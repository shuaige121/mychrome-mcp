import { pageEventStubs } from './page-event-test-stubs.mjs';
/* Deterministic production input transactions. All native/browser/filesystem
 * effects are injected; no helper process, Apple Event, or UI is opened. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import os from 'node:os';
import path from 'node:path';
import { runInputAction, releaseKept, normalizeReturnFocus, userStopMessage, stopRestoreLine } from '../src/guard.js';
import { BridgeError, UserInterrupted, setupHint, closeTab as nativeCloseTab } from '../src/bridge.js';
import { closeVerdict, checkTakeover } from '../src/tabs.js';
import { redactUrl } from '../src/privacy.js';
import { RoutineError, routineMessage } from '../src/routine-runner.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const terminalLockSource = await fs.readFile(new URL('../src/lock.js', import.meta.url), 'utf8');
function production(name, input = source) {
  const start = input.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return (name === 'callToolInner' ? 'function noticeTerminalRefusal() {}\n' : '') +  input.slice(start, input.indexOf('\n}', start) + 2);
}
function productionConst(name, input = source) {
  const start = input.indexOf(`const ${name} =`);
  assert.ok(start >= 0, name);
  const end = input.indexOf(';\n', start);
  assert.ok(end > start, `${name} declaration boundary`);
  return input.slice(start, end + 1);
}
const target = (tabId = 1, windowId = 10, cgWindow = 70) => ({
  tabId, windowId, cgWindow, chromePid: 42, tabActive: true,
  url: 'https://fixture.test/', bounds: { left: 0, top: 0, width: 1200, height: 900 },
});
const identity = tab => ({ version: 1, tabId: tab.tabId, windowId: tab.windowId,
  chromePid: tab.chromePid, cgWindow: tab.cgWindow, dialogCgWindow: 90, token: 'fixture-dialog', dialogToken: 'd'.repeat(64) });
function harness(options = {}, modifiedSource = source) {
  const events = [], state = { held: false, closed: 0, paused: false, stopped: false, conversation: false,
    display: 'off', existing: 10, scene: { appPid: 9, chromePid: 42, chromeWindow: 10, chromeTab: 1 },
    tabs: new Map([[1, target()], [3, target(3)]]), registered: [], signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
    dialog: false, hasField: true, buttons: ['Cancel', 'OK'], ...options };
  const fail = (code, message = code) => new BridgeError(code, message);
  const no = () => {};
  const session = {
    interrupted: null,
    request: async req => {
      events.push(req.op);
      if (req.op === 'hold') { state.held = true; return { ok: true, epoch: 1, pointer: { x: 5, y: 6 }, heldAt: 1000 }; }
      if (req.op === 'veil' && typeof state.veilReply === 'function') return state.veilReply(req);
      if (req.op === 'veil') return { ok: true, held: state.held };
      if (req.op === 'status') {
        await state.onStatus?.();
        return { ok: true, epoch: state.epoch || 1, interrupted: state.interrupted || null,
          takeover: { active: state.held && !state.lostHold, aborted: state.stopped, abortedBy: state.stopped ? 'esc' : null } };
      }
      if (req.op === 'begin') { state.bound = req.window; return { ok: true, epoch: 1, inputMonitor: true, takeover: { active: state.held } }; }
      if (req.op === 'inspectDialog') {
        const id = state.identity || identity(state.tabs.get(1));
        if (['tabId', 'windowId', 'chromePid', 'cgWindow'].some(k => req.target[k] !== id[k])) throw fail('dialog_ambiguous');
        if (req.dialogToken) {
          events.push('dialog-exact'); state.afterDialogProbe?.();
          if (state.initialDialogToken !== id.token) throw fail('dialog_changed');
        } else state.initialDialogToken = id.token;
        return { ok: true, known: true, open: state.dialog, identity: id, buttons: state.buttons, hasField: state.hasField };
      }
      if (req.op === 'recordNativeScene') { events.push('record-scene'); state.original = { ...req.scene }; return { ok: true, epoch: 1, restoreToken: 'r'.repeat(64) }; }
      if (req.op === 'bindNativeTarget') { state.nativeTarget = req.target; return { ok: true, epoch: 1, target: req.target }; }
      if (req.op === 'nativeChrome') {
        assert.equal(req.epoch, state.epoch || 1);
        assert.equal(state.stopped, false, 'Stop rejects protected native dispatch');
        if (req.policy !== 'restore') assert.equal(state.paused, false, 'Pause rejects normal native dispatch');
        else { assert.equal(req.restoreToken, 'r'.repeat(64)); state.preserveSelection = req.intent.preserveSelection; }
        state.onNative?.(req);
        if (state.nativeReply) return state.nativeReply(req);
        return { ok: true, epoch: state.replyEpoch ?? 1, operationId: req.operationId, inputDelivery: 'sent', stages: [] };
      }
      if (req.op === 'warp') return { ok: true, verified: true, warped: req.to };
      return { ok: true };
    },
    close: async () => { events.push('release'); state.held = false; state.closed++;
      if (state.endVariant === 'session_interrupted') session.interrupted = { kind: 'key', epoch: 1000 };
      if (state.endFailure) throw Error('synthetic missing end');
      return { ok: true, restored: true, released: ['shift'],
        ...(state.endVariant === 'interrupted' ? { interrupted: { kind: 'key', epoch: 1000 } } : {}),
        takeover: { active: false, ...(state.endVariant === 'aborted' ? { aborted: true, abortedBy: state.endAbortedBy || 'esc' } : {}) } }; },
  };
  const assertHeld = kind => { assert.equal(state.held, true, `${kind} requires native hold`); events.push(kind); };
  const owner = { tabId: 1, ownerPid: process.pid, openedAt: 1, windowId: 10,
    expectedUrl: 'https://fixture.test/' };
  const store = {};
  const B = {
    pageDialog: async requested => {
      events.push(requested ? 'dialog-exact' : 'dialog-read');
      if (requested) state.afterDialogProbe?.();
      return state.dialog ? { ok: true, open: true, known: true, title: 'fixture.test',
        buttons: state.buttons, hasField: state.hasField, identity: state.identity || identity(state.tabs.get(1)) } : { ok: true, open: false };
    },
    chromeInfo: async tab => {
      await state.onInfo?.(tab);
      const t = state.tabs.get(tab ?? state.scene.chromeTab);
      if (!t) throw fail('no_such_tab');
      return { ...t };
    },
    listTabs: async () => ({ chromePid: 42, frontmost: 'Chrome', windows: [...new Set([...state.tabs.values()].map(t => t.windowId))].map(id => ({
      id, tabs: [...state.tabs.values()].filter(t => t.windowId === id).map(t => ({ id: t.tabId, active: t.tabId === state.scene.chromeTab, url: t.url })) })) }),
    openTab: async (_url, windowId, opts) => {
      assertHeld('open-tab'); assert.equal(opts.select, false);
      const t = target(2, windowId || 10, 70); state.tabs.set(2, t);
      // Native make-new-tab raises its window, then restores it itself.
      state.scene = { appPid: 42, chromeWindow: t.windowId, chromeTab: 2 };
      state.afterCreate?.();
      if (state.creationError) throw state.creationError;
      return { ok: true, tabId: 2, windowId: t.windowId };
    },
    newWindow: async () => {
      assertHeld('new-window'); state.tabs.set(2, target(2, 20, 80));
      state.scene = { appPid: 42, chromeWindow: 20, chromeTab: 2 };
      state.afterCreate?.();
      if (state.creationError) throw state.creationError;
      return {...state.tabs.get(2),ok:true,geometry:{mode:'placement',beforeBounds:{...state.tabs.get(2).bounds},displayId:1,branch:'usable',changed:false,possiblyChanged:false}};
    },
    answerDialog: async (button, text, expected) => {
      assertHeld('answer'); assert.deepEqual(expected, state.identity || identity(state.tabs.get(1)));
      state.answered = { button, text }; if (state.answerError) throw state.answerError;
      return state.answerReply || { ok: true, pressed: button, inputDelivery: 'sent', sameStillOpen: false };
    },
    closeTab: async (id, opts) => {
      assertHeld('close-tab'); assert.equal(opts.target.tabId, id);
      if (state.closePending) await state.closePending;
      if (state.closeError) throw state.closeError;
      state.tabs.delete(id); return { ok: true };
    },
    selectTab: async (id, opts) => { assertHeld('select-tab'); assert.equal(opts.windowId, state.tabs.get(id).windowId); state.scene.chromeTab = id; return { ok: true }; },
    moveWindow: async (windowId,b,options) => { assertHeld('move-window');const t=state.tabs.get(state.nativeTarget.tabId),beforeBounds={...t.bounds};assert.equal(t.windowId,windowId);
      if(b)for(const row of state.tabs.values())if(row.windowId===windowId)row.bounds={left:b.left,top:b.top,width:b.width??b.right-b.left,height:b.height??b.bottom-b.top};
      return {...t,ok:true,geometry:{mode:b?'placement':'fit-current',beforeBounds,displayId:options.displayId??1,branch:'usable',changed:!!b,possiblyChanged:!!b}}; },
    activateChrome: async id => { assertHeld('activate'); state.scene.appPid = 42;
      return { ...state.tabs.get(id), ok: true, frontmostPid: 42, keyWindowIsTarget: true, targetOnTop: true,
        geometry:{mode:'fit-current',beforeBounds:{...state.tabs.get(id).bounds},displayId:1,branch:'usable',changed:false,possiblyChanged:false} }; },
    snapshotScene: async () => { events.push('snapshot'); return { ...state.scene }; },
    restoreScene: async (scene, opts) => {
      assertHeld('restore'); assert.equal(opts.stopOnInput, false);
      state.scene = { ...scene, ...(state.preserveSelection ? { chromeTab: state.nativeTarget.tabId } : {}) }; return { ok: true, appFrontmost: true };
    },
    restoreApp: async () => { events.push('restore-app'); throw Error('unheld restoreApp is forbidden in these transactions'); },
    cgevent: async args => { assert.equal(args[0], 'mousepos'); return { x: 5, y: 6 }; },
    openNavigationObserver: async () => ({ startedAt: 1000, close: async () => events.push('observer-close'), untouched: async () => true }),
    pageScript: async (name, args) => { if (state.disarmScriptFailure && args?.ASK?.disarm) throw Error('synthetic disarm script failure'); return { name, args }; },
    evalInPage: async script => {
      if (script?.name !== 'ask' || !script.args?.ASK?.disarm) throw Error('unexpected DOM access');
      events.push('disarm'); if (state.disarmFailure) throw Error('synthetic disarm failure');
      return { ok: true, armed: false };
    },
  };
  for (const [name, optionIndex, kind] of [
    ['openTab', 2, 'openTab'], ['newWindow', 3, 'newWindow'], ['answerDialog', 3, 'dialogAnswer'],
    ['closeTab', 1, 'closeTab'], ['selectTab', 1, 'selectTab'], ['moveWindow', 2, 'moveWindow'],
    ['activateChrome', 2, 'activate'], ['restoreScene', 1, 'restoreScene']
  ]) {
    const implementation = B[name];
    B[name] = async (...args) => {
      const route = args[optionIndex]?.native;
      assert.equal(typeof route, 'function', `${name} must use captured native route`);
      if (kind === 'restoreScene') await state.beforeRestore?.();
      const options=args[optionIndex]||{},intent={kind};
      if(kind==='newWindow')Object.assign(intent,{url:args[0],bounds:args[1],profile:args[2],displayId:options.displayId});
      if(kind==='moveWindow')Object.assign(intent,{windowId:args[0],...(args[1]?{bounds:args[1],displayId:options.displayId}:{fitCurrent:options.fitCurrent})});
      if(kind==='activate')Object.assign(intent,{tabId:args[0],windowId:args[1]?.windowId,fitCurrent:options.fitCurrent});
      await route(intent, kind === 'restoreScene' ? { policy: 'restore' } : {});
      return implementation(...args);
    };
  }
  const c = vm.createContext({ ...pageEventStubs,
    normalizeReturnFocus, releaseKept, userStopMessage, stopRestoreLine, B, BridgeError, OWNER_PID: process.pid, process: { pid: process.pid, env: state.env || {} }, Number, String, Math, Map, Set, Error, Date,
    clearTimeout: no, clearInterval: no, randomUUID: () => 'fixture-token',
    CALL: { getStore: () => store }, ROUTINES: { beforeInput: async () => {}, afterInput: async () => {} },
    TAKEOVER: false, TAKEOVER_LIMITS: {}, TASK_LIMITS: {}, TASK_GAP_MS: 0,
    TASK_HOLD: null, TASK_CANCELLED: null, PLAN: null, YIELDING: null, HOLD_ENDING: 0, GUI_SERVICE: null,
    USER_POINTER: null, NATIVE_TARGETS: new Map(), SHOTS:new Map(), GEOMETRY_UNVERIFIED:new Set(), BLOCKS: new Map(), HANDOFFS: new Map(),
    LEDGER: { apply: no, live: () => [], get: () => null, mark: no },
    pausedCheck: () => { if (state.paused) throw fail('paused_by_user', '用户已暂停，这次什么也没做。'); },
    conversationInputCheck: () => { if (state.conversation) throw fail('conversation_waiting'); },
    taskCancelledError: () => fail('user_cancelled'), cancelledError: () => fail('cancelled'),
    taskInterruptedError: () => fail('task_interrupted'),
    taskKey: () => c.PLAN?.task || c.TASK_CANCELLED || c.TASK_HOLD?.task || '',
    screenReady: async () => { state.screenCalls = (state.screenCalls || 0) + 1; return ''; }, siteGate: async () => { if (!state.nonNative) throw Error('DOM site gate must be skipped'); return true; },
    noteAgentDone: async () => {}, noteAgentNavigation: async () => events.push('note-navigation'), ledgerNavigated: no, markTakenOver: async () => events.push('taken-over'),
    waitForHandsOff: async () => { events.push('idle'); state.afterIdle?.(); return 0; },
    waitForUserIdle: async () => { if (!state.nonNative) throw Error('native transaction must hold'); return 0; },
    userActedSince: async () => false, userClickedSince: async () => false,
    openOwnSession: async () => session, runInputAction, lockInfo: () => ({}),
    withInputLock: async (_label, fn, options) => {
      (state.leaseOptions ||= []).push({ kind: 'short', ...options });
      events.push('lease'); try { return { result: await fn(null), waitedMs: 0 }; }
      finally { events.push('lease-release'); }
    },
    acquireLease: async (_label, options) => { events.push('lease'); (state.leaseOptions ||= []).push({ kind: 'task', ...options }); if (state.leaseError) throw state.leaseError; return { release: async () => events.push('lease-release') }; },
    startGap: no, writeTaskState: no, closeTaskFeed: no,
    suspendForConversationReply: async () => {},
    debugLog: no, rememberHeldNavigation: no, heldNavigationAnchor: async () => { if (!state.nonNative) throw Error('native DOM anchor forbidden'); return 'https://fixture.test/'; },
    queueNote: () => '', notifyUserHeld: no,
    WHY_VALUES: ['user_asked', 'same_page_with_user'], agentDisplay: () => state.display,
    resolveProfile: async () => ({ dir: 'Default', name: 'Fixture', isDefault: true }),
    agentWindowId: async () => state.existing, agentWindowBounds: async () => ({left:0,top:0,right:1200,bottom:900, display: { id: 1, isMain: true } }),
    agentState: async () => { await state.beforeAgentState?.(); return { byProfile: state.fakeProfiles || {} }; },
    saveAgentState: async () => { await state.afterAgentSave?.(); },
    DISPLAYS: { at: Date.now(), list: [
      { id: 1, isMain: true, boundsPoints: { x: 0, y: 0, w: 1400, h: 1000 } },
      { id: 2, isMain: false, boundsPoints: { x: 1400, y: 0, w: 1400, h: 1000 } },
    ] },
    inDisplay: (point, display) => point.x >= display.boundsPoints.x && point.x < display.boundsPoints.x + display.boundsPoints.w,
    pickAgentDisplay: displays => displays[1], windowOn: () => ({ left: 1400, top: 0, right: 2600, bottom: 900 }),
    ownershipNote: async () => '', path: { dirname: () => '/mock' }, AGENT_STATE: '/mock/state',
    mkdirP: async () => {}, writeFileP: async () => {}, NEW_WINDOW_SETTLE_MS: 1,
    OPEN_NAVIGATIONS: new Map(),
    registerSettled: async r => { events.push('register'); state.registered.push(r.tabId); state.afterRegister?.();
      return { ...r, navigationVerified: true, finalUrl: state.finalUrl }; },
    agentName: () => 'fixture', clip: x => x, redactUrl,
    boundsRect: b => ({ x: b.left, y: b.top, w: b.width, h: b.height }),
    getTab: async id => { await state.onGetTab?.(id); return state.owner === null ? null : { ...owner, ...(state.owner || {}) }; },
    isMine: rec => rec?.ownerPid === process.pid, pidAlive: () => true, ownerName: () => 'peer ',
    myEntry: async () => null, forgetOpenNavigation: async () => {}, reconcileOpenNavigation: async () => {},
    closeVerdict, checkTakeover, recoveryLine: () => '', TAKEOVER_WHY: {},
    closeAgentTab: async (id, deps) => {
      if (state.closeRefusal) return state.closeRefusal;
      if (state.owner === null) return { ok: false, reason: 'not_agent_tab' };
      assert.equal(deps.verifiedOwnHold.tabId, id);
      await deps.verifiedOwnHold.check();
      state.beforeClose?.();
      if (state.closeTimeout) {
        deps.closeTab(id).catch(() => {});
        return { ok: false, reason: 'close_blocked' };
      }
      // Production closeAndConfirm swallows close errors while it confirms disappearance.
      try { await deps.closeTab(id); } catch {}
      return { ok: !state.tabs.has(id), closed: !state.tabs.has(id), reason: 'close_blocked' };
    },
    waitMinutes: () => 1, blockCheck: async tab => ({ tabId: tab ?? 1, url: 'https://fixture.test/', blocked: state.blocked || false }),
    blockToken: x => x.alertToken, markBlocked: async () => { assert.equal(state.held, false); events.push('notify'); return { alertToken: 'blocked' }; },
    siteOf: () => 'fixture.test', tellUser: () => { assert.equal(state.held, false); events.push('notify'); },
    armAsk: async (_tab, _field, _why, ctx) => { assertHeld('field-focus');
      if (state.armError) throw new BridgeError('arm_failed', 'synthetic arm failure');
      state.armed = true; await state.armEffect?.(ctx); return { token: 'field', done: false }; },
    locateForInput: async () => ({ visible: {}, hitOk: true, focusToken: state.focusTokenMissing ? null : 'field-token', aim: { x: 1, y: 2 } }),
    aimClickable: () => true, originFor: () => ({}), toScreen: x => x, rectToScreenRect: x => x,
    post: async (_session, ctx, kind) => { await ctx.check(); ctx.sent(kind); events.push('field-click'); },
    scrollToTarget: async () => ({ loc: { visible: {} }, done: !state.offscreen, notches: state.offscreen ? 3 : 0 }),
    prepareActivate: async tab => { assertHeld('activate'); state.scene.appPid = 42; return c.prepareNativeTarget(tab); },
    waitForFieldLoop: async ({ ask }) => { assert.equal(state.held, false); events.push('human-wait'); ask.done = true; return 'human wait'; },
    waitForUserLoop: async () => { assert.equal(state.held, false); events.push('human-wait'); return 'human wait'; },
    S: { get: () => false }, clearBlock: no, pauseCleanup: no,
    // P5: open_tab's attached read. Recorded apart from `events`: when it began, and whether the hold was on then.
    setTimeout, readPage: async (args, options) => {
      (state.reads ||= []).push({ tab: args.tab, at: events.length, held: state.held, taskHold: !!c.TASK_HOLD, attach: !!options?.attach });
      return state.readPage ? state.readPage(args, options) : `tab=${args.tab} Fixture page\n[1] link Fixture`;
    },
  });
  const names = ['actionReturnFocus', 'focusReturnNote', 'validateOpenTabArgs', 'openTabFocusSelection', 'dialogNote', 'inputBoundaryCheck', 'nativeMutation', 'prepareNativeTarget', 'inputAction', 'gateStopped', 'inputActionRun',
    'withTurn', 'taskRun', 'endTaskHold', 'endTaskHoldNow', 'interruptTaskPlan', 'taskInterruptionReason', 'taskInterruptedError', 'taskCancelledError', 'timingLine', 'openTabTool', 'openTabRun', 'openAndRegister', 'answerDialogTool', 'closeTabTool', 'waitForUserTool', 'dialogPlace', 'dialogRefusal', 'dialogElsewhere', 'disarmAsk'];
  names.push('latchTerminalTaskInterruption', 'persist','geometryTarget','geometryKey','sameGeometryBounds','invalidateGeometry','acceptGeometryResult','observeGeometryFailure','saveFittedAgentPlacement','openTabAttach');
  if (state.realPreparation) names.push('keepAgentAway', 'bringOnScreen', 'prepareActivate');
  const declarations = ['taskRestoreOps', 'TASK_NOTE', 'LATE_USER_NOTE', 'RETRY_WAIT', 'RETRY_FEW', 'SECURE_WAIT_MS', 'idleForAttempt', 'AGENT_PARTIAL', 'ATTACH_HELD_MS'].map(name => productionConst(name, modifiedSource));
  vm.runInContext([...declarations, ...names.map(name => production(name, modifiedSource))].join('\n'), c);
  const call = (name, args = {}) => c[name](args, { signal: state.signal });
  return { c, state, session, events, call, store };
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }
const openArgs = { url: 'https://fixture.test/', why: 'user_asked' };

for (const options of [{ display: 'off' }, { display: 'main', existing: 10 }, { display: 'main', existing: null }]) {
  await check(`all open branches acquire hold and restore the scene: ${JSON.stringify(options)}`, async () => {
    const h = harness(options), original = { ...h.state.scene };
    await h.call('openTabTool', openArgs);
    const mutation = h.events.indexOf(options.existing === null ? 'new-window' : 'open-tab');
    assert.ok(h.events.indexOf('lease') < h.events.indexOf('hold') && h.events.indexOf('hold') < mutation);
    assert.ok(h.events.indexOf('status') < mutation, 'opHold response is not proof of current active hold');
    assert.ok(h.events.indexOf('restore') < h.events.indexOf('release'));
    assert.deepEqual(h.state.scene, original);
    assert.deepEqual(h.state.registered, [2]);
    if (options.existing === null) assert.equal(h.events.filter(x => x === 'restore').length, 2, 'late activation repaired under hold');
  });
}
await check('unknown partial new window is never claimed, replayed, closed or restored', async () => {
  const h = harness({ display: 'main', existing: null, creationError: new BridgeError('native_empty_output', 'partial create') });
  await assert.rejects(h.call('openTabTool', openArgs), e => e.inputDelivery === 'unknown' && e.noRetry && e.sent.includes('new_window'));
  assert.equal(h.events.filter(x => x === 'new-window').length, 1);
  assert.deepEqual(h.state.registered, []);
  assert.equal(h.events.includes('close-tab'), false);
  assert.equal(h.events.filter(x => x === 'restore').length, 0);
  assert.equal(h.events.includes('warp'), false);
});
await check('Pause after complete creation and registration preserves the sent receipt without another mutation', async () => {
  for (const options of [{ display: 'off' }, { display: 'main', existing: null }]) {
    const h = harness({ ...options, finalUrl: 'https://fixture.test/landing?token=fixture-secret' });
    h.state.afterRegister = () => { h.state.paused = true; };
    await assert.rejects(h.call('openTabTool', openArgs), e => {
      assert.equal(e.code, 'paused_by_user'); assert.equal(e.inputDelivery, 'sent'); assert.equal(e.noRetry, true);
      assert.match(e.message, /创建标签 tab=2/); assert.match(e.message, /已记录为本连接创建的标签/);
      assert.match(e.message, /landing\?token=\[redacted\]/); assert.doesNotMatch(e.message, /什么也没做|fixture-secret/);
      return true;
    });
    assert.deepEqual(h.state.registered, [2]);
    assert.equal(h.events.filter(x => x === 'open-tab' || x === 'new-window').length, 1);
    assert.equal(h.events.includes('close-tab'), false);
    assert.ok(h.events.lastIndexOf('restore') < h.events.indexOf('release'));
    assert.equal(h.state.held, false);
  }
});
await check('missing original scene refuses new-window creation before its side effect', async () => {
  const h = harness({ display: 'main', existing: null, scene: {} });
  await assert.rejects(h.call('openTabTool', openArgs), e => e.code === 'scene_unknown');
  assert.equal(h.events.includes('new-window'), false);
  assert.deepEqual(h.state.registered, []);
});
await check('same-window open reuses a checked task hold; different new window refuses before creation', async () => {
  const h = harness({ display: 'main', existing: 10 }); h.c.PLAN = { task: 'fixture' };
  await h.call('openTabTool', openArgs);
  assert.ok(h.c.TASK_HOLD); assert.equal(h.state.held, true);
  await h.call('openTabTool', openArgs);
  assert.equal(h.events.filter(x => x === 'hold').length, 1);
  assert.equal(h.events.filter(x => x === 'record-scene').length, 1, 'original scene recorded once across hold reuse');
  h.state.existing = null;
  await assert.rejects(h.call('openTabTool', openArgs), e => e.code === 'new_window_blocked_by_task_hold');
  assert.equal(h.events.includes('new-window'), false);
  assert.equal(h.events.filter(x => x === 'hold').length, 1);
  await h.c.endTaskHold();
});
for (const fault of ['pause', 'abort', 'cancel', 'conversation', 'hold-lost']) {
  await check(`${fault} after a wait prevents creation`, async () => {
    const h = harness({ display: 'main', existing: null });
    h.state.afterIdle = () => {
      if (fault === 'pause') h.state.paused = true;
      if (fault === 'abort') h.state.signal.aborted = true;
      if (fault === 'cancel') h.c.TASK_CANCELLED = 'fixture';
      if (fault === 'conversation') h.state.conversation = true;
      if (fault === 'hold-lost') h.state.lostHold = true;
    };
    await assert.rejects(h.call('openTabTool', openArgs));
    assert.equal(h.events.includes('new-window'), false);
    assert.equal(h.events.includes('open-tab'), false);
  });
}
await check('native dialog uses exact identity and shared hold without DOM or activation, including an authorized user tab', async () => {
  const h = harness({ dialog: true, owner: null });
  const out = await h.call('answerDialogTool', { tab: 1, button: 'OK', text: 'fixture-only' });
  assert.match(out, /按了「OK」/);
  assert.equal(h.events.includes('activate'), false);
  assert.ok(h.events.indexOf('hold') < h.events.indexOf('dialog-exact'));
  assert.ok(h.events.indexOf('dialog-exact') < h.events.indexOf('answer'));
});
for (const opts of [{ buttons: ['Cancel'] }, { buttons: ['OK', 'OK'] }, { hasField: false },
  { identity: { ...identity(target()), cgWindow: 71 } }]) {
  await check(`dialog refuses before prompt write: ${JSON.stringify(opts)}`, async () => {
    const h = harness({ dialog: true, ...opts });
    await assert.rejects(h.call('answerDialogTool', { tab: 1, button: 'OK', text: 'fixture-only' }));
    assert.equal(h.events.includes('answer'), false);
  });
}
await check('Stop after exact dialog inspection prevents AX send and never retakes', async () => {
  const h = harness({ dialog: true }); h.state.afterDialogProbe = () => { h.state.stopped = true; };
  await assert.rejects(h.call('answerDialogTool', { tab: 1, button: 'OK' }), e => e.code === 'user_cancelled');
  assert.equal(h.events.includes('answer'), false); assert.equal(h.events.filter(x => x === 'hold').length, 1);
});
await check('a dialog replaced during the idle wait is not answered even with the same requested button', async () => {
  const h = harness({ dialog: true });
  h.state.afterIdle = () => { h.state.identity = { ...identity(target()), token: 'replacement-dialog' }; };
  await assert.rejects(h.call('answerDialogTool', { tab: 1, button: 'OK', text: 'fixture-only' }), e => e.code === 'dialog_changed');
  assert.equal(h.events.includes('answer'), false);
});
await check('missing matching press receipt and partial prompt write both remain unknown without replay', async () => {
  for (const opts of [{ answerReply: { ok: true, open: false } },
    { answerError: Object.assign(new BridgeError('dialog_write_unknown', 'field attempted'), { inputDelivery: 'unknown' }) }]) {
    const h = harness({ dialog: true, ...opts });
    await assert.rejects(h.call('answerDialogTool', { button: 'OK', text: 'fixture-only' }), e => e.inputDelivery === 'unknown' && e.sent.includes('answer_dialog'));
    assert.equal(h.events.filter(x => x === 'answer').length, 1);
  }
});
await check('close holds input through fresh ownership and native identity checks', async () => {
  const h = harness();
  await h.call('closeTabTool', { tab: 1 });
  assert.ok(h.events.indexOf('hold') < h.events.indexOf('close-tab'));
  assert.ok(h.events.indexOf('close-tab') < h.events.indexOf('release'));
});
await check('late sticky takeover refuses close, and close errors retain unknown delivery', async () => {
  const h = harness(); h.state.beforeClose = () => { h.state.owner = { takenOver: true }; };
  await assert.rejects(h.call('closeTabTool', { tab: 1 }), e => e.code === 'taken_over' && e.inputDelivery === 'not_sent');
  assert.equal(h.events.includes('close-tab'), false);
  const partial = harness({ closeError: Object.assign(new BridgeError('close_pending', 'unknown'), { inputDelivery: 'unknown' }) });
  await assert.rejects(partial.call('closeTabTool', { tab: 1 }), e => e.inputDelivery === 'unknown' && e.sent.includes('close_tab'));
  assert.equal(partial.events.filter(x => x === 'close-tab').length, 1);
});
await check('native Stop during the final close registry read prevents dispatch and leaves close not_sent', async () => {
  let reached, resume;
  const atRead = new Promise(resolve => { reached = resolve; });
  const blocked = new Promise(resolve => { resume = resolve; });
  const h = harness();
  h.state.beforeClose = () => { h.state.finalCloseRead = true; };
  h.state.onGetTab = async () => { if (h.state.finalCloseRead) { reached(); await blocked; } };
  const completion = h.call('closeTabTool', { tab: 1 }).then(() => null, error => error);
  await Promise.race([atRead, completion.then(() => { throw Error('close ended before the deferred registry read'); })]);
  h.state.stopped = true; // Native Stop only: no TASK_CANCELLED/PLAN flag is set.
  resume();
  const error = await completion;
  assert.equal(error.code, 'user_cancelled'); assert.equal(error.inputDelivery, 'not_sent');
  assert.equal(error.sent.includes('close_tab'), false);
  assert.equal(h.events.includes('close-tab'), false);
  assert.equal(h.events.filter(x => x === 'hold').length, 1);
  assert.equal(h.events.some(x => ['handBack', 'restore-app', 'restore', 'warp'].includes(x)), false);
});
await check('a late close completion/failure settles under the same hold; Stop never sends or restores again', async () => {
  for (const mode of ['complete', 'fail', 'stop']) {
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const h = harness({ closeTimeout: true, closePending: pending,
      ...(mode === 'fail' ? { closeError: Object.assign(new BridgeError('close_pending', 'late failure'), { inputDelivery: 'unknown' }) } : {}) });
    const result = h.call('closeTabTool', { tab: 1 }).then(() => null, e => e);
    while (!h.events.includes('close-tab')) await new Promise(r => setTimeout(r, 0));
    assert.equal(h.state.held, true);
    assert.equal(h.events.includes('release'), false, 'confirmation timeout must not release in-flight native write');
    if (mode === 'stop') h.state.stopped = true;
    resolve();
    const error = await result;
    assert.equal(error.code, mode === 'stop' ? 'user_cancelled' : mode === 'fail' ? 'close_pending' : 'close_blocked');
    assert.equal(h.events.filter(x => x === 'close-tab').length, 1);
    if (mode === 'stop') assert.equal(h.events.some(x => ['handBack', 'restore-app', 'restore', 'warp'].includes(x)), false);
    else assert.equal(error.inputDelivery, 'unknown');
  }
});
await check('field setup holds selection/focus, preserves requested tab on release, then notifies and waits without hold', async () => {
  const h = harness();
  assert.equal(await h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture input' }), 'human wait');
  assert.ok(h.events.indexOf('hold') < h.events.indexOf('select-tab'));
  assert.ok(h.events.indexOf('field-focus') < h.events.indexOf('release'));
  assert.ok(h.events.indexOf('release') < h.events.indexOf('notify'));
  assert.ok(h.events.indexOf('notify') < h.events.indexOf('human-wait'));
  assert.equal(h.state.scene.chromeTab, 3); assert.equal(h.state.scene.appPid, 42);
  assert.equal(h.events.some(x => ['handBack', 'restore-app', 'restore', 'warp'].includes(x)), false);
  assert.equal(h.events.filter(x => x === 'release').length, 1);
});
await check('unreachable field and stopped setup never issue a ready notification', async () => {
  const h = harness({ offscreen: true });
  await assert.rejects(h.call('waitForUserTool', { tab: 1, field: 4, reason: 'fixture input' }), e => e.code === 'target_offscreen');
  assert.equal(h.events.includes('field-focus'), false); assert.equal(h.events.includes('notify'), false);
  const stopped = harness(); stopped.state.afterIdle = () => { stopped.state.stopped = true; };
  await assert.rejects(stopped.call('waitForUserTool', { tab: 1, field: 4, reason: 'fixture input' }));
  assert.equal(stopped.events.includes('notify'), false);
});
await check('real field preparation rechecks Stop/Pause after state reads and after a completed move', async () => {
  for (const phase of ['before-move', 'after-move']) for (const stop of ['native', 'pause']) {
    let reached, resume;
    const pending = new Promise(resolve => { reached = resolve; });
    const blocked = new Promise(resolve => { resume = resolve; });
    const h = harness({ realPreparation: true, display: 'main',
      fakeProfiles: { Default: { windowId: 10, placed: { ...target().bounds } } } });
    h.state[phase === 'before-move' ? 'beforeAgentState' : 'afterAgentSave'] = async () => { reached(); await blocked; };
    const completion = h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture input' }).then(() => null, error => error);
    await Promise.race([pending, completion.then(() => { throw Error('field setup ended before the deferred preparation read'); })]);
    const fence = h.events.length;
    if (stop === 'native') h.state.stopped = true; else h.state.paused = true;
    resume();
    const error = await completion;
    assert.equal(error.code, stop === 'native' ? 'user_cancelled' : 'paused_by_user');
    assert.equal(error.noRetry, true);
    assert.equal(error.sent.includes('select_tab'), true);
    assert.equal(error.sent.includes('move_window'), false, 'scene preparation is not target-input delivery');
    assert.equal(error.sent.includes('activate'), false);
    assert.equal(h.events.filter(x => x === 'move-window').length, phase === 'after-move' ? 1 : 0);
    assert.equal(h.events.some(x => ['activate', 'field-focus', 'notify'].includes(x)), false);
    if (stop === 'native') assert.equal(h.events.slice(fence).some(x => ['handBack', 'restore-app', 'restore', 'warp'].includes(x)), false);
    else assert.ok(h.events.lastIndexOf('restore') < h.events.indexOf('release'));
    assert.equal(h.events.filter(x => x === 'hold').length, 1);
  }
});
await check('no-field handoff releases the retained hold before notification', async () => {
  const h = harness(); h.c.PLAN = { task: 'fixture' };
  await h.call('openTabTool', openArgs); assert.ok(h.c.TASK_HOLD);
  await h.call('waitForUserTool', { tab: 1, reason: 'fixture approval' });
  assert.ok(h.events.indexOf('release') < h.events.indexOf('notify'));
  assert.equal(h.c.TASK_HOLD, null);
});
await check('fault injection proves an old direct no-hold creation fails this harness', async () => {
  const mutant = source.replace("await inputAction('open_tab',", "await B.newWindow(url, null, prof.dir);\n  await inputAction('open_tab',");
  const h = harness({ display: 'main', existing: null }, mutant);
  await assert.rejects(h.call('openTabTool', openArgs), /newWindow must use captured native route/);
});
await check('caller and routine cancellation reach the original Session while actual preparation is still awaiting', async () => {
  for (const kind of ['caller', 'routine']) {
    let reached, resume;
    const entered = new Promise(resolve => { reached = resolve; });
    const blocked = new Promise(resolve => { resume = resolve; });
    const abort = new AbortController();
    const h = harness({ realPreparation: true, display: 'main',
      ...(kind === 'caller' ? { signal: abort.signal } : {}),
      fakeProfiles: { Default: { windowId: 10, placed: { ...target().bounds } } } });
    if (kind === 'routine') h.store.routineSignal = abort.signal;
    h.state.beforeAgentState = async () => { reached(); await blocked; };
    const completion = h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture' }).catch(error => error);
    await entered; abort.abort();
    assert.ok(h.events.includes('revokeNative'), 'control must be forwarded before deferred preparation resolves');
    h.state.stopped = true; resume(); await completion;
    assert.equal(h.events.includes('move-window'), false); assert.equal(h.events.includes('notify'), false);
  }
});
await check('restore rechecks task/conversation cancellation synchronously, while healthy Pause still restores', async () => {
  for (const reason of ['task', 'conversation', 'pause']) {
    const h = harness();
    h.state.beforeRestore = () => {
      if (reason === 'task') h.c.TASK_CANCELLED = 'fixture';
      if (reason === 'conversation') h.state.conversation = true;
      if (reason === 'pause') h.state.paused = true;
    };
    await h.call('openTabTool', openArgs).catch(() => {});
    assert.equal(h.events.includes('restore'), reason === 'pause');
    assert.equal(h.events.includes('warp'), reason === 'pause');
    assert.equal(h.events.includes('revokeNative'), reason !== 'pause');
  }
});
await check('changed epoch before dispatch refuses; a missing matching reply epoch is unknown with zero restoration', async () => {
  const stale = harness(); stale.state.afterIdle = () => { stale.state.epoch = 2; };
  await assert.rejects(stale.call('openTabTool', openArgs), e => e.code === 'native_epoch_changed');
  assert.equal(stale.events.includes('open-tab'), false);
  const lost = harness({ replyEpoch: 2 });
  await assert.rejects(lost.call('openTabTool', openArgs), e => e.inputDelivery === 'unknown' && e.noRetry);
  assert.equal(lost.events.includes('restore'), false); assert.equal(lost.events.includes('warp'), false);
});
await check('unknown native scene preparation never becomes a target click or a replay/restore opportunity', async () => {
  const h = harness({ realPreparation: true });
  h.state.onNative = req => { if (req.intent.kind === 'activate') throw Object.assign(new BridgeError('native_delivery_unknown', 'unknown activation'), { inputDelivery: 'unknown', noRetry: true }); };
  await assert.rejects(h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture' }), error =>
    error.inputDelivery === 'unknown' && error.noRetry && !error.sent.includes('activate'));
  assert.equal(h.events.includes('field-click'), false); assert.equal(h.events.includes('notify'), false);
  assert.equal(h.events.includes('restore'), false); assert.equal(h.events.includes('warp'), false);
});
await check('healthy monitor begins before native preparation when takeover is disabled', async () => {
  const sequence = []; let epoch = 1;
  const s = { request: async req => {
    sequence.push(req.op);
    if (req.op === 'recordNativeScene') return { ok: true, epoch, restoreToken: 'restore' };
    return { ok: true, epoch, operationId: req.operationId, stages: [], inputMonitor: true, inputDelivery: 'sent' };
  }, close: async () => { sequence.push('end'); return { ok: true }; } };
  const ops = { takeover: false, nativeTransactions: true, now: Date.now,
    waitForUserIdle: async () => 0, snapshotScene: async () => ({ appPid: 9, chromePid: 42, chromeWindow: 10, chromeTab: 1 }),
    mousepos: async () => null, openSession: async () => s, userActedSince: async () => false,
    prepare: async (_pre, _state, ctx) => { await ctx.bindNativeTarget(target()); await ctx.native({ kind: 'activate', tabId: 1, windowId: 10 }); return { ...target(), target: target() }; },
    restoreScene: async (_scene, o) => o.native({ kind: 'restoreScene' }, { policy: 'restore' }) };
  await runInputAction(ops, async () => 'done');
  assert.ok(sequence.indexOf('begin') < sequence.indexOf('bindNativeTarget'));
  assert.ok(sequence.indexOf('bindNativeTarget') < sequence.indexOf('nativeChrome'));
  assert.equal(sequence.filter(x => x === 'begin').length, 1);
  assert.equal(sequence.filter(x => x === 'recordNativeScene').length, 1);
});
await check('NAT-RETRY r3: a held task_plan session sends one native call id per MCP call; restore carries none', async () => {
  const h = harness({ display: 'main', existing: 10 }); h.c.PLAN = { task: 'fixture' };
  await h.call('openTabTool', openArgs);   // an earlier call takes and keeps the task hold
  assert.ok(h.c.TASK_HOLD, 'the task hold is kept');
  const fresh = () => { const store = {}; h.c.CALL = { getStore: () => store }; };   // the next MCP call: a new CALL context
  const seen = [], request = h.session.request;
  h.session.request = async req => { seen.push({ op: req.op, call: req.call, policy: req.policy }); return request(req); };
  const step = () => h.c.taskRun('step', { takeover: true, nativeTransactions: true, now: Date.now,
    prepare: async (_pre, _state, ctx) => {
      const bound = await h.c.prepareNativeTarget(1, ctx);
      await ctx.native({ kind: 'selectTab', tabId: 1, windowId: 10 });
      await h.c.prepareNativeTarget(1, ctx);
      return bound;
    } }, async () => 'done', 'fixture');
  fresh(); await step();
  const first = seen.length;
  fresh(); await step();
  assert.equal(h.events.filter(x => x === 'hold').length, 1, 'both calls reuse the held Session (th.kept)');
  const ordinary = list => list.filter(x => ['bindNativeTarget', 'nativeChrome'].includes(x.op) && x.policy !== 'restore');
  const one = ordinary(seen.slice(0, first)), two = ordinary(seen.slice(first));
  assert.deepEqual(one.map(x => x.op), ['bindNativeTarget', 'nativeChrome', 'bindNativeTarget']);
  assert.deepEqual(two.map(x => x.op), ['bindNativeTarget', 'nativeChrome', 'bindNativeTarget']);
  assert.ok(typeof one[0].call === 'string' && one[0].call.length > 0 && one.every(x => x.call === one[0].call), JSON.stringify(one));
  assert.ok(typeof two[0].call === 'string' && two.every(x => x.call === two[0].call), JSON.stringify(two));
  assert.notEqual(one[0].call, two[0].call, 'the next MCP call has its own id');
  // Another attempt inside the same MCP call (same CALL context) keeps that call's id.
  const second = seen.length; await step();
  const again = ordinary(seen.slice(second));
  assert.ok(again.length === 3 && again.every(x => x.call === two[0].call), JSON.stringify(again));
  fresh(); await h.c.endTaskHold();
  const restores = seen.filter(x => x.policy === 'restore');
  assert.ok(restores.length >= 1, 'ending the hold restores the scene natively');
  assert.ok(restores.every(x => x.call === undefined), JSON.stringify(restores));
});
await check('removing the immediate restore cancellation guard makes the intended no-write negative fail', async () => {
  const original = await fs.readFile(new URL('../src/guard.js', import.meta.url), 'utf8');
  const marker = '        await checkBoundary(true);';
  assert.equal(original.split(marker).length, 2);
  const mutated = original.replace(marker, '').replace("from './bridge.js'", `from ${JSON.stringify(new URL('../src/bridge.js', import.meta.url).href)}`);
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(mutated).toString('base64'));
  async function negative(run) {
    let restores = 0, held = false;
    const session = { request: async request => {
      if (request.op === 'hold') held = true;
      if (request.op === 'nativeChrome' && request.intent.kind === 'restoreScene') restores++;
      return { ok: true, epoch: 1, operationId: request.operationId, stages: [], inputMonitor: true, restoreToken: 'restore', inputDelivery: 'sent', takeover: { active: held } };
    }, close: async () => { held = false; return { ok: true }; } };
    await run({ takeover: true, nativeTransactions: true, now: Date.now, waitForHandsOff: async () => 0,
      snapshotScene: async () => ({ appPid: 9, chromePid: 42, chromeWindow: 10, chromeTab: 1 }), mousepos: async () => null,
      userActedSince: async () => false, openSession: async () => session,
      beforeRestore() { throw new BridgeError('conversation_waiting', 'cancel arrived before the poll'); },
      prepare: async (_pre, _state, ctx) => { await ctx.bindNativeTarget(target()); return { ...target(), target: target() }; },
      restoreScene: async (_scene, options) => options.native({ kind: 'restoreScene' }, { policy: 'restore' })
    }, async () => 'done');
    assert.equal(restores, 0, 'known cancellation must prevent the native restore request');
  }
  await negative(runInputAction);
  await assert.rejects(negative(mutant.runInputAction), error => error.code === 'ERR_ASSERTION' && error.actual === 1 && error.expected === 0);
});
await check('unknown restoration retains native stages and confirmed creation without pretending a user interruption', async () => {
  const h = harness();
  h.state.onNative = request => { if (request.intent.kind === 'restoreScene') throw Object.assign(
    new BridgeError('native_delivery_unknown', 'restore entered without acknowledgement'),
    { inputDelivery: 'unknown', noRetry: true, stages: [{ sequence: 1, stage: 'restoreApp', delivery: 'unknown', entered: true }] }); };
  await assert.rejects(h.call('openTabTool', openArgs), error => {
    assert.equal(error.code, 'native_delivery_unknown'); assert.equal(error.inputDelivery, 'unknown');
    assert.equal(error.targetInputDelivery, 'sent'); assert.equal(error.noRetry, true);
    assert.equal(error.lateUser, undefined); assert.equal(error.stages[0].delivery, 'unknown');
    assert.match(error.message, /创建标签 tab=2/); return true;
  });
  assert.equal(h.events.includes('warp'), false);
  assert.equal(h.events.filter(x => x === 'open-tab').length, 1);
});
await check('only an explicit validated GUI goto may start after an old task/conversation stop; model input stays stopped', async () => {
  const h = harness();
  h.c.TASK_CANCELLED = 'old task'; h.state.conversation = true;
  const request = { id: 'gui-request', tab: 1, at: Date.now(), sessionGeneration: 'generation', alertToken: 'alert' };
  h.c.BLOCKS.set(1, { url: 'https://fixture.test/', alertToken: 'alert' });
  Object.assign(h.c, {
    GOTO_REQ: '/synthetic-goto', SESSION_GENERATION: 'generation', GOTO_MESSAGES: { queued: 'queued' },
    GOTO: { running: false, latest: null, seen: new Map(), entryMaxMs: 10000, queueMaxMs: 15000 },
    renameSync() {}, readFileSync: () => JSON.stringify(request), rmSync() {},
    publishGoto: () => true, finishGoto: (_record, status) => status,
    AbortController, setTimeout: () => ({ unref() {} }), setInterval: () => ({ unref() {} }),
    watchQueue: session => session, OWN_INPUT_END: 0,
    withInputLock: async (_label, action) => ({ result: await action({}) }),
  });
  h.c.B.openInputSession = async () => h.session;
  vm.runInContext(['openOwnSession', 'preWriteTimeout', 'gotoIdentityReason', 'onGotoRequest'].map(name => production(name)).join('\n'), h.c);
  assert.equal(await h.c.onGotoRequest(), 'shown');
  assert.equal(h.c.TASK_CANCELLED, 'old task'); assert.equal(h.state.conversation, true);
  assert.equal(h.events.filter(x => x === 'activate').length, 1);
  assert.equal(h.events.includes('restore'), false); assert.equal(h.events.includes('warp'), false);
  await assert.rejects(h.call('openTabTool', { ...openArgs, humanGoto: true }), error => error.code === 'user_cancelled');
  assert.equal(h.events.filter(x => x === 'hold').length, 1, 'normal tool must not borrow GUI handoff authorization');
});
await check('bare veil healthy reuse keeps the original Session, lease and scene without a second hold', async () => {
  const h = harness({ display: 'main', existing: 10 }); h.c.PLAN = { task: 'fixture' };
  try {
    await h.call('openTabTool', openArgs);
    const original = h.c.TASK_HOLD, lease = original.lease, session = original.kept.session, scene = original.kept.scene;
    assert.equal(session, h.session);
    const fence = h.events.length;
    h.state.veilReply = req => { assert.deepEqual(req, { op: 'veil' }); return { ok: true, held: true }; };
    await h.call('openTabTool', openArgs);
    assert.equal(h.c.TASK_HOLD, original);
    assert.equal(h.c.TASK_HOLD.lease, lease);
    assert.equal(h.c.TASK_HOLD.kept.session, session);
    assert.equal(h.c.TASK_HOLD.kept.scene, scene);
    const reused = h.events.slice(fence);
    assert.equal(reused.filter(x => x === 'veil').length, 1);
    assert.ok(reused.indexOf('veil') < reused.indexOf('open-tab'));
    for (const event of ['lease', 'hold', 'snapshot', 'record-scene']) assert.equal(h.events.filter(x => x === event).length, 1, event);
    assert.equal(h.events.filter(x => x === 'open-tab').length, 2);
    assert.equal(reused.includes('release'), false);
    assert.equal(reused.includes('lease-release'), false);
    assert.equal(h.state.closed, 0);
  } finally { await h.c.endTaskHold(); }
});
for (const [kind, reply] of [['missing', { ok: true }], ['false', { ok: true, held: false }]]) {
  await check(`bare veil ${kind} held refuses reuse before another preparation or creation`, async () => {
    const h = harness({ display: 'main', existing: 10 }); h.c.PLAN = { task: 'fixture' };
    try {
      await h.call('openTabTool', openArgs);
      let preparations = 0;
      Object.defineProperty(h.state, 'existing', { get() { preparations++; return 10; } });
      h.state.veilReply = req => { assert.deepEqual(req, { op: 'veil' }); return reply; };
      const fence = h.events.length;
      await assert.rejects(h.call('openTabTool', openArgs), e => e.code === 'task_hold_lost' && e.sent.length === 0);
      assert.equal(preparations, 0);
      assert.equal(h.events.slice(fence).filter(x => x === 'veil').length, 1);
      for (const event of ['lease', 'hold', 'snapshot', 'record-scene', 'open-tab']) assert.equal(h.events.filter(x => x === event).length, 1, event);
      assert.equal(h.events.includes('new-window'), false);
      assert.deepEqual(h.state.registered, [2]);
      assert.equal(h.c.TASK_HOLD, null);
      assert.equal(h.state.closed, 1);
      assert.equal(h.events.filter(x => x === 'lease-release').length, 1);
    } finally { await h.c.endTaskHold(); }
  });
}
for (const failure of ['inactive', 'aborted']) {
  await check(`bare veil held true does not bypass the next ${failure} status before preparation`, async () => {
    const h = harness({ display: 'main', existing: 10 }); h.c.PLAN = { task: 'fixture' };
    try {
      await h.call('openTabTool', openArgs);
      let preparations = 0, checksAfterVeil = 0;
      Object.defineProperty(h.state, 'existing', { get() { preparations++; return 10; } });
      h.state.veilReply = req => {
        assert.deepEqual(req, { op: 'veil' });
        h.state.onStatus = () => { checksAfterVeil++; if (failure === 'inactive') h.state.lostHold = true; else h.state.stopped = true; };
        return { ok: true, held: true };
      };
      const fence = h.events.length;
      await assert.rejects(h.call('openTabTool', openArgs), e => e.code === (failure === 'inactive' ? 'task_hold_lost' : 'user_cancelled') && e.sent.length === 0);
      assert.ok(checksAfterVeil > 0);
      assert.equal(preparations, 0);
      const refused = h.events.slice(fence);
      assert.equal(refused.filter(x => x === 'veil').length, 1);
      assert.ok(refused.indexOf('veil') < refused.indexOf('status'));
      assert.equal(refused.some(x => ['bindNativeTarget', 'nativeChrome', 'open-tab', 'new-window', 'restore', 'warp', 'hold'].includes(x)), false);
      for (const event of ['lease', 'hold', 'snapshot', 'record-scene', 'open-tab']) assert.equal(h.events.filter(x => x === event).length, 1, event);
      assert.equal(h.c.TASK_HOLD, null);
      assert.equal(h.state.closed, 1);
      assert.equal(h.events.filter(x => x === 'lease-release').length, 1);
    } finally { await h.c.endTaskHold(); }
  });
}

// This composition keeps all production close/guard functions. Only the native
// transport, registry directory, lock/list observations and clock are inert.
// In particular, it does not use the legacy closeTimeout callback above.
let composedSerial = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const strictCloseReceipt = req => ({ ok: true, closed: true, leavePrompt: false,
  stage: 'close_postcheck', inputDelivery: 'sent', epoch: req.epoch, operationId: req.operationId,
  stages: [{ sequence: 1, stage: 'close_tab', entered: true, delivery: 'sent', acknowledged: true }] });
async function composedCloseHarness(options = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-held-close-composition-'));
  const registry = path.join(tmp, 'tabs'), lockDir = path.join(tmp, 'input.lock');
  const previousDir = process.env.CHROME_BRIDGE_TAB_DIR;
  const previousOwner = process.env.CHROME_BRIDGE_LAUNCHER_PID;
  let T, registryReadHook = null;
  try {
    process.env.CHROME_BRIDGE_TAB_DIR = registry;
    process.env.CHROME_BRIDGE_LAUNCHER_PID = String(process.pid);
    if (options.finalRegistryBoundary) {
      // Evaluate the complete unchanged tabs implementation with just its
      // filesystem import binding wrapped. This observes one test-owned read;
      // it does not replace getTab, closeAgentTab, closeAndConfirm or flags.
      const text = await fs.readFile(new URL('../src/tabs.js', import.meta.url), 'utf8');
      const names = [...text.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(match => match[1]);
      const context = vm.createContext({ ...fs, readFileSync, os, path, Date, URL, Number, Map, Set, Promise, Error,
        setTimeout, LOCK_DIR: lockDir, STALE_MS: 90_000, S: { get: () => false },
        process: { pid: process.pid, env: { CHROME_BRIDGE_TAB_DIR: registry, CHROME_BRIDGE_LAUNCHER_PID: String(process.pid) },
          kill: () => { throw Error('host process probes are forbidden'); } },
        readFile: async (...args) => { const result = await fs.readFile(...args); await registryReadHook?.(args[0]); return result; } });
      vm.runInContext(text.replace(/^import[^\n]*;\n/gm, '').replace(/^export /gm, '') +
        `\nglobalThis.exports = { ${names.join(', ')} };`, context);
      T = context.exports;
    } else T = await import(`../src/tabs.js?held-close-composition=${++composedSerial}`);
  } finally {
    if (previousDir === undefined) delete process.env.CHROME_BRIDGE_TAB_DIR;
    else process.env.CHROME_BRIDGE_TAB_DIR = previousDir;
    if (previousOwner === undefined) delete process.env.CHROME_BRIDGE_LAUNCHER_PID;
    else process.env.CHROME_BRIDGE_LAUNCHER_PID = previousOwner;
  }
  const h = harness();
  if (options.guardRun) h.c.runInputAction = options.guardRun;
  h.state.tabs.set(99, target(99));
  h.state.scene.chromeTab = 99;
  Object.assign(h.c, T);
  h.c.B.closeTab = nativeCloseTab;
  h.c.getTab = id => T.getTab(id);
  h.c.PLAN = { task: 'composed-close' };
  let ticks = 0, active = null;
  const requests = [], lists = [];
  const rawList = h.c.B.listTabs;
  h.c.B.listTabs = async () => {
    lists.push({ at: ticks, inFlight: !!active?.request, tab: active?.id });
    if (active?.request && options.observer === 'stalled') return new Promise(() => {});
    if (active?.request && options.observer === 'rejected') throw Error('inert listing unavailable');
    return rawList();
  };
  h.state.nativeReply = async req => {
    if (req.intent.kind !== 'closeTab') return { ok: true, epoch: req.epoch,
      operationId: req.operationId, inputDelivery: 'sent', stages: [] };
    assert.equal(req.intent.tabId, active.id);
    assert.equal(h.state.held, true);
    requests.push(req);
    active.request = req;
    active.enteredAt = ticks;
    active.dispatched.resolve();
    const receipt = await active.native.promise;
    active.nativeReturned = true;
    if (receipt instanceof Error) throw receipt;
    h.state.tabs.delete(req.intent.tabId);
    h.state.scene.chromeTab = [...h.state.tabs.values()].find(tab => tab.windowId === 10)?.tabId ?? null;
    return receipt;
  };
  h.c.closeAgentTab = async (id, deps) => {
    const result = await T.closeAgentTab(id, { ...deps, lockDir, clock: () => ticks,
      sleep: async ms => {
        // Let the actual native request enter before advancing the observer
        // deadline. A separate case below deliberately delays preparation.
        if (!options.latePrepare) await active.dispatched.promise;
        ticks += ms;
        await options.onSleep?.({ ticks, active });
        await new Promise(resolve => setImmediate(resolve));
      } });
    active.observerResult = result;
    active.observed.resolve(result);
    options.onObserved?.(result);
    return result;
  };
  for (const id of [1, 3]) await T.registerTab(id, 'https://fixture.test/', { ownerPid: process.pid, windowId: 10, now: 1000 + id });
  await h.c.inputAction('retain original close hold', (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx),
    async () => '', { nativeOnly: true, task: 'composed-close', compact: true });
  const original = h.c.TASK_HOLD;
  const retained = { hold: original, lease: original.lease, session: original.kept.session,
    scene: original.kept.scene, epoch: original.kept.nativeState.epoch };
  const start = id => {
    assert.equal(active, null);
    active = { id, at: ticks, dispatched: deferred(), observed: deferred(), native: deferred() };
    const step = active;
    step.completion = h.call('closeTabTool', { tab: id }).then(value => ({ value }), error => ({ error }));
    return step;
  };
  const finishStep = () => { active = null; };
  const onFinalRegistryRead = callback => { registryReadHook = async file => {
    if (active?.nativeReturned && String(file) === path.join(registry, '1.json')) {
      registryReadHook = null; await callback();
    }
  }; };
  const cleanup = async () => { await h.c.endTaskHold(); await fs.rm(tmp, { recursive: true, force: true }); };
  return { ...h, T, registry, requests, lists, retained, start, finishStep, onFinalRegistryRead, cleanup, clock: () => ticks };
}
async function observeDeadline(h, step) {
  const observed = await Promise.race([step.observed.promise, step.completion.then(result => {
    throw Error(`composed close ended before observer: ${result.error?.stack || result.value}`);
  })]);
  assert.equal(observed.ok, false);
  assert.equal(observed.reason, 'close_blocked');
  assert.ok(h.clock() - step.at >= 3000, 'unchanged original 3000 ms observer deadline elapsed');
  assert.ok(h.lists.some(item => item.inFlight && item.at - step.at >= 3000), 'a post-deadline listing was attempted while native close was pending');
  assert.equal(h.state.held, true);
  assert.equal(h.events.includes('release'), false);
  assert.equal(h.events.includes('lease-release'), false);
  assert.equal(h.requests.filter(req => req.intent.tabId === step.id).length, 1);
}
for (const observer of ['present', 'stalled', 'rejected']) {
  await check(`production composed held close adopts strict late receipt after ${observer} observer, then closes B and finishes once`, async () => {
    const h = await composedCloseHarness({ observer });
    try {
      for (const id of [1, 3]) {
        const step = h.start(id);
        await observeDeadline(h, step);
        step.native.resolve(strictCloseReceipt(step.request));
        const result = await step.completion;
        assert.equal(result.error, undefined, `strict same-call native close must replace stale observer r.ok=false: ${result.error?.code}`);
        assert.match(result.value, /已关闭 agent 标签/);
        assert.equal(h.state.scene.chromeTab, id === 1 ? 3 : 99, 'native close selects the surviving same-window tab');
        assert.equal(await h.T.getTab(id), null, 'exact original record is forgotten');
        assert.equal((await fs.readdir(h.registry)).some(name => name.startsWith(`${id}.`)), false, 'no blocked residue remains');
        assert.equal(h.c.TASK_HOLD, h.retained.hold);
        assert.equal(h.c.TASK_HOLD.lease, h.retained.lease);
        assert.equal(h.c.TASK_HOLD.kept.session, h.retained.session);
        assert.equal(h.c.TASK_HOLD.kept.scene, h.retained.scene);
        assert.equal(h.c.TASK_HOLD.kept.nativeState.epoch, h.retained.epoch);
        h.finishStep();
      }
      assert.deepEqual(h.requests.map(req => req.intent.tabId), [1, 3]);
      assert.notEqual(h.requests[0].operationId, h.requests[1].operationId);
      for (const event of ['lease', 'hold', 'snapshot', 'record-scene']) assert.equal(h.events.filter(x => x === event).length, 1, event);
      assert.equal(h.events.includes('release'), false);
      await h.c.endTaskHold();
      assert.equal(h.events.filter(x => x === 'release').length, 1);
      assert.equal(h.events.filter(x => x === 'lease-release').length, 1);
      assert.equal(h.events.filter(x => x === 'restore').length, 1);
      assert.deepEqual(h.state.scene, h.retained.scene, 'finish restores the original inert user scene once');
    } finally { await h.cleanup(); }
  });
}


const without = (receipt, key) => { const next = { ...receipt }; delete next[key]; return next; };
const receiptCases = [
  ['closed missing', r => without(r, 'closed'), 'close_blocked'],
  ['closed false', r => ({ ...r, closed: false }), 'close_blocked'],
  ['closed string', r => ({ ...r, closed: 'true' }), 'close_blocked'],
  ['stage missing', r => without(r, 'stage'), 'close_blocked'],
  ['stage wrong', r => ({ ...r, stage: 'close_dispatch' }), 'close_blocked'],
  ['leavePrompt missing', r => without(r, 'leavePrompt'), 'close_blocked'],
  ['leavePrompt true', r => ({ ...r, leavePrompt: true }), 'close_blocked'],
  ['leavePrompt string', r => ({ ...r, leavePrompt: 'false' }), 'close_blocked'],
  ['stages missing', r => without(r, 'stages'), 'native_delivery_unknown'],
  ['stages empty', r => ({ ...r, stages: [] }), 'close_blocked'],
  ['stages malformed', r => ({ ...r, stages: [null] }), 'close_blocked'],
  ['stage duplicate', r => ({ ...r, stages: [...r.stages, ...r.stages] }), 'close_blocked'],
  ['stage wrong name', r => ({ ...r, stages: [{ ...r.stages[0], stage: 'select_tab' }] }), 'close_blocked'],
  ['stage wrong sequence', r => ({ ...r, stages: [{ ...r.stages[0], sequence: 2 }] }), 'close_blocked'],
  ['stage sequence string', r => ({ ...r, stages: [{ ...r.stages[0], sequence: '1' }] }), 'close_blocked'],
  ['stage not entered', r => ({ ...r, stages: [{ ...r.stages[0], entered: false }] }), 'close_blocked'],
  ['stage delivery unknown', r => ({ ...r, stages: [{ ...r.stages[0], delivery: 'unknown' }] }), 'close_blocked'],
  ['stage unacknowledged', r => ({ ...r, stages: [{ ...r.stages[0], acknowledged: false }] }), 'close_blocked'],
  ['epoch missing', r => without(r, 'epoch'), 'native_delivery_unknown'],
  ['epoch wrong', r => ({ ...r, epoch: r.epoch + 1 }), 'native_delivery_unknown'],
  ['operationId missing', r => without(r, 'operationId'), 'native_delivery_unknown'],
  ['operationId wrong', r => ({ ...r, operationId: 'another-close' }), 'native_delivery_unknown'],
  ['delivery unknown', r => ({ ...r, inputDelivery: 'unknown' }), 'native_delivery_unknown'],
  ['typed native rejection', r => ({ ...r, ok: false, error: 'native_close_rejected', message: 'inert rejection' }), 'native_close_rejected'],
  ['close_pending rejection', () => Object.assign(new BridgeError('close_pending', 'inert pending close'), { inputDelivery: 'unknown', noRetry: true }), 'close_pending'],
  ['prompt pending receipt', r => ({ ...r, ok: false, closed: false, leavePrompt: true, error: 'close_pending' }), 'close_pending'],
];
async function assertRejectedComposition(h, step, expectedCode) {
  const result = await step.completion;
  assert.ok(result.error, 'unconfirmed close must reject');
  assert.equal(result.error.code, expectedCode);
  assert.equal(result.error.noRetry, true);
  assert.ok(await h.T.getTab(1), 'A ownership record is never deleted on rejection');
  assert.ok(await h.T.getTab(3), 'B ownership record remains untouched');
  assert.deepEqual(h.requests.map(req => req.intent.tabId), [1], 'no retry or subsequent B close');
  assert.equal(h.events.filter(x => x === 'hold').length, 1);
  assert.equal(h.events.filter(x => x === 'lease').length, 1);
  return result.error;
}
for (const [name, change, code] of receiptCases) {
  await check(`production composed late receipt refuses ${name} without deleting A or operating B`, async () => {
    const h = await composedCloseHarness();
    try {
      const step = h.start(1);
      await observeDeadline(h, step);
      step.native.resolve(change(strictCloseReceipt(step.request)));
      const error = await assertRejectedComposition(h, step, code);
      if (code === 'native_delivery_unknown' || code === 'close_blocked' || name === 'close_pending rejection') assert.equal(error.inputDelivery, 'unknown');
      if (name === 'typed native rejection' || name === 'prompt pending receipt') assert.equal(error.inputDelivery, 'sent');
      assert.equal((await h.T.getTab(1)).closeBlocked, true, 'unconfirmed attempt keeps ordinary sticky blocked bookkeeping');
    } finally { await h.cleanup(); }
  });
}
const boundaryCases = [
  ['Stop', h => { h.state.stopped = true; }, 'user_cancelled'],
  ['Pause', h => { h.state.paused = true; }, 'paused_by_user'],
  ['caller cancellation', h => { h.state.signal.aborted = true; }, 'cancelled'],
  ['task cancellation', h => { h.c.TASK_CANCELLED = 'composed-close'; }, 'user_cancelled'],
  ['inactive native hold', h => { h.state.lostHold = true; }, 'task_hold_lost'],
  ['replaced hold object with healthy old Session', h => { h.c.TASK_HOLD = { ...h.c.TASK_HOLD }; }, 'task_hold_lost'],
  ['replaced lease with healthy old Session', h => { h.c.TASK_HOLD.lease = { release: async () => {} }; }, 'task_hold_lost'],
  ['replaced Session with healthy old Session', h => { h.c.TASK_HOLD.kept.session = { ...h.session }; }, 'task_hold_lost'],
  ['changed retained epoch with healthy old Session', h => { h.c.TASK_HOLD.kept.nativeState.epoch++; }, 'native_delivery_unknown'],
];
for (const [name, change, code] of boundaryCases) {
  await check(`production composed late close does not adopt after ${name}`, async () => {
    const h = await composedCloseHarness();
    try {
      const step = h.start(1);
      await observeDeadline(h, step);
      const receipt = strictCloseReceipt(step.request);
      change(h);
      step.native.resolve(receipt);
      await assertRejectedComposition(h, step, code);
      assert.equal(h.events.some(event => ['restore', 'warp', 'handBack'].includes(event)), false);
    } finally {
      // The deliberately replaced bookkeeping never owns a second resource.
      h.c.TASK_HOLD = null;
      await h.cleanup();
    }
  });
}

for (const [mode, code] of [['native Stop', 'user_cancelled'], ['native inactive hold', 'task_hold_lost']]) {
  await check(`production composed ${mode} during final registry await rejects before adoption`, async () => {
    const h = await composedCloseHarness({ finalRegistryBoundary: true });
    try {
      const step = h.start(1);
      await observeDeadline(h, step);
      let reads = 0;
      h.onFinalRegistryRead(() => {
        reads++;
        assert.equal(h.c.TASK_CANCELLED, null, 'only native state changes; no JS cancellation shortcut');
        assert.equal(h.state.signal.aborted, false);
        if (mode === 'native Stop') h.state.stopped = true;
        else h.state.lostHold = true;
      });
      step.native.resolve(strictCloseReceipt(step.request));
      await assertRejectedComposition(h, step, code);
      assert.equal(reads, 1, 'real finalizer registry read hit the inert IO hook');
      assert.equal(h.events.some(event => ['restore', 'warp', 'handBack'].includes(event)), false);
    } finally { await h.cleanup(); }
  });
}

async function changeRecord(h, patch) {
  const file = path.join(h.registry, '1.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...record, ...patch }));
}
const recordCases = [
  ['ownerPid', h => changeRecord(h, { ownerPid: process.pid + 1 })],
  ['openedAt / replacement', h => h.T.registerTab(1, 'https://fixture.test/', { ownerPid: process.pid, windowId: 10, now: 5000 })],
  ['windowId', h => changeRecord(h, { windowId: 11 })],
  ['popup identity', h => changeRecord(h, { popup: true })],
  ['ownership token', h => changeRecord(h, { ownershipObservation: { token: 'replacement-observation' } })],
  ['expected URL', h => changeRecord(h, { expectedUrl: 'https://changed.test/' })],
  ['protected', h => changeRecord(h, { protected: true })],
  ['takenOver sticky flag', h => h.T.markTakenOver(1, 'user_viewing', 5000)],
  ['ownershipUncertain', h => changeRecord(h, { ownershipUncertain: true })],
  ['other-operation blocked flag', h => h.T.markCloseBlocked(1, 5555)],
];
for (const [name, change] of recordCases) {
  await check(`production composed late close preserves changed ${name} record`, async () => {
    const h = await composedCloseHarness();
    try {
      const step = h.start(1);
      await observeDeadline(h, step);
      await change(h);
      const before = await h.T.getTab(1);
      step.native.resolve(strictCloseReceipt(step.request));
      await assertRejectedComposition(h, step, 'close_blocked');
      const after = await h.T.getTab(1);
      for (const [key, value] of Object.entries(before)) {
        if (key !== 'agentDoneAt') assert.deepEqual(after[key], value, `retains changed record field ${key}`);
      }
      // inputAction's existing finally records completion even on refusal.
      assert.ok(Number.isFinite(after.agentDoneAt) && after.agentDoneAt >= before.agentDoneAt);
      if (name === 'other-operation blocked flag') {
        const flag = JSON.parse(await fs.readFile(path.join(h.registry, '1.blocked.json'), 'utf8'));
        assert.equal(flag.at, 5555, 'independent create-only blocked mark is never replaced or cleared');
      }
    } finally { await h.cleanup(); }
  });
}
await check('production composed preexisting blocked flag refuses before native dispatch', async () => {
  const h = await composedCloseHarness();
  try {
    await h.T.markCloseBlocked(1, 7777);
    const step = h.start(1);
    const result = await step.completion;
    assert.equal(result.error.code, 'close_blocked');
    assert.deepEqual(h.requests, []);
    assert.equal((await h.T.getTab(1)).closeBlockedAt, 7777);
    assert.ok(await h.T.getTab(3));
  } finally { await h.cleanup(); }
});
await check('production composed preparation beyond 3 seconds still closes once within its separate budget', async () => {
  const gate = deferred();
  const h = await composedCloseHarness({ latePrepare: true,
    onSleep: ({ ticks }) => { if (ticks >= 5000) gate.resolve(); },
    // Also drain a baseline failure so the same oracle reports an assertion, not a hang.
    onObserved: () => gate.resolve() });
  let infos = 0;
  h.state.onInfo = async () => { if (++infos === 2) await gate.promise; };
  h.state.onNative = req => { if (req.intent.kind === 'closeTab') step.native.resolve(strictCloseReceipt(req)); };
  const step = h.start(1);
  try {
    const result = await step.completion;
    assert.equal(result.error, undefined, `a safe long preparation must not produce a false blocked flag: ${result.error?.code}`);
    assert.match(result.value, /已关闭 agent 标签/);
    assert.ok(step.enteredAt >= 5000 && step.enteredAt < 25000);
    assert.equal(h.requests.length, 1);
    assert.equal(await h.T.getTab(1), null);
    assert.equal((await fs.readdir(h.registry)).some(name => name.startsWith('1.')), false);
    assert.ok(h.lists.slice(1).every(item => item.at >= step.enteredAt), 'confirmation listings start after native entry');
    assert.equal(h.c.TASK_HOLD, h.retained.hold);
    assert.equal(h.state.held, true);
  } finally { gate.resolve(); await h.cleanup(); }
});
await check('production composed preparation expiry seals a not-sent attempt without a blocked flag', async () => {
  const h = await composedCloseHarness({ latePrepare: true });
  const gate = deferred();
  let infos = 0;
  h.state.onInfo = async () => { if (++infos === 2) await gate.promise; };
  try {
    const step = h.start(1);
    const observed = await step.observed.promise;
    assert.equal(observed.reason, 'close_prepare_timeout');
    assert.equal(observed.stage, 'close_preflight');
    assert.equal(observed.inputDelivery, 'not_sent');
    assert.equal(observed.noRetry, true);
    assert.ok(h.clock() - step.at >= 25000);
    assert.equal((await h.T.getTab(1)).closeBlocked, false);
    assert.deepEqual(h.requests, [], 'no native close was dispatched before the observer deadline');
    gate.resolve();
    const result = await step.completion;
    assert.equal(result.error.code, 'close_prepare_timeout');
    assert.equal(result.error.stage, 'close_preflight');
    assert.equal(result.error.noRetry, true);
    assert.equal(result.error.inputDelivery, 'not_sent');
    assert.equal(result.error.sent.includes('close_tab'), false);
    assert.deepEqual(h.requests, []);
    assert.ok(await h.T.getTab(1)); assert.ok(await h.T.getTab(3));
    assert.equal((await fs.readdir(h.registry)).some(name => name.startsWith('1.blocked')), false);
    assert.equal(h.c.TASK_HOLD, h.retained.hold);
    assert.equal(h.state.held, true);
    assert.equal(h.events.some(event => ['restore', 'warp', 'handBack'].includes(event)), false);
  } finally { gate.resolve(); await h.cleanup(); }
});

async function finalCloseEnqueueOracle(guardRun = runInputAction, stop = false) {
  const h = await composedCloseHarness({ latePrepare: true, guardRun });
  const atStatus = deferred(), resumeStatus = deferred();
  let infos = 0, statuses = 0;
  h.state.onInfo = () => { infos++; };
  h.state.onStatus = async () => {
    // Fresh prepare bind -> nativeMutation check -> ctx.native final check.
    if (infos === 2 && ++statuses === 3) { atStatus.resolve(); await resumeStatus.promise; }
  };
  h.state.onNative = req => { if (req.intent.kind === 'closeTab') step.native.resolve(strictCloseReceipt(req)); };
  const step = h.start(1);
  try {
    await atStatus.promise;
    const observed = await step.observed.promise;
    if (stop) h.state.stopped = true;
    resumeStatus.resolve();
    const result = await step.completion;
    assert.equal(h.requests.length, 0, 'expiry during the final status await must leave zero parent native enqueues');
    assert.equal(observed.reason, 'close_prepare_timeout');
    assert.equal(result.error.code, stop ? 'user_cancelled' : 'close_prepare_timeout');
    assert.equal(result.error.inputDelivery, 'not_sent');
    assert.equal(result.error.sent.includes('close_tab'), false);
    assert.equal((await h.T.getTab(1)).closeBlocked, false);
    assert.ok(await h.T.getTab(3));
    assert.equal(h.events.some(event => ['restore', 'warp', 'handBack'].includes(event)), false);
  } finally { resumeStatus.resolve(); h.state.onStatus = null; await h.cleanup(); }
}
for (const stop of [false, true]) await check(`production final close status await expires safely${stop ? ' and preserves later native Stop' : ''}`,
  () => finalCloseEnqueueOracle(runInputAction, stop));
await check('production native Stop during final close status await refuses before preparation expires', async () => {
  const atStatus = deferred(), resumeStatus = deferred();
  const h = await composedCloseHarness({ latePrepare: true, onSleep: () => resumeStatus.promise });
  let infos = 0, statuses = 0;
  h.state.onInfo = () => { infos++; };
  h.state.onStatus = async () => {
    if (infos === 2 && ++statuses === 3) { atStatus.resolve(); await resumeStatus.promise; }
  };
  try {
    const step = h.start(1);
    await atStatus.promise;
    assert.ok(h.clock() < h.T.CLOSE_PREPARE_MS);
    h.state.stopped = true;
    resumeStatus.resolve();
    const result = await step.completion;
    assert.equal(result.error.code, 'user_cancelled');
    assert.equal(result.error.inputDelivery, 'not_sent');
    assert.equal(result.error.sent.includes('close_tab'), false);
    assert.deepEqual(h.requests, []);
    assert.equal((await h.T.getTab(1)).closeBlocked, false);
    assert.equal(h.events.some(event => ['restore', 'warp', 'handBack'].includes(event)), false);
  } finally { resumeStatus.resolve(); h.state.onStatus = null; await h.cleanup(); }
});
await check('valid close gate moved before final status await is killed by the zero-enqueue oracle', async () => {
  const original = await fs.readFile(new URL('../src/guard.js', import.meta.url), 'utf8');
  const gateStart = original.indexOf('        if (beforeCloseEnqueue != null) {');
  const gateEnd = original.indexOf("        const reply = await captured.request({ op: 'nativeChrome'", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  const gate = original.slice(gateStart, gateEnd);
  const marker = "      if (policy === 'normal') await ctx.check();";
  assert.equal(original.split(marker).length, 2);
  const mutated = original.replace(gate, '').replace(marker, gate + marker)
    .replace("from './bridge.js'", `from ${JSON.stringify(new URL('../src/bridge.js', import.meta.url).href)}`);
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(mutated).toString('base64'));
  await assert.rejects(finalCloseEnqueueOracle(mutant.runInputAction), error =>
    error.code === 'ERR_ASSERTION' && error.actual === 1 && error.expected === 0);
});

for (const [name, hook, intent, policy] of [
  ['nonfunction', 1], ['async function', async () => true], ['Promise', () => Promise.resolve(true)],
  ['rejected Promise', () => Promise.reject(Error('inert hook rejection'))],
  ['undefined grant', () => {}], ['false grant', () => false], ['object grant', () => ({})],
  ['other intent', () => true, { kind: 'selectTab', tabId: 1 }],
  ['other tab', () => true, { kind: 'closeTab', tabId: 3 }],
  ['restore policy', () => true, { kind: 'restoreScene' }, 'restore'],
]) await check(`private close enqueue hook rejects ${name} without native IO`, async () => {
  const h = harness(); h.c.PLAN = { task: 'close-hook-validation', returnFocus: { mode: 'current', source: 'explicit' } };
  try {
    const result = await h.c.inputAction('validate close hook', (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx),
      (_session, _prep, ctx) => ctx.native(intent || { kind: 'closeTab', tabId: 1 }, { policy: policy || 'normal', beforeCloseEnqueue: hook }),
      { nativeOnly: true, task: 'close-hook-validation', compact: true }).catch(e => e);
    assert.equal(result.code, 'native_session_required');
    assert.equal(result.inputDelivery, 'not_sent');
    assert.equal(h.events.filter(event => event === 'nativeChrome').length, 0);
  } finally { await h.c.endTaskHold(); }
});

for (const [name, change, code] of boundaryCases.slice(0, 5)) {
  await check(`production preparation ${name} remains not-sent with no blocked flag`, async () => {
    const gate = deferred(), atPrepare = deferred();
    const h = await composedCloseHarness({ latePrepare: true, onSleep: () => gate.promise });
    let infos = 0;
    h.state.onInfo = async () => { if (++infos === 2) { atPrepare.resolve(); await gate.promise; } };
    try {
      const step = h.start(1);
      await atPrepare.promise;
      change(h);
      gate.resolve();
      const result = await step.completion;
      assert.equal(result.error.code, code);
      assert.equal(result.error.inputDelivery, 'not_sent');
      assert.deepEqual(h.requests, []);
      assert.equal((await h.T.getTab(1)).closeBlocked, false);
      assert.ok(await h.T.getTab(3));
      if (name !== 'Pause') assert.equal(h.events.some(event => ['restore', 'warp', 'handBack'].includes(event)), false);
    } finally { gate.resolve(); await h.cleanup(); }
  });
}
for (const [name, change] of [...recordCases, ['protected filename', h => fs.rename(path.join(h.registry, '1.json'), path.join(h.registry, '1.protected.json'))]]) {
  await check(`production preparation preserves foreign ${name} and sends no close`, async () => {
    const gate = deferred(), atPrepare = deferred();
    const h = await composedCloseHarness({ latePrepare: true, onSleep: () => gate.promise });
    let infos = 0;
    h.state.onInfo = async () => { if (++infos === 2) { atPrepare.resolve(); await gate.promise; } };
    try {
      const step = h.start(1);
      await atPrepare.promise;
      await change(h);
      const before = await h.T.getTab(1), names = (await fs.readdir(h.registry)).sort();
      const flags = await Promise.all(names.filter(name => /\.(blocked|taken)\.json$/.test(name))
        .map(async name => [name, await fs.readFile(path.join(h.registry, name), 'utf8')]));
      gate.resolve();
      const result = await step.completion;
      assert.ok(['ownership_unverified', 'taken_over', 'close_blocked'].includes(result.error?.code), result.error?.code);
      assert.equal(result.error.inputDelivery, 'not_sent');
      assert.deepEqual(h.requests, []);
      const afterNames = (await fs.readdir(h.registry)).sort();
      assert.ok(names.every(name => afterNames.includes(name)), 'no foreign record or flag is removed');
      assert.deepEqual(afterNames.filter(name => /\.(blocked|taken)\.json$/.test(name)),
        names.filter(name => /\.(blocked|taken)\.json$/.test(name)), 'no sticky flag is invented by the unsent attempt');
      const after = await h.T.getTab(1);
      for (const [key, value] of Object.entries(before)) if (key !== 'agentDoneAt') assert.deepEqual(after[key], value);
      for (const [name, bytes] of flags) assert.equal(await fs.readFile(path.join(h.registry, name), 'utf8'), bytes);
      assert.ok(await h.T.getTab(3));
    } finally { gate.resolve(); await h.cleanup(); }
  });
}
for (const delivery of [undefined, 'sent', 'unknown']) {
  await check(`production failed preparation preserves ${delivery || 'absent'} delivery and original error`, async () => {
    const h = await composedCloseHarness({ latePrepare: true });
    const original = Object.assign(new BridgeError('chromectl_failed', 'inert preparation failure'),
      delivery ? { inputDelivery: delivery, noRetry: true } : {});
    let infos = 0;
    h.state.onInfo = () => { if (++infos === 2) throw original; };
    try {
      const step = h.start(1);
      const result = await step.completion;
      assert.equal(result.error, original);
      assert.equal(result.error.inputDelivery, delivery || 'not_sent');
      assert.equal(step.observerResult.reason, 'chromectl_failed');
      assert.equal(step.observerResult.inputDelivery, delivery || 'not_sent');
      assert.deepEqual(h.requests, []);
      assert.equal((await h.T.getTab(1)).closeBlocked, false);
    } finally { await h.cleanup(); }
  });
}
for (const delivery of ['sent', 'unknown']) {
  await check(`production long preparation gives ${delivery} receipt its own confirmation window with no retry`, async () => {
    const gate = deferred();
    const h = await composedCloseHarness({ latePrepare: true, onSleep: ({ ticks }) => { if (ticks >= 5000) gate.resolve(); } });
    let infos = 0;
    h.state.onInfo = async () => { if (++infos === 2) await gate.promise; };
    try {
      const step = h.start(1);
      await observeDeadline(h, step);
      assert.ok(step.enteredAt >= 5000 && step.enteredAt < 25000);
      assert.ok(h.clock() >= step.enteredAt + 3000);
      assert.equal((await h.T.getTab(1)).closeBlocked, false, 'entered close defers only its own blocked mark');
      step.native.resolve({ ...strictCloseReceipt(step.request), inputDelivery: delivery });
      if (delivery === 'sent') {
        assert.equal((await step.completion).error, undefined);
        assert.equal(await h.T.getTab(1), null);
      } else {
        const error = await assertRejectedComposition(h, step, 'native_delivery_unknown');
        assert.equal(error.inputDelivery, 'unknown');
        assert.equal((await h.T.getTab(1)).closeBlocked, true);
      }
      assert.equal(h.requests.length, 1);
    } finally { gate.resolve(); await h.cleanup(); }
  });
}
await check('production composed A receipt cannot be reused for another B operation', async () => {
  const h = await composedCloseHarness();
  try {
    const first = h.start(1);
    await observeDeadline(h, first);
    const receipt = strictCloseReceipt(first.request);
    first.native.resolve(receipt);
    assert.equal((await first.completion).error, undefined);
    assert.equal(await h.T.getTab(1), null);
    h.finishStep();
    const second = h.start(3);
    await observeDeadline(h, second);
    second.native.resolve(receipt);
    const result = await second.completion;
    assert.equal(result.error.code, 'native_delivery_unknown');
    assert.equal(result.error.noRetry, true);
    assert.equal(result.error.inputDelivery, 'unknown');
    assert.ok(await h.T.getTab(3));
    assert.deepEqual(h.requests.map(req => req.intent.tabId), [1, 3]);
  } finally { await h.cleanup(); }
});


for (const kind of ['taken flag', 'blocked flag', 'replacement record']) {
  await check(`production composed ${kind} written during final status wait survives strict late success`, async () => {
    const h = await composedCloseHarness();
    const atStatus = deferred(), resumeStatus = deferred();
    let statusPaused = false;
    try {
      const step = h.start(1);
      await observeDeadline(h, step);
      h.state.onStatus = async () => {
        // The first status after this actual native receipt is the finalizer's
        // existing ctx.check, reached after its real asynchronous getTab read.
        // Only this bottom transport response is paused; no finalizer is mocked.
        if (!step.nativeReturned || statusPaused) return;
        statusPaused = true;
        atStatus.resolve();
        await resumeStatus.promise;
      };
      step.native.resolve(strictCloseReceipt(step.request));
      await Promise.race([atStatus.promise, step.completion.then(result => {
        throw Error(`close ended before the final status wait: ${result.error?.stack || result.value}`);
      })]);
      assert.equal(step.nativeReturned, true, 'the strict native result completed before registry interference');
      assert.equal(h.c.TASK_HOLD, h.retained.hold);
      assert.equal(h.c.TASK_HOLD.lease, h.retained.lease);
      assert.equal(h.c.TASK_HOLD.kept.session, h.retained.session);
      assert.equal(h.c.TASK_HOLD.kept.nativeState.epoch, h.retained.epoch);
      assert.equal(h.state.held, true);
      assert.equal(h.events.includes('release'), false);
      const original = await h.T.getTab(1);
      assert.equal(original.takenOver, false);
      assert.equal(original.closeBlocked, false);
      if (kind === 'taken flag') await h.T.markTakenOver(1, 'user_viewing', 9011);
      else if (kind === 'blocked flag') await h.T.markCloseBlocked(1, 9022);
      else await h.T.registerTab(1, 'https://fixture.test/', { ownerPid: process.pid + 1, windowId: 10, now: 9033 });
      const before = await h.T.getTab(1);
      const namesBefore = (await fs.readdir(h.registry)).sort();
      const flag = kind === 'taken flag' ? '1.taken.json' : kind === 'blocked flag' ? '1.blocked.json' : null;
      const flagBefore = flag && await fs.readFile(path.join(h.registry, flag), 'utf8');
      resumeStatus.resolve();
      const result = await step.completion;
      const after = await h.T.getTab(1);
      assert.equal(result.error?.code, 'close_blocked',
        `final status wait ${kind} must veto stale registry authorization; record ${after ? 'present' : 'deleted'}, result ${result.value || result.error?.code}`);
      await assertRejectedComposition(h, step, 'close_blocked');
      assert.deepEqual((await fs.readdir(h.registry)).sort(), namesBefore, 'no intervening record or flag is deleted and no stale blocked mark is added');
      for (const [key, value] of Object.entries(before)) {
        if (key !== 'agentDoneAt') assert.deepEqual(after[key], value, `status-wait preserves ${kind} field ${key}`);
      }
      assert.ok(Number.isFinite(after.agentDoneAt) && after.agentDoneAt >= before.agentDoneAt);
      if (flag) assert.equal(await fs.readFile(path.join(h.registry, flag), 'utf8'), flagBefore, 'independent sticky flag bytes remain unchanged');
      assert.equal(h.events.some(event => ['restore', 'warp', 'handBack'].includes(event)), false);
    } finally {
      resumeStatus.resolve();
      h.state.onStatus = null;
      await h.cleanup();
    }
  });
}


const focusPolicy = (mode, source = 'explicit') => ({ mode, source });
const focusWrites = events => events.filter(x => ['handBack', 'restore-app', 'restore', 'warp'].includes(x));
for (const kind of ['blocked', 'reason', 'empty']) await check(`origin no-field ${kind} selects only an intended human handoff`, async () => {
  const h = harness(); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
  await h.call('openTabTool', openArgs); assert.ok(h.c.TASK_HOLD); const start = h.events.length;
  if (kind === 'blocked') h.state.blocked = true;
  const result = await h.call('waitForUserTool', { tab: 1, reason: kind === 'reason' ? 'fixture approval' : '  ' });
  const tail = h.events.slice(start); assert.equal(h.c.TASK_HOLD, null);
  assert.equal(tail.filter(x => x === 'release').length, 1);
  if (kind === 'empty') { assert.match(result, /不需要等/); assert.ok(tail.includes('restore')); assert.equal(tail.includes('notify'), false); }
  else { assert.deepEqual(focusWrites(tail), []); assert.ok(tail.indexOf('release') >= 0 && tail.indexOf('release') < tail.indexOf('notify')); }
});
for (const errorKind of ['offscreen', 'focus', 'arm', 'target']) await check(`field ${errorKind} failure before handoff retains origin restoration and no ready`, async () => {
  const h = harness({ offscreen: errorKind === 'offscreen', focusTokenMissing: errorKind === 'focus', armError: errorKind === 'arm' });
  if (errorKind === 'target') h.state.armEffect = ctx => ctx.bindNativeTarget({ ...target(3), tabId: 99 });
  const error = await h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture input' }).catch(e => e);
  assert.equal(error.code, { offscreen: 'target_offscreen', focus: 'focus_unconfirmed', arm: 'arm_failed', target: 'native_target_changed' }[errorKind]);
  assert.equal(h.events.includes('notify'), false); assert.equal(h.c.BLOCKS.size, 0); assert.equal(h.state.closed, 1);
  assert.ok(h.events.includes('restore'), h.events.join(','));
  if (errorKind === 'target') assert.ok(h.events.includes('disarm'));
});
// Contract D (new fix): the same production entry, with a native dialog open by the time the highlight is withdrawn.
await check('D field cleanup through waitForUserTool: a dialog open after arming gets no disarm eval', async () => {
  const h = harness();
  h.state.armEffect = ctx => { h.state.dialog = true; return ctx.bindNativeTarget({ ...target(3), tabId: 99 }); };
  const error = await h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture input' }).catch(e => e);
  assert.equal(error.code, 'native_target_changed');
  assert.equal(h.events.includes('disarm'), false, h.events.join(','));
  assert.ok(h.events.includes('dialog-read'), 'the withdrawal asked the native dialog state first');
  assert.equal(h.events.includes('notify'), false);
});
for (const mode of ['user', 'late', 'end']) for (const disarm of ['confirmed', 'eval-failure', 'script-failure']) await check(`post-handoff ${mode} with ${disarm} preserves error, zero focus writes and no false ready`, async () => {
  const h = harness({ endFailure: mode === 'end', disarmFailure: disarm === 'eval-failure', disarmScriptFailure: disarm === 'script-failure' });
  let afterArm = 0;
  h.state.onStatus = () => { if (h.state.armed && ++afterArm === (mode === 'user' ? 2 : mode === 'late' ? 3 : -1)) h.state.interrupted = { kind: 'key', epoch: 1000 }; };
  const error = await h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture input' }).catch(e => e);
  assert.equal(error.code, mode === 'end' ? 'input_release_unverified' : 'user_interrupted');
  assert.equal(error.noRetry, true); assert.equal(h.events.includes('notify'), false); assert.equal(h.c.BLOCKS.size, 0);
  assert.equal(h.state.closed, 1); assert.deepEqual(focusWrites(h.events), []); assert.match(error.message, /未请求焦点恢复/);
  if (disarm === 'confirmed') assert.match(error.message, /提示已撤回/);
  else { assert.match(error.message, /撤回未确认/); assert.doesNotMatch(error.message, /提示已撤回/); }
  if (mode === 'end') assert.doesNotMatch(error.message, /键盘鼠标接管已结束|保留当前页面/);
});
for (const selection of ['current', 'origin']) for (const path of ['short', 'task']) await check(`${selection} ${path} acquisition registers the correct inherit intent`, async () => {
  const h = harness(); const p = focusPolicy(selection);
  if (path === 'task') h.c.PLAN = { task: 'fixture', returnFocus: p };
  const text = await h.c.inputAction('inert operation', async (_pre, _scene, ctx) => h.c.prepareNativeTarget(1, ctx), async () => 'done',
    { nativeOnly: true, task: path === 'task' ? 'fixture' : '', returnFocus: p, compact: true });
  if (selection === 'current') {
    assert.match(text, /未请求焦点恢复/); assert.doesNotMatch(text, /已把光标|前台 App 已切回|光标恢复未确认/);
    assert.match(text, path === 'task' ? /接管仍在保持/ : /接管已结束/);
    if (path === 'task') assert.doesNotMatch(text, /接管已结束/);
  }
  assert.equal(h.state.leaseOptions.length, 1); assert.equal(h.state.leaseOptions[0].kind, path);
  assert.equal(h.state.leaseOptions[0].inherit, selection === 'origin');
  if (path === 'task') await h.c.endTaskHold();
});
for (const planned of [false, true]) for (const held of [false, true]) for (const sourceKind of ['legacy_default', 'explicit']) for (const mode of ['origin', 'current']) {
  if (!planned && !held && sourceKind === 'explicit') continue;
  if (sourceKind === 'legacy_default' && mode === 'current') continue;
  await check(`open shared precedence plan=${planned} held=${held} policy=${sourceKind}/${mode}`, async () => {
    const h = harness(), p = focusPolicy(mode, sourceKind);
    if (planned || held) h.c.PLAN = { task: 'fixture', returnFocus: p };
    if (held) { await h.call('openTabTool', openArgs); if (!planned) h.c.PLAN = null; }
    const before = h.events.length, screenCalls = h.state.screenCalls || 0, plan = h.c.PLAN;
    const previousPolicy = plan?.returnFocus;
    const result = await h.call('openTabTool', { ...openArgs, why: 'same_page_with_user' }).catch(e => e);
    const conflict = (planned || held) && sourceKind === 'explicit' && mode === 'origin';
    if (conflict) { assert.equal(result.code, 'return_focus_conflict'); assert.equal(h.events.length, before); assert.equal(h.state.screenCalls || 0, screenCalls); assert.equal(h.c.PLAN, plan); }
    else {
      assert.equal(typeof result, 'string');
      const expected = held ? mode : 'current';
      if (h.c.TASK_HOLD) assert.equal(h.c.TASK_HOLD.kept.returnFocus.mode, expected);
      if (held && mode === 'origin') assert.match(result, /没有改写已持有的归还策略/);
      if (planned && !held && sourceKind === 'legacy_default') assert.deepEqual(h.c.PLAN.returnFocus, focusPolicy('current', 'why_signal'));
      if (!planned && !held) { assert.equal(h.c.TASK_HOLD, null); assert.equal(h.state.leaseOptions.at(-1).kind, 'short'); assert.equal(h.state.leaseOptions.at(-1).inherit, false); }
    }
    if (conflict) assert.equal(plan?.returnFocus, previousPolicy);
    if (h.c.TASK_HOLD) await h.c.endTaskHold();
  });
}
await check('shared bad URL and lock failure never promote a legacy plan', async () => {
  for (const fail of ['url', 'lease']) {
    const h = harness(); const p = focusPolicy('origin', 'legacy_default'); h.c.PLAN = { task: 'fixture', returnFocus: p };
    if (fail === 'lease') h.state.leaseError = new BridgeError('lock_timeout', 'synthetic queue stalled');
    const error = await h.call('openTabTool', { url: fail === 'url' ? 'file:///no' : openArgs.url, why: 'same_page_with_user' }).catch(e => e);
    assert.equal(error.code, fail === 'url' ? 'bad_url' : 'lock_timeout'); assert.equal(h.c.PLAN.returnFocus, p); assert.equal(h.c.TASK_HOLD, null);
    if (fail === 'url') { assert.equal(h.state.screenCalls || 0, 0); assert.equal(h.events.length, 0); }
  }
});
await check('implicit shared hold expires its policy when released and later ordinary input captures fresh origin', async () => {
  const h = harness(); h.c.TASK_GAP_MS = 30000; h.c.taskKey = () => 'implicit fixture';
  await h.call('openTabTool', { ...openArgs, why: 'same_page_with_user' });
  assert.equal(h.c.TASK_HOLD.kept.returnFocus.mode, 'current'); const first = h.c.TASK_HOLD.kept;
  await h.c.inputAction('inert click', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async () => '', { nativeOnly: true, task: 'implicit fixture', compact: true });
  assert.equal(h.c.TASK_HOLD.kept.returnFocus.mode, 'current'); await h.c.endTaskHold();
  assert.deepEqual(focusWrites(h.events), []);
  await h.call('openTabTool', openArgs); assert.equal(h.c.TASK_HOLD.kept.returnFocus.mode, 'origin');
  assert.notEqual(h.c.TASK_HOLD.kept, first); assert.equal(h.events.filter(x => x === 'snapshot').length, 2);
  await h.c.endTaskHold(); assert.ok(h.events.includes('restore'));
});
for (const missing of [undefined, { mode: 'bogus', source: 'explicit' }]) await check('reused missing policy with an already-claimed lease handoff closes the original Session', async () => {
  const h = harness(); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') }; await h.call('openTabTool', openArgs);
  const th = h.c.TASK_HOLD; th.kept.returnFocus = missing; th.lease.handoff = { scene: {} }; th.lease.claimed = true;
  const before = h.events.length;
  const result = await h.c.taskRun('inert release', { takeover: true, nativeTransactions: true, returnFocus: focusPolicy('origin'), releaseAfter: true,
    now: Date.now, prepare: async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx) }, async () => '', 'fixture');
  assert.equal(result.result.focusRestoration, 'policy_invalid'); assert.equal(h.c.TASK_HOLD, null);
  const tail = h.events.slice(before); assert.deepEqual(focusWrites(tail), []); assert.equal(tail.filter(x => x === 'release').length, 1); assert.equal(tail.filter(x => x === 'lease-release').length, 1);
});


for (const invalid of [undefined, { mode: 'current', source: 'bogus' }]) await check('shared open refuses invalid kept policy before screen wake or any mutation', async () => {
  const h = harness(); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin', 'legacy_default') };
  await h.call('openTabTool', openArgs); const held = h.c.TASK_HOLD, plan = h.c.PLAN;
  held.kept.returnFocus = invalid; const before = h.events.length, screens = h.state.screenCalls;
  await assert.rejects(h.call('openTabTool', { ...openArgs, why: 'same_page_with_user' }), e => e.code === 'focus_policy_invalid');
  assert.equal(h.c.TASK_HOLD, held); assert.equal(h.c.PLAN, plan); assert.equal(h.events.length, before); assert.equal(h.state.screenCalls, screens);
  await h.c.endTaskHold();
});
await check('successful field handoff ends the old hold and next acquisition snapshots the visible scene', async () => {
  const h = harness(); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
  await h.call('openTabTool', openArgs); const original = h.c.TASK_HOLD.kept;
  assert.equal(original.scene.appPid, 9);
  await h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture input' });
  assert.equal(h.c.TASK_HOLD, null); assert.equal(h.state.scene.appPid, 42); assert.equal(h.state.scene.chromeTab, 3);
  await h.call('openTabTool', openArgs); const next = h.c.TASK_HOLD.kept;
  assert.notEqual(next, original); assert.equal(next.scene.appPid, 42); assert.equal(next.scene.chromeTab, 3);
  assert.deepEqual(next.returnFocus, focusPolicy('origin')); await h.c.endTaskHold();
  assert.equal(h.state.scene.appPid, 42); assert.equal(h.state.scene.chromeTab, 3);
});


await check('valid early-handoff mutant cannot discard borrowed origin when arming the field fails', async () => {
  const anchor = 'ask = await armAsk(tabId, field, why, ctx, fresh.focusToken);';
  assert.equal(source.split(anchor).length - 1, 1);
  const mutated = source.replace(anchor, 'await ctx.handToHuman(prep.target); ' + anchor);
  async function oracle(code) {
    const h = harness({ armError: true }, code);
    const error = await h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture input' }).catch(e => e);
    assert.equal(error.code, 'arm_failed'); assert.equal(h.events.includes('notify'), false);
    assert.ok(h.events.includes('restore'), 'failed arm before handoff must restore borrowed origin');
  }
  await oracle(source); await assert.rejects(oracle(mutated), e => e.code === 'ERR_ASSERTION');
});

// R2 public paths use the production endTaskHold, TASK_NOTE, LATE_USER_NOTE
// and timingLine above. End-only fixtures do not alter any earlier status.
const r2Failures = [];
async function r2check(name, fn) {
  try { await check(name, fn); }
  catch (error) { r2Failures.push({ name, stack: error.stack }); console.error(`FAIL ${name}\n${error.stack}`); }
}
for (const kind of ['field', 'blocked', 'reason']) for (const endVariant of ['healthy', 'aborted', 'interrupted', 'session_interrupted']) {
  await r2check(`terminal-only ${kind}/${endVariant} cannot announce ready after Stop`, async () => {
    const h = harness(); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
    await h.call('openTabTool', openArgs); const start = h.events.length;
    h.state.endVariant = endVariant; h.state.blocked = kind === 'blocked';
    const result = await h.call('waitForUserTool', { tab: 3, reason: 'fixture approval', ...(kind === 'field' ? { field: 4 } : {}) }).catch(e => e);
    const tail = h.events.slice(start);
    assert.deepEqual(focusWrites(tail), []); assert.equal(h.state.closed, 1);
    assert.equal(tail.filter(x => x === 'lease-release').length, 1); assert.equal(h.c.TASK_HOLD, null);
    if (endVariant === 'healthy') { assert.equal(typeof result, 'string'); assert.ok(tail.includes('notify')); return; }
    assert.ok(result instanceof Error, 'terminal Stop must reject the public wait, not return human wait');
    assert.ok(['user_interrupted', 'user_cancelled', 'task_interrupted'].includes(result.code), result.code);
    assert.equal(result.noRetry, true); assert.equal(result.releaseReason, 'human_handoff');
    assert.equal(result.inputReleased, true, 'confirmed release remains distinct from missing end');
    assert.equal(tail.includes('notify'), false); assert.equal(tail.includes('human-wait'), false); assert.equal(h.c.BLOCKS.size, 0);
    if (kind === 'field') { assert.ok(tail.includes('disarm')); assert.match(result.message, /提示已撤回/); }
  });
}
const noRestorationText = /切回后观察|还原窗口|交还前台App|还原之前|还原的过程中|操作完已把光标|前台 App 已切回/;
for (const mode of ['origin', 'current', 'invalid']) for (const retained of [false, true]) for (const compact of [false, true]) {
  await r2check(`actual ${compact ? 'compact' : 'detailed'} ${mode}/${retained ? 'retained' : 'released'} receipt agrees with physical policy`, async () => {
    const h = harness({ env: { CHROME_BRIDGE_TIMING_DETAIL: '1' } });
    if (retained || mode === 'invalid') {
      h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy(mode === 'invalid' ? 'origin' : mode) };
      await h.call('openTabTool', openArgs);
      if (mode === 'invalid') delete h.c.TASK_HOLD.kept.returnFocus;
    }
    const before = h.events.length;
    const result = await h.c.inputAction('inert detail tab 1', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async () => 'done',
      { nativeOnly: true, task: retained || mode === 'invalid' ? 'fixture' : '', returnFocus: mode === 'invalid' ? null : focusPolicy(mode), compact, releaseAfter: !retained });
    if (mode === 'origin') { if (compact) assert.equal(result, 'done'); else assert.match(result, retained ? /持续接管/ : /操作完已把光标/); }
    else {
      assert.deepEqual(focusWrites(h.events.slice(before)), []); assert.doesNotMatch(result, noRestorationText);
      assert.match(result, /未请求焦点恢复|不请求焦点恢复|不执行恢复/);
      assert.match(result, retained ? /接管.*保持|持续接管/ : /接管已结束/);
      if (mode === 'invalid') assert.match(result, /焦点归还策略缺失或无效/);
    }
    if (h.c.TASK_HOLD) await h.c.endTaskHold();
  });
}
await r2check('ordinary public open retains invalid held-policy diagnostic', async () => {
  const h = harness(); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
  await h.call('openTabTool', openArgs); delete h.c.TASK_HOLD.kept.returnFocus; const before = h.events.length;
  const result = await h.call('openTabTool', openArgs);
  assert.deepEqual(focusWrites(h.events.slice(before)), []);
  assert.match(result, /焦点归还策略缺失或无效/); assert.match(result, /接管仍在保持|持续接管/);
  assert.doesNotMatch(result, noRestorationText); await h.c.endTaskHold();
});
for (const kind of ['field', 'blocked', 'reason']) for (const planned of [false, true]) for (const by of ['esc', 'shake']) {
  await r2check(`terminal ${kind}/${planned ? 'explicit' : 'implicit'}/${by} refuses same-task reacquisition`, async () => {
    const h = harness(); h.c.TASK_GAP_MS = 30000; h.c.taskKey = () => 'fixture';
    if (planned) h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
    await h.call('openTabTool', openArgs); h.state.endVariant = 'aborted'; h.state.endAbortedBy = by; h.state.blocked = kind === 'blocked';
    const error = await h.call('waitForUserTool', { tab: 3, reason: 'fixture approval', ...(kind === 'field' ? { field: 4 } : {}) }).catch(e => e);
    assert.ok(error instanceof Error); assert.equal(error.noRetry, true); assert.equal(error.releaseReason, 'human_handoff');
    assert.equal(h.c.TASK_CANCELLED, 'fixture');
    if (planned) assert.ok(h.c.PLAN.interrupted, 'explicit project remains interrupted');
    const before = h.events.length, screens = h.state.screenCalls;
    await assert.rejects(h.call('openTabTool', openArgs), e => e.code === 'user_cancelled' || e.code === 'task_interrupted');
    assert.equal(h.events.length, before, 'same task sends no lease, Session, restoration, notification or input');
    assert.equal(h.state.screenCalls, screens); assert.equal(h.c.TASK_HOLD, null);
  });
}
for (const disarm of ['confirmed', 'eval-failure', 'script-failure']) for (const endFailure of [false, true]) {
  await r2check(`end-only field interruption preserves ${disarm} withdrawal and ${endFailure ? 'unconfirmed' : 'confirmed'} release`, async () => {
    const h = harness({ endVariant: 'session_interrupted', endFailure, disarmFailure: disarm === 'eval-failure', disarmScriptFailure: disarm === 'script-failure' });
    const error = await h.call('waitForUserTool', { tab: 3, field: 4, reason: 'fixture input' }).catch(e => e);
    assert.equal(error.code, 'user_interrupted'); assert.equal(error.noRetry, true); assert.equal(error.releaseReason, 'human_handoff');
    assert.equal(error.inputReleased, !endFailure); assert.equal(error.terminalInterrupted, true);
    assert.equal(h.events.includes('notify'), false); assert.equal(h.events.includes('human-wait'), false); assert.equal(h.c.BLOCKS.size, 0);
    assert.equal(h.state.closed, 1); assert.equal(h.events.filter(x => x === 'lease-release').length, 1); assert.deepEqual(focusWrites(h.events), []);
    if (disarm === 'confirmed') assert.match(error.message, /提示已撤回/);
    else { assert.match(error.message, /撤回未确认/); assert.doesNotMatch(error.message, /提示已撤回/); }
    if (endFailure) assert.doesNotMatch(error.message, /接管已结束|保留当前页面/);
  });
}
for (const mode of ['origin', 'current', 'invalid']) for (const branch of ['user', 'out-user', 'late', 'error', 'late-error']) {
  await r2check(`actual non-native ${mode}/${branch} receipt preserves error and truthful focus facts`, async () => {
    const h = harness({ nonNative: true, env: { CHROME_BRIDGE_TIMING_DETAIL: '1' } }); h.c.TAKEOVER = true;
    if (mode === 'invalid') {
      h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
      await h.call('openTabTool', openArgs); delete h.c.TASK_HOLD.kept.returnFocus;
    }
    const before = h.events.length; let afterAction = false, statuses = 0;
    if (['out-user', 'late', 'late-error'].includes(branch)) h.state.onStatus = () => {
      if (afterAction && ++statuses === (branch === 'out-user' ? 1 : 2)) h.state.interrupted = { kind: 'key', epoch: 1000 };
    };
    const originalError = new BridgeError('fixture_action_error', 'original action failure');
    const result = await h.c.inputAction('inert non-native tab 1', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async () => {
      afterAction = true;
      if (branch === 'user') throw new UserInterrupted({ kind: 'key', epoch: 1000 });
      if (branch.includes('error')) throw originalError;
      return 'action completed';
    }, { nativeOnly: false, task: mode === 'invalid' ? 'fixture' : '', returnFocus: mode === 'invalid' ? null : focusPolicy(mode), compact: false, releaseAfter: branch.includes('error') }).catch(e => e);
    if (branch.includes('error')) assert.equal(result, originalError, 'original thrown error identity survives reporting');
    else if (branch === 'user') { assert.equal(result.code, 'user_interrupted'); assert.match(result.message, /剪贴板已还原/); }
    else assert.equal(typeof result, 'string');
    const text = typeof result === 'string' ? result : result.message;
    if (mode === 'origin') {
      if (branch === 'late' || branch === 'late-error') assert.match(text, /还原之前|还原的过程中/, 'origin executes the real LATE_USER_NOTE');
    } else {
      assert.deepEqual(focusWrites(h.events.slice(before)), []); assert.doesNotMatch(text, noRestorationText);
      assert.match(text, /未请求焦点恢复|没有请求焦点恢复/);
      if (mode === 'invalid') assert.match(text, /归还策略缺失或无效/);
      assert.match(text, /接管已结束|接管仍在保持/);
    }
    if (h.c.TASK_HOLD) await h.c.endTaskHold();
  });
}
for (const mode of ['origin', 'current', 'invalid']) await r2check(`actual retained ${mode} error preserves original hold without a false release claim`, async () => {
  const h = harness({ nonNative: true, env: { CHROME_BRIDGE_TIMING_DETAIL: '1' } }); h.c.TAKEOVER = true;
  h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy(mode === 'invalid' ? 'origin' : mode) };
  await h.call('openTabTool', openArgs); if (mode === 'invalid') delete h.c.TASK_HOLD.kept.returnFocus;
  const hold = h.c.TASK_HOLD, before = h.events.length, originalError = new BridgeError('fixture_action_error', 'original recoverable action failure');
  const error = await h.c.inputAction('inert non-native tab 1', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async () => { throw originalError; },
    { nativeOnly: false, task: 'fixture', compact: false }).catch(e => e);
  assert.equal(error, originalError); assert.equal(error.keptHold, true); assert.equal(h.c.TASK_HOLD, hold); assert.equal(h.state.held, true);
  assert.deepEqual(focusWrites(h.events.slice(before)), []); assert.equal(h.events.slice(before).includes('release'), false);
  assert.doesNotMatch(error.message, /接管已结束|保留当前页面/);
  if (mode !== 'origin') { assert.doesNotMatch(error.message, noRestorationText); assert.match(error.message, /未请求焦点恢复/); }
  if (mode === 'invalid') assert.match(error.message, /归还策略缺失或无效/);
  await h.c.endTaskHold();
});
for (const kind of ['blocked', 'reason']) await r2check(`end-only ${kind} interruption outranks missing release confirmation without ready`, async () => {
  const h = harness(); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
  await h.call('openTabTool', openArgs); const before = h.events.length;
  h.state.endVariant = 'session_interrupted'; h.state.endFailure = true; h.state.blocked = kind === 'blocked';
  const error = await h.call('waitForUserTool', { tab: 3, reason: 'fixture approval' }).catch(e => e);
  assert.equal(error.code, 'user_interrupted'); assert.equal(error.noRetry, true); assert.equal(error.inputReleased, false);
  assert.equal(error.releaseReason, 'human_handoff'); assert.equal(error.terminalInterrupted, true);
  const tail = h.events.slice(before); assert.deepEqual(focusWrites(tail), []);
  assert.equal(tail.filter(x => x === 'release').length, 1); assert.equal(tail.filter(x => x === 'lease-release').length, 1);
  assert.equal(tail.includes('notify'), false); assert.equal(tail.includes('human-wait'), false); assert.equal(h.c.BLOCKS.size, 0);
  assert.doesNotMatch(error.message, /接管已结束|保留当前页面/);
});
for (const planned of [false, true]) for (const errorCode of ['fixture_action_error', 'task_hold_lost']) await r2check(`original ${errorCode} after terminal Stop latches ${planned ? 'explicit' : 'implicit'} task before another acquisition`, async () => {
  const h = harness(); h.c.TASK_GAP_MS = 30000; h.c.taskKey = () => 'fixture';
  if (planned) h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
  await h.call('openTabTool', openArgs); h.state.endVariant = 'aborted';
  const originalError = Object.assign(new BridgeError(errorCode, 'original error after successful marker'), { by: 'esc' }), before = h.events.length;
  const error = await h.c.inputAction('inert detail tab 1', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async (_session, prep, ctx) => {
    await ctx.handToHuman(prep.target); throw originalError;
  }, { nativeOnly: true, task: 'fixture', releaseAfter: true }).catch(e => e);
  assert.equal(error, originalError); assert.equal(error.noRetry, true); assert.equal(error.terminalInterrupted, true); assert.equal(h.c.TASK_CANCELLED, 'fixture');
  assert.deepEqual(focusWrites(h.events.slice(before)), []); assert.equal(h.state.closed, 1);
  const stopped = h.events.length; await assert.rejects(h.call('openTabTool', openArgs), e => e.code === 'user_cancelled'); assert.equal(h.events.length, stopped);
});
for (const mode of ['origin', 'current', 'invalid']) await r2check(`actual detailed ${mode} successful human handoff uses neutral timing`, async () => {
  const h = harness({ env: { CHROME_BRIDGE_TIMING_DETAIL: '1' } });
  if (mode === 'invalid') { h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') }; await h.call('openTabTool', openArgs); delete h.c.TASK_HOLD.kept.returnFocus; }
  const before = h.events.length;
  const text = await h.c.inputAction('inert detail tab 1', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async (_session, prep, ctx) => {
    await ctx.handToHuman(prep.target); return 'handoff prepared';
  }, { nativeOnly: true, task: mode === 'invalid' ? 'fixture' : '', returnFocus: mode === 'invalid' ? null : focusPolicy(mode), releaseAfter: true, compact: false });
  assert.deepEqual(focusWrites(h.events.slice(before)), []); assert.match(text, /接管已结束/); assert.match(text, /未请求焦点恢复/);
  assert.match(text, /耗时/); assert.match(text, /收尾后观察|收尾/); assert.doesNotMatch(text, noRestorationText);
});
for (const mode of ['current', 'invalid']) await r2check(`actual detailed ${mode} missing end never claims confirmed release`, async () => {
  const h = harness({ env: { CHROME_BRIDGE_TIMING_DETAIL: '1' } });
  if (mode === 'invalid') { h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') }; await h.call('openTabTool', openArgs); delete h.c.TASK_HOLD.kept.returnFocus; }
  const before = h.events.length; h.state.endFailure = true;
  const text = await h.c.inputAction('inert detail tab 1', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async () => 'done',
    { nativeOnly: true, task: mode === 'invalid' ? 'fixture' : '', returnFocus: mode === 'invalid' ? null : focusPolicy(mode), compact: false, releaseAfter: mode === 'invalid' }).catch(e => e);
  const receipt = typeof text === 'string' ? text : text.message;
  assert.deepEqual(focusWrites(h.events.slice(before)), []); assert.doesNotMatch(receipt, /接管已结束|保留当前页面|释放后观察|结束接管/);
  if (typeof text !== 'string') { assert.equal(text.code, 'input_release_unverified'); assert.equal(text.inputReleased, false); }
  else assert.match(receipt, /未确认.*接管已解除/);
  assert.doesNotMatch(receipt, noRestorationText);
});
await r2check('actual invalid-policy unconfirmed release timing remains diagnostic and neutral', async () => {
  const h = harness({ env: { CHROME_BRIDGE_TIMING_DETAIL: '1' } }); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
  await h.call('openTabTool', openArgs); delete h.c.TASK_HOLD.kept.returnFocus; h.state.endFailure = true; const before = h.events.length;
  const { result } = await h.c.taskRun('inert release', { takeover: true, nativeTransactions: true, releaseAfter: true, now: Date.now,
    prepare: async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx) }, async () => 'done', 'fixture');
  assert.equal(result.inputReleased, false); assert.equal(result.focusRestoration, 'policy_invalid');
  const text = h.c.focusReturnNote(result) + h.c.timingLine(result.timing, result);
  assert.match(text, /未确认.*接管已解除/); assert.match(text, /归还策略缺失或无效/); assert.match(text, /收尾/);
  assert.doesNotMatch(text, /接管已结束|保留当前页面|释放后观察|结束接管/); assert.doesNotMatch(text, noRestorationText);
  assert.deepEqual(focusWrites(h.events.slice(before)), []); assert.equal(h.state.closed, 1);
});
async function actualIndexMutant(name, from, to, oracle) {
  assert.equal(source.split(from).length - 1, 1, `${name}: unique valid production mutation`);
  await oracle(source);
  await assert.rejects(oracle(source.replace(from, to)), e => e.code === 'ERR_ASSERTION', `${name}: only semantic failure kills the mutant`);
}
await r2check('valid detailed-note-dropping mutant fails actual invalid held-policy receipt', async () => {
  await actualIndexMutant('detailed focus note dropped', "TASK_NOTE(r.kept.returnFocus) + (focusNote ? `\\n（${focusNote}）` : '')", 'TASK_NOTE(r.kept.returnFocus)', async code => {
    const h = harness({ env: { CHROME_BRIDGE_TIMING_DETAIL: '1' } }, code); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
    await h.call('openTabTool', openArgs); delete h.c.TASK_HOLD.kept.returnFocus;
    const text = await h.c.inputAction('inert detail tab 1', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async () => 'done', { nativeOnly: true, task: 'fixture', compact: false });
    assert.match(text, /焦点归还策略缺失或无效/); assert.match(text, /持续接管/); await h.c.endTaskHold();
  });
});
await r2check('valid restoration-wording mutant fails actual detailed current receipt', async () => {
  await actualIndexMutant('current observation falsely says restored', "noRestore ? '收尾后观察' : '切回后观察'", "'切回后观察'", async code => {
    const h = harness({ env: { CHROME_BRIDGE_TIMING_DETAIL: '1' } }, code);
    const text = await h.c.inputAction('inert detail tab 1', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async () => 'done',
      { nativeOnly: true, returnFocus: focusPolicy('current'), compact: false });
    assert.match(text, /耗时/); assert.doesNotMatch(text, noRestorationText); assert.deepEqual(focusWrites(h.events), []);
  });
});
function terminalLockCapsule(h, lockCode = terminalLockSource) {
  const counts = {acquire:0, claim:0, removed:0, released:0, heartbeat:0, leaseRelease:0};
  const ticket = {name:'inert-ticket', remove:async()=>{counts.removed++;}};
  const context = vm.createContext({Error,Date,lease:null,TURN_TIMEOUT_MS:100,HEARTBEAT_MS:100,HEARTBEAT_CAP_MS:100,
    acquire:async(_label,_timeout,opts)=>{
      counts.acquire++;
      if(counts.acquire===1)return {token:'first',waitedMs:0,ahead:0,handoff:{offer:{scene:{appPid:9,chromePid:42,chromeWindow:10,chromeTab:1},pointer:{x:5,y:6},touched:true},ticket}};
      if(opts.ticket)await opts.ticket.remove();
      return {token:'second',waitedMs:0,ahead:0};
    },
    claim:async()=>{counts.claim++;return false;},offer:async()=>null,
    startHeartbeat:()=>({stop:async()=>{counts.heartbeat++;}}),release:async()=>{counts.released++;},
    cancelledError:()=>Object.assign(Error('cancelled'),{code:'cancelled'})});
  vm.runInContext(['makeTurn','acquireLease','withInputLock'].map(name=>production(name,lockCode)).join('\n'),context);
  h.c.acquireLease=async(...args)=>{const lease=await context.acquireLease(...args);const release=lease.release;lease.release=async(...a)=>{counts.leaseRelease++;return release(...a);};return lease;};
  h.c.withInputLock=(...args)=>context.withInputLock(...args);
  return {counts,context};
}

for(const route of ['task','short'])for(const endVariant of ['healthy','aborted','interrupted','session_interrupted'])await r2check(`terminal retry claim-false ${route}/${endVariant}`,async()=>{
  const h=harness({endVariant}),{counts}=terminalLockCapsule(h);
  if(route==='task')h.c.PLAN={task:'fixture',returnFocus:focusPolicy('origin')};
  const errors=[];h.c.runInputAction=async(...args)=>{try{return await runInputAction(...args);}catch(e){errors.push(e);throw e;}};
  let actions=0,opens=0;h.c.openOwnSession=async()=>{opens++;return h.session;};
  const result=await h.c.inputAction('inherited fixture',async(_pre,_state,ctx)=>h.c.prepareNativeTarget(1,ctx),async()=>{actions++;return 'done';},
    {nativeOnly:true,task:route==='task'?'fixture':'',returnFocus:focusPolicy('origin'),releaseAfter:true,compact:true}).catch(e=>e);
  assert.equal(errors[0]?.code,'handoff_lost','actual guard must create the failed-claim error');
  if(endVariant==='healthy'){
    assert.equal(typeof result,'string');assert.equal(counts.acquire,2);assert.equal(opens,2);assert.equal(actions,1);assert.equal(h.state.closed,2);
    assert.equal(counts.removed,1);assert.equal(counts.released,1);assert.equal(counts.heartbeat,2);return;
  }
  assert.equal(result,errors[0],'terminal error identity must survive the retry consumer');
  assert.equal(result.noRetry,true);assert.equal(result.terminalInterrupted,true);
  assert.equal(counts.acquire,1,'terminal close forbids a second acquisition');assert.equal(opens,1);assert.equal(actions,0);assert.equal(h.state.closed,1);
  assert.equal(counts.removed,1,'unclaimed ticket must be removed once');assert.equal(counts.released,0,'an unclaimed owner lock is not ours to release');assert.equal(counts.heartbeat,1);
  if(route==='task')assert.equal(counts.leaseRelease,1);
  assert.deepEqual(focusWrites(h.events),[]);
});

for(const compact of [true,false])for(const endVariant of ['healthy','aborted','interrupted','session_interrupted'])await r2check(`terminal public origin ${compact?'compact':'detailed'}/${endVariant}`,async()=>{
  const h=harness({nonNative:true,endVariant,env:{CHROME_BRIDGE_TIMING_DETAIL:'1'}});h.c.TAKEOVER=true;
  const text=await h.c.inputAction('inert origin tab 1',async(_pre,_state,ctx)=>h.c.prepareNativeTarget(1,ctx),async()=> 'done',
    {nativeOnly:false,returnFocus:focusPolicy('origin'),compact});
  const close=h.events.indexOf('release');assert.ok(h.events.indexOf('restore')>=0&&h.events.indexOf('restore')<close);assert.ok(h.events.indexOf('warp')>=0&&h.events.indexOf('warp')<close);
  assert.deepEqual(focusWrites(h.events.slice(close+1)),[]);assert.equal(h.state.closed,1);
  if(endVariant!=='healthy'){
    assert.match(text,/中断|用户操作|键盘鼠标输入|你动了/);
    assert.doesNotMatch(text,/还原之前|没有把光标和前台窗口|光标没有拉回/,'public terminal receipt cannot deny completed origin restoration');
    assert.match(text,/还原|恢复|切回/);
  }
});


async function terminalFlagConsumer(route, flag, indexCode = source, lockCode = terminalLockSource) {
  const h=harness({},indexCode),{counts}=terminalLockCapsule(h,lockCode);
  if(route==='task')h.c.PLAN={task:'fixture',returnFocus:focusPolicy('origin')};
  const error=Object.assign(Error('standalone terminal guard'),{code:'handoff_lost',[flag]:true});
  let attempts=0;
  h.c.runInputAction=async()=>{if(++attempts===1)throw error;return {outcome:'ok',out:'unexpected retry',end:{ok:true,takeover:{active:false}}};};
  const result=await h.c.inputAction('inert flag consumer',async()=>({}),async()=>{},
    {nativeOnly:true,task:route==='task'?'fixture':'',returnFocus:focusPolicy('origin'),releaseAfter:true,compact:true}).catch(e=>e);
  assert.equal(result,error,`${route} must retain the ${flag}-only original error`);
  assert.equal(attempts,1);assert.equal(counts.acquire,1);assert.equal(counts.removed,1);assert.equal(counts.heartbeat,1);
  if(route==='task')assert.equal(counts.leaseRelease,1);
  assert.equal(h.state.closed,0,'standalone flag consumer fixture never starts a Session');
}
for(const route of ['task','short'])for(const flag of ['noRetry','terminalInterrupted'])
  await r2check(`terminal retry ${route} independently honors ${flag}`,()=>terminalFlagConsumer(route,flag));


for(const flag of ['noRetry','terminalInterrupted'])await r2check(`valid taskRun ${flag} retry-guard mutant`,async()=>{
  const anchor=`&& e.${flag} !== true `;assert.equal(source.split(anchor).length-1,1);
  await terminalFlagConsumer('task',flag);
  await assert.rejects(terminalFlagConsumer('task',flag,source.replace(anchor,'')),e=>e.code==='ERR_ASSERTION');
});
await r2check('public terminal origin receipt uses uncertainty when restoration was not confirmed',async()=>{
  const h=harness({nonNative:true,endVariant:'interrupted',env:{CHROME_BRIDGE_TIMING_DETAIL:'1'}});h.c.TAKEOVER=true;
  const restore=h.c.B.restoreScene;h.c.B.restoreScene=async(...args)=>{await restore(...args);return {ok:false};};
  const text=await h.c.inputAction('inert origin tab 1',async(_pre,_state,ctx)=>h.c.prepareNativeTarget(1,ctx),async()=> 'done',
    {nativeOnly:false,returnFocus:focusPolicy('origin'),compact:false});
  assert.match(text,/中断/);assert.match(text,/恢复情况未确认/);assert.doesNotMatch(text,/原场景已执行恢复/);
  assert.deepEqual(focusWrites(h.events.slice(h.events.indexOf('release')+1)),[]);
});
await r2check('valid terminal-origin-wording mutant cannot deny a completed pointer warp',async()=>{
  await actualIndexMutant('terminal origin branch removed',': r.terminalInterrupted\n',': false\n',async code=>{
    const h=harness({nonNative:true,endVariant:'aborted'},code);h.c.TAKEOVER=true;
    const text=await h.c.inputAction('inert origin tab 1',async(_pre,_state,ctx)=>h.c.prepareNativeTarget(1,ctx),async()=> 'done',
      {nativeOnly:false,returnFocus:focusPolicy('origin'),compact:true});
    assert.ok(h.events.indexOf('warp')<h.events.indexOf('release'));
    assert.doesNotMatch(text,/还原之前|没有把光标和前台窗口|光标没有拉回/);
  });
});


// Original-error terminal receipts traverse the real guard, inputActionRun,
// callToolInner and SDK. Only operating-system effects and callback input are inert.
const errorDescriptorStart=source.indexOf("  {\n    name: 'press_key'");
const errorDescriptorEnd=source.indexOf('\n  },\n  {',errorDescriptorStart)+'\n  }'.length;
assert.ok(errorDescriptorStart>=0&&errorDescriptorEnd>errorDescriptorStart);
const errorDescriptor=vm.runInNewContext(productionConst('TAB')+'\n'+productionConst('PANEL_ARGS')+'\n('+source.slice(errorDescriptorStart,errorDescriptorEnd)+')');
async function originalErrorReceipt({via='sdk',compact=false,endVariant='aborted',mode='origin',held=false,handoff=false,unconfirmedRestore=false,endFailure=false,originalCode='fixture_action_error',indexCode=source}={}){
  const h=harness({nonNative:true,env:{CHROME_BRIDGE_TIMING_DETAIL:'1'}},indexCode);h.c.TAKEOVER=true;
  if(held||mode==='invalid'){
    h.c.TASK_GAP_MS=30000;h.c.PLAN={task:'fixture',returnFocus:focusPolicy(mode==='invalid'?'origin':mode)};
    await h.call('openTabTool',openArgs);if(mode==='invalid')delete h.c.TASK_HOLD.kept.returnFocus;h.c.PLAN=null;
  }
  assert.equal(h.c.PLAN,null,'the public error must not rely on an interrupted-plan suffix');
  h.state.endVariant=endVariant;h.state.endFailure=endFailure;const before=h.events.length;
  if(unconfirmedRestore){const restore=h.c.B.restoreScene;h.c.B.restoreScene=async(...args)=>{await restore(...args);return {ok:false};};}
  const original=new BridgeError(originalCode,'original action error must survive');let captured=null,tailError=null;
  h.c.runInputAction=async(...args)=>{try{return await runInputAction(...args);}catch(e){captured=e;throw e;}};
  const action=()=>h.c.inputAction('inert original error tab 1',async(_pre,_state,ctx)=>h.c.prepareNativeTarget(1,ctx),async(_session,prep,ctx)=>{
    if(handoff)await ctx.handToHuman(prep.target);throw original;
  },{nativeOnly:false,returnFocus:mode==='invalid'?null:focusPolicy(mode),task:held||mode==='invalid'?'fixture':'',compact,releaseAfter:held||mode==='invalid'||handoff});
  let text,reply;
  if(via==='direct'){const error=await action().catch(e=>e);assert.equal(error,original);text=error.message;}
  else{
    Object.assign(h.c,{pauseGate:async()=>{},noteOutcome(){},RoutineError,routineMessage,setupHint,pressKeyTool:action});
    vm.runInContext(production('goneTabNote',indexCode)+'\n'+production('callToolInner',indexCode),h.c);
    const call=()=>h.c.callToolInner('press_key',{key:'enter'},{},async facts=>{tailError=facts?.error;return '';});
    if(via==='public')reply=await call();
    else{
      const server=new Server({name:'original-error',version:'1'},{capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[errorDescriptor]}));
      server.setRequestHandler(CallToolRequestSchema,request=>h.c.callToolInner(request.params.name,request.params.arguments,{},async facts=>{tailError=facts?.error;return '';}));
      const client=new Client({name:'original-error-client',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
      await server.connect(st);await client.connect(ct);await client.listTools();
      try{reply=await client.callTool({name:'press_key',arguments:{key:'enter'}});}finally{await client.close();await server.close();}
    }
    assert.equal(reply.isError,true);assert.equal(tailError,original);text=reply.content[0].text;assert.equal(h.store.code,originalCode);
  }
  assert.equal(captured,original);assert.equal(original.code,originalCode);assert.match(text,/original action error must survive/);
  assert.equal(h.c.PLAN,null);assert.equal(h.c.TASK_HOLD,null);assert.equal(h.state.closed,1);
  const tail=h.events.slice(before),close=tail.indexOf('release');assert.ok(close>=0);assert.equal(tail.filter(x=>x==='lease-release').length,1);
  assert.deepEqual(focusWrites(tail.slice(close+1)),[],'terminal error must never trigger a post-close focus write');
  if(mode==='origin'&&!handoff){for(const event of ['restore','warp'])assert.ok(tail.indexOf(event)>=0&&tail.indexOf(event)<close,`${event} occurs before close`);}
  else assert.deepEqual(focusWrites(tail),[]);
  if(endVariant==='healthy'){
    assert.equal(original.terminalInterrupted,false);assert.doesNotMatch(text,/接管已中断|操作中断了输入接管/);
    if(mode==='origin'&&!handoff)assert.equal(text,'original action error must survive');return {h,text,original};
  }
  assert.equal(original.terminalInterrupted,true);assert.equal(original.noRetry,true);assert.equal(original.inputReleased,!endFailure);
  assert.match(text,/接管已中断|操作中断了输入接管/,'public original-error text must retain terminal interruption');
  if(mode==='origin'&&!handoff){
    assert.equal(original.sceneRestored,!unconfirmedRestore);
    assert.match(text,unconfirmedRestore?/恢复情况未确认/:/原场景已执行恢复|前台 App 已切回/);
    assert.match(text,/光标.*未确认/);assert.doesNotMatch(text,/还原之前|没有把光标和前台窗口|光标没有拉回/);
  }else{
    assert.match(text,/未请求焦点恢复/);assert.doesNotMatch(text,noRestorationText);
    if(mode==='invalid')assert.match(text,/归还策略缺失或无效/);
    if(handoff)assert.equal(original.releaseReason,'human_handoff');
  }
  if(endFailure)assert.doesNotMatch(text,/接管已结束|保留当前页面/);
  return {h,text,original};
}
for(const via of ['direct','public','sdk'])for(const compact of [true,false])for(const endVariant of ['healthy','aborted','interrupted','session_interrupted'])
  await r2check(`original-error ${via}/${compact?'compact':'detailed'}/${endVariant}`,()=>originalErrorReceipt({via,compact,endVariant}));
for(const mode of ['current','invalid','handoff'])for(const endVariant of ['healthy','aborted','interrupted','session_interrupted'])
  await r2check(`original-error SDK retained ${mode}/${endVariant}`,()=>originalErrorReceipt({mode:mode==='handoff'?'origin':mode,held:true,handoff:mode==='handoff',endVariant}));
await r2check('original-error SDK unconfirmed restoration stays neutral despite pre-close requests',()=>originalErrorReceipt({endVariant:'interrupted',unconfirmedRestore:true}));
await r2check('original-error SDK invalid policy with missing end preserves unconfirmed release and terminal interruption',()=>originalErrorReceipt({mode:'invalid',held:true,endVariant:'session_interrupted',endFailure:true}));


for(const via of ['direct','sdk'])await r2check(`original-error ${via} terminal lock_timeout code preserves the same callback error`,
  ()=>originalErrorReceipt({via,originalCode:'lock_timeout',endVariant:'aborted'}));
await r2check('healthy queue lock_timeout retains its existing public BridgeError normalization',async()=>{
  const h=harness({nonNative:true});h.c.TAKEOVER=true;const original=Object.assign(Error('healthy queue timeout'),{code:'lock_timeout'});
  h.c.withInputLock=async()=>{throw original;};
  const result=await h.c.inputAction('inert queued callback',async()=>({}),async()=>{throw Error('queue failure must not execute input');},
    {nativeOnly:false,returnFocus:focusPolicy('origin')}).catch(e=>e);
  assert.notEqual(result,original);assert.ok(result instanceof BridgeError);assert.equal(result.code,'lock_timeout');assert.equal(result.message,original.message);
  assert.equal(result.terminalInterrupted,undefined);assert.equal(h.state.closed,0);assert.deepEqual(h.events,['dialog-read']);
});
await r2check('valid original-error terminal-note omission mutant fails final SDK error text',async()=>{
  await actualIndexMutant('terminal error note omitted','if (e.terminalInterrupted === true) e.message +=','if (false) e.message +=',
    indexCode=>originalErrorReceipt({via:'sdk',endVariant:'interrupted',indexCode}));
});


await r2check('valid terminal lock_timeout normalization mutant cannot replace the original SDK error',async()=>{
  await actualIndexMutant('terminal timeout loses original identity',"e.code === 'lock_timeout' && e.terminalInterrupted !== true","e.code === 'lock_timeout'",
    indexCode=>originalErrorReceipt({via:'sdk',originalCode:'lock_timeout',endVariant:'aborted',indexCode}));
});

// Compose production guard -> inputActionRun -> persist with sticky per-reply
// Session evidence. No PLAN, native helper, shared lock or OS effect exists here.
async function monitoredRetry({ variant = 'repeat', mode = 'current', flags = null,
  generic = false, travel = null, receipt = null, localSent = [], requireNoRetry = true,
  partial = false, indexCode = source, guardRun = runInputAction } = {}) {
  const h = harness({ nonNative: true, env: { CHROME_BRIDGE_TIMING_DETAIL: '1' } }, indexCode);
  Object.assign(h.c, { RETRY: { maxMs: 10000, few: 3, pauseMs: 0 }, USER_IDLE_MAX_WAIT_MS: 1000,
    userIdleS: () => 0, sleep: async () => h.events.push('retry-wait') });
  vm.runInContext(production('postedNothing', indexCode) + '\n' + production('post', indexCode), h.c);
  const caller = new AbortController(); h.state.signal = caller.signal;
  const attempts = [], errors = [], receipts = [];
  let actionCount = 0, delivered = 0, prepareCount = 0, attemptNo = 0, originalError = null;
  const known = { kind: 'move', t: 12.5, epoch: 1000, button: false };
  const event = variant === 'missing-time' ? { kind: 'move', epoch: 1000, button: false }
    : variant === 'invalid-time' ? { ...known, t: NaN } : known;
  const rawAbort = variant === 'prior-caller-status' ? 'caller' : variant === 'prior-esc-status-signal' ? 'esc' : null;
  const throwOriginal = session => {
    originalError = generic ? new BridgeError('user_busy', 'original guarded failure')
      : new UserInterrupted(Object.hasOwn(flags, 'interrupted') ? flags.interrupted : { ...known }, flags.reply || null);
    Object.assign(originalError, flags);
    if (!generic && variant !== 'no-echo') session.interrupted = { ...known };
    throw originalError;
  };
  h.c.B.restoreScene = async () => { h.events.push('restore'); return { ok: true, appFrontmost: true }; };
  h.c.B.restoreApp = async () => { h.events.push('restore-app'); return { ok: true, appFrontmost: true }; };
  h.c.B.cgevent = async args => { if (args[0] === 'warp') h.events.push('warp'); return { x: 5, y: 6 }; };
  h.c.openOwnSession = async () => {
    const number = ++attemptNo; assert.ok(number <= 3, 'fixture allows only the expected bounded attempts');
    const failed = number <= 2;
    const record = { number, closed: 0, requests: [], end: null, sessionBefore: null };
    attempts.push(record); h.events.push('open');
    let reportedInterruption = null;
    const session = { get interrupted() { return reportedInterruption; },
      set interrupted(value) { reportedInterruption = value; }, request: async req => {
      record.requests.push(req.op); h.events.push(req.op);
      assert.notEqual(req.op, 'hold', 'monitored retry cannot acquire a native hold');
      if (req.op === 'begin') return { ok: true, epoch: 1, inputMonitor: true, takeover: { active: false } };
      if (req.op === 'status') {
        const interrupted = failed && !flags && travel === null ? { ...event } : null;
        if (interrupted) {
          session.interrupted = { ...interrupted };
          record.status = interrupted; record.sessionBefore = session.interrupted;
        }
        if (failed && rawAbort) caller.abort();
        record.statusReply = { ok: true, epoch: 1, interrupted, takeover: { active: false,
          ...(failed && variant === 'prior-status-cancel' ? { aborted: true, abortedBy: 'esc' } : {}),
          ...(failed && rawAbort ? { aborted: true, abortedBy: rawAbort, releasedBy: rawAbort } : {}) } };
        return record.statusReply;
      }
      if (req.op === 'click') {
        if (failed) {
          session.interrupted = { ...known };
          originalError = new UserInterrupted({ ...known }, { ok: false, error: 'interrupted', interrupted: { ...known },
            ...(travel === 'missing' ? {} : { postedInput: travel }) });
          throw originalError;
        }
        delivered++; return { ok: true, postedInput: 1 };
      }
      if (req.op === 'recordNativeScene') return { ok: true, epoch: 1, restoreToken: 'r'.repeat(64) };
      if (req.op === 'bindNativeTarget') return { ok: true, epoch: 1, target: req.target };
      if (req.op === 'nativeChrome') return { ok: true, epoch: 1, operationId: req.operationId, inputDelivery: 'sent', stages: [] };
      return { ok: true, epoch: 1 };
    }, close: async () => {
      record.closed++; h.events.push('release'); h.state.closed++;
      const stickyBefore = session.interrupted;
      if (failed && ['caller-cancel', 'prior-status-cancel', 'signal-esc'].includes(variant)) caller.abort();
      let endEvent = failed && !generic && variant !== 'no-echo' ? { ...event } : null;
      if (failed && variant === 'new-end') endEvent = { ...known, t: 13, epoch: 1001 };
      if (failed && variant === 'new-kind') endEvent = { ...known, kind: 'key' };
      if (failed && variant === 'new-session') session.interrupted = { ...known, t: 13, epoch: 1001 };
      else if (failed && variant === 'session-undefined') session.interrupted = undefined;
      else if (failed && variant === 'session-null') session.interrupted = null;
      else if (failed && variant === 'button') endEvent.button = true;
      else if (failed && variant === 'mutable-session') {
        assert.equal(session.interrupted, record.sessionBefore); session.interrupted.button = true;
      } else if (failed && variant === 'mutable-identity') {
        assert.equal(session.interrupted, record.sessionBefore); session.interrupted.epoch = 1001;
      } else if (!(failed && ['end-omitted-sticky', 'end-null-sticky'].includes(variant))) session.interrupted = endEvent && { ...endEvent };
      record.end = { ok: true, restored: true, interrupted: endEvent,
        takeover: { active: false, ...(failed && ['abort', 'caller-cancel', 'prior-status-cancel', 'signal-esc'].includes(variant)
          ? { aborted: true, abortedBy: ['caller-cancel', 'prior-status-cancel'].includes(variant) ? 'caller' : 'esc' } : {}),
          ...(failed && rawAbort ? { aborted: true, abortedBy: 'caller' } : {}) } };
      if (failed && variant === 'end-omitted-sticky') { delete record.end.interrupted; assert.equal(Object.hasOwn(record.end, 'interrupted'), false); }
      if (failed && variant === 'end-null-sticky') { record.end.interrupted = null; assert.equal(Object.hasOwn(record.end, 'interrupted'), true); assert.equal(record.end.interrupted, null); }
      if (failed && ['end-omitted-sticky', 'end-null-sticky'].includes(variant)) {
        assert.equal(session.interrupted, stickyBefore, 'missing END evidence leaves the accessor sticky');
        assert.deepEqual(session.interrupted, known);
      }
      if (failed && ['session-undefined', 'session-null'].includes(variant)) {
        assert.deepEqual(record.end.interrupted, known, 'inverse omission retains a complete END record');
        assert.equal(session.interrupted, variant === 'session-null' ? null : undefined);
      }
      record.sessionAfter = session.interrupted;
      if (failed && variant === 'unconfirmed') throw Error('missing confirmed end');
      return record.end;
    } };
    return session;
  };
  h.c.runInputAction = async (ops, action) => {
    try { const r = await guardRun({ ...ops, quietMs: 0 }, action); receipts.push(r); return r; }
    catch (error) { errors.push(error); throw error; }
  };
  const result = await h.c.persist(idle => h.c.inputAction('monitored retry tab 1', async (_pre, state) => {
    prepareCount++;
    if (flags && attemptNo <= 2 && !localSent.length) throwOriginal(state.session);
    return { ...target(), target: target(), touchesScene: true };
  }, async (session, _prep, ctx) => {
    actionCount++; h.events.push('action');
    if (flags && attemptNo <= 2 && localSent.length) {
      for (const kind of localSent) { ctx.sent(kind); delivered++; }
      throwOriginal(session);
    }
    if (travel !== null) await h.c.post(session, ctx, 'click', { op: 'click' });
    else { ctx.sent('click'); delivered++; }
    return 'done';
  },
  { preflight: async () => ({ session: target() }), idle, returnFocus: focusPolicy(mode), compact: true }), h.state.signal).catch(e => e);
  if (receipt === 'not_sent') assert.match(result.message, /还没有发出任何输入/, 'known not-sent receipt remains explicit');
  else if (receipt) assert.doesNotMatch(result.message, /还没有发出任何输入/, `${receipt} evidence must not claim no input before ledger assertions; actual public message: ${result.message}`);
  const retryable = variant === 'repeat' && !flags && (travel === null || travel === 0);
  if (retryable) {
    assert.equal(typeof result, 'string', 'a known pre-input echo must reach the healthy third attempt');
    assert.match(result, /2 次；此前未发送输入/); assert.match(result, /done/);
    assert.equal(attemptNo, 3); assert.equal(delivered, 1);
    assert.equal(actionCount, travel === null ? 1 : 3); assert.equal(prepareCount, travel === null ? 1 : 3);
    assert.equal(h.events.filter(x => x === 'retry-wait').length, 2);
    for (const r of receipts.slice(0, 2)) { assert.equal(r.outcome, 'user'); assert.equal(r.noRetry, undefined); assert.equal(r.terminalInterrupted, false); assert.deepEqual([...r.sent], []); }
  } else {
    assert.equal(attemptNo, 1, 'refusal must not replay even when no noRetry flag was supplied');
    assert.equal(result?.code, generic ? 'user_busy' : (variant === 'caller-cancel' || variant === 'prior-caller-status') && !flags && (travel === null || travel === 0) ? 'cancelled' : 'user_interrupted');
    if (requireNoRetry) assert.equal(result.noRetry, true, 'new/ambiguous evidence or an existing safety flag must forbid retry');
    assert.equal(actionCount, localSent.length ? 1 : travel === null ? 0 : 1); assert.equal(delivered, localSent.length);
    assert.equal(h.events.includes('retry-wait'), false);
    if (flags) for (const [key, value] of Object.entries(flags)) {
      if (key === 'sent' && localSent.length) assert.deepEqual([...result.sent].sort(), [...new Set([...value, ...localSent])].sort(), 'preserve the union of affirmative original and local sent ledgers');
      else if (key === 'sent') assert.deepEqual([...result.sent], [...value], 'preserve affirmative original sent ledger');
      else assert.equal(result[key], value, `preserve original ${key}`);
    }
    if (flags) assert.equal(result, originalError, 'original flagged error identity survives public conversion');
    if (!flags) assert.equal(result.terminalInterrupted, true);
    if (travel !== null && travel !== 0) { assert.equal(result, originalError); assert.deepEqual([...result.sent], ['click']); }
    if (variant === 'prior-status-cancel') {
      assert.equal(result.reply, attempts[0].statusReply); assert.equal(result.reply.takeover.abortedBy, 'esc');
    }
    if (rawAbort) {
      assert.equal(result, errors[0] || receipts[0]?.error, 'same actual guard error survives public cancellation handling');
      assert.equal(result.reply, attempts[0].statusReply); assert.equal(result.reply.takeover.abortedBy, rawAbort);
      assert.equal(attempts[0].end.takeover.abortedBy, 'caller'); assert.equal(result.terminalAbortedBy, 'caller');
      assert.equal(caller.signal.aborted, true); assert.equal(prepareCount, 0); assert.deepEqual([...result.sent], []);
    }
    if (partial) {
      assert.match(result.message, /已经发出了部分输入/); assert.match(result.message, /先 read_page/);
      assert.doesNotMatch(result.message, /还没有发出任何输入|此前未发送输入|仍未发送输入/);
    }
  }
  assert.equal(h.c.PLAN, null); assert.equal(h.c.TASK_HOLD, null);
  if (!localSent.length) assert.equal(h.events.includes('taken-over'), travel !== null && travel !== 0, 'only retained sent evidence changes ownership');
  assert.equal(h.events.filter(x => x === 'lease').length, attemptNo);
  assert.equal(h.events.filter(x => x === 'lease-release').length, attemptNo);
  for (const a of attempts) { assert.equal(a.closed, 1); assert.equal(a.requests.filter(x => x === 'begin').length, 1); }
  const firstClose = h.events.indexOf('release');
  if (!retryable) assert.deepEqual(focusWrites(h.events.slice(firstClose + 1)), []);
  for (let i = 0; i < attempts.length - (retryable ? 1 : 0); i++) assert.equal(attempts[i].requests.includes('nativeChrome'), false);
  return { h, result, receipts, errors, attempts };
}
for (const mode of ['origin', 'current'])
  await r2check(`actual monitored persist repeated identity ${mode}`, () => monitoredRetry({ mode }));
for (const variant of ['new-end', 'new-kind', 'new-session', 'button', 'mutable-session', 'mutable-identity', 'abort', 'missing-time', 'invalid-time', 'unconfirmed'])
  await r2check(`actual monitored persist rejects ${variant}`, () => monitoredRetry({ variant }));
for (const flags of [{ noRetry: true }, { terminalInterrupted: true }, { noRetry: true, inputDelivery: 'unknown' }])
  await r2check(`actual monitored persist preserves UserInterrupted ${JSON.stringify(flags)}`, () => monitoredRetry({ flags }));
for (const flags of [{ noRetry: true }, { terminalInterrupted: true }])
  await r2check(`actual monitored persist preserves thrown original ${JSON.stringify(flags)}`, () => monitoredRetry({ flags, generic: true }));
for (const flags of [{ noRetry: true }, { terminalInterrupted: true }, { noRetry: true, inputDelivery: 'unknown' }])
  await r2check(`actual monitored persist preserves no-echo UserInterrupted ${JSON.stringify(flags)}`, () => monitoredRetry({ flags, variant: 'no-echo' }));

await r2check('actual monitored persist refuses missing post-close identity', () => monitoredRetry({ variant: 'no-echo' }));
await r2check('actual monitored persist retains original interruption by metadata',
  () => monitoredRetry({ flags: { noRetry: true, by: 'original-cause' } }));
await r2check('actual monitored persist caller cancellation at close retains cancelled semantics',
  () => monitoredRetry({ variant: 'caller-cancel' }));
for (const [generic, flags] of [[true, { noRetry: true }], [false, { noRetry: true, inputDelivery: 'unknown' }]])
  await r2check(`caller cancellation does not replace ${generic ? 'hard original error' : 'unknown delivery'}`,
    () => monitoredRetry({ variant: 'caller-cancel', generic, flags }));

await r2check('actual prior Esc reply dominates later caller cancellation at close', () => monitoredRetry({
  variant: 'caller-cancel', flags: { by: 'esc', reply: { interrupted: { kind: 'move', t: 12.5, epoch: 1000, button: false },
    takeover: { aborted: true, abortedBy: 'esc' } } },
}));

for (const interrupted of [null, undefined]) await r2check(`actual malformed interrupted reply ${interrupted === null ? 'null' : 'missing'} identity refuses replay`,
  () => monitoredRetry({ variant: 'no-echo', flags: { interrupted, reply: { ok: false, error: 'interrupted' } } }));
await r2check('actual prior quiet-window Esc status dominates later caller cancellation',
  () => monitoredRetry({ variant: 'prior-status-cancel' }));
await r2check('caller signal does not relabel an Esc end as caller cancellation',
  () => monitoredRetry({ variant: 'signal-esc' }));
for (const mode of ['origin', 'current']) await r2check(`actual post zero-input travel retains fresh retry ${mode}`,
  () => monitoredRetry({ travel: 0, mode }));
for (const travel of [1, 'missing']) for (const variant of ['repeat', 'caller-cancel'])
  await r2check(`actual post ${travel} proof refuses replay and cancellation relabel ${variant}`,
    () => monitoredRetry({ travel, variant }));
await r2check('actual post zero-input travel permits caller cancellation without replay',
  () => monitoredRetry({ travel: 0, variant: 'caller-cancel' }));

await r2check('actual prior sent ledger survives an otherwise empty local ledger',
  () => monitoredRetry({ flags: { noRetry: true, sent: ['keys'] } }));

for (const variant of ['end-omitted-sticky', 'end-null-sticky', 'session-undefined', 'session-null'])
  await r2check(`R2 actual composed retry rejects independent post-close omission ${variant}`,
    () => monitoredRetry({ variant, flags: { by: 'original-cause' } }));
for (const [name, options] of [
  ['unknown-top-prior-sent', { flags: { by: 'original-cause', noRetry: true, inputDelivery: 'unknown', sent: ['keys'] }, partial: true }],
  ['unknown-reply-prior-sent', { flags: { by: 'original-cause', noRetry: true, sent: ['keys'], reply: { ok: false, error: 'interrupted', inputDelivery: 'unknown',
    interrupted: { kind: 'move', t: 12.5, epoch: 1000, button: false } } }, partial: true }],
  ['generic-noRetry-prior-sent', { generic: true, flags: { by: 'original-cause', noRetry: true, sent: ['keys'] } }],
  ['generic-sent-only', { generic: true, flags: { by: 'original-cause', sent: ['keys'] }, requireNoRetry: false }],
  ['returned-prior-local-union', { flags: { by: 'original-cause', noRetry: true, sent: ['keys'] }, localSent: ['click'], partial: true }],
  ['unknown-prior-local-union', { flags: { by: 'original-cause', noRetry: true, inputDelivery: 'unknown', sent: ['keys'] }, localSent: ['click'], partial: true }],
  ['generic-prior-local-union', { generic: true, flags: { by: 'original-cause', noRetry: true, sent: ['keys'] }, localSent: ['click'] }],
]) await r2check(`R2 actual composed sent evidence ${name}`, () => monitoredRetry(options));
await r2check('R2 actual pre-close caller status plus cancelled signal retains cancelled semantics',
  () => monitoredRetry({ variant: 'prior-caller-status' }));
await r2check('R2 actual pre-close Esc status survives an already-cancelled signal and caller END',
  () => monitoredRetry({ variant: 'prior-esc-status-signal' }));

for (const [receipt, flags] of [
  ['sent', { noRetry: true, sent: ['keys'] }],
  ['unknown', { noRetry: true, inputDelivery: 'unknown' }],
  ['not_sent', { noRetry: true, inputDelivery: 'not_sent' }],
]) await r2check(`actual unconfirmed-close ${receipt} public receipt is truthful before ledger checks`,
  () => monitoredRetry({ variant: 'unconfirmed', flags, receipt }));

// Actual persist receipt controls keep refusal/error identity separate from delivery.
const retryReceiptVariants = [
  ['noRetry-empty', { noRetry: true, sent: [] }, false],
  ['terminal-empty', { noRetry: true, terminalInterrupted: true, sent: [] }, false],
  ['known-sent-ledger', { noRetry: true, sent: ['keys'] }, true],
  ['known-sent-delivery', { noRetry: true, sent: [], inputDelivery: 'sent' }, true],
  ['unknown-neutral', { noRetry: true, sent: [], inputDelivery: 'unknown' }, false],
  ['revoked-neutral', { noRetry: true, sent: [], inputDelivery: 'not_sent', nativeRevoked: true }, false],
];
async function persistReceipt(name, flags, partial, indexCode = source) {
  const error = Object.assign(new BridgeError('user_interrupted', 'known interruption'), flags);
  let attempts = 0, sleeps = 0;
  const c = vm.createContext({ BridgeError, Date, Math, Number, Set, process: { env: {} },
    RETRY: { maxMs: 1000, few: 3, pauseMs: 0 }, USER_IDLE_MAX_WAIT_MS: 1000,
    CALL: { getStore: () => ({}) }, userIdleS: () => 0, sleep: async () => { sleeps++; },
    cancelledError: () => Object.assign(Error('cancelled'), { code: 'cancelled' }) });
  vm.runInContext(['RETRY_WAIT', 'RETRY_FEW', 'SECURE_WAIT_MS', 'idleForAttempt', 'AGENT_PARTIAL']
    .map(name => productionConst(name, indexCode)).join('\n') + '\n' + production('persist', indexCode), c);
  const result = await c.persist(async () => { attempts++; throw error; }).catch(e => e);
  assert.equal(result, error, 'original object'); assert.equal(result.code, 'user_interrupted');
  assert.equal(attempts, 1); assert.equal(sleeps, 0);
  for (const [key, value] of Object.entries(flags)) assert.equal(result[key], value, `${name} preserves ${key}`);
  assert.equal(/已经发出了部分输入/.test(result.message), partial, `${name}: definite partial receipt needs affirmative sent evidence`);
  if (partial) assert.match(result.message, /先 read_page/);
  else assert.doesNotMatch(result.message, /此前未发送输入|仍未发送输入/);
}
for (const [name, flags, partial] of retryReceiptVariants)
  await r2check(`actual persist receipt ${name}`, () => persistReceipt(name, flags, partial));

// Existing flags must also survive a refusal before the first Session exists.
async function beforeSessionFlag(flag, guardRun = runInputAction) {
  const h = harness({ nonNative: true }); let attempts = 0, opens = 0;
  const original = Object.assign(new UserInterrupted(null), { [flag]: true });
  Object.assign(h.c, { RETRY: { maxMs: 1000, few: 3, pauseMs: 0 }, USER_IDLE_MAX_WAIT_MS: 1000,
    userIdleS: () => 0, sleep: async () => {}, runInputAction: guardRun,
    openOwnSession: async () => { opens++; throw Error('refusal must precede Session creation'); } });
  const result = await h.c.persist(idle => h.c.inputAction('pre-session refusal', async () => { throw Error('unexpected prepare'); },
    async () => { throw Error('unexpected action'); }, { idle, returnFocus: focusPolicy('current'),
      preflight: async () => { assert.equal(++attempts, 1, 'original flag must prevent reacquisition'); throw original; } })).catch(e => e);
  assert.equal(result, original); assert.equal(result.code, 'user_interrupted'); assert.equal(result[flag], true); assert.equal(result.noRetry, true);
  assert.equal(attempts, 1); assert.equal(opens, 0); assert.equal(h.state.closed, 0);
  assert.equal(h.events.filter(x => x === 'lease').length, 1); assert.equal(h.events.filter(x => x === 'lease-release').length, 1);
}
for (const flag of ['noRetry', 'terminalInterrupted'])
  await r2check(`actual before-Session ${flag} prevents reacquisition`, () => beforeSessionFlag(flag));

const retryGuardSource = await fs.readFile(new URL('../src/guard.js', import.meta.url), 'utf8');
async function retryGuardMutant(name, from, to, oracle) {
  assert.equal(retryGuardSource.split(from).length - 1, 1, `${name}: unique valid guard mutation`);
  await oracle(runInputAction);
  const edited = retryGuardSource.replace(from, to).replace("from './bridge.js'", `from ${JSON.stringify(new URL('../src/bridge.js', import.meta.url).href)}`);
  const mod = await import('data:text/javascript;base64,' + Buffer.from(edited).toString('base64'));
  await assert.rejects(oracle(mod.runInputAction), e => e.code === 'ERR_ASSERTION', `${name}: only a semantic assertion counts`);
}
await r2check('valid prior result flag propagation mutant fails before-Session refusal', () =>
  retryGuardMutant('prior result flags lost', '...facts(result.error)', '...facts()', run => beforeSessionFlag('noRetry', run)));
await r2check('valid prior thrown flag propagation mutant fails composed persist', () =>
  retryGuardMutant('prior thrown terminal flag lost', 'const terminal = facts(error);', 'const terminal = facts();',
    run => monitoredRetry({ generic: true, flags: { terminalInterrupted: true }, guardRun: run })));
await r2check('valid raw prior abort omission mutant cannot relabel Esc as caller cancellation', () =>
  retryGuardMutant('raw prior abort ignored', "priorCloseAborts.every(abort => abort.abortedBy === 'caller') &&", '',
    run => monitoredRetry({ variant: 'caller-cancel', guardRun: run, flags: { by: 'esc',
      reply: { interrupted: { kind: 'move', t: 12.5, epoch: 1000, button: false }, takeover: { aborted: true, abortedBy: 'esc' } } } })));
await r2check('valid broad caller conversion mutant cannot replace unknown delivery', () =>
  retryGuardMutant('caller conversion ignores clean boundary',
    'if (cleanBeforeInput && err instanceof UserInterrupted && ops.signal?.aborted &&',
    'if (err instanceof UserInterrupted && ops.signal?.aborted &&',
    run => monitoredRetry({ variant: 'caller-cancel', flags: { noRetry: true, inputDelivery: 'unknown' }, guardRun: run })));
await r2check('valid original interruption replacement mutant loses error identity', () =>
  actualIndexMutant('original interruption replaced',
    'const original = r.error && (r.noRetry === true || r.terminalInterrupted === true) ? r.error : null;',
    'const original = null;', code => monitoredRetry({ flags: { noRetry: true }, indexCode: code })));
await r2check('valid noRetry-implies-partial mutant fails actual persist receipt', () =>
  actualIndexMutant('noRetry falsely proves sent',
    "(e.sent?.length || e.inputDelivery === 'sent' || e.reply?.inputDelivery === 'sent')", 'true',
    code => persistReceipt('noRetry-empty mutant', { noRetry: true, sent: [] }, false, code)));
await r2check('valid R2 original sentKinds contribution omission mutant cannot replay a sent-only hard error', () =>
  retryGuardMutant('original sentKinds contribution omitted', '...(Array.isArray(error?.sent) ? error.sent : []), ', '',
    run => monitoredRetry({ generic: true, flags: { by: 'original-cause', sent: ['keys'] }, requireNoRetry: false, guardRun: run })));

// Actual guard -> pointerTo -> persist: motion belongs to the counted action
// ledger even when the following wheel/click has not been sent yet. Native
// progress.points is conservative attempted-motion evidence, not a post count.
async function motionRetry(mode, indexCode = source) {
  const h = harness({ nonNative: true }, indexCode);
  Object.assign(h.c, { RETRY: { maxMs: 1000, few: 3, pauseMs: 0 }, USER_IDLE_MAX_WAIT_MS: 1000,
    userIdleS: () => 0, sleep: async () => h.events.push('motion-retry-wait'),
    squareToScreenRect: point => ({ x: point.x, y: point.y, w: 20, h: 20 }),
    runInputAction: (ops, action) => runInputAction({ ...ops, quietMs: 0 }, action) });
  vm.runInContext(['postedNothing', 'pointerTo'].map(name => production(name, indexCode)).join('\n'), h.c);
  const original = Object.assign(new BridgeError('guard_cursor_moved', 'motion boundary refusal'), {
    ...(mode === 'unknown' ? {} : { reply: { postedInput: 0,
      ...(['partial', 'complete-error'].includes(mode) ? { points: mode === 'partial' ? 1 : 3 } : {}) } }) });
  let attempts = 0, moves = 0, attemptMoves = 0;
  const baseRequest = h.session.request;
  h.session.request = async req => {
    if (req.op !== 'move') return baseRequest(req);
    moves++; attemptMoves++;
    if (attempts === 1 && (['partial', 'complete-error', 'unknown', 'zero'].includes(mode) ||
        mode === 'completed-then-zero' && attemptMoves === 2)) throw original;
    return { ok: true, points: mode === 'skipped' ? 0 : 3, skippedMove: mode === 'skipped' };
  };
  const result = await h.c.persist(idle => {
    assert.ok(++attempts <= 2, 'motion fixture permits at most one retry'); attemptMoves = 0;
    return h.c.inputAction('motion ledger', async () => ({ ...target(), target: target(), touchesScene: true }),
      async (session, _prep, ctx) => {
        await h.c.pointerTo(session, { x: 40, y: 50 }, {}, ctx);
        if (mode === 'completed-then-zero') await h.c.pointerTo(session, { x: 45, y: 55 }, {}, ctx);
        if (attempts === 1 && ['completed-then-failure', 'skipped'].includes(mode)) throw original;
        return 'motion done';
      }, { preflight: async () => ({ session: target() }), idle,
        returnFocus: { mode: 'current' }, compact: true });
  }).catch(error => error);
  const retryable = ['zero', 'skipped'].includes(mode), healthy = mode === 'healthy';
  assert.equal(attempts, retryable ? 2 : 1, `${mode}: action acquisition count`);
  assert.equal(h.events.filter(event => event === 'motion-retry-wait').length, retryable ? 1 : 0, `${mode}: retry count`);
  assert.equal(h.state.closed, attempts, `${mode}: each session closes once`);
  if (healthy || retryable) assert.match(result, /motion done/);
  else {
    assert.equal(result, original, `${mode}: original error object`);
    assert.deepEqual([...result.sent], ['move'], `${mode}: attempted motion remains in the ledger`);
    assert.equal(moves, mode === 'completed-then-zero' ? 2 : 1, `${mode}: no motion replay`);
    if (['partial', 'complete-error', 'unknown'].includes(mode)) assert.equal(result.noRetry, true);
  }
}
for (const mode of ['partial', 'complete-error', 'unknown', 'completed-then-failure', 'completed-then-zero', 'zero', 'skipped', 'healthy'])
  await r2check(`actual guard motion ledger ${mode}`, () => motionRetry(mode));
await r2check('valid move-ledger omission mutant cannot replay a completed move', async () => {
  const from = "  ctx?.sent?.('move');";
  assert.equal(source.split(from).length - 1, 1);
  await assert.rejects(motionRetry('completed-then-failure', source.replace(from, '  // mutation: omitted motion ledger')),
    error => error.code === 'ERR_ASSERTION');
});
await r2check('valid move-progress omission mutant cannot replay partial motion', async () => {
  const from = "(op !== 'move' || r.points === undefined || r.points === 0)";
  assert.equal(source.split(from).length - 1, 1);
  await assert.rejects(motionRetry('partial', source.replace(from, 'true')),
    error => error.code === 'ERR_ASSERTION');
});

// C4: an explicit plan through the production callToolInner → maintainTaskAfterError,
// inputAction → taskRun → guard and closeTabTool. Only native effects are inert.
function planHarness(options = {}, code = source) {
  const h = harness({ nonNative: true, ...options }, code); h.c.TAKEOVER = true;
  h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
  const runs = { action: 0 }, script = [];
  const act = () => h.c.inputAction('fixture plan tab 1', async (_pre, _state, ctx) => h.c.prepareNativeTarget(1, ctx), async () => {
    runs.action++;
    const next = script.shift();
    if (next) throw next;
    return 'fixture done';
  }, { nativeOnly: false, returnFocus: focusPolicy('origin'), task: 'fixture', compact: true });
  Object.assign(h.c, { pauseGate: async () => {}, touchTab: async () => {}, noteOutcome() {}, RoutineError, routineMessage, setupHint, pressKeyTool: act });
  // The no-input predicate is loaded when production has it; without it the old decision runs unchanged.
  const predicate = code.includes('\nfunction failedWithoutInput(') ? [productionConst('READ_ONLY_TOOLS', code), production('failedWithoutInput', code)] : [];
  vm.runInContext([...['holdActive', 'givenBackBy'].map(name => productionConst(name, code)), ...predicate,
    ...['maintainTaskAfterError', 'goneTabNote', 'callToolInner'].map(name => production(name, code))].join('\n'), h.c);
  const tool = (name, args = {}) => h.c.callToolInner(name, args, {}, async () => '');
  return { h, runs, script, tool, holds: () => h.events.filter(x => x === 'hold').length };
}
const planNotSent = () => Object.assign(new BridgeError('target_unavailable', 'fixture marker missing; nothing sent'), { inputDelivery: 'not_sent' });

await r2check('C4 real path: a not_sent first action keeps the plan and the next action takes its first hold', async () => {
  const p = planHarness();
  p.script.push(planNotSent());
  const failed = await p.tool('press_key', { key: 'enter' });
  assert.equal(failed.isError, true); assert.equal(p.h.store.code, 'target_unavailable'); assert.equal(p.h.store.inputDelivery, 'not_sent');
  assert.doesNotMatch(failed.content[0].text, /计划已保留/);
  assert.equal(p.h.c.PLAN.interrupted, undefined); assert.equal(p.h.c.TASK_HOLD, null); assert.equal(p.h.state.closed, 1);
  const next = await p.tool('press_key', { key: 'enter' });
  assert.equal(next.isError, undefined, next.content[0].text); assert.match(next.content[0].text, /fixture done/);
  assert.equal(p.runs.action, 2); assert.equal(p.holds(), 2, 'the first failure released its hold; the next action holds anew');
  assert.ok(p.h.c.TASK_HOLD); assert.equal(p.h.c.PLAN.interrupted, undefined);
  await p.h.c.endTaskHold();
});

async function closeRefusalOracle(code = source) {
  const p = planHarness({}, code);
  // Before any hold: another agent's tab is refused without taking input.
  p.h.state.owner = { ownerPid: process.pid + 1 };
  const foreign = await p.tool('close_tab', { tab: 1 });
  assert.equal(foreign.isError, true); assert.equal(p.h.store.code, 'not_your_tab');
  assert.equal(p.h.c.PLAN.interrupted, undefined, 'a refused close_tab before the first hold keeps the plan');
  assert.equal(p.h.store.inputDelivery, 'not_sent');
  assert.equal(p.holds(), 0);
  p.h.state.owner = undefined;
  assert.equal((await p.tool('press_key', { key: 'enter' })).isError, undefined);
  const held = p.h.c.TASK_HOLD; assert.ok(held); const start = p.h.events.length;
  for (const refusal of [{ ok: false, reason: 'taken_over', why: 'user_viewing', transient: true }, { ok: false, reason: 'taken_over', why: 'url_changed' },
    { ok: false, reason: 'not_agent_tab' }, { ok: false, reason: 'ownership_unverified' }, 'send-boundary']) {
    p.h.state.closeRefusal = refusal === 'send-boundary' ? null : refusal;
    p.h.state.beforeClose = refusal === 'send-boundary' ? () => { p.h.state.owner = { takenOver: true }; } : null;
    const reply = await p.tool('close_tab', { tab: 1 });
    assert.equal(reply.isError, true); assert.equal(p.h.store.inputDelivery, 'not_sent', JSON.stringify(refusal));
    assert.equal(p.h.c.PLAN.interrupted, undefined, JSON.stringify(refusal)); assert.equal(p.h.c.TASK_HOLD, held);
    assert.equal(p.h.state.held, true); p.h.state.owner = undefined;
  }
  assert.equal(p.h.events.slice(start).includes('release'), false, 'a refused close_tab never ends the plan hold');
  assert.equal(p.h.events.includes('close-tab'), false);
  assert.equal((await p.tool('press_key', { key: 'enter' })).isError, undefined);
  assert.equal(p.holds(), 1, 'the next action runs inside the same hold'); assert.equal(p.runs.action, 2);
  await p.h.c.endTaskHold();
}
await r2check('C4 real path: a refused close_tab keeps the plan and its hold', () => closeRefusalOracle());
await r2check('C4 real path: valid close-refusal delivery omission mutant is caught', async () => {
  await actualIndexMutant('close refusal delivery dropped',
    "const refused = (code, message) => Object.assign(new BridgeError(code, message), { inputDelivery: 'not_sent' });",
    'const refused = (code, message) => new BridgeError(code, message);', closeRefusalOracle);
});

await r2check('C4 real path: Stop still stops the plan, with or without a hold, and never retakes', async () => {
  for (const withHold of [false, true]) {
    const p = planHarness();
    if (withHold) { assert.equal((await p.tool('press_key', { key: 'enter' })).isError, undefined); p.h.state.stopped = true; }
    else p.h.state.afterIdle = () => { p.h.state.stopped = true; };
    const stopped = await p.tool('press_key', { key: 'enter' });
    assert.equal(stopped.isError, true); assert.equal(p.h.store.code, 'user_cancelled');
    assert.equal(p.h.c.PLAN.interrupted?.code, 'esc'); assert.equal(p.h.c.TASK_CANCELLED, 'fixture'); assert.equal(p.h.c.TASK_HOLD, null);
    assert.match(stopped.content[0].text, /等用户明确恢复后重新 task_plan/);
    const holds = p.holds(), actions = p.runs.action;
    p.h.state.stopped = false; p.h.state.afterIdle = null;
    const next = await p.tool('press_key', { key: 'enter' });
    assert.equal(next.isError, true); assert.equal(p.h.store.code, 'user_cancelled');
    assert.deepEqual([p.holds(), p.runs.action], [holds, actions], 'no new hold and no action after Stop');
  }
});

await r2check('C4 real path: unknown delivery still stops the plan and is never replayed', async () => {
  const p = planHarness();
  assert.equal((await p.tool('press_key', { key: 'enter' })).isError, undefined);
  p.script.push(Object.assign(new BridgeError('native_delivery_unknown', 'fixture key outcome unknown'), { inputDelivery: 'unknown', noRetry: true }));
  assert.equal((await p.tool('press_key', { key: 'enter' })).isError, true);
  assert.equal(p.h.store.inputDelivery, 'unknown'); assert.equal(p.h.c.PLAN.interrupted?.code, 'native_delivery_unknown');
  assert.equal(p.h.c.TASK_HOLD, null); assert.equal(p.h.c.TASK_CANCELLED, null);
  const next = await p.tool('press_key', { key: 'enter' });
  assert.equal(next.isError, true); assert.equal(p.h.store.code, 'task_interrupted');
  assert.deepEqual([p.holds(), p.runs.action], [1, 2], 'the unknown action is not replayed and no hold is retaken');

  const c = planHarness({ closeError: Object.assign(new BridgeError('close_pending', 'fixture close outcome unknown'), { inputDelivery: 'unknown' }) });
  assert.equal((await c.tool('close_tab', { tab: 1 })).isError, true);
  assert.equal(c.h.store.inputDelivery, 'unknown'); assert.equal(c.h.c.PLAN.interrupted?.code, 'close_pending');
  assert.equal((await c.tool('close_tab', { tab: 1 })).isError, true); assert.equal(c.h.store.code, 'task_interrupted');
  assert.equal(c.h.events.filter(x => x === 'close-tab').length, 1, 'an unknown close is never sent again');
  assert.equal(c.holds(), 1);
});

// P5: open_tab's reply carries the new tab's read_page output. The read starts after the action's own input
// critical section: after the release when the action gave its hold back, inside a hold a plan keeps (≤ 3 s).
// `reads[i].at` is how many events had happened when the read began.
await check('P5 standalone open_tab: the attached read begins after the Session release and the lease release', async () => {
  const h = harness();
  const out = await h.call('openTabTool', openArgs);
  assert.equal((h.state.reads || []).length, 1, 'not exactly one attached read');
  const [read] = h.state.reads, before = h.events.slice(0, read.at);
  assert.ok(before.indexOf('hold') >= 0 && before.indexOf('hold') < before.indexOf('release') &&
    before.indexOf('release') < before.indexOf('lease-release'), h.events.join(','));
  assert.deepEqual(h.events.slice(read.at), [], 'nothing of the action after the read began');
  assert.deepEqual([read.tab, read.held, read.taskHold, read.attach], [2, false, false, true]);
  assert.equal(h.c.TASK_HOLD, null);
  assert.match(out, /^✅ 已在窗口 10 新开标签 tab=2（后台打开，未替换原标签）。\n/);
  assert.match(out, /\ntab=2 Fixture page\n\[1\] link Fixture$/);
  assert.doesNotMatch(out, /页面可能还在加载|页面内容未能读取/);
});
await check('P5 planned open_tab: the attached read runs inside the hold the plan keeps; no release or new hold for it', async () => {
  const h = harness(); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
  const out = await h.call('openTabTool', openArgs);
  const [read] = h.state.reads;
  assert.deepEqual([read.held, read.taskHold], [true, true]);
  assert.deepEqual([h.events.filter(x => x === 'hold').length, h.events.filter(x => x === 'release').length,
    h.events.filter(x => x === 'lease-release').length], [1, 0, 0], h.events.join(','));
  assert.ok(h.c.TASK_HOLD); assert.match(out, /\[1\] link Fixture/);
  await h.c.endTaskHold();
});
await check('P5 implicit job (a recent task, no plan): open_tab keeps its hold for the gap, so the read runs inside it under the same limit', async () => {
  const h = harness();
  h.c.TASK_GAP_MS = 30000; h.c.taskKey = () => 'implicit fixture';
  const out = await h.call('openTabTool', openArgs);
  const [read] = h.state.reads;
  assert.deepEqual([read.held, read.taskHold], [true, true]);
  assert.deepEqual([h.events.filter(x => x === 'release').length, h.events.filter(x => x === 'lease-release').length], [0, 0]);
  assert.ok(h.c.TASK_HOLD); assert.match(out, /\[1\] link Fixture/);
  await h.c.endTaskHold();
});
await check('P5 planned open_tab: a stuck read gives the success receipt and the hint within 3 s; the hold is kept as it was', async () => {
  const h = harness({ readPage: () => new Promise(() => {}) }); h.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
  const t0 = Date.now();
  const out = await Promise.race([h.call('openTabTool', openArgs), new Promise(resolve => setTimeout(resolve, 6000, 'no reply within 6 s'))]);
  const ms = Date.now() - t0;
  assert.ok(ms >= 2900 && ms < 3500, `replied after ${ms} ms`);
  assert.match(out, /^✅ 已在窗口 10 新开标签 tab=2/);
  assert.match(out, /页面内容未能读取，可 read_page\(tab=2\)。$/);
  assert.ok(h.c.TASK_HOLD); assert.equal(h.events.includes('release'), false);
  await h.c.endTaskHold();
});
await check('P5 open_tab: a failed read keeps the success receipt with the hint; site_blocked keeps its stop and says the tab is open, inside a plan within 3 s even while the hand-back is stuck', async () => {
  const h = harness({ readPage: async () => { throw new BridgeError('chrome_error', 'fixture read failure'); } });
  assert.match(await h.call('openTabTool', openArgs), /^✅ [^]*页面内容未能读取，可 read_page\(tab=2\)。$/);
  const head = '⏸️ fixture.test 出现了人机检查页。', next = '不要重试，也不要换别的工具去绕过。可调用 wait_for_user（tab=2）观察页面。';
  const opened = /\n标签已打开：已在窗口 10 新开标签 tab=2（后台打开，未替换原标签）。\n页面内容没有读取；不要重复 open_tab。$/;
  for (const kind of ['standalone', 'planned', 'planned, hand-back stuck']) {
    const b = harness({ readPage: async (_args, { attach }) => {
      // siteGate's protocol: the verdict is published before markBlocked starts handing the hold back.
      attach.blocked = handed => `${head}\n${handed}\n${next}`;
      if (kind.endsWith('stuck')) return new Promise(() => {});
      throw new BridgeError('site_blocked', `${head}\n已经提醒用户（系统通知 + 菜单栏），键盘鼠标已交还。\n${next}`);
    } });
    if (kind !== 'standalone') b.c.PLAN = { task: 'fixture', returnFocus: focusPolicy('origin') };
    const t0 = Date.now();
    const error = await Promise.race([b.call('openTabTool', openArgs).then(() => null, e => e), new Promise(resolve => setTimeout(resolve, 6000, 'no reply'))]);
    const ms = Date.now() - t0;
    assert.equal(error?.code, 'site_blocked', `${kind}: ${error}`);
    assert.deepEqual([error.noRetry, error.inputDelivery], [true, 'sent']);
    assert.ok(error.message.startsWith(head), error.message); assert.ok(error.message.includes(next)); assert.match(error.message, opened);
    if (kind.endsWith('stuck')) {
      assert.ok(ms >= 2900 && ms < 3300, `${kind}: replied after ${ms} ms`);
      assert.match(error.message, /\n正在提醒用户（系统通知 \+ 菜单栏）并交还键盘鼠标，3 秒内尚未确认完成。\n/);
    } else {
      assert.ok(ms < 1000, `${kind}: replied after ${ms} ms`);
      assert.match(error.message, /键盘鼠标已交还/);
    }
    assert.deepEqual(b.state.registered, [2]);
    if (kind !== 'standalone') await b.c.endTaskHold();
  }
});

// markBlocked as open_tab's read calls it (`hold`: the hold the read began under): it ends that hold only while it
// is still the current one, also after a hand-over in progress; without a hold it ends none. read_page's own
// call (no `hold`) still ends whatever hold is current.
await check('P5 markBlocked from open_tab\'s read ends only the hold the read began under, and only while it is current', async () => {
  const run = async ({ hold, current, swapDuringYield = null }) => {
    const ended = [];
    let resolveYield = null;
    const c = vm.createContext({ BLOCKS: new Map(), siteOf: () => 'fixture.test', blockToken: b => b?.alertToken, randomUUID: () => 'token',
      TELL_EVERY_MS: 300000, tellUser: () => {}, writeTaskState: () => {}, debugLog: () => {}, blockText: () => 'fixture check',
      BLOCK_KIND_EN: {}, process: { env: {} }, Date,
      TASK_HOLD: current, YIELDING: swapDuringYield ? new Promise(resolve => { resolveYield = resolve; }) : null,
      endTaskHold: async () => { ended.push(['current', c.TASK_HOLD?.id ?? null]); c.TASK_HOLD = null; },
      endTaskHoldNow: async th => { if (c.TASK_HOLD !== th) return; ended.push(['now', th.id]); c.TASK_HOLD = null; } });
    vm.runInContext(production('markBlocked'), c);
    const marked = c.markBlocked({ tabId: 2, url: 'https://fixture.test/', blocked: { kind: 'challenge', vendor: '', evidence: 'fixture' } },
      hold === 'none' ? {} : { hold });
    if (swapDuringYield) { c.TASK_HOLD = swapDuringYield; c.YIELDING = null; resolveYield(); }
    await marked;
    return { ended, left: c.TASK_HOLD?.id ?? null, blocked: c.BLOCKS.has(2) };
  };
  const H1 = { id: 'H1' }, H2 = { id: 'H2' };
  assert.deepEqual(await run({ hold: H1, current: H1 }), { ended: [['now', 'H1']], left: null, blocked: true });
  assert.deepEqual(await run({ hold: H1, current: H2 }), { ended: [], left: 'H2', blocked: true });
  assert.deepEqual(await run({ hold: H1, current: H1, swapDuringYield: H2 }), { ended: [], left: 'H2', blocked: true });
  assert.deepEqual(await run({ hold: null, current: H2 }), { ended: [], left: 'H2', blocked: true });
  assert.deepEqual(await run({ hold: 'none', current: H2 }), { ended: [['current', 'H2']], left: null, blocked: true });
});

await check('P5 open_tab: paused or called off once the open action is over → no read, the success receipt with the hint', async () => {
  for (const why of ['paused', 'aborted']) {
    const h = harness();
    h.c.noteAgentDone = async () => {   // inputAction's last step, after the action and its release
      if (why === 'paused') h.c.S = { get: key => key === 'paused' };
      else h.state.signal.aborted = true;
    };
    const out = await h.call('openTabTool', openArgs);
    assert.match(out, /^✅ 已在窗口 10 新开标签 tab=2[^]*\n页面内容未能读取，可 read_page\(tab=2\)。$/);
    assert.deepEqual(h.state.reads || [], [], why);
  }
});

if (r2Failures.length) { console.error(JSON.stringify({ r2Failures: r2Failures.length })); process.exitCode = 1; }

console.log(`${passed} input lifecycle transaction groups passed; no browser or native IO`);
