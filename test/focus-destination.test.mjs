#!/usr/bin/env node
/* FOCUS4 (problems-20261101, contracts-batch4.md; Codex r2 §1 gate table, coordinator rulings 2-3): under the input
 * lock, after MyChrome's own activation, only the destination decides. The AX key window, the AX window list and the
 * settle/CG-order verdicts are diagnostics (keyWindowIsTarget, axWindowMissing on the receipt and row).
 *
 * Sections (FOCUS4_GROUP=new|kept runs one group; FOCUS4_CASE=<name>[,<name>…] runs those cases):
 *   native     the production Owner.run -> execute -> settle path, compiled as window-visibility-native.test.mjs compiles
 *              it (exact source blocks, inert AX/CG/front-app model, the real Session click guards). No OS effect.
 *   chromectl  nativeInputProbe's destination decision (nativeWindowMatches), its exact source compiled with a driver.
 *   js         the production callTool with a fake bridge; the real bridge.activateChrome turns the fake helper's reply
 *              into the result, and the real src/page/native-select.js runs in a jsdom page whose keyboard focus the
 *              cases change before and between events (r1 A4). Nothing reaches Chrome or the input helper.
 *   dom        native-select.js's own control classification and focus fact, executed in jsdom pages.
 * New fix (each RED under its targeted mutation in runs/FOCUS4/rerun.sh): AX-empty activation proceeds; AX key false or
 * missing proceeds (native, JS); the G-h point decision without AXFocusedWindow; another Chrome window ahead in CG order
 * but not at the landing point stays eligible (native, JS); press_key with page focus false sends zero keys; focus lost
 * after the first repetition withholds the next key; the row and receipt carry the AX facts.
 * Kept: wrong point/window, wrong recipient app at event time, another app in front refused once for a click or a key,
 * the menu exemption still bound to the focused window, missing control evidence never matches. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROUP = process.env.FOCUS4_GROUP || 'all';
const ONLY = process.env.FOCUS4_CASE ? process.env.FOCUS4_CASE.split(',') : null;
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-focus4-'));
Object.assign(process.env, {
  CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'), CHROME_BRIDGE_LOCK: path.join(tmp, 'lock', 'input.lock'),
  CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'agent-window.json'), CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_AGENT_NAME: 'focus4-test',
  CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_LANG: 'zh', CHROME_BRIDGE_WARM: '0',
});
for (const k of ['MYCHROME_FOCUS_BACKEND', 'MYCHROME_FOCUS_CARBON_FLAG', 'MYCHROME_FOCUS_RERAISE', 'CHROME_BRIDGE_RETRY_MAX_MS',
  'CHROME_BRIDGE_CALL_BUDGET_MS', 'CHROME_BRIDGE_IDLE_S']) delete process.env[k];
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const cases = [];
const add = (group, name, label, fn) => cases.push({ group, name, label, fn });
const evidence = [];

/* ======================================================================== native: the production activation path */

let capsule = null;
async function native() {
  if (!capsule) {
    const { compileWindowBehaviorCapsule } = await import('./window-visibility-native.test.mjs');
    capsule = compileWindowBehaviorCapsule();
  }
  return capsule;
}
const activate = { op: 'nativeChrome', schema: 1, epoch: 1, operationId: 'focus4', call: 'call-A', intent: { kind: 'activate', windowId: 2, tabId: 9, fitCurrent: true } };
// Window 2 (the target) spans [0,40,1000,700]; window 1 (another Chrome window) is [100,100,600,500]. The landing point
// (850,650) is inside the target only.
const clickAt = { op: 'click', aim: { x: 850, y: 650 }, rect: { x: 840, y: 640, w: 20, h: 20 } };
async function activation(fixture) {
  const r = (await native()).run({ initialBounds: [0, 40, 1000, 700], requests: [activate, clickAt], ...fixture });
  return { r, a: r.replies[0], click: r.replies[1], writes: r.effects.map(e => e.kind), input: r.input.map(i => i.kind) };
}
const said = ({ a, writes, input, click }) => `activation ${a.ok ? 'ok' : a.error} key=${a.keyWindowIsTarget} onTop=${a.targetOnTop} axWindowMissing=${a.axWindowMissing}; ` +
  `writes ${writes.join(',')}; click ${click?.ok ? 'posted' : click?.why || click?.error}; input ${input.join(',') || 'none'}`;

add('new', 'native-ax-empty', 'AXWindows empty: the activation skips AXMain/AXRaise, records axWindowMissing, completes; the click lands once', async () => {
  const x = await activation({ name: 'ax-empty', axEmpty: true });
  evidence.push(`native-ax-empty: ${said(x)}`);
  assert.equal(x.a.ok, true, JSON.stringify(x.a));
  assert.equal(x.a.axWindowMissing, true);
  assert.deepEqual(x.writes, ['index', 'app'], 'no AX write without the AX target; every other write once');
  assert.equal(x.a.inputDelivery, 'sent');
  assert.equal(x.click?.ok, true, JSON.stringify(x.click));
  assert.deepEqual(x.input, ['down', 'up']);
});

add('new', 'native-ax-key', 'AXFocusedWindow unavailable, or another window: the activation completes with keyWindowIsTarget false at the first on-top sample; the click lands once', async () => {
  for (const [label, fixture] of [['missing', { axFocusMissing: true }], ['other window', { keySamples: [false] }]]) {
    const x = await activation({ name: `ax-key-${label.replace(' ', '-')}`, ...fixture });
    evidence.push(`native-ax-key (${label}): ${said(x)}; focus reads ${x.r.focusReads}`);
    assert.equal(x.a.ok, true, `${label}: ${JSON.stringify(x.a)}`);
    assert.equal(x.a.keyWindowIsTarget, false, label);
    assert.equal(x.a.targetOnTop, true, label);
    assert.equal(x.a.axWindowMissing, false, label);
    assert.equal(x.r.focusReads, 1, `${label}: never waits for the AX key window`);
    assert.deepEqual(x.writes, ['index', 'main', 'raise', 'app'], label);
    assert.deepEqual(x.input, ['down', 'up'], label);
  }
});

add('new', 'native-order-not-landing', 'another Chrome window ahead in CG order (never on top) but not at the landing point: the activation completes at the 1 s bound with targetOnTop false; the click lands once', async () => {
  const x = await activation({ name: 'order-not-landing', focusWorld: [{ chromeAbove: true }] });
  evidence.push(`native-order-not-landing: ${said(x)}; ${Math.round((x.r.clock - x.r.appAt) * 1000)} ms from the app write`);
  assert.equal(x.a.ok, true, JSON.stringify(x.a));
  assert.equal(x.a.targetOnTop, false);
  assert.ok(x.a.focusSamples > 1, 'the settle sampled until its bound (window-visibility-native focus-settle-never times it)');
  assert.equal(x.click?.ok, true, JSON.stringify(x.click));
  assert.deepEqual(x.input, ['down', 'up']);
});

add('kept', 'native-ax-present', 'the AX target present: AXMain and AXRaise each once, axWindowMissing false, the key fact true', async () => {
  const x = await activation({ name: 'ax-present' });
  evidence.push(`native-ax-present: ${said(x)}`);
  assert.equal(x.a.ok, true); assert.deepEqual(x.writes, ['index', 'main', 'raise', 'app']);
  assert.equal(x.a.axWindowMissing, false); assert.equal(x.a.keyWindowIsTarget, true); assert.deepEqual(x.input, ['down', 'up']);
});

add('new', 'native-apple-activate', 'amendment A: another app still in front after the activation: Chrome\'s activate Apple Event once brings it front; focusAppleActivate; the click lands once', async () => {
  const x = await activation({ name: 'apple-activate', focusWorld: [{ front: 77 }] });
  evidence.push(`native-apple-activate: ${said(x)}; focusAppleActivate=${x.a.focusAppleActivate}`);
  assert.equal(x.a.ok, true, JSON.stringify(x.a));
  assert.equal(x.a.focusAppleActivate, true);
  assert.deepEqual(x.writes, ['index', 'main', 'raise', 'app', 'apple'], 'the Apple Event once, after the activation\'s own writes');
  assert.equal(x.a.frontmostPid, 42, 'the facts read again after it');
  assert.equal(x.click?.ok, true, JSON.stringify(x.click));
  assert.deepEqual(x.input, ['down', 'up']);
  const front = await activation({ name: 'apple-not-needed' });
  assert.equal(front.writes.includes('apple'), false, 'Chrome already frontmost: no Apple Event');
  assert.equal('focusAppleActivate' in front.a, false);
});

add('new', 'native-apple-stop', 'r1 A3: a Stop right after the Apple Event was sent: the reply (the Session\'s Stop, with the ledger) still says focusAppleActivate; activate_apple is the last write, sent', async () => {
  const x = await activation({ name: 'apple-stop', focusWorld: [{ front: 77 }], stopStage: 'activate_apple', stopOccurrence: 2 });
  const last = x.a.stages?.at(-1);
  evidence.push(`native-apple-stop: reply ${x.a.error}, focusAppleActivate=${x.a.focusAppleActivate}, last write ${last?.stage}/${last?.delivery}; input ${x.input.join(',') || 'none'}`);
  assert.equal(x.a.ok, false, JSON.stringify(x.a));
  assert.equal(x.a.error, 'aborted');
  assert.equal(x.a.focusAppleActivate, true, JSON.stringify(x.a));
  assert.equal(last?.stage, 'activate_apple'); assert.equal(last?.delivery, 'sent');
  assert.deepEqual(x.input, []);
});

add('new', 'native-apple-sample-failure', 'r1 A3: the sample after the Apple Event fails (no window list): native_focus_unknown, and the reply still says focusAppleActivate', async () => {
  const x = await activation({ name: 'apple-sample-failure', focusWorld: [{ front: 77 }], failCGAfterApple: true });
  evidence.push(`native-apple-sample-failure: reply ${x.a.error}/${x.a.stage}, focusAppleActivate=${x.a.focusAppleActivate}, delivery ${x.a.inputDelivery}`);
  assert.equal(x.a.ok, false, JSON.stringify(x.a));
  assert.equal(x.a.error, 'native_focus_unknown');
  assert.equal(x.a.focusAppleActivate, true, JSON.stringify(x.a));
  assert.equal(x.a.noRetry, true);
  assert.deepEqual(x.writes, ['index', 'main', 'raise', 'app', 'apple']);
  // (The fixture's own click request after the failed activation is not the production flow: the server sends none.)
});

add('kept', 'native-wrong-app-at-event', 'another app frontmost at the click (front pid != Chrome, even after the Apple Event): the activation reports it, the click guard refuses before any press', async () => {
  const x = await activation({ name: 'wrong-app', focusWorld: [{ front: 77 }], appleFails: true });
  evidence.push(`native-wrong-app-at-event: ${said(x)}`);
  assert.equal(x.a.ok, true, 'the activation itself is not the verdict');
  assert.equal(x.a.focusAppleActivate, true);
  assert.deepEqual(x.writes, ['index', 'main', 'raise', 'app', 'apple'], 'the Apple Event once only');
  assert.equal(x.a.frontmostPid, 0, 'the sample saw no Chrome in front');
  assert.equal(x.click?.ok, false); assert.equal(x.click?.why, 'not_frontmost', JSON.stringify(x.click));
  assert.deepEqual(x.input, [], 'no press');
});

add('kept', 'native-wrong-window-at-point', 'another window at the landing point (CG hit test != the bound window): the click guard refuses before any press', async () => {
  const x = await activation({ name: 'wrong-window', top: 77 });
  evidence.push(`native-wrong-window-at-point: ${said(x)}`);
  assert.equal(x.a.ok, true);
  assert.equal(x.click?.ok, false); assert.equal(x.click?.why, 'window_not_top', JSON.stringify(x.click));
  assert.deepEqual(x.input, []);
});

add('kept', 'native-ax-write-uncertain', 'an AX assistance write that fails after it was entered stays native_write_unknown (sent ledger, noRetry), never "skipped"', async () => {
  const x = await activation({ name: 'ax-write-unknown', unknownStage: 'activate_main' });
  evidence.push(`native-ax-write-uncertain: ${said(x)}`);
  assert.equal(x.a.ok, false); assert.equal(x.a.error, 'native_write_unknown'); assert.equal(x.a.stage, 'activate_main');
  assert.equal(x.a.inputDelivery, 'unknown'); assert.equal(x.a.noRetry, true);
  assert.deepEqual(x.input, []);
});

/* ======================================================================== chromectl: the G-h destination decision */

let matcher = null;
function windowMatches(rows) {
  if (!matcher) {
    const source = fs.readFileSync(process.env.CHROMECTL_SOURCE || path.join(ROOT, 'src/chromectl.swift'), 'utf8');
    const at = source.indexOf('func nativeWindowMatches(');
    assert.ok(at >= 0, 'nativeWindowMatches is in chromectl.swift');
    const fn = source.slice(at, source.indexOf('\n}\n', at) + 3);
    const probe = source.slice(source.indexOf('func nativeInputProbe('), source.indexOf('\nfunc rectOf('));
    assert.match(probe, /"windowMatches": nativeWindowMatches\(expected: expectedWindow, hit: hitWindowID, focused: focusedWindowID, menu: menu\)/,
      'nativeInputProbe reports this decision');
    const dir = fs.mkdtempSync(path.join(tmp, 'gh-')), main = path.join(dir, 'main.swift'), bin = path.join(dir, 'gh');
    fs.writeFileSync(main, `import Foundation\n${fn}\nlet rows = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [[String: Any]]\n` +
      'print(rows.map { r in nativeWindowMatches(expected: r["expected"] as! Int, hit: r["hit"] as? Int, focused: r["focused"] as? Int, menu: r["menu"] as! Bool) ? "1" : "0" }.joined())\n');
    const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', path.join(dir, 'cache'), '-o', bin, main], { encoding: 'utf8', timeout: 300_000 });
    assert.equal(c.status, 0, c.stderr);
    matcher = bin;
  }
  const r = spawnSync(matcher, [JSON.stringify(rows)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return [...r.stdout.trim()].map(x => x === '1');
}
add('new', 'gh-no-focused-window', 'G-h: the element at the landing point in the bound window matches without (or against) AXFocusedWindow', async () => {
  const got = windowMatches([{ expected: 20, hit: 20, focused: null, menu: false }, { expected: 20, hit: 20, focused: 10, menu: false }]);
  evidence.push(`gh-no-focused-window: hit=bound with focused missing → ${got[0]}, focused=another window → ${got[1]}`);
  assert.deepEqual(got, [true, true]);
});
let menuStater = null;
/** r2 A2: chromectl's own nativeMenuState (exact source) and the probe's use of it, compiled with a driver. */
function menuStates(rows) {
  if (!menuStater) {
    const source = fs.readFileSync(process.env.CHROMECTL_SOURCE || path.join(ROOT, 'src/chromectl.swift'), 'utf8');
    const at = source.indexOf('func nativeMenuState(');
    assert.ok(at >= 0, 'nativeMenuState is in chromectl.swift');
    const fn = source.slice(at, source.indexOf('\n}\n', at) + 3);
    const probe = source.slice(source.indexOf('func nativeInputProbe('), source.indexOf('\nfunc rectOf('));
    assert.match(probe, /try focusedChain\.filter \{ \$0\.1 == kAXPopUpButtonRole \}\.map \{ try probe\.value\(\$0\.0, kAXExpandedAttribute\) as\? Bool \}/,
      'the probe reads each focused popup button\'s explicit expansion value');
    assert.match(probe, /nativeMenuState\(focused: focused != nil, roles: focusedChain\.map \{ \$0\.1 \}, menu: menu, popupExpanded: popupExpanded\)/);
    assert.match(probe, /"menuState": menuState/, 'nativeInputProbe reports menuState');
    const dir = fs.mkdtempSync(path.join(tmp, 'menu-')), main = path.join(dir, 'main.swift'), bin = path.join(dir, 'menu');
    fs.writeFileSync(main, `import Foundation\nimport ApplicationServices\n${fn}\nlet rows = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [[String: Any]]\n` +
      'print(rows.map { r in nativeMenuState(focused: r["focused"] as! Bool, roles: r["roles"] as! [String], menu: r["menu"] as! Bool, ' +
      'popupExpanded: (r["expanded"] as! [Any]).map { $0 as? Bool }) }.joined(separator: ","))\n');
    const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', path.join(dir, 'cache'), '-o', bin, main], { encoding: 'utf8', timeout: 300_000 });
    assert.equal(c.status, 0, c.stderr);
    menuStater = bin;
  }
  const r = spawnSync(menuStater, [JSON.stringify(rows)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split(',');
}
add('new', 'menu-state-producer', 'r2 A2: the probe\'s menuState is closed only from complete AX focus evidence; a missing focused element, an incomplete chain, an unread role or a popup without an expansion value is unknown; positive menu evidence is open', async () => {
  const W = 'AXWindow', rows = [
    ['complete, no popup', { focused: true, roles: ['AXButton', 'AXGroup', 'AXWebArea', W], menu: false, expanded: [] }, 'closed'],
    ['complete, popup collapsed', { focused: true, roles: ['AXPopUpButton', 'AXWebArea', W], menu: false, expanded: [false] }, 'closed'],
    ['application root', { focused: true, roles: ['AXTextField', 'AXApplication'], menu: false, expanded: [] }, 'closed'],
    ['missing focused element', { focused: false, roles: [], menu: false, expanded: [] }, 'unknown'],
    ['incomplete chain', { focused: true, roles: ['AXButton', 'AXGroup'], menu: false, expanded: [] }, 'unknown'],
    ['unread role', { focused: true, roles: ['AXButton', '', W], menu: false, expanded: [] }, 'unknown'],
    ['popup without expansion value', { focused: true, roles: ['AXPopUpButton', 'AXWebArea', W], menu: false, expanded: [null] }, 'unknown'],
    ['open menu', { focused: true, roles: ['AXMenuItem', 'AXMenu', W], menu: true, expanded: [] }, 'open'],
    ['open menu, chain incomplete', { focused: false, roles: [], menu: true, expanded: [] }, 'open'],
  ];
  const got = menuStates(rows.map(r => r[1]));
  evidence.push(`menu-state-producer: ${rows.map((r, i) => `${r[0]}=${got[i]}`).join('; ')}`);
  assert.deepEqual(got, rows.map(r => r[2]));
});
add('kept', 'gh-protections', 'G-h: an element of another window, or none (missing control evidence), never matches; an open menu matches only with the focused window bound', async () => {
  const got = windowMatches([
    { expected: 20, hit: 10, focused: 20, menu: false }, { expected: 20, hit: null, focused: 20, menu: false }, { expected: 20, hit: null, focused: null, menu: false },
    { expected: 20, hit: 900, focused: 20, menu: true }, { expected: 20, hit: 900, focused: 10, menu: true }, { expected: 20, hit: 900, focused: null, menu: true }]);
  evidence.push(`gh-protections: ${got.map(Number).join('')}`);
  assert.deepEqual(got, [false, false, false, true, false, false]);
});

/* ======================================================================== js: the production callTool */

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
let state, log;
const target = id => ({ tabId: id, windowId: 7, chromePid: 42, cgWindow: 70, tabActive: true, minimized: false,
  bounds: { ...BOUNDS }, url: state.url, title: `t${id}` });
/** A completed activation, as the FOCUS4 helper replies (FOCUS2/3 shape plus axWindowMissing). */
const completed = extra => id => ({ ok: true, inputDelivery: 'sent', stages: SENT, epoch: 1, operationId: id, ...target(10),
  windowIndex: 1, frontmost: 'Google Chrome', frontmostPid: 42, waitedMs: 0, targetOnTop: true, keyWindowIsTarget: true, axWindowMissing: false,
  frontmostChanged: false, prevFrontPutBack: false,
  geometry: { mode: 'fit-current', beforeBounds: { ...BOUNDS }, displayId: 1, branch: 'usable', changed: false, possiblyChanged: false }, ...extra });
const SAMPLES = {
  'key false': { keyWindowIsTarget: false },
  'AX window missing': { keyWindowIsTarget: false, axWindowMissing: true },
  'CG order false': { targetOnTop: false, focusBlocker: { owner: 'Google Chrome', pid: 42, layer: 0, width: 800, height: 600 } },
  'other app front': { targetOnTop: false, keyWindowIsTarget: false, frontmost: 'Terminal', frontmostPid: 555 },
};
function page(kind, vars, tab) {
  const t = target(tab == null ? 10 : Number(tab));
  if (kind === 'block') return { ok: true, blocked: null, target: t };
  if (kind === 'temporal') return { ok: true, fail: 'not_temporal', target: t };
  if (kind === 'locate') {
    if (vars.MODE === 'scroll') return { bounds: t.bounds, view: VIEW, scroller: 'document', points: [{ x: 600, y: 400 }],
      height: 800, scrollTop: 0, max: 5000, target: t };
    if (vars.MODE === 'measure') { state.scrollTop += 800; return { ok: true, scrollTop: state.scrollTop, max: 5000, target: t }; }
    return { bounds: t.bounds, view: VIEW, tag: 'button', text: 'Next', url: state.url, aim: { x: 100, y: 112 },
      rect: { x: 10, y: 100, width: 200, height: 24 }, visible: { x: 10, y: 100, width: 200, height: 24 },
      land: { x: 90, y: 106, width: 20, height: 12 }, hitOk: true, chain: [], target: t,
      ...(vars.MODE === 'field' ? { focusToken: 'field-token' } : {}) };
  }
  if (kind === 'ack') {
    const a = vars.ACK || {};
    if (a.arm) return { ok: true, armed: true, target: t };
    const met = state.clicks > 0;
    return { ok: true, armed: !state.ackGone, met, click: met ? 1 : 0, pointerup: met ? 1 : 0, keyup: 0, target: t,
      ...(met || a.disarm ? (state.ackGone = true, {}) : {}) };
  }
  if (kind === 'read') return vars.READ?.actionSnapshot ? { ok: true, controls: [], controlsComplete: true }
    : { ok: true, text: '=== 这一屏\n[1] 按钮 Next', count: 1, hint: '', opaque: 0, outline: [], target: t };
  if (kind === 'click-observation') return { ok: true, href: state.url, texts: ['Next'], dialogs: [], complete: true, busy: false,
    renderedHash: 1, scrollX: 0, scrollY: 0, targetState: null };
  if (kind === 'after') {
    const expect = vars.EXPECT;
    return { ok: true, hasFocus: true, activeEditable: true, activeIsTarget: true, bound: true,
      bindingMatches: !!vars.BIND?.check, selectionStable: !!vars.BIND?.check, selectionAll: true, href: state.url, focusMoved: false,
      changed: state.value !== '', fieldHasText: expect != null && state.value.endsWith(expect), confirmedChars: expect != null ? [...expect].length : 0, target: t };
  }
  if (kind === 'select') {
    if (vars.MODE === 'check') return { ok: true, selected: state.typed.length > 0, target: t };
    return { ok: true, index: 2, current: 1, focused: true, hasFocus: true, typeahead: 'b', text: 'B', target: t };
  }
  throw new Error(`unexpected page script ${kind}`);
}
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in focus4 test`); }]));
  return Object.assign(fake, {
    pageDialog: async () => ({ ok: true, open: false }),
    ensureScreenAwake: async () => ({ locked: false, displays: 1, woke: false }),
    axInput: async args => { state.axCalls.push(args.point ? 'point' : 'focus'); return state.ax(args); },
    axMenuState: async () => ({ ok: true, known: true, menuOpen: false }),
    // r1 A4: native-select.js is the real page script, evaluated in the jsdom page; the other page scripts are fakes.
    pageScript: async (kind, vars = {}) => kind === 'native-select' ? bridge.pageScript(kind, vars) : `fakePage(${JSON.stringify(kind)}, ${JSON.stringify(vars)})`,
    evalInPage: async (src, tab) => {
      const w = state.dom;
      if (src.includes('function popupSelect(')) state.focusReads++;
      w.fakePage = (k, v) => JSON.stringify(page(k, v, tab));
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
          if (req.op === 'nativeChrome' && req.intent?.kind === 'activate') { state.activations++; return state.activation(req.operationId); }
          if (req.op === 'veil') return { ok: true, held, takeover: { active: held } };
          if (req.op === 'click') { state.clicks++; return { ok: true, epoch: 1, landed: { x: 100, y: 112 }, timing: {}, inputDelivery: 'sent' }; }
          if (req.op === 'key') { state.keys++; state.onKey?.(state.keys); return { ok: true, epoch: 1, postedInput: 1 }; }
          if (req.op === 'type' || req.op === 'paste') { state.typed.push(req.text); state.value += req.text;
            return { ok: true, epoch: 1, typed: [...req.text].length, postedInput: req.text.length }; }
          if (req.op === 'wheel') return { ok: true, epoch: 1, sent: req.notches, postedInput: req.notches };
          if (req.op === 'move') return { ok: true, epoch: 1, landed: req.to, points: 5, skippedMove: false };
          if (req.op === 'routed') return { ok: true, allToChrome: true, ms: 1 };
          return { ok: true, epoch: 1, operationId: req.operationId, stages: [], inputDelivery: req.op === 'nativeChrome' ? 'sent' : undefined,
            inputMonitor: true, takeover: { active: held }, ...(req.op === 'warp' ? { verified: true, warped: req.to } : {}) };
        },
        close: async () => { held = false; return { ok: true, takeover: { active: false, swallowedKeys: 0, swallowedPointer: 0 } }; },
      };
    },
    snapshotScene: async () => ({ appPid: 99, chromeWindow: 7, chromeTab: 10 }),
    restoreScene: async (_scene, options) => { await options.native({ kind: 'restoreScene' }, { policy: 'restore' }); return { ok: true, appFrontmost: true }; },
    activateChrome: bridge.activateChrome,   // production: the helper's reply becomes the result or the error here
    selectTab: async (id, o) => { await o.native({ kind: 'selectTab', tabId: id, windowId: o.windowId }); return { ok: true, ...target(id), changed: false }; },
    openNavigationObserver: async () => ({ startedAt: Date.now(), untouched: async () => true, close: async () => {} }),
    cgevent: async args => {
      if (args[0] === 'displays') return { displays: [] };
      if (args[0] === 'mousepos') return { x: 10, y: 20 };
      // The scroll's own wheel-location check (unoccludedPoint) reads the window at its point: the target. Any other
      // tool reading it would be the retired window-centre diagnostic sample of bringOnScreen.
      if (args[0] === 'windowsat') { log.push('windowsat'); return { windows: [{ id: 70, pid: 42, owner: 'Google Chrome', layer: 0, bounds: { x: 0, y: 0, w: 1200, h: 900 } }] }; }
      if (args[0] === 'idle') return { ok: true, idle: 100, keyIdle: 100, held: [], clickIdle: 100 };
      throw new Error(`B.cgevent ${args[0]} reached in focus4 test`);
    },
  });
}
const AX_OK = { ok: true, frontmost: true, windowMatches: true, nodeFound: true, hitWindow: 70, focusedWindow: 70, documentToken: 'doc1',
  focusedDocumentToken: 'doc1', menuOpen: false, menuState: 'closed', nativeMenuOpen: false, nativePopup: false, blocker: null };
/** AX control inspection unavailable: the probe fails, or answers without an element or a window number for it. */
const AX_FAILS = () => { throw new bridge.BridgeError('ax_probe_failed', 'Native target inspection failed (AX -25204); no input was sent.'); };
const AX_MISSING = { ...AX_OK, windowMatches: false, nodeFound: false, hitWindow: null, focusedWindow: null, documentToken: null, focusedDocumentToken: null,
  menuState: 'unknown' };
/** The jsdom page native-select.js reads: marker 1 a button, 2 an inaccessible (cross-origin) frame, 3 a popup select,
 * 4 a custom element with no open shadow root, 5 a label for the select. */
function fixturePage(html = '<button id="b">Next</button><input id="f"><select id="s"><option>A</option><option>B</option></select>' +
  '<iframe id="x"></iframe><x-widget id="w" tabindex="0"></x-widget><label id="l" for="s">Pick</label>') {
  const w = new JSDOM(html, { url: 'https://shop.test/page', runScripts: 'outside-only' }).window;
  const d = w.document, frame = d.getElementById('x');
  if (frame) Object.defineProperty(frame, 'contentDocument', { get: () => null });   // cross-origin: not reachable
  w.__chromeBridge = { markers: [null, d.getElementById('b'), frame, d.getElementById('s'), d.getElementById('w'), d.getElementById('l')], url: w.location.href };
  return w;
}
let world = 0;
async function setup(o = {}) {
  for (const t = Date.now(); idx.__taskHoldForTests() && Date.now() - t < 3000;) await sleep(20);
  idx.__resetPanelTaskForTests(); idx.__resetLedgerForTests(); idx.__resetNativeTargetsForTests(); idx.__resetShotsForTests(); idx.__resetTypedForTests?.();
  idx.__setTakeoverForTests(true);
  S.writeSettings({ inputMode: 'auto', inputSpeed: 3 });
  // A fresh tab id per world: no geometry mark or shot of an earlier case applies.
  const tab = 10;
  state = { url: `https://shop.test/form-${++world}`, activation: completed(), activations: 0, clicks: 0, typed: [], value: '', scrollTop: 0,
    focusReads: 0, keys: 0, ackGone: false, axCalls: [], ax: () => AX_OK, focus: 'b', atPoint: 'b', ...o };
  state.dom = fixturePage();
  state.build?.(state.dom);
  // The page's keyboard focus (r1 A4): an element focused (document.hasFocus() true), or none (the omnibox or another
  // window has it: false). onKey changes it between key events.
  if (state.focus) state.dom.document.getElementById(state.focus).focus();
  state.dom.document.elementFromPoint = () => state.dom.document.getElementById(state.atPoint);
  log = [];
  idx.__setBridgeForTests(fakeBridge());
  await T.registerTab(tab, state.url, { windowId: 7, agentName: 'focus4-test' });
  await rm(ACTIVITY, { force: true });
}
const INPUT = new Set(['click', 'key', 'type', 'paste', 'wheel', 'move']);
async function run(name, args) {
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  const rows = (await readFile(ACTIVITY, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError, error: r.structuredContent?.error || null,
    row: rows.at(-1) ?? null, inputs: log.filter(op => INPUT.has(op)), activations: state.activations,
    diagnostics: name === 'scroll' ? 0 : log.filter(op => op === 'windowsat').length };
}
const brief = r => `${r.isError ? `refused ${r.error?.code}` : 'done'}; ${r.activations} activation(s); input ${r.inputs.join(',') || 'none'}`;
const TOOLS = {
  click: ['click', { tab: 10, marker: 1 }], hover: ['hover', { tab: 10, marker: 1 }], scroll: ['scroll', { tab: 10, direction: 'down' }],
  type_text: ['type_text', { tab: 10, marker: 1, text: 'hi', input_mode: 'keys' }], select_option: ['select_option', { tab: 10, marker: 1, option: 'B' }],
  press_key: ['press_key', { tab: 10, key: 'enter' }],
};
// What each tool posts when it is done: the pointer tools' press or move, the key tools' keys, the wheel's notches.
const DONE = { click: ['click'], hover: ['move'], scroll: ['wheel'], type_text: ['click', 'type'], select_option: ['type'], press_key: ['key'] };

add('new', 'js-ax-not-a-veto', 'per tool: an activation reporting the AX key window not the target, or the AX window list without it, is not refused; the tool posts its own input once; the row carries the AX facts', async () => {
  const broken = [];
  for (const sample of ['key false', 'AX window missing']) for (const [tool, [name, args]] of Object.entries(TOOLS)) {
    await setup({ activation: completed(SAMPLES[sample]) });
    const r = await run(name, args);
    evidence.push(`events ${tool} (${sample}): ${brief(r)}; row keyWindowIsTarget=${r.row?.keyWindowIsTarget} axWindowMissing=${r.row?.axWindowMissing}`);
    try {
      assert.equal(r.isError, false, `${tool} ${sample}: ${r.text}`);
      assert.equal(r.activations, 1, `${tool} ${sample}: one activation`);
      for (const kind of DONE[tool]) assert.ok(r.inputs.includes(kind), `${tool} ${sample}: no ${kind} posted: ${r.inputs}`);
      assert.equal(r.row?.keyWindowIsTarget, false, `${tool} ${sample}: row ${JSON.stringify(r.row)}`);
      assert.equal(r.row?.axWindowMissing, sample === 'AX window missing', `${tool} ${sample}: row ${JSON.stringify(r.row)}`);
    } catch (e) { broken.push(e); }
  }
  if (broken.length) { broken[0].message = `${broken.length} tool/sample cell(s) failed; first: ${broken[0].message}`; throw broken[0]; }
});

add('new', 'js-order-not-a-veto', 'per tool: an activation whose CG order sample says another Chrome window is ahead is not refused and takes no window-centre diagnostic sample; the destination checks decide', async () => {
  const broken = [];
  for (const [tool, [name, args]] of Object.entries(TOOLS)) {
    await setup({ activation: completed(SAMPLES['CG order false']) });
    const r = await run(name, args);
    evidence.push(`events ${tool} (CG order false): ${brief(r)}; diagnostic samples ${r.diagnostics}`);
    try {
      assert.equal(r.isError, false, `${tool}: ${r.text}`);
      for (const kind of DONE[tool]) assert.ok(r.inputs.includes(kind), `${tool}: no ${kind} posted: ${r.inputs}`);
      assert.equal(r.diagnostics, 0, `${tool}: a window-centre diagnostic sample`);
    } catch (e) { broken.push(e); }
  }
  if (broken.length) { broken[0].message = `${broken.length} tool(s) failed; first: ${broken[0].message}`; throw broken[0]; }
});

add('new', 'js-recipient', 'another app in front after the activation: a press or a key is refused once (activate_unconfirmed, other_app_front, zero input); a move or a wheel is not (its event guard checks the point, not the front app)', async () => {
  const broken = [];
  for (const [tool, [name, args]] of Object.entries(TOOLS)) {
    await setup({ activation: completed(SAMPLES['other app front']) });
    const r = await run(name, args);
    evidence.push(`events ${tool} (other app front): ${brief(r)}; row focusReason=${r.row?.focusReason}`);
    try {
      if (['hover', 'scroll'].includes(tool)) {
        assert.equal(r.isError, false, `${tool}: ${r.text}`);
        for (const kind of DONE[tool]) assert.ok(r.inputs.includes(kind), `${tool}: no ${kind} posted`);
      } else {
        assert.equal(r.isError, true, `${tool}: ${r.text}`);
        assert.equal(r.error?.code, 'activate_unconfirmed', `${tool}: ${r.text}`);
        assert.deepEqual(r.inputs, [], `${tool}: input posted`);
        assert.equal(r.activations, 1, `${tool}: retried`);
        assert.equal(r.row?.focusReason, 'other_app_front', `${tool}: row ${JSON.stringify(r.row)}`);
        assert.match(r.text, /最前面的 App：「Terminal」/);
        assert.match(r.text, /没有发送点击或按键/);
      }
    } catch (e) { broken.push(e); }
  }
  if (broken.length) { broken[0].message = `${broken.length} tool(s) failed; first: ${broken[0].message}`; throw broken[0]; }
});

add('new', 'js-presskey-no-focus', 'press_key: the target page does not own keyboard focus (omnibox, another window): zero keys, no_page_focus, not retried', async () => {
  await setup({ focus: null });   // nothing in the page holds focus: document.hasFocus() is false
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`js-presskey-no-focus: ${brief(r)}; page focus reads ${state.focusReads}`);
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'no_page_focus', r.text);
  assert.deepEqual(r.inputs, [], 'a key was posted');
  assert.equal(r.activations, 1);
  assert.ok(state.focusReads >= 2 && state.focusReads <= 6, `bounded grace before the first key: ${state.focusReads} reads`);
  assert.match(r.text, /没有按键/);
});

add('new', 'js-presskey-focus-lost', 'press_key times 3: the page loses keyboard focus after the first key: the next key is withheld; one key, partial delivery, not retried', async () => {
  await setup({ onKey: n => { if (n === 1) state.dom.document.activeElement.blur(); } });   // focus leaves the page after the first key
  const r = await run('press_key', { tab: 10, key: 'down', times: 3 });
  evidence.push(`js-presskey-focus-lost: ${brief(r)}; page focus reads ${state.focusReads}; inputDelivery ${r.error?.inputDelivery}`);
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'no_page_focus', r.text);
  assert.deepEqual(r.inputs, ['key'], 'exactly the first key');
  assert.equal(r.activations, 1, 'not retried after a sent key');
  assert.equal(r.error?.inputDelivery, 'sent');
  assert.match(r.text, /第 2 次没有按，此前已按了 1 次/);
});

add('kept', 'js-presskey-focus-each', 'press_key times 3 with the page focused: the key-recipient check runs before every repetition; three keys', async () => {
  await setup();
  const r = await run('press_key', { tab: 10, key: 'down', times: 3 });
  evidence.push(`js-presskey-focus-each: ${brief(r)}; page focus reads ${state.focusReads}`);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.inputs, ['key', 'key', 'key']);
  assert.equal(state.focusReads, 3);
});

add('new', 'js-row-receipt', 'the row carries keyWindowIsTarget and axWindowMissing (booleans only); the error receipt carries them when they disagreed with the target', async () => {
  const base = { tool: 'click', ok: true, t: 1, pid: 1 };
  for (const v of [true, false]) {
    assert.equal(S.activityRecord({ ...base, axWindowMissing: v }).axWindowMissing, v);
    assert.equal(S.activityRecord({ ...base, keyWindowIsTarget: v }).keyWindowIsTarget, v);
  }
  for (const bad of ['true', 1, 0, null, {}, ['x'], 'https://private.invalid/']) {
    assert.equal('axWindowMissing' in S.activityRecord({ ...base, axWindowMissing: bad }), false, JSON.stringify(bad));
  }
  // A refusal after the activation (the page does not own focus): its receipt carries the activation's disagreeing AX facts.
  await setup({ activation: completed(SAMPLES['AX window missing']), focus: null });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`js-row-receipt: receipt ${JSON.stringify(r.error)}; row keyWindowIsTarget=${r.row?.keyWindowIsTarget} axWindowMissing=${r.row?.axWindowMissing}`);
  assert.equal(r.error?.keyWindowIsTarget, false, JSON.stringify(r.error));
  assert.equal(r.error?.axWindowMissing, true, JSON.stringify(r.error));
  assert.equal(r.row?.keyWindowIsTarget, false); assert.equal(r.row?.axWindowMissing, true);
  // Amendment A: the activation that needed Chrome's activate Apple Event says so on the row (true only).
  await setup({ activation: completed({ focusAppleActivate: true }) });
  const apple = await run('click', { tab: 10, marker: 1 });
  evidence.push(`js-row-receipt: Apple Event activation → row focusAppleActivate=${apple.row?.focusAppleActivate}; ${brief(apple)}`);
  assert.equal(apple.isError, false, apple.text); assert.equal(apple.row?.focusAppleActivate, true, JSON.stringify(apple.row));
  for (const bad of [false, 'true', 1]) assert.equal('focusAppleActivate' in S.activityRecord({ ...base, focusAppleActivate: bad }), false);
  // An agreeing activation adds nothing to a receipt.
  await setup({ focus: null });
  const quiet = await run('press_key', { tab: 10, key: 'enter' });
  assert.equal('keyWindowIsTarget' in (quiet.error || {}) || 'axWindowMissing' in (quiet.error || {}), false, JSON.stringify(quiet.error));
});

add('kept', 'js-tab-not-current', 'a FOCUS4 helper refusing a wrong active tab: tab_not_current, its own wording (no keyboard-focus claim), one activation, zero input', async () => {
  await setup({ activation: id => ({ ok: false, error: 'activate_unconfirmed', stage: 'activate_verify', inputDelivery: 'sent', noRetry: true, stages: SENT,
    epoch: 1, operationId: id, ...target(10), targetOnTop: true, keyWindowIsTarget: false, frontmost: 'Google Chrome', frontmostPid: 42, focusBlocker: null,
    axWindowMissing: false, focusVerdict: 'tab_not_current' }) });
  const r = await run('click', { tab: 10, marker: 1 });
  evidence.push(`js-tab-not-current: ${brief(r)}; row focusReason=${r.row?.focusReason}`);
  assert.equal(r.error?.code, 'activate_unconfirmed', r.text);
  assert.deepEqual(r.inputs, []);
  assert.equal(r.activations, 1);
  assert.equal(r.row?.focusReason, 'tab_not_current');
  assert.match(r.text, /没有成为它所在窗口的当前标签/);
  assert.doesNotMatch(r.text, /键盘焦点/);
});

/* ------------------------------------------------------------------ r1 A1: page evidence when AX cannot inspect the control */

const pressCases = () => [
  ['click', ['click', { tab: 10, marker: 1 }], 'click'],
  ['click_at', ['click_at', { tab: 10, x: 100, y: 100 }], 'click'],
  ['press_key', ['press_key', { tab: 10, key: 'enter' }], 'key'],
];
/** A fresh screenshot record for click_at (the hot-swap carry path, as a screenshot leaves it). */
const shot = () => idx.applyCarry({ shots: [[10, { at: Date.now(), width: 1200, height: 800, rect: { x: 0, y: 100, w: 1200, h: 800 },
  baseline: { chromePid: 42, cgWindow: 70, windowId: 7, tabId: 10, bounds: { ...BOUNDS } }, texts: [] }]] });

add('new', 'js-ax-unavailable-ordinary', 'AX cannot inspect the control (the probe fails, or finds no element/window) and the page positively shows an ordinary control (marker, landing point, focused element): click, click_at and the key proceed once', async () => {
  const broken = [];
  for (const [label, ax] of [['probe fails', AX_FAILS], ['no element', () => AX_MISSING]]) for (const [tool, [name, args], posted] of pressCases()) {
    await setup({ ax });
    if (tool === 'click_at') shot();
    const r = await run(name, args);
    evidence.push(`js-ax-unavailable-ordinary ${tool} (${label}): ${brief(r)}; AX probes ${state.axCalls.join(',')}`);
    try {
      assert.equal(r.isError, false, `${tool} ${label}: ${r.text}`);
      assert.deepEqual(r.inputs.filter(x => x !== 'move'), [posted], `${tool} ${label}: ${r.inputs}`);
      assert.ok(state.axCalls.length >= 1, `${tool} ${label}: the AX probe was not asked`);
    } catch (e) { broken.push(e); }
  }
  if (broken.length) { broken[0].message = `${broken.length} cell(s) failed; first: ${broken[0].message}`; throw broken[0]; }
});

add('new', 'js-ax-unavailable-unknown', 'AX cannot inspect the control and the page cannot positively classify it (an inaccessible frame, a custom element that may hide a closed shadow root): refused, zero input', async () => {
  const broken = [];
  for (const [label, o, tool, name, args] of [
    // r2 A1: the click's evidence is what its landing point hits (the marker element itself does not vouch).
    ['click on a cross-origin frame', { atPoint: 'x' }, 'click', 'click', { tab: 10, marker: 2 }],
    ['click on a custom element', { atPoint: 'w' }, 'click', 'click', { tab: 10, marker: 4 }],
    ['click_at on a cross-origin frame', { atPoint: 'x' }, 'click_at', 'click_at', { tab: 10, x: 100, y: 100 }],
    ['key with focus in a cross-origin frame', { focus: 'x' }, 'press_key', 'press_key', { tab: 10, key: 'enter' }],
    ['key with focus on a custom element', { focus: 'w' }, 'press_key', 'press_key', { tab: 10, key: 'enter' }],
  ]) for (const ax of [AX_FAILS, () => AX_MISSING]) {
    await setup({ ax, ...o });
    if (tool === 'click_at') shot();
    const r = await run(name, args);
    evidence.push(`js-ax-unavailable-unknown ${label} (${ax === AX_FAILS ? 'probe fails' : 'no element'}): ${brief(r)}`);
    try {
      assert.equal(r.isError, true, `${label}: ${r.text}`);
      assert.ok(['ax_probe_failed', 'native_target_changed'].includes(r.error?.code), `${label}: ${r.error?.code}`);
      assert.deepEqual(r.inputs.filter(x => x !== 'move'), [], `${label}: input posted`);
    } catch (e) { broken.push(e); }
  }
  if (broken.length) { broken[0].message = `${broken.length} cell(s) failed; first: ${broken[0].message}`; throw broken[0]; }
});

add('new', 'js-ax-conflict-wins', 'positive AX conflict or popup evidence wins over an ordinary page control: an element in another window, an open menu, a popup button, another app in front: refused, zero input', async () => {
  const broken = [];
  for (const [label, ax, code] of [
    ['element in another window', { ...AX_MISSING, nodeFound: true, hitWindow: 99 }, 'native_target_changed'],
    ['open menu', { ...AX_MISSING, menuOpen: true, menuState: 'open' }, 'native_target_changed'],
    // r2 A3: the landing element in the target window and an open menu in the focused chain (a valid combination).
    ['open menu, window matches', { ...AX_OK, menuOpen: true, menuState: 'open' }, 'native_target_changed'],
    ['menu state open, window matches', { ...AX_OK, menuState: 'open' }, 'native_target_changed'],
    ['popup button', { ...AX_MISSING, nodeFound: true, nativePopup: true }, 'use_select_option'],
    ['another app in front', { ...AX_OK, frontmost: false }, 'native_target_changed'],
  ]) for (const [tool, [name, args], posted] of pressCases()) {
    await setup({ ax: () => ax });
    if (tool === 'click_at') shot();
    const r = await run(name, args);
    evidence.push(`js-ax-conflict-wins ${tool} (${label}): ${brief(r)}`);
    try {
      assert.equal(r.isError, true, `${tool} ${label}: ${r.text}`);
      assert.equal(r.error?.code, code, `${tool} ${label}: ${r.text}`);
      assert.equal(r.inputs.includes(posted), false, `${tool} ${label}: ${r.inputs}`);
    } catch (e) { broken.push(e); }
  }
  if (broken.length) { broken[0].message = `${broken.length} cell(s) failed; first: ${broken[0].message}`; throw broken[0]; }
});

/* ------------------------------------------------------------------ the real page script's own facts (r1 A1, A4) */

async function pageRun(w, vars) {
  return JSON.parse(w.eval(await bridge.pageScript('native-select', { MARKER: null, POINT: null, BOUNDS: null, RECT: null, ...vars })));
}
add('new', 'dom-classify', 'native-select.js: control comes from the composed hit test at the landing point(s) (open shadow roots, labels and accessible frames traversed to the deepest element) or the focus chain; marker mode never vouches for a recipient; built-in elements (div, span, body) are ordinary (r3); an inaccessible frame, an unresolved host or a custom element with no accessible shadow root is unknown', async () => {
  const w = fixturePage('<button id="b">Next</button><select id="s"><option>A</option></select><label id="l" for="s">Pick</label>' +
    '<iframe id="x"></iframe><iframe id="ok"></iframe><x-widget id="w" tabindex="0"></x-widget><o-host id="o" tabindex="0"></o-host>' +
    '<select id="lb" size="3"><option>A</option></select><div id="cd" tabindex="0"></div><div id="pd">plain</div><span id="sp">t</span>' +
    '<a id="ln" href="#">link</a><x-sel id="os"></x-sel><x-btn id="ob"></x-btn><x-un id="ou"></x-un>');
  const d = w.document, el = id => d.getElementById(id);
  el('o').attachShadow({ mode: 'open' }).innerHTML = '<input id="inner">';
  el('cd').attachShadow({ mode: 'closed' }).innerHTML = '<select><option>A</option><option>B</option></select>';   // a standard element, closed shadow
  const osRoot = el('os').attachShadow({ mode: 'open' }); osRoot.innerHTML = '<select id="ins"><option>A</option></select>';
  osRoot.elementFromPoint = () => osRoot.getElementById('ins');
  const obRoot = el('ob').attachShadow({ mode: 'open' }); obRoot.innerHTML = '<button id="inb">Go</button>';
  obRoot.elementFromPoint = () => obRoot.getElementById('inb');
  el('ou').attachShadow({ mode: 'open' }).elementFromPoint = () => null;   // nothing of the shadow tree at the point
  const okDoc = el('ok').contentDocument; okDoc.body.innerHTML = '<input id="framed">';
  w.__chromeBridge.markers = [null, el('b'), el('x'), el('s'), el('w'), el('l'), el('o'), el('lb'), el('os')];
  const got = {};
  for (const [name, m] of [['button', 1], ['frame', 2], ['select', 3], ['label', 5], ['open-shadow host', 6], ['open-shadow host with a select', 8]]) {
    got[`marker ${name}`] = (await pageRun(w, { MODE: 'marker', MARKER: m })).control;
  }
  el('b').focus(); got['focus button'] = (await pageRun(w, { MODE: 'focus' })).control;
  el('o').shadowRoot.getElementById('inner').focus(); got['focus in open shadow'] = (await pageRun(w, { MODE: 'focus' })).control;
  el('x').focus(); got['focus cross-origin frame'] = (await pageRun(w, { MODE: 'focus' })).control;
  el('w').focus(); got['focus custom element'] = (await pageRun(w, { MODE: 'focus' })).control;
  el('cd').focus(); got['focus closed-shadow div'] = (await pageRun(w, { MODE: 'focus' })).control;
  el('ok').focus(); okDoc.getElementById('framed').focus(); got['focus in accessible frame'] = (await pageRun(w, { MODE: 'focus' })).control;
  d.activeElement.blur(); got['focus body only'] = (await pageRun(w, { MODE: 'focus' })).control;
  const BOUNDS = { left: 0, top: 0, width: w.outerWidth || 1024, height: w.outerHeight || 768 };
  for (const [name, target] of [['button', 'b'], ['link', 'ln'], ['cross-origin frame', 'x'], ['select', 's'], ['plain div', 'pd'], ['span', 'sp'],
    ['closed-shadow div', 'cd'], ['open-shadow host with a select', 'os'], ['open-shadow host with a button', 'ob'], ['unresolved open-shadow host', 'ou']]) {
    d.elementFromPoint = () => el(target);
    got[`point ${name}`] = (await pageRun(w, { MODE: 'point', POINT: { x: 50, y: 50 }, BOUNDS })).control;
  }
  // r2 A1: a marker click may land anywhere in its landing rect: a select at its far end counts.
  d.elementFromPoint = x => (x > 150 ? el('s') : el('b'));
  got['point button, rect reaching a select'] = (await pageRun(w, { MODE: 'point', POINT: { x: 100, y: 50 }, BOUNDS, RECT: { x: 90, y: 40, w: 200, h: 20 } })).control;
  got['point button, no rect'] = (await pageRun(w, { MODE: 'point', POINT: { x: 100, y: 50 }, BOUNDS })).control;
  evidence.push(`dom-classify: ${JSON.stringify(got)}`);
  assert.deepEqual(got, {
    'marker button': 'unknown', 'marker frame': 'unknown', 'marker select': 'native-select', 'marker label': 'native-select', 'marker open-shadow host': 'unknown',
    'marker open-shadow host with a select': 'unknown',
    'focus button': 'ordinary', 'focus in open shadow': 'ordinary', 'focus cross-origin frame': 'unknown', 'focus custom element': 'unknown',
    // r3: built-ins are ordinary, a built-in hosting a closed shadow root included (accepted B residual).
    'focus closed-shadow div': 'ordinary', 'focus in accessible frame': 'ordinary', 'focus body only': 'ordinary',
    'point button': 'ordinary', 'point link': 'ordinary', 'point cross-origin frame': 'unknown', 'point select': 'native-select', 'point plain div': 'ordinary',
    'point span': 'ordinary', 'point closed-shadow div': 'ordinary', 'point open-shadow host with a select': 'native-select',
    'point open-shadow host with a button': 'ordinary', 'point unresolved open-shadow host': 'unknown',
    'point button, rect reaching a select': 'native-select', 'point button, no rect': 'ordinary' });
});

add('new', 'js-ax-unavailable-shadow', 'r2 A1 + r3, production path with AX unavailable: a div button and a span button are clicked once, a key with body as the recipient is sent; an open-shadow marker host whose shadow tree puts a <select> at the landing point and a custom element with no accessible shadow root are refused with zero input; an open-shadow host resolving to a button proceeds', async () => {
  const shadowSelect = w => {
    const host = w.document.createElement('x-host'); host.setAttribute('role', 'button'); w.document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<select id="ins"><option>A</option><option>B</option></select>';
    root.elementFromPoint = () => root.getElementById('ins');
    host.id = 'h'; w.__chromeBridge.markers.push(host);   // marker 6
  };
  const shadowButton = w => {
    const host = w.document.createElement('x-host'); w.document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<button id="inb">Go</button>';
    root.elementFromPoint = () => root.getElementById('inb');
    host.id = 'h'; w.__chromeBridge.markers.push(host);
  };
  const builtin = tag => w => {
    const b = w.document.createElement(tag); b.id = 'bb'; b.setAttribute('role', 'button'); b.textContent = 'Go'; w.document.body.appendChild(b);
    w.__chromeBridge.markers.push(b);   // marker 6: a div/span with a click handler, the most common web button
  };
  const customClosed = w => {
    const c = w.document.createElement('x-closed'); c.id = 'cc'; c.tabIndex = 0; w.document.body.appendChild(c);
    c.attachShadow({ mode: 'closed' }).innerHTML = '<select><option>A</option><option>B</option></select>';
    w.__chromeBridge.markers.push(c);
  };
  const bodyFocus = w => { w.document.body.tabIndex = 0; };
  for (const [label, build, o, tool, name, args, proceeds] of [
    ['click on a div button', builtin('div'), { atPoint: 'bb' }, 'click', 'click', { tab: 10, marker: 6 }, true],
    ['click on a span button', builtin('span'), { atPoint: 'bb' }, 'click', 'click', { tab: 10, marker: 6 }, true],
    ['click_at on a div button', builtin('div'), { atPoint: 'bb' }, 'click_at', 'click_at', { tab: 10, x: 100, y: 100 }, true],
    ['key with body as the recipient', bodyFocus, { focus: null, focusBody: true }, 'press_key', 'press_key', { tab: 10, key: 'enter' }, true],
    ['click on an open-shadow host with a select inside', shadowSelect, { atPoint: 'h' }, 'click', 'click', { tab: 10, marker: 6 }, false],
    ['click_at on an open-shadow host with a select inside', shadowSelect, { atPoint: 'h' }, 'click_at', 'click_at', { tab: 10, x: 100, y: 100 }, false],
    ['click on a custom element without an accessible shadow root', customClosed, { atPoint: 'cc' }, 'click', 'click', { tab: 10, marker: 6 }, false],
    ['key with focus on a custom element without an accessible shadow root', customClosed, { focus: 'cc' }, 'press_key', 'press_key', { tab: 10, key: 'enter' }, false],
    ['click on an open-shadow host resolving to a button', shadowButton, { atPoint: 'h' }, 'click', 'click', { tab: 10, marker: 6 }, true],
  ]) {
    await setup({ ax: AX_FAILS, build, ...o });
    if (o.focusBody) state.dom.document.body.focus();
    if (tool === 'click_at') shot();
    const r = await run(name, args);
    evidence.push(`js-ax-unavailable-shadow ${label}: ${brief(r)}`);
    const pressed = r.inputs.filter(x => x !== 'move'), want = tool === 'press_key' ? 'key' : 'click';
    if (proceeds) { assert.equal(r.isError, false, `${label}: ${r.text}`); assert.deepEqual(pressed, [want], label); }
    else { assert.equal(r.isError, true, `${label}: ${r.text}`); assert.deepEqual(pressed, [], `${label}: input posted`); }
  }
});

add('new', 'dom-has-focus', 'native-select.js reports the page\'s own keyboard focus: true with an element focused, false once focus leaves it', async () => {
  const w = fixturePage();
  const before = (await pageRun(w, { MODE: 'focus' })).hasFocus;
  w.document.getElementById('b').focus();
  const focused = (await pageRun(w, { MODE: 'focus' })).hasFocus;
  w.document.getElementById('b').blur();
  const after = (await pageRun(w, { MODE: 'focus' })).hasFocus;
  evidence.push(`dom-has-focus: unfocused ${before}, focused ${focused}, after blur ${after}`);
  assert.deepEqual([before, focused, after], [false, true, false]);
});

/* ------------------------------------------------------------------ r1 A2: every ordinary key, tab and escape included */

add('new', 'js-leave-keys-no-focus', 'tab and ordinary escape: the page does not own keyboard focus before the first key: zero keys, no_page_focus', async () => {
  for (const key of ['tab', 'escape']) {
    await setup({ focus: null });
    const r = await run('press_key', { tab: 10, key });
    evidence.push(`js-leave-keys-no-focus ${key}: ${brief(r)}; page reads ${state.focusReads}`);
    assert.equal(r.isError, true, `${key}: ${r.text}`);
    assert.equal(r.error?.code, 'no_page_focus', `${key}: ${r.text}`);
    assert.deepEqual(r.inputs, [], `${key}: a key was posted`);
  }
});

add('new', 'js-leave-keys-focus-lost', 'tab times 3 and escape times 2: focus leaves the page after the first key: the next one is withheld (one key, partial delivery)', async () => {
  for (const [key, times] of [['tab', 3], ['escape', 2]]) {
    await setup({ onKey: n => { if (n === 1) state.dom.document.activeElement.blur(); } });
    const r = await run('press_key', { tab: 10, key, times });
    evidence.push(`js-leave-keys-focus-lost ${key}×${times}: ${brief(r)}; inputDelivery ${r.error?.inputDelivery}`);
    assert.equal(r.error?.code, 'no_page_focus', `${key}: ${r.text}`);
    assert.deepEqual(r.inputs, ['key'], `${key}: exactly the first key`);
    assert.equal(r.error?.inputDelivery, 'sent');
  }
});

add('new', 'js-leave-keys-menu', 'tab: a native menu open (AX), no AX reply, or a menu state other than an explicit closed: refused before any page read, zero keys', async () => {
  for (const [label, ax] of [['menu open', () => ({ ...AX_OK, menuOpen: true, menuState: 'open' })], ['AX unavailable', AX_FAILS],
    ['menu state unknown (no focused element)', () => ({ ...AX_OK, menuOpen: false, menuState: 'unknown' })],
    ['menu state absent (older helper)', () => { const { menuState, ...rest } = AX_OK; return rest; }]]) {
    await setup({ ax });
    const r = await run('press_key', { tab: 10, key: 'tab' });
    evidence.push(`js-leave-keys-menu (${label}): ${brief(r)}; page reads ${state.focusReads}`);
    assert.equal(r.isError, true, `${label}: ${r.text}`);
    assert.deepEqual(r.inputs, [], `${label}: a key was posted`);
    assert.equal(state.focusReads, 0, `${label}: the page was read while a native menu may block it`);
  }
});

add('kept', 'js-leave-keys-focused', 'tab and escape with the page focused (a focused select included) are sent, one page check per repetition; a focused select never refuses them', async () => {
  await setup();
  const t = await run('press_key', { tab: 10, key: 'tab', times: 2 });
  assert.equal(t.isError, false, t.text); assert.deepEqual(t.inputs, ['key', 'key']); assert.equal(state.focusReads, 2);
  await setup({ focus: 's' });
  const e = await run('press_key', { tab: 10, key: 'escape' });
  evidence.push(`js-leave-keys-focused: tab×2 ${brief(t)}; escape on a focused select ${brief(e)}`);
  assert.equal(e.isError, false, e.text); assert.deepEqual(e.inputs, ['key']);
});

/* ------------------------------------------------------------------ r1 A3: the Apple-activation fact through errors */

add('new', 'js-apple-error-row', 'r1 A3: an activation that sent the Apple Event and then stopped or failed: the row says focusAppleActivate and its last write is activate_apple', async () => {
  for (const [label, error, stage] of [['Stop after the send', 'aborted', 'activate_apple'], ['sample failure after it', 'native_focus_unknown', 'native_focus_read']]) {
    await setup({ activation: id => ({ ok: false, error, stage, inputDelivery: 'sent', noRetry: true, epoch: 1, operationId: id, ...target(10),
      stages: [...SENT, { sequence: 6, stage: 'activate_apple', entered: true, delivery: 'sent', acknowledged: false }], focusAppleActivate: true }) });
    const r = await run('click', { tab: 10, marker: 1 });
    evidence.push(`js-apple-error-row (${label}): ${brief(r)}; row focusAppleActivate=${r.row?.focusAppleActivate} lastWriteStage=${r.row?.lastWriteStage}`);
    assert.equal(r.isError, true, r.text);
    assert.deepEqual(r.inputs, []);
    assert.equal(r.row?.focusAppleActivate, true, `${label}: ${JSON.stringify(r.row)}`);
    assert.equal(r.row?.lastWriteStage, 'activate_apple', `${label}: ${JSON.stringify(r.row)}`);
  }
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
console.log(`\nfocus-destination tests: ${passed} passed, ${failed} failed. Artifacts: ${tmp}${capsule ? `, ${capsule.dir}` : ''}`);
process.exit(failed ? 1 : 0);
