#!/usr/bin/env node
/* The takeover panel (docs/discussion-round4/summary.md), helper side, DRY-RUN only (nothing is
 * posted, no window is shown): stages ticked off by the session's own ops, ↑/↓ pace (it really
 * shortens the waits; it is not counted as held input), the character count, a failure, and the
 * offscreen render (`veilsnap`: every sample state lays out without overlaps). */
import './isolate-settings.mjs';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// These check the built-in timing defaults; the user's recorded habits (test/habits.test.mjs) stay out.
process.env.CHROME_BRIDGE_HABITS = 'off';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.CGEVENT_BIN || path.join(HERE, '..', 'bin', 'cgevent');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const timed = (p, what, ms = 20000) => Promise.race([p, sleep(ms).then(() => { throw new Error(`no reply: ${what}`); })]);

const CHROME = 42, WIN = 7;
const BOUNDS = { x: 0, y: 0, w: 1400, h: 900 };
const failures = [];
const children = new Set();
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

const L = (zh, en) => ({ zh, en });
const CLICK_STAGES = [
  { key: 'hold', label: L('接管键盘鼠标', 'Hold'), est: 150 },
  { key: 'focus', label: L('把网页切到前面', 'Focus'), est: 300 },
  { key: 'move', label: L('移动鼠标到目标', 'Move'), est: 700, paced: true },
  { key: 'press', label: L('点击', 'Click'), est: 150, paced: true },
  { key: 'restore', label: L('还原你的窗口和光标', 'Restore'), est: 250 }
];
const TYPE_STAGES = [
  { key: 'hold', label: 'h', est: 150 }, { key: 'focus', label: 'f', est: 300 },
  { key: 'type', label: 't', est: 2600, paced: true }, { key: 'confirm', label: 'c', est: 300 }, { key: 'restore', label: 'r', est: 250 }
];
const panelOf = (stages, extra = {}) => ({ who: 'Claude · test', color: 2, task: '', step: '', action: 'x', stages, chars: 0, ...extra });

/** A dry-run session held from the start (hold → begin), as the bridge does under takeover. */
async function held(seed, panel) {
  const child = spawn(BIN, ['session'], {
    env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: seed, CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.panel${process.pid}.${seed}` },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  children.add(child);
  const waiting = new Map();
  let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const r = JSON.parse(l);
    if (r.op === 'end') waiting.get('end')?.(r); else { waiting.get(r.id)?.(r); waiting.delete(r.id); }
  });
  // Control ops act as soon as they are read: each is sent only after the previous reply.
  const send = (o) => { const n = ++id; const p = new Promise(res => waiting.set(n, res)); child.stdin.write(JSON.stringify({ ...o, id: n }) + '\n'); return timed(p, o.op); };
  const h = await send({ op: 'hold', veil: { label: 'x', panel } });
  assert.equal(h.ok, true, JSON.stringify(h));
  const b = await send({ op: 'begin', chromePid: CHROME, window: WIN, windowBounds: BOUNDS, rateMs: 2, takeover: true });
  if (b.dryRun !== true) { child.kill('SIGKILL'); throw new Error('not a dry run; stopping'); }
  const end = async () => {
    const p = timed(new Promise(res => waiting.set('end', res)), 'end');
    child.stdin.write('{"op":"end"}\n');
    return p;
  };
  return { send, end, hold: h, begin: b };
}
const states = (p) => p.stages.map(s => s.state).join(',');

await check('hold ticks off the hold; a click runs move then press; restore runs on warp; end turns everything green', async () => {
  const s = await held('p1', panelOf(CLICK_STAGES));
  assert.equal(states(s.hold.panel), 'done,running,pending,pending,pending');
  await s.send({ op: '_fake', cursor: { x: 100, y: 100 } });
  const c = await s.send({ op: 'click', rect: { x: 900, y: 600, w: 80, h: 30 }, aim: null, clickCount: 1 });
  assert.equal(c.ok, true, JSON.stringify(c).slice(0, 200));
  assert.equal(states(c.panel), 'done,done,done,done,running');
  const w = await s.send({ op: 'warp', to: { x: 100, y: 100 } });
  assert.equal(states(w.panel), 'done,done,done,done,running');
  const e = await s.end();
  assert.equal(states(e.panel), 'done,done,done,done,done');
  assert.deepEqual([e.panel.fraction, e.panel.etaMs], [1, 0]);
});

await check('↑/↓ step the pace 1 → 1.5 → 2 → 3 (held at 3) and back; not counted as held keys', async () => {
  const s = await held('p2', panelOf(CLICK_STAGES));
  const up = async () => (await s.send({ op: '_inject', kind: 'speedUp' })).speed;
  const down = async () => (await s.send({ op: '_inject', kind: 'speedDown' })).speed;
  assert.deepEqual([await up(), await up(), await up(), await up()], [1.5, 2, 3, 3]);
  assert.deepEqual([await down(), await down(), await down(), await down(), await down(), await down()], [2, 1.5, 1, 0.75, 0.5, 0.5]);
  const st = await s.send({ op: 'status' });
  assert.equal(st.takeover.swallowedKeys, 0, 'pace keys were counted as the user\'s held input');
  assert.equal(st.panel.speed, 0.5);
  await s.end();
});

await check('the pace really changes the timing: the same click (same seed) takes about half as long at 2×', async () => {
  const run = async (ups) => {
    const s = await held('p3', panelOf(CLICK_STAGES));
    for (let i = 0; i < ups; i++) await s.send({ op: '_inject', kind: 'speedUp' });
    await s.send({ op: '_fake', cursor: { x: 50, y: 50 } });
    const t0 = Date.now();
    const c = await s.send({ op: 'click', rect: { x: 1200, y: 800, w: 40, h: 20 }, aim: null, clickCount: 1 });
    const ms = Date.now() - t0;
    assert.equal(c.ok, true);
    await s.end();
    return { ms, T: c.timing.T, planned: c.planned.T };
  };
  const a = await run(0), b = await run(2);
  assert.equal(a.planned, b.planned, 'same seed should plan the same movement');
  assert.ok(b.T < a.T * 0.65, `move+dwell at 2×: ${b.T} ms vs ${a.T} ms at 1×`);
  assert.ok(b.ms < a.ms * 0.7, `whole click at 2×: ${b.ms} ms vs ${a.ms} ms at 1×`);
  return `1×: ${Math.round(a.ms)} ms, 2×: ${Math.round(b.ms)} ms`;
});

await check('at 3× a press still dwells ≥ 4 ms, holds the button ≥ 40 ms and each key ≥ 30 ms', async () => {
  let minDwell = Infinity, minHold = Infinity, minKey = Infinity;
  for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) {
    const s = await held(seed, panelOf(CLICK_STAGES));
    for (let i = 0; i < 3; i++) await s.send({ op: '_inject', kind: 'speedUp' });
    await s.send({ op: '_fake', cursor: { x: 50, y: 50 } });
    const c = await s.send({ op: 'click', rect: { x: 700, y: 500, w: 40, h: 20 }, aim: null, clickCount: 1 });
    assert.equal(c.ok, true);
    const moves = c.posted.filter(e => e.type === 'mouseMoved');
    const down = c.posted.find(e => e.type === 'leftMouseDown'), up = c.posted.find(e => e.type === 'leftMouseUp');
    minDwell = Math.min(minDwell, down.t - moves.at(-1).t);
    minHold = Math.min(minHold, up.t - down.t);
    const t = await s.send({ op: 'type', text: 'abcdef', firstDelay: false });
    const ev = t.posted.filter(e => e.type === 'keyDown' || e.type === 'keyUp');
    for (let i = 0; i + 1 < ev.length; i++) if (ev[i].type === 'keyDown' && ev[i + 1].type === 'keyUp') minKey = Math.min(minKey, ev[i + 1].t - ev[i].t);
    await s.end();
  }
  assert.ok(minDwell >= 3.5, `dwell ${minDwell} ms at 3×`);
  assert.ok(minHold >= 39, `button held ${minHold} ms at 3×`);
  assert.ok(minKey >= 29, `key held ${minKey} ms at 3×`);
  return `min dwell ${minDwell.toFixed(1)} ms, button ${minHold.toFixed(0)} ms, key ${minKey.toFixed(0)} ms`;
});

await check('typing key by key counts characters on the panel and the time left falls as they go in', async () => {
  const s = await held('p4', panelOf(TYPE_STAGES, { chars: 10, perChar: true }));
  const before = (await s.send({ op: 'status' })).panel.etaMs;
  const t = await s.send({ op: 'type', text: 'hello abcd', firstDelay: false });
  assert.equal(t.ok, true);
  assert.deepEqual(t.panel.chars, [10, 10]);
  assert.equal(t.panel.stages.find(x => x.key === 'type').detail, '10/10');
  assert.ok(t.panel.etaMs < before, `eta ${t.panel.etaMs} ms after typing vs ${before} ms before`);
  const c = await s.send({ op: 'panel', stage: 'confirm' });
  assert.equal(c.ok, true);
  const st = await s.send({ op: 'status' });
  assert.equal(states(st.panel), 'done,done,done,running,pending');
  await s.end();
});

await check('Esc-Esc mid-action: the stage under way is failed, nothing after it turns green, end keeps it failed', async () => {
  const s = await held('p5', panelOf(CLICK_STAGES));
  await s.send({ op: '_inject', kind: 'esc' });
  await s.send({ op: '_inject', kind: 'esc' });
  await s.send({ op: '_inject', kind: 'escUp' });
  await s.send({ op: '_fake', cursor: { x: 100, y: 100 } });
  const c = await s.send({ op: 'click', rect: { x: 900, y: 600, w: 80, h: 30 }, aim: null, clickCount: 1 });
  assert.equal(c.ok, false);
  assert.equal(states(c.panel), 'done,failed,pending,pending,pending');
  const e = await s.end();
  assert.equal(states(e.panel), 'done,failed,pending,pending,pending');
});

await check('a failure the bridge reports (e.g. target covered) stays failed through a normal end; nothing turns green', async () => {
  const s = await held('p8', panelOf(CLICK_STAGES));
  const f = await s.send({ op: 'panel', fail: true });
  assert.equal(states(f.panel), 'done,failed,pending,pending,pending');
  await s.send({ op: 'warp', to: { x: 10, y: 10 } });
  const e = await s.end();
  assert.equal(states(e.panel), 'done,failed,pending,pending,pending');
});

await check('a panel request names the caller\'s stages; an unknown stage changes nothing; without a panel it is a no-op', async () => {
  const s = await held('p6', panelOf(CLICK_STAGES));
  const r = await s.send({ op: 'panel', stage: 'nope' });
  assert.equal(states(r.panel), 'done,running,pending,pending,pending');
  const r2 = await s.send({ op: 'panel', stage: 'restore' });
  assert.equal(states(r2.panel), 'done,done,done,done,running');
  await s.end();
  const t = await held('p7', undefined);
  const n = await t.send({ op: 'panel', stage: 'restore' });
  assert.deepEqual([n.ok, n.panel], [true, false]);
  await t.end();
});

await check('a long job\'s next action: veil replaces the panel (its hold already done); without a panel the panel waits', async () => {
  const s = await held('p9', panelOf(CLICK_STAGES));
  await s.send({ op: 'panel', stage: 'restore' });
  const w = await s.send({ op: 'veil', veil: { label: 'thinking' } });
  assert.deepEqual([w.ok, w.held], [true, true]);
  assert.equal(w.panel.waiting, true);
  const n = await s.send({ op: 'veil', veil: { label: 'x', panel: panelOf(TYPE_STAGES, { step: '2/9' }) } });
  assert.deepEqual([n.panel.step, n.panel.waiting, states(n.panel)], ['2/9', false, 'done,running,pending,pending,pending']);
  await s.end();
});

await check('visible feed updates in place without inferring any completed step or exposing message text in status', async () => {
  const s = await held('feed1', panelOf([], {
    feedMode: true, feedEntries: [], feedStatus: 'connected',
    step: '', task: 'Read and verify'
  }));
  assert.equal(s.hold.panel.feedMode, true);
  assert.equal(s.hold.panel.feedCount, 0);
  const r = await s.send({ op: 'panel', feedEntries: ['Existing visible message.', 'Still checking question seven.'], feedStatus: 'connected' });
  assert.equal(r.ok, true);
  const st = (await s.send({ op: 'status' })).panel;
  assert.deepEqual(st.stages, []);
  assert.equal(st.feedCount, 2);
  assert.doesNotMatch(JSON.stringify(st), /Still checking|Existing visible/, 'helper status must not copy conversation content');
  const next = await s.send({ op: 'veil', veil: { label: 'Reading' } });
  assert.equal(next.panel.feedCount, 2, 'reading gaps must retain the visible feed');
  const e = await s.end();
  assert.deepEqual(e.panel.stages, [], 'releasing input cannot mark any question complete');
});

await check('veilsnap: every sample state renders offscreen, in both languages, with nothing overlapping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veilsnap-'));
  try {
    for (const lang of ['zh', 'en']) {
      const out = path.join(dir, `${lang}.png`);
      const r = JSON.parse(execFileSync(BIN, ['veilsnap', '--out', out, '--lang', lang], { encoding: 'utf8', timeout: 30000 }));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(fs.statSync(out).size > 50_000, 'empty sheet');
      assert.equal(r.frames.length, 16);
      const q = r.frames.find(f => f.frame === 'queued' && f.dark), mv = r.frames.find(f => f.frame === 'moving' && f.dark);
      assert.ok(q.panel[1] >= mv.panel[1] + 36, `the queue lines add no height: ${q.panel} vs ${mv.panel}`);
      for (const f of r.frames) assert.deepEqual(f.overlaps, [], `${lang} ${f.frame} dark=${f.dark}: ${f.overlaps}`);
      const by = (n) => r.frames.find(f => f.frame === n && f.dark);
      assert.equal(by('done').fraction, 1);
      assert.equal(by('done').fillWidth, by('done').trackWidth);
      assert.ok(by('typing').fraction > by('moving').fraction && by('moving').fraction >= by('start').fraction);
      assert.match(by('typing').pace, /1\.5×/);
      assert.ok(by('failed').states.includes('failed') && !by('failed').states.slice(by('failed').states.indexOf('failed') + 1).includes('done'));
      assert.equal(by('card').mode, 'card');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('CHROME_BRIDGE_LANG overrides the system language for the veil (no --lang: en and zh both followed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veillang-'));
  try {
    for (const lang of ['en', 'zh']) {
      const out = path.join(dir, `${lang}.png`);
      const r = JSON.parse(execFileSync(BIN, ['veilsnap', '--out', out], { encoding: 'utf8', timeout: 30000, env: { ...process.env, CHROME_BRIDGE_LANG: lang } }));
      assert.equal(r.lang, lang, JSON.stringify({ lang, got: r.lang }));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length) { console.log(`panel tests FAILED: ${failures.length}`); process.exit(1); }
console.log('panel tests passed');
