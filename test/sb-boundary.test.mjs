/* CRASH1: an Objective-C exception from a ScriptingBridge call never aborts a helper.
 *
 * Production code is compiled exactly as scripts/build-native.sh compiles it: the script runs in a temporary
 * root with a recording compiler that keeps its argv and its objc-try.h shim; the real swiftc then builds each
 * driver with those flags, that shim and src/native-chrome.swift. The only ScriptingBridge target is this
 * test's own driver process. It has no scripting definition, so ScriptingBridge hands back the same generic
 * SBApplication whose "windows" key threw NSUnknownKeyException on 2026-11-03 (REL-T2): no Apple Event reaches
 * Chrome or any other process, and nothing is activated or typed.
 *
 * Groups (CRASH1_GROUP=new|kept|gate runs one):
 *   new   fails with the fix reverted, or under the targeted mutation runs/CRASH1/rerun.sh applies to it;
 *   kept  behaviour the fix must not change;
 *   gate  every ScriptingBridge call site goes through the boundary; each mutant copy must trip the gate.
 * CRASH1_CASES=tag,tag runs only the cases with those tags (each case name starts with [tag]); a driver is
 * compiled only when one of its cases runs. Sources are read from disk, so rerun.sh mutates them in place.
 * NATIVE_CHROME_SOURCE / CHROMECTL_SOURCE / HELPER_SOURCE / BUILD_NATIVE_SCRIPT point at other copies. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'This suite compiles macOS Swift drivers.');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_PATH = process.env.NATIVE_CHROME_SOURCE || path.join(ROOT, 'src/native-chrome.swift');
const native = fs.readFileSync(NATIVE_PATH, 'utf8');
const cli = fs.readFileSync(process.env.CHROMECTL_SOURCE || path.join(ROOT, 'src/chromectl.swift'), 'utf8');
const helper = fs.readFileSync(process.env.HELPER_SOURCE || path.join(ROOT, 'src/helper.swift'), 'utf8');
const BUILD = process.env.BUILD_NATIVE_SCRIPT || path.join(ROOT, 'scripts/build-native.sh');
const GROUP = process.env.CRASH1_GROUP || 'all';
const CASES = process.env.CRASH1_CASES ? new Set(process.env.CRASH1_CASES.split(',')) : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-sb-boundary-'));
let passed = 0, failed = 0;
function check(group, tag, name, fn) {
  if ((GROUP !== 'all' && GROUP !== group) || (CASES && !CASES.has(tag))) return;
  try { fn(); passed++; console.log(`  ok    [${group}] [${tag}] ${name}`); }
  catch (error) { failed++; console.log(`  FAIL  [${group}] [${tag}] ${name}\n        ${String(error.message).split('\n').slice(0, 6).join('\n        ')}`); }
}
const lazy = make => { let value; return (...args) => (value ??= make())(...args); };
const between = (text, start, end) => {
  const a = text.indexOf(start); if (a < 0) return null;
  const b = text.indexOf(end, a + start.length); return b < 0 ? null : text.slice(a, b);
};
const topBlock = (text, decl) => { const a = text.indexOf(decl); if (a < 0) return null; const b = text.indexOf('\n}', a); return b < 0 ? null : text.slice(a, b + 2); };
// A balanced block from its declaration (these functions hold no braces inside string literals).
function block(text, decl) {
  const a = text.indexOf(decl); if (a < 0 || text.indexOf(decl, a + 1) >= 0) return null;
  let depth = 0, i = text.indexOf('{', a);
  for (; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) return text.slice(a, i + 1); }
  return null;
}
function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: opts.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024,
    env: opts.env ?? process.env, ...(opts.input != null ? { input: opts.input } : {}) });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
}

/* ------------------------------------------------ the build's own flags and shim */
const build = (() => {
  const root = path.join(tmp, 'build-root'), stash = path.join(tmp, 'build-stash');
  for (const d of ['src', 'bin', 'scripts']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(stash);
  fs.copyFileSync(BUILD, path.join(root, 'scripts/build-native.sh'));
  for (const n of ['helper.swift', 'chromectl.swift', 'native-chrome.swift']) fs.writeFileSync(path.join(root, 'src', n), `// fixture ${n}\n`);
  const recorder = path.join(tmp, 'recorder.cjs');
  fs.writeFileSync(recorder, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),stash=process.env.CRASH1_STASH;
const n=fs.readdirSync(stash).filter(x=>x.startsWith('argv-')).length,i=a.indexOf('-import-objc-header');
if(i>=0) fs.copyFileSync(a[i+1],path.join(stash,'objc-try-'+n+'.h'));
fs.writeFileSync(path.join(stash,'argv-'+n+'.json'),JSON.stringify(a));fs.writeFileSync(a[a.indexOf('-o')+1],'recorded');
`, { mode: 0o755 });
  const r = run('/bin/sh', [path.join(root, 'scripts/build-native.sh')], { env: { ...process.env, MYCHROME_SWIFTC: recorder, CRASH1_STASH: stash } });
  const argvs = fs.readdirSync(stash).filter(x => x.startsWith('argv-')).sort().map(x => JSON.parse(fs.readFileSync(path.join(stash, x), 'utf8')));
  const headers = fs.readdirSync(stash).filter(x => x.startsWith('objc-try-')).sort().map(x => fs.readFileSync(path.join(stash, x), 'utf8'));
  // Exactly the build's flags: everything but its output, its inputs and the (stashed) header path.
  const flags = (argvs[0] ?? []).filter((x, k, a) => x !== '-o' && a[k - 1] !== '-o' && !x.endsWith('.swift') &&
    x !== '-import-objc-header' && a[k - 1] !== '-import-objc-header');
  const header = headers.length ? path.join(stash, 'objc-try-0.h') : null;
  return { status: r.status, stderr: r.stderr, argvs, headers, flags, header, leftovers: fs.readdirSync(path.join(root, 'bin')).sort() };
})();
check('new', 'build', 'build-native.sh compiles both helpers with the same @try shim', () => {
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.argvs.length, 2);
  for (const a of build.argvs) assert.ok(a.includes('-import-objc-header'), 'each helper compile imports the shim header');
  assert.equal(build.headers.length, 2); assert.equal(build.headers[0], build.headers[1]);
  assert.match(build.headers[0], /@try/);
  assert.deepEqual(build.leftovers, ['cgevent', 'chromectl'], 'the per-build shim is cleaned up with the build directory');
});
function compileDriver(name, swift) {
  const dir = path.join(tmp, name), bin = path.join(dir, name);
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'main.swift'), swift);
  const c = run('/usr/bin/xcrun', ['swiftc', ...build.flags, ...(build.header ? ['-import-objc-header', build.header] : []),
    '-o', bin, path.join(dir, 'main.swift'), NATIVE_PATH], { timeout: 600_000 });
  fs.writeFileSync(path.join(dir, 'compile.log'), c.stderr);
  return (args, opts) => {
    assert.equal(c.status, 0, `${name} compile failed (${path.join(dir, 'compile.log')}):\n${c.stderr.split('\n').filter(l => /error/.test(l)).slice(0, 4).join('\n')}`);
    const r = run(bin, args, opts);
    return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').at(-1)) : null };
  };
}
const noAbort = r => { assert.equal(r.signal, null, `the helper process died by ${r.signal}: ${r.stderr.slice(-400)}`); assert.doesNotMatch(r.stderr, /uncaught exception|Terminating app/); };

/* ------------------------------------------------ the read site: needs no new symbol, so it also runs (and aborts) on the reverted source */
const readOutcome = lazy(() => compileDriver('read-driver', `import Foundation
let me = getpid()
func out(_ value: [String: Any]) { print(String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!) }
switch CommandLine.arguments[1] {
case "read-direct":
    do { let rows = try ChromeNative.readSnapshot(me); out(["mode": "read-direct", "returned": rows.count]) }
    catch let f as ChromeNative.ReadFailure { out(["mode": "read-direct", "code": f.code, "details": f.details, "osStatus": f.osStatus.map { $0 as Any } ?? NSNull()]) }
case "read-runner":
    // The crashed path: Owner.snapshot hands the read to the ReadRunner thread "MyChrome native read".
    do { _ = try ChromeNative.Owner(dry: false).snapshot(me); out(["mode": "read-runner", "returned": true]) }
    catch let f as ChromeNative.Failure { out(["mode": "read-runner", "failure": f.json]) }
default: exit(70)
}
`));
check('new', 'read', '1. read site: readSnapshot returns the structured read failure (field windows, NSUnknownKeyException)', () => {
  const r = readOutcome(['read-direct']); noAbort(r); assert.equal(r.status, 0);
  assert.deepEqual(r.json, { mode: 'read-direct', code: 'native_read_unknown', osStatus: null,
    details: { nativeReadPoint: 'windows', nativeReadReason: 'objc_exception', exceptionName: 'NSUnknownKeyException' } });
  assert.match(r.stderr, /failed to get scripting definition/, 'ScriptingBridge made the generic SBApplication of the field crash');
});
check('new', 'read', '1. read site on the crashed thread: Owner.snapshot -> ReadRunner -> native_read failure, helper alive', () => {
  const r = readOutcome(['read-runner']); noAbort(r); assert.equal(r.status, 0);
  assert.deepEqual(r.json, { mode: 'read-runner', failure: { ok: false, error: 'native_read_unknown', stage: 'native_read',
    nativeReadPoint: 'windows', nativeReadReason: 'objc_exception', exceptionName: 'NSUnknownKeyException' } });
});

/* ------------------------------------------------ the driver: chromectl's boundary, its dialog catch, the production inspect body */
const cliBoundary = between(cli, "// MARK: - ScriptingBridge boundary, chromectl's top-level side (CRASH1)", '\nfunc windows()');
const phaseVars = cli.match(/^var sbPreCommand = [^\n]+\nvar sbRecorded: ChromeNative\.SBException\?\n/m)?.[0];
const cliEmit = topBlock(cli, 'func emit(_ obj: [String: Any]) -> Never {'), cliFail = topBlock(cli, 'func fail(_ code: String, _ message: String) -> Never {');
// chromectl's own dialog catch pair, taken from inside nativeDialogCommand (the pair dialog-reader also pins).
const dialogCatch = (topBlock(cli, 'func nativeDialogCommand(_ args: [String]) -> Never {') ?? '')
  .match(/^    \} catch let e as DialogFailure \{ emit\(e\.json\) \}\n    catch \{ emit\([^\n]+$/m)?.[0];
const inspectFn = topBlock(native, 'func inspectBoundDialog(pid: pid_t, target: [String: Any]?) throws -> PageDialog? {');
const outcome = lazy(() => compileDriver('driver', `import Foundation
import ScriptingBridge
import ApplicationServices
// ---- chromectl.swift's own emit, its boundary state and its top-level ScriptingBridge boundary, unchanged ----
${cliEmit ?? '// emit missing'}
${phaseVars ?? '// phase variables missing'}
${cliBoundary ?? '// chromectl boundary missing'}
// ---- doubles around the production inspectBoundDialog body: its snapshot read is the real readSnapshot ----
typealias DialogFailure = ChromeNative.DialogFailure
typealias PageDialog = ChromeNative.PageDialog
typealias DialogParent = ChromeNative.DialogParent
typealias DialogIdentity = ChromeNative.DialogIdentity
func unreachable(_ what: String) -> Never { FileHandle.standardError.write(Data("unreachable:\\(what)\\n".utf8)); exit(70) }
var axDialog: PageDialog? = nil
func axPageDialog(pid: pid_t) throws -> PageDialog? { axDialog }
func snapshot(_ pid: pid_t) throws -> [ChromeNative.WindowRow] { try ChromeNative.readSnapshot(pid) }
func sameRect(_ a: CGRect, _ b: CGRect) -> Bool { ChromeNative.sameRect(a, b) }
func axWindowNumber(_ e: AXUIElement) -> Int? { unreachable("axWindowNumber") }
func axRect(_ e: AXUIElement) -> CGRect? { unreachable("axRect") }
func dialogAX(_ e: AXUIElement, _ key: String, optional: Bool = false) throws -> CFTypeRef? { unreachable("dialogAX") }
func bindDialog(pid: Int, dialogCG: Int, dialogRect: CGRect, descriptor: [String], parents: [DialogParent],
                attachments: [Int], target: [String: Any]?) throws -> DialogIdentity { unreachable("bindDialog") }
${inspectFn ?? '// inspectBoundDialog missing'}
// nativeDialogCommand's own tail: open:false / open:true, then its production catch pair, unchanged.
func dialogCommandTail(_ inspect: () throws -> PageDialog?) -> Never {
    do {
        guard let d = try inspect() else { emit(["ok": true, "known": true, "open": false, "inputDelivery": "not_sent", "stage": "dialog_inspect"]) }
        emit(["ok": true, "known": true, "open": true, "title": d.title])
${dialogCatch ?? '    } catch { unreachable("dialog catch pair missing") }'}
}
// ---- ScriptingBridge's own SBObject, subclassed: a command that throws, and a healthy object. Allocated
// directly: SBObject's initializer hands back an SBProxyByClass, which would never reach these methods. ----
var performs = 0
final class ThrowingTab: ScriptingBridge.SBObject {
    @objc func executeJavascript(_ source: Any?) -> Any? {
        performs += 1; FileHandle.standardError.write(Data("perform \\(performs)\\n".utf8))
        NSException(name: .invalidArgumentException, reason: "fixture", userInfo: nil).raise(); return nil
    }
}
final class HealthyTab: ScriptingBridge.SBObject {
    override func value(forKey key: String) -> Any? { key == "title" ? "fixture title" : nil }
    @objc func executeJavascript(_ source: Any?) -> Any? { "{\\"ok\\":true}" as NSString }
}
let me = getpid(), target: [String: Any] = ["chromePid": Int(me), "windowId": 1, "tabId": 1, "cgWindow": 1]
func dialogOutcome(_ mode: String) -> Never {
    do { let d = try inspectBoundDialog(pid: me, target: target); emit(["mode": mode, "returned": d == nil ? "no_dialog" : "dialog"]) }
    catch let f as ChromeNative.ReadFailure { emit(["mode": mode, "thrown": "ReadFailure", "code": f.code, "details": f.details]) }
    catch let f as ChromeNative.DialogFailure { emit(["mode": mode, "thrown": "DialogFailure", "failure": f.json]) }
    catch { emit(["mode": mode, "thrown": String(describing: type(of: error))]) }
}
sbPreCommand = false
switch CommandLine.arguments[1] {
case "eval-perform":
    let tab = SBObject(ChromeNative.SBObject(class_createInstance(ThrowingTab.self, 0) as! ThrowingTab))
    let r = tab.perform(NSSelectorFromString("executeJavascript:"), with: "fixture script")?.takeUnretainedValue()
    emit(["mode": "eval-perform", "returned": r != nil, "performs": performs])
case "prewarm":
    // The --warm-read pre-warm, in preWarmReadOnly's own shape: no count means no ready line, exit 1, nothing on stdout.
    sbPreCommand = true
    let app = SBApplication(processIdentifier: me)
    let windows = (app?.value(forKey: "windows") as? SBElementArray)?.count
    guard windows != nil else { FileHandle.standardError.write(Data("prewarm: no ready line\\n".utf8)); exit(1) }
    emit(["mode": "prewarm", "ready": true])
case "recorded":
    sbPreCommand = true
    let app = SBApplication(processIdentifier: me)
    _ = (app?.value(forKey: "windows") as? SBElementArray)?.count   // recorded in the pre-warm
    sbPreCommand = false
    let after = app?.value(forKey: "id")                             // the first boundary call after it
    emit(["mode": "recorded", "returned": after != nil])
case "dialog-none": dialogOutcome("dialog-none")
case "dialog-present":
    axDialog = PageDialog(title: "fixture", texts: [], buttons: [], fields: [], window: AXUIElementCreateApplication(me), descriptor: ["fixture"])
    dialogOutcome("dialog-present")
case "dialog-cli":
    dialogCommandTail { try inspectBoundDialog(pid: me, target: target) }
case "dialog-cli-other":
    dialogCommandTail { throw NSError(domain: "FixtureDomain", code: 7, userInfo: ["NSDebugDescription": "private page text", "exceptionName": "NSFake", "nativeReadPoint": "windows"]) }
case "healthy":
    let tab = SBObject(ChromeNative.SBObject(class_createInstance(HealthyTab.self, 0) as! HealthyTab))
    let title = tab.value(forKey: "title") as? String
    let r = tab.perform(NSSelectorFromString("executeJavascript:"), with: "fixture script")?.takeUnretainedValue()
    emit(["mode": "healthy", "title": title.map { $0 as Any } ?? NSNull(), "result": (r as? String).map { $0 as Any } ?? NSNull()])
default: unreachable("mode")
}
`));
const BARE_DIALOG = { ok: false, error: 'dialog_probe_unknown', stage: 'dialog_inspect', inputDelivery: 'not_sent', dialogProbePoint: 'cli_inspect_catch' };

check('new', 'perform', '2. script-command site (executeJavascript:): one send, eval_result failure, noRetry, never sent again', () => {
  const r = outcome(['eval-perform']); noAbort(r); assert.equal(r.status, 0);
  assert.deepEqual(r.json, { ok: false, error: 'chrome_error', stage: 'eval_result', noRetry: true, exceptionName: 'NSInvalidArgumentException',
    sbOperation: 'perform', sbKey: 'executeJavascript:', message: r.json?.message });
  assert.equal((r.stderr.match(/^perform \d+$/gm) ?? []).length, 1, 'exactly one executeJavascript: message');
});
check('new', 'prewarm', 'chromectl --warm-read pre-warm: a caught exception still means no ready line and no output', () => {
  const r = outcome(['prewarm']); noAbort(r);
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /prewarm: no ready line/);
});
check('new', 'recorded', 'an exception recorded in the pre-warm is reported by the first boundary call after it', () => {
  const r = outcome(['recorded']); noAbort(r); assert.equal(r.status, 0);
  assert.deepEqual(r.json, { ok: false, error: 'chrome_error', stage: 'apple_event', exceptionName: 'NSUnknownKeyException',
    sbOperation: 'value', sbKey: 'windows', message: r.json?.message });
});
check('new', 'dialog', '4. dialog binding read, no dialog on AX: an exception refuses, never "no dialog"', () => {
  const r = outcome(['dialog-none']); noAbort(r); assert.equal(r.status, 0);
  assert.deepEqual(r.json, { mode: 'dialog-none', thrown: 'ReadFailure', code: 'native_read_unknown',
    details: { nativeReadPoint: 'windows', nativeReadReason: 'objc_exception', exceptionName: 'NSUnknownKeyException' } });
});
check('new', 'dialog', '4. dialog binding read, dialog on AX: an exception refuses before any binding', () => {
  const r = outcome(['dialog-present']); noAbort(r); assert.equal(r.status, 0);
  assert.equal(r.json.thrown, 'ReadFailure'); assert.equal(r.json.details.nativeReadReason, 'objc_exception');
  assert.doesNotMatch(r.stderr, /unreachable:/);
});
check('new', 'dialog-cli', 'r2 item 2: chromectl\'s dialog catch keeps dialog_probe_unknown and the read point and exceptionName', () => {
  assert.ok(dialogCatch, 'the catch pair inside nativeDialogCommand');
  const r = outcome(['dialog-cli']); noAbort(r); assert.equal(r.status, 0);
  assert.deepEqual(r.json, { ...BARE_DIALOG, message: r.json?.message,
    nativeReadPoint: 'windows', nativeReadReason: 'objc_exception', exceptionName: 'NSUnknownKeyException' });
});
check('new', 'dialog-cli', 'r2 item 2: any other error in that catch gains nothing (no foreign userInfo)', () => {
  const r = outcome(['dialog-cli-other']); noAbort(r); assert.equal(r.status, 0);
  assert.deepEqual(r.json, { ...BARE_DIALOG, message: r.json?.message });
});
check('new', 'healthy', 'the boundary passes a healthy object\'s value and script result through unchanged', () => {
  const r = outcome(['healthy']); noAbort(r); assert.equal(r.status, 0);
  assert.deepEqual(r.json, { mode: 'healthy', title: 'fixture title', result: '{"ok":true}' });
});

/* ------------------------------------------------ r2 item 5: chromectl's real dispatch region, --warm then "pick" */
// The region warm-read/windowmatch also compile: from `let warm` to the SBApplication marker, here with the real
// boundary, the build's shim and native-chrome.swift. Discovery returns this test's own process, so the first Apple
// Event (--warm's, after reading its command) meets the same generic SBApplication.
const dispatch = between(cli, 'let warm = CommandLine.arguments.count > 1', '// Must stay before SBApplication initialization.');
const pickOutcome = lazy(() => compileDriver('dispatch', `import Foundation
import ScriptingBridge
import CoreGraphics
${cliEmit ?? ''}
${cliFail ?? ''}
func trace(_ what: String) {}
func unreachable(_ what: String) -> Never { FileHandle.standardError.write(Data("unreachable:\\(what)\\n".utf8)); exit(70) }
struct FixtureChrome { let processIdentifier: pid_t }
func pickChrome() -> (FixtureChrome?, [[String: Any]]) { (FixtureChrome(processIdentifier: getpid()), [["pid": Int(getpid()), "reason": "fixture"]]) }
func preWarmReadOnly() -> (pick: (FixtureChrome?, [[String: Any]]), chrome: SBApplication) { unreachable("prewarm") }
func preWarmBindingCurrent(_ pid: pid_t) -> Bool { unreachable("binding") }
func profilesReport() -> [String: Any] { unreachable("profiles") }
typealias ChromeWin = ChromeNative.ChromeWin
func matchWindows(_ cw: [ChromeWin], cg: [(num: Int, rect: CGRect, onScreen: Bool)], onOrder: () -> [(num: Int, rect: CGRect)],
                  ax: () -> [(num: Int, title: String, minimized: Bool, rect: CGRect?)], title: (Int) -> String) -> [Int: Int] { unreachable("windowmatch") }
func axWindowTable(pid: pid_t) -> [(num: Int, title: String, minimized: Bool, rect: CGRect?)] { unreachable("axwindows") }
func sameRect(_ a: CGRect, _ b: CGRect) -> Bool { unreachable("sameRect") }
struct NativeInputProbeError: Error { let code: String; let message: String; var details: [String: Any] = [:] }
func nativePageContent(pid: pid_t, expectedWindow: Int) throws -> [String: Any] { unreachable("axcontent") }
func nativeInputProbe(pid: pid_t, expectedWindow: Int, point: CGPoint?) throws -> [String: Any] { unreachable("axinput") }
func nativeDialogCommand(_ args: [String]) -> Never { unreachable("dialog") }
${phaseVars ?? '// phase variables missing'}
${cliBoundary ?? '// chromectl boundary missing'}
${dispatch ?? '// dispatch region missing'}
emit(["ok": true, "fixture": "fell through to the Chrome-binding phase"])
`));
check('new', 'pick', 'r2 item 5: --warm then "pick": the first Apple Event\'s exception ends the command, never ok:true', () => {
  const r = pickOutcome(['--warm'], { input: '["pick"]\n' }); noAbort(r); assert.equal(r.status, 0);
  assert.deepEqual(r.json, { ok: false, error: 'chrome_error', stage: 'apple_event', exceptionName: 'NSUnknownKeyException',
    sbOperation: 'value', sbKey: 'windows', message: r.json?.message });
});

/* ------------------------------------------------ NAT-RETRY: the bounded re-reads count a caught exception */
function rescanHarness(source, name) {
  const swift = `import Foundation
final class ProcessInfo { static let processInfo = ProcessInfo(); var systemUptime: Double = 0 }
let input = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
enum ChromeNative {
    ${block(source, 'struct Failure: Error {') ?? '// Failure missing'}
    struct WindowRow { let id: Int }
    struct Target { let windowId: Int }
    final class Transaction { var delivery = input["delivery"] as? String ?? "sent" }
    final class Owner {
        var mutationRequested = input["mutationRequested"] as? Bool ?? false
        var script = input["script"] as? [String] ?? [], verifyCalls = 0, pumps = 0
        func pump() throws { pumps += 1; ProcessInfo.processInfo.systemUptime += 0.01 }
        func requireAlive(_ stage: String) throws {}
        @discardableResult
        func verify(_ t: Target, until: Double? = nil) throws -> WindowRow {
            verifyCalls += 1
            switch script.isEmpty ? "ok" : script.removeFirst() {
            case "exception": throw Failure("native_read_unknown", "native_read", details: ["nativeReadPoint": "windows", "nativeReadReason": "objc_exception", "exceptionName": "NSUnknownKeyException"])
            case "nil_read": throw Failure("native_read_unknown", "native_read", details: ["nativeReadPoint": "windows", "nativeReadReason": "nil_or_type"])
            case "structure": throw Failure("native_target_changed", "native_window_binding", details: ["bindingReason": "snapshot_structure_changed"])
            default: return WindowRow(id: t.windowId)
            }
        }
        ${block(source, 'func rescanVerify(_ t: Target) throws {') ?? '// rescanVerify missing'}
        ${block(source, 'func verifyAfterWrite(_ tx: Transaction, _ read: (Double?) throws -> WindowRow) throws -> WindowRow {') ?? '// verifyAfterWrite missing'}
        ${block(source, 'func rescanPause(until deadline: Double) throws {') ?? '// rescanPause missing'}
    }
}
let o = ChromeNative.Owner(), t = ChromeNative.Target(windowId: 1)
var result: [String: Any] = [:]
do {
    if input["fn"] as? String == "after" { _ = try o.verifyAfterWrite(ChromeNative.Transaction()) { try o.verify(t, until: $0) } }
    else { try o.rescanVerify(t) }
    result = ["ok": true]
} catch let f as ChromeNative.Failure { result = f.json }
result["verifyCalls"] = o.verifyCalls
print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
`;
  const dir = path.join(tmp, name); fs.mkdirSync(dir);
  const file = path.join(dir, 'main.swift'), bin = path.join(dir, name);
  fs.writeFileSync(file, swift);
  const c = run('/usr/bin/xcrun', ['swiftc', file, '-o', bin], { timeout: 300_000 });
  return input => { assert.equal(c.status, 0, c.stderr.split('\n').filter(l => /error/.test(l)).slice(0, 4).join('\n'));
    const r = run(bin, [JSON.stringify(input)]); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
}
const rescan = lazy(() => rescanHarness(native, 'rescan'));
check('new', 'rescan', 'goal 4: binding rescan re-reads after a caught exception (one exception, then a good read)', () => {
  assert.deepEqual(rescan({ script: ['exception', 'ok'] }), { ok: true, verifyCalls: 2 });
});
check('new', 'rescan', 'goal 4: a persistent exception stops at the existing bound (2 rescans) and keeps the read failure', () => {
  const r = rescan({ script: ['exception', 'exception', 'exception', 'ok'] });
  assert.equal(r.error, 'native_read_unknown'); assert.equal(r.stage, 'native_read'); assert.equal(r.bindingRescans, 2);
  assert.equal(r.nativeReadReason, 'objc_exception'); assert.equal(r.verifyCalls, 3);
});
check('new', 'rescan', 'goal 4: post-write verification re-reads after a caught exception; nothing is re-sent', () => {
  assert.deepEqual(rescan({ fn: 'after', script: ['exception', 'ok'] }), { ok: true, verifyCalls: 2 });
});
check('new', 'rescan', 'goal 4: targeted mutation (rescan clause removed) turns the re-read cases RED', () => {
  const clause = /\|\|\s*\n\s*\(failure\.code == "native_read_unknown" && failure\.stage == "native_read" &&\s*\n\s*failure\.details\["nativeReadReason"\] as\? String == "objc_exception"\)/g;
  assert.equal((native.match(clause) ?? []).length, 2, 'both rescan clauses present');
  const mutant = rescanHarness(native.replace(clause, ''), 'rescan-mutant');
  assert.equal(mutant({ script: ['exception', 'ok'] }).error, 'native_read_unknown');
  assert.equal(mutant({ fn: 'after', script: ['exception', 'ok'] }).error, 'native_read_unknown');
});
check('kept', 'rescan', 'NAT-RETRY: a structure change is still re-read; other read failures and a session that wrote stay final', () => {
  assert.deepEqual(rescan({ script: ['structure', 'ok'] }), { ok: true, verifyCalls: 2 });
  const nilRead = rescan({ script: ['nil_read', 'ok'] }); assert.equal(nilRead.nativeReadReason, 'nil_or_type'); assert.equal(nilRead.verifyCalls, 1);
  const wrote = rescan({ script: ['exception', 'ok'], mutationRequested: true }); assert.equal(wrote.error, 'native_read_unknown'); assert.equal(wrote.verifyCalls, 1);
  const unsent = rescan({ fn: 'after', delivery: 'not_sent', script: ['exception', 'ok'] }); assert.equal(unsent.error, 'native_read_unknown'); assert.equal(unsent.verifyCalls, 1);
});

/* ------------------------------------------------ 3. the source gate */
// Code only: comments dropped, string contents emptied (interpolated code kept), newlines kept.
function codeOnly(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { const e = text.indexOf('\n', i); i = (e < 0 ? text.length : e) - 1; continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? text.length : e + 2; out += text.slice(i, end).replace(/[^\n]/g, ''); i = end - 1; continue; }
    if (c === '"') {
      out += '"'; i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
        if (text[i] === '\\' && text[i + 1] === '(') {
          let d = 1, j = i + 2; while (j < text.length && d) { if (text[j] === '(') d++; else if (text[j] === ')') d--; j++; }
          out += ' ' + codeOnly(text.slice(i + 2, j - 1)) + ' '; i = j; continue;
        }
        i += text[i] === '\\' ? 2 : 1;
      }
      out += '"'; continue;
    }
    out += c;
  }
  return out;
}
// Top-level declarations of a file: each one's depth-0 text plus its whole block, in order.
function topLevelDecls(code) {
  const decls = []; let depth = 0, cur = '';
  for (const c of code) {
    cur += c;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { decls.push(cur); cur = ''; }
    else if (c === '\n' && depth === 0) { if (cur.trim()) decls.push(cur); cur = ''; }
  }
  if (cur.trim()) decls.push(cur);
  return decls.map(d => d.trim()).filter(Boolean);
}
// Inside the boundary a ScriptingBridge object (`raw`) may only be declared, stored, unwrapped, or handed to the shim.
const RAW_USES = [/^private let raw: ScriptingBridge\.SB(Application\?|Object|ElementArray)$/, /\braw = nil;/, /\{ raw = app \}/,
  /^init\(_ raw: ScriptingBridge\.SB(Object|ElementArray)\) \{ self\.raw = raw \}$/, /^guard let raw(, pending == nil)? else /];
// One shim function: exactly one statement inside @try, nothing before it, and a catch that keeps only the name.
const SHIM_FN = /^static inline [^\n{]+\{\n    @try \{ (?:return [^;\n]+;|[a-z]+\.[a-z]+ = [a-z]+; return YES;) \}\n    @catch \(id thrown\) \{ MyChromeSBCaught\(thrown, name\); return (?:nil|NO|-1); \}\n\}\n*$/;
function gate({ native, cli, helper, shim }) {
  const v = [], marker = '// MARK: - ScriptingBridge boundary (CRASH1)', at = native.indexOf(marker);
  if (at < 0) v.push('native-chrome.swift: no ScriptingBridge boundary section');
  const outside = at < 0 ? native : native.slice(0, at), inside = at < 0 ? '' : native.slice(at);
  const escapes = [[/\bScriptingBridge\s*\./, "names ScriptingBridge's own classes"], [/\bMyChromeSB\w*\s*\(/, 'calls the @try shim around the boundary classes'],
    [/\bobjc_msgSend\b|\bNSClassFromString\s*\(\s*"SB|\bobject_getClass\b/, 'reaches ScriptingBridge through the runtime']];
  for (const [file, text] of [['native-chrome.swift outside the boundary', outside], ['chromectl.swift', cli], ['helper.swift', helper]])
    for (const [re, what] of escapes) for (const line of codeOnly(text).split('\n')) if (re.test(line)) v.push(`${file} ${what}: ${line.trim()}`);
  // native-chrome.swift: an unqualified SB class name resolves to the boundary's only inside ChromeNative.
  for (const decl of topLevelDecls(codeOnly(outside)))
    if (!/^(enum|extension) ChromeNative \{/.test(decl) && /\bSB(Application|Object|ElementArray)\b|\.value\(forKey:|\.object\((withID|at):/.test(decl))
      v.push(`native-chrome.swift uses ScriptingBridge outside ChromeNative: ${decl.split('\n')[0]}`);
  for (const cls of ['SBApplication', 'SBObject', 'SBElementArray'])
    if (!new RegExp(`^final class ${cls} \\{$`, 'm').test(inside)) v.push(`native-chrome.swift boundary does not declare ChromeNative.${cls}`);
  if (inside && !/^extension ChromeNative \{$/m.test(inside)) v.push('native-chrome.swift boundary is not inside ChromeNative');
  // Inside the boundary: `raw` is never messaged, aliased or passed anywhere but to the shim.
  for (const line of codeOnly(inside).split('\n').map(l => l.trim())) {
    if (/\braw\s*[?!]?\s*\./.test(line)) v.push(`native-chrome.swift boundary messages a raw object: ${line}`);
    const uses = line.replace(/\bMyChromeSB\w+\(raw,/g, 'SHIM(').replace(/\bself\.raw\b/g, 'SELF_RAW');
    if (/\braw\b/.test(uses) && !RAW_USES.some(re => re.test(line))) v.push(`native-chrome.swift boundary uses a raw object outside the shim: ${line}`);
  }
  // chromectl.swift: top-level shadows of all three classes, each wrapping ChromeNative's.
  for (const cls of ['SBApplication', 'SBObject', 'SBElementArray']) {
    const body = block(cli, `\nfinal class ${cls} {`);
    if (!body) v.push(`chromectl.swift does not shadow ${cls}`);
    else if (!new RegExp(`let inner: ChromeNative\\.${cls}\\b`).test(body)) v.push(`chromectl.swift ${cls} does not wrap ChromeNative.${cls}`);
  }
  if (/\bimport ScriptingBridge\b|\bSB(Application|Object|ElementArray)\b/.test(codeOnly(helper))) v.push('helper.swift uses ScriptingBridge');
  // The shim: every message function sends its one message inside @try and catches any thrown object.
  if (!shim) v.push('build-native.sh has no objc-try.h shim');
  else {
    const fns = shim.split(/(?=static inline )/).filter(s => s.startsWith('static inline ') && !s.startsWith('static inline void MyChromeSBCaught('))
      .map(s => s.replace(/\n#pragma[^\n]*/g, '').replace(/\nNS_ASSUME_NONNULL_END[\s\S]*$/, '\n'));
    if (fns.length !== 8) v.push(`objc-try.h has ${fns.length} message functions, expected 8`);
    for (const fn of fns) if (!SHIM_FN.test(fn)) v.push(`objc-try.h function not in the one-message @try form: ${fn.split('(')[0]}`);
  }
  return v;
}
const shimText = fs.readFileSync(BUILD, 'utf8').match(/<<'OBJC_TRY'\n([\s\S]*?)\nOBJC_TRY\n/)?.[1] ?? null;
const sources = { native, cli, helper, shim: shimText };
check('gate', 'gate', '3. every ScriptingBridge call site in the three Swift files goes through the boundary', () => {
  assert.deepEqual(gate(sources), []);
  const sites = [...native.split('\n'), ...cli.split('\n')].filter(l => /\.value\(forKey:|\.object\((withID|at):|\.perform\(|\)\?\.count\b|SBApplication\(processIdentifier/.test(l));
  assert.ok(sites.length >= 40, `call sites listed: ${sites.length}`);
});
const mutants = {
  'direct call in chromectl': { cli: cli.replace('sbPreCommand = false\n', 'sbPreCommand = false\n_ = ScriptingBridge.SBApplication(processIdentifier: 1)?.value(forKey: "windows")\n') },
  'direct call in native-chrome outside the boundary': { native: native.replace('func identity(_ pid: pid_t) throws {\n', 'func identity(_ pid: pid_t) throws {\n            _ = ScriptingBridge.SBApplication(processIdentifier: pid)?.value(forKey: "windows")\n') },
  'shadow class removed from chromectl': { cli: cli.replace('\nfinal class SBObject {', '\nfinal class SBObjectWrapper {') },
  'helper.swift starts using ScriptingBridge': { helper: helper.replace('import Foundation\n', 'import Foundation\nimport ScriptingBridge\nlet sbProbe = SBApplication(processIdentifier: 1)\n') },
  'top-level function outside ChromeNative': { native: native.replace('\n// MARK: - ScriptingBridge boundary (CRASH1)', '\nfunc rawWindows(_ a: SBApplication) -> Any? { a.value(forKey: "windows") }\n// MARK: - ScriptingBridge boundary (CRASH1)') },
  'boundary messages its raw object': { native: native.replace('let value = MyChromeSBValueForKey(raw, key, &caught)', 'let value = raw.value(forKey: key)') },
  'boundary aliases its raw object (Codex r1 item 3)': { native: native.replace('let value = MyChromeSBValueForKey(raw, key, &caught)', 'let receiver = raw; let value = receiver.value(forKey: key)') },
  'shim function without @try': { shim: shimText?.replace('@try { return [array objectWithID:identifier]; }\n    @catch (id thrown) { MyChromeSBCaught(thrown, name); return nil; }', 'return [array objectWithID:identifier];') },
  'shim message moved before @try (Codex r1 item 3)': { shim: shimText?.replace('    @try { return [array objectWithID:identifier]; }', '    id result = [array objectWithID:identifier];\n    @try { return result; }') },
};
check('gate', 'gate', '3. the gate fires on each scratch copy with a direct or escaped call', () => {
  const scratch = path.join(tmp, 'gate-mutants'); fs.mkdirSync(scratch);
  for (const [name, change] of Object.entries(mutants)) {
    const copy = { ...sources, ...change };
    assert.notDeepEqual(copy, sources, `mutant applied: ${name}`);
    const fired = gate(copy);
    fs.writeFileSync(path.join(scratch, name.replace(/\W+/g, '-') + '.json'), JSON.stringify({ changed: Object.keys(change), fired }, null, 2));
    assert.ok(fired.length > 0, `gate silent for mutant: ${name}`);
    console.log(`        mutant "${name}" -> ${fired[0]}`);
  }
});

console.log(`${passed} passed, ${failed} failed (group ${GROUP}${CASES ? `, cases ${[...CASES].join(',')}` : ''}). Artifacts: ${tmp}`);
process.exitCode = failed ? 1 : 0;
