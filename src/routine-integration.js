/** Local recording and one shared entry point for MCP and the native GUI. */
import { randomUUID } from 'node:crypto';
import { createRoutineStore } from './routines.js';
import { createRoutineRunner, routinePage, pageMatches, RoutineError } from './routine-runner.js';

export const ROUTINE_ACTIONS = new Set(['click', 'hover', 'type_text', 'select_option', 'press_key', 'scroll', 'click_at', 'answer_dialog']);
const REPLAYABLE = new Set(['click', 'hover', 'type_text', 'select_option', 'press_key', 'scroll']);
const safeArgs = (tool, args) => {
  if (tool === 'type_text') return { submit: args.submit === true, ...(args.input_mode ? { input_mode: args.input_mode } : {}) };
  if (tool === 'click') return { scroll_into_view: args.scroll_into_view !== false };
  if (tool === 'press_key') return { key: args.key, times: args.times ?? 1 };
  if (tool === 'scroll') return { direction: args.direction, amount: args.amount ?? 1 };
  return {};
};

export function createRoutineIntegration({ adapter, sessionId = randomUUID(), store = createRoutineStore({ sessionId }), recording = () => process.env.CHROME_BRIDGE_ROUTINE_RECORDING !== '0' }) {
  let recordingError = false;
  const lastPages = new Map();
  // A missed action is a gap even when the ordinary browser operation succeeds.
  // Keep only sanitized page identity and tool name until its barrier is durable.
  const dirtyStreams = new Map();
  function markDirty(tab, tool) {
    if (!Number.isSafeInteger(tab) || tab <= 0) return;
    dirtyStreams.set(tab, { page: dirtyStreams.get(tab)?.page ?? lastPages.get(tab), tool });
  }
  async function flushDirty(tab, fallbackPage) {
    const dirty = dirtyStreams.get(tab);
    if (!dirty) return true;
    const page = dirty.page ?? fallbackPage ?? lastPages.get(tab);
    if (!page || !recording()) return false;
    try {
      const saved = await store.record({ tool: dirty.tool, tab, before: page, after: page,
        ok: false, replayable: false, reason: 'not_replayable' });
      if (!saved) return false; // Recording may have been disabled during the write.
      if (dirtyStreams.get(tab) === dirty) dirtyStreams.delete(tab);
      if (!dirtyStreams.size) recordingError = false;
      return !dirtyStreams.has(tab);
    } catch { recordingError = true; return false; }
  }
  const runner = createRoutineRunner({ store, adapter });
  const query = async payload => {
    switch (payload?.action) {
      case 'snapshot': case 'list': case 'history': return { ...await store.snapshot({ site: payload.site, query: payload.query, limit: payload.limit }), activeRun: runner.busy(), recordingError };
      case 'save': return store.save({ name: payload.name, description: payload.description, eventIds: payload.eventIds });
      case 'update': return store.update(payload.id, { ...(payload.name !== undefined ? { name: payload.name } : {}), ...(payload.archived !== undefined ? { archived: payload.archived } : {}) });
      case 'settings': { const enabled = await store.setEnabled(payload.enabled); return { enabled }; }
      case 'tabs': return { tabs: await adapter.tabs() };
      case 'start': return runner.start(payload);
      case 'run': return runner.run(payload);
      case 'status': return runner.status(payload);
      case 'cancel': case 'stop': return runner.cancel(payload);
      default: throw new RoutineError('invalid_request');
    }
  };

  async function beforeInput(context, tab) {
    const attempt = context?.routineAttempt;
    if (!attempt || attempt.started) return;
    attempt.started = true;
    attempt.tab = tab;
    const { tool, args } = attempt;
    if (!recording()) { markDirty(tab, tool); return; }
    try {
      if (!(await store.snapshot({ limit: 1 })).enabled) { markDirty(tab, tool); return; }
      // Escape/native-dialog recovery must never gain an Apple Event probe in front of it.
      if (tool === 'answer_dialog' || (tool === 'press_key' && args.key === 'escape')) { await barrier(tab, tool); return; }
      let captured;
      if (tool === 'scroll' || !REPLAYABLE.has(tool)) captured = await adapter.capture(tab, { mode: 'state' });
      else {
        try { captured = await adapter.capture(tab, { mode: 'capture', ...(args.marker != null ? { marker: args.marker } : { focused: true }) }); }
        catch { captured = { ...await adapter.capture(tab, { mode: 'state' }), replayable: false }; }
      }
      const before = routinePage({ ...captured, replayable: undefined });
      lastPages.set(tab, before);
      // Never let a recovered recorder create adjacent records around a missing
      // action. If persistence is still unavailable, this action stays a gap too.
      if (!(await flushDirty(tab, before))) return;
      const replayable = REPLAYABLE.has(tool) && captured.replayable !== false && !captured.sensitive
        && (tool === 'scroll' || !!captured.descriptor);
      attempt.event = { tool, tab, task: attempt.task, before, after: before,
        target: captured.descriptor, targetState: captured.targetState, args: safeArgs(tool, args),
        sensitive: captured.sensitive === true, replayable, reason: replayable ? undefined : 'not_replayable' };
      attempt.pending = await store.begin(attempt.event);
      if (!attempt.pending) markDirty(tab, tool);
    } catch {
      recordingError = true;
      await barrier(tab, tool);
      // A recorder/storage failure must not change the outcome of an ordinary authorized browser action.
    }
  }
  async function finishInput(context, result, observation) {
    const attempt = context?.routineAttempt;
    const original = attempt.event;
    const ok = !!result && !result.isError && !context.failed && context.routineEvidence?.ok !== false
      && observation?.noteable !== false;
    // The native action's observer runs under its physical lease. A handoff
    // (since=null) already transferred that lease; an outer tool completion
    // has no observation token at all. Neither may inspect or attribute a page.
    const untouched = async () => {
      if (observation?.noteable !== true || !Number.isFinite(observation.since)
          || typeof observation.untouched !== 'function') return false;
      try { return await observation.untouched() === true; } catch { return false; }
    };
    let replayable = ok && original.replayable;
    let after = original.after, afterState;
    const code = context.routineEvidence?.code || context.code;
    try {
      if (ok && await untouched()) {
        const captured = await adapter.capture(original.tab, { mode: 'state' });
        after = routinePage(captured);
        if (original.target && pageMatches(after, original.before, { fingerprint: false })) {
          try { afterState = (await adapter.capture(original.tab, { mode: 'resolve', target: original.target })).targetState; }
          catch { /* Navigation can remove the old target; its new page remains the postcondition. */ }
        }
        // Human input can resume after hand-back even while the lease excludes
        // other workers. Confirm the whole capture interval, not only its start.
        if (!await untouched()) { after = original.after; afterState = undefined; replayable = false; }
        else lastPages.set(original.tab, after);
      } else replayable = false;
    } catch { after = original.after; afterState = undefined; replayable = false; }
    if (attempt.tool === 'click') {
      const changedState = Object.keys(original.targetState ?? {}).some(key =>
        typeof original.targetState[key] === 'boolean' && typeof afterState?.[key] === 'boolean'
        && original.targetState[key] !== afterState[key]);
      if (context.routineEvidence?.confirmed !== true || (pageMatches(after, original.before) && !changedState)) replayable = false;
    }
    try {
      const saved = await store.finish(attempt.pending.id, { after, afterState, ok, code, replayable,
        reason: replayable ? undefined : ok ? 'not_replayable' : 'action_failed' });
      attempt.replayableFinished = replayable && saved?.replayable !== false;
      if (!dirtyStreams.size) recordingError = false;
    } catch { recordingError = true; markDirty(original.tab, attempt.tool); }
  }
  async function afterInput(context, result, { observation } = {}) {
    const attempt = context?.routineAttempt;
    if (attempt?.finishing) {
      await attempt.finishing;
      // An action may have completed before a later hold/dispatch interruption.
      // Keep its proven receipt, but never join the next action across that gap.
      if (attempt.replayableFinished && !attempt.failureBarrier
          && (result?.isError || context.failed || context.routineEvidence?.ok === false)) {
        attempt.failureBarrier = true;
        await barrier(attempt.tab ?? attempt.args.tab, attempt.tool);
      }
      return;
    }
    if (!attempt?.pending) {
      if (attempt && (!attempt.started || result?.isError || context.failed || context.routineEvidence?.ok === false)) await barrier(attempt.tab ?? attempt.args.tab, attempt.tool);
      return;
    }
    // Native observer and outer dispatch cleanup share the exact same receipt.
    // A failed persistence attempt remains a dirty barrier, never a second finish.
    attempt.finishing = finishInput(context, result, observation);
    return attempt.finishing;
  }
  async function barrier(tab, tool = 'wait_for_user') {
    if (!Number.isSafeInteger(tab) || tab <= 0) {
      for (const known of lastPages.keys()) { markDirty(known, tool); await flushDirty(known); }
      return;
    }
    markDirty(tab, tool);
    await flushDirty(tab);
  }
  return { query, beforeInput, afterInput, barrier, runner, store, recordingError: () => recordingError };
}
