#!/usr/bin/env node
/* The panel's settings, presence files and activity log (src/settings.js, src/menubar.swift pages
 * 「状态 / 设置 / 记录」): precedence env > file > default, strict JSON types, a change applying without a
 * restart, the panel (bin/cbmenu) reading the same values as the server, the pause switch stopping
 * input-capable requests before anything reaches Chrome while allowing status/stop queries, and the activity log keeping host names
 * only (never typed text, paths or queries). Everything lives in a temp directory; Chrome is faked. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-settings-test-'));
const SETTINGS_FILE = path.join(tmp, 'support', 'settings.json');
const ACTIVITY_FILE = path.join(tmp, 'support', 'activity.jsonl');
Object.assign(process.env, {
  CHROME_BRIDGE_SETTINGS: SETTINGS_FILE, CHROME_BRIDGE_ACTIVITY: ACTIVITY_FILE,
  CHROME_BRIDGE_ROUTINES_DIR: path.join(tmp, 'routines'),
  CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'), CHROME_BRIDGE_LOCK: path.join(tmp, 'lock', 'input.lock'),
  CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'agent-window.json'), CHROME_BRIDGE_AGENT_NAME: 'settings-test', CHROME_BRIDGE_HABITS: 'off'
});
for (const k of ['CHROME_BRIDGE_AGENT_DISPLAY', 'CHROME_BRIDGE_IDLE_S', 'CHROME_BRIDGE_TAB_TTL_MIN', 'CHROME_BRIDGE_NOTIFY',
  'CHROME_BRIDGE_INPUT_MODE', 'CHROME_BRIDGE_INPUT_SPEED',
  'CODEX_THREAD_ID', 'MYCHROME_VISIBLE_THREAD_ID', 'MYCHROME_VISIBLE_SOCKET']) delete process.env[k];
await mkdir(path.join(tmp, 'lock'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CBMENU = process.env.CBMENU_BIN || path.join(ROOT, 'bin', 'cbmenu');
const S = await import('../src/settings.js');
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
/** Write the file as the panel would (compact JSON) and make sure the mtime moves even within one clock tick. */
let tick = 0;
async function putFile(o) {
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  // Each case starts fresh, including this fixture's independent pause tokens.
  // A direct JSON false is intentionally insufficient to resume production.
  await writeFile(SETTINGS_FILE, '{}');
  S.writeSettings({ paused: false });
  await writeFile(SETTINGS_FILE, typeof o === 'string' ? o : JSON.stringify(o));
  const t = new Date(Date.now() + (++tick) * 1000);
  await utimes(SETTINGS_FILE, t, t);
}
const panelReads = () => JSON.parse(execFileSync(CBMENU, ['--read-settings'], { encoding: 'utf8', env: process.env }));
const serverReads = () => Object.fromEntries(Object.keys(S.SETTINGS).map(k => [k, S.get(k)]));

console.log('settings: precedence and types');
{
  assert.deepEqual(serverReads(), { paused: false, agentDisplay: 'away', idleSeconds: 1.5, tabIdleMinutes: 10, notify: true, activityLog: true, inputMode: 'auto', inputSpeed: 1 });
  assert.equal(S.setting('idleSeconds').source, 'default');
  ok('no file: every setting is its default');
}
{
  await putFile({ paused: true, agentDisplay: 'main', idleSeconds: 3, tabIdleMinutes: 0, notify: false, activityLog: false });
  assert.deepEqual(serverReads(), { paused: true, agentDisplay: 'main', idleSeconds: 3, tabIdleMinutes: 0, notify: false, activityLog: false, inputMode: 'auto', inputSpeed: 1 });
  assert.equal(S.setting('agentDisplay').source, 'file');
  await putFile({ idleSeconds: 5 });
  assert.equal(S.get('idleSeconds'), 5);
  assert.equal(S.get('paused'), false);
  ok('the file is read again when it changes (no restart): every key, and a key removed is the default again');
}
{
  // 1 is not true, "3" is not 3, out of range and unknown values are the default: the panel reads them the same way.
  await putFile({ paused: 1, notify: 'false', idleSeconds: '3', tabIdleMinutes: -5, agentDisplay: 'left', activityLog: null });
  assert.deepEqual(serverReads(), { paused: false, agentDisplay: 'away', idleSeconds: 1.5, tabIdleMinutes: 10, notify: true, activityLog: true, inputMode: 'auto', inputSpeed: 1 });
  await putFile('{ broken');
  assert.equal(S.get('paused'), false);
  await putFile('[true]');
  assert.equal(S.get('paused'), false);
  ok('mistyped, out-of-range, unknown values and a broken file: defaults, never an error');
}
{
  await putFile({ agentDisplay: 'main', idleSeconds: 3, notify: true });
  const env = { ...process.env, CHROME_BRIDGE_AGENT_DISPLAY: 'off', CHROME_BRIDGE_IDLE_S: 'abc', CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_TAB_TTL_MIN: '0' };
  assert.deepEqual(S.setting('agentDisplay', env), { value: 'off', source: 'env' });
  assert.deepEqual(S.setting('idleSeconds', env), { value: 3, source: 'file' });     // a bad env value is ignored
  assert.deepEqual(S.setting('notify', env), { value: false, source: 'env' });
  assert.deepEqual(S.envLocked(env), { agentDisplay: 'off', notify: false, tabIdleMinutes: 0 });
  assert.deepEqual(S.envLocked({ ...env, CHROME_BRIDGE_AGENT_DISPLAY: '', CHROME_BRIDGE_NOTIFY: ' ', CHROME_BRIDGE_TAB_TTL_MIN: undefined }), {});
  ok('a CHROME_BRIDGE_* variable wins over the file and is reported as fixed (with its value); empty or bad ones do not count');
}
{
  await putFile({ agentDisplay: 'secondary', future: { x: 1 } });
  S.writeSettings({ paused: true, idleSeconds: 5 });
  const j = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
  assert.deepEqual(j, { version: 1, agentDisplay: 'secondary', future: { x: 1 }, paused: true, idleSeconds: 5 });
  assert.throws(() => S.writeSettings({ nope: 1 }), /unknown setting/);
  assert.throws(() => S.writeSettings({ idleSeconds: 0 }), /bad value/);
  assert.throws(() => S.writeSettings({ paused: 'yes' }), /bad value/);
  assert.equal(S.get('paused'), true);
  ok('writeSettings keeps the other keys (also ones it does not know) and refuses unknown keys and bad values');
}

console.log('settings: the panel reads what the server reads');
{
  const cases = [
    {},
    { paused: true, agentDisplay: 'off', idleSeconds: 0.5, tabIdleMinutes: 1440, notify: false, activityLog: false },
    { paused: 1, notify: 0, activityLog: 'true', idleSeconds: true, tabIdleMinutes: '30', agentDisplay: 'Main' },
    { idleSeconds: 0.4, tabIdleMinutes: 1441 },
    { idleSeconds: 10, tabIdleMinutes: 0, agentDisplay: 'secondary' },
    '{ broken',
    'null'
  ];
  for (const c of cases) {
    await putFile(c);
    assert.deepEqual(panelReads(), serverReads(), `file ${JSON.stringify(c)}`);
  }
  ok(`bin/cbmenu --read-settings equals src/settings.js on ${cases.length} files (valid, mistyped, out of range, broken)`);
}
{
  await putFile({ agentDisplay: 'main', keep: 'me' });
  execFileSync(CBMENU, ['--write-setting', 'paused', 'true'], { env: process.env });
  execFileSync(CBMENU, ['--write-setting', 'idleSeconds', '3'], { env: process.env });
  await utimes(SETTINGS_FILE, new Date(Date.now() + (++tick) * 1000), new Date(Date.now() + tick * 1000));
  assert.equal(S.get('paused'), true);
  assert.equal(S.get('idleSeconds'), 3);
  assert.equal(S.get('agentDisplay'), 'main');
  assert.equal(JSON.parse(await readFile(SETTINGS_FILE, 'utf8')).keep, 'me');
  ok('what the panel writes, the server reads (true stays a boolean, 3 a number; other keys kept)');
}

console.log('settings: the server uses them');
{
  const T = await import('../src/tabs.js');
  const idx = await import('../src/index.js');
  await putFile({ tabIdleMinutes: 30 });
  assert.equal(T.tabTtlMs(), 30 * 60_000);
  await putFile({ tabIdleMinutes: 0 });
  assert.equal(T.tabTtlMs(), Infinity);
  const rec = { tabId: 5, ownerPid: process.pid, lastUsed: 0 };
  assert.equal(T.decideSweep([rec], new Set([5]), null, { now: 1e13 }).close.length, 0);
  await putFile({ tabIdleMinutes: 10 });
  assert.equal(T.decideSweep([rec], new Set([5]), null, { now: 1e13 }).close[0].reason, 'idle');
  ok('agent tabs: closed after the minutes set; 0 = never by age (the sweep reads it each time)');

  const d = (id, isMain, x) => ({ id, isMain, boundsPoints: { x, y: 0, w: 1000, h: 800 } });
  const displays = [d(1, true, 0), d(2, false, 1000)], onMain = { x: 10, y: 10 };
  await putFile({ agentDisplay: 'away' });
  assert.equal(idx.pickAgentDisplay(displays, onMain).id, 2);
  await putFile({ agentDisplay: 'main' });
  assert.equal(idx.pickAgentDisplay(displays, onMain).id, 1);
  ok('the agent window display follows the setting without a restart');
}

console.log('pause and activity log (src/index.js)');
const idx = await import('../src/index.js');
let reached = [];
const fakeChrome = {
  windows: [{ id: 7, index: 1, minimized: false, mode: 'normal', tabs: [{ id: 10, url: 'https://mail.example.test/inbox/42?q=secret-query', title: 'Inbox — someone', active: true }] }]
};
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { reached.push(k); throw new Error(`B.${k} reached`); }]));
  const target = () => ({ tabId: 10, windowId: 7, url: fakeChrome.windows[0].tabs[0].url, title: fakeChrome.windows[0].tabs[0].title });
  return Object.assign(fake, {
    listTabs: async () => { reached.push('listTabs'); return { ok: true, frontmost: 'WeChat', chromePid: 42, windows: structuredClone(fakeChrome.windows) }; },
    pageScript: async (kind) => kind,
    pageDialog: async () => ({ ok: true, open: false }),
    ensureScreenAwake: async () => ({ woke: false, displays: 1, locked: false }),
    // This fixture performs no user input while its synthetic redirect settles.
    openNavigationObserver: async () => ({
      startedAt: Date.now(), untouched: async () => true, close: async () => {},
    }),
    evalInPage: async (kind) => {
      reached.push(`eval ${kind}`);
      if (kind === 'block') return { ok: true, blocked: null, target: target() };
      if (kind === 'read') return { ok: true, text: '=== 这一屏\n[1] 链接 Inbox', count: 1, hint: '', opaque: 0, outline: [], target: target() };
      if (kind === 'opener') return { ok: true, referrer: '', opener: false, target: target() };
      // wait_for_user with a field: armed, then the user's Return (no page change, so the submit is followed to its end).
      if (kind === 'ask') return { ok: true, kind: 'input', password: true, armed: true, connected: true, entered: { how: 'enter', at: Date.now() - 50, filled: true }, target: target() };
      throw new Error(`unexpected page script ${kind}`);
    },
    chromeInfo: async (tab) => (tab === 77 && fakeChrome.landing ? { ok: true, tabId: 77, windowId: 7, url: fakeChrome.landing, title: 'Landing' } : { ok: true, ...target() }),
    keepAwake: () => { reached.push('keepAwake'); return () => reached.push('stopAwake'); },
    selectTab: async () => { reached.push('selectTab'); return { ok: true }; },
    openTab: async (url) => { reached.push(`openTab ${url}`); return { ok: true, tabId: 77, windowId: 7 }; },
    cgevent: async (args) => {
      if (args[0] === 'idle') return { ok: true, idle: 100, clickIdle: 100 };
      if (args[0] === 'trust') return { ok: true, responsible: { name: 'kitty' } };
      throw new Error(`unexpected cgevent ${args[0]}`);
    }
  });
}
const call = async (name, args = {}) => {
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError };
};
idx.__setBridgeForTests(fakeBridge());
idx.__recordForTests(true);
const logLines = async () => (await readFile(ACTIVITY_FILE, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
{
  await putFile({ paused: true });
  const requests = idx.__toolsForTests().filter(t => t.name !== 'list_tabs').flatMap(({ name }) =>
    name === 'routines' ? ['start', 'run'].map(action => ({ name, extra: { action, id: 'paused-routine', nonce: `paused-${action}`, params: {} } })) : [{ name, extra: {} }]);
  for (const { name, extra } of requests) {
    reached = [];
    const label = `${name}${extra.action ? `:${extra.action}` : ''}`;
    const r = await call(name, { tab: 10, marker: 1, text: 'secret-typed-text', url: 'https://bank.example.test/acct/99?token=abc', why: 'user_asked', key: 'Enter', x: 1, y: 1, ...extra });
    assert.equal(r.isError, true, label);
    assert.match(r.text, /暂停/, label);
    assert.deepEqual(reached, [], `${label} reached the bridge while paused: ${reached.join(', ')}`);
  }
  reached = [];
  const l = await call('list_tabs');
  assert.equal(l.isError, false);
  assert.ok(reached.includes('listTabs'));
  ok(`paused: ${requests.length} input-capable requests refused before touching Chrome or the input helper; list_tabs still answers`);

  // Exercise the real dispatch and pause gate. The routine backend is a local
  // fixture so a permitted status/stop request cannot reach a live browser.
  const routines = idx.__routinesForTests(), query = routines.query, queried = [];
  try {
    routines.query = async args => { queried.push(args.action); return { fixture: true, action: args.action }; };
    for (const action of ['list', 'history', 'snapshot', 'status', 'stop', 'cancel']) {
      reached = [];
      const r = await call('routines', { action, nonce: 'fixture-intent' });
      assert.equal(r.isError, false, `paused routines:${action}: ${r.text}`);
      assert.deepEqual(reached, [], `routine management reached Chrome while paused: ${action}`);
    }
    assert.deepEqual(queried, ['list', 'history', 'snapshot', 'status', 'stop', 'cancel']);
    for (const action of ['start', 'run']) {
      const r = await call('routines', { action, id: 'paused-routine', tab: 10, params: {}, nonce: `fixture-${action}` });
      assert.equal(r.isError, true);
      assert.match(r.text, /暂停/);
    }
    assert.equal(queried.length, 6, 'paused starts must not reach the routine backend');
  } finally { routines.query = query; }
  ok('paused: routine history, status and stop reach their backend; start/run are still refused');

  const lines = await logLines();
  const raw = await readFile(ACTIVITY_FILE, 'utf8');
  for (const secret of ['secret-typed-text', '/acct/', 'token=abc', 'Enter', 'Inbox', 'someone', 'secret-query']) assert.ok(!raw.includes(secret), `"${secret}" in the activity log`);
  const typed = lines.find(x => x.tool === 'type_text');
  assert.equal(typed.ok, false);
  assert.equal(typed.code, 'paused_by_user');
  assert.equal(lines.find(x => x.tool === 'open_tab').host, 'bank.example.test');
  assert.ok(!lines.some(x => x.tool === 'list_tabs' || x.tool === 'task_plan' || x.tool === 'wake_screen'));
  assert.deepEqual(Object.keys(typed).sort(), ['code', 'color', 'host', 'ms', 'ok', 'pid', 't', 'tool', 'who']);
  assert.equal((await stat(ACTIVITY_FILE)).mode & 0o777, 0o600);
  ok('activity log: refused calls logged as not done (paused_by_user), host names only, no typed text, path, query, key or title; file 0600');
}
{
  await putFile({ paused: false });
  reached = [];
  const r = await call('read_page', { tab: 10 });
  assert.equal(r.isError, false, r.text);
  const last = (await logLines()).at(-1);
  assert.equal(last.tool, 'read_page');
  assert.equal(last.ok, true);
  assert.equal(last.host, 'mail.example.test');
  assert.equal(last.who, 'settings-test');
  ok('resumed: read_page works again and is logged with the page host (mail.example.test) only');

  const before = (await logLines()).length;
  await putFile({ activityLog: false });
  await call('read_page', { tab: 10 });
  assert.equal((await logLines()).length, before);
  ok('activity log off in the settings: nothing more is written');
}
{
  const panel = JSON.parse(execFileSync(CBMENU, ['--read-activity'], { encoding: 'utf8', env: process.env }));
  const lines = await logLines();
  assert.equal(panel.length, lines.length);
  assert.equal(panel[0].tool, 'read_page');                      // newest first
  assert.equal(panel[0].label, '读取页面');
  const t = panel.find(x => x.tool === 'type_text');
  assert.equal(t.label, '输入文字');
  assert.equal(t.why, '当时 AI 操作已暂停');
  ok('the panel lists the log newest first, with plain labels and the reason a call did not work');
}

console.log('pause: the cases the reviews found (round 13)');
{
  const taskFile = path.join(tmp, 'lock', 'tasks', `${process.pid}.json`);
  await putFile({ notify: false });
  reached = [];
  const plan = await call('task_plan', { task: '导出订单', steps: ['打开后台', '筛选', '导出'], estimate_minutes: 5 });
  assert.equal(plan.isError, false, plan.text);
  assert.ok(await stat(taskFile).then(() => true, () => false), 'no task card');
  await putFile({ paused: true, notify: false });
  const refused = await call('read_page', { tab: 10 });
  assert.match(refused.text, /暂停/);
  await assert.rejects(stat(taskFile), 'the task card stayed after the pause');
  assert.ok(reached.includes('stopAwake'), 'the task\'s keep-awake kept running');
  const done = await call('task_plan', { done: true });
  assert.equal(done.isError, false, `task_plan done refused while paused: ${done.text}`);
  ok('paused: the running task\'s card and keep-awake end at the first refused step; task_plan done still passes (Fable r13 A1)');

  const lt = await call('list_tabs');
  assert.equal(lt.isError, false);
  assert.match(lt.text, /暂停期间只列出你自己的标签/);
  assert.ok(!/Inbox|mail\.example\.test/.test(lt.text), 'the user\'s tab listed while paused');
  ok('paused: list_tabs lists only the session\'s own tabs, not the user\'s titles and URLs (Fable r13 B10)');

  // Queued behind another agent's input lock when the pause comes: refused when its turn comes, Chrome untouched.
  await putFile({ agentDisplay: 'off', notify: false });
  const lockDir = process.env.CHROME_BRIDGE_LOCK;
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.ppid, since: Date.now(), label: 'other agent' }));
  reached = [];
  const queued = call('open_tab', { url: 'https://queued.example.test/x', why: 'user_asked' });
  await new Promise(r => setTimeout(r, 400));
  await putFile({ agentDisplay: 'off', paused: true, notify: false });
  const { rm } = await import('node:fs/promises');
  await rm(lockDir, { recursive: true, force: true });
  const q = await queued;
  assert.equal(q.isError, true, q.text);
  assert.match(q.text, /暂停.*排队/);
  assert.ok(!reached.some(x => x.startsWith('openTab')), `opened anyway: ${reached.join(', ')}`);
  ok('a call queued behind another agent when the pause came is refused when its turn comes (Codex r13 A1)');

  // An agent's own open_tab already under way settles its redirect even if the pause comes meanwhile: the URL it
  // registers is where the page landed, not the one before (Fable r13 r4 B1).
  await putFile({ agentDisplay: 'off', notify: false });
  fakeChrome.landing = 'https://long.example.test/landing';
  reached = [];
  const T0 = await import('../src/tabs.js');
  const op = call('open_tab', { url: 'https://short.example.test/x', why: 'user_asked' });
  await new Promise(r => setTimeout(r, 150));
  await putFile({ agentDisplay: 'off', paused: true, notify: false });
  const opr = await op;
  assert.equal(opr.isError, false, opr.text);
  assert.equal((await T0.getTab(77)).expectedUrl, 'https://long.example.test/landing', 'registered the URL before the redirect');
  delete fakeChrome.landing;
  await T0.forgetTab(77);
  ok('a pause during an agent\'s own open_tab: the redirect still settles and the landing URL is registered');

  // wait_for_user: paused while waiting → stops, and the job's card and keep-awake end (Codex/Fable r13 r2 A2);
  // a wait that runs out is logged as not done (Codex r13 A5).
  idx.__setWaitPollForTests(100);
  await putFile({ notify: false });
  reached = [];
  const plan2 = await call('task_plan', { task: '报名', steps: ['填表', '提交'], estimate_minutes: 3 });
  assert.equal(plan2.isError, false, plan2.text);
  await stat(taskFile);
  const w = call('wait_for_user', { tab: 10, reason: '请登录', minutes: 0.05 });
  await new Promise(r => setTimeout(r, 350));
  await putFile({ paused: true, notify: false });
  const wr = await w;
  assert.equal(wr.isError, true);
  assert.match(wr.text, /暂停.*等用户处理/);
  await assert.rejects(stat(taskFile), 'the task card stayed after a pause noticed mid-wait');
  assert.ok(reached.includes('stopAwake'), 'the job\'s keep-awake kept running after a pause noticed mid-wait');
  await putFile({ notify: false });
  // The user's Return in a highlighted field, then the pause while the submit is followed (Codex r13 r3 A1).
  await putFile({ notify: false });
  reached = [];
  idx.__setWaitPollForTests(100, 50, 3000);
  const plan3 = await call('task_plan', { task: '登录', steps: ['输入密码'], estimate_minutes: 1 });
  assert.equal(plan3.isError, false, plan3.text);
  const fw = call('wait_for_user', { tab: 10, field: 1, reason: '登录密码', minutes: 0.2 });
  await new Promise(r => setTimeout(r, 600));
  await putFile({ paused: true, notify: false });
  const fr = await fw;
  assert.match(fr.text, /输入完按了回车/);
  await assert.rejects(stat(taskFile), 'the task card stayed after a pause during the submit follow');
  assert.ok(reached.includes('stopAwake'), 'the job\'s keep-awake kept running after a pause during the submit follow');
  await putFile({ notify: false });
  const t = await call('wait_for_user', { tab: 10, reason: '请登录', minutes: 0.005 });
  assert.match(t.text, /^⏳/);
  const last = (await logLines()).filter(x => x.tool === 'wait_for_user').at(-1);
  assert.deepEqual([last.ok, last.code], [false, 'wait_timeout']);
  ok('wait_for_user stops when paused (the job\'s card and keep-awake end too, also when the pause comes after the user\'s Return); one that runs out is logged as not done (wait_timeout)');

  // Automatic closing waits for the resume (Codex r13 A2); each tab it does close is in the log.
  const T = await import('../src/tabs.js');
  await T.registerTab(10, 'https://mail.example.test/inbox/42?q=secret-query', { windowId: 7, agentName: 'settings-test' });
  const closed = [];
  const deps = { listTabs: async () => ({ ok: true, frontmost: 'WeChat', chromePid: 42, windows: structuredClone(fakeChrome.windows) }),
    closeTab: async (id) => { closed.push(id); fakeChrome.windows[0].tabs = fakeChrome.windows[0].tabs.filter(x => x.id !== id); }, clickedSince: async () => false };
  await putFile({ paused: true, notify: false });
  const sp = await T.sweepTabs({ ...deps, ttlMs: -1 });
  assert.equal(sp.paused, true);
  assert.deepEqual(closed, []);
  // The pause comes while the sweep is reading Chrome's tabs: it still closes nothing.
  await putFile({ notify: false });
  const sp2 = await T.sweepTabs({ ...deps, listTabs: async () => { await putFile({ paused: true, notify: false }); return deps.listTabs(); }, ttlMs: -1 });
  assert.deepEqual(closed, [], 'closed after the pause came mid-sweep');
  assert.equal(sp2.paused, true);
  await putFile({ notify: false });
  const tabsBack = structuredClone(fakeChrome.windows);
  const sr = await T.sweepTabs({ ...deps, ttlMs: -1 });
  assert.deepEqual(closed, [10], JSON.stringify(sr));
  fakeChrome.windows = tabsBack;
  ok('paused (also when the pause comes mid-sweep): the sweep closes no agent tab; resumed, the idle one is closed');
}

console.log('activity log: size and presence files');
{
  const p = path.join(tmp, 'rot.jsonl');
  const env = { ...process.env, CHROME_BRIDGE_ACTIVITY: p, CHROME_BRIDGE_SETTINGS: path.join(tmp, 'none.json') };
  for (let i = 0; i < 2600; i++) S.logActivity({ tool: 'click', host: `h${i}.test`, ok: true, who: 'x'.repeat(40) }, env);
  const cur = (await readFile(p, 'utf8')).split('\n').filter(Boolean), old1 = (await readFile(S.activityOldPath(p), 'utf8')).split('\n').filter(Boolean);
  assert.ok((await stat(p)).size <= S.ACTIVITY_MAX_BYTES, 'over the size cap');
  assert.ok((await stat(S.activityOldPath(p))).size <= S.ACTIVITY_MAX_BYTES + 400);
  const all = [...old1, ...cur].map(l => JSON.parse(l).host);
  assert.equal(all.at(-1), 'h2599.test');
  // Nothing lost in between: the two files hold one unbroken run of the newest lines.
  const first = Number(all[0].slice(1, -5));
  assert.deepEqual(all, Array.from({ length: 2600 - first }, (_, i) => `h${first + i}.test`));
  assert.equal((await stat(S.activityOldPath(p))).mode & 0o777, 0o600);
  // The panel reads both files, newest first.
  const panel = JSON.parse(execFileSync(CBMENU, ['--read-activity'], { encoding: 'utf8', env }));
  assert.equal(panel[0].host, 'h2599.test');
  assert.equal(panel.length, Math.min(300, all.length));
  // Right after a rotation the current file is short: the panel still shows the lines in the .1 file.
  const p3 = path.join(tmp, 'small.jsonl');
  const line = (i) => JSON.stringify(S.activityRecord({ tool: 'click', host: `s${i}.test`, ok: true, t: 1000 + i })) + '\n';
  await writeFile(S.activityOldPath(p3), [0, 1, 2, 3, 4].map(line).join(''));
  await writeFile(p3, [5, 6].map(line).join(''));
  const small = JSON.parse(execFileSync(CBMENU, ['--read-activity'], { encoding: 'utf8', env: { ...env, CHROME_BRIDGE_ACTIVITY: p3 } }));
  assert.deepEqual(small.map(x => x.host), ['s6.test', 's5.test', 's4.test', 's3.test', 's2.test', 's1.test', 's0.test']);
  ok(`past ${S.ACTIVITY_MAX_BYTES / 1024} KB the log is renamed to .1 and a new one starts (no line lost between them); the panel reads both, newest first`);

  // Two servers appending at once while it rotates: every line lands in one file or the other.
  const p2 = path.join(tmp, 'race.jsonl');
  const env2 = { ...env, CHROME_BRIDGE_ACTIVITY: p2 };
  const { spawn } = await import('node:child_process');
  const writer = (tag) => new Promise((res, rej) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', `
      const S = await import(${JSON.stringify(path.join(ROOT, 'src', 'settings.js'))});
      for (let i = 0; i < 1500; i++) S.logActivity({ tool: 'click', host: '${tag}' + i + '.test', ok: true, who: 'y'.repeat(60) });`],
      { env: env2, stdio: 'inherit' });
    c.on('exit', (code) => code === 0 ? res() : rej(new Error(`writer ${tag} exited ${code}`)));
  });
  await Promise.all([writer('a'), writer('b')]);
  const got = new Set([p2, S.activityOldPath(p2)].flatMap(f => { try { return execFileSync('cat', [f], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } })
    .map(l => JSON.parse(l).host));
  for (const tag of ['a', 'b']) assert.ok(got.has(`${tag}1499.test`), `${tag}: the newest line lost`);
  ok('two servers writing while the log rotates: the newest lines of both are kept');

  assert.equal(S.hostOf('https://user:pw@a.example.test:8443/x?y#z'), 'a.example.test');
  assert.equal(S.hostOf('file:///Users/me/secret.html'), 'file');
  assert.equal(S.hostOf('not a url'), null);
  assert.deepEqual(Object.keys(S.activityRecord({ tool: 'type_text', text: 'secret', url: 'https://x/y', ok: true })).sort(),
    ['code', 'color', 'host', 'ms', 'ok', 'pid', 't', 'tool', 'who']);
  ok('host names only (no user, port, path, query); a record has only its fixed fields whatever it is given');

  const lockDir = path.join(tmp, 'p', 'input.lock');
  S.writePresence(lockDir, { who: 'A', version: 'abc1234' }, 4242);
  S.writePresence(lockDir, { busy: 'click' }, 4242);
  const pres = JSON.parse(await readFile(path.join(tmp, 'p', 'servers', '4242.json'), 'utf8'));
  assert.equal(pres.who, 'A');
  assert.equal(pres.busy, 'click');
  S.removePresence(lockDir, 4242);
  await assert.rejects(stat(path.join(tmp, 'p', 'servers', '4242.json')));
  ok('presence file: fields merge, removed when the server ends');
}

console.log('AI sessions as the panel sees them');
// Processes that run as a server does (`node <checkout>/src/index.js`) but never start it: an --import that holds forever.
const HOLD = path.join(tmp, 'hold.mjs');
await writeFile(HOLD, 'setTimeout(() => {}, 60000);\nawait new Promise(() => {});\n');
{
  const { spawn } = await import('node:child_process');
  // A process that looks like an old server of this checkout (node runs its src/index.js, no presence file).
  const old = spawn(process.execPath, ['--import', HOLD, path.join(ROOT, 'src', 'index.js')], { stdio: 'ignore' });
  const doctor = spawn(process.execPath, ['--import', HOLD, path.join(ROOT, 'src', 'index.js'), 'doctor']);
  const other = spawn(process.execPath, ['--import', HOLD, path.join(tmp, 'elsewhere', 'src', 'index.js')], { stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 300));
    const read = () => JSON.parse(execFileSync(CBMENU, ['--read-servers'], { encoding: 'utf8', env: process.env }));
    let r = read();
    assert.ok(r.legacy.includes(old.pid), 'an old server not counted');
    assert.ok(!r.legacy.includes(doctor.pid) && !r.legacy.includes(other.pid), 'a doctor run or another checkout counted as an old server');
    // Presence versions are display metadata; restart detection compares srcHash.
    // A reviewed source export intentionally has no Git history yet.
    const fixtureVersion = 'settings-test-v1';
    const lockDir = process.env.CHROME_BRIDGE_LOCK;
    S.writePresence(lockDir, { who: 'Claude · demo', version: fixtureVersion, srcHash: S.sourceFingerprint(ROOT), root: ROOT, envLocked: { notify: false } }, old.pid);
    S.writePresence(lockDir, { who: 'Gone', version: fixtureVersion, root: ROOT }, 2 ** 22 + 4321);
    r = read();
    assert.ok(!r.legacy.includes(old.pid), 'a server with a presence file still counted as old');
    // (this test process has a presence file too: the pause checks above recorded with __recordForTests)
    assert.deepEqual(r.servers.filter(x => x.pid !== process.pid).map(x => [x.pid, x.who, x.needsRestart, x.envLocked]),
      [[old.pid, 'Claude · demo', false, { notify: false }]]);
    await assert.rejects(stat(path.join(path.dirname(lockDir), 'servers', `${2 ** 22 + 4321}.json`)));
    // A hot-swap launcher (src/launcher.js) has no presence file of its own: its worker names it; not an old server.
    const launcher = spawn(process.execPath, ['--import', HOLD, path.join(ROOT, 'src', 'index.js')], { stdio: 'ignore' });
    const worker = spawn(process.execPath, ['--import', HOLD, path.join(ROOT, 'src', 'index.js'), '--worker'], { stdio: 'ignore' });
    const probe = spawn(process.execPath, ['--import', HOLD, path.join(ROOT, 'src', 'index.js'), '--probe'], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      assert.ok(read().legacy.includes(launcher.pid), 'a lone launcher-like process not counted');
      assert.ok(!read().legacy.includes(probe.pid), 'the launcher\'s look at new code (--probe) counted as an old server');
      S.writePresence(lockDir, { who: 'Claude · swap', version: fixtureVersion, srcHash: 'older', root: ROOT, launcher: launcher.pid }, worker.pid);
      r = read();
      assert.ok(!r.legacy.includes(launcher.pid) && !r.legacy.includes(worker.pid), 'a launcher counted as an old server');
      const w = r.servers.find(x => x.pid === worker.pid);
      assert.deepEqual([w.launcher, w.needsRestart], [launcher.pid, true]);
    } finally {
      launcher.kill(); worker.kill(); probe.kill();
      S.writePresence(lockDir, { launcher: null, srcHash: S.sourceFingerprint(ROOT) }, worker.pid);   // presence fields merge: not into later writes
      S.removePresence(lockDir, worker.pid);
    }
    ok('old servers (no presence file) counted, doctor runs and other checkouts not, nor a hot-swap launcher; a dead server\'s file removed');

    // A live process that is not a server (the doctor run) with a presence file: a crashed server's pid reused (Fable r13 B5).
    // A session that started after the panel's last ps (Codex/Fable r13 r2 A1): not in that snapshot, but kept.
    const readAt = (psAt) => JSON.parse(execFileSync(CBMENU, ['--read-servers', '--ps-at', String(psAt)], { encoding: 'utf8', env: process.env }));
    S.writePresence(lockDir, { who: 'New', root: ROOT, startedAt: Date.now() }, doctor.pid);
    assert.ok(readAt(Date.now() - 20_000).servers.some(x => x.pid === doctor.pid), 'a session newer than the ps snapshot was dropped');
    await stat(path.join(path.dirname(lockDir), 'servers', `${doctor.pid}.json`));
    S.writePresence(lockDir, { who: 'Ghost', root: ROOT, startedAt: Date.now() - 60_000 }, doctor.pid);
    assert.ok(!readAt(Date.now()).servers.some(x => x.pid === doctor.pid), 'a reused pid shown as a session');
    await assert.rejects(stat(path.join(path.dirname(lockDir), 'servers', `${doctor.pid}.json`)));
    ok('a presence file whose pid now runs something else is dropped — only by a ps snapshot newer than that server\'s start');

    // 「需要重启」: the src/*.js the server loaded vs the files now (a checkout with the panel copied into it; no git).
    const repo = path.join(tmp, 'repo');
    await mkdir(path.join(repo, 'bin'), { recursive: true });
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'bin', 'cbmenu'), await readFile(CBMENU), { mode: 0o755 });
    await writeFile(path.join(repo, 'src', 'index.js'), 'v1');
    await writeFile(path.join(repo, 'src', 'Tabs.js'), 't');          // upper case sorts first in both
    const rr = path.join(repo, 'bin', 'cbmenu');
    const readRepo = () => JSON.parse(execFileSync(rr, ['--read-servers'], { encoding: 'utf8', env: process.env }));
    const h1 = S.sourceFingerprint(repo);
    assert.equal(readRepo().srcHash, h1, 'the panel hashes src/*.js differently from the server');
    assert.equal(JSON.parse(execFileSync(CBMENU, ['--read-servers'], { encoding: 'utf8', env: process.env })).srcHash, S.sourceFingerprint(ROOT));
    const restart = (srcHash) => {
      S.writePresence(lockDir, { srcHash, root: repo }, old.pid);
      return readRepo().servers.find(x => x.pid === old.pid).needsRestart;
    };
    assert.equal(restart(h1), false);
    await writeFile(path.join(repo, 'src', 'menubar.swift'), 'panel only');
    await writeFile(path.join(repo, 'TODO.md'), 'docs');
    assert.equal(restart(h1), false, 'a panel-only or docs-only change counted as an update (Fable r13 A3)');
    await writeFile(path.join(repo, 'src', 'index.js'), 'v2');
    assert.equal(restart(h1), true, 'an edited src/*.js (uncommitted, no git at all) not counted (Codex r13 A4)');
    assert.equal(restart(undefined), null, 'a server that reports no fingerprint is not guessed');
    ok('"needs restart" when a src/*.js file differs from what the server loaded (uncommitted edits too); not for the panel, helpers or docs; JS and Swift hash alike');

    // The setup check: one block per app, the freshest result of each; the header says what is wrong.
    const old2 = spawn(process.execPath, ['--import', HOLD, path.join(ROOT, 'src', 'index.js')], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      const item = (id, ok, x = {}) => ({ id, title: `${id} / ${id}`, required: id !== 'screen_recording', ok, skipped: false, detail: `${id}\nen`, fix: null, settings: null, ...x });
      const allOk = ['chrome_running', 'automation', 'accessibility', 'screen_recording'].map(id => item(id, true));
      const t = Date.now();
      S.writePresence(lockDir, { checks: { at: t - 5000, app: 'kitty', items: allOk } }, old.pid);
      S.writePresence(lockDir, { who: 'Codex', root: ROOT, checks: { at: t, app: 'Codex', items: [item('accessibility', false, { fix: '打开辅助功能\nTurn on', settings: 'x-apple.systempreferences:x' }), ...allOk.slice(1)] } }, old2.pid);
      // (the panel run below drops the presence file of this test process: it is not a server by ps)
      let r = read();
      assert.deepEqual(r.apps.map(a => [a.app, a.failed.map(f => f.id)]), [['Codex', ['accessibility']], ['kitty', []]]);
      assert.equal(r.problem, '有权限没打开');
      S.writePresence(lockDir, { checks: { at: t + 1, app: 'Codex', items: allOk } }, old2.pid);
      S.writePresence(lockDir, { checks: { at: t + 2, app: 'kitty', items: [item('chrome_running', false, { fix: '打开 Google Chrome（或运行 mychrome-mcp doctor --open-chrome 让本检查替你打开）。\nOpen' }), ...allOk.slice(1)] } }, old.pid);
      r = read();
      assert.equal(r.problem, 'Chrome 没有打开', 'Chrome closed shown as a missing permission (Fable r13 A2)');
      const fix = r.apps.find(a => a.app === 'kitty').failed[0].fix;
      assert.ok(!/doctor|mychrome-mcp/.test(fix), `a command in the panel: ${fix}`);
      assert.equal(S.freshCheckFor(lockDir, 'kitty', t, process.pid).at, t + 2);
      assert.equal(S.freshCheckFor(lockDir, 'kitty', t + 10, process.pid), null);
      assert.equal(S.freshCheckFor(lockDir, 'Other', 0, process.pid), null);
      assert.equal(S.freshCheckFor(lockDir, 'kitty', t, old.pid), null, 'its own result counted as another session\'s');
      // A session that skips its own check keeps a copy of the other's: it outlives that session (Codex r13 r4 A1).
      const mine = path.join(path.dirname(lockDir), 'servers', `${process.pid}.json`);
      await idx.__selfCheckForTests({ startup: true });
      assert.equal(JSON.parse(await readFile(mine, 'utf8')).checks?.at, t + 2, 'the borrowed check was not kept');
      old.kill();
      await new Promise(r => setTimeout(r, 200));
      assert.ok(JSON.parse(await readFile(mine, 'utf8')).checks.items.some(i => i.id === 'chrome_running' && !i.ok), 'the copy lost the failure');
      assert.equal(S.claimCheck(lockDir, 'kitty', t), true);
      assert.equal(S.claimCheck(lockDir, 'kitty', t), false, 'two sessions of one app both ran the same request');
      assert.equal(S.claimCheck(lockDir, 'Codex', t), true);
      assert.equal(S.claimCheck(lockDir, 'kitty', t + 1), true);
      ok('setup check per app (each session checks in its own app: Codex r13 A6); "Chrome 没有打开" is not a permission; no command lines in the panel; one session per app answers a request; a borrowed result is kept');
    } finally { old2.kill(); }
  } finally { old.kill(); doctor.kill(); other.kill(); }
}

console.log(`\nsettings checks passed (${passed}).`);
