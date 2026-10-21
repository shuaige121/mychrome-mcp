import net from 'node:net';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { createVisibleFeed } from './visible-feed.js';

// Codex app-server: https://learn.chatgpt.com/docs/app-server
// Join only a verified, already-active thread on its existing local daemon.
// No thread/start, turn/start, history hydration, settings changes, or replay.
// Item-completed notifications can contain large screenshots/tool payloads.
// They are never projected, but the transport must survive those frames.
const MAX_MESSAGE_BYTES = 16_777_216;
const VISIBLE_PHASES = new Set(['commentary', 'partial_answer', 'final_answer']);
const ALLOWED_METHODS = new Set([
  'item/started', 'item/completed', 'item/agentMessage/delta',
  'thread/reverted', 'thread/deleted', 'thread/closed',
]);

function whitespace(text, at) {
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}
function stringEnd(text, at) {
  if (text[at] !== '"') throw new Error('Invalid JSON');
  for (let i = at + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }
  throw new Error('Incomplete JSON');
}
function valueEnd(text, at, depth = 0) {
  if (depth > 64) throw new Error('Excessive nesting');
  at = whitespace(text, at);
  if (text[at] === '"') return stringEnd(text, at);
  if (text[at] === '{' || text[at] === '[') {
    const end = text[at] === '{' ? '}' : ']';
    for (let i = at + 1; i < text.length;) {
      i = whitespace(text, i);
      if (text[i] === end) return i + 1;
      if (text[i] === ',' || text[i] === ':') { i += 1; continue; }
      i = valueEnd(text, i, depth + 1);
    }
    throw new Error('Incomplete JSON');
  }
  let end = at;
  while (end < text.length && !/[\s,\]}]/.test(text[end])) end += 1;
  if (end === at) throw new Error('Invalid JSON');
  return end;
}
function fieldStart(text, at, key) {
  at = whitespace(text, at);
  if (text[at] !== '{') return null;
  for (let i = at + 1; i < text.length;) {
    i = whitespace(text, i);
    if (text[i] === '}') return null;
    if (text[i] === ',') { i += 1; continue; }
    const end = stringEnd(text, i);
    const name = JSON.parse(text.slice(i, end));
    i = whitespace(text, end);
    if (text[i] !== ':') throw new Error('Invalid JSON');
    i = whitespace(text, i + 1);
    if (name === key) return i;
    i = valueEnd(text, i);
  }
  return null;
}

// Decode only an explicitly selected field. Routing/type checks happen before
// accessing text; raw reasoning, tool data, other threads, and history objects
// are skipped lexically rather than JSON.parse'd into application objects.
export function visibleFeedField(raw, keys) {
  let at = 0;
  for (const key of keys) {
    at = fieldStart(raw, at, key);
    if (at === null) return undefined;
  }
  return JSON.parse(raw.slice(at, valueEnd(raw, at)));
}

export function resolveVisibleFeedContext({ threadId, hostMetadata, env = process.env } = {}) {
  const selected = threadId ?? hostMetadata?.threadId ?? env.MYCHROME_VISIBLE_THREAD_ID
    ?? env.CODEX_THREAD_ID;
  if (typeof selected !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(selected)) return null;
  return { threadId: selected };
}

function ownedSocket(socketPath) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) return false;
  try {
    const stat = lstatSync(socketPath);
    return stat.isSocket() && stat.uid === process.getuid?.() && !(stat.mode & 0o077);
  } catch { return false; }
}

/** Discover only the caller's own Codex ancestor, never unrelated processes. */
export function discoverVisibleFeedSocket({ socketPath, hostMetadata, env = process.env } = {}) {
  const explicit = socketPath ?? hostMetadata?.appServerSocket ?? env.MYCHROME_VISIBLE_SOCKET;
  if (explicit !== undefined) return ownedSocket(explicit) ? explicit : null;
  let pid = process.ppid;
  const visited = new Set();
  for (let depth = 0; depth < 12 && pid > 1 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    try {
      const result = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const match = result.match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      if (path.basename(match[2]) === 'codex') {
        const sockets = execFileSync('/usr/sbin/lsof', ['-n', '-U', '-a', '-p', String(pid), '-F', 'n'],
          { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] })
          .split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
        const candidates = [...new Set(sockets)].filter(candidate =>
          /\/codex-daemon-\d+\//.test(candidate)
          || /\/app-server-control\/[^/]+\.sock$/.test(candidate));
        const selected = candidates.find(ownedSocket);
        if (selected) return selected;
      }
      pid = Number(match[1]);
    } catch { break; }
  }
  return null;
}

/** Select a current-thread public message without decoding excluded payloads. */
export function projectVisibleNotification(raw, threadId, admittedIds) {
  const method = visibleFeedField(raw, ['method']);
  if (!ALLOWED_METHODS.has(method)
      || visibleFeedField(raw, ['params', 'threadId']) !== threadId) return null;
  if (method.startsWith('thread/')) {
    return visibleFeedField(raw, ['id']) === undefined ? { method, params: { threadId } } : null;
  }
  const turnId = visibleFeedField(raw, ['params', 'turnId']);
  if (typeof turnId !== 'string') return null;
  if (method === 'item/agentMessage/delta') {
    const itemId = visibleFeedField(raw, ['params', 'itemId']);
    if (!admittedIds.has(itemId)) return null;
    if (visibleFeedField(raw, ['id']) !== undefined) return null;
    const delta = visibleFeedField(raw, ['params', 'delta']);
    return typeof delta === 'string' ? { method, params: { threadId, turnId, itemId, delta } } : null;
  }
  const itemType = visibleFeedField(raw, ['params', 'item', 'type']);
  if (itemType !== 'agentMessage') return null;
  const phase = visibleFeedField(raw, ['params', 'item', 'phase']);
  if (!VISIBLE_PHASES.has(phase)) return null;
  const id = visibleFeedField(raw, ['params', 'item', 'id']);
  if (typeof id !== 'string' || (method === 'item/completed' && !admittedIds.has(id))) return null;
  if (visibleFeedField(raw, ['id']) !== undefined) return null;
  const text = visibleFeedField(raw, ['params', 'item', 'text']) ?? '';
  if (typeof text !== 'string') return null;
  return { method, params: { threadId, turnId, item: { type: 'agentMessage', id, phase, text } } };
}

/**
 * Mirror the existing host stream. onChange contains public prose only.
 * Transport states are connecting / connected / unavailable / disconnected.
 */
export function connectVisibleFeed(options = {}) {
  const selected = resolveVisibleFeedContext(options);
  const socketPath = selected && discoverVisibleFeedSocket(options);
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  let status = selected && socketPath ? 'connecting' : 'unavailable';
  let reason = !selected ? 'unbound_thread' : !socketPath ? 'host_unavailable' : null;
  let closed = false, socket, timer, retryTimer, retryCount = 0, beforeUpdatedAt, joined = false, joining = false;
  let stableTimer = null;
  const reconnectClock = options.reconnectClock ?? { setTimeout, clearTimeout };
  const retries = (options.retryDelaysMs ?? [250, 1000, 3000]).slice(0, 3)
    .filter(ms => Number.isFinite(ms) && ms >= 0 && ms <= 10_000);
  const admittedIds = new Set();
  const entryLimit = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries : 80;
  const feed = createVisibleFeed({
    threadId: selected?.threadId ?? 'unavailable',
    maxEntries: options.maxEntries,
    maxTextChars: options.maxTextChars,
    onUpdate() { notify(); },
  });
  const requestPrefix = `mychrome-visible-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const requests = new Map();
  function snapshot() { return { ...feed.snapshot(), status, reason }; }
  function notify() { if (!closed) onChange(snapshot()); }
  function diagnostic(stage) { options.onDiagnostic?.({ stage }); }
  function close(why = 'disconnected') {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    reconnectClock.clearTimeout(retryTimer);
    reconnectClock.clearTimeout(stableTimer);
    status = why === 'unavailable' ? 'unavailable' : 'disconnected';
    reason = why === 'unavailable' ? (reason || why) : why;
    admittedIds.clear();
    // Closing removes this observer. Never interrupt the owner's task.
    socket?.close();
    feed.disconnect();
    onChange(snapshot());
  }
  function transportLost(why) {
    if (closed) return;
    const previous = socket;
    socket = null;
    clearTimeout(timer);
    reconnectClock.clearTimeout(stableTimer); stableTimer = null;
    requests.clear(); admittedIds.clear(); joined = false; joining = false;
    previous?.close();
    reason = why;
    if (retryCount >= retries.length) { status = 'disconnected'; notify(); return; }
    status = 'connecting'; reason = 'reconnecting'; notify();
    retryTimer = reconnectClock.setTimeout(() => { retryTimer = null; openSocket(); }, retries[retryCount++]);
    retryTimer.unref?.();
  }
  function unavailable(why) { reason = why; close('unavailable'); }
  function request(method, params) {
    const id = `${requestPrefix}:${method}`;
    requests.set(id, method);
    socket.send(JSON.stringify({ id, method, params }));
  }
  function threadMatches(raw) {
    return visibleFeedField(raw, ['result', 'thread', 'id']) === selected.threadId
      && visibleFeedField(raw, ['result', 'thread', 'status', 'type']) === 'active';
  }
  function response(raw, id) {
    const method = requests.get(id);
    if (!method) return;
    requests.delete(id);
    if (visibleFeedField(raw, ['error']) !== undefined) { unavailable('host_rejected'); return; }
    if (method === 'initialize') {
      diagnostic('initialized');
      socket.send(JSON.stringify({ method: 'initialized' }));
      request('thread/read', { threadId: selected.threadId, includeTurns: false });
    } else if (method === 'thread/read') {
      if (!threadMatches(raw)) { unavailable('thread_inactive'); return; }
      beforeUpdatedAt = visibleFeedField(raw, ['result', 'thread', 'updatedAt']);
      diagnostic('active-thread-verified');
      // The protocol defines this as rejoining a running thread. Only these two
      // fields are sent; no model, environment, permission, or setting overrides.
      joining = true;
      request('thread/resume', { threadId: selected.threadId, excludeTurns: true });
    } else if (method === 'thread/resume') {
      if (!threadMatches(raw)) { unavailable('thread_inactive'); return; }
      const updatedAt = visibleFeedField(raw, ['result', 'thread', 'updatedAt']);
      diagnostic(updatedAt === beforeUpdatedAt ? 'active-thread-rejoined' : 'active-thread-rejoined-after-update');
      joined = true;
      joining = false;
      status = 'connected';
      reason = null;
      clearTimeout(timer);
      const expected = socket;
      reconnectClock.clearTimeout(stableTimer);
      stableTimer = reconnectClock.setTimeout(() => {
        stableTimer = null;
        if (!closed && socket === expected && status === 'connected') retryCount = 0;
      }, 30_000);
      stableTimer.unref?.();
      notify();
    }
  }
  function notification(raw) {
    if (!joined && !joining) return;
    const event = projectVisibleNotification(raw, selected.threadId, admittedIds);
    if (!event) return;
    if (event.method === 'thread/closed') { close(); return; }
    if (event.method === 'thread/reverted' || event.method === 'thread/deleted') {
      admittedIds.clear();
      feed.push(event);
      if (event.method === 'thread/deleted') close();
      return;
    }
    if (feed.push(event) && event.method === 'item/started') {
      admittedIds.add(event.params.item.id);
      while (admittedIds.size > entryLimit) admittedIds.delete(admittedIds.values().next().value);
    }
  }
  function openSocket() {
    if (closed) return;
    if (!ownedSocket(socketPath)) { unavailable('host_unavailable'); return; }
    const current = new WebSocket('ws://codex-app-server/rpc', {
      createConnection: () => net.createConnection(socketPath),
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: 5000,
    });
    socket = current;
    current.on('open', () => {
      if (closed || socket !== current) return;
      request('initialize', {
        clientInfo: { name: 'mychrome-visible-feed', title: 'MyChrome Visible Feed', version: '0.9.1' },
        capabilities: { optOutNotificationMethods: [
          'rawResponseItem/completed', 'rawResponse/completed',
          'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta',
          'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/plan/delta',
        ] },
      });
    });
    current.on('message', (data, isBinary) => {
      if (closed || socket !== current || isBinary || data.length > MAX_MESSAGE_BYTES) return;
      const raw = data.toString('utf8');
      try {
        // Most traffic is unrelated tool/reasoning metadata. Reject by method
        // first instead of scanning every large tool value for a missing id.
        const method = visibleFeedField(raw, ['method']);
        if (typeof method === 'string') {
          if (ALLOWED_METHODS.has(method)) notification(raw);
        } else {
          const id = visibleFeedField(raw, ['id']);
          if (id !== undefined) response(raw, id);
        }
      } catch { unavailable('invalid_host_message'); }
    });
    current.on('error', () => { if (socket === current) transportLost('connection_lost'); });
    current.on('close', () => { if (socket === current) transportLost('disconnected'); });
    timer = setTimeout(() => { if (socket === current) transportLost('response_timeout'); }, 10_000);
    timer.unref?.();
  }
  if (!socketPath) queueMicrotask(notify);
  else openSocket();
  return { snapshot, close };
}
