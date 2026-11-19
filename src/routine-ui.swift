import SwiftUI
import AppKit
import Combine

// Website routines use their worker's local IPC; no conversation text or model request is involved.
func routineWorkerKey(_ server: ServerInfo) -> String { "\(server.id):\(server.guiInstance ?? "")" }
func routineSuccessor(_ original: ServerInfo, among servers: [ServerInfo]) -> ServerInfo? {
    guard let launcher = original.launcher, launcher > 0, let root = original.root, !root.isEmpty,
          original.startedAt > 0 else { return nil }
    let matches = servers.filter { $0.launcher == launcher && $0.root == root && $0.startedAt > original.startedAt
        && $0.guiInstance != nil && routineWorkerKey($0) != routineWorkerKey(original) }
    return matches.count == 1 ? matches[0] : nil
}
func routineRequestFits(_ request: [String: Any]) -> Bool {
    guard let data = try? JSONSerialization.data(withJSONObject: request) else { return false }
    return data.count <= 128 * 1024 // gui-client stdin limit, measured as the actual UTF-8 JSON.
}
func routineStopHint() -> String { L("接管时请在 0.8 秒内连按两次 Esc，可立即停止。键鼠被接管时，鼠标无法点击此处按钮。", "During a takeover, press Esc twice within 0.8 seconds to stop at once. While the keyboard and mouse are taken over, the buttons here cannot be clicked.") }
func routineCount(_ value: Any?) -> Int { (value as? [Any])?.count ?? (value as? Int ?? 0) }
func routineTabLabel(_ tab: [String: Any]) -> String {
    let title = tab["title"] as? String ?? L("未命名页面", "Untitled page")
    var location = URLComponents(string: tab["url"] as? String ?? "")
    location?.query = nil; location?.fragment = nil; location?.user = nil; location?.password = nil
    return title + " · " + String((location?.string ?? "").prefix(120)) + " · \(tab["tabId"] as? Int ?? 0)"
}
func routineActionName(_ tool: String) -> String {
    switch tool {
    case "click": return L("点击", "Click")
    case "hover": return L("悬停", "Hover")
    case "type_text": return L("输入文字", "Type text")
    case "select_option": return L("选择选项", "Choose option")
    case "scroll": return L("滚动页面", "Scroll page")
    case "press_key": return L("按键", "Press key")
    case "navigate", "navigate_tab", "open_tab": return L("打开页面", "Open page")
    default: return L("网页操作", "Page action")
    }
}
func routineErrorMessage(_ code: String) -> String {
    switch code {
    case "session_changed", "connection_lost": return L("这个连接已变化，请重新选择连接。", "This connection has changed. Please choose a connection again.")
    case "routine_busy", "busy": return L("这个连接已有流程正在运行，请先等待或停止。", "A routine is already running on this connection. Wait for it or stop it first.")
    case "routines_busy": return L("流程存储正在保存其他操作，请稍后刷新。", "The routine store is saving another change. Refresh in a moment.")
    case "routines_corrupt", "routines_unsafe", "routines_unreadable": return L("暂时无法读取流程存储，请检查保存位置。", "The routine store cannot be read right now. Check where it is saved.")
    case "routine_selection", "routine_gap", "routine_barrier", "routine_missing_event", "invalid_selection", "event_gap", "non_contiguous", "unreplayable", "unsafe_sequence": return L("这些操作不能组成连续流程，请重新选择完整片段。", "These actions do not form a continuous routine. Choose a complete range again.")
    case "invalid_params", "invalid_parameters", "missing_parameter": return L("请填写全部运行参数。", "Fill in every run parameter.")
    case "invalid_tab", "no_such_tab", "tab_not_owned": return L("这个标签页不可用，请刷新列表后重新选择。", "This tab is unavailable. Refresh the list and choose again.")
    case "paused", "paused_by_user": return L("AI 操作已暂停，请用上方按钮继续后再运行。", "AI operations are paused. Resume them with the button above, then run.")
    case "not_found", "routine_not_found": return L("这个流程已变化，请刷新后重新选择。", "This routine has changed. Refresh and choose again.")
    case "invalid_request", "unavailable": return L("这个连接暂不能使用网站流程，请更新连接后重试。", "This connection cannot use website routines yet. Update the connection and retry.")
    default: return L("这次操作未完成，请刷新状态后重试。", "This action did not finish. Refresh the status and retry.")
    }
}

struct RoutineEvent: Identifiable {
    let id: String, site: String, sessionId: String, tool: String, name: String, path: String
    let seq: Int, tab: Int, at: Double
    let replayable: Bool, ok: Bool
    init?(_ j: [String: Any]) {
        guard let id = j["id"] as? String else { return nil }
        self.id = id; site = j["site"] as? String ?? ""; sessionId = j["sessionId"] as? String ?? ""
        seq = j["seq"] as? Int ?? 0; tab = j["tab"] as? Int ?? 0; at = j["at"] as? Double ?? 0
        tool = j["tool"] as? String ?? ""
        name = (j["target"] as? [String: Any])?["name"] as? String ?? ""
        path = (j["before"] as? [String: Any])?["path"] as? String ?? ""
        replayable = j["replayable"] as? Bool == true; ok = j["ok"] as? Bool == true
    }
    var label: String { routineActionName(tool) + (name.isEmpty ? "" : " · " + name) }
}
func routineRange(_ events: [RoutineEvent], from start: String?, through end: String?) -> [String] {
    guard let anchor = events.first(where: { $0.id == start }) else { return [] }
    // Other workers can interleave records. Sequence numbers are per session/tab.
    let stream = events.filter { $0.sessionId == anchor.sessionId && $0.tab == anchor.tab }
    guard let first = stream.firstIndex(where: { $0.id == start }), let last = stream.firstIndex(where: { $0.id == end }), first <= last else { return [] }
    let selected = Array(stream[first...last])
    guard selected.count <= 50, let anchor = selected.first, !anchor.sessionId.isEmpty, anchor.tab > 0,
          selected.allSatisfy({ $0.ok && $0.replayable && $0.site == anchor.site && $0.sessionId == anchor.sessionId && $0.tab == anchor.tab }) else { return [] }
    guard selected.indices.dropFirst().allSatisfy({ selected[$0].seq == selected[$0 - 1].seq + 1 }) else { return [] }
    // The store also checks recording epochs, task boundaries and gaps outside this limited snapshot.
    return selected.map(\.id)
}
struct SavedRoutine: Identifiable {
    let id: String, site: String, name: String, description: String
    let steps: [[String: Any]], parameters: [[String: String]], runCount: Int
    init?(_ j: [String: Any]) {
        guard let id = j["id"] as? String, j["archived"] as? Bool != true else { return nil }
        self.id = id; site = j["site"] as? String ?? ""; name = j["name"] as? String ?? L("未命名流程", "Untitled routine")
        description = j["description"] as? String ?? ""; steps = j["steps"] as? [[String: Any]] ?? []
        parameters = j["parameters"] as? [[String: String]] ?? []; runCount = j["runCount"] as? Int ?? 0
    }
}
struct RoutineCandidate: Identifiable {
    let id: String, site: String, name: String, eventIds: [String]
    let steps: Int, count: Int
    init?(_ j: [String: Any]) {
        guard let id = j["id"] as? String, let ids = j["eventIds"] as? [String], !ids.isEmpty else { return nil }
        self.id = id; site = j["site"] as? String ?? ""; name = j["name"] as? String ?? L("可复用片段", "Reusable ranges")
        eventIds = ids; steps = routineCount(j["steps"]); count = j["count"] as? Int ?? 1
    }
}
struct RoutineSnapshotState {
    let enabled: Bool?, sites: [[String: Any]], events: [RoutineEvent], routines: [SavedRoutine], candidates: [RoutineCandidate]
    let recordingError: Bool
    init(_ j: [String: Any]) {
        enabled = j["enabled"] as? Bool; sites = j["sites"] as? [[String: Any]] ?? []
        recordingError = j["recordingError"] as? Bool == true
        // Snapshot is newest-record-first. Preserve recording order even if the wall clock changed.
        events = (j["events"] as? [[String: Any]] ?? []).reversed().compactMap(RoutineEvent.init)
        routines = (j["routines"] as? [[String: Any]] ?? []).compactMap(SavedRoutine.init)
        candidates = (j["candidates"] as? [[String: Any]] ?? []).compactMap(RoutineCandidate.init)
    }
}
/// I18N1: a routine run's text in the UI language. The runner writes it in Chinese (src/routine-runner.js; the agent's receipt
/// keeps it); in English it is rebuilt from the run's own facts — status, code and counts — so what was delivered, where it
/// stopped and whether control was returned stay exactly as the runner said them. Chinese: the runner's text unchanged.
func routineRunMessage(status: String, code: String?, completed: Int, total: Int, step: Int?, message: String) -> String {
    guard uiEnglish(), !message.isEmpty else { return message }
    if code == "cleanup_unconfirmed" { return "The actions ended, but returning control was not confirmed. Check the browser." }
    switch status {
    case "completed": return "Routine run and checked: \(completed) step\(completed == 1 ? "" : "s")."
    case "running":
        guard let s = step, s > 0 else { return "Checking the routine's starting page" }
        return completed >= s ? "Step \(s) of \(total) confirmed" : "Running step \(s) of \(total)"
    default: break
    }
    // A stopped run whose code is not itself a stop reason was cancelled while acting (the runner says just "stopped").
    if status == "cancelled", !["cancelled", "paused_by_user", "user_cancelled", "task_interrupted", "conversation_waiting"].contains(code ?? "") {
        return "Routine stopped."
    }
    switch code ?? "" {
    case "wrong_page": return "The current page is not where the routine was recorded. Go back to the routine's starting page first."
    case "page_changed": return "The page is not as recorded, so the routine stopped; the remaining steps were not run."
    case "target_missing": return "The recorded target was not found, so the routine stopped. Ask the AI to check the page."
    case "target_ambiguous": return "Several identical targets appeared on the page, so the routine stopped without guessing a click."
    case "target_changed": return "The target changed before the action, so the routine stopped without typing further."
    case "postcondition_failed": return "The action was sent, but the expected page state was not confirmed; the routine stopped and will not retry by itself."
    case "site_blocked": return "The site needs a person, so the routine is paused."
    case "page_dialog": return "A dialog on the page needs attention, so the routine is paused."
    case "paused_by_user": return "You paused MyChrome, so the routine stopped."
    case "user_cancelled": return "You took back control, so the routine stopped."
    case "cancelled": return "Routine stopped."
    case "task_interrupted": return "The current task was interrupted. Check the original task before continuing."
    case "missing_parameter": return "Fill in the input values the routine needs."
    case "routine_busy": return "A routine is already running. Wait for it or stop it first."
    case "recording_unavailable": return "Routine records are unavailable for now; this run's result was not recorded."
    default: return "The routine could not continue. Ask the AI to check the current page; it is not retried automatically."
    }
}
struct RoutineRunState {
    let id: String?, status: String, completed: Int, total: Int, step: Int?, message: String
    let code: String?
    init(_ j: [String: Any]) {
        id = j["runId"] as? String; status = j["status"] as? String ?? "unknown"
        completed = max(0, j["completed"] as? Int ?? 0); total = max(0, j["total"] as? Int ?? 0)
        step = j["step"] as? Int
        code = (j["code"] as? String).flatMap { $0.range(of: "^[a-z_]{1,80}$", options: .regularExpression) != nil ? $0 : nil }
        message = String(routineRunMessage(status: status, code: code, completed: completed, total: total, step: step,
                                           message: j["message"] as? String ?? "").prefix(300))
    }
    var terminal: Bool { ["completed", "blocked", "cancelled", "failed"].contains(status) }
    var presentation: ConversationPresentation {
        switch status {
        case "running": return ConversationPresentation(kind: status, label: L("流程运行中", "Routine running"), symbol: "arrow.triangle.2.circlepath", tone: "blue")
        case "completed": return ConversationPresentation(kind: status, label: L("本次流程已完成", "Routine completed"), symbol: "checkmark.circle.fill", tone: "green")
        case "blocked": return ConversationPresentation(kind: status, label: L("流程已停下，需要处理", "Routine stopped; needs attention"), symbol: "hand.raised.fill", tone: "orange")
        case "cancelled": return ConversationPresentation(kind: status, label: L("流程已停止", "Routine stopped"), symbol: "stop.circle", tone: "gray")
        case "failed": return ConversationPresentation(kind: status, label: L("流程未完成", "Routine not completed"), symbol: "xmark.octagon.fill", tone: "red")
        default: return ConversationPresentation(kind: "unknown", label: L("运行状态尚未确认", "Run status not confirmed yet"), symbol: "questionmark.circle", tone: "orange")
        }
    }
}

final class RoutineModel: ObservableObject {
    // The parent model refreshes every second. Keep publisher identity across view rebuilds.
    let poll = Timer.publish(every: 1.5, on: .main, in: .common).autoconnect()
    @Published var workerKey = ""
    @Published var site = ""
    @Published var query = ""
    @Published var snapshot: RoutineSnapshotState? = nil
    @Published var loading = false
    @Published var saving = false
    @Published var checking = false
    @Published var cancelling = false
    @Published var note: String? = nil
    @Published var tabs: [[String: Any]] = []
    @Published var run: RoutineRunState? = nil
    @Published var runNote: String? = nil
    private var requestGeneration = 0
    private var runGeneration = 0
    private var runReadGeneration = 0
    private var runWorker: ServerInfo? = nil
    private var startNonce: String? = nil
    private var runRoutineId: String? = nil
    private var runTab: Int? = nil
    @Published var runTitle = ""
    var activeRun: Bool { startNonce != nil && run?.terminal != true }
    var browsingOtherWorker: Bool { activeRun && runWorker.map { routineWorkerKey($0) != workerKey } == true }
    func choose(_ server: ServerInfo) {
        guard (!activeRun || run?.status == "unknown"), workerKey != routineWorkerKey(server) else { return }
        requestGeneration += 1; workerKey = routineWorkerKey(server)
        snapshot = nil; tabs = []; site = ""; note = nil; loading = false; saving = false
        // Browsing another connection must not discard or reroute an uncertain run.
        if !activeRun {
            runGeneration += 1; run = nil; runNote = nil; startNonce = nil; runWorker = nil
            runRoutineId = nil; runTab = nil; checking = false; cancelling = false
        }
    }
    func refresh(_ server: ServerInfo, preservingNote: Bool = false) {
        guard routineWorkerKey(server) == workerKey else { return }
        requestGeneration += 1
        let expected = requestGeneration, key = workerKey
        if !preservingNote { note = nil }
        loading = true
        var payload: [String: Any] = ["action": "snapshot", "limit": 100]
        if !site.isEmpty { payload["site"] = site }
        if !query.isEmpty { payload["query"] = query }
        callConversation(server, request: ["op": "routine", "payload": payload]) { [weak self] response in
            guard let self, self.workerKey == key, self.requestGeneration == expected else { return }
            self.loading = false
            if response["ok"] as? Bool == true, let result = response["result"] as? [String: Any] {
                self.snapshot = RoutineSnapshotState(result)
                if !self.activeRun, let active = result["activeRun"] as? [String: Any],
                   let nonce = active["nonce"] as? String, !nonce.isEmpty,
                   let id = active["runId"] as? String, !id.isEmpty, active["status"] as? String == "running" {
                    self.runGeneration += 1; self.startNonce = nonce; self.runWorker = server
                    self.runRoutineId = active["routineId"] as? String; self.runTab = active["tab"] as? Int
                    self.run = RoutineRunState(active); self.runNote = nil
                    self.runTitle = self.snapshot?.routines.first { $0.id == active["routineId"] as? String }?.name ?? L("正在运行的网站流程", "Running website routine")
                }
            } else { self.snapshot = nil; self.note = routineErrorMessage(response["code"] as? String ?? "unavailable") }
        }
    }
    func change(_ server: ServerInfo, payload: [String: Any], success: String) {
        guard routineWorkerKey(server) == workerKey, !saving else { return }
        let key = workerKey
        saving = true; note = nil
        callConversation(server, request: ["op": "routine", "payload": payload]) { [weak self] response in
            guard let self, self.workerKey == key else { return }
            self.saving = false
            self.note = response["ok"] as? Bool == true ? success : routineErrorMessage(response["code"] as? String ?? "unavailable")
            self.refresh(server, preservingNote: true)
        }
    }
    func loadTabs(_ server: ServerInfo) {
        let key = workerKey
        guard routineWorkerKey(server) == key else { return }
        callConversation(server, request: ["op": "routine", "payload": ["action": "tabs"]]) { [weak self] response in
            guard let self, self.workerKey == key else { return }
            self.tabs = response["ok"] as? Bool == true ? (response["result"] as? [String: Any])?["tabs"] as? [[String: Any]] ?? [] : []
            if response["ok"] as? Bool != true { self.note = routineErrorMessage(response["code"] as? String ?? "unavailable") }
        }
    }
    func start(_ server: ServerInfo, routine: SavedRoutine, tab: Int, params: [String: String]) {
        guard !activeRun, workerKey == routineWorkerKey(server), tab > 0,
              tabs.contains(where: { $0["tabId"] as? Int == tab }),
              routine.parameters.allSatisfy({ !(params[$0["name"] ?? ""] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { return }
        let nonce = UUID().uuidString
        let request: [String: Any] = ["op": "routine", "payload": ["action": "start", "id": routine.id, "tab": tab, "params": params, "nonce": nonce]]
        guard routineRequestFits(request) else { note = L("参数内容太长，本次请求未发送。请减少内容后再运行。", "The parameters are too long, so this request was not sent. Shorten them and run again."); return }
        runGeneration += 1
        let generation = runGeneration
        checking = false; cancelling = false
        startNonce = nonce; runWorker = server; runNote = nil; runTitle = routine.name
        runRoutineId = routine.id; runTab = tab
        run = RoutineRunState(["status": "unknown", "total": routine.steps.count])
        callConversation(server, request: request) { [weak self] response in
            guard let self, self.runGeneration == generation, self.startNonce == nonce else { return }
            guard self.run?.terminal != true else { return }
            if response["ok"] as? Bool == true, let result = response["result"] as? [String: Any] {
                self.run = RoutineRunState(result)
                self.checkRun()
            } else if response["delivery"] as? String == "not_sent" || response["delivery"] as? String == "rejected" {
                self.startNonce = nil
                self.runReadGeneration += 1; self.checking = false; self.cancelling = false
                self.run = RoutineRunState(["status": "failed"])
                self.runNote = routineErrorMessage(response["code"] as? String ?? "unavailable")
            } else {
                self.runNote = L("启动结果尚未确认。请检查状态；不会自动重试启动。", "The start is not confirmed yet. Check the status; the start is not retried automatically.")
            }
        }
    }
    func checkRun(cancel: Bool = false, servers: [ServerInfo] = []) {
        guard let server = runWorker, let nonce = startNonce, cancel ? !cancelling : !checking,
              cancel || run?.terminal != true else { return }
        checking = true
        if cancel { cancelling = true }
        runReadGeneration += 1
        let generation = runGeneration, readGeneration = runReadGeneration
        var payload: [String: Any] = ["action": cancel ? "cancel" : "status", "nonce": nonce]
        if let id = run?.id { payload["runId"] = id }
        callConversation(server, request: ["op": "routine", "payload": payload]) { [weak self] response in
            guard let self, self.runGeneration == generation, self.startNonce == nonce, self.runReadGeneration == readGeneration else { return }
            self.checking = false; self.cancelling = false
            if response["ok"] as? Bool == true, let result = response["result"] as? [String: Any] {
                self.run = RoutineRunState(result); self.runNote = nil
                if self.run?.terminal == true { self.refresh(server) }
            } else {
                var unknown: [String: Any] = ["status": "unknown", "completed": self.run?.completed ?? 0, "total": self.run?.total ?? 0]
                if let id = self.run?.id { unknown["runId"] = id }
                self.run = RoutineRunState(unknown)
                self.runNote = L("原运行尚未确认；可查看其他连接的记录，但不能重发。仅会向可信后继连接查询同一回执。", "The original run is not confirmed yet. You can view other connections' records but cannot resend; only a trusted successor connection is asked for the same receipt.")
                if !cancel { self.recoverRun(servers) }
            }
        }
    }
    func recoverRun(_ servers: [ServerInfo]) {
        guard activeRun, run?.status == "unknown", !checking, !cancelling,
              let original = runWorker, let nonce = startNonce, let routineId = runRoutineId, let tab = runTab,
              let successor = routineSuccessor(original, among: servers) else { return }
        checking = true; runReadGeneration += 1
        let generation = runGeneration, readGeneration = runReadGeneration, knownId = run?.id
        var payload: [String: Any] = ["action": "status", "nonce": nonce]
        if let id = knownId { payload["runId"] = id }
        callConversation(successor, request: ["op": "routine", "payload": payload]) { [weak self] response in
            guard let self, self.runGeneration == generation, self.startNonce == nonce,
                  self.runReadGeneration == readGeneration else { return }
            self.checking = false
            guard response["ok"] as? Bool == true, let result = response["result"] as? [String: Any],
                  let id = result["runId"] as? String, !id.isEmpty, knownId == nil || knownId == id,
                  result["nonce"] as? String == nonce, result["routineId"] as? String == routineId,
                  result["tab"] as? Int == tab, RoutineRunState(result).terminal else { return }
            self.runWorker = successor; self.run = RoutineRunState(result)
            self.runNote = L("已从同一连接热更新后的运行回执恢复结果，没有重新执行流程。", "The result was recovered from the run receipt after the same connection updated itself; the routine was not run again.")
            if self.workerKey == routineWorkerKey(original) {
                self.workerKey = routineWorkerKey(successor); self.snapshot = nil; self.tabs = []
                self.refresh(successor)
            }
        }
    }
}

struct RoutinePolling: ViewModifier {
    @ObservedObject var model: Model
    @ObservedObject var state: RoutineModel
    func body(content: Content) -> some View {
        content.onReceive(state.poll) { _ in
            guard model.live, model.conversationVisible, model.workspaceDestination == "routines", state.activeRun else { return }
            state.checkRun(servers: model.servers.filter { $0.guiInstance != nil && $0.node != nil })
        }
    }
}

struct RoutineCenter: View {
    @ObservedObject var model: Model
    @ObservedObject var state: RoutineModel
    @State private var selectedRoutine = ""
    @State private var rangeStart = ""
    @State private var rangeEnd = ""
    @State private var candidate = ""
    @State private var newName = ""
    @State private var params: [String: String] = [:]
    @State private var selectedTab: Int? = nil
    init(model: Model) {
        self.model = model; self.state = model.routines
        _selectedRoutine = State(initialValue: model.live ? "" : model.routines.snapshot?.routines.first?.id ?? "")
    }
    var workers: [ServerInfo] { model.servers.filter { $0.guiInstance != nil && $0.node != nil } }
    var worker: ServerInfo? { workers.first { routineWorkerKey($0) == state.workerKey } }
    var selected: SavedRoutine? { state.snapshot?.routines.first { $0.id == selectedRoutine } }
    var selectedEvents: [String] {
        if let c = state.snapshot?.candidates.first(where: { $0.id == candidate }) { return c.eventIds }
        return routineRange(state.snapshot?.events ?? [], from: rangeStart, through: rangeEnd)
    }
    func resetSelection() { selectedRoutine = ""; rangeStart = ""; rangeEnd = ""; candidate = ""; newName = ""; params = [:]; selectedTab = nil }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("网站流程", "Website routines")).font(.title2.bold())
                    Text(L("把连续的网页操作保存下来，下次填写参数后直接运行。", "Save a continuous series of page actions, then run it with new parameters next time.")).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if let worker, let enabled = state.snapshot?.enabled {
                    Toggle(L("自动记录操作", "Record actions automatically"), isOn: Binding(get: { enabled }, set: {
                        state.change(worker, payload: ["action": "settings", "enabled": $0], success: $0 ? L("自动记录已开启", "Automatic recording on") : L("自动记录已关闭", "Automatic recording off"))
                    })).toggleStyle(.switch).disabled(state.saving || !model.live)
                }
            }.padding(22)
            if state.run != nil || state.runNote != nil { runCard.padding(.horizontal, 22).padding(.bottom, 14) }
            if workers.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "network").font(.system(size: 34)).foregroundStyle(.secondary)
                    Text(L("还没有可用的 MyChrome 连接", "No MyChrome connection available yet")).font(.headline)
                    Text(L("在 AI 客户端连接 MyChrome 后，就能查看和管理网站流程。", "Connect MyChrome in your AI client to view and manage website routines.")).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HStack {
                    Picker(L("操作连接", "Connection"), selection: Binding(get: { state.workerKey }, set: { key in
                        if let server = workers.first(where: { routineWorkerKey($0) == key }) { state.choose(server); resetSelection(); state.refresh(server) }
                    })) {
                        Text(L("请选择连接", "Choose a connection")).tag("")
                        ForEach(workers) { server in Text(server.who + " · \(server.id)").tag(routineWorkerKey(server)) }
                    }.disabled(state.activeRun && state.run?.status != "unknown")
                    Button { if let worker { state.refresh(worker) } } label: { Label(L("刷新", "Refresh"), systemImage: "arrow.clockwise") }
                        .disabled(worker == nil || state.loading || !model.live)
                }.padding(.horizontal, 22).padding(.bottom, 12)
                if let note = state.note { Text(note).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 22).padding(.bottom, 10) }
                if state.snapshot?.recordingError == true {
                    Label(L("部分新操作未能记录，请检查保存位置后刷新。", "Some new actions could not be recorded. Check where they are saved, then refresh."), systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange).padding(.horizontal, 22).padding(.bottom, 10)
                }
                Divider()
                if let worker {
                    if let snapshot = state.snapshot {
                        content(snapshot, worker: worker)
                    } else {
                        VStack(spacing: 12) {
                            if state.loading { ProgressView() }
                            Text(state.loading ? L("正在读取网站流程…", "Reading website routines…") : L("尚未读取这个连接的网站流程", "This connection's website routines have not been read yet")).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else {
                    Text(state.activeRun ? L("原运行连接已断开。保留原请求身份；可信后继仅用于查询原回执。", "The original run's connection was lost. The original request identity is kept; a trusted successor is used only to look up the original receipt.") : L("选择一个连接，查看它保存的网站流程。", "Choose a connection to see the website routines it saved."))
                        .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }.onAppear {
            guard model.live else { return }
            if state.workerKey.isEmpty, let first = workers.first { state.choose(first) }
            if let worker { state.refresh(worker) }
        }.modifier(RoutinePolling(model: model, state: state))
    }
    var runCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !state.runTitle.isEmpty { Text(state.runTitle).font(.callout.bold()) }
            HStack {
                if let run = state.run {
                    ConversationStatusLabel(presentation: run.presentation).font(.headline)
                    Spacer()
                    Text(L("已完成 \(run.completed) / \(run.total) 步", "\(run.completed) of \(run.total) steps done")).font(.caption.monospacedDigit())
                }
                if state.activeRun || (!model.live && state.run?.status == "running") {
                    Button(L("检查状态", "Check status")) { state.checkRun(servers: workers) }.disabled(state.checking || !model.live)
                    Button(L("停止流程", "Stop routine")) { state.checkRun(cancel: true) }.disabled(state.cancelling || !model.live)
                }
            }
            if state.activeRun || (!model.live && state.run?.status == "running") {
                Label(routineStopHint(), systemImage: "keyboard").font(.callout.weight(.semibold)).foregroundStyle(.orange)
            }
            if state.browsingOtherWorker {
                Text(L("当前查看的是其他连接；上方运行仍保留原连接和请求身份，未重新发送。", "You are viewing another connection; the run above keeps its original connection and request identity and was not resent.")).font(.caption).foregroundStyle(.secondary)
            }
            if let run = state.run {
                if run.total > 0 { ProgressView(value: Double(min(run.completed, run.total)), total: Double(run.total)) }
                if let step = run.step, step > 0, run.status != "completed" { Text((run.terminal ? L("停在第 ", "Stopped at step ") : L("正在执行第 ", "Running step ")) + L("\(step) 步", "\(step)")).font(.caption) }
                if !run.message.isEmpty { Text(run.message).font(.callout).fixedSize(horizontal: false, vertical: true) }
            }
            if let note = state.runNote { Text(note).font(.callout).foregroundStyle(.orange) }
        }.padding(14).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
    func content(_ snapshot: RoutineSnapshotState, worker: ServerInfo) -> some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    siteButton(L("全部网站", "All websites"), site: "", worker: worker)
                    ForEach(snapshot.sites.compactMap { $0["site"] as? String }, id: \.self) { site in
                        siteButton(site, site: site, worker: worker)
                    }
                }.padding(12)
            }.frame(width: 210).background(Color(nsColor: .controlBackgroundColor))
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack {
                        TextField(L("搜索流程或操作", "Search routines or actions"), text: $state.query).textFieldStyle(.roundedBorder)
                            .onSubmit { state.refresh(worker) }
                        Button(L("搜索", "Search")) { state.refresh(worker) }.disabled(state.loading)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        Text(L("已保存的流程", "Saved routines")).font(.headline)
                        if snapshot.routines.isEmpty { Text(L("这个网站还没有保存的流程。从下面选择一段连续操作即可创建。", "No routines saved for this website yet. Choose a continuous range of actions below to create one.")).foregroundStyle(.secondary) }
                        ForEach(snapshot.routines) { routine in
                            Button {
                                selectedRoutine = routine.id; params = [:]; selectedTab = nil; state.tabs = []
                            } label: {
                                HStack {
                                    Image(systemName: "list.bullet.rectangle")
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(routine.name).font(.system(size: 13, weight: .semibold))
                                        Text(L("\(routine.steps.count) 步 · 已运行 \(routine.runCount) 次", "\(routine.steps.count) step(s) · run \(routine.runCount) time(s)")).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer(); Image(systemName: "chevron.right").font(.caption)
                                }.padding(11).background(selectedRoutine == routine.id ? Color.accentColor.opacity(0.1) : Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                            }.buttonStyle(.plain)
                        }
                    }
                    if let selected { routineDetail(selected, worker: worker) }
                    Divider()
                    VStack(alignment: .leading, spacing: 12) {
                        Text(L("可复用片段", "Reusable ranges")).font(.headline)
                        if snapshot.candidates.isEmpty { Text(L("记录到可保存的连续片段后，会在这里给出建议。", "Suggestions appear here once a continuous range that can be saved is recorded.")).foregroundStyle(.secondary) }
                        ForEach(snapshot.candidates) { c in
                            Button {
                                candidate = c.id; rangeStart = ""; rangeEnd = ""; newName = c.name
                            } label: {
                                HStack { Image(systemName: "repeat"); Text(c.name); Spacer(); Text(L("\(c.steps) 步 · \(c.count) 次", "\(c.steps) step(s) · \(c.count) time(s)")).foregroundStyle(.secondary) }
                            }.buttonStyle(.bordered)
                        }
                    }
                    recentActions(snapshot, worker: worker)
                }.padding(22)
            }
        }
    }
    func siteButton(_ title: String, site: String, worker: ServerInfo) -> some View {
        Button { state.site = site; resetSelection(); state.refresh(worker) } label: {
            Text(title).font(.callout).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading).padding(10)
                .background(state.site == site ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(.plain)
    }
    func routineDetail(_ routine: SavedRoutine, worker: ServerInfo) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text(routine.name).font(.headline); Spacer()
                Button(L("归档", "Archive")) { state.change(worker, payload: ["action": "update", "id": routine.id, "archived": true], success: L("流程已归档", "Routine archived")); selectedRoutine = "" }
                    .disabled(state.saving || state.activeRun || !model.live)
            }
            if !routine.description.isEmpty { Text(routine.description).foregroundStyle(.secondary) }
            ForEach(Array(routine.steps.enumerated()), id: \.offset) { index, step in
                let target = ((step["target"] as? [String: Any])?["name"] as? String).map { " · " + $0 } ?? ""
                Text("\(index + 1). " + routineActionName(step["tool"] as? String ?? "") + target)
                    .font(.callout)
            }
            ForEach(Array(routine.parameters.enumerated()), id: \.offset) { _, parameter in
                if let name = parameter["name"] {
                    TextField(parameter["label"] ?? name, text: Binding(get: { params[name] ?? "" }, set: { params[name] = $0 })).textFieldStyle(.roundedBorder)
                }
            }
            HStack {
                Picker(L("运行标签页", "Tab to run in"), selection: $selectedTab) {
                    Text(L("请选择现有标签页", "Choose an open tab")).tag(Int?.none)
                    ForEach(Array(state.tabs.enumerated()), id: \.offset) { _, tab in
                        if let id = tab["tabId"] as? Int { Text(routineTabLabel(tab)).tag(Int?.some(id)) }
                    }
                }
                Button(L("读取标签页", "Read tabs")) { selectedTab = nil; state.loadTabs(worker) }.disabled(!model.live || state.activeRun)
            }
            HStack {
                Text(L("只会在你选定的现有标签页运行。", "Runs only in the open tab you choose.")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { if let tab = selectedTab { state.start(worker, routine: routine, tab: tab, params: params) } } label: { Label(L("运行流程", "Run routine"), systemImage: "play.fill") }
                    .buttonStyle(.borderedProminent)
                    .disabled(selectedTab == nil || state.activeRun || !model.live || routine.parameters.contains { (params[$0["name"] ?? ""] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
            }
        }.padding(16).background(Color.secondary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
    }
    func recentActions(_ snapshot: RoutineSnapshotState, worker: ServerInfo) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("最近记录的操作", "Recently recorded actions")).font(.headline)
            if snapshot.events.isEmpty {
                Text(snapshot.enabled == nil ? L("记录状态尚未确认，请刷新后查看。", "The recording status is not confirmed yet. Refresh to see it.") : snapshot.enabled == true ? L("还没有记录到网页操作。连接的 AI 操作网页后，记录会显示在这里。", "No page actions recorded yet. They appear here after a connected AI works on a page.") : L("自动记录未开启。开启后，新操作会显示在这里。", "Automatic recording is off. Turn it on to see new actions here."))
                    .foregroundStyle(.secondary)
            } else {
                Text(L("按记录顺序排列。选择起止步骤，保存中间的完整片段。", "Listed in recording order. Choose a first and last step to save the complete range between them.")).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Picker(L("从", "From"), selection: Binding(get: { rangeStart }, set: { rangeStart = $0; candidate = "" })) {
                        Text(L("选择起点", "Choose a start")).tag("")
                        ForEach(Array(snapshot.events.enumerated()), id: \.element.id) { index, event in Text("\(index + 1). " + event.label).tag(event.id) }
                    }
                    Picker(L("到", "To"), selection: Binding(get: { rangeEnd }, set: { rangeEnd = $0; candidate = "" })) {
                        Text(L("选择终点", "Choose an end")).tag("")
                        ForEach(Array(snapshot.events.enumerated()), id: \.element.id) { index, event in Text("\(index + 1). " + event.label).tag(event.id) }
                    }
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(snapshot.events.enumerated()), id: \.element.id) { index, event in
                            HStack(alignment: .top) {
                                Image(systemName: event.replayable && event.ok ? "circle" : "exclamationmark.circle").foregroundStyle(event.replayable && event.ok ? Color.secondary : .orange)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("\(index + 1). " + event.label).font(.callout)
                                    Text(event.path + L(" · 标签 \(event.tab)", " · tab \(event.tab)")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    if !event.replayable || !event.ok { Text(L("这一步不能保存为可运行流程", "This step cannot be saved in a runnable routine")).font(.caption).foregroundStyle(.orange) }
                                }
                                Spacer()
                                Text(Date(timeIntervalSince1970: event.at / 1000).formatted(uiDateStyle(date: .omitted, time: .shortened))).font(.caption).foregroundStyle(.secondary)
                            }.padding(6).background(selectedEvents.contains(event.id) ? Color.accentColor.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }.frame(height: min(260, Double(snapshot.events.count) * 62))
            }
            if !snapshot.events.isEmpty || !candidate.isEmpty {
                if !selectedEvents.isEmpty { Text(L("已选择 \(selectedEvents.count) 个连续步骤", "\(selectedEvents.count) consecutive step(s) selected")).font(.caption).foregroundStyle(.secondary) }
                else if !rangeStart.isEmpty || !rangeEnd.isEmpty { Text(L("请选择同一网站、连接和标签页中可以回放的连续步骤。", "Choose consecutive replayable steps from the same website, connection and tab.")).font(.caption).foregroundStyle(.orange) }
                HStack {
                    TextField(L("给这个流程起个名字", "Name this routine"), text: $newName).textFieldStyle(.roundedBorder)
                    Button(L("保存流程", "Save routine")) {
                        state.change(worker, payload: ["action": "save", "name": newName.trimmingCharacters(in: .whitespacesAndNewlines), "eventIds": selectedEvents], success: L("流程已保存", "Routine saved"))
                    }.disabled(selectedEvents.isEmpty || newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || state.saving || !model.live)
                }
            }
        }
    }
}

/// Offline render fixtures only; Model(live: false) never contacts workers or the browser.
enum RoutineSnapshot {
    static func populate(_ model: Model) {
        if CommandLine.arguments.contains("--routine-empty") { model.servers = []; return }
        let server = ServerInfo(id: 101, who: L("Codex · 网站操作", "Codex · website tasks"), color: 0, version: "synthetic", startedAt: 0,
            busy: nil, lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:], guiInstance: "routine-preview", node: "/synthetic/node")
        model.servers = [server]; model.routines.choose(server)
        let site = "https://courses.example"
        let steps: [[String: Any]] = [["tool": "click", "target": ["name": L("课程搜索", "Course search")]],
            ["tool": "type_text", "target": ["name": L("搜索关键词", "Search keywords")]], ["tool": "click", "target": ["name": L("搜索", "Search")]]]
        let events: [[String: Any]] = steps.enumerated().reversed().map { index, step in
            ["id": "event-\(index)", "seq": index + 1, "at": 1_790_000_000_000.0 + Double(index) * 10_000,
             "sessionId": "preview", "tab": 7, "site": site, "tool": step["tool"]!, "target": step["target"]!,
             "before": ["origin": site, "path": "/catalog"], "ok": true, "replayable": true]
        }
        let recent = CommandLine.arguments.contains("--routine-recent")
        model.routines.snapshot = RoutineSnapshotState(["enabled": true,
            "sites": [["site": site, "count": 9, "lastAt": 1_790_000_000_000.0]], "events": events,
            "routines": recent ? [] : [["id": "routine-preview", "site": site, "name": L("搜索课程", "Search courses"), "description": L("填写关键词，然后查看搜索结果。", "Enter keywords, then view the search results."),
                "steps": steps, "parameters": [["name": "input_1", "label": L("搜索关键词", "Search keywords")]], "runCount": 4]],
            "candidates": [["id": "candidate", "site": site, "name": L("课程搜索片段", "Course search range"), "eventIds": ["event-0", "event-1", "event-2"], "steps": steps, "count": 3]]])
        if CommandLine.arguments.contains("--routine-running") {
            model.routines.runTitle = L("搜索课程", "Search courses")
            model.routines.run = RoutineRunState(["runId": "preview-run", "status": "running", "completed": 1, "total": 3, "step": 2])
        }
    }
}
