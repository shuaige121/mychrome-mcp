// Actual panel call/finally code, evaluated with inert IO. No product import,
// browser, helper process, account, server socket, or live harness invocation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { productErrorFact } from './harness-terminal.mjs';
const source = await fs.readFile(new URL('./click-delta-live.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function runPanelHarness(');
const end = source.indexOf('\nasync function panelScenario(', start);
assert.ok(start >= 0 && end > start);
const realRunner = source.slice(start, end);
let passed = 0;
async function test(name, run) { await run(); console.log(`ok ${++passed} ${name}`); }
const reply = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

async function fixture(scenario, { script = realRunner, call, closeResources, recordRead } = {}) {
  const effects = [], signals = new Map(), aborted = [], saves = [];
  const report = { calls: [], observations: [], checks: {}, screenshots: [], cleanup: {} };
  const model = { hold: null, paused: false, locked: false, asleep: false, status: null, fixtureToken: true,
    owner: { ownerPid: 123, windowId: 9, expectedUrl: 'http://127.0.0.1/fixture-test', openedAt: 1000 },
    info: { tabId: 7, windowId: 9, chromePid: 23, cgWindow: 29, url: 'http://127.0.0.1/fixture-test' },
    lease: { pid: 123, token: 'fixture-lease-1' }, holdToken: 'fixture-lease-1', ownerReads: 0, clientCalls: 0, closed: false, exposed: null };
  const processStub = { pid: 123, exitCode: 0,
    on: (name, fn) => signals.set(name, fn), off: name => signals.delete(name),
    emit: name => signals.get(name)?.() };
  const session = { pid: 789, interrupted: null, request: async (request, opts) => {
    assert.deepEqual({ ...request }, { op: 'status' }); assert.equal(opts.raw, true);
    effects.push('native:status');
    return model.status || { ok: true, interrupted: null, takeover: { active: true, aborted: false } };
  }, close() { throw Error('forbidden_session_close'); }, cancel() { throw Error('forbidden_direct_cancel'); } };
  const hold = { kept: { session }, lease: { get token() { return model.holdToken; } }, timer: 'own-timer', poll: 'own-poll' };
  const api = { __taskHoldForTests: () => model.hold,
    endTaskHold() { throw Error('forbidden_product_cleanup'); } };
  const client = { callTool: async (request, _schema, options) => {
    effects.push('mcp:' + request.name); model.clientCalls++;
    options.signal.addEventListener('abort', () => {
      aborted.push({ terminal: !!model.exposed?.state.terminal, inflight: model.exposed?.state.inflight.size });
      effects.push('resource:abort');
    }, { once: true });
    if (call) {
      const result = await call({ request, options, model, effects, process: processStub });
      if (result !== undefined) return result;
    }
    if (request.name === 'open_tab') return reply('Opened fixture tab=7 window=9');
    if (request.name === 'click') { model.hold = hold; return reply('Fixture click receipt'); }
    if (request.name === 'close_tab') { model.closed = true; return reply('Fixture closed'); }
    if (request.name === 'task_plan' && request.arguments.done) { model.hold = null; return reply('键盘鼠标接管已结束'); }
    return reply('Fixture receipt');
  }, close: async () => { effects.push('resource:client.close'); } };
  const B = {
    cgevent: async ([name]) => { effects.push('native:' + name); assert.ok(['displays','idle'].includes(name));
      return name === 'displays' ? { locked: model.locked, displaysAsleep: model.asleep } : { held: [] }; },
    chromeInfo: async tab => { effects.push('browser:identity'); assert.equal(tab, 7); return model.info; },
    evalInPage: async () => { effects.push('browser:readback'); return { fixture: model.fixtureToken, counts: {}, result: 'Fixture' }; },
    snapshotScene: async () => { effects.push('browser:scene'); return { appPid: 44, chromeWindow: 9, chromeTab: 7 }; },
    closeTab() { throw Error('forbidden_direct_close'); },
    restoreScene() { throw Error('forbidden_direct_restore'); },
  };
  const deps = { client, api, B, tabs: { readTabRecord: async tab => {
    effects.push('owner:read'); assert.equal(tab, 7); model.ownerReads++;
    if (recordRead) await recordRead({ model, session, effects });
    return model.owner;
  } }, settings: { get: name => { assert.equal(name, 'paused'); effects.push('global:pause'); return model.paused; } },
    fs: { readFile: async p => { assert.equal(p, path.join('/shared-fixture-lock', 'owner.json')); effects.push('lease:read'); return JSON.stringify(model.lease); } },
    lockDir: '/shared-fixture-lock', url: model.info.url, token: 'test', report,
    save: async () => { effects.push('report:save'); saves.push(JSON.parse(JSON.stringify(report))); },
    closeResources: async () => { effects.push('resource:server.close'); if (closeResources) await closeResources(); },
    screenshot: async () => { throw Error('unexpected_screenshot'); },
    terminalDirectory: '/inert/worker', terminalSecret: 'inert-binding',
    terminalDispose: receipt => { effects.push('receipt:sync'); saves.push(JSON.parse(JSON.stringify(report)));
      model.terminalReceipt = receipt; effects.push('worker:exit'); },
    scenario: async h => { model.exposed = h; return scenario({ ...h, model, session, effects, process: processStub }); },
  };
  const context = vm.createContext({ assert, path, process: processStub, AbortController, productErrorFact,
    clearTimeout: timer => { assert.equal(timer, 'own-timer'); effects.push('resource:clear_timer'); },
    clearInterval: timer => { assert.equal(timer, 'own-poll'); effects.push('resource:clear_poll'); },
    console: { log() {} } });
  vm.runInContext(script + '\nglobalThis.run = runPanelHarness;', context);
  await context.run(deps);
  return { report, effects, aborted, model, saves, process: processStub, signals };
}
async function setup(h, { held = true } = {}) {
  const opened = await h.call('open_tab', { url: h.model.info.url, why: 'user_asked' });
  await h.captureFixture(opened);
  await h.call('task_plan', { task: 'Fixture' });
  if (held) await h.call('click', { tab: 7, marker: 1 });
}
function assertTerminal(h, code) {
  try { assert.equal(h.report.terminal?.code, code); }
  catch (error) { error.harnessCalls = h.effects.filter(e => e.startsWith('mcp:')); throw error; }
}
function assertRetained(h) {
  assert.equal(h.report.retainedFixture.tabId, 7);
  assert.equal(h.report.retainedFixture.windowId, 9);
  assert.equal(h.report.retainedFixture.chromePid, 23);
  assert.equal(h.report.retainedFixture.cgWindow, 29);
  assert.equal(h.model.closed, false);
}
function assertNoContinuation(h, after) {
  const tail = h.effects.slice(after + 1);
  assert.ok(!tail.some(e => /^(mcp:|browser:|native:|owner:|lease:)/.test(e)), tail.join(', '));
  assert.ok(!tail.some(e => e.startsWith('resource:')), tail.join(', '));
  assert.equal(h.effects.at(-2), 'receipt:sync');
  assert.equal(h.effects.at(-1), 'worker:exit');
}

async function errorReplyCheck(script = realRunner) {
  let failedAt = -1;
  const h = await fixture(async h => {
    await setup(h);
    await h.call('click', { tab: 7, marker: 2 });
    assert.fail('unexpected MCP errors cannot return to the scenario');
  }, { script, call: async ({ request, effects }) => {
    if (request.name === 'click' && request.arguments.marker === 2) {
      failedAt = effects.length - 1; return reply('Opaque tool error after possible input', true);
    }
  } });
  assertTerminal(h, 'unexpected_mcp_error');
  assert.equal(h.report.terminal.inputDelivery, 'unknown');
  assert.equal(h.report.terminal.noRetry, true);
  assert.equal(h.report.calls.at(-1).inputDelivery, 'unknown');
  assertRetained(h); assertNoContinuation(h, failedAt);
  assert.deepEqual(h.aborted, []);
  assert.equal(h.model.terminalReceipt.call.tool, 'click');
  assert.ok(h.model.terminalReceipt.pinned.hold);
}
await test('unexpected isError seals before inflight removal and skips real finally cleanup', () => errorReplyCheck());

async function rejectedCheck(script = realRunner) {
  let failedAt = -1;
  const h = await fixture(async h => {
    await setup(h); await h.call('click', { tab: 7, marker: 2 });
  }, { script, call: async ({ request, effects }) => {
    if (request.name === 'click' && request.arguments.marker === 2) {
      failedAt = effects.length - 1; throw Object.assign(Error('transport response lost'), { code: 'rpc_timeout' });
    }
  } });
  assertTerminal(h, 'dispatched_rpc_rejected');
  assert.equal(h.report.calls.at(-1).rejected, true);
  assert.equal(h.report.calls.at(-1).inputDelivery, 'unknown');
  assertRetained(h); assertNoContinuation(h, failedAt);
  assert.deepEqual(h.aborted, []);
}
await test('rejected dispatched RPC preserves unknown delivery and cannot reach done/readback/close', () => rejectedCheck());

await test('a caller catching the terminal error still cannot invoke later done, readback, or cleanup', async () => {
  let at;
  const h = await fixture(async h => {
    await setup(h);
    await assert.rejects(h.call('click', { tab: 7, marker: 2 }));
    await assert.rejects(h.call('task_plan', { done: true }));
    await assert.rejects(h.readback());
    await assert.rejects(h.cleanup());
  }, { call: async ({ request, effects }) => {
    if (request.name === 'click' && request.arguments.marker === 2) { at = effects.length - 1; return reply('error', true); }
  } });
  assertTerminal(h, 'unexpected_mcp_error'); assertRetained(h); assertNoContinuation(h, at);
  assert.equal(h.process.exitCode, 1);
});

await test('unknown creation never parses error prose into fixture IDs or reads/reclaims them', async () => {
  for (const rejected of [false, true]) {
    let at;
    const h = await fixture(async h => {
      const opened = await h.call('open_tab', { url: h.model.info.url }); await h.captureFixture(opened);
    }, { call: async ({ effects }) => { at = effects.length - 1;
      if (rejected) throw Error('lost create response');
      return reply('Unknown create: tab=77 window=99', true);
    } });
    assert.equal(h.report.retainedFixture.tabId, null);
    assert.equal(h.report.retainedFixture.windowId, null);
    assert.equal(h.report.retainedFixture.identity, 'unknown');
    assert.equal(JSON.stringify(h.saves).includes('Unknown create:'), false);
    assert.equal(Object.hasOwn(h.report.calls.at(-1), 'text'), false);
    assertNoContinuation(h, at);
  }
});

async function productErrorCheck(script = realRunner, delivery = 'not_sent') {
  let at;
  const product = { code: 'native_target_changed', stage: 'native_prepare', inputDelivery: delivery };
  const h = await fixture(async h => { await setup(h); await h.call('click', { tab: 7, marker: 2 }); }, {
    script, call: async ({ request, effects }) => {
      if (request.name === 'click' && request.arguments.marker === 2) { at = effects.length - 1;
        return { ...reply('synthetic-private-error https://example.test/?token=synthetic-private-token', true),
          structuredContent: { error: { ...product, message: 'synthetic-private-error', token: 'synthetic-private-token' } } };
      }
    }
  });
  assert.ok(h.model.terminalReceipt.productError, 'terminal productError lost');
  assert.deepEqual(JSON.parse(JSON.stringify(h.model.terminalReceipt.productError)), product);
  assert.deepEqual(JSON.parse(JSON.stringify(h.report.calls.at(-1).productError)), product);
  assert.equal(h.model.terminalReceipt.call.responseAt >= h.model.terminalReceipt.call.startedAt, true);
  assert.equal(h.report.terminal.inputDelivery, 'unknown'); assert.equal(h.report.terminal.noRetry, true);
  assert.equal(JSON.stringify(h.saves).includes('synthetic-private-'), false);
  assertRetained(h); assertNoContinuation(h, at);
  return h;
}
await test('panel error retains only bounded product claims and response time while terminal remains unknown/noRetry', async () => {
  for (const delivery of ['sent', 'not_sent', 'unknown']) await productErrorCheck(realRunner, delivery);
});
await test('removing the actual panel product-error transfer loses the diagnostic and fails its regression', async () => {
  const transfer = 'productError: pending?.productError,'; assert.ok(realRunner.includes(transfer));
  await assert.rejects(productErrorCheck(realRunner.replace(transfer, '')), error => error.code === 'ERR_ASSERTION' && /terminal productError lost/.test(error.message));
});

await test('native interruption, lock observation, and global Pause seal before another tool call', async () => {
  for (const kind of ['interrupt','locked','paused','aborted','statusUnknown','leaseUnknown']) {
    let at;
    const h = await fixture(async h => {
      await setup(h); at = h.effects.length - 1;
      if (kind === 'interrupt') h.session.interrupted = { kind: 'mouse' };
      if (kind === 'locked') h.model.locked = true;
      if (kind === 'paused') h.model.paused = true;
      if (kind === 'aborted') h.model.status = { ok: true, takeover: { active: true, aborted: true } };
      if (kind === 'statusUnknown') h.model.status = { ok: false };
      if (kind === 'leaseUnknown') h.model.lease.pid = 999;
      await h.call('click', { tab: 7, marker: 2 });
    });
    assert.ok(h.report.terminal, kind);
    assertRetained(h);
    assert.ok(!h.effects.slice(at + 1).some(e => /^(mcp:|browser:)/.test(e)), kind);
    assert.equal(h.effects.at(-1), 'worker:exit');
  }
});

await test('operator Abort synchronously records and exits without asynchronous call or resource cleanup', async () => {
  let at;
  const h = await fixture(async h => { await setup(h); await h.call('click', { tab: 7, marker: 2 }); },
    { call: async ({ request, options, effects, process }) => {
      if (request.name !== 'click' || request.arguments.marker !== 2) return;
      at = effects.length - 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Error('aborted dispatched call')), { once: true });
        queueMicrotask(() => { try { process.emit('SIGINT'); } catch (error) { reject(error); } });
      });
    } });
  assert.equal(h.report.terminal?.code, 'operator_abort'); assertRetained(h); assertNoContinuation(h, at);
  const tail = h.effects.slice(at + 1);
  assert.deepEqual(tail, ['receipt:sync', 'worker:exit']);
  assert.deepEqual(h.aborted, []);
});

await test('ordinary assertion cleanup uses a fresh healthy hold and exact owner, then closes before done', async () => {
  let at;
  const h = await fixture(async h => { await setup(h); at = h.effects.length; assert.fail('ordinary assertion'); });
  assert.equal(h.report.terminal, null);
  assert.equal(h.report.failure.code, 'assertion_failed');
  assert.equal(h.report.cleanup.fixtureClosed, true);
  assert.equal(h.report.retainedFixture, null);
  const tail = h.effects.slice(at), close = tail.indexOf('mcp:close_tab'), done = tail.indexOf('mcp:task_plan');
  assert.ok(close > 0 && done > close);
  assert.ok(tail.slice(0, close).filter(x => x === 'native:status').length >= 3);
  assert.ok(tail.slice(0, close).filter(x => x === 'owner:read').length >= 3);
  assert.ok(tail.slice(0, close).includes('browser:readback'));
});

await test('ordinary assertion without a current hold never reacquires one for cleanup', async () => {
  let at;
  const h = await fixture(async h => { await setup(h, { held: false }); at = h.effects.length; assert.fail('ordinary assertion'); });
  assert.equal(h.report.cleanup.skipped, 'no_current_hold'); assertRetained(h);
  assert.ok(!h.effects.slice(at).some(e => /^(mcp:|browser:|owner:)/.test(e)));
});

await test('a hold lost after a successful click cannot be silently reacquired for another call or cleanup', async () => {
  let at;
  const h = await fixture(async h => {
    await setup(h); h.model.hold = null; at = h.effects.length;
    await h.call('click', { tab: 7, marker: 2 });
  });
  assertTerminal(h, 'native_hold_lost'); assertRetained(h);
  assert.ok(!h.effects.slice(at).some(e => /^(mcp:|browser:|owner:)/.test(e)));
});

await test('a replacement healthy hold/session or same-PID lease token seals before continuation and cleanup', async () => {
  for (const kind of ['hold', 'session', 'holderToken', 'ownerToken', 'bothTokens']) {
    let at;
    const h = await fixture(async h => {
      await setup(h); at = h.effects.length;
      if (kind === 'hold') h.model.hold = { ...h.model.hold };
      if (kind === 'session') h.model.hold.kept.session = { ...h.session, pid: 790 };
      if (kind === 'holderToken' || kind === 'bothTokens') h.model.holdToken = 'fixture-lease-2';
      if (kind === 'ownerToken' || kind === 'bothTokens') h.model.lease.token = 'fixture-lease-2';
      await h.call('click', { tab: 7, marker: 2 });
    });
    assert.ok(h.report.terminal, `replacement ${kind} was accepted`);
    assertRetained(h);
    assert.ok(!h.effects.slice(at).some(e => /^(mcp:|browser:|owner:)/.test(e)), kind);
  }
});

await test('changed owner, record, URL, window and sticky protection all deny assertion cleanup', async () => {
  for (const change of [m => { m.owner.ownerPid = 999; }, m => { m.owner.openedAt++; },
    m => { m.owner.takenOver = true; }, m => { m.owner.ownershipUncertain = true; },
    m => { m.owner.protected = true; }, m => { m.owner.closeBlocked = true; },
    m => { m.info.url += '?changed'; }, m => { m.info.windowId = 99; },
    m => { m.info.cgWindow = 99; }, m => { m.owner.openedAt = undefined; }]) {
    let at;
    const h = await fixture(async h => { await setup(h); change(h.model); at = h.effects.length; assert.fail('ordinary assertion'); });
    assert.equal(h.report.cleanup.skipped, 'fixture_ownership_unverified'); assertRetained(h);
    assert.ok(!h.effects.slice(at).some(e => e.startsWith('mcp:') || e === 'browser:readback'));
  }
});

await test('Stop arriving during deferred ownership cleanup blocks readback and close', async () => {
  let at;
  const h = await fixture(async h => { await setup(h); at = h.effects.length; assert.fail('ordinary assertion'); },
    { recordRead: async ({ model, session }) => { if (model.ownerReads === 2) session.interrupted = { kind: 'esc' }; } });
  assert.equal(h.report.terminal?.code, 'native_interruption'); assertRetained(h);
  assert.ok(!h.effects.slice(at).some(e => e.startsWith('mcp:') || e === 'browser:readback'));
});

await test('cleanup close rejection seals before task-plan release, retaining exact fixture identity', async () => {
  let at;
  const h = await fixture(async h => { await setup(h); assert.fail('ordinary assertion'); }, {
    call: async ({ request, effects }) => { if (request.name === 'close_tab') { at = effects.length - 1; throw Error('close response lost'); } },
  });
  assertTerminal(h, 'dispatched_rpc_rejected'); assertRetained(h); assertNoContinuation(h, at);
});

await test('parent disconnect synchronously seals the disposable panel worker', async () => {
  const h = await fixture(async h => { await setup(h); h.process.emit('disconnect'); });
  assertTerminal(h, 'parent_disconnected'); assertRetained(h);
  const receipt = h.effects.indexOf('receipt:sync');
  assert.equal(h.effects[receipt + 1], 'worker:exit');
  assert.equal(h.effects.slice(receipt).some(x => x.startsWith('resource:')), false);
});
await test('terminal disposal never starts asynchronous resource-close work', async () => {
  let at;
  const h = await fixture(async h => { await setup(h); await h.call('click', { tab: 7, marker: 2 }); }, {
    call: async ({ request, effects }) => { if (request.name === 'click' && request.arguments.marker === 2) { at = effects.length - 1; throw Error('lost reply'); } },
    closeResources: async () => { throw Error('local server close failed'); },
  });
  assert.equal(h.report.cleanup.resourceError, undefined); assertNoContinuation(h, at);
  assert.equal(h.saves.at(-1).terminal.code, 'dispatched_rpc_rejected');
});

await test('removing either real terminal guard in memory makes its negative regression fail', async () => {
  const errorGuard = "if (result.isError) seal('unexpected_mcp_error', { stage: name, inputDelivery: 'unknown' });";
  const rejectGuard = "seal('dispatched_rpc_rejected', { stage: name, inputDelivery: 'unknown', cause: error.code || 'rpc_rejected' });";
  assert.ok(realRunner.includes(errorGuard)); assert.ok(realRunner.includes(rejectGuard));
  for (const [guard, check, expected] of [[errorGuard, errorReplyCheck, 'unexpected_mcp_error'],
    [rejectGuard, rejectedCheck, 'dispatched_rpc_rejected']]) {
    await assert.rejects(check(realRunner.replace(guard, '')), error => {
      assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, new RegExp(expected));
      assert.ok(error.harnessCalls.includes('mcp:close_tab'));
      assert.equal(error.harnessCalls.at(-1), 'mcp:task_plan');
      console.log(JSON.stringify({ mutation: expected, detected: error.message, calls: error.harnessCalls }));
      return true;
    });
  }
});
await test('--wide refuses in the real CLI prefix before SDK imports or live startup', () => {
  const prefix = source.slice(0, source.indexOf("if (!flags.has('--fixture-worker'))")).replace(/^import .*;\n/gm, '');
  for (const args of [['--wide'], ['--run', '--wide']]) {
    const context = vm.createContext({ process: { argv: ['node', 'fixture', ...args] } });
    assert.throws(() => vm.runInContext(prefix + '\nglobalThis.startup = true;', context), /--wide is unavailable/);
    assert.equal(context.startup, undefined);
  }
  const normal = vm.createContext({ process: { argv: ['node', 'fixture', '--run', '--fixture-worker'], send() {}, ppid: 42,
    env: { MYCHROME_PANEL_PARENT: '42', MYCHROME_PANEL_BINDING: 'inert', MYCHROME_PANEL_DIR: '/inert' } } });
  vm.runInContext(prefix + '\nglobalThis.startup = true;', normal); assert.equal(normal.startup, true);
});

console.log(`${passed} inert panel harness groups; no browser/native acceptance claimed.`);
