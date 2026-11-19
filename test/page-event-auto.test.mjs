import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { runInputAction, normalizeReturnFocus } from '../src/guard.js';
import { BridgeError } from '../src/bridge.js';
import { createPageEvents, PAGE_PROMPT_CATALOG, matchPromptRule, normalizePromptText } from '../src/page-events.js';
import { source, target, template, rule, settings, observation, tick } from './page-event-fixtures.mjs';
const index = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function production(name, text = index) {
  const start = text.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name); const end = text.indexOf('\n}', start);
  assert.ok(end > start, name); return text.slice(start, end + 2);
}
const names = ['actionReturnFocus', 'focusReturnNote', 'latchTerminalTaskInterruption', 'enterOrdinaryQueue', 'pageAutoError', 'checkPagePromptAuto', 'nativeAutoTextSafe', 'pageNativeMatches',
  'pagePromptDOMValidation', 'tryPageEventAuto', 'interruptTaskPlan', 'interruptPagePromptTask', 'preemptPageEvents', 'ensurePageEventTask', 'pinPageEventTarget', 'rebindPageEventSource', 'inputBoundaryCheck', 'inputAction', 'inputActionRun', 'taskRun', 'post', 'postedNothing', 'nativeMutation'];
function harness(options = {}, modifiedIndex = index) {
  const effects = [], state = { settings: structuredClone(settings), paused: false, conversation: false, epoch: 1, stopped: false, ...options };
  const forbidden = name => () => { effects.push(name); throw Error(`forbidden ${name}`); };
  const session = { request: async request => {
    effects.push(request.op); await state.onRequest?.(request);
    if (state.sessionBroken) throw new BridgeError('session_timeout', 'synthetic session failure');
    if (request.op === 'status') return { ok: true, epoch: state.epoch, takeover: { active: !state.stopped && !(state.finalHoldLost && state.writes), aborted: state.stopped, abortedBy: state.stopped ? 'esc' : null } };
    if (request.op === 'veil') return { ok: true, epoch: state.epoch, held: !state.stopped };
    if (request.op === 'inspectDialog') return state.native ? { known: true, open: true, complete: true, hasField: false,
      origin: rule.origin, originEvidence: 'native_current_snapshot', title: template.title, texts: template.texts, buttons: template.buttons,
      identity: { ...target, dialogToken: 'dialog', token: 'a'.repeat(64) } } : { known: true, open: false, ...state.dialog };
    if (request.op === 'click' || request.op === 'nativeChrome') {
      state.writes = (state.writes || 0) + 1;
      if (state.dispatchError) throw state.dispatchError;
      if (state.unknown) throw Object.assign(new BridgeError('native_delivery_unknown', 'uncertain'), { inputDelivery: 'unknown', noRetry: true });
      return { ok: true, epoch: state.epoch, operationId: request.operationId, stages: [], inputDelivery: 'sent' };
    }
    if (request.op === 'revokeNative' || request.op === 'panel') return { ok: true };
    throw Error(`unexpected native operation ${request.op}`);
  }, close: async () => { effects.push('close'); return { ok: true }; } };
  const kept = { returnFocus: { mode: 'origin', source: 'legacy_default' }, session, nativeState: { epoch: 1, target: { ...target }, sequence: 0 }, cgWindow: target.cgWindow, chromePid: target.chromePid, scene: {}, pointer: {} };
  const hold = { kept, task: 'fixture', lease: { release: async () => { effects.push('release'); } } };
  if (state.native) state.settings.rules[0].templateId = 'fixture-native-inactivity';
  const events = createPageEvents(); events.bind(source);
  const event = events.ingest(observation({ observedAt: Date.now(), ...(state.native ? { kind: 'native', originEvidence: 'native_current_snapshot', instance: { kind: 'native_episode', episodeId: 'episode', fingerprint: 'native-dialog' } } : {}) }));
  assert.ok(event?.eventId);
  let validations = 0;
  const deps = { normalizeReturnFocus, BridgeError, runInputAction, PAGE_PROMPT_CATALOG, matchPromptRule, normalizePromptText,
    samePageTarget: (a, b) => !!a && !!b && Object.keys(target).every(k => a[k] === b[k]),
    S: { get: () => state.paused, readPagePromptSettings: () => ({ value: state.settings, valid: true }) },
    CALL: { getStore: () => null }, ROUTINES: { runner: { busy: () => false, hasPending: () => false } },
    pausedCheck: () => { if (state.paused) throw new BridgeError('paused_by_user', 'pause'); },
    conversationInputCheck: () => { if (state.conversation) throw new BridgeError('conversation_waiting', 'question'); },
    taskCancelledError: () => new BridgeError('user_cancelled', 'stop'), taskInterruptedError: () => new BridgeError('task_interrupted', 'stop'),
    cancelledError: () => new BridgeError('cancelled', 'cancel'),
    B: { pageScript: async (name, args) => { assert.equal(name, 'prompt-observation'); assert.equal(args.PROMPT_OBSERVATION.mode, 'validate'); return 'fixed-script'; },
      evalInPage: async (script, tab, opts) => {
        effects.push('validate-dom'); assert.equal(script, 'fixed-script'); assert.equal(tab, target.tabId); assert.deepEqual(opts.exactTarget, target);
        validations++; await state.onDOM?.(validations);
        return { ok: true, point: { x: 30 + (state.staleGeometry && validations > 1 ? 1 : 0), y: 40 }, rect: { x: 20, y: 30, w: 50, h: 20 },
          view: {}, bounds: {}, target: { ...target, tabActive: true, minimized: false, ...state.visibility }, instance: { documentToken: 'document', nodeToken: 'node' }, ...state.dom };
      },
      answerDialog: async (button, value, identity, opts) => { assert.equal(button, rule.button); assert.equal(value, null);
        return opts.native({ kind: 'dialogAnswer', button, identity, autoConstraint: opts.autoConstraint }); },
      snapshotScene: forbidden('snapshotScene'), cgevent: forbidden('cgevent'), restoreScene: forbidden('restoreScene'), restoreApp: forbidden('restoreApp') },
    guardNativeTarget: async () => { effects.push('geometry'); await state.onGeometry?.(); },
    originFor: () => ({}), toScreen: x => x, rectToScreenRect: x => x,
    acquireLease: async () => { effects.push('acquireLease'); throw Object.assign(Error('inert lease boundary reached'), { code: 'fixture_acquire_reached' }); }, lockInfo: () => ({}), openOwnSession: forbidden('openOwnSession'),
    waitForUserIdle: forbidden('idle'), waitForHandsOff: forbidden('handsOff'),
    userActedSince: forbidden('userActedSince'), userClickedSince: forbidden('userClickedSince'),
    startGap: () => {}, debugLog: () => {}, publishPageEventStatus: () => {}, resumePageObservation: () => {},
    closeTaskFeed: () => {}, writeTaskState: () => {}, taskInterruptionReason: x => x, HANDOFFS: new Map() };
  // Execute unchanged production functions in this realm, so strict plain-object
  // settings validation is real; only native/UI effects are inert injected ops.
  const build = new Function('h', 'd', `const {${Object.keys(deps).join(',')}}=d;
    let PAGE_EVENTS=h.events, PAGE_SOURCE=h.source, PAGE_TASK={task:'fixture',generation:h.source.taskGeneration,provider:h.source.provider},
      PAGE_EVENT_ENDING=false,PAGE_EVENT_SUSPENDED=false,PLAN=h.state.implicit?null:{task:'fixture'},TASK_HOLD=h.hold,
      TASK_CANCELLED=null,YIELDING=null,ORDINARY_INPUTS=0,INFLIGHT=0,ORDINARY_TAIL=Promise.resolve(),LAST_CALL_END=0,USER_POINTER=null;
    const TAKEOVER=true,TAKEOVER_LIMITS={},TASK_LIMITS={},GUI_SERVICE=null,
      PAGE_INIT={connectionId:h.source.connectionId},PAGE_EVENT_WORKER=h.source.workerGeneration,
      PAGE_TARGET_KEYS=['chromePid','windowId','tabId','cgWindow'];
    ${names.map(name => production(name, modifiedIndex)).join('\n')}
    return {run:()=>tryPageEventAuto(h.event.eventId), queue:enterOrdinaryQueue, nativeTextSafe:nativeAutoTextSafe,
      async ordinary(task='fixture') { const release=await enterOrdinaryQueue(); try {
        inputBoundaryCheck(task);
        return await taskRun('ordinary fixture input', {takeover:true,nativeTransactions:true,now:Date.now,
          beforeSend:()=>inputBoundaryCheck(task),openSession:openOwnSession,
          prepare:async()=>({target:h.source.target,cgWindow:h.source.target.cgWindow,chromePid:h.source.target.chromePid,touchesScene:false})},
          async(s,p,ctx)=>{await ctx.check();ctx.sent('click');return s.request({op:'click'});},task);
      } finally {release();} },
      status:()=>({plan:PLAN,pageTask:PAGE_TASK,cancelled:TASK_CANCELLED,suspended:PAGE_EVENT_SUSPENDED}),
      set(p){if('hold'in p)TASK_HOLD=p.hold;if('source'in p)PAGE_SOURCE=p.source;if('plan'in p)PLAN=p.plan;
        if('pageTask'in p)PAGE_TASK=p.pageTask;if('cancelled'in p)TASK_CANCELLED=p.cancelled;if('suspended'in p)PAGE_EVENT_SUSPENDED=p.suspended;},
      current:()=>TASK_HOLD};`);
  return { ...build({ events, source, hold, event, state }, deps), state, effects, hold, kept, session, events, event,
    auto: () => events.getEvent(event.eventId).auto };
}
const noSceneWrites = h => assert.equal(h.effects.some(e => ['acquireLease', 'openOwnSession', 'hold', 'begin', 'bindNativeTarget', 'recordNativeScene', 'restoreScene', 'restoreApp', 'cgevent', 'idle', 'handsOff'].includes(e)), false, h.effects.join(','));
test('actual queue + inputAction + guard use the original hold and dispatch exactly one click with two validations', async () => {
  const h = harness(); await h.run(); assert.equal(h.auto().state, 'sent'); assert.equal(h.auto().outcome, 'unconfirmed');
  assert.equal(h.state.writes, 1); assert.equal(h.effects.filter(e => e === 'validate-dom').length, 2);
  assert.equal(h.current().kept.session, h.session); assert.equal(h.current().kept.nativeState.epoch, 1);
  await h.run(); assert.equal(h.state.writes, 1); noSceneWrites(h);
});
test('actual queue revalidates deleted rule, hold, source, target, epoch and Stop before any action', async () => {
  for (const change of [h => { h.state.settings.rules = []; }, h => h.set({ hold: { ...h.hold } }),
    h => h.set({ source: { ...source } }), h => { h.kept.nativeState.target.tabId++; }, h => { h.kept.nativeState.epoch++; },
    h => h.set({ cancelled: 'fixture' }), h => h.set({ suspended: true })]) {
    const h = harness(), release = await h.queue(); const work = h.run(); await tick();
    assert.equal(h.auto().state, 'queued'); change(h); release(); await work;
    assert.equal(h.auto().state, 'not_sent'); assert.equal(h.state.writes || 0, 0); noSceneWrites(h);
  }
});
test('awaited DOM geometry read rechecks Stop, Pause, handoff, conversation, task and target', async () => {
  for (const change of [h => { h.state.stopped = true; }, h => { h.state.paused = true; }, h => h.set({ suspended: true }),
    h => { h.state.conversation = true; }, h => h.set({ plan: { task: 'replacement' } }), h => { h.kept.nativeState.target.tabId++; }]) {
    const h = harness(); h.state.onGeometry = async () => { change(h); await tick(); }; await h.run();
    assert.equal(h.auto().state, 'not_sent'); assert.equal(h.state.writes || 0, 0); noSceneWrites(h);
  }
});
test('native unknown skips DOM; stale node/geometry skips click; no hold never acquires', async () => {
  for (const config of [{ dialog: { known: false } }, { dom: { ok: false } }, { staleGeometry: true }]) {
    const h = harness(config); await h.run(); assert.equal(h.auto().state, 'not_sent'); assert.equal(h.state.writes || 0, 0); noSceneWrites(h);
    if (config.dialog) assert.equal(h.effects.includes('validate-dom'), false);
  }
  const h = harness(); h.set({ hold: null }); await h.run(); assert.equal(h.auto().reason, 'same_hold_unavailable'); noSceneWrites(h);
});
test('native one-attempt uses same session; unknown closes that session with no restoration or replay', async () => {
  for (const native of [false, true]) {
    const h = harness({ native, unknown: true }); await h.run(); assert.equal(h.auto().state, 'unknown');
    assert.equal(h.state.writes, 1); assert.equal(h.effects.filter(x => x === 'close').length, 1);
    await h.run(); assert.equal(h.state.writes, 1); noSceneWrites(h);
    if (native) assert.equal(h.effects.includes('validate-dom'), false);
  }
  const native = harness({ native: true }); await native.run(); assert.equal(native.auto().state, 'sent'); noSceneWrites(native);
});
test('production native FEFF gate rejects any affected title/text/button without normalizing away data', () => {
  const h = harness(); assert.equal(h.nativeTextSafe(template, rule.button), true);
  for (const t of [{ ...template, title: '\uFEFF' + template.title }, { ...template, texts: ['\uFEFF' + template.texts[0]] }, { ...template, buttons: ['\uFEFF' + rule.button] }]) assert.equal(h.nativeTextSafe(t, rule.button), false);
  assert.equal(h.nativeTextSafe(template, '\uFEFF' + rule.button), false);
});
test('guard itself refuses retarget, scene recording, non-dialog native operation and a second dispatched attempt', async () => {
  for (const [operation, code] of [[ctx => ctx.bindNativeTarget({ ...target, tabId: 99 }), 'page_auto_retarget'],
    [ctx => ctx.recordNativeScene({}), 'page_auto_scene_forbidden'], [ctx => ctx.native({ kind: 'activate' }), 'page_auto_native_forbidden'],
    [ctx => { ctx.sent('click'); ctx.unsent('click'); ctx.sent('click'); }, 'page_auto_attempt_used']]) {
    const h = harness(), auto = { kept: h.kept, session: h.session, epoch: 1, target, attemptBudget: 1, noRetarget: true, check() {} };
    await assert.rejects(runInputAction({ pagePromptAuto: auto, reuse: h.kept, takeover: true, keep: true, nativeTransactions: true, now: Date.now,
      prepare: async () => ({ target, cgWindow: target.cgWindow, chromePid: target.chromePid, touchesScene: false }) }, async (_s, _p, ctx) => operation(ctx)), e => e.code === code);
    noSceneWrites(h);
  }
});
test('removing only production second-attempt guard makes the intended no-repeat assertion fail', async () => {
  const original = await fs.readFile(new URL('../src/guard.js', import.meta.url), 'utf8');
  const line = original.split('\n').find(s => s.includes('if (pagePromptAuto && pagePromptAuto.dispatched) throw'));
  assert.ok(line);
  const mutated = original.replace(line, '').replace("from './bridge.js'", `from ${JSON.stringify(new URL('../src/bridge.js', import.meta.url).href)}`);
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(mutated).toString('base64'));
  async function negative(run) {
    const h = harness(); let writes = 0;
    const auto = { kept: h.kept, session: h.session, epoch: 1, target, attemptBudget: 1, noRetarget: true, check() {} };
    await run({ pagePromptAuto: auto, reuse: h.kept, takeover: true, keep: true, nativeTransactions: true, now: Date.now,
      prepare: async () => ({ target, cgWindow: target.cgWindow, chromePid: target.chromePid, touchesScene: false }) }, async (_s, _p, ctx) => {
      ctx.sent('click'); writes++; ctx.unsent('click'); ctx.sent('click'); writes++;
    }).catch(() => {});
    assert.equal(writes, 1, 'a dispatched attempt stays spent even after an explicit zero receipt');
  }
  await negative(runInputAction); await assert.rejects(negative(mutant.runInputAction), e => e.code === 'ERR_ASSERTION' && e.actual === 2);
});

test('P44-SAFETY-01 lost or unknown auto latches the original explicit or implicit task before ordinary continuation', async () => {
  const failures = [];
  for (const implicit of [false, true]) for (const mode of ['dom-unknown', 'native-unknown', 'final-status-lost', 'session-error']) {
    const h = harness({ implicit, native: mode === 'native-unknown', unknown: mode.endsWith('unknown'), finalHoldLost: mode === 'final-status-lost' });
    if (mode === 'session-error') h.state.onRequest = request => { if (request.op === 'inspectDialog') h.state.sessionBroken = true; };
    try {
      await h.run(); const writes = h.state.writes || 0;
      const error = await h.ordinary().catch(error => error);
      assert.ok(['user_cancelled', 'task_interrupted'].includes(error?.code), 'ordinary input must encounter the existing task interruption gate');
      assert.ok(h.status().cancelled === 'fixture' || h.status().plan?.interrupted);
      assert.equal(h.state.writes || 0, writes); assert.equal(h.effects.filter(x => x === 'close').length, 1); noSceneWrites(h);
    } catch (error) { failures.push({ implicit, mode, reason: error.message, effects: h.effects }); }
  }
  assert.deepEqual(failures, []);
});
test('P44-SAFETY-02 both DOM validations require positively active and non-minimized target metadata', async () => {
  const failures = [];
  for (const [label, visibility] of [['inactive', { tabActive: false }], ['active missing', { tabActive: undefined }],
    ['minimized', { minimized: true }], ['minimized missing', { minimized: undefined }]]) {
    for (const read of [1, 2]) {
      const h = harness(); h.state.onDOM = number => { if (number === read) h.state.visibility = visibility; };
      try { await h.run(); assert.equal(h.auto().state, 'not_sent'); assert.equal(h.state.writes || 0, 0); noSceneWrites(h); }
      catch (error) { failures.push({ label, read, reason: error.message, effects: h.effects }); }
    }
  }
  assert.deepEqual(failures, []);
});

test('same-generation plan progress is interrupted, while a genuinely later task generation remains usable', async () => {
  const progressed = harness({ unknown: true }); const laterPlan = { task: 'fixture', progress: 2 };
  progressed.state.onRequest = request => { if (request.op === 'click') progressed.set({ plan: laterPlan }); };
  await progressed.run(); assert.equal(progressed.status().plan, laterPlan); assert.ok(laterPlan.interrupted);
  await assert.rejects(progressed.ordinary(), e => ['user_cancelled', 'task_interrupted'].includes(e.code)); noSceneWrites(progressed);

  // Same task name is intentionally reused: generation, not label or PLAN object,
  // determines whether the original failure may interrupt this new task.
  for (const code of ['native_delivery_unknown', 'user_cancelled', 'task_hold_lost']) {
    const fresh = harness({ dispatchError: Object.assign(new BridgeError(code, 'old-session failure'), { by: 'esc' }) });
    const nextSession = { ...fresh.session }, nextPlan = { task: 'fixture' };
    const nextHold = { ...fresh.hold, kept: { ...fresh.kept, session: nextSession,
      nativeState: { epoch: 1, target: { ...target }, sequence: 0 } } };
    fresh.state.onRequest = request => { if (request.op === 'click' && fresh.state.dispatchError) fresh.set({
      plan: nextPlan, pageTask: { task: 'fixture', generation: 'later-generation', provider: 'Claude' },
      source: { ...source, taskGeneration: 'later-generation' }, hold: nextHold }); };
    await fresh.run(); assert.equal(fresh.status().plan, nextPlan); assert.equal(nextPlan.interrupted, undefined, code);
    assert.equal(fresh.status().cancelled, null, code); assert.equal(fresh.current(), nextHold);
    fresh.state.dispatchError = null; await fresh.ordinary(); assert.equal(fresh.state.writes, 2);
    assert.equal(fresh.current().kept.session, nextSession); noSceneWrites(fresh);
  }
});
test('healthy not_sent rule and stale-node refusals preserve the original hold for ordinary authorized input', async () => {
  for (const mode of ['deleted-rule', 'stale-node']) {
    const h = harness(mode === 'stale-node' ? { dom: { ok: false } } : {});
    const release = await h.queue(), auto = h.run(); await tick();
    if (mode === 'deleted-rule') h.state.settings.rules = [];
    release(); await auto; assert.equal(h.auto().state, 'not_sent'); assert.equal(h.current(), h.hold);
    assert.equal(h.status().cancelled, null); assert.equal(h.status().plan.interrupted, undefined);
    await h.ordinary(); assert.equal(h.state.writes, 1); assert.equal(h.current().kept.session, h.session);
    assert.equal(h.effects.includes('close'), false); noSceneWrites(h);
  }
});
async function queuedContinuationNegative(text = index) {
  const h = harness({ unknown: true }, text); let entered, resume;
  const atWrite = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { resume = resolve; });
  h.state.onRequest = async request => { if (request.op === 'click') { entered(); await waiting; } };
  const auto = h.run(); await atWrite;
  const next = h.ordinary().catch(error => error);
  resume(); await auto; const error = await next;
  assert.equal(h.effects.includes('acquireLease'), false, 'lost auto task must be latched before queued ordinary input reaches acquireLease');
  assert.ok(['user_cancelled', 'task_interrupted'].includes(error.code)); assert.equal(h.state.writes, 1); noSceneWrites(h);
}
test('new task interruption latch precedes queued input; removing its actual call makes the reacquire negative fail', async () => {
  await queuedContinuationNegative();
  const guard = '    if (ops.pagePromptAuto) interruptPagePromptTask(ops.pagePromptAuto, th, e);';
  assert.equal(index.split(guard).length, 2);
  await assert.rejects(queuedContinuationNegative(index.replace(guard, '')), e => e.code === 'ERR_ASSERTION' && e.actual === true && e.expected === false);
});
test('removing only the production active/minimized check makes inactive-target refusal fail', async () => {
  const guard = ' ||\n      result.target.tabActive !== true || result.target.minimized !== false';
  assert.equal(index.split(guard).length, 2);
  async function negative(text) {
    const h = harness({ visibility: { tabActive: false, minimized: false } }, text); await h.run();
    assert.equal(h.state.writes || 0, 0, 'a hidden tab must never become a physical click on another tab'); noSceneWrites(h);
  }
  await negative(index); await assert.rejects(negative(index.replace(guard, '')), e => e.code === 'ERR_ASSERTION' && e.actual === 1 && e.expected === 0);
});
