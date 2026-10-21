// Controller + real isolated persistence only: no browser, helper, model or user files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRoutineIntegration } from '../src/routine-integration.js';
import { createRoutineStore } from '../src/routines.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'mychrome-routine-integration-'));
let sequence = 0;
const observed = () => ({ observation: { noteable: true, since: 1, untouched: async () => true } });
const initial = () => ({ ok: true, replayable: true, page: { origin: 'https://fixture.test', path: '/form' },
  view: [{ role: 'heading', name: 'Form' }], descriptor: { version: 1, tag: 'input', role: 'textbox', name: 'Search', id: 'search', type: 'text' },
  targetState: { disabled: false, focused: false } });
function fixture() {
  const dir = path.join(root, `case-${++sequence}`), store = createRoutineStore({ dir, sessionId: 'synthetic-session' });
  const fault = new Set(), hooks = new Map(), calls = [], adapter = { capture: async (tab, request) => {
    calls.push({ tab, mode: request.mode });
    if (fault.has('capture')) throw Error('Synthetic capture failure');
    return structuredClone(state);
  } };
  let state = initial(), enabled = true;
  const proxy = new Proxy(store, { get(target, key) {
    if (typeof target[key] !== 'function') return target[key];
    return async (...args) => { await hooks.get(key)?.(...args); if (fault.has(key)) throw Error(`Synthetic ${key} failure`); return target[key](...args); };
  } });
  const integration = createRoutineIntegration({ adapter, store: proxy, recording: () => enabled });
  return { dir, store, fault, hooks, calls, integration, adapter, state: () => state, set: value => { state = value; }, enabled: value => { enabled = value; },
    async action({ tool = 'type_text', tab = 7, args = {}, evidence, mutate, failed = false, isError = false } = {}) {
      const context = { routineAttempt: { tool, args: { tab, marker: 1, text: 'SYNTHETIC_TYPED_PRIVATE_987654', ...args } },
        ...(evidence ? { routineEvidence: evidence } : {}), failed };
      await integration.beforeInput(context, tab);
      if (mutate) mutate(state);
      await integration.afterInput(context, { isError }, observed());
      return context;
    },
    async events() { return (await store.snapshot()).events.toSorted((a, b) => a.seq - b.seq); },
  };
}

async function noGap(f, first, last) {
  await assert.rejects(f.store.save({ name: 'Must not span gap', eventIds: [first.id, last.id] }), { code: 'routine_gap' });
  const candidates = (await f.store.snapshot()).candidates;
  assert.ok(candidates.every(candidate => !candidate.eventIds.includes(first.id) || !candidate.eventIds.includes(last.id)));
}

test('input and selection are parameters; values never reach the real store or saved routine', async () => {
  const f = fixture();
  await f.action();
  f.set({ ...initial(), descriptor: { version: 1, tag: 'select', role: 'combobox', name: 'Region', id: 'region' } });
  await f.action({ tool: 'select_option', args: { option: 'SYNTHETIC_SELECTION_PRIVATE_987654' } });
  const events = await f.events();
  const saved = await f.integration.query({ action: 'save', name: 'Search and region', eventIds: events.map(e => e.id) });
  assert.deepEqual(saved.parameters.map(p => p.name), ['input_1', 'option_1']);
  assert.deepEqual(saved.steps.map(s => Object.keys(s.args).filter(k => /Param$/.test(k))), [['textParam'], ['valueParam']]);
  const contents = await readFile(path.join(f.dir, 'state.json'), 'utf8');
  assert.doesNotMatch(contents, /SYNTHETIC_TYPED_PRIVATE|SYNTHETIC_SELECTION_PRIVATE|"(?:view|value|text)"\s*:/);
});

test('click acknowledgement alone is not a replayable postcondition', async () => {
  const f = fixture();
  await f.action({ tool: 'click', evidence: { confirmed: true } });
  const [event] = await f.events();
  assert.equal(event.ok, true); assert.equal(event.replayable, false);
  await assert.rejects(f.store.save({ name: 'No change', eventIds: [event.id] }), { code: 'routine_barrier' });
});

test('sensitive capture remains a barrier and raw values are never persisted', async () => {
  const f = fixture();
  f.set({ ...initial(), sensitive: true, replayable: false, descriptor: { version: 1, tag: 'input', role: 'textbox', name: '', type: 'password' } });
  await f.action();
  const [event] = await f.events(); assert.equal(event.replayable, false); assert.equal('target' in event, false);
  assert.doesNotMatch(await readFile(path.join(f.dir, 'state.json'), 'utf8'), /SYNTHETIC_TYPED_PRIVATE/);
});

for (const [name, mutate] of [
  ['path', state => { state.page.path = '/next'; }],
  ['query', state => { state.page.queryHash = 'b'.repeat(64); }],
  ['view', state => { state.view = [{ role: 'dialog', name: 'Choose course' }]; }],
  ['focused', state => { state.targetState.focused = true; }],
]) test(`confirmed click with changed ${name} can be reused`, async () => {
  const f = fixture(); await f.action({ tool: 'click', evidence: { confirmed: true }, mutate });
  assert.equal((await f.events())[0].replayable, true);
});

test('missing click confirmation and newly absent target state cannot count as change', async () => {
  const f = fixture();
  await f.action({ tool: 'click', mutate: state => { state.page.path = '/next'; } });
  assert.equal((await f.events())[0].replayable, false);
  f.set(initial());
  await f.action({ tool: 'click', evidence: { confirmed: true }, mutate: state => { delete state.targetState.focused; } });
  assert.equal((await f.events())[1].replayable, false);
});

test('capture failure fences successful ordinary input without changing its result', async () => {
  const f = fixture(); await f.action();
  f.fault.add('capture'); await f.action(); f.fault.clear(); await f.action();
  const events = await f.events();
  assert.equal(events.filter(e => e.replayable).length, 2);
  assert.ok(events.some(e => !e.replayable));
  await noGap(f, events[0], events.at(-1));
  assert.equal(f.integration.recordingError(), false);
});

test('dirty stream survives failed barrier persistence and recovery cannot bridge over missed actions', async () => {
  const f = fixture(); await f.action();
  f.fault.add('capture'); f.fault.add('record'); await f.action();
  assert.equal(f.integration.recordingError(), true);
  f.fault.delete('capture'); await f.action(); // still cannot persist a barrier
  assert.equal((await f.events()).filter(e => e.replayable).length, 1);
  f.fault.clear(); await f.action();
  const events = await f.events(); await noGap(f, events[0], events.at(-1));
  assert.equal(f.integration.recordingError(), false);
});

for (const method of ['snapshot', 'begin', 'finish']) test(`${method} failure does not disappear from the recovered recording stream`, async () => {
  const f = fixture(); await f.action(); f.fault.add(method); await f.action(); f.fault.clear(); await f.action();
  const events = await f.events(); await noGap(f, events[0], events.at(-1));
  assert.ok(events.slice(1, -1).some(e => !e.replayable));
});

test('a first-action recording failure is fenced once a safe page becomes available', async () => {
  const f = fixture(); f.fault.add('capture'); await f.action(); f.fault.clear(); await f.action();
  const events = await f.events(); assert.equal(events.length, 2);
  assert.equal(events[0].replayable, false); assert.equal(events[1].replayable, true);
});

test('another tab finishing cannot clear the broken stream or let it resume without a barrier', async () => {
  const f = fixture(); await f.action(); f.fault.add('capture'); f.fault.add('record'); await f.action();
  f.fault.delete('capture'); await f.action({ tab: 8 });
  assert.equal(f.integration.recordingError(), true);
  f.fault.clear(); await f.action();
  const events = (await f.events()).filter(e => e.tab === 7); await noGap(f, events[0], events.at(-1));
});

test('a delayed successful barrier cannot clear a newer failed barrier in the same stream', async () => {
  const f = fixture(); await f.action();
  let release, started, writes = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const entering = new Promise(resolve => { started = resolve; });
  f.hooks.set('record', async () => { if (++writes === 1) { started(); await pending; } else throw Error('Newer barrier failed'); });
  const first = f.integration.barrier(7); await entering;
  await f.integration.barrier(7); release(); await first;
  assert.equal(f.integration.recordingError(), true);
  f.hooks.clear(); await f.action();
  const events = await f.events(); assert.equal(events.filter(e => !e.replayable).length, 2);
  await noGap(f, events[0], events.at(-1));
  assert.equal(f.integration.recordingError(), false);
});

test('recording callback and persisted disable both fence actions across re-enable', async () => {
  for (const persisted of [false, true]) {
    const f = fixture(); await f.action();
    if (persisted) await f.integration.query({ action: 'settings', enabled: false }); else f.enabled(false);
    const calls = f.calls.length; await f.action(); assert.equal(f.calls.length, calls);
    if (persisted) await f.integration.query({ action: 'settings', enabled: true }); else f.enabled(true);
    await f.action(); const events = await f.events(); await noGap(f, events[0], events.at(-1));
  }
});

test('interruption and failed actions remain barriers and do not add post-action page probes', async () => {
  for (const flags of [{ failed: true }, { isError: true }, { evidence: { ok: false, code: 'user_cancelled' } }]) {
    const f = fixture(); await f.action(); const calls = f.calls.length;
    await f.action(flags); assert.equal(f.calls.length, calls + 1);
    await f.action(); const events = await f.events(); await noGap(f, events[0], events.at(-1));
    assert.equal(events[1].ok, false);
  }
});

test('uncompleted begin survives a new controller as an interrupted barrier', async () => {
  const f = fixture(); await f.action();
  await f.integration.beforeInput({ routineAttempt: { tool: 'type_text', args: { tab: 7, marker: 1 } } }, 7);
  const fresh = createRoutineIntegration({ store: f.store, adapter: f.adapter });
  const context = { routineAttempt: { tool: 'type_text', args: { tab: 7, marker: 1 } } };
  await fresh.beforeInput(context, 7); await fresh.afterInput(context, {}, observed());
  const events = await f.events(); assert.equal(events[1].reason, 'in_progress');
  await noGap(f, events[0], events.at(-1));
});

test('Escape and answer_dialog write a barrier without any browser metadata probe', async () => {
  for (const tool of ['press_key', 'answer_dialog']) {
    const f = fixture(); await f.action(); const calls = f.calls.length;
    await f.action({ tool, args: { key: 'escape' } }); assert.equal(f.calls.length, calls);
    await f.action(); const events = await f.events(); await noGap(f, events[0], events.at(-1));
  }
});

test('explicit handoff is fenced even before the first safe page or while persistence is down', async () => {
  const f = fixture(); await f.integration.barrier(7); await f.action();
  let events = await f.events(); assert.equal(events[0].replayable, false); assert.equal(events[1].replayable, true);
  f.fault.add('record'); await f.integration.barrier(7); f.fault.clear(); await f.action();
  events = await f.events(); await noGap(f, events[1], events.at(-1));
});

test('run and start require explicit nonce and never mutate input on an invalid request', async () => {
  const f = fixture(); f.adapter.act = () => { throw Error('Must not perform input'); };
  for (const action of ['run', 'start']) await assert.rejects(f.integration.query({ action, id: 'synthetic', tab: 7, params: {} }), { code: 'invalid_request' });
  assert.equal((await f.events()).length, 0); assert.equal(f.calls.length, 0);
});

test('an outer dispatch completion never probes a page after the physical lease ended', async () => {
  const f = fixture(), context = { routineAttempt: { tool: 'type_text', args: { tab: 7, marker: 1 } } };
  await f.integration.beforeInput(context, 7);
  const calls = f.calls.length;
  f.set({ ...initial(), page: { origin: 'https://fixture.test', path: '/another-worker' } });
  await f.integration.afterInput(context, {});
  const [event] = await f.events();
  assert.equal(f.calls.length, calls); assert.equal(event.replayable, false);
  assert.equal(event.after.path, '/form');
});

for (const [name, observation] of [
  ['handoff', { noteable: true, since: null, untouched: async () => true }],
  ['interruption', { noteable: false, since: 1, untouched: async () => true }],
  ['unconfirmed routing', { noteable: true, since: 1, untouched: async () => false }],
  ['missing routing evidence', { noteable: true, since: 1 }],
]) test(`${name} cannot attribute post-action state or promote a recording`, async () => {
  const f = fixture(), context = { routineAttempt: { tool: 'type_text', args: { tab: 7, marker: 1 } } };
  await f.integration.beforeInput(context, 7); const calls = f.calls.length;
  await f.integration.afterInput(context, {}, { observation });
  assert.equal(f.calls.length, calls); assert.equal((await f.events())[0].replayable, false);
});

test('user input during post-action capture discards the captured page', async () => {
  const f = fixture(), context = { routineAttempt: { tool: 'type_text', args: { tab: 7, marker: 1 } } };
  await f.integration.beforeInput(context, 7);
  f.set({ ...initial(), page: { origin: 'https://fixture.test', path: '/user-navigation' } });
  let probes = 0;
  await f.integration.afterInput(context, {}, { observation: { noteable: true, since: 1, untouched: async () => ++probes === 1 } });
  const [event] = await f.events();
  assert.equal(probes, 2); assert.equal(event.replayable, false); assert.equal(event.after.path, '/form');
});

test('a pending event finishes once even when outer completion overlaps the in-lease write', async () => {
  const f = fixture(), context = { routineAttempt: { tool: 'type_text', args: { tab: 7, marker: 1 } } };
  await f.integration.beforeInput(context, 7);
  let release, enter, finishes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  f.hooks.set('finish', async () => { finishes++; enter(); await gate; });
  const held = f.integration.afterInput(context, {}, observed()); await entered;
  const calls = f.calls.length;
  f.set({ ...initial(), page: { origin: 'https://fixture.test', path: '/another-worker' } });
  const outer = f.integration.afterInput(context, {});
  release(); await Promise.all([held, outer]);
  await f.integration.afterInput(context, {});
  assert.equal(finishes, 1); assert.equal(f.calls.length, calls);
  assert.equal((await f.events())[0].replayable, true); assert.equal(f.integration.recordingError(), false);
});

test('an interruption after a confirmed receipt fences subsequent actions without finishing twice', async () => {
  const f = fixture(), context = await f.action();
  await f.integration.afterInput(context, { isError: true });
  await f.integration.afterInput(context, { isError: true });
  await f.action();
  const events = await f.events();
  assert.equal(events.length, 3); assert.equal(events[0].replayable, true); assert.equal(events[1].replayable, false);
  await noGap(f, events[0], events[2]); assert.equal(f.integration.recordingError(), false);
});
