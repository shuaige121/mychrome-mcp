/* Task ownership regressions: real production functions, simulated clocks and
 * helper replies. No browser, runtime files, or physical input is opened. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BridgeError } from '../src/bridge.js';
import { RoutineError, routineMessage } from '../src/routine-runner.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `production function ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function productionConstant(name) {
  const match = source.match(new RegExp(`^const ${name} = .+;$`, 'm'));
  assert.ok(match, `production constant ${name}`);
  return match[0];
}

function harness({ plan = true, task = 'Read the whole paper' } = {}) {
  const calls = [], timers = [];
  const state = {
    now: 1_000_000, paused: false, queue: [],
    status: { ok: true, takeover: { active: true, aborted: false } },
  };
  const timer = (kind, fn, ms) => {
    const t = { kind, fn, ms, active: true };
    timers.push(t);
    return t;
  };
  const clear = t => { if (t) t.active = false; };
  class Clock extends Date { static now() { return state.now; } }
  const c = vm.createContext({
    Date: Clock, Math, Number, String, Error, Map, Set, BridgeError, RoutineError, routineMessage,
    CALL: { getStore: () => null }, ROUTINES: { runner: { busy: () => null, hasPending: () => false }, beforeInput: async () => {} },
    PLAN: null, PANEL_TASK: { text: task, at: state.now },
    GUI_SERVICE: null,
    TASK_HOLD: null, TASK_CANCELLED: null, YIELDING: null,
    HOLD_ENDING: 0, INFLIGHT: 0, LAST_CALL_END: 0, GOTO: { running: false },
    TASK_GAP_MS: 30_000, PLAN_GAP_MS: 90_000, PANEL_TASK_KEEP_MS: 600_000,
    TASK_LIMITS: { takeoverMaxMs: 1_800_000, takeoverIdleMs: 60_000 },
    NOTES: [], BLOCKS: new Map(),
    STUCK: { n: 0, last: '', toldAt: 0, since: 0 },
    S: { get: key => key === 'paused' && state.paused },
    B: { keepAwake: () => {
      calls.push(['awake']);
      return () => calls.push(['stop-awake']);
    } },
    connectTaskFeed: async () => {},
    closeTaskFeed: () => {},
    VISIBLE_FEED: null, VISIBLE_FEED_REASON: null, VISIBLE_FEED_SOURCE: null,
    setTimeout: (fn, ms) => timer('timeout', fn, ms),
    setInterval: (fn, ms) => timer('interval', fn, ms),
    clearTimeout: clear, clearInterval: clear,
    writeTaskState: () => calls.push(['state']),
    debugLog: value => calls.push(['debug', value]),
    queueList: async () => { calls.push(['queue']); return state.queue; },
    yieldTurn: async () => calls.push(['yield']),
    endTaskHold: async () => {
      const held = c.TASK_HOLD;
      if (!held) return null;
      calls.push(['release']);
      clear(held.timer); clear(held.poll);
      c.TASK_HOLD = null;
      return { inputReleased: true, appRestored: true, pointerRestored: true };
    },
    taskCancelledError: () => new BridgeError('user_cancelled', 'stopped by user'),
    acquireLease: async () => { throw Error('unexpected new input lease'); },
    runInputAction: async () => { throw Error('unexpected physical input'); },
  });
  const fnNames = ['clearTaskPlan', 'interruptTaskPlan', 'taskInterruptionReason',
    'taskInterruptedError', 'conversationInputCheck', 'suspendForConversationReply', 'post',
    'maintainTaskAfterError', 'pauseCleanup', 'feedSnapshot', 'taskFeedMessage', 'taskPlanTool',
    'taskKey', 'startGap', 'taskRun', 'handoverRefusal'];
  vm.runInContext([
    ...['holdActive', 'givenBackBy'].map(productionConstant),
    ...fnNames.map(productionFunction),
  ].join('\n'), c);
  if (plan) c.PLAN = {
    task, steps: ['Read', 'Answer', 'Review'], current: 1,
    t0: state.now, currentSince: state.now, estimateMs: 3_600_000,
    stopAwake: () => calls.push(['stop-awake']),
  };
  const th = {
    task,
    kept: { session: { request: async req => {
      calls.push([req.op, req]);
      return req.op === 'status' ? state.status : { ok: true, held: true };
    } } },
  };
  c.TASK_HOLD = th;
  const count = kind => calls.filter(x => x[0] === kind).length;
  const poll = async () => {
    const t = timers.findLast(t => t.kind === 'interval' && t.active);
    assert.ok(t, 'a hold must have a live stop/liveness watcher');
    await t.fn();
  };
  return { c, th, calls, timers, state, count, poll };
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL  ${name}\n${error.stack}`);
  }
}

await check('an explicit plan survives long thinking gaps and never yields to a queued agent', async () => {
  const h = harness();
  h.state.queue = [{ inherit: true, task: 'Other agent' }];
  h.c.startGap(h.th);
  assert.equal(h.timers.some(t => t.kind === 'timeout' && t.active), false);
  for (let i = 0; i < 8; i++) {
    h.state.now += 15 * 60_000;
    await h.poll();
  }
  assert.equal(h.c.TASK_HOLD, h.th);
  assert.equal(h.count('release'), 0);
  assert.equal(h.count('yield'), 0);
  assert.equal(h.count('status'), 8, 'stop and helper liveness remain monitored');
});

await check('an explicit plan remains the action identity after the old ten-minute cache expires', async () => {
  const h = harness();
  h.state.now += 2 * 60 * 60_000;
  assert.equal(h.c.taskKey({}), h.th.task);
  assert.equal(h.c.taskKey({ task: 'An individual click' }), h.th.task);
});

await check('an ordinary named task still releases after its normal inactivity gap', async () => {
  const h = harness({ plan: false });
  h.c.startGap(h.th);
  const deadline = h.timers.find(t => t.kind === 'timeout' && t.active);
  assert.equal(deadline?.ms, 30_000);
  await deadline.fn();
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.TASK_HOLD, null);
});

await check('an ordinary task can still yield between actions to a queued agent', async () => {
  const h = harness({ plan: false });
  h.state.queue = [{ inherit: true }];
  h.c.startGap(h.th);
  await h.poll();
  assert.equal(h.count('yield'), 1);
});

await check('Esc stops the whole plan and repeated actions cannot consume the cancellation', async () => {
  const h = harness();
  h.c.startGap(h.th);
  h.state.status = { ok: true, takeover: { active: false, aborted: true, abortedBy: 'esc' } };
  await h.poll();
  assert.equal(h.count('release'), 1);
  assert.equal(h.count('stop-awake'), 1);
  assert.equal(h.c.PLAN.interrupted.code, 'esc');
  assert.equal(h.c.TASK_CANCELLED, h.th.task);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(h.c.taskRun('click', {}, () => {}, h.th.task),
      error => error.code === 'user_cancelled');
    assert.equal(h.c.TASK_CANCELLED, h.th.task);
  }
});

await check('an expired display cache cannot erase the identity of a user-stopped task', async () => {
  const h = harness({ plan: false });
  h.c.TASK_HOLD = null;
  h.c.TASK_CANCELLED = h.th.task;
  h.state.now += 2 * 60 * 60_000;
  assert.equal(h.c.taskKey({}), h.th.task);
});

await check('a fresh explicit plan clears cancellation; done does not silently resume it', async () => {
  const h = harness({ plan: false });
  h.c.TASK_HOLD = null;
  h.c.TASK_CANCELLED = h.th.task;
  await h.c.taskPlanTool({ done: true });
  assert.equal(h.c.TASK_CANCELLED, h.th.task);
  await h.c.taskPlanTool({
    task: h.th.task, steps: ['Continue after the user resumes', 'Finish'], estimate_minutes: 2,
  });
  assert.equal(h.c.TASK_CANCELLED, null);
  assert.equal(h.c.PLAN.task, h.th.task);
});

await check('upgrading a same-name implicit task releases its old hold and bounded timers', async () => {
  const h = harness({ plan: false });
  h.c.startGap(h.th);
  assert.equal(h.timers.some(t => t.active && t.kind === 'timeout'), true);
  await h.c.taskPlanTool({
    task: h.th.task, steps: ['Read the full paper', 'Answer', 'Review'], estimate_minutes: 60,
  });
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.TASK_HOLD, null, 'the next action must create a fresh explicit-plan helper hold');
  assert.equal(h.timers.some(t => t.active), false, 'old gap and helper polling timers are cancelled');
  assert.equal(h.c.PLAN.task, h.th.task);
});

await check('updating a same-name explicit plan retains its existing continuous hold', async () => {
  const h = harness();
  h.c.startGap(h.th);
  const watcher = h.th.poll;
  await h.c.taskPlanTool({
    task: h.th.task, steps: ['Read the full paper', 'Answer', 'Review', 'Submit'], estimate_minutes: 60,
  });
  assert.equal(h.count('release'), 0);
  assert.equal(h.c.TASK_HOLD, h.th);
  assert.equal(h.th.poll, watcher);
  assert.equal(watcher.active, true);
  assert.equal(h.timers.some(t => t.active && t.kind === 'timeout'), false);
  assert.equal(h.c.PLAN.steps.length, 4);
});

await check('repeating a long plan name retains the hold despite its shortened panel label', async () => {
  const h = harness({ plan: false });
  const task = 'Review the complete forty-question reading paper and verify every saved answer';
  h.c.TASK_HOLD = null;
  await h.c.taskPlanTool({ task });
  h.th.task = h.c.PLAN.task;
  assert.notEqual(h.th.task, task, 'the display name is shortened');
  h.c.TASK_HOLD = h.th;
  h.c.startGap(h.th);
  const watcher = h.th.poll;
  await h.c.taskPlanTool({ task, steps: ['Review', 'Submit'] });
  assert.equal(h.count('release'), 0);
  assert.equal(h.c.TASK_HOLD, h.th);
  assert.equal(h.c.PLAN.fullTask, task);
  assert.equal(h.th.poll, watcher);
  assert.equal(watcher.active, true);
});

await check('different long names with the same panel label still end the previous hold', async () => {
  const h = harness({ plan: false });
  const prefix = 'Review the complete forty-question reading paper';
  h.c.TASK_HOLD = null;
  await h.c.taskPlanTool({ task: `${prefix} for the first student` });
  h.th.task = h.c.PLAN.task;
  h.c.TASK_HOLD = h.th;
  h.c.startGap(h.th);
  await h.c.taskPlanTool({ task: `${prefix} for the second student` });
  assert.equal(h.c.PLAN.task, h.th.task, 'both names have the same display prefix');
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.TASK_HOLD, null);
  assert.equal(h.timers.some(t => t.active), false);
});

await check('pause during a thinking gap releases input and clears the active task card', async () => {
  const h = harness();
  h.c.startGap(h.th);
  h.state.paused = true;
  await h.poll();
  assert.equal(h.count('release'), 1);
  assert.equal(h.count('stop-awake'), 1);
  assert.equal(h.c.TASK_HOLD, null);
  assert.equal(h.c.PLAN, null);
});

await check('an unknown helper state releases ownership and preserves the unfinished task', async () => {
  const h = harness();
  h.c.startGap(h.th);
  h.state.status = null;
  await h.poll();
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.TASK_HOLD, null);
  assert.equal(h.c.PLAN.task, h.th.task);
  assert.equal(h.c.PLAN.interrupted.code, 'hold_unverified');
  assert.equal(h.c.TASK_CANCELLED, null, 'missing observation is not a user Stop');
  assert.equal(h.count('stop-awake'), 1);
  await assert.rejects(h.c.taskRun('click', {}, () => {}, h.th.task),
    error => error.code === 'task_interrupted');
  const result = await h.c.taskPlanTool({ done: true });
  assert.match(result, /Read the whole paper/);
  assert.doesNotMatch(result, /没有进行中的任务/);
  assert.equal(h.c.PLAN, null);
});

await check('hot swap waits for an explicit plan even before its first input and after a long gap', async () => {
  const h = harness();
  h.c.TASK_HOLD = null;
  h.state.now += 2 * 60 * 60_000;
  assert.equal(h.c.handoverRefusal(), 'plan');
  h.c.clearTaskPlan();
  assert.equal(h.c.handoverRefusal(), null);
});

function inputDispatchHarness(h) {
  const result = { outcome: 'ok', out: 'done', kept: {} };
  Object.assign(h.c, {
    TAKEOVER: true, TAKEOVER_LIMITS: {},
    userActedSince: async () => false,
    userClickedSince: async () => false,
    openOwnSession: async () => { throw Error('unexpected native session'); },
    queueNote: () => '', timingLine: () => '', TASK_NOTE: () => '', lockInfo: () => ({}),
    withInputLock: async () => {
      h.calls.push(['standalone']);
      return { result, waitedMs: 0 };
    },
    taskRun: async () => {
      h.calls.push(['task-dispatch']);
      if (h.c.TASK_CANCELLED) throw new BridgeError('user_cancelled', 'stopped');
      return { result, waitedMs: 0 };
    },
  });
  vm.runInContext(productionFunction('inputActionRun'), h.c);
  return () => h.c.inputActionRun('click', async () => {}, async () => {}, {
    doneNote: '', activates: true, preflight: null, idle: {}, veil: null, task: h.th.task,
  });
}

await check('disabling implicit task gaps does not disable an explicit whole-task hold', async () => {
  const h = harness();
  h.c.TASK_GAP_MS = 0;
  await inputDispatchHarness(h)();
  assert.equal(h.count('task-dispatch'), 1);
  assert.equal(h.count('standalone'), 0);
});

await check('disabling implicit task gaps cannot bypass a stopped-task input gate', async () => {
  const h = harness({ plan: false });
  h.c.TASK_GAP_MS = 0;
  h.c.TASK_CANCELLED = h.th.task;
  await assert.rejects(inputDispatchHarness(h)(), error => error.code === 'user_cancelled');
  assert.equal(h.count('standalone'), 0);
});

await check('a recoverable tool error preserves the same verified healthy hold and plan', async () => {
  const h = harness(), callState = {};
  h.c.startGap(h.th);
  Object.assign(h.c, {
    CALL: { getStore: () => callState },
    pauseGate: async () => {},
    click: async () => {
      throw new BridgeError('target_unavailable', 'The requested control is unavailable');
    },
    noteOutcome: (ok, error) => h.calls.push(['outcome', ok, error?.code]),
    FALLBACK_CODES: new Set(), FALLBACK_HINT: '',
    goneTabNote: () => '', setupHint: () => '',
  });
  vm.runInContext(productionFunction('callToolInner'), h.c);
  const reply = await h.c.callToolInner('click', {}, {}, async () => '');
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /control is unavailable/);
  assert.equal(callState.failed, true);
  assert.equal(callState.code, 'target_unavailable');
  assert.equal(h.count('release'), 0);
  assert.equal(h.count('stop-awake'), 0);
  assert.equal(h.c.TASK_HOLD, h.th);
  assert.equal(h.c.PLAN.task, h.th.task);
  assert.equal(h.c.PLAN.interrupted, undefined);
  assert.equal(h.timers.some(t => t.active), true);
});

await check('a tool error with unknown ownership pauses input without erasing the task', async () => {
  const h = harness();
  h.c.startGap(h.th);
  h.state.status = null;
  assert.equal(await h.c.maintainTaskAfterError(new BridgeError('target_unavailable', 'missing marker')), false);
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.PLAN.interrupted.code, 'hold_unverified');
  assert.equal(h.c.TASK_CANCELLED, null);
  assert.equal(h.c.TASK_HOLD, null);
  await assert.rejects(h.c.taskRun('click', {}, () => {}, h.th.task),
    error => error.code === 'task_interrupted');
});

await check('a confirmed system interruption preserves its cause and never retakes input', async () => {
  const h = harness();
  h.c.startGap(h.th);
  h.state.status = { ok: true, takeover: { active: false, aborted: true, abortedBy: 'tap_disabled' } };
  await h.poll();
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.PLAN.interrupted.code, 'tap_disabled');
  assert.equal(h.c.TASK_CANCELLED, null);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(h.c.taskRun('click', {}, () => {}, h.th.task),
      error => error.code === 'task_interrupted');
  }
  await h.c.taskPlanTool({ task: h.th.task, steps: ['Resume after inspection', 'Finish'] });
  assert.equal(h.c.PLAN.interrupted, undefined);
  assert.equal(h.c.TASK_HOLD, null, 'a restart does not itself send any input');
});

await check('a blocked page releases even a healthy hold and retains an interrupted task', async () => {
  const h = harness();
  h.c.startGap(h.th);
  assert.equal(await h.c.maintainTaskAfterError(new BridgeError('site_blocked', 'user must handle the challenge')), false);
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.PLAN.interrupted.code, 'site_blocked');
  assert.equal(h.c.TASK_HOLD, null);
});

await check('a question before the first hold prevents any new input lease', async () => {
  const h = harness();
  h.c.TASK_HOLD = null;
  h.c.GUI_SERVICE = { snapshot: () => ({ pending: [{ requestId: 1 }] }) };
  await assert.rejects(h.c.taskRun('click', {}, () => {}, h.th.task), e => e.code === 'conversation_waiting');
  assert.equal(h.c.TASK_HOLD, null);
});

await check('a question between steps releases input and retains the unfinished plan', async () => {
  const h = harness();
  h.c.GUI_SERVICE = { snapshot: () => ({ pending: [{ requestId: 1 }] }) };
  await h.c.suspendForConversationReply();
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.PLAN.interrupted.code, 'conversation_waiting');
  h.c.GUI_SERVICE = null; // Another GUI has answered; an old in-flight action still cannot continue.
  assert.throws(() => h.c.conversationInputCheck(), e => e.code === 'conversation_waiting');
  await assert.rejects(h.c.taskRun('click', {}, () => {}, h.th.task), e => e.code === 'task_interrupted');
});

await check('a question during input blocks the next event without racing restoration', async () => {
  const h = harness();
  h.th.busy = true;
  h.c.GUI_SERVICE = { snapshot: () => ({ pending: [{ requestId: 1 }] }) };
  await h.c.suspendForConversationReply();
  assert.equal(h.count('release'), 0);
  let posted = 0, marked = 0;
  await assert.rejects(h.c.post({ request: () => posted++ }, { sent: () => marked++ },
    'key', { op: 'key', name: 'return' }), e => e.code === 'conversation_waiting');
  assert.equal(posted, 0);
  assert.equal(marked, 0);
});

await check('a question arriving at action completion releases the newly retained hold', async () => {
  const h = harness();
  h.c.TASK_HOLD = null;
  h.c.lockInfo = () => ({});
  h.c.acquireLease = async () => ({ release: async () => {} });
  h.c.runInputAction = async () => {
    h.c.GUI_SERVICE = { snapshot: () => ({ pending: [{ requestId: 1 }] }) };
    return { kept: h.th.kept };
  };
  await assert.rejects(h.c.taskRun('click', {}, () => {}, h.th.task), e => e.code === 'conversation_waiting');
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.TASK_HOLD, null);
  assert.equal(h.c.PLAN.interrupted.code, 'conversation_waiting');
});

await check('a quickly answered question cannot leave a late completed action holding input', async () => {
  const h = harness();
  h.th.busy = true;
  h.c.runInputAction = async () => {
    h.c.GUI_SERVICE = { snapshot: () => ({ pending: [{ requestId: 1 }] }) };
    await h.c.suspendForConversationReply();
    h.c.GUI_SERVICE = { snapshot: () => ({ pending: [] }) };
    return { kept: h.th.kept };
  };
  await assert.rejects(h.c.taskRun('click', {}, () => {}, h.th.task), e => e.code === 'conversation_waiting');
  assert.equal(h.count('release'), 1);
  assert.equal(h.c.TASK_HOLD, null);
  assert.equal(h.c.PLAN.interrupted.code, 'conversation_waiting');
});

console.log(`task-lifecycle: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
