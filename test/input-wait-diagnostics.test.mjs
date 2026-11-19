import { pageEventStubs } from './page-event-test-stubs.mjs';
/* Production queue/action wiring with a virtual clock. No native helpers,
 * browser, runtime registry, or real sleep is used. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeReturnFocus } from '../src/guard.js';

const [index, lock] = await Promise.all([
  fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/lock.js', import.meta.url), 'utf8'),
]);
function fn(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const failure = code => Object.assign(new BridgeError(code, code), { sent: [] });

function harness(attempts, { task = false, reuse = false, takeover = true } = {}) {
  const state = { now: 1_000_000, attempt: 0, actions: 0, idleCalls: 0, acquisitions: 0, signal: { aborted: false } };
  const diagnostic = { connectionQueueMs: 125, queueMs: 125 };
  const current = () => attempts[state.attempt] || {};
  const kept = { returnFocus: { mode: 'origin', source: 'legacy_default' }, session: {}, scene: null, pointer: null };
  const no = () => {};
  const wait = async () => {
    state.idleCalls++;
    const a = current();
    state.now += a.idle || 0;
    if (a.idleError) throw failure(a.idleError);
    return a.idle || 0;
  };
  const c = vm.createContext({ ...pageEventStubs,
    normalizeReturnFocus, Date: { now: () => state.now }, Math, Number, Error, BridgeError,
    process: { env: {} }, CALL: { getStore: () => diagnostic },
    TASK_CANCELLED: null, TAKEOVER: takeover, PLAN: task ? { task: 'fixture' } : null,
    TASK_GAP_MS: task ? 1000 : 0, TASK_LIMITS: {}, TASK_HOLD: null, YIELDING: null,
    GUI_SERVICE: null, TAKEOVER_LIMITS: {},
    conversationInputCheck: no, pausedCheck: no, startGap: no, writeTaskState: no,
    endTaskHold: async () => {}, taskInterruptedError: () => failure('task_interrupted'),
    taskCancelledError: () => failure('user_cancelled'),
    clearTimeout: no, clearInterval: no, lockInfo: () => ({}), debugLog: no,
    B: { snapshotScene: async () => null, cgevent: async () => null },
    waitForHandsOff: wait, waitForUserIdle: wait,
    userActedSince: async () => false, userClickedSince: async () => false,
    openOwnSession: async () => { throw Error('unexpected native session'); },
    withTurn: ops => ops, ROUTINES: {},
    queueNote: () => '', timingLine: () => '', TASK_NOTE: () => '',
    LATE_USER_NOTE: () => '', notifyUserHeld: no,
    RETRY: { maxMs: 600_000, few: 3, pauseMs: 400 },
    RETRY_WAIT: new Set(['user_busy', 'lock_timeout']), RETRY_FEW: new Set(['focus_unconfirmed']),
    SECURE_WAIT_MS: 120_000, USER_IDLE_MAX_WAIT_MS: 60_000,
    idleForAttempt: () => 1.5, cancelledError: () => failure('cancelled'),
    sleep: async ms => { state.now += ms; },
    // The real acquire loop sees one ticket and deterministic lock replies.
    lease: null, TURN_TIMEOUT_MS: 600_000, HEARTBEAT_MS: 15_000, HEARTBEAT_CAP_MS: 180_000,
    POLL_MS: 100, PENDING: new Set(), OFFER: () => 'unused', readJson: async () => null,
    enqueue: async () => ({ name: 'fixture-ticket', beat: async () => {}, remove: async () => {} }),
    queueList: async () => [{ name: 'fixture-ticket' }],
    tryAcquire: async () => {
      state.acquisitions++;
      state.now += current().queue || 0;
      if (current().cancelQueue) {
        state.signal.aborted = true;
        return { ok: false, holder: { pid: 42, token: 'holder', label: 'fixture' } };
      }
      return { ok: true, token: 'fixture-token' };
    },
    makeTurn: (_label, got) => ({ claimed: true, transferred: false, handoff: got.handoff }),
    startHeartbeat: () => ({ stop: async () => {} }), release: async () => {},
    runInputAction: async ops => {
      if (!ops.reuse) await (ops.takeover ? ops.waitForHandsOff() : ops.waitForUserIdle());
      state.actions++;
      const a = current();
      state.now += a.work || 0;
      state.attempt++;
      if (a.error) throw failure(a.error);
      return { outcome: 'ok', out: 'done', idleWait: a.idle || 0,
        ...(task ? { kept: ops.reuse || kept } : {}) };
    },
  });
  vm.runInContext([
    ...['acquire', 'acquireLease', 'withInputLock'].map(name => fn(lock, name)),
    ...['actionReturnFocus', 'focusReturnNote', 'latchTerminalTaskInterruption', 'taskRun', 'inputActionRun', 'persist'].map(name => fn(index, name)),
  ].join('\n'), c);
  if (reuse) c.TASK_HOLD = { task: 'fixture', kept, lease: { release: async () => {} } };
  const run = () => c.persist(idle => c.inputActionRun('click tab 1', no, no,
    { idle, task: task ? 'fixture' : '', compact: true }), state.signal);
  return { c, state, diagnostic, run };
}

let passed = 0, failed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log(`ok - ${name}`); }
  catch (error) { failed++; console.error(`not ok - ${name}\n${error.stack}`); }
}

for (const task of [false, true]) {
  await check(`${task ? 'task lease' : 'ordinary lock'}: failed 48s wait survives a successful retry exactly once`, async () => {
    const h = harness([
      { queue: 48_000, idle: 1500, work: 900, error: 'focus_unconfirmed' },
      { queue: 200, idle: 500, work: 300 },
    ], { task });
    assert.equal(await h.run(), 'done');
    assert.equal(h.diagnostic.queueMs, 125 + 48_000 + 200);
    assert.equal(h.diagnostic.idleWaitMs, 2000);
    assert.equal(h.diagnostic.connectionQueueMs, 125, 'connection wait remains a separate fact');
    assert.equal(h.diagnostic.firstErrorCode, 'focus_unconfirmed');
    assert.equal(h.state.actions, 2);
  });

  await check(`${task ? 'task lease' : 'ordinary lock'}: cancellation while queued retains wait with zero actions`, async () => {
    const h = harness([{ queue: 48_000, cancelQueue: true }], { task });
    await assert.rejects(h.run(), error => error.code === 'cancelled');
    assert.equal(h.diagnostic.queueMs, 125 + 48_100);
    assert.equal(h.diagnostic.idleWaitMs || 0, 0);
    assert.equal(h.state.actions, 0);
    assert.equal(h.state.idleCalls, 0);
  });
}

for (const takeover of [false, true]) {
  await check(`${takeover ? 'hands-off' : 'polite idle'}: failed wait is recorded without counting action time`, async () => {
    const h = harness([{ queue: 300, idle: 2400, idleError: 'cancelled' }], { takeover });
    await assert.rejects(h.run(), error => error.code === 'cancelled');
    assert.equal(h.diagnostic.queueMs, 425);
    assert.equal(h.diagnostic.idleWaitMs, 2400);
    assert.equal(h.state.actions, 0);
  });
}

await check('reusing a healthy task hold adds no queue or idle wait', async () => {
  const h = harness([{ work: 900 }], { task: true, reuse: true });
  assert.equal(await h.run(), 'done');
  assert.equal(h.diagnostic.queueMs, 125);
  assert.equal(h.diagnostic.connectionQueueMs, 125);
  assert.equal(h.diagnostic.idleWaitMs || 0, 0);
  assert.equal(h.state.acquisitions, 0);
  assert.equal(h.state.idleCalls, 0);
});

await check('a diagnostic callback failure cannot change lock acquisition', async () => {
  const h = harness([{ queue: 300 }]);
  const result = await h.c.withInputLock('fixture', async () => 'input', {
    onWait: () => { throw Error('diagnostic unavailable'); },
  });
  assert.equal(result.result, 'input');
});

await check('pointer motion alone does not impose takeover idle waiting', async () => {
  let reads = 0, slept = 0;
  const c = vm.createContext({ ...pageEventStubs,
    Date: { now: () => 1000 }, BridgeError, OWN_INPUT_END: 0, STUCK_KEY_S: 30,
    NO_REPEAT: /never/, userIdleS: () => 1.5, USER_IDLE_MAX_WAIT_MS: 60_000,
    B: { cgevent: async () => { reads++; return { idle: 0, keyIdle: 100, held: [] }; } },
    sleep: async () => { slept++; throw Error('unexpected pointer wait'); },
  });
  vm.runInContext(fn(index, 'waitForHandsOff'), c);
  assert.equal(await c.waitForHandsOff(), 0);
  assert.equal(reads, 1);
  assert.equal(slept, 0);
});

// Characterization of the existing attribution heuristic, not evidence that
// a physical event belongs to this agent. Held input must always wait.
const ownBoundary = 999_900;
const handsOffBoundaryCases = [];
for (const delta of [0, 1, 19, 20, 21]) {
  for (const held of [[], ['左 ⇧'], ['键码 0']]) {
    handsOffBoundaryCases.push({ name: `own+${delta}/${held.length ? held[0] : 'released'}`,
      own: ownBoundary, keyAt: ownBoundary + delta, held, wait: held.length > 0 || delta > 20 });
  }
}
handsOffBoundaryCases.push(
  { name: 'no-own/released', own: 0, keyAt: ownBoundary, held: [], wait: true },
  { name: 'missing-keyAt/fallback-own/released', own: ownBoundary, held: [], wait: false },
  { name: 'missing-keyAt/fallback-after21/released', own: ownBoundary - 21, held: [], wait: true },
  { name: 'missing-keyAt/fallback-own/held', own: ownBoundary, held: ['左 ⇧'], wait: true },
);
for (const row of handsOffBoundaryCases) {
  await check(`hands-off 20ms boundary: ${row.name}`, async () => {
    let now = 1_000_000, reads = 0;
    const sleeps = [];
    const first = { keyIdle: 0.1, held: row.held,
      ...(Number.isFinite(row.keyAt) ? { keyAt: row.keyAt } : {}) };
    const c = vm.createContext({
      Date: { now: () => now }, Number, Math, BridgeError, OWN_INPUT_END: row.own,
      STUCK_KEY_S: 30, NO_REPEAT: /^(左|右) (⌘|⇧|⌥|⌃)$|^fn$|^鼠标/,
      userIdleS: () => 1.5, USER_IDLE_MAX_WAIT_MS: 60_000,
      cancelledError: () => new BridgeError('cancelled', 'cancelled'),
      B: { cgevent: async () => {
        reads++; assert.ok(reads <= 2, 'bounded fake transport');
        return reads === 1 ? first : { keyIdle: 100, held: [] };
      } },
      sleep: async ms => { sleeps.push(ms); now += ms; },
    });
    vm.runInContext(fn(index, 'waitForHandsOff'), c);
    const elapsed = await c.waitForHandsOff();
    assert.equal(reads, row.wait ? 2 : 1);
    assert.equal(sleeps.length, row.wait ? 1 : 0);
    assert.equal(elapsed, row.wait ? (row.held.length ? 100 : 1400) : 0);
  });
}


await check('a non-inheriting current waiter times out behind continuously active origin without reading an offer', async () => {
  const h = harness([{ work: 0 }]); let requestedInherit, offerReads = 0, removed = 0;
  h.c.enqueue = async (_label, _info, inherit) => { requestedInherit = inherit; return { name: 'fixture-ticket', beat: async () => {}, remove: async () => { removed++; } }; };
  h.c.tryAcquire = async () => { h.state.acquisitions++; return { ok: false, holder: { pid: 42, token: 'origin-holder', label: 'continuous origin work' } }; };
  h.c.readJson = async () => { offerReads++; return { state: 'offered' }; };
  const start = h.state.now;
  await assert.rejects(h.c.acquireLease('current waiter', { inherit: false, timeoutMs: 300 }), error => error.code === 'lock_timeout' && /队伍一直没动/.test(error.message));
  assert.equal(requestedInherit, false); assert.equal(offerReads, 0); assert.equal(removed, 1);
  assert.equal(h.state.actions, 0); assert.ok(h.state.now - start >= 300 && h.state.now - start <= 600);
});

console.log(`${passed} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
