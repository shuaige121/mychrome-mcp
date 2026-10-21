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
let (chromeProc, pickReport) = pickChrome()
trace("pickChrome")
// `chromectl --warm`: do the slow part (process start, choosing Chrome, the
// ScriptingBridge connection) ahead of time, then wait for ONE command on stdin
// as a JSON array of arguments, run it and exit like a normal invocation. The
// caller keeps a few warm processes ready, so a command costs only its own work.
let warm = CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "--warm"
let warmChrome: SBApplication? = warm ? chromeProc.flatMap { SBApplication(processIdentifier: $0.processIdentifier) } : nil
// The first Apple Event to Chrome also sets up the connection: pay that while waiting too.
if let c = warmChrome { _ = (c.value(forKey: "windows") as? SBElementArray)?.count; trace("warm: first Apple Event") }
func readWarmCommand() -> [String] {
    guard let line = readLine(strippingNewline: true), let data = line.data(using: .utf8),
          let a = try? JSONSerialization.jsonObject(with: data) as? [String], !a.isEmpty else { exit(0) }
    return a
}
let cmdArgs: [String] = warm ? readWarmCommand() : Array(CommandLine.arguments.dropFirst())
trace("command")
let cmd = cmdArgs.first ?? ""

if cmd == "pick" {
    emit(["ok": chromeProc != nil, "pid": chromeProc.map { Int($0.processIdentifier) } ?? NSNull(), "candidates": pickReport])
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
// Must stay before SBApplication initialization. A native menu can block all Apple Events.
// Call this command cold: --warm has already sent an Apple Event before reading its command.
if cmd == "axmenustate" {
    guard !warm, cmdArgs.count == 1 else { fail("usage", "axmenustate (cold only)") }
    do { emit(try nativeFrontMenuState()) }
    catch let e as NativeInputProbeError { fail(e.code, e.message) }
    catch { fail("ax_probe_failed", "The frontmost Chrome menu state could not be inspected.") }
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
guard let chromeProc = chromeProc, !chromeProc.isTerminated,
      let chrome = warmChrome ?? SBApplication(processIdentifier: chromeProc.processIdentifier) else {
    fail("chrome_not_running", "Google Chrome 没有在运行（或只有 headless 实例）")
}
chrome.delegate = catcher
trace("SBApplication")

func check(_ stage: String = "apple_event") {
    if let m = catcher.last {
        // Stage names contain no script, title, URL, or field contents. Preserve
        // the original failure; never turn an uncertain lookup into "tab gone".
        let code = catcher.lastCode
        emit(["ok": false, "error": classify(m, code), "osStatus": code, "stage": stage,
              "message": "\(m)（Apple Event 阶段：\(stage)，code \(code)）"])
    }
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

func boundsJSON(_ w: SBObject) -> [String: Any] {
    let r = (w.value(forKey: "bounds") as? NSValue)?.rectValue ?? .zero
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
struct ChromeWin { let id: Int; let rect: CGRect; let minimized: Bool; let index: Int? }

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
    var out: [Int: Int] = [:]
    for k in cw.indices {
        let hits = cg.filter { sameRect($0.rect, cw[k].rect) }
        if hits.count == 1 { out[cw[k].id] = hits[0].num; continue }
        let twins = cw.indices.filter { sameRect(cw[$0].rect, cw[k].rect) && cw[$0].minimized == cw[k].minimized }
        guard hits.count > 1, twins.count == 1 else { continue }
        let vis = hits.filter { $0.onScreen != cw[k].minimized }
        if vis.count == 1 { out[cw[k].id] = vis[0].num }
    }
    let left = cw.indices.filter { k in out[cw[k].id] == nil && cg.contains { sameRect($0.rect, cw[k].rect) } }
    if !left.isEmpty {
        // Chrome's titles are read before and after the AX table: when a title changed in between (a page
        // retitling itself, a tab switch), the AX snapshot may belong to other titles, so no window of
        // that bounds group is matched by title (dropping only the changed one would make a rival vanish).
        var titles: [Int: String] = [:]
        for k in left { titles[k] = title(k) }
        let axw = ax()
        let changed = left.filter { title($0) != titles[$0] }
        for k in left {
            guard let t = titles[k], !t.isEmpty,
                  !changed.contains(where: { sameRect(cw[$0].rect, cw[k].rect) && cw[$0].minimized == cw[k].minimized }) else { continue }
            let rivals = left.filter { sameRect(cw[$0].rect, cw[k].rect) && cw[$0].minimized == cw[k].minimized && titles[$0] == t }
            let same = axw.filter { $0.minimized == cw[k].minimized && ($0.rect.map { sameRect($0, cw[k].rect) } ?? false) }
            // "<title> - Google Chrome…" first; Chrome may put a state in between ("- Audio playing").
            let strict = same.filter { $0.title.hasPrefix(t + " - Google Chrome") }
            let hits = strict.count == 1 ? strict : same.filter { $0.title.hasPrefix(t + " - ") }
            if rivals.count == 1 && hits.count == 1 { out[cw[k].id] = hits[0].num }
        }
    }
    if cw.allSatisfy({ $0.index != nil }), cw.contains(where: { w in !w.minimized && out[w.id] == nil }) {
        let order = onOrder()
        var done = Set(out.keys)
        let taken = Set(out.values)
        for k in cw.indices where !done.contains(cw[k].id) && !cw[k].minimized {
            let group = cw.indices.filter { !cw[$0].minimized && sameRect(cw[$0].rect, cw[k].rect) && !done.contains(cw[$0].id) }
            let hits = order.filter { sameRect($0.rect, cw[k].rect) && !taken.contains($0.num) }
            // A single window left is paired too when Accessibility took its twins (the last of the group).
            let axTookTwins = order.contains { sameRect($0.rect, cw[k].rect) && taken.contains($0.num) }
            guard group.count > 1 || (group.count == 1 && axTookTwins), hits.count == group.count else { continue }
            for (g, h) in zip(group.sorted { cw[$0].index! < cw[$1].index! }, hits) { out[cw[g].id] = h.num; done.insert(cw[g].id) }
        }
    }
    let claimed = Dictionary(grouping: out.values, by: { $0 })
    return out.filter { claimed[$0.value]!.count == 1 }
}

// MARK: - Accessibility window numbers (from JustTab)
// The AX window <-> CoreGraphics window bridge and the bounded AX messages follow JustTab
// (~/work/justtab-seed; its seed sergio-farfan/alttab-macos is MIT, (c) 2026 Sergio Farfan).

/// The CG window number of an AX window: a private but long-standing HIServices call, the usual
/// bridge in macOS window managers. nil when it fails.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

func axWindowNumber(_ w: AXUIElement) -> Int? {
    var n: CGWindowID = 0
    return _AXUIElementGetWindow(w, &n) == .success && n != 0 ? Int(n) : nil
}

/// Upper bound on one AX message to Chrome: a busy or hung Chrome then costs at most this per call
/// instead of the system default of 6 s.
var axMessagingTimeout: Float { 1.0 }

/// An app's AX windows, every element with the bounded timeout.
func axWindows(pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
          let wins = value as? [AXUIElement] else { return [] }
    for w in wins { AXUIElementSetMessagingTimeout(w, axMessagingTimeout) }
    return wins
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
func axIsWindowSharingIndicator(_ w: AXUIElement) -> Bool {
    func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(e, axMessagingTimeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success else { return nil }
        return value
    }
    guard attr(w, kAXSubroleAttribute) as? String == (kAXDialogSubrole as String),
          attr(w, kAXRoleAttribute) as? String == (kAXWindowRole as String),
          attr(w, kAXTitleAttribute) as? String == "Window",
          let children = attr(w, kAXChildrenAttribute) as? [AXUIElement], children.count == 1 else { return false }
    let button = children[0]
    return attr(button, kAXRoleAttribute) as? String == (kAXButtonRole as String) &&
           attr(button, kAXTitleAttribute) as? String == "WindowSharingSessionButton"
}

/// Small input-source indicators can be attached to Chrome as an AXDialog.
/// Known labels qualify only within the observed unfocused, nonmodal WeType
/// shape below; a Caps Lock label alone is never enough to dismiss a dialog.
/// Unknown labels, failed attributes, extra content and real dialogs stay protected.
func axIsInputSourceIndicator(_ w: AXUIElement, pid: pid_t) -> Bool {
    func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(e, axMessagingTimeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success else { return nil }
        return value
    }
    guard attr(w, kAXRoleAttribute) as? String == (kAXWindowRole as String),
          attr(w, kAXSubroleAttribute) as? String == (kAXDialogSubrole as String),
          attr(w, kAXTitleAttribute) as? String == "",
          attr(w, kAXModalAttribute) as? Bool == false,
          attr(w, kAXFocusedAttribute) as? Bool == false,
          attr(w, kAXMainAttribute) as? Bool == false,
          let children = attr(w, kAXChildrenAttribute) as? [AXUIElement], children.count == 1 else { return false }
    let button = children[0]
    guard attr(button, kAXRoleAttribute) as? String == (kAXButtonRole as String),
          let title = attr(button, kAXTitleAttribute) as? String,
          let description = attr(button, kAXDescriptionAttribute) as? String,
          attr(button, kAXFocusedAttribute) as? Bool == false else { return false }
    // The incident retained the resolved button label, not which AX attribute
    // supplied it. Accept its exact spelling in either otherwise-empty slot.
    let inputSource = title.isEmpty && description == "com.tencent.inputmethod.wetype.pinyin"
    let capsLock = (title.isEmpty && description == "Capslock Enabled") ||
                   (title == "Capslock Enabled" && description.isEmpty)
    guard inputSource || capsLock else { return false }
    var buttonChildren: CFTypeRef?
    let childrenStatus = AXUIElementCopyAttributeValue(button, kAXChildrenAttribute as CFString, &buttonChildren)
    // AX reports noValue for this leaf button; unsupported/failed reads are not evidence of a leaf.
    guard childrenStatus == .noValue ||
          (childrenStatus == .success && (buttonChildren as? [AXUIElement])?.isEmpty == true) else { return false }
    guard let number = axWindowNumber(w),
          let focused = attr(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute),
          CFGetTypeID(focused) == AXUIElementGetTypeID(),
          let focusedNumber = axWindowNumber(focused as! AXUIElement), focusedNumber != number,
          let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]],
          let row = windows.first(where: { ($0[kCGWindowNumber as String] as? Int) == number }),
          (row[kCGWindowOwnerPID as String] as? Int) == Int(pid),
          (row[kCGWindowLayer as String] as? Int) == 3,
          let bounds = row[kCGWindowBounds as String] as? NSDictionary,
          let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double,
          width > 0, width <= 120, height > 0, height <= 120 else { return false }
    return true
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
func runAppleScript(_ src: String) -> (String?, String?) {
    var err: NSDictionary?
    let out = NSAppleScript(source: src)?.executeAndReturnError(&err)
    if let e = err { return (nil, (e[NSAppleScript.errorMessage] as? String) ?? "\(e)") }
    return (out?.stringValue, nil)
}

func asQuote(_ s: String) -> String {
    "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
}

/// Make the window with these bounds Chrome's MAIN window via Accessibility,
/// so activating Chrome brings that window forward (activation restores the
/// app's main window: raising by `index` alone was undone by activation, and
/// the agent window ended up 2nd/3rd — seen live).
/// With `cg` (the window's CG number) it is that exact window: by bounds alone a twin with the same
/// bounds could be made main instead (JustTab matches by window number first, too).
func axMakeMain(pid: pid_t, bounds r: NSRect, cg: Int? = nil) -> Bool {
    let wins = axWindows(pid: pid)
    let exact = cg.flatMap { n in wins.first { axWindowNumber($0) == n } }
    guard let w = exact ?? wins.first(where: { w in
        guard let wr = axRect(w) else { return false }
        return abs(wr.origin.x - r.origin.x) < 2 && abs(wr.origin.y - r.origin.y) < 2 &&
               abs(wr.size.width - r.size.width) < 2 && abs(wr.size.height - r.size.height) < 2
    }) else { return false }
    AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    return true
}

func axRect(_ w: AXUIElement) -> CGRect? {
    var pv: CFTypeRef?, sv: CFTypeRef?
    var pos = CGPoint.zero, size = CGSize.zero
    guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pv) == .success,
          AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sv) == .success else { return nil }
    AXValueGetValue(pv as! AXValue, .cgPoint, &pos)
    AXValueGetValue(sv as! AXValue, .cgSize, &size)
    return CGRect(origin: pos, size: size)
}

func sameRect(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.origin.x - b.origin.x) <= 2 && abs(a.origin.y - b.origin.y) <= 2 &&
    abs(a.size.width - b.size.width) <= 2 && abs(a.size.height - b.size.height) <= 2
}

/// Is Chrome's AX focused window (the key window) the one with these bounds?
/// The "Leave" button of a page's leave-confirmation dialog (beforeunload) in any Chrome window, by
/// its title in the languages Chrome shows; nil when there is none. Depth- and size-limited walk.
func axLeaveButton(pid: pid_t) -> AXUIElement? {
    let titles: Set<String> = ["leave", "leave site", "离开", "離開", "离开网站", "離開網站"]
    var windowsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &windowsRef) == .success,
          let wins = windowsRef as? [AXUIElement] else { return nil }
    var seen = 0
    func walk(_ e: AXUIElement, _ depth: Int) -> AXUIElement? {
        seen += 1
        if depth > 14 || seen > 4000 { return nil }
        var role: CFTypeRef?, title: CFTypeRef?, desc: CFTypeRef?
        AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &role)
        if (role as? String) == kAXButtonRole as String {
            AXUIElementCopyAttributeValue(e, kAXTitleAttribute as CFString, &title)
            AXUIElementCopyAttributeValue(e, kAXDescriptionAttribute as CFString, &desc)
            for v in [title as? String, desc as? String] {
                if let t = v?.trimmingCharacters(in: .whitespaces).lowercased(), titles.contains(t) { return e }
            }
        }
        var kids: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids) == .success,
              let list = kids as? [AXUIElement] else { return nil }
        for k in list { if let hit = walk(k, depth + 1) { return hit } }
        return nil
    }
    for w in wins { if let b = walk(w, 0) { return b } }
    return nil
}

/// A page's own dialog (alert / confirm / prompt, "<origin> says"): Chrome shows it as a separate,
/// non-standard window holding its text and buttons; while it is up the page runs no script, so a
/// read waits forever (live 2026-10-06). Returns its title, texts and buttons, or nil.
/// The first text field in an AX subtree (a prompt() dialog's input).
func axFirstTextField(in root: AXUIElement) -> AXUIElement? {
    var seen = 0
    func walk(_ e: AXUIElement, _ d: Int) -> AXUIElement? {
        seen += 1
        if d > 12 || seen > 600 { return nil }
        var r: CFTypeRef?
        AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &r)
        if (r as? String) == (kAXTextFieldRole as String) || (r as? String) == (kAXTextAreaRole as String) { return e }
        var k: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &k) == .success, let kids = k as? [AXUIElement] else { return nil }
        for c in kids { if let hit = walk(c, d + 1) { return hit } }
        return nil
    }
    return walk(root, 0)
}

func axPageDialog(pid: pid_t) -> (title: String, texts: [String], buttons: [(String, AXUIElement)], window: AXUIElement, hasField: Bool)? {
    func attr(_ e: AXUIElement, _ a: String) -> String {
        var v: CFTypeRef?
        AXUIElementCopyAttributeValue(e, a as CFString, &v)
        return (v as? String) ?? ""
    }
    var wr: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &wr) == .success,
          let wins = wr as? [AXUIElement] else { return nil }
    for w in wins where attr(w, kAXSubroleAttribute) != (kAXStandardWindowSubrole as String) {
        if axIsWindowSharingIndicator(w) || axIsInputSourceIndicator(w, pid: pid) { continue }
        var texts: [String] = [], buttons: [(String, AXUIElement)] = []
        var seen = 0
        func walk(_ e: AXUIElement, _ d: Int) {
            seen += 1
            if d > 12 || seen > 600 { return }
            let role = attr(e, kAXRoleAttribute)
            if role == (kAXButtonRole as String) {
                let t = attr(e, kAXTitleAttribute).isEmpty ? attr(e, kAXDescriptionAttribute) : attr(e, kAXTitleAttribute)
                if !t.isEmpty { buttons.append((t, e)) }
            } else if role == (kAXStaticTextRole as String) {
                let v = attr(e, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines)
                if !v.isEmpty { texts.append(String(v.prefix(300))) }
            }
            var k: CFTypeRef?
            guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &k) == .success, let kids = k as? [AXUIElement] else { return }
            for c in kids { walk(c, d + 1) }
        }
        walk(w, 0)
        if !buttons.isEmpty { return (attr(w, kAXTitleAttribute), texts, buttons, w, axFirstTextField(in: w) != nil) }
    }
    return nil
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

// MARK: - Read-only native input probe

struct NativeInputProbeError: Error {
    let code: String
    let message: String
    var details: [String: Any] = [:]
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
    let deadline = ProcessInfo.processInfo.systemUptime + 1.8
    var reads = 0
    func value(_ e: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
        reads += 1
        guard reads <= 220, ProcessInfo.processInfo.systemUptime < deadline else {
            throw NativeInputProbeError(code: "ax_probe_timeout", message: "Native target inspection timed out; no input was sent.")
        }
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
            "windowMatches": focusedWindowID == expectedWindow && (hitWindowID == expectedWindow || menu),
            "nodeFound": hit != nil, "roles": roleNames,
            "nativePopup": roleNames.contains(kAXPopUpButtonRole), "menuOpen": menu,
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
func makeTab(pid: pid_t, windowId: Int, url: String) -> String? {
    // Object specifiers must be built with CreateObjSpecifier: a record's
    // flattened data under type 'obj ' is not one (Chrome answered -1700).
    // Shape copied from what AppleScript sends (AEDebugSends=1).
    func dup(_ d: NSAppleEventDescriptor) -> AEDesc { var out = AEDesc(); AEDuplicateDesc(d.aeDesc!, &out); return out }
    var nullDesc = AEDesc(descriptorType: typeNull, dataHandle: nil)
    var winKey = dup(NSAppleEventDescriptor(string: String(windowId)))
    var win = AEDesc()
    guard CreateObjSpecifier(fourCC("cwin"), &nullDesc, fourCC("ID  "), &winKey, false, &win) == noErr else { return "objspec window" }
    var all = fourCC("all "); var allKey = AEDesc()
    AECreateDesc(fourCC("abso"), &all, 4, &allKey)
    var tabs = AEDesc()
    guard CreateObjSpecifier(fourCC("CrTb"), &win, fourCC("indx"), &allKey, false, &tabs) == noErr else { return "objspec tabs" }
    let loc = NSAppleEventDescriptor.record()
    loc.setDescriptor(NSAppleEventDescriptor(aeDescNoCopy: &tabs), forKeyword: fourCC("kobj"))
    loc.setDescriptor(NSAppleEventDescriptor(enumCode: fourCC("end ")), forKeyword: fourCC("kpos"))
    let props = NSAppleEventDescriptor.record()
    props.setDescriptor(NSAppleEventDescriptor(string: url), forKeyword: fourCC("URL "))
    let ev = NSAppleEventDescriptor(eventClass: fourCC("core"), eventID: fourCC("crel"),
                                    targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
                                    returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    ev.setParam(NSAppleEventDescriptor(typeCode: fourCC("CrTb")), forKeyword: fourCC("kocl"))
    ev.setParam(loc, forKeyword: fourCC("insh"))
    ev.setParam(props, forKeyword: fourCC("prdt"))
    do {
        let reply = try ev.sendEvent(options: [.waitForReply], timeout: 10)
        if let e = reply.paramDescriptor(forKeyword: fourCC("errn")), e.int32Value != 0 {
            return "Apple Event error \(e.int32Value) \(reply.paramDescriptor(forKeyword: fourCC("errs"))?.stringValue ?? "")"
        }
        return nil
    } catch { return "\(error)" }
}

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

case "open":
    guard argv.count >= 1 else { fail("usage", "open <url> [windowId] [--select]") }
    let wid: Int
    if argv.count >= 2, let x = Int(argv[1]) { wid = x } else {
        guard let f = frontWindowId() else { fail("no_window", "Chrome 没有窗口") }
        wid = f
    }
    guard let w = window(id: wid) else { fail("no_such_window", "window \(wid) gone") }
    let before = Set(ids(tabs(w)))
    let prevFront = frontWindowId()
    // Make the tab with a raw Apple Event addressed to THIS Chrome's pid.
    // AppleScript's `tell application "Google Chrome"` is routed by name and
    // was seen bound to another (headless) instance with one window, so the
    // agent window was "not found" (2026-09-30).
    let prevIdx = num(w.value(forKey: "activeTabIndex"))
    let err = makeTab(pid: chromeProc.processIdentifier, windowId: wid, url: argv[0])
    if err == nil && !selectFlag && prevIdx > 0 { w.setValue(prevIdx, forKey: "activeTabIndex") }
    if let e = err { fail("open_failed", "新开标签失败：\(e)") }
    // `make new tab` raises its window to the front of Chrome; when Chrome is
    // the user's active app that window also takes the keyboard, and the
    // user's typing went into an agent tab (seen live). Put their window back.
    if let pf = prevFront, pf != wid, frontWindowId() != pf, let fw = window(id: pf) {
        fw.setValue(1, forKey: "index")
    }
    let added = Set(ids(tabs(w))).subtracting(before)
    guard let tid = added.first else { fail("open_failed", "新标签没有出现在目标 Chrome（pid \(chromeProc.processIdentifier)）的窗口 \(wid) 里") }
    check()
    emit(["ok": true, "driver": "chromectl", "tabId": tid, "windowId": wid, "selected": selectFlag])

case "newwindow":
    guard argv.count >= 5, let l = Int(argv[1]), let tp = Int(argv[2]), let r = Int(argv[3]), let b = Int(argv[4]) else {
        fail("usage", "newwindow <url> <left> <top> <right> <bottom>")
    }
    // `make new window` cannot name a window id; verify by pid afterwards
    // that the new window really belongs to the chosen process.
    let before = Set(ids(windows()))
    let wasFront = frontApp()?.processIdentifier == chromeProc.processIdentifier
    var out: String? = nil
    // Open the window in the USER's profile. `make new window` lands in
    // whichever profile Chrome picks — seen live: the agent window opened in
    // another person's profile (other logins, Apple-Events JS setting off).
    // The Chrome binary with --profile-directory forwards to the running
    // instance (process singleton) and exits; no second Chrome starts.
    let wantProfile = argv.count >= 6 ? argv[5] : nil
    if let prof = targetProfile(wantProfile) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        p.arguments = ["--profile-directory=\(prof)", "--new-window", argv[0]]
        // Chrome prints "Opening in existing browser session." — keep our stdout pure JSON.
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
        var waited = 0
        while waited < 6000 && Set(ids(windows())).subtracting(before).isEmpty { spin(0.1); waited += 100 }
        if let wid = Set(ids(windows())).subtracting(before).first, let w = window(id: wid) {
            w.setValue(NSValue(rect: NSRect(x: l, y: tp, width: r - l, height: b - tp)), forKey: "bounds")
            out = String(wid)
        }
    } else {
        let (o, err) = runAppleScript("""
        tell application "Google Chrome"
            set w to make new window
            set bounds of w to {\(l), \(tp), \(r), \(b)}
            set URL of active tab of w to \(asQuote(argv[0]))
            return (id of w as text)
        end tell
        """)
        if let e = err { fail("newwindow_failed", "新建窗口失败：\(e)") }
        out = o
    }
    let added = Set(ids(windows())).subtracting(before)
    guard let wid = added.first, let w = window(id: wid) else {
        fail("wrong_instance", "新窗口（id \(out ?? "?")）没有出现在目标 Chrome（pid \(chromeProc.processIdentifier)）里：AppleScript 连到了别的 Chrome 实例。请关掉多余的 Chrome 后重试。")
    }
    let t = w.value(forKey: "activeTab") as? SBObject
    check()
    // A new window brings Chrome forward, but only some time after it appears (seen 2026-10-13: the
    // caller handed the front back first, then Chrome came forward over the user's app). Wait for it
    // (up to 1.5 s), so a hand-back after this reply is not undone.
    var forwardMs = 0
    if !wasFront {
        while forwardMs < 1500 && frontApp()?.processIdentifier != chromeProc.processIdentifier { spin(0.02); forwardMs += 20 }
    }
    emit(["ok": true, "driver": "chromectl", "windowId": wid, "tabId": num(t?.value(forKey: "id")),
          "chromeCameForward": !wasFront && frontApp()?.processIdentifier == chromeProc.processIdentifier, "forwardMs": forwardMs])

case "move":
    // Move one window (the agent's own: index.js only passes those) to new bounds, e.g. onto the display
    // the user is not working on. Never activates or raises anything.
    guard argv.count >= 5, let l = Int(argv[1]), let tp = Int(argv[2]), let r = Int(argv[3]), let b = Int(argv[4]),
          let wid = Int(argv[0]) else {
        fail("usage", "move <windowId> <left> <top> <right> <bottom>")
    }
    guard let w = window(id: wid) else { fail("no_such_window", "找不到窗口 \(wid)") }
    w.setValue(NSValue(rect: NSRect(x: l, y: tp, width: r - l, height: b - tp)), forKey: "bounds")
    check()
    let nb = (w.value(forKey: "bounds") as? NSValue)?.rectValue ?? .zero
    emit(["ok": true, "driver": "chromectl", "windowId": wid,
          "bounds": ["left": Int(nb.origin.x), "top": Int(nb.origin.y), "width": Int(nb.width), "height": Int(nb.height)]])

case "close":
    // close <tabId> [--leave]: --leave answers the page's own "leave this site?" prompt (beforeunload)
    // with Leave, so closing an agent tab never leaves that dialog on the user's screen (round 5).
    guard let tid = argv.first.flatMap(Int.init) else { fail("usage", "close <tabId> [--leave]") }
    guard let (_, t, _) = findTab(tid) else { emit(["ok": true, "closed": false, "reason": "already gone"]) }
    t.perform(NSSelectorFromString("close"))
    check()
    var answered = false
    if argv.contains("--leave") {
        let t0 = Date()
        while findTab(tid) != nil && Date().timeIntervalSince(t0) < 3 {
            if !answered, let b = axLeaveButton(pid: chromeProc.processIdentifier) {
                answered = AXUIElementPerformAction(b, kAXPressAction as CFString) == .success
            }
            usleep(150_000)
        }
    }
    emit(["ok": true, "closed": findTab(tid) == nil, "leavePrompt": answered])

case "dialog":
    // dialog [--press <button title>]: the page dialog (alert / confirm / prompt) if one is up; --press answers it.
    guard let d = axPageDialog(pid: chromeProc.processIdentifier) else { emit(["ok": true, "open": false]) }
    if let i = argv.firstIndex(of: "--press"), i + 1 < argv.count {
        let want = argv[i + 1]
        // prompt(): the text goes into the dialog's field first (--text).
        if let j = argv.firstIndex(of: "--text"), j + 1 < argv.count {
            guard let field = axFirstTextField(in: d.window) else {
                emit(["ok": false, "error": "no_text_field", "message": "这个对话框没有输入框（不是 prompt），不能填文字"])
            }
            AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, argv[j + 1] as CFString)
        }
        guard let b = d.buttons.first(where: { $0.0 == want }) else {
            emit(["ok": false, "error": "no_such_button", "message": "对话框里没有「\(want)」按钮", "buttons": d.buttons.map { $0.0 }])
        }
        let ok = AXUIElementPerformAction(b.1, kAXPressAction as CFString) == .success
        usleep(250_000)
        emit(["ok": ok, "open": true, "pressed": want, "stillOpen": axPageDialog(pid: chromeProc.processIdentifier) != nil])
    }
    emit(["ok": true, "open": true, "title": d.title, "texts": d.texts, "buttons": d.buttons.map { $0.0 }, "hasField": d.hasField])

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
          "chromeWindow": wid, "chromeTab": tid])

case "restore":
    // restore <appPid> <windowId> <tabId> [--stop-on-input] [--if-chrome-front]
    //         [--since <epochMs>] [--no-click-since <epochMs>]   (any id may be "-")
    // When the user's app is not Chrome, it goes to the front FIRST and only
    // then Chrome's window order / active tab are put back: reordering while
    // Chrome is still frontmost makes the user's window key for a moment, and
    // their tab gets a window focus followed by blur (plan A3). So the reorder
    // is skipped whenever Chrome is still in front at that point (the app did
    // not come forward in time, or it has quit), and reported.
    //   --stop-on-input   skip the reorder once HID input arrived after start
    //                     (the user took over while we were putting things back)
    //   --if-chrome-front do nothing unless Chrome is frontmost at start (used to
    //                     hand the front back to the user's app after they took over)
    //   --since <epochMs> with --stop-on-input: count input from this wall-clock
    //                     time instead of this process's start (the caller's last
    //                     check of the user; nothing of its own is posted after it)
    //   --no-click-since <epochMs>  do not activate the app when a mouse button
    //                     went down after this time: the user clicked a window of
    //                     their choice (reply skipped: "user_clicked")
    // With --stop-on-input the app is not activated either once input arrived
    // (reply activated: false).
    var flags = Set<String>(), values: [String: Double] = [:], pos: [String] = []
    var ai = 0
    while ai < argv.count {
        let a = argv[ai]
        if a == "--since" || a == "--no-click-since" {
            if ai + 1 < argv.count, let v = Double(argv[ai + 1]) { values[a] = v }
            ai += 2; continue
        }
        if a.hasPrefix("--") { flags.insert(a) } else { pos.append(a) }
        ai += 1
    }
    let t0 = values["--since"].map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
    let stopOnInput = flags.contains("--stop-on-input")
    // Nothing of ours is posted while this runs (activation and window order
    // post no input events), so any input after t0 is the user's (F13, F18).
    func userActed() -> Bool {
        stopOnInput && idleSeconds() * 1000 < Date().timeIntervalSince(t0) * 1000 - 50
    }
    func userClicked() -> Bool {
        guard let since = values["--no-click-since"] else { return false }
        let downs: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        let age = downs.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? .infinity
        return age * 1000 < Date().timeIntervalSince1970 * 1000 - since
    }
    /// Whether anything was changed (a window or tab given back).
    @discardableResult func putBackChrome() -> Bool {
        var changed = false
        if pos.count >= 3, let wid = Int(pos[1]), let w = window(id: wid) {
            if let tid = Int(pos[2]), let k = ids(tabs(w)).firstIndex(of: tid), num(w.value(forKey: "activeTabIndex")) != k + 1 {
                w.setValue(k + 1, forKey: "activeTabIndex"); changed = true
            }
            if num(w.value(forKey: "index")) != 1 { w.setValue(1, forKey: "index"); changed = true }
        }
        return changed
    }
    let chromePid = chromeProc.processIdentifier
    func chromeFront() -> Bool { frontApp()?.processIdentifier == chromePid }
    if flags.contains("--if-chrome-front") && !chromeFront() {
        emit(["ok": true, "skipped": "chrome_not_front", "appFrontmost": false, "chromeReordered": false])
    }
    guard let pidS = pos.first, let pid = pid_t(pidS), pid != chromePid else {
        // The user was in Chrome itself: put its window and tab back.
        if userActed() { emit(["ok": true, "chromeReordered": false, "userInput": true]) }
        emit(["ok": true, "chromeReordered": putBackChrome()])
    }
    guard let a = NSRunningApplication(processIdentifier: pid) else {
        // The user's app has quit since the snapshot.
        let reorder = !chromeFront() && !userActed() && putBackChrome()
        emit(["ok": true, "appFrontmost": false, "appGone": true, "chromeReordered": reorder, "userInput": userActed()])
    }
    // Checked right before activating: the user may have taken over since the
    // caller's last look (Node's own work and this process's start take time).
    if userClicked() {
        emit(["ok": true, "skipped": "user_clicked", "appFrontmost": false, "chromeReordered": false, "activated": false])
    }
    if userActed() {
        emit(["ok": true, "appFrontmost": false, "chromeReordered": false, "userInput": true, "activated": false])
    }
    a.activate(options: [])
    var waited = 0
    while waited < 1000 && frontApp()?.processIdentifier != pid && !userActed() {
        spin(0.005); waited += 5
    }
    trace("restore: app activate+wait (\(waited) ms polled)")
    let appFront = frontApp()?.processIdentifier == pid
    let acted = userActed()
    var reordered = false
    if !acted && !chromeFront() { reordered = putBackChrome(); trace("restore: putBackChrome"); if stopOnInput { spin(0.05) } }
    // Reordering a background Chrome might re-activate it (plan A3 risk, unmeasured): look right after,
    // and give the front back once more unless the user acted or clicked meanwhile. Reported as seen
    // after this (appFrontmost), with whether Chrome came forward (chromeReactivated).
    var reactivated = false, appFrontEnd = appFront
    if reordered {
        spin(0.03)
        if chromeFront() {
            reactivated = true
            trace("restore: Chrome came forward after the reorder")
            if !userActed() && !userClicked() {
                a.activate(options: [])
                var w2 = 0
                while w2 < 500 && frontApp()?.processIdentifier != pid && !userActed() { spin(0.005); w2 += 5 }
            }
        }
        appFrontEnd = frontApp()?.processIdentifier == pid
    }
    trace("restore: done")
    emit(["ok": true, "waitedMs": waited, "appFrontmost": appFrontEnd, "chromeReordered": reordered,
          "userInput": acted, "chromeReactivated": reactivated, "activated": true])

case "activate" where argv.contains("--lean"):
    // activate --lean --tab T --window W [--cg N]: the foreground path, with what the caller
    // already knows (window id, CG window from its pre-check) and nothing else read: no tab
    // search, no title/URL list, the active tab set only if it is not already, 5 ms polling.
    //   --assume-active   the pre-check saw the tab active in a non-minimized window
    //   --bounds l,t,w,h  the window's bounds from the pre-check
    guard let tid = tabArg, let wi = argv.firstIndex(of: "--window"), wi + 1 < argv.count,
          let wid = Int(argv[wi + 1]) else {
        fail("no_such_tab", "找不到标签（可能已关闭或被移到别的窗口）。请重新调用 list_tabs。")
    }
    let assume = argv.contains("--assume-active")
    var r = NSRect.zero
    if let bi = argv.firstIndex(of: "--bounds"), bi + 1 < argv.count {
        let n = argv[bi + 1].split(separator: ",").compactMap { Double($0) }
        if n.count == 4 { r = NSRect(x: n[0], y: n[1], width: n[2], height: n[3]) }
    }
    // A lazy reference: no round trip until a property is read; the active-tab read below
    // is the one that also proves the window still exists (an error otherwise).
    guard assume || ids(windows()).contains(wid) else { fail("no_such_tab", "窗口 \(wid) 已经不在了。") }
    let w = windows().object(withID: String(wid)) as! SBObject
    trace("lean: window")
    if !assume, (w.value(forKey: "minimized") as? Bool) == true { w.setValue(false, forKey: "minimized") }
    // Always read once: the user may have switched this window's tab since the pre-check.
    if num((w.value(forKey: "activeTab") as? SBObject)?.value(forKey: "id")) != tid {
        check()
        guard let k = ids(tabs(w)).firstIndex(of: tid) else { fail("no_such_tab", "标签 \(tid) 已经不在窗口 \(wid) 里。") }
        w.setValue(k + 1, forKey: "activeTabIndex")
    }
    check()
    trace("lean: tab")
    if r == .zero { r = rectOf(w) }
    if !assume, num(w.value(forKey: "index")) != 1 { w.setValue(1, forKey: "index") }
    // The CG window from the caller's pre-check, if it is still this window (owner, bounds); else
    // matched now. Raise, on-top and key-window checks then go by window number, not by bounds
    // (a twin window with the same bounds would pass those).
    // With a twin (another Chrome window with these bounds) the pre-check's number is not trusted: the
    // window order may have changed since; matched afresh, and after the raise Chrome itself must say
    // this window is its front one (a wrong number would raise the twin and pass the checks below).
    let twins = cgWindows(pid: chromeProc.processIdentifier).filter { sameRect($0.rect, r) }.count > 1
    var cgN: Int? = nil
    if twins {
        cgN = cgWindowIds()[wid]
    } else if let ci = argv.firstIndex(of: "--cg"), ci + 1 < argv.count, let n = Int(argv[ci + 1]),
       let d = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(n)) as? [[String: Any]])?.first,
       (d[kCGWindowOwnerPID as String] as? Int) == Int(chromeProc.processIdentifier),
       let b = d[kCGWindowBounds as String] as? NSDictionary, let cr = CGRect(dictionaryRepresentation: b), sameRect(cr, r) {
        cgN = n
    } else {
        cgN = cgWindowIds()[wid]
    }
    trace("lean: cg")
    let axOk = axMakeMain(pid: chromeProc.processIdentifier, bounds: r, cg: cgN)
    trace("lean: raised")
    chromeProc.activate(options: [])
    var waited = 0
    while waited < 1000 && frontApp()?.processIdentifier != chromeProc.processIdentifier { spin(0.005); waited += 5 }
    trace("lean: active (\(waited) ms)")
    // Not matched before (e.g. a window still coming back from the Dock): once more, now it is up.
    if cgN == nil { cgN = cgWindowIds()[wid] }
    func isTarget(_ f: (num: Int, rect: CGRect)?) -> Bool {
        guard let f = f else { return false }
        return cgN.map { f.num == $0 } ?? sameRect(f.rect, r)
    }
    // On top: Chrome's frontmost on-screen window is this one (CG list, no Apple Event); with a twin,
    // Chrome's own order must agree (one Apple Event).
    func front() -> Bool {
        isTarget(cgOnScreenOrder(pid: chromeProc.processIdentifier).first) && (!twins || num(w.value(forKey: "index")) == 1)
    }
    var onTop = front()
    if !onTop {
        // AX raise did not reorder Chrome's windows: do it through Chrome, then look again. With a twin the
        // number may have been the twin's (window order changed while matching): matched once more.
        w.setValue(1, forKey: "index")
        spin(0.005)
        if twins { cgN = cgWindowIds()[wid] }
        onTop = front()
    }
    let key = axFocusedIs(pid: chromeProc.processIdentifier, bounds: r, cg: cgN)
    check()
    trace("lean: checks")
    emit(["ok": true, "lean": true, "tabId": tid, "windowId": wid, "chromePid": Int(chromeProc.processIdentifier),
          "driver": "chromectl", "tabActive": true,
          "bounds": ["left": Int(r.origin.x), "top": Int(r.origin.y), "width": Int(r.size.width), "height": Int(r.size.height)],
          "axMain": axOk, "frontmost": frontApp()?.localizedName ?? "", "waitedMs": waited,
          "targetOnTop": onTop, "keyWindowIsTarget": key, "cgWindow": cgN ?? NSNull()])

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
    var expectWindow: Int? = nil
    if cmd == "select" {
        guard let x = argv.first.flatMap(Int.init) else { fail("usage", "select <tabId> [--window <windowId>]") }
        tabArg = x
        if let i = argv.firstIndex(of: "--window"), i + 1 < argv.count { expectWindow = Int(argv[i + 1]) }
    }
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
    var target: [String: Any] = [
        "tabId": tid, "windowId": wid,
        "tabActive": num((w.value(forKey: "activeTab") as? SBObject)?.value(forKey: "id")) == tid,
        "windowIndex": num(w.value(forKey: "index")),
        "minimized": (w.value(forKey: "minimized") as? Bool) ?? false,
        "url": str(t.value(forKey: "URL")), "title": str(t.value(forKey: "title")),
        "tabCount": ids(tabs(w)).count, "bounds": boundsJSON(w),
        "driver": "chromectl", "chromePid": Int(chromeProc.processIdentifier)
    ]
    check("target_metadata")
    trace("target metadata")

    switch cmd {
    case "info":
        target["ok"] = true
        // Browser-side metadata remains readable while a new document is loading.
        // URL stability alone does not mean an OAuth/HTTP redirect chain has finished.
        target["loading"] = (t.value(forKey: "loading") as? Bool) ?? true
        check("info_loading")
        target["frontmost"] = frontApp()?.localizedName ?? ""
        target["cgWindow"] = cgWindowJSON(wid)
        emit(target)

    case "select":
        // Only the window's active tab changes: no activation, no index. If
        // Chrome raised the window anyway, the previous front Chrome window is
        // put back, as `open` does. With --window, refuse when the tab is no
        // longer in that window (the user dragged it into one of theirs).
        if let ew = expectWindow, ew != wid {
            fail("tab_moved", "标签 \(tid) 已经不在窗口 \(ew) 里（现在在窗口 \(wid)），没有切换。")
        }
        let prevFront = frontWindowId()
        let prevApp = frontApp()?.processIdentifier
        var changed = false
        if let k = ids(tabs(w)).firstIndex(of: tid), num(w.value(forKey: "activeTabIndex")) != k + 1 {
            w.setValue(k + 1, forKey: "activeTabIndex"); changed = true
        }
        var putBack = false
        if changed, let pf = prevFront, pf != wid, frontWindowId() != pf, let fw = window(id: pf) {
            fw.setValue(1, forKey: "index"); putBack = true
        }
        check()
        target["ok"] = true
        target["changed"] = changed
        target["prevFrontPutBack"] = putBack
        target["tabActive"] = num((w.value(forKey: "activeTab") as? SBObject)?.value(forKey: "id")) == tid
        target["windowIndex"] = num(w.value(forKey: "index"))
        target["frontmost"] = frontApp()?.localizedName ?? ""
        target["frontmostChanged"] = frontApp()?.processIdentifier != prevApp
        target["cgWindow"] = cgWindowJSON(wid)
        emit(target)

    case "activate":
        // Make this tab the one on screen, raising ONLY its window: select the
        // tab, raise the window inside Chrome, then activate the process
        // without .activateAllWindows (AppleScript `activate` raised every
        // Chrome window over the user's app — seen live).
        if (w.value(forKey: "minimized") as? Bool) == true { w.setValue(false, forKey: "minimized") }
        if let k = ids(tabs(w)).firstIndex(of: tid) { w.setValue(k + 1, forKey: "activeTabIndex") }
        trace("activeTabIndex")
        w.setValue(1, forKey: "index")
        trace("index=1")
        // By window number when it can be matched now (twins share bounds); by bounds otherwise.
        let axOk = axMakeMain(pid: chromeProc.processIdentifier, bounds: rectOf(w), cg: cgWindowIds()[wid])
        trace("axMakeMain")
        chromeProc.activate(options: [])
        var waited = 0
        while waited < 1000 && frontApp()?.processIdentifier != chromeProc.processIdentifier {
            spin(0.05); waited += 50
        }
        trace("activate+wait (\(waited) ms polled)")
        // Belt and braces: if activation still put another window on top.
        if num(w.value(forKey: "index")) != 1 { w.setValue(1, forKey: "index"); spin(0.05) }
        target["axMain"] = axOk
        let onTop = num(w.value(forKey: "index")) == 1 && num((w.value(forKey: "activeTab") as? SBObject)?.value(forKey: "id")) == tid
        check()
        trace("onTop check")
        target["ok"] = true
        target["frontmost"] = frontApp()?.localizedName ?? ""
        target["waitedMs"] = waited
        target["targetOnTop"] = onTop
        target["bounds"] = boundsJSON(w)
        let cgN = cgWindowIds()[wid]
        target["cgWindow"] = cgN ?? NSNull()
        trace("cgWindow")
        target["keyWindowIsTarget"] = axFocusedIs(pid: chromeProc.processIdentifier, bounds: rectOf(w), cg: cgN)
        trace("axFocused")
        emit(target)

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
