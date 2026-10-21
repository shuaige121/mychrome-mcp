import assert from 'node:assert/strict';
import { attachVisibleFeed, createVisibleFeed, visibleProse } from '../src/visible-feed.js';
import {
  connectVisibleFeed, projectVisibleNotification, resolveVisibleFeedContext,
  visibleFeedField,
} from '../src/visible-feed-host.js';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtemp, chmod, rmdir } from 'node:fs/promises';

const threadId = 'test-visible-thread';
const turnId = 'test-visible-turn';
function lifecycle(method, item, extra = {}) {
  return { method, params: { threadId, turnId, item, ...extra } };
}
function start(id, text = '', phase = 'commentary') {
  return lifecycle('item/started', { id, type: 'agentMessage', text, phase });
}
function complete(id, text, phase = 'commentary') {
  return lifecycle('item/completed', { id, type: 'agentMessage', text, phase });
}
function delta(itemId, text, extra = {}) {
  return { method: 'item/agentMessage/delta',
    params: { threadId, turnId, itemId, delta: text, ...extra } };
}

{
  const updates = [];
  const feed = createVisibleFeed({ threadId, onUpdate: value => updates.push(value) });
  assert.equal(feed.push(start('message-a')), true);
  feed.push(delta('message-a', '正在检查'));
  feed.push(delta('message-a', '第七题。'));
  assert.equal(feed.snapshot().entries[0].text, '正在检查第七题。');
  feed.push(complete('message-a', '第七题仍为空，正在补填。'));
  assert.equal(feed.snapshot().entries[0].text, '第七题仍为空，正在补填。');
  assert.equal(feed.snapshot().entries[0].complete, true);
  assert.equal(feed.push(delta('message-a', 'late duplicate')), false);
  assert.equal(updates.length, 4);
  feed.push(complete('message-a', '已核对，第七题已填。'));
  assert.equal(feed.snapshot().entries[0].text, '已核对，第七题已填。');
  assert.equal(feed.push(complete('message-a', '已核对，第七题已填。')), false);
  // Do not invent question progress or claim task success from item completion.
  assert.deepEqual(Object.keys(feed.snapshot()).sort(), ['entries', 'resetRevision', 'status']);
  assert.equal(feed.snapshot().status, 'streaming');
}

{
  const feed = createVisibleFeed({ threadId });
  for (const type of ['reasoning', 'userMessage', 'commandExecution', 'functionCallOutput', 'plan']) {
    feed.push(lifecycle('item/started', {
      id: type, type, phase: 'commentary', text: 'not visible prose',
      summary: ['not visible prose'], content: ['not visible prose'],
    }));
    feed.push(lifecycle('item/completed', {
      id: type, type, phase: 'commentary', text: 'not visible prose',
    }));
  }
  for (const method of [
    'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta',
    'item/commandExecution/outputDelta', 'rawResponseItem/completed', 'item/plan/delta',
  ]) feed.push({ method, params: { threadId, turnId, delta: 'must not leak' } });
  feed.push(start('unknown-phase', 'unknown is not admitted', null));
  feed.push(start('analysis-phase', 'hidden reasoning', 'analysis'));
  feed.push({ ...start('rpc-response', 'not a notification'), id: 42 });
  feed.push(lifecycle('item/started', {
    id: 'foreign', type: 'agentMessage', phase: 'commentary', text: 'other conversation',
  }, { threadId: 'another-thread' }));
  feed.push(complete('historical-message', 'history without live start'));
  feed.push(delta('unknown-message', 'delta without classified start'));
  assert.deepEqual(feed.snapshot(), { status: 'waiting', resetRevision: 0, entries: [] });
}

{
  const feed = createVisibleFeed({ threadId });
  feed.push(start('message-a', '当前会话。'));
  assert.equal(feed.push(delta('message-a', 'other turn', { turnId: 'another-turn' })), false);
  assert.equal(feed.push(delta('message-a', 'other thread', { threadId: 'another-thread' })), false);
  assert.equal(feed.push(start('message-a', 'duplicate start')), false);
  assert.equal(feed.snapshot().entries[0].text, '当前会话。');
}

{
  const feed = createVisibleFeed({ threadId });
  feed.push(start('message-code'));
  for (const piece of ['我会检查。\n`', '`', '`sh\n', 'echo secret\n', '``', '`\n', '检查完毕。']) {
    feed.push(delta('message-code', piece));
    assert.ok(!feed.snapshot().entries.some(entry => entry.text.includes('echo secret')));
  }
  assert.equal(feed.snapshot().entries[0].text, '我会检查。\n检查完毕。');
  assert.equal(visibleProse('保留 `API` 名称。\n~~~js\nrun()\n~~~\n继续。'),
    '保留 `API` 名称。\n继续。');
  assert.equal(visibleProse('未闭合\n```shell\ncommand'), '未闭合');
  assert.equal(visibleProse('````text\n```\ncode\n````\n正文'), '正文');
}

{
  const feed = createVisibleFeed({ threadId, maxEntries: 2, maxTextChars: 10 });
  feed.push(start('a', 'one'));
  feed.push(start('b', 'two'));
  feed.push(start('c', 'three'));
  assert.deepEqual(feed.snapshot().entries.map(entry => entry.id), ['b', 'c']);
  assert.equal(feed.push(delta('c', 'x'.repeat(20))), false);
  assert.deepEqual(feed.snapshot().entries.map(entry => entry.id), ['b']);
  assert.equal(feed.snapshot().status, 'source-error');
}

{
  const unavailable = attachVisibleFeed({ threadId });
  assert.deepEqual(unavailable.snapshot(), { status: 'unavailable', resetRevision: 0, entries: [] });
  assert.equal(unavailable.push(start('synthetic', 'A fabricated plan')), false);
  const broken = attachVisibleFeed({ threadId, subscribe() { throw new Error('not exposed'); } });
  assert.equal(broken.snapshot().status, 'unavailable');
}

{
  let handlers;
  let unsubscriptions = 0;
  const feed = attachVisibleFeed({
    threadId,
    subscribe(value) { handlers = value; return () => { unsubscriptions += 1; }; },
  });
  handlers.onNotification(start('real-live-message', '已有公开消息。'));
  assert.equal(feed.snapshot().entries[0].text, '已有公开消息。');
  feed.dispose();
  feed.dispose();
  handlers.onNotification(delta('real-live-message', 'late'));
  assert.equal(unsubscriptions, 1);
  assert.equal(feed.snapshot().status, 'disconnected');
  assert.equal(feed.snapshot().entries[0].text, '已有公开消息。');
}

assert.throws(() => createVisibleFeed({}), /threadId/);

{
  const admitted = new Set(['known']);
  const payload = JSON.stringify({
    method: 'item/reasoning/textDelta',
    params: { threadId, turnId, itemId: 'known', delta: 'excluded reasoning' },
  });
  assert.equal(projectVisibleNotification(payload, threadId, admitted), null);
  assert.equal(projectVisibleNotification(JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { threadId: 'another-thread', turnId, itemId: 'known', delta: `mentions ${threadId}` },
  }), threadId, admitted), null);
  const actual = projectVisibleNotification(JSON.stringify(delta('known', '真实进度。')), threadId, admitted);
  assert.deepEqual(actual, delta('known', '真实进度。'));
  assert.equal(projectVisibleNotification(JSON.stringify(complete('unseen', 'older message')), threadId, admitted), null);
  assert.equal(visibleFeedField('{"ignored":{"text":"\\\"method\\\":\\\"wrong\\\""},"method":"actual"}', ['method']), 'actual');
  assert.equal(resolveVisibleFeedContext({ env: {} }), null);
  assert.deepEqual(resolveVisibleFeedContext({ hostMetadata: { threadId: 'from-host' }, env: {} }), { threadId: 'from-host' });
  assert.deepEqual(resolveVisibleFeedContext({ env: { CODEX_THREAD_ID: 'from-runtime' } }), { threadId: 'from-runtime' });
  assert.deepEqual(resolveVisibleFeedContext({
    threadId: 'explicit', hostMetadata: { threadId: 'host' }, env: { CODEX_THREAD_ID: 'runtime' },
  }), { threadId: 'explicit' });
}

{
  const feed = createVisibleFeed({ threadId });
  feed.push(start('removed', 'A visible message'));
  feed.push({ method: 'thread/reverted', params: { threadId: 'another-thread' } });
  assert.equal(feed.snapshot().entries.length, 1);
  assert.equal(feed.snapshot().resetRevision, 0);
  feed.push({ method: 'thread/reverted', params: { threadId } });
  assert.deepEqual(feed.snapshot().entries, []);
  assert.equal(feed.snapshot().resetRevision, 1);
  feed.push({ method: 'thread/deleted', params: { threadId } });
  assert.equal(feed.snapshot().resetRevision, 2);
}

async function eventually(check) {
  const until = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for test state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function withMockHost(threadStatus, run) {
  const directory = await mkdtemp('/tmp/mychrome-feed-test-');
  const socketPath = `${directory}/host.sock`;
  const server = http.createServer();
  const websocket = new WebSocketServer({ server });
  const requests = [];
  let client;
  websocket.on('connection', connection => {
    client = connection;
    connection.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      requests.push(message);
      const thread = { id: threadId, status: { type: threadStatus }, turns: [], updatedAt: 123 };
      if (message.method === 'initialize') connection.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === 'thread/read' || message.method === 'thread/resume') {
        connection.send(JSON.stringify({ id: message.id, result: { thread } }));
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  const updates = [];
  const feed = connectVisibleFeed({ threadId, socketPath, onChange: value => updates.push(value) });
  try { await run({ feed, updates, requests, send: value => client.send(JSON.stringify(value)) }); }
  finally {
    feed.close();
    await eventually(() => websocket.clients.size === 0);
    await new Promise(resolve => websocket.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rmdir(directory);
  }
}

await withMockHost('active', async ({ feed, requests, send, updates }) => {
  await eventually(() => feed.snapshot().status === 'connected');
  assert.deepEqual(requests.map(request => request.method),
    ['initialize', 'initialized', 'thread/read', 'thread/resume']);
  assert.deepEqual(requests[2].params, { threadId, includeTurns: false });
  assert.deepEqual(requests[3].params, { threadId, excludeTurns: true });
  send(lifecycle('item/started', { id: 'hidden', type: 'reasoning', summary: ['never display'] }));
  send(start('live'));
  send(delta('live', '实际消息，'));
  send(delta('live', '继续滚动。'));
  send(complete('live', '实际消息，完成核对。'));
  await eventually(() => feed.snapshot().entries[0]?.complete);
  assert.equal(feed.snapshot().entries[0].text, '实际消息，完成核对。');
  assert.ok(updates.every(update => ['connected', 'connecting'].includes(update.status)));
  send(complete('live', '更正后的原文。'));
  await eventually(() => feed.snapshot().entries[0]?.text === '更正后的原文。');
  send({ method: 'thread/reverted', params: { threadId } });
  await eventually(() => feed.snapshot().entries.length === 0);
  feed.close();
  assert.equal(feed.snapshot().status, 'disconnected');
  assert.equal(requests.some(request => /start|interrupt|settings|history|list/.test(request.method)), false);
});

await withMockHost('idle', async ({ feed, requests }) => {
  await eventually(() => feed.snapshot().status === 'unavailable');
  assert.equal(requests.some(request => request.method === 'thread/resume'), false);
  assert.deepEqual(feed.snapshot().entries, []);
});

console.log('ok visible feed mirrors scoped live prose, excludes reasoning/tools/history, and never fakes availability');
