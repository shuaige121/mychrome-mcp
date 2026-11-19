import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import * as bridge from '../src/bridge.js';
import { createPagePromptObserver } from '../src/bridge.js';
import { canonicalPromptOrigin } from '../src/page-events.js';
import { source, target, observation, template, tick } from './page-event-fixtures.mjs';
const identity = { version: 1, ...target, dialogCgWindow: 19, token: 'a'.repeat(64) };
function harness(extra = {}, makeObserver = createPagePromptObserver) {
  const children = [], effects = [], lifecycle = [], timers = new Map(); let sequence = 0, clock = 0;
  const observer = makeObserver({
    spawnChild: (bin, argv) => {
      effects.push(['spawn', bin, argv]); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      lifecycle.push(['spawn', children.length]);
      c.kill = signal => { effects.push(['kill', signal]); lifecycle.push(['kill', signal]); return true; };
      c.output = object => c.stdout.emit('data', Buffer.from(JSON.stringify(object)));
      c.close = (code = 0) => { lifecycle.push(['close', code]); c.emit('close', code); }; children.push(c); return c;
    }, readScript: async (...args) => { effects.push(['readScript', ...args]); return 'FIXED_READ_ONLY_SCRIPT'; },
    writeScript: async (...args) => { effects.push(['writeScript', ...args]); },
    removeScript: async (...args) => { effects.push(['removeScript', ...args]); },
    timer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms, at: clock + ms }); return id; }, untimer: id => timers.delete(id), now: () => 1000, ...extra
  });
  const controller = new AbortController();
  const observe = (options = {}) => observer.observe({ source, target, namespace: 'fixture', signal: controller.signal, ...options });
  const expire = ms => { const item = [...timers].find(([, v]) => v.ms === ms); assert.ok(item, `timer ${ms}`); timers.delete(item[0]); item[1].fn(); };
  const advance = async ms => {
    const end = clock + ms;
    for (;;) {
      const item = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break;
      clock = item[1].at; timers.delete(item[0]); item[1].fn(); await tick();
    }
    clock = end; await tick();
  };
  return { observer, children, effects, lifecycle, controller, observe, expire, advance };
}
const nativeOpen = () => ({ ok: true, known: true, open: true, identity, ...template, complete: true,
  hasField: false, origin: template.origins[0], originEvidence: 'native_current_snapshot' });
const domObserved = () => ({ ok: true, ...target,
  result: JSON.stringify({ ok: true, status: 'observed', complete: true, observations: [observation()] }) });
async function assertNormalAudit(makeObserver = createPagePromptObserver) {
  const facts = [], h = harness({ getAudit: () => fact => facts.push(structuredClone(fact)) }, makeObserver);
  const pending = h.observe();
  assert.deepEqual(facts.map(f => f.phase), ['begin', 'validated', 'spawn']);
  assert.equal(h.children.length, 1); assert.equal(facts[2].argvValid, true);
  h.children[0].output({ ok: true, known: true, open: false });
  await tick(); assert.equal(facts.some(f => f.phase === 'close'), false);
  h.children[0].close(); await tick();
  h.children[1].output(domObserved()); h.children[1].close();
  const result = await pending;
  assert.equal(result.status, 'observed'); assert.equal(h.observer.busy(), false);
  assert.deepEqual(facts.map(f => f.phase), ['begin', 'validated', 'spawn', 'close', 'parsed', 'native_result',
    'render', 'write', 'spawn', 'close', 'parsed', 'dom_result', 'released']);
  assert.equal(new Set(facts.map(f => f.attempt)).size, 1);
  assert.deepEqual(facts.filter(f => f.phase === 'spawn').map(f => f.child), [1, 2]);
  assert.deepEqual(facts.filter(f => f.phase === 'parsed').map(f => f.kind), ['native', 'dom']);
  assert.equal(facts.find(f => f.phase === 'render').script, 'FIXED_READ_ONLY_SCRIPT');
  assert.equal(facts.find(f => f.phase === 'write').path, h.effects.find(e => e[0] === 'writeScript')[1]);
  return { facts, h };
}
test('observer audit emits ordered facts from the real factory without treating output as close', async () => {
  await assertNormalAudit();
});
const AUDIT_KEYS = {
  begin: ['attempt'], rejected: ['attempt', 'reason', 'holdingAttempt'], validated: ['attempt', 'target'],
  spawn: ['attempt', 'child', 'kind', 'argv', 'argvValid'], spawn_failed: ['attempt', 'child', 'kind'],
  stop: ['attempt', 'child', 'why', 'via', 'toolStart'], grace_expired: ['attempt', 'child'],
  close: ['attempt', 'child', 'kind', 'code', 'reason', 'cancelled'], parsed: ['attempt', 'child', 'kind'],
  native_result: ['attempt', 'result'], render: ['attempt', 'script', 'namespace'], write: ['attempt', 'path'],
  dom_result: ['attempt', 'result'], released: ['attempt']
};
function assertFactSchema(facts) {
  for (const fact of facts) {
    assert.ok(Object.hasOwn(AUDIT_KEYS, fact.phase), fact.phase);
    assert.deepEqual(Object.keys(fact).sort(), ['phase', ...AUDIT_KEYS[fact.phase]].sort());
    assert.ok(Number.isSafeInteger(fact.attempt) && fact.attempt > 0);
    if (Object.hasOwn(fact, 'child')) assert.ok(Number.isSafeInteger(fact.child) && fact.child > 0 || fact.phase === 'stop' && fact.child === null);
    if (Object.hasOwn(fact, 'kind')) assert.ok(['native', 'dom'].includes(fact.kind));
    if (fact.phase === 'stop') {
      assert.ok(['preempted', 'observer_timeout', 'observer_output_limit', 'observer_spawn_failed', 'disposed'].includes(fact.why));
      assert.ok(['abort', 'cold', 'dispose'].includes(fact.via)); assert.equal(typeof fact.toolStart, 'boolean');
    }
    if (fact.phase === 'close') {
      assert.ok(fact.code === null || Number.isInteger(fact.code)); assert.equal(typeof fact.cancelled, 'boolean');
      assert.ok([null, 'preempted', 'observer_timeout', 'observer_output_limit', 'observer_spawn_failed'].includes(fact.reason));
    }
    if (fact.phase === 'native_result') assert.ok(['open', 'closed', 'unknown', 'identity_mismatch'].includes(fact.result));
    if (fact.phase === 'dom_result') assert.ok(['observed', 'target_changed', 'unknown'].includes(fact.result));
    if (fact.phase === 'rejected') assert.ok(['child_not_settled', 'target_unverified', 'preempted'].includes(fact.reason));
  }
  assert.equal(JSON.stringify(facts).includes(identity.token), false);
  assert.equal(JSON.stringify(facts).includes(template.title), false);
}
function normalizedEffects(h, result, busyBeforeClose) {
  const temporary = h.effects.find(e => e[0] === 'writeScript' || e[0] === 'removeScript')?.[1];
  return JSON.parse(JSON.stringify({ result, effects: h.effects, lifecycle: h.lifecycle,
    busy: h.observer.busy(), busyBeforeClose }), (_key, value) => temporary && value === temporary ? '<temporary>' : value);
}
async function auditScenario(mode, getAudit, makeObserver = createPagePromptObserver) {
  const extra = { getAudit };
  if (mode === 'spawn-throw') extra.spawnChild = () => { throw new Error('spawn failure'); };
  if (mode === 'render-throw') extra.readScript = async () => { throw new Error('render failure'); };
  if (mode === 'write-throw') extra.writeScript = async () => { throw new Error('write failure'); };
  const h = harness(extra, makeObserver);
  if (mode === 'early-abort') h.controller.abort('tool_start');
  const pending = h.observe(); let busyBeforeClose = null, disposing = null;
  if (!h.children.length && mode !== 'spawn-throw' && mode !== 'early-abort') await pending;
  if (mode === 'spawn-throw' || mode === 'early-abort') return { snapshot: normalizedEffects(h, await pending, busyBeforeClose), h };
  if (mode.startsWith('dom-') || ['render-throw', 'write-throw'].includes(mode)) {
    h.children[0].output({ ok: true, known: true, open: false }); h.children[0].close(); await tick();
    if (mode === 'render-throw' || mode === 'write-throw') return { snapshot: normalizedEffects(h, await pending, busyBeforeClose), h };
  }
  const child = h.children.at(-1);
  if (mode === 'native-open') child.output(nativeOpen());
  else if (mode === 'native-identity') child.output({ ...nativeOpen(), identity: { ...identity, tabId: identity.tabId + 1 } });
  else if (mode === 'native-unknown') child.output({ ok: true, known: false });
  else if (mode === 'dom-ok') child.output(domObserved());
  else if (mode === 'dom-target') child.output({ ...domObserved(), tabId: target.tabId + 1 });
  else if (mode === 'dom-bad-json') child.output({ ok: true, ...target, result: 'not json' });
  else if (mode === 'dom-bad-shape') child.output({ ok: true, ...target, result: '{}' });
  else if (mode === 'bad-json') child.stdout.emit('data', Buffer.from('not json'));
  else if (mode === 'stdout' || mode === 'stderr') child[mode].emit('data', Buffer.alloc(65537, 65));
  else if (mode === 'child-error') child.emit('error', new Error('child failure'));
  else if (mode.endsWith('timeout')) h.expire(mode.startsWith('dom-') ? 1000 : 5000);
  else if (mode.includes('abort')) h.controller.abort('tool_start');
  else if (mode.includes('dispose')) disposing = h.observer.dispose();
  if (mode.endsWith('late')) {
    h.expire(250); const result = await pending; busyBeforeClose = h.observer.busy();
    child.close(); await tick();
    return { snapshot: normalizedEffects(h, result, busyBeforeClose), h };
  }
  busyBeforeClose = h.observer.busy(); child.close(mode === 'exit' ? 1 : 0);
  const result = await pending; if (disposing) await disposing;
  return { snapshot: normalizedEffects(h, result, busyBeforeClose), h };
}
const AUDIT_SCENARIOS = ['native-open', 'native-identity', 'native-unknown', 'dom-ok', 'dom-target', 'dom-bad-json',
  'dom-bad-shape', 'bad-json', 'stdout', 'stderr', 'exit', 'child-error', 'spawn-throw', 'render-throw', 'write-throw',
  'native-timeout', 'dom-timeout', 'native-abort', 'dom-abort', 'native-abort-late', 'dom-abort-late',
  'native-dispose', 'dom-dispose', 'early-abort'];
async function assertAuditEffectEquivalence(makeObserver = createPagePromptObserver) {
  for (const mode of AUDIT_SCENARIOS) {
    const baseline = (await auditScenario(mode, undefined, makeObserver)).snapshot;
    for (const variant of ['collect', 'off', 'toggle', 'getter-throws', 'sink-throws']) {
      const facts = []; let reads = 0;
      const getAudit = () => {
        if (variant === 'getter-throws') throw new Error('audit getter failure');
        if (variant === 'off' || variant === 'toggle' && ++reads % 2 === 0) return null;
        return fact => { if (variant === 'sink-throws') throw new Error('audit sink failure'); facts.push(structuredClone(fact)); };
      };
      const actual = await auditScenario(mode, getAudit, makeObserver);
      assert.deepEqual(actual.snapshot, baseline, `${mode}: ${variant}`); assertFactSchema(facts);
      if (variant === 'collect') assert.equal(facts[0].phase, 'begin');
      if (variant === 'off' || variant.endsWith('throws')) assert.equal(facts.length, 0);
    }
  }
}
test('audit default/on/off/toggle/throwing getters and sinks preserve all original effects and outcomes', async () => {
  await assertAuditEffectEquivalence();
});
async function assertLateCloseAudit(makeObserver = createPagePromptObserver) {
  const facts = [], h = harness({ getAudit: () => fact => facts.push(structuredClone(fact)) }, makeObserver);
  const pending = h.observe(); h.controller.abort('tool_start'); h.expire(250);
  assert.equal((await pending).status, 'cancelled'); assert.equal(h.observer.busy(), true);
  assert.equal(facts.some(f => f.phase === 'close' || f.phase === 'released'), false);
  assert.deepEqual(facts.filter(f => f.phase === 'stop').map(f => [f.via, f.toolStart]), [['abort', true], ['cold', true]]);
  const holder = facts[0].attempt; assert.equal((await h.observe()).reason, 'child_not_settled');
  assert.equal(facts.at(-1).holdingAttempt, holder); assert.notEqual(facts.at(-1).attempt, holder);
  h.children[0].close(); await tick(); assert.equal(h.observer.busy(), false);
  assert.deepEqual(facts.filter(f => f.attempt === holder).map(f => f.phase),
    ['begin', 'validated', 'spawn', 'stop', 'stop', 'grace_expired', 'close', 'released']);
  assert.equal(facts.some(f => f.phase === 'parsed' || f.phase === 'render'), false); assertFactSchema(facts);
}
test('grace settlement and a rejected follower retain the owning attempt until real late close and release', async () => {
  await assertLateCloseAudit();
});
async function assertFactCopies(makeObserver = createPagePromptObserver) {
  const facts = [], h = harness({ getAudit: () => fact => {
    facts.push(structuredClone(fact));
    if (fact.phase === 'validated') fact.target.chromePid = 999999;
    if (fact.phase === 'spawn' && fact.argv) { fact.argv[0] = 'MUTATED'; fact.argv.push('extra'); }
  } }, makeObserver);
  const pending = h.observe(); h.children[0].output({ ok: true, known: true, open: false }); h.children[0].close(); await tick();
  h.children[1].output(domObserved()); h.children[1].close(); assert.equal((await pending).status, 'observed');
  const spawns = h.effects.filter(e => e[0] === 'spawn');
  assert.equal(spawns[0][2][0], 'dialog'); assert.equal(spawns[0][2].length, 5);
  assert.equal(spawns[1][2][0], 'eval'); assert.equal(spawns[1][2].length, 6);
  assert.equal(facts.filter(f => f.phase === 'spawn').every(f => f.argvValid), true);
  assert.deepEqual(facts.find(f => f.phase === 'validated').target, target);
}
test('audit facts copy target and actual argv without mutating delegate arguments or later evidence', async () => {
  await assertFactCopies();
});
test('safe native argv accepts all key orders and rejects token/title/toJSON content without changing spawn', async () => {
  const orders = keys => keys.length ? keys.flatMap(key => orders(keys.filter(k => k !== key)).map(rest => [key, ...rest])) : [[]];
  for (const keys of orders(Object.keys(target))) {
    const ordered = Object.fromEntries(keys.map(key => [key, target[key]])), facts = [];
    const h = harness({ getAudit: () => fact => facts.push(structuredClone(fact)) }); const pending = h.observe({ target: ordered });
    h.children[0].output({ ok: true, known: false }); h.children[0].close(); await pending;
    const fact = facts.find(f => f.phase === 'spawn'); assert.equal(fact.argvValid, true);
    assert.equal(fact.argv[4], JSON.stringify(ordered)); assert.deepEqual(fact.argv, h.effects[0][2]);
  }
  for (const mode of ['extra', 'toJSON']) {
    let reads = 0;
    const privateFields = { token: 'PRIVATE_TOKEN_FIXTURE', title: 'PRIVATE_TITLE_FIXTURE' };
    const supplied = mode === 'extra' ? { ...target, ...privateFields } : { ...target,
      toJSON() { reads++; return { ...target, ...privateFields }; } };
    const facts = [], h = harness({ getAudit: () => fact => facts.push(structuredClone(fact)) });
    const pending = h.observe({ target: supplied });
    assert.equal(h.effects[0][2][4], JSON.stringify({ ...target, ...privateFields }));
    assert.equal(reads, mode === 'toJSON' ? 1 : 0);
    h.children[0].output({ ok: true, known: false }); h.children[0].close(); await pending;
    assert.deepEqual(facts.find(f => f.phase === 'spawn').argv, null); assert.equal(facts.find(f => f.phase === 'spawn').argvValid, false);
    const serialized = JSON.stringify(facts);
    assert.equal(serialized.includes(privateFields.token), false); assert.equal(serialized.includes(privateFields.title), false);
  }
});
test('audit target projection never rereads original getters and singleton invalid-target facts are late-bound', async () => {
  const getterCounts = [];
  for (const enabled of [false, true]) {
    let reads = 0; const supplied = Object.fromEntries(Object.keys(target).map(key => [key, target[key]]));
    for (const key of Object.keys(target)) Object.defineProperty(supplied, key, { enumerable: true, get() { reads++; return target[key]; } });
    const h = harness({ getAudit: () => enabled ? () => {} : null }), pending = h.observe({ target: supplied });
    h.children[0].output({ ok: true, known: false }); h.children[0].close(); await pending; getterCounts.push(reads);
  }
  assert.equal(getterCounts[0], getterCounts[1]);
  assert.equal(typeof bridge.__setPagePromptObserverAuditForTests, 'function');
  const facts = [], opaqueSource = new Proxy({}, { get() { throw new Error('source must not be inspected'); } });
  let targetReads = 0; const invalid = { get chromePid() { targetReads++; throw new Error('invalid target getter'); } };
  try {
    bridge.__setPagePromptObserverAuditForTests(fact => facts.push(structuredClone(fact)));
    const result = await bridge.observePagePrompts({ target: invalid, source: opaqueSource });
    assert.equal(result.reason, 'target_unverified'); assert.equal(result.source, opaqueSource); assert.equal(targetReads, 1);
    assert.deepEqual(facts.map(f => f.phase), ['begin', 'rejected']); assertFactSchema(facts);
    bridge.__setPagePromptObserverAuditForTests(null);
    await bridge.observePagePrompts({ target: invalid, source: opaqueSource }); assert.equal(facts.length, 2); assert.equal(targetReads, 2);
    assert.throws(() => bridge.__setPagePromptObserverAuditForTests({}), TypeError);
  } finally { bridge.__setPagePromptObserverAuditForTests(null); }
});
test('signal reason and sink overflow failures cannot escape or convert abort into close proof', async () => {
  for (const enabled of [false, true]) {
    let reasonReads = 0; const facts = [], h = harness({ getAudit: () => enabled ? fact => facts.push(structuredClone(fact)) : null });
    Object.defineProperty(h.controller.signal, 'reason', { get() { reasonReads++; throw new Error('reason unavailable'); } });
    const pending = h.observe(); h.controller.abort('tool_start'); h.expire(250);
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.observer.busy(), true);
    assert.equal(reasonReads > 0, enabled); assert.equal(facts.some(f => f.phase === 'stop' || f.phase === 'close'), false);
    h.children[0].close(); await tick(); assert.equal(h.observer.busy(), false);
  }
  const facts = [], h = harness({ getAudit: () => fact => { if (facts.length === 2) throw new Error('bounded sink full'); facts.push(fact); } });
  const pending = h.observe(); h.children[0].output(nativeOpen()); h.children[0].close();
  assert.equal((await pending).status, 'observed'); assert.equal(facts.length, 2); assert.equal(h.observer.busy(), false);
  assert.equal(facts.some(f => f.phase === 'released'), false);
});
test('tool_start cancellation, other cancellation and dispose remain separate facts', async () => {
  for (const cause of ['tool_start', 'paused', 'disposed']) {
    const facts = [], h = harness({ getAudit: () => fact => facts.push(structuredClone(fact)) }), pending = h.observe();
    let disposed;
    if (cause === 'disposed') disposed = h.observer.dispose(); else h.controller.abort(cause);
    h.children[0].close(); assert.equal((await pending).status, 'cancelled'); if (disposed) await disposed;
    const stops = facts.filter(f => f.phase === 'stop');
    assert.equal(stops.length, cause === 'disposed' ? 1 : 2);
    assert.equal(stops.every(f => f.toolStart === (cause === 'tool_start')), true);
    assert.equal(stops[0].via, cause === 'disposed' ? 'dispose' : 'abort');
    assert.deepEqual(facts.slice(-2).map(f => f.phase), ['close', 'released']); assertFactSchema(facts);
  }
});
test('a zero-exit close does not claim JSON parsing or a valid native result', async () => {
  for (const output of ['not json', 'null', '{}', '{"ok":false}', '{"ok":true,"known":false}']) {
    const facts = [], h = harness({ getAudit: () => fact => facts.push(structuredClone(fact)) }), pending = h.observe();
    h.children[0].stdout.emit('data', Buffer.from(output)); h.children[0].close();
    assert.equal((await pending).status, 'unavailable'); assert.equal(facts.find(f => f.phase === 'close').code, 0);
    assert.equal(facts.some(f => f.phase === 'parsed'), output.includes('"ok":true'));
    assert.equal(facts.some(f => f.phase === 'render' || f.phase === 'dom_result'), false);
    assert.equal(facts.at(-1).phase, 'released'); assertFactSchema(facts);
  }
});
function inertFactory(mutator = text => text) {
  const text = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const targetSource = text.slice(text.indexOf('function dialogTarget('), text.indexOf('/** Read only.', text.indexOf('function dialogTarget(')));
  const factorySource = text.slice(text.indexOf('export function createPagePromptObserver('), text.indexOf('\nlet PAGE_PROMPT_OBSERVER_AUDIT'));
  assert.ok(factorySource.includes('const note = makeFact'));
  const unused = () => { throw new Error('No real executor is available in this source-mutant VM'); };
  return runInNewContext(`${targetSource}\n${mutator(factorySource).replace(/^export /, '')}\ncreatePagePromptObserver`, {
    spawn: unused, pageScript: unused, writeFile: unused, unlink: unused, CHROMECTL: '/inert/chromectl',
    // G2 r2: the factory's default gate source (block.js, read synchronously); inert here like pageScript's stand-ins.
    blockSource: () => 'JSON.stringify({ ok: true, blocked: null })',
    setTimeout, clearTimeout, Date, Promise, Object, Array, Number, String, JSON, Error, TypeError, Buffer, canonicalPromptOrigin,
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    path: { join: (...parts) => parts.join('/') }, os: { tmpdir: () => '/inert' },
    crypto: { randomBytes: size => Buffer.alloc(size, 1), createHash }
  });
}
function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length, 2, `unique mutation site: ${from}`); return text.replace(from, to);
}
test('the same fact, copy, late-close and sink-equivalence oracles reject four bounded source mutants', async () => {
  await assertNormalAudit(inertFactory()); await assertLateCloseAudit(inertFactory()); await assertFactCopies(inertFactory());
  const noParsed = inertFactory(text => replaceOnce(text,
    "note(() => ({ phase: 'parsed', attempt, child: childID, kind }));", ''));
  await assert.rejects(() => assertNormalAudit(noParsed), error => error.code === 'ERR_ASSERTION');
  const liveArgv = inertFactory(text => replaceOnce(text, 'return { argv: [...argv], argvValid: true };', 'return { argv, argvValid: true };'));
  await assert.rejects(() => assertFactCopies(liveArgv), error => error.code === 'ERR_ASSERTION');
  const earlyRelease = inertFactory(text => replaceOnce(text,
    "note(() => ({ phase: 'grace_expired', attempt, child: childID }));", "note(() => ({ phase: 'grace_expired', attempt, child: childID })); note(() => ({ phase: 'released', attempt }));"));
  await assert.rejects(() => assertLateCloseAudit(earlyRelease), error => error.code === 'ERR_ASSERTION');
  const throwingNote = inertFactory(text => replaceOnce(text,
    "} catch { /* Audit failures cannot change the observer's effects or outcome. */ }", '} catch (error) { throw error; }'));
  await assert.rejects(() => assertAuditEffectEquivalence(throwingNote), /audit getter failure/);
});
test('native completion after 750 ms remains alive and waits for close before normal DOM observation', async () => {
  const h = harness(), pending = h.observe();
  try {
    await h.advance(800);
    assert.equal(h.effects.some(e => e[0] === 'kill'), false, 'native read must survive the old 750 ms deadline');
    assert.equal(h.children.length, 1); assert.equal(h.effects.some(e => e[0] === 'readScript'), false);
    h.children[0].output({ ok: true, known: true, open: false }); await tick();
    assert.equal(h.children.length, 1); assert.equal(h.effects.some(e => e[0] === 'readScript'), false);
    h.children[0].close(); await tick(); assert.equal(h.children.length, 2);
    h.children[1].output({ ok: true, ...target, result: JSON.stringify({ ok: true, status: 'observed', complete: true, observations: [observation()] }) });
    h.children[1].close(); const result = await pending;
    assert.equal(result.status, 'observed'); assert.equal(result.complete, true);
    assert.equal(h.effects.some(e => e[0] === 'kill'), false); assert.equal(h.observer.busy(), false);
  } finally { for (const child of h.children) child.close(); await pending; }
});
test('DOM still times out at 1000 ms and owns its child until close', async () => {
  const h = harness(), pending = h.observe();
  h.children[0].output({ ok: true, known: true, open: false }); h.children[0].close(); await tick();
  assert.equal(h.children.length, 2); await h.advance(999);
  assert.equal(h.effects.some(e => e[0] === 'kill'), false);
  await h.advance(1); assert.equal(h.effects.filter(e => e[0] === 'kill').length, 1);
  assert.equal(h.observer.busy(), true); assert.equal(h.effects.some(e => e[0] === 'removeScript'), false);
  h.children[1].close(); const result = await pending;
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'observer_timeout');
  assert.equal(h.children.length, 2); assert.equal(h.observer.busy(), false);
  assert.equal(h.effects.filter(e => e[0] === 'removeScript').length, 1);
});
test('cold native close is mandatory before DOM child; exact fixed argv and temp survives until DOM close', async () => {
  const h = harness(), pending = h.observe(); assert.equal(h.children.length, 1);
  h.children[0].output({ ok: true, known: true, open: false }); await tick(); assert.equal(h.children.length, 1);
  assert.equal((await h.observe()).reason, 'child_not_settled');
  h.children[0].close(); await tick(); assert.equal(h.children.length, 2);
  assert.deepEqual(h.effects[0][2], ['dialog', '--pid', String(target.chromePid), '--target', JSON.stringify(target)]);
  const domArgs = h.effects.find(e => e[0] === 'spawn' && e[2][0] === 'eval')[2];
  assert.deepEqual(domArgs.slice(2), ['--pid', String(target.chromePid), '--tab', String(target.tabId)]);
  assert.equal(h.effects.some(e => e[0] === 'removeScript'), false);
  h.children[1].output({ ok: true, ...target, result: JSON.stringify({ ok: true, status: 'observed', complete: true, observations: [observation()] }) });
  await tick(); assert.equal(h.effects.some(e => e[0] === 'removeScript'), false);
  h.children[1].close(); assert.equal((await pending).status, 'observed'); assert.equal(h.observer.busy(), false);
  assert.equal(h.effects.filter(e => e[0] === 'removeScript').length, 1);
});
test('native open/unknown/ambiguous/failure never issues any DOM script or child', async () => {
  for (const reply of [{ ok: true, known: false }, { ok: false, error: 'dialog_ambiguous' }, {},
    { ok: true, known: true, open: true, identity, ...template, complete: true, hasField: false, origin: template.origins[0], originEvidence: 'native_current_snapshot' }]) {
    const h = harness(), pending = h.observe(); h.children[0].output(reply); h.children[0].close();
    const result = await pending; assert.equal(h.children.length, 1); assert.equal(h.effects.some(e => e[0] === 'readScript'), false);
    assert.equal(result.status, reply.open ? 'observed' : 'unavailable');
  }
});
test('oversized native arrays/full characters never retain complete authority by truncation', async () => {
  for (const patch of [{ texts: Array(33).fill('x') }, { texts: ['x'.repeat(4097)] }, { texts: Array(32).fill('x'.repeat(129)) },
    { title: 'x'.repeat(4097) }, { buttons: Array(9).fill('x') }, { buttons: ['x'.repeat(257)] }, { complete: false }]) {
    const h = harness(), pending = h.observe(); h.children[0].output({ ok: true, known: true, open: true, identity,
      title: template.title, texts: template.texts, buttons: template.buttons, hasField: false, complete: true, ...patch }); h.children[0].close();
    const result = await pending; assert.equal(result.status, 'observed'); assert.equal(result.complete, false);
    assert.equal(result.observations[0].complete, false); assert.deepEqual(result.observations[0].texts, []); assert.equal(h.children.length, 1);
  }
});
test('synchronous abort invalidates late output and never overlaps a child that has not closed', async () => {
  const h = harness(), pending = h.observe(); h.controller.abort('tool_start');
  assert.ok(h.effects.some(e => e[0] === 'kill')); assert.equal(h.observer.busy(), true);
  h.children[0].output({ ok: true, known: true, open: false }); assert.equal((await h.observe()).reason, 'child_not_settled');
  let ordinaryRan = false; await Promise.resolve().then(() => { ordinaryRan = true; }); assert.equal(ordinaryRan, true);
  h.expire(250); assert.equal((await pending).status, 'cancelled'); assert.equal(h.observer.busy(), true);
  assert.equal(h.children.length, 1); h.children[0].close(); await tick(); assert.equal(h.observer.busy(), false);
});
test('timeout/output overflow/no-close are explicit, terminal and never retried', async () => {
  for (const mode of ['timeout', 'stdout', 'stderr', 'bad-json', 'exit']) {
    const h = harness(), pending = h.observe(), c = h.children[0];
    if (mode === 'timeout') h.expire(5000);
    else if (mode === 'stdout' || mode === 'stderr') c[mode].emit('data', Buffer.alloc(65537, 65));
    else if (mode === 'bad-json') c.stdout.emit('data', Buffer.from('not json'));
    c.close(mode === 'exit' ? 1 : 0); const result = await pending;
    assert.equal(result.status, 'unavailable'); assert.equal(h.children.length, 1);
    assert.equal(result.reason, mode === 'timeout' ? 'observer_timeout' : ['stdout', 'stderr'].includes(mode) ? 'observer_output_limit' : mode === 'exit' ? 'observer_child_failed' : 'observer_result_unknown');
  }
  const h = harness(), pending = h.observe(); h.expire(5000); h.expire(250);
  assert.equal((await pending).reason, 'child_not_settled'); assert.equal(h.observer.busy(), true);
  assert.equal((await h.observe()).reason, 'child_not_settled'); h.children[0].close(); await tick(); assert.equal(h.observer.busy(), false);
});
test('an actual inert OS child with parseable output remains owned until real close', async () => {
  for (const mode of ['default', 'collect', 'off', 'getter-throws', 'sink-throws']) {
    let child, wrote; const facts = [], written = new Promise(resolve => { wrote = resolve; });
    const getAudit = mode === 'default' ? undefined : () => {
      if (mode === 'getter-throws') throw new Error('inert getter failure');
      if (mode === 'off') return null;
      return fact => { if (mode === 'sink-throws') throw new Error('inert sink failure'); facts.push(structuredClone(fact)); };
    };
    const observer = createPagePromptObserver({ nativeMs: 5000, getAudit,
      spawnChild: () => {
        child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ok:true,known:false})); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));'], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.once('data', wrote); return child;
      } });
    let settled = false; const pending = observer.observe({ source, target, namespace: 'inert' }).then(r => { settled = true; return r; });
    await written; await tick(); assert.equal(settled, false); assert.equal(observer.busy(), true);
    assert.equal(facts.some(f => f.phase === 'close' || f.phase === 'parsed'), false);
    assert.equal((await observer.observe({ source, target, namespace: 'inert' })).reason, 'child_not_settled');
    child.stdin.end(); assert.equal((await pending).reason, 'dialog_probe_unknown'); assert.equal(observer.busy(), false);
    if (mode === 'collect') assert.deepEqual(facts.slice(-4).map(f => f.phase), ['close', 'parsed', 'native_result', 'released']);
    else assert.equal(facts.length, 0);
  }
});
