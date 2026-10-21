#!/usr/bin/env node
/* wait_for_user with `field`, live (owner 2026-10-11: "the agent highlights where the user must type; after
 * the user presses Return the agent carries on by itself, without going back to the chat").
 * One agent (its own server process over real stdio MCP) opens a local test login page in its window,
 * reads it, and calls wait_for_user on the password field. The OWNER then goes to Chrome, types anything
 * into the highlighted field and presses Return; the call must return by itself and the agent goes on
 * (reads the next page, closes its tab).
 * Covers nothing and takes over neither keyboard nor mouse: the only input is the owner's own typing.
 * It does send one notification and selects the test tab in the agent window. Waits at most 3 minutes.
 * --self (owner 2026-10-12: "the password is not real, test it yourself"): a second agent stands in for
 * the owner and types a made-up code into the page's code field with MyChrome's own real keys, then
 * Return (the password field would turn on macOS Secure Input, which MyChrome waits out). That is ONE
 * MyChrome input action: it takes over keyboard and mouse for a few seconds; ask the owner first.
 *   npm run live:ask:check          checks only, nothing opened
 *   npm run live:ask [-- out.json]  the test (needs the owner at the keyboard)
 *   npm run live:ask -- --self      the test, typed by the stand-in agent */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTabs, evalInPage } from '../src/bridge.js';
import { requireUnlocked } from './live-guard.mjs';
import { startFixtureServer } from './fixtures/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const out = process.argv.slice(2).find(a => !a.startsWith('--')) ||
  path.join(ROOT, 'docs', 'live', `ask-live-${new Date().toLocaleDateString('sv')}.json`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.error(`[${new Date().toLocaleTimeString('sv')}] ${m}`);

const self = process.argv.includes('--self');
async function agent(name = 'ask-live') {
  const c = new Client({ name, version: '1' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'index.js')], stderr: 'ignore',
    env: { ...process.env, CHROME_BRIDGE_AGENT_NAME: name, CHROME_BRIDGE_MENUBAR: '0' } }));
  c.call = async (tool, args = {}) => {
    const t0 = Date.now();
    const r = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 240_000 });
    const text = r.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
    return { tool, text, images: r.content.filter(x => x.type === 'image'), isError: !!r.isError, ms: Date.now() - t0 };
  };
  return c;
}
// What the page shows now, read the way MyChrome reads pages: the highlight's host element (light DOM) and the title.
const pageState = (tabId) => evalInPage('JSON.stringify({ ok: true, n: document.querySelectorAll("[data-mychrome-ask]").length, title: document.title })',
  tabId, { lean: true }).then(r => ({ n: r.n, title: r.title, url: r.target.url })).catch(e => ({ error: String(e.message).split('\n')[0] }));
// This run's own test pages (the fixture's port is new each run, so nothing else matches).
const testTabs = (prefix, close = false) => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', `
  const c = Application('Google Chrome'), ids = [];
  for (const w of c.windows()) for (const t of w.tabs()) if (t.url().startsWith(${JSON.stringify(prefix)})) ids.push([w.id(), t.id()]);
  if (${close}) for (const [w, t] of ids) c.windows.byId(w).tabs.byId(t).close();
  JSON.stringify(ids.map(x => x[1]));`], { encoding: 'utf8', timeout: 10_000 }));

/* ---- self-check: nothing is opened ---- */
const fails = [];
await requireUnlocked();
await listTabs().catch(e => fails.push(`Chrome not reachable: ${String(e.message).split('\n')[0]}`));
const srv = await startFixtureServer({ port: 0 });
const base = `http://127.0.0.1:${srv.port}`;
const page = await fetch(`${base}/ask.html`).then(r => r.text()).catch(() => '');
if (!/type="password"/.test(page)) fails.push('fixture ask.html not served');
const a = await agent().catch(e => { fails.push(`server did not start: ${e.message}`); return null; });
if (a) {
  const w = (await a.listTools()).tools.find(t => t.name === 'wait_for_user');
  if (!w || !w.inputSchema.properties.field) fails.push('wait_for_user has no field: this checkout is older than the feature');
}
for (const f of fails) log(`check FAILED: ${f}`);
if (checkOnly || fails.length) {
  log(fails.length ? 'self-check failed; nothing was opened' : 'self-check passed; nothing was opened');
  await a?.close(); await srv.close();
  process.exit(fails.length ? 4 : 0);
}

const res = { at: new Date().toISOString(), checks: {}, steps: [] };
let tab = null;
// A Chrome profile's email address (open_tab names the profile) stays out of the result file.
const head = (t) => t.split('\n').slice(0, 2).join(' | ').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>').slice(0, 300);
const step = (r, extra = {}) => { res.steps.push({ tool: r.tool, ms: r.ms, isError: r.isError, head: head(r.text), ...extra }); };
try {
  const o = await a.call('open_tab', { url: `${base}/ask.html`, why: 'user_asked' });
  step(o);
  tab = Number((o.text.match(/tab=(\d+)/) || [])[1]);
  if (o.isError || !Number.isFinite(tab)) throw new Error(`open_tab: ${o.text.slice(0, 300)}`);
  await sleep(2000);
  const r = await a.call('read_page', { tab });
  step(r);
  // The field's own number: the screen line is "[3] 密码 [4] 输入框: 随便输几个字", so no "[" in between.
  const field = Number((r.text.match(self ? /\[(\d+)\][^[\n]*6 位数字/ : /\[(\d+)\][^[\n]*随便输几个字/) || [])[1]);
  if (!Number.isFinite(field)) throw new Error(`no ${self ? 'code' : 'password'} field on the page: ${r.text.slice(0, 400)}`);
  if (!self) log(`>>> 请到 Chrome：在高亮的「密码」框里随便输几个字，按回车。最多等 3 分钟。`);
  let typedCode = null;
  const waiting = a.call('wait_for_user', self
    ? { tab, field, reason: '测试验证码（本机测试页，测试脚本自己输入）', minutes: 2 }
    : { tab, field, reason: '任意测试密码（这是本机测试页）', minutes: 3 });
  if (self) {
    const u = await agent('ask-live-user');   // stands in for the owner
    try {
      await sleep(2500);   // armed by now
      res.armed = await pageState(tab);
      res.checks.highlight_shown = res.armed.n === 1 && /^【需要你输入】/.test(res.armed.title || '');
      const ur = await u.call('read_page', { tab });   // its own numbers (the same page: the same ones)
      step(ur);
      const uField = Number((ur.text.match(/\[(\d+)\][^[\n]*6 位数字/) || [])[1]);
      if (!Number.isFinite(uField)) throw new Error(`stand-in: no code field: ${ur.text.slice(0, 300)}`);
      const shot = await u.call('screenshot', { tab, image: true });
      // The agent window's text may hold other tabs' titles: not kept in the result file.
      res.steps.push({ tool: shot.tool, ms: shot.ms, isError: shot.isError, head: '(screenshot text not kept)' });
      if (shot.images[0]) writeFileSync(path.join(ROOT, 'verification', 'ask', `live-armed-${new Date().toLocaleDateString('sv')}.png`), Buffer.from(shot.images[0].data, 'base64'));
      res.checks.note_on_screen = /需要你输入/.test(shot.text);
      const code = String(100000 + Math.floor(Math.random() * 900000));   // made up, for this test page only
      log('stand-in agent: typing a made-up code and Return (MyChrome takes over keyboard and mouse for a few seconds)');
      const t = await u.call('type_text', { tab, marker: uField, text: code, input_mode: 'keys', submit: true });
      step(t);
      res.afterReturn = await pageState(tab);
      res.checks.highlight_gone = !res.afterReturn.error && res.afterReturn.n === 0 && !/^【需要你输入】/.test(res.afterReturn.title || '');
      // The stand-in's own type_text reply echoes what it typed (by design: it is the typist); the waiting agent must never see it.
      res.standInEchoesOwnInput = t.text.includes(code);
      res.checks.typed_value_not_in_any_reply = ![r.text, ur.text, shot.text].some(x => x.includes(code));
      typedCode = code;
    } finally { await u.close().catch(() => {}); }
  }
  const w = await waiting;
  step(w, { field });
  res.checks.wait_returned_by_itself = !w.isError && /^✅/.test(w.text);
  res.checks.reply_has_no_value_hint = /不要在回复里复述用户输入的内容/.test(w.text) || /页面已经跳转/.test(w.text);
  log(`wait_for_user: ${w.text.split('\n')[0]}`);
  if (!self) {
    res.afterReturn = await pageState(tab);   // right away (the page may already be on the next one: no highlight there either)
    res.checks.highlight_gone = !res.afterReturn.error && res.afterReturn.n === 0 && !/^【需要你输入】/.test(res.afterReturn.title || '');
  }
  await sleep(2500);   // the page's "logging in…" moment, then the next page (when the wait did not follow it already)
  const after = await a.call('read_page', { tab });
  step(after);
  res.checks.agent_went_on_to_next_page = /已提交/.test(after.text);
  // The redirect after the Return is the agent's: no "taken over" note, and close_tab closes it (live run 2 refused).
  res.checks.tab_still_the_agents = !/可能已被|接手/.test(after.text);
  if (self && typedCode) res.checks.typed_value_not_in_any_reply &&= ![w.text, after.text].some(x => x.includes(typedCode));
} catch (e) {
  res.fatal = String(e.message);
  log(`FAILED: ${res.fatal}`);
} finally {
  if (tab) {
    const c = await a.call('close_tab', { tab }).catch(e => ({ tool: 'close_tab', text: String(e.message), isError: true, ms: 0 }));
    step(c);
    if (!res.fatal) res.checks.agent_closed_its_tab = !c.isError && /^✅/.test(c.text);
  }
  await a.close().catch(() => {});
  await srv.close();
  let left = [];
  try { left = testTabs(`${base}/ask.html`); if (left.length) { testTabs(`${base}/ask.html`, true); left = testTabs(`${base}/ask.html`); } } catch (e) { left = [`unknown (${String(e.message).split('\n')[0]})`]; }
  res.checks.cleanup_no_test_tab_left = left.length === 0;
  res.pass = !res.fatal && Object.values(res.checks).every(Boolean);
  writeFileSync(out, JSON.stringify(res, null, 2));
  log(`${res.pass ? 'PASS' : 'FAIL'}: ${JSON.stringify(res.checks)} → ${path.relative(ROOT, out)}`);
  process.exit(res.pass ? 0 : 1);
}
