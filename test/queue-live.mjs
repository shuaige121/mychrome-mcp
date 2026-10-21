#!/usr/bin/env node
/* Several agents at once, live (owner 2026-10-09): served in turn, the takeover handed from one to the next,
 * the user's things put back once at the end. Each "agent" is its own server process over real stdio MCP.
 *  1. Three agents each click their own page twice, all at the same moment.
 *  2. A long job (task_plan, 3 steps, 4 s of "thinking" between steps) while another agent clicks once:
 *     the click is done between two of the job's steps, not after the job.
 * COVERS THE SCREEN and holds the keyboard and mouse (takeover) for about 32 s in total (measured 2026-10-09):
 * run only after the owner said yes in person. Steps, expected results and recovery: docs/live/queue-live-runbook.md.
 *   npm run live:queue:check          checks only, nothing opened or covered (also run first by the full test)
 *   npm run live:queue [-- out.json]  the full test (refuses while another agent holds or waits for the mouse) */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { snapshotScene, cgevent, listTabs } from '../src/bridge.js';
import { LOCK_DIR, queueList } from '../src/lock.js';
import { requireUnlocked } from './live-guard.mjs';
import { startFixtureServer } from './fixtures/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const out = process.argv.slice(2).find(a => !a.startsWith('--')) ||
  path.join(ROOT, 'docs', 'live', `queue-live-${new Date().toLocaleDateString('sv')}.json`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.error(`[${new Date().toLocaleTimeString('sv')}] ${m}`);

/* ---- self-check: nothing is opened, moved or covered ---- */
async function selfCheck() {
  const fails = [], notes = [];
  await requireUnlocked();                                   // exits 3 when locked or asleep
  const d = await cgevent(['displays']).catch(() => null);
  notes.push(`displays: ${d && d.displays ? d.displays.length : '?'}`);
  for (const [bin, src] of [['bin/cgevent', 'src/helper.swift'], ['bin/chromectl', 'src/chromectl.swift']]) {
    const b = path.join(ROOT, bin), s = path.join(ROOT, src);
    if (!existsSync(b)) fails.push(`${bin} missing: run npm run build`);
    else if (statSync(b).mtimeMs < statSync(s).mtimeMs) fails.push(`${bin} is older than ${src}: run npm run build`);
  }
  const tabs = await listTabs().catch(e => { fails.push(`Chrome not reachable: ${String(e.message).split('\n')[0]}`); return null; });
  if (tabs) notes.push(`Chrome: ${(tabs.windows || []).length} windows, ${(tabs.windows || []).reduce((n, w) => n + ((w.tabs || []).length), 0)} tabs`);
  // Another agent working or waiting: the test would mix with its work and its clicks.
  let holder = null;
  try { holder = JSON.parse(readFileSync(path.join(LOCK_DIR, 'owner.json'), 'utf8')); } catch {}
  if (holder && holder.pid) { try { process.kill(holder.pid, 0); fails.push(`another agent holds the mouse now (pid ${holder.pid}, "${holder.label}"): wait until it is done`); } catch {} }
  const q = await queueList().catch(() => []);
  if (q.length) fails.push(`${q.length} task(s) waiting for the mouse: wait until the queue is empty`);
  const srv = await startFixtureServer({ port: 0 });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/queue.html?agent=A`);
    const html = await r.text();
    if (r.status !== 200 || !/id="go"/.test(html)) fails.push(`fixture page not served (${r.status})`);
  } finally { await srv.close(); }
  const a = await agent('check').catch(e => { fails.push(`server did not start: ${e.message}`); return null; });
  if (a) {
    const tools = (await a.listTools()).tools.map(t => t.name);
    for (const t of ['open_tab', 'read_page', 'click', 'task_plan', 'close_tab']) if (!tools.includes(t)) fails.push(`tool ${t} missing`);
    await a.close();
  }
  return { ok: !fails.length, fails, notes };
}

async function agent(name) {
  const c = new Client({ name, version: '1' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'index.js')], stderr: 'ignore',
    // No menu-bar item from this worktree (it would stand beside the user's own).
    env: { ...process.env, CHROME_BRIDGE_AGENT_NAME: `queue-live ${name}`, CHROME_BRIDGE_MENUBAR: '0' } }));
  c.call = async (tool, args = {}) => {
    const t0 = Date.now();
    const r = await c.callTool({ name: tool, arguments: args });
    return { tool, args, text: r.content.map(x => x.text).join('\n'), isError: !!r.isError, t0, t1: Date.now() };
  };
  return c;
}
const short = (r) => ({ tool: r.tool, t0: r.t0, t1: r.t1, isError: r.isError, head: r.text.split('\n').slice(0, 2).join(' | ').slice(0, 240),
  queued: /按先来后到轮到这次/.test(r.text), chained: /直接接过上一个 agent 的接管/.test(r.text), handed: /做完直接交给排队的下一个任务/.test(r.text) });
// This run's own test pages in Chrome (the fixture's port is new each run, so nothing else matches).
const testTabs = (prefix, close = false) => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', `
  const c = Application('Google Chrome'), ids = [];
  for (const w of c.windows()) for (const t of w.tabs()) if (t.url().startsWith(${JSON.stringify(prefix)})) ids.push([w.id(), t.id()]);
  if (${close}) for (const [w, t] of ids) c.windows.byId(w).tabs.byId(t).close();
  JSON.stringify(ids.map(x => x[1]));`], { encoding: 'utf8', timeout: 10_000 }));
const sceneKey = (s) => s ? { app: s.app, appPid: s.appPid, chromeWindow: s.chromeWindow, chromeTab: s.chromeTab } : null;

const check = await selfCheck();
for (const n of check.notes) log(`check: ${n}`);
for (const f of check.fails) log(`check FAILED: ${f}`);
if (checkOnly || !check.ok) {
  log(check.ok ? 'self-check passed; nothing was opened or covered' : 'self-check failed; nothing was opened or covered');
  process.exit(check.ok ? 0 : 4);
}

const res = { at: new Date().toISOString(), checks: {}, round1: [], round2: [] };
const srv = await startFixtureServer({ port: 0 });
const base = `http://127.0.0.1:${srv.port}`;
const names = ['A', 'B', 'C'];
const agents = await Promise.all(names.map(agent));
const tabs = {}, markers = {};
// Ctrl-C or the 3-minute limit: close the test's tabs and servers (their helpers end with them: veil down, input back).
let cleaning = null;
const cleanup = async (why) => {
  cleaning ||= (async () => {
    log(`stopping (${why}): closing the test's tabs and servers`);
    res.cleanup = {};
    for (const [i, n] of names.entries()) if (tabs[n]) {
      const r = await agents[i].call('close_tab', { tab: tabs[n] }).catch(e => ({ isError: true, text: String(e.message) }));
      res.cleanup[n] = r.text.split('\n')[0].slice(0, 200);
      if (r.isError) log(`close_tab ${n} refused: ${res.cleanup[n]}`);
    }
    for (const a of agents) await a.close().catch(() => {});
    await srv.close?.();
    // close_tab will not close a tab showing in the front window (the user may be reading it). These are the test's own pages: close them here.
    if (Object.keys(tabs).length) {
      let left = [];
      try {
        const mine = `${base}/queue.html`;
        left = testTabs(mine);
        if (left.length) { log(`closing ${left.length} test tab(s) left open: ${left.join(', ')}`); testTabs(mine, true); left = testTabs(mine); }
      } catch (e) { left = [`unknown (${String(e.message).split('\n')[0]})`]; }
      res.cleanup.left = left;
      res.checks.cleanup_no_test_tab_left = left.length === 0;
    }
  })();
  return cleaning;
};
process.on('SIGINT', () => { res.fatal = 'stopped with Ctrl-C'; cleanup('Ctrl-C').finally(() => { writeFileSync(out, JSON.stringify(res, null, 2)); process.exit(130); }); });
setTimeout(() => { res.fatal = 'took longer than 3 minutes'; cleanup('time limit').finally(() => { writeFileSync(out, JSON.stringify(res, null, 2)); process.exit(5); }); }, 180_000).unref();
try {
  for (const [i, n] of names.entries()) {
    const r = await agents[i].call('open_tab', { url: `${base}/queue.html?agent=${n}`, why: 'user_asked' });
    const t = Number((r.text.match(/tab=(\d+)/) || [])[1]);
    if (r.isError || !Number.isFinite(t)) throw new Error(`open_tab ${n}: ${r.text.slice(0, 300)}`);
    tabs[n] = t;
  }
  await sleep(2500);
  for (const [i, n] of names.entries()) {
    const r = await agents[i].call('read_page', { tab: tabs[n] });
    markers[n] = Number((r.text.match(/\[(\d+)\][^\n]*Press /) || [])[1]);
    if (!Number.isFinite(markers[n])) throw new Error(`no button on ${n}'s page: ${r.text.slice(0, 300)}`);
  }
  const scene0 = sceneKey(await snapshotScene());
  log(`scene before: ${JSON.stringify(scene0)}`);

  // 1. Three agents, two clicks each, all at once.
  log('round 1: three agents click at once');
  const runs = await Promise.all(names.map(async (n, i) => {
    const a = await agents[i].call('click', { tab: tabs[n], marker: markers[n] });
    const b = await agents[i].call('click', { tab: tabs[n], marker: markers[n] });
    return [a, b];
  }));
  res.round1 = runs.flat().map(short);
  const counts = {};
  for (const [i, n] of names.entries()) {
    const r = await agents[i].call('read_page', { tab: tabs[n] });
    counts[n] = Number((r.text.match(/Pressed:\s*(\d+)/) || [])[1]);
  }
  const scene1 = sceneKey(await snapshotScene());
  const spans = runs.flat().map(r => [r.t0, r.t1]);
  res.checks.round1_all_ok = runs.flat().every(r => !r.isError);
  res.checks.round1_each_page_pressed_twice = names.every(n => counts[n] === 2);
  res.checks.round1_queued = res.round1.filter(r => r.queued || r.chained).length >= 2;
  res.checks.round1_handed_over = res.round1.some(r => r.chained) && res.round1.some(r => r.handed);
  res.checks.round1_scene_put_back = JSON.stringify(scene1) === JSON.stringify(scene0);
  res.round1_counts = counts; res.scene0 = scene0; res.scene1 = scene1;
  res.round1_wall_ms = Math.max(...spans.map(s => s[1])) - Math.min(...spans.map(s => s[0]));
  log(`round 1: counts ${JSON.stringify(counts)}, scene after ${JSON.stringify(scene1)}`);

  // 2. A long job with pauses; another agent clicks during the first pause.
  log('round 2: a long job, another agent clicks between its steps');
  const [A, B] = agents;
  res.round2.push(short(await A.call('task_plan', { task: 'queue-live job', steps: ['Press 1', 'Press 2', 'Press 3'], estimate_minutes: 0.5 })));
  const a1 = await A.call('click', { tab: tabs.A, marker: markers.A, step: '1/3' });
  const bP = B.call('click', { tab: tabs.B, marker: markers.B });
  await sleep(4000);
  const a2 = await A.call('click', { tab: tabs.A, marker: markers.A, step: '2/3' });
  await sleep(1500);
  const a3 = await A.call('click', { tab: tabs.A, marker: markers.A, step: '3/3' });
  const b1 = await bP;
  const done = await A.call('task_plan', { done: true });
  res.round2.push(...[a1, b1, a2, a3, done].map(short));
  const scene2 = sceneKey(await snapshotScene());
  res.checks.round2_all_ok = [a1, a2, a3, b1].every(r => !r.isError);
  res.checks.round2_click_between_steps = b1.t1 < a2.t1 && b1.t1 > a1.t1;
  res.checks.round2_click_took_the_job_turn = /直接接过上一个 agent 的接管/.test(b1.text);
  res.checks.round2_scene_put_back = JSON.stringify(scene2) === JSON.stringify(scene0);
  res.scene2 = scene2;
  log(`round 2: B's click ended ${b1.t1 - a1.t1} ms after A's step 1, ${a2.t1 - b1.t1} ms before A's step 2 ended`);
} catch (e) {
  res.fatal = `${e.code || ''} ${String(e.message).slice(0, 400)}`;
  log(`FATAL ${res.fatal}`);
} finally {
  await cleanup('done');
  res.pass = !res.fatal && Object.values(res.checks).every(Boolean);
  writeFileSync(out, JSON.stringify(res, null, 2));
  log(`${res.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(res.checks)} → ${out}`);
  process.exit(res.pass ? 0 : 1);
}
