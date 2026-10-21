#!/usr/bin/env node
/* Agent-tab ownership and cleanup. The rules that must never break: a tab
 * that is not in the registry (the user's) is never a candidate, and a tab the
 * user may have taken over is never closed. Registry and lock live in a temp
 * directory; Chrome is a fake listing. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-tabs-test-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
await mkdir(path.join(tmp, 'lock'));
const T = await import('../src/tabs.js');
const LOCK = process.env.CHROME_BRIDGE_LOCK;

const now = 1_000_000;
const TTL = 10 * 60_000;
const alive = (pid) => pid !== 999;          // pid 999 = crashed server
const rec = (tabId, ownerPid, idleMs, x = {}) => ({ tabId, ownerPid, windowId: 7, expectedUrl: `https://a.test/${tabId}`,
  openedAt: now - idleMs, lastUsed: now - idleMs, takenOver: false, closeBlocked: false, ...x });
const opts = (x = {}) => ({ now, ttlMs: TTL, isAlive: alive, ...x });
const ok = (name) => console.log(`  ok  ${name}`);

// Listing in the shape `chromectl list` returns.
const tab = (id, url, active = false) => ({ id, url, title: `t${id}`, active });
const listing = ({ frontmost = 'WeChat', windows }) => ({ ok: true, chromePid: 42, frontmost, windows });
const userWin = (tabs, index = 1) => ({ id: 1, index, minimized: false, mode: 'normal', tabs });
const agentWin = (tabs, index = 2) => ({ id: 7, index, minimized: false, mode: 'normal', tabs });

// user tabs 1,2 exist in Chrome but are not registered -> untouchable by construction
const existing = new Set([1, 2, 10, 11, 12, 13, 14]);

console.log('decideSweep');
{
  const { close, drop } = T.decideSweep([rec(10, 100, 1000)], existing, null, opts());
  assert.equal(close.length, 0); assert.equal(drop.length, 0);
  ok('a recently used agent tab stays open');
}
{
  const { close } = T.decideSweep([rec(11, 100, TTL + 1)], existing, null, opts());
  assert.deepEqual(close.map(c => [c.tabId, c.reason]), [[11, 'idle']]);
  ok('an agent tab idle past the TTL is closed');
}
{
  const { close } = T.decideSweep([rec(12, 999, 1000)], existing, null, opts());
  assert.deepEqual(close.map(c => [c.tabId, c.reason]), [[12, 'owner_gone']]);
  ok('a tab whose server process is gone is closed');
}
{
  const { close } = T.decideSweep([rec(13, 100, 1000), rec(14, 200, 1000)], existing, null, opts({ exitingPid: 100 }));
  assert.deepEqual(close.map(c => [c.tabId, c.reason]), [[13, 'session_end']]);
  ok('session end closes only that session\'s tabs');
}
{
  const { close } = T.decideSweep([rec(11, 999, TTL * 5)], existing, 11, opts({ exitingPid: 999 }));
  assert.equal(close.length, 0);
  ok('the tab the user is looking at is never closed, whatever the reason');
}
{
  const { close, drop } = T.decideSweep([rec(55, 100, TTL * 5)], existing, null, opts());
  assert.equal(close.length, 0); assert.deepEqual(drop.map(d => d.tabId), [55]);
  ok('a registered tab that no longer exists is only unregistered');
}
{
  const all = T.decideSweep([rec(10, 999, TTL * 9), rec(11, 999, TTL * 9)], existing, null, opts({ exitingPid: 999 }));
  assert.ok(!all.close.some(c => c.tabId === 1 || c.tabId === 2));
  ok('user tabs 1 and 2 are never selected');
}
{
  const r = T.decideSweep([rec(10, 999, TTL * 9, { takenOver: true }), rec(11, 999, TTL * 9, { closeBlocked: true })],
    existing, null, opts({ exitingPid: 999 }));
  assert.equal(r.close.length, 0); assert.equal(r.drop.length, 0);
  ok('taken-over and closeBlocked tabs are never closed (session end, owner gone, idle)');
}

console.log('checkTakeover');
{
  const r = rec(10, 100, 0);
  const c = T.checkTakeover(r, { id: 10, url: r.expectedUrl, windowId: 1 });
  assert.equal(c.changed, true); assert.equal(c.why, 'moved_window'); assert.equal(c.rec.takenOver, true);
  ok('a tab dragged into another window is taken over');
}
{
  const r = rec(10, 100, 0);
  const c = T.checkTakeover(r, { id: 10, url: 'https://elsewhere.test/', windowId: 7 });
  assert.equal(c.why, 'url_changed'); assert.equal(c.rec.takenOver, true);
  ok('a URL the agent did not navigate to means taken over');
}
{
  const r = rec(10, 100, 0);
  const c = T.checkTakeover(r, { id: 10, url: r.expectedUrl, windowId: 7 });
  assert.equal(c.changed, false); assert.equal(c.rec.takenOver, false);
  const c2 = T.checkTakeover({ ...r, expectedUrl: 'https://a.test' }, { id: 10, url: 'https://a.test/', windowId: 7 });
  assert.equal(c2.changed, false);
  ok('same window and same URL (after normalisation) is not a takeover');
}
{
  const r = rec(10, 100, 0, { takenOver: true, takenOverWhy: 'url_changed' });
  const c = T.checkTakeover(r, { id: 10, url: r.expectedUrl, windowId: 7 });
  assert.equal(c.rec.takenOver, true); assert.equal(c.changed, false);
  ok('takeover is sticky: going back to the expected URL does not clear it');
}
{
  const r = rec(10, 100, 0);
  const c = T.checkTakeover(r, null);
  assert.equal(c.changed, false);
  ok('a tab that is gone is not marked (it is dropped instead)');
}

console.log('frontmost-active marking');
{
  const l = listing({ frontmost: 'Google Chrome', windows: [agentWin([tab(10, 'https://a.test/10', true)], 1), userWin([tab(1, 'u', true)], 2)] });
  assert.equal(T.frontActiveTabId(l), 10);
  const p = T.planSweep([rec(10, 100, 0)], l, { userTabId: 10, ...opts() });
  assert.deepEqual(p.marks, [{ tabId: 10, why: 'user_viewing' }]); assert.equal(p.close.length, 0);
  ok('active tab of the front window while Chrome is frontmost, no lock -> taken over');
}
{
  const l = listing({ frontmost: 'WeChat', windows: [agentWin([tab(10, 'https://a.test/10', true)], 1)] });
  assert.equal(T.frontActiveTabId(l), null);
  const l2 = listing({ frontmost: 'Google Chrome', windows: [{ ...agentWin([tab(10, 'https://a.test/10', true)], 1), minimized: true }] });
  assert.equal(T.frontActiveTabId(l2), null);
  const l3 = listing({ frontmost: 'Google Chrome', windows: [userWin([tab(1, 'u', true)], 1), agentWin([tab(10, 'https://a.test/10', true)], 2)] });
  assert.equal(T.frontActiveTabId(l3), 1);
  const p = T.planSweep([rec(10, 100, 0)], l3, { userTabId: T.frontActiveTabId(l3), ...opts() });
  assert.equal(p.marks.length, 0);
  ok('not marked when Chrome is in the background, the window is minimized, or another window is in front');
}
{
  const l = listing({ frontmost: 'Google Chrome', windows: [agentWin([tab(10, 'https://a.test/10', true)], 1)] });
  const p = T.planSweep([rec(10, 100, TTL * 3)], l, { userTabId: null, ...opts() });
  assert.equal(p.marks.length, 0); assert.equal(p.close.length, 0);
  ok('with the lock held (userTabId null) it is not marked, and still not closed while on screen');
}
{
  const l = listing({ windows: [agentWin([tab(10, 'https://moved.test/', true), tab(11, 'https://a.test/11')])] });
  const p = T.planSweep([rec(10, 100, TTL * 3), rec(11, 100, TTL * 3), rec(55, 100, 0)], l, { lockQuiet: false, ...opts() });
  assert.deepEqual([p.marks.length, p.close.length, p.drop.map(d => d.tabId)], [0, 0, [55]]);
  ok('a sweep that saw the input lock only unregisters gone tabs: no marks, no closes');
}
{
  let n = 0;
  const l = listing({ frontmost: 'Google Chrome', windows: [agentWin([tab(10, 'https://a.test/10', true)], 1)] });
  const free = await T.observeUserTab({ listTabs: async () => { n++; return l; }, lockDir: LOCK });
  assert.equal(free.quiet, true); assert.equal(free.userTabId, 10);
  await mkdir(LOCK); await writeFile(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  const held = await T.observeUserTab({ listTabs: async () => l, lockDir: LOCK });
  assert.equal(held.quiet, false); assert.equal(held.userTabId, null);
  await rm(LOCK, { recursive: true });
  const during = await T.observeUserTab({ lockDir: LOCK, listTabs: async () => {
    await mkdir(LOCK); await new Promise(r => setTimeout(r, 20)); await rm(LOCK, { recursive: true }); return l; } });
  assert.equal(during.quiet, false); assert.equal(during.userTabId, null);
  await mkdir(LOCK); await writeFile(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: 999999, since: Date.now() }));
  const dead = await T.inputLockSnapshot({ lockDir: LOCK, isAlive: () => false });
  assert.equal(dead.held, false);
  await rm(LOCK, { recursive: true });
  ok('user-viewing is only reported when the lock was free across the whole listing (held, taken+released, dead holder)');
}

console.log('closeVerdict (every closing path)');
{
  const live = { id: 10, url: 'https://a.test/10', windowId: 7 };
  assert.deepEqual(T.closeVerdict(null, live), { ok: false, reason: 'not_agent_tab' });
  assert.deepEqual(T.closeVerdict(rec(10, 1, 0), null), { ok: false, reason: 'gone' });
  assert.deepEqual(T.closeVerdict(rec(10, 1, 0, { takenOver: true }), live), { ok: false, reason: 'taken_over' });
  assert.deepEqual(T.closeVerdict(rec(10, 1, 0, { closeBlocked: true }), live), { ok: false, reason: 'close_blocked' });
  assert.deepEqual(T.closeVerdict(rec(10, 1, 0), live), { ok: true });
  ok('unregistered, gone, taken over, closeBlocked are refused; an owned tab is allowed');
}

console.log('diff-appeared tabs');
{
  const before = listing({ windows: [userWin([tab(1, 'u')]), agentWin([tab(10, 'https://a.test/10', true)])] });
  const after = listing({ windows: [userWin([tab(1, 'u'), tab(3, 'https://user-cmd-t.test/')]),
    agentWin([tab(10, 'https://a.test/10'), tab(20, 'https://popup.test/', true)])] });
  const fresh = T.diffNewTabs(before, after);
  assert.deepEqual(fresh.map(f => [f.tabId, f.windowId]), [[3, 1], [20, 7]]);
  assert.deepEqual(await T.allTabs(), []);
  const p = T.planSweep(await T.allTabs(), after, { exitingPid: process.pid, ...opts() });
  assert.equal(p.close.length, 0);
  ok('diffNewTabs only reports the tabs that appeared (with ids); it registers nothing, so nothing of them is closed ' +
    '(registering a popup to the clicking agent is claimPopups\' job, under its own rules: test/ledger.test.mjs)');
}

console.log('registry persistence');
{
  await T.registerTab(30, 'https://a.test/30', { windowId: 7, now });
  let r = await T.getTab(30);
  assert.deepEqual([r.tabId, r.ownerPid, r.windowId, r.expectedUrl, r.takenOver, r.closeBlocked], [30, process.pid, 7, 'https://a.test/30', false, false]);
  await T.touchTab(30, now + 5);
  r = await T.getTab(30);
  assert.equal(r.lastUsed, now + 5); assert.equal(r.expectedUrl, 'https://a.test/30');
  ok('register writes windowId + expectedUrl; touch (what read_page does) moves lastUsed only');

  const later = now + 1;
  const c = await T.checkTabBeforeUse(30, { id: 30, url: 'https://user-went-here.test/', windowId: 7 }, later);
  assert.deepEqual([c.takenOver, c.why], [true, 'url_changed']);
  await T.touchTab(30, later + 1);
  r = await T.getTab(30);
  assert.deepEqual([r.takenOver, r.takenOverWhy], [true, 'url_changed']);
  ok('read_page after a user navigation does not absorb it: the next check marks takeover, touch keeps it');

  await T.noteAgentNavigation(30, 'https://user-went-here.test/', now + 8);
  r = await T.getTab(30);
  assert.equal(r.expectedUrl, 'https://user-went-here.test/'); assert.equal(r.takenOver, true);
  ok('noteAgentNavigation moves expectedUrl but never clears takeover');

  // A concurrent writer that read the record before the mark and writes it back afterwards.
  await T.registerTab(31, 'https://a.test/31', { windowId: 7, now });
  const stale = await T.getTab(31);
  await T.markTakenOver(31, 'moved_window', now);
  await writeFile(path.join(T.TAB_DIR, '31.json'), JSON.stringify({ ...stale, lastUsed: now + 9 }));
  r = await T.getTab(31);
  assert.deepEqual([r.takenOver, r.takenOverWhy, r.lastUsed], [true, 'moved_window', now + 9]);
  ok('a racing read-modify-write of the record cannot clear takeover (flag file)');

  await T.registerTab(32, 'https://a.test/32', { windowId: 7, now });
  await T.noteAgentNavigation(32, 'https://a.test/32/next', now + 1);
  const c2 = await T.checkTabBeforeUse(32, { id: 32, url: 'https://a.test/32/next', windowId: 7 });
  assert.equal(c2.takenOver, false);
  ok('an agent navigation reported through noteAgentNavigation is not a takeover');

  await T.registerTab(33, 'https://a.test/33', now);     // old positional signature
  r = await T.getTab(33);
  assert.deepEqual([r.openedAt, r.windowId], [now, null]);
  assert.equal(T.checkTakeover(r, { id: 33, url: 'https://a.test/33', windowId: 99 }).changed, false);
  ok('registerTab(tabId, url, now) still works; unknown windowId skips the window check');
  for (const id of [30, 31, 32, 33]) await T.forgetTab(id);
  assert.deepEqual(await readdir(T.TAB_DIR), []);
  ok('forgetTab removes the record and its flag files');
}

// Fake Chrome with a virtual clock for close confirmation. A closable tab
// disappears only from the second listing after its close request (Chrome
// removes it a little after chromectl returns).
function fakeChrome({ windows, closable = () => true, closeHangs = false }) {
  let t = 0;
  const state = { windows: structuredClone(windows), closeCalls: [], lists: 0, removeAt: new Map() };
  return {
    state,
    clock: () => t,
    sleep: async (ms) => { t += ms; },
    listTabs: async () => {
      state.lists++;
      for (const [id, n] of state.removeAt) {
        if (state.lists >= n) { for (const w of state.windows) w.tabs = w.tabs.filter(x => x.id !== id); state.removeAt.delete(id); }
      }
      return listing({ windows: structuredClone(state.windows) });
    },
    closeTab: (id) => {
      state.closeCalls.push(id);
      if (closeHangs) return new Promise(() => {});
      if (closable(id)) state.removeAt.set(id, state.lists + 2);
      return Promise.resolve({ ok: true, closed: true });
    }
  };
}

console.log('close confirmation');
{
  await T.registerTab(40, 'https://a.test/40', { windowId: 7, now });
  const fc = fakeChrome({ windows: [agentWin([tab(40, 'https://a.test/40')])] });
  const r = await T.closeAndConfirm([40], fc);
  assert.deepEqual(r, { closed: [40], blocked: [] });
  assert.ok(fc.state.lists >= 2, 'confirmed by a fresh listing after the close');
  assert.equal(await T.getTab(40), null);
  ok('a close is confirmed by a fresh listing before the record is forgotten');
}
{
  await T.registerTab(41, 'https://a.test/41', { windowId: 7, now });
  const fc = fakeChrome({ windows: [agentWin([tab(41, 'https://a.test/41')])], closable: () => false });
  const r = await T.closeAndConfirm([41], fc);
  assert.deepEqual(r, { closed: [], blocked: [41] });
  assert.ok(fc.clock() >= T.CLOSE_CONFIRM_MS && fc.clock() < T.CLOSE_CONFIRM_MS + 300);
  const rec41 = await T.getTab(41);
  assert.equal(rec41.closeBlocked, true);
  assert.equal(T.tabStatus(rec41), '关闭没有完成（可能有未保存内容的提示框），不会再自动尝试');
  ok('still listed after 3 s -> closeBlocked, record kept, shown by tabStatus');

  const fc2 = fakeChrome({ windows: [agentWin([tab(41, 'https://a.test/41')])] });
  const s = await T.sweepTabs({ ...fc2, exitingPid: process.pid, now, isAlive: alive, lockDir: LOCK });
  assert.deepEqual([s.closed.length, fc2.state.closeCalls.length], [0, 0]);
  const c = await T.closeAgentTab(41, fc2);
  assert.deepEqual([c.ok, c.reason, fc2.state.closeCalls.length], [false, 'close_blocked', 0]);
  ok('a closeBlocked tab is never retried: not by the sweep, not by session end, not by close_tab');
  await T.forgetTab(41);
}
{
  await T.registerTab(42, 'https://a.test/42', { windowId: 7, now });
  const fc = fakeChrome({ windows: [agentWin([tab(42, 'https://a.test/42')])], closeHangs: true });
  const r = await T.closeAndConfirm([42], fc);
  assert.deepEqual(r.blocked, [42]);
  assert.ok(fc.clock() <= T.CLOSE_CONFIRM_MS + 300);
  ok('a close request that never returns does not hang the sweep past the deadline');
  await T.forgetTab(42);
}

console.log('closing paths share the ownership check');
{
  const fc = fakeChrome({ windows: [userWin([tab(1, 'https://mine.test/', true)])] });
  assert.deepEqual(await T.closeAgentTab(1, fc), { ok: false, reason: 'not_agent_tab' });
  assert.equal(fc.state.closeCalls.length, 0);
  ok('close_tab refuses a user tab');
}
{
  await T.registerTab(50, 'https://a.test/50', { windowId: 7, now });
  const fc = fakeChrome({ windows: [agentWin([tab(50, 'https://user-typed.test/')])] });
  const c = await T.closeAgentTab(50, fc);
  assert.deepEqual([c.ok, c.reason, c.why, fc.state.closeCalls.length], [false, 'taken_over', 'url_changed', 0]);
  assert.equal(T.tabStatus(await T.getTab(50)), '可能已被你接手，不会自动关闭');
  ok('close_tab runs the takeover check first and refuses a taken-over tab');
  await T.forgetTab(50);
}
{
  await T.registerTab(51, 'https://a.test/51', { windowId: 7, now });
  const fc = fakeChrome({ windows: [agentWin([tab(51, 'https://a.test/51')])] });
  assert.deepEqual(await T.closeAgentTab(51, fc), { ok: true, closed: true });
  assert.deepEqual(fc.state.closeCalls, [51]); assert.equal(await T.getTab(51), null);
  ok('close_tab closes an owned tab and forgets it after confirmation');
}
{
  await T.registerTab(52, 'https://a.test/52', { windowId: 7, now });
  const fc = fakeChrome({ windows: [agentWin([tab(1, 'u')])] });
  assert.deepEqual(await T.closeAgentTab(52, fc), { ok: true, closed: false, reason: 'gone' });
  assert.equal(await T.getTab(52), null);
  ok('close_tab on a tab that is already gone only unregisters it');
}
{
  // Session end: own tabs 60 (fine), 61 (user navigated), 62 (dragged to user window); other pid's 63 stays.
  await T.registerTab(60, 'https://a.test/60', { windowId: 7, now });
  await T.registerTab(61, 'https://a.test/61', { windowId: 7, now });
  await T.registerTab(62, 'https://a.test/62', { windowId: 7, now });
  await T.registerTab(63, 'https://a.test/63', { windowId: 7, now, ownerPid: 4242 });
  const fc = fakeChrome({ windows: [
    userWin([tab(1, 'u', true), tab(62, 'https://a.test/62')]),
    agentWin([tab(60, 'https://a.test/60'), tab(61, 'https://user.test/'), tab(63, 'https://a.test/63', true)])] });
  const s = await T.sweepTabs({ ...fc, exitingPid: process.pid, now: now + 1, isAlive: () => true, lockDir: LOCK });
  assert.deepEqual(fc.state.closeCalls, [60]);
  assert.deepEqual(s.closed.map(r => r.tabId), [60]);
  assert.deepEqual(s.marked.sort((a, b) => a.tabId - b.tabId), [{ tabId: 61, why: 'url_changed' }, { tabId: 62, why: 'moved_window' }]);
  assert.deepEqual((await T.allTabs()).map(r => [r.tabId, r.takenOver]).sort(), [[61, true], [62, true], [63, false]]);
  assert.ok(!fc.state.closeCalls.includes(1));
  ok('session end closes only own, untouched tabs; taken-over ones are marked and kept');

  const fc2 = fakeChrome({ windows: fc.state.windows });
  await mkdir(LOCK); await writeFile(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  const s2 = await T.sweepTabs({ ...fc2, now: now + TTL * 9, isAlive: () => false, lockDir: LOCK });
  assert.deepEqual([s2.closed.length, s2.marked.length, fc2.state.closeCalls.length], [0, 0, 0]);
  await rm(LOCK, { recursive: true });
  const s3 = await T.sweepTabs({ ...fc2, now: now + TTL * 9, isAlive: () => false, lockDir: LOCK });
  assert.deepEqual(fc2.state.closeCalls, [63]);
  assert.deepEqual(s3.closed.map(r => [r.tabId, r.reason]), [[63, 'owner_gone']]);
  ok('a sweep during a held lock does nothing; the next one closes only the untouched orphan');
  for (const id of [61, 62]) await T.forgetTab(id);
}

console.log('no grace period: a URL is the agent\'s only when the agent recorded it (codex2-3)');
{
  // The finding's case: the user navigates the agent tab right after an agent
  // action, then switches away (Chrome not frontmost, so no user_viewing).
  await T.registerTab(10, 'https://a.test/x', { windowId: 7, now });
  await T.noteAgentNavigation(10, 'https://a.test/x', now + 1000);
  const recs = await T.allTabs();
  assert.equal(recs.find(r => r.tabId === 10).agentNavUntil, undefined, 'a grace deadline was recorded');
  const live = listing({ windows: [agentWin([tab(10, 'https://user.example/y')])] });
  const p = T.planSweep(recs.filter(r => r.tabId === 10), live, opts({ now: now + 2000, exitingPid: process.pid }));
  assert.deepEqual(p.marks, [{ tabId: 10, why: 'url_changed' }]);
  assert.equal(p.close.length, 0, 'session end would close a tab the user navigated');
  assert.equal('adopts' in p, false);
  const c = T.checkTakeover(recs.find(r => r.tabId === 10), { id: 10, url: 'https://user.example/y', windowId: 7 });
  assert.deepEqual([c.changed, c.why, c.rec.expectedUrl], [true, 'url_changed', 'https://a.test/x']);
  ok('a URL change 1 s after an agent navigation marks url_changed; the session-end sweep does not close it');
  await T.forgetTab(10);
}
{
  await T.registerTab(11, 'https://a.test/11', { windowId: 7, now });
  const c = await T.checkTabBeforeUse(11, { id: 11, url: 'https://user.example/other', windowId: 7 }, now + 500);
  assert.deepEqual([c.takenOver, c.why], [true, 'url_changed']);
  const r = await T.getTab(11);
  assert.equal(r.expectedUrl, 'https://a.test/11', 'the read_page path changed expectedUrl');
  ok('checkTabBeforeUse (read_page, every tool call) never moves expectedUrl, even right after registration');
  await T.forgetTab(11);
}
{
  // A record from an earlier build that still carries a grace deadline in the future.
  const old = rec(12, 100, 0, { expectedUrl: 'http://site.test/', agentNavUntil: now + 10_000 });
  const c = T.checkTakeover(old, { id: 12, url: 'https://www.site.test/', windowId: 7 });
  assert.deepEqual([c.changed, c.why], [true, 'url_changed']);
  ok('an old record\'s agentNavUntil is ignored');
}
{
  await T.registerTab(70, 'http://site.test/', { windowId: 7, now });
  const fc = fakeChrome({ windows: [agentWin([tab(70, 'https://www.site.test/')])] });
  const s = await T.sweepTabs({ ...fc, exitingPid: process.pid, now: now + 2000, isAlive: () => true, lockDir: LOCK });
  assert.deepEqual([s.marked, s.closed.length, fc.state.closeCalls.length], [[{ tabId: 70, why: 'url_changed' }], 0, 0]);
  const r70 = await T.getTab(70);
  assert.deepEqual([r70.takenOver, r70.expectedUrl], [true, 'http://site.test/']);
  ok('a sweep never stores a URL it merely saw; the tab is marked and kept (leak, not close)');
  await T.forgetTab(70);
}

console.log('close_tab and the tab the user is looking at (review codex1-8)');
{
  await T.registerTab(71, 'https://a.test/71', { windowId: 7, now });
  const front = [agentWin([tab(71, 'https://a.test/71', true)], 1), userWin([tab(1, 'u', true)], 2)];
  const fc = fakeChrome({ windows: front });
  const listFront = fc.listTabs;
  fc.listTabs = async () => ({ ...(await listFront()), frontmost: 'Google Chrome' });
  const c = await T.closeAgentTab(71, { ...fc, lockDir: LOCK });
  assert.deepEqual([c.ok, c.reason, c.why, fc.state.closeCalls.length], [false, 'taken_over', 'user_viewing', 0]);
  assert.equal(T.tabStatus(await T.getTab(71)), '可能已被你接手，不会自动关闭');
  ok('lock free: the tab on screen in front is marked as the user\'s and not closed');
  await T.forgetTab(71);

  await T.registerTab(72, 'https://a.test/72', { windowId: 7, now });
  const fc2 = fakeChrome({ windows: [agentWin([tab(72, 'https://a.test/72', true)], 1)] });
  const list2 = fc2.listTabs;
  fc2.listTabs = async () => ({ ...(await list2()), frontmost: 'Google Chrome' });
  await mkdir(LOCK); await writeFile(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  const c2 = await T.closeAgentTab(72, { ...fc2, lockDir: LOCK });
  await rm(LOCK, { recursive: true });
  assert.deepEqual([c2.ok, c2.transient, fc2.state.closeCalls.length], [false, true, 0]);
  assert.equal((await T.getTab(72)).takenOver, false, 'marked although an agent may have put it there');
  ok('lock held: the on-screen tab is not closed and not marked (transient refusal)');
  await T.forgetTab(72);
}

console.log('B4: an agent tab the agent itself left in front (live 2026-10-06)');
{
  await T.registerTab(72, 'https://a.test/72', { windowId: 7, now });
  await T.noteAgentDone(72, Date.now());
  const fc = fakeChrome({ windows: [agentWin([tab(72, 'https://a.test/72', true)], 1), userWin([tab(1, 'u', true)], 2)] });
  const lf = fc.listTabs;
  fc.listTabs = async () => ({ ...(await lf()), frontmost: 'Google Chrome' });
  const c = await T.closeAgentTab(72, { ...fc, lockDir: LOCK, clickedSince: async () => false });
  assert.equal(c.ok, true, JSON.stringify(c));
  ok('no click of the user\'s since the agent was done with it → still the agent\'s, closed');
  await T.registerTab(73, 'https://a.test/73', { windowId: 7, now });
  const fd = fakeChrome({ windows: [agentWin([tab(73, 'https://a.test/73', true)], 1)] });
  const lg = fd.listTabs;
  fd.listTabs = async () => ({ ...(await lg()), frontmost: 'Google Chrome' });
  const d = await T.closeAgentTab(73, { ...fd, lockDir: LOCK, clickedSince: async () => true });
  assert.deepEqual([d.ok, d.why], [false, 'user_viewing']);
  ok('after a click of the user\'s it is theirs and kept');
  await T.forgetTab(73);
}

console.log('close confirmation with a stalled listing (review codex1-12)');
{
  await T.registerTab(73, 'https://a.test/73', { windowId: 7, now });
  const fc = fakeChrome({ windows: [agentWin([tab(73, 'https://a.test/73')])] });
  fc.listTabs = () => new Promise(() => {});
  const r = await T.closeAndConfirm([73], fc);
  assert.deepEqual(r, { closed: [], blocked: [73] });
  assert.ok(fc.clock() <= T.CLOSE_CONFIRM_MS + 300, `waited ${fc.clock()} ms for a listing that never returns`);
  assert.equal((await T.getTab(73)).closeBlocked, true);
  ok('a listing that never returns: blocked at the deadline, record kept');
  await T.forgetTab(73);

  await T.registerTab(74, 'https://a.test/74', { windowId: 7, now });
  const fc2 = fakeChrome({ windows: [agentWin([tab(74, 'https://a.test/74')])], closable: () => false });
  const list2 = fc2.listTabs;
  let n = 0;
  fc2.listTabs = () => (++n === 1 ? list2() : new Promise(r => setTimeout(() => r(list2()), 8000).unref()));
  const t0 = Date.now();
  const r2 = await T.closeAndConfirm([74], fc2);
  assert.deepEqual(r2.blocked, [74]);
  assert.ok(fc2.clock() <= T.CLOSE_CONFIRM_MS + 300 && Date.now() - t0 < 2000, `fake ${fc2.clock()} ms, real ${Date.now() - t0} ms`);
  ok('first listing fast, second one stalls: still blocked at the deadline');
  await T.forgetTab(74);

  await T.registerTab(75, 'https://a.test/75', { windowId: 7, now });
  const fc3 = fakeChrome({ windows: [agentWin([tab(75, 'https://a.test/75')])], closeHangs: true });
  const list3 = fc3.listTabs;
  fc3.listTabs = async () => { const l = await list3(); l.windows[0].tabs = []; return l; };
  assert.deepEqual(await T.closeAndConfirm([75], fc3), { closed: [75], blocked: [] });
  ok('a close that used up the deadline still gets one confirming listing');
}

console.log('legacy registry');
{
  assert.notEqual(T.TAB_DIR, T.LEGACY_TAB_DIR);
  assert.ok(Array.isArray(await T.legacyTabs()));
  ok('records of older builds live elsewhere and are only read');
}

await rm(tmp, { recursive: true, force: true });
console.log('\ntab ownership tests passed.');
