/* Offline production-function regression tests. No Chrome, keyboard, or mouse. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { planScrollStep, chainDelta, aimClickable, MAX_SCROLL_BURSTS, BURST_MAX, FAR_BURST_MAX, runInputAction } from '../src/guard.js';
import { BridgeError } from '../src/bridge.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }
const documentLoc = (y, { height = 800, top = 0, sig = 'document' } = {}) => ({
  aim: { x: 300, y }, rect: { x: 280, y: y - 20, width: 40, height: 40 },
  view: { innerWidth: 1200, innerHeight: height },
  chain: [{ sig, document: true, clip: { x: 0, y: 0, width: 1200, height },
    scrollableY: true, scrollTop: top, maxTop: 10000,
    wheel: { down: { x: 300, y: 400 }, up: { x: 300, y: 400 } } }],
});

await check('far bursts require local calibration, stay conservative, and cap at 24', () => {
  const loc = documentLoc(2500), rng = () => 0.5;
  assert.ok(planScrollStep(loc, { rng }).notches <= BURST_MAX, 'first burst must calibrate');
  assert.ok(planScrollStep(loc, { rng, pxByScroller: new Map([['0:another-box', 40]]) }).notches <= BURST_MAX);
  const calibrated = planScrollStep(loc, { rng, pxByScroller: new Map([['0:document', 100]]) });
  assert.equal(calibrated.notches, 16, 'floor(0.8 * 2100 / 100), below the predicted remaining distance');
  assert.equal(planScrollStep(loc, { rng, pxByScroller: new Map([['0:document', 40]]) }).notches, FAR_BURST_MAX);
  for (const measured of [NaN, Infinity, 0, -1]) {
    assert.ok(planScrollStep(loc, { rng, pxByScroller: new Map([['0:document', measured]]) }).notches <= BURST_MAX);
  }
});

await check('two-viewports threshold is strict, near pacing is unchanged, and overshoot can reverse', () => {
  const rng = () => 0.5, map = new Map([['0:document', 100]]);
  assert.equal(planScrollStep(documentLoc(2000), { rng, pxByScroller: map }).notches,
    planScrollStep(documentLoc(2000), { rng, pxPerNotch: 100 }).notches);
  assert.equal(planScrollStep(documentLoc(790), { rng, pxByScroller: map }).notches, 4);
  const reversed = planScrollStep(documentLoc(-500, { top: 4000 }), { rng, pxByScroller: map });
  assert.equal(reversed.dir, 'up');
  assert.ok(reversed.notches <= BURST_MAX);
});

await check('nested scrollers never inherit the document wheel speed', () => {
  const loc = documentLoc(3300);
  loc.chain.unshift({ sig: 'list', clip: { x: 100, y: 100, width: 400, height: 500 },
    scrollableY: true, scrollTop: 0, maxTop: 5000,
    wheel: { down: { x: 300, y: 300 }, up: { x: 300, y: 300 } } });
  const options = { rng: () => 0.5, pxByScroller: new Map([['1:document', 10]]) };
  const first = planScrollStep(loc, options);
  assert.equal(first.key, '0:list');
  assert.ok(first.notches <= BURST_MAX, 'the inner box still needs its own first burst');
  options.pxByScroller.set('0:list', 100);
  assert.equal(planScrollStep(loc, options).notches, 23);
});

async function simulateScroll({ stalled = false, interrupted = false, speed = 1, sample = 500, animate = null } = {}) {
  let top = 0, fallback = 0, statuses = 0, reads = 0, clock = 0, anim = null;
  // animate = { delay, duration }: smooth scroll starts `delay` ms after the wheel, lasts `duration` ms; reads follow the clock.
  const now = () => anim ? Math.round(anim.from + (anim.to - anim.from) * Math.min(1, Math.max(0, (clock - anim.t0 - animate.delay) / animate.duration))) : top;
  const wheels = [], pauses = [];
  const locate = () => {
    const top = now();
    const loc = documentLoc(3720 - top, { height: 700, top });
    loc.rect.y = 3700 - top;
    loc.chain[0].maxTop = 3100;
    loc.hitOk = top === 3100;
    loc.visible = { x: 280, y: Math.max(0, loc.rect.y), width: 40, height: 40 };
    return loc;
  };
  const context = vm.createContext({
    Map, Set, Math, MAX_SCROLL_BURSTS, aimClickable, chainDelta, S: { setting: () => ({ value: 1 }) },
    CALL: { getStore: () => null }, conversationInputCheck() {},
    planScrollStep: (loc, opts) => planScrollStep(loc, { ...opts, rng: () => wheels.length % 2 ? 0.6 : 0.4 }),
    pointerTo: async () => {}, originFor: () => ({}),
    S: { setting: () => ({ value: speed }) },
    between: () => sample, sleep: async ms => { pauses.push(ms); clock += ms; },
    locateTarget: async (_marker, _tab, opts) => {
      reads++;
      if (opts?.scroll) { fallback++; top = 3100; }
      return locate();
    },
  });
  const session = { request: async req => {
    if (req.op === 'status') {
      statuses++;
      if (interrupted) throw Error('user interrupted during pause');
      return {};
    }
    assert.equal(req.op, 'wheel');
    wheels.push(req);
    if (!stalled) {
      const to = Math.max(0, Math.min(3100, now() + (req.dir === 'down' ? 1 : -1) * req.notches * 40));
      if (animate) anim = { t0: clock, from: now(), to }; top = to;
    }
    return { sent: req.notches };
  } };
  vm.runInContext(['inputSpeedNow', 'settlePause', 'post', 'postedNothing', 'scrollToTarget'].map(functionSource).join('\n'), context);
  const sent = [];
  const action = () => context.scrollToTarget(session, { step() {}, sent: kind => sent.push(kind), unsent: kind => sent.splice(sent.lastIndexOf(kind), 1) }, 1, 10, locate(), true);
  let result = null;
  if (interrupted) await assert.rejects(action, /user interrupted/);
  else result = await action();
  return { wheels, pauses, fallback, statuses, reads, top, sent, result };
}

await check('actual scrollToTarget reaches a distant target within the unchanged budget, without fallback', async () => {
  const r = await simulateScroll();
  assert.ok(r.wheels[0].notches >= 3 && r.wheels[0].notches <= 8);
  assert.ok(r.wheels.some(w => w.notches > 8));
  assert.ok(r.wheels.every(w => w.notches <= 24));
  assert.ok(r.wheels.length <= 8, `${r.wheels.length} bursts`);
  assert.equal(r.top, 3100);
  assert.equal(r.fallback, 0);
  assert.equal(r.statuses, r.wheels.length, 'status is still checked after every pause');
  assert.ok(r.pauses.every(ms => ms >= 300 && ms <= 700));
});

// The animation cases come first on purpose: a mutant that shortens the pause must trip one of THEM, not the formula check.
// Pause at speed 3 with the smallest sample is exactly the 300 ms floor. Production wording for a stalled scrollInSession (non-verbose):
const STUCK_TEXT = '页面不再移动，已停止';
await check('P3: scrollToTarget with a smooth scroll still running or starting late at the first read is not exhausted; a scroll that never starts is (positive control)', async () => {
  // delay/duration in ms from the wheel; the first read happens after the 300 ms floor (speed 3, smallest sample).
  for (const animate of [{ delay: 0, duration: 500 }, { delay: 0, duration: 450 }, { delay: 120, duration: 150 }, { delay: 250, duration: 40 }, { delay: 280, duration: 100 }]) {
    const r = await simulateScroll({ speed: 3, sample: 300, animate });
    // A slow animation may cost extra bursts (budget: too_many) but is never judged unreachable/exhausted.
    assert.ok(r.result.reason == null || r.result.reason === 'too_many', `${JSON.stringify(animate)} judged ${r.result.reason}`);
    assert.ok(r.wheels.length > 1 || r.result.done === true, JSON.stringify(animate));
    if (animate.delay + animate.duration <= 300) { assert.equal(r.result.done, true, JSON.stringify(animate)); assert.equal(r.top, 3100); }
  }
  const never = await simulateScroll({ speed: 3, sample: 300, animate: { delay: 5000, duration: 100 } });
  assert.ok(never.result.reason && never.result.reason !== 'too_many' && never.result.done !== true, `never-starting scroll: ${never.result.reason}`);
});

await check('P3: scrollInSession with a smooth scroll still running (>300 ms) or starting late (<300 ms) at the first read is not stuck; one that never starts is', async () => {
  const allPauses = [];
  for (const animate of [{ delay: 0, duration: 600 }, { delay: 0, duration: 450 }, { delay: 100, duration: 500 }, { delay: 250, duration: 40 }, { delay: 280, duration: 100 }]) {
    const h = foregroundScroll({ speed: 3, sample: 0, animate });
    const out = await h.run();
    assert.doesNotMatch(out, new RegExp(STUCK_TEXT), `${JSON.stringify(animate)} was reported stuck: ${out}`);
    assert.match(out, /✅ 已向下滚动/, JSON.stringify(animate));
    assert.ok(h.position() >= 200, `${JSON.stringify(animate)} position ${h.position()}`);
    allPauses.push(...h.pauses);
  }
  assert.ok(allPauses.length > 0 && allPauses.every(ms => ms >= 300), JSON.stringify(allPauses));
  // Positive control: the same harness, a page that never moves inside the window, produces the exact production wording.
  const stalled = foregroundScroll({ speed: 3, sample: 0, animate: { delay: 60_000, duration: 100 } });
  assert.match(await stalled.run(), new RegExp(STUCK_TEXT));
  // And the animation really is still running at the first read in the 600 ms case (not a finished-in-time fixture).
  const probe = foregroundScroll({ speed: 3, sample: 0, animate: { delay: 0, duration: 600 } });
  await probe.run();
  assert.ok(probe.firstReadFraction() > 0 && probe.firstReadFraction() < 1, `first read fraction ${probe.firstReadFraction()}`);
});

await check('P3: speed scales only the human part of the scroll pause; the 300 ms animation floor never drops (scrollToTarget)', async () => {
  for (const [speed, sample, want] of [[1, 500, 500], [1, 700, 700], [3, 700, 300 + 400 / 3], [3, 300, 300], [3, 500, 300 + 200 / 3], [0.5, 700, 1100], [2, 300, 300]]) {
    const r = await simulateScroll({ speed, sample });
    assert.ok(r.pauses.length > 0);
    for (const ms of r.pauses) assert.ok(Math.abs(ms - want) < 1e-9, `speed ${speed} sample ${sample}: ${ms} vs ${want}`);
    assert.equal(r.top, 3100, 'budget and arrival unchanged');
  }
});

await check('zero progress exhausts the scroller; interruption prevents any follow-up or fallback', async () => {
  const stalled = await simulateScroll({ stalled: true });
  assert.equal(stalled.wheels.length, 1);
  assert.equal(stalled.fallback, 0);
  assert.deepEqual(stalled.sent, ['wheel'], 'earlier wheel delivery stays in the retry ledger');
  const stopped = await simulateScroll({ interrupted: true });
  assert.equal(stopped.wheels.length, 1);
  assert.equal(stopped.reads, 0);
  assert.equal(stopped.fallback, 0);
});

await check('nested scroller no-progress reports target click not_sent and retains the earlier wheel delivery', async () => {
  const loc = documentLoc(700);
  loc.tag = 'button'; loc.text = 'nested target'; loc.visible = null; loc.hitOk = false;
  loc.chain[0].scrollableY = false; loc.chain[0].maxTop = 0;
  loc.chain.unshift({ sig: 'nested', clip: { x: 100, y: 100, width: 400, height: 400 },
    scrollableY: true, scrollTop: 0, maxTop: 5000, wheel: { down: { x: 300, y: 300 } } });
  const sent = [], requests = [];
  const context = vm.createContext({
    Map, Set, Math, Date, BridgeError, MAX_SCROLL_BURSTS, planScrollStep, chainDelta, aimClickable, S: { setting: () => ({ value: 1 }) },
    CALL: { getStore: () => null }, conversationInputCheck() {}, B: { listTabs: async () => null },
    originFor: () => ({}), pointerTo: async () => {}, between: () => 0, sleep: async () => {},
    locateTarget: async (_marker, _tab, opts) => { assert.equal(opts?.scroll, undefined); return loc; },
    locateForInput: async (_prep,_ctx,vars) => {assert.equal(vars.SCROLL,undefined);return loc;},
    guardNativeSelect: async () => {}, PRE_LOC_FRESH_MS: 1500,
  });
  vm.runInContext(['inputSpeedNow', 'settlePause', 'postedNothing', 'post', 'scrollToTarget', 'clickDeliver'].map(functionSource).join('\n'), context);
  const session = { request: async req => { requests.push(req.op); return { ok: true, sent: req.notches || 0 }; } };
  const ctx = { step() {}, mark() {}, sent: kind => sent.push(kind), unsent() {} };
  await assert.rejects(context.clickDeliver(session, { target: { tabId: 1 } }, ctx, { marker: 1 }), e =>
    e.code === 'target_offscreen' && e.targetInputDelivery === 'not_sent' && e.inputDelivery === 'sent' && /真实滚轮/.test(e.message));
  assert.deepEqual(sent, ['wheel']);
  assert.equal(requests.includes('click'), false);
});

// A real takeover must raise its exact target before using the wheel. Model
// the reported MyChrome window covering Chrome, using production preparation,
// wheel logic and the native-session lifecycle; only OS/page I/O is simulated.
function foregroundScroll({ takeover = true, front = 'MyChrome', info = {}, activation = {}, stop = false, speed = 1, sample = 0, animate = null } = {}) {
  const events = [], pauses = [];
  let top = 0, held = false, selected = false, clock = 0, anim = null, firstRead;
  // animate = { delay, duration }: the wheel's smooth scroll starts `delay` ms after it and takes `duration` ms; position follows the clock.
  const now = () => anim ? Math.round(anim.from + (anim.to - anim.from) * Math.min(1, Math.max(0, (clock - anim.t0 - animate.delay) / animate.duration))) : top;
  const target = () => ({ tabId: 5, windowId: 10, chromePid: 42, cgWindow: 70,
    tabActive: true, minimized: false, bounds: { left: 0, top: 0, width: 1000, height: 800 },
    url: 'https://example.test/article', ...info, ...(selected ? { tabActive: true } : {}) });
  const session = { interrupted: null, request: async req => {
    events.push(req.op);
    if (req.op === 'hold') {
      if (stop) return { ok: false, error: 'aborted', takeover: { active: false, aborted: true, abortedBy: 'esc' } };
      held = true;
      return { ok: true, pointer: { x: 1, y: 2 }, takeover: { active: true } };
    }
    if (req.op === 'veil') return { ok: true, held };
    if (req.op === 'begin') return { ok: true, inputMonitor: true, takeover: { active: held } };
    return { ok: true, takeover: { active: held, aborted: false } };
  }, close: async () => { events.push('close'); held = false; return { ok: true }; } };
  const c = vm.createContext({
    Number, Math, Date, Set, Map, BridgeError, TAKEOVER: takeover, process: { env: {} }, CALL: { getStore: () => null },
    NATIVE_TARGETS: new Map(), SHOTS:new Map(), GEOMETRY_UNVERIFIED:new Set(), DISPLAYS:{at:0,list:null}, USER_POINTER: null, TASK_HOLD: null, PRE_LOC_FRESH_MS:1500,
    B: {
      chromeInfo: async () => { events.push('info'); return target(); },
      selectTab: async (tab, options) => {
        assert.equal(tab, 5); assert.equal(options.windowId, 10);
        events.push('select'); selected = true; return { ...target(), changed: true };
      },
      activateChrome: async tab => {
        assert.equal(tab, 5, 'activation must use the resolved target, never the front tab');
        if (takeover) assert.equal(held, true, 'activation happened before takeover');
        events.push('activate'); front = 'Chrome';
        if (activation.error) throw new BridgeError(activation.error, 'native focus was not confirmed');
        return { ...target(),ok:true,inputDelivery:'sent', targetOnTop: true, keyWindowIsTarget: true,
          geometry:{mode:'fit-current',beforeBounds:{...target().bounds},displayId:1,branch:'usable',changed:false,possiblyChanged:false}, ...activation };
      },
      moveWindow:async(windowId,b,options)=>{assert.equal(windowId,10);assert.equal(b,null);assert.equal(options.fitCurrent,true);
        return {...target(),ok:true,geometry:{mode:'fit-current',beforeBounds:{...target().bounds},displayId:1,branch:'usable',changed:false,possiblyChanged:false}};},
      cgevent: async () => ({ windows: [{ layer: 0, pid: 99, owner: 'Other app' }] }),
      evalInPage: async mode => mode === 'measure' ? (firstRead ??= (anim ? (now() - anim.from) / (anim.to - anim.from) : null), { scrollTop: now(), max: 2000 }) : {
        ...target(),view:{innerWidth:1000,innerHeight:700,outerWidth:1000,outerHeight:800},
        scroller: 'document', height: 800, scrollTop: top, max: 2000, points: [{ x: 100, y: 100 }],
      },
    },
    agentWindowIds: async () => new Set(['10']), keepAgentAway: async () => '', agentState:async()=>({byProfile:{}}),saveAgentState:async()=>{},
    ownershipNote: async () => '', boundsRect: b => ({ x: b.left, y: b.top, w: b.width, h: b.height }),
    locateScript: async ({ MODE }) => MODE, originFor: () => ({}), targetLine: () => 'tab=5',
    // G2 r2: locateForInput reads behind the strict gate (gatedPageScript); this page is clean, so the eval answers locate.js's own result.
    gatedLocateScript: async ({ MODE }) => MODE,
    unoccludedPoint: async points => front === 'Chrome' ? points[0] : null,
    pointerTo: async () => { events.push('pointer'); },
    post: async (_s, ctx, kind, req) => {
      assert.equal(front, 'Chrome', 'wheel would hit the covering App');
      events.push('wheel'); ctx.sent(kind);
      if (animate) { anim = { t0: clock, from: now(), to: now() + req.notches * 40 }; top = anim.to; } else top += req.notches * 40;
      return { sent: req.notches };
    },
    PX_PER_NOTCH: 40, BURST_MIN: 3, BURST_MAX: 8,
    S: { setting: () => ({ value: speed }) },
    between: () => sample, sleep: async ms => { pauses.push(ms); clock += ms; },
    persist: async (fn, signal) => fn({ signal }), veilFor: () => ({}), taskKey: () => '',
    inputAction: async (_label, prepare, action, options) => {
      events.push(`activates:${options.activates}`);
      return (await runInputAction({
        takeover, activates: options.activates, prepare, signal: options.idle.signal,
        now: Date.now, waitForUserIdle: async () => 0, waitForHandsOff: async () => 0,
        snapshotScene: async () => { events.push('snapshot'); return { appPid: 99 }; },
        mousepos: async () => ({ x: 1, y: 2 }), openSession: async () => session,
        userActedSince: async () => false, userClickedSince: async () => false,
        restoreScene: async () => { events.push('restore'); front = 'MyChrome'; return { activated: true }; },
        restoreApp: async () => { events.push('restore-app'); return {}; },
        warp: async () => { events.push('warp-fallback'); },
      }, action)).out;
    },
  });
  vm.runInContext(['geometryTarget','geometryKey','sameGeometryBounds','invalidateGeometry','acceptGeometryResult','observeGeometryFailure','saveFittedAgentPlacement','passGate','locateForInput','corroborateGeometry','prepareNativeTarget', 'requireSelectable', 'bringOnScreen', 'prepareActivate', 'prepareScroll', 'inputSpeedNow', 'settlePause', 'scrollInSession', 'scroll']
    .map(functionSource).join('\n'), c);
  return { events, pauses, firstReadFraction: () => firstRead, run: () => c.scroll({ tab: 5, direction: 'down', amount: 0.25 }), position: () => top };
}

await check('takeover scroll raises the exact Chrome tab after hold, before wheel, and restores the original scene', async () => {
  const h = foregroundScroll();
  assert.match(await h.run(), /✅ 已向下滚动/);
  assert.equal(h.position(), 200);
  assert.ok(h.events.indexOf('hold') < h.events.indexOf('activate'));
  assert.ok(h.events.indexOf('activate') < h.events.indexOf('wheel'));
  assert.ok(h.events.indexOf('wheel') < h.events.indexOf('restore'));
  assert.ok(h.events.includes('activates:true'), 'failed preparation must also restore an activation');
});

await check('non-takeover scrolling stays in the background and refuses covered windows', async () => {
  const visible = foregroundScroll({ takeover: false, front: 'Chrome' });
  await visible.run();
  assert.equal(visible.events.includes('activate'), false);
  assert.equal(visible.events.includes('restore'), false);
  const covered = foregroundScroll({ takeover: false });
  await assert.rejects(covered.run(), e => e.code === 'window_covered');
  assert.equal(covered.events.includes('activate'), false);
  assert.equal(covered.events.includes('wheel'), false);
});

await check('takeover scroll preserves hidden-user-tab and minimized-window protection', async () => {
  for (const info of [{ tabActive: false, windowId: 11 }, { minimized: true }]) {
    const h = foregroundScroll({ info });
    await assert.rejects(h.run(), e => ['tab_hidden', 'agent_window_minimized'].includes(e.code));
    assert.equal(h.events.includes('hold'), false);
    assert.equal(h.events.includes('activate'), false);
    assert.equal(h.events.includes('wheel'), false);
  }
  const agent = foregroundScroll({ info: { tabActive: false } });
  const out = await agent.run();
  assert.ok(agent.events.indexOf('select') < agent.events.indexOf('activate'));
  assert.ok(agent.events.indexOf('activate') < agent.events.indexOf('wheel'));
  assert.doesNotMatch(out, /没有把 Chrome 切到前面/);
});

// FOCUS4: CG order, the AX key window and the front app are facts for a wheel, not a veto; the wheel's own location
// (guardWheel before every notch) decides. The CG identity and the activation's own refusals still stop it.
await check('takeover scroll is not refused by CG order, the AX key window or another app in front (FOCUS4)', async () => {
  for (const activation of [{ targetOnTop: false }, { keyWindowIsTarget: false }, { axWindowMissing: true, keyWindowIsTarget: false },
    { frontmost: 'Terminal', frontmostPid: 555, targetOnTop: false }]) {
    const h = foregroundScroll({ activation });
    assert.match(await h.run(), /✅ 已向下滚动/, JSON.stringify(activation));
    assert.ok(h.events.indexOf('activate') < h.events.indexOf('wheel'), JSON.stringify(activation));
  }
});

await check('takeover scroll sends no wheel on failed CG identity, activation or stopped hold', async () => {
  for (const [activation, code] of [
    [{ cgWindow: null }, 'no_cg_window'],
    [{ error: 'focus_unconfirmed' }, 'focus_unconfirmed'],
  ]) {
    const h = foregroundScroll({ activation });
    await assert.rejects(h.run(), e => e.code === code);
    assert.equal(h.events.includes('wheel'), false);
    assert.ok(h.events.includes('restore'), 'partial activation must restore the original scene');
  }
  const stopped = foregroundScroll({ stop: true });
  await assert.rejects(stopped.run(), e => e.code === 'user_cancelled');
  assert.equal(stopped.events.includes('activate'), false);
  assert.equal(stopped.events.includes('wheel'), false);
});

async function closeHarness({ own = true, ownerAlive = true, realUser = false, lostHold = false } = {}) {
  let held = true, closeCalls = 0;
  const events = [];
  const target = { tabId: 10, windowId: 7, chromePid: 42, cgWindow: 70, url: 'https://fixture.test/' };
  const owner = own === null ? null : { ownerPid: own ? 1 : 2, openedAt: 1, windowId: 7, expectedUrl: target.url };
  const checkHold = async () => { if (lostHold) throw Object.assign(new Error('hold lost'), { code: 'task_hold_lost' }); assert.equal(held, true); };
  const context = vm.createContext({
    NATIVE_TARGETS: new Map(), Number, BridgeError, OWNER_PID: 1, process: { pid: 1 },
    getTab: async () => owner,
    isMine: r => r?.ownerPid === 1, pidAlive: () => ownerAlive, ownerName: () => 'other agent ',
    myEntry: async () => { events.push('owned'); },
    forgetOpenNavigation: async () => { events.push('observer-close'); },
    endTaskHold: async () => { throw Error('close must not release before sending'); },
    prepareNativeTarget: async () => ({ target, chromePid: 42, cgWindow: 70 }),
    inputAction: async (_label, prepare, action, options) => {
      assert.equal(options.nativeOnly, true); events.push('protected');
      try { await checkHold(); return await action(null, await prepare(), { check: checkHold }); }
      finally { events.push('release'); held = false; }
    },
    nativeMutation: async (ctx, _kind, send) => { await ctx.check(); return send(); },
    inputBoundaryCheck() {}, taskKey: () => '',
    checkTakeover: rec => ({ rec }), closeVerdict: rec => ({ ok: !!rec }),
    closeAgentTab: async (id, deps) => {
      events.push('check');
      if (own === null) return { ok: false, reason: 'not_agent_tab' };
      if (realUser) return { ok: false, reason: 'taken_over', why: 'user_viewing' };
      assert.equal(deps.verifiedOwnHold.tabId, id);
      await deps.verifiedOwnHold.check(); await deps.closeTab(id);
      return { ok: true, closed: true };
    },
    B: { closeTab: async () => { assert.equal(held, true); events.push('send'); closeCalls++; return { ok: true }; } },
    userClickedSince: async () => false,
    LEDGER: { live: () => [], apply() {} }, recoveryLine: () => '', TAKEOVER_WHY: { user_viewing: '用户在看' },
  });
  vm.runInContext(functionSource('closeTabTool'), context);
  let error = null;
  try { await context.closeTabTool({ tab: 10 }); } catch (e) { error = e; }
  return { events, closeCalls, error };
}

await check('closing our tab retains verified input hold through the actual close, then releases', async () => {
  const r = await closeHarness();
  assert.deepEqual(r.events, ['owned', 'protected', 'check', 'send', 'release', 'observer-close']);
  assert.equal(r.closeCalls, 1);
  assert.equal(r.error, null);
});

await check('foreign ownership, actual takeover, user tabs and lost hold still prevent close', async () => {
  const foreign = await closeHarness({ own: false });
  assert.equal(foreign.error.code, 'not_your_tab');
  assert.deepEqual(foreign.events, []);
  const userTab = await closeHarness({ own: null });
  assert.equal(userTab.error.code, 'not_agent_tab');
  assert.equal(userTab.closeCalls, 0);
  const takeover = await closeHarness({ realUser: true });
  assert.equal(takeover.error.code, 'taken_over');
  assert.equal(takeover.closeCalls, 0);
  const failed = await closeHarness({ lostHold: true });
  assert.equal(failed.error.code, 'task_hold_lost');
  assert.equal(failed.closeCalls, 0);
});

console.log(`scroll/close: ${passed} regression groups passed`);
