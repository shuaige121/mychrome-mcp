import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { createCodexSession, discoverCodexModels } from '../src/managed-codex.js';

const CWD = process.cwd();
const MODEL = { id: 'catalog-id', model: 'test-model', displayName: 'Test model', hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
  defaultReasoningEffort: 'medium', isDefault: true };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  const writes = [], signals = [], spawns = [];
  let turn = 0;
  const emit = message => child.stdout.write(JSON.stringify(message) + '\n');
  const reply = (message, result) => emit({ id: message.id, result });
  const event = (method, params = {}) => emit({ method, params: { threadId: 'thread-owned', ...params } });
  child.finish = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
  };
  child.kill = signal => { signals.push(signal); child.finish(); return true; };
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString()); writes.push(message);
      queueMicrotask(() => {
        if (overrides.handle?.(message, { emit, reply, event, child }) === true) return;
        if (message.method === 'initialize') reply(message, { userAgent: 'fake-codex' });
        else if (message.method === 'model/list') reply(message, { data: [MODEL], nextCursor: null });
        else if (message.method === 'thread/start') reply(message, { model: message.params.model,
          reasoningEffort: message.params.config.model_reasoning_effort, cwd: message.params.cwd,
          thread: { id: 'thread-owned', status: { type: 'idle' }, turns: [] } });
        else if (message.method === 'turn/start') reply(message, { turn: { id: `turn-${++turn}`, status: 'inProgress', items: [] } });
        else if (message.method === 'turn/steer') reply(message, { turnId: message.params.expectedTurnId });
        else if (message.method === 'turn/interrupt') {
          reply(message, {}); event('turn/completed', { turn: { id: message.params.turnId, status: 'interrupted', items: [] } });
        }
      });
      done();
    },
    final(done) { done(); if (!overrides.ignoreEOF) queueMicrotask(() => child.finish()); },
  });
  const spawnImpl = (...args) => { spawns.push(args); return child; };
  return { child, writes, signals, spawns, spawnImpl, emit, event, reply };
}

async function session(f = fixture(), options = {}) {
  return createCodexSession({ cwd: CWD, model: 'test-model', effort: 'high', spawnImpl: f.spawnImpl,
    timeoutMs: 100, closeGraceMs: 10, ...options });
}

test('discovers the paginated live catalog without starting a thread or inference', async () => {
  const f = fixture({ handle(message, { reply }) {
    if (message.method !== 'model/list') return false;
    reply(message, message.params.cursor
      ? { data: [{ ...MODEL, model: 'second-model', displayName: 'Second', isDefault: false }], nextCursor: null }
      : { data: [MODEL, { ...MODEL, model: 'hidden', hidden: true }], nextCursor: 'page-2' });
    return true;
  } });
  const result = await discoverCodexModels({ spawnImpl: f.spawnImpl, timeoutMs: 100, closeGraceMs: 10 });
  assert.deepEqual(result, { provider: 'Codex', models: [
    { id: 'test-model', name: 'Test model', efforts: ['medium', 'high'], defaultEffort: 'medium', isDefault: true },
    { id: 'second-model', name: 'Second', efforts: ['medium', 'high'], defaultEffort: 'medium', isDefault: false },
  ] });
  assert.deepEqual(f.writes.map(x => x.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.deepEqual(f.spawns[0].slice(0, 2), ['codex', ['app-server', '--stdio']]);
  assert.equal(f.child.exitCode, 0);
});

test('creates only a new owned thread; model, effort and cwd reach every new turn', async () => {
  const f = fixture(), s = await session(f);
  try {
    assert.deepEqual(f.writes.find(x => x.method === 'thread/start').params,
      { cwd: CWD, model: 'test-model', config: { model_reasoning_effort: 'high' } });
    assert.equal(f.spawns[0][2].cwd, CWD);
    assert.equal(f.spawns[0][2].shell, false);
    assert.equal(s.snapshot().canSend, true);
    assert.equal(s.snapshot().model, 'test-model'); assert.equal(s.snapshot().effort, 'high');
    await s.send('First prompt');
    const first = f.writes.find(x => x.method === 'turn/start');
    assert.equal(first.params.model, 'test-model'); assert.equal(first.params.effort, 'high');
    assert.equal(first.params.cwd, CWD); assert.equal(first.params.threadId, 'thread-owned');
    assert.deepEqual(first.params.input, [{ type: 'text', text: 'First prompt' }]);
    await s.send('Additional instruction');
    assert.deepEqual(f.writes.find(x => x.method === 'turn/steer').params,
      { threadId: 'thread-owned', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'Additional instruction' }] });
    f.event('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
    await tick(); await s.send('Follow-up');
    assert.equal(f.writes.filter(x => x.method === 'turn/start').length, 2);
    for (const message of f.writes) assert.doesNotMatch(JSON.stringify(message), /approvalPolicy|sandboxPolicy|bypass|thread\/read|thread\/resume|thread\/list|auth\/|config\/read/);
  } finally { await s.close(); }
});

test('following client effort preserves configured settings instead of the catalog default', async () => {
  const f = fixture({ handle(message, { reply }) {
    if (message.method !== 'thread/start') return false;
    assert.deepEqual(message.params.config, {});
    reply(message, { model: 'test-model', reasoningEffort: 'high',
      thread: { id: 'thread-owned', status: { type: 'idle' }, turns: [] } });
    return true;
  } });
  const s = await session(f, { effort: null });
  try {
    assert.equal(s.snapshot().requestedEffort, null);
    assert.equal(s.snapshot().effort, 'high');
    await s.send('Follow configured effort');
    assert.equal(f.writes.find(x => x.method === 'turn/start').params.effort, 'high');
  } finally { await s.close(); }
});

test('projects only public agent messages from the owned thread and preserves streamed Unicode', async () => {
  const f = fixture(), changes = [], s = await session(f, { onChange: x => changes.push(x) });
  try {
    await s.send('Hello');
    const item = (type, id, phase = 'commentary', text = '') => ({ turnId: 'turn-1', item: { type, id, phase, text, command: 'PRIVATE_COMMAND' } });
    f.event('item/started', item('reasoning', 'reason', 'analysis', 'PRIVATE_REASONING'));
    f.event('item/started', item('commandExecution', 'tool', 'commentary', 'PRIVATE_TOOL'));
    f.event('item/started', { ...item('agentMessage', 'other', 'final_answer', 'FOREIGN'), threadId: 'another-thread' });
    f.event('item/completed', item('agentMessage', 'history', 'final_answer', 'UNADMITTED'));
    f.event('item/started', item('agentMessage', 'public'));
    const wire = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-owned', turnId: 'turn-1', itemId: 'public', delta: '你好 👋' } }) + '\n');
    for (const byte of wire) f.child.stdout.write(Buffer.from([byte]));
    f.event('item/completed', item('agentMessage', 'public', 'final_answer', '你好 👋\n```js\nconst n = 1;\n```'));
    await tick();
    assert.deepEqual(s.snapshot().entries, [{ id: 'public', text: '你好 👋\n```js\nconst n = 1;\n```' }]);
    assert.doesNotMatch(JSON.stringify(changes), /PRIVATE_|FOREIGN|UNADMITTED/);
  } finally { await s.close(); }
});

test('approvals stay pending until an explicit answer and cannot grant session-wide approval', async () => {
  const f = fixture(), s = await session(f);
  try {
    await s.send('Work');
    f.emit({ id: 'approve-1', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-owned', turnId: 'turn-1', itemId: 'cmd', command: 'echo example', cwd: CWD, reason: 'Run the requested example' } });
    await tick();
    assert.equal(s.snapshot().pending.length, 1); assert.equal(s.snapshot().canSend, false);
    assert.match(s.snapshot().pending[0].questions[0].question, /echo example/);
    assert.deepEqual(s.snapshot().entries, []);
    assert.equal(f.writes.some(x => x.id === 'approve-1'), false);
    await assert.rejects(s.answer({ requestId: 'approve-1', answers: { approval: { answers: ['acceptForSession'] } } }), { code: 'invalid_answer' });
    await s.answer({ requestId: 'approve-1', answers: { approval: { answers: ['允许一次'] } } });
    assert.deepEqual(f.writes.find(x => x.id === 'approve-1'), { id: 'approve-1', result: { decision: 'accept' } });
    await assert.rejects(s.answer({ requestId: 'approve-1', answers: { approval: { answers: ['accept'] } } }), { code: 'request_unavailable' });
  } finally { await s.close(); }
});

test('public agent messages accept optional/null phase while reasoning remains excluded', async () => {
  const f = fixture(), s = await session(f);
  try {
    await s.send('Hello');
    for (const [id, phase] of [['omitted', undefined], ['nullable', null]]) {
      f.event('item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id, text: '', phase } });
      f.event('item/agentMessage/delta', { turnId: 'turn-1', itemId: id, delta: id });
      f.event('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id, text: id, phase } });
    }
    f.event('item/started', { turnId: 'turn-1', item: { type: 'reasoning', id: 'private', text: 'PRIVATE' } });
    f.event('item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'analysis', text: 'PRIVATE', phase: 'analysis' } });
    assert.deepEqual(s.snapshot().entries, [{ id: 'omitted', text: 'omitted' }, { id: 'nullable', text: 'nullable' }]);
  } finally { await s.close(); }
});

test('permission requests never grant extra access; user questions use typed answer payloads', async () => {
  const f = fixture(), s = await session(f);
  try {
    await s.send('Work');
    f.emit({ id: 8, method: 'item/permissions/requestApproval', params: {
      threadId: 'thread-owned', turnId: 'turn-1', itemId: 'permissions', cwd: CWD, permissions: { network: { enabled: true } } } });
    await tick();
    assert.equal(s.snapshot().pending[0].questions[0].options.some(x => x.label === '允许一次'), false);
    await s.answer({ requestId: 8, answers: { approval: { answers: ['decline'] } } });
    assert.deepEqual(f.writes.find(x => x.id === 8), { id: 8, result: { permissions: {}, scope: 'turn' } });
    f.emit({ id: 'question-1', method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-owned', turnId: 'turn-1', itemId: 'question', isBlocking: true,
      questions: [{ id: 'choice', header: 'Choose', question: 'Which one?', options: [{ label: 'A', description: 'First' }] }] } });
    await tick();
    await s.answer({ requestId: 'question-1', answers: { choice: { answers: ['A'] } } });
    assert.deepEqual(f.writes.find(x => x.id === 'question-1').result, { answers: { choice: { answers: ['A'] } } });
    assert.deepEqual(s.snapshot().entries, []);
  } finally { await s.close(); }
});

test('unknown and foreign server requests fail safely, interruption targets only the owned active turn', async () => {
  const f = fixture(), s = await session(f);
  try {
    await s.send('Work');
    f.emit({ id: 'unknown', method: 'unsupported/action', params: { secret: 'DO_NOT_DISPLAY' } });
    f.emit({ id: 'foreign', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'another-thread', turnId: 'other', itemId: 'cmd', command: 'DO_NOT_DISPLAY' } });
    await tick();
    assert.ok(f.writes.find(x => x.id === 'unknown').error);
    assert.ok(f.writes.find(x => x.id === 'foreign').error);
    assert.deepEqual(s.snapshot().pending, []);
    assert.doesNotMatch(JSON.stringify(s.snapshot()), /DO_NOT_DISPLAY/);
    await s.interrupt();
    assert.deepEqual(f.writes.find(x => x.method === 'turn/interrupt').params, { threadId: 'thread-owned', turnId: 'turn-1' });
    assert.equal(s.snapshot().threadStatus, 'idle');
  } finally { await s.close(); }
  assert.equal(f.child.exitCode, 0);
});

test('errors remain short codes; process termination and late completion cannot revive a closed session', async () => {
  const f = fixture({ handle(message, { emit }) {
    if (message.method !== 'turn/start') return false;
    emit({ id: message.id, error: { code: -32000, message: 'TOKEN_PRIVATE_ERROR' } }); return true;
  } }), s = await session(f);
  await assert.rejects(s.send('Work'), error => error.code === 'request_failed' && !error.message.includes('TOKEN_'));
  assert.equal(s.snapshot().canSend, true);
  f.child.stderr.write('TOKEN_PRIVATE_STDERR'); f.child.finish(); await tick();
  assert.equal(s.snapshot().status, 'disconnected');
  assert.doesNotMatch(JSON.stringify(s.snapshot()), /TOKEN_/);
  await assert.rejects(s.send('Retry'), { code: 'session_closed' });
  await s.close();
});

test('invalid selections fail before thread creation and pagination loops are rejected', async () => {
  const f = fixture();
  await assert.rejects(session(f, { effort: 'unsupported' }), { code: 'unsupported_effort' });
  assert.equal(f.writes.some(x => x.method === 'thread/start'), false);
  assert.equal(f.child.exitCode, 0);
  const loop = fixture({ handle(message, { reply }) {
    if (message.method !== 'model/list') return false;
    reply(message, { data: [MODEL], nextCursor: 'same' }); return true;
  } });
  await assert.rejects(discoverCodexModels({ spawnImpl: loop.spawnImpl, timeoutMs: 100, closeGraceMs: 10 }), { code: 'invalid_catalog' });
  assert.equal(loop.child.exitCode, 0);
});

test('close drains the owned child and uses only normal termination if EOF is ignored', async () => {
  const f = fixture({ ignoreEOF: true }), s = await session(f);
  await s.close(); await s.close();
  assert.deepEqual(f.signals, ['SIGTERM']);
  assert.equal(s.snapshot().status, 'disconnected');
});

test('reports actual server configuration separately from the requested selection', async () => {
  const f = fixture({ handle(message, { reply }) {
    if (message.method !== 'thread/start') return false;
    reply(message, { model: 'resolved-model', reasoningEffort: 'medium', cwd: CWD,
      thread: { id: 'thread-owned', status: { type: 'idle' }, turns: [] } });
    return true;
  } }), s = await session(f);
  try {
    assert.equal(s.snapshot().model, 'resolved-model'); assert.equal(s.snapshot().effort, 'medium');
    assert.equal(s.snapshot().requestedModel, 'test-model'); assert.equal(s.snapshot().requestedEffort, 'high');
    await s.send('Work');
    const turn = f.writes.find(x => x.method === 'turn/start');
    assert.equal(turn.params.model, 'resolved-model'); assert.equal(turn.params.effort, 'medium');
  } finally { await s.close(); }
});

test('Stop during turn startup waits for the owned turn ID and then interrupts it', async () => {
  let startMessage;
  const f = fixture({ handle(message) {
    if (message.method !== 'turn/start') return false;
    startMessage = message; return true;
  } }), s = await session(f);
  try {
    const send = s.send('Start'); await tick();
    const stop = s.interrupt();
    assert.equal(s.snapshot().canSend, false);
    f.reply(startMessage, { turn: { id: 'late-turn', status: 'inProgress', items: [] } });
    await send; await stop;
    assert.deepEqual(f.writes.find(x => x.method === 'turn/interrupt').params,
      { threadId: 'thread-owned', turnId: 'late-turn' });
    assert.equal(s.snapshot().threadStatus, 'idle');
    assert.equal(s.snapshot().canSend, true);
  } finally { await s.close(); }
});

test('Close prevents new sends immediately and startup responses cannot revive the session', async () => {
  let startMessage, interruptMessage;
  const f = fixture({ handle(message) {
    if (message.method === 'turn/start') { startMessage = message; return true; }
    if (message.method === 'turn/interrupt') { interruptMessage = message; return true; }
    return false;
  } }), s = await session(f);
  const send = s.send('Start'); const rejected = assert.rejects(send, { code: 'session_closed' });
  await tick();
  const close = s.close();
  await assert.rejects(s.send('Must not launch'), { code: 'session_closed' });
  f.reply(startMessage, { turn: { id: 'late-turn', status: 'inProgress', items: [] } });
  await close; await rejected;
  assert.equal(s.snapshot().status, 'disconnected'); assert.equal(s.snapshot().activeTurnId, null);
  assert.equal(f.writes.filter(x => x.method === 'turn/start').length, 1);

  const active = fixture({ handle(message) {
    if (message.method !== 'turn/interrupt') return false;
    interruptMessage = message; return true;
  } }), a = await session(active);
  await a.send('Already active'); const closing = a.close();
  await assert.rejects(a.send('Must not steer'), { code: 'session_closed' });
  active.reply(interruptMessage, {}); await closing;
  assert.equal(active.writes.some(x => x.method === 'turn/steer'), false);
});

test('completion delivered before turn/start response leaves the session idle', async () => {
  const f = fixture({ handle(message, { reply, event }) {
    if (message.method !== 'turn/start') return false;
    event('turn/completed', { turn: { id: 'fast-turn', status: 'completed', items: [] } });
    reply(message, { turn: { id: 'fast-turn', status: 'inProgress', items: [] } });
    return true;
  } }), s = await session(f);
  try {
    await s.send('Fast');
    assert.equal(s.snapshot().activeTurnId, null); assert.equal(s.snapshot().canSend, true);
  } finally { await s.close(); }
});

test('malformed output and request timeout disconnect and close the owned child', async () => {
  for (const malformed of [true, false]) {
    const f = fixture({ handle(message, { child }) {
      if (message.method !== 'turn/start') return false;
      if (malformed) child.stdout.write('{not JSON}\n');
      return true;
    } }), s = await session(f, { timeoutMs: 10 });
    await assert.rejects(s.send('Work'), { code: malformed ? 'protocol_error' : 'request_timeout' });
    await tick();
    assert.equal(s.snapshot().status, 'disconnected'); assert.equal(f.child.exitCode, 0);
    await s.close();
  }
});
