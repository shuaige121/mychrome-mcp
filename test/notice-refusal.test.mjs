#!/usr/bin/env node
/* NOTICE1 (problems-20261101, contracts-batch4.md): when an attempted takeover ends in a terminal pre-input refusal of an
 * activation / destination check, MyChrome sends one best-effort notification through notifySend, after the takeover is
 * confirmed released. The sender is a stub here: nothing in this file can show a real notification, and a stub call proves
 * dispatch only, never that macOS displayed anything.
 * New fix (each RED under its targeted mutation in runs/NOTICE1/rerun.sh):
 *   order     the notification comes after the session close (the release) of the same call, exactly once.
 *   gating    only a terminal tagged refusal (or the page-focus refusal) notifies: an untagged refusal, and a call whose internal
 *             retry succeeds, notify nothing.
 *   rate      a second refusal inside the 60 s window (here: everyMs) is not notified; one after it is.
 *   setting   the `notify` setting off: no notification.
 *   i18n      I18N1: the notice in English when the UI language is English; an executed Chrome popup action (PERM1) is
 *             stated next to the requested input's own delivery, never "nothing was sent" (scope addition, integration review B).
 *   wording   the delivery sentence is conditional (not_sent / sent / unknown); only the front app's sanitised name; no title,
 *             URL or page text; the user is asked to click only after MyChrome's activation and Apple Event fallback.
 * Production callTool with a fake bridge, as test/focus-refusal.test.mjs. NOTICE1_CASE=<name>[,…] runs those cases. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const QUICK_MS = 60;
const TITLE = 'Private fixture title 7f3a', URL_ = 'https://private-fixture.invalid/secret-path-7f3a';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-notice1-'));
for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|KITTY_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  HOME: path.join(tmp, 'home'), TMPDIR: tmp,
  CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'), CHROME_BRIDGE_LOCK: path.join(tmp, 'lock', 'input.lock'),
  CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'agent-window.json'), CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_AGENT_NAME: 'notice1-test',
  CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_LANG: 'zh', CHROME_BRIDGE_WARM: '0',
});
for (const k of ['MYCHROME_FOCUS_BACKEND', 'MYCHROME_FOCUS_CARBON_FLAG', 'MYCHROME_FOCUS_RERAISE', 'CHROME_BRIDGE_RETRY_MAX_MS',
  'CHROME_BRIDGE_CALL_BUDGET_MS', 'CHROME_BRIDGE_IDLE_S', 'CHROME_BRIDGE_TAKEOVER']) delete process.env[k];
await mkdir(path.join(tmp, 'lock'));
await mkdir(process.env.HOME);
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const idx = await import('../src/index.js');
const bridge = await import('../src/bridge.js');
const T = await import('../src/tabs.js');
const S = await import('../src/settings.js');
const ACTIVITY = process.env.CHROME_BRIDGE_ACTIVITY;
const ONLY = process.env.NOTICE1_CASE ? process.env.NOTICE1_CASE.split(',') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
idx.__recordForTests(true);
idx.__notifyForTests({ send: () => {}, everyMs: 60_000 });   // no real notification can leave this file, whatever a case forgets

/* ------------------------------------------------------------ fixture */

const BOUNDS = { left: 0, top: 0, width: 1200, height: 900 };
const CHECK = { other_app_front: '另一个 App 在最前面', covered: '目标窗口被别的窗口挡住', not_key: '目标窗口在最上层，但不是键盘焦点窗口',
  tab_not_current: '目标标签不是该窗口的当前标签', unknown: '无法确定是哪一项' };
const SENT = ['activate_tab', 'activate_index', 'activate_main', 'activate_raise', 'activate_app']
  .map((stage, i) => ({ sequence: i + 1, stage, entered: true, delivery: 'sent', acknowledged: true }));
const own = id => ({ epoch: 1, operationId: id, chromePid: 42, windowId: 7, tabId: 10, cgWindow: state.cg, url: URL_, title: TITLE });
/** The helper's activate_unconfirmed: its activation writes were sent, then the read-only sample did not confirm. */
const unconfirmed = sample => id => ({ ok: false, error: 'activate_unconfirmed', stage: 'activate_verify', inputDelivery: 'sent', noRetry: true,
  stages: SENT, ...own(id), focusSamples: 40, ...sample });
/** A completed activation whose reply the server itself refuses (not key, moved window). Its URL is the tab's own (a
 * different one is a navigation the ledger reports, title included, in its own footer); the title is still planted. */
const confirmed = extra => id => ({ ok: true, inputDelivery: 'sent', stages: SENT, ...own(id), url: state.urls[10], bounds: { ...BOUNDS }, tabActive: true,
  minimized: false, windowIndex: 1, frontmost: 'Google Chrome', frontmostPid: 42, waitedMs: 0, targetOnTop: true, keyWindowIsTarget: true,
  frontmostChanged: false, prevFrontPutBack: false,
  geometry: { mode: 'fit-current', beforeBounds: { ...BOUNDS }, displayId: 1, branch: 'usable', changed: false, possiblyChanged: false }, ...extra });
/** A helper refusal before any write, with no focus sample. */
const refused = code => id => ({ ok: false, error: code, stage: 'activate_tab', inputDelivery: 'not_sent', stages: [], epoch: 1, operationId: id });
const moved = () => confirmed({ bounds: { ...BOUNDS, left: 300 },
  geometry: { mode: 'fit-current', beforeBounds: { ...BOUNDS }, displayId: 1, branch: 'usable', changed: true, possiblyChanged: true } });
const otherApp = { targetOnTop: false, keyWindowIsTarget: false, frontmost: 'Terminal', frontmostPid: 555, focusBlocker: null };

let state, log, logAt;
const note = e => { log.push(e); logAt.push(Date.now()); };
const target = id => ({ tabId: id, windowId: 7, chromePid: 42, cgWindow: state.cg, tabActive: true, minimized: false,
  bounds: { ...BOUNDS }, url: state.urls[id], title: `t${id}` });
function page(kind, vars, tab) {
  const t = target(tab == null ? 10 : Number(tab));
  if (kind === 'locate' && state.locate) return { ...page('locate-default', vars, tab), ...state.locate(t) };
  if (kind === 'locate-default') kind = 'locate';
  if (kind === 'block') return { ok: true, blocked: null, target: t };
  if (kind === 'locate') return { bounds: t.bounds, view: { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900 },
    aim: { x: 100, y: 112 }, rect: { x: 10, y: 100, width: 200, height: 24 }, visible: { x: 10, y: 100, width: 200, height: 24 },
    hitOk: true, chain: [], tag: 'button', target: t, ...(vars.MODE === 'field' ? { focusToken: 'field-token' } : {}) };
  if (kind === 'ack') return { ok: true, armed: true, target: t };
  // wait_for_user's field: its locate carries the focus token; arming the ready hint then fails (focus_unconfirmed).
  if (kind === 'ask') return { ok: true, armed: false, error: 'focus_unconfirmed', message: '无法确认输入框已获得焦点，没有显示输入就绪提示', target: t };
  if (kind === 'native-select' && state.hasFocus === false && state.failStatusAfter) { state.statusFail = true; state.statusSeen = 0; }   // the refusal is next
  if (kind === 'native-select') return { ok: true, nativeSelect: false, hasFocus: state.hasFocus !== false, target: t };   // FOCUS4: the page owns keyboard focus
  throw new Error(`unexpected page script ${kind}`);
}
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in focus3 test`); }]));
  return Object.assign(fake, {
    pageDialog: async () => ({ ok: true, open: false }),
    keepAwake: () => () => {},
    ensureScreenAwake: async () => ({ locked: false, displays: 1, woke: false }),
    axInput: async () => ({ ok: true, frontmost: true, windowMatches: true, nodeFound: true, documentToken: 'doc1', focusedDocumentToken: 'doc1',
      menuOpen: false, nativeMenuOpen: false, nativePopup: false }),
    pageScript: async (kind, vars = {}) => `fakePage(${JSON.stringify(kind)}, ${JSON.stringify(vars)})`,
    evalInPage: async (src, tab) => {
      note(`eval ${[...src.matchAll(/fakePage\("(\w+)"/g)].map(m => m[1]).join('+')}`);
      return JSON.parse(vm.runInNewContext(src, { fakePage: (k, v) => JSON.stringify(page(k, v, tab)) }));
    },
    pageContentRect: async () => ({ ok: false }),
    chromeInfo: async tab => target(tab == null ? 10 : Number(tab)),
    listTabs: async () => ({ ok: true, frontmost: 'Google Chrome', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
      tabs: Object.keys(state.urls).map(id => ({ id: Number(id), url: state.urls[id], title: `t${id}`, active: Number(id) === 10 })) }] }),
    openInputSession: async () => {
      let held = false;
      return {
        request: async req => {
          note(req.op === 'key' && state.keyReply ? 'session key refused (postedInput 0)' : `session ${req.op}`);
          if (req.op === 'hold') {
            held = true;
            if (state.swapCg) state.cg = 71;   // the window seen by the preflight is not the one bound after the hold
            return { ok: true, epoch: 1, pointer: { x: 10, y: 20 }, heldAt: Date.now() };
          }
          if (req.op === 'recordNativeScene') return { ok: true, epoch: 1, restoreToken: 'r'.repeat(64) };
          if (req.op === 'nativeChrome' && req.intent?.kind === 'activate') {
            state.activations.push(Date.now());
            await sleep(state.activateMs);
            return state.activation(req.operationId, state.activations.length);
          }
          if (req.op === 'status' && state.statusFail && ++state.statusSeen >= state.statusFrom) throw new Error('status failed (fixture)');
          if (req.op === 'veil') return { ok: true, held, takeover: { active: held } };
          if (req.op === 'wheel') { state.wheels++; return { ok: true, epoch: 1, sent: req.notches, postedInput: req.notches }; }
          // The helper's per-event guard refusing a key before posting it; the real session rejects such a reply.
          if (req.op === 'key' && state.keyReply) throw bridge.sessionError(state.keyReply);
          return { ok: true, epoch: 1, operationId: req.operationId, stages: [], inputDelivery: req.op === 'nativeChrome' ? 'sent' : undefined,
            inputMonitor: true, takeover: { active: held }, ...(req.op === 'warp' ? { verified: true, warped: req.to } : {}) };
        },
        close: async () => {
          note('session close'); held = false; state.cg = state.baseCg;
          const reply = typeof state.closeReply === 'function' ? state.closeReply(++state.closes) : state.closeReply;
          if (reply instanceof Error) throw reply;
          return reply ?? { ok: true, takeover: { active: false, swallowedKeys: state.swallowedKeys, swallowedPointer: 0 } };
        },
      };
    },
    snapshotScene: async () => ({ appPid: 99, chromeWindow: 7, chromeTab: 10 }),
    restoreScene: async (_scene, options) => { await options.native({ kind: 'restoreScene' }, { policy: 'restore' }); return { ok: true, appFrontmost: true }; },
    activateChrome: bridge.activateChrome,   // production: the helper's reply becomes the error here
    selectTab: async (id, o) => { await o.native({ kind: 'selectTab', tabId: id, windowId: o.windowId }); return { ok: true, ...target(id), changed: false }; },
    openNavigationObserver: async () => ({ startedAt: Date.now(), untouched: async () => true, close: async () => {} }),
    cgevent: async args => {
      if (args[0] === 'displays') return { displays: [] };
      if (args[0] === 'mousepos') return { x: 10, y: 20 };
      if (args[0] === 'windowsat') return { windows: [] };
      if (args[0] !== 'idle') throw new Error(`B.cgevent ${args[0]} reached in focus3 test`);
      note('idle');
      return state.idle();
    },
  });
}
const QUIET = () => ({ ok: true, idle: 100, keyIdle: 100, held: [], clickIdle: 100 });
async function world(o = {}) {
  for (const t = Date.now(); idx.__taskHoldForTests() && Date.now() - t < 3000;) await sleep(20);
  assert.equal(idx.__taskHoldForTests(), null, 'a job hold leaked from the previous case');
  idx.__resetPanelTaskForTests(); idx.__resetLedgerForTests(); idx.__resetNativeTargetsForTests(); idx.__resetShotsForTests();
  S.writeSettings({ inputMode: 'auto', inputSpeed: 1 });
  state = { urls: { 10: 'https://shop.test/form' }, baseCg: o.baseCg ?? 70, cg: o.baseCg ?? 70, activations: [], activateMs: QUICK_MS, hasFocus: true, statusFail: false, statusSeen: 0, statusFrom: Number(2), failStatusAfter: false,
    activation: confirmed(), idle: QUIET, swallowedKeys: 0, closeReply: null, closes: 0, keyReply: null, swapCg: false, locate: null, wheels: 0, ...o };
  log = []; logAt = [];
  idx.__setBridgeForTests(fakeBridge());
  await T.registerTab(10, state.urls[10], { windowId: 7, agentName: 'focus3-test' });
  await rm(ACTIVITY, { force: true });
}
/** One production callTool; what the helper was asked, what the agent read, and the activity row. */
async function run(name, args) {
  const started = Date.now();
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  const at = Date.now();
  const rows = (await readFile(ACTIVITY, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  // FOCUS3_SHOW=1: print what the agent read and the row (the report's before/after texts, on either revision).
  if (process.env.FOCUS3_SHOW === '1') console.log(`--- ${name} ${JSON.stringify(args)}\n${r.content.filter(c => c.type === 'text').map(c => c.text).join('\n')}\nrow: ${JSON.stringify(rows.at(-1) ?? null)}`);
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError,
    error: r.structuredContent?.error || null, ms: at - started, at, attempts: state.activations.length,
    sinceFirst: state.activations.length ? at - state.activations[0] : null, row: rows.at(-1) ?? null, rows: rows.length,
    inputs: log.filter(e => /^session (click|key|type|paste|wheel|move)$/.test(e)) };
}
const said = r => `${r.attempts} activation request(s); ${r.error?.code}`;

/* The notification sender is a stub for the whole file: dispatches land in `sends`, and `note('NOTIFY')` puts each one in the
 * same ordered log as the fake session's "session close" (the release), so ordering is observable. */
let sends = [], everything = [];
// `sends` are NOTICE1's own; the pre-existing "AI 好像卡住了" note (a third failure in a row) shares the sender and is kept apart.
function notifyStub(o = {}) {
  sends = []; everything = [];
  idx.__notifyForTests({ send: (text, opts) => { everything.push({ text, opts }); if (text.startsWith('agent 想操作 Chrome') || text.startsWith('The AI tried to use Chrome')) { sends.push({ text, opts }); note('NOTIFY'); } },
    everyMs: o.everyMs ?? 60_000, enabled: o.enabled ?? true });
}
const closeAt = () => log.lastIndexOf('session close');
const OTHER = { ...{ targetOnTop: false, keyWindowIsTarget: false, frontmost: 'Terminal', frontmostPid: 555, focusBlocker: null } };
const withApple = sample => ({ focusAppleActivate: true, ...sample });
const cases = [];
const add = (kind, name, label, fn) => cases.push({ kind, name, label, fn });
const evidence = [];
const clean = (text, label) => {
  assert.equal(text.includes(TITLE), false, `${label}: the planted page title reached the notice: ${text}`);
  assert.equal(/private-fixture|secret-path|shop\.test/.test(text), false, `${label}: a URL reached the notice: ${text}`);
};

/* ------------------------------------------------------------ new fix (gating-untagged and gating-retry-succeeds below are
 * kept-behaviour controls: they also hold with NOTICE1 removed; the positive controls are order-once, page-focus, retained-hold-release) */

add('new', 'order-once', 'a terminal other-app-in-front refusal: exactly one notification, dispatched after the call\'s session close (release) and before nothing else runs; the stub is the only sender', async () => {
  await world({ activation: unconfirmed(withApple(OTHER)) });
  notifyStub();
  const r = await run('click', { tab: 10, marker: 1 });
  assert.equal(r.error?.code, 'activate_unconfirmed', r.text);
  evidence.push(`order-once: ${said(r)}; ${sends.length} dispatch(es); log ${log.join(' > ')}`);
  assert.equal(sends.length, 1, `dispatches: ${sends.length}`);
  assert.deepEqual(r.inputs, [], 'input was posted');
  const n = log.indexOf('NOTIFY');
  assert.ok(closeAt() >= 0, `no session close: ${log}`);
  assert.ok(n > closeAt(), `the notice came before the release: ${log.join(' > ')}`);
  assert.equal(log.filter(x => x === 'NOTIFY').length, 1);
  await sleep(200);
  assert.equal(sends.length, 1, 'a late duplicate');
  assert.equal(r.rows, 1);
});

add('kept', 'gating-untagged', 'a terminal refusal that is not an activation/destination refusal (no_such_tab after its retries) notifies nothing', async () => {
  await world({ activation: refused('no_such_tab') });
  notifyStub();
  const r = await run('press_key', { tab: 10, key: 'enter' });
  assert.equal(r.error?.code, 'no_such_tab', r.text);
  evidence.push(`gating-untagged: ${said(r)}; ${sends.length} dispatch(es)`);
  assert.equal(sends.length, 0, `unwanted notice: ${sends.map(x => x.text)}`);
});

add('kept', 'gating-retry-succeeds', 'an activation refusal on the first attempt followed by a successful retry notifies nothing (the call succeeds)', async () => {
  const first = refused('focus_unconfirmed');   // the helper's transient refusal (no sample): one retry, which succeeds
  await world({ activation: (id, n) => (n === 1 ? first(id) : confirmed()(id)) });
  notifyStub();
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`gating-retry-succeeds: ${r.attempts} activation request(s); isError ${r.isError}; ${sends.length} dispatch(es)`);
  assert.equal(r.isError, false, r.text);
  assert.equal(r.attempts, 2, said(r));
  assert.equal(sends.length, 0, `unwanted notice: ${sends.map(x => x.text)}`);
});

add('new', 'rate-limit', 'two terminal refusals inside the window: one notification; one after the window: a second', async () => {
  await world({ activation: unconfirmed(withApple(OTHER)) });
  notifyStub({ everyMs: 700 });
  const a = await run('click', { tab: 10, marker: 1 });
  const b = await run('click', { tab: 10, marker: 1 });
  evidence.push(`rate-limit: ${a.error?.code}, ${b.error?.code}; ${sends.length} dispatch(es) inside the window`);
  assert.equal(a.error?.code, 'activate_unconfirmed'); assert.equal(b.error?.code, 'activate_unconfirmed');
  assert.equal(sends.length, 1, `inside the window: ${sends.length} dispatches`);
  await sleep(800);
  await run('click', { tab: 10, marker: 1 });
  assert.equal(sends.length, 2, `after the window: ${sends.length} dispatches: ${sends.map(x => x.text)}`);
});

add('new', 'setting-off', 'the notify setting off: no notification (control: on, one)', async () => {
  await world({ activation: unconfirmed(withApple(OTHER)) });
  notifyStub({ enabled: false });
  const off = await run('click', { tab: 10, marker: 1 });
  assert.equal(off.error?.code, 'activate_unconfirmed', off.text);
  evidence.push(`setting-off: ${sends.length} dispatch(es) with the setting off`);
  assert.equal(sends.length, 0, `notified with the setting off: ${sends.map(x => x.text)}`);
  notifyStub({ enabled: true });
  await run('click', { tab: 10, marker: 1 });
  assert.equal(sends.length, 1, 'control: the setting on must notify once');
});

add('new', 'wording-delivery', 'the delivery sentence is conditional: not sent says so; sent (a wheel was posted) and unknown never say nothing was sent', async () => {
  // not_sent, through the production call
  await world({ activation: unconfirmed(withApple(OTHER)) });
  notifyStub();
  await run('click', { tab: 10, marker: 1 });
  const t0 = sends[0]?.text ?? '';
  evidence.push(`wording not_sent: ${t0}`);
  assert.match(t0, /没有发送任何点击或按键/);
  assert.ok(t0.includes('「Terminal」'), t0);
  clean(t0, 'not_sent');
  // sent: a wheel went out before the geometry refusal (FOCUS3 r3 A1 fixture)
  const below = { aim: { x: 100, y: 2000 }, rect: { x: 10, y: 1988, width: 200, height: 24 }, visible: null, hitOk: false,
    chain: [{ document: true, clip: { x: 0, y: 0, width: 1200, height: 800 }, scrollableY: true, scrollTop: 0, maxTop: 5000, sig: 'doc',
      wheel: { down: { x: 600, y: 400 }, up: { x: 600, y: 400 } } }] };
  await world({ baseCg: 74, locate: t => (state.wheels ? { bounds: { ...t.bounds, left: 300 } } : below) });
  notifyStub();
  const r = await run('click', { tab: 10, marker: 1 });
  assert.equal(r.error?.code, 'window_changed', r.text);
  assert.equal(state.wheels, 1, `the wheel was not reached: ${log}`);
  const t1 = sends[0]?.text ?? '';
  evidence.push(`wording sent: ${t1}`);
  assert.equal(sends.length, 1);
  assert.equal(t1.includes('没有发送'), false, `claims nothing was sent after a wheel: ${t1}`);
  assert.match(t1, /已经发出了部分输入/);
  clean(t1, 'sent');
  // unknown: the text function, as the production call builds it from the refusal's delivery state
  const t2 = idx.refusalNoticeText({ reason: 'unknown', front: null, delivery: 'unknown', apple: false });
  evidence.push(`wording unknown: ${t2}`);
  assert.equal(t2.includes('没有发送'), false, t2);
  assert.match(t2, /无法确认是否已发出输入/);
  assert.equal(idx.refusalNoticeText({ reason: 'covered', front: null, delivery: undefined, apple: false }).includes('没有发送'), false, 'an absent delivery state is unknown');
});

add('new', 'wording-click-request', 'the user is asked to click the Chrome window only for another app in front after MyChrome\'s activation and Apple Event fallback; every other cause says the agent was told', async () => {
  const fall = idx.refusalNoticeText({ reason: 'other_app_front', front: 'Terminal', delivery: 'not_sent', apple: true });
  const noFall = idx.refusalNoticeText({ reason: 'other_app_front', front: 'Terminal', delivery: 'not_sent', apple: false });
  evidence.push(`click-request after fallback: ${fall}`, `click-request without fallback: ${noFall}`);
  assert.match(fall, /请点一下 Chrome 窗口/);
  assert.equal(/点一下|点击窗口/.test(noFall), false, `asks to click without a fallback: ${noFall}`);
  for (const reason of ['covered', 'not_key', 'tab_not_current', 'unknown', 'page_focus']) {
    const t = idx.refusalNoticeText({ reason, front: 'Terminal', delivery: 'not_sent', apple: true });
    assert.equal(/点一下/.test(t), false, `${reason}: asks to click: ${t}`);
    assert.match(t, /agent 会收到原因/);
  }
  // through production: the Apple Event fallback is a recorded fact of the activation (focusAppleActivate)
  await world({ activation: unconfirmed(OTHER) });
  notifyStub();
  await run('click', { tab: 10, marker: 1 });
  assert.equal(sends.length, 1);
  assert.equal(/点一下/.test(sends[0].text), false, `no recorded fallback, yet asks to click: ${sends[0].text}`);
  await world({ activation: unconfirmed(withApple(OTHER)) });
  notifyStub();
  await run('click', { tab: 10, marker: 1 });
  assert.match(sends[0]?.text ?? '', /请点一下 Chrome 窗口/);
});

add('new', 'wording-sanitised', 'only the front app\'s sanitised name: quotes, control characters and length are cut; no title, URL or page text from a planted reply', async () => {
  const t = idx.refusalNoticeText({ reason: 'other_app_front', front: 'Evil" & do shell\nscript \\ ' + 'x'.repeat(100), delivery: 'not_sent', apple: true });
  evidence.push(`sanitised: ${t}`);
  assert.equal(/["\\\n]/.test(t), false, t);
  assert.ok(t.length < 200, `${t.length}`);
  await world({ activation: unconfirmed(withApple({ ...OTHER, frontmost: `Terminal ${TITLE}`.slice(0, 20), title: TITLE, url: URL_, pageText: 'secret body text' })) });
  notifyStub();
  await run('click', { tab: 10, marker: 1 });
  assert.equal(sends.length, 1);
  clean(sends[0].text, 'planted reply');
  assert.equal(sends[0].text.includes('secret body text'), false);
});

add('new', 'page-focus', 'a press_key whose page has no keyboard focus (a destination refusal, nothing pressed): one notification after the release, no front app, nothing-sent wording', async () => {
  await world({ hasFocus: false });
  notifyStub();
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`page-focus: ${said(r)}; ${sends.length} dispatch(es): ${sends[0]?.text}`);
  assert.equal(r.error?.code, 'no_page_focus', r.text);
  assert.deepEqual(r.inputs, []);
  assert.equal(sends.length, 1);
  assert.ok(log.indexOf('NOTIFY') > closeAt(), `the notice came before the release: ${log.join(' > ')}`);
  assert.match(sends[0].text, /网页没有键盘焦点/);
  assert.match(sends[0].text, /没有发送任何点击或按键/);
});

add('new', 'retained-hold-release', 'a plan keeps its hold; a destination refusal (no page focus) then a failed status check: the cleanup ends the hold. Unconfirmed close: no notice. Confirmed close: one notice, after that close', async () => {
  const go = async closeReply => {
    await world({ failStatusAfter: true, closeReply: () => closeReply });
    notifyStub();
    const plan = await idx.callTool({ params: { name: 'task_plan', arguments: { task: 'notice1 job' } } }, {});
    assert.ok(!plan.isError, JSON.stringify(plan.content));
    const ok = await run('press_key', { tab: 10, key: 'enter' });
    assert.equal(ok.isError, false, ok.text);
    assert.notEqual(idx.__taskHoldForTests(), null, 'the plan did not keep its hold');
    state.hasFocus = false;
    const r = await run('press_key', { tab: 10, key: 'enter' });
    assert.equal(r.error?.code, 'no_page_focus', r.text);
    return r;
  };
  const un = await go({ ok: true, takeover: { active: true } });   // the close reply does not confirm the release
  evidence.push(`retained-hold-release unconfirmed: ${un.error?.code}; hold ${idx.__taskHoldForTests() ? 'kept' : 'ended'}; closes ${state.closes}; ${sends.length} dispatch(es)`);
  assert.equal(idx.__taskHoldForTests(), null, 'the cleanup did not end the hold');
  assert.ok(state.closes >= 1, 'the hold was never closed');
  assert.equal(sends.length, 0, `notified without a confirmed release: ${sends.map(x => x.text)}`);
  idx.__resetPanelTaskForTests();
  const yes = await go(null);
  evidence.push(`retained-hold-release confirmed: ${yes.error?.code}; closes ${state.closes}; ${sends.length} dispatch(es); log tail ${log.slice(-4).join(' > ')}`);
  assert.equal(sends.length, 1, `confirmed close: ${sends.length} dispatches`);
  assert.ok(log.indexOf('NOTIFY') > closeAt(), `the notice came before the close: ${log.join(' > ')}`);
  idx.__resetPanelTaskForTests();
});

add('new', 'i18n-english', 'I18N1: with the UI language English (CHROME_BRIDGE_UI_LANG=en), the same production refusal notifies once, in English, after the release', async () => {
  await world({ activation: unconfirmed(withApple(OTHER)) });
  notifyStub();
  process.env.CHROME_BRIDGE_UI_LANG = 'en';
  let r;
  try { r = await run('click', { tab: 10, marker: 1 }); } finally { delete process.env.CHROME_BRIDGE_UI_LANG; }
  assert.equal(r.error?.code, 'activate_unconfirmed', r.text);
  evidence.push(`i18n-english: ${sends[0]?.text}`);
  assert.equal(sends.length, 1, `dispatches: ${sends.length}`);
  assert.equal(sends[0].text, 'The AI tried to use Chrome but could not: MyChrome tried to switch to Chrome, but “Terminal” is still in front. No click or key was sent. If it still does not switch, click the Chrome window once.');
  assert.ok(log.indexOf('NOTIFY') > closeAt(), `the notice came before the release: ${log.join(' > ')}`);
  assert.match(r.text, /最前面/, 'the agent-facing receipt changed language');
  clean(sends[0].text, 'english');
});

add('new', 'i18n-popup-allowed', 'I18N1 scope addition: the activation chose Allow in a Chrome permission prompt, then another app stayed in front: the notice states the Allow and that the requested click was not sent (both languages)', async () => {
  const allowed = { popupKind: 'permission', popupAction: 'allow', popupDelivery: 'sent', popupResult: 'cleared' };
  const go = async lang => {
    await world({ activation: unconfirmed(withApple({ ...OTHER, ...allowed })) });
    notifyStub();
    process.env.CHROME_BRIDGE_UI_LANG = lang;
    try { return await run('click', { tab: 10, marker: 1 }); } finally { delete process.env.CHROME_BRIDGE_UI_LANG; }
  };
  const zh = await go('zh');
  assert.equal(zh.error?.code, 'activate_unconfirmed', zh.text);
  assert.equal(zh.attempts, 1, said(zh));
  assert.equal(zh.row?.popupAction, 'allow', JSON.stringify(zh.row));
  evidence.push(`i18n-popup-allowed zh: ${sends[0]?.text}`);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /已在 Chrome 的网站权限询问里选了「允许」；没有发送这次要做的点击或按键。/, sends[0].text);
  assert.equal(sends[0].text.includes('没有发送任何点击或按键'), false, `the notice says nothing was pressed: ${sends[0].text}`);
  const en = await go('en');
  evidence.push(`i18n-popup-allowed en: ${sends[0]?.text}`);
  assert.equal(en.error?.code, 'activate_unconfirmed', en.text);
  assert.match(sends[0]?.text ?? '', /MyChrome chose Allow in Chrome's site permission prompt; the requested click or key was not sent\./);
  assert.equal(/No click or key was sent/.test(sends[0].text), false, sends[0].text);
  clean(sends[0].text, 'popup');
});

/* ------------------------------------------------------------ run */

let passed = 0, failed = 0;
for (const kind of ['new', 'kept']) {
  for (const c of cases.filter(x => x.kind === kind && (!ONLY || ONLY.includes(x.name)))) {
    try { await c.fn(); passed++; console.log(`  ok    [${kind}] ${c.name}: ${c.label}`); }
    catch (e) { failed++; console.log(`FAIL  [${kind}] ${c.name}: ${c.label}\n${e.stack}`); }
  }
}
assert.ok(passed + failed > 0, `no case named ${ONLY}`);
idx.__resetPanelTaskForTests();
for (const line of evidence) console.log(`  evidence  ${line}`);
console.log(`\nnotice-refusal tests: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
