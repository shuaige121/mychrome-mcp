// Explicit real-device acceptance: disposable local page, real MCP click path.
// --run requires authorization for a short screen/keyboard/mouse takeover.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, fork } from 'node:child_process';
import { disposeTerminal, readTerminalReceipt, productErrorFact } from './harness-terminal.mjs';

const flags = new Set(process.argv.slice(2));
if (flags.has('--wide')) throw Error('--wide is unavailable: fixture window resizing has no verified native hold. Use the normal --run panel path.');
if (!flags.has('--run')) throw Error('Use --run only after real-device testing is authorized.');
if (!flags.has('--fixture-worker')) {
  const directory = await fs.mkdtemp('/tmp/mychrome-hud-live-20261023-'); await fs.chmod(directory, 0o700);
  const binding = randomUUID();
  const child = fork(fileURLToPath(import.meta.url), ['--run', '--fixture-worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, MYCHROME_PANEL_DIR: directory, MYCHROME_PANEL_BINDING: binding, MYCHROME_PANEL_PARENT: String(process.pid) } });
  console.log(`REPORT ${path.join(directory, 'report.json')}`);
  const ended = await new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ code: null, signal: null })); });
  let report = {}, receipt = null, receiptError = null;
  try { report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8')); } catch {}
  try { receipt = await readTerminalReceipt(directory, binding, child.pid); }
  catch (error) { if (error.code !== 'ENOENT' || ended.code !== 0) receiptError = 'terminal_receipt_missing_or_invalid'; }
  if (receipt || receiptError || ended.code !== 0 || !report.started) {
    report.status = 'deferred'; report.terminalReceipt = receipt;
    report.terminal = receipt?.terminal || { code: receiptError || 'worker_exit_unknown', inputDelivery: 'unknown', noRetry: true };
    report.retainedFixture = receipt?.fixtures || report.retainedFixture || null;
    report.workerExit = ended; await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    process.exit(1);
  }
  process.exit(0);
}
if (!process.send || Number(process.env.MYCHROME_PANEL_PARENT) !== process.ppid || !process.env.MYCHROME_PANEL_BINDING || !process.env.MYCHROME_PANEL_DIR)
  throw Error('fixture_worker_parent_missing');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
if (process.env.CGEVENT_DRYRUN || process.env.CHROME_BRIDGE_LOCK || process.env.CHROME_BRIDGE_SETTINGS) throw Error('unsafe_inherited_live_environment');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.MYCHROME_PANEL_DIR;
const token = randomUUID(), route = `/fixture-${token}`;
const html = `<!doctype html><meta charset="utf-8"><meta name="fixture-token" content="${token}">
<title>MyChrome login choices fixture</title>
<style>body{margin:40px;background:#f7fafc;color:#172b4d;font:20px system-ui}main{max-width:720px}button{font:inherit;padding:16px 22px;margin:8px;border:1px solid #607090;border-radius:8px;background:white}#choices{padding:24px;background:#dcecff;border-radius:14px}#result{padding:20px}small{color:#617080}dialog{border:1px solid #607090;border-radius:14px}</style>
<header>UNCHANGED_NAVIGATION</header><main><h1>Login choices fixture</h1><p>UNCHANGED_PAGE_BODY</p>
<p>Real mouse input; no account login or external submission.</p>
<button id="login">Login</button><button id="delayed">Delayed Login</button><button id="modal">Dialog Login</button><button id="panel">Panel Login</button>
<div id="loading" hidden role="status" aria-busy="true">Loading…</div>
<section id="choices" hidden><p>Please choose your login identity</p><button id="individual">Individual User</button><button id="business">Business User</button></section>
<dialog id="dialog"><p>Choose your login identity in this dialog</p><button id="individualDialog">Individual User</button><button id="businessDialog">Business User</button></dialog>
<p id="result">No identity selected</p><meta name="click-counts" content="{}"></main>
<script>
const counts = {}; const by = id => document.getElementById(id);
function record(e) { counts[e.target.id] = (counts[e.target.id] || 0) + 1;
  if (!e.isTrusted) counts.untrusted = (counts.untrusted || 0) + 1;
  document.querySelector('meta[name="click-counts"]').content = JSON.stringify(counts); }
document.addEventListener('click', record, true);
by('login').onclick = () => { by('choices').hidden = false; };
by('delayed').onclick = () => { by('choices').hidden = true; by('loading').hidden = false;
  setTimeout(() => { by('loading').hidden = true; by('choices').hidden = false; }, 1100); };
by('modal').onclick = () => by('dialog').showModal();
by('panel').onclick = () => {
  by('panel').replaceWith(by('panel').cloneNode(true));
  const backdrop = document.createElement('div'); backdrop.id='backdrop'; backdrop.setAttribute('role','button');
  backdrop.style.cssText='position:fixed;inset:0;background:#0005;z-index:1000';
  backdrop.innerHTML='<div role="dialog" style="position:absolute;right:0;top:0;width:360px;height:100%;padding:20px;box-sizing:border-box;background:white"><p>Log in to continue</p><button id="panelClose" aria-label="Close"></button><button id="panelChoice"><img alt="Log in with fixture identity" style="pointer-events:none;width:260px;height:50px"></button></div>';
  document.body.append(backdrop);
  by('panelClose').onclick=()=>backdrop.remove();
  by('panelChoice').onclick=()=>{by('result').textContent='Fixture identity route selected';backdrop.remove();};
};
for (const id of ['individual','business','individualDialog','businessDialog']) by(id).onclick = () => {
  by('result').textContent = id.toLowerCase().startsWith('individual') ? 'Individual route selected' : 'Business route selected';
  by('choices').hidden = true; by('dialog').close(); };
</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('Connection', 'close'); res.setHeader('Cache-Control', 'no-store');
  if (req.url !== route) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}${route}`;
// The product's unchanged MCP server runs in this disposable fixture process.
// Keep the real global Pause and shared lock; isolate only fixture-owned files.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CHROME_BRIDGE_')) delete process.env[key];
}
Object.assign(process.env, {
  CHROME_BRIDGE_AGENT_NAME: 'Claude · fixture', CHROME_BRIDGE_AGENT_DISPLAY: 'away',
  CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_WARM: '0',
  CHROME_BRIDGE_HOTSWAP: '0', CHROME_BRIDGE_SWEEP: '0', CHROME_BRIDGE_ROUTINE_RECORDING: '0',
  CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_TAKEOVER: '1', CHROME_BRIDGE_INPUT_SPEED: '1',
  CHROME_BRIDGE_RETRY_MAX_MS: '15000', CHROME_BRIDGE_TAB_TTL_MIN: '0',
  CHROME_BRIDGE_ROUTINES_DIR: path.join(out, 'routines'), CHROME_BRIDGE_ACTIVITY: path.join(out, 'activity.jsonl'),
  CHROME_BRIDGE_AGENT_STATE: path.join(out, 'agent-window.json'), CHROME_BRIDGE_TAB_DIR: path.join(out, 'tabs'),
});
const api = await import('../src/index.js');
const B = await import('../src/bridge.js');
const tabs = await import('../src/tabs.js');
const settings = await import('../src/settings.js');
const { LOCK_DIR } = await import('../src/lock.js');
const client = new Client({ name: 'Claude Code', version: 'fixture-1' }, { capabilities: {} });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
const report = { started: new Date().toISOString(), root, checks: {}, calls: [], observations: [], screenshots: [], cleanup: {},
  fixture: { url, token },
  hashes: Object.fromEntries(await Promise.all(['src/index.js', 'src/page/read.js', 'src/page/click-observation.js', 'src/helper.swift', 'bin/cgevent', 'bin/chromectl'].map(async file =>
    [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')]))),
};
const save = () => fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

// This actual call/finally path is also loaded by the inert harness regression.
async function runPanelHarness({ client, api, B, tabs, settings, fs, lockDir, url, token, report, save,
  closeResources, screenshot, terminalDirectory = out, terminalSecret = process.env.MYCHROME_PANEL_BINDING,
  terminalDispose = disposeTerminal, scenario = panelScenario }) {
  const state = { terminal: null, plan: false, fixture: null, reportedFixture: null, closed: false,
    lastSession: null, pinnedHold: null, pinnedLeaseToken: null, sessionId: 'panel-task-session', inflight: new Set(), cleanupDenied: false, released: false };
  function seal(code, details = {}) {
    if (!state.terminal) {
      state.terminal = { code, stage: details.stage || 'harness', inputDelivery: 'unknown', noRetry: true, ...details };
      report.terminal = state.terminal;
      report.retainedFixture = state.closed ? null : state.fixture || state.reportedFixture || { tabId: null, windowId: null, identity: 'unknown' };
      const pending = [...state.inflight].at(-1);
      terminalDispose({ directory: terminalDirectory, binding: terminalSecret, terminal: state.terminal,
        fixtures: report.retainedFixture ? [report.retainedFixture] : [],
        call: pending ? { tool: pending.name, startedAt: pending.started, responseAt: pending.responseAt ?? null } : null,
        productError: pending?.productError,
        pinned: state.pinnedHold ? { hold: state.pinnedHold, session: state.lastSession, token: state.pinnedLeaseToken, sessionId: state.sessionId } : null });
    }
    // disposeTerminal exits. This fallback keeps inert tests/mutants sealed.
    throw Object.assign(Error(state.terminal.code), state.terminal);
  }
  function requireRunning() {
    if (state.terminal) throw Object.assign(Error(state.terminal.code), state.terminal);
  }
  function requireSameHold(hold) {
    if (!state.pinnedHold || !hold) return;
    if (hold !== state.pinnedHold || hold.kept.session !== state.lastSession) {
      seal('native_hold_replaced'); requireRunning();
    }
    if (hold.lease?.token !== state.pinnedLeaseToken) {
      seal('native_lease_replaced'); requireRunning();
    }
  }
  const onSignal = () => seal('operator_abort');
  const onParentDisconnect = () => seal('parent_disconnected');
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  process.on('disconnect', onParentDisconnect);
  async function readNative(stage, fn) {
    requireRunning();
    let value;
    try { value = await fn(); }
    catch (error) { seal('observation_unknown', { stage, cause: error.code || 'read_failed' }); throw error; }
    requireRunning(); return value;
  }
  async function observe({ requireHold = false } = {}) {
    requireRunning();
    let paused;
    try { paused = settings.get('paused'); }
    catch (error) { seal('pause_observation_unknown', { cause: error.code || 'read_failed' }); requireRunning(); }
    if (paused) { seal('paused_by_user'); requireRunning(); }
    const screen = await readNative('screen', () => B.cgevent(['displays']));
    if (screen.locked !== false || screen.displaysAsleep !== false) { seal('screen_locked_or_unreadable'); requireRunning(); }
    const hold = api.__taskHoldForTests();
    requireSameHold(hold);
    if ((hold?.kept.session || state.lastSession)?.interrupted) { seal('native_interruption'); requireRunning(); }
    if (!hold) {
      if (state.plan && state.lastSession && !state.released) { seal('native_hold_lost'); requireRunning(); }
      return { healthy: false, reason: 'no_current_hold' };
    }
    const status = await readNative('native_status', () => hold.kept.session.request({ op: 'status' }, { raw: true }));
    requireSameHold(api.__taskHoldForTests());
    if (status?.ok !== true || status.interrupted || status.takeover?.active !== true || status.takeover.aborted !== false ||
        api.__taskHoldForTests() !== hold) { seal('native_hold_unhealthy'); requireRunning(); }
    let lease = null;
    try { lease = JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8')); }
    catch { /* absence/unreadability cannot authorize cleanup */ }
    requireRunning();
    requireSameHold(api.__taskHoldForTests());
    const leaseToken = hold.lease?.token;
    const healthy = lease?.pid === process.pid && typeof leaseToken === 'string' && leaseToken.length > 0 &&
      lease.token === leaseToken && (!state.pinnedHold || leaseToken === state.pinnedLeaseToken) && api.__taskHoldForTests() === hold;
    report.observations.push({ at: Date.now(), healthy, helperPid: hold.kept.session.pid ?? null,
      active: status.takeover.active, aborted: status.takeover.aborted, leaseOwned: lease?.pid === process.pid });
    if (!healthy) { seal('native_lease_unknown'); requireRunning(); }
    return { healthy, hold, requireHold };
  }
  async function own(tabId) {
    requireRunning();
    const record = await readNative('fixture_owner', () => tabs.readTabRecord(tabId));
    const info = await readNative('fixture_identity', () => B.chromeInfo(tabId));
    const identity = { tabId: Number(tabId), windowId: info.windowId, chromePid: info.chromePid, cgWindow: info.cgWindow,
      ownerPid: record?.ownerPid, openedAt: record?.openedAt };
    const exact = record?.ownerPid === process.pid && record.expectedUrl === url && info.url === url &&
      Number.isFinite(record.openedAt) && Number(info.tabId) === Number(tabId) && Number(record.windowId) === Number(info.windowId) &&
      ['tabId','windowId','chromePid','cgWindow'].every(k => Number.isSafeInteger(identity[k]) && identity[k] > 0) &&
      (!state.fixture || Object.keys(identity).every(k => identity[k] === state.fixture[k]));
    return { identity, exact, closable: exact && !record.takenOver && !record.ownershipUncertain && !record.protected && !record.closeBlocked };
  }
  function reportedIdentity(name, text) {
    if (name !== 'open_tab') return;
    const tabId = Number(text.match(/\btab=(\d+)\b/)?.[1]);
    const windowId = Number(text.match(/\bwindow=(\d+)\b/)?.[1]);
    state.reportedFixture = { tabId: Number.isSafeInteger(tabId) && tabId > 0 ? tabId : null,
      windowId: Number.isSafeInteger(windowId) && windowId > 0 ? windowId : null, identity: 'unverified' };
  }
  async function call(name, args) {
    requireRunning();
    await observe(); requireRunning();
    const started = Date.now(), controller = new AbortController(), pending = { name, controller, started };
    let recorded = false;
    state.inflight.add(pending);
    try {
      // From this point a rejection is unknown delivery, even without a reply.
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000, signal: controller.signal });
      pending.responseAt = Date.now();
      pending.productError = result?.isError === true ? productErrorFact(result?.structuredContent?.error) : null;
      // Error prose may contain private page/input data and is not identity evidence.
      const text = result.isError ? null : result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
      if (!result.isError) reportedIdentity(name, text);
      report.calls.push({ name, ms: Date.now() - started, ...(text !== null ? { text } : {}), error: !!result.isError,
        ...(pending.productError ? { productError: pending.productError } : {}),
        inputDelivery: result.isError ? 'unknown' : 'receipt', noRetry: !!result.isError });
      recorded = true;
      if (result.isError) seal('unexpected_mcp_error', { stage: name, inputDelivery: 'unknown' });
      requireRunning();
      if (name === 'task_plan') { state.plan = args.done !== true; state.released = args.done === true; }
      if (state.plan && name === 'click') {
        const held = api.__taskHoldForTests();
        if (!held) { seal('native_hold_missing_after_input'); requireRunning(); }
        requireSameHold(held);
        if (!state.pinnedHold) {
          const leaseToken = held.lease?.token;
          if (typeof leaseToken !== 'string' || !leaseToken) { seal('native_lease_unknown'); requireRunning(); }
          state.pinnedHold = held; state.lastSession = held.kept.session; state.pinnedLeaseToken = leaseToken;
        }
      }
      await save(); requireRunning(); return text;
    } catch (error) {
      // Seal BEFORE removing inflight, including malformed/rejected RPCs.
      if (!recorded) {
        report.calls.push({ name, error: true, rejected: true, inputDelivery: 'unknown', noRetry: true });
      }
      seal('dispatched_rpc_rejected', { stage: name, inputDelivery: 'unknown', cause: error.code || 'rpc_rejected' });
      throw error;
    } finally { state.inflight.delete(pending); }
  }
  async function captureFixture(text) {
    requireRunning();
    const tabId = Number(text.match(/\btab=(\d+)\b/)?.[1]);
    if (!Number.isSafeInteger(tabId) || tabId <= 0) { seal('created_identity_missing'); requireRunning(); }
    const found = await own(tabId);
    if (!found.exact) { seal('created_identity_unknown'); requireRunning(); }
    state.fixture = found.identity; report.fixture = { url, token, ...found.identity }; return tabId;
  }
  async function readback() {
    requireRunning(); await observe(); requireRunning();
    if (!state.fixture) throw Error('fixture_identity_missing');
    const identity = await own(state.fixture.tabId);
    if (!identity.exact) { seal('fixture_identity_changed'); requireRunning(); }
    const r = await readNative('fixture_readback', () => B.evalInPage(`JSON.stringify({ok:true,fixture:location.href===${JSON.stringify(url)} && document.querySelector('meta[name="fixture-token"]')?.content===${JSON.stringify(token)},
      counts:JSON.parse(document.querySelector('meta[name="click-counts"]')?.content||'{}'),result:document.getElementById('result')?.textContent})`, state.fixture.tabId, { lean: true }));
    if (r.fixture !== true) { seal('fixture_token_changed'); requireRunning(); }
    return { counts: r.counts, result: r.result };
  }
  async function cleanup() {
    requireRunning();
    if (state.cleanupDenied) return report.cleanup;
    if (!state.fixture || state.closed) return report.cleanup;
    const observation = await observe({ requireHold: true });
    if (!observation.healthy) { state.cleanupDenied = true; report.cleanup.skipped = observation.reason; return report.cleanup; }
    const ownership = await own(state.fixture.tabId);
    if (!ownership.closable) { state.cleanupDenied = true; report.cleanup.skipped = 'fixture_ownership_unverified'; return report.cleanup; }
    await readback();
    // Recheck after every deferred identity/content read; never acquire a hold
    // or claim an uncertain tab just to make cleanup possible.
    const fresh = await own(state.fixture.tabId);
    if (!fresh.closable) { state.cleanupDenied = true; report.cleanup.skipped = 'fixture_ownership_changed'; return report.cleanup; }
    const held = await observe({ requireHold: true });
    if (!held.healthy) { state.cleanupDenied = true; report.cleanup.skipped = held.reason; return report.cleanup; }
    await call('close_tab', { tab: state.fixture.tabId });
    state.closed = true; report.cleanup.fixtureClosed = true;
    if (state.plan) report.cleanup.taskEnd = await call('task_plan', { done: true });
    return report.cleanup;
  }
  function check(name, value) { report.checks[name] = !!value; assert.ok(value, name); console.log(`PASS ${name}`); }
  function marker(text, label) {
    const line = text.split('\n').find(x => x.includes(label) && /\[\d+\]/.test(x));
    assert.ok(line, `missing returned option: ${label}`); return Number(line.match(/\[(\d+)\]/)[1]);
  }
  async function shot(name) {
    await readback();
    const info = await readNative('screenshot_identity', () => B.chromeInfo(state.fixture.tabId));
    const screen = await readNative('screenshot_screen', () => B.cgevent(['displays']));
    if (screen.locked !== false || screen.displaysAsleep !== false) { seal('screen_locked_or_unreadable'); requireRunning(); }
    requireRunning(); report.screenshots.push(await screenshot(name, info, screen)); await save();
  }
  const scene = () => readNative('scene', () => B.snapshotScene());
  const idle = () => readNative('idle', () => B.cgevent(['idle']));
  try {
    await scenario({ call, captureFixture, readback, cleanup, check, marker, shot, scene, idle, state, report });
  } catch (error) {
    report.failure = { code: error.name === 'AssertionError' ? 'assertion_failed' : error.code || 'harness_error',
      message: String(error.message).slice(0, 1000) }; process.exitCode = 1;
  } finally {
    if (!state.terminal) {
      try { await cleanup(); }
      catch (error) { report.cleanup.error = error.code || String(error.message).slice(0, 400); }
    }
    if (state.terminal) { process.exitCode = 1; report.cleanup.skipped = state.terminal.code; return report; }
    report.terminal = state.terminal;
    report.retainedFixture = state.closed ? null : state.fixture || state.reportedFixture || { tabId: null, windowId: null, identity: 'unknown' };
    // Only the ordinary completed path reaches asynchronous resource closure.
    // A terminal seal synchronously records evidence and exits above.
    await client.close().catch(() => {});
    try { await closeResources(); } catch (error) { report.cleanup.resourceError = error.code || String(error.message).slice(0, 200); }
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); process.off('disconnect', onParentDisconnect);
    await save();
  }
  return report;
}

async function panelScenario({ call, captureFixture, readback, cleanup, check, marker, shot, scene, idle, report }) {
  const opened = await call('open_tab', { url, why: 'user_asked' });
  const tab = await captureFixture(opened);
  await readback();
  const page = await call('read_page', { tab, full: true });
  const login = marker(page, '| Login'), delayed = marker(page, 'Delayed Login'), modal = marker(page, 'Dialog Login'), panel = marker(page, 'Panel Login');
  const sceneBefore = await scene();
  assert.ok(sceneBefore.appPid && sceneBefore.chromeWindow && sceneBefore.chromeTab, 'original scene is observable');
  await call('task_plan', { task: 'Verify new login choices and HUD layout' });
  const result = await call('click', { tab, marker: login });
  check('same_url_delta', result.includes('URL未变') && !/UNCHANGED_NAVIGATION|UNCHANGED_PAGE_BODY/.test(result));
  check('choice_context', result.includes('Please choose your login identity'));
  const individual = marker(result, 'Individual User'); marker(result, 'Business User');
  await shot('inline-options-hud');
  await call('click', { tab, marker: individual });
  check('next_click_uses_returned_marker', (await readback()).result === 'Individual route selected');
  const later = await call('click', { tab, marker: delayed });
  const business = marker(later, 'Business User'); marker(later, 'Individual User');
  check('delayed_choices_returned', !/UNCHANGED_NAVIGATION|UNCHANGED_PAGE_BODY/.test(later));
  await call('click', { tab, marker: business });
  check('delayed_choice_continues', (await readback()).result === 'Business route selected');
  const modalResult = await call('click', { tab, marker: modal });
  const modalIndividual = marker(modalResult, 'Individual User'); marker(modalResult, 'Business User');
  await shot('dialog-options-hud');
  const closed = await call('click', { tab, marker: modalIndividual });
  check('modal_close_does_not_repeat_old_controls', !/button \| Login|button \| Delayed Login|button \| Dialog Login/.test(closed));
  const panelResult = await call('click', { tab, marker: panel });
  marker(panelResult, '| Close');
  const panelChoice = marker(panelResult, 'Log in with fixture identity');
  check('nested_dialog_options_only', panelResult.includes('Log in to continue') &&
    !/button \| Panel Login|\] div \||UNCHANGED_/.test(panelResult));
  await call('click', { tab, marker: panelChoice });
  check('nested_dialog_marker_clicks_real_button', (await readback()).result === 'Fixture identity route selected');
  const final = await readback(); report.readback = final;
  check('single_trusted_clicks', ['login','delayed','modal','individual','business','individualDialog','panel','panelChoice'].every(id => final.counts[id] === 1) && !final.counts.untrusted);
  const done = (await cleanup()).taskEnd;
  check('input_released', /键盘鼠标接管已结束/.test(done));
  const sceneAfter = await scene();
  report.sceneRestoration = { before: sceneBefore, after: sceneAfter };
  check('original_app_window_tab_restored', ['appPid', 'chromeWindow', 'chromeTab'].every(key => sceneBefore[key] === sceneAfter[key]));
  const released = await idle(); check('no_held_keys', Array.isArray(released.held) && released.held.length === 0);
}

await api.__connectForTests(serverTransport);
await client.connect(clientTransport);
await runPanelHarness({ client, api, B, tabs, settings, fs, lockDir: LOCK_DIR, url, token, report, save,
  closeResources: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  screenshot: async (name, info, screen) => {
    const b = info.bounds, union = screen.unionPoints;
    const x = Math.max(union.x, b.left - 24), y = Math.max(union.y, b.top - 24);
    const width = Math.min(b.width + 48, union.x + union.w - x), height = Math.min(b.height + 48, union.y + union.h - y);
    const file = path.join(out, `${name}.png`);
    execFileSync('/usr/sbin/screencapture', ['-x', '-R', `${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`, file], { timeout: 10000 });
    return { name, file, windowBounds: b };
  },
});
console.log(`REPORT ${path.join(out, 'report.json')}`);
process.exit(process.exitCode || 0);
