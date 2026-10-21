import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { normalizeConversationBinding, startConversationService } from '../src/gui-service.js';
import { requestGui } from '../src/gui-ipc.js';
import { connectConversationHost } from '../src/conversation-host.js';

const base = await mkdtemp(path.join(tmpdir(), 'mychrome-route-'));
let presence, sent = [], closed = [];
const service = await startConversationService({
  base, onPresence: p => presence = p,
  connect: ({ threadId }) => ({
    snapshot: () => ({ threadId, status: 'connected', entries: [], pending: [] }),
    send: async p => { sent.push({ threadId, text: p.text }); return { status: 'accepted' }; },
    close: () => closed.push(threadId),
  }),
});
const call = (op, payload) => requestGui({ base, pid: process.pid, instance: presence.guiInstance, op, payload });
try {
  service.bind('thread-a', 'Codex');
  const old = (await call('snapshot')).snapshot;
  const draft = { threadId: old.threadId, bindingId: old.bindingId, text: 'answer for a', nonce: 'first' };
  service.bind('thread-b', 'Codex');
  assert.equal((await call('send', draft)).code, 'conversation_changed');
  assert.equal(sent.length, 0);
  const fresh = (await call('snapshot')).snapshot;
  assert.equal((await call('send', { ...draft, threadId: fresh.threadId, bindingId: fresh.bindingId, nonce: 'second' })).result.status, 'accepted');
  assert.deepEqual(sent, [{ threadId: 'thread-b', text: 'answer for a' }]);
  service.bind('thread-a', 'Claude');
  assert.equal((await call('snapshot')).snapshot.reason, 'unsupported_client');
  assert.equal((await call('send', draft)).delivery, 'not_sent');
  assert.deepEqual(closed, ['thread-a', 'thread-b']);
  console.log('GUI service: old binding rejected, explicit current destination accepted, Claude never misbound to inherited Codex thread');
} finally { service.close(); }

async function eventually(check) {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Synthetic GUI route timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Actual service -> IPC -> conversation host, with only the daemon replaced.
async function withDaemon(name, run, { restoreBinding = null } = {}) {
  const fixture = await mkdtemp('/tmp/mychrome-gui-route-');
  const socketPath = path.join(fixture, 'daemon.sock');
  const server = http.createServer(), ws = new WebSocketServer({ server });
  const wire = [], peers = new Set(), presences = [];
  const state = { handler: null };
  let latestPresence, connections = 0;
  ws.on('connection', peer => {
    connections++;
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('message', bytes => {
      const m = JSON.parse(bytes.toString());
      wire.push(m);
      const reply = result => peer.send(JSON.stringify({ id: m.id, result }));
      if (state.handler?.(m, { peer, reply }) === true) return;
      if (m.method === 'initialize') reply({});
      else if (m.method === 'thread/read' || m.method === 'thread/resume') reply({
        thread: { id: m.params.threadId, status: { type: 'idle' }, canAcceptDirectInput: true, turns: [] },
      });
      else if (m.method === 'turn/start') reply({
        turn: { id: 'synthetic-turn', status: 'inProgress', items: [] },
      });
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  const service = await startConversationService({
    base: fixture,
    restoreBinding,
    onPresence(p) { latestPresence = p; presences.push(p); },
    connect: options => connectConversationHost({ ...options, socketPath, timeoutMs: 300 }),
  });
  const call = (op, payload, instance = latestPresence.guiInstance) =>
    requestGui({ base: fixture, pid: process.pid, instance, op, payload, timeoutMs: 1000 });
  const draft = (s, nonce, text = 'SYNTHETIC_REPLY_BODY') => ({
    threadId: s.threadId, bindingId: s.bindingId, nonce, text,
  });
  try {
    await run({
      service, state, wire, call, draft, fixture, presences,
      connections: () => connections, latestPresence: () => latestPresence,
    });
    console.log(`GUI service: ${name}`);
  } finally {
    service.close();
    await eventually(() => peers.size === 0);
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rmdir(fixture);
  }
}
const inputFrames = wire => wire.filter(m => m.method === 'turn/start' || m.method === 'turn/steer');

await withDaemon('same-thread binding preserves nonce deduplication and never stores reply body', async ({
  service, call, draft, wire, fixture, presences, connections,
}) => {
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  const before = (await call('snapshot')).snapshot;
  const p = draft(before, 'same-binding-send');
  assert.equal((await call('send', p)).result.delivery, 'accepted');
  service.bind('thread-a', 'Codex');
  assert.equal(service.snapshot().bindingId, before.bindingId);
  assert.equal((await call('send', p)).result.delivery, 'accepted');
  assert.equal(connections(), 1);
  assert.equal(inputFrames(wire).length, 1);
  assert.equal(JSON.stringify(presences).includes(p.text), false);
  assert.deepEqual((await readdir(fixture)).sort(), ['daemon.sock', `gui-${process.pid}.sock`].sort());
});

await withDaemon('both destination IDs are required, independently, before host mutation', async ({
  service, call, draft, wire,
}) => {
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  const old = service.snapshot();
  service.bind('thread-b', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  const current = service.snapshot();
  for (const payload of [
    { ...draft(current, 'wrong-thread'), threadId: old.threadId },
    { ...draft(current, 'wrong-binding'), bindingId: old.bindingId },
  ]) {
    assert.equal((await call('send', payload)).code, 'conversation_changed');
  }
  assert.equal(inputFrames(wire).length, 0);
  assert.equal((await call('send', draft(current, 'current-target'))).result.delivery, 'accepted');
  assert.equal(inputFrames(wire)[0].params.threadId, 'thread-b');
});

await withDaemon('rebind during metadata preflight cancels old input before any model mutation', async ({
  service, call, draft, wire, state,
}) => {
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  let waiting = false;
  state.handler = m => {
    if (m.method !== 'thread/read' || m.params.threadId !== 'thread-a') return false;
    waiting = true;
    return true;
  };
  const old = service.snapshot();
  const inflight = call('send', draft(old, 'preflight-rebind'));
  await eventually(() => waiting);
  service.bind('thread-b', 'Codex');
  const outcome = await inflight;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.delivery, 'not_sent');
  await eventually(() => service.snapshot().status === 'connected');
  assert.equal(service.snapshot().threadId, 'thread-b');
  assert.equal(inputFrames(wire).length, 0);
});

await withDaemon('rebind after write reports unknown and never reroutes an old reply into the new thread', async ({
  service, call, draft, wire, state,
}) => {
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  state.handler = m => m.method === 'turn/start';
  const old = service.snapshot(), payload = draft(old, 'written-rebind');
  const inflight = call('send', payload);
  await eventually(() => inputFrames(wire).length === 1);
  service.bind('thread-b', 'Codex');
  const outcome = await inflight;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.delivery, 'unknown');
  await eventually(() => service.snapshot().status === 'connected');
  assert.deepEqual(await call('send', payload), outcome, 'same nonce returns the original uncertain outcome');
  assert.equal((await call('send', { ...payload, nonce: 'stale-binding-new-intent' })).code, 'conversation_changed');
  assert.equal(inputFrames(wire).length, 1);
  assert.equal(inputFrames(wire)[0].params.threadId, 'thread-a');
});

await withDaemon('unknown delivery retains the disconnected host for the same binding without replay', async ({
  service, call, draft, wire, state, connections,
}) => {
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  state.handler = (m, { peer }) => {
    if (m.method !== 'turn/start') return false;
    peer.close();
    return true;
  };
  const s = service.snapshot(), payload = draft(s, 'lost-reply');
  assert.equal((await call('send', payload)).delivery, 'unknown');
  service.bind('thread-a', 'Codex');
  assert.equal(service.snapshot().bindingId, s.bindingId);
  assert.equal((await call('send', payload)).delivery, 'unknown');
  assert.equal(inputFrames(wire).length, 1);
  assert.equal(connections(), 1);
});

await withDaemon('another GUI instance cannot replay a valid conversation binding', async ({
  service, call, draft, wire,
}) => {
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  assert.equal((await call('send', draft(service.snapshot(), 'wrong-instance'), 'stale-instance')).code, 'session_changed');
  assert.equal(inputFrames(wire).length, 0);
});

await withDaemon('delivery lookup observes pending and accepted state without submitting new input', async ({
  service, call, draft, wire, state,
}) => {
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  let release;
  state.handler = (m, { reply }) => {
    if (m.method !== 'turn/start') return false;
    release = () => reply({ turn: { id: 'synthetic-turn', status: 'inProgress', items: [] } });
    return true;
  };
  const payload = draft(service.snapshot(), 'pending-delivery');
  const inflight = call('send', payload);
  await eventually(() => release !== undefined);
  assert.deepEqual((await call('delivery', { nonce: payload.nonce })).result, { status: 'pending', delivery: 'unknown' });
  assert.deepEqual((await call('delivery', { nonce: 'not-created' })).result, { status: 'not_found', delivery: 'unknown' });
  release();
  const outcome = await inflight;
  assert.deepEqual(await call('delivery', { nonce: payload.nonce }), outcome);
  assert.equal(inputFrames(wire).length, 1);
});

await withDaemon('a lost GUI response is recovered by receipt lookup without repeating model input', async ({
  service, call, draft, wire, state, fixture, latestPresence,
}) => {
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  state.handler = (m, { reply }) => {
    if (m.method !== 'turn/start') return false;
    setTimeout(() => reply({ turn: { id: 'synthetic-turn', status: 'inProgress', items: [] } }), 60);
    return true;
  };
  const payload = draft(service.snapshot(), 'gui-response-lost');
  await assert.rejects(requestGui({
    base: fixture, pid: process.pid, instance: latestPresence().guiInstance,
    op: 'send', payload, timeoutMs: 20,
  }), /delivery unknown/);
  await eventually(() => service.snapshot().lastDelivery?.nonce === payload.nonce);
  const receipt = await call('delivery', { nonce: payload.nonce });
  assert.equal(receipt.result.delivery, 'accepted');
  assert.equal(inputFrames(wire).length, 1);
});

await withDaemon('stdin cannot override the native client argv target', async ({
  service, latestPresence, fixture,
}) => {
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  const clientPath = fileURLToPath(new URL('../src/gui-client.js', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [clientPath, String(process.pid), latestPresence().guiInstance], {
      env: { ...process.env, CHROME_BRIDGE_LOCK: path.join(fixture, 'input.lock') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', x => output += x);
    child.stderr.on('data', x => stderr += x);
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(`GUI client exited ${code}: ${stderr || output}`));
      else {
        try { resolve(JSON.parse(output)); } catch (e) { reject(e); }
      }
    });
    child.stdin.end(JSON.stringify({
      op: 'snapshot', pid: 99999999, instance: 'untrusted-stdin-target', base: '/no-such-gui-target',
    }));
  });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.threadId, 'thread-a');
});

const automatic = { version: 1, provider: 'Codex', threadId: 'thread-a', manual: false };
const manual = { version: 1, provider: 'Codex', threadId: 'thread-b', manual: true };
assert.deepEqual(normalizeConversationBinding({
  ...manual, entries: [{ text: 'OLD_PRIVATE_VISIBLE_TEXT' }], nonce: 'old-receipt',
  bindingId: 'old-binding', instance: 'old-instance', answers: { reply: 'OLD_PRIVATE_REPLY' },
}), manual);
for (const invalid of [
  null, {}, { ...manual, version: 2 }, { ...manual, provider: 'Claude' },
  { ...manual, threadId: '../invalid' }, { ...manual, manual: 'true' },
]) assert.equal(normalizeConversationBinding(invalid), null);
console.log('GUI service: handover metadata is a strict four-field projection, never text, replies or receipt identity');

await withDaemon('automatic handover waits for client identity and revalidates its thread on the fresh host', async ({
  service, wire, connections,
}) => {
  assert.deepEqual(service.exportBinding(), automatic);
  assert.equal(service.snapshot().threadId, null);
  service.bind(null, null);
  service.bind(null, '');
  assert.equal(connections(), 0);
  assert.deepEqual(service.exportBinding(), automatic);
  service.bind(null, 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  assert.equal(service.snapshot().threadId, automatic.threadId);
  assert.deepEqual(service.exportBinding(), automatic);
  for (let i = 0; i < 3; i++) service.bind(null, 'Codex');
  assert.equal(connections(), 1, 'metadata polling must not forget a carried automatic binding');
  assert.deepEqual(wire.filter(m => m.method === 'thread/read').map(m => m.params),
    [{ threadId: automatic.threadId, includeTurns: false }]);
  assert.deepEqual(wire.filter(m => m.method === 'thread/resume').map(m => m.params),
    [{ threadId: automatic.threadId, excludeTurns: true }]);
  assert.equal(inputFrames(wire).length, 0);
  service.bind('thread-c', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  assert.equal(service.snapshot().threadId, 'thread-c', 'fresh explicit metadata supersedes carried automatic identity');
  assert.deepEqual(service.exportBinding(), { ...automatic, threadId: 'thread-c' });
}, { restoreBinding: automatic });

await withDaemon('a carried manual selection survives unknown and stale automatic metadata', async ({
  service, wire, connections,
}) => {
  service.bind('thread-a', null);
  assert.deepEqual(service.exportBinding(), manual);
  assert.equal(connections(), 0);
  service.bind('thread-a', 'Codex');
  await eventually(() => service.snapshot().status === 'connected');
  service.bind(null, 'Codex');
  service.bind('thread-c', 'Codex');
  assert.equal(service.snapshot().threadId, manual.threadId);
  assert.deepEqual(service.exportBinding(), manual);
  assert.equal(connections(), 1);
  assert.equal(inputFrames(wire).length, 0);
}, { restoreBinding: manual });

for (const identity of ['Claude', 'Agent']) {
  await withDaemon(`a confirmed ${identity} client discards carried Codex identity without joining it`, async ({
    service, wire, connections,
  }) => {
    service.bind(null, null);
    service.bind('thread-a', identity);
    assert.equal(service.snapshot().reason, 'unsupported_client');
    assert.equal(service.snapshot().threadId, null);
    assert.equal(service.exportBinding(), null);
    service.bind(null, 'Codex');
    assert.equal(service.snapshot().threadId, null, 'discarded carry must not revive on a later provider change');
    assert.equal(connections(), 0);
    assert.equal(wire.length, 0);
  }, { restoreBinding: manual });
}

await withDaemon('a carried identity still refuses a thread that fresh metadata says is not loaded', async ({
  service, state, wire,
}) => {
  state.handler = (m, { reply }) => {
    if (m.method !== 'thread/read') return false;
    reply({ thread: { id: m.params.threadId, status: { type: 'notLoaded' }, canAcceptDirectInput: true } });
    return true;
  };
  service.bind(null, 'Codex');
  await eventually(() => service.snapshot().status !== 'connecting');
  assert.equal(service.snapshot().canSend, false);
  assert.equal(service.snapshot().status, 'unavailable');
  assert.equal(service.snapshot().reason, 'host_unavailable');
  assert.equal(wire.filter(m => m.method === 'thread/resume').length, 0);
  assert.equal(inputFrames(wire).length, 0);
}, { restoreBinding: manual });
