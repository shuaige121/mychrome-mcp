#!/usr/bin/env node
/** Opt-in real input, never part of npm test. Prepare/check without opening UI:
 *   node --check test/routine-input-live.mjs
 * Run only when authorized and the current production helpers are built:
 *   node test/routine-input-live.mjs --run
 * All input uses callTool. Page evaluation only reads this owned local fixture.
 * Settings/registry/history are isolated; the physical input lock stays shared.
 * Paste uses the production clipboard restoration path; this script never reads
 * or writes the user's clipboard directly, and retains no input body in evidence.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.log('Opt-in real input: node test/routine-input-live.mjs --run');
  process.exitCode = process.argv.length > 2 ? 2 : 0;
} else {
  await main();
}

async function main() {
  if (process.env.CGEVENT_DRYRUN === '1') throw new Error('Refuse a dry-run environment for the real-input fixture.');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mychrome-routine-input-live-'));
  // Do not set CHROME_BRIDGE_LOCK: all agents must share the physical input lock.
  Object.assign(process.env, {
    CHROME_BRIDGE_SETTINGS: path.join(dir, 'settings.json'),
    CHROME_BRIDGE_ACTIVITY: path.join(dir, 'activity.jsonl'),
    CHROME_BRIDGE_ROUTINES_DIR: path.join(dir, 'routines'),
    CHROME_BRIDGE_TAB_DIR: path.join(dir, 'tabs'),
    CHROME_BRIDGE_AGENT_STATE: path.join(dir, 'agent-window.json'),
    CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_ROUTINE_RECORDING: '1',
    CHROME_BRIDGE_AGENT_NAME: 'Local routine input fixture', CHROME_BRIDGE_AGENT_DISPLAY: 'main',
    CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_SWEEP: '0', CHROME_BRIDGE_HOTSWAP: '0',
    CHROME_BRIDGE_TAKEOVER: '1', CHROME_BRIDGE_WARM: '0',
  });
  for (const name of ['CODEX_THREAD_ID', 'MYCHROME_VISIBLE_THREAD_ID', 'MYCHROME_VISIBLE_SOCKET',
    'CHROME_BRIDGE_LAUNCHER_PID', 'CHROME_BRIDGE_CLIENT_PID', 'CHROME_BRIDGE_CARRY',
    'CHROME_BRIDGE_DEBUG_LOG', 'CHROME_BRIDGE_INPUT_MODE', 'CHROME_BRIDGE_INPUT_SPEED']) delete process.env[name];
  await writeFile(process.env.CHROME_BRIDGE_SETTINGS, JSON.stringify({ inputMode: 'keys', inputSpeed: 1,
    agentDisplay: 'main', activityLog: false, notify: false }), { mode: 0o600 });

  const html = await readFile(new URL('./fixtures/routine-input.html', import.meta.url));
  const route = '/routine-input.html';
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== route) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.end(html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}${route}`;
  const evidence = { fixture: 'routine-input-live-v1', startedAt: new Date().toISOString(), directory: dir,
    origin, sharedInputLock: true, status: 'running', toolCalls: [], cleanup: {} };
  const sampleText = 'qzx', longText = 'abcdef'.repeat(100), pasteText = '本地流程中文输入验证';
  let api, bridge, tabs, settings, tab = null, plan = false, activeNonce = null, stage = 'setup';
  const abort = new AbortController();
  const fail = (code, operation) => Object.assign(new Error(operation), { code });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const terminal = result => ['completed', 'cancelled', 'blocked', 'failed'].includes(result?.status);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true; abort.abort();
    if (activeNonce && api) void api.callTool({ params: { name: 'routines', arguments: { action: 'stop', nonce: activeNonce } } }).catch(() => {});
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const deadline = setTimeout(stop, 180_000); deadline.unref();
  async function call(name, args = {}, { cleanup = false } = {}) {
    if (abort.signal.aborted && !cleanup) throw fail('cancelled', name);
    const at = Date.now();
    const result = await api.callTool({ params: { name, arguments: args } }, cleanup ? undefined : { signal: abort.signal });
    evidence.toolCalls.push({ tool: name, action: name === 'routines' ? args.action : undefined,
      ok: result?.isError !== true, at: new Date(at).toISOString(), ms: Date.now() - at });
    if (!result || result.isError) {
      // Type replies may contain text. Keep only the product's error code.
      const code = result?.structuredContent?.error?.code;
      evidence.toolFailure = { tool: name, code: /^[a-z_]{1,80}$/.test(code ?? '') ? code : 'tool_failed' };
      throw fail(evidence.toolFailure.code, name);
    }
    return result;
  }
  function structured(result) {
    const value = result?.structuredContent?.result;
    if (value === undefined) throw fail('missing_structured_result', 'routines');
    return value;
  }
  async function ownRecord() {
    if (!Number.isSafeInteger(tab) || tab <= 0) throw fail('missing_owned_tab', 'ownership');
    const record = await tabs.readTabRecord(tab);
    let address;
    try { address = new URL(record?.expectedUrl); } catch {}
    if (!record || record.ownerPid !== process.pid || address?.origin !== origin || address.pathname !== route) throw fail('ownership_changed', 'ownership');
    return record;
  }
  async function readFixture(expression) {
    await ownRecord();
    return bridge.evalInPage(`(() => {
      if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== ${JSON.stringify(route)} ||
          location.search || location.hash || document.querySelector('meta[name="mychrome-fixture"]')?.content !== 'routine-input-live-v1')
        return JSON.stringify({ok:false,error:'fixture_mismatch'});
      return JSON.stringify({ok:true,data:(${expression})});
    })()`, tab).then(result => result.data);
  }
  async function sample(expected) {
    return readFixture(`(() => {
      const field = document.getElementById('fixture-input');
      return { state: JSON.parse(document.getElementById('evidence').textContent), valueLength: field.value.length,
        valueMatches: field.value === ${JSON.stringify(expected)}, prefixMatches: ${JSON.stringify(expected)}.startsWith(field.value) };
    })()`);
  }
  async function marker(id) {
    await call('read_page', { tab, full: true });
    const result = await readFixture(`(() => {
      const registry = window.__chromeBridge;
      return registry?.url === location.href ? registry.markers.indexOf(document.getElementById(${JSON.stringify(id)})) : -1;
    })()`);
    if (!Number.isSafeInteger(result) || result < 1) throw fail('target_not_registered', id);
    return result;
  }
  function paired(state) {
    const c = state.counts;
    assert.ok(c.keydown > 0); assert.equal(c.keydown, c.keyup);
    for (const key of ['heldKeys', 'unmatchedUp', 'duplicateDown', 'repeats', 'untrusted', 'wrongTarget']) assert.equal(c[key], 0, key);
  }
  async function balancedSample(expected) {
    const until = Date.now() + 2000;
    do {
      const result = await sample(expected), c = result.state.counts;
      if (c.keydown > 0 && c.keydown === c.keyup && c.heldKeys === 0) return result;
      await delay(50);
    } while (Date.now() < until);
    throw fail('key_release_unconfirmed', 'browser_events');
  }
  async function waitTerminal(nonce, { cleanup = false, timeoutMs = 30_000 } = {}) {
    const until = Date.now() + timeoutMs;
    do {
      const state = structured(await call('routines', { action: 'status', nonce }, { cleanup }));
      if (terminal(state)) return state;
      await delay(100);
    } while (Date.now() < until);
    throw fail('routine_terminal_timeout', 'status');
  }
  async function endPlan() {
    if (!plan) return;
    await call('task_plan', { done: true }); plan = false;
  }
  async function newPlan(task) {
    await call('task_plan', { task }); plan = true;
  }
  async function reset(phase) {
    await call('click', { tab, marker: await marker('fixture-reset') });
    const state = await sample('');
    assert.equal(state.valueLength, 0); assert.equal(state.valueMatches, true);
    assert.equal(state.state.phase, phase); assert.equal(state.state.resetTrusted, phase);
    assert.equal(state.state.resetRefused, 0); assert.equal(state.state.counts.untrusted, 0);
    return state;
  }

  try {
    api = await import('../src/index.js');
    bridge = await import('../src/bridge.js');
    tabs = await import('../src/tabs.js');
    settings = await import('../src/settings.js');
    assert.equal(settings.settingsPath(), path.join(dir, 'settings.json'));
    assert.deepEqual(settings.setting('inputMode'), { value: 'keys', source: 'file' });
    stage = 'open';
    const opened = await call('open_tab', { url, why: 'user_asked' });
    const match = opened.content?.filter(block => block.type === 'text').map(block => block.text).join('\n').match(/\btab=(\d+)\b/);
    if (match) tab = Number(match[1]);
    await ownRecord(); evidence.tab = tab;
    // A Chinese fixture normally has no translation prompt. Handle only this
    // exact benign prompt on this active owned page; any other prompt stops.
    const current = await bridge.chromeInfo(tab), dialog = await bridge.pageDialog();
    if (dialog.open) {
      if (current.tabActive !== true || current.windowIndex !== 1 || current.url !== url
          || dialog.title !== '翻译此页？' || dialog.hasField || dialog.buttons?.length !== 2
          || !dialog.buttons.includes('翻译选项') || !dialog.buttons.includes('关闭')) throw fail('unexpected_native_prompt', 'preflight');
      await call('answer_dialog', { button: '关闭' });
      if ((await bridge.pageDialog()).open) throw fail('native_prompt_unresolved', 'preflight');
      evidence.preflight = { translationPromptClosed: true };
    }
    await newPlan('本地输入流程：录制与中途停止');
    evidence.initial = await sample(''); assert.equal(evidence.initial.valueLength, 0);
    stage = 'record_type';
    await call('type_text', { tab, marker: await marker('fixture-input'), text: sampleText, input_mode: 'keys', submit: false });
    evidence.recorded = await balancedSample(sampleText);
    assert.equal(evidence.recorded.valueMatches, true); paired(evidence.recorded.state);
    assert.equal(evidence.recorded.state.counts.paste, 0);
    stage = 'save';
    const history = structured(await call('routines', { action: 'history', site: origin, limit: 100 }));
    const inputs = history.events.filter(event => event.tab === tab && event.tool === 'type_text');
    assert.equal(inputs.length, 1); assert.equal(inputs[0].ok, true); assert.equal(inputs[0].replayable, true);
    assert.equal(inputs[0].target.id, 'fixture-input');
    const saved = structured(await call('routines', { action: 'save', name: '本地单步输入验证', eventIds: [inputs[0].id] }));
    assert.equal(saved.steps.length, 1); assert.equal(saved.steps[0].tool, 'type_text');
    assert.equal(saved.steps[0].args.input_mode, 'keys'); assert.equal(saved.parameters.length, 1);
    const parameter = saved.steps[0].args.textParam;
    assert.equal(saved.parameters[0].name, parameter);
    evidence.routine = { id: saved.id, steps: 1, recordedMode: 'keys' };
    stage = 'reset_for_cancel'; evidence.cancelReset = await reset(1);
    stage = 'start_long_type'; activeNonce = `routine-input-stop-${randomUUID()}`;
    const startedAt = Date.now();
    evidence.cancelStart = structured(await call('routines', { action: 'start', id: saved.id, tab,
      params: { [parameter]: longText }, nonce: activeNonce }));
    assert.equal(evidence.cancelStart.status, 'running');
    // Read-only wait for actual input: page inspection, field click and first-key
    // delay can take longer than 500 ms. Never retry or synthesize an event.
    const firstInputDeadline = Date.now() + 30_000;
    let firstInput;
    while (Date.now() < firstInputDeadline) {
      firstInput = await sample(longText);
      if (firstInput.valueLength > 0 && firstInput.state.counts.input > 0) break;
      const state = structured(await call('routines', { action: 'status', nonce: activeNonce }));
      if (terminal(state)) throw fail('run_ended_before_input', 'start');
      if (abort.signal.aborted) throw fail('cancelled', 'first_input');
      await delay(75);
    }
    if (!(firstInput?.valueLength > 0 && firstInput.state.counts.input > 0)) throw fail('first_input_timeout', 'start');
    const firstObservedAt = Date.now();
    await delay(500);
    const stopAt = Date.now();
    const stopReply = structured(await call('routines', { action: 'stop', nonce: activeNonce }));
    evidence.cancelTiming = { startToFirstObservedMs: firstObservedAt - startedAt,
      firstObservedToStopMs: stopAt - firstObservedAt, stopReplyMs: Date.now() - stopAt, requestedLength: longText.length };
    assert.ok(evidence.cancelTiming.firstObservedToStopMs >= 300 && evidence.cancelTiming.firstObservedToStopMs <= 700);
    assert.equal(stopReply.nonce, activeNonce);
    stage = 'verify_cancel';
    const cancelled = await waitTerminal(activeNonce);
    evidence.cancelRun = cancelled;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.total, 1); assert.equal(cancelled.completed, 0);
    const repeated = structured(await call('routines', { action: 'status', nonce: activeNonce }));
    assert.equal(repeated.runId, cancelled.runId); assert.equal(repeated.status, 'cancelled');
    activeNonce = null;
    evidence.cancelled = await balancedSample(longText);
    assert.ok(evidence.cancelled.valueLength > 0 && evidence.cancelled.valueLength < longText.length);
    assert.equal(evidence.cancelled.prefixMatches, true); paired(evidence.cancelled.state);
    assert.equal(evidence.cancelled.state.counts.paste, 0);
    await delay(300);
    const settled = await sample(longText);
    assert.equal(settled.valueLength, evidence.cancelled.valueLength);
    assert.deepEqual(settled.state.counts, evidence.cancelled.state.counts);
    evidence.cancelInputStable = true;

    // A cancelled run interrupts its enclosing plan. End it before this
    // independent reset and paste case; never silently re-arm the stopped run.
    stage = 'reset_for_paste'; await endPlan();
    await newPlan('本地输入流程：验证当前粘贴设置');
    evidence.pasteReset = await reset(2);
    assert.equal(settings.settingsPath(), path.join(dir, 'settings.json'));
    settings.writeSettings({ inputMode: 'paste', inputSpeed: 1 });
    assert.deepEqual(settings.setting('inputMode'), { value: 'paste', source: 'file' });
    assert.equal(settings.get('inputSpeed'), 1);
    evidence.pastePreference = { source: 'isolated_settings_file', mode: 'paste', speed: 1, recordedFallback: 'keys' };
    stage = 'run_paste'; activeNonce = `routine-input-paste-${randomUUID()}`;
    const pasted = structured(await call('routines', { action: 'run', id: saved.id, tab,
      params: { [parameter]: pasteText }, nonce: activeNonce }));
    evidence.pasteRun = pasted;
    assert.equal(pasted.status, 'completed'); assert.equal(pasted.completed, 1); assert.equal(pasted.total, 1);
    activeNonce = null;
    stage = 'verify_paste'; evidence.pasted = await balancedSample(pasteText);
    assert.equal(evidence.pasted.valueMatches, true); assert.equal(evidence.pasted.valueLength, pasteText.length);
    assert.equal(evidence.pasted.state.counts.paste, 1);
    assert.ok(evidence.pasted.state.counts.input > 0); assert.ok(evidence.pasted.state.counts.pasteInput > 0);
    paired(evidence.pasted.state);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = { stage, code: /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'fixture_assertion_failed' };
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    if (api) {
      if (activeNonce) {
        try {
          await call('routines', { action: 'stop', nonce: activeNonce }, { cleanup: true });
          const stopped = await waitTerminal(activeNonce, { cleanup: true });
          evidence.cleanup.runStatus = stopped.status; evidence.cleanup.runTerminal = true; activeNonce = null;
        } catch { evidence.cleanup.runTerminal = false; }
      }
      try { const end = await api.endTaskHold(); evidence.cleanup.inputReleased = end ? end.inputReleased === true : null; }
      catch { evidence.cleanup.inputReleased = false; }
      if (plan) {
        try { await call('task_plan', { done: true }, { cleanup: true }); evidence.cleanup.planEnded = true; }
        catch { evidence.cleanup.planEnded = false; }
      }
      if (tab == null && tabs) {
        try {
          const owned = (await tabs.allTabs()).filter(record => {
            try { const address = new URL(record.expectedUrl); return record.ownerPid === process.pid && address.origin === origin && address.pathname === route; }
            catch { return false; }
          });
          if (owned.length === 1) { tab = Number(owned[0].tabId); evidence.tab = tab; }
        } catch { evidence.cleanup.ownershipUnconfirmed = true; }
      }
      if (tab != null && !activeNonce) {
        try {
          await ownRecord(); await call('close_tab', { tab }, { cleanup: true });
          const live = await bridge.listTabs();
          evidence.cleanup.tabAbsent = !live.windows.some(window => window.tabs.some(item => Number(item.id) === tab));
        } catch { evidence.cleanup.tabAbsent = false; evidence.cleanup.tabPreserved = true; }
      } else if (tab != null) evidence.cleanup.tabPreserved = true;
    }
    await new Promise(resolve => server.close(resolve));
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    evidence.finishedAt = new Date().toISOString();
    if (evidence.status === 'passed' && (evidence.cleanup.inputReleased === false || evidence.cleanup.planEnded !== true || evidence.cleanup.tabAbsent !== true)) {
      evidence.inputVerified = true; evidence.status = 'cleanup_unconfirmed'; process.exitCode = 1;
    }
    // Reject an accidental input-body leak in the retained synthetic evidence.
    const serialized = JSON.stringify(evidence, null, 2) + '\n';
    if ([sampleText, longText, pasteText].some(text => serialized.includes(text))) throw fail('evidence_contains_input', 'evidence');
    await writeFile(path.join(dir, 'evidence.json'), serialized, { mode: 0o600 });
    console.log(`Routine input live ${evidence.status}. Evidence: ${path.join(dir, 'evidence.json')}`);
  }
}
