/** Deterministic routine execution. The adapter is the existing guarded browser input path. */
import { createHash, randomUUID } from 'node:crypto';

const TOOLS = new Set(['click', 'hover', 'type_text', 'select_option', 'press_key', 'scroll']);
const KEYS = new Set(['escape', 'enter', 'tab', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'space', 'backspace']);
const TERMINAL = new Set(['completed', 'blocked', 'cancelled', 'failed']);
const STOP_CODES = new Set(['cancelled', 'user_cancelled', 'paused_by_user', 'task_interrupted', 'conversation_waiting']);
export class RoutineError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
const fail = code => { throw new RoutineError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function routinePage(snapshot) {
  if (!snapshot?.page || snapshot.replayable === false) fail(snapshot?.reason || 'page_unavailable');
  return { ...snapshot.page, fingerprint: digest(snapshot.view ?? []) };
}
export function pageMatches(actual, expected, { fingerprint = true } = {}) {
  return !!actual && !!expected && actual.origin === expected.origin && actual.path === expected.path
    && (actual.queryHash ?? null) === (expected.queryHash ?? null)
    && (!fingerprint || !expected.fingerprint || actual.fingerprint === expected.fingerprint);
}
const stateMatches = (actual, expected) => !expected || Object.entries(expected).every(([key, value]) => actual?.[key] === value);
const publicMessages = {
  wrong_page: '当前页面与录制起点不同，请先回到流程起点。',
  page_changed: '页面状态与录制时不同，已停下，后面的步骤没有执行。',
  target_missing: '找不到录制的目标，已停下，请让 AI 检查页面。',
  target_ambiguous: '页面上出现了多个相同目标，已停下，没有猜测点击。',
  target_changed: '操作前目标发生变化，已停下，没有继续输入。',
  postcondition_failed: '操作已发出，但未确认预期页面状态；已停下，不会自动重试。',
  site_blocked: '网站需要人工处理，流程已暂停。',
  page_dialog: '页面弹出了需要处理的对话框，流程已暂停。',
  paused_by_user: '你已暂停 MyChrome，流程已停止。',
  user_cancelled: '你已收回控制，流程已停止。',
  cancelled: '流程已停止。',
  task_interrupted: '当前任务已中断，请检查原任务后再继续。',
  missing_parameter: '请填写流程需要的输入参数。',
  routine_busy: '已有流程正在运行，请先等待或停止它。',
  recording_unavailable: '流程记录暂时不可用，本次执行结果未写入记录。',
};
export const routineMessage = code => publicMessages[code] || '流程未能继续，请让 AI 检查当前页面；不会自动重试。';

function validateRoutine(routine, params) {
  if (!object(routine) || routine.archived || !Array.isArray(routine.steps) || routine.steps.length < 1 || routine.steps.length > 50) fail('invalid_routine');
  if (!object(params) || Object.keys(params).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) fail('invalid_parameters');
  const parameters = routine.parameters ?? [];
  if (!Array.isArray(parameters)) fail('invalid_routine');
  const names = new Set(parameters.map(parameter => parameter.name));
  if (Object.keys(params).some(key => !names.has(key))) fail('invalid_parameters');
  for (const name of names) if (typeof params[name] !== 'string' || !params[name].trim() || params[name].length > 20000) fail('missing_parameter');
  for (const step of routine.steps) {
    if (!TOOLS.has(step.tool) || !object(step.before) || !object(step.after)
        || step.before.origin !== routine.site || step.after.origin !== routine.site
        || typeof step.before.path !== 'string' || typeof step.after.path !== 'string') fail('invalid_routine');
    if (step.tool !== 'scroll' && (!object(step.target) || step.target.version !== 1)) fail('invalid_routine');
    if (step.tool === 'click' && pageMatches(step.before, step.after)
        && !Object.entries(step.targetState ?? {}).some(([key, value]) =>
          typeof value === 'boolean' && typeof step.afterState?.[key] === 'boolean' && step.afterState[key] !== value)) fail('unconfirmed_click');
    const args = step.args ?? {};
    if (step.tool === 'type_text' && !names.has(args.textParam)) fail('invalid_routine');
    if (step.tool === 'select_option' && !names.has(args.valueParam)) fail('invalid_routine');
    if (step.tool === 'press_key' && (!KEYS.has(args.key) || (args.times != null && (!Number.isInteger(args.times) || args.times < 1 || args.times > 20)))) fail('invalid_routine');
    if (step.tool === 'scroll' && (!['up', 'down'].includes(args.direction) || !Number.isFinite(args.amount ?? 1) || (args.amount ?? 1) < 0.1 || (args.amount ?? 1) > 20)) fail('invalid_routine');
  }
}

/** No arbitrary recorded tool arguments reach the input adapter. */
function actionArgs(step, marker, params, tab) {
  const saved = step.args ?? {};
  if (step.tool === 'click') return { tab, marker, scroll_into_view: saved.scroll_into_view !== false };
  if (step.tool === 'hover') return { tab, marker };
  if (step.tool === 'type_text') return { tab, marker, text: params[saved.textParam], submit: saved.submit === true,
    ...(saved.input_mode === 'keys' || saved.input_mode === 'paste' ? { input_mode: saved.input_mode } : {}) };
  if (step.tool === 'select_option') return { tab, marker, option: params[saved.valueParam] };
  if (step.tool === 'press_key') return { tab, key: saved.key, times: saved.times ?? 1 };
  return { tab, direction: saved.direction, amount: saved.amount ?? 1 };
}

/** Start and caller-abort must identify the same snapshotted request body. */
function requestIdentity(request) {
  const { id, tab, params = {}, nonce } = request ?? {};
  if (typeof id !== 'string' || !Number.isSafeInteger(tab) || tab <= 0 || typeof nonce !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(nonce)) fail('invalid_request');
  if (!object(params)) fail('invalid_parameters');
  const inputs = { ...params };
  return { id, tab, nonce, inputs,
    signature: digest([id, tab, Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))]) };
}

export function createRoutineRunner({ store, adapter, onChange = () => {}, maxRuns = 128, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const runs = new Map(), nonces = new Map();
  let active = null;
  const hasPending = () => [...nonces.values()].some(entry => !entry.runId && !entry.error);
  const view = run => ({ runId: run.id, routineId: run.routineId, nonce: run.nonce, status: run.status,
    completed: run.completed, total: run.total, step: run.step, tab: run.tab, message: run.message,
    ...(run.code ? { code: run.code } : {}), ...(run.recordingWarning ? { recordingWarning: true } : {}) });
  const publish = run => { try { onChange(view(run)); } catch {} };
  const check = run => { if (run.controller.signal.aborted) fail('cancelled'); };
  async function execute(run, routine, params) {
    let began = false, state;
    try {
      check(run);
      state = await adapter.inspect(run.tab, { signal: run.controller.signal, refresh: true });
      if (!pageMatches(state.page, routine.steps[0].before)) fail('wrong_page');
      check(run);
      began = true;
      await adapter.begin?.(run, routine);
      for (let index = 0; index < routine.steps.length; index++) {
        check(run);
        const step = routine.steps[index];
        run.step = index + 1;
        run.message = `正在执行第 ${run.step} / ${run.total} 步`;
        publish(run);
        state = await adapter.inspect(run.tab, { signal: run.controller.signal, refresh: true });
        if (!pageMatches(state.page, step.before)) fail('page_changed');
        let target = null;
        if (step.target) {
          target = await adapter.resolve(run.tab, step.target, { signal: run.controller.signal, focused: step.tool === 'press_key' });
          if (!target?.ok || !Number.isSafeInteger(target.marker) || target.marker < 1) fail(target?.reason || 'target_missing');
          if (!stateMatches(target.targetState, step.targetState)) fail('target_changed');
        }
        check(run);
        const outcome = await adapter.act(step.tool, actionArgs(step, target?.marker, params, run.tab), {
          signal: run.controller.signal, run, descriptor: step.target ?? null, before: step.before,
        });
        if (!outcome?.ok) fail(outcome?.code || 'action_failed');
        // Only poll read-only state after an action. Never send it a second time.
        const fingerprint = !['type_text', 'select_option'].includes(step.tool);
        let matched = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          check(run);
          state = await adapter.inspect(run.tab, { signal: run.controller.signal, refresh: false });
          if (pageMatches(state.page, step.after, { fingerprint })) { matched = true; break; }
          if (state.page?.origin !== routine.site) break;
          if (attempt < 7) await wait(150 + attempt * 100);
        }
        if (!matched) fail('postcondition_failed');
        if (step.afterState && step.target && pageMatches(step.before, step.after, { fingerprint: false })) {
          // Value contents are confirmed by the existing type/select implementation, never persisted here.
          const afterTarget = await adapter.resolve(run.tab, step.target, { signal: run.controller.signal, refresh: true });
          if (!afterTarget?.ok || !stateMatches(afterTarget.targetState, step.afterState)) fail('postcondition_failed');
        }
        run.completed++;
        run.message = `已确认第 ${run.completed} / ${run.total} 步`;
        publish(run);
      }
      check(run);
      run.status = 'completed';
      run.message = `流程已执行并核对，共 ${run.completed} 步。`;
    } catch (error) {
      run.code = /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'action_failed';
      run.status = STOP_CODES.has(run.code) || run.controller.signal.aborted ? 'cancelled' : 'blocked';
      run.message = routineMessage(run.controller.signal.aborted ? 'cancelled' : run.code);
    } finally {
      // Do not expose a terminal status until input ownership has actually been released/restored.
      const terminal = run.status;
      run.status = 'running';
      try { if (began) await adapter.finish?.(run, { status: terminal }); }
      catch { run.code = 'cleanup_unconfirmed'; run.message = '操作已结束，但归还控制的状态未确认，请检查浏览器。'; }
      run.status = run.code === 'cleanup_unconfirmed' ? 'failed' : run.controller.signal.aborted ? 'cancelled' : terminal;
      if (run.status === 'cancelled' && terminal === 'completed') { run.code = 'cancelled'; run.message = routineMessage('cancelled'); }
      try { await store.recordRun({ id: routine.id, status: run.status, completed: run.completed, total: run.total, code: run.code }); }
      catch { run.recordingWarning = true; }
      if (active === run) active = null;
      publish(run);
      // Secrets/parameters remain only in this invocation and are not retained in run metadata.
    }
    return view(run);
  }
  async function start(request) {
    const { id, tab, nonce, inputs, signature } = requestIdentity(request);
    const prior = nonces.get(nonce);
    if (prior) {
      if (prior.signature !== signature) fail('nonce_conflict');
      if (prior.error) fail(prior.error);
      return prior.promise;
    }
    if (nonces.size >= maxRuns) fail('capacity_reached');
    const entry = { signature };
    entry.promise = (async () => {
      const routine = await store.get(id);
      validateRoutine(routine, inputs);
      if (entry.cancelled) fail('cancelled');
      if (active) fail('routine_busy');
      const run = { id: randomUUID(), nonce, routineId: id, tab, status: 'running', completed: 0, total: routine.steps.length,
        step: 0, message: '正在核对流程起点', controller: new AbortController() };
      active = run;
      runs.set(run.id, run);
      entry.runId = run.id;
      publish(run);
      run.promise = execute(run, routine, inputs);
      return view(run);
    })().catch(error => { entry.error = /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'unavailable'; throw error; });
    nonces.set(nonce, entry);
    return entry.promise;
  }
  function find({ runId, nonce } = {}) {
    const id = runId ?? nonces.get(nonce)?.runId;
    const run = runs.get(id);
    if (!run) fail('run_not_found');
    return run;
  }
  // Only an idle worker can hand over. Project terminal receipts rather than
  // serializing runs: adapters, promises, parameters and task text never cross.
  function exportCarry() {
    if (active || hasPending()) fail('routine_busy');
    return { version: 1, entries: [...nonces].map(([nonce, entry]) => {
      if (!entry.runId) return { nonce, signature: entry.signature, error: entry.error };
      const run = runs.get(entry.runId);
      if (!run || !TERMINAL.has(run.status)) fail('routine_busy');
      return { nonce, signature: entry.signature, receipt: view(run) };
    }) };
  }
  function importCarry(carry) {
    if (carry === undefined) return 0; // Workers predating routine receipts.
    if (active || nonces.size || runs.size) fail('routine_busy');
    const invalid = () => fail('invalid_routine_carry');
    const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
    const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
    const code = value => typeof value === 'string' && /^[a-z_]{1,80}$/.test(value);
    const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
    if (!keys(carry, ['version', 'entries']) || carry.version !== 1 || !Array.isArray(carry.entries)
        || carry.entries.length > maxRuns) invalid();
    const seenNonces = new Set(), seenRuns = new Set(), validated = [];
    for (const entry of carry.entries) {
      if (!keys(entry, ['nonce', 'signature', 'receipt', 'error']) || !token(entry.nonce)
          || typeof entry.signature !== 'string' || !/^[a-f0-9]{64}$/.test(entry.signature)
          || seenNonces.has(entry.nonce) || ('receipt' in entry) === ('error' in entry)) invalid();
      seenNonces.add(entry.nonce);
      if ('error' in entry) {
        if (!code(entry.error)) invalid();
        validated.push({ nonce: entry.nonce, signature: entry.signature, error: entry.error });
        continue;
      }
      const r = entry.receipt;
      if (!keys(r, ['runId', 'routineId', 'nonce', 'status', 'completed', 'total', 'step', 'tab', 'code', 'recordingWarning', 'message'])
          || typeof r.runId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(r.runId)
          || seenRuns.has(r.runId) || !token(r.routineId) || r.nonce !== entry.nonce || !TERMINAL.has(r.status)
          || !integer(r.total, 1, 50) || !integer(r.completed, 0, r.total) || !integer(r.step, r.completed, r.total)
          || !integer(r.tab, 1, Number.MAX_SAFE_INTEGER) || (r.code !== undefined && !code(r.code))
          || (r.status === 'completed' ? r.completed !== r.total || r.code !== undefined : !code(r.code))
          || (r.recordingWarning !== undefined && typeof r.recordingWarning !== 'boolean')) invalid();
      // Only product-generated terminal notices may cross, never arbitrary text.
      // Cancellation can override a native error while retaining its diagnostic code.
      const messages = r.status === 'completed' ? [`流程已执行并核对，共 ${r.completed} 步。`]
        : r.code === 'cleanup_unconfirmed' ? ['操作已结束，但归还控制的状态未确认，请检查浏览器。']
        : [routineMessage(r.code), ...(r.status === 'cancelled' ? [routineMessage('cancelled')] : [])];
      if (!messages.includes(r.message)) invalid();
      seenRuns.add(r.runId);
      validated.push({ nonce: entry.nonce, signature: entry.signature, receipt: { ...r } });
    }
    // Validate the entire carry before changing either map. A rejected carry
    // must abort the worker handover, never quietly discard a used nonce.
    for (const entry of validated) {
      if (entry.error) {
        nonces.set(entry.nonce, { signature: entry.signature, error: entry.error });
        continue;
      }
      const r = entry.receipt;
      const run = { ...r, id: r.runId };
      run.promise = Promise.resolve(view(run));
      runs.set(run.id, run);
      nonces.set(entry.nonce, { signature: entry.signature, runId: run.id, promise: Promise.resolve(view(run)) });
    }
    return validated.length;
  }
  return {
    start,
    exportCarry, importCarry, hasPending,
    async run(request) { const started = await start(request); return runs.get(started.runId).promise; },
    status(request) {
      const entry = nonces.get(request?.nonce);
      if (!request?.runId && entry && !entry.runId) return { runId: null, nonce: request.nonce,
        status: entry.error ? (entry.error === 'cancelled' ? 'cancelled' : 'failed') : 'running', completed: 0, total: 0, step: 0,
        message: entry.error ? routineMessage(entry.error) : entry.cancelled ? '正在取消启动' : '正在检查流程',
        ...(entry.error ? { code: entry.error, delivery: 'not_sent' } : {}) };
      return view(find(request));
    },
    cancel(request) {
      const entry = nonces.get(request?.nonce);
      if (!request?.runId && entry && !entry.runId) { entry.cancelled = true; return this.status(request); }
      const run = find(request);
      if (!TERMINAL.has(run.status)) { run.controller.abort(); run.message = '正在停止，等待当前操作归还控制'; publish(run); }
      return view(run);
    },
    cancelRequest(request) {
      const { nonce, signature } = requestIdentity(request);
      const entry = nonces.get(nonce);
      if (!entry) fail('run_not_found');
      if (entry.signature !== signature) fail('nonce_conflict');
      return this.cancel({ nonce });
    },
    busy() { return active ? view(active) : null; },
  };
}
