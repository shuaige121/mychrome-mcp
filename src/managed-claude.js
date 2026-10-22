import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { visibleProse } from './visible-feed.js';

// Claude Code's official Agent SDK stream-json protocol (SDK 0.3.307 / CLI
// 2.1.307). Use the installed, signed-in CLI; never read credentials or history.
// https://platform.claude.com/docs/en/agent-sdk/typescript
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MAX_LINE = 8 * 1024 * 1024;
const MAX_TEXT = 24_000;
const clean = value => typeof value === 'string'
  ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') : '';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f]/.test(value);
function failure(code, delivery = 'not_sent') {
  return Object.assign(new Error(code), { code, delivery });
}
function executablePath(override) {
  if (override) return override;
  const candidates = [path.join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return candidates.find(candidate => existsSync(candidate)) || 'claude';
}
function projectModels(raw) {
  if (!Array.isArray(raw) || !raw.length) throw failure('claude_models_unavailable');
  const seen = new Set();
  const models = raw.flatMap(item => {
    if (!validId(item?.value) || seen.has(item.value)) return [];
    seen.add(item.value);
    const efforts = Array.isArray(item.supportedEffortLevels)
      ? [...new Set(item.supportedEffortLevels.filter(level => EFFORTS.has(level)))] : [];
    return [{ id: item.value, name: clean(item.displayName) || item.value, efforts,
      // null preserves the CLI's configured default; the catalog does not
      // advertise a default effort and the host must not invent one.
      defaultEffort: null, isDefault: item.value === 'default',
      resolvedModel: validId(item.resolvedModel) ? item.resolvedModel : null }];
  });
  if (!models.length) throw failure('claude_models_unavailable');
  return models;
}
function questionProjection(input) {
  if (!Array.isArray(input?.questions) || !input.questions.length || input.questions.length > 10) return null;
  const result = [], seen = new Set();
  for (const [index, item] of input.questions.entries()) {
    if (typeof item?.question !== 'string' || !item.question.trim() || item.question.length > 8000
        || typeof item.header !== 'string' || item.header.length > 256
        || !Array.isArray(item.options) || item.options.length > 30 || seen.has(item.question)) return null;
    seen.add(item.question);
    const options = [];
    for (const option of item.options) {
      if (typeof option?.label !== 'string' || option.label.length > 2000
          || typeof option.description !== 'string' || option.description.length > 4000) return null;
      options.push({ label: clean(option.label), description: clean(option.description) });
    }
    result.push({ id: `question-${index}`, header: clean(item.header), question: clean(item.question), options });
  }
  return result;
}
function approvalProjection(request) {
  let redacted = false;
  function scrub(value) {
    if (typeof value === 'string' && /(?:bearer\s+|(?:password|token|secret|api[_-]?key)\s*[=:]\s*\S)/i.test(value)) {
      redacted = true; return '[敏感内容已隐藏]';
    }
    return typeof value === 'string' ? clean(value) : value;
  }
  const details = JSON.stringify(request.input, (key, value) => {
    if (/password|passwd|credential|token|secret|authorization|api.?key|cookie|^auth$/i.test(key)) {
      redacted = true;
      return '[敏感内容已隐藏]';
    }
    return scrub(value);
  }, 2);
  // A shortened or redacted request cannot support informed approval.
  const description = clean(scrub(request.description || request.title || request.decision_reason)).slice(0, 1500);
  const canApprove = !redacted && details.length <= 6000 && request.requires_user_interaction !== true;
  return { canApprove, questions: [{ id: 'approval', header: 'Claude 请求授权',
    question: `Claude 请求执行 ${clean(request.tool_name)}。${description ? `\n${description}` : ''}\n${details.length <= 6000 ? details : '[内容过长，无法完整展示]'}${canApprove ? '\n是否仅允许这一次操作？' : '\n这里无法安全完整地展示此操作，请拒绝后让 Claude 换一种可审阅的方式。'}`,
    options: [{ label: '拒绝', description: '不执行此操作。' },
      ...(canApprove ? [{ label: '仅允许一次', description: '只批准这里展示的这一次操作，不保存权限规则。' }] : [])],
  }] };
}

/** No prompt or inference is sent until send(text). Model discovery shares the
 * initialize handshake, then closes its own CLI. All settings/MCP/permissions
 * remain those of the user's installed Claude Code. */
async function openClaude(options = {}) {
  const cwd = options.cwd || process.cwd();
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw failure('invalid_cwd');
  const model = options.model || null;
  const effort = options.effort || null;
  if (model && (!validId(model) || model.startsWith('-'))) throw failure('invalid_model');
  if (effort && !EFFORTS.has(effort)) throw failure('invalid_effort');
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10) throw failure('invalid_timeout');
  const threadId = randomUUID();
  const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool=stdio', '--session-id', threadId];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  const child = (options.spawnImpl || spawn)(executablePath(options.executable), args,
    { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let status = 'connecting', threadStatus = 'unknown', reason = null, closed = false;
  let activeTurnId = null, currentMessage = null, sequence = 0, buffer = '', models = [];
  let actualModel = null, actualEffort = null, closePromise, currentTurn = null, interrupting = null;
  const calls = new Map(), sends = new Map(), entries = new Map(), pending = new Map(), completedRequests = new Set();
  const textBlocks = new Set();
  function snapshot() {
    return { provider: 'Claude', threadId, status, reason, threadStatus,
      activeTurnId, sending: sends.size > 0, canSend: status === 'connected' && threadStatus === 'idle' && pending.size === 0 && sends.size === 0
        && !interrupting && (!currentTurn || currentTurn.completed),
      model: actualModel, effort: actualEffort, requestedModel: model, requestedEffort: effort,
      entries: [...entries.values()].flatMap(entry => {
        const text = visibleProse(entry.text);
        return text.trim() ? [{ ...entry, text }] : [];
      }),
      pending: [...pending.values()].map(item => ({ requestId: item.requestId, isBlocking: true,
        state: 'pending', questions: structuredClone(item.questions) })),
    };
  }
  function notify() { try { options.onChange?.(snapshot()); } catch { /* UI errors cannot change CLI permissions. */ } }
  function write(message) {
    if (closed || !child.stdin?.writable || child.exitCode != null) throw failure('claude_disconnected');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function retirePending() {
    for (const id of pending.keys()) completedRequests.add(id);
    pending.clear();
    while (completedRequests.size > 1000) completedRequests.delete(completedRequests.values().next().value);
  }
  function rejectCalls(code) {
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(failure(code, call.mutating ? 'unknown' : 'not_sent')); }
    calls.clear();
    for (const send of sends.values()) { clearTimeout(send.timer); send.reject(failure(code, 'unknown')); }
    sends.clear();
  }
  function stop(code = null) {
    if (closePromise) return closePromise;
    closed = true;
    status = code ? 'error' : 'disconnected'; reason = code; threadStatus = 'unknown';
    retirePending(); rejectCalls(code || 'claude_disconnected');
    closePromise = new Promise(resolve => {
      const fallback = setTimeout(resolve, 1200); fallback.unref?.();
      child.once('close', () => { clearTimeout(fallback); resolve(); });
      try { child.stdin?.end(); } catch { /* Already closed. */ }
      // SIGTERM is graceful and targets only the child this adapter owns.
      const timer = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); }, 100);
      timer.unref?.();
      if (child.exitCode != null || child.signalCode != null) { clearTimeout(fallback); clearTimeout(timer); resolve(); }
    });
    notify();
    return closePromise;
  }
  function request(requestBody, mutating = false) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { calls.delete(requestId); reject(failure('claude_response_timeout', mutating ? 'unknown' : 'not_sent')); void stop('claude_response_timeout'); }, timeoutMs);
      calls.set(requestId, { resolve, reject, timer, mutating });
      try { write({ type: 'control_request', request_id: requestId, request: requestBody }); }
      catch (error) { clearTimeout(timer); calls.delete(requestId); reject(error); }
    });
  }
  async function refreshApplied() {
    try {
      // `effective` contains configuration, not necessarily the values used by
      // the model. Only `applied` accounts for model resolution and effort caps.
      // Do not retain/log the remaining settings or any per-source settings.
      const settings = await request({ subtype: 'get_settings' });
      actualModel = validId(settings.applied?.model) ? settings.applied.model : null;
      actualEffort = EFFORTS.has(settings.applied?.effort) ? settings.applied.effort : null;
    } catch (error) {
      // Older CLIs may not implement this read. Unknown is safer than echoing
      // the selected level as if it had been applied. Transport errors still
      // close the adapter through the request/child handlers.
      actualEffort = null;
      if (error.code !== 'claude_control_rejected') throw error;
    }
  }
  function respond(requestId, response, error = null) {
    write({ type: 'control_response', response: error
      ? { subtype: 'error', request_id: requestId, error }
      : { subtype: 'success', request_id: requestId, response } });
    completedRequests.add(requestId);
    if (completedRequests.size > 1000) completedRequests.delete(completedRequests.values().next().value);
  }
  function setEntry(id, text, complete = false) {
    if (!validId(id) || typeof text !== 'string') return;
    if (text.length > MAX_TEXT) { void stop('claude_message_too_large'); return; }
    entries.set(id, { id, text, complete, turnId: activeTurnId });
    while (entries.size > 80) entries.delete(entries.keys().next().value);
  }
  function belongsToCurrentTurn(message) {
    const ids = [message.user_message_uuid, ...(Array.isArray(message.user_message_uuids) ? message.user_message_uuids : [])].filter(validId);
    return !ids.length || (currentTurn && ids.includes(currentTurn.id));
  }
  function turnReason(turn) {
    const result = turn?.result;
    if (!result) return reason;
    const aborted = ['aborted_streaming', 'aborted_tools', 'cancelled'].includes(result.terminal_reason);
    // An error result is not itself proof of cancellation. Retain real provider
    // failures, and require both this turn's user Stop and an abort outcome.
    if (aborted && !turn.providerFailed && turn.stop?.status === 'accepted') return 'interrupted';
    if (aborted && !turn.providerFailed && turn.stop?.status === 'requested') return null;
    return result.is_error || turn.providerFailed ? 'claude_turn_failed' : null;
  }
  function receive(message) {
    if (closed || !message || typeof message !== 'object') return;
    if (message.type === 'control_response') {
      const response = message.response, call = calls.get(response?.request_id);
      if (!call) return;
      calls.delete(response.request_id); clearTimeout(call.timer);
      if (response.subtype === 'success') call.resolve(response.response || {});
      else call.reject(failure('claude_control_rejected', call.mutating ? 'unknown' : 'not_sent'));
      return;
    }
    if (message.type === 'control_cancel_request') {
      pending.delete(message.request_id); completedRequests.add(message.request_id); notify(); return;
    }
    if (message.type === 'control_request') {
      const id = message.request_id, body = message.request;
      if (!validId(id) || !body || pending.has(id) || completedRequests.has(id)) return;
      // We advertise no dialog kinds. The official protocol says an unknown
      // request_user_dialog must remain unanswered, not falsely cancelled.
      if (body.subtype === 'request_user_dialog') return;
      if (body.subtype !== 'can_use_tool') { respond(id, null, 'Unsupported host request'); return; }
      if (!validId(body.tool_name) || !body.input || typeof body.input !== 'object' || Array.isArray(body.input)) {
        respond(id, { behavior: 'deny', message: 'Invalid permission request.' }); return;
      }
      if (options.discoveryOnly) { respond(id, { behavior: 'deny', message: 'Model discovery does not authorize actions.' }); return; }
      let projection;
      if (body.tool_name === 'AskUserQuestion') {
        const questions = questionProjection(body.input);
        if (!questions) { respond(id, { behavior: 'deny', message: 'Unsupported question format.' }); return; }
        projection = { questions, kind: 'question' };
      } else projection = { ...approvalProjection(body), kind: 'permission' };
      pending.set(id, { ...projection, requestId: id, input: body.input });
      notify(); return;
    }
    if (message.session_id && message.session_id !== threadId) { void stop('claude_session_mismatch'); return; }
    if (message.type === 'user') {
      // --replay-user-messages emits this CLI acknowledgement. A successful
      // stdin.write only queues bytes and must never clear the user's draft.
      const send = sends.get(message.uuid);
      if (send && message.isReplay === true && message.session_id === threadId
          && message.parent_tool_use_id == null && message.message?.role === 'user') {
        sends.delete(message.uuid); clearTimeout(send.timer);
        send.resolve({ status: 'accepted', delivery: 'accepted', threadId, turnId: message.uuid });
        notify();
      }
      return;
    }
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        if (validId(message.model)) actualModel = message.model;
      } else if (message.subtype === 'session_state_changed') {
        if (message.state === 'running' || message.state === 'requires_action') threadStatus = 'active';
        else if (message.state === 'idle' && (!currentTurn || currentTurn.completed)) {
          threadStatus = 'idle'; activeTurnId = null; retirePending();
        }
      } else if (message.subtype === 'task_notification' && !message.ambient && !message.skip_transcript) {
        setEntry(`task-${message.uuid || ++sequence}`, clean(message.summary), true);
      }
      notify(); return;
    }
    // Only assistant text is a user-visible message. Never project thinking,
    // tool inputs/results, hook output, raw errors, or command progress.
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      if (!belongsToCurrentTurn(message)) return;
      const event = message.event;
      if (event?.type === 'message_start') { currentMessage = event.message?.id || `message-${++sequence}`; textBlocks.clear(); }
      else if (currentMessage && event?.type === 'content_block_start' && event.content_block?.type === 'text') {
        textBlocks.add(event.index); setEntry(`${currentMessage}:${event.index}`, event.content_block.text || '');
      } else if (currentMessage && event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && textBlocks.has(event.index) && typeof event.delta.text === 'string') {
        const id = `${currentMessage}:${event.index}`;
        setEntry(id, (entries.get(id)?.text || '') + event.delta.text);
      } else if (currentMessage && event?.type === 'content_block_stop' && textBlocks.has(event.index)) {
        const id = `${currentMessage}:${event.index}`, entry = entries.get(id);
        if (entry) setEntry(id, entry.text, true);
      }
      notify(); return;
    }
    if (message.type === 'assistant' && !message.parent_tool_use_id && Array.isArray(message.message?.content)) {
      if (!belongsToCurrentTurn(message)) return;
      if (message.error) {
        if (currentTurn) currentTurn.providerFailed = true;
        reason = 'claude_turn_failed'; notify(); return;
      }
      for (const [index, block] of message.message.content.entries()) if (block.type === 'text') {
        setEntry(`${message.message.id || message.uuid || `message-${++sequence}`}:${index}`, block.text, true);
      }
      notify(); return;
    }
    if (message.type === 'result') {
      if (!belongsToCurrentTurn(message) || currentTurn?.completed) return;
      // A result is the per-turn completion signal. An unlabelled idle event
      // alone must not let a following send race this turn's delayed result.
      if (currentTurn) {
        currentTurn.completed = true;
        currentTurn.result = { is_error: message.is_error === true, terminal_reason: message.terminal_reason };
      }
      threadStatus = 'idle'; activeTurnId = null; retirePending();
      reason = currentTurn ? turnReason(currentTurn) : message.is_error ? 'claude_turn_failed' : null;
      notify();
      void refreshApplied().then(notify, () => {});
    }
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (closed) return;
    buffer += chunk;
    if (buffer.length > MAX_LINE) { void stop('claude_protocol_too_large'); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); } catch { void stop('claude_protocol_error'); return; }
    }
  });
  // Drain, but never retain or expose stderr: CLI diagnostics may contain
  // environment values, paths or provider credentials.
  child.stderr?.on('data', () => {});
  child.stdin.on('error', () => { void stop('claude_write_failed'); });
  child.on('error', error => { void stop(error?.code === 'ENOENT' ? 'claude_not_installed' : 'claude_start_failed'); });
  child.on('close', () => { if (!closed) void stop('claude_process_exited'); });
  try {
    const initialized = await request({ subtype: 'initialize' });
    models = projectModels(initialized.models);
    const selected = models.find(item => item.id === (model || 'default') || item.resolvedModel === model);
    if (model && !selected) throw failure('claude_model_unavailable');
    if (effort && (!selected || !selected.efforts.includes(effort))) throw failure('claude_effort_unavailable');
    if (!options.discoveryOnly) await refreshApplied();
    status = 'connected'; threadStatus = 'idle'; notify();
  } catch (error) { await stop(error.code || 'claude_initialization_failed'); throw error; }
  return {
    models, snapshot,
    async send(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 100_000 || text.includes('\0')) throw failure('invalid_message');
      if (!snapshot().canSend) throw failure(pending.size ? 'answer_pending_question' : 'claude_not_ready');
      const uuid = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          sends.delete(uuid); reason = 'claude_delivery_unconfirmed';
          reject(failure('claude_delivery_unconfirmed', 'unknown')); notify();
        }, timeoutMs);
        sends.set(uuid, { resolve, reject, timer });
        activeTurnId = uuid; threadStatus = 'active'; reason = null;
        currentTurn = { id: uuid, completed: false, result: null, stop: null, providerFailed: false };
        try {
          write({ type: 'user', session_id: threadId, uuid, parent_tool_use_id: null, message: { role: 'user', content: text } });
        } catch (error) {
          sends.delete(uuid); clearTimeout(timer); activeTurnId = null; currentTurn = null;
          if (!closed) threadStatus = 'idle';
          reject(error);
        }
        notify();
      });
    },
    async answer({ requestId, answers } = {}) {
      const item = pending.get(requestId);
      if (!item || status !== 'connected') throw failure('question_expired');
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw failure('invalid_answer');
      const projected = {};
      for (const question of item.questions) {
        const values = answers[question.id]?.answers;
        if (!Array.isArray(values) || !values.length || values.length > 30
            || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 8000)) throw failure('invalid_answer');
        projected[question.id] = values;
      }
      if (item.kind === 'question') {
        const selectedAnswers = Object.create(null);
        for (const [index, question] of item.input.questions.entries()) selectedAnswers[question.question] = projected[`question-${index}`].join(', ');
        respond(requestId, { behavior: 'allow', updatedInput: { ...item.input, answers: selectedAnswers } });
      } else {
        const selected = projected.approval;
        if (selected.length !== 1 || !['仅允许一次', '拒绝'].includes(selected[0])) throw failure('invalid_answer');
        if (selected[0] === '仅允许一次' && !item.canApprove) throw failure('approval_not_available');
        respond(requestId, selected[0] === '仅允许一次'
          ? { behavior: 'allow', updatedInput: item.input }
          : { behavior: 'deny', message: 'The user declined this action.' });
      }
      pending.delete(requestId); notify();
      return { delivery: 'sent', requestId };
    },
    async interrupt() {
      if (status !== 'connected') throw failure('claude_not_ready');
      if (interrupting) return interrupting;
      if (threadStatus === 'idle') return { status: 'idle', delivery: 'accepted' };
      const target = currentTurn && !currentTurn.completed ? currentTurn : null;
      if (target) target.stop = { status: 'requested' };
      interrupting = (async () => {
        try {
          const result = await request({ subtype: 'interrupt', cancel_queued: true }, true);
          if (target) target.stop.status = 'accepted';
          if (!closed && currentTurn === target) {
            if (target && !target.completed && Array.isArray(result.cancelled) && result.cancelled.includes(target.id)) {
              target.completed = true;
              target.result = { is_error: false, terminal_reason: 'cancelled' };
              activeTurnId = null; threadStatus = 'idle';
              const send = sends.get(target.id);
              if (send) { sends.delete(target.id); clearTimeout(send.timer); send.reject(failure('claude_send_cancelled', 'rejected')); }
            }
            retirePending();
            if (target?.result) reason = turnReason(target);
          }
          return { delivery: 'accepted', ...result };
        } catch (error) {
          if (target) target.stop.status = 'rejected';
          if (!closed && currentTurn === target && target?.result) reason = turnReason(target);
          throw error;
        } finally { interrupting = null; notify(); }
      })();
      notify();
      return interrupting;
    },
    close: () => stop(),
  };
}
export async function discoverClaudeModels(options = {}) {
  const session = await openClaude({ ...options, model: null, effort: null, onChange: undefined, discoveryOnly: true });
  try { return { provider: 'Claude', models: session.models }; }
  finally { await session.close(); }
}
export async function createClaudeSession(options = {}) {
  const { models: _models, ...session } = await openClaude(options);
  return session;
}
