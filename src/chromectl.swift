// chromectl — talk to ONE specific Google Chrome process via ScriptingBridge.
//
// Why not `tell application "Google Chrome"`: Apple Events addressed by name
// go to whichever instance macOS picks, and on this machine other programs
// start extra Chrome instances (a Hermes PDF job, --headless automation that
// still exposes scriptable windows). Measured 2026-09-28: while such an
// instance ran, AppleScript saw 0 windows and every call failed. Here the
// target is chosen by pid, so a stray instance can never be driven by mistake.
//
// Usage (one JSON line out, always):
//   chromectl list
//   chromectl info|activate [--tab ID]
//   chromectl select <tabId> [--window W] make it its window's active tab; no activation, no raise;
//                                        with --window, refused unless the tab is in window W
//   chromectl eval <file.js> [--tab ID]
//   chromectl open <url> [windowId] [--select]
//   chromectl newwindow <url> <left> <top> <right> <bottom>
//   chromectl close <tabId>
//   chromectl scene                      front app + Chrome's front window/tab
//   chromectl restore <appPid> <windowId> <tabId> [--stop-on-input] [--if-chrome-front]
//                     [--since <epochMs>] [--no-click-since <epochMs>]
//   chromectl pick                       which Chrome process would be used, and why
//   chromectl profiles                   Chrome's profiles and their Apple-Events JS setting (files
//                                        only; Chrome need not be running)
//   chromectl axwindows <pid>            any app's AX windows and their CG window numbers (reads only)
//   chromectl axinput <pid> --window <cgWindow> [--point x y | --focus]
//                                        read-only native input/menu/date probe; no Apple Events
//
// `cgWindow` (list/info/activate/select) is the CoreGraphics window number of
// the Chrome window, for the input helper's per-window guards; null when it
// cannot be matched to exactly one layer-0 window of the pid (see cgWindowIds).
import AppKit
import ScriptingBridge
import Carbon
import CryptoKit

// MARK: - output

func emit(_ obj: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "error": code, "message": message])
}

// MARK: - Chrome's profile files

/// Chrome's user data folder; CHROME_BRIDGE_CHROME_DIR replaces it (tests).
func chromeDataDir() -> String {
    if let d = ProcessInfo.processInfo.environment["CHROME_BRIDGE_CHROME_DIR"], !d.isEmpty { return d }
    return NSHomeDirectory() + "/Library/Application Support/Google/Chrome"
}

/// `chromectl profiles`: every Chrome profile — directory, display name, account, and whether
/// "Allow JavaScript from Apple Events" is on (read_page needs it; it is a per-profile setting only
/// a person can switch on): true, false (off or never set: Chrome's default is off), or null (no
/// readable Preferences file). Read from the files only, so it needs no running Chrome.
func profilesReport() -> [String: Any] {
    let dir = chromeDataDir()
    guard let data = FileManager.default.contents(atPath: dir + "/Local State"),
          let ls = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let prof = ls["profile"] as? [String: Any] else { fail("no_local_state", "读不到 Chrome 的 Local State") }
    let cache = prof["info_cache"] as? [String: Any] ?? [:]
    var outP: [[String: Any]] = []
    for (k, v) in cache.sorted(by: { $0.key < $1.key }) {
        let info = v as? [String: Any] ?? [:]
        var js: Any = NSNull()
        if let pd = FileManager.default.contents(atPath: dir + "/" + k + "/Preferences"),
           let pj = try? JSONSerialization.jsonObject(with: pd) as? [String: Any] {
            // A profile signed in to Chrome keeps the switch with its account (account_values.browser…), and that value
            // is the one in force; the local browser… key is often missing then (seen 2026-10-14: "Leonard" read as off).
            let key = "allow_javascript_apple_events"
            let account = ((pj["account_values"] as? [String: Any])?["browser"] as? [String: Any])?[key] as? Bool
            js = account ?? ((pj["browser"] as? [String: Any])?[key] as? Bool) ?? false
        }
        outP.append(["dir": k, "name": info["name"] ?? "", "user": info["user_name"] ?? "", "appleEventsJS": js])
    }
    return ["ok": true, "lastUsed": prof["last_used"] ?? NSNull(), "default": targetProfile() ?? NSNull(), "profiles": outP]
}

// MARK: - choosing the Chrome process

func processArgs(_ pid: pid_t) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/ps")
    p.arguments = ["-o", "args=", "-p", String(pid)]
    let pipe = Pipe()
    p.standardOutput = pipe
    try? p.run()
    p.waitUntilExit()
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
}

/// The same argument string as `ps -o args=`, read in-process (sysctl KERN_PROCARGS2, no child
/// process): cheap enough for a check on every pre-warmed command. nil when it cannot be read.
func processArgsNow(_ pid: pid_t) -> String? {
    var mib: [Int32] = [CTL_KERN, KERN_ARGMAX], argmax: Int32 = 0, size = MemoryLayout<Int32>.size
    guard sysctl(&mib, 2, &argmax, &size, nil, 0) == 0, argmax > 0 else { return nil }
    var buffer = [UInt8](repeating: 0, count: Int(argmax))
    mib = [CTL_KERN, KERN_PROCARGS2, pid]
    size = buffer.count
    guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
    // argc, the executable path, NUL padding, then argc NUL-terminated arguments (then the environment).
    let argc = buffer.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    var i = MemoryLayout<Int32>.size
    while i < size && buffer[i] != 0 { i += 1 }
    while i < size && buffer[i] == 0 { i += 1 }
    var args: [String] = []
    while args.count < Int(argc) && i < size {
        let start = i
        while i < size && buffer[i] != 0 { i += 1 }
        args.append(String(decoding: buffer[start..<i], as: UTF8.self))
        i += 1
    }
    return args.count == Int(argc) ? args.joined(separator: " ") : nil
}

func onScreenWindowCount(_ pid: pid_t) -> Int {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return 0 }
    return list.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 }.count
}

struct Candidate { let app: NSRunningApplication; let args: String; let onScreen: Int }

/// The user's interactive Chrome: never a --headless process; prefer one with
/// windows actually on screen, then the default profile (no --user-data-dir),
/// then the oldest. CHROME_BRIDGE_PID overrides everything.
func pickChrome() -> (NSRunningApplication?, [[String: Any]]) {
    var report: [[String: Any]] = []
    // A bound cold command never falls back to another Chrome process.
    if let i = CommandLine.arguments.firstIndex(of: "--pid") {
        guard i + 1 < CommandLine.arguments.count, let pid = pid_t(CommandLine.arguments[i + 1]), pid > 0,
              let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.bundleIdentifier == "com.google.Chrome" else { return (nil, []) }
        return (app, [["pid": Int(pid), "reason": "explicit_pid"]])
    }
    if let s = ProcessInfo.processInfo.environment["CHROME_BRIDGE_PID"], let pid = pid_t(s),
       let a = NSRunningApplication(processIdentifier: pid) {
        return (a, [["pid": pid, "reason": "CHROME_BRIDGE_PID"]])
    }
    let all = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").filter { !$0.isTerminated }
    var cands: [Candidate] = []
    for a in all {
        let args = processArgs(a.processIdentifier)
        let headless = args.contains("--headless")
        let onScreen = onScreenWindowCount(a.processIdentifier)
        report.append(["pid": a.processIdentifier, "headless": headless, "onScreenWindows": onScreen,
                       "customProfile": args.contains("--user-data-dir")])
        if !headless { cands.append(Candidate(app: a, args: args, onScreen: onScreen)) }
    }
    cands.sort { x, y in
        if (x.onScreen > 0) != (y.onScreen > 0) { return x.onScreen > 0 }
        let xd = x.args.contains("--user-data-dir"), yd = y.args.contains("--user-data-dir")
        if xd != yd { return !xd }
        return (x.app.launchDate ?? .distantFuture) < (y.app.launchDate ?? .distantFuture)
    }
    return (cands.first?.app, report)
}

// MARK: - ScriptingBridge plumbing

final class ErrorCatcher: NSObject, SBApplicationDelegate {
    var last: String?
    var lastCode: Int = 0
    func eventDidFail(_ event: UnsafePointer<AppleEvent>, withError error: Error) -> Any? {
        let e = error as NSError
        lastCode = e.code
        last = (e.userInfo["ErrorString"] as? String) ?? e.localizedDescription
        return nil
    }
}

func classify(_ msg: String, _ code: Int) -> String {
    if msg.contains("support.google.com/chrome/?p=applescript") { return "js_from_apple_events_disabled" }
    if msg.contains("AppleScript") && (msg.contains("turned off") || msg.contains("已关闭") || msg.contains("disabled")) {
        return "js_from_apple_events_disabled"
    }
    if code == -1743 || msg.contains("Not authorized") { return "no_automation_permission" }
    if code == -600 { return "chrome_not_running" }
    return "chrome_error"
}

/// CHROMECTL_TRACE=1: per-stage timing on stderr (where a command's time goes).
let traceOn = ProcessInfo.processInfo.environment["CHROMECTL_TRACE"] == "1"
let traceT0 = Date()
var traceLast = Date()
func trace(_ what: String) {
    guard traceOn else { return }
    let now = Date()
    FileHandle.standardError.write("[chromectl \(Int(now.timeIntervalSince(traceT0) * 1000)) ms +\(Int(now.timeIntervalSince(traceLast) * 1000))] \(what)\n".data(using: .utf8)!)
    traceLast = now
}
trace("start")
let catcher = ErrorCatcher()
// The ScriptingBridge boundary's state (see "ScriptingBridge boundary" below); set before any Apple Event.
// Only the --warm-read pre-warm runs before its command is known; every other Apple Event belongs to a command.
var sbPreCommand = CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "--warm-read"
var sbRecorded: ChromeNative.SBException?
/// `chromectl --warm-read`, the read-only pre-warm the bridge keeps ready. The mode is its
/// declaration at spawn: it runs only `warmReadCommands`, so it may choose Chrome and pay the
/// first read-only Apple Event (counting windows) BEFORE its command arrives. Only once that
/// Apple Event succeeded does it report ready, on fd 3 and never on stdout:
/// {"ready":true,"protocol":1,"chromePid":<the pid it chose>}. Any failure exits with no ready
/// line and no output; the caller then runs its command cold, which reports the cause.
func preWarmReadOnly() -> (pick: (NSRunningApplication?, [[String: Any]]), chrome: SBApplication) {
    // The caller's ready channel, checked before this process opens a descriptor of its own.
    // A run without one (by hand, a timing script) still works; it only gets no notice.
    var channel = stat()
    let readyFD: Int32? = fstat(3, &channel) == 0 &&
        [S_IFSOCK, S_IFIFO].contains(channel.st_mode & S_IFMT) ? 3 : nil
    let pick = pickChrome()
    trace("pickChrome")
    guard let app = pick.0, !app.isTerminated,
          let chrome = SBApplication(processIdentifier: app.processIdentifier) else { exit(1) }
    chrome.delegate = catcher
    let windows = (chrome.value(forKey: "windows") as? SBElementArray)?.count
    trace("warm: first Apple Event")
    guard windows != nil, catcher.last == nil else { exit(1) }
    if let fd = readyFD {
        let ready = try! JSONSerialization.data(withJSONObject: ["ready": true, "protocol": 1,
                                                                 "chromePid": Int(app.processIdentifier)])
        let line = ready + Data("\n".utf8)
        guard line.withUnsafeBytes({ write(fd, $0.baseAddress, $0.count) }) == line.count else { exit(1) }
        close(fd)
    }
    trace("warm-read: ready")
    return (pick, chrome)
}
/// Is a pre-warmed binding still what pickChrome would choose? Checked when the command arrives,
/// before anything runs, in-process (no `ps`, no Apple Event): pickChrome's own --pid and
/// CHROME_BRIDGE_PID overrides first; otherwise exactly one non-headless Google Chrome must be
/// running and be this pid. Several candidates, or one whose arguments cannot be read, is never
/// assumed to match: the caller then runs the command cold, which chooses afresh.
func preWarmBindingCurrent(_ pid: pid_t) -> Bool {
    if let i = CommandLine.arguments.firstIndex(of: "--pid") {
        return i + 1 < CommandLine.arguments.count && pid_t(CommandLine.arguments[i + 1]) == pid &&
            NSRunningApplication(processIdentifier: pid).map { !$0.isTerminated } == true
    }
    if let s = ProcessInfo.processInfo.environment["CHROME_BRIDGE_PID"], let override = pid_t(s),
       let app = NSRunningApplication(processIdentifier: override) {
        return override == pid && !app.isTerminated
    }
    var candidates: [pid_t] = []
    for app in NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome") where !app.isTerminated {
        guard let args = processArgsNow(app.processIdentifier) else { return false }
        if !args.contains("--headless") { candidates.append(app.processIdentifier) }
    }
    return candidates == [pid]
}
// `chromectl --warm`: start ahead of time, then wait for ONE command on stdin as a JSON array
// of arguments, run it and exit like a normal invocation. It reads its command first, so
// protected and cold-only commands are refused before Chrome discovery or any Apple Event
// (c31ca9b); it then chooses Chrome and sends its first Apple Event like a cold run.
// `--warm-read` (above) is the pre-warm that is chosen and connected before its command.
let warm = CommandLine.arguments.count > 1 && ["--warm", "--warm-read"].contains(CommandLine.arguments[1])
let warmRead = warm && CommandLine.arguments[1] == "--warm-read"
/// All a read-only pre-warm runs: no mutation, no cold-only native probe, no --pid binding.
let warmReadCommands: Set<String> = ["list", "info", "eval", "scene", "profiles"]
let preWarmed = warmRead ? preWarmReadOnly() : nil
func readWarmCommand() -> [String] {
    guard let line = readLine(strippingNewline: true), let data = line.data(using: .utf8),
          let a = try? JSONSerialization.jsonObject(with: data) as? [String], !a.isEmpty else { exit(0) }
    return a
}
let cmdArgs: [String] = warm ? readWarmCommand() : Array(CommandLine.arguments.dropFirst())
trace("command")
let cmd = cmdArgs.first ?? ""
// Protected mutations exist only in the captured cgevent Session owner.
// Refuse before opening an Apple Event connection, including warm invocations.
if ["open", "newwindow", "move", "close", "select", "activate", "restore"].contains(cmd) ||
   (cmd == "dialog" && (cmdArgs.contains("--press") || cmdArgs.contains("--text"))) {
    emit(["ok": false, "error": "native_session_required", "inputDelivery": "not_sent",
          "message": "This native mutation requires the protected action Session."])
}
// A read-only pre-warm runs only what it declared at spawn; a bound command needs its own cold process.
if warmRead && (!warmReadCommands.contains(cmd) || cmdArgs.contains("--pid")) {
    emit(["ok": false, "error": "warm_read_refused", "inputDelivery": "not_sent",
          "message": "This pre-warmed helper runs read-only commands only; nothing was sent."])
}
// Its Chrome may no longer be the one to choose (another instance started, or this one quit):
// say so before running anything. The caller runs this same command cold; nothing was sent here.
if warmRead, let bound = preWarmed?.pick.0 {
    let current = preWarmBindingCurrent(bound.processIdentifier)
    trace("warm-read: binding checked")
    if !current {
        emit(["ok": false, "error": "warm_binding_stale", "inputDelivery": "not_sent", "stage": "warm_binding",
              "message": "The pre-warmed helper's Chrome is no longer the only choice; nothing was sent."])
    }
}
// Files only: works while Chrome is closed too (`mychrome-mcp doctor` reads it before Chrome is open).
if cmd == "profiles" { emit(profilesReport()) }
// windowmatch: matchWindows on a JSON description read from stdin (tests; nothing is read from
// Chrome or the screen): {"chrome":[{id,rect:[x,y,w,h],minimized,index,title,title2 (2nd read)}],
// "cg":[{num,rect,onScreen}], "onOrder":[{num,rect}], "ax":[{num,title,minimized,rect}]}
if cmd == "windowmatch" {
    func rect(_ v: Any?) -> CGRect? {
        guard let a = v as? [Double], a.count == 4 else { return nil }
        return CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
    }
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { fail("usage", "windowmatch: JSON on stdin") }
    let chrome = (j["chrome"] as? [[String: Any]]) ?? []
    let cw = chrome.map { ChromeWin(id: ($0["id"] as? Int) ?? 0, rect: rect($0["rect"]) ?? .zero,
                                    minimized: ($0["minimized"] as? Bool) ?? false, index: $0["index"] as? Int) }
    let cg = ((j["cg"] as? [[String: Any]]) ?? []).map { (num: ($0["num"] as? Int) ?? 0, rect: rect($0["rect"]) ?? .zero, onScreen: ($0["onScreen"] as? Bool) ?? false) }
    let order = ((j["onOrder"] as? [[String: Any]]) ?? []).map { (num: ($0["num"] as? Int) ?? 0, rect: rect($0["rect"]) ?? .zero) }
    let axw = ((j["ax"] as? [[String: Any]]) ?? []).map { (num: ($0["num"] as? Int) ?? 0, title: ($0["title"] as? String) ?? "",
                                                           minimized: ($0["minimized"] as? Bool) ?? false, rect: rect($0["rect"])) }
    var axAsked = false, titlesAsked = 0, reads: [Int: Int] = [:]
    let m = matchWindows(cw, cg: cg, onOrder: { order }, ax: { axAsked = true; return axw },
                         title: { k in
                             titlesAsked += 1
                             let again = (reads[k] ?? 0) > 0
                             reads[k] = (reads[k] ?? 0) + 1
                             return ((again ? chrome[k]["title2"] : nil) as? String) ?? (chrome[k]["title"] as? String) ?? ""
                         })
    emit(["ok": true, "map": Dictionary(uniqueKeysWithValues: m.map { (String($0.key), $0.value) }),
          "axAsked": axAsked, "titlesAsked": titlesAsked])
}
// axwindows <pid>: that app's AX windows with their CG numbers (the bridge raise/key checks use),
// each checked against the CG list (same owner, same frame). Reads only; any app, Chrome need not run.
if cmd == "axwindows" {
    guard cmdArgs.count > 1, let pid = pid_t(cmdArgs[1]) else { fail("usage", "axwindows <pid>") }
    let cgl = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
    let rows: [[String: Any]] = axWindowTable(pid: pid).map { w in
        let d = cgl.first { ($0[kCGWindowNumber as String] as? Int) == w.num }
        let owner = d?[kCGWindowOwnerPID as String] as? Int
        let cr = (d?[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
        return ["cgWindow": w.num, "minimized": w.minimized, "titleChars": w.title.count,
                "cgOwnerMatches": owner == Int(pid),
                "cgFrameMatches": (cr != nil && w.rect != nil) ? sameRect(cr!, w.rect!) : NSNull()]
    }
    emit(["ok": true, "pid": Int(pid), "windows": rows])
}
// axcontent/axinput inspect the Chrome pid they are given, so they run before Chrome discovery
// and any Apple Event (discovery's choice was never used). Each still verifies that the pid is a
// running Google Chrome and that the window belongs to it; --warm refuses them here as well.
// Content geometry only. Never read titles, URLs or field values.
if cmd == "axcontent" {
    guard !warm, cmdArgs.count == 4, let pid = pid_t(cmdArgs[1]), pid > 0,
          cmdArgs[2] == "--window", let window = Int(cmdArgs[3]), window > 0 else {
        fail("usage", "axcontent <pid> --window <cgWindow> (cold only)")
    }
    do { emit(try nativePageContent(pid: pid, expectedWindow: window)) }
    // Its details beside the code and message, as axinput: a stopped probe's limit and counts, or the
    // identity check's enums. Never page text, titles, URLs or AX names.
    catch let e as NativeInputProbeError {
        emit(["ok": false, "error": e.code, "message": e.message].merging(e.details) { original, _ in original })
    }
    catch { fail("page_content_unavailable", "无法确认网页内容区域，这次没有截图。") }
}
if cmd == "axinput" {
    guard !warm, cmdArgs.count >= 4, let pid = pid_t(cmdArgs[1]), pid > 0,
          let wi = cmdArgs.firstIndex(of: "--window"), wi + 1 < cmdArgs.count,
          let cg = Int(cmdArgs[wi + 1]), cg > 0 else {
        fail("usage", "axinput <pid> --window <cgWindow> [--point x y | --focus] (cold only)")
    }
    var point: CGPoint? = nil
    if let pi = cmdArgs.firstIndex(of: "--point") {
        guard pi + 2 < cmdArgs.count, let x = Double(cmdArgs[pi + 1]), let y = Double(cmdArgs[pi + 2]),
              x.isFinite, y.isFinite else { fail("usage", "axinput --point requires finite screen coordinates") }
        point = CGPoint(x: x, y: y)
    }
    do { emit(try nativeInputProbe(pid: pid, expectedWindow: cg, point: point)) }
    catch let e as NativeInputProbeError {
        emit(["ok": false, "error": e.code, "message": e.message].merging(e.details) { original, _ in original })
    }
    catch { fail("ax_probe_failed", "The native input target could not be inspected.") }
}
// Dialogs use their own fixed-PID connection, only after a complete AX scan. An unbound probe
// enumerates Chrome itself and refuses several instances, so discovery's choice would go unused.
// Never let discovery or a warm Apple Event choose or block their target.
if cmd == "dialog" { nativeDialogCommand(cmdArgs) }
let (chromeProc, pickReport) = preWarmed?.pick ?? pickChrome()
trace(warmRead ? "pre-warmed Chrome" : "pickChrome")
let warmChrome: SBApplication? = preWarmed?.chrome ??
    (warm ? chromeProc.flatMap { SBApplication(processIdentifier: $0.processIdentifier) } : nil)
// The first Apple Event to Chrome also sets up the connection. --warm-read paid it before its command.
if !warmRead, let c = warmChrome { _ = (c.value(forKey: "windows") as? SBElementArray)?.count; trace("warm: first Apple Event") }


if cmd == "pick" {
    emit(["ok": chromeProc != nil, "pid": chromeProc.map { Int($0.processIdentifier) } ?? NSNull(), "candidates": pickReport])
}
// Must stay before SBApplication initialization. A native menu can block all Apple Events.
// Call this command cold: --warm has already sent an Apple Event before reading its command.
if cmd == "axmenustate" {
    guard !warm, cmdArgs.count == 1 else { fail("usage", "axmenustate (cold only)") }
    do { emit(try nativeFrontMenuState()) }
    catch let e as NativeInputProbeError { fail(e.code, e.message) }
    catch { fail("ax_probe_failed", "The frontmost Chrome menu state could not be inspected.") }
}
// The command phase for every mode: from here a ScriptingBridge exception ends the command with its JSON failure line.
sbPreCommand = false
guard let chromeProc = chromeProc, !chromeProc.isTerminated,
      let chrome = warmChrome ?? SBApplication(processIdentifier: chromeProc.processIdentifier) else {
    if cmd == "close" { emit(["ok": false, "error": "chrome_not_running", "stage": "close_identity", "inputDelivery": "not_sent"]) }
    fail("chrome_not_running", "Google Chrome 没有在运行（或只有 headless 实例）")
}
chrome.delegate = catcher
trace("SBApplication")
var closeCommandSent = false

func check(_ stage: String = "apple_event") {
    if let m = catcher.last {
        // Stage names contain no script, title, URL, or field contents. Preserve
        // the original failure; never turn an uncertain lookup into "tab gone".
        let code = catcher.lastCode
        var result: [String: Any] = ["ok": false, "error": classify(m, code), "osStatus": code, "stage": stage,
                                    "message": "\(m)（Apple Event 阶段：\(stage)，code \(code)）"]
        if cmd == "close" { result["inputDelivery"] = closeCommandSent ? "unknown" : "not_sent" }
        emit(result)
    }
}

// MARK: - ScriptingBridge boundary, chromectl's top-level side (CRASH1)
// These names shadow ScriptingBridge's classes for this file, so its call sites keep their shape. Each wraps
// native-chrome.swift's ChromeNative boundary, which sends every message inside the Objective-C @try shim.
// A caught exception is never a value, never "absent" and never retried here:
// - in the --warm-read pre-warm (before its command exists) it is recorded and the read gives nil, so the
//   pre-warm still exits with no ready line and no output;
// - everywhere else (cold, --warm, which reads its command first, and every command) it ends the command with
//   one JSON failure line, as check() ends it, before any later branch (pick included) can report success;
//   a recorded one is reported by the first boundary call after the pre-warm.
func sbBoundary<T>(_ body: () throws -> T) -> T? {
    if !sbPreCommand, let recorded = sbRecorded { sbFailure(recorded) }
    do { return try body() } catch {
        let caught = error as? ChromeNative.SBException ?? ChromeNative.SBException(nil, .value, "unknown")
        if !sbPreCommand { sbFailure(caught) }
        sbRecorded = sbRecorded ?? caught
        return nil
    }
}
/// The site's own failure family: chrome_error, as check() reports a failed Apple Event. A script command
/// (executeJavascript:) may already have run: eval_result and noRetry, and it is never sent again.
func sbFailure(_ caught: ChromeNative.SBException) -> Never {
    let script = caught.operation == .perform
    var result: [String: Any] = ["ok": false, "error": "chrome_error", "stage": script ? "eval_result" : "apple_event",
                                 "exceptionName": caught.name, "sbOperation": caught.operation.rawValue, "sbKey": caught.key,
                                 "message": "Chrome 的脚本接口抛出了异常（\(caught.name)），这次没有完成。"]
    if script { result["noRetry"] = true }
    emit(result)
}
func sbTopLevel(_ value: Any?) -> Any? {
    if let array = value as? ChromeNative.SBElementArray { return SBElementArray(array) }
    if let object = value as? ChromeNative.SBObject { return SBObject(object) }
    return value
}
final class SBApplication {
    let inner: ChromeNative.SBApplication
    init?(processIdentifier pid: pid_t) {
        guard let app = ChromeNative.SBApplication(processIdentifier: pid) else { return nil }
        inner = app
    }
    var delegate: SBApplicationDelegate? { get { inner.delegate } set { inner.delegate = newValue } }
    func value(forKey key: String) -> Any? { sbBoundary { sbTopLevel(try inner.value(forKey: key)) } ?? nil }
}
final class SBObject {
    let inner: ChromeNative.SBObject
    init(_ inner: ChromeNative.SBObject) { self.inner = inner }
    func value(forKey key: String) -> Any? { sbBoundary { sbTopLevel(try inner.value(forKey: key)) } ?? nil }
    func perform(_ selector: Selector, with argument: Any?) -> Unmanaged<AnyObject>? {
        guard let value = sbBoundary({ try inner.perform(selector, with: argument) }) ?? nil else { return nil }
        return Unmanaged.passRetained(value as AnyObject).autorelease()
    }
}
final class SBElementArray {
    let inner: ChromeNative.SBElementArray
    init(_ inner: ChromeNative.SBElementArray) { self.inner = inner }
    func value(forKey key: String) -> Any? { sbBoundary { sbTopLevel(try inner.value(forKey: key)) } ?? nil }
    func object(withID identifier: Any) -> Any? { sbBoundary { sbTopLevel(try inner.object(withID: identifier)) } ?? nil }
    func object(at index: Int) -> Any? { sbBoundary { sbTopLevel(try inner.object(at: index)) } ?? nil }
    var count: Int? { sbBoundary { try inner.count } }
}

func windows() -> SBElementArray { chrome.value(forKey: "windows") as! SBElementArray }
func tabs(_ w: SBObject) -> SBElementArray { w.value(forKey: "tabs") as! SBElementArray }
/// Chrome's sdef declares `id` as text: ScriptingBridge hands ids back as strings.
func num(_ v: Any?) -> Int {
    if let n = v as? NSNumber { return n.intValue }
    if let s = v as? String { return Int(s) ?? 0 }
    return 0
}
func str(_ v: Any?) -> String { (v as? String) ?? "" }

/// All ids of an element array in ONE Apple Event.
func ids(_ arr: SBElementArray, stage: String = "element_ids") -> [Int] {
    let value = arr.value(forKey: "id")
    // A failed Apple Event produces nil too. Preserve its error before an
    // empty lookup can be misreported as a tab that the user closed.
    check(stage)
    return ((value as? NSArray) ?? []).map { num($0) }
}

/// Retry only this read-only collection lookup, never its driver command or input.
/// A second explicit error keeps its own status (especially permission denial).
/// An invalid read without an error preserves the first -1701 and its stage.
func tabLookupWindowIds() -> [Int] {
    check("find_tab_windows")
    let first = windows().value(forKey: "id")
    if let originalMessage = catcher.last, catcher.lastCode == -1701 {
        let originalCode = catcher.lastCode
        catcher.last = nil
        catcher.lastCode = 0
        let refreshed = windows().value(forKey: "id")
        check("find_tab_windows")
        if let values = refreshed as? NSArray {
            let refreshedIds = values.map { num($0) }
            if refreshedIds.allSatisfy({ $0 > 0 }), Set(refreshedIds).count == refreshedIds.count {
                return refreshedIds
            }
        }
        catcher.last = originalMessage
        catcher.lastCode = originalCode
    }
    check("find_tab_windows")
    return ((first as? NSArray) ?? []).map { num($0) }
}

func boundsJSON(_ w: SBObject, capture: ((CGRect) -> Void)? = nil) -> [String: Any] {
    let r = (w.value(forKey: "bounds") as? NSValue)?.rectValue ?? .zero
    capture?(r)
    return ["left": Int(r.origin.x), "top": Int(r.origin.y), "width": Int(r.size.width), "height": Int(r.size.height)]
}

func window(id: Int) -> SBObject? {
    guard ids(windows()).contains(id) else { return nil }
    return (windows().object(withID: String(id)) as! SBObject)
}

/// Locate a tab by id anywhere; returns (window, tab, windowId).
func findTab(_ tid: Int) -> (SBObject, SBObject, Int)? {
    for wid in tabLookupWindowIds() {
        let w = windows().object(withID: String(wid)) as! SBObject
        if ids(tabs(w), stage: "find_tab_tabs").contains(tid) {
            return (w, tabs(w).object(withID: String(tid)) as! SBObject, wid)
        }
    }
    return nil
}

/// Layer-0 CG windows of one pid (on screen or not). Chrome's AppleScript
/// bounds and CG bounds share the same top-left-origin global coordinates.
func cgWindows(pid: pid_t) -> [(num: Int, rect: CGRect, onScreen: Bool)] {
    guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { d in
        guard (d[kCGWindowOwnerPID as String] as? Int) == Int(pid), (d[kCGWindowLayer as String] as? Int) == 0,
              let n = d[kCGWindowNumber as String] as? Int,
              let bd = d[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: bd as CFDictionary) else { return nil }
        return (n, r, (d[kCGWindowIsOnscreen as String] as? Bool) ?? false)
    }
}

/// Chrome window id -> CG window number (see matchWindows), from Chrome's window list, the CG
/// window list and, only for twins nothing else tells apart, Accessibility.
func cgWindowIds() -> [Int: Int] {
    let arr = windows()
    let wids = ids(arr)
    let rects = ((arr.value(forKey: "bounds") as? NSArray) ?? []).map { ($0 as? NSValue)?.rectValue ?? .zero }
    let mins = ((arr.value(forKey: "minimized") as? NSArray) ?? []).map { ($0 as? Bool) ?? false }
    guard rects.count == wids.count, mins.count == wids.count else { return [:] }
    let idx = ((arr.value(forKey: "index") as? NSArray) ?? []).map { ($0 as? NSNumber)?.intValue ?? Int.max }
    let pid = chromeProc.processIdentifier
    let cw = wids.indices.map { ChromeWin(id: wids[$0], rect: rects[$0], minimized: mins[$0], index: idx.count == wids.count ? idx[$0] : nil) }
    return matchWindows(cw, cg: cgWindows(pid: pid), onOrder: { cgOnScreenOrder(pid: pid) }, ax: { axWindowTable(pid: pid) },
                        title: { k in str(((arr.object(at: k) as? SBObject)?.value(forKey: "activeTab") as? SBObject)?.value(forKey: "title")) })
}

/// One Chrome window as matchWindows sees it (AppleScript: id, bounds, minimized, index 1 = front).
typealias ChromeWin = ChromeNative.ChromeWin

/// Chrome window id -> CG window number, matched by bounds (±2 pt). Several Chrome windows often
/// share bounds (every maximized window on a display; seen live: a minimized and a normal window,
/// both 0,30 1920x970). In order, a twin is told apart:
///  1. when it is the sole Chrome window with those bounds AND that minimized state, by requiring
///     CG on-screen == not minimized;
///  2. through Accessibility, which knows each window's CG number exactly: when bounds, minimized
///     state and the active tab's title ("<title> - Google Chrome…") single out one AX window and
///     one Chrome window (`ax` and `title(k)` are called only when some twin is left);
///  3. twins all on screen (seen live after a Chrome restart: two windows stacked at 1960,959
///     1280x900): Chrome's window order (index 1 = front) paired with CoreGraphics' front-to-back
///     on-screen order; counts must match.
/// Anything still ambiguous, or a CG window claimed twice, gives no entry (-> null).
func matchWindows(_ cw: [ChromeWin], cg: [(num: Int, rect: CGRect, onScreen: Bool)],
                  onOrder: () -> [(num: Int, rect: CGRect)],
                  ax: () -> [(num: Int, title: String, minimized: Bool, rect: CGRect?)],
                  title: (Int) -> String) -> [Int: Int] {
    ChromeNative.matchWindows(cw, cg: cg, onOrder: onOrder, ax: ax, title: title)
}

// MARK: - Accessibility window numbers (from JustTab)
// The AX window <-> CoreGraphics window bridge and the bounded AX messages follow JustTab
// (~/work/justtab-seed; its seed sergio-farfan/alttab-macos is MIT, (c) 2026 Sergio Farfan).

/// The CG window number of an AX window: a private but long-standing HIServices call, the usual
/// bridge in macOS window managers. nil when it fails.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

func axWindowNumber(_ w: AXUIElement) -> Int? {
    ChromeNative.Probe().axWindowNumber(w)
}

/// Upper bound on one AX message to Chrome: a busy or hung Chrome then costs at most this per call
/// instead of the system default of 6 s.
var axMessagingTimeout: Float { 1.0 }

/// An app's AX windows, every element with the bounded timeout.
func axWindows(pid: pid_t) -> [AXUIElement] {
    ChromeNative.Probe().axWindows(pid: pid)
}

/// Each AX window of the pid that has a CG number: that number, its title, minimized state and frame.
func axWindowTable(pid: pid_t) -> [(num: Int, title: String, minimized: Bool, rect: CGRect?)] {
    axWindows(pid: pid).compactMap { w in
        guard let n = axWindowNumber(w) else { return nil }
        var t: CFTypeRef?, m: CFTypeRef?
        AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
        AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &m)
        return (n, (t as? String) ?? "", (m as? Bool) ?? false, axRect(w))
    }
}

/// macOS adds this tiny title-bar window to the recorded app while sharing one window.
/// It is an AXDialog/layer-0 window, but does not take keyboard focus or block page content.
/// Match the complete observed structure; ordinary dialogs and unknown AX failures stay protected.
func axIsWindowSharingIndicator(_ w: AXUIElement, timeout: Float = axMessagingTimeout) -> Bool {
    ChromeNative.Probe().axIsWindowSharingIndicator(w, timeout: timeout)
}

/// Small input-source indicators can be attached to Chrome as an AXDialog.
/// Known labels qualify only within the observed unfocused, nonmodal WeType
/// shape below; a Caps Lock label alone is never enough to dismiss a dialog.
/// Unknown labels, failed attributes, extra content and real dialogs stay protected.
func axIsInputSourceIndicator(_ w: AXUIElement, pid: pid_t) -> Bool {
    ChromeNative.Probe().axIsInputSourceIndicator(w, pid: pid)
}

/// Chrome's unfocused Translate bubble does not suspend JavaScript. Require its
/// observed nonmodal window, language tabs and exact toolbar buttons; a title
/// alone cannot exempt a dialog. This changes only the page-dialog probe:
/// window-order, keyboard-focus and point-occlusion guards still see the bubble.
func axIsChromeTranslationBubble(_ w: AXUIElement) -> Bool {
    ChromeNative.Probe().axIsChromeTranslationBubble(w)
}

/// On-screen layer-0 windows of one pid, front to back (CGWindowList order), excluding only the
/// confirmed system sharing indicator. Point-level occlusion checks still protect its actual area.
func cgOnScreenOrder(pid: pid_t) -> [(num: Int, rect: CGRect)] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    let indicators = Set(axWindows(pid: pid).filter { axIsWindowSharingIndicator($0) }.compactMap { axWindowNumber($0) })
    return list.compactMap { d in
        guard (d[kCGWindowOwnerPID as String] as? Int) == Int(pid), (d[kCGWindowLayer as String] as? Int) == 0,
              let n = d[kCGWindowNumber as String] as? Int, !indicators.contains(n),
              let bd = d[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: bd as CFDictionary) else { return nil }
        return (n, r)
    }
}

func cgWindowJSON(_ wid: Int) -> Any { cgWindowIds()[wid] ?? NSNull() }

/// `info` uses the native owner's fresh reader/matcher. `list` deliberately
/// retains the legacy metadata/heuristic path above; neither is a cached grant.
/// This short-lived owner has no target, pin, Session, hold or write authority.
func nativeInfoTarget(_ metadata: [String: Any], pid: pid_t, activeTab: Int,
                      activeURL: String, bounds: CGRect) throws -> [String: Any] {
    func changed() -> ChromeNative.Failure {
        ChromeNative.Failure("native_target_changed", "native_window_binding",
                             details: ["bindingReason": "snapshot_structure_changed"])
    }
    guard metadata["chromePid"] as? Int == Int(pid),
          let window = ChromeNative.dialogInt(metadata["windowId"]),
          let tab = ChromeNative.dialogInt(metadata["tabId"]),
          let url = metadata["url"] as? String else { throw changed() }
    let owner = ChromeNative.Owner(dry: false)
    try owner.identity(pid)
    // Synchronous value snapshots keep this standalone read on one thread;
    // no Session control handling or ReadRunner/pump is invented here.
    let initial = try ChromeNative.readSnapshot(pid)
    let access = ChromeNative.Probe()
    var validated: [ChromeNative.WindowRow]?
    let mapping = try owner.cgMapping(pid, rows: initial, access: access,
                                     captureRows: { validated = $0 })
    guard let rows = validated else { throw ChromeNative.Failure("native_read_unknown", "native_read") }
    guard let row = rows.first(where: { $0.id == window }), row.tabs.contains(tab),
          row.activeTab == activeTab, row.bounds == bounds,
          metadata["tabActive"] as? Bool == (row.activeTab == tab),
          metadata["windowIndex"] as? Int == row.index,
          metadata["minimized"] as? Bool == row.minimized,
          metadata["tabCount"] as? Int == row.tabs.count,
          let currentURL = row.tabURLs[tab], currentURL.utf8.elementsEqual(url.utf8),
          let currentActiveURL = row.tabURLs[row.activeTab], currentActiveURL.utf8.elementsEqual(activeURL.utf8) else {
        throw changed()
    }
    var result = metadata
    result["ok"] = true
    result["cgWindow"] = mapping[window] ?? NSNull()
    result["bounds"] = ["left": Int(row.bounds.minX), "top": Int(row.bounds.minY),
                        "width": Int(row.bounds.width), "height": Int(row.bounds.height)]
    result["url"] = currentURL
    // A WindowRow title describes its active tab, not every requested tab.
    if tab == row.activeTab { result["title"] = row.title }
    return result
}

func nativeInfoFailure(_ error: Error) -> [String: Any] {
    if let failure = error as? ChromeNative.ReadFailure {
        return ChromeNative.Failure(failure.code, "native_read", osStatus: failure.osStatus, details: failure.details).json
    }
    if let failure = error as? ChromeNative.Failure { return failure.json }
    if let failure = error as? ChromeNative.DialogFailure { return failure.json }
    return ChromeNative.Failure("native_read_unknown", "native_read").json
}

/// The window with index 1 (topmost Chrome window).
func frontWindowId() -> Int? {
    let all = ids(windows())
    let idx = ((windows().value(forKey: "index") as? NSArray) ?? []).map { num($0) }
    guard let k = idx.firstIndex(of: 1), k < all.count else { return all.first }
    return all[k]
}

/// Creating objects (new tab / new window) through ScriptingBridge failed
/// both ways tried live (typed init traps on SBPseudoClass_*, plain init ->
/// "can't add an object that already exists"). So creation goes through
/// AppleScript, but only in forms that cannot land in the wrong instance:
/// always addressed to an explicit `window id` (ids exist only in their own
/// process — a stray instance answers "no such window"), then re-checked by
/// pid through ScriptingBridge.




/// Make the window with these bounds Chrome's MAIN window via Accessibility,
/// so activating Chrome brings that window forward (activation restores the
/// app's main window: raising by `index` alone was undone by activation, and
/// the agent window ended up 2nd/3rd — seen live).
/// With `cg` (the window's CG number) it is that exact window: by bounds alone a twin with the same
/// bounds could be made main instead (JustTab matches by window number first, too).


func axRect(_ w: AXUIElement) -> CGRect? {
    ChromeNative.Probe().axRect(w)
}

func sameRect(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.origin.x - b.origin.x) <= 2 && abs(a.origin.y - b.origin.y) <= 2 &&
    abs(a.size.width - b.size.width) <= 2 && abs(a.size.height - b.size.height) <= 2
}

// MARK: - bounded dialog model (also compiled with synthetic AX in tests)

typealias DialogFailure = ChromeNative.DialogFailure
typealias DialogIdentity = ChromeNative.DialogIdentity
func dialogInt(_ value: Any?) -> Int? { ChromeNative.dialogInt(value) }
func dialogIdentity(_ value: [String: Any]) throws -> DialogIdentity { try ChromeNative.dialogIdentity(value) }
func dialogOptions(_ args: [String]) throws -> [String: String] { try ChromeNative.dialogOptions(args) }
func axPageDialog(pid: pid_t) throws -> ChromeNative.PageDialog? { try ChromeNative.Probe().axPageDialog(pid: pid) }
func inspectBoundDialog(pid: pid_t, target: [String: Any]?) throws -> ChromeNative.PageDialog? {
    try ChromeNative.Probe().inspect(pid: pid, target: target)
}

func nativeDialogCommand(_ args: [String]) -> Never {
    do {
        guard !warm else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_identity") }
        let options = try dialogOptions(args)
        func object(_ key: String) throws -> [String: Any]? {
            guard let s = options[key] else { return nil }
            guard let data = s.data(using: .utf8), let v = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw DialogFailure(code: "dialog_identity_required", stage: "dialog_identity") }
            return v
        }
        let button = options["--press"], text = options["--text"]
        let expected = try object("--identity").map { try dialogIdentity($0) }
        let target = try object("--target") ?? expected?.json
        let pidString = options["--pid"]
        let explicitPID = pidString.flatMap { pid_t($0) }
        if pidString != nil && (explicitPID == nil || explicitPID! <= 0) { throw DialogFailure(code: "dialog_identity_required", stage: "dialog_identity") }
        if button != nil && (expected == nil || explicitPID == nil) { throw DialogFailure(code: "dialog_identity_required", stage: "dialog_identity") }
        let pid: pid_t
        if let p = explicitPID, p > 0 { pid = p }
        else {
            // Conservative unbound probing must not select the first of several instances.
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").filter { !$0.isTerminated && !processArgs($0.processIdentifier).contains("--headless") }
            guard apps.count == 1 else { throw DialogFailure(code: apps.count > 1 ? "dialog_ambiguous" : "dialog_probe_unknown", stage: "dialog_identity") }
            pid = apps[0].processIdentifier
        }
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.bundleIdentifier == "com.google.Chrome", expected == nil || expected?.chromePid == Int(pid) else {
            throw DialogFailure(code: "dialog_identity_mismatch", stage: "dialog_identity")
        }
        if let t = target {
            guard ["chromePid", "tabId", "windowId", "cgWindow"].allSatisfy({ dialogInt(t[$0]) != nil }), dialogInt(t["chromePid"]) == Int(pid) else { throw DialogFailure(code: "dialog_identity_required", stage: "dialog_identity") }
        }
        let inspect = { try inspectBoundDialog(pid: pid, target: target) }
        guard button == nil else { throw DialogFailure(code: "native_session_required", stage: "dialog_identity") }
        guard text == nil else { throw DialogFailure(code: "dialog_identity_required", stage: "dialog_identity") }
        guard let d = try inspect() else { emit(["ok": true, "known": true, "open": false, "inputDelivery": "not_sent", "stage": "dialog_inspect"]) }
        guard let identity = d.identity else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding") }
        // PERM1 r1 A4: a positively identified page dialog (D's domain) vs an unclassified browser surface; r1 A1: attached.
        let surface = ChromeNative.Probe().pageDialogSurface(d, pid: pid)
        emit(["ok": true, "known": true, "open": true, "surface": surface.surface, "attached": surface.attached,
              "title": d.title, "texts": d.texts, "buttons": d.buttons.map { $0.0 },
              "hasField": d.hasField, "identity": identity.json, "complete": d.templateComplete, "origin": d.origin as Any? ?? NSNull(),
              "originEvidence": d.origin == nil ? "unverified" : "native_current_snapshot", "inputDelivery": "not_sent", "stage": "dialog_inspect"])
    } catch let e as DialogFailure { emit(e.json) }
    catch { emit(DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .cli_inspect_catch).json.merging((error as NSError).domain == "MyChromeNativeReadFailure" ? (error as NSError).userInfo : [:]) { first, _ in first }) }
}

/// With `cg`, by window number (a twin with the same bounds does not count).
func axFocusedIs(pid: pid_t, bounds r: NSRect, cg: Int? = nil) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
          let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() else { return false }
    let fw = v as! AXUIElement
    AXUIElementSetMessagingTimeout(fw, axMessagingTimeout)
    if let n = cg, let fn = axWindowNumber(fw) { return fn == n }
    guard let fr = axRect(fw) else { return false }
    return sameRect(fr, r)
}

/// Activation must prove the exact CG window; equal geometry is not identity.
/// Split the remaining allowance across both AX requests instead of inheriting the 1 s default.
func axFocusedExactly(pid: pid_t, cg: Int, remaining: Double) -> Bool {
    guard cg > 0, remaining > 0 else { return false }
    let app = AXUIElementCreateApplication(pid)
    let timeout = Float(min(0.06, remaining / 3))
    AXUIElementSetMessagingTimeout(app, timeout)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
          let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() else { return false }
    let focused = v as! AXUIElement
    AXUIElementSetMessagingTimeout(focused, timeout)
    return axWindowNumber(focused) == cg
}

/// Read-only bounded settling after the one activation request. Never raises or selects again.
func settleExactFocus(pid: Int, cg: Int?, now: () -> Double, pause: (Double) -> Void,
                      sample: (Double) -> (frontmostPid: Int, onTop: Bool, key: Bool))
    -> (ready: Bool, frontmostPid: Int, onTop: Bool, key: Bool, waitedMs: Int) {
    let start = now(), deadline = start + 1.0
    var state = (frontmostPid: 0, onTop: false, key: false)
    guard let cg = cg, cg > 0 else { return (false, state.frontmostPid, false, false, 0) }
    while now() < deadline {
        state = sample(max(0, deadline - now()))
        let elapsed = now() - start
        if elapsed <= 1.0 && state.frontmostPid == pid && state.onTop && state.key {
            return (true, state.frontmostPid, true, true, Int(elapsed * 1000))
        }
        let remaining = deadline - now()
        if remaining > 0 { pause(min(0.005, remaining)) }
    }
    return (false, state.frontmostPid, state.onTop, state.key, Int((now() - start) * 1000))
}

/// Usually CG alone answers. Only a small set of proven recording indicators may be skipped.
/// No page title, field value or broad AX traversal is needed in this final focus check.
func focusTopWindowMatches(pid: pid_t, cg: Int, remaining: Double) -> Bool {
    guard cg > 0, remaining > 0 else { return false }
    let deadline = ProcessInfo.processInfo.systemUptime + remaining
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let ordered = rows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 }
        .compactMap { $0[kCGWindowNumber as String] as? Int }
    guard let at = ordered.firstIndex(of: cg), at <= 3 else { return false }
    if at == 0 { return true }
    var above = Set(ordered.prefix(at))
    let app = AXUIElementCreateApplication(pid)
    let timeout = Float(min(0.01, remaining / 100))
    AXUIElementSetMessagingTimeout(app, timeout)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement], windows.count <= 64 else { return false }
    for window in windows {
        // Keep room for the predicate's six bounded AX reads.
        guard ProcessInfo.processInfo.systemUptime + Double(timeout) * 7 < deadline else { return false }
        AXUIElementSetMessagingTimeout(window, timeout)
        guard let id = axWindowNumber(window), above.contains(id) else { continue }
        guard axIsWindowSharingIndicator(window, timeout: timeout) else { return false }
        above.remove(id)
        if above.isEmpty { return true }
    }
    return false
}

func waitForExactChromeFocus(pid: pid_t, cg: Int?)
    -> (ready: Bool, frontmostPid: Int, onTop: Bool, key: Bool, waitedMs: Int) {
    settleExactFocus(pid: Int(pid), cg: cg, now: { ProcessInfo.processInfo.systemUptime }, pause: spin) { remaining in
        let started = ProcessInfo.processInfo.systemUptime
        // General cgOnScreenOrder has 1 s per-AX-message timeouts, unsuitable for this loop.
        let onTop = cg.map { focusTopWindowMatches(pid: pid, cg: $0, remaining: remaining * 0.6) } == true
        let allowance = max(0, remaining - (ProcessInfo.processInfo.systemUptime - started))
        let key = onTop && cg.map { axFocusedExactly(pid: pid, cg: $0, remaining: allowance) } == true
        // Check after AX too: another app may have taken focus during a slow reply.
        return (Int(frontApp()?.processIdentifier ?? 0), onTop, key)
    }
}

// MARK: - Read-only native input probe

struct NativeInputProbeError: Error {
    let code: String
    let message: String
    var details: [String: Any] = [:]
}

/// A read-only AX probe's caps; every probe also has the fixed 1.8 s deadline, the only `ax_probe_timeout`.
/// Every probe except page-content bounds keeps 220 reads, and the old code and text when that cap trips.
struct AXProbeBudget {
    let maxReads: Int, maxVisited: Int
    /// Name the limit and its counts in the message; a tripped cap is `page_content_unavailable`.
    let namesLimits: Bool
    static let standard = AXProbeBudget(maxReads: 220, maxVisited: 120, namesLimits: false)
    /// 3 reads (window list, window position and size), then at most 3 per visited node: its role, then
    /// visibleChildren and the children fallback, or for the WebArea its position and size. So the read cap
    /// never stops a walk that the node cap allows; the deadline still bounds the time.
    static let pageContent = AXProbeBudget(maxReads: 3 + 3 * 300, maxVisited: 300, namesLimits: true)
}

/// Find one outer WebArea; nested frame WebAreas belong to that page and are not separate crops.
/// Unknown/oversized/ambiguous geometry is not permission to capture browser chrome.
func pageContentBounds(root: AXUIElement, window: CGRect, probe: NativeInputProbe) throws -> CGRect {
    var candidates: [CGRect] = []
    func walk(_ node: AXUIElement, _ depth: Int) throws {
        probe.visited += 1
        guard probe.visited <= probe.budget.maxVisited else { throw probe.stopped("visited") }
        guard depth <= 12 else { throw probe.stopped("depth") }
        if try probe.role(node) == "AXWebArea" {
            guard let r = try probe.rect(node), r.minX.isFinite, r.minY.isFinite,
                  r.width.isFinite, r.height.isFinite, r.width > 0, r.height > 0,
                  r.minX >= window.minX, r.minY > window.minY,
                  r.maxX <= window.maxX, r.maxY <= window.maxY else {
                throw NativeInputProbeError(code: "page_content_unavailable", message: "网页内容边界不可靠，这次没有截图。")
            }
            candidates.append(r)
            return
        }
        let visible = try probe.value(node, kAXVisibleChildrenAttribute) as? [AXUIElement]
        let children = try visible ?? (probe.value(node, kAXChildrenAttribute) as? [AXUIElement] ?? [])
        for child in children { try walk(child, depth + 1) }
    }
    try walk(root, 0)
    guard candidates.count == 1 else {
        throw NativeInputProbeError(code: "page_content_unavailable", message: "找不到唯一的网页内容区域，这次没有截图。")
    }
    return candidates[0]
}

func nativePageContent(pid: pid_t, expectedWindow: Int) throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
        throw NativeInputProbeError(code: "no_accessibility", message: "Accessibility permission is required to identify the page content area; no screenshot was taken.")
    }
    _ = try nativeChromeIdentity(pid: pid)
    guard let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(expectedWindow)) as? [[String: Any]],
          let row = rows.first, row[kCGWindowOwnerPID as String] as? Int == Int(pid),
          row[kCGWindowLayer as String] as? Int == 0, row[kCGWindowIsOnscreen as String] as? Bool == true,
          let bounds = row[kCGWindowBounds as String] as? NSDictionary,
          let window = CGRect(dictionaryRepresentation: bounds) else {
        throw NativeInputProbeError(code: "page_content_unavailable", message: "目标网页窗口不可见或已变化，这次没有截图。")
    }
    let probe = NativeInputProbe(.pageContent), app = AXUIElementCreateApplication(pid)
    let windows = try probe.value(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    guard windows.count <= 64 else {
        throw NativeInputProbeError(code: "page_content_unavailable", message: "无法及时确认目标网页窗口，这次没有截图。")
    }
    var matches: [AXUIElement] = []
    for candidate in windows {
        guard ProcessInfo.processInfo.systemUptime < probe.deadline else {
            throw NativeInputProbeError(code: "page_content_unavailable", message: "无法及时确认目标网页窗口，这次没有截图。")
        }
        AXUIElementSetMessagingTimeout(candidate, 0.06)
        if axWindowNumber(candidate) == expectedWindow { matches.append(candidate) }
    }
    guard matches.count == 1, let frame = try probe.rect(matches[0]), sameRect(frame, window) else {
        throw NativeInputProbeError(code: "page_content_unavailable", message: "无法确认目标网页窗口，这次没有截图。")
    }
    let rect = try pageContentBounds(root: matches[0], window: window, probe: probe)
    let json: (CGRect) -> [String: Double] = { ["x": $0.minX, "y": $0.minY, "w": $0.width, "h": $0.height] }
    return ["ok": true, "pid": Int(pid), "cgWindow": expectedWindow, "rect": json(rect),
            "windowBounds": json(window), "source": "ax-web-area"]
}

/// Missing direct metadata can be corroborated by one same-PID workspace record.
/// Known wrong/terminated identities fail immediately. Window ownership and all
/// AX/focus checks remain mandatory after this read-only identity decision.
func nativeChromeIdentity(pid: pid_t) throws -> String {
    func reject(_ reason: String, _ app: NSRunningApplication?, _ source: String) -> NativeInputProbeError {
        NativeInputProbeError(code: "wrong_app",
            message: "The native target is not a verified running Google Chrome process.",
            details: ["requestedPid": Int(pid), "identitySource": source, "identityReason": reason,
                      "appFound": app != nil, "bundleMissing": app?.bundleIdentifier?.isEmpty ?? true,
                      "bundleMatches": app?.bundleIdentifier == "com.google.Chrome",
                      "terminated": app.map { $0.isTerminated as Any } ?? NSNull()])
    }
    let direct = NSRunningApplication(processIdentifier: pid)
    if let app = direct {
        guard app.processIdentifier == pid else { throw reject("pid_mismatch", app, "direct") }
        guard !app.isTerminated else { throw reject("terminated", app, "direct") }
        if let bundle = app.bundleIdentifier, !bundle.isEmpty {
            guard bundle == "com.google.Chrome" else { throw reject("wrong_bundle", app, "direct") }
            return "direct"
        }
    }
    let matches = NSWorkspace.shared.runningApplications.filter { $0.processIdentifier == pid }
    guard matches.count == 1 else {
        throw reject(matches.isEmpty ? "identity_unavailable" : "ambiguous_identity", direct, "workspace")
    }
    let app = matches[0]
    guard !app.isTerminated else { throw reject("terminated", app, "workspace") }
    guard let bundle = app.bundleIdentifier, !bundle.isEmpty else { throw reject("bundle_missing", app, "workspace") }
    guard bundle == "com.google.Chrome" else { throw reject("wrong_bundle", app, "workspace") }
    return "workspace"
}

/// All AX traversal is bounded and omits field values, selected text, window titles and URLs.
/// The app-specific hit test reaches renderer accessibility nodes across iframe/shadow boundaries.
final class NativeInputProbe {
    let budget: AXProbeBudget, started: TimeInterval, deadline: TimeInterval
    var reads = 0, visited = 0
    init(_ budget: AXProbeBudget = .standard) {
        self.budget = budget
        started = ProcessInfo.processInfo.systemUptime
        deadline = started + 1.8
    }
    /// The limit that stopped the probe ("reads", "visited", "depth" or "deadline") with its counts.
    func stopped(_ limit: String) -> NativeInputProbeError {
        let ms = Int(((ProcessInfo.processInfo.systemUptime - started) * 1000).rounded())
        let details: [String: Any] = ["limit": limit, "reads": reads, "maxReads": budget.maxReads,
                                      "visited": visited, "maxVisited": budget.maxVisited, "elapsedMs": ms]
        guard budget.namesLimits || limit == "visited" || limit == "depth" else {
            return NativeInputProbeError(code: "ax_probe_timeout", message: "Native target inspection timed out; no input was sent.", details: details)
        }
        let counts = "limit=\(limit) reads=\(reads)/\(budget.maxReads) visited=\(visited)/\(budget.maxVisited) elapsedMs=\(ms)"
        return NativeInputProbeError(code: limit == "deadline" ? "ax_probe_timeout" : "page_content_unavailable",
                                     message: "网页内容区域没能在检查上限内确认，这次没有截图（\(counts)）。", details: details)
    }
    func value(_ e: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
        reads += 1
        guard reads <= budget.maxReads else { throw stopped("reads") }
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw stopped("deadline") }
        AXUIElementSetMessagingTimeout(e, 0.12)
        var result: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(e, attribute as CFString, &result)
        if status == .attributeUnsupported || status == .noValue { return nil }
        guard status == .success else {
            throw NativeInputProbeError(code: "ax_probe_failed", message: "Native target inspection failed (AX \(status.rawValue)); no input was sent.")
        }
        return result
    }
    func element(_ e: AXUIElement, _ name: String) throws -> AXUIElement? {
        guard let v = try value(e, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }
    func role(_ e: AXUIElement) throws -> String { try value(e, kAXRoleAttribute) as? String ?? "" }
    func rect(_ e: AXUIElement) throws -> CGRect? {
        guard let pv = try value(e, kAXPositionAttribute), CFGetTypeID(pv) == AXValueGetTypeID(),
              let sv = try value(e, kAXSizeAttribute), CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s),
              p.x.isFinite, p.y.isFinite, s.width > 0, s.height > 0 else { return nil }
        return CGRect(origin: p, size: s)
    }
    func chain(_ e: AXUIElement?) throws -> [(AXUIElement, String)] {
        var result: [(AXUIElement, String)] = [], current = e
        while let node = current, result.count < 16 {
            if result.contains(where: { CFEqual($0.0, node) }) { break }
            let r = try role(node)
            result.append((node, r))
            if r == kAXApplicationRole || r == kAXWindowRole { break }
            current = try element(node, kAXParentAttribute)
        }
        return result
    }
    func windowNumber(_ chain: [(AXUIElement, String)]) throws -> Int? {
        for (e, r) in chain {
            if r == kAXWindowRole, let n = axWindowNumber(e) { return n }
            if let w = try element(e, kAXWindowAttribute), let n = axWindowNumber(w) { return n }
        }
        return nil
    }
    func menuOpen(_ chain: [(AXUIElement, String)]) throws -> Bool {
        if chain.contains(where: { $0.1 == kAXMenuRole || $0.1 == kAXMenuItemRole }) { return true }
        for (e, r) in chain where r == kAXPopUpButtonRole {
            if (try value(e, kAXExpandedAttribute) as? Bool) == true { return true }
            let children = try value(e, kAXChildrenAttribute) as? [AXUIElement] ?? []
            for child in children.prefix(12) where try role(child) == kAXMenuRole { return true }
        }
        return false
    }
    func documentToken(_ chain: [(AXUIElement, String)]) throws -> String? {
        guard let (web, _) = chain.first(where: { $0.1 == "AXWebArea" }) else { return nil }
        // An opaque, process-bound identity. Never return the URL or the page title.
        let url = try value(web, kAXURLAttribute).map { String(describing: $0) } ?? ""
        let material = "\(CFHash(web)):\(url)"
        return SHA256.hash(data: Data(material.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    func dateSegments(_ chain: [(AXUIElement, String)]) throws -> [[String: Any]] {
        guard let (root, _) = chain.first(where: { ["AXDateField", "AXTimeField"].contains($0.1) }) else { return [] }
        var queue: [(AXUIElement, Int)] = [(root, 0)], seen = 0, rows: [[String: Any]] = []
        while !queue.isEmpty, seen < 32 {
            let (node, depth) = queue.removeFirst()
            seen += 1
            let r = try role(node)
            if r == kAXIncrementorRole || r == kAXTextFieldRole {
                if let frame = try rect(node) {
                    // These labels identify year/month/day/hour/minute sections, not their entered values.
                    let label = try value(node, kAXDescriptionAttribute) as? String ?? ""
                    let lo = try value(node, kAXMinValueAttribute) as? NSNumber
                    let hi = try value(node, kAXMaxValueAttribute) as? NSNumber
                    rows.append(["role": r, "description": String(label.prefix(80)),
                                 "min": lo ?? NSNull(), "max": hi ?? NSNull(),
                                 "rect": ["x": frame.minX, "y": frame.minY, "w": frame.width, "h": frame.height]])
                }
            }
            if depth < 6 {
                let children = try value(node, kAXChildrenAttribute) as? [AXUIElement] ?? []
                queue.append(contentsOf: children.prefix(32 - seen).map { ($0, depth + 1) })
            }
        }
        return rows
    }
}

/// A no-cache Escape may use the normal guarded input path only after a cold AX read proves
/// the frontmost Chrome has no menu. No tab identity is invented and this command posts nothing.
func nativeFrontMenuState() throws -> [String: Any] {
    let unknown: [String: Any] = ["ok": true, "known": false]
    guard AXIsProcessTrusted(),
          let front = NSWorkspace.shared.frontmostApplication,
          front.bundleIdentifier == "com.google.Chrome", !front.isTerminated else { return unknown }
    let pid = front.processIdentifier, app = AXUIElementCreateApplication(front.processIdentifier)
    let probe = NativeInputProbe()
    guard let window = try probe.element(app, kAXFocusedWindowAttribute),
          let windowID = axWindowNumber(window),
          let focused = try probe.element(app, kAXFocusedUIElementAttribute) else { return unknown }
    let chain = try probe.chain(focused)
    guard !chain.isEmpty, chain.allSatisfy({ !$0.1.isEmpty }),
          let terminal = chain.last?.1, terminal == kAXWindowRole || terminal == kAXApplicationRole else { return unknown }
    let menu = try probe.menuOpen(chain)
    // A popup provider with neither expansion state nor menu children cannot prove absence.
    if !menu {
        for (node, role) in chain where role == kAXPopUpButtonRole {
            guard (try probe.value(node, kAXExpandedAttribute) as? Bool) == false else { return unknown }
        }
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let still = try probe.element(app, kAXFocusedWindowAttribute),
          axWindowNumber(still) == windowID else { return unknown }
    return ["ok": true, "known": true, "menuOpen": menu, "pid": Int(pid), "window": windowID]
}

/// FOCUS4 (G-h): the AX element at the landing point (or, with no point, the focused element) belongs to the bound
/// window. AXFocusedWindow is not a prerequisite (it can be unavailable while the window is visibly in front); it still
/// binds the one exemption, an open menu (its items sit in their own window), to the target. Missing control evidence
/// (no element, no window number) never matches.
func nativeWindowMatches(expected: Int, hit: Int?, focused: Int?, menu: Bool) -> Bool {
    hit == expected || (menu && focused == expected)
}

/// FOCUS4 r2 A2: whether a native menu is open, from complete AX focus evidence only (as nativeFrontMenuState):
/// "open" on positive evidence; "closed" only with a focused element, every role on its parent chain read, the chain
/// ending at its window or application, and an explicit expansion value `false` for each popup button on it; else
/// "unknown" (no focused element, an incomplete chain, a popup without an expansion value).
func nativeMenuState(focused: Bool, roles: [String], menu: Bool, popupExpanded: [Bool?]) -> String {
    if menu { return "open" }
    guard focused, let last = roles.last, last == kAXWindowRole || last == kAXApplicationRole,
          roles.allSatisfy({ !$0.isEmpty }) else { return "unknown" }
    guard popupExpanded.allSatisfy({ $0 == false }) else { return "unknown" }
    return "closed"
}

func nativeInputProbe(pid: pid_t, expectedWindow: Int, point: CGPoint?) throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
        throw NativeInputProbeError(code: "no_accessibility", message: "Accessibility permission is required for native target inspection.")
    }
    let identitySource = try nativeChromeIdentity(pid: pid)
    let cg = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
    guard let window = cg.first(where: { ($0[kCGWindowNumber as String] as? Int) == expectedWindow }),
          (window[kCGWindowOwnerPID as String] as? Int) == Int(pid),
          (window[kCGWindowLayer as String] as? Int) == 0 else {
        throw NativeInputProbeError(code: "window_changed", message: "The expected Chrome window no longer matches; no input was sent.")
    }
    let probe = NativeInputProbe(), axApp = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(axApp, 0.12)
    let focusedWindow = try probe.element(axApp, kAXFocusedWindowAttribute)
    let focusedWindowID = focusedWindow.flatMap { axWindowNumber($0) }
    let focused = try probe.element(axApp, kAXFocusedUIElementAttribute)
    let focusedChain = try probe.chain(focused)
    var hit = focused
    if let p = point {
        let status = AXUIElementCopyElementAtPosition(axApp, Float(p.x), Float(p.y), &hit)
        guard status == .success else {
            throw NativeInputProbeError(code: "ax_probe_failed", message: "The native target at that point could not be inspected; no input was sent.")
        }
    }
    let hitChain = point == nil ? focusedChain : try probe.chain(hit)
    let hitWindowID = try probe.windowNumber(hitChain)
    let roleNames = hitChain.map { $0.1 }
    let menu = try probe.menuOpen(focusedChain)
    let popupExpanded: [Bool?] = try focusedChain.filter { $0.1 == kAXPopUpButtonRole }.map { try probe.value($0.0, kAXExpandedAttribute) as? Bool }
    let menuState = nativeMenuState(focused: focused != nil, roles: focusedChain.map { $0.1 }, menu: menu, popupExpanded: popupExpanded)
    var blocker: Any = NSNull()
    if let p = point,
       let stack = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
        for row in stack {
            if (row[kCGWindowNumber as String] as? Int) == expectedWindow { break }
            guard let owner = row[kCGWindowOwnerPID as String] as? Int, owner != Int(pid), owner != Int(getpid()),
                  let layer = row[kCGWindowLayer as String] as? Int, layer >= 0, layer <= 19,
                  let b = row[kCGWindowBounds as String] as? NSDictionary,
                  let r = CGRect(dictionaryRepresentation: b), r.contains(p),
                  r.width >= 2, r.height >= 2,
                  (row[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
                  (row[kCGWindowOwnerName as String] as? String) != "Window Server" else { continue }
            blocker = ["pid": owner, "appName": row[kCGWindowOwnerName as String] as? String ?? "another application"]
            break
        }
    }
    return ["ok": true, "pid": Int(pid), "expectedWindow": expectedWindow, "identitySource": identitySource,
            "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
            "focusedWindow": focusedWindowID ?? NSNull(), "hitWindow": hitWindowID ?? NSNull(),
            "windowMatches": nativeWindowMatches(expected: expectedWindow, hit: hitWindowID, focused: focusedWindowID, menu: menu),
            "nodeFound": hit != nil, "roles": roleNames,
            "nativePopup": roleNames.contains(kAXPopUpButtonRole), "menuOpen": menu, "menuState": menuState,
            "nativeMenuOpen": menu && focusedChain.contains(where: { $0.1 == kAXPopUpButtonRole }),
            "documentToken": try probe.documentToken(hitChain) ?? NSNull(),
            "focusedDocumentToken": try probe.documentToken(focusedChain) ?? NSNull(),
            "segments": try probe.dateSegments(hitChain), "blocker": blocker]
}

func rectOf(_ w: SBObject) -> NSRect { (w.value(forKey: "bounds") as? NSValue)?.rectValue ?? .zero }

/// Profile directory for agent windows: CHROME_BRIDGE_PROFILE (directory or
/// display name), else Chrome's last-used profile from Local State.
func targetProfile(_ explicit: String? = nil) -> String? {
    let dir = chromeDataDir()
    guard let data = FileManager.default.contents(atPath: dir + "/Local State"),
          let ls = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let prof = ls["profile"] as? [String: Any] else { return nil }
    let cache = prof["info_cache"] as? [String: Any] ?? [:]
    if let want = explicit ?? ProcessInfo.processInfo.environment["CHROME_BRIDGE_PROFILE"], !want.isEmpty {
        if cache[want] != nil { return want }
        for (k, v) in cache { if ((v as? [String: Any])?["name"] as? String) == want { return k } }
        return nil
    }
    return prof["last_used"] as? String
}

func fourCC(_ s: String) -> FourCharCode { s.utf8.reduce(0) { ($0 << 8) | FourCharCode($1) } }

/// `make new tab at end of tabs of window id <wid> with properties {URL:url}`,
/// as a raw Apple Event sent to one pid. Returns an error message or nil.


func frontApp() -> NSRunningApplication? { NSWorkspace.shared.frontmostApplication }

/// NSWorkspace's frontmost app is updated by notifications; let them arrive.
func spin(_ seconds: Double) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }

/// Seconds since the last HID input a human produces; the same event types as
/// `cgevent idle`.
func idleSeconds() -> Double {
    let kinds: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown,
                                .leftMouseDragged, .otherMouseDown, .scrollWheel, .keyDown, .flagsChanged]
    return kinds.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
}

// MARK: - commands

var argv = Array(cmdArgs.dropFirst())
var tabArg: Int? = nil
if let i = argv.firstIndex(of: "--tab"), i + 1 < argv.count {
    tabArg = Int(argv[i + 1]); argv.removeSubrange(i...(i + 1))
}
var selectFlag = false
if let i = argv.firstIndex(of: "--select") { selectFlag = true; argv.remove(at: i) }

switch cmd {
case "list":
    var out: [[String: Any]] = []
    let cgIds = cgWindowIds()
    for wid in ids(windows()) {
        let w = windows().object(withID: String(wid)) as! SBObject
        let ts = tabs(w)
        let tids = ids(ts)
        let titles = ts.value(forKey: "title") as? [String] ?? []
        let urls = ts.value(forKey: "URL") as? [String] ?? []
        let active = num((w.value(forKey: "activeTab") as? SBObject)?.value(forKey: "id"))
        var tabsOut: [[String: Any]] = []
        for (k, t) in tids.enumerated() {
            tabsOut.append(["id": t, "title": k < titles.count ? titles[k] : "", "url": k < urls.count ? urls[k] : "", "active": t == active])
        }
        out.append(["id": wid, "index": num(w.value(forKey: "index")), "mode": str(w.value(forKey: "mode")),
                    "minimized": (w.value(forKey: "minimized") as? Bool) ?? false, "tabs": tabsOut,
                    "bounds": boundsJSON(w), "cgWindow": cgIds[wid] ?? NSNull()])
    }
    check()
    emit(["ok": true, "driver": "chromectl", "chromePid": Int(chromeProc.processIdentifier),
          "frontmost": frontApp()?.localizedName ?? "", "windows": out])

case "scene":
    var wid: Any = NSNull(), tid: Any = NSNull()
    // Element order is not z-order under ScriptingBridge; ask for index 1.
    if let first = frontWindowId() {
        let w = windows().object(withID: String(first)) as! SBObject
        wid = first
        tid = num((w.value(forKey: "activeTab") as? SBObject)?.value(forKey: "id"))
    }
    let f = frontApp()
    trace("scene")
    emit(["ok": true, "app": f?.localizedName ?? "", "appPid": f.map { Int($0.processIdentifier) } ?? NSNull(),
          "chromeWindow": wid, "chromeTab": tid, "chromePid": Int(chromeProc.processIdentifier)])

case "eval" where argv.contains("--lean"):
    // Lean eval: only the script result and the tab URL — no window/tab
    // metadata round-trips (the full target costs ~0.3 s; used on the
    // foreground path, e.g. delivery acknowledgment).
    guard let tid = tabArg, let (_, t, _) = findTab(tid) else { fail("no_such_tab", "找不到标签（lean eval 需要 --tab）") }
    guard let path = argv.first(where: { $0 != "--lean" }), let js = try? String(contentsOfFile: path, encoding: .utf8) else {
        fail("read_failed", "cannot read script file")
    }
    let r = t.perform(NSSelectorFromString("executeJavascript:"), with: js)?.takeUnretainedValue()
    check("eval_result")
    guard let res = r as? String else {
        fail("js_from_apple_events_disabled", "Chrome 返回空结果，通常表示「允许来自 Apple 事件的 JavaScript」未开启")
    }
    let url = str(t.value(forKey: "URL"))
    check("eval_url")
    emit(["ok": true, "result": res, "tabId": tid, "url": url, "driver": "chromectl", "lean": true])

default:
    // Commands on one resolved target tab.
    let w: SBObject, t: SBObject, wid: Int
    if let tid = tabArg {
        guard let hit = findTab(tid) else { fail("no_such_tab", "找不到标签 \(tid)（可能已关闭）。请重新调用 list_tabs。") }
        (w, t, wid) = hit
    } else {
        check()
        guard let first = frontWindowId() else { fail("no_window", "Chrome 正在运行，但没有可用的窗口。") }
        wid = first
        w = windows().object(withID: String(first)) as! SBObject
        t = w.value(forKey: "activeTab") as! SBObject
    }
    trace("findTab")
    let tid = num(t.value(forKey: "id"))
    let activeObject = w.value(forKey: "activeTab") as? SBObject
    let activeTab = num(activeObject?.value(forKey: "id"))
    var targetBounds = CGRect.zero
    var target: [String: Any] = [
        "tabId": tid, "windowId": wid,
        "tabActive": activeTab == tid,
        "windowIndex": num(w.value(forKey: "index")),
        "minimized": (w.value(forKey: "minimized") as? Bool) ?? false,
        "url": str(t.value(forKey: "URL")), "title": str(t.value(forKey: "title")),
        "tabCount": ids(tabs(w)).count, "bounds": boundsJSON(w, capture: { targetBounds = $0 }),
        "driver": "chromectl", "chromePid": Int(chromeProc.processIdentifier)
    ]
    check("target_metadata")
    trace("target metadata")

    switch cmd {
    case "info":
        // Browser-side metadata remains readable while a new document is loading.
        // URL stability alone does not mean an OAuth/HTTP redirect chain has finished.
        target["loading"] = (t.value(forKey: "loading") as? Bool) ?? true
        check("info_loading")
        target["frontmost"] = frontApp()?.localizedName ?? ""
        let activeURL = activeTab == tid ? str(target["url"]) : str(activeObject?.value(forKey: "URL"))
        check("target_metadata")
        do {
            emit(try nativeInfoTarget(target, pid: chromeProc.processIdentifier, activeTab: activeTab,
                                      activeURL: activeURL, bounds: targetBounds))
        } catch { emit(nativeInfoFailure(error)) }

    case "eval":
        guard let path = argv.first, let js = try? String(contentsOfFile: path, encoding: .utf8) else {
            fail("read_failed", "cannot read script file")
        }
        let r = t.perform(NSSelectorFromString("executeJavascript:"), with: js)?.takeUnretainedValue()
        check("eval_result")
        guard let s = r as? String else {
            fail("js_from_apple_events_disabled", "Chrome 返回空结果，通常表示「允许来自 Apple 事件的 JavaScript」未开启")
        }
        target["ok"] = true
        target["result"] = s
        target["bounds"] = boundsJSON(w)
        check("eval_bounds")
        emit(target)

    default:
        fail("usage", "unknown command \(cmd)")
    }
}
