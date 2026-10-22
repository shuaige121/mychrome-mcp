import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { handleSessionRequest, launchManagedSession } from '../src/session-launcher.js';
import { normalizeSessionRequest, selectSessionModel } from '../src/session-options.js';
import { requestGui, startGuiIPC } from '../src/gui-ipc.js';

const base = mkdtempSync(path.join(os.tmpdir(), 'mychrome-session-launch-'));
let passed = 0;
const check = (label, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log(`ok - ${label}`); });
const request = overrides => normalizeSessionRequest({ op: 'create', provider: 'Codex', cwd: base,
  model: 'sample-model', effort: 'high', prompt: 'Private draft `$(not a command)`', nonce: randomUUID(), ...overrides });
const catalog = { provider: 'Codex', models: [{ id: 'sample-model', name: 'Sample', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true },
  { id: 'no-effort', name: 'Simple', efforts: [], defaultEffort: null }] };

try {
  await check('request validates the selected provider and existing absolute directory', () => {
    assert.throws(() => request({ provider: 'other' }), /invalid_provider/);
    assert.throws(() => request({ cwd: 'relative' }), /invalid_directory/);
    assert.throws(() => request({ cwd: path.join(base, 'absent') }), /invalid_directory/);
    assert.throws(() => request({ nonce: '../../escape' }), /invalid_nonce/);
    assert.throws(() => request({ prompt: 'a\0b' }), /invalid_prompt/);
    assert.throws(() => request({ prompt: 'a'.repeat(24_001) }), /invalid_prompt/);
    assert.equal(request({ prompt: 'a'.repeat(24_000) }).prompt.length, 24_000);
  });
  await check('model and effort validation follows capabilities, including models without effort', () => {
    assert.equal(selectSessionModel(request({ effort: null }), catalog).effort, null);
    assert.throws(() => selectSessionModel(request({ model: 'invented' }), catalog), /model_unavailable/);
    assert.throws(() => selectSessionModel(request({ effort: 'max' }), catalog), /effort_unavailable/);
    assert.throws(() => selectSessionModel(request({ model: 'no-effort' }), catalog), /effort_unavailable/);
    assert.equal(selectSessionModel(request({ model: 'no-effort', effort: null }), catalog).effort, null);
  });
  await check('catalog discovery does not create a conversation or forward a prompt', async () => {
    let seen;
    const response = await handleSessionRequest({ op: 'catalog', provider: 'Codex', cwd: base, prompt: 'ignored' },
      { catalog: async input => { seen = input; return catalog; }, spawnWorker() { assert.fail('No worker for catalog'); } });
    assert.equal(response.ok, true);
    assert.deepEqual(Object.keys(seen).sort(), ['cwd', 'op', 'provider']);
  });
  let launches = 0;
  const ready = { ok: true, pid: process.pid, instance: randomUUID(), threadId: 'new-thread', bindingId: randomUUID() };
  const spawnReady = (script, args, options) => {
    launches++;
    assert.ok(script.endsWith('/src/session-worker.js'));
    assert.deepEqual(args, []);
    assert.deepEqual(options.execArgv, []);
    assert.equal(options.stdio[3], 'ipc');
    const child = new EventEmitter(); child.connected = true;
    child.disconnect = () => { child.connected = false; }; child.unref = () => {};
    child.send = message => {
      assert.equal(message.request.prompt, 'Private draft `$(not a command)`');
      writeFileSync(message.receipt.file, JSON.stringify({ hash: message.receipt.hash, status: 'ready', result: ready }), { mode: 0o600 });
      queueMicrotask(() => child.emit('message', { type: 'ready', result: ready }));
    };
    return child;
  };
  const verifySession = async () => ({ snapshot: { threadId: ready.threadId, bindingId: ready.bindingId } });
  const options = { base, spawnWorker: spawnReady, verifySession };
  const first = request();
  await check('create passes exact configuration only through IPC and writes a private metadata receipt', async () => {
    assert.deepEqual(await launchManagedSession(first, options), ready);
    const file = path.join(base, 'session-launches', `${first.nonce}.json`);
    const bytes = readFileSync(file, 'utf8');
    assert.equal(bytes.includes('Private draft'), false);
    assert.equal(statSync(file).mode & 0o077, 0);
  });
  await check('repeating a create nonce verifies and returns the same conversation without spawning', async () => {
    assert.deepEqual(await launchManagedSession(first, options), ready);
    assert.equal(launches, 1);
    await assert.rejects(launchManagedSession({ ...first, prompt: 'different' }, options), /nonce_conflict/);
    assert.equal(launches, 1);
  });
  await check('a reused PID or changed binding cannot become the destination of a retry', async () => {
    await assert.rejects(launchManagedSession(first, { ...options, verifySession: async () => ({ snapshot: { threadId: 'someone-else' } }) }), /session_ended/);
    assert.equal(launches, 1);
  });
  await check('uncertain create result retains its nonce and never auto-launches a duplicate', async () => {
    const pending = request();
    const child = new EventEmitter(); child.connected = true;
    child.disconnect = () => { child.connected = false; }; child.unref = () => {}; child.send = () => {};
    const hold = setTimeout(() => {}, 500);
    try {
      await assert.rejects(launchManagedSession(pending, { base, timeoutMs: 20, spawnWorker: () => child }), e => e.code === 'launch_pending' && e.delivery === 'unknown');
      await assert.rejects(launchManagedSession(pending, options), /launch_pending/);
      assert.equal(launches, 1);
    } finally { clearTimeout(hold); }
  });
  await check('spawn failure reports a concrete failure, not an invented session', async () => {
    const failed = request();
    await assert.rejects(launchManagedSession(failed, { base, spawnWorker() { throw new Error('OS failure'); } }), /launch_failed/);
    await assert.rejects(launchManagedSession(failed, options), /launch_failed/);
    assert.equal(launches, 1);
  });
  await check('a worker exiting after writing ready is not returned as a live conversation', async () => {
    const dead = request();
    await assert.rejects(launchManagedSession(dead, { base, spawnWorker() {
      const child = new EventEmitter(); child.connected = true;
      child.disconnect = () => { child.connected = false; }; child.unref = () => {};
      child.send = message => {
        writeFileSync(message.receipt.file, JSON.stringify({ hash: message.receipt.hash, status: 'ready', result: ready }), { mode: 0o600 });
        queueMicrotask(() => child.emit('exit', 1));
      };
      return child;
    } }), /session_ended/);
    await assert.rejects(launchManagedSession(dead, options), /session_ended/);
    assert.equal(launches, 1);
  });
  await check('stop is local to a selected GUI instance and does not submit a user message', async () => {
    let stops = 0, sends = 0;
    const transport = await startGuiIPC({ base, snapshot: () => ({}), send: () => { sends++; }, interrupt: async () => { stops++; return { status: 'accepted' }; } });
    try {
      assert.equal((await requestGui({ base, pid: process.pid, instance: transport.instance, op: 'interrupt' })).ok, true);
      assert.equal(stops, 1); assert.equal(sends, 0);
      assert.equal((await requestGui({ base, pid: process.pid, instance: randomUUID(), op: 'interrupt' })).ok, false);
      assert.equal(stops, 1);
    } finally { transport.close(); }
  });
  console.log(`${passed} session launcher checks passed`);
} finally { rmSync(base, { recursive: true, force: true }); }
