#!/usr/bin/env node
/* PERM1 (problems-20261101, contracts-batch4.md PERM1 + rulings 1-7; inv-batch4/perm-fable.md N1-N11): a Chrome permission
 * prompt directly above the bound target is answered "allow" by ONE re-verified AXPress inside the activation (never a key);
 * everything else Chrome shows there is classified and left alone. Fakes only: nothing reaches Chrome, AX, CG or input.
 *
 * Sections (PERM1_GROUP=new|kept runs one group; PERM1_CASE=<name>[,<name>…] runs those cases):
 *   policy  the exact production Popup enum (classify + resolve), Transaction, Failure, and the production Probe readers
 *           popupAbove / popupShape / popupPressable / axIsChromePermissionPrompt / axPageDialog, compiled with a synthetic
 *           AX tree and CG list. The driver wires Popup.Effects exactly as Owner.clearChromePrompt does (the reads, the
 *           press through the transaction ledger, the read-only settle), with a model press and settle.
 *   owner   the production Owner.run -> execute -> clearChromePrompt path in window-visibility-native's behaviour capsule
 *           (exact source blocks, the model answers the AX/CG reads), then the real Session click guard.
 * New fix (each RED under its targeted mutation in runs/PERM1/rerun.sh). Kept: other Chrome windows, JS dialogs and
 * unknown popups are never pressed (D's domain stays D's). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROUP = process.env.PERM1_GROUP || 'all';
const ONLY = process.env.PERM1_CASE ? process.env.PERM1_CASE.split(',') : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-perm1-native-'));
const cases = [];
const add = (group, name, label, fn) => cases.push({ group, name, label, fn });
const evidence = [];

/* ======================================================================== policy: exact source, synthetic AX/CG */

const swift = fs.readFileSync(process.env.NATIVE_CHROME_SOURCE || path.join(ROOT, 'src/native-chrome.swift'), 'utf8');
function slice(start, end, label) {
  const a = swift.indexOf(start); assert.ok(a >= 0, `anchor ${label}`);
  const b = swift.indexOf(end, a + start.length); assert.ok(b > a, `end ${label}`);
  return swift.slice(a, b);
}
/** A Probe-level (column 0) function, as the dialog tests extract them. */
const probeFn = name => { const a = swift.indexOf(`\nfunc ${name}(`); assert.ok(a >= 0, name); return swift.slice(a + 1, swift.indexOf('\n}', a + 1) + 2); };
const blocks = {
  popup: slice('enum Popup {', '\n}\n', 'Popup') + '\n}',
  transaction: slice('    final class Transaction {', '\n    }\n', 'Transaction') + '\n    }',
  failure: slice('    struct Failure: Error {', '\n    }\n', 'Failure') + '\n    }',
  target: slice('    struct Target: Equatable {', '\n    struct Failure:', 'Target'),
  dialogInt: slice('static func dialogInt(', '\nstatic func dialogIdentity(', 'dialogInt'),
  promptText: slice('static func promptText(', '\nstatic func promptOrigin(', 'promptText'),
  dialogTypes: slice('struct DialogFailure:', '\nstruct DialogParent', 'dialog types'),
};
const readers = ['axIsWindowSharingIndicator', 'axIsInputSourceIndicator', 'axIsChromeTranslationBubble', 'popupAbove', 'popupShape',
  'popupPressable', 'pageDialogSurface', 'axIsChromePermissionPrompt', 'axPageDialog', 'axRetryPause'].map(probeFn);
// r1 A4: the pre-check reply (chromectl's dialog command) carries this surface word and the attachment boolean.
const cli = fs.readFileSync(process.env.CHROMECTL_SOURCE || path.join(ROOT, 'src/chromectl.swift'), 'utf8');
assert.match(cli, /let surface = ChromeNative\.Probe\(\)\.pageDialogSurface\(d, pid: pid\)\n\s+emit\(\["ok": true, "known": true, "open": true, "surface": surface\.surface, "attached": surface\.attached,/);
// The Owner's wiring that this driver mirrors (same reads, same press primitive, same settle bound).
const wiring = slice('        func clearChromePrompt(', '\n        }\n', 'clearChromePrompt');
assert.match(wiring, /above: \{ try read \{ \$0\.popupAbove\(t\) \} \}/);
assert.match(wiring, /shape: \{ number in try read \{ \$0\.popupShape\(number, pid: t\.chromePid\) \} \}/);
assert.match(wiring, /pressable: \{ element in try read \{ \$0\.popupPressable\(element\) \} \}/);
assert.match(wiring, /press: \{ element in AXUIElementPerformAction\(element, kAXPressAction as CFString\) \}/);
assert.match(wiring, /settleFocus\(t, until: ProcessInfo\.processInfo\.systemUptime \+ 0\.7\)/);
assert.match(wiring, /let until = ProcessInfo\.processInfo\.systemUptime \+ 0\.3/);
assert.match(wiring, /held: \{ \[unowned self\] in self\.held\(\) \}/);
// r1 A3: unwired Owners (chromectl) never press; the helper Session's own owner() wiring is exercised by owner-monitored.
assert.match(swift, /var held: \(\) -> Bool = \{ false \}/);

const program = (popupBlock = blocks.popup, readerBlocks = readers) => String.raw`
import Foundation
import CoreGraphics
typealias CFTypeRef = AnyObject
typealias CFString = String
typealias CFArray = NSArray
let kAXWindowsAttribute = "AXWindows", kAXSubroleAttribute = "AXSubrole", kAXRoleAttribute = "AXRole", kAXTitleAttribute = "AXTitle"
let kAXDescriptionAttribute = "AXDescription", kAXValueAttribute = "AXValue", kAXChildrenAttribute = "AXChildren"
let kAXStandardWindowSubrole = "AXStandardWindow", kAXDialogSubrole = "AXDialog", kAXWindowRole = "AXWindow"
let kAXButtonRole = "AXButton", kAXStaticTextRole = "AXStaticText", kAXTextFieldRole = "AXTextField", kAXTextAreaRole = "AXTextArea"
let kAXModalAttribute = "AXModal", kAXFocusedAttribute = "AXFocused", kAXMainAttribute = "AXMain", kAXEnabledAttribute = "AXEnabled"
let kAXFocusedWindowAttribute = "AXFocusedWindow", kAXPressAction = "AXPress", kAXParentAttribute = "AXParent", kAXWindowAttribute = "AXWindow"
let kCGWindowOwnerPID = "pid", kCGWindowLayer = "layer", kCGWindowNumber = "num", kCGWindowBounds = "bounds", kCGWindowIsOnscreen = "onScreen"
let kCGNullWindowID = 0
let axMessagingTimeout: Float = 0.025
enum AXError: Int32 { case success = 0, failure = -25200, invalidUIElement = -25202, cannotComplete = -25204, attributeUnsupported = -25205, noValue = -25212 }
var firstFailure: Error? = nil, axRetries = 0, axLastError: Int? = nil
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
final class AXUIElement {
    var attrs: [String: AnyObject] = [:]
    var number: Int
    init(_ row: [String: Any]) {
        number = row["num"] as? Int ?? 0
        for (key, value) in row where !["children", "num", "AXSheets", "AXParentNum"].contains(key) { attrs[key] = value as AnyObject }
        // r1 A1: the window its AXParent attribute names (an element carrying only that window number).
        if let parent = row["AXParentNum"] as? Int { attrs[kAXParentAttribute] = AXUIElement(["num": parent]) }
        if let children = row["children"] as? [[String: Any]] { attrs[kAXChildrenAttribute] = children.map { AXUIElement($0) } as AnyObject }
        if let sheets = row["AXSheets"] as? [[String: Any]] { attrs["AXSheets"] = sheets.map { AXUIElement($0) } as AnyObject }
    }
}
func CFGetTypeID(_ value: CFTypeRef) -> Int { value is AXUIElement ? 1 : 0 }
func AXUIElementGetTypeID() -> Int { 1 }
func CFEqual(_ a: AXUIElement, _ b: AXUIElement) -> Bool { a === b }
func CFHash(_ a: AXUIElement) -> Int { a.number }
func AXUIElementSetMessagingTimeout(_ e: AXUIElement, _ timeout: Float) {}
var reads: [String] = []
func AXUIElementCopyAttributeValue(_ e: AXUIElement, _ key: String, _ value: inout CFTypeRef?) -> AXError {
    reads.append(key)
    if (e.attrs["noValueAttributes"] as? [String])?.contains(key) == true { return .noValue }
    if key == "AXSheets" && e.attrs[key] == nil { return .attributeUnsupported }
    // A leaf (no children listed) answers noValue, as AX does; "unreadableChildren" makes the read fail.
    if key == kAXChildrenAttribute && e.attrs[key] == nil { return e.attrs["unreadableChildren"] as? Bool == true ? .cannotComplete : .noValue }
    guard let found = e.attrs[key] else { return .failure }
    value = found; return .success
}
func AXUIElementCopyActionNames(_ e: AXUIElement, _ out: inout CFArray?) -> AXError {
    out = (e.attrs["noPress"] as? Bool == true ? [] : ["AXPress"]) as NSArray; return .success
}
func around<T>(_ fallback: T, _ body: () -> T) -> T { body() }
struct CGOptions: OptionSet {
    let rawValue: Int
    static let optionOnScreenOnly = CGOptions(rawValue: 1), excludeDesktopElements = CGOptions(rawValue: 2), optionAll = CGOptions(rawValue: 4)
}
// The world, front to back: AX windows and CG rows (mutable: the press and the recheck mutations change them).
var axRows = fixture["windows"] as? [[String: Any]] ?? []
var cgRows = fixture["cg"] as? [[String: Any]] ?? []
var wins = axRows.map { AXUIElement($0) }
let application = AXUIElement([:])
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { application.attrs[kAXWindowsAttribute] = wins as AnyObject; return application }
func axWindows(pid: pid_t) -> [AXUIElement] { wins }
func axWindowNumber(_ element: AXUIElement) -> Int? { element.number == 0 ? nil : element.number }
func CGWindowListCopyWindowInfo(_ options: CGOptions, _ number: Int) -> Any? {
    cgRows.map { row -> [String: Any] in
        var r = row
        if let b = row["bounds"] as? [Double] { r["bounds"] = ["X": b[0], "Y": b[1], "Width": b[2], "Height": b[3]] as NSDictionary }
        r["onScreen"] = row["onScreen"] as? Bool ?? true
        return r
    }.filter { !options.contains(.optionOnScreenOnly) || $0["onScreen"] as? Bool == true }
}
${blocks.dialogTypes}
enum ChromeNative {
    ${blocks.promptText}
    ${blocks.dialogInt}
${blocks.target}
${blocks.failure}
${blocks.transaction}
${popupBlock}
}
typealias Target = ChromeNative.Target
typealias Popup = ChromeNative.Popup
${readerBlocks.join('\n')}

// ---- driver
let mode = fixture["mode"] as? String ?? "resolve"
let target = try! ChromeNative.Target(["chromePid": 42, "windowId": 2, "tabId": 9, "cgWindow": 20])
func emit(_ value: [String: Any]) { print(String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!) }
func labelOf(_ e: AXUIElement) -> String { (e.attrs[kAXTitleAttribute] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? e.attrs[kAXDescriptionAttribute] as? String ?? "" }
func rebuild() { wins = axRows.map { AXUIElement($0) } }
switch mode {
case "classify":
    guard let above = popupAbove(target) else { emit(["kind": "none"]); exit(0) }
    let shape = popupShape(above.number, pid: 42), c = Popup.classify(shape, target: above.target, bound: above.bound)
    emit(["kind": c.kind, "button": c.button.map { shape.labels[$0] } ?? NSNull(), "bound": above.bound, "number": above.number,
          "complete": shape.complete, "foreign": shape.foreign, "fields": shape.fields])
case "pageDialog":
    do {
        guard var d = try axPageDialog(pid: 42) else { emit(["dialog": NSNull()]); exit(0) }
        // r1 A4: the surface word the pre-check reply carries (chromectl emits pageDialogSurface for the bound dialog).
        d.identity = DialogIdentity(chromePid: 42, tabId: 9, windowId: 2, cgWindow: 20, dialogCgWindow: d.window.number, token: "fixture")
        let surface = pageDialogSurface(d, pid: 42)
        emit(["dialog": d.window.number, "surface": surface.surface, "attached": surface.attached])
    } catch let e as DialogFailure { emit(["error": e.code]) }
default:
    // Popup.resolve wired as Owner.clearChromePrompt wires it: the production readers, a deadline cut as the Probe's,
    // the press through the transaction ledger, then the read-only settle (here: the model's CG order).
    var aboveCalls = 0, shapeCalls = 0, presses: [String] = [], checkpoints: [String: Int] = [:], clock = 0.0
    let cut = fixture["cutAtRead"] as? Int ?? 0
    struct Stop: Error {}
    let tx = ChromeNative.Transaction(operationId: "perm1", checkpoint: { stage in
        checkpoints[stage, default: 0] += 1
        if let s = fixture["stopStage"] as? String, s == stage, checkpoints[stage] == (fixture["stopOccurrence"] as? Int ?? 1) { throw Stop() }
    })
    func mutate(_ at: String) {
        guard let m = fixture["mutate"] as? [String: Any], m["at"] as? String == at else { return }
        switch m["kind"] as? String ?? "" {
        case "renumber":   // a new popup (another window number) replaces the classified one
            axRows = axRows.map { var r = $0; if r["num"] as? Int == 50 { r["num"] = 51 }; return r }
            cgRows = cgRows.map { var r = $0; if r["num"] as? Int == 50 { r["num"] = 51 }; return r }
            rebuild()
        case "relabel":    // the same window now offers other buttons
            axRows = axRows.map { var r = $0; if r["num"] as? Int == 50 { r["children"] = (m["children"] as? [[String: Any]]) ?? [] }; return r }
            rebuild()
        case "elements":   // the same labels, new button elements
            rebuild()
        default: break
        }
    }
    func readCut(_ n: Int) throws { if cut > 0 && n >= cut { throw DialogFailure(code: "dialog_probe_unknown", stage: "native_read_deadline") } }
    let fx = Popup.Effects(
        now: { clock += 0.001; return clock },
        above: { aboveCalls += 1; if aboveCalls == 2 { mutate("recheck") }; try readCut(aboveCalls + shapeCalls); return popupAbove(target) },
        shape: { number in shapeCalls += 1; try readCut(aboveCalls + shapeCalls); return popupShape(number, pid: 42) },
        pressable: { element in popupPressable(element) },
        prepare: { _ in fixture["prepareFails"] as? Bool != true },
        press: { element in
            presses.append(labelOf(element))
            let status: AXError = fixture["pressFails"] as? Bool == true ? .cannotComplete : .success
            if status == .success && fixture["pressEffect"] as? String ?? "close" == "close" {
                axRows.removeAll { $0["num"] as? Int == 50 }; cgRows.removeAll { $0["num"] as? Int == 50 }; rebuild()
            }
            return status
        },
        settle: {
            clock += 0.7
            let chrome = cgRows.filter { $0["pid"] as? Int == 42 && $0["layer"] as? Int ?? 0 == 0 && ($0["onScreen"] as? Bool ?? true) }
            let first = chrome.first { r in let b = r["bounds"] as? [Double] ?? [0, 0, 0, 0]; return b[2] >= 100 && b[3] >= 100 }
            let onTop = first?["num"] as? Int == 20
            return (onTop, true, 42, ["focusBlocker": onTop ? NSNull() : ["pid": 42, "layer": 0] as [String: Any], "focusSamples": 1])
        },
        held: { fixture["held"] as? Bool ?? true })
    let s = fixture["state"] as? [String: Any] ?? [:]
    let state: (Bool, Bool, Int, [String: Any]) = (s["onTop"] as? Bool ?? false, true, s["front"] as? Int ?? 42,
        ["focusBlocker": s["blocker"] ?? ["owner": "", "pid": 42, "layer": 0, "width": 320, "height": 160]])
    var out: [String: Any] = [:]
    do {
        let (after, facts) = try Popup.resolve(fx, state: state, chromePid: 42, tx: tx)
        out = ["ok": true, "facts": facts, "onTop": after.0]
    } catch let f as ChromeNative.Failure {
        out = ["ok": false, "error": f.code, "reply": tx.result(f.json)]
    } catch is Stop {
        out = ["ok": false, "error": "aborted", "reply": tx.result(["ok": false, "error": "aborted"])]
    } catch { out = ["ok": false, "error": String(describing: error)] }
    out["presses"] = presses; out["stages"] = tx.stages; out["txFacts"] = tx.facts; out["reads"] = ["above": aboveCalls, "shape": shapeCalls]
    out["clockMs"] = Int((clock * 1000).rounded())
    emit(out)
}
`;
function compile(label, source) {
  const dir = fs.mkdtempSync(path.join(tmp, `${label}-`)), main = path.join(dir, 'main.swift'), bin = path.join(dir, 'policy');
  fs.writeFileSync(main, source);
  const c = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', path.join(dir, 'cache'), '-o', bin, main], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(c.status, 0, `compile ${label}: ${c.stderr}`);
  return fixture => {
    const r = spawnSync(bin, [JSON.stringify(fixture)], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `run ${label}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
}
let policyRun = null;
const policy = fixture => (policyRun ??= compile('policy', program()))(fixture);

// The target (CG 20) spans [0,40,1000,700]; the popup (CG 50) is anchored under the toolbar: [300,80,320,160].
const button = (label, extra = {}) => ({ AXRole: 'AXButton', AXTitle: label, AXEnabled: true, ...extra });
const text = value => ({ AXRole: 'AXStaticText', AXValue: value });
const SENTINEL = { title: 'SENTINEL-TITLE-https://private.example/path?q=secret', text: 'SENTINEL-TEXT private.example wants to' };
const promptWindow = (labels, extra = {}) => ({ num: 50, AXRole: 'AXWindow', AXSubrole: 'AXUnknown', AXModal: false, AXTitle: SENTINEL.title,
  children: [{ AXRole: 'AXGroup', children: [text(SENTINEL.text), { AXRole: 'AXImage' }, ...labels.map(l => typeof l === 'string' ? button(l) : l)] }], ...extra });
const standard = (num, extra = {}) => ({ num, AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow', AXModal: false, AXTitle: 'Synthetic', children: [], ...extra });
const world = (popup, o = {}) => ({
  windows: [...(popup ? [popup] : []), standard(20, o.targetAX ?? {}), standard(10)],
  cg: [...(popup || o.cgOnly ? [{ num: 50, pid: o.popupPid ?? 42, layer: o.popupLayer ?? 0, bounds: o.popupRect ?? [300, 80, 320, 160] }] : []),
    ...(o.between ? [{ num: 10, pid: 42, layer: 0, bounds: [0, 40, 1000, 700] }] : []),
    { num: 20, pid: 42, layer: 0, bounds: [0, 40, 1000, 700] },
    ...(o.between ? [] : [{ num: 10, pid: 42, layer: 0, bounds: [100, 100, 600, 500] }])],
});
const STANDARD_EN = ['Allow', 'Block'];
const ONE_TIME_EN = ['Allow this time', 'Allow on every visit', 'Never allow'];
const STANDARD_ZH = ['允许', '禁止'];
const resolveCase = (popup, o = {}) => policy({ mode: 'resolve', ...world(popup, o), ...o.fx });
const said = r => `${r.ok ? 'ok' : r.error}; facts ${JSON.stringify(r.facts ?? r.reply ?? {})}; presses [${r.presses?.join('|')}]; stages ${r.stages?.map(s => `${s.stage}/${s.delivery}`).join(',') || 'none'}`;

add('new', 'allow-en-standard', 'N1: en standard prompt {Allow, Block} above the bound target: one popup_allow write (AXPress on Allow), the settle shows the target on top: permission/allow/sent/cleared', async () => {
  const r = resolveCase(promptWindow(STANDARD_EN));
  evidence.push(`allow-en-standard: ${said(r)}; ${r.clockMs} ms on the model clock`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.presses, ['Allow']);
  assert.deepEqual(r.stages.map(s => [s.stage, s.delivery]), [['popup_allow', 'sent']]);
  assert.equal(r.facts.popupKind, 'permission'); assert.equal(r.facts.popupAction, 'allow');
  assert.equal(r.facts.popupDelivery, 'sent'); assert.equal(r.facts.popupResult, 'cleared'); assert.equal(r.onTop, true);
});
add('new', 'allow-one-time', 'N2: one-time sets: "Allow this time" is pressed, never "Allow on every visit"; both en one-time variants', async () => {
  for (const labels of [ONE_TIME_EN, ['Allow while visiting the site', 'Allow this time', 'Never allow']]) {
    const r = resolveCase(promptWindow(labels));
    evidence.push(`allow-one-time [${labels.join('|')}]: ${said(r)}`);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.presses, ['Allow this time']); assert.equal(r.facts.popupResult, 'cleared');
  }
});
add('new', 'allow-zh-standard', 'N3: zh_CN standard prompt {允许, 禁止}: 允许 is pressed once', async () => {
  const r = resolveCase(promptWindow(STANDARD_ZH));
  evidence.push(`allow-zh-standard: ${said(r)}`);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.presses, ['允许']); assert.equal(r.facts.popupKind, 'permission');
});
add('new', 'leave-site-sheet', 'N4: a "Leave site?" sheet of the standard window ({Leave, Cancel}) above the target: js_dialog, zero writes; a modal Chrome window likewise', async () => {
  const sheet = { num: 50, AXRole: 'AXWindow', AXSubrole: 'AXSheet', AXModal: false, children: [button('Leave'), button('Cancel')] };
  const r = resolveCase(null, { cgOnly: true, targetAX: { AXSheets: [sheet] } });
  const modal = resolveCase(promptWindow(STANDARD_EN, { AXModal: true }));
  evidence.push(`leave-site-sheet: ${said(r)}; modal window with Allow/Block: ${said(modal)}`);
  for (const x of [r, modal]) {
    assert.equal(x.ok, true, JSON.stringify(x)); assert.equal(x.facts.popupKind, 'js_dialog'); assert.deepEqual(x.presses, []); assert.deepEqual(x.stages, []);
    assert.equal(x.facts.popupAction, 'none'); assert.equal(x.facts.popupDelivery, 'not_sent');
  }
});
add('new', 'unknown-labels', 'N5: unknown label sets are never pressed (whole-label set equality, not substrings): {Allow, Don\'t allow}, {允许, 不允许}, {Save, Never}, a bubble with a text field, 5 buttons, a web area, an unreadable subtree', async () => {
  const variants = {
    'dont-allow': ['Allow', "Don't allow"], 'zh-bu-yunxu': ['允许', '不允许'], 'save-never': ['Save', 'Never'],
    'with-field': [...STANDARD_EN, { AXRole: 'AXTextField' }], 'five-buttons': ['Allow', 'Block', 'Allow this time', 'Never allow', 'Settings'],
    'web-area': [...STANDARD_EN, { AXRole: 'AXWebArea', children: [] }], 'allow-twice': ['Allow', 'Allow', 'Block'],
    'unreadable-subtree': [...STANDARD_EN, { AXRole: 'AXGroup', unreadableChildren: true }],
  };
  for (const [name, labels] of Object.entries(variants)) {
    const r = resolveCase(promptWindow(labels));
    evidence.push(`unknown-labels ${name}: ${said(r)}`);
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`); assert.equal(r.facts.popupKind, 'unknown', name);
    assert.deepEqual(r.presses, [], name); assert.deepEqual(r.stages, [], name);
  }
});
add('new', 'ax-invisible', 'N6: a Chrome CG window above the target with no AX window: unknown, zero writes (and a large one is another browser window: no popup facts)', async () => {
  const r = resolveCase(null, { cgOnly: true });
  const big = resolveCase(null, { cgOnly: true, popupRect: [0, 40, 900, 650] });
  evidence.push(`ax-invisible: ${said(r)}; large AX-invisible window: ${said(big)}`);
  assert.equal(r.facts.popupKind, 'unknown'); assert.deepEqual(r.presses, []); assert.deepEqual(r.stages, []);
  assert.equal('popupWindow' in r.facts, false, 'r1 A1: an AX-invisible window (maybe another browser window) is never offered for a picture');
  assert.deepEqual(big.facts, {}, 'another browser window: FOCUS4 territory, no popup facts');
});
add('new', 'recheck-changed', 'N7: between the classification and the press the window above changes number, its buttons change, or its button elements are new: popupResult changed, zero writes', async () => {
  for (const mutate of [{ at: 'recheck', kind: 'renumber' }, { at: 'recheck', kind: 'relabel', children: [button('Allow'), button('Block'), button('Settings')] },
    { at: 'recheck', kind: 'elements' }]) {
    const r = resolveCase(promptWindow(STANDARD_EN), { fx: { mutate } });
    evidence.push(`recheck-changed ${mutate.kind}: ${said(r)}`);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.facts.popupResult, 'changed', mutate.kind);
    assert.deepEqual(r.presses, [], mutate.kind); assert.deepEqual(r.stages, [], mutate.kind);
  }
});
add('new', 'press-unknown', 'N8: AXPress returns an error: popup_press_unknown, the one write entered with delivery unknown, noRetry, the popup facts on the failure reply; never a second press', async () => {
  const r = resolveCase(promptWindow(STANDARD_EN), { fx: { pressFails: true } });
  evidence.push(`press-unknown: ${said(r)}`);
  assert.equal(r.ok, false); assert.equal(r.error, 'popup_press_unknown');
  assert.deepEqual(r.presses, ['Allow']); assert.deepEqual(r.stages.map(s => [s.stage, s.delivery]), [['popup_allow', 'unknown']]);
  assert.equal(r.reply.inputDelivery, 'unknown'); assert.equal(r.reply.noRetry, true);
  assert.equal(r.reply.popupKind, 'permission'); assert.equal(r.reply.popupAction, 'allow'); assert.equal(r.reply.popupDelivery, 'unknown');
});
add('new', 'still-covered', 'N9: after the press the bubble is still there: popupResult remains, exactly one write (no second press)', async () => {
  const r = resolveCase(promptWindow(STANDARD_EN), { fx: { pressEffect: 'stay' } });
  evidence.push(`still-covered: ${said(r)}`);
  assert.equal(r.ok, true); assert.equal(r.facts.popupResult, 'remains'); assert.equal(r.onTop, false);
  assert.deepEqual(r.presses, ['Allow']); assert.equal(r.stages.length, 1);
});
add('new', 'translate-dismiss', 'N10 (ruling 3): a recognised translate bubble above the target is closed by ONE AXPress on its own Close button (popup_dismiss); never a key', async () => {
  const translate = { num: 50, AXRole: 'AXWindow', AXSubrole: 'AXUnknown', AXModal: false, AXFocused: false, AXMain: false, AXTitle: 'Translate this page?',
    children: [{ AXRole: 'AXGroup', AXSubrole: 'AXApplicationAlertDialog', AXTitle: 'Translate this page?', children: [
      { AXRole: 'AXTabGroup', children: [{ AXRole: 'AXRadioButton', AXSubrole: 'AXTabButton', AXTitle: 'English', noValueAttributes: ['AXChildren'] },
        { AXRole: 'AXRadioButton', AXSubrole: 'AXTabButton', AXTitle: 'Chinese', noValueAttributes: ['AXChildren'] }] },
      button('Translate options', { noValueAttributes: ['AXChildren'] }), button('Close', { noValueAttributes: ['AXChildren'] })] }] };
  const r = resolveCase(translate);
  evidence.push(`translate-dismiss: ${said(r)}`);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.facts.popupKind, 'translate'); assert.equal(r.facts.popupAction, 'dismiss');
  assert.deepEqual(r.presses, ['Close']); assert.deepEqual(r.stages.map(s => s.stage), ['popup_dismiss']); assert.equal(r.facts.popupResult, 'cleared');
});
add('new', 'facts-finite', 'N11: the facts carry finite words, bounded ints and the window number only; the planted title, static text and URL appear nowhere in any output', async () => {
  const outputs = [resolveCase(promptWindow(STANDARD_EN)), resolveCase(promptWindow(STANDARD_EN), { fx: { pressFails: true } }),
    resolveCase(promptWindow(['Allow', "Don't allow"]))];
  for (const r of outputs) {
    const all = JSON.stringify({ facts: r.facts, reply: r.reply, txFacts: r.txFacts, stages: r.stages });
    for (const s of [SENTINEL.title, SENTINEL.text, 'private.example', 'Allow', 'Block']) assert.equal(all.includes(s), false, `${s} leaked: ${all}`);
    const facts = r.facts ?? r.reply;
    assert.ok(['permission', 'translate', 'indicator', 'js_dialog', 'unknown'].includes(facts.popupKind));
    assert.ok(['none', 'allow', 'dismiss'].includes(facts.popupAction)); assert.ok(['not_sent', 'sent', 'unknown'].includes(facts.popupDelivery));
    assert.ok(['cleared', 'remains', 'changed', 'unknown'].includes(facts.popupResult));
  }
  evidence.push(`facts-finite: ${outputs.length} outputs scanned for 5 sentinels: none present`);
});
add('new', 'not-bound', 'binding (ruling 1): another Chrome window between the popup and the target, a popup outside the target\'s top band, or one owned by another process: zero writes', async () => {
  const between = resolveCase(promptWindow(STANDARD_EN), { between: true });
  const outside = resolveCase(promptWindow(STANDARD_EN), { popupRect: [300, 500, 320, 160] });
  const foreign = policy({ mode: 'classify', ...world(promptWindow(STANDARD_EN), { popupPid: 77 }) });
  evidence.push(`not-bound: between ${said(between)}; outside band ${said(outside)}; other pid ${JSON.stringify(foreign)}`);
  assert.equal(between.facts.popupKind, 'unknown'); assert.deepEqual(between.presses, []);
  assert.equal(outside.facts.popupKind, 'unknown'); assert.deepEqual(outside.presses, []);
  assert.equal(foreign.kind, 'none', 'another process\'s window is not a Chrome popup above the target');
});
add('new', 'read-cut', 'G8: a read cut by the 0.3 s classification deadline (DialogFailure native_read_deadline) proves nothing: no write, popupResult unknown; one at the recheck likewise', async () => {
  const first = resolveCase(promptWindow(STANDARD_EN), { fx: { cutAtRead: 2 } }), recheck = resolveCase(promptWindow(STANDARD_EN), { fx: { cutAtRead: 3 } });
  evidence.push(`read-cut: at the shape read ${said(first)}; at the recheck ${said(recheck)}`);
  for (const r of [first, recheck]) { assert.equal(r.ok, true); assert.equal(r.facts.popupResult, 'unknown'); assert.deepEqual(r.presses, []); }
});
add('new', 'stop-after-press', 'a Stop right after the press was sent: the reply is the Stop, the ledger says popup_allow sent, the popup facts survive on it', async () => {
  const before = resolveCase(promptWindow(STANDARD_EN), { fx: { stopStage: 'popup_allow', stopOccurrence: 1 } });
  const after = resolveCase(promptWindow(STANDARD_EN), { fx: { stopStage: 'popup_allow', stopOccurrence: 2 } });
  evidence.push(`stop-after-press: before entry ${said(before)}; after the send ${said(after)}`);
  assert.equal(before.error, 'aborted'); assert.deepEqual(before.presses, []); assert.equal(before.reply.inputDelivery, 'not_sent'); assert.equal(before.reply.popupDelivery, 'not_sent');
  assert.equal(after.error, 'aborted'); assert.deepEqual(after.presses, ['Allow']);
  assert.deepEqual(after.stages.map(s => [s.stage, s.delivery]), [['popup_allow', 'sent']]);
  assert.equal(after.reply.popupDelivery, 'sent'); assert.equal(after.reply.popupAction, 'allow'); assert.equal(after.reply.noRetry, true);
});
add('new', 'precheck-exclusion', 'ruling 2: the read pre-check (axPageDialog) does not report a recognised permission prompt as a page dialog; it still reports an unknown bubble and a JS dialog', async () => {
  const perm = policy({ mode: 'pageDialog', ...world(promptWindow(STANDARD_EN)) });
  const unknown = policy({ mode: 'pageDialog', ...world(promptWindow(['Allow', "Don't allow"])) });
  const js = policy({ mode: 'pageDialog', ...world({ num: 50, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'x', children: [text('Leave site?'), button('Leave'), button('Cancel')] }) });
  evidence.push(`precheck-exclusion: permission → ${JSON.stringify(perm)}; unknown → ${JSON.stringify(unknown)}; JS dialog → ${JSON.stringify(js)}`);
  assert.deepEqual(perm, { dialog: null });
  assert.equal(unknown.dialog, 50); assert.equal(js.dialog, 50);
});
add('kept', 'no-popup', 'the target already on top, another app in front, or another app\'s window as the blocker: resolve reads nothing and adds no facts', async () => {
  for (const state of [{ onTop: true }, { front: 77 }, { blocker: { owner: 'Other', pid: 77, layer: 0 } }]) {
    const r = resolveCase(promptWindow(STANDARD_EN), { fx: { state } });
    assert.deepEqual(r.facts, {}, JSON.stringify(state)); assert.deepEqual(r.reads, { above: 0, shape: 0 }); assert.deepEqual(r.presses, []);
  }
  evidence.push('no-popup: 3 states, 0 reads, 0 facts');
});
add('kept', 'another-window', 'another standard Chrome window directly above the target is not a popup: no facts, no write (FOCUS4\'s destination checks decide)', async () => {
  const r = policy({ mode: 'resolve', windows: [standard(10), standard(20)], cg: [{ num: 10, pid: 42, layer: 0, bounds: [100, 100, 600, 500] }, { num: 20, pid: 42, layer: 0, bounds: [0, 40, 1000, 700] }] });
  evidence.push(`another-window: ${said(r)}`);
  assert.deepEqual(r.facts, {}); assert.deepEqual(r.presses, []);
});

add('new', 'attachment', 'r1 A1: the popup\'s window number (the only way to a picture) is reported only when its AXParent names the bound target window; another window or none: finite facts only', async () => {
  const unknownBubble = extra => promptWindow(['Save', 'Never'], extra);
  const own = resolveCase(unknownBubble({ AXParentNum: 20 })), other = resolveCase(unknownBubble({ AXParentNum: 10 })), none = resolveCase(unknownBubble());
  const allowed = resolveCase(promptWindow(STANDARD_EN, { AXParentNum: 20 }));
  evidence.push(`attachment: AXParent=target ${JSON.stringify(own.facts)}; AXParent=another window ${JSON.stringify(other.facts)}; none ${JSON.stringify(none.facts)}`);
  assert.equal(own.facts.popupWindow, 50);
  assert.equal('popupWindow' in other.facts, false); assert.equal('popupWindow' in none.facts, false);
  for (const x of [own, other, none]) { assert.equal(x.facts.popupKind, 'unknown'); assert.deepEqual(x.presses, []); }
  assert.equal(allowed.facts.popupWindow, 50); assert.deepEqual(allowed.presses, ['Allow']);
});
add('new', 'no-hold-observe', 'r1 A3: no healthy physical hold (monitored mode, a lost hold) at the write boundary: a recognised prompt is observed only (popupAction observe), zero writes', async () => {
  const r = resolveCase(promptWindow(STANDARD_EN), { fx: { held: false } });
  evidence.push(`no-hold-observe: ${said(r)}`);
  assert.equal(r.ok, true); assert.equal(r.facts.popupKind, 'permission'); assert.equal(r.facts.popupAction, 'observe');
  assert.equal(r.facts.popupDelivery, 'not_sent'); assert.deepEqual(r.presses, []); assert.deepEqual(r.stages, []);
});
add('new', 'precheck-surface', 'r1 A4: the pre-check reply says whether its dialog is positively a page\'s own (a sheet, AXModal or a Chrome JS-dialog button set: js_dialog) or an unclassified browser surface (browser); attached only when its AXParent names the bound parent', async () => {
  const cases = [
    ['unknown bubble', { num: 50, AXRole: 'AXWindow', AXSubrole: 'AXUnknown', AXModal: false, AXTitle: SENTINEL.title, children: [text(SENTINEL.text), button('Save'), button('Never')] }, {}, 'browser', false],
    ['unknown bubble, AXParent = parent', { num: 50, AXRole: 'AXWindow', AXSubrole: 'AXUnknown', AXModal: false, AXTitle: 'x', AXParentNum: 20, children: [text('t'), button('Save'), button('Never')] }, {}, 'browser', true],
    ['confirm()', { num: 50, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'x', children: [text('t'), button('OK'), button('Cancel')] }, {}, 'js_dialog', false],
    ['Leave site? (zh)', { num: 50, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'x', children: [text('t'), button('离开'), button('取消')] }, {}, 'js_dialog', false],
    ['modal, unknown labels', { num: 50, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXModal: true, AXTitle: 'x', children: [text('t'), button('Go')] }, {}, 'js_dialog', false],
    ['sheet of the parent', null, { targetAX: { AXSheets: [{ num: 50, AXRole: 'AXWindow', AXSubrole: 'AXSheet', AXTitle: 'x', children: [text('t'), button('Go')] }] }, cgOnly: true }, 'js_dialog', false],
  ];
  for (const [label, popup, o, surface, attached] of cases) {
    const r = policy({ mode: 'pageDialog', ...world(popup, o) });
    evidence.push(`precheck-surface ${label}: ${JSON.stringify(r)}`);
    assert.equal(r.dialog, 50, `${label}: ${JSON.stringify(r)}`); assert.equal(r.surface, surface, label); assert.equal(r.attached, attached, label);
    assert.equal(JSON.stringify(r).includes('SENTINEL'), false);
  }
});

/* ======================================================================== owner: Owner.run -> execute -> clearChromePrompt */

let capsule = null;
async function behaviour() {
  if (!capsule) {
    const { compileWindowBehaviorCapsule } = await import('./window-visibility-native.test.mjs');
    capsule = compileWindowBehaviorCapsule();
  }
  return capsule;
}
const activate = { op: 'nativeChrome', schema: 1, epoch: 1, operationId: 'perm1', call: 'call-A', intent: { kind: 'activate', windowId: 2, tabId: 9, fitCurrent: true } };
const clickAt = { op: 'click', aim: { x: 850, y: 650 }, rect: { x: 840, y: 640, w: 20, h: 20 } };
async function owner(name, popup, extra = {}) {
  const r = (await behaviour()).run({ name, initialBounds: [0, 40, 1000, 700], requests: [activate, clickAt], ...(popup ? { popup } : {}), ...extra });
  return { r, a: r.replies[0], click: r.replies[1], writes: r.effects.map(e => e.kind), input: r.input.map(i => i.kind) };
}
const ownerSaid = x => `activation ${x.a.ok ? 'ok' : x.a.error} popup ${x.a.popupKind}/${x.a.popupAction}/${x.a.popupDelivery}/${x.a.popupResult}; ` +
  `writes ${x.writes.join(',')}; stages ${(x.a.stages ?? []).map(s => s.stage).join(',')}; click ${x.click?.ok ? 'posted' : x.click?.why || x.click?.error}; input ${x.input.join(',') || 'none'}`;

add('new', 'owner-allow', 'through Owner.execute: a permission prompt above the bound target: the activation presses Allow once (popup_allow, sent) after its own writes, reports permission/allow/sent/cleared, and the click then lands once', async () => {
  const x = await owner('perm-allow', { labels: STANDARD_EN });
  evidence.push(`owner-allow: ${ownerSaid(x)}; popupMs ${x.a.popupMs}`);
  assert.equal(x.a.ok, true, JSON.stringify(x.a));
  assert.deepEqual(x.writes, ['index', 'main', 'raise', 'app', 'press']);
  assert.equal(x.a.stages.at(-1).stage, 'popup_allow'); assert.equal(x.a.stages.at(-1).delivery, 'sent');
  assert.deepEqual([x.a.popupKind, x.a.popupAction, x.a.popupDelivery, x.a.popupResult], ['permission', 'allow', 'sent', 'cleared']);
  assert.equal(x.a.targetOnTop, true);
  assert.ok(Number.isInteger(x.a.popupMs) && x.a.popupMs <= 1200, `G8: ≤ 1.2 s added (${x.a.popupMs} ms)`);
  assert.equal(x.click?.ok, true, JSON.stringify(x.click)); assert.deepEqual(x.input, ['down', 'up']);
});
add('new', 'owner-press-unknown', 'through Owner.execute: the press fails: popup_press_unknown, inputDelivery unknown, noRetry, the popup facts on the reply; the click after it is refused by the Session (no input)', async () => {
  const x = await owner('perm-press-unknown', { labels: STANDARD_EN, pressFails: true });
  evidence.push(`owner-press-unknown: ${ownerSaid(x)}`);
  assert.equal(x.a.ok, false); assert.equal(x.a.error, 'popup_press_unknown'); assert.equal(x.a.inputDelivery, 'unknown'); assert.equal(x.a.noRetry, true);
  assert.equal(x.a.popupDelivery, 'unknown'); assert.equal(x.writes.filter(w => w === 'press').length, 1);
  assert.deepEqual(x.input, []);
});
add('kept', 'owner-unknown-not-pressed', 'through Owner.execute: an unknown bubble, an unbound one and a modal window above the target are never pressed; the activation completes with the facts (FOCUS4: the landing point decides the click)', async () => {
  for (const [label, popup] of [['unknown labels', { labels: ['Allow', "Don't allow"] }], ['unbound', { labels: STANDARD_EN, bound: false }],
    ['modal', { labels: STANDARD_EN, modal: true }]]) {
    const x = await owner(`perm-${label.replace(/\W+/g, '-')}`, popup);
    evidence.push(`owner-unknown-not-pressed (${label}): ${ownerSaid(x)}`);
    assert.equal(x.a.ok, true, label); assert.equal(x.writes.includes('press'), false, label);
    assert.equal(x.a.popupAction, 'none', label); assert.equal(x.a.popupDelivery, 'not_sent', label);
    assert.equal(x.a.popupKind, label === 'modal' ? 'js_dialog' : 'unknown', label);
    assert.equal('popupWindow' in x.a, false, `${label}: no attachment evidence, so no window number for a picture (r1 A1)`);
  }
});
add('new', 'owner-monitored', 'r1 A3 through Owner.execute and the Session\'s own owner() wiring: monitored mode (no takeover, no hold): the prompt is observed only, zero presses', async () => {
  const x = await owner('perm-monitored', { labels: STANDARD_EN }, { takeover: false, holding: false });
  evidence.push(`owner-monitored: ${ownerSaid(x)}`);
  assert.equal(x.a.ok, true, JSON.stringify(x.a)); assert.equal(x.writes.includes('press'), false);
  assert.equal(x.a.popupKind, 'permission'); assert.equal(x.a.popupAction, 'observe'); assert.equal(x.a.popupDelivery, 'not_sent');
});
add('kept', 'owner-lost-hold', 'r1 A3 through Owner.execute: the hold is lost right before the popup write: the activation stops (hold_ended), zero presses, zero input', async () => {
  const x = await owner('perm-lost-hold', { labels: STANDARD_EN }, { stopStage: 'popup_press_prepare', stopKind: 'hold' });
  evidence.push(`owner-lost-hold: ${ownerSaid(x)}`);
  assert.equal(x.a.ok, false, JSON.stringify(x.a)); assert.equal(x.writes.includes('press'), false); assert.deepEqual(x.input, []);
});
add('kept', 'owner-no-popup', 'through Owner.execute: no popup: no popup facts, writes and click as FOCUS4', async () => {
  const x = await owner('perm-none', null);
  assert.equal(x.a.ok, true); assert.equal('popupKind' in x.a, false); assert.deepEqual(x.writes, ['index', 'main', 'raise', 'app']); assert.deepEqual(x.input, ['down', 'up']);
  evidence.push(`owner-no-popup: ${ownerSaid(x)}`);
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
for (const line of evidence) console.log(`  evidence  ${line}`);
console.log(`\nperm-prompt tests: ${passed} passed, ${failed} failed. Artifacts: ${tmp}${capsule ? `, ${capsule.dir}` : ''}`);
process.exit(failed ? 1 : 0);
