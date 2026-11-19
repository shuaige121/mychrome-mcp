#!/usr/bin/env node
/* R-text (problems-20261101): refusal wording for covered targets, window_covered (F3/F4), the routine dialog owner (DQ)
 * and tab_hidden. Everything goes through the production callTool / production functions with only external reads faked
 * (fake bridge, fake cgevent windowsat, fake registry); nothing reaches Chrome, the screen, the mouse or the keyboard.
 * R_TEXT_GROUP=new|kept runs one group. "new" groups fail with the fix reverted; "kept" groups pass on both sides. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-rtext-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
process.env.CHROME_BRIDGE_NOTIFY = '0';
process.env.CHROME_BRIDGE_AGENT_NAME = 'rtext-test';
process.env.CHROME_BRIDGE_HABITS = 'off';
process.env.CHROME_BRIDGE_MENUBAR = '0';
process.env.CHROME_BRIDGE_LANG = 'zh';
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const idx = await import('../src/index.js');
const T = await import('../src/tabs.js');
const { writeSettings } = await import('../src/settings.js');
const GROUP = process.env.R_TEXT_GROUP || null;

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
    if (vars.MODE === 'scroll') return { bounds: t.bounds, view: VIEW, scroller: 'document', points: state.points || [{ x: 600, y: 400 }],
      height: 800, scrollTop: 0, max: 5000, target: t };
    if (vars.MODE === 'measure') { state.scrollTop += 800; return { ok: true, scrollTop: state.scrollTop, max: 5000, target: t }; }
    return { bounds: t.bounds, view: VIEW, tag: 'button', text: 'Next', url: state.url,
      aim: { x: 100, y: 112 }, rect: { x: 10, y: 100, width: 200, height: 24 }, visible: { x: 10, y: 100, width: 200, height: 24 },
      hitOk: !state.domCover, hitBy: state.domCover, chain: [], target: t };
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
      if (state.axBlocker !== undefined) return { ok: true, blocker: state.axBlocker, frontmost: true, windowMatches: true, nodeFound: true };
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
    chromeInfo: async (tab) => { call('chromeInfo'); return { ...target(tab == null ? 10 : Number(tab)), ...(state.info || {}) }; },
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
      if (args[0] === 'displays') return state.screenOk ? { locked: false, displaysAsleep: false, displays: [{ id: 1 }] } : { displays: [] };
      if (args[0] === 'mousepos') return { x: 10, y: 20 };
      if (args[0] === 'windowsat') {
        if (state.windowsat) return state.windowsat(args);
        return { windows: [{ pid: 42, owner: 'Google Chrome', layer: 0, bounds: { x: 0, y: 0, w: 1200, h: 900 } }] };
      }
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
  await T.registerTab(10, state.url, { windowId: 7, agentName: 'rtext-test' });
}
const tool = async (name, args) => {
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError, error: r.structuredContent?.error || null };
};
/** Every helper round trip: chromectl reads, cgevent, AX, session requests (pageScript builds a string locally). */
const roundTrips = () => log.filter(e => e !== 'session spawn').length;
const count = re => log.filter(e => re.test(e)).length;
const INPUT = /^session (hold|click|key|type|paste|wheel|move|nativeChrome)$|^activateChrome$/;


/* ------------------------------------------------------------ groups */

let passed = 0, failed = 0;
async function check(group, name, fn) {
  if (GROUP && group !== GROUP) return;
  try { await fn(); passed++; console.log(`  ok  [${group}] ${name}`); }
  catch (e) { failed++; console.error(`  FAIL [${group}] ${name}\n${e.stack}`); }
}
const CHROME = { pid: 42, owner: 'Google Chrome', layer: 0, alpha: 1, bounds: { x: 0, y: 0, w: 1200, h: 900 } };
const WIN = (owner, pid = 900, extra = {}) => ({ pid, owner, layer: 3, alpha: 1, bounds: { x: 0, y: 0, w: 900, h: 700 }, ...extra });
const NOT_REPEAT = /不要重复同一点击/;

/* --- the three covered-target kinds (click through callTool) --- */

await check('new', 'native blocker with a known app: names it, says do not repeat, tells the user in chat, not wait_for_user', async () => {
  await world({ axBlocker: { appName: 'ChatGPT', pid: 800, title: 'SECRET TITLE' } });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.error?.code, 'target_covered', r.text);
  assert.equal(r.error?.targetCoveredSource, 'native_point_blocker');
  assert.match(r.text, /「ChatGPT」的窗口盖住了/);
  assert.match(r.text, NOT_REPEAT);
  assert.match(r.text, /告诉用户把「ChatGPT」窗口移开或关掉/);
  assert.match(r.text, /wait_for_user 在地址变化时才结束，移动窗口不会触发它/);
  assert.doesNotMatch(r.text, /SECRET TITLE/);
  assert.equal(state.clicks, 0);
});

await check('new', 'native blocker with an unknown app: neutral wording, same hand-off, same source fact', async () => {
  for (const blocker of [{}, { appName: '' }, { appName: 42 }]) {
    await world({ axBlocker: blocker });
    const r = await tool('click', { tab: 10, marker: 1 });
    assert.equal(r.error?.code, 'target_covered', r.text);
    assert.equal(r.error?.targetCoveredSource, 'native_point_blocker');
    assert.match(r.text, /被另一个窗口（无法确认是哪个应用）盖住了/);
    assert.match(r.text, NOT_REPEAT);
    assert.match(r.text, /告诉用户把那个窗口移开或关掉/);
    assert.doesNotMatch(r.text, /「」|undefined|\[object/);
    assert.equal(state.clicks, 0);
  }
});

await check('new', 'DOM overlay: says it is part of the page and to use read_page / scroll / close it', async () => {
  await world({ domCover: 'div.modal' });
  const r = await tool('click', { tab: 10, marker: 1 });
  assert.equal(r.error?.code, 'target_covered', r.text);
  assert.equal(r.error?.targetCoveredSource, 'dom_hit_test');
  assert.match(r.text, /被「div\.modal」盖住了/);
  assert.match(r.text, /网页自己的元素.*不是别的应用/);
  assert.match(r.text, /read_page/);
  assert.match(r.text, /scroll/);
  assert.match(r.text, /点掉/);
  assert.doesNotMatch(r.text, /告诉用户|wait_for_user/);
  assert.equal(state.clicks, 0);
});

await check('kept', 'covered kinds: codes, source facts and "no click" are unchanged', async () => {
  for (const [extra, source] of [[{ axBlocker: { appName: 'Notes' } }, 'native_point_blocker'], [{ domCover: 'x' }, 'dom_hit_test']]) {
    await world(extra);
    const r = await tool('click', { tab: 10, marker: 1 });
    assert.deepEqual([r.error?.code, r.error?.targetCoveredSource, state.clicks], ['target_covered', source, 0]);
    assert.match(r.text, /没有点击/);
  }
});

/* --- the 3-attempt covered replay: refused every time, takeover counts exactly as without a cache --- */

const TAKEOVER = /^session (hold|click|key|type|paste|wheel|move|nativeChrome)$|^activateChrome$|^scene$|^restoreScene$|^session spawn$|^session close$/;
const takeoverCounts = () => {
  const out = {};
  for (const e of log) if (TAKEOVER.test(e)) out[e] = (out[e] || 0) + 1;
  return out;
};
await check('kept', 'three attempts at the same native-covered target: refused three times, no click, takeover counts per attempt unchanged', async () => {
  await world({ axBlocker: { appName: 'ChatGPT' } });
  const one = await tool('click', { tab: 10, marker: 1 });
  assert.equal(one.error?.code, 'target_covered', one.text);
  const perAttempt = takeoverCounts();
  const probesPer = count(/^ax probe$/);
  assert.ok(probesPer >= 1, 'the AX probe runs on the first attempt');
  await world({ axBlocker: { appName: 'ChatGPT' } });
  const texts = [];
  for (let i = 0; i < 3; i++) {
    const r = await tool('click', { tab: 10, marker: 1 });
    assert.equal(r.error?.code, 'target_covered', `attempt ${i + 1}: ${r.text}`);
    assert.equal(r.error?.targetCoveredSource, 'native_point_blocker');
    texts.push(r.text);
  }
  assert.equal(state.clicks, 0, 'never a click through the covering window');
  assert.equal(new Set(texts).size, 1, 'every attempt is refused with the same text');
  // No cache: attempt N costs what attempt 1 cost. Exactly three times the per-attempt counts.
  const total = takeoverCounts();
  for (const k of new Set([...Object.keys(perAttempt), ...Object.keys(total)])) {
    assert.equal(total[k] || 0, 3 * (perAttempt[k] || 0), `takeover count ${k}: ${JSON.stringify(total)} vs ${JSON.stringify(perAttempt)}`);
  }
  assert.equal(count(/^ax probe$/), 3 * probesPer, 'the AX probe re-validates the point on every attempt (no cache)');
  console.log(`     takeover counts for 3 attempts: ${JSON.stringify(total)}, ax probes ${count(/^ax probe$/)}`);
});

/* --- F3: window_covered (scroll) --- */

const scrollWith = async (windowsat, extra = {}) => { await world({ windowsat, ...extra }); return tool('scroll', { tab: 10, direction: 'down' }); };

await check('new', 'F3: a ChatGPT window on top: the message names it, says a retry does not help, hands off in chat', async () => {
  const r = await scrollWith(() => ({ windows: [WIN('ChatGPT'), CHROME] }));
  assert.equal(r.error?.code, 'window_covered', r.text);
  assert.match(r.text, /被「ChatGPT」的窗口挡住了/);
  assert.match(r.text, /重试没有用，不要重复同一滚动/);
  assert.match(r.text, /在聊天里告诉用户把「ChatGPT」窗口移开或关掉/);
  assert.equal(count(/^session wheel$/), 0, 'no wheel into the covering window');
});

await check('new', 'F3: only Chrome on top passes; another Chrome window on top is named as such', async () => {
  const ok = await scrollWith(() => ({ windows: [CHROME] }));
  assert.equal(ok.isError, false, ok.text);
  const otherChrome = { ...CHROME, bounds: { x: 10, y: 10, w: 800, h: 600 } };
  const r = await scrollWith(() => ({ windows: [otherChrome, CHROME] }));
  assert.equal(r.error?.code, 'window_covered', r.text);
  assert.match(r.text, /被另一个 Chrome 窗口挡住了/);
});

await check('new', 'F3: windowsat that throws is "could not check", not covered; still no scroll, same code', async () => {
  const r = await scrollWith(() => { throw new Error('cgevent windowsat failed'); });
  assert.equal(r.error?.code, 'window_covered', r.text);
  assert.match(r.text, /没能检查/);
  assert.match(r.text, /这不表示它被挡住了/);
  assert.doesNotMatch(r.text, /被.*挡住了（或找不到/);
  assert.equal(count(/^session wheel$/), 0);
  // Mixed: the first point unreadable, a later one reads and is covered -> the cover is named (it is evidence).
  let n = 0;
  const mixed = await scrollWith(() => { if (n++ === 0) throw new Error('x'); return { windows: [WIN('Slack'), CHROME] }; },
    { points: [{ x: 600, y: 400 }, { x: 700, y: 500 }] });
  assert.equal(mixed.error?.code, 'window_covered', mixed.text);
  assert.match(mixed.text, /被「Slack」的窗口挡住了/);
});

await check('kept', 'F3: the privacy rule: only the owner name reaches the text, never a window title', async () => {
  const r = await scrollWith(() => ({ windows: [WIN('ChatGPT', 900, { title: 'PRIVATE_TITLE', name: 'PRIVATE_NAME' }), CHROME] }));
  assert.doesNotMatch(r.text, /PRIVATE_/);
});

/* --- tab_hidden (screenshot) --- */

await check('new', 'tab_hidden: a background tab and a minimized window are told apart; both say read_page works, screenshot does not switch tabs', async () => {
  const bg = await (async () => { await world({ screenOk: true, info: { tabActive: false } }); return tool('screenshot', { tab: 10 }); })();
  assert.equal(bg.error?.code, 'tab_hidden', bg.text);
  assert.match(bg.text, /标签 10 在后台（不是它窗口的当前标签），这次没有截图/);
  assert.match(bg.text, /这个标签在后台：read_page 可以读，screenshot 不会切换标签、也不会接管键鼠；要截图请等该标签显示后再试/);
  const min = await (async () => { await world({ screenOk: true, info: { minimized: true } }); return tool('screenshot', { tab: 10 }); })();
  assert.equal(min.error?.code, 'tab_hidden', min.text);
  assert.match(min.text, /标签 10 所在窗口已最小化，这次没有截图/);
  assert.match(min.text, /read_page 可以读，screenshot 不会切换标签、也不会接管键鼠；要截图请等窗口还原后再试/);
  const both = await (async () => { await world({ screenOk: true, info: { tabActive: false, minimized: true } }); return tool('screenshot', { tab: 10 }); })();
  assert.match(both.text, /所在窗口已最小化/);
  assert.equal(count(/^session |^activateChrome$/), 0);
});

/* --- DQ: the routine dialog refusal names the owner tab --- */

const { createRoutineRunner, RoutineError, routineMessage } = await import('../src/routine-runner.js');
const { BridgeError } = await import('../src/bridge.js');
const { readFile } = await import('node:fs/promises');
const indexSource = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const production = name => {
  const start = indexSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return indexSource.slice(start, indexSource.indexOf('\n}', start) + 2);
};
const OWNER = 4242;
const dlg = tabId => ({ open: true, texts: ['SYNTHETIC'], buttons: ['OK'], identity: tabId == null ? undefined : { version: 1, tabId, windowId: 1, chromePid: 42, cgWindow: 7 } });
function capture(records, dialog, current = 5) {
  const c = vm.createContext({ Number, Object, RoutineError, BridgeError,
    readTabRecord: async id => { const r = records[id]; if (r instanceof Error) return undefined; return r ?? null; },
    isMine: rec => !!rec && Number(rec.ownerPid) === OWNER,
    B: { pageDialog: async () => dialog, chromeInfo: async () => ({ tabId: current }) } });
  vm.runInContext(['dialogPlace', 'routineCapture'].map(production).join('\n'), c);
  return tab => c.routineCapture(tab, { mode: 'state' });
}
const PLAIN = '页面弹出了需要处理的对话框，流程已暂停。';
const ROUTINE = { id: 'r1', site: 'https://example.test', name: 'T', archived: false, parameters: [],
  steps: [{ tool: 'click', before: { origin: 'https://example.test', path: '/a', fingerprint: '0'.repeat(64) }, after: { origin: 'https://example.test', path: '/b', fingerprint: '1'.repeat(64) },
    target: { version: 1, tag: 'button', role: 'button', name: 'Go' }, args: {} }] };
/** The real runner, whose adapter.inspect is the production routineCapture refusing on a dialog. */
function runnerFor(records, dialog, tab = 17) {
  const cap = capture(records, dialog);
  const runner = createRoutineRunner({
    store: { get: async () => structuredClone(ROUTINE), recordRun: async () => {} },
    adapter: { inspect: async t => { await cap(t); return { page: ROUTINE.steps[0].before }; }, resolve: async () => ({ ok: true, marker: 1, targetState: {} }),
      begin: async () => {}, act: async () => ({ ok: true }), finish: async () => {} },
    wait: async () => {} });
  return { runner, request: { id: 'r1', tab, nonce: 'nonce-a', params: {} } };
}
const dqCases = [
  ['own', { 9: { ownerPid: OWNER } }, 9, 'mine', /对话框在标签 9（你自己的标签）：用 answer_dialog（tab=9）处理后，再重新开始流程。$/],
  ['another agent\'s', { 9: { ownerPid: 7 } }, 9, 'agent', /对话框在标签 9（另一个 agent 的标签），不是你的标签：不要替它按按钮，告诉用户去处理。$/],
  ['the user\'s', { 9: { ownerPid: OWNER, takenOver: true } }, 9, 'user', /对话框在标签 9（用户的标签），不是你的标签：不要替它按按钮，告诉用户去处理。$/],
];
await check('new', 'DQ: routineCapture names the owner tab (own / another agent\'s / the user\'s) through the real runner receipt', async () => {
  for (const [label, records, tab, who, re] of dqCases) {
    const { runner, request } = runnerFor(records, dlg(9), tab);
    const out = await runner.run(request);
    assert.equal(out.status, 'blocked', label);
    assert.equal(out.code, 'page_dialog', `${label}: the code is unchanged`);
    assert.match(out.message, re, label);
    assert.ok(out.message.startsWith(PLAIN), label);
    assert.equal(who === 'mine' || !/answer_dialog/.test(out.message), true, `${label}: only an own dialog suggests answering`);
  }
});
await check('new', 'DQ: the owner forms cross a worker handover; arbitrary text and forged forms do not', async () => {
  for (const [label, records, tab] of dqCases) {
    const { runner, request } = runnerFor(records, dlg(9), tab);
    const out = await runner.run(request);
    assert.match(out.message, /对话框在标签 9（/, `${label}: the receipt names the owner`);
    const carry = JSON.parse(JSON.stringify(runner.exportCarry()));
    const fresh = createRoutineRunner({ store: { get: async () => { throw new Error('unused'); }, recordRun: async () => {} }, adapter: {}, wait: async () => {} });
    assert.equal(fresh.importCarry(carry), 1, label);
    assert.deepEqual(fresh.status({ nonce: 'nonce-a' }), out, label);
    // Strictness: any other text is refused, including near-misses of the exact forms.
    const forged = text => ({ version: 1, entries: [{ ...carry.entries[0], receipt: { ...carry.entries[0].receipt, message: text } }] });
    const own = carry.entries[0].receipt.message;
    for (const bad of [own + ' 多余', own.replace('标签 9', '标签 0'), own.replace('标签 9', '标签 9x'), own.replace('标签 9', '标签 -9'),
      PLAIN + '对话框在标签 9（别人的标签）：随便写', PLAIN + '对话框在标签 9（用户的标签），不是你的标签：不要替它按按钮，告诉用户去处理。\nPRIVATE', 'PRIVATE_TERMINAL_TEXT']) {
      if (bad === own) continue;
      const f = createRoutineRunner({ store: {}, adapter: {}, wait: async () => {} });
      assert.throws(() => f.importCarry(forged(bad)), { code: 'invalid_routine_carry' }, `${label}: ${JSON.stringify(bad)}`);
    }
  }
  // A dialog form is accepted only on a page_dialog receipt.
  const { runner, request } = runnerFor({ 9: { ownerPid: 7 } }, dlg(9), 9);
  await runner.run(request);
  const carry = JSON.parse(JSON.stringify(runner.exportCarry()));
  carry.entries[0].receipt.code = 'page_changed';
  assert.throws(() => createRoutineRunner({ store: {}, adapter: {}, wait: async () => {} }).importCarry(carry), { code: 'invalid_routine_carry' });
});
await check('kept', 'DQ: an unknown owner (no native binding, unreadable registry) keeps today\'s wording and carries as before', async () => {
  for (const [records, dialog] of [[{}, dlg(null)], [{ 9: new Error('unreadable') }, dlg(9)]]) {
    const { runner, request } = runnerFor(records, dialog);
    const out = await runner.run(request);
    assert.equal(out.code, 'page_dialog');
    assert.equal(out.message, PLAIN);
    const fresh = createRoutineRunner({ store: {}, adapter: {}, wait: async () => {} });
    assert.equal(fresh.importCarry(JSON.parse(JSON.stringify(runner.exportCarry()))), 1);
  }
  assert.equal(routineMessage('page_dialog'), PLAIN);
  assert.equal(routineMessage('page_dialog', { dialog: { who: 'nobody', tab: 9 } }), PLAIN);
  assert.equal(routineMessage('page_dialog', { dialog: { who: 'mine', tab: -1 } }), PLAIN);
  assert.equal(routineMessage('page_changed'), '页面状态与录制时不同，已停下，后面的步骤没有执行。');
});
await check('kept', 'DQ: no dialog open: routineCapture does not refuse (reaches the page eval)', async () => {
  const c = vm.createContext({ Number, Object, RoutineError, BridgeError, B: { pageDialog: async () => ({ open: false }), evalInPage: async () => { throw new Error('reached eval'); } },
    gatedPageScript: async () => 'script', passGate: x => x, markBlocked: async () => {}, dialogPlace: async () => { throw new Error('must not be asked'); } });
  vm.runInContext(production('routineCapture'), c);
  await assert.rejects(c.routineCapture(5, { mode: 'state' }), /reached eval/);
});

console.log(`\nrefusal-text: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
