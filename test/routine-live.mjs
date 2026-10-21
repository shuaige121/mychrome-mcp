#!/usr/bin/env node
/** Opt-in real Chrome fixture. Run only when authorized: node test/routine-live.mjs --run
 * No alternate input driver or DOM action. Ordinary MCP calls record three real
 * clicks; one routines/run replays them after a real reset changes marker order.
 * Uses the existing shared input lock and one task_plan, plus isolated stores,
 * tab registry and agent-window state. Never closes an unowned/taken-over tab.
 * Merely checking syntax or importing without --run does not open Chrome.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.log('Opt-in real input: node test/routine-live.mjs --run');
  process.exitCode = process.argv.length > 2 ? 2 : 0;
} else {
  await main();
}

async function main() {
  if (process.env.CGEVENT_DRYRUN === '1') throw new Error('Refuse a dry-run environment for the real-input fixture.');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mychrome-routine-live-'));
  // Preserve the standard shared input lock. An isolated lock would let this
  // process race other agents for the physical mouse and keyboard.
  Object.assign(process.env, {
    CHROME_BRIDGE_SETTINGS: path.join(dir, 'settings.json'),
    CHROME_BRIDGE_ACTIVITY: path.join(dir, 'activity.jsonl'),
    CHROME_BRIDGE_ROUTINES_DIR: path.join(dir, 'routines'),
    CHROME_BRIDGE_TAB_DIR: path.join(dir, 'tabs'),
    CHROME_BRIDGE_AGENT_STATE: path.join(dir, 'agent-window.json'),
    CHROME_BRIDGE_HABITS: 'off',
    CHROME_BRIDGE_ROUTINE_RECORDING: '1',
    CHROME_BRIDGE_AGENT_NAME: 'Local routines fixture',
    CHROME_BRIDGE_AGENT_DISPLAY: 'main',
    CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_SWEEP: '0', CHROME_BRIDGE_HOTSWAP: '0',
    CHROME_BRIDGE_TAKEOVER: '1', CHROME_BRIDGE_WARM: '0',
  });
  for (const name of ['CODEX_THREAD_ID', 'MYCHROME_VISIBLE_THREAD_ID', 'MYCHROME_VISIBLE_SOCKET',
    'CHROME_BRIDGE_LAUNCHER_PID', 'CHROME_BRIDGE_CLIENT_PID', 'CHROME_BRIDGE_CARRY',
    'CHROME_BRIDGE_DEBUG_LOG', 'CHROME_BRIDGE_INPUT_MODE', 'CHROME_BRIDGE_INPUT_SPEED']) delete process.env[name];
  await writeFile(process.env.CHROME_BRIDGE_SETTINGS, JSON.stringify({ inputMode: 'keys', inputSpeed: 1,
    agentDisplay: 'main', activityLog: false, notify: false }), { mode: 0o600 });

  const html = await readFile(new URL('./fixtures/routine.html', import.meta.url));
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/routine.html') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.end(html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/routine.html`;
  const evidence = { fixture: 'routine-live-v1', startedAt: new Date().toISOString(), directory: dir,
    origin, sharedInputLock: true, status: 'running', toolCalls: [], cleanup: {} };
  let api, bridge, tabs, tab = null, plan = false, activeNonce = null;
  const abort = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true; abort.abort();
    if (activeNonce && api) void api.callTool({ params: { name: 'routines', arguments: { action: 'stop', nonce: activeNonce } } }).catch(() => {});
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const deadline = setTimeout(stop, 180_000); deadline.unref();
  let stage = 'setup';
  const failure = (code, operation) => Object.assign(new Error(operation), { code });
  async function call(name, args = {}, { cleanup = false } = {}) {
    if (abort.signal.aborted && !cleanup) throw failure('cancelled', name);
    const at = Date.now();
    const result = await api.callTool({ params: { name, arguments: args } }, cleanup ? undefined : { signal: abort.signal });
    evidence.toolCalls.push({ tool: name, action: name === 'routines' ? args.action : undefined,
      ok: result?.isError !== true, at: new Date(at).toISOString(), ms: Date.now() - at });
    if (!result || result.isError) {
      // This driver only acts on its synthetic local fixture. Retain the actual
      // refusal rather than discarding the diagnostic as a generic tool_failed.
      evidence.toolFailure = { tool: name, code: result?.structuredContent?.error?.code,
        message: result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 2000) };
      throw failure(result?.structuredContent?.error?.code || 'tool_failed', name);
    }
    return result;
  }
  function structured(result) {
    const value = result?.structuredContent?.result;
    if (value === undefined) throw failure('missing_structured_result', 'routines');
    return value;
  }
  async function ownRecord() {
    if (!Number.isSafeInteger(tab) || tab <= 0) throw failure('missing_owned_tab', 'ownership');
    const record = await tabs.readTabRecord(tab);
    const expected = record?.expectedUrl && new URL(record.expectedUrl);
    if (!record || record.ownerPid !== process.pid || expected?.origin !== origin || expected.pathname !== '/routine.html') throw failure('ownership_changed', 'ownership');
    return record;
  }
  async function readFixture(expression) {
    await ownRecord();
    // Every eval is read-only and checks this exact local fixture before reading.
    return bridge.evalInPage(`(() => {
      if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== '/routine.html' ||
          document.querySelector('meta[name="mychrome-fixture"]')?.content !== 'routine-live-v1')
        return JSON.stringify({ok:false,error:'fixture_mismatch'});
      return JSON.stringify({ok:true,data:(${expression})});
    })()`, tab).then(result => result.data);
  }
  async function fixtureState() { return readFixture("JSON.parse(document.getElementById('evidence').textContent)"); }
  async function marker(id) {
    await call('read_page', { tab, full: true });
    const result = await readFixture(`(() => {
      const registry = window.__chromeBridge;
      if (!registry || registry.url !== location.href) return -1;
      return registry.markers.indexOf(document.getElementById(${JSON.stringify(id)}));
    })()`);
    if (!Number.isSafeInteger(result) || result < 1) throw failure('target_not_registered', id);
    return result;
  }

  try {
    // Dynamic imports are after isolation. No bridge stubs or alternative driver.
    api = await import('../src/index.js');
    bridge = await import('../src/bridge.js');
    tabs = await import('../src/tabs.js');
    stage = 'open';
    const opened = await call('open_tab', { url, why: 'user_asked' });
    const ownTab = opened.content?.filter(block => block.type === 'text').map(block => block.text).join('\n').match(/\btab=(\d+)\b/);
    if (ownTab) tab = Number(ownTab[1]);
    await ownRecord(); evidence.tab = tab;
    // Chrome may offer to translate this synthetic page. Close only
    // that exact benign browser prompt, before the recorded task begins.
    // Every other native prompt remains a refusal; no page guard is disabled.
    const current = await bridge.chromeInfo(tab);
    const dialog = await bridge.pageDialog();
    if (dialog.open) {
      evidence.preflight = { ownTabActive: current.tabActive === true, windowIndex: current.windowIndex,
        ownRoute: current.url === `${url}#/login`, dialogTitle: dialog.title,
        dialogButtons: dialog.buttons, hasField: dialog.hasField };
      if (current.tabActive !== true || current.windowIndex !== 1 || current.url !== `${url}#/login`
          || dialog.title !== '翻译此页？' || dialog.hasField || dialog.buttons?.length !== 2
          || !dialog.buttons.includes('翻译选项') || !dialog.buttons.includes('关闭')) throw failure('unexpected_native_prompt', 'preflight');
      await call('answer_dialog', { button: '关闭' });
      if ((await bridge.pageDialog()).open) throw failure('native_prompt_unresolved', 'preflight');
      evidence.preflight = { translationPromptClosed: true };
    }
    await call('task_plan', { task: 'Local routines: record and replay three clicks' }); plan = true;
    evidence.initial = await fixtureState(); assert.equal(evidence.initial.stage, 'login');
    const ids = ['login', 'catalogue', 'lesson'];
    const initialMarkers = [];
    for (const id of ids) {
      stage = `record_${id}`;
      const current = await marker(id); initialMarkers.push(current);
      await call('click', { tab, marker: current });
    }
    evidence.recorded = await fixtureState();
    assert.equal(evidence.recorded.stage, 'lesson'); assert.deepEqual(evidence.recorded.trustedByPhase, [3, 0]);
    assert.deepEqual(evidence.recorded.events[0].map(event => event.action), ids);
    assert.deepEqual(evidence.recorded.events[0].map(event => event.buttonIndex), [0, 0, 0]);
    assert.ok(evidence.recorded.events[0].every(event => event.trusted === true));
    stage = 'save';
    const history = structured(await call('routines', { action: 'history', site: origin, limit: 100 }));
    const clicks = history.events.filter(event => event.tab === tab && event.tool === 'click').sort((a, b) => a.seq - b.seq);
    assert.equal(clicks.length, 3); assert.ok(clicks.every(event => event.ok && event.replayable));
    assert.deepEqual(clicks.map(event => event.target.id), ids);
    const saved = structured(await call('routines', { action: 'save', name: 'Local three-click lesson', eventIds: clicks.map(event => event.id) }));
    assert.equal(saved.steps.length, 3); evidence.routine = { id: saved.id, steps: saved.steps.length };
    stage = 'reset';
    await call('click', { tab, marker: await marker('reset') });
    evidence.reset = await fixtureState(); assert.equal(evidence.reset.stage, 'login'); assert.equal(evidence.reset.resetTrusted, 1);
    const changedMarker = await marker('login'); assert.notEqual(changedMarker, initialMarkers[0]);
    evidence.markers = { initial: initialMarkers, resetLogin: changedMarker };
    stage = 'replay'; activeNonce = `routine-live-${randomUUID()}`;
    // This is the only replay request. No per-step model or script input calls.
    const run = structured(await call('routines', { action: 'run', id: saved.id, tab, params: {}, nonce: activeNonce }));
    evidence.run = run; activeNonce = null;
    assert.equal(run.status, 'completed'); assert.equal(run.completed, 3); assert.equal(run.total, 3);
    stage = 'verify';
    await call('read_page', { tab, full: true }); evidence.replayed = await fixtureState();
    assert.equal(evidence.replayed.stage, 'lesson'); assert.deepEqual(evidence.replayed.trustedByPhase, [3, 3]);
    assert.deepEqual(evidence.replayed.events[1].map(event => event.action), ids);
    assert.ok(evidence.replayed.events[1].every(event => event.trusted === true));
    assert.deepEqual(evidence.replayed.events[1].map(event => event.buttonIndex), [1, 1, 1]);
    assert.equal(evidence.replayed.untrustedClicks, 0); assert.equal(evidence.replayed.unrelatedTrusted, 0);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = { stage, code: typeof error?.code === 'string' ? error.code : 'fixture_assertion_failed' };
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    // Normal release only. Never re-take, remove ownership flags, or retry a click.
    if (api) {
      try { const end = await api.endTaskHold(); evidence.cleanup.inputReleased = end ? end.inputReleased === true : null; }
      catch { evidence.cleanup.inputReleased = false; }
      if (plan) {
        try { await call('task_plan', { done: true }, { cleanup: true }); evidence.cleanup.planEnded = true; }
        catch { evidence.cleanup.planEnded = false; }
      }
      if (tab == null && tabs) {
        // An open reply can fail after registration. Search only the fresh,
        // isolated registry, never adopt or close a tab from another session.
        try {
          const owned = (await tabs.allTabs()).filter(record => {
            try { const address = new URL(record.expectedUrl); return record.ownerPid === process.pid && address.origin === origin && address.pathname === '/routine.html'; }
            catch { return false; }
          });
          if (owned.length === 1) { tab = Number(owned[0].tabId); evidence.tab = tab; }
        } catch { evidence.cleanup.ownershipUnconfirmed = true; }
      }
      if (tab != null) {
        try {
          await ownRecord();
          await call('close_tab', { tab }, { cleanup: true });
          // Readback is filtered to our numeric tab; no other tab data is retained.
          const live = await bridge.listTabs();
          evidence.cleanup.tabAbsent = !live.windows.some(window => window.tabs.some(item => Number(item.id) === tab));
        } catch { evidence.cleanup.tabAbsent = false; evidence.cleanup.tabPreserved = true; }
      }
    }
    await new Promise(resolve => server.close(resolve));
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    evidence.finishedAt = new Date().toISOString();
    if (evidence.status === 'passed' && (evidence.cleanup.inputReleased === false || evidence.cleanup.planEnded !== true || evidence.cleanup.tabAbsent !== true)) {
      evidence.routineVerified = true; evidence.status = 'cleanup_unconfirmed'; process.exitCode = 1;
    }
    await writeFile(path.join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(`Routine live ${evidence.status}. Evidence: ${path.join(dir, 'evidence.json')}`);
  }
}
