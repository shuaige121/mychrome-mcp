/* Compile the real window-order and dialog scanners against a fake AX/CG snapshot.
 * No browser, display, or input device is accessed by this regression. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const sourcePath = process.env.CHROMECTL_SOURCE || new URL('../src/chromectl.swift', import.meta.url);
const nativePath = process.env.NATIVE_CHROME_SOURCE || new URL('../src/native-chrome.swift', import.meta.url);
const swift = fs.readFileSync(nativePath, 'utf8').replaceAll('static func ', 'func ') + '\n' + fs.readFileSync(sourcePath, 'utf8');
function productionFunction(name, optional = false) {
  const start = swift.indexOf(`func ${name}(`);
  if (optional && start < 0) return '';
  assert.ok(start >= 0, name);
  return swift.slice(start, swift.indexOf('\n}', start) + 2);
}
// A method of the native activate transaction (8-space indent), compiled unchanged.
function productionMethod(name) {
  const start = swift.indexOf(`\n        func ${name}(`);
  assert.ok(start >= 0, name);
  return swift.slice(start + 1, swift.indexOf('\n        }', start + 1) + 10);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-window-sharing-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const program = `
import Foundation
typealias CFTypeRef = AnyObject
typealias CFString = String
typealias CFDictionary = NSDictionary
let kAXWindowsAttribute = "AXWindows", kAXSubroleAttribute = "AXSubrole"
let kAXRoleAttribute = "AXRole", kAXTitleAttribute = "AXTitle"
let kAXDescriptionAttribute = "AXDescription", kAXValueAttribute = "AXValue"
let kAXChildrenAttribute = "AXChildren", kAXStandardWindowSubrole = "AXStandardWindow"
let kAXModalAttribute = "AXModal", kAXFocusedAttribute = "AXFocused", kAXMainAttribute = "AXMain"
let kAXFocusedWindowAttribute = "AXFocusedWindow"
let kAXDialogSubrole = "AXDialog", kAXWindowRole = "AXWindow"
let kAXButtonRole = "AXButton", kAXStaticTextRole = "AXStaticText"
let kAXTextFieldRole = "AXTextField", kAXTextAreaRole = "AXTextArea"
let kCGWindowOwnerPID = "pid", kCGWindowLayer = "layer"
let kCGWindowNumber = "num", kCGWindowBounds = "bounds", kCGNullWindowID = 0
let kCGWindowOwnerName = "owner", kCGWindowAlpha = "alpha"
let axMessagingTimeout: Float = 1.0
enum AXError: Int32 { case success = 0, failure = -25200, invalidUIElement = -25202, cannotComplete = -25204, attributeUnsupported = -25205, noValue = -25212 }
// NAT-RETRY: axPageDialog's rescan reads the owner's first failure (none here).
var firstFailure: Error? = nil, axRetries = 0, axLastError: Int? = nil
func CFGetTypeID(_ value: CFTypeRef) -> Int { value is AXUIElement ? 1 : 0 }
func AXUIElementGetTypeID() -> Int { 1 }
func CFEqual(_ a: AXUIElement, _ b: AXUIElement) -> Bool { a === b }
func CFHash(_ a: AXUIElement) -> Int { a.number }
final class AXUIElement {
    var attrs: [String: AnyObject]
    let number: Int
    init(_ row: [String: Any]) {
        number = row["num"] as? Int ?? 0
        attrs = [:]
        for (key, value) in row where key != "children" && key != "num" { attrs[key] = value as AnyObject }
        if let children = row["children"] as? [[String: Any]] {
            attrs[kAXChildrenAttribute] = children.map { AXUIElement($0) } as AnyObject
        }
    }
}
func AXUIElementSetMessagingTimeout(_ e: AXUIElement, _ timeout: Float) {}
func AXUIElementCopyAttributeValue(_ e: AXUIElement, _ key: String, _ value: inout CFTypeRef?) -> AXError {
    if key == "AXSheets" && e.attrs[key] == nil { return .attributeUnsupported }
    guard let found = e.attrs[key] else { return .failure }
    value = found; return .success
}
struct CGOptions: OptionSet {
    let rawValue: Int
    static let optionOnScreenOnly = CGOptions(rawValue: 1)
    static let excludeDesktopElements = CGOptions(rawValue: 2)
    static let optionAll = CGOptions(rawValue: 4)
}
struct CGRect {
    let x: Double, y: Double, width: Double, height: Double
    init?(dictionaryRepresentation value: NSDictionary) {
        func v(_ key: String) -> Double { (value[key] as? NSNumber)?.doubleValue ?? 0 }
        x = v("X"); y = v("Y"); width = v("Width"); height = v("Height")
    }
    func intersects(_ o: CGRect) -> Bool { x < o.x + o.width && o.x < x + width && y < o.y + o.height && o.y < y + height }
}
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
// pid -1 stands for this process (the input helper's own veil window in production).
let cgRows: [[String: Any]] = (fixture["cg"] as? [[String: Any]] ?? []).map { row in
    var r = row; if r["pid"] as? Int == -1 { r["pid"] = Int(getpid()) }; return r
}
let wins = (fixture["windows"] as? [[String: Any]] ?? []).map { AXUIElement($0) }
let application = AXUIElement([:])
application.attrs[kAXWindowsAttribute] = wins as AnyObject
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { application }
func axWindows(pid: pid_t) -> [AXUIElement] { wins }
func axWindowNumber(_ element: AXUIElement) -> Int? { element.number == 0 ? nil : element.number }
func CGWindowListCopyWindowInfo(_ options: CGOptions, _ number: Int) -> Any? { fixture["cg"] == nil ? nil : cgRows }
${productionFunction('axIsWindowSharingIndicator', true)}
${productionFunction('axIsInputSourceIndicator', true)}
${productionFunction('axIsChromeTranslationBubble', true)}
${productionFunction('cgOnScreenOrder')}
${productionFunction('focusTopWindowMatches')}
${swift.slice(swift.indexOf('struct DialogFailure:'), swift.indexOf('func dialogInt('))}
enum ChromeNative { ${productionFunction('promptText').replace('func promptText(', 'static func promptText(')} }
// PERM1: the permission-prompt exclusion is exercised by test/perm-prompt.test.mjs; inert here.
func axIsChromePermissionPrompt(_ w: AXUIElement, pid: pid_t) -> Bool { false }
${productionFunction('axPageDialog')}
${productionFunction('axRetryPause')}
struct Failure: Error { let code: String; init(_ code: String, _ stage: String) { self.code = code } }
struct Target { let chromePid: Int32; let cgWindow: Int }
final class FrontApp {
    let processIdentifier: Int32, localizedName: String?
    init(_ pid: Int32, _ name: String?) { processIdentifier = pid; localizedName = name }
}
final class NSWorkspace { static let shared = NSWorkspace(); var frontmostApplication: FrontApp? }
let sharingIndicator: (AXUIElement) -> Bool = { axIsWindowSharingIndicator($0) }
let windowNumber: (AXUIElement) -> Int? = { axWindowNumber($0) }
let copyAttribute: (AXUIElement, String, inout CFTypeRef?) -> AXError = { AXUIElementCopyAttributeValue($0, $1, &$2) }
final class FocusProbe {
    func check() throws {}
    func AXUIElementCopyAttributeValue(_ e: AXUIElement, _ key: String, _ value: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
        copyAttribute(e, key, &value.pointee)
    }
    func CGWindowListCopyWindowInfo(_ options: CGOptions, _ number: Int) -> Any? { fixture["cg"] == nil ? nil : cgRows }
    func axWindows(pid: pid_t) -> [AXUIElement] { wins }
    func axIsWindowSharingIndicator(_ w: AXUIElement) -> Bool { sharingIndicator(w) }
    func axWindowNumber(_ w: AXUIElement) -> Int? { windowNumber(w) }
}
final class FocusOwner {
    func probe() -> FocusProbe { FocusProbe() }
    func probe(until deadline: Double) -> FocusProbe { FocusProbe() }
    func requireAlive(_ stage: String) throws {}
${productionMethod('focus')}
}
var result: [String: Any] = ["order": cgOnScreenOrder(pid: 7).map { $0.num }]
if let target = fixture["focusTarget"] as? Int {
    result["focusOnTop"] = focusTopWindowMatches(pid: 7, cg: target, remaining: 1)
}
if let focus = fixture["exactFocus"] as? [String: Any] {
    let front = focus["front"] as? Int ?? 7
    NSWorkspace.shared.frontmostApplication = FrontApp(Int32(front), focus["frontName"] as? String)
    if let f = focus["focused"] as? Int { application.attrs[kAXFocusedWindowAttribute] = wins.first { $0.number == f } }
    do {
        let r = try FocusOwner().focus(Target(chromePid: 7, cgWindow: focus["target"] as? Int ?? 0))
        result["exactFocus"] = ["onTop": r.0, "key": r.1, "front": r.2, "details": r.3]
    } catch let e as Failure { result["exactFocus"] = ["error": e.code] }
}
do {
    if let dialog = try axPageDialog(pid: 7) {
        result["dialog"] = ["num": dialog.window.number, "buttons": dialog.buttons.map { $0.0 }]
    }
} catch let e as DialogFailure { result["error"] = e.code }
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`;
const source = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'window-sharing');
fs.writeFileSync(source, program);
execFileSync('/usr/bin/swiftc', [source, '-o', binary], { stdio: 'pipe' });
const run = fixture => {
  const r = spawnSync(binary, [JSON.stringify(fixture)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const button = title => ({ AXRole: 'AXButton', AXTitle: title, children: [] });
const window = (num, children, extra = {}) => ({
  num, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'Window', children, ...extra,
});
const indicator = () => window(21, [button('WindowSharingSessionButton')]);
const standard = num => window(num, [], { AXSubrole: 'AXStandardWindow' });
const cg = (num, extra = {}) => ({
  num, pid: 7, layer: 0, bounds: { X: 30, Y: 41, Width: 66, Height: 20 }, ...extra,
});

const translationBubble = () => window(41, [{
  AXRole: 'AXGroup', AXSubrole: 'AXApplicationAlertDialog', AXTitle: '翻译此页？', children: [
    { AXRole: 'AXTabGroup', children: [
      { AXRole: 'AXRadioButton', AXSubrole: 'AXTabButton', AXTitle: '英语', children: [] },
      { AXRole: 'AXRadioButton', AXSubrole: 'AXTabButton', AXTitle: '中文（简体）', children: [] },
    ] },
    { ...button('翻译选项'), children: [] }, { ...button('关闭'), children: [] },
  ],
}], { AXSubrole: 'AXUnknown', AXTitle: '翻译此页？', AXModal: false, AXFocused: false, AXMain: false });

test('unfocused Chrome translation bubble does not block reads; foreground protection remains', () => {
  const r = run({ focusTarget: 11, windows: [translationBubble(), standard(11)], cg: [cg(41), cg(11)] });
  assert.deepEqual(r, { order: [41, 11], focusOnTop: false });
});

test('real page dialog behind a translation bubble is still detected', () => {
  const r = run({ windows: [translationBubble(), window(31, [button('OK')]), standard(11)], cg: [] });
  assert.deepEqual(r.dialog, { num: 31, buttons: ['OK'] });
});

test('translation title alone, modal/focused bubbles, extra controls and incomplete AX trees stay protected', () => {
  const cases = [
    w => { w.children[0].children.shift(); },
    w => { w.AXModal = true; }, w => { w.AXFocused = true; }, w => { w.AXMain = true; },
    w => { delete w.AXModal; }, w => { w.AXTitle = 'Unknown dialog'; },
    w => { w.children[0].children.push({ AXRole: 'AXTextField', children: [] }); },
    w => { w.children[0].children.push({ AXRole: 'AXStaticText', AXValue: 'An actual prompt', children: [] }); },
    w => { w.children[0].children.push({ ...button('OK'), children: [] }); },
    w => { delete w.children[0].children[0].children; },
    w => { w.children[0].children[0].children.pop(); },
    w => { w.children[0].children[0].children[0].AXSubrole = 'AXRadioButton'; },
  ];
  for (const mutate of cases) {
    const w = translationBubble(); mutate(w);
    const r = run({ windows: [w], cg: [] });
    assert.ok(r.dialog?.num === 41 || r.error === 'dialog_probe_unknown', JSON.stringify(r));
  }
});

test('recording indicator is neither the front content window nor a page dialog', () => {
  assert.deepEqual(run({ windows: [indicator(), standard(11)], cg: [cg(21), cg(11)] }), { order: [11] });
});

test('real dialog behind the indicator remains detectable and blocks window order', () => {
  const r = run({
    windows: [indicator(), window(31, [button('OK')]), standard(11)],
    cg: [cg(21), cg(31), cg(11)],
  });
  assert.deepEqual(r, { order: [31, 11], dialog: { num: 31, buttons: ['OK'] } });
});

test('another standard Chrome window remains ahead of the target', () => {
  assert.deepEqual(run({
    windows: [indicator(), standard(12), standard(11)],
    cg: [cg(21), cg(12), cg(11)],
  }), { order: [12, 11] });
});

test('bounded final focus still accepts the verified recording indicator', () => {
  const r = run({ focusTarget: 11, windows: [indicator(), standard(11)], cg: [cg(21), cg(11)] });
  assert.equal(r.focusOnTop, true);
});

test('bounded final focus rejects a real dialog or an unknown layer-zero overlay', () => {
  for (const windows of [[window(21, [button('OK')]), standard(11)], [standard(11)]]) {
    const r = run({ focusTarget: 11, windows, cg: [cg(21), cg(11)] });
    assert.equal(r.focusOnTop, false);
  }
});

for (const [name, makeWindow] of [
  ['same Window title with an ordinary button', () => window(21, [button('OK')])],
  ['marker button accompanied by dialog text', () => window(21, [button('WindowSharingSessionButton'),
    { AXRole: 'AXStaticText', AXValue: 'An actual prompt', children: [] }])],
  ['marker button accompanied by another button', () => window(21, [button('WindowSharingSessionButton'), button('Cancel')])],
  ['marker appears only in the button description', () => window(21, [{ AXRole: 'AXButton', AXTitle: '', AXDescription: 'WindowSharingSessionButton', children: [] }])],
  ['different window title', () => window(21, [button('WindowSharingSessionButton')], { AXTitle: 'Confirm' })],
  ['different window role', () => window(21, [button('WindowSharingSessionButton')], { AXRole: 'AXSheet' })],
  ['different window subrole', () => window(21, [button('WindowSharingSessionButton')], { AXSubrole: 'AXSystemDialog' })],
]) {
  test(`${name} is not silently exempted`, () => {
    const r = run({ windows: [makeWindow(), standard(11)], cg: [cg(21), cg(11)] });
    assert.deepEqual(r.order, [21, 11]);
    assert.equal(r.dialog?.num, 21);
  });
}

test('an unreadable AX structure does not exempt its CG window', () => {
  const unreadable = indicator(); delete unreadable.children;
  assert.deepEqual(run({ windows: [unreadable, standard(11)], cg: [cg(21), cg(11)] }).order, [21, 11]);
});

test('unknown CG windows and different owners keep their existing treatment', () => {
  assert.deepEqual(run({
    windows: [indicator(), standard(11)],
    cg: [cg(21), cg(99), cg(11), cg(41, { pid: 8 }), cg(42, { layer: 3 })],
  }).order, [99, 11]);
});

// Activate transaction's exact-focus check: the real focus(_:) method and decision, fake CG/AX rows.
const box = (X, Y, Width, Height) => ({ X, Y, Width, Height });
const row = (num, bounds, extra = {}) => cg(num, { bounds, owner: 'Google Chrome', alpha: 1, ...extra });
const target = () => row(11, box(0, 30, 1200, 800), { title: 'Private target title' });
const focusCheck = (rows, { windows = [standard(11)], front = 7, frontName = 'Google Chrome', focused = 11 } = {}) => {
  const r = run({ windows, cg: rows, exactFocus: { target: 11, front, frontName, focused } }).exactFocus;
  assert.deepEqual(Object.keys(r.details).sort(), ['focusBlocker', 'frontmost', 'frontmostPid', 'keyWindowIsTarget', 'targetOnTop']);
  assert.doesNotMatch(JSON.stringify(r), /Private|title/i, 'diagnostics never carry a window title');
  return r;
};

test('Chrome-own windows under 100 pt above the target do not fail exact focus', () => {
  for (const small of [box(0, 812, 240, 20), box(1100, 40, 80, 300), box(500, 500, 100, 99), box(500, 500, 99, 100)]) {
    const r = focusCheck([row(51, small), target()]);
    assert.deepEqual([r.onTop, r.key, r.details.targetOnTop, r.details.focusBlocker], [true, true, true, null], JSON.stringify(small));
  }
  const r = focusCheck([row(51, box(0, 812, 240, 20)), row(52, box(40, 60, 90, 24)), target()]);
  assert.equal(r.onTop, true);
});

test('a normal-size Chrome window above the target is still rejected and named', () => {
  const r = focusCheck([row(12, box(100, 100, 800, 600), { title: 'Private other title' }), target()]);
  assert.equal(r.onTop, false);
  assert.deepEqual(r.details, { targetOnTop: false, keyWindowIsTarget: true, frontmost: 'Google Chrome', frontmostPid: 7,
    focusBlocker: { owner: 'Google Chrome', pid: 7, layer: 0, width: 800, height: 600 } });
});

test('exactly 100 x 100 pt is not exempt; the rule is width < 100 or height < 100', () => {
  const r = focusCheck([row(13, box(0, 0, 100, 100)), target()]);
  assert.equal(r.onTop, false);
  assert.deepEqual(r.details.focusBlocker, { owner: 'Google Chrome', pid: 7, layer: 0, width: 100, height: 100 });
});

test('a real Chrome dialog window above the target is still rejected', () => {
  const r = focusCheck([row(21, box(400, 300, 420, 180)), target()], { windows: [window(21, [button('OK')]), standard(11)] });
  assert.equal(r.onTop, false);
  assert.deepEqual(r.details.focusBlocker, { owner: 'Google Chrome', pid: 7, layer: 0, width: 420, height: 180 });
});

test('the verified sharing indicator stays exempt at any size', () => {
  assert.equal(focusCheck([row(21, box(0, 0, 300, 200)), target()], { windows: [indicator(), standard(11)] }).onTop, true);
});

test('another app in front is rejected and its covering window is named, not the veil or system layers', () => {
  const r = focusCheck([
    { num: 90, pid: -1, layer: 0, owner: 'cgevent', alpha: 1, bounds: box(0, 0, 3000, 2000) },
    { num: 91, pid: 60, layer: 24, owner: 'Window Server', alpha: 1, bounds: box(0, 0, 3000, 24) },
    { num: 92, pid: 61, layer: 20, owner: 'Dock', alpha: 1, bounds: box(0, 0, 3000, 2000) },
    { num: 93, pid: 55, layer: 0, owner: 'Example App', alpha: 1, bounds: box(2000, 0, 300, 300) },
    { num: 94, pid: 55, layer: 0, owner: 'Example App', alpha: 1, bounds: box(200, 200, 640, 480), title: 'Private app title' },
    target(),
  ], { front: 55, frontName: 'Example App' });
  assert.equal(r.onTop, false);
  assert.deepEqual(r.details, { targetOnTop: false, keyWindowIsTarget: true, frontmost: 'Example App', frontmostPid: 55,
    focusBlocker: { owner: 'Example App', pid: 55, layer: 0, width: 640, height: 480 } });
});

test('a small window of another process is not exempt as Chrome-own when that app is in front', () => {
  const r = focusCheck([{ num: 95, pid: 55, layer: 0, owner: 'Example App', alpha: 1, bounds: box(10, 40, 80, 30) }, target()],
    { front: 55, frontName: 'Example App' });
  assert.equal(r.onTop, false);
  assert.deepEqual(r.details.focusBlocker, { owner: 'Example App', pid: 55, layer: 0, width: 80, height: 30 });
});

test('only this Chrome process enters the order decision (other apps stay with the point guard, as before)', () => {
  for (const other of [box(200, 200, 640, 480), box(10, 40, 80, 30)]) {
    const r = focusCheck([{ num: 96, pid: 55, layer: 0, owner: 'Example App', alpha: 1, bounds: other }, target()]);
    assert.deepEqual([r.onTop, r.details.focusBlocker], [true, null], JSON.stringify(other));
  }
});

test('the activate refusal carries the focus detail set unchanged', () => {
  // This pins its one-line hand-off; the transaction body runs offline in window-visibility-native (FOCUS1: the
  // last bounded settle sample is reported, see runFocusSettle there). FOCUS4: only a wrong active tab refuses; the
  // detail set is the same sample's (after the Apple Event fallback when it ran), plus axWindowMissing and the verdict word.
  const native = fs.readFileSync(nativePath, 'utf8');
  assert.match(native, /var focusState = kind == "activate" \? try settleFocus\(t, until: focusSettleUntil \?\? 0\) : \(false, false, 0, \[:\]\)\n/);
  assert.match(native, /\n\s+if kind == "activate" && after\.activeTab != t\.tabId \{\n\s+throw Failure\("activate_unconfirmed", "activate_verify", details: focusState\.3\.merging\(\n\s+\["axWindowMissing": axWindowMissing, "focusVerdict": "tab_not_current"\]/);
});
