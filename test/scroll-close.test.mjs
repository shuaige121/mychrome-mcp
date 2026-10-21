/* Offline production-function regression tests. No Chrome, keyboard, or mouse. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { planScrollStep, chainDelta, aimClickable, MAX_SCROLL_BURSTS, BURST_MAX, FAR_BURST_MAX } from '../src/guard.js';

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

async function simulateScroll({ stalled = false, interrupted = false } = {}) {
  let top = 0, fallback = 0, statuses = 0, reads = 0;
  const wheels = [], pauses = [];
  const locate = () => {
    const loc = documentLoc(3720 - top, { height: 700, top });
    loc.rect.y = 3700 - top;
    loc.chain[0].maxTop = 3100;
    loc.hitOk = top === 3100;
    loc.visible = { x: 280, y: Math.max(0, loc.rect.y), width: 40, height: 40 };
    return loc;
  };
  const context = vm.createContext({
    Map, Set, Math, MAX_SCROLL_BURSTS, aimClickable, chainDelta,
    planScrollStep: (loc, opts) => planScrollStep(loc, { ...opts, rng: () => wheels.length % 2 ? 0.6 : 0.4 }),
    pointerTo: async () => {}, originFor: () => ({}),
    between: () => 500, sleep: async ms => { pauses.push(ms); },
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
    if (!stalled) top = Math.max(0, Math.min(3100, top + (req.dir === 'down' ? 1 : -1) * req.notches * 40));
    return { sent: req.notches };
  } };
  vm.runInContext(functionSource('scrollToTarget'), context);
  const action = () => context.scrollToTarget(session, { step() {} }, 1, 10, locate(), true);
  if (interrupted) await assert.rejects(action, /user interrupted/);
  else await action();
  return { wheels, pauses, fallback, statuses, reads, top };
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

await check('zero progress exhausts the scroller; interruption prevents any follow-up or fallback', async () => {
  const stalled = await simulateScroll({ stalled: true });
  assert.equal(stalled.wheels.length, 1);
  assert.equal(stalled.fallback, 1);
  const stopped = await simulateScroll({ interrupted: true });
  assert.equal(stopped.wheels.length, 1);
  assert.equal(stopped.reads, 0);
  assert.equal(stopped.fallback, 0);
});

async function closeHarness({ own = true, ownerAlive = true, realUser = false, releaseFails = false } = {}) {
  let held = true, closeCalls = 0;
  const events = [];
  class BridgeError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = vm.createContext({
    NATIVE_TARGETS: new Map(), Number, BridgeError,
    getTab: async () => own === null ? null : ({ ownerPid: own ? 1 : 2 }),
    isMine: r => r?.ownerPid === 1, pidAlive: () => ownerAlive, ownerName: () => 'other agent ',
    myEntry: async () => { events.push('owned'); },
    endTaskHold: async () => {
      events.push('release');
      if (releaseFails) throw Error('release failed');
      held = false;
    },
    closeAgentTab: async () => {
      events.push('check');
      if (own === null) return { ok: false, reason: 'not_agent_tab' };
      if (realUser) return { ok: false, reason: 'taken_over', why: 'user_viewing' };
      if (held) return { ok: false, reason: 'taken_over', transient: true };
      closeCalls++; return { ok: true, closed: true };
    },
    B: {}, userClickedSince: async () => false,
    LEDGER: { live: () => [], apply() {} }, recoveryLine: () => '', TAKEOVER_WHY: { user_viewing: '用户在看' },
  });
  vm.runInContext(functionSource('closeTabTool'), context);
  let error = null;
  try { await context.closeTabTool({ tab: 10 }); } catch (e) { error = e; }
  return { events, closeCalls, error };
}

await check('closing our tab releases our retained hold before the ordinary ownership checks', async () => {
  const r = await closeHarness();
  assert.deepEqual(r.events, ['owned', 'release', 'check']);
  assert.equal(r.closeCalls, 1);
  assert.equal(r.error, null);
});

await check('foreign and user tabs do not release our hold; actual takeover and release failures still prevent close', async () => {
  const foreign = await closeHarness({ own: false });
  assert.equal(foreign.error.code, 'not_your_tab');
  assert.deepEqual(foreign.events, []);
  const userTab = await closeHarness({ own: null });
  assert.equal(userTab.error.code, 'not_agent_tab');
  assert.deepEqual(userTab.events, ['check']);
  const takeover = await closeHarness({ realUser: true });
  assert.equal(takeover.error.code, 'taken_over');
  assert.equal(takeover.closeCalls, 0);
  const failed = await closeHarness({ releaseFails: true });
  assert.match(failed.error.message, /release failed/);
  assert.deepEqual(failed.events, ['owned', 'release']);
  assert.equal(failed.closeCalls, 0);
});

console.log(`scroll/close: ${passed} regression groups passed`);
