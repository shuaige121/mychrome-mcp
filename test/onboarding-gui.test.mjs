import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setupInstructions } from '../src/setup.js';

// Compile the production controller and process runner. Everything uses isolated
// preferences and a synthetic Node child; no Chrome, user settings, or permission probe.
const source = readFileSync(new URL('../src/onboarding-ui.swift', import.meta.url), 'utf8');
const core = source.slice(0, source.indexOf('// MARK: - Native guide'));
assert.ok(core.includes('final class OnboardingModel'));
const tmp = mkdtempSync(path.join(tmpdir(), 'mychrome-onboarding-gui-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
writeFileSync(path.join(tmp, 'instructions.json'), JSON.stringify({ schemaVersion: 1,
  ...setupInstructions({ root: '/synthetic/source root', nodePath: process.execPath, appPath: '/synthetic/MyChrome.app' }) }));
const script = path.join(tmp, 'fixture.mjs');
writeFileSync(script, `
import fs from 'node:fs';
const mode = process.argv[2];
if (mode === 'invalid') console.log('not json');
else if (mode === 'oversized') console.log(JSON.stringify({ value: 'x'.repeat(300_000) }));
else if (mode === 'hang') { fs.writeFileSync(process.argv[3], String(process.pid)); setInterval(() => {}, 200); }
else { console.log(JSON.stringify({ schemaVersion: 1, ok: mode === 'ok' })); process.exitCode = mode === 'failed' ? 2 : mode === 'blocked' ? 1 : 0; }
`);
const swift = path.join(tmp, 'main.swift');
const binary = path.join(tmp, 'onboarding-probe');
writeFileSync(swift, `import Foundation
import Combine
let ROOT_DIR = "/synthetic/source root"
let SUPPORT_DIR = "/never-read-support"
func envPath(_ key: String, _ fallback: String) -> String { fallback }
${core}
final class FakeTask: OnboardingCancellable {
    var cancellations = 0
    func cancel() { cancellations += 1 }
}
struct Call {
    let node: String, root: String, check: Bool, task: FakeTask
    let done: ([String: Any]?, String?) -> Void
}
let scenario = CommandLine.arguments[1]
let directory = CommandLine.arguments[2] + "/" + scenario
try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
let store = OnboardingPreferenceStore(path: directory + "/onboarding.json")
let node = CommandLine.arguments[3], script = CommandLine.arguments[4]
var calls: [Call] = []
let model = OnboardingModel(root: ROOT_DIR, store: store) { node, root, check, done in
    let task = FakeTask(); calls.append(Call(node: node, root: root, check: check, task: task, done: done)); return task
}
func fixture(_ pass: Bool = true) -> [String: Any] {
    ["schemaVersion": 1, "ok": pass,
     "preflight": ["ok": true, "checks": [["id": "node", "title": "Node.js", "required": true, "ok": true]]],
     "doctor": ["ok": pass, "app": "Synthetic App", "checks": [["id": "helpers", "title": "助手 / Helpers", "required": true, "ok": pass, "detail": "中文说明\\nEnglish detail"]]],
     "connection": ["codexCommand": "literal 'path with space'", "claudeCommand": "literal Claude", "codexNote": "Edit the existing entry in ~/.codex/config.toml. Do not duplicate it."],
     "commands": ["doctor": "literal doctor", "doctorAsk": "literal --ask"],
     "firstTask": ["prompt": "Continue the user's task", "promptZh": "继续用户的任务"]]
}
func spin(until condition: () -> Bool, timeout: Double = 4) {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    precondition(condition(), "Timed out")
}
switch scenario {
case "first-return-skip-reopen":
    precondition(model.shouldAutoPresent && !store.exists)
    model.present(node: node)
    precondition(!model.shouldAutoPresent && store.stored?["presented"] as? Bool == true)
    precondition(calls.count == 1 && !calls[0].check && calls[0].root == ROOT_DIR)
    calls[0].done(fixture(), nil)
    precondition(model.report == nil, "Reading instructions must not mark permission checks passed")
    model.dismiss()
    precondition(store.stored?["dismissal"] as? String == "skipped")
    let returning = OnboardingModel(root: ROOT_DIR, store: store)
    precondition(!returning.shouldAutoPresent)
    model.present(node: node)
    precondition(model.visible && calls.count == 1, "Manual reopen remains available without repeated diagnostics")
    model.dismiss(reviewed: true)
    precondition(store.stored?["dismissal"] as? String == "reviewed")
    precondition(Set(store.stored!.keys) == Set(["kind", "version", "presented", "dismissal", "language"]))
    let mode = try FileManager.default.attributesOfItem(atPath: store.path)[.posixPermissions] as! NSNumber
    precondition(mode.intValue == 0o600)
case "missing-node":
    model.present(node: nil)
    precondition(calls.isEmpty && model.report == nil && model.note != nil && !model.loading)
    model.request(node: "relative-node", check: true)
    precondition(calls.isEmpty && model.report == nil)
    model.request(node: node, check: true)
    calls[0].done(fixture(false), nil)
    precondition(model.report?.passed == false && model.report?.checks.contains { $0.id == "helpers" && !$0.ok } == true)
case "failed-diagnostics":
    model.present(node: node); calls[0].done(fixture(), nil)
    model.request(node: node, check: true); calls[1].done(fixture(), nil)
    precondition(model.report?.passed == true)
    model.request(node: node, check: true)
    precondition(model.report == nil, "A previous pass must not remain visible during a new check")
    calls[2].done(nil, "RAW PRIVATE OUTPUT")
    precondition(model.report == nil && model.note != nil && !model.note!.contains("RAW"))
    model.request(node: node, check: true); calls[3].done(["schemaVersion": 7], nil)
    precondition(model.report == nil && !model.loading)
    model.request(node: node, check: true); calls[4].done(["schemaVersion": 1], nil)
    precondition(model.report == nil && model.note != nil)
    precondition(model.command("doctor") == "literal doctor", "Failed checks must preserve previously loaded recovery commands")
    model.request(node: node, check: false); calls[5].done(["schemaVersion": 1], nil)
    precondition(model.note != nil && model.command("doctor") == "literal doctor")
case "repeated-checks-stale":
    model.present(node: node); calls[0].done(fixture(), nil)
    model.request(node: node, check: true); model.request(node: node, check: true)
    precondition(calls.count == 2 && model.checking)
    model.dismiss(); precondition(calls[1].task.cancellations == 1 && !model.loading)
    model.present(node: node); model.request(node: node, check: true)
    calls[2].done(fixture(false), nil); calls[1].done(fixture(), nil)
    precondition(model.report?.passed == false && !model.loading, "An old success cannot replace the new result")
    model.request(node: node, check: true); model.stop(); calls[3].done(fixture(), nil)
    precondition(calls[3].task.cancellations == 1 && !model.visible && !model.loading && model.report == nil)
case "unknown-preference":
    for content in ["not json", "{\\\"kind\\\":\\\"mychrome-onboarding\\\",\\\"version\\\":2}"] {
        try content.write(toFile: store.path, atomically: true, encoding: .utf8)
        precondition(!store.shouldAutoPresent)
        precondition(!store.save(dismissal: "skipped", english: true))
        let preserved = try String(contentsOfFile: store.path, encoding: .utf8)
        precondition(preserved == content)
    }
    let broken = OnboardingPreferenceStore(path: directory)
    precondition(!broken.save(dismissal: "presented", english: true))
case "symlink-preference":
    let target = directory + "/unrelated.json"
    try "untouched".write(toFile: target, atomically: true, encoding: .utf8)
    try FileManager.default.createSymbolicLink(atPath: store.path, withDestinationPath: target)
    precondition(!store.shouldAutoPresent && !store.save(dismissal: "presented", english: false))
    let preserved = try String(contentsOfFile: target, encoding: .utf8)
    precondition(preserved == "untouched")
case "truthful-readiness":
    var value = fixture()
    value["doctor"] = NSNull()
    precondition(OnboardingReport(value)?.passed == false)
    value = fixture(); value["ok"] = false
    precondition(OnboardingReport(value)?.passed == false)
    value = fixture(); value["doctor"] = ["ok": true, "checks": [["id": "accessibility", "required": true, "ok": false, "skipped": true]]]
    precondition(OnboardingReport(value)?.passed == false)
    value = fixture(); value["doctor"] = ["ok": true, "checks": []]
    precondition(OnboardingReport(value)?.passed == false)
    precondition(OnboardingReport([:]) == nil)
case "language-and-copy":
    precondition(onboardingEnglish(environment: [:], languages: ["en-SG"]))
    precondition(!onboardingEnglish(environment: [:], languages: ["zh-Hans-SG"]))
    precondition(onboardingEnglish(environment: ["CHROME_BRIDGE_LANG": "en"], languages: ["zh-Hans"]))
    precondition(!onboardingEnglish(environment: ["CHROME_BRIDGE_LANG": "zh"], languages: ["en"]))
    model.present(node: node); calls[0].done(fixture(), nil)
    model.english = false; precondition(model.firstTaskPrompt == "继续用户的任务")
    model.dismiss(); precondition(store.stored?["language"] as? String == "zh")
    precondition(model.command("codexCommand", group: "connection") == "literal 'path with space'")
    let check = OnboardingCheck(["title": "助手 / Helpers", "detail": "中文\\nEnglish detail"])
    precondition(check.localized(check.title, english: true, title: true) == "Helpers")
    precondition(check.localized(check.detail, english: true) == "English detail")
case "node-selection":
    precondition(onboardingNode(root: ROOT_DIR, connectedNodes: [node], environment: [:], bundled: nil) == node)
    precondition(onboardingNode(root: ROOT_DIR, connectedNodes: [node], environment: [:], bundled: "/missing") == node)
    precondition(onboardingNode(root: ROOT_DIR, connectedNodes: [], environment: ["PATH": (node as NSString).deletingLastPathComponent], bundled: nil) == node)
case "task-continuation":
    precondition(model.firstTaskPrompt == nil, "No task is invented before instructions load")
    let actual = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2] + "/instructions.json"))) as! [String: Any]
    model.present(node: node); calls[0].done(actual, nil)
    let task = actual["firstTask"] as! [String: Any]
    precondition(model.command("codexNote", group: "connection")?.contains("~/.codex/config.toml") == true)
    model.step = 2; model.english = true
    precondition(model.firstTaskPrompt == task["prompt"] as? String)
    model.english = false; precondition(model.firstTaskPrompt == task["promptZh"] as? String)
    precondition(calls.count == 1 && !calls[0].check && model.report == nil, "The task step only presents instructions; it does not run a task or claim success")
    model.dismiss(reviewed: true); model.present(node: node)
    precondition(model.step == 2 && model.firstTaskPrompt == task["promptZh"] as? String && calls.count == 1)
    precondition(Set(store.stored!.keys) == Set(["kind", "version", "presented", "dismissal", "language"]), "Task text and browser state are not persisted")
    model.stop(); precondition(!model.visible && !model.loading)
case "task-language-fallback":
    model.present(node: node)
    var value = fixture(); value["firstTask"] = ["prompt": "Continue this conversation"]
    calls[0].done(value, nil); model.english = false
    precondition(model.firstTaskPrompt == "Continue this conversation")
    value.removeValue(forKey: "firstTask")
    model.request(node: node, check: false); calls[1].done(value, nil)
    precondition(model.firstTaskPrompt == nil && model.report == nil)
case "process-ok", "process-blocked", "process-failed", "process-invalid", "process-oversized":
    let mode = String(scenario.dropFirst("process-".count))
    var finished = false, response: [String: Any]?, failure: String?
    let task = OnboardingProcess()
    task.start(executable: node, arguments: [script, mode]) { object, error in response = object; failure = error; finished = true }
    spin(until: { finished })
    if ["ok", "blocked"].contains(mode) { precondition(failure == nil && response?["schemaVersion"] as? Int == 1) }
    else { precondition(failure != nil) }
case "process-cancel", "process-timeout":
    var finished = false, failure: String?
    let task = OnboardingProcess()
    let pidFile = directory + "/child.pid"
    task.start(executable: node, arguments: [script, "hang", pidFile], timeout: scenario == "process-timeout" ? 0.2 : 5) { _, error in failure = error; finished = true }
    spin(until: { FileManager.default.fileExists(atPath: pidFile) })
    let child = Int32(try String(contentsOfFile: pidFile, encoding: .utf8))!
    if scenario == "process-cancel" { task.cancel() }
    spin(until: { finished })
    precondition(failure == (scenario == "process-cancel" ? "cancelled" : "timeout"))
    spin(until: { kill(child, 0) != 0 })
case "process-unavailable":
    var finished = false, failure: String?
    let task = OnboardingProcess()
    task.start(executable: "/missing-node-for-fixture", arguments: []) { _, error in failure = error; finished = true }
    spin(until: { finished }); precondition(failure == "unavailable")
default: fatalError("Unknown scenario")
}
print("ok")
`);
execFileSync('/usr/bin/swiftc', [swift, '-o', binary], { timeout: 60_000, stdio: 'pipe' });
for (const scenario of [
  'first-return-skip-reopen', 'missing-node', 'failed-diagnostics', 'repeated-checks-stale',
  'unknown-preference', 'symlink-preference', 'truthful-readiness', 'language-and-copy', 'node-selection',
  'task-continuation', 'task-language-fallback',
  'process-ok', 'process-blocked', 'process-failed', 'process-invalid', 'process-oversized',
  'process-cancel', 'process-timeout', 'process-unavailable',
]) {
  test(`production onboarding controller: ${scenario}`, () => {
    assert.equal(execFileSync(binary, [scenario, tmp, process.execPath, script], { encoding: 'utf8', timeout: 10_000 }).trim(), 'ok');
  });
}

test('native entry points reopen the guide and quit cancels local work', () => {
  const menu = readFileSync(new URL('../src/menubar.swift', import.meta.url), 'utf8');
  const conversation = readFileSync(new URL('../src/conversation-ui.swift', import.meta.url), 'utf8');
  assert.match(menu, /if m\.onboarding\.shouldAutoPresent \{ controller\?\.showOnboarding\(\) \}/);
  assert.match(menu, /func prepareForExit\(\) \{\s*onboarding\.stop\(\)/);
  assert.match(conversation, /model\.openOnboarding\?\(\)/);
  assert.match(source, /Live conversation text and direct replies to Claude terminal sessions are currently unsupported/);
  assert.match(source, /read-only|Read-only/);
  assert.match(source, /state\.command\("codexNote", group: "connection"\)/);
  assert.match(source, /~\/\.codex\/config\.toml/);
  assert.doesNotMatch(source, /startPractice|practiceURL|practiceStarting|examples\/first-task|firstLine:/);
  assert.doesNotMatch(source, /--ask-automation|tccutil|readActivity\(|writeSettingsObject\(/);
});
