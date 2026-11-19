// Actual product response wrapper and MCP SDK; inert handler, no product main,
// browser, native helper, real settings, host connection or external network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { redactText, redactToolResult } from '../src/privacy.js';
import { productErrorFact, workerFailureFact, rpcFailureFact, readTerminalReceipt, terminalBinding } from './harness-terminal.mjs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
function actualFunction(name, script = source) {
  const start = script.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return (name === 'callToolInner' ? 'function noticeTerminalRefusal() {}\n' : '') +  script.slice(start, script.indexOf('\n}', start) + 2);
}
// Root-reviewed selection, pinned independently from both implementation Sets.
// Vocabulary SHA-256: 639e1ad693165c37eb07f92f5f7e803b0c926cc1900790cdacc2c040ea1cd6dc.
const EXPECTED_CODES = [
  'aborted', 'activate_failed', 'activate_unconfirmed', 'agent_window_minimized', 'already_begun',
  'auto_skipped_field', 'auto_skipped_incomplete_template', 'auto_skipped_origin_mismatch',
  'auto_skipped_origin_unverified', 'auto_skipped_template_mismatch', 'ax_probe_failed', 'ax_probe_timeout',
  'bad_args', 'bad_button', 'bad_crop', 'bad_direction', 'bad_driver_output', 'bad_geometry_side_inset',
  'bad_geometry_toolbar_tall', 'bad_geometry_toolbar_zero', 'bad_image', 'bad_input_mode', 'bad_native_target',
  'bad_page_result', 'bad_plan', 'bad_progress', 'bad_replace', 'bad_request', 'bad_sections', 'bad_select',
  'bad_url', 'blank_text', 'cancelled', 'cannot_check', 'capture_failed', 'cgevent_failed', 'chrome_error',
  'chrome_not_running', 'chromectl_failed', 'close_blocked', 'close_pending', 'close_prompt_pending',
  'close_target_invalid', 'compose_failed', 'conversation_waiting', 'creation_unknown', 'cursor_moved',
  'dialog_ambiguous', 'dialog_button_ambiguous', 'dialog_button_unavailable', 'dialog_changed',
  'dialog_delivery_unknown', 'dialog_field_ambiguous', 'dialog_field_unavailable', 'dialog_identity_mismatch',
  'dialog_identity_required', 'dialog_press_unconfirmed', 'dialog_probe_unknown', 'dialog_registry_full',
  'dialog_response_unknown', 'dialog_set_failed', 'dialog_set_unconfirmed', 'dialog_target_invalid',
  'dialog_text_invalid', 'disabled_field', 'displays_asleep', 'empty_option', 'empty_text', 'error',
  'focus_unconfirmed', 'gone', 'guard', 'guard_cursor_moved', 'guard_key_window', 'guard_modifier_held',
  'guard_not_frontmost', 'guard_window_not_top', 'handoff_lost', 'helper_missing', 'hold_ended', 'input_held',
  'input_release_unverified', 'input_stuck', 'input_unconfirmed', 'internal', 'interrupted',
  'invalid_temporal_value', 'js_from_apple_events_disabled', 'lock_timeout', 'mouse_interrupted',
  'native_app_missing', 'native_bounds_invalid', 'native_creation_unbound', 'native_delivery_unknown',
  'native_epoch_changed', 'native_epoch_stale', 'native_event_invalid', 'native_focus_unknown', 'native_paused',
  'native_permission_required', 'native_policy_invalid', 'native_profile_invalid', 'native_read_timeout',
  'native_read_unknown', 'native_reader_busy', 'native_recovery_unavailable', 'native_request_invalid',
  'native_response_unknown', 'native_restore_target_invalid', 'native_restore_token_invalid',
  'native_scene_already_recorded', 'native_scene_invalid', 'native_scene_unknown', 'native_schema_invalid',
  'native_session_required', 'native_session_revoked', 'native_target_changed', 'native_target_invalid',
  'native_target_rebind', 'native_target_unbound', 'native_target_unknown', 'native_url_invalid',
  'native_write_unknown', 'navigation_unverified', 'new_tab_unconfirmed', 'new_window_blocked_by_task_hold',
  'new_window_unconfirmed', 'no_accessibility', 'no_automation_permission', 'no_cg_window', 'no_context',
  'no_dialog', 'no_input_monitor', 'no_local_state', 'no_page_focus', 'no_screen', 'no_screen_recording',
  'no_screenshot', 'no_such_app', 'no_such_button', 'no_such_profile', 'no_such_tab', 'no_such_text',
  'no_such_window', 'no_takeover_tap', 'no_text_field', 'no_window', 'not_agent_tab', 'not_ascii', 'not_begun',
  'not_key_window', 'not_on_top', 'not_your_tab', 'observer_read_only', 'ocr_failed', 'ocr_timeout',
  'outside_shot', 'ownership_unverified', 'page_auto_attempt_used', 'page_auto_geometry_changed',
  'page_auto_hold_changed', 'page_auto_hold_lost', 'page_auto_native_forbidden', 'page_auto_no_reacquire',
  'page_auto_retarget', 'page_auto_rule_changed', 'page_auto_scene_forbidden', 'page_auto_session_required',
  'page_auto_stale_node', 'page_auto_target_changed', 'page_auto_target_invalid', 'page_auto_template_changed',
  'page_changed', 'page_content_changed', 'page_content_unavailable', 'page_dialog', 'page_error',
  'paused_by_user', 'pointer_restore_unconfirmed', 'protected_write_requires_session', 'read_failed',
  'replace_unconfirmed', 'restore_unconfirmed', 'routine_busy', 'scene_unknown', 'screen_locked',
  'screen_state_unknown', 'screen_wake_failed', 'screenshot_changed', 'secure_input', 'select_failed',
  'session_closed', 'session_exited', 'session_failed', 'session_timeout', 'site_blocked', 'stale_marker',
  'submit_unconfirmed', 'tab_hidden', 'taken_over', 'takeover_expired', 'target_covered', 'target_offscreen',
  'target_unavailable', 'task_hold_lost', 'task_interrupted', 'temporal_field_changed', 'temporal_layout_unknown',
  'temporal_paste_unsupported', 'temporal_unconfirmed', 'terminated', 'unknown_tool', 'unsupported_key_text',
  'use_select_option', 'user_busy', 'user_cancelled', 'user_interrupted', 'why_required', 'window_changed',
  'window_covered', 'window_not_chrome', 'window_off_screen', 'write_failed', 'wrong_app', 'wrong_field',
  'unavailable'
];
const EXPECTED_STAGES = [
  'activate_app', 'activate_index', 'activate_main', 'activate_raise', 'activate_tab', 'activate_unminimize',
  'activate_verify', 'apple_event', 'close_identity', 'close_postcheck', 'close_preflight', 'close_tab',
  'dialog_auto_constraint', 'dialog_auto_origin', 'dialog_binding', 'dialog_button', 'dialog_field',
  'dialog_identity', 'dialog_inspect', 'dialog_postcheck', 'dialog_press', 'dialog_press_prepare',
  'dialog_readback', 'dialog_recheck', 'dialog_response', 'dialog_set', 'dialog_set_prepare', 'element_ids',
  'eval_bounds', 'eval_result', 'eval_url', 'find_tab_tabs', 'find_tab_windows', 'info_loading',
  'native_app_lookup', 'native_ax_read', 'native_binding', 'native_dispatch', 'native_focus_read',
  'native_identity', 'native_prepare', 'native_read', 'native_read_deadline', 'native_restore', 'native_scene',
  'native_window_binding', 'new_window_bounds', 'new_window_create', 'new_window_identity', 'new_window_prepare',
  'new_window_receipt', 'new_window_response', 'new_window_url', 'open_restore_index', 'open_restore_tab',
  'open_tab_create', 'open_tab_identity', 'open_tab_url', 'restore_app', 'restore_app_again',
  'restore_app_verify', 'restore_index', 'restore_prepare', 'restore_tab', 'select_tab', 'target_metadata',
  'window_bounds', 'unobserved'
];
const normalize = value => JSON.parse(JSON.stringify(value));
const unknown = { code: 'unavailable', stage: 'unobserved', inputDelivery: 'unknown' };
const facts = delivery => ({ code: 'native_target_changed', stage: 'native_prepare', inputDelivery: delivery });
const failure = () => ({ isError: true, content: [{ type: 'text', text: 'Synthetic ordinary error' }] });
function wrapper(handler, mutate = code => code) {
  const CALL = new AsyncLocalStorage();
  const context = vm.createContext({ CALL, callToolRun: (req, extra) => handler(CALL.getStore(), req, extra), redactText, redactToolResult });
  vm.runInContext(actualFunction('progressFor') + '\n' + mutate(actualFunction('callTool')) + '\nglobalThis.invoke = callTool;', context);
  return { CALL, invoke: (name = 'open_tab', args = {}) => context.invoke({ params: { name, arguments: args } }, {}), raw: context.invoke };
}
function errorFacts(result) {
  assert.equal(result.isError, true);
  assert.ok(result.structuredContent?.error, 'ordinary error must retain machine facts');
  const out = normalize(result.structuredContent.error);
  assert.deepEqual(Object.keys(out).sort(), ['code', 'inputDelivery', 'stage']);
  return out;
}

test('actual wrapper preserves the existing CALL code/stage/delivery for ordinary errors', async () => {
  for (const delivery of ['sent', 'not_sent', 'unknown']) {
    const expected = facts(delivery), h = wrapper(state => { Object.assign(state, expected); return failure(); });
    assert.deepEqual(errorFacts(await h.invoke()), expected);
  }
});

test('error code, prose and zero-duration failures never imply not_sent', async () => {
  for (const code of ['why_required', 'screen_locked', 'cancelled']) {
    const h = wrapper(state => { state.code = code; return { isError: true, content: [{ type: 'text', text: 'No input was sent / 没有输入' }] }; });
    assert.deepEqual(errorFacts(await h.invoke()), { ...unknown, code });
  }
});

test('missing and malformed fields use bounded fallbacks without string coercion or newline acceptance', async () => {
  for (const value of [undefined, null, '', 'a'.repeat(81), 'valid_label\n', 'https://example.test/?token=synthetic-secret',
    'raw message with spaces', 42, [], { secret: 'synthetic-secret' }]) {
    const h = wrapper(state => { Object.assign(state, { code: value, stage: value, inputDelivery: value }); return failure(); });
    assert.deepEqual(errorFacts(await h.invoke()), unknown);
  }
  const h = wrapper(state => { Object.assign(state, { code: 'a'.repeat(80), stage: 'stage_12', inputDelivery: true }); return failure(); });
  assert.deepEqual(errorFacts(await h.invoke()), unknown, 'an identifier-shaped value is not a public product word');
});

test('outer throw keeps first captured facts, then direct error, then nested reply without downgrading known uncertainty', async () => {
  const nested = { code: 'new_tab_unconfirmed', stage: 'open_tab_identity', inputDelivery: 'sent' };
  const direct = { code: 'native_response_unknown', stage: 'native_dispatch', inputDelivery: 'not_sent' };
  for (const [captured, error, expected] of [
    [{}, Object.assign(Error('synthetic'), nested), nested],
    [{}, Object.assign(Error('synthetic'), { reply: nested }), nested],
    [{}, Object.assign(Error('synthetic'), direct, { reply: nested }), direct],
    [{ ...facts('unknown') }, Object.assign(Error('synthetic'), direct, { reply: nested }), facts('unknown')],
    [{ code: 'bad label', stage: [], inputDelivery: 'invalid' }, Object.assign(Error('synthetic'), direct), unknown],
    [{}, Object.assign(Error('synthetic'), { code: null, stage: null, inputDelivery: null, reply: nested }), nested],
    [{}, Object.assign(Error('synthetic'), { sent: [] }), unknown]
  ]) {
    const h = wrapper(state => { Object.assign(state, captured); throw error; });
    assert.deepEqual(errorFacts(await h.invoke()), expected);
  }
});

test('success and routines keep their existing shapes, and an ordinary result is not mutated', async () => {
  const image = { type: 'image', data: 'synthetic-image', mimeType: 'image/png' };
  const result = { content: [image, { type: 'text', text: 'Success' }], structuredContent: { result: { status: 'ready' } } };
  let next = result;
  const h = wrapper(state => { Object.assign(state, facts('not_sent')); return next; });
  const success = await h.invoke(); assert.deepEqual(normalize(success), result); assert.strictEqual(success.content[0], image);
  next = { isError: true, content: [{ type: 'text', text: 'Routine error' }], structuredContent: { error: { code: 'cancelled' } } };
  assert.deepEqual(normalize(await h.invoke('routines')), next);
  next = failure(); await h.invoke(); assert.equal(Object.hasOwn(next, 'structuredContent'), false);
});

test('metadata contains no raw error properties, and final text privacy still runs', async () => {
  const secret = 'synthetic-secret', url = `https://example.test/?access_token=${secret}`;
  const e = Object.assign(Error(url), facts('unknown'), { stack: secret, token: secret, account: secret,
    reply: { ...facts('sent'), message: secret, url, stages: [{ prompt: secret }] } });
  const h = wrapper(() => { throw e; }), result = await h.invoke();
  assert.deepEqual(errorFacts(result), facts('unknown'));
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.match(result.content[0].text, /redacted/);
});

test('actual AsyncLocalStorage keeps overlapping error facts local to each request', async () => {
  let unblock, entered;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { unblock = resolve; });
  const stores = [];
  const firstFacts = { code: 'native_target_changed', stage: 'native_prepare', inputDelivery: 'unknown' };
  const secondFacts = { code: 'new_tab_unconfirmed', stage: 'open_tab_identity', inputDelivery: 'sent' };
  const h = wrapper(async (state, req) => {
    stores.push(state); Object.assign(state, req.params.arguments.facts);
    if (req.params.arguments.which === 'first') { entered(); await gate; }
    return failure();
  });
  const first = h.invoke('click', { which: 'first', facts: firstFacts }); await ready;
  const second = await h.invoke('click', { which: 'second', facts: secondFacts }); unblock();
  assert.deepEqual(errorFacts(await first), firstFacts); assert.deepEqual(errorFacts(second), secondFacts);
  assert.notStrictEqual(stores[0], stores[1]); assert.equal(h.CALL.getStore(), undefined);
});

test('real MCP SDK transport preserves actual-wrapper structured error facts and human text', async () => {
  const h = wrapper(state => { Object.assign(state, facts('not_sent')); return failure(); });
  const server = new Server({ name: 'inert-error-wrapper', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, (req, extra) => h.raw(req, extra));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'open_tab', inputSchema: { type: 'object', properties: {} } }] }));
  const client = new Client({ name: 'inert-sdk-client', version: '1' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  try {
    await client.connect(clientSide);
    const result = await client.callTool({ name: 'open_tab', arguments: {} });
    assert.deepEqual(errorFacts(result), facts('not_sent'));
    assert.equal(result.content[0].text, 'Synthetic ordinary error');
  } finally { await client.close(); }
});

test('removing the actual ordinary error projection recreates the information loss', async () => {
  const transfer = 'structuredContent: { error: boundedErrorFacts(state) }';
  assert.ok(actualFunction('callTool').includes(transfer));
  const h = wrapper(state => { Object.assign(state, facts('not_sent')); return failure(); }, code => code.replace(transfer, 'structuredContent: {}'));
  const awaited = await h.invoke();
  assert.throws(() => errorFacts(awaited), /machine facts/);
});

// These actual upstream functions include the page JSON -> BridgeError -> CALL
// path. Every IO dependency is inert; unlike direct state injection, the page
// controls only its synthetic payload and the human message excludes the canary.
async function upstreamError(pageCode, mutate = code => code) {
  const at = bridge.indexOf('class BridgeError '); assert.ok(at >= 0);
  const bridgeError = bridge.slice(at, bridge.indexOf('\n}', at) + 2);
  const effects = [];
  let drives = 0;
  const context = vm.createContext({ CALL: new AsyncLocalStorage(), redactToolResult,
    path: { join: (...parts) => parts.join('/') }, os: { tmpdir: () => '/inert' },
    crypto: { randomBytes: () => ({ toString: () => 'inert' }) },
    writeFile: async () => { effects.push('writeFile'); }, unlink: async () => { effects.push('unlink'); },
    // G1: the read runs only after a verdict, so the site check on its own (the second eval) answers one.
    runDriver: async () => { effects.push('runDriver'); return { result: JSON.stringify(++drives === 2 ? { ok: true, blocked: null } : { ok: false, error: pageCode,
      stage: 'synthetic_private_stage_abc', message: 'Safe synthetic failure' }) }; },
    pauseGate: async () => {}, noteOutcome: () => {}, PLAN: null, RoutineError: class extends Error {},
    HANDOFFS: new Map(), BLOCKS: new Map(), writeTaskState: () => {},
    goneTabNote: () => '', setupHint: () => '', readRequest: () => ({ full: true }),
    // read_page's gate runs through the actual siteGate: one dialog check and one combined eval; after a
    // failure of that eval, the site check on its own and then the read eval, each after a dialog check.
    B: { pageDialog: async () => { effects.push('pageDialog'); return { open: false }; },
      pageScript: async () => { effects.push('pageScript'); return 'inert fixed script'; } } });
  vm.runInContext([bridgeError, actualFunction('evalInPage', bridge), actualFunction('gatedReadScript'), actualFunction('blockCheck'),
    actualFunction('readAlone'), actualFunction('siteGate'), actualFunction('readPage'),
    actualFunction('callToolInner'), actualFunction('progressFor'), mutate(actualFunction('callTool')),
    'B.evalInPage = evalInPage; globalThis.callToolRun = req => callToolInner(req.params.name, req.params.arguments, {}, async () => ""); globalThis.invoke = callTool;'].join('\n'), context);
  const result = await context.invoke({ params: { name: 'read_page', arguments: { full: true } } }, {});
  // The combined eval fails as a whole: the bda7086 sequence follows, the site check on its own (G1: it must give
  // a verdict; here nothing to stop for) and then the read eval on its own, each after a fresh dialog check.
  assert.deepEqual(effects, ['pageDialog', 'pageScript', 'pageScript', 'writeFile', 'runDriver', 'unlink',
    'pageDialog', 'pageScript', 'writeFile', 'runDriver', 'unlink',
    // G1 r2: the read eval gates itself (block.js and read.js in one eval: two scripts, one eval).
    'pageDialog', 'pageScript', 'pageScript', 'writeFile', 'runDriver', 'unlink']);
  assert.equal(result.content[0].text, 'Safe synthetic failure');
  assert.equal(result.content[0].text.includes(pageCode), false);
  assert.equal(errorFacts(result).stage, 'unobserved', 'evalInPage does not forward payload.stage');
  return result;
}
async function assertPrivateUpstream(mutate) {
  const canary = 'synthetic_private_token_abc';
  const result = await upstreamError(canary, mutate);
  assert.equal(errorFacts(result).code, 'unavailable', 'page identifier canary must not become a public code');
  assert.deepEqual(errorFacts(result), unknown);
  assert.deepEqual(productErrorFact(result.structuredContent.error), unknown);
  assert.equal(JSON.stringify(result).includes(canary), false);
  return result;
}
test('actual page eval, readPage and inner catch cannot export an identifier-shaped private code', async () => {
  await assertPrivateUpstream();
});
test('restoring shape-only acceptance in the actual wrapper makes the upstream negative fail', async () => {
  const membership = 'allowed.has(value)'; assert.equal(actualFunction('callTool').split(membership).length, 2);
  await assert.rejects(assertPrivateUpstream(code => code.replace(membership, '/^[a-z][a-z0-9_]{0,79}$/.test(value)')),
    error => error.code === 'ERR_ASSERTION' && /page identifier canary/.test(error.message));
});
test('a page-chosen public word remains only a bounded claim and does not authenticate its source', async () => {
  const result = await upstreamError('page_error');
  assert.deepEqual(errorFacts(result), { ...unknown, code: 'page_error' });
  assert.deepEqual(productErrorFact(result.structuredContent.error), { ...unknown, code: 'page_error' });
});

test('identifier canaries in context, direct errors and nested replies fall back without optimistic promotion', async () => {
  for (const location of ['context', 'direct', 'nested']) for (const key of ['code', 'stage']) {
    const canary = `synthetic_private_${key}_abc`, selected = { ...facts('unknown'), [key]: canary };
    const h = wrapper(state => {
      if (location === 'context') {
        Object.assign(state, selected);
        throw Object.assign(Error('Safe synthetic failure'), facts('sent'), { reply: facts('not_sent') });
      }
      if (location === 'direct') throw Object.assign(Error('Safe synthetic failure'), selected, { reply: facts('sent') });
      throw Object.assign(Error('Safe synthetic failure'), { reply: selected });
    });
    const result = await h.invoke(), expected = { ...facts('unknown'), [key]: unknown[key] };
    assert.deepEqual(errorFacts(result), expected, `${location}.${key}`);
    assert.deepEqual(productErrorFact(selected), expected);
    assert.equal(JSON.stringify(result).includes(canary), false);
  }
});

const publicMemberCases = ['sent', 'not_sent', 'unknown'].flatMap(inputDelivery => [
  ...EXPECTED_CODES.map(code => ({ code, stage: 'native_prepare', inputDelivery })),
  ...EXPECTED_STAGES.map(stage => ({ code: 'native_target_changed', stage, inputDelivery }))
]);
const unrecognizedFields = [
  ...['synthetic_private_token_abc', 'native_target_changed_private_abc', 'private_native_target_changed',
    'close_tab', 'unobserved', 'delete_failed', 'dryrun_only', 'habits_off', 'no_habits', 'usage',
    'native_target_changed\n', 'Native_target_changed', ' native_target_changed', 'a'.repeat(80)].map(code => ({ code })),
  ...['synthetic_private_stage_abc', 'native_prepare_private_abc', 'private_native_prepare',
    'native_target_changed', 'unavailable', 'native_prepare\n', 'Native_prepare', 'native_prepare '].map(stage => ({ stage }))
];
test('every reviewed finite member and sentinel survives actual wrapper and receipt projection with each delivery value', async () => {
  assert.equal(new Set(EXPECTED_CODES).size, 226); assert.equal(new Set(EXPECTED_STAGES).size, 68);
  let current;
  const h = wrapper(state => { Object.assign(state, current); return failure(); });
  for (const expected of publicMemberCases) {
    current = expected;
    assert.deepEqual(errorFacts(await h.invoke()), expected);
    assert.deepEqual(productErrorFact(expected), expected);
  }
});
test('wrong-field, excluded, private and prefix words never grow the finite output vocabulary', async () => {
  for (const fields of unrecognizedFields) {
    const input = { ...facts('unknown'), ...fields }, key = Object.keys(fields)[0];
    const expected = { ...input, [key]: unknown[key] };
    const h = wrapper(state => { Object.assign(state, input); return failure(); });
    assert.deepEqual(errorFacts(await h.invoke()), expected);
    assert.deepEqual(productErrorFact(input), expected);
  }
  const coercible = { toString() { throw Error('must not coerce'); } };
  const h = wrapper(state => { Object.assign(state, { code: coercible, stage: coercible, inputDelivery: coercible }); return failure(); });
  assert.deepEqual(errorFacts(await h.invoke()), unknown);
  assert.deepEqual(productErrorFact({ code: coercible, stage: coercible, inputDelivery: coercible }), unknown);
});
test('actual receipt reader accepts every public member but rejects unrecognized stored words instead of normalizing them', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-vocabulary-receipt-'));
  const file = path.join(directory, 'terminal-receipt.json'), binding = 'inert-vocabulary-binding', workerPid = process.pid;
  const base = { schema: 1, workerPid, bindingSha256: terminalBinding(binding, workerPid), at: new Date().toISOString(),
    terminal: { code: 'unexpected_mcp_error', stage: 'worker', inputDelivery: 'unknown', noRetry: true },
    fixtures: [], call: null, pinned: null, diagnostic: null };
  try {
    const save = value => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    save(base); assert.deepEqual(await readTerminalReceipt(directory, binding, workerPid), base);
    for (const productError of publicMemberCases) {
      save({ ...base, productError });
      assert.deepEqual((await readTerminalReceipt(directory, binding, workerPid)).productError, productError);
    }
    for (const fields of unrecognizedFields) {
      save({ ...base, productError: { ...facts('unknown'), ...fields } });
      await assert.rejects(readTerminalReceipt(directory, binding, workerPid), /content_invalid/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// Independently frozen optional vocabulary; the legacy 226/68 arrays above
// remain unchanged. Errors pass through the complete actual inner catch.
const BINDING_REASONS = ['window_missing', 'tab_not_in_window', 'active_tab_mismatch',
  'cg_mapping_missing', 'cg_mapping_mismatch', 'snapshot_structure_changed'];
const WRITE_STAGES = ['dialog_set', 'dialog_press', 'close_tab', 'window_bounds', 'select_tab',
  'activate_unminimize', 'activate_tab', 'activate_index', 'activate_main', 'activate_raise', 'activate_app',
  'open_tab_create', 'open_tab_url', 'open_restore_tab', 'open_restore_index', 'new_window_create',
  'new_window_bounds', 'new_window_url', 'restore_app', 'restore_tab', 'restore_index', 'restore_app_again'];
const optionalKeys = ['bindingReason', 'lastWriteStage', 'lastWriteDelivery'];
const ledger = (stage = 'activate_tab', delivery = 'sent') => [{ entered: true, stage, delivery }];
const productFailure = extra => Object.assign(Error('Safe synthetic native failure'), facts('unknown'), extra);
function actualCatchWrapper(handler, { tail = async () => '', twice = false, mutate = code => code } = {}) {
  const CALL = new AsyncLocalStorage(), stores = [];
  const context = vm.createContext({ CALL, redactText, redactToolResult, PLAN: null,
    RoutineError: class extends Error {}, BridgeError: class extends Error {}, pauseGate: async () => {},
    noteOutcome: () => {}, goneTabNote: () => '', setupHint: () => '',
    openTabTool: async args => { stores.push(CALL.getStore()); return handler(CALL.getStore(), args); }, tail });
  vm.runInContext([actualFunction('callToolInner'), actualFunction('progressFor'), mutate(actualFunction('callTool')),
    `globalThis.callToolRun = async req => { ${twice ? "await callToolInner('open_tab', {which:'earlier'}, {}, tail);" : ''}
      return callToolInner('open_tab', req.params.arguments, {}, tail); }; globalThis.invoke = callTool;`].join('\n'), context);
  return { CALL, stores, invoke: (args = {}) => context.invoke({ params: { name: 'open_tab', arguments: args } }, {}) };
}
function optionalResult(result, expected) {
  assert.equal(result.isError, true);
  assert.deepEqual(normalize(result.structuredContent.error), { ...facts('unknown'), ...expected });
  assert.equal(JSON.stringify(result).includes('synthetic_private_'), false);
  assert.deepEqual(productErrorFact(result.structuredContent.error), { ...facts('unknown'), ...expected });
}
test('actual inner catch preserves every optional enum member and exact final ledger delivery', async () => {
  for (const bindingReason of BINDING_REASONS) {
    const h = actualCatchWrapper(() => { throw productFailure({ bindingReason }); });
    optionalResult(await h.invoke(), { bindingReason });
  }
  for (const lastWriteStage of WRITE_STAGES) for (const lastWriteDelivery of ['sent', 'not_sent', 'unknown']) {
    const h = actualCatchWrapper(() => { throw productFailure({ stages: ledger(lastWriteStage, lastWriteDelivery) }); });
    optionalResult(await h.invoke(), { lastWriteStage, lastWriteDelivery });
    assert.equal(h.stores[0].nativeErrorFactsCaptured, true);
    assert.equal(Object.hasOwn(h.stores[0], 'stages'), false);
    assert.equal(Object.hasOwn(h.stores[0], 'reply'), false);
  }
});
test('actual catch chooses own non-nullish optional data before validation and never searches backward', async () => {
  const nested = { bindingReason: 'window_missing', stages: ledger('close_tab', 'unknown') };
  const pair = { lastWriteStage: 'close_tab', lastWriteDelivery: 'unknown' };
  const cases = [
    [{}, {}], [{ inputDelivery: 'sent' }, {}], [{ reply: nested }, { bindingReason: 'window_missing', ...pair }],
    [{ bindingReason: null, stages: null, reply: nested }, { bindingReason: 'window_missing', ...pair }],
    [{ bindingReason: 'cg_mapping_mismatch', stages: ledger(), reply: nested },
      { bindingReason: 'cg_mapping_mismatch', lastWriteStage: 'activate_tab', lastWriteDelivery: 'sent' }],
    [{ bindingReason: 'synthetic_private_reason', stages: [], reply: nested }, {}],
    [{ bindingReason: 42, stages: 'synthetic_private_ledger', reply: nested }, {}],
    [{ stages: [...ledger(), { entered: false, stage: 'close_tab', delivery: 'sent' }] }, {}],
    [{ stages: [...ledger(), { entered: true, stage: 'synthetic_private_stage', delivery: 'sent' }] }, {}],
    [{ stages: [...ledger(), { entered: true, stage: 'close_tab', delivery: 'invalid' }] }, {}],
    [{ stages: [...ledger(), { entered: true, stage: 'close_tab' }] }, {}],
    [{ lastWriteStage: 'close_tab', lastWriteDelivery: 'sent' }, {}]
  ];
  for (const [extra, expected] of cases) {
    const h = actualCatchWrapper(() => { throw productFailure(extra); }), result = await h.invoke();
    // Overall delivery is preserved independently; it never invents a write.
    const delivery = extra.inputDelivery ?? 'unknown';
    assert.deepEqual(normalize(result.structuredContent.error), { ...facts(delivery), ...expected });
    assert.equal(JSON.stringify(result).includes('synthetic_private_'), false);
  }
});
test('optional getters and coercion do not execute; inherited data is ignored and descriptor-trap failures are contained', async () => {
  let hits = 0;
  const getter = { get() { hits++; throw Error('synthetic_private_getter'); } };
  const inherited = Object.create({ bindingReason: 'window_missing', stages: ledger() });
  const directGetter = productFailure(); Object.defineProperties(directGetter, { bindingReason: getter, stages: getter, reply: getter });
  const nestedGetter = productFailure({ reply: {} }); Object.defineProperties(nestedGetter.reply, { bindingReason: getter, stages: getter });
  const lastGetter = ledger(); Object.defineProperty(lastGetter, '0', getter);
  const entryGetter = {}; Object.defineProperties(entryGetter, { entered: getter, stage: getter, delivery: getter });
  const stageGetter = { entered: true, delivery: 'sent' }; Object.defineProperty(stageGetter, 'stage', getter);
  const deliveryGetter = { entered: true, stage: 'close_tab' }; Object.defineProperty(deliveryGetter, 'delivery', getter);
  const coercible = { toString() { hits++; throw Error('synthetic_private_coercion'); } };
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('synthetic_private_trap'); } });
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  for (const error of [directGetter, nestedGetter, productFailure({ reply: inherited }),
    productFailure({ stages: lastGetter }), productFailure({ stages: [entryGetter] }),
    productFailure({ stages: [stageGetter] }), productFailure({ stages: [deliveryGetter] }),
    productFailure({ stages: [Object.create({ entered: true, stage: 'close_tab', delivery: 'sent' })] }),
    productFailure({ stages: revoked.proxy }), productFailure({ bindingReason: coercible, stages: ledger(coercible, coercible) }), productFailure({ reply: proxy })]) {
    optionalResult(await actualCatchWrapper(() => { throw error; }).invoke(), {});
  }
  const inheritedError = productFailure(); Object.setPrototypeOf(inheritedError, { bindingReason: 'window_missing', stages: ledger() });
  optionalResult(await actualCatchWrapper(() => { throw inheritedError; }).invoke(), {});
  const flat = { ...facts('unknown') }; for (const key of optionalKeys) Object.defineProperty(flat, key, getter);
  assert.deepEqual(productErrorFact(flat), facts('unknown')); assert.equal(hits, 0);
  const hidden = productFailure(); Object.defineProperties(hidden, {
    bindingReason: { value: 'window_missing' }, stages: { value: ledger('close_tab', 'unknown') } });
  optionalResult(await actualCatchWrapper(() => { throw hidden; }).invoke(),
    { bindingReason: 'window_missing', lastWriteStage: 'close_tab', lastWriteDelivery: 'unknown' });
});
test('CALL current captured facts stay with their error across cleanup and supersede historical logging', async () => {
  const late = productFailure({ bindingReason: 'window_missing', stages: ledger('close_tab', 'sent') });
  for (const extra of [{}, { bindingReason: 'cg_mapping_mismatch', stages: ledger('activate_tab', 'unknown') }]) {
    const h = actualCatchWrapper(() => { throw productFailure(extra); }, { tail: async () => { throw late; } });
    const expected = extra.bindingReason ? { bindingReason: extra.bindingReason, lastWriteStage: 'activate_tab', lastWriteDelivery: 'unknown' } : {};
    optionalResult(await h.invoke(), expected);
  }
  const h = actualCatchWrapper((state, args) => {
    state.firstErrorCode = 'new_tab_unconfirmed'; state.firstErrorStage = 'open_tab_identity';
    throw productFailure(args.which === 'earlier' ? { bindingReason: 'window_missing', stages: ledger() } : {});
  }, { twice: true });
  optionalResult(await h.invoke({ which: 'current' }), {});
  assert.equal(h.stores[0], h.stores[1]);
  for (const key of optionalKeys) assert.equal(Object.hasOwn(h.stores[1], key), false);
});
test('outer optional precedence accepts bounded CALL facts and derives uncaptured error ledgers only', async () => {
  const direct = productFailure({ bindingReason: 'window_missing', stages: ledger('close_tab', 'sent') });
  for (const [captured, expected] of [
    [{}, { bindingReason: 'window_missing', lastWriteStage: 'close_tab', lastWriteDelivery: 'sent' }],
    [{ bindingReason: 'cg_mapping_mismatch', lastWriteStage: 'activate_tab', lastWriteDelivery: 'unknown' },
      { bindingReason: 'cg_mapping_mismatch', lastWriteStage: 'activate_tab', lastWriteDelivery: 'unknown' }],
    [{ bindingReason: 'synthetic_private_reason', lastWriteStage: 'close_tab' }, {}],
    [{ nativeErrorFactsCaptured: true }, {}]
  ]) {
    const h = wrapper(state => { Object.assign(state, captured); throw direct; });
    optionalResult(await h.invoke(), expected);
  }
});
test('overlapping real inner catches and a later success retain no optional cross-call state', async () => {
  let ready, release; const entered = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = actualCatchWrapper(async (_, args) => {
    if (args.which === 'first') { ready(); await gate; throw productFailure({ bindingReason: 'window_missing', stages: ledger() }); }
    if (args.which === 'second') throw productFailure({ bindingReason: 'cg_mapping_mismatch', stages: ledger('close_tab', 'unknown') });
    if (args.which === 'ordinary') throw productFailure();
    return 'Successful inert tool';
  });
  const first = h.invoke({ which: 'first' }); await entered;
  const second = await h.invoke({ which: 'second' }); release();
  optionalResult(await first, { bindingReason: 'window_missing', lastWriteStage: 'activate_tab', lastWriteDelivery: 'sent' });
  optionalResult(second, { bindingReason: 'cg_mapping_mismatch', lastWriteStage: 'close_tab', lastWriteDelivery: 'unknown' });
  optionalResult(await h.invoke({ which: 'ordinary' }), {});
  assert.deepEqual(normalize(await h.invoke({ which: 'success' })), { content: [{ type: 'text', text: 'Successful inert tool' }] });
  assert.equal(new Set(h.stores).size, 4); assert.equal(h.CALL.getStore(), undefined);
});
test('strict receipt reader allows finite optional members and rejects incomplete or unexpected stored facts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-optional-receipt-'));
  const binding = 'inert-optional-binding', workerPid = process.pid, file = path.join(directory, 'terminal-receipt.json');
  const base = { schema: 1, workerPid, bindingSha256: terminalBinding(binding, workerPid), at: new Date().toISOString(),
    terminal: { code: 'unexpected_mcp_error', stage: 'worker', inputDelivery: 'unknown', noRetry: true }, fixtures: [], call: null, pinned: null, diagnostic: null };
  const valid = [{}, ...BINDING_REASONS.map(bindingReason => ({ bindingReason })),
    ...WRITE_STAGES.flatMap(lastWriteStage => ['sent', 'not_sent', 'unknown'].map(lastWriteDelivery => ({ lastWriteStage, lastWriteDelivery }))),
    { bindingReason: 'window_missing', lastWriteStage: 'close_tab', lastWriteDelivery: 'sent' }];
  const invalid = [{ bindingReason: 'synthetic_private_reason' }, { lastWriteStage: 'close_tab' }, { lastWriteDelivery: 'sent' },
    { lastWriteStage: 'native_binding', lastWriteDelivery: 'sent' }, { lastWriteStage: 'close_tab', lastWriteDelivery: 'invalid' },
    { stages: ledger() }, { bindingReason: null }, { lastWriteStage: null, lastWriteDelivery: null }];
  try {
    for (const extra of valid) {
      const productError = { ...facts('unknown'), ...extra };
      fs.writeFileSync(file, JSON.stringify({ ...base, productError }), { mode: 0o600 });
      assert.deepEqual((await readTerminalReceipt(directory, binding, workerPid)).productError, productError);
    }
    for (const extra of invalid) {
      fs.writeFileSync(file, JSON.stringify({ ...base, productError: { ...facts('unknown'), ...extra } }), { mode: 0o600 });
      await assert.rejects(readTerminalReceipt(directory, binding, workerPid), /content_invalid/);
      assert.deepEqual(productErrorFact({ ...facts('unknown'), ...extra }), facts('unknown'));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// Reviewed additions are independent of the protected historical vocabulary.
// They project only bounded public facts; internal geometry is never exported.
const WINDOW_CODES=['native_display_unavailable','native_geometry_unconfirmed','native_full_frame_conflict','guard_landing_unreachable'];
const WINDOW_STAGES=['activate_fit','native_display_read','native_geometry_prepare','native_geometry_verify','native_geometry_refresh'];
test('window geometry failures preserve bounded code stage delivery and keep geometry private',async()=>{
  for(const code of WINDOW_CODES)for(const stage of WINDOW_STAGES)for(const inputDelivery of ['sent','not_sent','unknown']){
    const h=actualCatchWrapper(()=>{throw Object.assign(Error('Synthetic window refusal'),{code,stage,inputDelivery,
      geometry:{mode:'fit-current',displayId:1,private:'synthetic_private_geometry'}});});
    const out=await h.invoke();assert.equal(out.isError,true);
    assert.deepEqual(normalize(out.structuredContent.error),{code,stage,inputDelivery});
    assert.equal(JSON.stringify(out).includes('synthetic_private_geometry'),false);
  }
});
test('activation fitting is a bounded last-entered-write projection',async()=>{
  for(const delivery of ['sent','not_sent','unknown']){
    const h=actualCatchWrapper(()=>{throw productFailure({stages:ledger('activate_fit',delivery)});});
    const out=await h.invoke();assert.deepEqual(normalize(out.structuredContent.error),{...facts('unknown'),lastWriteStage:'activate_fit',lastWriteDelivery:delivery});
    assert.equal(Object.hasOwn(h.stores[0],'stages'),false);assert.equal(Object.hasOwn(h.stores[0],'reply'),false);
  }
});

const COVERED_SOURCES = ['dom_hit_test', 'native_point_blocker'];
const coveredFacts = { code: 'target_covered', stage: 'unobserved', inputDelivery: 'unknown' };
const coveredFailure = extra => Object.assign(Error('Safe target coverage refusal'), coveredFacts, extra);
function coveredProducer(kind) {
  const effects = [], forbidden = () => { throw Error('unexpected continuation after covered target'); };
  const loc = { visible: { x: 10, y: 20, width: 30, height: 40 }, land: { x: 10, y: 20, width: 30, height: 40 },
    aim: { x: 25, y: 40 }, hitOk: kind === 'native_point_blocker', hitBy: 'fixture-overlay',
    tag: 'button', text: 'Fixture confirm', private: 'synthetic_private_dom' };
  const at = bridge.indexOf('class BridgeError '), bridgeError = bridge.slice(at, bridge.indexOf('\n}', at) + 2);
  assert.ok(at >= 0);
  const c = vm.createContext({
    B: { axInput: async () => { effects.push('axInput'); return { blocker: { appName: 'Fixture app', private: 'synthetic_private_native' } }; } },
    locateForInput: async () => { effects.push('locate'); return loc; },
    originFor: () => { effects.push('origin'); return {}; },
    scrollToTarget: async () => { effects.push('scroll'); return { loc, done: true, notches: 0 }; },
    guardNativeSelect: async () => { effects.push('nativeSelect'); },
    rectToScreenRect: value => { effects.push('screenRect'); return value; },
    toScreen: value => { effects.push('screenPoint'); return value; },
    planScrollStep: forbidden, post: forbidden, armAck: forbidden, clickObservation: forbidden,
    rememberNativeTarget: forbidden, refuseNativeSelect: forbidden,
  });
  vm.runInContext([bridgeError, actualFunction('guardNativeTarget'), actualFunction('clickDeliver')].join('\n'), c);
  return { effects, run: () => c.clickDeliver({}, { chromePid: 50, cgWindow: 90, target: { tabId: 7 } },
    { mark: value => effects.push('mark:' + value) }, { marker: 1 }, { listBefore: [] }) };
}
test('actual target_covered producers preserve their closed source through the actual inner catch', async () => {
  for (const targetCoveredSource of COVERED_SOURCES) {
    const producer = coveredProducer(targetCoveredSource);
    const result = await actualCatchWrapper(() => producer.run()).invoke();
    const expected = { ...coveredFacts, targetCoveredSource };
    assert.deepEqual(normalize(result.structuredContent.error), expected);
    assert.deepEqual(productErrorFact(result.structuredContent.error), expected);
    assert.deepEqual(producer.effects, ['locate', 'mark:relocated', 'origin', 'scroll', 'nativeSelect',
      ...(targetCoveredSource === 'native_point_blocker' ? ['origin', 'screenRect', 'screenPoint', 'axInput'] : [])]);
    assert.equal(JSON.stringify(result.structuredContent).includes('synthetic_private_'), false);
  }
});
test('targetCoveredSource is own-data closed evidence only for target_covered', async () => {
  let hits = 0;
  const getter = { get() { hits++; throw Error('synthetic_private_getter'); } };
  const coercible = { toString() { hits++; throw Error('synthetic_private_coercion'); } };
  for (const value of [undefined, null, '', 'dom_hit_test\n', 'native', 'synthetic_private_source', 0, [], {}, coercible]) {
    const error = coveredFailure({ targetCoveredSource: value });
    const out = await actualCatchWrapper(() => { throw error; }).invoke();
    assert.deepEqual(normalize(out.structuredContent.error), coveredFacts);
    assert.deepEqual(productErrorFact({ ...coveredFacts, targetCoveredSource: value }), coveredFacts);
  }
  for (const targetCoveredSource of COVERED_SOURCES) {
    const wrong = productFailure({ targetCoveredSource });
    optionalResult(await actualCatchWrapper(() => { throw wrong; }).invoke(), {});
    assert.deepEqual(productErrorFact({ ...facts('unknown'), targetCoveredSource }), facts('unknown'));
    const nested = coveredFailure({ reply: { targetCoveredSource } });
    const out = await actualCatchWrapper(() => { throw nested; }).invoke();
    assert.deepEqual(normalize(out.structuredContent.error), { ...coveredFacts, targetCoveredSource });
    nested.targetCoveredSource = 'synthetic_private_invalid_direct';
    assert.deepEqual(normalize((await actualCatchWrapper(() => { throw nested; }).invoke()).structuredContent.error), coveredFacts);
  }
  const inherited = coveredFailure(); Object.setPrototypeOf(inherited, { targetCoveredSource: COVERED_SOURCES[0] });
  const direct = coveredFailure(); Object.defineProperty(direct, 'targetCoveredSource', getter);
  const nested = coveredFailure({ reply: {} }); Object.defineProperty(nested.reply, 'targetCoveredSource', getter);
  for (const error of [inherited, direct, nested]) {
    assert.deepEqual(normalize((await actualCatchWrapper(() => { throw error; }).invoke()).structuredContent.error), coveredFacts);
  }
  const flat = { ...coveredFacts }; Object.defineProperty(flat, 'targetCoveredSource', getter);
  assert.deepEqual(productErrorFact(flat), coveredFacts); assert.equal(hits, 0);
});
test('targetCoveredSource stays with the current error across cleanup and overlapping calls', async () => {
  const late = coveredFailure({ targetCoveredSource: COVERED_SOURCES[1] });
  for (const extra of [{}, { targetCoveredSource: COVERED_SOURCES[0] }]) {
    const h = actualCatchWrapper(() => { throw coveredFailure(extra); }, { tail: async () => { throw late; } });
    assert.deepEqual(normalize((await h.invoke()).structuredContent.error), { ...coveredFacts, ...extra });
  }
  const twice = actualCatchWrapper((_, args) => { throw coveredFailure(args.which === 'earlier' ? { targetCoveredSource: COVERED_SOURCES[0] } : {}); }, { twice: true });
  assert.deepEqual(normalize((await twice.invoke()).structuredContent.error), coveredFacts);
  assert.equal(Object.hasOwn(twice.stores.at(-1), 'targetCoveredSource'), false);
  let ready, release; const entered = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = actualCatchWrapper(async (_, args) => {
    if (args.which === 'first') { ready(); await gate; throw coveredFailure({ targetCoveredSource: COVERED_SOURCES[0] }); }
    if (args.which === 'second') throw coveredFailure({ targetCoveredSource: COVERED_SOURCES[1] });
    return 'Successful inert tool';
  });
  const first = h.invoke({ which: 'first' }); await entered;
  const second = await h.invoke({ which: 'second' }); release();
  assert.deepEqual(normalize((await first).structuredContent.error), { ...coveredFacts, targetCoveredSource: COVERED_SOURCES[0] });
  assert.deepEqual(normalize(second.structuredContent.error), { ...coveredFacts, targetCoveredSource: COVERED_SOURCES[1] });
  assert.equal(Object.hasOwn(await h.invoke({ which: 'success' }), 'structuredContent'), false);
  assert.equal(new Set(h.stores).size, 3);
});
test('terminal receipt accepts only the two target_covered source values and rejects cross-code evidence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-covered-receipt-'));
  const binding = 'inert-covered-binding', workerPid = process.pid, file = path.join(directory, 'terminal-receipt.json');
  const base = { schema: 1, workerPid, bindingSha256: terminalBinding(binding, workerPid), at: new Date().toISOString(),
    terminal: { code: 'unexpected_mcp_error', stage: 'click', inputDelivery: 'unknown', noRetry: true }, fixtures: [], call: null, pinned: null, diagnostic: null };
  try {
    for (const targetCoveredSource of COVERED_SOURCES) {
      const productError = { ...coveredFacts, targetCoveredSource };
      fs.writeFileSync(file, JSON.stringify({ ...base, productError }), { mode: 0o600 });
      assert.deepEqual((await readTerminalReceipt(directory, binding, workerPid)).productError, productError);
    }
    for (const productError of [
      ...[null, '', 'dom_hit_test\n', 'synthetic_private_source', 42, {}, []].map(targetCoveredSource => ({ ...coveredFacts, targetCoveredSource })),
      ...COVERED_SOURCES.map(targetCoveredSource => ({ ...facts('unknown'), targetCoveredSource }))]) {
      fs.writeFileSync(file, JSON.stringify({ ...base, productError }), { mode: 0o600 });
      await assert.rejects(readTerminalReceipt(directory, binding, workerPid), /content_invalid/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// Independently reviewed failure-site vocabulary; these labels do not identify a root cause.
const DIALOG_PROBE_POINTS = [
  'native_attribute_deadline', 'native_attribute_read', 'native_windows_shape',
  'native_subrole_shape', 'native_sheets_shape', 'native_walk_guard',
  'native_button_title', 'native_button_label', 'native_text_value',
  'native_children_read', 'native_dialog_final', 'cli_inspect_catch',
  'bridge_child_failed', 'bridge_output_invalid', 'bridge_reply_invalid'];
const dialogFacts = { code: 'dialog_probe_unknown', stage: 'dialog_inspect', inputDelivery: 'not_sent' };
const dialogFailure = extra => Object.assign(Error('Safe synthetic dialog failure'), dialogFacts, extra);
const dialogResult = async error => normalize((await actualCatchWrapper(() => { throw error; }).invoke()).structuredContent.error);
test('all fifteen dialog failure points survive actual inner capture and both projectors', async () => {
  for (const dialogProbePoint of DIALOG_PROBE_POINTS) for (const nested of [false, true]) {
    const extra = nested ? { reply: { dialogProbePoint } } : { dialogProbePoint };
    const result = await dialogResult(dialogFailure(extra));
    assert.deepEqual(result, { ...dialogFacts, dialogProbePoint });
    assert.deepEqual(productErrorFact(result), result);
  }
});
test('dialog point requires exact code and stage and rejects unknown, inherited, accessor and coercible values', async () => {
  let hits = 0;
  const getter = { get() { hits++; throw Error('synthetic_private_getter'); } };
  const coercible = { toString() { hits++; throw Error('synthetic_private_coercion'); } };
  for (const dialogProbePoint of [undefined, null, '', 'native_attribute_read\n', 'native', 'synthetic_private_point', 15, [], {}, coercible]) {
    assert.deepEqual(await dialogResult(dialogFailure({ dialogProbePoint })), dialogFacts);
    assert.deepEqual(productErrorFact({ ...dialogFacts, dialogProbePoint }), dialogFacts);
  }
  for (const changed of [{ code: 'native_target_changed' }, { stage: 'dialog_identity' }, { stage: 'native_read_deadline' }]) {
    const base = { ...dialogFacts, ...changed }, error = dialogFailure({ ...changed, dialogProbePoint: DIALOG_PROBE_POINTS[0] });
    assert.deepEqual(await dialogResult(error), base);
    assert.deepEqual(productErrorFact(error), base);
  }
  const inherited = dialogFailure(); Object.setPrototypeOf(inherited, { dialogProbePoint: DIALOG_PROBE_POINTS[0] });
  const direct = dialogFailure(); Object.defineProperty(direct, 'dialogProbePoint', getter);
  const nested = dialogFailure({ reply: {} }); Object.defineProperty(nested.reply, 'dialogProbePoint', getter);
  const hidden = dialogFailure(); Object.defineProperty(hidden, 'dialogProbePoint', { value: DIALOG_PROBE_POINTS[0] });
  for (const error of [inherited, direct, nested]) assert.deepEqual(await dialogResult(error), dialogFacts);
  assert.deepEqual(await dialogResult(hidden), { ...dialogFacts, dialogProbePoint: DIALOG_PROBE_POINTS[0] });
  const flat = { ...dialogFacts }; Object.defineProperty(flat, 'dialogProbePoint', getter);
  assert.deepEqual(productErrorFact(flat), dialogFacts); assert.equal(hits, 0);
});
test('dialog point selects own evidence before validation and empty captures never fall back', async () => {
  const direct = dialogFailure({ dialogProbePoint: DIALOG_PROBE_POINTS[0], reply: { dialogProbePoint: DIALOG_PROBE_POINTS[1] } });
  for (const [captured, expected] of [
    [{}, DIALOG_PROBE_POINTS[0]],
    [{ ...dialogFacts, dialogProbePoint: DIALOG_PROBE_POINTS[2] }, DIALOG_PROBE_POINTS[2]],
    [{ ...dialogFacts, dialogProbePoint: 'synthetic_private_invalid' }, undefined],
    [{ ...dialogFacts, nativeErrorFactsCaptured: true }, undefined]
  ]) {
    const out = await wrapper(state => { Object.assign(state, captured); throw direct; }).invoke();
    assert.deepEqual(normalize(out.structuredContent.error), { ...dialogFacts, ...(expected ? { dialogProbePoint: expected } : {}) });
  }
  direct.dialogProbePoint = 'synthetic_private_invalid';
  assert.deepEqual(await dialogResult(direct), dialogFacts);
  direct.dialogProbePoint = null;
  assert.deepEqual(await dialogResult(direct), { ...dialogFacts, dialogProbePoint: DIALOG_PROBE_POINTS[1] });
});
test('dialog captures remain with their error through cleanup, repeated catches and overlapping calls', async () => {
  const late = dialogFailure({ dialogProbePoint: DIALOG_PROBE_POINTS[1] });
  for (const extra of [{}, { dialogProbePoint: DIALOG_PROBE_POINTS[0] }]) {
    const h = actualCatchWrapper(() => { throw dialogFailure(extra); }, { tail: async () => { throw late; } });
    assert.deepEqual(normalize((await h.invoke()).structuredContent.error), { ...dialogFacts, ...extra });
  }
  const twice = actualCatchWrapper((_, args) => { throw dialogFailure(args.which === 'earlier' ? { dialogProbePoint: DIALOG_PROBE_POINTS[0] } : {}); }, { twice: true });
  assert.deepEqual(normalize((await twice.invoke()).structuredContent.error), dialogFacts);
  assert.equal(Object.hasOwn(twice.stores.at(-1), 'dialogProbePoint'), false);
  let ready, release; const entered = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = actualCatchWrapper(async (_, args) => {
    if (args.which === 'first') { ready(); await gate; throw dialogFailure({ dialogProbePoint: DIALOG_PROBE_POINTS[0] }); }
    if (args.which === 'second') throw dialogFailure({ dialogProbePoint: DIALOG_PROBE_POINTS[1] });
    return 'Successful inert tool';
  });
  const first = h.invoke({ which: 'first' }); await entered;
  const second = await h.invoke({ which: 'second' }); release();
  assert.deepEqual(normalize((await first).structuredContent.error), { ...dialogFacts, dialogProbePoint: DIALOG_PROBE_POINTS[0] });
  assert.deepEqual(normalize(second.structuredContent.error), { ...dialogFacts, dialogProbePoint: DIALOG_PROBE_POINTS[1] });
  assert.equal(Object.hasOwn(await h.invoke({ which: 'success' }), 'structuredContent'), false);
  assert.equal(new Set(h.stores).size, 3);
});
test('terminal reader accepts only scoped dialog points and retains close preflight timeout without changing terminal uncertainty', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-dialog-point-receipt-'));
  const binding = 'inert-dialog-point-binding', workerPid = process.pid, file = path.join(directory, 'terminal-receipt.json');
  const base = { schema: 1, workerPid, bindingSha256: terminalBinding(binding, workerPid), at: new Date().toISOString(),
    terminal: { code: 'unexpected_mcp_error', stage: 'read_page', inputDelivery: 'unknown', noRetry: true }, fixtures: [], call: null, pinned: null, diagnostic: null };
  try {
    const close = { code: 'close_prepare_timeout', stage: 'close_preflight', inputDelivery: 'not_sent' };
    assert.deepEqual(productErrorFact(close), close);
    for (const productError of [...DIALOG_PROBE_POINTS.map(dialogProbePoint => ({ ...dialogFacts, dialogProbePoint })), close]) {
      fs.writeFileSync(file, JSON.stringify({ ...base, productError }), { mode: 0o600 });
      const receipt = await readTerminalReceipt(directory, binding, workerPid);
      assert.deepEqual(receipt.productError, productError); assert.deepEqual(receipt.terminal, base.terminal);
    }
    for (const productError of [
      ...[null, '', 'native_attribute_read\n', 'synthetic_private_point', 42, {}, []].map(dialogProbePoint => ({ ...dialogFacts, dialogProbePoint })),
      ...[{ code: 'native_target_changed' }, { stage: 'dialog_identity' }, { stage: 'native_read_deadline' }]
        .map(changed => ({ ...dialogFacts, ...changed, dialogProbePoint: DIALOG_PROBE_POINTS[0] }))]) {
      fs.writeFileSync(file, JSON.stringify({ ...base, productError }), { mode: 0o600 });
      await assert.rejects(readTerminalReceipt(directory, binding, workerPid), /content_invalid/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// Independent producer contract: no values, identifiers, URLs, counts or timings.
const NATIVE_READ_GETTERS = ['windows', 'window_ids', 'window', 'bounds', 'minimized', 'index',
  'tabs', 'tab_ids', 'tab_urls', 'tab_url_ids', 'active_tab', 'active_tab_id', 'title'];
const NATIVE_READ_SHAPES = ['window_ids_shape', 'tab_url_ids_shape', 'row_shape'];
const NATIVE_READ_PAIRS = [
  ...NATIVE_READ_GETTERS.flatMap(nativeReadPoint => [
    { code: 'native_read_timeout', nativeReadPoint, nativeReadReason: 'before_deadline' },
    { code: 'native_read_unknown', nativeReadPoint, nativeReadReason: 'nil_or_type' },
    { code: 'native_read_unknown', nativeReadPoint, nativeReadReason: 'after_deadline' }]),
  ...NATIVE_READ_SHAPES.map(nativeReadPoint => ({ code: 'native_read_unknown', nativeReadPoint, nativeReadReason: 'shape' })),
  { code: 'native_read_unknown', nativeReadPoint: 'runner', nativeReadReason: 'runner_other' }
];
const nativeReadFacts = (code = 'native_read_unknown', inputDelivery = 'not_sent') => ({ code, stage: 'native_read', inputDelivery });
const nativeReadFailure = extra => Object.assign(Error('Safe synthetic read failure'), nativeReadFacts(), extra);
const nativeReadResult = async (error, options) => normalize((await actualCatchWrapper(() => { throw error; }, options).invoke()).structuredContent.error);
const readPairA = { nativeReadPoint: 'windows', nativeReadReason: 'nil_or_type' };
const readPairB = { nativeReadPoint: 'row_shape', nativeReadReason: 'shape' };

test('native read all 43 producer pairs survive actual capture and both bounded projectors', async () => {
  assert.equal(NATIVE_READ_PAIRS.length, 43);
  for (const { code, ...pair } of NATIVE_READ_PAIRS) for (const nested of [false, true]) {
    const expected = { ...nativeReadFacts(code), ...pair };
    const error = nativeReadFailure({ code, ...(nested ? { reply: pair } : pair) });
    assert.deepEqual(await nativeReadResult(error), expected);
    assert.deepEqual(productErrorFact(expected), expected);
  }
});

test('native read rejects impossible code point reason combinations and non-data values', async () => {
  const points = [...NATIVE_READ_GETTERS, ...NATIVE_READ_SHAPES, 'runner'];
  const reasons = ['before_deadline', 'nil_or_type', 'after_deadline', 'shape', 'runner_other'];
  const valid = new Set(NATIVE_READ_PAIRS.map(({ code, nativeReadPoint, nativeReadReason }) => JSON.stringify([code, nativeReadPoint, nativeReadReason])));
  for (const code of ['native_read_unknown', 'native_read_timeout']) for (const nativeReadPoint of points) for (const nativeReadReason of reasons) {
    if (valid.has(JSON.stringify([code, nativeReadPoint, nativeReadReason]))) continue;
    const value = { ...nativeReadFacts(code), nativeReadPoint, nativeReadReason };
    assert.deepEqual(await nativeReadResult(nativeReadFailure(value)), nativeReadFacts(code));
    assert.deepEqual(productErrorFact(value), nativeReadFacts(code));
  }
  let hits = 0;
  const coercible = { toString() { hits++; throw Error('synthetic_private_coercion'); } };
  for (const field of ['nativeReadPoint', 'nativeReadReason']) for (const value of [undefined, null, '', 'windows\n', 'nil_or_type\n',
    'synthetic_private_value', 7, true, [], {}, coercible]) {
    const extra = { ...readPairA, [field]: value };
    assert.deepEqual(await nativeReadResult(nativeReadFailure(extra)), nativeReadFacts());
    assert.deepEqual(productErrorFact({ ...nativeReadFacts(), ...extra }), nativeReadFacts());
  }
  for (const changed of [{ code: 'native_target_changed' }, { code: 'chrome_error' }, { code: 'native_permission_required' },
    { stage: 'native_read_deadline' }, { stage: 'native_binding' }]) {
    const expected = { ...nativeReadFacts(), ...changed };
    assert.deepEqual(await nativeReadResult(nativeReadFailure({ ...changed, ...readPairA })), expected);
    assert.deepEqual(productErrorFact({ ...expected, ...readPairA }), expected);
  }
  assert.equal(hits, 0);
});

test('native read selects a whole own-data carrier and never combines partial direct nested or captured fields', async () => {
  const direct = nativeReadFailure({ ...readPairA, reply: readPairB });
  for (const [captured, pair] of [
    [{}, readPairA], [{ ...nativeReadFacts(), ...readPairB }, readPairB],
    [{ ...nativeReadFacts(), nativeReadPoint: 'row_shape' }, {}],
    [{ ...nativeReadFacts(), nativeReadReason: 'shape' }, {}],
    [{ ...nativeReadFacts(), nativeReadPoint: null, nativeReadReason: null }, {}],
    [{ ...nativeReadFacts(), nativeErrorFactsCaptured: true }, {}]
  ]) {
    const out = await wrapper(state => { Object.assign(state, captured); throw direct; }).invoke();
    assert.deepEqual(normalize(out.structuredContent.error), { ...nativeReadFacts(), ...pair });
  }
  for (const extra of [
    { nativeReadPoint: 'windows', reply: { nativeReadReason: 'nil_or_type' } },
    { nativeReadReason: 'nil_or_type', reply: { nativeReadPoint: 'windows' } },
    { nativeReadPoint: 'windows', reply: readPairA },
    { nativeReadReason: 'nil_or_type', reply: readPairA },
    { nativeReadPoint: undefined, reply: readPairA },
    { nativeReadReason: null, reply: readPairA },
    { nativeReadPoint: 'synthetic_private_point', nativeReadReason: 'nil_or_type', reply: readPairA },
    { nativeReadPoint: 'row_shape', nativeReadReason: 'nil_or_type', reply: readPairA }
  ]) assert.deepEqual(await nativeReadResult(nativeReadFailure(extra)), nativeReadFacts());
  let hits = 0;
  const getter = { get() { hits++; throw Error('synthetic_private_getter'); } };
  for (const key of ['nativeReadPoint', 'nativeReadReason']) {
    const ownGetter = nativeReadFailure({ reply: readPairA }); Object.defineProperty(ownGetter, key, getter);
    const nestedGetter = nativeReadFailure({ reply: { ...readPairA } }); Object.defineProperty(nestedGetter.reply, key, getter);
    const flat = { ...nativeReadFacts(), ...readPairA }; Object.defineProperty(flat, key, getter);
    assert.deepEqual(await nativeReadResult(ownGetter), nativeReadFacts());
    assert.deepEqual(await nativeReadResult(nestedGetter), nativeReadFacts());
    assert.deepEqual(productErrorFact(flat), nativeReadFacts());
  }
  const inherited = nativeReadFailure(); Object.setPrototypeOf(inherited, readPairA);
  assert.deepEqual(await nativeReadResult(inherited), nativeReadFacts());
  const hidden = nativeReadFailure(); Object.defineProperties(hidden, {
    nativeReadPoint: { value: 'windows' }, nativeReadReason: { value: 'nil_or_type' } });
  assert.deepEqual(await nativeReadResult(hidden), { ...nativeReadFacts(), ...readPairA });
  const trap = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('synthetic_private_trap'); } });
  assert.deepEqual(await nativeReadResult(nativeReadFailure({ reply: trap })), nativeReadFacts());
  assert.equal(hits, 0);
});

test('native read empty current captures defeat cleanup and stale prior facts while overlapping calls stay separate', async () => {
  const late = nativeReadFailure(readPairB);
  for (const pair of [{}, readPairA]) {
    const h = actualCatchWrapper(() => { throw nativeReadFailure(pair); }, { tail: async () => { throw late; } });
    assert.deepEqual(normalize((await h.invoke()).structuredContent.error), { ...nativeReadFacts(), ...pair });
  }
  const twice = actualCatchWrapper((state, args) => {
    state.firstErrorCode = 'native_read_unknown'; state.firstErrorStage = 'native_read';
    throw nativeReadFailure(args.which === 'earlier' ? readPairA : {});
  }, { twice: true });
  assert.deepEqual(normalize((await twice.invoke()).structuredContent.error), nativeReadFacts());
  assert.equal(Object.hasOwn(twice.stores.at(-1), 'nativeReadPoint'), false);
  assert.equal(Object.hasOwn(twice.stores.at(-1), 'nativeReadReason'), false);
  let entered, release; const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = actualCatchWrapper(async (_, args) => {
    if (args.which === 'first') { entered(); await gate; throw nativeReadFailure(readPairA); }
    if (args.which === 'second') throw nativeReadFailure({ ...readPairB, inputDelivery: 'sent' });
    return 'Successful inert tool';
  });
  const first = h.invoke({ which: 'first' }); await ready;
  const second = await h.invoke({ which: 'second' }); release();
  assert.deepEqual(normalize((await first).structuredContent.error), { ...nativeReadFacts(), ...readPairA });
  assert.deepEqual(normalize(second.structuredContent.error), { ...nativeReadFacts('native_read_unknown', 'sent'), ...readPairB });
  assert.equal(Object.hasOwn(await h.invoke({ which: 'success' }), 'structuredContent'), false);
  assert.equal(new Set(h.stores).size, 3);
});

function nativeReadTransport(reply, mutate = code => code) {
  const at = bridge.indexOf('class BridgeError '); assert.ok(at >= 0);
  const bridgeError = bridge.slice(at, bridge.indexOf('\n}', at) + 2);
  let nativeCalls = 0;
  const context = vm.createContext({ CALL: new AsyncLocalStorage(), PLAN: null, RoutineError: class extends Error {},
    pauseGate: async () => {}, noteOutcome: () => {}, goneTabNote: () => '', setupHint: () => '', redactText, redactToolResult,
    SESSION_ERRORS: { native_read_unknown: 'Safe synthetic read failure', native_read_timeout: 'Safe synthetic read failure' },
    native: async () => { nativeCalls++; return reply; } });
  vm.runInContext([bridgeError, actualFunction('sessionErrorBase', bridge), actualFunction('sessionError', bridge),
    actualFunction('nativeWrite', bridge), actualFunction('callToolInner'), actualFunction('progressFor'), mutate(actualFunction('callTool')),
    'globalThis.openTabTool=()=>nativeWrite(native,{kind:"newWindow"}); globalThis.callToolRun=req=>callToolInner(req.params.name,req.params.arguments,{},async()=>""); globalThis.invoke=callTool;'].join('\n'), context);
  return { raw: context.invoke, nativeCalls: () => nativeCalls };
}

function driverReadTransport(reply, mutate = code => code) {
  const at = bridge.indexOf('class BridgeError '); assert.ok(at >= 0);
  const bridgeError = bridge.slice(at, bridge.indexOf('\n}', at) + 2);
  let calls = 0;
  const context = vm.createContext({ CALL: new AsyncLocalStorage(), PLAN: null, RoutineError: class extends Error {},
    pauseGate: async () => {}, noteOutcome: () => {}, goneTabNote: () => '', setupHint: () => '', redactText, redactToolResult,
    WARM_ON: false, CHROMECTL: '/inert/chromectl', humanMessage: () => 'Safe synthetic read failure',
    process: { env: {}, stderr: { write() { throw Error('Unexpected trace output'); } } },
    execFileP: async (binary, argv, options) => {
      assert.equal(binary, '/inert/chromectl'); assert.deepEqual(Array.from(argv), ['info']); assert.equal(options.timeout, 25000);
      calls++; return { stdout: JSON.stringify(reply), stderr: '' };
    } });
  vm.runInContext([bridgeError, actualFunction('driverFailureFacts', bridge), mutate(actualFunction('runDriver', bridge)),
    actualFunction('chromeInfo', bridge), actualFunction('callToolInner'), actualFunction('progressFor'), actualFunction('callTool'),
    'globalThis.openTabTool=()=>chromeInfo(null); globalThis.callToolRun=req=>callToolInner(req.params.name,req.params.arguments,{},async()=>""); globalThis.invoke=callTool;'].join('\n'), context);
  // Keep the shared oracle's one-upstream-call assertion for this cold CLI route.
  return { raw: context.invoke, nativeCalls: () => calls };
}

async function nativeReadPublicReceipt(pair, inputDelivery, mutate, transport = nativeReadTransport) {
  const expected = { ...nativeReadFacts(pair.code, inputDelivery), nativeReadPoint: pair.nativeReadPoint, nativeReadReason: pair.nativeReadReason };
  const h = transport({ ok: false, error: pair.code, stage: 'native_read', inputDelivery,
    nativeReadPoint: pair.nativeReadPoint, nativeReadReason: pair.nativeReadReason,
    rawValue: 'synthetic_private_value', windowId: 123, url: 'https://synthetic_private.invalid/', title: 'synthetic_private_title', count: 9, time: 17 }, mutate);
  const server = new Server({ name: 'inert-native-read-wrapper', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, (req, extra) => h.raw(req, extra));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'open_tab', inputSchema: { type: 'object', properties: {} } }] }));
  const client = new Client({ name: 'inert-native-read-client', version: '1' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-native-read-receipt-'));
  await server.connect(serverSide);
  try {
    await client.connect(clientSide);
    const result = await client.callTool({ name: 'open_tab', arguments: {} });
    assert.deepEqual(result.structuredContent.error, expected);
    assert.equal(h.nativeCalls(), 1);
    assert.equal(JSON.stringify(result).includes('synthetic_private'), false);
    // The actual terminal writer runs in a disposable inert child and exits before continuation.
    const helper = new URL('./harness-terminal.mjs', import.meta.url).href;
    const childSource = `import {disposeTerminal} from ${JSON.stringify(helper)};
      import {writeFileSync} from 'node:fs';
      disposeTerminal({directory:process.argv[2],binding:'inert-native-read-binding',terminal:{code:'unexpected_mcp_error',stage:'open_tab'},
        call:{tool:'open_tab',startedAt:1,responseAt:2},productError:JSON.parse(process.argv[1])});
      writeFileSync(process.argv[2]+'/forbidden-continuation','continued');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource, JSON.stringify(result.structuredContent.error), directory],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 86);
    assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
    const receipt = await readTerminalReceipt(directory, 'inert-native-read-binding', child.pid);
    assert.deepEqual(receipt.productError, expected);
    assert.deepEqual(receipt.terminal, { code: 'unexpected_mcp_error', stage: 'open_tab', inputDelivery: 'unknown', noRetry: true });
    assert.equal(fs.existsSync(path.join(directory, 'forbidden-continuation')), false);
  } finally { await client.close(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

test('native read actual nativeWrite reply public SDK and terminal writer roundtrip preserve bounded pairs', async () => {
  const samples = [NATIVE_READ_PAIRS[0], NATIVE_READ_PAIRS[1], NATIVE_READ_PAIRS[2], NATIVE_READ_PAIRS[39], NATIVE_READ_PAIRS[42]];
  for (const [i, pair] of samples.entries()) await nativeReadPublicReceipt(pair, ['not_sent', 'unknown', 'sent'][i % 3]);
});

test('native read cold runDriver JSON error chromeInfo public SDK and terminal writer preserve the same pair', async () => {
  const samples = [NATIVE_READ_PAIRS[0], NATIVE_READ_PAIRS[1], NATIVE_READ_PAIRS[2], NATIVE_READ_PAIRS[39], NATIVE_READ_PAIRS[42]];
  for (const [i, pair] of samples.entries()) await nativeReadPublicReceipt(pair, ['not_sent', 'unknown', 'sent'][i % 3], undefined, driverReadTransport);
});

test('native read stored pair validation rejects partial illegal or cross-code facts and keeps legacy schema1', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-native-read-validation-'));
  const binding = 'inert-native-read-binding', workerPid = process.pid, file = path.join(directory, 'terminal-receipt.json');
  const base = { schema: 1, workerPid, bindingSha256: terminalBinding(binding, workerPid), at: new Date().toISOString(),
    terminal: { code: 'unexpected_mcp_error', stage: 'open_tab', inputDelivery: 'unknown', noRetry: true }, fixtures: [], call: null, pinned: null, diagnostic: null };
  const read = async productError => { fs.writeFileSync(file, JSON.stringify({ ...base, ...(productError ? { productError } : {}) }), { mode: 0o600 }); return readTerminalReceipt(directory, binding, workerPid); };
  try {
    assert.deepEqual(await read(null), base);
    assert.deepEqual((await read(nativeReadFacts())).productError, nativeReadFacts());
    for (const { code, ...pair } of NATIVE_READ_PAIRS) {
      const productError = { ...nativeReadFacts(code), ...pair }, receipt = await read(productError);
      assert.deepEqual(receipt.productError, productError); assert.deepEqual(receipt.terminal, base.terminal);
    }
    for (const extra of [
      { nativeReadPoint: 'windows' }, { nativeReadReason: 'nil_or_type' },
      { ...readPairA, nativeReadPoint: null }, { ...readPairA, nativeReadReason: null },
      { ...readPairA, nativeReadPoint: 'windows\n' }, { ...readPairA, nativeReadReason: 'nil_or_type\n' },
      { ...readPairA, nativeReadPoint: 'synthetic_private_point' }, { ...readPairA, nativeReadReason: {} },
      { ...readPairA, code: 'native_target_changed' }, { ...readPairA, stage: 'native_read_deadline' },
      { nativeReadPoint: 'windows', nativeReadReason: 'shape' }, { nativeReadPoint: 'row_shape', nativeReadReason: 'nil_or_type' },
      { nativeReadPoint: 'runner', nativeReadReason: 'before_deadline' },
      { ...readPairA, code: 'native_read_timeout' }, { ...readPairA, nativeReadReason: 'before_deadline' },
      { ...readPairA, rawValue: 'synthetic_private_value' }
    ]) await assert.rejects(read({ ...nativeReadFacts(), ...extra }), /content_invalid/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('native read same positive and negative oracles reject projection loss and mixed-carrier mutants', async () => {
  const transfer = 'facts.nativeReadPoint = nativeReadPoint; facts.nativeReadReason = nativeReadReason;';
  assert.equal(actualFunction('callTool').split(transfer).length, 2);
  await assert.rejects(nativeReadPublicReceipt(NATIVE_READ_PAIRS[1], 'not_sent', code => code.replace(transfer, '/* mutant: drop paired native-read evidence */')),
    error => error.code === 'ERR_ASSERTION');
  const selection = 'const read = capturedOnly ? nativeReadPair(captured) : nativeReadPair(captured) ?? nativeReadPair(error) ?? nativeReadPair(reply);';
  assert.equal(actualFunction('callTool').split(selection).length, 2);
  const mutate = code => code.replace(selection, `const read = { nativeReadPoint: own(captured, 'nativeReadPoint') ?? own(error, 'nativeReadPoint') ?? own(reply, 'nativeReadPoint'),
      nativeReadReason: own(captured, 'nativeReadReason') ?? own(error, 'nativeReadReason') ?? own(reply, 'nativeReadReason') };`);
  const sameNegativeOracle = async options => assert.deepEqual(await nativeReadResult(nativeReadFailure({ nativeReadPoint: 'windows', reply: { nativeReadReason: 'nil_or_type' } }), options), nativeReadFacts());
  await sameNegativeOracle();
  await assert.rejects(sameNegativeOracle({ mutate }), error => error.code === 'ERR_ASSERTION');
});

const CHILD_FACT = { op: 'sample', code: 'chromectl_failed', driverCommand: 'eval', exitCode: 7,
  signal: 'SIGTERM', killed: true, timedOut: null };
test('worker and RPC failure projections use own finite data without getters or timeout inference', () => {
  let hits = 0;
  const getter = { get() { hits++; throw Error('synthetic_private_getter'); } };
  const fields = ['code', 'driverCommand', 'exitCode', 'signal', 'killed', 'timedOut'];
  const accessor = Object.defineProperties({}, Object.fromEntries(fields.map(key => [key, getter])));
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const unknown = { toString() { hits++; throw Error('synthetic_private_coercion'); } };
  const blank = { op: 'sample', code: 'unavailable', driverCommand: 'unavailable', exitCode: null, signal: null, killed: null, timedOut: null };
  for (const value of [accessor, Object.create(CHILD_FACT), revoked.proxy, Object.fromEntries(fields.map(key => [key, unknown]))]) {
    assert.deepEqual(workerFailureFact('sample', value), blank); assert.deepEqual(rpcFailureFact(value), { code: null });
  }
  assert.deepEqual(workerFailureFact('sample', { ...CHILD_FACT, timedOut: true, message: 'synthetic_private_message', argv: ['synthetic_private_path'] }), CHILD_FACT);
  assert.deepEqual(workerFailureFact('sample', { ...CHILD_FACT, code: 'native_target_changed' }), { ...blank, code: 'native_target_changed' });
  for (const op of ['call', 'observe', 'dialog', 'synthetic_private_op', null]) assert.equal(workerFailureFact(op, CHILD_FACT), null);
  for (const code of [-32000, -32001, -32603, '-32001', 'ETIMEDOUT', unknown, null])
    assert.deepEqual(rpcFailureFact({ code, message: 'synthetic_private_message', data: CHILD_FACT }), { code: [-32000, -32001].includes(code) ? code : null });
  assert.equal(hits, 0);
});
test('schema1 reader accepts optional child and RPC evidence only in their matching operation context', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-child-receipt-'));
  const binding = 'inert-child-binding', workerPid = process.pid, file = path.join(directory, 'terminal-receipt.json');
  const base = { schema: 1, workerPid, bindingSha256: terminalBinding(binding, workerPid), at: new Date().toISOString(),
    terminal: { code: 'chromectl_failed', stage: 'worker', inputDelivery: 'unknown', noRetry: true }, fixtures: [], call: null, pinned: null, diagnostic: null };
  const read = async value => { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return readTerminalReceipt(directory, binding, workerPid); };
  const rpc = { ...base, terminal: { ...base.terminal, code: 'dispatched_rpc_rejected', stage: 'type_text' },
    call: { tool: 'type_text', startedAt: 1, responseAt: null } };
  try {
    assert.deepEqual(await read(base), base);
    assert.deepEqual((await read({ ...base, workerFailure: CHILD_FACT })).workerFailure, CHILD_FACT);
    for (const code of [-32000, -32001, null]) assert.deepEqual((await read({ ...rpc, rpcFailure: { code } })).rpcFailure, { code });
    for (const workerFailure of [null, {}, { ...CHILD_FACT, op: 'call' }, { ...CHILD_FACT, code: 'synthetic_private_code' },
      { ...CHILD_FACT, driverCommand: 'synthetic_private_path' }, { ...CHILD_FACT, exitCode: '7' }, { ...CHILD_FACT, exitCode: 1.5 },
      { ...CHILD_FACT, signal: 'synthetic_private_signal' }, { ...CHILD_FACT, killed: 1 }, { ...CHILD_FACT, timedOut: true },
      { ...CHILD_FACT, message: 'synthetic_private_message' }, { ...CHILD_FACT, code: 'native_target_changed' }])
      await assert.rejects(read({ ...base, workerFailure }), /content_invalid/);
    for (const rpcFailure of [null, {}, { code: '-32001' }, { code: -32603 }, { code: -32001, message: 'synthetic_private_message' }])
      await assert.rejects(read({ ...rpc, rpcFailure }), /content_invalid/);
    await assert.rejects(read({ ...rpc, workerFailure: CHILD_FACT }), /content_invalid/);
    await assert.rejects(read({ ...base, rpcFailure: { code: -32001 } }), /content_invalid/);
    await assert.rejects(read({ ...rpc, terminal: { ...rpc.terminal, code: 'unexpected_mcp_error' }, rpcFailure: { code: -32001 } }), /content_invalid/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
