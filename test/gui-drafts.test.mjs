import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Compile the production draft/routing methods with a synthetic IPC queue.
// Foundation only: no AppKit window, real worker, user state or model input.
const source = readFileSync(new URL('../src/conversation-ui.swift', import.meta.url), 'utf8');
function block(marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Production declaration missing: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Incomplete production declaration: ${marker}`);
}
const dir = mkdtempSync(path.join(os.tmpdir(), 'mychrome-gui-drafts-'));
const swift = path.join(dir, 'probe.swift'), binary = path.join(dir, 'probe');
after(() => {
  for (const file of [swift, binary]) {
    try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  rmdirSync(dir);
});
writeFileSync(swift, `import Foundation
struct ServerInfo {
    let id: Int32
    let guiInstance: String?, conversationThread: String?, conversationBinding: String?
}
struct ConversationEntry: Identifiable { let id: String, text: String }
${block('struct ConversationState')}
${block('func conversationKey(')}
${block('func hasPreviousBindingDraft(')}
struct Call {
    let server: ServerInfo, request: [String: Any]
    let done: ([String: Any]) -> Void
}
var calls: [Call] = []
func callConversation(_ server: ServerInfo, request: [String: Any], done: @escaping ([String: Any]) -> Void) {
    calls.append(Call(server: server, request: request, done: done))
}
final class Model {
    var servers: [ServerInfo] = [], selectedConversation: Int32?
    var live = true, conversationVisible = false, conversationReading = false
    var conversation: ConversationState?, loadedConversationKey: String?
    var drafts: [String: String] = [:], deliveryNotes: [String: String] = [:]
    var deliveryStates: [String: String] = [:]
    var unconfirmedSends: [String: [String: Any]] = [:], sendingTo = Set<String>()
    var chosenServer: ServerInfo? { servers.first { $0.id == selectedConversation } }
    ${block('    func selectConversation(')}
    ${block('    func refreshConversation()')}
    ${block('    func sendConversation(')}
}
let a = ServerInfo(id: 101, guiInstance: "gui-a", conversationThread: "thread-a", conversationBinding: "binding-a")
let b = ServerInfo(id: 102, guiInstance: "gui-b", conversationThread: "thread-b", conversationBinding: "binding-b")
let reconnected = ServerInfo(id: 101, guiInstance: "gui-a", conversationThread: "thread-a", conversationBinding: "binding-new")
let ak = conversationKey(a), bk = conversationKey(b), rk = conversationKey(reconnected)
let model = Model()
model.servers = [a, b]; model.selectedConversation = a.id
func accept(_ call: Call) { call.done(["ok": true, "result": ["status": "accepted"]]) }
func payload(_ call: Call) -> [String: Any] { call.request["payload"] as! [String: Any] }
switch CommandLine.arguments[1] {
case "switch":
    model.drafts[ak] = "Draft A"
    model.selectConversation(b); model.drafts[bk] = "Draft B"; model.sendConversation(b)
    precondition(calls.count == 1 && calls[0].server.id == b.id)
    precondition(payload(calls[0])["threadId"] as? String == "thread-b")
    precondition(payload(calls[0])["text"] as? String == "Draft B")
    accept(calls[0])
    precondition(model.drafts[ak] == "Draft A" && model.drafts[bk] == "")
case "late-accepted":
    model.drafts[ak] = "Sending A"; model.sendConversation(a)
    let inflight = calls[0]
    model.selectConversation(b); model.drafts[bk] = "New B"; model.drafts[ak] = "Edited A"
    accept(inflight)
    precondition(model.drafts[ak] == "Edited A" && model.drafts[bk] == "New B")
case "reconnect":
    model.drafts[ak] = "Unsent A"; model.servers = [reconnected, b]
    precondition(model.chosenServer.map(conversationKey) == rk && model.drafts[rk] == nil)
    precondition(model.drafts[ak] == "Unsent A" && calls.isEmpty)
    precondition(hasPreviousBindingDraft(reconnected, drafts: model.drafts))
    precondition(!hasPreviousBindingDraft(b, drafts: model.drafts))
case "unknown":
    model.drafts[ak] = "Uncertain A"; model.sendConversation(a)
    let original = calls[0]
    original.done(["ok": true, "result": ["status": "unknown"]])
    model.sendConversation(a)
    precondition(calls.count == 1 && model.unconfirmedSends[ak] != nil)
    model.sendConversation(a, checkOnly: true)
    precondition(calls.count == 2 && calls[1].request["op"] as? String == "delivery")
    precondition(payload(original)["nonce"] as? String == payload(calls[1])["nonce"] as? String)
    precondition(payload(calls[1])["threadId"] as? String == "thread-a")
case "stale-snapshot":
    model.conversationVisible = true; model.refreshConversation()
    let stale = calls[0]
    model.selectConversation(b)
    stale.done(["ok": true, "snapshot": ["bindingId": "binding-a", "threadId": "thread-a",
        "status": "connected", "entries": [["id": "a", "text": "A only"]]]])
    precondition(model.conversation == nil && model.loadedConversationKey == nil)
    precondition(calls.count == 2 && calls[1].server.id == b.id)
    calls[1].done(["ok": true, "snapshot": ["bindingId": "binding-b", "threadId": "thread-b", "status": "connected"]])
    precondition(model.loadedConversationKey == bk && model.conversation?.threadId == "thread-b")
default: fatalError("Unknown synthetic scenario")
}
print("ok")
`);
execFileSync('/usr/bin/swiftc', [swift, '-o', binary], { timeout: 60_000, stdio: 'pipe' });

for (const [scenario, description] of [
  ['switch', 'switching sources sends only the selected draft and retains the previous one'],
  ['late-accepted', 'late acceptance cannot clear another source or a draft edited after sending'],
  ['reconnect', 'same-thread reconnect retains the old draft with an explicit recovery hint, without sending'],
  ['unknown', 'unknown delivery blocks resend and checks only the original nonce'],
  ['stale-snapshot', 'a late snapshot cannot repaint another selected source'],
]) {
  test(description, () => {
    assert.equal(execFileSync(binary, [scenario], { encoding: 'utf8', timeout: 5000 }).trim(), 'ok');
  });
}
