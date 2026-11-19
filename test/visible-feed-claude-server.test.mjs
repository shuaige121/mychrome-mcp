#!/usr/bin/env node
/* CC-LIVE (problems-20261101/contracts-batch4.md): a Claude Code connection through the production MCP path —
 * src/index.js served over the SDK's InMemoryTransport, the client identified by name. The source starts when the
 * client is identified (no tool call), the sidebar subscribes to it (assistant prose only), done:true ends only the
 * sidebar subscription. The transcript and the session registry are synthetic, under a temporary HOME; CLAUDE_CODE_*,
 * KITTY_*, CLAUDECODE and CHROME_BRIDGE_CLAUDE_FEED are scrubbed before src/ loads, so this process can never bind the
 * session that runs the tests. Spies (fs, stdout/stderr, the transport) prove where ~/.claude is touched and where
 * prose goes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

for (const key of Object.keys(process.env)) {
  if (/^(CLAUDE_CODE_|KITTY_)/.test(key) || ['CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CHROME_BRIDGE_CLAUDE_FEED'].includes(key)) delete process.env[key];
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-claude-server-'));
const home = path.join(tmp, 'home');
const claudeRoot = path.join(home, '.claude');
const project = path.join(claudeRoot, 'projects', '-synthetic-project');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(tmp, 'lock'));
process.env.HOME = home;
Object.assign(process.env, {
  CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'), CHROME_BRIDGE_LOCK: path.join(tmp, 'lock', 'input.lock'),
  CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'agent-window.json'), CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_HABITS: 'off',
  CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_SWEEP: '0', CHROME_BRIDGE_WARM: '0', CHROME_BRIDGE_AGENT_NAME: 'cc-live-test', CHROME_BRIDGE_CLIENT_PID: '424242',
});
fs.writeFileSync(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));
await import('./isolate-settings.mjs');

const SID = '11111111-2222-4333-8444-555555555555';
const SENTINEL = 'CCLIVE-SENTINEL-7f3a';
const transcript = path.join(project, `${SID}.jsonl`);
const sessions = path.join(claudeRoot, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const original = { appendFileSync: fs.appendFileSync, writeFileSync: fs.writeFileSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
let fixtureWriting = false;   // the test's own fixture writes (Node's appendFileSync goes through writeFileSync)
const quietly = fn => (...a) => { fixtureWriting = true; try { return fn(...a); } finally { fixtureWriting = false; } };
const real = { appendFileSync: quietly(original.appendFileSync), writeFileSync: quietly(original.writeFileSync),
  readFileSync: original.readFileSync, readdirSync: original.readdirSync };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const line = record => JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', sessionId: SID,
  uuid: uuid(), timestamp: new Date().toISOString(), ...record }) + '\n';
const say = text => line({ type: 'assistant', apiBlockIndex: 0, message: { id: `msg_${++seq}`, role: 'assistant', content: [{ type: 'text', text }] } });
const ask = text => line({ type: 'user', message: { role: 'user', content: text } });
real.writeFileSync(transcript, say('History before connect: never shown.'));
real.writeFileSync(path.join(sessions, '424242.json'), JSON.stringify({ pid: 424242, sessionId: SID, updatedAt: Date.now() + 1000, status: 'idle' }));
real.writeFileSync(path.join(sessions, `424242.${'cd'.repeat(32)}.key`), 'PLANTED-CREDENTIAL');

// Spies: every path-based touch under the fake ~/.claude, and every write carrying the sentinel anywhere.
const touches = [], leaks = [];
const pathArg = value => typeof value === 'string' ? value : value instanceof URL ? value.pathname : Buffer.isBuffer(value) ? value.toString() : '';
const carries = data => data != null && (Buffer.isBuffer(data) || ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(SENTINEL) : String(data).includes(SENTINEL));
for (const name of ['openSync', 'readdirSync', 'lstatSync', 'statSync', 'realpathSync', 'readFileSync', 'existsSync', 'accessSync', 'opendirSync', 'createReadStream']) {
  const original = fs[name];
  fs[name] = function (target, ...rest) { if (`${pathArg(target)}/`.startsWith(`${claudeRoot}/`)) touches.push(name); return original.call(this, target, ...rest); };
}
for (const name of ['writeFileSync', 'appendFileSync', 'writeSync']) {
  const original = fs[name];
  fs[name] = function (target, data, ...rest) { if (!fixtureWriting && carries(data)) leaks.push(`fs.${name} ${typeof target === 'number' ? 'fd' : pathArg(target).replace(tmp, '<tmp>')}`); return original.call(this, target, data, ...rest); };
}
for (const name of ['writeFile', 'appendFile']) {
  const original = fs.promises[name];
  fs.promises[name] = function (target, data, ...rest) { if (carries(data)) leaks.push(`fs.promises.${name}`); return original.call(this, target, data, ...rest); };
}
syncBuiltinESMExports();
for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => { if (carries(chunk)) leaks.push('stdio'); return original(chunk, ...rest); };
}

const idx = await import('../src/index.js');
idx.__setBridgeForTests({ keepAwake: () => () => {} });
idx.__recordForTests(true);   // presence and activity log are written, so they are checked
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let passed = 0;
const failures = [];
async function check(name, run) {
  try { await run(); passed++; console.log(`ok - ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL - ${name}\n${error.stack}`); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const feed = () => idx.__taskFeedForTests();
const source = () => idx.__claudeSourceForTests();
async function eventually(predicate, label, ms = 3500) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (predicate()) return; await sleep(25); }
  assert.fail(`${label}: ${JSON.stringify({ feed: feed(), source: source() })}`);
}
const wire = [], requests = [];
async function connect(name) {
  idx.__resetPanelTaskForTests();
  idx.__resetClaudeSourceForTests();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const send = serverSide.send.bind(serverSide);
  serverSide.send = async message => { wire.push(JSON.stringify(message)); return send(message); };
  const receive = serverSide.onmessage;
  await idx.__connectForTests(serverSide);
  const handler = serverSide.onmessage;
  serverSide.onmessage = (message, extra) => { if (message?.method) requests.push(message.method); return handler(message, extra); };
  const client = new Client({ name, version: 'cc-live-test' }, { capabilities: {} });
  await client.connect(clientSide);
  void receive;
  return client;
}
const results = [];
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  results.push(JSON.stringify(result));
  return result.content?.map(c => c.text).join('\n') ?? '';
}
const environment = ({ claudecode = true, setting = null, file = null } = {}) => {
  if (claudecode) process.env.CLAUDECODE = '1'; else delete process.env.CLAUDECODE;
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  if (setting === null) delete process.env.CHROME_BRIDGE_CLAUDE_FEED; else process.env.CHROME_BRIDGE_CLAUDE_FEED = setting;
  real.writeFileSync(process.env.CHROME_BRIDGE_SETTINGS, file === null ? '{}' : JSON.stringify({ claudeFeed: file }));
};
/** Identify the client, run a whole task, and require zero path-based fs calls under the fake ~/.claude. */
async function untouched(clientName, env, expected) {
  environment(env);
  touches.length = 0;
  const client = await connect(clientName);
  try {
    await sleep(50);
    real.appendFileSync(transcript, say(`${SENTINEL} must not be read (${expected})`));
    const reply = await call(client, 'task_plan', { task: `Gate ${expected}`, steps: ['one'] });
    assert.match(reply, /已就绪/);
    await sleep(1200);
    assert.equal(feed().feedReason, expected);
    assert.equal(feed().feedEntries.length, 0);
    assert.notEqual(source().status, 'connected');
    await call(client, 'task_plan', { done: true });
    assert.deepEqual(touches, [], `~/.claude touched: ${touches.join(', ')}`);
    return reply;
  } finally { await client.close(); }
}

await check('N10 switch: settings file claudeFeed:false -> feed_off and zero fs calls under ~/.claude', async () => {
  const reply = await untouched('claude-code', { file: false }, 'feed_off');
  assert.match(reply, /对话镜像已在设置中关闭/);
});
await check('N10 switch: CHROME_BRIDGE_CLAUDE_FEED=0 wins over a settings file true', () =>
  untouched('claude-code', { setting: '0', file: true }, 'feed_off'));
await check('N11 a client that is not Claude: browser_only, zero fs calls, even with the switch on', async () => {
  await untouched('cursor', { setting: '1' }, 'browser_only');
  await untouched('Codex', { setting: '1' }, 'unbound_thread');
});
await check('N11 a Claude client without CLAUDECODE: transcript_unavailable, zero fs calls', () =>
  untouched('claude-code', { claudecode: false, setting: '1' }, 'transcript_unavailable'));

await check('N10 switch: CHROME_BRIDGE_CLAUDE_FEED=1 wins over a settings file false', async () => {
  environment({ setting: '1', file: false });
  const probe = await connect('claude-code');
  try { await eventually(() => source().status === 'connected', 'env 1 did not win'); }
  finally { await probe.close(); idx.__resetClaudeSourceForTests(); }
});

let client = null;
await check('N1 binding without a call (default on): the source is connected right after identification, zero tools/call served', async () => {
  environment({});   // no switch anywhere: the default is on
  touches.length = 0; requests.length = 0;
  client = await connect('claude-code');
  await eventually(() => source().status === 'connected', 'source not connected');
  assert.equal(requests.filter(m => m === 'tools/call').length, 0);
  assert.ok(['readdirSync', 'lstatSync', 'openSync'].every(name => touches.includes(name)), `positive control, spy saw: ${touches.join(', ')}`);
  assert.equal(source().threadStatus, 'idle', 'status copied from the registry');
  real.appendFileSync(transcript, ask(`Please check the page ${SENTINEL}-prompt.`) + say(`Visible progress ${SENTINEL}.`));
  await eventually(() => source().entries?.length === 2, 'records not mirrored');
  assert.deepEqual(source().entries.map(e => e.role), ['user', 'assistant']);
  assert.equal(requests.filter(m => m === 'tools/call').length, 0);
});

await check('N2 sidebar: task_plan subscribes to the same source and shows assistant prose only', async () => {
  const reply = await call(client, 'task_plan', { task: 'Live task', steps: ['read'] });
  assert.match(reply, /侧栏已连接本会话（只读镜像）/);
  assert.equal(feed().feedSource, 'claude');
  assert.equal(feed().feedStatus, 'connected');
  assert.deepEqual(feed().feedEntries, [`Visible progress ${SENTINEL}.`]);
  real.appendFileSync(transcript, ask('Another prompt.') + say('Another reply.'));
  await eventually(() => feed().feedEntries.includes('Another reply.'), 'sidebar did not follow');
  assert.ok(!feed().feedEntries.some(text => /prompt/i.test(text)), 'a user prompt reached the sidebar');
});

await check('G10 lifetime: done:true ends only the sidebar subscription; the source keeps following the session', async () => {
  await call(client, 'task_plan', { done: true });
  assert.equal(feed().feedSource, null);
  assert.deepEqual(feed().feedEntries, []);
  real.appendFileSync(transcript, say('After the task.'));
  await eventually(() => source().entries?.some(e => e.text === 'After the task.'), 'source stopped with the task');
  assert.equal(source().status, 'connected');
});

await check('N12 surfaces: the sentinel is in no tool result, transport message, file, write or stdio', async () => {
  const reply = await call(client, 'task_plan', { task: 'Live task again', steps: ['read'] });
  assert.doesNotMatch(reply, new RegExp(SENTINEL));
  for (const text of [...results, ...wire]) assert.doesNotMatch(text, new RegExp(SENTINEL));
  assert.deepEqual(leaks, []);
  const files = [];
  const walk = dir => { for (const e of real.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
  walk(tmp); walk(path.dirname(process.env.CHROME_BRIDGE_SETTINGS));
  const carrying = files.filter(f => f !== transcript && real.readFileSync(f).includes(SENTINEL));
  assert.deepEqual(carrying, []);
  assert.ok(files.length > 3, `files checked: ${files.length}`);
  await call(client, 'task_plan', { done: true });
  await client.close();
  idx.__resetClaudeSourceForTests();
});

// B3: a test process that inherits this session's identity AND the exported switch, under the shared helper.
const CHILD = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const E = process.env, touches = [];
let fixture = false;
for (const name of ['openSync', 'readdirSync', 'lstatSync', 'statSync', 'realpathSync', 'readFileSync', 'existsSync', 'accessSync', 'opendirSync']) {
  const original = fs[name];
  fs[name] = function (target, ...rest) { if (!fixture && (String(target) + '/').startsWith(E.B3_ROOT + '/')) touches.push(name); return original.call(this, target, ...rest); };
}
syncBuiltinESMExports();
const inherited = Object.keys(process.env).filter(k => /^(CLAUDE|KITTY)|^CHROME_BRIDGE_CLAUDE_FEED$/.test(k)).length;
if (E.B3_USE_ISOLATE === '1') await import(E.B3_ISOLATE);
const left = Object.keys(process.env).filter(k => /^(CLAUDE_CODE_|KITTY_)|^CLAUDECODE$|^CHROME_BRIDGE_CLAUDE_FEED$/.test(k));
const { B3_TRANSCRIPT: transcript, B3_RECORD: record } = E;
const idx = await import(E.B3_INDEX);
idx.__setBridgeForTests({ keepAwake: () => () => {} });
const { Client } = await import(E.B3_CLIENT);
const { InMemoryTransport } = await import(E.B3_MEMORY);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await idx.__connectForTests(serverSide);
const client = new Client({ name: 'claude-code', version: 'b3' }, { capabilities: {} });
await client.connect(clientSide);
await client.callTool({ name: 'task_plan', arguments: { task: 'Isolated task' } });
fixture = true; fs.appendFileSync(transcript, record); fixture = false;
await new Promise(resolve => setTimeout(resolve, 1300));
const snap = idx.__claudeSourceForTests();
process.stdout.write('\\nB3 ' + JSON.stringify({ inherited, left, touches, status: snap.status ?? null, entries: snap.entries?.length ?? 0 }) + '\\n');
process.exit(0);
`;
await check('isolation: under test/isolate-settings.mjs an in-process server never opens a transcript, even with the switch exported', async () => {
  const { spawnSync } = await import('node:child_process');
  const home2 = path.join(tmp, 'home-b3'), root2 = path.join(home2, '.claude', 'projects');
  const project2 = path.join(root2, '-b3-project');
  fs.mkdirSync(project2, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'lock-b3'), { recursive: true });
  const transcript2 = path.join(project2, `${SID}.jsonl`);
  real.writeFileSync(transcript2, say('History of the b3 session.'));
  const script = path.join(tmp, 'b3-child.mjs');
  real.writeFileSync(script, CHILD);
  const run = useIsolate => {
    const env = { PATH: process.env.PATH, HOME: home2, TMPDIR: os.tmpdir(),
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_ENTRYPOINT: 'cli', CHROME_BRIDGE_CLAUDE_FEED: '1',
      KITTY_WINDOW_ID: '42', KITTY_LISTEN_ON: 'unix:/nonexistent-b3',
      CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs-b3'), CHROME_BRIDGE_LOCK: path.join(tmp, 'lock-b3', 'input.lock'),
      CHROME_BRIDGE_AGENT_STATE: process.env.CHROME_BRIDGE_AGENT_STATE, CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_HABITS: 'off',
      CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_SWEEP: '0', CHROME_BRIDGE_WARM: '0',
      B3_USE_ISOLATE: useIsolate ? '1' : '0', B3_ROOT: root2, B3_TRANSCRIPT: transcript2,
      B3_RECORD: say('Isolation prose.'),
      B3_ISOLATE: new URL('./isolate-settings.mjs', import.meta.url).href, B3_INDEX: new URL('../src/index.js', import.meta.url).href,
      B3_CLIENT: import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'),
      B3_MEMORY: import.meta.resolve('@modelcontextprotocol/sdk/inMemory.js') };
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, `child exit ${r.status} ${r.signal ?? ''}: ${(r.stderr || '').slice(-1500)}`);
    const reportLine = r.stdout.split('\n').find(l => l.startsWith('B3 '));
    assert.ok(reportLine, `no report line: ${r.stdout.slice(-500)}`);
    return JSON.parse(reportLine.slice(3));
  };
  const control = run(false);
  assert.equal(control.status, 'connected', 'positive control: without the helper the default-on feed opens the fake transcript');
  assert.ok(control.touches.includes('openSync'), `control touches: ${control.touches.join(', ')}`);
  const isolated = run(true);
  assert.equal(isolated.inherited, 6);
  assert.deepEqual(isolated.left, []);
  assert.deepEqual(isolated.touches, [], `transcript touched under the helper: ${isolated.touches.join(', ')}`);
  assert.notEqual(isolated.status, 'connected');
  assert.equal(isolated.entries, 0);
});

for (const key of Object.keys(process.env)) if (/^(CLAUDE_CODE_|CLAUDECODE|CHROME_BRIDGE_CLAUDE_FEED)/.test(key)) delete process.env[key];
fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) { console.error(`visible-feed-claude-server: ${failures.length} failed: ${failures.join('; ')}`); process.exit(1); }
console.log(`visible-feed-claude-server: ${passed} passed`);
process.exit(0);
