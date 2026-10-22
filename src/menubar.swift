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
let DURATIONS: [Duration] = [
    Duration(key: "15", label: "15 分钟", minutes: 15), Duration(key: "30", label: "30 分钟", minutes: 30),
    Duration(key: "60", label: "1 小时", minutes: 60), Duration(key: "120", label: "2 小时", minutes: 120),
    Duration(key: "task", label: "直到任务结束", minutes: nil), Duration(key: "forever", label: "一直保持", minutes: nil)
]

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
        out.append((num("since") ?? 0, AgentTask(id: pid, who: t["who"] as? String ?? "AI 助手", task: t["task"] as? String ?? "",
            stepName: t["stepName"] as? String ?? "", current: num("current").map { Int($0) }, total: num("total").map { Int($0) },
            color: Int(num("color") ?? 0), etaMs: num("etaMs"), etaAt: num("etaAt"), alert: t["alert"] as? String,
            alertTab: num("alertTab").map { Int($0) }, alertToken: t["alertToken"] as? String,
            sessionGeneration: t["sessionGeneration"] as? String)))
    }
    return out.sorted { $0.0 < $1.0 }.map { $0.1 }
}

func minutesText(_ ms: Double) -> String {
    let m = Int((ms / 60_000).rounded(.up))
    if m < 1 { return "不到 1 分钟" }
    if m < 60 { return "\(m) 分钟" }
    return m % 60 == 0 ? "\(m / 60) 小时" : "\(m / 60) 小时 \(m % 60) 分钟"
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
    guard let d = d else { return "日期不明" }
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.dateFormat = "M月d日 HH:mm"
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
        RestartItem(id: Int(jsonNum(i["client"]) ?? 0), name: i["name"] as? String ?? "", state: i["state"] as? String ?? "", note: i["note"] as? String ?? "")
    }
    let finished = jsonBool(j["finished"]) ?? false
    let died = !finished && !alive(pid)
    return RestartJob(pid: pid, startedAt: jsonNum(j["startedAt"]) ?? 0, at: jsonNum(j["at"]) ?? 0, finished: finished, died: died, items: items.map { i in
        died && (i.state == "waiting" || i.state == "sent")
            ? RestartItem(id: i.id, name: i.name, state: "failed", note: "重启程序中途退出了，这个没做完：再点一次「全部重启」") : i
    }, error: j["error"] as? String)
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

/// src/settings.js sourceFingerprint, the same bytes: sha256 over "<name>\0<bytes>\0" for each src/*.js in name order.
func sourceFingerprint(_ root: String) -> String? {
    let dir = root + "/src"
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return nil }
    var h = SHA256()
    for n in names.filter({ $0.hasSuffix(".js") }).sorted(by: { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }) {
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
                         afterCommit: () -> Bool = { true }) -> Bool {
    do { try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true) }
    catch { return false }
    return withSettingsWriteLock(file) {
        if !current() { return true }
        var values: [String: Any] = [:]
        if (try? FileManager.default.attributesOfItem(atPath: file)) != nil {
            guard let data = FileManager.default.contents(atPath: file),
                  let current = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
            values = current
        }
        for (key, value) in patch { values[key] = value }
        values["version"] = 1
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { return false }
        do { try data.write(to: URL(fileURLWithPath: file), options: .atomic); return afterCommit() }
        catch { return false }
    }
}

/// The settings as src/settings.js reads them: a missing, mistyped or out-of-range value is the default.
struct Settings: Equatable {
    var paused = false, agentDisplay = "away", idleSeconds = 1.5, tabIdleMinutes = 10.0, notify = true, activityLog = true
    var inputMode = "auto", inputSpeed = 1.0
    static let displays = ["away", "secondary", "main", "off"]
    static let inputModes = ["auto", "keys", "paste"]
    static let inputSpeeds: [Double] = [0.5, 0.75, 1, 1.5, 2, 3]
    static func read() -> Settings {
        var s = Settings()
        s.paused = !settingsPauseTokens(SETTINGS_FILE).isEmpty
        guard let j = readJSON(SETTINGS_FILE) else { return s }
        if !s.paused, let v = jsonBool(j["paused"]) { s.paused = v }
        if let v = j["agentDisplay"] as? String, displays.contains(v) { s.agentDisplay = v }
        if let v = jsonNum(j["idleSeconds"]), (0.5...10).contains(v) { s.idleSeconds = v }
        if let v = j["inputMode"] as? String, inputModes.contains(v) { s.inputMode = v }
        if let v = jsonNum(j["inputSpeed"]), inputSpeeds.contains(v) { s.inputSpeed = v }
        if let v = jsonNum(j["tabIdleMinutes"]), (0...1440).contains(v) { s.tabIdleMinutes = v }
        if let v = jsonBool(j["notify"]) { s.notify = v }
        if let v = jsonBool(j["activityLog"]) { s.activityLog = v }
        return s
    }
    static func valid(_ key: String, _ value: Any) -> Bool {
        switch key {
        case "paused", "notify", "activityLog": return jsonBool(value) != nil
        case "agentDisplay": return (value as? String).map { displays.contains($0) } ?? false
        case "idleSeconds": return jsonNum(value).map { (0.5...10).contains($0) } ?? false
        case "tabIdleMinutes": return jsonNum(value).map { (0...1440).contains($0) } ?? false
        case "inputMode": return (value as? String).map { inputModes.contains($0) } ?? false
        case "inputSpeed": return jsonNum(value).map { inputSpeeds.contains($0) } ?? false
        default: return false
        }
    }
    /// Prepare on the caller thread: pause is immediately visible to workers;
    /// resume captures only the requests that already exist. Saving may wait.
    static func prepareWrite(_ key: String, _ value: Any) -> (() -> Bool)? {
        guard valid(key, value) else { return nil }
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
}
/// A session's setup check (src/doctor.js runChecks, run in that session's own app).
struct SetupChecks {
    let at: Double, app: String?, items: [Check]
}
func parseSetupChecks(_ v: Any?) -> SetupChecks? {
    guard let j = v as? [String: Any], let at = jsonNum(j["at"]), let cs = j["items"] as? [[String: Any]] else { return nil }
    return SetupChecks(at: at, app: j["app"] as? String, items: cs.map { c in
        Check(id: c["id"] as? String ?? "", title: zhTitle(c["title"] as? String ?? ""), required: jsonBool(c["required"]) ?? true,
              ok: jsonBool(c["ok"]) ?? false, skipped: jsonBool(c["skipped"]) ?? false,
              detail: zhPart(c["detail"] as? String) ?? "", fix: zhPart(c["fix"] as? String), settings: c["settings"] as? String)
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
        out.append(ServerInfo(id: pid, who: j["who"] as? String ?? "AI 助手", color: Int(jsonNum(j["color"]) ?? 0),
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
            model: j["model"] as? String, effort: j["effort"] as? String, cwd: j["cwd"] as? String))
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
/// doctor writes "中文\nEnglish" and titles "中文 / English": the panel shows the Chinese.
func zhPart(_ s: String?) -> String? {
    guard let s = s, !s.isEmpty else { return nil }
    return String(s.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
}
func zhTitle(_ s: String) -> String { s.components(separatedBy: " / ").first ?? s }
/// The checks that are permissions the owner turns on (the rest: Chrome open, installed, the setup itself).
let PERMISSION_CHECKS: Set<String> = ["automation", "apple_events_js", "accessibility", "screen_recording"]
/// What to do, for someone who does not use a terminal: doctor's own text names commands for two of them.
func fixText(_ c: Check, app: String?) -> String {
    switch c.id {
    case "chrome_running": return "打开 Google Chrome，AI 才能用它。"
    case "automation" where c.settings == nil:
        return "AI 第一次用浏览器时，macOS 会问「“\(app ?? "这个程序")”想要控制“Google Chrome”」，点「允许」就行。"
    default: return c.fix ?? c.detail
    }
}

/// A failed check's title says what is wrong ("在运行" read as a heading looks like good news).
func failTitle(_ c: Check) -> String {
    switch c.id {
    case "chrome_running": return "Google Chrome 没有打开"
    case "chrome_installed": return "没有安装 Google Chrome"
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
        out.append(ActivityItem(id: i, t: t, who: j["who"] as? String ?? "AI 助手", color: Int(jsonNum(j["color"]) ?? 0),
            tool: j["tool"] as? String ?? "", host: j["host"] as? String, ok: jsonBool(j["ok"]) ?? false, code: j["code"] as? String))
    }
    return out.reversed()
}
let TOOL_LABEL = ["open_tab": "打开网页", "close_tab": "关闭标签", "read_page": "读取页面", "click": "点击", "type_text": "输入文字",
                  "scroll": "滚动页面", "select_option": "选择选项", "answer_dialog": "回答网页弹窗", "wait_for_user": "等你处理",
                  "click_at": "按位置点击", "press_key": "按键", "hover": "鼠标悬停", "screenshot": "截图", "auto_close": "自动关闭标签"]
/// Why MyChrome closed an agent tab by itself (src/tabs.js decideSweep reasons).
func autoCloseText(_ code: String?) -> String {
    switch code ?? "" {
    case "idle": return "很久没用"
    case "session_end": return "开它的 AI 会话结束了"
    case "owner_gone": return "开它的 AI 会话已经不在了"
    default: return "AI 的标签"
    }
}
/// Why a call did not work, in plain words (the codes of src/index.js BridgeError).
func failureText(_ code: String?) -> String {
    switch code ?? "" {
    case "user_cancelled": return "你按了两次 Esc，取消了"
    case "cancelled": return "AI 那边中途取消了这次操作"
    case "wait_timeout": return "等到时间了，你还没处理"
    case "tab_gone": return "标签已经关掉了"
    case "field_gone": return "要你填的框不见了"
    case "paused_by_user": return "当时 AI 操作已暂停"
    case "site_blocked": return "网站要你处理（验证码等）"
    case "input_held", "user_busy": return "你一直在操作，没等到空闲"
    case "input_stuck": return "有按键卡住了"
    case "user_interrupted", "mouse_interrupted": return "你中途动了键盘鼠标"
    case "secure_input": return "当时在输入密码，系统不允许操作"
    case "screen_locked", "displays_asleep": return "屏幕锁着或在睡眠"
    case "taken_over", "not_your_tab", "not_agent_tab": return "这个标签不归它用"
    case "lock_timeout": return "排队太久，没轮到"
    case "bad_url", "bad_args", "why_required": return "AI 给的参数不对"
    case "unknown_tool": return "AI 调了不存在的功能"
    case "not_on_top", "activate_failed", "window_covered", "target_covered", "not_key_window": return "没能把窗口切到前面"
    default: return "没做成"
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
    @Published var activity: [ActivityItem] = []
    @Published var confirmClear = false
    @Published var clearNote: String?
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
        guard let path = habitsPath() else { recordError = "现在设置为不使用习惯（CHROME_BRIDGE_HABITS=off），所以不录制。"; return }
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
        do { try p.run() } catch { recordError = "录制没能开始：找不到 \(exe.path)"; return }
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
            let msg = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["message"] as? String
            recordError = msg ?? "录制没有完成（退出码 \(status)）。"
        }
        cancelling = false
        tick()
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
        if live, !settings.paused, checkRequestedAt == nil, sv.contains(where: { !$0.managedSession && $0.checks == nil && now - $0.startedAt > 20_000 }) { requestChecks(force: true) }
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
            settingsError = "设置未能保存，原设置仍保留。请稍后再试。"
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
                self.settingsError = saved ? nil : "设置未能保存，原设置仍保留。请稍后再试。"
                if saved && key == "paused" {
                    self.checkRequestedAt = nil
                    if !self.settings.paused {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.requestChecks(force: true) }
                    }
                }
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
            restartError = "找不到 node，没法开始重启。"
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [ROOT_DIR + "/src/index.js", "restart-all"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { restartError = "没能开始重启：\(node) 启动不了。"; return }
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
    }

    var appChecks: [SetupChecks] { checksByApp(servers) }
    /// The header's word for what is wrong: permissions first, then Chrome itself, then the setup.
    var setupProblem: String? {
        let failed = appChecks.flatMap { $0.items }.filter { !$0.ok && !$0.skipped && $0.required }
        if failed.contains(where: { PERMISSION_CHECKS.contains($0.id) }) { return "有权限没打开" }
        if failed.contains(where: { $0.id == "chrome_installed" }) { return "没有安装 Chrome" }
        if failed.contains(where: { $0.id == "chrome_running" }) { return "Chrome 没有打开" }
        return failed.isEmpty ? nil : "安装有问题"
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
            gotoNotes[t.id] = "这个提醒已更新，请选择当前任务再试。"
            return
        }
        gotoPending[t.id] = (id, generation, nowMs())
        gotoNotes[t.id] = "正在定位页面…"
    }
    func openChrome() {
        guard live, let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else { return }
        NSWorkspace.shared.openApplication(at: u, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.requestChecks(force: true) }
    }

    /// Two clicks, like deleting the habits: the first asks, the second removes both log files.
    func clearActivity() {
        guard live else { return }
        if !confirmClear {
            confirmClear = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.confirmClear = false }
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
            clearNote = "记录正在整理，过几秒再点一次「再点一次，确认清空」。"
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.clearNote = nil; self?.confirmClear = false }
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
                    result[i].alert = "有 \(s.conversationPending) 个问题等你回复"
                    result[i].alertToken = (s.conversationBinding ?? "") + (s.conversationRequestKey ?? "")
                }
            } else {
                result.append(AgentTask(id: s.id, who: s.who, task: s.conversationTitle ?? s.who, stepName: "", current: nil, total: nil, color: s.color, etaMs: nil, etaAt: nil,
                      alert: "有 \(s.conversationPending) 个问题等你回复", alertToken: (s.conversationBinding ?? "") + (s.conversationRequestKey ?? "")))
            }
        }
        return result
    }
    var needsYou: Bool { attentionTasks.contains { $0.alert != nil } }

    /// The plain-language line under the switch.
    var keepLine: String {
        switch mode {
        case "off": return "已关闭，按系统设置自动息屏"
        case "forever": return "一直保持，直到你在这里关闭"
        case "task": return tasks.isEmpty ? "AI 开始并结束任务后，自动关闭屏幕常亮" : "任务结束后，自动关闭屏幕常亮"
        default: return "剩余 " + minutesText(max(0, (until ?? now) - now)) + "，之后恢复系统息屏设置"
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
    var label: (on: String, off: String) = ("关掉屏幕常亮", "打开屏幕常亮")
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
                    if let go = onGoto { PlainButton(text: "带我去那个页面", action: go) }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.task.isEmpty ? "正在使用你的 Chrome" : t.task)
                        .font(.system(size: 14, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Text(t.who).font(.system(size: 11)).foregroundStyle(SUBTLE).lineLimit(1)
                }
                if let cur = t.current, let n = t.total, n > 0 {
                    Bar(fraction: Double(max(0, cur - 1)) / Double(n), color: c)
                    Text("正在进行第 \(cur) 步，共 \(n) 步").font(.system(size: 12, weight: .medium))
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if !t.stepName.isEmpty { Text(t.stepName).foregroundStyle(SUBTLE).lineLimit(1) }
                        Spacer(minLength: 6)
                        if let left = t.leftMs(at: now) { Text("预计还需 " + minutesText(left)).foregroundStyle(SUBTLE) }
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
        Label("「\(who)」的 MCP 配置里固定为「\(value)」（\(env)），这里改不了；删掉配置里这一项后才能在这里改。", systemImage: "lock.fill")
            .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
    }
}

let DISPLAY_OPTIONS: [(key: String, label: String)] = [("away", "你没在用的屏幕"), ("secondary", "固定在副屏"), ("main", "固定在主屏"), ("off", "开在你的窗口里")]
let DISPLAY_SUB = [
    "away": "有两块屏幕时，AI 的窗口放在你鼠标不在的那块，不挡你；只有一块屏幕时，开在单独的窗口里。",
    "secondary": "AI 的窗口总在副屏（没有副屏时在主屏）。",
    "main": "AI 的窗口总在主屏。",
    "off": "不单独开窗口：AI 的标签开在你当前的 Chrome 窗口里，在后台打开，不切换你正在看的标签。"
]
let IDLE_OPTIONS: [(key: String, label: String)] = [("1.5", "1.5 秒"), ("3", "3 秒"), ("5", "5 秒")]
let TAB_OPTIONS: [(key: String, label: String)] = [("10", "10 分钟"), ("30", "30 分钟"), ("60", "1 小时"), ("0", "不自动关")]
func numKey(_ x: Double) -> String { x == x.rounded() ? String(Int(x)) : oneDecimal(x) }
func lockedText(_ key: String, _ v: Any) -> String {
    switch key {
    case "agentDisplay": return DISPLAY_OPTIONS.first { $0.key == v as? String }?.label ?? "\(v)"
    case "idleSeconds": return "\(jsonNum(v).map(numKey) ?? "\(v)") 秒"
    case "tabIdleMinutes": return jsonNum(v).map { $0 > 0 ? "\(numKey($0)) 分钟" : "不自动关" } ?? "\(v)"
    case "notify": return jsonBool(v) == false ? "关" : "开"
    default: return "\(v)"
    }
}
func timeText(_ ms: Double, day: Bool = false) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.dateFormat = day ? "M月d日" : "HH:mm"
    return f.string(from: Date(timeIntervalSince1970: ms / 1000))
}
/// "18:20" today, "昨天 18:20", "10月12日 18:20" (sessions live for days: Fable r13 B9).
func whenText(_ ms: Double, now: Double) -> String {
    let d = dayTitle(ms, now: now)
    return d == "今天" ? timeText(ms) : d + " " + timeText(ms)
}
func dayTitle(_ ms: Double, now: Double) -> String {
    let cal = Calendar.current, d = Date(timeIntervalSince1970: ms / 1000), n = Date(timeIntervalSince1970: now / 1000)
    if cal.isDate(d, inSameDayAs: n) { return "今天" }
    if let y = cal.date(byAdding: .day, value: -1, to: n), cal.isDate(d, inSameDayAs: y) { return "昨天" }
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
        if model.needsYou { return ("需要你处理一下", ALERT) }
        if model.settings.paused { return ("AI 操作已暂停", hex(0xEA6A0C)) }
        if !model.tasks.isEmpty || model.servers.contains(where: { $0.busy != nil }) { return ("AI 正在操作", hex(0x3B7BFF)) }
        if let p = model.setupProblem { return (p, ALERT) }
        if !model.settings.paused, model.servers.contains(where: { !$0.managedSession }), model.appChecks.isEmpty { return ("正在检查权限", SUBTLE) }
        if model.servers.isEmpty { return ("没有 AI 连接", SUBTLE) }
        return ("一切就绪", hex(0x16A34A))
    }

    var header: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 11, style: .continuous).fill(AURORA).frame(width: 40, height: 40)
                .overlay(Image(systemName: "cursorarrow.rays").font(.system(size: 18, weight: .semibold)).foregroundStyle(.white))
                .shadow(color: hex(0xA47BFF).opacity(0.35), radius: 6, y: 3)
            VStack(alignment: .leading, spacing: 2) {
                Text("AI 浏览器助手").font(.system(size: 16, weight: .bold))
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
                    .help("屏幕常亮已开启")
            }
        }
    }

    var tabs: some View {
        HStack(spacing: 4) {
            ForEach([("status", "状态"), ("settings", "设置"), ("records", "记录")], id: \.0) { key, label in
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
            Label("打开会话中心", systemImage: "bubble.left.and.bubble.right")
                .font(.system(size: 14, weight: .semibold)).frame(maxWidth: .infinity).padding(.vertical, 8)
        }.buttonStyle(.borderedProminent)
        Button { model.openOnboarding?(); close() } label: {
            Label(onboardingText("入门引导", "Getting started"), systemImage: "questionmark.circle")
                .frame(maxWidth: .infinity)
        }.buttonStyle(.bordered)
        if model.settings.paused {
            Card {
                SettingRow(icon: "pause.circle.fill", title: "AI 操作已暂停", sub: "AI 现在不能操作你的 Chrome，它会收到「已暂停」并等你恢复。", tint: hex(0xEA6A0C)) {
                    PlainButton(text: "恢复") { model.set("paused", false) }
                }
            }
        }
        if !model.tasks.isEmpty { section("AI 任务") { tasksBody } }
        section("AI 会话") { sessionsBody }
        section("准备情况") { checksBody }
        section("屏幕常亮") { keepBody }
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
                    Text("目前没有 AI 连接").font(.system(size: 14, weight: .semibold))
                    Text("AI 助手第一次用你的浏览器时，会出现在这里。").font(.system(size: 11)).foregroundStyle(SUBTLE)
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
                    Text(sessionLine(s)).font(.system(size: 11)).foregroundStyle(SUBTLE).lineLimit(1)
                }
                Spacer(minLength: 6)
                if !s.managedSession && s.needsRestart == true && s.launcher != nil {
                    Text("会自动更新").font(.system(size: 11, weight: .semibold)).foregroundStyle(SUBTLE)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Capsule().fill(SUBTLE.opacity(0.12)))
                        .help("MyChrome 更新过。这个会话空下来（没有操作进行中）后会自己换成新版，不用重启，它开的标签也保留。")
                } else if !s.managedSession && s.needsRestart == true {
                    Text("需要重启").font(.system(size: 11, weight: .semibold)).foregroundStyle(ALERT)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Capsule().fill(ALERT.opacity(0.1)))
                        .help("这个会话开始时 MyChrome 还不会自动更新。点下面的「全部重启」，或者在这个会话里输入 /mcp reconnect chrome-bridge（不用关会话；它开的标签会被关掉）。之后的更新会自动换上。")
                } else if s.busy != nil {
                    Text("正在操作").font(.system(size: 11, weight: .semibold)).foregroundStyle(hex(0x3B7BFF))
                }
            }
        }
        if !model.legacy.isEmpty {
            if !model.servers.isEmpty { Divider() }
            Label("另有 \(model.legacy.count) 个 AI 会话还在用旧版本 MyChrome：点下面的「全部重启」，才会用上新版本和这里的设置。",
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
                    Text("正在重启，每个会话空下来时换一个…").font(.system(size: 12, weight: .medium))
                }
            } else if model.staleCount > 0 {
                PlainButton(text: "全部重启（\(model.staleCount) 个会话）") { model.restartAll() }
                Text("每个会话空下来、输入框也是空的时候，替它输入 /mcp reconnect chrome-bridge；后台会话用 claude respawn。对话都还在，它们开的标签会被关掉。")
                    .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            }
            if let e = model.restartError {
                Text(e).font(.system(size: 11)).foregroundStyle(ALERT).fixedSize(horizontal: false, vertical: true)
            }
            if model.restartShown, let job = model.restartJob {
                if let e = job.error {
                    Text(e).font(.system(size: 11)).foregroundStyle(ALERT).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(job.items) { i in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: restartIcon(i.state)).font(.system(size: 12)).foregroundStyle(restartColor(i.state)).frame(width: 16)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(i.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                            Text(i.note).font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
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
        var parts = ["连接于 " + (s.startedAt > 0 ? whenText(s.startedAt, now: model.now) : "?")]
        if let b = s.busy { parts.append("正在" + (TOOL_LABEL[b] ?? "操作")) }
        else if let a = s.lastActionAt { parts.append("上次操作 " + whenText(a, now: model.now)) }
        else { parts.append("还没操作过") }
        return parts.joined(separator: " · ")
    }

    /// One block per app the sessions run in: the permissions are that app's (Codex r13 A6).
    @ViewBuilder var checksBody: some View {
        let apps = model.appChecks
        if model.settings.paused {
            Text("AI 操作已暂停，暂停期间不检查；恢复后会自动再查一次。").font(.system(size: 12)).foregroundStyle(SUBTLE)
                .fixedSize(horizontal: false, vertical: true)
        } else if apps.isEmpty {
            Text(model.servers.contains(where: { !$0.managedSession }) ? "正在检查权限…" : "浏览器连接启用后，会在这里检查权限。")
                .font(.system(size: 12)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
        }
        ForEach(Array(apps.enumerated()), id: \.offset) { i, a in
            if i > 0 { Divider() }
            let failed = a.items.filter { !$0.ok && !$0.skipped }
            let app = a.app ?? "运行 AI 的程序"
            if failed.isEmpty {
                SettingRow(icon: "checkmark.seal.fill", title: apps.count > 1 ? "「\(app)」：权限都已打开" : "权限都已打开",
                           sub: "\(a.items.count) 项检查都通过（检查的是「\(app)」，AI 助手在这个程序里运行）", tint: hex(0x16A34A)) { EmptyView() }
            } else {
                if apps.count > 1 { Text("「\(app)」里的 AI 会话").font(.system(size: 11, weight: .semibold)).foregroundStyle(SUBTLE) }
                ForEach(failed) { c in
                    VStack(alignment: .leading, spacing: 6) {
                        Label(failTitle(c), systemImage: c.required ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(c.required ? ALERT : hex(0xEA6A0C))
                        Text(fixText(c, app: a.app)).font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                        if c.id == "chrome_running" { PlainButton(text: "打开 Chrome") { model.openChrome() } }
                        else if let u = c.settings { PlainButton(text: "打开系统设置") { model.openSettingsPane(u) } }
                    }
                }
                if failed.contains(where: { PERMISSION_CHECKS.contains($0.id) }) {
                    Text("要给「\(app)」打开：AI 助手在哪个程序里运行，就给哪个程序。")
                        .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        HStack {
            if let at = apps.map({ $0.at }).max() { Text("检查于 " + whenText(at, now: model.now)).font(.system(size: 11)).foregroundStyle(SUBTLE) }
            Spacer()
            if model.servers.contains(where: { !$0.managedSession }) && !model.settings.paused {
                PlainButton(text: model.checkRequestedAt != nil ? "正在检查…" : "重新检查") { model.requestChecks(force: true) }
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
                Text("保持屏幕常亮").font(.system(size: 14, weight: .semibold))
                Text(model.keepLine).font(.system(size: 11))
                    .foregroundStyle(SUBTLE)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            PillSwitch(isOn: model.on) { model.choose(model.on ? "off" : (model.tasks.isEmpty ? "60" : "task")) }
        }
        if model.on {
            VStack(alignment: .leading, spacing: 6) {
                Text("保持多久").font(.system(size: 11, weight: .medium)).foregroundStyle(SUBTLE)
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
        section("暂停") {
            SettingRow(icon: s.paused ? "pause.circle.fill" : "play.circle", title: "暂停 AI 操作",
                       sub: s.paused ? "已暂停：AI 不能操作你的 Chrome，只能看到它自己开的标签；它会收到「已暂停」并等你恢复。" : "需要安心用电脑时打开：AI 不会操作你的浏览器，也不会自动关标签。",
                       tint: s.paused ? hex(0xEA6A0C) : SUBTLE) {
                PillSwitch(isOn: s.paused, fill: SUN, label: ("恢复 AI 操作", "暂停 AI 操作")) { model.set("paused", !s.paused) }
            }
            if s.paused && !model.legacy.isEmpty {
                Text("有 \(model.legacy.count) 个旧版本的 AI 会话不认这个开关，重启这些会话后才会一起暂停。")
                    .font(.system(size: 11)).foregroundStyle(ALERT).fixedSize(horizontal: false, vertical: true)
            }
        }
        section("AI 的窗口放在哪") {
            let lock = model.lockedValue("agentDisplay")
            let cur = (lock?.value as? String) ?? s.agentDisplay
            Choices(options: DISPLAY_OPTIONS, selected: cur, columns: 2, disabled: lock != nil) { model.set("agentDisplay", $0) }
            Text(DISPLAY_SUB[cur] ?? "").font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            if let l = lock { LockedNote(env: SETTING_ENV["agentDisplay"]!, value: lockedText("agentDisplay", l.value), who: l.who) }
        }
        section("接管键盘鼠标前，等你停手") {
            let lock = model.lockedValue("idleSeconds")
            Choices(options: IDLE_OPTIONS, selected: numKey(lock.flatMap { jsonNum($0.value) } ?? s.idleSeconds), disabled: lock != nil) { model.set("idleSeconds", Double($0) ?? 1.5) }
            Text("AI 要用键盘鼠标时，先等你停手这么久再接管；你在打字时它会等，不会抢着操作。只动鼠标不算在操作。")
                .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            if let l = lock { LockedNote(env: SETTING_ENV["idleSeconds"]!, value: lockedText("idleSeconds", l.value), who: l.who) }
        }
        section("AI 开的标签，多久没用就关掉") {
            let lock = model.lockedValue("tabIdleMinutes")
            Choices(options: TAB_OPTIONS, selected: numKey(lock.flatMap { jsonNum($0.value) } ?? s.tabIdleMinutes), columns: 4, disabled: lock != nil) {
                model.set("tabIdleMinutes", Double($0) ?? 10)
            }
            Text("只关 AI 自己开的标签；你自己开的、或你接手用过的标签从来不关。AI 会话结束时，它开的标签也会关掉。")
                .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
            if let l = lock { LockedNote(env: SETTING_ENV["tabIdleMinutes"]!, value: lockedText("tabIdleMinutes", l.value), who: l.who) }
        }
        section("通知与记录") {
            let lock = model.lockedValue("notify")
            let notifyOn = lock.flatMap { jsonBool($0.value) } ?? s.notify
            SettingRow(icon: notifyOn ? "bell.fill" : "bell.slash", title: "系统通知",
                       sub: "网站要你处理（如验证码）、AI 好像卡住了、或 AI 操作时拦下了你的按键，会弹通知告诉你。", tint: notifyOn ? hex(0x3B7BFF) : SUBTLE) {
                PillSwitch(isOn: notifyOn, fill: AURORA, label: ("关闭系统通知", "打开系统通知")) { model.set("notify", !notifyOn) }
                    .disabled(lock != nil).opacity(lock != nil ? 0.5 : 1)
            }
            if let l = lock { LockedNote(env: SETTING_ENV["notify"]!, value: lockedText("notify", l.value), who: l.who) }
            Divider()
            SettingRow(icon: s.activityLog ? "list.bullet.rectangle.fill" : "list.bullet.rectangle", title: "记录 AI 的操作",
                       sub: "在「记录」页查看。只记时间、网站名和操作类型，不记输入的内容；只存在这台电脑上。",
                       tint: s.activityLog ? hex(0x3B7BFF) : SUBTLE) {
                PillSwitch(isOn: s.activityLog, fill: AURORA, label: ("不再记录", "开始记录")) { model.set("activityLog", !s.activityLog) }
            }
        }
        section("我的操作习惯") { habitsBody }
        if !model.legacy.isEmpty {
            Text("这些设置改了马上生效，但只对新版本的 AI 会话有效；另有 \(model.legacy.count) 个旧会话要重启后才会用上。")
                .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: 记录

    @ViewBuilder var recordsPage: some View {
        let items = model.activity
        let today = items.filter { Calendar.current.isDate(Date(timeIntervalSince1970: $0.t / 1000), inSameDayAs: Date(timeIntervalSince1970: model.now / 1000)) }
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: today.isEmpty ? "最近的操作" : "今天 \(today.count) 次操作" + (today.contains { !$0.ok } ? "，\(today.filter { !$0.ok }.count) 次没做成" : ""))
            Card {
                if items.isEmpty {
                    SettingRow(icon: "list.bullet.rectangle", title: "还没有记录",
                               sub: model.settings.activityLog ? "AI 用你的浏览器做的每一步都会记在这里。" : "记录已关闭，可以在「设置」里打开。") { EmptyView() }
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
            Text("只记网站名和操作类型，不记输入的内容。").font(.system(size: 11)).foregroundStyle(SUBTLE)
            Spacer()
            if !items.isEmpty {
                PlainButton(text: model.confirmClear ? "再点一次，确认清空" : "清空记录", destructive: true) { model.clearActivity() }
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
                    Text("正在录制 · 还剩 " + clockText(left)).font(.system(size: 14, weight: .semibold)).monospacedDigit()
                    Text("正常用电脑就行：只记节奏，不记按了什么、不看屏幕")
                        .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                }
            }
            Bar(fraction: 1 - left / (RECORD_SECONDS * 1000), color: ALERT)
            HStack {
                Spacer()
                PlainButton(text: "取消录制（不保存）") { model.cancelRecording() }
            }
        } else if let h = model.habits {
            HStack(spacing: 12) {
                Image(systemName: h.use ? "hand.point.up.left.fill" : "hand.point.up.left")
                    .font(.system(size: 18)).foregroundStyle(h.use ? hex(0x8B5CF6) : SUBTLE).frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("按我的习惯操作").font(.system(size: 14, weight: .semibold))
                    Text(h.use ? "AI 打字、移动鼠标的快慢照你的来" : "已关闭：AI 按默认的快慢操作")
                        .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                PillSwitch(isOn: h.use, fill: AURORA, label: ("不按我的习惯操作", "按我的习惯操作")) { model.setUse(!h.use) }
            }
            VStack(alignment: .leading, spacing: 5) {
                Fact(icon: "calendar", text: "录制于 " + dateText(h.recordedAt))
                Fact(icon: "keyboard", text: h.interKeyMs.map { "打字间隔：一般 \(Int($0.rounded())) 毫秒（中位数）" } ?? "打字：录到的太少，用默认节奏")
                Fact(icon: "computermouse", text: h.speedX.map { "鼠标速度：默认的 \(oneDecimal($0)) 倍" } ?? "鼠标：录到的太少，用默认速度")
                if h.missing > 0 { Fact(icon: "info.circle", text: "录到的太少的项目，仍用默认值") }
            }
            HStack {
                PlainButton(text: "重新录制 3 分钟") { model.startRecording() }
                Spacer()
                PlainButton(text: model.confirmDelete ? "再点一次，确认删除" : "删除习惯数据", destructive: true) { model.deleteHabits() }
            }
        } else {
            HStack(spacing: 12) {
                Image(systemName: "hand.point.up.left").font(.system(size: 18)).foregroundStyle(SUBTLE).frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("还没有录制").font(.system(size: 14, weight: .semibold))
                    Text("录 3 分钟你平时用电脑的样子，之后 AI 打字、移动鼠标就照你的快慢来。只记节奏，不记按了什么、不看屏幕。")
                        .font(.system(size: 11)).foregroundStyle(SUBTLE).fixedSize(horizontal: false, vertical: true)
                }
            }
            Button { model.startRecording() } label: {
                Label("录制 3 分钟", systemImage: "record.circle")
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
            Text("现在设置为不使用习惯（CHROME_BRIDGE_HABITS=off）。").font(.system(size: 11)).foregroundStyle(SUBTLE)
        }
    }

    var footer: some View {
        HStack(spacing: 6) {
            Text("停止操作：连按两次").font(.system(size: 12, weight: .medium))
            Keycap(text: "Esc")
            Spacer()
            Button("退出应用") { close(); model.quit() }
                .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(SUBTLE)
                .help("关掉菜单栏里的这个小图标，屏幕常亮也会关闭；不影响正在进行的 AI 任务")
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
                    Text("没做成：" + failureText(a.code)).font(.system(size: 10.5, weight: .medium)).foregroundStyle(ALERT)
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
        item.button?.toolTip = "AI 浏览器助手（MyChrome）"
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
        let img = NSImage(systemSymbolName: name, accessibilityDescription: "AI 浏览器助手")?
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
                                    "inputMode": st.inputMode, "inputSpeed": st.inputSpeed]
            if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) { print(String(decoding: d, as: UTF8.self)) }
            exit(0)
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
                AgentTask(id: 1, who: "Claude Code · demo", task: "在 example.com 后台导出本月订单", stepName: "核对筛选条件",
                          current: 9, total: 14, color: 0, etaMs: 7 * 60_000, etaAt: now),
                AgentTask(id: 2, who: "Codex · demo", task: "填写 example.org 活动报名表", stepName: "检查必填项",
                          current: 3, total: 3, color: 1, etaMs: 40_000, etaAt: now,
                          alert: argv.contains("--alert") ? "需要你处理：www.google.com reCAPTCHA 人机验证（验证码）" : nil,
                          alertTab: argv.contains("--alert") ? 2 : nil)
            ]
            if m.mode == "off" { m.mode = "task" }
            // Sessions, the setup check and the activity log: samples for the picture, not anyone's data.
            let ok = { (id: String, t: String) in Check(id: id, title: t, required: true, ok: true, skipped: false, detail: "", fix: nil, settings: nil) }
            var items = [ok("macos", "macOS"), ok("node", "Node.js"), ok("helpers", "助手程序"), ok("chrome_installed", "Google Chrome 已安装"),
                         ok("chrome_running", "Google Chrome 在运行"), ok("automation", "自动化：控制 Chrome"), ok("apple_events_js", "Chrome：允许 Apple 事件中的 JavaScript"),
                         ok("accessibility", "辅助功能：真实鼠标键盘"), ok("screen_recording", "屏幕录制：截图识字")]
            if argv.contains("--fail") {
                items[7] = Check(id: "accessibility", title: "辅助功能：真实鼠标键盘", required: true, ok: false, skipped: false,
                                 detail: "「kitty」没有打开。", fix: "打开「系统设置 → 隐私与安全性 → 辅助功能」，把「kitty」的开关打开。",
                                 settings: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            }
            if argv.contains("--no-chrome") {
                items[4] = Check(id: "chrome_running", title: "Google Chrome 在运行", required: true, ok: false, skipped: false,
                                 detail: "Google Chrome 没有在运行。", fix: "打开 Google Chrome（或运行 mychrome-mcp doctor --open-chrome 让本检查替你打开）。", settings: nil)
            }
            m.servers = [
                ServerInfo(id: 1, who: "Claude Code · demo", color: 0, version: "demo", startedAt: now - 52 * 60_000, busy: "click",
                           lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:],
                           checks: SetupChecks(at: now - 2 * 60_000, app: "kitty", items: items), needsRestart: false),
                ServerInfo(id: 2, who: "Codex · demo", color: 1, version: "demo", startedAt: now - 27 * 3600_000, busy: nil,
                           lastActionAt: now - 4 * 60_000, root: nil, srcHash: nil, envLocked: [:], needsRestart: true),
                ServerInfo(id: 5, who: "Claude · 主目录", color: 2, version: "demo", startedAt: now - 3 * 3600_000, busy: nil,
                           lastActionAt: now - 9 * 60_000, root: nil, srcHash: nil, envLocked: [:], needsRestart: true, launcher: 6)
            ]
            m.legacy = argv.contains("--legacy") ? [3, 4] : []
            if argv.contains("--restart") {
                m.restartJob = RestartJob(pid: 0, startedAt: now - 4 * 60_000, at: now - 20_000, finished: true, died: false, items: [
                    RestartItem(id: 1, name: "demo · 更新商品页面", state: "done", note: "已重启，用上新版了"),
                    RestartItem(id: 2, name: "demo · 整理任务", state: "done", note: "已重启，用上新版了"),
                    RestartItem(id: 3, name: "SSH 连接 remote-mac", state: "skipped", note: "等了 30 分钟还是没机会（输入框里有没发出去的字，等它清空），没动它"),
                    RestartItem(id: 4, name: "demo · 写周报", state: "failed", note: "发了 /mcp reconnect chrome-bridge，但 MyChrome 没换（这个会话的 Claude Code 可能太旧）：在里面输入 /mcp 手动 Reconnect，或者关掉重开")])
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
        var hb: [String: Any] = ["state": m.habitsState]
        if let h = m.habits {
            hb["use"] = h.use
            hb["interKeyMs"] = h.interKeyMs.map { Int($0.rounded()) } ?? NSNull()
            hb["speedX"] = h.speedX.map { ($0 * 10).rounded() / 10 } ?? NSNull()
        }
        let o: [String: Any] = ["ok": true, "path": path, "w": Int(host.bounds.width), "h": Int(host.bounds.height), "habits": hb]
        if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) { print(String(decoding: d, as: UTF8.self)) }
    }
}
