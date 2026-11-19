// SHOT2: a page-area probe's stop reaches the screenshot receipt. The native child process is compiled from the
// production chromectl.swift (the axcontent dispatch, emit/fail, NativeInputProbe and its budget, pageContentBounds,
// nativePageContent) with AX, CG-window and clock doubles; bridge.js runs it through the production pageContentRect,
// coldNativeProbe and capturePageContent; screenshotTool and callTool are the production ones. The only bridge fakes
// are the screen-state, tab-info and site-check reads in front of the probe. No Chrome, AX, screen, mouse or keyboard.
// CHROMECTL_SOURCE points the Swift at another chromectl.swift (revert proof). SHOT2_GROUP=kept|new runs one group.
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-shot2-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
Object.assign(process.env, { CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_MENUBAR: '0',
  CHROME_BRIDGE_SWEEP: '0', CHROME_BRIDGE_WARM: '0', CHROME_BRIDGE_HOTSWAP: '0', CHROME_BRIDGE_LANG: 'zh',
  CHROME_BRIDGE_AGENT_NAME: 'shot2-test' });
fs.mkdirSync(path.join(tmp, 'lock'));
fs.writeFileSync(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ windowId: 9 }));

/* ------------------------------------------------ the native child: production Swift, AX doubles */

const source = fs.readFileSync(process.env.CHROMECTL_SOURCE || new URL('../src/chromectl.swift', import.meta.url), 'utf8');
const block = prefix => {
  const start = source.indexOf(prefix);
  assert.ok(start >= 0, `missing production code ${prefix}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const optional = prefix => source.includes(prefix) ? block(prefix) : '';
const program = `
import Foundation
import CoreGraphics
import CryptoKit
typealias AXUIElement = NSDictionary
typealias AXValue = NSArray
enum AXValueType { case cgPoint, cgSize }
enum AXError: Int32 { case success = 0, cannotComplete = -25204, attributeUnsupported = -25205, noValue = -25212 }
let kAXRoleAttribute = "role", kAXChildrenAttribute = "children", kAXVisibleChildrenAttribute = "visibleChildren",
    kAXWindowsAttribute = "windows", kAXPositionAttribute = "position", kAXSizeAttribute = "size",
    kAXParentAttribute = "parent", kAXWindowAttribute = "window", kAXExpandedAttribute = "expanded",
    kAXURLAttribute = "url", kAXDescriptionAttribute = "description", kAXMinValueAttribute = "min",
    kAXMaxValueAttribute = "max", kAXApplicationRole = "AXApplication", kAXWindowRole = "AXWindow",
    kAXMenuRole = "AXMenu", kAXMenuItemRole = "AXMenuItem", kAXPopUpButtonRole = "AXPopUpButton",
    kAXIncrementorRole = "AXIncrementor", kAXTextFieldRole = "AXTextField"
func AXUIElementGetTypeID() -> CFTypeID { CFDictionaryGetTypeID() }
func AXValueGetTypeID() -> CFTypeID { CFArrayGetTypeID() }
func AXValueGetValue(_ v: AXValue, _ type: AXValueType, _ out: UnsafeMutableRawPointer) -> Bool {
    guard v.count == 2, let a = v[0] as? Double, let b = v[1] as? Double else { return false }
    switch type {
    case .cgPoint: out.storeBytes(of: CGPoint(x: a, y: b), as: CGPoint.self)
    case .cgSize: out.storeBytes(of: CGSize(width: a, height: b), as: CGSize.self)
    }
    return true
}
final class ProcessInfo {
    static let processInfo = ProcessInfo()
    var systemUptime: TimeInterval = 1000
}
// The fixture comes from a file named by the environment: bridge.js runs this child with its own argv.
let fixture = try! JSONSerialization.jsonObject(with: FileManager.default.contents(atPath: String(cString: getenv("SHOT2_AX_FIXTURE")!))!) as! NSDictionary
let latency = (fixture["latency"] as? Double) ?? 0
@discardableResult func AXUIElementSetMessagingTimeout(_ e: AXUIElement, _ seconds: Float) -> AXError { .success }
func AXUIElementCopyAttributeValue(_ e: AXUIElement, _ attribute: CFString, _ out: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
    ProcessInfo.processInfo.systemUptime += latency
    if e["unreadable"] as? Bool == true { return .cannotComplete }
    let name = attribute as String, r = e["rect"] as? [Double]
    let v: AnyObject? = name == kAXPositionAttribute ? r.map { [$0[0], $0[1]] as NSArray }
        : name == kAXSizeAttribute ? r.map { [$0[2], $0[3]] as NSArray } : e[name] as AnyObject?
    guard let value = v else { return .noValue }
    out.pointee = value
    return .success
}
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { ["windows": [fixture["window"] as! NSDictionary]] as NSDictionary }
func axWindowNumber(_ w: AXUIElement) -> Int? { w["num"] as? Int }
func AXIsProcessTrusted() -> Bool { true }
func nativeChromeIdentity(pid: pid_t) throws -> String { "direct" }
func CGWindowListCopyWindowInfo(_ option: CGWindowListOption, _ relativeToWindow: CGWindowID) -> CFArray? {
    let b = (fixture["cgBounds"] as? [Double]) ?? [100, 200, 800, 600]
    let row: NSDictionary = [kCGWindowOwnerPID as String: 7, kCGWindowLayer as String: 0, kCGWindowIsOnscreen as String: true,
        kCGWindowBounds as String: CGRect(x: b[0], y: b[1], width: b[2], height: b[3]).dictionaryRepresentation]
    return [row] as NSArray as CFArray
}
// Production code under test.
${block('func emit(')}
${block('func fail(')}
${block('struct NativeInputProbeError:')}
${optional('struct AXProbeBudget {')}
${block('func sameRect(')}
${block('func pageContentBounds(')}
${block('func nativePageContent(')}
${block('final class NativeInputProbe {')}
// A reply exactly as an earlier or other chromectl printed it (old formats, privacy cases).
if let raw = fixture["raw"] as? String { print(raw); exit(0) }
let warm = false
let cmdArgs = Array(CommandLine.arguments.dropFirst())
let cmd = cmdArgs.first ?? ""
${block('if cmd == "axcontent" {')}
fail("usage", "fixture child: axcontent only")
`;
assert.doesNotMatch(program, /import (?:AppKit|ApplicationServices|ScriptingBridge|Carbon)\b/);
const helper = path.join(tmp, 'chromectl');
fs.writeFileSync(path.join(tmp, 'main.swift'), program);
execFileSync('/usr/bin/swiftc', ['-module-cache-path', path.join(tmp, 'cache'), path.join(tmp, 'main.swift'), '-o', helper],
  { stdio: 'pipe', timeout: 300_000 });
const fixtureFile = path.join(tmp, 'fixture.json');
process.env.SHOT2_AX_FIXTURE = fixtureFile;
const setFixture = fixture => fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
/** The child's stdout for axcontent, as the Swift side prints it. */
const swiftReply = () => JSON.parse(execFileSync(helper, ['axcontent', '7', '--window', '5'], { encoding: 'utf8', timeout: 60_000 }));

const WINDOW = [100, 200, 800, 600], PAGE = [100, 300, 800, 500];
const web = () => ({ role: 'AXWebArea', rect: PAGE, children: [{ role: 'AXWebArea', rect: [110, 320, 100, 100] }] });
// `count` browser-chrome nodes ahead of the WebArea, none offering visibleChildren: 3 AX reads each.
function chrome(count) {
  const out = [];
  for (let left = count; left > 0;) {
    const kids = Math.min(40, left - 1), buttons = Array.from({ length: kids }, () => ({ role: 'AXButton' }));
    out.push(kids ? { role: 'AXGroup', children: buttons } : { role: 'AXButton' });
    left -= 1 + kids;
  }
  return out;
}
const win = (children, extra = {}) => ({ num: 5, role: 'AXWindow', rect: WINDOW, children, ...extra });
const nested = (depth, leaf) => depth === 0 ? leaf : { role: 'AXGroup', children: [nested(depth - 1, leaf)] };
const MEDIUM = 1 / 256;   // exact binary fraction per AX message: the simulated clock stays exact
const CAP = { window: win([...chrome(301), web()]) };
const DEADLINE = { window: win([...chrome(300), web()]), latency: MEDIUM };
const DEPTH = { window: win([nested(12, web())]) };

/* ------------------------------------------------ bridge.js and the production callTool */

const bridge = await import('../src/bridge.js');
// Safety: without the helper seam pageContentRect would run the real bin/chromectl, so stop before any call.
assert.match(bridge.pageContentRect.toString(), /\bhelper\b/, 'pageContentRect has no helper seam: refusing to run the real helper');
const idx = await import('../src/index.js');
const { BridgeError } = bridge;
const TARGET = { tabId: 7, windowId: 9, chromePid: 7, cgWindow: 5, tabActive: true, minimized: false,
  url: 'https://fixture.invalid/page', title: 'Fixture', bounds: { left: 100, top: 200, width: 800, height: 600 } };
const notifications = [];
let info = TARGET, captureReached = false;
const probeVia = t => bridge.pageContentRect(t, { helper });
// Fail closed: any entry point not named here throws instead of reaching the user's apps.
const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(name => [name,
  () => { throw new Error(`Unexpected native entry point: ${name}`); }]));
Object.assign(fake, {
  cgevent: async args => {
    assert.deepEqual(args, ['displays']);
    return { ok: true, locked: false, displaysAsleep: false, displays: [{ id: 1 }] };
  },
  chromeInfo: async () => ({ ok: true, ...info }),
  pageDialog: async () => ({ ok: true, open: false }),
  pageScript: async name => `inert ${name}`,
  evalInPage: async (script, tab) => {
    assert.equal(script, 'inert block');
    return { blocked: null, target: { tabId: tab, url: TARGET.url } };
  },
  // The production capture with the production probe; only the child's path differs. Pixels are never read:
  // a proven rect would go on to capture, which fails closed here.
  capturePageContent: target => bridge.capturePageContent(target, { contentProbe: probeVia, screencapture: '/usr/bin/false',
    cg: async () => { captureReached = true; throw new Error('capture reached in a probe-stop test'); } }),
});
idx.__setBridgeForTests(fake);
idx.__recordForTests(false);
idx.__notifyForTests({ send: text => notifications.push(text) });

async function screenshot(fixture, args = { tab: 7 }) {
  setFixture(fixture);
  idx.__resetLedgerForTests();
  idx.__stuckForTests().n = 0;
  captureReached = false;
  const r = await idx.callTool({ params: { name: 'screenshot', arguments: args } }, {});
  assert.equal(captureReached, false, 'a stopped probe must not reach the capture');
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: r.isError === true,
    error: JSON.parse(JSON.stringify(r.structuredContent?.error ?? null)) };
}
const facts = code => ({ code, stage: 'unobserved', inputDelivery: 'unknown' });
const TIMEOUT_TEXT = '❌ 读取网页内容区域失败或超时（Chrome 正忙或页面很复杂），这次没有截图；可以直接重试。';
const CAP_TEXT = '❌ 网页内容区域没能在检查上限内确认，这次没有截图。';
const RETRY_CAP = '给 agent：这是固定的检查上限，原样重试会停在同一上限，不要重试；改用 read_page 读取网页。';
const COUNT_KEYS = ['limit', 'reads', 'maxReads', 'visited', 'maxVisited', 'elapsedMs'];

/* ------------------------------------------------ runner */

const only = process.env.SHOT2_GROUP || null;
const results = [];
async function check(group, name, fn) {
  if (only && only !== group) return;
  try { await fn(); results.push([group, name, null]); console.log(`  ok    [${group}] ${name}`); }
  catch (e) { results.push([group, name, e]); console.log(`  FAIL  [${group}] ${name}\n        ${String(e?.message || e).split('\n').join('\n        ')}`); }
}

/* ------------------------------------------------ kept behaviour (passes before and after SHOT2) */

await check('kept', 'old-format ax_probe_timeout without details: the receipt is exactly the old text', async () => {
  const r = await screenshot({ raw: JSON.stringify({ ok: false, error: 'ax_probe_timeout', message: 'Native target inspection timed out; no input was sent.' }) });
  assert.equal(r.isError, true);
  assert.equal(r.text, TIMEOUT_TEXT);
  assert.deepEqual(r.error, facts('ax_probe_timeout'));
});

await check('kept', 'old-format ax_probe_failed: the receipt is exactly the old text', async () => {
  const r = await screenshot({ raw: JSON.stringify({ ok: false, error: 'ax_probe_failed', message: 'Native target inspection failed (AX -25204); no input was sent.' }) });
  assert.equal(r.text, TIMEOUT_TEXT);
  assert.deepEqual(r.error, facts('ax_probe_failed'));
});

await check('kept', 'old-format page-content cap (db695b0: counts in the message only): rendered as before', async () => {
  const message = '网页内容区域没能在检查上限内确认，这次没有截图（limit=visited reads=903/903 visited=301/300 elapsedMs=0）。';
  const r = await screenshot({ raw: JSON.stringify({ ok: false, error: 'page_content_unavailable', message }) });
  assert.equal(r.text, message);
  assert.deepEqual(r.error, facts('page_content_unavailable'));
});

await check('kept', 'production page_content_unavailable without a limit (window frame differs): the Swift text as before', async () => {
  const r = await screenshot({ window: { ...win([web()]), rect: [100, 200, 900, 600] } });
  assert.equal(r.text, '无法确认目标网页窗口，这次没有截图。');
  assert.deepEqual(r.error, facts('page_content_unavailable'));
});

await check('kept', 'production unreadable tree (ax_probe_failed): the bridge text as before', async () => {
  const r = await screenshot({ window: win([web()], { unreadable: true }) });
  assert.equal(r.text, TIMEOUT_TEXT);
  assert.deepEqual(r.error, facts('ax_probe_failed'));
});

await check('kept', 'wrong_app with identity fields: the message alone, as before', async () => {
  const message = 'The native target is not a verified running Google Chrome process.';
  const r = await screenshot({ raw: JSON.stringify({ ok: false, error: 'wrong_app', message, requestedPid: 7,
    identitySource: 'direct', identityReason: 'wrong_bundle', appFound: true, bundleMissing: false, bundleMatches: false, terminated: false }) });
  assert.equal(r.text, message);
  assert.deepEqual(r.error, facts('wrong_app'));
});

await check('kept', 'an unrelated refusal before the probe (tab_hidden) is unchanged', async () => {
  info = { ...TARGET, tabActive: false };
  try {
    const r = await screenshot({ raw: '{"ok":false,"error":"never_reached","message":"never reached"}' });
    assert.equal(r.text, '❌ 标签 7 在后台（不是它窗口的当前标签），这次没有截图。这个标签在后台：read_page 可以读，screenshot 不会切换标签、也不会接管键鼠；要截图请等该标签显示后再试。');
    assert.deepEqual(r.error, facts('tab_hidden'));
  } finally { info = TARGET; }
});

await check('kept', 'the probe stops themselves are unchanged (SHOT1): codes and Swift messages', async () => {
  setFixture(CAP);
  let s = swiftReply();
  assert.deepEqual([s.ok, s.error, s.message], [false, 'page_content_unavailable',
    '网页内容区域没能在检查上限内确认，这次没有截图（limit=visited reads=903/903 visited=301/300 elapsedMs=0）。']);
  setFixture(DEADLINE);
  s = swiftReply();
  assert.deepEqual([s.ok, s.error, s.message], [false, 'ax_probe_timeout',
    '网页内容区域没能在检查上限内确认，这次没有截图（limit=deadline reads=462/903 visited=153/300 elapsedMs=1801）。']);
});

await check('kept', 'malformed limit fields (unknown limit, text or negative counts) render as before', async () => {
  const base = { ok: false, error: 'ax_probe_timeout', message: 'x', limit: 'deadline', reads: 1, maxReads: 903, visited: 1, maxVisited: 300, elapsedMs: 1801 };
  for (const bad of [{ limit: 'SECRET-TITLE' }, { reads: '462' }, { visited: -1 }, { elapsedMs: 1.5 }, { maxReads: undefined }]) {
    const raw = JSON.stringify({ ...base, ...bad });
    setFixture({ raw });
    await assert.rejects(probeVia({ chromePid: 7, cgWindow: 5 }), e => { assert.equal(e.details, undefined, raw); return true; });
    const r = await screenshot({ raw });
    assert.equal(r.text, TIMEOUT_TEXT, raw);
  }
});

await check('kept', 'a limit paired with the other code renders as before (the deadline is only ax_probe_timeout)', async () => {
  const counts = { reads: 5, maxReads: 903, visited: 2, maxVisited: 300, elapsedMs: 1801 };
  let r = await screenshot({ raw: JSON.stringify({ ok: false, error: 'ax_probe_timeout', message: 'x', limit: 'visited', ...counts }) });
  assert.equal(r.text, TIMEOUT_TEXT);
  r = await screenshot({ raw: JSON.stringify({ ok: false, error: 'page_content_unavailable', message: 'plain', limit: 'deadline', ...counts }) });
  assert.equal(r.text, 'plain');
});

/* ------------------------------------------------ SHOT2 new fix (fails on db695b0) */

await check('new', 'Swift: axcontent forwards the stop details beside code and message', async () => {
  setFixture(CAP);
  const s = swiftReply();
  assert.deepEqual(Object.keys(s).sort(), ['elapsedMs', 'error', 'limit', 'maxReads', 'maxVisited', 'message', 'ok', 'reads', 'visited']);
  assert.deepEqual(COUNT_KEYS.map(k => s[k]), ['visited', 903, 903, 301, 300, 0]);
  setFixture(DEADLINE);
  assert.deepEqual(COUNT_KEYS.map(k => swiftReply()[k]), ['deadline', 462, 903, 153, 300, 1801]);
});

await check('new', 'bridge parse: pageContentRect keeps the limit and counts on the error', async () => {
  setFixture(CAP);
  await assert.rejects(probeVia({ chromePid: 7, cgWindow: 5 }), e => {
    assert.equal(e.code, 'page_content_unavailable');
    assert.deepEqual(e.details, { limit: 'visited', reads: 903, maxReads: 903, visited: 301, maxVisited: 300, elapsedMs: 0 });
    return true;
  });
});

await check('new', 'bridge rebuild: capturePageContent keeps them for the deadline and the cap', async () => {
  for (const [fixture, code, limit] of [[DEADLINE, 'ax_probe_timeout', 'deadline'], [CAP, 'page_content_unavailable', 'visited']]) {
    setFixture(fixture);
    await assert.rejects(fake.capturePageContent({ chromePid: 7, cgWindow: 5 }), e => {
      assert.equal(e.code, code);
      assert.equal(e.details?.limit, limit);
      assert.deepEqual(Object.keys(e.details), COUNT_KEYS);
      return true;
    });
  }
});

await check('new', 'receipt, cap: names the limit with its counts, says a plain retry stops at the same cap, points to read_page', async () => {
  const r = await screenshot(CAP);
  assert.equal(r.isError, true);
  assert.equal(r.text, `${CAP_TEXT}\n检查停在上限 limit=visited（reads=903/903 visited=301/300 elapsedMs=0）。\n${RETRY_CAP}`);
  assert.deepEqual(r.error, facts('page_content_unavailable'));
});

await check('new', 'receipt, depth: the same cap advice, counts as the Swift side printed them', async () => {
  setFixture(DEPTH);
  const s = swiftReply();
  assert.equal(s.limit, 'depth');
  const r = await screenshot(DEPTH);
  assert.equal(r.text, `${CAP_TEXT}\n检查停在上限 limit=depth（reads=${s.reads}/${s.maxReads} visited=${s.visited}/${s.maxVisited} elapsedMs=${s.elapsedMs}）。\n${RETRY_CAP}`);
});

await check('new', 'receipt, deadline: names the deadline with its counts and keeps today\'s retry advice', async () => {
  const r = await screenshot(DEADLINE);
  assert.equal(r.text, `${TIMEOUT_TEXT}\n检查停在时限 limit=deadline（reads=462/903 visited=153/300 elapsedMs=1801）。`);
  assert.doesNotMatch(r.text, /不要重试/);
  assert.deepEqual(r.error, facts('ax_probe_timeout'));
});

await check('new', 'privacy: only the limit name and counts leave the reply; nothing else reaches the receipt', async () => {
  const counts = { limit: 'reads', reads: 904, maxReads: 903, visited: 120, maxVisited: 300, elapsedMs: 12 };
  const raw = JSON.stringify({ ok: false, error: 'page_content_unavailable', message: 'SECRET-MESSAGE',
    ...counts, title: 'SECRET-TITLE', url: 'https://secret.invalid/SECRET-URL', name: 'SECRET-AX-NAME', axName: 'SECRET-AX-NAME' });
  setFixture({ raw });
  await assert.rejects(probeVia({ chromePid: 7, cgWindow: 5 }), e => { assert.deepEqual(e.details, counts); return true; });
  const r = await screenshot({ raw });
  assert.equal(r.text, `${CAP_TEXT}\n检查停在上限 limit=reads（reads=904/903 visited=120/300 elapsedMs=12）。\n${RETRY_CAP}`);
  assert.doesNotMatch(r.text + JSON.stringify(r.error), /SECRET/);
});

/* ------------------------------------------------ summary */

assert.deepEqual(notifications.filter(n => !/AI 好像卡住了/.test(n)), [], 'no other notification');
const failed = results.filter(([, , e]) => e);
for (const g of ['kept', 'new']) {
  const mine = results.filter(([group]) => group === g);
  if (mine.length) console.log(`screenshot-probe-receipt [${g}]: ${mine.length - mine.filter(([, , e]) => e).length}/${mine.length} passed`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
