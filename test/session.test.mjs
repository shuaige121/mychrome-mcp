#!/usr/bin/env node
/* Input session protocol (docs/impl-contract.md §1, §6) in DRY-RUN mode only:
 * CGEVENT_DRYRUN=1 posts nothing, uses a fake tap (`_inject`), fake window /
 * frontmost / cursor state (`_fake`) and the private pasteboard
 * com.chromebridge.dryrun (`_pb`). Every event that WOULD be posted comes back
 * in `posted`. CGEVENT_BIN overrides the binary (used to prove the checks fail
 * on a deliberately broken build). Every check runs; failures are listed at
 * the end. */
import './isolate-settings.mjs';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import os from 'node:os';

// These check the built-in timing defaults; the user's recorded habits (test/habits.test.mjs) stay out.
process.env.CHROME_BRIDGE_HABITS = 'off';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.CGEVENT_BIN || path.join(HERE, '..', 'bin', 'cgevent');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** A reply that never comes fails the check instead of hanging the run. */
const timed = (p, what, ms = 15000) => Promise.race([p, sleep(ms).then(() => { throw new Error(`no reply: ${what}`); })]);

const CHROME = 42, WIN = 7, OTHER_WIN = 99;
/** `npm run test:timing`: the scheduler-dependent numbers too (meaningful only on an idle machine). */
const STRICT_TIMING = process.env.CHROME_BRIDGE_TIMING_STRICT === '1';
if (STRICT_TIMING && os.loadavg()[0] > 2) {
  console.log(`timing checks skipped: load average ${os.loadavg()[0].toFixed(2)} > 2 (they measure the scheduler, not the code)`);
  process.exit(0);
}
const BOUNDS = { x: 0, y: 0, w: 1200, h: 800 };
const TARGET = { x: 600, y: 400, w: 80, h: 30 };

const children = new Set();
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`);
  } finally {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    children.clear();
  }
}

// A pasteboard of this run's own, so parallel runs cannot see each other's items.
let pbSerial = 0;
const pbName = () => `com.chromebridge.dryrun.test${process.pid}.${++pbSerial}`;

async function open(seed = 's1', beginExtra = {}, { begin = true } = {}) {
  const child = spawn(BIN, ['session'], {
    env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: seed, CGEVENT_DRYRUN_PASTEBOARD: pbName() },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.add(child);
  const waiting = new Map();
  const replies = [];
  let nextId = 1;
  const exited = new Promise(res => child.on('exit', (code, sig) => res({ code, sig })));
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const r = JSON.parse(line);
    replies.push(r);
    if (r.op === 'end') { waiting.get('end')?.(r); return; }
    waiting.get(r.id)?.(r);
    waiting.delete(r.id);
  });
  const s = {
    child, replies, exited,
    send(obj) {
      const id = nextId++;
      const p = new Promise(res => waiting.set(id, res));
      child.stdin.write(JSON.stringify({ ...obj, id }) + '\n');
      return timed(p, obj.op);
    },
    ended: () => timed(new Promise(res => waiting.set('end', res)), 'end'),
    async end() {
      const p = s.ended();
      child.stdin.write(JSON.stringify({ op: 'end' }) + '\n');
      const r = await p;
      const x = await timed(exited, 'exit');
      assert.equal(x.code, 0, 'session exits 0');
      return r;
    },
  };
  if (!begin) {
    const status = await s.send({ op: 'status' });
    if (!Array.isArray(status.posted)) { child.kill('SIGKILL'); throw new Error('session is not in dry-run mode; refusing to continue'); }
    assert.equal(status.ok, true);
    return s;
  }
  const b = await s.send({ op: 'begin', chromePid: CHROME, window: WIN, windowBounds: BOUNDS, rateMs: 2, ...beginExtra });
  if (b.dryRun !== true) { child.kill('SIGKILL'); throw new Error('session is not in dry-run mode; refusing to continue'); }
  assert.equal(b.ok, true);
  return s;
}

const types = (posted) => posted.map(e => e.type);
const count = (posted, type) => posted.filter(e => e.type === type).length;
const lastFlags = (posted) => posted.filter(e => e.type === 'flagsChanged').at(-1)?.flags;

// ── guard right before the press ───────────────────────────────────────────
await check('click: moves on a 2 ms deadline cadence, dwells ≥4 ms, presses at the landing point; second click skips the move', async () => {
  // Control for the next check: a `_fake` at dwellEnd that changes nothing lets the press happen.
  const s = await open();
  await s.send({ op: '_fake', cursor: { x: 100, y: 100 } });
  const f = s.send({ op: '_fake', topWindow: WIN, at: 'dwellEnd' });
  const r = await s.send({ op: 'click', rect: TARGET, aim: null, clickCount: 1 });
  await f;
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.equal(count(r.posted, 'leftMouseDown'), 1);
  assert.equal(count(r.posted, 'leftMouseUp'), 1);
  const land = r.landed;
  assert.ok(land.x >= TARGET.x && land.x <= TARGET.x + TARGET.w && land.y >= TARGET.y && land.y <= TARGET.y + TARGET.h);
  const moves = r.posted.filter(e => e.type === 'mouseMoved');
  assert.deepEqual({ x: moves.at(-1).x, y: moves.at(-1).y }, land, 'last move is the landing point');
  const gaps = moves.slice(1).map((e, i) => e.t - moves[i].t).sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1];
  assert.ok(med >= 1.7 && med <= 2.5, `median move interval ${med} ms`);
  // What runMove promises under any load: late → jump to the latest due point, never a catch-up
  // burst. So never more points than the timeline has, and a short gap never follows a short gap
  // twice in a row (a jump makes at most one). Scheduler-dependent numbers are in test:timing.
  const moveMs = r.planned.primary + r.planned.corrections.reduce((a, b) => a + b, 0);
  assert.ok(moves.length <= Math.ceil(moveMs / 2) + 1, `${moves.length} points for a ${moveMs} ms move at 2 ms: caught up in a burst`);
  const inOrder = moves.slice(1).map((e, i) => e.t - moves[i].t);
  const runs = inOrder.some((g, i) => i >= 2 && g < 0.5 && inOrder[i - 1] < 0.5 && inOrder[i - 2] < 0.5);
  assert.ok(!runs, 'three short intervals in a row: a catch-up burst');
  const down = r.posted.find(e => e.type === 'leftMouseDown');
  assert.ok(down.t - moves.at(-1).t >= 3.5, 'dwell ≥ 4 ms between the last move and the press');
  if (STRICT_TIMING) {
    assert.ok(gaps.filter(g => g < 0.5).length <= 3, `bursts: ${gaps.filter(g => g < 0.5).length} intervals < 0.5 ms`);
    assert.ok(down.t - moves.at(-1).t <= r.planned.dwell + 25, `dwell ${down.t - moves.at(-1).t} ms, planned ${r.planned.dwell}`);
  }
  assert.ok(r.timing.dwell >= 3.5 && r.timing.hold >= 49, JSON.stringify(r.timing));
  const r2 = await s.send({ op: 'click', rect: TARGET });
  assert.equal(r2.skippedMove, true);
  assert.equal(count(r2.posted, 'mouseMoved'), 0);
  await s.end();
  return `${moves.length} moves, median interval ${med.toFixed(2)} ms`;
});

await check('a _fake change between dwell and down blocks the press (window, frontmost, cursor, modifier)', async () => {
  for (const [change, why] of [[{ topWindow: OTHER_WIN }, 'window_not_top'],
                               [{ frontPid: 1 }, 'not_frontmost'],
                               [{ cursor: { x: 5, y: 5 } }, 'cursor_moved'],
                               [{ userFlags: ['cmd'] }, 'modifier_held']]) {
    const s = await open();
    await s.send({ op: '_fake', cursor: { x: 100, y: 100 } });
    const f = s.send({ op: '_fake', ...change, at: 'dwellEnd' });
    const r = await s.send({ op: 'click', rect: TARGET });
    await f;
    assert.ok(count(r.posted, 'mouseMoved') > 0, 'the movement happened');
    assert.equal(count(r.posted, 'leftMouseDown'), 0, `pressed despite ${why}`);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'guard');
    assert.equal(r.why, why);
    await s.end();
  }
});

await check('key: a frontmost change during the pre-press pause blocks the keyDown', async () => {
  const s = await open();
  const r = s.send({ op: 'key', name: 'return' });
  await sleep(40);
  await s.send({ op: '_fake', frontPid: 1 });
  const k = await r;
  assert.equal(count(k.posted, 'keyDown'), 0, 'keyDown posted');
  assert.equal(k.why, 'not_frontmost');
  await s.end();
});

await check('codex2-7: a reaction pause (≥150 ms, median ≈200) comes before the movement, also when it is skipped', async () => {
  const s = await open('react');
  const reactions = [];
  for (let i = 0; i < 10; i++) {
    // Far from the target on even rounds (a movement), on it on odd ones (skippedMove).
    const at = i % 2 ? { x: TARGET.x + TARGET.w / 2, y: TARGET.y + TARGET.h / 2 } : { x: 100, y: 100 };
    const mark = await s.send({ op: '_fake', cursor: at });
    const r = await s.send({ op: 'click', rect: TARGET });
    assert.equal(r.ok, true);
    assert.equal(r.skippedMove, i % 2 === 1);
    const first = r.posted[0];
    assert.ok(first.t - mark.t >= 149, `first event ${first.type} only ${(first.t - mark.t).toFixed(1)} ms after the request`);
    assert.ok(r.timing.reaction >= 149, JSON.stringify(r.timing));
    reactions.push(r.timing.reaction);
  }
  const mv = await s.send({ op: '_fake', cursor: { x: 100, y: 100 } });
  const m = await s.send({ op: 'move', to: { x: 700, y: 500 }, rect: { x: 690, y: 490, w: 20, h: 20 } });
  assert.ok(m.posted[0].t - mv.t >= 149 && m.timing.reaction >= 149, 'move: no reaction pause');
  await s.end();
  const med = [...reactions].sort((a, b) => a - b)[reactions.length >> 1];
  assert.ok(med >= 150 && med <= 280, `median reaction ${med} ms`);
  return `median reaction ${med.toFixed(0)} ms`;
});

// ── interruption ───────────────────────────────────────────────────────────
await check('codex2-1: after a first move the session keeps watching; a later click sets button:true; epoch is wall-clock', async () => {
  const s = await open();
  const t0 = Date.now();
  await s.send({ op: '_inject', kind: 'move' });
  let st = await s.send({ op: 'status' });
  assert.equal(st.interrupted.kind, 'move');
  assert.equal(st.interrupted.button, undefined);
  assert.ok(Math.abs(st.interrupted.epoch - t0) < 2000, `epoch ${st.interrupted.epoch} vs ${t0}`);
  await s.send({ op: '_inject', kind: 'key' });
  await s.send({ op: '_inject', kind: 'button' });
  st = await s.send({ op: 'status' });
  assert.deepEqual([st.interrupted.kind, st.interrupted.button], ['move', true], 'the first kind stays, the click is added');
  const end = await s.end();
  assert.equal(end.interrupted.button, true);
});

await check('_inject during typing stops further keys, releases Shift, and stays interrupted', async () => {
  // Deterministic: the user's key arrives right after our Shift went down for "B".
  const s = await open();
  const inj = s.send({ op: '_inject', kind: 'key', afterPosted: 3 });
  const r = await s.send({ op: 'type', text: 'aBc', firstDelay: false });
  const i = await inj;
  assert.deepEqual(types(r.posted).slice(0, 3), ['keyDown', 'keyUp', 'flagsChanged']);
  assert.deepEqual(r.posted[2].flags, ['shift']);
  assert.equal(count(r.posted, 'keyDown'), 1, 'keys after the interruption');
  assert.deepEqual(lastFlags(r.posted), [], 'Shift not released');
  assert.deepEqual(r.released, ['shift']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'interrupted');
  assert.equal(r.interrupted.kind, 'key');
  assert.equal(r.typed, 1);
  assert.ok(r.posted.filter(e => e.type === 'keyDown').every(e => e.t <= i.t));
  const c = await s.send({ op: 'click', rect: TARGET });
  assert.equal(c.error, 'interrupted');
  assert.equal(c.posted.length, 0);
  const st = await s.send({ op: 'status' });
  assert.equal(st.interrupted.kind, 'key');
  await s.end();
});

await check('_inject mid-typing (real time) stops the typing', async () => {
  const s = await open();
  const text = 'hello world, this is a test';
  const r = s.send({ op: 'type', text, firstDelay: false });
  await sleep(700);
  const i = await s.send({ op: '_inject', kind: 'move' });
  const t = await r;
  assert.ok(t.posted.filter(e => e.type === 'keyDown').every(e => e.t <= i.t), 'keyDown after the injection');
  assert.equal(t.error, 'interrupted');
  assert.ok(t.typed > 0 && t.typed < text.length, `typed ${t.typed}`);
  assert.equal(count(t.posted, 'keyDown'), count(t.posted, 'keyUp'), 'every key released');
  await s.end();
  return `${t.typed}/${text.length} chars`;
});

await check('_inject during paste releases Cmd, sends no V, restores the clipboard at once', async () => {
  const s = await open();
  await s.send({ op: '_pb', set: [{ 'public.utf8-plain-text': 'mine' }] });
  const inj = s.send({ op: '_inject', kind: 'flags', afterPosted: 1 });
  const r = await s.send({ op: 'paste', text: '你好' });
  await inj;
  assert.equal(count(r.posted, 'keyDown'), 0);
  assert.deepEqual(lastFlags(r.posted), [], 'Cmd not released');
  assert.deepEqual(r.released, ['cmd']);
  assert.equal(r.error, 'interrupted');
  assert.equal(r.restored, true);
  const pb = await s.send({ op: '_pb' });
  assert.deepEqual(pb.items, [{ 'public.utf8-plain-text': 'mine' }]);
  await s.end();
});

await check('interruption during the hold releases the mouse button', async () => {
  const s = await open();
  await s.send({ op: '_fake', cursor: { x: TARGET.x + 40, y: TARGET.y + 15 } });
  const inj = s.send({ op: '_inject', kind: 'button', afterPosted: 1 });
  const r = await s.send({ op: 'click', rect: TARGET });
  await inj;
  assert.deepEqual(types(r.posted), ['leftMouseDown', 'leftMouseUp']);
  assert.deepEqual(r.released, ['mouse']);
  assert.equal(r.error, 'interrupted');
  await s.end();
});

await check('codex1-3/A3: the user moves the mouse during the hold → mouse-up at the pointer, not back at the landing', async () => {
  const s = await open();
  const away = { x: TARGET.x + 300, y: TARGET.y + 200 };
  // Right after the mouse-down: the physical pointer is elsewhere, and the tap sees the move.
  const fake = s.send({ op: '_fake', cursor: away, afterPosted: 1 });
  const inj = s.send({ op: '_inject', kind: 'move', afterPosted: 1 });
  await s.send({ op: '_fake', cursor: { x: TARGET.x + 40, y: TARGET.y + 15 } });
  const r = await s.send({ op: 'click', rect: TARGET });
  await fake; await inj;
  assert.equal(r.error, 'interrupted');
  assert.deepEqual(types(r.posted), ['leftMouseDown', 'leftMouseUp'], 'no move may be posted before the release');
  const up = r.posted[1];
  assert.deepEqual([up.x, up.y], [away.x, away.y], `released at ${up.x},${up.y}: pulled the pointer back`);
  assert.deepEqual(r.released, ['mouse']);
  await s.end();
});

await check('A1: session warp puts the pointer back, and is refused once the user has touched anything', async () => {
  const s = await open();
  const w = await s.send({ op: 'warp', to: { x: 11, y: 22 } });
  assert.equal(w.ok, true);
  assert.deepEqual(w.posted, [], 'a warp posts no event');
  const st = await s.send({ op: 'status' });
  assert.deepEqual(st.cursor, { x: 11, y: 22 });
  await s.send({ op: '_inject', kind: 'move' });
  const w2 = await s.send({ op: 'warp', to: { x: 50, y: 60 } });
  assert.equal(w2.ok, false);
  assert.equal(w2.error, 'interrupted');
  assert.deepEqual((await s.send({ op: 'status' })).cursor, { x: 11, y: 22 }, 'warped after the user took over');
  await s.end();
});

// ── clipboard ──────────────────────────────────────────────────────────────
await check('paste → restoreClipboard restores every item and type of the private pasteboard', async () => {
  const s = await open();
  const original = [{ 'public.utf8-plain-text': 'user text', 'public.html': '<b>user text</b>' },
                    { 'public.utf8-plain-text': 'second item' }];
  await s.send({ op: '_pb', set: original });
  const r = await s.send({ op: 'paste', text: 'Hi, 你好 ok!' });
  assert.equal(r.ok, true);
  assert.equal(r.pendingRestore, true);
  assert.deepEqual(types(r.posted), ['flagsChanged', 'keyDown', 'keyUp', 'flagsChanged']);
  assert.equal(r.posted[1].key, 9);
  assert.deepEqual(r.posted[1].flags, ['cmd']);
  assert.deepEqual(lastFlags(r.posted), []);
  const during = await s.send({ op: '_pb' });
  assert.equal(during.items.length, 1, 'one item while pasting');
  assert.equal(during.items[0]['public.utf8-plain-text'], 'Hi, 你好 ok!');
  assert.ok('org.nspasteboard.TransientType' in during.items[0]);
  assert.ok('org.nspasteboard.AutoGeneratedType' in during.items[0]);
  const rr = await s.send({ op: 'restoreClipboard' });
  const after = await s.send({ op: '_pb' });
  assert.deepEqual(after.items, original, 'items and types not restored');
  assert.equal(rr.restored, true);
  await s.end();
});

await check('changeCount mismatch leaves the newer clipboard alone', async () => {
  const s = await open();
  await s.send({ op: '_pb', set: [{ 'public.utf8-plain-text': 'user text' }] });
  await s.send({ op: 'paste', text: 'agent text' });
  await s.send({ op: '_pb', set: [{ 'public.utf8-plain-text': 'copied meanwhile' }] });
  const rr = await s.send({ op: 'restoreClipboard' });
  const after = await s.send({ op: '_pb' });
  assert.deepEqual(after.items, [{ 'public.utf8-plain-text': 'copied meanwhile' }], 'newer clipboard overwritten');
  assert.equal(rr.restored, false);
  assert.equal(rr.reason, 'changed');
  await s.end();
});

await check('pending clipboard restored on end, stdin EOF and SIGTERM', async () => {
  for (const how of ['end', 'eof', 'signal']) {
    const s = await open();
    await s.send({ op: '_pb', set: [{ 'public.utf8-plain-text': 'user text' }] });
    await s.send({ op: 'paste', text: 'agent text' });
    let e;
    if (how === 'end') e = await s.end();
    else {
      const p = s.ended();
      if (how === 'eof') s.child.stdin.end(); else s.child.kill('SIGTERM');
      e = await p;
      assert.equal((await timed(s.exited, 'exit')).code, 0);
    }
    assert.equal(e.reason, how);
    assert.equal(e.restored, true, `not restored on ${how}`);
  }
});

// ── release on end / abort ─────────────────────────────────────────────────
await check('termination with Shift and a key held posts keyUp and Shift-up, then exits 0', async () => {
  const s = await open();
  const term = s.send({ op: '_term', afterPosted: 2 });
  const endP = s.ended();
  const r = await s.send({ op: 'type', text: 'Ab' });
  await term;
  assert.deepEqual(types(r.posted), ['flagsChanged', 'keyDown', 'keyUp', 'flagsChanged']);
  assert.deepEqual(lastFlags(r.posted), []);
  assert.deepEqual(r.released, ['key', 'shift']);
  assert.equal(r.error, 'terminated');
  const e = await endP;
  assert.equal(e.reason, 'signal');
  assert.equal((await timed(s.exited, 'exit')).code, 0);
});

await check('SIGTERM at an arbitrary moment of typing: every key and Shift released, exit 0', async () => {
  const s = await open();
  const endP = s.ended();
  const r = s.send({ op: 'type', text: 'ABCDEFGHIJKLMNOP' });
  await sleep(450);
  s.child.kill('SIGTERM');
  const t = await r;
  const e = await endP;
  const all = [...t.posted, ...e.posted];
  assert.equal(count(all, 'keyDown'), count(all, 'keyUp'));
  assert.deepEqual(lastFlags(all), []);
  assert.equal(t.error, 'terminated');
  assert.equal((await timed(s.exited, 'exit')).code, 0);
  return `${count(all, 'keyDown')} keys`;
});

// ── wheel ──────────────────────────────────────────────────────────────────
await check('wheel: one line tick per event, 15–120 ms apart, window guard before each', async () => {
  const s = await open();
  await s.send({ op: '_fake', cursor: { x: 300, y: 300 } });
  const d = await s.send({ op: 'wheel', notches: 6, dir: 'down' });
  assert.deepEqual(d.posted.map(e => e.delta), [-1, -1, -1, -1, -1, -1]);
  assert.equal(d.ok, true);
  assert.equal(d.sent, 6);
  const gaps = d.posted.slice(1).map((e, i) => e.t - d.posted[i].t);
  assert.ok(gaps.every(g => g >= 14 && g <= 160), `gaps ${gaps}`);
  const u = await s.send({ op: 'wheel', notches: 3, dir: 'up' });
  assert.deepEqual(u.posted.map(e => e.delta), [1, 1, 1]);
  const f = s.send({ op: '_fake', topWindow: OTHER_WIN, afterPosted: 2 });
  const g = await s.send({ op: 'wheel', notches: 5, dir: 'down' });
  await f;
  assert.equal(count(g.posted, 'scrollWheel'), 2);
  assert.equal(g.error, 'guard');
  assert.equal(g.why, 'window_not_top');
  assert.equal(g.sent, 2);
  await s.end();
});

// ── typing shape and protocol edges ────────────────────────────────────────
await check('type: real keycodes, Shift as flagsChanged, newline = Shift+Return, tab = 4 spaces, non-ASCII refused', async () => {
  const s = await open();
  const r = await s.send({ op: 'type', text: 'Hi!\n\t' });
  assert.equal(r.ok, true);
  assert.equal(r.typed, 5);
  const downs = r.posted.filter(e => e.type === 'keyDown');
  assert.deepEqual(downs.map(e => e.key), [4, 34, 18, 36, 49, 49, 49, 49]);
  assert.deepEqual(downs.map(e => e.flags.join()), ['shift', '', 'shift', 'shift', '', '', '', '']);
  assert.deepEqual(downs.slice(0, 3).map(e => e.unicode), ['H', 'i', '!']);
  const dwell = r.posted.map((e, i) => e.type === 'keyDown' ? r.posted[i + 1].t - e.t : null).filter(x => x !== null);
  assert.ok(dwell.every(x => x >= 39 && x <= 215), `dwell ${dwell}`);
  const na = await s.send({ op: 'type', text: '你好' });
  assert.equal(na.error, 'not_ascii');
  assert.equal(na.posted.length, 0);
  await s.end();
});

// ── takeover: the user's input is held for the length of the action ───────
await check('takeover: input while held is dropped, not an interruption; the click goes through; end reports the count', async () => {
  const s = await open('tk1', { takeover: true, takeoverMaxMs: 5000 });
  await s.send({ op: '_fake', cursor: { x: 100, y: 100 } });
  const k = await s.send({ op: '_inject', kind: 'key' });
  assert.equal(k.swallowed, true);
  assert.equal(k.interrupted, null);
  await s.send({ op: '_inject', kind: 'move' });
  const r = await s.send({ op: 'click', rect: TARGET, aim: null, clickCount: 1 });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.equal(count(r.posted, 'leftMouseDown'), 1);
  assert.equal(r.takeover.active, true);
  const e = await s.end();
  assert.deepEqual([e.takeover.swallowedKeys, e.takeover.active, e.takeover.releasedBy], [1, false, 'end']);
});

await check('takeover: Esc twice gives control back and aborts the next input op; putting things back stays allowed', async () => {
  const s = await open('tk2', { takeover: true });
  await s.send({ op: '_inject', kind: 'esc' });
  const k = await s.send({ op: '_inject', kind: 'esc' });
  // Still holding until that Esc's key-up is dropped too (it would read as the user's input).
  assert.deepEqual([k.takeover.aborted, k.takeover.active], [true, true]);
  const up = await s.send({ op: '_inject', kind: 'escUp' });
  assert.equal(up.swallowed, true);
  assert.deepEqual([up.takeover.active, up.takeover.releasedBy, up.interrupted], [false, 'esc', null]);
  const r = await s.send({ op: 'click', rect: TARGET, aim: null, clickCount: 1 });
  assert.equal(r.error, 'aborted');
  assert.equal(count(r.posted, 'leftMouseDown'), 0);
  const w = await s.send({ op: 'warp', to: { x: 5, y: 5 } });
  assert.equal(w.ok, true, JSON.stringify(w));
  // Released: the user's input is attributed again.
  const m = await s.send({ op: '_inject', kind: 'move' });
  assert.equal(m.interrupted.kind, 'move');
  await s.end();
});

await check('takeover: one Esc does nothing; two Esc more than 0.8 s apart do not cancel', async () => {
  const s = await open('tk3', { takeover: true });
  await s.send({ op: '_inject', kind: 'esc' });
  await sleep(900);
  const k = await s.send({ op: '_inject', kind: 'esc' });
  assert.deepEqual([k.takeover.aborted, k.takeover.active], [false, true]);
  await s.end();
});

await check('takeover: idle (nothing running, no request) longer than takeoverIdleMs → released; input after that interrupts as before', async () => {
  const s = await open('tk5', { takeover: true, takeoverIdleMs: 800 });
  const a = await s.send({ op: '_inject', kind: 'key' });
  assert.equal(a.swallowed, true);
  await sleep(1300);
  const st = await s.send({ op: 'status' });
  assert.deepEqual([st.takeover.active, st.takeover.releasedBy, st.takeover.aborted], [false, 'idle', true]);
  // The veil is gone: the action must not go on.
  const c = await s.send({ op: 'click', rect: TARGET, aim: null, clickCount: 1 });
  assert.equal(c.error, 'aborted');
  assert.equal(count(c.posted, 'leftMouseDown'), 0);
  const b = await s.send({ op: '_inject', kind: 'key' });
  assert.equal(b.interrupted.kind, 'key');
  await s.end();
});

await check('takeover: a long op keeps the hold past takeoverIdleMs; requests every < idle keep it too', async () => {
  const s = await open('tk6', { takeover: true, takeoverIdleMs: 800, takeoverMaxMs: 60000 });
  const t0 = Date.now();
  const r = await s.send({ op: 'type', text: 'a fairly long line typed key by key', firstDelay: true });
  assert.ok(Date.now() - t0 > 1500, `typing took only ${Date.now() - t0} ms: not a long op`);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.equal(r.takeover.active, true, 'released during a running op');
  for (let i = 0; i < 4; i++) { await sleep(500); assert.equal((await s.send({ op: 'status' })).takeover.active, true, 'released while requests kept coming'); }
  await s.end();
});

await check('takeover: never held past takeoverMaxMs; input after that interrupts as before', async () => {
  const s = await open('tk4', { takeover: true, takeoverMaxMs: 1000 });
  const a = await s.send({ op: '_inject', kind: 'key' });
  assert.equal(a.swallowed, true);
  await sleep(1300);
  const st = await s.send({ op: 'status' });
  assert.deepEqual([st.takeover.active, st.takeover.releasedBy], [false, 'timeout']);
  const b = await s.send({ op: '_inject', kind: 'key' });
  assert.equal(b.interrupted.kind, 'key');
  await s.end();
});

await check('whole-task takeover: heartbeats keep it beyond maxMs; Stop still releases immediately', async () => {
  const s = await open('whole-task', { takeover: true, takeoverUntilDone: true,
    takeoverIdleMs: 800, takeoverMaxMs: 1000 });
  for (let i = 0; i < 5; i++) {
    await sleep(300);
    assert.equal((await s.send({ op: 'status' })).takeover.active, true, 'a live task expired at the fixed maximum');
  }
  await s.send({ op: '_inject', kind: 'esc' });
  await s.send({ op: '_inject', kind: 'esc' });
  const up = await s.send({ op: '_inject', kind: 'escUp' });
  assert.deepEqual([up.takeover.active, up.takeover.releasedBy], [false, 'esc']);
  await s.end();
});

await check('whole-task takeover: a missing heartbeat still releases the keyboard and mouse', async () => {
  const s = await open('whole-task-idle', { takeover: true, takeoverUntilDone: true,
    takeoverIdleMs: 500, takeoverMaxMs: 1000 });
  await sleep(1000);
  const st = await s.send({ op: 'status' });
  assert.deepEqual([st.takeover.active, st.takeover.releasedBy], [false, 'idle']);
  await s.end();
});

await check('takeover: Esc-Esc whose key-up never arrives is released after 0.4 s', async () => {
  const s = await open('tk7', { takeover: true });
  await s.send({ op: '_inject', kind: 'esc' });
  await s.send({ op: '_inject', kind: 'esc' });
  await sleep(600);
  const st = await s.send({ op: 'status' });
  assert.deepEqual([st.takeover.active, st.takeover.releasedBy], [false, 'esc']);
  await s.end();
});

await check('takeover: refused while the user holds a key or mouse button (its release would be dropped)', async () => {
  const child = spawn(BIN, ['session'], { env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_DRYRUN_PASTEBOARD: pbName() }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.add(child);
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', l => lines.push(JSON.parse(l)));
  child.stdin.write('{"op":"_fake","held":true,"id":1}\n' +
    JSON.stringify({ op: 'begin', chromePid: CHROME, window: WIN, windowBounds: BOUNDS, takeover: true, id: 2 }) + '\n{"op":"end"}\n');
  await timed(new Promise(res => child.on('exit', res)), 'exit');
  const b = lines.find(l => l.id === 2);
  assert.equal(b.error, 'input_held', JSON.stringify(b));
});

await check('takeover refused for a held key: the reply names the key, and the message says how to clear a stuck one', async () => {
  const child = spawn(BIN, ['session'], { env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_DRYRUN_PASTEBOARD: pbName() }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.add(child);
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', l => lines.push(JSON.parse(l)));
  child.stdin.write('{"op":"_fake","heldKeys":[55,36],"id":1}\n' +
    JSON.stringify({ op: 'begin', chromePid: CHROME, window: WIN, windowBounds: BOUNDS, takeover: true, id: 2 }) + '\n{"op":"end"}\n');
  await timed(new Promise(res => child.on('exit', res)), 'exit');
  const b = lines.find(l => l.id === 2);
  assert.equal(b.error, 'input_held', JSON.stringify(b));
  assert.equal(b.message, 'held: 左 ⌘、回车', JSON.stringify(b));
  const { sessionError } = await import('../src/bridge.js');
  const e = sessionError(b);
  assert.equal(e.code, 'input_held');
  assert.match(e.message, /「左 ⌘、回车」正被按着/);
  assert.match(e.message, /按一下这个键再松开/);
  assert.match(sessionError({ ok: false, error: 'input_held', message: 'held: ?' }).message, /用户正按着某个键或鼠标键/);
});

await check('postedInput counts what went out: a leading tab typed as spaces, stopped after the first space, is not "nothing"', async () => {
  const s = await open('pi1');
  const f = s.send({ op: '_fake', userFlags: ['cmd'], afterPosted: 2 });
  const r = await s.send({ op: 'type', text: '\tabc' });
  await f;
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200));
  assert.equal(r.typed, 0, 'the tab is not counted as typed until its 4th space');
  assert.equal(r.postedInput, 1, 'one key-down already went out');
  await s.end();
});

await check('takeover: disable notifications before and during prime do not contaminate the first hold', async () => {
  const s = await open('tk-disable-prime', {}, { begin: false });
  await s.send({ op: '_inject', kind: 'tapDisabled' });
  const p = await s.send({ op: 'prime' });
  assert.equal(p.ok, true);
  await s.send({ op: '_inject', kind: 'tapDisabled', reason: 'user_input' });
  const h = await s.send({ op: 'hold', takeoverUntilDone: true });
  assert.deepEqual([h.ok, h.takeover.active, h.takeover.aborted, h.takeover.tapDiagnostic], [true, true, false, undefined]);
  const b = await s.send({ op: 'begin', chromePid: CHROME, window: WIN, windowBounds: BOUNDS, takeover: true });
  assert.equal(b.ok, true);
  assert.equal(b.interrupted, null);
  assert.equal(b.takeover.tapDiagnostic, undefined);
  const k = await s.send({ op: 'key', name: 'space' });
  assert.equal(k.ok, true);
  assert.equal(count(k.posted, 'keyDown'), 1);
  const e = await s.end();
  assert.deepEqual([e.takeover.active, e.takeover.aborted, e.takeover.releasedBy, e.takeover.tapDiagnostic],
    [false, false, 'end', undefined]);
});

await check('takeover: the system disabling the tap ends the hold and the action (not silently re-armed)', async () => {
  const s = await open('tk8', { takeover: true });
  const d = await s.send({ op: '_inject', kind: 'tapDisabled' });
  assert.deepEqual([d.takeover.active, d.takeover.aborted, d.takeover.abortedBy], [false, true, 'tap_disabled']);
  assert.equal(d.takeover.tapDiagnostic.reason, 'timeout');
  assert.ok(Number.isFinite(d.takeover.tapDiagnostic.longestRunLoopGapMs));
  assert.deepEqual(Object.keys(d.takeover.tapDiagnostic).sort(),
    ['at', 'longestRunLoopGapMs', 'operation', 'reason', 'recentStage', 'runLoopGapMs', 'slowestStage', 'stage']);
  const c = await s.send({ op: 'click', rect: TARGET, aim: null, clickCount: 1 });
  assert.equal(c.error, 'aborted');
  await s.end();
});

await check('takeover: user-requested tap disable is distinguished from a timeout without re-arming', async () => {
  const s = await open('tk-disable-user', { takeover: true });
  const d = await s.send({ op: '_inject', kind: 'tapDisabled', reason: 'user_input' });
  assert.equal(d.takeover.tapDiagnostic.reason, 'user_input');
  assert.equal(d.takeover.active, false);
  const c = await s.send({ op: 'key', name: 'space' });
  assert.equal(c.error, 'aborted');
  assert.equal(c.postedInput, 0);
  await s.end();
});

await check('takeover: notifications after a lost hold preserve the first failure through end', async () => {
  const s = await open('tk-disable-released', { takeover: true });
  const first = await s.send({ op: '_inject', kind: 'tapDisabled' });
  assert.equal(first.takeover.tapDiagnostic.reason, 'timeout');
  const later = await s.send({ op: '_inject', kind: 'tapDisabled', reason: 'user_input' });
  assert.deepEqual(later.takeover.tapDiagnostic, first.takeover.tapDiagnostic);
  assert.deepEqual([later.takeover.active, later.takeover.aborted, later.takeover.abortedBy, later.interrupted],
    [false, true, 'tap_disabled', null]);
  const h = await s.send({ op: 'hold' });
  assert.equal(h.error, 'hold_ended');
  const k = await s.send({ op: 'key', name: 'space' });
  assert.equal(k.error, 'aborted');
  assert.equal(k.postedInput, 0);
  assert.deepEqual(k.posted, []);
  const e = await s.end();
  assert.deepEqual(e.takeover.tapDiagnostic, first.takeover.tapDiagnostic);
  assert.deepEqual([e.takeover.active, e.takeover.aborted, e.takeover.releasedBy], [false, true, 'tap_disabled']);
});

await check('takeover: refused while Secure Input is on, naming the app that holds it', async () => {
  const child = spawn(BIN, ['session'], { env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_DRYRUN_PASTEBOARD: pbName() }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.add(child);
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', l => lines.push(JSON.parse(l)));
  child.stdin.write('{"op":"_fake","secureInput":"1Password","id":1}\n' +
    JSON.stringify({ op: 'begin', chromePid: CHROME, window: WIN, windowBounds: BOUNDS, takeover: true, id: 2 }) + '\n{"op":"end"}\n');
  await timed(new Promise(res => child.on('exit', res)), 'exit');
  const b = lines.find(l => l.id === 2);
  assert.deepEqual([b.error, b.message], ['secure_input', '1Password'], JSON.stringify(b));
});

await check('takeover: Secure Input turned on mid-hold ends the hold and the action', async () => {
  const s = await open('si1', { takeover: true });
  await s.send({ op: '_fake', secureInput: 'Terminal' });
  await sleep(500);
  const st = await s.send({ op: 'status' });
  assert.deepEqual([st.takeover.active, st.takeover.abortedBy], [false, 'secure_input']);
  const c = await s.send({ op: 'click', rect: TARGET, aim: null, clickCount: 1 });
  assert.equal(c.error, 'aborted');
  await s.end();
});

await check('hold before begin: input is held from the first op; begin keeps the same hold', async () => {
  const child = spawn(BIN, ['session'], { env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_DRYRUN_PASTEBOARD: pbName() }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.add(child);
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => { const r = JSON.parse(l); waiting.get(r.id)?.(r); });
  let id = 0;
  // Control ops act as soon as they are read: send each only after the previous reply.
  const send = (o) => { const n = ++id; const p = new Promise(res => waiting.set(n, res)); child.stdin.write(JSON.stringify({ ...o, id: n }) + '\n'); return timed(p, o.op); };
  const h = await send({ op: 'hold' });
  assert.equal(h.ok, true, JSON.stringify(h));
  const k = await send({ op: '_inject', kind: 'key' });
  assert.deepEqual([k.swallowed, k.interrupted], [true, null]);
  const b = await send({ op: 'begin', chromePid: CHROME, window: WIN, windowBounds: BOUNDS, takeover: true });
  assert.equal(b.ok, true);
  const st = await send({ op: 'status' });
  assert.deepEqual([st.takeover.active, st.takeover.swallowedKeys], [true, 1]);
  child.stdin.write('{"op":"end"}\n');
  await timed(new Promise(res => child.on('exit', res)), 'exit');
});

await check('input before begin is refused', async () => {
  const child = spawn(BIN, ['session'], { env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_DRYRUN_PASTEBOARD: pbName() }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.add(child);
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', l => lines.push(JSON.parse(l)));
  child.stdin.write('{"op":"click","rect":{"x":0,"y":0,"w":10,"h":10},"id":1}\n{"op":"end"}\n');
  await timed(new Promise(res => child.on('exit', res)), 'exit');
  assert.equal(lines[0].error, 'not_begun');
  assert.equal(lines[0].posted.length, 0);
  assert.equal(lines[1].op, 'end');
});

// ── shaking no longer cancels (owner, 2026-10-06): held pointer moves are dropped and only nudge the hint ──
await check('takeover: shaking the mouse (4+ fast reversals) is held like any movement and does NOT give control back; Esc twice still does', async () => {
  const s = await open('sh1', { takeover: true });
  let last;
  for (const dx of [20, -20, 20, -20, 20, -20, 20]) {
    last = await s.send({ op: '_inject', kind: 'shake', dx });
    assert.deepEqual([last.swallowed, last.takeover.active, last.interrupted], [true, true, null], JSON.stringify(last));
  }
  assert.equal(last.takeover.aborted, false);
  await s.send({ op: '_inject', kind: 'esc' });
  const k = await s.send({ op: '_inject', kind: 'esc' });
  assert.equal(k.takeover.abortedBy, 'esc');
  await s.end();
});

await check('shake without a hold is ordinary user movement (an interruption, kind move)', async () => {
  const s = await open('sh3');
  const r = await s.send({ op: '_inject', kind: 'shake', dx: 20 });
  assert.equal(r.interrupted && r.interrupted.kind, 'move');
  await s.end();
});

/** Windows (any state, on screen or not) owned by `pid`, from the window server. */
function windowsOf(pid) {
  const js = `ObjC.import('CoreGraphics');
function run(a) { const l = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)); let n = 0;
  for (let i = 0; i < l.count; i++) if (Number(ObjC.unwrap(l.objectAtIndex(i).objectForKey('kCGWindowOwnerPID'))) === Number(a[0])) n++;
  return String(n); }`;
  return Number(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js, String(pid)], { encoding: 'utf8' }).trim());
}

await check('dry run: prime and a hold with a veil create no window at all', async () => {
  const s = await open('veil1');
  const p = await s.send({ op: 'prime' });
  assert.equal(p.ok, true);
  assert.equal(p.veilPrimeMs, undefined, 'a dry run built a veil');
  const child = spawn(BIN, ['session'], { env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_DRYRUN_PASTEBOARD: pbName() }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.add(child);
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => { const r = JSON.parse(l); waiting.get(r.id)?.(r); });
  let id = 0;
  const send = (o) => { const n = ++id; const pr = new Promise(res => waiting.set(n, res)); child.stdin.write(JSON.stringify({ ...o, id: n }) + '\n'); return timed(pr, o.op); };
  await send({ op: 'prime' });
  const h = await send({ op: 'hold', veil: { rect: { x: 100, y: 100, w: 800, h: 600 }, label: { zh: '正在点击「保存」', en: 'Clicking "Save"' }, point: { x: 300, y: 400 } } });
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.veilMs, undefined);
  const b = await send({ op: 'begin', chromePid: CHROME, window: WIN, windowBounds: BOUNDS, takeover: true });
  assert.equal(b.ok, true);
  assert.equal(windowsOf(child.pid), 0, 'the dry-run helper owns windows');
  assert.equal(windowsOf(s.child.pid), 0, 'the dry-run helper owns windows');
  child.stdin.write('{"op":"end"}\n');
  await timed(new Promise(res => child.on('exit', res)), 'exit');
  await s.end();
});

if (failures.length) { console.log(`session tests FAILED: ${failures.length}`); process.exit(1); }
console.log('session tests passed');
