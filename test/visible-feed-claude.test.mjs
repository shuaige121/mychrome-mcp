#!/usr/bin/env node
/* CC-LIVE (problems-20261101/contracts-batch4.md, design inv-batch4/cclive-fable.md §2): the connection-lifetime
 * Claude Code source (src/visible-feed-claude.js) on synthetic transcripts and a synthetic session registry under a
 * temporary HOME. Fake clock and explicit polls, except the latency case. Never opens a real ~/.claude file: every path
 * is built from the temporary root, and CLAUDE_CODE_* / KITTY_* / CLAUDECODE are scrubbed first.
 * Kept from SIDEBAR-CC: admission, integrity and bounds fixtures. CASE=<substring> runs only the matching cases. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

for (const key of Object.keys(process.env)) {
  if (/^(CLAUDE_CODE_|KITTY_)/.test(key) || ['CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CHROME_BRIDGE_CLAUDE_FEED'].includes(key)) delete process.env[key];
}
const M = await import('../src/visible-feed-claude.js');
const { resolveClaudeTranscript, connectClaudeSource, CLAUDE_FEED_LIMITS, CLAUDE_FEED_TIMING } = M;

const ONLY = process.env.CASE || null;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-claude-source-'));
const SID = '11111111-2222-4333-8444-555555555555';
const OTHER_SID = '99999999-2222-4333-8444-555555555555';
const NEW_SID = '33333333-2222-4333-8444-555555555555';
const PID = 4242;
let passed = 0, seq = 0, clock = 1_800_000_000_000;
const failures = [];
const now = () => clock;
const timers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };

async function check(name, run) {
  if (ONLY && !name.includes(ONLY)) return;
  try { await run(); passed++; console.log(`ok - ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL - ${name}\n${error.stack}`); }
}

function fixture({ sid = SID, project = 'proj', content = '', file = true } = {}) {
  const home = path.join(root, `home${++seq}`);
  const dir = path.join(home, '.claude', 'projects', `-Users-synthetic-${project}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const f = {
    home, dir, env: { CLAUDE_CODE_SESSION_ID: sid },
    file: path.join(dir, `${sid}.jsonl`),
    fileFor: id => path.join(dir, `${id}.jsonl`),
    append(...records) { fs.appendFileSync(f.file, records.map(r => typeof r === 'string' ? r : JSON.stringify(r) + '\n').join('')); },
    appendTo(target, ...records) { fs.appendFileSync(target, records.map(r => typeof r === 'string' ? r : JSON.stringify(r) + '\n').join('')); },
    registry(pid, fields) {
      fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({
        cwd: '/synthetic', startedAt: clock - 60_000, kind: 'interactive', entrypoint: 'cli', name: 'synthetic',
        messagingSocketPath: '/synthetic/socket', version: '2.1.318', ...fields }));
    },
  };
  if (file) fs.writeFileSync(f.file, content);
  return f;
}
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const stamp = () => new Date(clock).toISOString();
const base = (over = {}) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd: '/synthetic', sessionId: SID,
  version: '2.1.318', uuid: uuid(), timestamp: stamp(), ...over });
const say = (text, { mid = `msg_${++seq}`, index = 0, ...over } = {}) => base({ type: 'assistant', apiBlockIndex: index,
  message: { id: mid, type: 'message', role: 'assistant', model: 'claude-synthetic', content: [{ type: 'text', text }] }, ...over });
const ask = (content, over = {}) => base({ type: 'user', message: { role: 'user', content }, ...over });
const use = (id, input = {}, over = {}) => base({ type: 'assistant', apiBlockIndex: 1,
  message: { id: `msg_${++seq}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__chrome-bridge__click', input }] }, ...over });

/** A source as index.js builds it: launch env, this relay's client pid, fake clock, no real timers. */
function start(f, options = {}) {
  let changes = 0;
  const source = connectClaudeSource({ env: f.env, home: f.home, clientPid: PID, startedAt: clock, now, ...timers,
    isAlive: () => false, onChange: () => { changes++; }, ...options });
  return { source, texts: () => source.snapshot().entries.map(e => e.text),
    roles: () => source.snapshot().entries.map(e => `${e.role}:${e.text}`), changes: () => changes };
}

/* ------------------------------------------------------------------ binding and roles (N1, N2) */

await check('N1 binding: the launch session id binds at connect with no tool call; only new records appear', () => {
  const f = fixture();
  f.append(say('History before connect.'), ask('History prompt.'));
  const h = start(f);
  assert.equal(h.source.snapshot().status, 'connected');
  assert.equal(h.source.snapshot().reason, null);
  f.append(ask('Please check the page.'), say('Opening the page now.'));
  h.source.poll();
  assert.deepEqual(h.roles(), ['user:Please check the page.', 'assistant:Opening the page now.']);
  assert.equal(h.source.snapshot().canSend, false);
  assert.equal(h.source.snapshot().sessionId, SID);
  h.source.close();
});

await check('N2 roles: a typed prompt (string) and a text-block prompt are user entries with their time', () => {
  const f = fixture();
  const h = start(f);
  f.append(ask('Typed as a string.'), ask([{ type: 'text', text: 'Typed as' }, { type: 'text', text: 'two text blocks.' }]));
  h.source.poll();
  const entries = h.source.snapshot().entries;
  assert.deepEqual(entries.map(e => [e.role, e.text]), [['user', 'Typed as a string.'], ['user', 'Typed as\ntwo text blocks.']]);
  assert.ok(entries.every(e => e.at === clock && e.id.startsWith('user:')));
  h.source.close();
});

/* ------------------------------------------------------------------ admission (N3, N4) */

await check('N3 user records: tool results, meta, compact summaries, mixed blocks, sidechain and foreign sessions are never shown', () => {
  const f = fixture();
  const h = start(f);
  const S = n => `PLANTED-USER-${n}`;
  f.append(
    ask([{ type: 'tool_result', tool_use_id: 'toolu_x', content: S('tool-result') }], { toolUseResult: { stdout: S('tool-use-result') } }),
    ask(S('with-tool-use-result'), { toolUseResult: 'x' }),
    ask(S('meta'), { isMeta: true }),
    ask(S('compact-summary'), { isCompactSummary: true }),
    ask([{ type: 'text', text: S('mixed-text') }, { type: 'tool_result', tool_use_id: 'toolu_y', content: S('mixed-result') }]),
    ask([{ type: 'text', text: S('with-image') }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }]),
    ask(S('sidechain'), { isSidechain: true }),
    ask(S('foreign-session'), { sessionId: OTHER_SID }),
    ask(`<bash-stdout>${S('bash-stdout')}</bash-stdout>`),
    ask(`<command-name>/model</command-name><command-args>${S('command')}</command-args>`),
    ask(`[Request interrupted by user] ${S('interrupt')}`),
    base({ type: 'user', message: { role: 'assistant', content: S('role-assistant-in-user') } }),
    ask('The one real prompt.'),
  );
  h.source.poll();
  assert.deepEqual(h.roles(), ['user:The one real prompt.']);
  assert.doesNotMatch(JSON.stringify(h.source.snapshot()), /PLANTED-USER/);
  h.source.close();
});

await check('N4 assistant records: planted secrets in thinking, tool data, blobs, hooks, sidechain and foreign records are never shown', () => {
  const f = fixture();
  const h = start(f);
  const S = n => `PLANTED-SECRET-${n}`;
  const blobContent = [{ type: 'text', text: S('blob-text') }, { type: 'thinking', thinking: S('blob-thinking') },
    { type: 'tool_use', id: 'toolu_blob0000000', name: 'x', input: { s: S('blob-input') } }, { type: 'tool_result', content: S('blob-result') }];
  f.append(
    base({ type: 'assistant', apiBlockIndex: 0, message: { id: 'msg_t', role: 'assistant', content: [{ type: 'thinking', thinking: S('thinking'), signature: 'x' }] } }),
    use('toolu_other000000001', { text: S('tool-input') }),
    base({ type: 'api-request-blob', messages: [{ role: 'assistant', content: blobContent }] }),
    base({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: S('blob-as-message') }] } }),
    base({ type: 'attachment', message: { role: 'assistant', content: [{ type: 'text', text: S('attachment') }] } }),
    base({ type: 'system', subtype: 'stop_hook_summary', content: S('hook'), message: { role: 'assistant', content: [{ type: 'text', text: S('system-text') }] } }),
    say(S('sidechain'), { isSidechain: true }),
    say(S('meta'), { isMeta: true }),
    say(S('api-error'), { isApiErrorMessage: true }),
    say(S('foreign-session'), { sessionId: OTHER_SID }),
    base({ type: 'assistant', message: { id: 'msg_u', role: 'user', content: [{ type: 'text', text: S('role-user') }] } }),
    base({ type: 'assistant', apiBlockIndex: 2, message: { id: 'msg_r', role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x', text: S('non-text-block') }] } }),
    say('Visible synthetic progress.\n```sh\nrm -rf /tmp/' + S('fenced') + '\n```'),
  );
  h.source.poll();
  assert.deepEqual(h.roles(), ['assistant:Visible synthetic progress.']);
  assert.doesNotMatch(JSON.stringify(h.source.snapshot()), /PLANTED-SECRET/);
  h.source.close();
});

await check('identity: records sharing one message.id are separate blocks; uuid dedupes', () => {
  const f = fixture();
  const h = start(f);
  const mid = 'msg_shared';
  const first = say('First part.', { mid, index: 1 });
  f.append(
    base({ type: 'assistant', apiBlockIndex: 0, message: { id: mid, role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden', signature: 's' }] } }),
    first, use('toolu_shared00000002', { e: 1 }, { apiBlockIndex: 2, message: { id: mid, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_shared00000002', name: 'x', input: {} }] } }),
    say('Second part.', { mid, index: 3 }), first);
  h.source.poll();
  assert.deepEqual(h.texts(), ['First part.', 'Second part.']);
  assert.deepEqual(h.source.snapshot().entries.map(e => e.id), [`${mid}:1`, `${mid}:3`]);
  h.source.close();
});

await check('boundary: EOF inside an incomplete record skips that record and all history', () => {
  const f = fixture();
  f.append(say('History one.'));
  const two = JSON.stringify(say('History two.')) + '\n';
  f.append(two.slice(0, 40));
  const h = start(f);
  f.append(two.slice(40), say('Live after the boundary.'));
  h.source.poll();
  assert.deepEqual(h.texts(), ['Live after the boundary.']);
  h.source.close();
});

await check('fork: copied history in the file at connect is never shown', () => {
  const parent = fixture();
  parent.append(say('Parent history one.'), ask('Parent prompt.'), say('Parent history two.'));
  const fork = fixture({ content: fs.readFileSync(parent.file) });
  const h = start(fork);
  fork.append(say('Fork live prose.'));
  h.source.poll();
  assert.deepEqual(h.texts(), ['Fork live prose.']);
  h.source.close();
});

await check('late file: a session file that appears after connect is read from its start, records stamped before connect excluded', () => {
  const f = fixture({ file: false });
  const h = start(f);
  assert.equal(h.source.snapshot().status, 'connected');
  h.source.poll();
  assert.deepEqual(h.texts(), []);
  const old = base({ timestamp: new Date(clock - 60_000).toISOString() });
  clock += 5000;
  f.appendTo(f.file, { ...say('Copied from an older session.'), timestamp: old.timestamp }, ask('First prompt.'), say('First reply.'));
  h.source.poll();
  assert.deepEqual(h.roles(), ['user:First prompt.', 'assistant:First reply.']);
  h.source.close();
});

/* ------------------------------------------------------------------ currency and ambiguity (N5–N8) */

await check('N5 session change: the registry names a new session -> old entries cleared, old file no longer read, new file from its EOF', () => {
  const f = fixture();
  f.registry(PID, { pid: PID, sessionId: SID, updatedAt: clock, status: 'busy' });
  const h = start(f);
  f.append(say('Old session prose.'));
  h.source.poll();
  assert.deepEqual(h.texts(), ['Old session prose.']);
  assert.equal(h.source.snapshot().threadStatus, 'busy');
  const newFile = f.fileFor(NEW_SID);
  f.appendTo(newFile, { ...say('New file history.'), sessionId: NEW_SID });
  clock += 3000;
  f.registry(PID, { pid: PID, sessionId: NEW_SID, updatedAt: clock, status: 'idle' });
  f.append(say('Old file, after the change.'));
  h.source.poll();
  assert.deepEqual(h.texts(), [], 'old text cleared and the old file not read after the change');
  assert.equal(h.source.snapshot().sessionId, NEW_SID);
  assert.equal(h.source.snapshot().status, 'connected');
  f.appendTo(newFile, { ...say('New session prose.'), sessionId: NEW_SID });
  f.append(say('Old file, later still.'));
  h.source.poll();
  assert.deepEqual(h.texts(), ['New session prose.']);
  h.source.close();
});

await check('N5 session change: when the new session cannot be resolved the source stops with session_changed', () => {
  const f = fixture();
  f.registry(PID, { pid: PID, sessionId: SID, updatedAt: clock, status: 'idle' });
  const h = start(f);
  f.append(say('Old session prose.'));
  h.source.poll();
  fs.mkdirSync(path.join(f.home, '.claude', 'projects', 'second'));
  for (const dir of [f.dir, path.join(f.home, '.claude', 'projects', 'second')]) fs.writeFileSync(path.join(dir, `${NEW_SID}.jsonl`), '');
  clock += 3000;
  f.registry(PID, { pid: PID, sessionId: NEW_SID, updatedAt: clock, status: 'idle' });
  h.source.poll();
  assert.equal(h.source.snapshot().status, 'unavailable');
  assert.equal(h.source.snapshot().reason, 'session_changed');
  assert.deepEqual(h.texts(), []);
  h.source.close();
});

await check('N6 registry as a hint: another pid, an entry older than the relay, a missing or broken entry -> the launch id stands', () => {
  for (const [label, prepare] of [
    ['pid differs', f => f.registry(PID, { pid: PID + 1, sessionId: NEW_SID, updatedAt: clock + 10_000, status: 'busy' })],
    ['older than the relay', f => f.registry(PID, { pid: PID, sessionId: NEW_SID, updatedAt: clock - 10_000, status: 'busy' })],
    ['missing', () => {}],
    ['broken', f => fs.writeFileSync(path.join(f.home, '.claude', 'sessions', `${PID}.json`), '{ broken')],
  ]) {
    const f = fixture();
    const h = start(f);
    prepare(f);
    f.appendTo(f.fileFor(NEW_SID), { ...say(`Other session (${label}).`), sessionId: NEW_SID });
    f.append(say(`Launch session (${label}).`));
    h.source.poll();
    assert.deepEqual(h.texts(), [`Launch session (${label}).`], label);
    assert.equal(h.source.snapshot().sessionId, SID, label);
    h.source.close();
  }
});

await check('N7 ambiguity: two live processes on the bound session stop the source; one live and one dead do not', () => {
  const f = fixture();
  f.registry(PID, { pid: PID, sessionId: SID, updatedAt: clock, status: 'idle' });
  f.registry(5151, { pid: 5151, sessionId: SID, updatedAt: clock, status: 'busy' });
  f.registry(6161, { pid: 6161, sessionId: OTHER_SID, updatedAt: clock, status: 'busy' });
  const deadOther = start(f, { isAlive: pid => pid === PID || pid === 6161 });
  f.append(say('Shown: the other holder is dead.'));
  deadOther.source.poll();
  assert.equal(deadOther.source.snapshot().status, 'connected');
  assert.deepEqual(deadOther.texts(), ['Shown: the other holder is dead.']);
  deadOther.source.close();
  const both = start(f, { isAlive: () => true });
  f.append(say('Never shown: two live holders.'));
  both.source.poll();
  assert.equal(both.source.snapshot().status, 'unavailable');
  assert.equal(both.source.snapshot().reason, 'binding_ambiguous');
  assert.deepEqual(both.texts(), []);
  both.source.close();
});

await check('N8 registry files: only ^\\d+\\.json$ names are opened; a planted .key file is never opened or read', () => {
  const f = fixture();
  const sessions = path.join(f.home, '.claude', 'sessions');
  f.registry(PID, { pid: PID, sessionId: SID, updatedAt: clock, status: 'idle' });
  f.registry(5151, { pid: 5151, sessionId: OTHER_SID, updatedAt: clock, status: 'busy' });
  fs.writeFileSync(path.join(sessions, `${PID}.${'ab'.repeat(32)}.key`), 'PLANTED-CREDENTIAL');
  fs.writeFileSync(path.join(sessions, `${PID} 2.json`), JSON.stringify({ pid: PID, sessionId: SID }));
  const opened = [];
  const spied = {};
  for (const name of ['openSync', 'readFileSync', 'createReadStream', 'statSync', 'lstatSync']) {
    spied[name] = fs[name];
    fs[name] = function (target, ...rest) { if (String(target).startsWith(sessions + '/')) opened.push(`${name}:${path.basename(String(target))}`); return spied[name].call(this, target, ...rest); };
  }
  syncBuiltinESMExports();
  try {
    const h = start(f, { isAlive: () => true });
    f.append(say('Still connected.'));
    h.source.poll();
    assert.equal(h.source.snapshot().status, 'connected');
    h.source.close();
  } finally {
    for (const [name, original] of Object.entries(spied)) fs[name] = original;
    syncBuiltinESMExports();
  }
  assert.ok(opened.includes(`openSync:${PID}.json`), `opened: ${opened.join(', ')}`);
  assert.ok(opened.every(entry => /:\d+\.json$/.test(entry)), `opened: ${opened.join(', ')}`);
  assert.ok(!opened.some(entry => entry.endsWith('.key')));
});

/* ------------------------------------------------------------------ integrity and bounds (kept from SIDEBAR-CC) */

await check('integrity: truncation stops the source and never seeks back to zero', () => {
  const f = fixture();
  f.append(say('Old history.'));
  const h = start(f);
  f.append(say('Shown prose.'));
  h.source.poll();
  assert.deepEqual(h.texts(), ['Shown prose.']);
  fs.writeFileSync(f.file, '');
  f.append(say('Rewritten after truncation.'));
  h.source.poll();
  assert.equal(h.source.snapshot().status, 'unavailable');
  assert.equal(h.source.snapshot().reason, 'transcript_truncated');
  assert.deepEqual(h.texts(), []);
  h.source.close();
});

await check('integrity: a same-length-or-longer rewrite under the read position is a truncation', () => {
  const f = fixture();
  const h = start(f);
  f.append(say('Shown prose.'));
  h.source.poll();
  const size = fs.readFileSync(f.file).length;
  fs.writeFileSync(f.file, JSON.stringify(say('X'.repeat(size + 200))) + '\n');
  f.append(say('Appended after the rewrite.'));
  h.source.poll();
  assert.equal(h.source.snapshot().reason, 'transcript_truncated');
  assert.deepEqual(h.texts(), []);
  h.source.close();
});

await check('integrity: a replaced file (new inode at the path) stops the source', () => {
  const f = fixture();
  const h = start(f);
  f.append(say('Shown prose.'));
  h.source.poll();
  const old = fs.openSync(f.file, 'a');
  const replacement = `${f.file}.new`;
  fs.writeFileSync(replacement, '');
  fs.renameSync(replacement, f.file);
  fs.writeSync(old, JSON.stringify(say('Written to the unlinked old inode.')) + '\n');
  fs.closeSync(old);
  h.source.poll();
  assert.equal(h.source.snapshot().reason, 'transcript_replaced');
  assert.deepEqual(h.texts(), []);
  h.source.close();
});

await check('resolution: a symlinked transcript is refused', () => {
  const f = fixture();
  const real = path.join(f.home, 'real.jsonl');
  fs.writeFileSync(real, '');
  fs.rmSync(f.file);
  fs.symlinkSync(real, f.file);
  assert.deepEqual(resolveClaudeTranscript({ sid: SID, home: f.home }), { ok: false, reason: 'transcript_not_regular' });
  assert.equal(start(f).source.snapshot().reason, 'transcript_not_regular');
});

await check('resolution: a file owned by another user is refused', () => {
  const f = fixture();
  assert.deepEqual(resolveClaudeTranscript({ sid: SID, home: f.home, uid: process.getuid() + 1 }), { ok: false, reason: 'transcript_owner' });
  assert.equal(resolveClaudeTranscript({ sid: SID, home: f.home }).ok, true);
});

await check('resolution: two files for one session id are refused; a bad id is unavailable', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.home, '.claude', 'projects', 'second'));
  fs.writeFileSync(path.join(f.home, '.claude', 'projects', 'second', `${SID}.jsonl`), '');
  assert.deepEqual(resolveClaudeTranscript({ sid: SID, home: f.home }), { ok: false, reason: 'transcript_ambiguous' });
  assert.equal(start(f).source.snapshot().reason, 'transcript_ambiguous');
  for (const sid of ['../x', '', undefined]) {
    const g = fixture();
    const s = connectClaudeSource({ env: { CLAUDE_CODE_SESSION_ID: sid }, home: g.home, clientPid: PID, now, ...timers });
    assert.deepEqual(s.snapshot(), { status: 'unavailable', reason: 'transcript_unavailable', canSend: false, sessionId: sid ?? null, threadStatus: null, entries: [] });
  }
});

await check('bounds: an oversized record is skipped unparsed and reading resumes at the next line', () => {
  const f = fixture();
  const h = start(f);
  f.append(say('Oversized record prose.', { padding: 'x'.repeat(CLAUDE_FEED_LIMITS.lineBytes) }), say('After the oversized record.'));
  h.source.poll();
  assert.deepEqual(h.texts(), ['After the oversized record.']);
  h.source.close();
});

await check('bounds: an oversized text (assistant or user) is not shown, even in part', () => {
  const f = fixture();
  const h = start(f);
  f.append(say('Long block. ' + 'y'.repeat(CLAUDE_FEED_LIMITS.textChars)), ask('Long prompt. ' + 'z'.repeat(CLAUDE_FEED_LIMITS.textChars)), say('Short block.'));
  h.source.poll();
  assert.deepEqual(h.texts(), ['Short block.']);
  h.source.close();
});

await check('bounds: at most 80 entries are kept, oldest first out', () => {
  const f = fixture();
  const h = start(f);
  f.append(...Array.from({ length: 85 }, (_, i) => i % 2 ? say(`Entry ${i}.`) : ask(`Entry ${i}.`)));
  h.source.poll();
  assert.equal(h.texts().length, CLAUDE_FEED_LIMITS.entries);
  assert.equal(h.texts()[0], 'Entry 5.');
  assert.equal(h.texts().at(-1), 'Entry 84.');
  h.source.close();
});

await check('bounds: UTF-8 split across writes and reads is decoded whole', () => {
  const f = fixture();
  const h = start(f, { limits: { chunkBytes: 7 } });
  const record = Buffer.from(JSON.stringify(say('中文进度：已打开页面。')) + '\n');
  const cut = record.indexOf(Buffer.from('文')) + 1;   // inside a three-byte character
  fs.appendFileSync(f.file, record.subarray(0, cut));
  h.source.poll();
  assert.deepEqual(h.texts(), []);
  fs.appendFileSync(f.file, record.subarray(cut));
  h.source.poll();
  assert.deepEqual(h.texts(), ['中文进度：已打开页面。']);
  h.source.close();
});

await check('bounds: dedupe memory and subscribers are capped', () => {
  const f = fixture();
  const h = start(f, { limits: { seenUuids: 5, subscribers: 2 } });
  f.append(...Array.from({ length: 12 }, (_, i) => say(`Line ${i}.`)));
  h.source.poll();
  assert.ok(h.source.stats().seen <= 5, JSON.stringify(h.source.stats()));
  const calls = [];
  const a = h.source.subscribe(() => calls.push('a'));
  h.source.subscribe(() => calls.push('b'));
  h.source.subscribe(() => calls.push('c'));
  assert.equal(h.source.stats().listeners, 2);
  f.append(say('Notify.'));
  h.source.poll();
  assert.deepEqual(calls.sort(), ['a', 'b']);
  a();
  assert.equal(h.source.stats().listeners, 1);
  h.source.close();
});

await check('compaction: compact_boundary resets the shown entries', () => {
  const f = fixture();
  const h = start(f);
  f.append(say('Before compaction.'));
  h.source.poll();
  f.append(base({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false }), say('After compaction.'));
  h.source.poll();
  assert.deepEqual(h.texts(), ['After compaction.']);
  h.source.close();
});

/* ------------------------------------------------------------------ lifecycle (N13 and kept) */

await check('N13 hot swap: a new worker source starts empty and reads only from the current EOF', () => {
  const f = fixture();
  const a = start(f);
  f.append(say('Seen by the old worker.'));
  a.source.poll();
  assert.deepEqual(a.texts(), ['Seen by the old worker.']);
  a.source.close();
  const b = start(f);
  b.source.poll();
  assert.deepEqual(b.texts(), []);
  f.append(say('Seen by the new worker.'));
  b.source.poll();
  assert.deepEqual(b.texts(), ['Seen by the new worker.']);
  b.source.close();
});

await check('lifecycle: close stops the timer, drops listeners, and later polls read nothing', () => {
  const f = fixture();
  let cleared = 0;
  const h = start(f, { clearInterval: () => { cleared++; } });
  f.append(say('Shown.'));
  h.source.poll();
  h.source.close();
  assert.equal(cleared, 1);
  assert.equal(h.source.stats().listeners, 0);
  f.append(say('After close.'));
  h.source.poll();
  assert.deepEqual(h.texts(), ['Shown.']);
});

await check('read-only: the module imports no write, spawn or network API and reads only CLAUDE_CODE_SESSION_ID', () => {
  const source = fs.readFileSync(new URL('../src/visible-feed-claude.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import\s+([^;]+?)\s+from\s+'([^']+)';$/gm)].map(m => [m[2], m[1]]);
  assert.deepEqual(imports.map(([from]) => from).sort(), ['./visible-feed.js', 'node:fs', 'node:path']);
  const fsNames = imports.find(([from]) => from === 'node:fs')[1].replace(/[{}\s]/g, '').split(',').sort();
  assert.deepEqual(fsNames, ['closeSync', 'constants', 'fstatSync', 'lstatSync', 'openSync', 'readSync', 'readdirSync']);
  const forbidden = source.match(/\bimport\s*\(|require\(|process\.env[.[]|console\.|process\.(stdout|stderr)|\b(write|append|spawn|exec|fork|createConnection|fetch)\w*\(|\bnet\b|\bhttp/g);
  assert.equal(forbidden, null, `forbidden API in the module: ${forbidden}`);
  assert.equal(source.match(/process\.kill\(/g)?.length, 1, 'only the signal-0 liveness probe');
  assert.match(source, /process\.kill\(pid, 0\)/);
  const f = fixture();
  const read = [];
  const env = new Proxy({ CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_MESSAGING_TOKEN: 'never-read' }, { get(target, key) { read.push(key); return target[key]; } });
  connectClaudeSource({ env, home: f.home, clientPid: PID, now, ...timers }).close();
  assert.deepEqual([...new Set(read)], ['CLAUDE_CODE_SESSION_ID']);
});

await check('latency: a record is shown within one production poll interval (real timers)', async () => {
  const f = fixture();
  let shownAt = null, source = null;
  source = connectClaudeSource({ env: f.env, home: f.home, clientPid: PID, isAlive: () => false,
    onChange: () => { if (!shownAt && source?.snapshot().entries.length) shownAt = Date.now(); } });
  const writtenAt = Date.now();
  f.append({ ...say('Timed prose.'), timestamp: new Date().toISOString() });
  while (!shownAt && Date.now() - writtenAt < CLAUDE_FEED_TIMING.pollMs * 3) await new Promise(r => setTimeout(r, 20));
  source.close();
  assert.ok(shownAt, 'never shown');
  const ms = shownAt - writtenAt;
  console.log(`  latency: shown ${ms} ms after the write (poll ${CLAUDE_FEED_TIMING.pollMs} ms)`);
  assert.ok(ms <= CLAUDE_FEED_TIMING.pollMs + 250, `${ms} ms`);
});

fs.rmSync(root, { recursive: true, force: true });
if (failures.length) { console.error(`visible-feed-claude: ${failures.length} failed: ${failures.join('; ')}`); process.exit(1); }
console.log(`visible-feed-claude: ${passed} passed`);
