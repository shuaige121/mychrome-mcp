// Disposable acceptance workers only. No product lifecycle or browser calls.
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const TERMINAL_EXIT = 86;
export const RECEIPT_FAILURE_EXIT = 87;
const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const terminalBinding = (secret, pid) => digest(`${pid}\0${secret}`);
export const terminalPath = directory => path.join(directory, 'terminal-receipt.json');
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = value => typeof value === 'string' && /^[a-zA-Z0-9_ .:-]{1,120}$/.test(value) ? value : 'unknown';
const identity = value => Object.fromEntries(['tabId', 'windowId', 'chromePid', 'cgWindow'].map(key => [key, number(value?.[key])]));
const callFact = value => value ? { tool: label(value.tool), startedAt: number(value.startedAt), responseAt: number(value.responseAt) } : null;
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const maybeNumber = value => value === null || number(value) === value;
const identityValid = value => keys(value, ['tabId', 'windowId', 'chromePid', 'cgWindow']) && Object.values(value).every(maybeNumber);
// Reviewed finite public output vocabulary, not proof of the producer or claim.
const productCodes = new Set([
  'aborted', 'activate_failed', 'activate_unconfirmed', 'agent_window_minimized', 'already_begun',
  'auto_skipped_field', 'auto_skipped_incomplete_template', 'auto_skipped_origin_mismatch',
  'auto_skipped_origin_unverified', 'auto_skipped_template_mismatch', 'ax_probe_failed', 'ax_probe_timeout',
  'bad_args', 'bad_button', 'bad_crop', 'bad_direction', 'bad_driver_output', 'bad_geometry_side_inset',
  'bad_geometry_toolbar_tall', 'bad_geometry_toolbar_zero', 'bad_image', 'bad_input_mode', 'bad_native_target',
  'bad_page_result', 'bad_plan', 'bad_progress', 'bad_replace', 'bad_request', 'bad_sections', 'bad_select',
  'bad_url', 'blank_text', 'cancelled', 'cannot_check', 'capture_failed', 'cgevent_failed', 'chrome_error',
  'chrome_not_running', 'chromectl_failed', 'close_blocked', 'close_pending', 'close_prepare_timeout', 'close_prompt_pending',
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
]);
const productStages = new Set([
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
]);
const deliveries = ['sent', 'not_sent', 'unknown'];
const bindingReasons = new Set(['window_missing', 'tab_not_in_window', 'active_tab_mismatch',
  'cg_mapping_missing', 'cg_mapping_mismatch', 'snapshot_structure_changed']);
const coveredSources = new Set(['dom_hit_test', 'native_point_blocker']);
const dialogProbePoints = new Set([
  'native_attribute_deadline', 'native_attribute_read', 'native_windows_shape',
  'native_subrole_shape', 'native_sheets_shape', 'native_walk_guard',
  'native_button_title', 'native_button_label', 'native_text_value',
  'native_children_read', 'native_dialog_final', 'cli_inspect_catch',
  'bridge_child_failed', 'bridge_output_invalid', 'bridge_reply_invalid']);
const nativeReadGetters = new Set(['windows', 'window_ids', 'window', 'bounds', 'minimized', 'index',
  'tabs', 'tab_ids', 'tab_urls', 'tab_url_ids', 'active_tab', 'active_tab_id', 'title']);
const nativeReadShapes = new Set(['window_ids_shape', 'tab_url_ids_shape', 'row_shape']);
const nativeReadPairValid = (code, stage, point, reason) => stage === 'native_read' && (
  (code === 'native_read_timeout' && nativeReadGetters.has(point) && reason === 'before_deadline') ||
  (code === 'native_read_unknown' && (
    (nativeReadGetters.has(point) && ['nil_or_type', 'after_deadline'].includes(reason)) ||
    (nativeReadShapes.has(point) && reason === 'shape') || (point === 'runner' && reason === 'runner_other'))));
const writeStages = new Set(['dialog_set', 'dialog_press', 'close_tab', 'window_bounds', 'select_tab',
  'activate_unminimize', 'activate_tab', 'activate_index', 'activate_main', 'activate_raise', 'activate_app',
  'open_tab_create', 'open_tab_url', 'open_restore_tab', 'open_restore_index', 'new_window_create',
  'new_window_bounds', 'new_window_url', 'restore_app', 'restore_tab', 'restore_index', 'restore_app_again']);
const ownData = (value, key) => {
  if (value === null || !['object', 'function'].includes(typeof value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
};
function productOptionalErrorFacts(value) {
  const facts = {}, reason = ownData(value, 'bindingReason');
  if (bindingReasons.has(reason)) facts.bindingReason = reason;
  const coveredSource = ownData(value, 'targetCoveredSource');
  if (ownData(value, 'code') === 'target_covered' && coveredSources.has(coveredSource)) facts.targetCoveredSource = coveredSource;
  const dialogProbePoint = ownData(value, 'dialogProbePoint');
  if (ownData(value, 'code') === 'dialog_probe_unknown' && ownData(value, 'stage') === 'dialog_inspect'
      && dialogProbePoints.has(dialogProbePoint)) facts.dialogProbePoint = dialogProbePoint;
  const nativeReadPoint = ownData(value, 'nativeReadPoint'), nativeReadReason = ownData(value, 'nativeReadReason');
  if (nativeReadPairValid(ownData(value, 'code'), ownData(value, 'stage'), nativeReadPoint, nativeReadReason)) {
    facts.nativeReadPoint = nativeReadPoint; facts.nativeReadReason = nativeReadReason;
  }
  const stage = ownData(value, 'lastWriteStage'), delivery = ownData(value, 'lastWriteDelivery');
  if (writeStages.has(stage) && deliveries.includes(delivery)) {
    facts.lastWriteStage = stage; facts.lastWriteDelivery = delivery;
  }
  return facts;
}
const driverCommands = new Set(['info', 'eval', 'dialog', 'list', 'profiles', 'scene', 'unavailable']);
const childSignals = new Set(['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL',
  'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'SIGXCPU', 'SIGXFSZ']);
/** Non-MCP worker read failure, captured from this rejection only. */
export function workerFailureFact(op, value) {
  if (!['own', 'sample'].includes(op) || value == null) return null;
  const code = ownData(value, 'code'), child = code === 'chromectl_failed';
  const command = child ? ownData(value, 'driverCommand') : null;
  const exitCode = child ? ownData(value, 'exitCode') : null;
  const signal = child ? ownData(value, 'signal') : null;
  const killed = child ? ownData(value, 'killed') : null;
  return { op, code: productCodes.has(code) ? code : 'unavailable',
    driverCommand: driverCommands.has(command) ? command : 'unavailable',
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    signal: childSignals.has(signal) ? signal : null,
    killed: typeof killed === 'boolean' ? killed : null, timedOut: null };
}
/** A numeric SDK rejection code is evidence; its message and data are not. */
export function rpcFailureFact(value) {
  const code = ownData(value, 'code');
  return { code: [-32000, -32001].includes(code) ? code : null };
}
const workerFailureValid = value => keys(value, ['op', 'code', 'driverCommand', 'exitCode', 'signal', 'killed', 'timedOut'])
  && ['own', 'sample'].includes(value.op) && productCodes.has(value.code) && driverCommands.has(value.driverCommand)
  && (value.exitCode === null || Number.isSafeInteger(value.exitCode)) && (value.signal === null || childSignals.has(value.signal))
  && (value.killed === null || typeof value.killed === 'boolean') && value.timedOut === null
  && (value.code === 'chromectl_failed' || (value.driverCommand === 'unavailable' && value.exitCode === null && value.signal === null && value.killed === null));
const rpcFailureValid = value => keys(value, ['code']) && (value.code === null || [-32000, -32001].includes(value.code));
/** Product claims only, never input authority or human-error reconstruction. */
export function productErrorFact(value) {
  if (value == null) return null;
  const object = typeof value === 'object' && !Array.isArray(value) ? value : {};
  const own = key => Object.hasOwn(object, key) ? object[key] : undefined;
  return { code: productCodes.has(own('code')) ? own('code') : 'unavailable',
    stage: productStages.has(own('stage')) ? own('stage') : 'unobserved',
    inputDelivery: deliveries.includes(own('inputDelivery')) ? own('inputDelivery') : 'unknown',
    ...productOptionalErrorFacts(object) };
}
const productErrorValid = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const optional = ['bindingReason', 'lastWriteStage', 'lastWriteDelivery', 'targetCoveredSource', 'dialogProbePoint',
    'nativeReadPoint', 'nativeReadReason'].filter(key => Object.hasOwn(value, key));
  const hasReason = optional.includes('bindingReason'), hasStage = optional.includes('lastWriteStage');
  const hasDelivery = optional.includes('lastWriteDelivery');
  return keys(value, ['code', 'stage', 'inputDelivery', ...optional])
    && productCodes.has(value.code) && productStages.has(value.stage) && deliveries.includes(value.inputDelivery)
    && (!hasReason || bindingReasons.has(ownData(value, 'bindingReason')))
    && (!optional.includes('targetCoveredSource') || (value.code === 'target_covered' && coveredSources.has(ownData(value, 'targetCoveredSource'))))
    && (!optional.includes('dialogProbePoint') || (value.code === 'dialog_probe_unknown' && value.stage === 'dialog_inspect'
      && dialogProbePoints.has(ownData(value, 'dialogProbePoint'))))
    && optional.includes('nativeReadPoint') === optional.includes('nativeReadReason')
    && (!optional.includes('nativeReadPoint') || nativeReadPairValid(value.code, value.stage,
      ownData(value, 'nativeReadPoint'), ownData(value, 'nativeReadReason')))
    && hasStage === hasDelivery
    && (!hasStage || (writeStages.has(ownData(value, 'lastWriteStage')) && deliveries.includes(ownData(value, 'lastWriteDelivery'))));
};

/** Synchronous receipt then immediate exit: no Promise/IPC/cleanup window in
 * which an already-entered releaseKept continuation could resume. */
export function disposeTerminal({ directory, binding, terminal, fixtures = [], call = null, pinned = null, diagnostic = null, productError = null, workerFailure = null, rpcFailure = null }) {
  const product = productErrorFact(productError);
  const worker = call === null ? workerFailureFact(ownData(workerFailure, 'op'), workerFailure) : null;
  const rpc = rpcFailure !== null && call !== null && terminal.code === 'dispatched_rpc_rejected' ? rpcFailureFact(rpcFailure) : null;
  const receipt = {
    schema: 1, workerPid: process.pid, bindingSha256: terminalBinding(binding, process.pid),
    at: new Date().toISOString(), terminal: { code: label(terminal.code), stage: label(terminal.stage || 'harness'),
      inputDelivery: 'unknown', noRetry: true },
    fixtures: fixtures.slice(0, 32).map(identity), call: callFact(call),
    pinned: pinned ? { helperPid: number(pinned.session?.pid), sessionId: label(pinned.sessionId),
      epoch: number(pinned.hold?.kept?.nativeState?.epoch),
      leaseTokenSha256: typeof pinned.token === 'string' ? digest(pinned.token) : null } : null,
    diagnostic: diagnostic ? { attempts: number(diagnostic.attempts), registered: diagnostic.registered === true,
      exact: diagnostic.exact === true, identity: identity(diagnostic.identity), createdAt: number(diagnostic.createdAt) } : null,
    ...(product ? { productError: product } : {}),
    ...(worker ? { workerFailure: worker } : {}),
    ...(rpc ? { rpcFailure: rpc } : {}),
  };
  let exitCode = TERMINAL_EXIT;
  try {
    writeFileSync(terminalPath(directory), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch { exitCode = RECEIPT_FAILURE_EXIT; }
  process.exit(exitCode);
}

/** Parent-side evidence validation. A lost IPC response or absent/bad receipt
 * remains unknown failure; a receipt never turns a terminal exit into success. */
export async function readTerminalReceipt(directory, binding, workerPid) {
  const file = terminalPath(directory), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536)
    throw Error('terminal_receipt_file_invalid');
  const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
  if (receipt.schema !== 1 || receipt.workerPid !== workerPid || receipt.bindingSha256 !== terminalBinding(binding, workerPid)
      || !Number.isFinite(Date.parse(receipt.at)) || typeof receipt.terminal?.code !== 'string'
      || receipt.terminal.inputDelivery !== 'unknown' || receipt.terminal.noRetry !== true || !Array.isArray(receipt.fixtures))
    throw Error('terminal_receipt_binding_invalid');
  if (receipt.pinned && receipt.pinned.leaseTokenSha256 !== null && !/^[a-f0-9]{64}$/.test(receipt.pinned.leaseTokenSha256))
    throw Error('terminal_receipt_lease_digest_invalid');
  const receiptKeys = ['schema', 'workerPid', 'bindingSha256', 'at', 'terminal', 'fixtures', 'call', 'pinned', 'diagnostic'];
  const optional = ['productError', 'workerFailure', 'rpcFailure'].filter(key => Object.hasOwn(receipt, key));
  if (!keys(receipt, [...receiptKeys, ...optional])
      || (Object.hasOwn(receipt, 'productError') && !productErrorValid(receipt.productError))
      || (Object.hasOwn(receipt, 'workerFailure') && (receipt.call !== null || !workerFailureValid(receipt.workerFailure)))
      || (Object.hasOwn(receipt, 'rpcFailure') && (receipt.call === null || receipt.terminal.code !== 'dispatched_rpc_rejected' || !rpcFailureValid(receipt.rpcFailure)))
      || !keys(receipt.terminal, ['code', 'stage', 'inputDelivery', 'noRetry'])
      || label(receipt.terminal.code) !== receipt.terminal.code || label(receipt.terminal.stage) !== receipt.terminal.stage
      || receipt.fixtures.length > 32 || !receipt.fixtures.every(identityValid)
      || (receipt.call !== null && (!keys(receipt.call, ['tool', 'startedAt', 'responseAt'])
        || label(receipt.call.tool) !== receipt.call.tool || !maybeNumber(receipt.call.startedAt) || !maybeNumber(receipt.call.responseAt)))
      || (receipt.pinned !== null && (!keys(receipt.pinned, ['helperPid', 'sessionId', 'epoch', 'leaseTokenSha256'])
        || !maybeNumber(receipt.pinned.helperPid) || !maybeNumber(receipt.pinned.epoch) || label(receipt.pinned.sessionId) !== receipt.pinned.sessionId))
      || (receipt.diagnostic !== null && (!keys(receipt.diagnostic, ['attempts', 'registered', 'exact', 'identity', 'createdAt'])
        || !maybeNumber(receipt.diagnostic.attempts) || !maybeNumber(receipt.diagnostic.createdAt)
        || typeof receipt.diagnostic.registered !== 'boolean' || typeof receipt.diagnostic.exact !== 'boolean' || !identityValid(receipt.diagnostic.identity))))
    throw Error('terminal_receipt_content_invalid');
  return receipt;
}
