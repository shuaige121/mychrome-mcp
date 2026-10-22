import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createClaudeSession, discoverClaudeModels } from '../src/managed-claude.js';

let passed = 0;
const catalog = [
  { value: 'default', displayName: 'Default', resolvedModel: 'claude-test', supportedEffortLevels: ['low', 'high', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku' },
];
function fakeCLI({ initialize = true, replay = true, models = catalog, applied = { model: 'claude-sonnet-test', effort: 'high' }, onMessage } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  const messages = [], spawns = [], signals = [];
  let buffer = '';
  const output = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (message, response = {}) => output({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
  const finish = code => {
    if (child.exitCode != null || child.signalCode != null) return;
    child.exitCode = code;
    child.emit('close', code, null);
  };
  child.kill = signal => { signals.push(signal); finish(0); return true; };
  child.stdin.on('finish', () => finish(0));
  child.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const message = JSON.parse(line); messages.push(message);
      queueMicrotask(() => {
        if (onMessage?.(message, { output, reply, child }) === true) return;
        if (replay && message.type === 'user') output({ ...message, isReplay: true });
        if (initialize && message.request?.subtype === 'initialize') reply(message, { models, account: { private: 'never expose account' } });
        if (message.request?.subtype === 'interrupt') reply(message, { still_queued: [], cancelled: [] });
        if (message.request?.subtype === 'get_settings') reply(message, { applied, effective: { effortLevel: 'max' }, sources: { private: 'not retained' } });
      });
    }
  });
  const spawnImpl = (...args) => { spawns.push(args); return child; };
  return { child, messages, spawns, signals, output, reply, finish, spawnImpl };
}
async function withSession(name, run, config = {}) {
  const fixture = fakeCLI(config);
  const updates = [];
  const session = await createClaudeSession({ cwd: '/tmp', model: 'sonnet', effort: 'high',
    executable: '/synthetic/claude', spawnImpl: fixture.spawnImpl, timeoutMs: 100,
    onChange: state => updates.push(state) });
  try { await run({ ...fixture, session, updates }); passed++; console.log(`  ok  ${name}`); }
  finally { await session.close(); }
}
const permission = (id, tool, input, rest = {}) => ({ type: 'control_request', request_id: id,
  request: { subtype: 'can_use_tool', tool_name: tool, tool_use_id: `tool-${id}`, input, ...rest } });
const answer = value => ({ approval: { answers: [value] } });
const flush = () => new Promise(resolve => setImmediate(resolve));

{
  const fake = fakeCLI();
  const result = await discoverClaudeModels({ cwd: '/tmp', spawnImpl: fake.spawnImpl });
  assert.equal(result.provider, 'Claude');
  assert.deepEqual(result.models[0], { id: 'default', name: 'Default', efforts: ['low', 'high', 'max'], defaultEffort: null, isDefault: true, resolvedModel: 'claude-test' });
  assert.deepEqual(result.models[2].efforts, []);
  assert.equal(JSON.stringify(result).includes('account'), false);
  assert.equal(fake.messages.length, 1);
  assert.equal(fake.messages[0].request.subtype, 'initialize');
  assert.equal(fake.child.exitCode, 0);
  assert.equal(fake.spawns[0][1].includes('--model'), false);
  passed++; console.log('  ok  dynamic catalog without a prompt, inference, account data or a lingering process');
}

await withSession('passes model and effort literally while retaining user MCP and permission settings', async ({ session, spawns, messages }) => {
  const [executable, args, spawnOptions] = spawns[0];
  assert.equal(executable, '/synthetic/claude');
  assert.deepEqual(args.slice(-4), ['--model', 'sonnet', '--effort', 'high']);
  assert.equal(args[args.indexOf('--session-id') + 1], session.snapshot().threadId);
  assert.equal(spawnOptions.cwd, '/tmp'); assert.equal(spawnOptions.shell, false);
  for (const flag of ['--dangerously-skip-permissions', '--permission-mode', '--tools', '--mcp-config', '--strict-mcp-config', '--setting-sources', '--no-session-persistence']) assert.equal(args.includes(flag), false);
  assert.equal(args.includes('--permission-prompt-tool=stdio'), true);
  assert.equal(args.includes('--replay-user-messages'), true);
  assert.equal(messages.some(message => message.type === 'user'), false);
  assert.equal(session.snapshot().status, 'connected'); assert.equal(session.snapshot().canSend, true);
  assert.equal(session.snapshot().model, 'claude-sonnet-test'); assert.equal(session.snapshot().effort, 'high');
  assert.equal(session.snapshot().requestedModel, 'sonnet'); assert.equal(session.snapshot().requestedEffort, 'high');
});

await withSession('reports CLI-applied model and effort separately from the requested values', async ({ session }) => {
  const state = session.snapshot();
  assert.equal(state.model, 'organization-resolved-model'); assert.equal(state.effort, 'low');
  assert.equal(state.requestedModel, 'sonnet'); assert.equal(state.requestedEffort, 'high');
  assert.equal(JSON.stringify(state).includes('not retained'), false);
}, { applied: { model: 'organization-resolved-model', effort: 'low' } });

await withSession('does not report requested settings as applied when an older CLI cannot confirm them', async ({ session }) => {
  assert.equal(session.snapshot().model, null); assert.equal(session.snapshot().effort, null);
  assert.equal(session.snapshot().requestedEffort, 'high');
}, { onMessage(message, { output }) {
  if (message.request?.subtype !== 'get_settings') return;
  output({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unsupported request' } });
  return true;
} });

await withSession('sends only submitted messages and accepts follow-up after a completed turn', async ({ session, messages, output }) => {
  const sent = await session.send('Please inspect this page.');
  assert.equal(sent.delivery, 'accepted');
  const user = messages.at(-1);
  assert.equal(user.type, 'user'); assert.equal(user.message.content, 'Please inspect this page.');
  assert.equal(user.session_id, session.snapshot().threadId);
  assert.equal(session.snapshot().threadStatus, 'active'); assert.equal(session.snapshot().canSend, false);
  await assert.rejects(session.send('duplicate while busy'), { code: 'claude_not_ready' });
  output({ type: 'result', subtype: 'success', is_error: false, session_id: user.session_id });
  assert.equal(session.snapshot().canSend, true);
  await session.send('Now continue.');
  assert.equal(messages.filter(message => message.type === 'user').length, 2);
});

await withSession('stdin write is not delivery: only an exact CLI replay acknowledges the message', async ({ session, messages, output }) => {
  let settled = false;
  const pendingSend = session.send('Synthetic prompt').then(result => { settled = true; return result; });
  const user = messages.at(-1);
  await flush(); assert.equal(settled, false); assert.equal(session.snapshot().sending, true);
  output({ ...user, uuid: 'different-message', isReplay: true });
  output({ ...user, isReplay: false });
  output({ ...user, isReplay: true, parent_tool_use_id: 'subagent' });
  await flush(); assert.equal(settled, false);
  output({ ...user, isReplay: true });
  assert.equal((await pendingSend).delivery, 'accepted');
  assert.equal(session.snapshot().sending, false);
  assert.deepEqual(session.snapshot().entries, [], 'the replay is not an assistant message');
}, { replay: false });

await withSession('process loss before replay leaves message delivery unknown without automatic retry', async ({ session, messages, finish }) => {
  const pendingSend = session.send('Synthetic prompt');
  finish(7);
  await assert.rejects(pendingSend, error => error.code === 'claude_process_exited' && error.delivery === 'unknown');
  assert.equal(messages.filter(message => message.type === 'user').length, 1);
  assert.equal(session.snapshot().sending, false);
}, { replay: false });

await withSession('an asynchronous stdin error cannot report delivery as accepted', async ({ session, child, messages }) => {
  const pendingSend = session.send('Synthetic prompt');
  child.stdin.emit('error', Object.assign(new Error('synthetic broken pipe'), { code: 'EPIPE' }));
  await assert.rejects(pendingSend, error => error.code === 'claude_write_failed' && error.delivery === 'unknown');
  assert.equal(messages.filter(message => message.type === 'user').length, 1);
}, { replay: false });

await withSession('missing CLI acknowledgement times out unknown while preserving observation of the session', async ({ session, messages }) => {
  await assert.rejects(session.send('Synthetic prompt'), error => error.code === 'claude_delivery_unconfirmed' && error.delivery === 'unknown');
  assert.equal(session.snapshot().status, 'connected');
  assert.equal(session.snapshot().reason, 'claude_delivery_unconfirmed');
  assert.equal(messages.filter(message => message.type === 'user').length, 1);
}, { replay: false });

await withSession('streams assistant text once while excluding thinking, tool inputs, commands and subagent internals', async ({ session, output }) => {
  await session.send('Start');
  const stream = event => output({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'msg-a' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'private chain' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private chain continued' } });
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'I will ' } });
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'read this page.\n```bash\nprivate-command\n```\nThen summarize.' } });
  assert.equal(session.snapshot().entries[0].text, 'I will read this page.\nThen summarize.');
  output({ type: 'assistant', message: { id: 'msg-a', content: [
    { type: 'thinking', thinking: 'private chain' },
    { type: 'text', text: 'I will read this page.\n```bash\nprivate-command\n```\nThen summarize.' },
    { type: 'tool_use', name: 'Bash', input: { command: 'hidden-tool-command' } },
  ] } });
  output({ type: 'assistant', parent_tool_use_id: 'subagent', message: { id: 'sub', content: [{ type: 'text', text: 'subagent private message' }] } });
  output({ type: 'system', subtype: 'hook_response', stdout: 'private hook output' });
  output({ type: 'system', subtype: 'tool_progress', tool_name: 'Bash', content: 'private tool output' });
  const snapshot = session.snapshot();
  assert.equal(snapshot.entries.length, 1); assert.equal(snapshot.entries[0].complete, true);
  for (const privateText of ['private chain', 'private-command', 'hidden-tool-command', 'subagent private', 'private hook', 'private tool']) assert.equal(JSON.stringify(snapshot).includes(privateText), false);
});

await withSession('shows reviewable one-time tool approval and never changes persistent permissions', async ({ session, output, messages }) => {
  await session.send('Inspect');
  output(permission('permission-a', 'Bash', { command: 'git status --short' }, { description: 'Check changed files.' }));
  const pending = session.snapshot().pending[0];
  assert.match(pending.questions[0].question, /git status --short/);
  assert.equal(pending.questions[0].options[0].label, '拒绝');
  assert.deepEqual(session.snapshot().entries, []);
  await assert.rejects(session.send('continue'), { code: 'answer_pending_question' });
  await session.answer({ requestId: 'permission-a', answers: answer('仅允许一次') });
  assert.deepEqual(messages.at(-1).response.response, { behavior: 'allow', updatedInput: { command: 'git status --short' } });
  assert.equal(JSON.stringify(messages.at(-1)).includes('updatedPermissions'), false);
  assert.equal(session.snapshot().pending.length, 0);
  await assert.rejects(session.answer({ requestId: 'permission-a', answers: answer('仅允许一次') }), { code: 'question_expired' });
});

await withSession('denies a user-declined action and ignores duplicate request frames', async ({ session, output, messages }) => {
  const event = permission('permission-b', 'Read', { file_path: '/tmp/example.txt' });
  output(event); output(event);
  assert.equal(session.snapshot().pending.length, 1);
  await session.answer({ requestId: 'permission-b', answers: answer('拒绝') });
  output(event);
  assert.equal(session.snapshot().pending.length, 0);
  assert.equal(messages.at(-1).response.response.behavior, 'deny');
});

await withSession('redacts sensitive approval fields and refuses approval when details are redacted or too large', async ({ session, output, messages }) => {
  for (const [id, input] of [
    ['sensitive', { token: 'secret-fixture-123', description: 'Test' }],
    ['inline', { command: 'echo token=secret-fixture-123' }],
    ['large', { command: 'x'.repeat(6500) }],
  ]) {
    output(permission(id, 'Bash', input));
    const pending = session.snapshot().pending[0];
    assert.equal(JSON.stringify(pending).includes('secret-fixture-123'), false);
    assert.deepEqual(pending.questions[0].options.map(option => option.label), ['拒绝']);
    await assert.rejects(session.answer({ requestId: id, answers: answer('仅允许一次') }), { code: 'approval_not_available' });
    await session.answer({ requestId: id, answers: answer('拒绝') });
    assert.equal(messages.at(-1).response.response.behavior, 'deny');
  }
});

await withSession('maps AskUserQuestion selections and free text back to their exact original questions', async ({ session, output, messages }) => {
  output(permission('question-a', 'AskUserQuestion', { questions: [
    { header: 'Language', question: 'Which language?', options: [{ label: 'Chinese', description: '中文' }], multiSelect: false },
    { header: 'Audience', question: 'Who is this for?', options: [] },
  ] }, { requires_user_interaction: true }));
  assert.equal(session.snapshot().pending[0].questions.length, 2);
  await session.answer({ requestId: 'question-a', answers: {
    'question-0': { answers: ['Chinese'] }, 'question-1': { answers: ['My team'] },
  } });
  assert.deepEqual(messages.at(-1).response.response.updatedInput.answers, { 'Which language?': 'Chinese', 'Who is this for?': 'My team' });
  assert.equal(messages.at(-1).response.response.behavior, 'allow');
});

await withSession('fails closed for unsupported controls, interaction surfaces and malformed questions', async ({ session, output, messages }) => {
  output({ type: 'control_request', request_id: 'unknown', request: { subtype: 'future_privileged_request' } });
  assert.equal(messages.at(-1).response.subtype, 'error');
  output(permission('invalid-question', 'AskUserQuestion', { questions: [{ question: 'broken' }] }));
  assert.equal(messages.at(-1).response.response.behavior, 'deny');
  output(permission('interaction', 'FutureInteractiveTool', { action: 'Review something' }, { requires_user_interaction: true }));
  assert.deepEqual(session.snapshot().pending[0].questions[0].options.map(option => option.label), ['拒绝']);
  const count = messages.length;
  output({ type: 'control_request', request_id: 'dialog', request: { subtype: 'request_user_dialog', dialog_kind: 'future_kind', payload: {} } });
  assert.equal(messages.length, count, 'unknown dialogs must remain unanswered per the official protocol');
});

await withSession('withdrawn permission requests cannot be answered', async ({ session, output, messages }) => {
  const event = permission('cancel-me', 'Read', { file_path: '/tmp/example' });
  output(event);
  output({ type: 'control_cancel_request', request_id: 'cancel-me' });
  assert.equal(session.snapshot().pending.length, 0);
  const count = messages.length;
  await assert.rejects(session.answer({ requestId: 'cancel-me', answers: answer('仅允许一次') }), { code: 'question_expired' });
  output(event); assert.equal(messages.length, count); assert.equal(session.snapshot().pending.length, 0);
});

await withSession('interrupts the owned session through control protocol, including queued prompts', async ({ session, output, messages }) => {
  await session.send('Work');
  output(permission('pending-stop', 'Read', { file_path: '/tmp/example' }));
  const result = await session.interrupt();
  assert.equal(result.delivery, 'accepted');
  assert.deepEqual(messages.at(-1).request, { subtype: 'interrupt', cancel_queued: true });
  assert.equal(session.snapshot().pending.length, 0);
  output(permission('pending-stop', 'Read', { file_path: '/tmp/example' }));
  assert.equal(session.snapshot().pending.length, 0, 'late duplicates cannot revive an interrupted request');
  assert.equal(session.snapshot().canSend, false, 'wait for real idle/result, not interrupt acknowledgement alone');
  output({ type: 'result', is_error: true, terminal_reason: 'aborted_tools' });
  output({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  assert.equal(session.snapshot().canSend, true);
  assert.equal(session.snapshot().reason, 'interrupted');
});

await withSession('confirmed user Stop labels its aborted result as interrupted and leaves the next turn independent', async ({ session, output, messages }) => {
  await session.send('First turn');
  const first = messages.find(message => message.type === 'user').uuid;
  await session.interrupt();
  output({ type: 'result', is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_streaming', user_message_uuid: first });
  assert.equal(session.snapshot().reason, 'interrupted'); assert.equal(session.snapshot().canSend, true);
  await session.send('Second turn');
  const second = messages.filter(message => message.type === 'user').at(-1).uuid;
  output({ type: 'result', is_error: true, terminal_reason: 'aborted_streaming', user_message_uuid: first });
  assert.equal(session.snapshot().activeTurnId, second); assert.equal(session.snapshot().threadStatus, 'active');
  assert.equal(session.snapshot().reason, null);
  output({ type: 'result', is_error: true, terminal_reason: 'api_error', user_message_uuid: second });
  assert.equal(session.snapshot().reason, 'claude_turn_failed');
});

for (const accepted of [true, false]) {
  await withSession(`a result before the interrupt ${accepted ? 'acceptance' : 'rejection'} is classified only after its receipt`, async ({ session, output, messages, reply }) => {
    await session.send('Synthetic turn');
    const id = session.snapshot().activeTurnId;
    const stopping = session.interrupt();
    const request = messages.at(-1);
    output({ type: 'result', is_error: true, terminal_reason: 'aborted_streaming', user_message_uuid: id });
    assert.equal(session.snapshot().reason, null); assert.equal(session.snapshot().canSend, false);
    if (accepted) {
      reply(request, { still_queued: [], cancelled: [] });
      await stopping;
      assert.equal(session.snapshot().reason, 'interrupted');
    } else {
      output({ type: 'control_response', response: { subtype: 'error', request_id: request.request_id, error: 'Synthetic rejection' } });
      await assert.rejects(stopping, { code: 'claude_control_rejected' });
      assert.equal(session.snapshot().reason, 'claude_turn_failed');
    }
    assert.equal(session.snapshot().canSend, true);
  }, { onMessage: message => message.request?.subtype === 'interrupt' });
}

await withSession('rejected Stop before the result cannot turn an ordinary error into cancellation', async ({ session, output }) => {
  await session.send('Synthetic turn');
  await assert.rejects(session.interrupt(), { code: 'claude_control_rejected' });
  output({ type: 'result', is_error: true, terminal_reason: 'aborted_streaming' });
  assert.equal(session.snapshot().reason, 'claude_turn_failed');
}, { onMessage(message, { output }) {
  if (message.request?.subtype !== 'interrupt') return;
  output({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Synthetic rejection' } });
  return true;
} });

await withSession('a provider error remains a failure even when Stop was accepted', async ({ session, output }) => {
  await session.send('Synthetic turn');
  await session.interrupt();
  output({ type: 'result', is_error: true, terminal_reason: 'api_error' });
  assert.equal(session.snapshot().reason, 'claude_turn_failed');
  await session.send('Another turn');
  output({ type: 'result', is_error: true, terminal_reason: 'aborted_streaming' });
  assert.equal(session.snapshot().reason, 'claude_turn_failed', 'abort without a local Stop is not a user cancellation');
});

await withSession('cancelled queued UUID from Stop completes only that exact turn', async ({ session, output, messages, reply }) => {
  await session.send('Synthetic turn');
  const id = session.snapshot().activeTurnId;
  const stopping = session.interrupt();
  reply(messages.at(-1), { still_queued: [], cancelled: [id] });
  await stopping;
  assert.equal(session.snapshot().reason, 'interrupted'); assert.equal(session.snapshot().canSend, true);
  await session.send('Next turn');
  const next = session.snapshot().activeTurnId;
  output({ type: 'result', is_error: true, terminal_reason: 'aborted_tools', user_message_uuid: id });
  assert.equal(session.snapshot().activeTurnId, next); assert.equal(session.snapshot().threadStatus, 'active');
}, { onMessage: message => message.request?.subtype === 'interrupt' });

await withSession('handles process loss without replaying a submitted user message or exposing stderr', async ({ session, child, finish }) => {
  await session.send('Start');
  child.stderr.write('Authorization: secret-diagnostic-do-not-display');
  finish(7);
  assert.equal(session.snapshot().status, 'error');
  assert.equal(session.snapshot().reason, 'claude_process_exited');
  assert.equal(JSON.stringify(session.snapshot()).includes('secret-diagnostic'), false);
  await assert.rejects(session.send('again'), { code: 'claude_not_ready' });
});

await withSession('rejects another session and malformed protocol instead of displaying its data', async ({ session, output }) => {
  output({ type: 'assistant', session_id: 'someone-elses-session', message: { id: 'private', content: [{ type: 'text', text: 'Private other session' }] } });
  assert.equal(session.snapshot().reason, 'claude_session_mismatch');
  assert.deepEqual(session.snapshot().entries, []);
});

await withSession('malformed JSON closes the adapter without exposing raw output', async ({ session, child }) => {
  child.stdout.write('private malformed output\n');
  assert.equal(session.snapshot().reason, 'claude_protocol_error');
  assert.deepEqual(session.snapshot().entries, []);
});

await withSession('provider error text does not leak diagnostics into the natural-language stream', async ({ session, output }) => {
  output({ type: 'assistant', error: 'authentication_failed', message: { id: 'err', content: [{ type: 'text', text: 'token=secret-diagnostic' }] } });
  assert.equal(session.snapshot().reason, 'claude_turn_failed');
  assert.deepEqual(session.snapshot().entries, []);
});

for (const [name, config, expected] of [
  ['initialization timeout', { initialize: false }, 'claude_response_timeout'],
  ['missing model catalog', { models: [] }, 'claude_models_unavailable'],
]) {
  const fake = fakeCLI(config);
  await assert.rejects(createClaudeSession({ cwd: '/tmp', spawnImpl: fake.spawnImpl, timeoutMs: 20 }), { code: expected });
  assert.equal(fake.child.exitCode, 0);
  assert.equal(fake.messages.some(message => message.type === 'user'), false);
  passed++; console.log(`  ok  ${name} closes its owned process without a prompt`);
}
for (const [model, effort, expected] of [
  ['missing-model', null, 'claude_model_unavailable'],
  ['haiku', 'high', 'claude_effort_unavailable'],
  ['sonnet', 'max', 'claude_effort_unavailable'],
]) {
  const fake = fakeCLI();
  await assert.rejects(createClaudeSession({ cwd: '/tmp', model, effort, spawnImpl: fake.spawnImpl }), { code: expected });
  assert.equal(fake.child.exitCode, 0);
  passed++; console.log(`  ok  validates ${model}/${effort} against the installed CLI catalog`);
}
{
  const fake = fakeCLI({ initialize: false });
  const promise = createClaudeSession({ cwd: '/tmp', spawnImpl: fake.spawnImpl, timeoutMs: 100 });
  fake.child.emit('error', Object.assign(new Error('private diagnostic'), { code: 'ENOENT' }));
  await assert.rejects(promise, { code: 'claude_not_installed' });
  passed++; console.log('  ok  missing CLI produces a safe actionable error');
}
{
  const fake = fakeCLI();
  await assert.rejects(createClaudeSession({ cwd: '/tmp', effort: 'invented', spawnImpl: fake.spawnImpl }), { code: 'invalid_effort' });
  await assert.rejects(createClaudeSession({ cwd: 'relative', spawnImpl: fake.spawnImpl }), { code: 'invalid_cwd' });
  assert.equal(fake.spawns.length, 0);
  passed++; console.log('  ok  invalid options do not spawn a process');
}
await flush();
console.log(`managed-claude: ${passed} checks passed`);
