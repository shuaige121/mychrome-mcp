#!/usr/bin/env node
/* LOG-OS (problems-20261101): the activity row says why the first error happened.
 * New fix:  firstErrorOsStatus (integer only), bindingReason and lastWriteStage reach the row; the first error's
 *           code, stage and osStatus come from the same error and a later error never overwrites them; the early-error
 *           path (an error that never passes through persist) records them too.
 * Kept behaviour: privacy (no free text), existing whitelist fields, firstErrorCode/Stage patterns.
 * Everything goes through the real activityRecord and the production callTool; the bridge is a fake (no Chrome). */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-logos-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
process.env.CHROME_BRIDGE_NOTIFY = '0';
process.env.CHROME_BRIDGE_AGENT_NAME = 'logos-test';
process.env.CHROME_BRIDGE_HABITS = 'off';
process.env.CHROME_BRIDGE_MENUBAR = '0';
process.env.CHROME_BRIDGE_LANG = 'zh';
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const idx = await import('../src/index.js');
const S = await import('../src/settings.js');
const T = await import('../src/tabs.js');
const { BridgeError } = await import('../src/bridge.js');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  [${name}]`); }
  catch (e) { failed++; console.error(`  FAIL [${name}]\n${e.stack}`); }
}

/* ---------------------------------------------------- activityRecord (the whitelist) */
const rec = o => S.activityRecord({ tool: 'scroll', ok: false, ...o });

await check('new-fix: firstErrorOsStatus keeps an integer only', () => {
  assert.equal(rec({ firstErrorOsStatus: -1701 }).firstErrorOsStatus, -1701);
  assert.equal(rec({ firstErrorOsStatus: 0 }).firstErrorOsStatus, 0);
  assert.equal(rec({ firstErrorOsStatus: -600 }).firstErrorOsStatus, -600);
  for (const bad of [undefined, null, '-1701', 1.5, NaN, Infinity, -Infinity, true, {}, [], [-1701], 2 ** 60, 'x']) {
    assert.equal(Object.hasOwn(rec({ firstErrorOsStatus: bad }), 'firstErrorOsStatus'), false, String(bad));
  }
});

await check('new-fix: bindingReason and lastWriteStage keep a strict word only', () => {
  const r = rec({ bindingReason: 'cg_mapping_missing', lastWriteStage: 'activate_tab' });
  assert.equal(r.bindingReason, 'cg_mapping_missing');
  assert.equal(r.lastWriteStage, 'activate_tab');
  assert.equal(Object.hasOwn(rec({}), 'bindingReason'), false);
  assert.equal(Object.hasOwn(rec({}), 'lastWriteStage'), false);
  for (const bad of ['https://private.example/x', 'Has Space', 'UPPER', 'a-b', '', 'x'.repeat(65), 5, null, ['activate_tab'], 'private page text']) {
    const x = rec({ bindingReason: bad, lastWriteStage: bad });
    assert.equal(Object.hasOwn(x, 'bindingReason'), false, String(bad));
    assert.equal(Object.hasOwn(x, 'lastWriteStage'), false, String(bad));
  }
});

await check('kept: the whitelist gains exactly these three fields', () => {
  const full = rec({ stage: 'a', firstErrorCode: 'b', firstErrorStage: 'c', firstErrorOsStatus: -1, bindingReason: 'd', lastWriteStage: 'e',
    queueMs: 1, idleWaitMs: 1, inputDelivery: 'sent', captureMs: 1, ocrMs: 1, typedChars: 1, charsPerSec: 1, text: 'secret', url: 'https://x/y', title: 't', message: 'm' });
  assert.deepEqual(Object.keys(full).sort(), ['bindingReason', 'captureMs', 'charsPerSec', 'code', 'color', 'firstErrorCode', 'firstErrorOsStatus',
    'firstErrorStage', 'host', 'idleWaitMs', 'inputDelivery', 'lastWriteStage', 'ms', 'ocrMs', 'ok', 'pid', 'queueMs', 'stage', 't', 'tool', 'typedChars', 'who']);
});

/* ---------------------------------------------------- production callTool, fake bridge */
const ACTIVITY = process.env.CHROME_BRIDGE_ACTIVITY;
let plan;   // { info: Error|null, activate: [Error, ...] }
const target = id => ({ tabId: id, windowId: 7, chromePid: 42, cgWindow: 70, tabActive: true, minimized: false,
  bounds: { left: 0, top: 0, width: 1200, height: 900 }, url: 'https://shop.test/form', title: `t${id}` });
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in log-os test`); }]));
  return Object.assign(fake, {
    // plan.helper (CRASH1 cases below): the production runDriver answers, fed by a fake chromectl reply.
    chromeInfo: async tab => { if (plan.helper) return driver.runDriver(['info'], tab); if (plan.info) throw plan.info; return target(tab == null ? 10 : Number(tab)); },
    listTabs: async () => ({ ok: true, frontmost: 'WeChat', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
      tabs: [{ id: 10, url: 'https://shop.test/form', title: 't10', active: true }] }] }),
    pageDialog: async () => ({ ok: true, open: false }),
    ensureScreenAwake: async () => ({ locked: false, displays: 1, woke: false }),
    axInput: async () => ({ ok: true, frontmost: true, windowMatches: true, nodeFound: true, documentToken: 'd', focusedDocumentToken: 'd', menuOpen: false, nativeMenuOpen: false, nativePopup: false }),
    pageScript: async (kind, vars = {}) => `fakePage(${JSON.stringify(kind)}, ${JSON.stringify(vars)})`,
    evalInPage: async (src, tab) => JSON.parse(vm.runInNewContext(src, { fakePage: (k, v) => JSON.stringify(page(k, v, tab)) })),
    snapshotScene: async () => ({ appPid: 99, chromeWindow: 7, chromeTab: 10 }),
    restoreScene: async () => ({ ok: true, appFrontmost: true }),
    openInputSession: async () => { const e = plan.activate.shift(); if (e) throw e; return { request: async req => ({ ok: true, epoch: 1, operationId: req.operationId, stages: [], inputMonitor: true, takeover: { active: false } }),
      close: async () => ({ ok: true, takeover: { active: false } }) }; },
    activateChrome: async () => { throw new Error('activateChrome reached in log-os test'); },
    cgevent: async args => {
      if (args[0] === 'displays') return { displays: [] };
      if (args[0] === 'mousepos') return { x: 10, y: 20 };
      if (args[0] === 'windowsat') return { windows: [] };
      if (args[0] === 'idle') return { ok: true, idle: 100, keyIdle: 100, held: [], clickIdle: 100 };
      throw new Error(`B.cgevent ${args[0]} reached in log-os test`);
    },
  });
}
const VIEW = { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900 };
function page(kind, vars, tab) {
  const t = target(tab == null ? 10 : Number(tab));
  if (kind === 'block') return { ok: true, blocked: null, target: t };
  if (kind === 'locate' && vars.MODE === 'scroll') return { bounds: t.bounds, view: VIEW, scroller: 'document', points: [{ x: 600, y: 400 }],
    height: 800, scrollTop: 0, max: 5000, target: t };
  throw new Error(`unexpected page script ${kind}`);
}
const err = (code, extra = {}) => Object.assign(new BridgeError(code, `${code} private page text`), extra);
async function row(name, args, p) {
  idx.__resetPanelTaskForTests(); idx.__resetLedgerForTests(); idx.__resetNativeTargetsForTests();
  plan = { info: null, activate: [], ...p };
  idx.__setBridgeForTests(fakeBridge());
  idx.__setRetryForTests({ maxMs: 5000, few: 3, pauseMs: 1 });
  await T.registerTab(10, 'https://shop.test/form', { windowId: 7, agentName: 'logos-test' });
  await rm(ACTIVITY, { force: true });
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  const lines = (await readFile(ACTIVITY, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(lines.length, 1, `one row for ${name}`);
  return { r, row: lines[0] };
}
idx.__recordForTests(true);

await check('new-fix: early-error path (before persist) records code, stage and osStatus of the same error', async () => {
  const { r, row: x } = await row('scroll', { tab: 10, direction: 'down' },
    { info: err('chrome_error', { osStatus: -1701, stage: 'find_tab_windows' }) });
  assert.equal(r.isError, true);
  assert.equal(x.firstErrorCode, 'chrome_error');
  assert.equal(x.firstErrorStage, 'find_tab_windows');
  assert.equal(x.firstErrorOsStatus, -1701);
  assert.equal(x.code, 'chrome_error');
  assert.ok(!JSON.stringify(x).includes('private page text'));
});

await check('new-fix: early-error path with a non-integer or missing osStatus records no osStatus', async () => {
  for (const os of [undefined, '-1701', 1.5, NaN]) {
    const { row: x } = await row('scroll', { tab: 10, direction: 'down' },
      { info: err('chrome_error', { stage: 'find_tab_windows', ...(os === undefined ? {} : { osStatus: os }) }) });
    assert.equal(Object.hasOwn(x, 'firstErrorOsStatus'), false, String(os));
    // Kept behaviour: an early refusal without an integer osStatus adds no first-error fields (settings.test pins the row shape).
    assert.equal(Object.hasOwn(x, 'firstErrorCode'), false);
    assert.equal(x.code, 'chrome_error');
    assert.equal(x.stage, 'find_tab_windows');
  }
});

await check('new-fix: persist path keeps the first error whole; a later error does not overwrite any of the three', async () => {
  const { r, row: x } = await row('scroll', { tab: 10, direction: 'down' }, { activate: [
    err('activate_failed', { osStatus: -1712, stage: 'activate_tab' }),     // retryable: attempt 2 runs
    err('no_such_tab', { osStatus: -1728, stage: 'activate_main' }) ] });   // later, different error ends the call
  assert.equal(r.isError, true);
  assert.notEqual(x.code, 'activate_failed', 'the call ended with a later, different error');
  assert.equal(x.firstErrorCode, 'activate_failed');
  assert.equal(x.firstErrorStage, 'activate_tab');
  assert.equal(x.firstErrorOsStatus, -1712);
});

await check('new-fix: first error without osStatus is not given the later error\'s osStatus', async () => {
  const { row: x } = await row('scroll', { tab: 10, direction: 'down' }, { activate: [
    err('activate_failed', { stage: 'activate_tab' }),
    err('no_such_tab', { osStatus: -1728, stage: 'activate_main' }) ] });
  assert.equal(x.firstErrorCode, 'activate_failed');
  assert.equal(x.firstErrorStage, 'activate_tab');
  assert.equal(Object.hasOwn(x, 'firstErrorOsStatus'), false);
});

await check('new-fix: bindingReason and lastWriteStage reach the row only when valid', async () => {
  const good = await row('scroll', { tab: 10, direction: 'down' }, { info: err('native_target_changed',
    { stage: 'native_window_binding', bindingReason: 'cg_mapping_missing', stages: [{ entered: true, stage: 'activate_tab', delivery: 'sent' }] }) });
  assert.equal(good.row.bindingReason, 'cg_mapping_missing');
  assert.equal(good.row.lastWriteStage, 'activate_tab');
  const bad = await row('scroll', { tab: 10, direction: 'down' }, { info: err('native_target_changed',
    { stage: 'native_window_binding', bindingReason: 'https://private.example/x', stages: [{ entered: true, stage: 'not_a_stage', delivery: 'sent' }] }) });
  assert.equal(Object.hasOwn(bad.row, 'bindingReason'), false);
  assert.equal(Object.hasOwn(bad.row, 'lastWriteStage'), false);
  const unknownButShaped = await row('scroll', { tab: 10, direction: 'down' }, { info: err('native_target_changed',
    { stage: 'native_window_binding', bindingReason: 'made_up_reason', stages: [{ entered: true, stage: 'made_up_stage', delivery: 'sent' }] }) });
  assert.equal(Object.hasOwn(unknownButShaped.row, 'bindingReason'), false, 'unknown but well-formed values are dropped by the existing enum');
  assert.equal(Object.hasOwn(unknownButShaped.row, 'lastWriteStage'), false);
  const none = await row('scroll', { tab: 10, direction: 'down' }, { info: err('chrome_error', { stage: 'find_tab_windows' }) });
  assert.equal(Object.hasOwn(none.row, 'bindingReason'), false);
  assert.equal(Object.hasOwn(none.row, 'lastWriteStage'), false);
});

await check('kept: a successful call logs none of the new fields', async () => {
  const { r, row: x } = await row('list_tabs', {}, {});
  assert.equal(r.isError, undefined);
  for (const k of ['firstErrorCode', 'firstErrorStage', 'firstErrorOsStatus', 'bindingReason', 'lastWriteStage']) assert.equal(Object.hasOwn(x, k), false, k);
});

/* ---------------------------------------------------- CRASH1 goal 5 (contracts-batch3 ruling r1, point 3)
 * A helper's caught Objective-C exception (nativeReadReason objc_exception, exceptionName) reaches the receipt and the
 * activity row; a name that is not an identifier is dropped everywhere. The helper is a fake chromectl answering the
 * production runDriver (loaded from src/bridge.js into a vm, as metadata-recovery does); the cgevent path keeps the
 * native reply on error.reply, as sessionError does. */
const { humanMessage, sessionError } = await import('../src/bridge.js');
const bridgeSource = await readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
const bridgeFunction = name => {
  const start = bridgeSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name); return bridgeSource.slice(start, bridgeSource.indexOf('\n}', start) + 2);
};
let helperReply;   // the fake chromectl's one JSON line
const driver = vm.createContext({ BridgeError, humanMessage, sessionError, JSON, WARM_ON: false, CHROMECTL: '/fake/chromectl',
  process: { env: {}, stderr: { write() {} } }, takeWarm: () => null, beforeReadRetry() {},
  runWarm: async () => { throw new Error('no warm helper in log-os test'); },
  execFileP: async () => ({ stdout: JSON.stringify(helperReply) + '\n', stderr: '' }) });
vm.runInContext(['driverFailureFacts', 'runDriver'].map(bridgeFunction).join('\n'), driver);
const objcRead = (exceptionName = 'NSUnknownKeyException') => ({ ok: false, error: 'native_read_unknown', stage: 'native_read',
  nativeReadPoint: 'windows', nativeReadReason: 'objc_exception', exceptionName });
const BAD_NAMES = ['has space', 'NS-Bad', '9starts', '', 'x'.repeat(65), 'NSRangeException\n',
  "[<SBApplication 0x1> valueForUndefinedKey:]: this class is not key value coding-compliant for the key windows.", 7, null, ['NSRangeException'], {}];
const helperRow = async reply => { helperReply = reply; return row('scroll', { tab: 10, direction: 'down' }, { helper: true }); };

await check('new-fix (CRASH1): activityRecord keeps exceptionName only as an identifier', () => {
  assert.equal(rec({ exceptionName: 'NSUnknownKeyException' }).exceptionName, 'NSUnknownKeyException');
  assert.equal(rec({ exceptionName: '_a9' }).exceptionName, '_a9');
  assert.equal(rec({ exceptionName: 'A'.repeat(64) }).exceptionName, 'A'.repeat(64));
  for (const bad of BAD_NAMES) assert.equal(Object.hasOwn(rec({ exceptionName: bad }), 'exceptionName'), false, String(bad));
});

await check('new-fix (CRASH1): runDriver keeps objc_exception and a valid exceptionName from the helper reply', async () => {
  helperReply = objcRead();
  await assert.rejects(driver.runDriver(['info'], 10), e => {
    assert.ok(e instanceof BridgeError); assert.equal(e.code, 'native_read_unknown'); assert.equal(e.stage, 'native_read');
    assert.equal(e.nativeReadPoint, 'windows'); assert.equal(e.nativeReadReason, 'objc_exception');
    assert.equal(e.exceptionName, 'NSUnknownKeyException'); return true;
  });
  // chromectl's own boundary failure (sbFailure): chrome_error at eval_result; only the name is kept, not sbKey/sbOperation.
  helperReply = { ok: false, error: 'chrome_error', stage: 'eval_result', noRetry: true, exceptionName: 'NSInvalidArgumentException',
    sbOperation: 'perform', sbKey: 'executeJavascript:', message: 'x' };
  await assert.rejects(driver.runDriver(['eval', '/fake/tmp/a.js'], 10), e => {
    assert.equal(e.code, 'chrome_error'); assert.equal(e.stage, 'eval_result'); assert.equal(e.exceptionName, 'NSInvalidArgumentException');
    assert.equal(Object.hasOwn(e, 'sbKey'), false); assert.equal(Object.hasOwn(e, 'sbOperation'), false); return true;
  });
  for (const bad of BAD_NAMES) {
    helperReply = objcRead(bad);
    await assert.rejects(driver.runDriver(['info'], 10), e => {
      assert.equal(Object.hasOwn(e, 'exceptionName'), false, String(bad)); assert.equal(e.nativeReadReason, 'objc_exception'); return true;
    });
  }
});

await check('new-fix (CRASH1 r2): runDriver keeps noRetry from the helper failure (executeJavascript: may have run)', async () => {
  helperReply = { ok: false, error: 'chrome_error', stage: 'eval_result', noRetry: true, exceptionName: 'NSInvalidArgumentException' };
  await assert.rejects(driver.runDriver(['eval', '/fake/tmp/a.js'], 10), e => {
    assert.equal(e.code, 'chrome_error'); assert.equal(e.stage, 'eval_result'); assert.equal(e.noRetry, true); return true;
  });
  // Only a literal true counts; anything else adds nothing.
  for (const value of ['true', 1, false, null, {}]) {
    helperReply = { ok: false, error: 'chrome_error', stage: 'eval_result', noRetry: value };
    await assert.rejects(driver.runDriver(['eval', '/fake/tmp/a.js'], 10), e => { assert.equal(Object.hasOwn(e, 'noRetry'), false, String(value)); return true; });
  }
});

await check('new-fix (CRASH1): a chromectl objc_exception failure reaches the receipt and the activity row', async () => {
  const { r, row: x } = await helperRow(objcRead());
  assert.equal(r.isError, true);
  const receipt = r.structuredContent.error;
  assert.equal(receipt.code, 'native_read_unknown'); assert.equal(receipt.stage, 'native_read');
  assert.equal(receipt.nativeReadPoint, 'windows'); assert.equal(receipt.nativeReadReason, 'objc_exception');
  assert.equal(receipt.exceptionName, 'NSUnknownKeyException');
  assert.equal(x.code, 'native_read_unknown'); assert.equal(x.stage, 'native_read'); assert.equal(x.exceptionName, 'NSUnknownKeyException');
  assert.ok(!JSON.stringify({ receipt, x }).includes('coding-compliant'));
});

await check('new-fix (CRASH1): a cgevent objc_exception failure (native reply on error.reply) reaches the receipt and the row', async () => {
  const native = (name) => Object.assign(new BridgeError('native_read_unknown', 'native read private page text'),
    { stage: 'native_read', reply: objcRead(name) });
  const { r, row: x } = await row('scroll', { tab: 10, direction: 'down' }, { info: native('NSUnknownKeyException') });
  const receipt = r.structuredContent.error;
  assert.equal(receipt.nativeReadReason, 'objc_exception'); assert.equal(receipt.nativeReadPoint, 'windows');
  assert.equal(receipt.exceptionName, 'NSUnknownKeyException'); assert.equal(x.exceptionName, 'NSUnknownKeyException');
  for (const bad of BAD_NAMES.filter(b => typeof b === 'string')) {
    const dropped = await row('scroll', { tab: 10, direction: 'down' }, { info: native(bad) });
    assert.equal(Object.hasOwn(dropped.r.structuredContent.error, 'exceptionName'), false, bad);
    assert.equal(Object.hasOwn(dropped.row, 'exceptionName'), false, bad);
    assert.equal(dropped.r.structuredContent.error.nativeReadReason, 'objc_exception');
  }
});

await check('new-fix (CRASH1): a helper failure with a bad name keeps the reason but drops the name end to end', async () => {
  for (const bad of ['has space', 'x'.repeat(65), "this class is not key value coding-compliant"]) {
    const { r, row: x } = await helperRow(objcRead(bad));
    assert.equal(r.structuredContent.error.nativeReadReason, 'objc_exception');
    assert.equal(Object.hasOwn(r.structuredContent.error, 'exceptionName'), false, bad);
    assert.equal(Object.hasOwn(x, 'exceptionName'), false, bad);
  }
});

await check('kept (CRASH1): calls without an exception carry no exceptionName', async () => {
  const ok = await row('list_tabs', {}, {});
  assert.equal(Object.hasOwn(ok.row, 'exceptionName'), false);
  const plain = await helperRow({ ok: false, error: 'native_read_unknown', stage: 'native_read', nativeReadPoint: 'windows', nativeReadReason: 'nil_or_type' });
  assert.equal(plain.r.structuredContent.error.nativeReadReason, 'nil_or_type');
  assert.equal(Object.hasOwn(plain.r.structuredContent.error, 'exceptionName'), false);
  assert.equal(Object.hasOwn(plain.row, 'exceptionName'), false);
});

console.log(`log-os: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
