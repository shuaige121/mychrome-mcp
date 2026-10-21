import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openNavigationObserver } from '../src/bridge.js';

// Run the actual production functions with a virtual clock. No Chrome or input.
const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness(snapshot) {
  let now = 0;
  const context = vm.createContext({
    Date: { now: () => now }, Math, process: { env: {} },
    sleep: async ms => { now += ms; },
    S: { get: () => false },
    B: { chromeInfo: async () => snapshot(now) },
  });
  vm.runInContext(functionSource('settledUrl') + '\n' + functionSource('timingLine'), context);
  return { context, elapsed: () => now };
}
const initial = 'https://example.test/login';
const callback = 'https://example.test/callback';
const final = 'https://example.test/dashboard';
{
  const h = harness(t => t < 2400 ? { url: initial, loading: true } : { url: final, loading: false });
  assert.equal(await h.context.settledUrl(1, initial), final);
  assert.ok(h.elapsed() >= 3600, 'does not settle while the request is loading');
}
{
  const h = harness(t => ({ url: t < 1200 ? callback : final, loading: false }));
  assert.equal(await h.context.settledUrl(1, callback), final, 'waits through a delayed callback redirect');
}
{
  const h = harness(() => ({ url: initial, loading: true }));
  assert.equal(await h.context.settledUrl(1, initial, 3000), initial);
  assert.equal(h.elapsed(), 3000, 'a never-ending load has a bounded wait');
}
{
  const h = harness(() => ({ url: final, loading: false }));
  const signal = { aborted: true };
  assert.equal(await h.context.settledUrl(1, initial, 6000, signal), initial);
  assert.equal(h.elapsed(), 0, 'cancellation stops before reading');
}
{
  const h = harness(() => ({}));
  assert.doesNotMatch(h.context.timingLine({ activated: 100, observeEnd: 300 }), /null|undefined|NaN/);
  const held = h.context.timingLine({ activated: 100, statusDone: 200, observeEnd: 500 });
  assert.match(held, /接管中观察 300 ms/);
  assert.doesNotMatch(held, /切回后观察/);
  assert.match(h.context.timingLine({ activated: 100, handBack: 300, observeEnd: 500 }), /切回后观察 200 ms/);
}

// Ownership is independent of URL stability: an event-routed observer begins BEFORE navigation,
// survives fast foreground switches, and does not confuse typing in another app with taking a tab.
async function registration({ untouched = true, observerFails = false, openFails = false, moved = false } = {}) {
  let at = 0, registered, taken = false;
  const steps = [];
  const target = { tabId: 1, windowId: moved ? 99 : 10, chromePid: 42, cgWindow: 70, url: final };
  const observer = { startedAt: 0, untouched: async () => untouched,
    close: async () => { steps.push('close'); } };
  const context = vm.createContext({
    Date: { now: () => at }, sleep: async ms => { at += ms; }, S: { get: () => false },
    B: {
      openNavigationObserver: async () => { steps.push('arm'); if (observerFails) throw Error('unavailable'); return observer; },
      chromeInfo: async () => ({ ...target, url: at < 1500 ? initial : final, loading: at < 1500 }),
    },
    registerTab: async (id, url) => { registered = { id, url }; },
    markTakenOver: async () => { taken = true; }, LEDGER: { apply() {} }, agentName: () => 'test',
  });
  vm.runInContext(['settledUrl', 'registerSettled', 'openAndRegister'].map(functionSource).join('\n'), context);
  const open = async () => { steps.push('open'); if (openFails) throw Error('open failed'); return { tabId: 1, windowId: 10 }; };
  if (openFails) {
    await assert.rejects(context.openAndRegister(open, initial), /open failed/);
  } else {
    await context.openAndRegister(open, initial);
  }
  return { registered, taken, steps };
}
{
  const r = await registration();
  assert.equal(r.registered.url, final, 'slow redirects remain agent-owned with complete evidence');
  assert.equal(r.taken, false);
  assert.deepEqual(r.steps, ['arm', 'open', 'close']);
}
{
  for (const options of [{ untouched: false }, { observerFails: true }, { moved: true }]) {
    const r = await registration(options);
    assert.equal(r.registered.url, initial, 'user/unknown navigation must not become expectedUrl');
    assert.equal(r.taken, true, 'an unverified tab is protected from automatic close');
  }
  assert.deepEqual((await registration({ openFails: true })).steps, ['arm', 'open', 'close']);
}
{
  const calls = [], session = {
    request: async req => { calls.push(req); return req.op === 'watchNavigation'
      ? { readOnly: true, startedAt: 100 } : { known: true, untouched: true }; },
    close: async () => { calls.push('close'); },
  };
  const observer = await openNavigationObserver({ openSession: () => session });
  assert.equal(await observer.untouched({ chromePid: 42, cgWindow: 70 }, 150), true);
  assert.deepEqual(calls[1], { op: 'navigationState', chromePid: 42, window: 70, since: 150 });
  assert.equal(await observer.untouched({ chromePid: 42 }, 150), false);
  assert.equal(await observer.untouched({ chromePid: 42, cgWindow: 70 }, 99), false);
  session.request = async () => { throw Error('observer exited'); };
  assert.equal(await observer.untouched({ chromePid: 42, cgWindow: 70 }), false);
  await observer.close();
  assert.equal(calls.at(-1), 'close');
  const unavailable = { request: async () => ({}), close: async () => { calls.push('failed-close'); } };
  await assert.rejects(openNavigationObserver({ openSession: () => unavailable }));
  assert.equal(calls.at(-1), 'failed-close');
}
{
  const guard = await fs.readFile(new URL('../src/guard.js', import.meta.url), 'utf8');
  const start = guard.indexOf('  const observe = async (noteable, since) => {');
  assert.ok(start > 0);
  const observe = guard.slice(start, guard.indexOf('\n  };', start) + '\n  };'.length);
  for (const evidence of [true, false, 'unavailable', 'missing']) {
    const notes = [];
    const context = vm.createContext({
      err: null, out: '', prep: { target: { tabId: 1 } },
      observer: async () => ({ out: 'loaded', url: final }),
      ops: { navigationUntouched: async () => { if (evidence === 'unavailable') throw Error('gone'); return evidence; },
        noteNavigation: async (_prep, url) => { notes.push(url); } },
    });
    if (evidence === 'missing') {
      delete context.ops.navigationUntouched;
      context.ops.userClickedSince = async () => false; // Mouse-only evidence cannot prove ownership.
    }
    vm.runInContext(observe + '\nglobalThis.observe = observe;', context);
    await context.observe(true, 100);
    assert.equal(notes.length, evidence === true ? 1 : 0);
    if (evidence !== true) assert.match(context.out, /没有记为 agent 的导航/);
  }
}
{
  // Done must describe native restore facts, including menu/time-out failures and an already-ended hold.
  for (const end of [null, { inputReleased: true, appRestored: true, pointerRestored: true },
    { inputReleased: true, appRestored: false, pointerRestored: false },
    { inputReleased: false, appRestored: false, pointerRestored: false }]) {
    const context = vm.createContext({
      PLAN: { task: 'Synthetic job', t0: 1000 }, Date: { now: () => 2000 },
      writeTaskState() {}, closeTaskFeed() {}, endTaskHold: async () => end, PANEL_TASK: {},
    });
    vm.runInContext(functionSource('clearTaskPlan') + '\n' + functionSource('taskPlanTool'), context);
    const text = await context.taskPlanTool({ done: true });
    assert.doesNotMatch(text, /窗口和光标已还原/);
    assert.equal(text.includes('光标已放回原处'), end?.pointerRestored === true);
    assert.equal(text.includes('前台 App 已切回'), end?.appRestored === true);
    assert.equal(text.includes('键盘鼠标接管已结束'), end?.inputReleased === true);
  }
  const facts = { inputReleased: true, pointerRestored: false };
  const context = vm.createContext({ YIELDING: null, TASK_HOLD: {}, endTaskHoldNow: async () => facts });
  vm.runInContext(functionSource('endTaskHold'), context);
  assert.equal(await context.endTaskHold(), facts, 'endTaskHold forwards native restoration facts');
}
{
  // The user's requested Return is allowed; later keyboard navigation in that window is not.
  for (const untouched of [true, false]) for (const currentToken of ['current-wait', 'newer-wait']) {
    let now = 1000;
    const noted = [], observed = [];
    const target = { tabId: 1, windowId: 10, chromePid: 42, cgWindow: 70, url: final };
    const context = vm.createContext({
      Date: { now: () => now }, sleep: async ms => { now += ms; }, ASK_POLL_MS: 20,
      BLOCKS: new Map([[1, { alertToken: currentToken }]]), randomUUID,
      pausedCheck() {}, writeTaskState() {}, siteOf: u => u,
      followSubmit: async () => final, ledgerNavigated() {},
      noteAgentNavigation: async (_tab, url) => { noted.push(url); },
      B: { pageScript: async () => '', chromeInfo: async () => target,
        evalInPage: async () => ({ target: { url: initial }, entered: { how: 'enter', filled: true, at: 1005 } }) },
    });
    vm.runInContext(source.match(/^function blockToken\b.*$/m)[0] + '\n'
      + functionSource('clearBlock') + '\n' + functionSource('waitForFieldObserved'), context);
    await context.waitForFieldObserved({ tabId: 1, startUrl: initial, field: 1, why: 'test',
      ask: { alertToken: 'current-wait' }, ms: 5000, t0: 1000 }, {
      untouched: async (seen, since) => { observed.push({ seen, since }); return untouched; },
    });
    assert.equal(noted.length, untouched ? 1 : 0);
    assert.equal(observed[0].since, 1005);
    assert.deepEqual(observed[0].seen, target);
    assert.equal(context.BLOCKS.has(1), currentToken !== 'current-wait',
      'finishing an older field wait must preserve a replacement alert on the same tab');
  }
}
{
  for (const untouched of [true, false]) {
    const claims = [];
    const context = vm.createContext({
      getTab: async tab => tab === 1 ? { ownerPid: 1 } : null,
      isMine: () => true, findLiveTab: () => ({ windowId: 10 }),
      popupCandidates: () => [{ tabId: 2, windowId: 10, url: initial }],
      settledUrl: async () => final, popupProof: () => 'source',
      B: { pageScript: async () => '', evalInPage: async () => ({ opener: true }) },
      legacyTabs: async () => [], agentName: () => 'test',
      claimTab: async (...args) => { claims.push(args); return true; }, LEDGER: { apply() {} },
    });
    vm.runInContext(functionSource('claimPopups'), context);
    await context.claimPopups({}, {}, { target: { tabId: 1, windowId: 10 } },
      { noteable: true, since: 100, untouched: async () => untouched }, initial);
    assert.equal(claims.length, untouched ? 1 : 0, 'a typed popup URL must not be claimed as agent navigation');
  }
}

// Compile the real bounded metadata history. Synthetic events contain only process/window IDs
// and timestamps; no keyboard or mouse input is generated and no real event tap is installed.
{
  const helper = await fs.readFile(new URL('../src/helper.swift', import.meta.url), 'utf8');
  const start = helper.indexOf('struct NavigationInputHistory {');
  assert.ok(start > 0);
  const history = helper.slice(start, helper.indexOf('\n}\n', start) + 2);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mychrome-navigation-'));
  try {
    const source = `
import Foundation
${history}
var h = NavigationInputHistory()
h.startedAt = 100
assert(h.untouched(pid: 42, window: 70, since: 100))
h.record(pid: 9, window: 10, at: 110) // The user types in another app.
assert(h.untouched(pid: 42, window: 70, since: 100))
h.record(pid: 42, window: 71, at: 120) // Another Chrome window remains usable.
assert(h.untouched(pid: 42, window: 70, since: 100))
h.record(pid: 42, window: 70, at: 130) // Cmd-L/Return in our target, then immediately away.
h.record(pid: 9, window: 10, at: 131)
assert(!h.untouched(pid: 42, window: 70, since: 100))
assert(h.untouched(pid: 42, window: 70, since: 131))
assert(!h.untouched(pid: 42, window: 70, since: 99)) // Unobserved earlier interval.
h.record(pid: 42, window: nil, at: 140) // Chrome event with unknown target window.
assert(!h.untouched(pid: 42, window: 70, since: 131))
h.invalidate() // A disabled tap or Secure Event Input loses evidence.
assert(!h.untouched(pid: 42, window: 70, since: 150))
var overflow = NavigationInputHistory()
overflow.startedAt = 100
for i in 1...257 { overflow.record(pid: i, window: 1, at: 110) }
assert(!overflow.reliable && overflow.latest.count == 256)
print("native metadata history: 9 assertions passed")
`;
    const file = path.join(tmp, 'main.swift'), bin = path.join(tmp, 'navigation-history');
    await fs.writeFile(file, source);
    execFileSync('/usr/bin/swiftc', [file, '-o', bin], { stdio: 'pipe' });
    console.log(execFileSync(bin, [], { encoding: 'utf8' }).trim());
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
console.log('navigation: 13 regression groups passed');
