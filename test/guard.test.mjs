/* Unit tests for src/guard.js — the click guards.
 *
 * These cover the two failure modes that cannot be staged on a real desktop
 * from inside this session:
 *   - a foreign application's window covering the target point;
 *   - the physical mouse being moved during the travel animation.
 * Both are driven here from synthetic data / stubbed side effects.
 *
 * Run: node test/guard.test.mjs
 */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import {
  pickTopWindowOwner, isChromeOwner, distance, didClickRegister, guardedClick,
  checkViewportGeometry, pickTopWindow, targetWindowOnTop,
  aimBlockers, planScrollStep, chainDelta, typingSegments, typedCount, keyupCount, runInputAction, releaseKept, userStopMessage,
  mergeInterrupted, CURSOR_TOLERANCE_PT, MAX_WINDOW_LAYER, MIN_WINDOW_ALPHA, BURST_MIN, BURST_MAX
} from '../src/guard.js';
import { viewportOrigin, intersectRect, rectToScreenRect, squareToScreenRect } from '../src/coords.js';
import { BridgeError, UserInterrupted, openInputSession, sessionError } from '../src/bridge.js';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// These check the built-in timing defaults; the user's recorded habits (test/habits.test.mjs) stay out.
process.env.CHROME_BRIDGE_HABITS = 'off';

let passed = 0;
function t(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
async function ta(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

const box = (x, y, w, h) => ({ x, y, w, h });

/* ------------------------------------------------ pickTopWindowOwner ---- */

console.log('guard.js — window owner at the click point');

t('the front-most normal window wins', () => {
  const list = [
    { owner: 'kitty', layer: 0, alpha: 1, bounds: box(785, 102, 892, 771) },
    { owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }
  ];
  assert.equal(pickTopWindowOwner(list), 'kitty');
});

t('Chrome in front of a terminal is Chrome', () => {
  const list = [
    { owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) },
    { owner: 'kitty', layer: 0, alpha: 1, bounds: box(785, 102, 892, 771) }
  ];
  assert.equal(pickTopWindowOwner(list), 'Google Chrome');
});

t('the Dock is ignored — its window is the size of the whole display', () => {
  // Real capture from this machine, `cgevent windowsat 1011 232`:
  // the Dock ("程序坞") owns a 1920x1080 window at layer 20 covering the whole
  // main display. Trusting it would veto every click on that screen.
  const list = [
    { owner: '程序坞', pid: 655, layer: 20, alpha: 1, bounds: box(0, 0, 1920, 1080) },
    { owner: 'Google Chrome', pid: 41064, layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }
  ];
  assert.equal(pickTopWindowOwner(list), 'Google Chrome');
});

t('the desktop picture and desktop icons (negative layers) are ignored', () => {
  const list = [
    { owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) },
    { owner: 'Finder', layer: -2147483603, alpha: 1, bounds: box(0, 0, 1920, 1080) },
    { owner: 'Dock', layer: -2147483623, alpha: 1, bounds: box(0, 0, 1920, 1080) }
  ];
  assert.equal(pickTopWindowOwner(list), 'Google Chrome');
});

t('fully transparent windows are ignored', () => {
  const list = [
    { owner: 'Notification Centre', layer: 0, alpha: 0, bounds: box(0, 0, 1920, 1080) },
    { owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }
  ];
  assert.equal(pickTopWindowOwner(list), 'Google Chrome');
  assert.equal(MIN_WINDOW_ALPHA, 0.05);
});

t('degenerate 1-point windows are ignored', () => {
  const list = [
    { owner: 'SomeAgent', layer: 0, alpha: 1, bounds: box(1000, 200, 1, 1) },
    { owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }
  ];
  assert.equal(pickTopWindowOwner(list), 'Google Chrome');
});

t('a floating panel below the Dock layer still counts as an occluder', () => {
  const list = [
    { owner: 'WezTerm', layer: MAX_WINDOW_LAYER, alpha: 1, bounds: box(900, 150, 600, 400) },
    { owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }
  ];
  assert.equal(pickTopWindowOwner(list), 'WezTerm');
});

t('an empty or non-array list means "cannot tell", not "nothing there"', () => {
  assert.equal(pickTopWindowOwner([]), null);
  assert.equal(pickTopWindowOwner(null), null);
  assert.equal(pickTopWindowOwner(undefined), null);
  assert.equal(pickTopWindowOwner([{ owner: 'Window Server', layer: 0, alpha: 1 }]), null);
});

t('isChromeOwner accepts Chrome and nothing else', () => {
  assert.equal(isChromeOwner('Google Chrome'), true);
  assert.equal(isChromeOwner('  Google Chrome  '), true);
  assert.equal(isChromeOwner('Google Chrome Canary'), true);
  assert.equal(isChromeOwner('kitty'), false);
  assert.equal(isChromeOwner('程序坞'), false);
  assert.equal(isChromeOwner('Google Chromecast Helper'), false); // \b, not a prefix match
  assert.equal(isChromeOwner(null), false);
  assert.equal(isChromeOwner(''), false);
});

/* ------------------------------------------------------- distance ------ */

console.log('\nguard.js — cursor distance');

t('distance is euclidean, and unknown positions are infinitely far', () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(distance(null, { x: 1, y: 1 }), Infinity);
  assert.equal(distance({ x: NaN, y: 0 }, { x: 0, y: 0 }), Infinity);
});

/* --------------------------------------------------- didClickRegister -- */

console.log('\nguard.js — was the click observable?');

t('a URL change is proof', () => {
  const r = didClickRegister({ hrefChanged: true, activeIsTarget: false, hadFocusBefore: false });
  assert.equal(r.observed, true);
  assert.match(r.reasons.join(''), /地址/);
});

t('focus moving onto the target is proof', () => {
  const r = didClickRegister({ hrefChanged: false, activeIsTarget: true, hadFocusBefore: false });
  assert.equal(r.observed, true);
  assert.match(r.reasons.join(''), /焦点/);
});

t('focus that was already on the target before the click is NOT proof (codex #5)', () => {
  const r = didClickRegister({ hrefChanged: false, activeIsTarget: true, hadFocusBefore: true });
  assert.equal(r.observed, false);
  assert.deepEqual(r.reasons, []);
});

t('an onclick / role=button target is no longer evidence of anything (codex #5)', () => {
  // The old rule excused such targets; a click that never happened then
  // still printed ✅. Passing the old flag must change nothing.
  const r = didClickRegister({ hrefChanged: false, activeIsTarget: false, targetInteractive: true });
  assert.equal(r.observed, false);
});

t('THE REGRESSION: a plain <a href> that did not navigate is NOT a success', () => {
  // 2026-09-04: click on <a href="/zh/services/"> returned ✅ with correct
  // coordinates, but the page never navigated and focus never moved.
  const r = didClickRegister({ hrefChanged: false, activeIsTarget: false, hadFocusBefore: false });
  assert.equal(r.observed, false);
  assert.deepEqual(r.reasons, []);
});

/* -------------------------------------------- checkViewportGeometry ---- */

console.log('\nguard.js — is the window→viewport model true for this window?');

t('an ordinary macOS Chrome window passes', () => {
  // Measured live 2026-09-04: bounds 240,30 1496x938; viewport 1496x761.
  const view = { innerWidth: 1496, innerHeight: 761, outerWidth: 1496, outerHeight: 938 };
  const o = viewportOrigin({ left: 240, top: 30, width: 1496, height: 938 }, view);
  assert.equal(o.toolbarHeight, 177);
  assert.equal(checkViewportGeometry(o, view).ok, true);
});

t('THE REGRESSION: DevTools docked right is refused, not clicked', () => {
  // Measured live 2026-09-05: window 1496x938 at (-87,30) with DevTools docked;
  // viewport 1110x753 => sideInset 193, toolbarHeight collapses to 0, and the
  // computed point lands in the tab strip.
  const view = { innerWidth: 1110, innerHeight: 753, outerWidth: 1496, outerHeight: 938 };
  const o = viewportOrigin({ left: -87, top: 30, width: 1496, height: 938 }, view);
  assert.equal(o.sideInset, 193);
  assert.equal(o.toolbarHeight, 0);
  const r = checkViewportGeometry(o, view);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'side_inset');
  assert.match(r.message, /已放弃点击/);
  assert.match(r.message, /DevTools/);
});

t('DevTools docked at the bottom is refused too', () => {
  const view = { innerWidth: 1496, innerHeight: 300, outerWidth: 1496, outerHeight: 938 };
  const o = viewportOrigin({ left: 240, top: 30, width: 1496, height: 938 }, view);
  assert.equal(o.sideInset, 0);
  assert.equal(o.toolbarHeight, 638);
  const r = checkViewportGeometry(o, view);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'toolbar_tall');
});

t('a fullscreen window (no chrome at all) is allowed through', () => {
  const view = { innerWidth: 1496, innerHeight: 938, outerWidth: 1496, outerHeight: 938 };
  const o = viewportOrigin({ left: 0, top: 0, width: 1496, height: 938 }, view);
  assert.equal(o.toolbarHeight, 0);
  assert.equal(checkViewportGeometry(o, view).ok, true);
});

/* ------------------------------------------------------- guardedClick -- */

console.log('\nguard.js — guardedClick sequence');

/** Stub side effects. `positions` is the queue mousepos() reads from. */
function makeOps({ windows = [], positions = [], pressThrows = null, pressDrift = 0 } = {}) {
  const calls = { windowsAt: 0, move: [], mousepos: 0, press: 0 };
  const queue = positions.slice();
  let last = null;
  return {
    calls,
    ops: {
      windowsAt: async () => { calls.windowsAt++; return windows; },
      move: async (p, ms) => { calls.move.push(ms); return { durationMs: ms ?? 318 }; },
      mousepos: async () => { calls.mousepos++; last = queue.length ? queue.shift() : last; return last; },
      press: async (p) => {
        calls.press++;
        if (pressThrows && calls.press <= pressThrows.times) {
          const e = new Error(pressThrows.message || 'cursor moved');
          e.code = pressThrows.code;
          throw e;
        }
        return { afterX: p.x + pressDrift, afterY: p.y, drift: pressDrift };
      }
    }
  };
}

const POINT = { x: 1011.25, y: 232.1 };

await ta('happy path: one move, cursor on target, one press', async () => {
  const { ops, calls } = makeOps({
    windows: [{ owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }],
    positions: [{ x: 1011.25, y: 232.1 }]
  });
  const r = await guardedClick({ point: POINT, ops });
  assert.equal(r.owner, 'Google Chrome');
  assert.equal(r.retried, false);
  assert.equal(calls.move.length, 1);
  assert.equal(calls.press, 1);
  assert.equal(r.moveMs, 318);
  assert.equal(r.drift, 0);
});

await ta('CASE 2: a foreign window over the point aborts before any movement', async () => {
  const { ops, calls } = makeOps({
    windows: [
      { owner: 'kitty', layer: 0, alpha: 1, bounds: box(785, 102, 892, 771) },
      { owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }
    ],
    positions: [POINT]
  });
  await assert.rejects(() => guardedClick({ point: POINT, ops }), (e) => {
    assert.equal(e.code, 'window_not_chrome');
    assert.match(e.message, /kitty/);
    assert.match(e.message, /已放弃点击/);
    return true;
  });
  assert.equal(calls.move.length, 0, 'must not move the mouse at all');
  assert.equal(calls.press, 0, 'must not press');
});

await ta('an unidentifiable top window does not block the click', async () => {
  const { ops } = makeOps({ windows: [], positions: [POINT] });
  const r = await guardedClick({ point: POINT, ops });
  assert.equal(r.owner, null);
});

await ta('CASE 3a: cursor displaced after the path -> re-run the path once, then press', async () => {
  const { ops, calls } = makeOps({
    windows: [{ owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }],
    // First readback is the observed failure's 90-point miss; the retry lands.
    positions: [{ x: 1026.0, y: 320.9 }, { x: 1011.0, y: 232.0 }]
  });
  const r = await guardedClick({ point: POINT, ops });
  assert.equal(r.retried, true);
  assert.deepEqual(calls.move, [null, 120], 'retry path is the short one');
  assert.equal(calls.press, 1);
});

await ta('CASE 3b: displaced twice -> no click at all, ok=false', async () => {
  const { ops, calls } = makeOps({
    windows: [{ owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }],
    positions: [{ x: 1026.0, y: 320.9 }, { x: 1100.0, y: 400.0 }]
  });
  await assert.rejects(() => guardedClick({ point: POINT, ops }), (e) => {
    assert.equal(e.code, 'mouse_interrupted');
    assert.equal(e.message, '❌ 鼠标在移动过程中被其他输入打断，未点击。');
    return true;
  });
  assert.equal(calls.press, 0, 'never pressed');
  assert.equal(calls.move.length, 2, 'exactly one retry');
});

await ta('a miss of exactly the tolerance is accepted, one point more is not', async () => {
  const okOps = makeOps({
    windows: [{ owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }],
    positions: [{ x: POINT.x + CURSOR_TOLERANCE_PT, y: POINT.y }]
  });
  const r = await guardedClick({ point: POINT, ops: okOps.ops });
  assert.equal(r.retried, false);

  const badOps = makeOps({
    windows: [{ owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }],
    positions: [{ x: POINT.x + CURSOR_TOLERANCE_PT + 0.01, y: POINT.y },
                { x: POINT.x + CURSOR_TOLERANCE_PT + 0.01, y: POINT.y }]
  });
  await assert.rejects(() => guardedClick({ point: POINT, ops: badOps.ops }),
    (e) => e.code === 'mouse_interrupted');
});

await ta("the helper's own last-moment cursor check is treated the same way", async () => {
  // press() throws cursor_moved on the first attempt only: the mouse moved in
  // the few ms between our readback and the helper's.
  const { ops, calls } = makeOps({
    windows: [{ owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }],
    positions: [POINT, POINT],
    pressThrows: { code: 'cursor_moved', times: 1 }
  });
  const r = await guardedClick({ point: POINT, ops });
  assert.equal(r.retried, true);
  assert.equal(calls.press, 2);
});

await ta('a real helper failure is not swallowed by the retry loop', async () => {
  const { ops, calls } = makeOps({
    windows: [{ owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }],
    positions: [POINT, POINT],
    pressThrows: { code: 'no_accessibility', times: 2, message: 'no accessibility' }
  });
  await assert.rejects(() => guardedClick({ point: POINT, ops }), (e) => e.code === 'no_accessibility');
  assert.equal(calls.press, 1, 'stops at the first real error');
});

await ta('post-click drift is reported back to the caller', async () => {
  const { ops } = makeOps({
    windows: [{ owner: 'Google Chrome', layer: 0, alpha: 1, bounds: box(240, 30, 1496, 938) }],
    positions: [POINT],
    pressDrift: 90
  });
  const r = await guardedClick({ point: POINT, ops });
  assert.equal(r.drift, 90);
  assert.equal(r.cursorAfter.x, POINT.x + 90);
});

/* ------------------------------------------- scroll to the target (D1) -- */

console.log('\nguard.js — which wheel burst brings the target into view');

const VIEW = { innerWidth: 1200, innerHeight: 800 };
const docEntry = (o = {}) => ({
  sig: 'document', document: true, clip: { x: 0, y: 0, width: 1200, height: 800 },
  scrollableY: true, scrollTop: 0, maxTop: 5000,
  wheel: { down: { x: 600, y: 400 }, up: { x: 600, y: 400 } }, ...o
});
const inner = (o = {}) => ({
  sig: 'div#list', clip: { x: 100, y: 200, width: 400, height: 300 },
  scrollableY: true, scrollTop: 0, maxTop: 900,
  wheel: { down: { x: 300, y: 350 }, up: { x: 300, y: 350 } }, ...o
});
const mkLoc = (aim, chain) => ({ aim, chain, view: VIEW });
const half = () => 0.5;

t('aim inside the viewport comfort zone and every clip box: done, no burst', () => {
  assert.deepEqual(planScrollStep(mkLoc({ x: 300, y: 400 }, [docEntry()]), { rng: half }), { done: true });
  assert.deepEqual(aimBlockers(mkLoc({ x: 300, y: 300 }, [inner(), docEntry()]), half), []);
});

t('target three screens down: the document scrolls down, in a 3–8 notch burst', () => {
  const s = planScrollStep(mkLoc({ x: 300, y: 2500 }, [docEntry()]), { rng: half });
  assert.equal(s.sig, 'document');
  assert.equal(s.dir, 'down');
  // goal = 80 + 640·0.5 = 400 ⇒ need 2100
  assert.equal(s.need, 2100);
  assert.ok(s.notches >= BURST_MIN && s.notches <= BURST_MAX, `notches ${s.notches}`);
  assert.deepEqual(s.point, { x: 600, y: 400 });
});

t('the bottom 10% of the viewport is not comfortable: scroll, sized by the measured px per notch', () => {
  const s = planScrollStep(mkLoc({ x: 300, y: 790 }, [docEntry()]), { rng: half, pxPerNotch: 100 });
  assert.equal(s.dir, 'down');
  assert.equal(s.need, 390);
  assert.equal(s.notches, 4);
  const up = planScrollStep(mkLoc({ x: 300, y: 30 }, [docEntry({ scrollTop: 500 })]), { rng: half });
  assert.equal(up.dir, 'up');
  assert.equal(up.need, 370);
});

t('landing spot varies from burst plan to burst plan (not always centred)', () => {
  const goals = new Set();
  for (let i = 0; i < 20; i++) {
    const r = i / 19;
    const s = planScrollStep(mkLoc({ x: 300, y: 2500 }, [docEntry()]), { rng: () => r });
    goals.add(Math.round((2500 - s.need) / 8));
  }
  assert.ok(goals.size >= 15, `only ${goals.size} distinct goals`);
});

t('aim hidden by an inner scroller while the viewport is fine: that scroller scrolls', () => {
  const s = planScrollStep(mkLoc({ x: 300, y: 650 }, [inner(), docEntry()]), { rng: half });
  assert.equal(s.sig, 'div#list');
  assert.equal(s.dir, 'down');
  assert.deepEqual(s.point, { x: 300, y: 350 });
});

t('CX#11: a scroller that itself starts below the fold — the OUTERMOST box moves first', () => {
  // inner scroller at y 2400..2700, target inside it at 2900: both hide it.
  const deep = inner({ clip: { x: 100, y: 2400, width: 400, height: 300 }, wheel: { down: null, up: null } });
  const loc = mkLoc({ x: 300, y: 2900 }, [deep, docEntry()]);
  assert.equal(aimBlockers(loc, half).length, 2);
  const s = planScrollStep(loc, { rng: half });
  assert.equal(s.sig, 'document');
  // Once the page has brought the scroller on screen, the inner box is next.
  const later = mkLoc({ x: 300, y: 600 }, [inner({ clip: { x: 100, y: 200, width: 400, height: 300 } }), docEntry({ scrollTop: 2200 })]);
  assert.equal(planScrollStep(later, { rng: half }).sig, 'div#list');
});

t('target deep inside an on-screen list: only the list scrolls, the page stays put', () => {
  // list shows y 200..500 with 900 px more below; the target sits at 1400 in its content
  const loc = mkLoc({ x: 300, y: 1400 }, [inner(), docEntry()]);
  assert.deepEqual(aimBlockers(loc, half).map(b => b.index), [0], 'the document must not be a blocker');
  assert.equal(planScrollStep(loc, { rng: half }).sig, 'div#list');
  // …unless the list cannot bring it that far: 100 px of range left.
  const short = mkLoc({ x: 300, y: 1400 }, [inner({ maxTop: 100 }), docEntry()]);
  assert.deepEqual(aimBlockers(short, half).map(b => b.index), [0, 1]);
  assert.equal(planScrollStep(short, { rng: half }).sig, 'document');
});

t('CX#11: target inside the viewport comfort zone but clipped by its scroller is NOT done', () => {
  const loc = mkLoc({ x: 300, y: 560 }, [inner(), docEntry()]);
  assert.notEqual(planScrollStep(loc, { rng: half }).done, true);
});

t('unreachable cases fall back instead of guessing', () => {
  // horizontal: only a vertical wheel is simulated
  assert.equal(planScrollStep(mkLoc({ x: 1500, y: 400 }, [docEntry()])).unreachable, 'horizontal');
  // overflow:hidden box clips the aim: no wheel scrolls it
  const hidden = inner({ scrollableY: false, wheel: null });
  assert.equal(planScrollStep(mkLoc({ x: 300, y: 650 }, [hidden, docEntry()])).unreachable, 'not_scrollable');
  // no pointer spot routes the wheel to the box
  const noSpot = inner({ wheel: { down: null, up: null } });
  assert.equal(planScrollStep(mkLoc({ x: 300, y: 650 }, [noSpot, docEntry()])).unreachable, 'no_pointer_spot');
  // already at the end of its range
  const atEnd = docEntry({ scrollTop: 5000 });
  assert.equal(planScrollStep(mkLoc({ x: 300, y: 2500 }, [atEnd])).unreachable, 'at_limit');
});

t('a box that did not move on the last burst is not tried again', () => {
  const loc = mkLoc({ x: 300, y: 2500 }, [docEntry()]);
  const first = planScrollStep(loc, { rng: half });
  assert.equal(first.key, '0:document');
  assert.equal(planScrollStep(loc, { rng: half, exhausted: new Set([first.key]) }).unreachable, 'no_progress');
});

t('A2: a header at y=30 on a page at the top (or a short page) is clicked where it is, no fallback', () => {
  const hdr = (chain) => ({ ...mkLoc({ x: 300, y: 30 }, chain), visible: { x: 250, y: 18, width: 100, height: 24 }, hitOk: true });
  assert.deepEqual(planScrollStep(hdr([docEntry()]), { rng: half }), { done: true, edge: true });
  assert.deepEqual(planScrollStep(hdr([docEntry({ maxTop: 0, scrollableY: false })]), { rng: half }), { done: true, edge: true });
  // …but not when it is covered, or when its aim is not inside its visible part.
  assert.equal(planScrollStep({ ...hdr([docEntry()]), hitOk: false }, { rng: half }).unreachable, 'at_limit');
  assert.equal(planScrollStep({ ...hdr([docEntry()]), visible: null }, { rng: half }).unreachable, 'at_limit');
  // A box that stopped moving the target (no_progress) with the aim clickable: done as well.
  const mid = hdr([docEntry({ scrollTop: 400 })]);
  const first = planScrollStep(mid, { rng: half });
  assert.equal(first.dir, 'up');
  assert.deepEqual(planScrollStep(mid, { rng: half, exhausted: new Set([first.key]) }), { done: true, edge: true });
});

t('A2: a target in a position:fixed layer is not wheeled for by the document (movesAim:false)', () => {
  const fixed = { ...mkLoc({ x: 300, y: 30 }, [docEntry({ scrollTop: 3000, movesAim: false })]),
    visible: { x: 250, y: 18, width: 100, height: 24 }, hitOk: true };
  assert.deepEqual(aimBlockers(fixed, half), [], 'the comfort band applied to a box that cannot move the target');
  assert.deepEqual(planScrollStep(fixed, { rng: half }), { done: true });
  // A fixed target outside the viewport: nothing can bring it in.
  const off = mkLoc({ x: 300, y: 900 }, [docEntry({ scrollTop: 3000, movesAim: false })]);
  assert.equal(planScrollStep(off, { rng: half }).unreachable, 'not_scrollable');
});

t('A2: a genuinely clipped target at a scroll limit still falls back', () => {
  const clipped = { ...mkLoc({ x: 300, y: 650 }, [inner({ scrollTop: 900 }), docEntry()]),
    visible: null, hitOk: false };
  assert.equal(planScrollStep(clipped, { rng: half }).unreachable, 'at_limit');
});

t('chainDelta measures one box between two locates, and refuses a different box', () => {
  const a = mkLoc({ x: 0, y: 0 }, [docEntry({ scrollTop: 100 })]);
  const b = mkLoc({ x: 0, y: 0 }, [docEntry({ scrollTop: 340 })]);
  assert.equal(chainDelta(a, b, 0), 240);
  assert.equal(chainDelta(a, mkLoc({ x: 0, y: 0 }, [inner()]), 0), null);
});

/* ------------------------------------------------------------- typing -- */

console.log('\nguard.js — input_mode: keys by default, explicit paste');

t('input_mode paste explicitly sends any text as one paste, short ASCII included', () => {
  for (const x of ['hi', 'Hello, World! 123', 'a'.repeat(500), 'Hi, 你好 ok!', 'ok 👍']) {
    assert.deepEqual(typingSegments(x, 'paste'), [{ mode: 'paste', text: x }]);
  }
});

t('default and explicit keys type ASCII in order and refuse unsupported text without paste fallback', () => {
  for (const mode of [undefined, 'keys']) {
    assert.deepEqual(typingSegments('Hello, World!\n\tend', mode), [{ mode: 'type', text: 'Hello, World!\n\tend' }]);
    for (const text of ['Hi, 你好 ok! café', '你好', '👍a', 'x\u0000y']) {
      assert.throws(() => typingSegments(text, mode), e => e.code === 'unsupported_key_text');
    }
  }
  // what the helper reports as typed, and the key-ups a page sees
  assert.equal(typedCount('a\r\nb\tc'), 5);
  assert.equal(keyupCount('a\r\nb\tc'), 8);
});

/* -------------------------------------------------- window at a point -- */

console.log('\nguard.js — is the target window on top at the wheel point?');

t('target window on top: pid and bounds must both match; Chrome\'s status bubble is skipped', () => {
  const B = { x: 1940, y: 959, w: 1688, h: 1037 };
  const chrome = { owner: 'Google Chrome', pid: 500, layer: 0, alpha: 1, bounds: B };
  const bubble = { owner: 'Google Chrome', pid: 500, layer: 0, alpha: 1, bounds: { x: 1940, y: 1970, w: 300, h: 22 } };
  assert.equal(targetWindowOnTop([bubble, chrome], 500, B), true);
  assert.equal(pickTopWindow([bubble, chrome]).bounds.h, 22, 'without the pid rule the bubble would win');
  assert.equal(targetWindowOnTop([{ owner: 'kitty', pid: 9, layer: 0, alpha: 1, bounds: B }, chrome], 500, B), false);
  const otherChromeWin = { ...chrome, bounds: { x: 0, y: 30, w: 1920, h: 970 } };
  assert.equal(targetWindowOnTop([otherChromeWin, chrome], 500, B), false);
  assert.equal(targetWindowOnTop([], 500, B), false);
});

/* ---------------------------------------------------------- coords.js -- */

console.log('\ncoords.js — rects for the input helper');

t('intersection, and viewport rects converted to screen points (with page zoom)', () => {
  assert.deepEqual(intersectRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 80, width: 100, height: 100 }),
    { x: 50, y: 80, width: 50, height: 20 });
  assert.equal(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 }), null);
  const o = { originX: 100, originY: 148, scale: 1.5 };
  assert.deepEqual(rectToScreenRect({ x: 200, y: 300, width: 100, height: 50 }, o), { x: 400, y: 598, w: 150, h: 75 });
  assert.deepEqual(squareToScreenRect({ x: 10, y: 10 }, 20, { originX: 0, originY: 0, scale: 1 }), { x: 0, y: 0, w: 20, h: 20 });
});

/* ----------------------------------------- one locked input action (§3) -- */

console.log('\nguard.js — runInputAction outcomes (injected side effects)');

const PREP = { chromePid: 42, cgWindow: 7, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, touchesScene: true,
  target: { tabId: 5 } };

/**
 * A scripted session. `status` / `warp` give the replies to those requests
 * (functions of the request); `interrupted` is the sticky flag as bridge.js
 * exposes it. Requests and close() are written to `log` once attached.
 */
function fakeSession({ begin = { ok: true, inputMonitor: true }, end = { ok: true, op: 'end', interrupted: null },
                       status = () => ({ ok: true, interrupted: null }), warp = () => ({ ok: true }) } = {}) {
  const sent = [];
  return {
    sent, closed: 0, log: null, interrupted: end.interrupted,
    async request(o) {
      sent.push(o.op);
      if (o.op === 'begin') return begin;
      if (o.op === 'status') { this.log?.push('status'); return status(o); }
      if (o.op === 'warp') {
        const r = warp(o);
        if (r instanceof Error) throw r;
        if (r.ok !== false && !r.interrupted) this.log?.push(`warp ${o.to.x},${o.to.y}`);
        return r;
      }
      return { ok: true };
    },
    async close() { this.closed++; this.log?.push('close'); return end; }
  };
}
/** `acted`: a boolean, or a function of the log so far (input after some point). */
function fakeOps({ prepare = async () => PREP, session = fakeSession(), acted = false, scene = { appPid: 1 },
                   restoreReply = { ok: true }, now = () => 1000 } = {}) {
  const log = [];
  const calls = { restoreScene: [], restoreApp: [] };
  if (session) session.log = log;
  return {
    log, session, calls,
    ops: {
      waitForUserIdle: async () => { log.push('idle'); return 0; },
      now,
      snapshotScene: async () => { log.push('snapshot'); return scene; },
      mousepos: async () => { log.push('mousepos'); return { x: 5, y: 6 }; },
      prepare: async () => { log.push('prepare'); return prepare(); },
      userActedSince: async () => { log.push('acted?'); return typeof acted === 'function' ? acted(log) : acted; },
      openSession: async () => { log.push('open'); return session; },
      restoreScene: async (sc, o) => { log.push('restore'); calls.restoreScene.push(o); return restoreReply; },
      restoreApp: async (sc, o) => { log.push(`restoreApp ${sc.appPid}`); calls.restoreApp.push(o); return { ok: true, appFrontmost: true }; },
      warp: async (p) => { log.push(`cgwarp ${p.x},${p.y}`); },
      currentUrl: async () => { log.push('url?'); return 'https://a.test/after'; },
      noteNavigation: async (prep, url) => { log.push(`note ${url}`); }
    }
  };
}
const pulledBack = (log) => log.some(x => x === 'restore' || x.startsWith('warp') || x.startsWith('cgwarp'));

await ta('success: idle wait first, then scene, prepare, session; scene and pointer restored while the session still watches', async () => {
  const f = fakeOps();
  const r = await runInputAction(f.ops, async (s, prep, ctx) => { f.log.push('action'); ctx.step('点击了 [3]'); return 'done'; });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.out, 'done');
  assert.deepEqual(f.log, ['idle', 'snapshot', 'mousepos', 'prepare', 'acted?', 'open', 'action',
    'url?', 'status', 'note https://a.test/after', 'status', 'restore', 'warp 5,6', 'close']);
  assert.deepEqual(f.session.sent, ['begin', 'status', 'status', 'handBack', 'warp']);
  assert.equal(f.session.closed, 1);
});

await ta('CX#9: the user interrupts (key) → session ended, NO scene restore, NO warp; only their app handed back', async () => {
  const f = fakeOps();
  const r = await runInputAction(f.ops, async (s, prep, ctx) => {
    ctx.step('点击了 [3]');
    const e = new UserInterrupted({ kind: 'key', t: 1234 }, { ok: false, error: 'interrupted', typed: 4, released: ['shift'] });
    throw e;
  });
  assert.equal(r.outcome, 'user');
  assert.equal(f.session.closed, 1);
  assert.ok(!pulledBack(f.log), `pulled the user back: ${f.log}`);
  assert.ok(!f.log.some(x => x.startsWith('note')), 'recorded a navigation after a user interruption');
  assert.ok(f.log.includes('restoreApp 1'), 'A3/A4: the front was not handed back to the user\'s app');
  assert.equal(r.appRestored, true);
  const msg = userStopMessage(r);
  assert.match(msg, /你开始操作了，已停止；完成了：点击了 \[3\]；逐键输入了 4 个字符/);
  assert.match(msg, /已把前台切回你原来用的 App（光标和 Chrome 窗口没有动）；你按下的第一个键可能已经进了 agent 的网页/);
});

await ta('A3/A4: the front is handed back only when our activation left Chrome in front and the user did not click', async () => {
  const run = async (o, kind = 'key') => {
    const f = fakeOps(o);
    const r = await runInputAction(f.ops, async () => { throw new UserInterrupted({ kind, t: 1 }); });
    assert.ok(!pulledBack(f.log), `pulled back: ${f.log}`);
    return [r, f.log.some(x => x.startsWith('restoreApp'))];
  };
  assert.equal((await run({}, 'button'))[1], false, 'a click into Chrome is the user\'s choice');
  assert.equal((await run({}, 'move'))[1], true);
  assert.equal((await run({ scene: { appPid: 42 } }))[1], false, 'the user was in Chrome itself');
  assert.equal((await run({ prepare: async () => ({ ...PREP, touchesScene: false }) }))[1], false, 'scroll never activated Chrome');
  const [r] = await run({}, 'button');
  assert.match(userStopMessage(r), /没有把光标和前台窗口拉回原处/);
});

await ta('codex2-1: a move that becomes a click into Chrome (button flag after kind move) → the front is NOT handed back', async () => {
  const run = async (intr) => {
    const f = fakeOps();
    const r = await runInputAction(f.ops, async () => { throw new UserInterrupted(intr); });
    assert.equal(r.outcome, 'user');
    return f;
  };
  let f = await run({ kind: 'move', t: 1, epoch: 777, button: true });
  assert.ok(!f.log.some(x => x.startsWith('restoreApp')), `handed back over the user's click: ${f.log}`);
  // Move only: handed back, and chromectl is told since when a click counts as the user's.
  f = await run({ kind: 'move', t: 1, epoch: 777 });
  assert.ok(f.log.includes('restoreApp 1'));
  assert.deepEqual(f.calls.restoreApp, [{ noClickSince: 777 }]);
  // The click seen only by a later reply (end) also counts.
  const session = fakeSession({ end: { ok: true, op: 'end', interrupted: { kind: 'move', t: 1, epoch: 5, button: true } } });
  const g = fakeOps({ session });
  await runInputAction(g.ops, async () => { throw new UserInterrupted({ kind: 'move', t: 1, epoch: 5 }); });
  assert.ok(!g.log.some(x => x.startsWith('restoreApp')), `end reply's button flag ignored: ${g.log}`);
  assert.deepEqual(mergeInterrupted([{ kind: 'move', epoch: 9 }, null, { kind: 'button', epoch: 12 }]),
    { kind: 'move', epoch: 9, button: true });
  assert.equal(mergeInterrupted([null, { t: 1 }]), null);
  // Input seen before begin (idle counter): any click after the idle wait is the user's.
  let clock = 1000;
  const h = fakeOps({ acted: true, now: () => clock++ });
  await runInputAction(h.ops, async () => {});
  assert.deepEqual(h.calls.restoreApp, [{ noClickSince: 1000 }], 'the click baseline is not the end of the idle wait');
});

await ta('codex2-2: input seen by the re-check right before the restore → no restore, no warp; the restore baseline is the last clean status', async () => {
  let n = 0;
  const session = fakeSession({ status: () => (++n === 1 ? { ok: true, interrupted: null }
    : { ok: true, interrupted: { kind: 'key', t: 9, epoch: 1234 } }) });
  let clock = 1000;
  const f = fakeOps({ session, now: () => clock++ });
  f.ops.noteNavigation = async (prep, url) => { f.log.push(`note ${url}`); };
  const r = await runInputAction(f.ops, async () => 'clicked');
  assert.deepEqual([r.outcome, r.late], ['user', true]);
  assert.ok(!pulledBack(f.log), `restored after the user took over: ${f.log}`);
  assert.deepEqual(f.calls.restoreApp, [{ noClickSince: 1234 }], 'only the front handed back, guarded by the click check');
  // Without input: the restore is told the time of the last clean status.
  const g = fakeOps({ now: () => clock++ });
  let statusAt = null;
  const orig = g.session.request.bind(g.session);
  g.session.request = async (o, x) => { if (o.op === 'status' && statusAt == null) statusAt = clock - 1; return orig(o, x); };
  await runInputAction(g.ops, async () => 'clicked');
  assert.equal(g.calls.restoreScene.length, 1);
  assert.equal(g.calls.restoreScene[0].since, statusAt, 'restoreScene not given the status time as --since');
});

await ta('codex2-2: chromectl saw input before activating (activated:false) → the front is handed back only through the guarded path', async () => {
  const f = fakeOps({ restoreReply: { ok: true, userInput: true, activated: false, appFrontmost: false } });
  const r = await runInputAction(f.ops, async () => 'clicked');
  assert.deepEqual([r.outcome, r.late, r.sceneRestored], ['user', true, false]);
  assert.ok(f.log.includes('restoreApp 1'));
  assert.ok(!f.log.some(x => x.startsWith('warp') || x.startsWith('cgwarp')));
});

await ta('codex2-5: observation runs AFTER restore, warp and close; routing evidence is required to note its URL', async () => {
  const f = fakeOps();
  f.ops.navigationUntouched = async () => { f.log.push('routing?'); return true; };
  const r = await runInputAction(f.ops, async (s, prep, ctx) => {
    f.log.push('deliver');
    ctx.observe(async () => { f.log.push('observe'); return { out: 'report', url: 'https://a.test/next' }; });
    return null;
  });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.out, 'report');
  const i = (x) => f.log.indexOf(x);
  assert.ok(i('restore') < i('observe') && i('warp 5,6') < i('observe') && i('close') < i('observe'), f.log.join(','));
  assert.equal(f.log.at(-1), 'note https://a.test/next');
  // A key or click routed to the target since hand-back is not agent navigation.
  const g = fakeOps();
  g.ops.navigationUntouched = async () => false;
  const r2 = await runInputAction(g.ops, async (s, prep, ctx) => {
    ctx.observe(async () => ({ out: 'report', url: 'https://a.test/next' }));
  });
  assert.ok(!g.log.includes('note https://a.test/next'), g.log.join(','));
  assert.match(r2.out, /没有记为 agent 的导航/);
});

await ta('releaseKept preserves clipboard/end fields and reports only confirmed restore results', async () => {
  for (const failed of [false, true]) {
    const end = { ok: true, restored: true, released: ['shift'], takeover: { active: false, swallowedKeys: 2 } };
    let closed = 0;
    const session = {
      request: async ({ op }) => {
        if (op === 'status') return { ok: true, takeover: { active: true } };
        if (failed) throw Error('native menu blocked the restore');
        return op === 'warp' ? { ok: true, warped: { x: 5, y: 6 } } : { ok: true, frontmost: true };
      },
      close: async () => { closed++; return end; },
    };
    const restore = { ok: true, appFrontmost: true, chromeReordered: true };
    const r = await releaseKept({ now: () => 100, restoreScene: async () => {
      if (failed) throw Error('Apple Event timed out');
      return restore;
    } }, { session, scene: { appPid: 1 }, pointer: { x: 5, y: 6 }, chromePid: 42 });
    assert.equal(closed, 1);
    for (const [key, value] of Object.entries(end)) assert.deepEqual(r[key], value);
    assert.equal(r.inputReleased, true);
    assert.equal(r.appRestored, !failed);
    assert.equal(r.pointerRestored, !failed);
    assert.equal(r.restoration.scene, failed ? null : restore);
  }
  const r = await releaseKept({ now: () => 100 }, {
    session: { request: async () => null, close: async () => { throw Error('no end reply'); } },
  });
  assert.equal(r.inputReleased, false);
  assert.equal(r.appRestored, false);
  assert.equal(r.pointerRestored, false);
});

await ta('codex2-5: a user interruption after delivery still gets the report, but nothing observed is noted', async () => {
  const session = fakeSession({ status: () => ({ ok: true, interrupted: { kind: 'move', t: 5 } }) });
  const f = fakeOps({ session });
  const r = await runInputAction(f.ops, async (s, prep, ctx) => {
    ctx.observe(async () => { f.log.push('observe'); return { out: 'report', url: 'https://a.test/next' }; });
  });
  assert.deepEqual([r.outcome, r.out], ['user', 'report']);
  assert.ok(!f.log.some(x => x.startsWith('note')), f.log.join(','));
  assert.ok(f.log.indexOf('close') < f.log.indexOf('observe'));
  // An action that failed never runs its observation.
  const g = fakeOps();
  await assert.rejects(runInputAction(g.ops, async (s, prep, ctx) => {
    ctx.observe(async () => { g.log.push('observe'); return { out: 'x' }; });
    throw new BridgeError('no_page_focus', 'x');
  }));
  assert.ok(!g.log.includes('observe'));
});

await ta('the user touches input after the last op (during observation): result kept, still no restore', async () => {
  const session = fakeSession({ end: { ok: true, op: 'end', interrupted: { kind: 'move', t: 99 } } });
  const f = fakeOps({ session });
  const r = await runInputAction(f.ops, async () => 'clicked');
  assert.equal(r.outcome, 'user');
  assert.equal(r.out, 'clicked');
  assert.ok(!pulledBack(f.log));
});

await ta('codex1-1/A1: input seen by the session after the action (status) → no restore, no warp, no navigation noted', async () => {
  const session = fakeSession({ status: () => ({ ok: true, interrupted: { kind: 'move', t: 5 } }) });
  const f = fakeOps({ session });
  const r = await runInputAction(f.ops, async () => 'clicked');
  assert.equal(r.outcome, 'user');
  assert.equal(r.out, 'clicked');
  assert.ok(!pulledBack(f.log), `pulled back: ${f.log}`);
  assert.ok(!f.log.some(x => x.startsWith('note')), 'a URL read while the user was active was recorded as the agent\'s');
});

await ta('A1: the user takes over during the scene restore (chromectl saw input) → the pointer is not warped', async () => {
  const f = fakeOps({ restoreReply: { ok: true, userInput: true, chromeReordered: false } });
  const r = await runInputAction(f.ops, async () => 'clicked');
  assert.deepEqual([r.outcome, r.late, r.sceneRestored], ['user', true, true]);
  assert.ok(!f.log.some(x => x.startsWith('warp') || x.startsWith('cgwarp')), `warped: ${f.log}`);
  assert.equal(f.session.closed, 1);
});

await ta('A1: the session refuses the warp because the user moved meanwhile → late, nothing warped', async () => {
  const session = fakeSession({ warp: () => ({ ok: false, error: 'interrupted', interrupted: { kind: 'move', t: 9 } }) });
  const f = fakeOps({ session });
  const r = await runInputAction(f.ops, async () => 'clicked');
  assert.deepEqual([r.outcome, r.late], ['user', true]);
  assert.ok(!f.log.some(x => x.startsWith('warp') || x.startsWith('cgwarp')));
});

await ta('codex1-1: session gone before the restore → idle counter from its close decides; user input → nothing pulled back', async () => {
  const session = fakeSession({ status: () => { throw new BridgeError('session_exited', 'x'); } });
  const f = fakeOps({ session, acted: (log) => log.includes('close') });
  const r = await runInputAction(f.ops, async () => 'clicked');
  assert.deepEqual([r.outcome, r.late], ['user', true]);
  assert.ok(!pulledBack(f.log), `pulled back: ${f.log}`);
  const g = fakeOps({ session: fakeSession({ status: () => { throw new BridgeError('session_exited', 'x'); } }) });
  const r2 = await runInputAction(g.ops, async () => 'clicked');
  assert.equal(r2.outcome, 'ok');
  assert.deepEqual(g.log.slice(-3), ['restore', 'acted?', 'cgwarp 5,6'], 'no input: restored with the standalone warp');
});

await ta('any other failure: scene restored and pointer warped back, then the error is reported', async () => {
  const f = fakeOps();
  await assert.rejects(() => runInputAction(f.ops, async (s, p, ctx) => {
    ctx.step('用真实滚轮滚了 1 串（5 格）', 'wheel');
    ctx.step('用真实滚轮滚了 2 串（9 格）', 'wheel');
    throw new BridgeError('guard_window_not_top', 'x');
  }), (e) => {
    assert.equal(e.code, 'guard_window_not_top');
    assert.deepEqual(e.steps, ['用真实滚轮滚了 2 串（9 格）'], 'keyed steps keep only the running total');
    assert.equal(e.lateUser, undefined);
    return true;
  });
  assert.deepEqual(f.log.slice(-3), ['restore', 'warp 5,6', 'close']);
  assert.equal(f.session.closed, 1);
});

await ta('a failure after which the user takes over during the restore: error kept, flagged lateUser, no warp', async () => {
  const f = fakeOps({ restoreReply: { ok: true, userInput: true } });
  await assert.rejects(() => runInputAction(f.ops, async () => { throw new BridgeError('guard_window_not_top', 'x'); }),
    (e) => e.code === 'guard_window_not_top' && e.lateUser === true && e.sceneRestored === true);
  assert.ok(!f.log.some(x => x.startsWith('warp') || x.startsWith('cgwarp')));
});

await ta('refused in prepare (not the key window / no CG window): no session, no input, scene restored', async () => {
  const f = fakeOps({ prepare: async () => { throw new BridgeError('not_key_window', 'x'); } });
  let ran = false;
  await assert.rejects(() => runInputAction(f.ops, async () => { ran = true; }), (e) => e.code === 'not_key_window');
  assert.equal(ran, false);
  assert.ok(!f.log.includes('open'), 'opened a session although prepare refused');
  assert.ok(f.log.includes('restore'));
  assert.equal(f.log.at(-1), 'cgwarp 5,6');
});

await ta('codex1-2/A2: prepare refuses because the user switched windows meanwhile → user outcome, nothing pulled back', async () => {
  for (const code of ['not_on_top', 'not_key_window']) {
    const f = fakeOps({ prepare: async () => { throw new BridgeError(code, 'x'); }, acted: true });
    const r = await runInputAction(f.ops, async () => {});
    assert.equal(r.outcome, 'user');
    assert.ok(r.error instanceof UserInterrupted && r.error.interrupted.beforeBegin);
    assert.equal(r.error.cause.code, code);
    assert.ok(!pulledBack(f.log), `${code}: pulled back ${f.log}`);
    assert.match(userStopMessage(r), /在把 Chrome 切到前面的过程中检测到了你的键盘鼠标输入/);
  }
});

await ta('user input between the idle wait and begin: nothing posted, nothing pulled back', async () => {
  const f = fakeOps({ acted: true });
  let ran = false;
  const r = await runInputAction(f.ops, async () => { ran = true; });
  assert.equal(r.outcome, 'user');
  assert.equal(ran, false);
  assert.ok(!f.log.includes('open') && !pulledBack(f.log));
  assert.match(userStopMessage(r), /还没有发出任何输入/);
});

await ta('no input monitor → refused before the action, scene restored', async () => {
  const session = fakeSession({ begin: { ok: true, inputMonitor: false } });
  const f = fakeOps({ session });
  let ran = false;
  await assert.rejects(() => runInputAction(f.ops, async () => { ran = true; }), (e) => e.code === 'no_input_monitor');
  assert.equal(ran, false);
  assert.ok(f.log.includes('restore'));
});

await ta('scroll (touchesScene false): pointer warped back, scene left alone', async () => {
  const f = fakeOps({ prepare: async () => ({ ...PREP, touchesScene: false }) });
  await runInputAction(f.ops, async () => 'scrolled');
  assert.ok(!f.log.includes('restore'));
  assert.deepEqual(f.log.slice(-2), ['warp 5,6', 'close']);
});

/* --------------------------------- bridge.openInputSession (DRY-RUN helper) -- */

console.log('\nbridge.js — openInputSession against `cgevent session` in DRY-RUN (posts nothing)');

let pbN = 0;
const dryEnv = () => ({ ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: 'guard-test',
  CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.guard${process.pid}.${++pbN}` });
/** A dry-run session; refuses to go on if the helper did not confirm dry-run at begin. Warps go to `log`. */
function drySession(log = null) {
  const s = openInputSession({ env: dryEnv() });
  return {
    get interrupted() { return s.interrupted; },
    close: () => s.close(),
    async request(o, opts) {
      const r = await s.request(o, opts);
      if (o.op === 'begin' && r.dryRun !== true) { await s.close(); throw new Error('helper is not in dry-run mode; stopping'); }
      if (o.op === 'warp' && r.ok !== false && !r.interrupted) log?.push(`warp ${r.warped.x},${r.warped.y}`);
      return r;
    }
  };
}
const BEGIN = { op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 1200, h: 800 } };

await ta('request/close: a click is planned and "posted" (dry), end releases and the helper exits', async () => {
  const s = drySession();
  await s.request(BEGIN);
  const c = await s.request({ op: 'click', rect: { x: 600, y: 400, w: 80, h: 30 }, aim: null, clickCount: 1 });
  assert.equal(c.ok, true);
  assert.equal(c.posted.filter(e => e.type === 'leftMouseDown').length, 1);
  const end = await s.close();
  assert.equal(end.op, 'end');
  assert.equal(end.reason, 'end');
  assert.equal(await s.close(), end, 'close is idempotent');
  await assert.rejects(() => s.request({ op: 'status' }), (e) => e.code === 'session_closed');
});

await ta('a user event during typing rejects with UserInterrupted carrying the progress', async () => {
  const s = drySession();
  await s.request(BEGIN);
  const typing = s.request({ op: 'type', text: 'hello world, typed slowly', firstDelay: false });
  await new Promise(r => setTimeout(r, 400));
  await s.request({ op: '_inject', kind: 'key' }, { raw: true });
  await assert.rejects(typing, (e) => {
    assert.ok(e instanceof UserInterrupted);
    assert.equal(e.interrupted.kind, 'key');
    assert.ok(e.reply.typed < 25, `typed ${e.reply.typed}`);
    return true;
  });
  const end = await s.close();
  assert.ok(end.interrupted, 'the end reply still carries the interruption');
});

await ta('a guard failure becomes a Chinese BridgeError, not an interruption', async () => {
  const s = drySession();
  await s.request(BEGIN);
  await s.request({ op: '_fake', topWindow: 99 }, { raw: true });
  await assert.rejects(s.request({ op: 'click', rect: { x: 600, y: 400, w: 80, h: 30 } }), (e) => {
    assert.ok(!(e instanceof UserInterrupted));
    assert.equal(e.code, 'guard_window_not_top');
    assert.match(e.message, /最上层的窗口不是目标 Chrome 窗口/);
    return true;
  });
  await s.close();
});

await ta('a missing helper binary: requests fail with helper_missing, close resolves', async () => {
  const s = openInputSession({ bin: '/nonexistent/cgevent' });
  await assert.rejects(s.request(BEGIN), (e) => e.code === 'helper_missing');
  assert.equal(await s.close(), null);
});

await ta('runInputAction + dry session: interrupted mid-type → user outcome, nothing restored', async () => {
  const f = fakeOps({ session: null });
  f.ops.openSession = async () => { f.log.push('open'); return drySession(); };
  const r = await runInputAction(f.ops, async (s, prep, ctx) => {
    ctx.step('点击了 [2]');
    const typing = s.request({ op: 'type', text: 'abcdefghijklmnop', firstDelay: false });
    await new Promise(res => setTimeout(res, 300));
    await s.request({ op: '_inject', kind: 'move' }, { raw: true });
    await typing;
    return 'unreachable';
  });
  assert.equal(r.outcome, 'user');
  assert.ok(!f.log.includes('restore') && !f.log.some(x => x.startsWith('warp')));
  assert.match(userStopMessage(r), /完成了：点击了 \[2\]；逐键输入了 \d+ 个字符/);
});

await ta('runInputAction + dry session: success restores, then the helper itself warps the pointer back', async () => {
  const f = fakeOps({ session: null });
  f.ops.openSession = async () => { f.log.push('open'); return drySession(f.log); };
  const r = await runInputAction(f.ops, async (s) => {
    const c = await s.request({ op: 'click', rect: { x: 600, y: 400, w: 80, h: 30 } });
    return `landed ${c.landed.x}`;
  });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.end.reason, 'end');
  assert.deepEqual(f.log.slice(-2), ['restore', 'warp 5,6']);
});

await ta('A1 + dry session: a user move after the action → no restore, no warp', async () => {
  const f = fakeOps({ session: null });
  f.ops.openSession = async () => { f.log.push('open'); return drySession(f.log); };
  const r = await runInputAction(f.ops, async (s) => {
    await s.request({ op: 'click', rect: { x: 600, y: 400, w: 80, h: 30 } });
    await s.request({ op: '_inject', kind: 'move' }, { raw: true });
    return 'clicked';
  });
  assert.equal(r.outcome, 'user');
  assert.equal(r.out, 'clicked');
  assert.ok(!pulledBack(f.log), `pulled back: ${f.log}`);
});

await ta('A1 + dry session: a user move during the scene restore → the helper refuses the warp', async () => {
  const f = fakeOps({ session: null });
  let sess;
  f.ops.openSession = async () => { f.log.push('open'); sess = drySession(f.log); return sess; };
  f.ops.restoreScene = async () => {
    f.log.push('restore');
    await sess.request({ op: '_inject', kind: 'move' }, { raw: true });
    return { ok: true };
  };
  const r = await runInputAction(f.ops, async () => 'clicked');
  assert.deepEqual([r.outcome, r.late], ['user', true]);
  assert.ok(!f.log.some(x => x.startsWith('warp') || x.startsWith('cgwarp')), `warped: ${f.log}`);
});

console.log(`\n${passed} assertion groups passed.`);

console.log('\nguard.js — preflight: prepare before activation, watch through it');
await ta('preflight: session starts BEFORE prepare (activation), action gets the preflight data', async () => {
  const f = fakeOps({ quiet: true });
  f.ops.quietMs = 0;
  f.ops.preflight = async () => { f.log.push('preflight'); return { tab: 7, session: { chromePid: PREP.chromePid, cgWindow: PREP.cgWindow, windowBounds: PREP.windowBounds } }; };
  let got = null;
  const r = await runInputAction(f.ops, async (s, prep, ctx, pre) => { got = pre; f.log.push('action'); return 'done'; });
  assert.equal(r.outcome, 'ok');
  assert.ok(f.log.indexOf('preflight') < f.log.indexOf('open') && f.log.indexOf('open') < f.log.indexOf('prepare'),
    `order was ${f.log.join(' > ')}`);
  assert.equal(got && got.tab, 7);
  assert.ok(r.timing && r.timing.activated && r.timing.handBack);
});
await ta('preflight: user input in the quiet window before activation → no activation, no action', async () => {
  const f = fakeOps({ session: fakeSession({ status: () => ({ ok: true, interrupted: { kind: 'key', t: 1 } }) }) });
  f.ops.quietMs = 0;
  f.ops.preflight = async () => ({ tab: 7, session: { chromePid: PREP.chromePid, cgWindow: PREP.cgWindow, windowBounds: PREP.windowBounds } });
  let acted = false;
  const r = await runInputAction(f.ops, async () => { acted = true; return 'done'; }).catch(e => e);
  assert.ok(!f.log.includes('prepare'), 'Chrome must not be activated');
  assert.equal(acted, false);
  assert.ok((r && r.outcome === 'user') || (r instanceof Error), 'reported as the user taking over');
});
await ta('preflight: CG window changed between preflight and activation → refused before the action', async () => {
  const f = fakeOps({ prepare: async () => ({ ...PREP, cgWindow: 999 }) });
  f.ops.quietMs = 0;
  f.ops.preflight = async () => ({ tab: 7, session: { chromePid: PREP.chromePid, cgWindow: PREP.cgWindow, windowBounds: PREP.windowBounds } });
  let acted = false;
  const e = await runInputAction(f.ops, async () => { acted = true; }).catch(x => x);
  assert.equal(acted, false);
  assert.equal(e && e.code, 'window_changed');
});
console.log('\npreflight tests passed.');

await ta('handBack: user input seen when handing the front back → late takeover, no scene restore', async () => {
  const sess = fakeSession();
  const orig = sess.request.bind(sess);
  sess.request = async (o, x) => o.op === 'handBack' ? ({ ok: false, error: 'user_input', interrupted: { kind: 'move', t: 1 } }) : orig(o, x);
  const f = fakeOps({ session: sess });
  const r = await runInputAction(f.ops, async () => 'done');
  assert.equal(r.outcome, 'user');
  assert.ok(!f.log.includes('restore'), 'the scene must not be restored after the user took over');
});
console.log('handBack tests passed.');

/* ------------------------------------------------ the takeover veil (wiring) -- */

console.log('\nguard.js / bridge.js — takeover veil wiring');

await ta('takeover without a pre-check (scroll, type without marker): held first, then begun with the prepared window', async () => {
  const sess = fakeSession({ begin: { ok: true, inputMonitor: true, takeover: { active: true } } });
  const holds = [];
  const orig = sess.request.bind(sess);
  sess.request = async (o, x) => {
    if (o.op === 'hold') { sess.sent.push('hold'); holds.push(o); return { ok: true, pointer: { x: 5, y: 6 } }; }
    if (o.op === 'begin') sess.beginReq = o;
    return orig(o, x);
  };
  const f = fakeOps({ session: sess, prepare: async () => ({ ...PREP, touchesScene: false }) });
  f.ops.takeover = true;
  f.ops.takeoverLimits = {};
  f.ops.veil = (pre) => ({ label: { zh: '正在滚动', en: 'Scrolling' }, ...(pre ? { rect: pre.session.windowBounds } : {}) });
  const r = await runInputAction(f.ops, async () => 'scrolled');
  assert.equal(r.outcome, 'ok', r.error && r.error.message);
  assert.deepEqual(sess.sent.slice(0, 3), ['prime', 'hold', 'begin']);
  assert.deepEqual(holds[0].veil, { label: { zh: '正在滚动', en: 'Scrolling' } }, 'hold did not carry the veil');
  assert.deepEqual([sess.beginReq.window, sess.beginReq.takeover], [7, undefined], 'begin must not take over again');
});

await ta('takeover with a pre-check: hold carries the veil built from it (hole = the pre-checked window)', async () => {
  const sess = fakeSession({ begin: { ok: true, inputMonitor: true, takeover: { active: true } } });
  let hold = null;
  const orig = sess.request.bind(sess);
  sess.request = async (o, x) => o.op === 'hold' ? ((hold = o), { ok: true, pointer: { x: 5, y: 6 } }) : orig(o, x);
  const f = fakeOps({ session: sess });
  f.ops.takeover = true;
  f.ops.takeoverLimits = {};
  f.ops.preflight = async () => ({ session: { chromePid: 42, cgWindow: 7, windowBounds: PREP.windowBounds } });
  f.ops.veil = (pre) => ({ rect: pre.session.windowBounds, label: 'x' });
  const r = await runInputAction(f.ops, async () => 'done');
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(hold.veil, { rect: PREP.windowBounds, label: 'x' });
  // A veil that throws never costs the action.
  f.ops.veil = () => { throw new Error('boom'); };
  const r2 = await runInputAction(f.ops, async () => 'done');
  assert.equal(r2.outcome, 'ok');
});

/* ------------------------------------- hand-over between agents (lock.js queue) -- */

console.log('\nguard.js — hand-over between agents (lock.js queue)');

/** A takeover session that holds (hold → pointer 70,80) and stays held. */
function heldSession() {
  const sess = fakeSession({ begin: { ok: true, inputMonitor: true, takeover: { active: true } },
    status: () => ({ ok: true, interrupted: null, takeover: { active: true } }) });
  const orig = sess.request.bind(sess);
  sess.request = async (o, x) => {
    if (o.op === 'hold') { sess.sent.push('hold'); sess.log?.push('hold'); return { ok: true, pointer: { x: 70, y: 80 } }; }
    if (o.op === 'veil') { sess.sent.push('veil'); return { ok: true, held: true }; }
    return orig(o, x);
  };
  return sess;
}
const takeoverOps = (sess, o = {}) => { const f = fakeOps({ session: sess, ...o }); f.ops.takeover = true; f.ops.takeoverLimits = {}; return f; };

await ta('takeover waits until the user is done typing or clicking BEFORE holding (owner 2026-10-13: "等用户操作完了再接管")', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess);
  f.ops.waitForHandsOff = async () => { f.log.push('handsoff'); return 2300; };
  f.ops.preflight = async () => { f.log.push('preflight'); return null; };
  const r = await runInputAction(f.ops, async () => { f.log.push('action'); return 'done'; });
  assert.equal(r.outcome, 'ok', r.error && r.error.message);
  assert.equal(r.idleWait, 2300);
  // Right before the hold, after the page work: the user cannot start typing again in between (Codex/Fable r12 B).
  const at = (x) => f.log.indexOf(x);
  assert.ok(at('preflight') < at('handsoff') && at('handsoff') + 1 === at('hold'), `not right before the hold: ${f.log}`);
  assert.ok(!f.log.includes('idle'), 'the takeover waited for the pointer to stop too');
  // Already held (a hand-over from the previous agent, a long job's next action): nothing to wait for.
  const g = takeoverOps(heldSession());
  g.ops.waitForHandsOff = async () => { g.log.push('handsoff'); return 0; };
  g.ops.inherit = { scene: { appPid: 3 }, pointer: { x: 1, y: 2 }, touched: true, claim: async () => true };
  await runInputAction(g.ops, async () => 'done');
  assert.ok(!g.log.includes('handsoff'), `waited although the input was already held: ${g.log}`);
  // Still busy at the deadline: refused before anything was opened or touched (the retry waits on).
  const h = takeoverOps(heldSession());
  h.ops.waitForHandsOff = async () => { throw Object.assign(new Error('busy'), { code: 'user_busy' }); };
  await assert.rejects(runInputAction(h.ops, async () => 'done'), (e) => e.code === 'user_busy' && e.sent.length === 0);
  assert.ok(!h.log.includes('hold') && !h.log.includes('prepare') && !pulledBack(h.log), h.log.join(','));
  assert.equal(h.session.closed, 1, 'the primed session was left open');
});

await ta('hand-over taken: claimed only once our veil is up; the previous agent\'s scene and pointer are put back at the end, none read again', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess);
  let sentAtClaim = null;
  f.ops.inherit = { scene: { appPid: 3 }, pointer: { x: 1, y: 2 }, touched: true,
    claim: async () => { sentAtClaim ??= [...sess.sent]; f.log.push('claim'); return true; } };
  const r = await runInputAction(f.ops, async () => { f.log.push('action'); return 'done'; });
  assert.equal(r.outcome, 'ok', r.error && r.error.message);
  assert.ok(sentAtClaim && sentAtClaim.includes('hold'), `claimed before our own veil was up: ${sentAtClaim}`);
  assert.ok(!f.log.includes('snapshot') && !f.log.includes('mousepos'), `read the scene again: ${f.log}`);
  assert.ok(f.log.indexOf('claim') < f.log.indexOf('prepare'), `activated before the claim: ${f.log}`);
  assert.equal(f.log.filter(x => x === 'claim').length, 1, 'claimed more than once');
  assert.equal(f.calls.restoreScene.length, 1);
  assert.ok(f.log.includes('warp 1,2'), `the user's pointer was not put back: ${f.log}`);
  assert.ok(sess.sent.includes('handBack'), 'the user\'s app (from the handed scene) was not handed back');
});

await ta('hand-over taken, this action does not bring Chrome forward (scroll): an earlier agent did, so the scene is still put back', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess, { prepare: async () => ({ ...PREP, touchesScene: false }) });
  f.ops.inherit = { scene: { appPid: 3 }, pointer: { x: 1, y: 2 }, touched: true, claim: async () => true };
  const r = await runInputAction(f.ops, async () => 'scrolled');
  assert.equal(r.outcome, 'ok');
  assert.equal(f.calls.restoreScene.length, 1, `scene not put back after a chain: ${f.log}`);
});

await ta('hand-over withdrawn before our claim: handoff_lost; nothing activated, nothing put back, the pointer not moved', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess);
  f.ops.inherit = { scene: { appPid: 3 }, pointer: { x: 1, y: 2 }, touched: true, claim: async () => false };
  await assert.rejects(runInputAction(f.ops, async () => { f.log.push('action'); return 'done'; }), (e) => e.code === 'handoff_lost' && e.sent.length === 0);
  assert.ok(!f.log.includes('prepare') && !f.log.includes('action'), f.log.join(','));
  assert.ok(!pulledBack(f.log), `put something back that was not ours: ${f.log}`);
  assert.equal(sess.closed, 1, 'our veil stayed up');
});

await ta('done while another agent waits: handed over — no scene restore, no pointer warp, no app hand-back; our session closes before the waiter is written in', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess);
  const seq = [];
  f.ops.handoff = async (payload) => {
    seq.push('offer'); f.payload = payload;
    return { to: { who: 'Codex · x', task: 'export' }, commit: async () => { seq.push(`commit closed=${sess.closed}`); } };
  };
  const r = await runInputAction(f.ops, async () => 'done');
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(r.handedOver, { who: 'Codex · x', task: 'export' });
  assert.equal(f.calls.restoreScene.length, 0);
  assert.ok(!pulledBack(f.log) && !sess.sent.includes('handBack'), `put things back although handed over: ${f.log} / ${sess.sent}`);
  assert.deepEqual(seq, ['offer', 'commit closed=1']);
  assert.deepEqual([f.payload.scene, f.payload.pointer, f.payload.touched], [{ appPid: 1 }, { x: 70, y: 80 }, true]);
  assert.ok(f.log.includes('note https://a.test/after'), 'the agent\'s navigation was not recorded');
});

await ta('Codex A6: claimed, then the page check fails before anything begins → the handed scene and pointer put back WHILE still held, then let go', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess, { prepare: async () => { throw Object.assign(new Error('gone'), { code: 'no_such_tab' }); } });
  f.ops.inherit = { scene: { appPid: 3 }, pointer: { x: 1, y: 2 }, touched: true, claim: async () => true };
  await assert.rejects(runInputAction(f.ops, async () => 'never'), (e) => e.code === 'no_such_tab');
  const iRestore = f.log.indexOf('restore'), iWarp = f.log.indexOf('cgwarp 1,2'), iClose = f.log.indexOf('close');
  assert.ok(iRestore >= 0 && iWarp >= 0 && iClose >= 0, f.log.join(','));
  assert.ok(iRestore < iClose && iWarp < iClose, `let go before putting the handed scene back: ${f.log}`);
  assert.equal(f.calls.restoreScene[0].held, true, 'restored as if not held (would stop on the user\'s input)');
  assert.equal(f.log.filter(x => x === 'restore').length, 1, 'restored twice');
});

await ta('Codex round 2 A11: claimed, the user gives the hold back (Esc) and moves on, then the page check fails → no forced restore, no pointer pulled back', async () => {
  const sess = heldSession();
  sess.request = ((orig) => async (o, x) => o.op === 'status'
    ? { ok: true, interrupted: null, takeover: { active: false, aborted: true, abortedBy: 'esc' } } : orig(o, x))(sess.request.bind(sess));
  const f = takeoverOps(sess, { prepare: async () => { throw Object.assign(new Error('gone'), { code: 'no_such_tab' }); },
    restoreReply: { ok: true, userInput: true } });
  f.ops.inherit = { scene: { appPid: 3 }, pointer: { x: 1, y: 2 }, touched: true, claim: async () => true };
  await assert.rejects(runInputAction(f.ops, async () => 'never'), (e) => e.code === 'no_such_tab');
  assert.ok(f.calls.restoreScene.every(o => !o.held), `restored as if still held: ${JSON.stringify(f.calls.restoreScene)}`);
  assert.ok(!f.log.some(x => x.startsWith('cgwarp') || x.startsWith('warp')), `pulled the pointer back after the user took over: ${f.log}`);
});

await ta('Codex round 3 A11: the user gives the hold back DURING the restore of a claimed scene → the pointer is not pulled back', async () => {
  const sess = heldSession();
  let restored = false;
  sess.request = ((orig) => async (o, x) => o.op === 'status'
    ? { ok: true, interrupted: null, takeover: restored ? { active: false, aborted: true, abortedBy: 'esc' } : { active: true } } : orig(o, x))(sess.request.bind(sess));
  const f = takeoverOps(sess, { prepare: async () => { throw Object.assign(new Error('gone'), { code: 'no_such_tab' }); } });
  f.ops.restoreScene = async (sc, o) => { f.log.push('restore'); f.calls.restoreScene.push(o); restored = true; return { ok: true }; };
  f.ops.inherit = { scene: { appPid: 3 }, pointer: { x: 1, y: 2 }, touched: true, claim: async () => true };
  await assert.rejects(runInputAction(f.ops, async () => 'never'), (e) => e.code === 'no_such_tab');
  assert.equal(f.calls.restoreScene.length, 1, 'restored twice');
  assert.ok(!f.log.some(x => x.startsWith('cgwarp') || x.startsWith('warp')), `pulled the pointer back after the user took over: ${f.log}`);
});

await ta('Codex round 3 A12: a long job\'s step cancelled by the caller → not kept for a retry: things put back, the hold closed', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess);
  const ac = new AbortController(); ac.abort();
  f.ops.signal = ac.signal;
  f.ops.keep = true;
  f.ops.reuse = { session: sess, scene: { appPid: 1 }, pointer: { x: 5, y: 6 }, cgWindow: 7, chromePid: 42 };
  await assert.rejects(runInputAction(f.ops, async () => 'x'), (e) => e.code === 'cancelled' && !e.keptHold);
  assert.equal(sess.closed, 1, 'the hold stayed up after a cancelled call');
});

await ta('Codex round 2 A9: cancelled while waiting for its turn (no hand-over) → nothing activated, nothing sent', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess);
  const ac = new AbortController(); ac.abort();
  f.ops.signal = ac.signal;
  await assert.rejects(runInputAction(f.ops, async () => { f.log.push('action'); return 'x'; }), (e) => e.code === 'cancelled');
  assert.ok(!f.log.includes('prepare') && !f.log.includes('action'), f.log.join(','));
});

await ta('cancelled while waiting for a hand-over: once claimed, the handed scene is put back and nothing is done', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess);
  const ac = new AbortController();
  f.ops.signal = ac.signal;
  f.ops.inherit = { scene: { appPid: 3 }, pointer: { x: 1, y: 2 }, touched: true, claim: async () => { ac.abort(); return true; } };
  await assert.rejects(runInputAction(f.ops, async () => { f.log.push('action'); return 'x'; }), (e) => e.code === 'cancelled');
  assert.ok(!f.log.includes('prepare') && !f.log.includes('action'), f.log.join(','));
  assert.equal(f.calls.restoreScene.length, 1);
  assert.ok(f.log.indexOf('restore') < f.log.indexOf('close'));
});

await ta('nobody takes the hand-over: things put back as usual', async () => {
  const sess = heldSession();
  const f = takeoverOps(sess);
  f.ops.handoff = async () => null;
  const r = await runInputAction(f.ops, async () => 'done');
  assert.equal(r.outcome, 'ok');
  assert.equal(r.handedOver, undefined);
  assert.equal(f.calls.restoreScene.length, 1);
  assert.ok(f.log.includes('warp 70,80'));
});

await ta('no hand-over after a failure, after the user took over, or for a long job\'s step (it keeps its hold)', async () => {
  for (const [name, act, extra] of [
    ['failure', async () => { throw new Error('boom'); }, {}],
    ['user', async () => { throw new UserInterrupted({ kind: 'key', t: 1 }); }, {}],
    ['keep', async () => 'done', { keep: true }]
  ]) {
    const sess = heldSession();
    const f = takeoverOps(sess);
    let offered = false;
    f.ops.handoff = async () => { offered = true; return null; };
    Object.assign(f.ops, extra);
    await runInputAction(f.ops, act).catch(() => {});
    assert.equal(offered, false, `offered a hand-over after: ${name}`);
  }
});

t('sessionError: a shake cancel is the user\'s cancel (user_cancelled), not a lost hold', () => {
  const e = sessionError({ ok: false, error: 'aborted', takeover: { aborted: true, abortedBy: 'shake', active: false } });
  assert.equal(e.code, 'user_cancelled');
  assert.match(e.message, /晃动鼠标.*\n给 agent：不要自动重试/s);
  const esc = sessionError({ ok: false, error: 'aborted', takeover: { aborted: true, abortedBy: 'esc' } });
  assert.equal(esc.code, 'user_cancelled');
  assert.match(esc.message, /两次 Esc/);
  assert.equal(sessionError({ ok: false, error: 'aborted', takeover: { aborted: true, abortedBy: 'timeout' } }).code, 'takeover_expired');
  const tap = sessionError({ ok: false, error: 'aborted', takeover: { aborted: true, abortedBy: 'tap_disabled' } });
  assert.equal(tap.code, 'takeover_expired');
  assert.match(tap.message, /系统中断/);
  assert.doesNotMatch(tap.message, /超时/);
  const detail = sessionError({ ok: false, error: 'aborted', takeover: { aborted: true, abortedBy: 'tap_disabled',
    tapDiagnostic: { reason: 'timeout', longestRunLoopGapMs: 634.2, slowestStage: { stage: 'overlay_hole', ms: 612.8 } } } });
  assert.match(detail.message, /timeout.*634 ms.*overlay_hole 613 ms/s);
});

await ta('close() resolves with the end reply without waiting for the helper to exit (it fades its veil out first)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-fade-'));
  const bin = path.join(dir, 'slow-exit-helper');
  // Replies to `end` at once, then stays 1.5 s (a long fade-out) before exiting.
  writeFileSync(bin, `#!${process.execPath}\nconst rl = require('readline').createInterface({ input: process.stdin });\n` +
    `rl.on('line', (l) => { const r = JSON.parse(l); if (r.op === 'end') { process.stdout.write(JSON.stringify({ op: 'end', ok: true, reason: 'end', interrupted: null }) + '\\n'); setTimeout(() => process.exit(0), 1500); } ` +
    `else process.stdout.write(JSON.stringify({ op: r.op, id: r.id, ok: true, interrupted: null }) + '\\n'); });\n`);
  chmodSync(bin, 0o755);
  try {
    const s = openInputSession({ bin });
    await s.request({ op: 'status' });
    const t0 = Date.now();
    const end = await s.close();
    const ms = Date.now() - t0;
    assert.equal(end && end.reason, 'end');
    assert.ok(ms < 700, `close waited ${ms} ms for the exit`);
    assert.equal(await s.close(), end, 'close is idempotent');
    await new Promise(r => setTimeout(r, 1700));   // let the helper go before the temp dir does
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
console.log('veil wiring tests passed.');
