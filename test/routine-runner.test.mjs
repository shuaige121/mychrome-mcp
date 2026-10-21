#!/usr/bin/env node
// Independent, deterministic runner acceptance: adapters are fakes; no Chrome or native input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutineRunner, pageMatches, routinePage } from '../src/routine-runner.js';

const ORIGIN = 'https://example.test';
const copy = value => structuredClone(value);
const page = (n = 0, path = '/form') => ({ origin: ORIGIN, path, fingerprint: String(n).padStart(64, '0') });
const target = (name = 'Continue') => ({ version: 1, tag: 'button', role: 'button', name });
const step = (tool = 'click', n = 0, extra = {}) => ({ tool, before: page(n), after: page(n + 1), target: target(), args: {}, ...extra });
const routine = (steps = [step()], extra = {}) => ({ id: 'routine-a', site: ORIGIN, name: 'Test flow', archived: false, steps, parameters: [], ...extra });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const coded = code => Object.assign(new Error(`private error details: ${code}`), { code });

function harness(saved = routine(), hooks = {}) {
  const h = { saved, page: copy(saved.steps?.[0]?.before ?? page()), actions: [], inspections: [], resolutions: [],
    messages: [], records: [], waits: [], getCount: 0, begins: 0, finishes: 0 };
  const store = {
    async get(id) { h.getCount++; return hooks.get ? hooks.get(h, id) : copy(saved); },
    async recordRun(record) { h.records.push(copy(record)); if (hooks.recordRun) await hooks.recordRun(h, record); }
  };
  const adapter = {
    async inspect(tab, options) {
      h.inspections.push({ tab, refresh: options.refresh });
      return hooks.inspect ? hooks.inspect(h, tab, options) : { page: copy(h.page) };
    },
    async resolve(tab, descriptor, options) {
      h.resolutions.push({ tab, descriptor: copy(descriptor), focused: options.focused, refresh: options.refresh });
      if (hooks.resolve) return hooks.resolve(h, tab, descriptor, options);
      const index = options.refresh ? h.actions.length - 1 : h.actions.length;
      const s = saved.steps[index];
      return { ok: true, marker: 100 + h.resolutions.length, targetState: copy((options.refresh ? s?.afterState : s?.targetState) ?? {}) };
    },
    async begin(run, value) { h.begins++; if (hooks.begin) await hooks.begin(h, run, value); },
    async act(tool, args, context) {
      h.actions.push({ tool, args: copy(args), descriptor: copy(context.descriptor), before: copy(context.before) });
      if (hooks.act) return hooks.act(h, tool, args, context);
      h.page = copy(saved.steps[h.actions.length - 1].after);
      return { ok: true };
    },
    async finish(run, result) { h.finishes++; if (hooks.finish) await hooks.finish(h, run, result); }
  };
  h.runner = createRoutineRunner({ store, adapter, onChange: value => h.messages.push(copy(value)),
    wait: async ms => { h.waits.push(ms); if (hooks.wait) await hooks.wait(h, ms); }, ...(hooks.options ?? {}) });
  h.request = extra => ({ id: saved.id, tab: 17, nonce: 'nonce-a', params: {}, ...extra });
  return h;
}

test('one call executes every mechanical step with fresh markers and one cleanup', async () => {
  const steps = [
    step('click', 0, { args: { marker: 999, text: 'RECORDED_SECRET', unknown: 'drop' } }),
    step('hover', 1),
    step('type_text', 2, { target: { ...target('Search'), tag: 'input', role: 'textbox' }, args: { textParam: 'input_1', submit: true, input_mode: 'keys', text: 'OLD_VALUE' } }),
    step('select_option', 3, { target: { ...target('Region'), tag: 'select', role: 'combobox' }, args: { valueParam: 'option_1', option: 'OLD_OPTION' } }),
    step('press_key', 4, { args: { key: 'enter', times: 2 } }),
    step('scroll', 5, { target: undefined, args: { direction: 'down', amount: 0.5 } })
  ];
  const h = harness(routine(steps, { parameters: [{ name: 'input_1', label: 'Search' }, { name: 'option_1', label: 'Region' }] }));
  const result = await h.runner.run(h.request({ params: { input_1: 'NEW_PRIVATE_VALUE', option_1: 'SG' } }));
  assert.equal(result.status, 'completed');
  assert.equal(result.completed, 6);
  assert.deepEqual(h.actions.map(x => x.tool), steps.map(x => x.tool));
  assert.deepEqual(h.actions.slice(0, 4).map(x => x.args.marker), [101, 102, 103, 104]);
  assert.equal(h.resolutions[4].focused, true);
  assert.deepEqual(h.actions[4].args, { tab: 17, key: 'enter', times: 2 });
  assert.deepEqual(h.actions[5].args, { tab: 17, direction: 'down', amount: 0.5 });
  assert.equal(h.actions[2].args.text, 'NEW_PRIVATE_VALUE');
  assert.equal(h.actions[2].args.input_mode, 'keys', 'recorded mode is the fallback when GUI mode is auto; gui-input-settings tests cover explicit GUI precedence');
  assert.equal(h.actions[3].args.option, 'SG');
  assert.equal(h.begins, 1);
  assert.equal(h.finishes, 1);
  assert.equal(h.inspections.filter(x => x.refresh).length, 7);
  assert.ok(!JSON.stringify(h.actions).includes('RECORDED_SECRET'));
  assert.ok(!JSON.stringify(h.actions).includes('OLD_VALUE'));
  assert.ok(!JSON.stringify([result, h.messages, h.records, h.runner.busy()]).includes('NEW_PRIVATE_VALUE'));
  assert.equal(h.records.length, 1);
  assert.deepEqual(Object.keys(h.records[0]).sort(), ['code', 'completed', 'id', 'status', 'total']);
});

test('exact origin, route, query and fingerprint mismatch stops before any input', async () => {
  const before = { ...page(), queryHash: 'a'.repeat(64) };
  for (const wrong of [
    { ...before, origin: 'http://example.test' }, { ...before, path: '/other' },
    { ...before, queryHash: 'b'.repeat(64) }, { ...before, queryHash: undefined },
    { ...before, fingerprint: 'f'.repeat(64) }
  ]) {
    const h = harness(routine([step('click', 0, { before })]), { inspect: async () => ({ page: wrong }) });
    const result = await h.runner.run(h.request());
    assert.equal(result.code, 'wrong_page');
    assert.equal(result.completed, 0);
    assert.equal(h.actions.length, 0);
    assert.equal(h.begins, 0);
    assert.equal(h.finishes, 0);
  }
});

test('a page changed between initial inspection and the first step is refused', async () => {
  const h = harness(routine(), { inspect: async h => ({ page: h.inspections.length === 1 ? page() : page(0, '/changed') }) });
  const result = await h.runner.run(h.request());
  assert.equal(result.code, 'page_changed');
  assert.equal(h.actions.length, 0);
  assert.equal(h.begins, 1);
  assert.equal(h.finishes, 1);
});

test('ambiguous targets, invalid markers and changed target state refuse before input', async () => {
  for (const resolution of [
    { ok: false, reason: 'target_ambiguous' }, { ok: true, marker: 0 },
    { ok: true, marker: 1, targetState: { disabled: true } }
  ]) {
    const h = harness(routine([step('click', 0, { targetState: { disabled: false } })]), { resolve: async () => resolution });
    const result = await h.runner.run(h.request());
    assert.equal(result.status, 'blocked');
    assert.equal(h.actions.length, 0);
    assert.equal(h.finishes, 1);
  }
});

test('uncertain input is never retried and subsequent steps never execute', async () => {
  for (const failure of [async () => ({ ok: false, code: 'delivery_unconfirmed' }), async () => { throw coded('unconfirmed_input'); }]) {
    const h = harness(routine([step(), step('click', 1)]), { act: failure });
    const result = await h.runner.run(h.request());
    assert.equal(result.status, 'blocked');
    assert.equal(result.completed, 0);
    assert.equal(h.actions.length, 1);
    assert.equal(h.waits.length, 0);
    assert.equal(h.finishes, 1);
    await h.runner.run(h.request());
    assert.equal(h.actions.length, 1, 'the same nonce never delivers uncertain input twice');
  }
});

test('failed postcondition only polls reads and never repeats the sent click', async () => {
  const h = harness(routine([step(), step('click', 1)]), { act: async () => ({ ok: true }) });
  const result = await h.runner.run(h.request());
  assert.equal(result.code, 'postcondition_failed');
  assert.equal(h.actions.length, 1);
  assert.equal(h.inspections.filter(x => !x.refresh).length, 8);
  assert.equal(h.waits.length, 7);
  assert.equal(h.finishes, 1);
});

test('type/select confirmation ignores variable text fingerprints but still requires the route', async () => {
  for (const tool of ['type_text', 'select_option']) {
    const key = tool === 'type_text' ? 'textParam' : 'valueParam';
    const h = harness(routine([step(tool, 0, { args: { [key]: 'input_1' } })], { parameters: [{ name: 'input_1', label: 'Input' }] }), {
      act: async h => { h.page = { ...page(1), fingerprint: 'f'.repeat(64) }; return { ok: true }; }
    });
    assert.equal((await h.runner.run(h.request({ params: { input_1: 'DIFFERENT_VALUE' } }))).status, 'completed');
  }
  const h = harness(routine([step('type_text', 0, { args: { textParam: 'input_1' } })], { parameters: [{ name: 'input_1', label: 'Input' }] }), {
    act: async h => { h.page = page(1, '/wrong'); return { ok: true }; }
  });
  assert.equal((await h.runner.run(h.request({ params: { input_1: 'VALUE' } }))).code, 'postcondition_failed');
  assert.equal(h.actions.length, 1);
});

test('pending nonce duplicates share one lookup and one execution; changed parameters conflict', async () => {
  const gate = deferred();
  const h = harness(routine(), { get: async () => gate.promise });
  const a = h.runner.start(h.request());
  const b = h.runner.start(h.request());
  assert.equal(h.getCount, 1);
  assert.equal(h.runner.status({ nonce: 'nonce-a' }).status, 'running');
  await assert.rejects(h.runner.start(h.request({ tab: 18 })), { code: 'nonce_conflict' });
  gate.resolve(copy(h.saved));
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.runId, second.runId);
  assert.equal((await h.runner.run(h.request())).status, 'completed');
  assert.equal(h.actions.length, 1);
});

test('pending cancellation is durable for that nonce and sends no input', async () => {
  const gate = deferred();
  const h = harness(routine(), { get: async () => gate.promise });
  const pending = h.runner.start(h.request());
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  assert.equal(h.runner.cancel({ nonce: 'nonce-a' }).status, 'running');
  gate.resolve(copy(h.saved));
  await rejected;
  assert.equal(h.runner.status({ nonce: 'nonce-a' }).status, 'cancelled');
  assert.equal(h.runner.status({ nonce: 'nonce-a' }).delivery, 'not_sent');
  await assert.rejects(h.runner.start(h.request()), { code: 'cancelled' });
  assert.equal(h.actions.length, 0);
  assert.equal(h.begins, 0);
});

test('active cancellation remains running until input and cleanup both finish', { timeout: 3000 }, async () => {
  const input = deferred(), cleanup = deferred(), entered = deferred();
  const h = harness(routine([step(), step('click', 1)]), {
    act: async () => { entered.resolve(); return input.promise; },
    finish: async () => cleanup.promise
  });
  const started = await h.runner.start(h.request());
  await entered.promise;
  const resultPromise = h.runner.run(h.request());
  h.runner.cancel({ runId: started.runId });
  assert.equal(h.runner.status({ runId: started.runId }).status, 'running');
  input.resolve({ ok: true });
  await tick();
  assert.equal(h.finishes, 1);
  assert.equal(h.runner.status({ runId: started.runId }).status, 'running');
  assert.equal(h.runner.busy().runId, started.runId);
  assert.equal(h.records.length, 0);
  cleanup.resolve();
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(h.actions.length, 1);
  assert.equal(h.runner.busy(), null);
});

test('a cancellation accepted during cleanup does not later claim completed', { timeout: 3000 }, async () => {
  const cleanup = deferred(), entered = deferred();
  const h = harness(routine(), { finish: async () => { entered.resolve(); await cleanup.promise; } });
  const started = await h.runner.start(h.request());
  await entered.promise;
  const resultPromise = h.runner.run(h.request());
  assert.equal(h.runner.cancel({ runId: started.runId }).status, 'running');
  cleanup.resolve();
  assert.equal((await resultPromise).status, 'cancelled');
});

test('cleanup failure is explicit and a recording failure exposes no raw error', async () => {
  const h = harness(routine(), { finish: async () => { throw new Error('PRIVATE_CLEANUP_DETAIL'); }, recordRun: async () => { throw new Error('PRIVATE_STORAGE_DETAIL'); } });
  const result = await h.runner.run(h.request());
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'cleanup_unconfirmed');
  assert.equal(result.recordingWarning, true);
  assert.ok(!JSON.stringify([result, h.messages]).includes('PRIVATE_'));
});

test('invalid requests, missing parameters and dangerous parameter keys never reach adapters', async () => {
  const r = routine([step('type_text', 0, { args: { textParam: 'input_1' } })], { parameters: [{ name: 'input_1', label: 'Input' }] });
  for (const patch of [
    { tab: 0 }, { nonce: '../bad' }, { params: [] }, { params: {} }, { params: { input_1: '' } },
    { params: { input_1: ' ' } }, { params: { input_1: 'a'.repeat(20001) } },
    { params: { input_1: 'ok', unknown: 'PRIVATE' } }, { params: JSON.parse('{"input_1":"ok","__proto__":"PRIVATE"}') }
  ]) {
    const h = harness(r);
    await assert.rejects(h.runner.start(h.request(patch)));
    assert.equal(h.inspections.length, 0);
    assert.equal(h.actions.length, 0);
  }
});

test('invalid routine structure and missing focused key target refuse before adapters', async () => {
  for (const bad of [
    routine([], {}), routine([step()], { archived: true }), routine([step('unknown')]),
    routine([step('press_key', 0, { target: undefined, args: { key: 'enter' } })]),
    routine([step('press_key', 0, { args: { key: 'enter', times: 21 } })]),
    routine([step('scroll', 0, { target: undefined, args: { direction: 'down', amount: 0.01 } })]),
    routine([step('click', 0, { after: { ...page(1), origin: 'https://other.test' } })])
  ]) {
    const h = harness(bad);
    await assert.rejects(h.runner.start(h.request()), { code: 'invalid_routine' });
    assert.equal(h.inspections.length, 0);
  }
});

test('no-op recorded clicks without a changed page or target state are refused before input', async () => {
  const h = harness(routine([step('click', 0, { after: page() })]));
  await assert.rejects(h.runner.run(h.request()), { code: 'unconfirmed_click' });
  assert.equal(h.actions.length, 0);
});

test('a recorded focus change makes a same-page click verifiable', async () => {
  const h = harness(routine([step('click', 0, { after: page(), targetState: { focused: false }, afterState: { focused: true } })]));
  assert.equal((await h.runner.run(h.request())).status, 'completed');
  assert.equal(h.resolutions.at(-1).refresh, true);
  assert.equal(h.actions.length, 1);
});

test('page helpers retain hashes and never expose visible text in the fingerprint', () => {
  const p = routinePage({ page: { origin: ORIGIN, path: '/form', queryHash: 'a'.repeat(64) }, view: ['PRIVATE_HEADING_TEXT'] });
  assert.match(p.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(p.queryHash, 'a'.repeat(64));
  assert.ok(!JSON.stringify(p).includes('PRIVATE_HEADING_TEXT'));
  assert.equal(pageMatches(p, { ...p, queryHash: 'b'.repeat(64) }), false);
  assert.throws(() => routinePage({ replayable: false, reason: 'site_blocked', page: p }), { code: 'site_blocked' });
});

test('a different nonce cannot start while the first run is waiting for cleanup', { timeout: 3000 }, async () => {
  const entered = deferred(), cleanup = deferred();
  const h = harness(routine(), { finish: async () => { entered.resolve(); await cleanup.promise; } });
  await h.runner.start(h.request());
  await entered.promise;
  await assert.rejects(h.runner.start(h.request({ nonce: 'nonce-b' })), { code: 'routine_busy' });
  assert.equal(h.actions.length, 1);
  cleanup.resolve();
  assert.equal((await h.runner.run(h.request())).status, 'completed');
});

test('query-only navigation is a verifiable click outcome and still uses exact query identity', async () => {
  const h = harness(routine([step('click', 0, {
    before: { ...page(), queryHash: 'a'.repeat(64) },
    after: { ...page(), queryHash: 'b'.repeat(64) }
  })]));
  assert.equal((await h.runner.run(h.request())).status, 'completed');
  assert.equal(h.actions.length, 1);
});

test('a promised target-state change must actually be observed after the action', async () => {
  const h = harness(routine([step('click', 0, { after: page(), targetState: { checked: false }, afterState: { checked: true } })]), {
    resolve: async () => ({ ok: true, marker: 17, targetState: { checked: false } })
  });
  const result = await h.runner.run(h.request());
  assert.equal(result.code, 'postcondition_failed');
  assert.equal(result.completed, 0);
  assert.equal(h.actions.length, 1);
});

test('pending parameters are snapshotted so the nonce identifies exactly what will be sent', async () => {
  const gate = deferred();
  const r = routine([step('type_text', 0, { args: { textParam: 'input_1' } })], { parameters: [{ name: 'input_1', label: 'Input' }] });
  const h = harness(r, { get: async () => gate.promise });
  const params = { input_1: 'ORIGINAL_PRIVATE_VALUE' };
  const first = h.runner.start(h.request({ params }));
  params.input_1 = 'MUTATED_PRIVATE_VALUE';
  gate.resolve(copy(r));
  await first;
  const result = await h.runner.run(h.request({ params: { input_1: 'ORIGINAL_PRIVATE_VALUE' } }));
  assert.equal(result.status, 'completed');
  assert.equal(h.actions[0].args.text, 'ORIGINAL_PRIVATE_VALUE');
  assert.ok(!JSON.stringify([result, h.records, h.messages]).includes('PRIVATE_VALUE'));
});

test('terminal receipts survive a worker handover without replaying a lost response', async () => {
  const saved = routine([step('type_text', 0, { args: { textParam: 'input_1' } })], { parameters: [{ name: 'input_1', label: 'Input' }] });
  const old = harness(saved);
  const request = old.request({ params: { input_1: 'PRIVATE_RUNTIME_VALUE' } });
  const completed = await old.runner.run(request);
  const carry = JSON.parse(JSON.stringify(old.runner.exportCarry()));
  assert.ok(!JSON.stringify(carry).includes('PRIVATE_RUNTIME_VALUE'));
  assert.ok(!JSON.stringify(carry).includes('params'));
  const fresh = harness(saved);
  assert.equal(fresh.runner.importCarry(carry), 1);
  assert.deepEqual(await fresh.runner.start(request), completed);
  assert.deepEqual(await fresh.runner.run(request), completed);
  assert.deepEqual(fresh.runner.status({ nonce: request.nonce }), completed);
  assert.deepEqual(fresh.runner.cancel({ runId: completed.runId }), completed);
  assert.equal(fresh.getCount, 0);
  assert.equal(fresh.actions.length, 0);
  assert.equal(fresh.records.length, 0);
  await assert.rejects(fresh.runner.start({ ...request, params: { input_1: 'DIFFERENT' } }), { code: 'nonce_conflict' });
  const next = harness(saved);
  assert.equal(next.runner.importCarry(fresh.runner.exportCarry()), 1);
  assert.equal((await next.runner.run(request)).runId, completed.runId);
  assert.equal(next.actions.length, 0, 'a second worker handover preserves the same receipt');
});

test('blocked and failed-start receipts survive handover without rechecking or repeating input', async () => {
  const old = harness(routine(), { act: async () => ({ ok: false, code: 'delivery_unconfirmed' }) });
  const blocked = await old.runner.run(old.request());
  const fresh = harness();
  fresh.runner.importCarry(old.runner.exportCarry());
  assert.deepEqual(await fresh.runner.run(old.request()), blocked);
  assert.equal(fresh.actions.length, 0);
  const failed = harness(routine(), { get: async () => { throw coded('routine_not_found'); } });
  await assert.rejects(failed.runner.start(failed.request()), { code: 'routine_not_found' });
  const changedStore = harness();
  changedStore.runner.importCarry(failed.runner.exportCarry());
  await assert.rejects(changedStore.runner.run(failed.request()), { code: 'routine_not_found' });
  assert.equal(changedStore.runner.status({ nonce: 'nonce-a' }).delivery, 'not_sent');
  assert.equal(changedStore.getCount, 0, 'a now-valid routine must not revive a rejected start');
});

test('handover refuses pending lookup and active cleanup without losing nonce state', async () => {
  const lookup = deferred(), cleanup = deferred(), finishing = deferred();
  const h = harness(routine(), { get: () => lookup.promise, finish: async () => { finishing.resolve(); await cleanup.promise; } });
  const started = h.runner.start(h.request());
  assert.equal(h.runner.busy(), null);
  assert.equal(h.runner.hasPending(), true);
  assert.throws(() => h.runner.exportCarry(), { code: 'routine_busy' });
  lookup.resolve(copy(h.saved));
  await started;
  await finishing.promise;
  assert.equal(h.runner.hasPending(), false);
  assert.throws(() => h.runner.exportCarry(), { code: 'routine_busy' });
  cleanup.resolve();
  await h.runner.run(h.request());
  assert.equal(h.runner.exportCarry().entries.length, 1);
});

test('invalid or oversized carry is rejected atomically without accepting partial receipts', async () => {
  const old = harness();
  await old.runner.run(old.request());
  const valid = old.runner.exportCarry();
  const invalid = [
    { ...copy(valid), version: 2 },
    { ...copy(valid), params: { private: 'DO_NOT_IMPORT' } },
    { version: 1, entries: [valid.entries[0], valid.entries[0]] },
    { version: 1, entries: [{ ...valid.entries[0], signature: 'not-a-hash' }] },
    ...[
      { status: 'running' }, { runId: 'invalid' }, { nonce: 'different' }, { completed: 2 },
      { total: 51 }, { step: 0 }, { code: 'cancelled' }, { code: 'RAW PRIVATE ERROR' },
      { message: 'PRIVATE_TERMINAL_TEXT' }, { params: { private: 'DO_NOT_IMPORT' } },
    ].map(patch => ({ version: 1, entries: [{ ...copy(valid.entries[0]), receipt: { ...valid.entries[0].receipt, ...patch } }] })),
  ];
  for (const bad of invalid) {
    const fresh = harness();
    assert.throws(() => fresh.runner.importCarry(bad), { code: 'invalid_routine_carry' });
    assert.throws(() => fresh.runner.status({ nonce: 'nonce-a' }), { code: 'run_not_found' });
    assert.equal(fresh.runner.importCarry(valid), 1, 'rejection must not partially mutate the ledger');
  }
  const full = harness(routine(), { options: { maxRuns: 0 } });
  assert.throws(() => full.runner.importCarry(valid), { code: 'invalid_routine_carry' });
  const occupied = harness();
  await occupied.runner.run(occupied.request({ nonce: 'local-intent' }));
  assert.throws(() => occupied.runner.importCarry(valid), { code: 'routine_busy' });
  assert.equal(occupied.runner.status({ nonce: 'local-intent' }).status, 'completed');
});

test('imported receipts keep the original nonce capacity rather than evicting old intentions', async () => {
  const old = harness();
  await old.runner.run(old.request());
  const fresh = harness(routine(), { options: { maxRuns: 1 } });
  fresh.runner.importCarry(old.runner.exportCarry());
  await assert.rejects(fresh.runner.start(fresh.request({ nonce: 'another-intent' })), { code: 'capacity_reached' });
  assert.equal((await fresh.runner.run(old.request())).status, 'completed');
  assert.equal(fresh.actions.length, 0);
});

test('cancelled and cleanup-failed receipts retain their terminal result after handover', async () => {
  for (const failure of ['cancelled', 'cleanup_unconfirmed']) {
    const h = harness(routine(), failure === 'cancelled'
      ? { act: async () => { throw coded('cancelled'); } }
      : { finish: async () => { throw coded('cleanup_unconfirmed'); }, recordRun: async () => { throw coded('unavailable'); } });
    const terminal = await h.runner.run(h.request());
    const fresh = harness();
    fresh.runner.importCarry(h.runner.exportCarry());
    assert.deepEqual(await fresh.runner.run(h.request()), terminal);
    assert.deepEqual(fresh.runner.cancel({ nonce: 'nonce-a' }), terminal);
    assert.equal(fresh.actions.length, 0);
  }
});

test('a fresh worker without a carry reports unknown and never recovers by starting', () => {
  const h = harness();
  assert.equal(h.runner.importCarry(undefined), 0);
  assert.throws(() => h.runner.status({ nonce: 'lost-worker-intent' }), { code: 'run_not_found' });
  assert.throws(() => h.runner.cancel({ nonce: 'lost-worker-intent' }), { code: 'run_not_found' });
  assert.equal(h.getCount, 0);
  assert.equal(h.actions.length, 0);
});

test('cancellation after a native operation error retains its truthful stop receipt', async () => {
  const h = harness(routine(), { act: async (_h, _tool, _args, { run }) => {
    run.controller.abort();
    throw coded('session_closed');
  } });
  const terminal = await h.runner.run(h.request());
  assert.equal(terminal.status, 'cancelled');
  const fresh = harness();
  fresh.runner.importCarry(h.runner.exportCarry());
  assert.deepEqual(await fresh.runner.run(h.request()), terminal);
  assert.equal(fresh.actions.length, 0);
});

test('caller cancellation cannot cancel a pending nonce with another request body', async () => {
  const lookup = deferred();
  const saved = routine([step('type_text', 0, { args: { textParam: 'a' } })], {
    parameters: [{ name: 'a', label: 'First' }, { name: 'b', label: 'Second' }],
  });
  const h = harness(saved, { get: () => lookup.promise });
  const request = h.request({ params: { a: 'PRIVATE_A', b: 'PRIVATE_B' } });
  const pending = h.runner.start(request);
  for (const patch of [{ id: 'another-routine' }, { tab: 18 }, { params: { a: 'OTHER', b: 'PRIVATE_B' } }]) {
    assert.throws(() => h.runner.cancelRequest({ ...request, ...patch }), { code: 'nonce_conflict' });
    assert.equal(h.runner.status({ nonce: request.nonce }).message, '正在检查流程');
  }
  assert.throws(() => h.runner.cancelRequest({ ...request, nonce: 'unknown-intent' }), { code: 'run_not_found' });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  h.runner.cancelRequest({ ...request, params: { b: 'PRIVATE_B', a: 'PRIVATE_A' } });
  lookup.resolve(copy(saved));
  await rejected;
  assert.equal(h.actions.length, 0);
  assert.ok(!JSON.stringify(h.runner.exportCarry()).includes('PRIVATE_'));
});

test('caller cancellation verifies the signature before touching an active run', async () => {
  const input = deferred(), entered = deferred();
  let signal;
  const h = harness(routine(), { act: async (_h, _tool, _args, context) => {
    signal = context.signal; entered.resolve(); return input.promise;
  } });
  const request = h.request();
  await h.runner.start(request);
  await entered.promise;
  assert.throws(() => h.runner.cancelRequest({ ...request, tab: 18 }), { code: 'nonce_conflict' });
  assert.equal(signal.aborted, false);
  h.runner.cancelRequest(request);
  assert.equal(signal.aborted, true);
  input.resolve({ ok: true });
  assert.equal((await h.runner.run(request)).status, 'cancelled');
  assert.equal(h.actions.length, 1);
  const fresh = harness();
  fresh.runner.importCarry(h.runner.exportCarry());
  assert.throws(() => fresh.runner.cancelRequest({ ...request, id: 'another-routine' }), { code: 'nonce_conflict' });
  assert.equal(fresh.runner.cancelRequest(request).status, 'cancelled');
  assert.equal(fresh.actions.length, 0);
});
