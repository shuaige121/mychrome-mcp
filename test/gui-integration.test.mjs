import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { guiSocketPath, requestGui } from '../src/gui-ipc.js';

// This is the actual stdio MCP worker, with every browser/background entry point
// disabled. No thread ID is inherited, so the GUI cannot join a real AI thread.
const root = fileURLToPath(new URL('..', import.meta.url));
const base = await mkdtemp('/tmp/mychrome-gui-integration-');
const settings = path.join(base, 'settings.json');
await writeFile(settings, JSON.stringify({ paused: true, activityLog: false }));
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CHROME_BRIDGE_HOTSWAP: '0',
  CHROME_BRIDGE_SWEEP: '0',
  CHROME_BRIDGE_MENUBAR: '0',
  CHROME_BRIDGE_WARM: '0',
  CHROME_BRIDGE_NOTIFY: '0',
  CHROME_BRIDGE_HABITS: 'off',
  CHROME_BRIDGE_LOCK: path.join(base, 'input.lock'),
  CHROME_BRIDGE_SETTINGS: settings,
  CHROME_BRIDGE_ACTIVITY: path.join(base, 'activity.jsonl'),
  CHROME_BRIDGE_TAB_DIR: path.join(base, 'tabs'),
  CHROME_BRIDGE_AGENT_STATE: path.join(base, 'agent-window.json'),
};
assert.ok(!Object.keys(env).some(key => key === 'CODEX_THREAD_ID' || key.startsWith('MYCHROME_VISIBLE')));
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'src/index.js')], env, stderr: 'pipe',
});
// Keep child diagnostics bounded and in memory; never read a real worker's logs.
let stderr = '';
transport.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
const client = new Client({ name: 'Codex', version: 'gui-integration-test' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label) {
  const until = Date.now() + 5000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out: ${label}\n${stderr}`);
    await pause(20);
  }
}
async function missing(file) {
  try { await access(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function removeFixture(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await removeFixture(file);
    else await unlink(file);
  }
  await rmdir(dir);
}
let closed = false;
try {
  await client.connect(transport);
  const presence = await eventually(async () => {
    let entries;
    try { entries = await readdir(path.join(base, 'servers')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    for (const entry of entries) {
      if (!/^\d+\.json$/.test(entry)) continue;
      const record = JSON.parse(await readFile(path.join(base, 'servers', entry), 'utf8'));
      if (record.guiInstance) return record;
    }
    return null;
  }, 'worker GUI presence');
  assert.ok(Number.isSafeInteger(presence.pid) && presence.pid > 0);
  assert.equal(presence.launcher, null, 'test unexpectedly started a hot-swap launcher');
  const snapshot = () => requestGui({
    base, pid: presence.pid, instance: presence.guiInstance, op: 'snapshot', timeoutMs: 1000,
  });
  const before = await snapshot();
  assert.equal(before.ok, true);
  assert.equal(before.snapshot.threadId, null);
  assert.equal(before.snapshot.canSend, false);
  assert.deepEqual(before.snapshot.pending, []);
  console.log('ok - initialized stdio worker exposes an unbound GUI socket without a real daemon');

  const done = await client.callTool({ name: 'task_plan', arguments: { done: true } });
  assert.notEqual(done.isError, true);
  assert.match(done.content.filter(item => item.type === 'text').map(item => item.text).join('\n'), /没有进行中的任务计划/);
  const after = await snapshot();
  assert.equal(after.ok, true);
  assert.equal(after.instance, before.instance);
  assert.equal(after.snapshot.bindingId, before.snapshot.bindingId);
  assert.equal(after.snapshot.threadId, null);
  assert.equal(after.snapshot.canSend, false);
  console.log('ok - task_plan done keeps the worker GUI instance and binding available');

  // Repeated task cleanup must not quietly damage the service either.
  await client.callTool({ name: 'task_plan', arguments: { done: true } });
  assert.equal((await snapshot()).ok, true);
  assert.equal(await missing(path.join(base, 'input.lock')), true);
  assert.equal(await missing(path.join(base, 'tabs')), true);
  assert.equal(await missing(path.join(base, 'agent-window.json')), true);
  console.log('ok - repeated done neither closes GUI nor enters a browser/input path');

  await client.close();
  closed = true;
  await eventually(() => missing(guiSocketPath(base, presence.pid)), 'normal exit removes GUI socket');
  await eventually(() => missing(path.join(base, 'servers', `${presence.pid}.json`)), 'normal exit removes presence');
  console.log('ok - normal stdio close removes this worker GUI socket and presence');
} finally {
  if (!closed) await client.close().catch(() => {});
  await removeFixture(base);
}

// Exercise index.js's real handoverCarry/applyCarry channel, replacing only the
// daemon with an owned synthetic socket. All workers remain globally paused.
const carriedBase = await mkdtemp('/tmp/mychrome-gui-handover-');
const carriedSettings = path.join(carriedBase, 'settings.json');
await writeFile(carriedSettings, JSON.stringify({ paused: true, activityLog: false }));
const daemonPath = path.join(carriedBase, 'synthetic.sock');
const daemon = http.createServer(), ws = new WebSocketServer({ server: daemon });
const frames = [], children = new Set();
let connections = 0;
const selectedThread = 'synthetic-manual-thread';
ws.on('connection', peer => {
  connections++;
  peer.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    frames.push(message);
    const reply = result => peer.send(JSON.stringify({ id: message.id, result }));
    if (message.method === 'initialize') reply({});
    else if (message.method === 'thread/loaded/list') reply({ data: [selectedThread], nextCursor: null });
    else if (['thread/read', 'thread/resume'].includes(message.method)) reply({
      thread: { id: message.params.threadId, name: 'Synthetic selected conversation',
        status: { type: 'idle' }, canAcceptDirectInput: true, turns: [] },
    });
  });
});
await new Promise(resolve => daemon.listen(daemonPath, resolve));
await chmod(daemonPath, 0o600);

async function carriedWorker(carry = null) {
  const child = spawn(process.execPath, [path.join(root, 'src/index.js'), '--worker'], {
    env: {
      ...env,
      CHROME_BRIDGE_WORKER: '1',
      CHROME_BRIDGE_LAUNCHER_PID: String(process.pid),
      CHROME_BRIDGE_LOCK: path.join(carriedBase, 'input.lock'),
      CHROME_BRIDGE_SETTINGS: carriedSettings,
      CHROME_BRIDGE_ACTIVITY: path.join(carriedBase, 'activity.jsonl'),
      CHROME_BRIDGE_TAB_DIR: path.join(carriedBase, 'tabs'),
      CHROME_BRIDGE_AGENT_STATE: path.join(carriedBase, 'agent-window.json'),
      MYCHROME_VISIBLE_SOCKET: daemonPath,
      ...(carry ? { CHROME_BRIDGE_CARRY: 'ipc' } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  let output = '', sequence = 0, diagnostics = '', handover;
  const pending = new Map();
  const exited = new Promise(resolve => child.once('exit', code => { children.delete(child); resolve(code); }));
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', text => {
    output += text;
    let end;
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line), receive = pending.get(response.id);
      if (receive) { pending.delete(response.id); receive(response); }
    }
  });
  child.on('message', message => {
    if (message.t === 'carry?') child.send({ t: 'carry', carry });
    if (message.t === 'handover') handover = message;
  });
  const presencePath = path.join(carriedBase, 'servers', `${child.pid}.json`);
  const presence = async () => {
    try { return JSON.parse(await readFile(presencePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker ${method} timeout\n${diagnostics}`)); }, 5000);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await eventually(async () => (await presence())?.guiInstance, 'pre-initialize worker GUI socket');
  return {
    child, presence, call,
    initialize: async name => {
      const result = await call('initialize', {
        protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name, version: 'synthetic-handover' },
      });
      assert.ok(result.result?.serverInfo);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    gui: async (op, payload) => {
      const p = await presence();
      return requestGui({ base: carriedBase, pid: child.pid, instance: p.guiInstance, op, payload, timeoutMs: 1000 });
    },
    handover: async () => {
      child.send({ t: 'handover?' });
      await eventually(() => handover, 'worker handover result');
      assert.equal(handover.ok, true, JSON.stringify(handover));
      assert.equal(await exited, 0);
      await eventually(() => missing(guiSocketPath(carriedBase, child.pid)), 'old worker socket cleanup');
      return handover.carry;
    },
    close: async () => {
      child.stdin.end();
      assert.equal(await exited, 0);
    },
  };
}

try {
  const first = await carriedWorker();
  assert.equal(connections, 0, 'an unknown MCP client must not discover a host');
  await first.initialize('Codex');
  await eventually(async () => (await first.presence())?.conversationProvider === 'Codex', 'verified Codex provider');
  assert.equal((await first.gui('discover')).conversations[0].threadId, selectedThread);
  assert.equal((await first.gui('bind', { threadId: selectedThread })).ok, true);
  await eventually(async () => (await first.gui('snapshot')).snapshot.status === 'connected', 'first host validation');
  const old = await first.gui('snapshot');
  const carry = await first.handover();
  assert.deepEqual(carry.guiBinding, { version: 1, provider: 'Codex', threadId: selectedThread, manual: true });
  assert.doesNotMatch(JSON.stringify(carry), /Synthetic selected conversation|bindingId|guiInstance|nonce|lastDelivery/);
  console.log('ok - actual worker handover preserves only the explicitly selected thread metadata');

  const connectionsBefore = connections, readsBefore = frames.filter(m => m.method === 'thread/read').length;
  const second = await carriedWorker(carry);
  assert.equal(connections, connectionsBefore, 'carry cannot join before initialize verifies the new MCP client');
  const waiting = await second.gui('snapshot');
  assert.equal(waiting.snapshot.threadId, null);
  assert.equal(waiting.snapshot.canSend, false);
  await second.initialize('Codex');
  await eventually(async () => (await second.gui('snapshot')).snapshot.status === 'connected', 'restored host validation');
  const restored = await second.gui('snapshot');
  assert.equal(restored.snapshot.threadId, selectedThread);
  assert.equal(restored.snapshot.canSend, true);
  assert.notEqual(restored.instance, old.instance);
  assert.notEqual(restored.snapshot.bindingId, old.snapshot.bindingId);
  assert.deepEqual(restored.snapshot.entries, []);
  assert.deepEqual(restored.snapshot.pending, []);
  assert.equal(restored.snapshot.lastDelivery, null);
  assert.equal(frames.filter(m => m.method === 'thread/read').length, readsBefore + 1);
  assert.equal((await second.gui('send', {
    threadId: selectedThread, bindingId: old.snapshot.bindingId, nonce: 'old-binding-intent',
    text: 'SYNTHETIC_UNSENT_REPLY',
  })).code, 'conversation_changed');
  await second.call('tools/call', { name: 'task_plan', arguments: { done: true } });
  assert.equal((await second.gui('snapshot')).snapshot.threadId, selectedThread);
  await second.close();
  console.log('ok - replacement revalidates the selected thread with fresh identities and rejects the old reply binding');

  const beforeClaude = connections;
  const third = await carriedWorker(carry);
  await third.initialize('Claude');
  await eventually(async () => (await third.presence())?.conversationProvider === 'Claude', 'verified Claude provider');
  const unsupported = await third.gui('snapshot');
  assert.equal(unsupported.snapshot.reason, 'unsupported_client');
  assert.equal(unsupported.snapshot.threadId, null);
  assert.equal(connections, beforeClaude);
  const discarded = await third.handover();
  assert.equal(discarded.guiBinding, undefined);
  assert.equal(frames.filter(m => ['turn/start', 'turn/steer'].includes(m.method)).length, 0);
  for (const frame of frames.filter(m => m.method === 'thread/read')) assert.equal(frame.params.includeTurns, false);
  for (const frame of frames.filter(m => m.method === 'thread/resume')) assert.equal(frame.params.excludeTurns, true);
  console.log('ok - a replacement identified as Claude discards Codex carry without a host connection or model input');
} finally {
  for (const child of children) child.stdin.end();
  await eventually(() => children.size === 0, 'fixture worker cleanup');
  for (const peer of ws.clients) peer.terminate();
  await new Promise(resolve => ws.close(resolve));
  await new Promise(resolve => daemon.close(resolve));
  await removeFixture(carriedBase);
}
