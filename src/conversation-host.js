import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createVisibleFeed } from './visible-feed.js';
import {
  discoverVisibleFeedSocket, projectVisibleNotification, resolveVisibleFeedContext, visibleFeedField,
} from './visible-feed-host.js';

// This adapter joins one explicitly bound, loaded Codex thread. It never starts
// a daemon, creates a thread, reads history, changes permissions, or types into
// a terminal. Only send(), called after a user's GUI submission, transmits input.
// Protocol: local Codex 0.163.0 generated schema; https://learn.chatgpt.com/docs/app-server
const MAX_PAYLOAD = 16_777_216;
const MAX_TEXT = 24_000;
const MAX_NONCES = 256;
const LIVE_METHODS = new Set([
  'turn/started', 'turn/completed', 'thread/status/changed',
  'thread/closed', 'thread/deleted', 'thread/reverted',
  'item/started', 'item/completed', 'item/agentMessage/delta',
  'item/tool/requestUserInput', 'serverRequest/resolved',
]);
const idOK = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const requestIdOK = value => (typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f]/.test(value)) || Number.isSafeInteger(value);
const requestKey = value => `${typeof value}:${String(value)}`;
const field = visibleFeedField;

function failure(code, delivery = 'not_sent') {
  const error = new Error(code);
  error.code = code;
  error.delivery = delivery;
  return error;
}

function projectQuestions(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 10) return null;
  const ids = new Set(), result = [];
  for (const q of raw) {
    if (!q || !idOK(q.id) || ids.has(q.id) || typeof q.question !== 'string'
        || q.question.length > 8000 || typeof q.header !== 'string' || q.header.length > 256) return null;
    ids.add(q.id);
    let options = null;
    if (q.options != null) {
      if (!Array.isArray(q.options) || q.options.length > 30) return null;
      options = [];
      for (const o of q.options) {
        if (!o || typeof o.label !== 'string' || o.label.length > 2000
            || typeof o.description !== 'string' || o.description.length > 4000) return null;
        options.push({ label: o.label, description: o.description });
      }
    }
    result.push({
      id: q.id, header: q.header, question: q.question, options,
      isOther: q.isOther === true, isSecret: q.isSecret === true,
    });
  }
  return result;
}

/**
 * snapshot(): { threadId, title, status, reason, threadStatus, canSend, activeTurnId,
 *   entries, pending, sending, lastDelivery }
 * send({ text, nonce }) sends plain user input. send({ requestId, answers, nonce })
 * answers a request actually received on this connection. answers is a map of
 * question ID -> { answers: string[] }, as in the Codex protocol.
 *
 * Nonces are required, scoped to this adapter, and never silently evicted or
 * replayed. Reusing one with different content fails. A disconnected adapter
 * cannot reconnect itself or retry an uncertain delivery.
 */
export function connectConversationHost(options = {}) {
  const selected = resolveVisibleFeedContext(options);
  const threadId = selected?.threadId ?? null;
  const socketPath = selected && discoverVisibleFeedSocket(options);
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 20
    ? options.timeoutMs : 10_000;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  let status = socketPath ? 'connecting' : 'unavailable';
  let reason = socketPath ? null : 'host_unavailable';
  let threadStatus = 'unknown', directInput = false, activeTurnId = null, title = null;
  let stateRevision = 0;
  let closed = false, joining = false, joined = false, sending = false, socket, initTimer;
  let lastDelivery = null, sequence = 0;
  const generation = randomUUID();
  const calls = new Map(), nonces = new Map(), pending = new Map(), retired = new Set();
  const admitted = new Set(), answered = new Map();
  const feed = createVisibleFeed({
    threadId: threadId ?? 'unavailable', maxEntries: 80, maxTextChars: MAX_TEXT,
    onUpdate: () => notify(),
  });

  function unavailableReason() {
    if (status !== 'connected') return reason || 'host_unavailable';
    if (!directInput) return 'direct_input_unsupported';
    if (pending.size && [...pending.values()].some(x => x.isBlocking)) return 'answer_pending_question';
    if (threadStatus === 'active' && !activeTurnId) return 'active_turn_unknown';
    if (!['active', 'idle'].includes(threadStatus)) return 'thread_unavailable';
    if (sending) return 'sending';
    return null;
  }
  function snapshot() {
    const visible = feed.snapshot();
    return {
      threadId, title, status, reason: unavailableReason(), threadStatus,
      canSend: unavailableReason() === null, activeTurnId,
      entries: visible.entries, resetRevision: visible.resetRevision,
      pending: [...pending.values()].map(p => ({
        requestId: p.requestId, turnId: p.turnId, itemId: p.itemId,
        isBlocking: p.isBlocking, state: p.state,
        questions: structuredClone(p.questions),
      })),
      sending, lastDelivery: lastDelivery && { ...lastDelivery },
    };
  }
  function notify() { onChange(snapshot()); }
  function diagnostic(stage) { options.onDiagnostic?.({ stage }); }
  function setRuntime(nextStatus, nextTurnId) {
    if (threadStatus !== nextStatus || activeTurnId !== nextTurnId) stateRevision += 1;
    threadStatus = nextStatus;
    activeTurnId = nextTurnId;
  }
  function expire(key) {
    retired.add(key);
    const p = pending.get(key);
    if (!p) return;
    pending.delete(key);
    stateRevision += 1;
    const a = answered.get(key);
    if (a) {
      clearTimeout(a.timer);
      answered.delete(key);
      // The protocol also sends resolved when another client answered, or when
      // a turn clears the question. It cannot prove our particular answer won.
      a.resolve({ status: 'resolved', delivery: 'unconfirmed', requestId: p.requestId });
    }
  }
  function expireTurn(turnId) {
    for (const [key, p] of pending) if (p.turnId === turnId) expire(key);
  }
  function close(why = 'disconnected') {
    if (closed) return;
    closed = true;
    clearTimeout(initTimer);
    status = why === 'host_unavailable' ? 'unavailable' : 'disconnected';
    reason = why;
    for (const c of calls.values()) {
      clearTimeout(c.timer);
      c.reject(failure(why, c.mutation ? 'unknown' : 'not_sent'));
    }
    calls.clear();
    for (const a of answered.values()) {
      clearTimeout(a.timer);
      a.reject(failure(why, 'unknown'));
    }
    answered.clear();
    pending.clear();
    admitted.clear();
    socket?.close();
    feed.disconnect();
    notify();
  }
  function call(method, params, mutation = false) {
    if (closed || socket?.readyState !== WebSocket.OPEN) return Promise.reject(failure('disconnected'));
    const id = `mychrome-conversation-${generation}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!calls.has(id)) return;
        calls.delete(id);
        reject(failure('response_timeout', mutation ? 'unknown' : 'not_sent'));
        close('response_timeout');
      }, timeoutMs);
      calls.set(id, { method, resolve, reject, timer, mutation });
      socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        close('connection_lost');
      });
    });
  }
  function applyMetadata(raw, revision, { preserveLive = false } = {}) {
    if (field(raw, ['result', 'thread', 'id']) !== threadId) throw failure('thread_mismatch');
    const next = field(raw, ['result', 'thread', 'status', 'type']);
    if (!['idle', 'active'].includes(next)) throw failure('thread_not_loaded');
    const stale = revision !== stateRevision;
    // thread/read snapshots status before other asynchronous server work. A later response
    // must not erase a live question/turn that arrived while that snapshot was in flight.
    if (stale && !preserveLive) throw failure('thread_state_changed');
    directInput = field(raw, ['result', 'thread', 'canAcceptDirectInput']) === true;
    const name = field(raw, ['result', 'thread', 'name']);
    title = typeof name === 'string' && name.trim() ? name.slice(0, 512) : null;
    if (stale) return; // Joining is read-only: keep newer live events, including replayed questions.
    setRuntime(next, next === 'idle' ? null : activeTurnId);
    if (next === 'idle') {
      for (const key of pending.keys()) expire(key);
    }
  }
  async function refresh() {
    const revision = stateRevision;
    const raw = await call('thread/read', { threadId, includeTurns: false });
    applyMetadata(raw, revision);
    return raw;
  }
  function acceptResponse(raw, id) {
    const c = calls.get(id);
    if (!c) return;
    calls.delete(id);
    clearTimeout(c.timer);
    if (field(raw, ['error']) !== undefined) {
      const e = failure('host_rejected', c.mutation ? 'rejected' : 'not_sent');
      const code = field(raw, ['error', 'code']);
      if (Number.isSafeInteger(code)) e.rpcCode = code;
      c.reject(e);
    } else c.resolve(raw);
  }
  function observeTurn(turnId, replace = false) {
    if (!idOK(turnId)) return;
    if (replace && activeTurnId && activeTurnId !== turnId) expireTurn(activeTurnId);
    setRuntime('active', replace || !activeTurnId ? turnId : activeTurnId);
  }
  function receive(raw) {
    const method = field(raw, ['method']);
    if (typeof method !== 'string') {
      const id = field(raw, ['id']);
      if (id !== undefined) acceptResponse(raw, id);
      return;
    }
    if (!LIVE_METHODS.has(method) || (!joined && !joining)
        || field(raw, ['params', 'threadId']) !== threadId) return;
    const requestId = field(raw, ['id']);
    if (method === 'item/tool/requestUserInput') {
      if (!requestIdOK(requestId)) return;
      const key = requestKey(requestId);
      if (pending.has(key) || retired.has(key) || pending.size >= 20) return;
      const turnId = field(raw, ['params', 'turnId']);
      const itemId = field(raw, ['params', 'itemId']);
      const isBlocking = field(raw, ['params', 'isBlocking']);
      const questions = projectQuestions(field(raw, ['params', 'questions']));
      if (!idOK(turnId) || !idOK(itemId) || typeof isBlocking !== 'boolean' || !questions
          || (activeTurnId && activeTurnId !== turnId)) return;
      observeTurn(turnId);
      pending.set(key, { requestId, turnId, itemId, isBlocking, questions, state: 'pending' });
      stateRevision += 1;
      notify();
      return;
    }
    if (requestId !== undefined) return; // Never treat a server request as an event.
    if (method === 'serverRequest/resolved') {
      const id = field(raw, ['params', 'requestId']);
      if (requestIdOK(id)) expire(requestKey(id));
    } else if (method === 'thread/closed' || method === 'thread/deleted') {
      if (method === 'thread/deleted') {
        admitted.clear();
        feed.push({ method, params: { threadId } });
      }
      close('thread_closed');
      return;
    } else if (method === 'thread/reverted') {
      for (const key of pending.keys()) expire(key);
      setRuntime(threadStatus, null);
      stateRevision += 1;
      admitted.clear();
      feed.push({ method, params: { threadId } });
    } else if (method === 'thread/status/changed') {
      const next = field(raw, ['params', 'status', 'type']);
      if (!['active', 'idle'].includes(next)) { close('thread_unavailable'); return; }
      setRuntime(next, next === 'idle' ? null : activeTurnId);
      if (next === 'idle') {
        for (const key of pending.keys()) expire(key);
      }
    } else if (method === 'turn/started') {
      observeTurn(field(raw, ['params', 'turn', 'id']), true);
    } else if (method === 'turn/completed') {
      const turnId = field(raw, ['params', 'turn', 'id']);
      expireTurn(turnId);
      if (turnId === activeTurnId) setRuntime('idle', null);
    } else {
      if (method === 'item/started' || method === 'item/agentMessage/delta') {
        observeTurn(field(raw, ['params', 'turnId']));
      }
      const event = projectVisibleNotification(raw, threadId, admitted);
      if (event && feed.push(event) && event.method === 'item/started') {
        admitted.add(event.params.item.id);
        while (admitted.size > 80) admitted.delete(admitted.values().next().value);
      }
    }
    notify();
  }
  function answerPayload(p, answers) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw failure('invalid_answers');
    const keys = Object.keys(answers), expected = p.questions.map(q => q.id);
    if (keys.length !== expected.length || keys.some(k => !expected.includes(k))) throw failure('invalid_answers');
    const safe = Object.create(null);
    for (const id of expected) {
      const values = answers[id]?.answers;
      if (!Array.isArray(values) || !values.length || values.length > 30
          || values.some(v => typeof v !== 'string' || !v.trim() || v.length > MAX_TEXT)) {
        throw failure('invalid_answers');
      }
      safe[id] = { answers: [...values] };
    }
    return { answers: safe };
  }
  async function transmit(args) {
    if (closed || status !== 'connected') throw failure('host_unavailable');
    if (sending) throw failure('busy');
    sending = true;
    notify();
    try {
      const isAnswer = args.requestId !== undefined;
      const key = isAnswer ? requestKey(args.requestId) : null;
      const p = isAnswer ? pending.get(key) : null;
      if (isAnswer && (!p || p.state !== 'pending')) throw failure('request_expired');
      const result = isAnswer ? answerPayload(p, args.answers) : null;
      await refresh(); // Revalidate exact loaded thread/capability before any input.
      if (closed) throw failure('disconnected');
      if (isAnswer) {
        if (pending.get(key) !== p || p.state !== 'pending' || threadStatus !== 'active'
            || activeTurnId !== p.turnId) throw failure('request_expired');
        p.state = 'submitted';
        notify();
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            answered.delete(key);
            resolve({ status: 'submitted', delivery: 'unconfirmed', requestId: p.requestId });
          }, timeoutMs);
          answered.set(key, { resolve, reject, timer });
          socket.send(JSON.stringify({ id: p.requestId, result }), error => {
            if (error) close('connection_lost');
          });
        });
      }
      if (!directInput) throw failure('direct_input_unsupported');
      if ([...pending.values()].some(x => x.isBlocking)) throw failure('answer_pending_question');
      const active = threadStatus === 'active';
      if (active && !activeTurnId) throw failure('active_turn_unknown');
      if (!active && threadStatus !== 'idle') throw failure('thread_unavailable');
      const expectedTurnId = activeTurnId;
      const method = active ? 'turn/steer' : 'turn/start';
      const revision = stateRevision;
      const raw = await call(method, {
        threadId, input: [{ type: 'text', text: args.text }],
        clientUserMessageId: args.nonce,
        ...(active ? { expectedTurnId } : {}),
      }, true);
      const turnId = field(raw, active ? ['result', 'turnId'] : ['result', 'turn', 'id']);
      if (!idOK(turnId) || (active && turnId !== expectedTurnId)) {
        close('invalid_delivery_receipt');
        throw failure('invalid_delivery_receipt', 'unknown');
      }
      // Acceptance proves delivery, not that this is still the current turn. Live completion
      // or a newer turn/question can already have arrived before this RPC receipt.
      if (revision === stateRevision) observeTurn(turnId, true);
      return { status: 'accepted', delivery: 'accepted', turnId, method };
    } finally {
      sending = false;
      notify();
    }
  }
  function send(args = {}) {
    const { text, requestId, nonce } = args;
    let answers = args.answers;
    if (!idOK(nonce)) return Promise.reject(failure('invalid_nonce'));
    const isAnswer = requestId !== undefined;
    if (isAnswer ? (!requestIdOK(requestId) || text !== undefined)
      : (answers !== undefined || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT)) {
      return Promise.reject(failure('invalid_input'));
    }
    let fingerprint;
    try {
      // Freeze the submission's JSON value before deferring transmission.
      // A GUI caller changing its form object cannot change an admitted nonce.
      if (isAnswer) answers = JSON.parse(JSON.stringify(answers));
      fingerprint = createHash('sha256').update(JSON.stringify({ text, requestId, answers })).digest('hex');
    } catch { return Promise.reject(failure('invalid_input')); }
    const previous = nonces.get(nonce);
    if (previous) return previous.fingerprint === fingerprint
      ? previous.promise : Promise.reject(failure('nonce_conflict'));
    if (nonces.size >= MAX_NONCES) return Promise.reject(failure('nonce_capacity_reached'));
    // Defer execution until the nonce is recorded, including synchronous sends.
    const promise = Promise.resolve().then(() => transmit({ text, requestId, answers, nonce }))
      .then(result => {
        lastDelivery = { nonce, ...result };
        notify();
        return result;
      }, error => {
        lastDelivery = { nonce, status: 'failed', delivery: error.delivery || 'unknown', reason: error.code || 'send_failed' };
        notify();
        throw error;
      });
    nonces.set(nonce, { fingerprint, promise });
    return promise;
  }

  if (!socketPath) queueMicrotask(notify);
  else {
    socket = new WebSocket('ws://codex-app-server/rpc', {
      createConnection: () => net.createConnection(socketPath),
      maxPayload: MAX_PAYLOAD, handshakeTimeout: timeoutMs,
    });
    socket.on('open', async () => {
      if (closed) return;
      try {
        await call('initialize', {
          clientInfo: { name: 'mychrome-conversation', title: 'MyChrome Conversation', version: '0.9.1' },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [
            'rawResponseItem/completed', 'rawResponse/completed',
            'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta',
            'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/plan/delta',
          ] },
        });
        socket.send(JSON.stringify({ method: 'initialized' }));
        await refresh();
        joining = true;
        const revision = stateRevision;
        applyMetadata(await call('thread/resume', { threadId, excludeTurns: true }), revision, { preserveLive: true });
        joining = false;
        joined = true;
        status = 'connected';
        clearTimeout(initTimer);
        diagnostic('bound-thread-connected');
        notify();
      } catch { close('host_unavailable'); }
    });
    socket.on('message', (data, binary) => {
      if (closed || binary || data.length > MAX_PAYLOAD) return;
      try { receive(data.toString('utf8')); } catch { close('invalid_host_message'); }
    });
    socket.on('error', () => close('connection_lost'));
    socket.on('close', () => close('disconnected'));
    initTimer = setTimeout(() => close('host_unavailable'), timeoutMs * 3);
    initTimer.unref?.();
  }
  return { snapshot, send, close };
}
