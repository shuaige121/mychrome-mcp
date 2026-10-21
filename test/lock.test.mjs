#!/usr/bin/env node
/* Cross-process input lock: N real processes contend; their critical sections
 * must never overlap. Also proves the overlap check itself fires (run once
 * with the lock bypassed) and that a dead holder's lock is taken over. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_JS = path.join(HERE, '..', 'src', 'lock.js');

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

/* Children for the queue and hand-over cases (each prints one JSON line). */
if (process.argv[2] === 'fifo') {
  // Wait `delay`, take a ticket, hold the lock `hold` ms: [asked, got, done].
  const [delay, hold] = process.argv.slice(3).map(Number);
  const { withInputLock } = await import(LOCK_JS);
  await sleepMs(delay);
  const asked = Date.now();
  const span = (await withInputLock('fifo', async () => { const got = Date.now(); await sleepMs(hold); return [asked, got, Date.now()]; },
    { info: { who: `w${delay}`, task: 't' } })).result;
  process.stdout.write(JSON.stringify(span));
  process.exit(0);
}
if (process.argv[2] === 'giver') {
  // Hold the lock; once someone waits, offer it; `die` exits after a claim without writing the waiter in;
  // `hb`: a heartbeat every 2 ms, racing the hand-over's write of the next owner.
  const mode = process.argv[3] || '';
  const L = await import(LOCK_JS);
  const out = await L.withInputLock('giver', async (turn) => {
    for (let i = 0; i < 200 && !(await L.queueList()).length; i++) await sleepMs(20);
    const t0 = Date.now();
    const h = await turn.offer({ scene: { appPid: 9, chromeTab: 5 }, pointer: { x: 1, y: 2 }, touched: true });
    if (h && mode === 'die') process.exit(0);
    if (h) { await sleepMs(50); await h.commit(); }
    // `slow`: putting things back takes a while after a withdrawn offer, the lock still held.
    if (!h && mode === 'slow') await sleepMs(800);
    return { taken: !!(h && h.commit), to: h ? h.to : null, offerMs: Date.now() - t0 };
  }, { info: { who: 'giver' }, ...(mode === 'hb' ? { heartbeatMs: 2 } : {}) });
  process.stdout.write(JSON.stringify(out.result));
  process.exit(0);
}
if (process.argv[2] === 'taker') {
  // Wait (able to take a hand-over unless `plain`); claim after `delay` ms; report what this turn got.
  const [delay, plain] = [Number(process.argv[3] || 0), process.argv[4] === 'plain'];
  const L = await import(LOCK_JS);
  const r = await L.withInputLock('taker', async (turn) => {
    if (turn && turn.handoff) {
      await sleepMs(delay);
      if (!await turn.claim()) { const e = new Error('withdrawn'); e.code = 'handoff_lost'; throw e; }
    }
    const own = JSON.parse(await readFile(path.join(L.LOCK_DIR, 'owner.json'), 'utf8'));
    await sleepMs(100);
    return { handoff: turn ? turn.handoff : null, ownsLock: own.token === turn.token, pid: process.pid };
  }, { inherit: !plain, info: { who: 'taker', task: 'export' } });
  process.stdout.write(JSON.stringify({ ...r.result, inherited: r.inherited }));
  process.exit(0);
}

if (process.argv[2] === 'oldserver') {
  // An older server build: no ticket, just mkdir + owner.json; holds `hold` ms once it gets in.
  const hold = Number(process.argv[3] || 1000);
  const { LOCK_DIR } = await import(LOCK_JS);
  for (;;) {
    try { await mkdir(LOCK_DIR); break; } catch (e) { if (e.code === 'ENOENT') await mkdir(path.dirname(LOCK_DIR), { recursive: true }); else await sleepMs(20); }
  }
  await writeFile(path.join(LOCK_DIR, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now(), label: 'old', token: `old-${process.pid}` }));
  const got = Date.now();
  await sleepMs(hold);
  const { rm } = await import('node:fs/promises');
  await rm(LOCK_DIR, { recursive: true, force: true });
  process.stdout.write(JSON.stringify([got, Date.now()]));
  process.exit(0);
}
if (process.argv[2] === 'patient') {
  // Wait with a short no-progress limit `stall` ms: [ok, code, waited].
  const stall = Number(process.argv[3]);
  const { withInputLock } = await import(LOCK_JS);
  const t0 = Date.now();
  try { await withInputLock('patient', async () => {}, { timeoutMs: stall }); process.stdout.write(JSON.stringify([true, null, Date.now() - t0])); }
  catch (e) { process.stdout.write(JSON.stringify([false, e.code, Date.now() - t0])); }
  process.exit(0);
}

if (process.argv[2] === 'child') {
  const bypass = process.argv[3] === 'bypass';
  const { withInputLock } = await import(LOCK_JS);
  const body = async () => {
    const t0 = Date.now();
    await new Promise(r => setTimeout(r, 150));
    return [t0, Date.now()];
  };
  const span = bypass ? await body() : (await withInputLock('test', body)).result;
  process.stdout.write(JSON.stringify(span));
  process.exit(0);
}

function runChildren(n, lockPath, mode = '') {
  return Promise.all(Array.from({ length: n }, () => new Promise((res, rej) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', mode],
      { env: { ...process.env, CHROME_BRIDGE_LOCK: lockPath } });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('exit', code => code === 0 ? res(JSON.parse(out)) : rej(new Error('child failed')));
  })));
}

function overlaps(spans) {
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  let n = 0;
  for (let i = 1; i < s.length; i++) if (s[i][0] < s[i - 1][1]) n++;
  return n;
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'cb-lock-'));

// 1. The check fires: without the lock, 6 concurrent 150 ms sections overlap.
const raw = await runChildren(6, path.join(dir, 'a.lock'), 'bypass');
assert.ok(overlaps(raw) > 0, 'overlap detector must fire when the lock is bypassed');
console.log(`  ok  without the lock: ${overlaps(raw)} overlapping sections detected (check can fail)`);

// 2. With the lock: zero overlap, and total time ~ serial.
const t0 = Date.now();
const spans = await runChildren(6, path.join(dir, 'b.lock'));
const wall = Date.now() - t0;
assert.equal(overlaps(spans), 0, 'critical sections overlapped under the lock');
assert.ok(wall >= 6 * 150, `6 x 150 ms under one lock finished in ${wall} ms — not serialized`);
console.log(`  ok  with the lock: 6 processes, 0 overlaps, ${wall} ms wall (>= 900 ms serial)`);

// 3. A lock left by a dead process is taken over instead of wedging everyone.
const stale = path.join(dir, 'c.lock');
await mkdir(stale);
await writeFile(path.join(stale, 'owner.json'), JSON.stringify({ pid: 999999, since: Date.now(), label: 'crashed', token: 'x' }));
const t1 = Date.now();
await runChildren(1, stale);
assert.ok(Date.now() - t1 < 3000, 'dead holder was not taken over');
console.log('  ok  lock held by a dead pid is taken over');

// 4. Heartbeat (review A5): a live holder keeps `since` fresh, so a long idle
// wait plus a long scroll cannot make its lock look stale to other servers.
process.env.CHROME_BRIDGE_LOCK = path.join(dir, 'd.lock');
const L = await import(LOCK_JS);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const owner = async () => JSON.parse(await readFile(path.join(L.LOCK_DIR, 'owner.json'), 'utf8'));
{
  let first, later, files;
  await L.withInputLock('hb', async () => {
    first = await owner();
    await sleep(400);
    later = await owner();
    files = await readdir(L.LOCK_DIR);
  }, { heartbeatMs: 50 });
  assert.ok(later.since > first.since + 200, `since not refreshed: ${first.since} -> ${later.since}`);
  assert.equal(later.token, first.token);
  assert.deepEqual(files, ['owner.json'], 'a temp file was left behind');
  console.log('  ok  a holder re-stamps `since` while it runs (atomic rename, same token)');
}
{
  let after;
  await L.withInputLock('hb2', async () => {
    const o = await owner();
    await writeFile(path.join(L.LOCK_DIR, 'owner.json'), JSON.stringify({ ...o, token: 'someone-else', since: 1 }));
    await sleep(300);
    after = await owner();
  }, { heartbeatMs: 50 });
  assert.deepEqual([after.token, after.since], ['someone-else', 1], 'the heartbeat overwrote a lock that is no longer ours');
  console.log('  ok  the heartbeat never writes over a lock whose token is not ours');
}
{
  let a, b;
  await L.withInputLock('hb3', async () => {
    await sleep(250);
    a = (await owner()).since;
    await sleep(300);
    b = (await owner()).since;
  }, { heartbeatMs: 50, heartbeatCapMs: 150 });
  assert.equal(a, b, 'a holder past the cap kept refreshing');
  console.log('  ok  the heartbeat stops after its cap (a wedged live holder still goes stale)');
}

/* ---- queue: first come, first served; the veil's waiting list; hand-over between agents ---- */

function spawnChild(args, env = {}) {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.map(String)], { env: { ...process.env, ...env } });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('exit', code => code === 0 ? res(out ? JSON.parse(out) : null) : rej(new Error(`child ${args[0]} failed: ${err}`)));
  });
}

// 5. Six waiters arriving 40 ms apart behind a holder get the lock in the order they asked.
{
  const lock = path.join(dir, 'e.lock');
  const env = { CHROME_BRIDGE_LOCK: lock };
  const holder = spawnChild(['fifo', 0, 500], env);
  await sleepMs(150);
  const waiters = await Promise.all([0, 40, 80, 120, 160, 200].map(d => spawnChild(['fifo', d, 60], env)));
  await holder;
  const byAsk = [...waiters].sort((a, b) => a[0] - b[0]);
  const gots = byAsk.map(s => s[1]);
  assert.deepEqual(gots, [...gots].sort((a, b) => a - b), `not first come, first served: asked ${byAsk.map(s => s[0])} got ${gots}`);
  assert.equal(overlaps(waiters.map(s => [s[1], s[2]])), 0);
  console.log('  ok  6 waiters behind a holder: served in the order they asked, no overlap');
}

// 6. The waiting list: who and what each waiter is; a dead waiter's ticket is dropped.
{
  const lock = path.join(dir, 'f.lock');
  const env = { CHROME_BRIDGE_LOCK: lock };
  const holder = spawnChild(['fifo', 0, 900], env);
  await sleepMs(150);
  const w = spawnChild(['fifo', 0, 10], env);
  await mkdir(lock + '.queue', { recursive: true });
  await writeFile(path.join(lock + '.queue', '00000000000001-0999999-00001.json'), JSON.stringify({ pid: 999999, label: 'ghost', beat: Date.now() }));
  await sleepMs(250);
  const { stdout } = await new Promise((res) => {
    const c = spawn(process.execPath, ['-e', `import(${JSON.stringify(LOCK_JS)}).then(async L => process.stdout.write(JSON.stringify(await L.queueList())))`],
      { env: { ...process.env, CHROME_BRIDGE_LOCK: lock } });
    let o = ''; c.stdout.on('data', d => { o += d; }); c.on('exit', () => res({ stdout: o }));
  });
  const q = JSON.parse(stdout);
  assert.deepEqual(q.map(t => [t.who, t.task]), [['w0', 't']], JSON.stringify(q));
  assert.ok(!(await readdir(lock + '.queue')).some(n => n.includes('0999999')), 'a dead waiter\'s ticket stayed in the queue');
  await Promise.all([holder, w]);
  console.log('  ok  the waiting list names each waiter and its task; a dead waiter\'s ticket is dropped');
}

// 7. Hand-over: the holder offers, the waiter claims and becomes the owner with the user's scene;
//    the holder's own release does not free the lock under it.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'g.lock') };
  const giver = spawnChild(['giver'], env);
  await sleepMs(150);
  const [g, t] = await Promise.all([giver, spawnChild(['taker', 0], env)]);
  assert.equal(g.taken, true, JSON.stringify(g));
  assert.equal(g.to.task, 'export');
  assert.deepEqual([t.inherited, t.ownsLock, t.handoff.scene, t.handoff.pointer, t.handoff.touched], [true, true, { appPid: 9, chromeTab: 5 }, { x: 1, y: 2 }, true]);
  assert.ok(!fsSync.existsSync(env.CHROME_BRIDGE_LOCK), 'lock left behind after the last holder');
  console.log('  ok  hand-over: the waiter claims, becomes the owner and gets the user\'s scene and pointer');
}

// 8. Withdrawn: the waiter is too slow to claim → the holder takes its offer back and puts things back
//    itself (still holding the lock); the waiter's late claim fails, it waits again in its place and gets
//    the lock the usual way once the holder is done.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'h.lock'), CHROME_BRIDGE_HANDOFF_WAIT_MS: '150' };
  const giver = spawnChild(['giver', 'slow'], env);
  await sleepMs(150);
  const [g, t] = await Promise.all([giver, spawnChild(['taker', 600], env)]);
  assert.equal(g.taken, false, JSON.stringify(g));
  assert.deepEqual([t.inherited, t.ownsLock], [false, true], JSON.stringify(t));
  console.log('  ok  a hand-over not claimed in time is withdrawn; the waiter then gets the lock the usual way');
}

// 9. A waiter that cannot take a takeover over is never offered one (no wait for it).
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'i.lock') };
  const giver = spawnChild(['giver'], env);
  await sleepMs(150);
  const [g, t] = await Promise.all([giver, spawnChild(['taker', 0, 'plain'], env)]);
  assert.equal(g.taken, false);
  assert.ok(g.offerMs < 300, `offered to a waiter that cannot take it (${g.offerMs} ms)`);
  assert.deepEqual([t.inherited, t.ownsLock, t.handoff], [false, true, null]);
  console.log('  ok  a waiter that cannot take a takeover over is not offered one');
}

// 10. The holder dies after the claim, before writing the waiter in: the waiter still gets the lock and
//     the scene (nothing was put back, so it is the waiter's to put back).
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'j.lock') };
  const giver = spawnChild(['giver', 'die'], env);
  await sleepMs(150);
  const [, t] = await Promise.all([giver, spawnChild(['taker', 0], env)]);
  assert.deepEqual([t.inherited, t.ownsLock, t.handoff && t.handoff.scene.appPid], [true, true, 9], JSON.stringify(t));
  console.log('  ok  a holder that dies after the claim: the waiter takes the lock and keeps the scene');
}

// 11. Codex A1: a withdrawn offer stays withdrawn after the lock changed hands — here an older server
//     (no ticket) takes the freed lock before the slow waiter claims; the late claim must fail.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'k.lock'), CHROME_BRIDGE_HANDOFF_WAIT_MS: '150' };
  const giver = spawnChild(['giver'], env);
  await sleepMs(150);
  const taker = spawnChild(['taker', 900], env);
  await sleepMs(500);                                   // offer made and withdrawn, lock freed
  const old = spawnChild(['oldserver', 1200], env);
  const [g, t] = await Promise.all([giver, taker, old]);
  assert.equal(g.taken, false);
  assert.equal(t.inherited, false, `a late claim of a withdrawn offer succeeded in the next holder's lock: ${JSON.stringify(t)}`);
  console.log('  ok  Codex A1: a late claim of a withdrawn offer fails even after the lock changed hands');
}

// 12. Codex A2: a heartbeat racing the hand-over never writes the old owner back (5 hand-overs, heartbeat every 2 ms).
{
  for (let i = 0; i < 5; i++) {
    const env = { CHROME_BRIDGE_LOCK: path.join(dir, `l${i}.lock`) };
    const giver = spawnChild(['giver', 'hb'], env);
    await sleepMs(120);
    const t0 = Date.now();
    const [g, t] = await Promise.all([giver, spawnChild(['taker', 0], env)]);
    assert.deepEqual([g.taken, t.inherited, t.ownsLock], [true, true, true], JSON.stringify({ g, t }));
    assert.ok(Date.now() - t0 < 5000, `hand-over stalled ${Date.now() - t0} ms (old owner written back?)`);
  }
  console.log('  ok  Codex A2: 5 hand-overs with a 2 ms heartbeat: the next owner is never overwritten');
}

// 13. Codex A5: a waiter whose page check outlasts the ticket's stale limit keeps its place and its claim.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'm.lock'), CHROME_BRIDGE_TICKET_BEAT_MS: '100', CHROME_BRIDGE_TICKET_STALE_MS: '400',
    CHROME_BRIDGE_HANDOFF_WAIT_MS: '3000' };
  const giver = spawnChild(['giver'], env);
  await sleepMs(150);
  const taker = spawnChild(['taker', 1200], env);       // 3x the stale limit outside the wait loop
  await sleepMs(300);
  const later = spawnChild(['fifo', 0, 50], env);
  const [g, t, w] = await Promise.all([giver, taker, later]);
  assert.deepEqual([g.taken, t.inherited], [true, true], `the slow waiter lost its place: ${JSON.stringify({ g, t })}`);
  assert.ok(w[1] > g.offerMs, 'the later waiter went first');
  console.log('  ok  Codex A5: a slow page check (3x the ticket limit) keeps the waiter\'s place and claim');
}

// 14. Codex A8: refused only when the queue stops moving, not after a fixed total wait.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'n.lock') };
  const chain = [spawnChild(['fifo', 0, 400], env), spawnChild(['fifo', 50, 400], env), spawnChild(['fifo', 100, 400], env)];
  await sleepMs(200);
  const moving = await spawnChild(['patient', 700], env);   // waits ~1.0 s in all, never 700 ms without progress
  await Promise.all(chain);
  assert.deepEqual(moving.slice(0, 2), [true, null], `refused while the queue moved: ${moving}`);
  const stuck = spawnChild(['fifo', 0, 1500], env);
  await sleepMs(150);
  const stalled = await spawnChild(['patient', 500], env);
  await stuck;
  assert.deepEqual(stalled.slice(0, 2), [false, 'lock_timeout'], `not refused after 500 ms without progress: ${stalled}`);
  console.log(`  ok  Codex A8: a queue that moves is waited out (${moving[2]} ms > 700 ms limit); one that stops is refused`);
}

// 15. Codex A9: a call cancelled while it waits gives its place up at once.
{
  process.env.CHROME_BRIDGE_LOCK = path.join(dir, 'd.lock');
  const holder = spawnChild(['fifo', 0, 800], { CHROME_BRIDGE_LOCK: L.LOCK_DIR });
  await sleepMs(150);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  await assert.rejects(L.withInputLock('cancel', async () => 'ran', { signal: ac.signal }), (e) => e.code === 'cancelled');
  assert.ok(Date.now() - t0 < 600, 'kept waiting after the cancel');
  assert.deepEqual((await L.queueList()).filter(x => x.pid === process.pid), [], 'the cancelled waiter\'s ticket stayed');
  await holder;
  console.log('  ok  Codex A9: cancelled while waiting → rejected at once, ticket removed, nothing run');
}

// 16. Codex round 2 A10: a re-stamp already writing when the ticket is removed must not put it back.
//     The hook makes every re-stamp take 300 ms; the wait is cancelled while one is under way.
{
  process.env.CHROME_BRIDGE_LOCK = path.join(dir, 'd.lock');
  const holder = spawnChild(['fifo', 0, 4000], { CHROME_BRIDGE_LOCK: L.LOCK_DIR });
  await sleepMs(200);
  let writing = 0, mine = null;
  const ac = new AbortController();
  const waiting = L.withInputLock('a10', async () => 'ran', { signal: ac.signal }).catch(e => e);
  // Once the ticket is in the queue (its first write done), every later re-stamp is slow.
  let t0 = Date.now();
  while (!(await L.queueList()).some(t => t.pid === process.pid) && Date.now() - t0 < 2000) await sleepMs(10);
  L.__setTicketBeatHookForTests(async (name) => { mine = name; writing++; await sleepMs(300); writing--; });
  t0 = Date.now();
  while (!writing && Date.now() - t0 < 4000) await sleepMs(10);     // the 2 s re-stamp timer fired: a write is under way
  assert.ok(writing, 'no re-stamp started (test setup)');
  ac.abort();
  const e = await waiting;
  L.__setTicketBeatHookForTests(null);
  assert.equal(e.code, 'cancelled', String(e));
  await sleepMs(500);                                              // past the slow write
  const left = (await readdir(L.QUEUE_DIR)).filter(n => n === mine);
  assert.deepEqual(left, [], `the removed ticket was written back by a re-stamp under way: ${mine}`);
  assert.ok(!(await L.queueList()).some(t => t.name === mine), 'the removed ticket is still in the queue');
  await holder;
  console.log('  ok  Codex round 2 A10: a re-stamp under way when the ticket is removed does not put it back');
}

console.log('\nlock tests passed.');
