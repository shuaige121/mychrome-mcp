/* The real AX dialog predicates, compiled against synthetic metadata only.
 * No Chrome, UI, field contents or input devices are accessed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { PAGE_PROMPT_CATALOG, matchPromptRule, normalizePagePromptSettings } from '../src/page-events.js';

const swift = fs.readFileSync(process.env.NATIVE_CHROME_SOURCE || new URL('../src/native-chrome.swift', import.meta.url), 'utf8').replaceAll('static func ', 'func ');
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
let kAXTextFieldRole = "AXTextField", kAXTextAreaRole = "AXTextArea"
let kAXModalAttribute = "AXModal", kAXFocusedAttribute = "AXFocused", kAXMainAttribute = "AXMain"
let kAXFocusedWindowAttribute = "AXFocusedWindow"
let kCGWindowOwnerPID = "pid", kCGWindowLayer = "layer"
let kCGWindowNumber = "num", kCGWindowBounds = "bounds", kCGNullWindowID = 0
let axMessagingTimeout: Float = 1.0
enum AXError: Int32 { case success = 0, failure = -25200, invalidUIElement = -25202, cannotComplete = -25204, attributeUnsupported = -25205, noValue = -25212 }
// NAT-RETRY: axPageDialog's rescan reads the owner's first failure (none here).
var firstFailure: Error? = nil, axRetries = 0, axLastError: Int? = nil
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
func CFEqual(_ a: AXUIElement, _ b: AXUIElement) -> Bool { a === b }
func CFHash(_ a: AXUIElement) -> Int { a.number }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Float) {}
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ key: String, _ value: inout CFTypeRef?) -> AXError {
    if (element.attrs["noValueAttributes"] as? [String])?.contains(key) == true { return .noValue }
    if key == "AXSheets" && element.attrs[key] == nil { return .attributeUnsupported }
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
if fixture["unreadableWindows"] as? Bool != true { application.attrs[kAXWindowsAttribute] = wins as AnyObject }
if let focused = fixture["focused"] as? Int, let element = wins.first(where: { $0.number == focused }) {
    application.attrs[kAXFocusedWindowAttribute] = element
}
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { application }
func axWindowNumber(_ element: AXUIElement) -> Int? { element.number == 0 ? nil : element.number }

func CGWindowListCopyWindowInfo(_ options: CGOptions, _ number: Int) -> Any? { fixture["cg"] }
${swift.slice(swift.indexOf('struct DialogFailure:'), swift.indexOf('func dialogInt('))}
enum ChromeNative { ${productionFunction('promptText').replace('func promptText(', 'static func promptText(')} }
// PERM1: the permission-prompt exclusion is exercised by test/perm-prompt.test.mjs; inert here.
func axIsChromePermissionPrompt(_ w: AXUIElement, pid: pid_t) -> Bool { false }
${['axIsWindowSharingIndicator', 'axIsInputSourceIndicator', 'axIsChromeTranslationBubble', 'axPageDialog', 'axRetryPause'].map(productionFunction).join('\n')}
var result: [String: Any] = ["excluded": wins.isEmpty ? false : axIsInputSourceIndicator(wins[0], pid: 7)]
do {
    if let dialog = try axPageDialog(pid: 7) {
        result["dialog"] = dialog.window.number
        if fixture["details"] as? Bool == true { result["details"] = ["complete": dialog.templateComplete, "title": dialog.title, "texts": dialog.texts, "buttons": dialog.buttons.map { $0.0 }, "hasField": dialog.hasField] }
    }
} catch let e as DialogFailure { result["error"] = e.code }
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

test('actual scanner refuses auto when a reviewed 300-character prefix hides a different suffix', () => {
  const catalog = structuredClone(PAGE_PROMPT_CATALOG), template = catalog.templates[1], prefix = 'x'.repeat(300);
  template.texts = [prefix];
  const f = { details: true, focused: 31, windows: [{ num: 31, AXRole: 'AXWindow', AXSubrole: 'AXDialog',
    AXTitle: template.title, AXModal: true, AXFocused: true, AXMain: false, children: [
      { AXRole: 'AXStaticText', AXValue: prefix + ' DIFFERS AFTER DISPLAY PREFIX', children: [] },
      ...template.buttons.map(AXTitle => ({ AXRole: 'AXButton', AXTitle, children: [] })) ] }], cg: [] };
  const raw = { version: 1, policy: 'auto_safe', rules: [{ id: 'native_rule', enabled: true, origin: template.origins[0],
    templateId: template.id, templateVersion: 1, semantic: 'keep_session', button: template.choices.keep_session }] };
  const negative = result => {
    assert.deepEqual(result.details.texts, [prefix], 'display prefix still matches the reviewed template');
    assert.equal(result.details.complete, false);
    assert.equal(matchPromptRule({ ...result.details, kind: 'native', origin: template.origins[0], originEvidence: 'native_current_snapshot' }, normalizePagePromptSettings(raw, catalog), catalog), null);
  };
  negative(run(f));
  const guard = 'if v.count > 300 || ChromeNative.promptText(value) != ChromeNative.promptText(v) { templateComplete = false }';
  assert.ok(program.includes(guard));
  const mutantFile = path.join(tmp, 'mutant.swift'), mutantBin = path.join(tmp, 'mutant');
  fs.writeFileSync(mutantFile, program.replace(guard, '/* completeness guard removed only in inert fixture */'));
  execFileSync('/usr/bin/swiftc', [mutantFile, '-o', mutantBin], { stdio: 'pipe' });
  assert.throws(() => negative(JSON.parse(execFileSync(mutantBin, [JSON.stringify(f)], { encoding: 'utf8' }))), assert.AssertionError);
  f.windows[0].children[0].AXValue = prefix;
  assert.equal(run(f).details.complete, true);
});

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
    const r = run(f);
    assert.equal(r.excluded, false);
    assert.ok(r.dialog === 21 || ['dialog_probe_unknown', 'dialog_ambiguous'].includes(r.error), JSON.stringify(r));
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
      { AXRole: 'AXStaticText', AXValue: 'Continue?', children: [] }, { AXRole: 'AXButton', AXTitle: 'OK', children: [] },
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
        { AXRole: 'AXStaticText', AXValue: 'Capslock Enabled', children: [] },
        { AXRole: 'AXButton', AXTitle: 'OK', children: [] },
        ...(kind !== 'alert' ? [{ AXRole: 'AXButton', AXTitle: 'Cancel', children: [] }] : []),
        ...(kind === 'prompt' ? [{ AXRole: 'AXTextField', AXValue: '', children: [] }] : []),
      ],
    });
    f.focused = 31;
    assert.deepEqual(run(f), { excluded: true, dialog: 31 });
  });
}

test('a Caps Lock label alone cannot exclude an unknown native window', () => {
  assert.deepEqual(run({ windows: [{ num: 21, AXSubrole: 'AXDialog', AXTitle: '',
    children: [{ AXRole: 'AXButton', AXTitle: 'Capslock Enabled' }] }], cg: [] }),
  { excluded: false, error: 'dialog_probe_unknown' });
});

const alertFixture = () => ({ windows: [{ num: 31, AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'example.test says',
  children: [{ AXRole: 'AXStaticText', AXValue: 'Continue?', children: [] }, { AXRole: 'AXButton', AXTitle: 'OK', children: [] }] }], cg: [] });

test('complete empty inspection is different from unreadable AXWindows', () => {
  assert.deepEqual(run({ windows: [], cg: [] }), { excluded: false });
  assert.deepEqual(run({ windows: [], cg: [], unreadableWindows: true }), { excluded: false, error: 'dialog_probe_unknown' });
});
test('multiple dialogs are ambiguous regardless of enumeration order', () => {
  const a = alertFixture(), b = alertFixture().windows[0]; b.num = 32;
  a.windows.push(b);
  assert.equal(run(a).error, 'dialog_ambiguous');
  a.windows.reverse(); assert.equal(run(a).error, 'dialog_ambiguous');
});
for (const [name, change] of [
  ['unreadable child', f => { delete f.windows[0].children[0].children; }],
  ['missing role', f => { delete f.windows[0].children[0].AXRole; }],
  ['missing title', f => { delete f.windows[0].AXTitle; }],
  ['malformed child collection', f => { f.windows[0].children = 'unknown'; }],
  ['node budget', f => { f.windows[0].children.push(...Array.from({ length: 601 }, () => ({ AXRole: 'AXGroup', children: [] }))); }],
  ['depth budget', f => { let root = f.windows[0]; for (let i = 0; i < 14; i++) { const next = { AXRole: 'AXGroup', children: [] }; root.children.push(next); root = next; } }],
]) test(`${name} never becomes no dialog`, () => { const f = alertFixture(); change(f); assert.equal(run(f).error, 'dialog_probe_unknown'); });

test('prompt values are never read by the scanner', () => {
  const f = alertFixture(); f.windows[0].children.push({ AXRole: 'AXTextField', children: [] });
  assert.equal(run(f).dialog, 31);
});

test('the proven sharing indicator remains excluded while a real alert is detected', () => {
  const indicator = { num: 21, AXRole:'AXWindow', AXSubrole:'AXDialog', AXTitle:'Window',
    children:[{ AXRole:'AXButton', AXTitle:'WindowSharingSessionButton', children:[] }] };
  assert.deepEqual(run({windows:[indicator],cg:[]}),{excluded:false});
  assert.equal(run({windows:[indicator,...alertFixture().windows],cg:[]}).dialog,31);
});
test('the complete nonmodal Translate shape remains excluded, with an alert still protected', () => {
  const title='Translate this page?';
  const bubble={num:41,AXRole:'AXWindow',AXSubrole:'AXUnknown',AXTitle:title,AXModal:false,AXFocused:false,AXMain:false,children:[{
    AXRole:'AXGroup',AXSubrole:'AXApplicationAlertDialog',AXTitle:title,children:[
      {AXRole:'AXTabGroup',children:['English','Chinese'].map(t=>({AXRole:'AXRadioButton',AXSubrole:'AXTabButton',AXTitle:t,children:[]}))},
      ...['Translate options','Close'].map(t=>({AXRole:'AXButton',AXTitle:t,children:[]})),
    ],
  }]};
  assert.deepEqual(run({windows:[bubble],cg:[]}),{excluded:false});
  assert.equal(run({windows:[bubble,...alertFixture().windows],cg:[]}).dialog,31);
  bubble.AXModal=true;
  assert.equal(run({windows:[bubble],cg:[]}).dialog,41);
});
