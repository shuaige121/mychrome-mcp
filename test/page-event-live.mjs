#!/usr/bin/env node
/** Root-operated fixture server. No browser/host/input is opened by this file.
 * The root follows the printed MCP procedure in the user's actual terminal
 * Claude connection. A synthetic SDK client cannot establish model receipt.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_PROMPT_CATALOG } from '../src/page-events.js';
const HERE = fileURLToPath(import.meta.url), ROOT = path.resolve(path.dirname(HERE), '..');
export const ORIGIN = 'http://127.0.0.1:17744';
export const DELAY_MS = 4000;
const TEMPLATE = PAGE_PROMPT_CATALOG.templates.find(t => t.id === 'fixture-dom-inactivity');
const failure = code => Object.assign(new Error(code), { code });
export function parseOptions(argv) {
  const options = { run: false, check: false, operator: false, source: ROOT, sourceKind: 'candidate', seconds: 120 };
  let chosen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') options.run = true;
    else if (a === '--check') options.check = true;
    else if (a === '--root-operator') options.operator = true;
    else if (['--source', '--runtime', '--seconds'].includes(a)) {
      const v = argv[++i]; if (!v || v.startsWith('--')) throw failure('missing_option_value');
      if (a === '--seconds') options.seconds = Number(v);
      else { if (chosen) throw failure('choose_one_source'); chosen = true; options.source = path.resolve(v); options.sourceKind = a === '--runtime' ? 'installed' : 'candidate'; }
    } else throw failure('unknown_option');
  }
  if (options.run && (!options.operator || options.check)) throw failure('root_operator_required');
  if (!Number.isInteger(options.seconds) || options.seconds < 10 || options.seconds > 600) throw failure('bad_timeout');
  return options;
}
export function procedure(url = ORIGIN + '/fixture-<synthetic-id>', caseNonce = randomUUID()) {
  const ref = name => ({ $ref: name }); // Resolve from the named actual reply; never a guessed id/token.
  const call = (tool, args) => ({ tool, args });
  const step = (id, text, requiresEvidence = [], recordEvidence = [], invalidatesEvidence = [], calls = [], checks = []) =>
    ({ id, text, requiresEvidence, recordEvidence, invalidatesEvidence, calls, checks });
  const preparation = caseId => [
    step('fresh_task', 'In the same actual terminal Claude connection, start this NEW nonempty task once with the payload below. Never restart this case after interruption.',
      ['desktop_safe', 'actual_connection', 'case_policy_ready', 'input_released'], ['fresh_task'], ['input_released'],
      [call('task_plan', { task: `P44 ${caseId} ${caseNonce}` })]),
    step('fresh_document', 'Open this NEW inert document with open_tab({url: fixtureURL, why: "user_asked"}); bind opened_tab to its returned tab id. Existing-window tabs normally start in the background; opening does not establish visible-target readiness.',
      ['fresh_task'], ['fresh_document', 'opened_tab'], [], [call('open_tab', { url, why: 'user_asked' })]),
    step('read_arm_marker', 'Use read_page({tab: opened_tab}), then query "Start delayed prompt" to obtain the fresh arm_marker on that same document. Default headings may omit the button; full:true is an alternative. No read activates the tab. If the marker/document is unavailable, stop the case.',
      ['fresh_document', 'opened_tab'], ['fresh_arm_marker'], [],
      [call('read_page', { tab: ref('opened_tab') }), call('read_page', { tab: ref('opened_tab'), query: 'Start delayed prompt' })]),
    step('ordinary_arm_click', 'Once only, call click({tab: opened_tab, marker: arm_marker}). This ordinary authorized MCP action prepares/activates the exact tab through the existing Session path. The trusted arm changes visible content to "Armed: prompt appears in 4000 ms." immediately and schedules one delayed prompt. Do not retry an uncertain/refused click, use scripted input, selectTab or force-activation.',
      ['fresh_task', 'fresh_document', 'fresh_arm_marker'], ['arm_action_returned'], [],
      [call('click', { tab: ref('opened_tab'), marker: ref('arm_marker') })]),
    step('verify_preparation', 'Require a successful confirmed arm click on this fresh document, its Armed content delta, no interruption/unknown ownership, and read-only list_tabs({}) showing the SAME opened_tab as "▶ 屏幕上" in a non-minimized window. Label this visibility snapshot before_prompt, after_prompt or relative_time_unknown from the actual evidence; a late/unknown snapshot is NOT proof of pre-event visibility. Ordinary prepareActivate ran before the trusted arm; private auto performs its own fresh visibility/hold checks. No extra model/tool round must finish within 4000 ms: busy delivery may be collected later for this SAME fresh task/document/event. Background/minimized starts may prepare successfully or refuse safely; record the actual result. Failed, inactive, minimized or uncertain preparation STOPS this case, without restart/reacquire or reinterpretation/replay of an older event.',
      ['arm_action_returned', 'opened_tab'], ['preparation_confirmed', 'original_task_uninterrupted_public', 'target_on_screen', 'fresh_arm_confirmed'], [],
      [call('list_tabs', {})], [
        { fact: 'arm_click_confirmed', equals: true }, { fact: 'armed_content_seen', equals: true }, { fact: 'fresh_arm_document', equals: true },
        { fact: 'task_interrupted', equals: false }, { fact: 'hold_unknown', equals: false },
        { fact: 'listed_tab', sameAs: 'opened_tab' }, { fact: 'tab_on_screen', equals: true },
        { fact: 'window_minimized', equals: false },
        { fact: 'visibility_snapshot_timing', oneOf: ['before_prompt', 'after_prompt', 'relative_time_unknown'] }
      ])
  ];
  const observe = () => step('observe_new_event', 'Keep this original task alive and make no intervening input/GUI changes. Observe or collect the delayed event produced by THIS one-shot arm on the fresh document, including a notification that arrived while the model was busy. Record receipt time separately from observation/input time. An old document, earlier task or already-refused attempt cannot become a new auto case; never replay it. Retain bounded one-attempt evidence separately from the synthetic DOM result.',
    ['preparation_confirmed', 'original_task_uninterrupted_public', 'target_on_screen', 'fresh_arm_confirmed'], ['event_observed'], [], [],
    [{ fact: 'event_from_fresh_arm', equals: true }, { fact: 'event_matches_case_document', equals: true }]);
  const acknowledge = () => step('actual_route_ack', 'Record actual terminal idle and busy cases separately. In that original route, page_event_ack must use ALL THREE fields from the received event, exactly as in the payload bindings below. Persist only a token digest and bounded result. A next-tool fallback ACK does not establish Channel/model ACK.',
    ['event_observed'], ['route_ack_evidence'], [], [call('page_event_ack', {
      event_id: ref('received.event_id'), task_generation: ref('received.task_generation'), delivery_token: ref('received.delivery_token')
    })], [{ fact: 'ack_current_route_accepted', equals: true }]);
  const release = () => [
    step('end_task', 'End this fixture task in its original connection with task_plan({done:true}). This is release, not evidence of successful acceptance. On a failed preparation, jump directly to this safe release; never repeat task_plan with a new task to resume the case.',
      ['fresh_task'], ['release_requested'], [], [call('task_plan', { done: true })]),
    step('verify_release', 'Require the returned input-release confirmation before touching GUI settings. If release is unconfirmed, retain the blocker; do not proceed to cleanup. Stop, Pause, handoff or a pending question never implies permission to resume.',
      ['release_requested'], ['input_released'], [], [], [{ fact: 'input_release_confirmed', equals: true }])
  ];
  return {
    payloadBindings: 'calls[].args contains $ref placeholders only for values received in this case; substitute them before invoking the named public tool. Never send $ref objects as MCP arguments.',
    shared: [
      step('desktop_and_worker', 'Verify unlocked desktop and intended candidate/installed worker. Keep real global Pause, Stop and the shared input lock authoritative.', [], ['desktop_safe']),
      step('actual_terminal_connection', "Use the user's actual terminal Claude Code MCP connection. Inspect its first server initialize capability and explicitly approve Channel trust only if requested; never rewrite configuration or auto-accept trust.", [], ['actual_connection'])
    ],
    cases: [
      { id: 'notify_only', steps: [
        step('released_before_setup', 'Verify any prior task has safely released input before GUI setup.', [], ['input_released']),
        step('notify_policy', 'Before this fresh case, use the existing GUI to select Notify AI (notify_ai). Only the ordinary preparation click occurs; no automatic prompt choice is authorized.', ['input_released'], ['case_policy_ready']),
        ...preparation('notify'), observe(), acknowledge(), ...release()
      ] },
      { id: 'auto', steps: [
        step('released_before_setup', 'Verify any prior task has safely released input before GUI setup.', [], ['input_released']),
        step('create_save_disabled_rule', 'Create and SAVE the exact fixture origin/template/Keep-or-Exit rule in the existing GUI; newly saved rules are disabled.', ['input_released'], ['saved_exact_rule']),
        step('deliberately_enable_rule', 'Deliberately ENABLE that saved exact fixture rule in the GUI.', ['input_released', 'saved_exact_rule'], ['enabled_exact_rule']),
        step('select_auto_safe', 'Select auto_safe BEFORE this fresh fixture task/document/event.', ['input_released', 'enabled_exact_rule'], ['case_policy_ready']),
        ...preparation('auto'), observe(),
        step('one_attempt_receipt', 'Record the one-attempt auto receipt and synthetic DOM result separately. Original healthy hold/Session/epoch/target continuity is enforced internally by the unchanged auto guards; do not claim independently observed raw identities from public replies. A click receipt does not prove any real-site session outcome.',
          ['event_observed', 'original_task_uninterrupted_public', 'target_on_screen'], ['auto_attempt_evidence']),
        acknowledge(), ...release(),
        step('gui_cleanup_after_release', 'Only AFTER verified safe input release, remove the temporary rule and restore the prior policy through the GUI.', ['input_released', 'saved_exact_rule'], ['cleanup_recorded'])
      ] }
    ],
    limitations: [
      'Public success/Armed delta and list_tabs on-screen status provide preparation evidence; public tools do not expose raw hold/Session/epoch identity. Internal same-hold checks are not independent live observations. If root has no separate read-only evidence for a stronger claim, leave that claim unverified.',
      'The 4000 ms delay is measured from trusted arm, not load or model receipt. A busy model may receive/ACK the same fresh event later. Post-event or unknown-time list_tabs snapshots do not independently prove pre-event visibility; the private auto guards remain authoritative for input-time checks. An expired/rejected ACK or interrupted/unknown hold is a stopped/unverified case, never a reason to restart or replay.',
      'Candidate and installed evidence are separate; actual host loading, idle/busy ACK and physical input remain pending until root records them.',
      'Native catalog labels are offline synthetic AX values. This DOM fixture does not establish native Chrome exact-template auto support; native live remains pending until actual Chrome output is reviewed.'
    ]
  };
}

export function fixtureHTML(token) {
  assert.match(token, /^[a-f0-9-]{36}$/); assert.ok(TEMPLATE.origins.includes(ORIGIN)); assert.ok(DELAY_MS > 3000);
  return `<!doctype html><meta charset="utf-8"><title>MyChrome page event fixture</title>
<meta name="fixture-token" content="${token}"><style>body{font:18px system-ui;padding:48px}#prompt{position:fixed;left:120px;top:120px;background:white;border:2px solid #333;padding:24px;z-index:10}button{padding:12px;margin:8px}</style>
<h1>Local DOM acceptance fixture</h1><p>A trusted click starts the four-second delay. Use the original MCP task and real Pause/Stop.</p><button id="arm">Start delayed prompt</button><p id="result" role="status">Not armed. No prompt is scheduled.</p>
<script>let armed=false,chosen=false;const arm=document.getElementById('arm');arm.onclick=e=>{if(!e.isTrusted||armed)return;
armed=true;arm.disabled=true;const armedAt=performance.now();document.getElementById('result').textContent='Armed: prompt appears in ${DELAY_MS} ms.';
setTimeout(()=>{const shownAfterMs=Math.round(performance.now()-armedAt);const d=document.createElement('div');d.id='prompt';d.role='dialog';d.setAttribute('aria-modal','true');
const h=document.createElement('h2');h.textContent=${JSON.stringify(TEMPLATE.title)};d.append(h);
for(const text of ${JSON.stringify(TEMPLATE.texts)}){const p=document.createElement('p');p.textContent=text;d.append(p)}
for(const [i,label] of ${JSON.stringify(TEMPLATE.buttons)}.entries()){const b=document.createElement('button');b.textContent=label;b.onclick=e=>{if(!e.isTrusted||chosen)return;chosen=true;document.getElementById('result').textContent='Synthetic choice: '+(i===0?'keep':'exit');d.remove();fetch('/receipt-${token}',{method:'POST',body:JSON.stringify({shownAfterMs,choice:i===0?'keep':'exit'})}).catch(()=>{})};d.append(b)}
document.body.append(d);document.getElementById('result').textContent='Prompt visible.';},${DELAY_MS});};</script>`;
}
export async function startFixture({ token = randomUUID(), listen = (server, done) => server.listen(17744, '127.0.0.1', done) } = {}) {
  const html = fixtureHTML(token), receipts = [];
  const server = createServer((req, res) => {
    if (req.headers.host !== '127.0.0.1:17744') { res.writeHead(421).end(); return; }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'GET' && req.url === `/fixture-${token}`) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (req.method === 'POST' && req.url === `/receipt-${token}`) {
      let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 512) req.destroy(); });
      req.on('end', () => { try { const r = JSON.parse(body);
        if (!['keep', 'exit'].includes(r.choice) || !Number.isInteger(r.shownAfterMs) || r.shownAfterMs < DELAY_MS || r.shownAfterMs > 600000 || Object.keys(r).length !== 2) throw failure('bad_receipt');
        if (receipts.length < 8) receipts.push({ choice: r.choice, shownAfterMs: r.shownAfterMs });
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); } }); return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', error => reject(failure(error.code === 'EADDRINUSE' ? 'fixture_port_in_use' : 'fixture_listen_failed'))); listen(server, resolve); });
  return { server, url: `${ORIGIN}/fixture-${token}`, receipts, close: () => new Promise(resolve => server.close(resolve)) };
}
export async function readiness(source) {
  const files = ['src/index.js', 'src/guard.js', 'src/bridge.js', 'src/page-events.js', 'src/page-event-host.js', 'src/page-prompt-templates.json', 'src/page/prompt-observation.js'];
  const hashes = {};
  for (const file of files) hashes[file] = createHash('sha256').update(await fs.readFile(path.join(source, file))).digest('hex');
  return { hashes, procedureOnly: true, channelLoaded: 'unverified', modelReceipt: 'unverified', nativeExactTemplateLive: 'pending_reviewed_chrome_template' };
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv), ready = await readiness(options.source);
  if (!options.run) {
    console.log(JSON.stringify({ mode: options.check ? 'check' : 'usage', uiEffects: false, hostEffects: false, nativeInput: false,
      origin: ORIGIN, delayMs: DELAY_MS, sourceKind: options.sourceKind, ...ready, procedure: procedure(),
      usage: 'node test/page-event-live.mjs --run --root-operator --source /candidate --seconds 120' }, null, 2)); return;
  }
  if (process.env.CGEVENT_DRYRUN || process.env.CHROME_BRIDGE_LOCK || process.env.CHROME_BRIDGE_SETTINGS) throw failure('unsafe_inherited_live_environment');
  const fixture = await startFixture();
  console.log(JSON.stringify({ mode: 'fixture_server', url: fixture.url, sourceKind: options.sourceKind, ...ready, procedure: procedure(fixture.url) }, null, 2));
  await new Promise(resolve => { const timer = setTimeout(resolve, options.seconds * 1000);
    const stop = () => { clearTimeout(timer); resolve(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
    fixture.server.once('close', stop); });
  await fixture.close();
  console.log(JSON.stringify({ mode: 'fixture_closed', sourceKind: options.sourceKind, syntheticDOMReceipts: fixture.receipts,
    hostIdleACK: 'pending_root_evidence', hostBusyACK: 'pending_root_evidence', installedAcceptance: 'pending_root_evidence', physicalInput: 'unobserved' }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === HERE) await main();
