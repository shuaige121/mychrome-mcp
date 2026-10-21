import net from 'node:net';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { discoverVisibleFeedSocket, visibleFeedField as field } from './visible-feed-host.js';

const PAGE_SIZE = 25, MAX_PAGES = 4, MAX_THREADS = PAGE_SIZE * MAX_PAGES;
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const error = code => Object.assign(new Error(code), { code });

/**
 * Metadata-only discovery on the caller's existing ancestor daemon (or explicit owned socket).
 * No resume, history, new thread, settings changes, terminal input, or other-daemon search.
 * At most 100 initially loaded IDs are read; a final loaded-list intersection drops unloaded ones.
 * The GUI must still revalidate its selected thread when binding/sending.
 */
export async function discoverConversations(options = {}) {
  const socketPath = discoverVisibleFeedSocket(options);
  if (!socketPath) throw error('host_unavailable');
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 20
    ? Math.min(options.timeoutMs, 30_000) : 10_000;
  const calls = new Map(), removed = new Set(), initialIds = new Set();
  const generation = randomUUID();
  let sequence = 0, stopped = false, fatal = null, rejectOpen;
  const socket = new WebSocket('ws://codex-app-server/rpc', {
    createConnection: () => net.createConnection(socketPath),
    maxPayload: 16_777_216, handshakeTimeout: timeoutMs,
  });
  function stop(code) {
    if (stopped) return;
    stopped = true;
    fatal = error(code);
    rejectOpen?.(fatal);
    for (const pending of calls.values()) pending.reject(fatal);
    calls.clear();
  }
  const deadline = setTimeout(() => { stop('discovery_timeout'); socket.terminate(); }, timeoutMs);
  deadline.unref();
  socket.on('error', () => stop('host_unavailable'));
  socket.on('close', () => stop('disconnected'));
  socket.on('message', (bytes, binary) => {
    if (stopped || binary) return;
    try {
      const raw = bytes.toString('utf8');
      const method = field(raw, ['method']);
      if (method !== undefined) {
        if (method === 'thread/deleted' || method === 'thread/closed') {
          const id = field(raw, ['params', 'threadId']);
          if (initialIds.has(id)) removed.add(id);
        }
        return; // Never decode message content, tool requests, or unrelated events.
      }
      const id = field(raw, ['id']), pending = calls.get(id);
      if (!pending) return;
      calls.delete(id);
      if (field(raw, ['error', 'code']) !== undefined) pending.reject(error('host_rejected'));
      else pending.resolve(raw);
    } catch { stop('invalid_host_response'); socket.close(); }
  });
  function call(method, params) {
    if (stopped || socket.readyState !== WebSocket.OPEN) return Promise.reject(fatal || error('disconnected'));
    const id = `mychrome-discovery-${generation}-${++sequence}`;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }), e => { if (e) stop('host_unavailable'); });
    });
  }
  async function loadedIds() {
    const ids = new Set(), cursors = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES && ids.size < MAX_THREADS; page += 1) {
      const raw = await call('thread/loaded/list', { limit: PAGE_SIZE, ...(cursor !== undefined ? { cursor } : {}) });
      const data = field(raw, ['result', 'data']);
      if (!Array.isArray(data) || data.length > PAGE_SIZE || data.some(id => !idOK(id))) throw error('invalid_host_response');
      for (const id of data) ids.add(id);
      const next = field(raw, ['result', 'nextCursor']);
      if (next === null || next === undefined) break;
      if (typeof next !== 'string' || !next || next.length > 8192 || cursors.has(next)) throw error('invalid_host_response');
      cursors.add(next);
      cursor = next; // Opaque: pass it back exactly, never derive one.
    }
    return ids;
  }
  try {
    await new Promise((resolve, reject) => {
      rejectOpen = reject;
      socket.once('open', () => { rejectOpen = null; resolve(); });
    });
    await call('initialize', {
      clientInfo: { name: 'mychrome-conversation-discovery', title: 'MyChrome Conversation Picker', version: '0.9.1' },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: 'initialized' }));
    for (const id of await loadedIds()) initialIds.add(id);
    if (!initialIds.size) return [];
    const rows = [];
    // Four metadata reads at a time keep discovery bounded without monopolizing the daemon.
    const ids = [...initialIds];
    for (let offset = 0; offset < ids.length; offset += 4) {
      const batch = await Promise.all(ids.slice(offset, offset + 4).map(async threadId => {
        let raw;
        try { raw = await call('thread/read', { threadId, includeTurns: false }); }
        catch (e) { if (e.code === 'host_rejected') return null; throw e; } // Deleted between list and read.
        if (field(raw, ['result', 'thread', 'id']) !== threadId) throw error('thread_mismatch');
        const status = field(raw, ['result', 'thread', 'status', 'type']);
        if (!['active', 'idle', 'systemError'].includes(status) || removed.has(threadId)) return null;
        const name = field(raw, ['result', 'thread', 'name']);
        return {
          threadId, title: typeof name === 'string' && name.trim() ? name.slice(0, 512) : `未命名 · ${threadId.slice(-8)}`,
          status, canAcceptDirectInput: field(raw, ['result', 'thread', 'canAcceptDirectInput']) === true,
        };
      }));
      rows.push(...batch.filter(Boolean));
    }
    const stillLoaded = await loadedIds();
    return rows.filter(row => stillLoaded.has(row.threadId) && !removed.has(row.threadId));
  } finally {
    clearTimeout(deadline);
    stop('disconnected');
    if (socket.readyState !== WebSocket.CLOSED) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 250);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close();
      });
    }
  }
}
