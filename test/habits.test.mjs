#!/usr/bin/env node
/* Habit recording (TODO.md C9): the user's own input RHYTHM, fitted into a statistical summary and used
 * as the timing parameters of later actions. Nothing here listens to the real keyboard or mouse:
 * `cgevent habits fit` feeds a synthetic event stream through the same recorder `habits record` uses,
 * sessions run with CGEVENT_DRYRUN=1 (nothing is posted), and the menu-bar panel is drawn offscreen.
 *
 *   (a) known parameters in → fitted values within ±15%
 *   (b) privacy: key codes, characters, modifiers and screen coordinates never reach the file
 *       (field names, content, and invariance under changing them); nothing but the summary is written
 *   (c) keys under Secure Event Input, this project's own events and other programs' events are not counted
 *   (d) a session's timing follows the summary; CHROME_BRIDGE_HABITS=off → defaults; out-of-range values are
 *       clamped; the safety floors hold
 *   (e) the menu-bar card draws its three states
 *
 * CGEVENT_BIN / CBMENU_BIN override the binaries (test/habits-faults.mjs runs this file against broken
 * builds), HABITS_ONLY=<regex> picks checks by name. Every check runs; failures are listed at the end. */
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.CGEVENT_BIN || path.join(HERE, '..', 'bin', 'cgevent');
const MENU = process.env.CBMENU_BIN || path.join(HERE, '..', 'bin', 'cbmenu');
const SESSION_TAG = 0x43425247, CLI_TAG = 0x43425243;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'habits-test-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const timed = (p, what, ms = 60000) => Promise.race([p, sleep(ms).then(() => { throw new Error(`no reply: ${what}`); })]);

const failures = [];
const children = new Set();
/** HABITS_ONLY=<regex>: run only the checks whose names match (test/habits-faults.mjs). */
const ONLY = process.env.HABITS_ONLY ? new RegExp(process.env.HABITS_ONLY) : null;
async function check(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try {
    const detail = await fn();
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
  } finally {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    children.clear();
  }
}

/* ------------------------------------------------------------------ synthetic input */

/** mulberry32: a seeded stream, so every run sees the same events. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next());
  return { next, gauss, logn: (m, s) => m * Math.exp(s * gauss()), uni: (lo, hi) => lo + (hi - lo) * next() };
}

const TEXT = 'zebra quartz vixen jumps over the lazy dog while the fox sleeps ';
const MODS = ['shift', 'cmd', 'ctrl', 'alt'];
const minJerk = (s) => s * s * s * (10 - 15 * s + 6 * s * s);

/**
 * A stream like the recorder's tap would see. Every key event carries a key code (0–50), the character and
 * modifier names; every pointer event absolute screen coordinates. `look` changes only those (code map,
 * characters, modifiers, coordinate offset) and never a time, so the summary must come out the same.
 */
function synth(o = {}) {
  const {
    seed = 7, keys = 1500, dwell = { median: 95, sigma: 0.25 }, flight = { median: 140, sigma: 0.5 }, longPause = 0.03,
    clicks = 200, u = 0.6, pressDwell = { median: 25, sigma: 0.6 }, hold = { median: 110, sigma: 0.25 }, bow = [0.03, 0.07],
    bursts = 80, wheelGap = { median: 45, sigma: 0.3 }, look = {}, t0 = 1000
  } = o;
  const r = rng(seed);
  const code = look.code || ((c) => c);
  const char = look.char || ((ch) => ch);
  const mods = look.mods || ((m) => m);
  const off = look.offset || { x: 0, y: 0 };
  const ev = [];
  let t = t0;
  // Typing: one key at a time, a 3 s break every 250 keys.
  const codeOf = new Map();
  for (let i = 0; i < keys; i++) {
    if (i && i % 250 === 0) t += 3000;
    const ch = TEXT[i % TEXT.length];
    if (!codeOf.has(ch)) codeOf.set(ch, codeOf.size % 51);
    const k = code(codeOf.get(ch));
    const m = r.next() < 0.1 ? [MODS[Math.floor(r.next() * 4)]] : [];
    if (m.length) ev.push({ t: t - 30, type: 'flagsChanged', keycode: code(56), flags: mods(m) });
    const d = r.logn(dwell.median, dwell.sigma);
    ev.push({ t, type: 'keyDown', keycode: k, char: char(ch), flags: mods(m), autorepeat: false });
    ev.push({ t: t + d, type: 'keyUp', keycode: k, char: char(ch), flags: mods(m) });
    let f = r.logn(flight.median, flight.sigma);
    if (r.next() < longPause) f += r.uni(300, 900);
    t += d + Math.min(f, 1800);
  }
  t += 3000;
  // Pointing: still, then one movement (minimum jerk, bowed), a pause, a click.
  let px = 900, py = 500;
  for (let i = 0; i < clicks; i++) {
    let tx, ty, D;
    do { tx = r.uni(60, 1800); ty = r.uni(60, 1060); D = Math.hypot(tx - px, ty - py); } while (D < 40);
    const ID = Math.log2(D / 32 + 1);
    const T = (21 + 225 * ID) * u * Math.exp(0.15 * r.gauss());
    const dw = Math.min(r.logn(pressDwell.median, pressDwell.sigma), 0.4 * T, 450);
    const moveMs = T - dw;
    const b = r.uni(bow[0], bow[1]) * (r.next() < 0.5 ? -1 : 1);
    const nx = -(ty - py) / D, ny = (tx - px) / D;
    const start = t;
    for (let k = 8; ; k += 8) {
      const last = k >= moveMs;
      const s = last ? 1 : minJerk(k / moveMs);
      const bo = b * D * 4 * s * (1 - s);
      ev.push({ t: start + (last ? moveMs : k), type: 'mouseMoved', x: px + (tx - px) * s + nx * bo + off.x, y: py + (ty - py) * s + ny * bo + off.y });
      if (last) break;
    }
    const down = start + T;
    ev.push({ t: down, type: 'leftMouseDown', x: tx + off.x, y: ty + off.y, flags: mods([]) });
    ev.push({ t: down + r.logn(hold.median, hold.sigma), type: 'leftMouseUp', x: tx + off.x, y: ty + off.y });
    px = tx; py = ty;
    t = down + 600 + r.uni(0, 600);
  }
  t += 3000;
  // Wheel: bursts of 3–8 notches, plus a trackpad flick that is not counted.
  for (let i = 0; i < bursts; i++) {
    const n = 3 + Math.floor(r.next() * 6);
    for (let k = 0; k < n; k++) {
      ev.push({ t, type: 'scrollWheel', dy: -1, x: 500 + off.x, y: 400 + off.y });
      if (k < n - 1) t += Math.min(r.logn(wheelGap.median, wheelGap.sigma), 190);
    }
    t += 1000 + r.uni(0, 2000);
  }
  for (let k = 0; k < 20; k++) ev.push({ t: t + k * 8, type: 'scrollWheel', continuous: true, momentum: k > 10, dy: -3 });
  return ev.sort((a, b) => a.t - b.t);
}

function writeEvents(name, events) {
  const f = path.join(TMP, `${name}.jsonl`);
  fs.writeFileSync(f, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return f;
}

function fit(events, name, env = {}) {
  const file = writeEvents(name, events);
  const out = path.join(TMP, `${name}.summary.json`);
  fs.rmSync(out, { force: true });
  const r = JSON.parse(execFileSync(BIN, ['habits', 'fit', file, '--out', out], { encoding: 'utf8', env: { ...process.env, ...env } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  return { r, out, text: fs.readFileSync(out, 'utf8'), summary: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

const within = (got, want, tol = 0.15) => Math.abs(got - want) <= tol * Math.abs(want);
const near = (got, want, tol, what) => assert.ok(within(got, want, tol), `${what}: ${got} vs ${want} (±${tol * 100}%)`);

/* ------------------------------------------------------------------ (a) fitting */

await check('(a) fit: typing dwell/flight median and sigma, Fitts u, click hold, press dwell, wheel interval within ±15% of the truth', async () => {
  const { summary: s } = fit(synth({ seed: 11, keys: 3000 }), 'truth');
  const t = s.typing, p = s.pointer;
  near(t.keyHoldMs.lognormal.median, 95, 0.15, 'key hold median');
  near(t.keyHoldMs.lognormal.sigma, 0.25, 0.15, 'key hold sigma');
  near(t.flightMs.lognormal.median, 140, 0.15, 'flight median');
  near(t.flightMs.lognormal.sigma, 0.5, 0.15, 'flight sigma');
  near(p.fitts.u, 0.6, 0.15, 'Fitts u');
  assert.equal(p.fitts.W, 32);
  near(p.clickHoldMs.lognormal.median, 110, 0.15, 'click hold median');
  near(p.clickHoldMs.lognormal.sigma, 0.25, 0.15, 'click hold sigma');
  near(p.pressDwellMs.lognormal.median, 25, 0.15, 'press dwell median');
  near(s.wheel.intervalMs.lognormal.median, 45, 0.15, 'wheel interval median');
  assert.equal(s.sampleCounts.movements, 200);
  assert.equal(s.sampleCounts.clickHoldMs, 200);
  assert.equal(s.sampleCounts.keyHoldMs, 3000);
  assert.equal(s.sampleCounts.flightMs, 3000 - 12, '11 breaks of 3 s and the last key have no flight');
  assert.equal(s.excluded.trackpadScroll, 20);
  return `u ${p.fitts.u}, flight ${t.flightMs.lognormal.median}/${t.flightMs.lognormal.sigma}, hold ${t.keyHoldMs.lognormal.median}/${t.keyHoldMs.lognormal.sigma}`;
});

await check('(a) fit: other truths move the fit with them (u 1.1, flight 260 ms σ0.35, hold 70 ms, long pauses 8%)', async () => {
  const { summary: s } = fit(synth({ seed: 12, keys: 4000, u: 1.1, flight: { median: 260, sigma: 0.35 }, dwell: { median: 70, sigma: 0.3 },
    longPause: 0.08, hold: { median: 160, sigma: 0.3 }, pressDwell: { median: 60, sigma: 0.5 } }), 'truth2');
  near(s.pointer.fitts.u, 1.1, 0.15, 'Fitts u');
  near(s.typing.flightMs.lognormal.median, 260, 0.15, 'flight median');
  near(s.typing.flightMs.lognormal.sigma, 0.35, 0.15, 'flight sigma');
  near(s.typing.keyHoldMs.lognormal.median, 70, 0.15, 'key hold median');
  near(s.typing.keyHoldMs.lognormal.sigma, 0.3, 0.15, 'key hold sigma');
  near(s.pointer.clickHoldMs.lognormal.median, 160, 0.15, 'click hold');
  near(s.pointer.pressDwellMs.lognormal.median, 60, 0.15, 'press dwell');
  // Long pauses: +300–900 ms on top of a flight (as the default model makes them).
  near(s.typing.longPause.ratio, 0.08, 0.15, 'long-pause share');
  return `long pauses ${s.typing.longPause.ratio}`;
});

await check('(a) movement shape: one submovement, speed peak near the middle (minimum jerk), deviation = the bow drawn', async () => {
  const { summary: s } = fit(synth({ seed: 13, keys: 0, bursts: 0, bow: [0.04, 0.06] }), 'shape');
  const p = s.pointer;
  assert.equal(p.submovements.p50, 1, JSON.stringify(p.submovements));
  assert.ok(p.submovements.share['1'] >= 0.9, JSON.stringify(p.submovements.share));
  assert.ok(Math.abs(p.peakFrac.p50 - 0.5) <= 0.06, `peak at ${p.peakFrac.p50}`);
  near(p.maxDeviationRatio.p50, 0.05, 0.15, 'deviation');
  assert.equal(s.typing.keyHoldMs, null, 'no keys: null, not a default');
  assert.equal(s.wheel.intervalMs, null);
  return `peak ${p.peakFrac.p50}, deviation ${p.maxDeviationRatio.p50}`;
});

await check('(a) too few samples → null (never a default dressed up as a fit)', async () => {
  const { summary: s } = fit(synth({ seed: 14, keys: 30, clicks: 10, bursts: 2 }), 'few');
  assert.equal(s.typing.keyHoldMs, null);
  assert.equal(s.typing.flightMs, null);
  assert.equal(s.typing.longPause, null);
  assert.equal(s.pointer.fitts, null);
  assert.equal(s.pointer.clickHoldMs, null);
  assert.equal(s.pointer.durationMs, null);
  assert.equal(s.wheel.intervalMs, null);
  assert.equal(s.sampleCounts.keyHoldMs, 30);
  assert.equal(s.sampleCounts.clickHoldMs, 10);
  assert.equal(s.version, 1);
  assert.equal(s.kind, 'chrome-bridge-habits');
  assert.equal(s.pointer.reactionMs, null);
  assert.ok(s.notFitted.spaceFactor && s.notFitted.reactionMs);
});

/* ------------------------------------------------------------------ (b) privacy */

const FORBIDDEN_NAME = /^(key|keys|keycode|keycodes|code|codes|char|chars|character|characters|unicode|text|string|x|y|xy|pos|position|positions|coord|coords|coordinate|coordinates|location|point|points|window|windows|app|apps|application|program|owner|title|pid|flags|modifier|modifiers|screen)$/i;
const FORBIDDEN_PART = /keycode|unicode|coord|window|title|modifier|location|position/i;
function walk(o, visit, at = '') {
  if (Array.isArray(o)) { o.forEach((v, i) => walk(v, visit, `${at}[${i}]`)); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { visit(k, v, `${at}.${k}`); walk(v, visit, `${at}.${k}`); }
  else visit(null, o, at);
}
const withoutTime = (s) => { const c = structuredClone(s); delete c.createdAt; return c; };
function tree(dir) {
  const out = {};
  const go = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, n.name);
      if (n.isDirectory()) go(f); else { const st = fs.statSync(f); out[f] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  go(dir);
  return out;
}

await check('(b) privacy: no key code, character, modifier or coordinate in the file — by field name, by content, and unchanged when they change', async () => {
  const base = synth({ seed: 21, keys: 800, clicks: 60, bursts: 20 });
  // Same times, different looks: key codes permuted, characters swapped, other modifiers, the screen shifted.
  const perm = Array.from({ length: 51 }, (_, i) => (i * 17 + 5) % 51);
  const looked = synth({ seed: 21, keys: 800, clicks: 60, bursts: 20, look: {
    code: (c) => perm[c], char: (ch) => (ch === ' ' ? '_' : String.fromCharCode(((ch.charCodeAt(0) - 97 + 13) % 26) + 97)),
    mods: (m) => m.map(x => ({ shift: 'cmd', cmd: 'alt', ctrl: 'shift', alt: 'ctrl' })[x]), offset: { x: 1000.5, y: -250.25 } } });
  assert.deepEqual(base.map(e => e.t), looked.map(e => e.t));
  const a = fit(base, 'priv-a'), b = fit(looked, 'priv-b');
  assert.deepEqual(withoutTime(b.summary), withoutTime(a.summary), 'the summary changed with key codes / characters / modifiers / coordinates');
  // By field name.
  const bad = [];
  walk(a.summary, (k, v, at) => { if (k && (FORBIDDEN_NAME.test(k) || FORBIDDEN_PART.test(k))) bad.push(at); });
  assert.deepEqual(bad, [], `fields that name codes / characters / positions: ${bad.join(', ')}`);
  // By content: no word of what was typed, no array of numbers (codes or points), only known strings.
  for (const w of ['zebra', 'quartz', 'vixen', 'jumps', 'lazy']) assert.ok(!a.text.includes(w), `typed word "${w}" in the file`);
  walk(a.summary, (k, v, at) => {
    if (Array.isArray(v)) assert.fail(`array in the summary at ${at}`);
    if (k !== null && typeof v === 'string' && !/^(createdAt|kind|note|fitts|movementSplit|submovements|lognormalFit|longPause|spaceFactor|punctFactor|reactionMs)$/.test(k)) assert.fail(`unexpected text at ${at}: ${v}`);
  });
  // Absolute positions: every number is the same after the screen moved by (1000.5, -250.25) (checked above).
  // The command's own output: counts only.
  assert.deepEqual(Object.keys(a.r).sort(), ['excluded', 'ok', 'out', 'sampleCounts', 'seconds']);
  return `${a.text.length} bytes, identical under the change`;
});

await check('(b) privacy: the summary is the only file written (output dir, HOME, TMPDIR, working dir), mode 600', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'iso-')), home = path.join(dir, 'home'), tmp = path.join(dir, 'tmp'), cwd = path.join(dir, 'cwd'), outDir = path.join(dir, 'out');
  for (const d of [home, tmp, cwd, outDir]) fs.mkdirSync(d);
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, synth({ seed: 22, keys: 300, clicks: 30, bursts: 10 }).map(e => JSON.stringify(e)).join('\n'));
  const realDefault = path.join(os.homedir(), 'Library/Application Support/chrome-bridge-mcp/habits.json');
  const realBefore = fs.existsSync(realDefault) ? fs.statSync(realDefault).mtimeMs : null;
  const before = tree(dir);
  const out = path.join(outDir, 'habits.json');
  const r = JSON.parse(execFileSync(BIN, ['habits', 'fit', file, '--out', out], { cwd, encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: tmp + '/', CHROME_BRIDGE_HABITS: path.join(home, 'unused.json') } }));
  assert.equal(r.ok, true);
  const after = tree(dir);
  const added = Object.keys(after).filter(f => !(f in before));
  const changed = Object.keys(before).filter(f => after[f] !== before[f]);
  assert.deepEqual(added, [out], `files written: ${added.join(', ')}`);
  assert.deepEqual(changed, [], `files changed: ${changed.join(', ')}`);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(realDefault) ? fs.statSync(realDefault).mtimeMs : null, realBefore, 'the real habits file was touched');
});

/* ------------------------------------------------------------------ (c) what is not counted */

function typingRun(n, { start = 0, tag, pid, secure, step = 220, hold = 90 } = {}) {
  const ev = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * step, k = i % 40;
    const extra = { ...(tag ? { userData: tag } : {}), ...(pid ? { sourcePid: pid } : {}), ...(secure ? { secure: true } : {}) };
    ev.push({ t, type: 'keyDown', keycode: k, char: 'a', ...extra }, { t: t + hold, type: 'keyUp', keycode: k, char: 'a', ...extra });
  }
  return ev;
}
function clickRun(n, { start = 0, tag, pid } = {}) {
  const ev = [], extra = { ...(tag ? { userData: tag } : {}), ...(pid ? { sourcePid: pid } : {}) };
  for (let i = 0; i < n; i++) {
    const t = start + i * 1500;
    for (let k = 0; k <= 40; k++) ev.push({ t: t + k * 8, type: 'mouseMoved', x: 100 + k * 10, y: 300 + i, ...extra });
    ev.push({ t: t + 360, type: 'leftMouseDown', x: 500, y: 300 + i, ...extra }, { t: t + 460, type: 'leftMouseUp', x: 500, y: 300 + i, ...extra });
  }
  return ev;
}
function wheelRun(n, { start = 0, tag } = {}) {
  const ev = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < 5; k++) ev.push({ t: start + i * 2000 + k * 40, type: 'scrollWheel', dy: -1, ...(tag ? { userData: tag } : {}) });
  return ev;
}

await check('(c) secure input, this project\'s events (session and CLI tags) and other programs\' events are not counted', async () => {
  const user = [...typingRun(200), ...clickRun(30, { start: 60_000 }), ...wheelRun(10, { start: 120_000 })];
  const noise = [
    ...typingRun(100, { start: 200_000, secure: true }),
    ...typingRun(100, { start: 240_000, tag: SESSION_TAG }),
    ...typingRun(50, { start: 280_000, tag: CLI_TAG }),
    ...typingRun(50, { start: 300_000, pid: 4242 }),
    ...clickRun(30, { start: 320_000, tag: SESSION_TAG }),
    ...clickRun(10, { start: 380_000, pid: 777 }),
    ...wheelRun(10, { start: 400_000, tag: SESSION_TAG }),
  ];
  const a = fit(user, 'excl-a').summary, b = fit([...user, ...noise].sort((x, y) => x.t - y.t), 'excl-b').summary;
  assert.deepEqual(a.sampleCounts, { keyHoldMs: 200, flightMs: 199, interKeyMs: 199, movements: 30, pressDwellMs: 30, clickHoldMs: 30, fitts: 30, wheelIntervalMs: 40, wheelBursts: 10 });
  assert.deepEqual(b.sampleCounts, a.sampleCounts, 'excluded events changed the sample counts');
  assert.equal(b.excluded.secureInputKeys, 200);
  assert.equal(b.excluded.ours, 300 + 30 * 43 + 50);
  assert.equal(b.excluded.otherSenders, 100 + 10 * 43);
  assert.deepEqual([b.typing, b.pointer, b.wheel], [a.typing, a.pointer, a.wheel], 'excluded events changed the statistics');
  return `excluded ${JSON.stringify(b.excluded)}`;
});

await check('(c) no flight across a secure-input stretch or an agent key in the middle of the user\'s typing', async () => {
  const run = typingRun(40);
  const plain = fit(run, 'chain-a').summary.sampleCounts;
  // Secure input switched on (and off) between keys 19 and 20: that gap is not a flight.
  const secured = fit([...run, { t: 19 * 220 + 150, type: 'secure' }].sort((x, y) => x.t - y.t), 'chain-b').summary.sampleCounts;
  // One agent key between keys 9 and 10: neither 9 → agent nor agent → 10 is the user's flight.
  const agent = fit([...run, { t: 9 * 220 + 120, type: 'keyDown', keycode: 3, userData: SESSION_TAG }, { t: 9 * 220 + 160, type: 'keyUp', keycode: 3, userData: SESSION_TAG }]
    .sort((x, y) => x.t - y.t), 'chain-c').summary.sampleCounts;
  assert.deepEqual([plain.flightMs, plain.keyHoldMs], [39, 40]);
  assert.deepEqual([secured.flightMs, secured.keyHoldMs], [38, 40]);
  assert.deepEqual([agent.flightMs, agent.keyHoldMs], [38, 40]);
});

await check('(c) key repeat (a key held down) and drags are not keystrokes or clicks', async () => {
  const ev = [...typingRun(60)];
  ev.push({ t: 20_000, type: 'keyDown', keycode: 7 }, ...Array.from({ length: 10 }, (_, i) => ({ t: 20_500 + i * 33, type: 'keyDown', keycode: 7, autorepeat: true })),
    { t: 21_000, type: 'keyUp', keycode: 7 });
  ev.push({ t: 30_000, type: 'leftMouseDown', x: 10, y: 10 }, ...Array.from({ length: 20 }, (_, i) => ({ t: 30_010 + i * 8, type: 'leftMouseDragged', x: 10 + i, y: 10 })),
    { t: 30_400, type: 'leftMouseUp', x: 30, y: 10 });
  const s = fit(ev.sort((x, y) => x.t - y.t), 'repeat').summary;
  assert.equal(s.sampleCounts.keyHoldMs, 60);
  assert.equal(s.excluded.autoRepeat, 10);
  assert.equal(s.sampleCounts.clickHoldMs, 0);
});

/* ------------------------------------------------------------------ (d) the session uses it */

function profile({ u, keyHold, flight, longPause, pressDwell, clickHold, wheel, bow, peak, use = true, version = 1, n = 500 } = {}) {
  const d = (ln) => (ln ? { n, p10: ln.median, p25: ln.median, p50: ln.median, p75: ln.median, p90: ln.median, lognormal: ln } : null);
  return {
    kind: 'chrome-bridge-habits', version, createdAt: '2026-10-06T06:00:00Z', recordedSeconds: 180, use,
    typing: { keyHoldMs: d(keyHold), flightMs: d(flight), interKeyMs: null,
      longPause: longPause != null ? { n, ratio: longPause, thresholdMs: 500 } : null },
    pointer: { fitts: u != null ? { n: 100, u, p25: u, p75: u, W: 32 } : null, pressDwellMs: d(pressDwell), clickHoldMs: d(clickHold),
      maxDeviationRatio: bow ? { n: 100, p10: bow[0], p25: bow[0], p50: (bow[0] + bow[1]) / 2, p75: bow[1], p90: bow[1] } : null,
      peakFrac: peak != null ? { n: 100, p10: peak, p25: peak, p50: peak, p75: peak, p90: peak } : null },
    wheel: { intervalMs: d(wheel) }
  };
}
let pn = 0;
function profileFile(p) {
  const f = path.join(TMP, `profile-${++pn}.json`);
  fs.writeFileSync(f, JSON.stringify(p));
  return f;
}
const show = (env) => JSON.parse(execFileSync(BIN, ['habits', 'show'], { encoding: 'utf8', env: { ...process.env, ...env } }));

/** A dry-run session (nothing posted). `habits`: a profile path, 'off', or undefined (= a path that does not exist). */
async function session(habits, seed, { held = false } = {}) {
  const child = spawn(BIN, ['session'], {
    env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: seed, CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.habits${process.pid}.${++pn}`,
      CHROME_BRIDGE_HABITS: habits ?? path.join(TMP, 'none.json'), CHROME_BRIDGE_MOUSE_SPEED: '', CHROME_BRIDGE_FITTS_U: '' },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  children.add(child);
  const waiting = new Map();
  let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const r = JSON.parse(l);
    if (r.op === 'end') waiting.get('end')?.(r); else { waiting.get(r.id)?.(r); waiting.delete(r.id); }
  });
  const send = (o) => { const n = ++id; const p = new Promise(res => waiting.set(n, res)); child.stdin.write(JSON.stringify({ ...o, id: n }) + '\n'); return timed(p, o.op); };
  if (held) assert.equal((await send({ op: 'hold', veil: { label: 'x', panel: { who: 't', color: 1, task: '', step: '', action: 'x', stages: [{ key: 'hold', label: 'h', est: 100 }], chars: 0 } } })).ok, true);
  const begin = await send({ op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 1400, h: 900 }, rateMs: 2, takeover: held });
  if (begin.dryRun !== true) { child.kill('SIGKILL'); throw new Error('not a dry run; stopping'); }
  const end = () => { const p = timed(new Promise(res => waiting.set('end', res)), 'end'); child.stdin.write('{"op":"end"}\n'); return p; };
  return { send, end, begin };
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function keyTimes(posted) {
  const k = posted.filter(e => e.type === 'keyDown' || e.type === 'keyUp');
  const holds = [], flights = [];
  for (let i = 0; i < k.length; i++) {
    if (k[i].type === 'keyDown' && k[i + 1]?.type === 'keyUp') holds.push(k[i + 1].t - k[i].t);
    if (k[i].type === 'keyUp' && k[i + 1]?.type === 'keyDown') flights.push(k[i + 1].t - k[i].t);
  }
  return { holds, flights, total: k.at(-1).t - k[0].t };
}
async function typeWith(habits, text = 'abcdefghijklmnop', seed = 'ht1') {
  const s = await session(habits, seed);
  const r = await s.send({ op: 'type', text, firstDelay: false });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  await s.end();
  return { ...keyTimes(r.posted), begin: s.begin };
}
async function clickWith(habits, seed = 'hc1', held = false, speedUps = 0) {
  const s = await session(habits, seed, { held });
  for (let i = 0; i < speedUps; i++) await s.send({ op: '_inject', kind: 'speedUp' });
  await s.send({ op: '_fake', cursor: { x: 60, y: 60 } });
  const c = await s.send({ op: 'click', rect: { x: 1100, y: 700, w: 40, h: 20 }, aim: null, clickCount: 1 });
  assert.equal(c.ok, true, JSON.stringify(c).slice(0, 200));
  return { c, s };
}

await check('(d) habits show: each parameter says default or habits; the session and model say which were applied', async () => {
  const f = profileFile(profile({ u: 0.8, flight: { median: 220, sigma: 0.4 }, clickHold: { median: 130, sigma: 0.3 } }));
  const r = show({ CHROME_BRIDGE_HABITS: f, CHROME_BRIDGE_MOUSE_SPEED: '', CHROME_BRIDGE_FITTS_U: '' });
  assert.equal(r.status, 'loaded');
  const src = Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, v.source]));
  assert.deepEqual(src, { fittsU: 'habits', keyHoldMs: 'default', flightMs: 'habits', longPause: 'default', spaceFactor: 'default', punctFactor: 'default',
    pressDwellMs: 'default', clickHoldMs: 'habits', wheelIntervalMs: 'default', bow: 'default', peakScale: 'default', reactionMs: 'default', submovements: 'default' });
  assert.equal(r.params.fittsU.value, 0.8);
  assert.equal(r.params.flightMs.median, 220);
  assert.equal(r.params.keyHoldMs.median, 95);
  assert.deepEqual(r.floors, { keyHoldMs: 30, mouseHoldMs: 40, pressDwellMs: 4 });
  const s = await session(f, 'hs1');
  assert.deepEqual(s.begin.habits, { status: 'loaded', applied: ['clickHoldMs', 'fittsU', 'flightMs'] });
  await s.end();
  const m = JSON.parse(execFileSync(BIN, ['model', '--from', '100,100', '--rect', '900,600,40,20', '--n', '5'], { encoding: 'utf8', env: { ...process.env, CHROME_BRIDGE_HABITS: f, CHROME_BRIDGE_MOUSE_SPEED: '', CHROME_BRIDGE_FITTS_U: '' } }));
  assert.deepEqual([m.u, m.uSource], [0.8, 'habits']);
  // An explicit environment setting still wins over the habit.
  const e = JSON.parse(execFileSync(BIN, ['model', '--from', '100,100', '--rect', '900,600,40,20', '--n', '5'], { encoding: 'utf8', env: { ...process.env, CHROME_BRIDGE_HABITS: f, CHROME_BRIDGE_MOUSE_SPEED: '2', CHROME_BRIDGE_FITTS_U: '' } }));
  assert.deepEqual([e.u, e.uSource], [0.5, 'CHROME_BRIDGE_MOUSE_SPEED']);
});

await check('(d) a fitted summary drives the session end to end: fit → file → show reads the fitted values', async () => {
  const { out, summary } = fit(synth({ seed: 31, keys: 1200, clicks: 120, u: 0.9, flight: { median: 200, sigma: 0.45 } }), 'e2e');
  const r = show({ CHROME_BRIDGE_HABITS: out, CHROME_BRIDGE_MOUSE_SPEED: '', CHROME_BRIDGE_FITTS_U: '' });
  assert.equal(r.status, 'loaded');
  assert.equal(r.params.fittsU.value, summary.pointer.fitts.u);
  assert.equal(r.params.flightMs.median, summary.typing.flightMs.lognormal.median);
  assert.equal(r.params.keyHoldMs.median, summary.typing.keyHoldMs.lognormal.median);
  for (const k of ['fittsU', 'keyHoldMs', 'flightMs', 'longPause', 'pressDwellMs', 'clickHoldMs', 'wheelIntervalMs', 'bow', 'peakScale']) assert.equal(r.params[k].source, 'habits', k);
});

await check('(d) typing follows the summary: flight median doubled → key-to-key gaps double and the text takes longer; key hold doubled → keys held twice as long', async () => {
  const base = await typeWith(undefined);
  assert.equal(base.begin.habits.status, 'missing');
  const slow = await typeWith(profileFile(profile({ flight: { median: 280, sigma: 0.5 } })));
  const heavy = await typeWith(profileFile(profile({ keyHold: { median: 190, sigma: 0.25 } })));
  const rf = median(slow.flights) / median(base.flights), rh = median(heavy.holds) / median(base.holds);
  assert.ok(rf > 1.7 && rf < 2.3, `flight ratio ${rf}`);
  assert.ok(slow.total > base.total * 1.4, `typing took ${slow.total} vs ${base.total} ms`);
  assert.ok(rh > 1.7 && rh < 2.3, `hold ratio ${rh}`);
  return `flight ×${rf.toFixed(2)}, hold ×${rh.toFixed(2)}, ${Math.round(base.total)} → ${Math.round(slow.total)} ms`;
});

await check('(d) pointing follows the summary: u 1.0 vs default 1/1.8 → the same planned move takes 1.8× as long; click hold follows', async () => {
  const a = await clickWith(undefined, 'hc1'); await a.s.end();
  const b = await clickWith(profileFile(profile({ u: 1.0, clickHold: { median: 200, sigma: 0.25 } })), 'hc1'); await b.s.end();
  const rp = b.c.planned.T / a.c.planned.T, rt = b.c.timing.T / a.c.timing.T, rh = b.c.timing.hold / a.c.timing.hold;
  assert.ok(Math.abs(rp - 1.8) < 0.02, `planned ratio ${rp}`);
  assert.ok(rt > 1.5 && rt < 2.1, `measured ratio ${rt}`);
  assert.ok(rh > 1.7 && rh < 2.4, `hold ratio ${rh}`);
  return `T ${a.c.timing.T} → ${b.c.timing.T} ms, hold ${a.c.timing.hold} → ${b.c.timing.hold} ms`;
});

await check('(d) wheel cadence, path bow, speed-peak timing and the pause before a press follow the summary', async () => {
  const f = profileFile(profile({ wheel: { median: 100, sigma: 0.3 }, bow: [0.10, 0.14], peak: 0.2, pressDwell: { median: 60, sigma: 0.3 } }));
  const gaps = async (h) => {
    const s = await session(h, 'hw1');
    const r = await s.send({ op: 'wheel', notches: 8, dir: 'down' });
    await s.end();
    const w = r.posted.filter(e => e.type === 'scrollWheel');
    return median(w.slice(1).map((e, i) => e.t - w[i].t));
  };
  const g0 = await gaps(undefined), g1 = await gaps(f);
  assert.ok(g1 / g0 > 2 && g1 / g0 < 3, `wheel gap ${g0} → ${g1} ms`);
  const model = (h) => JSON.parse(execFileSync(BIN, ['model', '--from', '100,100', '--rect', '1100,700,60,30', '--n', '300', '--seed', 'hm', '--u', '1'],
    { encoding: 'utf8', env: { ...process.env, CHROME_BRIDGE_HABITS: h } })).plans;
  const m0 = model(path.join(TMP, 'none.json')), m1 = model(f);
  const bow0 = median(m0.map(p => p.maxPerpFrac)), bow1 = median(m1.map(p => p.maxPerpFrac));
  const pk0 = median(m0.map(p => p.peakFrac)), pk1 = median(m1.map(p => p.peakFrac));
  const dw0 = median(m0.map(p => p.dwell)), dw1 = median(m1.map(p => p.dwell));
  assert.ok(bow0 > 0.03 && bow0 < 0.07 && bow1 > 0.09 && bow1 < 0.15, `bow ${bow0} → ${bow1}`);
  assert.ok(pk1 < pk0 * 0.7, `peak ${pk0} → ${pk1}`);
  assert.ok(Math.abs(dw1 - 60) < 9 && dw0 < 30, `press dwell ${dw0} → ${dw1}`);
  return `wheel ${g0}→${g1} ms, bow ${bow0.toFixed(3)}→${bow1.toFixed(3)}, peak ${pk0}→${pk1}, dwell ${dw0}→${dw1}`;
});

await check('(d) CHROME_BRIDGE_HABITS=off, use:false, a wrong version → every default (same seed, same plan as with no file)', async () => {
  const f = profileFile(profile({ u: 1.0, flight: { median: 280, sigma: 0.5 } }));
  const none = await clickWith(undefined, 'hc2'); await none.s.end();
  const off = await clickWith('off', 'hc2'); await off.s.end();
  const disabled = await clickWith(profileFile(profile({ u: 1.0, use: false })), 'hc2'); await disabled.s.end();
  const v2 = await clickWith(profileFile(profile({ u: 1.0, version: 2 })), 'hc2'); await v2.s.end();
  const on = await clickWith(f, 'hc2'); await on.s.end();
  assert.deepEqual([off.s.begin.habits, disabled.s.begin.habits, v2.s.begin.habits],
    [{ status: 'off', applied: [] }, { status: 'disabled', applied: [] }, { status: 'bad_version', applied: [] }]);
  for (const x of [off, disabled, v2]) assert.equal(x.c.planned.T, none.c.planned.T);
  assert.ok(on.c.planned.T > none.c.planned.T * 1.7);
  const sh = show({ CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_MOUSE_SPEED: '', CHROME_BRIDGE_FITTS_U: '' });
  assert.equal(sh.status, 'off');
  assert.ok(Object.values(sh.params).every(p => p.source === 'default'), JSON.stringify(sh.params));
});

await check('(d) out-of-range values are clamped (u ≤ 2, flight median ≤ 600 ms, …) and say so', async () => {
  const f = profileFile(profile({ u: 50, flight: { median: 100000, sigma: 5 }, keyHold: { median: 1, sigma: 0.01 }, clickHold: { median: 0.5, sigma: 3 },
    pressDwell: { median: 0.001, sigma: 0.01 }, wheel: { median: 9999, sigma: 9 }, longPause: 0.9, bow: [0.9, 2], peak: 5 }));
  const p = show({ CHROME_BRIDGE_HABITS: f, CHROME_BRIDGE_MOUSE_SPEED: '', CHROME_BRIDGE_FITTS_U: '' }).params;
  assert.deepEqual([p.fittsU.value, p.fittsU.clamped], [2, true]);
  assert.deepEqual([p.flightMs.median, p.flightMs.sigma, p.flightMs.clamped], [600, 1.2, true]);
  assert.deepEqual([p.keyHoldMs.median, p.keyHoldMs.sigma], [40, 0.1]);
  assert.deepEqual([p.clickHoldMs.median, p.clickHoldMs.sigma], [50, 0.8]);
  assert.equal(p.pressDwellMs.median, 4);
  assert.equal(p.wheelIntervalMs.median, 180);
  assert.equal(p.longPause.ratio, 0.15);
  assert.deepEqual([p.bow.lo, p.bow.hi], [0.15, 0.25]);
  assert.equal(p.peakScale.value, 1.5);
  assert.ok(p.flightMs.hi <= 3000 && p.keyHoldMs.lo >= 30 && p.clickHoldMs.lo >= 40 && p.pressDwellMs.lo >= 4);
  // And the session really uses the clamped value: u 50 would be a 90× slower move; 2 is 3.6×.
  const a = await clickWith(undefined, 'hc3'); await a.s.end();
  const b = await clickWith(f, 'hc3'); await b.s.end();
  const ratio = b.c.planned.T / a.c.planned.T;
  assert.ok(Math.abs(ratio - 3.6) < 0.05, `planned ratio ${ratio}`);
  const t = await typeWith(f, 'abcd', 'ht3');
  assert.ok(Math.max(...t.flights) < 3000 + 900 + 100, `a flight of ${Math.max(...t.flights)} ms (cap 3000 + a long pause ≤ 900)`);
});

await check('(d) the safety floors hold with the smallest habits at 3×: a key held ≥ 30 ms, the button ≥ 40 ms, ≥ 4 ms before a press', async () => {
  const f = profileFile(profile({ keyHold: { median: 1, sigma: 0.01 }, clickHold: { median: 1, sigma: 0.01 }, pressDwell: { median: 0.001, sigma: 0.01 },
    flight: { median: 1, sigma: 0.01 }, u: 0.01 }));
  let minKey = Infinity, minHold = Infinity, minDwell = Infinity;
  for (const seed of ['fl1', 'fl2', 'fl3']) {
    const { c, s } = await clickWith(f, seed, true, 3);
    assert.equal(c.panel?.speed ?? 3, 3);
    const moves = c.posted.filter(e => e.type === 'mouseMoved');
    const down = c.posted.find(e => e.type === 'leftMouseDown'), up = c.posted.find(e => e.type === 'leftMouseUp');
    minDwell = Math.min(minDwell, down.t - moves.at(-1).t);
    minHold = Math.min(minHold, up.t - down.t);
    const t = await s.send({ op: 'type', text: 'abcdef', firstDelay: false });
    minKey = Math.min(minKey, ...keyTimes(t.posted).holds);
    await s.end();
  }
  assert.ok(minDwell >= 3.5, `dwell ${minDwell} ms`);
  assert.ok(minHold >= 39, `button held ${minHold} ms`);
  assert.ok(minKey >= 29, `key held ${minKey} ms`);
  return `min dwell ${minDwell.toFixed(1)} ms, button ${minHold.toFixed(0)} ms, key ${minKey.toFixed(0)} ms`;
});

await check('(d) use on/off and delete: the switch survives a new recording, delete removes only the summary', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'use-'));
  const f = path.join(dir, 'habits.json');
  const env = { ...process.env, CHROME_BRIDGE_HABITS: f };
  const file = writeEvents('use', synth({ seed: 41, keys: 200, clicks: 20, bursts: 5 }));
  execFileSync(BIN, ['habits', 'fit', file, '--out', f], { env });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).use, true);
  assert.equal(JSON.parse(execFileSync(BIN, ['habits', 'use', 'off'], { encoding: 'utf8', env })).use, false);
  assert.equal(show({ CHROME_BRIDGE_HABITS: f }).status, 'disabled');
  execFileSync(BIN, ['habits', 'fit', file, '--out', f], { env });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).use, false, 'a new recording turned the switch back on');
  execFileSync(BIN, ['habits', 'use', 'on'], { env });
  assert.equal(show({ CHROME_BRIDGE_HABITS: f }).status, 'loaded');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'keep');
  assert.equal(JSON.parse(execFileSync(BIN, ['habits', 'delete'], { encoding: 'utf8', env })).deleted, true);
  assert.deepEqual(fs.readdirSync(dir), ['other.txt']);
  assert.equal(show({ CHROME_BRIDGE_HABITS: f }).status, 'missing');
});

/* ------------------------------------------------------------------ (e) the menu-bar card */

// The card is on the panel's 「设置」 page since panel-settings (2026-10-14).
await check('(e) menu bar --snapshot draws the habits card: not recorded / recording / recorded (and reads a real summary)', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'menu-'));
  const hashes = {};
  for (const st of ['none', 'recording', 'recorded']) {
    const out = path.join(dir, `${st}.png`);
    const r = JSON.parse(execFileSync(MENU, ['--snapshot', out, '--page', 'settings', '--habits', st], { encoding: 'utf8', timeout: 30000, env: { ...process.env, CHROME_BRIDGE_LOCK: path.join(dir, 'lock') } }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.habits.state, st);
    assert.ok(fs.statSync(out).size > 30_000, `${st}: ${fs.statSync(out).size} bytes`);
    hashes[st] = crypto.createHash('sha1').update(fs.readFileSync(out)).digest('hex');
  }
  assert.equal(new Set(Object.values(hashes)).size, 3, 'two states drew the same picture');
  // Without --habits it reads the summary file (read-only): the numbers shown are the file's.
  const { out: f, summary } = fit(synth({ seed: 51, keys: 600, clicks: 60, u: 0.45 }), 'menu');
  const before = fs.readFileSync(f, 'utf8');
  const r = JSON.parse(execFileSync(MENU, ['--snapshot', path.join(dir, 'file.png'), '--page', 'settings'], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHROME_BRIDGE_HABITS: f, CHROME_BRIDGE_LOCK: path.join(dir, 'lock') } }));
  assert.equal(r.habits.state, 'recorded');
  assert.equal(r.habits.interKeyMs, Math.round(summary.typing.interKeyMs.p50));
  assert.equal(r.habits.speedX, Math.round(((1 / 1.8) / summary.pointer.fitts.u) * 10) / 10);
  assert.equal(r.habits.use, true);
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'the snapshot changed the summary');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['file.png', 'none.png', 'recorded.png', 'recording.png'], 'the snapshot wrote other files');
  return `typing gap ${r.habits.interKeyMs} ms, speed ×${r.habits.speedX}`;
});

fs.rmSync(TMP, { recursive: true, force: true });
if (failures.length) { console.log(`habits tests FAILED: ${failures.length}`); process.exit(1); }
console.log('habits tests passed');
