/* The real AX dialog predicates, compiled against synthetic metadata only.
 * No Chrome, UI, field contents or input devices are accessed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const swift = fs.readFileSync(process.env.CHROMECTL_SOURCE || new URL('../src/chromectl.swift', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = swift.indexOf(`func ${name}(`);
  assert.ok(start >= 0, name);
  return swift.slice(start, swift.indexOf('\n}', start) + 2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-input-source-dialog-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const program = `
import Foundation
typealias CFTypeRef = AnyObject
typealias CFString = String
let kAXWindowsAttribute = "AXWindows", kAXSubroleAttribute = "AXSubrole"
let kAXRoleAttribute = "AXRole", kAXTitleAttribute = "AXTitle"
let kAXDescriptionAttribute = "AXDescription", kAXValueAttribute = "AXValue"
let kAXChildrenAttribute = "AXChildren", kAXStandardWindowSubrole = "AXStandardWindow"
let kAXDialogSubrole = "AXDialog", kAXWindowRole = "AXWindow"
let kAXButtonRole = "AXButton", kAXStaticTextRole = "AXStaticText"
let kAXModalAttribute = "AXModal", kAXFocusedAttribute = "AXFocused", kAXMainAttribute = "AXMain"
let kAXFocusedWindowAttribute = "AXFocusedWindow"
let kCGWindowOwnerPID = "pid", kCGWindowLayer = "layer"
let kCGWindowNumber = "num", kCGWindowBounds = "bounds", kCGNullWindowID = 0
let axMessagingTimeout: Float = 1.0
enum AXError { case success, failure, noValue }
final class AXUIElement {
    var attrs: [String: AnyObject] = [:]
    let number: Int
    init(_ row: [String: Any]) {
        number = row["num"] as? Int ?? 0
        for (key, value) in row where key != "children" && key != "num" { attrs[key] = value as AnyObject }
        if let children = row["children"] as? [[String: Any]] {
            attrs[kAXChildrenAttribute] = children.map { AXUIElement($0) } as AnyObject
        }
    }
}
func CFGetTypeID(_ value: CFTypeRef) -> Int { value is AXUIElement ? 1 : 0 }
func AXUIElementGetTypeID() -> Int { 1 }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Float) {}
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ key: String, _ value: inout CFTypeRef?) -> AXError {
    if (element.attrs["noValueAttributes"] as? [String])?.contains(key) == true { return .noValue }
    guard let found = element.attrs[key] else { return .failure }
    value = found; return .success
}
struct CGOptions: OptionSet {
    let rawValue: Int
    static let optionAll = CGOptions(rawValue: 1)
}
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
let wins = (fixture["windows"] as! [[String: Any]]).map { AXUIElement($0) }
let application = AXUIElement([:])
application.attrs[kAXWindowsAttribute] = wins as AnyObject
if let focused = fixture["focused"] as? Int, let element = wins.first(where: { $0.number == focused }) {
    application.attrs[kAXFocusedWindowAttribute] = element
}
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { application }
func axWindowNumber(_ element: AXUIElement) -> Int? { element.number == 0 ? nil : element.number }
func axFirstTextField(in root: AXUIElement) -> AXUIElement? { nil }
func CGWindowListCopyWindowInfo(_ options: CGOptions, _ number: Int) -> Any? { fixture["cg"] }
${['axIsWindowSharingIndicator', 'axIsInputSourceIndicator', 'axPageDialog'].map(productionFunction).join('\n')}
var result: [String: Any] = ["excluded": axIsInputSourceIndicator(wins[0], pid: 7)]
if let dialog = axPageDialog(pid: 7) { result["dialog"] = dialog.window.number }
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`;
const source = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'probe');
fs.writeFileSync(source, program);
execFileSync('/usr/bin/swiftc', [source, '-o', binary], { stdio: 'pipe' });
const run = fixture => {
  const result = spawnSync(binary, [JSON.stringify(fixture)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const fixture = () => ({
  focused: 11,
  windows: [{
    num: 21, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: '',
    AXModal: false, AXFocused: false, AXMain: false,
    children: [{
      AXRole: 'AXButton', AXTitle: '', AXDescription: 'com.tencent.inputmethod.wetype.pinyin',
      AXFocused: false, children: [],
    }],
  }, { num: 11, AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow', AXTitle: '', children: [] }],
  cg: [{ num: 21, pid: 7, layer: 3, bounds: { X: 618, Y: 858, Width: 84, Height: 77 } }],
});
// The incident retained only axPageDialog's resolved button label, not raw AX
// attributes. Exercise both label positions within the existing proven shape;
// this fixture does not claim the historical indicator's full native metadata.
const capsLockFixture = (label = 'AXDescription') => {
  const f = fixture(), button = f.windows[0].children[0];
  button.AXTitle = '';
  button.AXDescription = '';
  button[label] = 'Capslock Enabled';
  return f;
};
const indicators = [
  ['input-source', fixture],
  ['caps-lock description', () => capsLockFixture()],
  ['caps-lock title', () => capsLockFixture('AXTitle')],
];

test('observed nonmodal input-source indicator is not reported as a page dialog', () => {
  assert.deepEqual(run(fixture()), { excluded: true });
});

test('the observed AX noValue for the leaf button children is accepted', () => {
  const f = fixture();
  delete f.windows[0].children[0].children;
  f.windows[0].children[0].noValueAttributes = ['AXChildren'];
  assert.deepEqual(run(f), { excluded: true });
});

for (const [name, makeFixture] of indicators.slice(1)) {
  test(`${name} in the narrow nonmodal native shape is not a page dialog`, () => {
    assert.deepEqual(run(makeFixture()), { excluded: true });
  });
  test(`${name} accepts a proven noValue leaf, not an unreadable subtree`, () => {
    const f = makeFixture();
    delete f.windows[0].children[0].children;
    f.windows[0].children[0].noValueAttributes = ['AXChildren'];
    assert.deepEqual(run(f), { excluded: true });
  });
}

for (const [indicator, makeFixture] of indicators) {
for (const [name, change] of [
  ['modal window', f => { f.windows[0].AXModal = true; }],
  ['focused window', f => { f.windows[0].AXFocused = true; }],
  ['main window', f => { f.windows[0].AXMain = true; }],
  ['application focused window disagrees with its flag', f => { f.focused = 21; }],
  ['unreadable application focus', f => { delete f.focused; }],
  ['unreadable modal state', f => { delete f.windows[0].AXModal; }],
  ['unreadable title', f => { delete f.windows[0].AXTitle; }],
  ['named dialog', f => { f.windows[0].AXTitle = 'Confirm'; }],
  ['system dialog', f => { f.windows[0].AXSubrole = 'AXSystemDialog'; }],
  ['extra text', f => { f.windows[0].children.push({ AXRole: 'AXStaticText', AXValue: 'An actual prompt' }); }],
  ['extra button', f => { f.windows[0].children.push({ AXRole: 'AXButton', AXTitle: 'Cancel' }); }],
  ['button with its own label', f => { f.windows[0].children[0].AXTitle = 'OK'; }],
  ['another provider', f => { f.windows[0].children[0].AXDescription = 'com.example.inputmethod'; }],
  ['focused button', f => { f.windows[0].children[0].AXFocused = true; }],
  ['nested dialog content', f => { f.windows[0].children[0].children.push({ AXRole: 'AXStaticText', AXValue: 'Confirm' }); }],
  ['unreadable button children', f => { delete f.windows[0].children[0].children; }],
  ['unreadable CG metadata', f => { f.cg = []; }],
  ['different CG owner', f => { f.cg[0].pid = 8; }],
  ['ordinary layer-zero dialog', f => { f.cg[0].layer = 0; }],
  ['larger floating dialog', f => { f.cg[0].bounds.Width = 400; }],
  ['invalid bounds', f => { f.cg[0].bounds.Height = 0; }],
]) {
  test(`${indicator}: ${name} remains protected`, () => {
    const f = makeFixture(); change(f);
    assert.deepEqual(run(f), { excluded: false, dialog: 21 });
  });
}
}

for (const [indicator, makeFixture] of indicators) {
  for (const attribute of ['AXTitle', 'AXDescription']) {
    test(`${indicator}: unreadable ${attribute} is not proof of an indicator`, () => {
      const f = makeFixture();
      delete f.windows[0].children[0][attribute];
      assert.equal(run(f).excluded, false);
    });
  }
}

test('a genuine page alert behind the indicator is still returned', () => {
  const f = fixture();
  f.windows.push({
    num: 31, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'example.test says',
    AXModal: true, children: [
      { AXRole: 'AXStaticText', AXValue: 'Continue?' }, { AXRole: 'AXButton', AXTitle: 'OK' },
    ],
  });
  assert.deepEqual(run(f), { excluded: true, dialog: 31 });
});

for (const kind of ['alert', 'confirm', 'prompt']) {
  test(`Caps Lock indicator cannot hide a genuine page ${kind}`, () => {
    const f = capsLockFixture();
    f.windows.push({
      num: 31, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'example.test says',
      AXModal: true, AXFocused: true, AXMain: false,
      children: [
        { AXRole: 'AXStaticText', AXValue: 'Capslock Enabled' },
        { AXRole: 'AXButton', AXTitle: 'OK' },
        ...(kind !== 'alert' ? [{ AXRole: 'AXButton', AXTitle: 'Cancel' }] : []),
        ...(kind === 'prompt' ? [{ AXRole: 'AXTextField', AXValue: '' }] : []),
      ],
    });
    f.focused = 31;
    assert.deepEqual(run(f), { excluded: true, dialog: 31 });
  });
}

test('a Caps Lock label alone cannot exclude an unknown native window', () => {
  assert.deepEqual(run({ windows: [{ num: 21, AXSubrole: 'AXDialog', AXTitle: '',
    children: [{ AXRole: 'AXButton', AXTitle: 'Capslock Enabled' }] }], cg: [] }),
  { excluded: false, dialog: 21 });
});
