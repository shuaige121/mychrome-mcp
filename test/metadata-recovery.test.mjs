// Exercise the production driver and metadata/eval wrappers with fake process boundaries.
// No Chrome, helper process, runtime state, or input is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { BridgeError, humanMessage } from '../src/bridge.js';

const source = await fs.readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const descriptorError = { ok: false, error: 'chrome_error', message: 'Missing descriptor.',
  osStatus: -1701, stage: 'find_tab_windows' };
const success = { ok: true, tabId: 7, windowId: 9, loading: false };
function harness(replies, { warm = true } = {}) {
  const calls = [], delays = [], events = [], writes = [], unlinks = [];
  let poolCalls = 0;
  const receive = (kind, argv) => {
    calls.push({ kind, argv: Array.from(argv) });
    events.push(kind);
    assert.ok(replies.length, `Unexpected extra ${kind} process`);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply?.raw ?? { stdout: JSON.stringify(reply), stderr: '' };
  };
  const context = vm.createContext({
    BridgeError, humanMessage, JSON, WARM_ON: warm, CHROMECTL: '/fake/chromectl',
    path, os: { tmpdir: () => '/fake/tmp' }, crypto: { randomBytes: () => Buffer.from('abcdef') },
    writeFile: async (...args) => { writes.push(args); },
    unlink: async file => { unlinks.push(file); },
    setTimeout(resolve, ms) { delays.push(ms); events.push(`delay:${ms}`); resolve(); },
    process: { env: {}, stderr: { write() { throw Error('Unexpected diagnostic output'); } } },
    takeWarm() { poolCalls++; return { id: 'warm-process' }; },
    runWarm: async (_process, argv) => receive('warm', argv),
    execFileP: async (binary, argv, options) => {
      assert.equal(binary, '/fake/chromectl');
      assert.equal(options.timeout, 25000);
      return receive('cold', argv);
    },
  });
  vm.runInContext(['runDriver', 'chromeInfo', 'evalInPage'].map(productionFunction).join('\n'), context);
  return { context, calls, delays, events, writes, unlinks,
    poolCalls: () => poolCalls, remaining: () => replies.length };
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }
const status = (code, osStatus, stage) => error =>
  error instanceof BridgeError && error.code === code &&
  error.osStatus === osStatus && error.stage === stage;

await check('info retries the exact structured warm failure once in a new cold process', async () => {
  const h = harness([{ ...descriptorError }, success]);
  assert.deepEqual(await h.context.chromeInfo(7), success);
  assert.deepEqual(h.calls, [
    { kind: 'warm', argv: ['info', '--tab', '7'] },
    { kind: 'cold', argv: ['info', '--tab', '7'] },
  ]);
  assert.equal(h.poolCalls(), 1, 'recovery must not take another pooled process');
  assert.equal(h.remaining(), 0);
});

await check('an unqualified info read keeps its original argv during recovery', async () => {
  const h = harness([{ ...descriptorError }, success]);
  await h.context.chromeInfo();
  assert.deepEqual(h.calls.map(x => x.argv), [['info'], ['info']]);
});

await check('successful metadata performs just its normal warm read', async () => {
  const h = harness([success]);
  assert.deepEqual(await h.context.chromeInfo(7), success);
  assert.equal(h.calls.length, 1);
});

await check('the second failure is exposed with its own code, status, stage and message', async () => {
  const second = { ok: false, error: 'chrome_error', message: 'Second read timed out.',
    osStatus: -1712, stage: 'target_metadata' };
  const h = harness([{ ...descriptorError }, second]);
  await assert.rejects(h.context.chromeInfo(7), error =>
    status(second.error, second.osStatus, second.stage)(error) && error.message === second.message);
  assert.deepEqual(h.calls.map(x => x.kind), ['warm', 'cold']);
});

await check('a repeated exact descriptor failure cannot cause a third process', async () => {
  const h = harness([{ ...descriptorError }, { ...descriptorError, message: 'Second exact failure.' }]);
  await assert.rejects(h.context.chromeInfo(7), error =>
    status('chrome_error', -1701, 'find_tab_windows')(error) && error.message === 'Second exact failure.');
  assert.equal(h.calls.length, 2);
  assert.equal(h.poolCalls(), 1);
});

await check('a cold recovery permission failure remains a permission error without another retry', async () => {
  const second = { ok: false, error: 'no_automation_permission', message: 'Permission denied.',
    osStatus: -1743, stage: 'find_tab_windows' };
  const h = harness([{ ...descriptorError }, second]);
  await assert.rejects(h.context.chromeInfo(7), error =>
    status(second.error, second.osStatus, second.stage)(error) &&
    error.message === humanMessage(second.error, second.message));
  assert.deepEqual(h.calls.map(x => x.kind), ['warm', 'cold']);
});

await check('permission failures, including contradictory metadata, are never retried', async () => {
  for (const code of [-1743, -1701]) {
    const h = harness([{ ...descriptorError, error: 'no_automation_permission', osStatus: code }]);
    await assert.rejects(h.context.chromeInfo(7), status('no_automation_permission', code, 'find_tab_windows'));
    assert.equal(h.calls.length, 1);
  }
});

await check('other stages, statuses and unknown error codes do not trigger metadata recovery', async () => {
  for (const changed of [
    { stage: 'find_tab_tabs' }, { stage: 'eval_result' }, { stage: 'target_metadata' },
    { osStatus: -1712 }, { error: 'unknown_failure' },
  ]) {
    const failure = { ...descriptorError, ...changed }, h = harness([failure]);
    await assert.rejects(h.context.chromeInfo(7), status(failure.error, failure.osStatus, failure.stage));
    assert.equal(h.calls.length, 1, JSON.stringify(changed));
  }
});

await check('message text alone cannot authorize recovery', async () => {
  const h = harness([{ ok: false, error: 'chrome_error',
    message: 'OSStatus -1701 at find_tab_windows; retry suggested by text.' }]);
  await assert.rejects(h.context.chromeInfo(7), status('chrome_error', undefined, undefined));
  assert.equal(h.calls.length, 1);
});

await check('malformed structured metadata is not coerced into a recovery condition', async () => {
  for (const changed of [
    { osStatus: '-1701' }, { osStatus: null }, { stage: { name: 'find_tab_windows' } },
    { stage: 'find_tab_windows https://private.example/path' },
  ]) {
    const h = harness([{ ...descriptorError, ...changed }]);
    await assert.rejects(h.context.chromeInfo(7), error => error.code === 'chrome_error');
    assert.equal(h.calls.length, 1, JSON.stringify(changed));
  }
});

await check('only validated numeric status and simple stage metadata are copied into BridgeError', async () => {
  const h = harness([{ ...descriptorError, script: 'private script', url: 'https://private.example/',
    tabTitle: 'private title', secret: 'private input' }]);
  await assert.rejects(h.context.runDriver(['info'], 7), error => {
    assert.deepEqual(Object.keys(error).sort(), ['code', 'osStatus', 'stage']);
    return status('chrome_error', -1701, 'find_tab_windows')(error);
  });
  assert.equal(h.calls.length, 1, 'runDriver itself must not add descriptor retries');
});

await check('ordinary driver commands never replay a structured descriptor failure', async () => {
  for (const args of [
    ['activate'], ['select', '7'], ['open', 'https://example.test/'], ['close', '7'],
    ['eval', '/fake/script.js'], ['newwindow', 'https://example.test/', '1', '2', '3', '4'],
    ['list'], ['profiles'],
  ]) {
    const h = harness([{ ...descriptorError }]);
    await assert.rejects(h.context.runDriver(args, 7), status('chrome_error', -1701, 'find_tab_windows'));
    assert.equal(h.calls.length, 1, args[0]);
    assert.equal(h.calls[0].kind, 'warm', args[0]);
  }
});

await check('process failures and malformed output do not become descriptor retries', async () => {
  for (const reply of [Error('OSStatus -1701 find_tab_windows'), { raw: { stdout: 'not-json', stderr: '' } }]) {
    const h = harness([reply]);
    await assert.rejects(h.context.chromeInfo(7), error =>
      ['chromectl_failed', 'bad_driver_output'].includes(error.code));
    assert.equal(h.calls.length, 1);
  }
});

await check('cold mode bypasses the pool and an exact cold failure still has only one fresh retry', async () => {
  const h = harness([{ ...descriptorError }, success], { warm: false });
  assert.deepEqual(await h.context.chromeInfo(7), success);
  assert.deepEqual(h.calls.map(x => x.kind), ['cold', 'cold']);
  assert.equal(h.poolCalls(), 0);
});

await check('the preexisting empty-stdout fallback remains unchanged for ordinary commands', async () => {
  const h = harness([{ raw: { stdout: '', stderr: '' } }, success]);
  await h.context.runDriver(['activate'], 7);
  assert.deepEqual(h.calls.map(x => x.kind), ['warm', 'cold']);
  assert.equal(h.poolCalls(), 1);
});

const evalSuccess = (payload = { ok: true, value: 'page read' }) => ({
  ok: true, tabId: 7, windowId: 9, url: 'https://fixture.test/', title: 'Fixture',
  tabActive: true, windowIndex: 1, minimized: false, bounds: { left: 1, top: 2, width: 800, height: 600 },
  result: JSON.stringify(payload),
});

await check('an eval with unknown delivery cannot reach either empty-output or descriptor recovery', async () => {
  for (const lean of [false, true]) {
    const h = harness([
      { raw: { stdout: '', stderr: '' } },
      { ...descriptorError },
      evalSuccess(),
    ]);
    await assert.rejects(h.context.evalInPage('synthetic script with a possible effect', 7, { lean }),
      error => error.code === 'chromectl_failed');
    assert.deepEqual(h.calls.map(x => x.kind), ['warm'], 'empty output cannot prove the script did not run');
    assert.equal(h.remaining(), 2, 'neither the old fallback nor the new descriptor retry may replay it');
    assert.deepEqual(h.delays, []);
    assert.deepEqual(h.unlinks, [h.writes[0][0]]);
  }
});

await check('full and lean eval recover one pre-script lookup failure after a short pause in a fresh process', async () => {
  for (const lean of [false, true]) {
    const h = harness([{ ...descriptorError }, evalSuccess()]);
    const result = await h.context.evalInPage('fixture script', 7, { lean });
    assert.equal(result.value, 'page read');
    assert.equal(result.target.tabId, 7);
    assert.deepEqual(h.calls.map(x => x.kind), ['warm', 'cold']);
    assert.deepEqual(h.calls[1].argv, h.calls[0].argv, 'recovery must keep the exact tab and script');
    assert.deepEqual(h.calls[0].argv, ['eval', h.writes[0][0], ...(lean ? ['--lean'] : []), '--tab', '7']);
    assert.deepEqual(h.delays, [250]);
    assert.deepEqual(h.events, ['warm', 'delay:250', 'cold']);
    assert.equal(h.poolCalls(), 1, 'recovery must bypass the warm pool');
    assert.equal(h.writes.length, 1, 'the same script file is reused');
    assert.deepEqual(h.unlinks, [h.writes[0][0]]);
  }
});

await check('successful eval neither pauses nor opens another process', async () => {
  const h = harness([evalSuccess()]);
  await h.context.evalInPage('fixture script', 7);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
  assert.deepEqual(h.unlinks, [h.writes[0][0]]);
});

await check('eval without an explicit target never retries a lookup failure onto a different front tab', async () => {
  const h = harness([{ ...descriptorError }]);
  await assert.rejects(h.context.evalInPage('fixture script'), status('chrome_error', -1701, 'find_tab_windows'));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
  assert.deepEqual(h.unlinks, [h.writes[0][0]]);
});

await check('post-script eval errors never replay a script or any effects it already caused', async () => {
  for (const stage of ['eval_result', 'eval_url', 'eval_bounds']) {
    const h = harness([{ ...descriptorError, stage }, evalSuccess()]);
    await assert.rejects(h.context.evalInPage('fixture script with an observable effect', 7),
      status('chrome_error', -1701, stage));
    assert.equal(h.calls.length, 1, stage);
    assert.equal(h.remaining(), 1, 'a second execution must not occur');
    assert.deepEqual(h.delays, []);
    assert.deepEqual(h.unlinks, [h.writes[0][0]]);
  }
});

await check('page-result fields and error text cannot impersonate native pre-script failure metadata', async () => {
  const payload = { ...descriptorError, message: 'Page says find_tab_windows -1701; do not replay.' };
  const h = harness([evalSuccess(payload)]);
  await assert.rejects(h.context.evalInPage('fixture script', 7), error =>
    error.code === 'chrome_error' && error.message === payload.message &&
    error.osStatus === undefined && error.stage === undefined);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
  const malformed = harness([{ ...evalSuccess(), result: 'not JSON; find_tab_windows -1701' }]);
  await assert.rejects(malformed.context.evalInPage('fixture script', 7), error => error.code === 'bad_page_result');
  assert.equal(malformed.calls.length, 1);
});

await check('eval permissions, other stages/statuses and invalid metadata never authorize recovery', async () => {
  for (const change of [
    { error: 'no_automation_permission', osStatus: -1743 },
    { error: 'no_automation_permission' }, { error: 'js_from_apple_events_disabled' },
    { stage: 'find_tab_tabs' }, { stage: 'target_metadata' }, { osStatus: -1712 },
    { osStatus: '-1701' }, { stage: 'find_tab_windows private text' },
  ]) {
    const failure = { ...descriptorError, ...change }, h = harness([failure]);
    await assert.rejects(h.context.evalInPage('fixture script', 7), error => error.code === failure.error);
    assert.equal(h.calls.length, 1, JSON.stringify(change));
    assert.deepEqual(h.delays, []);
  }
});

await check('a second eval failure is returned unchanged without a third process', async () => {
  for (const second of [
    { ...descriptorError, message: 'Second exact failure.' },
    { ...descriptorError, stage: 'eval_result', message: 'Script result failed.' },
    { ...descriptorError, error: 'no_automation_permission', osStatus: -1743, message: 'Permission denied.' },
  ]) {
    const h = harness([{ ...descriptorError }, second]);
    await assert.rejects(h.context.evalInPage('fixture script', 7), error =>
      status(second.error, second.osStatus, second.stage)(error) && error.message === humanMessage(second.error, second.message));
    assert.deepEqual(h.calls.map(x => x.kind), ['warm', 'cold']);
    assert.deepEqual(h.delays, [250]);
    assert.deepEqual(h.unlinks, [h.writes[0][0]]);
  }
});

await check('cold eval still receives exactly one fresh-process recovery', async () => {
  const h = harness([{ ...descriptorError }, evalSuccess()], { warm: false });
  await h.context.evalInPage('fixture script', 7, { lean: true });
  assert.deepEqual(h.calls.map(x => x.kind), ['cold', 'cold']);
  assert.deepEqual(h.delays, [250]);
  assert.equal(h.poolCalls(), 0);
});

console.log(`\nMetadata recovery: ${passed} checks passed.`);
