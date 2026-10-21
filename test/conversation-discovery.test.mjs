import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdtemp, rmdir } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { discoverConversations } from '../src/conversation-discovery.js';

let passed = 0;
const metadata = (id, overrides = {}) => ({ thread: {
  id, name: `Title ${id}`, status: { type: 'idle' }, canAcceptDirectInput: true,
  preview: 'PRIVATE FIRST PROMPT', turns: [{ text: 'PRIVATE HISTORY' }],
  path: '/private/history', cwd: '/private/work', ...overrides,
} });
async function withHost(name, handler, run, mode = 0o600) {
  const dir = await mkdtemp('/tmp/mychrome-discovery-test-');
  const socketPath = `${dir}/host.sock`;
  const server = http.createServer(), ws = new WebSocketServer({ server });
  const requests = [];
  ws.on('connection', peer => peer.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    requests.push(message);
    const send = value => peer.send(JSON.stringify(value));
    const reply = value => send({ id: message.id, result: value });
    if (handler(message, { send, reply, peer })) return;
    if (message.method === 'initialize') reply({});
    else if (message.method === 'thread/loaded/list') reply({ data: ['thread-a'], nextCursor: null });
    else if (message.method === 'thread/read') reply(metadata(message.params.threadId));
  }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  await chmod(socketPath, mode);
  const discover = options => discoverConversations({ socketPath, timeoutMs: 500, ...options });
  try {
    await run({ discover, requests });
    const allowed = ['initialize', 'initialized', 'thread/loaded/list', 'thread/read'];
    assert.ok(requests.every(r => allowed.includes(r.method)), 'a discovery request navigated or mutated the host');
    for (const r of requests.filter(r => r.method === 'thread/read')) assert.equal(r.params.includeTurns, false);
    // With a server-initiated close, the client's close event precedes the server's cleanup.
    for (const end = Date.now() + 500; ws.clients.size && Date.now() < end;) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(ws.clients.size, 0, 'discovery left its connection open');
    passed++;
    console.log(`  ok  ${name}`);
  } finally {
    for (const peer of ws.clients) peer.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rmdir(dir);
  }
}

await withHost('only explicitly projected loaded-thread metadata is returned', () => false, async ({ discover, requests }) => {
  const rows = await discover();
  assert.deepEqual(rows, [{ threadId: 'thread-a', title: 'Title thread-a', status: 'idle', canAcceptDirectInput: true }]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|history|private|preview|cwd/);
  assert.deepEqual(requests.map(r => r.method), ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/loaded/list']);
});

await withHost('missing name uses an opaque ID suffix, never preview/history', (r, { reply }) => {
  if (r.method !== 'thread/read') return false;
  reply(metadata(r.params.threadId, { name: null, canAcceptDirectInput: null }));
  return true;
}, async ({ discover }) => {
  assert.deepEqual(await discover(), [{ threadId: 'thread-a', title: '未命名 · thread-a', status: 'idle', canAcceptDirectInput: false }]);
});

await withHost('pagination passes opaque cursors verbatim and deduplicates loaded IDs', (r, { reply }) => {
  if (r.method !== 'thread/loaded/list') return false;
  reply(r.params.cursor === undefined
    ? { data: ['thread-a', 'thread-b'], nextCursor: 'opaque:/?page=2' }
    : { data: ['thread-b', 'thread-c'], nextCursor: null });
  return true;
}, async ({ discover, requests }) => {
  assert.equal((await discover()).length, 3);
  assert.equal(requests.filter(r => r.method === 'thread/read').length, 3);
  assert.deepEqual(requests.filter(r => r.method === 'thread/loaded/list').map(r => r.params.cursor), [undefined, 'opaque:/?page=2', undefined, 'opaque:/?page=2']);
});

await withHost('pagination and metadata reads have a finite 100-thread upper bound', (r, { reply }) => {
  if (r.method !== 'thread/loaded/list') return false;
  const page = r.params.cursor === undefined ? 0 : Number(r.params.cursor);
  reply({ data: Array.from({ length: 25 }, (_, i) => `thread-${page * 25 + i}`), nextCursor: String(page + 1) });
  return true;
}, async ({ discover, requests }) => {
  assert.equal((await discover({ timeoutMs: 2000 })).length, 100);
  assert.equal(requests.filter(r => r.method === 'thread/read').length, 100);
  assert.equal(requests.filter(r => r.method === 'thread/loaded/list').length, 8);
});

await withHost('a repeated pagination cursor stops without reading history or navigating', (r, { reply }) => {
  if (r.method !== 'thread/loaded/list') return false;
  reply({ data: ['thread-a'], nextCursor: 'same' });
  return true;
}, async ({ discover, requests }) => {
  await assert.rejects(discover(), { code: 'invalid_host_response' });
  assert.equal(requests.filter(r => r.method === 'thread/read').length, 0);
});

await withHost('empty loaded list does not read any stored threads', (r, { reply }) => {
  if (r.method !== 'thread/loaded/list') return false;
  reply({ data: [], nextCursor: null });
  return true;
}, async ({ discover, requests }) => {
  assert.deepEqual(await discover(), []);
  assert.equal(requests.some(r => r.method === 'thread/read'), false);
});

await withHost('unloaded and deleted-between-list-and-read threads are omitted', (r, { send, reply }) => {
  if (r.method === 'thread/loaded/list') { reply({ data: ['unloaded', 'deleted', 'loaded'], nextCursor: null }); return true; }
  if (r.method !== 'thread/read') return false;
  if (r.params.threadId === 'deleted') send({ id: r.id, error: { code: -32600, message: 'PRIVATE deleted path' } });
  else reply(metadata(r.params.threadId, { status: { type: r.params.threadId === 'unloaded' ? 'notLoaded' : 'active' } }));
  return true;
}, async ({ discover }) => {
  const rows = await discover();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].threadId, 'loaded');
  assert.equal(rows[0].status, 'active');
});

await withHost('final loaded check excludes a thread unloaded after its metadata read', (() => {
  let lists = 0;
  return (r, { reply }) => {
    if (r.method !== 'thread/loaded/list') return false;
    reply({ data: ++lists === 1 ? ['thread-a'] : [], nextCursor: null });
    return true;
  };
})(), async ({ discover }) => assert.deepEqual(await discover(), []));

await withHost('closed/deleted events cannot resurrect a listed thread; other events expose nothing', (r, { send, reply }) => {
  if (r.method !== 'thread/read') return false;
  send({ method: 'item/agentMessage/delta', params: { threadId: 'foreign', delta: 'PRIVATE FOREIGN' } });
  send({ id: 50, method: 'item/tool/requestUserInput', params: { threadId: 'foreign', questions: ['PRIVATE QUESTION'] } });
  send({ method: 'thread/deleted', params: { threadId: r.params.threadId } });
  reply(metadata(r.params.threadId));
  return true;
}, async ({ discover, requests }) => {
  assert.deepEqual(await discover(), []);
  assert.equal(requests.some(r => r.id === 50), false);
});

await withHost('wrong metadata identity fails rather than returning an unlisted thread', (r, { reply }) => {
  if (r.method !== 'thread/read') return false;
  reply(metadata('foreign-unlisted'));
  return true;
}, async ({ discover }) => assert.rejects(discover(), { code: 'thread_mismatch' }));

await withHost('read timeout closes the connection and reports a fixed non-private error', r => r.method === 'thread/read',
  async ({ discover }) => assert.rejects(discover({ timeoutMs: 40 }), { code: 'discovery_timeout', message: 'discovery_timeout' }));

await withHost('a public socket is never contacted', () => false, async ({ discover, requests }) => {
  await assert.rejects(discover(), { code: 'host_unavailable' });
  assert.equal(requests.length, 0);
}, 0o666);

await withHost('initialization rejection does not enumerate or return private host errors', (r, { send }) => {
  if (r.method !== 'initialize') return false;
  send({ id: r.id, error: { code: -32000, message: 'PRIVATE HOST ERROR', data: { token: 'PRIVATE VALUE' } } });
  return true;
}, async ({ discover, requests }) => {
  await assert.rejects(discover(), { code: 'host_rejected', message: 'host_rejected' });
  assert.deepEqual(requests.map(r => r.method), ['initialize']);
});

await withHost('disconnect during concurrent reads rejects and closes every outstanding request', (r, { reply, peer }) => {
  if (r.method === 'thread/loaded/list') { reply({ data: ['a', 'b', 'c', 'd'], nextCursor: null }); return true; }
  if (r.method !== 'thread/read') return false;
  peer.close();
  return true;
}, async ({ discover }) => assert.rejects(discover(), { code: 'disconnected' }));

console.log(`\nConversation discovery: ${passed} checks passed (synthetic Unix sockets only).`);
