#!/usr/bin/env node
/* PERM1 (problems-20261101, contracts-batch4.md PERM1 + rulings 1-5; inv-batch4/perm-fable.md N11-N15, perm-codex.md §3):
 * what the input tools do with the activation's popup facts, and type_text's probe when the destination is uncertain.
 * Production callTool with a fake bridge (the real bridge.activateChrome turns the fake helper's reply into the result;
 * the real src/page/after.js runs in jsdom for its own facts). Nothing reaches Chrome, the input helper or the screen.
 *
 * PERM1_GROUP=new|kept runs one group; PERM1_CASE=<name>[,<name>…] runs those cases. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { JSDOM } from 'jsdom';

const GROUP = process.env.PERM1_GROUP || 'all';
const ONLY = process.env.PERM1_CASE ? process.env.PERM1_CASE.split(',') : null;
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-perm1-js-'));
// Every path the server would resolve at import time is private to this run (no real lock, tabs, agent state).
Object.assign(process.env, {
  CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'), CHROME_BRIDGE_LOCK: path.join(tmp, 'lock', 'input.lock'),
  CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'agent-window.json'), CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_AGENT_NAME: 'perm1-test',
  CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_LANG: 'zh', CHROME_BRIDGE_WARM: '0',
});
for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|KITTY_)/.test(k) || k === 'CHROME_BRIDGE_CLAUDE_FEED') delete process.env[k];
for (const k of ['MYCHROME_FOCUS_BACKEND', 'MYCHROME_FOCUS_CARBON_FLAG', 'MYCHROME_FOCUS_RERAISE', 'CHROME_BRIDGE_RETRY_MAX_MS',
  'CHROME_BRIDGE_CALL_BUDGET_MS', 'CHROME_BRIDGE_IDLE_S']) delete process.env[k];
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));
/* r2 A2: the REAL bridge.captureWindow runs (no stub); only its seams are fakes: a stand-in screencapture binary that
 * records its arguments and writes a small real PNG (so sips reads it), and the helper calls (windowstack, compose). */
function png(w, h) {
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const SHOT_DIR = path.join(tmp, 'capture'); await mkdir(SHOT_DIR);
const SHOT_PNG = path.join(SHOT_DIR, 'fixture.png'), SC_LOG = path.join(SHOT_DIR, 'screencapture.log'), FAKE_SC = path.join(SHOT_DIR, 'screencapture');
await writeFile(SHOT_PNG, png(8, 4));
const SHOT_B64 = (await readFile(SHOT_PNG)).toString('base64');
await writeFile(FAKE_SC, `#!/bin/sh\necho "$*" >> '${SC_LOG}'\nfor last; do :; done\ncp '${SHOT_PNG}' "$last"\n`);
await chmod(FAKE_SC, 0o755);
const screencaptures = async () => (await readFile(SC_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean);

const cases = [];
const add = (group, name, label, fn) => cases.push({ group, name, label, fn });
const evidence = [];

const idx = await import('../src/index.js');
const bridge = await import('../src/bridge.js');
const T = await import('../src/tabs.js');
const S = await import('../src/settings.js');
const ACTIVITY = process.env.CHROME_BRIDGE_ACTIVITY;
idx.__recordForTests(true);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BOUNDS = { left: 0, top: 0, width: 1200, height: 900 };
const VIEW = { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900 };
const SENT = ['activate_tab', 'activate_index', 'activate_main', 'activate_raise', 'activate_app']
  .map((stage, i) => ({ sequence: i + 1, stage, entered: true, delivery: 'sent', acknowledged: true }));
const SENTINEL = ['SENTINEL-TITLE', 'https://private.example/path?q=secret', 'SENTINEL-TEXT'];
let state, log;
// state.cg: a CG window number of its own for a case that leaves a geometry mark (window_changed) on its window.
const target = id => ({ tabId: id, windowId: 7, chromePid: 42, cgWindow: state.cg ?? 70, tabActive: true, minimized: false,
  bounds: { ...BOUNDS }, url: state.url, title: `t${id}` });
/** A completed activation as the PERM1 helper replies: FOCUS4's shape plus the popup facts (and planted text the bridge
 * must never copy: a title, texts and a URL). */
const completed = extra => id => ({ ok: true, inputDelivery: 'sent', stages: SENT, epoch: 1, operationId: id, ...target(10),
  windowIndex: 1, frontmost: 'Google Chrome', frontmostPid: 42, waitedMs: 0, targetOnTop: true, keyWindowIsTarget: true, axWindowMissing: false,
  frontmostChanged: false, prevFrontPutBack: false,
  geometry: { mode: 'fit-current', beforeBounds: { ...BOUNDS }, displayId: 1, branch: 'usable', changed: false, possiblyChanged: false }, ...extra });
const POPUP = {
  allowed: { popupKind: 'permission', popupAction: 'allow', popupDelivery: 'sent', popupResult: 'cleared', popupWindow: 50, popupMs: 412,
    popupTitle: SENTINEL[0], popupUrl: SENTINEL[1], texts: [SENTINEL[2]] },
  remains: { popupKind: 'permission', popupAction: 'allow', popupDelivery: 'sent', popupResult: 'remains', popupWindow: 50, targetOnTop: false,
    focusBlocker: { owner: 'Google Chrome', pid: 42, layer: 0, width: 320, height: 160 } },
  unknown: { popupKind: 'unknown', popupAction: 'none', popupDelivery: 'not_sent', popupResult: 'remains', popupWindow: 50, targetOnTop: false,
    focusBlocker: { owner: 'Google Chrome', pid: 42, layer: 0, width: 320, height: 160 } },
  jsDialog: { popupKind: 'js_dialog', popupAction: 'none', popupDelivery: 'not_sent', popupResult: 'remains', popupWindow: 50, targetOnTop: false },
};
function page(kind, vars, tab) {
  const t = target(tab == null ? 10 : Number(tab));
  state.evals.push(kind);
  if (kind === 'block') return { ok: true, blocked: null, target: t };
  if (kind === 'temporal') return { ok: true, fail: 'not_temporal', target: t };
  if (kind === 'locate') {
    if (vars.MODE === 'scroll') return { bounds: t.bounds, view: VIEW, scroller: 'document', points: [{ x: 600, y: 400 }],
      height: 800, scrollTop: 0, max: 5000, target: t };
    if (vars.MODE === 'measure') return { ok: true, scrollTop: 800, max: 5000, target: t };
    // r1 A2: "shiftAfterActivation": the page measured again after the activation reports moved window bounds.
    const bounds = state.shiftAfterActivation && state.activations > 0 ? { ...t.bounds, left: t.bounds.left + 40 } : t.bounds;
    return { bounds, view: VIEW, tag: 'button', text: 'Next', url: state.url, aim: { x: 100, y: 112 },
      rect: { x: 10, y: 100, width: 200, height: 24 }, visible: { x: 10, y: 100, width: 200, height: 24 },
      land: { x: 90, y: 106, width: 20, height: 12 }, hitOk: true, chain: [], target: t,
      ...(vars.MODE === 'field' ? { focusToken: 'field-token' } : {}) };
  }
  if (kind === 'ack') {
    const a = vars.ACK || {};
    if (a.arm) return { ok: true, armed: true, target: t };
    const met = state.clicks > 0;
    return { ok: true, armed: true, met, click: met ? 1 : 0, pointerup: met ? 1 : 0, keyup: 0, target: t };
  }
  if (kind === 'click-observation') return { ok: true, href: state.url, texts: ['Next'], dialogs: [], complete: true, busy: false,
    renderedHash: 1, scrollX: 0, scrollY: 0, targetState: null };
  if (kind === 'after') {
    const expect = vars.EXPECT;
    return { ok: true, hasFocus: true, activeEditable: true, activeIsTarget: true, bound: true, fieldSensitive: state.sensitive === true,
      bindingMatches: !!vars.BIND?.check, selectionStable: !!vars.BIND?.check, selectionAll: true, href: state.url, focusMoved: false,
      changed: state.value !== '', fieldHasText: expect != null && state.value === expect, confirmedChars: expect != null ? [...expect].length : 0, target: t };
  }
  if (kind === 'select') {
    if (vars.MODE === 'check') return { ok: true, selected: state.typed.length > 0, target: t };
    return { ok: true, index: 2, current: 1, focused: true, hasFocus: true, typeahead: 'b', text: 'B', target: t };
  }
  throw new Error(`unexpected page script ${kind}`);
}
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in perm1 test`); }]));
  return Object.assign(fake, {
    pageDialog: async () => { state.dialogReads++; return state.dialog ?? { ok: true, open: false }; },
    ensureScreenAwake: async () => ({ locked: false, displays: 1, woke: false }),
    axInput: async () => ({ ok: true, frontmost: true, windowMatches: true, nodeFound: true, hitWindow: state.cg ?? 70, focusedWindow: state.cg ?? 70, documentToken: 'doc1',
      focusedDocumentToken: 'doc1', menuOpen: false, menuState: 'closed', nativeMenuOpen: false, nativePopup: false, blocker: null }),
    axMenuState: async () => ({ ok: true, known: true, menuOpen: false }),
    pageScript: async (kind, vars = {}) => kind === 'native-select' ? bridge.pageScript(kind, vars) : `fakePage(${JSON.stringify(kind)}, ${JSON.stringify(vars)})`,
    evalInPage: async (src, tab) => {
      const w = state.dom;
      w.fakePage = (k, v) => JSON.stringify(page(k, v, tab));
      if (src.includes('function popupSelect(')) state.evals.push('native-select');
      const out = JSON.parse(w.eval(src));
      return out && typeof out === 'object' && !out.target ? { ...out, target: target(tab == null ? 10 : Number(tab)) } : out;
    },
    pageContentRect: async () => ({ ok: false }),
    chromeInfo: async tab => target(tab == null ? 10 : Number(tab)),
    listTabs: async () => ({ ok: true, frontmost: 'Google Chrome', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
      tabs: [{ id: 10, url: state.url, title: 't10', active: true }] }] }),
    openInputSession: async () => {
      let held = false;
      return {
        request: async req => {
          log.push(req.op);
          if (req.op === 'hold') { held = true; return { ok: true, epoch: 1, pointer: { x: 10, y: 20 }, heldAt: Date.now() }; }
          if (req.op === 'recordNativeScene') return { ok: true, epoch: 1, restoreToken: 'r'.repeat(64) };
          if (req.op === 'nativeChrome' && req.intent?.kind === 'activate') { state.activations++; state.evalsAtActivation = state.evals.length; return state.activation(req.operationId); }
          if (req.op === 'veil') return { ok: true, held, takeover: { active: held } };
          if (req.op === 'click') { state.clicks++; return { ok: true, epoch: 1, landed: { x: 100, y: 112 }, timing: {}, inputDelivery: 'sent' }; }
          if (req.op === 'key') { state.keys.push(req.name); return { ok: true, epoch: 1, postedInput: 1 }; }
          if (req.op === 'type' || req.op === 'paste') {
            state.typed.push(`${req.op}:${req.text}`);
            if (!(state.dropFirst && state.typed.length === 1)) state.value += req.text;   // dropFirst: the first op lands elsewhere
            return { ok: true, epoch: 1, typed: [...req.text].length, postedInput: req.text.length };
          }
          if (req.op === 'wheel') return { ok: true, epoch: 1, sent: req.notches, postedInput: req.notches };
          if (req.op === 'move') return { ok: true, epoch: 1, landed: req.to, points: 5, skippedMove: false };
          if (req.op === 'routed') return { ok: true, allToChrome: true, ms: 1 };
          if (req.op === 'restoreClipboard') return { ok: true, restored: true };
          // r1 A3: "loseHoldAfterActivation": the helper's status says the takeover is no longer active.
          const active = held && !(state.loseHoldAfterActivation && state.activations > 0);
          return { ok: true, epoch: 1, operationId: req.operationId, stages: [], inputDelivery: req.op === 'nativeChrome' ? 'sent' : undefined,
            inputMonitor: true, takeover: { active }, ...(req.op === 'warp' ? { verified: true, warped: req.to } : {}) };
        },
        close: async () => { held = false; return { ok: true, takeover: { active: false, swallowedKeys: 0, swallowedPointer: 0 } }; },
      };
    },
    snapshotScene: async () => ({ appPid: 99, chromeWindow: 7, chromeTab: 10 }),
    restoreScene: async (_scene, options) => { await options.native({ kind: 'restoreScene' }, { policy: 'restore' }); return { ok: true, appFrontmost: true }; },
    activateChrome: bridge.activateChrome,   // production: the helper's reply becomes the result (and the popup facts) here
    selectTab: async (id, o) => { await o.native({ kind: 'selectTab', tabId: id, windowId: o.windowId }); return { ok: true, ...target(id), changed: false }; },
    openNavigationObserver: async () => ({ startedAt: Date.now(), untouched: async () => true, close: async () => {} }),
    ocrImage: async () => { state.ocr++; throw new Error('OCR reached in perm1 test'); },
    // PERM1 ruling 3: the private look at the popup window; windowstack is the ownership check before and after.
    captureWindow: async (w, o) => {
      state.captures.push({ cgWindow: w.cgWindow, maxPx: o?.maxPx, single: o?.single === true });
      // The production capture with the caller's own options; only the binary and the helper calls are seams.
      const shot = await bridge.captureWindow(w, { ...o, screencapture: FAKE_SC, screenCheck: null, cg: async args => {
        if (args[0] === 'windowstack') return { ok: true, id: Number(args[1]), pid: 42, layer: 0, alpha: 1, onScreen: true,
          bounds: { x: 300, y: 80, w: 320, h: 160 }, above: state.menuAbove ? [state.menuAbove] : [] };
        if (args[0] === 'compose') { state.composed++; await copyFile(SHOT_PNG, args[args.indexOf('--out') + 1]); return { ok: true }; }
        throw new Error(`capture helper call ${args[0]} in perm1 test`);
      } });
      const dispose = shot.dispose;
      return { ...shot, dispose: async () => { state.disposed++; await dispose(); } };
    },
    cgevent: async args => {
      if (args[0] === 'displays') return { displays: [] };
      if (args[0] === 'mousepos') return { x: 10, y: 20 };
      if (args[0] === 'windowsat') return { windows: [{ id: state.cg ?? 70, pid: 42, owner: 'Google Chrome', layer: 0, bounds: { x: 0, y: 0, w: 1200, h: 900 } }] };
      if (args[0] === 'idle') return { ok: true, idle: 100, keyIdle: 100, held: [], clickIdle: 100 };
      if (args[0] === 'windowstack') {
        state.stacks++;
        const owner = state.stacks > 1 && state.ownerChanges ? 77 : 42;
        return { ok: true, id: Number(args[1]), pid: owner, layer: 0, onScreen: true, bounds: { x: 300, y: 80, w: 320, h: 160 }, above: [] };
      }
      throw new Error(`B.cgevent ${args[0]} reached in perm1 test`);
    },
  });
}
let world = 0;
async function setup(o = {}) {
  for (const t = Date.now(); idx.__taskHoldForTests() && Date.now() - t < 3000;) await sleep(20);
  idx.__resetPanelTaskForTests(); idx.__resetLedgerForTests(); idx.__resetNativeTargetsForTests(); idx.__resetShotsForTests(); idx.__resetTypedForTests?.();
  idx.__setTakeoverForTests(o.takeover !== false);   // r1 A3: takeover:false = monitored mode (CHROME_BRIDGE_TAKEOVER=0)
  S.writeSettings({ inputMode: 'auto', inputSpeed: 3 });
  state = { url: `https://shop.test/form-${++world}`, activation: completed(), activations: 0, clicks: 0, typed: [], keys: [], value: '',
    evals: [], evalsAtActivation: 0, captures: [], disposed: 0, stacks: 0, ocr: 0, dialogReads: 0, composed: 0, ...o };
  await rm(SC_LOG, { force: true });
  const w = new JSDOM('<button id="b">Next</button><input id="f">', { url: 'https://shop.test/page', runScripts: 'outside-only' }).window;
  w.__chromeBridge = { markers: [null, w.document.getElementById('b'), w.document.getElementById('f')], url: w.location.href };
  w.document.getElementById('f').focus();
  w.document.elementFromPoint = () => w.document.getElementById('b');
  state.dom = w;
  log = [];
  idx.__setBridgeForTests(fakeBridge());
  await T.registerTab(10, state.url, { windowId: 7, agentName: 'perm1-test' });
  await rm(ACTIVITY, { force: true });
}
const INPUT = new Set(['click', 'key', 'type', 'paste', 'wheel', 'move']);
async function run(name, args) {
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  const rows = (await readFile(ACTIVITY, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), images: r.content.filter(c => c.type === 'image'),
    isError: !!r.isError, error: r.structuredContent?.error || null, raw: r,
    row: rows.at(-1) ?? null, inputs: log.filter(op => INPUT.has(op)), activations: state.activations };
}
const brief = r => `${r.isError ? `refused ${r.error?.code}` : 'done'}; ${r.activations} activation(s); input ${r.inputs.join(',') || 'none'}; ops ${state.typed.join(' ') || '-'}`;
const keyOps = () => log.filter(op => ['key', 'type', 'paste'].includes(op));
const TYPE = { tab: 10, marker: 2, text: 'hello', input_mode: 'keys' };

/* ------------------------------------------------------------------ the popup facts: receipt, row, separate deliveries */

add('new', 'js-allow-receipt-row', 'N11 + ruling 1: a prompt answered "allow" on the way: the click lands; the receipt says the prompt\'s own button was pressed (not page input); the row carries the four finite words; planted title/text/URL appear nowhere', async () => {
  await setup({ activation: completed(POPUP.allowed) });
  const r = await run('click', { tab: 10, marker: 1 });
  evidence.push(`js-allow-receipt-row: ${brief(r)}; row ${JSON.stringify({ k: r.row?.popupKind, a: r.row?.popupAction, d: r.row?.popupDelivery, x: r.row?.popupResult })}`);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.inputs.filter(x => x !== 'move'), ['click']);
  assert.match(r.text, /Chrome 弹出了网站权限询问：已按用户的默认设置在询问里选了「允许」（按的是询问自己的按钮，不是网页里的点击或按键）/);
  assert.deepEqual([r.row?.popupKind, r.row?.popupAction, r.row?.popupDelivery, r.row?.popupResult], ['permission', 'allow', 'sent', 'cleared']);
  const all = JSON.stringify(r.raw) + JSON.stringify(r.row);
  for (const s of SENTINEL) assert.equal(all.includes(s), false, `${s} leaked`);
  assert.equal('popupWindow' in r.row, false); assert.equal('popupMs' in r.row, false);
});
add('new', 'js-facts-finite', 'N11: valid finite popup words and a bounded probe count reach the row and the receipt through production output (positive control); words outside the finite sets (a planted URL as popupKind, a title as popupResult) add nothing to the row, the receipt or the call', async () => {
  // Positive control (Codex QA round 3): the supported words survive bridge.focusFacts → the call → settings.activityRecord.
  await setup({ activation: completed({ popupKind: 'permission', popupAction: 'allow', popupDelivery: 'sent', popupResult: 'cleared', popupWindow: 50 }) });
  const ok = await run('click', { tab: 10, marker: 1 });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual([ok.row?.popupKind, ok.row?.popupAction, ok.row?.popupDelivery, ok.row?.popupResult], ['permission', 'allow', 'sent', 'cleared'],
    `valid popup words did not reach the row: ${JSON.stringify(ok.row)}`);
  assert.match(ok.text, /选了「允许」/, 'the receipt names the answered prompt');
  await setup({ activation: completed({ keyWindowIsTarget: false }) });
  const typed = await run('type_text', TYPE);
  assert.equal(typed.isError, false, typed.text);
  assert.equal(typed.row?.probeChars, 2, `the bounded probe count did not reach the row: ${JSON.stringify(typed.row)}`);
  assert.equal(typed.row?.probeResult, 'landed'); assert.equal(typed.row?.destinationEvidence, 'probe');
  for (const [k, v] of [['popupKind', 'translate'], ['popupAction', 'observe'], ['popupDelivery', 'unknown'], ['popupResult', 'changed'], ['probeChars', 0], ['probeChars', 2]]) {
    assert.equal(S.activityRecord({ tool: 'type_text', ok: true, [k]: v })[k], v, `${k}=${v} dropped by the row filter`);
  }
  evidence.push(`js-facts-finite (positive): row ${JSON.stringify({ k: ok.row?.popupKind, a: ok.row?.popupAction, d: ok.row?.popupDelivery, x: ok.row?.popupResult, probeChars: typed.row?.probeChars })}`);
  // Words outside the finite sets.
  await setup({ activation: completed({ popupKind: SENTINEL[1], popupAction: 'allow', popupDelivery: 'sent', popupResult: SENTINEL[0] }) });
  const r = await run('click', { tab: 10, marker: 1 });
  evidence.push(`js-facts-finite: ${brief(r)}; row popup keys ${Object.keys(r.row ?? {}).filter(k => k.startsWith('popup')).join(',') || 'none'}`);
  assert.equal(r.isError, false, r.text);
  const all = JSON.stringify(r.raw) + JSON.stringify(r.row);
  for (const s of SENTINEL) assert.equal(all.includes(s), false, `${s} leaked`);
  assert.equal(r.row?.popupKind, undefined); assert.equal(r.row?.popupResult, undefined);
  for (const bad of ['Allow', 'https://x.example', 1, null]) assert.equal('popupKind' in S.activityRecord({ tool: 'click', ok: true, popupKind: bad }), false);
  for (const bad of [3, -1, 1.5, '2']) assert.equal('probeChars' in S.activityRecord({ tool: 'type_text', ok: true, probeChars: bad }), false);
});
add('new', 'js-remains-keys', 'ruling 1: Allow was sent but a Chrome popup still covers the target: type_text, press_key and select_option send zero keys (chrome_popup_remains); the receipt says the Allow WAS executed and the requested input was not; row: popupDelivery sent, inputDelivery not_sent', async () => {
  for (const [name, args] of [['type_text', TYPE], ['press_key', { tab: 10, key: 'enter' }], ['select_option', { tab: 10, marker: 1, option: 'B' }]]) {
    await setup({ activation: completed(POPUP.remains) });
    const r = await run(name, args);
    evidence.push(`js-remains-keys ${name}: ${brief(r)}; row popupDelivery=${r.row?.popupDelivery} inputDelivery=${r.row?.inputDelivery}; image ${r.images.length}`);
    assert.equal(r.error?.code, 'chrome_popup_remains', `${name}: ${r.text}`);
    assert.deepEqual(keyOps(), [], `${name}: keys sent`);
    assert.match(r.text, /已在 Chrome 的网站权限询问里选了「允许」（这一步已执行/, name);
    assert.match(r.text, /没有发送按键/, name);
    assert.doesNotMatch(r.text, /什么也没(做|发)|没有发送任何/, name);
    assert.equal(r.row?.popupDelivery, 'sent', name); assert.equal(r.row?.inputDelivery, 'not_sent', name);
    assert.equal(r.activations, 1, `${name}: not retried`);
  }
});
add('new', 'js-unknown-keys-image', 'ruling 3: an unknown Chrome popup above the target: a key tool sends zero keys (chrome_popup_unknown) and returns a private look at that popup window only (ownership checked before and after, disposed, no OCR); a click goes on (its landing point decides)', async () => {
  await setup({ activation: completed(POPUP.unknown) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`js-unknown-keys-image press_key: ${brief(r)}; images ${r.images.length}; captures ${JSON.stringify(state.captures)}; windowstack reads ${state.stacks}; disposed ${state.disposed}; ocr ${state.ocr}`);
  assert.equal(r.error?.code, 'chrome_popup_unknown', r.text);
  assert.deepEqual(keyOps(), []);
  assert.equal(r.images.length, 1); assert.equal(r.images[0].data, SHOT_B64);
  assert.deepEqual(state.captures, [{ cgWindow: 50, maxPx: 800, single: true }], 'the popup window itself, never the target window');
  assert.equal(state.stacks, 2, 'ownership read before and after the capture'); assert.equal(state.disposed, 1); assert.equal(state.ocr, 0);
  assert.equal(r.row?.destinationEvidence, 'image'); assert.match(r.text, /不要用 Esc 或回车去关它/);
  await setup({ activation: completed(POPUP.unknown) });
  const c = await run('click', { tab: 10, marker: 1 });
  evidence.push(`js-unknown-keys-image click: ${brief(c)}; images ${c.images.length}`);
  assert.equal(c.isError, false, c.text); assert.deepEqual(c.inputs.filter(x => x !== 'move'), ['click']); assert.equal(c.images.length, 0);
});
add('new', 'js-image-ownership', 'ruling 3: the popup window changes owner during the capture: no image is returned, the temporary capture is still disposed', async () => {
  await setup({ activation: completed(POPUP.unknown), ownerChanges: true });
  const r = await run('type_text', TYPE);
  evidence.push(`js-image-ownership: ${brief(r)}; images ${r.images.length}; disposed ${state.disposed}`);
  assert.equal(r.error?.code, 'chrome_popup_unknown', r.text);
  assert.equal(r.images.length, 0); assert.equal(state.disposed, 1); assert.deepEqual(keyOps(), []);
  assert.notEqual(r.row?.destinationEvidence, 'image');
});
add('new', 'js-dialog-all-tools', 'a JS dialog (or "Leave site?") above the target: every input tool refuses page_dialog before any page read after the activation and sends nothing (D\'s domain)', async () => {
  for (const [name, args] of [['click', { tab: 10, marker: 1 }], ['type_text', TYPE], ['press_key', { tab: 10, key: 'enter' }], ['hover', { tab: 10, marker: 1 }],
    ['scroll', { tab: 10, direction: 'down' }]]) {
    await setup({ activation: completed(POPUP.jsDialog) });
    const r = await run(name, args);
    const after = state.evals.slice(state.evalsAtActivation);
    evidence.push(`js-dialog-all-tools ${name}: ${brief(r)}; page reads after the activation ${after.length}`);
    assert.equal(r.error?.code, 'page_dialog', `${name}: ${r.text}`);
    assert.deepEqual(r.inputs.filter(x => x !== 'move' || name !== 'hover'), [], `${name}: ${r.inputs}`);
    assert.deepEqual(after, [], `${name}: a page read behind a possible JS dialog`);
  }
});
add('new', 'js-deferred-preflight', 'ruling 2 (the deferred preflight): after a popup was answered inside the hold, the click measures its target again under the hold instead of reusing the preflight\'s location', async () => {
  await setup({ activation: completed(POPUP.allowed) });
  const r = await run('click', { tab: 10, marker: 1 });
  const located = state.evals.slice(state.evalsAtActivation).filter(k => k === 'locate').length;
  await setup();
  const plain = await run('click', { tab: 10, marker: 1 });
  const plainLocated = state.evals.slice(state.evalsAtActivation).filter(k => k === 'locate').length;
  evidence.push(`js-deferred-preflight: locate reads after the activation: popup answered ${located}, no popup ${plainLocated}`);
  assert.equal(r.isError, false, r.text); assert.equal(plain.isError, false, plain.text);
  assert.ok(located >= 1, 'the preflight location was reused after the popup was answered');
  assert.equal(plainLocated, 0, 'kept: without a popup the fresh preflight location is used');
});

add('new', 'js-capture-single-window', 'r2 A2: the private look runs the real captureWindow in single-window mode: an unrelated same-pid Chrome menu overlapping the popup (another window\'s, with its own text) is never captured or composed; only the popup\'s own window is taken', async () => {
  const menu = { id: 66, pid: 42, layer: 101, alpha: 1, bounds: { x: 320, y: 120, w: 200, h: 180 } };
  await setup({ activation: completed(POPUP.unknown), menuAbove: menu });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  const calls = await screencaptures();
  evidence.push(`js-capture-single-window: ${brief(r)}; screencapture calls ${JSON.stringify(calls.map(c => c.split(' ').slice(0, -1).join(' ')))}; compose ${state.composed}; images ${r.images.length}; disposed ${state.disposed}`);
  assert.equal(r.error?.code, 'chrome_popup_unknown', r.text);
  assert.equal(calls.length, 1, `exactly one window captured: ${calls}`);
  assert.match(calls[0], /-l 50 /); assert.equal(calls.some(c => / -l 66 /.test(` ${c} `)), false, 'the overlapping menu window was captured');
  assert.equal(state.composed, 0, 'another window was composed into the picture');
  assert.equal(r.images.length, 1); assert.equal(r.images[0].data, SHOT_B64); assert.equal(state.disposed, 1);
});

/* ------------------------------------------------------------------ type_text's probe (ruling 4) */

const UNCERTAIN = { activation: completed({ keyWindowIsTarget: false }) };
add('new', 'js-probe-landed', 'N12: the destination is uncertain (AX key window not the target): the first op carries 2 characters and no newline, it is read back, then the rest follows; row probe landed/2, destinationEvidence probe', async () => {
  await setup(UNCERTAIN);
  const r = await run('type_text', TYPE);
  evidence.push(`js-probe-landed: ${brief(r)}; row probe ${r.row?.probeResult}/${r.row?.probeChars} evidence ${r.row?.destinationEvidence}`);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(state.typed, ['type:he', 'type:llo']);
  assert.equal(state.value, 'hello');
  assert.deepEqual([r.row?.probeResult, r.row?.probeChars, r.row?.destinationEvidence], ['landed', 2, 'probe']);
  assert.match(r.text, /先单独输入了前 2 个字符/);
});
add('new', 'js-probe-not-landed', 'N12: the probe does not land in the bound field: zero further ops, no Backspace or any cleanup key, input_unconfirmed with the partial wording, delivery sent, not retried', async () => {
  await setup({ ...UNCERTAIN, dropFirst: true });
  const r = await run('type_text', TYPE);
  evidence.push(`js-probe-not-landed: ${brief(r)}; keys ${state.keys.join(',') || 'none'}; row probe ${r.row?.probeResult} delivery ${r.row?.inputDelivery}`);
  assert.equal(r.error?.code, 'input_unconfirmed', r.text);
  assert.deepEqual(state.typed, ['type:he'], 'exactly the probe');
  assert.deepEqual(state.keys, [], 'a cleanup key was sent');
  assert.match(r.text, /没有按删除键或别的键去清理/); assert.match(r.text, /这次已经发出了部分输入/);
  assert.equal(r.row?.inputDelivery, 'sent'); assert.equal(r.row?.probeResult, 'not_landed'); assert.equal(r.activations, 1);
});
add('new', 'js-probe-sensitive', 'N13: a password / one-time-code / payment / private field with an uncertain destination: destination_uncertain, zero keys (not even the probe)', async () => {
  await setup({ ...UNCERTAIN, sensitive: true });
  const r = await run('type_text', TYPE);
  evidence.push(`js-probe-sensitive: ${brief(r)}; row probe ${r.row?.probeResult}`);
  assert.equal(r.error?.code, 'destination_uncertain', r.text);
  assert.deepEqual(keyOps(), []); assert.equal(r.row?.probeResult, 'prohibited'); assert.match(r.text, /wait_for_user/);
});
add('new', 'js-probe-newline', 'N14: text starting with a newline (or a tab) and an uncertain destination: destination_uncertain, zero keys', async () => {
  for (const text of ['\nhello', '\thello']) {
    await setup(UNCERTAIN);
    const r = await run('type_text', { ...TYPE, text });
    evidence.push(`js-probe-newline ${JSON.stringify(text)}: ${brief(r)}`);
    assert.equal(r.error?.code, 'destination_uncertain', r.text); assert.deepEqual(keyOps(), []);
  }
});
add('new', 'js-probe-triggers', 'the probe also runs after a Chrome prompt was answered in this activation and when the AX window list missed the target (popup / axWindowMissing triggers)', async () => {
  for (const [label, extra] of [['prompt answered', POPUP.allowed], ['AX window missing', { axWindowMissing: true }]]) {
    await setup({ activation: completed(extra) });
    const r = await run('type_text', TYPE);
    evidence.push(`js-probe-triggers (${label}): ${brief(r)}`);
    assert.equal(r.isError, false, `${label}: ${r.text}`); assert.deepEqual(state.typed, ['type:he', 'type:llo'], label);
  }
});
add('kept', 'js-probe-not-uncertain', 'N15: a certain destination: the op sequence is FOCUS4\'s (one chunk), probe not used', async () => {
  await setup();
  const r = await run('type_text', TYPE);
  evidence.push(`js-probe-not-uncertain: ${brief(r)}; row probe ${r.row?.probeResult}`);
  assert.equal(r.isError, false, r.text); assert.deepEqual(state.typed, ['type:hello']);
  assert.equal(r.row?.probeResult, 'not_used'); assert.equal(r.row?.destinationEvidence, 'ordinary');
});
add('kept', 'js-probe-paste', 'paste mode: an ASCII start is probed with keys (never a paste), then the rest is pasted; a non-ASCII start cannot be typed as keys: no probe (unavailable), FOCUS4\'s checks decide alone', async () => {
  await setup(UNCERTAIN);
  const a = await run('type_text', { ...TYPE, input_mode: 'paste' });
  const ascii = [...state.typed];
  await setup(UNCERTAIN);
  const z = await run('type_text', { ...TYPE, text: '你好世界', input_mode: 'paste' });
  evidence.push(`js-probe-paste: ascii ${ascii.join(' ')}; non-ascii ${state.typed.join(' ')} (row probe ${z.row?.probeResult})`);
  assert.equal(a.isError, false, a.text); assert.deepEqual(ascii, ['type:he', 'paste:llo']);
  assert.equal(z.isError, false, z.text); assert.deepEqual(state.typed, ['paste:你好世界']); assert.equal(z.row?.probeResult, 'unavailable');
});

/* ------------------------------------------------------------------ r1 (Codex QA A1-A4) */

add('new', 'js-allow-then-window-changed', 'r1 A2: Allow was sent and cleared, then the target\'s window bounds change before the requested input (window_changed, normally retried): exactly one attempt; the requested input is recorded not sent, the Allow as sent', async () => {
  await setup({ activation: completed(POPUP.allowed), shiftAfterActivation: true, cg: 71 });
  const r = await run('click', { tab: 10, marker: 1 });
  evidence.push(`js-allow-then-window-changed: ${brief(r)}; row popupDelivery=${r.row?.popupDelivery} inputDelivery=${r.row?.inputDelivery}`);
  assert.equal(r.error?.code, 'window_changed', r.text);
  assert.equal(r.activations, 1, 'a whole-call retry after a sent popup action');
  assert.deepEqual(r.inputs.filter(x => x !== 'move'), []);
  assert.equal(r.row?.popupDelivery, 'sent'); assert.equal(r.row?.inputDelivery, 'not_sent');
  assert.match(r.text, /注意：这次调用已在 Chrome 的网站权限询问里选了「允许」（这一步已执行/);
});
add('new', 'js-unattached-no-image', 'r1 A1: an unknown Chrome window above the target without attachment evidence (no window number in the facts): the key tool refuses with finite facts only, zero captures, no image, destinationEvidence unknown', async () => {
  const { popupWindow, ...unattached } = POPUP.unknown;
  await setup({ activation: completed(unattached) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`js-unattached-no-image: ${brief(r)}; captures ${state.captures.length}; windowstack ${state.stacks}; images ${r.images.length}`);
  assert.equal(r.error?.code, 'chrome_popup_unknown', r.text);
  assert.equal(state.captures.length, 0); assert.equal(state.stacks, 0); assert.equal(r.images.length, 0);
  assert.equal(r.row?.destinationEvidence, 'unknown'); assert.match(r.text, /不附截图/); assert.deepEqual(keyOps(), []);
});
const EARLY = (o = {}) => ({ ok: true, known: true, open: true, surface: 'browser', attached: false, title: SENTINEL[0], texts: [SENTINEL[2], SENTINEL[1]],
  buttons: ['Save', 'Never'], hasField: false, complete: true, origin: null, originEvidence: 'unverified',
  identity: { version: 1, chromePid: 42, tabId: 10, windowId: 7, cgWindow: 70, dialogCgWindow: 55, token: 't'.repeat(64) }, ...o });
add('new', 'js-early-browser-surface', 'r1 A4: an unclassified Chrome surface already open at entry: every input tool refuses chrome_popup_unknown before any page read or activation; its title, text and buttons appear nowhere; finite facts on the row; no image without attachment', async () => {
  for (const [name, args] of [['click', { tab: 10, marker: 1 }], ['type_text', TYPE], ['press_key', { tab: 10, key: 'enter' }]]) {
    await setup({ dialog: EARLY() });
    const r = await run(name, args);
    evidence.push(`js-early-browser-surface ${name}: ${brief(r)}; page reads ${state.evals.length}; images ${r.images.length}; row ${r.row?.popupKind}`);
    assert.equal(r.error?.code, 'chrome_popup_unknown', `${name}: ${r.text}`);
    assert.equal(r.activations, 0, name); assert.deepEqual(state.evals, [], `${name}: a page read behind the surface`);
    assert.equal(r.images.length, 0, name); assert.equal(state.captures.length, 0, name);
    const all = JSON.stringify(r.raw) + JSON.stringify(r.row);
    for (const x of [...SENTINEL, 'Save', 'Never']) assert.equal(all.includes(x), false, `${name}: ${x} leaked`);
    assert.equal(r.row?.popupKind, 'unknown', name); assert.equal(r.row?.destinationEvidence, 'unknown', name);
  }
});
add('new', 'js-early-attached-image', 'r1 A4 + A1: an early surface whose AXParent names the bound parent of the tab this call names: the private look at that surface (its own CG window), ownership checked, disposed; another tab\'s surface: no image', async () => {
  await setup({ dialog: EARLY({ attached: true }) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  const mine = { images: r.images.length, captures: [...state.captures], disposed: state.disposed };
  await setup({ dialog: EARLY({ attached: true, identity: { ...EARLY().identity, tabId: 11 } }) });
  const other = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`js-early-attached-image: own ${JSON.stringify(mine)}; another tab's: images ${other.images.length}, captures ${state.captures.length}`);
  assert.equal(r.error?.code, 'chrome_popup_unknown'); assert.equal(mine.images, 1); assert.deepEqual(mine.captures, [{ cgWindow: 55, maxPx: 800, single: true }]); assert.equal(mine.disposed, 1);
  assert.equal(other.error?.code, 'chrome_popup_unknown'); assert.equal(other.images.length, 0); assert.equal(state.captures.length, 0);
});
add('kept', 'js-early-js-dialog', 'r1 A4 kept: a positively identified page dialog (surface js_dialog) at entry keeps D\'s refusal (page_dialog, its owner wording) with zero page reads and zero input', async () => {
  await setup({ dialog: EARLY({ surface: 'js_dialog', title: 'Leave site?', texts: ['Changes you made may not be saved.'], buttons: ['Leave', 'Cancel'] }) });
  const r = await run('click', { tab: 10, marker: 1 });
  evidence.push(`js-early-js-dialog: ${brief(r)}; page reads ${state.evals.length}`);
  assert.equal(r.error?.code, 'page_dialog', r.text); assert.equal(r.activations, 0); assert.deepEqual(state.evals, []);
});
add('new', 'js-probe-monitored', 'r1 A3: monitored mode (no takeover, no physical hold) with an uncertain destination: no probe (observe only: probeResult no_hold); the text goes as FOCUS4 sends it', async () => {
  await setup({ ...UNCERTAIN, takeover: false });
  const r = await run('type_text', TYPE);
  evidence.push(`js-probe-monitored: ${brief(r)}; row probe ${r.row?.probeResult}`);
  assert.equal(r.isError, false, r.text); assert.deepEqual(state.typed, ['type:hello']); assert.equal(r.row?.probeResult, 'no_hold');
});
add('new', 'js-observe-no-hold', 'r1 A3: the helper observed a prompt without a hold (popupAction observe): key tools send zero keys and say it was not pressed because there was no takeover', async () => {
  await setup({ activation: completed({ ...POPUP.remains, popupAction: 'observe', popupDelivery: 'not_sent' }) });
  const r = await run('type_text', TYPE);
  evidence.push(`js-observe-no-hold: ${brief(r)}; row popupAction=${r.row?.popupAction}`);
  assert.equal(r.error?.code, 'chrome_popup_remains', r.text); assert.deepEqual(keyOps(), []);
  assert.match(r.text, /没有接管键鼠（监视模式或接管已结束），所以没有按它/); assert.equal(r.row?.popupAction, 'observe');
});
add('kept', 'js-probe-lost-hold', 'r1 A3 kept: the takeover is lost after the activation (status inactive): zero probe characters, zero keys; the call stops', async () => {
  await setup({ ...UNCERTAIN, loseHoldAfterActivation: true });
  const r = await run('type_text', TYPE);
  evidence.push(`js-probe-lost-hold: ${brief(r)}; keys ${keyOps().join(',') || 'none'}`);
  assert.equal(r.isError, true, r.text); assert.deepEqual(keyOps(), []); assert.deepEqual(state.typed, []);
});

/* ------------------------------------------------------------------ the real after.js: its sensitivity fact */

add('new', 'dom-field-sensitive', 'after.js (production): fieldSensitive from attributes only: password, autocomplete one-time-code / current-password / cc-number, an otp name, a cvc name, a field handed to the user (isPrivate) → true; a plain text or search field → false', async () => {
  const rows = [
    ['<input id="t" type="password">', true], ['<input id="t" autocomplete="one-time-code">', true], ['<input id="t" autocomplete="current-password">', true],
    ['<input id="t" autocomplete="cc-number">', true], ['<input id="t" name="otp">', true], ['<input id="t" name="card_cvc">', true],
['<input id="t" name="private-field">', 'private'],
    ['<input id="t" name="q" type="search">', false], ['<textarea id="t" aria-label="Message"></textarea>', false], ['<input id="t" name="pinyin">', false],
  ];
  const got = [];
  for (const [html, want] of rows) {
    const w = new JSDOM(`<form>${html}</form>`, { url: 'https://shop.test/p', runScripts: 'outside-only' }).window;
    const el = w.document.getElementById('t');
    if (want === 'private') w.__chromeBridgePrivate = { set: new Set([el]), forms: new Set(), like: [] };
    el.focus();
    const out = JSON.parse(w.eval(await bridge.pageScript('after', { MARKER: null, EXPECT: null, BIND: { set: 'tok', strict: true } })));
    got.push(`${html} → ${out.fieldSensitive}`);
    assert.equal(out.fieldSensitive, want === 'private' ? true : want, html);
    assert.equal(typeof out.fieldSensitive, 'boolean');
    assert.equal(JSON.stringify(out).includes('hunter2'), false);
  }
  evidence.push(`dom-field-sensitive: ${got.length} fields classified`);
});

/* ======================================================================== run */

let passed = 0, failed = 0;
for (const group of ['new', 'kept']) {
  if (GROUP !== 'all' && GROUP !== group) continue;
  console.log(group === 'new' ? 'new fix (RED under its targeted mutation)' : 'kept behaviour');
  for (const c of cases.filter(x => x.group === group && (!ONLY || ONLY.includes(x.name)))) {
    try { await c.fn(); passed++; console.log(`  ok    [${group}] ${c.name}: ${c.label}`); }
    catch (e) { failed++; console.log(`FAIL  [${group}] ${c.name}: ${c.label}\n${e.stack}`); }
  }
}
idx.__resetPanelTaskForTests();
for (const line of evidence) console.log(`  evidence  ${line}`);
console.log(`\nperm-probe tests: ${passed} passed, ${failed} failed. Artifacts: ${tmp}`);
process.exit(failed ? 1 : 0);
