#!/usr/bin/env node
/* Input tools within one call budget (contract HI1, problems-20261101): the waits before any input (this connection's
 * queue, the input lock, the user still typing, retries in place such as Secure Input) end with the call budget and
 * refuse not_sent (call_deadline); type_text's send estimate (keys and paste each by its own path, in the mode and
 * speed resolved at the last check) is compared with what is left before the hold, activation, focus click or Cmd+A;
 * typing that has started is never stopped by the budget. Round 3 (contract HI v3): the budget is checked at stage boundaries;
 * a stage that has started runs to its end, and nothing of the call runs on after it returns.
 * Time is scaled: CHROME_BRIDGE_CALL_BUDGET_MS=6000 (reserve 600 ms, preparation 1200 ms) stands for 100 s; the send
 * estimates are real (keys about 300 ms a character at 1x). Production callTool with a fake bridge; nothing reaches
 * Chrome or the input helper. BUDGET_CASE=<name> runs one case (the coordinator's revert check). */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const BUDGET = 6000, RESERVE = 600, PREPARE = 1200;
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-input-budget-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
process.env.CHROME_BRIDGE_NOTIFY = '0';
process.env.CHROME_BRIDGE_AGENT_NAME = 'budget-test';
process.env.CHROME_BRIDGE_HABITS = 'off';
process.env.CHROME_BRIDGE_MENUBAR = '0';
process.env.CHROME_BRIDGE_LANG = 'zh';
process.env.CHROME_BRIDGE_CALL_BUDGET_MS = String(BUDGET);
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const idx = await import('../src/index.js');
const T = await import('../src/tabs.js');
const { writeSettings } = await import('../src/settings.js');
const ONLY = process.env.BUDGET_CASE || null;
let passed = 0;
const evidence = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------ fixture */

let state, log, logAt, sessions, pending = 0;
const note = e => { log.push(e); logAt.push(Date.now()); };
/** A slow fake stage; `pending` lets a case wait until every one has settled. */
async function slow(ms) { pending++; try { await sleep(ms); } finally { pending--; } }
const target = id => ({ tabId: id, windowId: 7, chromePid: 42, cgWindow: 70, tabActive: !state.inactive,
  bounds: { left: 0, top: 0, width: 1200, height: 900 }, url: state.urls[id], title: `t${id}` });
function page(kind, vars, tab) {
  const t = target(tab == null ? 10 : Number(tab));
  if (kind === 'block') return { ok: true, blocked: state.blocked || null, target: t };
  if (kind === 'temporal') return { ok: true, fail: 'not_temporal', target: t };
  // click's preflight (locate, arm the delivery listener): read-only, so a late preflight can finish in the fake.
  if (kind === 'locate') return { bounds: t.bounds, view: { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900 },
    aim: { x: 100, y: 112 }, rect: { x: 10, y: 100, width: 200, height: 24 }, visible: { x: 10, y: 100, width: 200, height: 24 }, hitOk: true, chain: [], target: t };
  if (kind === 'ack') return { ok: true, armed: true, target: t };
  if (kind === 'native-select') return { ok: true, nativeSelect: false, hasFocus: true, target: t };   // FOCUS4: the page owns keyboard focus
  if (kind === 'after') {
    const expect = vars.EXPECT;
    return { ok: true, hasFocus: true, activeEditable: true, activeIsTarget: true, bindingMatches: true, selectionStable: true,
      selectionAll: true, href: t.url, focusMoved: false, changed: state.value !== '',
      fieldHasText: expect != null && state.value.endsWith(expect), confirmedChars: expect != null ? [...expect].length : 0, target: t };
  }
  throw new Error(`unexpected page script ${kind}`);
}
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in budget test`); }]));
  return Object.assign(fake, {
    pageDialog: async () => {
      note('dialog probe');
      state.dialogCalls = (state.dialogCalls || 0) + 1;
      if (state.slowDialogMs) { const ms = state.slowDialogMs; state.slowDialogMs = 0; await slow(ms); }
      if (state.slowDialog?.call === state.dialogCalls) await slow(state.slowDialog.ms);
      return { ok: true, open: false };
    },
    ensureScreenAwake: async () => { note('screen check'); return { locked: false, displays: 1, woke: false }; },
    axInput: async ({ point } = {}) => {
      note(point === undefined ? 'ax probe (menu)' : 'ax probe');
      if (state.slowAxMs && point === undefined) { const ms = state.slowAxMs; state.slowAxMs = 0; await slow(ms); }
      // A native popup blocks Chrome's Apple Events, so window reads fail from here on (as live).
      if (state.nativePopup) state.infoThrows = true;
      return { ok: true, frontmost: true, windowMatches: true, nodeFound: true, documentToken: 'doc1', focusedDocumentToken: 'doc1',
        menuOpen: !!state.menuOpen, menuState: state.menuOpen ? 'open' : 'closed',   // FOCUS4 r2 A2: the probe's explicit menu state
        nativeMenuOpen: !!state.menuOpen, nativePopup: !!state.nativePopup };
    },
    pageScript: async (kind, vars = {}) => `fakePage(${JSON.stringify(kind)}, ${JSON.stringify(vars)})`,
    evalInPage: async (src, tab) => {
      const kinds = [...src.matchAll(/fakePage\("(\w+)"/g)].map(m => m[1]);
      note(`eval ${kinds.join('+')}`);
      if (state.slowEval) { const f = state.slowEval; state.slowEval = null; await f(); }
      if (kinds[0] === 'block' && state.slowBlock) {
        const b = state.slowBlock; state.slowBlock = null; await slow(b.ms); state.blocked = b.blocked; note('block verdict');
      }
      return JSON.parse(vm.runInNewContext(src, { fakePage: (k, v) => JSON.stringify(page(k, v, tab)) }));
    },
    chromeInfo: async (tab) => {
      state.infoCalls = (state.infoCalls || 0) + 1;
      if (state.infoThrows) throw Object.assign(new Error('chromectl: no window (fixture)'), { code: 'chrome_error' });
      if (state.slowInfo) { const f = state.slowInfo; state.slowInfo = null; pending++; try { await f(); } finally { pending--; } }
      return target(tab == null ? 10 : Number(tab));
    },
    listTabs: async () => ({ ok: true, frontmost: 'WeChat', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
      tabs: Object.keys(state.urls).map(id => ({ id: Number(id), url: state.urls[id], title: `t${id}`, active: Number(id) === 10 })) }] }),
    openInputSession: async () => {
      sessions++;
      if (state.slowSessionMs) { const ms = state.slowSessionMs; state.slowSessionMs = 0; await slow(ms); }
      let held = false;
      return {
        request: async req => {
          note(`session ${req.op}`);
          if (req.op === 'nativeChrome') note(`write ${req.intent?.kind}`);   // a native write actually sent
          // A stuck activation: its write was sent and the helper has not answered yet (the call ahead in the queue cases).
          if (req.op === 'nativeChrome' && req.intent?.kind === 'activate') state.afterActivateWrite?.();
          if (req.op === 'nativeChrome' && req.intent?.kind === 'activate' && state.hangActivate) {
            state.hangActivate = false; await new Promise(r => { state.releaseActivate = r; });
          }
          if (req.op === 'bindNativeTarget' && state.slowStatusAfterBindMs) { state.slowNextStatusMs = state.slowStatusAfterBindMs; state.slowStatusAfterBindMs = 0; }
          if (req.op === 'status' && state.slowNextStatusMs) { const ms = state.slowNextStatusMs; state.slowNextStatusMs = 0; await slow(ms); }
          if (req.op === 'inspectDialog') return { ok: true, epoch: 1, known: true, open: true, buttons: ['OK'], hasField: false,
            identity: { dialogToken: 'dlg-1', tabId: 10, windowId: 7, chromePid: 42, cgWindow: 70 } };
          if (req.op === 'hold') {
            if (state.secureInput) return { ok: false, error: 'secure_input' };
            await state.onHold?.();
            held = true; return { ok: true, epoch: 1, pointer: { x: 10, y: 20 }, heldAt: Date.now() };
          }
          if (req.op === 'recordNativeScene') return { ok: true, epoch: 1, restoreToken: 'r'.repeat(64) };
          if (req.op === 'type' || req.op === 'paste') {
            if (state.typeMs) await sleep(state.typeMs);
            state.value += req.op === 'type' ? req.text.replace(/\t/g, '    ') : req.text;
            note(`${req.op} done`);
            return { ok: true, epoch: 1, typed: [...req.text.replace(/\r\n/g, '\n')].length, postedInput: req.text.length };
          }
          if (req.op === 'routed') return { ok: true, allToChrome: true, ms: 1 };
          if (req.op === 'veil') return { ok: true, held, takeover: { active: held } };
          if (req.op === 'restoreClipboard') return { ok: true, restored: true };
          return { ok: true, epoch: 1, operationId: req.operationId, stages: [], inputDelivery: req.op === 'nativeChrome' ? 'sent' : undefined,
            inputMonitor: true, takeover: { active: held }, ...(req.op === 'warp' ? { verified: true, warped: req.to } : {}) };
        },
        close: async () => { note('session close'); held = false; return { ok: true, takeover: { active: false } }; },
      };
    },
    snapshotScene: async () => {
      note('scene');
      if (state.slowSceneMs) { const ms = state.slowSceneMs; state.slowSceneMs = 0; await slow(ms); }
      return { appPid: 99, chromeWindow: 7, chromeTab: 10 };
    },
    restoreScene: async (_scene, options) => { await options.native({ kind: 'restoreScene' }, { policy: 'restore' }); return { ok: true, appFrontmost: true }; },
    activateChrome: async (id, hint, opts) => {
      note(`native activate ${id}`);
      state.onActivate?.();
      await opts.native({ kind: 'activate', tabId: id, windowId: hint.windowId });
      return { ok: true, targetOnTop: true, ...target(id), frontmostPid: 42, keyWindowIsTarget: true,
        geometry: { mode: 'fit-current', beforeBounds: { ...target(id).bounds }, displayId: 1, branch: 'usable', changed: false, possiblyChanged: false } };
    },
    openNavigationObserver: async () => {
      if (state.slowObserverMs) { const ms = state.slowObserverMs; state.slowObserverMs = 0; await slow(ms); }
      return { startedAt: Date.now(), untouched: async () => true, close: async () => {} };
    },
    answerDialog: async (button, text, identity, { native }) => {
      note('answer dialog');
      if (state.slowInnerStatusMs) { state.slowNextStatusMs = state.slowInnerStatusMs; state.slowInnerStatusMs = 0; }
      const r = await native({ kind: 'dialogAnswer', dialogToken: identity.dialogToken, button, text });
      return { ...r, pressed: button, inputDelivery: 'sent', sameStillOpen: false };
    },
    selectTab: async (id, opts) => {
      note(`native selectTab ${id}`);
      await opts.native({ kind: 'selectTab', tabId: id, windowId: opts.windowId });
      state.afterSelectWrite?.();
      state.inactive = false;
      return { ok: true, ...target(id), changed: true };
    },
    cgevent: async (args) => {
      if (args[0] === 'displays') { if (state.slowDisplaysMs) { const ms = state.slowDisplaysMs; state.slowDisplaysMs = 0; note('displays'); await slow(ms); } return { displays: [] }; }
      if (args[0] === 'mousepos') { note('mousepos'); return { x: 10, y: 20 }; }
      if (args[0] === 'escape-menu') { note('escape-menu'); state.menuOpen = false; return { ok: true }; }
      if (args[0] !== 'idle') throw new Error(`B.cgevent ${args[0]} reached in budget test`);
      note('idle');
      if (state.slowIdleMs) { const ms = state.slowIdleMs; state.slowIdleMs = 0; await slow(ms); }
      return state.busy ? { ok: true, idle: 0, keyIdle: 0, held: [] } : { ok: true, idle: 100, keyIdle: 100, held: [], clickIdle: 100 };
    },
  });
}
async function world(settings = {}) {
  // A job's kept hold from an earlier case would poll its session meanwhile.
  for (const t = Date.now(); idx.__taskHoldForTests() && Date.now() - t < 3000;) await sleep(20);
  assert.equal(idx.__taskHoldForTests(), null, 'a job hold leaked from the previous case');
  idx.__resetPanelTaskForTests();
  idx.__resetLedgerForTests();
  idx.__resetTypedForTests();
  idx.__setCallBudgetForTests(BUDGET);
  writeSettings({ inputMode: 'auto', inputSpeed: 1, ...settings });
  state = { urls: { 10: 'https://shop.test/form', 11: 'https://bank.test/login' }, value: '' };
  log = []; logAt = []; sessions = 0;
  idx.__setBridgeForTests(fakeBridge());
  await T.registerTab(10, state.urls[10], { windowId: 7, agentName: 'budget-test' });
  await T.registerTab(11, state.urls[11], { windowId: 7, agentName: 'budget-test' });
}
const call = async (name, args = {}, extra = {}) => {
  const started = Date.now();
  const r = await idx.callTool({ params: { name, arguments: args } }, extra);
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError,
    error: r.structuredContent?.error || null, ms: Date.now() - started, at: Date.now() };
};
/** Native writes actually sent (not the refusal's own restore) and the menu Esc. */
const writes = () => log.filter(e => /^write (?!restoreScene)/.test(e) || e === 'escape-menu');
/** Round 3, every new case: once every slow fake has settled, plus 300 ms, nothing of the call ran after it returned. */
async function nothingAfter(r, label, ignore = null) {
  for (const t = Date.now(); pending > 0 && Date.now() - t < 10_000;) await sleep(10);
  assert.equal(pending, 0, `${label}: fakes still pending`);
  await sleep(300);
  const late = log.filter((e, i) => logAt[i] > r.at && !(ignore && ignore.test(e)));
  assert.deepEqual(late, [], `${label}: ran after the call returned: ${late}`);
}
async function within(promise, ms, label) {
  let timer;
  const r = await Promise.race([promise, new Promise(res => { timer = setTimeout(res, ms, 'TIMED_OUT'); })]);
  clearTimeout(timer);
  assert.notEqual(r, 'TIMED_OUT', `${label}: still running after ${ms} ms`);
  return r;
}
const run = (name, args, limit = BUDGET + 3000) => within(call(name, args), limit, `${name} ${JSON.stringify(args).slice(0, 60)}`);
/** Anything that changes what the user sees or sends input: the hold, activation, a click, a key, typing or pasting. */
const INPUT = /^(session (hold|click|key|type|paste|wheel|move|nativeChrome)|native activate)/;
function assertNotSent(r, label) {
  assert.equal(r.isError, true, `${label}: ${r.text}`);
  assert.equal(r.error?.code, 'call_deadline', `${label}: ${r.text}`);
  assert.equal(r.error?.inputDelivery, 'not_sent', label);
  assert.match(r.text, /没有发送任何输入/, label);
  assert.ok(r.ms < BUDGET, `${label}: returned after ${r.ms} ms (budget ${BUDGET})`);
  assert.deepEqual(log.filter(e => INPUT.test(e)), [], `${label}: input before the refusal: ${log}`);
  assert.equal(state.value, '', `${label}: text reached the field`);
}
const LOCK = process.env.CHROME_BRIDGE_LOCK;
async function holdLockElsewhere() {
  await mkdir(LOCK, { recursive: true });
  await writeFile(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.ppid, since: Date.now(), label: 'other agent', token: 'other-token' }));
}
const releaseLockElsewhere = () => rm(LOCK, { recursive: true, force: true });

const cases = [];
const add = (kind, name, label, fn) => cases.push({ kind, name, label, fn });

/* ------------------------------------------------------------ new fix */

add('new', 'estimate-entry', 'keys whose estimate exceeds the budget: not_sent at once with the duration and how to split, nothing evaluated, held or activated', async () => {
  await world();
  const text = 'x'.repeat(40);   // 40 × 300 ms = 12 s against 6 s
  const r = await run('type_text', { tab: 10, text, input_mode: 'keys', replace: true, submit: true });
  assertNotSent(r, 'estimate');
  assert.match(r.text, /逐键输入预计约 12 秒/);
  assert.match(r.text, /同一个 task_plan 里分几次调用 type_text（每段约 14 个字符以内）/);
  assert.match(r.text, /replace 只用在第一段，submit 只用在最后一段/);
  assert.equal(sessions, 0, 'an input session was opened');
  assert.deepEqual(log, [], `reached the page or Chrome: ${log}`);
  await nothingAfter(r, 'estimate');
  evidence.push(`estimate-entry: 40 keys (12 s) refused after ${r.ms} ms, zero evals, sessions or activation`);
});

add('new', 'keys-vs-paste', 'keys and paste are estimated by their own paths: 2,000 characters pasted fit (one Cmd+V), the same text by keys does not', async () => {
  await world();
  const text = 'a'.repeat(2000);
  const keys = await run('type_text', { tab: 10, text, input_mode: 'keys' });
  assertNotSent(keys, 'keys');
  await nothingAfter(keys, 'keys');
  assert.match(keys.text, /逐键输入预计约 600 秒/);
  await world();
  const paste = await run('type_text', { tab: 10, text, input_mode: 'paste' });
  assert.equal(paste.isError, false, paste.text);
  assert.match(paste.text, /一次 Cmd\+V 整段粘贴 2000 个字符/);
  assert.equal(state.value, text);
  assert.equal(log.filter(e => e === 'paste done').length, 1);
  await nothingAfter(paste, 'paste');
  evidence.push(`keys-vs-paste: 2000 chars keys refused (${keys.ms} ms); paste typed in ${paste.ms} ms`);
});

add('new', 'mode-after-queue', 'queued for the input lock as paste, the setting changes to keys meanwhile: the last check uses keys and refuses before the hold or activation', async () => {
  await world({ inputMode: 'paste' });
  await holdLockElsewhere();
  try {
    setTimeout(() => writeSettings({ inputMode: 'keys' }), 200);
    setTimeout(() => { releaseLockElsewhere(); }, 400);
    const r = await run('type_text', { tab: 10, text: 'y'.repeat(30) });   // paste ≈ 1.9 s fits; keys 9 s does not
    assertNotSent(r, 'mode change');
    assert.match(r.text, /逐键输入（预计约 9 秒）|逐键输入预计约 9 秒/);
    await nothingAfter(r, 'mode change');
    evidence.push(`mode-after-queue: paste→keys while queued, refused after ${r.ms} ms with no hold or activation (${log.join(', ')})`);
  } finally { await releaseLockElsewhere(); }
});

add('new', 'speed-after-queue', 'queued at 3x, the speed changes to 1x meanwhile: the estimate at the last check uses 1x and refuses before any input', async () => {
  await world({ inputSpeed: 3 });
  await holdLockElsewhere();
  try {
    setTimeout(() => writeSettings({ inputSpeed: 1 }), 200);
    setTimeout(() => { releaseLockElsewhere(); }, 400);
    const r = await run('type_text', { tab: 10, text: 'z'.repeat(30), input_mode: 'keys' });   // 3.3 s at 3x fits; 9 s at 1x does not
    assertNotSent(r, 'speed change');
    assert.match(r.text, /预计约 9 秒/);
    await nothingAfter(r, 'speed change');
    evidence.push(`speed-after-queue: 3x→1x while queued, refused after ${r.ms} ms`);
  } finally { await releaseLockElsewhere(); }
});

add('new', 'lock', 'the input lock is held elsewhere past the budget: not_sent at the cut-off (budget less the reserves), within the budget', async () => {
  for (const [name, args] of [['click', { tab: 10, marker: 1 }], ['press_key', { tab: 10, key: 'enter' }], ['type_text', { tab: 10, text: 'abc' }]]) {
    await world();
    await holdLockElsewhere();
    try {
      const r = await run(name, args);
      assertNotSent(r, name);
      const send = name === 'type_text' ? 900 : 0;
      assert.ok(r.ms >= BUDGET - RESERVE - PREPARE - send - 50, `${name}: refused at ${r.ms} ms, before its cut-off`);
      assert.match(r.text, /排队、等用户停手或输入前的检查用掉了这次调用/);
      await nothingAfter(r, name);
      evidence.push(`lock ${name}: not_sent after ${r.ms} ms (cut-off ${BUDGET - RESERVE - PREPARE - send} ms)`);
    } finally { await releaseLockElsewhere(); }
  }
});

add('new', 'idle', 'the user never stops typing: the hands-off wait ends at the cut-off, not_sent, nothing held', async () => {
  await world();
  state.busy = true;
  const r = await run('press_key', { tab: 10, key: 'tab' });
  assertNotSent(r, 'idle');
  await nothingAfter(r, 'idle');
  evidence.push(`idle: not_sent after ${r.ms} ms`);
});

add('new', 'connection-queue', 'queued behind this connection\'s call (stuck in its activation) past the budget: not_sent within the budget; the call ahead is not stopped by its own budget', async () => {
  await world();
  state.hangActivate = true;
  const ahead = call('press_key', { tab: 10, key: 'tab' });
  for (const t = Date.now(); !state.releaseActivate && Date.now() - t < 3000;) await sleep(10);
  assert.ok(state.releaseActivate, 'the first call never reached its activation');
  const mark = log.length;
  const r = await run('scroll', { tab: 10, direction: 'down' });
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.ok(r.ms < BUDGET, `returned after ${r.ms} ms`);
  assert.match(r.text, /排在同一 MCP 连接前面的调用/);
  assert.deepEqual(log.slice(mark).filter(e => INPUT.test(e)), [], `queued call sent input: ${log.slice(mark)}`);
  evidence.push(`connection-queue: not_sent after ${r.ms} ms`);
  // A text that can never fit, queued behind it: the split advice, not "call again" (Codex QA B).
  const long = await run('type_text', { tab: 10, text: 'v'.repeat(40), input_mode: 'keys' });
  assert.equal(long.error?.code, 'call_deadline', long.text);
  assert.match(long.text, /逐键输入预计约 12 秒/); assert.match(long.text, /同一个 task_plan 里分几次调用 type_text/);
  assert.doesNotMatch(long.text, /可以直接再调用一次/);
  await sleep(300);   // the call ahead is still stuck: anything logged now would be the refused calls'
  assert.deepEqual(log.filter((_, i) => logAt[i] > r.at), [], `ran after the queued calls returned: ${log}`);
  await sleep(Math.max(0, BUDGET - 4500));   // the call ahead is now past its own budget, activated: it continues
  state.releaseActivate();
  const first = await within(ahead, 5000, 'call ahead');
  assert.equal(first.isError, false, first.text);
  assert.ok(log.includes('session key'), 'the call ahead was stopped');
});

add('new', 'secure-input', 'Secure Input on (a password field) keeps refusing the hold: retries in place end with the budget, not after 120 s', async () => {
  await world();
  state.secureInput = true;
  const r = await run('press_key', { tab: 10, key: 'enter' });
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.ok(r.ms < BUDGET, `returned after ${r.ms} ms`);
  assert.match(r.text, /等安全输入（例如密码框）或锁屏结束用掉了这次调用/);
  assert.ok(log.filter(e => e === 'session hold').length >= 2, 'not retried in place');
  assert.equal(log.some(e => /^(session (click|key)|native activate)/.test(e)), false);
  await nothingAfter(r, 'secure input');
  evidence.push(`secure-input: ${log.filter(e => e === 'session hold').length} refused holds, call_deadline after ${r.ms} ms`);
});

add('new', 'task-hold', 'a job\'s kept hold reused: the mode changes to keys while the page check runs; refused before activation or any key, and the job keeps its hold', async () => {
  await world({ inputMode: 'paste' });
  const first = await run('press_key', { tab: 10, key: 'tab', task: 'budget job' });
  assert.equal(first.isError, false, first.text);
  const hold = idx.__taskHoldForTests();
  assert.ok(hold?.kept, 'no job hold after the first action');
  const mark = log.length;
  state.slowEval = async () => { writeSettings({ inputMode: 'keys' }); await sleep(50); };
  const r = await run('type_text', { tab: 10, text: 'q'.repeat(30), task: 'budget job' });
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.match(r.text, /逐键输入（预计约 9 秒）|逐键输入预计约 9 秒/);
  assert.deepEqual(log.slice(mark).filter(e => INPUT.test(e) || e === 'session revokeNative' || e === 'session close'), [],
    `input, revoke or release before the refusal: ${log.slice(mark)}`);
  assert.equal(idx.__taskHoldForTests(), hold, 'the job lost its hold');
  assert.equal(state.value, '');
  await nothingAfter(r, 'task hold');
  evidence.push(`task-hold: refused in the kept hold after ${r.ms} ms; hold kept, no revoke`);
  await idx.callTool({ params: { name: 'task_plan', arguments: { task: 'budget job', done: true } } }, {});
});

add('new', 'mode-locked', 'A3 (r3c): the mode changes to keys after the first write (the activation) was sent: the paste checked at that write is what runs; nothing is refused after a write. Changed before the write: refused with zero writes', async () => {
  // Before the first write: the chokepoint, the last check, resolves keys (9 s, does not fit): refused, zero writes.
  await world({ inputMode: 'paste' });
  state.onActivate = () => writeSettings({ inputMode: 'keys' });
  const before = await run('type_text', { tab: 10, text: 'w'.repeat(30) });
  assert.equal(before.error?.code, 'call_deadline', before.text); assert.equal(before.error?.inputDelivery, 'not_sent');
  assert.match(before.text, /逐键输入预计约 9 秒/);
  assert.deepEqual(writes(), [], `a write after the mode change: ${log}`);
  await nothingAfter(before, 'mode change before the first write');
  // After the first write: the checked paste runs.
  await world({ inputMode: 'paste' });
  state.afterActivateWrite = () => writeSettings({ inputMode: 'keys' });
  const r = await run('type_text', { tab: 10, text: 'w'.repeat(30) });   // keys (9 s) would not fit; paste (1.9 s) was checked
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /一次 Cmd\+V 整段粘贴 30 个字符/);
  assert.equal(log.filter(e => e === 'paste done').length, 1); assert.equal(log.includes('type done'), false);
  assert.equal(state.value, 'w'.repeat(30));
  await nothingAfter(r, 'mode locked');
  evidence.push(`mode-locked: keys chosen during activation; the checked paste ran (${r.ms} ms)`);
});

add('new', 'mode-change-zero-activation', 'A3: whenever the mode or speed that will run does not fit, the refusal comes with zero activation', async () => {
  for (const [settings, change, args] of [[{ inputMode: 'paste' }, { inputMode: 'keys' }, { text: 'u'.repeat(30) }],
    [{ inputSpeed: 3 }, { inputSpeed: 1 }, { text: 'u'.repeat(30), input_mode: 'keys' }]]) {
    await world(settings);
    state.slowEval = async () => { writeSettings(change); };   // changes during the first page check, before the last check
    const r = await run('type_text', { tab: 10, ...args });
    assertNotSent(r, JSON.stringify(change));
    assert.equal(log.some(e => /^native activate/.test(e)), false, `activated before the refusal: ${log}`);
    await nothingAfter(r, JSON.stringify(change));
  }
});

const QUEUE = path.join(path.dirname(LOCK), 'input.lock.queue');
const CUT = BUDGET - RESERVE - PREPARE;   // the cut-off with no send estimate
/** The holder offers its takeover to our ticket (lock.js protocol 2) and has already cancelled that offer. */
function offerWithdrawn() {
  return (async () => {
    for (const t = Date.now(); Date.now() - t < 3000; await sleep(20)) {
      const mine = (await readdir(QUEUE).catch(() => [])).filter(n => n.endsWith('.json') && !n.startsWith('.'));
      if (!mine.length) continue;
      await writeFile(path.join(QUEUE, '.decision-w1.json'), JSON.stringify({ protocol: 2, cancel: true }));
      await writeFile(path.join(LOCK, 'handoff.json'), JSON.stringify({ protocol: 2, id: 'w1', from: 'other-token', to: mine[0], at: Date.now(),
        scene: { appPid: 99, chromeWindow: 7, chromeTab: 10 }, pointer: { x: 10, y: 20 } }));
      return mine[0];
    }
    return null;
  })();
}
const myTickets = async () => (await readdir(QUEUE).catch(() => []))
  .filter(n => n.endsWith('.json') && !n.startsWith('.') && n.includes(`-${String(process.pid).padStart(7, '0')}-`));
async function withdrawnHandover({ lateClaim, task = null }) {
  await world();
  await holdLockElsewhere();
  try {
    const offering = offerWithdrawn();
    const started = Date.now();
    // Withdrawn: the offer goes, the lock stays held. lateClaim: the claim's answer comes after the cut-off.
    state.onHold = async () => { await rm(path.join(LOCK, 'handoff.json'), { force: true });
      if (lateClaim) { pending++; try { await sleep(Math.max(0, CUT + 100 - (Date.now() - started))); } finally { pending--; } } };
    const r = await run('press_key', { tab: 10, key: 'tab', ...(task ? { task } : {}) });
    assert.ok(await offering, 'no ticket to offer to');
    assert.equal(log.filter(e => e === 'session hold').length, 1, `the offer was not taken up: ${log}`);
    assert.equal(r.error?.code, 'call_deadline', `${lateClaim}: ${r.text}`); assert.equal(r.error?.inputDelivery, 'not_sent');
    assert.ok(r.ms < BUDGET, `returned after ${r.ms} ms (budget ${BUDGET})`);
    assert.equal(log.some(e => /^(session (click|key|type|paste)|native activate)/.test(e)), false, `input sent: ${log}`);
    await nothingAfter(r, 'withdrawn');
    assert.deepEqual(await myTickets(), [], 'this process left a queue ticket behind');
    return r;
  } finally { await releaseLockElsewhere(); await rm(path.join(QUEUE, '.decision-w1.json'), { force: true }); }
}

add('new', 'withdrawn-handover', 'A1 (r2): the holder withdraws its offered takeover after this call\'s last check: the re-queue (or the withdrawal seen after the cut-off) ends by the same absolute deadline', async () => {
  for (const lateClaim of [false, true]) {
    const r = await withdrawnHandover({ lateClaim });
    evidence.push(`withdrawn-handover${lateClaim ? ' (answer after the cut-off)' : ''}: call_deadline after ${r.ms} ms`);
  }
});

/* ------------------------------------------------------------ round 3 (HI v3, Fable ruling §3) */

add('new', 'withdrawn-handover-task', 'r3 #1: in a job (taskRun) the withdrawal is seen after the cut-off: call_deadline, no ticket of this process left, and the next call gets the lock at once', async () => {
  const r = await withdrawnHandover({ lateClaim: true, task: 'budget job' });
  const next = await run('press_key', { tab: 10, key: 'tab', task: 'budget job' });
  assert.equal(next.isError, false, `the next call did not get the lock: ${next.text}`);
  assert.ok(next.ms < 1500, `the next call waited ${next.ms} ms for the lock`);
  await idx.callTool({ params: { name: 'task_plan', arguments: { task: 'budget job', done: true } } }, {});
  evidence.push(`withdrawn-handover-task: call_deadline after ${r.ms} ms; no ticket left; next press_key done in ${next.ms} ms`);
});

add('new', 'acquire-aborted-ticket', 'r3 #2: lock.js: a ticket kept from a withdrawn hand-over, passed to an acquisition whose signal has already ended, is removed (no beating leftover)', async () => {
  await world();
  const L = await import('../src/lock.js');
  await holdLockElsewhere();
  try {
    const offering = offerWithdrawn();
    const lease = await within(L.acquireLease('fixture', { inherit: true, info: {} }), 4000, 'acquireLease with an offer');
    assert.ok(await offering);
    assert.ok(lease.handoff, 'no hand-over offered');
    assert.equal(await lease.claim(), false, 'the cancelled offer was claimed');
    const ticket = lease.ticket;
    assert.ok(ticket, 'no ticket kept');
    await lease.release({ keepTicket: true });
    assert.deepEqual(await myTickets(), [ticket.name], 'the kept ticket is not in the queue');
    const ac = new AbortController(); ac.abort();
    await assert.rejects(L.acquireLease('fixture', { ticket, signal: ac.signal }), e => e.code === 'cancelled');
    await sleep(2500);   // longer than a ticket beat (2 s): a leftover would have been written again
    assert.deepEqual(await myTickets(), [], 'the passed ticket was left behind, beating');
  } finally { await releaseLockElsewhere(); await rm(path.join(QUEUE, '.decision-w1.json'), { force: true }); }
});

const STAGE = 1500;   // the longest pre-input stage timeout (chromectl 25 s of 100 s), scaled
const CAPTCHA = { kind: 'captcha', vendor: '', evidence: 'fixture check' };
add('kept', 'slow-site-gate-blocked', 'r3 #3 (passes at HEAD, which has no budget; RED for the r2 race, mutation R3-3): the site check starts before the cut-off and returns "blocked" after it: the receipt is site_blocked (the verdict), nothing waits, holds or runs after the return', async () => {
  await world();
  state.slowDialogMs = CUT - 400;                       // the dialog probe ends just before the cut-off
  state.slowBlock = { ms: 1200, blocked: CAPTCHA };      // the site check runs across it
  const r = await run('press_key', { tab: 10, key: 'tab' });
  assert.equal(r.error?.code, 'site_blocked', r.text);
  assert.ok(r.ms <= CUT + STAGE, `returned after ${r.ms} ms (cut-off ${CUT} + stage ${STAGE})`);
  assert.ok(log.includes('block verdict'));
  assert.equal(log.some(e => e === 'idle' || /^session /.test(e) || /^native /.test(e)), false, `a later stage ran: ${log}`);
  assert.deepEqual(await myTickets(), [], 'queued for the lock');
  await nothingAfter(r, 'slow site gate blocked');
  // (b, Codex QA r3 B) A job's kept hold exists: the verdict ends it (restore, hand back) inside the call; nothing after.
  await world();
  const first = await run('press_key', { tab: 10, key: 'tab', task: 'budget job' });
  assert.equal(first.isError, false, first.text);
  assert.ok(idx.__taskHoldForTests(), 'no job hold to end');
  state.slowDialogMs = CUT - 400;
  state.slowBlock = { ms: 1200, blocked: CAPTCHA };
  const mark = log.length;
  const r2 = await run('press_key', { tab: 10, key: 'tab', task: 'budget job' });
  assert.equal(r2.error?.code, 'site_blocked', r2.text);
  assert.ok(r2.ms <= CUT + STAGE, `returned after ${r2.ms} ms`);
  assert.equal(idx.__taskHoldForTests(), null, 'the job hold was not ended by the verdict');
  assert.ok(log.slice(mark).includes('session close'), `the hold was not released inside the call: ${log.slice(mark)}`);
  assert.equal(log.slice(mark).some(e => /^session (key|click|type|paste)|^native activate/.test(e)), false, `input in the blocked call: ${log.slice(mark)}`);
  await nothingAfter(r2, 'slow site gate blocked, job hold');
  evidence.push(`slow-site-gate-blocked: site_blocked after ${r.ms} ms (cut-off ${CUT}); with a job hold, released inside the call, site_blocked after ${r2.ms} ms; nothing after either return`);
});

add('new', 'slow-site-gate-clear', 'r3 #4: the same, but the page is clear: the next boundary returns call_deadline; no later stage starts', async () => {
  await world();
  state.slowDialogMs = CUT - 400;
  state.slowBlock = { ms: 1200, blocked: null };
  const r = await run('press_key', { tab: 10, key: 'tab' });
  assertNotSent(r, 'slow site gate clear');
  assert.ok(r.ms <= CUT + STAGE, `returned after ${r.ms} ms`);
  assert.ok(log.includes('block verdict'));
  assert.equal(log.some(e => e === 'idle' || /^session /.test(e)), false, `a later stage ran: ${log}`);
  assert.equal(log.indexOf('block verdict'), log.length - 1, `something ran after the site check: ${log}`);
  await nothingAfter(r, 'slow site gate clear');
  // (b) The dialog probe itself runs across the cut-off: the boundaries after it start no screen or site check.
  await world();
  state.slowDialogMs = CUT + 300;
  const r2 = await run('press_key', { tab: 10, key: 'tab' });
  assertNotSent(r2, 'slow dialog probe');
  assert.ok(r2.ms <= CUT + STAGE, `returned after ${r2.ms} ms`);
  assert.deepEqual(log, ['dialog probe'], `a stage started after the cut-off: ${log}`);
  await nothingAfter(r2, 'slow dialog probe');
  evidence.push(`slow-site-gate-clear: call_deadline after ${r.ms} ms, nothing after the site check; a dialog probe across the cut-off: call_deadline after ${r2.ms} ms, no later stage`);
});

add('new', 'slow-preflight', 'r3 #5: (a) the lock comes just before the cut-off and the session start runs across it: the preflight is not started (no window read); (b) the preflight itself runs across the cut-off: it finishes, and the next boundary refuses with no hold or activation', async () => {
  await world();
  await holdLockElsewhere();
  setTimeout(() => { state.infoCalls = 0; state.slowSessionMs = 600; releaseLockElsewhere(); }, CUT - 300);
  const a = await run('click', { tab: 10, marker: 1 });
  assertNotSent(a, 'preflight not started');
  assert.equal(state.infoCalls, 0, 'the preflight read the window after the cut-off');
  await nothingAfter(a, 'slow preflight (a)');
  const idleBefore = process.env.CHROME_BRIDGE_IDLE_S;
  process.env.CHROME_BRIDGE_IDLE_S = '0';   // no hands-off wait: only the boundaries stand between the preflight and the hold
  try {
    await world();
    await holdLockElsewhere();
    // The preflight's last read (its page eval, after the window read) runs across the cut-off.
    setTimeout(() => { state.slowEval = () => slow(STAGE); releaseLockElsewhere(); }, CUT - 1200);
    const b = await run('click', { tab: 10, marker: 1 });
    assertNotSent(b, 'preflight across the cut-off');
    assert.ok(b.ms <= CUT + STAGE, `returned after ${b.ms} ms`);
    assert.equal(log.some(e => /^session hold|^native activate/.test(e)), false, `held or activated: ${log}`);
    await nothingAfter(b, 'slow preflight (b)');
    evidence.push(`slow-preflight: (a) refused after ${a.ms} ms with 0 window reads; (b) refused after ${b.ms} ms, no hold`);
  } finally {
    if (idleBefore === undefined) delete process.env.CHROME_BRIDGE_IDLE_S; else process.env.CHROME_BRIDGE_IDLE_S = idleBefore;
    await releaseLockElsewhere();
  }
});

add('new', 'queue-expired-preread', 'r3 #6: scroll and click_at whose budget ran out in this connection\'s queue read no window (a failing read would be the receipt): call_deadline; with a named tab handed to the user, handoff_pending still', async () => {
  for (const handed of [false, true]) {
    await world();
    let wfu = null;
    if (handed) {
      idx.__setWaitPollForTests(20, 15, 200);
      wfu = await run('wait_for_user', { tab: 11, reason: '在这个页面登录', minutes: 0.5 });
      assert.match(wfu.text, /^⏳ 用户还没处理完/, wfu.text);
    }
    state.hangActivate = true;
    const ahead = call('press_key', { tab: 10, key: 'tab' });
    for (const t = Date.now(); !state.releaseActivate && Date.now() - t < 3000;) await sleep(10);
    assert.ok(state.releaseActivate, 'the first call never reached its activation');
    state.infoCalls = 0; state.infoThrows = true;
    const tab = handed ? 11 : 10;
    const [sc, ca] = await Promise.all([run('scroll', { tab, direction: 'down' }), run('click_at', { tab, x: 5, y: 5 })]);
    for (const [r, name] of [[sc, 'scroll'], [ca, 'click_at']]) {
      assert.equal(r.error?.code, handed ? 'handoff_pending' : 'call_deadline', `${name}: ${r.text}`);
      assert.equal(r.error?.inputDelivery, 'not_sent');
      assert.ok(r.ms < BUDGET, `${name} returned after ${r.ms} ms`);
      if (!handed) assert.match(r.text, /排在同一 MCP 连接前面的调用/);
    }
    assert.equal(state.infoCalls, 0, 'a window was read after the budget ran out');
    await sleep(300);
    assert.deepEqual(log.filter((_, i) => logAt[i] > Math.min(sc.at, ca.at)), [], `ran after the return: ${log}`);
    state.infoThrows = false;
    state.releaseActivate();
    await within(ahead, 5000, 'call ahead');
    evidence.push(`queue-expired-preread${handed ? ' (handed-off tab: handoff_pending)' : ''}: scroll ${sc.ms} ms, click_at ${ca.ms} ms, 0 window reads`);
  }
});

/* ------------------------------------------------------------ round 3b (HI v3.1, Codex QA r3) */

add('new', 'serial-preflight', 'r3b #1: two serial preflight reads, the first running across the cut-off: (a) type_text paste with a marker: no window read after the temporal check; (b) click: no page eval after the window read', async () => {
  // (a) paste (≈1.9 s estimate): its cut-off is CUT − 1900. The lock comes before it; the temporal eval runs across it.
  await world({ inputMode: 'paste' });
  await holdLockElsewhere();
  const cutPaste = CUT - 1900;
  setTimeout(() => { state.infoCalls = 0; state.slowEval = () => slow(1200); releaseLockElsewhere(); }, cutPaste - 800);
  const a = await run('type_text', { tab: 10, marker: 1, text: 'x'.repeat(30) });
  assertNotSent(a, 'temporal then clickPreflight');
  assert.ok(log.some(e => /^eval .*temporal/.test(e)), `the temporal check did not run: ${log}`);
  assert.equal(state.infoCalls, 0, 'clickPreflight read the window after the cut-off');
  assert.equal(log.some(e => /^eval .*(locate|ack)/.test(e)), false, `page evals after the cut-off: ${log}`);
  await nothingAfter(a, 'serial (a)');
  // (b) click: the window read runs across the cut-off; locate / arm are not started.
  await world();
  await holdLockElsewhere();
  setTimeout(() => { state.slowInfo = () => sleep(STAGE); releaseLockElsewhere(); }, CUT - 1200);
  const b = await run('click', { tab: 10, marker: 1 });
  assertNotSent(b, 'chromeInfo then locate');
  assert.ok(b.ms <= CUT + STAGE, `returned after ${b.ms} ms`);
  assert.equal(log.some(e => /^eval .*(locate|ack)/.test(e)), false, `page evals after the cut-off: ${log}`);
  await nothingAfter(b, 'serial (b)');
  await releaseLockElsewhere();
  evidence.push(`serial-preflight: (a) refused after ${a.ms} ms, 0 window reads after the temporal check; (b) refused after ${b.ms} ms, no locate/arm`);
});

add('new', 'menu-esc', 'r3b #2: press_key escape\'s native-menu recovery: the AX probe runs across the cut-off; no Esc is sent after it', async () => {
  await world();
  // A key refused because a native popup is open: the page identity stays cached (guardNativeTarget) for the Esc recovery.
  state.nativePopup = true;
  const first = await run('press_key', { tab: 10, key: 'enter' });
  assert.equal(first.error?.code, 'use_select_option', first.text);
  state.nativePopup = false; state.infoThrows = false; state.menuOpen = true; state.slowAxMs = CUT + 300;
  const mark = log.length;
  const r = await run('press_key', { tab: 10, key: 'escape' });
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.ok(r.ms <= CUT + STAGE, `returned after ${r.ms} ms`);
  assert.deepEqual(log.slice(mark).filter(e => INPUT.test(e)), [], `input in the Esc call: ${log.slice(mark)}`);
  assert.ok(log.slice(mark).includes('ax probe (menu)'), `the recovery path was not taken: ${log.slice(mark)}`);
  assert.equal(log.includes('escape-menu'), false, 'an Esc was sent after the cut-off');
  await nothingAfter(r, 'menu Esc');
  // Control: the same recovery within the budget sends its one Esc.
  await world();
  state.nativePopup = true;
  const again = await run('press_key', { tab: 10, key: 'enter' });
  assert.equal(again.error?.code, 'use_select_option', again.text);
  state.nativePopup = false; state.infoThrows = false; state.menuOpen = true;
  const ok = await run('press_key', { tab: 10, key: 'escape' });
  assert.match(ok.text, /已发送一次 Esc/, ok.text);
  assert.equal(log.filter(e => e === 'escape-menu').length, 1);
  evidence.push(`menu-esc: probe across the cut-off → call_deadline after ${r.ms} ms, no Esc; within budget → one Esc`);
});

add('new', 'slow-hold', 'r3b (B, M11 split): the hold request runs across the cut-off: the boundary before activation refuses; no activation', async () => {
  await world();
  state.onHold = async () => { pending++; try { await sleep(CUT + 300); } finally { pending--; } state.infoCalls = 0; };
  const r = await run('press_key', { tab: 10, key: 'tab' });
  assert.equal(state.infoCalls, 0, 'the preparation read the window after the cut-off');
  // The hold itself started before the cut-off; the refusal's own restore (nativeChrome restoreScene) runs before the return.
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.equal(log.some(e => /^session (click|key|type|paste|wheel|move)/.test(e)), false, `input sent: ${log}`);
  assert.ok(r.ms <= CUT + STAGE, `returned after ${r.ms} ms`);
  assert.equal(log.some(e => /^native activate/.test(e)), false, `activated after the cut-off: ${log}`);
  await nothingAfter(r, 'slow hold');
  evidence.push(`slow-hold: refused after ${r.ms} ms before activation`);
});

add('new', 'slow-target-read', 'r3b (audit): the window read inside the preparation runs across the cut-off: the boundary right before the activation refuses; no activation', async () => {
  await world();
  await holdLockElsewhere();
  setTimeout(() => { state.slowInfo = () => sleep(STAGE); releaseLockElsewhere(); }, CUT - 600);
  const r = await run('press_key', { tab: 10, key: 'tab' });
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.ok(r.ms <= CUT + STAGE, `returned after ${r.ms} ms`);
  assert.equal(log.some(e => /^native activate|^session (click|key|type|paste|wheel|move)/.test(e)), false, `activated or sent: ${log}`);
  await nothingAfter(r, 'slow target read');
  await releaseLockElsewhere();
  evidence.push(`slow-target-read: refused after ${r.ms} ms before activation`);
});

add('new', 'slow-gate-dialog', 'r3b (audit): the site check\'s own dialog probe runs across the cut-off: its page eval does not start', async () => {
  await world();
  state.slowDialog = { call: 2, ms: CUT + 300 };   // call 1 is inputAction's probe, call 2 the site check's
  const r = await run('press_key', { tab: 10, key: 'tab' });
  assertNotSent(r, 'slow gate dialog');
  assert.ok(r.ms <= CUT + STAGE, `returned after ${r.ms} ms`);
  assert.equal(state.dialogCalls, 2);
  assert.equal(log.some(e => /^eval/.test(e)), false, `a page eval started after the cut-off: ${log}`);
  await nothingAfter(r, 'slow gate dialog');
  evidence.push(`slow-gate-dialog: refused after ${r.ms} ms; no page eval`);
});

add('new', 'no-takeover-reads', 'r3b (audit): without takeover (CHROME_BRIDGE_TAKEOVER=0): (a) the idle read runs across the cut-off: no scene read; (b) the scene read runs across it: no pointer read', async () => {
  idx.__setTakeoverForTests(false);
  try {
    await world();
    state.slowIdleMs = CUT + 300;
    const a = await run('press_key', { tab: 10, key: 'tab' });
    assertNotSent(a, 'slow idle read');
    assert.equal(log.includes('scene'), false, `the scene was read after the cut-off: ${log}`);
    await nothingAfter(a, 'no takeover (a)');
    await world();
    state.slowSceneMs = CUT + 300;
    const b = await run('press_key', { tab: 10, key: 'tab' });
    assertNotSent(b, 'slow scene read');
    assert.ok(log.includes('scene'));
    assert.equal(log.includes('mousepos'), false, `the pointer was read after the cut-off: ${log}`);
    await nothingAfter(b, 'no takeover (b)');
    evidence.push(`no-takeover-reads: (a) refused after ${a.ms} ms, no scene read; (b) refused after ${b.ms} ms, no pointer read`);
  } finally { idx.__setTakeoverForTests(true); }
});

add('new', 'scroll-preread-hold', 'r3b (audit): scroll\'s window read runs across the cut-off on a hidden tab while a job holds input: no selectability check, so the job\'s hold is not ended after the cut-off', async () => {
  await world();
  const first = await run('press_key', { tab: 10, key: 'tab', task: 'budget job' });
  assert.equal(first.isError, false, first.text);
  const hold = idx.__taskHoldForTests();
  assert.ok(hold, 'no job hold');
  state.inactive = true; state.slowInfo = () => sleep(CUT + 300);
  const mark = log.length;
  const r = await run('scroll', { tab: 10, direction: 'down', task: 'budget job' });
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.equal(idx.__taskHoldForTests(), hold, 'the job hold was ended after the cut-off');
  assert.equal(log.slice(mark).some(e => /^session (close|handBack|warp|nativeChrome)/.test(e)), false, `restore after the cut-off: ${log.slice(mark)}`);
  // The kept job hold polls its own session status between steps (startGap, read-only): that is the job's, not this call's.
  await nothingAfter(r, 'scroll pre-read', /^session status$/);
  state.inactive = false;
  await idx.callTool({ params: { name: 'task_plan', arguments: { task: 'budget job', done: true } } }, {});
  evidence.push(`scroll-preread-hold: refused after ${r.ms} ms; the job hold kept`);
});

/* ------------------------------------------------------------ round 3c (HI v3.2: the first-write chokepoint) */

add('new', 'first-write-activation', 'r3c #1: the display read inside keepAgentAway (after the last boundary) runs across the cut-off: the activation is refused at the chokepoint; zero writes', async () => {
  await world();
  await holdLockElsewhere();
  setTimeout(() => { state.slowDisplaysMs = 900; releaseLockElsewhere(); }, CUT - 400);
  const r = await run('press_key', { tab: 10, key: 'tab' });
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.ok(log.includes('displays'), `the display read did not run: ${log}`);
  assert.deepEqual(writes(), [], `a write was sent after the cut-off: ${log}`);
  // HI v3.3 (A2 ruled B): the hand-back after the refused first write is not budget-checked; it still runs, before the return.
  assert.ok(log.includes('write restoreScene'), `the user's scene was not restored: ${log}`);
  assert.ok(log.includes('session close'), `the input hold was not released: ${log}`);
  assert.equal(log.some(e => /^session (click|key|type|paste|wheel|move)/.test(e)), false);
  await nothingAfter(r, 'first write: activation');
  await releaseLockElsewhere();
  evidence.push(`first-write-activation: refused after ${r.ms} ms; zero writes`);
});

add('new', 'first-write-answer', 'r3c #2: answer_dialog: the navigation observer starts across the cut-off: the answer is refused at the chokepoint; zero writes', async () => {
  await world();
  state.slowObserverMs = CUT + 300;
  const r = await run('answer_dialog', { tab: 10, button: 'OK' });
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.equal(log.includes('answer dialog'), false, `the answer was sent after the cut-off: ${log}`);
  assert.deepEqual(writes(), [], `a write was sent after the cut-off: ${log}`);
  await nothingAfter(r, 'first write: answer');
  // Control: within the budget the same answer is sent once.
  await world();
  const ok = await run('answer_dialog', { tab: 10, button: 'OK' });
  assert.match(ok.text, /按了「OK」/, ok.text);
  assert.deepEqual(writes(), ['write dialogAnswer']);
  evidence.push(`first-write-answer: refused after ${r.ms} ms, no answer; control answered once`);
});

add('new', 'first-write-scroll', 'r3c #3: scroll on a hidden tab: the ctx.check before the tab selection runs across the cut-off: the selection is refused at the chokepoint; zero writes', async () => {
  await world();
  state.inactive = true; state.slowStatusAfterBindMs = CUT + 300;
  const r = await run('scroll', { tab: 10, direction: 'down' });
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.ok(log.includes('native selectTab 10'), `the selection was not reached: ${log}`);
  assert.deepEqual(writes(), [], `a write was sent after the cut-off: ${log}`);
  await nothingAfter(r, 'first write: scroll');
  evidence.push(`first-write-scroll: refused after ${r.ms} ms; zero writes`);
});

/* ------------------------------------------------------------ round 3d (HI v3.3) */

add('new', 'first-write-inner-check', 'r3d A1: answer_dialog: the outer checks pass, then the status check inside the native send runs across the cut-off: the answer is refused right before it is issued; zero writes', async () => {
  await world();
  state.slowInnerStatusMs = CUT + 300;   // set when the answer starts: the next status request is ctx.native's own ctx.check
  const r = await run('answer_dialog', { tab: 10, button: 'OK' });
  assert.equal(r.error?.code, 'call_deadline', r.text); assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.ok(log.includes('answer dialog'), `the answer path was not reached: ${log}`);
  assert.deepEqual(writes(), [], `a write was issued after the cut-off: ${log}`);
  await nothingAfter(r, 'inner check');
  evidence.push(`first-write-inner-check: refused after ${r.ms} ms; zero writes`);
});

add('new', 'after-first-write', 'r3d A3: a hidden-tab scroll: the tab selection (the first write) is issued before the cut-off, then the window read runs across it: no boundary stops the call; the scroll completes and its receipt is the scroll\'s own', async () => {
  await world();
  state.inactive = true;
  state.afterSelectWrite = () => { state.slowInfo = () => sleep(CUT + 300); };   // the next window read (prepareActivate) crosses the cut-off
  const r = await run('scroll', { tab: 10, direction: 'down' }, BUDGET * 3);
  assert.notEqual(r.error?.code, 'call_deadline', `stopped by the budget after its first write: ${r.text}`);
  assert.ok(r.ms > CUT, `the window read did not cross the cut-off (${r.ms} ms)`);
  assert.ok(log.includes('write selectTab'), `no tab selection: ${log}`);
  assert.ok(log.includes('write activate'), `the activation after the first write did not run: ${log}`);
  assert.equal(r.isError, false, r.text);
  evidence.push(`after-first-write: completed after ${r.ms} ms (cut-off ${CUT}); selectTab and activation both issued`);
});

/* ------------------------------------------------------------ kept behaviour */

add('kept', 'within-estimate', 'typing that fits the budget runs as before: typed, confirmed, no refusal', async () => {
  await world();
  const r = await run('type_text', { tab: 10, text: 'abc', input_mode: 'keys' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^✅ 已输入并在输入框里确认：逐键输入 3 个字符/);
  assert.equal(state.value, 'abc');
});

add('kept', 'slower-than-estimate', 'typing slower than its estimate, past the call budget: never stopped by the budget (no revoke, no cancel), typed and confirmed', async () => {
  await world();
  state.typeMs = BUDGET;   // 4 keys estimated 1.2 s take 6 s
  const r = await run('type_text', { tab: 10, text: 'abcd', input_mode: 'keys' }, BUDGET * 3);
  assert.equal(r.isError, false, r.text);
  assert.ok(r.ms > BUDGET, `finished after ${r.ms} ms`);
  assert.equal(state.value, 'abcd');
  assert.equal(log.includes('session revokeNative'), false, `revoked mid-typing: ${log}`);
  evidence.push(`slower-than-estimate: typed after ${r.ms} ms of a ${BUDGET} ms budget, no revoke`);
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
console.log(`\ninput-budget tests passed (${passed}).`);
process.exit(0);
