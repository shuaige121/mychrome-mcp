#!/usr/bin/env node
/* wait_for_user within one call budget (contract H-handoff, problems-20261101): one call observes a slice
 * of the hand-off window and returns a non-error "still waiting" receipt with a resume token before the
 * budget; a resume continues the same instance (reminder, highlight, alert token, observer); a call without
 * the token replaces it; it ends at its window end with no further call; pending and recently ended
 * hand-offs keep the tab from any server's idle sweep; input on that tab meanwhile is refused not_sent.
 * Time is scaled: CHROME_BRIDGE_CALL_BUDGET_MS=600 stands for the 100 s budget. Production entry points
 * (callTool, sweepTabs in a second process) with a fake bridge; nothing reaches Chrome or the input helper.
 * HANDOFF_CASE=<name> runs one case (the coordinator's revert check). */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const BUDGET = 600;
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-handoff-test-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
process.env.CHROME_BRIDGE_NOTIFY = '0';
process.env.CHROME_BRIDGE_AGENT_NAME = 'handoff-test';
process.env.CHROME_BRIDGE_HABITS = 'off';
process.env.CHROME_BRIDGE_MENUBAR = '0';
process.env.CHROME_BRIDGE_LANG = 'zh';
process.env.CHROME_BRIDGE_CALL_BUDGET_MS = String(BUDGET);
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idx = await import('../src/index.js');
const T = await import('../src/tabs.js');
const { writeSettings } = await import('../src/settings.js');
const ONLY = process.env.HANDOFF_CASE || null;
let passed = 0;
const evidence = [];   // measured timings, printed at the end (report evidence)
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------ fixture */

let state, log, notes, sessions, observers;
const url = id => state.urls[id];
const target = id => ({ tabId: id, windowId: 7, chromePid: 42, cgWindow: 70, tabActive: id === state.front,
  bounds: { left: 0, top: 0, width: 1200, height: 900 }, url: url(id), title: `t${id}` });
function page(kind, vars, tab) {
  const id = tab == null ? state.front : Number(tab);
  const t = target(id);
  if (kind === 'block') return { ok: true, blocked: state.blocked[id] || null, target: t };
  if (kind === 'read') return { ok: true, text: '=== 这一屏\n[1] 输入框', count: 1, hint: '', opaque: 0, outline: [], target: t };
  if (kind === 'locate') return { bounds: t.bounds, focusToken: 'native-focus', view: { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900 },
    aim: { x: 100, y: 112 }, rect: { x: 10, y: 100, width: 200, height: 24 }, visible: { x: 10, y: 100, width: 200, height: 24 }, hitOk: true, chain: [], target: t };
  if (kind === 'ask') {
    const a = vars.ASK || {};
    if (a.arm) { state.armed = a.arm; return { ok: true, armed: true, kind: 'single', password: true, filled: false, target: t }; }
    if (a.read) return { ok: true, armed: state.armed === a.read, connected: true, target: t,
      ...(state.entered && state.armed === a.read ? { entered: { how: 'return', filled: true, at: state.entered } } : {}) };
    if (a.disarm) { if (state.armed === a.disarm) state.armed = null; return { ok: true, armed: false, target: t }; }
  }
  throw new Error(`unexpected page script ${kind}`);
}
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in handoff test`); }]));
  return Object.assign(fake, {
    pageDialog: async () => ({ ok: true, open: false }),
    ensureScreenAwake: async () => ({ locked: false, displays: 1, woke: false }),
    // Page scripts are one expression returning JSON, as in Chrome; read_page joins block.js and read.js in one eval.
    pageScript: async (kind, vars = {}) => `fakePage(${JSON.stringify(kind)}, ${JSON.stringify(vars)})`,
    evalInPage: async (src, tab) => {
      const kinds = [...src.matchAll(/fakePage\("(\w+)"/g)].map(m => m[1]);
      log.push(`eval ${kinds.join('+')}${src.includes('"disarm"') ? ' disarm' : ''}`);
      if (src.includes('"disarm"') && state.hangDisarm) return new Promise(() => {});
      if (state.slowBlockMs && kinds[0] === 'block') { const ms = state.slowBlockMs; state.slowBlockMs = 0; await sleep(ms); }
      return JSON.parse(vm.runInNewContext(src, { fakePage: (k, v) => JSON.stringify(page(k, v, tab)) }));
    },
    chromeInfo: async (tab) => target(tab == null ? state.front : Number(tab)),
    listTabs: async () => ({ ok: true, frontmost: 'WeChat', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
      tabs: Object.keys(state.urls).map(id => ({ id: Number(id), url: state.urls[id], title: `t${id}`, active: Number(id) === state.front })) }] }),
    openInputSession: async () => {
      sessions++;
      let held = false;
      return {
        request: async req => {
          log.push(`session ${req.op}`);
          if (req.op === 'hold') { held = true; return { ok: true, epoch: 1, pointer: { x: 10, y: 20 }, heldAt: Date.now() }; }
          if (req.op === 'recordNativeScene') return { ok: true, epoch: 1, restoreToken: 'r'.repeat(64) };
          return { ok: true, epoch: 1, operationId: req.operationId, stages: [], inputDelivery: req.op === 'nativeChrome' ? 'sent' : undefined,
            inputMonitor: true, takeover: { active: held }, ...(req.op === 'warp' ? { verified: true, warped: req.to } : {}) };
        },
        close: async () => { log.push('session close'); held = false; return { ok: true, takeover: { active: false } }; },
      };
    },
    snapshotScene: async () => ({ appPid: 99, chromeWindow: 7, chromeTab: 10 }),
    restoreScene: async (_scene, options) => { await options.native({ kind: 'restoreScene' }, { policy: 'restore' }); return { ok: true, appFrontmost: true }; },
    selectTab: async (id, opts) => {
      log.push(`native selectTab ${id}`);
      if (state.hangSelect) await new Promise(r => { state.releaseSelect = r; });
      await opts.native({ kind: 'selectTab', tabId: id, windowId: opts.windowId }); return { ok: true };
    },
    activateChrome: async (id, hint, opts) => { log.push(`native activate ${id}`); await opts.native({ kind: 'activate', tabId: id, windowId: hint.windowId });
      return { ok: true, targetOnTop: true, ...target(id), frontmostPid: 42, keyWindowIsTarget: true,
        geometry: { mode: 'fit-current', beforeBounds: { ...target(id).bounds }, displayId: 1, branch: 'usable', changed: false, possiblyChanged: false } }; },
    openNavigationObserver: async ({ maxMs } = {}) => {
      const o = { maxMs, closed: false, startedAt: Date.now(), untouched: async () => true,
        close: async () => { o.closed = true; if (state.hangDisarm) return new Promise(() => {}); } };
      observers.push(o);
      return o;
    },
    cgevent: async (args) => {
      if (args[0] === 'displays') return { displays: [] };
      if (args[0] === 'mousepos') return { x: 10, y: 20 };
      if (args[0] !== 'idle') throw new Error(`B.cgevent ${args[0]} reached in handoff test`);
      return state.busy ? { ok: true, idle: 0, keyIdle: 0, held: [] } : { ok: true, idle: 100, keyIdle: 100, held: [], clickIdle: 100 };
    },
  });
}
async function world() {
  idx.__resetPanelTaskForTests();
  idx.__gotoForTests().writeTask();   // the menu-bar state written clear, as after the previous case's end
  idx.__resetLedgerForTests();
  for (const n of await readdir(T.TAB_DIR).catch(() => [])) await rm(path.join(T.TAB_DIR, n), { force: true });
  state = { urls: { 10: 'https://shop.test/login', 11: 'https://bank.test/login' }, front: 10, blocked: {}, armed: null, entered: null };
  log = []; notes = []; sessions = 0; observers = [];
  idx.__setBridgeForTests(fakeBridge());
  idx.__notifyForTests({ send: t => notes.push(t), everyMs: 60_000 });
  idx.__setWaitPollForTests(20, 15, 200);
  await T.registerTab(10, url(10), { windowId: 7, agentName: 'handoff-test' });
}
const call = async (name, args = {}, extra = {}) => {
  const started = Date.now();
  const r = await idx.callTool({ params: { name, arguments: args } }, extra);
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError,
    error: r.structuredContent?.error || null, ms: Date.now() - started, at: Date.now() };
};
/** A call that must return by `ms`: a hang fails the case instead of the run. */
async function within(promise, ms, label) {
  let timer;
  const r = await Promise.race([promise, new Promise(res => { timer = setTimeout(res, ms, 'TIMED_OUT'); })]);
  clearTimeout(timer);
  assert.notEqual(r, 'TIMED_OUT', `${label}: still running after ${ms} ms`);
  return r;
}
const wfu = (args, extra = {}, limit = BUDGET + 2000) => within(call('wait_for_user', args, extra), limit, `wait_for_user ${JSON.stringify(args)}`);
const taskFile = path.join(tmp, 'lock', 'tasks', `${process.pid}.json`);
const readTask = async () => JSON.parse(await readFile(taskFile, 'utf8').catch(() => 'null'));
const handoffFile = id => path.join(T.TAB_DIR, `${id}.handoff.json`);
const readHandoff = async id => JSON.parse(await readFile(handoffFile(id), 'utf8').catch(() => 'null'));
const tokenOf = text => (text.match(/resume="([^"]+)"/) || [])[1] || null;
function assertContinuationRequired(text) {
  assert.match(text, /观察已结束/);
  assert.match(text, /不代表收到继续授权/);
  assert.match(text, /若用户尚未在本次交接后于原对话明确说“继续”，先等待/);
  assert.match(text, /收到后先 read_page 核对同一页面，再恢复原任务/);
  assert.match(text, /此前的任务授权不能替代本次继续指令/);
  assert.doesNotMatch(text, /自动接着做|自己接着做|不用回去|再接着做|用户应该已经提交|用户可能已经提交/);
}
function assertStillWaiting(r, label) {
  assert.equal(r.isError, false, `${label}: ${r.text}`);
  assert.ok(r.ms < BUDGET, `${label}: returned after ${r.ms} ms (budget ${BUDGET})`);
  assert.match(r.text, /^⏳ 用户还没处理完/, `${label}: ${r.text}`);
  assert.match(r.text, /交接没有结束/);
  assert.ok(tokenOf(r.text), `${label}: no resume token`);
  assertContinuationRequired(r.text);
}
/** A resume whose hand-off is over: a non-error "ended, no new wait" receipt, and nothing started, shown or sent. */
async function staleResume(args, why, label) {
  const before = { notes: notes.length, sessions, log: log.length, task: await readTask() };
  const r = await wfu(args);
  assert.equal(r.isError, false, `${label}: ${r.text}`);
  assert.match(r.text, /^⏹ /, `${label}: ${r.text}`);
  assert.match(r.text, why, `${label}: ${r.text}`);
  assert.match(r.text, /这次没有开始新的等待，没有提醒用户，也没有操作页面/);
  assert.match(r.text, /不带 resume 再调用 wait_for_user 重新交接/);
  assertContinuationRequired(r.text);
  assert.equal(tokenOf(r.text), null, `${label}: a new token was issued`);
  assert.equal(notes.length, before.notes, `${label}: the user was notified`);
  assert.equal(sessions, before.sessions, `${label}: an input session was opened`);
  assert.deepEqual(log.slice(before.log), [], `${label}: the page or Chrome was touched`);
  assert.deepEqual(await readTask(), before.task, `${label}: the menu-bar state changed`);
  return r;
}
async function until(pred, ms, label) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(10)) if (await pred()) return;
  throw new Error(`${label}: not within ${ms} ms`);
}
/** Another server (its own process) sweeping the same registry. `go`: the listing waits for this file (the
 * plan is made from records read before it, the close re-checks the registry after it). */
function otherServerSweep({ now = null, ttlMs, go = null, listed = null }) {
  const script = `
    import { writeFileSync, existsSync } from 'node:fs';
    const T = await import(${JSON.stringify(path.join(ROOT, 'src/tabs.js'))});
    const tabs = ${JSON.stringify(Object.keys(state.urls).map(id => ({ id: Number(id), url: state.urls[id], title: 't' + id, active: false })))};
    const closed = [];
    const r = await T.sweepTabs({ ${now != null ? `now: ${now},` : ''} ttlMs: ${ttlMs}, isAlive: () => true, lockDir: ${JSON.stringify(process.env.CHROME_BRIDGE_LOCK)},
      clickedSince: async () => false,
      listTabs: async () => {
        ${listed ? `writeFileSync(${JSON.stringify(listed)}, '1'); for (const t = Date.now(); !existsSync(${JSON.stringify(go)}) && Date.now() - t < 8000;) await new Promise(r => setTimeout(r, 10));` : ''}
        return { ok: true, frontmost: 'WeChat', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal', tabs: tabs.filter(t => !closed.includes(t.id)) }] };
      },
      closeTab: async id => { closed.push(id); return { ok: true }; } });
    console.log(JSON.stringify({ closed: r.closed.map(x => x.tabId), deferred: (r.deferred || []).map(x => x.tabId), calls: closed }));`;
  return new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], { env: process.env, encoding: 'utf8' },
    (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(JSON.parse(out.trim().split('\n').pop()))));
}
async function fieldHandoff(args = {}, extra = {}, limit) {
  return wfu({ tab: 10, field: 1, reason: '短信验证码', ...args }, extra, limit);
}

const cases = [];
const add = (kind, name, label, fn) => cases.push({ kind, name, label, fn });

/* ------------------------------------------------------- new fix */

add('new', 'slice', 'minutes=10: a non-error "still waiting" receipt before the budget, with a resume token and the continuation protocol; the hand-off stays pending', async () => {
  await world();
  const r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 10 });
  assertStillWaiting(r, 'first slice');
  const left = Number(r.text.match(/窗口还剩约 (\d+) 秒/)?.[1]);
  evidence.push(`slice: minutes=10 returned after ${r.ms} ms of a ${BUDGET} ms budget, ${left} s left`);
  assert.ok(left >= 595 && left <= 600, `time left ${left}`);
  assert.match(r.text, new RegExp(`wait_for_user（tab=10，resume="${tokenOf(r.text)}"）`));
  const task = await readTask();
  assert.equal(task?.alert, '需要你处理：shop.test 在这个页面登录', 'the reminder went with the slice');
  assert.ok(log.every(e => e === 'eval block'), `a slice sent something: ${log}`);
  assert.equal(sessions, 0);
});

add('new', 'resume', 'resume continues the same instance with the time left (each call within budget, total = the window); a read_page between slices keeps the reminder; the window end clears it', async () => {
  await world();
  const first = Date.now();
  let r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.03 });
  assertStillWaiting(r, 'slice 1');
  const token = tokenOf(r.text), alertToken = (await readTask())?.alertToken;
  assert.ok(alertToken);
  const rp = await call('read_page', { tab: 10 });
  assert.equal(rp.isError, false, rp.text);
  assert.equal((await readTask())?.alertToken, alertToken, 'read_page between slices cleared the hand-off reminder');
  assert.ok(idx.__blocksForTests().get(10), 'read_page between slices removed the alert');
  let slices = 1;
  while (/^⏳ 用户还没处理完/.test(r.text)) {
    assert.equal(tokenOf(r.text), token, 'a resumed slice changed the instance token');
    assert.equal((await readTask())?.alertToken, alertToken, 'a resumed slice renewed the alert');
    r = await wfu({ tab: 10, resume: token });
    assert.ok(r.ms < BUDGET, `resume returned after ${r.ms} ms`);
    slices++;
  }
  const total = Date.now() - first;
  assert.ok(slices >= 3, `only ${slices} slices for a 1800 ms window`);
  evidence.push(`resume: ${slices} calls covered a 1800 ms window in ${total} ms`);
  assert.match(r.text, /^⏳ 等了 [\d.]+ 分钟，用户还没处理（在这个页面登录）/);
  assertContinuationRequired(r.text);
  assert.ok(total >= 1800 && total <= 1800 + BUDGET, `window total ${total} ms`);
  assert.equal(await readTask(), null, 'the reminder outlived its window');
});

add('new', 'window-end', 'a parked hand-off ends at its window end with no further call: reminder gone, registry says ended, ledger mark closed', async () => {
  await world();
  const r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.02 });
  assertStillWaiting(r, 'slice');
  assert.equal((await readHandoff(10))?.pending, true);
  await until(async () => (await readTask()) === null, 1500, 'window end');
  assert.equal(idx.__blocksForTests().has(10), false);
  await until(async () => (await readHandoff(10))?.pending === false, 500, 'registry end');
  const h = await readHandoff(10);
  assert.ok(h.keepUntil >= Date.now() + 9 * 60_000, 'the ended hand-off is not kept from idle closing');
  assert.ok(idx.__ledgerForTests().get(10)?.helped?.until > 0, 'the ledger mark stayed open');
});

add('new', 'replace', 'a call without the token replaces the old hand-off; the old window end never clears the new one; the old token then answers "ended (replaced)" and starts nothing', async () => {
  await world();
  const a = await wfu({ tab: 10, reason: '第一个交接', minutes: 0.03 });
  assertStillWaiting(a, 'A');
  const aAt = Date.now();
  const b = await wfu({ tab: 10, reason: '第二个交接', minutes: 0.1 });
  assertStillWaiting(b, 'B');
  assert.notEqual(tokenOf(a.text), tokenOf(b.text));
  const bTask = await readTask();
  assert.equal(bTask.alert, '需要你处理：shop.test 第二个交接');
  const gated = await within(call('press_key', { tab: 10, key: 'enter' }), 2000, 'press_key after replace');
  assert.equal(gated.error?.code, 'handoff_pending', 'the replaced hand-off\'s end lifted the newer one\'s input gate');
  assert.match(gated.text, new RegExp(`resume="${tokenOf(b.text)}"`));
  await sleep(Math.max(0, aAt + 1800 + 200 - Date.now()));   // past A's window end
  assert.equal((await readTask())?.alertToken, bTask.alertToken, 'the replaced hand-off\'s window end cleared the newer one');
  // Round 3b (meeting 11-01 #4): the replaced token is answered "ended", no new hand-off; B stays as it was.
  await staleResume({ tab: 10, resume: tokenOf(a.text), reason: '第三个交接', minutes: 0.1 }, /结束：同一标签开始了新的交接/, 'replaced token');
  assert.equal((await readTask())?.alertToken, bTask.alertToken);
});

add('new', 'cancel-pause', 'cancel or pause between slices ends the hand-off (its reminder only); its token then answers "ended", no new wait', async () => {
  await world();
  let r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.1 });
  assertStillWaiting(r, 'slice');
  const ac = new AbortController(); ac.abort();
  const cancelled = await wfu({ tab: 10, resume: tokenOf(r.text) }, { signal: ac.signal });
  assert.equal(cancelled.isError, true, cancelled.text);
  assert.equal(cancelled.error?.code, 'cancelled');
  assert.equal(await readTask(), null, 'a cancel between slices left the reminder');
  await staleResume({ tab: 10, resume: tokenOf(r.text) }, /结束：调用被取消/, 'cancelled token');
  r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.1 });
  assertStillWaiting(r, 'slice 2');
  writeSettings({ paused: true });
  try {
    const paused = await wfu({ tab: 10, resume: tokenOf(r.text) });
    assert.equal(paused.isError, true); assert.equal(paused.error?.code, 'paused_by_user');
    assert.equal(await readTask(), null);
    assert.equal(idx.__blocksForTests().size, 0);
  } finally { writeSettings({ paused: false }); }
  await staleResume({ tab: 10, resume: tokenOf(r.text), reason: '在这个页面登录', minutes: 0.1 }, /结束：用户在菜单栏暂停了 MyChrome/, 'paused token');
});

add('new', 'input-gate', 'input on the tab while its hand-off is pending: not_sent, nothing taken over or evaluated, told to resume observing', async () => {
  await world();
  const r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.1 });
  assertStillWaiting(r, 'slice');
  log = [];
  for (const [name, args] of [['click', { tab: 10, marker: 1 }], ['type_text', { tab: 10, text: 'abc' }], ['press_key', { tab: 10, key: 'enter' }]]) {
    const x = await within(call(name, args), 2000, name);
    assert.equal(x.isError, true, `${name}: ${x.text}`);
    assert.equal(x.error?.code, 'handoff_pending', `${name}: ${JSON.stringify(x.error)}`);
    assert.equal(x.error?.inputDelivery, 'not_sent');
    assert.match(x.text, new RegExp(`resume="${tokenOf(r.text)}"`));
    assert.match(x.text, /不代表收到继续授权/);
  }
  assert.equal(sessions, 0, 'an input session was opened'); assert.deepEqual(log, [], `reached the page: ${log}`);
  assert.ok((await readTask())?.alert, 'the refused input ended the hand-off');
});

add('new', 'field-slices', 'a field hand-off keeps its highlight and observer between slices; the user\'s Return in a resumed slice ends it', async () => {
  await world();
  const r = await fieldHandoff({ minutes: 0.1 });
  assertStillWaiting(r, 'field slice');
  assert.match(r.text, /提醒和高亮仍保留/);
  assert.ok(state.armed, 'the highlight went with the slice');
  assert.equal(log.some(e => e.includes('disarm')), false);
  // The setup's own click observer (120 s) is closed; the hand-off's (window + 10 s) stays open between slices.
  const watch = () => observers.filter(o => o.maxMs === 6000 + 10_000);
  assert.equal(watch().length, 1); assert.equal(watch()[0].closed, false, 'the observer closed with the slice');
  assert.equal(log.filter(e => e === 'session click').length, 1);
  const alertToken = (await readTask())?.alertToken;
  const before = log.length;
  setTimeout(() => { state.entered = Date.now(); }, 50);
  const done = await fieldHandoff({ resume: tokenOf(r.text) });
  assert.equal(done.isError, false, done.text);
  assert.match(done.text, /^✅ 用户在 \[1\] 输入完按了回车/);
  assertContinuationRequired(done.text);
  assert.ok(alertToken);
  assert.equal(watch().length, 1, 'a resumed slice opened a second observer');
  assert.equal(watch()[0].closed, true);
  assert.equal(log.slice(before).filter(e => e.startsWith('session')).length, 0, 'the resume sent input');
  assert.equal(await readTask(), null);
});

add('new', 'budget-idle', 'field setup: the user never stops typing: not_sent before the budget, nothing held or clicked, nobody notified', async () => {
  await world();
  state.busy = true;
  const r = await fieldHandoff({ minutes: 1 });
  assert.equal(r.isError, true, r.text);
  assert.ok(r.ms < BUDGET, `returned after ${r.ms} ms`);
  assert.equal(r.error?.code, 'call_deadline'); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.match(r.text, /没有发送任何输入/);
  evidence.push(`budget-idle: not_sent after ${r.ms} ms`);
  assert.equal(log.some(e => /session (hold|click)/.test(e)), false, `input sent: ${log}`);
  assert.equal(notes.length, 0); assert.equal(await readTask(), null);
});

add('new', 'budget-queue', 'a wait_for_user queued behind this connection\'s other call past the budget: not_sent before the budget', async () => {
  await world();
  state.hangSelect = true;
  const ac = new AbortController();
  const holder = idx.callTool({ params: { name: 'wait_for_user', arguments: { tab: 10, field: 1, reason: '验证码', minutes: 1 } } }, { signal: ac.signal });
  await until(() => typeof state.releaseSelect === 'function', 1000, 'first setup');
  const r = await wfu({ tab: 11, reason: '在这个页面登录', minutes: 1 });
  assert.equal(r.isError, true, r.text);
  assert.ok(r.ms < BUDGET, `returned after ${r.ms} ms`);
  assert.equal(r.error?.code, 'call_deadline'); assert.equal(r.error?.inputDelivery, 'not_sent');
  evidence.push(`budget-queue: not_sent after ${r.ms} ms`);
  ac.abort(); state.releaseSelect();
  await within(holder, 3000, 'holder');
});

add('new', 'cleanup-bound', 'the window ends inside the call and its cleanup hangs (dialog-free page, disarm and observer close never answer): the call still returns within its budget', async () => {
  await world();
  idx.__setCallBudgetForTests?.(2000);
  try {
    const started = Date.now();
    const pending = fieldHandoff({ minutes: 0.01 }, {}, 4000);
    await until(() => notes.length > 0, 1000, 'setup done (ready notice)');   // the setup's own observer is closed by then
    state.hangDisarm = true;
    const r = await pending;
    assert.ok(Date.now() - started < 2000, `returned after ${Date.now() - started} ms (budget 2000)`);
    evidence.push(`cleanup-bound: hanging cleanup, returned after ${Date.now() - started} ms of 2000`);
    assert.match(r.text, /^⏳ 等了 [\d.]+ 分钟，用户还没在 \[1\] 输入完/);
    assertContinuationRequired(r.text);
  } finally { idx.__setCallBudgetForTests?.(BUDGET); state.hangDisarm = false; }
});

add('new', 'sweep-grace', 'another server\'s sweep: 4 s after the window end the tab stays (TTL 1 s); after the 10-minute grace it may close it', async () => {
  await world();
  await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.02 });
  await until(async () => (await readTask()) === null, 2500, 'hand-off end');
  await sleep(50);
  const endedAt = Date.now();
  const soon = await otherServerSweep({ now: endedAt + 4000, ttlMs: 1000 });
  assert.deepEqual(soon.calls, [], `closed right after the hand-off: ${JSON.stringify(soon)}`);
  const late = await otherServerSweep({ now: endedAt + 10 * 60_000 + 1000, ttlMs: 1000 });
  assert.deepEqual(late.closed, [10], JSON.stringify(late));
});

add('new', 'sweep-recheck', 'another server planned to close an idle tab; a hand-off on it (no tab argument) starts and is resumed before its close re-check: kept', async () => {
  await world();
  await T.registerTab(11, url(11), { windowId: 7, agentName: 'handoff-test', now: Date.now() - 3_600_000 });
  state.front = 11;
  const listed = path.join(tmp, `listed-${Date.now()}`), go = path.join(tmp, `go-${Date.now()}`);
  const sweeping = otherServerSweep({ ttlMs: 60_000, listed, go });
  await until(() => existsSync(listed), 5000, 'other server listing');
  const r = await wfu({ reason: '在这个页面登录', minutes: 0.1 });
  assertStillWaiting(r, 'start');
  const again = await wfu({ resume: tokenOf(r.text) });
  assertStillWaiting(again, 'resume');
  await writeFile(go, '1');
  const res = await within(sweeping, 10_000, 'other server sweep');
  assert.deepEqual(res.calls, [], `closed a tab handed to the user: ${JSON.stringify(res)}`);
  assert.deepEqual(res.deferred, [11]);
  assert.ok(await T.getTab(11));
});


/* ---------------------------------------------------- round 2 (Codex QA r1) */

const LOCK = process.env.CHROME_BRIDGE_LOCK;
async function holdLockElsewhere() {
  // Another live process holds the input lock (its owner record; lock.js reads it as held).
  await mkdir(LOCK, { recursive: true });
  await writeFile(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.ppid, since: Date.now(), label: 'other agent', token: 'other-token' }));
}
const releaseLockElsewhere = () => rm(LOCK, { recursive: true, force: true });

add('new', 'budget-lock', 'A1: the input lock queue leaves just under the preparation + cleanup reserve: not_sent before any input, total within the budget', async () => {
  await world();
  await holdLockElsewhere();
  try {
    const r = await fieldHandoff({ minutes: 1 });
    assert.equal(r.isError, true, r.text);
    assert.equal(r.error?.code, 'call_deadline'); assert.equal(r.error?.inputDelivery, 'not_sent');
    assert.ok(r.ms < BUDGET, `returned after ${r.ms} ms (budget ${BUDGET})`);
    assert.ok(r.ms >= BUDGET - 60 - 120 - 30, `refused at ${r.ms} ms, before the reserve was reached`);
    assert.equal(log.some(e => /session (hold|click|nativeChrome)/.test(e)), false, `input sent: ${log}`);
    assert.equal(notes.length, 0); assert.equal(await readTask(), null);
    evidence.push(`budget-lock: lock held elsewhere, not_sent after ${r.ms} ms (cut-off ${BUDGET - 180} ms)`);
  } finally { await releaseLockElsewhere(); }
});

add('new', 'lock-early', 'A1 control (needs the budget, so new): the input lock freed while enough budget is left: the field hand-off starts and returns within the budget', async () => {
  await world();
  await holdLockElsewhere();
  setTimeout(() => { releaseLockElsewhere(); }, 120);
  const r = await fieldHandoff({ minutes: 1 });
  assertStillWaiting(r, 'after the lock');
  assert.equal(log.filter(e => e === 'session click').length, 1);
});

add('new', 'budget-blockcheck', 'A1: a slow first page check uses the budget: not_sent (call_deadline) within the budget, nothing shown or sent', async () => {
  await world();
  state.slowBlockMs = BUDGET + 200;
  const r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 1 });
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'call_deadline'); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.ok(r.ms < BUDGET, `returned after ${r.ms} ms`);
  assert.equal(sessions, 0); assert.equal(notes.length, 0); assert.equal(await readTask(), null);
});

add('new', 'captcha-between', 'A2: slice → a CAPTCHA appears → read_page → it is gone → read_page: the hand-off reminder (same alert token) and the input gate are still in force', async () => {
  await world();
  const r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.1 });
  assertStillWaiting(r, 'slice');
  const own = await readTask();
  state.blocked[10] = { kind: 'captcha', vendor: '', evidence: 'fixture check' };
  const blocked = await call('read_page', { tab: 10 });
  assert.equal(blocked.isError, true); assert.equal(blocked.error?.code, 'site_blocked');
  const during = await within(call('press_key', { tab: 10, key: 'enter' }), 2000, 'press_key during the challenge');
  assert.equal(during.error?.code, 'handoff_pending', `the gate followed the replaced reminder: ${during.text}`);
  delete state.blocked[10];
  const clean = await call('read_page', { tab: 10 });
  assert.equal(clean.isError, false, clean.text);
  const after = await readTask();
  assert.equal(after?.alert, own.alert, 'the hand-off reminder is gone after the challenge came and went');
  assert.equal(after?.alertToken, own.alertToken);
  const gated = await within(call('press_key', { tab: 10, key: 'enter' }), 2000, 'press_key');
  assert.equal(gated.error?.code, 'handoff_pending', `the gate was lifted: ${gated.text}`);
  const again = await wfu({ tab: 10, resume: tokenOf(r.text) });
  assertStillWaiting(again, 'resume after the challenge');
});

add('new', 'pause-parked', 'A3: a menu-bar pause between slices, with no call: within the watch interval the highlight is withdrawn and the hand-off ends; the old token then answers "ended", no new wait', async () => {
  await world();
  const r = await fieldHandoff({ minutes: 0.1 });
  assertStillWaiting(r, 'field slice');
  assert.ok(state.armed);
  writeSettings({ paused: true });
  try {
    const t = Date.now();
    await until(async () => state.armed === null && (await readTask()) === null, 1000, 'pause noticed with no call');
    evidence.push(`pause-parked: highlight withdrawn ${Date.now() - t} ms after the pause, no call`);
    assert.ok(log.some(e => e.includes('disarm')));
    assert.equal(idx.__handoffsForTests?.().size, 0);
  } finally { writeSettings({ paused: false }); }
  await staleResume({ tab: 10, resume: tokenOf(r.text), reason: '在这个页面登录', minutes: 0.1 }, /结束：用户在菜单栏暂停了 MyChrome/, 'paused token');
});

add('new', 'last-used', 'B: start, resume and end each move lastUsed (no tab argument, so the call entry does not touch it)', async () => {
  await world();
  await T.registerTab(10, url(10), { windowId: 7, agentName: 'handoff-test', now: Date.now() - 3_600_000 });
  const lastUsed = async () => (await T.getTab(10)).lastUsed;
  const t1 = Date.now();
  const r = await wfu({ reason: '在这个页面登录', minutes: 0.03 });
  assertStillWaiting(r, 'start');
  assert.ok(await lastUsed() >= t1, 'start did not move lastUsed');
  const t2 = Date.now();
  await wfu({ resume: tokenOf(r.text) });
  const afterResume = await lastUsed();
  assert.ok(afterResume >= t2, 'resume did not move lastUsed');
  await until(async () => (await readTask()) === null, 2500, 'window end');
  await until(async () => (await lastUsed()) > afterResume, 500, 'end did not move lastUsed');
});


/* ---------------------------------------------------- round 3 (Codex QA r2 A4, B) */

add('new', 'gate-default-tab', 'A4: tab omitted while the handed-off tab is Chrome\'s current tab: not_sent with zero takeover, activation or native mutation', async () => {
  await world();
  const r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.1 });
  assertStillWaiting(r, 'slice');
  log = [];
  for (const [name, args] of [['press_key', { key: 'enter' }], ['click', { marker: 1 }], ['scroll', { direction: 'down' }]]) {
    const x = await within(call(name, args), 2000, name);
    assert.equal(x.error?.code, 'handoff_pending', `${name}: ${x.text}`);
    assert.equal(x.error?.inputDelivery, 'not_sent');
    assert.match(x.text, new RegExp(`resume="${tokenOf(r.text)}"`));
  }
  assert.equal(sessions, 0, 'an input session (takeover) was opened');
  assert.deepEqual(log.filter(e => /^(native|session|eval)/.test(e)), [], `native work before the refusal: ${log}`);
  assert.ok((await readTask())?.alert, 'the refused input ended the hand-off');
});

add('new', 'gate-default-other', 'A4 control: tab omitted while another tab is current: the gate does not refuse it', async () => {
  await world();
  await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.1 });
  state.front = 11;
  const x = await within(call('press_key', { key: 'enter' }), 3000, 'press_key other tab');
  assert.notEqual(x.error?.code, 'handoff_pending', x.text);
});

add('new', 'stop-parked', 'B: a Stop (Esc twice) recorded between slices, with no call: the highlight is withdrawn and the hand-off ends; the old token answers "ended", no new wait', async () => {
  await world();
  const r = await fieldHandoff({ minutes: 0.1 });
  assertStillWaiting(r, 'field slice');
  idx.__setTaskCancelledForTests?.('some task');
  try {
    const t = Date.now();
    await until(async () => state.armed === null && (await readTask()) === null, 1000, 'Stop noticed with no call');
    evidence.push(`stop-parked: highlight withdrawn ${Date.now() - t} ms after the Stop, no call`);
    assert.equal(idx.__handoffsForTests?.().size, 0);
  } finally { idx.__setTaskCancelledForTests?.(null); }
  await staleResume({ tab: 10, resume: tokenOf(r.text), reason: '在这个页面登录', minutes: 0.1 }, /结束：用户停止了任务/, 'stopped token');
});


/* ---------------------------------------------------- round 3b: stale resume tokens (meeting 11-01 #4) */

add('new', 'stale-window-end', '3b: a resume after the window ran out (no call meanwhile) answers "ended: window", no new wait', async () => {
  await world();
  const r = await wfu({ tab: 10, field: 1, reason: '短信验证码', minutes: 0.02 });
  assertStillWaiting(r, 'slice');
  await until(async () => (await readTask()) === null, 2000, 'window end');
  await sleep(30);
  await staleResume({ tab: 10, field: 1, reason: '短信验证码', resume: tokenOf(r.text) }, /结束：交接窗口到时/, 'expired token');
  assert.equal(state.armed, null, 'a highlight was armed again');
});

add('new', 'stale-done', '3b: a resume after the hand-off already reported its result answers "ended: done", no new wait', async () => {
  await world();
  const r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.1 });
  assertStillWaiting(r, 'slice');
  setTimeout(() => { state.urls[10] = 'https://shop.test/home'; }, 40);
  const done = await wfu({ tab: 10, resume: tokenOf(r.text) });
  assert.match(done.text, /^✅ 页面已经变了/);
  await staleResume({ tab: 10, resume: tokenOf(r.text), reason: '在这个页面登录' }, /结束：那次观察已经有结果/, 'done token');
});

add('new', 'stale-unknown', '3b: an unknown token (not issued here) answers "unknown", no new wait, even with a reason', async () => {
  await world();
  await staleResume({ tab: 10, resume: 'not-a-token', reason: '在这个页面登录', minutes: 0.1 }, /resume 令牌未知/, 'unknown token');
});

add('new', 'stale-other-tab', '3b: a live token given with another tab answers "belongs to tab 10", starts nothing, and leaves the live hand-off pending', async () => {
  await world();
  const r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.1 });
  assertStillWaiting(r, 'slice');
  await staleResume({ tab: 11, resume: tokenOf(r.text), reason: 'x' }, /属于标签 10 的交接，不是标签 11/, 'other tab');
  assertStillWaiting(await wfu({ tab: 10, resume: tokenOf(r.text) }), 'the live hand-off still resumes');
});

/* -------------------------------------------------- kept behaviour */

add('kept', 'short-window', 'a window shorter than the budget runs out in one call with the same receipt as before and takes its reminder down', async () => {
  await world();
  idx.__setCallBudgetForTests?.(2000);   // the shortest window (0.01 min = 600 ms) inside the budget
  let r;
  try { r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 0.003 }, {}, 3000); }
  finally { idx.__setCallBudgetForTests?.(BUDGET); }
  assert.equal(r.isError, false);
  assert.match(r.text, /^⏳ 等了 [\d.]+ 分钟，用户还没处理（在这个页面登录）。本次观察已结束/);
  assert.match(r.text, /若用户仍希望等待，可再调用 wait_for_user 观察，或者结束任务并告诉用户卡在哪里。不要自己去点验证码。$/m);
  assertContinuationRequired(r.text);
  assert.equal(await readTask(), null);
});

add('kept', 'done-in-slice', 'the page moving on within the first slice ends observation with the same receipt as before', async () => {
  await world();
  setTimeout(() => { state.urls[10] = 'https://shop.test/home'; }, 60);
  const r = await wfu({ tab: 10, reason: '在这个页面登录', minutes: 1 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^✅ 页面已经变了（shop\.test），等了 \d+ 秒。本次观察已结束，这不代表收到继续授权。/);
  assert.equal(await readTask(), null);
});

for (const kind of ['new', 'kept']) {
  console.log(kind === 'new' ? 'new fix (fails with the source change reverted)' : 'kept behaviour');
  for (const c of cases.filter(x => x.kind === kind && (!ONLY || x.name === ONLY))) {
    await c.fn();
    passed++;
    console.log(`  ok  [${c.name}] ${c.label}`);
  }
}
assert.ok(passed > 0, `no case named ${ONLY}`);
idx.__resetPanelTaskForTests();
for (const line of evidence) console.log(`  evidence  ${line}`);
console.log(`\nhandoff-slices tests passed (${passed}).`);
process.exit(0);
