import SwiftUI
import AppKit
import Combine
import Darwin

// MARK: - Dynamic client catalog and one-shot launcher requests

enum SessionProvider: String, CaseIterable, Identifiable {
    case codex = "Codex", claude = "Claude"
    var id: String { rawValue }
    var title: String { self == .claude ? "Claude Code" : "Codex" }
}

struct SessionModelChoice: Identifiable {
    let id: String, name: String, efforts: [String], defaultEffort: String?
    let isDefault: Bool
    init?(_ object: [String: Any]) {
        guard let id = object["id"] as? String, !id.isEmpty,
              let efforts = object["efforts"] as? [String], efforts.allSatisfy({ !$0.isEmpty }) else { return nil }
        self.id = id
        name = (object["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id
        var seen = Set<String>()
        self.efforts = efforts.filter { seen.insert($0).inserted }
        defaultEffort = (object["defaultEffort"] as? String).flatMap { efforts.contains($0) ? $0 : nil }
        isDefault = object["isDefault"] as? Bool == true
    }
}

func sessionEffortName(_ value: String) -> String {
    ["none": L("不额外思考", "No extra reasoning"), "minimal": L("最少", "Minimal"), "low": L("低", "Low"), "medium": L("中", "Medium"), "high": L("高", "High"),
     "xhigh": L("更高", "Higher"), "max": L("最高", "Highest"), "default": L("默认", "Default"), "auto": L("自动", "Automatic")][value] ?? value
}

struct SessionCreationReceipt: Equatable {
    let pid: Int32, instance: String, threadId: String, bindingId: String
    init?(_ object: [String: Any]) {
        guard object["ok"] as? Bool == true,
              let pid = object["pid"] as? Int, pid > 0, pid <= Int(Int32.max),
              let instance = object["instance"] as? String, !instance.isEmpty,
              let thread = object["threadId"] as? String, !thread.isEmpty,
              let binding = object["bindingId"] as? String, !binding.isEmpty else { return nil }
        self.pid = Int32(pid); self.instance = instance; threadId = thread; bindingId = binding
    }
}

func sessionLaunchMessage(_ code: String, catalog: Bool = false) -> String {
    switch code {
    case "client_missing": return L("未找到这个 AI 客户端。请先安装并登录，再重试。", "This AI client was not found. Install it and sign in, then retry.")
    case "auth_required", "not_authenticated", "login_required", "unauthorized": return L("这个客户端需要登录。请在客户端完成登录后重试。", "This client needs you to sign in. Sign in within the client, then retry.")
    case "invalid_directory": return L("这个工作目录不可用，请重新选择文件夹。", "This working folder is unavailable. Choose a folder again.")
    case "model_unavailable", "effort_unavailable": return L("所选模型或思考强度已不可用，请重新读取模型后再试。", "The chosen model or reasoning effort is no longer available. Reload the models and try again.")
    case "models_unavailable", "catalog_unavailable": return L("暂时无法读取可用模型。请确认客户端已登录，然后重试。", "The available models cannot be read right now. Make sure the client is signed in, then retry.")
    case "node_unavailable": return L("未找到可用的 Node.js。请在入门引导中检查安装。", "No usable Node.js was found. Check the installation in Getting started.")
    case "invalid_prompt", "too_large": return L("首条任务过长或含有无效字符，请缩短后再试。", "The first task is too long or contains invalid characters. Shorten it and try again.")
    case "launch_pending", "timeout", "invalid_response", "connection_lost":
        return catalog ? L("读取模型未完成，请重试。", "Reading the models did not finish. Please retry.") : L("尚未确认创建结果。请点击「检查创建结果」核对同一次请求。", "The result is not confirmed yet. Click Check result to verify the same request.")
    case "session_ended": return L("刚创建的会话已结束。草稿仍保留，可以重新创建。", "The session you just created has ended. Your draft is kept; you can create it again.")
    case "unsafe_session_path": return L("会话保存位置暂不可用。请检查 MyChrome 的本地安装后重试。", "The session storage location is unavailable. Check the local MyChrome installation, then retry.")
    default: return catalog ? L("无法读取可用模型，请确认客户端已安装并登录后重试。", "The available models could not be read. Make sure the client is installed and signed in, then retry.") : L("对话未能创建，输入内容已保留。请重试。", "The conversation was not created. What you entered is kept. Please retry.")
    }
}

protocol SessionLaunchCancellable: AnyObject { func cancel() }

/// Exact executable/argv with JSON on stdin. Output is bounded and stderr is never shown in the GUI.
final class SessionLaunchProcess: SessionLaunchCancellable {
    private let lock = NSLock()
    private var process: Process?
    private var cancelled = false
    func cancel() {
        lock.lock(); cancelled = true; let child = process; lock.unlock()
        if let child, child.isRunning { child.terminate() }
    }
    func start(node: String, root: String, request: [String: Any], timeout: Double,
               done: @escaping ([String: Any]) -> Void) {
        guard node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: node) else {
            done(["ok": false, "code": "node_unavailable", "delivery": "not_sent"]); return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: request), data.count <= 131_072 else {
            done(["ok": false, "code": "too_large", "delivery": "not_sent"]); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let child = Process(), input = Pipe(), output = Pipe()
            child.executableURL = URL(fileURLWithPath: node)
            child.arguments = [root + "/src/session-launcher.js"]
            child.standardInput = input; child.standardOutput = output; child.standardError = FileHandle.nullDevice
            _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
            self.lock.lock()
            if self.cancelled { self.lock.unlock(); DispatchQueue.main.async { done(["ok": false, "code": "cancelled", "delivery": "not_sent"]) }; return }
            do { try child.run(); self.process = child; self.lock.unlock() }
            catch { self.lock.unlock(); DispatchQueue.main.async { done(["ok": false, "code": "node_unavailable", "delivery": "not_sent"]) }; return }
            try? input.fileHandleForReading.close()
            try? output.fileHandleForWriting.close()
            DispatchQueue.global(qos: .userInitiated).async {
                try? input.fileHandleForWriting.write(contentsOf: data)
                try? input.fileHandleForWriting.close()
            }
            let dataLock = NSLock(), drained = DispatchSemaphore(value: 0)
            var response = Data(), oversized = false
            output.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty { handle.readabilityHandler = nil; drained.signal(); return }
                dataLock.lock()
                if response.count + chunk.count <= 262_144 { response.append(chunk) } else { oversized = true }
                dataLock.unlock()
            }
            let deadline = Date().addingTimeInterval(timeout)
            while child.isRunning && Date() < deadline {
                self.lock.lock(); let stopped = self.cancelled; self.lock.unlock()
                if stopped { break }; Thread.sleep(forTimeInterval: 0.02)
            }
            let timedOut = child.isRunning && Date() >= deadline
            if child.isRunning { child.terminate() }
            _ = drained.wait(timeout: .now() + 0.5)
            output.fileHandleForReading.readabilityHandler = nil
            self.lock.lock(); let stopped = self.cancelled; self.process = nil; self.lock.unlock()
            dataLock.lock(); let result = response, tooLarge = oversized; dataLock.unlock()
            let parsed = !tooLarge ? (try? JSONSerialization.jsonObject(with: result)) as? [String: Any] : nil
            let failure = stopped ? "cancelled" : timedOut ? "timeout" : "invalid_response"
            let object = !stopped && !timedOut && parsed?["ok"] is Bool ? parsed!
                : ["ok": false, "code": failure, "delivery": "unknown"]
            DispatchQueue.main.async { done(object) }
        }
    }
}

typealias SessionLauncher = (String, String, [String: Any], Double, @escaping ([String: Any]) -> Void) -> SessionLaunchCancellable
func runSessionLauncher(node: String, root: String, request: [String: Any], timeout: Double,
                        done: @escaping ([String: Any]) -> Void) -> SessionLaunchCancellable {
    let process = SessionLaunchProcess()
    process.start(node: node, root: root, request: request, timeout: timeout, done: done)
    return process
}

final class NewSessionModel: ObservableObject {
    @Published private(set) var provider = SessionProvider.codex
    @Published private(set) var cwd = ""
    @Published private(set) var models: [SessionModelChoice] = []
    @Published private(set) var modelId: String?
    @Published private(set) var effort: String?
    @Published private(set) var prompt = ""
    @Published private(set) var loading = false
    @Published private(set) var creating = false
    @Published private(set) var uncertain = false
    @Published private(set) var receipt: SessionCreationReceipt?
    @Published var catalogError: String?
    @Published var createError: String?
    private let root: String, launcher: SessionLauncher
    private var node: String?
    private var catalogGeneration = 0, createGeneration = 0
    private var catalogTask: SessionLaunchCancellable?, createTask: SessionLaunchCancellable?
    private var pendingRequest: [String: Any]?
    private var visible = false
    init(root: String = ROOT_DIR, launcher: @escaping SessionLauncher = runSessionLauncher) {
        self.root = root; self.launcher = launcher
    }
    var selectedModel: SessionModelChoice? { models.first { $0.id == modelId } }
    var canEdit: Bool { !creating && !uncertain && receipt == nil }
    var canCreate: Bool { !loading && !creating && receipt == nil && selectedModel != nil && !cwd.isEmpty }
    func present(node: String?, defaultDirectory: String) {
        visible = true; self.node = node
        if cwd.isEmpty { cwd = defaultDirectory }
        if receipt == nil && !uncertain && !creating { loadCatalog() }
    }
    func dismiss() {
        guard !creating else { return }
        visible = false; catalogGeneration += 1; catalogTask?.cancel(); catalogTask = nil; loading = false
    }
    func stop() {
        visible = false; catalogGeneration += 1; createGeneration += 1
        catalogTask?.cancel(); createTask?.cancel(); catalogTask = nil; createTask = nil; loading = false; creating = false
    }
    func chooseProvider(_ value: SessionProvider) {
        guard canEdit, provider != value else { return }
        provider = value; clearCatalog(); loadCatalog()
    }
    func chooseDirectory(_ value: String) {
        guard canEdit, cwd != value else { return }
        cwd = value; loadCatalog()
    }
    func chooseModel(_ id: String) {
        guard canEdit, !loading, let choice = models.first(where: { $0.id == id }), modelId != id else { return }
        modelId = id; effort = choice.defaultEffort; createError = nil
    }
    func chooseEffort(_ value: String?) {
        guard canEdit, !loading, value == nil || selectedModel?.efforts.contains(value!) == true else { return }
        effort = value; createError = nil
    }
    func setPrompt(_ value: String) { if canEdit { prompt = value; createError = nil } }
    private func clearCatalog() { models = []; modelId = nil; effort = nil; catalogError = nil; createError = nil }
    func loadCatalog() {
        guard visible, canEdit else { return }
        catalogGeneration += 1; let generation = catalogGeneration
        catalogTask?.cancel(); catalogError = nil; createError = nil
        guard let node, node.hasPrefix("/") else { clearCatalog(); catalogError = sessionLaunchMessage("node_unavailable", catalog: true); return }
        loading = true
        let expectedProvider = provider.rawValue, oldModel = modelId, oldEffort = effort
        catalogTask = launcher(node, root, ["op": "catalog", "provider": expectedProvider, "cwd": cwd], 45) { [weak self] response in
            guard let self, self.visible, self.catalogGeneration == generation else { return }
            self.loading = false; self.catalogTask = nil
            guard response["ok"] as? Bool == true, response["provider"] as? String == expectedProvider,
                  let rows = response["models"] as? [[String: Any]], !rows.isEmpty else {
                self.clearCatalog(); self.catalogError = sessionLaunchMessage(response["code"] as? String ?? "models_unavailable", catalog: true); return
            }
            let choices = rows.compactMap(SessionModelChoice.init)
            guard choices.count == rows.count, Set(choices.map(\.id)).count == choices.count else {
                self.clearCatalog(); self.catalogError = sessionLaunchMessage("models_unavailable", catalog: true); return
            }
            self.models = choices
            let choice = choices.first(where: { $0.id == oldModel }) ?? choices.first(where: \.isDefault) ?? choices[0]
            self.modelId = choice.id
            self.effort = choice.id == oldModel && (oldEffort == nil || oldEffort.map(choice.efforts.contains) == true)
                ? oldEffort : choice.defaultEffort
        }
    }
    func create(_ onCreated: @escaping (SessionCreationReceipt) -> Void) {
        guard canCreate, let node, node.hasPrefix("/") else { return }
        let request: [String: Any]
        if uncertain, let pendingRequest { request = pendingRequest }
        else {
            request = ["op": "create", "provider": provider.rawValue, "model": modelId ?? "", "effort": effort as Any? ?? NSNull(),
                       "cwd": cwd, "prompt": prompt, "nonce": UUID().uuidString]
            pendingRequest = request
        }
        creating = true; createError = nil; createGeneration += 1; let generation = createGeneration
        createTask = launcher(node, root, request, 65) { [weak self] response in
            guard let self, self.createGeneration == generation else { return }
            self.creating = false; self.createTask = nil
            if let receipt = SessionCreationReceipt(response) {
                self.uncertain = false; self.receipt = receipt; onCreated(receipt); return
            }
            self.uncertain = response["ok"] as? Bool == true || response["delivery"] as? String == "unknown"
            if !self.uncertain { self.pendingRequest = nil }
            self.createError = sessionLaunchMessage(self.uncertain ? "launch_pending" : response["code"] as? String ?? "launch_failed")
        }
    }
    func checkCreation(_ onCreated: @escaping (SessionCreationReceipt) -> Void) {
        guard !creating, receipt != nil, pendingRequest != nil else { return }
        receipt = nil; uncertain = true
        create(onCreated)
    }
    func finishCreation() {
        receipt = nil; pendingRequest = nil; uncertain = false; prompt = ""; createError = nil
        dismiss()
    }
}

// MARK: - Native form and exact-session selection

func createdSession(_ receipt: SessionCreationReceipt, among servers: [ServerInfo]) -> ServerInfo? {
    servers.first { $0.managedSession && $0.id == receipt.pid && $0.guiInstance == receipt.instance &&
        $0.conversationThread == receipt.threadId && $0.conversationBinding == receipt.bindingId }
}
func sessionDirectoryName(_ directory: String, home: String = NSHomeDirectory()) -> String {
    directory == home ? L("主目录", "Home folder") : (directory as NSString).lastPathComponent
}
func sessionDirectoryPath(_ directory: String, home: String = NSHomeDirectory()) -> String {
    directory == home ? "~" : directory.hasPrefix(home + "/") ? "~" + directory.dropFirst(home.count) : directory
}

extension Model {
    var newSessionNode: String? { onboardingNode(root: ROOT_DIR, connectedNodes: servers.filter { sameRoot($0.root) }.compactMap(\.node)) }
    func showNewSession() {
        let recent = chosenServer?.cwd ?? servers.sorted { $0.startedAt > $1.startedAt }.compactMap(\.cwd).first
        newSession.present(node: newSessionNode, defaultDirectory: recent ?? NSHomeDirectory())
        newSessionPresented = true
    }
    func connectCreatedSession(_ receipt: SessionCreationReceipt) {
        let current = namedConversations(liveServers())
        guard let server = createdSession(receipt, among: current) else {
            newSession.createError = L("对话已创建，连接尚未就绪。请点击「打开已创建的对话」重试。", "The conversation was created, but its connection is not ready yet. Click Open created conversation to retry."); return
        }
        let shouldSend = seedCreatedSessionDraft(server, prompt: newSession.prompt)
        if chosenServer.map(conversationKey) != conversationKey(server) { selectedConversation = nil }
        servers = current; workspaceDestination = "conversations"; conversationVisible = true
        selectConversation(server)
        newSession.finishCreation(); newSessionPresented = false
        openConversations?(server.id)
        if shouldSend { sendConversation(server) }
    }
}

struct NewSessionSheet: View {
    @ObservedObject var state: NewSessionModel
    @ObservedObject var model: Model
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text(L("新对话", "New conversation")).font(.title2.bold())
                Text(L("选择 AI、模型和工作目录，然后在这里聊天。", "Choose an AI, a model and a working folder, then chat here.")).font(.callout).foregroundStyle(.secondary)
            }
            Picker(L("AI 客户端", "AI client"), selection: Binding(get: { state.provider }, set: state.chooseProvider)) {
                ForEach(SessionProvider.allCases) { provider in Text(provider.title).tag(provider) }
            }.pickerStyle(.segmented).labelsHidden().disabled(!state.canEdit)
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(L("模型", "Model")).font(.headline)
                    if state.loading { ProgressView().controlSize(.small); Text(L("正在读取…", "Reading…")).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button(L("重新读取", "Reload")) { state.loadCatalog() }.disabled(state.loading || !state.canEdit)
                }
                if !state.models.isEmpty {
                    Picker(L("模型", "Model"), selection: Binding(get: { state.modelId ?? "" }, set: state.chooseModel)) {
                        ForEach(state.models) { choice in Text(choice.name + (choice.isDefault ? L("（默认）", " (default)") : "")).tag(choice.id) }
                    }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading).disabled(state.loading || !state.canEdit)
                    if let choice = state.selectedModel, !choice.efforts.isEmpty {
                        Picker(L("思考强度", "Reasoning effort"), selection: Binding<String?>(get: { state.effort }, set: state.chooseEffort)) {
                            Text(L("跟随客户端设置", "Client setting")).tag(nil as String?)
                            ForEach(choice.efforts, id: \.self) { Text(sessionEffortName($0)).tag(Optional($0)) }
                        }.disabled(state.loading || !state.canEdit)
                    }
                }
                if let error = state.catalogError { Text(error).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(L("工作目录", "Working folder")).font(.headline)
                HStack {
                    Label(sessionDirectoryName(state.cwd), systemImage: "folder").lineLimit(1)
                    Spacer()
                    Button(L("选择文件夹…", "Choose folder…"), action: chooseDirectory).disabled(!state.canEdit)
                }
                Text(sessionDirectoryPath(state.cwd)).font(.caption).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(L("第一条任务（可选）", "First task (optional)")).font(.headline)
                TextEditor(text: Binding(get: { state.prompt }, set: state.setPrompt))
                    .font(.system(size: 14)).frame(height: 100).padding(6)
                    .background(Color(nsColor: .textBackgroundColor))
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.secondary.opacity(0.25)))
                    .disabled(!state.canEdit).accessibilityLabel(L("第一条任务（可选）", "First task (optional)"))
                Text(L("可以先创建空对话，稍后再输入。关闭此表单会保留草稿，直到退出 MyChrome。", "You can create an empty conversation and type later. Closing this form keeps your draft until you quit MyChrome."))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = state.createError { Text(error).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            Divider()
            HStack {
                Button(state.receipt != nil || state.uncertain ? L("稍后查看", "Check later") : L("取消", "Cancel")) {
                    state.dismiss(); model.newSessionPresented = false
                }.keyboardShortcut(.cancelAction).disabled(state.creating)
                Spacer()
                if state.creating { ProgressView().controlSize(.small); Text(L("正在创建…", "Creating…")).font(.callout).foregroundStyle(.secondary) }
                if state.receipt != nil {
                    Button(L("打开已创建的对话", "Open created conversation")) { state.checkCreation { model.connectCreatedSession($0) } }
                        .buttonStyle(.borderedProminent).disabled(state.creating)
                } else {
                    Button(state.uncertain ? L("检查创建结果", "Check result") : L("创建对话", "Create conversation")) { state.create { model.connectCreatedSession($0) } }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(!state.canCreate)
                }
            }
        }.padding(26).frame(width: 510).interactiveDismissDisabled(state.creating)
            .onDisappear { state.dismiss() }
    }
    func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.title = L("选择工作目录", "Choose a working folder"); panel.prompt = L("选择此文件夹", "Choose this folder")
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: state.cwd)
        panel.begin { result in
            if result == .OK, let directory = panel.url { state.chooseDirectory(directory.path) }
        }
    }
}
