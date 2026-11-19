import { randomUUID } from 'node:crypto';
import { connectConversationHost } from './conversation-host.js';
import { startGuiIPC } from './gui-ipc.js';
import { discoverConversations } from './conversation-discovery.js';

const threadIdOK = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);

/**
 * CC-LIVE: an external Claude Code session, read-only. Its source (src/visible-feed-claude.js) belongs to the
 * connection; this host only subscribes. Assistant prose and the user's typed prompts, with their role; no reply.
 */
function connectClaudeHost({ threadId, source = null, reason = null, onChange }) {
  const unsubscribe = source ? source.subscribe(onChange) : () => {};
  const threadStatus = { busy: 'active', idle: 'idle', waiting: 'waiting' };
  return {
    snapshot() {
      if (!source) {
        return { threadId, status: 'unavailable', reason: reason || 'transcript_unavailable', canSend: false, readOnly: true,
          threadStatus: '', entries: [], pending: [] };
      }
      const state = source.snapshot();
      // Another session's entries never appear under this row's identity (the service rotates the binding first).
      if (state.sessionId !== threadId) {
        return { threadId, status: 'connecting', reason: 'session_changed', canSend: false, readOnly: true,
          threadStatus: '', entries: [], pending: [] };
      }
      return { threadId, status: state.status, reason: state.reason, canSend: false, readOnly: true,
        threadStatus: threadStatus[state.threadStatus] ?? '', pending: [],
        entries: state.entries.map(entry => ({ id: entry.id, role: entry.role, text: entry.text, at: entry.at })) };
    },
    async send() { const error = new Error('read_only'); error.code = 'read_only'; error.delivery = 'not_sent'; throw error; },
    close() { unsubscribe(); },
  };
}

/** CC-LIVE: the Claude row is the session its source follows now (the launch id until a registry change). */
const claudeSession = (fallback, descriptor) => descriptor?.source ? descriptor.source.snapshot().sessionId ?? null
  : descriptor ? fallback : null;

/** The only GUI state allowed across a worker replacement. Never copy a snapshot or receipt. */
export function normalizeConversationBinding(value) {
  if (!value || value.version !== 1 || value.provider !== 'Codex'
      || !threadIdOK(value.threadId) || typeof value.manual !== 'boolean') return null;
  return { version: 1, provider: 'Codex', threadId: value.threadId, manual: value.manual };
}

/** A worker can move between threads. Every binding is a distinct destination, even for the same PID. */
export async function startConversationService({
  base, onPresence, restoreBinding = null, connect = connectConversationHost, discover = discoverConversations, routines,
  retryDelaysMs = [250, 1000, 3000],
  reconnectClock = { setTimeout, clearTimeout },
}) {
  let host = null, threadId = null, bindingId = randomUUID(), provider = null, transport, published;
  let claude = { source: null, reason: null };   // CC-LIVE: the connection's Claude source, when the client is Claude
  let manualThreadId = null, discovered = new Set(), discoveredAt = 0;
  let restored = normalizeConversationBinding(restoreBinding), restoredAutomaticThreadId = null;
  let bindingRequest = 0;
  let closed = false, rebinding = false, retryTimer = null, retryCount = 0;
  let stableTimer = null, stableBinding = null;
  let retainedEntries = [], hostResetRevision = 0, resetRevision = 0;
  const retries = retryDelaysMs.slice(0, 3).filter(ms => Number.isFinite(ms) && ms >= 0 && ms <= 10_000);
  const visibleListeners = new Set();
  const fail = code => { const error = new Error(code); error.code = code; error.delivery = 'not_sent'; throw error; };
  const empty = () => ({
    threadId, status: 'unavailable', canSend: false, entries: [], pending: [],
    reason: provider === 'Claude' ? 'transcript_unavailable' : provider && provider !== 'Codex' ? 'browser_only' : 'unbound_thread',
  });
  const snapshot = () => {
    // CC-LIVE: after a registry change the source follows a new session id. Rotate the row's identity (thread id
    // and a new bindingId, published to presence) before any entry of that session can be read under the old one.
    if (provider === 'Claude' && claude.source && !rebinding && !closed) {
      const current = claudeSession(threadId, claude);
      if (current !== threadId) applyBinding(current, 'Claude', false, claude);
    }
    const state = host?.snapshot() ?? empty();
    const revision = Number.isSafeInteger(state.resetRevision) ? state.resetRevision : 0;
    if (host && revision !== hostResetRevision) {
      retainedEntries = [];
      hostResetRevision = revision;
      resetRevision++;
    }
    const keys = new Set((state.entries ?? []).map(entry => `${entry.turnId}:${entry.id}`));
    return { ...state, bindingId, resetRevision,
      entries: [...retainedEntries.filter(entry => !keys.has(`${entry.turnId}:${entry.id}`)),
        ...(state.entries ?? [])].slice(-80) };
  };
  const visibleFeedSnapshot = () => {
    const state = snapshot();
    return { provider, threadId, bindingId, status: state.status, reason: state.reason ?? null,
      entries: state.entries ?? [], resetRevision: state.resetRevision,
      verified: state.status === 'connected',
      origin: manualThreadId === threadId && threadId ? 'manual'
        : restoredAutomaticThreadId === threadId && threadId ? 'carry' : 'metadata' };
  };
  function scheduleReconnect() {
    const state = host?.snapshot();
    if (closed || rebinding) return;
    if (state?.status === 'connected') {
      if (stableBinding !== bindingId) {
        stableBinding = bindingId;
        reconnectClock.clearTimeout(stableTimer);
        const expected = bindingId;
        stableTimer = reconnectClock.setTimeout(() => {
          stableTimer = null;
          if (!closed && bindingId === expected && host?.snapshot().status === 'connected') retryCount = 0;
        }, 30_000);
        stableTimer.unref?.();
      }
      return;
    }
    reconnectClock.clearTimeout(stableTimer); stableTimer = null; stableBinding = null;
    // An ambiguous send still owns its nonce/receipt ledger. Keep that host so
    // the GUI can inspect the original outcome; never replace it behind a draft.
    if (state?.sending || state?.lastDelivery?.delivery === 'unknown') {
      reconnectClock.clearTimeout(retryTimer); retryTimer = null;
      return;
    }
    if (closed || rebinding || retryTimer || provider !== 'Codex' || !threadId
        || state?.status !== 'disconnected'
        || ![undefined, null, 'disconnected', 'connection_lost', 'response_timeout'].includes(state.reason)
        || retryCount >= retries.length) return;
    const expected = bindingId, target = threadId;
    retryTimer = reconnectClock.setTimeout(() => {
      retryTimer = null;
      const current = host?.snapshot();
      if (!closed && bindingId === expected && threadId === target
          && !current?.sending && current?.lastDelivery?.delivery !== 'unknown') applyBinding(target, 'Codex', true);
    }, retries[retryCount++]);
    retryTimer.unref?.();
  }
  const publish = () => {
    const state = snapshot();
    const fields = {
      guiInstance: transport?.instance ?? null, conversationThread: threadId,
      conversationBinding: bindingId, conversationStatus: state.status,
      conversationPending: state.pending?.length ?? 0,
      conversationRequestKey: JSON.stringify((state.pending ?? []).map(p => [typeof p.requestId, p.requestId])),
      conversationTitle: state.title ?? null,
      conversationProvider: provider,
    };
    const signature = JSON.stringify(fields);
    if (signature !== published) { published = signature; onPresence(fields); }
    for (const listener of visibleListeners) { try { listener(visibleFeedSnapshot()); } catch {} }
    scheduleReconnect();
  };
  transport = await startGuiIPC({
    base, snapshot, routines,
    discover: async () => {
      if (provider === 'Claude') fail('read_only_mirror');
      if (provider !== 'Codex') fail('browser_only');
      const before = bindingId;
      const rows = await discover();
      if (provider !== 'Codex' || before !== bindingId) fail('conversation_changed');
      discovered = new Set(rows.map(row => row.threadId)); discoveredAt = Date.now();
      return rows;
    },
    bind: async selected => {
      if (provider === 'Claude') fail('read_only_mirror');
      if (provider !== 'Codex' || !discovered.has(selected) || Date.now() - discoveredAt > 120_000) fail('conversation_not_listed');
      const request = ++bindingRequest;
      const before = bindingId;
      const rows = await discover();
      if (request !== bindingRequest || before !== bindingId || provider !== 'Codex') fail('conversation_changed');
      if (!rows.some(row => row.threadId === selected)) fail('conversation_expired');
      manualThreadId = selected;
      applyBinding(selected, provider);
    },
    send: async payload => {
      if (provider === 'Claude') fail('read_only');   // a read-only mirror: nothing is ever sent to a terminal
      if (!host || payload.bindingId !== bindingId || payload.threadId !== threadId) {
        const error = new Error('conversation_changed');
        error.code = 'conversation_changed'; error.delivery = 'not_sent'; throw error;
      }
      return host.send(payload);
    },
  });
  function applyBinding(next, nextProvider, reconnect = false, nextClaude = { source: null, reason: null }) {
    if (closed) return;
    if (!reconnect && next === threadId && nextProvider === provider
        && (nextProvider !== 'Claude' || (nextClaude.source === claude.source && nextClaude.reason === claude.reason))) {
      scheduleReconnect(); return;
    }
    reconnectClock.clearTimeout(retryTimer); retryTimer = null;
    reconnectClock.clearTimeout(stableTimer); stableTimer = null; stableBinding = null;
    if (!reconnect) retryCount = 0;
    discovered = new Set(); discoveredAt = 0;
    // Only this observer's already-public memory survives a same-thread retry.
    // A new host's revision zero is not a reset; a real reset drops the seed.
    const previous = reconnect ? snapshot().entries : [];
    rebinding = true;
    host?.close();
    host = null;
    retainedEntries = previous;
    hostResetRevision = 0;
    if (!reconnect) resetRevision = 0;
    threadId = next; provider = nextProvider; bindingId = randomUUID();
    claude = provider === 'Claude' ? nextClaude : { source: null, reason: null };
    if (threadId && provider === 'Codex') host = connect({ threadId, onChange: publish });
    else if (provider === 'Claude') host = connectClaudeHost({ threadId, ...claude, onChange: publish });
    rebinding = false;
    publish();
  }
  publish();
  return {
    bind(nextThreadId, nextProvider, nextClaude = null) {
      // Startup can precede initialize/clientInfo. Unknown is not a different client,
      // and carried identity alone is never permission to join its old Codex host.
      if (!nextProvider) return;
      const next = threadIdOK(nextThreadId) ? nextThreadId : null;
      if (restored) {
        if (nextProvider === restored.provider) {
          if (restored.manual) manualThreadId = restored.threadId;
          else restoredAutomaticThreadId = restored.threadId;
        }
        restored = null;
      }
      if (nextProvider !== 'Codex') {
        manualThreadId = null;
        restoredAutomaticThreadId = null;
        // CC-LIVE: a Claude client's row is the session its own source follows (index.js passes the launch id with
        // the connection's source descriptor), never a carried or inherited Codex thread.
        if (nextProvider === 'Claude') applyBinding(claudeSession(next, nextClaude), nextProvider, false,
          { source: nextClaude?.source ?? null, reason: nextClaude?.reason ?? null });
        else applyBinding(null, nextProvider);
        return;
      }
      if (next) restoredAutomaticThreadId = null;
      applyBinding(manualThreadId ?? next ?? restoredAutomaticThreadId, nextProvider);
    },
    exportBinding() {
      return normalizeConversationBinding(restored ?? {
        version: 1, provider, threadId, manual: manualThreadId === threadId,
      });
    },
    snapshot,
    visibleFeedSnapshot,
    subscribeVisibleFeed(listener) {
      if (typeof listener !== 'function' || closed) return () => {};
      visibleListeners.add(listener);
      listener(visibleFeedSnapshot());
      return () => visibleListeners.delete(listener);
    },
    close() {
      closed = true;
      reconnectClock.clearTimeout(retryTimer); retryTimer = null;
      reconnectClock.clearTimeout(stableTimer); stableTimer = null;
      host?.close(); visibleListeners.clear(); transport.close();
    },
  };
}
