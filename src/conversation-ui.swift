import SwiftUI
import AppKit

/// A live view of one explicitly bound AI thread. No rollout files or terminal scrollback.
struct ConversationState {
    let threadId: String, status: String, reason: String, threadStatus: String
    let canSend: Bool, sending: Bool
    let entries: [ConversationEntry]
    let pending: [[String: Any]]
    init(_ j: [String: Any]) {
        threadId = j["threadId"] as? String ?? ""
        status = j["status"] as? String ?? "unavailable"
        reason = j["reason"] as? String ?? ""
        threadStatus = j["threadStatus"] as? String ?? ""
        canSend = j["canSend"] as? Bool ?? false
        sending = j["sending"] as? Bool ?? false
        entries = (j["entries"] as? [[String: Any]] ?? []).compactMap { e in
            guard let id = e["id"] as? String, let text = e["text"] as? String else { return nil }
            return ConversationEntry(id: id, text: text)
        }
        pending = j["pending"] as? [[String: Any]] ?? []
    }
    var availability: String {
        if status == "connecting" { return "正在连接这个会话…" }
        if status == "disconnected" { return "会话连接已断开，草稿仍保留。" }
        if canSend { return threadStatus == "active" ? "回复会发送给这个正在进行的会话" : "回复会继续这个会话" }
        if !pending.isEmpty { return "这个会话正在等你回答下面的问题" }
        if reason == "upgrade_required" { return "这个连接还未启用会话中心，请更新连接后使用。可从 MyChrome 菜单的「全部重启」入口更新；直接回复仍取决于 AI 客户端支持。" }
        if reason == "unsupported_client" { return "这个客户端尚未接入实时文字和直接回复；网页接手仍可使用「去处理」。" }
        if reason == "unbound_thread" { return "这个连接尚未绑定到具体 AI 对话，暂时不能从这里回复。" }
        return "当前会话暂不能接收回复，草稿会留在这里。"
    }
    var feedPlaceholder: String {
        if reason == "unsupported_client" { return "这个客户端还没有提供实时文字流。需要你接手网页时，提示仍会显示在这里。" }
        if reason == "unbound_thread" { return "先关联一个对话，才能显示它的实时进展。" }
        if reason == "upgrade_required" { return "这个连接需要更新后，才能在这里显示对话。" }
        if status == "disconnected" { return "实时文字连接已断开，正在等待恢复。" }
        if status == "connecting" { return "正在连接实时进展…" }
        if status == "connected" { return "已连接。AI 接下来公开展示的进展会出现在这里。" }
        if reason == "thread_inactive" { return "这个对话当前没有实时文字流，后续连接恢复时会继续显示。" }
        if reason == "conversation_changed" { return "正在重新连接原来的对话进展。" }
        return "实时进展暂时不可用，连接恢复后会继续显示。"
    }
}
struct ConversationEntry: Identifiable { let id: String, text: String }

func managedConversationFailure(_ state: ConversationState?) -> String? {
    guard let state else { return nil }
    switch state.reason {
    case "turn_failed", "claude_turn_failed": return "本轮生成失败，已显示的内容和草稿仍保留。请重试。"
    case "claude_delivery_unconfirmed": return "尚未确认客户端是否收到消息。请先检查送达状态，草稿仍保留。"
    case "message_too_large": return "本轮内容超出显示限制，部分内容未能显示。"
    case "request_failed", "request_timeout": return "客户端请求未完成。请查看当前进展后重试，草稿仍保留。"
    default: return state.status == "error" ? "客户端发生错误。请检查客户端连接后重试，草稿仍保留。" : nil
    }
}
func canInterruptConversation(_ server: ServerInfo, state: ConversationState?, sending: Bool) -> Bool {
    guard server.managedSession, server.conversationStatus != "disconnected" else { return false }
    let current = state.flatMap { $0.threadId == server.conversationThread ? $0 : nil }
    return (current?.status ?? server.conversationStatus) == "connected" &&
        (sending || current?.sending == true || current?.threadStatus == "active")
}

/// Presentation uses verified state/receipt metadata, never the wording of an AI message.
struct ConversationPresentation {
    let kind: String, label: String, symbol: String, tone: String
}
func conversationPresentation(_ server: ServerInfo, task: AgentTask? = nil, state: ConversationState? = nil) -> ConversationPresentation {
    let current = state.flatMap { server.conversationThread == $0.threadId ? $0 : nil }
    // Presence can already report a lost connection while the last detail snapshot is still on screen.
    let status = ["disconnected", "connecting", "unavailable"].contains(server.conversationStatus ?? "")
        ? server.conversationStatus : current?.status ?? server.conversationStatus
    if task?.alert != nil {
        return ConversationPresentation(kind: "waiting", label: "需要你处理", symbol: "hand.raised.fill", tone: "orange")
    }
    if status == "disconnected" {
        return ConversationPresentation(kind: "disconnected", label: "连接已断开", symbol: "wifi.slash", tone: "gray")
    }
    if (current?.pending.count ?? server.conversationPending) > 0 {
        return ConversationPresentation(kind: "waiting", label: "等待你回复", symbol: "hand.raised.fill", tone: "orange")
    }
    if server.managedSession, managedConversationFailure(current) != nil {
        return ConversationPresentation(kind: "error", label: "本轮遇到问题", symbol: "exclamationmark.triangle.fill", tone: "red")
    }
    if server.busy != nil || (status == "connected" && current?.threadStatus == "active") {
        return ConversationPresentation(kind: "running", label: server.busy != nil ? "正在操作网页" : "正在运行", symbol: "arrow.triangle.2.circlepath", tone: "blue")
    }
    if status == "connecting" {
        return ConversationPresentation(kind: "connecting", label: "正在连接", symbol: "ellipsis.circle", tone: "gray")
    }
    if current?.reason == "unsupported_client" || (!server.managedSession && server.conversationProvider != nil && server.conversationProvider != "Codex") {
        return ConversationPresentation(kind: "unsupported", label: "暂不支持实时对话", symbol: "bubble.left.and.exclamationmark.bubble.right", tone: "gray")
    }
    if server.guiInstance == nil {
        return ConversationPresentation(kind: "upgrade", label: "需要更新连接", symbol: "arrow.up.circle", tone: "gray")
    }
    if server.conversationThread == nil {
        return ConversationPresentation(kind: "unbound", label: "尚未关联对话", symbol: "link", tone: "gray")
    }
    if status == "connected" {
        return ConversationPresentation(kind: current?.threadStatus == "idle" ? "idle" : "connected",
            label: current?.threadStatus == "idle" ? "当前空闲" : "已连接", symbol: "bubble.left", tone: "gray")
    }
    return ConversationPresentation(kind: "unavailable", label: "实时进展不可用", symbol: "wifi.slash", tone: "gray")
}
func conversationDeliveryPresentation(_ status: String) -> ConversationPresentation {
    switch status {
    case "sending": return ConversationPresentation(kind: status, label: "正在发送", symbol: "arrow.up.circle", tone: "blue")
    case "accepted": return ConversationPresentation(kind: status, label: "回复已送达", symbol: "checkmark.circle.fill", tone: "green")
    case "rejected": return ConversationPresentation(kind: status, label: "回复未被接收", symbol: "xmark.octagon.fill", tone: "red")
    case "resolved": return ConversationPresentation(kind: status, label: "问题已结束，回答送达未确认", symbol: "questionmark.circle", tone: "orange")
    case "not_sent": return ConversationPresentation(kind: status, label: "尚未发送", symbol: "exclamationmark.circle", tone: "orange")
    case "released": return ConversationPresentation(kind: status, label: "已解除发送等待", symbol: "info.circle", tone: "gray")
    default: return ConversationPresentation(kind: "unknown", label: "送达尚未确认", symbol: "questionmark.circle", tone: "orange")
    }
}
/// The same palette is used for conversation activity, questions and delivery receipts.
struct ConversationStatusLabel: View {
    let presentation: ConversationPresentation
    var text: String? = nil
    @Environment(\.colorScheme) private var colorScheme
    var tint: Color {
        let dark = colorScheme == .dark
        switch presentation.tone {
        case "orange": return dark ? Color(red: 0.97, green: 0.75, blue: 0.33) : Color(red: 0.60, green: 0.34, blue: 0)
        case "blue": return dark ? Color(red: 0.47, green: 0.72, blue: 1) : Color(red: 0.07, green: 0.38, blue: 0.68)
        case "green": return dark ? Color(red: 0.50, green: 0.85, blue: 0.58) : Color(red: 0.14, green: 0.44, blue: 0.23)
        case "red": return dark ? Color(red: 1, green: 0.55, blue: 0.51) : Color(red: 0.69, green: 0.18, blue: 0.18)
        default: return .secondary
        }
    }
    var body: some View {
        Label(text ?? presentation.label, systemImage: presentation.symbol)
            .foregroundStyle(tint).fixedSize(horizontal: false, vertical: true)
    }
}

func conversationKey(_ server: ServerInfo) -> String {
    "\(server.id):\(server.guiInstance ?? "legacy"):\(server.conversationThread ?? ""):\(server.conversationBinding ?? "")"
}
func hasPreviousBindingDraft(_ server: ServerInfo, drafts: [String: String]) -> Bool {
    guard let instance = server.guiInstance, let thread = server.conversationThread else { return false }
    let prefix = "\(server.id):\(instance):\(thread):"
    let current = conversationKey(server)
    return drafts.contains { key, text in key != current && key.hasPrefix(prefix) && !text.isEmpty }
}
// Display names never determine reply routing; conversationKey retains the exact connection identity.
func conversationName(_ server: ServerInfo, task: AgentTask? = nil) -> String {
    for value in [server.conversationTitle, task?.task] {
        if let text = value?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return text }
    }
    return server.conversationThread == nil ? "尚未关联对话" : "未命名对话"
}
func conversationClient(_ server: ServerInfo) -> String {
    if let provider = server.conversationProvider, !provider.isEmpty { return provider }
    return server.who.components(separatedBy: " · ").first ?? "AI"
}
func conversationIsVisible(_ server: ServerInfo, task: AgentTask? = nil, hasActiveContext: Bool = false) -> Bool {
    hasActiveContext || server.conversationThread != nil || server.busy != nil || server.conversationPending > 0 || task?.alert != nil ||
        !(task?.task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
}
func questionKey(_ value: Any?) -> String {
    if let text = value as? String { return "string:" + text }
    if let number = value as? NSNumber { return "number:" + number.stringValue }
    return "invalid"
}

/// Run only our own local IPC client; reply contents go through stdin, never through a shell or argv.
func callConversation(_ server: ServerInfo, request: [String: Any], done: @escaping ([String: Any]) -> Void) {
    guard let node = server.node, node.hasPrefix("/"), let instance = server.guiInstance,
          let data = try? JSONSerialization.data(withJSONObject: request) else {
        done(["ok": false, "code": "unavailable"]); return
    }
    DispatchQueue.global(qos: .userInitiated).async {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [ROOT_DIR + "/src/gui-client.js", String(server.id), instance]
        let input = Pipe(), output = Pipe()
        p.standardInput = input
        p.standardOutput = output
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            input.fileHandleForWriting.write(data)
            try? input.fileHandleForWriting.close()
            let response = output.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let j = (try? JSONSerialization.jsonObject(with: response)) as? [String: Any]
                ?? ["ok": false, "code": "connection_lost"]
            DispatchQueue.main.async { done(j) }
        } catch { DispatchQueue.main.async { done(["ok": false, "code": "unavailable"]) } }
    }
}

extension Model {
    var chosenServer: ServerInfo? { servers.first { $0.id == selectedConversation } }
    func seedCreatedSessionDraft(_ server: ServerInfo, prompt: String) -> Bool {
        let key = conversationKey(server)
        guard initializedNewConversations.insert(key).inserted else { return false }
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        drafts[key] = prompt
        return true
    }
    func namedConversations(_ values: [ServerInfo]) -> [ServerInfo] {
        values.map { server in
            var copy = server
            if server.managedSession, let title = localConversationTitles[conversationKey(server)] { copy.conversationTitle = title }
            return copy
        }
    }
    func rememberConversationTitle(_ server: ServerInfo, text: String) {
        let key = conversationKey(server)
        guard server.managedSession, localConversationTitles[key] == nil else { return }
        let words = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !words.isEmpty else { return }
        localConversationTitles[key] = String(words.prefix(48)) + (words.count > 48 ? "…" : "")
        servers = namedConversations(servers)
    }
    func selectConversation(_ server: ServerInfo) {
        guard selectedConversation != server.id else { return }
        selectedConversation = server.id
        conversation = nil
        loadedConversationKey = nil
        refreshConversation()
    }
    func discoverConversation(_ server: ServerInfo) {
        let key = conversationKey(server)
        guard !associating.contains(key) else { return }
        associating.insert(key); associationNotes[key] = "正在读取当前宿主的会话…"
        callConversation(server, request: ["op": "discover"]) { [weak self] response in
            guard let self else { return }
            self.associating.remove(key)
            if let rows = response["conversations"] as? [[String: Any]], response["ok"] as? Bool == true {
                self.availableConversations[key] = rows
                self.associationNotes[key] = rows.isEmpty ? "当前宿主没有可关联的已加载会话。" : "选择要在这里回复的对话"
            } else {
                self.associationNotes[key] = "当前连接未提供可关联的会话。请在支持的 Codex 宿主中使用。"
            }
        }
    }
    func bindConversation(_ server: ServerInfo, thread: String) {
        let key = conversationKey(server)
        guard !associating.contains(key) else { return }
        associating.insert(key); associationNotes[key] = "正在关联…"
        callConversation(server, request: ["op": "bind", "payload": ["threadId": thread]]) { [weak self] response in
            guard let self else { return }
            self.associating.remove(key)
            self.availableConversations.removeValue(forKey: key)
            self.associationNotes[key] = response["ok"] as? Bool == true ? "已关联，正在刷新…" : "这个对话已变化，请重新选择。"
            self.loadedConversationKey = nil
            self.refreshPanelData()
            self.refreshConversation()
        }
    }
    func refreshConversation() {
        guard live, conversationVisible, !conversationReading, let server = chosenServer else { return }
        guard server.guiInstance != nil else {
            conversation = ConversationState(["reason": "upgrade_required"])
            loadedConversationKey = conversationKey(server)
            return
        }
        conversationReading = true
        let key = conversationKey(server)
        callConversation(server, request: ["op": "snapshot"]) { [weak self] result in
            guard let self else { return }
            self.conversationReading = false
            guard self.chosenServer.map(conversationKey) == key else { self.refreshConversation(); return }
            if let snapshot = result["snapshot"] as? [String: Any], result["ok"] as? Bool == true {
                guard snapshot["bindingId"] as? String == server.conversationBinding,
                      snapshot["threadId"] as? String == server.conversationThread else {
                    self.conversation = nil; self.loadedConversationKey = nil; return
                }
                self.conversation = ConversationState(snapshot)
            } else {
                self.conversation = ConversationState(["status": "disconnected"])
            }
            self.loadedConversationKey = key
        }
    }
    func sendConversation(_ server: ServerInfo, answers: [String: Any]? = nil, requestId: Any? = nil, checkOnly: Bool = false) {
        let key = conversationKey(server)
        guard live, !sendingTo.contains(key) else { return }
        guard unconfirmedSends[key] == nil || checkOnly else { return }
        let text = drafts[key] ?? ""
        guard checkOnly || answers != nil || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var payload: [String: Any]
        if checkOnly {
            guard let pending = unconfirmedSends[key] else { return }
            payload = pending
        } else {
            guard let binding = server.conversationBinding, let thread = server.conversationThread else { return }
            payload = ["nonce": UUID().uuidString, "bindingId": binding, "threadId": thread]
            if let answers { payload["answers"] = answers; payload["requestId"] = requestId }
            else { payload["text"] = text; generationNotes.removeValue(forKey: key) }
        }
        unconfirmedSends[key] = payload
        sendingTo.insert(key)
        deliveryNotes[key] = "正在发送…"
        deliveryStates[key] = "sending"
        callConversation(server, request: ["op": checkOnly ? "delivery" : "send", "payload": payload]) { [weak self] response in
            guard let self else { return }
            self.sendingTo.remove(key)
            let result = response["result"] as? [String: Any] ?? [:]
            let status = result["status"] as? String ?? ""
            if status == "accepted" {
                self.deliveryStates[key] = "accepted"
                self.deliveryNotes[key] = "已送达这个会话"
                if let sentText = payload["text"] as? String {
                    self.rememberConversationTitle(server, text: sentText)
                    if self.drafts[key] == sentText { self.drafts[key] = "" }
                }
                self.unconfirmedSends.removeValue(forKey: key)
            } else if status == "resolved" {
                self.deliveryStates[key] = "resolved"
                self.deliveryNotes[key] = "这个问题已结束；无法确认是否采用了本次回答。"
                self.unconfirmedSends.removeValue(forKey: key)
            } else if status == "rejected" || response["delivery"] as? String == "rejected" {
                self.deliveryStates[key] = "rejected"
                self.deliveryNotes[key] = "会话没有接收这条回复，内容已保留。"
                self.unconfirmedSends.removeValue(forKey: key)
            } else if response["delivery"] as? String == "not_sent" {
                self.deliveryStates[key] = "not_sent"
                self.deliveryNotes[key] = "尚未发送：会话状态已变化，内容已保留。"
                self.unconfirmedSends.removeValue(forKey: key)
            } else {
                self.deliveryStates[key] = "unknown"
                self.deliveryNotes[key] = "尚未确认送达，请先查看会话状态；内容已保留，不会自动重发。"
            }
            self.refreshConversation()
        }
    }
    func interruptConversation(_ server: ServerInfo) {
        let key = conversationKey(server)
        guard live, server.managedSession, !interruptingConversations.contains(key) else { return }
        interruptingConversations.insert(key); generationNotes[key] = "正在请求停止生成…"
        callConversation(server, request: ["op": "interrupt"]) { [weak self] response in
            guard let self else { return }
            self.interruptingConversations.remove(key)
            self.generationNotes[key] = response["ok"] as? Bool == true
                ? "已请求停止生成" : "停止请求未能确认，请查看最新进展后重试。"
            self.refreshConversation()
        }
    }
    func refreshGotoResults() {
        for (pid, pending) in gotoPending {
            if let r = readJSON(BASE + "/goto-result-\(pid).json"),
               r["id"] as? String == pending.id,
               r["sessionGeneration"] as? String == pending.generation || r["reason"] as? String == "session_changed" {
                gotoNotes[pid] = r["message"] as? String ?? "正在定位页面…"
                if r["status"] as? String != "queued" { gotoPending.removeValue(forKey: pid) }
            } else if nowMs() - pending.at > 20_000 {
                gotoNotes[pid] = "未收到跳转结果；请检查这个会话是否仍在等待。"
                gotoPending.removeValue(forKey: pid)
            }
        }
    }
}

struct MyChromeWorkspace: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 18) {
                Label("MyChrome", systemImage: "bubble.left.and.bubble.right").font(.headline)
                Button { model.showNewSession() } label: { Label("新对话", systemImage: "plus.bubble") }
                    .buttonStyle(.borderedProminent).keyboardShortcut("n", modifiers: .command).help("新对话（⌘N）")
                Spacer()
                Picker("页面", selection: $model.workspaceDestination) {
                    Text("对话").tag("conversations")
                    Text("操作设置").tag("settings")
                    Text("网站流程").tag("routines")
                }.pickerStyle(.segmented).labelsHidden().frame(width: 310)
                Spacer()
                Button {
                    model.set("paused", !model.settings.paused)
                } label: {
                    Label(model.settings.paused ? "继续 AI 操作" : "暂停 AI 操作",
                          systemImage: model.settings.paused ? "play.fill" : "pause.fill")
                }.buttonStyle(.bordered)
                Button { model.openOnboarding?() } label: {
                    Image(systemName: "questionmark.circle")
                }.buttonStyle(.plain).help(onboardingText("入门引导", "Getting started"))
                    .accessibilityLabel(onboardingText("入门引导", "Getting started"))
            }.padding(.horizontal, 20).padding(.vertical, 12)
            if let error = model.settingsError {
                Text(error).font(.callout).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.bottom, 10)
            }
            Divider()
            if model.workspaceDestination == "settings" {
                OperationSettings(model: model)
            } else if model.workspaceDestination == "routines" {
                RoutineCenter(model: model)
            } else {
                ConversationCenter(model: model)
            }
        }.frame(minWidth: 840, minHeight: 580)
            .background(Color(nsColor: .windowBackgroundColor))
            .sheet(isPresented: $model.newSessionPresented) { NewSessionSheet(state: model.newSession, model: model) }
    }
}

struct OperationSettings: View {
    @ObservedObject var model: Model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("操作设置").font(.system(size: 25, weight: .semibold))
                    Text("按你的习惯操作浏览器。更改会应用到后续操作。")
                        .font(.callout).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 18) {
                    Label("文字输入", systemImage: "keyboard").font(.headline)
                    let lock = model.lockedValue("inputMode")
                    let mode = lock?.value as? String ?? model.settings.inputMode
                    Picker("输入方式", selection: Binding(get: { mode }, set: { model.set("inputMode", $0) })) {
                        Text("跟随任务").tag("auto")
                        Text("逐字键盘输入").tag("keys")
                        Text("直接粘贴").tag("paste")
                    }.pickerStyle(.segmented).labelsHidden().disabled(lock != nil)
                    Text(mode == "auto" ? "由 AI 按任务选择；未指定时使用逐字键盘输入。" : mode == "keys" ? "依次按下键盘，适用于英文与常用符号。输入中文时请选择直接粘贴。" : "一次粘贴整段文字，适用于中文和较长内容。")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if let lock {
                        Text("\(lock.who) 的客户端配置固定了输入方式。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    let lock = model.lockedValue("inputSpeed")
                    let speed = lock.flatMap { jsonNum($0.value) } ?? model.settings.inputSpeed
                    HStack {
                        Label("操作速度", systemImage: "speedometer").font(.headline)
                        Spacer()
                        Text(speed.formatted() + "×").font(.title3.monospacedDigit().weight(.semibold))
                    }
                    Picker("操作速度", selection: Binding(get: { speed }, set: { model.set("inputSpeed", $0) })) {
                        ForEach(Settings.inputSpeeds, id: \.self) { value in
                            Text(value.formatted() + "×").tag(value)
                        }
                    }.pickerStyle(.segmented).labelsHidden().disabled(lock != nil)
                    Text("0.5× 更慢 · 1× 标准节奏 · 3× 更快").font(.caption).foregroundStyle(.secondary)
                    Text(lock == nil ? "调整按键、鼠标和滚动的节奏。接管时也可用 ↑ / ↓ 调整。" : "调整按键、鼠标和滚动的节奏。")
                        .font(.callout).foregroundStyle(.secondary)
                    if let lock {
                        Text("\(lock.who) 的客户端配置固定了操作速度。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    Label("浏览器窗口", systemImage: "macwindow").font(.headline)
                    let lock = model.lockedValue("agentDisplay")
                    let display = lock?.value as? String ?? model.settings.agentDisplay
                    Picker("AI 窗口位置", selection: Binding(get: { display }, set: { model.set("agentDisplay", $0) })) {
                        Text("自动选择").tag("away")
                        Text("副屏").tag("secondary")
                        Text("主屏").tag("main")
                        Text("沿用当前窗口").tag("off")
                    }.disabled(lock != nil)
                    let notifyLock = model.lockedValue("notify")
                    Toggle("需要我处理时通知我", isOn: Binding(
                        get: { notifyLock.flatMap { jsonBool($0.value) } ?? model.settings.notify },
                        set: { model.set("notify", $0) })).disabled(notifyLock != nil)
                }
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    Label("我的操作习惯", systemImage: "hand.draw").font(.headline)
                    Text("学习你的键鼠节奏，用于逐字输入与移动。这是节奏采样，不是视频录屏。")
                        .font(.callout).foregroundStyle(.secondary)
                    if let until = model.recordingUntil {
                        Text("正在采样 · 还剩 " + clockText(max(0, until - model.now)))
                            .font(.callout.monospacedDigit())
                        ProgressView(value: min(1, max(0, 1 - (until - model.now) / (RECORD_SECONDS * 1000))))
                        Button("取消采样，不保存") { model.cancelRecording() }
                    } else if let habits = model.habits {
                        Toggle("使用我的操作习惯", isOn: Binding(get: { habits.use }, set: { model.setUse($0) }))
                        Text("采样于 " + dateText(habits.recordedAt)).font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("重新采样 3 分钟") { model.startRecording() }.disabled(model.habitsOff)
                            Spacer()
                            Button(model.confirmDelete ? "再次点击确认删除" : "删除习惯数据", role: .destructive) { model.deleteHabits() }
                        }
                    } else {
                        HStack {
                            Text("还没有习惯数据").foregroundStyle(.secondary)
                            Spacer()
                            Button("采样 3 分钟") { model.startRecording() }
                                .buttonStyle(.bordered).disabled(model.habitsOff)
                        }
                    }
                    if let error = model.recordError { Text(error).font(.caption).foregroundStyle(.orange) }
                    if model.habitsOff { Text("客户端配置已关闭习惯采样。").font(.caption).foregroundStyle(.secondary) }
                }
            }.frame(maxWidth: 620, alignment: .leading).padding(32)
                .frame(maxWidth: .infinity, alignment: .top)
        }
    }
}

struct ConversationCenter: View {
    @ObservedObject var model: Model
    @State private var showDrafts = false
    @State private var showOtherConnections = false
    @State private var query = ""
    var ordered: [ServerInfo] {
        model.servers.sorted { a, b in
            let aw = a.conversationPending > 0 || model.tasks.contains { $0.id == a.id && $0.alert != nil }
            let bw = b.conversationPending > 0 || model.tasks.contains { $0.id == b.id && $0.alert != nil }
            if aw != bw { return aw }
            return a.startedAt == b.startedAt ? a.id < b.id : a.startedAt < b.startedAt
        }
    }
    func isVisible(_ server: ServerInfo) -> Bool {
        let key = conversationKey(server)
        let active = server.id == model.selectedConversation || !(model.drafts[key] ?? "").isEmpty ||
            model.sendingTo.contains(key) || model.unconfirmedSends[key] != nil ||
            model.answerDrafts.keys.contains { $0.hasPrefix(key + ":") }
        return conversationIsVisible(server, task: model.tasks.first { $0.id == server.id }, hasActiveContext: active)
    }
    var conversations: [ServerInfo] {
        ordered.filter { isVisible($0) && matches($0) }
    }
    var otherConnections: [ServerInfo] {
        ordered.filter { !isVisible($0) && matches($0) }
    }
    func matches(_ server: ServerInfo) -> Bool {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty || (conversationName(server, task: model.tasks.first { $0.id == server.id }) + " " + conversationClient(server)).localizedCaseInsensitiveContains(text)
    }
    var canAssociate: ServerInfo? {
        otherConnections.first { !$0.managedSession && $0.guiInstance != nil && $0.conversationProvider == "Codex" }
    }
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("搜索对话", text: $query).textFieldStyle(.plain)
                }.padding(9).background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 7))
                    .padding(.horizontal, 14).padding(.top, 16)
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(conversations) { server in
                            Button { model.selectConversation(server) } label: {
                                conversationRow(server)
                            }.buttonStyle(.plain)
                        }
                        if conversations.isEmpty {
                            Text(query.isEmpty ? "关联 AI 对话后，\n这里会显示它的真实标题。" : "没有匹配的对话")
                                .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }
                        if let server = canAssociate {
                            Button {
                                showOtherConnections = true
                                model.selectConversation(server)
                                model.discoverConversation(server)
                            } label: { Label("关联已有对话", systemImage: "link") }
                                .buttonStyle(.plain).foregroundStyle(Color.accentColor)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }
                        if !otherConnections.isEmpty {
                            Divider().padding(.vertical, 8)
                            Button { showOtherConnections.toggle() } label: {
                                HStack {
                                    Image(systemName: showOtherConnections ? "chevron.down" : "chevron.right").font(.caption2)
                                    Text("未关联的连接（\(otherConnections.count)）")
                                    Spacer()
                                }.font(.caption).foregroundStyle(.secondary).padding(10).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            if showOtherConnections {
                                ForEach(otherConnections) { server in
                                    Button { model.selectConversation(server) } label: { conversationRow(server) }.buttonStyle(.plain)
                                }
                            }
                        }
                    }.padding(.horizontal, 10)
                }
                Button("保留的草稿") { showDrafts = true }.buttonStyle(.plain).font(.caption).padding(.horizontal, 18).padding(.bottom, 16)
            }.frame(width: 260).background(Color(nsColor: .controlBackgroundColor))
            Divider()
            if let server = model.chosenServer {
                detail(server).id(conversationKey(server))
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 38)).foregroundStyle(.secondary)
                    Text(model.servers.isEmpty ? "开始你的第一个对话" : "选择一个会话").font(.title2.bold())
                    Text("新建 Codex 或 Claude Code 对话，直接在这里聊天。\n已有连接会显示在左侧，也可以关联原来的 AI 对话。")
                        .multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button { model.showNewSession() } label: { Label("新对话", systemImage: "plus.bubble") }
                        .buttonStyle(.borderedProminent)
                    Button(onboardingText("打开入门引导", "Open getting started")) { model.openOnboarding?() }
                        .buttonStyle(.borderedProminent)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.frame(minWidth: 760, minHeight: 540).background(Color(nsColor: .windowBackgroundColor))
            .sheet(isPresented: $showDrafts) { ConversationDrafts(model: model, close: { showDrafts = false }) }
    }
    func conversationRow(_ server: ServerInfo) -> some View {
        let task = model.tasks.first { $0.id == server.id }
        let state = model.loadedConversationKey == conversationKey(server) ? model.conversation : nil
        let presentation = conversationPresentation(server, task: task, state: state)
        let selected = server.id == model.selectedConversation
        let name = conversationName(server, task: task)
        let duplicate = ordered.contains { other in
            other.id != server.id && conversationClient(other) == conversationClient(server) &&
                conversationName(other, task: model.tasks.first { $0.id == other.id }) == name
        }
        return VStack(alignment: .leading, spacing: 7) {
            HStack {
                Image(systemName: "bubble.left").font(.caption).foregroundStyle(.secondary)
                Text(name).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                Spacer(minLength: 0)
            }
            HStack {
                Text(conversationClient(server)).foregroundStyle(.secondary)
                Text("·").foregroundStyle(.tertiary)
                ConversationStatusLabel(presentation: presentation)
                Spacer()
            }.font(.caption2)
            if duplicate {
                Text("连接于 " + Date(timeIntervalSince1970: server.startedAt / 1000).formatted(date: .omitted, time: .standard))
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 9).fill(selected ? Color.accentColor.opacity(0.12) : .clear))
            .contentShape(Rectangle())
            .help(server.who + " · 连接 \(server.id)" + (server.conversationThread.map { " · " + $0 } ?? ""))
    }
    func detail(_ server: ServerInfo) -> some View {
        let key = conversationKey(server)
        let state = model.loadedConversationKey == key ? model.conversation : nil
        let task = model.tasks.first { $0.id == server.id }
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top) {
                    Text(conversationName(server, task: task)).font(.title2.bold()).textSelection(.enabled)
                    Spacer()
                    if !server.managedSession && server.guiInstance != nil && server.conversationProvider == "Codex" {
                        Button(server.conversationThread == nil ? "关联对话" : "更换对话") { model.discoverConversation(server) }
                            .disabled(model.associating.contains(key) || model.sendingTo.contains(key))
                    }
                }
                HStack(spacing: 12) {
                    Text(conversationClient(server)).foregroundStyle(.secondary)
                        .help(server.who + " · 连接 \(server.id)")
                    ConversationStatusLabel(presentation: conversationPresentation(server, task: task, state: state))
                    Spacer()
                    if server.managedSession {
                        Button(model.interruptingConversations.contains(key) ? "正在停止…" : "停止生成") { model.interruptConversation(server) }
                            .disabled(!canInterruptConversation(server, state: state, sending: model.sendingTo.contains(key)) || model.interruptingConversations.contains(key))
                    }
                }.font(.caption)
                if server.managedSession {
                    HStack(spacing: 12) {
                        Text(server.model.map { "模型：" + $0 } ?? "模型信息待确认")
                        Text(server.effort.map { "思考强度：" + sessionEffortName($0) } ?? "思考强度：未提供")
                    }.font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    if let directory = server.cwd {
                        Label(sessionDirectoryName(directory), systemImage: "folder").font(.caption).foregroundStyle(.secondary)
                            .help(sessionDirectoryPath(directory))
                    }
                    if let note = model.generationNotes[key] { Text(note).font(.caption).foregroundStyle(.secondary) }
                    if let failure = managedConversationFailure(state) {
                        Label(failure, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let note = model.associationNotes[key] { Text(note).font(.caption).foregroundStyle(.secondary) }
                if let choices = model.availableConversations[key], !choices.isEmpty {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
                                if let id = choice["threadId"] as? String {
                                    Button { model.bindConversation(server, thread: id) } label: {
                                        HStack {
                                            Text(choice["title"] as? String ?? "未命名").lineLimit(2)
                                            Spacer()
                                            Text(String(id.suffix(8))).font(.caption).foregroundStyle(.secondary)
                                        }.frame(maxWidth: .infinity, alignment: .leading).padding(7)
                                    }.buttonStyle(.bordered).disabled(model.associating.contains(key))
                                }
                            }
                        }
                    }.frame(maxHeight: 160)
                }
            }.padding(22)
            Divider()
            if let task, let alert = task.alert {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        ConversationStatusLabel(presentation: conversationPresentation(server, task: task, state: state)).font(.caption.bold())
                        Text(alert).font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                        if let note = model.gotoNotes[task.id] { Text(note).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength: 6)
                    if task.alertTab != nil {
                        Button { model.gotoAlert(task) } label: { Label("去处理", systemImage: "arrow.up.forward.app") }
                            .disabled(model.gotoPending[task.id] != nil)
                    }
                }.padding(16).background(Color.orange.opacity(0.08))
            }
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let state, !state.entries.isEmpty {
                            ForEach(state.entries) { entry in
                                Text(entry.text).font(.system(size: 14)).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        } else {
                            Text(state?.feedPlaceholder ?? "正在连接实时进展…")
                                .font(.system(size: 13)).foregroundStyle(.secondary)
                        }
                        if let state {
                            ForEach(Array(state.pending.enumerated()), id: \.offset) { _, pending in
                                ConversationQuestion(model: model, server: server, pending: pending)
                                    .id(questionKey(pending["requestId"]))
                            }
                        }
                        PreviousAnswers(model: model, server: server, current: state?.pending ?? [])
                        Color.clear.frame(height: 1).id("latest")
                    }.padding(22)
                }.onChange(of: state?.entries.last?.text) { _ in
                    scroll.scrollTo("latest", anchor: .bottom)
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 9) {
                if hasPreviousBindingDraft(server, drafts: model.drafts) {
                    Button("连接已更新，查看之前保留的草稿") { showDrafts = true }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(Color.accentColor)
                }
                Text(state?.availability ?? "正在连接这个会话…").font(.caption).foregroundStyle(.secondary)
                TextEditor(text: Binding(get: { model.drafts[key] ?? "" }, set: {
                    model.drafts[key] = $0
                    model.draftTitles[key] = conversationName(server, task: task) + " · " + conversationClient(server) + " · " +
                        Date(timeIntervalSince1970: server.startedAt / 1000).formatted(date: .abbreviated, time: .standard)
                }))
                    .font(.system(size: 14)).frame(minHeight: 65, maxHeight: 115)
                    .padding(6).background(Color(nsColor: .textBackgroundColor))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.22)))
                    .accessibilityLabel("回复给 \(conversationName(server, task: task))")
                HStack {
                    if let note = model.deliveryNotes[key] {
                        ConversationStatusLabel(presentation: conversationDeliveryPresentation(model.deliveryStates[key] ?? "unknown"), text: note).font(.caption)
                    } else {
                        Text("⌘ Return 发送 · Return 换行").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.unconfirmedSends[key] != nil {
                        Button("检查送达状态") { model.sendConversation(server, checkOnly: true) }
                            .disabled(model.sendingTo.contains(key))
                    }
                    Button(model.sendingTo.contains(key) ? "正在发送…" : "发送回复") { model.sendConversation(server) }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(state?.canSend != true || model.sendingTo.contains(key) || model.unconfirmedSends[key] != nil || (model.drafts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if model.unconfirmedSends[key] != nil && !model.sendingTo.contains(key) {
                    Button("我已在原会话核对，继续输入新回复") {
                        model.unconfirmedSends.removeValue(forKey: key)
                        model.deliveryNotes[key] = "已解除发送等待；旧内容仍在草稿中。"
                        model.deliveryStates[key] = "released"
                    }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                }
            }.padding(18)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ConversationDrafts: View {
    @ObservedObject var model: Model
    let close: () -> Void
    var keys: [String] { model.drafts.keys.filter { !(model.drafts[$0] ?? "").isEmpty }.sorted() }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("保留的草稿").font(.title2.bold()); Spacer(); Button("完成", action: close) }
            Text("草稿只保留到退出 MyChrome。连接变化后，旧内容会留在这里，不会自动发给新会话。")
                .font(.caption).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if keys.isEmpty && model.answerDrafts.isEmpty { Text("还没有草稿").foregroundStyle(.secondary) }
                    ForEach(keys, id: \.self) { key in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(model.draftTitles[key] ?? "此前会话").font(.headline).help(key)
                            Text(model.drafts[key] ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            HStack {
                                if let selected = model.chosenServer {
                                    Button("追加到「\(conversationName(selected, task: model.tasks.first { $0.id == selected.id }))」的草稿") {
                                        let target = conversationKey(selected)
                                        let sourceText = model.drafts[key] ?? ""
                                        let existing = model.drafts[target] ?? ""
                                        if existing != sourceText {
                                            model.drafts[target] = existing.isEmpty ? sourceText : existing + "\n\n" + sourceText
                                        }
                                        close()
                                    }.help(conversationKey(selected))
                                }
                                Button("删除") { model.drafts.removeValue(forKey: key) }
                            }.font(.caption)
                        }.padding(14).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                    }
                    ForEach(model.answerDrafts.keys.sorted(), id: \.self) { key in
                        DisclosureGroup("此前问题的回答草稿") {
                            ForEach(Array((model.answerQuestions[key] ?? []).enumerated()), id: \.offset) { _, q in
                                Text(q["question"] as? String ?? "").font(.caption.bold())
                                if q["isSecret"] as? Bool == true { Text("私密回答已隐藏").font(.caption) }
                                else { Text(model.answerDrafts[key]?[q["id"] as? String ?? ""] ?? "").textSelection(.enabled) }
                            }
                            Button("删除") { model.answerDrafts.removeValue(forKey: key); model.answerQuestions.removeValue(forKey: key) }
                        }
                    }
                }
            }
        }.padding(24).frame(width: 600, height: 480)
    }
}

struct ConversationQuestion: View {
    @ObservedObject var model: Model
    let server: ServerInfo
    let pending: [String: Any]
    var draftKey: String { conversationKey(server) + ":question:" + questionKey(pending["requestId"]) }
    var answers: [String: String] { model.answerDrafts[draftKey] ?? [:] }
    func setAnswer(_ id: String, _ value: String) { model.answerDrafts[draftKey, default: [:]][id] = value }
    var questions: [[String: Any]] { pending["questions"] as? [[String: Any]] ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ConversationStatusLabel(presentation: ConversationPresentation(kind: "waiting", label: "AI 在等你回答", symbol: "hand.raised.fill", tone: "orange")).font(.headline)
            ForEach(Array(questions.enumerated()), id: \.offset) { i, q in
                let id = q["id"] as? String ?? String(i)
                VStack(alignment: .leading, spacing: 8) {
                    Text(q["question"] as? String ?? "").font(.system(size: 14, weight: .medium))
                    if let options = q["options"] as? [[String: Any]] {
                        ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                            let label = option["label"] as? String ?? ""
                            Button { setAnswer(id, label) } label: {
                                HStack(alignment: .top) {
                                    Image(systemName: answers[id] == label ? "largecircle.fill.circle" : "circle")
                                    VStack(alignment: .leading) {
                                        Text(label)
                                        if let description = option["description"] as? String {
                                            Text(description).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }.buttonStyle(.plain)
                        }
                    }
                    if q["isSecret"] as? Bool == true {
                        SecureField("在这里回答", text: Binding(get: { answers[id] ?? "" }, set: { setAnswer(id, $0) })).textFieldStyle(.roundedBorder)
                    } else {
                        TextField("在这里回答", text: Binding(get: { answers[id] ?? "" }, set: { setAnswer(id, $0) })).textFieldStyle(.roundedBorder)
                    }
                }
            }
            Button("提交回答") {
                model.sendConversation(server, answers: answers.mapValues { ["answers": [$0]] }, requestId: pending["requestId"])
            }.buttonStyle(.borderedProminent)
                .disabled(questions.isEmpty || questions.contains { (answers[$0["id"] as? String ?? ""] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } || model.sendingTo.contains(conversationKey(server)) || model.unconfirmedSends[conversationKey(server)] != nil)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Color.orange.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .onAppear { model.answerQuestions[draftKey] = questions }
    }
}

struct PreviousAnswers: View {
    @ObservedObject var model: Model
    let server: ServerInfo
    let current: [[String: Any]]
    var keys: [String] {
        let prefix = conversationKey(server) + ":question:"
        let active = Set(current.map { prefix + questionKey($0["requestId"]) })
        return model.answerDrafts.keys.filter { $0.hasPrefix(prefix) && !active.contains($0) }.sorted()
    }
    var body: some View {
        ForEach(keys, id: \.self) { key in
            DisclosureGroup("此前问题的回答草稿") {
                VStack(alignment: .leading, spacing: 9) {
                    Text("该问题已结束，草稿不会再次发送。").font(.caption).foregroundStyle(.secondary)
                    ForEach(Array((model.answerQuestions[key] ?? []).enumerated()), id: \.offset) { _, q in
                        Text(q["question"] as? String ?? "").font(.caption.bold())
                        if q["isSecret"] as? Bool == true {
                            Text("私密回答已隐藏").font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text(model.answerDrafts[key]?[q["id"] as? String ?? ""] ?? "")
                                .textSelection(.enabled).font(.system(size: 13))
                        }
                    }
                    Button("删除这份草稿") {
                        model.answerDrafts.removeValue(forKey: key)
                        model.answerQuestions.removeValue(forKey: key)
                    }.font(.caption)
                }.padding(.vertical, 8)
            }.font(.system(size: 12))
        }
    }
}

/// A clickable, non-activating prompt. It never switches apps until the user chooses an action.
final class HandoffToast: NSPanel {
    init(model: Model, task: AgentTask, open: @escaping () -> Void) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 370, height: 150), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .floating
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        sharingType = .none
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        contentView = NSHostingView(rootView: HandoffToastView(model: model, task: task, open: open, dismiss: { [weak self] in self?.orderOut(nil) }))
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main {
            setFrameOrigin(NSPoint(x: screen.visibleFrame.maxX - 390, y: screen.visibleFrame.maxY - 180))
        }
    }
}
struct HandoffToastView: View {
    @ObservedObject var model: Model
    let task: AgentTask
    let open: () -> Void
    let dismiss: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text(task.who + " 需要你").font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Spacer()
                Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("稍后处理")
            }
            Button(action: open) {
                Text(model.gotoNotes[task.id] ?? task.alert ?? task.task).font(.system(size: 13)).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain)
            HStack {
                Button("查看会话", action: open)
                Spacer()
                if task.alertTab != nil {
                    Button("去处理") { model.gotoAlert(task) }.buttonStyle(.borderedProminent)
                        .disabled(model.gotoPending[task.id] != nil)
                }
            }
        }.padding(16).frame(width: 370, height: 150).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

enum ConversationSnapshot {
    static func write(_ path: String) {
        let model = Model(live: false)
        model.servers = [
            ServerInfo(id: 101, who: "Codex · 主目录", color: 0, version: "0.10.3", startedAt: nowMs(), busy: "wait_for_user", lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:], guiInstance: "demo", conversationThread: "demo-exam", conversationTitle: "完成一套 IELTS 阅读试卷", conversationProvider: "Codex", conversationStatus: "connected"),
            ServerInfo(id: 102, who: "Codex · 主目录", color: 3, version: "0.10.3", startedAt: nowMs(), busy: "read_page", lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:], guiInstance: "demo-2", conversationThread: "demo-review", conversationTitle: "检查模考记录与得分", conversationProvider: "Codex", conversationStatus: "connected")
        ]
        model.servers += (103...114).map { id in
            ServerInfo(id: Int32(id), who: "Claude · 主目录", color: 3, version: "0.10.0", startedAt: nowMs(), busy: nil, lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:])
        }
        model.tasks = [AgentTask(id: 101, who: "Codex · 模考体验", task: "完成一套阅读试卷", stepName: "", current: nil, total: nil, color: 0, etaMs: nil, etaAt: nil,
            alert: "需要你登录练习网站。登录完成后，我会继续作答。", alertTab: 10)]
        model.selectedConversation = 101
        model.loadedConversationKey = conversationKey(model.servers[0])
        model.conversation = ConversationState(["threadId": "demo-exam", "status": "connected", "canSend": true, "threadStatus": "active",
            "entries": [["id": "a", "text": "已经打开试卷，正在确认题目数量和作答方式。"], ["id": "b", "text": "页面要求先登录。我已交还鼠标和键盘，点击上方「去处理」即可回到需要你的页面。"]]])
        model.workspaceDestination = CommandLine.arguments.contains("--settings-page") ? "settings" : "conversations"
        if CommandLine.arguments.contains("--routines-page") {
            model.workspaceDestination = "routines"
            RoutineSnapshot.populate(model)
        }
        let host = NSHostingView(rootView: MyChromeWorkspace(model: model).frame(width: 1020, height: 760))
        host.appearance = NSAppearance(named: CommandLine.arguments.contains("--dark") ? .darkAqua : .aqua)
        host.frame = NSRect(x: 0, y: 0, width: 1020, height: 760)
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        host.layoutSubtreeIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
}
