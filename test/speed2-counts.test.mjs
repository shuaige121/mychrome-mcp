#!/usr/bin/env node
/* SPEED2 (problems-20261101): helper round trips and native dialog probes per action, counted offline through the
 * production callTool path with a fake bridge (nothing reaches Chrome or the input helper), plus the safety property
 * each changed round trip used to provide:
 *  - clickDeliver: the select guard, the native target guard and the baseline observation run together (all three
 *    start before any completes); their refusals keep the old order, and the baseline never reads a challenge page;
 *  - clickReport: waitAck's first read (its probe, then one gated eval) also takes the first observation; a dialog after
 *    the click is still caught before any eval, an unmet ack falls back to the old ack loop, and a failing observation
 *    part keeps the ack's facts.
 * Kept behaviour (r2 ruling: candidates 1 and 4 dropped): the site gate's own probe catches a dialog that opened during
 * a fast screen check; the check before the first typing chunk refuses a field that lost focus after the bind.
 * SPEED2_PRINT=1 prints the per-action counts (the report's before/after table). */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-speed2-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
process.env.CHROME_BRIDGE_NOTIFY = '0';
process.env.CHROME_BRIDGE_AGENT_NAME = 'speed2-test';
process.env.CHROME_BRIDGE_HABITS = 'off';
process.env.CHROME_BRIDGE_MENUBAR = '0';
process.env.CHROME_BRIDGE_LANG = 'zh';
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const idx = await import('../src/index.js');
const T = await import('../src/tabs.js');
const { writeSettings } = await import('../src/settings.js');
const PRINT = process.env.SPEED2_PRINT === '1';
const ONLY = process.env.SPEED2_CASE || null;

/* ------------------------------------------------------------ fixture */

let state, log, fakeB;
const target = id => ({ tabId: id, windowId: 7, chromePid: 42, cgWindow: 70, tabActive: true, minimized: false,
  bounds: { left: 0, top: 0, width: 1200, height: 900 }, url: state.url, title: `t${id}` });
const VIEW = { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900 };
function page(kind, vars, tab) {
  const t = target(tab == null ? 10 : Number(tab));
  if (kind === 'block') {
    if (state.blockErrorAt != null && state.evals >= state.blockErrorAt) return { ok: true, error: 'synthetic' };
    return { ok: true, blocked: state.blockedAt != null && state.evals >= state.blockedAt ? { kind: 'challenge', evidence: 'Just a moment' } : null, target: t };
  }
  if (kind === 'temporal') return { ok: true, fail: 'not_temporal', target: t };
  if (kind === 'locate') {
    if (vars.MODE === 'scroll') return { bounds: t.bounds, view: VIEW, scroller: 'document', points: [{ x: 600, y: 400 }],
      height: 800, scrollTop: 0, max: 5000, target: t };
    if (vars.MODE === 'measure') { state.scrollTop += 800; return { ok: true, scrollTop: state.scrollTop, max: 5000, target: t }; }
    return { bounds: t.bounds, view: VIEW, tag: 'button', text: 'Next', url: state.url,
      aim: { x: 100, y: 112 }, rect: { x: 10, y: 100, width: 200, height: 24 }, visible: { x: 10, y: 100, width: 200, height: 24 },
      hitOk: true, chain: [], target: t };
  }
  if (kind === 'ack') {
    const a = vars.ACK || {};
    if (a.arm) { state.ackToken = a.arm; return { ok: true, armed: true, target: t }; }
    state.ackReads++;
    if (state.navigated || state.ackGone) return { ok: true, armed: false, met: false, target: t };
    const met = state.clicks > 0 && state.ackReads > state.ackLate;
    if (met || a.disarm) state.ackGone = true;   // ack.js removes its listener once met, and on disarm (one-shot)
    return { ok: true, armed: true, met, click: met ? 1 : 0, pointerup: met ? 1 : 0, keyup: 0, target: t };
  }
  if (kind === 'native-select') return { ok: true, nativeSelect: false, target: t };
  if (kind === 'read') {
    state.contentReads++;
    if (vars.READ?.actionSnapshot) return { ok: true, controls: [], controlsComplete: true };
    return { ok: true, text: '=== 这一屏\n[1] 按钮 Next', count: 1, hint: '', opaque: 0, outline: [], target: t };
  }
  if (kind === 'click-observation') {
    if (state.clicks > 0 && state.obsThrow > 0) { state.obsThrow--; throw new Error('synthetic observation failure'); }
    state.contentReads++;
    const changed = state.clicks > 0 && !state.noChange;
    return { ok: true, href: state.url, texts: changed ? ['Done'] : ['Next'], dialogs: [], complete: true, busy: false,
      renderedHash: changed ? 2 : 1, scrollX: 0, scrollY: 0, targetState: null };
  }
  if (kind === 'after') {
    const expect = vars.EXPECT;
    return { ok: true, hasFocus: true, activeEditable: true, activeIsTarget: true, bound: true,
      bindingMatches: !!vars.BIND?.check && !state.fieldMoved, selectionStable: !!vars.BIND?.check && !state.fieldMoved,
      selectionAll: true, href: state.url, focusMoved: !!state.fieldMoved, changed: state.value !== '',
      fieldHasText: expect != null && state.value.endsWith(expect), confirmedChars: expect != null ? [...expect].length : 0, target: t };
  }
  throw new Error(`unexpected page script ${kind}`);
}
/** A read that takes 30 ms, recorded as it starts and as it ends (the overlap test). */
const span = async k => { state.spans.push(`start ${k}`); await new Promise(r => setTimeout(r, 30)); state.spans.push(`end ${k}`); };
const call = (name, ...a) => { log.push(name); state.calls[name] = (state.calls[name] || 0) + 1; };
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in speed2 test`); }]));
  return Object.assign(fake, {
    pageDialog: async () => {
      call('dialog probe');
      state.probes++;
      if (state.dialogAtProbe != null && state.probes >= state.dialogAtProbe) {
        return { ok: true, open: true, texts: ['Leave site?'], buttons: ['OK'], identity: { tabId: 10, windowId: 7, chromePid: 42, cgWindow: 70 } };
      }
      return { ok: true, open: false };
    },
    ensureScreenAwake: async () => {
      call('screen check');
      if (state.screenMs) await new Promise(r => setTimeout(r, state.screenMs));
      return state.locked ? { locked: true, displays: 1, woke: false } : { locked: false, displays: 1, woke: !!state.woke };
    },
    axInput: async ({ point } = {}) => {
      call('ax probe');
      if (state.spans) await span('ax');
      if (state.axBlocker) return { ok: true, blocker: { appName: 'Notes' }, frontmost: true, windowMatches: true, nodeFound: true };
      return { ok: true, frontmost: true, windowMatches: !state.axChanged, nodeFound: true, documentToken: 'doc1', focusedDocumentToken: 'doc1',
        menuOpen: false, nativeMenuOpen: false, nativePopup: false };
    },
    pageScript: async (kind, vars = {}) => `fakePage(${JSON.stringify(kind)}, ${JSON.stringify(vars)})`,
    evalInPage: async (src, tab) => {
      const kinds = [...src.matchAll(/fakePage\("([\w-]+)"/g)].map(m => m[1]);
      call(`eval ${kinds.join('+')}`);
      state.evals++;
      if (state.spans && state.clicks === 0 && kinds.includes('native-select')) await span('select');
      if (state.spans && state.clicks === 0 && kinds.includes('click-observation')) await span('baseline');
      if (state.selectHang && kinds.includes('native-select')) await new Promise(r => setTimeout(r, 30));
      if (state.selectNative && kinds.includes('native-select')) {
        return { ok: true, nativeSelect: true, marker: 1, target: target(10) };
      }
      return JSON.parse(vm.runInNewContext(src, { fakePage: (k, v) => JSON.stringify(page(k, v, tab)) }));
    },
    chromeInfo: async (tab) => { call('chromeInfo'); return target(tab == null ? 10 : Number(tab)); },
    listTabs: async () => { call('listTabs'); return { ok: true, frontmost: 'WeChat', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
      tabs: [{ id: 10, url: state.url, title: 't10', active: true }] }] }; },
    openInputSession: async () => {
      call('session spawn');
      let held = false;
      return {
        request: async req => {
          call(`session ${req.op}`);
          if (req.op === 'click') {
            state.clicks++;
            state.readsAtClick = state.contentReads;
            if (state.navigateOnClick) { state.url = 'https://shop.test/next'; state.navigated = true; }
            return { ok: true, epoch: 1, landed: { x: 100, y: 112 }, timing: {}, inputDelivery: 'sent' };
          }
          if (req.op === 'hold') { held = true; return { ok: true, epoch: 1, pointer: { x: 10, y: 20 }, heldAt: Date.now() }; }
          if (req.op === 'recordNativeScene') return { ok: true, epoch: 1, restoreToken: 'r'.repeat(64) };
          if (req.op === 'type' || req.op === 'paste') {
            state.value += req.text;
            return { ok: true, epoch: 1, typed: [...req.text.replace(/\r\n/g, '\n')].length, postedInput: req.text.length };
          }
          if (req.op === 'wheel') return { ok: true, epoch: 1, sent: req.notches };
          if (req.op === 'routed') return { ok: true, allToChrome: true, ms: 1 };
          if (req.op === 'veil') return { ok: true, held, takeover: { active: held } };
          return { ok: true, epoch: 1, operationId: req.operationId, stages: [], inputDelivery: req.op === 'nativeChrome' ? 'sent' : undefined,
            inputMonitor: true, takeover: { active: held }, ...(req.op === 'warp' ? { verified: true, warped: req.to } : {}) };
        },
        close: async () => { call('session close'); held = false; return { ok: true, takeover: { active: false } }; },
      };
    },
    snapshotScene: async () => { call('scene'); return { appPid: 99, chromeWindow: 7, chromeTab: 10 }; },
    restoreScene: async (_scene, options) => { call('restoreScene'); await options.native({ kind: 'restoreScene' }, { policy: 'restore' }); return { ok: true, appFrontmost: true }; },
    activateChrome: async (id, hint, opts) => {
      call('activateChrome');
      await opts.native({ kind: 'activate', tabId: id, windowId: hint?.windowId ?? 7 });
      return { ok: true, targetOnTop: true, ...target(id), frontmostPid: 42, keyWindowIsTarget: true,
        geometry: { mode: 'fit-current', beforeBounds: { ...target(id).bounds }, displayId: 1, branch: 'usable', changed: false, possiblyChanged: false } };
    },
    openNavigationObserver: async () => { call('navigation observer'); return { startedAt: Date.now(), untouched: async () => true, close: async () => {} }; },
    cgevent: async (args) => {
      call(`cgevent ${args[0]}`);
      if (args[0] === 'displays') return { displays: [] };
      if (args[0] === 'mousepos') return { x: 10, y: 20 };
      if (args[0] === 'windowsat') return { windows: [{ pid: 42, owner: 'Google Chrome', layer: 0, bounds: { x: 0, y: 0, w: 1200, h: 900 } }] };
      if (args[0] !== 'idle') throw new Error(`B.cgevent ${args[0]} reached in speed2 test`);
      return { ok: true, idle: 100, keyIdle: 100, held: [], clickIdle: 100 };
    },
  });
}
async function world(extra = {}) {
  idx.__resetPanelTaskForTests();
  idx.__resetLedgerForTests();
  idx.__resetTypedForTests();
  idx.__resetNativeTargetsForTests();
  writeSettings({ inputMode: 'auto', inputSpeed: 3 });
  state = { url: 'https://shop.test/form', value: '', calls: {}, probes: 0, evals: 0, clicks: 0, ackReads: 0, ackLate: 0,
    contentReads: 0, scrollTop: 0, ...extra };
  log = [];
  idx.__setBridgeForTests(fakeB = fakeBridge());
  await T.registerTab(10, state.url, { windowId: 7, agentName: 'speed2-test' });
}
const tool = async (name, args) => {
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError, error: r.structuredContent?.error || null };
};
/** Every helper round trip: chromectl reads, cgevent, AX, session requests (pageScript builds a string locally). */
const roundTrips = () => log.filter(e => e !== 'session spawn').length;
const count = re => log.filter(e => re.test(e)).length;
const INPUT = /^session (hold|click|key|type|paste|wheel|move|nativeChrome)$|^activateChrome$/;

let passed = 0, failed = 0;
const table = [];
async function check(name, fn) {
  if (ONLY && name !== ONLY) return;
  try { await fn(); passed++; console.log(`  ok  [${name}]`); }
  catch (e) { failed++; console.error(`  FAIL [${name}]\n${e.stack}`); }
}
function measure(label) {
  const row = { label, probes: count(/^dialog probe$/), evals: count(/^eval /), roundTrips: roundTrips() };
  table.push(row);
  if (PRINT) console.log(`  count  ${label}: dialog probes ${row.probes}, page evals ${row.evals}, helper round trips ${row.roundTrips}\n         ${log.join(' | ')}`);
  return row;
}

/* ------------------------------------------------------------ counts per action (the AFTER numbers are asserted) */

await check('count-click', async () => {
  await world();
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /新出现：Done/);
  assert.equal(state.clicks, 1);
  const row = measure('click (content changes)');
  // Entry: 2 probes (as at HEAD). After the hand-back: 1 probe + 1 eval for ack and first observation (was 2 + 2).
  assert.equal(row.probes, 3, log.join(' | '));
  assert.equal(row.evals, 6, log.join(' | '));
});

await check('count-click-navigation', async () => {
  await world({ navigateOnClick: true });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /URL已变/);
  const row = measure('click with navigation');
  assert.equal(row.probes, 3, log.join(' | '));
  assert.equal(row.evals, 6, log.join(' | '));
});

await check('count-type', async () => {
  await world();
  const r = await tool('type_text', { tab: 10, marker: 1, text: 'hello', input_mode: 'keys' });
  assert.equal(r.isError, false, r.text);
  assert.equal(state.value, 'hello');
  const row = measure('type_text (5 chars, marker)');
  assert.equal(row.probes, 3, log.join(' | '));   // entry 2 + the focus click's ack read 1 (as at HEAD)
  assert.equal(count(/^eval (block\+)?after$/), 3, `bind, check before the first chunk, confirm (as at HEAD): ${log.join(' | ')}`);
});

await check('count-scroll', async () => {
  await world();
  const r = await tool('scroll', { tab: 10, direction: 'down' });
  assert.equal(r.isError, false, r.text);
  const row = measure('scroll (1 screen)');
  assert.equal(row.probes, 2, log.join(' | '));   // as at HEAD
});

await check('count-read', async () => {
  await world();
  const r = await tool('read_page', { tab: 10 });
  assert.equal(r.isError, false, r.text);
  const row = measure('read_page');
  assert.equal(row.probes, 1, log.join(' | '));   // unchanged (P2 already)
});

/* ------------------------------------------------------------ the safety property of each removed call */

await check('entry-dialog', async () => {
  // The single entry probe still refuses an open dialog before any eval, session or input.
  await world({ dialogAtProbe: 1 });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'page_dialog', r.text);
  assert.equal(count(/^eval /), 0, log.join(' | '));
  assert.equal(count(INPUT), 0, log.join(' | '));
  assert.equal(count(/^session spawn$/), 0, log.join(' | '));
});

await check('entry-fast-dialog', async () => {
  // Kept (r2 ruling A1): a fast screen check (no wake, well under 500 ms) during which a dialog opens. The site gate's
  // own probe, right before its eval, refuses with page_dialog and zero eval.
  await world({ dialogAtProbe: 2 });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.error?.code, 'page_dialog', r.text);
  assert.deepEqual(log, ['dialog probe', 'screen check', 'dialog probe'], log.join(' | '));
  assert.equal(count(/^eval /), 0, log.join(' | '));
  assert.equal(count(INPUT), 0, log.join(' | '));
});

await check('entry-precedence', async () => {
  // A dialog and a locked screen together: the dialog refusal still comes first (old precedence).
  await world({ dialogAtProbe: 1, locked: true });
  idx.__setCallBudgetForTests(1500);
  let r;
  try { r = await tool('click', { tab: 10, marker: 1 }); } finally { idx.__setCallBudgetForTests(100_000); }
  assert.equal(r.error?.code, 'page_dialog', r.text);
  assert.equal(count(INPUT), 0, log.join(' | '));
  // A locked screen alone: refused (it waits for the unlock within the call budget), with no eval and no input.
  await world({ locked: true });
  idx.__setCallBudgetForTests(1500);
  try {
    const s = await tool('click', { tab: 10, marker: 1 });
    assert.equal(s.isError, true, s.text);
    assert.notEqual(s.error?.code, 'page_dialog', s.text);
    assert.equal(count(/^eval /), 0, log.join(' | '));
    assert.equal(count(INPUT), 0, log.join(' | '));
  } finally { idx.__setCallBudgetForTests(100_000); }
});

await check('deliver-select-first', async () => {
  // The select guard refuses first even though the AX guard would refuse too (old order), with no click.
  await world({ selectNative: true, axBlocker: true, selectHang: true });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.error?.code, 'use_select_option', r.text);
  assert.equal(state.clicks, 0);
  // The AX read succeeds while the select guard refuses: still use_select_option, no click.
  await world({ selectNative: true, selectHang: true });
  const r2 = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r2.error?.code, 'use_select_option', r2.text);
  assert.equal(state.clicks, 0);
});

await check('deliver-target-covered', async () => {
  await world({ axBlocker: true });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.error?.code, 'target_covered', r.text);
  assert.equal(state.clicks, 0);
});

await check('deliver-baseline-gated', async () => {
  // The document turns into a challenge between the preflight and the click: the baseline read (now concurrent with the
  // select guard) reads nothing on it, and no click is sent.
  await world();
  state.blockedAt = 1e9;
  const orig = fakeB.evalInPage;
  idx.__setBridgeForTests({ evalInPage: async (src, tab) => {
    if (/fakePage\("native-select"/.test(src) || /fakePage\("click-observation"/.test(src)) state.blockedAt = 0;
    return orig(src, tab);
  } });
  const before = state.contentReads;
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.error?.code, 'site_blocked', r.text);
  assert.equal(state.clicks, 0);
  assert.equal(state.contentReads, before, 'a content script ran on the challenge document');
});

await check('deliver-baseline-own-gate', async () => {
  // Only the baseline's eval sees the challenge (the select guard's gate came back clean a moment earlier): the baseline
  // runs no content script on it, and the click is not sent (it no longer sits behind the select guard's gate).
  await world();
  const orig = fakeB.evalInPage;
  idx.__setBridgeForTests({ evalInPage: async (src, tab) => {
    if (state.clicks === 0 && /fakePage\("click-observation"/.test(src)) {
      state.blockedAt = 0;
      try { return await orig(src, tab); } finally { state.blockedAt = null; }
    }
    return orig(src, tab);
  } });
  const before = state.contentReads;
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.error?.code, 'site_blocked', r.text);
  assert.equal(r.error?.inputDelivery, 'not_sent', r.text);
  assert.equal(state.clicks, 0);
  assert.equal(state.contentReads, before, 'a content script ran on the challenge document');
});

await check('deliver-overlap', async () => {
  // r2 (a): the select guard's eval, the native target guard's AX read and the baseline eval all start before any of
  // them completes; the click follows only after all three ended.
  await world({ spans: [] });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.isError, false, r.text);
  const sp = state.spans, firstEnd = sp.findIndex(x => x.startsWith('end '));
  assert.deepEqual(sp.slice(0, firstEnd).sort(), ['start ax', 'start baseline', 'start select'], sp.join(' | '));
  assert.equal(sp.length, 6, sp.join(' | '));
  const clickAt = log.indexOf('session click');
  assert.ok(clickAt > log.lastIndexOf('ax probe') && clickAt > log.findIndex(e => /native-select/.test(e)), log.join(' | '));
});

await check('report-observation-error', async () => {
  // r2 (b): the observation part of the combined first read throws after the ack was met (ack.js has removed its
  // listener). The ack stands (seen, read once, not taken for a replaced document); the observation is the loop's next
  // sample, with its own probe, as at HEAD.
  const diag = process.env.CHROME_BRIDGE_CLICK_DIAGNOSTICS;
  process.env.CHROME_BRIDGE_CLICK_DIAGNOSTICS = '1';
  try {
    await world({ obsThrow: 1 });
    const r = await tool('click', { tab: 10, marker: 1 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /网页在 \d+ ms 内收到了这次点击/, r.text);
    assert.doesNotMatch(r.text, /换成了新文档|页面事件回执未确认/, r.text);
    assert.match(r.text, /新出现：Done/, r.text);
    assert.equal(state.ackReads, 1, `the ack was read again: ${log.join(' | ')}`);
    const after = log.slice(log.indexOf('session close'));
    assert.deepEqual(after.filter(e => e === 'dialog probe' || e.startsWith('eval ')),
      ['dialog probe', 'eval ack+block+read+click-observation', 'dialog probe', 'eval block+read+click-observation'], after.join(' | '));
    assert.equal(state.clicks, 1);
  } finally { if (diag === undefined) delete process.env.CHROME_BRIDGE_CLICK_DIAGNOSTICS; else process.env.CHROME_BRIDGE_CLICK_DIAGNOSTICS = diag; }
});

await check('report-dialog-after-click', async () => {
  // A dialog that opens after the click is caught by the combined read's probe, before its eval: no eval after it.
  await world();
  const r0 = await tool('click', { tab: 10, marker: 1 });
  const probesPerClick = count(/^dialog probe$/);
  assert.equal(r0.isError, false);
  await world({ dialogAtProbe: probesPerClick });   // the first probe after the hand-back sees the dialog
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /新弹窗：Leave site\?/);
  const last = log.lastIndexOf('dialog probe');
  assert.equal(log.slice(last + 1).filter(e => e.startsWith('eval ')).length, 0, `an eval after the dialog: ${log.join(' | ')}`);
  assert.equal(state.clicks, 1);
});

await check('report-ack-late', async () => {
  // The page has not recorded the click at the first read: the old ack loop takes over (no premature observation result).
  await world({ ackLate: 2 });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /新出现：Done/);
  assert.doesNotMatch(r.text, /页面事件回执未确认/);
  assert.ok(state.ackReads >= 3, `ack reads ${state.ackReads}`);
  assert.equal(state.clicks, 1);
});

await check('report-gate-after-click', async () => {
  // After the click the document is a challenge: the combined read's gate stops it; nothing is read; sent, no retry.
  await world();
  const orig = fakeB.evalInPage;
  idx.__setBridgeForTests({ evalInPage: async (src, tab) => {
    if (state.clicks > 0) state.blockedAt = 0;
    return orig(src, tab);
  } });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.isError, true, r.text);
  assert.equal(r.error?.code, 'site_blocked', r.text);
  assert.equal(r.error?.inputDelivery, 'sent');
  assert.equal(state.clicks, 1);
  assert.equal(state.contentReads, state.readsAtClick, `a content script ran on the challenge document: ${log.join(' | ')}`);
});

await check('type-first-check', async () => {
  // Kept (r2 ruling A2): the bind read returns bound and focused, then focus moves before the check in front of the
  // first chunk: refused (input_unconfirmed, as at HEAD), zero keys.
  await world();
  const orig = fakeB.evalInPage;
  idx.__setBridgeForTests({ evalInPage: async (src, tab) => {
    const r = await orig(src, tab);
    if (/fakePage\("after"/.test(src) && /"set"/.test(src)) { state.fieldMoved = true; return { ...r, bound: true, hasFocus: true }; }
    return r;
  } });
  const m = await tool('type_text', { tab: 10, marker: 1, text: 'abc', input_mode: 'keys' });
  assert.equal(m.isError, true, m.text);
  assert.equal(m.error?.code, 'input_unconfirmed', m.text);
  assert.equal(count(/^session (type|key|paste)$/), 0, log.join(' | '));
  assert.equal(state.value, '');
  // With replace, as at HEAD: bind, check, Cmd+A, select-all check, check before the chunk, confirm.
  await world();
  const r = await tool('type_text', { tab: 10, marker: 1, text: 'abc', input_mode: 'keys', replace: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(count(/^eval (block\+)?after$/), 5, log.join(' | '));
});

if (PRINT) for (const r of table) console.log(`  table  ${r.label} | ${r.probes} | ${r.evals} | ${r.roundTrips}`);
idx.__resetPanelTaskForTests();
console.log(`\nspeed2-counts: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
