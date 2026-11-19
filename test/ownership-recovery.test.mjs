/* Ownership recovery uses isolated records and virtual browser/native evidence. No UI input. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'mychrome-ownership-recovery-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'locks', 'input.lock');
await mkdir(path.dirname(process.env.CHROME_BRIDGE_LOCK));
const T = await import('../src/tabs.js');
const L = await import('../src/ledger.js');
const { openNavigationObserver } = await import('../src/bridge.js');
const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
let passed = 0;
const target = { tabId: 501, windowId: 81, chromePid: 42, cgWindow: 70, url: 'https://fixture.test/result' };
const uncertain = { token: 'creation-501', since: 100, native: { chromePid: 42, cgWindow: 70 } };
const proof = { ...uncertain, known: true, untouched: true, windowId: 81, url: target.url };
async function check(name, fn) { await fn(); console.log(`  ok ${++passed} ${name}`); }
async function register(id = 501, extra = {}) {
  await T.forgetTab(id);
  await T.registerTab(id, 'https://fixture.test/start', { windowId: 81, now: 200, uncertainty: uncertain, ...extra });
  return T.getTab(id);
}
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness({ observation = { known: false, untouched: false }, live = target, noObserver = false } = {}) {
  const state = { observation, live, closed: 0, timers: [] };
  const observer = { startedAt: 100, observation: async () => state.observation,
    close: async () => { state.closed++; } };
  const ledger = new L.TabLedger();
  const context = vm.createContext({
    Date, Number, Map, Set, Promise, Math,
    setTimeout: fn => { const timer = { fn, unref() {} }; state.timers.push(timer); return timer; }, clearTimeout() {},
    B: { openNavigationObserver: async () => { if (noObserver) throw Error('unavailable'); return observer; }, chromeInfo: async () => state.live },
    OPEN_NAVIGATIONS: new Map(), OPEN_NAVIGATION_MS: 120000, LEDGER: ledger,
    settledUrl: async () => target.url, randomUUID: () => 'new-creation-501', agentName: () => 'fixture',
    isMine: rec => Number(rec?.ownerPid) === T.OWNER_PID,
    getTab: T.getTab, registerTab: T.registerTab, markTakenOver: T.markTakenOver,
    confirmNavigationOwnership: T.confirmNavigationOwnership,
  });
  vm.runInContext(['navigationObservation', 'forgetOpenNavigation', 'retainOpenNavigation',
    'reconcileOpenNavigation', 'registerSettled', 'openAndRegister'].map(functionSource).join('\n'), context);
  return { state, context, ledger, open: () => context.openAndRegister(async () => ({ tabId: 501, windowId: 81 }), 'https://fixture.test/start') };
}
try {
  await check('observer distinguishes missing evidence from confirmed user input and preserves untouched()', async () => {
    let answer = { known: false, untouched: false };
    const observer = await openNavigationObserver({ openSession: () => ({
      request: async req => req.op === 'watchNavigation' ? { readOnly: true, startedAt: 100 } : answer,
      close: async () => {},
    }) });
    assert.equal(typeof observer.observation, 'function');
    assert.deepEqual(await observer.observation(target), { known: false, untouched: false });
    answer = { known: true, untouched: false };
    assert.deepEqual(await observer.observation(target), { known: false, untouched: false }, 'old helpers cannot distinguish a target event from an event with an unknown window');
    answer = { known: true, untouched: false, targetInput: true };
    assert.deepEqual(await observer.observation(target), { known: true, untouched: false });
    assert.equal(await observer.untouched(target), false);
    answer = { known: false, untouched: false, targetInput: true };
    assert.deepEqual(await observer.observation(target), { known: true, untouched: false }, 'later loss of coverage cannot erase an exact observed user event');
    answer = { known: true, untouched: false, ambiguousInput: true };
    assert.deepEqual(await observer.observation(target), { known: false, untouched: false });
    answer = { known: true, untouched: true };
    assert.equal(await observer.untouched(target), true);
    assert.deepEqual(await observer.observation({}), { known: false, untouched: false });
    assert.deepEqual(await observer.observation({ chromePid: 0, cgWindow: 70 }), { known: false, untouched: false });
    await observer.close();
  });
  await check('new uncertain records remain visible to new readers and invisible to both old sweep schemas', async () => {
    const rec = await register();
    assert.equal(rec.ownershipUncertain, true);
    assert.equal(rec.takenOver, false);
    assert.equal(rec.protected, true);
    const names = await readdir(T.TAB_DIR);
    assert.ok(names.includes('501.protected.json'));
    assert.equal(names.filter(n => /^\d+(\.popup)?\.json$/.test(n)).length, 0);
    await T.registerTab(502, target.url, { windowId: 81, now: 200 });
    await T.claimTab(503, target.url, { windowId: 81, now: 200 });
    assert.deepEqual((await T.allTabs()).map(r => r.tabId).sort(), [501, 502, 503]);
    assert.equal(await T.claimTab(501, target.url, { windowId: 81 }), false);
    assert.equal(T.decideSweep([rec], new Set([501]), null, { now: 99999, ttlMs: 0, isAlive: () => false }).close.length, 0);
  });
  await check('URL equality alone cannot recover uncertainty or permit close; delayed redirects remain uncertain', async () => {
    const rec = await register();
    assert.equal(await T.confirmNavigationOwnership(501, { url: rec.expectedUrl }), null);
    assert.equal(T.closeVerdict(rec, { ...target, id: 501 }).reason, 'ownership_unverified');
    assert.equal(T.checkTakeover(rec, { id: 501, windowId: 81, url: target.url }).changed, false);
    assert.equal((await T.getTab(501)).ownershipUncertain, true);
  });
  await check('a reused tab id cannot leave an older ordinary record exposed to an old sweep', async () => {
    await T.forgetTab(501);
    await T.registerTab(501, 'https://fixture.test/previous', { windowId: 81, ownerPid: 999999 });
    await T.registerTab(501, 'https://fixture.test/start', { windowId: 81, uncertainty: uncertain });
    const names = await readdir(T.TAB_DIR);
    assert.ok(!names.includes('501.json'));
    assert.equal((await T.getTab(501)).ownerPid, T.OWNER_PID);
    assert.equal((await T.getTab(501)).protected, true);
    assert.equal((await T.getTab(501)).takenOver, false);
  });
  await check('matching original observation proof restores readiness but never automatic closing', async () => {
    await register();
    const rec = await T.confirmNavigationOwnership(501, proof);
    assert.equal(rec.ownershipUncertain, false);
    assert.equal(rec.expectedUrl, target.url);
    assert.equal(rec.protected, true);
    assert.equal(T.closeVerdict(rec, { ...target, id: 501 }).ok, true);
    assert.equal(T.decideSweep([rec], new Set([501]), null, { exitingPid: rec.ownerPid, now: 99999, ttlMs: 0 }).close.length, 0);
  });
  await check('token, native window, coverage, owner and true takeover all fail closed', async () => {
    for (const change of [ { token: 'other' }, { since: 101 }, { native: { chromePid: 42, cgWindow: 99 } },
      { known: false }, { untouched: false }, { windowId: 99 } ]) {
      await register();
      assert.equal(await T.confirmNavigationOwnership(501, { ...proof, ...change }), null);
    }
    await register(501, { ownerPid: 999999 });
    assert.equal(await T.confirmNavigationOwnership(501, proof), null);
    for (const why of ['user_viewing', 'moved_window', 'user_interrupted', 'navigation_unverified']) {
      await register();
      await T.markTakenOver(501, why);
      assert.equal(await T.confirmNavigationOwnership(501, proof), null);
      assert.equal((await T.getTab(501)).takenOverWhy, why);
    }
  });
  await check('a later real takeover outranks uncertainty; normal old records keep their sticky behavior', async () => {
    for (const [live, opts, why] of [
      [{ id: 501, windowId: 99, url: target.url }, {}, 'moved_window'],
      [{ id: 501, windowId: 81, url: target.url }, { userTabId: 501 }, 'user_viewing'],
    ]) {
      const rec = await register();
      assert.equal(T.checkTakeover(rec, live, opts).why, why);
    }
    await register(501, { uncertainty: null });
    await T.markTakenOver(501, 'navigation_unverified');
    assert.equal(await T.confirmNavigationOwnership(501, proof), null);
    assert.equal((await T.getTab(501)).takenOver, true);
  });
  await check('ledger uncertainty stays on the original tab, reads do not manufacture proof, and real takeover wins', async () => {
    const ledger = new L.TabLedger();
    ledger.apply(501, { type: 'open', url: target.url });
    ledger.apply(501, { type: 'uncertain' });
    assert.equal(ledger.get(501).state, 'uncertain');
    assert.equal(ledger.live()[0].tabId, 501);
    assert.match(L.nextAction(ledger.get(501)), /原标签|这个标签/);
    assert.doesNotMatch(L.nextAction(ledger.get(501)), /先不要|先问用户|明确交回/);
    ledger.apply(501, { type: 'read', url: target.url });
    assert.equal(ledger.get(501).state, 'uncertain');
    ledger.apply(501, { type: 'verified', url: target.url });
    assert.equal(ledger.get(501).state, 'ready');
    ledger.apply(501, { type: 'takeover', why: 'user_viewing' });
    ledger.apply(501, { type: 'verified', url: target.url });
    assert.equal(ledger.get(501).state, 'taken_over');
  });
  await check('actual open registration preserves an unknown observer and recovers on its original complete evidence', async () => {
    await T.forgetTab(501);
    const h = harness();
    await h.open();
    assert.equal((await T.getTab(501)).takenOver, false);
    assert.equal(h.ledger.get(501).state, 'uncertain');
    assert.equal(h.state.closed, 0);
    await h.context.reconcileOpenNavigation(target);
    assert.equal(h.ledger.get(501).state, 'uncertain');
    h.state.observation = { known: true, untouched: true };
    assert.equal(await h.context.reconcileOpenNavigation(target), true);
    assert.equal((await T.getTab(501)).ownershipUncertain, false);
    assert.equal(h.ledger.get(501).state, 'ready');
    assert.equal(h.state.closed, 1);
  });
  await check('actual registration and late recovery distinguish true input or moved windows from unknown', async () => {
    for (const [options, why] of [
      [{ observation: { known: true, untouched: false } }, 'user_interrupted'],
      [{ live: { ...target, windowId: 99 } }, 'moved_window'],
    ]) {
      await T.forgetTab(501);
      const h = harness(options);
      await h.open();
      assert.equal((await T.getTab(501)).takenOverWhy, why);
      assert.equal(h.ledger.get(501).state, 'taken_over');
      assert.equal(h.state.closed, 1);
    }
    await T.forgetTab(501);
    const h = harness(); await h.open();
    h.state.observation = { known: true, untouched: false };
    assert.equal(await h.context.reconcileOpenNavigation(target), false);
    assert.equal((await T.getTab(501)).takenOverWhy, 'user_interrupted');
    assert.equal(h.state.closed, 1);
  });
  await check('open registration never reclassifies a preserved old sticky flag as mere uncertainty', async () => {
    await register(501, { uncertainty: null });
    await T.markTakenOver(501, 'user_viewing');
    const h = harness();
    const opened = await h.open();
    assert.equal(opened.takenOver, true);
    assert.equal(h.ledger.get(501).state, 'taken_over');
    assert.equal(h.ledger.get(501).why, 'user_viewing');
    assert.equal(h.state.closed, 1);
  });
  await check('missing observer, lost native identity or expired original coverage cannot become ready', async () => {
    for (const options of [{ noObserver: true }, { live: null }, { live: { ...target, cgWindow: undefined } }]) {
      await T.forgetTab(501);
      const h = harness(options);
      const opened = await h.open();
      assert.equal(opened.navigationVerified, false);
      h.state.live = target;
      h.state.observation = { known: true, untouched: true };
      assert.equal(await h.context.reconcileOpenNavigation(target), false);
      assert.equal((await T.getTab(501)).ownershipUncertain, true);
    }
    await T.forgetTab(501);
    const h = harness(); await h.open();
    h.state.timers[0].fn();
    h.state.observation = { known: true, untouched: true };
    assert.equal(await h.context.reconcileOpenNavigation(target), false);
    assert.equal(h.state.closed, 1);
    assert.equal((await T.getTab(501)).takenOver, false);
    assert.equal((await T.getTab(501)).ownershipUncertain, true);
  });
  await check('recovery cannot cross native identity changes or a late loss of observation coverage', async () => {
    for (const change of [{ chromePid: 99 }, { cgWindow: 99 }, { tabId: 999 }, { url: 'https://fixture.test/other' }]) {
      await T.forgetTab(501);
      const h = harness(); await h.open();
      h.state.live = { ...target, ...change };
      h.state.observation = { known: true, untouched: true };
      assert.equal(await h.context.reconcileOpenNavigation(target), false);
      assert.equal((await T.getTab(501)).ownershipUncertain, true);
    }
    await T.forgetTab(501);
    const h = harness(); await h.open();
    const pending = h.context.OPEN_NAVIGATIONS.get(501);
    let checks = 0;
    pending.observer.observation = async () => ++checks === 1 ? { known: true, untouched: true } : { known: false, untouched: false };
    assert.equal(await h.context.reconcileOpenNavigation(target), false);
    assert.equal((await T.getTab(501)).ownershipUncertain, true);
  });
  await check('recovery preserves a real sticky flag written while the original observer is responding', async () => {
    await T.forgetTab(501);
    const h = harness(); await h.open();
    const pending = h.context.OPEN_NAVIGATIONS.get(501);
    pending.observer.observation = async () => {
      await T.markTakenOver(501, 'user_viewing');
      return { known: true, untouched: true };
    };
    assert.equal(await h.context.reconcileOpenNavigation(target), false);
    const rec = await T.getTab(501);
    assert.equal(rec.takenOverWhy, 'user_viewing');
    assert.equal(rec.ownershipUncertain, true);
  });
  await check('an obsolete reconcile cannot close the observer that replaced its slot during a registry read', async () => {
    await T.forgetTab(501);
    const h = harness(); await h.open();
    const record = await T.getTab(501);
    let resume;
    h.context.getTab = () => new Promise(resolve => { resume = resolve; });
    const pending = h.context.reconcileOpenNavigation(target);
    let replacementClosed = 0;
    const observer = { startedAt: 100, close: async () => { replacementClosed++; } };
    h.context.retainOpenNavigation(target, observer, { ...uncertain, token: 'replacement' });
    const replacement = h.context.OPEN_NAVIGATIONS.get(501);
    resume(record);
    assert.equal(await pending, false);
    assert.equal(h.state.closed, 1, 'replacing the old slot releases its observer');
    assert.equal(replacementClosed, 0);
    assert.equal(h.context.OPEN_NAVIGATIONS.get(501), replacement);
    await h.context.forgetOpenNavigation(501);
    assert.equal(replacementClosed, 1, 'normal cleanup still releases the current observer');
  });
  await check('late takeover or confirmation cleanup is bound to its captured observer identity', async () => {
    for (const phase of ['moved_window', 'user_input', 'verified']) {
      await T.forgetTab(501);
      const h = harness(); await h.open();
      const record = await T.getTab(501);
      h.state.observation = { known: true, untouched: phase !== 'user_input' };
      let resume, reached;
      const reachedWrite = new Promise(resolve => { reached = resolve; });
      const deferWrite = () => new Promise(resolve => { resume = resolve; reached(); });
      if (phase === 'verified') h.context.confirmNavigationOwnership = deferWrite;
      else h.context.markTakenOver = deferWrite;
      const pending = h.context.reconcileOpenNavigation(phase === 'moved_window' ? { ...target, windowId: 82 } : target);
      await reachedWrite;
      let replacementClosed = 0;
      h.context.retainOpenNavigation(target, { startedAt: 100, close: async () => { replacementClosed++; } },
        { ...uncertain, token: 'replacement-' + phase });
      const replacement = h.context.OPEN_NAVIGATIONS.get(501);
      resume(phase === 'verified' ? { ...record, ownershipUncertain: false } : record);
      assert.equal(await pending, false, phase);
      assert.equal(replacementClosed, 0, phase);
      assert.equal(h.context.OPEN_NAVIGATIONS.get(501), replacement, phase);
      assert.equal(h.ledger.get(501).state, 'uncertain', 'obsolete evidence cannot update the new slot ledger');
      await h.context.forgetOpenNavigation(501);
    }
  });
  await check('manual cleanup is refused while uncertain, then uses normal close-and-confirm after proof', async () => {
    await register();
    let live = true, calls = 0;
    const deps = { lockDir: process.env.CHROME_BRIDGE_LOCK, clickedSince: async () => false,
      listTabs: async () => ({ frontmost: 'Fixture other app', windows: live ? [{ id: 81, index: 1, tabs: [{ id: 501, url: target.url, active: true }] }] : [] }),
      closeTab: async () => { calls++; live = false; },
    };
    assert.equal((await T.closeAgentTab(501, deps)).reason, 'ownership_unverified');
    assert.equal(calls, 0);
    await T.confirmNavigationOwnership(501, proof);
    assert.equal((await T.closeAgentTab(501, deps)).closed, true);
    assert.equal(calls, 1);
    assert.equal(await T.getTab(501), null);
  });
  await check('a real takeover recorded during the close listing prevents sending close and preserves its flag', async () => {
    await register(); await T.confirmNavigationOwnership(501, proof);
    let calls = 0, live = true;
    const result = await T.closeAgentTab(501, {
      lockDir: process.env.CHROME_BRIDGE_LOCK, clickedSince: async () => false,
      listTabs: async () => {
        await T.markTakenOver(501, 'user_interrupted');
        return { frontmost: 'Fixture other app', windows: live ? [{ id: 81, index: 1, tabs: [{ id: 501, url: target.url, active: true }] }] : [] };
      },
      closeTab: async () => { calls++; live = false; },
    });
    assert.equal(calls, 0);
    assert.equal(result.reason, 'taken_over');
    assert.equal((await T.getTab(501)).takenOverWhy, 'user_interrupted');
  });
  await check('the final close boundary refuses sticky or uncertain records even after an earlier caller approved them', async () => {
    for (const mutation of ['takeover', 'blocked', 'uncertain']) {
      await T.forgetTab(501);
      await T.registerTab(501, target.url, { windowId: 81 });
      if (mutation === 'takeover') await T.markTakenOver(501, 'user_viewing');
      else if (mutation === 'blocked') await T.markCloseBlocked(501);
      else await register();
      let calls = 0;
      const result = await T.closeAndConfirm([501], {
        listTabs: async () => ({ windows: [{ id: 81, tabs: [{ id: 501, url: target.url }] }] }),
        closeTab: async () => { calls++; },
      });
      assert.equal(calls, 0, mutation);
      assert.equal(result.blocked.length, 0, 'a refused close was never sent');
      assert.equal(result.refused[0].reason, mutation === 'takeover' ? 'taken_over' : mutation === 'blocked' ? 'close_blocked' : 'ownership_unverified');
      assert.ok(await T.getTab(501));
    }
  });
  await check('sweep rereads sticky flags, protection and registration identity after its listing', async () => {
    for (const mutation of ['takeover', 'protection', 'new_owner']) {
      await T.forgetTab(501);
      await T.registerTab(501, target.url, { windowId: 81, now: 100 });
      let calls = 0, live = true, changed = false;
      await T.sweepTabs({
        exitingPid: T.OWNER_PID, now: 1000, isAlive: () => true,
        lockDir: process.env.CHROME_BRIDGE_LOCK, clickedSince: async () => false,
        listTabs: async () => {
          if (!changed) {
            changed = true;
            if (mutation === 'takeover') await T.markTakenOver(501, 'user_interrupted');
            else await T.registerTab(501, target.url, { windowId: 81, now: 200,
              ...(mutation === 'protection' ? { uncertainty: uncertain } : { ownerPid: 999999 }) });
          }
          return { frontmost: 'Fixture other app', windows: live ? [{ id: 81, index: 1, tabs: [{ id: 501, url: target.url, active: true }] }] : [] };
        },
        closeTab: async () => { calls++; live = false; },
      });
      assert.equal(calls, 0, mutation);
      assert.ok(await T.getTab(501), mutation);
    }
  });
  console.log(`ownership-recovery: ${passed} passed; no real browser/native input`);
} finally { await rm(tmp, { recursive: true, force: true }); }
