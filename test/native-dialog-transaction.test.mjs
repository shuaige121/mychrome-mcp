/* Compile the production native binding/transaction against synthetic evidence only.
 * No Chrome process, AX query, Apple Event, activation, field or hardware is accessed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';

const swift = fs.readFileSync(process.env.NATIVE_CHROME_SOURCE || new URL('../src/native-chrome.swift', import.meta.url), 'utf8').replaceAll('static func ', 'func ');
const fn = name => {
  const start = swift.indexOf(`func ${name}(`);
  assert.ok(start >= 0, name);
  return swift.slice(start, swift.indexOf('\n}', start) + 2);
};
const model = swift.slice(swift.indexOf('struct DialogFailure:'), swift.indexOf('struct ChromeWin'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-dialog-transaction-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const source = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'dialog');
fs.writeFileSync(source, `import Foundation
import CoreGraphics
import CryptoKit
typealias CFTypeRef = AnyObject
let kAXWindowsAttribute = "AXWindows", kAXSubroleAttribute = "AXSubrole", kAXStandardWindowSubrole = "AXStandardWindow"
let kAXMinimizedAttribute = "AXMinimized", kAXWindowAttribute = "AXWindow", kAXParentAttribute = "AXParent"
let kAXRoleAttribute = "AXRole", kAXApplicationRole = "AXApplication"
let kCGWindowNumber = "num", kCGWindowOwnerPID = "pid", kCGWindowLayer = "layer", kCGWindowIsOnscreen = "onScreen", kCGWindowBounds = "bounds"
let kCGNullWindowID = 0
final class AXUIElement {
    let number: Int
    var attrs: [String: Any]
    let rect: CGRect?
    init(_ row: [String: Any]) { number = row["cgWindow"] as? Int ?? 0; attrs = row; rect = readRect(row["rect"]) }
}
func CFGetTypeID(_ value: AnyObject) -> Int { value is AXUIElement ? 1 : ((value as? NSNumber).map { String(cString: $0.objCType) == "c" ? 2 : 3 } ?? 0) }
func CFBooleanGetTypeID() -> Int { 2 }
func AXUIElementGetTypeID() -> Int { 1 }
func CFEqual(_ a: AXUIElement, _ b: AXUIElement) -> Bool { a === b }
func readRect(_ value: Any?) -> CGRect? {
    guard let raw = value as? [Any], raw.count == 4 else { return nil }
    let a = raw.compactMap { ($0 as? NSNumber)?.doubleValue }
    guard a.count == 4 else { return nil }
    return CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
}
extension CGRect {
    init?(dictionaryRepresentation value: NSDictionary) {
        guard let x = value["X"] as? Double, let y = value["Y"] as? Double, let w = value["Width"] as? Double, let h = value["Height"] as? Double else { return nil }
        self.init(x: x, y: y, width: w, height: h)
    }
}
struct CGOptions: OptionSet { let rawValue: Int; static let optionAll = CGOptions(rawValue: 1) }
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
let app = AXUIElement([:])
let dialog = AXUIElement(["cgWindow": 21, "rect": [100,100,200,100], "AXSubrole": "AXDialog"])
let windowRows = fixture["windows"] as? [[String: Any]] ?? [["cgWindow": 11, "rect": [0,0,800,600], "AXSubrole": "AXStandardWindow", "AXMinimized": false]]
let wins = windowRows.map { AXUIElement($0) } + [dialog]
app.attrs["AXWindows"] = wins
if let n = fixture["attachment"] as? Int { dialog.attrs["AXParent"] = wins.first { $0.number == n } ?? AXUIElement(["cgWindow": n]) }
func axWindowNumber(_ e: AXUIElement) -> Int? { e.number > 0 ? e.number : nil }
func axRect(_ e: AXUIElement) -> CGRect? { e.rect }
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { app }
func dialogAX(_ e: AXUIElement, _ key: String, optional: Bool = false) throws -> CFTypeRef? {
    if fixture["unreadableAttribute"] as? String == key { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding") }
    if let value = e.attrs[key] { return value as AnyObject }
    if optional { return nil }
    throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding")
}
func CGWindowListCopyWindowInfo(_ o: CGOptions, _ n: Int) -> Any? {
    if fixture["missingCG"] as? Bool == true { return nil }
    return fixture["cg"] ?? [
      ["num": 21,"pid": 7,"layer": 1,"onScreen": true,"bounds": ["X": 100,"Y": 100,"Width": 200,"Height": 100]],
      ["num": 11,"pid": 7,"layer": 0,"onScreen": true,"bounds": ["X": 0,"Y": 0,"Width": 800,"Height": 600]]]
}
final class ErrorCatcher { var last: String? = nil }
final class SBObject {
    let row: [String: Any]
    init(_ r: [String: Any]) { row = r }
    func value(forKey key: String) -> Any? {
        if key == "bounds" { return readRect(row["rect"]).map { NSValue(rect: $0) } }
        if key == "activeTab" { return (row["tabId"] as? Int).map { SBObject(["id": $0]) } }
        return row[key]
    }
}
final class SBElementArray {
    let rows = fixture["chrome"] as? [[String: Any]] ?? [["id": 1, "tabId": 9, "rect": [0,0,800,600], "minimized": false]]
    func value(forKey key: String) -> Any? { rows.map { $0[key] ?? NSNull() } }
    func object(withID id: String) -> Any? { rows.first { String($0["id"] as? Int ?? 0) == id }.map { SBObject($0) } }
}
final class SBApplication {
    var delegate: ErrorCatcher?
    init?(processIdentifier: pid_t) { if fixture["missingSB"] as? Bool == true { return nil }; assert(processIdentifier == 7) }
    func value(forKey key: String) -> Any? { if fixture["appleEventFailure"] as? Bool == true { delegate?.last = "synthetic failure"; return nil }; return SBElementArray() }
}
${model}
enum ChromeNative { ${['promptOrigin', 'dialogInt'].map(name => fn(name).replace(`func ${name}(`, `static func ${name}(`)).join('\n')} }
struct WindowRow { let id: Int, activeTab: Int, bounds: CGRect, minimized: Bool; let tabs: [Int]; let tabURLs: [Int: String] }
func snapshot(_ pid: pid_t) throws -> [WindowRow] {
    if fixture["missingSB"] as? Bool == true || fixture["appleEventFailure"] as? Bool == true { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding") }
    let rows = fixture["chrome"] as? [[String: Any]] ?? [["id": 1, "tabId": 9, "rect": [0,0,800,600], "minimized": false]]
    return try rows.map { row in
        guard let id = row["id"] as? Int, id > 0, let tab = row["tabId"] as? Int, tab > 0,
              let rect = readRect(row["rect"]), let minimized = row["minimized"] as? Bool else {
            throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding")
        }
        return WindowRow(id: id, activeTab: tab, bounds: rect, minimized: minimized, tabs: [tab], tabURLs: [tab: row["url"] as? String ?? "https://fixture.test/"])
    }
}
${['num', 'sameRect', 'bindDialog', 'answerPageDialog', 'inspectBoundDialog'].map(fn).join('\n')}
func axPageDialog(pid: pid_t) throws -> PageDialog? {
    if fixture["gone"] as? Bool == true { return nil }
    if fixture["scanError"] as? Bool == true { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect") }
    return PageDialog(title: "test", texts: [], buttons: [("OK", dialog)], fields: [dialog], window: dialog, descriptor: ["stable"])
}
var result: [String: Any] = [:], effects: [String] = [], inspections = 0
let target: [String: Any]? = fixture["untargeted"] as? Bool == true ? nil : (fixture["target"] as? [String: Any] ?? ["chromePid": 7, "tabId": 9, "windowId": 1, "cgWindow": 11])
do {
    if fixture["mode"] as? String == "failure_projection" {
        result = DialogFailure(code: fixture["code"] as? String ?? "dialog_probe_unknown", stage: fixture["stage"] as? String ?? "dialog_inspect",
            dialogProbePoint: DialogFailure.ProbePoint(rawValue: fixture["point"] as? String ?? ""),
            axRetries: fixture["axRetries"] as? Int, axError: fixture["axError"] as? Int).json
    } else if fixture["mode"] as? String == "options" {
        let options = try dialogOptions(fixture["args"] as? [String] ?? [])
        result = ["ok": true, "textMatches": options["--text"] == fixture["expectedText"] as? String, "buttonMatches": options["--press"] == fixture["expectedButton"] as? String]
    } else if fixture["mode"] as? String == "identity" {
        result = ["ok": true, "identity": try dialogIdentity(fixture["identity"] as? [String: Any] ?? [:]).json]
    } else if fixture["mode"] as? String == "binding" {
        if let d = try inspectBoundDialog(pid: 7, target: target) { result = ["ok": true, "identity": d.identity!.json] }
        else { result = ["ok": true, "open": false] }
    } else {
        let identity = DialogIdentity(chromePid: 7, tabId: 9, windowId: 1, cgWindow: 11, dialogCgWindow: 21, token: String(repeating: "a", count: 64))
        var fieldValue = ""
        result = try answerPageDialog(expected: identity, button: fixture["button"] as? String ?? "OK", text: fixture["text"] as? String,
            inspect: {
                inspections += 1
                let sequence = fixture["sequence"] as? [String] ?? ["same", "same", "same", "gone"]
                let state = sequence[min(inspections - 1, sequence.count - 1)]
                if state == "error" { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect",
                    dialogProbePoint: fixture["probePoint"] as? Bool == true ? .native_attribute_read : nil) }
                if state == "gone" { return nil }
                let labels = fixture["buttons"] as? [String] ?? ["OK", "Cancel"]
                let fields = Array(repeating: dialog, count: fixture["fields"] as? Int ?? 1)
                let actual = state == "same" ? identity : DialogIdentity(chromePid: 7, tabId: 9, windowId: 1, cgWindow: 11, dialogCgWindow: 22, token: String(repeating: "b", count: 64))
                return PageDialog(title: "test", texts: [], buttons: labels.map { ($0, dialog) }, fields: fields, window: dialog, descriptor: [], identity: actual)
            }, validateButton: { _ in if fixture["buttonDisabled"] as? Bool == true { throw DialogFailure(code: "dialog_button_disabled", stage: "dialog_button") } },
            validateField: { _ in if fixture["fieldReadonly"] as? Bool == true { throw DialogFailure(code: "dialog_field_unavailable", stage: "dialog_field") } },
            set: { _, value in effects.append("set"); fieldValue = value; return fixture["setFails"] as? Bool != true },
            read: { _ in effects.append("read"); return fixture["readFails"] as? Bool == true ? nil : (fixture["readMismatch"] as? Bool == true ? "different" : fieldValue) },
            press: { _ in effects.append("press"); return fixture["pressFails"] as? Bool != true }, settle: {})
    }
} catch let e as DialogFailure { result = e.json }
result["effects"] = effects; result["inspections"] = inspections
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`);
execFileSync('/usr/bin/swiftc', [source, '-o', binary], { stdio: 'pipe' });
const run = fixture => JSON.parse(execFileSync(binary, [JSON.stringify(fixture)], { encoding: 'utf8' }));
const identity = { version: 1, chromePid: 7, tabId: 9, windowId: 1, cgWindow: 11, dialogCgWindow: 21, token: 'a'.repeat(64) };

test('native failure projection admits only closed points for dialog inspection errors', () => {
  for(const point of ['native_attribute_deadline','native_attribute_read','native_windows_shape','native_subrole_shape',
    'native_sheets_shape','native_walk_guard','native_button_title','native_button_label','native_text_value',
    'native_children_read','native_dialog_final','cli_inspect_catch']) {
    const r=run({mode:'failure_projection',point});assert.equal(r.dialogProbePoint,point);assert.equal(r.inputDelivery,'not_sent');
  }
  for(const extra of [{point:'PRIVATE_AX_TEXT'},{point:'bridge_child_failed'},{point:'native_attribute_read',code:'terminated'},
    {point:'native_attribute_read',stage:'native_read_deadline'}]) {
    const r=run({mode:'failure_projection',...extra});assert.equal(Object.hasOwn(r,'dialogProbePoint'),false);
    assert.doesNotMatch(JSON.stringify(r),/PRIVATE_AX_TEXT/);
  }
});
test('NAT-RETRY: rescan facts project for inspect, binding and Probe-deadline unknowns only', () => {
  for(const stage of ['dialog_inspect','dialog_binding','native_read_deadline']) {
    const r=run({mode:'failure_projection',stage,axRetries:2,axError:-25204});assert.equal(r.axRetries,2,stage);assert.equal(r.axError,-25204,stage);
  }
  for(const extra of [{stage:'dialog_recheck'},{code:'dialog_ambiguous'},{code:'terminated',stage:'native_read_deadline'}]) {
    const r=run({mode:'failure_projection',axRetries:2,axError:-25204,...extra});assert.equal(Object.hasOwn(r,'axRetries'),false);assert.equal(Object.hasOwn(r,'axError'),false);
  }
  assert.equal(Object.hasOwn(run({mode:'failure_projection',point:'native_attribute_read'}),'axRetries'),false);
});
test('optional probe point preserves transaction refusal and partial-delivery behavior', () => {
  for(const fixture of [{sequence:['error']},{sequence:['same','same','error'],text:'PRIVATE_INPUT'}]) {
    const prior=run(fixture),annotated=run({...fixture,probePoint:true});
    assert.equal(annotated.dialogProbePoint,'native_attribute_read');delete annotated.dialogProbePoint;
    assert.deepEqual(annotated,prior,'same error, delivery, inspections and synthetic effects');
  }
});
test('exact complete identity and native AX/CG/Chrome map bind without host heuristics', () => {
  assert.deepEqual(run({ mode: 'identity', identity }).identity, identity);
  const result = run({ mode: 'binding' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual({ ...result.identity, token: identity.token }, identity);
  assert.match(result.identity.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(run({ mode: 'binding', attachment: 11 }).identity, result.identity);
});
for (const key of ['version', 'chromePid', 'tabId', 'windowId', 'cgWindow', 'dialogCgWindow', 'token']) {
  test(`missing ${key} refuses identity`, () => {
    const missing = { ...identity }; delete missing[key];
    const r = run({ mode: 'identity', identity: missing });
    assert.equal(r.error, 'dialog_identity_required'); assert.equal(r.inputDelivery, 'not_sent');
  });
}
for (const value of [true, 0, -1, 1.5, '7', 2147483648]) test(`invalid PID ${JSON.stringify(value)} refuses identity`, () => {
  assert.equal(run({ mode: 'identity', identity: { ...identity, chromePid: value } }).error, 'dialog_identity_required');
});
const standard = (cgWindow = 11, rect = [0, 0, 800, 600]) => ({ cgWindow, rect, AXSubrole: 'AXStandardWindow', AXMinimized: false });
const chrome = (id = 1, tabId = 9, rect = [0, 0, 800, 600]) => ({ id, tabId, rect, minimized: false });
const cg = (num, rect, overrides = {}) => ({ num, pid: 7, layer: num === 21 ? 1 : 0, onScreen: true,
  bounds: { X: rect[0], Y: rect[1], Width: rect[2], Height: rect[3] }, ...overrides });
const cgRows = () => [cg(21, [100, 100, 200, 100]), cg(11, [0, 0, 800, 600])];
for (const [name, fixture, error] of [
  ['wrong parent attachment', { attachment: 99 }, 'dialog_identity_mismatch'],
  ['wrong active tab', { chrome: [chrome(1, 10)] }, 'dialog_identity_mismatch'],
  ['missing active tab metadata', { chrome: [{ id: 1, rect: [0,0,800,600], minimized: false }] }, 'dialog_probe_unknown'],
  ['wrong Chrome window id', { chrome: [chrome(2)] }, 'dialog_identity_mismatch'],
  ['unknown AX attribute', { unreadableAttribute: 'AXMinimized' }, 'dialog_probe_unknown'],
  ['CG unavailable', { missingCG: true }, 'dialog_probe_unknown'],
  ['SB unavailable', { missingSB: true }, 'dialog_probe_unknown'],
  ['Apple Event error', { appleEventFailure: true }, 'dialog_probe_unknown'],
  ['wrong CG owner', { cg: [cg(21, [100,100,200,100], { pid: 8 }), cgRows()[1]] }, 'dialog_probe_unknown'],
  ['wrong parent CG owner', { cg: [cgRows()[0], cg(11, [0,0,800,600], { pid: 8 })] }, 'dialog_probe_unknown'],
  ['AX/CG frame disagreement', { cg: [cg(21, [200,100,200,100]), cgRows()[1]] }, 'dialog_probe_unknown'],
  ['missing parent CG', { cg: [cgRows()[0]] }, 'dialog_probe_unknown'],
  ['nonstandard overlay is not parent', { windows: [{ ...standard(), AXSubrole: 'AXUnknown' }] }, 'dialog_probe_unknown'],
  ['hidden parent', { cg: [cgRows()[0], cg(11, [0,0,800,600], { onScreen: false })] }, 'dialog_probe_unknown'],
  ['parent outside dialog', { windows: [standard(11, [500,0,800,600])], chrome: [chrome(1,9,[500,0,800,600])], cg: [cgRows()[0],cg(11,[500,0,800,600])] }, 'dialog_probe_unknown'],
  ['overlapping distinct parents', { windows: [standard(), standard(12,[50,50,800,600])], chrome: [chrome(),chrome(2,10,[50,50,800,600])], cg: [...cgRows(),cg(12,[50,50,800,600])] }, 'dialog_ambiguous'],
  ['identical parent bounds', { windows: [standard(),standard(12)], chrome: [chrome(),chrome(2,10)], cg: [...cgRows(),cg(12,[0,0,800,600])] }, 'dialog_ambiguous'],
  ['missing AX parent window', { chrome: [chrome(),chrome(2,10,[900,0,800,600])] }, 'dialog_probe_unknown'],
]) test(`${name} refuses before writes`, () => {
  const r = run({ mode: 'binding', ...fixture });
  assert.equal(r.ok, false); assert.equal(r.error, error); assert.equal(r.inputDelivery, 'not_sent'); assert.deepEqual(r.effects, []);
});

// Contract D (kept behaviour, no native change): a dialog in another window goes through the real binding.
test('kept: a dialog in window M binds to tab M; target N is refused before writes; target M binds and can answer', () => {
  const twoWindows = { windows: [standard(), standard(12, [900, 0, 800, 600])],
    chrome: [chrome(1, 9), chrome(2, 10, [900, 0, 800, 600])], cg: [...cgRows(), cg(12, [900, 0, 800, 600])] };
  const unbound = run({ mode: 'binding', untargeted: true, ...twoWindows });
  assert.equal(unbound.ok, true, JSON.stringify(unbound));
  assert.deepEqual([unbound.identity.tabId, unbound.identity.windowId, unbound.identity.cgWindow], [9, 1, 11], 'owner M from the binding');
  const other = run({ mode: 'binding', ...twoWindows, target: { chromePid: 7, tabId: 10, windowId: 2, cgWindow: 12 } });
  assert.equal(other.ok, false); assert.equal(other.error, 'dialog_identity_mismatch');
  assert.equal(other.inputDelivery, 'not_sent'); assert.deepEqual(other.effects, []);
  const own = run({ mode: 'binding', ...twoWindows, target: { chromePid: 7, tabId: 9, windowId: 1, cgWindow: 11 } });
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.deepEqual(own.identity, unbound.identity, 'the same binding whether targeted at M or not');
  assert.deepEqual({ ...own.identity, token: identity.token }, identity, 'the identity the answer transaction expects');
  const pressed = run({});
  assert.equal(pressed.ok, true); assert.equal(pressed.pressed, 'OK'); assert.equal(pressed.inputDelivery, 'sent');
});

for (const [name, fixture, error] of [
  ['invalid exact button', { button: 'Missing', text: 'PRIVATE_INPUT' }, 'no_such_button'],
  ['case mismatch', { button: 'ok', text: 'PRIVATE_INPUT' }, 'no_such_button'],
  ['duplicate exact button', { buttons: ['OK','OK'], text: 'PRIVATE_INPUT' }, 'dialog_button_ambiguous'],
  ['disabled button', { buttonDisabled: true, text: 'PRIVATE_INPUT' }, 'dialog_button_disabled'],
  ['missing prompt field', { fields: 0, text: 'PRIVATE_INPUT' }, 'dialog_field_ambiguous'],
  ['ambiguous prompt fields', { fields: 2, text: 'PRIVATE_INPUT' }, 'dialog_field_ambiguous'],
  ['readonly prompt field', { fieldReadonly: true, text: 'PRIVATE_INPUT' }, 'dialog_field_unavailable'],
  ['dialog already gone', { sequence: ['gone'] }, 'dialog_identity_mismatch'],
  ['dialog replaced', { sequence: ['other'] }, 'dialog_identity_mismatch'],
  ['replacement before set', { sequence: ['same','other'], text: 'PRIVATE_INPUT' }, 'dialog_identity_mismatch'],
  ['unknown inspection', { sequence: ['error'] }, 'dialog_probe_unknown'],
]) test(`${name} cannot write any field or press`, () => {
  const r = run(fixture); assert.equal(r.error,error); assert.equal(r.inputDelivery,'not_sent'); assert.deepEqual(r.effects,[]);
  assert.equal(JSON.stringify(r).includes('PRIVATE_INPUT'),false);
});
for (const [name, fixture, effects, stage] of [
  ['AXSet failure', { setFails: true }, ['set'], 'dialog_set'],
  ['readback unavailable', { readFails: true }, ['set','read'], 'dialog_readback'],
  ['readback mismatch', { readMismatch: true }, ['set','read'], 'dialog_readback'],
  ['dialog changed after set', { sequence: ['same','same','other'] }, ['set','read'], 'dialog_recheck'],
  ['dialog gone after set', { sequence: ['same','same','gone'] }, ['set','read'], 'dialog_recheck'],
  ['AXPress failure', { pressFails: true }, ['set','read','press'], 'dialog_press'],
]) test(`${name} reports unknown with no replay`, () => {
  const r = run({ text: 'PRIVATE_INPUT', ...fixture });
  assert.equal(r.ok,false); assert.equal(r.inputDelivery,'unknown'); assert.equal(r.stage,stage); assert.deepEqual(r.effects,effects);
  assert.equal(r.pressed,undefined); assert.equal(JSON.stringify(r).includes('PRIVATE_INPUT'),false);
});
test('one successful press has a receipt; postcheck distinguishes same, new, gone and unknown', () => {
  for (const [last,same,still] of [['same',true,true],['other',false,true],['gone',false,false],['error',null,null]]) {
    const r = run({ text:'PRIVATE_INPUT', sequence:['same','same','same',last] });
    assert.equal(r.ok,true); assert.equal(r.pressed,'OK'); assert.equal(r.inputDelivery,'sent');
    assert.equal(r.sameStillOpen,same); assert.equal(r.stillOpen,still); assert.deepEqual(r.effects,['set','read','press']);
    assert.equal(JSON.stringify(r).includes('PRIVATE_INPUT'),false);
  }
});
test('button-only transaction never reads or writes the prompt value', () => {
  const r = run({}); assert.deepEqual(r.effects,['press']); assert.equal(r.pressed,'OK');
});
test('raw close has no retired CLI mutation or global AXPress path', () => {
  const cli = fs.readFileSync(new URL('../src/chromectl.swift', import.meta.url), 'utf8');
  assert.equal(cli.includes('func axLeaveButton('), false);
  assert.equal(cli.includes('case "close":'), false);
  assert.match(cli, /native_session_required/);
  assert.match(swift, /close_prompt_pending/);
});

test('native argument parser treats flag-shaped labels and prompt contents as opaque values', () => {
  for (const value of ['--pid', '--identity', '--press', '--text', 'quote"; $(native) \n中文']) {
    const r = run({ mode:'options', args:['dialog','--pid','7','--press',value,'--text',value], expectedText:value, expectedButton:value });
    assert.equal(r.ok,true); assert.equal(r.textMatches,true); assert.equal(r.buttonMatches,true);
  }
  for (const args of [['dialog','--pid'],['dialog','--pid','7','--pid','8'],['dialog','--unknown','x']]) {
    assert.equal(run({mode:'options',args}).error,'dialog_identity_required');
  }
});

test('dialog inspect and answer do not evaluate DOM, activate, raise or invoke AppleScript', () => {
  for (const name of ['axPageDialog','inspectBoundDialog','answerPageDialog']) {
    assert.doesNotMatch(fn(name),/executeJavascript|runAppleScript|AXRaise|\.activate\(|\.setValue\(/,name);
  }
});
