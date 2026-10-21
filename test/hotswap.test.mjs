#!/usr/bin/env node
/* Hot swap (src/launcher.js): the process a client starts stays for the whole session; the worker behind
 * it is replaced when src/*.js change. Run on a copy of the repo with a fake chromectl and cgevent in its
 * bin/ and a temporary HOME: nothing here reaches Chrome, the screen, the keyboard or the mouse.
 *
 * The client keeps its connection and hears tools/list_changed; the session's tabs stay over a swap and
 * close when the session ends; a call under way, a job in progress or new code that does not load: no
 * swap; a worker that dies is started again and its call answered with an error to retry. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hotswap-')));   // module paths are real paths
const copy = path.join(tmp, 'pkg'), fake = path.join(tmp, 'fake'), cache = path.join(tmp, 'cache'), home = path.join(tmp, 'home');
for (const d of [copy, fake, cache, home, path.join(copy, 'bin')]) fs.mkdirSync(d, { recursive: true });
fs.cpSync(path.join(ROOT, 'src'), path.join(copy, 'src'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(copy, 'package.json'));
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'));

// The fake helpers: every call logged; `list` shows the tabs in fake/tabs.json (after `listDelayMs`), `close` removes one.
fs.writeFileSync(path.join(fake, 'chromectl.cjs'), `
const fs = require('fs'), path = require('path');
const dir = ${JSON.stringify(fake)}, args = process.argv.slice(2), file = path.join(dir, 'tabs.json');
fs.appendFileSync(path.join(dir, 'chromectl.log'), JSON.stringify(args) + '\\n');
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = (o) => process.stdout.write(JSON.stringify(o));
if (args[0] === 'list') setTimeout(() => out({ ok: true, frontmost: 'Finder', chromePid: 42,
  windows: [{ id: 7, index: 1, minimized: false, mode: 'normal', tabs: st.tabs.map((t, i) => ({ ...t, active: i === 0 })) }] }), st.listDelayMs || 0);
else if (args[0] === 'close') { st.tabs = st.tabs.filter(t => String(t.id) !== args[1]); fs.writeFileSync(file, JSON.stringify(st)); out({ ok: true }); }
else out({ ok: true });
`);
fs.writeFileSync(path.join(fake, 'cgevent.cjs'), `
require('fs').appendFileSync(${JSON.stringify(path.join(fake, 'cgevent.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ ok: true }));
`);
for (const n of ['chromectl', 'cgevent']) {
  fs.writeFileSync(path.join(copy, 'bin', n), `#!/bin/sh\nexec "${process.execPath}" "${path.join(fake, n + '.cjs')}" "$@"\n`, { mode: 0o755 });
}
const setTabs = (o) => fs.writeFileSync(path.join(fake, 'tabs.json'), JSON.stringify(o));
setTabs({ tabs: [{ id: 10, url: 'https://a.test/', title: 'A' }, { id: 11, url: 'https://b.test/', title: 'B' }] });

const LOCK = path.join(cache, 'lock', 'input.lock'), TABS = path.join(cache, 'tabs');
const ENV = {
  PATH: process.env.PATH, HOME: home,
  CHROME_BRIDGE_SETTINGS: process.env.CHROME_BRIDGE_SETTINGS, CHROME_BRIDGE_ACTIVITY: process.env.CHROME_BRIDGE_ACTIVITY,
  CHROME_BRIDGE_LOCK: LOCK, CHROME_BRIDGE_TAB_DIR: TABS, CHROME_BRIDGE_AGENT_STATE: path.join(cache, 'agent-window.json'),
  CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_WARM: '0', CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_NOTIFY: '0',
  CHROME_BRIDGE_AGENT_NAME: 'swap-test', CHROME_BRIDGE_SWAP_POLL_MS: '200', CHROME_BRIDGE_SWAP_QUIET_MS: '300',
  CHROME_BRIDGE_PLAN_GAP_MS: '2500'
};

let passed = 0;
const ok = (what) => { passed++; console.log(`  ok  ${what}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(f, ms, what) {
  const t = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const ppidOf = (pid) => Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
/** The live servers' presence files (a killed worker leaves its file behind: the panel drops dead ones too). */
function servers() {
  const dir = path.join(cache, 'lock', 'servers');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n)); } catch {}
  return names.map(n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } })
    .filter(j => j && alive(j.pid));
}
const closes = () => { try { return fs.readFileSync(path.join(fake, 'chromectl.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(a => a[0] === 'close').map(a => Number(a[1])); } catch { return []; } };
let edits = 0;
/** An update: src/peers.js changes (valid code unless `broken`). */
function update(broken = false) {
  fs.appendFileSync(path.join(copy, 'src', 'peers.js'), broken ? '\nexport const = ;\n' : `\n// update ${++edits}\n`);
}
const unbreak = () => {
  const f = path.join(copy, 'src', 'peers.js');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('\nexport const = ;\n', `\n// fixed ${++edits}\n`));
};
function record(tabId, ownerPid, url) {
  fs.mkdirSync(TABS, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(TABS, `${tabId}.json`), JSON.stringify({ tabId, ownerPid, windowId: 7, expectedUrl: url, openedAt: now,
    lastUsed: now, agentDoneAt: now, takenOver: false, closeBlocked: false, agentName: 'swap-test' }));
}
async function connect(env = ENV) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(copy, 'src', 'index.js')], env, stderr: 'pipe' });
  let err = '';
  transport.stderr.on('data', d => { err += d; });
  const client = new Client({ name: 'hotswap-test', version: '0' });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
  await client.connect(transport);
  return { client, changed: () => changed, stderr: () => err };
}
const text = (r) => r.content.map(c => c.text).join('\n');

console.log('hot swap (src/launcher.js; a copy of the repo, fake chromectl and cgevent)');
try {
  const s = await connect();
  const w1 = await until(() => servers().find(j => j.launcher), 10_000, 'the worker');
  const L = w1.launcher;
  assert.equal(ppidOf(w1.pid), L, 'the worker is not the launcher\'s child');
  assert.ok(execFileSync('/bin/ps', ['-o', 'command=', '-p', String(L)], { encoding: 'utf8' }).includes(path.join(copy, 'src', 'index.js')));
  assert.equal(servers().length, 1, 'the launcher reports as a server of its own');
  assert.equal((await s.client.listTools()).tools.length, 17);
  // The session's tab (registered to the launcher) and one whose owner is gone (closed by the next sweep).
  const gone = spawnSync('/usr/bin/true').pid;
  record(10, L, 'https://a.test/');
  record(11, gone, 'https://b.test/');
  const before = text(await s.client.callTool({ name: 'list_tabs', arguments: {} }));
  const mine = /你（这个会话）的标签（1 个）：\n  tab=10 [\s\S]*tab=10 +A +［你的/;
  assert.match(before, mine, before);
  ok('the client starts a launcher; MyChrome runs as its child and reports the launcher; tools as before');

  update();
  const w2 = await until(() => servers().find(j => j.pid !== w1.pid && j.launcher === L), 15_000, 'the new worker');
  await until(() => !alive(w1.pid), 5000, 'the old worker gone');
  await until(() => s.changed() >= 1, 5000, 'tools/list_changed');
  assert.equal((await s.client.listTools()).tools.length, 17);
  const after = text(await s.client.callTool({ name: 'list_tabs', arguments: {} }));
  await until(() => closes().includes(11), 5000, 'the dead owner\'s tab closed by the new worker\'s sweep');
  assert.ok(!closes().includes(10), 'the session\'s tab was closed by the swap');
  assert.ok(fs.existsSync(path.join(TABS, '10.json')), 'the session\'s tab record went');
  assert.match(after, mine, `the tab is not this session's after the swap:\n${after}`);
  assert.match(s.stderr(), new RegExp(`updated: \\w+ → \\w+, worker ${w1.pid} → ${w2.pid}`));
  assert.match(s.stderr(), new RegExp(`pid ${w2.pid}, carried 1 tab\\(s\\) over`), 'the ledger was not handed over');
  ok('src/ changes: the worker is replaced at a quiet moment; same connection, tools/list_changed; the session\'s tab stays its own, its ledger handed over (sweeps still close a dead owner\'s)');

  // A call under way: no swap until it is answered.
  setTabs({ tabs: [{ id: 10, url: 'https://a.test/', title: 'A' }], listDelayMs: 2500 });
  const slow = s.client.callTool({ name: 'list_tabs', arguments: {} });
  await sleep(300);
  update();
  await sleep(1500);
  assert.equal(servers().find(j => j.launcher === L).pid, w2.pid, 'swapped while a call was under way');
  const slowText = text(await slow);
  assert.doesNotMatch(slowText, /意外退出/);
  setTabs({ tabs: [{ id: 10, url: 'https://a.test/', title: 'A' }] });
  const w3 = await until(() => servers().find(j => j.pid !== w2.pid && j.launcher === L), 15_000, 'the swap after the call');
  ok('a call under way: answered by the worker that had it; the swap comes after');

  // A whole job keeps its worker even across a long reasoning gap; only done permits a swap.
  await s.client.callTool({ name: 'task_plan', arguments: { task: 'swap test', steps: ['one', 'two'], estimate_minutes: 1 } });
  update();
  await sleep(3200);
  assert.equal(servers().find(j => j.launcher === L).pid, w3.pid, 'swapped in the middle of a job');
  await s.client.callTool({ name: 'task_plan', arguments: { done: true } });
  const w4 = await until(() => servers().find(j => j.pid !== w3.pid && j.launcher === L), 15_000, 'the swap once the job finished');
  assert.ok(!fs.existsSync(path.join(cache, 'lock', 'tasks', `${w3.pid}.json`)), 'the old worker\'s menu-bar card stayed');
  ok('a job in progress (task_plan): no swap until done; the old worker\'s menu-bar card goes with it');

  // New code that does not load: the worker stays; once fixed, the swap.
  update(true);
  await until(() => /new code does not load/.test(s.stderr()), 30_000, 'the failed look at the new code');
  await sleep(800);
  assert.equal(servers().find(j => j.launcher === L).pid, w4.pid, 'swapped to code that does not load');
  assert.equal((await s.client.listTools()).tools.length, 17);
  unbreak();
  const w5 = await until(() => servers().find(j => j.pid !== w4.pid && j.launcher === L), 30_000, 'the swap once fixed');
  ok('new code that does not load: the old worker keeps serving (said on stderr); fixed: swapped');

  // A worker that dies: its call gets an error to retry; a new worker; the session's tab stays.
  setTabs({ tabs: [{ id: 10, url: 'https://a.test/', title: 'A' }], listDelayMs: 3000 });
  const doomed = s.client.callTool({ name: 'list_tabs', arguments: {} }).then(r => ({ r }), e => ({ e }));
  await sleep(500);
  process.kill(w5.pid, 'SIGKILL');
  const d = await Promise.race([doomed, sleep(10_000).then(() => ({ hung: true }))]);
  assert.ok(d.e && /意外退出/.test(String(d.e.message)), `the call of a worker that died: ${JSON.stringify(d.r || String(d.e))}`);
  setTabs({ tabs: [{ id: 10, url: 'https://a.test/', title: 'A' }] });
  await until(() => servers().find(j => j.pid !== w5.pid && j.launcher === L), 10_000, 'a worker again');
  assert.equal((await s.client.listTools()).tools.length, 17);
  assert.ok(!closes().includes(10), 'the session\'s tab closed when a worker died');
  ok('a worker that dies: its call answered with an error to retry, a new worker, the session\'s tab kept');

  // A signal to the worker alone (not the session ending): it goes, another starts; the session's tab stays.
  const w6 = await until(() => servers().find(j => j.launcher === L), 10_000, 'the worker');
  process.kill(w6.pid, 'SIGTERM');
  const w7 = await until(() => servers().find(j => j.pid !== w6.pid && j.launcher === L), 15_000, 'a worker after SIGTERM');
  await sleep(300);
  assert.ok(!closes().includes(10), 'the session\'s tab closed when only the worker got SIGTERM');
  assert.match(text(await s.client.callTool({ name: 'list_tabs', arguments: {} })), mine);
  ok('SIGTERM to the worker alone: another worker, the session\'s tab kept and still its own');

  // A call the client cancels gets no answer (the SDK drops it): it must not hold the swap back for ever.
  setTabs({ tabs: [{ id: 10, url: 'https://a.test/', title: 'A' }], listDelayMs: 3000 });
  const ac = new AbortController();
  const gone2 = s.client.callTool({ name: 'list_tabs', arguments: {} }, undefined, { signal: ac.signal }).catch(() => null);
  await sleep(300);
  ac.abort();
  await gone2;
  setTabs({ tabs: [{ id: 10, url: 'https://a.test/', title: 'A' }] });
  update();
  await until(() => servers().find(j => j.pid !== w7.pid && j.launcher === L), 20_000, 'the swap after a cancelled call');
  ok('a cancelled call does not hold the swap back');

  // The session ends: the worker closes the session's tabs and both processes go.
  const last = servers().find(j => j.launcher === L);
  await s.client.close();
  await until(() => !alive(L) && !alive(last.pid), 15_000, 'launcher and worker gone');
  await until(() => closes().includes(10), 5000, 'the session\'s tab closed at its end');
  ok('the session ends: its tabs close, launcher and worker exit');

  // A worker that ends while asked to hand over: the session goes on with a new worker (on the new code).
  const t = await connect({ ...ENV, CHROME_BRIDGE_TEST_HANDOVER: 'die' });
  const d1 = await until(() => servers().find(j => j.launcher), 10_000, 'the worker');
  update();
  await until(() => /ended while asked to hand over/.test(t.stderr()), 20_000, 'the worker ending while asked');
  await until(() => servers().find(j => j.pid !== d1.pid && j.launcher === d1.launcher), 10_000, 'a worker again');
  assert.equal((await t.client.listTools()).tools.length, 17);
  await t.client.close();
  await until(() => !alive(d1.launcher), 15_000, 'its launcher gone');
  ok('a worker that ends while asked to hand over: another one starts, the session goes on');

  // A big ledger (long addresses and titles, past what the environment could carry) still goes over.
  const b = await connect();
  const b1 = await until(() => servers().find(j => j.launcher), 10_000, 'the worker');
  const many = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, url: `https://big.test/${i}/${'x'.repeat(1500)}`, title: `T${i} ${'y'.repeat(1500)}` }));
  setTabs({ tabs: many });
  for (const t of many) record(t.id, b1.launcher, t.url);
  assert.match(text(await b.client.callTool({ name: 'list_tabs', arguments: {} })), /你（这个会话）的标签（120 个）/);
  update();
  await until(() => servers().find(j => j.pid !== b1.pid && j.launcher === b1.launcher), 20_000, 'the swap with a big ledger');
  await until(() => /carried 120 tab\(s\) over/.test(b.stderr()), 5000, 'the big ledger handed over');
  setTabs({ tabs: [] });
  await b.client.close();
  await until(() => !alive(b1.launcher), 15_000, 'its launcher gone');
  ok('a big ledger (over 200 KB) is handed over too (over the IPC channel)');

  // A worker that should get a hand-over and does not (its launcher stopped answering): it does not serve;
  // answered, it takes it before it answers initialize. Here the test is the launcher.
  const { spawn } = await import('node:child_process');
  const lone = (answer) => new Promise((res) => {
    const c = spawn(process.execPath, [path.join(copy, 'src', 'index.js'), '--worker'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...ENV, CHROME_BRIDGE_WORKER: '1', CHROME_BRIDGE_LAUNCHER_PID: String(process.pid), CHROME_BRIDGE_CLIENT_PID: String(process.pid), CHROME_BRIDGE_CARRY: 'ipc' } });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; if (/"id":1\b/.test(out)) c.stdin.end(); });
    c.stderr.on('data', d => { err += d; });
    c.on('message', (m) => { if (m && m.t === 'carry?' && answer) c.send({ t: 'carry', carry: answer }); });
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lone', version: '0' } } }) + '\n');
    const t = setTimeout(() => c.kill('SIGKILL'), 20_000);
    c.on('exit', (code) => { clearTimeout(t); res({ code, out, err }); });
  });
  const none = await lone(null);
  assert.equal(none.code, 4, none.err);
  assert.doesNotMatch(none.out, /"id":1\b/, 'answered initialize without its hand-over');
  assert.match(none.err, /the hand-over did not arrive/);
  const got = await lone({ ledger: { tabs: [[10, { tabId: 10, state: 'ready', url: 'https://a.test/' }]], seq: 1, reportedSeq: 1 }, taskCancelled: 'job' });
  assert.equal(got.code, 0, got.err);
  const answered = JSON.parse(got.out.split('\n').find(l => /"id":1\b/.test(l)));
  assert.ok(answered.id === 1 && answered.result && answered.result.serverInfo, got.out.slice(0, 200));
  assert.match(got.err, /carried 1 tab\(s\) over/);
  ok('a worker whose hand-over does not come does not serve (exit 4, initialize unanswered); one that gets it takes it first');

  // What one worker hands over is what the next one takes (src/index.js handoverCarry / applyCarry).
  Object.assign(process.env, { CHROME_BRIDGE_LOCK: path.join(tmp, 'unit', 'lock', 'input.lock'), CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'unit', 'tabs'),
    CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'unit', 'agent-window.json'), CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_HABITS: 'off' });
  const idx = await import('../src/index.js');
  const carry = { routines: { version: 1, entries: [] }, ledger: { tabs: [[10, { tabId: 10, state: 'user_viewing', url: 'https://a.test/', helped: { since: 1, until: 2 }, newsSeq: 3 }]], seq: 3, reportedSeq: 2 },
    warned: [11], noted: [12], taskCancelled: 'swap test', panelTask: { text: 'swap test', at: 123 },
    shots: [[10, { rect: [0, 0, 800, 600], width: 800, height: 600, at: Date.now(), texts: [['t1', { x: 40, y: 20, text: '登录' }]] }]] };
  assert.equal(idx.applyCarry(JSON.parse(JSON.stringify(carry))), 1);
  assert.deepEqual(idx.handoverCarry(), carry);
  assert.equal(idx.applyCarry(null), 0);
  carry.shots[0][1].at = Date.now() - 6 * 60_000;
  idx.applyCarry(JSON.parse(JSON.stringify(carry)));
  assert.deepEqual(idx.handoverCarry().shots, [], 'a screenshot past its 5 minutes handed over');
  ok('the hand-over: the tab ledger (helped included), the warnings given, a stop not yet heard, the job of actions without task and fresh screenshots go to the next worker');
  const guiBinding = { version: 1, provider: 'Codex', threadId: 'synthetic-carried-thread', manual: true };
  idx.applyCarry({ guiBinding: { ...guiBinding, entries: [{ text: 'PRIVATE_SYNTHETIC_TEXT' }],
    nonce: 'old-nonce', bindingId: 'old-binding', guiInstance: 'old-instance' } });
  assert.deepEqual(idx.handoverCarry().guiBinding, guiBinding);
  idx.applyCarry({ guiBinding: { ...guiBinding, provider: 'Claude' } });
  assert.equal(idx.handoverCarry().guiBinding, undefined);
  ok('GUI hand-over carries only validated Codex identity, never text, nonces, bindings or GUI instances');

  // CHROME_BRIDGE_HOTSWAP=0: one process, as before.
  const p = await connect({ ...ENV, CHROME_BRIDGE_HOTSWAP: '0' });
  const one = await until(() => servers()[0], 10_000, 'the server');
  assert.equal(one.launcher, null);
  assert.ok(execFileSync('/bin/ps', ['-o', 'command=', '-p', String(ppidOf(one.pid))], { encoding: 'utf8' }).includes('hotswap.test'), 'not started by the test itself');
  await p.client.close();
  ok('CHROME_BRIDGE_HOTSWAP=0: no launcher, the server is the process the client started');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`hotswap tests passed (${passed})`);
