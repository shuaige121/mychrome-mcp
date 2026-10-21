import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { startConversationService } from '../src/gui-service.js';
import { requestGui } from '../src/gui-ipc.js';

// Only this test's sockets and synthetic Swift data are used. No browser/model connection.
const tmp = mkdtempSync(path.join(tmpdir(), 'mychrome-routine-gui-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
test('routine IPC preserves exact worker identity and passes literal payloads without a model call', async () => {
  let presence;
  const seen = [];
  const service = await startConversationService({
    base: path.join(tmp, 'ipc'), onPresence: p => { presence = p; },
    connect() { throw Error('Routine GUI must not connect a model'); },
    async routines(payload) {
      seen.push(payload);
      if (payload.action === 'fail') throw Object.assign(Error('private raw terminal output'), { code: 'invalid_selection' });
      return { enabled: false, echo: payload };
    },
  });
  const call = (payload, instance = presence.guiInstance) => requestGui({
    base: path.join(tmp, 'ipc'), pid: process.pid, instance, op: 'routine', payload,
  });
  try {
    const payload = { action: 'start', id: 'routine-a', tab: 7, nonce: 'same-intent', params: { input_1: '中文 `$(literal)`\nsecond line' } };
    assert.deepEqual((await call(payload)).result.echo, payload);
    assert.equal((await call(payload, 'stale-instance')).code, 'session_changed');
    assert.equal(seen.length, 1, 'a different GUI instance never reaches the callback');
    assert.equal((await call([])).code, 'invalid_request');
    assert.equal(seen.length, 1);
    const failure = await call({ action: 'fail' });
    assert.equal(failure.code, 'invalid_selection');
    assert.doesNotMatch(JSON.stringify(failure), /private|terminal/);
    assert.equal((await requestGui({ base: path.join(tmp, 'ipc'), pid: process.pid,
      instance: presence.guiInstance, op: 'snapshot' })).ok, true, 'existing conversation IPC is preserved');
  } finally { service.close(); }
});

const source = readFileSync(new URL('../src/routine-ui.swift', import.meta.url), 'utf8');
function declaration(kind, name) {
  const start = source.indexOf(`${kind} ${name}`);
  assert.ok(start >= 0, name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(`Incomplete production declaration: ${name}`);
}
const declarations = [
  ...['routineCount', 'routineActionName', 'routineErrorMessage', 'routineRange', 'routineTabLabel', 'routineSuccessor', 'routineRequestFits', 'routineStopHint'].map(n => declaration('func', n)),
  ...['RoutineEvent', 'SavedRoutine', 'RoutineCandidate', 'RoutineSnapshotState', 'RoutineRunState'].map(n => declaration('struct', n)),
  declaration('final class', 'RoutineModel'),
  declaration('struct', 'RoutinePolling'),
].join('\n');
const swift = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'probe');
writeFileSync(swift, `import Foundation
import Combine
import SwiftUI
import AppKit
struct ServerInfo {
    let id: Int32; let guiInstance: String?
    var root: String? = "/synthetic/root"; var launcher: Int32? = 77; var startedAt: Double = 100
    var node: String? = "/synthetic/node"
}
final class Model: ObservableObject {
    @Published var tick = 0
    @Published var conversationVisible = true
    @Published var workspaceDestination = "routines"
    @Published var live = true
    @Published var showPolling = true
    var servers: [ServerInfo] = []
}
func routineWorkerKey(_ server: ServerInfo) -> String { "\\(server.id):\\(server.guiInstance ?? "")" }
struct ConversationPresentation { let kind: String, label: String, symbol: String, tone: String }
struct Call { let server: ServerInfo; let request: [String: Any]; let done: ([String: Any]) -> Void }
var calls: [Call] = []
func callConversation(_ server: ServerInfo, request: [String: Any], done: @escaping ([String: Any]) -> Void) {
    calls.append(Call(server: server, request: request, done: done))
}
${declarations}
var parentBuilds = 0
struct PollingParent: View {
    @ObservedObject var parent: Model
    let state: RoutineModel
    var body: some View {
        parentBuilds += 1
        return Group {
            if parent.showPolling {
                Text("Synthetic parent \\(parent.tick)").modifier(RoutinePolling(model: parent, state: state))
            }
        }
    }
}
func drive(_ host: NSHostingView<PollingParent>, parent: Model, seconds: Double) {
    let deadline = Date(timeIntervalSinceNow: seconds)
    while Date() < deadline {
        parent.tick += 1
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
    }
}
let a = ServerInfo(id: 101, guiInstance: "gui-a"), b = ServerInfo(id: 102, guiInstance: "gui-b")
let model = RoutineModel()
model.choose(a)
let routine = SavedRoutine(["id": "r", "site": "https://fixture.test", "name": "Synthetic routine",
    "steps": [["tool": "type_text"]], "parameters": [["name": "input_1", "label": "输入文字"]]])!
func payload(_ i: Int) -> [String: Any] { calls[i].request["payload"] as! [String: Any] }
func reply(_ i: Int, _ result: [String: Any]) { calls[i].done(["ok": true, "result": result]) }
func start() { model.tabs = [["tabId": 7]]; model.start(a, routine: routine, tab: 7, params: ["input_1": "Literal text"]) }
func event(_ id: String, seq: Int, ok: Bool = true, tab: Int = 7, site: String = "https://fixture.test") -> [String: Any] {
    ["id": id, "seq": seq, "at": seq * 1000, "sessionId": "s", "site": site, "tab": tab,
     "tool": "click", "ok": ok, "replayable": ok, "target": ["name": id]]
}
switch CommandLine.arguments[1] {
case "range":
    let s = RoutineSnapshotState(["events": [event("c", seq: 3), event("b", seq: 2), event("a", seq: 1)]])
    precondition(s.events.map(\\.id) == ["a", "b", "c"])
    precondition(routineRange(s.events, from: "a", through: "c") == ["a", "b", "c"])
    precondition(routineRange(s.events, from: "c", through: "a").isEmpty)
    precondition(routineRange([event("a", seq: 1), event("c", seq: 3)].compactMap(RoutineEvent.init), from: "a", through: "c").isEmpty)
    var olderClock = event("c", seq: 3); olderClock["at"] = 0
    precondition(RoutineSnapshotState(["events": [olderClock, event("b", seq: 2), event("a", seq: 1)]]).events.map(\\.id) == ["a", "b", "c"])
    for altered in [event("b", seq: 2, ok: false), event("b", seq: 2, tab: 8), event("b", seq: 2, site: "https://other.test")] {
        let rows = [event("a", seq: 1), altered, event("c", seq: 3)].compactMap(RoutineEvent.init)
        precondition(routineRange(rows, from: "a", through: "c").isEmpty)
    }
case "stale-snapshot":
    model.refresh(a); model.choose(b); model.refresh(b)
    reply(0, ["enabled": true]); precondition(model.snapshot == nil)
    reply(1, ["enabled": false]); precondition(model.snapshot?.enabled == false)
case "filter-race":
    model.site = "one"; model.refresh(a); model.site = "two"; model.refresh(a)
    precondition(payload(0)["site"] as? String == "one" && payload(1)["site"] as? String == "two")
    reply(1, ["enabled": false]); reply(0, ["enabled": true]); precondition(model.snapshot?.enabled == false)
case "refresh-notes":
    model.refresh(a); calls[0].done(["ok": false, "code": "connection_lost"])
    precondition(model.note == routineErrorMessage("connection_lost"))
    model.refresh(a); reply(1, ["enabled": true])
    precondition(model.snapshot?.enabled == true && model.note == nil)
    model.change(a, payload: ["action": "save"], success: "Saved")
    reply(2, [:]); reply(3, ["enabled": true])
    precondition(model.note == "Saved")
    model.refresh(a); reply(4, ["enabled": true])
    precondition(model.note == nil)
case "candidate-single-use":
    let candidate = RoutineCandidate(["id": "c", "eventIds": ["a", "b"], "count": 1])!
    precondition(candidate.count == 1 && candidate.name == "可复用片段")
case "settings-failure":
    model.snapshot = RoutineSnapshotState(["enabled": false])
    model.change(a, payload: ["action": "settings", "enabled": true], success: "Saved")
    calls[0].done(["ok": false, "code": "unavailable", "message": "RAW PRIVATE OUTPUT"])
    precondition(model.snapshot?.enabled == false && model.note != "Saved")
    calls[1].done(["ok": false, "code": "connection_lost"])
    precondition(model.snapshot == nil && !(model.note ?? "").contains("RAW"))
case "start-guards":
    model.start(a, routine: routine, tab: 7, params: ["input_1": "text"])
    model.tabs = [["tabId": 7]]
    model.start(a, routine: routine, tab: 7, params: [:])
    model.start(b, routine: routine, tab: 7, params: ["input_1": "text"])
    precondition(calls.isEmpty)
    start(); precondition(calls.count == 1 && payload(0)["tab"] as? Int == 7)
case "unknown-start":
    start(); let nonce = payload(0)["nonce"] as! String
    calls[0].done(["ok": false, "code": "connection_lost", "delivery": "unknown"])
    start(); model.choose(b); precondition(calls.count == 1 && model.workerKey == routineWorkerKey(b))
    precondition(model.activeRun && model.browsingOtherWorker)
    model.checkRun(); precondition(calls.count == 2 && payload(1)["action"] as? String == "status")
    precondition(payload(1)["nonce"] as? String == nonce && calls[1].server.guiInstance == "gui-a")
    calls[1].done(["ok": false, "code": "run_not_found"]); precondition(model.activeRun)
    model.checkRun(); reply(2, ["status": "failed", "delivery": "not_sent"]); precondition(!model.activeRun)
case "cancel-overtakes-status":
    start(); reply(0, ["runId": "run-a", "status": "running"])
    precondition(calls.count == 2 && payload(1)["action"] as? String == "status")
    model.checkRun(cancel: true)
    precondition(calls.count == 3 && payload(2)["action"] as? String == "cancel")
    precondition(payload(2)["runId"] as? String == "run-a" && calls[2].server.id == a.id)
    reply(2, ["runId": "run-a", "status": "cancelled", "completed": 0, "total": 1])
    reply(1, ["runId": "run-a", "status": "running"])
    precondition(model.run?.status == "cancelled" && !model.activeRun)
case "completion-evidence":
    let stillRunning = RoutineRunState(["status": "running", "completed": 1, "total": 1, "message": "全部完成"])
    precondition(!stillRunning.terminal && stillRunning.presentation.tone == "blue")
    precondition(RoutineRunState(["status": "completed"]).presentation.tone == "green")
    precondition(RoutineRunState(["status": "blocked"]).presentation.tone == "orange")
    precondition(RoutineRunState(["status": "failed"]).presentation.tone == "red")
case "restore-active":
    model.refresh(a)
    reply(0, ["enabled": true, "recordingError": true, "activeRun": ["runId": "existing-run", "nonce": "existing-nonce", "status": "running", "completed": 1, "total": 3]])
    precondition(model.activeRun && model.snapshot?.recordingError == true)
    model.checkRun(cancel: true)
    precondition(payload(1)["action"] as? String == "cancel" && payload(1)["runId"] as? String == "existing-run")
    precondition(payload(1)["nonce"] as? String == "existing-nonce" && calls[1].server.guiInstance == "gui-a")
    precondition(calls.allSatisfy { ($0.request["payload"] as? [String: Any])?["action"] as? String != "start" })
case "tab-label":
    let label = routineTabLabel(["tabId": 7, "title": "Fixture", "url": "https://user:secret@fixture.test/path?token=private#private"])
    precondition(label.contains("fixture.test/path") && label.contains("7"))
    precondition(!label.contains("secret") && !label.contains("private") && !label.contains("user:"))
case "lost-status":
    start(); reply(0, ["runId": "run-a", "status": "running", "completed": 1, "total": 3])
    calls[1].done(["ok": false, "code": "connection_lost"])
    precondition(model.run?.status == "unknown" && model.run?.completed == 1 && model.run?.total == 3)
    precondition(model.activeRun && model.run?.presentation.tone == "orange")
    model.checkRun(); reply(2, ["runId": "run-a", "status": "completed", "completed": 3, "total": 3])
    precondition(!model.activeRun && model.run?.presentation.tone == "green")
case "paused-message":
    precondition(routineErrorMessage("paused_by_user") == routineErrorMessage("paused"))
    start(); calls[0].done(["ok": false, "code": "paused_by_user", "delivery": "not_sent"])
    precondition(!model.activeRun && model.run?.status == "failed")
    precondition(model.runNote?.contains("暂停") == true && model.runNote?.contains("上方按钮") == true)
case "interleaved-range":
    let rows = [event("a1", seq: 1), event("b1", seq: 1, tab: 8), event("a2", seq: 2)].compactMap(RoutineEvent.init)
    precondition(routineRange(rows, from: "a1", through: "a2") == ["a1", "a2"])
    precondition(routineRange(rows, from: "a1", through: "b1").isEmpty)
    let barrier = [event("a1", seq: 1), event("b1", seq: 1, tab: 8), event("failed", seq: 2, ok: false), event("a3", seq: 3)].compactMap(RoutineEvent.init)
    precondition(routineRange(barrier, from: "a1", through: "a3").isEmpty)
case "successor-receipt":
    start(); let nonce = payload(0)["nonce"] as! String
    reply(0, ["runId": "run-a", "status": "running"])
    calls[1].done(["ok": false, "code": "connection_lost"])
    let successor = ServerInfo(id: 103, guiInstance: "gui-successor", startedAt: 200)
    model.recoverRun([successor])
    precondition(calls.count == 3 && calls[2].server.id == 103)
    precondition(payload(2)["action"] as? String == "status" && payload(2)["nonce"] as? String == nonce && payload(2)["runId"] as? String == "run-a")
    reply(2, ["runId": "run-a", "nonce": nonce, "routineId": "r", "tab": 7, "status": "completed", "completed": 1, "total": 1])
    precondition(!model.activeRun && model.run?.status == "completed" && model.workerKey == routineWorkerKey(successor))
    precondition(calls.filter { ($0.request["payload"] as? [String: Any])?["action"] as? String == "start" }.count == 1)
case "successor-refusal":
    start(); let nonce = payload(0)["nonce"] as! String
    calls[0].done(["ok": false, "code": "connection_lost"])
    let successor = ServerInfo(id: 103, guiInstance: "gui-successor", startedAt: 200)
    for candidate in [ServerInfo(id: 104, guiInstance: "other-root", root: "/other", startedAt: 200),
                      ServerInfo(id: 105, guiInstance: "other-launcher", launcher: 78, startedAt: 200),
                      ServerInfo(id: 106, guiInstance: "older", startedAt: 90)] { model.recoverRun([candidate]) }
    model.recoverRun([successor, ServerInfo(id: 107, guiInstance: "second-successor", startedAt: 300)])
    precondition(calls.count == 1)
    for patch: [String: Any] in [["nonce": "foreign"], ["routineId": "other"], ["tab": 8], ["status": "running"]] {
        model.recoverRun([successor]); let i = calls.count - 1
        var receipt: [String: Any] = ["runId": "run-a", "nonce": nonce, "routineId": "r", "tab": 7, "status": "completed"]
        receipt.merge(patch) { _, new in new }; reply(i, receipt)
        precondition(model.activeRun && model.workerKey == routineWorkerKey(a))
    }
    model.choose(b); model.tabs = [["tabId": 7]]
    let before = calls.count; model.start(b, routine: routine, tab: 7, params: ["input_1": "New"])
    precondition(calls.count == before && model.activeRun && model.browsingOtherWorker)
    model.checkRun(); precondition(calls.last!.server.id == a.id && payload(calls.count - 1)["nonce"] as? String == nonce)
case "successor-known-id":
    start(); let nonce = payload(0)["nonce"] as! String
    reply(0, ["runId": "run-a", "status": "running"])
    calls[1].done(["ok": false, "code": "connection_lost"])
    let successor = ServerInfo(id: 103, guiInstance: "gui-successor", startedAt: 200)
    model.recoverRun([successor])
    reply(2, ["runId": "foreign-run", "nonce": nonce, "routineId": "r", "tab": 7, "status": "completed"])
    precondition(model.activeRun && model.run?.id == "run-a" && model.workerKey == routineWorkerKey(a))
case "successor-lost-start":
    start(); let nonce = payload(0)["nonce"] as! String
    calls[0].done(["ok": false, "code": "connection_lost", "delivery": "unknown"])
    let successor = ServerInfo(id: 103, guiInstance: "gui-successor", startedAt: 200)
    model.choose(b); model.recoverRun([successor])
    precondition(payload(1)["runId"] == nil && payload(1)["nonce"] as? String == nonce)
    reply(1, ["runId": "run-a", "nonce": nonce, "routineId": "r", "tab": 7, "status": "completed"])
    precondition(!model.activeRun && model.run?.id == "run-a" && model.workerKey == routineWorkerKey(b))
    reply(0, ["runId": "run-a", "status": "running"])
    precondition(model.run?.status == "completed" && calls.count == 2)
case "request-byte-limit":
    let large = SavedRoutine(["id": "large", "steps": [["tool": "type_text"]], "parameters": [["name": "a"], ["name": "b"], ["name": "c"]]])!
    model.tabs = [["tabId": 7]]
    let text = String(repeating: "中", count: 20000)
    model.start(a, routine: large, tab: 7, params: ["a": text, "b": text, "c": text])
    precondition(calls.isEmpty && !model.activeRun && model.note?.contains("未发送") == true)
    start(); precondition(calls.count == 1)
case "late-unsent-flags":
    start(); model.checkRun(); precondition(model.checking)
    calls[0].done(["ok": false, "delivery": "not_sent", "code": "paused_by_user"])
    reply(1, ["status": "running"])
    precondition(!model.activeRun && !model.checking && !model.cancelling)
    model.choose(b); model.tabs = [["tabId": 7]]
    model.start(b, routine: routine, tab: 7, params: ["input_1": "New"]); reply(2, ["runId": "new-run", "status": "running"])
    precondition(calls.count == 4 && payload(3)["action"] as? String == "status" && calls[3].server.id == b.id)
case "stop-hint":
    precondition(routineStopHint().contains("0.8 秒内连按两次 Esc"))
    precondition(routineStopHint().contains("鼠标无法点击"))
case "polling-parent-rebuild":
    NSApplication.shared.setActivationPolicy(.prohibited)
    start(); reply(0, ["runId": "run-a", "status": "running", "completed": 0, "total": 3])
    reply(1, ["runId": "run-a", "status": "running", "completed": 0, "total": 3])
    let parent = Model(); parent.servers = [a]
    let host = NSHostingView(rootView: PollingParent(parent: parent, state: model))
    host.frame = NSRect(x: 0, y: 0, width: 200, height: 40)
    drive(host, parent: parent, seconds: 3.3)
    precondition(parentBuilds > 20, "The parent must really rebuild faster than the polling interval")
    precondition(calls.count == 3 && payload(2)["action"] as? String == "status", "Automatic status must fire once and not overlap an unanswered request")
    reply(2, ["runId": "run-a", "status": "completed", "completed": 3, "total": 3])
    precondition(model.run?.completed == 3 && model.run?.status == "completed")
    let count = calls.count
    drive(host, parent: parent, seconds: 1.7)
    precondition(calls.count == count, "Terminal runs must stop querying")
case "polling-visibility":
    NSApplication.shared.setActivationPolicy(.prohibited)
    start(); reply(0, ["runId": "run-a", "status": "running"]); reply(1, ["runId": "run-a", "status": "running"])
    let parent = Model(); parent.servers = [a]; parent.conversationVisible = false
    let host = NSHostingView(rootView: PollingParent(parent: parent, state: model))
    host.frame = NSRect(x: 0, y: 0, width: 200, height: 40)
    drive(host, parent: parent, seconds: 1.7); precondition(calls.count == 2, "Closed windows must not query")
    parent.conversationVisible = true; parent.workspaceDestination = "settings"
    drive(host, parent: parent, seconds: 1.7); precondition(calls.count == 2, "Other tabs must not query")
    parent.workspaceDestination = "routines"; parent.live = false
    drive(host, parent: parent, seconds: 1.7); precondition(calls.count == 2, "Offline previews must not query")
    parent.live = true; parent.showPolling = false
    drive(host, parent: parent, seconds: 1.7); precondition(calls.count == 2, "Removed views must unsubscribe")
    parent.showPolling = true
    drive(host, parent: parent, seconds: 1.7); precondition(calls.count == 3, "Returning to the view must resume automatic status")
default: fatalError("Unknown fixture")
}
print("ok")
`);
execFileSync('/usr/bin/swiftc', [swift, '-o', binary], { timeout: 60_000, stdio: 'pipe' });
for (const scenario of ['range', 'stale-snapshot', 'filter-race', 'refresh-notes', 'candidate-single-use', 'settings-failure', 'start-guards', 'unknown-start', 'cancel-overtakes-status', 'completion-evidence', 'restore-active', 'tab-label', 'lost-status', 'paused-message', 'interleaved-range', 'successor-receipt', 'successor-refusal', 'successor-known-id', 'successor-lost-start', 'request-byte-limit', 'late-unsent-flags', 'stop-hint', 'polling-parent-rebuild', 'polling-visibility']) {
  test(`production Swift routine controller: ${scenario}`, () => {
    assert.equal(execFileSync(binary, [scenario], { encoding: 'utf8', timeout: 15000 }).trim(), 'ok');
  });
}
