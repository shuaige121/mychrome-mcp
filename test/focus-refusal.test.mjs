#!/usr/bin/env node
/* FOCUS3 (problems-20261101, contracts-batch3.md, with coordinator rulings r1): a focus refusal returns fast, says what it
 * saw, and tells the agent not to work around it. An activation refusal is tagged where it is raised; only tagged errors
 * get the new retry table and wording.
 * New fix (fails with src/index.js and src/settings.js reverted to 3acd761):
 *   retry        the fake helper counts activation requests: 1 when the completed activation's own sample shows another
 *                app in front or the target not key; at most 2 otherwise. A fake activation takes 1.7 s (a conservative
 *                fixture constant; the field attempt is about 2 s); the reply, release and cleanup included, comes within
 *                4.0 s of the first activation request, and nothing of the call runs after it.
 *   text         front app (from the sample) and the failed check; three input-observation states (detected, checked and
 *                none detected, unknown); "没有发送点击或按键" only with the target action's non-delivery established;
 *                FOCUS_AGENT_LINE (the one exported constant); no planted page title or URL.
 *   partial-input (r3 A1) a tagged refusal after preparation input (a scroll wheel) still carries the facts, the input
 *                state, FOCUS_AGENT_LINE and the row fields; its delivery sentence is the partial-input wording; one attempt.
 *   field-focus  the page field focus refusal after the field click (index.js armAsk) is never retried; a RETRY_FEW error
 *                whose delivery is "sent" is never retried.
 *   agent-line   FOCUS_AGENT_LINE is exactly the coordinator's r2 text (the tests use the export; this pins its wording).
 *   instructions serverInstructions() carries the r2 sentence, verbatim.
 *   row          focusReason from the finite set and keyWindowIsTarget (boolean); anything else is dropped.
 * Kept behaviour: activate_unconfirmed (activation writes sent) was already one attempt; untagged family codes (the input
 * guard's window_changed, guard_window_not_top) keep their rules and text; no_such_tab keeps its three retries; a posted
 * field click followed by an armAsk failure is not replayed (the guard's sent ledger sets noRetry; r2 item 3).
 * Production callTool with a fake bridge; the real bridge.activateChrome turns the fake helper's reply into the error. The
 * field-focus case runs the production persist and armAsk sources in a vm (as input-wait-diagnostics.test.mjs does).
 * Nothing reaches Chrome or the input helper. FOCUS3_CASE=<name>[,<name>…] runs those cases; FOCUS3_SHOW=1 prints replies. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const ATTEMPT_MS = 1700, LIMIT_MS = 4000, QUICK_MS = 60;
const TITLE = 'Private fixture title 7f3a', URL_ = 'https://private-fixture.invalid/secret-path-7f3a';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-focus3-'));
Object.assign(process.env, {
  CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'), CHROME_BRIDGE_LOCK: path.join(tmp, 'lock', 'input.lock'),
  CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'agent-window.json'), CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_AGENT_NAME: 'focus3-test',
  CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_LANG: 'zh', CHROME_BRIDGE_WARM: '0',
});
for (const k of ['MYCHROME_FOCUS_BACKEND', 'MYCHROME_FOCUS_CARBON_FLAG', 'MYCHROME_FOCUS_RERAISE', 'CHROME_BRIDGE_RETRY_MAX_MS',
  'CHROME_BRIDGE_CALL_BUDGET_MS', 'CHROME_BRIDGE_IDLE_S', 'CHROME_BRIDGE_TAKEOVER']) delete process.env[k];
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const idx = await import('../src/index.js');
const bridge = await import('../src/bridge.js');
const T = await import('../src/tabs.js');
const S = await import('../src/settings.js');
const SOURCE = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const ACTIVITY = process.env.CHROME_BRIDGE_ACTIVITY;
const ONLY = process.env.FOCUS3_CASE ? process.env.FOCUS3_CASE.split(',') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
idx.__recordForTests(true);

/* ------------------------------------------------------------ fixture */

const BOUNDS = { left: 0, top: 0, width: 1200, height: 900 };
// The one exported constant (ruling 9). Missing (3acd761): a marker no text contains, so the cases fail on their own lines.
const AGENT_LINE = typeof idx.FOCUS_AGENT_LINE === 'string' && idx.FOCUS_AGENT_LINE.startsWith('给 agent：') ? idx.FOCUS_AGENT_LINE : '\u0000no FOCUS_AGENT_LINE export';
const NONE = '本次检查未检测到键盘或鼠标输入。', UNKNOWN = '无法确认期间是否有用户输入。';
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
  if (kind === 'native-select') return { ok: true, nativeSelect: false, hasFocus: true, target: t };   // FOCUS4: the page owns keyboard focus
  throw new Error(`unexpected page script ${kind}`);
}
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in focus3 test`); }]));
  return Object.assign(fake, {
    pageDialog: async () => ({ ok: true, open: false }),
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
  state = { urls: { 10: 'https://shop.test/form' }, baseCg: o.baseCg ?? 70, cg: o.baseCg ?? 70, activations: [], activateMs: ATTEMPT_MS,
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
const said = r => `${r.attempts} activation request(s), reply ${r.sinceFirst} ms after the first; ${r.error?.code}`;
/** Ruling 1: the bound includes release and cleanup: once the reply is back, nothing of the call runs any more. */
async function nothingAfter(r, label) {
  await sleep(300);
  const late = log.filter((e, i) => logAt[i] > r.at);
  assert.deepEqual(late, [], `${label}: ran after the reply: ${late}`);
}
function refusal(r, code, label) {
  assert.equal(r.isError, true, `${label}: ${r.text}`);
  assert.equal(r.error?.code, code, `${label}: ${r.text}`);
  assert.deepEqual(r.inputs, [], `${label}: a click or key was posted: ${log}`);
  assert.equal(r.text.includes(TITLE), false, `${label}: the planted page title reached the agent: ${r.text}`);
  assert.equal(/private-fixture|secret-path/.test(r.text), false, `${label}: the planted URL reached the agent: ${r.text}`);
  assert.equal(r.rows, 1, `${label}: one activity row`);
}
/** The FOCUS3 wording: facts, then the input-observation state, then FOCUS_AGENT_LINE, in that order; the row. */
function told(r, { reason, front, key, input = NONE, label, legacyText = false }) {
  const t = r.text;
  assert.match(t, /没有发送点击或按键/, `${label}: ${t}`);
  assert.ok(t.includes(`最前面的 App：${front}`), `${label}: front app ${front} not named: ${t}`);
  assert.ok(t.includes(`未通过的检查：${CHECK[reason]}。`), `${label}: failed check "${CHECK[reason]}" not named: ${t}`);
  const at = t.indexOf(input);
  assert.ok(at > 0, `${label}: the input-observation line "${input}" is missing: ${t}`);
  for (const other of [NONE, UNKNOWN, '这次调用期间检测到了键盘或鼠标输入'].filter(x => !input.startsWith(x))) {
    assert.equal(t.includes(other), false, `${label}: a second input-observation state "${other}": ${t}`);
  }
  assert.doesNotMatch(t, /在打字|正在输入/, `${label}: claims typing: ${t}`);
  assert.equal(t.split(AGENT_LINE).length, 2, `${label}: FOCUS_AGENT_LINE, exactly once: ${t}`);
  assert.ok(t.indexOf(`未通过的检查：${CHECK[reason]}`) < at && at < t.indexOf(AGENT_LINE), `${label}: facts, input, agent line out of order: ${t}`);
  // not_key_window keeps 3acd761's wording (ruling 8: FOCUS4 retires it); the others lost the "fix it yourself" ending.
  if (!legacyText) assert.doesNotMatch(t, /请先处理遮挡|请先检查遮挡|请重试。/, `${label}: an old "fix it yourself / retry" ending survived: ${t}`);
  assert.equal(r.row?.focusReason, reason, `${label}: activity row ${JSON.stringify(r.row)}`);
  if (key === undefined) assert.equal('keyWindowIsTarget' in (r.row || {}), false, `${label}: row ${JSON.stringify(r.row)}`);
  else assert.equal(r.row?.keyWindowIsTarget, key, `${label}: row keyWindowIsTarget ${JSON.stringify(r.row)}`);
}

const cases = [];
const add = (kind, name, label, fn) => cases.push({ kind, name, label, fn });
/** Every sample is checked (and, with FOCUS3_SHOW=1, printed) before the case fails on the first broken one. */
async function each(items, fn) {
  const broken = [];
  for (const item of items) { try { await fn(item); } catch (e) { broken.push(e); } }
  if (broken.length) { broken[0].message = `${broken.length}/${items.length} sample(s) failed; first: ${broken[0].message}`; throw broken[0]; }
}
const evidence = [];

/* ------------------------------------------------------------ new fix: retry */

// FOCUS4 (contracts-batch4.md): the "target not key" samples of this case are retired (the AX key window no longer
// refuses; test/focus-destination.test.mjs). Another app in front is still refused once, now by prepareActivate's
// recipient check (activate_unconfirmed, other_app_front) instead of not_key_window.
add('new', 'retry-no-repeat', 'the completed activation\'s sample shows another app in front: one activation request, reply and cleanup within 4.0 s', async () => {
  await each([
    ['click', { tab: 10, marker: 1 }, confirmed({ keyWindowIsTarget: false, frontmost: 'Terminal', frontmostPid: 555 }), 'another app in front'],
    ['press_key', { tab: 10, key: 'enter' }, confirmed({ keyWindowIsTarget: false, frontmost: 'Terminal', frontmostPid: 555 }), 'another app in front'],
  ], async ([tool, args, activation, sample]) => {
    await world({ activation });
    const r = await run(tool, args);
    evidence.push(`retry-no-repeat ${tool} (${sample}): ${said(r)}`);
    refusal(r, 'activate_unconfirmed', `${tool} ${sample}`);
    assert.equal(r.attempts, 1, `${tool} ${sample}: ${said(r)}`);
    assert.ok(r.sinceFirst <= LIMIT_MS, `${tool} ${sample}: ${said(r)}`);
    await nothingAfter(r, `${tool} ${sample}`);
  });
});

add('new', 'retry-transient', 'an activation refusal whose sample shows neither another app in front nor a non-key target: two activation requests, reply and cleanup within 4.0 s', async () => {
  // click: the window moved during each activation (window_changed at the locate after it); press_key: the helper's
  // focus_unconfirmed (the installed 39989aa's field code) and activate_failed, with no focus sample.
  await each([['click', { tab: 10, marker: 1 }, moved(), 'window_changed'],
    ['press_key', { tab: 10, key: 'enter' }, refused('focus_unconfirmed'), 'focus_unconfirmed'],
    ['press_key', { tab: 10, key: 'enter' }, refused('activate_failed'), 'activate_failed']], async ([tool, args, activation, code]) => {
    await world({ activation });
    const r = await run(tool, args);
    evidence.push(`retry-transient ${tool} ${code}: ${said(r)}`);
    refusal(r, code, `${tool} ${code}`);
    assert.equal(r.attempts, 2, `${tool} ${code}: ${said(r)}`);
    assert.ok(r.sinceFirst <= LIMIT_MS, `${tool} ${code}: ${said(r)}`);
    assert.match(r.text, /此前已自动重试 1 次/);
    await nothingAfter(r, `${tool} ${code}`);
  });
});

/* ------------------------------------------------------------ new fix: text and row */

add('new', 'text-samples', 'each tagged activation refusal names the front app (its sample\'s) and the failed check, the input state and FOCUS_AGENT_LINE; row focusReason and keyWindowIsTarget', async () => {
  // [label, helper reply, code, reason, front, row keyWindowIsTarget (undefined: none), options]
  await each([
    ['other app in front', unconfirmed(otherApp), 'activate_unconfirmed', 'other_app_front', '「Terminal」', false],
    ['covered by a named window', unconfirmed({ targetOnTop: false, keyWindowIsTarget: true, frontmost: 'Google Chrome', frontmostPid: 42,
      focusBlocker: { owner: 'ChatGPT', pid: 777, layer: 3, width: 400, height: 300 } }), 'activate_unconfirmed', 'covered', '「Google Chrome」', true],
    ['on top but not key (sample)', unconfirmed({ targetOnTop: true, keyWindowIsTarget: false, frontmost: 'Google Chrome', frontmostPid: 42, focusBlocker: null }),
      'activate_unconfirmed', 'not_key', '「Google Chrome」', false],
    ['tab not current', unconfirmed({ targetOnTop: true, keyWindowIsTarget: true, frontmost: 'Google Chrome', frontmostPid: 42, focusBlocker: null }),
      'activate_unconfirmed', 'tab_not_current', '「Google Chrome」', true],
    // FOCUS4: 'not key (server check)' retired: a non-key target is not refused (test/focus-destination.test.mjs).
    ['no sample (helper)', refused('focus_unconfirmed'), 'focus_unconfirmed', 'unknown', '未知', undefined],
    // FOCUS4: CG order is no longer a veto; the front app still is, for a click or a key (prepareActivate).
    ['another app in front (server check)', confirmed({ targetOnTop: false, frontmost: 'Terminal', frontmostPid: 555 }), 'activate_unconfirmed', 'other_app_front', '「Terminal」', true],
    ['no system window (activation result)', confirmed({ cgWindow: null }), 'no_cg_window', 'unknown', '「Google Chrome」', true],
    // A tagged code RETRY_FEW never retried gets no retry now either.
    ['no system window (helper)', refused('no_cg_window'), 'no_cg_window', 'unknown', '未知', undefined, { attempts: 1 }],
  ], async ([label, activation, code, reason, front, key, o = {}]) => {
    await world({ activation, activateMs: QUICK_MS });
    const r = await run('click', { tab: 10, marker: 1 });
    evidence.push(`text ${label}: ${code} → focusReason ${r.row?.focusReason}, keyWindowIsTarget ${r.row?.keyWindowIsTarget}; ${said(r)}`);
    refusal(r, code, label);
    told(r, { reason, front, key, label, legacyText: o.legacyText });
    if (code === 'activate_unconfirmed' && reason === 'covered') assert.match(r.text, /挡在目标窗口前面的是「ChatGPT」的窗口（pid 777，layer 3，400×300）/);
    if (o.attempts) assert.equal(r.attempts, o.attempts, `${label}: ${said(r)}`);
  });
});

add('new', 'text-input-states', 'input detected (the hands-off wait waited; the hold swallowed keys), checked and none (every attempt: a read and a counted hold end), or unknown (a read failed, a hold end gave no counts or failed, in any attempt)', async () => {
  let reads = 0;
  const noCounts = { ok: true, takeover: { active: false } };
  const failSecond = () => (++reads >= 2 ? (() => { throw new Error('idle read failed (fixture)'); })() : QUIET());
  // [label, world options, expected line, the refusal: [code, reason, front, row keyWindowIsTarget]]
  const other = ['activate_unconfirmed', 'other_app_front', '「Terminal」', false], movedRefusal = ['window_changed', 'unknown', '未知', undefined];
  await each([
    ['waited', { idle: () => (++reads === 1 ? { ok: true, idle: 0.2, keyIdle: 0.2, held: [] } : QUIET()) }, '这次调用期间检测到了键盘或鼠标输入（等过用户停手）。', other],
    ['swallowed', { swallowedKeys: 2 }, '这次调用期间检测到了键盘或鼠标输入（接管期间拦下了输入）。', other],
    ['checked, none', {}, NONE, other],
    ['idle read failed', { idle: () => { throw new Error('idle read failed (fixture)'); } }, UNKNOWN, other],
    ['no hold counts', { closeReply: noCounts }, UNKNOWN, other],
    ['hold end failed', { closeReply: new Error('end failed (fixture)') }, UNKNOWN, other],
    ['two attempts, the second idle read failed', { activation: moved(), idle: failSecond }, UNKNOWN, movedRefusal],
    ['two attempts, the second hold end without counts', { activation: moved(), closeReply: n => (n >= 2 ? noCounts : null) }, UNKNOWN, movedRefusal],
    ['two attempts, both checked', { activation: moved() }, NONE, movedRefusal],
  ], async ([label, o, input, [code, reason, front, key]]) => {
    reads = 0;
    await world({ activation: unconfirmed(otherApp), activateMs: QUICK_MS, ...o });
    const r = await run('click', { tab: 10, marker: 1 });
    evidence.push(`text-input-states ${label}: ${input}; ${said(r)}`);
    refusal(r, code, label);
    told(r, { reason, front, key, input, label });
  });
});

add('new', 'text-transient', 'a retried activation refusal (window moved) ends with the facts (no front app read by that check), the input state and FOCUS_AGENT_LINE', async () => {
  await world({ activateMs: QUICK_MS, activation: moved() });
  const r = await run('click', { tab: 10, marker: 1 });
  evidence.push(`text-transient: ${said(r)}`);
  refusal(r, 'window_changed', 'moved window');
  told(r, { reason: 'unknown', front: '未知', key: undefined, label: 'moved window' });
});

add('new', 'field-focus', 'production persist and armAsk: the field focus refusal after the field click is never retried; a RETRY_FEW error delivered "sent" is never retried', async () => {
  const fn = name => { const a = SOURCE.search(new RegExp(`(?:async )?function ${name}\\(`)); assert.ok(a >= 0, name); return SOURCE.slice(a, SOURCE.indexOf('\n}', a) + 2); };
  const konst = name => { const a = SOURCE.indexOf(`const ${name} =`); assert.ok(a >= 0, name); return SOURCE.slice(a, SOURCE.indexOf(';\n', a) + 1); };
  class BridgeError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const c = vm.createContext({ BridgeError, Error, Object, Array, Set, Number, Math, Date, JSON, Promise,
    process: { env: {} }, uiEnglish: () => false, CALL: { getStore: () => ({}) }, RETRY: { maxMs: 600_000, few: 3, pauseMs: 1 }, USER_IDLE_MAX_WAIT_MS: 60_000,
    sleep: async () => {}, cancelledError: () => new BridgeError('cancelled', 'cancelled'), userIdleS: () => 0,
    gatedPageScript: async () => 'ask', passGate: r => r, B: { evalInPage: async () => ({ ok: true, armed: false, error: 'focus_unconfirmed' }) } });
  vm.runInContext(['RETRY_WAIT', 'RETRY_FEW', 'SECURE_WAIT_MS', 'AGENT_PARTIAL', 'FOCUS_AGENT_LINE', 'idleForAttempt'].map(konst).join('\n') +
    '\n' + fn('persist') + '\n' + fn('armAsk') + '\nglobalThis.persist = persist; globalThis.armAsk = armAsk;', c);
  const attempts = async make => { let n = 0; const e = await c.persist(async () => { n++; throw await make(); }).catch(x => x); return { n, e }; };
  // (a) armAsk's own refusal, even with no guard ledger to say the field click went out.
  const a = await attempts(async () => Object.assign(await c.armAsk(10, 3, 'why', { check: async () => {} }, 'tok').catch(x => x), { sent: [] }));
  evidence.push(`field-focus armAsk: ${a.n} attempt(s), ${a.e.code}, noRetry ${a.e.noRetry}`);
  assert.equal(a.e.code, 'focus_unconfirmed');
  assert.equal(a.n, 1, 'the field focus refusal after the field click was retried');
  assert.equal(a.e.message.includes(c.FOCUS_AGENT_LINE ?? AGENT_LINE), false, 'the page field refusal is not an activation refusal');
  // (b) an untagged RETRY_FEW error whose delivery is "sent": not retried; the same with no delivery keeps three retries.
  const b = await attempts(() => Object.assign(new BridgeError('focus_unconfirmed', 'x'), { inputDelivery: 'sent', sent: [] }));
  const b0 = await attempts(() => Object.assign(new BridgeError('focus_unconfirmed', 'x'), { sent: [] }));
  evidence.push(`field-focus delivery sent: ${b.n} attempt(s); no delivery: ${b0.n} attempt(s)`);
  assert.equal(b.n, 1, 'a RETRY_FEW error delivered "sent" was retried');
  assert.equal(b0.n, 4, 'kept: an untagged RETRY_FEW error without delivery keeps three retries');
});

add('new', 'partial-input', 'r3 A1, production callTool: click on a target below the fold: the pointer move and one wheel are posted, then the relocate sees the window moved (tagged window_changed): facts, input state, FOCUS_AGENT_LINE, row fields and the partial-input wording, no no-click claim; one activation request; delivery left as the guard set it', async () => {
  const below = { aim: { x: 100, y: 2000 }, rect: { x: 10, y: 1988, width: 200, height: 24 }, visible: null, hitOk: false,
    chain: [{ document: true, clip: { x: 0, y: 0, width: 1200, height: 800 }, scrollableY: true, scrollTop: 0, maxTop: 5000, sig: 'doc',
      wheel: { down: { x: 600, y: 400 }, up: { x: 600, y: 400 } } }] };
  // baseCg 73: a window whose geometry no earlier case left unverified; after the wheel the page reports the window moved.
  await world({ activateMs: QUICK_MS, baseCg: 73, locate: t => (state.wheels ? { bounds: { ...t.bounds, left: 300 } } : below) });
  const r = await run('click', { tab: 10, marker: 1 });
  evidence.push(`partial-input: ${said(r)}; posted ${r.inputs.join(', ')}; inputDelivery ${r.error?.inputDelivery}; row ${r.row?.focusReason}`);
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'window_changed', r.text);
  assert.equal(state.wheels, 1, `the wheel was not reached: ${log}`);
  assert.deepEqual(r.inputs, ['session move', 'session wheel'], `posted: ${log}`);
  assert.equal(r.attempts, 1, `a refusal after posted input was retried: ${said(r)}`);
  assert.equal(r.error?.inputDelivery, 'unknown', 'unknown stays unknown (the guard\'s own delivery)');
  const t = r.text;
  assert.ok(t.includes('这次已经发出了部分输入，先 read_page 看页面现状再决定是否重做'), `the partial-input wording is missing: ${t}`);
  assert.equal(t.includes('没有发送点击或按键'), false, `claims nothing was sent after a wheel: ${t}`);
  assert.ok(t.includes(`最前面的 App：未知（这次检查没有读取前台 App）；未通过的检查：${CHECK.unknown}。`), `facts missing: ${t}`);
  assert.ok(t.includes(NONE), `the input-observation line is missing: ${t}`);
  assert.equal(t.split(AGENT_LINE).length, 2, `FOCUS_AGENT_LINE, exactly once: ${t}`);
  assert.equal(t.includes(TITLE) || /private-fixture|secret-path/.test(t), false, `a planted title or URL: ${t}`);
  assert.equal(r.row?.focusReason, 'unknown', `row ${JSON.stringify(r.row)}`);
  assert.equal('keyWindowIsTarget' in (r.row || {}), false, `row ${JSON.stringify(r.row)}`);
  await nothingAfter(r, 'partial input');
});

// FOCUS4 amendment B (contracts-batch4.md "User decision 3"): the agent may activate Chrome itself, read and retry once.
add('new', 'agent-line', 'FOCUS_AGENT_LINE is exactly the user decision 3 text (one exported constant)', async () => {
  assert.equal(idx.FOCUS_AGENT_LINE, '给 agent：MyChrome 没能把 Chrome 切到最前面。可以先运行 `osascript -e \'tell application "Google Chrome" to activate\'` ' +
    '把 Chrome 切到前面，再 read_page 同一标签后重试一次；不要换别的浏览器工具绕过。重试仍失败再告诉用户原因，不要让用户去点窗口。');
});

add('new', 'instructions', 'serverInstructions() carries the user decision 3 sentence verbatim, once, and not the old no-self-activation one', async () => {
  const text = idx.serverInstructions({ home: '/nonexistent-home', execPath: '/nonexistent/node' });
  const sentence = 'If MyChrome cannot bring Chrome to the front, you may activate Chrome yourself (osascript … activate), read_page the same tab ' +
    'and retry once; never switch browser tools for it, and do not ask the user to click the window.';
  assert.equal(text.split(sentence).length, 2, `the sentence, exactly once: ${text}`);
  assert.doesNotMatch(text, /not yours to fix|never activate Chrome or switch apps yourself/, 'the old sentence survived');
  evidence.push(`instructions: ${text.length} characters`);
});

add('new', 'row-whitelist', 'activityRecord keeps focusReason only from its finite set and keyWindowIsTarget only as a boolean', async () => {
  const base = { tool: 'click', ok: false, t: 1, pid: 1 };
  for (const reason of ['other_app_front', 'covered', 'not_key', 'tab_not_current', 'unknown']) {
    assert.equal(S.activityRecord({ ...base, focusReason: reason }).focusReason, reason);
  }
  for (const bad of ['user_typing', 'Other_App_Front', 'covered ', '', null, 1, ['covered'], { reason: 'covered' }, 'https://private.invalid/']) {
    assert.equal('focusReason' in S.activityRecord({ ...base, focusReason: bad }), false, JSON.stringify(bad));
  }
  for (const key of [true, false]) assert.equal(S.activityRecord({ ...base, keyWindowIsTarget: key }).keyWindowIsTarget, key);
  for (const bad of ['true', 'false', 1, 0, null, {}, ['x']]) {
    assert.equal('keyWindowIsTarget' in S.activityRecord({ ...base, keyWindowIsTarget: bad }), false, JSON.stringify(bad));
  }
});

/* ------------------------------------------------------------ kept behaviour */

add('kept', 'unconfirmed-once', 'activate_unconfirmed with another app in front (its activation writes sent): one activation request, within 4.0 s (already so at 3acd761)', async () => {
  await world({ activation: unconfirmed(otherApp) });
  const r = await run('click', { tab: 10, marker: 1 });
  evidence.push(`unconfirmed-once: ${said(r)}`);
  refusal(r, 'activate_unconfirmed', 'unconfirmed');
  assert.equal(r.attempts, 1, said(r));
  assert.ok(r.sinceFirst <= LIMIT_MS, said(r));
  await nothingAfter(r, 'unconfirmed');
});

add('kept', 'outside-family', 'untagged family codes keep their rules and text: the input guard\'s window_changed (window rebound between preflight and activation) keeps three retries; guard_window_not_top none; no focus wording or row fields', async () => {
  await world({ activateMs: QUICK_MS, swapCg: true });
  const w = await run('click', { tab: 10, marker: 1 });
  evidence.push(`outside-family guard window_changed: ${said(w)}`);
  assert.equal(w.error?.code, 'window_changed', w.text);
  assert.match(w.text, /窗口在准备和切到前台之间变了（70 → 71），没有操作。/);
  assert.equal(w.attempts, 4, said(w));
  await world({ activateMs: QUICK_MS, keyReply: { ok: false, error: 'guard', why: 'window_not_top', postedInput: 0 } });
  const g = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`outside-family guard_window_not_top: ${said(g)}`);
  assert.equal(g.error?.code, 'guard_window_not_top', g.text);
  assert.equal(g.attempts, 1, said(g));
  for (const [r, label] of [[w, 'guard window_changed'], [g, 'guard_window_not_top']]) {
    assert.deepEqual(r.inputs, [], label);
    assert.equal(r.text.includes(AGENT_LINE), false, `${label}: ${r.text}`);
    assert.equal(/未通过的检查|本次检查未检测到|无法确认期间是否有用户输入/.test(r.text), false, `${label}: ${r.text}`);
    assert.equal('focusReason' in (r.row || {}), false, `${label}: ${JSON.stringify(r.row)}`);
    // FOCUS4: a completed activation's AX key fact is a diagnostic on every row (here: the fixture's true), never a reason.
    assert.equal(r.row?.keyWindowIsTarget, r.attempts ? true : undefined, `${label}: ${JSON.stringify(r.row)}`);
  }
});

add('kept', 'field-click-not-replayed', 'r2 item 3: wait_for_user with field: the field focus click is posted, then arming the ready hint fails: the guard\'s sent ledger makes it noRetry; one click, never replayed; not an activation refusal', async () => {
  await world({ activateMs: QUICK_MS, baseCg: 72 });   // a window whose geometry no earlier case left unverified
  const e = await idx.waitForUserTool({ tab: 10, field: 3, reason: '登录密码' }).then(() => null, x => x);
  const clicks = log.filter(x => x === 'session click').length;
  evidence.push(`field-click-not-replayed: ${e?.code}, noRetry ${e?.noRetry}, sent ${JSON.stringify(e?.sent)}, ${clicks} click(s), ${state.activations.length} activation request(s)`);
  assert.ok(e, 'the field hand-off did not fail');
  assert.equal(e.code, 'focus_unconfirmed', e.message);
  assert.equal(clicks, 1, `the field click was replayed: ${log}`);
  assert.ok(Array.isArray(e.sent) && e.sent.includes('field_focus'), `the sent ledger lacks the field click: ${JSON.stringify(e.sent)}`);
  assert.equal(e.noRetry, true, 'a refusal after a posted field click must never be retried');
  assert.notEqual(e.inputDelivery, 'not_sent');
  assert.equal(e.message.includes(AGENT_LINE), false, 'the page field refusal is not an activation refusal');
  assert.equal(e.activationRefusal, undefined);
});

add('kept', 'no-such-tab', 'a non-focus refusal keeps its rule: no_such_tab is retried three times; its row has no focusReason and its text no focus agent line', async () => {
  await world({ activation: refused('no_such_tab'), activateMs: QUICK_MS });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`no-such-tab: ${said(r)}`);
  assert.equal(r.error?.code, 'no_such_tab', r.text);
  assert.deepEqual(r.inputs, []);
  assert.equal(r.attempts, 4, said(r));
  assert.equal('focusReason' in (r.row || {}), false, JSON.stringify(r.row));
  assert.equal(r.text.includes(AGENT_LINE), false, r.text);
});

/* ------------------------------------------------------------ run */

let passed = 0, failed = 0;
for (const kind of ['new', 'kept']) {
  console.log(kind === 'new' ? 'new fix (fails with the source change reverted)' : 'kept behaviour');
  for (const c of cases.filter(x => x.kind === kind && (!ONLY || ONLY.includes(x.name)))) {
    try { await c.fn(); passed++; console.log(`  ok    [${kind}] ${c.name}: ${c.label}`); }
    catch (e) { failed++; console.log(`FAIL  [${kind}] ${c.name}: ${c.label}\n${e.stack}`); }
  }
}
assert.ok(passed + failed > 0, `no case named ${ONLY}`);
idx.__resetPanelTaskForTests();
for (const line of evidence) console.log(`  evidence  ${line}`);
console.log(`\nfocus-refusal tests: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
