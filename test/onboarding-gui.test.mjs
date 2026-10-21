import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Compile the production controller and process runner. Everything uses isolated
// preferences and a synthetic Node child; no Chrome, user settings, or permission probe.
const source = readFileSync(new URL('../src/onboarding-ui.swift', import.meta.url), 'utf8');
const core = source.slice(0, source.indexOf('// MARK: - Native guide'));
assert.ok(core.includes('final class OnboardingModel'));
const tmp = mkdtempSync(path.join(tmpdir(), 'mychrome-onboarding-gui-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const script = path.join(tmp, 'fixture.mjs');
writeFileSync(script, `
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const mode = process.argv[2];
if (mode === '--open') {
  fs.writeFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../practice-child.pid'), String(process.pid));
  console.log(JSON.stringify({ url: process.argv[1].includes('practice-start-timeout') ? 'https://external.invalid/' : 'http://127.0.0.1:12345/', pid: process.pid }));
  setInterval(() => {}, 200);
}
else if (mode === 'invalid') console.log('not json');
else if (mode === 'oversized') console.log(JSON.stringify({ value: 'x'.repeat(300_000) }));
else if (mode === 'hang') { console.log(JSON.stringify({ pid: process.pid })); setInterval(() => {}, 200); }
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
     "practice": ["prompt": "Read the local page", "promptZh": "读取本地页"]]
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
    model.english = false; precondition(model.practicePrompt == "读取本地页")
    model.dismiss(); precondition(store.stored?["language"] as? String == "zh")
    precondition(model.command("codexCommand", group: "connection") == "literal 'path with space'")
    let check = OnboardingCheck(["title": "助手 / Helpers", "detail": "中文\\nEnglish detail"])
    precondition(check.localized(check.title, english: true, title: true) == "Helpers")
    precondition(check.localized(check.detail, english: true) == "English detail")
case "node-selection":
    precondition(onboardingNode(root: ROOT_DIR, connectedNodes: [node], environment: [:], bundled: nil) == node)
    precondition(onboardingNode(root: ROOT_DIR, connectedNodes: [node], environment: [:], bundled: "/missing") == node)
    precondition(onboardingNode(root: ROOT_DIR, connectedNodes: [], environment: ["PATH": (node as NSString).deletingLastPathComponent], bundled: nil) == node)
case "practice-prompt-exact-url":
    model.present(node: node); calls[0].done(fixture(), nil)
    precondition(model.command("codexNote", group: "connection")?.contains("~/.codex/config.toml") == true)
    model.english = true; precondition(model.practicePrompt == "Read the local page")
    model.english = false; precondition(model.practicePrompt == "读取本地页")
    let current = "http://127.0.0.1:45678/?practice=synthetic"
    model.practiceURL = URL(string: current)
    model.english = true
    precondition(model.practicePrompt == "Read the local page\\n\\nUse this exact practice page: " + current)
    model.english = false
    precondition(model.practicePrompt == "读取本地页\\n\\n请只操作本次练习页面：" + current)
    model.practiceURL = URL(string: "http://127.0.0.1:45679/")
    precondition(model.practicePrompt?.contains("45678") == false && model.practicePrompt?.contains("45679") == true)
    model.stop(); precondition(model.practicePrompt == "读取本地页", "No URL is fabricated after the server stops")
case "practice-lifecycle", "practice-start-timeout":
    let practiceDirectory = directory + "/examples/first-task"
    try FileManager.default.createDirectory(atPath: practiceDirectory, withIntermediateDirectories: true)
    try FileManager.default.copyItem(atPath: script, toPath: practiceDirectory + "/serve.mjs")
    let practice = OnboardingModel(root: directory, store: store)
    if scenario == "practice-start-timeout" {
        practice.startPractice(node: node, startupTimeout: 0.2)
        spin(until: { !practice.practiceStarting })
        precondition(practice.practiceURL == nil && practice.note != nil)
        let child = Int32(try String(contentsOfFile: directory + "/practice-child.pid", encoding: .utf8))!
        spin(until: { kill(child, 0) != 0 })
        break
    }
    practice.startPractice(node: node); practice.startPractice(node: node)
    spin(until: { practice.practiceURL != nil })
    let pidText = try String(contentsOfFile: directory + "/practice-child.pid", encoding: .utf8)
    let child = Int32(pidText)!
    precondition(!practice.practiceStarting && kill(child, 0) == 0)
    practice.dismiss(); practice.startPractice(node: node)
    precondition(practice.practiceURL != nil && kill(child, 0) == 0, "Closing the guide keeps practice available")
    practice.stop()
    spin(until: { kill(child, 0) != 0 })
    precondition(practice.practiceURL == nil && !practice.practiceStarting)
case "practice-missing-server":
    model.startPractice(node: node)
    spin(until: { !model.practiceStarting })
    precondition(model.practiceURL == nil && model.note != nil)
case "process-ok", "process-blocked", "process-failed", "process-invalid", "process-oversized":
    let mode = String(scenario.dropFirst("process-".count))
    var finished = false, response: [String: Any]?, failure: String?
    let task = OnboardingProcess()
    task.start(executable: node, arguments: [script, mode]) { object, error in response = object; failure = error; finished = true }
    spin(until: { finished })
    if ["ok", "blocked"].contains(mode) { precondition(failure == nil && response?["schemaVersion"] as? Int == 1) }
    else { precondition(failure != nil) }
case "process-cancel", "process-timeout":
    var finished = false, child: Int32?, failure: String?
    let task = OnboardingProcess()
    task.start(executable: node, arguments: [script, "hang"], timeout: scenario == "process-timeout" ? 0.2 : 5, firstLine: { object in
        child = (object["pid"] as? NSNumber)?.int32Value
    }) { _, error in failure = error; finished = true }
    spin(until: { child != nil })
    if scenario == "process-cancel" { task.cancel() }
    spin(until: { finished })
    precondition(failure == (scenario == "process-cancel" ? "cancelled" : "timeout"))
    spin(until: { kill(child!, 0) != 0 })
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
  'practice-prompt-exact-url', 'practice-lifecycle', 'practice-missing-server', 'practice-start-timeout',
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
  assert.match(source, /\.disabled\(state\.practiceURL == nil\)/);
  assert.doesNotMatch(source, /--ask-automation|tccutil|readActivity\(|writeSettingsObject\(/);
});
