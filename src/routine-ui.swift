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
func routineStopHint() -> String { "接管时请在 0.8 秒内连按两次 Esc，可立即停止。键鼠被接管时，鼠标无法点击此处按钮。" }
func routineCount(_ value: Any?) -> Int { (value as? [Any])?.count ?? (value as? Int ?? 0) }
func routineTabLabel(_ tab: [String: Any]) -> String {
    let title = tab["title"] as? String ?? "未命名页面"
    var location = URLComponents(string: tab["url"] as? String ?? "")
    location?.query = nil; location?.fragment = nil; location?.user = nil; location?.password = nil
    return title + " · " + String((location?.string ?? "").prefix(120)) + " · \(tab["tabId"] as? Int ?? 0)"
}
func routineActionName(_ tool: String) -> String {
    switch tool {
    case "click": return "点击"
    case "hover": return "悬停"
    case "type_text": return "输入文字"
    case "select_option": return "选择选项"
    case "scroll": return "滚动页面"
    case "press_key": return "按键"
    case "navigate", "navigate_tab", "open_tab": return "打开页面"
    default: return "网页操作"
    }
}
func routineErrorMessage(_ code: String) -> String {
    switch code {
    case "session_changed", "connection_lost": return "这个连接已变化，请重新选择连接。"
    case "routine_busy", "busy": return "这个连接已有流程正在运行，请先等待或停止。"
    case "routines_busy": return "流程存储正在保存其他操作，请稍后刷新。"
    case "routines_corrupt", "routines_unsafe", "routines_unreadable": return "暂时无法读取流程存储，请检查保存位置。"
    case "routine_selection", "routine_gap", "routine_barrier", "routine_missing_event", "invalid_selection", "event_gap", "non_contiguous", "unreplayable", "unsafe_sequence": return "这些操作不能组成连续流程，请重新选择完整片段。"
    case "invalid_params", "invalid_parameters", "missing_parameter": return "请填写全部运行参数。"
    case "invalid_tab", "no_such_tab", "tab_not_owned": return "这个标签页不可用，请刷新列表后重新选择。"
    case "paused", "paused_by_user": return "AI 操作已暂停，请用上方按钮继续后再运行。"
    case "not_found", "routine_not_found": return "这个流程已变化，请刷新后重新选择。"
    case "invalid_request", "unavailable": return "这个连接暂不能使用网站流程，请更新连接后重试。"
    default: return "这次操作未完成，请刷新状态后重试。"
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
        self.id = id; site = j["site"] as? String ?? ""; name = j["name"] as? String ?? "未命名流程"
        description = j["description"] as? String ?? ""; steps = j["steps"] as? [[String: Any]] ?? []
        parameters = j["parameters"] as? [[String: String]] ?? []; runCount = j["runCount"] as? Int ?? 0
    }
}
struct RoutineCandidate: Identifiable {
    let id: String, site: String, name: String, eventIds: [String]
    let steps: Int, count: Int
    init?(_ j: [String: Any]) {
        guard let id = j["id"] as? String, let ids = j["eventIds"] as? [String], !ids.isEmpty else { return nil }
        self.id = id; site = j["site"] as? String ?? ""; name = j["name"] as? String ?? "可复用片段"
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
struct RoutineRunState {
    let id: String?, status: String, completed: Int, total: Int, step: Int?, message: String
    init(_ j: [String: Any]) {
        id = j["runId"] as? String; status = j["status"] as? String ?? "unknown"
        completed = max(0, j["completed"] as? Int ?? 0); total = max(0, j["total"] as? Int ?? 0)
        step = j["step"] as? Int
        message = String((j["message"] as? String ?? "").prefix(300))
    }
    var terminal: Bool { ["completed", "blocked", "cancelled", "failed"].contains(status) }
    var presentation: ConversationPresentation {
        switch status {
        case "running": return ConversationPresentation(kind: status, label: "流程运行中", symbol: "arrow.triangle.2.circlepath", tone: "blue")
        case "completed": return ConversationPresentation(kind: status, label: "本次流程已完成", symbol: "checkmark.circle.fill", tone: "green")
        case "blocked": return ConversationPresentation(kind: status, label: "流程已停下，需要处理", symbol: "hand.raised.fill", tone: "orange")
        case "cancelled": return ConversationPresentation(kind: status, label: "流程已停止", symbol: "stop.circle", tone: "gray")
        case "failed": return ConversationPresentation(kind: status, label: "流程未完成", symbol: "xmark.octagon.fill", tone: "red")
        default: return ConversationPresentation(kind: "unknown", label: "运行状态尚未确认", symbol: "questionmark.circle", tone: "orange")
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
                    self.runTitle = self.snapshot?.routines.first { $0.id == active["routineId"] as? String }?.name ?? "正在运行的网站流程"
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
        guard routineRequestFits(request) else { note = "参数内容太长，本次请求未发送。请减少内容后再运行。"; return }
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
                self.runNote = "启动结果尚未确认。请检查状态；不会自动重试启动。"
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
                self.runNote = "原运行尚未确认；可查看其他连接的记录，但不能重发。仅会向可信后继连接查询同一回执。"
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
            self.runNote = "已从同一连接热更新后的运行回执恢复结果，没有重新执行流程。"
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
                    Text("网站流程").font(.title2.bold())
                    Text("把连续的网页操作保存下来，下次填写参数后直接运行。").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if let worker, let enabled = state.snapshot?.enabled {
                    Toggle("自动记录操作", isOn: Binding(get: { enabled }, set: {
                        state.change(worker, payload: ["action": "settings", "enabled": $0], success: $0 ? "自动记录已开启" : "自动记录已关闭")
                    })).toggleStyle(.switch).disabled(state.saving || !model.live)
                }
            }.padding(22)
            if state.run != nil || state.runNote != nil { runCard.padding(.horizontal, 22).padding(.bottom, 14) }
            if workers.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "network").font(.system(size: 34)).foregroundStyle(.secondary)
                    Text("还没有可用的 MyChrome 连接").font(.headline)
                    Text("在 AI 客户端连接 MyChrome 后，就能查看和管理网站流程。").foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HStack {
                    Picker("操作连接", selection: Binding(get: { state.workerKey }, set: { key in
                        if let server = workers.first(where: { routineWorkerKey($0) == key }) { state.choose(server); resetSelection(); state.refresh(server) }
                    })) {
                        Text("请选择连接").tag("")
                        ForEach(workers) { server in Text(server.who + " · \(server.id)").tag(routineWorkerKey(server)) }
                    }.disabled(state.activeRun && state.run?.status != "unknown")
                    Button { if let worker { state.refresh(worker) } } label: { Label("刷新", systemImage: "arrow.clockwise") }
                        .disabled(worker == nil || state.loading || !model.live)
                }.padding(.horizontal, 22).padding(.bottom, 12)
                if let note = state.note { Text(note).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 22).padding(.bottom, 10) }
                if state.snapshot?.recordingError == true {
                    Label("部分新操作未能记录，请检查保存位置后刷新。", systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange).padding(.horizontal, 22).padding(.bottom, 10)
                }
                Divider()
                if let worker {
                    if let snapshot = state.snapshot {
                        content(snapshot, worker: worker)
                    } else {
                        VStack(spacing: 12) {
                            if state.loading { ProgressView() }
                            Text(state.loading ? "正在读取网站流程…" : "尚未读取这个连接的网站流程").foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else {
                    Text(state.activeRun ? "原运行连接已断开。保留原请求身份；可信后继仅用于查询原回执。" : "选择一个连接，查看它保存的网站流程。")
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
                    Text("已完成 \(run.completed) / \(run.total) 步").font(.caption.monospacedDigit())
                }
                if state.activeRun || (!model.live && state.run?.status == "running") {
                    Button("检查状态") { state.checkRun(servers: workers) }.disabled(state.checking || !model.live)
                    Button("停止流程") { state.checkRun(cancel: true) }.disabled(state.cancelling || !model.live)
                }
            }
            if state.activeRun || (!model.live && state.run?.status == "running") {
                Label(routineStopHint(), systemImage: "keyboard").font(.callout.weight(.semibold)).foregroundStyle(.orange)
            }
            if state.browsingOtherWorker {
                Text("当前查看的是其他连接；上方运行仍保留原连接和请求身份，未重新发送。").font(.caption).foregroundStyle(.secondary)
            }
            if let run = state.run {
                if run.total > 0 { ProgressView(value: Double(min(run.completed, run.total)), total: Double(run.total)) }
                if let step = run.step, step > 0, run.status != "completed" { Text((run.terminal ? "停在第 " : "正在执行第 ") + "\(step) 步").font(.caption) }
                if !run.message.isEmpty { Text(run.message).font(.callout).fixedSize(horizontal: false, vertical: true) }
            }
            if let note = state.runNote { Text(note).font(.callout).foregroundStyle(.orange) }
        }.padding(14).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
    func content(_ snapshot: RoutineSnapshotState, worker: ServerInfo) -> some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    siteButton("全部网站", site: "", worker: worker)
                    ForEach(snapshot.sites.compactMap { $0["site"] as? String }, id: \.self) { site in
                        siteButton(site, site: site, worker: worker)
                    }
                }.padding(12)
            }.frame(width: 210).background(Color(nsColor: .controlBackgroundColor))
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack {
                        TextField("搜索流程或操作", text: $state.query).textFieldStyle(.roundedBorder)
                            .onSubmit { state.refresh(worker) }
                        Button("搜索") { state.refresh(worker) }.disabled(state.loading)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        Text("已保存的流程").font(.headline)
                        if snapshot.routines.isEmpty { Text("这个网站还没有保存的流程。从下面选择一段连续操作即可创建。").foregroundStyle(.secondary) }
                        ForEach(snapshot.routines) { routine in
                            Button {
                                selectedRoutine = routine.id; params = [:]; selectedTab = nil; state.tabs = []
                            } label: {
                                HStack {
                                    Image(systemName: "list.bullet.rectangle")
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(routine.name).font(.system(size: 13, weight: .semibold))
                                        Text("\(routine.steps.count) 步 · 已运行 \(routine.runCount) 次").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer(); Image(systemName: "chevron.right").font(.caption)
                                }.padding(11).background(selectedRoutine == routine.id ? Color.accentColor.opacity(0.1) : Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                            }.buttonStyle(.plain)
                        }
                    }
                    if let selected { routineDetail(selected, worker: worker) }
                    Divider()
                    VStack(alignment: .leading, spacing: 12) {
                        Text("可复用片段").font(.headline)
                        if snapshot.candidates.isEmpty { Text("记录到可保存的连续片段后，会在这里给出建议。").foregroundStyle(.secondary) }
                        ForEach(snapshot.candidates) { c in
                            Button {
                                candidate = c.id; rangeStart = ""; rangeEnd = ""; newName = c.name
                            } label: {
                                HStack { Image(systemName: "repeat"); Text(c.name); Spacer(); Text("\(c.steps) 步 · \(c.count) 次").foregroundStyle(.secondary) }
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
                Button("归档") { state.change(worker, payload: ["action": "update", "id": routine.id, "archived": true], success: "流程已归档"); selectedRoutine = "" }
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
                Picker("运行标签页", selection: $selectedTab) {
                    Text("请选择现有标签页").tag(Int?.none)
                    ForEach(Array(state.tabs.enumerated()), id: \.offset) { _, tab in
                        if let id = tab["tabId"] as? Int { Text(routineTabLabel(tab)).tag(Int?.some(id)) }
                    }
                }
                Button("读取标签页") { selectedTab = nil; state.loadTabs(worker) }.disabled(!model.live || state.activeRun)
            }
            HStack {
                Text("只会在你选定的现有标签页运行。").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { if let tab = selectedTab { state.start(worker, routine: routine, tab: tab, params: params) } } label: { Label("运行流程", systemImage: "play.fill") }
                    .buttonStyle(.borderedProminent)
                    .disabled(selectedTab == nil || state.activeRun || !model.live || routine.parameters.contains { (params[$0["name"] ?? ""] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
            }
        }.padding(16).background(Color.secondary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
    }
    func recentActions(_ snapshot: RoutineSnapshotState, worker: ServerInfo) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("最近记录的操作").font(.headline)
            if snapshot.events.isEmpty {
                Text(snapshot.enabled == nil ? "记录状态尚未确认，请刷新后查看。" : snapshot.enabled == true ? "还没有记录到网页操作。连接的 AI 操作网页后，记录会显示在这里。" : "自动记录未开启。开启后，新操作会显示在这里。")
                    .foregroundStyle(.secondary)
            } else {
                Text("按记录顺序排列。选择起止步骤，保存中间的完整片段。").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Picker("从", selection: Binding(get: { rangeStart }, set: { rangeStart = $0; candidate = "" })) {
                        Text("选择起点").tag("")
                        ForEach(Array(snapshot.events.enumerated()), id: \.element.id) { index, event in Text("\(index + 1). " + event.label).tag(event.id) }
                    }
                    Picker("到", selection: Binding(get: { rangeEnd }, set: { rangeEnd = $0; candidate = "" })) {
                        Text("选择终点").tag("")
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
                                    Text(event.path + " · 标签 \(event.tab)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    if !event.replayable || !event.ok { Text("这一步不能保存为可运行流程").font(.caption).foregroundStyle(.orange) }
                                }
                                Spacer()
                                Text(Date(timeIntervalSince1970: event.at / 1000).formatted(date: .omitted, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                            }.padding(6).background(selectedEvents.contains(event.id) ? Color.accentColor.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }.frame(height: min(260, Double(snapshot.events.count) * 62))
            }
            if !snapshot.events.isEmpty || !candidate.isEmpty {
                if !selectedEvents.isEmpty { Text("已选择 \(selectedEvents.count) 个连续步骤").font(.caption).foregroundStyle(.secondary) }
                else if !rangeStart.isEmpty || !rangeEnd.isEmpty { Text("请选择同一网站、连接和标签页中可以回放的连续步骤。").font(.caption).foregroundStyle(.orange) }
                HStack {
                    TextField("给这个流程起个名字", text: $newName).textFieldStyle(.roundedBorder)
                    Button("保存流程") {
                        state.change(worker, payload: ["action": "save", "name": newName.trimmingCharacters(in: .whitespacesAndNewlines), "eventIds": selectedEvents], success: "流程已保存")
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
        let server = ServerInfo(id: 101, who: "Codex · 网站操作", color: 0, version: "synthetic", startedAt: 0,
            busy: nil, lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:], guiInstance: "routine-preview", node: "/synthetic/node")
        model.servers = [server]; model.routines.choose(server)
        let site = "https://courses.example"
        let steps: [[String: Any]] = [["tool": "click", "target": ["name": "课程搜索"]],
            ["tool": "type_text", "target": ["name": "搜索关键词"]], ["tool": "click", "target": ["name": "搜索"]]]
        let events: [[String: Any]] = steps.enumerated().reversed().map { index, step in
            ["id": "event-\(index)", "seq": index + 1, "at": 1_790_000_000_000.0 + Double(index) * 10_000,
             "sessionId": "preview", "tab": 7, "site": site, "tool": step["tool"]!, "target": step["target"]!,
             "before": ["origin": site, "path": "/catalog"], "ok": true, "replayable": true]
        }
        let recent = CommandLine.arguments.contains("--routine-recent")
        model.routines.snapshot = RoutineSnapshotState(["enabled": true,
            "sites": [["site": site, "count": 9, "lastAt": 1_790_000_000_000.0]], "events": events,
            "routines": recent ? [] : [["id": "routine-preview", "site": site, "name": "搜索课程", "description": "填写关键词，然后查看搜索结果。",
                "steps": steps, "parameters": [["name": "input_1", "label": "搜索关键词"]], "runCount": 4]],
            "candidates": [["id": "candidate", "site": site, "name": "课程搜索片段", "eventIds": ["event-0", "event-1", "event-2"], "steps": steps, "count": 3]]])
        if CommandLine.arguments.contains("--routine-running") {
            model.routines.runTitle = "搜索课程"
            model.routines.run = RoutineRunState(["runId": "preview-run", "status": "running", "completed": 1, "total": 3, "step": 2])
        }
    }
}
