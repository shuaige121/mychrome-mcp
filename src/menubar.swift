// cbmenu — MyChrome's menu-bar panel (round 6; owner's request: good-looking, simple, for people who
// do not read code). Click the icon: which AI assistant is using the computer and for what (task, step,
// progress, time left), and "keep the screen on and the Mac awake" for 15 min / 30 min / 1 h / 2 h /
// until the task is done / until turned off. One instance; the MCP server starts it (CHROME_BRIDGE_MENUBAR=0: not).
//
//   cbmenu                       the menu-bar panel (exits at once if one is already running)
//   cbmenu --set off|15|30|60|120|task|forever
//                                change the keep-awake mode (the running panel picks it up)
//   cbmenu --status              what the running panel last reported, as JSON
//   cbmenu --read-settings | --read-activity | --read-servers | --write-setting <key> <value>
//                                settings, activity log, AI sessions as the panel reads / writes them (tests)
//   cbmenu --goto <pid> <tab>    what 「带我去」 writes: session <pid> brings tab <tab> (waiting for the user) to the front
//   cbmenu --snapshot <png> [--demo] [--dark] [--mode <key>] [--habits none|recording|recorded] [--legacy] [--restart]
//                                draw the panel into a PNG (nothing on screen, no files, no power assertions);
//                                without --habits the habits card shows the summary file as it is (read only)
//
// Files (next to the input lock, ~/Library/Caches/chrome-bridge-mcp/ by default):
//   keepawake.json      {mode, until (epoch ms, timed modes), setAt}
//   menubar-state.json  {pid, mode, holding, until, tasks, at}   written by the running panel
//   menubar.pid
//   tasks/<pid>.json    one per MCP server with a task in progress (src/index.js writeTaskState)
//   goto-<pid>.json     {tab, at}: 「带我去」 under an alert; that server shows the tab (src/index.js onGotoRequest)
// Pages 「状态 / 设置 / 记录」 (owner 2026-10-14: the panel showed and set too little for someone who does not code):
//   settings.json   ~/Library/Application Support/chrome-bridge-mcp/ (CHROME_BRIDGE_SETTINGS); src/settings.js reads it
//   activity.jsonl  same folder (CHROME_BRIDGE_ACTIVITY): one line per tool call, host names only
//   servers/<pid>.json  one per live MCP server (who, version, busy); a server without one is an old build
// The habits card ("我的操作习惯") reads and changes the summary `bin/cgevent habits record` writes
// (~/Library/Application Support/chrome-bridge-mcp/habits.json, CHROME_BRIDGE_HABITS overrides; TODO.md C9).
//
// Build: swiftc -parse-as-library -O -o bin/cbmenu src/menubar.swift

import SwiftUI
import AppKit
import IOKit.pwr_mgt
import Combine
import CryptoKit

// MARK: - files and modes (no UI)

func baseDir() -> String {
    if let lock = ProcessInfo.processInfo.environment["CHROME_BRIDGE_LOCK"], !lock.isEmpty {
        return (lock as NSString).deletingLastPathComponent
    }
    return NSHomeDirectory() + "/Library/Caches/chrome-bridge-mcp"
}
let BASE = baseDir()
let MODE_FILE = BASE + "/keepawake.json"
let STATE_FILE = BASE + "/menubar-state.json"
let PID_FILE = BASE + "/menubar.pid"
let TASK_DIR = BASE + "/tasks"

func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }
func readJSON(_ path: String) -> [String: Any]? {
    guard let d = FileManager.default.contents(atPath: path) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
}
func writeJSON(_ path: String, _ o: [String: Any]) {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) {
        try? d.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}
func alive(_ pid: Int32) -> Bool { pid > 0 && kill(pid, 0) == 0 }

struct Duration: Identifiable {
    let key: String, label: String, minutes: Double?
    var id: String { key }
}
/// What "keep the screen on" can last; the panel shows them once the switch is on.
/// I18N1: computed, so a language change applies without a restart (the same for the tables below).
var DURATIONS: [Duration] { [
    Duration(key: "15", label: L("15 分钟", "15 min"), minutes: 15), Duration(key: "30", label: L("30 分钟", "30 min"), minutes: 30),
    Duration(key: "60", label: L("1 小时", "1 hour"), minutes: 60), Duration(key: "120", label: L("2 小时", "2 hours"), minutes: 120),
    Duration(key: "task", label: L("直到任务结束", "Until task ends"), minutes: nil), Duration(key: "forever", label: L("一直保持", "Always on"), minutes: nil)
] }

@discardableResult
func setMode(_ key: String) -> Bool {
    guard key == "off" || DURATIONS.contains(where: { $0.key == key }) else { return false }
    var o: [String: Any] = ["mode": key, "setAt": nowMs()]
    if let min = DURATIONS.first(where: { $0.key == key })?.minutes { o["until"] = nowMs() + min * 60_000 }
    writeJSON(MODE_FILE, o)
    return true
}

struct AgentTask: Identifiable {
    let id: Int32
    let who: String, task: String, stepName: String
    let current: Int?, total: Int?, color: Int
    let etaMs: Double?, etaAt: Double?
    /// What the user must do now (a CAPTCHA on the page, the agent stuck), in plain words; nil when nothing.
    var alert: String? = nil
    /// The Chrome tab that waits for the user (a field to fill, a CAPTCHA): 「带我去」 asks its session to show it.
    var alertTab: Int? = nil
    var alertToken: String? = nil
    var sessionGeneration: String? = nil
    func leftMs(at now: Double) -> Double? { etaMs.map { max(0, $0 - (now - (etaAt ?? now))) } }
}

/// Tasks in progress: one file per live MCP server (a dead server's file is removed).
func liveTasks() -> [AgentTask] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: TASK_DIR)) ?? []
    var out: [(Double, AgentTask)] = []
    for n in names where n.hasSuffix(".json") {
        let path = TASK_DIR + "/" + n
        guard let t = readJSON(path), let pid = (t["pid"] as? NSNumber)?.int32Value else { continue }
        guard alive(pid) else { try? FileManager.default.removeItem(atPath: path); continue }
        let num = { (k: String) in (t[k] as? NSNumber)?.doubleValue }
        out.append((num("since") ?? 0, AgentTask(id: pid, who: uiWho(t["who"] as? String), task: t["task"] as? String ?? "",
            stepName: t["stepName"] as? String ?? "", current: num("current").map { Int($0) }, total: num("total").map { Int($0) },
            color: Int(num("color") ?? 0), etaMs: num("etaMs"), etaAt: num("etaAt"), alert: t["alert"] as? String,
            alertTab: num("alertTab").map { Int($0) }, alertToken: t["alertToken"] as? String,
            sessionGeneration: t["sessionGeneration"] as? String)))
    }
    return out.sorted { $0.0 < $1.0 }.map { $0.1 }
}

func minutesText(_ ms: Double) -> String {
    let m = Int((ms / 60_000).rounded(.up))
    if m < 1 { return L("不到 1 分钟", "less than 1 min") }
    if m < 60 { return L("\(m) 分钟", "\(m) min") }
    return m % 60 == 0 ? L("\(m / 60) 小时", "\(m / 60) h") : L("\(m / 60) 小时 \(m % 60) 分钟", "\(m / 60) h \(m % 60) min")
}

// MARK: - habits (src/helper.swift "habits": a statistical summary of the user's own input rhythm)

let RECORD_SECONDS = 180.0
/// The movement model's default Fitts factor (helper DEFAULT_MOUSE_SPEED 1.8) and the range a recorded one is clamped to.
let DEFAULT_U = 1 / 1.8
let U_RANGE = 0.3...2.0

/// Where the summary lives; nil when CHROME_BRIDGE_HABITS is off. Keep in step with habitsFile() in src/helper.swift.
func habitsPath() -> String? {
    let env = ProcessInfo.processInfo.environment["CHROME_BRIDGE_HABITS"] ?? ""
    if ["off", "0", "false", "no", "none"].contains(env.lowercased()) { return nil }
    if !env.isEmpty { return (env as NSString).expandingTildeInPath }
    return NSHomeDirectory() + "/Library/Application Support/chrome-bridge-mcp/habits.json"
}

/// What the card shows of a summary.
struct HabitsInfo {
    var recordedAt: Date?
    var interKeyMs: Double?      // typing: time from one key to the next (median)
    var speedX: Double?          // mouse speed as a multiple of the default (default u / recorded u, clamped)
    var use: Bool
    var missing: Int             // timings without enough samples (they keep the defaults)
}

func readHabits() -> HabitsInfo? {
    guard let p = habitsPath(), let j = readJSON(p), j["kind"] as? String == "chrome-bridge-habits",
          (j["version"] as? NSNumber)?.intValue == 1 else { return nil }
    let typing = j["typing"] as? [String: Any] ?? [:], ptr = j["pointer"] as? [String: Any] ?? [:]
    let iki = ((typing["interKeyMs"] as? [String: Any])?["p50"] as? NSNumber)?.doubleValue
    let u = ((ptr["fitts"] as? [String: Any])?["u"] as? NSNumber)?.doubleValue
    let parts: [Any?] = [typing["keyHoldMs"], typing["flightMs"], ptr["fitts"], ptr["clickHoldMs"], ptr["pressDwellMs"]]
    return HabitsInfo(recordedAt: (j["createdAt"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) },
                      interKeyMs: iki, speedX: u.map { DEFAULT_U / min(U_RANGE.upperBound, max(U_RANGE.lowerBound, $0)) },
                      use: j["use"] as? Bool ?? true, missing: parts.filter { $0 == nil || $0 is NSNull }.count)
}

func clockText(_ ms: Double) -> String {
    let s = Int((ms / 1000).rounded(.up))
    return "\(s / 60):" + String(format: "%02d", s % 60)
}

func dateText(_ d: Date?) -> String {
    guard let d = d else { return L("日期不明", "Date unknown") }
    let f = DateFormatter()
    f.locale = Locale(identifier: uiEnglish() ? "en_US_POSIX" : "zh_CN")
    f.dateFormat = L("M月d日 HH:mm", "MMM d, HH:mm")
    return f.string(from: d)
}

func oneDecimal(_ x: Double) -> String { String(format: "%.1f", x) }

// MARK: - settings, servers, activity, setup check (src/settings.js reads and writes the same files)

let SUPPORT_DIR = NSHomeDirectory() + "/Library/Application Support/chrome-bridge-mcp"
func envPath(_ key: String, _ def: String) -> String {
    let v = ProcessInfo.processInfo.environment[key] ?? ""
    return v.isEmpty ? def : (v as NSString).expandingTildeInPath
}
let SETTINGS_FILE = envPath("CHROME_BRIDGE_SETTINGS", SUPPORT_DIR + "/settings.json")
let ACTIVITY_FILE = envPath("CHROME_BRIDGE_ACTIVITY", SUPPORT_DIR + "/activity.jsonl")
let ACTIVITY_OLD = ACTIVITY_FILE.hasSuffix(".jsonl") ? String(ACTIVITY_FILE.dropLast(6)) + ".1.jsonl" : ACTIVITY_FILE + ".1.jsonl"
let SERVER_DIR = BASE + "/servers"
/// The panel asks the sessions to run their setup check again (src/index.js watchCheckRequests).
let CHECK_REQUEST = BASE + "/check-request"
/// 「全部重启」's progress, written by `mychrome-mcp restart-all` (src/restart.js).
let RESTART_FILE = BASE + "/restart-all.json"
struct RestartItem: Identifiable, Equatable {
    let id: Int
    let name: String, state: String, note: String
    /// How the session is reached (src/restart.js `how`: kitty, tmux, background, print, other, unknown, self, gone).
    var how: String? = nil
}
struct RestartJob: Equatable {
    let pid: Int32, startedAt: Double, at: Double, finished: Bool
    /// Not finished and its process gone when read: what it had not done yet shows as failed (Codex r15 restart r1 B9).
    let died: Bool
    let items: [RestartItem]
    /// The run could not start (a lock left behind), in words for the owner.
    var error: String? = nil
    var running: Bool { !finished && !died }
}
func readRestartJob() -> RestartJob? {
    guard let j = readJSON(RESTART_FILE), let pid = (j["pid"] as? NSNumber)?.int32Value else { return nil }
    let items = (j["items"] as? [[String: Any]] ?? []).map { i in
        RestartItem(id: Int(jsonNum(i["client"]) ?? 0), name: i["name"] as? String ?? "", state: i["state"] as? String ?? "", note: i["note"] as? String ?? "",
                    how: i["how"] as? String)
    }
    let finished = jsonBool(j["finished"]) ?? false
    let died = !finished && !alive(pid)
    return RestartJob(pid: pid, startedAt: jsonNum(j["startedAt"]) ?? 0, at: jsonNum(j["at"]) ?? 0, finished: finished, died: died, items: items.map { i in
        died && (i.state == "waiting" || i.state == "sent")
            ? RestartItem(id: i.id, name: i.name, state: "failed", note: L("重启程序中途退出了，这个没做完：再点一次「全部重启」", "The restart program exited early and this one was not finished: click Restart all again"), how: i.how) : i
    }, error: j["error"] as? String)
}
/// I18N1: a 「全部重启」 item in the UI language. The restart program writes its notes in Chinese (src/restart.js); in English the
/// note is worded from the item's actual outcome, never from its state alone: restarted on the new version, already on it,
/// the session closed (not restarted), the reconnect command typed but Return withheld (left in its input box), sent and
/// unconfirmed, or left untouched. Only restart.js's fixed note openings are matched; the command is copied from the note.
func restartNoteText(state: String, how: String?, note: String) -> String {
    guard uiEnglish(), note.unicodeScalars.contains(where: { $0.value >= 0x3000 }) else { return note }
    let command = note.range(of: "/mcp reconnect [A-Za-z0-9_.@-]+", options: .regularExpression).map { String(note[$0]) } ?? "/mcp reconnect"
    switch state {
    case "done":
        if note.hasPrefix("已重启") { return "Restarted; now on the new version" }   // i18n-exempt: restart.js note matched
        if note.hasPrefix("已经换成新版") { return "Already on the new version (reconnected meanwhile); nothing was typed" }   // i18n-exempt: restart.js note matched
        if note.hasPrefix("会话已经关了") { return "The session has closed; it was not restarted" }   // i18n-exempt: restart.js note matched
        return "Finished, but the outcome was not recognised; check that session"
    case "skipped":
        if note.contains("没有按回车") {   // i18n-exempt: restart.js note matched
            return "\(command) was typed into that session's input box, but Return was not pressed and nothing was deleted (someone was using the computer, or the screen changed). Press Return there to restart, or delete it."
        }
        switch how {
        case "other": return "Not a Claude Code session; nothing was typed. Close it and reopen it."
        case "print": return "A one-off task (claude -p); nothing was typed. It ends by itself."
        case "self": return "This is the session running the restart; nothing was typed. When the command finishes, type \(command) here."
        case "unknown": return "Not in kitty or tmux, so MyChrome cannot type for it; nothing was typed. Type \(command) in that window, or close and reopen it."
        default: return "Left untouched: nothing was typed. Type \(command) in that session, or choose Reconnect under /mcp."
        }
    case "failed":
        if note.contains("旧的 MyChrome 停了") { return "The old MyChrome stopped, but the new one did not start: type /mcp in that session to check its status." }   // i18n-exempt: restart.js note matched
        if note.hasPrefix("claude respawn") { return "claude respawn did not succeed: open the session with claude attach and reconnect it under /mcp." }
        return "The reconnect was sent, but the switch to the new version was not confirmed. If the /mcp menu is open there, press Esc and choose Reconnect, or close and reopen the session."
    case "sent": return "Reconnect sent; confirming the new version"
    default: return "Waiting for this session to be idle"
    }
}
/// 「带我去」: the session `pid` brings `tab` (the page waiting for the user) to the front (src/index.js onGotoRequest).
func writeGotoRequest(pid: Int32, tab: Int, task: AgentTask? = nil, requestId: String = UUID().uuidString) -> String? {
    let state = readJSON(TASK_DIR + "/\(pid).json")
    guard let token = task?.alertToken ?? state?["alertToken"] as? String,
          let generation = task?.sessionGeneration ?? state?["sessionGeneration"] as? String,
          task?.alertTab == tab || (state?["alertTab"] as? NSNumber)?.intValue == tab else { return nil }
    let path = BASE + "/goto-\(pid).json"
    writeJSON(path, ["id": requestId, "tab": tab, "at": nowMs(), "alertToken": token, "sessionGeneration": generation])
    return readJSON(path)?["id"] as? String == requestId ? path : nil
}
/// The real path, as Node's realpathSync gives it (Foundation's resolvingSymlinksInPath turns /private/tmp into /tmp).
func realPath(_ p: String) -> String {
    guard let r = realpath(p, nil) else { return p }
    defer { free(r) }
    return String(cString: r)
}
/// The checkout or package this panel belongs to (bin/cbmenu → its parent), as a real path like the servers report.
let ROOT_DIR: String = {
    if let root = Bundle.main.object(forInfoDictionaryKey: "MyChromeSourceRoot") as? String, !root.isEmpty {
        return realPath(root)
    }
    let exe = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
    return realPath(URL(fileURLWithPath: realPath(exe.path)).deletingLastPathComponent().deletingLastPathComponent().path)
}()
/// A server of this checkout (its root, resolved) — the restart check compares with this checkout's files.
func sameRoot(_ root: String?) -> Bool { root == nil || realPath(root!) == ROOT_DIR }

/// src/settings.js sourceFingerprint: identical sorted src-relative JS/catalog inputs.
func sourceFingerprint(_ root: String) -> String? {
    let dir = root + "/src"
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return nil }
    var h = SHA256()
    let inputs = names.filter({ $0.hasSuffix(".js") }) + ["page-prompt-templates.json", "page/prompt-observation.js"]
    for n in inputs.sorted(by: { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }) {
        guard let d = FileManager.default.contents(atPath: dir + "/" + n) else { return nil }
        h.update(data: Data(n.utf8)); h.update(data: Data([0])); h.update(data: d); h.update(data: Data([0]))
    }
    return h.finalize().map { String(format: "%02x", $0) }.joined().prefix(16).description
}

/// JSON true/false only (JSONSerialization hands 1 and true back as the same NSNumber).
func jsonBool(_ v: Any?) -> Bool? {
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
    return n.boolValue
}
func jsonNum(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    return n.doubleValue
}

/// JSONSerialization strips a leading U+FEFF from string values on macOS.
/// Decode this settings/catalog boundary without changing Unicode text or JSON Bool types.
private enum SettingsJSONValue: Decodable {
    case object([String: SettingsJSONValue]), array([SettingsJSONValue]), string(String), bool(Bool)
    case integer(Int64), unsigned(UInt64), decimal(Decimal), null
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Int64.self) { self = .integer(value) }
        else if let value = try? container.decode(UInt64.self) { self = .unsigned(value) }
        else if let value = try? container.decode(Decimal.self) { self = .decimal(value) }
        else if let value = try? container.decode([SettingsJSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: SettingsJSONValue].self)) }
    }
    var value: Any {
        switch self {
        case .object(let values): return values.mapValues { $0.value }
        case .array(let values): return values.map { $0.value }
        case .string(let value): return value
        case .bool(let value): return NSNumber(value: value)
        case .integer(let value): return NSNumber(value: value)
        case .unsigned(let value): return NSNumber(value: value)
        case .decimal(let value): return NSDecimalNumber(decimal: value)
        case .null: return NSNull()
        }
    }
}
func decodeSettingsObject(_ data: Data) -> [String: Any]? {
    guard let values = try? JSONDecoder().decode([String: SettingsJSONValue].self, from: data) else { return nil }
    return values.mapValues { $0.value }
}
func readSettingsObject(_ file: String) -> [String: Any]? {
    guard let data = FileManager.default.contents(atPath: file) else { return nil }
    return decodeSettingsObject(data)
}

// MARK: - reviewed page-prompt catalog and settings (pure Node/Swift parity)

func normalizePromptText(_ value: String) -> String {
    var result = "", pendingSpace = false
    for scalar in value.unicodeScalars {
        let n = scalar.value
        let whitespace = (9...13).contains(n) || n == 32 || n == 0x85 || n == 0xA0 || n == 0x1680
            || (0x2000...0x200A).contains(n) || n == 0x2028 || n == 0x2029 || n == 0x202F || n == 0x205F || n == 0x3000
        if whitespace { pendingSpace = !result.isEmpty }
        else {
            if pendingSpace { result.append(" ") }
            result.unicodeScalars.append(scalar); pendingSpace = false
        }
    }
    return result
}

/// Deliberately portable canonical origins: ASCII DNS/IPv4 only, no credentials or URL suffix.
func canonicalPromptOrigin(_ value: String) -> String? {
    guard value.utf8.count <= 280, value.unicodeScalars.allSatisfy({ (0x21...0x7e).contains($0.value) }),
          value.hasPrefix("https://") || value.hasPrefix("http://") else { return nil }
    let scheme = value.hasPrefix("https://") ? "https" : "http"
    let authority = String(value.dropFirst(scheme.count + 3))
    let parts = authority.split(separator: ":", omittingEmptySubsequences: false)
    guard (1...2).contains(parts.count) else { return nil }
    let host = String(parts[0])
    guard !host.isEmpty, host.utf8.count <= 253, !host.hasSuffix(".") else { return nil }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    for label in labels {
        guard !label.hasPrefix("xn--"),
              label.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\z", options: .regularExpression) != nil else { return nil }
    }
    if host.allSatisfy({ $0.isNumber || $0 == "." }) {
        guard labels.count == 4, labels.allSatisfy({ label in
            guard let n = Int(label), (0...255).contains(n) else { return false }
            return String(n) == label
        }) else { return nil }
    } else if let last = labels.last, last.allSatisfy({ $0.isNumber }) || last.range(of: "^0x[0-9a-f]*$", options: .regularExpression) != nil {
        // WHATWG interprets a numeric final DNS label as IPv4; do not diverge from Node.
        return nil
    }
    if parts.count == 2 {
        let raw = String(parts[1])
        guard let port = Int(raw), (1...65535).contains(port), String(port) == raw,
              port != (scheme == "https" ? 443 : 80) else { return nil }
    }
    return value
}

func promptExactKeys(_ value: [String: Any], _ keys: [String]) -> Bool { Set(value.keys) == Set(keys) }
// Swift String equality folds canonical Unicode equivalents; Node exact text matching does not.
func promptTextEqual(_ left: String, _ right: String) -> Bool { left.utf16.elementsEqual(right.utf16) }
func promptUniqueText(_ values: [String]) -> Bool { Set(values.map { Array($0.utf16) }).count == values.count }
func promptID(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\z", options: .regularExpression) != nil
}
func promptVersion(_ value: Any?) -> Int? {
    guard let n = jsonNum(value), n.isFinite, n >= 1, n <= 9_007_199_254_740_991, n.rounded() == n else { return nil }
    return Int(n)
}

struct PagePromptTemplate: Identifiable, Equatable {
    let id: String, version: Int, fixtureOnly: Bool, kind: String
    let title: String, texts: [String], buttons: [String], choices: [String: String], origins: [String]
    var label: String { L("\(fixtureOnly ? "仅测试页面 · " : "")\(title) · \(kind) · v\(version)", "\(fixtureOnly ? "Test pages only · " : "")\(title) · \(kind) · v\(version)") }
}

struct PagePromptCatalog {
    let templates: [PagePromptTemplate]
    static let fixtureOrigins: Set<String> = ["http://127.0.0.1:17744", "http://localhost:17744"]
    static func parse(_ raw: Any?) -> PagePromptCatalog? {
        let rows: [[String: Any]]
        if let array = raw as? [[String: Any]] { rows = array }
        else {
            guard let wrapper = raw as? [String: Any], promptExactKeys(wrapper, ["version", "templates"]),
                  jsonNum(wrapper["version"]) == 1, let array = wrapper["templates"] as? [[String: Any]] else { return nil }
            rows = array
        }
        guard (1...64).contains(rows.count) else { return nil }
        var templates: [PagePromptTemplate] = [], ids = Set<String>()
        for row in rows {
            guard promptExactKeys(row, ["id", "version", "fixtureOnly", "kind", "semanticClass", "title", "texts", "buttons", "choices", "hasField", "origins"]),
                  let id = row["id"] as? String, promptID(id), ids.insert(id).inserted,
                  let version = promptVersion(row["version"]), let fixture = jsonBool(row["fixtureOnly"]),
                  let kind = row["kind"] as? String, ["dom", "native"].contains(kind),
                  row["semanticClass"] as? String == "inactivity", jsonBool(row["hasField"]) == false,
                  let title = row["title"] as? String, let texts = row["texts"] as? [String], texts.count <= 32,
                  let buttons = row["buttons"] as? [String], (1...8).contains(buttons.count), promptUniqueText(buttons),
                  let choices = row["choices"] as? [String: String], (1...2).contains(choices.count),
                  Set(choices.keys).isSubset(of: ["keep_session", "exit_session"]), promptUniqueText(Array(choices.values)),
                  choices.values.allSatisfy({ choice in buttons.contains(where: { promptTextEqual($0, choice) }) }),
                  let origins = row["origins"] as? [String], (1...8).contains(origins.count), Set(origins).count == origins.count else { return nil }
            let strings = [title] + texts + buttons
            guard strings.allSatisfy({ promptTextEqual(normalizePromptText($0), $0) }),
                  (texts + buttons).allSatisfy({ !$0.isEmpty }),
                  strings.reduce(0, { $0 + $1.utf16.count }) <= 4096,
                  buttons.allSatisfy({ $0.utf16.count <= 256 }),
                  origins.allSatisfy({ origin in
                      canonicalPromptOrigin(origin) != nil && (fixture ? fixtureOrigins.contains(origin) : origin.hasPrefix("https://"))
                  }) else { return nil }
            templates.append(PagePromptTemplate(id: id, version: version, fixtureOnly: fixture, kind: kind,
                title: title, texts: texts, buttons: buttons, choices: choices, origins: origins))
        }
        return PagePromptCatalog(templates: templates)
    }
    static func load() -> PagePromptCatalog? {
        guard let raw = readSettingsObject(ROOT_DIR + "/src/page-prompt-templates.json") else { return nil }
        return parse(raw)
    }
}

struct PagePromptRule: Identifiable, Equatable {
    let id: String, enabled: Bool, origin: String, templateId: String, templateVersion: Int, semantic: String, button: String
    var object: [String: Any] {
        ["id": id, "enabled": enabled, "origin": origin, "templateId": templateId,
         "templateVersion": templateVersion, "semantic": semantic, "button": button]
    }
    static func parse(_ raw: Any?, catalog: PagePromptCatalog) -> PagePromptRule? {
        guard let row = raw as? [String: Any],
              promptExactKeys(row, ["id", "enabled", "origin", "templateId", "templateVersion", "semantic", "button"]),
              let id = row["id"] as? String, promptID(id), let enabled = jsonBool(row["enabled"]),
              let origin = row["origin"] as? String, canonicalPromptOrigin(origin) != nil,
              let templateId = row["templateId"] as? String, let version = promptVersion(row["templateVersion"]),
              let semantic = row["semantic"] as? String, let button = row["button"] as? String,
              let template = catalog.templates.first(where: { $0.id == templateId && $0.version == version }),
              template.origins.contains(origin), template.choices[semantic].map({ promptTextEqual($0, button) }) == true else { return nil }
        return PagePromptRule(id: id, enabled: enabled, origin: origin, templateId: templateId,
                              templateVersion: version, semantic: semantic, button: button)
    }
}

struct PagePromptSettingsState: Equatable {
    var policy = "notify_ai", rules: [PagePromptRule] = []
    var valid = true, reason: String? = nil
    var object: [String: Any] { ["version": 1, "policy": policy, "rules": rules.map { $0.object }] }
    var normalizedObject: [String: Any] { ["value": object, "valid": valid, "reason": reason as Any? ?? NSNull()] }
    static func normalize(_ raw: Any?, catalog: PagePromptCatalog?) -> PagePromptSettingsState {
        guard let catalog else { return PagePromptSettingsState(valid: false, reason: "catalog_unavailable") }
        guard let raw else { return PagePromptSettingsState() }
        guard let row = raw as? [String: Any], promptExactKeys(row, ["version", "policy", "rules"]),
              jsonNum(row["version"]) == 1, let policy = row["policy"] as? String,
              ["off", "notify_ai", "auto_safe"].contains(policy), let rows = row["rules"] as? [Any], rows.count <= 32 else {
            return PagePromptSettingsState(valid: false, reason: "invalid_page_prompt_settings")
        }
        var rules: [PagePromptRule] = [], ids = Set<String>()
        for row in rows {
            guard let rule = PagePromptRule.parse(row, catalog: catalog), ids.insert(rule.id).inserted else {
                return PagePromptSettingsState(valid: false, reason: "invalid_page_prompt_settings")
            }
            rules.append(rule)
        }
        return PagePromptSettingsState(policy: policy, rules: rules)
    }
}

/// Used by both GUI surfaces. Every operation re-reads and merges one ID under the existing lock.
func writePagePromptMutation(_ operation: [String: Any], file: String = SETTINGS_FILE) -> Bool {
    return writeSettingsObject(file, [:], mutate: { values in
        let catalog = PagePromptCatalog.load()
        let current = PagePromptSettingsState.normalize(values["pagePrompt"], catalog: catalog)
        guard current.valid, let catalog, let op = operation["op"] as? String else { return false }
        var next = current.object
        var rules = current.rules.map { $0.object }
        if op == "policy" {
            guard promptExactKeys(operation, ["op", "policy"]), let policy = operation["policy"] as? String,
                  ["off", "notify_ai", "auto_safe"].contains(policy) else { return false }
            next["policy"] = policy
        } else if op == "add" {
            guard promptExactKeys(operation, ["op", "rule"]), let rule = PagePromptRule.parse(operation["rule"], catalog: catalog),
                  !current.rules.contains(where: { $0.id == rule.id }) else { return false }
            rules.append(rule.object)
        } else {
            guard let id = operation["id"] as? String, promptID(id),
                  let index = current.rules.firstIndex(where: { $0.id == id }) else { return false }
            if op == "toggle" {
                guard promptExactKeys(operation, ["op", "id", "enabled"]), let enabled = jsonBool(operation["enabled"]) else { return false }
                rules[index]["enabled"] = enabled
            } else if op == "delete" {
                guard promptExactKeys(operation, ["op", "id"]) else { return false }
                rules.remove(at: index)
            } else { return false }
        }
        next["rules"] = rules
        guard PagePromptSettingsState.normalize(next, catalog: catalog).valid else { return false }
        values["pagePrompt"] = next
        return true
    })
}

/// Presence contains only bounded status, never observed prompt text or delivery/route tokens.
struct PagePromptDeliveryStatus: Equatable {
    let observer: String, route: String?, transport: String, model: String, reason: String?
    let openCount: Int, updatedAt: Double
    static let reasons: Set<String> = ["unbound_source", "reconnect_required", "channel_unavailable", "unsupported_host",
        "binding_changed", "tool_start", "task_ended", "task_interrupted", "paused", "handoff", "conversation_waiting",
        "observer_timeout", "observer_output_limit", "observer_result_unknown", "observer_child_failed", "observer_spawn_failed",
        "dialog_probe_unknown", "target_changed", "target_unverified", "child_not_settled", "event_capacity", "probe_failed",
        "invalid_probe", "policy_off", "unavailable"]
    static func parse(_ raw: Any?) -> PagePromptDeliveryStatus? {
        guard let row = raw as? [String: Any],
              promptExactKeys(row, ["observer", "route", "transport", "model", "reason", "openCount", "updatedAt"]),
              let observer = row["observer"] as? String, ["idle", "observing", "unavailable", "paused"].contains(observer),
              let transport = row["transport"] as? String,
              ["not_sent", "queued_busy", "sent_unconfirmed", "host_accepted", "rejected", "unknown", "unavailable"].contains(transport),
              let model = row["model"] as? String, ["not_acknowledged", "acknowledged", "expired"].contains(model),
              let count = jsonNum(row["openCount"]), count.isFinite, (0...64).contains(count), count.rounded() == count,
              let at = jsonNum(row["updatedAt"]), at.isFinite, (0...9_007_199_254_740_991).contains(at), at.rounded() == at else { return nil }
        let route = row["route"] as? String
        guard (row["route"] is NSNull) || route.map({ ["claude_channel", "next_tool"].contains($0) }) == true else { return nil }
        let rawReason = row["reason"] as? String
        let reason = rawReason.map { reasons.contains($0) ? $0 : "unavailable" }
        guard rawReason != nil || row["reason"] is NSNull else { return nil }
        return PagePromptDeliveryStatus(observer: observer, route: route, transport: transport, model: model,
                                        reason: reason, openCount: Int(count), updatedAt: at)
    }
    var routeLabel: String {
        if route == "next_tool" { return L("下次工具回复补送（不是主动通知）", "Delivered with the next tool reply (not a proactive notification)") }
        if route == "claude_channel" { return model == "acknowledged" ? L("Claude Channel · 模型已确认", "Claude Channel · confirmed by the model") : L("Claude Channel · 已声明，接收未验证", "Claude Channel · declared, receipt not verified") }
        return L("主动通知路线不可用", "No proactive notification route available")
    }
    var transportLabel: String {
        switch transport {
        case "queued_busy": return L("会话忙碌，排队中", "Session busy, queued")
        case "sent_unconfirmed": return L("已发送（传输记录）", "Sent (transport record)")
        case "host_accepted": return L("传输已接受", "Accepted by the transport")
        case "rejected": return L("发送被拒绝", "Sending was refused")
        case "unknown": return L("传输回执未知", "Transport receipt unknown")
        case "not_sent": return L("尚未发送", "Not sent yet")
        default: return L("当前无法投递", "Cannot be delivered right now")
        }
    }
    var modelLabel: String {
        if model == "acknowledged" { return route == "next_tool" ? L("模型仅确认了工具回复补送", "The model confirmed only delivery with tool replies") : L("模型已确认此通知路线的接收", "The model confirmed receiving this notification route") }
        return model == "expired" ? L("确认已过期", "Confirmation expired") : L("模型尚未确认接收", "Not yet confirmed by the model")
    }
    var observerLabel: String {
        switch observer {
        case "observing": return L("正在观察当前任务页面", "Watching the current task page")
        case "paused": return L("观察已暂停", "Watching paused")
        case "unavailable": return L("页面观察不可用", "Page watching unavailable")
        default: return L("等待可观察的任务间隙", "Waiting for a gap in the task to watch")
        }
    }
    var reasonLabel: String? {
        guard let reason else { return nil }
        switch reason {
        case "reconnect_required": return L("此连接需要重新建立后才可声明 Channel。", "This connection must be re-established before it can declare a Channel.")
        case "channel_unavailable": return L("当前连接尚未提供可用 Channel。", "This connection has not offered a usable Channel yet.")
        case "unsupported_host": return L("此客户端暂不支持主动网页通知。", "This client cannot receive proactive page notifications.")
        case "unbound_source": return L("尚未绑定到当前任务的实际连接。", "Not yet bound to the connection actually running this task.")
        case "conversation_waiting": return L("会话正在等你回答。", "The session is waiting for your answer.")
        case "paused", "policy_off": return L("网页观察已关闭或暂停。", "Page watching is off or paused.")
        case "task_ended", "task_interrupted", "handoff": return L("任务已结束、停止或交由你处理。", "The task has ended, stopped or been handed to you.")
        case "tool_start": return L("普通工具操作正在进行。", "A regular tool action is in progress.")
        case "event_capacity": return L("待处理事件已达上限，自动处理已停用。", "Too many pending events; automatic handling is off.")
        case "target_changed", "target_unverified", "binding_changed": return L("当前页面或连接需要重新验证。", "The current page or connection needs to be verified again.")
        default: return L("当前无法取得可靠的观察或投递状态。", "No reliable watching or delivery status is available right now.")
        }
    }
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

/// UUID zero-byte files are pause requests, not settings data. Unknown files and
/// symlinks are neither interpreted nor removed by a resume.
func settingsPauseTokens(_ file: String) -> [String] {
    let dir = file + ".paused"
    var directory = stat()
    guard lstat(dir, &directory) == 0, directory.st_mode & S_IFMT == S_IFDIR,
          directory.st_uid == getuid(), let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
    return names.filter { name in
        guard name.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
                         options: .regularExpression) != nil else { return false }
        var item = stat()
        return lstat(dir + "/" + name, &item) == 0 && item.st_mode & S_IFMT == S_IFREG &&
            item.st_size == 0 && item.st_uid == getuid()
    }
}

func requestSettingsPause(_ file: String) -> String? {
    do { try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true) }
    catch { return nil }
    let dir = file + ".paused"
    if mkdir(dir, 0o700) != 0 && errno != EEXIST { return nil }
    var directory = stat()
    guard lstat(dir, &directory) == 0, directory.st_mode & S_IFMT == S_IFDIR, directory.st_uid == getuid() else { return nil }
    let token = UUID().uuidString
    let fd = open(dir + "/" + token, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { return nil }
    _ = close(fd)
    return token
}

func clearSettingsPauseTokens(_ file: String, _ observed: [String]) -> Bool {
    let remaining = Set(settingsPauseTokens(file))
    for token in observed where remaining.contains(token) {
        if unlink(file + ".paused/" + token) != 0 && errno != ENOENT { return false }
    }
    return true
}

@discardableResult
func writeSettingsObject(_ file: String, _ patch: [String: Any], when current: () -> Bool = { true },
                         afterCommit: () -> Bool = { true }, mutate: ((inout [String: Any]) -> Bool)? = nil) -> Bool {
    do { try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true) }
    catch { return false }
    return withSettingsWriteLock(file) {
        if !current() { return true }
        var values: [String: Any] = [:]
        var entry = stat()
        if lstat(file, &entry) == 0 {
            guard let data = FileManager.default.contents(atPath: file),
                  let current = decodeSettingsObject(data) else { return false }
            values = current
        } else if errno != ENOENT { return false }
        for (key, value) in patch { values[key] = value }
        if let mutate, !mutate(&values) { return false }
        values["version"] = 1
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { return false }
        do { try data.write(to: URL(fileURLWithPath: file), options: .atomic); return afterCommit() }
        catch { return false }
    }
}

/// The settings as src/settings.js reads them: a missing, mistyped or out-of-range value is the default.
struct Settings: Equatable {
    var paused = false, agentDisplay = "away", idleSeconds = 1.5, tabIdleMinutes = 10.0, notify = true, activityLog = true
    var inputMode = "auto", inputSpeed = 1.0, claudeFeed = true, uiLanguage = "auto"
    var pagePrompt = PagePromptSettingsState()
    static let displays = ["away", "secondary", "main", "off"]
    static let inputModes = ["auto", "keys", "paste"]
    static let inputSpeeds: [Double] = [0.5, 0.75, 1, 1.5, 2, 3]
    static let uiLanguages = ["auto", "en", "zh"]
    static func read() -> Settings {
        var s = Settings()
        let raw = readSettingsObject(SETTINGS_FILE)
        s.pagePrompt = PagePromptSettingsState.normalize(raw?["pagePrompt"], catalog: PagePromptCatalog.load())
        s.paused = !settingsPauseTokens(SETTINGS_FILE).isEmpty
        guard let j = raw else { return s }
        if !s.paused, let v = jsonBool(j["paused"]) { s.paused = v }
        if let v = j["agentDisplay"] as? String, displays.contains(v) { s.agentDisplay = v }
        if let v = jsonNum(j["idleSeconds"]), (0.5...10).contains(v) { s.idleSeconds = v }
        if let v = j["inputMode"] as? String, inputModes.contains(v) { s.inputMode = v }
        if let v = jsonNum(j["inputSpeed"]), inputSpeeds.contains(v) { s.inputSpeed = v }
        if let v = jsonNum(j["tabIdleMinutes"]), (0...1440).contains(v) { s.tabIdleMinutes = v }
        if let v = jsonBool(j["notify"]) { s.notify = v }
        if let v = jsonBool(j["activityLog"]) { s.activityLog = v }
        if let v = jsonBool(j["claudeFeed"]) { s.claudeFeed = v }
        if let v = j["uiLanguage"] as? String, uiLanguages.contains(v) { s.uiLanguage = v }
        return s
    }
    static func valid(_ key: String, _ value: Any) -> Bool {
        switch key {
        case "paused", "notify", "activityLog", "claudeFeed": return jsonBool(value) != nil
        case "agentDisplay": return (value as? String).map { displays.contains($0) } ?? false
        case "idleSeconds": return jsonNum(value).map { (0.5...10).contains($0) } ?? false
        case "tabIdleMinutes": return jsonNum(value).map { (0...1440).contains($0) } ?? false
        case "inputMode": return (value as? String).map { inputModes.contains($0) } ?? false
        case "inputSpeed": return jsonNum(value).map { inputSpeeds.contains($0) } ?? false
        case "uiLanguage": return (value as? String).map { uiLanguages.contains($0) } ?? false
        case "pagePrompt": return PagePromptSettingsState.normalize(value, catalog: PagePromptCatalog.load()).valid
        default: return false
        }
    }
    /// Prepare on the caller thread: pause is immediately visible to workers;
    /// resume captures only the requests that already exist. Saving may wait.
    static func prepareWrite(_ key: String, _ value: Any) -> (() -> Bool)? {
        guard key != "pagePrompt", valid(key, value) else { return nil }
        if key == "paused", jsonBool(value) == true {
            guard let token = requestSettingsPause(SETTINGS_FILE) else { return nil }
            return {
                _ = writeSettingsObject(SETTINGS_FILE, [key: value], when: { settingsPauseTokens(SETTINGS_FILE).contains(token) })
                return true // The independent pause request already succeeded.
            }
        }
        let observed = key == "paused" ? settingsPauseTokens(SETTINGS_FILE) : []
        return {
            writeSettingsObject(SETTINGS_FILE, [key: value], afterCommit: { clearSettingsPauseTokens(SETTINGS_FILE, observed) })
        }
    }
    /// CLI callers execute the same prepared write synchronously.
    @discardableResult
    static func write(_ key: String, _ value: Any) -> Bool {
        guard let write = prepareWrite(key, value) else { return false }
        return write()
    }
}
/// The CHROME_BRIDGE_* variable that fixes a setting (src/settings.js SETTINGS[key].env).
let SETTING_ENV = ["agentDisplay": "CHROME_BRIDGE_AGENT_DISPLAY", "idleSeconds": "CHROME_BRIDGE_IDLE_S",
                   "tabIdleMinutes": "CHROME_BRIDGE_TAB_TTL_MIN", "notify": "CHROME_BRIDGE_NOTIFY",
                   "inputMode": "CHROME_BRIDGE_INPUT_MODE", "inputSpeed": "CHROME_BRIDGE_INPUT_SPEED"]

/// One MCP server (one AI session), from its presence file servers/<pid>.json.
struct ServerInfo: Identifiable {
    let id: Int32
    let who: String, color: Int, version: String, startedAt: Double
    let busy: String?, lastActionAt: Double?
    let root: String?, srcHash: String?
    let envLocked: [String: Any]
    var checks: SetupChecks? = nil
    var needsRestart: Bool? = nil
    /// The hot-swap launcher this server runs under (src/launcher.js): part of the same session, and the
    /// session takes new code by itself (no restart).
    var launcher: Int32? = nil
    var guiInstance: String? = nil
    var node: String? = nil
    var conversationThread: String? = nil
    var conversationBinding: String? = nil
    var conversationPending: Int = 0
    var conversationRequestKey: String? = nil
    var conversationTitle: String? = nil
    var conversationProvider: String? = nil
    var conversationStatus: String? = nil
    var managedSession = false
    var model: String? = nil
    var effort: String? = nil
    var cwd: String? = nil
    var pagePrompt: PagePromptDeliveryStatus? = nil
}
/// A session's setup check (src/doctor.js runChecks, run in that session's own app).
struct SetupChecks {
    let at: Double, app: String?, items: [Check]
}
func parseSetupChecks(_ v: Any?) -> SetupChecks? {
    guard let j = v as? [String: Any], let at = jsonNum(j["at"]), let cs = j["items"] as? [[String: Any]] else { return nil }
    return SetupChecks(at: at, app: j["app"] as? String, items: cs.map { c in
        Check(id: c["id"] as? String ?? "", title: uiTitle(c["title"] as? String ?? ""), required: jsonBool(c["required"]) ?? true,
              ok: jsonBool(c["ok"]) ?? false, skipped: jsonBool(c["skipped"]) ?? false,
              detail: uiPart(c["detail"] as? String) ?? "", fix: uiPart(c["fix"] as? String), settings: c["settings"] as? String)
    })
}

/// The live servers. `serverPids` (a ps snapshot taken at `psAt`): a pid alive but not running a server is a
/// crashed server's file whose pid was reused (Fable r13 B5), removed like a dead one — only when the snapshot is
/// newer than the server's start (a session started since the last ps is not judged by it: Codex/Fable r13 r2 A1).
func liveServers(serverPids: Set<Int32>? = nil, psAt: Double = 0) -> [ServerInfo] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: SERVER_DIR)) ?? []
    var out: [ServerInfo] = []
    for n in names where n.hasSuffix(".json") {
        let path = SERVER_DIR + "/" + n
        guard let j = readJSON(path), let pid = (j["pid"] as? NSNumber)?.int32Value else { continue }
        let started = jsonNum(j["startedAt"]) ?? 0
        let reused = serverPids.map { !$0.contains(pid) && started > 0 && started < psAt - 2000 } ?? false
        guard alive(pid), !reused else { try? FileManager.default.removeItem(atPath: path); continue }
        out.append(ServerInfo(id: pid, who: uiWho(j["who"] as? String), color: Int(jsonNum(j["color"]) ?? 0),
            version: j["version"] as? String ?? "", startedAt: jsonNum(j["startedAt"]) ?? 0,
            busy: j["busy"] as? String, lastActionAt: jsonNum(j["lastActionAt"]),
            root: j["root"] as? String, srcHash: j["srcHash"] as? String,
            envLocked: j["envLocked"] as? [String: Any] ?? [:], checks: parseSetupChecks(j["checks"]),
            launcher: (j["launcher"] as? NSNumber)?.int32Value, guiInstance: j["guiInstance"] as? String,
            node: j["node"] as? String, conversationThread: j["conversationThread"] as? String,
            conversationBinding: j["conversationBinding"] as? String,
            conversationPending: (j["conversationPending"] as? NSNumber)?.intValue ?? 0,
            conversationRequestKey: j["conversationRequestKey"] as? String,
            conversationTitle: j["conversationTitle"] as? String, conversationProvider: j["conversationProvider"] as? String,
            conversationStatus: j["conversationStatus"] as? String,
            managedSession: j["managedSession"] as? Bool ?? false,
            model: j["model"] as? String, effort: j["effort"] as? String, cwd: j["cwd"] as? String,
            pagePrompt: PagePromptDeliveryStatus.parse(j["pagePrompt"])))
    }
    return out.sorted { $0.startedAt < $1.startedAt }
}

/// Run a program and return its output and exit code (nil: it could not start or ran past the timeout).
func runQuick(_ exe: String, _ args: [String], cwd: String? = nil, timeout: Double = 3) -> (out: String, code: Int32)? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let cwd = cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    // Read as it comes (a full pipe would stall the program) and never wait past the timeout on the main thread.
    var data = Data()
    let lock = NSLock()
    pipe.fileHandleForReading.readabilityHandler = { h in
        let d = h.availableData
        lock.lock(); data.append(d); lock.unlock()
    }
    do { try p.run() } catch { pipe.fileHandleForReading.readabilityHandler = nil; return nil }
    let deadline = Date().addingTimeInterval(timeout)
    while p.isRunning && Date() < deadline { usleep(5_000) }
    pipe.fileHandleForReading.readabilityHandler = nil
    if p.isRunning { p.terminate(); return nil }
    lock.lock(); data.append(pipe.fileHandleForReading.availableData); let all = data; lock.unlock()
    return (String(decoding: all, as: UTF8.self), p.terminationStatus)
}

/// src/restart.js scriptOf: the script a `node [options] <script> …` command runs, as a real path; nil for anything
/// else and for an option it does not know (it might take the next word as its value: Codex r15 restart r9 A2).
let NODE_VALUED: Set<String> = ["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions",
    "--input-type", "--env-file", "--env-file-if-exists", "--title", "--watch-path", "--inspect-port", "--debug-port",
    "--redirect-warnings", "--report-dir", "--report-filename", "--icu-data-dir", "--openssl-config", "--dns-result-order"]
let NODE_NOT_SCRIPT: Set<String> = ["-e", "--eval", "-p", "--print", "-c", "--check", "-i", "--interactive", "--test", "-v", "--version", "-h", "--help",
    "--run"]
let NODE_EQ: Set<String> = ["--max-old-space-size", "--max-semi-space-size", "--stack-size", "--stack-trace-limit", "--inspect", "--inspect-brk",
    "--unhandled-rejections", "--max-http-header-size"]
let NODE_BOOL: Set<String> = ["--enable-source-maps", "--no-warnings", "--no-deprecation", "--trace-warnings", "--trace-deprecation",
    "--trace-uncaught", "--expose-gc", "--inspect", "--inspect-brk", "--watch", "--experimental-vm-modules", "--preserve-symlinks",
    "--preserve-symlinks-main", "--no-experimental-fetch", "--throw-deprecation", "--pending-deprecation", "--abort-on-uncaught-exception"]
func nodeScript<S: StringProtocol>(_ cmd: S) -> String? {
    let w = String(cmd).split(separator: " ").map(String.init)
    guard let exe = w.first, exe == "node" || exe.hasSuffix("/node") else { return nil }
    var i = 1
    while i < w.count, w[i].hasPrefix("-") {
        let o = w[i]
        if o == "--" { i += 1; break }
        let name = String(o.split(separator: "=").first ?? "")
        if NODE_NOT_SCRIPT.contains(name) { return nil }
        if o.contains("=") { if NODE_VALUED.contains(name) || NODE_EQ.contains(name) { i += 1; continue }; return nil }
        if NODE_BOOL.contains(o) { i += 1; continue }
        if NODE_VALUED.contains(o) { i += 2; continue }
        return nil
    }
    guard i < w.count, w[i].contains("/") else { return nil }
    return realPath(w[i])
}

/// From ps: every process that runs an MCP server or managed session worker (any checkout),
/// not a doctor run nor a hot-swap launcher's look at new code), and those of this checkout. nil when ps could not run.
func isManagedSessionCommand<S: StringProtocol>(_ cmd: S) -> Bool {
    nodeScript(cmd)?.hasSuffix("/src/session-worker.js") == true
}
func serverProcesses() -> (all: Set<Int32>, here: Set<Int32>, parent: [Int32: Int32])? {
    guard let r = runQuick("/bin/ps", ["-axo", "pid=,ppid=,command="]) else { return nil }
    let script = ROOT_DIR + "/src/index.js"
    var all = Set<Int32>(), here = Set<Int32>(), parent: [Int32: Int32] = [:]
    for line in r.out.split(separator: "\n") {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard let sp1 = t.firstIndex(of: " "), let pid = Int32(t[..<sp1]), pid != getpid() else { continue }
        let rest = t[sp1...].drop(while: { $0 == " " })
        guard let sp2 = rest.firstIndex(of: " "), let ppid = Int32(rest[..<sp2]) else { continue }
        let cmd = rest[sp2...]
        guard (cmd.contains("src/index.js") || cmd.contains("mychrome-mcp") || isManagedSessionCommand(cmd)), !cmd.contains(" doctor"), !cmd.contains(" --probe"),
              !cmd.contains(" restart-all") else { continue }
        all.insert(pid)
        parent[pid] = ppid
        // This checkout: node running a script whose real path is its src/index.js (directly or through a linked
        // `mychrome-mcp`), not a process that only names that path among its arguments (Codex r15 restart r7 B3, r8 A2).
        if nodeScript(cmd) == script { here.insert(pid) }
    }
    return (all, here, parent)
}

/// One line of the setup check (src/doctor.js).
struct Check: Identifiable {
    let id: String, title: String, required: Bool, ok: Bool, skipped: Bool
    let detail: String, fix: String?, settings: String?
}
/// doctor writes "中文\nEnglish" and titles "中文 / English": the panel shows the part in the UI language (I18N1; a text
/// without the English part is shown as it is).
func uiPart(_ s: String?) -> String? {
    guard let s = s, !s.isEmpty else { return nil }
    let parts = s.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
    return String((uiEnglish() && parts.count > 1 ? parts[1] : parts.first) ?? "")
}
func uiTitle(_ s: String) -> String {
    let parts = s.components(separatedBy: " / ")
    return uiEnglish() && parts.count > 1 ? parts.dropFirst().joined(separator: " / ") : parts.first ?? s
}
/// A session's label as the server writes it (src/index.js agentIdentity: "<client> · 主目录" for the home folder).
func uiWho(_ who: String?) -> String {
    guard let who else { return L("AI 助手", "AI assistant") }
    let home = " · 主目录"   // i18n-exempt: the server's label, matched to translate it
    return uiEnglish() && who.hasSuffix(home) ? String(who.dropLast(home.count)) + " · home folder" : who
}
/// The checks that are permissions the owner turns on (the rest: Chrome open, installed, the setup itself).
let PERMISSION_CHECKS: Set<String> = ["automation", "apple_events_js", "accessibility", "screen_recording"]
/// What to do, for someone who does not use a terminal: doctor's own text names commands for two of them.
func fixText(_ c: Check, app: String?) -> String {
    switch c.id {
    case "chrome_running": return L("打开 Google Chrome，AI 才能用它。", "Open Google Chrome so the AI can use it.")
    case "automation" where c.settings == nil:
        return L("AI 第一次用浏览器时，macOS 会问「“\(app ?? "这个程序")”想要控制“Google Chrome”」，点「允许」就行。", "The first time the AI uses the browser, macOS asks whether “\(app ?? "this app")” may control “Google Chrome”. Click Allow.")
    default: return c.fix ?? c.detail
    }
}

/// A failed check's title says what is wrong ("在运行" read as a heading looks like good news).
func failTitle(_ c: Check) -> String {
    switch c.id {
    case "chrome_running": return L("Google Chrome 没有打开", "Google Chrome is not open")
    case "chrome_installed": return L("没有安装 Google Chrome", "Google Chrome is not installed")
    default: return c.title
    }
}

/// The freshest check of each app the sessions run in (one session per app answers a request).
func checksByApp(_ servers: [ServerInfo]) -> [SetupChecks] {
    var best: [String: SetupChecks] = [:]
    for s in servers where !s.managedSession { if let c = s.checks { let k = c.app ?? "?"; if best[k].map({ $0.at < c.at }) ?? true { best[k] = c } } }
    return best.values.sorted { ($0.app ?? "") < ($1.app ?? "") }
}

/// One tool call from activity.jsonl: what, where (the host only), who, whether it worked.
struct ActivityItem: Identifiable {
    let id: Int
    let t: Double, who: String, color: Int, tool: String, host: String?, ok: Bool, code: String?
}
func readActivity(limit: Int = 300) -> [ActivityItem] {
    // The previous file first (src/settings.js renames the log past its size cap), then the current one.
    let text = [ACTIVITY_OLD, ACTIVITY_FILE].compactMap { FileManager.default.contents(atPath: $0) }.map { String(decoding: $0, as: UTF8.self) }.joined(separator: "\n")
    guard !text.isEmpty else { return [] }
    let lines = text.split(separator: "\n").suffix(limit)
    var out: [ActivityItem] = []
    for (i, l) in lines.enumerated() {
        guard let j = (try? JSONSerialization.jsonObject(with: Data(l.utf8))) as? [String: Any], let t = jsonNum(j["t"]) else { continue }
        out.append(ActivityItem(id: i, t: t, who: uiWho(j["who"] as? String), color: Int(jsonNum(j["color"]) ?? 0),
            tool: j["tool"] as? String ?? "", host: j["host"] as? String, ok: jsonBool(j["ok"]) ?? false, code: j["code"] as? String))
    }
    return out.reversed()
}
var TOOL_LABEL: [String: String] { ["open_tab": L("打开网页", "Open page"), "close_tab": L("关闭标签", "Close tab"), "read_page": L("读取页面", "Read page"), "click": L("点击", "Click"), "type_text": L("输入文字", "Type text"),
                  "scroll": L("滚动页面", "Scroll page"), "select_option": L("选择选项", "Choose option"), "answer_dialog": L("回答网页弹窗", "Answer page dialog"), "wait_for_user": L("等你处理", "Wait for you"),
                  "click_at": L("按位置点击", "Click at position"), "press_key": L("按键", "Press key"), "hover": L("鼠标悬停", "Hover"), "screenshot": L("截图", "Screenshot"), "auto_close": L("自动关闭标签", "Auto-close tab")] }
/// Why MyChrome closed an agent tab by itself (src/tabs.js decideSweep reasons).
func autoCloseText(_ code: String?) -> String {
    switch code ?? "" {
    case "idle": return L("很久没用", "Unused for a long time")
    case "session_end": return L("开它的 AI 会话结束了", "The AI session that opened it ended")
    case "owner_gone": return L("开它的 AI 会话已经不在了", "The AI session that opened it is gone")
    default: return L("AI 的标签", "AI tab")
    }
}
/// Why a call did not work, in plain words (the codes of src/index.js BridgeError).
func failureText(_ code: String?) -> String {
    switch code ?? "" {
    case "user_cancelled": return L("操作已停止：可能是用户停止，或接管已结束或无法确认", "Stopped: you may have stopped it, or the takeover ended or could not be confirmed")
    case "cancelled": return L("AI 那边中途取消了这次操作", "The AI cancelled this action midway")
    case "wait_timeout": return L("等到时间了，你还没处理", "Timed out before you handled it")
    case "tab_gone": return L("标签已经关掉了", "The tab was already closed")
    case "field_gone": return L("要你填的框不见了", "The field you were asked to fill disappeared")
    case "paused_by_user": return L("当时 AI 操作已暂停", "AI operations were paused")
    case "site_blocked": return L("网站要你处理（验证码等）", "The site needed you (CAPTCHA or similar)")
    case "input_held", "user_busy": return L("你一直在操作，没等到空闲", "You kept working; no idle moment came")
    case "input_stuck": return L("有按键卡住了", "A key was stuck")
    case "user_interrupted", "mouse_interrupted": return L("你中途动了键盘鼠标", "You used the keyboard or mouse midway")
    case "secure_input": return L("当时在输入密码，系统不允许操作", "A password was being typed; macOS did not allow input")
    case "screen_locked", "displays_asleep": return L("屏幕锁着或在睡眠", "The screen was locked or asleep")
    case "taken_over", "not_your_tab", "not_agent_tab": return L("这个标签不归它用", "This tab was not its to use")
    case "lock_timeout": return L("排队太久，没轮到", "Queued too long; its turn never came")
    case "bad_url", "bad_args", "why_required": return L("AI 给的参数不对", "The AI gave invalid parameters")
    case "unknown_tool": return L("AI 调了不存在的功能", "The AI called a function that does not exist")
    case "not_on_top", "activate_failed", "window_covered", "target_covered", "not_key_window": return L("没能把窗口切到前面", "Could not bring the window to the front")
    default: return L("没做成", "Did not succeed")
    }
}

// MARK: - the model: keep-awake state, power assertions, tasks

final class Model: ObservableObject {
    let routines = RoutineModel()
    let onboarding = OnboardingModel()
    let newSession = NewSessionModel()
    @Published var newSessionPresented = false
    @Published var workspaceDestination = "conversations"
    @Published var settingsError: String? = nil
    private let settingsWriteQueue = DispatchQueue(label: "work.mychrome.settings-save", qos: .userInitiated)
    @Published var selectedConversation: Int32? = nil
    @Published var conversation: ConversationState? = nil
    @Published var loadedConversationKey: String? = nil
    @Published var availableConversations: [String: [[String: Any]]] = [:]
    @Published var associationNotes: [String: String] = [:]
    @Published var associating = Set<String>()
    @Published var drafts: [String: String] = [:]
    @Published var draftTitles: [String: String] = [:]
    @Published var answerDrafts: [String: [String: String]] = [:]
    @Published var answerQuestions: [String: [[String: Any]]] = [:]
    @Published var unconfirmedSends: [String: [String: Any]] = [:]
    @Published var deliveryNotes: [String: String] = [:]
    @Published var deliveryStates: [String: String] = [:]
    @Published var sendingTo = Set<String>()
    @Published var interruptingConversations = Set<String>()
    @Published var generationNotes: [String: String] = [:]
    var initializedNewConversations = Set<String>()
    var localConversationTitles: [String: String] = [:]
    @Published var gotoNotes: [Int32: String] = [:]
    var openConversations: ((Int32?) -> Void)?
    var openOnboarding: (() -> Void)?
    var conversationVisible = false
    var conversationReading = false
    var gotoPending: [Int32: (id: String, generation: String, at: Double)] = [:]
    var guiRequestAt = 0.0
    @Published var mode = "off"
    @Published var until: Double?
    @Published var holding = false
    @Published var tasks: [AgentTask] = []
    @Published var now = nowMs()
    // The habits card.
    @Published var habits: HabitsInfo?
    @Published var habitsOff = habitsPath() == nil
    @Published var recordingUntil: Double?
    @Published var recordError: String?
    @Published var confirmDelete = false
    // Pages, settings, sessions, the setup check, the activity log.
    @Published var page = "status"
    @Published var settings = Settings()
    @Published var servers: [ServerInfo] = []
    @Published var legacy: [Int32] = []
    /// The last 「全部重启」 run (src/restart.js), and when the button was pressed (until the run's file appears).
    @Published var restartJob: RestartJob?
    @Published var restartPressedAt: Double?
    @Published var restartError: String?
    private var restartDeadSeenAt: Double?
    /// When the panel last asked the sessions to check again (nil: no request pending).
    @Published var checkRequestedAt: Double?
    /// Every issued request starts the automatic missing-result retry window, even after one app answers.
    private var lastCheckRequestedAt: Double?
    @Published var activity: [ActivityItem] = []
    @Published var confirmClear = false
    @Published var clearNote: String?
    private var clearConfirmationGeneration = 0
    /// A rebuilt binary that ran, waiting for the habits recording to end before it takes over.
    private var pendingHandover: (exe: String, stamp: Double)?
    private var activityStamp: (Double, Int) = (-1, -1)
    /// From the slow refresh (background queue): ps and this checkout's source fingerprint.
    private var serverPids: (all: Set<Int32>, here: Set<Int32>, parent: [Int32: Int32])?
    private var psAt = 0.0
    private var currentHash: String?
    private var slowAt = 0.0, slowRunning = false
    private var exeStamp: Double?
    private var recorder: Process?
    private var cancelling = false
    let live: Bool
    private var displayAssertion: IOPMAssertionID = 0, systemAssertion: IOPMAssertionID = 0
    private var lastActivity = 0.0, sawTask = false, modeSetAt = 0.0
    private var timer: Timer?

    /// live: read and write the files, hold the assertions. Not live: a picture only (--snapshot).
    init(live: Bool) {
        self.live = live
        guard live else { return }
        tick()
        // Common modes: an open panel must not stop expiry or the task check.
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func choose(_ key: String) {
        guard live else { mode = key; return }
        setMode(key)
        tick()
    }

    func tick() {
        var m = readJSON(MODE_FILE) ?? ["mode": "off"]
        let setAt = (m["setAt"] as? NSNumber)?.doubleValue ?? 0
        if setAt != modeSetAt { modeSetAt = setAt; sawTask = false }
        let t = liveTasks()
        var want = false
        switch m["mode"] as? String ?? "off" {
        case "forever": want = true
        case "task":
            if !t.isEmpty { sawTask = true }
            // Until the task running now (or the next one, if none is) is done.
            want = !t.isEmpty || !sawTask
            if sawTask && t.isEmpty { setMode("off"); m = readJSON(MODE_FILE) ?? m }
        case "off": want = false
        default:
            want = nowMs() < ((m["until"] as? NSNumber)?.doubleValue ?? 0)
            if !want { setMode("off"); m = readJSON(MODE_FILE) ?? m }
        }
        hold(want)
        mode = m["mode"] as? String ?? "off"
        until = (m["until"] as? NSNumber)?.doubleValue
        tasks = t
        habits = readHabits()
        now = nowMs()
        if onboarding.visible { onboarding.refreshLanguage() }   // I18N1: a changed Language setting reaches an open guide
        refreshPanelData()
        refreshConversation()
        refreshGotoResults()
        if let request = readJSON(BASE + "/open-gui.json"), let at = jsonNum(request["at"]),
           at > guiRequestAt, abs(now - at) < 10_000 {
            guiRequestAt = at
            openConversations?(nil)
        }
        writeJSON(STATE_FILE, ["pid": Int(getpid()), "mode": mode, "holding": holding, "until": until ?? NSNull(),
                               "tasks": t.count, "at": now, "handoffGUI": true])
    }

    func hold(_ on: Bool) {
        if on && !holding {
            let why = "MyChrome keep screen awake" as CFString
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), why, &displayAssertion)
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), why, &systemAssertion)
            holding = true
        } else if !on && holding {
            IOPMAssertionRelease(displayAssertion)
            IOPMAssertionRelease(systemAssertion)
            holding = false
        }
        // The screen saver and the lock follow the idle timer, not display sleep: declare activity now and then.
        if holding && nowMs() - lastActivity > 50_000 {
            var id: IOPMAssertionID = 0
            IOPMAssertionDeclareUserActivity("MyChrome keep screen awake" as CFString, kIOPMUserActiveLocal, &id)
            lastActivity = nowMs()
        }
    }

    // MARK: habits

    /// Use this installation's helper for both the source binary and the App bundle.
    func startRecording() {
        guard live, recorder == nil else { return }
        guard let path = habitsPath() else { recordError = L("现在设置为不使用习惯（CHROME_BRIDGE_HABITS=off），所以不录制。", "Habits are turned off (CHROME_BRIDGE_HABITS=off), so nothing is recorded."); return }
        let exe = URL(fileURLWithPath: ROOT_DIR).appendingPathComponent("bin/cgevent")
        let p = Process()
        p.executableURL = exe
        p.arguments = ["habits", "record", "--seconds", String(Int(RECORD_SECONDS)), "--out", path]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            let data = out.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async { self?.recordingEnded(proc.terminationStatus, data) }
        }
        do { try p.run() } catch { recordError = L("录制没能开始：找不到 \(exe.path)", "Recording could not start: \(exe.path) was not found"); return }
        recorder = p
        cancelling = false
        recordError = nil
        confirmDelete = false
        recordingUntil = nowMs() + RECORD_SECONDS * 1000
    }

    /// SIGTERM: the recorder stops and writes nothing.
    func cancelRecording() {
        cancelling = true
        recorder?.terminate()
    }

    func recordingEnded(_ status: Int32, _ data: Data) {
        recorder = nil
        recordingUntil = nil
        if let p = pendingHandover { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.handOver(to: p.exe, stamp: p.stamp) } }
        if status != 0 && !cancelling {
            let reply = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            recordError = habitsRecordError(reply?["error"] as? String, message: reply?["message"] as? String, status: status)
        }
        cancelling = false
        tick()
    }

    /// The helper's own words are Chinese (bin/cgevent habits record); in English the panel says it by the error code.
    func habitsRecordError(_ code: String?, message: String?, status: Int32) -> String {
        if !uiEnglish(), let message { return message }
        switch code ?? "" {
        case "no_input_monitor": return L("录制没能开始：系统没有允许监听键盘鼠标。", "Recording could not start: macOS has not allowed keyboard and mouse monitoring. In System Settings → Privacy & Security → Accessibility (or Input Monitoring), turn on the app that runs it.")
        case "write_failed": return L("录制结果没能保存。", "The recording could not be saved.")
        case "habits_off": return L("现在设置为不使用习惯（CHROME_BRIDGE_HABITS=off），所以不录制。", "Habits are turned off (CHROME_BRIDGE_HABITS=off), so nothing is recorded.")
        default: return L("录制没有完成（退出码 \(status)）。", "Recording did not finish (exit code \(status)).")
        }
    }

    /// The switch "按我的习惯操作": the `use` field of the summary (the helper reads it at every action).
    func setUse(_ on: Bool) {
        guard live, let p = habitsPath(), var j = readJSON(p) else { return }
        j["use"] = on
        if let d = try? JSONSerialization.data(withJSONObject: j, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: URL(fileURLWithPath: p), options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: p)
        }
        tick()
    }

    /// Two clicks: the first asks, the second removes the summary file (nothing else is kept anywhere).
    func deleteHabits() {
        guard live else { return }
        if !confirmDelete {
            confirmDelete = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.confirmDelete = false }
            return
        }
        confirmDelete = false
        if let p = habitsPath() { try? FileManager.default.removeItem(atPath: p) }
        tick()
    }

    var habitsState: String { recordingUntil != nil ? "recording" : habits != nil ? "recorded" : "none" }

    // MARK: settings, sessions, setup check, activity

    /// Every tick: the settings and the presence files (small reads); the activity log when it changed.
    /// Every 30 s, off the main thread: ps (old servers, reused pids) and this checkout's source fingerprint
    /// (「需要重启」). Every 10 s: whether this program itself was rebuilt (then a fresh copy takes over).
    func refreshPanelData() {
        let st = Settings.read()
        if st != settings { settings = st }
        var sv = namedConversations(liveServers(serverPids: serverPids?.all, psAt: psAt))
        for i in sv.indices where !sv[i].managedSession && sameRoot(sv[i].root) {
            if let a = sv[i].srcHash, let b = currentHash { sv[i].needsRestart = a != b }
        }
        servers = sv
        legacy = serverPids.map { Array($0.here.subtracting(sv.map { $0.id }).subtracting(sv.compactMap { $0.launcher })).sorted() } ?? []
        let job = readRestartJob()
        if job != restartJob {
            // The first read that finds this run dead starts its 15 minutes (a new run starts over: r2 B1).
            if let j = job, j.died, !(restartJob?.died == true && restartJob?.startedAt == j.startedAt) { restartDeadSeenAt = now }
            restartJob = job
        }
        if let at = restartPressedAt, (job.map { $0.startedAt >= at - 5000 } ?? false) || now - at > 15_000 { restartPressedAt = nil }
        if let at = checkRequestedAt, checksByApp(sv).contains(where: { $0.at >= at }) || now - at > 30_000 { checkRequestedAt = nil }
        // A session with no result (it skipped its own check, the one it relied on is gone): ask (Codex r13 r4 A1).
        if live, !settings.paused, checkRequestedAt == nil, (lastCheckRequestedAt.map { now - $0 >= 30_000 } ?? true), sv.contains(where: { !$0.managedSession && $0.checks == nil && now - $0.startedAt > 20_000 }) { requestChecks(force: true) }
        let attrs = [ACTIVITY_FILE, ACTIVITY_OLD].map { try? FileManager.default.attributesOfItem(atPath: $0) }
        let stamp = (attrs.compactMap { ($0?[.modificationDate] as? Date)?.timeIntervalSince1970 }.max() ?? -1,
                     attrs.compactMap { ($0?[.size] as? NSNumber)?.intValue }.reduce(0, +))
        if stamp != activityStamp { activityStamp = stamp; activity = readActivity() }
        if now - slowAt > 30_000 && !slowRunning {
            slowAt = now
            slowRunning = true
            DispatchQueue.global(qos: .utility).async { [weak self] in
                let at = nowMs(), ps = serverProcesses(), hash = sourceFingerprint(ROOT_DIR)
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.slowRunning = false
                    if ps != nil { self.serverPids = ps; self.psAt = at }
                    self.currentHash = hash
                    self.refreshPanelData()
                }
            }
        }
        if Int(now / 1000) % 10 == 0 { relaunchIfRebuilt() }
    }

    /// A setting a live server's MCP config fixes (a CHROME_BRIDGE_* variable), with its value and which session.
    func lockedValue(_ key: String) -> (value: Any, who: String)? {
        servers.lazy.compactMap { s in s.envLocked[key].map { ($0, s.who) } }.first
    }

    func set(_ key: String, _ value: Any) {
        guard live else { return }
        guard let commit = Settings.prepareWrite(key, value) else {
            settingsError = L("设置未能保存，原设置仍保留。请稍后再试。", "The setting was not saved; the previous setting is kept. Please try again later.")
            return
        }
        settingsError = nil
        // Pause is made visible before any background preference write waits.
        settings = Settings.read()
        settingsWriteQueue.async { [weak self] in
            let saved = commit()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.settings = Settings.read()
                self.settingsError = saved ? nil : L("设置未能保存，原设置仍保留。请稍后再试。", "The setting was not saved; the previous setting is kept. Please try again later.")
                if saved && key == "paused" {
                    self.checkRequestedAt = nil
                    if !self.settings.paused {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.requestChecks(force: true) }
                    }
                }
            }
        }
    }

    func mutatePagePrompt(_ operation: [String: Any], completion: ((Bool) -> Void)? = nil) {
        guard live else { completion?(false); return }
        settingsError = nil
        settingsWriteQueue.async { [weak self] in
            let saved = writePagePromptMutation(operation)
            DispatchQueue.main.async { [weak self] in
                guard let self else { completion?(false); return }
                self.settings = Settings.read()
                self.settingsError = saved ? nil : L("网页弹窗设置未能保存。原设置已保留，请检查模板、规则或稍后重试。", "Page pop-up settings were not saved. The previous settings are kept; check the template and rules, or try again later.")
                completion?(saved)
            }
        }
    }

    /// Sessions on old code that do not update themselves (「需要重启」 and the older ones without a presence file),
    /// one per session as restart-all counts them: servers with the same parent are one (Codex r15 restart r1 B10).
    var staleCount: Int {
        let pids = servers.filter { !$0.managedSession && $0.needsRestart == true && $0.launcher == nil }.map { $0.id } + legacy
        return Set(pids.map { serverPids?.parent[$0] ?? -$0 }).count
    }
    var restartRunning: Bool { restartPressedAt != nil || restartJob?.running == true }
    /// The last run's list stays on the page for 15 minutes after it ends (a run that died: after it was seen dead).
    var restartShown: Bool {
        guard let j = restartJob else { return false }
        return j.running || now - (j.finished ? j.at : restartDeadSeenAt ?? now) < 15 * 60_000
    }

    /// 「全部重启」: `node src/index.js restart-all` of this checkout, on its own (it outlives the panel, e.g. a
    /// rebuilt panel taking over); it writes its progress to RESTART_FILE, read at every tick.
    func restartAll() {
        guard live, !restartRunning else { return }
        var nodes: [String] = []
        for n in (try? FileManager.default.contentsOfDirectory(atPath: SERVER_DIR)) ?? [] where n.hasSuffix(".json") {
            if let node = readJSON(SERVER_DIR + "/" + n)?["node"] as? String { nodes.append(node) }
        }
        nodes += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        guard let node = nodes.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            restartError = L("找不到 node，没法开始重启。", "node was not found, so the restart could not start.")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [ROOT_DIR + "/src/index.js", "restart-all"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { restartError = L("没能开始重启：\(node) 启动不了。", "The restart could not start: \(node) did not launch."); return }
        restartError = nil
        restartPressedAt = nowMs()
    }

    /// Ask every session to run its setup check again (they watch this file); results come in their presence files.
    func requestChecks(force: Bool = false) {
        guard live, checkRequestedAt == nil, !settings.paused else { return }
        let newest = checksByApp(servers).map { $0.at }.max() ?? 0
        // Chrome closed or missing changes by itself (opened since: Fable r13 r3 B3): checked again at once. A missing
        // permission changes only when the owner changes it, and then they press 「重新检查」 (Fable r13 r4 B3).
        let chromeGone = appChecks.flatMap { $0.items }.contains { !$0.ok && !$0.skipped && ($0.id == "chrome_running" || $0.id == "chrome_installed") }
        if !force && !chromeGone && now - newest < 5 * 60_000 { return }
        guard servers.contains(where: { !$0.managedSession }) else { return }
        let at = nowMs()
        try? String(Int(at)).write(toFile: CHECK_REQUEST, atomically: true, encoding: .utf8)
        checkRequestedAt = at
        lastCheckRequestedAt = at
    }

    var appChecks: [SetupChecks] { checksByApp(servers) }
    /// The header's word for what is wrong: permissions first, then Chrome itself, then the setup.
    var setupProblem: String? {
        let failed = appChecks.flatMap { $0.items }.filter { !$0.ok && !$0.skipped && $0.required }
        if failed.contains(where: { PERMISSION_CHECKS.contains($0.id) }) { return L("有权限没打开", "A permission is off") }
        if failed.contains(where: { $0.id == "chrome_installed" }) { return L("没有安装 Chrome", "Chrome is not installed") }
        if failed.contains(where: { $0.id == "chrome_running" }) { return L("Chrome 没有打开", "Chrome is not open") }
        return failed.isEmpty ? nil : L("安装有问题", "Setup problem")
    }
    var problems: Bool { setupProblem != nil }

    func openSettingsPane(_ url: String) {
        guard live, let u = URL(string: url) else { return }
        NSWorkspace.shared.open(u)
    }
    /// 「带我去」: the session that waits brings its page to the front (it raises that one window only).
    func gotoAlert(_ t: AgentTask) {
        guard live, let tab = t.alertTab else { return }
        let id = UUID().uuidString
        guard writeGotoRequest(pid: t.id, tab: tab, task: t, requestId: id) != nil,
              let generation = t.sessionGeneration else {
            gotoNotes[t.id] = L("这个提醒已更新，请选择当前任务再试。", "This alert has changed. Choose the current task and try again.")
            return
        }
        gotoPending[t.id] = (id, generation, nowMs())
        gotoNotes[t.id] = L("正在定位页面…", "Finding the page…")
    }
    func openChrome() {
        guard live, let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else { return }
        NSWorkspace.shared.openApplication(at: u, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.requestChecks(force: true) }
    }

    /// Two clicks, like deleting the habits: the first asks, the second removes both log files.
    func clearActivity() {
        guard live else { return }
        clearConfirmationGeneration &+= 1
        let generation = clearConfirmationGeneration
        if !confirmClear {
            confirmClear = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                guard let self, self.clearConfirmationGeneration == generation else { return }
                self.confirmClear = false
            }
            return
        }
        confirmClear = false
        // Under the lock src/settings.js rotates with, so a rotation cannot bring the old lines back (Codex r13 r2 B3).
        let lock = ACTIVITY_FILE + ".lock"
        var locked = false
        for _ in 0..<12 where !locked {
            locked = mkdir(lock, 0o755) == 0
            if !locked {
                if let m = (try? FileManager.default.attributesOfItem(atPath: lock))?[.modificationDate] as? Date, Date().timeIntervalSince(m) > 10 {
                    try? FileManager.default.removeItem(atPath: lock)
                } else { usleep(25_000) }
            }
        }
        // Without the lock a rotation may be in its middle: delete nothing rather than let old lines come back (Codex r13 r3 B1).
        guard locked else {
            // Still one click from clearing; the note goes by itself (Fable r13 r4 B5).
            confirmClear = true
            clearNote = L("记录正在整理，过几秒再点一次「再点一次，确认清空」。", "The log is being tidied up. In a few seconds, click “Click again to clear” again.")
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self, self.clearConfirmationGeneration == generation else { return }
                self.clearNote = nil; self.confirmClear = false
            }
            return
        }
        clearNote = nil
        for f in [ACTIVITY_OLD, ACTIVITY_FILE] { try? FileManager.default.removeItem(atPath: f) }
        rmdir(lock)
        activityStamp = (-1, -1)
        activity = []
    }

    /// bin/cbmenu was rebuilt (an update): start the new one and leave — once the new binary has shown it runs
    /// (a broken build would leave no panel at all: Fable r13 B13). Not while recording habits.
    func relaunchIfRebuilt() {
        guard live, recorder == nil else { return }
        let exe = (Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])).resolvingSymlinksInPath().path
        guard let m = (try? FileManager.default.attributesOfItem(atPath: exe))?[.modificationDate] as? Date else { return }
        let t = m.timeIntervalSince1970 * 1000
        if exeStamp == nil { exeStamp = t; return }
        guard t != exeStamp, now - t > 3000 else { return }
        exeStamp = t
        // The new binary must run before this one leaves; tried off the main thread (Codex r13 r2 B4).
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let ok = runQuick(exe, ["--read-settings"], timeout: 5)?.code == 0
            DispatchQueue.main.async { if ok { self?.handOver(to: exe, stamp: t) } }
        }
    }

    private func handOver(to exe: String, stamp: Double) {
        guard live, exeStamp == stamp else { return }
        // Recording habits: hand over when it ends (Codex/Fable r13 r3 B4).
        if recorder != nil { pendingHandover = (exe, stamp); return }
        pendingHandover = nil
        hold(false)
        try? FileManager.default.removeItem(atPath: PID_FILE)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        if (try? p.run()) != nil { exit(0) }
        try? String(getpid()).write(toFile: PID_FILE, atomically: true, encoding: .utf8)
        tick()
    }

    /// Both menu Quit and process signals must cancel an in-flight recording before leaving.
    func prepareForExit() {
        onboarding.stop()
        newSession.stop()
        if let recorder, recorder.isRunning {
            cancelling = true
            recorder.terminate()
        }
        hold(false)
        try? FileManager.default.removeItem(atPath: PID_FILE)
    }

    func quit() {
        prepareForExit()
        setMode("off")
        writeJSON(STATE_FILE, ["pid": Int(getpid()), "mode": "off", "holding": false, "at": nowMs(), "quit": true])
        NSApp.terminate(nil)
    }

    var on: Bool { mode != "off" }
    var attentionTasks: [AgentTask] {
        var result = tasks
        for s in servers where s.conversationPending > 0 {
            if let i = result.firstIndex(where: { $0.id == s.id }) {
                if result[i].alert == nil {
                    result[i].alert = L("有 \(s.conversationPending) 个问题等你回复", "\(s.conversationPending) question(s) waiting for your reply")
                    result[i].alertToken = (s.conversationBinding ?? "") + (s.conversationRequestKey ?? "")
                }
            } else {
                result.append(AgentTask(id: s.id, who: s.who, task: s.conversationTitle ?? s.who, stepName: "", current: nil, total: nil, color: s.color, etaMs: nil, etaAt: nil,
                      alert: L("有 \(s.conversationPending) 个问题等你回复", "\(s.conversationPending) question(s) waiting for your reply"), alertToken: (s.conversationBinding ?? "") + (s.conversationRequestKey ?? "")))
            }
        }
        return result
    }
    var needsYou: Bool { attentionTasks.contains { $0.alert != nil } }

    /// The plain-language line under the switch.
    var keepLine: String {
        switch mode {
        case "off": return L("已关闭，按系统设置自动息屏", "Off: the display sleeps as set in macOS")
        case "forever": return L("一直保持，直到你在这里关闭", "Stays on until you turn it off here")
        case "task": return tasks.isEmpty ? L("AI 开始并结束任务后，自动关闭屏幕常亮", "Turns off by itself after the AI starts and finishes a task") : L("任务结束后，自动关闭屏幕常亮", "Turns off by itself when the task ends")
        default: return L("剩余 ", "Remaining: ") + minutesText(max(0, (until ?? now) - now)) + L("，之后恢复系统息屏设置", "; then your usual display sleep returns")
        }
    }
}

// MARK: - look

func hex(_ h: Int) -> Color {
    Color(.sRGB, red: Double((h >> 16) & 0xFF) / 255, green: Double((h >> 8) & 0xFF) / 255, blue: Double(h & 0xFF) / 255)
}
/// Error text needs a lighter red on dark cards; the solid white-text alert keeps its darker fill.
let ALERT = Color(nsColor: NSColor(name: nil, dynamicProvider: { appearance in
    let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    return dark ? NSColor(srgbRed: 1, green: 0.54, blue: 0.54, alpha: 1)
                : NSColor(srgbRed: 0.86, green: 0.15, blue: 0.15, alpha: 1)
}))
/// The assistant colours, as on the overlay's panel (src/helper.swift VeilPanel).
let WHO_COLORS: [Color] = [0x3B7BFF, 0x8B5CF6, 0xEC4899, 0xF97316, 0x0D9488, 0xCA8A04].map(hex)
func whoColor(_ i: Int) -> Color { WHO_COLORS[((i % 6) + 6) % 6] }
/// The overlay's aurora, so the panel and the veil look like one product.
let AURORA = LinearGradient(colors: [hex(0x5B9BFF), hex(0xA47BFF), hex(0xFF6FB5), hex(0xFFB066)],
                            startPoint: .topLeading, endPoint: .bottomTrailing)
let SUN = LinearGradient(colors: [hex(0xFFB547), hex(0xFF8A3D)], startPoint: .top, endPoint: .bottom)

struct Card<Content: View>: View {
    @Environment(\.colorScheme) var scheme
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(scheme == .dark ? Color.white.opacity(0.06) : Color.white.opacity(0.85)))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(scheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.06)))
            .shadow(color: .black.opacity(scheme == .dark ? 0 : 0.04), radius: 6, y: 2)
    }
}

struct SectionTitle: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary).textCase(nil)
    }
}

/// A pill switch drawn by hand: it looks the same everywhere, including in --snapshot pictures.
struct PillSwitch: View {
    let isOn: Bool
    var fill: LinearGradient = SUN
    var label: (on: String, off: String) = (L("关掉屏幕常亮", "Stop keeping screen awake"), L("打开屏幕常亮", "Keep screen awake"))
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule().fill(isOn ? AnyShapeStyle(fill) : AnyShapeStyle(Color.secondary.opacity(0.25)))
                    .frame(width: 44, height: 26)
                Circle().fill(.white).frame(width: 22, height: 22).padding(2)
                    .shadow(color: .black.opacity(0.18), radius: 1.5, y: 1)
            }
            .animation(.spring(response: 0.28, dampingFraction: 0.8), value: isOn)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isOn ? label.on : label.off)
    }
}

struct Bar: View {
    let fraction: Double, color: Color
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.15))
                Capsule().fill(LinearGradient(colors: [color.opacity(0.75), color], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(8, g.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: 6)
    }
}

/// A softly breathing dot: "working right now".
struct LiveDot: View {
    let color: Color
    @State private var big = false
    var body: some View {
        ZStack {
            Circle().fill(color.opacity(0.25)).frame(width: 18, height: 18).scaleEffect(big ? 1 : 0.55)
            Circle().fill(color).frame(width: 9, height: 9)
        }
        .frame(width: 18, height: 18)
        .onAppear { withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { big = true } }
    }
}

// MARK: - the panel

/// Secondary text that stays readable in dark mode (the system .secondary is too dim on the dark card).
let SUBTLE = Color.primary.opacity(0.62)

struct Keycap: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 11, weight: .semibold, design: .rounded))
            .padding(.horizontal, 6).padding(.vertical, 1.5)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color.primary.opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Color.primary.opacity(0.25)))
    }
}

struct TaskRow: View {
    let t: AgentTask
    let now: Double
    /// 「带我去」 under the alert: to the page that waits for the user (nil: no such page).
    var onGoto: (() -> Void)? = nil
    var body: some View {
        let c = whoColor(t.color)
        HStack(alignment: .top, spacing: 10) {
            LiveDot(color: t.alert != nil ? ALERT : c)
            VStack(alignment: .leading, spacing: 6) {
                if let a = t.alert {
                    Label(a, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(hex(0xDC2626)))
                        .fixedSize(horizontal: false, vertical: true)
                    if let go = onGoto { PlainButton(text: L("带我去那个页面", "Take me to that page"), action: go) }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.task.isEmpty ? L("正在使用你的 Chrome", "Using your Chrome") : t.task)
                        .font(.system(size: 14, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Text(t.who).font(.system(size: 11)).foregroundStyle(SUBTLE).lineLimit(1)
                }
                if let cur = t.current, let n = t.total, n > 0 {
                    Bar(fraction: Double(max(0, cur - 1)) / Double(n), color: c)
                    Text(L("正在进行第 \(cur) 步，共 \(n) 步", "Step \(cur) of \(n)")).font(.system(size: 12, weight: .medium))
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if !t.stepName.isEmpty { Text(t.stepName).foregroundStyle(SUBTLE).lineLimit(1) }
                        Spacer(minLength: 6)
                        if let left = t.leftMs(at: now) { Text(L("预计还需 ", "Time left: about ") + minutesText(left)).foregroundStyle(SUBTLE) }
                    }
                    .font(.system(size: 11))
                }
            }
        }
    }
}

/// One line of what the habits card learned.
struct Fact: View {
    let icon: String, text: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 11)).foregroundStyle(SUBTLE).frame(width: 16)
            Text(text).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct PlainButton: View {
    let text: String
    var destructive = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(text).font(.system(size: 12, weight: .medium))
                .foregroundStyle(destructive ? ALERT : Color.primary)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(destructive ? ALERT.opacity(0.1) : Color.primary.opacity(0.07)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A row of choices, one selected (keep-awake durations, settings with a few values).
struct Choices: View {
    let options: [(key: String, label: String)]
    let selected: String
    var columns = 3
    var disabled = false
    let pick: (String) -> Void
    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: columns), spacing: 6) {
            ForEach(options, id: \.key) { o in
                let sel = selected == o.key
                Button { pick(o.key) } label: {
                    Text(o.label).font(.system(size: 12, weight: sel ? .semibold : .regular))
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity).padding(.vertical, 7)
                        .foregroundStyle(sel ? Color.white : Color.primary)
                        .background(RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(sel ? hex(0x3B7BFF) : Color.primary.opacity(0.07)))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
            }
        }
        .opacity(disabled ? 0.5 : 1)
    }
}

/// Icon, title, one line of explanation, and a control on the right.
struct SettingRow<Trailing: View>: View {
    let icon: String, title: String, sub: String
    var tint: Color = SUBTLE
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 17)).foregroundStyle(tint).frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .semibold))
                Text(sub).font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            trailing
        }
    }
}

/// "Fixed by the MCP config": the setting cannot be changed here.
struct LockedNote: View {
    let env: String, value: String, who: String
    var body: some View {
        Label(L("「\(who)」的 MCP 配置里固定为「\(value)」（\(env)），这里改不了；删掉配置里这一项后才能在这里改。", "Fixed to “\(value)” in the MCP configuration of “\(who)” (\(env)). Remove that entry from the configuration to change it here."), systemImage: "lock.fill")
            .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
    }
}

var DISPLAY_OPTIONS: [(key: String, label: String)] { [("away", L("你没在用的屏幕", "Display not in use")), ("secondary", L("固定在副屏", "Always secondary")), ("main", L("固定在主屏", "Always main")), ("off", L("开在你的窗口里", "In your window"))] }
var DISPLAY_SUB: [String: String] { [
    "away": L("有两块屏幕时，AI 的窗口放在你鼠标不在的那块，不挡你；只有一块屏幕时，开在单独的窗口里。", "With two displays, the AI's window goes on the one your pointer is not on, out of your way. With one display, it opens in a separate window."),
    "secondary": L("AI 的窗口总在副屏（没有副屏时在主屏）。", "The AI's window is always on the secondary display (the main display when there is none)."),
    "main": L("AI 的窗口总在主屏。", "The AI's window is always on the main display."),
    "off": L("不单独开窗口：AI 的标签开在你当前的 Chrome 窗口里，在后台打开，不切换你正在看的标签。", "No separate window: the AI's tabs open in the background of your current Chrome window, without switching away from the tab you are viewing.")
] }
/// I18N1: an environment variable of this app that overrides the Language setting (uiLanguageChoice's order), or nil: then
/// the picker shows the language it fixes and is disabled.
func uiLanguageLock(environment: [String: String] = ProcessInfo.processInfo.environment) -> (key: String, variable: String, value: String)? {
    let ui = (environment["CHROME_BRIDGE_UI_LANG"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if ui == "en" || ui == "zh" { return (ui, "CHROME_BRIDGE_UI_LANG", ui) }
    if let legacy = environment["CHROME_BRIDGE_LANG"], !legacy.isEmpty { return (legacy.lowercased().hasPrefix("zh") ? "zh" : "en", "CHROME_BRIDGE_LANG", legacy) }
    return nil
}
/// I18N1: SETTINGS.uiLanguage. Each language is named in its own words.
var UI_LANGUAGE_OPTIONS: [(key: String, label: String)] { [("auto", L("跟随系统", "Follow system")), ("en", "English"), ("zh", "中文")] }   // i18n-exempt: a language's own name
var IDLE_OPTIONS: [(key: String, label: String)] { [("1.5", L("1.5 秒", "1.5 s")), ("3", L("3 秒", "3 s")), ("5", L("5 秒", "5 s"))] }
var TAB_OPTIONS: [(key: String, label: String)] { [("10", L("10 分钟", "10 min")), ("30", L("30 分钟", "30 min")), ("60", L("1 小时", "1 hour")), ("0", L("不自动关", "Never"))] }
func numKey(_ x: Double) -> String { x == x.rounded() ? String(Int(x)) : oneDecimal(x) }
func lockedText(_ key: String, _ v: Any) -> String {
    switch key {
    case "agentDisplay": return DISPLAY_OPTIONS.first { $0.key == v as? String }?.label ?? "\(v)"
    case "idleSeconds": return L("\(jsonNum(v).map(numKey) ?? "\(v)") 秒", "\(jsonNum(v).map(numKey) ?? "\(v)") s")
    case "tabIdleMinutes": return jsonNum(v).map { $0 > 0 ? L("\(numKey($0)) 分钟", "\(numKey($0)) min") : L("不自动关", "Never") } ?? "\(v)"
    case "notify": return jsonBool(v) == false ? L("关", "Off") : L("开", "On")
    default: return "\(v)"
    }
}
func timeText(_ ms: Double, day: Bool = false) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: uiEnglish() ? "en_US_POSIX" : "zh_CN")
    f.dateFormat = day ? L("M月d日", "MMM d") : "HH:mm"
    return f.string(from: Date(timeIntervalSince1970: ms / 1000))
}
/// "18:20" today, "昨天 18:20", "10月12日 18:20" (sessions live for days: Fable r13 B9).
func whenText(_ ms: Double, now: Double) -> String {
    let d = dayTitle(ms, now: now)
    return d == L("今天", "Today") ? timeText(ms) : d + " " + timeText(ms)
}
func dayTitle(_ ms: Double, now: Double) -> String {
    let cal = Calendar.current, d = Date(timeIntervalSince1970: ms / 1000), n = Date(timeIntervalSince1970: now / 1000)
    if cal.isDate(d, inSameDayAs: n) { return L("今天", "Today") }
    if let y = cal.date(byAdding: .day, value: -1, to: n), cal.isDate(d, inSameDayAs: y) { return L("昨天", "Yesterday") }
    return timeText(ms, day: true)
}

struct Panel: View {
    @ObservedObject var model: Model
    let close: () -> Void
    /// false: the whole page, however tall (--snapshot); true: the page scrolls past the screen's room, as it is now.
    var fit = true

    /// The visible screen minus the header, tabs and footer: a popover taller than the screen gets cut off.
    static func screenRoom() -> CGFloat { max(320, (NSScreen.main?.visibleFrame.height ?? 900) - 230) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            tabs
            if fit {
                let room = Panel.screenRoom()
                ScrollView(.vertical) { page }.frame(maxHeight: room)
            } else {
                page
            }
            Divider().opacity(0.6)
            footer
        }
        .padding(16)
        .frame(width: 360)
    }

    var page: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch model.page {
            case "settings": settingsPage
            case "records": recordsPage
            default: statusPage
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: header and page switch

    var headerLine: (String, Color) {
        if model.needsYou { return (L("需要你处理一下", "Needs your attention"), ALERT) }
        if model.settings.paused { return (L("AI 操作已暂停", "AI operations paused"), hex(0xEA6A0C)) }
        if !model.tasks.isEmpty || model.servers.contains(where: { $0.busy != nil }) { return (L("AI 正在操作", "AI is working"), hex(0x3B7BFF)) }
        if let p = model.setupProblem { return (p, ALERT) }
        if !model.settings.paused, model.servers.contains(where: { !$0.managedSession }), model.appChecks.isEmpty { return (L("正在检查权限", "Checking permissions"), SUBTLE) }
        if model.servers.isEmpty { return (L("没有 AI 连接", "No AI connection"), SUBTLE) }
        return (L("一切就绪", "All set"), hex(0x16A34A))
    }

    var header: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 11, style: .continuous).fill(AURORA).frame(width: 40, height: 40)
                .overlay(Image(systemName: "cursorarrow.rays").font(.system(size: 18, weight: .semibold)).foregroundStyle(.white))
                .shadow(color: hex(0xA47BFF).opacity(0.35), radius: 6, y: 3)
            VStack(alignment: .leading, spacing: 2) {
                Text(L("AI 浏览器助手", "AI browser assistant")).font(.system(size: 16, weight: .bold))
                HStack(spacing: 6) {
                    Text(headerLine.0).foregroundStyle(headerLine.1)
                    Text("·").foregroundStyle(SUBTLE)
                    Text("MyChrome").foregroundStyle(SUBTLE)
                }
                .font(.system(size: 12, weight: .medium))
            }
            Spacer()
            if model.holding {
                Image(systemName: "sun.max.fill").font(.system(size: 14)).foregroundStyle(hex(0xF97316))
                    .help(L("屏幕常亮已开启", "Keeping the screen awake"))
            }
        }
    }

    var tabs: some View {
        HStack(spacing: 4) {
            ForEach([("status", L("状态", "Status")), ("settings", L("设置", "Settings")), ("records", L("记录", "Activity"))], id: \.0) { key, label in
                let sel = model.page == key
                Button { model.page = key; if key == "status" { model.requestChecks() } } label: {
                    HStack(spacing: 4) {
                        Text(label).font(.system(size: 12, weight: sel ? .semibold : .medium))
                        if key == "status" && (model.problems || model.needsYou || !model.legacy.isEmpty || model.servers.contains { $0.needsRestart == true && $0.launcher == nil }) {
                            Circle().fill(ALERT).frame(width: 6, height: 6)
                        }
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
                    .foregroundStyle(sel ? Color.primary : SUBTLE)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(sel ? Color.primary.opacity(0.1) : Color.clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.05)))
    }

    func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: title)
            Card { content() }
        }
    }

    // MARK: 状态

    @ViewBuilder var statusPage: some View {
        Button { model.openConversations?(nil); close() } label: {
            Label(L("打开会话中心", "Open conversation center"), systemImage: "bubble.left.and.bubble.right")
                .font(.system(size: 14, weight: .semibold)).frame(maxWidth: .infinity).padding(.vertical, 8)
        }.buttonStyle(.borderedProminent)
        Button { model.openOnboarding?(); close() } label: {
            Label(onboardingText("入门引导", "Getting started"), systemImage: "questionmark.circle")
                .frame(maxWidth: .infinity)
        }.buttonStyle(.bordered)
        if model.settings.paused {
            Card {
                SettingRow(icon: "pause.circle.fill", title: L("AI 操作已暂停", "AI operations paused"), sub: L("AI 现在不能操作你的 Chrome，它会收到「已暂停」并等你恢复。", "The AI cannot operate your Chrome now. It is told “paused” and waits until you resume."), tint: hex(0xEA6A0C)) {
                    PlainButton(text: L("恢复", "Resume")) { model.set("paused", false) }
                }
            }
        }
        if !model.tasks.isEmpty { section(L("AI 任务", "AI tasks")) { tasksBody } }
        section(L("AI 会话", "AI sessions")) { sessionsBody }
        section(L("准备情况", "Readiness")) { checksBody }
        section(L("屏幕常亮", "Keep screen awake")) { keepBody }
    }

    @ViewBuilder var tasksBody: some View {
        ForEach(Array(model.tasks.enumerated()), id: \.element.id) { i, t in
            if i > 0 { Divider() }
            TaskRow(t: t, now: model.now, onGoto: t.alert != nil && t.alertTab != nil ? { model.gotoAlert(t) } : nil)
            if let note = model.gotoNotes[t.id] { Text(note).font(.system(size: 11)).foregroundStyle(SUBTLE) }
        }
    }

    @ViewBuilder var sessionsBody: some View {
        if model.servers.isEmpty && model.legacy.isEmpty {
            HStack(spacing: 12) {
                Image(systemName: "cup.and.saucer.fill").font(.system(size: 20)).foregroundStyle(SUBTLE).frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("目前没有 AI 连接", "No AI connection yet")).font(.system(size: 14, weight: .semibold))
                    Text(L("AI 助手第一次用你的浏览器时，会出现在这里。", "An AI assistant appears here the first time it uses your browser.")).font(.system(size: 11)).foregroundStyle(SUBTLE)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        ForEach(Array(model.servers.enumerated()), id: \.element.id) { i, s in
            if i > 0 { Divider() }
            HStack(alignment: .top, spacing: 10) {
                if s.busy != nil { LiveDot(color: whoColor(s.color)) }
                else { Circle().fill(whoColor(s.color).opacity(0.55)).frame(width: 9, height: 9).frame(width: 18, height: 18) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.who).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(sessionLine(s)).font(.system(size: 11)).foregroundStyle(SUBTLE).lineLimit(1).help(sessionLine(s))   // I18N1: the longer English line may be cut
                }
                Spacer(minLength: 6)
                if !s.managedSession && s.needsRestart == true && s.launcher != nil {
                    Text(L("会自动更新", "Updates itself")).font(.system(size: 11, weight: .semibold)).foregroundStyle(SUBTLE)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Capsule().fill(SUBTLE.opacity(0.12)))
                        .help(L("MyChrome 更新过。这个会话空下来（没有操作进行中）后会自己换成新版，不用重启，它开的标签也保留。", "MyChrome was updated. When this session is idle (no action in progress), it switches to the new version by itself. No restart is needed, and its tabs stay open."))
                } else if !s.managedSession && s.needsRestart == true {
                    Text(L("需要重启", "Needs restart")).font(.system(size: 11, weight: .semibold)).foregroundStyle(ALERT)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Capsule().fill(ALERT.opacity(0.1)))
                        .help(L("这个会话开始时 MyChrome 还不会自动更新。点下面的「全部重启」，或者在这个会话里输入 /mcp reconnect chrome-bridge（不用关会话；它开的标签会被关掉）。之后的更新会自动换上。", "This session started before MyChrome could update itself. Click Restart all below, or type /mcp reconnect chrome-bridge in this session (the session stays open; its tabs are closed). Later updates then apply automatically."))
                } else if s.busy != nil {
                    Text(L("正在操作", "Working")).font(.system(size: 11, weight: .semibold)).foregroundStyle(hex(0x3B7BFF))
                }
            }
        }
        if !model.legacy.isEmpty {
            if !model.servers.isEmpty { Divider() }
            Label(L("另有 \(model.legacy.count) 个 AI 会话还在用旧版本 MyChrome：点下面的「全部重启」，才会用上新版本和这里的设置。", "\(model.legacy.count) more AI session(s) still use an older MyChrome. Click Restart all below to use the new version and these settings."),
                  systemImage: "arrow.triangle.2.circlepath")
                .font(.system(size: 11)).foregroundStyle(ALERT).fixedSize(horizontal: false, vertical: true)
        }
        if model.staleCount > 0 || model.restartShown || model.restartRunning {
            if !model.servers.isEmpty || !model.legacy.isEmpty { Divider() }
            restartBlock
        }
    }

    /// 「全部重启」 and, while it runs and for a while after, where each session is.
    @ViewBuilder var restartBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.restartRunning {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L("正在重启，每个会话空下来时换一个…", "Restarting each session when it is idle…")).font(.system(size: 12, weight: .medium))
                }
            } else if model.staleCount > 0 {
                PlainButton(text: L("全部重启（\(model.staleCount) 个会话）", "Restart all (\(model.staleCount) session(s))")) { model.restartAll() }
                Text(L("每个会话空下来、输入框也是空的时候，替它输入 /mcp reconnect chrome-bridge；后台会话用 claude respawn。对话都还在，它们开的标签会被关掉。", "When a session is idle and its input box is empty, MyChrome types /mcp reconnect chrome-bridge for it; background sessions use claude respawn. Conversations are kept; the tabs they opened are closed."))
                    .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            }
            if let e = model.restartError {
                Text(e).font(.system(size: 11)).foregroundStyle(ALERT).fixedSize(horizontal: false, vertical: true)
            }
            if model.restartShown, let job = model.restartJob {
                if let e = job.error {
                    Text(uiEnglish() && e.unicodeScalars.contains(where: { $0.value >= 0x3000 })
                         ? L("全部重启没能进行", "Restart all could not run. Run mychrome-mcp restart-all in a terminal to see why.") : e).font(.system(size: 11)).foregroundStyle(ALERT).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(job.items) { i in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: restartIcon(i.state)).font(.system(size: 12)).foregroundStyle(restartColor(i.state)).frame(width: 16)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(i.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                            Text(restartNoteText(state: i.state, how: i.how, note: i.note)).font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }
    func restartIcon(_ state: String) -> String {
        switch state {
        case "done": return "checkmark.circle.fill"
        case "failed": return "exclamationmark.circle.fill"
        case "skipped": return "minus.circle"
        default: return "clock"
        }
    }
    func restartColor(_ state: String) -> Color {
        switch state {
        case "done": return hex(0x16A34A)
        case "failed": return ALERT
        case "skipped": return hex(0xD97706)
        default: return SUBTLE
        }
    }

    func sessionLine(_ s: ServerInfo) -> String {
        var parts = [L("连接于 ", "Since ") + (s.startedAt > 0 ? whenText(s.startedAt, now: model.now) : "?")]
        if let b = s.busy { parts.append(L("正在", "Now: ") + (TOOL_LABEL[b] ?? L("操作", "working"))) }
        else if let a = s.lastActionAt { parts.append(L("上次操作 ", "last: ") + whenText(a, now: model.now)) }
        else { parts.append(L("还没操作过", "No actions yet")) }
        return parts.joined(separator: " · ")
    }

    /// One block per app the sessions run in: the permissions are that app's (Codex r13 A6).
    @ViewBuilder var checksBody: some View {
        let apps = model.appChecks
        if model.settings.paused {
            Text(L("AI 操作已暂停，暂停期间不检查；恢复后会自动再查一次。", "AI operations are paused, so no checks run. They run again automatically when you resume.")).font(.system(size: 12)).foregroundStyle(SUBTLE)
                .fixedSize(horizontal: false, vertical: true)
        } else if apps.isEmpty {
            Text(model.servers.contains(where: { !$0.managedSession }) ? L("正在检查权限…", "Checking permissions…") : L("浏览器连接启用后，会在这里检查权限。", "Permissions are checked here once a browser connection is active."))
                .font(.system(size: 12)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
        }
        ForEach(Array(apps.enumerated()), id: \.offset) { i, a in
            if i > 0 { Divider() }
            let failed = a.items.filter { !$0.ok && !$0.skipped }
            let app = a.app ?? L("运行 AI 的程序", "the app running the AI")
            if failed.isEmpty {
                SettingRow(icon: "checkmark.seal.fill", title: apps.count > 1 ? L("「\(app)」：权限都已打开", "“\(app)”: all permissions on") : L("权限都已打开", "All permissions on"),
                           sub: L("\(a.items.count) 项检查都通过（检查的是「\(app)」，AI 助手在这个程序里运行）", "All \(a.items.count) checks passed (checked for “\(app)”, the app the AI assistant runs in)"), tint: hex(0x16A34A)) { EmptyView() }
            } else {
                if apps.count > 1 { Text(L("「\(app)」里的 AI 会话", "AI sessions in “\(app)”")).font(.system(size: 11, weight: .semibold)).foregroundStyle(SUBTLE) }
                ForEach(failed) { c in
                    VStack(alignment: .leading, spacing: 6) {
                        Label(failTitle(c), systemImage: c.required ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(c.required ? ALERT : hex(0xEA6A0C))
                        Text(fixText(c, app: a.app)).font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                        if c.id == "chrome_running" { PlainButton(text: L("打开 Chrome", "Open Chrome")) { model.openChrome() } }
                        else if let u = c.settings { PlainButton(text: L("打开系统设置", "Open System Settings")) { model.openSettingsPane(u) } }
                    }
                }
                if failed.contains(where: { PERMISSION_CHECKS.contains($0.id) }) {
                    Text(L("要给「\(app)」打开：AI 助手在哪个程序里运行，就给哪个程序。", "Turn these on for “\(app)”: permissions go to the app the AI assistant runs in."))
                        .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        HStack {
            if let at = apps.map({ $0.at }).max() { Text(L("检查于 ", "Checked: ") + whenText(at, now: model.now)).font(.system(size: 11)).foregroundStyle(SUBTLE) }
            Spacer()
            if model.servers.contains(where: { !$0.managedSession }) && !model.settings.paused {
                PlainButton(text: model.checkRequestedAt != nil ? L("正在检查…", "Checking…") : L("重新检查", "Check again")) { model.requestChecks(force: true) }
            }
        }
    }

    @ViewBuilder var keepBody: some View {
        HStack(spacing: 12) {
            Image(systemName: model.on ? "sun.max.fill" : "moon.zzz.fill")
                .font(.system(size: 18))
                .foregroundStyle(model.on ? hex(0xF97316) : SUBTLE)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(L("保持屏幕常亮", "Keep screen awake")).font(.system(size: 14, weight: .semibold))
                Text(model.keepLine).font(.system(size: 11))
                    .foregroundStyle(SUBTLE)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            PillSwitch(isOn: model.on) { model.choose(model.on ? "off" : (model.tasks.isEmpty ? "60" : "task")) }
        }
        if model.on {
            VStack(alignment: .leading, spacing: 6) {
                Text(L("保持多久", "For how long")).font(.system(size: 11, weight: .medium)).foregroundStyle(SUBTLE)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
                    ForEach(DURATIONS) { d in
                        let sel = model.mode == d.key
                        Button { model.choose(d.key) } label: {
                            Text(d.label).font(.system(size: 12, weight: sel ? .semibold : .regular))
                                .lineLimit(1).minimumScaleFactor(0.85)
                                .frame(maxWidth: .infinity).padding(.vertical, 7)
                                .foregroundStyle(sel ? Color.white : Color.primary)
                                .background(RoundedRectangle(cornerRadius: 9, style: .continuous)
                                    .fill(sel ? hex(0xEA6A0C) : Color.primary.opacity(0.07)))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: 设置

    @ViewBuilder var settingsPage: some View {
        let s = model.settings
        section(L("暂停", "Pause")) {
            SettingRow(icon: s.paused ? "pause.circle.fill" : "play.circle", title: L("暂停 AI 操作", "Pause AI operations"),
                       sub: s.paused ? L("已暂停：AI 不能操作你的 Chrome，只能看到它自己开的标签；它会收到「已暂停」并等你恢复。", "Paused: the AI cannot operate your Chrome and sees only the tabs it opened. It is told “paused” and waits until you resume.") : L("需要安心用电脑时打开：AI 不会操作你的浏览器，也不会自动关标签。", "Turn on when you want the computer to yourself: the AI does not operate your browser or close tabs automatically."),
                       tint: s.paused ? hex(0xEA6A0C) : SUBTLE) {
                PillSwitch(isOn: s.paused, fill: SUN, label: (L("恢复 AI 操作", "Resume AI operations"), L("暂停 AI 操作", "Pause AI operations"))) { model.set("paused", !s.paused) }
            }
            if s.paused && !model.legacy.isEmpty {
                Text(L("有 \(model.legacy.count) 个旧版本的 AI 会话不认这个开关，重启这些会话后才会一起暂停。", "\(model.legacy.count) AI session(s) on an older version ignore this switch; they pause too only after they restart."))
                    .font(.system(size: 11)).foregroundStyle(ALERT).fixedSize(horizontal: false, vertical: true)
            }
        }
        section(L("AI 的窗口放在哪", "Where the AI's window goes")) {
            let lock = model.lockedValue("agentDisplay")
            let cur = (lock?.value as? String) ?? s.agentDisplay
            Choices(options: DISPLAY_OPTIONS, selected: cur, columns: 2, disabled: lock != nil) { model.set("agentDisplay", $0) }
            Text(DISPLAY_SUB[cur] ?? "").font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            if let l = lock { LockedNote(env: SETTING_ENV["agentDisplay"]!, value: lockedText("agentDisplay", l.value), who: l.who) }
        }
        section(L("接管键盘鼠标前，等你停手", "Wait for you to pause before taking over")) {
            let lock = model.lockedValue("idleSeconds")
            Choices(options: IDLE_OPTIONS, selected: numKey(lock.flatMap { jsonNum($0.value) } ?? s.idleSeconds), disabled: lock != nil) { model.set("idleSeconds", Double($0) ?? 1.5) }
            Text(L("AI 要用键盘鼠标时，先等你停手这么久再接管；你在打字时它会等，不会抢着操作。只动鼠标不算在操作。", "Before using the keyboard and mouse, the AI waits until you have paused this long. While you type, it waits and never grabs control. Moving the mouse alone does not count."))
                .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            if let l = lock { LockedNote(env: SETTING_ENV["idleSeconds"]!, value: lockedText("idleSeconds", l.value), who: l.who) }
        }
        section(L("AI 开的标签，多久没用就关掉", "Close AI tabs after they are unused for")) {
            let lock = model.lockedValue("tabIdleMinutes")
            Choices(options: TAB_OPTIONS, selected: numKey(lock.flatMap { jsonNum($0.value) } ?? s.tabIdleMinutes), columns: 4, disabled: lock != nil) {
                model.set("tabIdleMinutes", Double($0) ?? 10)
            }
            Text(L("只关 AI 自己开的标签；你自己开的、或你接手用过的标签从来不关。AI 会话结束时，它开的标签也会关掉。", "Only tabs the AI opened are closed; tabs you opened or took over are never closed. When an AI session ends, its tabs close too."))
                .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            if let l = lock { LockedNote(env: SETTING_ENV["tabIdleMinutes"]!, value: lockedText("tabIdleMinutes", l.value), who: l.who) }
        }
        section(L("通知与记录", "Notifications and activity")) {
            let lock = model.lockedValue("notify")
            let notifyOn = lock.flatMap { jsonBool($0.value) } ?? s.notify
            SettingRow(icon: notifyOn ? "bell.fill" : "bell.slash", title: L("系统通知", "System notifications"),
                       sub: L("网站要你处理（如验证码）、AI 好像卡住了、或 AI 操作时拦下了你的按键，会弹通知告诉你。", "You get a notification when a site needs you (such as a CAPTCHA), the AI seems stuck, or your keys were held back during an AI action."), tint: notifyOn ? hex(0x3B7BFF) : SUBTLE) {
                PillSwitch(isOn: notifyOn, fill: AURORA, label: (L("关闭系统通知", "Turn off system notifications"), L("打开系统通知", "Turn on system notifications"))) { model.set("notify", !notifyOn) }
                    .disabled(lock != nil).opacity(lock != nil ? 0.5 : 1)
            }
            if let l = lock { LockedNote(env: SETTING_ENV["notify"]!, value: lockedText("notify", l.value), who: l.who) }
            Divider()
            SettingRow(icon: s.activityLog ? "list.bullet.rectangle.fill" : "list.bullet.rectangle", title: L("记录 AI 的操作", "Log AI actions"),
                       sub: L("在「记录」页查看。只记时间、网站名和操作类型，不记输入的内容；只存在这台电脑上。", "See the Activity page. Only the time, site name and action type are logged, never what was typed. The log stays on this Mac."),
                       tint: s.activityLog ? hex(0x3B7BFF) : SUBTLE) {
                PillSwitch(isOn: s.activityLog, fill: AURORA, label: (L("不再记录", "Stop logging"), L("开始记录", "Start logging"))) { model.set("activityLog", !s.activityLog) }
            }
        }
        section(L("界面语言", "Language")) {
            let lock = uiLanguageLock()
            Choices(options: UI_LANGUAGE_OPTIONS, selected: lock?.key ?? s.uiLanguage, columns: 3, disabled: lock != nil) { model.set("uiLanguage", $0) }
            if let lock {
                Label(L("由这个 App 的环境变量 \(lock.variable)=\(lock.value) 固定，这里改不了；去掉这个变量后才能在这里改。",
                        "Fixed by this app's environment variable \(lock.variable)=\(lock.value); remove it to change the language here."), systemImage: "lock.fill")
                    .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            }
            if let l = model.lockedValue("uiLanguage"), let v = l.value as? String, v == "en" || v == "zh" {
                Label(L("「\(l.who)」的 MCP 配置用 CHROME_BRIDGE_UI_LANG 固定为 \(v)：那个会话的通知和接管面板用这个语言。",
                        "The MCP configuration of “\(l.who)” sets CHROME_BRIDGE_UI_LANG to \(v): that session's notifications and takeover card use it."), systemImage: "info.circle")
                    .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            }
            Text(L("菜单栏面板、会话中心、接管提示和系统通知使用的语言。跟随系统：Mac 的首选语言是中文时用中文，否则用英文。", "The language of this panel, the conversation center, the takeover card and system notifications. Follow system uses Chinese when your Mac's preferred language is Chinese, otherwise English."))
                .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
        }
        section(L("网页弹窗", "Page pop-ups")) { PagePromptSettingsView(model: model) }
        section(L("我的操作习惯", "My operation habits")) { habitsBody }
        if !model.legacy.isEmpty {
            Text(L("这些设置改了马上生效，但只对新版本的 AI 会话有效；另有 \(model.legacy.count) 个旧会话要重启后才会用上。", "Changes apply at once, but only to AI sessions on the new version; \(model.legacy.count) older session(s) use them after a restart."))
                .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: 记录

    @ViewBuilder var recordsPage: some View {
        let items = model.activity
        let today = items.filter { Calendar.current.isDate(Date(timeIntervalSince1970: $0.t / 1000), inSameDayAs: Date(timeIntervalSince1970: model.now / 1000)) }
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: today.isEmpty ? L("最近的操作", "Recent actions") : L("今天 \(today.count) 次操作", "Today: \(today.count) action(s)") + (today.contains { !$0.ok } ? L("，\(today.filter { !$0.ok }.count) 次没做成", ", \(today.filter { !$0.ok }.count) did not succeed") : ""))
            Card {
                if items.isEmpty {
                    SettingRow(icon: "list.bullet.rectangle", title: L("还没有记录", "Nothing logged yet"),
                               sub: model.settings.activityLog ? L("AI 用你的浏览器做的每一步都会记在这里。", "Every step the AI takes in your browser is logged here.") : L("记录已关闭，可以在「设置」里打开。", "Logging is off. Turn it on in Settings.")) { EmptyView() }
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(items.prefix(150).enumerated()), id: \.element.id) { i, a in
                            if i == 0 || dayTitle(items[i - 1].t, now: model.now) != dayTitle(a.t, now: model.now) {
                                Text(dayTitle(a.t, now: model.now)).font(.system(size: 11, weight: .semibold)).foregroundStyle(SUBTLE)
                                    .padding(.top, i == 0 ? 0 : 10).padding(.bottom, 4)
                            }
                            ActivityRow(a: a)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        HStack {
            Text(L("只记网站名和操作类型，不记输入的内容。", "Only site names and action types are logged, never what was typed.")).font(.system(size: 11)).foregroundStyle(SUBTLE)
            Spacer()
            if !items.isEmpty {
                PlainButton(text: model.confirmClear ? L("再点一次，确认清空", "Click again to clear") : L("清空记录", "Clear log"), destructive: true) { model.clearActivity() }
            }
        }
        if let n = model.clearNote { Text(n).font(.system(size: 11)).foregroundStyle(hex(0xEA6A0C)) }
    }

    /// Not recorded / recording (countdown, cancel) / recorded (switch, what was learned, record again, delete).
    @ViewBuilder var habitsBody: some View {
        if let until = model.recordingUntil {
            let left = max(0, until - model.now)
            HStack(spacing: 12) {
                LiveDot(color: ALERT)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("正在录制 · 还剩 ", "Recording · left: ") + clockText(left)).font(.system(size: 14, weight: .semibold)).monospacedDigit()
                    Text(L("正常用电脑就行：只记节奏，不记按了什么、不看屏幕", "Use your Mac as usual: only rhythm is recorded, never which keys or the screen"))
                        .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                }
            }
            Bar(fraction: 1 - left / (RECORD_SECONDS * 1000), color: ALERT)
            HStack {
                Spacer()
                PlainButton(text: L("取消录制（不保存）", "Cancel recording (nothing saved)")) { model.cancelRecording() }
            }
        } else if let h = model.habits {
            HStack(spacing: 12) {
                Image(systemName: h.use ? "hand.point.up.left.fill" : "hand.point.up.left")
                    .font(.system(size: 18)).foregroundStyle(h.use ? hex(0x8B5CF6) : SUBTLE).frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("按我的习惯操作", "Use my habits")).font(.system(size: 14, weight: .semibold))
                    Text(h.use ? L("AI 打字、移动鼠标的快慢照你的来", "The AI types and moves the mouse at your pace") : L("已关闭：AI 按默认的快慢操作", "Off: the AI uses the default pace"))
                        .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                PillSwitch(isOn: h.use, fill: AURORA, label: (L("不按我的习惯操作", "Stop using my habits"), L("按我的习惯操作", "Use my habits"))) { model.setUse(!h.use) }
            }
            VStack(alignment: .leading, spacing: 5) {
                Fact(icon: "calendar", text: L("录制于 ", "Recorded: ") + dateText(h.recordedAt))
                Fact(icon: "keyboard", text: h.interKeyMs.map { L("打字间隔：一般 \(Int($0.rounded())) 毫秒（中位数）", "Typing interval: typically \(Int($0.rounded())) ms (median)") } ?? L("打字：录到的太少，用默认节奏", "Typing: too little recorded; default rhythm used"))
                Fact(icon: "computermouse", text: h.speedX.map { L("鼠标速度：默认的 \(oneDecimal($0)) 倍", "Mouse speed: \(oneDecimal($0))× the default") } ?? L("鼠标：录到的太少，用默认速度", "Mouse: too little recorded; default speed used"))
                if h.missing > 0 { Fact(icon: "info.circle", text: L("录到的太少的项目，仍用默认值", "Items with too little data keep the default values")) }
            }
            HStack {
                PlainButton(text: L("重新录制 3 分钟", "Record 3 minutes again")) { model.startRecording() }
                Spacer()
                PlainButton(text: model.confirmDelete ? L("再点一次，确认删除", "Click again to delete") : L("删除习惯数据", "Delete habit data"), destructive: true) { model.deleteHabits() }
            }
        } else {
            HStack(spacing: 12) {
                Image(systemName: "hand.point.up.left").font(.system(size: 18)).foregroundStyle(SUBTLE).frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("还没有录制", "Not recorded yet")).font(.system(size: 14, weight: .semibold))
                    Text(L("录 3 分钟你平时用电脑的样子，之后 AI 打字、移动鼠标就照你的快慢来。只记节奏，不记按了什么、不看屏幕。", "Record 3 minutes of your usual computer use; the AI then types and moves the mouse at your pace. Only rhythm is recorded, never which keys or the screen."))
                        .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                }
            }
            Button { model.startRecording() } label: {
                Label(L("录制 3 分钟", "Record 3 minutes"), systemImage: "record.circle")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                    .background(Capsule().fill(AURORA))
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        if let e = model.recordError {
            Label(e, systemImage: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(ALERT)
                .fixedSize(horizontal: false, vertical: true)
        }
        if model.habitsOff {
            Text(L("现在设置为不使用习惯（CHROME_BRIDGE_HABITS=off）。", "Habits are turned off (CHROME_BRIDGE_HABITS=off).")).font(.system(size: 11)).foregroundStyle(SUBTLE)
        }
    }

    var footer: some View {
        HStack(spacing: 6) {
            Text(L("停止操作：连按两次", "To stop: press twice")).font(.system(size: 12, weight: .medium))
            Keycap(text: "Esc")
            Spacer()
            Button(L("退出应用", "Quit")) { close(); model.quit() }
                .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(SUBTLE)
                .help(L("关掉菜单栏里的这个小图标，屏幕常亮也会关闭；不影响正在进行的 AI 任务", "Closes this menu bar icon and stops keeping the screen awake; AI tasks in progress are not affected"))
        }
    }
}

struct ActivityRow: View {
    let a: ActivityItem
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(timeText(a.t)).font(.system(size: 11, design: .rounded)).monospacedDigit().foregroundStyle(SUBTLE).frame(width: 38, alignment: .leading)
            Circle().fill(whoColor(a.color)).frame(width: 7, height: 7).padding(.top, 4)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(TOOL_LABEL[a.tool] ?? a.tool).font(.system(size: 12, weight: .medium))
                    if let h = a.host { Text(h).font(.system(size: 12)).foregroundStyle(SUBTLE).lineLimit(1).truncationMode(.middle) }
                }
                Text(a.tool == "auto_close" ? autoCloseText(a.code) + " · " + a.who : a.who).font(.system(size: 10.5)).foregroundStyle(SUBTLE).lineLimit(1)
                if !a.ok {
                    Text(L("没做成：", "Did not succeed: ") + failureText(a.code)).font(.system(size: 10.5, weight: .medium)).foregroundStyle(ALERT)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 4)
            Image(systemName: a.ok ? "checkmark" : "xmark").font(.system(size: 10, weight: .bold))
                .foregroundStyle(a.ok ? hex(0x16A34A) : ALERT).padding(.top, 3)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - app

/// The menu-bar icon and its popover. An NSStatusItem (not SwiftUI's MenuBarExtra) so it can have a stable
/// autosave name: macOS folds icons that do not fit behind its «, newest first; a first-run position on the
/// right keeps this one visible, and once the owner ⌘-drags it elsewhere macOS keeps that place instead.
final class Controller: NSObject, NSWindowDelegate, NSApplicationDelegate {
    static let autosave = "chrome-bridge"
    let model: Model
    let item: NSStatusItem
    let popover = NSPopover()
    var watch: AnyCancellable?
    var conversationWindow: NSWindow?
    var onboardingWindow: NSWindow?
    var toast: HandoffToast?
    var toastKey: String?
    var seenAlerts = Set<String>()

    init(model: Model) {
        self.model = model
        let key = "NSStatusItem Preferred Position \(Controller.autosave)"
        if UserDefaults.standard.object(forKey: key) == nil { UserDefaults.standard.set(420.0, forKey: key) }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        item.autosaveName = Controller.autosave
        item.behavior = []
        item.button?.target = self
        item.button?.action = #selector(toggle)
        item.button?.toolTip = L("AI 浏览器助手（MyChrome）", "AI browser assistant (MyChrome)")
        let host = NSHostingController(rootView: Panel(model: model, close: { [weak self] in self?.popover.performClose(nil) }))
        host.sizingOptions = .preferredContentSize
        popover.contentViewController = host
        popover.behavior = .transient
        popover.animates = true
        icon()
        model.openConversations = { [weak self] pid in self?.showConversations(pid) }
        model.openOnboarding = { [weak self] in self?.showOnboarding() }
        watch = model.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.icon(); self?.showNewAlert() } }
    }

    func showConversations(_ pid: Int32? = nil) {
        popover.performClose(nil)
        toast?.orderOut(nil)
        model.workspaceDestination = "conversations"
        if conversationWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 940, height: 680),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "MyChrome"
            window.contentView = NSHostingView(rootView: MyChromeWorkspace(model: model))
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 840, height: 580)
            window.delegate = self
            window.setFrameAutosaveName("MyChromeConversationCenter")
            window.center()
            conversationWindow = window
        }
        model.conversationVisible = true
        if let selected = model.servers.first(where: { $0.id == pid }) {
            model.selectConversation(selected)
        } else if model.chosenServer == nil,
                  let selected = model.servers.first(where: { s in model.attentionTasks.contains { $0.id == s.id && $0.alert != nil } })
                    ?? model.servers.first(where: { $0.guiInstance != nil && ($0.managedSession || $0.conversationProvider == "Codex") && $0.conversationThread != nil })
                    ?? model.servers.first(where: { $0.guiInstance != nil && $0.conversationProvider == "Codex" })
                    ?? model.servers.first {
            model.selectConversation(selected)
        }
        model.refreshConversation()
        NSApp.activate(ignoringOtherApps: true)
        if conversationWindow?.isMiniaturized == true { conversationWindow?.deminiaturize(nil) }
        conversationWindow?.makeKeyAndOrderFront(nil)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showConversations()
        return true
    }

    func showOnboarding() {
        popover.performClose(nil)
        if onboardingWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 700),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "MyChrome · " + onboardingText("入门引导", "Getting started")
            window.contentView = NSHostingView(rootView: OnboardingView(state: model.onboarding, model: model) { [weak self] reviewed in
                self?.model.onboarding.dismiss(reviewed: reviewed)
                self?.onboardingWindow?.orderOut(nil)
            })
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 780, height: 660)
            window.delegate = self
            window.center()
            onboardingWindow = window
        }
        model.onboarding.present(node: onboardingNode(root: ROOT_DIR, connectedNodes: model.servers.filter { sameRoot($0.root) }.compactMap(\.node)))
        NSApp.activate(ignoringOtherApps: true)
        if onboardingWindow?.isMiniaturized == true { onboardingWindow?.deminiaturize(nil) }
        onboardingWindow?.makeKeyAndOrderFront(nil)
    }
    func windowWillClose(_ notification: Notification) {
        if notification.object as? NSWindow === onboardingWindow { model.onboarding.dismiss() }
        if notification.object as? NSWindow === conversationWindow { model.conversationVisible = false }
    }
    func applicationWillTerminate(_ notification: Notification) { model.onboarding.stop(); model.newSession.stop() }
    func showNewAlert() {
        let current = Set(model.attentionTasks.compactMap { task in task.alert.map { _ in "\(task.id):\(task.alertToken ?? task.alert ?? "")" } })
        seenAlerts.formIntersection(current)
        if toastKey.map({ !current.contains($0) }) ?? false {
            toast?.orderOut(nil); toast = nil; toastKey = nil
        }
        guard model.settings.notify else { seenAlerts.formUnion(current); return }
        for task in model.attentionTasks where task.alert != nil {
            let key = "\(task.id):\(task.alertToken ?? task.alert ?? "")"
            guard !seenAlerts.contains(key) else { continue }
            seenAlerts.insert(key)
            toast?.orderOut(nil)
            toastKey = key
            toast = HandoffToast(model: model, task: task) { [weak self] in self?.showConversations(task.id) }
            toast?.orderFrontRegardless()
        }
    }
    func icon() {
        let busy = !model.tasks.isEmpty || model.servers.contains { $0.busy != nil }
        let name = model.needsYou ? "exclamationmark.triangle.fill" : model.settings.paused ? "pause.circle.fill"
            : model.holding ? "sun.max.fill" : (busy ? "cursorarrow.motionlines" : "cursorarrow.rays")
        let img = NSImage(systemSymbolName: name, accessibilityDescription: L("AI 浏览器助手", "AI browser assistant"))?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 15, weight: .medium))
        img?.isTemplate = true
        if item.button?.image?.name() != name { img?.setName(name); item.button?.image = img }
    }

    @objc func toggle() {
        if popover.isShown { popover.performClose(nil); return }
        guard let b = item.button else { return }
        model.tick()
        model.requestChecks()   // the header shows what is wrong on every page (Fable r13 r2 B2)
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
    }
}

@main
enum CBMenu {
    static var controller: Controller?
    /// Kept for the life of the process: a dropped signal source would leave SIGTERM ignored (seen 2026-10-06).
    static var sources: [DispatchSourceSignal] = []

    static func main() {
        let argv = Array(CommandLine.arguments.dropFirst())
        if let i = argv.firstIndex(of: "--set") {
            guard i + 1 < argv.count, setMode(argv[i + 1]) else {
                print("{\"ok\":false,\"error\":\"usage: cbmenu --set off|15|30|60|120|task|forever\"}"); exit(2)
            }
            print("{\"ok\":true,\"mode\":\"\(argv[i + 1])\"}"); exit(0)
        }
        // What the panel reads from the settings file and the activity log (test/settings.test.mjs compares with src/settings.js).
        if argv.contains("--read-settings") {
            let st = Settings.read()
            let o: [String: Any] = ["paused": st.paused, "agentDisplay": st.agentDisplay, "idleSeconds": st.idleSeconds,
                                    "tabIdleMinutes": st.tabIdleMinutes, "notify": st.notify, "activityLog": st.activityLog,
                                    "inputMode": st.inputMode, "inputSpeed": st.inputSpeed, "claudeFeed": st.claudeFeed,
                                    "uiLanguage": st.uiLanguage,
                                    "pagePrompt": st.pagePrompt.object]
            if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) { print(String(decoding: d, as: UTF8.self)) }
            exit(0)
        }
        // Pure fixture/read interface; catalog comes from this bundle's source root.
        if let i = argv.firstIndex(of: "--validate-page-prompt") {
            guard i + 1 < argv.count, let data = argv[i + 1].data(using: .utf8),
                  let request = decodeSettingsObject(data) else { exit(2) }
            let catalog = request.keys.contains("catalog") ? PagePromptCatalog.parse(request["catalog"]) : PagePromptCatalog.load()
            var result = PagePromptSettingsState.normalize(request["settings"], catalog: catalog).normalizedObject
            if let origin = request["origin"] as? String { result["origin"] = canonicalPromptOrigin(origin) as Any? ?? NSNull() }
            if let text = request["text"] as? String { result["text"] = normalizePromptText(text) }
            if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) { print(String(decoding: data, as: UTF8.self)) }
            exit(0)
        }
        if let i = argv.firstIndex(of: "--page-prompt-mutation") {
            guard i + 1 < argv.count, let data = argv[i + 1].data(using: .utf8),
                  let operation = decodeSettingsObject(data),
                  writePagePromptMutation(operation) else {
                print("{\"ok\":false,\"error\":\"page_prompt_not_saved\"}"); exit(2)
            }
            print("{\"ok\":true}"); exit(0)
        }
        if let i = argv.firstIndex(of: "--write-setting"), i + 2 < argv.count {
            let raw = argv[i + 2]
            let v: Any = raw == "true" ? true : raw == "false" ? false : Double(raw).map { $0 as Any } ?? raw
            guard Settings.valid(argv[i + 1], v) else {
                print("{\"ok\":false,\"error\":\"invalid_setting\"}"); exit(2)
            }
            guard Settings.write(argv[i + 1], v) else {
                print("{\"ok\":false,\"error\":\"settings_not_saved\"}"); exit(2)
            }
            exit(0)
        }
        if argv.contains("--read-servers") {
            // --ps-at <ms>: judge as if the ps snapshot had been taken then (tests: a snapshot older than a new session).
            let at = argv.firstIndex(of: "--ps-at").flatMap { $0 + 1 < argv.count ? Double(argv[$0 + 1]) : nil } ?? nowMs()
            let ps = serverProcesses()
            let sv = liveServers(serverPids: ps?.all, psAt: at)
            let hash = sourceFingerprint(ROOT_DIR)
            let m = Model(live: false)
            m.servers = sv
            let o: [String: Any] = [
                "root": ROOT_DIR, "srcHash": hash ?? NSNull(),
                "servers": sv.map { s -> [String: Any] in
                    let restart: Any = !s.managedSession && sameRoot(s.root) ? ((s.srcHash).flatMap { a in hash.map { a != $0 } } ?? NSNull()) as Any : NSNull()
                    return ["pid": Int(s.id), "who": s.who, "busy": s.busy ?? NSNull(), "needsRestart": restart, "envLocked": s.envLocked,
                            "launcher": s.launcher.map { Int($0) } ?? NSNull(),
                            "checksApp": s.checks?.app ?? NSNull()]
                },
                "apps": checksByApp(sv).map { a -> [String: Any] in
                    ["app": a.app ?? NSNull(), "failed": a.items.filter { !$0.ok && !$0.skipped }.map { ["id": $0.id, "fix": fixText($0, app: a.app)] }]
                },
                "problem": m.setupProblem ?? NSNull(),
                "legacy": ps.map { Array($0.here.subtracting(sv.map { $0.id }).subtracting(sv.compactMap { $0.launcher })).sorted().map { Int($0) } } ?? []
            ]
            if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) { print(String(decoding: d, as: UTF8.self)) }
            exit(0)
        }
        // --goto <pid> <tab>: what 「带我去」 writes (test/ask.test.mjs: the session reads the same file).
        if let i = argv.firstIndex(of: "--goto") {
            guard i + 2 < argv.count, let pid = Int32(argv[i + 1]), let tab = Int(argv[i + 2]) else {
                print("{\"ok\":false,\"error\":\"usage: cbmenu --goto <pid> <tab>\"}"); exit(2)
            }
            guard let path = writeGotoRequest(pid: pid, tab: tab) else {
                print("{\"ok\":false,\"error\":\"This alert is no longer current\"}"); exit(2)
            }
            if let d = try? JSONSerialization.data(withJSONObject: ["ok": true, "file": path], options: [.sortedKeys]) { print(String(decoding: d, as: UTF8.self)) }
            exit(0)
        }
        if argv.contains("--read-activity") {
            let items = readActivity().map { a -> [String: Any] in
                ["t": a.t, "who": a.who, "tool": a.tool, "label": TOOL_LABEL[a.tool] ?? a.tool, "host": a.host ?? NSNull(), "ok": a.ok,
                 "why": a.ok ? NSNull() : failureText(a.code)]
            }
            if let d = try? JSONSerialization.data(withJSONObject: items, options: [.sortedKeys]) { print(String(decoding: d, as: UTF8.self)) }
            exit(0)
        }
        if argv.contains("--status") {
            var s = readJSON(STATE_FILE) ?? [:]
            let running = (s["pid"] as? NSNumber).map { alive($0.int32Value) } ?? false
            s["running"] = running
            if !running { s["holding"] = false }
            s["ok"] = true
            if let d = try? JSONSerialization.data(withJSONObject: s, options: [.sortedKeys]) { print(String(decoding: d, as: UTF8.self)) }
            exit(0)
        }
        let app = NSApplication.shared
        let openConversations = argv.contains("--gui") || Bundle.main.object(forInfoDictionaryKey: "MyChromeOpensConversations") as? Bool == true
        if let i = argv.firstIndex(of: "--snapshot-gui"), i + 1 < argv.count {
            ConversationSnapshot.write(argv[i + 1])
            exit(0)
        }
        if let i = argv.firstIndex(of: "--snapshot"), i + 1 < argv.count {
            Snapshot.write(argv[i + 1], argv: argv)
            exit(0)
        }
        // One panel at a time.
        if let old = (try? String(contentsOfFile: PID_FILE, encoding: .utf8)).flatMap({ Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }),
           old != getpid(), alive(old) {
            if openConversations { writeJSON(BASE + "/open-gui.json", ["at": nowMs()]) }
            exit(0)
        }
        try? FileManager.default.createDirectory(atPath: BASE, withIntermediateDirectories: true)
        try? String(getpid()).write(toFile: PID_FILE, atomically: true, encoding: .utf8)
        app.setActivationPolicy(.accessory)
        let m = Model(live: true)
        controller = Controller(model: m)
        app.delegate = controller
        if openConversations { controller?.showConversations() }
        if m.onboarding.shouldAutoPresent { controller?.showOnboarding() }
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            s.setEventHandler { m.prepareForExit(); exit(0) }
            s.resume()
            sources.append(s)
        }
        app.run()
    }
}

/// --snapshot: the panel as a picture, for review without opening anything on screen.
enum Snapshot {
    static func write(_ path: String, argv: [String]) {
        let m = Model(live: false)
        if let i = argv.firstIndex(of: "--mode"), i + 1 < argv.count { m.mode = argv[i + 1] }
        if let i = argv.firstIndex(of: "--page"), i + 1 < argv.count { m.page = argv[i + 1] }
        if argv.contains("--paused") { m.settings.paused = true }
        if argv.contains("--demo") {
            let now = nowMs()
            m.tasks = [
                AgentTask(id: 1, who: "Claude Code · demo", task: L("在 example.com 后台导出本月订单", "Export this month's orders from the example.com dashboard"), stepName: L("核对筛选条件", "Check the filters"),
                          current: 9, total: 14, color: 0, etaMs: 7 * 60_000, etaAt: now),
                AgentTask(id: 2, who: "Codex · demo", task: L("填写 example.org 活动报名表", "Fill in the example.org event sign-up form"), stepName: L("检查必填项", "Check required fields"),
                          current: 3, total: 3, color: 1, etaMs: 40_000, etaAt: now,
                          alert: argv.contains("--alert") ? L("需要你处理：www.google.com reCAPTCHA 人机验证（验证码）", "Needs you: www.google.com is showing a reCAPTCHA check") : nil,
                          alertTab: argv.contains("--alert") ? 2 : nil)
            ]
            if m.mode == "off" { m.mode = "task" }
            // Sessions, the setup check and the activity log: samples for the picture, not anyone's data.
            let ok = { (id: String, t: String) in Check(id: id, title: t, required: true, ok: true, skipped: false, detail: "", fix: nil, settings: nil) }
            var items = [ok("macos", "macOS"), ok("node", "Node.js"), ok("helpers", L("助手程序", "Helpers")), ok("chrome_installed", L("Google Chrome 已安装", "Google Chrome installed")),
                         ok("chrome_running", L("Google Chrome 在运行", "Google Chrome running")), ok("automation", L("自动化：控制 Chrome", "Automation: control Chrome")), ok("apple_events_js", L("Chrome：允许 Apple 事件中的 JavaScript", "Chrome: Allow JavaScript from Apple Events")),
                         ok("accessibility", L("辅助功能：真实鼠标键盘", "Accessibility: real mouse and keyboard")), ok("screen_recording", L("屏幕录制：截图识字", "Screen Recording: screenshots and text recognition"))]
            if argv.contains("--fail") {
                items[7] = Check(id: "accessibility", title: L("辅助功能：真实鼠标键盘", "Accessibility: real mouse and keyboard"), required: true, ok: false, skipped: false,
                                 detail: L("「kitty」没有打开。", "“kitty” is not turned on."), fix: L("打开「系统设置 → 隐私与安全性 → 辅助功能」，把「kitty」的开关打开。", "Open System Settings → Privacy & Security → Accessibility and turn on “kitty”."),
                                 settings: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            }
            if argv.contains("--no-chrome") {
                items[4] = Check(id: "chrome_running", title: L("Google Chrome 在运行", "Google Chrome running"), required: true, ok: false, skipped: false,
                                 detail: L("Google Chrome 没有在运行。", "Google Chrome is not running."), fix: L("打开 Google Chrome（或运行 mychrome-mcp doctor --open-chrome 让本检查替你打开）。", "Open Google Chrome (or run mychrome-mcp doctor --open-chrome to let this check open it)."), settings: nil)
            }
            m.servers = [
                ServerInfo(id: 1, who: "Claude Code · demo", color: 0, version: "demo", startedAt: now - 52 * 60_000, busy: "click",
                           lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:],
                           checks: SetupChecks(at: now - 2 * 60_000, app: "kitty", items: items), needsRestart: false),
                ServerInfo(id: 2, who: "Codex · demo", color: 1, version: "demo", startedAt: now - 27 * 3600_000, busy: nil,
                           lastActionAt: now - 4 * 60_000, root: nil, srcHash: nil, envLocked: [:], needsRestart: true),
                ServerInfo(id: 5, who: L("Claude · 主目录", "Claude · home folder"), color: 2, version: "demo", startedAt: now - 3 * 3600_000, busy: nil,
                           lastActionAt: now - 9 * 60_000, root: nil, srcHash: nil, envLocked: [:], needsRestart: true, launcher: 6)
            ]
            m.legacy = argv.contains("--legacy") ? [3, 4] : []
            if argv.contains("--restart") {
                m.restartJob = RestartJob(pid: 0, startedAt: now - 4 * 60_000, at: now - 20_000, finished: true, died: false, items: [
                    // restart.js's own notes (its outcomes, as data), so the picture goes through restartNoteText as the panel does
                    RestartItem(id: 1, name: L("demo · 更新商品页面", "demo · update product page"), state: "done", note: "已重启，用上新版了", how: "kitty"),   // i18n-exempt: restart.js output sample
                    RestartItem(id: 2, name: L("demo · 整理任务", "demo · tidy up tasks"), state: "done", note: "会话已经关了", how: "kitty"),   // i18n-exempt: restart.js output sample
                    RestartItem(id: 3, name: L("SSH 连接 remote-mac", "SSH connection remote-mac"), state: "skipped", note: "替你输入时有人在用电脑（或画面变了），没有按回车，也没删任何字：那个会话的输入框里留着 /mcp reconnect chrome-bridge，要重启就按回车，不要就删掉", how: "tmux"),   // i18n-exempt: restart.js output sample
                    RestartItem(id: 4, name: L("demo · 写周报", "demo · write weekly report"), state: "failed", note: "发了 /mcp reconnect chrome-bridge，但 MyChrome 没换（这个会话的 Claude Code 可能太旧）：如果那里开着 /mcp 菜单，按 Esc 关掉，再选 chrome-bridge → Reconnect，或者关掉重开", how: "kitty")])   // i18n-exempt: restart.js output sample
            }
            let hosts = ["mail.example.com", "shop.example.org", "example.com"]
            let tools = ["open_tab", "read_page", "click", "type_text", "scroll", "click", "read_page", "select_option", "click", "close_tab"]
            m.activity = (0..<14).map { i in
                ActivityItem(id: i, t: now - Double(i) * 7 * 60_000 - (i > 9 ? 20 * 3600_000 : 0), who: i % 3 == 2 ? "Codex · demo" : "Claude Code · demo",
                             color: i % 3 == 2 ? 1 : 0, tool: tools[i % tools.count], host: hosts[i % hosts.count],
                             ok: i != 4 && i != 11, code: i == 4 ? "site_blocked" : i == 11 ? "user_cancelled" : nil)
            } + [ActivityItem(id: 99, t: now - 2 * 60_000, who: "Claude Code · demo", color: 0, tool: "auto_close", host: "shop.example.org", ok: true, code: "idle")]
            m.activity.sort { $0.t > $1.t }
        }
        m.holding = m.mode != "off"
        m.until = nowMs() + 42 * 60_000
        m.now = nowMs()
        switch argv.firstIndex(of: "--habits").flatMap({ $0 + 1 < argv.count ? argv[$0 + 1] : nil }) {
        case "none": m.habits = nil
        case "recording": m.recordingUntil = m.now + 161_000
        case "recorded":
            // A sample for the picture (docs/panel/), not anyone's data.
            m.habits = HabitsInfo(recordedAt: ISO8601DateFormatter().date(from: "2026-10-06T06:30:00Z"), interKeyMs: 182, speedX: 1.2,
                                  use: true, missing: 0)
        default: m.habits = readHabits()
        }
        let dark = argv.contains("--dark")
        let view = Panel(model: m, close: {}, fit: argv.contains("--fit"))
            .background(dark ? hex(0x2A2A2D) : hex(0xEFEFF2))
            .environment(\.colorScheme, dark ? .dark : .light)
        let host = NSHostingView(rootView: view)
        host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { exit(1) }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
        try? png.write(to: URL(fileURLWithPath: path))
        let languageLock = uiLanguageLock()
        var hb: [String: Any] = ["state": m.habitsState]
        if let h = m.habits {
            hb["use"] = h.use
            hb["interKeyMs"] = h.interKeyMs.map { Int($0.rounded()) } ?? NSNull()
            hb["speedX"] = h.speedX.map { ($0 * 10).rounded() / 10 } ?? NSNull()
        }
        let o: [String: Any] = ["ok": true, "path": path, "w": Int(host.bounds.width), "h": Int(host.bounds.height), "habits": hb,
                                "uiLanguage": ["selected": languageLock?.key ?? m.settings.uiLanguage, "fixedBy": languageLock?.variable ?? NSNull(), "english": uiEnglish()]]
        if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) { print(String(decoding: d, as: UTF8.self)) }
    }
}
