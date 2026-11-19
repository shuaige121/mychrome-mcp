#!/usr/bin/env node
// Entirely offline: no product imports, worker starts, browser or native input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as scrollHelpers from './reliability-reset-live.mjs';
import { CASES, LEGACY, EXCLUDED, parseOptions, fixtureHTML, workerEnvironment,
  staticSafetyCheck, installPartialCreateFault, cleanupDecision, handoffEvidence, mcpReplyBoundary, executeCase, createHoldFence, stopWorkerResources, cleanupFixtures } from './reliability-reset-live.mjs';
import { refuseUnsafeLegacy } from './live-guard.mjs';
import { productErrorFact, rpcFailureFact } from './harness-terminal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH = { healthyHold: true, sameHold: true, lease: { owned: true, sameToken: true }, heldKeys: [], scene: { appPid: 1, chromeWindow: 2, chromeTab: 3 } };
let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log(`ok ${name}`); };
await test('explicit run and root operator are both required', () => {
  assert.equal(parseOptions([]).run, false);
  assert.equal(parseOptions(['--check']).run, false);
  assert.throws(() => parseOptions(['--run']), /root_operator_required/);
  assert.throws(() => parseOptions(['--run', '--check', '--root-operator']), /root_operator_required/);
  assert.throws(() => parseOptions(['--legacy']), /unknown_option/);
  assert.throws(() => parseOptions(['--source', '/a', '--runtime', '/b']), /choose_one_source/);
  assert.equal(parseOptions(['--run', '--root-operator', '--runtime', '/fixture', '--case', 'partial-create']).sourceKind, 'runtime');
});

await test('default and --check execute without importing product or worker modules', async () => {
  const source = await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8');
  assert.ok(!/^import .*src\//m.test(source));
  assert.ok(source.includes('if (!options.run)'));
  for (const args of [[], ['--check']]) {
    const r = spawnSync(process.execPath, ['test/reliability-reset-live.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, HOME: '/nonexistent-reliability-harness-home' } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout); assert.equal(out.nativeInput, false); assert.deepEqual(out.cases, CASES);
  }
});

await test('known legacy entries refuse before every import/effect, with no override', async () => {
  const guard = await fs.readFile(path.join(root, 'test/live-guard.mjs'), 'utf8');
  assert.ok(!/^import .*bridge/m.test(guard));
  assert.ok(guard.includes('export async function requireUnlocked()'));
  for (const name of LEGACY) {
    const source = await fs.readFile(path.join(root, 'test', name), 'utf8');
    const imports = source.match(/^import .+$/gm);
    assert.equal(imports?.length, 1, name);
    assert.match(imports[0], /refuseUnsafeLegacy.*live-guard/);
    const body = source.replace(/^#!.*\n/, '').replace(/^import .+\n/m, '');
    assert.ok(body.trimStart().startsWith(`refuseUnsafeLegacy('${name}');`));
    // Run only an inert fake prefix, never an old script or a product import.
    // The sentinel represents every later import/server/native call.
    const firstStatement = body.slice(0, body.indexOf(';') + 1);
    const context = vm.createContext({ refuseUnsafeLegacy, effects: [] });
    assert.throws(() => vm.runInContext(`${firstStatement}\neffects.push('later import/effect')`, context),
      e => e.code === 'unsafe_legacy_live' && e.inputDelivery === 'not_sent', name);
    assert.equal(context.effects.length, 0, name);
    assert.ok(!/--legacy|allowLegacy|unsafeOverride/.test(source));
  }
});

await test('mutation allowlist rejects old OCR and each direct visible native write', async () => {
  const source = await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8');
  assert.deepEqual(staticSafetyCheck(source), []);
  const oldOCR = await fs.readFile(path.join(root, 'test/round7-ocr-live.mjs'), 'utf8');
  assert.ok(staticSafetyCheck(oldOCR).includes('direct_bridge:newWindow'));
  for (const method of ['newWindow', 'openTab', 'closeTab', 'selectTab', 'answerDialog', 'restoreScene', 'restoreApp', 'moveWindow', 'activateChrome']) {
    assert.ok(staticSafetyCheck(`await B.${method}(1)`).length > 0, method);
  }
  for (const code of ["B['newWindow']('x')", "B.cgevent(['click', 1, 2])", "spawn('osascript', [])", "session.request({ op: 'key' })"]) {
    assert.ok(staticSafetyCheck(code).length > 0, code);
  }
  assert.deepEqual(staticSafetyCheck("await B.cgevent(['idle']); await B.snapshotScene();"), []);
  assert.equal(EXCLUDED.length, 3);
});

await test('worker strips settings/session overrides and keeps the physical lock shared', () => {
  const env = workerEnvironment({ HOME: '/home/example', PATH: '/bin', CHROME_BRIDGE_LOCK: '/isolated', CHROME_BRIDGE_SETTINGS: '/isolated-settings',
    CODEX_THREAD_ID: 'private-thread', CHROME_BRIDGE_DEBUG_LOG: '/private/log', CGEVENT_DRYRUN: '1', NODE_OPTIONS: '--require bad' },
  '/synthetic/worker', '/candidate', 'nonce', 'input');
  for (const k of ['CHROME_BRIDGE_LOCK', 'CHROME_BRIDGE_SETTINGS', 'CODEX_THREAD_ID', 'CHROME_BRIDGE_DEBUG_LOG', 'CGEVENT_DRYRUN', 'NODE_OPTIONS']) assert.equal(env[k], undefined);
  assert.equal(env.HOME, '/home/example');
  assert.equal(env.CHROME_BRIDGE_SWEEP, '0'); assert.equal(env.CHROME_BRIDGE_HOTSWAP, '0');
  assert.equal(env.CHROME_BRIDGE_AGENT_STATE, '/synthetic/worker/agent-window.json');
  assert.equal(env.CHROME_BRIDGE_TAB_DIR, '/synthetic/worker/tabs');
  assert.equal(env.CHROME_BRIDGE_ROUTINE_RECORDING, '0');
  assert.equal(env.CHROME_BRIDGE_AGENT_DISPLAY, 'away');
});

await test('inline fixture counts only actual dispatched events and contains no auto-dialog/auto-click', () => {
  const html = fixtureHTML('test-token');
  assert.match(html, /fixture-token/); assert.match(html, /e\.isTrusted/);
  assert.ok(!/dispatchEvent|\.click\(|\.focus\(|scrollIntoView/.test(html));
  assert.match(html, /onclick=.*prompt\(/); assert.match(html, /heldKeys=keys\.size/);
  assert.throws(() => fixtureHTML('</script>'));
});

await test('partial-create delegates once, withholds identity, and cannot replay', async () => {
  let replacement, sends = 0;
  const api = { __setBridgeForTests: x => { replacement = x.newWindow; } };
  const retained = { attempts: 0, created: null };
  installPartialCreateFault(api, { newWindow: async () => { sends++; return { tabId: 7, windowId: 9, chromePid: 10, cgWindow: 11 }; } }, retained);
  await assert.rejects(replacement('fixture'), e => {
    assert.equal(e.creationAttempted, true); assert.equal(e.inputDelivery, 'unknown');
    assert.equal(e.stage, 'new_window_response'); assert.equal(e.noRetry, true);
    assert.equal(e.tabId, undefined); assert.equal(e.createdWindowId, undefined); return true;
  });
  assert.equal(sends, 1); assert.equal(retained.created.tabId, 7);
  await assert.rejects(replacement('fixture'), /fault_duplicate_creation_refused/);
  assert.equal(sends, 1);
  const failed = { attempts: 0, created: null };
  installPartialCreateFault(api, { newWindow: async () => { throw Object.assign(Error('native_refused'), { inputDelivery: 'not_sent' }); } }, failed);
  await assert.rejects(replacement('fixture'), /native_refused/); assert.equal(failed.created, null);
});

await test('cleanup refuses Stop, Abort, lock-screen, handoff, partial creation and uncertain ownership', () => {
  const safe = { exact: true, closable: true };
  for (const terminal of ['operator_abort', 'native_interruption', 'screen_locked_or_unreadable', 'harness_timeout']) {
    assert.equal(cleanupDecision({ terminal }, safe).close, false);
  }
  assert.equal(cleanupDecision({ handoff: true }, safe).close, false);
  assert.equal(cleanupDecision({ partial: true }, safe).close, false);
  assert.equal(cleanupDecision({}, null).close, false);
  assert.equal(cleanupDecision({}, { exact: true, closable: false }).close, false);
  assert.equal(cleanupDecision({}, safe).close, false);
  assert.equal(cleanupDecision({}, safe, HEALTH).close, true);
  for (const health of [{ ...HEALTH, healthyHold: false }, { ...HEALTH, sameHold: false }, { ...HEALTH, lease: { owned: true, sameToken: false } }])
    assert.equal(cleanupDecision({}, safe, health).close, false);
});

await test('handoff setup failure cannot masquerade as a successful released wait', () => {
  const reply = { content: [{ type: 'text', text: '用户还没在 [2] 输入完。本次观察已结束，这不代表收到继续授权。' }] };
  const setup = { fieldFocused: true, askVisible: true, selectedTab: 7 };
  assert.deepEqual(handoffEvidence(reply, setup), { setupObserved: true, expectedReply: true });
  assert.equal(handoffEvidence({ ...reply, isError: true }, setup).expectedReply, false);
  assert.equal(handoffEvidence(reply, null).setupObserved, false);
  assert.equal(handoffEvidence(reply, { ...setup, fieldFocused: false }).setupObserved, false);
  assert.equal(handoffEvidence({ content: [{ type: 'text', text: 'setup failed; input released' }] }, setup).expectedReply, false);
});


await test('actual handoff adapter retains bounded read order and setup evidence before failed assertions', async () => {
  const source = await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8');
  const start = source.indexOf('    handoff: async tab => {'), end = source.indexOf('\n    concurrent:', start);
  assert.ok(start > 0 && end > start);
  for (const [success, rounds] of [[false, 1], [true, 1], [false, 70]]) {
    const effects = [], state = {}, report = {}; let complete, clock = 0, observations = 0;
    const reply = { content: [{ type: 'text', text: '用户还没在 [2] 输入完。本次观察已结束，这不代表收到继续授权。' }] };
    const context = vm.createContext({ state, report, w: {}, options: { seconds: 30 }, handoffEvidence,
      Date: class extends Date { static now() { return ++clock; } },
      call: async (_w, name) => { effects.push(name); return name === 'wait_for_user' ? new Promise(resolve => { complete = () => resolve(reply); }) : {}; },
      readWorker: async (_w, op, args) => { effects.push(op); return op === 'own' ? { tabActive: true } : args.markerId ? { marker: 3 } : { state: { askVisible: true, fieldFocused: success, privateValue: 'private-handoff-sentinel' } }; },
      observe: async () => { effects.push('observe'); if (++observations === rounds) complete(); return { workerHold: false, lease: { owned: false }, inputReleased: true, timestamp: 4, privateRaw: 'private-handoff-sentinel' }; },
      delay: async () => {}, error: code => Error(code), check: (name, expected, actual) => assert.equal(actual, expected, name) });
    vm.runInContext('globalThis.adapter = { ' + source.slice(start, end) + '\n};', context);
    if (success) await context.adapter.handoff(7);
    else await assert.rejects(context.adapter.handoff(7), /handoff_setup_observed_after_release/);
    assert.ok(report.handoffWait, 'wait facts survive setup assertion failure');
    assert.equal(report.handoffSetup?.fieldFocused ?? false, success);
    assert.equal(report.handoffReads.rounds.length, Math.min(rounds, 64));
    assert.equal(report.handoffReads.overflow, rounds > 64);
    const row = report.handoffReads.rounds[0];
    assert.deepEqual(Array.from([row.sample.startOrder, row.sample.endOrder, row.own.startOrder, row.own.endOrder, row.observe.startOrder, row.observe.endOrder]), [1, 2, 3, 4, 5, 6]);
    assert.ok(row.sample.startAt <= row.sample.endAt && row.sample.endAt <= row.own.startAt && row.own.endAt <= row.observe.startAt);
    assert.equal(row.sample.askVisible, true); assert.equal(row.sample.fieldFocused, success);
    assert.equal(row.own.tabActive, true); assert.equal(row.observe.workerHold, false); assert.equal(row.observe.leaseOwned, false);
    assert.equal(JSON.stringify(report).includes('private-handoff-sentinel'), false);
    assert.deepEqual(effects, ['read_page', 'sample', 'wait_for_user', ...Array.from({ length: rounds }, () => ['sample', 'own', 'observe']).flat()]);
  }
});

async function actualCallHarness(mode, reply, mutate = x => x) {
  const source = await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8');
  const start = source.indexOf('  async function call(w, name,');
  const end = source.indexOf('\n  const check =', start);
  assert.ok(start >= 0 && end > start);
  const state = { terminal: null, handoff: false, partial: mode === 'partial-create' }, effects = [];
  const report = { calls: [], cleanup: [], observations: [], originalScene: HEALTH.scene };
  const deletionStates = [], inflight = new Set();
  inflight.delete = value => { deletionStates.push(state.terminal); return Set.prototype.delete.call(inflight, value); };
  const worker = { pid: 123, rpc: async (op, request) => { effects.push(op === 'call' ? request.name : op); return typeof reply === 'function' ? reply(op, request) : reply; } };
  const context = vm.createContext({ state, report, options: { case: mode }, inflight, mcpReplyBoundary,
    scrollGate: scrollHelpers.createScrollActionGate(mode), owned: [{ worker, exact: true, closable: true, chromePid: 10, windowId: 9, tabId: 7, cgWindow: 11 }],
    WRITE_TOOLS: new Set(['open_tab', 'click', 'type_text', 'close_tab', 'task_plan']),
    observe: async () => {}, save: async () => {}, unknown: reason => ({ basis: 'unobserved', value: null, reason }),
    error: (code, stage) => Object.assign(Error(code), { code, stage }),
    abort: code => { state.terminal ||= code; effects.push('abort_pending_calls'); } });
  const readStart = source.indexOf('  async function readWorker('), readEnd = source.indexOf('  async function observe(w)', readStart);
  vm.runInContext(mutate(source.slice(start, end)) + source.slice(readStart, readEnd) + '\nglobalThis.invoke = call; globalThis.read = readWorker;', context);
  return { state, effects, report, worker, inflight, deletionStates, invoke: context.invoke, read: context.read };
}

await test('ordinary unstructured MCP error seals the real call path before continuation or cleanup', async () => {
  const h = await actualCallHarness('input', { isError: true, content: [{ type: 'text', text: 'Opaque localized ordinary-tool error' }] });
  await assert.rejects(h.invoke(h.worker, 'click', { tab: 7 }), e => e.code === 'unexpected_mcp_error' && e.stage === 'unobserved');
  assert.equal(h.state.terminal, 'unexpected_mcp_error');
  assert.deepEqual(h.deletionStates, ['unexpected_mcp_error']);
  assert.equal(h.report.calls[0].code, null); assert.equal(h.report.calls[0].stage, 'unobserved');
  assert.equal(h.report.calls[0].inputDelivery, 'unobserved');
  assert.equal(h.report.calls[0].expectedError, false);
  await assert.rejects(h.invoke(h.worker, 'type_text', { tab: 7 }), /unexpected_mcp_error/);
  await assert.rejects(h.invoke(h.worker, 'task_plan', { done: true }), /unexpected_mcp_error/);
  const cleanup = cleanupDecision(h.state, { exact: true, closable: true });
  if (cleanup.close) await h.invoke(h.worker, 'close_tab', { tab: 7 });
  assert.equal(cleanup.close, false);
  assert.deepEqual(h.effects, ['click', 'abort_pending_calls']);
});

await test('bounded product error claims survive actual parent call reporting but never permit terminal continuation', async () => {
  for (const delivery of ['sent', 'not_sent', 'unknown']) {
    const productError = { code: 'native_target_changed', stage: 'native_prepare', inputDelivery: delivery };
    const receipt = { terminal: { code: 'unexpected_mcp_error', stage: 'open_tab', inputDelivery: 'unknown', noRetry: true },
      productError, fixtures: [], call: { tool: 'open_tab', startedAt: 100, responseAt: 120 } };
    const h = await actualCallHarness('input', async () => {
      throw Object.assign(Error('worker ended'), { code: 'worker_terminal', terminalReceipt: receipt });
    });
    await assert.rejects(h.invoke(h.worker, 'open_tab', {}), /dispatched_rpc_rejected/);
    assert.deepEqual(h.report.terminalReceipts[0].productError, productError);
    assert.equal(Object.hasOwn(h.report.calls[0], 'productError'), false, 'worker terminal facts are not an RPC reply');
    assert.equal(h.report.calls[0].inputDelivery, 'unknown'); assert.equal(h.report.calls[0].noRetry, true);
    assert.deepEqual(h.deletionStates, ['dispatched_rpc_rejected']);
    await cleanupFixtures(finalizer(h));
    assert.deepEqual(h.effects, ['open_tab', 'abort_pending_calls']);
  }
});
await test('machine metadata is projected without coercion, prose parsing or extra authority', () => {
  const unknown = { code: 'unavailable', stage: 'unobserved', inputDelivery: 'unknown' };
  for (const value of [[], 'raw-secret', 42, { code: 'valid_code\n', stage: 'https://example.test/?token=secret', inputDelivery: 'not really sent' },
    Object.create({ code: 'native_target_changed', stage: 'native_prepare', inputDelivery: 'not_sent' })]) assert.deepEqual(productErrorFact(value), unknown);
  assert.equal(productErrorFact(undefined), null); assert.equal(productErrorFact(null), null);
  const raw = { code: 'native_target_changed', stage: 'native_prepare', inputDelivery: 'not_sent', token: 'synthetic-secret' };
  const state = {}, boundary = mcpReplyBoundary(state, { isError: true, content: [{ type: 'text', text: 'synthetic-secret' }], structuredContent: { error: raw } }, { mode: 'input', tool: 'click' });
  assert.deepEqual(boundary.productError, { code: raw.code, stage: raw.stage, inputDelivery: raw.inputDelivery });
  assert.equal(boundary.terminal, true); assert.equal(state.terminal, 'unexpected_mcp_error');
  assert.equal(JSON.stringify(boundary).includes('synthetic-secret'), false);
  const legacy = mcpReplyBoundary({}, { isError: true, content: [{ type: 'text', text: 'code=fixture_error not_sent' }] }, { mode: 'input', tool: 'click' });
  assert.equal(legacy.productError, null); assert.equal(legacy.code, null); assert.equal(legacy.inputDelivery, 'unobserved');
  const partial = mcpReplyBoundary({}, { isError: true, structuredContent: { error: raw } },
    { mode: 'partial-create', tool: 'open_tab', expectedError: 'partial-create-response' });
  assert.equal(partial.inputDelivery, 'unknown', 'partial-create harness outcome stays unknown');
  assert.equal(partial.productError.inputDelivery, 'not_sent', 'harness classification cannot rewrite the original product claim');
});

await test('expected partial-create reply alone is scoped and never resends or claims the retained identity', async () => {
  let replacement, nativeSends = 0;
  const retained = { attempts: 0, created: null };
  installPartialCreateFault({ __setBridgeForTests: x => { replacement = x.newWindow; } },
    { newWindow: async () => { nativeSends++; return { tabId: 7, windowId: 9 }; } }, retained);
  const ordinaryError = { isError: true, content: [{ type: 'text', text: 'Opaque expected response error' }] };
  const h = await actualCallHarness('partial-create', async () => {
    await assert.rejects(replacement('fixture'), e => e.code === 'fixture_response_lost' && e.creationAttempted && e.inputDelivery === 'unknown');
    return ordinaryError;
  });
  const result = await h.invoke(h.worker, 'open_tab', {}, { expectedError: 'partial-create-response' });
  assert.equal(result.isError, true); assert.equal(h.state.terminal, null);
  assert.equal(h.report.calls[0].expectedError, true);
  assert.equal(nativeSends, 1); assert.equal(retained.attempts, 1);
  assert.deepEqual(h.effects, ['open_tab']);
  assert.equal(h.state.unknown, true);
  await assert.rejects(h.invoke(h.worker, 'task_plan', { done: true }), /unknown_delivery_boundary/);
  await assert.rejects(h.read(h.worker, 'sample', { tab: 7 }), /unknown_delivery_boundary/);
  assert.equal(result.tabId, undefined); assert.equal(cleanupDecision(h.state, { exact: true, closable: true }).close, false);
  for (const [mode, tool, expectedError] of [['input', 'open_tab', 'partial-create-response'],
    ['partial-create', 'click', 'partial-create-response'], ['partial-create', 'open_tab', null]]) {
    const wrong = await actualCallHarness(mode, ordinaryError);
    await assert.rejects(wrong.invoke(wrong.worker, tool, {}, { expectedError }), /unexpected_mcp_error/);
    assert.ok(wrong.state.terminal);
  }
  const knownStop = await actualCallHarness('partial-create', { ...ordinaryError, structuredContent: { error: { code: 'user_cancelled' } } });
  await assert.rejects(knownStop.invoke(knownStop.worker, 'open_tab', {}, { expectedError: 'partial-create-response' }), /user_cancelled/);
});

function fake({ badHold = false, badPartial = false, stopOnClick = false } = {}) {
  const calls = [], state = {}, counts = { clicks: 0, heldKeys: 0, untrusted: 0 }, records = new Map();
  let next = 100;
  const add = name => { if (state.terminal) throw Error('write_after_stop'); calls.push(name); };
  return { calls, state,
    check: (name, expected, actual) => assert.deepEqual(actual, expected, name),
    plan: async () => add('task_plan'), done: async () => add('done'),
    open: async ({ unknownIdentity } = {}) => { add('open_tab'); if (unknownIdentity) return { error: true }; const t = ++next; records.set(t, { windowId: 30, tabActive: true }); return t; },
    own: async tab => records.get(tab),
    close: async () => add('close_tab'),
    sample: async () => ({ ...counts }),
    click: async (_tab, id) => { add('click:' + id); if (stopOnClick) { state.terminal = 'native_interruption'; throw Error('stopped'); } if (id === 'tick') counts.clicks++; },
    observe: async () => ({ takeover: { active: !badHold }, lease: { owned: !state.handoff }, workerHold: !state.handoff }),
    type: async () => { add('type_text'); counts.valueMatches = true; },
    dialog: async () => ({ exact: true, button: 'OK' }),
    answer: async (_tab, _button, text) => { add('answer_dialog');
      if (text) { counts.promptDone = 1; counts.promptMatches = true; }
      else if (!counts.alertDone) counts.alertDone = 1; else counts.confirmDone = 1; },
    handoff: async () => { add('wait_for_user'); state.handoff = true; },
    concurrent: async () => add('real_queue_scenario'),
    waitForStop: async () => { state.terminal = 'stop_observed'; calls.push('observe_stop'); },
    fault: async () => ({ attempts: badPartial ? 2 : 1, registered: false, exact: true, identity: { tabId: 7, windowId: 9 } }),
  };
}

await test('fake cases exercise MCP sequencing without proving native effects', async () => {
  for (const mode of CASES.filter(mode => !['scroll-document', 'same-connection-writes'].includes(mode))) {
    const h = fake(); await executeCase(mode, h);
    assert.equal(h.calls[0], 'task_plan');
    if (mode === 'input') assert.deepEqual(h.calls, ['task_plan', 'open_tab', 'click:tick', 'open_tab', 'type_text']);
    if (mode === 'handoff' || mode === 'stop') assert.ok(!h.calls.includes('done'));
    if (mode === 'partial-create') assert.deepEqual(h.calls, ['task_plan', 'open_tab']);
  }
});

await test('negative harness mutations really fail instead of claiming coverage', async () => {
  await assert.rejects(executeCase('input', fake({ badHold: true })), /native_hold_active/);
  await assert.rejects(executeCase('partial-create', fake({ badPartial: true })), /one_real_create/);
  const stopped = fake({ stopOnClick: true });
  await assert.rejects(executeCase('input', stopped), /stopped/);
  assert.ok(!stopped.calls.includes('type_text')); assert.ok(!stopped.calls.includes('done'));
  assert.equal(cleanupDecision(stopped.state, { exact: true, closable: true }).close, false);
});


function finalizer(h, overrides = {}) {
  return { state: h.state, owned: [{ worker: h.worker, tabId: 7, windowId: 9 }], workers: [h.worker],
    observe: async () => { h.effects.push('observe'); return HEALTH; },
    readWorker: h.read, call: h.invoke, check: (name, want, got) => assert.deepEqual(got, want, name), report: h.report, ...overrides };
}

await test('rejected dispatched RPC seals before inflight deletion and real finally cannot read, close or done', async () => {
  for (const code of ['harness_timeout', 'worker_exited', 'malformed_response']) {
    const h = await actualCallHarness('input', async () => { throw Object.assign(Error(code), { code }); });
    await assert.rejects(h.invoke(h.worker, 'click', { tab: 7 }), e => e.code === 'dispatched_rpc_rejected' && e.inputDelivery === 'unknown' && e.noRetry);
    assert.equal(h.state.terminal, 'dispatched_rpc_rejected');
    assert.deepEqual(h.deletionStates, ['dispatched_rpc_rejected']); assert.equal(h.inflight.size, 0);
    const receipt = h.report.calls[0];
    assert.equal(receipt.workerPid, 123); assert.equal(receipt.tool, 'click'); assert.equal(receipt.code, code);
    assert.equal(receipt.inputDelivery, 'unknown'); assert.equal(receipt.noRetry, true);
    assert.ok(Date.parse(receipt.timestamp) <= Date.parse(receipt.responseAt)); assert.ok(receipt.elapsedMs >= 0);
    await assert.rejects(h.invoke(h.worker, 'task_plan', { done: true }), /dispatched_rpc_rejected/);
    await assert.rejects(h.read(h.worker, 'sample', { tab: 7 }), /dispatched_rpc_rejected/);
    await cleanupFixtures(finalizer(h));
    assert.deepEqual(h.effects, ['click', 'abort_pending_calls']);
    assert.equal(h.report.cleanup[0].tabId, 7); assert.equal(h.report.cleanup[0].windowId, 9);
    assert.equal(h.report.cleanup[0].close, false);
  }
});

await test('malformed resolved RPC replies are also terminal unknown before cleanup', async () => {
  for (const reply of [null, undefined, 'bad reply']) {
    const h = await actualCallHarness('input', reply);
    await assert.rejects(h.invoke(h.worker, 'click', { tab: 7 }), /malformed_mcp_reply/);
    assert.deepEqual(h.deletionStates, ['malformed_mcp_reply']);
    assert.equal(h.report.calls[0].inputDelivery, 'unknown');
    await cleanupFixtures(finalizer(h));
    assert.deepEqual(h.effects, ['click', 'abort_pending_calls']);
  }
});

await test('removing rejection sealing fails the actual terminal-before-delete negative', async () => {
  const h = await actualCallHarness('input', async () => { throw Error('lost'); },
    text => text.replace("abort('dispatched_rpc_rejected');", '/* intentionally removed in-memory guard */'));
  await assert.rejects(h.invoke(h.worker, 'click'), /dispatched_rpc_rejected/);
  assert.throws(() => assert.equal(h.deletionStates[0], 'dispatched_rpc_rejected'), { code: 'ERR_ASSERTION' });
});

await test('actual finally closes exact fixtures under original hold before done and scene readback', async () => {
  for (const ordinaryAssertion of [false, true]) {
    const effects = [], worker = { pid: 123 }, state = {}, report = { cleanup: [], originalScene: HEALTH.scene, status: ordinaryAssertion ? 'failed' : 'running' };
    await cleanupFixtures({ state, owned: [{ worker, tabId: 7, windowId: 9 }], workers: [worker], report,
      observe: async () => { effects.push(worker.completed ? 'post_scene' : 'healthy_same_hold'); return HEALTH; },
      readWorker: async (_w, op) => { effects.push(op); return op === 'own' ? { exact: true, closable: true, tabId: 7, windowId: 9 } : { gone: true }; },
      call: async (_w, tool) => { effects.push(tool); }, check: (n, a, b) => assert.deepEqual(b, a, n) });
    assert.deepEqual(effects, ['healthy_same_hold', 'own', 'close_tab', 'gone', 'healthy_same_hold', 'task_plan', 'post_scene']);
    assert.equal(worker.completed, true); assert.equal(report.cleanup[0].closed, true);
  }
});

await test('actual finally cannot reacquire after lost/replaced hold or clean partial unknown creation', async () => {
  for (const state of [{ partial: true, unknown: true }, { terminal: 'native_interruption' }, { handoff: true }]) {
    const h = await actualCallHarness('input', {}); Object.assign(h.state, state);
    await cleanupFixtures(finalizer(h)); assert.deepEqual(h.effects, []);
  }
  for (const health of [{ ...HEALTH, healthyHold: false }, { ...HEALTH, sameHold: false }, { ...HEALTH, lease: { owned: true, sameToken: false } }]) {
    const h = await actualCallHarness('input', {});
    await cleanupFixtures(finalizer(h, { observe: async () => health }));
    assert.deepEqual(h.effects, []); assert.equal(h.worker.completed, undefined);
    assert.equal(h.report.cleanup[0].reason, 'original_healthy_hold_unproven');
  }
});

await test('an exact record in a different window cannot authorize cleanup or done', async () => {
  const h = await actualCallHarness('input', {});
  await cleanupFixtures(finalizer(h, { readWorker: async () => ({ exact: true, closable: true, tabId: 7, windowId: 99 }) }));
  assert.deepEqual(h.effects, ['observe']);
  assert.equal(h.state.terminal, 'ownership_or_user_view_unknown');
  assert.equal(h.report.cleanup[0].windowId, 9); assert.equal(h.report.cleanup[0].close, false);
});

await test('rejection during actual cleanup close also blocks done and final readback', async () => {
  const h = await actualCallHarness('input', async (_op, request) => {
    if (request.name === 'close_tab') throw Error('lost close response');
    throw Error('unexpected tool');
  });
  await cleanupFixtures(finalizer(h, { readWorker: async (_w, op) => { h.effects.push(op); return { exact: true, closable: true, tabId: 7, windowId: 9 }; } }));
  assert.deepEqual(h.effects, ['observe', 'own', 'close_tab', 'abort_pending_calls']);
  assert.equal(h.report.cleanup[0].closed, false);
});

async function actualWorkerHarness({ mode = 'input', mutate = text => text, toolReply = {}, audit = null } = {}) {
  const source = await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8');
  const effects = [], workerState = { terminal: null, unknown: false };
  const first = { kept: { session: { pid: 1 } }, lease: { token: 'original-token' } };
  let current = first, lease = { pid: process.pid, token: 'original-token' }, health = { paused: false, locked: false, asleep: false };
  const deny = code => { workerState.terminal ||= code; if (mode === 'scroll-document') { effects.push('terminal:' + workerState.terminal); throw Object.assign(Error(workerState.terminal), { code: workerState.terminal }); } };
  let info = { url: 'http://127.0.0.1/fixture-fixture', tabId: 7, windowId: 9, chromePid: 10, cgWindow: 11 };
  const fixtures = new Map(mode === 'scroll-document' ? [[7, { exact: true, closable: true, tabId: 7, windowId: 9, chromePid: 10, cgWindow: 11 }]] : []);
  const controllers = new Map(), controllerDeletionStates = [];
  controllers.delete = key => { controllerDeletionStates.push(workerState.terminal); return Map.prototype.delete.call(controllers, key); };
  const scrollAudit = audit || (mode === 'scroll-document' ? scrollHelpers.createScrollAudit({ sources: scrollSources }) : null);
  const fence = createHoldFence({ getHold: () => current, readLease: async () => lease,
    readStatus: async () => ({ ok: true, takeover: { active: true } }), readHealth: async () => health, deny });
  const context = vm.createContext({ workerState, fence, rpcFailureFact, LIVE_BUDGETS: scrollHelpers.LIVE_BUDGETS, releaseKind: null, error: (code, stage) => Object.assign(Error(code), { code, stage }),
    process: { pid: process.pid }, fixtures, requestContext: new AsyncLocalStorage(), eventSequence: 0, url: 'http://127.0.0.1/fixture-fixture', token: 'fixture', controllers,
    scrollGate: scrollHelpers.createScrollActionGate(mode), scrollAudit, scrollIdentityMatches: scrollHelpers.scrollIdentityMatches,
    scrollIdentity: value => scrollHelpers.scrollIdentityMatches(value, value), scrollSamplerScript: scrollHelpers.scrollSamplerScript,
    SCROLL_ID_KEYS: ['chromePid', 'windowId', 'tabId', 'cgWindow'],
    tabs: { readTabRecord: async () => { effects.push('registry_read'); return { ownerPid: process.pid, expectedUrl: 'http://127.0.0.1/fixture-fixture', windowId: 9 }; } },
    B: { chromeInfo: async () => { effects.push('browser_read'); return info; },
      evalInPage: async () => { effects.push('page_read'); return { ok: true, state: {} }; } },
    api: { __taskHoldForTests: () => current }, client: { callTool: async (...args) => { effects.push('tool_dispatch'); return typeof toolReply === 'function' ? toolReply(...args) : toolReply; } },
    env: { MYCHROME_FIXTURE_CASE: mode }, retained: {}, boundsEvidence: null, mcpReplyBoundary, deny,
    stopResources: () => effects.push('stop_resources'), shutdown: () => effects.push('exit'), AbortController,
    WRITE_TOOLS: new Set(['click', 'close_tab', 'task_plan']), observe: async () => {},
  });
  const fresh = source.slice(source.indexOf('  async function fresh({'), source.indexOf('  let shuttingDown ='));
  const owns = source.slice(source.indexOf('  async function own(tab)'), source.indexOf('  async function observe()'));
  const dispatch = source.slice(source.indexOf('  async function dispatch(m)'), source.indexOf("  process.on('message', m =>"));
  vm.runInContext(mutate(fresh + owns + dispatch) + '\nconst actualDispatch = dispatch; globalThis.dispatch = m => requestContext.run(m.op === \'call\' ? { id: m.id, tool: m.name, startedAt: Date.now(), responseAt: null, startedSequence: ++eventSequence } : null, () => actualDispatch(m));', context);
  await fence.fresh();
  return { first, fence, effects, workerState, fixtures, controllers, controllerDeletionStates, scrollAudit, dispatch: context.dispatch, setInfo: changes => { info = { ...info, ...changes }; },
    replaceHold: () => { current = { kept: { session: first.kept.session }, lease: first.lease }; },
    replaceSession: () => { first.kept.session = { pid: 1 }; },
    replaceLease: () => { lease = { pid: process.pid, token: 'different-token' }; },
    release: () => { current = null; lease = null; }, pause: () => { health = { ...health, paused: true }; } };
}

await test('actual worker marks action immediately around accepted MCP return inside original outer window', async () => {
  for (const failed of [false, true]) {
    const events = [], audit = Object.fromEntries(['bind', 'begin', 'actionStart', 'actionEnd', 'end'].map(name => [name, () => events.push(name)]));
    const h = await actualWorkerHarness({ mode: 'scroll-document', audit, toolReply: () => { events.push('tool'); return failed ? { isError: true } : {}; } });
    const result = h.dispatch({ op: 'call', id: 1, name: 'scroll', args: { tab: 7, direction: 'down', amount: 1 } });
    if (failed) await assert.rejects(result, /unexpected_mcp_error/); else await result;
    assert.deepEqual(events, failed ? ['begin', 'bind', 'actionStart', 'tool'] : ['begin', 'bind', 'actionStart', 'tool', 'actionEnd', 'end']);
  }
});

await test('actual worker pins hold object, Session and owner token before any further read or tool dispatch', async () => {
  for (const replacement of ['replaceHold', 'replaceSession', 'replaceLease', 'release', 'pause']) {
    for (const request of [{ op: 'own', tab: 7 }, { op: 'sample', tab: 7 }, { op: 'call', id: 1, name: 'click', args: { tab: 7 } }, { op: 'call', id: 2, name: 'close_tab', args: { tab: 7 } }]) {
      const h = await actualWorkerHarness(); h[replacement]();
      await assert.rejects(h.dispatch(request), /original_|paused_by_user/);
      assert.deepEqual(h.effects, [], `${replacement}/${request.op}`);
      assert.equal(h.fence.pinned.hold, h.first);
    }
  }
  const healthy = await actualWorkerHarness(); await healthy.dispatch({ op: 'call', id: 3, name: 'click', args: { tab: 7 } });
  assert.deepEqual(healthy.effects, ['registry_read', 'browser_read', 'tool_dispatch']);
});

await test('resource-only shutdown stops only owned hold timers and controllers, without release or restore', async () => {
  const effects = [];
  const own = { timer: setTimeout(() => effects.push('own_timer'), 20), poll: setInterval(() => effects.push('own_poll'), 20),
    kept: { session: { close: () => effects.push('forbidden_session_close') } }, lease: { release: () => effects.push('forbidden_lease_release') } };
  const peer = { timer: setTimeout(() => effects.push('peer_timer'), 20) };
  const ac = new AbortController(); ac.signal.addEventListener('abort', () => effects.push('abort_own_call'));
  stopWorkerResources([own, own], new Map([[1, ac]]));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(effects, ['abort_own_call', 'peer_timer']); assert.equal(own.busy, true);
  assert.equal(own.timer, null); assert.equal(own.poll, null); clearTimeout(peer.timer);
  const source = await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8');
  const start = source.indexOf('  let shuttingDown ='), end = source.indexOf('  async function own(tab)', start);
  const shutdownEffects = [], context = vm.createContext({
    stopResources: () => shutdownEffects.push('stop_owned_resources'),
    clientTransport: { close: async () => shutdownEffects.push('close_transport') },
    process: { connected: true, disconnect: () => shutdownEffects.push('disconnect_ipc'), exit: () => shutdownEffects.push('exit_own_process') } });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.shutdown = shutdown;', context);
  context.shutdown(); context.shutdown();
  assert.deepEqual(shutdownEffects, ['stop_owned_resources', 'close_transport', 'exit_own_process']);
  assert.equal(shutdownEffects.includes('disconnect_ipc'), false, 'normal exit must not trigger the abnormal parent-disconnect terminal handler');
  assert.ok(source.indexOf('await save();\n    for (const w of workers)') > source.indexOf('report.retainedFixture ='));
});

await test('actual parent exit collection cannot turn missing abnormal or invalid bound receipts into success', async () => {
  const source = await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8');
  const start = source.indexOf('    for (const w of workers)', source.indexOf('// Persist exact retained identities'));
  const end = source.indexOf('    server.closeAllConnections();', start);
  assert.ok(start >= 0 && end > start);
  const loop = source.slice(start, end);
  const collect = async (evidence, body = loop) => {
    const c = vm.createContext({ workers: [{ pid: 123, disconnect: async () => {}, terminalEvidence: async () => evidence }],
      report: { status: 'observations_complete_with_open_gates', cleanup: [] }, process: { exitCode: 0 } });
    vm.runInContext('async function collect() {\n' + body + '\n}\nglobalThis.collect = collect;', c);
    await c.collect(); return c;
  };
  for (const evidence of [{ code: 86, receipt: null, receiptError: 'missing' },
    { code: 0, receipt: null, receiptError: 'invalid' }, { code: 0, receipt: { workerPid: 123, terminal: { code: 'unknown' } } }]) {
    const c = await collect(evidence); assert.equal(c.report.status, 'deferred'); assert.equal(c.process.exitCode, 1);
  }
  const normal = await collect({ code: 0, receipt: null, receiptError: 'missing' }); assert.equal(normal.process.exitCode, 0);
  const mutant = loop.replace(" || evidence.receiptError === 'invalid'", ''); assert.notEqual(mutant, loop);
  const bad = await collect({ code: 0, receipt: null, receiptError: 'invalid' }, mutant);
  assert.throws(() => assert.equal(bad.report.status, 'deferred'), { code: 'ERR_ASSERTION' });
});

await test('native bounds evidence is explicit input-source-run only and cannot inherit opt-in', () => {
  const flag='--native-bounds-evidence';
  const good=['--run','--root-operator','--source','/inert/source','--case','input',flag];
  assert.equal(parseOptions(good).nativeBoundsEvidence,true);
  for(const args of [[flag],['--check',flag],['--run','--root-operator','--source','/inert/source',flag],
    ['--run','--root-operator','--runtime','/inert/runtime','--case','input',flag],
    ...['partial-create','concurrency'].map(mode=>['--run','--root-operator','--source','/inert/source','--case',mode,flag])])
    assert.throws(()=>parseOptions(args),/native_bounds_evidence_requires_explicit_input_source_run|bad_case_or_timeout/);
  const base={PATH:'/bin',MYCHROME_FIXTURE_BOUNDS_DIR:'/stale',MYCHROME_FIXTURE_BOUNDS_ENABLED:'1'};
  assert.equal(workerEnvironment(base,'/inert/run','/inert/source','token','input','rpc').MYCHROME_FIXTURE_BOUNDS_DIR,undefined);
  assert.equal(workerEnvironment(base,'/inert/run','/inert/source','token','input','rpc',{nativeBoundsEvidence:true,directory:'/inert/fresh'}).MYCHROME_FIXTURE_BOUNDS_DIR,'/inert/fresh');
  assert.equal(workerEnvironment(base,'/inert/run','/inert/source','token','partial-create','rpc',{nativeBoundsEvidence:true,directory:'/inert/fresh'}).MYCHROME_FIXTURE_BOUNDS_DIR,undefined);
});


// Scroll QA uses actual named helpers and source slices. It never imports the
// product, executes page/native payloads, or creates a real worker.
const SCROLL_ID = Object.freeze({ exact: true, closable: true, chromePid: 10, windowId: 9, tabId: 7, cgWindow: 11 });
const SCROLL_ARGS = Object.freeze({ tab: 7, direction: 'down', amount: 1 });
const scrollSources = Object.fromEntries(await Promise.all(Object.keys(scrollHelpers.SCROLL_SOURCE_PINS).map(async file =>
  [file, await fs.readFile(path.join(root, file), 'utf8')])));
const digest = text => createHash('sha256').update(text).digest('hex');
const scrollBefore = (changes = {}) => ({ clicks: 1, input: 0, keydown: 0, keyup: 0, untrusted: 0, heldKeys: 0,
  scrollY: 0, maxScrollY: 4000, innerHeight: 800, sampledAt: 10, wheel: 0, trustedWheel: 0, untrustedWheel: 0,
  scrollEvents: 0, firstWheelAt: null, lastWheelAt: null, firstScrollAt: null, lastScrollAt: null,
  identity: { ...SCROLL_ID }, ...changes });
const scrollAfter = (changes = {}) => scrollBefore({ scrollY: 600, sampledAt: 30, wheel: 2, trustedWheel: 2,
  scrollEvents: 1, firstWheelAt: 15, lastWheelAt: 16, firstScrollAt: 17, lastScrollAt: 17, ...changes });

async function actualScrollHelpers(mutate = text => text, { here = '/inert/reliability-reset-live.mjs', readFile = async () => { throw Error('unexpected inert file read'); } } = {}) {
  const source = await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8');
  const end = source.lastIndexOf("\nif (process.argv[1]");
  assert.ok(end > source.indexOf('export async function main('));
  const body = source.slice(0, end).replace(/^#!.*\n/, '').replace(/^import[\s\S]*?;\n/gm, '')
    .replaceAll('export ', '').replace('const HERE = fileURLToPath(import.meta.url);', `const HERE = ${JSON.stringify(here)};`);
  const changed = mutate(body);
  if (mutate !== undefined && changed !== body) assert.ok(changed.length > 0);
  const context = vm.createContext({ assert, createHash, performance, path, Buffer, URL, Promise, fs: { readFile }, process: { pid: 123, argv: [] } });
  // Compilation errors escape and fail the suite; only behavioral assertions
  // after successful execution are accepted as killed mutants.
  new vm.Script(changed + '\nglobalThis.helpers = { scrollSampleValid, scrollIdentityMatches, scrollDocumentEvidence, createScrollActionGate, createScrollAudit, installScrollAudit, executeCase, hashes, scrollHarnessHashes };').runInContext(context);
  return context.helpers;
}
function replaceScroll(text, from, to) {
  assert.ok(text.includes(from), `mutation anchor absent: ${from}`);
  return text.replace(from, to);
}
function killed(label, check) {
  assert.throws(check, e => e.code === 'ERR_ASSERTION', `${label}: expected a valid behavioral assertion failure`);
  console.log(`  killed valid mutant: ${label}`);
}

await test('scroll and same-connection cases retain old fixture bytes and all seven fake sequences', async () => {
  assert.deepEqual(CASES, ['input', 'dialog', 'close', 'handoff', 'concurrency', 'stop', 'partial-create', 'scroll-document', 'same-connection-writes']);
  assert.equal(digest(fixtureHTML.toString()), 'dd19757c65cb4291554ca7b01a7b6d079f7a957e8b2fa304531195bd0e91f94e');
  const expected = {
    input: ['task_plan', 'open_tab', 'click:tick', 'open_tab', 'type_text'],
    dialog: ['task_plan', 'open_tab', 'click:tick', 'click:prompt', 'answer_dialog', 'click:alert', 'answer_dialog', 'click:confirm', 'answer_dialog'],
    close: ['task_plan', 'open_tab', 'click:tick', 'close_tab'],
    handoff: ['task_plan', 'open_tab', 'click:tick', 'wait_for_user'],
    concurrency: ['task_plan', 'open_tab', 'click:tick', 'real_queue_scenario'],
    stop: ['task_plan', 'open_tab', 'click:tick', 'observe_stop'],
    'partial-create': ['task_plan', 'open_tab'],
  };
  for (const [mode, calls] of Object.entries(expected)) {
    const h = fake(); await executeCase(mode, h); assert.deepEqual(h.calls, calls, mode);
  }
  assert.equal(parseOptions(['--check', '--case', 'scroll-document']).case, 'scroll-document');
  const html = scrollHelpers.scrollFixtureHTML('scroll-test-token');
  assert.match(html, /500vh/); assert.match(html, /passive\s*:\s*true/);
  assert.ok(!/dispatchEvent|\.click\(|\.focus\(|scrollIntoView|scrollTo\(|scrollBy\(|preventDefault|setInterval|setTimeout|<iframe|https?:\/\//.test(html));
  assert.throws(() => scrollHelpers.scrollFixtureHTML('</script>'));
  const sampler = scrollHelpers.scrollSamplerScript({ url: 'http://127.0.0.1/fixture-scroll-test-token', token: 'scroll-test-token' });
  assert.match(sampler, /scrollingElement/); assert.ok(!/scrollTo\(|scrollBy\(|scrollTop\s*=|\.focus\(/.test(sampler));
  for (const code of ["B.pageScript('block')", 'B.openInputSession()', "session.request({ op: 'wheel' })"])
    assert.ok(staticSafetyCheck(code).length > 0, code);
});

await test('scroll samples require finite typed monotonic counters, offsets, timestamps and all four identities', () => {
  const { scrollSampleValid, scrollIdentityMatches, scrollDocumentEvidence } = scrollHelpers;
  const before = scrollBefore(), after = scrollAfter();
  assert.equal(scrollSampleValid(before), true); assert.equal(scrollSampleValid(after, before), true);
  assert.equal(scrollDocumentEvidence(before, after).documentScrollObserved, true);
  assert.equal(scrollDocumentEvidence(before, after).identityObserved, true);
  for (const key of ['scrollY', 'maxScrollY', 'innerHeight', 'sampledAt', 'wheel', 'trustedWheel', 'untrustedWheel', 'scrollEvents', 'clicks', 'input', 'keydown', 'keyup']) {
    for (const value of [undefined, null, NaN, Infinity, -Infinity, '1'])
      assert.equal(scrollSampleValid({ ...after, [key]: value }, before), false, `${key}/${String(value)}`);
  }
  for (const changed of [{ scrollY: -1 }, { scrollY: 4001 }, { innerHeight: 0 }, { sampledAt: 9 }, { wheel: 1.5 },
    { trustedWheel: 3 }, { firstWheelAt: 18, lastWheelAt: 16 }, { lastWheelAt: 31 }, { firstScrollAt: null },
    { wheel: 0 }, { trustedWheel: 0 }, { untrustedWheel: 1 }, { scrollY: 0 }, { clicks: 2 }, { input: 1 }, { keydown: 1 }, { keyup: 1 }])
    assert.equal(scrollDocumentEvidence(before, scrollAfter(changed)).documentScrollObserved, false, JSON.stringify(changed));
  for (const key of ['chromePid', 'windowId', 'tabId', 'cgWindow']) {
    const wrong = { ...SCROLL_ID, [key]: SCROLL_ID[key] + 1 };
    assert.equal(scrollIdentityMatches(SCROLL_ID, wrong), false, key);
    assert.equal(scrollIdentityMatches(SCROLL_ID, { ...SCROLL_ID, [key]: String(SCROLL_ID[key]) }), false, key);
    const result = scrollDocumentEvidence(before, scrollAfter({ identity: wrong }));
    assert.equal(result.identityObserved, false, key); assert.equal(result.documentScrollObserved, false, key);
  }
});

await test('scroll action gate rejects every legacy mode, foreign tab, extra field and duplicate before delegation', () => {
  for (const mode of CASES.filter(mode => mode !== 'scroll-document'))
    assert.throws(() => scrollHelpers.createScrollActionGate(mode).accept(SCROLL_ARGS, SCROLL_ID));
  for (const args of [{ ...SCROLL_ARGS, tab: 8 }, { ...SCROLL_ARGS, tab: '7' }, { ...SCROLL_ARGS, direction: 'up' },
    { ...SCROLL_ARGS, amount: 2 }, { ...SCROLL_ARGS, amount: '1' }, { ...SCROLL_ARGS, extra: true }, { tab: 7, direction: 'down' }, null])
    assert.throws(() => scrollHelpers.createScrollActionGate('scroll-document').accept(args, SCROLL_ID));
  for (const identity of [null, { ...SCROLL_ID, exact: false }, { ...SCROLL_ID, chromePid: NaN }])
    assert.throws(() => scrollHelpers.createScrollActionGate('scroll-document').accept(SCROLL_ARGS, identity));
  const gate = scrollHelpers.createScrollActionGate('scroll-document'); gate.accept(SCROLL_ARGS, SCROLL_ID);
  assert.throws(() => gate.accept(SCROLL_ARGS, SCROLL_ID));
});


// Independent reconstruction mirrors the frozen bridge substitution algorithm;
// the audit under test never supplies the expected script bytes.
function frozenScript(name, vars = {}) {
  let source = scrollSources[`src/page/${name}.js`];
  assert.equal(typeof source, 'string');
  for (const [key, value] of Object.entries(vars)) source = source.replaceAll(`__${key}__`, () => JSON.stringify(value === undefined ? null : value));
  return source;
}
const LOCATE_SCROLL = Object.freeze({ MARKER: null, MODE: 'scroll', SCROLL: false, DIR: 'down' });
const LOCATE_MEASURE = Object.freeze({ MARKER: null, MODE: 'measure', SCROLL: false, DIR: null });
const AUDIT_BOUNDS = {left:30,top:40,width:900,height:700};
const AUDIT_CONTENT = {ok:true,source:"ax-web-area",pid:SCROLL_ID.chromePid,cgWindow:SCROLL_ID.cgWindow,windowBounds:{x:30,y:40,w:900,h:700},rect:{x:30,y:128,w:900,h:612}};
function auditFixture({ helpers = scrollHelpers, sources = scrollSources, now, limit, page, evaluate, content, observe, observerAudit, native, geometryChanged = false } = {}) {
  let clock = 0;
  const audit = helpers.createScrollAudit({ sources, now: now || (() => ++clock), ...(limit === undefined ? {} : { limit }) });
  const effects = [], returned = { native: true }, receiver = { receiver: true };
  const session = { pid: 42, close: () => effects.push({ type: 'forbidden-close' }), cancel: () => effects.push({ type: 'forbidden-cancel' }),
    request: function (...args) {
      effects.push({ type: 'request', receiver: this, args });
      if (native) return native.apply(this, args);
      const request = args[0];
      if (request.op === 'nativeChrome') return Promise.resolve({ ok: true, schema: 1, epoch: request.epoch, operationId: request.operationId,
        inputDelivery: 'sent', targetOnTop: true, keyWindowIsTarget: true, ...SCROLL_ID, stages: [], bounds: {...AUDIT_BOUNDS},
        geometry:{mode:'fit-current',beforeBounds:{...AUDIT_BOUNDS},displayId:1,branch:'usable',changed:geometryChanged,possiblyChanged:geometryChanged} });
      if (request.op === 'wheel') return Promise.resolve({ ok: true, sent: request.notches });
      if (request.op === 'veil') return Promise.resolve({ ok: true, held: true });
      return Promise.resolve({ ok: true });
    } };
  const original = {
    ...(observerAudit ? { __setPagePromptObserverAuditForTests: observerAudit } : {}),
    pageScript: async function (...args) { effects.push({ type: 'pageScript', receiver: this, args }); return page ? page.apply(this, args) : frozenScript(...args); },
    evalInPage: async function (...args) { effects.push({ type: 'eval', receiver: this, args });
      if (evaluate) return evaluate.apply(this, args);
      if (args[0] === frozenScript('block')) return { ok: true, blocked: null };
      if (args[0] === frozenScript('locate', LOCATE_SCROLL)) return { ok: true, scroller: 'document', scrollTop: 0, max: 4000, height: 800,
        target:{tabId:SCROLL_ID.tabId,windowId:SCROLL_ID.windowId},bounds:{...AUDIT_BOUNDS},view:{outerWidth:900,outerHeight:700,innerWidth:900,innerHeight:612} };
      return { ok: true, scrollTop: 600, max: 4000 }; },
    pageContentRect: function (...args) { effects.push({type:'content',receiver:this,args}); return content ? content.apply(this,args) : Promise.resolve(structuredClone(AUDIT_CONTENT)); },
    observePagePrompts: async function (...args) { effects.push({ type: 'observer', receiver: this, args }); return observe ? observe.apply(this, args) : { status: 'observed', complete: true, observedAt: 1, observations: [] }; },
    openInputSession: function (...args) { effects.push({ type: 'open', receiver: this, args }); return session; },
  };
  let wrapped;
  helpers.installScrollAudit({ __setBridgeForTests: replacements => { assert.equal(wrapped, undefined); wrapped = replacements; } }, original, audit);
  audit.bind(SCROLL_ID);
  return { audit, effects, returned, receiver, session, original, wrapped,
    page: (...args) => wrapped.pageScript.apply(receiver, args), eval: (...args) => wrapped.evalInPage.apply(receiver, args),
    content: (...args) => wrapped.pageContentRect.apply(receiver,args),
    observer: (...args) => wrapped.observePagePrompts.apply(receiver, args), open: (...args) => wrapped.openInputSession.apply(receiver, args) };
}

async function actualHeldScrollVeil(session, transform = request => request) {
  const product = scrollSources['src/index.js'], guard = scrollSources['src/guard.js'];
  const bounds = product.match(/^const boundsRect = .*;$/m)?.[0];
  assert.equal(typeof bounds, 'string', 'frozen boundsRect declaration');
  const exactSlice = (text, first, last) => {
    const start = text.indexOf(first), end = text.indexOf(last, start);
    assert.ok(start >= 0 && end > start, first); return text.slice(start, end);
  };
  const labels = exactSlice(product, 'function veilLabel(', '\n/** Password, one-time code');
  const feed = exactSlice(product, 'function feedSnapshot()', '\nfunction scheduleFeedPush()');
  const task = exactSlice(product, 'function taskKey(', '\nconst taskRestoreOps =');
  const veil = exactSlice(product, 'function veilFor(', '\n/** The note for an action');
  const scroll = exactSlice(product, 'async function scroll(args,', '\n/* ---------------------------------------------------------------- server */');
  const callback = scroll.match(/veil: \(\) => veilFor\('scroll', null, info\.bounds \? boundsRect\(info\.bounds\) : null, args\)/)?.[0];
  assert.equal(typeof callback, 'string', 'actual scroll veil callback');
  // Execute the real reuse branch, including its exact request/options and held
  // receipt check. The non-reuse path is outside this existing-hold fixture.
  const hold = exactSlice(guard, '  const hold = async () => {', '\n    await ensureSession();') + '\n  };';
  assert.match(hold, /session\.request\(\{ op: 'veil', \.\.\.\(veil \? \{ veil \} : \{\}\) \}, \{ raw: true \}\)/);
  const forwarded = [];
  const context = vm.createContext({
    PLAN: { task: 'private-synthetic-task', t0: 100 }, args: SCROLL_ARGS,
    info: { ...SCROLL_ID, bounds: { left: 30, top: 40, width: 900, height: 700 } },
    agentIdentity: () => ({ who: 'private-synthetic-agent', color: 2 }),
    VISIBLE_FEED: { snapshot: () => ({ entries: [{ text: 'private-synthetic-feed' }], status: 'streaming', reason: 'private-synthetic-reason' }) },
    VISIBLE_FEED_REASON: null, VISIBLE_FEED_SOURCE: 'private-synthetic-source',
    Date: { now: () => 150 }, T: {}, pre: null, reuse: { session },
    session: { request: (request, options) => { const actual = transform(request); forwarded.push({ request: actual, options }); return session.request(actual, options); } },
  });
  new vm.Script([bounds, labels, feed, task, veil, `const ops = { ${callback} };`, hold, 'globalThis.hold = hold;'].join('\n')).runInContext(context);
  await context.hold(); assert.equal(forwarded.length, 1);
  return forwarded[0];
}

async function normalAuditTrace(h, { omitBlockEval = false, omitMeasureEval = false, blockArgs = [], blockEvalArgs, measureRepeats = 1, beforeEnd, veilTransform, corroboration = false, exactOptions, omitContent = false, omitB = false, nativeIntent, actionMarkers = false, beforeAction, atActionStart, afterAction } = {}) {
  const session = h.open({ inert: 'open-options' }); assert.equal(session, h.session, 'same Session object');
  h.audit.begin();
  if (beforeAction) await beforeAction();
  if (actionMarkers) h.audit.actionStart();
  if (atActionStart) await atActionStart();
  const block = await h.page('block', ...blockArgs);
  if (!omitBlockEval) await h.eval(block, ...(blockEvalArgs || [7, { lean: true }]));
  await actualHeldScrollVeil(session, veilTransform);
  await session.request({ op: 'nativeChrome', schema: 1, operationId: 'native-1', epoch: 1, policy: 'normal', intent: nativeIntent || { kind: 'activate', tabId: 7, windowId: 9, fitCurrent:true } });
  const loc = await h.page('locate', LOCATE_SCROLL);
  const options = exactOptions || {exactTarget:Object.fromEntries(['chromePid','cgWindow','windowId','tabId'].map(k=>[k,SCROLL_ID[k]]))};
  await h.eval(loc,7,...(corroboration ? [options] : []));
  if (corroboration) {
    if (!omitContent) await h.content({chromePid:SCROLL_ID.chromePid,cgWindow:SCROLL_ID.cgWindow});
    if (!omitB) await h.eval(loc,7,options);
  }
  await session.request({ op: 'move', to: { x: 100, y: 100 }, rect: { x: 90, y: 90, w: 20, h: 20 } });
  const measure = await h.page('locate', LOCATE_MEASURE);
  await session.request({ op: 'wheel', dir: 'down', notches: 2 });
  if (!omitMeasureEval) for (let i = 0; i < measureRepeats; i++) await h.eval(measure, 7);
  if (beforeEnd) await beforeEnd(h, session);
  if (actionMarkers) h.audit.actionEnd();
  if (afterAction) await afterAction();
  h.audit.end(); return h.audit.snapshot();
}

await test('one frozen live budget governs MCP, parent RPC and episode without changing startup, exit or hold limits', async () => {
  const budgets = scrollHelpers.LIVE_BUDGETS;
  assert.deepEqual(budgets, { mcpTimeoutMs: 180000, parentRpcTimeoutMs: 210000, episodeTimeoutMs: 600000 });
  assert.equal(Object.isFrozen(budgets), true);
  assert.throws(() => { budgets.mcpTimeoutMs = 1; }, TypeError);
  let observed;
  const worker = await actualWorkerHarness({ toolReply: (...args) => { observed = args[2]; return {}; } });
  await worker.dispatch({ op: 'call', id: 1, name: 'click', args: { tab: 7 } });
  assert.equal(observed.timeout, budgets.mcpTimeoutMs); assert.ok(observed.signal instanceof AbortSignal);
  const source = await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8');
  for (const name of ['mcpTimeoutMs', 'parentRpcTimeoutMs', 'episodeTimeoutMs'])
    assert.equal(source.split('LIVE_BUDGETS.' + name).length - 1, 1);
  assert.match(source, /setTimeout\(\(\) => reject\(error\('worker_start_timeout'\)\), 15000\)/);
  assert.match(source, /setTimeout\(\(\) => reject\(error\('worker_exit_unconfirmed'\)\), 5000\)/);
  assert.equal(parseOptions(['--seconds', '120']).seconds, 120);
  assert.throws(() => parseOptions(['--seconds', '121']), /bad_case_or_timeout/);
});

// Execute the real product factory in an inert VM; only its dependency inputs
// are fake children/files/timers. No product module or process is started.
async function actualObserverAudit({ alterFact = fact => fact, script = (...args) => frozenScript(...args), auditOptions = {} } = {}) {
  const source = await fs.readFile(path.join(root, 'src/bridge.js'), 'utf8');
  const targetStart = source.indexOf('function dialogTarget('), targetEnd = source.indexOf('/** Read only.', targetStart);
  const factoryStart = source.indexOf('export function createPagePromptObserver('), factoryEnd = source.indexOf('\nconst pagePromptObserver =', factoryStart);
  assert.ok(targetStart > 0 && targetEnd > targetStart && factoryEnd > factoryStart);
  const context = vm.createContext({ Buffer, Promise, JSON, crypto, path, os, canonicalPromptOrigin: () => null,
    BridgeError: class extends Error {}, CHROMECTL: '/inert/chromectl',
    blockSource: () => 'JSON.stringify({ ok: true, blocked: null })' });   // G2 r2: the observer's gate source, inert
  vm.runInContext(source.slice(targetStart, targetEnd) + source.slice(factoryStart, factoryEnd).replace('export ', '') + '\nglobalThis.factory = createPagePromptObserver;', context);
  const children = [], timers = new Map(), effects = []; let sink = null, timerId = 0;
  const observer = context.factory({ getAudit: () => fact => { const value = alterFact(fact); for (const entry of Array.isArray(value) ? value : [value]) if (entry && sink) sink(entry); },
    spawnChild: (_bin, argv) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = signal => { effects.push(['kill', signal]); return true; };
      child.output = value => child.stdout.emit('data', Buffer.from(JSON.stringify(value)));
      child.close = (code = 0) => child.emit('close', code); children.push(child); effects.push(['spawn', argv[0]]); return child;
    }, readScript: async (...args) => script(...args), writeScript: async () => { effects.push(['write']); },
    removeScript: async () => { effects.push(['remove']); }, timer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    untimer: id => timers.delete(id), now: () => 123 });
  const h = auditFixture({ ...auditOptions, observerAudit: value => { sink = value; }, observe: options => observer.observe(options) });
  const controller = new AbortController();
  const start = (target = Object.fromEntries(['chromePid', 'tabId', 'windowId', 'cgWindow'].map(k => [k, SCROLL_ID[k]]))) => h.observer({ target, source: {}, namespace: 'private-observer-namespace', signal: controller.signal });
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const native = async (open = false) => {
    const child = children.at(-1);
    child.output({ ok: true, known: true, open, ...(open ? { identity: { ...SCROLL_ID, version: 1, dialogCgWindow: 19, token: 'a'.repeat(64) },
      title: 'private-observer-output', texts: [], buttons: [], hasField: false, complete: true } : {}) }); child.close(); await drain();
  };
  const dom = async () => {
    children.at(-1).output({ ok: true, ...SCROLL_ID, result: JSON.stringify({ ok: true, status: 'observed', complete: true, observations: [] }) });
    children.at(-1).close(); await drain();
  };
  const expire = ms => { const entry = [...timers].find(([, value]) => value.ms === ms); assert.ok(entry); timers.delete(entry[0]); entry[1].fn(); };
  return { h, observer, controller, children, start, native, dom, drain, expire, effects };
}

await test('real observer factory graph joins prefix native and DOM work before action without retaining transient data', async () => {
  for (const open of [true, false]) {
    const f = await actualObserverAudit(), pending = f.start();
    assert.equal(f.h.audit.snapshot().scriptAuditComplete, false, 'early snapshot is provisional');
    const result = await normalAuditTrace(f.h, { actionMarkers: true, beforeAction: async () => { await f.native(open); if (!open) await f.dom(); await pending; } });
    assert.equal(result.observerGraph?.complete, true, JSON.stringify(result.gaps));
    assert.equal(result.observerGraph.attempts[0].classification, 'peripheral_before');
    assert.equal(result.scriptAuditComplete, true, JSON.stringify(result.gaps));
    assert.equal(result.observerCompletionUnknown, false);
    assert.equal(result.events.some(row => row.kind === 'observer'), false, 'prefix invocation has no invented outer row');
    for (const secret of ['private-observer-namespace', 'private-observer-output', 'mychrome-observe-', 'PROMPT_OBSERVATION', 'a'.repeat(64)])
      assert.equal(JSON.stringify(result).includes(secret), false, secret);
  }
});

await test('real observer factory normal DOM after action and busy prefix have complete attributed graphs', async () => {
  const after = await actualObserverAudit();
  const result = await normalAuditTrace(after.h, { actionMarkers: true, afterAction: async () => { const p = after.start(); await after.native(); await after.dom(); await p; } });
  assert.equal(result.scriptAuditComplete, true, JSON.stringify(result.gaps));
  assert.equal(result.observerGraph.attempts[0].classification, 'peripheral_after');
  assert.equal(result.observerGraph.attempts[0].facts.length, 13);
  assert.equal(result.events.filter(row => row.kind === 'observer').length, 1, 'outer row retained');
  const busy = await actualObserverAudit(), first = busy.start(), second = busy.start();
  assert.equal((await second).reason, 'child_not_settled');
  const snapshot = await normalAuditTrace(busy.h, { actionMarkers: true, beforeAction: async () => { await busy.native(true); await first; } });
  assert.equal(snapshot.scriptAuditComplete, true, JSON.stringify(snapshot.gaps));
  assert.equal(snapshot.observerCompletionUnknown, true, 'busy content stays unknown');
  assert.equal(snapshot.observerGraph.attempts[1].classification, 'busy_accounted');
  assert.equal(snapshot.observerGraph.attempts[1].holdingAttempt, snapshot.observerGraph.attempts[0].attempt);
});

await test('real native-only tool_start cancellation requires child close and release before first action work', async () => {
  const f = await actualObserverAudit(), pending = f.start();
  const out = await normalAuditTrace(f.h, { actionMarkers: true, atActionStart: async () => {
    f.controller.abort('tool_start'); f.children[0].close(null); assert.equal((await pending).status, 'cancelled');
  } });
  assert.equal(out.scriptAuditComplete, true, JSON.stringify(out.gaps));
  assert.equal(out.observerGraph.complete, true); assert.equal(out.observerCompletionUnknown, true);
  const attempt = out.observerGraph.attempts[0]; assert.equal(attempt.classification, 'native_cancelled_in_action');
  assert.equal(attempt.contentObserved, false);
  const release = attempt.facts.find(f => f.phase === 'released'), first = out.events.find(row => ['eval', 'content', 'native'].includes(row.kind));
  assert.ok(release.order < first.startOrder);
  assert.equal(attempt.facts.some(f => f.kind === 'dom' || f.phase === 'render'), false);
});

await test('real observer normal execution intersecting action and absent action markers remain incomplete', async () => {
  for (const phase of ['inside', 'crossing', 'no-markers']) {
    const f = await actualObserverAudit(), pending = f.start();
    const finish = async () => { await f.native(true); await pending; };
    const out = await normalAuditTrace(f.h, { actionMarkers: phase !== 'no-markers',
      ...(phase === 'inside' ? { atActionStart: finish } : phase === 'crossing' ? { afterAction: finish } : { beforeAction: finish }) });
    assert.equal(out.scriptAuditComplete, false, phase); assert.equal(out.observerGraph.complete, false, phase);
  }
});

await test('real observer missing begin validation spawn close parsed result render write or release never becomes complete', async () => {
  for (const missing of ['begin', 'validated', 'spawn', 'close', 'parsed', 'native_result', 'render', 'write', 'dom_result', 'released']) {
    const f = await actualObserverAudit({ alterFact: fact => fact.phase === missing ? null : fact }), pending = f.start();
    const out = await normalAuditTrace(f.h, { actionMarkers: true, beforeAction: async () => { await f.native(); await f.dom(); assert.equal((await pending).status, 'observed'); } });
    assert.equal(out.scriptAuditComplete, false, missing); assert.equal(out.observerGraph.complete, false, missing);
    assert.ok(out.gaps.some(g => g.startsWith('observer_')), missing);
  }
});

await test('real observer wrong script bytes routes targets and busy owner cannot authorize a graph', async () => {
  const changes = [
    ['validate script', { script: (name, vars) => frozenScript(name, { PROMPT_OBSERVATION: { ...vars.PROMPT_OBSERVATION, mode: 'validate' } }) }],
    ['extra rendered statement', { script: (...args) => frozenScript(...args) + '\n;document.title="private-observer-output";' }],
    ['wrong namespace', { script: () => frozenScript('prompt-observation', { PROMPT_OBSERVATION: { mode: 'observe', namespace: 'different' } }) }],
    ['invalid native route', { alterFact: f => f.phase === 'spawn' && f.kind === 'native' ? { ...f, argv: ['dialog'], argvValid: false } : f }],
    ['foreign native target', { alterFact: f => f.phase === 'spawn' && f.kind === 'native' ? { ...f, argv: ['dialog', '--pid', '10', '--target', JSON.stringify({ chromePid: 10, windowId: 90, tabId: 7, cgWindow: 11 })] } : f }],
    ['foreign DOM path', { alterFact: f => f.phase === 'spawn' && f.kind === 'dom' ? { ...f, argv: [f.argv[0], '/inert/foreign-path', ...f.argv.slice(2)] } : f }],
    ['foreign validated target', { alterFact: f => f.phase === 'validated' ? { ...f, target: { ...f.target, windowId: 90 } } : f }],
    ['wrong child close', { alterFact: f => f.phase === 'close' ? { ...f, child: f.child + 10 } : f }],
  ];
  for (const [label, options] of changes) {
    const f = await actualObserverAudit(options), pending = f.start();
    const out = await normalAuditTrace(f.h, { actionMarkers: true, beforeAction: async () => { await f.native(); await f.dom(); await pending; } });
    assert.equal(out.scriptAuditComplete, false, label); assert.equal(out.observerGraph.complete, false, label);
  }
  const f = await actualObserverAudit({ alterFact: fact => fact.phase === 'rejected' ? { ...fact, holdingAttempt: 99 } : fact });
  const pending = f.start(); await f.start();
  const out = await normalAuditTrace(f.h, { actionMarkers: true, beforeAction: async () => { await f.native(true); await pending; } });
  assert.equal(out.observerGraph.complete, false); assert.equal(out.scriptAuditComplete, false);
});

await test('real killed abnormal or unclosed DOM stays incomplete even with exactly reconstructed script', async () => {
  for (const mode of ['killed', 'abnormal', 'unclosed']) {
    const f = await actualObserverAudit(), pending = f.start(); await f.native();
    const out = await normalAuditTrace(f.h, { actionMarkers: true, atActionStart: async () => {
      if (mode === 'abnormal') f.children[1].close(1);
      else { f.controller.abort('tool_start'); if (mode === 'killed') f.children[1].close(null); else f.expire(250); }
      await pending;
    } });
    assert.equal(out.observerGraph.complete, false, mode); assert.equal(out.scriptAuditComplete, false, mode);
    assert.equal(out.observerGraph.attempts[0].facts.find(f => f.phase === 'render').mapped, true);
    if (mode === 'unclosed') { f.children[1].close(null); await f.drain(); }
  }
});

await test('native cancellation without tool_start cause early release or actual close remains incomplete', async () => {
  for (const mode of ['wrong-reason', 'cause-missing', 'unclosed', 'late-close']) {
    const f = await actualObserverAudit({ alterFact: fact => mode === 'cause-missing' && fact.phase === 'stop' ? { ...fact, toolStart: false } : fact });
    const pending = f.start();
    const out = await normalAuditTrace(f.h, { actionMarkers: true, atActionStart: async () => {
      f.controller.abort(mode === 'wrong-reason' ? 'another_reason' : 'tool_start');
      if (['unclosed', 'late-close'].includes(mode)) f.expire(250); else f.children[0].close(null);
      await pending;
    }, ...(mode === 'late-close' ? { beforeEnd: async () => { f.children[0].close(null); await f.drain(); } } : {}) });
    assert.equal(out.observerGraph.complete, false, mode); assert.equal(out.scriptAuditComplete, false, mode);
    if (mode === 'unclosed') { f.children[0].close(null); await f.drain(); }
  }
});

await test('all worker-init observer attempts and facts remain capped independently of outer rows', async () => {
  for (const [count, dom, expectedOverflow] of [[64, false, false], [65, false, true], [40, true, true]]) {
    const f = await actualObserverAudit();
    for (let i = 0; i < count; i++) { const p = f.start(); await f.native(!dom); if (dom) await f.dom(); await p; }
    const out = await normalAuditTrace(f.h, { actionMarkers: true });
    assert.equal(out.overflow, expectedOverflow, `${count}/${dom}`);
    assert.equal(out.scriptAuditComplete, !expectedOverflow, JSON.stringify(out.gaps));
    assert.ok(out.observerGraph.attempts.length <= 64); assert.ok(out.observerGraph.factCount <= 512);
    assert.ok(out.observerGraph.attempts.every(a => a.facts.length <= 16));
  }
  const f = await actualObserverAudit({ alterFact: fact => fact.phase === 'validated' ? Array(20).fill(fact) : fact }), pending = f.start();
  const out = await normalAuditTrace(f.h, { actionMarkers: true, beforeAction: async () => { await f.native(true); await pending; } });
  assert.equal(out.overflow, true); assert.equal(out.scriptAuditComplete, false); assert.equal(out.observerGraph.attempts[0].facts.length, 16);
});

await test('observer template remains forbidden through ordinary eval and recorder failure cannot alter delegate result', async () => {
  const f = await actualObserverAudit(), pending = f.start();
  const out = await normalAuditTrace(f.h, { actionMarkers: true, beforeAction: async () => { await f.native(); await f.dom(); await pending; },
    beforeEnd: h => h.eval(frozenScript('prompt-observation', { PROMPT_OBSERVATION: { mode: 'observe', namespace: 'private-observer-namespace' } }), 7) });
  assert.equal(out.scriptAuditComplete, false); assert.ok(out.gaps.includes('eval_unmapped'));
  let n = 0;
  const broken = await actualObserverAudit({ auditOptions: { now: () => { if (++n === 3) throw Error('private-observer-recorder'); return n; } } });
  const original = broken.start(); await broken.native(true); assert.equal((await original).status, 'observed');
  const result = await normalAuditTrace(broken.h, { actionMarkers: true });
  assert.equal(result.recordingFailed, true); assert.equal(result.scriptAuditComplete, false);
  assert.equal(JSON.stringify(result).includes('private-observer-recorder'), false);
});

await test('normal audit independently reconstructs pinned block, locate-scroll and repeated measure executions', async () => {
  const h = auditFixture(), snapshot = await normalAuditTrace(h, { measureRepeats: 2 });
  const edited = await normalAuditTrace(auditFixture({ sources: { ...scrollSources, 'src/guard.js': scrollSources['src/guard.js'] + '\n// changed' } }));
  assert.equal(edited.scriptAuditComplete, true, 'edited source is recorded, not rejected');
  assert.equal(edited.sourceSha256['src/guard.js'], digest(scrollSources['src/guard.js'] + '\n// changed'));
  for (const file of Object.keys(scrollHelpers.SCROLL_SOURCE_PINS)) assert.equal(snapshot.sourceSha256[file], digest(scrollSources[file]), `receipt records current hash of ${file}`);
  assert.equal(snapshot.scriptAuditComplete, true, JSON.stringify(snapshot.gaps));
  assert.equal(snapshot.boundedNativeRequestsObserved, true, JSON.stringify(snapshot.gaps));
  assert.equal(snapshot.identityObserved, true);
  const evaluations = snapshot.events.filter(e => e.kind === 'eval');
  assert.deepEqual(evaluations.map(e => e.template), ['block', 'locate-scroll', 'locate-measure', 'locate-measure']);
  assert.deepEqual(evaluations.map(e => e.hash), [digest(frozenScript('block')), digest(frozenScript('locate', LOCATE_SCROLL)),
    digest(frozenScript('locate', LOCATE_MEASURE)), digest(frozenScript('locate', LOCATE_MEASURE))]);
  assert.equal(h.effects.filter(e => e.type === 'pageScript').length, 3);
  assert.equal(h.effects.filter(e => e.type === 'eval').length, 4);
  assert.equal(h.effects.filter(e => e.type === 'request').length, 4);
  assert.equal(h.effects.filter(e => e.type === 'open').length, 1);
  for (const event of h.effects) assert.equal(event.receiver, event.type === 'request' ? h.session : h.receiver);
  assert.ok(snapshot.events.every(e => Number.isFinite(e.startMs) && Number.isFinite(e.endMs) && e.endMs >= e.startMs));
  assert.equal(snapshot.clock, 'worker-monotonic-ms');
  assert.deepEqual(snapshot.events.filter(e => e.kind === 'native').map(e => e.requestSequence), [1, 2, 3, 4]);
  assert.equal(snapshot.wheelBursts, 1); assert.equal(snapshot.wheelNotches, 2);
  assert.equal(snapshot.wheelToMeasureMs.length, 1); assert.ok(snapshot.wheelToMeasureMs[0] >= 0);
});

await test('R1 rejects wrong block bytes vars tab options, attached setters and generated-only templates', async () => {
  for (const options of [{ omitBlockEval: true }, { blockArgs: [{}] }, { blockArgs: [{ EXTRA: true }] },
    { blockEvalArgs: [8, { lean: true }] }, { blockEvalArgs: [7] }, { blockEvalArgs: [7, { lean: false }] },
    { blockEvalArgs: [7, { lean: true, extra: true }] }, { omitMeasureEval: true }]) {
    const h = auditFixture(); const snapshot = await normalAuditTrace(h, options);
    assert.equal(snapshot.scriptAuditComplete, false, JSON.stringify(options));
  }
  for (const name of ['block', 'locate']) {
    const h = auditFixture({ page: async (...args) => frozenScript(...args) + (args[0] === name ? '\n;document.scrollingElement.scrollTop=99;' : '') });
    assert.equal((await normalAuditTrace(h)).scriptAuditComplete, false, name);
  }
  for (const file of ['src/page/block.js', 'src/page/locate.js']) {
    const h = auditFixture({ sources: { ...scrollSources, [file]: scrollSources[file] + '\n// drift' } });
    assert.equal((await normalAuditTrace(h)).scriptAuditComplete, false, file);
  }
  const unknown = auditFixture();
  assert.equal((await normalAuditTrace(unknown, { beforeEnd: h => h.eval('inert unknown script sentinel', 7) })).scriptAuditComplete, false);
  for (const value of [null, {}, { ok: false }]) {
    const malformed = auditFixture({ evaluate: async script => script === frozenScript('block') ? value
      : { ok: true, scroller: 'document', scrollTop: 600, max: 4000 } });
    assert.equal((await normalAuditTrace(malformed)).scriptAuditComplete, false);
  }
  const scrollby = auditFixture();
  assert.equal((await normalAuditTrace(scrollby, { beforeEnd: async h => h.eval(await h.page('scrollby', {}), 7) })).scriptAuditComplete, false);
});

await test('R2 prior non-observed observer completion remains unknown across clean results and window boundaries', async () => {
  for (const outcome of [{ status: 'cancelled' }, { status: 'unavailable', reason: 'child_not_settled' },
    { status: 'unavailable' }, { status: 'unexpected' }, null, {}, 'observed', { status: 'observed', complete: true, get observedAt() { throw Error('recorder read failure'); }, observations: [] }]) {
    let first = true;
    const h = auditFixture({ observe: async () => { if (first) { first = false; return outcome; } return { status: 'observed', complete: true, observedAt: 1, observations: [] }; } });
    const returned = await h.observer({ inert: true }); assert.equal(returned, outcome);
    await h.observer({ inert: true });
    const snapshot = await normalAuditTrace(h);
    assert.equal(snapshot.scriptAuditComplete, false, typeof outcome?.status === 'string' ? outcome.status : 'malformed');
    assert.equal(snapshot.observerCompletionUnknown, true);
    h.audit.begin(); h.audit.end();
    assert.equal(h.audit.snapshot().observerCompletionUnknown, true);
  }
  const failure = Error('inert private observer exception'), rejected = auditFixture({ observe: async () => { throw failure; } });
  await assert.rejects(rejected.observer(), e => e === failure);
  assert.equal((await normalAuditTrace(rejected)).scriptAuditComplete, false);
  const clean = auditFixture(); await clean.observer();
  assert.equal((await normalAuditTrace(clean)).scriptAuditComplete, true);
});

await test('observer overlap and pre-window eval flights, overflow and recorder failure cannot become complete', async () => {
  for (const kind of ['observer', 'eval']) {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const h = auditFixture(kind === 'observer' ? { observe: () => promise } : { evaluate: () => promise });
    const pending = kind === 'observer' ? h.observer() : h.eval('pre-window inert sentinel', 7);
    h.audit.begin(); resolve(kind === 'observer' ? { status: 'observed', complete: true, observedAt: 1, observations: [] } : {}); await pending; h.audit.end();
    assert.equal(h.audit.snapshot().scriptAuditComplete, false, kind);
  }
  const overflow = auditFixture({ limit: 8 });
  const full = await normalAuditTrace(overflow, { measureRepeats: 20 });
  assert.equal(full.overflow, true); assert.equal(full.scriptAuditComplete, false); assert.ok(full.events.length <= 8);
  let clock = 0;
  const broken = auditFixture({ now: () => { if (++clock > 3) throw Error('private recorder clock failure'); return clock; } });
  const brokenSnapshot = await normalAuditTrace(broken);
  assert.equal(brokenSnapshot.recordingFailed, true); assert.equal(brokenSnapshot.scriptAuditComplete, false);
  assert.equal(broken.effects.filter(e => e.type === 'eval').length, 3);
  assert.equal(broken.effects.filter(e => e.type === 'request').length, 4);
});

await test('every wrapper delegates once with identical this arguments options returned values and exception objects', async () => {
  for (const kind of ['page', 'eval', 'content', 'observer', 'open', 'native']) {
    const value = { inert: kind }, failure = Error(`private ${kind}`);
    for (const rejects of [false, true]) {
      let calls = 0, receivedThis, receivedArgs;
      const delegate = function (...args) { calls++; receivedThis = this; receivedArgs = args; if (rejects) throw failure; return value; };
      const audit = scrollHelpers.createScrollAudit({ sources: scrollSources, now: () => 10 }); audit.bind(SCROLL_ID);
      const method = { page: 'wrapPageScript', eval: 'wrapEvalInPage', content:'wrapPageContentRect', observer: 'wrapObserver', open: 'wrapOpenInputSession' }[kind];
      const receiver = { receiver: kind }, args = [{ sentinel: 'first' }, 7, { options: 'same-object' }];
      if (kind === 'native') {
        const session = { pid: 42, request: delegate }; const wrapped = audit.wrapOpenInputSession(() => session);
        assert.equal(wrapped(), session);
        if (rejects) await assert.rejects(async () => session.request.apply(receiver, args), e => e === failure);
        else assert.equal(await session.request.apply(receiver, args), value);
      } else {
        const wrapped = audit[method](delegate);
        if (rejects) await assert.rejects(async () => wrapped.apply(receiver, args), e => e === failure);
        else assert.equal(await wrapped.apply(receiver, args), value);
      }
      assert.equal(calls, 1, kind); assert.equal(receivedThis, receiver);
      receivedArgs.forEach((arg, index) => assert.equal(arg, args[index], `${kind}/${index}`));
    }
  }
});

await test('native routes retain only bounded numeric enums and reject unknown op kind schema shape or identity', async () => {
  const invalid = [{ op: 'eval', script: 'private-script' }, { op: 'wheel', dir: 'down', notches: '2' },
    { op: 'wheel', dir: 'down', notches: 2, raw: 'private-extra' },
    { op: 'nativeChrome', schema: 2, operationId: 'native-2', epoch: 1, policy: 'normal', intent: { kind: 'activate', tabId: 7, windowId: 9 } },
    { op: 'nativeChrome', schema: 1, operationId: 'native-2', epoch: 1, policy: 'normal', intent: { kind: 'executeJavascript', script: 'private-script' } },
    { op: 'nativeChrome', schema: 1, operationId: 'native-2', epoch: 1, policy: 'normal', intent: { kind: 'activate', tabId: 8, windowId: 9 } }];
  for (const request of invalid) {
    const h = auditFixture();
    const result = await normalAuditTrace(h, { beforeEnd: (_h, session) => session.request(request) });
    assert.equal(result.scriptAuditComplete, false, JSON.stringify(request));
    assert.equal(result.boundedNativeRequestsObserved, false, JSON.stringify(request));
    assert.ok(!JSON.stringify(result).includes('private-'));
  }
  const h = auditFixture({ evaluate: async (_script) => _script === frozenScript('block')
    ? { ok: true, blocked: { evidence: 'private-evidence', error: 'private-error' }, secret: 'private-value' }
    : { ok: true, scroller: 'document', scrollTop: 600, max: 4000, url: 'private-url', token: 'private-token', text: 'private-text' } });
  const snapshot = await normalAuditTrace(h);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['private-', 'native-1', 'operationId', 'epoch', 'scrollingElement.scrollTop', 'Fixture count']) assert.ok(!serialized.includes(secret), secret);
});



async function orderedGeometryTrace(helpers, mode, now) {
  let resolveFit, resolveB, resolveContent, locateReads = 0;
  const delayedFit = ['fit-completes-after-A','unchanged-fit-completes-after-A','unchanged-fit-completes-after-input'].includes(mode);
  const withoutProof = ['raw','unchanged-fit-completes-after-input'].includes(mode);
  const changed = !mode.startsWith('unchanged-');
  const fitReply = {ok:true,schema:1,epoch:1,operationId:'native-1',inputDelivery:'sent',targetOnTop:true,keyWindowIsTarget:true,...SCROLL_ID,
    bounds:{...AUDIT_BOUNDS},geometry:{mode:'fit-current',beforeBounds:changed?{left:-100,top:40,width:900,height:700}:{...AUDIT_BOUNDS},displayId:1,branch:'usable',changed,possiblyChanged:changed}};
  const locateReply = {ok:true,scroller:'document',scrollTop:600,max:4000,target:{tabId:7,windowId:9},bounds:{...AUDIT_BOUNDS},
    view:{outerWidth:900,outerHeight:700,innerWidth:900,innerHeight:612}};
  const h = auditFixture({helpers,now,native(request) {
    if(request.op==='nativeChrome') {
      if(delayedFit) return new Promise(resolve=>{resolveFit=resolve;});
      if(mode==='raw') {const {bounds,geometry,...raw}=fitReply;return Promise.resolve(raw);}
      return Promise.resolve(fitReply);
    }
    return Promise.resolve(request.op==='wheel'?{ok:true,sent:request.notches}:{ok:true,held:true});
  },content() {
    if(mode==='AX-completes-after-B') return new Promise(resolve=>{resolveContent=resolve;});
    return Promise.resolve(structuredClone(AUDIT_CONTENT));
  },evaluate(script) {
    if(script===frozenScript('block')) return {ok:true,blocked:null};
    if(script===frozenScript('locate',LOCATE_SCROLL)) {
      if(++locateReads===2&&mode==='input-before-B-completes') return new Promise(resolve=>{resolveB=resolve;});
      return structuredClone(locateReply);
    }
    return {ok:true,scrollTop:600,max:4000};
  }});
  const session=h.open({inert:true});h.audit.begin();
  await h.eval(await h.page('block'),7,{lean:true});
  const fit=session.request({op:'nativeChrome',schema:1,operationId:'native-1',epoch:1,policy:'normal',
    intent:{kind:'activate',tabId:7,windowId:9,...(mode==='raw'?{}:{fitCurrent:true})}});
  if(!delayedFit)await fit;
  const move=()=>session.request({op:'move',to:{x:100,y:150},rect:{x:90,y:140,w:20,h:20}});
  const wheel=()=>session.request({op:'wheel',dir:'down',notches:2});
  if(mode==='move-before-proof')await move();
  if(mode==='wheel-before-proof')await wheel();
  const loc=await h.page('locate',LOCATE_SCROLL),options={exactTarget:Object.fromEntries(['chromePid','cgWindow','windowId','tabId'].map(k=>[k,SCROLL_ID[k]]))};
  await h.eval(loc,7,...(withoutProof?[]:[options]));
  if(mode==='unchanged-fit-completes-after-input')await move();
  if(delayedFit){resolveFit(fitReply);await fit;}
  if(!withoutProof) {
    const content=h.content({chromePid:SCROLL_ID.chromePid,cgWindow:SCROLL_ID.cgWindow});
    if(mode!=='AX-completes-after-B')await content;
    const b=h.eval(loc,7,options);
    if(mode==='input-before-B-completes'){await move();resolveB(structuredClone(locateReply));}
    await b;
    if(mode==='AX-completes-after-B'){resolveContent(structuredClone(AUDIT_CONTENT));await content;}
  }
  await move();await wheel();await h.eval(await h.page('locate',LOCATE_MEASURE),7);
  h.audit.end();return h.audit.snapshot();
}

await test('geometry proof completes after fit and before every coordinate input; raw activation remains observable',async()=>{
  const expected={healthy:true,raw:true,'move-before-proof':false,'wheel-before-proof':false,'fit-completes-after-A':false,
    'unchanged-fit-completes-after-A':false,'unchanged-fit-completes-after-input':false,'input-before-B-completes':false};
  const actual={};
  for(const mode of Object.keys(expected)) {
    const snapshot=await orderedGeometryTrace(scrollHelpers,mode);
    actual[mode]=snapshot.scriptAuditComplete;
    console.log(JSON.stringify({geometryOrder:mode,complete:snapshot.scriptAuditComplete,gaps:snapshot.gaps}));
  }
  assert.deepEqual(actual,expected);
});

await test('equal clocks preserve healthy serial proof and reject reversed fit AX or B completion',async()=>{
  const expected={healthy:true,raw:true,'fit-completes-after-A':false,'unchanged-fit-completes-after-A':false,
    'unchanged-fit-completes-after-input':false,'input-before-B-completes':false,'AX-completes-after-B':false};
  const actual={};
  for(const mode of Object.keys(expected)) {
    const snapshot=await orderedGeometryTrace(scrollHelpers,mode,()=>10);
    assert.equal(snapshot.recordingFailed,false,mode);
    assert.ok(snapshot.events.every(row=>row.startMs===10&&row.endMs===10),mode+' tied clock');
    actual[mode]=snapshot.scriptAuditComplete;
    console.log(JSON.stringify({equalClockGeometryOrder:mode,complete:snapshot.scriptAuditComplete,gaps:snapshot.gaps}));
  }
  assert.deepEqual(actual,expected);
});

await test('geometry audit observes the closed fit and complete A/AX/B graph', async () => {
  for (const intent of [{kind:'activate',tabId:7,windowId:9,fitCurrent:true},{kind:'moveWindow',windowId:9,fitCurrent:true}]) {
    const h=auditFixture({geometryChanged:true}),out=await normalAuditTrace(h,{corroboration:true,nativeIntent:intent});
    assert.equal(out.scriptAuditComplete,true,JSON.stringify(out.gaps));assert.equal(out.identityObserved,true);
    assert.equal(h.effects.filter(e=>e.type==='content').length,1);assert.equal(out.events.filter(e=>e.kind==='content').length,1);
    assert.deepEqual(out.events.filter(e=>e.kind==='eval'&&e.exactTarget).map(e=>e.geometry.bounds),[{x:30,y:40,w:900,h:700},{x:30,y:40,w:900,h:700}]);
  }
  for (const option of [{},{corroboration:true,omitContent:true},{corroboration:true,omitB:true},
    {corroboration:true,exactOptions:{exactTarget:{...SCROLL_ID,windowId:99}}},
    {corroboration:true,exactOptions:{exactTarget:SCROLL_ID,lean:true}}]) {
    const out=await normalAuditTrace(auditFixture({geometryChanged:true}),option);
    assert.equal(out.scriptAuditComplete,false,JSON.stringify(option));
  }
  for (const intent of [{kind:'activate',tabId:7,windowId:9,fitCurrent:false},{kind:'activate',tabId:7,windowId:9,unexpected:true},
    {kind:'moveWindow',windowId:9,fitCurrent:true,displayId:1},{kind:'moveWindow',windowId:9,fitCurrent:true,bounds:AUDIT_BOUNDS}]) {
    assert.equal((await normalAuditTrace(auditFixture(),{nativeIntent:intent})).scriptAuditComplete,false);
  }
});
await test('AX content identity geometry rejection overlap and pending cannot manufacture audit completeness',async()=>{
  for (const patch of [()=>null,v=>({...v,source:'guess'}),v=>({...v,pid:v.pid+1}),v=>({...v,cgWindow:v.cgWindow+1}),
    v=>({...v,rect:{...v.rect,x:v.rect.x+10}}),v=>({...v,windowBounds:{...v.windowBounds,w:800}})]) {
    const out=await normalAuditTrace(auditFixture({geometryChanged:true,content:()=>patch(structuredClone(AUDIT_CONTENT))}),{corroboration:true});
    assert.equal(out.scriptAuditComplete,false);
  }
  const failure=Error('inert content refusal');
  const h=auditFixture({content:()=>{throw failure;}});
  const out=await normalAuditTrace(h,{beforeEnd:async h=>{await assert.rejects(async()=>h.content({chromePid:SCROLL_ID.chromePid,cgWindow:SCROLL_ID.cgWindow}),e=>e===failure);}});
  assert.equal(out.scriptAuditComplete,false);
  for (const mode of ['pending','overlap']) {
    let resolve;const promise=new Promise(r=>{resolve=r;}),h=auditFixture({content:()=>promise});let observed;
    const out=await normalAuditTrace(h,{beforeEnd:async h=>{
      observed=h.content({chromePid:SCROLL_ID.chromePid,cgWindow:SCROLL_ID.cgWindow});
      assert.equal(observed,promise,'wrapper preserves exact pending promise');
      if(mode==='overlap'){await h.eval(await h.page('locate',LOCATE_MEASURE),7);resolve(AUDIT_CONTENT);await observed;}
    }});
    assert.equal(out.scriptAuditComplete,false,mode);resolve(AUDIT_CONTENT);await observed;
  }
  const expected=Promise.resolve(AUDIT_CONTENT),delegate=()=>expected;
  const audit=scrollHelpers.createScrollAudit({sources:scrollSources});
  assert.equal(audit.wrapPageContentRect(delegate)({chromePid:42,cgWindow:70}),expected);
});

await test('fixed scroll fixture and sampler execute only passive counters and exact own-document reads in inert VM', () => {
  const token = 'fixture-vm', url = `http://127.0.0.1/fixture-${token}`;
  const listeners = new Map(), nodes = new Map(['tick', 'field', 'prompt', 'alert', 'confirm'].map(id => [id, { id }]));
  const stateMeta = { content: '{}' }, tokenMeta = { content: token };
  const scroller = { scrollTop: 0, scrollHeight: 4800 };
  let time = 1;
  const document = { scrollingElement: scroller,
    querySelector: selector => selector === 'meta[name="fixture-state"]' ? stateMeta : selector === 'meta[name="fixture-token"]' ? tokenMeta : null,
    getElementById: id => nodes.get(id),
    addEventListener: (type, fn, options) => { const list = listeners.get(type) || []; list.push({ fn, options }); listeners.set(type, list); } };
  const context = vm.createContext({ document, location: { href: url }, window: { __chromeBridge: { url, markers: [null, nodes.get('tick')] } },
    performance: { now: () => time++ }, innerHeight: 800, Date, JSON, Set });
  const html = scrollHelpers.scrollFixtureHTML(token), script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.equal(typeof script, 'string'); vm.runInContext(script, context);
  let state = JSON.parse(stateMeta.content);
  assert.equal(state.wheel, 0); assert.equal(state.scrollEvents, 0); assert.equal(state.clicks, 0); assert.equal(scroller.scrollTop, 0);
  for (const type of ['wheel', 'scroll']) assert.equal(listeners.get(type)[0].options.passive, true);
  listeners.get('wheel')[0].fn({ isTrusted: true }); listeners.get('wheel')[0].fn({ isTrusted: false });
  listeners.get('scroll')[0].fn();
  state = JSON.parse(stateMeta.content);
  assert.equal(state.wheel, 2); assert.equal(state.trustedWheel, 1); assert.equal(state.untrustedWheel, 1); assert.equal(state.scrollEvents, 1);
  assert.equal(state.input, 0); assert.equal(state.keydown, 0); assert.equal(state.keyup, 0); assert.equal(scroller.scrollTop, 0);
  const sampler = scrollHelpers.scrollSamplerScript({ url, token, markerId: 'tick' });
  const result = JSON.parse(vm.runInContext(sampler, context));
  assert.equal(result.ok, true); assert.equal(result.marker, 1); assert.equal(result.state.scrollY, 0); assert.equal(result.state.maxScrollY, 4000);
  assert.equal(result.state.innerHeight, 800); assert.equal(result.state.wheel, 2); assert.equal(scroller.scrollTop, 0);
  tokenMeta.content = 'other'; assert.equal(JSON.parse(vm.runInContext(sampler, context)).ok, false);
  tokenMeta.content = token; context.location.href = 'http://127.0.0.1/other'; assert.equal(JSON.parse(vm.runInContext(sampler, context)).ok, false);
  for (const fields of ['inert raw script', { url, token, extra: true }, { url, token, markerId: undefined },
    { url, token, markerId: 'field' }, { url: 'https://example.invalid', token }, { url: url + '?secret=1', token },
    { url, token: 'wrong' }, { url, token: '</script>' }]) assert.throws(() => scrollHelpers.scrollSamplerScript(fields));
  const audit = scrollHelpers.createScrollAudit({ sources: scrollSources });
  audit.sampler({ url, token, markerId: 'tick' });
  const metadata = audit.snapshot().samplers[0];
  assert.equal(metadata.hash, digest(sampler)); assert.equal(metadata.length, Buffer.byteLength(sampler));
  assert.equal(metadata.generatorHash, digest(scrollHelpers.scrollSamplerScript.toString()));
  assert.equal(JSON.stringify(audit.snapshot()).includes(token), false); assert.equal(JSON.stringify(audit.snapshot()).includes(url), false);
  const malformed = scrollHelpers.createScrollAudit({ sources: scrollSources });
  assert.equal(malformed.sampler('inert raw script'), null); assert.equal(malformed.snapshot().recordingFailed, true);
});

await test('native receipt gaps monotonic measurement and fixed wheel bound remain explicitly unobserved', async () => {
  for (const changes of [{ sent: undefined }, { sent: '2' }, { ok: false }]) {
    const h = auditFixture(); const request = h.original.openInputSession().request;
    h.session.request = function (req, ...rest) {
      if (req.op === 'wheel') return Promise.resolve({ ok: true, sent: 2, ...changes });
      return request.call(this, req, ...rest);
    };
    assert.equal((await normalAuditTrace(h)).scriptAuditComplete, false, JSON.stringify(changes));
  }
  for (const key of ['chromePid', 'windowId', 'tabId', 'cgWindow', 'targetOnTop', 'keyWindowIsTarget']) {
    const h = auditFixture({ native: async req => req.op === 'nativeChrome'
      ? { ok: true, inputDelivery: 'sent', ...SCROLL_ID, targetOnTop: true, keyWindowIsTarget: true, [key]: null }
      : req.op === 'wheel' ? { ok: true, sent: 2 } : req.op === 'veil' ? { ok: true, held: true } : { ok: true } });
    const result = await normalAuditTrace(h); assert.equal(result.identityObserved, false, key); assert.equal(result.scriptAuditComplete, false, key);
  }
  for (const result of [null, {}, { ok: true, scrollTop: NaN, max: 4000 }, { ok: true, scrollTop: 4001, max: 4000 }]) {
    const h = auditFixture({ evaluate: async script => script === frozenScript('block') ? { ok: true }
      : script === frozenScript('locate', LOCATE_SCROLL) ? { ok: true, scroller: 'document', scrollTop: 0, max: 4000 } : result });
    assert.equal((await normalAuditTrace(h)).scriptAuditComplete, false);
  }
  const nonDocument = auditFixture({ evaluate: async script => script === frozenScript('block') ? { ok: true }
    : { ok: true, scroller: 'nested', scrollTop: 600, max: 4000 } });
  assert.equal((await normalAuditTrace(nonDocument)).scriptAuditComplete, false);
  const many = auditFixture();
  const result = await normalAuditTrace(many, { beforeEnd: async (_h, session) => {
    for (let i = 0; i < 40; i++) await session.request({ op: 'wheel', dir: 'down', notches: 1 });
  } });
  assert.equal(result.wheelBursts, 41); assert.equal(result.scriptAuditComplete, false); assert.equal(result.boundedNativeRequestsObserved, false);
  for (const now of [() => NaN, () => Infinity, (() => { let n = 100; return () => --n; })()]) {
    const h = auditFixture({ now }); assert.equal((await normalAuditTrace(h)).scriptAuditComplete, false);
  }
});

await test('wrapper sidecars preserve original Promise identities and cannot replace an unwrappable Session', async () => {
  const audit = scrollHelpers.createScrollAudit({ sources: scrollSources });
  for (const method of ['wrapPageScript', 'wrapEvalInPage', 'wrapObserver']) {
    const returned = Promise.resolve({ inert: method }); const wrapped = audit[method](() => returned);
    assert.equal(wrapped('inert sentinel'), returned); await returned;
  }
  let calls = 0; const result = { ok: true }, session = Object.freeze({ pid: 42, request: () => { calls++; return result; } });
  assert.equal(audit.wrapOpenInputSession(() => session)(), session);
  assert.equal(session.request({ op: 'status' }), result); assert.equal(calls, 1);
  assert.equal(audit.snapshot().recordingFailed, true); assert.equal(audit.snapshot().observerCompletionUnknown, true);
  const before = scrollAfter({ sampledAt: 20 });
  for (const after of [scrollAfter({ sampledAt: 19 }), scrollAfter({ firstWheelAt: 14 }), scrollAfter({ lastWheelAt: 15 }),
    scrollAfter({ wheel: 1, trustedWheel: 1 }), scrollAfter({ identity: {} })]) assert.equal(scrollHelpers.scrollSampleValid(after, before), false);
});

function scrollCaseFake({ before = scrollBefore(), after = scrollAfter(), initial = scrollBefore({ clicks: 0, sampledAt: 1 }), failure = null } = {}) {
  const effects = [], state = {}; let samples = 0;
  return { state, effects, check: (name, expected, actual) => assert.deepEqual(actual, expected, name),
    plan: async () => effects.push('plan'), open: async () => { effects.push('open'); return 7; },
    click: async (tab, marker) => { assert.equal(tab, 7); assert.equal(marker, 'tick'); effects.push('tick'); },
    observe: async () => { effects.push('hold'); return { takeover: { active: true }, lease: { owned: true } }; },
    sample: async tab => { assert.equal(tab, 7); effects.push('sample'); return [initial, before, after][samples++]; },
    scroll: async tab => { assert.equal(tab, 7); effects.push('scroll'); if (failure) throw failure; } };
}

await test('actual scroll case has exact protected setup, one action and after sample with precondition refusal', async () => {
  const h = scrollCaseFake(); await executeCase('scroll-document', h);
  assert.deepEqual(h.effects, ['plan', 'open', 'sample', 'tick', 'hold', 'sample', 'scroll', 'sample']);
  assert.deepEqual(h.state.documentScrollEvidence, { documentScrollObserved: true, identityObserved: true });
  for (const before of [scrollBefore({ maxScrollY: 500 }), scrollBefore({ sampledAt: NaN }), scrollBefore({ clicks: 2 })]) {
    const bad = scrollCaseFake({ before }); await assert.rejects(executeCase('scroll-document', bad), e => e.code === 'ERR_ASSERTION');
    assert.equal(bad.effects.includes('scroll'), false);
  }
  const failure = Error('terminal scroll'); const stopped = scrollCaseFake({ failure });
  await assert.rejects(executeCase('scroll-document', stopped), e => e === failure);
  assert.deepEqual(stopped.effects, ['plan', 'open', 'sample', 'tick', 'hold', 'sample', 'scroll']);
});

await test('actual parent and worker gates independently refuse foreign modes parameters and second scroll before delegation', async () => {
  for (const mode of CASES.filter(mode => mode !== 'scroll-document')) {
    const parent = await actualCallHarness(mode, {});
    await assert.rejects(parent.invoke(parent.worker, 'scroll', SCROLL_ARGS), /scroll_mode_refused/); assert.deepEqual(parent.effects, []);
    const worker = await actualWorkerHarness({ mode });
    await assert.rejects(worker.dispatch({ op: 'call', id: 1, name: 'scroll', args: SCROLL_ARGS }), /scroll_mode_refused/); assert.deepEqual(worker.effects, []);
  }
  for (const args of [{ ...SCROLL_ARGS, tab: 8 }, { ...SCROLL_ARGS, amount: 2 }, { ...SCROLL_ARGS, direction: 'up' }, { ...SCROLL_ARGS, extra: true }]) {
    const parent = await actualCallHarness('scroll-document', {});
    await assert.rejects(parent.invoke(parent.worker, 'scroll', args), /scroll_/); assert.deepEqual(parent.effects, []);
    const worker = await actualWorkerHarness({ mode: 'scroll-document' });
    await assert.rejects(worker.dispatch({ op: 'call', id: 1, name: 'scroll', args }), /scroll_/); assert.deepEqual(worker.effects, []);
  }
  const parent = await actualCallHarness('scroll-document', {});
  await parent.invoke(parent.worker, 'scroll', SCROLL_ARGS);
  await assert.rejects(parent.invoke(parent.worker, 'scroll', SCROLL_ARGS), /scroll_already_attempted/);
  assert.deepEqual(parent.effects, ['scroll']);
  const worker = await actualWorkerHarness({ mode: 'scroll-document' });
  await worker.dispatch({ op: 'call', id: 1, name: 'scroll', args: SCROLL_ARGS });
  await assert.rejects(worker.dispatch({ op: 'call', id: 2, name: 'scroll', args: SCROLL_ARGS }), /scroll_already_attempted/);
  assert.deepEqual(worker.effects, ['registry_read', 'browser_read', 'tool_dispatch']);
});

await test('actual scroll worker window covers dispatch until normal return and identity changes never replace original quartet', async () => {
  const auditCalls = [], audit = { bind: () => auditCalls.push('bind'), begin: () => auditCalls.push('begin'), actionStart: () => auditCalls.push('actionStart'), actionEnd: () => auditCalls.push('actionEnd'), end: () => auditCalls.push('end') };
  const healthy = await actualWorkerHarness({ mode: 'scroll-document', audit, toolReply: () => { auditCalls.push('tool'); return {}; } });
  await healthy.dispatch({ op: 'call', id: 1, name: 'scroll', args: SCROLL_ARGS });
  assert.deepEqual(auditCalls, ['begin', 'bind', 'actionStart', 'tool', 'actionEnd', 'end']);
  assert.deepEqual(healthy.controllerDeletionStates, [null]);
  for (const key of ['chromePid', 'windowId', 'tabId', 'cgWindow']) {
    const h = await actualWorkerHarness({ mode: 'scroll-document' }); const original = h.fixtures.get(7);
    h.setInfo({ [key]: SCROLL_ID[key] + 1 });
    await assert.rejects(h.dispatch({ op: 'sample', tab: 7 }), /fixture_identity_changed/);
    assert.equal(h.fixtures.get(7), original, key); assert.equal(h.workerState.terminal, 'fixture_identity_changed');
    const after = [...h.effects];
    for (const op of ['sample', 'own', 'call'])
      await assert.rejects(h.dispatch({ op, id: 3, tab: 7, name: 'close_tab', args: { tab: 7 } }), /fixture_identity_changed/);
    assert.deepEqual(h.effects, after, key);
  }
  for (const replacement of ['replaceHold', 'replaceSession', 'replaceLease', 'release', 'pause']) {
    const h = await actualWorkerHarness({ mode: 'scroll-document' }); h[replacement]();
    await assert.rejects(h.dispatch({ op: 'call', id: 1, name: 'scroll', args: SCROLL_ARGS }), /original_|paused_by_user/);
    assert.equal(h.effects.includes('tool_dispatch'), false, replacement);
  }
});

await test('scroll product transport Stop malformed replies seal actual call and worker before deletion with zero cleanup continuation', async () => {
  const rejected = async () => { throw Object.assign(Error('lost scroll'), { code: 'worker_exited' }); };
  for (const reply of [rejected, null, 'malformed', { isError: true },
    { isError: true, structuredContent: { error: { code: 'user_cancelled' } } },
    { isError: true, structuredContent: { error: { code: 'native_interruption' } } }]) {
    const h = await actualCallHarness('scroll-document', reply);
    await assert.rejects(h.invoke(h.worker, 'scroll', SCROLL_ARGS));
    assert.ok(h.state.terminal); assert.deepEqual(h.deletionStates, [h.state.terminal]);
    const effects = [...h.effects];
    await assert.rejects(h.invoke(h.worker, 'scroll', SCROLL_ARGS));
    await assert.rejects(h.read(h.worker, 'sample', { tab: 7 }));
    await assert.rejects(h.invoke(h.worker, 'task_plan', { done: true }));
    await cleanupFixtures(finalizer(h)); assert.deepEqual(h.effects, effects);
    assert.equal(h.effects.filter(e => e === 'scroll').length, 1);
    const worker = await actualWorkerHarness({ mode: 'scroll-document', toolReply: reply });
    await assert.rejects(worker.dispatch({ op: 'call', id: 1, name: 'scroll', args: SCROLL_ARGS }));
    assert.ok(worker.workerState.terminal); assert.deepEqual(worker.controllerDeletionStates, [worker.workerState.terminal]);
    assert.equal(worker.scrollAudit.snapshot().window.endMs, null);
    const before = [...worker.effects];
    await assert.rejects(worker.dispatch({ op: 'sample', tab: 7 }));
    await assert.rejects(worker.dispatch({ op: 'call', id: 2, name: 'task_plan', args: { done: true } }));
    assert.deepEqual(worker.effects, before);
  }
  const h = await actualCallHarness('scroll-document', rejected,
    text => replaceScroll(text, "abort('dispatched_rpc_rejected');", '/* in-memory seal removal */'));
  await assert.rejects(h.invoke(h.worker, 'scroll', SCROLL_ARGS), /dispatched_rpc_rejected/);
  killed('actual scroll rejection seal before inflight deletion', () => assert.equal(h.deletionStates[0], 'dispatched_rpc_rejected'));
});


await test('normal scroll uses the unchanged original-hold close gone done and final-scene cleanup order', async () => {
  const h = await actualCallHarness('scroll-document', {});
  await h.invoke(h.worker, 'scroll', SCROLL_ARGS);
  await cleanupFixtures(finalizer(h, { readWorker: async (_worker, op) => {
    h.effects.push(op); return op === 'gone' ? { gone: true } : { exact: true, closable: true, tabId: 7, windowId: 9 };
  } }));
  assert.deepEqual(h.effects, ['scroll', 'observe', 'own', 'close_tab', 'gone', 'observe', 'task_plan', 'observe']);
  assert.equal(h.worker.completed, true); assert.equal(h.state.terminal, null);
});

await test('valid helper mutants lose finite identity offset trusted-wheel mode and one-attempt protections', async () => {
  const absent = await actualScrollHelpers(text => replaceScroll(text, "} else if (mode === 'scroll-document') {", "} else if (mode === 'missing-scroll-capability') {"));
  const missing = scrollCaseFake(); await absent.executeCase('scroll-document', missing);
  killed('new-feature missing scroll capability', () => assert.equal(missing.effects.includes('scroll'), true));
  const finite = await actualScrollHelpers(text => replaceScroll(text,
    "const scrollNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;",
    "const scrollNumber = value => typeof value === 'number';"));
  killed('finite sample', () => assert.equal(finite.scrollSampleValid(scrollAfter({ sampledAt: NaN }), scrollBefore()), false));
  for (const key of ['chromePid', 'windowId', 'tabId', 'cgWindow']) {
    const helpers = await actualScrollHelpers(text => replaceScroll(text, 'SCROLL_ID_KEYS.every(k => a[k] === b[k])',
      `SCROLL_ID_KEYS.every(k => k === '${key}' || a[k] === b[k])`));
    killed(`identity ${key}`, () => assert.equal(helpers.scrollIdentityMatches(SCROLL_ID, { ...SCROLL_ID, [key]: SCROLL_ID[key] + 1 }), false));
  }
  const offset = await actualScrollHelpers(text => replaceScroll(text, 'after.scrollY > before.scrollY', 'after.scrollY >= before.scrollY'));
  killed('offset progress', () => assert.equal(offset.scrollDocumentEvidence(scrollBefore(), scrollAfter({ scrollY: 0 })).documentScrollObserved, false));
  const trusted = await actualScrollHelpers(text => replaceScroll(text, 'after.trustedWheel > before.trustedWheel', 'true'));
  killed('trusted wheel increase', () => assert.equal(trusted.scrollDocumentEvidence(scrollBefore(), scrollAfter({ wheel: 0, trustedWheel: 0, firstWheelAt: null, lastWheelAt: null })).documentScrollObserved, false));
  const untrusted = await actualScrollHelpers(text => replaceScroll(text, 'after.untrustedWheel === 0', 'true'));
  killed('untrusted wheel exclusion', () => assert.equal(untrusted.scrollDocumentEvidence(scrollBefore(), scrollAfter({ trustedWheel: 1, untrustedWheel: 1 })).documentScrollObserved, false));
  const args = await actualScrollHelpers(text => replaceScroll(text, 'args.amount !== 1', 'false'));
  killed('exact amount gate', () => assert.throws(() => args.createScrollActionGate('scroll-document').accept({ ...SCROLL_ARGS, amount: 2 }, SCROLL_ID)));
  const mode = await actualScrollHelpers(text => replaceScroll(text, "if (mode !== 'scroll-document') throw error('scroll_mode_refused');", ''));
  killed('mode gate', () => assert.throws(() => mode.createScrollActionGate('input').accept(SCROLL_ARGS, SCROLL_ID)));
  const once = await actualScrollHelpers(text => replaceScroll(text, "if (attempted) throw error('scroll_already_attempted');", ''));
  const gate = once.createScrollActionGate('scroll-document'); gate.accept(SCROLL_ARGS, SCROLL_ID);
  killed('one attempt gate', () => assert.throws(() => gate.accept(SCROLL_ARGS, SCROLL_ID)));
  const parent = await actualCallHarness('input', {}, text => replaceScroll(text,
    "if (name === 'scroll') scrollGate.accept(args, owned.find(item => item.worker === w && item.tabId === args?.tab));", ''));
  await parent.invoke(parent.worker, 'scroll', SCROLL_ARGS);
  killed('actual parent gate removal', () => assert.equal(parent.effects.includes('scroll'), false));
  const worker = await actualWorkerHarness({ mutate: text => replaceScroll(text,
    'scrollGate.accept(m.args, fixtures.get(m.args?.tab));', '') });
  await worker.dispatch({ op: 'call', id: 1, name: 'scroll', args: SCROLL_ARGS });
  killed('actual worker gate removal', () => assert.equal(worker.effects.includes('tool_dispatch'), false));
});

await test('valid audit mutants lose exact block vars bytes execution options and frozen pin checks', async () => {
  const cases = [
    ['block no-vars mapping', text => replaceScroll(text, "if (args.length === 1 && args[0] === 'block')", "if (args[0] === 'block')"),
      h => normalAuditTrace(h, { blockArgs: [{}] })],
    ['missing block execution', text => replaceScroll(text, 'evals.find(row => row.template === id)?.sequence', '(evals.find(row => row.template === id)?.sequence ?? 0)'),
      h => normalAuditTrace(h, { omitBlockEval: true })],
    ['block eval options', text => replaceScroll(text, "args.length === 3 && scrollKeys(args[2], ['lean']) && args[2].lean === true", 'true'),
      h => normalAuditTrace(h, { blockEvalArgs: [7, { lean: false }] })],
    ['exact eval bytes', text => replaceScroll(text, "args[0] === expected[k]", "args[0].startsWith(expected[k])"),
      h => normalAuditTrace(h, { beforeEnd: h => h.eval(frozenScript('block') + '\n;document.scrollingElement.scrollTop=99;', 7, { lean: true }) })],
    ['source presence', text => replaceScroll(text, 'Object.values(sourceSha256).every(h => h !== null)', 'true'),
      h => normalAuditTrace(h)],
  ];
  for (const [label, mutation, trace] of cases) {
    const helpers = await actualScrollHelpers(mutation);
    const h = auditFixture({ helpers, ...(label === 'source presence' ? { sources: Object.fromEntries(Object.entries(scrollSources).filter(([file]) => file !== 'src/guard.js')) } : {}) });
    const snapshot = await trace(h);
    killed(label, () => assert.equal(snapshot.scriptAuditComplete, false));
  }
  const helpers = await actualScrollHelpers(text => replaceScroll(text, "typeof value === 'string' && value === expected[id]", "typeof value === 'string'"));
  const h = auditFixture({ helpers, page: async (...args) => frozenScript(...args) + (args[0] === 'block' ? '\n;inert extra byte sentinel' : '') });
  const original = h.eval; h.eval = (script, ...args) => original(script.startsWith(frozenScript('block')) ? frozenScript('block') : script, ...args);
  const snapshot = await normalAuditTrace(h);
  killed('pageScript independent output-byte comparison', () => assert.equal(snapshot.scriptAuditComplete, false));
});

await test('valid geometry audit mutants lose graph coverage AX identity and exact-target options',async()=>{
  const cases=[
    ['omit AX graph coverage',text=>replaceScroll(text,"gaps.add('geometry_corroboration_incomplete');","void 0;"),
      helpers=>normalAuditTrace(auditFixture({helpers,geometryChanged:true}),{corroboration:true,omitContent:true})],
    ['accept foreign AX PID',text=>replaceScroll(text,'value.pid === identity?.chromePid && value.cgWindow === identity?.cgWindow','true && value.cgWindow === identity?.cgWindow'),
      helpers=>normalAuditTrace(auditFixture({helpers,geometryChanged:true,content:()=>({...AUDIT_CONTENT,pid:99})}),{corroboration:true})],
    ['accept wrong exactTarget',text=>replaceScroll(text,'scrollIdentityMatches(identity, args[2].exactTarget)','true'),
      helpers=>normalAuditTrace(auditFixture({helpers,geometryChanged:true}),{corroboration:true,exactOptions:{exactTarget:{chromePid:10,cgWindow:11,windowId:99,tabId:7}}})],
  ];
  for(const [label,change,trace] of cases){
    assert.equal((await trace(scrollHelpers)).scriptAuditComplete,false,label+' baseline');
    const mutated=await actualScrollHelpers(change),result=await trace(mutated);
    killed(label,()=>assert.equal(result.scriptAuditComplete,false));
  }
});

await test('valid geometry audit mutants expose premature input unfinished fits and raw-route regression',async()=>{
  const cases=[
    ['move before proof','move-before-proof',false,text=>replaceScroll(text,
      '(!input || (pair.b.sequence < input.sequence && completedBefore(pair.b,input)))','true')],
    ['wheel before proof','wheel-before-proof',false,text=>replaceScroll(text,
      '(!input || (pair.b.sequence < input.sequence && completedBefore(pair.b,input)))','true')],
    ['unfinished B','input-before-B-completes',false,text=>replaceScroll(text,'completedBefore(pair.b,input)','true')],
    ['unfinished prior fit','unchanged-fit-completes-after-A',false,text=>replaceScroll(text,'completedBefore(prior,a)','true')],
    ['unfinished unchanged fit before input','unchanged-fit-completes-after-input',false,text=>replaceScroll(text,
      'if (row.geometryRequired && input && !completedBefore(row,input)) return true;','')],
    ['raw activation geometry demand','raw',true,text=>replaceScroll(text,'geometryRequired: intent.fitCurrent === true',"geometryRequired: intent.kind !== 'selectTab'")],
  ];
  for(const [label,mode,expected,change] of cases) {
    assert.equal((await orderedGeometryTrace(scrollHelpers,mode)).scriptAuditComplete,expected,label+' baseline');
    const mutated=await actualScrollHelpers(change),result=await orderedGeometryTrace(mutated,mode);
    killed(label,()=>assert.equal(result.scriptAuditComplete,expected));
  }
});

await test('valid equal-clock audit mutant cannot replace completion order with timestamps',async()=>{
  const mutated=await actualScrollHelpers(text=>replaceScroll(text,'a.endOrder < b.startOrder','a.endMs <= b.startMs'));
  assert.equal((await orderedGeometryTrace(mutated,'healthy',()=>10)).scriptAuditComplete,true);
  for(const mode of ['unchanged-fit-completes-after-input','input-before-B-completes','AX-completes-after-B']) {
    assert.equal((await orderedGeometryTrace(scrollHelpers,mode,()=>10)).scriptAuditComplete,false,mode+' baseline');
    const result=await orderedGeometryTrace(mutated,mode,()=>10);
    killed('equal-clock '+mode,()=>assert.equal(result.scriptAuditComplete,false));
  }
});

await test('valid audit mutants lose sticky prior uncertainty observer overlap overflow and delegate equivalence', async () => {
  for (const [label, mutation] of [
    ['non-observed sticky latch', text => replaceScroll(text, 'if (!observed) observerCompletionUnknown = true;', '')],
    ['clear sticky at begin', text => replaceScroll(text, 'started = active = true; startMs = clock();', 'observerCompletionUnknown = false; started = active = true; startMs = clock();')],
    ['later observed clears sticky', text => replaceScroll(text, 'if (!observed) observerCompletionUnknown = true;', 'observerCompletionUnknown = !observed;')],
  ]) {
    const helpers = await actualScrollHelpers(mutation); let first = true;
    const h = auditFixture({ helpers, observe: async () => first ? (first = false, { status: 'cancelled', reason: 'preempted' })
      : { status: 'observed', complete: true, observedAt: 1, observations: [] } });
    await h.observer(); await h.observer();
    const snapshot = await normalAuditTrace(h);
    killed(label, () => assert.equal(snapshot.scriptAuditComplete, false));
  }
  const overlap = await actualScrollHelpers(text => replaceScroll(text, "if (active) gaps.add('observer_overlap');", ''));
  const overlapSnapshot = await normalAuditTrace(auditFixture({ helpers: overlap }), { beforeEnd: h => h.observer() });
  killed('observer overlap', () => assert.equal(overlapSnapshot.scriptAuditComplete, false));
  const prior = await actualScrollHelpers(text => replaceScroll(text, "if (Object.values(pending).some(n => n !== 0)) gaps.add('prior_inflight');", ''));
  let settle; const pending = new Promise(resolve => { settle = resolve; });
  const priorHarness = auditFixture({ helpers: prior, observe: () => pending }); const flight = priorHarness.observer();
  const priorSnapshot = await normalAuditTrace(priorHarness, { beforeEnd: async () => { settle({ status: 'observed', complete: true, observedAt: 1, observations: [] }); await flight; } });
  killed('prior observer in flight', () => assert.equal(priorSnapshot.scriptAuditComplete, false));
  const overflow = await actualScrollHelpers(text => replaceScroll(text,
    "if (events.length >= limit) { overflow = true; gaps.add('overflow'); return null; }", ''));
  const overflowSnapshot = await normalAuditTrace(auditFixture({ helpers: overflow, limit: 8 }), { measureRepeats: 20 });
  killed('bounded ring overflow', () => assert.equal(overflowSnapshot.scriptAuditComplete, false));
  const twice = await actualScrollHelpers(text => replaceScroll(text, 'result = Reflect.apply(real, this, args);', 'Reflect.apply(real, this, args); result = Reflect.apply(real, this, args);'));
  let sends = 0; const twiceAudit = twice.createScrollAudit({ sources: scrollSources });
  const delegate = twiceAudit.wrapEvalInPage(() => { sends++; return {}; }); delegate('inert sentinel', 7);
  killed('delegate twice', () => assert.equal(sends, 1));
  const swallowed = await actualScrollHelpers(text => replaceScroll(text, 'catch (failure) { finish(failure, true); throw failure; }', 'catch (failure) { finish(failure, true); return null; }'));
  const throwAudit = swallowed.createScrollAudit({ sources: scrollSources }); const failure = Error('inert exception sentinel');
  killed('swallowed original exception', () => assert.throws(() => throwAudit.wrapEvalInPage(() => { throw failure; })('inert', 7), e => e === failure));
  const cloned = await actualScrollHelpers(text => replaceScroll(text, 'return session;\n    }; },', 'return { ...session };\n    }; },'));
  const session = { pid: 42, request: () => ({ ok: true }) }, cloneAudit = cloned.createScrollAudit({ sources: scrollSources });
  killed('Session object cloning', () => assert.equal(cloneAudit.wrapOpenInputSession(() => session)(), session));
});


await test('held-scroll normal trace derives the real veil rectangle panel and raw request from frozen product code', async () => {
  const h = auditFixture(), snapshot = await normalAuditTrace(h);
  const native = h.effects.filter(event => event.type === 'request');
  assert.deepEqual(native.map(event => event.args[0].op), ['veil', 'nativeChrome', 'move', 'wheel']);
  const request = native[0].args[0], options = native[0].args[1];
  assert.deepEqual(Object.keys(request.veil.rect).sort(), ['h', 'w', 'x', 'y']);
  assert.equal(request.veil.rect.x, 30); assert.equal(request.veil.rect.y, 40);
  assert.equal(request.veil.rect.w, 900); assert.equal(request.veil.rect.h, 700);
  assert.equal(options.raw, true); assert.deepEqual(Object.keys(options), ['raw']);
  assert.equal(request.veil.panel.task, 'private-synthetic-task');
  assert.equal(request.veil.panel.who, 'private-synthetic-agent');
  assert.equal(request.veil.panel.feedEntries[0], 'private-synthetic-feed');
  assert.equal(snapshot.scriptAuditComplete, true); assert.equal(snapshot.boundedNativeRequestsObserved, true);
  assert.equal(snapshot.events.find(event => event.kind === 'native' && event.op === 'veil').mapped, true);
  assert.equal(JSON.stringify(snapshot).includes('private-synthetic-'), false);
  for (const badRect of [{ left: 30, top: 40, width: 900, height: 700 }, { x: 30, y: 40, w: 0, h: 700 },
    { x: 30, y: 40, w: 900, h: -1 }, { x: 30, y: 40, w: '900', h: 700 }, { x: NaN, y: 40, w: 900, h: 700 },
    { x: 30, y: 40, w: 900, h: Infinity }, { x: 30, y: 40, w: 900 }, { x: 30, y: 40, w: 900, h: 700, secret: 'private-extra' }]) {
    const bad = await normalAuditTrace(auditFixture(), { veilTransform: request => ({ ...request, veil: { ...request.veil, rect: badRect } }) });
    assert.equal(bad.scriptAuditComplete, false); assert.equal(bad.boundedNativeRequestsObserved, false);
    assert.equal(JSON.stringify(bad).includes('private-extra'), false);
  }
  for (const transform of [request => ({ ...request, secret: 'private-extra' }),
    request => ({ ...request, veil: { ...request.veil, secret: 'private-extra' } }),
    request => ({ ...request, veil: { ...request.veil, panel: { ...request.veil.panel, secret: 'private-extra' } } })]) {
    const bad = await normalAuditTrace(auditFixture(), { veilTransform: transform });
    assert.equal(bad.scriptAuditComplete, false); assert.equal(bad.boundedNativeRequestsObserved, false);
    assert.equal(JSON.stringify(bad).includes('private-extra'), false);
  }
  const oldRect = await actualScrollHelpers(text => replaceScroll(text,
    "const rect = value => scrollKeys(value, ['x', 'y', 'w', 'h']) && Object.values(value).every(Number.isFinite)\n          && value.w > 0 && value.h > 0;",
    "const rect = value => scrollKeys(value, ['left', 'top', 'width', 'height']) && Object.values(value).every(Number.isFinite)\n          && value.width > 0 && value.height > 0;"));
  const reverted = await normalAuditTrace(auditFixture({ helpers: oldRect }));
  killed('old held-scroll veil rectangle mapping', () => assert.equal(reverted.scriptAuditComplete, true));
});

const EXECUTING_HASH_FILES = ['reliability-reset-live.mjs', 'reliability-reset-harness.test.mjs', 'harness-terminal.mjs', 'native-bounds-evidence.mjs'];
async function actualManifestHarness({ mutate = text => text, mode = 'scroll-document', sourceKind = 'source' } = {}) {
  const source = mutate(await fs.readFile(path.join(root, 'test/reliability-reset-live.mjs'), 'utf8'));
  const productRoot = '/inert/selected-product', here = '/inert/executing-harness/test/reliability-reset-live.mjs';
  const executing = new Map(EXECUTING_HASH_FILES.map(file => [path.join(path.dirname(here), file), `executing:${file}`]));
  const product = new Map(), reads = [];
  const readFile = async file => {
    reads.push(file);
    if (executing.has(file)) return Buffer.from(executing.get(file));
    if (file.startsWith(productRoot + '/')) return Buffer.from(product.get(file) ?? `product:${file.slice(productRoot.length + 1)}`);
    throw Error('unexpected inert manifest path: ' + file);
  };
  const helpers = await actualScrollHelpers(mutate, { here, readFile });
  const slice = (first, last) => {
    const start = source.indexOf(first), end = source.indexOf(last, start);
    assert.ok(start >= 0 && end > start, first); return source.slice(start, end);
  };
  // Real live setup and real final integrity statements, with the intervening
  // server/worker/browser work omitted. File reads are synthetic and separate.
  const before = slice('  const beforeHashes = await hashes(', '  const directory = await fs.mkdtemp(');
  const reportSetup = slice('  const report = { schema: 1, case:', '  const state = { terminal:');
  const finalIntegrity = slice('    report.afterHashes = await hashes(', '    if (report.nativeBoundsEvidenceManifest) {');
  const options = parseOptions(['--run', '--root-operator', `--${sourceKind}`, productRoot, '--case', mode]);
  const context = vm.createContext({ options, HERE: here, EXCLUDED, process: { argv: [] },
    fs: { readFile }, path, createHash, hashes: helpers.hashes, scrollHarnessHashes: helpers.scrollHarnessHashes,
    url: 'http://127.0.0.1/fixture-inert', token: 'inert' });
  new vm.Script(`async function prepare() {\n${before}\n${reportSetup}\nreturn { report, finish: async () => {\n${finalIntegrity}\n} };\n}\nglobalThis.prepare = prepare;`).runInContext(context);
  const prepared = await context.prepare();
  if (mode === 'scroll-document') prepared.report.scrollDocument = { scriptAuditComplete: true, boundedNativeRequestsObserved: true };
  return { ...prepared, here, productRoot, reads,
    replaceExecuting: file => executing.set(path.join(path.dirname(here), file), `changed-executing:${file}`),
    replaceProduct: file => product.set(path.join(productRoot, file), `changed-product:${file}`),
  };
}

await test('actual hash builder and final integrity bind product roots separately from the executing harness and imports', async () => {
  for (const sourceKind of ['source', 'runtime']) {
    const h = await actualManifestHarness({ sourceKind });
    const manifest = h.report.scrollHarnessManifest;
    assert.equal(manifest.entrypoint, h.here);
    assert.deepEqual(Object.keys(manifest.beforeHashes), EXECUTING_HASH_FILES);
    for (const file of EXECUTING_HASH_FILES) {
      assert.equal(manifest.beforeHashes[file], digest(`executing:${file}`));
      assert.notEqual(manifest.beforeHashes[file], digest(`product:test/${file}`));
      assert.equal(Object.hasOwn(h.report.beforeHashes, `test/${file}`), false);
      assert.equal(h.reads.includes(path.join(h.productRoot, 'test', file)), false);
      assert.equal(h.reads.includes(path.join(path.dirname(h.here), file)), true);
    }
    assert.equal(h.report.beforeHashes['src/index.js'], digest('product:src/index.js'));
    assert.equal(h.reads.includes(path.join(h.productRoot, 'src/index.js')), true);
    await h.finish();
    assert.equal(h.report.sourceUnchanged, true); assert.equal(manifest.sourceUnchanged, true);
    assert.equal(h.report.scrollDocument.scriptAuditComplete, true); assert.equal(h.report.scrollDocument.boundedNativeRequestsObserved, true);
  }
  for (const file of EXECUTING_HASH_FILES) {
    const h = await actualManifestHarness(); h.replaceExecuting(file); await h.finish();
    assert.equal(h.report.sourceUnchanged, true, file);
    assert.equal(h.report.scrollHarnessManifest.sourceUnchanged, false, file);
    assert.equal(h.report.scrollHarnessManifest.afterHashes[file], digest(`changed-executing:${file}`));
    assert.equal(h.report.scrollDocument.scriptAuditComplete, false, file);
    assert.equal(h.report.scrollDocument.boundedNativeRequestsObserved, false, file);
  }
  const changedProduct = await actualManifestHarness(); changedProduct.replaceProduct('src/index.js'); await changedProduct.finish();
  assert.equal(changedProduct.report.sourceUnchanged, false);
  assert.equal(changedProduct.report.scrollHarnessManifest.sourceUnchanged, true);
  assert.equal(changedProduct.report.scrollDocument.scriptAuditComplete, false);
  assert.equal(changedProduct.report.scrollDocument.boundedNativeRequestsObserved, false);
  const decoys = await actualManifestHarness();
  for (const file of EXECUTING_HASH_FILES) decoys.replaceProduct(`test/${file}`);
  await decoys.finish();
  assert.equal(decoys.report.sourceUnchanged, true); assert.equal(decoys.report.scrollHarnessManifest.sourceUnchanged, true);
  assert.equal(decoys.report.scrollDocument.scriptAuditComplete, true);
  const legacy = await actualManifestHarness({ mode: 'input' }); await legacy.finish();
  assert.equal(legacy.report.scrollHarnessManifest, undefined);
  assert.equal(legacy.reads.some(file => file.startsWith(path.dirname(legacy.here))), false);
  const selectedRoot = await actualManifestHarness({ mutate: text => {
    assert.equal((text.match(/await scrollHarnessHashes\(\)/g) || []).length, 2);
    return text.replaceAll('await scrollHarnessHashes()', "await scrollHarnessHashes(path.join(options.source, 'test', 'reliability-reset-live.mjs'))");
  } });
  selectedRoot.replaceExecuting('harness-terminal.mjs'); await selectedRoot.finish();
  assert.equal(selectedRoot.report.sourceUnchanged, true); assert.equal(selectedRoot.report.scrollHarnessManifest.sourceUnchanged, true);
  killed('selected-product-root instrumentation hashes', () => assert.equal(selectedRoot.report.scrollDocument.scriptAuditComplete, false));
  const noDowngrade = await actualManifestHarness({ mutate: text => replaceScroll(text,
    '(!report.sourceUnchanged || !report.scrollHarnessManifest?.sourceUnchanged)', '(!report.sourceUnchanged)') });
  noDowngrade.replaceExecuting('reliability-reset-live.mjs'); await noDowngrade.finish();
  killed('executing-harness final integrity downgrade removal', () => assert.equal(noDowngrade.report.scrollDocument.boundedNativeRequestsObserved, false));
});



console.log(`${checks} offline harness checks; no live/native acceptance claimed.`);
