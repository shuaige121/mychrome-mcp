import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { RoutineError, routinePage, pageMatches } from '../src/routine-runner.js';

// Run the actual input-boundary functions with read-only probes and native
// dispatch replaced by in-memory fixtures. No browser, helper, or settings.
const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `production function ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness() {
  const controller = new AbortController();
  const page = { origin: 'https://fixture.test', path: '/form' };
  const state = { focused: true, paused: false, waiting: false, view: [], probe: async () => {}, requests: [], sent: [] };
  const guard = { signal: controller.signal, tab: 7, tool: 'click', marker: 1,
    before: routinePage({ page, view: [] }), descriptor: { version: 1, tag: 'button', role: 'button', name: 'Continue' } };
  const call = {};
  const c = vm.createContext({
    RoutineError, routinePage, pageMatches,
    pausedCheck() { if (state.paused) throw new RoutineError('paused_by_user'); },
    conversationInputCheck() { if (state.waiting) throw new RoutineError('conversation_waiting'); },
    async routineCapture() {
      await state.probe();
      return { ok: true, page, marker: 1, view: state.view, targetState: { focused: state.focused } };
    },
    CALL: { getStore: () => call },
    toScreen: point => point,
    squareToScreenRect: point => ({ x: point.x, y: point.y, w: 20, h: 20 }),
  });
  vm.runInContext(['postedNothing', 'routineCheck', 'routineGuard', 'post', 'pointerTo'].map(productionFunction).join('\n'), c);
  call.routineGuard = () => c.routineGuard({ ...guard, firstInput: call.routineInputStarted !== true });
  const session = { request: async request => { state.requests.push(request); return { ok: true }; } };
  const ctx = { sent: kind => state.sent.push(kind), unsent: () => {} };
  return { c, controller, state, guard, call, session, ctx };
}

test('unchanged target passes the actual routine guard and posts exactly once', async () => {
  const h = harness();
  await h.c.post(h.session, h.ctx, 'click', { op: 'click' });
  assert.deepEqual(h.state.sent, ['click']);
  assert.equal(h.state.requests.length, 1);
});

test('Stop arriving during the read-only target probe prevents native dispatch', async () => {
  const h = harness();
  h.state.probe = async () => { h.controller.abort(); };
  await assert.rejects(h.c.post(h.session, h.ctx, 'click', { op: 'click' }), { code: 'cancelled' });
  assert.deepEqual(h.state.requests, []);
  assert.deepEqual(h.state.sent, []);
});

for (const [flag, code] of [['paused', 'paused_by_user'], ['waiting', 'conversation_waiting']]) {
  test(`${flag} arriving during the target probe prevents native dispatch`, async () => {
    const h = harness();
    h.state.probe = async () => { h.state[flag] = true; };
    await assert.rejects(h.c.post(h.session, h.ctx, 'key', { op: 'key' }), { code });
    assert.deepEqual(h.state.requests, []);
    assert.deepEqual(h.state.sent, []);
  });
}

test('press_key refuses the same marker after focus moved to another element', async () => {
  const h = harness();
  h.guard.tool = 'press_key';
  h.state.focused = false;
  await assert.rejects(h.c.post(h.session, h.ctx, 'key', { op: 'key' }), { code: 'target_changed' });
  assert.deepEqual(h.state.requests, []);
  assert.deepEqual(h.state.sent, []);
});

test('hover pointer movement obeys Stop at the final routine boundary', async () => {
  const h = harness();
  h.guard.tool = 'hover';
  h.controller.abort();
  await assert.rejects(h.c.pointerTo(h.session, { x: 10, y: 20 }, {}), { code: 'cancelled' });
  assert.deepEqual(h.state.requests, []);
});

test('ordinary pointer movement remains available without a routine', async () => {
  const h = harness();
  delete h.call.routineGuard;
  await h.c.pointerTo(h.session, { x: 10, y: 20 }, {});
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.requests[0].op, 'move');
});

test('same-route view change before the first native event refuses input', async () => {
  const h = harness(); h.state.view = [{ role: 'heading', name: 'Different course' }];
  await assert.rejects(h.c.post(h.session, h.ctx, 'click', { op: 'click' }), { code: 'page_changed' });
  assert.equal(h.state.requests.length, 0);
});

test('a view change caused after this action posted input does not block its following key', async () => {
  const h = harness();
  await h.c.post(h.session, h.ctx, 'click', { op: 'click' });
  assert.equal(h.call.routineInputStarted, true);
  h.state.view = [{ role: 'heading', name: 'Search results updated by the action' }];
  await h.c.post(h.session, h.ctx, 'key', { op: 'key' });
  assert.equal(h.state.requests.length, 2);
});

test('a pointer move also binds the first-input fingerprint before causing hover changes', async () => {
  const h = harness();
  await h.c.pointerTo(h.session, { x: 10, y: 20 }, {});
  assert.equal(h.call.routineInputStarted, true);
  h.state.view = [{ role: 'dialog', name: 'Hover menu' }];
  await h.c.post(h.session, h.ctx, 'click', { op: 'click' });
  assert.equal(h.state.requests.length, 2);
});

for (const kind of ['click', 'move']) test(`known zero-input ${kind} failure keeps the first-input fingerprint required`, async () => {
  const h = harness();
  h.session.request = async () => { throw Object.assign(Error('Synthetic zero input'), { reply: { postedInput: 0 } }); };
  await assert.rejects(kind === 'move' ? h.c.pointerTo(h.session, { x: 10, y: 20 }, {})
    : h.c.post(h.session, h.ctx, 'click', { op: 'click' }));
  assert.equal(h.call.routineInputStarted, false);
  h.state.view = [{ role: 'heading', name: 'Different course' }];
  await assert.rejects(h.c.post(h.session, h.ctx, 'key', { op: 'key' }), { code: 'page_changed' });
});
