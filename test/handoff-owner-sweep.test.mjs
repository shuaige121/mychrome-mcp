#!/usr/bin/env node
/* HC (problems-20261101, contracts-batch2 "HC: decision only"): a tab whose shared <tabId>.handoff.json is
 * pending, or within its protection (keepUntil = window end + 10 min while pending, end + 10 min once ended),
 * is not a sweep candidate and does not pass the re-check before close for `session_end` or `owner_gone`.
 * After the protection only the idle rule can select it, pending or ended: never `owner_gone` or `session_end`.
 * r2 (HC r2 ruling): the hand-off file is absent (ENOENT only), valid (finite keepUntil within `at` +
 * HANDOFF_KEEP_BOUND_MS) or uncertain (unreadable, corrupt, keepUntil missing, not a number or past the bound):
 * an uncertain one keeps the tab until the file's mtime + HANDOFF_KEEP_BOUND_MS, then idle only; when not even
 * stat works the sweep leaves the tab alone. A fixed file brings the valid behaviour back.
 *
 * Every role is its own node process on one registry directory (real files):
 * - the owner registers the tab and writes the hand-off with the production noteHandoff (what wait_for_user's
 *   start/resume/end write), runs its own session-end sweep (index.js bye() and the hot-swap handover callback
 *   both call sweep({ exitingPid: OWNER_PID }) = sweepTabs) and exits, or is killed;
 * - another server sweeps with the production sweepTabs and real pid liveness;
 * - a third server hands the tab to the user between another sweep's plan and its close re-check.
 * Chrome is a fake listing; closeTab only records the call. The new-fix cases inject listTabs/closeTab so the
 * decision is observable as close calls (closeAndConfirm then treats the native close as available). Production
 * sweeps get defaultDeps (nativeSessionAvailable:false) and close nothing: the kept cases check that, and that
 * the owner's close_tab (closeAgentTab) still closes a handed-off tab. HC_CASE=<name> runs one case. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABS_JS = path.join(ROOT, 'src', 'tabs.js');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-hc-test-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_NOTIFY = '0';
delete process.env.CHROME_BRIDGE_LAUNCHER_PID;
await mkdir(path.join(tmp, 'lock'));
const LOCK = process.env.CHROME_BRIDGE_LOCK;
const T = await import('../src/tabs.js');   // the orchestrator only reads the registry
const ONLY = process.env.HC_CASE || null;
const GRACE = T.HANDOFF_GRACE_MS;
// The longest wait_for_user window (10 min) + HANDOFF_GRACE_MS. A literal, so a revert of src/tabs.js does not turn the
// cases' clock arithmetic into NaN; the 'bound' case checks that src/tabs.js says the same.
const BOUND = 20 * 60_000;
const HOUR = 3_600_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const evidence = [];

/* ------------------------------------------------------------ processes */

/** Shared by every child: the production tabs.js, a fake Chrome listing (window 7, Chrome not frontmost, so no
 * tab counts as the one the user looks at) and a closeTab that records the call. `gate`: the first listing writes
 * gate.listed and waits for gate.go (the sweep's plan is made from records read before it; its close re-checks
 * the registry after it). */
const PRELUDE = `
  import { writeFileSync, existsSync, chmodSync, symlinkSync, lstatSync, readFileSync, statSync } from 'node:fs';
  import path from 'node:path';
  const T = await import(${JSON.stringify(TABS_JS)});
  const hf = id => path.join(process.env.CHROME_BRIDGE_TAB_DIR, id + '.handoff.json');
  const LOCK = ${JSON.stringify(LOCK)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = o => console.log(JSON.stringify(o));
  const url = id => 'https://shop.test/' + id;
  const listing = ids => ({ ok: true, frontmost: 'WeChat', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
    tabs: ids.map(id => ({ id, url: url(id), title: 't' + id, active: false })) }] });
  function chrome(ids, gate = null) {
    const calls = [];
    let first = true;
    return { calls, clickedSince: async () => false,
      listTabs: async () => {
        if (first && gate) { first = false; writeFileSync(gate.listed, '1'); for (const t = Date.now(); !existsSync(gate.go) && Date.now() - t < 8000;) await sleep(10); }
        return listing(ids.filter(id => !calls.includes(id)));
      },
      closeTab: async id => { calls.push(Number(id)); return { ok: true }; } };
  }
  async function sweep(c, o = {}) {
    const r = await T.sweepTabs({ lockDir: LOCK, ...o, listTabs: c.listTabs, closeTab: c.closeTab, clickedSince: c.clickedSince });
    return { closed: r.closed.map(x => [x.tabId, x.reason]), deferred: (r.deferred || []).map(x => [x.tabId, x.reason]), calls: c.calls };
  }
`;
const childEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const [k, v] of Object.entries(env)) if (v == null) delete env[k];
  return env;
};
/** One process from start to exit; its last stdout line is the result. */
function run(body, extra = {}) {
  return new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', PRELUDE + body],
    { env: childEnv(extra), encoding: 'utf8', timeout: 20_000 },
    (e, stdout, stderr) => e ? reject(new Error(`${e.message}\n${stderr}`)) : resolve(JSON.parse(stdout.trim().split('\n').pop()))));
}
/** A process that stays (an owner that will be killed, a launcher): resolves with its first stdout line. */
function start(body, extra = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', PRELUDE + body + '\nsetInterval(() => {}, 60_000);'],
    { env: childEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  child.stderr.on('data', d => { err += d; });
  const exited = new Promise(r => child.once('exit', r));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', d => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl))); });
    child.once('exit', code => reject(new Error(`exited ${code} before ready: ${err}`)));
  });
  return { child, ready, kill: async () => { child.kill('SIGKILL'); await exited; } };
}
async function owner(body, extra = {}) {
  const r = await run(body, extra);
  assert.equal(alive(r.pid), false, 'the owner process is gone');
  return r;
}
/** Another server's sweep, in its own process (real pid liveness: isAlive is not passed). */
const otherSweep = (ids, o, gate = null) => run(`out(await sweep(chrome(${JSON.stringify(ids)}, ${JSON.stringify(gate)}), ${JSON.stringify(o)}));`);
const gateFiles = name => ({ listed: path.join(tmp, `${name}-listed-${Date.now()}`), go: path.join(tmp, `${name}-go-${Date.now()}`) });
async function until(pred, ms, label) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(10)) if (await pred()) return;
  throw new Error(`${label}: not within ${ms} ms`);
}
async function fresh() {
  for (const n of await readdir(T.TAB_DIR).catch(() => [])) await rm(path.join(T.TAB_DIR, n), { force: true });
}
const none = { closed: [], deferred: [], calls: [] };
const show = (label, r) => evidence.push(`${label}: ${JSON.stringify(r)}`);

const cases = [];
const add = (kind, name, label, fn) => cases.push({ kind, name, label, fn });

/* ------------------------------------------------------------ new fix */

add('new', 'session-end', 'normal session end (bye) during a pending hand-off: the owner\'s own sweep does not pick it; after the owner exits another server\'s sweep does not pick it for owner_gone', async () => {
  await fresh();
  const a = await owner(`
    const now = Date.now();
    await T.registerTab(20, url(20), { windowId: 7, now });
    const h = await T.noteHandoff(20, { pending: true, until: now + 60_000 });   // wait_for_user started (window 1 min)
    out({ pid: process.pid, owner: T.OWNER_PID, keepUntil: h.keepUntil,
      ...await sweep(chrome([20]), { exitingPid: T.OWNER_PID, ttlMs: ${HOUR} }) });   // bye(): sweep({ exitingPid: OWNER_PID })`);
  show('session-end owner sweep', a);
  assert.equal(a.owner, a.pid);
  assert.deepEqual({ closed: a.closed, deferred: a.deferred, calls: a.calls }, none, `session end picked a handed-off tab: ${JSON.stringify(a)}`);
  const s = await otherSweep([20], { ttlMs: HOUR });
  show('session-end other server after owner exit', s);
  assert.deepEqual(s, none, `owner_gone picked a handed-off tab: ${JSON.stringify(s)}`);
  assert.ok(await T.getTab(20));
});

add('new', 'owner-dies', 'the owner is killed during a pending hand-off: no sweep picks it while protected, even with the idle TTL met; after window end + 10 min only idle selects it (no owner_gone fallback)', async () => {
  await fresh();
  const o = start(`
    const now = Date.now();
    await T.registerTab(21, url(21), { windowId: 7, now });
    const h = await T.noteHandoff(21, { pending: true, until: now + 60_000 });
    out({ pid: process.pid, now, keepUntil: h.keepUntil });`);
  const a = await o.ready;
  await o.kill();
  assert.equal(alive(a.pid), false);
  assert.equal(a.keepUntil, a.now + 60_000 + GRACE, 'protection = window end + 10 min');
  const inside = await otherSweep([21], { now: a.keepUntil - 1000, ttlMs: 1000 });
  show('owner-dies protected (end+10min-1s, TTL 1 s)', inside);
  assert.deepEqual(inside, none, JSON.stringify(inside));
  const after = await otherSweep([21], { now: a.keepUntil + 1000, ttlMs: HOUR });
  show('owner-dies expired, idle not met (TTL 1 h)', after);
  assert.deepEqual(after, none, `fell back to owner_gone after the protection: ${JSON.stringify(after)}`);
  const idle = await otherSweep([21], { now: a.keepUntil + 1000, ttlMs: 60_000 });
  show('owner-dies expired, idle met (TTL 1 min)', idle);
  assert.deepEqual(idle.closed, [[21, 'idle']], JSON.stringify(idle));
  assert.equal(await T.getTab(21), null);
});

add('new', 'ended-owner-gone', 'a hand-off that ended normally, owner exits within its grace: not picked in the grace; afterwards only idle (no owner_gone fallback)', async () => {
  await fresh();
  const a = await owner(`
    const now = Date.now();
    await T.registerTab(22, url(22), { windowId: 7, now: now - 120_000 });
    await T.noteHandoff(22, { pending: true, until: now + 60_000, now: now - 60_000 });
    const h = await T.noteHandoff(22, { pending: false, until: now, now });   // endHandoff: the user was done
    out({ pid: process.pid, now, keepUntil: h.keepUntil });`);
  assert.equal(a.keepUntil, a.now + GRACE);
  const inside = await otherSweep([22], { now: a.now + 4000, ttlMs: HOUR });
  show('ended-owner-gone in grace', inside);
  assert.deepEqual(inside, none, JSON.stringify(inside));
  const after = await otherSweep([22], { now: a.keepUntil + 1000, ttlMs: HOUR });
  show('ended-owner-gone expired, idle not met', after);
  assert.deepEqual(after, none, JSON.stringify(after));
  const idle = await otherSweep([22], { now: a.keepUntil + 1000, ttlMs: 60_000 });
  assert.deepEqual(idle.closed, [[22, 'idle']], JSON.stringify(idle));
});

add('new', 'expiry-session-end', 'a hand-off its owner never ended (pending) past window end + 10 min: the owner\'s session end picks it only by idle', async () => {
  await fresh();
  const a = await owner(`
    const now = Date.now();
    await T.registerTab(23, url(23), { windowId: 7, now });
    const h = await T.noteHandoff(23, { pending: true, until: now + 60_000 });
    const later = h.keepUntil + 1000;
    out({ pid: process.pid,
      notIdle: await sweep(chrome([23]), { exitingPid: T.OWNER_PID, now: later, ttlMs: ${HOUR} }),
      idle: await sweep(chrome([23]), { exitingPid: T.OWNER_PID, now: later, ttlMs: 60_000 }) });`);
  show('expiry-session-end', a);
  assert.deepEqual(a.notIdle, none, `session_end after the protection of a pending hand-off: ${JSON.stringify(a.notIdle)}`);
  assert.deepEqual(a.idle.closed, [[23, 'idle']], JSON.stringify(a.idle));
});

add('new', 'handover', 'session end during a hot-swap handover (sweep({ exitingPid: launcher })): a tab whose hand-off just ended in this worker and one a crashed earlier worker left pending are not picked; after the launcher goes another server does not pick them', async () => {
  await fresh();
  const launcher = start(`out({ pid: process.pid });`);
  const L = (await launcher.ready).pid;
  try {
    // Worker 0 of the session starts a hand-off on tab 24, then crashes (the launcher starts worker 1).
    const w0 = start(`
      const now = Date.now();
      await T.registerTab(24, url(24), { windowId: 7, now });
      await T.noteHandoff(24, { pending: true, until: now + 60_000 });
      out({ pid: process.pid, owner: T.OWNER_PID });`, { CHROME_BRIDGE_LAUNCHER_PID: String(L) });
    const r0 = await w0.ready;
    await w0.kill();
    assert.equal(r0.owner, L);
    // Worker 1: a hand-off on tab 25 started and ended (nothing pending in it, so it may hand over); tab 26 has
    // none (control). It is asked to hand over and the session ends meanwhile: its handover callback sweeps.
    const w1 = await run(`
      const now = Date.now();
      await T.registerTab(25, url(25), { windowId: 7, now: now - 120_000 });
      await T.registerTab(26, url(26), { windowId: 7, now: now - 120_000 });
      await T.noteHandoff(25, { pending: true, until: now + 60_000, now: now - 60_000 });
      await T.noteHandoff(25, { pending: false, until: now - 1000, now: now - 1000 });
      out({ pid: process.pid, owner: T.OWNER_PID, ...await sweep(chrome([24, 25, 26]), { exitingPid: T.OWNER_PID, ttlMs: ${HOUR} }) });`,
    { CHROME_BRIDGE_LAUNCHER_PID: String(L) });
    show('handover worker sweep', w1);
    assert.equal(w1.owner, L);
    assert.deepEqual(w1.calls, [26], `handover session end picked a handed-off tab: ${JSON.stringify(w1)}`);
    assert.deepEqual(w1.closed, [[26, 'session_end']], 'control: the session\'s tab without a hand-off still goes');
    await launcher.kill();
    assert.equal(alive(L), false);
    const s = await otherSweep([24, 25], { ttlMs: HOUR });
    show('handover other server after launcher exit', s);
    assert.deepEqual(s, none, JSON.stringify(s));
  } finally { await launcher.kill().catch(() => {}); }
});

add('new', 'recheck-owner-gone', 're-check: another server planned to close a dead owner\'s tab (owner_gone); a third server hands it to the user before the close: refused at the re-check, zero close calls', async () => {
  await fresh();
  await owner(`await T.registerTab(27, url(27), { windowId: 7, now: Date.now() }); out({ pid: process.pid });`);
  const gate = gateFiles('og');
  const sweeping = otherSweep([27], { ttlMs: HOUR }, gate);
  await until(() => existsSync(gate.listed), 8000, 'the other server\'s listing');
  const b = await run(`const h = await T.noteHandoff(27, { pending: true, until: Date.now() + 60_000 }); out({ pid: process.pid, h });`);
  assert.equal(b.h.pending, true);
  await writeFile(gate.go, '1');
  const s = await sweeping;
  show('recheck-owner-gone', s);
  assert.deepEqual(s.calls, [], `the re-check let a handed-off tab close: ${JSON.stringify(s)}`);
  assert.deepEqual(s.deferred, [[27, 'ownership_unverified']], 'the plan had picked it; the re-check refused it');
  assert.ok(await T.getTab(27));
});

add('new', 'recheck-session-end', 're-check at a session end during a handover: the old worker planned session_end; the new worker of the same session hands the tab to the user before the close: refused, zero close calls', async () => {
  await fresh();
  const launcher = start(`out({ pid: process.pid });`);
  const L = (await launcher.ready).pid;
  try {
    const env = { CHROME_BRIDGE_LAUNCHER_PID: String(L) };
    const gate = gateFiles('se');
    const sweeping = run(`
      await T.registerTab(28, url(28), { windowId: 7, now: Date.now() });
      out(await sweep(chrome([28], ${JSON.stringify(gate)}), { exitingPid: T.OWNER_PID, ttlMs: ${HOUR} }));`, env);
    await until(() => existsSync(gate.listed), 8000, 'the old worker\'s listing');
    await run(`await T.noteHandoff(28, { pending: true, until: Date.now() + 60_000 }); out({ pid: process.pid });`, env);
    await writeFile(gate.go, '1');
    const s = await sweeping;
    show('recheck-session-end', s);
    assert.deepEqual(s.calls, [], `the re-check let a handed-off tab close: ${JSON.stringify(s)}`);
    assert.deepEqual(s.deferred, [[28, 'ownership_unverified']]);
    assert.ok(await T.getTab(28));
  } finally { await launcher.kill(); }
});

add('new', 'production-decision', 'production default deps (defaultDeps, no native Session): a protected tab is not even a candidate (absent from deferred); an unprotected one is deferred native_session_required; nothing is closed', async () => {
  await fresh();
  const a = await owner(`
    const calls = [];
    T.__setBridgeForTests({ listTabs: async () => listing([29, 30]), closeTab: async id => { calls.push(id); return { ok: true }; }, cgevent: async () => ({}) });
    const now = Date.now();
    await T.registerTab(29, url(29), { windowId: 7, now });
    await T.registerTab(30, url(30), { windowId: 7, now });
    await T.noteHandoff(29, { pending: true, until: now + 60_000 });
    const r = await T.sweepTabs({ exitingPid: T.OWNER_PID, ttlMs: ${HOUR}, lockDir: LOCK });
    out({ pid: process.pid, closed: r.closed.length, deferred: (r.deferred || []).map(x => [x.tabId, x.reason]), calls });`);
  show('production-decision', a);
  assert.deepEqual(a.calls, []); assert.equal(a.closed, 0);
  assert.deepEqual(a.deferred, [[30, 'native_session_required']], JSON.stringify(a));
});

/* ------------------------------------------------------------ r2 (HC r2 ruling) */

add('new', 'ended-expiry-session-end', 'A1: a hand-off that ended normally, its grace over: the owner\'s session end picks it only by idle (r1 kept session_end here)', async () => {
  await fresh();
  const a = await owner(`
    const now = Date.now();
    await T.registerTab(36, url(36), { windowId: 7, now: now - 40 * 60_000 });
    await T.noteHandoff(36, { pending: false, until: now - 30 * 60_000, now: now - 30 * 60_000 });
    out({ pid: process.pid,
      notIdle: await sweep(chrome([36]), { exitingPid: T.OWNER_PID, ttlMs: ${HOUR} }),
      idle: await sweep(chrome([36]), { exitingPid: T.OWNER_PID, ttlMs: 60_000 }) });`);
  show('ended-expiry-session-end', a);
  assert.deepEqual(a.notIdle, none, `session_end after an ended hand-off's protection: ${JSON.stringify(a.notIdle)}`);
  assert.deepEqual(a.idle.closed, [[36, 'idle']], JSON.stringify(a.idle));
});

add('new', 'bound', 'A2: HANDOFF_KEEP_BOUND_MS = the longest window index.js gives noteHandoff (waitMinutes cap) + HANDOFF_GRACE_MS; a record noteHandoff writes for that window is valid, not uncertain', async () => {
  await fresh();
  const w = await run(`
    process.env.CHROME_BRIDGE_HABITS = 'off'; process.env.CHROME_BRIDGE_AGENT_STATE = ${JSON.stringify(path.join(tmp, 'agent.json'))};
    const i = await import(${JSON.stringify(path.join(ROOT, 'src', 'index.js'))});
    out({ max: Math.max(i.waitMinutes(1e9, 1), i.waitMinutes(1e9, null), i.waitMinutes(undefined, 1), i.waitMinutes(undefined, null)) * 60_000 });
    process.exit(0);`);
  assert.equal(T.HANDOFF_MAX_WINDOW_MS, w.max, 'the bound follows the longest window wait_for_user can have');
  assert.equal(T.HANDOFF_KEEP_BOUND_MS, T.HANDOFF_MAX_WINDOW_MS + GRACE);
  assert.equal(T.HANDOFF_KEEP_BOUND_MS, BOUND);
  const a = await owner(`
    const now = Date.now();
    await T.registerTab(37, url(37), { windowId: 7, now });
    const h = await T.noteHandoff(37, { pending: true, until: now + T.HANDOFF_MAX_WINDOW_MS });
    out({ pid: process.pid, h, hold: T.handoffHold(await T.getTab(37), Date.now()) });`);
  assert.deepEqual(a.hold, { until: a.h.keepUntil }, JSON.stringify(a));
});

/** The four uncertain kinds: each written into tabs `a` and `b` by the owner process (its own registry writes). */
const BAD = {
  corrupt: id => `writeFileSync(hf(${id}), '{"pending":true,"keepUntil":' + (Date.now() + 60_000 + ${GRACE}));`,
  unreadable: id => `await T.noteHandoff(${id}, { pending: true, until: Date.now() + 60_000 }); chmodSync(hf(${id}), 0o000);`,
  'keep-1e308': id => `writeFileSync(hf(${id}), JSON.stringify({ pending: true, keepUntil: 1e308, at: Date.now(), ownerPid: process.pid }));`,
  // `at` is no excuse: a write time after now counts as now.
  'at-future': id => `writeFileSync(hf(${id}), JSON.stringify({ pending: true, keepUntil: 1e308, at: 1e308, ownerPid: process.pid }));`,
  // A string that would be a valid keepUntil as a number: only its type makes it uncertain.
  'keep-string': id => `writeFileSync(hf(${id}), JSON.stringify({ pending: true, keepUntil: String(Date.now() + 60_000 + ${GRACE}), at: Date.now(), ownerPid: process.pid }));`,
};
for (const [kind, write] of Object.entries(BAD)) {
  add('new', kind, `A2 ${kind}: kept from session end, owner gone and idle until its mtime + the bound, then idle only; once the file is fixed (a new noteHandoff), the valid record's keepUntil rules`, async () => {
    await fresh();
    const [a, b] = [40, 41];
    try {
      const o = await owner(`
        const now = Date.now();
        for (const id of [${a}, ${b}]) await T.registerTab(id, url(id), { windowId: 7, now });
        ${write(a)} ${write(b)}
        const m = [${a}, ${b}].map(id => lstatSync(hf(id)).mtimeMs);
        const before = Math.min(...m) + ${BOUND} - 1000, after = Math.max(...m) + ${BOUND} + 1000;
        let probe = 'readable'; try { readFileSync(hf(${a})); } catch (e) { probe = e.code; }
        out({ pid: process.pid, before, after, probe,
          sBefore: await sweep(chrome([${a}, ${b}]), { exitingPid: T.OWNER_PID, now: before, ttlMs: 1000 }),
          sAfter: await sweep(chrome([${a}, ${b}]), { exitingPid: T.OWNER_PID, now: after, ttlMs: ${HOUR} }) });`);
      show(`${kind} owner session end`, o);
      assert.deepEqual(o.sBefore, none, `session end/idle before the bound: ${JSON.stringify(o.sBefore)}`);
      assert.deepEqual(o.sAfter, none, `session_end after the bound: ${JSON.stringify(o.sAfter)}`);
      assert.equal(o.probe, kind === 'unreadable' ? 'EACCES' : 'readable', 'the file was as this case needs it when swept');
      const before = await otherSweep([a, b], { now: o.before, ttlMs: 1000 });
      assert.deepEqual(before, none, `owner gone/idle before the bound: ${JSON.stringify(before)}`);
      const after = await otherSweep([a, b], { now: o.after, ttlMs: HOUR });
      assert.deepEqual(after, none, `owner_gone after the bound: ${JSON.stringify(after)}`);
      // Recovery: tab b's file is fixed by another process (a hand-off that ended now: keepUntil = now + grace).
      const f = await run(`out(await T.noteHandoff(${b}, { pending: false, until: Date.now() }));`);
      assert.ok(f.keepUntil + 1000 < o.before, 'the fixed record ends before the uncertain bound');
      const fixedIn = await otherSweep([a, b], { now: f.keepUntil - 1000, ttlMs: 1000 });
      assert.deepEqual(fixedIn, none, JSON.stringify(fixedIn));
      const fixedOut = await otherSweep([a, b], { now: f.keepUntil + 1000, ttlMs: 1000 });
      show(`${kind} fixed b past its keepUntil, a still uncertain`, fixedOut);
      assert.deepEqual(fixedOut.closed, [[b, 'idle']], `valid behaviour after the fix: ${JSON.stringify(fixedOut)}`);
      const idle = await otherSweep([a], { now: o.after, ttlMs: 1000 });
      show(`${kind} past the bound, idle met`, idle);
      assert.deepEqual(idle.closed, [[a, 'idle']], `idle only after the bound: ${JSON.stringify(idle)}`);
    } finally {
      for (const id of [a, b]) await chmod(path.join(T.TAB_DIR, `${id}.handoff.json`), 0o644).catch(() => {});
    }
  });
}

add('new', 'stat-fails', 'A2: a hand-off file not even stat can read (a symlink loop: ELOOP): every sweep leaves the tab alone, whatever the time; once fixed, the valid record rules', async () => {
  await fresh();
  const o = await owner(`
    await T.registerTab(42, url(42), { windowId: 7, now: Date.now() });
    symlinkSync('42.handoff.json', hf(42));
    let probe = 'stat ok'; try { statSync(hf(42)); } catch (e) { probe = e.code; }
    out({ pid: process.pid, probe, s: await sweep(chrome([42]), { exitingPid: T.OWNER_PID, now: Date.now() + 86_400_000, ttlMs: 1000 }) });`);
  show('stat-fails owner session end (+1 day)', o.s);
  assert.deepEqual(o.s, none, JSON.stringify(o.s));
  assert.equal(o.probe, 'ELOOP', 'stat of the hand-off file fails');
  const s = await otherSweep([42], { now: Date.now() + 86_400_000, ttlMs: 1000 });
  assert.deepEqual(s, none, JSON.stringify(s));
  const f = await run(`out(await T.noteHandoff(42, { pending: false, until: Date.now() }));`);
  assert.deepEqual(await otherSweep([42], { now: f.keepUntil - 1000, ttlMs: 1000 }), none);
  const fixed = await otherSweep([42], { now: f.keepUntil + 1000, ttlMs: 1000 });
  assert.deepEqual(fixed.closed, [[42, 'idle']], JSON.stringify(fixed));
});

add('new', 'recheck-corrupt', 'A2 re-check: another server planned owner_gone; a third process leaves a corrupt hand-off file before the close: refused at the re-check, zero close calls', async () => {
  await fresh();
  await owner(`await T.registerTab(43, url(43), { windowId: 7, now: Date.now() }); out({ pid: process.pid });`);
  const gate = gateFiles('corrupt');
  const sweeping = otherSweep([43], { ttlMs: HOUR }, gate);
  await until(() => existsSync(gate.listed), 8000, 'the other server\'s listing');
  await run(`writeFileSync(hf(43), '{"pending":tr'); out({ pid: process.pid });`);
  await writeFile(gate.go, '1');
  const s = await sweeping;
  show('recheck-corrupt', s);
  assert.deepEqual(s.calls, [], `the re-check let a tab with a corrupt hand-off close: ${JSON.stringify(s)}`);
  assert.deepEqual(s.deferred, [[43, 'ownership_unverified']]);
});

/* ------------------------------------------------------------ kept behaviour */

add('kept', 'production-refuses', 'production default deps refuse native close at session end and for owner gone/idle after a hand-off\'s protection ended: zero close calls, records kept, never marked closeBlocked', async () => {
  await fresh();
  const bridge = `
    const calls = [], reads = [];
    T.__setBridgeForTests({ listTabs: async o => { reads.push(o ?? null); return listing([31, 32]); },
      closeTab: async id => { calls.push(id); return { ok: true }; }, cgevent: async () => ({}) });`;
  const a = await owner(`${bridge}
    const now = Date.now();
    await T.registerTab(31, url(31), { windowId: 7, now });
    await T.registerTab(32, url(32), { windowId: 7, now: now - ${HOUR} });
    await T.noteHandoff(32, { pending: true, until: now - 50 * 60_000, now: now - 55 * 60_000 });   // protection over 30 min ago
    const r = await T.sweepTabs({ exitingPid: T.OWNER_PID, ttlMs: 60_000, lockDir: LOCK });
    out({ pid: process.pid, closed: r.closed.length, blocked: r.blocked.length, deferred: (r.deferred || []).map(x => [x.tabId, x.reason]), calls, reads });`);
  show('production-refuses session end', a);
  assert.deepEqual(a.calls, []); assert.equal(a.closed, 0); assert.equal(a.blocked, 0);
  assert.deepEqual(a.reads, [{ cold: true }], 'the production cold listing was used');
  assert.deepEqual(a.deferred.map(d => d[1]), a.deferred.map(() => 'native_session_required'));
  assert.ok(a.deferred.some(d => d[0] === 31));
  const s = await run(`${bridge}
    const r = await T.sweepTabs({ ttlMs: 60_000, lockDir: LOCK });
    out({ closed: r.closed.length, deferred: (r.deferred || []).map(x => [x.tabId, x.reason]), calls });`);
  show('production-refuses other server after expiry', s);
  assert.deepEqual(s.calls, []); assert.equal(s.closed, 0);
  assert.deepEqual(s.deferred.sort((x, y) => x[0] - y[0]), [[31, 'native_session_required'], [32, 'native_session_required']]);
  for (const id of [31, 32]) assert.equal((await T.getTab(id)).closeBlocked, false);
});

add('kept', 'owner-close-tab', 'the owner\'s close_tab (closeAgentTab with index.js\'s canCloseRecord) still closes its tab while a hand-off on it is pending', async () => {
  await fresh();
  const a = await owner(`
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    const isMine = rec => !!rec && Number(rec.ownerPid) === T.OWNER_PID;
    await T.registerTab(33, url(33), { windowId: 7, now: Date.now() });
    await T.noteHandoff(33, { pending: true, until: Date.now() + 60_000 });
    const c = chrome([33]);
    const r = await T.closeAgentTab(33, { listTabs: c.listTabs, closeTab: c.closeTab, clickedSince: c.clickedSince, lockDir: LOCK,
      canCloseRecord: rec => !(rec.popup && !isMine(rec)) && (isMine(rec) || !alive(Number(rec.ownerPid))) });
    out({ pid: process.pid, r, calls: c.calls, left: await T.getTab(33) });`);
  show('owner-close-tab', a);
  assert.deepEqual(a.r, { ok: true, closed: true });
  assert.deepEqual(a.calls, [33]);
  assert.equal(a.left, null);
});

add('kept', 'unprotected', 'without a hand-off: session end and owner gone still pick the tab', async () => {
  await fresh();
  const a = await owner(`
    await T.registerTab(34, url(34), { windowId: 7, now: Date.now() });
    out({ pid: process.pid, ...await sweep(chrome([34]), { exitingPid: T.OWNER_PID, ttlMs: ${HOUR} }) });`);
  show('unprotected session end', a);
  assert.deepEqual(a.closed, [[34, 'session_end']]);
  await owner(`await T.registerTab(35, url(35), { windowId: 7, now: Date.now() }); out({ pid: process.pid });`);
  const s = await otherSweep([35], { ttlMs: HOUR });
  show('unprotected owner gone', s);
  assert.deepEqual(s.closed, [[35, 'owner_gone']]);
});

/* ------------------------------------------------------------ run */

let passed = 0;
try {
  for (const kind of ['new', 'kept']) {
    console.log(kind === 'new' ? 'new fix (fails with the source change reverted)' : 'kept behaviour');
    for (const c of cases.filter(x => x.kind === kind && (!ONLY || x.name === ONLY))) {
      await c.fn();
      passed++;
      console.log(`  ok  [${c.name}] ${c.label}`);
    }
  }
  assert.ok(passed > 0, `no case named ${ONLY}`);
  for (const line of evidence) console.log(`  evidence  ${line}`);
  console.log(`\nhandoff-owner-sweep tests passed (${passed}).`);
} finally { await rm(tmp, { recursive: true, force: true }); }
