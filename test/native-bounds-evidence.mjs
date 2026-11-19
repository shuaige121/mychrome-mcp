/** Private, opt-in harness evidence. No product/native/browser operations. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { types } from 'node:util';
import { terminalBinding } from './harness-terminal.mjs';

export const TRACE_BYTES = 32768;
export const RECEIPT_BYTES = 65536;
export const boundsEvidencePath = directory => path.join(directory, 'native-bounds-evidence-receipt.json');
const invalid = () => { throw Error('bounds_evidence_invalid'); };
const ownData = (value, key) => {
  if (!value || !['object', 'function'].includes(typeof value) || types.isProxy(value)) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && Object.hasOwn(d, 'value') ? d.value : undefined;
};
function object(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || !keys.every(k => actual.includes(k))) invalid();
  const out = {};
  for (const k of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, k);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    out[k] = descriptor.value;
  }
  return out;
}
function array(value, max, project) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const n = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(n) || n < 0 || n > max || Reflect.ownKeys(value).length !== n + 1) invalid();
  const out = [];
  for (let i = 0; i < n; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    out.push(project(descriptor.value));
  }
  return out;
}
const enumeration = (value, values) => values.includes(value) ? value : invalid();
const integer = (value, min = 0, max = 65535) => Number.isInteger(value) && value >= min && value <= max ? value : invalid();
const maybe = (value, project) => value === null ? null : project(value);
const boolean = value => typeof value === 'boolean' ? value : invalid();
const windowAlias = value => typeof value === 'string' && /^W([1-9]|1[0-6])$/.test(value) ? value : invalid();
const cgAlias = value => typeof value === 'string' && /^C([1-9]|[12][0-9]|3[0-2])$/.test(value) ? value : invalid();
const unique = values => new Set(values).size === values.length ? values : invalid();
const rect = value => {
  const out = array(value, 4, n => typeof n === 'number' && Number.isFinite(n) ? n : invalid());
  if (out.length !== 4 || Math.abs(out[0]) > 1000000 || Math.abs(out[1]) > 1000000
      || out[2] <= 0 || out[2] > 1000000 || out[3] <= 0 || out[3] > 1000000) invalid();
  return out;
};
const REASONS = ['window_alias_cap', 'cg_alias_cap', 'row_cap', 'decision_cap', 'relation_cap',
  'geometry_out_of_range', 'index_out_of_range', 'count_saturated', 'byte_cap', 'projection_failure', 'read_unavailable', 'phase_incomplete'];
const RECEIPT_REASONS = ['trace_missing', 'typed_stop', 'dialog_failure', 'malformed_or_uncorrelated', 'overlap',
  'no_correlated_reply', 'request_not_dispatched', 'no_new_window_request', 'in_flight_at_terminal', 'projection_failure'];
const PHASE_KEYS = ['state', 'attempts', 'target', 'expected', 'mapped', 'binding', 'structural', 'chrome', 'cg', 'ax', 'relations', 'decisions'];
const COUNT_KEYS = ['hits', 'twins', 'visible', 'rivals', 'strict', 'loose', 'group'];
function phase(value) {
  const hasFailure = ownData(value, 'firstStructureFailure') !== undefined;
  const p = object(value, hasFailure ? [...PHASE_KEYS, 'firstStructureFailure'] : PHASE_KEYS);
  const a = object(p.ax, ['state', 'enumerationStatus', 'returned_count', 'rows']);
  const out = {
    state: enumeration(p.state, ['not_reached', 'complete', 'incomplete']), attempts: integer(p.attempts),
    target: maybe(p.target, windowAlias), expected: maybe(p.expected, cgAlias), mapped: maybe(p.mapped, cgAlias),
    binding: enumeration(p.binding, ['not_checked', 'matched', 'window_missing', 'tab_not_in_window', 'active_tab_mismatch', 'cg_mapping_missing', 'cg_mapping_mismatch', 'unavailable']),
    structural: enumeration(p.structural, ['not_checked', 'same', 'changed', 'unavailable']),
    chrome: array(p.chrome, 16, value => { const r = object(value, ['w', 'rect', 'index', 'minimized']);
      return { w: windowAlias(r.w), rect: maybe(r.rect, rect), index: maybe(r.index, v => integer(v, 1)), minimized: boolean(r.minimized) }; }),
    cg: array(p.cg, 32, value => { const r = object(value, ['c', 'rect', 'onScreen']);
      return { c: cgAlias(r.c), rect: maybe(r.rect, rect), onScreen: boolean(r.onScreen) }; }),
    ax: { state: enumeration(a.state, ['called', 'not_called']), enumerationStatus: enumeration(a.enumerationStatus, ['unobserved']),
      returned_count: maybe(a.returned_count, integer), rows: array(a.rows, 32, value => {
        const r = object(value, ['c', 'rect', 'minimized']);
        return { c: cgAlias(r.c), rect: maybe(r.rect, rect), minimized: boolean(r.minimized) };
      }) },
    relations: array(p.relations, 32, value => {
      const r = object(value, ['w', 'kind', 'counts', 'titleNonempty', 'titlesChanged', 'windows', 'cgs']);
      const counts = object(r.counts, COUNT_KEYS);
      return { w: maybe(r.w, windowAlias), kind: enumeration(r.kind, ['bounds', 'title', 'order']),
        counts: Object.fromEntries(COUNT_KEYS.map(k => [k, maybe(counts[k], integer)])),
        titleNonempty: maybe(r.titleNonempty, boolean), titlesChanged: maybe(r.titlesChanged, boolean),
        windows: unique(array(r.windows, 16, windowAlias)), cgs: unique(array(r.cgs, 32, cgAlias)) };
    }),
    decisions: array(p.decisions, 32, value => { const d = object(value, ['w', 'c', 'branch']);
      return { w: maybe(d.w, windowAlias), c: maybe(d.c, cgAlias),
        branch: enumeration(d.branch, ['unique_bounds', 'visibility', 'ax_strict', 'ax_loose', 'order', 'duplicate_claim_removed', 'retained_exact', 'document_exact', 'document_conflict_refused']) }; }),
  };
  if (hasFailure) {
    const failure = object(p.firstStructureFailure, ['scope', 'field']);
    const scope = enumeration(failure.scope, ['target', 'other', 'snapshot']);
    const field = enumeration(failure.field, ['duplicate_id', 'count', 'id', 'tabs', 'active_tab', 'bounds', 'minimized', 'index']);
    if (out.state === 'not_reached' || out.structural !== 'changed' || (scope === 'snapshot') !== (field === 'count')) invalid();
    // The first rejected row is not an exhaustive snapshot comparison. In
    // particular, "other" does not establish that the target remained stable.
    out.firstStructureFailure = { scope, field };
  }
  return out;
}
/** Own-data only, closed projection. Never serialize the supplied object. */
export function projectBoundsTrace(value) {
  const t = object(value, ['schema', 'status', 'reasons', 'requestedRect', 'phases']);
  // Accept only the exact legacy or extended set; unknown/missing phases stay closed.
  const phaseNames = ownData(t.phases, 'post_url') === undefined
    ? ['initial', 'pre_bounds', 'post_bounds'] : ['initial', 'pre_bounds', 'post_bounds', 'post_url'];
  const phases = object(t.phases, phaseNames);
  const out = { schema: enumeration(t.schema, [1]), status: enumeration(t.status, ['complete', 'incomplete', 'unavailable']),
    reasons: unique(array(t.reasons, 12, r => enumeration(r, REASONS))), requestedRect: maybe(t.requestedRect, rect),
    phases: Object.fromEntries(phaseNames.map(name => [name, phase(phases[name])])) };
  const reasons = new Set(out.reasons), incomplete = out.status !== 'complete';
  if (incomplete !== (reasons.size > 0)) invalid();
  const requireReason = (...allowed) => { if (!incomplete || !allowed.some(r => reasons.has(r))) invalid(); };
  if (out.requestedRect === null) requireReason('geometry_out_of_range', 'byte_cap', 'projection_failure');
  const windows = new Set(), cgs = new Set(), refsW = [], refsC = [];
  for (const [name, p] of Object.entries(out.phases)) {
    unique(p.chrome.map(r => r.w)); unique(p.cg.map(r => r.c)); unique(p.ax.rows.map(r => r.c));
    for (const r of p.chrome) windows.add(r.w);
    for (const r of [...p.cg, ...p.ax.rows]) cgs.add(r.c);
    if (p.state === 'not_reached') {
      if (p.attempts !== 0 || p.target !== null || p.expected !== null || p.mapped !== null
          || p.binding !== 'not_checked' || p.structural !== 'not_checked' || p.chrome.length || p.cg.length
          || p.ax.state !== 'not_called' || p.ax.returned_count !== null || p.ax.rows.length || p.relations.length || p.decisions.length) invalid();
      continue;
    }
    if (p.attempts < 1 || (p.state === 'incomplete' && !incomplete)) invalid();
    const requirePhaseReason = (...allowed) => { if (p.state !== 'incomplete') invalid(); requireReason(...allowed); };
    if (p.target === null) requirePhaseReason('window_alias_cap'); else refsW.push({ alias: p.target, phase: p });
    if (name === 'initial') { if (p.expected !== null || p.binding !== 'not_checked') invalid(); }
    else if (p.expected === null) requirePhaseReason('cg_alias_cap');
    if (p.expected !== null) refsC.push({ alias: p.expected, phase: p });
    if (p.mapped !== null) refsC.push({ alias: p.mapped, phase: p });
    else if (p.binding === 'matched' || p.binding === 'cg_mapping_mismatch') requirePhaseReason('cg_alias_cap');
    if (p.binding === 'unavailable' || p.structural === 'unavailable') requirePhaseReason('read_unavailable', 'phase_incomplete', 'projection_failure');
    if (p.ax.state === 'not_called' && (p.ax.returned_count !== null || p.ax.rows.length)) invalid();
    if (p.ax.state === 'called' && p.ax.returned_count === null) requirePhaseReason('read_unavailable', 'phase_incomplete');
    for (const r of p.chrome) {
      if (r.rect === null) requirePhaseReason('geometry_out_of_range');
      if (r.index === null) requirePhaseReason('index_out_of_range');
    }
    for (const r of p.cg) if (r.rect === null) requirePhaseReason('geometry_out_of_range');
    for (const r of p.ax.rows) if (r.rect === null) requirePhaseReason('geometry_out_of_range', 'read_unavailable');
    for (const r of p.relations) {
      if (p.state === 'complete' && r.kind === 'order'
          && (r.counts.group !== r.windows.length || r.counts.hits !== r.cgs.length
            || r.windows.length !== r.cgs.length)) invalid();
      if (r.w === null) requirePhaseReason('window_alias_cap'); else refsW.push({ alias: r.w, phase: p });
      refsW.push(...r.windows.map(alias => ({ alias, phase: p }))); refsC.push(...r.cgs.map(alias => ({ alias, phase: p })));
    }
    for (const d of p.decisions) {
      if (d.w === null) requirePhaseReason('window_alias_cap'); else refsW.push({ alias: d.w, phase: p });
      if (d.c === null) requirePhaseReason('cg_alias_cap'); else refsC.push({ alias: d.c, phase: p });
    }
  }
  for (const ref of [...refsW.filter(r => !windows.has(r.alias)), ...refsC.filter(r => !cgs.has(r.alias))]) {
    if (ref.phase.state !== 'incomplete') invalid();
    requireReason('row_cap');
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > TRACE_BYTES) invalid();
  return out;
}
export function projectBoundsReceipt(value) {
  const r = object(value, ['schema', 'kind', 'workerPid', 'bindingSha256', 'callOrdinal', 'tool', 'sessionOrdinal', 'nativeOrdinal', 'outcome', 'capture', 'reason', 'trace']);
  if (typeof r.bindingSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.bindingSha256)) invalid();
  const out = { schema: enumeration(r.schema, [1]), kind: enumeration(r.kind, ['native_bounds']),
    workerPid: integer(r.workerPid, 1, 2147483647), bindingSha256: r.bindingSha256,
    callOrdinal: integer(r.callOrdinal, 1), tool: enumeration(r.tool, ['open_tab']),
    sessionOrdinal: maybe(r.sessionOrdinal, v => integer(v, 1)), nativeOrdinal: enumeration(r.nativeOrdinal, [1, null]),
    outcome: enumeration(r.outcome, ['returned', 'rejected', 'unsettled', 'not_dispatched']),
    capture: enumeration(r.capture, ['captured', 'unavailable']), reason: maybe(r.reason, v => enumeration(v, RECEIPT_REASONS)),
    trace: maybe(r.trace, projectBoundsTrace) };
  if (out.capture === 'captured') {
    if (out.reason !== null || out.trace === null || out.sessionOrdinal === null || out.nativeOrdinal !== 1
        || !['returned', 'rejected'].includes(out.outcome)) invalid();
  } else if (out.trace !== null || out.reason === null) invalid();
  if (Buffer.byteLength(JSON.stringify(out) + '\n', 'utf8') > RECEIPT_BYTES) invalid();
  return out;
}

/** One request-local writer, scoped by immutable accepted call and Session.
 * Product Promise/reply/error identities are preserved even when writing fails.
 * Overlap is assessed through capture; later calls never rewrite saved evidence
 * or turn a native Promise outcome into an enclosing MCP success claim. */
export function createBoundsEvidenceCollector({ directory, binding, workerPid = process.pid, write = writeFileSync }) {
  const storage = new AsyncLocalStorage(), active = new Set(), states = new WeakMap(), sessions = new WeakMap();
  const bindingSha256 = terminalBinding(binding, workerPid);
  let nextCall = 0, nextSession = 0, selected = null, attempted = false;
  function persist(state, outcome, reason, trace = null) {
    if (attempted || !state || state !== selected) return;
    attempted = true; // Consumed before projection, serialization or any I/O.
    const base = { schema: 1, kind: 'native_bounds', workerPid, bindingSha256,
      callOrdinal: state.context.callOrdinal, tool: 'open_tab', sessionOrdinal: state.native?.sessionOrdinal ?? null,
      nativeOrdinal: state.native ? 1 : null, outcome, capture: 'unavailable', reason, trace: null };
    try {
      let receipt;
      try { receipt = projectBoundsReceipt(trace === null ? base : { ...base, capture: 'captured', reason: null, trace }); }
      catch { receipt = projectBoundsReceipt({ ...base, capture: 'unavailable', reason: 'projection_failure', trace: null }); }
      write(boundsEvidencePath(directory), JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' });
    } catch {} // Diagnostic failure never replaces the product outcome; no retry.
  }
  function acceptCall(tool) {
    const context = Object.freeze({ callOrdinal: ++nextCall, tool });
    const state = { context, dispatched: false, settled: false, overlap: active.size > 0, native: null };
    states.set(context, state);
    if (!selected && tool === 'open_tab' && nextCall <= 65535) selected = state;
    if (active.size) for (const entry of active) states.get(entry).overlap = true;
    active.add(context);
    return context;
  }
  function settleCall(context) {
    const state = states.get(context);
    if (!state || state.settled) return;
    state.settled = true;
    if (state === selected && !attempted) {
      persist(state, state.native ? 'unsettled' : 'not_dispatched', state.overlap ? 'overlap'
        : state.native ? 'no_correlated_reply' : state.dispatched ? 'no_new_window_request' : 'request_not_dispatched');
    }
    active.delete(context);
  }
  function capture(state, native, outcome, value) {
    if (attempted) return;
    if (state !== selected || state.native !== native || state.settled || !active.has(state.context)) {
      persist(selected, outcome, 'malformed_or_uncorrelated'); return;
    }
    if (state.overlap) { persist(state, outcome, 'overlap'); return; }
    const reply = outcome === 'returned' ? value : ownData(value, 'reply');
    if (reply === undefined || reply === null) { persist(state, outcome, 'no_correlated_reply'); return; }
    if (ownData(reply, 'op') !== 'nativeChrome' || ownData(reply, 'operationId') !== native.operationId) {
      persist(state, outcome, 'malformed_or_uncorrelated'); return;
    }
    const trace = ownData(reply, '_boundsEvidence');
    if (trace === undefined) {
      persist(state, outcome, ownData(reply, 'error') === 'dialog_probe_unknown' && ownData(reply, 'stage') === 'native_read_deadline'
        ? 'dialog_failure' : 'trace_missing'); return;
    }
    if (trace === null) { persist(state, outcome, 'projection_failure'); return; }
    persist(state, outcome, null, trace);
  }
  function wrapSession(session) {
    if (!session || typeof session !== 'object' || types.isProxy(session) || sessions.has(session)) return session;
    const original = ownData(session, 'request');
    if (typeof original !== 'function') return session;
    const sessionOrdinal = ++nextSession;
    sessions.set(session, sessionOrdinal);
    const wrapped = function (...args) {
      const context = storage.getStore(), state = context && states.get(context), request = args[0];
      if (!state || state !== selected || state.settled || state.native || attempted || !active.has(context)
          || ownData(request, 'op') !== 'nativeChrome' || ownData(ownData(request, 'intent'), 'kind') !== 'newWindow')
        return Reflect.apply(original, session, args);
      let selectedArgs = args, native;
      try {
        const operationId = ownData(request, 'operationId'), epoch = ownData(request, 'epoch');
        if (typeof operationId !== 'string' || !operationId || !Number.isSafeInteger(epoch) || epoch < 0 || sessionOrdinal > 65535)
          throw Error('correlation_missing');
        if (types.isProxy(request) || Object.getPrototypeOf(request) !== Object.prototype) throw Error('request_not_plain');
        const descriptors = Object.getOwnPropertyDescriptors(request);
        if (Reflect.ownKeys(descriptors).some(k => typeof k !== 'string' || !Object.hasOwn(descriptors[k], 'value'))) throw Error('request_not_data');
        const flagged = Object.defineProperties({}, descriptors);
        Object.defineProperty(flagged, '_boundsEvidence', { value: 1, writable: true, enumerable: true, configurable: true });
        native = Object.freeze({ context, session, sessionOrdinal, operationId, epoch });
        state.native = native;
        selectedArgs = [flagged, ...args.slice(1)];
      } catch {
        persist(state, 'not_dispatched', state.overlap ? 'overlap' : 'malformed_or_uncorrelated');
        return Reflect.apply(original, session, args);
      }
      let pending;
      try { pending = Reflect.apply(original, session, selectedArgs); }
      catch (failure) { try { capture(state, native, 'rejected', failure); } catch {} throw failure; }
      // The original request Promise is the request-ID routing authority. Attach
      // before returning it; no second native request and no deferred file I/O.
      if (types.isPromise(pending) && !types.isProxy(pending)) {
        Promise.prototype.then.call(pending,
          reply => { try { capture(state, native, 'returned', reply); } catch {} },
          failure => { try { capture(state, native, 'rejected', failure); } catch {} });
      } else { persist(state, 'returned', 'no_correlated_reply'); }
      return pending;
    };
    try { session.request = wrapped; } catch {} // Unwrappable sessions remain product-owned.
    return session;
  }
  return {
    acceptCall,
    enterCall(context, fn) { if (!states.has(context)) throw Error('bounds_evidence_context_invalid'); return storage.run(context, fn); },
    markDispatched(context) { const state = states.get(context); if (state && !state.settled) state.dispatched = true; },
    settleCall, wrapSession,
    finalizeTerminal() {
      if (!selected || attempted) return;
      persist(selected, selected.native ? 'unsettled' : 'not_dispatched', selected.overlap ? 'overlap'
        : selected.native ? 'in_flight_at_terminal' : selected.dispatched ? 'no_new_window_request' : 'request_not_dispatched');
    },
    get attempted() { return attempted; },
  };
}

/** Parent-only saved bytes. The caller retains its exclusive mkdtemp directory
 * and fresh binding; this is not authentication against deliberate same-user forgery. */
export async function readBoundsEvidenceReceipt(directory, binding, workerPid, callOrdinal) {
  const dir = await fs.lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700) invalid();
  const file = boundsEvidencePath(directory), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > RECEIPT_BYTES) invalid();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || (opened.mode & 0o777) !== 0o600
        || opened.size < 1 || opened.size > RECEIPT_BYTES) invalid();
    const buffer = Buffer.alloc(RECEIPT_BYTES + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== opened.size || bytesRead > RECEIPT_BYTES) invalid();
    const receipt = projectBoundsReceipt(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    if (receipt.workerPid !== workerPid || receipt.bindingSha256 !== terminalBinding(binding, workerPid)
        || receipt.callOrdinal !== callOrdinal) invalid();
    return receipt;
  } finally { await handle.close(); }
}
