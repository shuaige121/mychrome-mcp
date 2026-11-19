#!/usr/bin/env node
/* CC-LIVE: the GUI conversation centre's Claude host (src/gui-service.js) over its real local IPC socket, fed by the
 * real connection source (src/visible-feed-claude.js) on a synthetic transcript under a temporary HOME. Read-only:
 * send → read_only / not_sent; discover and bind → read_only_mirror; presence never carries prose. Other clients get
 * browser_only. No Codex host, no real conversation, no Chrome. CLAUDE_CODE_* / KITTY_* / CLAUDECODE are scrubbed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const key of Object.keys(process.env)) {
  if (/^(CLAUDE_CODE_|KITTY_)/.test(key) || ['CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CHROME_BRIDGE_CLAUDE_FEED'].includes(key)) delete process.env[key];
}
const { startConversationService } = await import('../src/gui-service.js');
const { requestGui } = await import('../src/gui-ipc.js');
const { connectClaudeSource } = await import('../src/visible-feed-claude.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-gui-claude-'));
const home = path.join(tmp, 'home');
const SID = '11111111-2222-4333-8444-555555555555';
const NEW_SID = '33333333-2222-4333-8444-555555555555';
const SENTINEL = 'GUI-SENTINEL-41c2';
const project = path.join(home, '.claude', 'projects', '-synthetic');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
const transcript = path.join(project, `${SID}.jsonl`);
fs.writeFileSync(transcript, '');
let seq = 0;
const line = (record, sessionId = SID) => JSON.stringify({ isSidechain: false, sessionId, uuid: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  timestamp: new Date().toISOString(), ...record }) + '\n';
const say = (text, sessionId) => line({ type: 'assistant', apiBlockIndex: 0, message: { id: `msg_${++seq}`, role: 'assistant', content: [{ type: 'text', text }] } }, sessionId);
const ask = text => line({ type: 'user', message: { role: 'user', content: text } });
const registry = (status, sessionId = SID) => fs.writeFileSync(path.join(home, '.claude', 'sessions', '4242.json'),
  JSON.stringify({ pid: 4242, sessionId, updatedAt: Date.now() + 1000, status }));

let passed = 0;
const failures = [];
async function check(name, run) {
  try { await run(); passed++; console.log(`ok - ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL - ${name}\n${error.stack}`); }
}

const presences = [];
let discovered = 0;
// A unix socket path must stay short (104 bytes): the GUI base lives directly under /tmp, as in the other GUI tests.
const base = fs.mkdtempSync('/tmp/cb-gcm-');
const service = await startConversationService({
  base, onPresence: fields => presences.push(fields),
  connect: () => { throw new Error('no Codex host in this test'); },
  discover: async () => { discovered++; return [{ threadId: 'codex-thread', title: 'Codex' }]; },
});
const presence = () => presences.at(-1);
const call = (op, payload) => requestGui({ base, pid: process.pid, instance: presence().guiInstance, op, payload });
registry('busy');
const source = connectClaudeSource({ env: { CLAUDE_CODE_SESSION_ID: SID }, home, clientPid: 4242, startedAt: Date.now(),
  setInterval: () => ({ unref() {} }), clearInterval: () => {}, isAlive: () => false });

try {
  await check('N1 GUI: a Claude binding is connected with no tool call; prompts and replies arrive with their roles', async () => {
    service.bind(SID, 'Claude', { source, reason: null });
    assert.equal(presence().conversationProvider, 'Claude');
    assert.equal(presence().conversationThread, SID);
    assert.equal(presence().conversationStatus, 'connected');
    fs.appendFileSync(transcript, ask(`Check the form ${SENTINEL}-prompt.`) + say(`Opening the form ${SENTINEL}.`));
    source.poll();
    const { snapshot } = await call('snapshot');
    assert.equal(snapshot.status, 'connected');
    assert.equal(snapshot.threadId, SID);
    assert.equal(snapshot.bindingId, presence().conversationBinding);
    assert.equal(snapshot.canSend, false);
    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.threadStatus, 'active', 'registry busy → active');
    assert.deepEqual(snapshot.entries.map(e => [e.role, e.text]),
      [['user', `Check the form ${SENTINEL}-prompt.`], ['assistant', `Opening the form ${SENTINEL}.`]]);
    assert.ok(snapshot.entries.every(e => Number.isFinite(e.at)));
  });

  await check('N9 read-only: send → read_only / not_sent; discover and bind → read_only_mirror', async () => {
    const { snapshot } = await call('snapshot');
    const sent = await call('send', { nonce: 'reply-1', bindingId: snapshot.bindingId, threadId: snapshot.threadId, text: 'A reply' });
    assert.deepEqual([sent.ok, sent.code, sent.delivery], [false, 'read_only', 'not_sent']);
    const before = discovered;
    assert.equal((await call('discover')).code, 'read_only_mirror');
    assert.equal((await call('bind', { threadId: 'codex-thread' })).code, 'read_only_mirror');
    assert.equal(discovered, before, 'no discovery for a Claude connection');
  });

  await check('N12 presence: no prompt or reply text in any presence field; no title for Claude', async () => {
    fs.appendFileSync(transcript, say(`Later reply ${SENTINEL}.`));
    source.poll();
    await call('snapshot');
    assert.ok(presences.length > 1);
    for (const fields of presences) assert.doesNotMatch(JSON.stringify(fields), new RegExp(SENTINEL));
    assert.equal(presence().conversationTitle, null);
  });

  await check('labels: feed_off, a missing source and other clients carry their own reason, never unsupported', async () => {
    service.bind(SID, 'Claude', { source: null, reason: 'feed_off' });
    let { snapshot } = await call('snapshot');
    assert.deepEqual([snapshot.status, snapshot.reason, snapshot.entries.length, snapshot.readOnly], ['unavailable', 'feed_off', 0, true]);
    service.bind(null, 'Claude', { source: null, reason: 'transcript_unavailable' });
    ({ snapshot } = await call('snapshot'));
    assert.deepEqual([snapshot.threadId, snapshot.reason], [null, 'transcript_unavailable']);
    service.bind(null, 'Cursor');
    ({ snapshot } = await call('snapshot'));
    assert.equal(snapshot.reason, 'browser_only');
    assert.equal((await call('discover')).code, 'browser_only');
    for (const fields of presences) assert.doesNotMatch(JSON.stringify(fields), /unsupported/);
  });

  await check('N5 GUI: after a registry change the row names the new session and a new bindingId before any of its entries', async () => {
    service.bind(SID, 'Claude', { source, reason: null });
    fs.appendFileSync(transcript, say('Old session prose.'));
    source.poll();
    const before = (await call('snapshot')).snapshot;
    assert.equal(before.threadId, SID);
    assert.ok(before.entries.some(e => e.text === 'Old session prose.'));
    const oldBinding = before.bindingId;
    const seen = [];
    const newFile = path.join(project, `${NEW_SID}.jsonl`);
    fs.writeFileSync(newFile, say('New file history.', NEW_SID));
    registry('idle', NEW_SID);
    fs.appendFileSync(transcript, say('Old file, after the change.'));
    source.poll();   // the source follows the new session; its change listener publishes through the service
    assert.equal(presence().conversationThread, NEW_SID, 'presence (row and tooltip) names the new session');
    assert.notEqual(presence().conversationBinding, oldBinding);
    seen.push((await call('snapshot')).snapshot);
    fs.appendFileSync(newFile, say(`New session prose ${SENTINEL}.`, NEW_SID));
    source.poll();
    seen.push((await call('snapshot')).snapshot);
    service.bind(SID, 'Claude', { source, reason: null });   // the 2 s metadata poll still passes the launch id
    seen.push((await call('snapshot')).snapshot);
    for (const snap of seen) {
      assert.equal(snap.threadId, NEW_SID);
      assert.notEqual(snap.bindingId, oldBinding);
      assert.equal(snap.bindingId, presence().conversationBinding);
      assert.ok(!snap.entries.some(e => /Old|history/.test(e.text)), 'old-session text or new-file history shown');
    }
    assert.deepEqual(seen.at(-1).entries.map(e => e.text), [`New session prose ${SENTINEL}.`]);
    for (const fields of presences) assert.doesNotMatch(JSON.stringify(fields), new RegExp(SENTINEL));
    const sent = await call('send', { nonce: 'reply-n5', bindingId: oldBinding, threadId: SID, text: 'late reply' });
    assert.deepEqual([sent.ok, sent.delivery], [false, 'not_sent']);
  });

  await check('lifetime: rebinding the GUI drops only its subscription; the source keeps running', async () => {
    service.bind(NEW_SID, 'Claude', { source, reason: null });
    assert.equal(source.stats().listeners, 1);
    service.bind(null, 'Cursor');
    assert.equal(source.stats().listeners, 0);
    fs.appendFileSync(path.join(project, `${NEW_SID}.jsonl`), say('Still followed.', NEW_SID));   // the session N5 moved to
    source.poll();
    assert.ok(source.snapshot().entries.some(e => e.text === 'Still followed.'));
    assert.equal(source.snapshot().status, 'connected');
  });
} finally {
  source.close();
  service.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(base, { recursive: true, force: true });
}
if (failures.length) { console.error(`gui-claude-mirror: ${failures.length} failed: ${failures.join('; ')}`); process.exit(1); }
console.log(`gui-claude-mirror: ${passed} passed`);
