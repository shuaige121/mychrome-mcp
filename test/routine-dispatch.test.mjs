// Actual MCP dispatch functions and integration, with no browser or native input.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import vm from 'node:vm';
import { createRoutineIntegration, ROUTINE_ACTIONS } from '../src/routine-integration.js';
import { RoutineError, routineMessage } from '../src/routine-runner.js';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const guardSource = await readFile(new URL('../src/guard.js', import.meta.url), 'utf8');
function productionFunction(name, code = source) {
  const start = code.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `production function ${name}`);
  return code.slice(start, code.indexOf('\n}', start) + 2);
}
const observedStart = source.indexOf('  const observedAction = async (session, prep, ctx, pre) => {', source.indexOf('async function inputActionRun('));
const observedEnd = source.indexOf('\n  const ops = {', observedStart);
assert.ok(observedStart >= 0 && observedEnd > observedStart);
const observedSource = source.slice(observedStart, observedEnd);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const page = { origin: 'https://fixture.test', path: '/form' };
  const target = { version: 1, tag: 'input', role: 'textbox', name: 'Search' };
  const routine = { id: 'synthetic', site: page.origin, parameters: [{ name: 'input_1' }],
    steps: [{ tool: 'type_text', before: page, after: page, target, args: { textParam: 'input_1' } }] };
  const state = { actions: 0, directActions: 0, records: [], finishes: [], captured: 0,
    currentPage: page, captureHook: null, holdInspect: null, inspectEntered: null };
  const integration = createRoutineIntegration({ recording: () => true, store: {
    get: async () => routine, recordRun: async () => {}, snapshot: async () => ({ enabled: true }),
    begin: async event => { state.records.push({ ...event, kind: 'begin' }); return { id: String(state.records.length) }; },
    finish: async (id, patch) => { state.finishes.push({ id, ...patch }); },
    record: async event => { state.records.push({ ...event, kind: 'barrier' }); return { id: String(state.records.length) }; },
  }, adapter: {
    capture: async (_tab, request) => {
      state.captured++; await state.captureHook?.(request);
      return { ok: true, replayable: true, page: state.currentPage, view: [], descriptor: target };
    },
    inspect: async () => { state.inspectEntered?.resolve(); if (state.holdInspect) await state.holdInspect.promise; return { page }; },
    begin: async () => state.beginCheck?.(),
    resolve: async () => ({ ok: true, marker: 1 }), act: async () => { state.actions++; return { ok: true }; },
  } });
  const CALL = new AsyncLocalStorage();
  const c = vm.createContext({ CALL, ROUTINES: integration, ROUTINE_ACTIONS,
    ROUTINE_EXCLUSIVE: new Set([...ROUTINE_ACTIONS, 'open_tab', 'close_tab', 'wait_for_user', 'task_plan', 'wake_screen']),
    ORDINARY_WRITES: new Set([...ROUTINE_ACTIONS, 'open_tab', 'close_tab', 'task_plan', 'wake_screen']),
    ORDINARY_INPUTS: 0, ORDINARY_TAIL: Promise.resolve(), PLAN: null, INFLIGHT: 0, LAST_CALL_END: 0, RECORD: false,
    presenceBusy: () => null, ledgerTail: async () => '', pauseGate: async () => {}, touchTab: async () => {},
    RoutineError, routineMessage, BridgeError: class extends Error {}, noteOutcome: () => {},
    FALLBACK_CODES: new Set(), goneTabNote: () => '', setupHint: () => '',
    readPage: async () => 'Synthetic read', click: async () => { state.directActions++; return 'Synthetic click'; },
    recoverNativeMenu: async () => 'Synthetic native menu recovered',
    B: { pageDialog: async () => ({ open: true, title: 'fixture.test', buttons: ['OK'], texts: [] }),
      chromeInfo: async () => ({ url: 'https://fixture.test/form' }),
      answerDialog: async () => { state.directActions++; return { ok: true }; } },
    Date, AbortController,
  });
  vm.runInContext(['answerDialogTool', 'pressKeyTool', 'callToolInner', 'callToolRun'].map(name => productionFunction(name)).join('\n'), c);
  const request = (name, args, signal) => CALL.run({}, () => c.callToolRun({ params: { name, arguments: args } }, { signal }));
  const runArgs = (action, nonce) => ({ action, id: 'synthetic', tab: 7, params: { input_1: 'Synthetic text' }, nonce });
  return { state, integration, c, CALL, request, runArgs };
}

// Execute the production native-observer wrapper and the real guard lifecycle;
// every session/OS operation is a pure fixture, and the caller owns its lease.
async function nativeFixture(f, action, { handoff = false } = {}) {
  Object.assign(f.c, { action, TASK_HOLD: null, conversationInputCheck() {},
    UserInterrupted: class extends Error {}, sessionError: value => Object.assign(Error('Synthetic session error'), value) });
  f.c.B.openNavigationObserver = async () => null;
  const observed = vm.runInContext(`(() => { let navigationObserver, routineAbortCleanup,
    inputCount=0, actionSession, navigationAnchor; const takeover=false, actionPlan=null;
    ${observedSource}; return observedAction; })()`, f.c);
  vm.runInContext(productionFunction('runInputAction', guardSource), f.c);
  const session = { interrupted: null, request: async () => ({ ok: true, inputMonitor: true,
    takeover: { active: true } }), close: async () => ({ ok: true }) };
  return f.c.runInputAction({ now: () => 1000, waitForUserIdle: async () => 0, snapshotScene: async () => null,
    mousepos: async () => null, prepare: async () => ({ chromePid: 42, cgWindow: 7, target: { tabId: 7 } }),
    userActedSince: async () => false, openSession: async () => session, navigationUntouched: async () => true,
    restoreScene: async () => ({}), warp: async () => {},
    ...(handoff ? { takeover: true, handoff: async () => ({ to: 'synthetic-worker', commit: async () => {} }) } : {}),
  }, observed);
}

test('MCP run cancellation reaches the background runner before any action is dispatched', async () => {
  const f = fixture(), caller = new AbortController();
  f.state.holdInspect = deferred(); f.state.inspectEntered = deferred();
  const pending = f.request('routines', f.runArgs('run', 'caller-cancel'), caller.signal);
  await f.state.inspectEntered.promise; caller.abort(); f.state.holdInspect.resolve();
  const result = await pending;
  assert.equal(result.structuredContent.result.status, 'cancelled'); assert.equal(f.state.actions, 0);
});

test('already cancelled MCP run refuses before looking up or executing the routine', async () => {
  const f = fixture(), caller = new AbortController(); caller.abort();
  const result = await f.request('routines', f.runArgs('run', 'already-cancelled'), caller.signal);
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'cancelled');
  assert.equal(f.integration.runner.busy(), null); assert.equal(f.state.actions, 0);
});

test('cancelling a conflicting nonce request cannot cancel the original accepted run', async () => {
  const f = fixture(); f.state.holdInspect = deferred();
  await f.request('routines', f.runArgs('start', 'exact-intent'));
  const caller = new AbortController(), query = f.integration.query;
  // Model a cancellation notification during the async query acknowledgement.
  // It must bind to this request's validated intent, not an existing nonce alone.
  f.integration.query = payload => { const result = query(payload); queueMicrotask(() => caller.abort()); return result; };
  const conflict = await f.request('routines', { ...f.runArgs('run', 'exact-intent'), params: { input_1: 'Different request' } }, caller.signal);
  assert.equal(conflict.structuredContent.error.code, 'nonce_conflict');
  f.integration.query = query; f.state.holdInspect.resolve();
  const original = await query(f.runArgs('run', 'exact-intent'));
  assert.equal(original.status, 'completed'); assert.equal(f.state.actions, 1);
});

test('MCP start releases its caller binding after delivery; later cancellation uses explicit stop', async () => {
  const f = fixture(), caller = new AbortController(); f.state.holdInspect = deferred();
  const started = await f.request('routines', f.runArgs('start', 'background'), caller.signal);
  assert.equal(started.structuredContent.result.status, 'running'); caller.abort();
  const status = await f.request('routines', { action: 'status', nonce: 'background' });
  assert.equal(status.structuredContent.result.status, 'running');
  const stopped = await f.request('routines', { action: 'stop', nonce: 'background' });
  assert.equal(stopped.structuredContent.result.runId, started.structuredContent.result.runId);
  f.state.holdInspect.resolve();
  const terminal = await f.integration.query(f.runArgs('run', 'background'));
  assert.equal(terminal.status, 'cancelled'); assert.equal(f.state.actions, 0);
});

test('active routine blocks ordinary input, while MCP reads/status/stop remain available', async () => {
  const f = fixture(); f.state.holdInspect = deferred();
  await f.request('routines', f.runArgs('start', 'busy'));
  assert.equal((await f.request('click', { tab: 7, marker: 1 })).isError, true);
  assert.equal(f.state.directActions, 0);
  assert.notEqual((await f.request('read_page', { tab: 7 })).isError, true);
  assert.equal((await f.request('routines', { action: 'status', nonce: 'busy' })).structuredContent.result.status, 'running');
  await f.request('routines', { action: 'stop', nonce: 'busy' }); f.state.holdInspect.resolve();
  assert.equal((await f.integration.query(f.runArgs('run', 'busy'))).status, 'cancelled');
});

for (const [name, args] of [['answer_dialog', { tab: 7, button: 'OK' }], ['press_key', { tab: 7, key: 'escape' }]]) {
  test(`successful ${name} native bypass creates a recording barrier without a page probe`, async () => {
    const f = fixture();
    const context = { routineAttempt: { tool: 'type_text', args: { tab: 7, marker: 1 } } };
    await f.integration.beforeInput(context, 7); await f.integration.afterInput(context, {});
    const before = f.state.captured;
    const result = await f.request(name, args);
    assert.notEqual(result.isError, true); assert.equal(f.state.captured, before);
    assert.equal(f.state.records.at(-1).kind, 'barrier'); assert.equal(f.state.records.at(-1).tab, 7);
  });
}

test('unknown-tab boundary fences every known stream without inventing a tab identity', async () => {
  const f = fixture();
  for (const tab of [7, 8]) {
    const context = { routineAttempt: { tool: 'type_text', args: { tab, marker: 1 } } };
    await f.integration.beforeInput(context, tab); await f.integration.afterInput(context, {});
  }
  await f.integration.barrier(undefined, 'task_plan');
  assert.deepEqual(f.state.records.filter(event => event.kind === 'barrier').map(event => event.tab), [7, 8]);
  assert.equal(f.integration.recordingError(), false);
});

test('overlapping ordinary calls cannot promote another action\'s postcondition', async () => {
  const f = fixture(), captureEntered = deferred(), captureRelease = deferred();
  let gated = false;
  f.state.captureHook = async request => {
    if (request.mode === 'state' && f.state.currentPage.path === '/first' && !gated) {
      gated = true; captureEntered.resolve(); await captureRelease.promise;
    }
  };
  f.c.click = args => nativeFixture(f, async () => {
    const context = f.CALL.getStore();
    f.state.currentPage = { origin: 'https://fixture.test', path: args.marker === 1 ? '/first' : '/second' };
    context.routineEvidence = { ok: true, confirmed: true };
    return 'Synthetic native action completed';
  }).then(result => result.out);
  const first = f.request('click', { tab: 7, marker: 1 });
  await captureEntered.promise;
  // The first native action has finished, but its asynchronous postcondition
  // probe is pending. A second MCP request must not change what it records.
  const second = f.request('click', { tab: 7, marker: 2 });
  await new Promise(resolve => setImmediate(resolve));
  captureRelease.resolve();
  await Promise.all([first, second]);
  const recordedFirst = f.state.finishes.find(event => event.id === '1');
  assert.ok(recordedFirst);
  assert.ok(recordedFirst.replayable === false || recordedFirst.after.path === '/first',
    `first action incorrectly promoted after=${recordedFirst.after.path}, replayable=${recordedFirst.replayable}`);
});

test('the actual native action hook awaits recording before posting any input', async () => {
  const recording = deferred(), entered = deferred(), events = [];
  const context = { routineGuard: async () => events.push('guard'), routineCheck: () => events.push('check') };
  const c = vm.createContext({ CALL: { getStore: () => context }, TASK_HOLD: null,
    conversationInputCheck: () => {},
    ROUTINES: { beforeInput: async () => { events.push('record_begin'); entered.resolve(); await recording.promise; events.push('record_saved'); } },
    B: { openNavigationObserver: async () => null }, action: async () => { events.push('native_input'); },
  });
  vm.runInContext(`let navigationObserver, routineAbortCleanup, inputCount=0, actionSession, navigationAnchor;
    const takeover=false, actionPlan=null;${observedSource};this.runObserved=observedAction;`, c);
  const running = c.runObserved({}, { target: { tabId: 7 } }, { sent() {}, unsent() {}, observe() {} });
  await entered.promise; assert.deepEqual(events, ['guard', 'record_begin']);
  recording.resolve(); await running;
  assert.deepEqual(events, ['guard', 'record_begin', 'record_saved', 'check', 'native_input']);
});

for (const nativeObserver of [false, true]) test(`postcondition finishes inside the lease with native observer=${nativeObserver}`, async () => {
  const f = fixture(), context = { routineAttempt: { tool: 'click', args: { tab: 7, marker: 1 } } };
  let leaseHeld = true, originalObserved = !nativeObserver;
  f.state.captureHook = async request => {
    assert.equal(leaseHeld, true, 'postcondition must precede lease release');
    if (request.mode === 'state') assert.equal(originalObserved, true, 'native confirmation must precede recording');
  };
  const result = await f.CALL.run(context, () => nativeFixture(f, async (_session, _prep, ctx) => {
    f.state.currentPage = { origin: 'https://fixture.test', path: '/first' };
    if (nativeObserver) ctx.observe(async () => {
      originalObserved = true; context.routineEvidence = { confirmed: true };
      return { out: 'Original native report' };
    });
    else context.routineEvidence = { confirmed: true };
    return 'Original action result';
  }));
  leaseHeld = false;
  f.state.currentPage = { origin: 'https://fixture.test', path: '/another-worker' };
  const captures = f.state.captured;
  await f.integration.afterInput(context, {});
  assert.equal(f.state.captured, captures); assert.equal(f.state.finishes.length, 1);
  assert.equal(f.state.finishes[0].after.path, '/first'); assert.equal(f.state.finishes[0].replayable, true);
  assert.equal(result.out, nativeObserver ? 'Original native report' : 'Original action result');
});

test('the actual guard handoff observer creates a barrier without probing the next worker page', async () => {
  const f = fixture(), context = { routineAttempt: { tool: 'type_text', args: { tab: 7, marker: 1 } } };
  const result = await f.CALL.run(context, () => nativeFixture(f, async () => 'Synthetic action', { handoff: true }));
  assert.equal(result.handedOver, 'synthetic-worker'); assert.equal(f.state.captured, 1);
  assert.equal(f.state.finishes.length, 1); assert.equal(f.state.finishes[0].replayable, false);
  await f.integration.afterInput(context, {}); assert.equal(f.state.finishes.length, 1);
});

test('overlapping user waits release the short-write queue but retain runner exclusion and both boundaries', async () => {
  const f = fixture(), olderGate = deferred(), newerGate = deferred(), olderEntered = deferred();
  const known = { routineAttempt: { tool: 'type_text', args: { tab: 7, marker: 1 } } };
  await f.integration.beforeInput(known, 7); await f.integration.afterInput(known, {});
  let newerEntered = false;
  f.c.waitForUserTool = async (args, call) => {
    call.waitReady?.();
    if (args.reason === 'older') { olderEntered.resolve(); await olderGate.promise; }
    else { newerEntered = true; await newerGate.promise; }
    return 'Synthetic wait finished';
  };
  const beginStart = source.indexOf('  async begin(run, routine) {');
  const beginEnd = source.indexOf('\n  },', beginStart);
  assert.ok(beginStart >= 0 && beginEnd > beginStart);
  f.state.beginCheck = vm.runInContext(`(async function(run, routine) {${source.slice(beginStart + '  async begin(run, routine) {'.length, beginEnd)}\n})`, f.c);
  const older = f.request('wait_for_user', { tab: 7, reason: 'older' });
  await olderEntered.promise;
  const newer = f.request('wait_for_user', { tab: 7, reason: 'newer' });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(newerEntered, true, 'the second wait must not wait for the first user response');
    assert.equal(f.c.ORDINARY_INPUTS, 2);
    const run = await f.request('routines', f.runArgs('run', 'during-waits'));
    assert.equal(run.structuredContent.result.code, 'routine_busy'); assert.equal(f.state.actions, 0);
    assert.equal(f.state.records.filter(record => record.kind === 'barrier' && record.tool === 'wait_for_user').length, 2);
  } finally { olderGate.resolve(); newerGate.resolve(); await Promise.all([older, newer]); }
  assert.equal(f.c.ORDINARY_INPUTS, 0);
  assert.equal(f.state.records.filter(record => record.kind === 'barrier' && record.tool === 'wait_for_user').length, 4);
});

test('a new wait setup stays behind an active physical input instead of ending its hold', async () => {
  const f = fixture(), inputEntered = deferred(), inputRelease = deferred();
  let waitSetup = false;
  f.c.click = async () => { inputEntered.resolve(); await inputRelease.promise; return 'Synthetic click'; };
  f.c.waitForUserTool = async (_args, call) => { waitSetup = true; call.waitReady?.(); return 'Synthetic wait'; };
  const input = f.request('click', { tab: 7, marker: 1 }); await inputEntered.promise;
  const waiting = f.request('wait_for_user', { tab: 7, reason: 'human step' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waitSetup, false);
  inputRelease.resolve(); await Promise.all([input, waiting]);
  assert.equal(waitSetup, true); assert.equal(f.c.ORDINARY_INPUTS, 0);
});
