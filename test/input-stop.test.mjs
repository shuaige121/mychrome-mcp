#!/usr/bin/env node
/* A native request timeout or a caller cancel really stops the input helper before the call returns (contract HI2,
 * problems-20261101). The real openInputSession drives a fake `cgevent session` child with no input ability: it speaks
 * the JSON Lines protocol and only writes what it would have posted to a log file. Cases:
 *  - a valid stop acknowledgement; no acknowledgement but the exit confirmed; neither → unknown + no-retry;
 *  - a late reply to the released request is ignored; zero sends after return; a released original wait (a hold that
 *    answers late) never activates or types late;
 *  - production callTool paths: a hold that never answers is stopped within the call budget (the 60 s residual), a
 *    caller cancel and a request timeout stop typing that is under way, and a retry inside one bridge read starts only
 *    before the cut-off (the retry-chain residual).
 * STOP_CASE=<name> runs one case (the coordinator's revert check). */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const BUDGET = 6000, RESERVE = 600;
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-input-stop-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
process.env.CHROME_BRIDGE_NOTIFY = '0';
process.env.CHROME_BRIDGE_AGENT_NAME = 'stop-test';
process.env.CHROME_BRIDGE_HABITS = 'off';
process.env.CHROME_BRIDGE_MENUBAR = '0';
process.env.CHROME_BRIDGE_LANG = 'zh';
process.env.CHROME_BRIDGE_CALL_BUDGET_MS = String(BUDGET);
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const bridge = await import('../src/bridge.js');
const idx = await import('../src/index.js');
const T = await import('../src/tabs.js');
const { writeSettings } = await import('../src/settings.js');
const ONLY = process.env.STOP_CASE || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const evidence = [];
let passed = 0;

/* ------------------------------------------------------------ the fake helper (no input ability) */

// FAKE_MODE: ack (answers the priority stop), noack (never answers it; dies on SIGKILL), deaf (after FAKE_HANG arrives it
// answers nothing and ignores SIGTERM). FAKE_HANG: the op that does not answer (type: keeps "typing" FAKE_KEYS keys every
// FAKE_KEY_MS; any other op: answers only after FAKE_LATE_MS, the late reply). Every line received, every reply and every
// event it would have posted is appended to FAKE_LOG.
const FAKE = path.join(tmp, 'fake-cgevent.mjs');
await writeFile(FAKE, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const E = process.env, LOG = E.FAKE_LOG, MODE = E.FAKE_MODE || 'ack', HANG = E.FAKE_HANG || '';
const KEY_MS = Number(E.FAKE_KEY_MS || 50), KEYS = Number(E.FAKE_KEYS || 1000), LATE = Number(E.FAKE_LATE_MS || 0);
const log = (kind, op) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), kind, op }) + '\\n');
const out = r => { process.stdout.write(JSON.stringify(r) + '\\n'); log('reply', r.op); };
if (MODE === 'deaf') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }   // wedged: stays on after stdin EOF
let held = false, aborted = null, deaf = false, typing = null, lateAt = 0;
const takeover = () => ({ active: held && !aborted, aborted: !!aborted, ...(aborted ? { abortedBy: aborted } : {}) });
function post(op) { log('post', op); }
function type(req) {
  let n = 0;
  const total = HANG === 'type' ? KEYS : [...req.text].length;
  typing = { req, timer: setInterval(() => {
    if (aborted) return;
    post('key'); n++;
    typing.n = n;
    if (n >= total) { clearInterval(typing.timer); const t = typing; typing = null; out({ id: t.req.id, op: 'type', ok: true, epoch: 1, typed: n, postedInput: n }); }
  }, KEY_MS), n: 0 };
}
function stopNow(c, by) {
  const ackMs = Number(E.FAKE_ACK_MS || 0);
  if (ackMs > 0 && !c.delayed) { setTimeout(() => stopNow({ ...c, delayed: true }, by), ackMs); return; }
  aborted = aborted || by;
  held = false;
  out({ id: c.id, op: c.op, ok: true, cancelled: true, released: [], epoch: 1, takeover: takeover() });
  if (typing) {
    clearInterval(typing.timer);
    const t = typing; typing = null;
    out({ id: t.req.id, op: 'type', ok: false, error: 'aborted', typed: t.n, postedInput: t.n, epoch: 1, takeover: takeover() });
  }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line);
  log('recv', c.op);
  if (deaf) return;
  if (c.op === HANG && c.op === 'end' && MODE === 'deaf') { deaf = true; return; }
  if (c.op === 'cancel' || c.op === 'revokeNative') {
    if (MODE === 'ack') stopNow(c, c.op === 'cancel' ? 'caller_cancel' : c.reason || 'caller');
    return;
  }
  if (c.op === 'end') {
    if (typing) { clearInterval(typing.timer); typing = null; }
    held = false;
    out({ id: c.id, op: 'end', ok: true, epoch: 1, takeover: takeover(), interrupted: null });
    setTimeout(() => process.exit(0), Math.max(20, lateAt - Date.now() + 50));   // a late reply still goes out
    return;
  }
  if (c.op === 'status') { out({ id: c.id, op: 'status', ok: true, epoch: 1, takeover: takeover(), cursor: { x: 1, y: 1 } }); return; }
  if (c.op === HANG) {
    if (MODE === 'deaf') deaf = true;
    if (c.op === 'type') { type(c); return; }
    if (LATE > 0) lateAt = Date.now() + LATE;
    if (LATE > 0) setTimeout(() => { held = true; out({ id: c.id, op: c.op, ok: true, epoch: 1, pointer: { x: 10, y: 20 }, heldAt: Date.now(), takeover: takeover() }); }, LATE);
    return;
  }
  const input = ['click', 'key', 'type', 'paste', 'wheel', 'move', 'nativeChrome', 'warp', 'handBack'].includes(c.op);
  if (input && aborted) { out({ id: c.id, op: c.op, ok: false, error: 'aborted', postedInput: 0, epoch: 1, takeover: takeover() }); return; }
  if (c.op === 'type') { type(c); return; }
  if (input) post(c.op === 'nativeChrome' ? 'native ' + c.intent?.kind : c.op);
  if (c.op === 'hold') held = true;
  out({ id: c.id, op: c.op, ok: true, epoch: 1, operationId: c.operationId, stages: [], inputMonitor: true, held,
    inputDelivery: c.op === 'nativeChrome' ? 'sent' : c.op === 'bindNativeTarget' || c.op === 'recordNativeScene' ? 'not_sent' : undefined,
    pointer: { x: 10, y: 20 }, heldAt: Date.now(), restoreToken: 'r'.repeat(64), typed: 0, postedInput: input ? 1 : 0,
    ...(c.op === 'warp' ? { verified: true, warped: c.to } : {}), takeover: takeover() });
});
`);
await chmod(FAKE, 0o755);

let fakeLog = null, logN = 0;
async function readLog() {
  const text = await readFile(fakeLog, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function fakeEnv(mode, hang, more = {}) {
  fakeLog = path.join(tmp, `fake-${++logN}.log`);
  return { ...process.env, FAKE_LOG: fakeLog, FAKE_MODE: mode, FAKE_HANG: hang, ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, String(v)])) };
}
const spawned = [];
/** The real openInputSession on the fake child. `noKill`: SIGKILL is not delivered (a child that cannot be confirmed gone). */
function open(env, { noKill = false, ...o } = {}) {
  const kills = [];
  const s = bridge.openInputSession({ bin: FAKE, env, stopAckMs: 600, stopExitMs: 400,
    kill: (child, sig) => { kills.push(sig); if (!noKill) child.kill(sig); }, ...o });
  spawned.push(s);
  return Object.assign(s, { kills });
}
async function killSpawned() {
  for (const s of spawned.splice(0)) { try { process.kill(s.pid, 'SIGKILL'); } catch {} }
}
/** Nothing reached the child, and the child posted nothing, after `at` (300 ms of quiet). */
async function nothingAfter(at, label, { allowRecv = [] } = {}) {
  await sleep(300);
  const late = (await readLog()).filter(e => e.t > at && (e.kind === 'post' || (e.kind === 'recv' && !allowRecv.includes(e.op))));
  assert.deepEqual(late, [], `${label}: sent or posted after the return: ${JSON.stringify(late)}`);
}

const cases = [];
const add = (kind, name, label, fn) => cases.push({ kind, name, label, fn });

/* ------------------------------------------------------------ new fix: openInputSession */

add('new', 'ack-timeout', 'a type request times out: the priority stop is acknowledged before the request is released; nothing is posted after the acknowledgement, the late reply is ignored, nothing is written after', async () => {
  const s = open(fakeEnv('ack', 'type', { FAKE_KEY_MS: 40 }));
  const t0 = Date.now();
  const e = await s.request({ op: 'type', text: 'x'.repeat(100) }, { timeoutMs: 400 }).then(() => null, x => x);
  const at = Date.now();
  assert.ok(e, 'the timed-out request resolved');
  assert.equal(e.code, 'session_timeout');
  assert.equal(e.helperStop, 'ack', e.message);
  assert.equal(e.inputDelivery, 'unknown');
  assert.equal(e.noRetry, true);
  assert.equal(s.helperStop, 'ack');
  const log = await readLog();
  const ack = log.find(x => x.kind === 'reply' && x.op === 'cancel');
  assert.ok(ack, `no stop acknowledgement before the return: ${JSON.stringify(log)}`);
  assert.ok(ack.t <= at, 'the request was released before the acknowledgement');
  assert.deepEqual(log.filter(x => x.kind === 'post' && x.t > ack.t), [], 'posted after the acknowledgement');
  assert.ok(log.some(x => x.kind === 'reply' && x.op === 'type'), 'the fake sent no late reply to ignore');
  // After the stop nothing more is written to the child: a new request is refused unwritten.
  const after = await s.request({ op: 'key', name: 'return' }).then(() => null, x => x);
  assert.equal(after?.notWritten, true, 'a request after the stop was written');
  await nothingAfter(at, 'ack-timeout');
  await s.close();
  assert.deepEqual(s.kills, [], 'killed although acknowledged');
  evidence.push(`ack-timeout: released ${at - t0} ms after the request (timeout 400), acknowledgement first, ${log.filter(x => x.kind === 'post').length} keys before it, 0 after`);
});

add('new', 'exit-timeout', 'no acknowledgement: the child is killed and its exit confirmed before the request is released', async () => {
  const s = open(fakeEnv('noack', 'type', { FAKE_KEY_MS: 40 }));
  const t0 = Date.now();
  const e = await s.request({ op: 'type', text: 'x'.repeat(100) }, { timeoutMs: 300 }).then(() => null, x => x);
  const at = Date.now();
  assert.equal(e?.code, 'session_timeout');
  assert.equal(e.helperStop, 'exit', e.message);
  assert.equal(e.inputDelivery, 'unknown');
  assert.equal(e.noRetry, true);
  assert.deepEqual(s.kills, ['SIGKILL']);
  assert.ok(at - t0 < 300 + 600 + 400 + 300, `released after ${at - t0} ms`);
  await nothingAfter(at, 'exit-timeout');
  evidence.push(`exit-timeout: no acknowledgement in 600 ms, SIGKILL, exit seen; released ${at - t0} ms after the request`);
});

add('new', 'unconfirmed-timeout', 'neither an acknowledgement nor an exit: unknown + no-retry, and nothing more is written to the child', async () => {
  const s = open(fakeEnv('deaf', 'type', { FAKE_KEY_MS: 40 }), { noKill: true });
  const t0 = Date.now();
  const e = await s.request({ op: 'type', text: 'x'.repeat(100) }, { timeoutMs: 300 }).then(() => null, x => x);
  const at = Date.now();
  assert.equal(e?.code, 'session_timeout');
  assert.equal(e.helperStop, 'unconfirmed');
  assert.equal(e.inputDelivery, 'unknown');
  assert.equal(e.noRetry, true);
  assert.match(e.message, /没有确认停止/);
  assert.ok(at - t0 < 300 + 600 + 400 + 300, `released after ${at - t0} ms`);
  await s.close();
  const recv = (await readLog()).filter(x => x.kind === 'recv' && x.t > at);
  assert.deepEqual(recv, [], `written after the return: ${JSON.stringify(recv)}`);
  await killSpawned();
  evidence.push(`unconfirmed-timeout: released ${at - t0} ms after the request with unknown/noRetry; close wrote nothing`);
});

add('new', 'pre-input-ack', 'a request that posts nothing (hold) times out and the stop is acknowledged: not_sent; its late reply is ignored', async () => {
  const s = open(fakeEnv('ack', 'hold', { FAKE_LATE_MS: 900 }));
  const e = await s.request({ op: 'hold' }, { raw: true, timeoutMs: 300 }).then(() => null, x => x);
  assert.equal(e?.code, 'session_timeout');
  assert.equal(e.helperStop, 'ack');
  assert.equal(e.inputDelivery, 'not_sent');
  assert.notEqual(e.noRetry, true);
  await sleep(900);
  assert.ok((await readLog()).some(x => x.kind === 'reply' && x.op === 'hold'), 'no late hold reply');
  await s.close();
});

add('new', 'caller-stop', 'stop() while typing (a caller cancel): acknowledged; the request in flight ends with the helper\'s own aborted reply; nothing posted after', async () => {
  const s = open(fakeEnv('ack', '', { FAKE_KEY_MS: 40 }));
  const p = s.request({ op: 'type', text: 'y'.repeat(60) }).then(() => null, x => x);
  await sleep(250);
  const st = await s.stop('caller');
  const e = await p;
  const at = Date.now();
  assert.equal(st.how, 'ack');
  assert.ok(e, 'typing was not stopped');
  assert.ok(e.reply?.postedInput > 0 && e.reply.postedInput < 60, `postedInput ${e.reply?.postedInput}`);
  const log = await readLog();
  const ack = log.find(x => x.kind === 'reply' && x.op === 'revokeNative');
  assert.deepEqual(log.filter(x => x.kind === 'post' && x.t > ack.t), [], 'posted after the acknowledgement');
  await nothingAfter(at, 'caller-stop', { allowRecv: ['end'] });
  await s.close();
});

add('new', 'real-helper-dryrun', 'the real helper (bin/cgevent, CGEVENT_DRYRUN=1: posts nothing) acknowledges both stops: a type request past its timeout, and a caller stop that ends typing under way', async () => {
  const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'cgevent');
  const env = () => ({ ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: 'stop', CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.stop${process.pid}.${++logN}` });
  const begin = async s => {
    const b = await s.request({ op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, rateMs: 2 });
    if (b.dryRun !== true) { process.kill(s.pid, 'SIGKILL'); throw new Error('not in dry-run mode; refusing to continue'); }
  };
  const text = 'a fairly long line typed key by key, much longer than the timeout allows';
  const a = bridge.openInputSession({ bin: BIN, env: env() });
  spawned.push(a);
  await begin(a);
  const e = await a.request({ op: 'type', text }, { timeoutMs: 300 }).then(() => null, x => x);
  assert.equal(e?.code, 'session_timeout');
  assert.equal(e.helperStop, 'ack', e.message);
  const end = await a.close();
  assert.equal(end?.ok, true, 'no end reply after the acknowledged stop');
  const b = bridge.openInputSession({ bin: BIN, env: env() });
  spawned.push(b);
  await begin(b);
  const p = b.request({ op: 'type', text }).then(() => null, x => x);
  await sleep(300);
  const st = await b.stop('caller');
  const err = await p;
  assert.equal(st.how, 'ack');
  assert.equal(err?.reply?.error, 'aborted', `typing not aborted: ${err?.message}`);
  assert.ok(err.reply.typed < [...text].length, `typed ${err.reply.typed}`);
  await b.close();
  evidence.push(`real-helper-dryrun: timeout → ack; caller stop → ack, typing aborted after ${err.reply.typed}/${[...text].length} characters`);
});

/* ------------------------------------------------------------ new fix: production callTool paths */

let state, sessionOpts;
const target = id => ({ tabId: id, windowId: 7, chromePid: 42, cgWindow: 70, tabActive: true,
  bounds: { left: 0, top: 0, width: 1200, height: 900 }, url: state.urls[id], title: `t${id}` });
function page(kind, vars, tab) {
  const t = target(tab == null ? 10 : Number(tab));
  if (kind === 'block') return { ok: true, blocked: null, target: t };
  if (kind === 'temporal') return { ok: true, fail: 'not_temporal', target: t };
  // click's preflight (locate, arm the delivery listener), as in input-budget.test.mjs.
  if (kind === 'locate') return { bounds: t.bounds, view: { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900 },
    aim: { x: 100, y: 112 }, rect: { x: 10, y: 100, width: 200, height: 24 }, visible: { x: 10, y: 100, width: 200, height: 24 }, hitOk: true, chain: [], target: t };
  if (kind === 'ack') return { ok: true, armed: true, target: t };
  if (kind === 'native-select') return { ok: true, nativeSelect: false, hasFocus: true, target: t };   // FOCUS4: the page owns keyboard focus
  if (kind === 'after') return { ok: true, hasFocus: true, activeEditable: true, activeIsTarget: true, bindingMatches: true, selectionStable: true,
    selectionAll: true, href: t.url, focusMoved: false, changed: false, fieldHasText: false, confirmedChars: 0, target: t };
  return { ok: true, target: t };
}
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in stop test`); }]));
  return Object.assign(fake, {
    pageDialog: async () => ({ ok: true, open: false }),
    ensureScreenAwake: async () => (state.screen ? state.screen() : { locked: false, displays: 1, woke: false }),
    axInput: async () => ({ ok: true, frontmost: true, windowMatches: true, nodeFound: true, documentToken: 'doc1', focusedDocumentToken: 'doc1' }),
    pageScript: async (kind, vars = {}) => `fakePage(${JSON.stringify(kind)}, ${JSON.stringify(vars)})`,
    evalInPage: async (src, tab) => {
      state.calls?.push(`eval ${[...src.matchAll(/fakePage\("(\w+)"/g)].map(m => m[1]).join('+')}`);
      await state.onRead?.();
      return JSON.parse(vm.runInNewContext(src, { fakePage: (k, v) => JSON.stringify(page(k, v, tab)) }));
    },
    chromeInfo: async tab => { state.calls?.push('chromeInfo'); await state.onRead?.(); return target(tab == null ? 10 : Number(tab)); },
    listTabs: async () => ({ ok: true, frontmost: 'WeChat', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
      tabs: Object.keys(state.urls).map(id => ({ id: Number(id), url: state.urls[id], title: `t${id}`, active: Number(id) === 10 })) }] }),
    openInputSession: () => { state.sessions++; const s = open(state.env, sessionOpts); state.lastKills = s.kills; return s; },
    snapshotScene: async () => ({ appPid: 99, chromeWindow: 7, chromeTab: 10 }),
    restoreScene: async (_scene, options) => { await options.native({ kind: 'restoreScene' }, { policy: 'restore' }); return { ok: true, appFrontmost: true }; },
    activateChrome: async (id, hint, opts) => {
      await opts.native({ kind: 'activate', tabId: id, windowId: hint.windowId });
      return { ok: true, targetOnTop: true, ...target(id), frontmostPid: 42, keyWindowIsTarget: true,
        geometry: { mode: 'fit-current', beforeBounds: { ...target(id).bounds }, displayId: 1, branch: 'usable', changed: false, possiblyChanged: false } };
    },
    openNavigationObserver: async () => ({ startedAt: Date.now(), untouched: async () => true, close: async () => {} }),
    cgevent: async (args) => {
      if (args[0] === 'mousepos') return { x: 10, y: 20 };
      if (args[0] === 'idle') return { ok: true, idle: 100, keyIdle: 100, held: [], clickIdle: 100 };
      return { displays: [] };
    },
  });
}
async function world(env, opts = {}) {
  for (const t = Date.now(); idx.__taskHoldForTests() && Date.now() - t < 3000;) await sleep(20);
  idx.__resetPanelTaskForTests();
  idx.__resetLedgerForTests();
  idx.__resetTypedForTests();
  idx.__setCallBudgetForTests(BUDGET, RESERVE);
  writeSettings({ inputMode: 'auto', inputSpeed: 1 });
  state = { urls: { 10: 'https://shop.test/form' }, sessions: 0, env };
  sessionOpts = opts;
  idx.__setBridgeForTests(fakeBridge());
  await T.registerTab(10, state.urls[10], { windowId: 7, agentName: 'stop-test' });
}
async function call(name, args, extra = {}, limit = BUDGET + 3000) {
  const started = Date.now();
  let timer;
  const r = await Promise.race([idx.callTool({ params: { name, arguments: args } }, extra),
    new Promise(res => { timer = setTimeout(res, limit, null); })]);
  clearTimeout(timer);
  assert.ok(r, `${name}: still running after ${limit} ms`);
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError,
    error: r.structuredContent?.error || null, ms: Date.now() - started, at: Date.now() };
}
const posts = log => log.filter(x => x.kind === 'post');

add('new', 'hold-never-answers', 'type_text: the hold never answers (60 s residual) → stopped within the call budget, acknowledged, not_sent; the released hold answers late and nothing activates or types', async () => {
  await world(fakeEnv('ack', 'hold', { FAKE_LATE_MS: BUDGET + 500 }));
  const r = await call('type_text', { tab: 10, text: 'abc', input_mode: 'keys' });
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'session_timeout', r.text);
  assert.equal(r.error?.inputDelivery, 'not_sent', r.text);
  assert.ok(r.ms < BUDGET, `returned after ${r.ms} ms (budget ${BUDGET})`);
  assert.match(r.text, /收到了确认/);
  // The released hold's late reply comes after the return: no activation, no key, nothing written after.
  await sleep(BUDGET + 800 - r.ms);
  const log = await readLog();
  assert.ok(log.some(x => x.kind === 'reply' && x.op === 'hold'), 'the late hold reply never came');
  assert.deepEqual(posts(log), [], `activated or typed: ${JSON.stringify(posts(log))}`);
  assert.deepEqual(log.filter(x => x.kind === 'recv' && ['nativeChrome', 'type', 'key', 'click'].includes(x.op)), [], 'an input request reached the child');
  await nothingAfter(r.at, 'hold-never-answers');
  evidence.push(`hold-never-answers: refused not_sent after ${r.ms} ms of a ${BUDGET} ms budget (was 60 s); late hold reply ignored, 0 posts`);
});

add('new', 'hold-never-answers-deaf', 'type_text: the hold never answers and the helper can be neither stopped nor seen to exit → unknown + no-retry within the budget', async () => {
  await world(fakeEnv('deaf', 'hold'), { noKill: true });
  const r = await call('type_text', { tab: 10, text: 'abc', input_mode: 'keys' });
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.inputDelivery, 'unknown', r.text);
  assert.match(r.text, /没有确认停止/);
  assert.ok(r.ms < BUDGET + 1500, `returned after ${r.ms} ms`);
  const recv = (await readLog()).filter(x => x.kind === 'recv' && x.t > r.at);
  await sleep(300);
  assert.deepEqual(recv, [], 'written after the return');
  await killSpawned();
  evidence.push(`hold-never-answers-deaf: unknown/noRetry after ${r.ms} ms`);
});

add('kept', 'caller-cancel-typing', 'type_text: the caller cancels while keys are being typed → the helper acknowledges the stop, typing ends there, sent/unknown + no-retry, nothing posted after', async () => {
  await world(fakeEnv('ack', '', { FAKE_KEY_MS: 150 }));
  const ac = new AbortController();
  const watch = (async () => {
    for (let i = 0; i < 400; i++) {
      if (posts(await readLog()).filter(x => x.op === 'key').length >= 2) { ac.abort(); return Date.now(); }
      await sleep(10);
    }
  })();
  const r = await call('type_text', { tab: 10, text: 'abcdefgh', input_mode: 'keys' }, { signal: ac.signal });
  const abortedAt = await watch;
  assert.ok(abortedAt, 'typing never started');
  assert.equal(r.isError, true, r.text);
  assert.ok(['sent', 'unknown'].includes(r.error?.inputDelivery), `${r.error?.inputDelivery}: ${r.text}`);
  const log = await readLog();
  const ack = log.find(x => x.kind === 'reply' && x.op === 'revokeNative');
  assert.ok(ack && ack.t <= r.at, 'no acknowledgement before the return');
  const keys = posts(log).filter(x => x.op === 'key');
  assert.ok(keys.length < 8, `all ${keys.length} keys typed`);
  assert.deepEqual(posts(log).filter(x => x.t > ack.t), [], 'posted after the acknowledgement');
  assert.ok(r.at - abortedAt < 2000, `returned ${r.at - abortedAt} ms after the cancel`);
  await nothingAfter(r.at, 'caller-cancel-typing');
  evidence.push(`caller-cancel-typing: ${keys.length}/8 keys, acknowledged, returned ${r.at - abortedAt} ms after the cancel (${r.error?.inputDelivery})`);
});

add('new', 'key-timeout', 'press_key: the key request outruns the session timeout (type_text\'s own is 300 s) → stopped and acknowledged before the call returns; unknown + no-retry; nothing written after', async () => {
  await world(fakeEnv('ack', 'key'), { timeoutMs: 1000 });
  const r = await call('press_key', { tab: 10, key: 'Return' });
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'session_timeout', r.text);
  assert.equal(r.error?.inputDelivery, 'unknown', r.text);
  assert.match(r.text, /收到了确认/);
  const log = await readLog();
  const ack = log.find(x => x.kind === 'reply' && x.op === 'cancel');
  assert.ok(ack && ack.t <= r.at, `no acknowledgement before the return: ${r.text}`);
  assert.deepEqual(posts(log).filter(x => x.t > ack.t), [], 'posted after the acknowledgement');
  await nothingAfter(r.at, 'key-timeout');
  evidence.push(`key-timeout: key request released after the acknowledgement; unknown/noRetry after ${r.ms} ms`);
});

add('new', 'caller-cancel-noack', 'type_text: the caller cancels and the helper never acknowledges → killed and its exit confirmed before the call returns; typing ends there', async () => {
  await world(fakeEnv('noack', '', { FAKE_KEY_MS: 150 }));
  const ac = new AbortController();
  const watch = (async () => {
    for (let i = 0; i < 400; i++) {
      if (posts(await readLog()).filter(x => x.op === 'key').length >= 2) { ac.abort(); return Date.now(); }
      await sleep(10);
    }
  })();
  const r = await call('type_text', { tab: 10, text: 'abcdefgh', input_mode: 'keys' }, { signal: ac.signal });
  const abortedAt = await watch;
  assert.ok(abortedAt, 'typing never started');
  assert.equal(r.isError, true, r.text);
  assert.ok(['sent', 'unknown'].includes(r.error?.inputDelivery), `${r.error?.inputDelivery}: ${r.text}`);
  const keys = posts(await readLog()).filter(x => x.op === 'key');
  assert.ok(keys.length < 8, `all ${keys.length} keys typed`);
  assert.ok(state.lastKills?.includes('SIGKILL'), 'not killed');
  assert.ok(r.at - abortedAt < 2000, `returned ${r.at - abortedAt} ms after the cancel`);
  await nothingAfter(r.at, 'caller-cancel-noack');
  evidence.push(`caller-cancel-noack: ${keys.length}/8 keys, no acknowledgement, SIGKILL + exit, returned ${r.at - abortedAt} ms after the cancel`);
});

add('new', 'close-unconfirmed', 'press_key completes, but close gets neither an end reply nor the exit (the reap now checks it): unknown + no-retry, not a success', async () => {
  await world(fakeEnv('deaf', 'end'), { noKill: true });
  const r = await call('press_key', { tab: 10, key: 'Return' }, {}, BUDGET + 6000);
  if (process.env.STOP_DEBUG) console.log(r.ms, JSON.stringify(await readLog()), state.lastKills);
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.inputDelivery, 'unknown', r.text);
  assert.match(r.text, /无法确认鼠标键盘助手已经停止/);
  evidence.push(`close-unconfirmed: press_key reported unknown/noRetry after ${r.ms} ms instead of success`);
});

add('new', 'eval-retry-refused', 'type_text: the site check\'s eval reports a read retry refused at the cut-off (bridge readRetryRefused) → call_deadline / not_sent, not cannot_check', async () => {
  await world(fakeEnv('ack', ''));
  const fb = fakeBridge(), evalReal = fb.evalInPage;
  fb.evalInPage = async (src, tab) => {
    if (/fakePage\("block"/.test(src)) throw Object.assign(new bridge.BridgeError('call_deadline', '⏳ 输入前的读取重试用掉了这次调用的时限：没有发送任何输入。'),
      { inputDelivery: 'not_sent', noRetry: true, readRetryRefused: true });
    return evalReal(src, tab);
  };
  idx.__setBridgeForTests(fb);
  const r = await call('type_text', { tab: 10, text: 'abc', input_mode: 'keys' });
  assert.equal(r.error?.code, 'call_deadline', r.text);
  assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.equal(state.sessions, 0, 'a session was opened');
});

/* ------------------------------------------------------------ new fix: a retry inside one bridge read */

add('new', 'read-retry-cutoff', 'the screen-state settle loop inside one bridge read: no further read starts after the cut-off; call_deadline, not_sent', async () => {
  await world(fakeEnv('ack', ''));
  const CUT = BUDGET - 1200 - RESERVE - 900;   // preparation 20 %, reserve, three keys at 1x
  let reads = 0, late = 0, t0 = 0;
  state.screen = () => bridge.ensureScreenAwake({ waitMs: 60_000, probes: {
    readDisplays: async () => { reads++; if (t0 && Date.now() - t0 > CUT) late++; await sleep(reads === 1 ? 50 : 700); return { displays: [{}], displaysAsleep: false, locked: true }; },
    sleep: ms => sleep(ms), wake: async () => {} } });
  t0 = Date.now();
  const r = await call('type_text', { tab: 10, text: 'abc', input_mode: 'keys' });
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'call_deadline', r.text);
  assert.equal(r.error?.inputDelivery, 'not_sent');
  assert.equal(late, 0, `${late} screen reads started after the cut-off`);
  assert.ok(r.ms < BUDGET, `returned after ${r.ms} ms`);
  assert.equal(state.sessions, 0, 'a session was opened');
  evidence.push(`read-retry-cutoff: ${reads} screen reads, none after the cut-off (${CUT} ms); call_deadline after ${r.ms} ms`);
});

/* ------------------------------------------------------------ round 2 (Codex QA A1): a cancel during a job's final observation */

/** A click inside a job (task): the caller cancels during the kept branch's final observation (after its two healthy
 * statuses). The return waits for the acknowledgement or the exit, no hold is kept, nothing is written after. */
async function cancelDuringObserve(mode, extra, label) {
  await world(fakeEnv(mode, '', extra));
  idx.__setTaskGapForTests(30_000);
  const ac = new AbortController();
  let abortedAt = 0, session = null;
  const open0 = fakeBridge().openInputSession;
  state.calls = [];
  state.onRead = async () => {
    if (abortedAt) return;
    const log = await readLog();
    const click = log.findIndex(x => x.kind === 'post' && x.op === 'click');
    if (click < 0 || log.slice(click).filter(x => x.kind === 'reply' && x.op === 'status').length < 2) return;
    abortedAt = Date.now(); ac.abort();
    await sleep(30);   // the observation itself ends before the stop is decided
  };
  const fb = fakeBridge();
  fb.openInputSession = () => { session = open0(); return session; };
  idx.__setBridgeForTests(fb);
  const r = await call('click', { tab: 10, marker: 1, task: 'stop job' }, { signal: ac.signal });
  assert.ok(abortedAt, `the cancel never came during the observation: ${state.calls}`);
  const helperStop = session?.helperStop;
  const hold = idx.__taskHoldForTests();
  const log = await readLog();
  assert.equal(r.isError, true, `${label}: returned success: ${r.text}`);
  assert.ok(['ack', 'exit'].includes(helperStop), `${label}: returned before the stop was decided (helperStop ${helperStop})`);
  assert.equal(hold, null, `${label}: a stopped session was kept as the job's hold`);
  assert.equal(r.error?.inputDelivery === 'not_sent', false, `${label}: not_sent after a click`);
  await nothingAfter(r.at, label);
  await idx.callTool({ params: { name: 'task_plan', arguments: { task: 'stop job', done: true } } }, {});
  return { r, helperStop, abortedAt, log };
}

add('new', 'job-cancel-observe-delayed-ack', 'task: a cancel during the final observation, the acknowledgement 400 ms late → returns only after it, no hold kept, nothing written after', async () => {
  const { r, abortedAt, log } = await cancelDuringObserve('ack', { FAKE_ACK_MS: 400 }, 'delayed ack');
  const ack = log.find(x => x.kind === 'reply' && x.op === 'revokeNative');
  assert.ok(ack && ack.t <= r.at, 'returned before the acknowledgement');
  assert.ok(r.at - abortedAt >= 400, `returned ${r.at - abortedAt} ms after the cancel`);
  evidence.push(`job-cancel-observe-delayed-ack: returned ${r.at - abortedAt} ms after the cancel (ack at +${ack.t - abortedAt} ms), ${r.error?.code}/${r.error?.inputDelivery}, no hold`);
});

add('new', 'job-cancel-observe-no-ack', 'task: a cancel during the final observation, no acknowledgement → killed, exit confirmed before the return, no hold kept', async () => {
  const { r, helperStop, abortedAt } = await cancelDuringObserve('noack', {}, 'no ack');
  assert.equal(helperStop, 'exit');
  evidence.push(`job-cancel-observe-no-ack: exit confirmed, returned ${r.at - abortedAt} ms after the cancel, ${r.error?.code}/${r.error?.inputDelivery}, no hold`);
});

/* ------------------------------------------------------------ kept behaviour */

add('kept', 'typing-completes', 'type_text within its timeout through the real session: typed to the end, nothing stopped or killed', async () => {
  await world(fakeEnv('ack', '', { FAKE_KEY_MS: 20 }));
  const r = await call('type_text', { tab: 10, text: 'abc', input_mode: 'keys' });
  const log = await readLog();
  assert.equal(posts(log).filter(x => x.op === 'key').length, 3, r.text);
  assert.equal(log.some(x => x.kind === 'recv' && (x.op === 'cancel' || x.op === 'revokeNative')), false, 'stopped');
  assert.ok(log.some(x => x.kind === 'recv' && x.op === 'end'), 'not closed with end');
});

for (const kind of ['new', 'kept']) {
  console.log(kind === 'new' ? 'new fix (fails with the source change reverted)' : 'kept behaviour');
  for (const c of cases.filter(x => x.kind === kind && (!ONLY || x.name === ONLY))) {
    try { await c.fn(); } finally { await killSpawned(); }
    passed++;
    console.log(`  ok  [${c.name}] ${c.label}`);
  }
}
assert.ok(passed > 0, `no case named ${ONLY}`);
idx.__resetPanelTaskForTests();
for (const line of evidence) console.log(`  evidence  ${line}`);
console.log(`\ninput-stop tests passed (${passed}).`);
process.exit(0);
