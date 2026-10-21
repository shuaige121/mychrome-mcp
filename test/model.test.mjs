#!/usr/bin/env node
/* Pointer movement model (docs/impl-contract.md §1.4, §6), through the offline
 * `cgevent model` subcommand: it plans movements with a fixed seed and posts
 * nothing. Inside/outside, peak time and step sizes are recomputed here from
 * the reported points rather than taken from the helper's own flags.
 * Every check runs and failures are listed at the end. CGEVENT_BIN overrides
 * the binary (used to prove the checks fail on a deliberately broken build). */
import './isolate-settings.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// These check the built-in timing defaults; the user's recorded habits (test/habits.test.mjs) stay out.
process.env.CHROME_BRIDGE_HABITS = 'off';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.CGEVENT_BIN || path.join(HERE, '..', 'bin', 'cgevent');
const RATE = 2;
const failures = [];
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}

function model({ from, rect, n = 200, seed = 'm1' }) {
  const out = execFileSync(BIN, ['model', '--from', from.join(','), '--rect', rect.join(','),
    '--n', String(n), '--seed', seed, '--rate', String(RATE), '--u', '1',
    '--window', '0,0,3000,2000', '--points'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const r = JSON.parse(out);
  assert.equal(r.ok, true);
  return r.plans;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const EPS = 0.006;   // reported coordinates are rounded to 0.01
const inRect = ([x, y], [rx, ry, rw, rh], inset = 0) =>
  x >= rx + rw * inset - EPS && x <= rx + rw * (1 - inset) + EPS && y >= ry + rh * inset - EPS && y <= ry + rh * (1 - inset) + EPS;

function regression(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, r2: sxy * sxy / (sxx * syy) };
}

/** From the reported points: largest step, and when the fastest step of the primary happened. */
function fromPoints(p) {
  let last = [0, ...p.start], maxStep = 0, best = -1, peakFrac = 0;
  for (const q of p.pts) {
    const step = Math.hypot(q[1] - last[1], q[2] - last[2]);
    maxStep = Math.max(maxStep, step);
    if (q[0] <= p.primary + 1e-6) {
      const v = step / Math.max(1e-9, q[0] - last[0]);
      if (v > best) { best = v; peakFrac = (q[0] + last[0]) / 2 / p.primary; }
    }
    last = q;
  }
  return { maxStep, peakFrac, end: p.pts.at(-1)?.slice(1) };
}

// Horizontal, diagonal and leftward movements across D 150–1200 pt and W 12–200 pt.
const configs = [];
for (const D of [150, 400, 800, 1200]) {
  for (const W of [12, 40, 200]) configs.push({ from: [200, 600], rect: [200 + D - W / 2, 600 - W / 2, W, W] });
}
configs.push({ from: [300, 300], rect: [780, 780, 30, 30] });
configs.push({ from: [1500, 900], rect: [940, 888, 120, 24] });

const all = [];
const perConfig = [];
for (const [i, c] of configs.entries()) {
  const plans = model({ from: c.from, rect: c.rect, seed: `cfg${i}` });
  all.push(...plans.map(p => ({ ...p, rect: c.rect, ...fromPoints(p) })));
  perConfig.push({ ID: median(plans.map(p => p.ID)), T: median(plans.map(p => p.T)) });
}
const moved = all.filter(p => !p.skippedMove);

check('median T increases with ID across configurations', () => {
  const sorted = [...perConfig].sort((a, b) => a.ID - b.ID);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].ID - sorted[i - 1].ID < 0.25) continue;   // near-equal IDs: noise decides the order
    assert.ok(sorted[i].T > sorted[i - 1].T,
      `median T must rise with ID: ID ${sorted[i - 1].ID}→${sorted[i].ID} gave T ${sorted[i - 1].T}→${sorted[i].T}`);
  }
});

check('regression slope of (movement start → mouseDown) on ID within 225 ms/bit ±25%', () => {
  const { slope, intercept, r2 } = regression(moved.map(p => p.ID), moved.map(p => p.total));
  console.log(`       slope ${slope.toFixed(1)} ms/bit, intercept ${intercept.toFixed(1)} ms, r² ${r2.toFixed(3)}, n ${moved.length}`);
  assert.ok(slope >= 225 * 0.75 && slope <= 225 * 1.25, `slope ${slope} outside 225 ±25%`);
});

check(`100% of endpoints inside the rect (${all.length} plans)`, () => {
  const outside = moved.filter(p => !inRect(p.end, p.rect));
  assert.equal(outside.length, 0, `${outside.length} endpoints outside, e.g. ${outside[0]?.end} vs ${outside[0]?.rect}`);
  assert.ok(moved.every(p => p.end[0] === p.landed.x && p.end[1] === p.landed.y), 'last point = reported landing');
});

check('median peak-speed time fraction of the primary in [0.30, 0.50]', () => {
  const m = median(moved.map(p => p.peakFrac));
  console.log(`       median peak-speed fraction ${m.toFixed(3)}`);
  assert.ok(m >= 0.30 && m <= 0.50, `median peak fraction ${m} outside [0.30, 0.50]`);
});

check('no inter-point step larger than 2·rateMs at peak speed ×1.5', () => {
  for (const p of moved) {
    const limit = p.peakSpeed * 2 * RATE * 1.5;
    assert.ok(p.maxStep <= limit, `step ${p.maxStep.toFixed(2)} pt > ${limit.toFixed(2)} (peak ${p.peakSpeed} pt/ms)`);
  }
});

check('zero-correction plans only when the primary ended inside the inner 80%', () => {
  const zero = moved.filter(p => p.corrections.length === 0);
  const bad = zero.filter(p => !inRect(p.primaryEnd, p.rect, 0.1));
  assert.equal(bad.length, 0, `${bad.length} zero-correction plans whose primary ended outside`);
  const corrected = moved.filter(p => p.corrections.length > 0);
  assert.ok(corrected.length > 0 && zero.length > 0, 'both corrected and uncorrected plans must occur');
  assert.ok(moved.every(p => p.corrections.length <= 3), 'at most 3 corrections');
  console.log(`       ${zero.length} without corrections, ${corrected.length} corrected`);
});

check('bow ≤ 8% of D, phases sum to the budget T, dwell = the user\'s arrival→press pause (§7)', () => {
  assert.ok(moved.every(p => p.maxPerpFrac <= 0.09), 'perpendicular deviation must stay ≤ ~8% of D');
  const off = moved.filter(p => Math.abs(p.total - p.T) > 0.05);
  assert.ok(off.length / moved.length < 0.02, `${off.length} plans do not add up to their budget T`);
  assert.ok(moved.every(p => p.dwell >= 4 - 1e-6 && p.dwell <= 150 + 1e-6), 'dwell outside [4, 150] ms');
  const med = median(moved.map(p => p.dwell));
  assert.ok(med >= 12 && med <= 30, `median dwell ${med.toFixed(1)} ms, want ≈ 20`);
  const skipped = model({ from: [500, 500], rect: [450, 480, 100, 40], n: 200 });
  assert.ok(skipped.every(p => p.dwell >= 4 - 1e-6 && p.dwell <= 150 + 1e-6), 'skipped-move dwell outside [4, 150] ms');
  return `median dwell ${med.toFixed(1)} ms`;
});

/** `cgevent model` without --u: the speed comes from the environment. */
function modelEnv(env, { from = [100, 100], rect = [900, 500, 40, 20], n = 30, seed = 'speed' } = {}) {
  const e = { ...process.env, ...env };
  for (const k of ['CHROME_BRIDGE_FITTS_U', 'CHROME_BRIDGE_MOUSE_SPEED']) if (!(k in env)) delete e[k];
  const r = JSON.parse(execFileSync(BIN, ['model', '--from', from.join(','), '--rect', rect.join(','),
    '--n', String(n), '--seed', seed, '--rate', String(RATE)], { encoding: 'utf8', env: e }));
  assert.equal(r.ok, true);
  return r;
}

check('CHROME_BRIDGE_MOUSE_SPEED divides T (u = 1/speed, default 1.8); CHROME_BRIDGE_FITTS_U still wins', () => {
  const s1 = modelEnv({ CHROME_BRIDGE_MOUSE_SPEED: '1' }), s2 = modelEnv({ CHROME_BRIDGE_MOUSE_SPEED: '2' });
  assert.deepEqual([s1.speed, s1.uSource, s2.speed], [1, 'CHROME_BRIDGE_MOUSE_SPEED', 2]);
  s1.plans.forEach((p, i) => {
    const ratio = p.T / s2.plans[i].T;
    assert.ok(Math.abs(ratio - 2) < 0.01, `plan ${i}: T ${p.T} at speed 1 vs ${s2.plans[i].T} at speed 2`);
  });
  const def = modelEnv({});
  assert.deepEqual([def.speed, def.uSource], [1.8, 'default']);
  def.plans.forEach((p, i) => assert.ok(Math.abs(s1.plans[i].T / p.T - 1.8) < 0.01, 'default speed is not 1.8'));
  const fu = modelEnv({ CHROME_BRIDGE_FITTS_U: '1', CHROME_BRIDGE_MOUSE_SPEED: '2' });
  assert.equal(fu.uSource, 'CHROME_BRIDGE_FITTS_U');
  fu.plans.forEach((p, i) => assert.ok(Math.abs(p.T - s1.plans[i].T) < 0.01, 'CHROME_BRIDGE_FITTS_U did not override the speed'));
});

check('cursor already inside the inner 80% → skippedMove, 0 points', () => {
  const plans = model({ from: [500, 500], rect: [450, 480, 100, 40], n: 20 });
  assert.ok(plans.every(p => p.skippedMove && p.points === 0 && p.submovements === 0));
});

check('same seed → identical plans; different seed → different plans', () => {
  const a = model({ from: [100, 100], rect: [900, 700, 30, 30], n: 5, seed: 'same' });
  const b = model({ from: [100, 100], rect: [900, 700, 30, 30], n: 5, seed: 'same' });
  const c = model({ from: [100, 100], rect: [900, 700, 30, 30], n: 5, seed: 'other' });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

if (failures.length) { console.log(`model tests FAILED: ${failures.length}`); process.exit(1); }
console.log('model tests passed');
