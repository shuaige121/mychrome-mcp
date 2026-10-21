/** Local GUI transport. Message text stays in memory, never in presence files or command arguments. */
import net from 'node:net';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function canonical(value, depth = 0) {
  if (depth > 64) throw new Error('Invalid payload');
  if (Array.isArray(value)) return value.map(x => canonical(x, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], depth + 1)]));
  return value;
}
export const guiSocketPath = (base, pid) => path.join(base, `gui-${pid}.sock`);

export async function startGuiIPC({ base, pid = process.pid, snapshot, send, discover, bind, routines }) {
  mkdirSync(base, { recursive: true });
  const socketPath = guiSocketPath(base, pid);
  const instance = randomUUID();
  const operations = new Map();
  // Never unlink another running server's socket. A fresh worker has a fresh PID.
  const clients = new Set();
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(15_000, () => socket.destroy());
    let input = '', consumed = false;
    const reply = value => { if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n'); };
    socket.on('data', async data => {
      if (consumed) return;
      input += data.toString('utf8');
      if (Buffer.byteLength(input) > LIMIT) { consumed = true; reply({ ok: false, code: 'too_large' }); return; }
      if (!input.includes('\n')) return;
      consumed = true;
      let request;
      try { request = JSON.parse(input.trim()); } catch { reply({ ok: false, code: 'invalid_request' }); return; }
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        reply({ ok: false, code: 'invalid_request', delivery: 'not_sent' }); return;
      }
      if (request.instance !== instance) { reply({ ok: false, code: 'session_changed', delivery: 'not_sent' }); return; }
      try {
        if (request.op === 'snapshot') reply({ ok: true, instance, snapshot: snapshot() });
        else if (request.op === 'routine' && typeof routines === 'function' && request.payload &&
          typeof request.payload === 'object' && !Array.isArray(request.payload)) {
          reply({ ok: true, instance, result: await routines(request.payload) });
        }
        else if (request.op === 'discover' && discover) reply({ ok: true, instance, conversations: await discover() });
        else if (request.op === 'bind' && bind && safeId(request.payload?.threadId)) {
          await bind(request.payload.threadId);
          reply({ ok: true, instance, snapshot: snapshot() });
        }
        else if (request.op === 'delivery' && safeId(request.payload?.nonce)) {
          const record = operations.get(request.payload.nonce);
          reply(record?.response ?? { ok: true, instance, result: { status: record ? 'pending' : 'not_found', delivery: 'unknown' } });
        } else if (request.op === 'send' && safeId(request.payload?.nonce)) {
          let record = operations.get(request.payload.nonce);
          const content = JSON.stringify(canonical(request.payload));
          if (record && record.content !== content) {
            reply({ ok: false, code: 'nonce_conflict', delivery: 'not_sent' }); return;
          }
          if (!record) {
            if (operations.size >= 256) { reply({ ok: false, code: 'capacity_reached', delivery: 'not_sent' }); return; }
            record = { content };
            operations.set(request.payload.nonce, record);
            record.promise = Promise.resolve().then(() => send(request.payload)).then(
              result => ({ ok: true, instance, result }),
              error => ({ ok: false, code: /^[a-z_]{1,80}$/.test(error?.code) ? error.code : 'unavailable',
                delivery: ['not_sent', 'rejected'].includes(error?.delivery) ? error.delivery : 'unknown' }),
            ).then(response => { record.response = response; return response; });
          }
          reply(await record.promise);
        } else reply({ ok: false, code: 'invalid_request' });
      } catch (error) {
        reply({ ok: false, code: /^[a-z_]{1,80}$/.test(error?.code) ? error.code : 'unavailable',
          delivery: ['not_sent', 'rejected'].includes(error?.delivery) ? error.delivery : 'unknown' });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  chmodSync(socketPath, 0o600);
  server.on('error', () => {});
  server.unref();
  return {
    instance, socketPath,
    close() {
      for (const socket of clients) socket.destroy();
      server.close();
      try { unlinkSync(socketPath); } catch {}
    },
  };
}

export function requestGui({ base, pid, instance, op, payload, timeoutMs = 12_000 }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !safeId(instance)) throw new Error('Invalid GUI target');
  const socketPath = guiSocketPath(base, pid);
  const st = lstatSync(socketPath);
  if (!st.isSocket() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error('Unsafe GUI socket');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let output = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('GUI response timeout; delivery unknown')));
    socket.once('error', error => finish(error));
    socket.once('connect', () => socket.write(JSON.stringify({ instance, op, payload }) + '\n'));
    socket.on('data', data => {
      output += data.toString('utf8');
      if (Buffer.byteLength(output) > RESPONSE_LIMIT) finish(new Error('GUI response too large'));
      else if (output.includes('\n')) {
        try {
          const response = JSON.parse(output.trim());
          if (!response || (response.ok === true && response.instance !== instance)) throw new Error('Wrong GUI response');
          finish(null, response);
        } catch { finish(new Error('Invalid GUI response')); }
      }
    });
    socket.once('end', () => finish(new Error('GUI connection ended; delivery unknown')));
  });
}
