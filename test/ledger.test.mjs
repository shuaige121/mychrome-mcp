#!/usr/bin/env node
/* Per-session tab ledger (src/ledger.js) and its wiring in src/index.js: every transition of the
 * state machine (checked against the table in the source comment), list_tabs grouping (mine first,
 * other agents by name, orphans, user tabs), the reminder line only when something changed, the
 * "not your tab" warnings with this session's tabs, popups registered to the agent whose click
 * opened them. Registry, lock and agent-window state live in a temp directory; Chrome is a fake
 * listing and every bridge call is faked (nothing reaches the real Chrome or the input helper). */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-ledger-test-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
process.env.CHROME_BRIDGE_NOTIFY = '0';
process.env.CHROME_BRIDGE_AGENT_NAME = 'ledger-test';
process.env.CHROME_BRIDGE_HABITS = 'off';
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const L = await import('../src/ledger.js');
const T = await import('../src/tabs.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

/* ------------------------------------------------ the transition function */

console.log('transitions (nextTabState), cell by cell against the table in src/ledger.js');
{
  // The table in the comment is the specification: parse it and run every cell.
  const src = await readFile(path.join(ROOT, 'src/ledger.js'), 'utf8');
  const lines = src.split('\n');
  const h = lines.findIndex(l => /^\s*\*\s+open\s+popup\s+navigated\s+read\s+takeover\s+close\s+missing\s+foreign\s+owner_dead\s*$/.test(l));
  assert.ok(h > 0, 'transition table header not found in src/ledger.js');
  const cols = lines[h].replace(/^\s*\*\s+/, '').trim().split(/\s+/);
  assert.deepEqual(cols, L.EVENTS);
  const rows = {};
  for (let i = h + 1; /^\s*\*\s+\S/.test(lines[i]); i++) {
    const cells = lines[i].replace(/^\s*\*\s+/, '').trim().split(/\s+/);
    rows[cells[0]] = Object.fromEntries(cols.map((c, k) => [c, cells[k + 1].replace(/[¹²]/g, '')]));
  }
  assert.deepEqual(Object.keys(rows), ['(none)', ...L.STATES]);
  const entry = (state) => state === '(none)' ? null
    : { tabId: 1, state, url: 'https://a.test/1', title: 't1', base: 'https://a.test/1', from: null, why: null, owner: null, at: 0 };
  // Each event as the code emits it; navigated / read go to a new URL (¹: stale only then, checked below).
  const ev = (type) => ({ type, tabId: 1, url: 'https://a.test/2', title: 't2', why: 'url_changed', from: 9, at: 5 });
  let cells = 0;
  for (const [state, row] of Object.entries(rows)) {
    for (const [type, want] of Object.entries(row)) {
      const before = entry(state);
      const after = L.nextTabState(before, ev(type));
      if (want === '·') assert.equal(after, before, `${state} + ${type}: expected no change, got ${after && after.state}`);
      else assert.equal(after && after.state, want, `${state} + ${type}: expected ${want}, got ${after && after.state}`);
      cells++;
    }
  }
  assert.equal(cells, 8 * 9);
  ok(`all ${cells} cells of the table hold (the comment cannot drift from the code)`);
}

console.log('the transitions the owner named');
{
  const s = (e) => e && e.state;
  let e = L.nextTabState(null, { type: 'open', tabId: 5, url: 'https://a.test/x' });
  assert.equal(s(e), 'ready');
  ok('open_tab → ready');

  const p = L.nextTabState(null, { type: 'popup', tabId: 6, url: 'https://b.test/', from: 5 });
  assert.deepEqual([s(p), p.from, p.base], ['ready', 5, 'https://b.test/']);
  ok('my click opened a new tab → that tab is mine and ready, with the tab it came from');

  const same = L.nextTabState(e, { type: 'navigated', url: 'https://a.test/x' });
  assert.equal(same, e, 'an action that ended on the same URL changed the entry');
  e = L.nextTabState(e, { type: 'navigated', url: 'https://a.test/y' });
  assert.deepEqual([s(e), e.url, e.base], ['stale', 'https://a.test/y', 'https://a.test/x']);
  ok('my click / typing that navigates → stale (an action that stays on the URL I saw does not)');

  e = L.nextTabState(e, { type: 'read', url: 'https://a.test/y', title: 'Y' });
  assert.deepEqual([s(e), e.base, e.title], ['ready', 'https://a.test/y', 'Y']);
  ok('read_page → ready again (markers fresh; the URL read becomes the one I saw)');

  const back = L.nextTabState(L.nextTabState(e, { type: 'navigated', url: 'https://a.test/z' }), { type: 'navigated', url: 'https://a.test/y' });
  assert.equal(s(back), 'stale', 'navigating back to the read URL un-staled the markers');
  ok('stale stays stale until read_page, even when the URL comes back');

  const tk = L.nextTabState(e, { type: 'takeover', why: 'moved_window' });
  assert.deepEqual([s(tk), tk.why], ['taken_over', 'moved_window']);
  assert.equal(L.nextTabState(tk, { type: 'read', url: 'https://a.test/y' }), tk);
  assert.equal(L.nextTabState(tk, { type: 'close' }), tk);
  ok('takeover detected → taken_over; sticky (read_page does not clear it, close_tab does not close it)');

  assert.equal(s(L.nextTabState(e, { type: 'close' })), 'closed');
  ok('close_tab → closed');
  assert.equal(s(L.nextTabState(e, { type: 'missing' })), 'gone');
  assert.equal(s(L.nextTabState(tk, { type: 'missing' })), 'gone');
  ok('missing from Chrome → gone (also when taken over)');

  const alive = (pid) => pid !== 999;
  assert.equal(L.classifyRecord({ tabId: 1, ownerPid: process.pid }, { myPid: process.pid, isAlive: alive }), 'mine');
  assert.equal(L.classifyRecord({ tabId: 1, ownerPid: 4242 }, { myPid: process.pid, isAlive: alive }), 'other_agent');
  assert.equal(L.classifyRecord({ tabId: 1, ownerPid: 999 }, { myPid: process.pid, isAlive: alive }), 'orphan');
  ok('another process\'s tab → other_agent; its owner pid dead → orphan');
}

/* ------------------------------------------------------- the ledger class */

console.log('TabLedger: news, told, prune');
{
  const led = new L.TabLedger();
  led.apply(10, { type: 'open', url: 'https://a.test/10' });
  assert.equal(led.hasNews(), false);
  ok('open_tab is not news (its own reply gives the id)');
  led.apply(10, { type: 'read', url: 'https://a.test/10' });
  assert.equal(led.hasNews(), false);
  led.apply(10, { type: 'navigated', url: 'https://a.test/10b' });
  assert.equal(led.hasNews(), true);
  led.markReported();
  assert.equal(led.hasNews(), false);
  ok('stale is news once; after a reply showed it, nothing is new');
  led.apply(11, { type: 'popup', url: 'https://b.test/', from: 10 });
  assert.equal(led.hasNews(), true); led.markReported();
  ok('a tab my click opened is news');
  led.apply(11, { type: 'takeover', why: 'user_viewing' }, { told: true });
  assert.equal(led.hasNews(), false);
  ok('a change the reply itself states (told) is not repeated in the reminder');
  led.apply(10, { type: 'missing' });
  assert.equal(led.hasNews(), true);
  assert.deepEqual(led.entries().map(e => [e.tabId, e.state]), [[11, 'taken_over'], [10, 'gone']]);
  led.markReported();
  assert.deepEqual(led.entries().map(e => e.tabId), [11], 'a gone tab stayed after it was reported');
  ok('gone is news; closed / gone entries are dropped once a reply showed them');
  led.apply(20, { type: 'foreign', owner: { pid: 1 } });
  assert.equal(led.get(20), null);
  ok('another agent\'s tab never enters this process\'s ledger');
  led.drop(11);
  assert.equal(led.get(11), null);
}

/* ---------------------------------------------------------------- wording */

console.log('wording: list section, reminder line, recovery line, owner names');
{
  const e = (tabId, state, x = {}) => ({ tabId, state, url: `https://site${tabId}.test/page`, title: `标题${tabId}`, base: null, from: null, why: null, at: 0, ...x });
  const sec = L.mineSection([e(1, 'ready'), e(2, 'stale'), e(3, 'taken_over', { why: 'url_changed' }), e(4, 'gone'), e(5, 'ready', { from: 1 }),
    e(6, 'taken_over', { why: 'moved_window' }), e(7, 'taken_over', { why: 'user_viewing', helped: true })]);
  assert.equal(sec[0], '你（这个会话）的标签（7 个）：');
  assert.match(sec.join('\n'), /tab=2 stale .*\n {6}→ 网址在你上次 read_page 之后变了，编号已失效：先 read_page\(tab=2\)/);
  assert.match(sec.join('\n'), /tab=3 taken_over .*\n {6}→ 可能被用户动过（它现在的网址不是 agent 打开或点出来的）：先 read_page\(tab=3\) 看现在的页面；确认用户已交回后在这个标签继续/);
  assert.match(sec.join('\n'), /tab=6 taken_over .*\n {6}→ 可能已被用户接手（它被移到了别的窗口）：先不要点击、输入或关闭；可 read_page 查看现状。用户明确交回后在原标签继续，不要另开标签替代/);
  assert.match(sec.join('\n'), /tab=7 taken_over .*\n {6}→ 用户按你的请求（wait_for_user）处理过它，这不代表收到继续授权：若用户尚未在本次交接后于原对话明确说“继续”，先等待；收到后先 read_page\(tab=7\) 核对同一页面，再恢复原任务/);
  assert.match(sec.join('\n'), /tab=4 gone\n {6}→ 已经不在 Chrome 里了/);
  assert.match(sec.join('\n'), /tab=5 ready .*（tab=1 点击弹出）/);
  assert.ok(!sec.some(l => /tab=1 ready.*\n.*→/.test(l)), 'a ready tab got a next step');
  assert.equal(sec.filter(l => l.includes('→')).length, 5, 'one next-step line per non-ready tab');
  ok('list section: one line per tab, a next step only for non-ready ones, popups say where they came from');
  assert.deepEqual([e(3, 'taken_over', { why: 'url_changed' }), e(6, 'taken_over', { why: 'moved_window' }), e(7, 'taken_over', { why: 'moved_window', helped: true }),
    e(8, 'taken_over', { why: 'user_interrupted' })].map(x => L.shortItem(x).replace(/「.*$/, '')),
    ['tab=3 taken_over·先 read_page 确认', 'tab=6 taken_over·别再操作', 'tab=7 taken_over·用户处理过，等继续后读页', 'tab=8 taken_over·先 read_page 确认']);
  ok('taken over: leave it when dragged away / watched by the user; read first when uncertain; explicit continuation required after wait_for_user');
  assert.match(L.mineSection([])[0], /没有。open_tab 打开的/);

  const many = [1, 2, 3, 4, 5, 6, 7].map(i => e(i, 'ready', { title: 'x'.repeat(200) }));
  const foot = L.footerLine(many);
  assert.equal(foot.split('\n').length, 1);
  const items = foot.replace(/^［你的标签有变化］/, '').split('；');
  assert.equal(items.length, 6);
  assert.match(items[5], /^另 2 个见 list_tabs\(mine:true\)$/);
  assert.ok(items.slice(0, 5).every(x => x.length <= 80), items.map(x => x.length).join(','));
  ok('reminder: one line, at most 5 tabs of at most 80 characters, the rest counted');
  const fresh = L.footerLine([e(1, 'ready', { newsSeq: 1 }), e(2, 'stale', { newsSeq: 3 })], { sinceSeq: 2 });
  assert.match(fresh, /^［你的标签有变化］tab=2 stale·先 read_page「标题2」；tab=1 ready/);
  ok('reminder: the tab that changed comes first');
  assert.equal(L.footerLine([]), '');

  assert.equal(L.recoveryLine([]), '你这个会话当前没有登记为可用的自有标签；先 list_tabs 查找用户指定的现有标签，再 read_page 查看。继续输入前确认交接，不要直接新开标签。');
  assert.match(L.recoveryLine([e(1, 'ready')]), /^你这个会话现在可用的标签：tab=1 ready「标题1」$/);
  assert.equal(L.ownerName({ ownerPid: 42, agentName: 'codex' }), 'agent「codex」（进程 42）');
  assert.equal(L.ownerName({ ownerPid: 42 }), 'agent（进程 42）');
  for (const why of ['url_changed', 'user_interrupted', 'moved_window', 'user_viewing', 'unknown']) {
    const hint = L.nextAction(e(9, 'taken_over', { why }));
    assert.match(hint, /read_page/);
    assert.match(hint, /交回/);
    assert.doesNotMatch(hint, /open_tab/);
  }
  assert.doesNotMatch(L.recoveryLine([]), /open_tab/);
  ok('takeover recovery reads the shared tab and requires handoff instead of a duplicate tab');
  ok('recovery line and owner names (a record of an older build has no name: pid only)');
}

/* ---------------------------------------------------------------- registry */

console.log('registry: owner name, back-compat, create-only claim, popup candidates');
{
  await T.registerTab(30, 'https://a.test/30', { windowId: 7, agentName: 'claude-code' });
  let r = await T.getTab(30);
  assert.deepEqual([r.ownerPid, r.agentName, 'openedFrom' in r], [process.pid, 'claude-code', false]);
  await T.registerTab(31, 'https://a.test/31', { windowId: 7 });
  assert.equal('agentName' in (await T.getTab(31)), false);
  ok('registerTab records the agent name when there is one, nothing otherwise');

  // A record exactly as an older build writes it (no agentName / openedFrom), and that build's rewrite of a new record.
  const old = { tabId: 32, ownerPid: 4242, windowId: 7, expectedUrl: 'https://a.test/32', openedAt: 1, lastUsed: 1, takenOver: false, closeBlocked: false };
  await writeFile(path.join(T.TAB_DIR, '32.json'), JSON.stringify(old));
  r = (await T.allTabs()).find(x => x.tabId === 32);
  assert.deepEqual([r.ownerPid, r.agentName, L.ownerName(r)], [4242, undefined, 'agent（进程 4242）']);
  const rec30 = JSON.parse(await readFile(path.join(T.TAB_DIR, '30.json'), 'utf8'));
  await writeFile(path.join(T.TAB_DIR, '30.json'), JSON.stringify({ ...rec30, lastUsed: 99 }));   // old touchTab: { ...rec, lastUsed }
  assert.equal((await T.getTab(30)).agentName, 'claude-code');
  ok('older builds\' records load (pid only); their read-modify-write keeps the new fields');

  assert.equal(await T.claimTab(33, 'https://p.test/', { windowId: 7, agentName: 'a', openedFrom: 30 }), true);
  r = await T.getTab(33);
  assert.deepEqual([r.ownerPid, r.openedFrom, r.expectedUrl, r.takenOver], [process.pid, 30, 'https://p.test/', false]);
  assert.equal(await T.claimTab(33, 'https://p.test/', { ownerPid: 5555 }), false);
  assert.equal((await T.getTab(33)).ownerPid, process.pid);
  assert.equal(await T.claimTab(32, 'https://x.test/'), false);
  assert.equal((await T.getTab(32)).ownerPid, 4242, 'a claim overwrote another server\'s record');
  assert.deepEqual((await readdir(T.TAB_DIR)).filter(n => n.includes('tmp')), []);
  ok('claimTab is create-only: whoever registered the tab first keeps it; no temp files left');

  const lst = (windows) => ({ ok: true, windows });
  const before = lst([{ id: 1, tabs: [{ id: 1, url: 'https://u.test/' }] }, { id: 7, tabs: [{ id: 30, url: 'https://a.test/30' }] }]);
  const after = lst([
    { id: 1, tabs: [{ id: 1, url: 'https://u.test/' }, { id: 40, url: 'https://user-cmd-click.test/' }, { id: 41, url: 'chrome://newtab/' }] },
    { id: 7, tabs: [{ id: 30, url: 'https://a.test/30' }, { id: 42, url: 'https://blank-target.test/' }, { id: 43, url: 'about:blank' },
      { id: 44, url: 'chrome://newtab/' }, { id: 45, url: 'file:///etc/hosts' }] },
    { id: 9, tabs: [{ id: 46, url: 'https://window-open.test/' }] }
  ]);
  assert.deepEqual(T.popupCandidates(before, after, { srcWindowId: 7 }).map(n => n.tabId), [42, 43, 46]);
  ok('popup candidates: the clicked tab\'s window or a new window; web pages or loading; never the user\'s window or chrome://');
  for (const id of [30, 31, 32, 33]) await T.forgetTab(id);
}

/* ------------------------------------------------ wiring (src/index.js) */

const idx = await import('../src/index.js');
const LEDGER = idx.__ledgerForTests();
const OTHER = process.ppid;               // a live process that is not this one: "another agent"
const DEAD = 2 ** 22 + 12345;             // no such pid on macOS: "an agent that has exited"
let chrome, log;

/** Every bridge call fails loudly unless faked here: nothing may reach the real Chrome or the helper. */
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in ledger.test`); }]));
  const target = (tab) => {
    const id = tab == null ? chrome.front : Number(tab);
    for (const w of chrome.windows) {
      const t = w.tabs.find(x => x.id === id);
      if (t) return { tabId: id, windowId: w.id, url: t.url, title: t.title };
    }
    throw Object.assign(new Error('找不到标签（可能已关闭或被移到别的窗口）。请重新调用 list_tabs。'), { code: 'no_such_tab' });
  };
  return Object.assign(fake, {
    listTabs: async () => { log.push('listTabs'); return { ok: true, frontmost: chrome.frontmost || 'WeChat', chromePid: 42, windows: structuredClone(chrome.windows) }; },
    pageScript: async (kind) => kind,
    pageDialog: async () => ({ ok: true, open: false }),
    evalInPage: async (kind, tab) => {
      let t;
      try { t = target(tab); } catch (e) { const { BridgeError } = await import('../src/bridge.js'); throw new BridgeError(e.code, e.message); }
      if (kind === 'block') return { ok: true, blocked: (chrome.blocked && chrome.blocked[t.tabId]) || null, target: t };
      // chrome.brokenRead: a payload read_page chokes on after its use check (any failure from there on).
      if (kind === 'read') return chrome.brokenRead ? { ok: true, hint: 'x', target: t }
        : { ok: true, text: `=== 这一屏\n[1] 链接 ${t.title}`, count: 1, hint: '', opaque: 0, outline: [], target: t };
      if (kind === 'opener') return { ok: true, ...(chrome.openers[t.tabId] || { referrer: '', opener: false }), target: t };
      throw new Error(`unexpected page script ${kind}`);
    },
    chromeInfo: async (tab) => ({ ok: true, ...target(tab) }),
    closeTab: async (id) => { log.push(`closeTab ${id}`); for (const w of chrome.windows) w.tabs = w.tabs.filter(t => t.id !== id); return { ok: true }; },
    cgevent: async (args) => {
      if (args[0] === 'idle') {
        const ci = 'clickIdle' in chrome ? chrome.clickIdle : 100;     // undefined: an answer without clickIdle
        return { ok: true, idle: 100, ...(ci !== undefined ? { clickIdle: ci } : {}) };
      }
      throw new Error(`unexpected cgevent ${args[0]}`);
    }
  });
}
const tab = (id, url, title = `t${id}`, active = false) => ({ id, url, title, active });
async function world() {
  idx.__resetLedgerForTests();
  for (const n of await readdir(T.TAB_DIR).catch(() => [])) await rm(path.join(T.TAB_DIR, n), { force: true });
  chrome = {
    front: 1,
    clickIdle: 100,
    openers: {},
    windows: [
      { id: 1, index: 1, minimized: false, mode: 'normal', tabs: [tab(1, 'https://user.test/', 'User page', true), tab(2, 'https://user2.test/', 'User 2')] },
      { id: 7, index: 2, minimized: false, mode: 'normal', tabs: [tab(10, 'https://mine.test/a', 'Mine A', true), tab(11, 'https://codex.test/', 'Codex page'),
        tab(12, 'https://orphan.test/', 'Orphan page'), tab(13, 'https://old.test/', 'Old build page'), tab(14, 'https://stray.test/', 'Stray')] }
    ]
  };
  log = [];
  idx.__setBridgeForTests(fakeBridge());
  await T.registerTab(10, 'https://mine.test/a', { windowId: 7, agentName: 'ledger-test' });
  await T.registerTab(11, 'https://codex.test/', { windowId: 7, ownerPid: OTHER, agentName: 'codex' });
  await T.registerTab(12, 'https://orphan.test/', { windowId: 7, ownerPid: DEAD, agentName: 'gone-agent' });
  await writeFile(path.join(T.TAB_DIR, '13.json'), JSON.stringify({ tabId: 13, ownerPid: OTHER, windowId: 7, expectedUrl: 'https://old.test/',
    openedAt: 1, lastUsed: Date.now(), takenOver: false, closeBlocked: false }));
}
const call = async (name, args = {}) => {
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError };
};
const FOOT = /［你的标签有变化］/;

console.log('list_tabs: mine first, then everything, others by name');
{
  await world();
  const { text } = await call('list_tabs');
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith('MyChrome MCP 版本'), lines[0]);
  assert.equal(lines[1], '你（这个会话）的标签（1 个）：');
  assert.match(lines[2], /^ {2}tab=10 ready {2}Mine A｜https:\/\/mine\.test\/a$/);
  assert.ok(text.indexOf('你（这个会话）的标签') < text.indexOf('Chrome 共 2 个窗口'), 'my section is not first');
  assert.match(text, /tab=10 {2}Mine A {2}［你的·ready］/);
  assert.match(text, new RegExp(`tab=11 {2}Codex page {2}［另一个 agent「codex」（进程 ${OTHER}）开的］`));
  assert.match(text, new RegExp(`tab=12 {2}Orphan page {2}［无主：开它的 agent「gone-agent」（进程 ${DEAD}）已退出］`));
  assert.match(text, new RegExp(`tab=13 {2}Old build page {2}［另一个 agent（进程 ${OTHER}）开的］`));
  assert.match(text, /tab=14 {2}Stray {2}［未登记/);
  assert.match(text, /tab=1 {2}User page\n/);
  assert.doesNotMatch(text.slice(0, text.indexOf('Chrome 共')), /tab=1[1-4]/, 'another agent\'s tab is in my section');
  assert.doesNotMatch(text, FOOT, 'list_tabs carries the reminder line');
  ok('my section first; other agents\' tabs by name (an old build\'s record by pid); orphans; user and stray tabs as before');

  const m = await call('list_tabs', { mine: true });
  assert.deepEqual(m.text.split('\n'), [`你（这个会话，进程 ${process.pid}）的标签（1 个）：`, '  tab=10 ready  Mine A｜https://mine.test/a']);
  ok('list_tabs {mine:true}: only this session\'s tabs');

  // A record of mine the ledger never saw (registered by another path): adopted from the registry.
  idx.__resetLedgerForTests();
  assert.match((await call('list_tabs', { mine: true })).text, /tab=10 ready/);
  ok('a record with this process\'s pid is mine even if the ledger never saw it');
}

console.log('the reminder line: only when my tabs changed');
{
  await world();
  await call('list_tabs');
  const direct = await idx.readPage({ tab: 10 });
  const r1 = await call('read_page', { tab: 10 });
  assert.equal(r1.text, direct, 'a reply with nothing changed got extra text');
  const r2 = await call('read_page', { tab: 10 });
  assert.equal(r2.text.length - direct.length, 0);
  ok('nothing changed: 0 extra characters on the reply');

  // Another server's sweep forgot my tab (it is gone from Chrome).
  chrome.windows[1].tabs = chrome.windows[1].tabs.filter(t => t.id !== 10);
  await T.forgetTab(10);
  const r3 = await call('read_page', { tab: 11 });
  const tail3 = r3.text.split('\n').filter(l => FOOT.test(l));
  assert.deepEqual(tail3, ['［你的标签有变化］tab=10 gone·已不在']);
  const r4 = await call('read_page', { tab: 11 });
  assert.doesNotMatch(r4.text, FOOT);
  ok('my tab disappeared → one reminder on the next reply, none on the one after');

  await world();
  await call('list_tabs');
  await T.markTakenOver(10, 'user_viewing');           // e.g. another server's sweep saw the user on it
  const r5 = await call('read_page', { tab: 11 });
  assert.match(r5.text, /\n［你的标签有变化］tab=10 taken_over·别再操作「Mine A」$/);
  assert.doesNotMatch((await call('read_page', { tab: 11 })).text, FOOT);
  ok('my tab marked taken over elsewhere → reminder once');

  await world();
  await call('list_tabs');
  await call('read_page', { tab: 10 });
  idx.__ledgerForTests().apply(10, { type: 'navigated', url: 'https://mine.test/b' });   // what a navigating click of mine does
  const r6 = await call('read_page', { tab: 11 });
  assert.match(r6.text, /\n［你的标签有变化］tab=10 stale·先 read_page「Mine A」$/);
  ok('my tab went stale → reminder once');
}

console.log('a tab that is not mine, gone or taken over: the reply lists mine');
{
  await world();
  await call('list_tabs');
  const a = await call('read_page', { tab: 11 });
  assert.equal(a.isError, false);
  assert.match(a.text, /tab=11 是另一个 agent/);
  assert.match(a.text, /可读取/);
  assert.match(a.text, /键鼠操作需排队/);
  assert.match(a.text, /未经交接不要修改或关闭/);
  assert.match(a.text, /你这个会话现在可用的标签：tab=10 ready「Mine A」$/);
  assert.doesNotMatch((await call('read_page', { tab: 11 })).text,
    /tab=11 是另一个 agent|可读取|未经交接不要修改或关闭/);
  ok('another agent\'s tab: warned once, with my tabs');

  const u = await call('read_page', { tab: 2 });
  assert.match(u.text, /（tab=2 不是你这个会话开的标签。）你这个会话现在可用的标签：tab=10 ready/);
  const f = await call('read_page', {});
  assert.match(f.text, /（tab=1 不是你这个会话开的标签：没传 tab，用的是最前面的标签。）/);
  ok('the user\'s tab (also the front tab when no tab was passed): a hint with my tabs, once');

  const o = await call('read_page', { tab: 12 });
  assert.match(o.text, new RegExp(`（tab=12 是一个已退出的 agent「gone-agent」（进程 ${DEAD}）开的，不是你的。）你这个会话现在可用的标签：tab=10 ready`));
  ok('an exited agent\'s tab: said so, with my tabs');

  await world();
  await T.forgetTab(10); await T.forgetTab(11); await T.forgetTab(12); await T.forgetTab(13);
  const quiet = await call('read_page', { tab: 2 });
  assert.equal(quiet.text, await idx.readPage({ tab: 2 }), 'working on the user\'s page with no tabs of my own got a warning');
  ok('no tabs of my own: the user\'s tab gets no warning (working on the user\'s page is the point)');

  await world();
  await call('list_tabs');
  chrome.windows[1].tabs = chrome.windows[1].tabs.filter(t => t.id !== 10);
  const g = await call('read_page', { tab: 10 });
  assert.equal(g.isError, true);
  assert.match(g.text, /tab=10 是你的标签，但它已经不在 Chrome 里了。你这个会话当前没有登记为可用的自有标签；先 list_tabs 查找用户指定的现有标签，再 read_page 查看。继续输入前确认交接，不要直接新开标签。/);
  assert.doesNotMatch(g.text, FOOT, 'the gone tab was told twice');
  assert.equal(LEDGER.get(10), null, 'the gone tab stayed in the ledger after it was reported');
  ok('a gone tab of mine: the error says so and what I can use instead');

  await world();
  await call('list_tabs');
  const w = await call('read_page', { tab: 999 });
  assert.equal(w.isError, true);
  assert.equal((w.text.match(/你这个会话现在可用的标签/g) || []).length, 1, w.text);
  assert.doesNotMatch(w.text, /tab=999 是你的标签|tab=999 不是你这个会话开的标签/);
  for (const id of [10, 11, 12, 13]) await T.forgetTab(id);
  idx.__resetLedgerForTests();
  const w2 = await call('read_page', { tab: 998 });
  assert.equal(w2.text, '找不到标签（可能已关闭或被移到别的窗口）。请重新调用 list_tabs。', 'no tabs of my own: the error got ledger text');
  ok('a wrong tab id: my usable tabs listed once; with no tabs of my own nothing is added');

  await world();
  await call('list_tabs');
  await T.registerTab(15, 'https://mine.test/elsewhere', { windowId: 7 });
  chrome.windows[1].tabs.push(tab(15, 'https://user-went.test/', 'Moved on'));
  const t = await call('read_page', { tab: 15 });
  assert.match(t.text, /（tab=15 是你这个会话开的 agent 标签，已标记为「可能已被用户接手」。可能被用户动过（它现在的网址不是 agent 打开或点出来的）：先 read_page\(tab=15\) 看现在的页面；确认用户已交回后在这个标签继续，未确认时先问用户。不要另开标签替代；它不会再被自动关闭。）/);
  assert.doesNotMatch(t.text, /你这个会话现在可用的标签/, 'a takeover that may be a slow navigation pushed the agent to its other tabs');
  assert.doesNotMatch(t.text, FOOT, 'the takeover was told twice');
  assert.equal(LEDGER.get(15).state, 'taken_over');
  ok('my tab found taken over when used (URL not the agent\'s): one note — read it first; no second reminder');

  await T.registerTab(16, 'https://mine.test/16', { windowId: 7 });
  chrome.windows[0].tabs.push(tab(16, 'https://mine.test/16', 'Dragged'));     // now in the user's window 1
  const d = await call('read_page', { tab: 16 });
  assert.match(d.text, /（tab=16 是你这个会话开的 agent 标签，已标记为「可能已被用户接手」。可能已被用户接手（它被移到了别的窗口）：先不要点击、输入或关闭；可 read_page 查看现状。用户明确交回后在原标签继续，不要另开标签替代。你这个会话现在可用的标签：tab=10 ready「Mine A」）/);
  assert.doesNotMatch(d.text, FOOT);
  ok('my tab dragged into another window: leave it, with my other tabs');

  // A failure after the use check: the note never reaches a reply, so the reminder line carries it.
  await T.registerTab(17, 'https://mine.test/17', { windowId: 7 });
  chrome.windows[1].tabs.push(tab(17, 'https://user-went-17.test/', 'Elsewhere'));
  chrome.brokenRead = true;
  const L17 = await call('read_page', { tab: 17 });
  chrome.brokenRead = false;
  assert.equal(L17.isError, true, L17.text);
  assert.doesNotMatch(L17.text, /已标记为「可能已被用户接手」/);
  assert.match(L17.text, /\n［你的标签有变化］tab=17 taken_over·先 read_page 确认「Elsewhere」/);
  ok('a takeover found by a call that then fails: the reminder line says it (the note never reached a reply)');
}

console.log('close_tab and the ledger');
{
  await world();
  await call('list_tabs');
  const x = await call('close_tab', { tab: 11 });
  assert.equal(x.isError, true);
  assert.match(x.text, new RegExp(`❌ 标签 11 是另一个 agent「codex」（进程 ${OTHER}）开的，不是你的，没有关闭。你这个会话现在可用的标签：tab=10 ready`));
  assert.ok(!log.includes('closeTab 11'), 'another agent\'s tab was closed');
  ok('close_tab refuses another live agent\'s tab and lists mine');

  const y = await call('close_tab', { tab: 2 });
  assert.match(y.text, /不是 agent 用 open_tab 打开的，不会关闭它（用户自己开的标签一律不动）。你这个会话现在可用的标签：tab=10/);
  assert.ok(!log.includes('closeTab 2'));
  ok('close_tab on the user\'s tab: refused as before, now with my tabs');

  const z = await call('close_tab', { tab: 12 });
  assert.match(z.text, /✅ 已关闭 agent 标签 12/);
  ok('an exited agent\'s tab may still be closed (as before)');

  const c = await call('close_tab', { tab: 10 });
  assert.match(c.text, /^✅ 已关闭 agent 标签 10（已确认它不在了）$/);
  assert.equal(LEDGER.get(10), null);
  assert.match((await call('list_tabs', { mine: true })).text, /的标签：没有。/);
  ok('close_tab → closed: the reply says it, no reminder; my section is empty afterwards');
}

console.log('popups: a tab my click opened is registered to me');
{
  const before = () => ({ ok: true, windows: structuredClone(chrome.windows) });
  const prep = { target: { tabId: 10, windowId: 7 } };
  const obsOk = { noteable: true, since: Date.now() - 1000,
    untouched: async () => Number.isFinite(chrome.clickIdle) && chrome.clickIdle > 0 };
  const SRC = 'https://mine.test/a';
  const claim = (b, p = prep, o = obsOk, src = SRC) => idx.__claimPopupsForTests(b, before(), p, o, src);
  const ids = (r) => r.mine.map(n => n.tabId);

  await world();
  await call('list_tabs');
  let b = before();
  chrome.windows[1].tabs.push(tab(20, 'https://popup.test/landing', 'Popup'));
  chrome.windows[0].tabs.push(tab(21, 'https://user-side.test/', 'User side'));
  chrome.openers[20] = { referrer: 'https://mine.test/', opener: false };
  chrome.openers[21] = { referrer: 'https://mine.test/', opener: false };
  let got = await claim(b);
  assert.deepEqual(ids(got), [20]);
  let r = await T.getTab(20);
  assert.deepEqual([r.ownerPid, r.openedFrom, r.agentName, r.expectedUrl, r.windowId], [process.pid, 10, 'ledger-test', 'https://popup.test/landing', 7]);
  assert.deepEqual([r.popup, r.proof], [true, 'site']);
  const names = await readdir(T.TAB_DIR);
  assert.ok(names.includes('20.popup.json') && !names.includes('20.json'), names.join(','));
  // What an older build reads (src/tabs.js before the ledger: /^\d+\.json$/): not this popup, so it never sweeps it.
  assert.ok(!names.filter(n => /^\d+\.json$/.test(n)).includes('20.json'));
  assert.equal(await T.getTab(21), null, 'a tab in the user\'s window was registered');
  assert.deepEqual([LEDGER.get(20).state, LEDGER.get(20).from], ['ready', 10]);
  const n = await call('read_page', { tab: 10 });
  assert.match(n.text, /\n［你的标签有变化］tab=20 ready（tab=10 点出）「Popup」；tab=10 ready「Mine A」$/);
  ok('click on my tab opened a tab in its window (referrer: the clicked page\'s site) → registered to me (from tab 10), ready, reminder once');

  await world();
  await call('list_tabs');
  b = before();
  chrome.windows[1].tabs.push(tab(24, 'https://popup.test/', 'P'));
  chrome.openers[24] = { referrer: '', opener: true };
  assert.deepEqual(ids(await claim(b)), [24]);
  ok('a window.open popup with an opener (no referrer) is registered too');

  await world();
  await call('list_tabs');
  b = before();
  chrome.windows[1].tabs.push(tab(22, 'https://popup.test/', 'P'));
  chrome.openers[22] = { referrer: 'https://mine.test/', opener: false };
  const none = { mine: [], theirs: [] };
  assert.deepEqual(await claim(b, { target: { tabId: 11, windowId: 7 } }), none);
  assert.deepEqual(await claim(b, { target: { tabId: 1, windowId: 1 } }), none);
  assert.deepEqual(await claim(b, prep, { noteable: false }), none);
  assert.deepEqual(await claim(b, prep, { noteable: true, since: null }), none);
  chrome.clickIdle = 0;
  assert.deepEqual(ids(await claim(b)), []);
  chrome.clickIdle = undefined;                         // the helper did not say: counts as clicked
  assert.deepEqual(ids(await claim(b)), []);
  chrome.clickIdle = 100;
  chrome.openers[22] = { referrer: '', opener: false };   // `open <url>` from another program, a noreferrer link
  assert.deepEqual(ids(await claim(b)), []);
  chrome.openers[22] = { referrer: 'https://elsewhere.test/', opener: false };
  assert.deepEqual(ids(await claim(b)), []);
  assert.equal(await T.getTab(22), null);
  chrome.openers[22] = { referrer: 'https://mine.test/', opener: false };
  await T.registerTab(22, 'https://popup.test/', { windowId: 7, ownerPid: OTHER, agentName: 'codex' });
  assert.deepEqual((await claim(b)).theirs.map(x => x.tabId), [22]);
  assert.equal((await T.getTab(22)).ownerPid, OTHER);
  assert.equal(LEDGER.get(22), null);
  ok('not registered: a click on someone else\'s / the user\'s tab, a click the user interrupted or clicked after (or unknown), ' +
    'a hand-over to the next agent, a tab with no opener and no referrer of the clicked site, a tab another server registered first (said so)');

  await world();
  await call('list_tabs');
  b = before();
  chrome.windows[1].tabs.push(tab(25, 'https://download.test/file.csv', 'dl'));
  chrome.openers[25] = { referrer: 'https://mine.test/', opener: false };
  const p = claim(b);
  chrome.windows[1].tabs = chrome.windows[1].tabs.filter(t => t.id !== 25);   // a download tab that closes itself
  assert.deepEqual(ids(await p), []);
  assert.equal(await T.getTab(25), null);
  ok('not registered: a tab that closed itself before it could be checked (download)');

  await world();
  await call('list_tabs');
  await T.markTakenOver(10, 'user_viewing');
  b = before();
  chrome.windows[1].tabs.push(tab(23, 'https://popup.test/', 'P'));
  chrome.openers[23] = { referrer: 'https://mine.test/', opener: false };
  assert.deepEqual(ids(await claim(b)), []);
  ok('not registered: a click on my tab the user may have taken over');
}

console.log('wait_for_user hands my tab to the user: afterwards, wait for explicit continuation, then read it');
{
  await world();
  await call('list_tabs');
  idx.__setWaitPollForTests(20);
  setTimeout(async () => {
    await T.markTakenOver(10, 'user_viewing');           // another server's sweep saw the user on it while logging in
    chrome.windows[1].tabs.find(t => t.id === 10).url = 'https://mine.test/dashboard';
  }, 50);
  const wr = await call('wait_for_user', { tab: 10, reason: '请在这个页面登录', minutes: 0.05 });
  // Observation ends without a chat reply; instructions require explicit continuation, without dropping the tab.
  assert.equal(wr.text, wr.text.split('\n')[0]);
  assert.match(wr.text, /^✅ 页面已经变了（mine\.test），等了 \d+ 秒。/);
  assert.match(wr.text, /本次观察已结束，这不代表收到继续授权。若用户尚未在本次交接后于原对话明确说“继续”，先等待；收到后先 read_page 核对同一页面，再恢复原任务/);
  assert.equal(LEDGER.get(10).state, 'taken_over');
  assert.match((await call('list_tabs', { mine: true })).text, /tab=10 taken_over .*\n {6}→ 用户按你的请求（wait_for_user）处理过它/);
  const rp = await call('read_page', { tab: 10 });
  assert.doesNotMatch(rp.text, /别再操作/);
  assert.match(rp.text, /（tab=10 是你这个会话开的 agent 标签，已标记为「可能已被用户接手」。用户按你的请求（wait_for_user）处理过它，这不代表收到继续授权：若用户尚未在本次交接后于原对话明确说“继续”，先等待；收到后先 read_page\(tab=10\) 核对同一页面，再恢复原任务；它不会再被自动关闭。）/);
  idx.__setWaitPollForTests(3000);
  ok('after wait_for_user the takeover marks do not tell the agent to drop its tab');
}

console.log('Codex A1: list_tabs checks this session\'s tabs for takeover before showing them');
{
  // The user dragged my tab into their window; no sweep has run yet.
  await world();
  await call('list_tabs', { mine: true });
  const t10 = chrome.windows[1].tabs.find(t => t.id === 10);
  chrome.windows[1].tabs = chrome.windows[1].tabs.filter(t => t.id !== 10);
  chrome.windows[0].tabs.push({ ...t10, active: false });
  const m = await call('list_tabs', { mine: true });
  assert.match(m.text, /\n {2}tab=10 taken_over {2}Mine A｜https:\/\/mine\.test\/a\n {6}→ 可能已被用户接手（它被移到了别的窗口）：先不要点击、输入或关闭/);
  const full = await call('list_tabs');
  assert.match(full.text, /tab=10 {2}Mine A {2}［你的·taken_over］/);
  assert.match(full.text, /\n {2}tab=10 taken_over /);
  const r = await T.getTab(10);
  assert.deepEqual([r.takenOver, r.takenOverWhy], [true, 'moved_window']);
  ok('dragged into another window: list_tabs {mine:true} says taken_over at once (and persists it), list_tabs says the same');

  await world();
  const t = chrome.windows[1].tabs.find(x => x.id === 10);
  chrome.windows[1].tabs = chrome.windows[1].tabs.filter(x => x.id !== 10);
  chrome.windows[0].tabs.push({ ...t, active: false });
  const f2 = await call('list_tabs');
  assert.match(f2.text, /\n {2}tab=10 taken_over .*\n {6}→ 可能已被用户接手（它被移到了别的窗口）/);
  assert.match((await call('list_tabs', { mine: true })).text, /tab=10 taken_over/);
  ok('the same with the full list_tabs first');

  // The user is looking at it: Chrome in front, my tab the active one of the front window, no input lock, a click since.
  await world();
  chrome.frontmost = 'Google Chrome';
  chrome.windows[0].index = 2; chrome.windows[1].index = 1;
  chrome.clickIdle = 0;
  await mkdir(process.env.CHROME_BRIDGE_LOCK);
  await writeFile(path.join(process.env.CHROME_BRIDGE_LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  // An input lock held across the listing (an action of mine may be navigating the tab, not yet recorded): no conclusion.
  const t10b = chrome.windows[1].tabs.find(x => x.id === 10);
  t10b.url = 'https://mine.test/navigating';
  const held = await call('list_tabs', { mine: true });
  assert.doesNotMatch(held.text, /taken_over/);
  assert.equal((await T.getTab(10)).takenOver, false);
  t10b.url = 'https://mine.test/a';
  await rm(process.env.CHROME_BRIDGE_LOCK, { recursive: true });
  const v = await call('list_tabs', { mine: true });
  assert.match(v.text, /tab=10 taken_over .*\n {6}→ 可能已被用户接手（用户当时正在看它）/);
  assert.equal((await T.getTab(10)).takenOverWhy, 'user_viewing');
  ok('the user looking at it (no input lock held) → taken_over; while an input lock is held nothing is concluded');
}

console.log('Codex B2: a claimed popup is never closed by a sweep; only its owner\'s close_tab closes it');
{
  const NOW = Date.now();
  const recP = (id, owner, x = {}) => ({ tabId: id, ownerPid: owner, windowId: 7, expectedUrl: `https://p.test/${id}`, openedAt: 0, lastUsed: 0,
    takenOver: false, closeBlocked: false, popup: true, ...x });
  const existing = new Set([30, 31, 32]);
  const d = T.decideSweep([recP(30, process.pid), recP(31, DEAD), recP(32, OTHER), recP(33, process.pid)], existing, null,
    { now: NOW, ttlMs: 1000, exitingPid: process.pid, isAlive: (p) => p !== DEAD });
  assert.deepEqual([d.close.map(x => x.tabId), d.drop.map(x => x.tabId)], [[], [33]]);
  ok('decideSweep: a popup idle past the TTL, of the exiting session, or of an exited agent is not closed; a gone one is unregistered');

  await world();
  await T.claimTab(40, 'https://p.test/40', { windowId: 7, openedFrom: 10, proof: 'source' });
  await T.claimTab(41, 'https://p.test/41', { windowId: 7, openedFrom: 12, ownerPid: DEAD, proof: 'site' });
  chrome.windows[1].tabs.push(tab(40, 'https://p.test/40', 'P40'), tab(41, 'https://p.test/41', 'P41'));
  const fc = { listTabs: async () => ({ ok: true, frontmost: 'WeChat', chromePid: 42, windows: structuredClone(chrome.windows) }),
    closeTab: async (id) => { log.push(`closeTab ${id}`); }, clickedSince: async () => true };
  await T.sweepTabs({ ...fc, exitingPid: process.pid, now: Date.now() + 3_600_000, isAlive: (p) => p !== DEAD,
    lockDir: process.env.CHROME_BRIDGE_LOCK });
  assert.ok(!log.includes('closeTab 40') && !log.includes('closeTab 41'), log.join(','));
  assert.ok((await T.getTab(40)) && (await T.getTab(41)));
  ok('sweepTabs (session end, an hour idle, owner gone): popups stay open and registered');

  const x = await call('close_tab', { tab: 41 });
  assert.match(x.text, new RegExp(`❌ 标签 41 是一个已退出的 agent（进程 ${DEAD}）点击弹出的，只有它自己能关，没有关闭`));
  assert.ok(!log.includes('closeTab 41'));
  const y = await call('close_tab', { tab: 40 });
  assert.match(y.text, /^✅ 已关闭 agent 标签 40/);
  assert.equal(await T.getTab(40), null);
  assert.ok(!(await readdir(T.TAB_DIR)).includes('40.popup.json'));
  ok('close_tab: the owner closes its popup (record removed); an exited agent\'s popup is left to the user');

  const full = await call('list_tabs');
  assert.match(full.text, new RegExp(`tab=41 {2}P41 {2}［无主：开它的 agent（进程 ${DEAD}）已退出；点击弹出，不会被自动关］`));
  ok('list_tabs says an exited agent\'s popup is not closed automatically');

  const P = idx.popupProof;
  const src = 'https://mine.test/list?p=2#top';
  assert.equal(P({ referrer: 'https://mine.test/list?p=2', opener: false, openerUrl: '' }, src), 'source');
  assert.equal(P({ referrer: '', opener: true, openerUrl: 'https://mine.test/list?p=2#top' }, src), 'source');
  assert.equal(P({ referrer: 'https://mine.test/', opener: false, openerUrl: '' }, src), 'site');
  assert.equal(P({ referrer: '', opener: true, openerUrl: '' }, src), 'opener');
  assert.equal(P({ referrer: 'https://elsewhere.test/', opener: false, openerUrl: '' }, src), null);
  assert.equal(P({ referrer: '', opener: false, openerUrl: '' }, src), null);
  ok('popup proof: the clicked page itself (opener URL or referrer, fragment aside) > its site > an opener; nothing → not claimed');
}

console.log('Codex B3: wait_for_user\'s help counts only for a real wait, and a later takeover wins');
{
  // A call that did not wait (nothing on the page, no reason) hands nothing to the user.
  await world();
  await call('list_tabs');
  const nw = await call('wait_for_user', { tab: 10 });
  assert.match(nw.text, /^现在页面上没有验证码或拦截，不需要等/);
  assert.equal(LEDGER.get(10).helped ?? null, null);
  const t10 = chrome.windows[1].tabs.find(t => t.id === 10);
  chrome.windows[1].tabs = chrome.windows[1].tabs.filter(t => t.id !== 10);
  chrome.windows[0].tabs.push({ ...t10, active: false });
  assert.match((await call('list_tabs', { mine: true })).text, /→ 可能已被用户接手（它被移到了别的窗口）：先不要点击、输入或关闭/);
  ok('a wait_for_user that returned without waiting: a later drag still says leave it');

  // A real wait, then the user drags the tab away afterwards: that newer takeover wins over the help.
  await world();
  await call('list_tabs');
  idx.__setWaitPollForTests(20);
  setTimeout(() => { chrome.windows[1].tabs.find(t => t.id === 10).url = 'https://mine.test/dashboard'; }, 40);
  const wr = await call('wait_for_user', { tab: 10, reason: '请在这个页面登录', minutes: 0.05 });
  idx.__setWaitPollForTests(3000);
  assert.match(wr.text, /^✅ 页面已经变了/);
  const h = LEDGER.get(10).helped;
  assert.ok(h && typeof h.until === 'number', JSON.stringify(h));
  await new Promise(r => setTimeout(r, 5));
  const t = chrome.windows[1].tabs.find(x => x.id === 10);
  chrome.windows[1].tabs = chrome.windows[1].tabs.filter(x => x.id !== 10);
  chrome.windows[0].tabs.push({ ...t, active: false });
  const after = await call('list_tabs', { mine: true });
  assert.match(after.text, /tab=10 taken_over .*\n {6}→ 可能已被用户接手（它被移到了别的窗口）：先不要点击、输入或关闭/);
  assert.doesNotMatch(after.text, /用户按你的请求/);
  // Used, not listed: the use check sees the move too.
  await world();
  await call('list_tabs');
  LEDGER.mark(10, { helped: { since: 1, until: 2 } });
  await T.markTakenOver(10, 'url_changed', 1);            // during that wait: helped
  const u = chrome.windows[1].tabs.find(x => x.id === 10);
  chrome.windows[1].tabs = chrome.windows[1].tabs.filter(x => x.id !== 10);
  chrome.windows[0].tabs.push({ ...u, active: false });
  const rp = await call('read_page', { tab: 10 });
  assert.match(rp.text, /可能已被用户接手（它被移到了别的窗口）：先不要点击、输入或关闭/);
  ok('a real wait, then a drag after it ended: the drag wins ("leave it"), in list_tabs and when the tab is used');

  assert.equal(L.nextTabState({ tabId: 1, state: 'taken_over', why: 'user_viewing', helped: { since: 1, until: 10 } },
    { type: 'takeover', why: 'user_viewing', seenAt: 5 }).helped.until, 10);
  assert.equal(L.nextTabState({ tabId: 1, state: 'taken_over', why: 'url_changed', helped: { since: 1, until: 10 } },
    { type: 'takeover', why: 'url_changed', seenAt: 50 }).helped.until, 10);
  const won = L.nextTabState({ tabId: 1, state: 'taken_over', why: 'url_changed', helped: { since: 1, until: 10 } },
    { type: 'takeover', why: 'user_viewing', seenAt: 50 });
  assert.deepEqual([won.why, won.helped, L.takeoverKind(won)], ['user_viewing', null, 'leave']);
  assert.equal(L.isNews({ state: 'taken_over', helped: { until: 10 } }, won, { type: 'takeover' }), true);
  ok('pure: a takeover seen during the wait keeps the help; a URL change after it too; a drag / viewing after it ends it (news)');
}

console.log('Codex r2 B1: after a wait, a click after it ended means the user is on it; clicks during it do not');
{
  const front10 = () => { chrome.frontmost = 'Google Chrome'; chrome.windows[0].index = 2; chrome.windows[1].index = 1; };
  // Login redirect: the wait ends on a URL the agent did not open, with the user still on the tab.
  await world();
  await call('list_tabs');
  await T.noteAgentDone(10, 1);                          // the agent's last action long ago: every click below is after it
  front10();
  chrome.clickIdle = 1;                                  // the user's last click: before the wait ended (logging in)
  idx.__setWaitPollForTests(20);
  setTimeout(() => { chrome.windows[1].tabs.find(t => t.id === 10).url = 'https://mine.test/dashboard'; }, 40);
  const wr = await call('wait_for_user', { tab: 10, reason: '请在这个页面登录', minutes: 0.05 });
  idx.__setWaitPollForTests(3000);
  assert.match(wr.text, /^✅ 页面已经变了/);
  const during = await call('list_tabs', { mine: true });
  assert.match(during.text, /tab=10 taken_over .*\n {6}→ 用户按你的请求（wait_for_user）处理过它，这不代表收到继续授权：若用户尚未在本次交接后于原对话明确说“继续”，先等待；收到后先 read_page/);
  await new Promise(r => setTimeout(r, 5));
  chrome.clickIdle = 0;                                  // a click after the wait: the user is using the page now
  const after = await call('list_tabs', { mine: true });
  assert.match(after.text, /tab=10 taken_over .*\n {6}→ 可能已被用户接手（用户当时正在看它）：先不要点击、输入或关闭/);
  assert.doesNotMatch(after.text, /用户按你的请求/);
  ok('login redirect keeps explicit continuation instructions; a click after the wait wins over url_changed ("leave it")');

  // A check solved in place (the URL stays): the clicks that solved it do not make the tab the user's.
  await world();
  await call('list_tabs');
  await T.noteAgentDone(10, 1);
  front10();
  chrome.clickIdle = 1;
  chrome.blocked = { 10: { kind: 'captcha', vendor: 'test', evidence: '验证码' } };
  idx.__setWaitPollForTests(20);
  setTimeout(() => { chrome.blocked = {}; }, 40);
  const cr = await call('wait_for_user', { tab: 10, minutes: 0.05 });
  idx.__setWaitPollForTests(3000);
  assert.match(cr.text, /^✅ 验证\/拦截已经没有了/);
  const solved = await call('list_tabs', { mine: true });
  assert.match(solved.text, /tab=10 ready/);
  assert.doesNotMatch(solved.text, /别再操作/);
  assert.equal((await T.getTab(10)).takenOver, false);
  ok('a check solved in place: the tab stays ready for the agent (clicks during the wait are not "the user is on it")');
}

console.log('drop: a tab another server took over in the registry');
{
  await world();
  await call('list_tabs');
  await T.registerTab(10, 'https://mine.test/a', { windowId: 7, ownerPid: OTHER, agentName: 'codex' });
  const dr = await call('read_page', { tab: 2 });     // the user's tab: no warning, as this session has no tab left
  assert.equal(dr.text, await idx.readPage({ tab: 2 }), 'a dropped tab left text (an empty reminder line) on the reply');
  assert.equal(LEDGER.get(10), null);
  ok('a tab that became another server\'s leaves my ledger quietly (no empty reminder line)');
}

console.log('over MCP (in-memory transport): the client\'s own name goes on the tabs it opens');
{
  await world();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const fake = fakeBridge();
  Object.assign(fake, {
    ensureScreenAwake: async () => ({ woke: false, displays: 1, locked: false }),
    openNavigationObserver: async () => ({
      startedAt: Date.now(), untouched: async () => true, close: async () => {},
    }),
    profiles: async () => ({ ok: true, default: 'Default', profiles: [{ dir: 'Default', name: 'Me', user: 'me@test' }] }),
    openTab: async (url, windowId, o) => {
      log.push(`openTab ${url} ${windowId} select=${!!(o && o.select)}`);
      chrome.windows.find(w => w.id === Number(windowId)).tabs.push(tab(50, url, 'New'));
      return { ok: true, tabId: 50, windowId: Number(windowId), selected: true };
    }
  });
  idx.__setBridgeForTests(fake);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await idx.__connectForTests(serverSide);
  const client = new Client({ name: 'clientinfo-test', version: '1' }, { capabilities: {} });
  await client.connect(clientSide);
  const envName = process.env.CHROME_BRIDGE_AGENT_NAME;
  delete process.env.CHROME_BRIDGE_AGENT_NAME;
  try {
    const o = await client.callTool({ name: 'open_tab', arguments: { url: 'https://new.test/', why: 'user_asked' } });
    assert.match(o.content[0].text, /新开标签 tab=50/);
    assert.doesNotMatch(o.content[0].text, FOOT, 'open_tab carried the reminder line');
    assert.ok(log.includes('openTab https://new.test/ 7 select=true'), log.join(','));
    const rec = await T.getTab(50);
    assert.deepEqual([rec.ownerPid, rec.agentName, rec.windowId], [process.pid, 'clientinfo-test', 7]);
    const m = await client.callTool({ name: 'list_tabs', arguments: { mine: true } });
    assert.deepEqual(m.content[0].text.split('\n').slice(1).map(l => l.replace(/^( {2}tab=\d+ \w+).*$/, '$1')), ['  tab=10 ready', '  tab=50 ready']);
  } finally {
    process.env.CHROME_BRIDGE_AGENT_NAME = envName;
    await client.close();
  }
  ok('open_tab through the MCP handler records the MCP client\'s name (no CHROME_BRIDGE_AGENT_NAME); list_tabs {mine:true} over MCP lists it');
}

await rm(tmp, { recursive: true, force: true });
console.log(`\nledger tests passed (${passed}).`);
