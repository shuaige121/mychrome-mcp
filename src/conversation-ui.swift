import SwiftUI
import AppKit

/// A live view of one explicitly bound AI thread. No rollout files or terminal scrollback.
struct ConversationState {
    let threadId: String, status: String, reason: String, threadStatus: String
    let canSend: Bool, sending: Bool, readOnly: Bool
    let entries: [ConversationEntry]
    let pending: [[String: Any]]
    init(_ j: [String: Any]) {
        threadId = j["threadId"] as? String ?? ""
        status = j["status"] as? String ?? "unavailable"
        reason = j["reason"] as? String ?? ""
        threadStatus = j["threadStatus"] as? String ?? ""
        canSend = j["canSend"] as? Bool ?? false
        sending = j["sending"] as? Bool ?? false
        readOnly = j["readOnly"] as? Bool ?? false
        entries = (j["entries"] as? [[String: Any]] ?? []).compactMap { e in
            guard let id = e["id"] as? String, let text = e["text"] as? String else { return nil }
            return ConversationEntry(id: id, text: text, role: e["role"] as? String)
        }
        pending = j["pending"] as? [[String: Any]] ?? []
    }
    var availability: String {
        if status == "connecting" { return L("正在连接这个会话…", "Connecting to this session…") }
        if status == "disconnected" { return L("会话连接已断开，草稿仍保留。", "The session connection was lost. Your draft is kept.") }
        if canSend { return threadStatus == "active" ? L("回复会发送给这个正在进行的会话", "Your reply goes to this running session") : L("回复会继续这个会话", "Your reply continues this session") }
        if readOnly || reason == "read_only_mirror" { return L("这是终端里 Claude Code 会话的只读镜像，请回到终端回复。", "This is a read-only mirror of a Claude Code session in your terminal. Reply in the terminal.") }
        if !pending.isEmpty { return L("这个会话正在等你回答下面的问题", "This session is waiting for your answers below") }
        if reason == "upgrade_required" { return L("这个连接还未启用会话中心，请更新连接后使用。可从 MyChrome 菜单的「全部重启」入口更新；直接回复仍取决于 AI 客户端支持。", "This connection does not use the conversation center yet. Update the connection first, for example with Restart all in the MyChrome menu; direct replies also depend on the AI client.") }
        if reason == "browser_only" { return L("这个连接只使用浏览器工具，回复请在它自己的客户端里进行；网页接手仍可使用「去处理」。", "This connection uses browser tools only. Reply in its own client; Go handle it still works for page handoffs.") }
        if reason == "unbound_thread" { return L("这个连接尚未绑定到具体 AI 对话，暂时不能从这里回复。", "This connection is not linked to an AI conversation yet, so you cannot reply from here.") }
        return L("当前会话暂不能接收回复，草稿会留在这里。", "This session cannot take a reply right now. Your draft stays here.")
    }
    var feedPlaceholder: String {
        if reason == "browser_only" { return L("这个连接只使用浏览器工具；它的对话在自己的客户端里。需要你接手网页时，提示仍会显示在这里。", "This connection uses browser tools only; its conversation lives in its own client. When a page needs you, the prompt still appears here.") }
        if reason == "transcript_unavailable" { return L("这个 Claude 连接没有可读的本会话记录（不是终端里的 Claude Code，或记录文件不唯一）。", "This Claude connection has no readable session record (it is not Claude Code in a terminal, or the record file is not unique).") }
        if reason == "binding_ambiguous" { return L("同一个会话有两个正在运行的进程，为避免混入另一边的文字，已停止显示。", "Two running processes share this session, so the mirror stopped to avoid mixing in the other one's text.") }
        if reason == "session_changed" { return L("终端里的会话已切换；这里不再显示旧会话的文字。", "The terminal switched to another session; the old session's text is no longer shown here.") }
        if reason == "feed_off" { return L("对话镜像已在设置中关闭。", "The conversation mirror is turned off in settings.") }
        if reason == "unbound_thread" { return L("先关联一个对话，才能显示它的实时进展。", "Link a conversation to see its live progress.") }
        if reason == "upgrade_required" { return L("这个连接需要更新后，才能在这里显示对话。", "Update this connection to show its conversation here.") }
        if status == "disconnected" { return L("实时文字连接已断开，正在等待恢复。", "The live text connection was lost. Waiting for it to return.") }
        if status == "connecting" { return L("正在连接实时进展…", "Connecting to live progress…") }
        if status == "connected" { return L("已连接。AI 接下来公开展示的进展会出现在这里。", "Connected. Progress the AI shows from now on appears here.") }
        if reason == "thread_inactive" { return L("这个对话当前没有实时文字流，后续连接恢复时会继续显示。", "This conversation has no live text right now; it continues here when the connection returns.") }
        if reason == "conversation_changed" { return L("正在重新连接原来的对话进展。", "Reconnecting to the original conversation's progress.") }
        return L("实时进展暂时不可用，连接恢复后会继续显示。", "Live progress is unavailable for now; it continues when the connection returns.")
    }
}
struct ConversationEntry: Identifiable { let id: String, text: String; var role: String? = nil }

func managedConversationFailure(_ state: ConversationState?) -> String? {
    guard let state else { return nil }
    switch state.reason {
    case "turn_failed", "claude_turn_failed": return L("本轮生成失败，已显示的内容和草稿仍保留。请重试。", "This turn failed. What is shown and your draft are kept. Please try again.")
    case "claude_delivery_unconfirmed": return L("尚未确认客户端是否收到消息。请先检查送达状态，草稿仍保留。", "Not yet confirmed that the client received the message. Check the delivery status first; your draft is kept.")
    case "message_too_large": return L("本轮内容超出显示限制，部分内容未能显示。", "This turn exceeded the display limit; part of it is not shown.")
    case "request_failed", "request_timeout": return L("客户端请求未完成。请查看当前进展后重试，草稿仍保留。", "The client request did not finish. Check the current progress, then retry; your draft is kept.")
    default: return state.status == "error" ? L("客户端发生错误。请检查客户端连接后重试，草稿仍保留。", "The client reported an error. Check its connection, then retry; your draft is kept.") : nil
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
        return ConversationPresentation(kind: "waiting", label: L("需要你处理", "Needs you"), symbol: "hand.raised.fill", tone: "orange")
    }
    if status == "disconnected" {
        return ConversationPresentation(kind: "disconnected", label: L("连接已断开", "Disconnected"), symbol: "wifi.slash", tone: "gray")
    }
    if (current?.pending.count ?? server.conversationPending) > 0 {
        return ConversationPresentation(kind: "waiting", label: L("等待你回复", "Waiting for your reply"), symbol: "hand.raised.fill", tone: "orange")
    }
    if server.managedSession, managedConversationFailure(current) != nil {
        return ConversationPresentation(kind: "error", label: L("本轮遇到问题", "This turn hit a problem"), symbol: "exclamationmark.triangle.fill", tone: "red")
    }
    if server.busy != nil || (status == "connected" && current?.threadStatus == "active") {
        return ConversationPresentation(kind: "running", label: server.busy != nil ? L("正在操作网页", "Working on a page") : L("正在运行", "Running"), symbol: "arrow.triangle.2.circlepath", tone: "blue")
    }
    if status == "connecting" {
        return ConversationPresentation(kind: "connecting", label: L("正在连接", "Connecting"), symbol: "ellipsis.circle", tone: "gray")
    }
    // What the source is, stated as a fact: never a verdict on the client, never generated progress.
    switch current?.reason ?? "" {
    case "browser_only": return ConversationPresentation(kind: "browser_only", label: L("仅浏览器操作", "Browser tools only"), symbol: "globe", tone: "gray")
    case "transcript_unavailable", "transcript_ambiguous", "transcript_not_regular", "transcript_owner":
        return ConversationPresentation(kind: "transcript_unavailable", label: L("对话记录不可用", "Conversation record unavailable"), symbol: "doc.questionmark", tone: "gray")
    case "binding_ambiguous": return ConversationPresentation(kind: "binding_ambiguous", label: L("会话被多个进程打开", "Session open in several processes"), symbol: "exclamationmark.bubble", tone: "gray")
    case "session_changed": return ConversationPresentation(kind: "session_changed", label: L("会话已切换", "Session switched"), symbol: "arrow.left.arrow.right", tone: "gray")
    case "feed_off": return ConversationPresentation(kind: "feed_off", label: L("对话镜像已关闭", "Conversation mirror off"), symbol: "pause.circle", tone: "gray")
    default: break
    }
    if !server.managedSession, let provider = server.conversationProvider, provider != "Codex" {
        if provider != "Claude" {
            return ConversationPresentation(kind: "browser_only", label: L("仅浏览器操作", "Browser tools only"), symbol: "globe", tone: "gray")
        }
        if server.conversationThread == nil {
            return ConversationPresentation(kind: "transcript_unavailable", label: L("对话记录不可用", "Conversation record unavailable"), symbol: "doc.questionmark", tone: "gray")
        }
    }
    if server.guiInstance == nil {
        return ConversationPresentation(kind: "upgrade", label: L("需要更新连接", "Connection needs an update"), symbol: "arrow.up.circle", tone: "gray")
    }
    if server.conversationThread == nil {
        return ConversationPresentation(kind: "unbound", label: L("尚未关联对话", "No conversation linked"), symbol: "link", tone: "gray")
    }
    if status == "connected" {
        return ConversationPresentation(kind: current?.threadStatus == "idle" ? "idle" : "connected",
            label: current?.threadStatus == "idle" ? L("当前空闲", "Idle") : L("已连接", "Connected"), symbol: "bubble.left", tone: "gray")
    }
    return ConversationPresentation(kind: "unavailable", label: L("实时进展不可用", "Live progress unavailable"), symbol: "wifi.slash", tone: "gray")
}
func conversationDeliveryPresentation(_ status: String) -> ConversationPresentation {
    switch status {
    case "sending": return ConversationPresentation(kind: status, label: L("正在发送", "Sending"), symbol: "arrow.up.circle", tone: "blue")
    case "accepted": return ConversationPresentation(kind: status, label: L("回复已送达", "Reply delivered"), symbol: "checkmark.circle.fill", tone: "green")
    case "rejected": return ConversationPresentation(kind: status, label: L("回复未被接收", "Reply not accepted"), symbol: "xmark.octagon.fill", tone: "red")
    case "resolved": return ConversationPresentation(kind: status, label: L("问题已结束，回答送达未确认", "Question closed; delivery of the answer unconfirmed"), symbol: "questionmark.circle", tone: "orange")
    case "not_sent": return ConversationPresentation(kind: status, label: L("尚未发送", "Not sent yet"), symbol: "exclamationmark.circle", tone: "orange")
    case "released": return ConversationPresentation(kind: status, label: L("已解除发送等待", "No longer waiting on the send"), symbol: "info.circle", tone: "gray")
    default: return ConversationPresentation(kind: "unknown", label: L("送达尚未确认", "Delivery not confirmed yet"), symbol: "questionmark.circle", tone: "orange")
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
    return server.conversationThread == nil ? L("尚未关联对话", "No conversation linked") : L("未命名对话", "Untitled conversation")
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
        associating.insert(key); associationNotes[key] = L("正在读取当前宿主的会话…", "Reading this host's conversations…")
        callConversation(server, request: ["op": "discover"]) { [weak self] response in
            guard let self else { return }
            self.associating.remove(key)
            if let rows = response["conversations"] as? [[String: Any]], response["ok"] as? Bool == true {
                self.availableConversations[key] = rows
                self.associationNotes[key] = rows.isEmpty ? L("当前宿主没有可关联的已加载会话。", "This host has no loaded conversation to link.") : L("选择要在这里回复的对话", "Choose the conversation to reply to here")
            } else {
                self.associationNotes[key] = L("当前连接未提供可关联的会话。请在支持的 Codex 宿主中使用。", "This connection offers no conversation to link. Use a Codex host that provides them.")
            }
        }
    }
    func bindConversation(_ server: ServerInfo, thread: String) {
        let key = conversationKey(server)
        guard !associating.contains(key) else { return }
        associating.insert(key); associationNotes[key] = L("正在关联…", "Linking…")
        callConversation(server, request: ["op": "bind", "payload": ["threadId": thread]]) { [weak self] response in
            guard let self else { return }
            self.associating.remove(key)
            self.availableConversations.removeValue(forKey: key)
            self.associationNotes[key] = response["ok"] as? Bool == true ? L("已关联，正在刷新…", "Linked. Refreshing…") : L("这个对话已变化，请重新选择。", "This conversation has changed. Please choose again.")
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
        deliveryNotes[key] = L("正在发送…", "Sending…")
        deliveryStates[key] = "sending"
        callConversation(server, request: ["op": checkOnly ? "delivery" : "send", "payload": payload]) { [weak self] response in
            guard let self else { return }
            self.sendingTo.remove(key)
            let result = response["result"] as? [String: Any] ?? [:]
            let status = result["status"] as? String ?? ""
            if status == "accepted" {
                self.deliveryStates[key] = "accepted"
                self.deliveryNotes[key] = L("已送达这个会话", "Delivered to this session")
                if let sentText = payload["text"] as? String {
                    self.rememberConversationTitle(server, text: sentText)
                    if self.drafts[key] == sentText { self.drafts[key] = "" }
                }
                self.unconfirmedSends.removeValue(forKey: key)
            } else if status == "resolved" {
                self.deliveryStates[key] = "resolved"
                self.deliveryNotes[key] = L("这个问题已结束；无法确认是否采用了本次回答。", "This question is closed; it cannot be confirmed whether this answer was used.")
                self.unconfirmedSends.removeValue(forKey: key)
            } else if status == "rejected" || response["delivery"] as? String == "rejected" {
                self.deliveryStates[key] = "rejected"
                self.deliveryNotes[key] = L("会话没有接收这条回复，内容已保留。", "The session did not accept this reply. The text is kept.")
                self.unconfirmedSends.removeValue(forKey: key)
            } else if response["delivery"] as? String == "not_sent" {
                self.deliveryStates[key] = "not_sent"
                self.deliveryNotes[key] = L("尚未发送：会话状态已变化，内容已保留。", "Not sent: the session state changed. The text is kept.")
                self.unconfirmedSends.removeValue(forKey: key)
            } else {
                self.deliveryStates[key] = "unknown"
                self.deliveryNotes[key] = L("尚未确认送达，请先查看会话状态；内容已保留，不会自动重发。", "Delivery not confirmed yet. Check the session first; the text is kept and is not resent automatically.")
            }
            self.refreshConversation()
        }
    }
    func interruptConversation(_ server: ServerInfo) {
        let key = conversationKey(server)
        guard live, server.managedSession, !interruptingConversations.contains(key) else { return }
        interruptingConversations.insert(key); generationNotes[key] = L("正在请求停止生成…", "Asking to stop generating…")
        callConversation(server, request: ["op": "interrupt"]) { [weak self] response in
            guard let self else { return }
            self.interruptingConversations.remove(key)
            self.generationNotes[key] = response["ok"] as? Bool == true
                ? L("已请求停止生成", "Asked to stop generating") : L("停止请求未能确认，请查看最新进展后重试。", "The stop request was not confirmed. Check the latest progress, then retry.")
            self.refreshConversation()
        }
    }
    /// The session's own words are Chinese (src/index.js GOTO_MESSAGES); in English the GUI says it by the finite reason.
    func gotoResultText(reason: String?, message: String?) -> String {
        if !uiEnglish(), let message { return message }
        switch reason ?? "" {
        case "queued": return L("正在等待其他 AI 交还鼠标，稍后打开。", "Waiting for another AI to hand back the mouse; the page opens after that.")
        case "shown": return L("已打开需要你处理的页面。", "The page that needs you is open.")
        case "invalid_request": return L("跳转请求不完整，请刷新列表后重试。", "The request was incomplete. Refresh the list and retry.")
        case "session_changed": return L("这个 AI 会话已经更新，请刷新列表。", "This AI session has been updated. Refresh the list.")
        case "alert_changed": return L("这条等待提示已经结束或被替换，请刷新列表。", "This alert has ended or been replaced. Refresh the list.")
        case "stale_request": return L("跳转请求已过期，请重新点击。", "The request expired. Click again.")
        case "paused": return L("MyChrome 已暂停，请恢复后重新点击。", "MyChrome is paused. Resume it, then click again.")
        case "busy": return L("这个 AI 正在操作，请稍后重新点击。", "This AI is working. Click again in a moment.")
        case "queue_timeout": return L("等待鼠标超时，请稍后重新点击。", "Timed out waiting for the mouse. Click again in a moment.")
        case "page_changed": return L("等待的页面已经变化，请刷新列表。", "The waiting page has changed. Refresh the list.")
        case "target_unavailable": return L("暂时无法打开这个页面，请确认 Chrome 和标签页仍在。", "The page cannot be opened right now. Check that Chrome and the tab are still there.")
        case "request_conflict": return L("这个请求编号已经使用，请重新点击。", "This request was already used. Click again.")
        case "too_many_requests": return L("跳转请求过多，请稍后重试。", "Too many requests. Try again in a moment.")
        case "result_unavailable": return L("无法保存跳转结果，请稍后重试。", "The result could not be saved. Try again in a moment.")
        default: return message ?? L("正在定位页面…", "Finding the page…")
        }
    }
    func refreshGotoResults() {
        for (pid, pending) in gotoPending {
            if let r = readJSON(BASE + "/goto-result-\(pid).json"),
               r["id"] as? String == pending.id,
               r["sessionGeneration"] as? String == pending.generation || r["reason"] as? String == "session_changed" {
                gotoNotes[pid] = gotoResultText(reason: r["reason"] as? String, message: r["message"] as? String)
                if r["status"] as? String != "queued" { gotoPending.removeValue(forKey: pid) }
            } else if nowMs() - pending.at > 20_000 {
                gotoNotes[pid] = L("未收到跳转结果；请检查这个会话是否仍在等待。", "No result from going to the page; check whether this session is still waiting.")
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
                Button { model.showNewSession() } label: { Label(L("新对话", "New conversation"), systemImage: "plus.bubble") }
                    .buttonStyle(.borderedProminent).keyboardShortcut("n", modifiers: .command).help(L("新对话（⌘N）", "New conversation (⌘N)"))
                Spacer()
                Picker(L("页面", "Page"), selection: $model.workspaceDestination) {
                    Text(L("对话", "Conversations")).tag("conversations")
                    Text(L("操作设置", "Operation settings")).tag("settings")
                    Text(L("网站流程", "Website routines")).tag("routines")
                }.pickerStyle(.segmented).labelsHidden().frame(width: 310)
                Spacer()
                Button {
                    model.set("paused", !model.settings.paused)
                } label: {
                    Label(model.settings.paused ? L("继续 AI 操作", "Resume AI operations") : L("暂停 AI 操作", "Pause AI operations"),
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

func pagePromptSemanticLabel(_ semantic: String) -> String {
    semantic == "keep_session" ? L("保持会话", "Keep session") : L("退出会话", "End session")
}

/// Shared by the real menu-bar Settings and conversation-center Operation Settings.
struct PagePromptSettingsView: View {
    @ObservedObject var model: Model
    @State private var addingRule = false
    private var catalog: PagePromptCatalog? { PagePromptCatalog.load() }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker(L("网页弹窗处理", "Page pop-up handling"), selection: Binding(get: { model.settings.pagePrompt.policy }, set: {
                model.mutatePagePrompt(["op": "policy", "policy": $0])
            })) {
                Text(L("关闭", "Off")).tag("off")
                Text(L("通知 AI", "Notify AI")).tag("notify_ai")
                Text(L("已审核的闲置规则", "Reviewed idle rules")).tag("auto_safe")
            }.disabled(!model.settings.pagePrompt.valid || catalog == nil)
            Text(L("默认只通知 AI。自动处理仅适用于你明确保存并启用的精确规则；系统通知开关独立。", "By default the AI is only notified. Automatic handling applies only to exact rules you saved and turned on yourself; system notifications have their own switch."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !model.settings.pagePrompt.valid {
                Text(model.settings.pagePrompt.reason == "catalog_unavailable"
                     ? L("模板目录缺失或无效，自动处理不可用。其他设置仍可使用。", "The template catalog is missing or invalid, so automatic handling is unavailable. Other settings still work.")
                     : L("网页弹窗设置无效，当前仅通知 AI，自动规则停用。原始设置已保留，其他设置仍可使用。", "The page pop-up settings are invalid: the AI is only notified and automatic rules are off. The original settings are kept; other settings still work."))
                    .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if catalog?.templates.contains(where: { !$0.fixtureOnly }) != true {
                Text(L("当前没有真实网站的自动处理模板。现有模板仅用于测试页面；MCF 尚不支持自动处理。", "There are no automatic handling templates for real websites yet. The existing templates are for test pages only; MCF has no automatic handling yet."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.settings.pagePrompt.rules) { rule in
                VStack(alignment: .leading, spacing: 6) {
                    let template = catalog?.templates.first(where: { $0.id == rule.templateId && $0.version == rule.templateVersion })
                    Text(template?.label ?? L("模板不可用", "Template unavailable")).font(.callout.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(rule.origin).font(.caption.monospaced()).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(rule.templateId) · v\(rule.templateVersion)").font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(pagePromptSemanticLabel(rule.semantic)) → \(rule.button)")
                        .font(.callout).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Toggle(L("启用此规则", "Turn on this rule"), isOn: Binding(get: { rule.enabled }, set: {
                            model.mutatePagePrompt(["op": "toggle", "id": rule.id, "enabled": $0])
                        })).disabled(!model.settings.pagePrompt.valid || template == nil)
                        Spacer()
                        Button(L("删除", "Delete"), role: .destructive) { model.mutatePagePrompt(["op": "delete", "id": rule.id]) }
                            .disabled(!model.settings.pagePrompt.valid)
                    }
                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            }
            if model.settings.pagePrompt.rules.isEmpty && model.settings.pagePrompt.valid {
                Text(L("还没有自动规则。新规则保存后默认关闭。", "No automatic rules yet. A new rule is off when saved."))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Button(L("添加规则…", "Add rule…")) { addingRule = true }
                .disabled(!model.settings.pagePrompt.valid || catalog == nil || model.settings.pagePrompt.rules.count >= 32)
                .sheet(isPresented: $addingRule) { PagePromptRuleSheet(model: model) }
            if let error = model.settingsError {
                Text(error).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            Text(L("网页通知接收状态", "Page notification delivery status")).font(.callout.weight(.semibold))
            Text(L("以下状态只供查看；选择或查看会话不会改变通知接收方。", "These statuses are for viewing only; choosing or viewing a session does not change who receives notifications."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if model.servers.isEmpty {
                Text(L("没有可用的任务连接，主动通知尚不可用。", "No task connection is available, so proactive notifications are not available yet.")).font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Array(model.servers.prefix(8))) { server in
                VStack(alignment: .leading, spacing: 4) {
                    Text(String(server.who.prefix(60))).font(.caption.weight(.semibold))
                    if let status = server.pagePrompt {
                        let stale = model.now - status.updatedAt > 30_000 || status.updatedAt > model.now + 5_000
                        if stale { Text(L("上次状态（已过期）", "Last status (expired)")).font(.caption).foregroundStyle(.orange) }
                        Text(status.routeLabel).font(.caption)
                        Text(status.transportLabel + " · " + status.modelLabel).font(.caption).foregroundStyle(.secondary)
                        Text(L("\(status.observerLabel) · \(status.openCount) 个未关闭提示", "\(status.observerLabel) · \(status.openCount) open prompt(s)")).font(.caption).foregroundStyle(.secondary)
                        if let reason = status.reasonLabel { Text(reason).font(.caption).foregroundStyle(.secondary) }
                        Text(L("更新于 ", "Updated: ") + dateText(Date(timeIntervalSince1970: status.updatedAt / 1000))).font(.caption2).foregroundStyle(.secondary)
                    } else {
                        Text(L("此连接尚无可验证的网页通知状态。", "This connection has no verifiable page notification status yet.")).font(.caption).foregroundStyle(.secondary)
                    }
                }.fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct PagePromptRuleSheet: View {
    @ObservedObject var model: Model
    @Environment(\.dismiss) private var dismiss
    @State private var templateId = ""
    @State private var origin = ""
    @State private var semantic = ""
    @State private var saving = false
    private var catalog: PagePromptCatalog? { PagePromptCatalog.load() }
    private var template: PagePromptTemplate? { catalog?.templates.first(where: { $0.id == templateId }) }
    private var candidate: PagePromptRule? {
        guard let catalog, let template, let button = template.choices[semantic] else { return nil }
        return PagePromptRule.parse(["id": "preview", "enabled": false, "origin": origin, "templateId": template.id,
                                    "templateVersion": template.version, "semantic": semantic, "button": button], catalog: catalog)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L("添加网页闲置规则", "Add a page idle rule")).font(.title2.weight(.semibold))
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Picker(L("已审核模板", "Reviewed template"), selection: $templateId) {
                        Text(L("请选择模板", "Choose a template")).tag("")
                        ForEach(catalog?.templates ?? []) { template in Text(template.label).tag(template.id) }
                    }.onChange(of: templateId) { _ in origin = ""; semantic = "" }
                    if let template {
                        Text("\(template.id) · v\(template.version)").font(.caption.monospaced()).textSelection(.enabled)
                        if template.fixtureOnly {
                            Text(L("仅测试页面：此规则不能用于 MCF 或其他真实网站。", "Test pages only: this rule cannot be used on MCF or any other real website."))
                                .font(.callout).foregroundStyle(.orange)
                            Picker(L("精确 origin", "Exact origin"), selection: $origin) {
                                Text(L("请选择测试 origin", "Choose a test origin")).tag("")
                                ForEach(template.origins, id: \.self) { Text($0).tag($0) }
                            }
                        } else {
                            TextField(L("精确 HTTPS origin", "Exact HTTPS origin"), text: $origin).textFieldStyle(.roundedBorder)
                            Text(L("须与模板允许的 origin 完全一致：", "Must match an origin the template allows exactly: ") + template.origins.joined(separator: L("、", ", ")))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Picker(L("处理方式与按钮", "Action and button"), selection: $semantic) {
                            Text(L("请选择处理方式", "Choose an action")).tag("")
                            ForEach(template.choices.keys.sorted(), id: \.self) { key in
                                Text(pagePromptSemanticLabel(key) + " → " + (template.choices[key] ?? "")).tag(key)
                            }
                        }
                        Divider()
                        Text(L("完整匹配预览", "Full match preview")).font(.headline)
                        Text(L("标题：", "Title: ") + (template.title.isEmpty ? L("（空）", "(empty)") : template.title))
                        ForEach(Array(template.texts.enumerated()), id: \.offset) { item in Text(L("正文 \(item.offset + 1)：", "Body \(item.offset + 1): ") + item.element) }
                        Text(L("全部按钮（顺序固定）", "All buttons (fixed order)")).font(.callout.weight(.medium))
                        ForEach(Array(template.buttons.enumerated()), id: \.offset) { item in Text("\(item.offset + 1). " + item.element) }
                        Text(L("输入字段：无", "Input fields: none")).font(.caption).foregroundStyle(.secondary)
                        Text(L("origin：", "Origin: ") + (origin.isEmpty ? L("未选择", "not chosen") : origin)).font(.caption.monospaced())
                        if let button = template.choices[semantic] {
                            Text(L("操作：\(pagePromptSemanticLabel(semantic)) → \(button)", "Action: \(pagePromptSemanticLabel(semantic)) → \(button)")).font(.callout.weight(.medium))
                        }
                    }
                    Text(L("保存后此规则保持关闭。回到规则列表明确启用，并选择「已审核的闲置规则」后才可能自动处理。", "This rule stays off after saving. It can act automatically only after you turn it on in the rule list and choose Reviewed idle rules."))
                        .font(.caption).foregroundStyle(.secondary)
                    if candidate == nil && !templateId.isEmpty {
                        Text(L("请选择模板允许的精确 origin 和处理方式。", "Choose an exact origin the template allows and an action."))
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if catalog == nil { Text(L("模板目录不可用，无法保存规则。", "The template catalog is unavailable, so the rule cannot be saved.")).foregroundStyle(.orange) }
                    if let error = model.settingsError { Text(error).font(.caption).foregroundStyle(.orange) }
                }.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            HStack {
                Button(L("取消", "Cancel")) { dismiss() }.disabled(saving)
                Spacer()
                Button(saving ? L("正在保存…", "Saving…") : L("保存规则（默认关闭）", "Save rule (off by default)")) {
                    guard let rule = candidate else { return }
                    var object = rule.object
                    object["id"] = UUID().uuidString
                    saving = true
                    model.mutatePagePrompt(["op": "add", "rule": object]) { saved in
                        saving = false
                        if saved { dismiss() }
                    }
                }.buttonStyle(.borderedProminent)
                    .disabled(candidate == nil || !model.settings.pagePrompt.valid || model.settings.pagePrompt.rules.count >= 32 || saving)
            }
        }.padding(24).frame(width: 540, height: 650)
    }
}

struct OperationSettings: View {
    @ObservedObject var model: Model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(L("操作设置", "Operation settings")).font(.system(size: 25, weight: .semibold))
                    Text(L("按你的习惯操作浏览器。更改会应用到后续操作。", "Operate the browser your way. Changes apply to later actions."))
                        .font(.callout).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 18) {
                    Label(L("文字输入", "Text input"), systemImage: "keyboard").font(.headline)
                    let lock = model.lockedValue("inputMode")
                    let mode = lock?.value as? String ?? model.settings.inputMode
                    Picker(L("输入方式", "Input mode"), selection: Binding(get: { mode }, set: { model.set("inputMode", $0) })) {
                        Text(L("跟随任务", "Follow task")).tag("auto")
                        Text(L("逐字键盘输入", "Type key by key")).tag("keys")
                        Text(L("直接粘贴", "Paste")).tag("paste")
                    }.pickerStyle(.segmented).labelsHidden().disabled(lock != nil)
                    Text(mode == "auto" ? L("由 AI 按任务选择；未指定时使用逐字键盘输入。", "The AI chooses per task; key-by-key typing when none is given.") : mode == "keys" ? L("依次按下键盘，适用于英文与常用符号。输入中文时请选择直接粘贴。", "Presses keys one by one; suits English and common symbols. Choose Paste for Chinese text.") : L("一次粘贴整段文字，适用于中文和较长内容。", "Pastes the whole text at once; suits Chinese and longer text."))
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if let lock {
                        Text(L("\(lock.who) 的客户端配置固定了输入方式。", "The client configuration of \(lock.who) fixes the input mode."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    let lock = model.lockedValue("inputSpeed")
                    let speed = lock.flatMap { jsonNum($0.value) } ?? model.settings.inputSpeed
                    HStack {
                        Label(L("操作速度", "Operation speed"), systemImage: "speedometer").font(.headline)
                        Spacer()
                        Text(speed.formatted() + "×").font(.title3.monospacedDigit().weight(.semibold))
                    }
                    Picker(L("操作速度", "Operation speed"), selection: Binding(get: { speed }, set: { model.set("inputSpeed", $0) })) {
                        ForEach(Settings.inputSpeeds, id: \.self) { value in
                            Text(value.formatted() + "×").tag(value)
                        }
                    }.pickerStyle(.segmented).labelsHidden().disabled(lock != nil)
                    Text(L("0.5× 更慢 · 1× 标准节奏 · 3× 更快", "0.5× slower · 1× standard pace · 3× faster")).font(.caption).foregroundStyle(.secondary)
                    Text(lock == nil ? L("调整按键、鼠标和滚动的节奏。接管时也可用 ↑ / ↓ 调整。", "Sets the pace of keys, pointer and scrolling. During a takeover, ↑ / ↓ also adjust it.") : L("调整按键、鼠标和滚动的节奏。", "Sets the pace of keys, pointer and scrolling."))
                        .font(.callout).foregroundStyle(.secondary)
                    if let lock {
                        Text(L("\(lock.who) 的客户端配置固定了操作速度。", "The client configuration of \(lock.who) fixes the operation speed."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    Label(L("浏览器窗口", "Browser window"), systemImage: "macwindow").font(.headline)
                    let lock = model.lockedValue("agentDisplay")
                    let display = lock?.value as? String ?? model.settings.agentDisplay
                    Picker(L("AI 窗口位置", "AI window position"), selection: Binding(get: { display }, set: { model.set("agentDisplay", $0) })) {
                        Text(L("自动选择", "Automatic")).tag("away")
                        Text(L("副屏", "Secondary display")).tag("secondary")
                        Text(L("主屏", "Main display")).tag("main")
                        Text(L("沿用当前窗口", "Current window")).tag("off")
                    }.disabled(lock != nil)
                    let notifyLock = model.lockedValue("notify")
                    Toggle(L("需要我处理时通知我", "Notify me when I need to act"), isOn: Binding(
                        get: { notifyLock.flatMap { jsonBool($0.value) } ?? model.settings.notify },
                        set: { model.set("notify", $0) })).disabled(notifyLock != nil)
                }
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    Label(L("网页弹窗", "Page pop-ups"), systemImage: "text.bubble").font(.headline)
                    PagePromptSettingsView(model: model)
                }
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    Label(L("我的操作习惯", "My operation habits"), systemImage: "hand.draw").font(.headline)
                    Text(L("学习你的键鼠节奏，用于逐字输入与移动。这是节奏采样，不是视频录屏。", "Learns your keyboard and mouse rhythm for key-by-key typing and pointer movement. It samples rhythm only; it is not a screen recording."))
                        .font(.callout).foregroundStyle(.secondary)
                    if let until = model.recordingUntil {
                        Text(L("正在采样 · 还剩 ", "Sampling · left: ") + clockText(max(0, until - model.now)))
                            .font(.callout.monospacedDigit())
                        ProgressView(value: min(1, max(0, 1 - (until - model.now) / (RECORD_SECONDS * 1000))))
                        Button(L("取消采样，不保存", "Cancel sampling without saving")) { model.cancelRecording() }
                    } else if let habits = model.habits {
                        Toggle(L("使用我的操作习惯", "Use my operation habits"), isOn: Binding(get: { habits.use }, set: { model.setUse($0) }))
                        Text(L("采样于 ", "Sampled: ") + dateText(habits.recordedAt)).font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button(L("重新采样 3 分钟", "Sample 3 minutes again")) { model.startRecording() }.disabled(model.habitsOff)
                            Spacer()
                            Button(model.confirmDelete ? L("再次点击确认删除", "Click again to delete") : L("删除习惯数据", "Delete habit data"), role: .destructive) { model.deleteHabits() }
                        }
                    } else {
                        HStack {
                            Text(L("还没有习惯数据", "No habit data yet")).foregroundStyle(.secondary)
                            Spacer()
                            Button(L("采样 3 分钟", "Sample 3 minutes")) { model.startRecording() }
                                .buttonStyle(.bordered).disabled(model.habitsOff)
                        }
                    }
                    if let error = model.recordError { Text(error).font(.caption).foregroundStyle(.orange) }
                    if model.habitsOff { Text(L("客户端配置已关闭习惯采样。", "Habit sampling is turned off in the client configuration.")).font(.caption).foregroundStyle(.secondary) }
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
                    TextField(L("搜索对话", "Search conversations"), text: $query).textFieldStyle(.plain)
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
                            Text(query.isEmpty ? L("关联 AI 对话后，\n这里会显示它的真实标题。", "After you link an AI conversation,\nits real title appears here.") : L("没有匹配的对话", "No matching conversations"))
                                .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }
                        if let server = canAssociate {
                            Button {
                                showOtherConnections = true
                                model.selectConversation(server)
                                model.discoverConversation(server)
                            } label: { Label(L("关联已有对话", "Link an existing conversation"), systemImage: "link") }
                                .buttonStyle(.plain).foregroundStyle(Color.accentColor)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }
                        if !otherConnections.isEmpty {
                            Divider().padding(.vertical, 8)
                            Button { showOtherConnections.toggle() } label: {
                                HStack {
                                    Image(systemName: showOtherConnections ? "chevron.down" : "chevron.right").font(.caption2)
                                    Text(L("未关联的连接（\(otherConnections.count)）", "Unlinked connections (\(otherConnections.count))"))
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
                Button(L("保留的草稿", "Kept drafts")) { showDrafts = true }.buttonStyle(.plain).font(.caption).padding(.horizontal, 18).padding(.bottom, 16)
            }.frame(width: 260).background(Color(nsColor: .controlBackgroundColor))
            Divider()
            if let server = model.chosenServer {
                detail(server).id(conversationKey(server))
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 38)).foregroundStyle(.secondary)
                    Text(model.servers.isEmpty ? L("开始你的第一个对话", "Start your first conversation") : L("选择一个会话", "Choose a session")).font(.title2.bold())
                    Text(L("新建 Codex 或 Claude Code 对话，直接在这里聊天。\n已有连接会显示在左侧，也可以关联原来的 AI 对话。", "Start a Codex or Claude Code conversation and chat right here.\nExisting connections appear on the left; you can also link an existing AI conversation."))
                        .multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button { model.showNewSession() } label: { Label(L("新对话", "New conversation"), systemImage: "plus.bubble") }
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
                Text(L("连接于 ", "Since ") + Date(timeIntervalSince1970: server.startedAt / 1000).formatted(uiDateStyle(date: .omitted, time: .standard)))
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 9).fill(selected ? Color.accentColor.opacity(0.12) : .clear))
            .contentShape(Rectangle())
            .help(server.who + L(" · 连接 \(server.id)", " · connection \(server.id)") + (server.conversationThread.map { " · " + $0 } ?? ""))
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
                        Button(server.conversationThread == nil ? L("关联对话", "Link conversation") : L("更换对话", "Change conversation")) { model.discoverConversation(server) }
                            .disabled(model.associating.contains(key) || model.sendingTo.contains(key))
                    }
                }
                HStack(spacing: 12) {
                    Text(conversationClient(server)).foregroundStyle(.secondary)
                        .help(server.who + L(" · 连接 \(server.id)", " · connection \(server.id)"))
                    ConversationStatusLabel(presentation: conversationPresentation(server, task: task, state: state))
                    Spacer()
                    if server.managedSession {
                        Button(model.interruptingConversations.contains(key) ? L("正在停止…", "Stopping…") : L("停止生成", "Stop generating")) { model.interruptConversation(server) }
                            .disabled(!canInterruptConversation(server, state: state, sending: model.sendingTo.contains(key)) || model.interruptingConversations.contains(key))
                    }
                }.font(.caption)
                if server.managedSession {
                    HStack(spacing: 12) {
                        Text(server.model.map { L("模型：", "Model: ") + $0 } ?? L("模型信息待确认", "Model not confirmed yet"))
                        Text(server.effort.map { L("思考强度：", "Reasoning effort: ") + sessionEffortName($0) } ?? L("思考强度：未提供", "Reasoning effort: not provided"))
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
                                            Text(choice["title"] as? String ?? L("未命名", "Untitled")).lineLimit(2)
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
                        Button { model.gotoAlert(task) } label: { Label(L("去处理", "Go handle it"), systemImage: "arrow.up.forward.app") }
                            .disabled(model.gotoPending[task.id] != nil)
                    }
                }.padding(16).background(Color.orange.opacity(0.08))
            }
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let state, !state.entries.isEmpty {
                            ForEach(state.entries) { entry in
                                if entry.role == "user" {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(L("你", "You")).font(.caption.bold()).foregroundStyle(.secondary)
                                        Text(entry.text).font(.system(size: 14)).foregroundStyle(.secondary).textSelection(.enabled)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                } else {
                                    Text(entry.text).font(.system(size: 14)).textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        } else {
                            Text(state?.feedPlaceholder ?? L("正在连接实时进展…", "Connecting to live progress…"))
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
                    Button(L("连接已更新，查看之前保留的草稿", "The connection was updated; see your kept drafts")) { showDrafts = true }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(Color.accentColor)
                }
                Text(state?.availability ?? L("正在连接这个会话…", "Connecting to this session…")).font(.caption).foregroundStyle(.secondary)
                TextEditor(text: Binding(get: { model.drafts[key] ?? "" }, set: {
                    model.drafts[key] = $0
                    model.draftTitles[key] = conversationName(server, task: task) + " · " + conversationClient(server) + " · " +
                        Date(timeIntervalSince1970: server.startedAt / 1000).formatted(uiDateStyle(date: .abbreviated, time: .standard))
                }))
                    .font(.system(size: 14)).frame(minHeight: 65, maxHeight: 115)
                    .padding(6).background(Color(nsColor: .textBackgroundColor))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.22)))
                    .accessibilityLabel(L("回复给 \(conversationName(server, task: task))", "Reply to \(conversationName(server, task: task))"))
                HStack {
                    if let note = model.deliveryNotes[key] {
                        ConversationStatusLabel(presentation: conversationDeliveryPresentation(model.deliveryStates[key] ?? "unknown"), text: note).font(.caption)
                    } else {
                        Text(L("⌘ Return 发送 · Return 换行", "⌘ Return to send · Return for a new line")).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.unconfirmedSends[key] != nil {
                        Button(L("检查送达状态", "Check delivery status")) { model.sendConversation(server, checkOnly: true) }
                            .disabled(model.sendingTo.contains(key))
                    }
                    Button(model.sendingTo.contains(key) ? L("正在发送…", "Sending…") : L("发送回复", "Send reply")) { model.sendConversation(server) }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(state?.canSend != true || model.sendingTo.contains(key) || model.unconfirmedSends[key] != nil || (model.drafts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if model.unconfirmedSends[key] != nil && !model.sendingTo.contains(key) {
                    Button(L("我已在原会话核对，继续输入新回复", "I checked in the original session; write a new reply")) {
                        model.unconfirmedSends.removeValue(forKey: key)
                        model.deliveryNotes[key] = L("已解除发送等待；旧内容仍在草稿中。", "No longer waiting on the send; the earlier text is still in your draft.")
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
            HStack { Text(L("保留的草稿", "Kept drafts")).font(.title2.bold()); Spacer(); Button(L("完成", "Done"), action: close) }
            Text(L("草稿只保留到退出 MyChrome。连接变化后，旧内容会留在这里，不会自动发给新会话。", "Drafts are kept until you quit MyChrome. When a connection changes, earlier text stays here and is never sent to the new session automatically."))
                .font(.caption).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if keys.isEmpty && model.answerDrafts.isEmpty { Text(L("还没有草稿", "No drafts yet")).foregroundStyle(.secondary) }
                    ForEach(keys, id: \.self) { key in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(model.draftTitles[key] ?? L("此前会话", "Earlier session")).font(.headline).help(key)
                            Text(model.drafts[key] ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            HStack {
                                if let selected = model.chosenServer {
                                    Button(L("追加到「\(conversationName(selected, task: model.tasks.first { $0.id == selected.id }))」的草稿", "Add to the draft for “\(conversationName(selected, task: model.tasks.first { $0.id == selected.id }))”")) {
                                        let target = conversationKey(selected)
                                        let sourceText = model.drafts[key] ?? ""
                                        let existing = model.drafts[target] ?? ""
                                        if existing != sourceText {
                                            model.drafts[target] = existing.isEmpty ? sourceText : existing + "\n\n" + sourceText
                                        }
                                        close()
                                    }.help(conversationKey(selected))
                                }
                                Button(L("删除", "Delete")) { model.drafts.removeValue(forKey: key) }
                            }.font(.caption)
                        }.padding(14).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                    }
                    ForEach(model.answerDrafts.keys.sorted(), id: \.self) { key in
                        DisclosureGroup(L("此前问题的回答草稿", "Draft answers to earlier questions")) {
                            ForEach(Array((model.answerQuestions[key] ?? []).enumerated()), id: \.offset) { _, q in
                                Text(q["question"] as? String ?? "").font(.caption.bold())
                                if q["isSecret"] as? Bool == true { Text(L("私密回答已隐藏", "Private answer hidden")).font(.caption) }
                                else { Text(model.answerDrafts[key]?[q["id"] as? String ?? ""] ?? "").textSelection(.enabled) }
                            }
                            Button(L("删除", "Delete")) { model.answerDrafts.removeValue(forKey: key); model.answerQuestions.removeValue(forKey: key) }
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
            ConversationStatusLabel(presentation: ConversationPresentation(kind: "waiting", label: L("AI 在等你回答", "The AI is waiting for your answer"), symbol: "hand.raised.fill", tone: "orange")).font(.headline)
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
                        SecureField(L("在这里回答", "Answer here"), text: Binding(get: { answers[id] ?? "" }, set: { setAnswer(id, $0) })).textFieldStyle(.roundedBorder)
                    } else {
                        TextField(L("在这里回答", "Answer here"), text: Binding(get: { answers[id] ?? "" }, set: { setAnswer(id, $0) })).textFieldStyle(.roundedBorder)
                    }
                }
            }
            Button(L("提交回答", "Submit answers")) {
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
            DisclosureGroup(L("此前问题的回答草稿", "Draft answers to earlier questions")) {
                VStack(alignment: .leading, spacing: 9) {
                    Text(L("该问题已结束，草稿不会再次发送。", "This question is closed; the draft will not be sent again.")).font(.caption).foregroundStyle(.secondary)
                    ForEach(Array((model.answerQuestions[key] ?? []).enumerated()), id: \.offset) { _, q in
                        Text(q["question"] as? String ?? "").font(.caption.bold())
                        if q["isSecret"] as? Bool == true {
                            Text(L("私密回答已隐藏", "Private answer hidden")).font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text(model.answerDrafts[key]?[q["id"] as? String ?? ""] ?? "")
                                .textSelection(.enabled).font(.system(size: 13))
                        }
                    }
                    Button(L("删除这份草稿", "Delete this draft")) {
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
                Text(task.who + L(" 需要你", " needs you")).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Spacer()
                Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel(L("稍后处理", "Later"))
            }
            Button(action: open) {
                Text(model.gotoNotes[task.id] ?? task.alert ?? task.task).font(.system(size: 13)).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain)
            HStack {
                Button(L("查看会话", "View session"), action: open)
                Spacer()
                if task.alertTab != nil {
                    Button(L("去处理", "Go handle it")) { model.gotoAlert(task) }.buttonStyle(.borderedProminent)
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
            ServerInfo(id: 101, who: L("Codex · 主目录", "Codex · home folder"), color: 0, version: "0.10.3", startedAt: nowMs(), busy: "wait_for_user", lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:], guiInstance: "demo", conversationThread: "demo-exam", conversationTitle: L("完成一套 IELTS 阅读试卷", "Complete an IELTS reading test"), conversationProvider: "Codex", conversationStatus: "connected"),
            ServerInfo(id: 102, who: L("Codex · 主目录", "Codex · home folder"), color: 3, version: "0.10.3", startedAt: nowMs(), busy: "read_page", lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:], guiInstance: "demo-2", conversationThread: "demo-review", conversationTitle: L("检查模考记录与得分", "Review mock test records and scores"), conversationProvider: "Codex", conversationStatus: "connected")
        ]
        model.servers += (103...114).map { id in
            ServerInfo(id: Int32(id), who: L("Claude · 主目录", "Claude · home folder"), color: 3, version: "0.10.0", startedAt: nowMs(), busy: nil, lastActionAt: nil, root: nil, srcHash: nil, envLocked: [:])
        }
        model.tasks = [AgentTask(id: 101, who: L("Codex · 模考体验", "Codex · mock test"), task: L("完成一套阅读试卷", "Complete a reading test"), stepName: "", current: nil, total: nil, color: 0, etaMs: nil, etaAt: nil,
            alert: L("需要你登录练习网站。登录完成后，我会继续作答。", "Please sign in to the practice site. Once you are signed in, I will continue answering."), alertTab: 10)]
        model.selectedConversation = 101
        model.loadedConversationKey = conversationKey(model.servers[0])
        model.conversation = ConversationState(["threadId": "demo-exam", "status": "connected", "canSend": true, "threadStatus": "active",
            "entries": [["id": "a", "text": L("已经打开试卷，正在确认题目数量和作答方式。", "The test is open. I am checking the number of questions and how to answer them.")], ["id": "b", "text": L("页面要求先登录。我已交还鼠标和键盘，点击上方「去处理」即可回到需要你的页面。", "The page asks you to sign in first. I have handed back the mouse and keyboard; click Go handle it above to return to the page that needs you.")]]])
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
