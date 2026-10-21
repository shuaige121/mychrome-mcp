// cgevent — tiny CGEvent CLI helper for MyChrome MCP
//
// All coordinates are in Quartz global display space POINTS (top-left origin),
// which is the same unit AppleScript reports for window bounds. On a Retina
// display 1 point = 2 physical pixels; CGEvent does NOT want pixels.
//
// Subcommands:
//   check                       -> {"ok":true,"trusted":bool,"arch":"arm64"}
//   trust [--ask-automation]    -> {"ok":true,"accessibility":bool,"screenRecording":bool,"automation":code,
//                                   "responsible":{pid,name,bundleId,path},"arch":..}; read-only, never
//                                   prompts (except --ask-automation: macOS's own Automation question
//                                   for Chrome, only if it has never asked)
//   mousepos                    -> {"ok":true,"x":..,"y":..}
//   windowsat <x> <y>           -> on-screen windows covering that point, front to back
//   click <x> <y> [durationMs]  -> curved humanised move then left down/up
//   press <x> <y> [--expect-owner NAME] [--tolerance PT]
//                               -> press/release WITHOUT moving; refuses if the
//                                  top window there is not NAME, or if the cursor
//                                  has drifted off the point (a hand on the mouse)
//   move  <x> <y> [durationMs]  -> curved move only
//   type  <utf8-text>           -> unicode keystrokes into the focused app
//   key   return|tab|escape     -> a single named key
//   scroll <lines>              -> wheel at current pointer (negative = down)
//   session                     -> JSON Lines input session for one locked action
//                                  (docs/impl-contract.md §1; CGEVENT_DRYRUN=1 posts nothing)
//   veildemo --rect x,y,w,h [--seconds 4] [--label TEXT] [--path] [--point x,y]
//            [--appearance light|dark] [--reduce-motion] [--contrast] [--continuous]
//            [--slow N] [--panel] -> shows the takeover veil over that CG rect and plays its
//                                  motions on the veil's own layers: no event tap, no input
//                                  posted, the real cursor never moves (docs/overlay-design);
//                                  --panel adds the progress panel with a sample task
//   veilsnap --out sheet.png [--scale 2] [--lang zh|en] [--frames start,moving,…]
//                               -> the progress panel's sample states rendered offscreen
//                                  (no window), and their layout as JSON
//   model --from x,y --rect x,y,w,h [--n N] [--seed S] [--aim x,y] [--window x,y,w,h]
//         [--rate ms] [--u U] [--points]
//                               -> stats of N planned pointer movements, posts nothing
//   ocr <png> [--langs zh-Hans,zh-Hant,en-US,ja-JP]
//                               -> text lines in the image (Vision, on-device): {text, conf,
//                                  x, y, w, h} in image pixels, top-left origin, top to bottom
//   windowstack <cgWindowId>    -> that window's CG bounds and the on-screen windows in front of
//                                  it that overlap it (ids, pids, layers; no titles, no pixels)
//   habits record --seconds N [--out f] | show | delete | use on|off | fit <events.jsonl> --out f
//                               -> the user's own input rhythm, statistics only (C9; MARK "habits")
//   compose --out o.png --base b.png --rect x,y,w,h [--add p.png@x,y,w,h]...
//                               -> b.png (the window at CG rect x,y,w,h) with each p.png drawn
//                                  over it at its own CG rect, clipped to the window; offline
//
// Everything except `session` prints a single JSON line on stdout. Failures exit 1.

import Foundation
import CoreGraphics
import ApplicationServices
import AppKit
import QuartzCore
import Carbon
import ImageIO
import Vision
import CryptoKit

// MARK: - output helpers

func emit(_ dict: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: dict, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "error": code, "message": message])
    exit(1)
}

// MARK: - randomness

/// Every draw of the session and model paths goes through `rng`. CGEVENT_SEED
/// (or `model --seed`) turns it into a SplitMix64 stream so tests are
/// reproducible; unset, it forwards to the system generator.
struct HelperRNG: RandomNumberGenerator {
    var state: UInt64?
    mutating func next() -> UInt64 {
        guard var s = state else { var g = SystemRandomNumberGenerator(); return g.next() }
        s &+= 0x9E37_79B9_7F4A_7C15
        state = s
        var z = s
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

func seedValue(_ s: String) -> UInt64 {
    if let v = UInt64(s) { return v }
    var h: UInt64 = 0xCBF2_9CE4_8422_2325                // FNV-1a of a non-numeric seed
    for b in s.utf8 { h = (h ^ UInt64(b)) &* 0x100_0000_01B3 }
    return h
}

var rng = HelperRNG(state: ProcessInfo.processInfo.environment["CGEVENT_SEED"].map(seedValue))

func unit() -> Double { Double(rng.next() >> 11) * 0x1.0p-53 }
func uniform(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * unit() }
func gauss() -> Double {
    let u1 = max(unit(), Double.ulpOfOne), u2 = unit()
    return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
}

/// Monotonic milliseconds.
func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

func r2(_ x: Double) -> Double { x.isFinite ? (x * 100).rounded() / 100 : 0 }

var archName: String {
    #if arch(arm64)
    return "arm64"
    #elseif arch(x86_64)
    return "x86_64"
    #else
    return "unknown"
    #endif
}

// MARK: - accessibility

func isTrusted() -> Bool {
    // Never pass kAXTrustedCheckOptionPrompt: we must not pop System Settings.
    return AXIsProcessTrusted()
}

// A native menu can block Apple Events, so this narrow recovery does not
// activate an app or use ScriptingBridge. The caller must hold the shared
// input lock; all target, menu and fresh-user-input guards are repeated here.
@_silgen_name("_AXUIElementGetWindow")
func nativeEscapeWindowNumber(_ element: AXUIElement, _ window: UnsafeMutablePointer<CGWindowID>) -> AXError

func guardedNativeEscape(pid: pid_t, window: Int, documentToken: String, since: Double) -> [String: Any] {
    func denied(_ why: String) -> [String: Any] {
        ["ok": false, "error": "native_recovery_unavailable", "message": "没有发送 Esc（\(why)）。请手动按 Esc 关闭系统菜单，再重新读取页面。"]
    }
    let started = Date().timeIntervalSince1970 * 1000
    guard since.isFinite, started >= since, started - since < 5000, documentToken.count == 64 else { return denied("检查已过期") }
    guard isTrusted(), let chrome = NSRunningApplication(processIdentifier: pid),
          chrome.bundleIdentifier == "com.google.Chrome", !chrome.isTerminated else { return denied("Chrome 身份无法确认") }
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          session["kCGSSessionOnConsoleKey"] as? Bool == true,
          session["kCGSessionLoginDoneKey"] as? Bool == true else { return denied("屏幕不可操作") }
    if let locked = session["CGSSessionScreenIsLocked"] {
        guard let value = locked as? Bool, !value else { return denied("屏幕锁定状态无法确认") }
    }
    guard !IsSecureEventInputEnabled() else { return denied("安全输入已开启") }
    var displayIDs = [CGDirectDisplayID](repeating: 0, count: 16), displayCount: UInt32 = 0
    guard CGGetActiveDisplayList(16, &displayIDs, &displayCount) == .success,
          displayIDs.prefix(Int(displayCount)).contains(where: { CGDisplayIsAsleep($0) == 0 }) else { return denied("显示器尚未唤醒") }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.10)
    var failed = false, reads = 0
    func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        reads += 1
        guard reads < 120, Date().timeIntervalSince1970 * 1000 - started < 1600 else { failed = true; return nil }
        AXUIElementSetMessagingTimeout(element, 0.10)
        var result: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &result)
        if status == .attributeUnsupported || status == .noValue { return nil }
        if status != .success { failed = true; return nil }
        return result
    }
    func element(_ parent: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attr(parent, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    guard let focusedWindow = element(app, kAXFocusedWindowAttribute) else { return denied("键盘窗口无法确认") }
    var cg: CGWindowID = 0
    guard nativeEscapeWindowNumber(focusedWindow, &cg) == .success, Int(cg) == window else { return denied("键盘窗口已改变") }
    var node = element(app, kAXFocusedUIElementAttribute), visited: [AXUIElement] = []
    var popup = false, menu = false, token: String?
    while let current = node, visited.count < 16 {
        if visited.contains(where: { CFEqual($0, current) }) { break }
        visited.append(current)
        let role = attr(current, kAXRoleAttribute) as? String ?? ""
        if role == kAXMenuRole || role == kAXMenuItemRole { menu = true }
        if role == kAXPopUpButtonRole {
            popup = true
            if attr(current, kAXExpandedAttribute) as? Bool == true { menu = true }
            for child in (attr(current, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(12) {
                if attr(child, kAXRoleAttribute) as? String == kAXMenuRole { menu = true }
            }
        }
        if role == "AXWebArea" {
            let url = attr(current, kAXURLAttribute).map { String(describing: $0) } ?? ""
            token = SHA256.hash(data: Data("\(CFHash(current)):\(url)".utf8)).map { String(format: "%02x", $0) }.joined()
        }
        if role == kAXWindowRole || role == kAXApplicationRole { break }
        node = element(current, kAXParentAttribute)
    }
    guard !failed, popup, menu, token == documentToken else { return denied("原生菜单或页面身份无法确认") }
    let inputKinds: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
        .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel, .mouseMoved, .leftMouseDragged]
    let idle = inputKinds.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0
    guard idle * 1000 > Date().timeIntervalSince1970 * 1000 - since + 20, hardwareHeld().isEmpty else { return denied("用户正在操作") }
    guard !IsSecureEventInputEnabled(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          cgFrontWindowOf(pid) == window else { return denied("前台窗口或安全输入状态已改变") }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false) else { return denied("无法创建按键") }
    for event in [down, up] {
        event.flags = []
        event.setIntegerValueField(.eventSourceUserData, value: SESSION_TAG)
        event.post(tap: .cghidEventTap)
    }
    return ["ok": true, "postedInput": 1, "pid": Int(pid), "window": window]
}

// MARK: - permission report (`cgevent trust`, for `mychrome-mcp doctor`)

/// The process macOS holds responsible for this one: privacy permissions are granted to, and asked
/// for on behalf of, that app (usually the terminal or agent app that started the server), not
/// this helper. responsibility_get_pid_responsible_for_pid is private, so it is looked up at run
/// time; without it, pid is null.
func responsibleApp() -> [String: Any] {
    typealias Fn = @convention(c) (pid_t) -> pid_t
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else {
        return ["pid": NSNull()]   // RTLD_DEFAULT is (void *)-2 on Darwin
    }
    let pid = unsafeBitCast(sym, to: Fn.self)(getpid())
    guard pid > 0 else { return ["pid": NSNull()] }
    var out: [String: Any] = ["pid": Int(pid)]
    if let app = NSRunningApplication(processIdentifier: pid) {
        out["name"] = app.localizedName ?? NSNull()
        out["bundleId"] = app.bundleIdentifier ?? NSNull()
        out["path"] = (app.bundleURL ?? app.executableURL)?.path ?? NSNull()
    }
    return out
}

/// May this process's responsible app send Apple Events to Google Chrome (System Settings →
/// Privacy & Security → Automation)? AEDeterminePermissionToAutomateTarget: 0 allowed, -1743
/// denied, -1744 not asked yet, -600 Chrome not running. `ask` lets macOS show its question when
/// it has never asked; without it nothing is shown.
func automationCode(ask: Bool) -> Int {
    let chrome = NSAppleEventDescriptor(bundleIdentifier: "com.google.Chrome")
    guard let desc = chrome.aeDesc else { return Int(paramErr) }
    return Int(AEDeterminePermissionToAutomateTarget(desc, typeWildCard, typeWildCard, ask))
}

func requireTrust() {
    if !isTrusted() {
        let host = ProcessInfo.processInfo.environment["CHROME_BRIDGE_HOST_APP"] ?? "运行本 MCP 的终端 App"
        fail("no_accessibility",
             "系统未授予「辅助功能」权限，无法模拟鼠标/键盘。请在 系统设置 → 隐私与安全性 → 辅助功能 中，为 \(host) 打上勾，然后重启该 App。")
    }
}

// MARK: - pointer

func currentMouse() -> CGPoint {
    if let e = CGEvent(source: nil) { return e.location }
    return CGPoint(x: 0, y: 0)
}

/// The one-shot CLI commands post through here: tagged CLI_TAG, so the habit recorder (and anything
/// else that listens) can tell these from the user's own input.
func post(_ event: CGEvent?) {
    event?.setIntegerValueField(.eventSourceUserData, value: CLI_TAG)
    event?.post(tap: .cghidEventTap)
}

/// Quadratic bezier with a perpendicular bow + per-step jitter.
func curvedPath(from a: CGPoint, to b: CGPoint, steps: Int) -> [CGPoint] {
    let dx = b.x - a.x, dy = b.y - a.y
    let dist = (dx * dx + dy * dy).squareRoot()
    // Bow out perpendicular to the travel direction, up to ~12% of distance.
    let bow = min(max(dist * Double.random(in: 0.05...0.12), 6), 90)
    let sign: Double = Bool.random() ? 1 : -1
    let nx = dist == 0 ? 0 : -dy / dist
    let ny = dist == 0 ? 0 : dx / dist
    let ctrl = CGPoint(x: (a.x + b.x) / 2 + nx * bow * sign,
                       y: (a.y + b.y) / 2 + ny * bow * sign)

    var pts: [CGPoint] = []
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        // ease-in-out so it starts and ends slowly like a hand does
        let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        let u = 1 - e
        var x = u * u * a.x + 2 * u * e * ctrl.x + e * e * b.x
        var y = u * u * a.y + 2 * u * e * ctrl.y + e * e * b.y
        if i < steps { // never jitter the final landing point
            x += Double.random(in: -1.2...1.2)
            y += Double.random(in: -1.2...1.2)
        }
        pts.append(CGPoint(x: x, y: y))
    }
    return pts
}

func humanMove(to target: CGPoint, durationMs: Int) {
    let start = currentMouse()
    let steps = max(8, min(40, Int(durationMs / 12)))
    let path = curvedPath(from: start, to: target, steps: steps)
    let perStep = UInt32(max(1, (durationMs * 1000) / max(1, steps)))
    for p in path {
        post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                     mouseCursorPosition: p, mouseButton: .left))
        usleep(perStep)
    }
}

/// Press and release at `p`.
///
/// kCGMouseEventClickState is set explicitly. AppKit reports it as
/// `clickCount`, and Blink refuses to dispatch a DOM `click` for click_count 0,
/// so a wrong value here produces a "focused but never activated" click.
/// Investigated 2026-09-05 as a candidate cause for exactly that symptom and
/// RULED OUT: this CGEvent initialiser already yields clickState 1, measured
/// with getIntegerValueField on a freshly built .leftMouseDown. The field is
/// pinned anyway so the value is stated rather than inherited.
func leftClick(at p: CGPoint) {
    if let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                          mouseCursorPosition: p, mouseButton: .left) {
        down.setIntegerValueField(.mouseEventClickState, value: 1)
        post(down)
    }
    usleep(UInt32.random(in: 40_000...110_000))
    if let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                        mouseCursorPosition: p, mouseButton: .left) {
        up.setIntegerValueField(.mouseEventClickState, value: 1)
        post(up)
    }
}

// MARK: - windows

struct WinInfo {
    let owner: String
    let pid: Int
    let layer: Int
    let alpha: Double
    let rect: CGRect
}

/// On-screen windows containing `p`, front to back.
///
/// kCGWindowListOptionOnScreenOnly is documented to return windows in
/// front-to-back order, and kCGWindowBounds is in the same global screen-POINT
/// space (top-left origin) that CGEvent posts into — so no conversion here.
/// kCGWindowOwnerName is available without Screen Recording permission;
/// kCGWindowName would not be, which is why we never ask for the title.
func windowsContaining(_ p: CGPoint) -> [WinInfo] {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var out: [WinInfo] = []
    for w in raw {
        guard let bd = w[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: bd) else { continue }
        if !r.contains(p) { continue }
        out.append(WinInfo(
            owner: (w[kCGWindowOwnerName as String] as? String) ?? "",
            pid: (w[kCGWindowOwnerPID as String] as? Int) ?? 0,
            layer: (w[kCGWindowLayer as String] as? Int) ?? 0,
            alpha: (w[kCGWindowAlpha as String] as? Double) ?? 1,
            rect: r))
    }
    return out
}

/// Same rule as pickTopWindowOwner() in src/guard.js — keep the two in step.
/// Skips: transparent windows, everything below the normal window layer (the
/// desktop picture and the desktop icon layer cover every point and occlude
/// nothing), everything at or above the Dock's layer (measured 2026-09-05: the
/// Dock owns a window the full size of the main display at layer 20, so
/// trusting it would veto every click on that display), degenerate windows,
/// and the Window Server's own bookkeeping.
let MAX_WINDOW_LAYER = 19

func topOwner(at p: CGPoint) -> String? {
    for w in windowsContaining(p) {
        if w.alpha <= 0.05 { continue }
        if w.layer < 0 || w.layer > MAX_WINDOW_LAYER { continue }
        if w.rect.width < 2 || w.rect.height < 2 { continue }
        if w.owner == "Window Server" || w.owner.isEmpty { continue }
        return w.owner
    }
    return nil
}

// MARK: - keyboard

/// CGEventKeyboardSetUnicodeString is documented as reliable only for short
/// strings, so feed it in small UTF-16 chunks. virtualKey 0 + unicode payload
/// is the standard way to deliver arbitrary text (incl. CJK) without an IME.
func typeUnicode(_ text: String) {
    let units = Array(text.utf16)
    let chunk = 8
    var i = 0
    while i < units.count {
        let slice = Array(units[i..<min(i + chunk, units.count)])
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
        down.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: slice)
        up.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: slice)
        post(down)
        usleep(UInt32.random(in: 8_000...26_000))
        post(up)
        usleep(UInt32.random(in: 12_000...40_000))
        i += chunk
    }
}

// MARK: - human typing

/// US-layout virtual keycodes, with whether Shift is held. The user types
/// through WeType Pinyin; measured 2026-09-28: a REAL keycode that also
/// carries the character as a unicode string comes out exact through that IME
/// and the page sees the right key/code (H/KeyH, !/Digit1+Shift). Keycode 0 +
/// unicode (the old path, and keytype's) shows code "KeyA" for every char.
let usKeys: [Character: (CGKeyCode, Bool)] = {
    var m: [Character: (CGKeyCode, Bool)] = [:]
    let base: [(String, CGKeyCode)] = [
        ("a",0),("s",1),("d",2),("f",3),("h",4),("g",5),("z",6),("x",7),("c",8),("v",9),("b",11),
        ("q",12),("w",13),("e",14),("r",15),("y",16),("t",17),("1",18),("2",19),("3",20),("4",21),
        ("6",22),("5",23),("=",24),("9",25),("7",26),("-",27),("8",28),("0",29),("]",30),("o",31),
        ("u",32),("[",33),("i",34),("p",35),("l",37),("j",38),("'",39),("k",40),(";",41),("\\",42),
        (",",43),("/",44),("n",45),("m",46),(".",47),(" ",49),("`",50)]
    for (c, k) in base { m[Character(c)] = (k, false) }
    for c in "abcdefghijklmnopqrstuvwxyz" { m[Character(c.uppercased())] = (m[c]!.0, true) }
    let shifted: [(String, String)] = [("!","1"),("@","2"),("#","3"),("$","4"),("%","5"),("^","6"),
        ("&","7"),("*","8"),("(","9"),(")","0"),("_","-"),("+","="),("{","["),("}","]"),("|","\\"),
        (":",";"),("\"","'"),("<",","),(">","."),("?","/"),("~","`")]
    for (c, b) in shifted { m[Character(c)] = (m[Character(b)]!.0, true) }
    return m
}()

/// Log-normal sample in ms: median * exp(sigma * N(0,1)), clamped.
func lognormalMs(_ median: Double, _ sigma: Double, _ lo: Double, _ hi: Double) -> Double {
    return min(hi, max(lo, median * exp(sigma * gauss())))
}
func sleepMs(_ ms: Double) { usleep(UInt32(max(0, ms) * 1000)) }

func keyEvent(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags, _ unicode: String?) {
    guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { return }
    e.flags = flags
    if let u = unicode {
        let units = Array(u.utf16)
        e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    }
    post(e)
}

/// A modifier going down/up is its own flagsChanged event on a real keyboard.
func modifier(_ code: CGKeyCode, _ flags: CGEventFlags) {
    guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: !flags.isEmpty) else { return }
    e.type = .flagsChanged
    e.flags = flags
    post(e)
}

let kShift: CGKeyCode = 56, kCommand: CGKeyCode = 55, kReturn: CGKeyCode = 36, kV: CGKeyCode = 9

/// One character on its real key, with human dwell.
func strike(_ code: CGKeyCode, shift: Bool, unicode: String?) {
    let flags: CGEventFlags = shift ? .maskShift : []
    if shift { modifier(kShift, .maskShift); sleepMs(lognormalMs(55, 0.35, 20, 150)) }
    keyEvent(code, true, flags, unicode)
    sleepMs(lognormalMs(95, 0.25, 40, 200))            // dwell (key held)
    keyEvent(code, false, flags, unicode)
    if shift { sleepMs(lognormalMs(35, 0.4, 10, 120)); modifier(kShift, []) }
}

/// Non-ASCII runs (CJK, emoji) are PASTED: a human types CJK through an IME
/// (composition events, keyCode 229), which cannot be reproduced; a key event
/// carrying "你" on the A key is a combination no keyboard makes. Paste is
/// ordinary human behaviour. The user's clipboard is saved and put back.
func pasteRun(_ text: String) -> Bool {
    let pb = NSPasteboard.general
    let saved: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { item in
        item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
    }
    pb.clearContents()
    pb.setString(text, forType: .string)
    let changeAfterSet = pb.changeCount
    sleepMs(lognormalMs(120, 0.3, 50, 300))
    modifier(kCommand, .maskCommand)
    sleepMs(lognormalMs(90, 0.3, 40, 220))
    keyEvent(kV, true, .maskCommand, nil)
    sleepMs(lognormalMs(80, 0.25, 40, 160))
    keyEvent(kV, false, .maskCommand, nil)
    sleepMs(lognormalMs(45, 0.35, 15, 120))
    modifier(kCommand, [])
    sleepMs(350)                                         // let the app read the pasteboard
    // Put the user's clipboard back — unless something else wrote to it meanwhile.
    if pb.changeCount == changeAfterSet {
        pb.clearContents()
        let items: [NSPasteboardItem] = saved.map { pairs in
            let it = NSPasteboardItem()
            for (t, d) in pairs { it.setData(d, forType: t) }
            return it
        }
        if !items.isEmpty { pb.writeObjects(items) }
        return true
    }
    return false
}

/// Type like a person: real keys for what a US keyboard has, paste for the
/// rest, newline as Shift+Return (Return would submit a single-line form),
/// tab as spaces (Tab moves focus). Returns counts for the report.
func typeHuman(_ text: String) -> [String: Any] {
    var keyed = 0, pasted = 0, runs = 0, clipboardRestored = true
    var pending = ""
    func flushPaste() {
        guard !pending.isEmpty else { return }
        if !pasteRun(pending) { clipboardRestored = false }
        pasted += pending.count; runs += 1; pending = ""
        sleepMs(lognormalMs(220, 0.4, 80, 700))
    }
    var prev: Character? = nil
    for ch in text.replacingOccurrences(of: "\t", with: "    ") {
        if ch == "\n" || ch == "\r\n" {
            flushPaste()
            strike(kReturn, shift: true, unicode: nil)
            keyed += 1
        } else if let (code, shift) = usKeys[ch] {
            flushPaste()
            strike(code, shift: shift, unicode: String(ch))
            keyed += 1
        } else {
            pending.append(ch)
            prev = ch
            continue
        }
        // flight time to the next key: slower after spaces and punctuation,
        // occasional longer hesitation
        var flight = lognormalMs(140, 0.5, 35, 900)
        if ch == " " { flight *= 1.3 }
        if ",.;:!?".contains(ch) { flight *= 1.6 }
        if Double.random(in: 0..<1) < 0.03 { flight += Double.random(in: 300...900) }
        sleepMs(flight)
        prev = ch
    }
    flushPaste()
    _ = prev
    return ["keyed": keyed, "pasted": pasted, "pasteRuns": runs, "clipboardRestored": clipboardRestored]
}

let namedKeys: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "escape": 53, "esc": 53,
    "delete": 51, "backspace": 51, "space": 49,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121
]

func pressKey(_ code: CGKeyCode) {
    post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true))
    usleep(UInt32.random(in: 20_000...50_000))
    post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false))
}

// MARK: - movement model (docs/impl-contract.md §1.4)

func dist(_ a: CGPoint, _ b: CGPoint) -> Double { hypot(b.x - a.x, b.y - a.y) }
func lerp(_ a: CGPoint, _ b: CGPoint, _ s: Double) -> CGPoint {
    CGPoint(x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s)
}
/// Closed-interval containment (CGRect.contains excludes the max edges).
func within(_ p: CGPoint, _ r: CGRect) -> Bool {
    p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY
}
func inner80(_ r: CGRect) -> CGRect { r.insetBy(dx: r.width * 0.1, dy: r.height * 0.1) }
func clampInto(_ p: CGPoint, _ r: CGRect) -> CGPoint {
    CGPoint(x: min(max(p.x, r.minX), r.maxX), y: min(max(p.y, r.minY), r.maxY))
}

/// Default pointer speed factor: matches the user's own median start-of-movement
/// -> press times (impl-contract §7 calibration).
let DEFAULT_MOUSE_SPEED = 1.8

/// Fitts factor u and where it came from: CHROME_BRIDGE_FITTS_U (older callers)
/// wins; else 1 / CHROME_BRIDGE_MOUSE_SPEED (> 0); else the user's recorded habits (`cgevent habits`,
/// clamped); else 1 / 1.8 (fitted to 150 of the user's own clicks).
func fittsSetting() -> (u: Double, source: String) {
    let env = ProcessInfo.processInfo.environment
    if let s = env["CHROME_BRIDGE_FITTS_U"], let v = Double(s), v > 0 { return (v, "CHROME_BRIDGE_FITTS_U") }
    if let s = env["CHROME_BRIDGE_MOUSE_SPEED"], let v = Double(s), v > 0 { return (1 / v, "CHROME_BRIDGE_MOUSE_SPEED") }
    if let u = gHabits.fittsU { return (u, "habits") }
    return (1 / DEFAULT_MOUSE_SPEED, "default")
}
func fittsU() -> Double { fittsSetting().u }

/// Arrival -> press pause: the user's own median 18 ms (P25 6, P75 42),
/// clamped to [4, 150] (impl-contract §7); or their recorded habits (never under 4 ms).
func sampleDwell() -> Double { gHabits.pressDwell.sample() }

/// Pause before a pointing movement starts (impl-contract §7): median 200 ms, floor 150.
func sampleReaction() -> Double { lognormalMs(200, 0.25, 150, 600) }

/// One submovement. The primary stroke follows the normalized CDF of a
/// lognormal velocity kernel (speed peak at exp(mu - sigma^2) of its duration)
/// and bows perpendicular by `bow` at mid-path; corrections are straight
/// minimum-jerk strokes. Neither adds per-point jitter.
struct Stroke {
    let from: CGPoint, to: CGPoint, ms: Double
    let primary: Bool
    let mu: Double, sigma: Double, bow: Double

    func at(_ tau: Double) -> CGPoint {
        let t = min(1, max(0, tau))
        if !primary {
            return lerp(from, to, t * t * t * (10 - 15 * t + 6 * t * t))
        }
        let cdf = { (x: Double) -> Double in 0.5 * erfc(-(log(x) - self.mu) / (self.sigma * 2.0.squareRoot())) }
        let s = t <= 0 ? 0 : t >= 1 ? 1 : cdf(t) / cdf(1)
        let base = lerp(from, to, s)
        let d = dist(from, to)
        if d == 0 { return base }
        let off = bow * 4 * s * (1 - s)
        return CGPoint(x: base.x - (to.y - from.y) / d * off, y: base.y + (to.x - from.x) / d * off)
    }
}

struct MovePlan {
    var start: CGPoint
    var landing: CGPoint          // where the pointer ends and the press happens
    var skipped = false
    var D = 0.0, W = 0.0, ID = 0.0
    var T = 0.0                   // the one budget, start of movement -> mouseDown
    var strokes: [Stroke] = []
    var dwell = 0.0
    var primaryEnd: CGPoint
    var primaryInside = true

    var moveMs: Double { strokes.reduce(0) { $0 + $1.ms } }
    var primaryMs: Double { strokes.first?.ms ?? 0 }
    var correctionMs: [Double] { strokes.dropFirst().map { $0.ms } }

    func position(at t: Double) -> CGPoint {
        var rest = t
        for s in strokes {
            if rest <= s.ms { return s.at(s.ms > 0 ? rest / s.ms : 1) }
            rest -= s.ms
        }
        return landing
    }

    /// The points a device would report: one per rateMs on the ideal
    /// schedule, the last one exactly the landing point.
    func samples(rate: Double) -> [(Double, CGPoint)] {
        if skipped { return [] }
        let total = moveMs
        var out: [(Double, CGPoint)] = []
        var k = 1
        while Double(k) * rate < total { out.append((Double(k) * rate, position(at: Double(k) * rate))); k += 1 }
        out.append((total, landing))
        return out
    }
}

/// Plan one pointing movement from `S` to a landing point inside `R`.
func planMove(from S: CGPoint, rect R: CGRect, aim: CGPoint?, window WB: CGRect?,
              rate: Double, u: Double) -> MovePlan {
    let box = inner80(R)
    if within(S, box) {
        // Already on the target: no movement, only the pause before pressing.
        let dwell = sampleDwell()
        return MovePlan(start: S, landing: S, skipped: true, T: dwell, dwell: dwell, primaryEnd: S)
    }

    // Landing: 2-D normal around the aim, SD = size/4.133 x 0.7 per axis,
    // resampled until it falls in the inner 80%.
    let a = clampInto(aim ?? CGPoint(x: R.midX, y: R.midY), box)
    let sdx = R.width / 4.133 * 0.7, sdy = R.height / 4.133 * 0.7
    var L = a
    for _ in 0..<1000 {
        let c = CGPoint(x: a.x + sdx * gauss(), y: a.y + sdy * gauss())
        if within(c, box) { L = c; break }
    }

    let D = dist(S, L)
    let ux = abs(L.x - S.x) / D, uy = abs(L.y - S.y) / D
    let W = min(ux > 1e-9 ? R.width / ux : .infinity, uy > 1e-9 ? R.height / uy : .infinity)
    let ID = log2(D / W + 1)
    let T = (21 + 225 * ID) * u * exp(0.15 * gauss())

    // Primary stroke: amplitude p·D; an overshoot must stay inside the window.
    var p = uniform(0.85, 1.05)
    var E1 = lerp(S, L, p)
    if let wb = WB, p > 1, !within(E1, wb) { p = uniform(0.9, 1.0); E1 = lerp(S, L, p) }
    // Velocity shape calibrated to the user's own cursor (verification/
    // user-mouse-baseline*.json, pointer acceleration 1.5 included): a short,
    // sharp burst — peak speed ~6x (150–400 pt) to ~10x (400–900 pt) the mean,
    // earlier the longer the move (peak at ~45% short, ~23% long) — followed
    // by a slow homing tail. A narrow kernel gives the burst; its tail is the
    // homing phase.
    let idN = min(1, max(0, (ID - 1.5) / 3.5))
    // Peak timing is a step too: ~46% up to ID ~3.8, ~17% from ID ~4.5.
    let early = min(1, max(0, (ID - 3.8) / 0.7))
    // The user's recorded habits scale it (their median peak / the 40% of the baseline this was fitted to).
    let peak = min(0.8, max(0.08, (0.46 - 0.29 * early) * gHabits.peakScale + uniform(-0.02, 0.02)))
    // Short moves are smooth (peak ~2x mean); from ID ~2.3 the user's moves
    // turn into a flick (peak ~10x mean) — a step, not a ramp, in their data.
    let flick = min(1, max(0, (ID - 2.3) / 0.9))
    let sigma = (0.30 - 0.12 * flick + 0.08 * early) * uniform(0.9, 1.1)
    let bow = dist(S, E1) * uniform(gHabits.bowLo, gHabits.bowHi) * (unit() < 0.5 ? -1 : 1)

    // Corrections. Zero only when the primary already ends in the inner 80%;
    // otherwise they continue until the pointer is there (the third lands on
    // L exactly), so the press is always inside the rect.
    let primaryInside = within(E1, box)
    var targets: [CGPoint] = []
    var cur = E1
    if !primaryInside {
        var i = 0
        while !within(cur, box) && i < 3 {
            i += 1
            let g = i == 1 ? uniform(0.9, 1.03) : i == 2 ? uniform(0.96, 1.01) : 1
            var next = lerp(cur, L, g)
            if let wb = WB, !within(next, wb) { next = L }
            targets.append(next); cur = next
        }
    } else {
        let pOpt = min(0.35, 0.06 * ID)
        while targets.count < 2 && unit() < (targets.isEmpty ? pOpt : pOpt / 3) {
            var next = lerp(cur, L, uniform(0.9, 1.03))
            if !within(next, box) { next = L }
            targets.append(next); cur = next
        }
    }

    // Budget: dwell first (the user's own arrival -> press pause, at most half
    // of T), the rest is movement. Corrections take 80–200 ms each and the
    // primary the remainder, but at least 60% of the movement; when both do
    // not fit, they shrink together. Only the minimum stroke length (4
    // samples) can push the total past T.
    let dwell = min(sampleDwell(), max(4, 0.5 * T))
    let budget = max(1, T - dwell)
    var corrMs = targets.map { _ in uniform(80, 200) }
    let corrSum = corrMs.reduce(0, +)
    var primaryMs = max(budget - corrSum, 0.6 * budget)
    let moving = primaryMs + corrSum
    if moving > budget {
        let minStroke = 4 * rate
        let kMin = max(minStroke / primaryMs, corrMs.map { minStroke / $0 }.max() ?? 0)
        let k = max(budget / moving, kMin)
        primaryMs *= k
        corrMs = corrMs.map { $0 * k }
    }

    var strokes = [Stroke(from: S, to: E1, ms: primaryMs, primary: true,
                          mu: log(peak) + sigma * sigma, sigma: sigma, bow: bow)]
    var from = E1
    for (i, t) in targets.enumerated() {
        strokes.append(Stroke(from: from, to: t, ms: corrMs[i], primary: false, mu: 0, sigma: 1, bow: 0))
        from = t
    }
    return MovePlan(start: S, landing: from, D: D, W: W, ID: ID, T: T, strokes: strokes,
                    dwell: dwell, primaryEnd: E1, primaryInside: primaryInside)
}

/// Stats of one plan for `cgevent model`; `withPoints` adds the reported
/// points as [t, x, y] and the start / primary end, for independent checks.
func planStats(_ p: MovePlan, rect: CGRect, rate: Double, withPoints: Bool = false) -> [String: Any] {
    let pts = p.samples(rate: rate)
    var maxStep = 0.0, prev = p.start
    for (_, q) in pts { maxStep = max(maxStep, dist(prev, q)); prev = q }

    // Peak speed (pt/ms) of the continuous path, sampled finely within each stroke.
    var peakSpeed = 0.0
    for s in p.strokes where s.ms > 0 {
        let n = max(200, Int(s.ms / 0.05))
        var a = s.at(0)
        for i in 1...n {
            let b = s.at(Double(i) / Double(n))
            peakSpeed = max(peakSpeed, dist(a, b) / (s.ms / Double(n)))
            a = b
        }
    }

    // Time of the fastest reported step within the primary, as a fraction of it;
    // and the largest perpendicular deviation from the primary's chord.
    var peakFrac = 0.0, best = -1.0, maxPerp = 0.0
    var last = (0.0, p.start)
    let chord = dist(p.start, p.primaryEnd)
    for (t, q) in pts where t <= p.primaryMs + 1e-9 {
        let v = dist(last.1, q) / max(1e-9, t - last.0)
        if v > best { best = v; peakFrac = (t - (t - last.0) / 2) / p.primaryMs }
        if chord > 0 {
            let cx = (p.primaryEnd.x - p.start.x) / chord, cy = (p.primaryEnd.y - p.start.y) / chord
            maxPerp = max(maxPerp, abs((q.x - p.start.x) * cy - (q.y - p.start.y) * cx))
        }
        last = (t, q)
    }
    var out: [String: Any] = [
        "skippedMove": p.skipped, "D": r2(p.D), "W": r2(p.W), "ID": (p.ID * 1000).rounded() / 1000,
        "T": r2(p.T), "primary": r2(p.primaryMs), "corrections": p.correctionMs.map(r2), "dwell": r2(p.dwell),
        "total": r2(p.moveMs + p.dwell), "submovements": p.strokes.count,
        "peakFrac": (peakFrac * 1000).rounded() / 1000, "maxPerp": r2(maxPerp),
        "maxPerpFrac": p.D > 0 ? (maxPerp / p.D * 1000).rounded() / 1000 : 0,
        "maxStep": r2(maxStep), "peakSpeed": (peakSpeed * 1000).rounded() / 1000,
        "landed": ["x": r2(p.landing.x), "y": r2(p.landing.y)],
        "inside": within(p.landing, rect), "insideInner80": within(p.landing, inner80(rect)),
        "primaryInside": p.primaryInside, "points": pts.count,
    ]
    if withPoints {
        out["start"] = [r2(p.start.x), r2(p.start.y)]
        out["primaryEnd"] = [r2(p.primaryEnd.x), r2(p.primaryEnd.y)]
        out["pts"] = pts.map { [r2($0.0), r2($0.1.x), r2($0.1.y)] }
    }
    return out
}

func parseNums(_ s: String) -> [Double] { s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) } }

// MARK: - takeover veil (docs/overlay-design/design.md, direction A "Aurora Spotlight")
//
// One borderless window per screen above everything (level .screenSaver, ignores the mouse,
// non-opaque): frost (NSVisualEffectView) with a clear hole over the agent's Chrome window, an
// aurora ring drawn entirely OUTSIDE that window's edge, and the text in the frost (or in a
// frosted capsule when Chrome fills its screen). Everything that moves is Core Animation on
// layers drawn once: the ring's colours turn by rotating a conic-gradient image under a static 9-slice
// mask, the halo is moved with every posted pointer move; nothing is redrawn per frame.
// Built hidden by `prime`, shown by `hold`, faded out by the release.

/// A Chrome window's corner radius on this macOS (measured 2026-10-05 on a 2x capture: 15-17 pt).
let VEIL_RADIUS: CGFloat = 16
/// Room around the window for the ring (2-3 pt) and its glow (Gaussian, sigma 8 pt).
let VEIL_MARGIN: CGFloat = 30
let VEIL_ENTRY = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
let VEIL_EXIT = CAMediaTimingFunction(controlPoints: 0, 0, 0.2, 1)
let VEIL_RIPPLE = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
let VEIL_INOUT = CAMediaTimingFunction(name: .easeInEaseOut)
let VEIL_OUT = CAMediaTimingFunction(name: .easeOut)
let VEIL_LINEAR = CAMediaTimingFunction(name: .linear)

func srgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

struct VeilTheme {
    let dark: Bool
    let contrast: Bool       // Increase Contrast: solid title, 3 pt ring
    var ring: [CGColor] { (dark ? [0x5E9BFF, 0xA27BFF, 0xFF6FB5, 0xFFB066] : [0x3B7BFF, 0x8B5CF6, 0xEC4899, 0xF97316]).map { srgb($0) } }
    var title: [CGColor] { (dark ? [0x8DB2FF, 0xB79CFF, 0xFF8CCB, 0xFFB27A] : [0x2B5CE6, 0x6E3BEB, 0xC2257E, 0xC2410C]).map { srgb($0) } }
    var titleGlow: CGColor { dark ? srgb(0x000000, 0.45) : srgb(0xFFFFFF, 0.55) }
    var label: CGColor { dark ? srgb(0xFFFFFF) : srgb(0x000000) }
    var text: CGColor { dark ? srgb(0xF5F5F7) : srgb(0x1D1D1F) }
    var halo: CGColor { dark ? srgb(0xA27BFF) : srgb(0x8B5CF6) }
    var haloFill: CGColor { dark ? srgb(0xA27BFF, 0.16) : srgb(0x8B5CF6, 0.12) }
    var neutral: CGColor { dark ? srgb(0xFFFFFF, 0.9) : srgb(0x1D1D1F, 0.9) }
    var tint: CGColor { dark ? srgb(0x000000, 0.22) : srgb(0xFFFFFF, 0.30) }
    var glowPeak: CGFloat { dark ? 0.85 : 0.60 }
    var ringWidth: CGFloat { contrast ? 3 : 2 }
    var accent: CGColor { ring[0] }
    var dotOn: CGColor { ring[1] }
    var dotOff: CGColor { text.copy(alpha: 0.25) ?? text }
}

struct VeilCopy {
    let zh: Bool
    /// CHROME_BRIDGE_LANG=en|zh overrides the system language (recording the English promo on a Chinese Mac).
    static var system: VeilCopy {
        if let l = ProcessInfo.processInfo.environment["CHROME_BRIDGE_LANG"], !l.isEmpty { return VeilCopy(zh: l.hasPrefix("zh")) }
        return VeilCopy(zh: (Locale.preferredLanguages.first ?? "").hasPrefix("zh"))
    }
    var title: String { zh ? "AI 正在操作电脑" : "AI is using your computer" }
    /// The cancel hint, split around its Esc keycap.
    var hint: (String, String) { zh ? ("连按两次", "停止操作") : ("Press", "twice to stop") }
    var again: (String, String) { zh ? ("再按一次", "停止") : ("Press", "again to stop") }
}

struct VeilOptions {
    var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    var increaseContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
    /// Record when this veil ended, so a takeover right after it skips the lock-in.
    var recordEnd = true
    var forceContinuous = false
    /// veildemo --slow N: every motion N times slower (layer speed and the veil's own timers), so
    /// still captures can resolve it. 1 everywhere else.
    var timeScale = 1.0
}

/// When the last veil ended (epoch ms), next to the input lock: every action is a new helper.
func veilStampPath() -> String {
    if let lock = ProcessInfo.processInfo.environment["CHROME_BRIDGE_LOCK"], !lock.isEmpty {
        return ((lock as NSString).deletingLastPathComponent as NSString).appendingPathComponent("veil-ended")
    }
    return NSHomeDirectory() + "/Library/Caches/chrome-bridge-mcp/veil-ended"
}

struct VeilImage {
    let image: CGImage
    let size: CGSize        // points
}

/// Draw once into a bitmap at `scale` (user space in points, origin bottom-left).
func veilRender(_ size: CGSize, _ scale: CGFloat, _ draw: (CGContext) -> Void) -> VeilImage? {
    let w = max(1, Int((size.width * scale).rounded(.up))), h = max(1, Int((size.height * scale).rounded(.up)))
    guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.scaleBy(x: scale, y: scale)
    ctx.textMatrix = .identity
    draw(ctx)
    guard let img = ctx.makeImage() else { return nil }
    return VeilImage(image: img, size: CGSize(width: CGFloat(w) / scale, height: CGFloat(h) / scale))
}

/// One line of text (CoreText), optionally middle-truncated to a width.
struct VeilLine {
    let line: CTLine
    let width: CGFloat, ascent: CGFloat, descent: CGFloat
    var height: CGFloat { ascent + descent }

    init(_ s: String, _ font: NSFont, _ color: CGColor, maxWidth: CGFloat? = nil) {
        let attrs: [NSAttributedString.Key: Any] = [.font: font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color]
        var l = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
        if let m = maxWidth, CTLineGetTypographicBounds(l, nil, nil, nil) > Double(m) {
            let token = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: attrs))
            if let t = CTLineCreateTruncatedLine(l, Double(m), .middle, token) { l = t }
        }
        var a: CGFloat = 0, d: CGFloat = 0
        width = CGFloat(CTLineGetTypographicBounds(l, &a, &d, nil))
        ascent = a
        descent = d
        line = l
    }

    func draw(_ ctx: CGContext, x: CGFloat, baseline: CGFloat) {
        ctx.textPosition = CGPoint(x: x, y: baseline)
        CTLineDraw(line, ctx)
    }
}

func veilSymbol(_ name: String, _ size: CGFloat, _ color: CGColor) -> NSImage? {
    guard let img = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
    let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: .medium)
        .applying(NSImage.SymbolConfiguration(paletteColors: [NSColor(cgColor: color) ?? .white]))
    return img.withSymbolConfiguration(cfg)
}

func veilTitleFont(_ zh: Bool, _ size: CGFloat) -> NSFont {
    if zh, let f = NSFont(name: "PingFangSC-Semibold", size: size) { return f }
    let base = NSFont.systemFont(ofSize: size, weight: .bold)
    if let d = base.fontDescriptor.withDesign(.rounded), let f = NSFont(descriptor: d, size: size) { return f }
    return base
}

func veilRounded(_ r: CGRect, _ radius: CGFloat) -> CGPath {
    let k = max(0, min(radius, r.width / 2 - 0.01, r.height / 2 - 0.01))
    return CGPath(roundedRect: r, cornerWidth: k, cornerHeight: k, transform: nil)
}

/// Animate `key` from its on-screen value (or `from`) to `to`; the model value becomes `to`
/// with implicit actions off, so nothing else animates.
func veilAnimate(_ layer: CALayer, _ key: String, to: Any, from: Any? = nil, _ dur: CFTimeInterval,
                 _ timing: CAMediaTimingFunction, delay: CFTimeInterval = 0) {
    let a = CABasicAnimation(keyPath: key)
    a.fromValue = from ?? layer.presentation()?.value(forKeyPath: key) ?? layer.value(forKeyPath: key)
    a.toValue = to
    a.duration = dur
    a.timingFunction = timing
    if delay > 0 {
        a.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) + delay
        a.fillMode = .backwards
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.setValue(to, forKeyPath: key)
    CATransaction.commit()
    layer.add(a, forKey: key)
}

/// Everything that can be drawn before the target is known, once per backing scale.
struct VeilAssets {
    static let hintHeight: CGFloat = 22
    let scale: CGFloat
    var title: VeilImage?, titleText = CGSize.zero            // the text block's title
    var titleSmall: VeilImage?, titleSmallText = CGSize.zero  // the capsule's
    var hint: VeilImage?, hintKeyX: CGFloat = 0
    var again: VeilImage?, againKeyX: CGFloat = 0
    var keyOutline: VeilImage?, keyFilled: VeilImage?
    var ring: VeilImage?
    var halo: VeilImage?
    var conic: CGImage?

    init(scale: CGFloat, theme: VeilTheme, copy: VeilCopy) {
        self.scale = scale
        let t = VeilAssets.titleImage(copy, theme, copy.zh ? 30 : 32, scale)
        title = t.0
        titleText = t.1
        let s = VeilAssets.titleImage(copy, theme, copy.zh ? 19 : 20, scale)
        titleSmall = s.0
        titleSmallText = s.1
        keyOutline = VeilAssets.keycap(false, theme, scale)
        keyFilled = VeilAssets.keycap(true, theme, scale)
        let kw = keyOutline?.size.width ?? 36
        let h = VeilAssets.row(copy.hint, symbols: false, keyWidth: kw, theme, scale)
        hint = h.0
        hintKeyX = h.1
        let a = VeilAssets.row(copy.again, symbols: false, keyWidth: kw, theme, scale)
        again = a.0
        againKeyX = a.1
        ring = VeilAssets.ringMask(theme, scale)
        halo = VeilAssets.haloImage(theme, scale)
        conic = VeilAssets.conicImage(theme)
    }

    /// The four aurora colours around a full turn (angle 0 at the top, clockwise), closing on the first.
    static func conicImage(_ theme: VeilTheme) -> CGImage? {
        let n = 256
        let stops: [[CGFloat]] = (theme.ring + [theme.ring[0]]).map { c in
            let cc = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil) ?? c
            return Array((cc.components ?? [0, 0, 0, 1]).prefix(3))
        }
        var px = [UInt8](repeating: 255, count: n * n * 4)
        for y in 0..<n {
            for x in 0..<n {
                let dx = Double(x) + 0.5 - Double(n) / 2, dy = Double(n) / 2 - (Double(y) + 0.5)
                var t = atan2(dx, dy) / (2 * Double.pi)        // 0 at the top, clockwise
                if t < 0 { t += 1 }
                let f = t * 4, i = min(3, Int(f)), u = CGFloat(f - Double(i))
                let o = (y * n + x) * 4
                for k in 0..<3 { px[o + k] = UInt8(max(0, min(255, (stops[i][k] * (1 - u) + stops[i + 1][k] * u) * 255 + 0.5))) }
            }
        }
        guard let provider = CGDataProvider(data: Data(px) as CFData) else { return nil }
        return CGImage(width: n, height: n, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: n * 4,
                       space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    /// Four-colour gradient glyphs with a soft glow, no plate (solid label colour under Increase Contrast).
    static func titleImage(_ copy: VeilCopy, _ theme: VeilTheme, _ size: CGFloat, _ scale: CGFloat) -> (VeilImage?, CGSize) {
        let t = VeilLine(copy.title, veilTitleFont(copy.zh, size), theme.contrast ? theme.label : srgb(0x000000))
        let pad: CGFloat = 14
        let text = CGSize(width: ceil(t.width), height: ceil(t.height))
        let img = veilRender(CGSize(width: text.width + 2 * pad, height: text.height + 2 * pad), scale) { ctx in
            let base = pad + t.descent
            // The glow alone: the glyphs are drawn far to the left and only their shadow lands here
            // (shadow offset and blur are in device pixels).
            ctx.saveGState()
            let far: CGFloat = 4000
            ctx.setShadow(offset: CGSize(width: far * scale, height: 0), blur: 10 * scale, color: theme.titleGlow)
            t.draw(ctx, x: pad - far, baseline: base)
            ctx.restoreGState()
            if theme.contrast { t.draw(ctx, x: pad, baseline: base); return }
            ctx.saveGState()
            ctx.setTextDrawingMode(.clip)
            t.draw(ctx, x: pad, baseline: base)
            if let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: theme.title as CFArray,
                                  locations: [0, 0.35, 0.68, 1]) {
                ctx.drawLinearGradient(g, start: CGPoint(x: pad, y: 0), end: CGPoint(x: pad + t.width, y: 0), options: [])
            }
            ctx.restoreGState()
        }
        return (img, text)
    }

    static func keycap(_ filled: Bool, _ theme: VeilTheme, _ scale: CGFloat) -> VeilImage? {
        let t = VeilLine("Esc", NSFont.systemFont(ofSize: 11.5, weight: .semibold), filled ? srgb(0xFFFFFF) : theme.text)
        let cap = CGRect(x: 1, y: 1, width: ceil(t.width) + 12, height: 18)
        return veilRender(CGSize(width: cap.width + 2, height: cap.height + 2), scale) { ctx in
            ctx.addPath(veilRounded(cap.insetBy(dx: 0.5, dy: 0.5), 5))
            if filled {
                ctx.setFillColor(theme.accent)
                ctx.fillPath()
            } else {
                ctx.setStrokeColor(theme.text)
                ctx.setLineWidth(1)
                ctx.strokePath()
            }
            t.draw(ctx, x: cap.midX - t.width / 2, baseline: cap.midY - (t.ascent - t.descent) / 2)
        }
    }

    /// "<left> [keycap gap] <right> [mouse ↔]", and where the keycap's centre goes.
    static func row(_ parts: (String, String), symbols: Bool, keyWidth: CGFloat, _ theme: VeilTheme,
                    _ scale: CGFloat) -> (VeilImage?, CGFloat) {
        let font = NSFont.systemFont(ofSize: 15, weight: .medium)
        let t1 = VeilLine(parts.0, font, theme.text), t2 = VeilLine(parts.1, font, theme.text)
        let h = hintHeight
        let mouse = symbols ? veilSymbol("computermouse", 13, theme.text) : nil
        let arrows = symbols ? veilSymbol("arrow.left.and.right", 11, theme.text) : nil
        var x: CGFloat = 0
        let x1 = x
        x += ceil(t1.width) + 5
        let keyX = x + keyWidth / 2
        x += keyWidth + 5
        let x2 = x
        x += ceil(t2.width)
        var mx: CGFloat = 0, ax: CGFloat = 0
        if let m = mouse, let a = arrows {
            x += 8
            mx = x
            x += m.size.width + 2
            ax = x
            x += a.size.width
        }
        let base = (h - t1.height) / 2 + t1.descent
        let img = veilRender(CGSize(width: ceil(x), height: h), scale) { ctx in
            t1.draw(ctx, x: x1, baseline: base)
            t2.draw(ctx, x: x2, baseline: base)
            if let m = mouse, let a = arrows {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
                m.draw(in: NSRect(x: mx, y: (h - m.size.height) / 2, width: m.size.width, height: m.size.height))
                a.draw(in: NSRect(x: ax, y: (h - a.size.height) / 2, width: a.size.width, height: a.size.height))
                NSGraphicsContext.restoreGraphicsState()
            }
        }
        return (img, keyX)
    }

    /// 9-slice alpha mask of a window corner of VEIL_RADIUS: the ring (full alpha) hugging the
    /// outside of the edge, its glow falling off outward (Gaussian, sigma 8 pt), nothing inside.
    static func ringMask(_ theme: VeilTheme, _ scale: CGFloat) -> VeilImage? {
        let G = VEIL_MARGIN, R = VEIL_RADIUS, S = 2 * (G + R) + 1
        let win = CGRect(x: G, y: G, width: 2 * R + 1, height: 2 * R + 1)
        let w = theme.ringWidth
        func rr(_ d: CGFloat) -> CGPath { veilRounded(win.insetBy(dx: -d, dy: -d), R + d) }
        return veilRender(CGSize(width: S, height: S), scale) { ctx in
            // Outside in, each step overwriting the inside of the last: alpha by distance.
            ctx.setBlendMode(.copy)
            var d = G - 1
            while d > w {
                let x = d - w
                ctx.addPath(rr(d))
                ctx.setFillColor(CGColor(gray: 0, alpha: theme.glowPeak * exp(-(x * x) / (2 * 8 * 8))))
                ctx.fillPath()
                d -= 0.5
            }
            ctx.addPath(rr(w))
            ctx.setFillColor(CGColor(gray: 0, alpha: 1))
            ctx.fillPath()
            ctx.addPath(rr(0))
            ctx.setFillColor(CGColor(gray: 0, alpha: 0))
            ctx.fillPath()
        }
    }

    /// 34 pt ring, 2 pt stroke, light fill, 6 pt outer glow.
    static func haloImage(_ theme: VeilTheme, _ scale: CGFloat) -> VeilImage? {
        let d: CGFloat = 34, pad: CGFloat = 10
        return veilRender(CGSize(width: d + 2 * pad, height: d + 2 * pad), scale) { ctx in
            let c = CGRect(x: pad + 1, y: pad + 1, width: d - 2, height: d - 2)
            ctx.setFillColor(theme.haloFill)
            ctx.fillEllipse(in: c)
            ctx.saveGState()
            ctx.setShadow(offset: .zero, blur: 6 * scale, color: theme.halo)
            ctx.setStrokeColor(theme.halo)
            ctx.setLineWidth(2)
            ctx.strokeEllipse(in: c)
            ctx.restoreGState()
        }
    }
}

/// The cancel hint: "press Esc twice · or shake the mouse", its first-Esc variant, the shake dots.
final class VeilHint {
    let layer = CALayer()           // scales and brightens on a nudge
    let normal = CALayer(), again = CALayer()
    let keyNormal = CALayer(), keyAgain = CALayer()
    let dotsBox = CALayer()
    var dots: [CALayer] = []
    let theme: VeilTheme
    let size: CGSize
    /// Width including the shake dots, which hang off the right of the normal row.
    var extent: CGFloat { max(size.width, dotsBox.frame.maxX + normal.frame.minX) }
    var isAgain = false
    var lit = 0

    init(_ a: VeilAssets, _ theme: VeilTheme) {
        self.theme = theme
        let h = VeilAssets.hintHeight
        let wn = a.hint?.size.width ?? 0, wa = a.again?.size.width ?? 0
        size = CGSize(width: max(wn, wa), height: h)
        layer.bounds = CGRect(origin: .zero, size: size)
        layer.opacity = 0.88
        func setup(_ row: CALayer, _ img: VeilImage?, _ key: CALayer, _ keyImg: VeilImage?, _ keyX: CGFloat) {
            let w = img?.size.width ?? 0
            row.contentsScale = a.scale
            row.contents = img?.image
            row.frame = CGRect(x: ((size.width - w) / 2 * a.scale).rounded() / a.scale, y: 0, width: w, height: h)
            key.contentsScale = a.scale
            key.contents = keyImg?.image
            let ks = keyImg?.size ?? .zero
            key.frame = CGRect(x: ((keyX - ks.width / 2) * a.scale).rounded() / a.scale, y: (h - ks.height) / 2,
                               width: ks.width, height: ks.height)
            row.addSublayer(key)
            layer.addSublayer(row)
        }
        setup(normal, a.hint, keyNormal, a.keyOutline, a.hintKeyX)
        setup(again, a.again, keyAgain, a.keyFilled, a.againKeyX)
        again.opacity = 0
        dotsBox.frame = CGRect(x: wn + 8, y: (h - 6) / 2, width: 36, height: 6)
        dotsBox.opacity = 0
        for i in 0..<4 {
            let d = CALayer()
            d.frame = CGRect(x: CGFloat(i) * 10, y: 0, width: 6, height: 6)
            d.cornerRadius = 3
            d.backgroundColor = theme.dotOff
            dotsBox.addSublayer(d)
            dots.append(d)
        }
        normal.addSublayer(dotsBox)
    }

    /// Held input: a small spring nudge (k 700, c 22, peak 1.05) and a brief brightening.
    func nudge(_ reduceMotion: Bool) {
        if !reduceMotion {
            let s = CAKeyframeAnimation(keyPath: "transform.scale")
            s.values = (0...90).map { i -> Double in
                let t = Double(i) * 0.005
                return 1 + 0.05 * exp(-11 * t) * sin(24.05 * t) / 0.54
            }
            s.duration = 0.45
            layer.add(s, forKey: "nudge")
        }
        let o = CAKeyframeAnimation(keyPath: "opacity")
        o.values = [0.88, 1, 1, 0.88]
        o.keyTimes = [0, 0.12, 0.55, 1]
        o.duration = 0.45
        layer.add(o, forKey: "bright")
    }

    /// First Esc: the filled keycap and "press Esc again" (crossfade 120 ms); off again after 800 ms.
    func setAgain(_ on: Bool) {
        guard on != isAgain else { return }
        isAgain = on
        veilAnimate(normal, "opacity", to: on ? 0 : 1, 0.12, VEIL_INOUT)
        veilAnimate(again, "opacity", to: on ? 1 : 0, 0.12, VEIL_INOUT)
    }

    func pressAgain(_ reduceMotion: Bool) {
        setAgain(true)
        if reduceMotion { return }
        let a = CABasicAnimation(keyPath: "transform.scale")
        a.fromValue = 1.12
        a.toValue = 1
        a.duration = 0.15
        a.timingFunction = VEIL_OUT
        keyAgain.add(a, forKey: "press")
    }

    /// One dot per direction reversal of a shake; 0 clears them.
    func setDots(_ n: Int) {
        let n = max(0, min(4, n))
        if n == lit { return }
        if (n > 0) != (lit > 0) { veilAnimate(dotsBox, "opacity", to: n > 0 ? 1 : 0, n > 0 ? 0.08 : 0.12, VEIL_OUT) }
        for (i, d) in dots.enumerated() where (i < n) != (i < lit) {
            veilAnimate(d, "backgroundColor", to: i < n ? theme.dotOn : theme.dotOff, 0.08, VEIL_OUT)
        }
        lit = n
    }
}

// MARK: - progress panel (docs/discussion-round4/summary.md)
//
// What the agent is doing, as a checklist driven by the session's own ops (no LLM involved): each
// stage goes from a red dot to a turning ring to a green check; a bar and "about N s" come from the
// movement plan and the characters left; ↑/↓ change the pace (0.5×–3×). Who (client · project) and
// the agent's optional task and "step i/n" arrive with `hold`'s veil (src/index.js panelFor).

/// ↑/↓ during a takeover step through these; 1 is the movement model's own timing.
let PANEL_SPEEDS: [Double] = [0.5, 0.75, 1, 1.5, 2, 3]
/// Key by key at 1×: about 95 ms down + 160 ms flight per character (the lognormals in strike/opType);
/// with the user's recorded habits, scaled to their own down + flight.
var PANEL_MS_PER_CHAR: Double { gHabits.msPerChar }

func panelSpeedPath() -> String {
    ((veilStampPath() as NSString).deletingLastPathComponent as NSString).appendingPathComponent("speed")
}

func panelSpeedSettingsPath() -> String {
    if let raw = ProcessInfo.processInfo.environment["CHROME_BRIDGE_SETTINGS"], !raw.isEmpty {
        return (raw as NSString).expandingTildeInPath
    }
    return (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/chrome-bridge-mcp/settings.json")
}

func panelSpeedFromEnvironment() -> Double? {
    guard let raw = ProcessInfo.processInfo.environment["CHROME_BRIDGE_INPUT_SPEED"]?.trimmingCharacters(in: .whitespacesAndNewlines),
          raw.range(of: "^\\d+(\\.\\d+)?$", options: .regularExpression) != nil,
          let speed = Double(raw), PANEL_SPEEDS.contains(speed) else { return nil }
    return speed
}

/// Explicit environment > user preference. Dry runs only read an explicitly
/// isolated settings path; neither they nor tests inspect the user's defaults.
func configuredPanelSpeed(dry: Bool) -> Double? {
    if let speed = panelSpeedFromEnvironment() { return speed }
    if dry && ProcessInfo.processInfo.environment["CHROME_BRIDGE_SETTINGS"]?.isEmpty != false { return nil }
    guard let data = FileManager.default.contents(atPath: panelSpeedSettingsPath()),
          let values = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let number = values["inputSpeed"] as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(), PANEL_SPEEDS.contains(number.doubleValue) else { return nil }
    return number.doubleValue
}

/// Shared with settings.js and the other native writer. The symlink is created
/// atomically with a complete PID/token; only a proven dead owner is reclaimed.
func withSettingsWriteLock(_ file: String, _ write: () -> Bool) -> Bool {
    let lockPath = file + ".write-lock", recovery = file + ".write-recovery"
    let token = "\(getpid()):\(UUID().uuidString)"
    let readOwner = { () -> String? in try? FileManager.default.destinationOfSymbolicLink(atPath: lockPath) }
    let dead = { (value: String?) -> Bool in
        guard let value = value, value.range(of: "^\\d+:[0-9a-fA-F-]{36}$", options: .regularExpression) != nil,
              let pid = Int32(value.split(separator: ":")[0]), pid > 0 else { return false }
        return kill(pid, 0) != 0 && errno == ESRCH
    }
    let deadline = Date().timeIntervalSince1970 + 0.5
    while true {
        if symlink(token, lockPath) == 0 { break }
        if errno != EEXIST { return false }
        if dead(readOwner()), mkdir(recovery, 0o700) == 0 {
            // Serialize cleaners, then re-read: never unlink a new live owner.
            // A crashed recovery gate is deliberately not removed by age.
            if dead(readOwner()) { _ = unlink(lockPath) }
            _ = rmdir(recovery)
        }
        if Date().timeIntervalSince1970 >= deadline { return false }
        usleep(5_000)
    }
    defer { if readOwner() == token { _ = unlink(lockPath) } }
    return write()
}

@discardableResult
func writeSettingsObject(_ file: String, _ patch: [String: Any]) -> Bool {
    do { try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true) }
    catch { return false }
    return withSettingsWriteLock(file) {
        var values: [String: Any] = [:]
        if (try? FileManager.default.attributesOfItem(atPath: file)) != nil {
            guard let data = FileManager.default.contents(atPath: file),
                  let current = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
            values = current
        }
        for (key, value) in patch { values[key] = value }
        values["version"] = 1
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { return false }
        do { try data.write(to: URL(fileURLWithPath: file), options: .atomic); return true }
        catch { return false }
    }
}

/// Serial off-main persistence: lock contention must never stall the input tap.
let panelSpeedSaveQueue = DispatchQueue(label: "work.mychrome.input-speed-save", qos: .utility)

@discardableResult
func savePanelSpeed(_ s: Double) -> Bool {
    guard PANEL_SPEEDS.contains(s), panelSpeedFromEnvironment() == nil else { return false }
    guard writeSettingsObject(panelSpeedSettingsPath(), ["inputSpeed": s]) else { return false }
    // Older helpers can still consume the short-lived cache during an upgrade.
    let path = panelSpeedPath()
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    let o: [String: Any] = ["speed": s, "at": (Date().timeIntervalSince1970 * 1000).rounded()]
    if let d = try? JSONSerialization.data(withJSONObject: o) { try? d.write(to: URL(fileURLWithPath: path), options: .atomic) }
    return true
}

/// One step up (+1) or down (-1) from `s`, held at the ends.
func panelSpeedStep(_ s: Double, _ dir: Int) -> Double {
    let i = PANEL_SPEEDS.firstIndex(where: { $0 >= s - 0.001 }) ?? 2
    return PANEL_SPEEDS[max(0, min(PANEL_SPEEDS.count - 1, i + dir))]
}

func panelSpeedText(_ s: Double) -> String {
    s == s.rounded() ? "\(Int(s))×" : String(format: s * 100 == (s * 10).rounded() * 10 ? "%.1f×" : "%.2f×", s)
}

/// "about N s" for `ms` left.
func panelEtaText(_ ms: Double, finished: Bool, failed: Bool, zh: Bool) -> String {
    if failed { return zh ? "已停止" : "Stopped" }
    if finished { return zh ? "完成" : "Done" }
    if ms < 1000 { return zh ? "马上完成" : "Almost done" }
    let n = Int((ms / 1000).rounded(.up))
    if n < 60 { return zh ? "约 \(n) 秒完成" : "About \(n) s left" }
    return zh ? "约 \(n / 60) 分 \(n % 60) 秒完成" : "About \(n / 60) min \(n % 60) s left"
}

/// A `label` that is a string, or {zh, en} picked by the system language.
func panelText(_ v: Any?, zh: Bool) -> String {
    if let s = v as? String { return s }
    if let m = v as? [String: Any] { return (m[zh ? "zh" : "en"] as? String) ?? (m["en"] as? String) ?? (m["zh"] as? String) ?? "" }
    return ""
}

enum PanelState: String { case pending, running, done, failed }

final class PanelStage {
    let key: String
    let label: String
    var est: Double          // ms at 1× for the whole stage
    let paced: Bool          // follows the ↑/↓ pace
    var state = PanelState.pending
    var spent = 0.0          // ms of the stage's own timeline gone (wall ms × pace)
    init(key: String, label: String, est: Double, paced: Bool) {
        self.key = key
        self.label = label
        self.est = est
        self.paced = paced
    }
}

/// The checklist's state: changed only by the session's ops (main thread), ↑/↓ and `panel` requests.
final class PanelModel {
    let who: String
    let whoColor: Int
    let task: String
    let step: String
    let action: String
    let stages: [PanelStage]
    let charsTotal: Int
    let showCount: Bool
    /// The agent's live notes (what it is about to do and why), oldest first, at most three.
    let notes: [String]
    /// Existing visible assistant messages, supplied by the host stream adapter.
    /// These never come from action arguments or inferred checklist completion.
    let feedMode: Bool
    var feedEntries: [String]
    var feedStatus: String
    let perChar: Bool         // the type stage goes key by key: time from the characters left
    var charsDone = 0
    var speed = 1.0
    var speedSaveState = "idle"
    /// Between two actions of a long job (index.js task hold): the agent is working out the next step.
    var waiting = false
    /// The other agents' tasks waiting for the mouse, first in line first (index.js lock queue).
    var queue: [String] = []
    var t0 = nowMs()
    var last = nowMs()
    var shownFraction = 0.0
    var onChange: (() -> Void)?

    init?(_ d: [String: Any], zh: Bool = VeilCopy.system.zh) {
        let st = (d["stages"] as? [[String: Any]] ?? []).compactMap { s -> PanelStage? in
            guard let k = s["key"] as? String else { return nil }
            let st = PanelStage(key: k, label: panelText(s["label"], zh: zh), est: max(0, (s["est"] as? NSNumber)?.doubleValue ?? 300),
                                paced: s["paced"] as? Bool ?? false)
            // A long job's plan arrives with each step's state (done / running / pending).
            if let v = s["state"] as? String, let ps = PanelState(rawValue: v) { st.state = ps }
            return st
        }
        feedMode = d["feedMode"] as? Bool ?? false
        guard !st.isEmpty || feedMode else { return nil }
        stages = st
        who = panelText(d["who"], zh: zh)
        whoColor = (d["color"] as? NSNumber)?.intValue ?? 0
        task = panelText(d["task"], zh: zh)
        step = d["step"] as? String ?? ""
        action = panelText(d["action"], zh: zh)
        charsTotal = max(0, (d["chars"] as? NSNumber)?.intValue ?? 0)
        notes = Array((d["notes"] as? [String] ?? []).suffix(3))
        feedEntries = Array((d["feedEntries"] as? [String] ?? []).suffix(16)).map { String($0.suffix(8000)) }
        feedStatus = d["feedStatus"] as? String ?? "unavailable"
        showCount = d["showCount"] as? Bool ?? true
        perChar = d["perChar"] as? Bool ?? false
        queue = (d["queue"] as? [Any] ?? []).map { panelText($0, zh: zh) }.filter { !$0.isEmpty }
        // A long job's plan: the bar counts from the job's start, not from this action's.
        if let e = (d["elapsedMs"] as? NSNumber)?.doubleValue, e > 0 { t0 = nowMs() - e }
    }

    var running: PanelStage? { stages.first { $0.state == .running } }
    var finished: Bool { !feedMode && stages.allSatisfy { $0.state == .done } }
    var failed: Bool { stages.contains { $0.state == .failed } }

    /// Account the running stage's time up to now, at the pace.
    func tick() {
        let now = nowMs()
        if let r = running { r.spent += (now - last) * (r.paced ? speed : 1) }
        last = now
    }

    func changed() { onChange?() }

    /// `key` is under way: every stage before it is done.
    func begin(_ key: String, est: Double? = nil) {
        guard !failed, let i = stages.firstIndex(where: { $0.key == key }) else { return }
        tick()
        waiting = false
        for s in stages[..<i] where s.state == .pending || s.state == .running { s.state = .done }
        let s = stages[i]
        if s.state != .running { s.state = .running; s.spent = 0 }
        if let e = est { s.est = e }
        changed()
    }

    /// `key` and everything before it are done; the stage after it is under way.
    func finish(_ key: String) {
        guard !failed, let i = stages.firstIndex(where: { $0.key == key }) else { return }
        tick()
        for s in stages[...i] where s.state != .done { s.state = .done }
        if i + 1 < stages.count, stages[i + 1].state == .pending { stages[i + 1].state = .running; stages[i + 1].spent = 0 }
        changed()
    }

    /// `key` did not happen (the field did not show the text, Return was not pressed): everything
    /// before it is done, it is failed, nothing after it turns green.
    func fail(_ key: String) {
        guard !failed, let i = stages.firstIndex(where: { $0.key == key }) else { fail(); return }
        tick()
        for s in stages[..<i] where s.state != .done { s.state = .done }
        stages[i].state = .failed
        changed()
    }

    /// The stage under way (or the next one) failed; nothing after it turns green.
    func fail() {
        guard !failed, !finished else { return }
        tick()
        if let r = running ?? stages.first(where: { $0.state == .pending }) { r.state = .failed }
        changed()
    }

    func allDone() {
        guard !failed else { return }
        tick()
        for s in stages { s.state = .done }
        changed()
    }

    func addChars(_ n: Int) {
        charsDone = charsTotal > 0 ? min(charsTotal, charsDone + n) : charsDone + n
        changed()
    }

    func setSpeed(_ s: Double) { tick(); speed = s; changed() }
    func setSpeedSaveState(_ state: String) { speedSaveState = state; changed() }

    func setWaiting() { tick(); waiting = true; changed() }

    /// Wall-clock ms left for `s` at the current pace.
    func left(_ s: PanelStage) -> Double {
        if s.state == .done || s.state == .failed { return 0 }
        let k = s.paced ? speed : 1
        if s.key == "type" && perChar && charsTotal > 0 {
            // Per character at 1×: measured once a few are in, else the model's average.
            let per = charsDone >= 4 && s.state == .running ? max(60, s.spent / Double(charsDone)) : PANEL_MS_PER_CHAR
            return Double(charsTotal - charsDone) * per / k
        }
        return max(0, s.est - (s.state == .running ? s.spent : 0)) / k
    }

    func etaMs() -> Double { tick(); return stages.reduce(0) { $0 + left($1) } }

    /// Elapsed / (elapsed + left): never goes back, 1 only once everything is done.
    func fraction() -> Double {
        if feedMode { return 0 }
        if finished { shownFraction = 1; return 1 }
        let el = nowMs() - t0
        shownFraction = max(shownFraction, min(0.97, el / max(1, el + etaMs())))
        return shownFraction
    }

    /// "23/54" on the typing row; never for a field that hides its length.
    func detail(_ s: PanelStage) -> String {
        guard s.key == "type", charsTotal > 0, showCount, s.state != .pending else { return "" }
        return "\(charsDone)/\(charsTotal)"
    }

    func json() -> [String: Any] {
        ["stages": stages.map { ["key": $0.key, "state": $0.state.rawValue, "detail": detail($0)] as [String: Any] },
         "speed": speed, "speedSaveState": speedSaveState, "etaMs": Int(etaMs().rounded()), "fraction": r2(fraction()), "chars": [charsDone, charsTotal],
         "who": who, "task": task, "step": step, "action": action, "waiting": waiting, "notes": notes, "queue": queue,
         "feedMode": feedMode, "feedCount": feedEntries.count, "feedStatus": feedStatus]
    }
}

/// The subline's image (also used by veilsnap, which has no screen).
func veilSubImage(_ label: String, _ size: CGFloat, _ maxWidth: CGFloat, _ theme: VeilTheme, _ scale: CGFloat) -> (VeilImage?, CGSize) {
    guard !label.isEmpty, maxWidth >= 24 else { return (nil, .zero) }
    let t = VeilLine(label, NSFont.systemFont(ofSize: size), theme.text.copy(alpha: 0.72) ?? theme.text, maxWidth: maxWidth)
    let pad: CGFloat = 2
    let text = CGSize(width: ceil(t.width), height: ceil(t.height))
    let img = veilRender(CGSize(width: text.width + 2 * pad, height: text.height + 2 * pad), scale) { ctx in
        t.draw(ctx, x: pad, baseline: pad + t.descent)
    }
    return (img, text)
}

/// The panel card: who · step, task, one row per stage, the bar, time left and pace.
/// Layers only; images are redrawn only when their text changes.
final class VeilPanel {
    static let width: CGFloat = 360
    static let pad: CGFloat = 16, rowH: CGFloat = 26, barH: CGFloat = 6
    let layer = CALayer()
    let theme: VeilTheme
    let zh: Bool
    let scale: CGFloat
    let reduceMotion: Bool
    let dot = CALayer(), name = CALayer(), stepL = CALayer(), taskL = CALayer()
    var noteLayers: [CALayer] = []
    var icons: [CALayer] = [], labels: [CALayer] = [], details: [CALayer] = []
    // fill: the done part (its width), clipping one gradient as wide as the track.
    let track = CALayer(), fill = CALayer(), grad = CAGradientLayer(), shimmer = CAGradientLayer()
    var barFailed = false
    let eta = CALayer(), pace = CALayer()
    var size = CGSize.zero
    var states: [PanelState?] = []
    var detailText: [String] = []
    var etaText = "", paceText = ""
    var fillW: CGFloat = -1
    var built: (String, String, String, [String], [String])?
    let iconImages: [PanelState: VeilImage]
    var trackW: CGFloat { VeilPanel.width - 2 * VeilPanel.pad }
    /// No plate of its own (inside the frosted card, which is the plate).
    var plain = false { didSet { layer.backgroundColor = plain ? nil : theme.text.copy(alpha: 0.05); layer.borderWidth = plain ? 0 : 1 } }

    /// Who colours: the aurora's four and two more, never the red or green of the checklist.
    static func whoColor(_ i: Int, _ dark: Bool) -> CGColor {
        let c: [UInt32] = dark ? [0x5E9BFF, 0xA27BFF, 0xFF6FB5, 0xFFB066, 0x4FD1C5, 0xF5D547]
                               : [0x3B7BFF, 0x8B5CF6, 0xEC4899, 0xF97316, 0x0D9488, 0xCA8A04]
        return srgb(c[((i % c.count) + c.count) % c.count])
    }
    static func red(_ dark: Bool) -> CGColor { dark ? srgb(0xFF453A) : srgb(0xFF3B30) }
    static func green(_ dark: Bool) -> CGColor { dark ? srgb(0x32D74B) : srgb(0x28B83C) }

    /// 16 pt status icons: a red dot (to do), a ring (under way, turned by an animation),
    /// a green check (done), a red cross (failed).
    static func iconSet(_ theme: VeilTheme, _ scale: CGFloat) -> [PanelState: VeilImage] {
        let box = CGSize(width: 16, height: 16), red = VeilPanel.red(theme.dark), green = VeilPanel.green(theme.dark)
        var out: [PanelState: VeilImage] = [:]
        out[.pending] = veilRender(box, scale) { ctx in
            ctx.setFillColor(red)
            ctx.fillEllipse(in: CGRect(x: 4, y: 4, width: 8, height: 8))
        }
        out[.running] = veilRender(box, scale) { ctx in
            ctx.setStrokeColor(theme.accent)
            ctx.setLineWidth(2)
            ctx.setLineCap(.round)
            ctx.addArc(center: CGPoint(x: 8, y: 8), radius: 6, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
            ctx.strokePath()
        }
        out[.done] = veilRender(box, scale) { ctx in
            ctx.setFillColor(green)
            ctx.fillEllipse(in: CGRect(x: 1, y: 1, width: 14, height: 14))
            ctx.setStrokeColor(srgb(0xFFFFFF))
            ctx.setLineWidth(1.8)
            ctx.setLineCap(.round)
            ctx.setLineJoin(.round)
            ctx.move(to: CGPoint(x: 4.6, y: 8.2))
            ctx.addLine(to: CGPoint(x: 7.0, y: 5.6))
            ctx.addLine(to: CGPoint(x: 11.4, y: 10.6))
            ctx.strokePath()
        }
        out[.failed] = veilRender(box, scale) { ctx in
            ctx.setFillColor(red)
            ctx.fillEllipse(in: CGRect(x: 1, y: 1, width: 14, height: 14))
            ctx.setStrokeColor(srgb(0xFFFFFF))
            ctx.setLineWidth(1.8)
            ctx.setLineCap(.round)
            ctx.move(to: CGPoint(x: 5.5, y: 5.5)); ctx.addLine(to: CGPoint(x: 10.5, y: 10.5))
            ctx.move(to: CGPoint(x: 5.5, y: 10.5)); ctx.addLine(to: CGPoint(x: 10.5, y: 5.5))
            ctx.strokePath()
        }
        return out
    }

    init(theme: VeilTheme, zh: Bool, scale: CGFloat, reduceMotion: Bool) {
        self.theme = theme
        self.zh = zh
        self.scale = scale
        self.reduceMotion = reduceMotion
        iconImages = VeilPanel.iconSet(theme, scale)
        layer.cornerRadius = 16
        layer.borderColor = theme.text.copy(alpha: 0.12)
        plain = false
        for l in [dot, name, stepL, taskL, track, eta, pace] { layer.addSublayer(l) }
        dot.cornerRadius = 4
        track.cornerRadius = VeilPanel.barH / 2
        track.backgroundColor = theme.text.copy(alpha: 0.12)
        track.masksToBounds = true
        grad.colors = theme.ring
        grad.startPoint = CGPoint(x: 0, y: 0.5)
        grad.endPoint = CGPoint(x: 1, y: 0.5)
        grad.anchorPoint = .zero
        fill.cornerRadius = VeilPanel.barH / 2
        fill.masksToBounds = true
        fill.anchorPoint = CGPoint(x: 0, y: 0.5)
        fill.addSublayer(grad)
        track.addSublayer(fill)
        // A light glint running along the filled part: "still working" between updates.
        shimmer.colors = [srgb(0xFFFFFF, 0), srgb(0xFFFFFF, theme.dark ? 0.45 : 0.6), srgb(0xFFFFFF, 0)]
        shimmer.startPoint = CGPoint(x: 0, y: 0.5)
        shimmer.endPoint = CGPoint(x: 1, y: 0.5)
        fill.addSublayer(shimmer)
    }

    func px(_ v: CGFloat) -> CGFloat { (v * scale).rounded() / scale }

    func textImage(_ s: String, _ size: CGFloat, _ weight: NSFont.Weight, _ color: CGColor,
                   maxWidth: CGFloat? = nil, mono: Bool = false) -> VeilImage? {
        guard !s.isEmpty else { return nil }
        let font = mono ? NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
        let t = VeilLine(s, font, color, maxWidth: maxWidth)
        return veilRender(CGSize(width: ceil(t.width) + 2, height: ceil(t.height) + 2), scale) { ctx in
            t.draw(ctx, x: 1, baseline: 1 + t.descent)
        }
    }

    /// Put `img` in `l` with its left (or right) edge at `x`, centred on `cy`.
    func place(_ l: CALayer, _ img: VeilImage?, x: CGFloat, cy: CGFloat, right: Bool = false) {
        l.contentsScale = scale
        l.contents = img?.image
        let s = img?.size ?? .zero
        l.frame = CGRect(x: px(right ? x - s.width : x), y: px(cy - s.height / 2), width: s.width, height: s.height)
    }

    func stepText(_ step: String) -> String {
        let p = step.split(separator: "/")
        guard p.count == 2, let i = Int(p[0]), let n = Int(p[1]), i >= 1, n >= i else { return "" }
        return zh ? "第 \(i)/\(n) 步" : "Step \(i) of \(n)"
    }

    /// Wrap the original messages and keep the newest text visible as the stream grows.
    /// The fixed viewport scrolls automatically; it has no completion ticks or invented ETA.
    func feedImage(_ text: String) -> VeilImage? {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 5
        paragraph.paragraphSpacing = 10
        let attributed = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor(cgColor: theme.text)!,
            .paragraphStyle: paragraph
        ])
        let setter = CTFramesetterCreateWithAttributedString(attributed)
        let width = VeilPanel.width - 2 * VeilPanel.pad
        let measured = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(), nil,
            CGSize(width: width, height: 100_000), nil)
        let fullHeight = max(24, ceil(measured.height) + 4)
        let height = min(280, fullHeight)
        return veilRender(CGSize(width: width, height: height), scale) { ctx in
            // Core Text lays the latest line at the bottom. The image clips older lines above.
            let path = CGPath(rect: CGRect(x: 0, y: 0, width: width, height: fullHeight), transform: nil)
            CTFrameDraw(CTFramesetterCreateFrame(setter, CFRange(), path, nil), ctx)
        }
    }

    func buildFeed(_ m: PanelModel) {
        let key = (m.who, m.task, m.feedStatus, m.feedEntries, m.queue + ["speed:" + m.speedSaveState])
        if let b = built, b.0 == key.0, b.1 == key.1, b.2 == key.2, b.3 == key.3, b.4 == key.4 { return }
        built = key
        for l in icons + labels + details + noteLayers { l.removeFromSuperlayer() }
        icons = []; labels = []; details = []; noteLayers = []
        states = []; detailText = []
        track.isHidden = true
        eta.isHidden = true
        pace.isHidden = true
        stepL.isHidden = true
        let empty = m.feedStatus == "connected"
            ? (zh ? "等待当前会话的可见进度…" : "Waiting for visible progress from this conversation…")
            : (zh ? "当前会话的进度流尚未连接" : "This conversation's progress stream is not connected")
        let body = feedImage(m.feedEntries.isEmpty ? empty : m.feedEntries.joined(separator: "\n\n"))
        let P = VeilPanel.pad, W = VeilPanel.width
        let hasTask = !m.task.isEmpty
        let stale = m.feedStatus != "connected" && !m.feedEntries.isEmpty
        let speedFailed = m.speedSaveState == "failed"
        let statusHeight: CGFloat = (stale ? 22 : 0) + (speedFailed ? 22 : 0)
        let H = 14 + 18 + (hasTask ? 28.0 : 0) + 14 + (body?.size.height ?? 24) + 16 + statusHeight
        size = CGSize(width: W, height: H)
        layer.bounds = CGRect(origin: .zero, size: size)
        let headY = H - 23
        dot.frame = CGRect(x: P, y: px(headY - 4), width: 8, height: 8)
        dot.backgroundColor = VeilPanel.whoColor(m.whoColor, theme.dark)
        place(name, textImage(m.who.isEmpty ? "AI" : m.who, 13, .semibold, theme.text,
              maxWidth: W - 2 * P - 14), x: P + 14, cy: headY)
        taskL.isHidden = !hasTask
        if hasTask {
            place(taskL, textImage(m.task, 16, .semibold, theme.text, maxWidth: W - 2 * P),
                  x: P, cy: H - 49)
        }
        let content = CALayer()
        place(content, body, x: P, cy: 16 + statusHeight + (body?.size.height ?? 24) / 2)
        layer.addSublayer(content)
        noteLayers.append(content)
        if stale {
            let status = CALayer()
            place(status, textImage(zh ? "进度流已断开 · 上方为最后收到的消息" : "Stream disconnected · last received messages",
                  11, .medium, theme.accent, maxWidth: W - 2 * P), x: P, cy: 22)
            layer.addSublayer(status)
            noteLayers.append(status)
        }
        if speedFailed {
            let status = CALayer()
            place(status, textImage(zh ? "操作速度未保存，已恢复原设置" : "Speed was not saved; previous setting restored",
                  11, .medium, VeilPanel.red(theme.dark), maxWidth: W - 2 * P), x: P, cy: 22 + (stale ? 22 : 0))
            layer.addSublayer(status)
            noteLayers.append(status)
        }
    }

    /// Rows and fixed texts for `m` (again only when they differ from what is built).
    func build(_ m: PanelModel) {
        if m.feedMode { buildFeed(m); return }
        track.isHidden = false
        eta.isHidden = false
        pace.isHidden = false
        stepL.isHidden = false
        let key = (m.who, m.task, m.step, m.stages.map { $0.label }, m.notes + ["\u{1}"] + m.queue)
        if let b = built, b.0 == key.0, b.1 == key.1, b.2 == key.2, b.3 == key.3, b.4 == key.4 { return }
        built = key
        for l in icons + labels + details + noteLayers { l.removeFromSuperlayer() }
        icons = []; labels = []; details = []; noteLayers = []
        let P = VeilPanel.pad, W = VeilPanel.width, rowH = VeilPanel.rowH
        let hasTask = !m.task.isEmpty
        let noteH: CGFloat = m.notes.isEmpty ? 0 : 8 + 20 * CGFloat(m.notes.count) + 4
        let queueH: CGFloat = m.queue.isEmpty ? 0 : 8 + 18 + 18
        let H = 14 + 18 + (hasTask ? 28 : 0) + queueH + noteH + 10 + rowH * CGFloat(m.stages.count) + 10 + VeilPanel.barH + 8 + 16 + 14
        size = CGSize(width: W, height: H)
        layer.bounds = CGRect(origin: .zero, size: size)
        var top: CGFloat = 14
        let headY = H - top - 9
        dot.frame = CGRect(x: P, y: px(headY - 4), width: 8, height: 8)
        dot.backgroundColor = VeilPanel.whoColor(m.whoColor, theme.dark)
        let st = textImage(stepText(m.step), 13, .medium, theme.text.copy(alpha: 0.6) ?? theme.text, mono: true)
        place(stepL, st, x: W - P, cy: headY, right: true)
        let room = W - 2 * P - 14 - (st.map { $0.size.width + 10 } ?? 0)
        place(name, textImage(m.who.isEmpty ? "AI" : m.who, 13, .semibold, theme.text.copy(alpha: 0.82) ?? theme.text, maxWidth: room),
              x: P + 14, cy: headY)
        top += 18
        taskL.isHidden = !hasTask
        if hasTask {
            top += 6
            place(taskL, textImage(m.task, 16, .semibold, theme.text, maxWidth: W - 2 * P), x: P, cy: H - top - 11)
            top += 22
        }
        // Who waits for the mouse after this agent (several agents' work is done in turn, first come first served).
        if !m.queue.isEmpty {
            top += 8
            let n = m.queue.count
            let lines = zh ? ["排队中：后面还有 \(n) 个任务", "下一个：\(m.queue[0])"]
                           : ["Queued: \(n) more task\(n == 1 ? "" : "s") after this", "Next: \(m.queue[0])"]
            for (i, text) in lines.enumerated() {
                let l = CALayer()
                let c = i == 0 ? theme.accent : theme.text.copy(alpha: 0.6) ?? theme.text
                place(l, textImage(text, 12.5, i == 0 ? .semibold : .regular, c, maxWidth: W - 2 * P), x: P, cy: H - top - 9)
                layer.addSublayer(l)
                noteLayers.append(l)
                top += 18
            }
        }
        // Live: what the agent is about to do and why — the newest bright, the two before it faded.
        if !m.notes.isEmpty {
            top += 8
            for (i, n) in m.notes.enumerated() {
                let newest = i == m.notes.count - 1
                let l = CALayer()
                let c = newest ? theme.accent : theme.text.copy(alpha: 0.5) ?? theme.text
                place(l, textImage((newest ? "› " : "  ") + n, 13, newest ? .medium : .regular, c, maxWidth: W - 2 * P), x: P, cy: H - top - 10)
                layer.addSublayer(l)
                noteLayers.append(l)
                top += 20
            }
            top += 4
        }
        top += 10
        for s in m.stages {
            let cy = H - top - rowH / 2
            let ic = CALayer(), lb = CALayer(), dt = CALayer()
            ic.bounds = CGRect(x: 0, y: 0, width: 16, height: 16)
            ic.position = CGPoint(x: px(P + 8), y: px(cy))
            ic.contentsScale = scale
            place(lb, textImage(s.label, 14, .regular, theme.text, maxWidth: W - 2 * P - 26 - 64), x: P + 26, cy: cy)
            for l in [ic, lb, dt] { layer.addSublayer(l) }
            icons.append(ic); labels.append(lb); details.append(dt)
            top += rowH
        }
        states = Array(repeating: nil, count: m.stages.count)
        detailText = Array(repeating: "\u{0}", count: m.stages.count)
        top += 10
        let barY = H - top - VeilPanel.barH
        track.frame = CGRect(x: P, y: px(barY), width: trackW, height: VeilPanel.barH)
        fill.bounds = CGRect(x: 0, y: 0, width: VeilPanel.barH, height: VeilPanel.barH)
        fill.position = CGPoint(x: 0, y: VeilPanel.barH / 2)
        grad.bounds = CGRect(x: 0, y: 0, width: trackW, height: VeilPanel.barH)
        grad.position = .zero
        fillW = -1
        shimmer.bounds = CGRect(x: 0, y: 0, width: 64, height: VeilPanel.barH)
        shimmer.position = CGPoint(x: -32, y: VeilPanel.barH / 2)
        shimmer.removeAllAnimations()
        if !reduceMotion {
            let a = CABasicAnimation(keyPath: "position.x")
            a.fromValue = -32
            a.toValue = trackW + 32
            a.duration = 1.4
            a.repeatCount = .infinity
            a.timingFunction = VEIL_INOUT
            shimmer.add(a, forKey: "glint")
        }
        top += VeilPanel.barH + 8
        etaText = ""; paceText = ""
        eta.frame = CGRect(x: P, y: px(H - top - 16), width: 0, height: 16)
        pace.frame = eta.frame
    }

    /// States, counts, bar, time left and pace from `m` (inside a transaction, actions off).
    func update(_ m: PanelModel) {
        if m.feedMode { return }
        let P = VeilPanel.pad, W = VeilPanel.width
        for (i, s) in m.stages.enumerated() where i < icons.count {
            if states[i] != s.state { setState(i, s.state, animate: states[i] != nil); states[i] = s.state }
            let d = m.detail(s)
            if d != detailText[i] {
                detailText[i] = d
                place(details[i], textImage(d, 13, .medium, theme.text.copy(alpha: 0.6) ?? theme.text, mono: true),
                      x: W - P, cy: labels[i].frame.midY, right: true)
            }
        }
        if m.failed != barFailed {
            barFailed = m.failed
            grad.colors = barFailed ? [VeilPanel.red(theme.dark), VeilPanel.red(theme.dark)] : theme.ring
            shimmer.isHidden = barFailed
        }
        let w = max(VeilPanel.barH, trackW * CGFloat(m.fraction()))
        if abs(w - fillW) >= 0.5 {
            if fillW < 0 || reduceMotion { fill.bounds.size.width = w } else { veilAnimate(fill, "bounds.size.width", to: w, 0.25, VEIL_LINEAR) }
            fillW = w
        }
        let cy = eta.frame.midY
        let e = m.waiting && !m.failed ? (zh ? "正在想下一步" : "Working out the next step")
            : panelEtaText(m.etaMs(), finished: m.finished, failed: m.failed, zh: zh)
        if e != etaText {
            etaText = e
            let c = m.failed ? VeilPanel.red(theme.dark) : theme.text.copy(alpha: 0.82) ?? theme.text
            place(eta, textImage(e, 12.5, .semibold, c, mono: true), x: P, cy: cy)
        }
        let speedHint = m.speedSaveState == "failed"
            ? (zh ? " · 未保存，已恢复" : " · Not saved; restored")
            : m.speedSaveState == "pending" ? (zh ? " · 正在保存" : " · Saving")
            : panelSpeedFromEnvironment() != nil
            ? (zh ? " · 配置固定" : " · Fixed by config")
            : (zh ? " · ↑ 加快 ↓ 减慢" : " · ↑ faster ↓ slower")
        let p = (zh ? "速度 " : "Speed ") + panelSpeedText(m.speed) + speedHint
        if p != paceText {
            paceText = p
            let c = m.speed != 1 ? theme.accent : theme.text.copy(alpha: 0.55) ?? theme.text
            place(pace, textImage(p, 12.5, m.speed != 1 ? .semibold : .regular, c), x: W - P, cy: cy, right: true)
        }
    }

    /// Icon and row emphasis for a new state: crossfade; the ring turns while under way; a check pops in.
    func setState(_ i: Int, _ st: PanelState, animate: Bool) {
        let ic = icons[i]
        ic.contents = iconImages[st]?.image
        labels[i].opacity = st == .pending ? 0.5 : st == .done ? 0.72 : 1
        if animate {
            let fade = CATransition()
            fade.type = .fade
            fade.duration = 0.18
            ic.add(fade, forKey: "fade")
        }
        if st == .running && !reduceMotion {
            if ic.animation(forKey: "spin") == nil {
                let a = CABasicAnimation(keyPath: "transform.rotation.z")
                a.fromValue = 0
                a.toValue = -2 * Double.pi
                a.duration = 0.9
                a.repeatCount = .infinity
                a.timingFunction = VEIL_LINEAR
                ic.add(a, forKey: "spin")
            }
        } else {
            ic.removeAnimation(forKey: "spin")
        }
        if animate && !reduceMotion && (st == .done || st == .failed) {
            let s = CAKeyframeAnimation(keyPath: "transform.scale")
            s.values = [0.6, 1.25, 0.95, 1]
            s.keyTimes = [0, 0.45, 0.75, 1]
            s.duration = 0.3
            ic.add(s, forKey: "pop")
        }
    }
}

/// One screen's veil window and its layers (local coordinates: AppKit, origin at the screen's bottom-left).
final class VeilScreen {
    let screen: NSScreen
    let frame: CGRect
    let scale: CGFloat
    let assets: VeilAssets
    let theme: VeilTheme
    let window: NSWindow
    let frost: NSVisualEffectView
    let capsule: NSVisualEffectView
    let root = CALayer()
    let tint = CAShapeLayer()
    let ring = CALayer()
    var strips: [CALayer] = [], grads: [CALayer] = [], masks: [CALayer] = []
    let block = CALayer()
    let title = CALayer(), sub = CALayer(), divider = CALayer()
    let hint: VeilHint
    let halo = CALayer()
    var ripples: [CALayer] = []
    var nextRipple = 0
    let home = CALayer()
    var hole: CGRect?
    var hasRing = false, hasText = false, hasHint = false, hasCapsule = false
    /// The progress panel (built the first time a model comes with the veil).
    var panel: VeilPanel?
    var reduceMotion = false

    init(_ screen: NSScreen, _ assets: VeilAssets, _ theme: VeilTheme) {
        self.screen = screen
        self.assets = assets
        self.theme = theme
        frame = screen.frame
        scale = screen.backingScaleFactor
        hint = VeilHint(assets, theme)
        window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .screenSaver
        window.ignoresMouseEvents = true
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.setFrame(frame, display: false)
        let bounds = NSRect(origin: .zero, size: frame.size)
        let content = NSView(frame: bounds)
        content.wantsLayer = true
        window.contentView = content

        frost = NSVisualEffectView(frame: bounds)
        frost.material = .fullScreenUI
        frost.blendingMode = .behindWindow
        frost.state = .active           // never the key window: would otherwise show as inactive grey
        frost.autoresizingMask = [.width, .height]
        frost.wantsLayer = true
        content.addSubview(frost)
        frost.layer?.opacity = 0

        capsule = NSVisualEffectView(frame: .zero)
        capsule.material = .hudWindow
        capsule.blendingMode = .behindWindow
        capsule.state = .active
        capsule.wantsLayer = true
        capsule.isHidden = true
        content.addSubview(capsule)
        capsule.layer?.opacity = 0

        let host = NSView(frame: bounds)
        host.layer = root               // layer-hosting: these layers are ours alone
        host.wantsLayer = true
        host.autoresizingMask = [.width, .height]
        content.addSubview(host)

        tint.frame = bounds
        tint.fillRule = .evenOdd
        tint.fillColor = theme.tint
        tint.opacity = 0
        root.addSublayer(tint)

        ring.opacity = 0
        ring.isHidden = true
        root.addSublayer(ring)
        let S = assets.ring?.size.width ?? 1
        let c = (VEIL_MARGIN + VEIL_RADIUS) / S
        for _ in 0..<4 {
            let strip = CALayer()
            strip.masksToBounds = true
            // The aurora colours as one small conic image, stretched: they change only with the
            // angle, so 256 px are smooth at any size, and rotating it is texture sampling.
            let g = CALayer()
            g.contents = assets.conic
            let m = CALayer()
            m.contents = assets.ring?.image
            m.contentsScale = scale
            m.contentsCenter = CGRect(x: c, y: c, width: 1 / S, height: 1 / S)
            strip.addSublayer(g)
            strip.mask = m
            ring.addSublayer(strip)
            strips.append(strip)
            grads.append(g)
            masks.append(m)
        }

        block.opacity = 0
        root.addSublayer(block)
        for l in [title, sub] {
            l.contentsScale = scale
            block.addSublayer(l)
        }
        divider.backgroundColor = theme.text.copy(alpha: 0.22)
        block.addSublayer(divider)
        block.addSublayer(hint.layer)

        for _ in 0..<4 {
            let r = CALayer()
            r.borderColor = theme.halo
            r.opacity = 0
            root.addSublayer(r)
            ripples.append(r)
        }
        home.borderColor = theme.neutral
        home.borderWidth = 2
        home.opacity = 0
        root.addSublayer(home)

        halo.contents = assets.halo?.image
        halo.contentsScale = scale
        halo.bounds = CGRect(origin: .zero, size: assets.halo?.size ?? .zero)
        halo.opacity = 0
        root.addSublayer(halo)
    }

    func local(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x - frame.minX, y: p.y - frame.minY) }
    func px(_ v: CGFloat) -> CGFloat { (v * scale).rounded() / scale }
    func pixel(_ p: CGPoint) -> CGPoint { CGPoint(x: px(p.x), y: px(p.y)) }
    /// Frame `l` at `size` around `center`, on whole device pixels (images stay crisp).
    func put(_ l: CALayer, _ size: CGSize, _ center: CGPoint) {
        l.frame = CGRect(x: px(center.x - size.width / 2), y: px(center.y - size.height / 2), width: size.width, height: size.height)
    }

    /// Visible frame (no menu bar, no Dock), clear of the notch.
    func usable() -> CGRect {
        var u = screen.visibleFrame.offsetBy(dx: -frame.minX, dy: -frame.minY)
        let top = frame.height - screen.safeAreaInsets.top
        if u.maxY > top { u.size.height = max(0, top - u.minY) }
        return u
    }

    /// The frost's hole and the tint's, 1 pt beyond the window edge (under the ring), and the ring.
    func setHole(_ h: CGRect?) {
        hole = h
        let full = CGRect(origin: .zero, size: frame.size)
        guard let h = h else {
            frost.maskImage = nil
            tint.path = CGPath(rect: full, transform: nil)
            hasRing = false
            ring.isHidden = true
            return
        }
        let cut = h.insetBy(dx: -1, dy: -1)
        frost.maskImage = VeilScreen.frostMask(full.size, cut, VEIL_RADIUS + 1, scale: scale)
        let p = CGMutablePath()
        p.addRect(full)
        p.addPath(veilRounded(cut, VEIL_RADIUS + 1))
        tint.path = p
        layoutRing(h)
        hasRing = true
        ring.isHidden = false
    }

    /// Frost mask at 1x (its edge lies under the ring): opaque everywhere but the hole.
    /// Rendered at the screen's backing scale: NSVisualEffectView takes the mask's pixels at that
    /// scale, so a 1x image came out half-size and shifted on Retina screens (seen on screen 2026-10-05).
    static func frostMask(_ size: CGSize, _ hole: CGRect, _ r: CGFloat, scale: CGFloat = 1) -> NSImage? {
        let k = max(1, scale)
        let w = Int((size.width * k).rounded(.up)), h = Int((size.height * k).rounded(.up))
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue)
            ?? CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                         space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        guard let ctx = ctx else { return nil }
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: k, y: k)
        ctx.setBlendMode(.clear)
        ctx.addPath(veilRounded(hole, r))
        ctx.fillPath()
        guard let img = ctx.makeImage() else { return nil }
        return NSImage(cgImage: img, size: size)
    }

    /// The ring box (window + margin) as four strips around the window's inside, each masked by
    /// the 9-slice ring and showing its own copy of one conic image centred on the window:
    /// the gradient only ever fills the strips, never the whole box.
    func layoutRing(_ h: CGRect) {
        let G = VEIL_MARGIN, inset = VEIL_RADIUS + 1
        let box = h.insetBy(dx: -G, dy: -G)
        ring.bounds = CGRect(origin: .zero, size: box.size)
        ring.position = CGPoint(x: box.midX, y: box.midY)
        let Wb = box.width, Hb = box.height
        let inner = CGRect(x: G + inset, y: G + inset, width: max(0, h.width - 2 * inset), height: max(0, h.height - 2 * inset))
        let rects = [CGRect(x: 0, y: inner.maxY, width: Wb, height: Hb - inner.maxY),
                     CGRect(x: 0, y: 0, width: Wb, height: inner.minY),
                     CGRect(x: 0, y: inner.minY, width: inner.minX, height: inner.height),
                     CGRect(x: inner.maxX, y: inner.minY, width: Wb - inner.maxX, height: inner.height)]
        let D = ceil(hypot(Wb, Hb) + 8)
        for i in 0..<4 {
            strips[i].frame = rects[i]
            masks[i].frame = CGRect(x: -rects[i].minX, y: -rects[i].minY, width: Wb, height: Hb)
            grads[i].bounds = CGRect(x: 0, y: 0, width: D, height: D)
            grads[i].position = CGPoint(x: Wb / 2 - rects[i].minX, y: Hb / 2 - rects[i].minY)
        }
    }

    func renderSub(_ label: String, _ size: CGFloat, _ maxWidth: CGFloat) -> (VeilImage?, CGSize) {
        veilSubImage(label, size, maxWidth, theme, scale)
    }

    /// The panel for `m`, built and brought up to date (inside the caller's transaction).
    func ensurePanel(_ m: PanelModel) -> VeilPanel {
        let p: VeilPanel
        if let x = panel { p = x } else {
            p = VeilPanel(theme: theme, zh: VeilCopy.system.zh, scale: scale, reduceMotion: reduceMotion)
            block.addSublayer(p.layer)
            panel = p
        }
        p.build(m)
        if let session = gSession { session.measuredStage("overlay_panel") { p.update(m) } }
        else { p.update(m) }
        p.layer.isHidden = false
        return p
    }

    /// §2.1: title, subline, the progress panel and the hint in the largest frosted area next to
    /// the hole; when there is no room, a frosted card in the corner away from the target (with a
    /// panel) or a capsule at the screen edge (without).
    func layoutText(label: String, target: CGPoint?, model: PanelModel? = nil) -> String {
        let u = usable()
        var (subImg, subText) = renderSub(label, 17, 520)
        let tt = assets.titleText
        let pv = model.map { ensurePanel($0) }
        let ph = pv.map { $0.size.height + 14 } ?? 0
        func blockSize() -> CGSize {
            CGSize(width: max(tt.width, subText.width, hint.size.width, pv?.size.width ?? 0),
                   height: tt.height + (subImg != nil ? 6 + subText.height : 0) + ph + 14 + hint.size.height)
        }
        var bs = blockSize()
        var center: CGPoint?
        if let h = hole {
            let above = u.maxY - h.maxY, below = h.minY - u.minY
            let need = bs.height + 56
            let cx = min(max(h.midX, u.minX + bs.width / 2 + 24), u.maxX - bs.width / 2 - 24)
            let gap = { (room: CGFloat) in min(max(40, (room - bs.height) / 2), 96) }
            if above >= need || below >= need {
                center = above >= below ? CGPoint(x: cx, y: h.maxY + gap(above) + bs.height / 2)
                                        : CGPoint(x: cx, y: h.minY - gap(below) - bs.height / 2)
            } else {
                let left = h.minX - u.minX, right = u.maxX - h.maxX
                let room = max(left, right) - 80
                if room >= max(tt.width, hint.size.width, pv?.size.width ?? 0) && u.height >= bs.height + 48 {
                    if subText.width > room { (subImg, subText) = renderSub(label, 17, room); bs = blockSize() }
                    let cy = min(max(h.midY, u.minY + bs.height / 2 + 24), u.maxY - bs.height / 2 - 24)
                    center = CGPoint(x: left >= right ? u.minX + left / 2 : h.maxX + right / 2, y: cy)
                }
            }
        } else {
            center = CGPoint(x: u.midX, y: u.midY)      // no hole yet: the middle of the frost
        }
        guard let c = center else {
            if let p = pv { return layoutCard(label: label, target: target, panel: p, step: model?.step ?? "") }
            return layoutCapsule(label: label, target: target)
        }
        capsule.isHidden = true
        hasCapsule = false
        put(block, bs, c)
        title.isHidden = false
        title.contents = assets.title?.image
        put(title, assets.title?.size ?? .zero, CGPoint(x: bs.width / 2, y: bs.height - tt.height / 2))
        if let s = subImg {
            sub.isHidden = false
            sub.contents = s.image
            put(sub, s.size, CGPoint(x: bs.width / 2, y: bs.height - tt.height - 6 - subText.height / 2))
        } else {
            sub.isHidden = true
        }
        divider.isHidden = true
        if let p = pv {
            p.plain = false
            put(p.layer, p.size, CGPoint(x: bs.width / 2, y: hint.size.height + 14 + p.size.height / 2))
        }
        put(hint.layer, hint.size, CGPoint(x: bs.width / 2, y: hint.size.height / 2))
        hasText = true
        hasHint = true
        return "block"
    }

    /// No room beside the hole (Chrome fills the screen): one frosted card with the small title,
    /// the subline, the panel and the hint, in the usable corner farthest from the target. It may
    /// cover part of the page; never the point the agent works on when another corner is free.
    func layoutCard(label: String, target: CGPoint?, panel p: VeilPanel, step: String = "") -> String {
        let u = usable()
        let pad: CGFloat = 18
        let tt = assets.titleSmallText
        let (subImg, subText) = renderSub(label, 15, p.size.width)
        let w = ceil(max(p.size.width, tt.width, hint.extent) + 2 * pad)
        let h = ceil(pad + tt.height + (subImg != nil ? 4 + subText.height : 0) + 10 + p.size.height + 12 + hint.size.height + pad)
        guard w <= u.width - 32, h <= u.height - 32 else {
            p.layer.isHidden = true
            return layoutCapsule(label: label, target: target, step: step)
        }
        let t = target ?? CGPoint(x: (hole ?? u).midX, y: (hole ?? u).midY)
        var best = CGRect.null, bestD = -1.0
        for x in [u.minX + 16, u.maxX - 16 - w] {
            for y in [u.minY + 16, u.maxY - 16 - h] {
                let r = CGRect(x: x, y: y, width: w, height: h)
                let d = Double(hypot(r.midX - t.x, r.midY - t.y))
                if d > bestD { bestD = d; best = r }
            }
        }
        let rect = CGRect(x: px(best.minX), y: px(best.minY), width: w, height: h)
        capsule.frame = rect
        capsule.maskImage = VeilScreen.cardMask(20)
        capsule.isHidden = false
        hasCapsule = true
        block.frame = rect
        var top = pad
        title.isHidden = false
        title.contents = assets.titleSmall?.image
        put(title, assets.titleSmall?.size ?? .zero, CGPoint(x: w / 2, y: h - top - tt.height / 2))
        top += tt.height
        if let s = subImg {
            top += 4
            sub.isHidden = false
            sub.contents = s.image
            put(sub, s.size, CGPoint(x: w / 2, y: h - top - subText.height / 2))
        } else {
            sub.isHidden = true
        }
        divider.isHidden = true
        p.plain = true
        put(p.layer, p.size, CGPoint(x: w / 2, y: pad + hint.size.height + 12 + p.size.height / 2))
        put(hint.layer, hint.size, CGPoint(x: w / 2, y: pad + hint.size.height / 2))
        hasText = true
        hasHint = true
        return "card"
    }

    static func cardMask(_ r: CGFloat) -> NSImage {
        let img = NSImage(size: NSSize(width: 2 * r + 1, height: 2 * r + 1), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r)
        img.resizingMode = .stretch
        return img
    }

    /// One frosted row: [title] [subline] | [hint]. It may cover at most 56 pt of the page edge.
    func layoutCapsule(label: String, target: CGPoint?, step: String = "") -> String {
        panel?.layer.isHidden = true
        let u = usable()
        let h: CGFloat = 44, padX: CGFloat = 20, gapSub: CGFloat = 12, gapHint: CGFloat = 16
        let tt = assets.titleSmallText
        let fixed = padX * 2 + tt.width + gapHint * 2 + 1 + hint.extent
        let stepLabel = step.isEmpty ? label : (VeilCopy.system.zh ? "第 \(step) 步 · \(label)" : "Step \(step) · \(label)")
        var (subImg, subText) = renderSub(stepLabel, 15, min(360, u.width - 32 - fixed - gapSub))
        if subImg != nil && subText.width < 40 { subImg = nil; subText = .zero }
        let w = ceil(fixed + (subImg != nil ? gapSub + subText.width : 0))
        let hole = self.hole ?? u
        // The edge farther from where the agent works (target in the lower half → top).
        let atTop = target.map { $0.y < hole.midY } ?? true
        let cx = min(max(hole.midX, u.minX + w / 2 + 16), u.maxX - w / 2 - 16)
        let cy = atTop ? u.maxY - 8 - h / 2 : u.minY + 8 + h / 2
        let rect = CGRect(x: px(cx - w / 2), y: px(cy - h / 2), width: w, height: h)
        capsule.frame = rect
        capsule.maskImage = VeilScreen.capsuleMask(h)
        capsule.isHidden = false
        hasCapsule = true
        block.frame = rect
        var x = padX
        title.isHidden = false
        title.contents = assets.titleSmall?.image
        put(title, assets.titleSmall?.size ?? .zero, CGPoint(x: x + tt.width / 2, y: h / 2))
        x += tt.width
        if let s = subImg {
            x += gapSub
            sub.isHidden = false
            sub.contents = s.image
            put(sub, s.size, CGPoint(x: x + subText.width / 2, y: h / 2))
            x += subText.width
        } else {
            sub.isHidden = true
        }
        x += gapHint
        divider.isHidden = false
        divider.frame = CGRect(x: px(x), y: (h - 18) / 2, width: 1, height: 18)
        x += 1 + gapHint
        put(hint.layer, hint.size, CGPoint(x: x + hint.size.width / 2, y: h / 2))
        hasText = true
        hasHint = true
        return "capsule"
    }

    static func capsuleMask(_ h: CGFloat) -> NSImage {
        let r = h / 2
        let img = NSImage(size: NSSize(width: h + 1, height: h), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r)
        img.resizingMode = .stretch
        return img
    }

    /// §6: the screen the user's pointer was on (not the agent's) gets the hint line alone, bottom centre.
    func layoutLoneHint() {
        let u = usable()
        panel?.layer.isHidden = true
        title.isHidden = true
        sub.isHidden = true
        divider.isHidden = true
        capsule.isHidden = true
        hasCapsule = false
        put(block, hint.size, CGPoint(x: u.midX, y: u.minY + max(64, u.height * 0.1)))
        put(hint.layer, hint.size, CGPoint(x: hint.size.width / 2, y: hint.size.height / 2))
        hasText = true
        hasHint = true
    }

    func hideText() {
        capsule.isHidden = true
        hasCapsule = false
        hasText = false
        hasHint = false
        block.opacity = 0
    }
}

final class Veil: NSObject {
    let theme: VeilTheme
    let copy: VeilCopy
    let opt: VeilOptions
    var screens: [VeilScreen] = []
    let primaryHeight: CGFloat
    var shown = false, dismissed = false, gone = true
    var agent: VeilScreen?, userScreen: VeilScreen?
    var holeCG: CGRect?
    var label = ""
    var target: CGPoint?
    var mode = "none"
    // The progress panel's state (the session's) and its 4 Hz refresh (time left, bar).
    var model: PanelModel?
    var panelTimer: Timer?
    var panelQueued = false
    var continuous = false
    // halo
    var haloScreen: VeilScreen?
    var haloOn = false, shrunk = false, dirty = false
    var latest = CGPoint.zero        // AppKit global
    var lastMove: CFTimeInterval = 0
    var lastApply: CFTimeInterval = 0
    var applyPending = false
    var applies = 0
    var stillTimer: Timer?
    // reactions
    var lastNudge: CFTimeInterval = 0
    var escGen = 0
    var returnEnd: CFTimeInterval = 0
    // measurements
    var primeMs = 0.0, showMs = 0.0
    var showAt: CFTimeInterval = 0

    var live: Bool { shown && !dismissed }

    /// `prime`: windows and every layer built, all transparent, nothing on screen.
    init(_ opt: VeilOptions = VeilOptions()) {
        let t0 = nowMs()
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        theme = VeilTheme(dark: app.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua,
                          contrast: opt.increaseContrast)
        copy = .system
        self.opt = opt
        primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        super.init()
        var cache: [CGFloat: VeilAssets] = [:]
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for s in NSScreen.screens {
            let a = cache[s.backingScaleFactor] ?? VeilAssets(scale: s.backingScaleFactor, theme: theme, copy: copy)
            cache[s.backingScaleFactor] = a
            let vs = VeilScreen(s, a, theme)
            vs.reduceMotion = opt.reduceMotion
            if opt.timeScale != 1 { vs.window.contentView?.layer?.speed = Float(1 / opt.timeScale) }
            screens.append(vs)
        }
        CATransaction.commit()
        primeMs = nowMs() - t0
    }

    // CG (top-left of the primary screen, y down) ↔ AppKit (bottom-left of the primary screen, y up).
    func appKit(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: primaryHeight - p.y) }
    func appKit(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height) }

    func screen(at p: CGPoint) -> VeilScreen? {
        if let s = screens.first(where: { $0.frame.contains(p) }) { return s }
        return screens.min { a, b in
            hypot(p.x - min(max(p.x, a.frame.minX), a.frame.maxX), p.y - min(max(p.y, a.frame.minY), a.frame.maxY)) <
            hypot(p.x - min(max(p.x, b.frame.minX), b.frame.maxX), p.y - min(max(p.y, b.frame.minY), b.frame.maxY))
        }
    }
    func screen(for r: CGRect) -> VeilScreen? {
        let area = { (s: VeilScreen) -> CGFloat in let i = s.frame.intersection(r); return i.isNull ? 0 : i.width * i.height }
        if let b = screens.max(by: { area($0) < area($1) }), area(b) > 0 { return b }
        return screen(at: CGPoint(x: r.midX, y: r.midY))
    }

    static func recentEnd() -> Bool {
        guard let s = try? String(contentsOfFile: veilStampPath(), encoding: .utf8),
              let t = Double(s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        let age = Date().timeIntervalSince1970 * 1000 - t
        return age >= 0 && age < 1000
    }

    /// `hold`: the veil up. `rect` is the Chrome window (CG; nil until `begin` says), `target` the
    /// point the agent goes for, `cursor` where the user's pointer is now.
    func show(rect: CGRect?, label: String, target: CGPoint?, cursor: CGPoint, model: PanelModel? = nil) {
        guard !shown, !screens.isEmpty else { return }
        let t0 = nowMs()
        shown = true
        gone = false
        self.label = label
        self.target = target
        self.model = model
        holeCG = rect
        continuous = opt.forceContinuous || Veil.recentEnd()
        let cur = appKit(cursor)
        userScreen = screen(at: cur)
        agent = rect.map { screen(for: appKit($0)) } ?? userScreen
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layout()
        latest = cur
        placeHalo(cur)
        entrance()
        CATransaction.commit()
        for vs in screens { vs.window.orderFrontRegardless() }
        CATransaction.flush()
        showAt = CACurrentMediaTime()
        lastMove = showAt
        watchStill()
        if model != nil {
            panelTimer = Timer.scheduledTimer(withTimeInterval: 0.25 * opt.timeScale, repeats: true) { [weak self] t in
                guard let s = self, s.live else { t.invalidate(); return }
                s.applyPanel()
            }
        }
        showMs = nowMs() - t0
    }

    /// A long job's next action (or the pause before it) in the same hold: new subline and panel,
    /// laid out again in place (no entrance).
    func relabel(label: String, target: CGPoint?, model: PanelModel?) {
        guard live else { return }
        self.label = label
        if let t = target { self.target = t }
        self.model = model
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layout()
        for vs in screens where vs.hasCapsule { vs.capsule.layer?.opacity = 1 }
        CATransaction.commit()
        if model != nil && panelTimer == nil {
            panelTimer = Timer.scheduledTimer(withTimeInterval: 0.25 * opt.timeScale, repeats: true) { [weak self] t in
                guard let s = self, s.live else { t.invalidate(); return }
                s.applyPanel()
            }
        }
    }

    /// Out of the way for a screenshot of the page (the input stays held), and back.
    func setHidden(_ hidden: Bool) {
        guard live else { return }
        for vs in screens { vs.window.alphaValue = hidden ? 0 : 1 }
        CATransaction.flush()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.06))
    }

    /// The model changed (an op, ↑/↓, a `panel` request): redraw once, soon, outside any tap
    /// callback (text images are drawn here).
    func panelChanged() {
        guard live, model != nil, !panelQueued else { return }
        panelQueued = true
        DispatchQueue.main.async { [weak self] in
            self?.panelQueued = false
            self?.applyPanel()
        }
    }

    /// `fading`: also while the veil fades out (the last state goes out with it).
    func applyPanel(fading: Bool = false) {
        guard live || (fading && shown && !gone), let m = model, let vs = agent, let p = vs.panel, !p.layer.isHidden else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let session = gSession { session.measuredStage("overlay_panel_update") { p.update(m) } }
        else { p.update(m) }
        CATransaction.commit()
    }

    /// Holes, ring and text on every screen for the current hole.
    func layout() {
        let holeA = holeCG.map { appKit($0) }
        for vs in screens {
            if let h = holeA, h.insetBy(dx: -VEIL_MARGIN, dy: -VEIL_MARGIN).intersects(vs.frame) {
                vs.setHole(h.offsetBy(dx: -vs.frame.minX, dy: -vs.frame.minY))
            } else {
                vs.setHole(nil)
            }
            if vs === agent {
                mode = vs.layoutText(label: label, target: target.map { vs.local(appKit($0)) }, model: model)
            } else if vs === userScreen {
                vs.layoutLoneHint()
            } else {
                vs.hideText()
            }
        }
    }

    func entrance() {
        let rm = opt.reduceMotion
        let quick: CFTimeInterval? = continuous ? 0.08 : (rm ? 0.12 : nil)
        for vs in screens {
            if let f = vs.frost.layer { veilAnimate(f, "opacity", to: 1, from: 0, quick ?? 0.14, VEIL_ENTRY) }
            veilAnimate(vs.tint, "opacity", to: 1, from: 0, quick ?? 0.14, VEIL_ENTRY)
            if vs.hasCapsule, let c = vs.capsule.layer { veilAnimate(c, "opacity", to: 1, from: 0, quick ?? 0.14, VEIL_ENTRY) }
            if vs.hasRing { ringIn(vs, quick) }
            if vs.hasText { veilAnimate(vs.block, "opacity", to: 1, from: 0, quick ?? 0.10, VEIL_ENTRY, delay: quick == nil ? 0.02 : 0) }
        }
        if let h = haloScreen { veilAnimate(h.halo, "opacity", to: 1, from: 0, quick ?? 0.10, VEIL_ENTRY) }
        haloOn = true
    }

    /// The ring fades in and locks onto the window from 10 pt outside (spring m 1, k 420, c 30),
    /// then its colours keep turning, one turn per 6 s.
    func ringIn(_ vs: VeilScreen, _ quick: CFTimeInterval?) {
        veilAnimate(vs.ring, "opacity", to: 1, from: 0, quick ?? 0.12, VEIL_ENTRY)
        if quick == nil, let h = vs.hole, h.width > 0, h.height > 0 {
            for (key, from) in [("transform.scale.x", (h.width + 20) / h.width), ("transform.scale.y", (h.height + 20) / h.height)] {
                let s = CASpringAnimation(keyPath: key)
                s.mass = 1
                s.stiffness = 420
                s.damping = 30
                s.fromValue = from
                s.toValue = 1
                s.duration = s.settlingDuration
                vs.ring.add(s, forKey: key)
            }
        }
        if opt.reduceMotion { return }
        // Phase from the wall clock: back-to-back veils continue the same turn.
        let phase = Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 6) / 6 * 2 * Double.pi
        for g in vs.grads where g.animation(forKey: "turn") == nil {
            let a = CABasicAnimation(keyPath: "transform.rotation.z")
            a.fromValue = -phase
            a.toValue = -phase - 2 * Double.pi
            a.duration = 6
            a.repeatCount = .infinity
            a.timingFunction = VEIL_LINEAR
            g.add(a, forKey: "turn")
        }
    }

    /// `begin` brought the window: open the hole now if it was unknown (or has moved).
    func updateHole(_ r: CGRect) {
        guard live else { return }
        if let h = holeCG, abs(h.minX - r.minX) < 2, abs(h.minY - r.minY) < 2,
           abs(h.width - r.width) < 2, abs(h.height - r.height) < 2 { return }
        holeCG = r
        agent = screen(for: appKit(r))
        let before = screens.map { ($0.hasRing, $0.hasCapsule) }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layout()
        let quick: CFTimeInterval? = continuous ? 0.08 : (opt.reduceMotion ? 0.12 : nil)
        for (i, vs) in screens.enumerated() {
            if vs.hasRing && !before[i].0 { ringIn(vs, quick) }
            if vs.hasCapsule && !before[i].1, let c = vs.capsule.layer { veilAnimate(c, "opacity", to: 1, from: 0, quick ?? 0.14, VEIL_ENTRY) }
            if vs.hasText { veilAnimate(vs.block, "opacity", to: 1, from: 0, quick ?? 0.14, VEIL_ENTRY) }
        }
        CATransaction.commit()
    }

    // MARK: halo, ripple, return ring

    /// Inside a transaction with actions off. The screen under the pointer shows the halo.
    func placeHalo(_ p: CGPoint) {
        guard let vs = screen(at: p) else { return }
        if vs !== haloScreen {
            if let old = haloScreen {
                old.halo.removeAllAnimations()
                old.halo.opacity = 0
            }
            haloScreen = vs
            vs.halo.opacity = haloOn ? (shrunk ? 0.55 : 1) : 0
            vs.halo.transform = shrunk && !opt.reduceMotion ? CATransform3DMakeScale(26.0 / 34, 26.0 / 34, 1) : CATransform3DIdentity
        }
        vs.halo.position = vs.pixel(vs.local(p))
    }

    /// Every posted pointer move, not interpolated (a lagging halo would read as a stall). At
    /// most one commit per 1/120 s; the latest position always lands. No display link: this
    /// needs no display to be awake and no extra callback source in the session's run loop.
    func pointerMoved(_ p: CGPoint) {
        guard live else { return }
        latest = appKit(p)
        dirty = true
        let now = CACurrentMediaTime()
        lastMove = now
        if now - lastApply >= 1.0 / 120 {
            applyHalo()
        } else if !applyPending {
            applyPending = true
            DispatchQueue.main.asyncAfter(deadline: .now() + (lastApply + 1.0 / 120 - now)) { [weak self] in
                self?.applyPending = false
                self?.applyHalo()
            }
        }
        watchStill()
    }

    func applyHalo() {
        guard dirty, live else { return }
        dirty = false
        lastApply = CACurrentMediaTime()
        applies += 1
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        placeHalo(latest)
        if !haloOn, let vs = haloScreen {
            haloOn = true
            shrunk = false
            vs.halo.transform = CATransform3DIdentity
            veilAnimate(vs.halo, "opacity", to: 1, 0.1, VEIL_ENTRY)
        } else if shrunk {
            shrunk = false
            if let vs = haloScreen {
                veilAnimate(vs.halo, "opacity", to: 1, 0.12, VEIL_OUT)
                if !opt.reduceMotion { veilAnimate(vs.halo, "transform.scale", to: 1, 0.12, VEIL_OUT) }
            }
        }
        CATransaction.commit()
    }

    /// Still for 600 ms (typing): 34 → 26 pt at 0.55, out of the way of the field.
    func shrink() {
        guard haloOn, !shrunk, let vs = haloScreen else { return }
        shrunk = true
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        veilAnimate(vs.halo, "opacity", to: 0.55, 0.3, VEIL_INOUT)
        if !opt.reduceMotion { veilAnimate(vs.halo, "transform.scale", to: 26.0 / 34, 0.3, VEIL_INOUT) }
        CATransaction.commit()
    }

    /// Shrink the halo once the pointer has been still for 600 ms.
    func watchStill() {
        guard stillTimer == nil, live else { return }
        let due = lastMove + 0.6 * opt.timeScale - CACurrentMediaTime()
        stillTimer = Timer.scheduledTimer(withTimeInterval: max(0.01, due), repeats: false) { [weak self] _ in
            guard let s = self else { return }
            s.stillTimer = nil
            if CACurrentMediaTime() - s.lastMove >= 0.59 * s.opt.timeScale { s.shrink() } else { s.watchStill() }
        }
    }

    /// A button press: one ripple, 24 → 80 pt in 420 ms (fades in place under Reduce Motion).
    func pressed(at p: CGPoint) {
        guard live else { return }
        let pa = appKit(p)
        guard let vs = screen(at: pa) else { return }
        let r = vs.ripples[vs.nextRipple]
        vs.nextRipple = (vs.nextRipple + 1) % vs.ripples.count
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        r.removeAllAnimations()
        r.position = vs.pixel(vs.local(pa))
        if opt.reduceMotion {
            r.bounds = CGRect(x: 0, y: 0, width: 40, height: 40)
            r.cornerRadius = 20
            r.borderWidth = 2
            veilAnimate(r, "opacity", to: 0, from: 0.9, 0.12, VEIL_LINEAR)
        } else {
            func a(_ key: String, _ from: Any, _ to: Any) -> CABasicAnimation {
                let b = CABasicAnimation(keyPath: key)
                b.fromValue = from
                b.toValue = to
                b.duration = 0.42
                return b
            }
            let g = CAAnimationGroup()
            g.animations = [a("bounds.size", CGSize(width: 24, height: 24), CGSize(width: 80, height: 80)),
                            a("cornerRadius", 12, 40), a("borderWidth", 2.5, 0.5), a("opacity", 0.9, 0)]
            g.duration = 0.42
            g.timingFunction = VEIL_RIPPLE
            r.bounds = CGRect(x: 0, y: 0, width: 80, height: 80)
            r.cornerRadius = 40
            r.borderWidth = 0.5
            r.opacity = 0
            r.add(g, forKey: "ripple")
        }
        CATransaction.commit()
    }

    /// The pointer put back where the user had it: the halo goes, a neutral ring (the user's own
    /// pointer) closes in there, 56 → 28 pt in 360 ms.
    func pointerReturned(to p: CGPoint) {
        guard live else { return }
        dirty = false
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if haloOn, let vs = haloScreen {
            haloOn = false
            veilAnimate(vs.halo, "opacity", to: 0, 0.1, VEIL_OUT)
        }
        let pa = appKit(p)
        if let vs = screen(at: pa) {
            let h = vs.home
            h.removeAllAnimations()
            h.position = vs.pixel(vs.local(pa))
            let dur: CFTimeInterval = opt.reduceMotion ? 0.24 : 0.36
            let o = CAKeyframeAnimation(keyPath: "opacity")
            o.values = [0, 0.9, 0]
            o.keyTimes = [0, 0.3, 1]
            o.duration = dur
            h.opacity = 0
            h.bounds = CGRect(x: 0, y: 0, width: 28, height: 28)
            h.cornerRadius = 14
            h.add(o, forKey: "opacity")
            if !opt.reduceMotion {
                let s = CABasicAnimation(keyPath: "bounds.size")
                s.fromValue = CGSize(width: 56, height: 56)
                s.toValue = CGSize(width: 28, height: 28)
                let c = CABasicAnimation(keyPath: "cornerRadius")
                c.fromValue = 28
                c.toValue = 14
                for x in [s, c] {
                    x.duration = dur
                    x.timingFunction = VEIL_OUT
                    h.add(x, forKey: x.keyPath)
                }
            }
            returnEnd = CACurrentMediaTime() + dur * opt.timeScale
        }
        CATransaction.commit()
    }

    // MARK: reactions to held input (called from the tap callback: layer properties only)

    var hints: [VeilHint] { screens.filter { $0.hasHint }.map { $0.hint } }

    func nudge() {
        guard live else { return }
        let t = CACurrentMediaTime()
        if t - lastNudge < 0.25 * opt.timeScale { return }
        lastNudge = t
        for h in hints { h.nudge(opt.reduceMotion) }
    }

    func escFirst() {
        guard live else { return }
        escGen += 1
        let g = escGen
        DispatchQueue.main.async { [weak self] in
            guard let s = self, s.live, s.escGen == g else { return }
            for h in s.hints { h.setAgain(true) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8 * opt.timeScale) { [weak self] in
            guard let s = self, s.live, s.escGen == g else { return }
            for h in s.hints { h.setAgain(false) }
        }
    }

    func escSecond() {
        guard live else { return }
        escGen += 1
        for h in hints { h.pressAgain(opt.reduceMotion) }
    }

    func shake(_ n: Int) {
        guard live else { return }
        for h in hints { h.setDots(n) }
    }

    // MARK: exit

    /// The hold is over: frost 220 ms, the rest 160 ms, windows out at ~240 ms (later only for a
    /// return ring still closing). Never delays anything: the caller has its reply already.
    func dismiss() {
        guard live else { return }
        // The last state (all green, or where it stopped) fades out with the rest: drawn on the next
        // turn of the run loop, never inside the tap callback (Esc-Esc and the shake end it there).
        if model != nil { DispatchQueue.main.async { [weak self] in self?.applyPanel(fading: true) } }
        panelTimer?.invalidate()
        panelTimer = nil
        dismissed = true
        escGen += 1
        let rm = opt.reduceMotion
        let fd: CFTimeInterval = rm ? 0.12 : 0.22, od: CFTimeInterval = rm ? 0.12 : 0.16
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for vs in screens {
            if let f = vs.frost.layer { veilAnimate(f, "opacity", to: 0, fd, VEIL_EXIT) }
            veilAnimate(vs.tint, "opacity", to: 0, fd, VEIL_EXIT)
            if vs.hasCapsule, let c = vs.capsule.layer { veilAnimate(c, "opacity", to: 0, fd, VEIL_EXIT) }
            for l in [vs.ring, vs.block, vs.halo] { veilAnimate(l, "opacity", to: 0, od, VEIL_EXIT) }
        }
        CATransaction.commit()
        CATransaction.flush()
        let now = CACurrentMediaTime()
        let at = max(now + (rm ? 0.14 : 0.24) * opt.timeScale, returnEnd)
        DispatchQueue.main.asyncAfter(deadline: .now() + (at - now)) { [weak self] in self?.takeDown() }
        if opt.recordEnd {
            // Out of the tap callback (Esc's key-up and the shake release from inside it).
            let stamp = String(Int64(Date().timeIntervalSince1970 * 1000))
            DispatchQueue.main.async {
                let path = veilStampPath()
                try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                                                         withIntermediateDirectories: true)
                try? stamp.write(toFile: path, atomically: true, encoding: .utf8)
            }
        }
    }

    func takeDown() {
        guard !gone else { return }
        gone = true
        stillTimer?.invalidate()
        stillTimer = nil
        for vs in screens {
            vs.window.orderOut(nil)
            for g in vs.grads { g.removeAllAnimations() }
        }
    }

    /// Keep the process alive until the fade-out is done (the caller has had its reply).
    func waitUntilGone(maxMs: Double = 600) {
        let end = nowMs() + maxMs
        while !gone && nowMs() < end { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005)) }
        takeDown()
    }
}

/// `veildemo`: the veil over `rect` with every motion played on its own layers. No event tap,
/// no posted input; the real cursor stays where it is (the halo starts there and travels alone).
/// The demo's veil, for the input watcher below (a C callback cannot capture).
var gDemoVeil: Veil?
/// The demo holds nothing, so any key, click or scroll of the user's ends it at once
/// (the hint on screen says how to take back control; in the demo every way works).
let demoInputCallback: CGEventTapCallBack = { _, type, event, _ in
    if type != .tapDisabledByTimeout && type != .tapDisabledByUserInput,
       event.getIntegerValueField(.eventSourceUserData) != SESSION_TAG, let v = gDemoVeil, !v.dismissed {
        v.dismiss()
    }
    return Unmanaged.passUnretained(event)
}

func runVeilDemo(rect: CGRect, seconds: Double, label: String, usePath: Bool, point: CGPoint?,
                 appearance: String?, options: VeilOptions, panel: Bool = false) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    if let a = appearance { app.appearance = NSAppearance(named: a == "light" ? .aqua : .darkAqua) }
    RunLoop.current.add(NSMachPort(), forMode: .default)
    let veil = Veil(options)
    gDemoVeil = veil
    var dmask: UInt64 = 0
    for t: CGEventType in [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel] { dmask |= 1 << UInt64(t.rawValue) }
    if let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                   eventsOfInterest: CGEventMask(dmask), callback: demoInputCallback, userInfo: nil) {
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }
    // Never on screen longer than this, whatever --seconds and --slow say (it covers the user's screen).
    let demoCapS = 15.0
    DispatchQueue.main.asyncAfter(deadline: .now() + demoCapS) { if !veil.dismissed { veil.dismiss() } }
    let cursor = currentMouse()
    let target = point ?? CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.42)
    let s0 = nowMs()
    // --panel: the progress panel with a sample task, its stages run on the demo's own timeline.
    let model: PanelModel? = panel ? snapModel(veil.copy.zh, chars: 24) : nil
    model?.onChange = { veil.panelChanged() }
    veil.show(rect: rect, label: label, target: target, cursor: cursor, model: model)
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005))   // as the session's showOverlay
    let showWithSettle = nowMs() - s0
    let S = panel ? max(9, seconds) : max(3, seconds)
    // The halo's path: the movement model's own samples (--path), else an eased curve.
    var path: [(Double, CGPoint)] = []
    if usePath {
        let plan = planMove(from: cursor, rect: CGRect(x: target.x - 8, y: target.y - 8, width: 16, height: 16), aim: target,
                            window: rect, rate: 2, u: fittsU())
        path = plan.samples(rate: 2)
    } else {
        let d = dist(cursor, target), dur = min(900, max(350, d / 1.8))
        let bow = CGPoint(x: -(target.y - cursor.y) * 0.12, y: (target.x - cursor.x) * 0.12)
        var t = 2.0
        while t <= dur {
            let s = t / dur, e = s < 0.5 ? 4 * s * s * s : 1 - pow(-2 * s + 2, 3) / 2
            let b = 4 * e * (1 - e)
            path.append((t, CGPoint(x: cursor.x + (target.x - cursor.x) * e + bow.x * b, y: cursor.y + (target.y - cursor.y) * e + bow.y * b)))
            t += 2
        }
    }
    if path.isEmpty { path = [(0, target)] }
    let k = options.timeScale
    func at(_ s: Double, _ f: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + s * k, execute: f) }
    let moveAt = 0.3, moveDur = (path.last?.0 ?? 0) / 1000
    at(moveAt) {
        let t0 = nowMs()
        var j = 0
        Timer.scheduledTimer(withTimeInterval: 0.002, repeats: true) { tm in
            let el = (nowMs() - t0) / k
            while j < path.count - 1 && path[j + 1].0 <= el { j += 1 }
            veil.pointerMoved(path[j].1)
            if j >= path.count - 1 { tm.invalidate() }
        }
    }
    let land = moveAt + moveDur + 0.15
    at(land) { veil.pressed(at: path.last?.1 ?? target) }
    if let m = model {
        at(0.15) { m.finish("hold") }
        at(moveAt) { m.begin("move", est: moveDur * 1000 + 150) }
        at(land) { m.begin("press", est: 150) }
        at(land + 0.15) { m.finish("press") }
        for i in 0..<m.charsTotal { at(land + 0.45 + Double(i) * 0.2) { m.addChars(1) } }
        let typed = land + 0.45 + Double(m.charsTotal) * 0.2
        at(typed) { m.begin("confirm") }
        at(min(typed + 0.4, S - 0.8)) { m.begin("restore") }
        at(S - 0.6) { m.allDone() }
    }
    let room = panel ? 0 : S - 0.6 - land
    if room > 0.6 { at(land + 0.5) { veil.nudge() } }
    if room > 1.0 { at(land + 0.9) { veil.escFirst() } }
    at(S - 0.55) { veil.pointerReturned(to: cursor) }
    at(S - 0.5) { veil.dismiss() }
    // Main-thread smoothness: how late a 2 ms timer gets (a stall here is a stall of the halo).
    final class Gaps { var last = 0.0, max = 0.0, over8 = 0, over17 = 0, n = 0 }
    let gaps = Gaps()
    let probe = Timer.scheduledTimer(withTimeInterval: 0.002, repeats: true) { _ in
        let t = nowMs()
        if gaps.last > 0 {
            let g = t - gaps.last
            gaps.n += 1
            gaps.max = max(gaps.max, g)
            if g > 8.3 { gaps.over8 += 1 }
            if g > 16.7 { gaps.over17 += 1 }
        }
        gaps.last = t
    }
    let t0 = nowMs()
    while !(veil.dismissed && veil.gone) && nowMs() - t0 < min(S * k * 1000, demoCapS * 1000) + 3000 {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005))
    }
    probe.invalidate()
    emit(["ok": true, "primeMs": r2(veil.primeMs), "showMs": r2(veil.showMs), "showWithSettleMs": r2(showWithSettle), "mode": veil.mode,
          "screens": veil.screens.count, "lang": veil.copy.zh ? "zh" : "en", "dark": veil.theme.dark,
          "continuous": veil.continuous, "reduceMotion": options.reduceMotion, "contrast": options.increaseContrast,
          "pathPoints": path.count, "haloCommits": veil.applies,
          "mainThread": ["ticks": gaps.n, "maxGapMs": r2(gaps.max), "gapsOver8ms": gaps.over8, "gapsOver17ms": gaps.over17],
          "totalMs": r2(nowMs() - t0)])
    exit(0)
}

// MARK: - veilsnap: the panel rendered offscreen (no window, no tap, nothing on screen)

func writePNG(_ img: CGImage, _ path: String) -> Bool {
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, img, nil)
    return CGImageDestinationFinalize(dest)
}

/// A sample model: a reply typed key by key into a field, step 3 of 7.
func snapModel(_ zh: Bool, chars: Int = 54) -> PanelModel {
    let L = { (z: String, e: String) -> [String: String] in ["zh": z, "en": e] }
    let d: [String: Any] = [
        "who": "Claude · demo", "color": 1, "task": L("给供应商回信", "Reply to the supplier"), "step": "3/7",
        "action": L("正在输入到「正文」", "Typing into \"Message\""), "chars": chars, "perChar": true, "showCount": true,
        "stages": [
            ["key": "hold", "label": L("接管键盘鼠标", "Hold keyboard and mouse"), "est": 150],
            ["key": "focus", "label": L("把网页切到前面", "Bring the page forward"), "est": 300],
            ["key": "move", "label": L("移动鼠标到输入框", "Move to the field"), "est": 700, "paced": true],
            ["key": "press", "label": L("点一下输入框", "Click the field"), "est": 150, "paced": true],
            ["key": "type", "label": L("逐键输入 \(chars) 个字", "Type \(chars) characters"), "est": chars * 260, "paced": true],
            ["key": "confirm", "label": L("确认输入框里有了", "Check the field"), "est": 300],
            ["key": "restore", "label": L("还原你的窗口和光标", "Put your windows and pointer back"), "est": 250]
        ] as [[String: Any]]
    ]
    return PanelModel(d, zh: zh)!
}

/// Synthetic visible-message fixtures for offscreen rendering only.
func snapPlanModel(_ zh: Bool) -> PanelModel {
    let L = { (z: String, e: String) -> [String: String] in ["zh": z, "en": e] }
    let d: [String: Any] = ["who": "AI · demo", "color": 1, "task": L("核对表格", "Review the sheet"), "step": "",
        "action": L("正在查看页面", "Reading the page"), "feedMode": true, "feedStatus": "connected",
        "feedEntries": zh
            ? ["我会先查看表格内容，再核对缺少的信息。",
               "前两行的金额已核对。第三行缺少地址，我正在查看对应的订单，确认是否需要补充。",
               "这一段是用于排版测试的示例文字。新消息保持原文，自动换行，并随会话更新滚动。"]
            : ["I will read the sheet and check the missing information.",
               "The amounts in the first two rows match. The third row has no address, so I am checking its order.",
               "This is synthetic layout test text. New messages keep their original wording, wrap, and scroll as the conversation updates."]]
    return PanelModel(d, zh: zh)!
}

/// Whether a sample model was built in Chinese (its first stage label).
func zhSample(_ m: PanelModel) -> Bool { m.stages.first.map { $0.label.unicodeScalars.contains { $0.value > 0x2E80 } } ?? true }

/// The sample states: (name, set up the model, card mode).
func snapFrames() -> [(String, (PanelModel) -> Void, Bool)] {
    func elapsed(_ m: PanelModel, _ ms: Double) { m.t0 = nowMs() - ms; m.last = nowMs() }
    return [
        ("start", { m in m.begin("hold"); m.stages[0].spent = 60; elapsed(m, 60) }, false),
        ("moving", { m in m.finish("hold"); m.begin("move", est: 900); m.stages[2].spent = 420; elapsed(m, 900) }, false),
        ("typing", { m in m.begin("type"); m.charsDone = 23; m.stages[4].spent = 23 * 250; m.speed = 1.5; elapsed(m, 7600) }, false),
        ("done", { m in m.charsDone = 54; m.allDone(); elapsed(m, 15800) }, false),
        ("failed", { m in m.begin("type"); m.charsDone = 23; m.fail(); elapsed(m, 7600) }, false),
        ("card", { m in m.begin("move", est: 900); m.stages[2].spent = 300; elapsed(m, 800) }, true),
        ("plan", { m in m.last = nowMs() }, true),
        // Two other agents' tasks wait for the mouse (neutral sample names).
        ("queued", { m in m.finish("hold"); m.begin("move", est: 900); m.stages[2].spent = 420; elapsed(m, 900)
            m.queue = m.who.isEmpty ? [] : [zhSample(m) ? "Codex · demo：导出订单表" : "Codex · demo: export the orders", "Claude · notes"] }, false)
    ]
}

/// `veilsnap --out sheet.png`: every sample state, dark row above light row, as on screen (title,
/// subline, panel, hint; the card frame as when Chrome fills the screen). The frost is a flat tone:
/// NSVisualEffectView cannot be rendered offscreen. Returns each frame's layout and any overlap.
func runVeilSnap(out: String, scale: CGFloat, zh: Bool, only: Set<String>? = nil) -> [String: Any] {
    NSApplication.shared.setActivationPolicy(.prohibited)
    let copy = VeilCopy(zh: zh)
    let frames = snapFrames().filter { only == nil || only!.contains($0.0) }
    struct Cell { let layer: CALayer; let size: CGSize; let info: [String: Any] }
    var rows: [[Cell]] = []
    var cellW: CGFloat = 0, cellH: CGFloat = 0
    for dark in [true, false] {
        let theme = VeilTheme(dark: dark, contrast: false)
        let assets = VeilAssets(scale: scale, theme: theme, copy: copy)
        var row: [Cell] = []
        for (name, setup, card) in frames {
            let m = name == "plan" ? snapPlanModel(zh) : snapModel(zh)
            setup(m)
            let hint = VeilHint(assets, theme)
            let panel = VeilPanel(theme: theme, zh: zh, scale: scale, reduceMotion: true)
            panel.build(m)
            panel.update(m)
            let (subImg, subText) = veilSubImage(m.action, card ? 15 : 17, card ? panel.size.width : 520, theme, scale)
            let tt = card ? assets.titleSmallText : assets.titleText
            let titleImg = card ? assets.titleSmall : assets.title
            let pad: CGFloat = card ? 18 : 0
            let bw = max(tt.width, subText.width, hint.extent, panel.size.width) + 2 * pad
            let bh = pad + tt.height + (subImg != nil ? (card ? 4 : 6) + subText.height : 0) + (card ? 10 : 14) + panel.size.height
                + (card ? 12 : 14) + hint.size.height + pad
            let margin: CGFloat = 28
            let box = CALayer()
            box.bounds = CGRect(x: 0, y: 0, width: ceil(bw + 2 * margin), height: ceil(bh + 2 * margin))
            box.backgroundColor = dark ? srgb(0x2A2A30) : srgb(0xE6E6EC)
            let block = CALayer()
            block.frame = CGRect(x: margin, y: margin, width: bw, height: bh)
            if card {
                block.backgroundColor = dark ? srgb(0x3A3A42, 0.92) : srgb(0xF7F7FA, 0.92)
                block.cornerRadius = 20
            }
            box.addSublayer(block)
            func put(_ l: CALayer, _ size: CGSize, _ c: CGPoint) {
                l.frame = CGRect(x: ((c.x - size.width / 2) * scale).rounded() / scale, y: ((c.y - size.height / 2) * scale).rounded() / scale,
                                 width: size.width, height: size.height)
                block.addSublayer(l)
            }
            var top = pad
            let title = CALayer()
            title.contents = titleImg?.image
            title.contentsScale = scale
            put(title, titleImg?.size ?? .zero, CGPoint(x: bw / 2, y: bh - top - tt.height / 2))
            top += tt.height
            let sub = CALayer()
            if let s = subImg {
                top += card ? 4 : 6
                sub.contents = s.image
                sub.contentsScale = scale
                put(sub, s.size, CGPoint(x: bw / 2, y: bh - top - subText.height / 2))
            }
            panel.plain = card
            put(panel.layer, panel.size, CGPoint(x: bw / 2, y: pad + hint.size.height + (card ? 12 : 14) + panel.size.height / 2))
            put(hint.layer, hint.size, CGPoint(x: bw / 2, y: pad + hint.size.height / 2))
            // Overlaps a reader would see: stacked blocks, and the parts inside the panel.
            var overlaps: [String] = []
            // The title's image has room for its glow around the text: the text box is what is read.
            let titleText = CGRect(x: bw / 2 - tt.width / 2, y: title.frame.midY - tt.height / 2, width: tt.width, height: tt.height)
            let stack: [(String, CGRect)] = [("title", titleText), ("sub", sub.frame), ("panel", panel.layer.frame), ("hint", hint.layer.frame)]
                .filter { !$0.1.isEmpty }
            for i in 0..<stack.count { for j in (i + 1)..<stack.count where stack[i].1.intersects(stack[j].1) { overlaps.append("\(stack[i].0)×\(stack[j].0)") } }
            var parts: [(String, CGRect)] = [("name", panel.name.frame), ("step", panel.stepL.frame), ("bar", panel.track.frame),
                                             ("eta", panel.eta.frame), ("pace", panel.pace.frame)]
            if !panel.taskL.isHidden { parts.append(("task", panel.taskL.frame)) }
            for (k, l) in panel.noteLayers.enumerated() { parts.append(("note\(k)", l.frame)) }
            for (k, l) in panel.labels.enumerated() { parts.append(("row\(k)", l.frame.union(panel.icons[k].frame))) }
            for (k, d) in panel.details.enumerated() where !d.frame.isEmpty { parts.append(("detail\(k)", d.frame)) }
            parts = parts.filter { !$0.1.isEmpty }
            for i in 0..<parts.count {
                for j in (i + 1)..<parts.count where parts[i].1.insetBy(dx: 0.5, dy: 0.5).intersects(parts[j].1.insetBy(dx: 0.5, dy: 0.5)) {
                    // A row's label and its own count share the row by design (left / right).
                    let a = parts[i].0, b = parts[j].0
                    if a.hasPrefix("row"), b == "detail" + a.dropFirst(3) { continue }
                    overlaps.append("\(a)×\(b)")
                }
            }
            let inside = parts.allSatisfy { CGRect(origin: .zero, size: panel.size).insetBy(dx: -0.5, dy: -0.5).contains($0.1) }
            if !inside { overlaps.append("outside_panel") }
            let info: [String: Any] = ["frame": name, "dark": dark, "mode": card ? "card" : "block",
                                       "block": [r2(bw), r2(bh)], "panel": [r2(panel.size.width), r2(panel.size.height)],
                                       "states": m.stages.map { $0.state.rawValue }, "eta": panel.etaText, "pace": panel.paceText,
                                       "fraction": r2(m.fraction()), "fillWidth": r2(panel.fill.bounds.width), "trackWidth": r2(panel.trackW),
                                       "overlaps": overlaps]
            cellW = max(cellW, box.bounds.width)
            cellH = max(cellH, box.bounds.height)
            row.append(Cell(layer: box, size: box.bounds.size, info: info))
        }
        rows.append(row)
    }
    let gap: CGFloat = 12
    let W = CGFloat(frames.count) * cellW + CGFloat(frames.count + 1) * gap, H = CGFloat(rows.count) * cellH + CGFloat(rows.count + 1) * gap
    guard let ctx = CGContext(data: nil, width: Int(W * scale), height: Int(H * scale), bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return ["ok": false, "error": "no_context"] }
    ctx.scaleBy(x: scale, y: scale)
    ctx.setFillColor(srgb(0x808088))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    var infos: [[String: Any]] = []
    for (ri, row) in rows.enumerated() {
        for (ci, c) in row.enumerated() {
            let x = gap + CGFloat(ci) * (cellW + gap), y = H - CGFloat(ri + 1) * (cellH + gap)
            ctx.saveGState()
            ctx.translateBy(x: x + (cellW - c.size.width) / 2, y: y + (cellH - c.size.height) / 2)
            c.layer.render(in: ctx)
            ctx.restoreGState()
            infos.append(c.info)
        }
    }
    guard let img = ctx.makeImage(), writePNG(img, out) else { return ["ok": false, "error": "write_failed", "out": out] }
    return ["ok": true, "out": out, "scale": scale, "lang": zh ? "zh" : "en", "size": [r2(W), r2(H)], "frames": infos]
}

// MARK: - input session (docs/impl-contract.md §1)

/// eventSourceUserData on every event a session posts ("CBRG"); anything the
/// tap sees without it is someone else's input (F19).
let SESSION_TAG: Int64 = 0x43425247
let DRYRUN_PASTEBOARD = "com.chromebridge.dryrun"

/// Keys and mouse buttons physically down right now, by name. Read from the hardware state: input
/// posted by a program (ours, another agent's) never shows here (measured 2026-10-13).
func hardwareHeld() -> [String] {
    var out: [String] = []
    for b in 0..<32 where CGEventSource.buttonState(.hidSystemState, button: CGMouseButton(rawValue: UInt32(b))!) {
        out.append(b == 0 ? "鼠标左键" : b == 1 ? "鼠标右键" : "鼠标键 \(b + 1)")
    }
    // Caps Lock (57) reads as down for as long as it is ON (measured 2026-10-03: the IME switch
    // key on this machine) — a toggle, not a key being held.
    for k in 0..<128 where k != 57 && CGEventSource.keyState(.hidSystemState, key: CGKeyCode(k)) { out.append(heldKeyName(k)) }
    return out
}

/// A key's name for a message, by macOS virtual key code; others by number.
func heldKeyName(_ k: Int) -> String {
    let names: [Int: String] = [55: "左 ⌘", 54: "右 ⌘", 56: "左 ⇧", 60: "右 ⇧", 58: "左 ⌥", 61: "右 ⌥", 59: "左 ⌃", 62: "右 ⌃",
                                63: "fn", 36: "回车", 49: "空格", 53: "Esc", 48: "Tab", 51: "删除"]
    return names[k] ?? "键码 \(k)"
}

enum Halt: Error {
    case interrupted, terminated, aborted
    case guardFailed(String)
    case bad(String, String)
}

/// The number of the window a press at `p` would land on (front to back): the
/// first layer-0 window, or a window above layer 0 that belongs to another app
/// (it would take the click). Chrome's own small helper windows (status
/// bubble, tooltips) are skipped; filters otherwise as topOwner().
func cgWindowNumberAt(_ p: CGPoint, chromePid: pid_t) -> Int? {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in raw {
        guard let bd = w[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: bd), within(p, r) else { continue }
        let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
        let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
        let pid = pid_t((w[kCGWindowOwnerPID as String] as? Int) ?? 0)
        if ((w[kCGWindowAlpha as String] as? Double) ?? 1) <= 0.05 || r.width < 2 || r.height < 2 { continue }
        if owner == "Window Server" || owner.isEmpty { continue }
        if layer < 0 || layer > MAX_WINDOW_LAYER { continue }
        if pid == chromePid && (r.width < 100 || r.height < 100) { continue }
        if layer == 0 || pid != chromePid { return w[kCGWindowNumber as String] as? Int }
    }
    return nil
}

/// The frontmost layer-0 window owned by `chromePid` in CGWindowList order.
func cgFrontWindowOf(_ chromePid: pid_t) -> Int? {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in raw {
        guard pid_t((w[kCGWindowOwnerPID as String] as? Int) ?? 0) == chromePid,
              ((w[kCGWindowLayer as String] as? Int) ?? 0) == 0,
              ((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0.05,
              let bd = w[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: bd), r.width >= 100, r.height >= 100 else { continue }
        return w[kCGWindowNumber as String] as? Int
    }
    return nil
}

func flagNames(_ f: CGEventFlags) -> [String] {
    var out: [String] = []
    if f.contains(.maskShift) { out.append("shift") }
    if f.contains(.maskCommand) { out.append("cmd") }
    if f.contains(.maskControl) { out.append("ctrl") }
    if f.contains(.maskAlternate) { out.append("alt") }
    return out
}

func flagsFrom(_ names: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for n in names {
        switch n {
        case "shift": f.insert(.maskShift)
        case "cmd": f.insert(.maskCommand)
        case "ctrl": f.insert(.maskControl)
        case "alt": f.insert(.maskAlternate)
        default: break
        }
    }
    return f
}

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
func pointArg(_ v: Any?) -> CGPoint? {
    guard let d = v as? [String: Any], let x = num(d["x"]), let y = num(d["y"]) else { return nil }
    return CGPoint(x: x, y: y)
}
func rectArg(_ v: Any?) -> CGRect? {
    guard let d = v as? [String: Any], let x = num(d["x"]), let y = num(d["y"]),
          let w = num(d["w"]), let h = num(d["h"]), w >= 1, h >= 1 else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}
func pointJSON(_ p: CGPoint) -> [String: Any] { ["x": r2(p.x), "y": r2(p.y)] }

func writeLine(_ dict: [String: Any]) {
    let obj: [String: Any] = JSONSerialization.isValidJSONObject(dict) ? dict : ["ok": false, "error": "internal", "message": "unserializable reply"]
    guard var data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
    data.append(0x0A)
    data.withUnsafeBytes { buf in
        var off = 0
        while off < buf.count {
            let n = write(1, buf.baseAddress! + off, buf.count - off)
            if n <= 0 { break }
            off += n
        }
    }
}

var gSession: Session?
var gTap: CFMachPort?
var gRouteTap: CFMachPort?
var gTakeoverTap: CFMachPort?

/// Takeover (begin with takeover:true): an ACTIVE tap at the HID level drops
/// every event this session did not post, so the user's keyboard and mouse
/// (pointer included: dropped there, the cursor does not move — measured
/// 2026-10-02, experiments/takeover.swift) cannot reach any app while the
/// action runs. Esc pressed twice gives control back and aborts the action.
let takeoverCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        // The system stopped the tap: input got through in between. Not re-armed silently:
        // the hold is lost, so the action stops (takeover_expired).
        gSession?.recordTapDisabled(type)
        return Unmanaged.passUnretained(event)
    }
    gSession?.noteRunLoopService()
    guard let s = gSession, s.holding, event.getIntegerValueField(.eventSourceUserData) != SESSION_TAG else {
        return Unmanaged.passUnretained(event)
    }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    let isEsc = code == 53
    if s.releasePending && type == .keyUp && isEsc { s.releaseTakeover("esc"); return nil }
    // ↑/↓: the user asks for a faster or slower pace (dropped like the rest, not counted as held input).
    if (code == 126 || code == 125) && (type == .keyDown || type == .keyUp) {
        if type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { s.changeSpeed(code == 126 ? 1 : -1) }
        return nil
    }
    var dx = 0.0, dy = 0.0
    if type == .mouseMoved || type == .leftMouseDragged || type == .rightMouseDragged || type == .otherMouseDragged {
        dx = event.getDoubleValueField(.mouseEventDeltaX)
        dy = event.getDoubleValueField(.mouseEventDeltaY)
    }
    s.swallow(type, esc: type == .keyDown && isEsc && event.getIntegerValueField(.keyboardEventAutorepeat) == 0, dx: dx, dy: dy)
    return nil
}

let routeCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        gSession?.navigationHistory.invalidate()
        if let t = gRouteTap { CGEvent.tapEnable(tap: t, enable: true) }
    } else if event.getIntegerValueField(.eventSourceUserData) == SESSION_TAG, let s = gSession {
        if type == .keyDown || type == .keyUp || type == .flagsChanged {
            s.keysRouted += 1
            s.routedPids.append(event.getIntegerValueField(.eventTargetUnixProcessID))
        }
    } else {
        gSession?.observeNavigation(type, event)
    }
    return Unmanaged.passUnretained(event)
}

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = gTap { CGEvent.tapEnable(tap: t, enable: true) }
    } else {
        gSession?.observe(type, userData: event.getIntegerValueField(.eventSourceUserData))
    }
    return Unmanaged.passUnretained(event)
}

/// What a dry-run session reads instead of the real system (`_fake`).
struct Fake {
    var frontPid: pid_t?
    var topWindow: Int?
    var frontChromeWindow: Int?
    var cursor: CGPoint?
    var userFlags: CGEventFlags = []
    var secureInput: String?
}

/// A bounded, in-memory attribution record: no key codes, text, titles, or URLs.
/// Routing evidence survives the user switching to a target window and away between JS polls.
struct NavigationInputHistory {
    var startedAt: Double?
    var reliable = true
    var latest: [String: Double] = [:]

    mutating func invalidate() { if startedAt != nil { reliable = false } }
    mutating func record(pid: Int, window: Int?, at: Double) {
        guard startedAt != nil else { return }
        guard pid > 0, at.isFinite else { reliable = false; return }
        let key = "\(pid):\(window.map(String.init) ?? "?")"
        if latest[key] == nil && latest.count >= 256 { reliable = false; return }
        latest[key] = max(latest[key] ?? 0, at)
    }
    func untouched(pid: Int, window: Int, since: Double) -> Bool {
        guard let start = startedAt, reliable, pid > 0, window > 0,
              since.isFinite, since >= start else { return false }
        return (latest["\(pid):\(window)"] ?? 0) <= since && (latest["\(pid):?"] ?? 0) <= since
    }
}

final class Session {
    let dry: Bool
    let t0 = nowMs()
    var monitor = false
    // Keyboard-class events we posted vs. seen at the annotated session tap,
    // where the system has already decided which process receives them.
    var keysPosted = 0
    /// Wall-clock time (epoch ms) of the last key or mouse-button event this session posted: the bridge
    /// counts key events up to it as its own, not the user's typing (end reply `lastPostedAt`).
    var lastKeyPostedAt: Double? = nil
    var keysRouted = 0
    var routedPids: [Int64] = []
    var begun = false
    var chromePid: pid_t = 0
    var window = 0
    var windowBounds = CGRect.null
    var rate = 2.0
    var interrupted: [String: Any]?
    var terminate = false

    // Takeover: holding = the user's input is being dropped right now.
    var takeover = false
    var holding = false
    var aborted = false
    var releasedBy: String?
    var swallowedKeys = 0, swallowedPointer = 0
    var escTimes: [Double] = []
    // The veil (never in a dry run) and what hold/begin told it.
    var veil: Veil?
    var veilRect: CGRect?
    var veilTarget: CGPoint?
    var veilLabel = ""
    var veilMs: Double?
    /// When the takeover tap began dropping the user's input (epoch ms; the hold reply's `heldAt`).
    var heldAt: Double?
    // Held pointer movement: shake-to-cancel and the 30 pt nudge.
    let shakeCancels = false
    var shakeDir = 0
    var shakeTravel = 0.0
    var shakeTimes: [Double] = []
    var moveAccum = 0.0
    // Liveness: the hold lasts while the action is working (an op running, or
    // requests still coming); idle longer than takeoverIdleMs → released.
    var opRunning = false
    var lastActivity = nowMs()
    // Esc-Esc seen: still holding until that Esc's key-up is dropped (else it would reach the
    // listen-only tap as the user's input), at most 0.4 s.
    var releasePending = false
    var fakeHeld = false
    var fakeHeldKeys: [Int] = []
    var abortedBy: String?

    // The progress panel (from hold/begin's veil; also in a dry run, without the veil) and the
    // pace chosen with ↑/↓ (scales every human pause and the movement's timeline).
    var panel: PanelModel?
    /// The latest `panel {queue}`: a panel that arrives later (a long job's next step) starts with it.
    var queueLabels: [String] = []
    var speed = 1.0
    var speedLoaded = false
    var configuredSpeed: Double?
    var speedSaveGeneration = 0
    var pendingSpeedSave: Int?
    var speedSaveState = "idle"

    // What this session holds down right now (§1.6).
    var heldMouse: (CGPoint, Int)?
    var heldShift = false, heldCmd = false
    var heldKey: (CGKeyCode, String?)?

    // Clipboard: the user's items, saved in memory until restoreClipboard.
    let pb: NSPasteboard
    var savedItems: [[(NSPasteboard.PasteboardType, Data)]] = []
    var ourChange = -1
    var pendingRestore = false

    // Dry run.
    var fake = Fake()
    var posted: [[String: Any]] = []
    var triggers: [[String: Any]] = []
    var progress: [String: Any] = [:]

    // stdin, filled by the reader thread.
    let lock = NSLock()
    var queue: [[String: Any]] = []
    var eof = false
    var signalSources: [DispatchSourceSignal] = []
    var navigationHistory = NavigationInputHistory()
    var navigationOnly = false
    // Bounded diagnostic metadata, never event contents, key codes, page text or titles.
    var lastRunLoopService = nowMs()
    var longestRunLoopGapMs = 0.0
    var currentOperation = "idle"
    var currentStage = "idle"
    var recentStage: [String: Any]?
    var slowestStage: [String: Any]?
    var slowestStageMs = 0.0
    var tapFailure: [String: Any]?

    /// A dry run never touches the general pasteboard. CGEVENT_DRYRUN_PASTEBOARD
    /// may name a per-run pasteboard for parallel tests, only under the same prefix.
    init(dry: Bool) {
        self.dry = dry
        if dry {
            let custom = ProcessInfo.processInfo.environment["CGEVENT_DRYRUN_PASTEBOARD"] ?? ""
            let name = custom.hasPrefix(DRYRUN_PASTEBOARD + ".") ? custom : DRYRUN_PASTEBOARD
            pb = NSPasteboard(name: NSPasteboard.Name(name))
        } else {
            pb = NSPasteboard.general
        }
    }

    func ms() -> Double { r2(nowMs() - t0) }

    /// Measure synchronous sections which share the active tap's main run loop.
    /// The measurements identify stalls; they never re-enable a disabled hold.
    func measuredStage<T>(_ name: String, _ body: () throws -> T) rethrows -> T {
        let previous = currentStage, start = nowMs()
        currentStage = name
        defer {
            let duration = nowMs() - start
            let record: [String: Any] = ["stage": name, "ms": r2(duration), "at": ms()]
            recentStage = record
            if duration > slowestStageMs { slowestStageMs = duration; slowestStage = record }
            currentStage = previous
        }
        return try body()
    }

    func noteRunLoopService() {
        let stamp = nowMs()
        longestRunLoopGapMs = max(longestRunLoopGapMs, stamp - lastRunLoopService)
        lastRunLoopService = stamp
    }

    func recordTapDisabled(_ type: CGEventType) {
        // Creating the disabled tap in prime can notify before a hold exists. A notification
        // after release must also preserve the first failure; only a live hold can be lost.
        guard holding else { return }
        let stamp = nowMs()
        tapFailure = ["reason": type == .tapDisabledByTimeout ? "timeout" : "user_input",
                      "operation": currentOperation, "stage": currentStage,
                      "runLoopGapMs": r2(max(0, stamp - lastRunLoopService)),
                      "longestRunLoopGapMs": r2(max(longestRunLoopGapMs, stamp - lastRunLoopService)),
                      "recentStage": recentStage ?? [:], "slowestStage": slowestStage ?? [:],
                      "at": ms()]
        releaseTakeover("tap_disabled")
    }

    // MARK: attribution

    func observe(_ type: CGEventType, userData: Int64) {
        guard begun, userData != SESSION_TAG else { return }
        let kind: String
        switch type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: kind = "move"
        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp: kind = "button"
        case .scrollWheel: kind = "wheel"
        case .keyDown, .keyUp: kind = "key"
        case .flagsChanged: kind = "flags"
        default: return
        }
        noteUser(kind)
    }

    /// The annotated tap gives the actual receiving process. Window identity is read at that
    /// event, not at a later JS poll; unknown routing is never accepted as agent navigation.
    func observeNavigation(_ type: CGEventType, _ event: CGEvent) {
        guard navigationOnly else { return }
        guard type == .keyDown || type == .leftMouseDown || type == .rightMouseDown ||
              type == .otherMouseDown || type == .scrollWheel else { return }
        let pid = Int(event.getIntegerValueField(.eventTargetUnixProcessID))
        let window: Int?
        if type == .keyDown {
            window = pid > 0 ? cgFrontWindowOf(pid_t(pid)) : nil
        } else {
            window = pid > 0 ? cgWindowNumberAt(event.location, chromePid: pid_t(pid)) : nil
        }
        navigationHistory.record(pid: pid, window: window, at: Date().timeIntervalSince1970 * 1000)
    }

    /// `interrupted` keeps the FIRST kind and when it was seen (`t` session ms,
    /// `epoch` wall-clock ms: nothing of ours is pressed after it). Observation
    /// continues after it: a hand that moves the mouse and then clicks shows
    /// up as kind "move" with `button: true` (a click is the user's choice of
    /// window, which must not be undone).
    func noteUser(_ kind: String) {
        if interrupted == nil {
            interrupted = ["kind": kind, "t": ms(), "epoch": (Date().timeIntervalSince1970 * 1000).rounded()]
        }
        if kind == "button" { interrupted?["button"] = true }
    }

    // MARK: takeover

    /// A user event dropped while holding. Esc twice within 0.8 s: release and abort. Runs in the
    /// tap callback: counters, flags and veil layer properties only.
    func swallow(_ type: CGEventType, esc: Bool, dx: Double = 0, dy: Double = 0) {
        switch type {
        case .keyDown:
            swallowedKeys += 1
            if !esc { veil?.nudge() }
        case .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel:
            swallowedPointer += 1
            veil?.nudge()
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            noteMove(dx, dy)
        default: break
        }
        guard esc, !releasePending else { return }
        let t = nowMs()
        escTimes = escTimes.filter { t - $0 < 800 } + [t]
        if escTimes.count >= 2 {
            aborted = true
            abortedBy = "esc"
            releasePending = true
            veil?.escSecond()
            Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in self?.releaseTakeover("esc") }
        } else {
            veil?.escFirst()
        }
    }

    /// Held pointer movement (the cursor stays put): the hint nudges every 30 pt. Shaking no longer
    /// cancels (removed 2026-10-06, owner: a frozen pointer makes people wiggle the mouse, which
    /// gave control back in the middle of a long job); Esc twice is the one way back.
    func noteMove(_ dx: Double, _ dy: Double) {
        moveAccum += hypot(dx, dy)
        if moveAccum > 30 { moveAccum = 0; veil?.nudge() }
        guard shakeCancels, dx != 0, holding, !releasePending else { return }
        let dir = dx > 0 ? 1 : -1
        if shakeDir == 0 || dir == shakeDir {
            shakeDir = dir
            shakeTravel += abs(dx)
            return
        }
        let counted = shakeTravel >= 12
        shakeDir = dir
        shakeTravel = abs(dx)
        guard counted else { return }
        let t = nowMs()
        shakeTimes = shakeTimes.filter { t - $0 < 1000 } + [t]
        veil?.shake(shakeTimes.count)
        if shakeTimes.count >= 4 {
            aborted = true
            abortedBy = "shake"
            releaseTakeover("shake")
            return
        }
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: false) { [weak self] _ in
            guard let s = self, s.shakeTimes.last == t else { return }
            s.shakeTimes = []
            s.veil?.shake(0)
        }
    }

    /// ↑ (+1) / ↓ (-1) while holding: the next pace step, shown on the panel and kept for the next
    /// actions and GUI. Runs in the tap callback: the file is written afterwards.
    func changeSpeed(_ dir: Int) {
        guard holding, !releasePending, panelSpeedFromEnvironment() == nil else { return }
        let s = panelSpeedStep(speed, dir)
        if s == speed { return }
        speed = s
        panel?.setSpeed(s)
        if !dry {
            speedSaveGeneration += 1
            let generation = speedSaveGeneration
            pendingSpeedSave = generation
            speedSaveState = "pending"
            panel?.setSpeedSaveState(speedSaveState)
            panelSpeedSaveQueue.async { [weak self] in
                let saved = savePanelSpeed(s)
                DispatchQueue.main.async { self?.finishSpeedSave(generation, saved: saved) }
            }
        }
    }

    func finishSpeedSave(_ generation: Int, saved: Bool) {
        guard pendingSpeedSave == generation else { return }
        pendingSpeedSave = nil
        speedSaveState = saved ? "saved" : "failed"
        // Another writer may have committed since our own save. Re-read its
        // value too; a failed save restores the durable preference explicitly.
        speedLoaded = false
        refreshSpeedSetting()
        panel?.setSpeedSaveState(speedSaveState)
    }

    /// Called before each input operation, so a GUI change reaches an existing
    /// whole-task hold without a new helper or another keyboard takeover.
    func refreshSpeedSetting() {
        guard pendingSpeedSave == nil else { return }
        let configured = configuredPanelSpeed(dry: dry)
        guard !speedLoaded || configured != configuredSpeed else { return }
        configuredSpeed = configured
        speed = configured ?? 1
        speedLoaded = true
        panel?.setSpeed(speed)
    }

    func settleSpeedSaveBeforeExit() {
        let deadline = Date().addingTimeInterval(1.1)
        while pendingSpeedSave != nil && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.005))
        }
        if let generation = pendingSpeedSave { finishSpeedSave(generation, saved: false) }
    }

    /// A human pause of `ms` at 1×, at the chosen pace, never shorter than `floor` (a press or key
    /// held for a few ms reads as a machine).
    func pace(_ ms: Double, floor: Double = 0) throws { try wait(max(min(ms, floor), ms / speed)) }

    /// Stop dropping the user's input and take the overlay down. From here on
    /// the listen-only tap attributes the user's input as before (interruption).
    func releaseTakeover(_ why: String) {
        guard holding else { return }
        holding = false
        releasePending = false
        releasedBy = why
        // Lost the hold for any reason but a normal end: the action stops here (only putting the
        // scene back, and releasing what we hold, stay allowed).
        if why != "end" && why != "eof" && why != "signal" && !aborted { aborted = true; abortedBy = why }
        if let t = gTakeoverTap { CGEvent.tapEnable(tap: t, enable: false) }
        veil?.dismiss()
    }

    /// A key or mouse button the user is holding down right now: holding would drop its release
    /// and leave their app thinking it is still down.
    /// Keys and mouse buttons down right now, by name (for the refusal: a key whose release was lost,
    /// e.g. across a screen lock or a KVM switch, reads as down until it is pressed again).
    func heldInputs() -> [String] {
        if dry { return !fakeHeldKeys.isEmpty ? fakeHeldKeys.map(heldKeyName) : (fakeHeld ? ["?"] : []) }
        return hardwareHeld()
    }
    func userHoldsInput() -> Bool { !heldInputs().isEmpty }

    /// Who holds Secure Event Input (a password field, Terminal's Secure Keyboard Entry, an app
    /// that leaks it), or nil. While it is on, no tap sees the keyboard, so nothing can be held.
    /// The system reports the app the holder runs under (measured: a CLI inside kitty → kitty).
    func secureInputHolder() -> String? {
        if dry { return (fake.secureInput?.isEmpty == false) ? fake.secureInput : nil }
        guard IsSecureEventInputEnabled() else { return nil }
        let d = (CGSessionCopyCurrentDictionary() as? [String: Any]) ?? [:]
        // The lock screen's password field holds it (as loginwindow): say so plainly.
        if (d["CGSSessionScreenIsLocked"] as? Bool) == true { return "锁屏界面" }
        guard let pid = (d["kCGSSessionSecureInputPID"] as? NSNumber)?.int32Value else { return "未知程序" }
        return NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid \(pid)"
    }

    func startTakeover(maxMs: Double, idleMs: Double, untilDone: Bool = false) throws {
        if let holder = secureInputHolder() { throw Halt.bad("secure_input", holder) }
        if dry, case let held = heldInputs(), !held.isEmpty { throw Halt.bad("input_held", "held: " + held.joined(separator: "、")) }
        refreshSpeedSetting()
        recentStage = nil; slowestStage = nil; slowestStageMs = 0
        lastRunLoopService = nowMs(); longestRunLoopGapMs = 0
        panel?.speed = speed
        panel?.speedSaveState = speedSaveState
        takeover = true
        holding = true
        lastActivity = nowMs()
        // Released when the action stops working (nothing running, no request for idleMs: the
        // caller is stuck). Explicit whole-task holds have no fixed wall-clock cutoff:
        // their owner must keep heartbeating; EOF, Stop and lost permissions still release.
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] t in
            guard let s = self else { t.invalidate(); return }
            if !s.holding { t.invalidate(); return }
            // The hold must still be real: keyboard visible to the tap, permission still granted.
            if s.secureInputHolder() != nil { s.releaseTakeover("secure_input"); return }
            if !s.dry && !AXIsProcessTrusted() { s.releaseTakeover("untrusted"); return }
            if !s.opRunning && nowMs() - s.lastActivity > idleMs { s.releaseTakeover("idle") }
        }
        if !untilDone {
            Timer.scheduledTimer(withTimeInterval: maxMs / 1000, repeats: false) { [weak self] _ in self?.releaseTakeover("timeout") }
        }
        if dry { panel?.finish("hold"); return }
        guard let tap = gTakeoverTap ?? makeTakeoverTap()
        else { holding = false; takeover = false; throw Halt.bad("no_takeover_tap", "active HID event tap could not be created") }
        gTakeoverTap = tap
        CGEvent.tapEnable(tap: tap, enable: true)
        heldAt = Date().timeIntervalSince1970 * 1000
        // Checked only once the tap holds: a down that slipped in before it is seen here
        // (and refused), one after it is dropped together with its up.
        let held = heldInputs()
        if !held.isEmpty {
            CGEvent.tapEnable(tap: tap, enable: false)
            gTakeoverTap = nil
            holding = false; takeover = false
            throw Halt.bad("input_held", "held: " + held.joined(separator: "、"))
        }
        measuredStage("overlay_show") { showOverlay() }
        // Ticked just after the entrance, so the first stage visibly turns green.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in self?.panel?.finish("hold") }
    }

    /// The active HID tap, created disabled (enabled by startTakeover).
    func makeTakeoverTap() -> CFMachPort? {
        var mask: UInt64 = 0
        let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                    .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged,
                                    .otherMouseDragged, .scrollWheel, .keyDown, .keyUp, .flagsChanged]
        for t in types { mask |= 1 << UInt64(t.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                                          eventsOfInterest: CGEventMask(mask), callback: takeoverCallback, userInfo: nil)
        else { return nil }
        CGEvent.tapEnable(tap: tap, enable: false)
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
        return tap
    }

    /// `prime`: build the tap (disabled) and the veil (hidden) while the caller is still
    /// locating its target, so `hold` only has to switch them on.
    func opPrime() -> [String: Any] {
        if dry { return ["ok": true] }
        if gTakeoverTap == nil { gTakeoverTap = makeTakeoverTap() }
        if veil == nil { measuredStage("overlay_prime") { veil = Veil() } }
        return ["ok": true, "veilPrimeMs": r2(veil?.primeMs ?? 0)]
    }

    /// The veil (src: Veil) on every screen, ignoring the mouse (our events pass through; above
    /// layer 19, so the window guards skip it) and non-opaque with a clear hole over Chrome (the
    /// page stays "visible" under it — measured), with how to get control back.
    func showOverlay() {
        let t0 = nowMs()
        if veil == nil { veil = Veil() }
        panel?.onChange = { [weak self] in self?.veil?.panelChanged() }
        veil?.show(rect: veilRect ?? (windowBounds.isNull ? nil : windowBounds), label: veilLabel,
                   target: veilTarget, cursor: currentMouse(), model: panel)
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005))
        veilMs = r2(nowMs() - t0)
    }

    /// `veil: {rect: {x,y,w,h} (CG, the Chrome window), label: "…" | {zh, en}, point: {x,y}}`
    /// from hold or begin: the hole, the subline (one line, middle-truncated) and the target point.
    func takeVeil(_ v: Any?) {
        guard let d = v as? [String: Any] else { return }
        if let r = rectArg(d["rect"]) { veilRect = r }
        if let p = pointArg(d["point"]) { veilTarget = p }
        if let s = d["label"] as? String {
            veilLabel = s
        } else if let m = d["label"] as? [String: Any] {
            veilLabel = (m[VeilCopy.system.zh ? "zh" : "en"] as? String) ?? (m["en"] as? String) ?? ""
        }
        if panel == nil, let p = d["panel"] as? [String: Any], let m = PanelModel(p) {
            m.speed = speed
            m.speedSaveState = speedSaveState
            if m.queue.isEmpty { m.queue = queueLabels }
            panel = m
        }
    }

    func takeoverJSON() -> [String: Any] {
        var out: [String: Any] = ["active": holding, "releasedBy": releasedBy ?? NSNull(), "aborted": aborted, "abortedBy": abortedBy ?? NSNull(),
                                 "swallowedKeys": swallowedKeys, "swallowedPointer": swallowedPointer]
        if let failure = tapFailure { out["tapDiagnostic"] = failure }
        return out
    }

    func installTap() {
        if dry { monitor = true; return }
        var mask: UInt64 = 0
        let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                    .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged,
                                    .otherMouseDragged, .scrollWheel, .keyDown, .keyUp, .flagsChanged]
        for t in types { mask |= 1 << UInt64(t.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                          eventsOfInterest: CGEventMask(mask), callback: tapCallback, userInfo: nil)
        else { return }
        gTap = tap
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        monitor = true
        let routedTypes: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown,
                                        .otherMouseDown, .scrollWheel]
        let kmask = routedTypes.reduce(UInt64(0)) { $0 | (1 << UInt64($1.rawValue)) }
        if let rt = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                      eventsOfInterest: CGEventMask(kmask), callback: routeCallback, userInfo: nil) {
            gRouteTap = rt
            CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, rt, 0), .commonModes)
            CGEvent.tapEnable(tap: rt, enable: true)
        }
    }

    // MARK: waiting

    func checkStop() throws {
        if aborted { throw Halt.aborted }
        if interrupted != nil { throw Halt.interrupted }
        lock.lock(); let gone = eof; lock.unlock()
        if terminate || gone { throw Halt.terminated }
    }

    /// Run-loop wait in ≤5 ms slices, so the tap, NSWorkspace and signal
    /// handlers are serviced; any interruption ends it at once.
    func waitUntil(_ deadline: Double) throws {
        while true {
            try checkStop()
            let left = deadline - nowMs()
            if left <= 0 { return }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: min(5, left) / 1000))
            drainControl()
        }
    }
    func wait(_ ms: Double) throws { try waitUntil(nowMs() + ms) }

    // MARK: system state (real, or `_fake` in a dry run)

    func cursor() -> CGPoint {
        if dry { return fake.cursor ?? CGPoint(x: windowBounds.isNull ? 0 : windowBounds.midX,
                                               y: windowBounds.isNull ? 0 : windowBounds.midY) }
        return currentMouse()
    }
    func frontPid() -> pid_t? { dry ? (fake.frontPid ?? chromePid) : NSWorkspace.shared.frontmostApplication?.processIdentifier }
    func topWindow(at p: CGPoint) -> Int? { dry ? (fake.topWindow ?? window) : cgWindowNumberAt(p, chromePid: chromePid) }
    func frontChromeWindow() -> Int? { dry ? (fake.frontChromeWindow ?? fake.topWindow ?? window) : cgFrontWindowOf(chromePid) }
    /// Cmd/Ctrl/Opt held by someone else: our next key or click would become a shortcut.
    func foreignModifiers() -> Bool {
        let state = dry ? fake.userFlags : CGEventSource.flagsState(.hidSystemState)
        var relevant: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate]
        if heldCmd { relevant.remove(.maskCommand) }
        return !state.intersection(relevant).isEmpty
    }

    // MARK: guards (§1.2) — each is followed by its event with no wait between

    func guardKeys() throws {
        try checkStop()
        if frontPid() != chromePid { throw Halt.guardFailed("not_frontmost") }
        if frontChromeWindow() != window { throw Halt.guardFailed("key_window") }
        if foreignModifiers() { throw Halt.guardFailed("modifier_held") }
    }
    func guardPress(at p: CGPoint, checkCursor: Bool = true) throws {
        try checkStop()
        if frontPid() != chromePid { throw Halt.guardFailed("not_frontmost") }
        if topWindow(at: p) != window { throw Halt.guardFailed("window_not_top") }
        if foreignModifiers() { throw Halt.guardFailed("modifier_held") }
        if checkCursor && dist(cursor(), p) > 1.5 { throw Halt.guardFailed("cursor_moved") }
    }
    func guardWheel(at p: CGPoint) throws {
        try checkStop()
        if topWindow(at: p) != window { throw Halt.guardFailed("window_not_top") }
    }

    // MARK: posting

    var heldFlags: CGEventFlags {
        var f: CGEventFlags = []
        if heldShift { f.insert(.maskShift) }
        if heldCmd { f.insert(.maskCommand) }
        return f
    }

    func send(_ e: CGEvent?, _ rec: [String: Any]) {
        guard let e = e else { return }
        if e.type == .keyDown || e.type == .leftMouseDown || e.type == .scrollWheel {
            progress["postedInput"] = ((progress["postedInput"] as? Int) ?? 0) + 1
        }
        defer {
            if [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp].contains(e.type) {
                lastKeyPostedAt = Date().timeIntervalSince1970 * 1000
            }
        }
        if dry {
            var r = rec
            r["t"] = ms()
            posted.append(r)
            if e.type == .mouseMoved { fake.cursor = e.location }
            let n = posted.count
            fire { ($0["afterPosted"] as? NSNumber)?.intValue == n }
            return
        }
        e.setIntegerValueField(.eventSourceUserData, value: SESSION_TAG)
        if e.type == .keyDown || e.type == .keyUp || e.type == .flagsChanged { keysPosted += 1 }
        e.post(tap: .cghidEventTap)
    }
    func sendMove(_ p: CGPoint) {
        send(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left),
             ["type": "mouseMoved", "x": r2(p.x), "y": r2(p.y)])
        veil?.pointerMoved(p)
    }
    func sendButton(_ down: Bool, _ p: CGPoint, clicks: Int) {
        let e = CGEvent(mouseEventSource: nil, mouseType: down ? .leftMouseDown : .leftMouseUp,
                        mouseCursorPosition: p, mouseButton: .left)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
        send(e, ["type": down ? "leftMouseDown" : "leftMouseUp", "x": r2(p.x), "y": r2(p.y), "clickState": clicks])
        if down { veil?.pressed(at: p) }
    }
    func sendKey(_ code: CGKeyCode, _ down: Bool, _ unicode: String?) {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
        e?.flags = heldFlags
        if let u = unicode {
            let units = Array(u.utf16)
            e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        }
        var rec: [String: Any] = ["type": down ? "keyDown" : "keyUp", "key": Int(code), "flags": flagNames(heldFlags)]
        if let u = unicode { rec["unicode"] = u }
        send(e, rec)
    }
    /// A modifier change is its own flagsChanged event; flags = state after it.
    func sendFlags(_ code: CGKeyCode) {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: !heldFlags.isEmpty)
        e?.type = .flagsChanged
        e?.flags = heldFlags
        send(e, ["type": "flagsChanged", "key": Int(code), "flags": flagNames(heldFlags)])
    }
    func sendWheel(_ delta: Int32, at p: CGPoint) {
        send(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0),
             ["type": "scrollWheel", "delta": Int(delta), "x": r2(p.x), "y": r2(p.y)])
    }

    /// §1.6: post the matching release for anything still held.
    func releaseHeld() -> [String] {
        var out: [String] = []
        if let (code, u) = heldKey { sendKey(code, false, u); heldKey = nil; out.append("key") }
        if heldShift { heldShift = false; sendFlags(kShift); out.append("shift") }
        if heldCmd { heldCmd = false; sendFlags(kCommand); out.append("cmd") }
        // At the pointer's position now, not the press point: after the user
        // grabbed the mouse, an up posted at the landing would pull the cursor
        // back there. On the normal path the two are the same (guardPress).
        if let (_, n) = heldMouse { sendButton(false, cursor(), clicks: n); heldMouse = nil; out.append("mouse") }
        return out
    }

    // MARK: stdin and control messages

    func startReader() {
        Thread {
            while let line = readLine() {
                if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
                self.lock.lock(); self.queue.append(obj ?? ["op": "__invalid"]); self.lock.unlock()
            }
            self.lock.lock(); self.eof = true; self.lock.unlock()
        }.start()
    }

    func isControl(_ r: [String: Any]) -> Bool {
        let op = r["op"] as? String ?? ""
        return op == "cancel" || (op.hasPrefix("_") && op != "__invalid")
    }

    /// `cancel` acts immediately in every session. The dry-run controls act even in
    /// the middle of an op; with "at" or "afterPosted" they wait for that point.
    func drainControl() {
        lock.lock()
        let ctl = queue.filter(isControl)
        queue.removeAll(where: isControl)
        lock.unlock()
        for c in ctl {
            if c["op"] as? String == "cancel" {
                applyControl(c)
            } else if !dry {
                writeLine(["ok": false, "op": c["op"] ?? "", "id": c["id"] ?? NSNull(), "error": "dryrun_only",
                           "interrupted": interrupted ?? NSNull()])
            } else if c["at"] != nil || c["afterPosted"] != nil {
                triggers.append(c)
            } else {
                applyControl(c)
            }
        }
    }

    func checkpoint(_ name: String) { if dry { fire { $0["at"] as? String == name } } }

    func fire(_ match: ([String: Any]) -> Bool) {
        let due = triggers.filter(match)
        if due.isEmpty { return }
        triggers.removeAll(where: match)
        for c in due { applyControl(c) }
    }

    func applyControl(_ c: [String: Any]) {
        let op = c["op"] as? String ?? ""
        var r: [String: Any] = ["ok": true]
        switch op {
        case "cancel":
            r = cancelInput()
        case "_navigationEvent":
            if c["unknown"] as? Bool == true { navigationHistory.invalidate() }
            else {
                navigationHistory.record(pid: Int(num(c["pid"]) ?? 0), window: num(c["window"]).map(Int.init),
                                         at: num(c["epoch"]) ?? Date().timeIntervalSince1970 * 1000)
            }
        case "_inject":
            let kind = c["kind"] as? String ?? "key"
            if kind == "tapDisabled" {
                // The native callback receives disable notifications before hold and after release too.
                recordTapDisabled(c["reason"] as? String == "user_input" ? .tapDisabledByUserInput : .tapDisabledByTimeout)
            } else if holding && kind == "escUp" && releasePending {
                releaseTakeover("esc")
                r["swallowed"] = true
            } else if holding && (kind == "speedUp" || kind == "speedDown") {
                // ↑ / ↓ pressed while held.
                changeSpeed(kind == "speedUp" ? 1 : -1)
                r["swallowed"] = true
                r["speed"] = speed
            } else if holding && kind == "shake" {
                // One held pointer move of `dx` (and `dy`) points: repeated, it is the shake gesture.
                swallow(.mouseMoved, esc: false, dx: num(c["dx"]) ?? 0, dy: num(c["dy"]) ?? 0)
                r["swallowed"] = true
            } else if holding {
                swallow(kind == "key" || kind == "esc" ? .keyDown : kind == "button" ? .leftMouseDown : .mouseMoved, esc: kind == "esc")
                r["swallowed"] = true
            } else if begun { noteUser(kind == "esc" ? "key" : kind == "shake" ? "move" : kind) }
        case "_fake":
            if let v = num(c["frontPid"]) { fake.frontPid = pid_t(v) }
            if let v = num(c["topWindow"]) { fake.topWindow = Int(v) }
            if let v = num(c["frontChromeWindow"]) { fake.frontChromeWindow = Int(v) }
            if let p = pointArg(c["cursor"]) { fake.cursor = p }
            if let f = c["userFlags"] as? [String] { fake.userFlags = flagsFrom(f) }
            if let h = c["held"] as? Bool { fakeHeld = h }
            if let ks = c["heldKeys"] as? [NSNumber] { fakeHeldKeys = ks.map { $0.intValue } }
            if let si = c["secureInput"] as? String { fake.secureInput = si }
        case "_term":
            terminate = true
        case "_pb":
            if let items = c["set"] as? [[String: String]] {
                pb.clearContents()
                pb.writeObjects(items.map { d -> NSPasteboardItem in
                    let it = NSPasteboardItem()
                    for (t, s) in d { it.setData(Data(s.utf8), forType: NSPasteboard.PasteboardType(t)) }
                    return it
                })
            }
            r["items"] = (pb.pasteboardItems ?? []).map { item -> [String: String] in
                var d: [String: String] = [:]
                for t in item.types { d[t.rawValue] = item.data(forType: t).map { String(decoding: $0, as: UTF8.self) } ?? "" }
                return d
            }
            r["changeCount"] = pb.changeCount
        default:
            r = ["ok": false, "error": "bad_request", "message": "unknown op \(op)"]
        }
        r["op"] = op
        r["id"] = c["id"] ?? NSNull()
        r["t"] = ms()
        r["interrupted"] = interrupted ?? NSNull()
        if takeover || aborted { r["takeover"] = takeoverJSON() }
        writeLine(r)
    }

    /// Cancel only this session, preserving any earlier native stop reason. Release our
    /// held keys before giving input back; the caller can still restore and close normally.
    func cancelInput() -> [String: Any] {
        if navigationOnly {
            return ["ok": false, "error": "observer_read_only", "message": "A navigation observer cannot control input."]
        }
        if !aborted { aborted = true; abortedBy = "caller_cancel" }
        let released = releaseHeld()
        let reason = abortedBy ?? "caller_cancel"
        releaseTakeover(reason)
        if releasedBy == nil { releasedBy = reason }
        panel?.fail()
        return ["ok": true, "cancelled": true, "released": released, "takeover": takeoverJSON()]
    }

    // MARK: main loop

    func run() -> Never {
        signal(SIGPIPE, SIG_IGN)
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            s.setEventHandler { [weak self] in self?.terminate = true }
            s.resume()
            signalSources.append(s)
        }
        // A port keeps RunLoop.run(until:) waiting (not returning at once) when no tap is installed.
        RunLoop.current.add(NSMachPort(), forMode: .default)
        installTap()
        let heartbeat = Timer(timeInterval: 0.025, repeats: true) { [weak self] _ in self?.noteRunLoopService() }
        RunLoop.current.add(heartbeat, forMode: .common)
        startReader()
        while true {
            drainControl()
            if terminate { finish("signal") }
            lock.lock()
            let req = queue.isEmpty ? nil : queue.removeFirst()
            let gone = eof
            lock.unlock()
            if let r = req {
                opRunning = true
                lastActivity = nowMs()
                handle(r)
                opRunning = false
                lastActivity = nowMs()
                continue
            }
            if gone { finish("eof") }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005))
        }
    }

    func reply(_ req: [String: Any], _ body: [String: Any]) {
        var r = body
        r["op"] = req["op"] ?? NSNull()
        if let id = req["id"] { r["id"] = id }
        r["interrupted"] = interrupted ?? NSNull()
        if takeover || aborted { r["takeover"] = takeoverJSON() }
        if dry { r["posted"] = posted }
        if dry, let p = panel { r["panel"] = p.json() }
        writeLine(r)
    }

    func handle(_ req: [String: Any]) {
        posted = []
        progress = ["postedInput": 0]
        let op = req["op"] as? String ?? ""
        currentOperation = ["watchNavigation", "navigationState", "begin", "hold", "prime", "click", "move", "wheel",
            "type", "key", "paste", "restoreClipboard", "status", "routed", "warp", "handBack", "panel", "veil", "end"].contains(op) ? op : "unknown"
        defer { currentOperation = "idle" }
        var r: [String: Any]
        do {
            if navigationOnly && op != "navigationState" && op != "end" {
                throw Halt.bad("observer_read_only", "A navigation observer cannot post input or take over.")
            }
            if ["click", "move", "wheel", "type", "key", "paste"].contains(op) { refreshSpeedSetting() }
            switch op {
            case "watchNavigation": r = try opWatchNavigation(req)
            case "navigationState": r = opNavigationState(req)
            case "begin": r = try opBegin(req)
            case "hold": r = try opHold(req)
            case "prime": r = opPrime()
            case "click": r = try opClick(req)
            case "move": r = try opMove(req)
            case "wheel": r = try opWheel(req)
            case "type": r = try opType(req)
            case "key": r = try opKey(req)
            case "paste": r = try opPaste(req)
            case "restoreClipboard": r = restoreClipboard()
            case "status": settle(); r = ["ok": true, "cursor": pointJSON(cursor()),
                "inputSpeed": ["value": speed, "saveState": speedSaveState]]
            case "routed": r = try opRouted(req)
            case "warp": r = try opWarp(req)
            case "handBack": r = try opHandBack(req)
            case "panel": r = opPanel(req)
            case "veil": r = opVeil(req)
            case "end": finish("end", req)
            default: r = ["ok": false, "error": "bad_request", "message": "unknown op \(op)"]
            }
        } catch let h as Halt {
            panel?.fail()
            r = progress
            r["ok"] = false
            switch h {
            case .interrupted: r["error"] = "interrupted"
            case .aborted: r["error"] = "aborted"
            case .terminated: r["error"] = "terminated"
            case .guardFailed(let why): r["error"] = "guard"; r["why"] = why
            case .bad(let code, let msg): r["error"] = code; r["message"] = msg
            }
            r["released"] = releaseHeld()
        } catch {
            r = ["ok": false, "error": "internal", "message": "\(error)", "released": releaseHeld()]
        }
        reply(req, r)
    }

    /// end / EOF / SIGTERM / SIGINT: release, put a pending clipboard back if
    /// unchanged, reply once, then stay only until the veil has faded out (≤ ~0.4 s;
    /// the caller does not wait for it), exit 0.
    func finish(_ reason: String, _ req: [String: Any] = ["op": "end"]) -> Never {
        posted = []
        // A normal end: whatever was left on the checklist is done (a failed one stays failed).
        if reason == "end" && !aborted { panel?.allDone() } else { panel?.fail() }
        releaseTakeover(reason)
        let released = releaseHeld()
        // Hand input back first, then give the latest arrow preference a bounded
        // chance to finish. Normal session exit must not drop an unacknowledged save.
        settleSpeedSaveBeforeExit()
        var restored: Any = NSNull()
        if pendingRestore { restored = restoreClipboard()["restored"] ?? NSNull() }
        reply(req, ["ok": true, "reason": reason, "released": released, "restored": restored,
                    "inputSpeed": ["value": speed, "saveState": speedSaveState],
                    "lastPostedAt": lastKeyPostedAt ?? NSNull()])
        if dry { pb.releaseGlobally() }
        veil?.waitUntilGone()
        exit(0)
    }

    // MARK: ops

    func opWatchNavigation(_ req: [String: Any]) throws -> [String: Any] {
        guard !begun, !holding, !navigationOnly else {
            throw Halt.bad("bad_request", "Navigation observation needs its own read-only session.")
        }
        guard dry || (monitor && gRouteTap != nil) else {
            throw Halt.bad("no_input_monitor", "Navigation routing evidence is unavailable.")
        }
        navigationOnly = true
        navigationHistory.startedAt = Date().timeIntervalSince1970 * 1000
        if !dry && IsSecureEventInputEnabled() { navigationHistory.invalidate() }
        // No overlay, hold, input, clipboard change, or persistent record. EOF/signals use the
        // normal session cleanup; the deadline also bounds an abandoned observer.
        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] timer in
            guard let s = self, s.navigationOnly else { timer.invalidate(); return }
            if !s.dry && IsSecureEventInputEnabled() { s.navigationHistory.invalidate() }
        }
        let maxMs = min(660_000, max(1000, num(req["maxMs"]) ?? 120_000))
        Timer.scheduledTimer(withTimeInterval: maxMs / 1000, repeats: false) { [weak self] _ in
            self?.navigationHistory.invalidate()
            self?.terminate = true
        }
        return ["ok": true, "startedAt": navigationHistory.startedAt!, "readOnly": true]
    }

    func opNavigationState(_ req: [String: Any]) -> [String: Any] {
        if !dry && (IsSecureEventInputEnabled() || gRouteTap == nil) { navigationHistory.invalidate() }
        let since = num(req["since"]) ?? navigationHistory.startedAt ?? 0
        let untouched = navigationOnly && navigationHistory.untouched(pid: Int(num(req["chromePid"]) ?? 0),
            window: Int(num(req["window"]) ?? 0), since: since)
        return ["ok": true, "known": navigationOnly && navigationHistory.reliable,
                "untouched": untouched, "startedAt": navigationHistory.startedAt ?? NSNull()]
    }

    /// Putting the user's scene back is still wanted after Esc-Esc (their input was held, nothing of theirs moved).
    func requireRestore() throws {
        let wasAborted = aborted
        aborted = false
        defer { aborted = wasAborted }
        try requireInput()
    }

    func requireInput() throws {
        if !monitor { throw Halt.bad("no_input_monitor", "listen-only event tap could not be created") }
        if !begun { throw Halt.bad("not_begun", "send begin first") }
        try checkStop()
    }

    /// Service the run loop once so a user event already queued at the tap
    /// is seen before a reply that reports `interrupted`.
    func settle() { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005)) }

    /// Put the pointer back (CGWarpMouseCursorPosition posts no event, F13),
    /// but only while the user has not touched anything: refused as
    /// `interrupted` otherwise, so the check and the warp are one step.
    func opWarp(_ req: [String: Any]) throws -> [String: Any] {
        settle()
        try requireRestore()
        panel?.begin("restore")
        guard let p = pointArg(req["to"]) else { throw Halt.bad("bad_request", "warp needs to {x,y}") }
        if dry {
            fake.cursor = p
        } else {
            CGWarpMouseCursorPosition(p)
            CGAssociateMouseAndMouseCursorPosition(1)
            veil?.pointerReturned(to: p)
        }
        return ["ok": true, "warped": pointJSON(p)]
    }

    /// Give the front back to the user's app from inside the running session
    /// (no new process: ~0.4 s saved per action, measured) — refused as
    /// `interrupted` once the user has touched anything, like warp.
    /// Wait until every keyboard event this session posted has been routed
    /// (seen at the annotated session tap, target process decided) — the
    /// point after which switching the front app can no longer redirect them.
    /// Atomic, no page polling (~20 ms measured vs ~220 ms reading the page).
    func opRouted(_ req: [String: Any]) throws -> [String: Any] {
        if dry { return ["ok": true, "posted": keysPosted, "routed": keysPosted, "allToChrome": true, "ms": 0, "dryRun": true] }
        let cap = Double(num(req["timeoutMs"]) ?? 150)
        let t0 = nowMs()
        while keysRouted < keysPosted && nowMs() - t0 < cap { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.002)) }
        let all = routedPids.allSatisfy { $0 == Int64(chromePid) }
        return ["ok": keysRouted >= keysPosted, "posted": keysPosted, "routed": keysRouted, "allToChrome": all,
                "ms": Int(nowMs() - t0), "pids": Array(Set(routedPids)).map { Int($0) }]
    }

    func opHandBack(_ req: [String: Any]) throws -> [String: Any] {
        settle()
        try requireRestore()
        panel?.begin("restore")
        guard let pid = num(req["pid"]) else { throw Halt.bad("bad_request", "handBack needs pid") }
        if dry { return ["ok": true, "frontmost": true, "dryRun": true] }
        guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
            return ["ok": false, "error": "no_such_app"]
        }
        app.activate(options: [])
        var waited = 0.0
        while waited < 400 && NSWorkspace.shared.frontmostApplication?.processIdentifier != pid_t(pid) {
            try wait(10); waited += 10
        }
        return ["ok": true, "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid), "waitedMs": waited]
    }

    /// `panel {stage, state: "run"|"done"|"fail"}` or `panel {fail: true}`: the caller's own steps on the
    /// checklist (page confirmed the text, putting things back, the action failed).
    func opPanel(_ req: [String: Any]) -> [String: Any] {
        if let q = req["queue"] as? [Any] {
            // `panel {queue: [...]}`: the tasks waiting for the mouse (index.js polls the lock queue).
            let zh = VeilCopy.system.zh
            queueLabels = q.map { panelText($0, zh: zh) }.filter { !$0.isEmpty }
            guard let p = panel else { return ["ok": true, "panel": false, "queue": queueLabels.count] }
            if p.queue != queueLabels {
                p.queue = queueLabels
                if holding { measuredStage("overlay_queue") { veil?.relabel(label: veilLabel, target: veilTarget, model: p) } }
            }
            return ["ok": true, "panel": true, "queue": queueLabels.count]
        }
        guard let p = panel else { return ["ok": true, "panel": false] }
        if p.feedMode, let entries = req["feedEntries"] as? [String] {
            p.feedEntries = Array(entries.suffix(16)).map { String($0.suffix(8000)) }
            p.feedStatus = req["feedStatus"] as? String ?? p.feedStatus
            if holding { measuredStage("overlay_feed") { veil?.relabel(label: veilLabel, target: veilTarget, model: p) } }
            return ["ok": true, "panel": true, "feedCount": p.feedEntries.count]
        }
        if req["fail"] as? Bool == true {
            p.fail()
        } else if let k = req["stage"] as? String {
            switch req["state"] as? String {
            case "done": p.finish(k)
            case "fail": p.fail(k)
            default: p.begin(k)
            }
        }
        return ["ok": true, "panel": true]
    }

    /// `veil {veil: {label?, rect?, point?, panel?}}` in a held session (a long job's next action):
    /// a new panel replaces the last (its hold already done); without one the panel waits for the
    /// agent's next step. The veil is laid out again in place.
    func opVeil(_ req: [String: Any]) -> [String: Any] {
        if let h = req["hidden"] as? Bool { veil?.setHidden(h); return ["ok": true, "held": holding, "hidden": h] }
        guard let d = req["veil"] as? [String: Any] else { return ["ok": true] }
        if let p = d["panel"] as? [String: Any], let m = PanelModel(p) {
            m.speed = speed
            m.speedSaveState = speedSaveState
            if m.queue.isEmpty { m.queue = queueLabels }
            m.finish("hold")
            panel = m
            m.onChange = { [weak self] in self?.veil?.panelChanged() }
        } else {
            panel?.setWaiting()
        }
        if let r = rectArg(d["rect"]) { veilRect = r }
        veilTarget = pointArg(d["point"])
        if let s = d["label"] as? String {
            veilLabel = s
        } else if let m = d["label"] as? [String: Any] {
            veilLabel = (m[VeilCopy.system.zh ? "zh" : "en"] as? String) ?? (m["en"] as? String) ?? ""
        }
        if holding { measuredStage("overlay_relabel") { veil?.relabel(label: veilLabel, target: veilTarget, model: panel) } }
        return ["ok": true, "held": holding]
    }

    /// Take over before anything else is known (no Chrome window yet): veil up, the user's input
    /// held. `begin` follows with the target window.
    func opHold(_ req: [String: Any]) throws -> [String: Any] {
        if holding { return ["ok": true] }
        if takeover { throw Halt.bad("hold_ended", "this session already held and released") }
        try checkStop()
        if !dry && !isTrusted() { throw Halt.bad("no_accessibility", "Accessibility permission missing") }
        takeVeil(req["veil"])
        try startTakeover(maxMs: min(1_800_000, max(1000, num(req["takeoverMaxMs"]) ?? 600_000)),
                          idleMs: min(120_000, max(500, num(req["takeoverIdleMs"]) ?? 10_000)),
                          untilDone: req["takeoverUntilDone"] as? Bool == true)
        // Where the user's pointer is, read inside the hold (it cannot move any more).
        var r: [String: Any] = ["ok": true, "pointer": pointJSON(cursor())]
        r["heldAt"] = heldAt ?? Date().timeIntervalSince1970 * 1000
        if let v = veilMs { r["veilMs"] = v; r["veilMode"] = veil?.mode ?? NSNull() }
        return r
    }

    func opBegin(_ req: [String: Any]) throws -> [String: Any] {
        if begun { throw Halt.bad("already_begun", "one begin per session") }
        try checkStop()
        guard let pid = num(req["chromePid"]), let win = num(req["window"]), let wb = rectArg(req["windowBounds"]) else {
            throw Halt.bad("bad_request", "begin needs chromePid, window, windowBounds")
        }
        if !dry && !isTrusted() { throw Halt.bad("no_accessibility", "Accessibility permission missing") }
        chromePid = pid_t(pid)
        window = Int(win)
        windowBounds = wb
        rate = min(16, max(1, num(req["rateMs"]) ?? 2))
        takeVeil(req["veil"])
        // Held since `hold` without the window (or it moved since the pre-check): the hole opens now.
        if holding { measuredStage("overlay_hole") { veil?.updateHole(wb) } }
        if req["takeover"] as? Bool == true && !holding {
            try startTakeover(maxMs: min(1_800_000, max(1000, num(req["takeoverMaxMs"]) ?? 600_000)),
                              idleMs: min(120_000, max(500, num(req["takeoverIdleMs"]) ?? 10_000)),
                              untilDone: req["takeoverUntilDone"] as? Bool == true)
        }
        begun = true
        return ["ok": true, "inputMonitor": monitor, "dryRun": dry, "takeover": takeover, "habits": gHabits.brief()]
    }

    struct MoveRun { var start = 0.0, primaryEnd = 0.0, end = 0.0, points = 0 }

    /// Post the plan's points on absolute deadlines every `rate` ms; when
    /// late, jump to the latest due point instead of bursting to catch up.
    /// The plan's own timeline runs at the pace (↑/↓): `speed` plan-ms per wall-ms, read at every
    /// point, so a change takes effect mid-move; the posting cadence stays `rate`.
    func runMove(_ plan: MovePlan) throws -> MoveRun {
        var m = MoveRun()
        m.start = nowMs()
        m.primaryEnd = m.start
        m.end = m.start
        if plan.skipped { return m }
        let total = plan.moveMs
        var due = m.start       // wall-clock deadline of the next point
        var tk = 0.0            // plan time of the next point
        var primaryDone = false
        while true {
            let step = min(rate, (total - tk) / speed)
            due += step
            tk = min(total, tk + step * speed)
            try waitUntil(due)
            let late = nowMs() - due
            if late >= rate && tk < total {
                let skip = (late / rate).rounded(.down) * rate
                due += skip
                tk = min(total, tk + skip * speed)
            }
            sendMove(tk >= total ? plan.landing : plan.position(at: tk))
            m.points += 1
            progress["points"] = m.points
            if !primaryDone && tk >= plan.primaryMs { primaryDone = true; m.primaryEnd = nowMs() }
            if tk >= total { break }
        }
        m.end = nowMs()
        return m
    }

    func plannedJSON(_ p: MovePlan) -> [String: Any] {
        ["T": r2(p.T), "ID": (p.ID * 1000).rounded() / 1000, "D": r2(p.D), "W": r2(p.W),
         "primary": r2(p.primaryMs), "corrections": p.correctionMs.map(r2), "dwell": r2(p.dwell)]
    }

    func opClick(_ req: [String: Any]) throws -> [String: Any] {
        try requireInput()
        guard let rect = rectArg(req["rect"]) else { throw Halt.bad("bad_request", "click needs rect {x,y,w,h}") }
        let clicks = max(1, min(3, Int(num(req["clickCount"]) ?? 1)))
        let plan = measuredStage("click_plan") {
            planMove(from: cursor(), rect: rect, aim: pointArg(req["aim"]), window: windowBounds, rate: rate, u: fittsU())
        }
        // Nothing moves when the press could not happen anyway.
        try measuredStage("click_guard_before_move") { try guardPress(at: plan.landing, checkCursor: false) }
        // Reaction before the hand moves (also when it is already on the
        // target); a user who moves meanwhile ends it at once (Halt).
        let tReact = nowMs()
        let react = sampleReaction()
        panel?.begin("move", est: react + plan.moveMs + plan.dwell)
        try pace(react)
        let reaction = nowMs() - tReact
        checkpoint("reactionEnd")
        let m = try runMove(plan)
        try waitUntil(m.end + max(4, plan.dwell / speed))
        checkpoint("dwellEnd")
        panel?.begin("press", est: 100 + Double(clicks - 1) * 200)
        try measuredStage("click_guard_before_press") { try guardPress(at: plan.landing) }
        let tDown = nowMs()
        heldMouse = (plan.landing, 1)
        sendButton(true, plan.landing, clicks: 1)
        try pace(gHabits.clickHold.sample(), floor: 40)
        sendButton(false, plan.landing, clicks: 1)
        heldMouse = nil
        let hold = nowMs() - tDown
        if clicks > 1 {
            for n in 2...clicks {
                try pace(lognormalMs(110, 0.25, 60, 220))
                try guardPress(at: plan.landing)
                heldMouse = (plan.landing, n)
                sendButton(true, plan.landing, clicks: n)
                try pace(lognormalMs(90, 0.25, 50, 200), floor: 40)
                sendButton(false, plan.landing, clicks: n)
                heldMouse = nil
            }
        }
        panel?.finish("press")
        return ["ok": true, "landed": pointJSON(plan.landing), "skippedMove": plan.skipped,
                "submovements": plan.strokes.count, "points": m.points,
                "timing": ["T": r2(tDown - m.start), "primary": r2(m.primaryEnd - m.start),
                           "corrections": r2(m.end - m.primaryEnd), "dwell": r2(tDown - m.end), "hold": r2(hold),
                           "reaction": r2(reaction)],
                "planned": plannedJSON(plan)]
    }

    func opMove(_ req: [String: Any]) throws -> [String: Any] {
        try requireInput()
        guard let to = pointArg(req["to"]), let rect = rectArg(req["rect"]) else {
            throw Halt.bad("bad_request", "move needs to {x,y} and rect {x,y,w,h}")
        }
        let plan = planMove(from: cursor(), rect: rect, aim: to, window: windowBounds, rate: rate, u: fittsU())
        let tReact = nowMs()
        let react = sampleReaction()
        panel?.begin("move", est: react + plan.moveMs)
        try pace(react)
        let reaction = nowMs() - tReact
        let m = try runMove(plan)
        panel?.finish("move")
        return ["ok": true, "landed": pointJSON(plan.landing), "skippedMove": plan.skipped,
                "submovements": plan.strokes.count, "points": m.points,
                "timing": ["T": r2(m.end - m.start), "primary": r2(m.primaryEnd - m.start),
                           "corrections": r2(m.end - m.primaryEnd), "reaction": r2(reaction)],
                "planned": plannedJSON(plan)]
    }

    /// One burst: n events of ONE line tick each, a window guard before each.
    func opWheel(_ req: [String: Any]) throws -> [String: Any] {
        try requireInput()
        let n = max(1, min(30, Int(num(req["notches"]) ?? 3)))
        let delta: Int32 = (req["dir"] as? String) == "up" ? 1 : -1
        var sent = 0
        progress["sent"] = 0
        panel?.begin("wheel")
        for i in 0..<n {
            if i > 0 { try pace(gHabits.wheelGap.sample()) }
            let p = cursor()
            try guardWheel(at: p)
            sendWheel(delta, at: p)
            sent += 1
            progress["sent"] = sent
        }
        return ["ok": true, "sent": sent]
    }

    /// One character on its real key (§1.3 type): Shift as its own
    /// flagsChanged, guard right before each down. `delivered` runs at keyDown.
    func strike(_ code: CGKeyCode, shift: Bool, unicode: String?, delivered: () -> Void = {}) throws {
        if shift {
            try guardKeys()
            heldShift = true
            sendFlags(kShift)
            try pace(lognormalMs(55, 0.35, 20, 150))
        }
        try guardKeys()
        heldKey = (code, unicode)
        sendKey(code, true, unicode)
        delivered()
        try pace(gHabits.keyDwell.sample(), floor: 30)
        sendKey(code, false, unicode)
        heldKey = nil
        if shift {
            try pace(lognormalMs(35, 0.4, 10, 120))
            heldShift = false
            sendFlags(kShift)
        }
    }

    func opType(_ req: [String: Any]) throws -> [String: Any] {
        try requireInput()
        guard let text = req["text"] as? String else { throw Halt.bad("bad_request", "type needs text") }
        let newline: Set<Character> = ["\n", "\r\n", "\r"]
        if let bad = text.first(where: { usKeys[$0] == nil && !newline.contains($0) && $0 != "\t" }) {
            throw Halt.bad("not_ascii", "no US key for \(String(bad).unicodeScalars.map { String(format: "U+%04X", $0.value) }.joined())")
        }
        var typed = 0
        progress["typed"] = 0
        panel?.begin("type")
        if req["firstDelay"] as? Bool == true { try pace(lognormalMs(600, 0.4, 330, 2000)) }
        let chars = Array(text)
        for (i, ch) in chars.enumerated() {
            var strokes: [(CGKeyCode, Bool, String?)]
            if newline.contains(ch) { strokes = [(kReturn, true, nil)] }
            else if ch == "\t" { strokes = Array(repeating: (49, false, " "), count: 4) }
            else { let (code, shift) = usKeys[ch]!; strokes = [(code, shift, String(ch))] }
            for (j, s) in strokes.enumerated() {
                if j > 0 { try pace(gHabits.flight.sample() * gHabits.spaceFactor) }
                try strike(s.0, shift: s.1, unicode: s.2, delivered: {
                    if j == strokes.count - 1 { typed += 1; progress["typed"] = typed; panel?.addChars(1) }
                })
            }
            if i == chars.count - 1 { break }
            // Flight to the next key: slower after spaces and punctuation, occasional hesitation.
            var flight = gHabits.flight.sample()
            if ch == " " || ch == "\t" { flight *= gHabits.spaceFactor }
            if ",.;:!?".contains(ch) { flight *= gHabits.punctFactor }
            if unit() < gHabits.longPause { flight += uniform(300, 900) }
            try pace(flight)
        }
        return ["ok": true, "typed": typed]
    }

    func opKey(_ req: [String: Any]) throws -> [String: Any] {
        try requireInput()
        guard let name = (req["name"] as? String)?.lowercased(), let code = namedKeys[name] else {
            throw Halt.bad("bad_request", "key name must be one of \(namedKeys.keys.sorted().joined(separator: "|"))")
        }
        if name == "return" { panel?.begin("submit") }
        try pace(lognormalMs(400, 0.35, 150, 1500))
        try strike(code, shift: false, unicode: nil)
        if name == "return" { panel?.finish("submit") }
        return ["ok": true, "key": name]
    }

    /// Clipboard stays set after the paste; restoreClipboard (or end) puts the
    /// user's items back.
    func opPaste(_ req: [String: Any]) throws -> [String: Any] {
        try requireInput()
        guard let text = req["text"] as? String, !text.isEmpty else { throw Halt.bad("bad_request", "paste needs text") }
        try guardKeys()
        if !pendingRestore {
            savedItems = (pb.pasteboardItems ?? []).map { item in
                item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
            }
        }
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.AutoGeneratedType"))
        pb.clearContents()
        pb.writeObjects([item])
        ourChange = pb.changeCount
        pendingRestore = true
        var vDown = false
        panel?.begin("type")
        do {
            try pace(lognormalMs(120, 0.3, 50, 300))
            try guardKeys()
            heldCmd = true
            sendFlags(kCommand)
            try pace(lognormalMs(90, 0.3, 40, 220))
            try guardKeys()
            heldKey = (kV, nil)
            sendKey(kV, true, nil)
            vDown = true
            panel?.addChars(text.count)
            try pace(lognormalMs(80, 0.25, 40, 160), floor: 30)
            sendKey(kV, false, nil)
            heldKey = nil
            try pace(lognormalMs(45, 0.35, 15, 120))
            heldCmd = false
            sendFlags(kCommand)
        } catch {
            // No V-down: nothing could have read our text, so put the user's back now.
            if !vDown { progress["restored"] = restoreClipboard()["restored"] }
            progress["pendingRestore"] = pendingRestore
            throw error
        }
        return ["ok": true, "pendingRestore": true]
    }

    func restoreClipboard() -> [String: Any] {
        guard pendingRestore else { return ["ok": true, "restored": false, "reason": "nothing_pending"] }
        pendingRestore = false
        defer { savedItems = [] }
        if pb.changeCount != ourChange { return ["ok": true, "restored": false, "reason": "changed"] }
        pb.clearContents()
        let items: [NSPasteboardItem] = savedItems.map { pairs in
            let it = NSPasteboardItem()
            for (t, d) in pairs { it.setData(d, forType: t) }
            return it
        }
        if !items.isEmpty { pb.writeObjects(items) }
        return ["ok": true, "restored": true]
    }
}

// MARK: - habits: the user's own input rhythm (C9; docs/antibot-plan.md 2.1/2.2: fit parameters, never replay)
//
// `cgevent habits record --seconds N [--out f]` listens for N seconds (a listen-only tap: nothing is held back,
// nothing is posted) and then writes ONE file, a statistical summary. Held in memory while recording and never
// written anywhere: a key's code until its release (only to pair the press with the release), the pointer
// positions of the movement under way (only to measure it). Never read at all: characters, which modifier,
// windows, apps, the screen. Keys typed while Secure Event Input is on (password fields) are not counted, nor is
// anything this project posts (SESSION_TAG, CLI_TAG) or another program posts. Each session reads the summary
// when it starts and uses what has enough samples, clamped to sane ranges; the safety floors stay.
// Why not replay the recording: the same trajectory twice is itself a fingerprint, and it is biometric data.

let HABITS_KIND = "chrome-bridge-habits"
let HABITS_VERSION = 1
/// eventSourceUserData on what the one-shot CLI commands post (`post`); a session's events carry SESSION_TAG.
let CLI_TAG: Int64 = 0x43425243        // "CBRC"

let H_STILL_MS = 100.0          // the pointer still this long: the movement is over
let H_PRESS_WINDOW_MS = 500.0   // a left press this soon after the pointer stopped ends that movement
let H_MIN_MOVE_PT = 5.0         // shorter: a hand resting on the mouse, not a movement
let H_FITTS_MIN_D = 20.0
let H_FITTS_W = 32.0            // assumed target width (pt): a passive recording cannot know the targets
let H_KEY_BREAK_MS = 2000.0     // a longer gap between two keys is a break, not a flight
let H_KEY_HOLD_MAX = 2000.0
let H_CLICK_HOLD_MAX = 2000.0   // longer: a press held on purpose, not a click
let H_WHEEL_BURST_MS = 200.0    // as experiments/analyze.mjs wheelStats
let H_PEAK_BASELINE = 0.40      // the user's own baseline the movement model was calibrated to (impl-contract §7)
/// Fewer samples than this: the quantity is written as null and the default stays.
let H_MIN: [String: Int] = ["keyHoldMs": 50, "flightMs": 50, "interKeyMs": 50, "longPause": 100,
                            "pressDwellMs": 15, "clickHoldMs": 15, "fitts": 15, "movements": 20,
                            "wheelIntervalMs": 20, "wheelNotches": 5]

func r4(_ x: Double) -> Double { x.isFinite ? (x * 10000).rounded() / 10000 : 0 }

enum HabitKind { case keyDown, keyUp, move, drag, leftDown, leftUp, otherDown, otherUp, wheel, secure }

/// All the recorder ever takes from an event.
struct HabitEvent {
    var kind: HabitKind
    var t: Double                 // ms, monotonic
    var key: Int64 = -1           // key code: pairs a press with its release, in memory only, never written
    var repeatKey = false         // auto-repeat (a key held down)
    var x = 0.0, y = 0.0          // pointer position: the movement under way, in memory only, never written
    var tag: Int64 = 0            // eventSourceUserData (SESSION_TAG / CLI_TAG: ours)
    var senderPid: Int64 = 0      // eventSourceUnixProcessID: 0 for the user's devices
    var secure = false            // Secure Event Input was on (a password field)
    var continuous = false        // trackpad-style scrolling (not a wheel with notches)
    var momentum = false          // the inertia tail of a flick
}

typealias HPoint = (t: Double, x: Double, y: Double)

/// experiments/analyze.mjs resample(): a uniform series every dt ms; a gap longer than `hold` means the
/// pointer was still, so the previous position is held until one frame before the next sample.
func hResample(_ pts: [HPoint], dt: Double = 5, hold: Double = 40, frame: Double = 16) -> [HPoint] {
    var p: [HPoint] = []
    for q in pts {
        if let l = p.last, q.t <= l.t { continue }
        if let l = p.last, q.t - l.t > hold { p.append((q.t - frame, l.x, l.y)) }
        p.append(q)
    }
    guard let first = p.first, let lastP = p.last else { return [] }
    var out: [HPoint] = []
    var j = 0, t = first.t
    while t <= lastP.t + 1e-9 {
        while j < p.count - 2 && p[j + 1].t < t { j += 1 }
        let a = p[j], b = p[min(j + 1, p.count - 1)]
        let f = b.t > a.t ? min(1, max(0, (t - a.t) / (b.t - a.t))) : 0
        out.append((t, a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f))
        t += dt
    }
    return out
}

/// experiments/analyze.mjs lowpass(): 2nd-order Butterworth (RBJ biquad), forward and backward.
func hLowpass(_ xs: [Double], fs: Double, fc: Double) -> [Double] {
    if xs.count < 3 { return xs }
    let w0 = 2 * Double.pi * fc / fs, cw = cos(w0), alpha = sin(w0) / (2 * 0.5.squareRoot())
    let a0 = 1 + alpha
    let b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - alpha) / a0
    func pass(_ v: [Double]) -> [Double] {
        var y = [Double](repeating: 0, count: v.count)
        var x1 = v[0], x2 = v[0], y1 = v[0], y2 = v[0]
        for i in 0..<v.count {
            let x0 = v[i]
            y[i] = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x0; y2 = y1; y1 = y[i]
        }
        return y
    }
    let pad = min(xs.count * 3, Int((fs / fc).rounded(.up)) * 3)
    let padded = [Double](repeating: xs[0], count: pad) + xs + [Double](repeating: xs[xs.count - 1], count: pad)
    let out = Array(pass(Array(pass(padded).reversed())).reversed())
    return Array(out[pad..<(pad + xs.count)])
}

/// Submovements as Hertzum & Hornbæk (experiments/analyze.mjs segmentSubmovements): position low-passed at
/// 7 Hz, a run of speed above 75 pt/s lasting at least 100 ms. Also where the speed peaks, as a fraction of
/// the movement's duration.
func hSubmovements(_ pts: [HPoint]) -> (count: Int, peakFrac: Double?) {
    let dt = 5.0
    let r = hResample(pts, dt: dt)
    guard r.count >= 3, let a = pts.first, let b = pts.last, b.t > a.t else { return (0, nil) }
    let fs = 1000 / dt
    let xs = hLowpass(r.map { $0.x }, fs: fs, fc: 7), ys = hLowpass(r.map { $0.y }, fs: fs, fc: 7)
    var v = [Double](repeating: 0, count: r.count)
    for i in 0..<r.count {
        let lo = max(0, i - 1), hi = min(r.count - 1, i + 1)
        v[i] = hypot(xs[hi] - xs[lo], ys[hi] - ys[lo]) / ((r[hi].t - r[lo].t) / 1000)
    }
    var count = 0, s = -1
    for i in 0...r.count {
        let above = i < r.count && v[i] > 75
        if above && s < 0 { s = i }
        if !above && s >= 0 {
            if r[i - 1].t - r[s].t >= 100 { count += 1 }
            s = -1
        }
    }
    var pk = 0
    for i in 0..<v.count where v[i] > v[pk] { pk = i }
    return (count, min(1, max(0, (r[pk].t - a.t) / (b.t - a.t))))
}

/// The recorder: events in, numbers out. Keeps only durations and per-movement measures; the key codes and
/// positions it needs while an event is under way are dropped as soon as they are used.
final class HabitRecorder {
    // What the summary is made of: plain numbers, no codes, no positions.
    var keyHold: [Double] = [], flight: [Double] = [], interKey: [Double] = []
    var pressDwell: [Double] = [], clickHold: [Double] = [], fittsU: [Double] = []
    var moveDist: [Double] = [], moveMs: [Double] = [], peakFrac: [Double] = [], deviation: [Double] = []
    var submoves: [Double] = []
    var wheelGap: [Double] = [], wheelNotches: [Double] = []
    var ours = 0, otherSenders = 0, secureKeys = 0, autoRepeat = 0, trackpadScroll = 0, secureSeen = 0
    var firstT: Double?, lastT: Double?

    // Transient, in memory only.
    private var downAt: [Int64: Double] = [:]               // key code -> press time, until its release
    private var repeated: Set<Int64> = []
    private var prev: (key: Int64, down: Double, up: Double?)?
    private var pendingNext: (key: Int64, next: Double)?    // the next key went down before `prev` came up
    private var cur: [HPoint] = []                          // the movement under way
    private var stopped: [HPoint]?                          // ended by stillness; a press may still follow
    private var leftDownAt: Double?
    private var dragged = false
    private var burst: (last: Double, count: Int)?

    func ingest(_ e: HabitEvent) {
        if firstT == nil { firstT = e.t }
        lastT = e.t
        let isKey = e.kind == .keyDown || e.kind == .keyUp
        if e.kind == .secure { secureSeen += 1; resetKeys(); return }
        if e.tag == SESSION_TAG || e.tag == CLI_TAG || e.senderPid != 0 {
            // Not the user's hands: this project's own input, or another program's.
            if e.tag == SESSION_TAG || e.tag == CLI_TAG { ours += 1 } else { otherSenders += 1 }
            // Whatever of the user's was complete before it still counts; nothing spans it.
            if isKey {
                prev = nil; pendingNext = nil
            } else if e.kind == .wheel {
                if let b = burst, e.t - b.last > H_WHEEL_BURST_MS { wheelNotches.append(Double(b.count)) }
                burst = nil
            } else {
                if let s = stopped { finish(s, press: nil) }
                if let l = cur.last, e.t - l.t > H_STILL_MS { finish(cur, press: nil) }
                cur = []; stopped = nil; leftDownAt = nil
            }
            return
        }
        if isKey {
            if e.secure { secureKeys += 1; resetKeys(); return }
            key(e)
        } else if e.kind == .wheel {
            wheel(e)
        } else {
            pointer(e)
        }
    }

    func resetKeys() { downAt = [:]; repeated = []; prev = nil; pendingNext = nil }

    private func key(_ e: HabitEvent) {
        if e.kind == .keyDown {
            if e.repeatKey { autoRepeat += 1; repeated.insert(e.key); prev = nil; pendingNext = nil; return }
            if let p = prev, e.t - p.down <= H_KEY_BREAK_MS {
                interKey.append(e.t - p.down)
                if let up = p.up { flight.append(e.t - up) } else { pendingNext = (p.key, e.t) }
            } else {
                pendingNext = nil
            }
            downAt[e.key] = e.t
            repeated.remove(e.key)
            prev = (e.key, e.t, nil)
        } else {
            guard let d = downAt.removeValue(forKey: e.key) else { return }
            let held = e.t - d
            if !repeated.contains(e.key) && held > 0 && held <= H_KEY_HOLD_MAX { keyHold.append(held) }
            repeated.remove(e.key)
            if let pn = pendingNext, pn.key == e.key { flight.append(pn.next - e.t); pendingNext = nil }   // overlap: < 0
            if let p = prev, p.key == e.key, p.down == d { prev = (p.key, p.down, e.t) }
        }
    }

    private func pointer(_ e: HabitEvent) {
        switch e.kind {
        case .move:
            if let l = cur.last, e.t - l.t > H_STILL_MS { closeByStillness() }
            if cur.isEmpty, let s = stopped { finish(s, press: nil); stopped = nil }
            cur.append((e.t, e.x, e.y))
        case .drag:
            dragged = true
        case .leftDown:
            if let l = cur.last {
                finish(cur, press: e.t - l.t <= H_PRESS_WINDOW_MS ? e : nil)
            } else if let s = stopped, let l = s.last {
                finish(s, press: e.t - l.t <= H_PRESS_WINDOW_MS ? e : nil)
            }
            cur = []; stopped = nil
            leftDownAt = e.t
            dragged = false
        case .leftUp:
            if let d = leftDownAt, !dragged, e.t - d > 0, e.t - d <= H_CLICK_HOLD_MAX { clickHold.append(e.t - d) }
            leftDownAt = nil
            dragged = false
        case .otherDown:
            closeByStillness()
            if let s = stopped { finish(s, press: nil); stopped = nil }
        default: break
        }
    }

    private func closeByStillness() {
        if let s = stopped { finish(s, press: nil) }
        stopped = cur.isEmpty ? nil : cur
        cur = []
    }

    private func wheel(_ e: HabitEvent) {
        if e.continuous || e.momentum { trackpadScroll += 1; return }
        if let b = burst, e.t - b.last <= H_WHEEL_BURST_MS {
            wheelGap.append(e.t - b.last)
            burst = (e.t, b.count + 1)
        } else {
            if let b = burst { wheelNotches.append(Double(b.count)) }
            burst = (e.t, 1)
        }
    }

    /// One movement's measures; its points are dropped by the caller right after.
    private func finish(_ pts: [HPoint], press: HabitEvent?) {
        guard pts.count >= 3, let a = pts.first, let b = pts.last, b.t > a.t else { return }
        let D = hypot(b.x - a.x, b.y - a.y)
        guard D >= H_MIN_MOVE_PT else { return }
        moveDist.append(D)
        moveMs.append(b.t - a.t)
        var maxPerp = 0.0
        for p in pts { maxPerp = max(maxPerp, abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / D) }
        deviation.append(maxPerp / D)
        let sm = hSubmovements(pts)
        submoves.append(Double(sm.count))
        if let f = sm.peakFrac { peakFrac.append(f) }
        guard let p = press else { return }
        pressDwell.append(max(0, p.t - b.t))
        let Dp = hypot(p.x - a.x, p.y - a.y)
        if Dp >= H_FITTS_MIN_D { fittsU.append((p.t - a.t) / (21 + 225 * log2(Dp / H_FITTS_W + 1))) }
    }

    /// End of the recording: whatever is still open is closed.
    func flush() {
        closeByStillness()
        if let s = stopped { finish(s, press: nil); stopped = nil }
        if let b = burst { wheelNotches.append(Double(b.count)); burst = nil }
        resetKeys()
    }
}

func hQuantile(_ sorted: [Double], _ p: Double) -> Double {
    let i = Double(sorted.count - 1) * p, lo = Int(i.rounded(.down)), hi = Int(i.rounded(.up))
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - Double(lo))
}

/// Lognormal from quantiles: median = P50, sigma = ln(P75/P25)/1.349 (a few long pauses do not move it).
/// With overlapping keys (negative flights) in the lower quarter: sigma from P50..P75. Nil when P50 <= 0.
func hLogFit(_ xs: [Double]) -> (median: Double, sigma: Double)? {
    guard xs.count >= 4 else { return nil }
    let s = xs.sorted()
    let p25 = hQuantile(s, 0.25), p50 = hQuantile(s, 0.5), p75 = hQuantile(s, 0.75)
    guard p50 > 0 else { return nil }
    let sigma = p25 > 0 ? log(p75 / p25) / 1.34898 : log(p75 / p50) / 0.67449
    guard sigma.isFinite, sigma > 0 else { return nil }
    return (p50, sigma)
}

/// Flights in the default model's terms: a lognormal, and on a share of them a long pause (300–900 ms more).
/// The pauses sit above the lognormal's bulk, so it is fitted on the lowest (1 - share) of the flights and
/// the share re-estimated, a few rounds: flights more than 300 ms over the median, less what the lognormal
/// itself puts there.
func hFlightFit(_ xs: [Double]) -> (median: Double, sigma: Double, ratio: Double, cut: Double)? {
    guard xs.count >= 4 else { return nil }
    let s = xs.sorted()
    var r = 0.0
    var out: (median: Double, sigma: Double, ratio: Double, cut: Double)?
    for _ in 0..<5 {
        let k = 1 - r
        let p25 = hQuantile(s, 0.25 * k), p50 = hQuantile(s, 0.5 * k), p75 = hQuantile(s, 0.75 * k)
        guard p50 > 0 else { return nil }
        let sigma = p25 > 0 ? log(p75 / p25) / 1.34898 : log(p75 / p50) / 0.67449
        guard sigma.isFinite, sigma > 0 else { return nil }
        let cut = p50 + 300
        let over = Double(s.filter { $0 > cut }.count) / Double(s.count)
        let tail = 0.5 * erfc(log(cut / p50) / sigma / 2.0.squareRoot())
        r = min(0.5, max(0, (over - tail) / (1 - tail)))
        out = (p50, sigma, r, cut)
    }
    return out
}

/// n, P10/P25/P50/P75/P90 (and the lognormal fit), or null below the quantity's minimum.
func hDist(_ xs: [Double], _ name: String, lognormal: Bool, digits: Int = 2,
           fit: ((median: Double, sigma: Double))? = nil) -> Any {
    guard xs.count >= (H_MIN[name] ?? 1) else { return NSNull() }
    let s = xs.sorted()
    let rd: (Double) -> Double = digits == 4 ? r4 : r2
    var d: [String: Any] = ["n": xs.count]
    for (k, p) in [("p10", 0.1), ("p25", 0.25), ("p50", 0.5), ("p75", 0.75), ("p90", 0.9)] { d[k] = rd(hQuantile(s, p)) }
    if lognormal {
        if let f = fit ?? hLogFit(xs) { d["lognormal"] = ["median": r2(f.median), "sigma": r4(f.sigma)] } else { d["lognormal"] = NSNull() }
    }
    return d
}

/// The file: statistics only (counts, quantiles, fits), how long, when, which version.
func habitsSummary(_ r: HabitRecorder, seconds: Double, now: Date) -> [String: Any] {
    let ff = hFlightFit(r.flight)
    var longPause: Any = NSNull()
    if r.flight.count >= H_MIN["longPause"]!, let f = ff {
        longPause = ["n": r.flight.count, "ratio": r4(f.ratio), "thresholdMs": r2(f.cut)]
    }
    var fitts: Any = NSNull()
    if r.fittsU.count >= H_MIN["fitts"]! {
        let s = r.fittsU.sorted()
        fitts = ["n": s.count, "u": r4(hQuantile(s, 0.5)), "p25": r4(hQuantile(s, 0.25)), "p75": r4(hQuantile(s, 0.75)),
                 "W": H_FITTS_W]
    }
    var sub: Any = NSNull()
    if r.submoves.count >= H_MIN["movements"]!, var d = hDist(r.submoves, "movements", lognormal: false) as? [String: Any] {
        let n = Double(r.submoves.count)
        let c = { (k: Double) in r4(Double(r.submoves.filter { $0 == k }.count) / n) }
        d["share"] = ["0": c(0), "1": c(1), "2": c(2), "3+": r4(Double(r.submoves.filter { $0 >= 3 }.count) / n)]
        sub = d
    }
    let iso = ISO8601DateFormatter()
    return [
        "kind": HABITS_KIND, "version": HABITS_VERSION, "createdAt": iso.string(from: now),
        "recordedSeconds": r2(seconds), "use": true,
        "note": "只有统计摘要：没有按了哪个键、没有输入的内容、没有屏幕坐标、窗口或程序名、没有截图；录制时的原始事件从不写盘。" +
                "删除：菜单栏「AI 浏览器助手」→「删除习惯数据」，或 bin/cgevent habits delete，或直接删掉本文件。",
        "assumptions": [
            "fitts": "T = (21 + 225·log2(D/W + 1))·u ms；T = 移动开始到按下，D = 移动起点到按下点的距离，W 固定 32 pt（被动录制不知道目标多大）",
            "fittsW": H_FITTS_W,
            "movementSplit": "鼠标静止超过 100 ms 或按下鼠标即一次移动结束；停下后 500 ms 内的左键按下算这次移动的点击",
            "submovements": "位置 7 Hz 低通，速度 > 75 pt/s 且持续 ≥ 100 ms 为一个子动作（Hertzum & Hornbæk，同 experiments/analyze.mjs）",
            "typingBreakMs": H_KEY_BREAK_MS,
            "wheelBurstGapMs": H_WHEEL_BURST_MS,
            "lognormalFit": "median = P50，σ = ln(P75/P25)/1.349（按分位数拟合，少数长停顿不影响）",
            "longPause": "与默认模型同一含义（一部分间隔另加 300–900 ms）：比中位数长 300 ms 以上的间隔所占比例，减去对数正态本身会落到那里的部分；flightMs 的对数正态只用其余间隔拟合",
        ] as [String: Any],
        "sampleCounts": [
            "keyHoldMs": r.keyHold.count, "flightMs": r.flight.count, "interKeyMs": r.interKey.count,
            "movements": r.moveDist.count, "pressDwellMs": r.pressDwell.count, "clickHoldMs": r.clickHold.count,
            "fitts": r.fittsU.count, "wheelIntervalMs": r.wheelGap.count, "wheelBursts": r.wheelNotches.count,
        ],
        "excluded": ["ours": r.ours, "otherSenders": r.otherSenders, "secureInputKeys": r.secureKeys,
                     "autoRepeat": r.autoRepeat, "trackpadScroll": r.trackpadScroll],
        "typing": [
            "keyHoldMs": hDist(r.keyHold, "keyHoldMs", lognormal: true),
            "flightMs": hDist(r.flight, "flightMs", lognormal: true, fit: ff.map { ($0.median, $0.sigma) }),
            "interKeyMs": hDist(r.interKey, "interKeyMs", lognormal: true),
            "longPause": longPause,
            "spaceFactor": NSNull(), "punctFactor": NSNull(),
        ] as [String: Any],
        "pointer": [
            "distancePt": hDist(r.moveDist, "movements", lognormal: false),
            "durationMs": hDist(r.moveMs, "movements", lognormal: true),
            "peakFrac": hDist(r.peakFrac, "movements", lognormal: false, digits: 4),
            "maxDeviationRatio": hDist(r.deviation, "movements", lognormal: false, digits: 4),
            "submovements": sub,
            "pressDwellMs": hDist(r.pressDwell, "pressDwellMs", lognormal: true),
            "clickHoldMs": hDist(r.clickHold, "clickHoldMs", lognormal: true),
            "fitts": fitts,
            "reactionMs": NSNull(),
        ] as [String: Any],
        "wheel": [
            "intervalMs": hDist(r.wheelGap, "wheelIntervalMs", lognormal: true),
            "notchesPerBurst": hDist(r.wheelNotches, "wheelNotches", lognormal: false),
        ] as [String: Any],
        "notFitted": [
            "spaceFactor": "只录节奏、不区分按键，所以不知道哪一下是空格：空格后的停顿沿用默认 ×1.3",
            "punctFactor": "同上，标点后的停顿沿用默认 ×1.6",
            "reactionMs": "被动录制看不到「该动手了」的那一刻，移动前的反应时间沿用默认（中位 200 ms）",
        ] as [String: Any],
    ]
}

/// Where the summary lives: CHROME_BRIDGE_HABITS (a path), or nil when it is off/0/false/no/none.
/// Keep in step with habitsPath() in src/menubar.swift.
func habitsFile() -> String? {
    let env = ProcessInfo.processInfo.environment["CHROME_BRIDGE_HABITS"] ?? ""
    if ["off", "0", "false", "no", "none"].contains(env.lowercased()) { return nil }
    if !env.isEmpty { return (env as NSString).expandingTildeInPath }
    return NSHomeDirectory() + "/Library/Application Support/chrome-bridge-mcp/habits.json"
}

func readJSONObject(_ path: String) -> [String: Any]? {
    guard let d = FileManager.default.contents(atPath: path) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
}

/// Atomically, readable by the user only; the on/off switch of an earlier recording carries over.
func writeHabits(_ summary: [String: Any], to path: String, keepUse: Bool = true) -> String? {
    var s = summary
    if keepUse, let old = readJSONObject(path), let u = old["use"] as? Bool { s["use"] = u }
    do {
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: s, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
        return nil
    } catch {
        return error.localizedDescription
    }
}

/// A lognormal timing: median and sigma, sampled within [lo, hi].
struct LogN {
    var median: Double, sigma: Double, lo: Double, hi: Double
    func sample() -> Double { lognormalMs(median, sigma, lo, hi) }
    var json: [String: Any] { ["median": r2(median), "sigma": r4(sigma), "lo": r2(lo), "hi": r2(hi)] }
}

/// The timing parameters in effect: the defaults below, each replaced by the user's recorded habit when the
/// summary has enough samples for it (clamped). The safety floors (key held >= 30 ms, button >= 40 ms,
/// pause before a press >= 4 ms, at any pace) are applied where the waits happen and do not change.
struct HabitParams {
    var status = "missing"        // loaded | missing | off | disabled | bad_version | unreadable
    var path: String?
    var recordedAt: String?
    var fittsU: Double?           // nil: fittsSetting() falls back to the default
    var keyDwell = LogN(median: 95, sigma: 0.25, lo: 40, hi: 200)
    var flight = LogN(median: 140, sigma: 0.5, lo: 35, hi: 900)
    var longPause = 0.03
    var spaceFactor = 1.3, punctFactor = 1.6
    var pressDwell = LogN(median: 20, sigma: 1.0, lo: 4, hi: 150)
    var clickHold = LogN(median: 100, sigma: 0.25, lo: 50, hi: 220)
    var wheelGap = LogN(median: 40, sigma: 0.35, lo: 15, hi: 120)
    var bowLo = 0.02, bowHi = 0.08
    var peakScale = 1.0
    /// Each parameter taken from the summary: what was fitted and whether the range clamped it.
    var from: [String: [String: Any]] = [:]

    var applied: [String] { from.keys.sorted() }
    var msPerChar: Double { 260 * (keyDwell.median + flight.median) / 235 }
    func brief() -> [String: Any] { ["status": status, "applied": applied] }
}

var gHabits = HabitParams()

/// The parameter ranges (the clamp). A recorded value outside is pulled to the edge and marked clamped.
let H_RANGE: [String: (median: ClosedRange<Double>, sigma: ClosedRange<Double>, floor: Double, cap: Double)] = [
    "keyHoldMs": (40...250, 0.1...0.8, 30, 600),
    "flightMs": (60...600, 0.2...1.2, 20, 3000),
    "pressDwellMs": (4...150, 0.3...1.5, 4, 500),
    "clickHoldMs": (50...250, 0.1...0.8, 40, 800),
    "wheelIntervalMs": (15...180, 0.1...1.0, 10, H_WHEEL_BURST_MS),
]
let H_U_RANGE = 0.3...2.0
let H_LONGPAUSE_RANGE = 0.0...0.15
let H_PEAKSCALE_RANGE = 0.5...1.5

func clampTo(_ v: Double, _ r: ClosedRange<Double>) -> Double { min(r.upperBound, max(r.lowerBound, v)) }

func loadHabits() -> HabitParams {
    var h = HabitParams()
    guard let path = habitsFile() else { h.status = "off"; return h }
    h.path = path
    guard FileManager.default.fileExists(atPath: path) else { h.status = "missing"; return h }
    guard let j = readJSONObject(path) else { h.status = "unreadable"; return h }
    guard j["kind"] as? String == HABITS_KIND, (j["version"] as? NSNumber)?.intValue == HABITS_VERSION else {
        h.status = "bad_version"; return h
    }
    h.recordedAt = j["createdAt"] as? String
    if j["use"] as? Bool == false { h.status = "disabled"; return h }
    h.status = "loaded"
    let typing = j["typing"] as? [String: Any] ?? [:], ptr = j["pointer"] as? [String: Any] ?? [:]
    let wheel = j["wheel"] as? [String: Any] ?? [:]
    let enough = { (d: [String: Any], name: String) -> Bool in ((d["n"] as? NSNumber)?.intValue ?? 0) >= (H_MIN[name] ?? 1) }

    func logn(_ d: Any?, _ name: String) -> LogN? {
        guard let d = d as? [String: Any], enough(d, name), let f = d["lognormal"] as? [String: Any],
              let m = num(f["median"]), let s = num(f["sigma"]), m.isFinite, s.isFinite, let r = H_RANGE[name] else { return nil }
        let mc = clampTo(m, r.median), sc = clampTo(s, r.sigma)
        let lo = max(r.floor, mc * exp(-3 * sc)), hi = max(lo + 1, min(r.cap, mc * exp(3 * sc)))
        h.from[name] = ["fitted": ["median": m, "sigma": s], "clamped": mc != m || sc != s]
        return LogN(median: mc, sigma: sc, lo: lo, hi: hi)
    }
    if let v = logn(typing["keyHoldMs"], "keyHoldMs") { h.keyDwell = v }
    if let v = logn(typing["flightMs"], "flightMs") { h.flight = v }
    if let v = logn(ptr["pressDwellMs"], "pressDwellMs") { h.pressDwell = v }
    if let v = logn(ptr["clickHoldMs"], "clickHoldMs") { h.clickHold = v }
    if let v = logn(wheel["intervalMs"], "wheelIntervalMs") { h.wheelGap = v }
    if let d = typing["longPause"] as? [String: Any], enough(d, "longPause"), let r = num(d["ratio"]), r.isFinite {
        h.longPause = clampTo(r, H_LONGPAUSE_RANGE)
        h.from["longPause"] = ["fitted": r, "clamped": h.longPause != r]
    }
    if let d = ptr["fitts"] as? [String: Any], enough(d, "fitts"), let u = num(d["u"]), u.isFinite {
        h.fittsU = clampTo(u, H_U_RANGE)
        h.from["fittsU"] = ["fitted": u, "clamped": h.fittsU != u]
    }
    if let d = ptr["maxDeviationRatio"] as? [String: Any], enough(d, "movements"),
       let p10 = num(d["p10"]), let p90 = num(d["p90"]), p10.isFinite, p90.isFinite {
        h.bowLo = clampTo(p10, 0...0.15)
        h.bowHi = clampTo(p90, (h.bowLo + 0.005)...0.25)
        h.from["bow"] = ["fitted": ["p10": p10, "p90": p90], "clamped": h.bowLo != p10 || h.bowHi != p90]
    }
    if let d = ptr["peakFrac"] as? [String: Any], enough(d, "movements"), let p50 = num(d["p50"]), p50.isFinite {
        h.peakScale = clampTo(p50 / H_PEAK_BASELINE, H_PEAKSCALE_RANGE)
        h.from["peakScale"] = ["fitted": p50 / H_PEAK_BASELINE, "clamped": h.peakScale != p50 / H_PEAK_BASELINE]
    }
    return h
}

/// `cgevent habits show`: every timing parameter in effect and where it came from.
func habitsShow() -> [String: Any] {
    let h = gHabits
    let src = { (k: String) -> String in h.from[k] != nil ? "habits" : "default" }
    func entry(_ base: [String: Any], _ k: String) -> [String: Any] {
        var e = base
        e["source"] = src(k)
        if let f = h.from[k] { e["fitted"] = f["fitted"]; e["clamped"] = f["clamped"] }
        return e
    }
    let u = fittsSetting()
    var fu: [String: Any] = ["value": r4(u.u), "speedVsDefault": r4((1 / DEFAULT_MOUSE_SPEED) / u.u),
                             "source": u.source == "habits" || u.source == "default" ? u.source : "env \(u.source)",
                             "range": [H_U_RANGE.lowerBound, H_U_RANGE.upperBound]]
    if let f = h.from["fittsU"] { fu["fitted"] = f["fitted"]; fu["clamped"] = f["clamped"] }
    let rng = { (k: String) -> [String: Any] in
        guard let r = H_RANGE[k] else { return [:] }
        return ["median": [r.median.lowerBound, r.median.upperBound], "sigma": [r.sigma.lowerBound, r.sigma.upperBound]]
    }
    func logEntry(_ v: LogN, _ k: String) -> [String: Any] { var e = entry(v.json, k); e["range"] = rng(k); return e }
    return [
        "ok": true, "status": h.status, "path": h.path ?? NSNull(), "recordedAt": h.recordedAt ?? NSNull(),
        "params": [
            "fittsU": fu,
            "keyHoldMs": logEntry(h.keyDwell, "keyHoldMs"),
            "flightMs": logEntry(h.flight, "flightMs"),
            "longPause": entry(["ratio": r4(h.longPause), "extraMs": [300, 900]], "longPause"),
            "spaceFactor": ["value": h.spaceFactor, "source": "default"],
            "punctFactor": ["value": h.punctFactor, "source": "default"],
            "pressDwellMs": logEntry(h.pressDwell, "pressDwellMs"),
            "clickHoldMs": logEntry(h.clickHold, "clickHoldMs"),
            "wheelIntervalMs": logEntry(h.wheelGap, "wheelIntervalMs"),
            "bow": entry(["lo": r4(h.bowLo), "hi": r4(h.bowHi)], "bow"),
            "peakScale": entry(["value": r4(h.peakScale)], "peakScale"),
            "reactionMs": ["median": 200, "sigma": 0.25, "source": "default"],
            "submovements": ["source": "default"],
        ] as [String: Any],
        "floors": ["keyHoldMs": 30, "mouseHoldMs": 40, "pressDwellMs": 4],
    ]
}

/// A CGEvent timestamp on nowMs()'s clock. Documented as nanoseconds; on Apple silicon it has been reported
/// in mach ticks. Whichever reading is within a second of now is taken; neither: now.
let hTimebase: mach_timebase_info_data_t = { var t = mach_timebase_info_data_t(); mach_timebase_info(&t); return t }()
func eventTimeMs(_ ts: CGEventTimestamp) -> Double {
    let now = Double(DispatchTime.now().uptimeNanoseconds)
    let asNs = Double(ts), asTicks = Double(ts) * Double(hTimebase.numer) / Double(max(1, hTimebase.denom))
    let best = abs(now - asNs) <= abs(now - asTicks) ? asNs : asTicks
    return abs(now - best) < 1e9 ? best / 1e6 : now / 1e6
}

/// What the recorder takes from a real event — and nothing else (no characters, no modifier flags).
func habitEvent(_ type: CGEventType, _ ev: CGEvent) -> HabitEvent? {
    let kind: HabitKind
    switch type {
    case .keyDown: kind = .keyDown
    case .keyUp: kind = .keyUp
    case .mouseMoved: kind = .move
    case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: kind = .drag
    case .leftMouseDown: kind = .leftDown
    case .leftMouseUp: kind = .leftUp
    case .rightMouseDown, .otherMouseDown: kind = .otherDown
    case .rightMouseUp, .otherMouseUp: kind = .otherUp
    case .scrollWheel: kind = .wheel
    default: return nil
    }
    var e = HabitEvent(kind: kind, t: eventTimeMs(ev.timestamp))
    e.tag = ev.getIntegerValueField(.eventSourceUserData)
    e.senderPid = ev.getIntegerValueField(.eventSourceUnixProcessID)
    switch kind {
    case .keyDown, .keyUp:
        e.key = ev.getIntegerValueField(.keyboardEventKeycode)
        e.repeatKey = ev.getIntegerValueField(.keyboardEventAutorepeat) != 0
        e.secure = IsSecureEventInputEnabled()
    case .wheel:
        e.continuous = ev.getIntegerValueField(.scrollWheelEventIsContinuous) != 0
        e.momentum = ev.getIntegerValueField(.scrollWheelEventMomentumPhase) != 0
    case .move, .drag, .leftDown:
        e.x = ev.location.x
        e.y = ev.location.y
    default: break
    }
    return e
}

/// `habits fit`: one line of a synthetic event stream, read exactly as habitEvent reads a real event
/// (fields such as a character or modifier names are never looked at). For tests.
func habitEventFrom(_ o: [String: Any]) -> HabitEvent? {
    guard let type = o["type"] as? String, let t = num(o["t"]) else { return nil }
    let kinds: [String: HabitKind] = [
        "keyDown": .keyDown, "keyUp": .keyUp, "mouseMoved": .move, "leftMouseDragged": .drag,
        "rightMouseDragged": .drag, "otherMouseDragged": .drag, "leftMouseDown": .leftDown, "leftMouseUp": .leftUp,
        "rightMouseDown": .otherDown, "otherMouseDown": .otherDown, "rightMouseUp": .otherUp, "otherMouseUp": .otherUp,
        "scrollWheel": .wheel, "secure": .secure]
    guard let kind = kinds[type] else { return nil }       // flagsChanged and the rest: not listened to
    var e = HabitEvent(kind: kind, t: t)
    e.tag = Int64(num(o["userData"]) ?? 0)
    e.senderPid = Int64(num(o["sourcePid"]) ?? 0)
    switch kind {
    case .keyDown, .keyUp:
        e.key = Int64(num(o["keycode"]) ?? -1)
        e.repeatKey = o["autorepeat"] as? Bool ?? false
        e.secure = o["secure"] as? Bool ?? false
    case .wheel:
        e.continuous = o["continuous"] as? Bool ?? false
        e.momentum = o["momentum"] as? Bool ?? false
    case .move, .drag, .leftDown:
        e.x = num(o["x"]) ?? 0
        e.y = num(o["y"]) ?? 0
    default: break
    }
    return e
}

var gRecorder: HabitRecorder?
var gHabitsTap: CFMachPort?
let habitsTapCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = gHabitsTap { CGEvent.tapEnable(tap: t, enable: true) }
    } else if let e = habitEvent(type, event) {
        gRecorder?.ingest(e)
    }
    return Unmanaged.passUnretained(event)
}

func habitsCounts(_ s: [String: Any]) -> [String: Any] {
    ["sampleCounts": s["sampleCounts"] ?? NSNull(), "excluded": s["excluded"] ?? NSNull()]
}

/// `habits record`: listen for `seconds`, then write the summary. SIGTERM/SIGINT: cancelled, nothing written.
func runHabitsRecord(seconds: Double, out: String) -> Never {
    let rec = HabitRecorder()
    gRecorder = rec
    var mask: UInt64 = 0
    let types: [CGEventType] = [.keyDown, .keyUp, .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
                                .scrollWheel]
    for t in types { mask |= 1 << UInt64(t.rawValue) }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                      eventsOfInterest: CGEventMask(mask), callback: habitsTapCallback, userInfo: nil) else {
        fail("no_input_monitor", "录制没能开始：系统没有允许监听键盘鼠标。请在 系统设置 → 隐私与安全性 → 辅助功能（或「输入监控」）里给运行它的 App 打勾。")
    }
    gHabitsTap = tap
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    var stop = false
    var sources: [DispatchSourceSignal] = []
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        s.setEventHandler { stop = true }
        s.resume()
        sources.append(s)
    }
    let t0 = nowMs(), end = t0 + seconds * 1000
    while !stop && nowMs() < end {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: min(0.05, max(0.001, (end - nowMs()) / 1000))))
        // Keys are invisible to the tap while Secure Event Input is on; this marks the gap, so no flight spans it.
        if IsSecureEventInputEnabled() { rec.ingest(HabitEvent(kind: .secure, t: nowMs())) }
    }
    CGEvent.tapEnable(tap: tap, enable: false)
    _ = sources
    if stop {
        emit(["ok": false, "error": "cancelled", "message": "录制已取消，什么也没保存。"])
        exit(3)
    }
    rec.flush()
    let summary = habitsSummary(rec, seconds: (nowMs() - t0) / 1000, now: Date())
    if let err = writeHabits(summary, to: out) { fail("write_failed", "写不进 \(out)：\(err)") }
    var r: [String: Any] = ["ok": true, "out": out, "seconds": summary["recordedSeconds"] ?? seconds]
    for (k, v) in habitsCounts(summary) { r[k] = v }
    emit(r)
    exit(0)
}

/// `habits fit <events.jsonl> --out f`: the recorder fed from a file (tests), same summary, same writer.
func runHabitsFit(file: String, out: String) -> [String: Any] {
    guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { fail("read_failed", "cannot read \(file)") }
    let rec = HabitRecorder()
    for line in text.split(separator: "\n") {
        guard let o = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              let e = habitEventFrom(o) else { continue }
        rec.ingest(e)
    }
    rec.flush()
    let span = ((rec.lastT ?? 0) - (rec.firstT ?? 0)) / 1000
    let summary = habitsSummary(rec, seconds: span, now: Date())
    if let err = writeHabits(summary, to: out) { fail("write_failed", "cannot write \(out): \(err)") }
    var r: [String: Any] = ["ok": true, "out": out, "seconds": summary["recordedSeconds"] ?? span]
    for (k, v) in habitsCounts(summary) { r[k] = v }
    return r
}

// MARK: - screenshot support: on-device text recognition, window stack, compose (no input, no UI)

func loadImage(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// Text lines in the image at `path`, the way Pourtype's Grabber reads them (Vision, .accurate,
/// language correction). Vision's boxes are normalized with a BOTTOM-left origin; they are
/// returned in image pixels with a TOP-left origin, sorted top to bottom, then left to right.
func runOCR(path: String, langs: [String]) -> [String: Any] {
    guard let img = loadImage(path) else { fail("bad_image", "cannot read image: \(path)") }
    let W = Double(img.width), H = Double(img.height)
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    let supported = (try? req.supportedRecognitionLanguages()) ?? []
    let use = langs.filter { supported.isEmpty || supported.contains($0) }
    if !use.isEmpty { req.recognitionLanguages = use }
    var auto = false
    if #available(macOS 13.0, *) { req.automaticallyDetectsLanguage = true; auto = true }
    do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([req]) }
    catch { fail("ocr_failed", "text recognition failed: \(error.localizedDescription)") }
    var lines: [(y: Double, x: Double, d: [String: Any])] = []
    for obs in req.results ?? [] {
        guard let c = obs.topCandidates(1).first else { continue }
        let text = c.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        let bb = obs.boundingBox
        let x = bb.minX * W, y = (1 - bb.maxY) * H, w = bb.width * W, h = bb.height * H
        lines.append((y, x, ["text": text, "conf": (Double(c.confidence) * 100).rounded() / 100,
                             "x": x.rounded(), "y": y.rounded(), "w": w.rounded(), "h": h.rounded()]))
    }
    lines.sort { $0.y != $1.y ? $0.y < $1.y : $0.x < $1.x }
    return ["ok": true, "width": img.width, "height": img.height, "langs": use, "autoLanguage": auto,
            "lines": lines.map { $0.d }]
}

/// The window's CG bounds, and the on-screen windows in front of it that overlap it (front to
/// back): a Chrome window's own popups (select menu, date picker, bubbles) are separate windows,
/// which `screencapture -l` of the window alone leaves out. Owner names and titles are not given.
func windowStack(_ wid: Int) -> [String: Any] {
    guard let me = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(wid)) as? [[String: Any]])?.first,
          let bd = me[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: bd) else {
        fail("no_such_window", "no window with number \(wid)")
    }
    let rj: (CGRect) -> [String: Any] = { ["x": $0.origin.x, "y": $0.origin.y, "w": $0.size.width, "h": $0.size.height] }
    let onScreen = (me[kCGWindowIsOnscreen as String] as? Bool) ?? false
    var above: [[String: Any]] = []
    if onScreen, let raw = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow], CGWindowID(wid)) as? [[String: Any]] {
        for w in raw {
            guard let n = w[kCGWindowNumber as String] as? Int, n != wid,
                  let b = w[kCGWindowBounds as String] as? NSDictionary, let wr = CGRect(dictionaryRepresentation: b),
                  wr.width >= 2, wr.height >= 2, wr.intersects(r) else { continue }
            above.append(["id": n, "pid": (w[kCGWindowOwnerPID as String] as? Int) ?? 0,
                          "layer": (w[kCGWindowLayer as String] as? Int) ?? 0,
                          "alpha": (w[kCGWindowAlpha as String] as? Double) ?? 1, "bounds": rj(wr)])
        }
    }
    return ["ok": true, "id": wid, "pid": (me[kCGWindowOwnerPID as String] as? Int) ?? 0,
            "layer": (me[kCGWindowLayer as String] as? Int) ?? 0, "onScreen": onScreen, "bounds": rj(r), "above": above]
}

/// `base` shows the CG rect `rect`; each added image is drawn at its own CG rect on top (in the
/// order given), clipped to the base. The canvas keeps the base's pixel size.
func runCompose(out: String, base: String, rect: CGRect, adds: [(String, CGRect)]) -> [String: Any] {
    guard let b = loadImage(base) else { fail("bad_image", "cannot read image: \(base)") }
    guard rect.width > 0, rect.height > 0 else { fail("usage", "--rect needs a positive size") }
    let W = b.width, H = b.height
    guard let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("compose_failed", "no bitmap context") }
    let sx = CGFloat(W) / rect.width, sy = CGFloat(H) / rect.height
    ctx.interpolationQuality = .high
    ctx.draw(b, in: CGRect(x: 0, y: 0, width: W, height: H))
    var drawn = 0
    for (file, r) in adds {
        guard let img = loadImage(file) else { continue }
        // CG rect (top-left origin, points) -> context rect (bottom-left origin, pixels).
        let dst = CGRect(x: (r.minX - rect.minX) * sx, y: CGFloat(H) - (r.maxY - rect.minY) * sy,
                         width: r.width * sx, height: r.height * sy)
        ctx.draw(img, in: dst)
        drawn += 1
    }
    guard let outImg = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, "public.png" as CFString, 1, nil) else {
        fail("compose_failed", "cannot write \(out)")
    }
    CGImageDestinationAddImage(dest, outImg, nil)
    guard CGImageDestinationFinalize(dest) else { fail("compose_failed", "cannot write \(out)") }
    return ["ok": true, "width": W, "height": H, "added": drawn]
}

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else {
    fail("usage", "usage: cgevent check|mousepos|windowsat|move|click|press|type|key|scroll ...")
}

switch cmd {

case "escape-menu":
    guard args.count == 5, let pid = pid_t(args[1]), pid > 0, let window = Int(args[2]), window > 0,
          let since = Double(args[4]) else { fail("usage", "escape-menu <pid> <window> <document-token> <checked-since-ms>") }
    let recovery = guardedNativeEscape(pid: pid, window: window, documentToken: args[3], since: since)
    emit(recovery)
    if recovery["ok"] as? Bool != true { exit(1) }

case "check":
    emit(["ok": true, "trusted": isTrusted(), "arch": archName])

case "trust":
    // Read-only: AXIsProcessTrusted without the prompt option, CGPreflightScreenCaptureAccess (never
    // CGRequestScreenCaptureAccess), and the Automation answer without asking unless --ask-automation.
    emit(["ok": true, "accessibility": isTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
          "automation": automationCode(ask: args.contains("--ask-automation")), "responsible": responsibleApp(),
          "arch": archName])

case "idle":
    // Seconds since the last HID input (any key, click, move, wheel) — used to
    // wait until the user has stopped before taking the pointer.
    // Minimum over the input types a human produces (explicit, rather than
    // relying on the kCGAnyInputEventType mask).
    let kinds: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown,
                                .leftMouseDragged, .otherMouseDown, .scrollWheel, .keyDown, .flagsChanged]
    let s = kinds.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0
    // clickIdle: seconds since the last mouse button went down (any button).
    let downs: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    let c = downs.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0
    // keyIdle: seconds since the last key or mouse button event (typing, clicking; pointer moves and
    // the wheel are not counted). held: keys and buttons physically down now. Before taking over,
    // the bridge waits until the user is done typing (keyIdle) and holds nothing (held).
    let hands: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
                                .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp]
    let h = hands.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0
    // keyAt: the same as a wall-clock time (epoch ms), read here so the bridge's own delay does not shift it.
    emit(["ok": true, "idle": s, "clickIdle": c, "keyIdle": h, "keyAt": Date().timeIntervalSince1970 * 1000 - h * 1000,
          "held": hardwareHeld()])

case "warp":
    // Put the pointer back where the user left it. CGWarpMouseCursorPosition
    // moves the cursor without generating any mouse event, so no page sees it.
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else {
        fail("usage", "usage: cgevent warp <x> <y>")
    }
    CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
    CGAssociateMouseAndMouseCursorPosition(1)
    emit(["ok": true, "x": x, "y": y])

case "mousepos":
    let p = currentMouse()
    emit(["ok": true, "x": p.x, "y": p.y])

case "displays":
    // CGEvent mouse coordinates live in the same global display coordinate
    // space as CGDisplayBounds. CGDisplayBounds is documented in POINTS, while
    // CGDisplayPixelsWide/High report physical PIXELS. Printing both side by
    // side is the proof that we must not multiply by devicePixelRatio.
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(16, &ids, &count) == .success else {
        fail("screen_state_unknown", "The active displays could not be read; no input was sent.")
    }
    var list: [[String: Any]] = []
    var unionRect = CGRect.null
    for i in 0..<Int(count) {
        let d = ids[i]
        let b = CGDisplayBounds(d)
        // A sleeping display can remain in global desktop space with valid bounds. Do not
        // advertise it as drawable, or arrange an agent window on that sleeping monitor.
        guard CGDisplayIsAsleep(d) == 0, b.size.width > 0, b.size.height > 0 else { continue }
        unionRect = unionRect.union(b)
        list.append([
            "id": Int(d),
            "boundsPoints": ["x": b.origin.x, "y": b.origin.y, "w": b.size.width, "h": b.size.height],
            "pixelsWide": CGDisplayPixelsWide(d),
            "pixelsHigh": CGDisplayPixelsHigh(d),
            "backingScaleFactor": Double(CGDisplayPixelsWide(d)) / Double(b.size.width),
            "isMain": CGDisplayIsMain(d) != 0
        ])
    }
    // An absent lock flag is normal for an unlocked, fully logged-in console session. Missing
    // session metadata, a switched-out session, or a malformed flag must never imply unlocked.
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          (session["kCGSSessionOnConsoleKey"] as? Bool) == true,
          (session["kCGSessionLoginDoneKey"] as? Bool) == true else {
        fail("screen_state_unknown", "The current console session could not be verified; no input was sent.")
    }
    var locked = false
    if let lockValue = session["CGSSessionScreenIsLocked"] {
        guard let value = lockValue as? Bool else {
            fail("screen_state_unknown", "The screen lock state could not be read; no input was sent.")
        }
        locked = value
    }
    // No awake display: an empty list, not a crash (CGRect.null has infinite coordinates).
    emit(["ok": true, "displays": list, "arch": archName,
          "unionPoints": unionRect.isNull ? NSNull() as Any : ["x": unionRect.origin.x, "y": unionRect.origin.y,
                          "w": unionRect.size.width, "h": unionRect.size.height] as Any,
          "displaysAsleep": list.isEmpty,
          // The lock screen is up: input goes nowhere useful and nothing may type the password.
          "locked": locked,
          "mouse": ["x": currentMouse().x, "y": currentMouse().y]])

case "windowsat":
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else {
        fail("usage", "usage: cgevent windowsat <x> <y>")
    }
    let p = CGPoint(x: x, y: y)
    let list: [[String: Any]] = windowsContaining(p).map { w in
        ["owner": w.owner, "pid": w.pid, "layer": w.layer, "alpha": w.alpha,
         "bounds": ["x": w.rect.origin.x, "y": w.rect.origin.y,
                    "w": w.rect.size.width, "h": w.rect.size.height]]
    }
    emit(["ok": true, "x": x, "y": y, "windows": list,
          "topOwner": topOwner(at: p) ?? NSNull(), "arch": archName])

case "press":
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else {
        fail("usage", "usage: cgevent press <x> <y> [--expect-owner NAME] [--tolerance PT]")
    }
    requireTrust()
    var expectOwner: String? = nil
    var tolerance = 3.0
    var i = 3
    while i < args.count {
        if args[i] == "--expect-owner", i + 1 < args.count { expectOwner = args[i + 1]; i += 2; continue }
        if args[i] == "--tolerance", i + 1 < args.count { tolerance = Double(args[i + 1]) ?? 3.0; i += 2; continue }
        i += 1
    }
    let target = CGPoint(x: x, y: y)

    // Guard 1: is the top-most window at that point the app we mean to click?
    let ownerBefore = topOwner(at: target)
    if let want = expectOwner, let got = ownerBefore, !got.hasPrefix(want) {
        fail("window_not_chrome",
             "❌ 点击位置（x=\(Int(x)), y=\(Int(y))）最上层的窗口属于「\(got)」，不是 \(want)，已放弃点击。")
    }

    // Guard 2: is the cursor still where we put it? If a hand moved the mouse
    // during the travel animation, clicking here would hit something else.
    let before = currentMouse()
    let off = (pow(before.x - x, 2) + pow(before.y - y, 2)).squareRoot()
    if off > tolerance {
        fail("cursor_moved",
             "❌ 按下前鼠标已经不在目标点上（偏离 \(String(format: "%.1f", off)) point），已放弃点击。")
    }

    leftClick(at: target)
    let after = currentMouse()
    emit(["ok": true, "x": target.x, "y": target.y,
          "beforeX": before.x, "beforeY": before.y,
          "afterX": after.x, "afterY": after.y,
          "drift": (pow(after.x - x, 2) + pow(after.y - y, 2)).squareRoot(),
          "topOwner": ownerBefore ?? NSNull(), "arch": archName])

case "move", "click":
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else {
        fail("usage", "usage: cgevent \(cmd) <x> <y> [durationMs]")
    }
    requireTrust()
    let dur = args.count >= 4 ? (Int(args[3]) ?? 260) : Int.random(in: 150...400)
    let target = CGPoint(x: x, y: y)
    humanMove(to: target, durationMs: dur)
    if cmd == "click" {
        usleep(UInt32.random(in: 30_000...90_000))
        leftClick(at: target)
    }
    let now = currentMouse()
    emit(["ok": true, "x": now.x, "y": now.y, "durationMs": dur, "arch": archName])

case "type":
    guard args.count >= 2 else { fail("usage", "usage: cgevent type <text> | cgevent type --file <path>") }
    requireTrust()
    var text: String
    if args[1] == "--file" {
        guard args.count >= 3, let s = try? String(contentsOfFile: args[2], encoding: .utf8) else {
            fail("read_failed", "cannot read text file: \(args.count >= 3 ? args[2] : "?")")
        }
        text = s   // exact bytes: newlines and runs of spaces survive
    } else {
        text = args.dropFirst().joined(separator: " ")
    }
    // --raw: the old one-event-per-8-chars unicode path, only for fields
    // that block paste AND where the key fingerprint does not matter.
    if args.contains("--raw") {
        typeUnicode(text)
        emit(["ok": true, "chars": text.count, "mode": "raw"])
        exit(0)   // emit() does not exit: without this the text was typed twice
    }
    var r = typeHuman(text)
    r["ok"] = true
    r["chars"] = text.count
    r["mode"] = "human"
    emit(r)

case "key":
    guard args.count >= 2, let code = namedKeys[args[1].lowercased()] else {
        fail("usage", "usage: cgevent key \(namedKeys.keys.sorted().joined(separator: "|"))")
    }
    requireTrust()
    pressKey(code)
    emit(["ok": true, "key": args[1]])

case "scroll":
    guard args.count >= 2, let lines = Int(args[1]) else {
        fail("usage", "usage: cgevent scroll <lines>  (negative = down)")
    }
    requireTrust()
    // Break the travel into small wheel ticks so pages with scroll listeners
    // (infinite feeds, sticky headers) behave the way they do for a person.
    let step = lines < 0 ? -3 : 3
    var remaining = abs(lines)
    while remaining > 0 {
        let this = min(3, remaining) * (lines < 0 ? -1 : 1)
        if let e = CGEvent(scrollWheelEvent2Source: nil, units: .line,
                           wheelCount: 1, wheel1: Int32(this), wheel2: 0, wheel3: 0) {
            post(e)
        }
        remaining -= abs(step)
        usleep(UInt32.random(in: 12_000...30_000))
    }
    let p = currentMouse()
    emit(["ok": true, "lines": lines, "x": p.x, "y": p.y])

case "session":
    gHabits = loadHabits()
    let s = Session(dry: ProcessInfo.processInfo.environment["CGEVENT_DRYRUN"] == "1")
    gSession = s
    s.run()

case "model":
    // Offline: plans movements and reports their stats; posts nothing.
    var opt: [String: String] = [:]
    var i = 1
    while i < args.count {
        if args[i] == "--points" { opt["--points"] = "1"; i += 1; continue }
        if i + 1 < args.count { opt[args[i]] = args[i + 1] }
        i += 2
    }
    let from = parseNums(opt["--from"] ?? ""), r = parseNums(opt["--rect"] ?? "")
    guard from.count == 2, r.count == 4, r[2] >= 1, r[3] >= 1 else {
        fail("usage", "usage: cgevent model --from x,y --rect x,y,w,h [--n 200] [--seed s] [--aim x,y] [--window x,y,w,h] [--rate ms] [--u U] [--points]")
    }
    if let s = opt["--seed"] { rng = HelperRNG(state: seedValue(s)) }
    gHabits = loadHabits()
    let start = CGPoint(x: from[0], y: from[1])
    let rect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
    let aimN = parseNums(opt["--aim"] ?? ""), winN = parseNums(opt["--window"] ?? "")
    let aim = aimN.count == 2 ? CGPoint(x: aimN[0], y: aimN[1]) : nil
    let win = winN.count == 4 ? CGRect(x: winN[0], y: winN[1], width: winN[2], height: winN[3]) : nil
    let rate = max(1, Double(opt["--rate"] ?? "") ?? 2)
    let argU = Double(opt["--u"] ?? "").flatMap { $0 > 0 ? $0 : nil }
    let setting = fittsSetting()
    let u = argU ?? setting.u
    let n = max(1, min(5000, Int(opt["--n"] ?? "") ?? 200))
    var plans: [[String: Any]] = []
    for _ in 0..<n {
        plans.append(planStats(planMove(from: start, rect: rect, aim: aim, window: win, rate: rate, u: u),
                               rect: rect, rate: rate, withPoints: opt["--points"] != nil))
    }
    emit(["ok": true, "n": n, "rate": rate, "u": u, "speed": (1 / u * 1000).rounded() / 1000,
          "uSource": argU != nil ? "--u" : setting.source, "habits": gHabits.brief(), "plans": plans])

case "habits":
    // C9: the user's own input rhythm — statistics only (see "habits" above).
    let sub = args.count >= 2 ? args[1] : ""
    var opt: [String: String] = [:]
    var pos: [String] = []
    var i = 2
    while i < args.count {
        if args[i].hasPrefix("--"), i + 1 < args.count { opt[args[i]] = args[i + 1]; i += 2 } else { pos.append(args[i]); i += 1 }
    }
    let usage = "usage: cgevent habits record --seconds N [--out f] | show | delete | use on|off | fit <events.jsonl> --out f"
    switch sub {
    case "record":
        guard let s = Double(opt["--seconds"] ?? ""), s >= 1, s <= 1800 else { fail("usage", usage + "  (1 <= N <= 1800)") }
        guard let out = opt["--out"].map({ ($0 as NSString).expandingTildeInPath }) ?? habitsFile() else {
            fail("habits_off", "CHROME_BRIDGE_HABITS=off：不录制（用 --out 指定文件可以照录）。")
        }
        runHabitsRecord(seconds: s, out: out)
    case "fit":
        guard let file = pos.first, let out = opt["--out"] else { fail("usage", usage) }
        emit(runHabitsFit(file: file, out: out))
    case "show":
        gHabits = loadHabits()
        emit(habitsShow())
    case "delete":
        guard let path = habitsFile() else { fail("habits_off", "CHROME_BRIDGE_HABITS=off：没有习惯数据的路径。") }
        let existed = FileManager.default.fileExists(atPath: path)
        if existed {
            do { try FileManager.default.removeItem(atPath: path) } catch { fail("delete_failed", error.localizedDescription) }
        }
        emit(["ok": true, "deleted": existed, "path": path])
    case "use":
        guard let v = pos.first, v == "on" || v == "off" else { fail("usage", usage) }
        guard let path = habitsFile(), var j = readJSONObject(path), j["kind"] as? String == HABITS_KIND else {
            fail("no_habits", "还没有录制习惯数据。")
        }
        j["use"] = v == "on"
        if let err = writeHabits(j, to: path, keepUse: false) { fail("write_failed", err) }
        emit(["ok": true, "use": v == "on", "path": path])
    default:
        fail("usage", usage)
    }

case "veilsnap":
    var opt: [String: String] = [:]
    var i = 1
    while i + 1 < args.count { opt[args[i]] = args[i + 1]; i += 2 }
    guard let out = opt["--out"] else { fail("usage", "usage: cgevent veilsnap --out sheet.png [--scale 2] [--lang zh|en] [--frames a,b,…]") }
    let zh = (opt["--lang"] ?? (VeilCopy.system.zh ? "zh" : "en")) == "zh"
    let only = opt["--frames"].map { Set($0.split(separator: ",").map(String.init)) }
    emit(runVeilSnap(out: out, scale: CGFloat(min(3, max(1, Double(opt["--scale"] ?? "") ?? 2))), zh: zh, only: only))

case "veildemo":
    var opt: [String: String] = [:]
    var flags = Set<String>()
    var i = 1
    while i < args.count {
        if ["--path", "--reduce-motion", "--contrast", "--continuous", "--panel"].contains(args[i]) { flags.insert(args[i]); i += 1; continue }
        if i + 1 < args.count { opt[args[i]] = args[i + 1] }
        i += 2
    }
    let rn = parseNums(opt["--rect"] ?? ""), pn = parseNums(opt["--point"] ?? "")
    guard rn.count == 4, rn[2] >= 40, rn[3] >= 40 else {
        fail("usage", "usage: cgevent veildemo --rect x,y,w,h [--seconds 4] [--label TEXT] [--path] [--point x,y] " +
                      "[--appearance light|dark] [--reduce-motion] [--contrast] [--continuous] [--slow N] [--panel]")
    }
    var vo = VeilOptions()
    vo.recordEnd = false
    if flags.contains("--reduce-motion") { vo.reduceMotion = true }
    if flags.contains("--contrast") { vo.increaseContrast = true }
    if flags.contains("--continuous") { vo.forceContinuous = true }
    vo.timeScale = min(50, max(1, Double(opt["--slow"] ?? "") ?? 1))
    let zh = VeilCopy.system.zh
    runVeilDemo(rect: CGRect(x: rn[0], y: rn[1], width: rn[2], height: rn[3]),
                seconds: Double(opt["--seconds"] ?? "") ?? 4,
                label: opt["--label"] ?? (zh ? "演示 · 不拦截键鼠 · 按任意键关闭" : "Demo · input not held · press any key to close"),
                usePath: flags.contains("--path"), point: pn.count == 2 ? CGPoint(x: pn[0], y: pn[1]) : nil,
                appearance: opt["--appearance"], options: vo, panel: flags.contains("--panel"))

case "ocr":
    guard args.count >= 2, !args[1].hasPrefix("--") else {
        fail("usage", "usage: cgevent ocr <png> [--langs zh-Hans,zh-Hant,en-US,ja-JP]")
    }
    var langs = ["zh-Hans", "zh-Hant", "en-US", "ja-JP"]
    if let i = args.firstIndex(of: "--langs"), i + 1 < args.count {
        langs = args[i + 1].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    emit(runOCR(path: args[1], langs: langs))

case "windowstack":
    guard args.count >= 2, let wid = Int(args[1]) else { fail("usage", "usage: cgevent windowstack <cgWindowId>") }
    emit(windowStack(wid))

case "compose":
    var out: String?, base: String?, rect: [Double] = [], adds: [(String, CGRect)] = []
    var i = 1
    while i + 1 < args.count {
        switch args[i] {
        case "--out": out = args[i + 1]
        case "--base": base = args[i + 1]
        case "--rect": rect = parseNums(args[i + 1])
        case "--add":
            let a = args[i + 1]
            if let at = a.lastIndex(of: "@") {
                let n = parseNums(String(a[a.index(after: at)...]))
                if n.count == 4 { adds.append((String(a[..<at]), CGRect(x: n[0], y: n[1], width: n[2], height: n[3]))) }
            }
        default: break
        }
        i += 2
    }
    guard let o = out, let b = base, rect.count == 4 else {
        fail("usage", "usage: cgevent compose --out o.png --base b.png --rect x,y,w,h [--add p.png@x,y,w,h]...")
    }
    emit(runCompose(out: o, base: b, rect: CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3]), adds: adds))

default:
    fail("usage", "unknown subcommand: \(cmd)")
}
