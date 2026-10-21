/* Unit tests for the viewport -> screen point conversion.
   Run: node test/coords.test.mjs   (no test framework, no network) */
import assert from 'node:assert/strict';
import {
  viewportOrigin, pointInCentralArea, toScreen, rectToScreenPoint, pointInViewport
} from '../src/coords.js';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('coords.js');

/* ---- Fixed synthetic case ------------------------------------------------
   A 1400x900 point Chrome window whose top-left sits at (100, 60) on screen.
   Viewport is 1400x812 CSS px  =>  toolbar = 900 - 812 = 88 px, no side inset.
   Viewport origin on screen = (100, 60 + 88) = (100, 148).
   Target element rect (viewport coords): x=200 y=300 w=100 h=50.
     central 60% box = x in [220, 280], y in [310, 340]
     => screen x in [320, 380], screen y in [458, 488]
*/
const BOUNDS = { left: 100, top: 60, width: 1400, height: 900 };
const VIEW = {
  innerWidth: 1400, innerHeight: 812, outerWidth: 1400, outerHeight: 900,
  screenX: 100, screenY: 60, dpr: 2
};
const RECT = { x: 200, y: 300, width: 100, height: 50 };

t('origin: toolbar height and scale on a Retina window', () => {
  const o = viewportOrigin(BOUNDS, VIEW);
  assert.equal(o.scale, 1, 'no page zoom => scale 1');
  assert.equal(o.sideInset, 0);
  assert.equal(o.toolbarHeight, 88);
  assert.equal(o.originX, 100);
  assert.equal(o.originY, 148);
  assert.equal(o.source, 'applescript-bounds');
});

t('devicePixelRatio never enters the conversion (CGEvent uses points)', () => {
  const retina = viewportOrigin(BOUNDS, { ...VIEW, dpr: 2 });
  const nonRetina = viewportOrigin(BOUNDS, { ...VIEW, dpr: 1 });
  assert.deepEqual(retina, nonRetina);
  const a = toScreen({ x: 200, y: 300 }, retina);
  assert.deepEqual(a, { x: 300, y: 448 });
});

t('central 60%: extremes land exactly on the box corners', () => {
  const lo = pointInCentralArea(RECT, () => 0);
  const hi = pointInCentralArea(RECT, () => 1);
  assert.deepEqual(lo, { x: 220, y: 310 });
  assert.deepEqual(hi, { x: 280, y: 340 });
  const mid = pointInCentralArea(RECT, () => 0.5);
  assert.deepEqual(mid, { x: 250, y: 325 }); // == rect centre
});

t('fixed synthetic case: rect -> screen point inside the expected band', () => {
  const lo = rectToScreenPoint(RECT, BOUNDS, VIEW, () => 0);
  const hi = rectToScreenPoint(RECT, BOUNDS, VIEW, () => 1);
  assert.deepEqual(lo.screen, { x: 320, y: 458 });
  assert.deepEqual(hi.screen, { x: 380, y: 488 });
});

t('1000 random draws all stay inside the central 60% band', () => {
  for (let i = 0; i < 1000; i++) {
    const { screen } = rectToScreenPoint(RECT, BOUNDS, VIEW);
    assert.ok(screen.x >= 320 && screen.x <= 380, `x out of band: ${screen.x}`);
    assert.ok(screen.y >= 458 && screen.y <= 488, `y out of band: ${screen.y}`);
  }
});

t('page zoom 150% is recovered from bounds.width / outerWidth', () => {
  // Same physical window, page zoomed to 150%: CSS px shrink to 2/3.
  const zview = {
    innerWidth: 933, innerHeight: 541, outerWidth: 933, outerHeight: 600,
    screenX: 100, screenY: 60, dpr: 2
  };
  const o = viewportOrigin(BOUNDS, zview);
  assert.ok(Math.abs(o.scale - 1.5005) < 0.001, `scale=${o.scale}`);
  // toolbar 59 CSS px * 1.5 ≈ 88.5 points — matches the unzoomed 88.
  assert.ok(Math.abs(o.originY - 60 - 88) < 2, `originY=${o.originY}`);
});

t('window on a second display to the left of main (negative x)', () => {
  const b = { left: -1720, top: -200, width: 1400, height: 900 };
  const o = viewportOrigin(b, VIEW);
  assert.equal(o.originX, -1720);
  assert.equal(o.originY, -112);
  const p = toScreen({ x: 200, y: 300 }, o);
  assert.deepEqual(p, { x: -1520, y: 188 });
});

t('falls back to window.screenX/screenY when AppleScript bounds are missing', () => {
  const o = viewportOrigin(null, VIEW);
  assert.equal(o.source, 'window.screenXY');
  assert.equal(o.originX, 100);
  assert.equal(o.originY, 148);
});

t('absurd scale ratios are ignored rather than trusted', () => {
  const o = viewportOrigin(BOUNDS, { ...VIEW, outerWidth: 10 });
  assert.equal(o.scale, 1);
});

t('pointInViewport: inside, on the toolbar, and outside the window', () => {
  assert.equal(pointInViewport({ x: 500, y: 500 }, BOUNDS, VIEW), true);
  assert.equal(pointInViewport({ x: 500, y: 100 }, BOUNDS, VIEW), false); // toolbar, above viewport
  assert.equal(pointInViewport({ x: 3000, y: 500 }, BOUNDS, VIEW), false);
  assert.equal(pointInViewport({ x: 100, y: 148 }, BOUNDS, VIEW), true);   // exact top-left
  assert.equal(pointInViewport({ x: 1500, y: 960 }, BOUNDS, VIEW), true);  // exact bottom-right
  assert.equal(pointInViewport({ x: 1501, y: 960 }, BOUNDS, VIEW), false); // one point past the right edge
  assert.equal(pointInViewport({ x: 1500, y: 961 }, BOUNDS, VIEW), false); // one point below the viewport
  assert.equal(pointInViewport({ x: 500, y: 500 }, null, VIEW), false);    // no bounds => never a real wheel
});

t('degenerate rect (1px tall) still yields a point on the element', () => {
  const r = { x: 10, y: 20, width: 1, height: 1 };
  const { screen } = rectToScreenPoint(r, BOUNDS, VIEW, () => 0.5);
  assert.deepEqual(screen, { x: 110.5, y: 168.5 });
});

console.log(`\n${passed} assertions groups passed.`);
