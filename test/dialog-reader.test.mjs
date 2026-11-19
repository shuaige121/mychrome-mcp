// Deterministic DOM geometry and extracted native reader with inert AX doubles only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';
import { createPageFeedback } from '../src/page-feedback.js';
const source = await readFile(new URL('../src/page/read.js', import.meta.url), 'utf8');
const locateSource = await readFile(new URL('../src/page/locate.js', import.meta.url), 'utf8');
let passed = 0;
function test(name, run) { run(); console.log(`ok ${++passed} ${name}`); }
function page(html, run) {
  const w = new JSDOM(`<title>Fixture</title><body><h1>Page</h1><p>UNCHANGED_BODY</p>${html}</body>`, {
    url: 'https://fixture.invalid/dialog-reader', runScripts: 'outside-only', pretendToBeVisual: true,
  }).window;
  w.Element.prototype.getBoundingClientRect = function () {
    for (let p = this; p; p = p.parentElement) {
      const s = w.getComputedStyle(p);
      if (p.hidden || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') {
        return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      }
    }
    const x = +(this.dataset.x || 10), y = +(this.dataset.y || 10);
    const width = +(this.dataset.width || 80), height = +(this.dataset.height || 30);
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
  };
  w.Element.prototype.getClientRects = function () { const r = this.getBoundingClientRect(); return r.width ? [r] : []; };
  // Layout-only fixture, matching default browser computed overflow values.
  const computed = w.getComputedStyle.bind(w);
  w.getComputedStyle = el => {
    const style = computed(el);
    return new Proxy(style, { get(target, key) {
      if (key === 'overflowX' || key === 'overflowY') return el.style[key] || el.style.overflow || target[key] || target.overflow || 'visible';
      return target[key];
    } });
  };
  const read = (req = {}, script = source) => JSON.parse(w.eval(script.replaceAll('__READ__', () => JSON.stringify(req))));
  const snapshot = (baseline = null, script = source) => read({ actionSnapshot: true,
    ...(baseline ? { baselineControls: baseline.controls.map(({ n, line }) => ({ n, line })) } : {}) }, script);
  const control = (result, id) => result.controls.find(c => w.__chromeBridge.markers[c.n] === w.document.getElementById(id));
  const locate = id => JSON.parse(w.eval(Object.entries({ MARKER: w.__chromeBridge.markers.indexOf(w.document.getElementById(id)),
    MODE: 'target', SCROLL: false, DIR: 'down' }).reduce((s, [key, value]) => s.replaceAll(`__${key}__`, () => JSON.stringify(value)), locateSource)));
  try { return run({ w, d: w.document, read, snapshot, control, locate }); } finally { w.close(); }
}
const panel = '<aside role="dialog"><p>Choose a route</p><button id="choice">New choice</button></aside>';

function structureCheck(script = source) {
  page('<div id="launcher" role="button">Open choices<div><section role="dialog"><p>DIALOG_PROSE</p>' +
    '<button id="close" aria-label="Close"></button><button id="choice"><img alt="Use fixture identity" style="pointer-events:none"></button>' +
    '</section></div></div>', ({ d, w, snapshot, control, read }) => {
    const result = snapshot(null, script);
    assert.equal(control(result, 'launcher')?.label, 'Open choices', 'meaningful visible launcher must keep only its own label');
    assert.equal(control(result, 'choice')?.label, 'Use fixture identity', 'real image alt is the option name');
    for (const id of ['launcher', 'close', 'choice']) assert.ok(w.__chromeBridge.markers.includes(d.getElementById(id)), id);
    const compact = read({}, script);
    assert.match(compact.text, /DIALOG_PROSE/, 'dialog prose must cross the actionable ancestor boundary');
    assert.match(compact.text, /Use fixture identity/);
    assert.doesNotMatch(compact.text, /UNCHANGED_BODY/);
    assert.doesNotMatch(control(result, 'launcher').line, /DIALOG_PROSE|Close|fixture identity/);
  });
}
test('visible nested launcher, independent dialog structure, and real image alt stay distinct', () => structureCheck());

function dialogRootCheck(script = source) {
  for (const outer of [false, true]) {
    const dialog = '<section id="dialogRoot" role="dialog" onclick="event.stopPropagation()"><p>Choose a route</p>' +
      '<button id="choice">Continue</button><button id="close">Close</button><textarea>PRIVATE_DRAFT</textarea></section>';
    page(outer ? '<div id="launcher" role="button">Open choices' + dialog + '</div>' : dialog,
      ({ d, w, snapshot, control, read }) => {
        const before = snapshot(null, script);
        const ids = ['choice', 'close'].map(id => {
          const item = control(before, id);
          assert.ok(item, `onclick dialog root swallowed ${id}`);
          assert.equal(w.__chromeBridge.markers[item.n], d.getElementById(id));
          return item.n;
        });
        if (outer) assert.equal(control(before, 'launcher')?.label, 'Open choices');
        assert.doesNotMatch(JSON.stringify(before), /PRIVATE_DRAFT/);
        d.body.insertAdjacentHTML('afterbegin', '<button>Unrelated insertion</button>');
        const after = snapshot(before, script);
        for (const [i, id] of ['choice', 'close'].entries()) assert.equal(control(after, id)?.n, ids[i]);
        const compact = read({}, script);
        for (const id of ids) assert.match(compact.text, new RegExp('\\[' + id + '\\] button'));
      });
  }
}
test('an onclick dialog root never aggregates its inner buttons, including with an outer launcher', () => dialogRootCheck());

test('empty backdrops are omitted while named and hidden-dialog launchers remain actionable', () => {
  page('<div id="backdrop" role="button">' + panel + '</div>' +
    '<div id="named" role="button" aria-label="Show options"><div role="dialog"><button>Named option</button></div></div>' +
    '<div id="hiddenLauncher" role="button">Open hidden panel<div role="dialog" hidden><button>HIDDEN_CHOICE</button></div></div>' +
    '<button id="nativeLauncher">Native launcher<span role="dialog"><span>Nested description</span></span></button>', ({ snapshot, control }) => {
    const result = snapshot();
    assert.equal(control(result, 'backdrop'), undefined);
    assert.equal(control(result, 'named')?.label, 'Show options');
    assert.equal(control(result, 'hiddenLauncher')?.label, 'Open hidden panel');
    assert.equal(control(result, 'nativeLauncher')?.label, 'Native launcher');
    assert.doesNotMatch(JSON.stringify(result), /HIDDEN_CHOICE/);
  });
});

test('nonmodal background actions use node identity even with duplicate label and rectangle', () => {
  page('<button id="old">Same action</button>' + panel, ({ d, snapshot, control, w }) => {
    const before = snapshot();
    d.body.insertAdjacentHTML('beforeend', '<button id="new">Same action</button>');
    d.elementFromPoint = () => d.getElementById('new');
    const after = snapshot(before);
    assert.equal(control(after, 'new')?.visible, true);
    assert.notEqual(control(after, 'new')?.n, control(before, 'old')?.n);
    assert.equal(w.__chromeBridge.markers[control(before, 'old').n], d.getElementById('old'));
  });
});

function gridCheck(script = source) {
  page('<button id="target" data-width="100" data-height="100">Old</button>' + panel, ({ d, snapshot, control, locate }) => {
    const before = snapshot(null, script); d.getElementById('target').textContent = 'Changed';
    // The only exposed region is around (30%, 70%): missed by old 3x3 and five-point samples.
    d.elementFromPoint = (x, y) => Math.abs(x - 40) < 5 && Math.abs(y - 80) < 5 ? d.getElementById('target') : d.querySelector('aside');
    const after = snapshot(before, script);
    assert.equal(control(after, 'target').visible, true, 'a click-locator reachable point must survive reader filtering');
    assert.equal(locate('target').hitOk, true, 'the production locator reaches this exact point');
  });
}
test('all click search points are considered before excluding a covered candidate', () => gridCheck());

test('wide text aim agrees with the real click locator and pointer-events descendants', () => {
  page('<button id="target" data-width="500">Old <img id="art" alt="Art" style="pointer-events:none"></button>' + panel,
    ({ d, w, snapshot, control, locate }) => {
      const before = snapshot(); d.getElementById('target').firstChild.nodeValue = 'Changed';
      w.Range.prototype.getClientRects = () => [{ left: 30, top: 15, width: 80, height: 15 }];
      d.elementFromPoint = (x, y) => Math.abs(x - 70) < 5 && Math.abs(y - 22.5) < 5 ? d.getElementById('target') : d.querySelector('aside');
      assert.equal(control(snapshot(before), 'target').visible, true);
      const actual = locate('target'); assert.equal(actual.hitOk, true); assert.equal(actual.aimAt, 'label');
      // A descendant hit also proves this exact ancestor target is reachable.
      d.elementFromPoint = () => d.getElementById('art');
      assert.equal(control(snapshot(before), 'target').visible, true);
    });
});

test('full occlusion hides only new/changed controls; uncertainty retains candidates', () => {
  page('<button id="target">Old</button>' + panel, ({ d, snapshot, control }) => {
    let calls = 0; d.elementFromPoint = () => { calls++; return d.querySelector('aside'); };
    const before = snapshot(); assert.equal(calls, 0, 'before snapshot must do no hit tests');
    let after = snapshot(before); assert.equal(calls, 0, 'unchanged controls must do no hit tests');
    d.getElementById('target').textContent = 'Changed';
    after = snapshot(before); assert.equal(control(after, 'target').visible, false); assert.equal(calls, 26);
    assert.equal(after.controlsComplete, true); assert.equal(after.reachabilityComplete, true);
    for (const hit of [() => null, () => { throw new Error('hit API unavailable'); }]) {
      d.elementFromPoint = hit; after = snapshot(before);
      assert.equal(control(after, 'target').visible, true); assert.equal(after.reachabilityComplete, false);
    }
    delete d.elementFromPoint; after = snapshot(before);
    assert.equal(control(after, 'target').visible, true); assert.equal(after.reachabilityComplete, false);
  });
});

test('clipped and partially offscreen uncertain geometry never silently excludes an option', () => {
  for (const html of ['<div style="overflow:hidden"><button id="target">Old</button></div>',
    '<button id="target" data-x="-60" data-width="80">Old</button>']) {
    page(html + panel, ({ d, snapshot, control }) => {
      const before = snapshot(); d.getElementById('target').textContent = 'Changed';
      d.elementFromPoint = () => d.querySelector('aside');
      const after = snapshot(before);
      assert.equal(control(after, 'target').visible, true, html); assert.equal(after.reachabilityComplete, false);
    });
  }
});

function budgetCheck(script = source) {
  page(Array.from({ length: 20 }, (_, i) => `<button id="b${i}">Old ${i}</button>`).join('') + panel,
    ({ d, snapshot, control }) => {
      const before = snapshot(null, script); let hits = 0;
      for (let i = 0; i < 20; i++) d.getElementById(`b${i}`).textContent = `Changed ${i}`;
      d.elementFromPoint = () => { hits++; return d.querySelector('aside'); };
      const after = snapshot(before, script);
      assert.ok(hits <= 200, `hit budget exceeded: ${hits}`);
      assert.equal(after.reachabilityComplete, false);
      assert.equal(after.controlsComplete, true, 'unknown reachability must not discard complete control data');
      assert.equal(control(after, 'b19').visible, true, 'budget exhaustion retains untested controls');
    });
}
test('one snapshot has a hard 200-hit budget and conservatively retains untested controls', () => budgetCheck());

test('large DOM measurement: baseline and unchanged polls do zero hits, one changed candidate stays bounded', () => {
  page(Array.from({ length: 2000 }, (_, i) => `<button id="b${i}">Old ${i}</button>`).join('') + panel,
    ({ d, snapshot, control }) => {
      let hits = 0; d.elementFromPoint = () => { hits++; return d.querySelector('aside'); };
      const start = performance.now(), before = snapshot(), baselineMs = performance.now() - start;
      assert.equal(before.controls.length, 2001); assert.equal(hits, 0);
      const unchangedStart = performance.now(); snapshot(before); const unchangedMs = performance.now() - unchangedStart;
      assert.equal(hits, 0);
      d.getElementById('b1999').textContent = 'Changed';
      const deltaStart = performance.now(), after = snapshot(before), deltaMs = performance.now() - deltaStart;
      assert.equal(control(after, 'b1999').visible, false); assert.equal(hits, 26);
      console.log(JSON.stringify({ measurement: '2001-control-dialog', baselineMs: Math.round(baselineMs),
        unchangedMs: Math.round(unchangedMs), deltaMs: Math.round(deltaMs), baselineHits: 0, unchangedHits: 0, deltaHits: hits }));
    });
});

test('private descendant text and alt attributes never leak through dialog ancestor labels', () => {
  page('<div role="button">Open panel<textarea>PRIVATE_DRAFT</textarea><div role="dialog"><button id="choice">Public choice</button>' +
    '<div role="textbox">PRIVATE_EDITABLE<img alt="PRIVATE_ALT"></div><input type="password" value="PRIVATE_PASSWORD"></div></div>',
    ({ snapshot }) => assert.doesNotMatch(JSON.stringify(snapshot()), /PRIVATE_/));
});

function persistentCheck(script = source) {
  page('<aside role="dialog"><p>' + 'LONG_PROSE '.repeat(1400) + '</p>' +
    Array.from({ length: 350 }, (_, i) => `<button>Choice ${i}</button>`).join('') + '</aside>', ({ w, read }) => {
    const first = read({}, script), block = first.blocks.find(b => b.id === 'popup');
    assert.ok(block.lines.join('\n').length <= 6000, 'persistent dialog block is bounded before server feedback');
    assert.match(block.lines.join('\n'), /truncated/);
    assert.match(block.lines.join('\n'), /Choice 0/);
    assert.doesNotMatch(first.text, /UNCHANGED_BODY/);
    for (const [line, target] of Object.entries(block.lineTargets)) {
      assert.ok(block.lines[+line].startsWith(target));
      assert.ok(w.__chromeBridge.markers[+target.match(/\[(\d+)\]/)[1]]?.isConnected);
    }
    const feedback = createPageFeedback();
    const deliver = result => feedback.render({ ...result, target: { tabId: 7, windowId: 9 } }, { budget: 20000 });
    deliver(first); const repeated = deliver(read({}, script));
    assert.doesNotMatch(repeated, /LONG_PROSE|Choice 0|UNCHANGED_BODY/);
  });
}
test('persistent dialog prose and controls stay bounded with usable markers and no repeated page body', () => persistentCheck());

test('dialog prose remains visible when the panel has no actionable controls', () => {
  page('<div role="button">Open message<aside role="dialog"><p>Panel message</p></aside></div>', ({ read }) => {
    assert.match(read().text, /Panel message/); assert.doesNotMatch(read().text, /UNCHANGED_BODY/);
  });
});

test('fault injection detects ancestor swallowing, sparse hit sampling, budget removal, and unbounded layers', () => {
  const mutate = (from, to) => { assert.ok(source.includes(from), `mutation point missing: ${from}`); return source.replace(from, to); };
  assert.throws(() => structureCheck(mutate('if (boundary.has(y)) return false;', 'if (false) return false;')), /real image alt|close|choice/);
  assert.throws(() => dialogRootCheck(mutate(
    'if (boundary.has(y)) return false;\n      if (candidateSet.has(y) && (anyKind || inferred.has(y) || swallows(y))) return true;',
    'if (candidateSet.has(y) && (anyKind || inferred.has(y) || swallows(y))) return true;\n      if (boundary.has(y)) return false;')), /onclick dialog root swallowed/);
  assert.throws(() => gridCheck(mutate('var hx = 0; hx < 5; hx++', 'var hx = 0; hx < 1; hx++')), /click-locator reachable/);
  assert.throws(() => budgetCheck(mutate('hitTestLimit = 200', 'hitTestLimit = 20000')), /hit budget exceeded/);
  assert.throws(() => persistentCheck(mutate('var limit = 6000', 'var limit = 60000')), /persistent dialog block is bounded/);
});
test('actual native dialog walker keeps bounded failure points and read order with inert AX only', () => {
  const nativePath=process.env.NATIVE_CHROME_SOURCE || new URL('../src/native-chrome.swift',import.meta.url);
  const cliPath=process.env.CHROMECTL_SOURCE || new URL('../src/chromectl.swift',import.meta.url);
  const native=fs.readFileSync(nativePath,'utf8'),cli=fs.readFileSync(cliPath,'utf8');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dialog-reader-native-'));
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const receipt={schema:1,directory,realAX:false,artifactsPreserved:true,nativeSha256:sha(native),cliSha256:sha(cli),cases:[]};
  const exact=(text,anchor,indent=0)=>{
    const line='\n'+anchor,offset=text.indexOf(line),start=offset+1;
    assert.ok(offset>=0&&text.indexOf(line,offset+1)===-1,anchor);
    const end=text.indexOf('\n'+' '.repeat(indent)+'}',start);assert.ok(end>start,anchor);
    return text.slice(start,end+indent+2);
  };
  const program=(text,command)=>{
    const failure=exact(text,'struct DialogFailure:');
    const walker=exact(text,'func axPageDialog(');
    const check=exact(text,'    func check() throws {',4);
    const around=exact(text,'    func around<T>(',4);
    const inspect=exact(text,'    func inspect(pid: pid_t, target:',4);
    const retryFacts=exact(text,'    /// A Stop or deadline keeps precedence; it only gains this probe\'s rescan count and last AX status.\n    func retryFacts(',4);
    const timeout=exact(text,'    @discardableResult\n    func AXUIElementSetMessagingTimeout(',4);
    const attribute=exact(text,'    func AXUIElementCopyAttributeValue(',4);
    const prompt=exact(text,'static func promptText(');
    const catchLines=command.match(/^    } catch let e as DialogFailure \{ emit\(e.json\) \}\n    catch \{ emit\(DialogFailure\(code: "dialog_probe_unknown", stage: "dialog_inspect"[^\n]+$/m)?.[0];
    assert.ok(catchLines,'Exact production CLI typed/untyped catch boundary');
    const code=String.raw`import Foundation
// No ApplicationServices import. Every effectful name below is a local value double.
typealias CFString = String
typealias CFTypeRef = AnyObject
enum AXError: Int32 { case success = 0, invalidUIElement = -25202, cannotComplete = -25204, attributeUnsupported = -25205, noValue = -25212 }
enum Halt: Error { case terminated }
enum FixtureError: Error { case other }
struct Failure: Error { var details: [String: Any] = [:] }
let scenario = CommandLine.arguments[1]
var events: [String] = [], clock: Double = 0, dateCalls = 0, checks = 0, transientLeft = 0, uptime: Double = 0
struct Date: Comparable {
    let value: Double
    init() { dateCalls += 1; if scenario == "attribute_deadline" && dateCalls == 2 { clock = 5 }; value = clock; events.append("date") }
    init(_ value: Double) { self.value = value }
    func addingTimeInterval(_ seconds: Double) -> Date { Date(value + seconds) }
    static func < (_ lhs: Date, _ rhs: Date) -> Bool { lhs.value < rhs.value }
}
struct ProcessInfo {
    static let processInfo = ProcessInfo()
    // NAT-RETRY: the Probe's own clock (not Date) can pass its deadline between rescans.
    var systemUptime: Double { scenario == "probe_deadline" ? 5 : uptime }
}
let kAXWindowsAttribute = "AXWindows", kAXSubroleAttribute = "AXSubrole", kAXStandardWindowSubrole = "AXStandardWindow"
let kAXRoleAttribute = "AXRole", kAXButtonRole = "AXButton", kAXTitleAttribute = "AXTitle", kAXDescriptionAttribute = "AXDescription"
let kAXStaticTextRole = "AXStaticText", kAXValueAttribute = "AXValue", kAXTextFieldRole = "AXTextField", kAXTextAreaRole = "AXTextArea", kAXChildrenAttribute = "AXChildren"
final class AXUIElement {
    let name: String
    var attrs: [String: Any]
    init(_ name: String, _ attrs: [String: Any]) { self.name = name; self.attrs = attrs }
}
let button = AXUIElement("button", ["AXRole": "AXButton", "AXTitle": "OK"])
let text = AXUIElement("text", ["AXRole": "AXStaticText", "AXValue": "Synthetic text"])
let dialog = AXUIElement("dialog", ["AXSubrole": "AXDialog", "AXRole": "AXWindow", "AXTitle": "Synthetic dialog", "AXChildren": [button, text]])
let standard = AXUIElement("standard", ["AXSubrole": "AXStandardWindow"])
let app = AXUIElement("app", ["AXWindows": [dialog]])
switch scenario {
case "none", "optional_sheets": app.attrs["AXWindows"] = [standard]
case "ambiguous": app.attrs["AXWindows"] = [dialog, AXUIElement("second", ["AXSubrole": "AXDialog"])]
case "windows_shape": app.attrs["AXWindows"] = "PRIVATE_WINDOWS"
case "windows_limit": app.attrs["AXWindows"] = Array(repeating: standard, count: 65)
case "subrole_shape": dialog.attrs["AXSubrole"] = 7
case "sheets_shape": app.attrs["AXWindows"] = [standard]; standard.attrs["AXSheets"] = "PRIVATE_SHEETS"
case "sheets_limit": app.attrs["AXWindows"] = [standard]; standard.attrs["AXSheets"] = Array(repeating: dialog, count: 5)
case "role_shape": dialog.attrs["AXRole"] = 7
case "walk_depth":
    var child = button
    for n in 0..<13 { child = AXUIElement("depth" + String(n), ["AXRole": "AXGroup", "AXChildren": [child]]) }
    dialog.attrs["AXChildren"] = [child]
case "walk_count": dialog.attrs["AXChildren"] = Array(repeating: button, count: 601)
case "button_title": button.attrs["AXTitle"] = 7
case "button_label": button.attrs["AXTitle"] = ""; button.attrs["AXDescription"] = ""
case "text_value": text.attrs["AXValue"] = 7
case "children_shape": dialog.attrs["AXChildren"] = "PRIVATE_CHILDREN"
case "no_buttons": dialog.attrs["AXChildren"] = [text]
case "dialog_title": dialog.attrs["AXTitle"] = 7
case "transient_windows": transientLeft = 2
case "transient_none": app.attrs["AXWindows"] = [standard]; transientLeft = 1
case "transient_ambiguous": app.attrs["AXWindows"] = [dialog, AXUIElement("second", ["AXSubrole": "AXDialog"])]; transientLeft = 1
case "transient_walk", "transient_children", "vanished_then_gone", "transient_stop": transientLeft = 1
default: break
}
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { precondition(pid == 7); events.append("application"); return app }
func CFEqual(_ a: AXUIElement, _ b: AXUIElement) -> Bool { events.append("equal"); return a === b }
func CFHash(_ value: AXUIElement) -> Int { events.append("hash:" + value.name); return 1 }
enum ApplicationServices {
    static func AXUIElementSetMessagingTimeout(_ e: AXUIElement, _ seconds: Float) -> AXError {
        precondition(seconds == 0.025); events.append("timeout:" + e.name); return .success
    }
    static func AXUIElementCopyAttributeValue(_ e: AXUIElement, _ key: String, _ out: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
        events.append("read:" + e.name + ":" + key)
        if scenario == "attribute_read" && key == "AXWindows" { return .cannotComplete }
        // NAT-RETRY: transient statuses, then the real attributes; persistent ones never clear.
        if ["transient_windows", "transient_none", "transient_ambiguous", "transient_deadline", "transient_probe_deadline", "transient_stop"].contains(scenario) && key == "AXWindows" &&
            (transientLeft > 0 || ["transient_deadline", "transient_probe_deadline"].contains(scenario)) {
            transientLeft -= 1; return .cannotComplete
        }
        if scenario == "transient_walk" && e === button && key == "AXTitle" && transientLeft > 0 { transientLeft -= 1; return .invalidUIElement }
        if scenario == "transient_children" && e === dialog && key == "AXChildren" && transientLeft > 0 { transientLeft -= 1; return .cannotComplete }
        if scenario == "vanished_then_gone" && e === dialog && key == "AXSubrole" && transientLeft > 0 {
            transientLeft -= 1; app.attrs["AXWindows"] = [standard]; return .invalidUIElement
        }
        if scenario == "vanished_persistent" && e === dialog && key == "AXSubrole" { return .invalidUIElement }
        if scenario == "attribute_missing" && key == "AXWindows" { return .success }
        if scenario == "optional_sheets" && key == "AXSheets" { return .attributeUnsupported }
        if scenario == "children_read" && e === dialog && key == "AXChildren" { return .attributeUnsupported }
        if scenario == "final_deadline" && e === text && key == "AXChildren" { clock = 5 }
        guard let value = e.attrs[key] else { return .noValue }
        out.pointee = value as AnyObject; return .success
    }
}
${failure}
struct PageDialog {
    let title: String, texts: [String], buttons: [(String, AXUIElement)], fields: [AXUIElement]
    let window: AXUIElement, descriptor: [String]
    var templateComplete = true
}
enum ChromeNative { ${prompt} }
final class Probe {
    let deadline: Double = 4, axMessagingTimeout: Float = 0.025
    var firstFailure: Error?
    var axRetries = 0, axLastError: Int? = nil
    let checkpoint: () throws -> Void = { checks += 1; events.append("checkpoint")
        if scenario == "checkpoint_stop" && checks == 3 { throw Halt.terminated }
        if scenario == "transient_stop" && events.contains("pause") { throw Halt.terminated } }
${check}
${around}
${timeout}
${attribute}
${inspect}
${retryFacts}
    func inspectBoundDialog(pid: pid_t, target: [String: Any]?) throws -> PageDialog? { try axPageDialog(pid: pid) }
    func axIsWindowSharingIndicator(_ e: AXUIElement) -> Bool { events.append("sharing:" + e.name); return false }
    func axIsInputSourceIndicator(_ e: AXUIElement, pid: pid_t) -> Bool { events.append("input:" + e.name); return false }
    func axIsChromeTranslationBubble(_ e: AXUIElement) -> Bool { events.append("translation:" + e.name); return false }
    // PERM1: the permission-prompt exclusion is exercised by test/perm-prompt.test.mjs; inert here (no event).
    func axIsChromePermissionPrompt(_ e: AXUIElement, pid: pid_t) -> Bool { false }
    func axRetryPause(until deadline: Date) { events.append("pause"); clock += scenario == "transient_deadline" ? 5 : 0.05
        if scenario == "transient_probe_deadline" { uptime = 5 } }
${walker}
}
var output: [String: Any] = [:]
let probe = Probe()
if scenario == "first_failure" { probe.firstFailure = Halt.terminated }
func emit(_ value: [String: Any]) { output = value }
if scenario == "cli_other" || scenario == "cli_typed" {
    do {
        if scenario == "cli_other" { throw FixtureError.other }
        throw DialogFailure(code: "dialog_probe_unknown", stage: "native_read_deadline")
${catchLines}
} else {
    do {
        let result = try probe.inspect(pid: 7, target: nil)
        output = ["ok": true, "open": result != nil, "buttons": result?.buttons.count ?? 0]
    } catch let e as DialogFailure { output = e.json }
    catch is Halt { output = ["error": "terminated", "stage": "original_stop"] }
    catch { fatalError("unexpected fixture error") }
}
output["events"] = events
output["firstFailure"] = probe.firstFailure == nil ? "absent" : (probe.firstFailure is Halt ? "Halt" : "DialogFailure")
print(String(data: try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
`;
    for(const fragment of [failure,walker,check,around,inspect,retryFacts,timeout,attribute,prompt,catchLines])
      assert.equal(code.split(fragment).length,2,'actual source fragment appears byte-for-byte once');
    assert.deepEqual([...code.matchAll(/^import (\w+)/gm)].map(x=>x[1]),['Foundation']);
    assert.doesNotMatch(code,/@_silgen_name|\b(?:NSWorkspace|NSRunningApplication|SBApplication|CGWindowListCopyWindowInfo|Process|Thread|FileHandle)\b|\b(?:sleep|usleep|kill|system|sendEvent)\s*\(/);
    return code;
  };
  const invoke=(command,args,label)=>{
    const result=spawnSync(command,args,{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
    fs.writeFileSync(path.join(directory,label+'.stdout'),result.stdout??'',{flag:'wx'});
    fs.writeFileSync(path.join(directory,label+'.stderr'),result.stderr??'',{flag:'wx'});
    assert.equal(result.error,undefined,label);assert.equal(result.signal,null,label);
    assert.equal(result.status,0,`${label}: ${result.stderr}`);return result.stdout;
  };
  const compile=(text,command,label)=>{
    const code=program(text,command),file=path.join(directory,label+'.swift'),binary=path.join(directory,label),cache=path.join(directory,label+'-cache');
    fs.writeFileSync(file,code,{flag:'wx'});fs.mkdirSync(cache);
    invoke('/usr/bin/swiftc',['-module-cache-path',cache,file,'-o',binary],label+'-compile');return binary;
  };
  const expected={attribute_deadline:'native_attribute_deadline',attribute_read:'native_attribute_read',attribute_missing:'native_attribute_read',
    windows_shape:'native_windows_shape',windows_limit:'native_windows_shape',subrole_shape:'native_subrole_shape',sheets_shape:'native_sheets_shape',sheets_limit:'native_sheets_shape',
    role_shape:'native_walk_guard',walk_depth:'native_walk_guard',walk_count:'native_walk_guard',button_title:'native_button_title',button_label:'native_button_label',
    text_value:'native_text_value',children_read:'native_children_read',children_shape:'native_children_read',no_buttons:'native_dialog_final',dialog_title:'native_dialog_final',
    final_deadline:'native_dialog_final',cli_other:'cli_inspect_catch',
    vanished_persistent:'native_attribute_read',transient_deadline:'native_attribute_deadline'};
  // NAT-RETRY: transient AX statuses rescan the whole window list; [open, buttons, pauses].
  const recovered={transient_windows:[true,1,2],transient_none:[false,0,1],transient_walk:[true,1,1],transient_children:[true,1,1],vanished_then_gone:[false,0,1]};
  const scenarios=['healthy','none','optional_sheets','ambiguous','first_failure','checkpoint_stop','probe_deadline','cli_typed','transient_ambiguous',
    'transient_probe_deadline','transient_stop',
    ...Object.keys(recovered),...Object.keys(expected)];
  try {
    const binary=compile(native,cli,'candidate');
    const baseline=process.env.DIALOG_PROBE_BASELINE_SOURCE;
    const old=baseline?compile(fs.readFileSync(baseline,'utf8'),fs.readFileSync(process.env.DIALOG_PROBE_BASELINE_CLI,'utf8'),'baseline'):null;
    for(const scenario of scenarios) {
      const value=JSON.parse(invoke(binary,[scenario],'candidate-'+scenario));
      if(old) {
        const prior=JSON.parse(invoke(old,[scenario],'baseline-'+scenario));
        const behavior={...value};delete behavior.dialogProbePoint;
        assert.deepEqual(behavior,prior,`${scenario}: same error/result, firstFailure and exact ordered reads/checks`);
      }
      if(expected[scenario]) {
        assert.equal(value.error,'dialog_probe_unknown');assert.equal(value.stage,'dialog_inspect');assert.equal(value.inputDelivery,'not_sent');
        assert.equal(value.dialogProbePoint,expected[scenario],scenario);
      } else {
        assert.equal(Object.hasOwn(value,'dialogProbePoint'),false,scenario);
        if(['first_failure','checkpoint_stop'].includes(scenario)) {assert.equal(value.error,'terminated');assert.equal(value.firstFailure,'Halt');}
        if(scenario==='probe_deadline') {assert.equal(value.stage,'native_read_deadline');assert.equal(value.firstFailure,'DialogFailure');}
        if(scenario==='cli_typed')assert.equal(value.stage,'native_read_deadline');
        if(scenario==='ambiguous')assert.equal(value.error,'dialog_ambiguous');
        if(['healthy','none','optional_sheets'].includes(scenario))assert.equal(value.ok,true);
        if(scenario==='transient_ambiguous'){assert.equal(value.error,'dialog_ambiguous');assert.equal(value.events.filter(x=>x==='pause').length,1);}
        if(recovered[scenario]) {
          const [open,buttons,pauses]=recovered[scenario];
          assert.equal(value.ok,true,scenario);assert.equal(value.error,undefined,scenario);
          assert.equal(value.open,open,scenario);assert.equal(value.buttons,buttons,scenario);
          assert.equal(value.events.filter(x=>x==='pause').length,pauses,scenario);assert.equal(value.firstFailure,'absent',scenario);
        }
      }
      // A stop or the probe budget is never rescanned; a persistent transient status fails with its count and last code.
      if(['first_failure','checkpoint_stop','probe_deadline'].includes(scenario)) assert.equal(value.events.includes('pause'),false,scenario);
      if(scenario==='attribute_read') {assert.equal(value.axRetries,4);assert.equal(value.axError,-25204);assert.equal(value.events.filter(x=>x==='pause').length,4);}
      if(scenario==='vanished_persistent') {assert.equal(value.axRetries,4);assert.equal(value.axError,-25202);}
      if(scenario==='transient_deadline') {assert.equal(value.axRetries,1);assert.equal(value.axError,-25204);}
      // Round 2 (A3): the Probe clock passes its budget after a rescan: the deadline keeps precedence and carries the facts.
      if(scenario==='transient_probe_deadline') {assert.equal(value.error,'dialog_probe_unknown');assert.equal(value.stage,'native_read_deadline');
        assert.equal(value.firstFailure,'DialogFailure');assert.equal(value.axRetries,1);assert.equal(value.axError,-25204);
        assert.equal(value.events.filter(x=>x==='pause').length,1);}
      if(scenario==='transient_stop') {assert.equal(value.error,'terminated');assert.equal(value.firstFailure,'Halt');assert.equal(value.events.filter(x=>x==='pause').length,1);}
      if(['attribute_missing','children_read','healthy'].includes(scenario)) {assert.equal(Object.hasOwn(value,'axRetries'),false,scenario);assert.equal(value.events.includes('pause'),false,scenario);}
      assert.doesNotMatch(JSON.stringify(value),/PRIVATE_/);
      receipt.cases.push({scenario,point:value.dialogProbePoint??null,eventCount:value.events.length,eventsSha256:sha(JSON.stringify(value.events)),baselineCompared:!!old});
    }
    receipt.status='passed';
  } catch(error) {receipt.status='failed';receipt.failure={message:error.message,stack:error.stack};throw error;}
  finally {
    receipt.sourceUnchanged=sha(fs.readFileSync(nativePath,'utf8'))===receipt.nativeSha256&&sha(fs.readFileSync(cliPath,'utf8'))===receipt.cliSha256;
    fs.writeFileSync(path.join(directory,'execution-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({nativeDialogReceipt:path.join(directory,'execution-receipt.json'),status:receipt.status,cases:receipt.cases.length}));
  }
});
console.log(`${passed} dialog reader groups passed`);
