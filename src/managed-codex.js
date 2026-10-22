import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Codex 0.163.0 generated app-server schema and https://learn.chatgpt.com/docs/app-server.
// Own one stdio child and one newly created thread. Never inspect credentials,
// client configuration, another process, or existing conversation history.
const MAX_LINE = 16_777_216;
const MAX_TEXT = 24_000;
const VISIBLE_PHASES = new Set(['commentary', 'partial_answer', 'final_answer']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOK = (value, max = 256) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const idOK = value => textOK(value) && !/[\r\n]/.test(value);
const requestIdOK = value => idOK(value) || Number.isSafeInteger(value);
const requestKey = value => `${typeof value}:${String(value)}`;
const bounded = (value, max = 4000) => typeof value === 'string' ? value.slice(0, max) : '';
const error = code => Object.assign(new Error(code), { code });
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;

function stdioClient(options, { onEvent = () => {}, onRequest = () => {}, onClosed = () => {} } = {}) {
  const executable = options.executable ?? 'codex';
  if (!textOK(executable, 4096) || /[\r\n]/.test(executable)) throw error('invalid_executable');
  const timeoutMs = positive(options.timeoutMs, 15_000);
  const graceMs = positive(options.closeGraceMs, 1000);
  let child;
  try {
    child = (options.spawnImpl ?? spawn)(executable, ['app-server', '--stdio'], {
      ...(options.cwd ? { cwd: options.cwd } : {}), shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch { throw error('codex_unavailable'); }
  if (!child?.stdin?.write || !child.stdout?.on || !child.on) throw error('codex_unavailable');
  let closed = false, exited = false, closing, sequence = 0, buffer = '';
  const calls = new Map(), decoder = new StringDecoder('utf8');
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const waitExit = ms => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    exit.then(() => { clearTimeout(timer); resolve(); });
  });
  function stop(reason) {
    if (closed) return;
    closed = true;
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error(reason)); }
    calls.clear();
    try { onClosed(reason); } catch { /* UI observers cannot keep a child alive. */ }
  }
  async function close(reason = 'session_closed') {
    if (closing) return closing;
    stop(reason);
    closing = (async () => {
      try { child.stdin.end(); } catch { /* The child may already have exited. */ }
      if (!exited) await waitExit(graceMs);
      if (!exited) {
        try { child.kill('SIGTERM'); } catch { /* Exit can race normal termination. */ }
        await waitExit(graceMs);
      }
      if (!exited) throw error('close_failed');
    })();
    return closing;
  }
  const fail = reason => { void close(reason).catch(() => {}); };
  function write(message) {
    if (closed) return Promise.reject(error('session_closed'));
    return new Promise((resolve, reject) => {
      try {
        child.stdin.write(JSON.stringify(message) + '\n', failure => {
          if (!failure) { resolve(); return; }
          reject(error('transport_error')); fail('transport_error');
        });
      } catch { reject(error('transport_error')); fail('transport_error'); }
    });
  }
  function request(method, params, customTimeout = timeoutMs) {
    if (closed) return Promise.reject(error('session_closed'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(id); reject(error('request_timeout')); fail('request_timeout');
      }, customTimeout);
      calls.set(id, { resolve, reject, timer });
      void write({ id, method, params }).catch(failure => {
        const call = calls.get(id);
        if (call) { calls.delete(id); clearTimeout(timer); reject(failure); }
      });
    });
  }
  function receive(message) {
    if (!record(message)) { fail('protocol_error'); return; }
    if (typeof message.method === 'string') {
      if (own(message, 'id')) {
        if (!requestIdOK(message.id)) { fail('protocol_error'); return; }
        Promise.resolve(onRequest(message)).catch(() => fail('protocol_error'));
      } else onEvent(message);
      return;
    }
    const call = calls.get(message.id);
    if (!call) return;
    calls.delete(message.id); clearTimeout(call.timer);
    if (record(message.error)) call.reject(error('request_failed'));
    else if (own(message, 'result')) call.resolve(message.result);
    else { call.reject(error('protocol_error')); fail('protocol_error'); }
  }
  child.stdout.on('data', bytes => {
    if (closed) return;
    buffer += decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    if (Buffer.byteLength(buffer) > MAX_LINE) { fail('protocol_error'); return; }
    let at;
    while (!closed && (at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); } catch { fail('protocol_error'); }
    }
  });
  child.stdout.on('error', () => fail('transport_error'));
  child.stdin.on?.('error', () => fail('transport_error'));
  // Drain stderr to avoid blocking the server; never retain or expose its contents.
  child.stderr?.resume?.();
  child.stderr?.on?.('error', () => {});
  child.on('error', () => { exited = true; resolveExit(); fail('codex_unavailable'); });
  child.on('exit', () => { exited = true; resolveExit(); stop('backend_exited'); });
  child.on('close', () => { exited = true; resolveExit(); stop('backend_exited'); });
  return {
    request, close,
    notify: (method, params = {}) => write({ method, params }),
    respond: (id, result) => write({ id, result }),
    reject: (id, code = -32601) => write({ id, error: { code, message: 'unsupported_request' } }),
  };
}

async function initialize(client) {
  await client.request('initialize', { clientInfo: { name: 'mychrome', title: 'MyChrome', version: '0.1.0' } });
  await client.notify('initialized');
}

async function modelCatalog(client) {
  const models = new Map(), cursors = new Set();
  let cursor;
  for (let page = 0; page < 30; page++) {
    const result = await client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!record(result) || !Array.isArray(result.data) || result.data.length > 1000) throw error('invalid_catalog');
    for (const row of result.data) {
      if (!record(row) || row.hidden === true) continue;
      const id = row.model ?? row.id;
      if (!idOK(id) || !Array.isArray(row.supportedReasoningEfforts)) throw error('invalid_catalog');
      const efforts = [...new Set(row.supportedReasoningEfforts.map(x => x?.reasoningEffort))];
      if (efforts.some(effort => !idOK(effort))) throw error('invalid_catalog');
      const defaultEffort = efforts.includes(row.defaultReasoningEffort) ? row.defaultReasoningEffort : null;
      models.set(id, { id, name: bounded(row.displayName, 256) || id, efforts, defaultEffort, isDefault: row.isDefault === true });
      if (models.size > 1000) throw error('invalid_catalog');
    }
    if (result.nextCursor == null) {
      if (!models.size) throw error('invalid_catalog');
      return [...models.values()];
    }
    if (!textOK(result.nextCursor, 4096) || cursors.has(result.nextCursor)) throw error('invalid_catalog');
    cursor = result.nextCursor; cursors.add(cursor);
  }
  throw error('invalid_catalog');
}

/** Read the current CLI catalog only. Listing does not verify paid inference access. */
export async function discoverCodexModels(options = {}) {
  let client;
  client = stdioClient(options, { onRequest: message => client.reject(message.id) });
  try {
    await initialize(client);
    return { provider: 'Codex', models: await modelCatalog(client) };
  } finally { await client.close(); }
}

function projectQuestions(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 10) return null;
  const ids = new Set(), questions = [];
  for (const q of raw) {
    if (!record(q) || !idOK(q.id) || ids.has(q.id) || !textOK(q.question, 8000)
        || typeof q.header !== 'string' || q.header.length > 256) return null;
    ids.add(q.id);
    let options = [];
    if (q.options != null) {
      if (!Array.isArray(q.options) || q.options.length > 30) return null;
      if (q.options.some(x => !record(x) || !textOK(x.label, 2000)
          || typeof x.description !== 'string' || x.description.length > 4000)) return null;
      options = q.options.map(({ label, description }) => ({ label, description }));
    }
    questions.push({ id: q.id, header: q.header, question: q.question, options,
      isOther: q.isOther === true, isSecret: q.isSecret === true });
  }
  return questions;
}

const APPROVAL_LABELS = { accept: '允许一次', decline: '拒绝', cancel: '取消本轮' };
function approvalQuestion(method, params, files) {
  let question, allow = false;
  if (method === 'item/commandExecution/requestApproval') {
    const command = bounded(params.command, 8000);
    const network = record(params.networkApprovalContext) ? bounded(params.networkApprovalContext.host, 256) : '';
    allow = (!!command && params.command.length <= 8000) || !!network;
    question = network ? `Codex 请求访问网络目标：${network}` : command ? `Codex 请求运行命令：\n${command}` : '此命令请求缺少可审查内容，请拒绝或取消本轮。';
  } else if (method === 'item/fileChange/requestApproval') {
    allow = Array.isArray(files) && files.length > 0 && !params.grantRoot;
    question = files?.length ? `Codex 请求修改这些文件：\n${files.join('\n')}` : '此文件修改请求缺少可审查的文件范围，请拒绝或取消本轮。';
    if (params.grantRoot) question += '\n此请求涉及后续写入权限，请在 Codex 客户端处理。';
  } else {
    question = 'Codex 请求额外权限。此界面仅支持拒绝或取消本轮；如需授予，请在 Codex 客户端处理。';
  }
  if (params.cwd) question += `\n工作目录：${bounded(params.cwd, 4096)}`;
  if (params.reason) question += `\n理由：${bounded(params.reason, 4000)}`;
  const decisions = ['decline', 'cancel'];
  if (allow) decisions.unshift('accept');
  return { decisions, questions: [{ id: 'approval', header: '需要授权', question,
    options: decisions.map(decision => ({ label: APPROVAL_LABELS[decision], description: decision === 'accept'
      ? '仅允许当前请求，不保存后续自动允许规则。' : decision === 'decline' ? '拒绝当前请求。' : '拒绝请求并停止当前一轮。' })) }] };
}

/** Creates an idle session; only send(text), invoked by the user, starts inference. */
export async function createCodexSession(options = {}) {
  const { cwd } = options;
  if (!textOK(cwd, 4096) || !path.isAbsolute(cwd) || /[\r\n]/.test(cwd)) throw error('invalid_cwd');
  try { if (!(await stat(cwd)).isDirectory()) throw error('invalid_cwd'); } catch { throw error('invalid_cwd'); }
  let client, threadId = null, model = null, effort = null, requestedModel = null, requestedEffort = null;
  let status = 'connecting', reason = null, threadStatus = 'unknown', activeTurnId = null;
  let sending = false, stopping = false, closed = false, closing, starting, interrupting;
  const entries = new Map(), pending = new Map(), retired = new Set(), completed = new Set(), fileItems = new Map();
  function snapshot() {
    return { provider: 'Codex', threadId, status, reason, threadStatus, activeTurnId, model, effort,
      requestedModel, requestedEffort, cwd, sending,
      canSend: status === 'connected' && !closed && !sending && !stopping && !pending.size
        && (threadStatus === 'idle' || (threadStatus === 'active' && !!activeTurnId)),
      entries: [...entries.values()].filter(x => x.text.trim()).map(({ id, text }) => ({ id, text })),
      pending: [...pending.values()].map(p => ({ requestId: p.requestId, turnId: p.turnId, itemId: p.itemId,
        kind: p.kind, isBlocking: true, questions: structuredClone(p.questions) })),
    };
  }
  function changed() { try { options.onChange?.(snapshot()); } catch { /* A view cannot break transport handling. */ } }
  function disconnected(code) {
    closed = true; status = 'disconnected'; reason = code; sending = false; stopping = false;
    threadStatus = 'unknown'; activeTurnId = null; pending.clear(); changed();
  }
  function retire(key) { pending.delete(key); retired.add(key); while (retired.size > 512) retired.delete(retired.values().next().value); }
  function finishTurn(turn) {
    if (!idOK(turn?.id)) return;
    completed.add(turn.id); while (completed.size > 128) completed.delete(completed.values().next().value);
    for (const [key, p] of pending) if (p.turnId === turn.id) retire(key);
    if (activeTurnId === turn.id) { activeTurnId = null; threadStatus = 'idle'; stopping = false; }
    if (turn.status === 'failed') reason = 'turn_failed';
    else if (turn.status === 'interrupted') reason = 'interrupted';
  }
  function observeTurn(turn) {
    if (!idOK(turn?.id)) return;
    if (completed.has(turn.id) || ['completed', 'failed', 'interrupted'].includes(turn.status)) { finishTurn(turn); return; }
    activeTurnId = turn.id; threadStatus = 'active';
  }
  function onEvent({ method, params: p }) {
    if (closed || !record(p) || !threadId || p.threadId !== threadId) return;
    if (method === 'turn/started') observeTurn(p.turn);
    else if (method === 'turn/completed') finishTurn(p.turn);
    else if (method === 'thread/status/changed') {
      const next = p.status?.type;
      if (next === 'idle') { threadStatus = 'idle'; activeTurnId = null; stopping = false; for (const key of pending.keys()) retire(key); }
      else if (next === 'active') threadStatus = 'active';
      else if (next === 'systemError') { reason = 'turn_failed'; threadStatus = 'unknown'; }
    } else if (method === 'serverRequest/resolved') {
      if (requestIdOK(p.requestId)) retire(requestKey(p.requestId));
    } else if (method === 'thread/closed' || method === 'thread/deleted') {
      void client.close('session_closed').catch(() => {}); return;
    } else if (method === 'error') {
      reason = 'turn_failed';
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item;
      if (!idOK(p.turnId) || !record(item) || !idOK(item.id)) return;
      if (method === 'item/started' && item.type === 'fileChange') {
        if (Array.isArray(item.changes) && item.changes.length > 0 && item.changes.length <= 30
            && item.changes.every(change => textOK(change?.path, 4096))) {
          fileItems.set(item.id, item.changes.map(change => change.path));
          while (fileItems.size > 80) fileItems.delete(fileItems.keys().next().value);
        }
        return;
      }
      // phase is nullable/optional in the stable schema; agentMessage is public.
      if (item.type !== 'agentMessage' || (item.phase != null && !VISIBLE_PHASES.has(item.phase))) return;
      const value = item.text ?? '';
      if (typeof value !== 'string' || value.length > MAX_TEXT) { reason = 'message_too_large'; return; }
      if (method === 'item/started' && !entries.has(item.id)) {
        entries.set(item.id, { id: item.id, turnId: p.turnId, text: value, complete: false });
        while (entries.size > 80) entries.delete(entries.keys().next().value);
      } else if (method === 'item/completed') {
        const entry = entries.get(item.id);
        if (!entry || entry.turnId !== p.turnId) return;
        entry.text = value; entry.complete = true;
      }
    } else if (method === 'item/agentMessage/delta') {
      const entry = entries.get(p.itemId);
      if (!entry || entry.complete || p.turnId !== entry.turnId || typeof p.delta !== 'string') return;
      if (entry.text.length + p.delta.length > MAX_TEXT) { entries.delete(entry.id); reason = 'message_too_large'; }
      else entry.text += p.delta;
    } else return;
    changed();
  }
  async function onRequest(message) {
    const p = message.params, key = requestKey(message.id);
    if (closed || !threadId || !record(p) || p.threadId !== threadId || !idOK(p.turnId)
        || (activeTurnId && p.turnId !== activeTurnId) || completed.has(p.turnId)
        || !idOK(p.itemId) || pending.size >= 20 || retired.has(key)) { await client.reject(message.id); return; }
    if (pending.has(key)) return;
    let projected, decisions = null, kind;
    if (message.method === 'item/tool/requestUserInput') {
      projected = projectQuestions(p.questions); kind = 'question';
    } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(message.method)) {
      const approval = approvalQuestion(message.method, p, fileItems.get(p.itemId));
      projected = approval.questions; decisions = approval.decisions; kind = message.method === 'item/permissions/requestApproval' ? 'permissions' : 'approval';
    }
    if (!projected) { await client.reject(message.id); return; }
    pending.set(key, { requestId: message.id, turnId: p.turnId, itemId: p.itemId, questions: projected, decisions, kind });
    changed();
  }
  client = stdioClient(options, { onEvent, onRequest, onClosed: disconnected });
  try {
    await initialize(client);
    const models = await modelCatalog(client);
    const selected = options.model == null ? models.find(x => x.isDefault) ?? models[0] : models.find(x => x.id === options.model);
    if (!selected) throw error('model_unavailable');
    requestedModel = selected.id; requestedEffort = options.effort ?? null;
    if (requestedEffort != null && !selected.efforts.includes(requestedEffort)) throw error('unsupported_effort');
    const started = await client.request('thread/start', { cwd, model: requestedModel,
      config: requestedEffort == null ? {} : { model_reasoning_effort: requestedEffort } });
    if (!idOK(started?.thread?.id) || !idOK(started.model)
        || (started.reasoningEffort != null && !idOK(started.reasoningEffort))) throw error('invalid_thread');
    // Effective settings are server readback, which may resolve aliases or apply policy.
    model = started.model; effort = started.reasoningEffort ?? null;
    threadId = started.thread.id; status = 'connected'; threadStatus = 'idle'; changed();
  } catch (failure) { await client.close().catch(() => {}); throw failure; }

  async function send(text) {
    if (closed) throw error('session_closed');
    if (!textOK(text, MAX_TEXT) || !text.trim()) throw error('invalid_message');
    if (pending.size) throw error('approval_pending');
    if (sending) throw error('send_in_progress');
    if (!snapshot().canSend) throw error('thread_unavailable');
    sending = true; reason = null; changed();
    const turnId = activeTurnId;
    try {
      const input = [{ type: 'text', text }];
      if (turnId) {
        const result = await client.request('turn/steer', { threadId, expectedTurnId: turnId, input });
        if (closed) throw error('session_closed');
        if (result?.turnId !== turnId) throw error('invalid_turn');
        return { status: 'accepted', delivery: 'accepted', turnId };
      }
      starting = client.request('turn/start', { threadId, input, cwd, model, ...(effort == null ? {} : { effort }) });
      const result = await starting;
      if (closed) throw error('session_closed');
      if (!idOK(result?.turn?.id)) throw error('invalid_turn');
      observeTurn(result.turn);
      return { status: 'accepted', delivery: 'accepted', turnId: result.turn.id };
    } catch (failure) { if (!closed) reason = failure.code ?? 'request_failed'; throw failure; }
    finally { starting = null; sending = false; changed(); }
  }
  async function answer({ requestId, answers } = {}) {
    if (closed) throw error('session_closed');
    if (!requestIdOK(requestId)) throw error('request_unavailable');
    const key = requestKey(requestId), p = pending.get(key);
    if (!p) throw error('request_unavailable');
    if (!record(answers)) throw error('invalid_answer');
    let result, cancel = false;
    if (p.kind !== 'question') {
      const values = answers.approval?.answers;
      if (Object.keys(answers).length !== 1 || !Array.isArray(values) || values.length !== 1) throw error('invalid_answer');
      const decision = Object.keys(APPROVAL_LABELS).find(key => key === values[0] || APPROVAL_LABELS[key] === values[0]);
      if (!p.decisions.includes(decision)) throw error('invalid_answer');
      result = p.kind === 'permissions' ? { permissions: {}, scope: 'turn' } : { decision };
      cancel = p.kind === 'permissions' && decision === 'cancel';
    } else {
      if (Object.keys(answers).length !== p.questions.length) throw error('invalid_answer');
      const projected = Object.create(null);
      for (const question of p.questions) {
        if (!own(answers, question.id)) throw error('invalid_answer');
        const value = answers[question.id];
        if (!record(value) || !Array.isArray(value.answers) || value.answers.length !== 1
            || !textOK(value.answers[0], 8000) || !value.answers[0].trim()) throw error('invalid_answer');
        if (question.options.length && !question.isOther && !question.options.some(option => option.label === value.answers[0])) throw error('invalid_answer');
        projected[question.id] = { answers: [...value.answers] };
      }
      result = { answers: projected };
    }
    retire(key); changed();
    await client.respond(requestId, result);
    if (cancel && activeTurnId === p.turnId) await interrupt();
    return { status: 'submitted', delivery: 'unconfirmed', requestId };
  }
  async function interrupt() {
    if (closed) throw error('session_closed');
    if (interrupting) return interrupting;
    if (!activeTurnId && !starting) return { status: 'idle' };
    stopping = true; changed();
    interrupting = (async () => {
      // A Stop click may race the response that supplies the owned turn ID.
      if (!activeTurnId && starting) await starting.catch(() => {});
      if (closed) throw error('session_closed');
      if (!activeTurnId) { stopping = false; changed(); return { status: 'idle' }; }
      const turnId = activeTurnId;
      await client.request('turn/interrupt', { threadId, turnId });
      return { status: 'interrupt_requested', turnId };
    })();
    try { return await interrupting; }
    catch (failure) { stopping = false; changed(); throw failure; }
    finally { interrupting = null; }
  }
  async function close() {
    if (closing) return closing;
    const turnId = activeTurnId;
    const wasClosed = closed;
    disconnected('session_closed');
    closing = (async () => {
      if (!wasClosed && turnId) {
        await client.request('turn/interrupt', { threadId, turnId }, 1000).catch(() => {});
      }
      await client.close();
    })();
    return closing;
  }
  return { snapshot, send, answer, interrupt, close };
}
