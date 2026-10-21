#!/usr/bin/env node
/* Two Chrome windows with exactly the same position and size, live (issue B2; owner 2026-10-12: JustTab
 * "can switch straight to the right window"). One agent (its own server process over real stdio MCP)
 * opens a test page in its window; this script then opens a second window with the same bounds IN FRONT
 * of it. The agent clicks the button on its own page, which is now behind the twin: the click must reach
 * the agent's page and not the twin's, and the front must go back to the app that had it.
 * Takes over keyboard and mouse ONCE, for the click (a few seconds, with the overlay); opens and closes
 * one extra window on the agent's display. Ask the owner first.
 *   npm run live:focus:check                checks only, nothing opened
 *   npm run live:focus [-- out.json]        the test
 *   ... -- --server ~/work/chrome-bridge-mcp  the agent's server from another checkout (e.g. master, to
 *                                            see the old behaviour); the twin window is still opened here */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { listTabs, evalInPage, newWindow, closeTab, snapshotScene, restoreApp } from '../src/bridge.js';
import { requireUnlocked } from './live-guard.mjs';
import { startFixtureServer } from './fixtures/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const si = argv.indexOf('--server');
const SERVER = si >= 0 ? path.resolve(argv[si + 1].replace(/^~/, os.homedir())) : ROOT;
const out = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--server') ||
  path.join(ROOT, 'docs', 'live', `focus-live-${new Date().toLocaleDateString('sv')}${SERVER === ROOT ? '' : '-' + path.basename(SERVER)}.json`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.error(`[${new Date().toLocaleTimeString('sv')}] ${m}`);

async function agent(name = 'focus-live') {
  const c = new Client({ name, version: '1' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(SERVER, 'src', 'index.js')], stderr: 'ignore',
    env: { ...process.env, CHROME_BRIDGE_AGENT_NAME: name, CHROME_BRIDGE_MENUBAR: '0' } }));
  c.call = async (tool, args = {}) => {
    const t0 = Date.now();
    const r = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
    return { tool, text: r.content.filter(x => x.type === 'text').map(x => x.text).join('\n'), isError: !!r.isError, ms: Date.now() - t0 };
  };
  return c;
}
const pressed = (tab) => evalInPage('JSON.stringify({ ok: true, n: Number(document.getElementById("n").textContent) })', tab, { lean: true })
  .then(r => r.n).catch(e => `error: ${String(e.message).split('\n')[0]}`);
const testTabs = (prefix, close = false) => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', `
  const c = Application('Google Chrome'), ids = [];
  for (const w of c.windows()) for (const t of w.tabs()) if (t.url().startsWith(${JSON.stringify(prefix)})) ids.push([w.id(), t.id()]);
  if (${close}) for (const [w, t] of ids) c.windows.byId(w).tabs.byId(t).close();
  JSON.stringify(ids.map(x => x[1]));`], { encoding: 'utf8', timeout: 10_000 }));

/* ---- self-check: nothing is opened ---- */
const fails = [];
await requireUnlocked();
await listTabs().catch(e => fails.push(`Chrome not reachable: ${String(e.message).split('\n')[0]}`));
for (const [bin, src] of [['bin/cgevent', 'src/helper.swift'], ['bin/chromectl', 'src/chromectl.swift']]) {
  for (const root of new Set([ROOT, SERVER])) {
    const b = path.join(root, bin), s = path.join(root, src);
    if (!existsSync(b)) fails.push(`${b} missing: run npm run build there`);
    else if (statSync(b).mtimeMs < statSync(s).mtimeMs) fails.push(`${b} is older than its source: run npm run build there`);
  }
}
const srv = await startFixtureServer({ port: 0 });
const base = `http://127.0.0.1:${srv.port}`;
if (!/id="go"/.test(await fetch(`${base}/queue.html`).then(r => r.text()).catch(() => ''))) fails.push('fixture queue.html not served');
const a = await agent().catch(e => { fails.push(`server did not start: ${e.message}`); return null; });
for (const f of fails) log(`check FAILED: ${f}`);
if (checkOnly || fails.length) {
  log(fails.length ? 'self-check failed; nothing was opened' : `self-check passed; nothing was opened (agent server: ${SERVER})`);
  await a?.close(); await srv.close();
  process.exit(fails.length ? 4 : 0);
}

const res = { at: new Date().toISOString(), server: SERVER, checks: {}, steps: [] };
const head = (t) => t.split('\n').slice(0, 2).join(' | ').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>').slice(0, 300);
const step = (r) => res.steps.push({ tool: r.tool, ms: r.ms, isError: r.isError, head: head(r.text) });
let tab = null, twinTab = null, frontBefore = null;
try {
  const before = await snapshotScene().catch(() => null);
  frontBefore = before;
  const o = await a.call('open_tab', { url: `${base}/queue.html?agent=back`, why: 'user_asked' });
  step(o);
  tab = Number((o.text.match(/tab=(\d+)/) || [])[1]);
  if (o.isError || !Number.isFinite(tab)) throw new Error(`open_tab: ${o.text.slice(0, 300)}`);
  await sleep(1500);
  const own = (await listTabs()).windows.find(w => w.tabs.some(t => t.id === tab));
  if (!own) throw new Error('the agent\'s tab is in no window');
  const b = own.bounds;
  log(`opening a twin window at the same bounds (${b.left},${b.top} ${b.width}x${b.height}) in front of the agent's`);
  const tTwin = Date.now();
  const nw = await newWindow(`${base}/queue.html?agent=front`, { left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height });
  twinTab = nw.tabId;
  await sleep(1500);
  // Opening a window brings Chrome forward: the front goes straight back to the app that had it
  // (not when the owner clicked somewhere since), so the click below starts from the owner's scene.
  if (before && before.appPid != null) res.twinFrontHandBack = await restoreApp(before.appPid, { noClickSince: tTwin }).catch(e => String(e.message));
  const list = await listTabs();
  const wa = list.windows.find(w => w.id === own.id), wb = list.windows.find(w => w.tabs.some(t => t.id === twinTab));
  res.twins = { agent: { bounds: wa?.bounds, cg: wa?.cgWindow, index: wa?.index }, twin: { bounds: wb?.bounds, cg: wb?.cgWindow, index: wb?.index } };
  res.checks.twins_same_bounds = !!(wa && wb) && ['left', 'top', 'width', 'height'].every(k => wa.bounds[k] === wb.bounds[k]);
  res.checks.twin_in_front = !!wb && wb.index < wa.index;
  res.checks.both_have_their_own_cg_window = wa?.cgWindow != null && wb?.cgWindow != null && wa.cgWindow !== wb.cgWindow;
  const r = await a.call('read_page', { tab });
  step(r);
  const marker = Number((r.text.match(/\[(\d+)\][^\n[]*Press back/) || [])[1]);
  if (!Number.isFinite(marker)) throw new Error(`no button on the agent's page: ${r.text.slice(0, 300)}`);
  log('the agent clicks its button (MyChrome takes over keyboard and mouse for a few seconds)');
  const c = await a.call('click', { tab, marker });
  step(c);
  await sleep(500);
  res.pressed = { agent: await pressed(tab), twin: await pressed(twinTab) };
  res.checks.click_reported_done = !c.isError && /^✅|已点击/.test(c.text);
  res.checks.agent_page_got_the_click = res.pressed.agent === 1;
  res.checks.twin_page_untouched = res.pressed.twin === 0;
  const after = await snapshotScene().catch(() => null);
  res.front = { before: before?.app ?? null, after: after?.app ?? null };
  res.checks.front_given_back = !!before && !!after && before.appPid === after.appPid;
} catch (e) {
  res.fatal = String(e.message);
  log(`FAILED: ${res.fatal}`);
} finally {
  // The agent's tab first: closing the twin first makes the agent's window Chrome's front window, and
  // close_tab rightly refuses a tab shown there while Chrome is the front app (seen 2026-10-13, run 2).
  if (tab) {
    const c = await a.call('close_tab', { tab }).catch(e => ({ tool: 'close_tab', text: String(e.message), isError: true, ms: 0 }));
    step(c);
    res.checks.agent_closed_its_tab = !c.isError;
  }
  if (twinTab) await closeTab(twinTab).catch(() => {});
  await a.close().catch(() => {});
  await srv.close();
  let left = [];
  try { left = testTabs(`${base}/queue.html`); if (left.length) { testTabs(`${base}/queue.html`, true); left = testTabs(`${base}/queue.html`); } } catch (e) { left = [`unknown (${String(e.message).split('\n')[0]})`]; }
  res.checks.cleanup_no_test_tab_left = left.length === 0;
  // After the cleanup: the front app, once a second for 6 s, stays the one the user had (TODO: Chrome was
  // seen in front again after a hand-back; front_given_back above is read before the cleanup).
  if (frontBefore && frontBefore.appPid != null) {
    const seen = [];
    for (let i = 0; i < 6; i++) { await sleep(1000); const s = await snapshotScene().catch(() => null); seen.push(s ? s.app : null); }
    res.frontAfterCleanup = seen;
    res.checks.front_still_given_back_after_cleanup = seen.every(x => x === frontBefore.app);
  }
  res.pass = !res.fatal && Object.values(res.checks).every(Boolean);
  writeFileSync(out, JSON.stringify(res, null, 2));
  log(`${res.pass ? 'PASS' : 'FAIL'}: ${JSON.stringify(res.checks)} → ${path.relative(ROOT, out)}`);
  process.exit(res.pass ? 0 : 1);
}
