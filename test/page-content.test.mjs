// Compile the production AX content probe (NativeInputProbe, its budget, pageContentBounds and
// nativePageContent) against synthetic trees. Only the AX values, the CG window row and the clock
// are doubles: no Accessibility, window server, screen, UI or Apple Events.
// CHROMECTL_SOURCE points the test at another chromectl.swift (revert proof and mutations).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, after } from 'node:test';

const source = fs.readFileSync(process.env.CHROMECTL_SOURCE || new URL('../src/chromectl.swift', import.meta.url), 'utf8');
const block = prefix => {
  const start = source.indexOf(prefix);
  assert.ok(start >= 0, `missing production code ${prefix}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
// The budget type is SHOT1's; the revert proof compiles the same program against the source before it.
const optional = prefix => source.includes(prefix) ? block(prefix) : '';
const program = `
import Foundation
import CoreGraphics
import CryptoKit
// AX doubles. A synthetic node is a parsed JSON dictionary: a real CF object, so the production
// CFGetTypeID/CFEqual/CFHash calls run unchanged.
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
// The clock: production reads only ProcessInfo.processInfo.systemUptime. Each AX message costs
// the fixture's latency; reading the clock costs nothing.
final class ProcessInfo {
    static let processInfo = ProcessInfo()
    var systemUptime: TimeInterval = 1000
}
let fixture = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! NSDictionary
let latency = (fixture["latency"] as? Double) ?? 0
var axReads = 0, cgCalls = 0
@discardableResult func AXUIElementSetMessagingTimeout(_ e: AXUIElement, _ seconds: Float) -> AXError { .success }
func AXUIElementCopyAttributeValue(_ e: AXUIElement, _ attribute: CFString, _ out: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
    axReads += 1
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
    cgCalls += 1
    let b = (fixture["cgBounds"] as? [Double]) ?? [100, 200, 800, 600]
    let row: NSDictionary = [kCGWindowOwnerPID as String: 7, kCGWindowLayer as String: 0, kCGWindowIsOnscreen as String: true,
        kCGWindowBounds as String: CGRect(x: b[0], y: b[1], width: b[2], height: b[3]).dictionaryRepresentation]
    return [row] as NSArray as CFArray
}
// Production code under test.
${block('struct NativeInputProbeError:')}
${optional('struct AXProbeBudget {')}
${block('func sameRect(')}
${block('func pageContentBounds(')}
${block('func nativePageContent(')}
${block('final class NativeInputProbe {')}
// Driver.
var out: [String: Any] = [:]
do {
    switch fixture["mode"] as! String {
    case "bounds":   // the walk under a default probe: every other probe's budget
        let r = try pageContentBounds(root: fixture["tree"] as! NSDictionary, window: CGRect(x: 100, y: 200, width: 800, height: 600),
                                      probe: NativeInputProbe())
        out = ["ok": true, "rect": [r.minX, r.minY, r.width, r.height]]
    case "content":  // the production page-content entry point (axcontent)
        out = try nativePageContent(pid: 7, expectedWindow: 5)
    case "reads":    // a default probe reading until it stops (a probe without limits is reported, not hung)
        let probe = NativeInputProbe(), node: NSDictionary = ["role": "AXGroup"]
        for _ in 0..<100_000 { _ = try probe.value(node, kAXRoleAttribute) }
        out = ["ok": true, "unbounded": true]
    default: fatalError("mode")
    }
} catch let e as NativeInputProbeError {
    out = ["ok": false, "error": e.code, "message": e.message, "details": e.details]
}
out["axReads"] = axReads
out["cgCalls"] = cgCalls
out["clockMs"] = (ProcessInfo.processInfo.systemUptime - 1000) * 1000
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
`;
assert.doesNotMatch(program, /import (?:AppKit|ApplicationServices|ScriptingBridge|Carbon)\b/);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-page-content-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const swift = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'probe');
fs.writeFileSync(swift, program);
execFileSync('/usr/bin/swiftc', ['-module-cache-path', path.join(tmp, 'cache'), swift, '-o', binary], { stdio: 'pipe', timeout: 300_000 });
const run = input => JSON.parse(execFileSync(binary, { input: JSON.stringify(input), encoding: 'utf8', timeout: 60_000 }));

const WINDOW = [100, 200, 800, 600], PAGE = [100, 300, 800, 500];
const web = () => ({ role: 'AXWebArea', rect: PAGE, children: [{ role: 'AXWebArea', rect: [110, 320, 100, 100] }] });
// `count` browser-chrome nodes ahead of the WebArea (tab strip, toolbar, bookmarks: groups of buttons).
// No node offers visibleChildren unless `visible`, so each costs role + visibleChildren + the children fallback.
function chrome(count, { visible = false } = {}) {
  const out = [];
  for (let left = count; left > 0;) {
    const kids = Math.min(40, left - 1), buttons = Array.from({ length: kids }, () => ({ role: 'AXButton' }));
    out.push(kids ? { role: 'AXGroup', [visible ? 'visibleChildren' : 'children']: buttons } : { role: 'AXButton' });
    left -= 1 + kids;
  }
  return out;
}
const win = (children, extra = {}) => ({ num: 5, role: 'AXWindow', rect: WINDOW, children, ...extra });
const content = (window, latency = 0) => run({ mode: 'content', window, latency });
const nested = (depth, leaf) => depth === 0 ? leaf : { role: 'AXGroup', children: [nested(depth - 1, leaf)] };
// Exact binary fractions keep the simulated clock exact: 1/64 s and 1/256 s per AX message.
const SLOW = 1 / 64, MEDIUM = 1 / 256;

test('kept behaviour (12a4023 and SHOT1 alike)', async t => {
  await t.test('the 9 original synthetic trees, walked under a default probe', () => {
    const page = { role: 'AXWebArea', rect: PAGE, children: [{ role: 'AXWebArea', rect: [110, 320, 100, 100] }] };
    const root = { role: 'AXWindow', children: [{ role: 'AXToolbar', rect: [100, 200, 800, 100] }, page] };
    const bounds = tree => run({ mode: 'bounds', tree });
    assert.deepEqual(bounds(root), { ok: true, rect: page.rect, axReads: 9, cgCalls: 0, clockMs: 0 });
    assert.equal(bounds({ ...root, visibleChildren: [page] }).ok, true);
    assert.deepEqual(bounds({ ...root, visibleChildren: [page] }).rect, page.rect);
    for (const [name, tree] of [
      ['missing web area', { role: 'AXWindow', children: [] }],
      ['two visible web areas', { ...root, children: [page, { ...page, rect: [500, 300, 100, 300] }] }],
      ['unknown frame', { ...root, children: [{ role: 'AXWebArea' }] }],
      ['oversized document frame', { ...root, children: [{ ...page, rect: [100, 300, 800, 5000] }] }],
      ['frame outside window', { ...root, children: [{ ...page, rect: [99, 300, 800, 500] }] }],
      ['whole window is not a proven page crop', { ...root, children: [{ ...page, rect: [100, 200, 800, 600] }] }],
      ['unreadable tree', { ...root, unreadable: true }],
    ]) assert.equal(bounds(tree).ok, false, name);
    assert.equal(bounds({ ...root, unreadable: true }).error, 'ax_probe_failed');
  });

  await t.test('axcontent result: one outer WebArea inside the window, nested frame areas ignored', () => {
    const { axReads, ...r } = content(win([...chrome(20), web()]));
    assert.deepEqual(r, { ok: true, pid: 7, cgWindow: 5, source: 'ax-web-area', cgCalls: 1, clockMs: 0,
      rect: { x: 100, y: 300, w: 800, h: 500 }, windowBounds: { x: 100, y: 200, w: 800, h: 600 } });
    assert.equal(axReads, 3 + 3 * 22);
    for (const [name, window] of [
      ['two outer web areas', win([web(), { ...web(), rect: [500, 300, 100, 300] }])],
      ['web area outside the window', win([{ ...web(), rect: [100, 300, 800, 501] }])],
      ['window frame differs from the CG window', { ...win([web()]), rect: [100, 200, 900, 600] }],
    ]) assert.equal(content(window).error, 'page_content_unavailable', name);
  });

  await t.test('depth 12: a WebArea 12 levels below the window is found, 13 is refused', () => {
    assert.equal(content(win([nested(11, web())])).ok, true);
    assert.equal(content(win([nested(12, web())])).error, 'page_content_unavailable');
  });

  await t.test('every other probe keeps 220 reads, with its old code and text', () => {
    const r = run({ mode: 'reads' });
    assert.equal(r.axReads, 220);
    assert.equal(r.error, 'ax_probe_timeout');
    assert.equal(r.message, 'Native target inspection timed out; no input was sent.');
  });

  await t.test('the 1.8 s deadline: at 1/64 s per AX message exactly 116 messages are sent, then ax_probe_timeout', () => {
    // The check before message n passes while (n - 1) / 64 < 1.8, so n <= 116.
    const other = run({ mode: 'reads', latency: SLOW });
    assert.deepEqual([other.error, other.axReads, other.clockMs], ['ax_probe_timeout', 116, 1812.5]);
    const page = content(win([...chrome(60), web()]), SLOW);
    assert.deepEqual([page.error, page.axReads, page.clockMs], ['ax_probe_timeout', 116, 1812.5]);
  });
});

test('SHOT1 new fix: page-content bounds stop on their own limits and name them (fails on 12a4023)', async t => {
  // nativePageContent reads 3 values (window list, window position and size), then each visited node
  // costs at most 3: role + visibleChildren + the children fallback (a WebArea: role + position + size).
  const reads = visited => 3 + 3 * visited;

  await t.test('calibration: the ~300-node trees below fail under the old caps (220 reads, 120 nodes)', () => {
    for (const visible of [false, true]) {
      const r = run({ mode: 'bounds', tree: win([...chrome(298, { visible }), web()]) });
      assert.equal(r.ok, false);
      assert.equal(r.axReads, 220, 'the old read cap trips before the old 120-node cap');
    }
  });

  await t.test('300 visited nodes with the children fallback everywhere pass, using exactly 903 reads', () => {
    const r = content(win([...chrome(298), web()]));   // window + 298 + WebArea = 300 nodes
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.rect, { x: 100, y: 300, w: 800, h: 500 });
    assert.equal(r.axReads, reads(300));
    assert.equal(r.axReads, 903);
  });

  await t.test('300 nodes where groups offer visibleChildren pass with fewer reads', () => {
    const r = content(win([...chrome(298, { visible: true }), web()]));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.axReads < 903, String(r.axReads));
  });

  await t.test('one node more stops on the node cap, named with its counts; it is not a timeout', () => {
    const r = content(win([...chrome(299), web()]));
    assert.equal(r.error, 'page_content_unavailable');
    assert.deepEqual(r.details, { limit: 'visited', reads: 903, maxReads: 903, visited: 301, maxVisited: 300, elapsedMs: 0 });
    assert.match(r.message, /这次没有截图/);
    assert.match(r.message, /limit=visited reads=903\/903 visited=301\/300 elapsedMs=0/);
    assert.equal(r.axReads, 903);
  });

  await t.test('an oversized tree (1,000 nodes) still fails, on the node cap', () => {
    for (const visible of [false, true]) {
      const r = content(win([...chrome(1000, { visible }), web()]));
      assert.equal(r.error, 'page_content_unavailable');
      assert.equal(r.details.limit, 'visited');
      assert.equal(r.details.visited, 301);
      assert.ok(r.details.reads <= 903 && r.details.reads === r.axReads);
    }
  });

  await t.test('the deadline still fails as ax_probe_timeout, named with its counts', () => {
    // At 1/256 s per message the check before message n passes while (n - 1) / 256 < 1.8, so n <= 461.
    const r = content(win([...chrome(298), web()]), MEDIUM);
    assert.equal(r.error, 'ax_probe_timeout');
    assert.equal(r.axReads, 461);
    assert.deepEqual(r.details, { limit: 'deadline', reads: 462, maxReads: 903, visited: 153, maxVisited: 300, elapsedMs: 1801 });
    assert.match(r.message, /limit=deadline reads=462\/903 visited=153\/300 elapsedMs=1801/);
  });

  await t.test('the depth limit is named too', () => {
    const r = content(win([nested(12, web())]));
    assert.equal(r.error, 'page_content_unavailable');
    assert.equal(r.details.limit, 'depth');
    assert.match(r.message, /limit=depth /);
  });

  await t.test('every other probe: same code and text, and the detail says which limit', () => {
    const cap = run({ mode: 'reads' });
    assert.deepEqual(cap.details, { limit: 'reads', reads: 221, maxReads: 220, visited: 0, maxVisited: 120, elapsedMs: 0 });
    const late = run({ mode: 'reads', latency: SLOW });
    assert.deepEqual(late.details, { limit: 'deadline', reads: 117, maxReads: 220, visited: 0, maxVisited: 120, elapsedMs: 1813 });
  });
});
