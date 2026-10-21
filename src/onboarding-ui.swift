import SwiftUI
import AppKit
import Combine

// MARK: - Small independent preference and read-only setup commands

func onboardingEnglish(environment: [String: String] = ProcessInfo.processInfo.environment,
                       languages: [String] = Locale.preferredLanguages) -> Bool {
    if let language = environment["CHROME_BRIDGE_LANG"], !language.isEmpty { return !language.lowercased().hasPrefix("zh") }
    return !(languages.first ?? "en").lowercased().hasPrefix("zh")
}
func onboardingText(_ zh: String, _ en: String) -> String { onboardingEnglish() ? en : zh }

struct OnboardingPreferenceStore {
    let path: String
    init(path: String = envPath("CHROME_BRIDGE_ONBOARDING", SUPPORT_DIR + "/onboarding.json")) { self.path = path }
    // A future or damaged preference is preserved; the guide is always reachable manually.
    var stored: [String: Any]? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.size] as? NSNumber)?.intValue ?? 4097 <= 4096,
              let data = FileManager.default.contents(atPath: path),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["kind"] as? String == "mychrome-onboarding", object["version"] as? Int == 1 else { return nil }
        return object
    }
    var exists: Bool { (try? FileManager.default.attributesOfItem(atPath: path)) != nil }
    var shouldAutoPresent: Bool { !exists || stored?["presented"] as? Bool == false }
    @discardableResult func save(dismissal: String, english: Bool) -> Bool {
        guard ["presented", "skipped", "reviewed"].contains(dismissal), !exists || stored != nil else { return false }
        let object: [String: Any] = ["kind": "mychrome-onboarding", "version": 1, "presented": true,
                                     "dismissal": dismissal, "language": english ? "en" : "zh"]
        do {
            try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                                                    withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
            return true
        } catch { return false }
    }
}

func onboardingNode(root: String, connectedNodes: [String], environment: [String: String] = ProcessInfo.processInfo.environment,
                    bundled: String? = Bundle.main.object(forInfoDictionaryKey: "MyChromeNodePath") as? String) -> String? {
    let candidates = [bundled, environment["CHROME_BRIDGE_NODE"]].compactMap { $0 } + connectedNodes +
        (environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/node" } +
        ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    return candidates.first { $0.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: $0) }
}

struct OnboardingCheck: Identifiable {
    let id: String, title: String, detail: String, fix: String
    let required: Bool, ok: Bool, skipped: Bool
    init(_ object: [String: Any]) {
        id = object["id"] as? String ?? "unknown"
        title = object["title"] as? String ?? id
        detail = object["detail"] as? String ?? ""
        fix = object["fix"] as? String ?? ""
        required = object["required"] as? Bool ?? true
        ok = object["ok"] as? Bool ?? false
        skipped = object["skipped"] as? Bool ?? false
    }
    func localized(_ text: String, english: Bool, title: Bool = false) -> String {
        let parts = text.components(separatedBy: title ? " / " : "\n")
        return english && parts.count > 1 ? parts.dropFirst().joined(separator: title ? " / " : "\n") : parts[0]
    }
}
struct OnboardingReport {
    let checks: [OnboardingCheck]
    let app: String?
    let passed: Bool
    init?(_ object: [String: Any]) {
        guard object["schemaVersion"] as? Int == 1,
              let preflight = object["preflight"] as? [String: Any],
              let prerequisites = preflight["checks"] as? [[String: Any]], !prerequisites.isEmpty else { return nil }
        let doctor = object["doctor"] as? [String: Any]
        let permissions = doctor?["checks"] as? [[String: Any]] ?? []
        checks = prerequisites.map(OnboardingCheck.init) + permissions.map(OnboardingCheck.init)
        app = doctor?["app"] as? String
        passed = object["ok"] as? Bool == true && doctor?["ok"] as? Bool == true && !permissions.isEmpty &&
            checks.filter(\.required).allSatisfy { $0.ok && !$0.skipped }
    }
}

protocol OnboardingCancellable: AnyObject { func cancel() }

/// One local child, never a shell. All reads happen off the main thread; close/exit cancels it.
final class OnboardingProcess: OnboardingCancellable {
    private let lock = NSLock()
    private var process: Process?
    private var cancelled = false
    func cancel() {
        lock.lock(); cancelled = true; let child = process; lock.unlock()
        if let child, child.isRunning { child.terminate() }
    }
    func start(executable: String, arguments: [String], timeout: Double = 45,
               done: @escaping ([String: Any]?, String?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let child = Process(), output = Pipe()
            child.executableURL = URL(fileURLWithPath: executable); child.arguments = arguments
            child.standardInput = FileHandle.nullDevice; child.standardOutput = output; child.standardError = FileHandle.nullDevice
            self.lock.lock()
            if self.cancelled { self.lock.unlock(); DispatchQueue.main.async { done(nil, "cancelled") }; return }
            do { try child.run(); self.process = child; self.lock.unlock() }
            catch { self.lock.unlock(); DispatchQueue.main.async { done(nil, "unavailable") }; return }
            let dataLock = NSLock()
            let drained = DispatchSemaphore(value: 0)
            var data = Data(), oversized = false
            output.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty { handle.readabilityHandler = nil; drained.signal(); return }
                dataLock.lock()
                if data.count + chunk.count <= 262_144 { data.append(chunk) } else { oversized = true }
                dataLock.unlock()
            }
            let deadline = Date().addingTimeInterval(timeout)
            while child.isRunning && Date() < deadline {
                self.lock.lock(); let stopped = self.cancelled; self.lock.unlock()
                if stopped { break }; Thread.sleep(forTimeInterval: 0.02)
            }
            let timedOut = child.isRunning && Date() >= deadline
            if child.isRunning { child.terminate() }
            // Bounded drain: a descendant retaining stdout must not keep the guide waiting.
            _ = drained.wait(timeout: .now() + 0.5)
            output.fileHandleForReading.readabilityHandler = nil
            let exitCode = child.isRunning ? nil : child.terminationStatus
            self.lock.lock(); let stopped = self.cancelled; self.process = nil; self.lock.unlock()
            dataLock.lock(); let result = data, tooLarge = oversized; dataLock.unlock()
            let object = !tooLarge ? (try? JSONSerialization.jsonObject(with: result)) as? [String: Any] : nil
            DispatchQueue.main.async {
                done(object, stopped ? "cancelled" : timedOut ? "timeout" : tooLarge ? "invalid_response"
                    : exitCode != 0 && exitCode != 1 ? "process_failed" : object == nil ? "invalid_response" : nil)
            }
        }
    }
}

typealias OnboardingRunner = (String, String, Bool, @escaping ([String: Any]?, String?) -> Void) -> OnboardingCancellable
func runOnboardingSetup(node: String, root: String, check: Bool, done: @escaping ([String: Any]?, String?) -> Void) -> OnboardingCancellable {
    let process = OnboardingProcess()
    var arguments = [root + "/scripts/setup.mjs", check ? "--check" : "--instructions", "--json"]
    if Bundle.main.bundleURL.pathExtension == "app" { arguments += ["--app-path", Bundle.main.bundleURL.path] }
    process.start(executable: node, arguments: arguments, done: done)
    return process
}

final class OnboardingModel: ObservableObject {
    @Published var step = 0
    @Published var english = onboardingEnglish()
    @Published var loading = false
    @Published var checking = false
    @Published var report: OnboardingReport?
    @Published var instructions: [String: Any] = [:]
    @Published var note: String?
    @Published var persistenceFailed = false
    let root: String
    let store: OnboardingPreferenceStore
    private let runner: OnboardingRunner
    private var generation = 0
    private var diagnostic: OnboardingCancellable?
    private(set) var visible = false
    private(set) var presentedThisSession = false
    init(root: String = ROOT_DIR, store: OnboardingPreferenceStore = OnboardingPreferenceStore(),
         runner: @escaping OnboardingRunner = runOnboardingSetup) {
        self.root = root; self.store = store; self.runner = runner
    }
    func t(_ zh: String, _ en: String) -> String { english ? en : zh }
    var shouldAutoPresent: Bool { !presentedThisSession && store.shouldAutoPresent }
    func present(node: String?) {
        visible = true
        if !presentedThisSession {
            if ProcessInfo.processInfo.environment["CHROME_BRIDGE_LANG"]?.isEmpty ?? true,
               let language = store.stored?["language"] as? String { english = language == "en" }
            presentedThisSession = true
            persistenceFailed = !store.save(dismissal: "presented", english: english)
        }
        if instructions.isEmpty { request(node: node, check: false) }
    }
    func dismiss(reviewed: Bool = false) {
        visible = false; generation += 1; diagnostic?.cancel(); diagnostic = nil; checking = false; loading = false
        persistenceFailed = !store.save(dismissal: reviewed ? "reviewed" : "skipped", english: english)
    }
    func stop() {
        visible = false; generation += 1; diagnostic?.cancel(); diagnostic = nil; checking = false; loading = false
    }
    func request(node: String?, check: Bool) {
        guard visible, !loading else { return }
        generation += 1; let request = generation
        diagnostic?.cancel(); report = check ? nil : report; note = nil
        guard let node, node.hasPrefix("/") else {
            note = t("未找到 Node.js。请先完成源码安装，再重新打开引导。", "Node.js was not found. Complete source setup, then reopen this guide.")
            return
        }
        loading = true; checking = check
        diagnostic = runner(node, root, check) { [weak self] object, error in
            guard let self, self.visible, self.generation == request else { return }
            self.loading = false; self.checking = false; self.diagnostic = nil
            guard error == nil, let object, object["schemaVersion"] as? Int == 1 else {
                self.note = self.t("检查未完成。请重试，或复制诊断命令到 AI 客户端使用的终端中运行。", "The check did not finish. Retry, or run the diagnostic command in your AI client's terminal."); return
            }
            let hasInstructions = object["connection"] is [String: Any] && object["commands"] is [String: Any]
            if hasInstructions { self.instructions = object }
            if check {
                self.report = OnboardingReport(object)
                if self.report == nil { self.note = self.t("检查结果无法读取，请重试。", "The check returned an unreadable result. Please retry.") }
            } else if !hasInstructions {
                self.note = self.t("未能读取安装说明，请重试或打开安装帮助。", "Setup instructions could not be loaded. Please retry or open setup help.")
            }
        }
    }
    func command(_ key: String, group: String = "commands") -> String? { (instructions[group] as? [String: Any])?[key] as? String }
    var firstTaskPrompt: String? {
        let values = instructions["firstTask"] as? [String: Any]
        return values?[english ? "prompt" : "promptZh"] as? String ?? values?["prompt"] as? String
    }
}

// MARK: - Native guide

struct OnboardingView: View {
    @ObservedObject var state: OnboardingModel
    @ObservedObject var model: Model
    let close: (Bool) -> Void
    @State private var copied: String?
    var node: String? { onboardingNode(root: state.root, connectedNodes: model.servers.filter { sameRoot($0.root) }.compactMap(\.node)) }
    var stageNames: [String] { [state.t("安装与权限", "Installation"), state.t("连接 AI", "Connect AI"), state.t("随时叫 AI 接手", "AI on your page"), state.t("接手与习惯", "Handoff & habits")] }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(state.t("需要时，让 AI 接手", "Bring AI in when you need it.")).font(.system(size: 25, weight: .semibold))
                    Text(state.t("在你当前的 Chrome 页面继续任务，按你的节奏操作。", "Continue on your current Chrome page, at your pace.")).foregroundStyle(.secondary)
                }
                Spacer()
                Picker("Language", selection: $state.english) { Text("中文").tag(false); Text("English").tag(true) }
                    .labelsHidden().frame(width: 105)
            }.padding(24)
            HStack(spacing: 10) {
                ForEach(0..<4) { index in
                    Button { state.step = index; copied = nil } label: {
                        HStack(spacing: 7) {
                            Text("\(index + 1)").font(.caption.bold()).frame(width: 22, height: 22)
                                .background(state.step == index ? Color.accentColor : Color.secondary.opacity(0.15), in: Circle())
                                .foregroundStyle(state.step == index ? Color.white : Color.primary)
                            Text(stageNames[index]).font(.callout.weight(state.step == index ? .semibold : .regular))
                        }.frame(maxWidth: .infinity).padding(.vertical, 8).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 20).padding(.bottom, 14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if state.step == 0 { installation }
                    else if state.step == 1 { connection }
                    else if state.step == 2 { firstTask }
                    else { controls }
                    if let note = state.note { Text(note).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
                    if state.persistenceFailed { Text(state.t("无法保存引导偏好；下次启动可能再次显示。", "The guide preference could not be saved; it may appear again at launch.")).font(.caption).foregroundStyle(.secondary) }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                Button(state.t("稍后再看", "Skip for now")) { close(false) }
                if let copied { Text(copied).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                Spacer()
                if state.step > 0 { Button(state.t("上一步", "Back")) { state.step -= 1; copied = nil } }
                Button(state.step == 3 ? state.t("关闭引导", "Close guide") : state.t("下一步", "Continue")) {
                    if state.step == 3 { close(true) } else { state.step += 1; copied = nil }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }.padding(20)
        }.frame(minWidth: 760, minHeight: 620).background(Color(nsColor: .windowBackgroundColor))
    }
    func heading(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) { Text(title).font(.title3.bold()); Text(text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
    }
    func copy(_ text: String, label: String) {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        copied = state.t("已复制：", "Copied: ") + label
    }
    @ViewBuilder func command(_ key: String, label: String, group: String = "commands") -> some View {
        if let text = state.command(key, group: group), !text.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Text(label).font(.callout.bold()); Spacer(); Button(state.t("复制", "Copy")) { copy(text, label: label) } }
                Text(text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }.padding(12).background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 9))
        }
    }
    var installation: some View {
        VStack(alignment: .leading, spacing: 16) {
            heading(state.t("先检查这台 Mac", "Check this Mac first"), state.t("需要 Apple Silicon Mac、Google Chrome、受支持的 Node.js 和编译好的助手。权限由你在 macOS 设置中决定。", "You need an Apple Silicon Mac, Google Chrome, supported Node.js and the built helpers. You choose permissions in macOS Settings."))
            HStack {
                Button(state.checking ? state.t("正在检查…", "Checking…") : state.t("检查安装与权限", "Check installation & permissions")) { state.request(node: node, check: true) }.disabled(state.loading)
                if state.loading { ProgressView().controlSize(.small) }
                Button(state.t("安装帮助", "Setup help")) { openHelp() }
            }
            Text(state.t("检查不会弹出授权请求。结果只适用于下方列出的检查宿主；AI 客户端所用的 App 可能需要单独授权。", "Checks do not request permission. Results apply only to the host named below; the app hosting your AI client may need its own permission.")).font(.callout).foregroundStyle(.secondary)
            if let report = state.report {
                Label(report.passed ? state.t("当前宿主的检查已通过", "This host's checks passed") : state.t("还有项目需要处理或确认", "Some items need attention or verification"), systemImage: report.passed ? "checkmark.circle" : "exclamationmark.circle")
                    .foregroundStyle(report.passed ? Color.green : Color.orange)
                if let app = report.app { Text(state.t("检查宿主：", "Checked host: ") + app).font(.caption).foregroundStyle(.secondary) }
                ForEach(Array(report.checks.enumerated()), id: \.offset) { _, check in
                    VStack(alignment: .leading, spacing: 5) {
                        Label(check.localized(check.title, english: state.english, title: true), systemImage: check.skipped ? "circle.dotted" : check.ok ? "checkmark.circle.fill" : "exclamationmark.circle")
                            .font(.callout.bold()).foregroundStyle(check.ok && !check.skipped ? Color.green : Color.secondary)
                        Text(check.localized(check.detail, english: state.english)).font(.callout).textSelection(.enabled)
                        if !check.ok, !check.fix.isEmpty { Text(check.localized(check.fix, english: state.english)).font(.callout).foregroundStyle(.secondary).textSelection(.enabled) }
                        if let url = settingsURL(check.id), !check.ok { Button(state.t("打开系统设置", "Open System Settings")) { NSWorkspace.shared.open(url) } }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 9))
                }
            } else if !state.checking { Text(state.t("尚未检查；打开引导不会自动判断权限已就绪。", "Not checked yet. Opening this guide does not establish permission readiness.")).foregroundStyle(.secondary) }
            command("doctor", label: state.t("只读诊断命令", "Read-only diagnostic command"))
            Text(state.t("首次浏览器操作可能触发 macOS 的自动化授权。只在你准备好时允许；需要授权提示时，在 AI 客户端使用的终端运行下方命令。", "The first browser action may trigger macOS Automation consent. Allow it when you are ready; to request consent explicitly, run the command below in your AI client's terminal.")).font(.callout).foregroundStyle(.secondary)
            command("doctorAsk", label: state.t("手动请求自动化授权", "Manually request Automation consent"))
        }
    }
    var connection: some View {
        VStack(alignment: .leading, spacing: 16) {
            heading(state.t("连接你使用的 AI 客户端", "Connect your AI client"), state.t("复制适合你的配置。已有 MyChrome 注册时，先检查并更新原条目，避免重复添加。引导不会修改客户端配置。", "Copy the setup for your client. If MyChrome is already registered, inspect and update that entry to avoid duplicates. This guide does not edit client configuration."))
            Label(model.servers.isEmpty ? state.t("尚未检测到 MCP 连接", "No MCP connection detected yet") : state.t("检测到 \(model.servers.count) 个 MCP 连接；不代表任务已完成", "Detected \(model.servers.count) MCP connection(s); this does not confirm a completed task"), systemImage: model.servers.isEmpty ? "cable.connector" : "link")
                .foregroundStyle(model.servers.isEmpty ? Color.secondary : Color.accentColor)
            command("codexCommand", label: "Codex CLI", group: "connection")
            if let note = state.command("codexNote", group: "connection") {
                Text(state.english ? note : "在 ~/.codex/config.toml 找到已有的 [mcp_servers.mychrome] 条目，按下方配置更新，不要重复添加同名段落。仅运行注册命令不会设置所需的 900 秒工具超时。")
                    .font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            command("codexConfig", label: state.t("Codex 配置（含工具超时）", "Codex configuration (with tool timeout)"), group: "connection")
            Text(state.t("Codex：浏览器 MCP 工具可用。GUI 实时文字与直接回复还要求受支持的宿主，并关联到具体对话。", "Codex: browser MCP tools are supported. Live text and direct replies in the GUI also require a supported host and an explicitly linked conversation.")).font(.callout).foregroundStyle(.secondary)
            command("claudeCommand", label: "Claude Code", group: "connection")
            command("claudeDesktopConfig", label: "Claude Desktop", group: "connection")
            Text(state.t("Claude：浏览器工具和网页接手可用；当前不支持在此 GUI 显示实时对话或直接回复 Claude 终端会话。", "Claude: browser tools and page handoff are supported. Live conversation text and direct replies to Claude terminal sessions are currently unsupported in this GUI.")).font(.callout).foregroundStyle(.secondary)
            Text(state.t("保存后重新连接客户端的 MCP，确认 MyChrome 工具出现，再回到原有 AI 对话继续你的任务。", "After saving, reconnect MCP in your client and confirm that MyChrome tools appear, then return to your existing AI conversation to continue your task.")).font(.callout)
            Button(state.t("重新读取安装说明", "Reload setup instructions")) { state.request(node: node, check: false) }.disabled(state.loading)
        }
    }
    var firstTask: some View {
        VStack(alignment: .leading, spacing: 16) {
            heading(state.t("随时叫 AI 接手", "Bring AI into your page"), state.t("照常使用 Chrome，需要帮忙时回到已连接 MyChrome 的 AI 对话。说明想完成什么，并指明已打开页面的标题或 URL；如果之前已说清楚任务，可直接使用下面的接续请求。", "Browse Chrome as usual. When you need help, return to the AI conversation connected to MyChrome. State your goal and identify the open page by title or URL. If you already described the task, use the continuation request below."))
            if let prompt = state.firstTaskPrompt {
                Text(prompt).id(state.english).font(.callout).textSelection(.enabled).padding(14).background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 9))
                Button(state.t("复制接续请求并关闭引导", "Copy request and close guide")) {
                    copy(prompt, label: state.t("接续请求", "Continuation request")); close(true)
                }.buttonStyle(.borderedProminent)
                Text(state.t("复制后切回原有 AI 对话并发送。引导不会替你发送请求。", "Switch back to your existing AI conversation and send the copied request. The guide does not send it for you.")).font(.caption).foregroundStyle(.secondary)
            }
            heading(state.t("AI 操作，需要你时交回同一页", "AI works, then hands the same page back when needed"), state.t("AI 先读取实际页面并核对目标，再在授权范围内做事。密码、验证码等需要你时，把该页面交回给你；你明确说继续后，它重新读取同一页并接着原任务做。目标或授权不明确、页面受阻时也会暂停，无需每一步确认。", "The AI reads the actual page, checks your goal, and works within your authorization. When a password, verification code or another step needs you, it hands that page back. After you explicitly ask it to continue, it rereads the same page and resumes the original task. It also pauses for unclear targets or authorization and blocked pages; you do not need to confirm every step."))
            Text(state.t("任务是否完成，以真实结果和你的目标为准。连接成功或复制请求不代表任务完成。操作中可快速连按两次 Esc 停止并接手。", "Check completion against your goal and the actual result. A connection or copied request does not complete the task. Press Esc twice quickly during an action to stop and take over.")).font(.callout).foregroundStyle(.secondary)
            Button(state.t("关闭引导", "Close guide")) { close(true) }
        }
    }
    var controls: some View {
        VStack(alignment: .leading, spacing: 20) {
            heading(state.t("停止：0.8 秒内连按两次 Esc", "Stop: press Esc twice within 0.8 seconds"), state.t("真实鼠标键盘被接管时，用键盘立即停止当前操作。空闲时可在会话中心点「暂停 AI 操作」，阻止后续操作。", "During mouse and keyboard takeover, use the keyboard to stop the current action immediately. While idle, Pause AI operations in the workspace blocks further actions."))
            heading(state.t("按你的打字和鼠标习惯操作", "Use your typing and mouse habits"), state.t("在「操作设置」选择自动、按键或粘贴，并调整按键、鼠标与滚动速度。在「我的操作习惯」录制并启用你的打字和鼠标节奏。粘贴会使用剪贴板；环境变量固定的设置会注明，当前界面不能覆盖。", "In Operation Settings, choose automatic, keys or paste and adjust keyboard, mouse and scrolling speed. In My operation habits, record and enable your typing and mouse rhythm. Paste uses the clipboard. Settings fixed by environment variables are labeled and cannot be overridden here."))
            heading(state.t("需要本人处理时，交回同一页面", "Take over on the same page when needed"), state.t("密码、验证码等需要你时，AI 交回鼠标和键盘。点「去处理」回到该会话正在等待的确切页面，自行完成后，在原 AI 对话明确说继续；AI 再读取同一页面，接着原任务做。看到阻挡时不要反复重试。", "For passwords, verification codes or other steps that need you, the AI releases the mouse and keyboard. Use Go handle it to reach the exact page waiting for you. Complete the step, then explicitly ask the AI to continue in your original conversation. It rereads the same page and resumes the original task. Do not repeatedly retry a blocked page."))
            heading(state.t("连接不见了", "If a connection disappears"), state.t("在 AI 客户端重新连接 MCP，再查看会话中心。需要实时回复时重新关联具体 Codex 对话。随时从顶部问号或菜单的「入门引导」回到这里。", "Reconnect MCP in your AI client, then check the workspace. For live replies, link the specific Codex conversation again. Reopen this guide from the question mark or Getting started in the menu."))
            Button(state.t("打开操作设置", "Open operation settings")) { model.openConversations?(nil); model.workspaceDestination = "settings"; close(true) }
        }
    }
    func settingsURL(_ id: String) -> URL? {
        let panes = ["automation": "Privacy_Automation", "accessibility": "Privacy_Accessibility", "screen_recording": "Privacy_ScreenCapture"]
        return panes[id].flatMap { URL(string: "x-apple.systempreferences:com.apple.preference.security?" + $0) }
    }
    func openHelp() {
        let page = state.english ? "getting-started.html" : "zh/getting-started.html"
        NSWorkspace.shared.open(URL(string: "https://shuaige121.github.io/mychrome-mcp/" + page)!)
    }
}
