import { pageEventStubs } from './page-event-test-stubs.mjs';
/* Task ownership regressions: real production functions, simulated clocks and
 * helper replies. No browser, runtime files, or physical input is opened. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { normalizeReturnFocus, releaseKept } from '../src/guard.js';
import { BridgeError } from '../src/bridge.js';
import { RoutineError, routineMessage } from '../src/routine-runner.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `production function ${name}`);
  return (name === 'callToolInner' ? 'function noticeTerminalRefusal() {}\n' : '') +  source.slice(start, source.indexOf('\n}', start) + 2);
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
  const c = vm.createContext({ ...pageEventStubs,
    normalizeReturnFocus, Date: Clock, Math, Number, String, Error, Map, Set, BridgeError, RoutineError, routineMessage, process: { env: {} },
    CALL: { getStore: () => null }, ROUTINES: { runner: { busy: () => null, hasPending: () => false }, beforeInput: async () => {} },
    PLAN: null, PANEL_TASK: { text: task, at: state.now },
    GUI_SERVICE: null,
    TASK_HOLD: null, TASK_CANCELLED: null, YIELDING: null,
    HOLD_ENDING: 0, INFLIGHT: 0, LAST_CALL_END: 0, GOTO: { running: false },
    TASK_GAP_MS: 30_000, PLAN_GAP_MS: 90_000, PANEL_TASK_KEEP_MS: 600_000,
    TASK_LIMITS: { takeoverMaxMs: 1_800_000, takeoverIdleMs: 60_000 },
    NOTES: [], BLOCKS: new Map(), HANDOFFS: new Map(),
    STUCK: { n: 0, last: '', toldAt: 0, since: 0 },
    S: { get: key => key === 'paused' && state.paused },
    B: { keepAwake: () => {
      calls.push(['awake']);
      return () => calls.push(['stop-awake']);
    } },
    connectTaskFeed: async () => {},
    closeTaskFeed: () => {},
    VISIBLE_FEED: null, VISIBLE_FEED_REASON: null, FEED_UNSUPPORTED_TOLD: false, VISIBLE_FEED_SOURCE: null,
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
      return { inputReleased: true, appRestored: true, pointerRestored: true, returnFocus: { mode: 'origin', source: 'legacy_default' }, focusRestoration: 'requested', releaseReason: 'policy' };
    },
    taskCancelledError: () => new BridgeError('user_cancelled', 'stopped by user'),
    acquireLease: async () => { throw Error('unexpected new input lease'); },
    runInputAction: async () => { throw Error('unexpected physical input'); },
  });
  const fnNames = ['actionReturnFocus', 'focusReturnNote', 'latchTerminalTaskInterruption', 'clearTaskPlan', 'interruptTaskPlan', 'taskInterruptionReason',
    'taskInterruptedError', 'conversationInputCheck', 'suspendForConversationReply', 'post',
    'maintainTaskAfterError', 'pauseCleanup', 'feedSnapshot', 'taskFeedMessage', 'taskPlanTool',
    'taskKey', 'startGap', 'taskRun', 'handoverRefusal', 'endParkedHandoffs'];
  vm.runInContext([
    ...['holdActive', 'givenBackBy'].map(productionConstant),
    ...fnNames.map(productionFunction),
  ].join('\n'), c);
  if (plan) c.PLAN = {
    returnFocus: { mode: 'origin', source: 'legacy_default' }, task, steps: ['Read', 'Answer', 'Review'], current: 1,
    t0: state.now, currentSince: state.now, estimateMs: 3_600_000,
    stopAwake: () => calls.push(['stop-awake']),
  };
  const th = {
    task,
    kept: { returnFocus: { mode: 'origin', source: 'legacy_default' }, session: { request: async req => {
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

await check('task acknowledgement is generic and concise', async () => {
  const h = harness({ plan: false, task: 'Review an official page' });
  h.c.TASK_HOLD = null;
  const reply = await h.c.taskPlanTool({ task: 'Review an official page', steps: ['Read', 'Review'] });
  assert.doesNotMatch(reply, /试卷|题号|不要额外生成/);
  assert.ok(reply.length < 160, reply);
  assert.match(reply, /Review an official page/);
});

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

await check('cancel receipt does not claim unobserved window or pointer restoration', async () => {
  const code = productionFunction('taskCancelledError');
  const error = vm.runInNewContext(code + '\ntaskCancelledError({mode: \'origin\', source: \'explicit\'})', { BridgeError, normalizeReturnFocus, PLAN: null, TASK_HOLD: null });
  assert.equal(error.code, 'user_cancelled');
  assert.match(error.message, /尚未核实/);
  assert.doesNotMatch(error.message, /已还原/);
});

await check('an implicit task with an unknown lost hold never automatically acquires a replacement hold', async () => {
  const h = harness({ plan: false });
  let released = 0, acquired = 0;
  h.th.lease = { release: async () => { released++; } };
  h.c.acquireLease = async () => { acquired++; throw Error('must not retake'); };
  h.c.runInputAction = async () => { throw Object.assign(new Error('unknown hold'), { code: 'task_hold_lost' }); };
  await assert.rejects(h.c.taskRun('fixture input', {}, () => {}, h.th.task), e => e.code === 'task_hold_lost');
  assert.equal(released, 1);
  assert.equal(acquired, 0);
  assert.equal(h.c.TASK_HOLD, null);
});

// C4: failures during an explicit plan, through the production tool-call error path
// (callToolInner → maintainTaskAfterError) and the production taskRun for the next action.
function planToolPath({ held = false, code = null } = {}) {
  const h = harness(), io = { leases: 0, runs: 0, script: [] };
  if (held) h.c.startGap(h.th); else h.c.TASK_HOLD = null;
  Object.assign(h.c, {
    CALL: { getStore: () => (io.store ||= {}) }, pauseGate: async () => {}, touchTab: async () => {},
    noteOutcome: () => {}, goneTabNote: () => '', setupHint: () => '', lockInfo: () => ({}),
    acquireLease: async () => { io.leases++; return { release: async () => {} }; },
    runInputAction: async () => { io.runs++; return { outcome: 'ok', out: 'clicked', kept: h.th.kept }; },
  });
  // Each call fails with its scripted error; with none left it runs one input action through taskRun.
  const tool = async () => {
    const next = io.script.shift();
    if (typeof next === 'function') return next();
    if (next) throw next;
    return (await h.c.taskRun('click', {}, () => {}, h.c.PLAN.task)).result.out;
  };
  Object.assign(h.c, { click: tool, readPage: tool, closeTabTool: tool });
  // The no-input predicate is loaded when production has it; without it the old decision runs unchanged.
  const predicate = source.includes('\nfunction failedWithoutInput(')
    ? [productionConstant('READ_ONLY_TOOLS'), productionFunction('failedWithoutInput')] : [];
  vm.runInContext([...predicate, productionFunction('callToolInner'), ...(code ? [code] : [])].join('\n'), h.c);
  return { h, io, call: (name, args = {}) => h.c.callToolInner(name, args, {}, async () => '') };
}
const failure = (code, facts = {}) => Object.assign(new BridgeError(code, `fixture ${code}`), facts);
const notSent = (code = 'target_unavailable', facts = {}) => failure(code, { inputDelivery: 'not_sent', sent: [], ...facts });

await check('C4: a not_sent failure before the first hold keeps the plan and the next action takes its first hold', async () => {
  const { h, io, call } = planToolPath();
  io.script.push(notSent());
  const failed = await call('click');
  assert.equal(failed.isError, true);
  assert.doesNotMatch(failed.content[0].text, /尚未完成|计划已保留/);
  assert.equal(h.c.PLAN.interrupted, undefined);
  assert.equal(h.c.TASK_CANCELLED, null);
  assert.equal(h.count('stop-awake'), 0);
  const next = await call('click');
  assert.equal(next.isError, undefined, next.content[0].text);
  assert.match(next.content[0].text, /clicked/);
  assert.deepEqual([io.leases, io.runs], [1, 1]);
  assert.equal(h.c.TASK_HOLD?.kept, h.th.kept);
  assert.equal(h.c.PLAN.interrupted, undefined);
});

await check('C4: a refused close_tab or a failed read keeps the plan, and an existing hold stays the same hold', async () => {
  for (const [tool, error] of [['close_tab', notSent('not_your_tab', { sent: undefined })],
    ['close_tab', notSent('taken_over', { sent: undefined })], ['read_page', failure('page_unreadable')]]) {
    const before = planToolPath();
    before.io.script.push(error);
    assert.equal((await before.call(tool, { tab: 1 })).isError, true);
    assert.equal(before.h.c.PLAN.interrupted, undefined, `${tool}/${error.code} before the first hold`);
    assert.equal((await before.call('click')).isError, undefined);
    assert.deepEqual([before.io.leases, before.io.runs], [1, 1]);

    const held = planToolPath({ held: true });
    held.io.script.push(error);
    assert.equal((await held.call(tool, { tab: 1 })).isError, true);
    assert.equal(held.h.c.PLAN.interrupted, undefined, `${tool}/${error.code} with a hold`);
    assert.equal(held.h.c.TASK_HOLD, held.h.th);
    assert.equal(held.h.count('release'), 0);
    assert.equal((await held.call('click')).isError, undefined);
    assert.deepEqual([held.io.leases, held.io.runs], [0, 1], 'the next action runs inside the same hold');
  }
});

async function stopOracle(code = null) {
  for (const error of [notSent('user_cancelled', { by: 'esc' }),
    notSent('target_unavailable', { by: 'esc', terminalInterrupted: true, terminalAbortedBy: 'esc', noRetry: true })]) {
    const { h, io, call } = planToolPath({ code });
    io.script.push(error);
    const stopped = await call('click');
    assert.equal(stopped.isError, true);
    assert.equal(h.c.PLAN.interrupted?.code, 'esc', error.code);
    assert.equal(h.c.TASK_CANCELLED, h.th.task);
    assert.match(stopped.content[0].text, /等用户明确恢复后重新 task_plan/);
    const next = await call('click');
    assert.equal(next.isError, true);
    assert.equal(io.store.code, 'user_cancelled');
    assert.deepEqual([io.leases, io.runs], [0, 0], 'a stopped plan never takes input again');
  }
}
await check('C4: Stop still stops the plan when no hold is left', () => stopOracle());

await check('C8: the sidebar-unavailable notice is shown once per session, not on every task_plan', async () => {
  const h = harness({ plan: false, task: 'Review an official page' });
  h.c.TASK_HOLD = null; h.c.VISIBLE_FEED_REASON = 'browser_only';
  const first = await h.c.taskPlanTool({ task: 'Review an official page', steps: ['Read'] });
  assert.match(first, /侧栏进度流不可用/);
  const second = await h.c.taskPlanTool({ task: 'Another page', steps: ['Read'] });
  assert.doesNotMatch(second, /侧栏进度流不可用|可见文字接口/);
  assert.match(second, /已就绪/);
  h.c.VISIBLE_FEED_REASON = 'unbound_thread';   // other feed states keep their own wording
  assert.match(await h.c.taskPlanTool({ task: 'Third page' }), /尚未绑定具体对话/);
});

await check('C8: a double-Esc stop says so with the time and how to continue; other reasons are stated as they are', async () => {
  const at = new Date(2026, 9, 28, 10, 56, 3).getTime();
  const run = (code, reason) => {
    const c = vm.createContext({ normalizeReturnFocus, BridgeError, Date, String, Number, Math, PLAN: { task: 't', stopAwake: null }, TASK_HOLD: null,
      preemptPageEvents() {}, closeTaskFeed() {}, writeTaskState() {} });
    c.Date = class extends Date { static now() { return at; } };
    vm.runInContext(productionFunction('interruptTaskPlan') + productionFunction('taskCancelledError'), c);
    c.interruptTaskPlan(code, reason);
    return c.taskCancelledError({ mode: 'current', source: 'explicit' }).message;
  };
  const esc = run('esc', '你连按两次 Esc 停止了接管');   // 10:56:03 local time
  assert.match(esc, /你连按两次 Esc 停止了接管（10:56:03）/);
  assert.match(esc, /明确说继续/); assert.match(esc, /task_plan/); assert.match(esc, /read_page/);
  const timeout = run('timeout', '接管的安全时限已到');
  assert.match(timeout, /接管的安全时限已到/); assert.doesNotMatch(timeout, /Esc|\d\d:\d\d:\d\d/);
  assert.doesNotMatch(run('tap_disabled', '系统中断了输入接管'), /Esc/);
});

await check('C8: through the tool path, abortedBy=esc replies with 两次 Esc and a time (production taskCancelledError)', async () => {
  for (const error of [notSent('user_cancelled', { by: 'esc' })]) {
    const { h, io, call } = planToolPath();
    h.c.taskCancelledError = undefined;
    vm.runInContext(productionFunction('taskCancelledError'), h.c);
    io.script.push(error);
    const stopped = await call('click');
    assert.equal(stopped.isError, true);
    assert.match(stopped.content[0].text, /两次 Esc/);
    assert.match(stopped.content[0].text, /\d\d:\d\d:\d\d/);
    const next = await call('click');
    assert.match(next.content[0].text, /两次 Esc/);
  }
});

async function unknownOracle(code = null) {
  for (const error of [failure('native_delivery_unknown', { inputDelivery: 'unknown', noRetry: true }),
    failure('submit_unconfirmed', { inputDelivery: 'sent', noRetry: true }),
    notSent('target_unavailable', { sent: ['click'] }),
    notSent('target_unavailable', { reply: { inputDelivery: 'unknown' } }),
    notSent('target_unavailable', { inputReleased: false }),
    failure('activate_unconfirmed', { inputDelivery: 'sent', noRetry: true, sent: [] })]) {
    const { h, io, call } = planToolPath({ code });
    io.script.push(error);
    assert.equal((await call('click')).isError, true);
    assert.equal(h.c.PLAN.interrupted?.code, error.code, `${error.code} ${JSON.stringify(error.reply || error.sent || error.inputReleased)}`);
    assert.equal(h.c.TASK_CANCELLED, null);
    const next = await call('click');
    assert.equal(next.isError, true);
    assert.equal(io.store.code, 'task_interrupted');
    assert.deepEqual([io.leases, io.runs], [0, 0], 'unknown or sent input is never replayed');
  }
}
await check('C4: unknown or sent delivery still stops the plan and is never replayed', () => unknownOracle());

async function lostHoldOracle(code = null) {
  const { h, io, call } = planToolPath({ held: true, code });
  io.script.push(async () => { await h.c.endTaskHold(); throw notSent(); });
  assert.equal((await call('click')).isError, true);
  assert.equal(h.c.PLAN.interrupted?.code, 'target_unavailable');
  assert.equal((await call('click')).isError, true);
  assert.equal(io.store.code, 'task_interrupted');
  assert.deepEqual([io.leases, io.runs], [0, 0], 'a hold lost during the call is never silently retaken');
}
await check('C4: a plan hold ended during the failed call is not silently retaken', () => lostHoldOracle());

await check('C4: activate_unconfirmed (activation sent, no page input) keeps a healthy plan hold', async () => {
  const { h, io, call } = planToolPath({ held: true });
  io.script.push(failure('activate_unconfirmed', { inputDelivery: 'sent', noRetry: true, keptHold: true, sent: [] }));
  assert.equal((await call('click')).isError, true);
  assert.equal(h.c.PLAN.interrupted, undefined);
  assert.equal(h.c.TASK_HOLD, h.th);
  h.state.status = { ok: true, takeover: { active: false, aborted: true, abortedBy: 'esc' } };
  io.script.push(failure('activate_unconfirmed', { inputDelivery: 'sent', noRetry: true, keptHold: true, sent: [] }));
  assert.equal((await call('click')).isError, true);
  assert.equal(h.c.PLAN.interrupted?.code, 'esc', 'Stop seen at the hold check still ends the plan');
  assert.equal(h.c.TASK_CANCELLED, h.th.task);
});

await check('C4 mutants: dropping the delivery, Stop or hold-at-start checks is caught', async () => {
  await policyMutant('delivery ignored', 'failedWithoutInput', "if (delivery.some(v => v !== 'not_sent')) return false;", '', unknownOracle);
  await policyMutant('Stop evidence ignored', 'failedWithoutInput',
    'error.by != null || error.terminalInterrupted === true || error.terminalAborted === true ||', '', stopOracle);
  await policyMutant('hold at start ignored', 'maintainTaskAfterError', 'heldAtStart === null && ', '', lostHoldOracle);
});


const focus = (mode, source = 'explicit') => ({ mode, source });
const descriptorStart = source.indexOf("  {\n    name: 'task_plan'");
const descriptorEnd = source.indexOf('\n  },\n  {', descriptorStart) + '\n  }'.length;
assert.ok(descriptorStart > 0 && descriptorEnd > descriptorStart);
const taskDescriptor = vm.runInNewContext('(' + source.slice(descriptorStart, descriptorEnd) + ')');
await check('task_plan advertises optional focus enum and explicit protocol without changing legacy required fields', () => {
  assert.deepEqual(Array.from(taskDescriptor.inputSchema.properties.return_focus.enum), ['current', 'origin']);
  assert.equal(taskDescriptor.inputSchema.required?.includes('return_focus') || false, false);
  assert.match(taskDescriptor.description, /always.*return_focus/i);
  assert.match(taskDescriptor.description, /legacy|omit/i);
});
for (const mode of ['current', 'origin']) await check(`${mode} plan omission retains policy and conflicting held changes have zero side effects`, async () => {
  const h = harness({ plan: false }); h.c.TASK_HOLD = null;
  await h.c.taskPlanTool({ task: h.th.task, return_focus: mode });
  assert.deepEqual(h.c.PLAN.returnFocus, focus(mode));
  await h.c.taskPlanTool({ task: h.th.task }); assert.deepEqual(h.c.PLAN.returnFocus, focus(mode));
  h.th.kept.returnFocus = focus(mode); h.c.TASK_HOLD = h.th;
  const p = h.c.PLAN, panel = h.c.PANEL_TASK; h.c.TASK_CANCELLED = 'cancelled-sentinel'; const count = h.calls.length;
  for (const value of [mode === 'current' ? 'origin' : 'current', 'bogus', 5, null]) {
    await assert.rejects(h.c.taskPlanTool({ task: h.th.task, return_focus: value }), e => ['return_focus_conflict', 'bad_return_focus'].includes(e.code));
    assert.equal(h.c.PLAN, p); assert.equal(h.c.PANEL_TASK, panel); assert.equal(h.c.TASK_HOLD, h.th);
    assert.equal(h.c.TASK_CANCELLED, 'cancelled-sentinel'); assert.equal(h.calls.length, count);
  }
  h.c.TASK_HOLD = null;
  await h.c.taskPlanTool({ task: h.th.task, return_focus: mode === 'current' ? 'origin' : 'current' });
  assert.equal(h.c.PLAN.returnFocus.mode, mode === 'current' ? 'origin' : 'current');
});
await check('same plan with a different old hold may change policy after releasing that old hold', async () => {
  const h = harness(); h.c.PLAN.returnFocus = focus('origin'); h.th.task = 'Previous implicit job';
  await h.c.taskPlanTool({ task: h.c.PLAN.task, return_focus: 'current' });
  assert.equal(h.count('release'), 1); assert.equal(h.c.PLAN.returnFocus.mode, 'current'); assert.equal(h.c.TASK_HOLD, null);
});
await check('real SDK tool dispatch ignores malformed done and releases by kept policy after PLAN is cleared', async () => {
  let current;
  const server = new Server({ name: 'focus-test', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [taskDescriptor] }));
  server.setRequestHandler(CallToolRequestSchema, (request) => current.c.callToolInner(request.params.name, request.params.arguments, {}, async () => ''));
  const client = new Client({ name: 'focus-test-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport); await client.listTools();
  try {
    for (const mode of ['origin', 'current', 'invalid']) for (const value of ['bogus', 5, mode === 'current' ? 'origin' : 'current']) {
      const h = current = harness(); h.c.PLAN.returnFocus = focus(mode === 'invalid' ? 'origin' : mode); h.th.kept.returnFocus = mode === 'invalid' ? undefined : focus(mode);
      h.th.kept.scene = { appPid: 9 }; h.th.kept.pointer = { x: 5, y: 6 }; h.th.kept.chromePid = 42;
      const events = [];
      h.th.kept.session.request = async req => { events.push(req.op); return req.op === 'status' ? { ok: true, takeover: { active: true } } : { ok: true, verified: true, warped: req.to }; };
      h.th.kept.session.close = async () => { events.push('close'); return { ok: true, takeover: { active: false } }; };
      h.th.lease = { release: async () => events.push('lease-release') };
      Object.assign(h.c, { releaseKept, notifyUserHeld() {}, pauseGate: async () => {}, noteOutcome() {},
        taskRestoreOps: () => ({ now: Date.now, restoreScene: async () => { assert.equal(h.c.PLAN, null); events.push('restore'); return { ok: true, appFrontmost: true }; } }) });
      vm.runInContext(['endTaskHold', 'endTaskHoldNow', 'callToolInner'].map(productionFunction).join('\n'), h.c);
      const reply = await client.callTool({ name: 'task_plan', arguments: { done: true, return_focus: value } });
      assert.equal(reply.isError, undefined); assert.equal(h.c.PLAN, null); assert.equal(h.c.TASK_HOLD, null);
      assert.equal(events.filter(x => x === 'close').length, 1); assert.equal(events.filter(x => x === 'lease-release').length, 1);
      const text = reply.content[0].text; assert.match(text, /已忽略 return_focus/); assert.match(text, /键盘鼠标接管已结束/);
      assert.equal(events.includes('restore'), mode === 'origin');
      if (mode !== 'origin') { assert.equal(events.some(x => ['restore', 'handBack', 'warp'].includes(x)), false); assert.match(text, /未请求焦点恢复/); assert.doesNotMatch(text, /光标恢复未确认|前台 App 已切回/); if (mode === 'invalid') assert.match(text, /焦点归还策略缺失或无效/); }
    }
  } finally { await client.close(); await server.close(); }
});
for (const mode of ['current', 'origin']) await check(`${mode} implicit gap offer and acquisition use the stored mode`, async () => {
  const h = harness({ plan: false }); h.th.kept.returnFocus = focus(mode); h.state.queue = [{ inherit: true }];
  h.c.startGap(h.th); await h.poll(); assert.equal(h.count('yield'), mode === 'origin' ? 1 : 0);
  h.c.TASK_HOLD = null; const leases = [], runs = []; h.c.startGap = () => {}; h.c.lockInfo = () => ({});
  h.c.acquireLease = async (_label, options) => { leases.push(options); return { release: async () => {}, ...(mode === 'origin' ? { handoff: { scene: {}, pointer: {} } } : {}), claim: async () => true }; };
  h.c.runInputAction = async options => { runs.push(options); return { outcome: 'ok', out: '', end: { ok: true } }; };
  await h.c.taskRun('fixture', { returnFocus: focus(mode) }, () => {}, h.th.task);
  assert.equal(leases[0].inherit, mode === 'origin'); assert.equal(Boolean(runs[0].inherit), mode === 'origin');
});
await check('current and invalid cancellation messages do not imply an attempted origin restoration', () => {
  const c = vm.createContext({ normalizeReturnFocus, BridgeError, PLAN: null, TASK_HOLD: null });
  vm.runInContext(productionFunction('taskCancelledError'), c);
  for (const p of [focus('current'), null]) {
    const e = c.taskCancelledError(p); assert.equal(e.code, 'user_cancelled');
    assert.doesNotMatch(e.message, /窗口和光标是否还原尚未核实|已还原|已切回/);
  }
});


for (const mode of ['origin', 'current']) await check(`${mode} direct yieldTurn and withTurn retain origin-only transfer`, async () => {
  const h = harness({ plan: false }); h.th.kept.returnFocus = focus(mode); let offers = 0;
  h.th.lease = { offer: async () => { offers++; return null; } };
  vm.runInContext(productionFunction('yieldTurn') + '\n' + productionFunction('withTurn'), h.c);
  await h.c.yieldTurn(h.th); assert.equal(offers, mode === 'origin' ? 1 : 0);
  const out = h.c.withTurn({ takeover: true, returnFocus: focus(mode) }, { offer: async () => null });
  assert.equal(typeof out.handoff, mode === 'origin' ? 'function' : 'object');
  if (mode === 'current') assert.throws(() => h.c.withTurn({ takeover: true, returnFocus: focus(mode) }, { handoff: {}, offer() {} }), e => e.code === 'focus_handoff_conflict');
});
for (const variant of ['healthy', 'caller', 'caller_cancel', 'routine', 'esc', 'shake', 'interrupted', 'session_interrupted',
  'missing_end', 'failed_end', 'active_end', 'unknown_status', 'stopped_status', 'commit_error'])
  await check(`actual yieldTurn claimed terminal boundary ${variant}`, async () => {
    const h = harness({ plan: false }), counts = { commit: 0, cancel: 0, close: 0, release: 0 };
    const failure = Object.assign(Error('owner write failed'), { code: 'EIO' });
    if (variant === 'unknown_status') h.state.status = null;
    if (variant === 'stopped_status') h.state.status = { ok: true, takeover: { active: false, aborted: true, abortedBy: 'esc' } };
    h.th.kept.session.close = async () => {
      counts.close++;
      if (variant === 'missing_end') throw Error('unconfirmed close');
      if (variant === 'session_interrupted') h.th.kept.session.interrupted = { kind: 'key', epoch: 1000 };
      // A healthy end must not erase a prior unknown/Stop status.
      return { ok: variant !== 'failed_end', ...(variant === 'interrupted' ? { interrupted: { kind: 'key', epoch: 1000 } } : {}),
        takeover: { active: variant === 'active_end', ...(['caller', 'caller_cancel', 'routine', 'esc', 'shake'].includes(variant)
          ? { aborted: true, abortedBy: variant } : {}) } };
    };
    h.th.lease = { offer: async () => ({ to: 'peer', commit: async () => { counts.commit++; if (variant === 'commit_error') throw failure; },
      cancel: async () => { counts.cancel++; return { cancelled: true }; } }), release: async () => counts.release++ };
    vm.runInContext(productionFunction('yieldTurn'), h.c);
    const error = await h.c.yieldTurn(h.th).then(() => null, error => error);
    const allowed = ['healthy', 'caller', 'caller_cancel'].includes(variant);
    assert.equal(counts.close, 1); assert.equal(counts.release, 1);
    assert.equal(counts.commit, allowed || variant === 'commit_error' ? 1 : 0);
    assert.equal(counts.cancel, allowed ? 0 : 1);
    assert.equal(h.calls.some(x => x[0] === 'debug' && x[1].label === 'task hold handed over between steps'), allowed);
    if (variant === 'commit_error') { assert.equal(error, failure); assert.equal(error.noRetry, true); }
    else assert.equal(error, null);
    if (!allowed) assert.equal(h.c.TASK_CANCELLED, h.th.task, 'only the affected giver task is latched');
  });
async function policyMutant(name, fn, from, to, oracle) {
  const actual = productionFunction(fn); assert.equal(actual.split(from).length - 1, 1, `${name} unique anchor`);
  await oracle(actual);
  await assert.rejects(oracle(actual.replace(from, to)), e => e.code === 'ERR_ASSERTION', 'valid source must fail its semantic oracle');
}
await check('valid done-validation-order mutant is caught by an unreleased held Session oracle', async () => {
  await policyMutant('done validation moved first', 'taskPlanTool', 'if (args.done === true) {',
    "if (args.return_focus === 'bogus') throw new BridgeError('bad_return_focus', 'mutant rejected before release'); if (args.done === true) {", async code => {
      const h = harness(); vm.runInContext(code, h.c);
      await h.c.taskPlanTool({ done: true, return_focus: 'bogus' }).catch(e => { assert.equal(e.code, 'bad_return_focus'); });
      assert.equal(h.count('release'), 1); assert.equal(h.c.TASK_HOLD, null);
    });
});
await check('valid unconditional-inherit mutant is caught at the actual taskRun acquisition boundary', async () => {
  await policyMutant('current inherits origin', 'taskRun', "const canInherit = returnFocus?.mode === 'origin';", 'const canInherit = true;', async code => {
    const h = harness({ plan: false }); h.c.TASK_HOLD = null; h.c.lockInfo = () => ({}); h.c.startGap = () => {};
    const inherited = []; h.c.acquireLease = async (_label, options) => { inherited.push(options.inherit); return { release: async () => {} }; };
    h.c.runInputAction = async () => ({ outcome: 'ok', out: 'done' }); vm.runInContext(code, h.c);
    await h.c.taskRun('fixture', { returnFocus: focus('current') }, () => {}, h.th.task); assert.deepEqual(inherited, [false]);
  });
});


async function terminalDoneDispatch({mode='origin',planned=true,endVariant='aborted',value='bogus',prior=null,taskPlanCode=null}={}) {
  const h=harness({plan:planned});if(h.c.PLAN)h.c.PLAN.returnFocus=focus(mode==='invalid'?'origin':mode);
  h.th.kept.returnFocus=mode==='invalid'?undefined:focus(mode);h.th.kept.scene={appPid:9};h.th.kept.pointer={x:5,y:6};h.th.kept.chromePid=42;
  if(prior)h.c.PLAN.interrupted={code:'prior',reason:prior};
  const events=[];h.th.kept.session.request=async req=>{events.push(req.op);return req.op==='status'?{ok:true,takeover:{active:true}}:{ok:true,verified:true,warped:req.to};};
  h.th.kept.session.close=async()=>{
    assert.equal(h.c.PLAN,null,'done-first clears the live plan before release');events.push('close');
    if(endVariant==='session_interrupted')h.th.kept.session.interrupted={kind:'key',epoch:1000};
    return {ok:true,takeover:{active:false,...(endVariant==='aborted'?{aborted:true,abortedBy:'esc'}:{})},
      ...(endVariant==='interrupted'?{interrupted:{kind:'key',epoch:1000}}:{})};
  };
  h.th.lease={release:async()=>events.push('lease-release')};
  Object.assign(h.c,{releaseKept,notifyUserHeld(){},pauseGate:async()=>{},noteOutcome(){},
    taskRestoreOps:()=>({now:Date.now,restoreScene:async()=>{assert.equal(h.c.PLAN,null);events.push('restore');return {ok:true,appFrontmost:true};}})});
  vm.runInContext(['endTaskHold','endTaskHoldNow','callToolInner'].map(productionFunction).join('\n')+(taskPlanCode?'\n'+taskPlanCode:''),h.c);
  const server=new Server({name:'terminal-done',version:'1'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[taskDescriptor]}));
  server.setRequestHandler(CallToolRequestSchema,request=>h.c.callToolInner(request.params.name,request.params.arguments,{},async()=>''));
  const client=new Client({name:'terminal-done-client',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);await client.listTools();
  let reply;try{reply=await client.callTool({name:'task_plan',arguments:{done:true,return_focus:value,task:37,steps:'malformed'}});}
  finally{await client.close();await server.close();}
  assert.equal(reply.isError,undefined);assert.equal(h.c.PLAN,null);assert.equal(h.c.TASK_HOLD,null);
  assert.equal(events.filter(x=>x==='close').length,1);assert.equal(events.filter(x=>x==='lease-release').length,1);
  assert.equal(events.includes('restore'),mode==='origin');
  const text=reply.content[0].text;assert.match(text,/已忽略 return_focus/);assert.match(text,/键盘鼠标接管已结束/);
  if(mode!=='origin'){assert.equal(events.some(x=>['handBack','restore','warp'].includes(x)),false);assert.match(text,/未请求焦点恢复/);}
  if(mode==='invalid')assert.match(text,/焦点归还策略缺失或无效/);
  if(endVariant!=='healthy'||prior){assert.doesNotMatch(text,/✅/);assert.match(text,/中断|未完成|停止/);}
  else if(planned)assert.match(text,/✅/);
  if(prior)assert.ok(text.includes(prior));
  if(endVariant==='aborted')assert.equal(h.c.TASK_CANCELLED,h.th.task);
  return {h,text,events};
}
for(const planned of [true,false])for(const mode of ['origin','current','invalid'])for(const endVariant of ['healthy','aborted','interrupted','session_interrupted'])
  await check(`terminal SDK done ${planned?'plan':'implicit'}/${mode}/${endVariant}`,async()=>{
    for(const value of ['bogus',17,{mode:'current'}])await terminalDoneDispatch({planned,mode,endVariant,value});
  });
await check('terminal SDK done preserves a prior unfinished reason without recreating the plan',async()=>{
  await terminalDoneDispatch({prior:'previous interruption must remain',endVariant:'aborted'});
});


await check('valid done-terminal-evidence-dropping mutant cannot report normal completion',async()=>{
  const actual=productionFunction('taskPlanTool'),anchor='end?.terminalInterrupted === true';
  assert.equal(actual.split(anchor).length-1,1);
  await terminalDoneDispatch({planned:true,mode:'origin',endVariant:'interrupted'});
  await assert.rejects(terminalDoneDispatch({planned:true,mode:'origin',endVariant:'interrupted',taskPlanCode:actual.replace(anchor,'false')}),e=>e.code==='ERR_ASSERTION');
});

console.log(`task-lifecycle: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
