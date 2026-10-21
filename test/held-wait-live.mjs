#!/usr/bin/env node
/* The user is typing when an agent clicks (owner 2026-10-13: "之前不是用户正在操作会等用户操作完了再接管"):
 * MyChrome must wait until they are done, then take over once — not refuse with input_held. A helper
 * (test/fixtures/typist.swift) presses and releases right Option every 250 ms for 3 s, posted like
 * hardware input; the agent's click starts 0.4 s in. Expected: the hold begins only after the typing
 * has stopped for 1.5 s, the agent's page gets one click, none of the "typing" is swallowed, the
 * front goes back to the app that had it.
 * Takes over keyboard and mouse ONCE (a few seconds, with the overlay); presses right Option for 3 s.
 *   npm run live:held:check    checks only, nothing opened or pressed
 *   npm run live:held [-- out.json] */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTabs, evalInPage, closeTab, snapshotScene } from '../src/bridge.js';
import { requireUnlocked } from './live-guard.mjs';
import { startFixtureServer } from './fixtures/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const out = argv.find(a => !a.startsWith('--')) || path.join(ROOT, 'docs', 'live', `held-wait-live-${new Date().toLocaleDateString('sv')}.json`);
const TYPIST_SRC = path.join(ROOT, 'test', 'fixtures', 'typist.swift');
const TYPIST = path.join(ROOT, 'bin', 'typist');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let frontBefore = null;
/** After the cleanup: the front app, once a second for 6 s, must stay the one the user had (TODO: Chrome
 * was seen in front again after a hand-back). */
async function frontStaysBack(res) {
  if (!frontBefore || frontBefore.appPid == null) return true;
  const seen = [];
  for (let i = 0; i < 6; i++) { await sleep(1000); const s = await snapshotScene().catch(() => null); seen.push(s ? s.app : null); }
  res.frontAfterCleanup = seen;
  return seen.every(a => a === frontBefore.app);
}
const log = (m) => console.error(`[${new Date().toLocaleTimeString('sv')}] ${m}`);

const fails = [];
await requireUnlocked();
await listTabs().catch(e => fails.push(`Chrome not reachable: ${String(e.message).split('\n')[0]}`));
for (const [bin, src] of [['bin/cgevent', 'src/helper.swift'], ['bin/chromectl', 'src/chromectl.swift']]) {
  const b = path.join(ROOT, bin), s = path.join(ROOT, src);
  if (!existsSync(b)) fails.push(`${b} missing: run npm run build`);
  else if (statSync(b).mtimeMs < statSync(s).mtimeMs) fails.push(`${b} is older than its source: run npm run build`);
}
try {
  if (!existsSync(TYPIST) || statSync(TYPIST).mtimeMs < statSync(TYPIST_SRC).mtimeMs) {
    mkdirSync(path.dirname(TYPIST), { recursive: true });
    execFileSync('swiftc', ['-O', TYPIST_SRC, '-o', TYPIST], { stdio: 'pipe' });
  }
} catch (e) { fails.push(`typist did not build: ${String(e.stderr || e.message).slice(0, 200)}`); }
const srv = await startFixtureServer({ port: 0 });
const base = `http://127.0.0.1:${srv.port}`;
if (!/id="go"/.test(await fetch(`${base}/queue.html`).then(r => r.text()).catch(() => ''))) fails.push('fixture queue.html not served');
const a = await (async () => {
  const c = new Client({ name: 'held-wait-live', version: '1' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'index.js')], stderr: 'ignore',
    env: { ...process.env, CHROME_BRIDGE_AGENT_NAME: 'held-wait-live', CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_TIMING_DETAIL: '1' } }));
  c.call = async (tool, args = {}) => {
    const t0 = Date.now();
    const r = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
    return { tool, text: r.content.filter(x => x.type === 'text').map(x => x.text).join('\n'), isError: !!r.isError, start: t0, end: Date.now() };
  };
  return c;
})().catch(e => { fails.push(`server did not start: ${e.message}`); return null; });
for (const f of fails) log(`check FAILED: ${f}`);
if (checkOnly || fails.length) {
  log(fails.length ? 'self-check failed; nothing was opened' : 'self-check passed; nothing was opened or pressed');
  await a?.close(); await srv.close();
  process.exit(fails.length ? 4 : 0);
}

const res = { at: new Date().toISOString(), checks: {}, steps: [] };
const head = (t) => t.split('\n').slice(0, 3).join(' | ').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>').slice(0, 400);
const step = (r) => res.steps.push({ tool: r.tool, ms: r.end - r.start, isError: r.isError, head: head(r.text) });
let tab = null;
try {
  const o = await a.call('open_tab', { url: `${base}/queue.html?agent=held`, why: 'user_asked' });
  step(o);
  tab = Number((o.text.match(/tab=(\d+)/) || [])[1]);
  if (o.isError || !Number.isFinite(tab)) throw new Error(`open_tab: ${o.text.slice(0, 300)}`);
  await sleep(1500);
  const r = await a.call('read_page', { tab });
  step(r);
  const marker = Number((r.text.match(/\[(\d+)\][^\n[]*Press held/) || [])[1]);
  if (!Number.isFinite(marker)) throw new Error(`no button on the agent's page: ${r.text.slice(0, 300)}`);
  const before = await snapshotScene().catch(() => null);
  frontBefore = before;
  log('typing (right Option, 3 s) while the agent clicks; MyChrome should wait, then take over for a few seconds');
  const typist = new Promise((resolve, reject) => {
    const p = spawn(TYPIST, ['3000', '250'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let s = '';
    p.stdout.on('data', d => { s += d; });
    p.on('exit', (code) => code === 0 ? resolve(JSON.parse(s)) : reject(new Error(`typist exit ${code}`)));
  });
  await sleep(400);
  const [typed, c] = await Promise.all([typist, a.call('click', { tab, marker })]);
  step(c);
  res.typed = typed;
  res.click = { start: c.start, end: c.end, afterLastKeyMs: c.end - typed.last };
  await sleep(500);
  res.pressed = await evalInPage('JSON.stringify({ ok: true, n: Number(document.getElementById("n").textContent) })', tab, { lean: true })
    .then(x => x.n).catch(e => `error: ${String(e.message).split('\n')[0]}`);
  const after = await snapshotScene().catch(() => null);
  res.front = { before: before?.app ?? null, after: after?.app ?? null };
  res.checks.click_done = !c.isError && /✅|已点击/.test(c.text);
  res.checks.page_got_one_click = res.pressed === 1;
  res.checks.waited_for_the_typing = /等你停手 \d+\.\d 秒后才操作/.test(c.text);
  // The hold began >= 1.5 s after the last key: the server's own time of the hold (timing detail line,
  // "接管于 <epoch ms>"), not the call's end or start (Fable r12 B5, r2 A1).
  const heldAt = Number((c.text.match(/接管于 (\d+)/) || [])[1]);
  res.click.heldAfterLastKeyMs = Number.isFinite(heldAt) ? heldAt - typed.last : null;
  res.checks.held_only_after_typing_stopped = Number.isFinite(heldAt) && heldAt - typed.last >= 1450;
  res.checks.no_typing_swallowed = !/拦下了你的/.test(c.text);
  res.checks.not_refused_for_a_held_key = !/按着/.test(c.text);
  res.checks.front_given_back = !!before && !!after && before.appPid === after.appPid;
} catch (e) {
  res.fatal = String(e.message);
  log(`FAILED: ${res.fatal}`);
} finally {
  if (tab) {
    const c = await a.call('close_tab', { tab }).catch(e => ({ tool: 'close_tab', text: String(e.message), isError: true, start: 0, end: 0 }));
    step(c);
  }
  await a.close().catch(() => {});
  await srv.close();
  let left = [];
  try { left = (await listTabs()).windows.flatMap(w => w.tabs).filter(t => String(t.url).startsWith(`${base}/`)); for (const t of left) await closeTab(t.id).catch(() => {}); } catch {}
  res.checks.cleanup_no_test_tab_left_by_the_agent = left.length === 0;
  res.checks.front_still_given_back_after_cleanup = await frontStaysBack(res);
  res.pass = !res.fatal && Object.values(res.checks).every(Boolean);
  writeFileSync(out, JSON.stringify(res, null, 2));
  log(`${res.pass ? 'PASS' : 'FAIL'}: ${JSON.stringify(res.checks)} → ${path.relative(ROOT, out)}`);
  process.exit(res.pass ? 0 : 1);
}
