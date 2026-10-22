import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Production native state/process code, with a synthetic callback queue and local
// stdin-only Node fixture. No AI client, AppKit window, user configuration or IPC.
const source = readFileSync(new URL('../src/new-session-ui.swift', import.meta.url), 'utf8');
const menu = readFileSync(new URL('../src/menubar.swift', import.meta.url), 'utf8');
function block(text, marker) {
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `Missing production declaration: ${marker}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  assert.fail(`Incomplete declaration: ${marker}`);
}
const core = source.slice(0, source.indexOf('// MARK: - Native form'));
const directory = mkdtempSync(path.join(os.tmpdir(), 'mychrome-new-session-tests-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const fixtureRoot = path.join(directory, "source with ' quote and spaces");
const earlyRoot = path.join(directory, 'early-exit');
const fixture = `import fs from 'node:fs';
if (process.argv[1].includes('early-exit')) process.exit(1);
let input=''; for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
if (request.mode==='hang') { fs.writeFileSync(request.pidFile, String(process.pid)); setInterval(()=>{}, 50); }
else if (request.mode==='oversized') console.log(JSON.stringify({ok:true, text:'x'.repeat(300000)}));
else if (request.mode==='invalid') console.log('not JSON');
else console.log(JSON.stringify({ok:true, request, argv:process.argv.slice(2)}));
`;
for (const root of [fixtureRoot, earlyRoot]) {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/session-launcher.js'), fixture);
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
}
const swift = path.join(directory, 'probe.swift'), binary = path.join(directory, 'probe');
writeFileSync(swift, `import Foundation
let ROOT_DIR = "/synthetic/source"
${core}
struct ServerInfo {
    let id: Int32, guiInstance: String?, conversationThread: String?, conversationBinding: String?
    var managedSession = true
}
${block(source, 'func createdSession(')}
${block(source, 'func sessionDirectoryName(')}
${block(source, 'func sessionDirectoryPath(')}
func realPath(_ path: String) -> String { path }
${menu.slice(menu.indexOf('let NODE_VALUED:'), menu.indexOf('/// From ps:'))}
${block(menu, 'func isManagedSessionCommand')}
final class FakeTask: SessionLaunchCancellable {
    var cancellations = 0
    func cancel() { cancellations += 1 }
}
struct Call {
    let node: String, root: String, request: [String: Any], task: FakeTask
    let done: ([String: Any]) -> Void
}
var calls: [Call] = []
let model = NewSessionModel(root: ROOT_DIR) { node, root, request, timeout, done in
    let task = FakeTask(); calls.append(Call(node: node, root: root, request: request, task: task, done: done)); return task
}
let scenario = CommandLine.arguments[1], node = CommandLine.arguments[2]
let fixtureRoot = CommandLine.arguments[3], earlyRoot = CommandLine.arguments[4], directory = CommandLine.arguments[5]
func catalog(_ provider: String = "Codex") -> [String: Any] {
    ["ok": true, "provider": provider, "models": [
        ["id": "alpha", "name": "Model Alpha", "efforts": ["low", "high"], "defaultEffort": "high", "isDefault": true],
        ["id": "beta", "name": "Model Beta", "efforts": ["minimal", "medium"], "defaultEffort": "medium"],
        ["id": "plain", "name": "Model Plain", "efforts": []],
        ["id": "unknown", "name": "Unknown Default", "efforts": ["low", "high"]]]]
}
func ready() { model.present(node: node, defaultDirectory: fixtureRoot); calls[0].done(catalog()) }
func receipt() -> [String: Any] { ["ok": true, "pid": 123, "instance": "new-instance", "threadId": "new-thread", "bindingId": "new-binding"] }
func spin(until condition: () -> Bool, timeout: Double = 4) {
    let end = Date().addingTimeInterval(timeout)
    while !condition() && Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    precondition(condition(), "Timed out")
}
switch scenario {
case "model-effort-switch":
    ready(); precondition(model.modelId == "alpha" && model.effort == "high")
    model.chooseEffort("low"); model.chooseModel("beta")
    precondition(model.modelId == "beta" && model.effort == "medium", "A new model must not inherit the previous model's effort")
    model.chooseEffort("high"); precondition(model.effort == "medium")
    model.chooseModel("plain"); precondition(model.effort == nil)
    model.create { _ in }; precondition(calls[1].request["effort"] is NSNull)
case "unknown-default-effort":
    ready(); model.chooseModel("unknown")
    precondition(model.effort == nil, "An unknown client default must not silently choose the first effort")
    model.chooseEffort("high"); precondition(model.effort == "high")
    model.chooseEffort(nil); precondition(model.effort == nil)
    model.loadCatalog(); calls[1].done(catalog()); precondition(model.effort == nil)
    model.create { _ in }; precondition(calls[2].request["effort"] is NSNull)
case "provider-and-directory":
    model.present(node: node, defaultDirectory: fixtureRoot); model.setPrompt("Keep my draft")
    model.chooseProvider(.claude)
    precondition(calls[0].task.cancellations == 1 && calls.count == 2 && model.models.isEmpty)
    calls[0].done(catalog()); precondition(model.loading && model.models.isEmpty)
    precondition(calls[1].request["provider"] as? String == "Claude")
    calls[1].done(catalog("Claude")); precondition(!model.loading && model.modelId == "alpha")
    model.chooseDirectory(earlyRoot)
    precondition(calls[2].request["cwd"] as? String == earlyRoot && model.loading && !model.canCreate)
    calls[2].done(["ok": false, "code": "models_unavailable", "message": "RAW PRIVATE OUTPUT"])
    precondition(model.models.isEmpty && model.catalogError != nil && !model.catalogError!.contains("RAW") && model.prompt == "Keep my draft")
case "directory-preserves-selection":
    ready(); model.chooseModel("beta"); model.chooseEffort("minimal")
    model.chooseDirectory(earlyRoot)
    precondition(model.modelId == "beta" && model.effort == "minimal" && model.loading && !model.canCreate)
    calls[1].done(catalog())
    precondition(model.modelId == "beta" && model.effort == "minimal" && model.canCreate,
        "Changing only the directory must keep supported model and effort choices")
    model.chooseDirectory(fixtureRoot)
    calls[2].done(["ok": true, "provider": "Codex", "models": [
        ["id": "beta", "name": "Model Beta", "efforts": ["medium"], "defaultEffort": "medium"]]])
    precondition(model.modelId == "beta" && model.effort == "medium", "An unsupported effort falls back to the new catalog default")
    model.chooseDirectory(earlyRoot)
    calls[3].done(["ok": true, "provider": "Codex", "models": [
        ["id": "alpha", "name": "Model Alpha", "efforts": ["high"], "defaultEffort": "high", "isDefault": true]]])
    precondition(model.modelId == "alpha" && model.effort == "high", "An unavailable model falls back to a supported catalog choice")
case "catalog-failure-retry":
    model.present(node: nil, defaultDirectory: fixtureRoot)
    precondition(calls.isEmpty && !model.canCreate && model.catalogError != nil)
    model.present(node: node, defaultDirectory: fixtureRoot)
    calls[0].done(["ok": true, "provider": "Claude", "models": []])
    precondition(model.models.isEmpty && model.catalogError != nil && !model.canCreate)
    model.loadCatalog(); calls[1].done(catalog())
    precondition(model.canCreate && model.catalogError == nil)
case "single-empty-create":
    ready(); var accepted: SessionCreationReceipt?
    model.create { accepted = $0 }; model.create { _ in fatalError("Double submission") }
    precondition(calls.count == 2 && model.creating && !model.canEdit)
    precondition(calls[1].request["prompt"] as? String == "" && calls[1].request["op"] as? String == "create")
    precondition(calls[1].root == ROOT_DIR && calls[1].node == node)
    calls[1].done(receipt())
    precondition(accepted?.pid == 123 && model.receipt == accepted && !model.canCreate)
    model.finishCreation(); precondition(model.receipt == nil && model.prompt.isEmpty && model.canEdit)
case "failure-preserves-draft":
    ready(); model.setPrompt("Synthetic task\\nwith literal quote ' and $VALUE")
    let draft = model.prompt; model.create { _ in fatalError("Unexpected creation") }
    let nonce = calls[1].request["nonce"] as! String
    precondition(calls[1].request["prompt"] as? String == draft)
    calls[1].done(["ok": false, "code": "client_missing", "delivery": "not_sent"])
    precondition(model.prompt == draft && model.canEdit && model.createError != nil)
    model.dismiss(); model.present(node: node, defaultDirectory: "/another")
    precondition(model.prompt == draft && model.cwd == fixtureRoot)
    calls[2].done(catalog()); model.create { _ in }
    precondition(calls[3].request["nonce"] as? String != nonce)
case "uncertain-same-request":
    ready(); model.setPrompt("Original request"); model.create { _ in }
    let original = calls[1].request
    calls[1].done(["ok": false, "code": "launch_pending", "delivery": "unknown"])
    precondition(model.uncertain && !model.canEdit && model.canCreate)
    model.setPrompt("Changed"); model.chooseModel("beta"); model.chooseProvider(.claude)
    precondition(model.prompt == "Original request" && model.modelId == "alpha" && model.provider == .codex)
    model.dismiss(); model.present(node: node, defaultDirectory: "/different")
    precondition(calls.count == 2)
    model.create { _ in }
    precondition(NSDictionary(dictionary: original).isEqual(to: calls[2].request))
    calls[2].done(receipt()); precondition(model.receipt != nil && !model.uncertain && model.prompt == "Original request")
case "created-worker-ended":
    ready(); model.setPrompt("Keep this first task"); model.create { _ in }
    let original = calls[1].request
    calls[1].done(receipt()); precondition(model.receipt != nil && !model.canEdit)
    model.checkCreation { _ in fatalError("Ended worker cannot reconnect") }
    precondition(NSDictionary(dictionary: original).isEqual(to: calls[2].request))
    calls[2].done(["ok": false, "code": "session_ended", "delivery": "not_sent"])
    precondition(model.receipt == nil && !model.uncertain && model.canEdit && model.prompt == "Keep this first task")
    precondition(model.createError?.contains("已结束") == true)
    model.create { _ in }
    precondition(calls[3].request["nonce"] as? String != original["nonce"] as? String)
case "close-and-exit":
    model.present(node: node, defaultDirectory: fixtureRoot); model.dismiss()
    precondition(calls[0].task.cancellations == 1)
    calls[0].done(catalog()); precondition(model.models.isEmpty)
    model.present(node: node, defaultDirectory: fixtureRoot); calls[1].done(catalog())
    model.setPrompt("Preserved"); model.create { _ in fatalError("Stale exit callback") }
    model.stop(); calls[2].done(receipt())
    precondition(calls[2].task.cancellations == 1 && !model.creating && model.receipt == nil && model.prompt == "Preserved")
case "exact-created-identity":
    let r = SessionCreationReceipt(receipt())!
    let correct = ServerInfo(id: 123, guiInstance: "new-instance", conversationThread: "new-thread", conversationBinding: "new-binding")
    var external = correct; external.managedSession = false
    let wrong = [external,
        ServerInfo(id: 124, guiInstance: "new-instance", conversationThread: "new-thread", conversationBinding: "new-binding"),
        ServerInfo(id: 123, guiInstance: "old-instance", conversationThread: "new-thread", conversationBinding: "new-binding"),
        ServerInfo(id: 123, guiInstance: "new-instance", conversationThread: "other-thread", conversationBinding: "new-binding"),
        ServerInfo(id: 123, guiInstance: "new-instance", conversationThread: "new-thread", conversationBinding: "old-binding")]
    precondition(createdSession(r, among: wrong) == nil)
    precondition(createdSession(r, among: wrong + [correct])?.id == 123)
    precondition(SessionCreationReceipt(["ok": true, "pid": 123]) == nil)
    precondition(sessionDirectoryName("/test/home", home: "/test/home") == "主目录")
    precondition(sessionDirectoryName("/test/home/work", home: "/test/home") == "work")
    precondition(sessionDirectoryPath("/test/home/work", home: "/test/home") == "~/work")
case "worker-process-identity":
    precondition(isManagedSessionCommand("/opt/node /source/src/session-worker.js"))
    precondition(isManagedSessionCommand("node --no-warnings /source/src/session-worker.js"))
    for command in ["sh -c node /source/src/session-worker.js", "node -e /source/src/session-worker.js",
                    "node /unrelated.js /source/src/session-worker.js", "node /source/src/session-worker.js.fake"] {
        precondition(!isManagedSessionCommand(command))
    }
case "launcher-json", "launcher-oversized", "launcher-invalid", "launcher-early-exit":
    let task = SessionLaunchProcess(); var response: [String: Any]?
    let mode = String(scenario.dropFirst("launcher-".count))
    let request: [String: Any] = ["op": "create", "provider": "Claude", "mode": mode,
        "prompt": mode == "early-exit" ? String(repeating: "x", count: 90000) : "Literal ' quote \\n and $VARIABLE", "cwd": fixtureRoot]
    task.start(node: node, root: mode == "early-exit" ? earlyRoot : fixtureRoot, request: request, timeout: 2) { response = $0 }
    spin(until: { response != nil })
    if mode == "json" {
        precondition(response?["ok"] as? Bool == true && (response?["argv"] as? [String])?.isEmpty == true)
        let echoed = response?["request"] as! [String: Any]
        precondition(NSDictionary(dictionary: echoed).isEqual(to: request), "Prompt must arrive on stdin, with exact bytes and no shell evaluation")
    } else { precondition(response?["ok"] as? Bool == false && response?["delivery"] as? String == "unknown") }
case "launcher-cancel", "launcher-timeout":
    let task = SessionLaunchProcess(); var response: [String: Any]?
    let pidFile = directory + "/" + scenario + ".pid"
    task.start(node: node, root: fixtureRoot, request: ["mode": "hang", "pidFile": pidFile], timeout: scenario == "launcher-timeout" ? 0.2 : 3) { response = $0 }
    spin(until: { FileManager.default.fileExists(atPath: pidFile) })
    let pid = Int32(try String(contentsOfFile: pidFile, encoding: .utf8))!
    if scenario == "launcher-cancel" { task.cancel() }
    spin(until: { response != nil })
    precondition(response?["code"] as? String == (scenario == "launcher-cancel" ? "cancelled" : "timeout"))
    spin(until: { kill(pid, 0) != 0 })
default: fatalError("Unknown scenario")
}
print("ok")
`);
execFileSync('/usr/bin/swiftc', [swift, '-o', binary], { timeout: 60_000, stdio: 'pipe' });
for (const scenario of ['model-effort-switch', 'unknown-default-effort', 'provider-and-directory', 'directory-preserves-selection', 'catalog-failure-retry', 'single-empty-create',
  'failure-preserves-draft', 'uncertain-same-request', 'created-worker-ended', 'close-and-exit', 'exact-created-identity', 'worker-process-identity',
  'launcher-json', 'launcher-oversized', 'launcher-invalid', 'launcher-early-exit', 'launcher-cancel', 'launcher-timeout']) {
  test(`native new-session behavior: ${scenario}`, () => {
    assert.equal(execFileSync(binary, [scenario, process.execPath, fixtureRoot, earlyRoot, directory], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(), 'ok');
  });
}
