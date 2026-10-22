import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Compile only production declarations and pure display/identity helpers.
// The probe imports Foundation, never AppKit, and reads only synthetic arguments.
const menu = readFileSync(new URL('../src/menubar.swift', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/conversation-ui.swift', import.meta.url), 'utf8');
function declaration(source, kind, name) {
  const start = source.search(new RegExp(`^${kind} ${name}(?=[:\\s(])`, 'm'));
  assert.ok(start >= 0, `Production declaration missing: ${kind} ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `Production declaration incomplete: ${kind} ${name}`);
  return source.slice(start, end + 2);
}
const declarations = [
  'struct ConversationEntry: Identifiable { let id: String, text: String }',
  declaration(ui, 'struct', 'ConversationState'),
  declaration(ui, 'struct', 'ConversationPresentation'),
  ...['Check', 'SetupChecks', 'ServerInfo', 'AgentTask'].map(name => declaration(menu, 'struct', name)),
  declaration(menu, 'func', 'liveServers'),
  ...['conversationName', 'conversationClient', 'conversationIsVisible', 'conversationKey', 'hasPreviousBindingDraft',
    'conversationPresentation', 'conversationDeliveryPresentation', 'managedConversationFailure', 'canInterruptConversation']
    .map(name => declaration(ui, 'func', name)),
].join('\n');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mychrome-gui-list-'));
const swift = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'probe'), presence = path.join(tmp, 'synthetic.json');
after(() => {
  for (const file of [swift, binary, presence]) {
    try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  rmdirSync(tmp);
});
writeFileSync(swift, `import Foundation
${declarations}
let SERVER_DIR = CommandLine.arguments[2]
var syntheticPresence: [String: Any] = [:]
func readJSON(_ path: String) -> [String: Any]? { syntheticPresence }
func alive(_ pid: Int32) -> Bool { pid > 0 }
func jsonNum(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }
func parseSetupChecks(_ value: Any?) -> SetupChecks? { nil }
let rows = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [[String: Any]]
let results: [[String: Any]] = rows.map { row in
    let id = (row["pid"] as? NSNumber)?.int32Value ?? 101
    let who = row["who"] as? String ?? "Codex · 主目录"
    syntheticPresence = ["pid": id, "who": who]
    for (source, target) in ["busy": "busy", "launcher": "launcher", "instance": "guiInstance",
        "thread": "conversationThread", "binding": "conversationBinding", "pending": "conversationPending",
        "title": "conversationTitle", "provider": "conversationProvider", "status": "conversationStatus",
        "managed": "managedSession", "model": "model", "effort": "effort", "cwd": "cwd"] {
        syntheticPresence[target] = row[source]
    }
    let server = liveServers()[0]
    let task: AgentTask? = row["task"] != nil || row["alert"] != nil
        ? AgentTask(id: id, who: who, task: row["task"] as? String ?? "", stepName: "",
            current: nil, total: nil, color: 0, etaMs: nil, etaAt: nil,
            alert: row["alert"] as? String, alertTab: row["alertTab"] as? Int)
        : nil
    let state = (row["state"] as? [String: Any]).map(ConversationState.init)
    let presentation = conversationPresentation(server, task: task, state: state)
    let delivery = conversationDeliveryPresentation(row["delivery"] as? String ?? "")
    return ["name": conversationName(server, task: task), "client": conversationClient(server),
        "presentation": ["kind": presentation.kind, "label": presentation.label, "symbol": presentation.symbol, "tone": presentation.tone],
        "delivery": ["kind": delivery.kind, "label": delivery.label, "symbol": delivery.symbol, "tone": delivery.tone],
        "visible": conversationIsVisible(server, task: task, hasActiveContext: row["activeContext"] as? Bool ?? false),
        "key": conversationKey(server),
        "managed": server.managedSession, "model": server.model ?? NSNull(), "effort": server.effort ?? NSNull(), "cwd": server.cwd ?? NSNull(),
        "canInterrupt": canInterruptConversation(server, state: state, sending: row["sending"] as? Bool ?? false),
        "managedFailure": managedConversationFailure(state) ?? NSNull(),
        "feedPlaceholder": ConversationState(row["state"] as? [String: Any] ?? [:]).feedPlaceholder,
        "hasPreviousDraft": hasPreviousBindingDraft(server, drafts: row["drafts"] as? [String: String] ?? [:])]
}
print(String(decoding: try JSONSerialization.data(withJSONObject: results), as: UTF8.self))
`);
execFileSync('/usr/bin/swiftc', [swift, '-o', binary], { timeout: 60_000, stdio: 'pipe' });
writeFileSync(presence, '{}');
const inspect = (...rows) => JSON.parse(execFileSync(binary, [JSON.stringify(rows), tmp], {
  encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
}));

test('a verified conversation title wins over task, client and working-directory labels', () => {
  const [result] = inspect({ title: '  核对招生页面\n', task: '另一个当前任务', who: 'Claude · 主目录', provider: 'Codex', thread: 'thread-a' });
  assert.equal(result.name, '核对招生页面');
  assert.equal(result.client, 'Codex');
});

test('bound but disconnected, connecting and unsupported sessions never claim a live association', () => {
  const rows = inspect(
    { instance: 'gui-a', provider: 'Codex', thread: 'a', status: 'disconnected' },
    { instance: 'gui-a', provider: 'Codex', thread: 'a', status: 'connecting' },
    { instance: 'gui-a', provider: 'Claude', status: 'unavailable' },
    { instance: 'gui-a', provider: 'Codex', thread: 'a' },
  );
  assert.deepEqual(rows.map(row => row.presentation.kind), ['disconnected', 'connecting', 'unsupported', 'unavailable']);
  for (const row of rows) {
    assert.equal(row.presentation.tone, 'gray');
    assert.doesNotMatch(row.presentation.label, /已关联|已连接|完成|成功/);
    assert.ok(row.presentation.symbol);
  }
});

test('only same-thread metadata or an actual busy operation marks a conversation running', () => {
  const base = { instance: 'gui-a', provider: 'Codex', thread: 'a', status: 'connected' };
  const rows = inspect(
    { ...base, state: { threadId: 'a', status: 'connected', threadStatus: 'active' } },
    { ...base, busy: 'read_page' },
    { ...base, state: { threadId: 'other', status: 'connected', threadStatus: 'active' } },
    { ...base, state: { threadId: 'a', status: 'connected', threadStatus: 'idle' } },
    { ...base, status: 'disconnected', state: { threadId: 'a', status: 'connected', threadStatus: 'active' } },
  );
  assert.deepEqual(rows.map(row => row.presentation.kind), ['running', 'running', 'connected', 'idle', 'disconnected']);
  assert.deepEqual(rows.map(row => row.presentation.tone), ['blue', 'blue', 'gray', 'gray', 'gray']);
});

test('managed Codex and Claude use their actual conversation state while external Claude stays unsupported', () => {
  const base = { instance: 'managed-a', thread: 'managed-thread', status: 'connected', managed: true,
    model: 'reported-model', effort: 'high', cwd: '/synthetic/project',
    state: { threadId: 'managed-thread', status: 'connected', threadStatus: 'idle', canSend: true } };
  const rows = inspect({ ...base, provider: 'Codex' }, { ...base, provider: 'Claude' },
    { ...base, provider: 'Claude', managed: false },
    { ...base, provider: 'Claude', model: null, effort: null, cwd: null });
  assert.deepEqual(rows.map(r => r.presentation.kind), ['idle', 'idle', 'unsupported', 'idle']);
  assert.deepEqual(rows.slice(0, 2).map(r => [r.managed, r.model, r.effort, r.cwd]),
    Array(2).fill([true, 'reported-model', 'high', '/synthetic/project']));
  assert.equal(rows[3].model, null); assert.equal(rows[3].effort, null); assert.equal(rows[3].cwd, null);
});

test('a genuine pending question or page alert takes attention priority over active work', () => {
  const base = { instance: 'gui-a', provider: 'Codex', thread: 'a', status: 'connected', busy: 'click' };
  const rows = inspect(
    { ...base, pending: 1 },
    { ...base, alert: '请处理页面', status: 'disconnected' },
    { ...base, state: { threadId: 'a', status: 'connected', threadStatus: 'active', pending: [{ requestId: 'q' }] } },
  );
  for (const row of rows) {
    assert.equal(row.presentation.kind, 'waiting');
    assert.equal(row.presentation.tone, 'orange');
    assert.equal(row.presentation.symbol, 'hand.raised.fill');
  }
});

test('managed generation failures remain explicit even when the connection is idle and ready', () => {
  const base = { instance: 'managed-a', provider: 'Codex', thread: 'a', status: 'connected', managed: true };
  const rows = inspect(...['turn_failed', 'claude_turn_failed', 'message_too_large', 'claude_delivery_unconfirmed'].map(reason => ({
    ...base, state: { threadId: 'a', status: 'connected', threadStatus: 'idle', canSend: true, reason },
  })), { ...base, state: { threadId: 'other', status: 'connected', reason: 'turn_failed' } });
  for (const row of rows.slice(0, 4)) {
    assert.equal(row.presentation.kind, 'error'); assert.equal(row.presentation.tone, 'red');
    assert.ok(row.managedFailure); assert.doesNotMatch(row.managedFailure, /turn_failed|claude_/);
  }
  assert.equal(rows[4].presentation.kind, 'connected');
});

test('stop generation remains available during managed send and turn-start waiting', () => {
  const base = { instance: 'managed-a', provider: 'Codex', thread: 'a', status: 'connected', managed: true };
  const idle = { threadId: 'a', status: 'connected', threadStatus: 'idle' };
  const rows = inspect(
    { ...base, state: idle },
    { ...base, state: idle, sending: true },
    { ...base, state: { ...idle, sending: true } },
    { ...base, state: { ...idle, threadStatus: 'active' } },
    { ...base, sending: true },
    { ...base, state: { ...idle, threadStatus: 'active' }, status: 'disconnected' },
    { ...base, state: { ...idle, threadStatus: 'active' }, managed: false },
    { ...base, state: { ...idle, threadId: 'other', threadStatus: 'active' } },
  );
  assert.deepEqual(rows.map(row => row.canInterrupt), [false, true, true, true, true, false, false, false]);
});

test('delivery colors distinguish acceptance, refusal and uncertainty without claiming task success', () => {
  const rows = inspect(...['sending', 'accepted', 'rejected', 'unknown', 'resolved', 'not_sent', 'released'].map(delivery => ({ delivery })));
  assert.deepEqual(rows.map(row => row.delivery.tone), ['blue', 'green', 'red', 'orange', 'orange', 'orange', 'gray']);
  assert.match(rows[1].delivery.label, /送达/);
  assert.doesNotMatch(rows[1].delivery.label, /任务|完成|成功/);
  for (const row of rows) { assert.ok(row.delivery.symbol); assert.ok(row.delivery.label); }
});

test('ordinary prose, message completion, title and client names cannot imply task success or failure', () => {
  const base = { instance: 'gui-a', provider: 'Codex', thread: 'a', status: 'connected' };
  const rows = inspect(...['全部完成', '失败了', '下一步计划', '请你回复'].map(text => ({
    ...base, title: text, state: { threadId: 'a', status: 'connected', threadStatus: 'idle', entries: [{ id: 'm', text, complete: true }] },
  })));
  for (const row of rows) { assert.equal(row.presentation.kind, 'idle'); assert.equal(row.presentation.tone, 'gray'); }
});

test('blank titles fall back to the actual task, then to an explicit unnamed or unassociated label', () => {
  const results = inspect(
    { title: ' \n\t', task: '  检查合成表单 \n' },
    { title: ' \n\t', task: '\t ', thread: 'thread-a' },
    { title: '', task: ' \n', who: 'Claude · private-directory' },
    { who: 'Codex · 主目录' },
  );
  assert.deepEqual(results.map(result => result.name), ['检查合成表单', '未命名对话', '尚未关联对话', '尚未关联对话']);
});

test('client labels use the provider or client type without directory noise', () => {
  const results = inspect(
    { provider: 'Claude', who: 'Codex · irrelevant-directory' },
    { who: 'Claude · 主目录' },
    { provider: '', who: 'Codex · synthetic-project' },
  );
  assert.deepEqual(results.map(result => result.client), ['Claude', 'Claude', 'Codex']);
});

test('idle unbound connections collapse, including whitespace-only tasks and stale display titles', () => {
  const results = inspect({}, { task: ' \t\n' }, { title: '此前显示过的标题' });
  assert.deepEqual(results.map(result => result.visible), [false, false, false]);
});

for (const [name, row] of [
  ['pending questions', { pending: 1 }],
  ['Claude page handoff without a bound thread or GUI instance', { who: 'Claude · 主目录', provider: 'Claude', alert: '请处理合成网页', alertTab: 42 }],
  ['an active browser call', { busy: 'read_page' }],
  ['a real current task', { task: '核对合成页面' }],
  ['a bound conversation', { thread: 'thread-a' }],
  ['retained selection, draft or delivery context', { activeContext: true }],
]) {
  test(`${name} stays visible`, () => assert.equal(inspect(row)[0].visible, true));
}

test('identical names and a shared launcher cannot merge distinct connection identities', () => {
  const common = { title: '同名任务', who: 'Claude · 主目录', provider: 'Claude', launcher: 900,
    instance: 'gui-a', thread: 'thread-a', binding: 'binding-a' };
  const [a, b] = inspect({ ...common, pid: 101 }, { ...common, pid: 102 });
  assert.equal(a.name, b.name);
  assert.notEqual(a.key, b.key);
  assert.equal(a.key, '101:gui-a:thread-a:binding-a');
});

test('changing display metadata or the shared parent leaves reply identity unchanged', () => {
  const destination = { pid: 101, instance: 'gui-a', thread: 'thread-a', binding: 'binding-a' };
  const results = inspect(
    { ...destination, launcher: 900, title: '原名称', task: '原任务', who: 'Claude · 主目录' },
    { ...destination, launcher: 901, title: '新名称', task: '新任务', who: 'Codex · 新目录', provider: 'Codex' },
  );
  assert.notEqual(results[0].name, results[1].name);
  assert.equal(results[0].key, results[1].key);
});

test('instance, thread and binding changes remain separate even when the PID and title are identical', () => {
  const same = { pid: 101, title: '同名任务', instance: 'gui-a', thread: 'thread-a', binding: 'binding-a' };
  const results = inspect(same, { ...same, instance: 'gui-b' }, { ...same, thread: 'thread-b' }, { ...same, binding: 'binding-b' });
  assert.equal(new Set(results.map(result => result.key)).size, 4);
  assert.equal(inspect({ pid: 101 })[0].key, '101:legacy::');
});

test('only a connected live feed claims to be connected; unavailable and unknown states do not', () => {
  const reasons = ['host_unavailable', 'thread_inactive', 'host_rejected', 'invalid_host_message',
    'conversation_changed', 'unsupported_client', 'unbound_thread', 'upgrade_required', 'future_reason'];
  const results = inspect(...reasons.map(reason => ({ state: { status: 'unavailable', reason } })),
    {}, { state: { status: 'disconnected' } }, { state: { status: 'connecting' } });
  for (const result of results) assert.doesNotMatch(result.feedPlaceholder, /已连接/);
  assert.match(inspect({ state: { status: 'connected' } })[0].feedPlaceholder, /已连接/);
});

test('reconnected drafts are offered only for the same worker instance and thread', () => {
  const row = { pid: 101, instance: 'gui-a', thread: 'thread-a', binding: 'new' };
  assert.equal(inspect({ ...row, drafts: { '101:gui-a:thread-a:old': 'Unsent text' } })[0].hasPreviousDraft, true);
  for (const key of ['101:gui-a:thread-a:new', '102:gui-a:thread-a:old', '101:gui-b:thread-a:old', '101:gui-a:thread-ab:old']) {
    assert.equal(inspect({ ...row, drafts: { [key]: 'Unsent text' } })[0].hasPreviousDraft, false);
  }
  assert.equal(inspect({ ...row, drafts: { '101:gui-a:thread-a:old': '' } })[0].hasPreviousDraft, false);
});
