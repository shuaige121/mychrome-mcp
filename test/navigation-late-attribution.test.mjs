// A click's async handler navigates after its initial URL observation ended.
// Exercise the real report, attribution, and takeover functions with a virtual
// clock. No Chrome, network, runtime registry, or physical input is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { runInputAction } from '../src/guard.js';
import { BridgeError } from '../src/bridge.js';

const [indexSource, guardSource, tabsSource] = await Promise.all([
  fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/guard.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/tabs.js', import.meta.url), 'utf8'),
]);
function functionSource(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const observeStart = guardSource.indexOf('  const observe = async (noteable, since) => {');
assert.ok(observeStart >= 0);
const observeSource = guardSource.slice(observeStart,
  guardSource.indexOf('\n  };', observeStart) + '\n  };'.length);

const initial = 'https://fixture.test/exam';
const final = 'https://fixture.test/result';

async function scenario({ commitAt = 1800, untouched = true, readAt = 3000,
  explicit = true, inputCount = 1, productionAction = false,
  diagnostics = false, beforeAction = () => {}, mutate = () => {} } = {}) {
  let now = 0;
  let record = { tabId: 1, windowId: 10, expectedUrl: initial, takenOver: false };
  let report = null;
  let ownershipProofCalls = 0;
  const notes = [];
  const debug = [];
  const state = {
    paused: false, statusCalls: 0,
    status: { ok: true, interrupted: null, takeover: {
      active: true, aborted: false, releasedBy: null, abortedBy: null,
      swallowedKeys: 0, swallowedPointer: 0,
    } },
    // Body focus has no field hitWindow. It still has an exact focusedWindow.
    focus: { ok: true, frontmost: true, pid: 42, expectedWindow: 70,
      focusedWindow: 70, hitWindow: null, windowMatches: false },
    extraLive: {},
  };
  const live = () => ({ tabId: 1, windowId: 10, chromePid: 42, cgWindow: 70,
    url: now >= commitAt ? final : initial, loading: false, tabActive: true, ...state.extraLive });
  const plan = explicit ? { task: 'Complete reading paper' } : null;
  const session = { interrupted: null, request: async req => {
    if (req.op === 'veil') return { ok: true, held: true };
    if (req.op === 'click') return { ok: true };
    assert.equal(req.op, 'status');
    state.statusCalls++;
    if (state.statusError) throw Error('helper unavailable');
    if (state.onStatus) state.onStatus(state.statusCalls);
    return state.status;
  } };
  const hold = { task: 'Complete reading paper', kept: { session, chromePid: 42, cgWindow: 70 } };
  const prep = { target: live(), chromePid: 42, cgWindow: 70, ownNote: '' };
  const st = { tab: 1, marker: 2, prep, hrefBefore: initial, listBefore: null,
    loc: { hadFocus: false }, origin: { scale: 1 }, what: '[2] Submit',
    ack: { seen: true, ms: 0 } };
  const context = vm.createContext({
    CALL: { getStore: () => null }, ROUTINES: { beforeInput: async () => {} },
    Date: { now: () => now }, Math, BridgeError,
    process: { env: diagnostics ? { CHROME_BRIDGE_DEBUG_LOG: 'isolated-test-only' } : {} },
    debugLog: value => { debug.push(value); },
    sleep: async ms => { now += ms; },
    S: { get: key => key === 'paused' && state.paused },
    B: { chromeInfo: async () => live(), pageDialog: async () => null,
      axInput: async () => state.focus,
      openNavigationObserver: async () => ({ startedAt: now,
        untouched: async () => untouched, close: async () => {} }) },
    readAfter: async () => ({ href: live().url, activeIsTarget: true,
      activeElement: { tag: 'button', text: 'Submit' } }),
    targetLine: () => '', clickLines: () => [],
    didClickRegister: () => ({ observed: true, reasons: ['focus'] }),
    ledgerNavigated() {},
    TASK_HOLD: hold, PLAN: plan, TASK_CANCELLED: null, YIELDING: null, HOLD_ENDING: 0,
    GUI_SERVICE: null,
    NATIVE_TARGETS: new Map(),
    getTab: async () => {
      if (state.getError) throw Error('registry unavailable');
      if (state.onGetTab) state.onGetTab();
      return record;
    },
    isMine: () => state.mine !== false,
    noteAgentNavigation: async (_tab, url) => {
      notes.push(url);
      record = { ...record, expectedUrl: url };
    },
    // checkTakeover normalizes URLs via sameUrl. These URLs are canonical and
    // deliberately differ by path; normalization is not under test here.
    sameUrl: (a, b) => a === b,
    err: null, out: '', prep,
    observer: async obs => {
      report = await context.clickReport(st, obs);
      return report;
    },
    ops: {
      navigationUntouched: async () => { ownershipProofCalls++; return untouched; },
      noteNavigation: async (_prep, url) => {
        notes.push(url);
        record = { ...record, expectedUrl: url };
      },
    },
  });
  vm.runInContext([
    functionSource(indexSource, 'settledUrl'),
    functionSource(indexSource, 'waitForNavigation'),
    functionSource(indexSource, 'clickReport'),
    functionSource(indexSource, 'heldNavigationDebug'),
    functionSource(indexSource, 'heldNavigationStatusFacts'),
    functionSource(indexSource, 'heldNavigationAnchor'),
    functionSource(indexSource, 'rememberHeldNavigation'),
    functionSource(indexSource, 'reconcileHeldNavigation'),
    functionSource(indexSource, 'conversationInputCheck'),
    functionSource(indexSource, 'post'),
    functionSource(indexSource, 'postedNothing'),
    functionSource(indexSource, 'taskRun'),
    functionSource(indexSource, 'inputActionRun'),
    functionSource(tabsSource, 'checkTakeover'),
    observeSource + '\nglobalThis.observe = observe;',
  ].join('\n'), context);

  const controls = { context, state, hold, plan, session, prep,
    getRecord: () => record, setRecord: value => { record = value; } };
  beforeAction(controls);
  if (productionAction) {
    // Use the real action/guard/hold chain, including clickDeliver's deferAck
    // sentinel: guard must NOT read or note a URL before clickReport. The
    // pending anchor must come from the verified pre-input registry instead.
    Object.assign(context, {
      runInputAction, TAKEOVER: true, TAKEOVER_LIMITS: {}, TASK_GAP_MS: 30000,
      TASK_LIMITS: { takeoverMaxMs: 1800000, takeoverIdleMs: 60000 },
      clearTimeout() {}, clearInterval() {}, startGap() {}, writeTaskState() {},
      userActedSince: async () => false, userClickedSince: async () => false,
      openOwnSession: async () => { throw Error('existing hold must be reused'); },
      queueNote: () => '', timingLine: () => '', TASK_NOTE: () => '',
    });
    await context.inputActionRun('click', async () => prep, async (s, _prep, ctx) => {
      if (inputCount > 0) await context.post(s, ctx, 'click', { op: 'click' });
      prep.lastUrl = null; // Exact clickDeliver(..., { deferAck: true }) behavior.
      ctx.observe(async obs => {
        report = await context.clickReport(st, obs);
        return report;
      });
      return 'clicked';
    }, { doneNote: '', activates: true, idle: {}, task: hold.task });
  } else {
    await context.observe(true, 0);
    context.rememberHeldNavigation({ outcome: 'ok', kept: hold.kept, prep },
      { inputCount, session, plan, expectedUrl: record.expectedUrl });
  }
  const reportAt = now;
  const pendingBeforeRead = !!hold.pendingNavigation;
  mutate(controls);
  now = Math.max(now, readAt);
  await context.reconcileHeldNavigation(live());
  const checked = context.checkTakeover(record, live());
  return {
    commitAt, reportAt, reportedUrl: report.url, expectedUrl: record.expectedUrl,
    readUrl: live().url, notes, ownershipProofCalls,
    takenOver: checked.rec.takenOver, why: checked.why,
    secondCheck: context.checkTakeover(checked.rec, live()), state, pending: !!hold.pendingNavigation,
    pendingBeforeRead, debug: debug.filter(event => event.label === 'held_navigation'),
  };
}

const fast = await scenario({ commitAt: 900 });
assert.equal(fast.expectedUrl, final, 'normal navigation is attributed to the click');
assert.equal(fast.takenOver, false);

const user = await scenario({ commitAt: 900, untouched: false,
  mutate: ({ state }) => { state.status.takeover.swallowedKeys = 1; } });
assert.equal(user.expectedUrl, initial, 'user/unknown navigation must not be adopted');
assert.equal(user.takenOver, true);
assert.equal(user.why, 'url_changed');

const late = await scenario();
assert.equal(late.reportAt, 1500, 'ordinary click wait is not increased');
assert.equal(late.reportedUrl, null, 'the delayed response still outlives the click report');
assert.equal(late.ownershipProofCalls, 0, 'guard cannot attribute a URL it has not observed');
assert.equal(late.expectedUrl, final);
assert.equal(late.takenOver, false, 'the same verified hold attributes the delayed response');
assert.equal(late.state.statusCalls, 2, 'native hold is checked around fresh target/focus reads');
assert.equal(late.pending, false, 'attribution is consumed once');

const production = await scenario({ productionAction: true });
assert.equal(production.reportAt, 1500);
assert.equal(production.reportedUrl, null);
assert.equal(production.pendingBeforeRead, true, 'deferAck must retain the verified pre-input registry anchor');
assert.equal(production.expectedUrl, final);
assert.equal(production.takenOver, false);
assert.deepEqual(production.notes, [final], 'deferAck never notes the old URL; held read records the result');
const noInput = await scenario({ productionAction: true, inputCount: 0 });
assert.equal(noInput.pendingBeforeRead, false, 'a successful action posting nothing cannot establish pending attribution');
assert.equal(noInput.takenOver, true);

const diagnosed = await scenario({ productionAction: true, diagnostics: true,
  mutate: ({ state }) => { state.focus.focusedWindow = null; } });
assert.ok(diagnosed.debug.some(event => event.stage === 'remember_stored'));
assert.ok(diagnosed.debug.some(event => event.stage === 'focus_rejected' && event.focusedWindowPresent === false));
assert.doesNotMatch(JSON.stringify(diagnosed.debug), /fixture\.test|https?:|Submit|Complete reading paper/);
assert.deepEqual(production.debug, [], 'diagnostics are off without the explicit environment setting');

const anchorNegatives = [
  ['another owner', ({ state }) => { state.mine = false; }],
  ['preexisting sticky flag', ({ getRecord, setRecord }) => {
    setRecord({ ...getRecord(), takenOver: true, takenOverWhy: 'user_interrupted' });
  }],
  ['registry URL mismatch', ({ getRecord, setRecord }) => {
    setRecord({ ...getRecord(), expectedUrl: 'https://fixture.test/elsewhere' });
  }],
  ['registry window mismatch', ({ getRecord, setRecord }) => {
    setRecord({ ...getRecord(), windowId: 11 });
  }],
  ['unknown registry', ({ state }) => { state.getError = true; }],
  ['missing prepared URL', ({ prep }) => { prep.target.url = null; }],
  ['plan replaced during registry read', ({ context, state, plan }) => {
    state.onGetTab = () => { context.PLAN = { ...plan }; };
  }],
];
for (const [name, beforeAction] of anchorNegatives) {
  const result = await scenario({ productionAction: true, beforeAction });
  assert.equal(result.pendingBeforeRead, false, `${name}: pre-input evidence cannot establish an anchor`);
  assert.notEqual(result.expectedUrl, final, `${name}: no arbitrary URL fallback`);
  assert.equal(result.takenOver, true, `${name}: normal ownership protection remains`);
}

const negatives = [
  ['implicit task', { explicit: false }],
  ['no actual input', { inputCount: 0 }],
  ['ended hold', { mutate: ({ context }) => { context.TASK_HOLD = null; } }],
  ['replacement hold', { mutate: ({ context, hold }) => { context.TASK_HOLD = { ...hold }; } }],
  ['replacement session', { mutate: ({ hold }) => { hold.kept = { ...hold.kept, session: {} }; } }],
  ['replacement plan', { mutate: ({ context, plan }) => { context.PLAN = { ...plan }; } }],
  ['interrupted plan', { mutate: ({ plan }) => { plan.interrupted = { code: 'stopped' }; } }],
  ['cancelled task', { mutate: ({ context, plan }) => { context.TASK_CANCELLED = plan.task; } }],
  ['Stop/paused', { mutate: ({ state }) => { state.paused = true; } }],
  ['hold ending', { mutate: ({ context }) => { context.HOLD_ENDING = 1; } }],
  ['handover', { mutate: ({ context }) => { context.YIELDING = {}; } }],
  ['native unknown', { mutate: ({ state }) => { state.status = {}; } }],
  ['native error', { mutate: ({ state }) => { state.statusError = true; } }],
  ['native not OK', { mutate: ({ state }) => { state.status.ok = false; } }],
  ['released takeover', { mutate: ({ state }) => { state.status.takeover.active = false; } }],
  ['aborted takeover', { mutate: ({ state }) => { state.status.takeover.aborted = true; } }],
  ['native release reason', { mutate: ({ state }) => { state.status.takeover.releasedBy = 'esc'; } }],
  ['native abort reason', { mutate: ({ state }) => { state.status.takeover.abortedBy = 'shake'; } }],
  ['tap failure', { mutate: ({ state }) => { state.status.takeover.tapDiagnostic = 'disabled'; } }],
  ['native interruption', { mutate: ({ state }) => { state.status.interrupted = { kind: 'key' }; } }],
  ['session interruption', { mutate: ({ session }) => { session.interrupted = { kind: 'key' }; } }],
  ['user keyboard activity', { mutate: ({ state }) => { state.status.takeover.swallowedKeys = 1; } }],
  ['user pointer activity', { mutate: ({ state }) => { state.status.takeover.swallowedPointer = 1; } }],
  ['unknown activity counters', { mutate: ({ state }) => { delete state.status.takeover.swallowedKeys; } }],
  ['different Chrome PID', { mutate: ({ state }) => { state.extraLive.chromePid = 43; } }],
  ['different CG window', { mutate: ({ state }) => { state.extraLive.cgWindow = 71; } }],
  ['different browser window', { mutate: ({ state }) => { state.extraLive.windowId = 11; } }],
  ['inactive tab', { mutate: ({ state }) => { state.extraLive.tabActive = false; } }],
  ['unknown native focus', { mutate: ({ state }) => { state.focus = {}; } }],
  ['another front app', { mutate: ({ state }) => { state.focus.frontmost = false; } }],
  ['another focused window', { mutate: ({ state }) => { state.focus.focusedWindow = 71; } }],
  ['missing focused window', { mutate: ({ state }) => { state.focus.focusedWindow = null; } }],
  ['mismatched AX PID', { mutate: ({ state }) => { state.focus.pid = 43; } }],
  ['mismatched AX expected window', { mutate: ({ state }) => { state.focus.expectedWindow = 71; } }],
  ['Stop during verification', { mutate: ({ state }) => {
    state.onStatus = n => { if (n === 2) state.paused = true; };
  } }],
  ['release during verification', { mutate: ({ state }) => {
    state.onStatus = n => { if (n === 2) state.status.takeover.active = false; };
  } }],
  ['existing sticky flag', { mutate: ({ getRecord, setRecord }) => {
    setRecord({ ...getRecord(), takenOver: true, takenOverWhy: 'user_interrupted' });
  } }],
];
for (const [name, options] of negatives) {
  const result = await scenario(options);
  assert.equal(result.expectedUrl, initial, `${name}: must not adopt the delayed URL`);
  assert.equal(result.takenOver, true, `${name}: normal protection remains`);
  assert.equal(result.secondCheck.rec.takenOver, true, `${name}: never clears a sticky flag`);
}
console.log(`navigation-late-attribution: 6 positive/control cases and ${negatives.length + anchorNegatives.length} protection cases passed`);
