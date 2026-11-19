// Production warm-pool selection against process/file metadata; no real child or browser.
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const fn = name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
let metadata = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
let next = 0;
const killed = [], pool = [];
// The production read-only allowlist; these fixture children have reported ready for Chrome pid 42.
const READ_COMMANDS = vm.runInNewContext(source.match(/^const WARM_READ_COMMANDS = (.+);$/m)[1]);
const context = vm.createContext({
  CHROMECTL: '/fixture/chromectl', WARM_POOL: 3, WARM_MAX_AGE_MS: 1000, warmPool: pool,
  WARM_IDLE_MS: 60_000, warmIdle: { lastUse: 0, busy: 0, timer: null }, performance: { now: () => 2000 }, setTimeout: () => 1,
  WARM_READ_COMMANDS: READ_COMMANDS, warmRetryAt: 0, process: { kill: () => true },
  Date: { now: () => 2000 }, statSync: file => { assert.equal(file, '/fixture/chromectl'); if (!metadata) throw Error('unavailable'); return metadata; },
  spawnWarm(identity) { const id = ++next; return { id, identity, born: 2000, dead: false, ready: true, chromePid: 42, child: { kill: () => killed.push(id) } }; },
});
vm.runInContext(['helperIdentity', 'takeWarm', 'noteWarmUse', 'armWarmReaper', 'reapIdleWarm'].map(fn).join('\n'), context);
assert.equal(context.takeWarm(['list']), null);
assert.equal(pool.length, 3);
const inFlight = context.takeWarm(['list']);
assert.equal(inFlight.id, 1);
metadata = { ...metadata, ino: 99 };
assert.equal(context.takeWarm(['list']), null, 'atomic replacement must not consume an old helper');
assert.deepEqual(killed, [2, 3, 4]);
assert.equal(killed.includes(inFlight.id), false, 'in-flight helper must remain untouched');
assert.equal(pool.length, 3);
assert.equal(context.takeWarm(['list']).id, 5);
metadata = { ...metadata, mtimeMs: 8 };
assert.equal(context.takeWarm(['list']), null, 'in-place binary changes must also invalidate the pool');
assert.deepEqual(killed, [2, 3, 4, 6, 7, 8]);
const latest = context.takeWarm(['list']);
assert.equal(latest.id, 9);
metadata = null;
assert.equal(context.takeWarm(['list']), null, 'unknown binary identity must use the cold path');
assert.equal(pool.length, 0);
assert.equal(next, 12, 'unavailable binary must not start more pool children');
assert.equal(killed.includes(latest.id), false);
console.log('warm-helper: replacement, in-place change, unavailable identity and in-flight preservation passed');

// C9: the pool starts only with a real call; the tab sweep (production src/tabs.js) reads cold and
// neither takes, refills nor keeps the pool alive; idle children get SIGTERM after WARM_IDLE_MS;
// a child serving a command is never reaped and its reply arrives. Fake children, clock and timers.
{
  const constant = name => Number(vm.runInNewContext(source.match(new RegExp(`^const ${name} = (.+);$`, 'm'))[1]));
  const IDLE = constant('WARM_IDLE_MS');
  assert.ok(constant('WARM_POOL') <= 3 && IDLE > 0 && IDLE <= 10 * 60_000, 'idle children must be gone within 10 minutes');
  const prod = name => { const s = fn(name), at = source.indexOf(s); return source.slice(at - 6, at) === 'async ' ? `async ${s}` : s; };
  let clock = 0, timerSeq = 0, spawned = 0, hold = false;
  const timers = new Map(), kills = [], cold = [], children = [];
  const LISTING = JSON.stringify({ ok: true, chromePid: 42, frontmost: 'WeChat',
    windows: [{ id: 7, index: 1, minimized: false, tabs: [{ id: 90, url: 'https://a.test/90', title: 't', active: true }] }] });
  const ctx = vm.createContext({
    CHROMECTL: '/fixture/chromectl', WARM_ON: true, WARM_POOL: constant('WARM_POOL'), WARM_MAX_AGE_MS: constant('WARM_MAX_AGE_MS'),
    WARM_IDLE_MS: IDLE, WARM_CALL_MS: constant('WARM_CALL_MS'), warmPool: [], warmIdle: { lastUse: 0, busy: 0, timer: null }, WARM_READ_COMMANDS: READ_COMMANDS, warmRetryAt: 0,
    Date: { now: () => clock }, performance: { now: () => clock },
    setTimeout: (f, ms) => { const id = ++timerSeq; timers.set(id, { f, at: clock + ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
    statSync: () => ({ dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 }),
    spawnWarm(identity) {
      const w = { id: ++spawned, identity, born: clock, dead: false, ready: true, chromePid: 42, out: '', err: '', command: null };
      w.done = new Promise(r => { w.finish = out => { w.out = out; w.dead = true; r(); }; });
      w.child = { stdin: { end: line => { w.command = line; if (!hold) queueMicrotask(() => w.finish(LISTING)); } },
        kill: sig => { kills.push([w.id, sig]); w.finish(''); } };   // a signalled child exits
      children.push(w);
      return w;
    },
    execFileP: async (_file, argv) => { cold.push(argv.join(' ')); return { stdout: LISTING, stderr: '' }; },
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    humanMessage: (code, message) => message || code, driverFailureFacts: () => ({}), process: { env: {}, stderr: { write() {} }, kill: () => true },
  });
  vm.runInContext(['helperIdentity', 'takeWarm', 'noteWarmUse', 'armWarmReaper', 'reapIdleWarm', 'runWarm', 'runDriver', 'listTabs']
    .map(prod).join('\n'), ctx);
  const pool = () => ctx.warmPool.map(w => w.id);
  const advance = async ms => {
    const end = clock + ms;
    for (let due; (due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]);) {
      timers.delete(due[0]); clock = due[1].at; due[1].f();
      await new Promise(r => setImmediate(r));
    }
    clock = end;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-warm-c9-'));
  process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
  process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
  fs.mkdirSync(path.join(tmp, 'lock'));
  const T = await import('../src/tabs.js');
  T.__setBridgeForTests({ listTabs: ctx.listTabs, closeTab: () => { throw Error('a sweep must not close here'); }, cgevent: async () => ({}) });
  await T.registerTab(90, 'https://a.test/90', { windowId: 7 });   // a registered tab: the sweep has to read Chrome
  const sweep = async () => {
    const before = cold.length, r = await T.sweepTabs({ lockDir: process.env.CHROME_BRIDGE_LOCK, isAlive: () => true });
    assert.deepEqual(cold.slice(before), ['list'], 'a sweep reads Chrome once, on the cold path');
    assert.deepEqual([r.closed, r.marked], [[], []]);
  };

  await sweep();
  assert.deepEqual([spawned, pool(), timers.size], [0, [], 0], 'a sweep in a fresh session starts no warm helper');

  assert.equal(JSON.parse(JSON.stringify(await ctx.listTabs())).windows.length, 1);
  assert.deepEqual([cold.length, spawned, pool(), timers.size], [2, 3, [1, 2, 3], 1], 'the first real call starts the pool (≤3)');
  const used = ctx.warmIdle.lastUse;
  for (let m = 1; m <= 4; m++) { await advance(60_000); await sweep(); }
  assert.deepEqual([spawned, pool(), kills, ctx.warmIdle.lastUse], [3, [1, 2, 3], [], used], 'sweeps neither take, refill nor keep the pool alive');
  await advance(IDLE - 4 * 60_000);
  assert.deepEqual([pool(), kills, timers.size], [[], [[1, 'SIGTERM'], [2, 'SIGTERM'], [3, 'SIGTERM']], 0], 'idle pool ended by SIGTERM');
  await advance(IDLE); await sweep();
  assert.deepEqual([spawned, pool()], [3, []], 'a sweep after the reap does not restart the pool');

  await ctx.listTabs();
  assert.deepEqual([cold.length, spawned, pool()], [8, 6, [4, 5, 6]], 'the first call after idle runs cold and restarts the pool lazily');
  for (let i = 0; i < 4; i++) {
    await ctx.listTabs();
    assert.ok(ctx.warmPool.length === 3 && children.filter(w => !w.dead).length === 3, 'an active session keeps 3 warm children at rest');
  }
  assert.deepEqual([cold.length, spawned], [8, 10]);
  for (let m = 0; m < IDLE / 60_000 + 2; m++) { await advance(60_000); await ctx.listTabs(); }
  assert.deepEqual([kills.length, ctx.warmPool.length], [3, 3], 'a session with a call every minute keeps its pool');

  // The reaper comes due while a command is in flight (taken 10 s before): nothing is ended, the reply arrives.
  await advance(IDLE - 10_000);
  hold = true; const flight = ctx.listTabs(); hold = false;
  const x = children.find(w => w.command && !w.dead);
  assert.ok(x && !ctx.warmPool.includes(x) && ctx.warmPool.length === 3);
  await advance(15_000);
  assert.deepEqual(kills.slice(3), [], 'no child is reaped while a command was just taken');
  x.finish(LISTING);
  assert.equal((await flight).chromePid, 42, 'the in-flight request completes');
  await advance(IDLE);
  assert.deepEqual([ctx.warmPool.length, kills.slice(3).map(k => k[1])], [0, ['SIGTERM', 'SIGTERM', 'SIGTERM']]);
  assert.equal(kills.some(k => k[0] === x.id), false, 'the in-flight child was never signalled');

  // An in-flight command outlasting the idle period (shortened here below the 25 s command limit) defers the reap.
  ctx.WARM_IDLE_MS = 10_000;
  await ctx.listTabs();
  await advance(1_000);
  hold = true; const longer = ctx.listTabs(); hold = false;
  const y = children.find(w => w.command && !w.dead);
  const before = kills.length;
  await advance(14_000);
  assert.deepEqual([kills.length, ctx.warmPool.length], [before, 3], 'nothing is reaped while a command is in flight');
  y.finish(LISTING);
  assert.equal((await longer).chromePid, 42);
  await advance(10_000);
  assert.deepEqual([ctx.warmPool.length, kills.length - before, kills.some(k => k[0] === y.id)], [0, 3, false]);
  assert.equal(timers.size, 0, 'no timer is left once the pool is empty');

  T.__setBridgeForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('warm-helper: lazy start, cold sweep, idle reap and in-flight preservation passed');
}
