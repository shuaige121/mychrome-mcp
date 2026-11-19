#!/usr/bin/env node
/** Root-operated, local-only acceptance. Default and --check do no GUI/input.
 * node test/reliability-reset-live.mjs --check
 * node test/reliability-reset-live.mjs --run --root-operator --source /candidate --case input
 * --runtime /installed/root selects installed source instead. One case per run.
 * stop waits for the root's real Stop; handoff ends without resuming or closing.
 * No screenshots, user page bodies, prompt contents or raw MCP replies are saved.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { disposeTerminal, readTerminalReceipt, productErrorFact, workerFailureFact, rpcFailureFact } from './harness-terminal.mjs';
import { createBoundsEvidenceCollector, readBoundsEvidenceReceipt } from './native-bounds-evidence.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
export const CASES = ['input', 'dialog', 'close', 'handoff', 'concurrency', 'stop', 'partial-create', 'scroll-document', 'same-connection-writes'];
export const EXCLUDED = ['test/event-fingerprint.mjs', 'test/live-check.mjs', 'test/click-hardening-check.mjs'];
export const LEGACY = ['round6-live.mjs', 'round6-read-live.mjs', 'round7-block-live.mjs',
  'round7-ocr-live.mjs', 'round7-outline.mjs', 'round7-probe.mjs', 'round7-viewport.mjs'];
const HASH_FILES = ['src/index.js', 'src/guard.js', 'src/bridge.js', 'src/tabs.js',
  'src/page/read.js', 'src/page/locate.js', 'src/page/ask.js', 'src/chromectl.swift', 'src/helper.swift',
  'src/native-chrome.swift', 'scripts/build-native.sh', 'bin/chromectl', 'bin/cgevent'];
const WRITE_TOOLS = new Set(['task_plan', 'open_tab', 'click', 'type_text', 'answer_dialog', 'close_tab', 'wait_for_user']);
const error = (code, stage = 'harness') => Object.assign(new Error(code), { code, stage });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const measured = value => ({ basis: 'measured', value });
const unknown = reason => ({ basis: 'unobserved', value: null, reason });
export const LIVE_BUDGETS = Object.freeze({ mcpTimeoutMs: 180000, parentRpcTimeoutMs: 210000, episodeTimeoutMs: 600000 });

// Execution-graph source files and their last reviewed hashes. The hashes are
// recorded (receipt `sourceSha256`), never required to match: edits to these
// files must not break offline tests. They identify source bytes, never native
// execution or a binary. The live manifest separately binds binaries.
export const SCROLL_SOURCE_PINS = Object.freeze({
  'src/index.js': '28a73f44b2d557a39ae3c525e8db8ee9532a35d648e75b0717107fd25814c7a5',
  'src/bridge.js': '63191592640c1376b9de586dea61c8e762b4dbe578b7eeb67bde2c03db487d0a',
  'src/guard.js': 'e15aea5f5c5afabc5bd680071deff11be4495f9a1b91669cadde65163ad8bb0c',
  'src/page-events.js': 'fb269fde76ac2f5e5b0bddbca78857e0d225b5504f13af6dd3b365973388038d',
  'src/page/block.js': '54eb95ad1a98a9a98aa062154e2f751961532d2a436379c841c9a4f0c1ecf29f',
  'src/page/locate.js': '485beaf4c2d7b31ba6f0f9d95fb32efce83644e32af62966dfbbf377926c590e',
  'src/page/prompt-observation.js': '7a93aca466b88eff4f7d4534cc78c0ff2b5b86f2eb5874adade3ac6e3721de02',
  'src/page/scrollby.js': 'f5f92aaee6775bc4b41317d99ce25f2dfb0ee5c6e3575a8e93ead3b01bcbf1eb',
  'src/native-chrome.swift': 'c0654bf2b414f9ac33df8b7fb7300bff02af76f4eb5834ffb26b0749b39ce89e',
  'src/chromectl.swift': 'b4d4f5a94feac82bff92180d1e1701d01df5c112b11582d96d9cde078cf8182b',
  'src/helper.swift': 'e164b71b65258827886f8fccc9327cefdeb56e8d6feed02cb8c132db2199eb8e',
});
const scrollHash = value => createHash('sha256').update(value).digest('hex');
const SCROLL_ID_KEYS = ['chromePid', 'windowId', 'tabId', 'cgWindow'];
const scrollInteger = value => Number.isSafeInteger(value) && value >= 0;
const scrollNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const scrollKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const scrollIdentity = value => !!value && SCROLL_ID_KEYS.every(k => Number.isSafeInteger(value[k]) && value[k] > 0);

export function scrollIdentityMatches(a, b) {
  return scrollIdentity(a) && scrollIdentity(b) && SCROLL_ID_KEYS.every(k => a[k] === b[k]);
}

export function createScrollActionGate(mode) {
  let attempted = false;
  return { accept(args, identity) {
    if (mode !== 'scroll-document') throw error('scroll_mode_refused');
    if (!scrollKeys(args, ['tab', 'direction', 'amount']) || args.direction !== 'down' || args.amount !== 1
      || !Number.isSafeInteger(args.tab) || args.tab <= 0) throw error('scroll_arguments_refused');
    if (identity?.exact !== true || !scrollIdentity(identity) || args.tab !== identity.tabId) throw error('scroll_identity_refused');
    if (attempted) throw error('scroll_already_attempted');
    attempted = true;
  } };
}

export function scrollSampleValid(sample, previous = null) {
  if (!sample || !scrollIdentity(sample.identity)) return false;
  const counts = ['clicks', 'input', 'keydown', 'keyup', 'untrusted', 'heldKeys', 'wheel', 'trustedWheel', 'untrustedWheel', 'scrollEvents'];
  if (!counts.every(k => scrollInteger(sample[k])) || !['scrollY', 'maxScrollY', 'innerHeight', 'sampledAt'].every(k => scrollNumber(sample[k]))
    || sample.innerHeight <= 0 || sample.scrollY > sample.maxScrollY || sample.wheel !== sample.trustedWheel + sample.untrustedWheel) return false;
  for (const [count, first, last] of [['wheel', 'firstWheelAt', 'lastWheelAt'], ['scrollEvents', 'firstScrollAt', 'lastScrollAt']]) {
    if (sample[count] === 0) { if (sample[first] !== null || sample[last] !== null) return false; }
    else if (!scrollNumber(sample[first]) || !scrollNumber(sample[last]) || sample[first] > sample[last] || sample[last] > sample.sampledAt) return false;
  }
  if (previous) {
    if (!scrollSampleValid(previous) || !scrollIdentityMatches(previous.identity, sample.identity)
      || sample.sampledAt < previous.sampledAt || counts.some(k => sample[k] < previous[k])) return false;
    for (const [count, first, last] of [['wheel', 'firstWheelAt', 'lastWheelAt'], ['scrollEvents', 'firstScrollAt', 'lastScrollAt']]) {
      if (previous[count] > 0 && (sample[first] !== previous[first] || sample[last] < previous[last])) return false;
    }
  }
  return true;
}

export function scrollDocumentEvidence(before, after) {
  const identityObserved = scrollIdentityMatches(before?.identity, after?.identity);
  const documentScrollObserved = scrollSampleValid(before) && scrollSampleValid(after, before)
    && before.maxScrollY - before.scrollY >= before.innerHeight
    && after.scrollY > before.scrollY && after.maxScrollY === before.maxScrollY && after.innerHeight === before.innerHeight
    && after.trustedWheel > before.trustedWheel && after.untrustedWheel === 0 && after.scrollEvents > before.scrollEvents
    && before.clicks === 1 && after.clicks === 1 && after.untrusted === 0 && after.heldKeys === 0
    && ['input', 'keydown', 'keyup'].every(k => after[k] === before[k]);
  return { documentScrollObserved, identityObserved };
}

/** A separate variant leaves every byte of the legacy fixture unchanged. */
export function scrollFixtureHTML(token) {
  return fixtureHTML(token).replace('</style>', 'body{min-height:500vh}</style>').replace('</script>', `
Object.assign(state,{heldKeys:0,wheel:0,trustedWheel:0,untrustedWheel:0,scrollEvents:0,firstWheelAt:null,lastWheelAt:null,firstScrollAt:null,lastScrollAt:null});publish();
document.addEventListener('wheel',e=>{const t=performance.now();state.wheel++;if(e.isTrusted)state.trustedWheel++;else state.untrustedWheel++;state.firstWheelAt??=t;state.lastWheelAt=t;publish();},{passive:true});
document.addEventListener('scroll',()=>{const t=performance.now();state.scrollEvents++;state.firstScrollAt??=t;state.lastScrollAt=t;publish();},{passive:true});
</script>`);
}

export function scrollSamplerScript({ url, token, markerId = null }) {
  assert.equal(arguments.length, 1);
  assert.ok(scrollKeys(arguments[0], ['url', 'token']) || scrollKeys(arguments[0], ['url', 'token', 'markerId']));
  assert.equal(typeof url, 'string');
  if (Object.hasOwn(arguments[0], 'markerId')) assert.ok(arguments[0].markerId === null || arguments[0].markerId === 'tick');
  assert.match(token, /^[a-zA-Z0-9-]+$/);
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'http:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, `/fixture-${token}`); assert.equal(parsed.search + parsed.hash + parsed.username + parsed.password, '');
  assert.ok(markerId === null || markerId === 'tick');
  return `JSON.stringify((()=>{
    if(location.href!==${JSON.stringify(url)}||document.querySelector('meta[name="fixture-token"]')?.content!==${JSON.stringify(token)})return {ok:false};
    const el=document.scrollingElement,registry=window.__chromeBridge;
    if(!el)return {ok:false};
    return {ok:true,state:{...JSON.parse(document.querySelector('meta[name="fixture-state"]').content),
      scrollY:el.scrollTop,maxScrollY:Math.max(0,el.scrollHeight-innerHeight),innerHeight,sampledAt:performance.now()},
      marker:registry?.url===location.href?registry.markers.indexOf(document.getElementById(${JSON.stringify(markerId)})):-1};
  })())`;
}

/** Only the frozen block/locate forms are reconstructed. No template name,
 * digest of a delegate's own output, or page-world patch proves its bytes.
 * Frozen JS exits: bridge evalInPage -> chromectl's lean/full eval branches;
 * observePagePrompts -> its own cold child (not byte-observed here). The
 * latter is tracked from worker initialization, including uncertain children
 * outliving a settled Promise. Native typed intents cannot carry raw JS. */
export function createScrollAudit({ sources, now = () => performance.now(), limit = 512 }) {
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 512);
  const events = [], samplers = [], gaps = new Set(), generated = new Set(), sessions = new WeakSet();
  let identity = null, started = false, active = false, ended = false, startMs = null, endMs = null, sequence = 0, nativeSequence = 0, observationOrder = 0;
  let observerCompletionUnknown = false, recordingFailed = false, overflow = false, lastClock = -1;
  const action = { startMs: null, endMs: null, startOrder: null, endOrder: null };
  const observerAttempts = new Map(), observerInvocations = [];
  let observerFactsEnabled = false, currentObserverInvocation = null, factCount = 0, lastAttempt = 0, lastChild = 0;
  let windowStartOrder = null, windowEndOrder = null;
  const pending = { template: 0, eval: 0, content: 0, observer: 0, native: 0 };
  const failRecord = () => { recordingFailed = true; observerCompletionUnknown = true; gaps.add('recording_failed'); };
  const safe = fn => { try { return fn(); } catch { failRecord(); return null; } };
  const clock = () => { const n = now(); if (!scrollNumber(n) || n < lastClock) throw error('audit_clock_invalid'); lastClock = n; return n; };
  const sourceSha256 = safe(() => Object.fromEntries(Object.keys(SCROLL_SOURCE_PINS).map(file => [file, typeof sources?.[file] === 'string' ? scrollHash(sources[file]) : null])));
  const pinned = !!sourceSha256 && Object.values(sourceSha256).every(h => h !== null);
  if (!pinned) gaps.add('source_missing');
  const vars = { 'locate-scroll': { MARKER: null, MODE: 'scroll', SCROLL: false, DIR: 'down' },
    'locate-measure': { MARKER: null, MODE: 'measure', SCROLL: false, DIR: null } };
  const expected = safe(() => Object.fromEntries(['block', 'locate-scroll', 'locate-measure'].map(id => {
    let text = sources?.[id === 'block' ? 'src/page/block.js' : 'src/page/locate.js'];
    if (typeof text !== 'string') return [id, null];
    for (const [key, value] of Object.entries(vars[id] || {})) text = text.replaceAll(`__${key}__`, () => JSON.stringify(value));
    return [id, /__[A-Z][A-Z0-9_]*__/.test(text) ? null : text];
  }))) || {};
  // These transient producer inputs are reduced synchronously. No script,
  // namespace, temporary path, raw output or argv survives this callback.
  const observerFactKeys = {
    begin: ['phase', 'attempt'], validated: ['phase', 'attempt', 'target'],
    rejected: ['phase', 'attempt', 'reason', 'holdingAttempt'],
    spawn: ['phase', 'attempt', 'child', 'kind', 'argv', 'argvValid'],
    spawn_failed: ['phase', 'attempt', 'child', 'kind'],
    stop: ['phase', 'attempt', 'child', 'why', 'via', 'toolStart'],
    grace_expired: ['phase', 'attempt', 'child'],
    close: ['phase', 'attempt', 'child', 'kind', 'code', 'reason', 'cancelled'],
    parsed: ['phase', 'attempt', 'child', 'kind'],
    native_result: ['phase', 'attempt', 'result'], render: ['phase', 'attempt', 'script', 'namespace'],
    write: ['phase', 'attempt', 'path'], dom_result: ['phase', 'attempt', 'result'], released: ['phase', 'attempt'],
  };
  const observerInvalid = () => { gaps.add('observer_fact_invalid'); };
  const observerOverflow = () => { overflow = true; gaps.add('overflow'); };
  const observerFact = fact => safe(() => {
    if (!observerFactsEnabled) { observerInvalid(); return; }
    if (factCount >= 512) { observerOverflow(); return; }
    factCount++;
    const phase = fact?.phase, keys = Object.hasOwn(observerFactKeys, phase) ? observerFactKeys[phase] : null;
    if (!keys || !scrollKeys(fact, keys) || !Number.isSafeInteger(fact.attempt) || fact.attempt <= 0) { observerInvalid(); return; }
    let attempt = observerAttempts.get(fact.attempt);
    if (phase === 'begin') {
      if (observerAttempts.size >= 64) { observerOverflow(); return; }
      if (attempt || fact.attempt <= lastAttempt) { observerInvalid(); return; }
      lastAttempt = fact.attempt;
      const invocation = currentObserverInvocation;
      attempt = { id: fact.attempt, invocation: invocation?.id ?? null, target: null, facts: [], pathHash: null };
      observerAttempts.set(fact.attempt, attempt);
      if (!invocation || invocation.attempt !== null) gaps.add('observer_unattributed');
      else invocation.attempt = fact.attempt;
    }
    if (!attempt) { gaps.add('observer_unattributed'); return; }
    if (attempt.facts.length >= 16) { observerOverflow(); return; }
    const row = { phase, atMs: clock(), order: ++observationOrder };
    let valid = true;
    if (Object.hasOwn(fact, 'child')) {
      valid &&= Number.isSafeInteger(fact.child) && fact.child > 0 || (phase === 'stop' && fact.child === null);
      row.child = Number.isSafeInteger(fact.child) && fact.child > 0 ? fact.child : null;
    }
    if (Object.hasOwn(fact, 'kind')) { valid &&= ['native', 'dom'].includes(fact.kind); row.kind = ['native', 'dom'].includes(fact.kind) ? fact.kind : 'unknown'; }
    if (phase === 'validated') {
      valid &&= scrollKeys(fact.target, SCROLL_ID_KEYS) && scrollIdentity(fact.target) && fact.target.chromePid <= 2147483647;
      if (valid) attempt.target = Object.fromEntries(SCROLL_ID_KEYS.map(k => [k, fact.target[k]]));
    } else if (phase === 'rejected') {
      valid &&= ['child_not_settled', 'target_unverified', 'preempted'].includes(fact.reason)
        && (fact.reason === 'child_not_settled' ? Number.isSafeInteger(fact.holdingAttempt) && fact.holdingAttempt > 0 : fact.holdingAttempt === null);
      row.reason = valid ? fact.reason : 'unknown'; row.holdingAttempt = valid ? fact.holdingAttempt : null;
    } else if (phase === 'spawn' || phase === 'spawn_failed') {
      valid &&= fact.child > lastChild; if (valid) lastChild = fact.child;
      if (phase === 'spawn') {
        const argv = fact.argv, target = attempt.target;
        let mapped = fact.argvValid === true && Array.isArray(argv) && argv.length === (fact.kind === 'native' ? 5 : 6)
          && argv.every(x => typeof x === 'string' && x.length <= 1024) && !!target;
        if (mapped && fact.kind === 'native') {
          mapped = argv.length === 5 && argv[0] === 'dialog' && argv[1] === '--pid' && argv[2] === String(target.chromePid) && argv[3] === '--target';
          if (mapped) {
            let supplied; try { supplied = JSON.parse(argv[4]); } catch { mapped = false; }
            mapped &&= scrollKeys(supplied, SCROLL_ID_KEYS) && scrollIdentityMatches(target, supplied);
          }
        } else if (mapped && fact.kind === 'dom') {
          mapped = argv.length === 6 && argv[0] === 'eval' && argv[2] === '--pid' && argv[3] === String(target.chromePid)
            && argv[4] === '--tab' && argv[5] === String(target.tabId) && !!attempt.pathHash && scrollHash(argv[1]) === attempt.pathHash;
          attempt.pathHash = null;
        } else mapped = false;
        valid &&= typeof fact.argvValid === 'boolean'; row.mapped = mapped;
        row.argvHash = mapped ? scrollHash(JSON.stringify(argv)) : null;
        if (!mapped) gaps.add('observer_route_unmapped');
      }
    } else if (phase === 'stop') {
      valid &&= ['preempted', 'observer_timeout', 'observer_output_limit', 'observer_spawn_failed', 'disposed'].includes(fact.why)
        && ['abort', 'cold', 'dispose'].includes(fact.via) && typeof fact.toolStart === 'boolean';
      row.why = valid ? fact.why : 'unknown'; row.via = valid ? fact.via : 'unknown'; row.toolStart = fact.toolStart === true;
    } else if (phase === 'close') {
      valid &&= (fact.code === null || Number.isSafeInteger(fact.code)) && [null, 'preempted', 'observer_timeout', 'observer_output_limit', 'observer_spawn_failed'].includes(fact.reason)
        && typeof fact.cancelled === 'boolean';
      row.code = Number.isSafeInteger(fact.code) ? fact.code : null;
      row.reason = valid ? fact.reason : 'unknown'; row.cancelled = fact.cancelled === true;
    } else if (phase === 'native_result' || phase === 'dom_result') {
      const allowed = phase === 'native_result' ? ['open', 'closed', 'unknown', 'identity_mismatch'] : ['observed', 'target_changed', 'unknown'];
      valid &&= allowed.includes(fact.result); row.result = valid ? fact.result : 'unknown';
    } else if (phase === 'render') {
      const namespace = fact.namespace, script = fact.script;
      const inputOK = typeof namespace === 'string' && namespace.length > 0 && namespace.length <= 128 && typeof script === 'string' && script.length <= 65536;
      const source = sources?.['src/page/prompt-observation.js'];
      const reconstructed = inputOK && typeof source === 'string'
        ? source.replaceAll('__PROMPT_OBSERVATION__', () => JSON.stringify({ mode: 'observe', namespace })) : null;
      row.mapped = pinned && inputOK && reconstructed === script && !/__[A-Z][A-Z0-9_]*__/.test(reconstructed);
      row.hash = inputOK ? scrollHash(script) : null; row.length = inputOK ? Buffer.byteLength(script) : null;
      if (!row.mapped) gaps.add('observer_template_unmapped');
    } else if (phase === 'write') {
      row.mapped = typeof fact.path === 'string' && fact.path.length > 0 && fact.path.length <= 1024;
      attempt.pathHash = row.mapped ? scrollHash(fact.path) : null;
      if (!row.mapped) gaps.add('observer_write_unmapped');
    } else if (phase === 'released') attempt.pathHash = null;
    row.valid = valid; if (!valid) observerInvalid();
    attempt.facts.push(row);
  });
  const observerGraph = rows => {
    if (!observerFactsEnabled) return null;
    const firstWork = rows.find(row => ['eval', 'content', 'native'].includes(row.kind) && row.startOrder > action.startOrder && row.startOrder < action.endOrder)?.startOrder;
    const actionValid = Number.isSafeInteger(action.startOrder) && Number.isSafeInteger(action.endOrder)
      && windowStartOrder < action.startOrder && action.startOrder < action.endOrder && action.endOrder < windowEndOrder;
    const summaries = [...observerAttempts.values()].map(attempt => {
      const facts = attempt.facts, phases = facts.map(f => f.phase), invocation = observerInvocations.find(i => i.id === attempt.invocation);
      const one = phase => facts.find(f => f.phase === phase), spawn = facts.filter(f => f.phase === 'spawn'), close = facts.filter(f => f.phase === 'close');
      const release = one('released'), nativeResult = one('native_result'), reject = one('rejected');
      const grammar = expected => phases.length === expected.length && phases.every((phase, index) => phase === expected[index]);
      const childClosed = item => {
        const closed = close.find(f => f.child === item.child), parsed = facts.find(f => f.phase === 'parsed' && f.child === item.child);
        return item.mapped && closed?.kind === item.kind && closed.code === 0 && closed.reason === null && !closed.cancelled
          && parsed?.kind === item.kind && item.order < closed.order && closed.order < parsed.order;
      };
      const joined = !!invocation && invocation.attempt === attempt.id && invocation.startOrder < facts[0]?.order
        && invocation.endOrder !== null && invocation.endOrder < windowEndOrder && facts.every(f => f.valid && f.order < windowEndOrder);
      const targetOK = scrollIdentityMatches(identity, attempt.target);
      const base = joined && targetOK && release && spawn[0]?.kind === 'native';
      const nativeNormal = grammar(['begin', 'validated', 'spawn', 'close', 'parsed', 'native_result', 'released']) && nativeResult?.result === 'open';
      const domNormal = grammar(['begin', 'validated', 'spawn', 'close', 'parsed', 'native_result', 'render', 'write', 'spawn', 'close', 'parsed', 'dom_result', 'released'])
        && nativeResult?.result === 'closed' && spawn[1]?.kind === 'dom' && one('render')?.mapped && one('write')?.mapped && one('dom_result')?.result === 'observed';
      let classification = 'incomplete';
      if (base && (nativeNormal || domNormal) && spawn.every(childClosed) && invocation.observed && invocation.endOrder > release.order) {
        if (invocation.endOrder < action.startOrder) classification = 'peripheral_before';
        else if (invocation.startOrder > action.endOrder) classification = 'peripheral_after';
      }
      const stops = facts.filter(f => f.phase === 'stop'), middle = phases.slice(3, -2);
      const cancelGrammar = phases[0] === 'begin' && phases[1] === 'validated' && phases[2] === 'spawn'
        && phases.at(-2) === 'close' && phases.at(-1) === 'released' && middle.length >= 1 && middle.length <= 3
        && middle.every(p => p === 'stop' || p === 'grace_expired') && facts.filter(f => f.phase === 'grace_expired').length <= 1;
      if (base && cancelGrammar && spawn.length === 1 && spawn[0].mapped && spawn[0].order < action.startOrder
        && facts.every(f => !Object.hasOwn(f, 'child') || f.child === spawn[0].child)
        && close.length === 1 && close[0].child === spawn[0].child && close[0].kind === 'native' && close[0].cancelled
        && [null, 'preempted'].includes(close[0].reason) && invocation.status === 'cancelled' && invocation.reason === 'preempted'
        && stops.length >= 1 && stops.every(f => f.child === spawn[0].child && f.why === 'preempted' && f.toolStart && ['abort', 'cold'].includes(f.via)
          && f.order > action.startOrder && f.order < close[0].order)
        && Number.isSafeInteger(firstWork) && close[0].order < release.order && release.order < firstWork && invocation.endOrder < firstWork)
        classification = 'native_cancelled_in_action';
      if (joined && grammar(['begin', 'rejected']) && reject?.reason === 'child_not_settled'
        && invocation.status === 'unavailable' && invocation.reason === 'child_not_settled') classification = 'busy_pending';
      return { attempt: attempt.id, invocation: attempt.invocation, targetMatches: targetOK, classification,
        contentObserved: invocation?.observed === true, status: invocation?.status ?? 'unknown',
        holdingAttempt: reject?.holdingAttempt ?? null, startMs: invocation?.startMs ?? null, endMs: invocation?.endMs ?? null,
        startOrder: invocation?.startOrder ?? null, endOrder: invocation?.endOrder ?? null, facts: facts.map(f => ({ ...f })) };
    });
    for (const item of summaries.filter(s => s.classification === 'busy_pending')) {
      const holding = summaries.find(s => s.attempt === item.holdingAttempt), release = holding?.facts.find(f => f.phase === 'released');
      item.classification = holding && ['peripheral_before', 'peripheral_after', 'native_cancelled_in_action'].includes(holding.classification)
        && holding.startOrder < item.startOrder && item.startOrder < release?.order ? 'busy_accounted' : 'incomplete';
    }
    const complete = actionValid && !overflow && !recordingFailed && ![...gaps].some(g => g.startsWith('observer_'))
      && observerInvocations.every(i => i.attempt !== null && i.endOrder !== null)
      && summaries.length === observerInvocations.length && summaries.every(s => s.classification !== 'incomplete');
    return { schema: 1, complete, factCount, attempts: summaries };
  };
  const add = (kind, fields = {}) => {
    if (!active) return null;
    if (events.length >= limit) { overflow = true; gaps.add('overflow'); return null; }
    const row = { kind, sequence: ++sequence, startMs: clock(), endMs: null, startOrder: ++observationOrder, endOrder: null, completion: 'pending', ...fields };
    events.push(row); return row;
  };
  const settled = (row, rejected) => {
    if (!row) return;
    row.endMs = clock(); row.endOrder = ++observationOrder; row.completion = rejected ? 'rejected' : 'returned';
    if (rejected) gaps.add('delegate_rejected');
  };
  // Sidecars preserve the exact original promise/value and original thrown
  // object. A recording failure never skips, repeats or replaces a delegate.
  const wrap = (kind, real, before, after) => function (...args) {
    pending[kind]++;
    let row, invocation = null;
    safe(() => {
      if (kind === 'observer' && observerFactsEnabled) {
        if (observerInvocations.length >= 64) observerOverflow();
        else {
          invocation = { id: observerInvocations.length + 1, attempt: null, startMs: clock(), startOrder: ++observationOrder,
            endMs: null, endOrder: null, observed: false, status: 'unknown', reason: null };
          observerInvocations.push(invocation);
        }
      }
      row = add(kind, before(args));
    });
    const finish = (value, rejected) => safe(() => {
      pending[kind]--; settled(row, rejected);
      if (invocation) { invocation.endMs = clock(); invocation.endOrder = ++observationOrder; }
      after(value, rejected, row, args, invocation);
    });
    let result; const previousInvocation = currentObserverInvocation;
    if (invocation) currentObserverInvocation = invocation;
    try { result = Reflect.apply(real, this, args); }
    catch (failure) { finish(failure, true); throw failure; }
    finally { currentObserverInvocation = previousInvocation; }
    safe(() => {
      if (result instanceof Promise) Promise.prototype.then.call(result, value => { finish(value, false); }, failure => { finish(failure, true); });
      else finish(result, false);
    });
    return result;
  };
  const templateId = args => {
    if (args.length === 1 && args[0] === 'block') return 'block';
    if (args.length !== 2 || args[0] !== 'locate') return 'unknown';
    return Object.keys(vars).find(id => scrollKeys(args[1], Object.keys(vars[id])) && Object.entries(vars[id]).every(([k, v]) => args[1][k] === v)) || 'unknown';
  };
  const nativeShape = (args, pid) => {
    const req = args[0], opts = args[1];
    let mapped = args.length >= 1 && args.length <= 2 && (opts === undefined || (scrollKeys(opts, ['raw']) && typeof opts.raw === 'boolean'))
      && Number.isSafeInteger(pid) && pid > 0;
    let op = 'unknown', fields = {};
    if (req && typeof req === 'object' && !Array.isArray(req)) {
      if (req.op === 'status') { op = 'status'; mapped &&= scrollKeys(req, ['op']); }
      else if (req.op === 'wheel') { op = 'wheel'; mapped &&= scrollKeys(req, ['op', 'notches', 'dir']) && Number.isSafeInteger(req.notches) && req.notches > 0 && req.dir === 'down';
        if (mapped) fields = { notches: req.notches, dir: 'down' }; }
      else if (req.op === 'move') { op = 'move'; mapped &&= scrollKeys(req, ['op', 'to', 'rect']) && scrollKeys(req.to, ['x', 'y']) && scrollKeys(req.rect, ['x', 'y', 'w', 'h'])
          && [...Object.values(req.to), ...Object.values(req.rect)].every(Number.isFinite) && req.rect.w > 0 && req.rect.h > 0;
        if (mapped) fields = { x: req.to.x, y: req.to.y }; }
      else if (req.op === 'bindNativeTarget') { op = 'bindNativeTarget'; mapped &&= scrollKeys(req, ['op', 'schema', 'epoch', 'target']) && req.schema === 1
          && scrollKeys(req.target, SCROLL_ID_KEYS) && scrollIdentityMatches(identity, req.target) && Number.isSafeInteger(req.epoch) && req.epoch > 0;
        if (mapped) fields = { schema: 1, target: Object.fromEntries(SCROLL_ID_KEYS.map(k => [k, req.target[k]])) }; }
      else if (req.op === 'nativeChrome') {
        op = 'nativeChrome'; const intent = req.intent;
        mapped &&= scrollKeys(req, ['op', 'schema', 'operationId', 'epoch', 'intent', 'policy']) && req.schema === 1 && req.policy === 'normal'
          && typeof req.operationId === 'string' && /^native-[1-9]\d*$/.test(req.operationId) && Number.isSafeInteger(req.epoch) && req.epoch > 0
          && ((intent?.kind === 'selectTab' && scrollKeys(intent, ['kind', 'tabId', 'windowId']) && intent.tabId === identity?.tabId)
            || (intent?.kind === 'activate' && (scrollKeys(intent, ['kind', 'tabId', 'windowId'])
              || (scrollKeys(intent, ['kind', 'tabId', 'windowId', 'fitCurrent']) && intent.fitCurrent === true)) && intent.tabId === identity?.tabId)
            || (intent?.kind === 'moveWindow' && scrollKeys(intent, ['kind', 'windowId', 'fitCurrent']) && intent.fitCurrent === true))
          && intent.windowId === identity?.windowId;
        if (mapped) fields = { schema: 1, intent: intent.kind, target: { tabId: identity.tabId, windowId: intent.windowId }, geometryRequired: intent.fitCurrent === true };
      } else if (req.op === 'veil') {
        op = 'veil';
        const text = value => typeof value === 'string' && value.length <= 4096;
        const label = value => text(value) || (scrollKeys(value, ['zh', 'en']) && text(value.zh) && text(value.en));
        const v = req.veil, panel = v?.panel;
        const rect = value => scrollKeys(value, ['x', 'y', 'w', 'h']) && Object.values(value).every(Number.isFinite)
          && value.w > 0 && value.h > 0;
        const panelOK = scrollKeys(panel, ['who', 'color', 'task', 'step', 'action', 'stages', 'chars', 'perChar', 'showCount',
          'elapsedMs', 'feedMode', 'feedEntries', 'feedStatus', 'feedReason', 'feedSource']) && label(panel.who)
          && scrollInteger(panel.color) && text(panel.task) && panel.step === '' && label(panel.action)
          && Array.isArray(panel.stages) && panel.stages.length === 0 && panel.chars === 0 && panel.perChar === false && panel.showCount === false
          && scrollNumber(panel.elapsedMs) && panel.feedMode === true && Array.isArray(panel.feedEntries) && panel.feedEntries.length <= 200
          && panel.feedEntries.every(text) && text(panel.feedStatus) && (panel.feedReason === null || text(panel.feedReason)) && (panel.feedSource === null || text(panel.feedSource));
        // Frozen held-scroll and gap labels; validate shape without retaining
        // the text, feed, task or agent identity from any panel object.
        mapped &&= scrollKeys(req, ['op']) || (scrollKeys(req, ['op', 'veil']) && label(v?.label)
          && (scrollKeys(v, ['label']) || (scrollKeys(v, ['label', 'rect', 'panel']) && rect(v.rect) && panelOK)));
      } else mapped = false;
    } else mapped = false;
    if (!mapped && active) gaps.add('native_unmapped');
    return { op, requestSequence: ++nativeSequence, helperPid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, mapped: !!mapped, ...fields };
  };
  return {
    enableObserverFacts() { observerFactsEnabled = true; },
    observerFact,
    bind(value) { safe(() => {
      if (!scrollIdentity(value) || (identity && !scrollIdentityMatches(identity, value))) { gaps.add('identity_unknown'); return; }
      identity ||= Object.fromEntries(SCROLL_ID_KEYS.map(k => [k, value[k]]));
    }); },
    begin() { safe(() => {
      if (started) { gaps.add('window_reopened'); return; }
      started = active = true; startMs = clock(); windowStartOrder = ++observationOrder;
      if (!observerFactsEnabled) {
        if (Object.values(pending).some(n => n !== 0)) gaps.add('prior_inflight');
        if (observerCompletionUnknown) gaps.add('observer_completion_unknown');
      } else if (Object.entries(pending).some(([kind, count]) => kind !== 'observer' && count !== 0)) gaps.add('prior_inflight');
    }); },
    end() { safe(() => {
      if (!active || ended) { gaps.add('window_not_closed'); return; }
      endMs = clock(); windowEndOrder = ++observationOrder; active = false; ended = true;
      if (Object.values(pending).some(n => n !== 0)) gaps.add('inflight_at_end');
    }); },
    actionStart() { safe(() => {
      if (!active || action.startOrder !== null) { gaps.add('action_boundary_invalid'); return; }
      action.startMs = clock(); action.startOrder = ++observationOrder;
    }); },
    actionEnd() { safe(() => {
      if (!active || action.startOrder === null || action.endOrder !== null) { gaps.add('action_boundary_invalid'); return; }
      action.endMs = clock(); action.endOrder = ++observationOrder;
    }); },
    sampler(fields) { return safe(() => {
      const script = scrollSamplerScript(fields);
      if (samplers.length >= 4) { overflow = true; gaps.add('overflow'); return null; }
      const row = { hash: scrollHash(script), length: Buffer.byteLength(script), generatorHash: scrollHash(scrollSamplerScript.toString()), marker: fields.markerId === 'tick' ? 'tick' : 'none' };
      samplers.push(row); return row;
    }); },
    wrapPageScript(real) { return wrap('template', real, args => ({ template: templateId(args) }), (value, rejected, row, args) => {
      if (!row) return;
      const id = templateId(args), mapped = !rejected && pinned && id !== 'unknown' && typeof value === 'string' && value === expected[id];
      Object.assign(row, { mapped, hash: typeof value === 'string' ? scrollHash(value) : null, length: typeof value === 'string' ? Buffer.byteLength(value) : null });
      if (mapped) generated.add(id); else gaps.add('template_unmapped');
    }); },
    wrapEvalInPage(real) { return wrap('eval', real, args => {
      const id = Object.keys(expected).find(k => typeof args[0] === 'string' && args[0] === expected[k]) || 'unknown';
      const exact = id === 'locate-scroll' && args.length === 3 && scrollKeys(args[2], ['exactTarget'])
        && scrollKeys(args[2].exactTarget, SCROLL_ID_KEYS) && scrollIdentityMatches(identity, args[2].exactTarget);
      const optionsOK = id === 'block' ? args.length === 3 && scrollKeys(args[2], ['lean']) && args[2].lean === true : args.length === 2 || exact;
      const mapped = pinned && id !== 'unknown' && generated.has(id) && args[1] === identity?.tabId && optionsOK;
      if (active && !mapped) gaps.add('eval_unmapped');
      return { template: id, mapped, exactTarget: exact, hash: typeof args[0] === 'string' ? scrollHash(args[0]) : null, length: typeof args[0] === 'string' ? Buffer.byteLength(args[0]) : null };
    }, (value, rejected, row) => {
      if (!row || rejected) return;
      if (row.template === 'block') {
        row.result = value?.ok === true ? 'observed' : 'unknown';
        if (row.result !== 'observed') gaps.add('eval_result_unknown');
        return;
      }
      if (!value || value.ok !== true || !scrollNumber(value.scrollTop) || !scrollNumber(value.max) || value.scrollTop > value.max) { gaps.add('eval_result_unknown'); return; }
      row.scrollTop = value.scrollTop; row.max = value.max;
      if (row.exactTarget) {
        const target = value.target || value, b = value.bounds, v = value.view;
        const valid = target?.tabId === identity?.tabId && target?.windowId === identity?.windowId
          && (target.chromePid == null || target.chromePid === identity.chromePid) && (target.cgWindow == null || target.cgWindow === identity.cgWindow)
          && b && ['left','top','width','height'].every(k => Number.isFinite(b[k])) && b.width > 0 && b.height > 0
          && v && ['innerWidth','innerHeight','outerWidth','outerHeight'].every(k => Number.isFinite(v[k]) && v[k] > 0);
        const scale = valid ? b.width / v.outerWidth : NaN;
        if (!valid || scale < 0.25 || scale > 4 || !Number.isFinite(scale)) gaps.add('geometry_eval_unknown');
        else row.geometry = { bounds: { x:b.left,y:b.top,w:b.width,h:b.height }, viewport: {
          x:b.left+Math.max(0,(v.outerWidth-v.innerWidth)/2)*scale,
          y:b.top+Math.max(0,v.outerHeight-v.innerHeight-Math.max(0,(v.outerWidth-v.innerWidth)/2))*scale,w:v.innerWidth*scale,h:v.innerHeight*scale } };
      }
      if (row.template === 'locate-scroll') { row.scroller = value.scroller === 'document' ? 'document' : 'unknown'; if (row.scroller !== 'document') gaps.add('non_document_scroller'); }
    }); },
    wrapPageContentRect(real) { return wrap('content', real, args => {
      const mapped = args.length === 1 && scrollKeys(args[0], ['chromePid','cgWindow'])
        && args[0].chromePid === identity?.chromePid && args[0].cgWindow === identity?.cgWindow;
      if (active && (!mapped || pending.eval || pending.content > 1 || pending.native || pending.observer)) gaps.add('content_unmapped_or_overlap');
      return { mapped };
    }, (value, rejected, row) => {
      if (!row || rejected) return;
      const r=value?.rect,b=value?.windowBounds;
      const valid = value?.ok === true && value.source === 'ax-web-area' && value.pid === identity?.chromePid && value.cgWindow === identity?.cgWindow
        && r && b && ['x','y','w','h'].every(k => Number.isFinite(r[k]) && Number.isFinite(b[k]))
        && r.w > 0 && r.h > 0 && b.w > 0 && b.h > 0 && r.x >= b.x && r.y >= b.y && r.x+r.w <= b.x+b.w && r.y+r.h <= b.y+b.h;
      if (!valid) gaps.add('content_result_unknown');
      else row.geometry = { bounds: Object.fromEntries(['x','y','w','h'].map(k=>[k,b[k]])), viewport: Object.fromEntries(['x','y','w','h'].map(k=>[k,r[k]])) };
    }); },
    wrapObserver(real) { return wrap('observer', real, () => {
      if (!observerFactsEnabled) { if (active) gaps.add('observer_overlap'); } return {};
    }, (value, rejected, row, _args, invocation) => {
      const observed = !rejected && value && typeof value === 'object' && !Array.isArray(value) && value.status === 'observed'
        && typeof value.complete === 'boolean' && scrollNumber(value.observedAt) && Array.isArray(value.observations)
        && value.observations.length <= 8 && value.observations.every(item => item && typeof item === 'object' && !Array.isArray(item)
          && item.schema === 1 && ['native', 'dom'].includes(item.kind) && scrollNumber(item.observedAt) && typeof item.complete === 'boolean');
      if (!observed) observerCompletionUnknown = true;
      if (invocation) {
        invocation.observed = observed;
        invocation.status = ['observed', 'cancelled', 'unavailable'].includes(value?.status) ? value.status : 'unknown';
        invocation.reason = ['preempted', 'child_not_settled'].includes(value?.reason) ? value.reason : null;
      }
      if (row) row.result = observed ? 'observed' : 'unknown';
    }); },
    wrapOpenInputSession(real) { return function (...args) {
      const session = Reflect.apply(real, this, args);
      safe(() => {
        if (!session || typeof session !== 'object' || typeof session.request !== 'function') { gaps.add('session_unknown'); return; }
        if (sessions.has(session)) return;
        sessions.add(session); const pid = session.pid;
        session.request = wrap('native', session.request, requestArgs => nativeShape(requestArgs, pid), (value, rejected, row) => {
          if (!row || rejected) return;
          if (!value || typeof value !== 'object' || value.ok !== true) { gaps.add('native_result_unknown'); return; }
          row.ok = true;
          if (scrollInteger(value.sent)) row.sent = value.sent;
          if (['sent', 'not_sent', 'unknown'].includes(value.inputDelivery)) row.inputDelivery = value.inputDelivery;
          if (row.op === 'wheel' && !scrollInteger(value.sent)) gaps.add('wheel_receipt_unknown');
          if (row.op === 'nativeChrome') {
            if (!['sent', 'not_sent'].includes(value.inputDelivery)) gaps.add('native_delivery_unknown');
            const result = value;
            if (row.geometryRequired) {
              const g=value.geometry,b=value.bounds;
              const boundsOK = r => r && ['left','top','width','height'].every(k=>Number.isFinite(r[k])) && r.width > 0 && r.height > 0;
              if (!scrollIdentityMatches(identity,value) || !boundsOK(b) || !boundsOK(g?.beforeBounds) || g.mode !== 'fit-current'
                || !Number.isSafeInteger(g.displayId) || g.displayId <= 0 || g.displayId > 0xffffffff || !['usable','full-frame'].includes(g.branch)
                || typeof g.changed !== 'boolean' || typeof g.possiblyChanged !== 'boolean') gaps.add('native_geometry_unknown');
              else {
                row.identityMatches = true; row.geometryChanged = g.changed || g.possiblyChanged;
                row.finalBounds = { x:b.left,y:b.top,w:b.width,h:b.height };
              }
            }
            if (row.intent === 'activate') {
              row.targetOnTop = typeof result?.targetOnTop === 'boolean' ? result.targetOnTop : null;
              row.keyWindowIsTarget = typeof result?.keyWindowIsTarget === 'boolean' ? result.keyWindowIsTarget : null;
              row.identityMatches = scrollIdentityMatches(identity, result);
              if (!row.identityMatches || row.targetOnTop !== true || row.keyWindowIsTarget !== true) gaps.add('activation_unknown');
            }
          }
        });
      });
      return session;
    }; },
    snapshot() {
      const rows = events.map(row => ({ ...row, ...(row.target ? { target: { ...row.target } } : {}) }));
      const evals = rows.filter(row => row.kind === 'eval'), native = rows.filter(row => row.kind === 'native');
      const wheels = native.filter(row => row.op === 'wheel');
      const positions = evals.filter(row => ['locate-scroll', 'locate-measure'].includes(row.template));
      const positionsOK = positions.every((row, index) => scrollNumber(row.scrollTop) && scrollNumber(row.max)
        && (!index || (row.scrollTop >= positions[index - 1].scrollTop && row.max === positions[index - 1].max)));
      const exacts = evals.filter(row => row.exactTarget), contents = rows.filter(row => row.kind === 'content');
      const equivalent = (a,b) => a && b && ['x','y','w','h'].every(k=>Math.abs(a[k]-b[k]) <= 2);
      // Monotonic milliseconds can tie; only observed completion order proves
      // a prerequisite returned before the next operation began.
      const completedBefore = (a,b) => a.completion === 'returned' && Number.isSafeInteger(a.endOrder) && a.endOrder < b.startOrder;
      const pairs = contents.map(content => {
        const a = exacts.filter(row=>row.sequence < content.sequence).at(-1), b = exacts.find(row=>row.sequence > content.sequence);
        const prior = native.filter(row=>row.geometryRequired && row.sequence < (a?.sequence ?? 0)).at(-1);
        return { a,b,content, valid: !!a && !!b && content.mapped && [a,b,content].every(row=>row.completion === 'returned' && row.geometry)
          && completedBefore(a,content) && completedBefore(content,b)
          && !rows.some(row=>row.sequence > a.sequence && row.sequence < b.sequence && !['template','content'].includes(row.kind))
          && equivalent(a.geometry?.bounds,content.geometry?.bounds) && equivalent(b.geometry?.bounds,content.geometry?.bounds)
          && equivalent(a.geometry?.viewport,content.geometry?.viewport) && equivalent(b.geometry?.viewport,content.geometry?.viewport)
          && !!prior && prior.completion === 'returned' && completedBefore(prior,a)
          && equivalent(prior.finalBounds,content.geometry?.bounds) };
      });
      const used = pairs.flatMap(pair=>[pair.a?.sequence,pair.b?.sequence]);
      if (pairs.some(pair=>!pair.valid) || exacts.some(row=>used.filter(n=>n===row.sequence).length !== 1)
        || native.some(row=> {
          const input = native.find(next=>next.sequence > row.sequence && ['move','wheel'].includes(next.op));
          if (row.geometryRequired && input && !completedBefore(row,input)) return true;
          if (!row.geometryChanged) return false;
          // A later proof cannot validate input that already used old geometry.
          return !pairs.some(pair=>pair.valid && pair.a.sequence > row.sequence && completedBefore(row,pair.a)
            && (!input || (pair.b.sequence < input.sequence && completedBefore(pair.b,input))));
        })) gaps.add('geometry_corroboration_incomplete');
      const graph = observerGraph(rows);
      const observerExecutionKnown = graph?.complete === true;
      const complete = started && ended && !active && startMs !== null && endMs !== null && !overflow && !recordingFailed;
      const nativeOK = complete && native.length > 0 && wheels.length > 0 && wheels.length <= 40 && native.every(row => row.mapped && row.completion === 'returned' && row.ok)
        && ![...gaps].some(g => /native|wheel_receipt|session|activation|inflight/.test(g));
      const trace = ['block', 'locate-scroll', 'locate-measure'].map(id => evals.find(row => row.template === id)?.sequence);
      const scriptOK = complete && pinned && !!identity && nativeOK && positionsOK && (!observerCompletionUnknown || observerExecutionKnown) && (!graph || graph.complete) && gaps.size === 0
        && evals.every(row => row.mapped && row.completion === 'returned') && trace.every(Number.isSafeInteger)
        && trace[0] < trace[1] && trace[1] < trace[2]
        && ['block', 'locate-scroll', 'locate-measure'].every(id => generated.has(id))
        && rows.every(row => row.completion === 'returned');
      return { schema: 1, clock: 'worker-monotonic-ms', sourceSha256, scriptAuditComplete: scriptOK, boundedNativeRequestsObserved: nativeOK,
        identityObserved: !!identity && !gaps.has('identity_unknown') && native.some(row => row.identityMatches && ((row.intent === 'activate' && row.targetOnTop && row.keyWindowIsTarget) || (row.intent === 'moveWindow' && row.finalBounds))),
        observerCompletionUnknown, observerGraph: graph, overflow, recordingFailed, wheelBursts: wheels.length,
        wheelNotches: wheels.every(row => scrollInteger(row.notches)) ? wheels.reduce((n, row) => n + row.notches, 0) : null,
        window: { startMs, endMs, startOrder: windowStartOrder, endOrder: windowEndOrder }, action: { ...action }, events: rows, samplers: samplers.map(row => ({ ...row })),
        wheelToMeasureMs: wheels.map(wheel => {
          const next = evals.find(row => row.template === 'locate-measure' && row.startMs >= wheel.endMs);
          return wheel.endMs !== null && next ? next.startMs - wheel.endMs : null;
        }),
        gaps: [...gaps, ...(graph && !graph.complete ? ['observer_execution_incomplete'] : []), ...(!complete ? ['window_incomplete'] : []), ...(observerCompletionUnknown && !observerExecutionKnown ? ['observer_completion_unknown'] : []),
          ...(!positionsOK ? ['measure_nonmonotonic'] : []),
          ...(wheels.length === 0 || wheels.length > 40 ? ['wheel_count_unobserved'] : []),
          ...(!trace.every(Number.isSafeInteger) ? ['required_eval_missing'] : [])] };
    },
  };
}

/** The only new bridge seam. Original this/args are forwarded by each named
 * wrapper; no native command or JavaScript is supplied by the observer. */
export function installScrollAudit(api, B, audit) {
  if (typeof B.__setPagePromptObserverAuditForTests === 'function') {
    audit.enableObserverFacts(); B.__setPagePromptObserverAuditForTests(audit.observerFact);
  }
  api.__setBridgeForTests({ pageScript: audit.wrapPageScript(B.pageScript), evalInPage: audit.wrapEvalInPage(B.evalInPage),
    pageContentRect: audit.wrapPageContentRect(B.pageContentRect), observePagePrompts: audit.wrapObserver(B.observePagePrompts),
    openInputSession: audit.wrapOpenInputSession(B.openInputSession) });
}

export function parseOptions(argv) {
  const out = { run: false, check: false, operator: false, source: ROOT, case: 'input', seconds: 45 };
  let explicitCase = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.run = true;
    else if (a === '--check') out.check = true;
    else if (a === '--root-operator') out.operator = true;
    else if (a === '--native-bounds-evidence') out.nativeBoundsEvidence = true;
    else if (['--source', '--runtime', '--case', '--seconds'].includes(a)) {
      const v = argv[++i]; if (!v || v.startsWith('--')) throw error('missing_option_value');
      if (a === '--source' || a === '--runtime') {
        if (out.sourceKind) throw error('choose_one_source');
        out.sourceKind = a.slice(2); out.source = path.resolve(v);
      } else if (a === '--case') { out.case = v; explicitCase = true; }
      else out.seconds = Number(v);
    } else throw error('unknown_option');
  }
  if (out.run && (out.check || !out.operator)) throw error('root_operator_required');
  if (!CASES.includes(out.case) || !Number.isFinite(out.seconds) || out.seconds < 10 || out.seconds > 120) throw error('bad_case_or_timeout');
  if (out.nativeBoundsEvidence && (!out.run || !out.operator || out.check || out.sourceKind !== 'source' || !explicitCase || out.case !== 'input'))
    throw error('native_bounds_evidence_requires_explicit_input_source_run');
  return out;
}

/** The sole driver fault exception: delegate once, lose only the response.
 * Product code never receives the identity retained by this instrumentation.
 * No page is claimed/closed and no original creation is retried on any error.
 */
export function installPartialCreateFault(api, B, retained, verify = async () => null) {
  const realCreate = B.newWindow;
  api.__setBridgeForTests({ newWindow: async (...args) => {
    retained.attempts++;
    if (retained.attempts !== 1) throw error('fault_duplicate_creation_refused', 'new_window_response');
    const created = await realCreate(...args);
    retained.created = { tabId: created.tabId, windowId: created.windowId, chromePid: created.chromePid, cgWindow: created.cgWindow };
    retained.createdAt = Date.now();
    try { retained.proof = await verify(created); }
    catch (failure) { throw Object.assign(failure, { creationAttempted: true, partial: true, inputDelivery: 'unknown', noRetry: true }); }
    retained.responseLost = true;
    throw Object.assign(error('fixture_response_lost', 'new_window_response'),
      { creationAttempted: true, partial: true, inputDelivery: 'unknown', noRetry: true });
  } });
}

/** Exact opt-in test seam: delegate once and keep the original Session. */
export function installNativeBoundsEvidence(api, B, collector) {
  const realOpen = B.openInputSession;
  api.__setBridgeForTests({ openInputSession: (...args) => collector.wrapSession(realOpen(...args)) });
}

/** Deliberately narrow source allowlist, not a JavaScript sandbox. The exact
 * fault wrapper above is independently fault-tested; all ordinary writes must
 * enter callTool. Old round7 OCR is a positive forbidden-mutation fixture.
 */
export function staticSafetyCheck(source) {
  const ordinary = source.replace(installPartialCreateFault.toString(), '').replace(installNativeBoundsEvidence.toString(), '').replace(installScrollAudit.toString(), '');
  const allowed = new Set(['chromeInfo', 'snapshotScene', 'evalInPage', 'pageDialog', 'cgevent']);
  const violations = [];
  for (const m of ordinary.matchAll(/\bB\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    if (!allowed.has(m[1])) violations.push(`direct_bridge:${m[1]}`);
  }
  if (/\bB\s*\[/.test(ordinary)) violations.push('computed_bridge_access');
  for (const m of ordinary.matchAll(/\bB\.cgevent\s*\(([^\n;]*)/g)) {
    if (!/^\['(?:idle|displays)'\]\)/.test(m[1])) violations.push('non_readonly_cgevent');
  }
  if (/\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(/.test(ordinary)) violations.push('unbounded_process_execution');
  if (/session\.request\(\{\s*op:\s*'(?!status')/.test(ordinary)) violations.push('native_session_write');
  return [...new Set(violations)];
}

export function workerEnvironment(base, directory, source, token, mode, rpcToken = randomUUID(), evidence = null) {
  // Keep only ordinary OS variables. Never inherit an isolated lock or runtime
  // configuration, account/session bindings, test driver or debug-log override.
  const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING']
    .filter(k => typeof base[k] === 'string').map(k => [k, base[k]]));
  Object.assign(env, {
    // Read the real default settings: global Pause must remain authoritative.
    // No settings writer is called, and explicit speed prevents panel saves.
    CHROME_BRIDGE_ACTIVITY: path.join(directory, 'disabled-activity.jsonl'),
    CHROME_BRIDGE_AGENT_STATE: path.join(directory, 'agent-window.json'),
    CHROME_BRIDGE_TAB_DIR: path.join(directory, 'tabs'),
    CHROME_BRIDGE_ROUTINES_DIR: path.join(directory, 'routines'),
    CHROME_BRIDGE_AGENT_NAME: 'Reliability synthetic fixture', CHROME_BRIDGE_AGENT_DISPLAY: 'away',
    CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_HOTSWAP: '0', CHROME_BRIDGE_SWEEP: '0',
    CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_ROUTINE_RECORDING: '0', CHROME_BRIDGE_HABITS: 'off',
    CHROME_BRIDGE_WARM: '0', CHROME_BRIDGE_TAB_TTL_MIN: '0', CHROME_BRIDGE_TAKEOVER: '1',
    CHROME_BRIDGE_INPUT_MODE: 'keys', CHROME_BRIDGE_INPUT_SPEED: '1', CHROME_BRIDGE_RETRY_MAX_MS: '30000',
    MYCHROME_FIXTURE_SOURCE: source, MYCHROME_FIXTURE_TOKEN: token, MYCHROME_FIXTURE_CASE: mode, MYCHROME_FIXTURE_RPC_TOKEN: rpcToken,
    MYCHROME_FIXTURE_PARENT: String(process.pid), MYCHROME_FIXTURE_DIR: directory,
  });
  if (evidence?.nativeBoundsEvidence === true && mode === 'input' && typeof evidence.directory === 'string')
    env.MYCHROME_FIXTURE_BOUNDS_DIR = evidence.directory;
  return env;
}

export function fixtureHTML(token) {
  assert.match(token, /^[a-zA-Z0-9-]+$/);
  return `<!doctype html><meta charset="utf-8"><meta name="fixture-token" content="${token}">
<title>MyChrome synthetic reliability fixture</title><style>body{font:20px system-ui;margin:40px}button,input{font:inherit;margin:10px;padding:14px}</style>
<meta name="fixture-state" content="{}"><h1>Local reliability fixture</h1><button id="tick">Fixture count</button>
<label>Fixture input<input id="field" autocomplete="off"></label><button id="prompt">Fixture prompt</button>
<button id="alert">Fixture alert</button><button id="confirm">Fixture confirm</button><output id="result">Ready</output>
<script>
const state={clicks:0,input:0,keydown:0,keyup:0,untrusted:0,promptDone:0,promptMatches:false,alertDone:0,confirmDone:0,confirmValue:null,lastEventAt:null};
const keys=new Set(),publish=()=>document.querySelector('meta[name="fixture-state"]').content=JSON.stringify(state);publish();
for(const type of ['click','input','keydown','keyup'])document.addEventListener(type,e=>{state.lastEventAt=Date.now();if(!e.isTrusted)state.untrusted++;if(type==='input')state.input++;if(type==='keydown'){state.keydown++;keys.add(e.code);}if(type==='keyup'){state.keyup++;keys.delete(e.code);}state.heldKeys=keys.size;publish();},true);
document.getElementById('tick').onclick=()=>{state.clicks++;publish();};
document.getElementById('prompt').onclick=()=>{const v=prompt('Fixture prompt ${token}','');state.promptDone++;state.promptMatches=v==='fixture-value';publish();};
document.getElementById('alert').onclick=()=>{alert('Fixture alert ${token}');state.alertDone++;publish();};
document.getElementById('confirm').onclick=()=>{state.confirmValue=confirm('Fixture confirm ${token}');state.confirmDone++;publish();};
</script>`;
}

// Private IPC evidence; public adapters still receive the original MCP reply.
export function callReceiptValid(receipt, id, tool) {
  return scrollKeys(receipt, ['id', 'tool', 'startedSequence', 'dispatchSequence', 'settleSequence'])
    && Number.isSafeInteger(id) && id > 0 && receipt.id === id && receipt.tool === tool
    && [receipt.startedSequence, receipt.dispatchSequence, receipt.settleSequence].every(n => Number.isSafeInteger(n) && n > 0)
    && receipt.startedSequence < receipt.dispatchSequence && receipt.dispatchSequence < receipt.settleSequence;
}

export const SAME_CONNECTION_TEXT = Object.freeze({ A: 'fixture-A-17', B: 'fixture-B-29' });

/** A separate fixed fixture. Legacy and scroll fixture bytes are unchanged. */
export function sameConnectionFixtureHTML(token) {
  assert.match(token, /^[a-zA-Z0-9-]+$/);
  return `<!doctype html><meta charset="utf-8"><meta name="fixture-token" content="${token}">
<title>MyChrome same connection fixture</title><style>body{font:20px system-ui;margin:40px}input{font:inherit;margin:10px;padding:14px}</style>
<meta name="fixture-state" content="{}"><h1>Local same connection fixture</h1>
<label>Fixture A<input id="field-a" autocomplete="off"></label><label>Fixture B<input id="field-b" autocomplete="off"></label>
<script>
const fixed=${JSON.stringify(SAME_CONNECTION_TEXT)},state={events:[],inputCount:0,untrusted:0,extraInputs:0,overflow:false};
const publish=()=>document.querySelector('meta[name="fixture-state"]').content=JSON.stringify(state);publish();
document.addEventListener('input',e=>{
  const field=e.target===document.getElementById('field-a')?'A':e.target===document.getElementById('field-b')?'B':'other';
  if(!e.isTrusted)state.untrusted=Math.min(129,state.untrusted+1);
  if(field==='other')state.extraInputs=Math.min(129,state.extraInputs+1);
  state.inputCount=Math.min(129,state.inputCount+1);
  if(state.events.length>=128)state.overflow=true;
  else state.events.push({field,kind:'input',sequence:state.inputCount,trusted:e.isTrusted,
    length:field==='other'?0:Math.min(129,e.target.value.length),
    prefixMatches:field!=='other'&&e.target.value===fixed[field].slice(0,e.target.value.length)});
  publish();
},true);
</script>`;
}

export function sameConnectionSamplerScript({ url, token }) {
  return `JSON.stringify((()=>{
    if(location.href!==${JSON.stringify(url)}||document.querySelector('meta[name="fixture-token"]')?.content!==${JSON.stringify(token)})return {ok:false};
    const a=document.getElementById('field-a'),b=document.getElementById('field-b'),registry=window.__chromeBridge;
    if(!a||!b)return {ok:false};
    const raw=JSON.parse(document.querySelector('meta[name="fixture-state"]').content),count=n=>Number.isSafeInteger(n)&&n>=0&&n<=129?n:null;
    const events=Array.isArray(raw.events)?raw.events.slice(0,128).map(e=>({field:e.field==='A'?'A':e.field==='B'?'B':'other',
      kind:e.kind==='input'?'input':'other',sequence:count(e.sequence),trusted:e.trusted===true,length:count(e.length),prefixMatches:e.prefixMatches===true})):[];
    return {ok:true,state:{events,inputCount:count(raw.inputCount),untrusted:count(raw.untrusted),extraInputs:count(raw.extraInputs),
      overflow:raw.overflow!==false||!Array.isArray(raw.events)||raw.events.length>128,
      valueMatchesA:a.value===${JSON.stringify(SAME_CONNECTION_TEXT.A)},valueMatchesB:b.value===${JSON.stringify(SAME_CONNECTION_TEXT.B)},
      valueEmptyA:a.value==='',valueEmptyB:b.value==='',valueLengthA:Math.min(129,a.value.length),valueLengthB:Math.min(129,b.value.length)},
      markers:registry?.url===location.href?{A:registry.markers.indexOf(a),B:registry.markers.indexOf(b)}:null};
  })())`;
}

export function sameConnectionOverlap(receipts) {
  if (!Array.isArray(receipts) || receipts.length !== 2) return false;
  const [a, b] = receipts;
  return callReceiptValid(a, a?.id, 'type_text') && callReceiptValid(b, b?.id, 'type_text') && a.id !== b.id
    && a.dispatchSequence < b.dispatchSequence && b.dispatchSequence < a.settleSequence;
}

export function sameConnectionSampleValid(sample) {
  if (!sample || !scrollIdentity(sample.identity) || sample.overflow !== false || sample.untrusted !== 0 || sample.extraInputs !== 0
    || sample.valueMatchesA !== true || sample.valueMatchesB !== true
    || sample.valueLengthA !== SAME_CONNECTION_TEXT.A.length || sample.valueLengthB !== SAME_CONNECTION_TEXT['B'].length
    || !Array.isArray(sample.events) || sample.inputCount !== SAME_CONNECTION_TEXT.A.length + SAME_CONNECTION_TEXT['B'].length
    || sample.events.length !== sample.inputCount) return false;
  return sample.events.every((event, index) => {
    const field = index < SAME_CONNECTION_TEXT.A.length ? 'A' : 'B';
    const length = field === 'A' ? index + 1 : index + 1 - SAME_CONNECTION_TEXT.A.length;
    return scrollKeys(event, ['field', 'kind', 'sequence', 'trusted', 'length', 'prefixMatches'])
      && event.field === field && event.kind === 'input' && event.sequence === index + 1
      && event.trusted === true && event.length === length && event.prefixMatches === true;
  });
}

/** Pin the first healthy hold, Session object and lease token. This never
 * adopts a replacement, even when its PID and native active flag look healthy. */
export function createHoldFence({ getHold, readLease, readStatus, readHealth, deny }) {
  let pinned = null, sealed = null;
  const fail = (reason, interrupted = null) => { sealed ||= reason; deny(sealed);
    throw Object.assign(error(sealed, 'worker_hold'), interrupted ? { interrupted: { kind: interrupted.kind, t: interrupted.t } } : {}); };
  const identity = (hold, allowReleased) => {
    if (!pinned) return;
    if (!hold && allowReleased) return;
    if (hold !== pinned.hold || hold?.kept?.session !== pinned.session || hold?.lease?.token !== pinned.token)
      fail('original_hold_changed');
  };
  return {
    get pinned() { return pinned; },
    async fresh({ allowReleased = false, requireHold = false } = {}) {
      if (sealed) throw error(sealed, 'worker_hold');
      const hold = getHold(); identity(hold, allowReleased);
      if (pinned?.session?.interrupted) fail('native_interruption', pinned.session.interrupted);
      const lease = await readLease(); identity(getHold(), allowReleased);
      if (pinned && lease?.pid === process.pid && lease.token !== pinned.token) fail('original_lease_changed');
      const health = await readHealth(); identity(getHold(), allowReleased);
      if (health.paused) fail('paused_by_user');
      if (health.locked !== false || health.asleep !== false) fail('screen_locked_or_unreadable');
      if (!hold) {
        if (requireHold || (pinned && !allowReleased)) fail('original_hold_missing');
        return { ...health, workerHold: false, sameHold: false, healthyHold: false, status: null,
          lease: lease && { ownerPid: lease.pid, owned: lease.pid === process.pid, sameToken: false } };
      }
      const session = hold.kept?.session, token = hold.lease?.token;
      if (!session || typeof token !== 'string' || !token || lease?.pid !== process.pid || lease.token !== token)
        fail('original_lease_unverified');
      const status = await readStatus(session); identity(getHold(), allowReleased);
      if (getHold() !== hold || hold.kept?.session !== session || hold.lease?.token !== token) fail('original_hold_changed');
      if (status?.interrupted || session.interrupted) fail('native_interruption', status?.interrupted || session.interrupted);
      if (status?.ok !== true || status?.takeover?.active !== true) fail('original_hold_unhealthy');
      const confirmedLease = await readLease(); identity(getHold(), allowReleased);
      if (confirmedLease?.pid !== process.pid || confirmedLease.token !== token) fail('original_lease_changed');
      pinned ||= { hold, session, token };
      return { ...health, workerHold: true, sameHold: hold === pinned.hold && session === pinned.session,
        healthyHold: true, status, lease: { ownerPid: lease.pid, owned: true, sameToken: lease.token === pinned.token } };
    }
  };
}

/** Resource shutdown only. No product lifecycle cleanup, restore, session end,
 * lease release or lock deletion. Process exit closes helper stdin. */
export function stopWorkerResources(holds, controllers) {
  for (const hold of new Set(holds.filter(Boolean))) {
    clearTimeout(hold.timer); clearInterval(hold.poll);
    hold.timer = hold.poll = null;
    hold.busy = true; // An already-awaiting gap poll must not call endTaskHold.
  }
  for (const controller of controllers.values()) controller.abort();
}

export function cleanupDecision(state, own, health) {
  if (state.terminal) return { close: false, reason: state.terminal };
  if (state.handoff) return { close: false, reason: 'handed_to_user' };
  if (state.partial) return { close: false, reason: 'partial_creation_unclaimed' };
  if (state.unknown) return { close: false, reason: 'unknown_delivery_boundary' };
  if (!health?.healthyHold || !health?.sameHold || !health?.lease?.owned || !health?.lease?.sameToken)
    return { close: false, reason: 'original_healthy_hold_unproven' };
  if (!own?.exact || !own?.closable) return { close: false, reason: 'ownership_or_user_view_unknown' };
  return { close: true, reason: 'exact_owned_fixture' };
}

export function handoffEvidence(reply, setup) {
  const text = reply?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
  return { setupObserved: setup?.fieldFocused === true && setup?.askVisible === true && Number.isSafeInteger(setup?.selectedTab),
    expectedReply: reply?.isError !== true && /本次观察已结束，这不代表收到继续授权/.test(text)
      && /用户还没在 \[\d+\] 输入完|用户在 \[\d+\]/.test(text) };
}

/** Old MCP errors may have no structured facts. Treat every unexpected error
 * as terminal without interpreting localized prose; retain bounded claims only.
 * The explicit partial-create response fault is classified separately, but
 * its worker also exits immediately. Proof is captured before losing the
 * response; the parent reads that bound terminal receipt without worker RPC.
 */
export function mcpReplyBoundary(state, reply, { mode, tool, expectedError = null } = {}) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    state.terminal ||= 'malformed_mcp_reply';
    return { code: 'malformed_mcp_reply', stage: 'rpc_response', inputDelivery: 'unknown', terminal: true, expectedError: false };
  }
  const productError = productErrorFact(reply?.structuredContent?.error);
  const facts = productError ? { ...productError } : { code: null, stage: 'unobserved', inputDelivery: 'unobserved' };
  const knownStop = ['cancelled', 'user_cancelled', 'screen_locked', 'takeover_expired', 'user_interrupted', 'paused_by_user', 'native_interruption', 'input_monitor_failed', 'control_integrity_lost'].includes(facts.code);
  const expectedPartial = reply?.isError === true && mode === 'partial-create' && tool === 'open_tab'
    && expectedError === 'partial-create-response' && !knownStop;
  const terminal = knownStop || (reply?.isError === true && !expectedPartial);
  if (terminal) state.terminal ||= knownStop ? facts.code : 'unexpected_mcp_error';
  if (expectedPartial) { state.unknown = true; facts.inputDelivery = 'unknown'; }
  return { ...facts, productError, terminal, expectedError: expectedPartial };
}

export async function executeCase(mode, h) {
  await h.plan();
  if (mode === 'partial-create') {
    const result = await h.open({ allowError: true, unknownIdentity: true });
    h.check('partial_response_is_error', true, result.error === true);
    const fault = await h.fault();
    h.check('one_real_create', 1, fault.attempts);
    h.check('created_fixture_not_registered', false, fault.registered);
    h.check('retained_identity_is_exact_fixture', true, fault.exact);
    h.state.partial = true; h.state.retainedFixture = fault.identity;
    return;
  }
  const tab = await h.open();
  if (mode === 'same-connection-writes') {
    const receipts = await h.sameConnectionWrites(tab);
    if (!sameConnectionOverlap(receipts)) throw error('insufficient_overlap');
    h.check('same_connection_actual_worker_overlap', true, sameConnectionOverlap(receipts));
    if (h.state.terminal || h.state.unknown) throw error(h.state.terminal || 'unknown_delivery_boundary');
    const after = await h.sample(tab);
    h.check('same_connection_exact_trusted_ordered_fields', true, sameConnectionSampleValid(after));
    h.state.sameConnectionEvidence = { receipts, sample: after };
    return;
  }
  const initial = await h.sample(tab);
  await h.click(tab, 'tick');
  const held = await h.observe(); h.check('native_hold_active_after_click', true, held.takeover?.active);
  h.check('shared_lease_is_worker', true, held.lease?.owned);
  if (mode === 'input') {
    const second = await h.open();
    h.check('background_open_same_window', (await h.own(tab)).windowId, (await h.own(second)).windowId);
    h.check('background_open_preserved_selected_tab', true, (await h.own(tab)).tabActive);
    h.check('background_open_retained_native_hold', true, (await h.observe()).takeover?.active);
    await h.type(tab, 'field', 'fixture-value');
    const after = await h.sample(tab);
    h.check('single_trusted_click', initial.clicks + 1, after.clicks);
    h.check('fixture_text_matches', true, after.valueMatches);
    h.check('no_untrusted_events', 0, after.untrusted);
    h.check('fixture_keys_released', 0, after.heldKeys);
  } else if (mode === 'scroll-document') {
    const before = await h.sample(tab);
    h.check('scroll_initial_sample_finite', true, scrollSampleValid(initial));
    h.check('scroll_before_sample_finite_monotonic', true, scrollSampleValid(before, initial));
    h.check('scroll_before_has_room', true, before.maxScrollY - before.scrollY >= before.innerHeight);
    h.check('scroll_setup_tick_once', initial.clicks + 1, before.clicks);
    await h.scroll(tab);
    const after = await h.sample(tab);
    const evidence = scrollDocumentEvidence(before, after);
    h.check('scroll_after_sample_finite_monotonic', true, scrollSampleValid(after, before));
    h.check('scroll_identity_observed', true, evidence.identityObserved);
    h.check('document_scroll_observed', true, evidence.documentScrollObserved);
    h.state.documentScrollEvidence = evidence;
    h.state.documentScrollSamples = { before, after };
  } else if (mode === 'dialog') {
    for (const kind of ['prompt', 'alert', 'confirm']) {
      await h.click(tab, kind);
      const dialog = await h.dialog(tab);
      h.check('dialog_exact_identity', true, dialog.exact);
      await h.answer(tab, dialog.button, kind === 'prompt' ? 'fixture-value' : undefined);
      const after = await h.sample(tab);
      h.check(`${kind}_handled_once`, 1, after[`${kind}Done`]);
      if (kind === 'prompt') h.check('prompt_readback_matches', true, after.promptMatches);
    }
  } else if (mode === 'close') {
    await h.close(tab);
  } else if (mode === 'handoff') {
    // Set terminal boundary before dispatch: failure or abort cannot run cleanup
    // writes after this page was potentially offered to the user.
    await h.handoff(tab);
    const after = await h.observe();
    h.check('handoff_has_no_worker_hold', false, after.workerHold);
    h.check('handoff_released_shared_lease', false, after.lease?.owned);
    return;
  } else if (mode === 'concurrency') {
    await h.concurrent(tab);
    return;
  } else if (mode === 'stop') {
    await h.waitForStop(tab);
    return;
  }
}

export async function cleanupFixtures({ state, owned, workers, observe, readWorker, call, check, report }) {
  for (const item of owned) {
    if (item.closed) continue;
    let own = null, health = null;
    if (!state.terminal && !state.handoff && !state.partial && !state.unknown) {
      try {
        health = await observe(item.worker);
        if (cleanupDecision(state, { exact: true, closable: true }, health).close)
          own = await readWorker(item.worker, 'own', { tab: item.tabId });
        if (own && (own.tabId !== item.tabId || own.windowId !== item.windowId)) own = { ...own, closable: false };
      } catch (e) { state.terminal ||= e.code || 'cleanup_health_unknown'; }
    }
    const decision = cleanupDecision(state, own, health);
    const row = { tabId: item.tabId, windowId: item.windowId, ...decision };
    if (!decision.close && !state.terminal && !state.partial && !state.unknown && !state.handoff) state.terminal = decision.reason;
    if (decision.close) {
      try {
        await call(item.worker, 'close_tab', { tab: item.tabId });
        row.closed = (await readWorker(item.worker, 'gone', { tab: item.tabId })).gone;
        if (!row.closed) { row.code = 'close_receipt_without_absence'; state.terminal ||= row.code; }
        else item.closed = true;
      } catch (e) { row.closed = false; row.code = e.code || 'cleanup_unknown'; state.terminal ||= row.code; }
    }
    report.cleanup.push(row);
  }
  if (!state.terminal && !state.handoff && !state.partial && !state.unknown) {
    for (const w of workers) {
      if (state.terminal) break;
      if (w.completed) continue;
      try {
        const health = await observe(w);
        if (!cleanupDecision(state, { exact: true, closable: true }, health).close) {
          state.terminal = 'original_healthy_hold_unproven';
          report.cleanup.push({ workerPid: w.pid, releaseCode: state.terminal });
          break;
        }
        await call(w, 'task_plan', { done: true }); w.completed = true;
      } catch (e) { state.terminal ||= e.code || 'release_unobserved'; report.cleanup.push({ workerPid: w.pid, releaseCode: state.terminal }); }
    }
  }
  if (!state.terminal && !state.handoff && !state.partial && !state.unknown && workers.length && workers.every(w => w.completed)) {
    try {
      const final = await observe(workers[0]); report.postCleanup = final;
      check('post_cleanup_held_keys_empty', [], final.heldKeys);
      check('post_cleanup_original_scene', report.originalScene, final.scene);
    } catch (e) { report.status = 'failed'; report.postCleanupError = e.code || 'restoration_unconfirmed'; process.exitCode = 1; }
  }
}

async function hashes(root, mode) {
  const files = mode === 'scroll-document' ? [...new Set([...HASH_FILES, ...Object.keys(SCROLL_SOURCE_PINS)])] : HASH_FILES;
  return Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
}

/** The worker forks HERE; its relative imports resolve beside HERE, regardless
 * of the selected product root. Keep those bytes and the QA counterpart in a
 * separate manifest. Fixed file set only; live never substitutes these args. */
export async function scrollHarnessHashes(here = HERE, readFile = fs.readFile) {
  const files = ['reliability-reset-live.mjs', 'reliability-reset-harness.test.mjs',
    'harness-terminal.mjs', 'native-bounds-evidence.mjs'];
  return Object.fromEntries(await Promise.all(files.map(async file =>
    [file, scrollHash(await readFile(file === 'reliability-reset-live.mjs' ? here : path.join(path.dirname(here), file)))])));
}

/** Worker is a real MCP Client + the product's unchanged Server. Importing
 * index as a module avoids main-only GUI discovery, log/presence startup and
 * sweep. The test connection hook only connects transports; no input mocks.
 */
async function fixtureWorker() {
  const env = process.env, token = env.MYCHROME_FIXTURE_TOKEN, rpcToken = env.MYCHROME_FIXTURE_RPC_TOKEN;
  if (!process.send || Number(env.MYCHROME_FIXTURE_PARENT) !== process.ppid || !token || !rpcToken) throw error('worker_parent_missing');
  const source = env.MYCHROME_FIXTURE_SOURCE;
  const api = await import(pathToFileURL(path.join(source, 'src/index.js')));
  const B = await import(pathToFileURL(path.join(source, 'src/bridge.js')));
  const tabs = await import(pathToFileURL(path.join(source, 'src/tabs.js')));
  const settings = await import(pathToFileURL(path.join(source, 'src/settings.js')));
  const { LOCK_DIR } = await import(pathToFileURL(path.join(source, 'src/lock.js')));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const retained = { attempts: 0, created: null }, controllers = new Map(), fixtures = new Map();
  const scrollGate = createScrollActionGate(env.MYCHROME_FIXTURE_CASE);
  const scrollAudit = env.MYCHROME_FIXTURE_CASE === 'scroll-document' ? createScrollAudit({ sources: Object.fromEntries(
    await Promise.all(Object.keys(SCROLL_SOURCE_PINS).map(async file => [file, await fs.readFile(path.join(source, file), 'utf8')]))
  ) }) : null;
  if (scrollAudit) installScrollAudit(api, B, scrollAudit);
  await api.__connectForTests(serverTransport);
  const client = new Client({ name: 'Reliability fixture', version: '1' }, { capabilities: {} });
  await client.connect(clientTransport);
  const boundsEvidence = process.argv.includes('--native-bounds-evidence-worker')
    && env.MYCHROME_FIXTURE_CASE === 'input' && env.MYCHROME_FIXTURE_BOUNDS_DIR
    ? createBoundsEvidenceCollector({ directory: env.MYCHROME_FIXTURE_BOUNDS_DIR, binding: rpcToken }) : null;
  if (boundsEvidence) installNativeBoundsEvidence(api, B, boundsEvidence);
  if (env.MYCHROME_FIXTURE_CASE === 'partial-create') installPartialCreateFault(api, B, retained, async created => {
    const info = await B.chromeInfo(created.tabId), record = await tabs.readTabRecord(created.tabId);
    return { attempts: retained.attempts, registered: !!record, exact: info.url === url && info.windowId === created.windowId,
      identity: { ...retained.created }, createdAt: retained.createdAt };
  });
  let url = null, lastInterruption = null, releaseKind = null;
  let sameConnectionPrepared = null, sameConnectionWriteCount = 0;
  const workerState = { terminal: null, unknown: false };
  const requestContext = new AsyncLocalStorage();
  let eventSequence = 0, firstTerminal = null;
  const diagnosticSessionId = randomUUID();
  const stopResources = () => stopWorkerResources([api.__taskHoldForTests(), fence.pinned?.hold], controllers);
  const deny = (reason, facts = {}) => {
    workerState.terminal ||= reason;
    const context = requestContext.getStore();
    firstTerminal ||= { code: workerState.terminal, call: context ? { ...context } : null,
      productError: context?.productError ? { ...context.productError } : null,
      workerFailure: facts.workerFailure || null, rpcFailure: facts.rpcFailure || null };
    if (typeof boundsEvidence !== 'undefined') boundsEvidence?.finalizeTerminal();
    disposeTerminal({ directory: env.MYCHROME_FIXTURE_DIR, binding: rpcToken,
      terminal: { code: firstTerminal.code, stage: firstTerminal.call?.tool || 'worker', inputDelivery: 'unknown', noRetry: true },
      fixtures: [...fixtures.values(), ...(retained.created ? [retained.created] : [])], call: firstTerminal.call,
      productError: firstTerminal.productError,
      workerFailure: firstTerminal.workerFailure, rpcFailure: firstTerminal.rpcFailure,
      pinned: fence.pinned && { ...fence.pinned, sessionId: diagnosticSessionId },
      diagnostic: retained.responseLost ? retained.proof : null });
    throw error(workerState.terminal);
  };
  const fence = createHoldFence({ getHold: () => api.__taskHoldForTests(), deny,
    readLease: async () => { try { return JSON.parse(await fs.readFile(path.join(LOCK_DIR, 'owner.json'), 'utf8')); } catch { return null; } },
    readStatus: session => session.request({ op: 'status' }, { raw: true }).catch(() => null),
    readHealth: async () => { const screen = await B.cgevent(['displays']);
      return { paused: settings.get('paused'), locked: screen.locked ?? null, asleep: screen.displaysAsleep ?? null }; }
  });
  async function fresh({ diagnostic = false, requireHold = false } = {}) {
    if (workerState.terminal || (workerState.unknown && !diagnostic)) throw error(workerState.terminal || 'unknown_delivery_boundary');
    return fence.fresh({ allowReleased: !!releaseKind || diagnostic, requireHold });
  }
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    stopResources();
    void clientTransport.close().catch(() => {});
    process.exit(0);
  }
  async function own(tab) {
    await fresh();
    const record = await tabs.readTabRecord(tab);
    await fresh();
    const info = await B.chromeInfo(tab);
    await fresh();
    const exact = record?.ownerPid === process.pid && record?.expectedUrl === url && info.url === url
      && Number(record.windowId) === Number(info.windowId) && Number(info.tabId) === Number(tab);
    const closable = exact && !record.takenOver && !record.ownershipUncertain && !record.protected && !record.closeBlocked
      && !(info.windowIndex === 1 && info.tabActive && !api.__taskHoldForTests());
    const identity = { exact, closable, tabId: Number(tab), windowId: info.windowId, chromePid: info.chromePid, cgWindow: info.cgWindow, tabActive: info.tabActive };
    if (['scroll-document', 'same-connection-writes'].includes(env.MYCHROME_FIXTURE_CASE)) {
      const original = fixtures.get(Number(tab));
      if (!exact || !scrollIdentity(identity) || (original && !scrollIdentityMatches(original, identity))) {
        deny('fixture_identity_changed'); throw error('fixture_identity_changed');
      }
      scrollAudit?.bind(identity);
    }
    if (exact) fixtures.set(Number(tab), identity);
    return identity;
  }
  async function sample(tab, markerId = null) {
    const identity = await own(tab); if (!identity.exact) throw error('fixture_identity_changed');
    if (env.MYCHROME_FIXTURE_CASE === 'scroll-document') {
      const fields = { url, token, markerId };
      const script = scrollSamplerScript(fields);
      scrollAudit.sampler(fields);
      await fresh();
      const r = await B.evalInPage(script, tab, { lean: true });
      await fresh();
      if (r?.ok !== true) { deny('fixture_token_changed'); throw error('fixture_token_changed'); }
      r.state.identity = Object.fromEntries(SCROLL_ID_KEYS.map(k => [k, identity[k]]));
      return { ...r, audit: scrollAudit.snapshot() };
    }
    if (env.MYCHROME_FIXTURE_CASE === 'same-connection-writes') {
      await fresh({ requireHold: true });
      const r = await B.evalInPage(sameConnectionSamplerScript({ url, token }), tab, { lean: true });
      await fresh({ requireHold: true });
      if (r?.ok !== true) { deny('fixture_token_changed'); throw error('fixture_token_changed'); }
      r.state.identity = Object.fromEntries(SCROLL_ID_KEYS.map(k => [k, identity[k]]));
      if (!sameConnectionPrepared && sameConnectionWriteCount === 0 && r.state.valueEmptyA === true && r.state.valueEmptyB === true
        && r.state.inputCount === 0 && r.state.untrusted === 0 && r.state.extraInputs === 0 && r.state.overflow === false
        && Number.isSafeInteger(r.markers?.A) && r.markers.A > 0 && Number.isSafeInteger(r.markers?.B) && r.markers.B > 0
        && r.markers.A !== r.markers.B) sameConnectionPrepared = { tab, markers: { ...r.markers } };
      return r;
    }
    // Fixed read-only expression, after URL/record identity. Never evaluate
    // caller-provided JavaScript and never read values from a non-fixture page.
    await fresh();
    const r = await B.evalInPage(`JSON.stringify((()=>{
      if(location.href!==${JSON.stringify(url)}||document.querySelector('meta[name="fixture-token"]')?.content!==${JSON.stringify(token)})return {ok:false};
      const field=document.getElementById('field'), registry=window.__chromeBridge;
      return {ok:true,state:{...JSON.parse(document.querySelector('meta[name="fixture-state"]').content),valueLength:field.value.length,valueMatches:field.value==='fixture-value',
        fieldFocused:document.activeElement===field,askVisible:!!document.querySelector('[data-mychrome-ask]')},
        marker:registry?.url===location.href?registry.markers.indexOf(document.getElementById(${JSON.stringify(markerId)})):-1};
    })())`, tab, { lean: true });
    await fresh();
    if (!r.ok) throw error('fixture_token_changed');
    return r;
  }
  async function observe() {
    const health = await fresh(), th = api.__taskHoldForTests();
    const status = health.status;
    lastInterruption = status?.interrupted || fence.pinned?.session?.interrupted || lastInterruption;
    const idle = await B.cgevent(['idle']);
    await fresh();
    const rawScene = await B.snapshotScene();
    const final = await fresh();
    let queuedPids = [];
    try { queuedPids = (await fs.readdir(LOCK_DIR + '.queue'))
      .map(n => /^\d{14}-(\d+)-\d+\.json$/.exec(n)).filter(Boolean).map(m => Number(m[1])); } catch {}
    return { timestamp: new Date().toISOString(), workerPid: process.pid, workerHold: final.workerHold,
      sameHold: final.sameHold, healthyHold: final.healthyHold, paused: final.paused,
      helperPid: th?.kept?.session?.pid ?? null, takeover: status?.takeover ?? null,
      interrupted: lastInterruption ? { kind: lastInterruption.kind, t: lastInterruption.t } : null,
      heldKeys: Array.isArray(idle.held) ? idle.held : null,
      locked: final.locked, asleep: final.asleep,
      scene: { appPid: rawScene.appPid, chromeWindow: rawScene.chromeWindow, chromeTab: rawScene.chromeTab }, lease: final.lease, queuedPids,
      tapEnabled: unknown('session status is not an independent CGEventTap observation'),
      inputReleased: { basis: 'inferred', value: !final.workerHold && !final.lease?.owned, reason: 'worker hold and shared lease only' } };
  }
  async function dispatch(m) {
    if (m.op === 'init') { const u = new URL(m.url); if (u.hostname !== '127.0.0.1' || u.pathname !== `/fixture-${token}`) throw error('non_fixture_url'); url = m.url; return { pid: process.pid }; }
    if (m.op === 'call') {
      const callContext = requestContext.getStore();
      if (!callContext || callContext.id !== m.id) throw error('request_context_missing');
      if (!WRITE_TOOLS.has(m.name) && m.name !== 'read_page' && m.name !== 'scroll') throw error('tool_not_allowlisted');
      if (releaseKind) throw error('released_worker_boundary');
      if (env.MYCHROME_FIXTURE_CASE === 'same-connection-writes' && m.name === 'type_text') {
        const field = ['A', 'B'][sameConnectionWriteCount];
        if (!field || !sameConnectionPrepared || !scrollKeys(m.args, ['tab', 'marker', 'text', 'input_mode', 'submit'])
          || m.args.tab !== sameConnectionPrepared.tab || m.args.marker !== sameConnectionPrepared.markers[field]
          || m.args.text !== SAME_CONNECTION_TEXT[field] || m.args.input_mode !== 'keys' || m.args.submit !== false)
          throw error('same_connection_write_refused');
        sameConnectionWriteCount++;
      }
      const audit = typeof scrollAudit === 'undefined' ? null : scrollAudit;
      if (m.name === 'scroll') {
        scrollGate.accept(m.args, fixtures.get(m.args?.tab));
        audit?.begin(); // Preserve the outer freshness and ownership window.
      }
      const evidence = typeof boundsEvidence === 'undefined' ? null : boundsEvidence;
      const acceptedCall = evidence?.acceptCall(m.name); // Before the first await.
      const perform = async () => {
        await fresh();
        if (m.name === 'open_tab' && m.args.url !== url) throw error('non_fixture_open');
        if (m.args.tab != null && !(await own(m.args.tab)).exact) throw error('fixture_identity_changed');
        await fresh();
        const ac = new AbortController(); controllers.set(m.id, ac);
        if (m.name === 'wait_for_user') releaseKind = 'handoff';
        if (m.name === 'task_plan' && m.args.done) releaseKind = 'done';
        try {
          evidence?.markDispatched(acceptedCall);
          callContext.dispatchSequence = ++eventSequence;
          if (m.name === 'scroll') audit?.actionStart();
          const reply = await client.callTool({ name: m.name, arguments: m.args }, undefined, { timeout: LIVE_BUDGETS.mcpTimeoutMs, signal: ac.signal });
          callContext.responseAt = Date.now();
          callContext.settleSequence = ++eventSequence;
          const boundary = mcpReplyBoundary(workerState, reply, { mode: env.MYCHROME_FIXTURE_CASE, tool: m.name, expectedError: retained.responseLost ? m.expectedError : null });
          callContext.productError = boundary.productError;
          if (boundary.terminal) deny(workerState.terminal);
          else if (boundary.expectedError) { workerState.unknown = true; deny('fixture_response_lost'); }
          else {
            if (m.name === 'scroll') audit?.actionEnd();
            await fresh();
          }
          if (m.name === 'scroll') audit?.end();
          return reply;
        } catch (e) { deny('dispatched_rpc_rejected', workerState.terminal ? {} : { rpcFailure: rpcFailureFact(e) }); throw Object.assign(e, { inputDelivery: 'unknown', noRetry: true }); }
        finally { controllers.delete(m.id); }
      };
      try { return await (evidence ? evidence.enterCall(acceptedCall, perform) : perform()); }
      finally { evidence?.settleCall(acceptedCall); }
    }
    if (m.op === 'abort') { deny('parent_abort'); return { aborted: controllers.size }; }
    if (m.op === 'observe') return observe();
    if (m.op === 'own') return own(m.tab);
    if (m.op === 'sample') return sample(m.tab, m.markerId);
    if (m.op === 'gone') {
      await fresh();
      try { await B.chromeInfo(m.tab); return { gone: false }; }
      catch (e) { if (e.code === 'no_such_tab') return { gone: true }; throw e; }
    }
    if (m.op === 'dialog') {
      const identity = await own(m.tab); if (!identity.exact) throw error('fixture_identity_changed');
      await fresh();
      const d = await B.pageDialog(identity);
      await fresh();
      const exact = d.open === true && d.known === true && d.identity?.version === 1
        && ['chromePid', 'tabId', 'windowId', 'cgWindow'].every(k => d.identity[k] === identity[k])
        && Number.isFinite(d.identity.dialogCgWindow) && typeof d.identity.token === 'string'
        && Array.isArray(d.texts) && d.texts.some(t => t.includes(token));
      if (!exact) throw error('fixture_dialog_identity_unknown');
      const button = d.buttons?.find(b => /^(OK|确定|好)$/.test(b));
      if (!button) throw error('fixture_dialog_button_unknown');
      return { exact, button, identity: { ...d.identity, token: '[not retained]' } };
    }
    if (m.op === 'fault') throw error('post_unknown_rpc_forbidden');
    if (m.op === 'disconnect') { shutdown(); return; }
    throw error('unknown_worker_operation');
  }
  process.on('message', m => {
    if (m?.token !== rpcToken) return;
    if (!Number.isSafeInteger(m.id) || m.id <= 0 || typeof m.op !== 'string') {
      requestContext.run(null, () => deny('invalid_worker_envelope')); return;
    }
    const context = m.op === 'call' ? { id: m.id, tool: m.name, startedAt: Date.now(), responseAt: null,
      startedSequence: ++eventSequence } : null;
    requestContext.run(context, () => {
      const send = reply => {
        if (workerState.terminal) return deny(workerState.terminal);
        if (!process.connected) return deny('parent_disconnected');
        const receipt = context ? { id: context.id, tool: context.tool, startedSequence: context.startedSequence,
          dispatchSequence: context.dispatchSequence, settleSequence: context.settleSequence } : null;
        process.send({ id: m.id, ...reply, ...(receipt ? { receipt } : {}) }, failure =>
          requestContext.run(context, () => { if (failure) deny('ipc_response_lost'); }));
      };
      void dispatch(m).then(value => send({ value }), e => deny(workerState.terminal || e.code || 'worker_error',
        workerState.terminal ? {} : { workerFailure: workerFailureFact(m.op, e) }));
    });
  });
  process.on('disconnect', () => requestContext.run(null, () => deny('parent_disconnected')));
  process.send({ ready: true });
}

async function makeWorker(options, directory, token, url) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const rpcToken = randomUUID();
  const boundsDirectory = options.nativeBoundsEvidence ? await fs.mkdtemp(path.join(directory, 'native-bounds-')) : null;
  if (boundsDirectory) await fs.chmod(boundsDirectory, 0o700);
  const child = fork(HERE, ['--fixture-worker', ...(boundsDirectory ? ['--native-bounds-evidence-worker'] : [])],
    { env: workerEnvironment(process.env, directory, options.source, token, options.case, rpcToken,
      boundsDirectory ? { nativeBoundsEvidence: true, directory: boundsDirectory } : null),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const terminalEvidence = exited.then(async ended => {
    try { return { ...ended, receipt: await readTerminalReceipt(directory, rpcToken, child.pid) }; }
    catch (failure) { return { ...ended, receipt: null, receiptError: failure.code === 'ENOENT' ? 'missing' : 'invalid' }; }
  });
  const pending = new Map(), receipts = new Map(), receiptSequences = new Set();
  let next = 0, acceptedCalls = 0, boundsCallOrdinal = null, protocolFailure = null, readySeen = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error('worker_start_timeout')), 15000);
    child.once('error', reject);
    child.on('message', m => {
      if (protocolFailure) return;
      const failProtocol = () => {
        protocolFailure = 'worker_reply_invalid';
        clearTimeout(timer); reject(error(protocolFailure));
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          p.reject(Object.assign(error(protocolFailure), { rpcId: id, workerPid: child.pid, inputDelivery: 'unknown', noRetry: true }));
        }
        pending.clear();
        // Seal the worker once. A protocol failure never enables another call.
        if (child.connected) child.send({ id: ++next, token: rpcToken, op: 'abort' }, () => {});
      };
      if (m?.ready === true) {
        if (readySeen || Object.keys(m).length !== 1) { failProtocol(); return; }
        readySeen = true; clearTimeout(timer); resolve(); return;
      }
      const p = pending.get(m?.id);
      if (!p || !readySeen || m.error || !Object.hasOwn(m, 'value')) { failProtocol(); return; }
      if (p.op === 'call') {
        const receipt = m.receipt;
        if (!callReceiptValid(receipt, m.id, p.tool) || receipts.has(m.id)
          || [receipt.startedSequence, receipt.dispatchSequence, receipt.settleSequence].some(sequence => receiptSequences.has(sequence))
          || [...receipts].some(([id, prior]) => (id < m.id) !== (prior.startedSequence < receipt.startedSequence))) {
          failProtocol(); return;
        }
        const accepted = Object.freeze({ ...receipt });
        receipts.set(m.id, accepted);
        for (const sequence of [receipt.startedSequence, receipt.dispatchSequence, receipt.settleSequence]) receiptSequences.add(sequence);
        p.setReceipt(accepted);
      } else if (Object.hasOwn(m, 'receipt')) { failProtocol(); return; }
      pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.value);
    });
    child.on('exit', async () => {
      const evidence = await terminalEvidence;
      const failure = () => Object.assign(error(protocolFailure || (evidence.receipt ? 'worker_terminal' : 'worker_exit_unknown')),
        { workerPid: child.pid, terminalReceipt: evidence.receipt, inputDelivery: 'unknown', noRetry: true });
      clearTimeout(timer); reject(failure());
      for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(failure(), { rpcId: id })); } pending.clear();
    });
  });
  const rpc = (op, fields = {}) => {
    const id = ++next;
    let receipt = null;
    const request = new Promise((resolve, reject) => {
      if (protocolFailure || !child.connected) {
        reject(Object.assign(error(protocolFailure || 'worker_disconnected'), { rpcId: id, workerPid: child.pid, inputDelivery: 'unknown', noRetry: true })); return;
      }
      if (op === 'call') { acceptedCalls++; if (fields.name === 'open_tab' && boundsCallOrdinal === null) boundsCallOrdinal = acceptedCalls; }
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(error('harness_timeout'), { rpcId: id })); }, LIVE_BUDGETS.parentRpcTimeoutMs);
      pending.set(id, { resolve, reject, timer, op, tool: fields.name, setReceipt: value => { receipt = value; } });
      child.send({ ...fields, id, token: rpcToken, op }, e => {
        if (e) { pending.delete(id); clearTimeout(timer); reject(Object.assign(error('worker_send_failed'), { rpcId: id })); }
      });
    });
    Object.defineProperties(request, { rpcId: { value: id }, receipt: { get: () => receipt } });
    return request;
  };
  await ready; await rpc('init', { url });
  return { pid: child.pid, rpc, abort: () => rpc('abort'), terminalEvidence: () => terminalEvidence,
    boundsEvidence: boundsDirectory ? async () => {
      try { return { receipt: await readBoundsEvidenceReceipt(boundsDirectory, rpcToken, child.pid, boundsCallOrdinal) }; }
      catch (failure) { return { receipt: null, capture: 'unavailable', reason: failure.code === 'ENOENT' ? 'missing' : 'invalid' }; }
    } : null,
    disconnect: async () => { if (child.connected) void rpc('disconnect').catch(() => {});
      let timer; try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(error('worker_exit_unconfirmed')), 5000); })]); }
      finally { clearTimeout(timer); } } };
}

async function live(options) {
  if (process.env.CGEVENT_DRYRUN || process.env.CHROME_BRIDGE_LOCK || process.env.CHROME_BRIDGE_SETTINGS) throw error('unsafe_inherited_live_environment');
  const beforeHashes = await hashes(options.source, options.case);
  const scrollHarnessBefore = options.case === 'scroll-document' ? await scrollHarnessHashes() : null;
  const diagnosticHashes = async () => Object.fromEntries(await Promise.all(['reliability-reset-live.mjs', 'native-bounds-evidence.mjs']
    .map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(path.dirname(HERE), file))).digest('hex')])));
  const diagnosticBefore = options.nativeBoundsEvidence ? await diagnosticHashes() : null;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mychrome-reliability-reset-'));
  await fs.chmod(directory, 0o700);
  const token = randomUUID(), route = `/fixture-${token}`;
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== route) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.end(options.case === 'scroll-document' ? scrollFixtureHTML(token)
      : options.case === 'same-connection-writes' ? sameConnectionFixtureHTML(token) : fixtureHTML(token));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}${route}`;
  const report = { schema: 1, case: options.case, command: process.argv.slice(2), source: options.source,
    sourceKind: options.sourceKind || 'source', startedAt: new Date().toISOString(), beforeHashes,
    fixture: { url, token }, calls: [], checks: [], observations: [], cleanup: [],
    gaps: ['Independent active HID tap and native send/release timestamps are not observed by this harness.',
      'A hold observed after a completed action does not prove hold-before-send; that ordering needs separate root instrumentation.',
      'Concurrency covers separate MCP workers; same-connection-writes covers one Client only, with worker dispatch overlap and fixed trusted input evidence.',
      'Agent display policy is away; this harness does not independently attest the selected monitor.',
      'System notifications are disabled for the disposable worker; notification delivery/timing is not observed.',
      'Untagged pointer probe and physical hardware acceptance require separate root evidence.',
      'Protected legacy entrypoints are excluded: ' + EXCLUDED.join(', ')], status: 'running' };
  if (diagnosticBefore) report.nativeBoundsEvidenceManifest = { beforeHashes: diagnosticBefore,
    effects: 'Opt-in collection adds allocations, bounded bytes and synchronous file I/O; native reads are unchanged.' };
  if (scrollHarnessBefore) report.scrollHarnessManifest = { entrypoint: HERE, beforeHashes: scrollHarnessBefore };
  const state = { terminal: null, handoff: false, partial: options.case === 'partial-create', retainedFixture: null };
  const workers = [], owned = [], inflight = new Set();
  const scrollGate = createScrollActionGate(options.case);
  const save = () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const abort = code => { if (!state.terminal) state.terminal = code; for (const w of workers) void w.abort().catch(() => {}); };
  const onSignal = () => abort('operator_abort');
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const deadline = setTimeout(() => abort('harness_timeout'), LIVE_BUDGETS.episodeTimeoutMs);
  async function readWorker(w, op, fields = {}) {
    if (state.terminal || (state.unknown && op !== 'fault')) throw error(state.terminal || 'unknown_delivery_boundary');
    try { return await w.rpc(op, fields); } catch (e) {
      if (e.retainedFixture) state.retainedFixture = e.retainedFixture;
      abort(e.code || 'worker_read_unknown'); throw e;
    }
  }
  async function observe(w) {
    const s = await readWorker(w, 'observe'); report.observations.push(s);
    if (s.locked !== false || s.asleep !== false) abort('screen_locked_or_unreadable');
    if (s.paused === true) abort('paused_by_user');
    if (s.interrupted) abort('native_interruption');
    await save(); return s;
  }
  async function call(w, name, args = {}, { expectedError = null } = {}) {
    if (state.terminal || state.unknown || (state.handoff && name !== 'wait_for_user'))
      throw error(state.terminal || (state.unknown ? 'unknown_delivery_boundary' : 'handoff_boundary'));
    if (name === 'scroll') scrollGate.accept(args, owned.find(item => item.worker === w && item.tabId === args?.tab));
    if (WRITE_TOOLS.has(name) || name === 'scroll') {
      await observe(w);
      if (state.terminal) throw error(state.terminal);
    }
    return (await settleCall(w, name, args, { expectedError })).reply;
  }
  async function settleCall(w, name, args, { expectedError = null } = {}) {
    if (state.terminal || state.unknown || (state.handoff && name !== 'wait_for_user'))
      throw error(state.terminal || (state.unknown ? 'unknown_delivery_boundary' : 'handoff_boundary'));
    const started = Date.now();
    const request = w.rpc('call', { name, args, expectedError }); inflight.add(request);
    let r, boundary;
    try {
      r = await request;
      boundary = mcpReplyBoundary(state, r, { mode: options.case, tool: name, expectedError });
      if (boundary.terminal) abort(state.terminal);
    } catch (e) {
      // Seal before inflight removal: a rejected dispatched RPC may have sent.
      abort('dispatched_rpc_rejected');
      const receipt = e.terminalReceipt;
      if (receipt) { report.terminalReceipts ||= [];
        if (!report.terminalReceipts.some(r => r.workerPid === receipt.workerPid)) report.terminalReceipts.push(receipt);
        state.retainedFixture ||= receipt.fixtures[0] || null; }
      const expectedPartial = options.case === 'partial-create' && name === 'open_tab' && expectedError === 'partial-create-response'
        && receipt?.terminal?.code === 'fixture_response_lost' && receipt.diagnostic?.attempts === 1;
      if (expectedPartial) { state.terminal = 'expected_partial_create_unknown'; state.unknown = true; state.partialReceipt = receipt; }
      if (e.retainedFixture) state.retainedFixture = e.retainedFixture;
      report.calls.push({ workerPid: w.pid, rpcId: request.rpcId, tool: name, timestamp: new Date(started).toISOString(),
        responseAt: new Date().toISOString(), elapsedMs: Date.now() - started, error: true,
        code: e.code || 'rpc_rejected', stage: e.stage || 'rpc_response', inputDelivery: 'unknown', noRetry: true,
        ...(receipt ? { workerTerminalRef: { workerPid: receipt.workerPid, schema: receipt.schema }, terminalRpcAttribution: 'unknown' } : {}),
        expectedError: expectedPartial, sendTime: unknown('dispatched RPC rejection does not prove native delivery') });
      await save();
      if (expectedPartial) return { reply: { isError: true, content: [] }, receipt: null };
      throw Object.assign(error('dispatched_rpc_rejected', e.stage || 'rpc_response'), { inputDelivery: 'unknown', noRetry: true });
    } finally { inflight.delete(request); }
    report.calls.push({ workerPid: w.pid, rpcId: request.rpcId, tool: name, timestamp: new Date(started).toISOString(),
      responseAt: new Date().toISOString(), elapsedMs: Date.now() - started, error: boundary.terminal || r?.isError === true,
      code: boundary.code, stage: boundary.stage, inputDelivery: boundary.inputDelivery,
      ...(boundary.productError ? { productError: boundary.productError } : {}),
      expectedError: boundary.expectedError, receipt: request.receipt,
      sendTime: unknown('MCP call boundaries do not measure native send time') });
    await save();
    if (boundary.terminal) throw error(state.terminal, boundary.stage);
    return { reply: r, receipt: request.receipt };
  }
  async function sameConnectionWrites(w, tab) {
    if (options.case !== 'same-connection-writes' || state.sameConnectionAttempted) throw error('same_connection_case_refused');
    if (state.terminal || state.unknown || state.handoff) throw error(state.terminal || 'same_connection_boundary');
    state.sameConnectionAttempted = true;
    await call(w, 'read_page', { tab, full: true });
    const prepared = await readWorker(w, 'sample', { tab });
    const markers = prepared.markers;
    if (!Number.isSafeInteger(markers?.A) || markers.A <= 0 || !Number.isSafeInteger(markers?.B) || markers.B <= 0 || markers.A === markers.B)
      throw error('same_connection_markers_invalid');
    if (prepared.state?.valueEmptyA !== true || prepared.state.valueEmptyB !== true || prepared.state.inputCount !== 0
      || prepared.state.untrusted !== 0 || prepared.state.extraInputs !== 0 || prepared.state.overflow !== false)
      throw error('same_connection_fixture_not_empty');
    const health = await observe(w), original = owned.find(item => item.worker === w && item.tabId === tab);
    const identity = await readWorker(w, 'own', { tab });
    if (!original?.exact || !identity?.exact || !scrollIdentityMatches(original, identity)
      || !scrollIdentityMatches(original, prepared.state.identity)) throw error('same_connection_identity_changed');
    if (!health?.workerHold || !health.healthyHold || !health.sameHold || !health.lease?.owned || !health.lease.sameToken)
      throw error('same_connection_original_hold_unproven');
    // Exactly these two fixed public calls. No observe/read/sample between them.
    const a = settleCall(w, 'type_text', { tab, marker: markers.A, text: SAME_CONNECTION_TEXT.A, input_mode: 'keys', submit: false });
    const b = settleCall(w, 'type_text', { tab, marker: markers.B, text: SAME_CONNECTION_TEXT.B, input_mode: 'keys', submit: false });
    const results = await Promise.all([a, b]);
    if (state.terminal || state.unknown) throw error(state.terminal || 'unknown_delivery_boundary');
    const receipts = results.map(result => result.receipt);
    report.sameConnectionWrites = { receipts, actualOverlap: sameConnectionOverlap(receipts),
      scope: 'One Client and exact owned tab; worker dispatch order and fixture input events only.' };
    if (!sameConnectionOverlap(receipts)) throw error('insufficient_overlap');
    return receipts;
  }
  const check = (name, expected, actual) => { report.checks.push({ name, expected, actual: actual ?? null,
    basis: actual === undefined ? 'unobserved' : 'measured', timestamp: new Date().toISOString() }); assert.deepEqual(actual, expected, name); };
  const adapter = w => ({ state, check, observe: () => observe(w), own: tab => readWorker(w, 'own', { tab }),
    sample: async tab => { const sampled = await readWorker(w, 'sample', { tab });
      if (options.case === 'scroll-document') report.scrollAudit = sampled.audit;
      return sampled.state; },
    sameConnectionWrites: tab => sameConnectionWrites(w, tab),
    scroll: tab => call(w, 'scroll', { tab, direction: 'down', amount: 1 }),
    plan: () => call(w, 'task_plan', { task: `Reliability fixture ${options.case}` }),
    done: async () => { const result = await call(w, 'task_plan', { done: true }); w.completed = true; return result; },
    open: async ({ allowError = false, unknownIdentity = false } = {}) => {
      const r = await call(w, 'open_tab', { url, why: 'user_asked' },
        { expectedError: allowError && unknownIdentity ? 'partial-create-response' : null });
      if (unknownIdentity) return { error: r.isError === true };
      const text = r.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
      const tab = Number(text.match(/\btab=(\d+)\b/)?.[1]);
      if (!Number.isSafeInteger(tab) || tab <= 0) { state.partial = true; throw error('created_identity_missing'); }
      state.retainedFixture = { tabId: tab, exact: false };
      const identity = await readWorker(w, 'own', { tab }); if (!identity.exact) { state.partial = true; throw error('created_identity_unknown'); }
      owned.push({ worker: w, ...identity }); state.retainedFixture = null; await observe(w); return tab;
    },
    click: async (tab, id) => {
      await call(w, 'read_page', { tab, full: true }); const s = await readWorker(w, 'sample', { tab, markerId: id });
      if (!(s.marker > 0)) throw error('fixture_marker_missing');
      return call(w, 'click', { tab, marker: s.marker });
    },
    type: async (tab, id, text) => {
      await call(w, 'read_page', { tab, full: true }); const s = await readWorker(w, 'sample', { tab, markerId: id });
      if (!(s.marker > 0)) throw error('fixture_marker_missing');
      return call(w, 'type_text', { tab, marker: s.marker, text, input_mode: 'keys', submit: false });
    },
    dialog: tab => readWorker(w, 'dialog', { tab }), answer: (tab, button, text) => call(w, 'answer_dialog', { tab, button, ...(text === undefined ? {} : { text }) }),
    fault: async () => {
      const f = state.partialReceipt?.diagnostic;
      if (!f) throw error('partial_fault_receipt_missing');
      report.partialFault = { ...f, stage: 'new_window_response', inputDelivery: 'unknown',
        basis: 'one real creation returned before the injected response error',
        nativeSendTime: unknown('createdAt is response receipt time, not native send time') };
      return f;
    },
    close: async tab => {
      const identity = await readWorker(w, 'own', { tab }); check('close_exact_owned_identity', true, identity.exact);
      check('close_ownership_guard', true, identity.closable);
      const original = owned.find(x => x.worker === w && x.tabId === tab);
      check('close_original_window', original?.windowId, identity.windowId);
      const r = await call(w, 'close_tab', { tab });
      check('close_mcp_receipt', false, r.isError === true);
      check('close_exact_tab_gone', true, (await readWorker(w, 'gone', { tab })).gone);
      owned.find(x => x.worker === w && x.tabId === tab).closed = true;
      report.cleanup.push({ tabId: tab, windowId: identity.windowId, closed: true, reason: 'close_case_verified' });
    },
    handoff: async tab => {
      const p = await call(w, 'read_page', { tab, full: true }); void p;
      const s = await readWorker(w, 'sample', { tab, markerId: 'field' }); if (!(s.marker > 0)) throw error('fixture_marker_missing');
      state.handoff = true;
      let settled = false;
      const pending = call(w, 'wait_for_user', { tab, field: s.marker,
        reason: 'Local fixture handoff; no continuation is authorized by this wait.', minutes: Math.min(options.seconds, 30) / 60 })
        .then(value => ({ value }), e => ({ error: e })).finally(() => { settled = true; });
      let setup = null, readOrder = 0;
      const reads = report.handoffReads = { rounds: [], overflow: false };
      const mark = () => ({ at: Date.now(), order: ++readOrder });
      const boolean = value => typeof value === 'boolean' ? value : null;
      while (!settled && !state.terminal) {
        const row = { settledBefore: settled, terminalBefore: !!state.terminal };
        if (reads.rounds.length < 64) reads.rounds.push(row); else reads.overflow = true;
        const sampleStart = mark(); row.sample = { startAt: sampleStart.at, startOrder: sampleStart.order };
        const page = await readWorker(w, 'sample', { tab });
        const sampleEnd = mark(); Object.assign(row.sample, { endAt: sampleEnd.at, endOrder: sampleEnd.order,
          askVisible: boolean(page.state?.askVisible), fieldFocused: boolean(page.state?.fieldFocused), settledAfter: settled });
        const ownStart = mark(); row.own = { startAt: ownStart.at, startOrder: ownStart.order };
        const own = await readWorker(w, 'own', { tab });
        const ownEnd = mark(); Object.assign(row.own, { endAt: ownEnd.at, endOrder: ownEnd.order, tabActive: boolean(own.tabActive), settledAfter: settled });
        const observeStart = mark(); row.observe = { startAt: observeStart.at, startOrder: observeStart.order };
        const obs = await observe(w);
        const observeEnd = mark(); Object.assign(row.observe, { endAt: observeEnd.at, endOrder: observeEnd.order,
          workerHold: boolean(obs.workerHold), leaseOwned: boolean(obs.lease?.owned), inputReleased: boolean(obs.inputReleased), settledAfter: settled });
        if (page.state.askVisible && page.state.fieldFocused && own.tabActive && !obs.workerHold && !obs.lease?.owned) {
          setup = { fieldFocused: true, askVisible: true, selectedTab: tab, timestamp: obs.timestamp,
            inputReleased: obs.inputReleased }; break;
        }
        await delay(100);
      }
      const result = await pending;
      report.handoffSetup = setup;
      report.handoffWait = { error: !!result.error || result.value?.isError === true, returnedAt: new Date().toISOString(), continuationAuthorized: false };
      if (result.error) throw result.error;
      const evidence = handoffEvidence(result.value, setup);
      check('handoff_setup_observed_after_release', true, evidence.setupObserved);
      check('handoff_expected_wait_reply', true, evidence.expectedReply);
    },
    concurrent: async tab => {
      const peer = await makeWorker(options, path.join(directory, 'peer'), token, url); workers.push(peer);
      const p = adapter(peer), pending = p.open().then(value => ({ value }), e => ({ error: e.code }));
      let observedQueue = false;
      for (let i = 0; i < 40; i++) { const s = await observe(w); if (s.queuedPids.includes(peer.pid) && s.lease?.owned) { observedQueue = true; break; } await delay(100); }
      check('peer_waited_in_real_shared_queue', true, observedQueue);
      check('owner_fixture_click_once', 1, (await readWorker(w, 'sample', { tab })).state.clicks);
      await adapter(w).close(tab);
      await adapter(w).done();
      const result = await pending; if (result.error) throw error(result.error);
      check('peer_fixture_identity', true, (await readWorker(peer, 'own', { tab: result.value })).exact);
    },
    waitForStop: async () => {
      console.log('Root operator: invoke the real Stop now. No browser cleanup will follow this mode.');
      const until = Date.now() + options.seconds * 1000;
      while (Date.now() < until) {
        let s;
        try { s = await observe(w); }
        catch (e) {
          report.stop = { at: new Date().toISOString(), code: e.code, interruption: e.interrupted || null,
            productStop: e.interrupted ? measured(e.interrupted.kind) : unknown('terminal hold observation did not retain a native interruption') };
          return;
        }
        if (s.interrupted || !s.workerHold) {
          state.terminal ||= 'stop_observed';
          report.stop = { at: new Date().toISOString(), interruption: s.interrupted,
            productStop: s.interrupted ? measured(s.interrupted.kind) : unknown('hold ended without a retained native interruption') };
          return;
        }
        if (state.terminal) return;
        await delay(200);
      }
      abort('harness_timeout'); throw error('harness_timeout');
    },
  });
  try {
    const w = await makeWorker(options, path.join(directory, 'owner'), token, url); workers.push(w);
    const original = await observe(w); report.originalScene = original.scene;
    if (state.terminal) throw error(state.terminal);
    check('original_scene_identity_observable', true,
      ['appPid', 'chromeWindow', 'chromeTab'].every(k => Number.isSafeInteger(original.scene[k]) && original.scene[k] > 0));
    await executeCase(options.case, adapter(w));
    report.status = state.terminal ? 'deferred' : 'observations_complete_with_open_gates';
  } catch (e) {
    if (inflight.size) abort('pending_operation_at_failure');
    report.failure = { code: e.code || (e.name === 'AssertionError' ? 'assertion_failed' : 'harness_error'), stage: e.stage || 'scenario' };
    report.status = state.terminal || /timeout|held|busy|idle|mcp_tool_error/.test(e.code || '') ? 'deferred' : 'failed';
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await cleanupFixtures({ state, owned, workers, observe, readWorker, call, check, report });
    if (options.case === 'scroll-document') report.scrollDocument = {
      documentScrollObserved: state.documentScrollEvidence?.documentScrollObserved === true,
      identityObserved: state.documentScrollEvidence?.identityObserved === true && report.scrollAudit?.identityObserved === true,
      scriptAuditComplete: !state.terminal && report.scrollAudit?.scriptAuditComplete === true,
      boundedNativeRequestsObserved: !state.terminal && report.scrollAudit?.boundedNativeRequestsObserved === true,
      samples: Object.fromEntries(Object.entries(state.documentScrollSamples || {}).map(([label, sample]) => [label,
        Object.fromEntries(['scrollY', 'maxScrollY', 'innerHeight', 'sampledAt', 'wheel', 'trustedWheel', 'untrustedWheel', 'scrollEvents',
          'firstWheelAt', 'lastWheelAt', 'firstScrollAt', 'lastScrollAt', 'clicks', 'input', 'keydown', 'keyup', 'untrusted', 'heldKeys']
          .map(key => [key, sample[key]]).concat([['identity', Object.fromEntries(SCROLL_ID_KEYS.map(key => [key, sample.identity[key]]))]]))])),
      scope: 'One public document scroll dispatch-to-normal-return; source-path evidence, not an OS execution trace.',
      terminalAudit: state.terminal ? unknown('in-memory scroll audit is not recovered after terminal') : null,
      timing: { mcpClock: 'parent-wall-ms', workerClock: 'worker-monotonic-ms', pageClock: 'page-performance-ms',
        lockWait: unknown('shared-lock and hands-off internal durations are not exposed'),
        queueWait: unknown('connection queue duration is not exposed'),
        windowsAt: unknown('activation is not an independent windowsat receipt'),
        nativeSend: unknown('request start and return are not OS send timestamps') } };
    if (options.case === 'same-connection-writes') report.sameConnectionWrites = {
      ...report.sameConnectionWrites, fieldEvidence: state.sameConnectionEvidence?.sample || null,
      covered: !state.terminal && sameConnectionOverlap(state.sameConnectionEvidence?.receipts)
        && sameConnectionSampleValid(state.sameConnectionEvidence?.sample),
      nativeSendAndRelease: unknown('worker sequence and page input events are not independent native timing evidence') };
    report.retainedFixture = state.retainedFixture;
    report.terminal = state.terminal;
    if (state.terminal) { report.status = 'deferred'; process.exitCode = 1; }
    // Persist exact retained identities before resource-only worker shutdown.
    await save();
    for (const w of workers) {
      try {
        await w.disconnect();
        const evidence = await w.terminalEvidence();
        if (evidence.receipt) { report.terminalReceipts ||= []; if (!report.terminalReceipts.some(r => r.workerPid === evidence.receipt.workerPid)) report.terminalReceipts.push(evidence.receipt); }
        if (evidence.code !== 0 || evidence.receipt || evidence.receiptError === 'invalid') { report.status = 'deferred'; report.terminal ||= evidence.receipt?.terminal?.code || 'worker_exit_unknown'; process.exitCode = 1; }
      } catch (e) { report.cleanup.push({ workerPid: w.pid, releaseCode: e.code }); report.status = 'deferred'; process.exitCode = 1; }
      if (w.boundsEvidence) { report.nativeBoundsEvidence ||= []; report.nativeBoundsEvidence.push({ workerPid: w.pid, ...await w.boundsEvidence() }); }
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    report.afterHashes = await hashes(options.source, options.case);
    report.sourceUnchanged = JSON.stringify(report.beforeHashes) === JSON.stringify(report.afterHashes);
    if (report.scrollHarnessManifest) {
      report.scrollHarnessManifest.afterHashes = await scrollHarnessHashes();
      report.scrollHarnessManifest.sourceUnchanged = JSON.stringify(scrollHarnessBefore) === JSON.stringify(report.scrollHarnessManifest.afterHashes);
    }
    if (report.scrollDocument && (!report.sourceUnchanged || !report.scrollHarnessManifest?.sourceUnchanged)) {
      report.scrollDocument.scriptAuditComplete = false;
      report.scrollDocument.boundedNativeRequestsObserved = false;
    }
    if (report.nativeBoundsEvidenceManifest) {
      report.nativeBoundsEvidenceManifest.afterHashes = await diagnosticHashes();
      report.nativeBoundsEvidenceManifest.sourceUnchanged = JSON.stringify(diagnosticBefore) === JSON.stringify(report.nativeBoundsEvidenceManifest.afterHashes);
    }
    report.finishedAt = new Date().toISOString(); await save();
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    console.log(`Evidence: ${path.join(directory, 'report.json')}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const source = await fs.readFile(HERE, 'utf8');
  assert.deepEqual(staticSafetyCheck(source), [], 'harness contains forbidden direct mutations');
  if (!options.run) {
    console.log(JSON.stringify({ mode: options.check ? 'check' : 'usage', nativeInput: false, cases: CASES,
      usage: 'node test/reliability-reset-live.mjs --run --root-operator --source /candidate --case input',
      excluded: EXCLUDED, limitations: ['Root-only live execution', 'Stop is an operator action',
        'handoff never resumes or auto-closes', 'partial-create leaves the unclaimed fixture',
        'native tap/send timing and hardware evidence remain separate'] }, null, 2));
    return;
  }
  await live(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  if (process.argv[2] === '--fixture-worker') await fixtureWorker();
  else await main();
}
