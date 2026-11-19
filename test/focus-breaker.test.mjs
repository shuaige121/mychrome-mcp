/* FOCUS2, Node side: MYCHROME_FOCUS_BACKEND reaches the activation intent; legacy (the default) sends exactly
 * today's intent; a skylight child that died, hung, answered outside the protocol or could not be spawned opens
 * the breaker for the server's lifetime (fact focus_backend_disabled); the facts reach the activity row and the
 * error receipt as finite words only. Production bridge.activateChrome with a fake native route; production
 * callTool in a vm (as tool-error-receipts.test.mjs); no helper, Chrome or input. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

process.env.CHROME_BRIDGE_WARM = '0';
const B = await import('../src/bridge.js');
const S = await import('../src/settings.js');
const { redactText, redactToolResult } = await import('../src/privacy.js');

const ENV = ['MYCHROME_FOCUS_BACKEND', 'MYCHROME_FOCUS_CARBON_FLAG', 'MYCHROME_FOCUS_RERAISE'];
function setEnv(values = {}) { for (const k of ENV) delete process.env[k]; Object.assign(process.env, values); }
const seen = [];
B.onFocusFacts(facts => seen.push(facts));
const okResult = extra => ({ ok: true, chromePid: 42, windowId: 3, tabId: 7, cgWindow: 10, targetOnTop: true, keyWindowIsTarget: true,
  inputDelivery: 'sent', stages: [], ...extra });
function route(...replies) {
  const intents = [];
  return { intents, native: async intent => { intents.push(intent); const r = replies.shift(); if (r instanceof Error) throw r; return r; } };
}
const childFailure = focusChild => ({ ok: false, error: 'native_write_unknown', stage: 'activate_front_key', inputDelivery: 'unknown',
  noRetry: true, focusDriver: 'skylight', focusChild, tSpawnMs: 300, stages: [{ sequence: 1, stage: 'activate_front_key', entered: true, delivery: 'unknown', acknowledged: false }] });

test('legacy is the default and sends exactly today\'s intent (no new key), and reports no focus facts', async () => {
  for (const env of [{}, { MYCHROME_FOCUS_BACKEND: 'legacy' }, { MYCHROME_FOCUS_BACKEND: 'bogus' }, { MYCHROME_FOCUS_BACKEND: '' }]) {
    setEnv(env); B.__resetFocusBreakerForTests(); seen.length = 0;
    const r = route(okResult());
    const out = await B.activateChrome(7, { windowId: 3 }, { native: r.native, fitCurrent: true });
    assert.deepEqual(r.intents, [{ kind: 'activate', tabId: 7, windowId: 3, fitCurrent: true }], JSON.stringify(env));
    assert.equal('focusFact' in out, false); assert.deepEqual(seen, []);
  }
});

test('MYCHROME_FOCUS_BACKEND selects skylight or carbon; carbon flag 1|3 (default 3); MYCHROME_FOCUS_RERAISE=0 is arm S', async () => {
  const cases = [
    [{ MYCHROME_FOCUS_BACKEND: 'skylight' }, { focusBackend: 'skylight' }],
    [{ MYCHROME_FOCUS_BACKEND: ' SkyLight ' }, { focusBackend: 'skylight' }],
    [{ MYCHROME_FOCUS_BACKEND: 'skylight', MYCHROME_FOCUS_RERAISE: '0' }, { focusBackend: 'skylight', focusReraise: false }],
    [{ MYCHROME_FOCUS_BACKEND: 'carbon' }, { focusBackend: 'carbon', carbonFlag: 3 }],
    [{ MYCHROME_FOCUS_BACKEND: 'carbon', MYCHROME_FOCUS_CARBON_FLAG: '1' }, { focusBackend: 'carbon', carbonFlag: 1 }],
    [{ MYCHROME_FOCUS_BACKEND: 'carbon', MYCHROME_FOCUS_CARBON_FLAG: '7' }, { focusBackend: 'carbon', carbonFlag: 3 }],
  ];
  for (const [env, extra] of cases) {
    setEnv(env); B.__resetFocusBreakerForTests();
    const r = route(okResult({ focusDriver: extra.focusBackend }));
    await B.activateChrome(7, { windowId: 3 }, { native: r.native });
    assert.deepEqual(r.intents, [{ kind: 'activate', tabId: 7, windowId: 3, ...extra }], JSON.stringify(env));
  }
});

test('a child signal, timeout, malformed reply or spawn failure: unknown + noRetry, breaker open for the server, later activations legacy', async () => {
  for (const kind of ['signal', 'timeout', 'malformed', 'spawn_failed']) {
    setEnv({ MYCHROME_FOCUS_BACKEND: 'skylight' }); B.__resetFocusBreakerForTests(); seen.length = 0;
    const r = route(childFailure(kind), okResult(), okResult());
    const error = await B.activateChrome(7, { windowId: 3 }, { native: r.native }).then(() => null, e => e);
    assert.ok(error, kind);
    assert.equal(error.code, 'native_write_unknown'); assert.equal(error.inputDelivery, 'unknown'); assert.equal(error.noRetry, true);
    assert.equal(error.focusFact, 'focus_backend_disabled', kind);
    assert.deepEqual(B.focusBackendState(), { setting: 'skylight', effective: 'legacy', breaker: 'open', cause: kind });
    const second = await B.activateChrome(7, { windowId: 3 }, { native: r.native });
    const third = await B.activateChrome(7, { windowId: 3 }, { native: r.native });
    assert.deepEqual(r.intents.slice(1), [{ kind: 'activate', tabId: 7, windowId: 3 }, { kind: 'activate', tabId: 7, windowId: 3 }], 'pinned to legacy');
    assert.equal(second.focusFact, 'focus_backend_disabled'); assert.equal(third.focusFact, 'focus_backend_disabled');
    assert.deepEqual(seen[0], { focusDriver: 'skylight', focusChild: kind, focusFact: 'focus_backend_disabled', tSpawnMs: 300 });
    assert.deepEqual(seen[1], { focusFact: 'focus_backend_disabled' });
  }
});

test('the breaker also reads a guard-style rejection (error.reply), and a front error or a landed child keeps skylight', async () => {
  setEnv({ MYCHROME_FOCUS_BACKEND: 'skylight' }); B.__resetFocusBreakerForTests();
  const guarded = Object.assign(new B.BridgeError('native_delivery_unknown', '原生发送状态未知，不会重试或还原。'),
    { reply: childFailure('timeout'), inputDelivery: 'unknown', noRetry: true });
  let r = route(guarded, okResult());
  await assert.rejects(B.activateChrome(7, null, { native: r.native }), e => e.focusFact === 'focus_backend_disabled');
  await B.activateChrome(7, null, { native: r.native });
  assert.equal(r.intents[1].focusBackend, undefined);
  for (const kept of [childFailure('front_error'), okResult({ focusDriver: 'skylight', focusChild: 'posted' }),
    okResult({ focusDriver: 'skylight', focusChild: 'post_refused' })]) {
    B.__resetFocusBreakerForTests();
    r = route(kept, okResult());
    await B.activateChrome(7, null, { native: r.native }).catch(e => assert.equal(e.focusFact, undefined));
    await B.activateChrome(7, null, { native: r.native });
    assert.equal(r.intents[1].focusBackend, 'skylight', JSON.stringify(kept.focusChild));
    assert.equal(B.focusBackendState().breaker, 'closed');
  }
  // Once open it stays open; with the backend set back to legacy the fact is no longer claimed.
  B.__resetFocusBreakerForTests();
  r = route(childFailure('signal'), okResult());
  await B.activateChrome(7, null, { native: r.native }).catch(() => {});
  setEnv({});
  assert.equal('focusFact' in await B.activateChrome(7, null, { native: r.native }), false);
});

test('observer facts are finite words and bounded integers from the helper reply only', async () => {
  setEnv({ MYCHROME_FOCUS_BACKEND: 'skylight' }); B.__resetFocusBreakerForTests(); seen.length = 0;
  const r = route(okResult({ focusDriver: 'skylight', focusChild: 'evil', focusFallback: 'off_screen', tKeyMs: 12.5, tSpawnMs: 31,
    focusFact: 'other', title: 'Private page title', url: 'https://private.invalid/' }));
  await B.activateChrome(7, null, { native: r.native });
  assert.deepEqual(seen, [{ focusDriver: 'skylight', focusFallback: 'off_screen', tSpawnMs: 31 }]);
  assert.deepEqual(B.focusFacts({ focusDriver: 'skylight', tKeyMs: 70_000, tSpawnMs: -1 }), { focusDriver: 'skylight' });
  assert.deepEqual(B.focusFacts({ get focusDriver() { throw Error('no getters run'); } }), {});
});

test('activity row: the focus fields pass their patterns, everything else is dropped', () => {
  const base = { tool: 'click', ok: false, t: 1, pid: 1 };
  const row = S.activityRecord({ ...base, focusDriver: 'skylight', focusFallback: 'off_screen', focusChild: 'signal',
    focusFact: 'focus_backend_disabled', tSpawnMs: 300, tKeyMs: 41 });
  assert.deepEqual([row.focusDriver, row.focusFallback, row.focusChild, row.focusFact, row.tSpawnMs, row.tKeyMs],
    ['skylight', 'off_screen', 'signal', 'focus_backend_disabled', 300, 41]);
  const bad = S.activityRecord({ ...base, focusDriver: 'other', focusFallback: 'Has Space', focusChild: 'x'.repeat(40),
    focusFact: 'other', tSpawnMs: 1.5, tKeyMs: -1 });
  for (const k of ['focusDriver', 'focusFallback', 'focusChild', 'focusFact', 'tSpawnMs', 'tKeyMs']) assert.equal(k in bad, false, k);
  assert.deepEqual(S.activityRecord(base), S.activityRecord({ ...base, focusDriver: undefined }), 'absent fields add nothing');
});

test('error receipt: the call\'s focus words reach structuredContent.error through the production callTool; others are dropped', async () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const fn = name => { const a = source.search(new RegExp(`(?:async )?function ${name}\\(`)); assert.ok(a >= 0, name); return source.slice(a, source.indexOf('\n}', a) + 2); };
  const CALL = new AsyncLocalStorage();
  let current = {};
  const c = vm.createContext({ CALL, redactText, redactToolResult,
    callToolRun: async () => { Object.assign(CALL.getStore(), current); return { isError: true, content: [{ type: 'text', text: 'Synthetic error' }] }; } });
  vm.runInContext(fn('progressFor') + '\n' + fn('callTool') + '\nglobalThis.invoke = callTool;', c);
  const invoke = () => c.invoke({ params: { name: 'click', arguments: {} } }, {});
  const base = { code: 'native_write_unknown', stage: 'activate_front_key', inputDelivery: 'unknown' };
  current = { ...base, focusDriver: 'skylight', focusChild: 'signal', focusFact: 'focus_backend_disabled', focusFallback: 'off_screen', tKeyMs: 5 };
  assert.deepEqual(JSON.parse(JSON.stringify((await invoke()).structuredContent.error)),
    { ...base, focusDriver: 'skylight', focusChild: 'signal', focusFact: 'focus_backend_disabled' });
  current = { ...base, focusDriver: 'turbo', focusChild: 'evil', focusFact: 'nope' };
  assert.deepEqual(JSON.parse(JSON.stringify((await invoke()).structuredContent.error)), base);
  current = { code: 'native_write_unknown', stage: 'activate_reraise', inputDelivery: 'sent' };
  assert.equal((await invoke()).structuredContent.error.stage, 'activate_reraise', 'the new write stages are public stage words');
});

test('index.js files the facts on the activating call, and its activity row carries them', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /\nonFocusFacts\(facts => \{ const context = CALL\.getStore\(\); if \(context\) Object\.assign\(context, facts\); \}\);\n/);
  assert.match(source, /S\.logActivity\(\{[\s\S]{0,600}focusDriver: r\.focusDriver, focusFallback: r\.focusFallback, focusChild: r\.focusChild, focusFact: r\.focusFact, tSpawnMs: r\.tSpawnMs, tKeyMs: r\.tKeyMs,/);
});
