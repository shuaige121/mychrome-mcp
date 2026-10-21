import assert from 'node:assert/strict';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startConversationService } from '../src/gui-service.js';
import { requestGui } from '../src/gui-ipc.js';

const rows = ['thread-a', 'thread-b', 'thread-c'].map(threadId => ({
  threadId, title: `Synthetic ${threadId}`,
}));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
let passed = 0, failed = 0;

async function check(name, run) {
  const base = await mkdtemp(path.join(tmpdir(), 'mychrome-association-'));
  const connected = [], closed = [], sent = [], discovery = [];
  let presence, discoverCount = 0;
  const service = await startConversationService({
    base,
    onPresence: fields => { presence = fields; },
    discover: async () => {
      discoverCount++;
      const next = discovery.shift();
      if (!next) return rows;
      next.started.resolve();
      return next.result.promise;
    },
    connect: ({ threadId }) => {
      connected.push(threadId);
      return {
        snapshot: () => ({ threadId, status: 'connected', canSend: true, entries: [], pending: [] }),
        send: async payload => {
          sent.push({ threadId, payload });
          return { status: 'accepted', delivery: 'accepted' };
        },
        close: () => closed.push(threadId),
      };
    },
  });
  const call = (op, payload) => requestGui({
    base, pid: process.pid, instance: presence.guiInstance, op, payload, timeoutMs: 1000,
  });
  const delayDiscovery = () => {
    const next = { started: deferred(), result: deferred() };
    discovery.push(next);
    return { started: next.started.promise, resolve: next.result.resolve };
  };
  try {
    await run({
      service, call, connected, closed, sent, delayDiscovery,
      discoverCount: () => discoverCount,
    });
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}\n${error.stack}`);
  } finally {
    service.close();
    await rmdir(base);
  }
}

await check('an arbitrary thread is rejected before discovery or host activity', async ({
  service, call, connected, sent, discoverCount,
}) => {
  service.bind(null, 'Codex');
  const response = await call('bind', { threadId: 'thread-b' });
  assert.equal(response.code, 'conversation_not_listed');
  assert.equal(response.delivery, 'not_sent');
  assert.equal(discoverCount(), 0);
  assert.deepEqual(connected, []);
  assert.deepEqual(sent, []);
});

await check('discovery is read-only and an explicitly selected listed thread becomes the destination', async ({
  service, call, connected, sent, discoverCount,
}) => {
  service.bind(null, 'Codex');
  const found = await call('discover');
  assert.equal(found.ok, true);
  assert.deepEqual(found.conversations, rows);
  assert.deepEqual(connected, []);
  assert.deepEqual(sent, []);
  const bound = await call('bind', { threadId: 'thread-b' });
  assert.equal(bound.ok, true);
  assert.equal(bound.snapshot.threadId, 'thread-b');
  assert.equal(discoverCount(), 2, 'the selection is checked against a fresh host listing');
  assert.deepEqual(connected, ['thread-b']);
  assert.deepEqual(sent, [], 'association alone cannot submit model input');
});

await check('automatic empty or stale thread metadata does not clear a manual selection', async ({
  service, call, connected, sent,
}) => {
  service.bind('thread-a', 'Codex');
  await call('discover');
  assert.equal((await call('bind', { threadId: 'thread-b' })).ok, true);
  const manual = service.snapshot();
  service.bind(null, 'Codex');
  service.bind('thread-a', 'Codex');
  assert.equal(service.snapshot().threadId, 'thread-b');
  assert.equal(service.snapshot().bindingId, manual.bindingId);
  assert.deepEqual(connected, ['thread-a', 'thread-b']);
  assert.deepEqual(sent, []);
});

await check('an old draft cannot follow a manual association to another thread', async ({
  service, call, sent,
}) => {
  service.bind('thread-a', 'Codex');
  const old = service.snapshot();
  await call('discover');
  await call('bind', { threadId: 'thread-b' });
  const payload = {
    threadId: old.threadId, bindingId: old.bindingId,
    nonce: 'old-association-draft', text: 'Synthetic old draft',
  };
  assert.equal((await call('send', payload)).code, 'conversation_changed');
  assert.deepEqual(sent, []);
  const current = service.snapshot();
  const response = await call('send', {
    ...payload, nonce: 'current-association-draft',
    threadId: current.threadId, bindingId: current.bindingId,
  });
  assert.equal(response.result.delivery, 'accepted');
  assert.deepEqual(sent.map(item => item.threadId), ['thread-b']);
});

await check('a listed thread that disappears before association is refused', async ({
  service, call, connected, sent, delayDiscovery,
}) => {
  service.bind('thread-a', 'Codex');
  await call('discover');
  const next = delayDiscovery();
  const inflight = call('bind', { threadId: 'thread-b' });
  await next.started;
  next.resolve(rows.filter(row => row.threadId !== 'thread-b'));
  assert.equal((await inflight).code, 'conversation_expired');
  assert.equal(service.snapshot().threadId, 'thread-a');
  assert.deepEqual(connected, ['thread-a']);
  assert.deepEqual(sent, []);
});

for (const change of ['provider', 'binding', 'provider round trip']) {
  await check(`a ${change} change during association rejects the stale selection`, async ({
    service, call, connected, sent, delayDiscovery,
  }) => {
    service.bind('thread-a', 'Codex');
    await call('discover');
    const next = delayDiscovery();
    const inflight = call('bind', { threadId: 'thread-b' });
    await next.started;
    if (change === 'binding') service.bind('thread-c', 'Codex');
    else {
      service.bind('thread-a', 'Claude');
      if (change === 'provider round trip') service.bind('thread-a', 'Codex');
    }
    next.resolve(rows);
    assert.equal((await inflight).code, 'conversation_changed');
    assert.equal(connected.includes('thread-b'), false);
    assert.deepEqual(sent, []);
  });
}

for (const order of ['older first', 'newer first']) {
  await check(`the last valid selection wins concurrent association (${order})`, async ({
    service, call, connected, sent, delayDiscovery,
  }) => {
    service.bind('thread-a', 'Codex');
    await call('discover');
    const older = delayDiscovery(), newer = delayDiscovery();
    const first = call('bind', { threadId: 'thread-b' });
    await older.started;
    const second = call('bind', { threadId: 'thread-c' });
    await newer.started;
    if (order === 'older first') {
      older.resolve(rows);
      assert.equal((await first).code, 'conversation_changed');
      newer.resolve(rows);
      assert.equal((await second).ok, true);
    } else {
      newer.resolve(rows);
      assert.equal((await second).ok, true);
      older.resolve(rows);
      assert.equal((await first).code, 'conversation_changed');
    }
    assert.equal(service.snapshot().threadId, 'thread-c');
    assert.deepEqual(connected, ['thread-a', 'thread-c']);
    assert.deepEqual(sent, []);
  });
}

await check('an unlisted later selection does not cancel the last valid association intent', async ({
  service, call, connected, sent, delayDiscovery,
}) => {
  service.bind('thread-a', 'Codex');
  await call('discover');
  const next = delayDiscovery();
  const inflight = call('bind', { threadId: 'thread-b' });
  await next.started;
  assert.equal((await call('bind', { threadId: 'not-listed' })).code, 'conversation_not_listed');
  next.resolve(rows);
  assert.equal((await inflight).ok, true);
  assert.equal(service.snapshot().threadId, 'thread-b');
  assert.deepEqual(connected, ['thread-a', 'thread-b']);
  assert.deepEqual(sent, []);
});

await check('switching clients clears the manual selection and refuses discovery in an unsupported client', async ({
  service, call, connected, sent, discoverCount,
}) => {
  service.bind('thread-a', 'Codex');
  await call('discover');
  await call('bind', { threadId: 'thread-b' });
  service.bind('thread-a', 'Claude');
  const before = discoverCount();
  assert.equal((await call('discover')).code, 'unsupported_client');
  assert.equal(discoverCount(), before);
  service.bind('thread-c', 'Codex');
  assert.equal(service.snapshot().threadId, 'thread-c');
  assert.deepEqual(connected, ['thread-a', 'thread-b', 'thread-c']);
  assert.deepEqual(sent, []);
});

for (const change of ['binding', 'provider', 'provider round trip']) {
  await check(`a delayed discovery cannot authorize association after a ${change} change`, async ({
    service, call, connected, sent, delayDiscovery,
  }) => {
    service.bind('thread-a', 'Codex');
    const next = delayDiscovery();
    const inflight = call('discover');
    await next.started;
    if (change === 'binding') service.bind('thread-c', 'Codex');
    else {
      service.bind('thread-a', 'Claude');
      if (change === 'provider round trip') service.bind('thread-a', 'Codex');
    }
    next.resolve(rows);
    const found = await inflight;
    const rebound = await call('bind', { threadId: 'thread-b' });
    assert.equal(rebound.code, 'conversation_not_listed', 'a stale listing cannot authorize a new association');
    assert.equal(found.ok, false, 'a listing belongs to the provider and binding that requested it');
    assert.equal(found.code, 'conversation_changed');
    assert.equal(connected.includes('thread-b'), false);
    assert.deepEqual(sent, []);
  });
}

console.log(`GUI association: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
