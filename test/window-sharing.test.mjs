/* Compile the real window-order and dialog scanners against a fake AX/CG snapshot.
 * No browser, display, or input device is accessed by this regression. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const sourcePath = process.env.CHROMECTL_SOURCE || new URL('../src/chromectl.swift', import.meta.url);
const swift = fs.readFileSync(sourcePath, 'utf8');
function productionFunction(name, optional = false) {
  const start = swift.indexOf(`func ${name}(`);
  if (optional && start < 0) return '';
  assert.ok(start >= 0, name);
  return swift.slice(start, swift.indexOf('\n}', start) + 2);
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
let kCGWindowOwnerPID = "pid", kCGWindowLayer = "layer"
let kCGWindowNumber = "num", kCGWindowBounds = "bounds", kCGNullWindowID = 0
let axMessagingTimeout: Float = 1.0
enum AXError { case success, failure, noValue }
func CFGetTypeID(_ value: CFTypeRef) -> Int { value is AXUIElement ? 1 : 0 }
func AXUIElementGetTypeID() -> Int { 1 }
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
    guard let found = e.attrs[key] else { return .failure }
    value = found; return .success
}
struct CGOptions: OptionSet {
    let rawValue: Int
    static let optionOnScreenOnly = CGOptions(rawValue: 1)
    static let excludeDesktopElements = CGOptions(rawValue: 2)
    static let optionAll = CGOptions(rawValue: 4)
}
struct CGRect { init?(dictionaryRepresentation value: NSDictionary) {} }
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
let wins = (fixture["windows"] as? [[String: Any]] ?? []).map { AXUIElement($0) }
let application = AXUIElement([:])
application.attrs[kAXWindowsAttribute] = wins as AnyObject
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { application }
func axWindows(pid: pid_t) -> [AXUIElement] { wins }
func axWindowNumber(_ element: AXUIElement) -> Int? { element.number == 0 ? nil : element.number }
func axFirstTextField(in root: AXUIElement) -> AXUIElement? { nil }
func CGWindowListCopyWindowInfo(_ options: CGOptions, _ number: Int) -> Any? { fixture["cg"] }
${productionFunction('axIsWindowSharingIndicator', true)}
${productionFunction('axIsInputSourceIndicator', true)}
${productionFunction('cgOnScreenOrder')}
${productionFunction('axPageDialog')}
var result: [String: Any] = ["order": cgOnScreenOrder(pid: 7).map { $0.num }]
if let dialog = axPageDialog(pid: 7) {
    result["dialog"] = ["num": dialog.window.number, "buttons": dialog.buttons.map { $0.0 }]
}
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
const button = title => ({ AXRole: 'AXButton', AXTitle: title });
const window = (num, children, extra = {}) => ({
  num, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'Window', children, ...extra,
});
const indicator = () => window(21, [button('WindowSharingSessionButton')]);
const standard = num => window(num, [], { AXSubrole: 'AXStandardWindow' });
const cg = (num, extra = {}) => ({
  num, pid: 7, layer: 0, bounds: { X: 30, Y: 41, Width: 66, Height: 20 }, ...extra,
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

for (const [name, makeWindow] of [
  ['same Window title with an ordinary button', () => window(21, [button('OK')])],
  ['marker button accompanied by dialog text', () => window(21, [button('WindowSharingSessionButton'),
    { AXRole: 'AXStaticText', AXValue: 'An actual prompt' }])],
  ['marker button accompanied by another button', () => window(21, [button('WindowSharingSessionButton'), button('Cancel')])],
  ['marker appears only in the button description', () => window(21, [{ AXRole: 'AXButton', AXDescription: 'WindowSharingSessionButton' }])],
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
