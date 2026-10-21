/**
 * A projection of an already-running host's live, user-visible message stream.
 *
 * This module does not start/resume a thread, read a rollout/database, or ask a
 * model to produce progress. The host must supply its existing live app-server
 * notification source. A missing source is reported as unavailable, never
 * replaced with generated notes, tool arguments, or an invented task plan.
 *
 * Protocol reference: https://learn.chatgpt.com/docs/app-server
 */
const VISIBLE_PHASES = new Set(['commentary', 'partial_answer', 'final_answer']);
const DEFAULT_MAX_ENTRIES = 80;
const DEFAULT_MAX_TEXT = 24_000;

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Preserve prose verbatim while excluding fenced commands/code during streaming. */
export function visibleProse(text) {
  if (typeof text !== 'string') return '';
  let fence = null;
  const result = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.character
          && match[1].length >= fence.length && match[2].trim() === '') fence = null;
      continue;
    }
    if (match) {
      fence = { character: match[1][0], length: match[1].length };
      continue;
    }
    // Do not flash an unfinished fence opener while its next token is pending.
    if (index === lines.length - 1 && /^ {0,3}(`{1,2}|~{1,2})$/.test(line)) continue;
    result.push(line);
  }
  return result.join('\n');
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/**
 * Accept only identified live agent-message lifecycle events from one thread.
 * Item-start admission is intentional: completed items/history snapshots and
 * unclassified deltas must not become a back door into the visible feed.
 */
export function createVisibleFeed({
  threadId,
  onUpdate = () => {},
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxTextChars = DEFAULT_MAX_TEXT,
} = {}) {
  if (!validId(threadId)) throw new TypeError('A single threadId is required');
  if (typeof onUpdate !== 'function') throw new TypeError('onUpdate must be a function');
  const entryLimit = positiveInteger(maxEntries, DEFAULT_MAX_ENTRIES);
  const textLimit = positiveInteger(maxTextChars, DEFAULT_MAX_TEXT);
  const entries = new Map();
  let status = 'waiting';
  let closed = false;
  let resetRevision = 0;

  function snapshot() {
    return {
      status,
      resetRevision,
      entries: [...entries.values()].flatMap(entry => {
        const text = visibleProse(entry.text);
        return text.trim() ? [{
          id: entry.id,
          turnId: entry.turnId,
          text,
          complete: entry.complete,
        }] : [];
      }),
    };
  }

  function emit() {
    const value = snapshot();
    onUpdate(value);
    return value;
  }

  function boundedText(value) {
    if (typeof value !== 'string') return null;
    // A malformed or enormous payload should not be silently displayed in part.
    return value.length <= textLimit ? value : null;
  }

  function rejectOversize(entry) {
    entries.delete(entry.id);
    status = 'source-error';
    emit();
    return false;
  }

  function push(event) {
    if (closed || !event || typeof event !== 'object' || 'id' in event) return false;
    const { method, params } = event;
    if (!params || params.threadId !== threadId) return false;
    if (method === 'thread/reverted' || method === 'thread/deleted') {
      resetRevision++;
      entries.clear();
      emit();
      return true;
    }
    if (!validId(params.turnId)) return false;

    if (method === 'item/started') {
      const item = params.item;
      if (!item || item.type !== 'agentMessage' || !validId(item.id)
          || !VISIBLE_PHASES.has(item.phase) || entries.has(item.id)) return false;
      const text = boundedText(item.text ?? '');
      if (text === null) {
        status = 'source-error';
        emit();
        return false;
      }
      entries.set(item.id, {
        id: item.id, turnId: params.turnId, phase: item.phase, text, complete: false,
      });
      while (entries.size > entryLimit) entries.delete(entries.keys().next().value);
      status = 'streaming';
      emit();
      return true;
    }

    if (method === 'item/agentMessage/delta') {
      const entry = entries.get(params.itemId);
      if (!entry || entry.complete || entry.turnId !== params.turnId
          || typeof params.delta !== 'string') return false;
      const text = boundedText(entry.text + params.delta);
      if (text === null) return rejectOversize(entry);
      entry.text = text;
      status = 'streaming';
      emit();
      return true;
    }

    if (method === 'item/completed') {
      const item = params.item;
      const entry = item && entries.get(item.id);
      if (!entry || entry.turnId !== params.turnId
          || item.type !== 'agentMessage' || !VISIBLE_PHASES.has(item.phase)) return false;
      const text = boundedText(item.text);
      if (text === null) return rejectOversize(entry);
      if (entry.complete && entry.text === text) return false;
      entry.text = text;
      entry.complete = true;
      emit();
      return true;
    }

    // Deliberately ignore plan, reasoning (including summaries), tool commands,
    // tool results, warnings, raw response items, and lifecycle completion.
    // A model message ending does not prove that the user's task is complete.
    return false;
  }

  function disconnect(reason = 'disconnected') {
    if (closed) return;
    closed = true;
    status = reason === 'unavailable' ? 'unavailable' : 'disconnected';
    emit();
  }

  return { push, snapshot, disconnect };
}

/**
 * Bind to a host-owned live subscription. subscribe receives handlers and must
 * return a function that removes this observer, without stopping the task.
 * This adapter performs no process, filesystem, network, or UI operations.
 */
export function attachVisibleFeed({ subscribe, ...options } = {}) {
  const feed = createVisibleFeed(options);
  if (typeof subscribe !== 'function') {
    feed.disconnect('unavailable');
    return { ...feed, dispose() {} };
  }
  let unsubscribe;
  let disposed = false;
  try {
    unsubscribe = subscribe({
      onNotification: feed.push,
      onDisconnect: () => feed.disconnect(),
    });
    if (typeof unsubscribe !== 'function') throw new TypeError('Live source must return unsubscribe');
  } catch {
    feed.disconnect('unavailable');
  }
  return {
    ...feed,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { unsubscribe?.(); } finally { feed.disconnect(); }
    },
  };
}
