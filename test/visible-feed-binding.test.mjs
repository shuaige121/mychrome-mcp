import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { clientDisplayName } from '../src/client.js';
import { startConversationService } from '../src/gui-service.js';
import { connectVisibleFeed } from '../src/visible-feed-host.js';
import { connectConversationHost } from '../src/conversation-host.js';
import { requestGui } from '../src/gui-ipc.js';

// Real production binding functions + isolated GUI service and synthetic local sockets.
// No MCP worker, Chrome, AppKit, inherited environment, or user conversation is opened.
const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const functionSource = name => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `Missing production ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const feedStart = source.indexOf('let VISIBLE_FEED =');
const feedEnd = source.indexOf('\n/** The task named by', feedStart);
assert.ok(feedStart >= 0 && feedEnd > feedStart);
const feedSource = source.slice(feedStart, feedEnd)
  .replace("await import('./visible-feed-host.js')", 'await loadVisibleFeed()');
const eventually = async (check, message) => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { if (await check()) return; await delay(5); }
  assert.fail(message);
};
let passed = 0;
const failures = [];
function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    setTimeout(fn, ms) { const timer = { at: now + ms, fn, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(t => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next); now = next.at; next.fn();
      }
      now = until;
    },
  };
}
async function check(name, run) {
  try { await run(); passed++; console.log(`ok - ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL - ${name}\n${error.stack}`); }
}

async function bindingHarness(run, { client = 'Codex', env = {}, restoreBinding = null, reconnectClock } = {}) {
  const base = await mkdtemp('/tmp/mychrome-binding-');
  const hosts = [], observers = [], panels = [];
  const service = await startConversationService({
    base, restoreBinding, onPresence() {}, retryDelaysMs: [10, 20], reconnectClock,
    connect({ threadId, onChange }) {
      const state = { threadId, status: 'connected', entries: [], resetRevision: 0, pending: [], canSend: true };
      const host = { state, snapshot: () => ({ ...state }), close() { state.status = 'disconnected'; onChange(); },
        emit(text, id = 'public-message') { state.entries = [{ id, text }]; onChange(); },
        reset() { state.entries = []; state.resetRevision++; onChange(); },
        disconnect() { state.status = 'disconnected'; onChange(); } };
      // Exercise re-entrant publishers before assignment and while closing an old host.
      onChange(); hosts.push(host); return host;
    },
  });
  const context = vm.createContext({
    GUI_SERVICE: service, GUI_THREAD: null, server: { getClientVersion: () => ({ name: client }) },
    clientDisplayName, process: { env }, PLAN: { task: 'Synthetic task' },
    TASK_HOLD: { kept: { session: { request: async value => { panels.push(value); return { ok: true }; } } } },
    setTimeout, clearTimeout, queueMicrotask,
    loadVisibleFeed: async () => ({ connectVisibleFeed(options) {
      const state = { status: 'connected', resetRevision: 0,
        entries: [{ id: 'direct', text: `From ${options.threadId}` }] };
      const observer = { threadId: options.threadId, closed: false,
        snapshot: () => state,
        reset() { state.entries = []; state.resetRevision++; options.onChange(); },
        close() { observer.closed = true; } };
      observers.push(observer); return observer;
    } }),
  });
  vm.runInContext(`${functionSource('bindGuiThread')}\n${feedSource}`, context);
  const h = vm.runInContext('({ connectTaskFeed, closeTaskFeed, feedSnapshot, taskFeedMessage, bindGuiThread })', context);
  try { await run({ ...h, service, hosts, observers, panels }); }
  finally { h.closeTaskFeed(); service.close(); await rm(base, { recursive: true, force: true }); }
}

await check('an explicit Codex thread shares the GUI public stream without a duplicate observer', () => bindingHarness(async h => {
  await h.connectTaskFeed('thread-a', { sameTask: false });
  h.hosts[0].emit('Synthetic visible progress');
  await eventually(() => h.panels.some(p => p.feedEntries.includes('Synthetic visible progress')), 'public prose did not reach panel');
  assert.equal(h.observers.length, 0);
}));

await check('omitting the ID inside the same task preserves its pinned source', () => bindingHarness(async h => {
  await h.connectTaskFeed('thread-a', { sameTask: false });
  h.hosts[0].emit('Existing live prose');
  await h.connectTaskFeed(undefined, { sameTask: true });
  assert.equal(h.feedSnapshot().feedStatus, 'connected');
  assert.ok(h.feedSnapshot().feedEntries.includes('Existing live prose'));
}));

await check('a new task can use a verified restored manual GUI association', () => bindingHarness(async h => {
  h.bindGuiThread();
  await h.connectTaskFeed(undefined, { sameTask: false });
  h.hosts[0].emit('Manually associated public progress');
  assert.ok(h.feedSnapshot().feedEntries.includes('Manually associated public progress'));
}, { restoreBinding: { version: 1, provider: 'Codex', threadId: 'manual-thread', manual: true } }));

await check('a verified automatic carry is reusable, while an unrelated new task cannot guess the prior automatic thread', async () => {
  await bindingHarness(async h => {
    h.bindGuiThread();
    await h.connectTaskFeed(undefined, { sameTask: false });
    h.hosts[0].emit('Carried source progress');
    assert.ok(h.feedSnapshot().feedEntries.includes('Carried source progress'));
  }, { restoreBinding: { version: 1, provider: 'Codex', threadId: 'carried-thread', manual: false } });
  await bindingHarness(async h => {
    await h.connectTaskFeed('previous-thread', { sameTask: false });
    await h.connectTaskFeed(undefined, { sameTask: false });
    assert.equal(h.feedSnapshot().feedReason, 'unbound_thread');
    assert.equal(h.feedSnapshot().feedEntries.length, 0);
    assert.match(h.taskFeedMessage(), /未连接/);
  });
});

await check('a verified Codex environment ID works and task completion only closes its subscriber', () => bindingHarness(async h => {
  await h.connectTaskFeed(undefined, { sameTask: false });
  h.hosts[0].emit('Environment-selected prose');
  assert.equal(h.feedSnapshot().feedSource, 'environment');
  assert.ok(h.feedSnapshot().feedEntries.includes('Environment-selected prose'));
  h.closeTaskFeed();
  assert.equal(h.service.snapshot().status, 'connected');
  assert.equal(h.feedSnapshot().feedEntries.length, 0);
}, { env: { CODEX_THREAD_ID: 'verified-current-thread' } }));

for (const client of ['Claude Code', 'unrecognized-client', '']) {
  await check(`${client || 'unknown'} cannot inherit a Codex progress stream`, () => bindingHarness(async h => {
    await h.connectTaskFeed(undefined, { sameTask: false });
    assert.equal(h.observers.length, 0, 'unsupported provider opened the Codex adapter');
    assert.equal(h.hosts.length, 0);
    assert.equal(h.feedSnapshot().feedReason, 'unsupported_client');
    assert.match(h.taskFeedMessage(), /不可用/);
  }, { client, env: { CODEX_THREAD_ID: 'parent-codex-thread' } }));
}

await check('explicit task A cannot display the GUI manual selection B', () => bindingHarness(async h => {
  await h.connectTaskFeed('thread-a', { sameTask: false });
  h.hosts[0].emit('Other conversation B');
  assert.equal(h.observers[0]?.threadId, 'thread-a');
  assert.ok(!h.feedSnapshot().feedEntries.includes('Other conversation B'));
  assert.equal(h.feedSnapshot().feedReason, 'binding_conflict');
}, { restoreBinding: { version: 1, provider: 'Codex', threadId: 'thread-b', manual: true } }));

await check('GUI browsing B leaves the continuous task on A and retains its already-visible text', () => bindingHarness(async h => {
  await h.connectTaskFeed('thread-a', { sameTask: false });
  h.hosts[0].emit('Task A progress');
  h.service.bind('thread-b', 'Codex');
  h.hosts[1].emit('Foreign B progress');
  await eventually(() => h.observers.length === 1, 'task A did not detach into its own observer');
  assert.equal(h.observers[0].threadId, 'thread-a');
  assert.equal(h.service.snapshot().threadId, 'thread-b', 'the task must not navigate the GUI back');
  assert.ok(!h.service.snapshot().entries.some(entry => entry.text === 'Task A progress'), 'a new GUI binding inherited the old seed');
  assert.ok(h.feedSnapshot().feedEntries.includes('Task A progress'));
  assert.ok(!h.feedSnapshot().feedEntries.includes('Foreign B progress'));
  assert.equal(h.feedSnapshot().feedReason, 'binding_conflict');
}));

await check('an independent source reset cannot resurrect text retained from the previous shared subscription', () => bindingHarness(async h => {
  await h.connectTaskFeed('thread-a'); h.hosts[0].emit('Old live A text');
  h.service.bind('thread-b', 'Codex');
  await eventually(() => h.observers.length === 1, 'independent subscription missing');
  assert.ok(h.feedSnapshot().feedEntries.includes('Old live A text'));
  h.observers[0].reset();
  assert.equal(h.feedSnapshot().feedEntries.length, 0, 'reverted/deleted seed text was resurrected');
}));

await check('task completion cancels a queued GUI-detach subscription without closing the GUI host', () => bindingHarness(async h => {
  await h.connectTaskFeed('thread-a'); h.hosts[0].emit('Live A');
  h.service.bind('thread-b', 'Codex');
  h.closeTaskFeed();
  await delay(5);
  assert.equal(h.observers.length, 0, 'a completed task opened a late independent subscription');
  assert.equal(h.feedSnapshot().feedEntries.length, 0);
  assert.equal(h.service.snapshot().status, 'connected');
  assert.equal(h.service.snapshot().threadId, 'thread-b');
}));

await check('same-thread shared reconnect retains live memory but a reset clears it', () => bindingHarness(async h => {
  await h.connectTaskFeed('thread-a'); h.hosts[0].emit('Previously observed A');
  h.hosts[0].disconnect();
  await eventually(() => h.hosts.length === 2, 'shared subscription never reconnected');
  assert.ok(h.feedSnapshot().feedEntries.includes('Previously observed A'));
  h.hosts[1].emit('New A message', 'new-message');
  assert.ok(h.feedSnapshot().feedEntries.includes('Previously observed A'));
  assert.ok(h.feedSnapshot().feedEntries.includes('New A message'));
  h.hosts[1].reset();
  assert.equal(h.feedSnapshot().feedEntries.length, 0);
}));

await check('a disconnected same-thread GUI host gets bounded fresh subscriptions without sending', () => bindingHarness(async h => {
  h.service.bind('thread-a', 'Codex');
  h.hosts[0].disconnect();
  await eventually(() => h.hosts.length === 2, 'same-thread host was never reconnected');
  assert.equal(h.hosts[1].state.threadId, 'thread-a');
  h.hosts[1].disconnect();
  await eventually(() => h.hosts.length === 3, 'second bounded reconnect was not attempted');
  h.hosts[2].disconnect();
  await delay(80);
  assert.equal(h.hosts.length, 3, 'retry budget was reset by connection success/polling');
}));

await check('GUI reconnect budget resets only after a stable thirty-second connection', async () => {
  const clock = fakeClock();
  await bindingHarness(async h => {
    h.service.bind('thread-a', 'Codex');
    for (let round = 0; round < 2; round++) {
      const before = h.hosts.length;
      h.hosts.at(-1).disconnect(); clock.advance(10);
      h.hosts.at(-1).disconnect(); clock.advance(20);
      assert.equal(h.hosts.length, before + 2);
      clock.advance(30_000);
    }
    h.hosts.at(-1).disconnect(); clock.advance(10);
    h.hosts.at(-1).disconnect(); clock.advance(20);
    const exhausted = h.hosts.length;
    h.hosts.at(-1).disconnect(); clock.advance(30_000);
    assert.equal(h.hosts.length, exhausted, 'disconnected time must not reset a failed budget');
  }, { reconnectClock: clock });
});

async function socketFixture(run, { status = 'active', observer = true, onRequest, reconnectClock } = {}) {
  const base = await mkdtemp('/tmp/mychrome-binding-socket-');
  const socketPath = `${base}/host.sock`, requests = [];
  const httpServer = http.createServer();
  const ws = new WebSocketServer({ server: httpServer });
  let count = 0;
  ws.on('connection', peer => {
    const connection = ++count;
    peer.on('message', bytes => {
      const request = JSON.parse(bytes); requests.push(request);
      const reply = result => peer.send(JSON.stringify({ id: request.id, result }));
      if (onRequest?.(request, peer)) return;
      if (request.method === 'initialize') reply({});
      else if (request.method === 'thread/read') reply({ thread: { id: 'thread-a', status: { type: status }, updatedAt: 1, canAcceptDirectInput: true } });
      else if (request.method === 'thread/resume') {
        if (status === 'idle') {
          reply({ thread: { id: 'thread-a', status: { type: status }, canAcceptDirectInput: true } });
          return;
        }
        peer.send(JSON.stringify({ method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a',
          item: { id: `message-${connection}`, type: 'agentMessage', phase: 'commentary', text: '' } } }));
        reply({ thread: { id: 'thread-a', status: { type: 'active' }, updatedAt: 1 } });
        peer.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-a', turnId: 'turn-a',
          itemId: `message-${connection}`, delta: `Public progress ${connection}` } }));
      }
    });
  });
  httpServer.listen(socketPath); await once(httpServer, 'listening'); await chmod(socketPath, 0o600);
  const feed = observer ? connectVisibleFeed({ threadId: 'thread-a', socketPath, env: {}, retryDelaysMs: [10, 20], reconnectClock }) : null;
  try { await run({ base, socketPath, feed, requests,
    send: value => { for (const peer of ws.clients) peer.send(JSON.stringify(value)); },
    disconnect: () => { for (const peer of ws.clients) peer.close(); }, connections: () => count }); }
  finally {
    feed?.close(); for (const peer of ws.clients) peer.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => httpServer.close(resolve));
    await rm(base, { recursive: true, force: true });
  }
}

await check('verified live item-start before the resume response remains admitted', () => socketFixture(async h => {
  await eventually(() => h.feed.snapshot().status === 'connected', 'feed not connected');
  await eventually(() => h.feed.snapshot().entries.some(e => e.text === 'Public progress 1'), 'resume-time live start was lost');
}));

for (const adapter of ['task observer', 'GUI host']) {
  await check(`${adapter} exposes resets only from its selected thread, including deletion`, () => socketFixture(async h => {
    const feed = h.feed ?? connectConversationHost({ threadId: 'thread-a', socketPath: h.socketPath, env: {} });
    try {
      await eventually(() => feed.snapshot().entries.length > 0, 'public message missing');
      assert.equal(feed.snapshot().resetRevision, 0, 'a fresh host is not a source reset');
      h.send({ method: 'thread/reverted', params: { threadId: 'foreign-thread' } });
      await delay(10);
      assert.equal(feed.snapshot().resetRevision, 0);
      for (const [revision, method] of [[1, 'thread/reverted'], [2, 'thread/deleted']]) {
        h.send({ method, params: { threadId: 'thread-a' } });
        await eventually(() => feed.snapshot().resetRevision === revision, `${method} reset missing`);
        assert.equal(feed.snapshot().entries.length, 0);
      }
    } finally { if (!h.feed) feed.close(); }
  }, { observer: adapter === 'task observer' }));
}

await check('direct observer retries recover across multiple stable thirty-second periods', async () => {
  const clock = fakeClock();
  await socketFixture(async h => {
    await eventually(() => h.feed.snapshot().status === 'connected', 'feed not connected');
    for (let round = 0; round < 2; round++) {
      for (const backoff of [10, 20]) {
        const before = h.connections();
        h.disconnect();
        await eventually(() => h.feed.snapshot().reason === 'reconnecting', 'no reconnect was scheduled');
        clock.advance(backoff);
        await eventually(() => h.connections() === before + 1 && h.feed.snapshot().status === 'connected', 'reconnect failed');
      }
      clock.advance(30_000);
    }
  }, { reconnectClock: clock });
});

await check('a disconnected direct observer reconnects only with read/resume and a bounded budget', () => socketFixture(async h => {
  await eventually(() => h.feed.snapshot().status === 'connected', 'feed not connected');
  h.disconnect();
  await eventually(() => h.connections() === 2 && h.feed.snapshot().status === 'connected', 'direct observer did not reconnect');
  h.disconnect();
  await eventually(() => h.connections() === 3 && h.feed.snapshot().status === 'connected', 'second observer reconnect missing');
  h.disconnect(); await delay(80);
  assert.equal(h.connections(), 3);
  assert.ok(h.requests.every(r => ['initialize', 'initialized', 'thread/read', 'thread/resume'].includes(r.method)));
}));

await check('a real IPC send with unknown delivery survives the retry window without ledger loss or replay', () => socketFixture(async h => {
  let presence;
  const service = await startConversationService({
    base: h.base, onPresence: value => { presence = value; }, retryDelaysMs: [10, 20],
    connect: options => connectConversationHost({ ...options, socketPath: h.socketPath, env: {}, timeoutMs: 300 }),
  });
  const call = (op, payload) => requestGui({ base: h.base, pid: process.pid, instance: presence.guiInstance, op, payload });
  try {
    service.bind('thread-a', 'Codex');
    await eventually(() => service.snapshot().canSend, 'synthetic host was not ready');
    const bindingId = service.snapshot().bindingId;
    const payload = { threadId: 'thread-a', bindingId, nonce: 'uncertain-send', text: 'SYNTHETIC_USER_INPUT' };
    const first = await call('send', payload);
    assert.equal(first.delivery, 'unknown');
    service.bind('thread-a', 'Codex');
    await delay(80);
    assert.equal(service.snapshot().bindingId, bindingId);
    assert.deepEqual(await call('send', payload), first);
    assert.equal(service.snapshot().lastDelivery.delivery, 'unknown');
    assert.equal(h.connections(), 1);
    assert.equal(h.requests.filter(r => r.method === 'turn/start').length, 1);
  } finally { service.close(); }
}, { status: 'idle', observer: false, onRequest(request, peer) {
  if (request.method !== 'turn/start') return false;
  peer.close(); return true;
} }));

await check('accepted reply receipts survive a later read-only reconnect without replaying their nonce', () => socketFixture(async h => {
  let presence;
  const service = await startConversationService({
    base: h.base, onPresence: value => { presence = value; }, retryDelaysMs: [10, 20],
    connect: options => connectConversationHost({ ...options, socketPath: h.socketPath, env: {}, timeoutMs: 300 }),
  });
  const call = (op, payload) => requestGui({ base: h.base, pid: process.pid, instance: presence.guiInstance, op, payload });
  try {
    service.bind('thread-a', 'Codex');
    await eventually(() => service.snapshot().canSend, 'synthetic host was not ready');
    const bindingId = service.snapshot().bindingId;
    const payload = { threadId: 'thread-a', bindingId, nonce: 'accepted-send', text: 'SYNTHETIC_USER_INPUT' };
    const receipt = await call('send', payload);
    assert.equal(receipt.result.delivery, 'accepted');
    h.disconnect();
    await eventually(() => h.connections() === 2 && service.snapshot().status === 'connected', 'readonly reconnect missing');
    assert.notEqual(service.snapshot().bindingId, bindingId);
    assert.deepEqual(await call('send', payload), receipt);
    assert.equal((await call('send', { ...payload, nonce: 'new-intent-old-binding' })).code, 'conversation_changed');
    assert.equal(h.requests.filter(r => r.method === 'turn/start').length, 1);
  } finally { service.close(); }
}, { status: 'idle', observer: false, onRequest(request, peer) {
  if (request.method !== 'turn/start') return false;
  peer.send(JSON.stringify({ id: request.id, result: { turn: { id: 'synthetic-accepted-turn' } } })); return true;
} }));

console.log(`Visible feed binding: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
