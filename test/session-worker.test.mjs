import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { handleSessionRequest } from '../src/session-launcher.js';
import { guiSocketPath, requestGui } from '../src/gui-ipc.js';

// A real worker and real local sockets, with a synthetic CLI placed first on
// PATH. No installed model client, account, private configuration or inference
// is involved. Every file and process below belongs to this fixture.
const base = mkdtempSync('/tmp/mychrome-worker-');
const bin = path.join(base, 'bin');
const wireFile = path.join(base, 'synthetic-wire.jsonl');
mkdirSync(bin);
writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const journal = value => fs.appendFileSync(process.env.MYCHROME_TEST_WIRE,
  JSON.stringify({ pid: process.pid, ...value }) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (request, result) => send({ id: request.id, result });
const threadId = 'synthetic-thread-' + process.pid;
let turn = 0;
journal({ event: 'started', argv: process.argv.slice(2) });
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  journal({ event: 'received', message: request });
  if (request.method === 'initialize') reply(request, { userAgent: 'synthetic-codex' });
  else if (request.method === 'model/list') reply(request, { data: [{
    id: 'synthetic-model', model: 'synthetic-model', displayName: 'Synthetic model',
    hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
  }], nextCursor: null });
  else if (request.method === 'thread/start') reply(request, {
    model: request.params.model, reasoningEffort: request.params.config.model_reasoning_effort,
    cwd: request.params.cwd, thread: { id: threadId, status: { type: 'idle' }, turns: [] },
  });
  else if (request.method === 'turn/start') {
    const turnId = 'synthetic-turn-' + (++turn);
    reply(request, { turn: { id: turnId, status: 'inProgress', items: [] } });
    if (request.params.input[0].text === 'Ask for approval') {
      send({ id: 'approval-fixture', method: 'item/commandExecution/requestApproval', params: {
        threadId, turnId, itemId: 'synthetic-command', command: 'echo synthetic-fixture', cwd: process.cwd(),
      } });
    } else setTimeout(() => send({ method: 'turn/completed', params: {
      threadId, turn: { id: turnId, status: 'completed', items: [] },
    } }), 10);
  } else if (request.method === 'turn/interrupt') {
    reply(request, {});
    send({ method: 'turn/completed', params: { threadId, turn: {
      id: request.params.turnId, status: 'interrupted', items: [],
    } } });
  }
});
input.on('close', () => { journal({ event: 'closed' }); process.exit(0); });
`, { mode: 0o700 });

const children = [];
const wire = () => existsSync(wireFile)
  ? readFileSync(wireFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const requests = method => wire().filter(row => row.message?.method === method);
const spawnWorker = (script, args, options) => {
  assert.deepEqual(options.execArgv, [], 'the worker must not inherit a caller test runner or --input-type flag');
  const child = fork(script, args, { ...options, env: { ...options.env,
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    MYCHROME_TEST_WIRE: wireFile,
  } });
  let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  child.once('exit', (code, signal) => exit({ code, signal }));
  children.push({ child, exited });
  return child;
};
async function eventually(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function stopChild(owned) {
  if (owned.child.exitCode == null && owned.child.signalCode == null) owned.child.kill('SIGTERM');
  let timer;
  try {
    return await Promise.race([owned.exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned worker did not stop after SIGTERM')), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const createRequest = { op: 'create', provider: 'Codex', cwd: base, model: 'synthetic-model', effort: 'high',
  nonce: randomUUID(), prompt: 'This first prompt must remain a GUI draft.' };
let created;
const send = payload => requestGui({ base, pid: created.pid, instance: created.instance, op: 'send', payload });
const snapshot = async () => (await requestGui({ base, pid: created.pid, instance: created.instance, op: 'snapshot' })).snapshot;
const payload = overrides => ({ nonce: randomUUID(), threadId: created.threadId, bindingId: created.bindingId, ...overrides });

try {
  await check('real worker creates one empty thread and never automatically submits the initial prompt', async () => {
    created = await handleSessionRequest(createRequest, { base, spawnWorker });
    assert.equal(created.ok, true); assert.equal(children.length, 1);
    const state = await snapshot();
    assert.equal(state.status, 'connected'); assert.equal(state.threadStatus, 'idle'); assert.equal(state.canSend, true);
    assert.equal(state.threadId, created.threadId); assert.equal(state.bindingId, created.bindingId);
    assert.equal(state.model, 'synthetic-model'); assert.equal(state.effort, 'high');
    assert.equal(requests('thread/start').length, 1);
    assert.equal(requests('turn/start').length, 0);
    assert.equal(JSON.stringify(wire()).includes(createRequest.prompt), false);
    for (const row of wire().filter(row => row.event === 'started')) assert.deepEqual(row.argv, ['app-server', '--stdio']);
    const presence = path.join(base, 'servers', `${created.pid}.json`);
    assert.equal(statSync(presence).mode & 0o077, 0);
    assert.equal(readFileSync(presence, 'utf8').includes(createRequest.prompt), false);
    assert.equal(readFileSync(path.join(base, 'session-launches', `${createRequest.nonce}.json`), 'utf8').includes(createRequest.prompt), false);
  });
  await check('retrying the create nonce verifies the same live worker without a second CLI or thread', async () => {
    const count = wire().filter(row => row.event === 'started').length;
    assert.deepEqual(await handleSessionRequest(createRequest, { base, spawnWorker }), created);
    assert.equal(children.length, 1);
    assert.equal(wire().filter(row => row.event === 'started').length, count);
    assert.equal(requests('thread/start').length, 1);
  });
  await check('wrong binding or thread is rejected before any prompt reaches the CLI', async () => {
    for (const change of [{ bindingId: randomUUID() }, { threadId: 'different-thread' }]) {
      const response = await send(payload({ text: 'Should not be sent', ...change }));
      assert.equal(response.ok, false); assert.equal(response.code, 'conversation_changed');
      assert.equal(response.delivery, 'not_sent');
    }
    assert.equal(requests('turn/start').length, 0);
  });
  await check('concurrent duplicate send nonces produce exactly one model turn and a cached accepted result', async () => {
    const message = payload({ text: 'Synthetic user submission' });
    const [first, second] = await Promise.all([send(message), send(message)]);
    assert.deepEqual(first, second); assert.equal(first.result.status, 'accepted'); assert.equal(first.result.delivery, 'accepted');
    assert.equal(requests('turn/start').length, 1);
    assert.equal(requests('turn/start')[0].message.params.threadId, created.threadId);
    const cached = await requestGui({ base, pid: created.pid, instance: created.instance, op: 'delivery', payload: { nonce: message.nonce } });
    assert.deepEqual(cached, first);
    const conflict = await send({ ...message, text: 'Different content with the same nonce' });
    assert.equal(conflict.code, 'nonce_conflict');
    assert.equal(requests('turn/start').length, 1);
    await eventually(async () => (await snapshot()).threadStatus === 'idle', 'Synthetic turn did not finish');
  });
  await check('unconfirmed permission answers remain unknown through the real worker and delivery ledger', async () => {
    const started = await send(payload({ text: 'Ask for approval' }));
    assert.equal(started.result.status, 'accepted');
    await eventually(async () => (await snapshot()).pending.length === 1, 'Approval did not reach the GUI snapshot');
    const state = await snapshot();
    assert.equal(state.pending[0].requestId, 'approval-fixture');
    assert.match(state.pending[0].questions[0].question, /echo synthetic-fixture/);
    const answer = payload({ requestId: 'approval-fixture', answers: { approval: { answers: ['拒绝'] } } });
    const response = await send(answer);
    assert.equal(response.ok, true);
    assert.equal(response.result.status, 'unknown'); assert.equal(response.result.delivery, 'unknown');
    assert.deepEqual(await send(answer), response);
    assert.equal(wire().filter(row => row.message?.id === 'approval-fixture' && row.message?.result).length, 1);
    const cached = await requestGui({ base, pid: created.pid, instance: created.instance, op: 'delivery', payload: { nonce: answer.nonce } });
    assert.deepEqual(cached, response);
  });
  await check('SIGTERM closes only the owned backend and removes its presence and GUI socket', async () => {
    const result = await stopChild(children[0]);
    assert.equal(result.code, 0);
    assert.equal(existsSync(path.join(base, 'servers', `${created.pid}.json`)), false);
    assert.equal(existsSync(guiSocketPath(base, created.pid)), false);
    const pids = wire().filter(row => row.event === 'started').map(row => row.pid);
    await eventually(() => pids.every(pid => wire().some(row => row.pid === pid && row.event === 'closed')),
      'An owned synthetic CLI did not receive EOF');
    await assert.rejects(handleSessionRequest(createRequest, { base, spawnWorker }), { code: 'session_ended' });
    assert.equal(children.length, 1, 'a dead receipt must not silently create a replacement');
  });
  console.log(`${passed} real session worker integration checks passed`);
} finally {
  // Clean up only processes and temporary files created by this test. A failed
  // graceful shutdown deliberately leaves the fixture directory for inspection.
  await Promise.all(children.map(stopChild));
  rmSync(base, { recursive: true, force: true });
}
