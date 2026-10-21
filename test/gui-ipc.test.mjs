import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { guiSocketPath, requestGui, startGuiIPC } from '../src/gui-ipc.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const splitAtChinese = bytes => {
  const offset = bytes.indexOf(Buffer.from('中'));
  assert.ok(offset >= 0, 'fixture must contain a multi-byte character');
  return offset + 1; // Deliberately stop inside that character's UTF-8 encoding.
};
async function rawRequest(socketPath, input, split = null) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');
  let output = '';
  try {
    await once(socket, 'connect');
    const response = new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) {
          try { resolve(JSON.parse(output.trim())); } catch (error) { reject(error); }
        }
      });
      socket.setTimeout(1000, () => reject(new Error('Raw GUI response timed out')));
    });
    if (split === null) socket.write(input);
    else {
      socket.write(input.subarray(0, split));
      await delay(25);
      socket.write(input.subarray(split));
    }
    return await response;
  } finally { socket.destroy(); }
}

// The preload observes reads without changing their values. Waiting for the first
// actual stdin read makes the CLI fragmentation test independent of process startup.
const stdinProbe = `const original = process.stdin.read;
process.stdin.read = function(size) {
  const chunk = original.call(this, size);
  if (chunk !== null) process.send?.('stdin-read');
  return chunk;
};`;
async function runClient(target, request, split = false) {
  const client = fileURLToPath(new URL('../src/gui-client.js', import.meta.url));
  const child = spawn(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(stdinProbe)}`,
    client, String(target.pid), target.instance,
  ], {
    env: { ...process.env, CHROME_BRIDGE_LOCK: path.join(target.base, 'input.lock') },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { errors += part; });
  const closed = once(child, 'close');
  const deadline = setTimeout(() => child.kill('SIGTERM'), 5000);
  try {
    const bytes = Buffer.from(JSON.stringify(request));
    if (split) {
      const read = once(child, 'message');
      const offset = splitAtChinese(bytes);
      child.stdin.write(bytes.subarray(0, offset));
      assert.equal((await read)[0], 'stdin-read');
      child.stdin.end(bytes.subarray(offset));
    } else child.stdin.end(bytes);
    const [code, signal] = await closed;
    assert.equal(signal, null, 'CLI must finish without its deadline');
    assert.equal(code, 0, errors || output);
    return JSON.parse(output);
  } finally {
    clearTimeout(deadline);
    if (child.connected) child.disconnect();
  }
}

const base = await mkdtemp(path.join(tmpdir(), 'mychrome-gui-'));
let delivered = [];
let currentSnapshot = { threadId: 'thread-a', status: 'connected' };
let unblock, markStarted;
const started = new Promise(resolve => { markStarted = resolve; });
const server = await startGuiIPC({
  base,
  snapshot: () => currentSnapshot,
  send: async payload => {
    delivered.push(payload);
    if (payload.nonce === 'rejected' || payload.nonce === 'not-sent') {
      const error = new Error('fixture refusal');
      error.code = 'host_rejected';
      error.delivery = payload.nonce === 'rejected' ? 'rejected' : 'not_sent';
      throw error;
    }
    if (payload.nonce === 'slow') {
      markStarted();
      await new Promise(resolve => { unblock = resolve; });
    }
    return { status: 'accepted' };
  },
});
const target = { base, pid: process.pid, instance: server.instance };
try {
  assert.equal((await stat(server.socketPath)).mode & 0o777, 0o600);
  assert.equal((await requestGui({ ...target, op: 'snapshot' })).snapshot.threadId, 'thread-a');
  assert.equal((await requestGui({ ...target, instance: 'old-worker', op: 'send', payload: { nonce: 'n1', text: 'wrong' } })).code, 'session_changed');
  assert.equal(delivered.length, 0);
  const text = 'Literal reply 中文\n$(touch /tmp/not-a-command) `not a shell`';
  assert.equal((await requestGui({ ...target, op: 'send', payload: { nonce: 'n2', text } })).result.status, 'accepted');
  assert.equal(delivered[0].text, text);
  assert.equal((await requestGui({ ...target, op: 'execute', payload: { text } })).code, 'invalid_request');
  assert.equal((await requestGui({ ...target, op: 'send', payload: { text } })).code, 'invalid_request');
  assert.deepEqual(await readdir(base), [path.basename(server.socketPath)]);
  assert.equal(delivered.length, 1);

  for (const invalid of [null, [], 42, 'invalid']) {
    assert.equal((await rawRequest(server.socketPath, JSON.stringify(invalid) + '\n')).code, 'invalid_request');
  }
  assert.equal((await requestGui({ ...target, op: 'snapshot' })).ok, true, 'invalid JSON shapes cannot kill the server');

  const chinese = '中文答复 😀 保持逐字一致';
  const bytes = Buffer.from(JSON.stringify({
    instance: server.instance, op: 'send', payload: { nonce: 'split-request', text: chinese },
  }) + '\n');
  assert.equal((await rawRequest(server.socketPath, bytes, splitAtChinese(bytes))).result.status, 'accepted');
  assert.equal(delivered.at(-1).text, chinese, 'request decoder must retain split UTF-8 bytes');

  const cli = await runClient(target, { op: 'send', payload: { nonce: 'split-stdin', text: chinese } }, true);
  assert.equal(cli.result.status, 'accepted');
  assert.equal(delivered.at(-1).text, chinese, 'CLI stdin must retain split UTF-8 bytes');
  // stdin may carry a request, but cannot override the trusted argv destination.
  const exactTarget = await runClient(target, {
    op: 'send', base: '/nonexistent', pid: 1, instance: 'wrong-worker',
    payload: { nonce: 'fixed-target', text: chinese },
  });
  assert.equal(exactTarget.result.status, 'accepted');
  assert.equal(delivered.at(-1).nonce, 'fixed-target');

  currentSnapshot = { threadId: 'thread-a', entries: [{ id: 'long', text: '中'.repeat(100_000) }] };
  assert.deepEqual((await requestGui({ ...target, op: 'snapshot' })).snapshot, currentSnapshot,
    'a valid large live feed must not be mistaken for a disconnected session');

  const beforeQuery = delivered.length;
  assert.equal((await requestGui({ ...target, op: 'delivery', payload: { nonce: 'unknown' } })).result.status, 'not_found');
  assert.equal(delivered.length, beforeQuery, 'checking an unknown nonce must not transmit input');
  const slow = requestGui({ ...target, op: 'send', payload: { nonce: 'slow', text: 'wait for receipt' } });
  await started;
  assert.equal((await requestGui({ ...target, op: 'delivery', payload: { nonce: 'slow' } })).result.status, 'pending');
  const duplicate = requestGui({ ...target, op: 'send', payload: { text: 'wait for receipt', nonce: 'slow' } });
  assert.equal((await requestGui({ ...target, op: 'send', payload: { nonce: 'slow', text: 'changed' } })).code, 'nonce_conflict');
  unblock();
  assert.equal((await slow).result.status, 'accepted');
  assert.equal((await duplicate).result.status, 'accepted');
  assert.equal((await requestGui({ ...target, op: 'delivery', payload: { nonce: 'slow' } })).result.status, 'accepted');
  assert.equal(delivered.filter(entry => entry.nonce === 'slow').length, 1, 'same nonce sends only once');
  assert.equal((await requestGui({ ...target, instance: 'old-worker', op: 'delivery', payload: { nonce: 'slow' } })).code, 'session_changed');
  for (const [nonce, delivery] of [['rejected', 'rejected'], ['not-sent', 'not_sent']]) {
    const refusal = await requestGui({ ...target, op: 'send', payload: { nonce, text: 'refused fixture' } });
    assert.deepEqual([refusal.ok, refusal.code, refusal.delivery], [false, 'host_rejected', delivery],
      'known refusal must not be weakened to uncertain delivery');
    assert.deepEqual(await requestGui({ ...target, op: 'delivery', payload: { nonce } }), refusal);
  }
  const unique = new Set(delivered.map(entry => entry.nonce)).size;
  for (let i = unique; i < 256; i++) {
    assert.equal((await requestGui({ ...target, op: 'send', payload: { nonce: `capacity-${i}`, text: 'bounded fixture' } })).ok, true);
  }
  const full = await requestGui({ ...target, op: 'send', payload: { nonce: 'overflow', text: 'must not reach sender' } });
  assert.deepEqual([full.ok, full.code, full.delivery], [false, 'capacity_reached', 'not_sent']);
  assert.equal(delivered.length, 256, 'receipt storage must remain bounded without evicting nonces');
  assert.equal((await requestGui({ ...target, op: 'delivery', payload: { nonce: 'slow' } })).result.status, 'accepted',
    'capacity cannot discard a previous receipt or trigger a resend');
  assert.deepEqual(await readdir(base), [path.basename(server.socketPath)], 'message contents remain out of files');
} finally { server.close(); }
await assert.rejects(() => readFile(server.socketPath));

// Force a reply boundary inside a character independently of the server's
// request decoder: the production requestGui client must decode incrementally too.
const replyPath = guiSocketPath(base, process.pid);
const replyServer = net.createServer(socket => {
  socket.once('data', async () => {
    const bytes = Buffer.from(JSON.stringify({
      ok: true, instance: 'reply-fixture', snapshot: { text: '中文响应 😀' },
    }) + '\n');
    const offset = splitAtChinese(bytes);
    socket.write(bytes.subarray(0, offset));
    await delay(25);
    socket.end(bytes.subarray(offset));
  });
});
try {
  await new Promise((resolve, reject) => { replyServer.once('error', reject); replyServer.listen(replyPath, resolve); });
  await chmod(replyPath, 0o600);
  assert.equal((await requestGui({ base, pid: process.pid, instance: 'reply-fixture', op: 'snapshot' })).snapshot.text,
    '中文响应 😀', 'response decoder must retain split UTF-8 bytes');
} finally { await new Promise(resolve => replyServer.close(resolve)); }
console.log('GUI IPC: identity, literal text, split UTF-8 request/response/CLI, malformed inputs, large snapshots, read-only delivery, refusal states and bounded deduplication passed');
