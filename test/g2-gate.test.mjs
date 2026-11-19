/* G2 (2026-11-02): the remaining page-read entry points pass read_page's strict challenge gate.
 * Offline: the production functions run in a vm; the generated scripts (real block.js and the real page
 * scripts) run in jsdom documents with in-script counters. No browser, helper or user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { JSDOM } from 'jsdom';
import { pageScript, BridgeError } from '../src/bridge.js';
import { RoutineError } from '../src/routine-runner.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function production(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
let passed = 0, failed = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok  ${name} (${Date.now() - t0} ms)`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n${e.stack}`); }
}

const CLEAN = '<title>Fixture</title><input id="f" value=""><a id="a" href="/next">Next</a>';
const CHALLENGE = '<title>Just a moment...</title><p>Checking your browser</p>';
/** A page, its document swapped by `become` (a navigation), and every script but block.js counted when it runs. */
function harness(html = CLEAN, { referrer } = {}) {
  const dom = { w: null };
  const load = h => {
    dom.w = new JSDOM(h, { url: 'https://example.test/page', runScripts: 'outside-only', ...(referrer ? { referrer } : {}) }).window;
    dom.w.__ran = [];
    const input = dom.w.document.getElementById('f');
    dom.w.__chromeBridge = { markers: [null, input, dom.w.document.getElementById('a')].filter((x, i) => i === 0 || x), url: dom.w.location.href, stamp: 1 };
  };
  load(html);
  const evals = [];
  const B = {
    async pageScript(name, vars) {
      const src = String(await pageScript(name, vars)).trim().replace(/;$/, '');
      if (name === 'block') return src;
      return `(function () { window.__ran.push(${JSON.stringify(name)}); return (${src}); })()`;
    },
    async evalInPage(src, tab = null) {
      evals.push(tab);
      const payload = JSON.parse(dom.w.eval(src));
      if (!payload.ok) throw new BridgeError(payload.error || 'page_error', payload.message || 'page script failed');
      return { ...payload, bounds: { left: 0, top: 0, width: 1000, height: 800 }, target: { tabId: tab ?? 7, url: dom.w.location.href } };
    },
    pageDialog: async () => ({ open: false }),
  };
  const marked = [];
  const CALL = new AsyncLocalStorage();
  const c = vm.createContext({
    B, BridgeError, RoutineError, CALL, URL, process: { pid: 1, env: {} }, JSON, Promise, String, Object, Array, Number, Date, Math, Error, Set, Map,
    markBlocked: async (b) => { marked.push(b); return { site: 'example.test', kind: b.blocked.kind }; },
    blockText: b => b.kind || 'check', blockedSaid: (b, site) => `STOP ${site} wait_for_user（tab=${b.tabId}）`,
    newToken: () => 'g2-token',
    uiEnglish: () => false,   // I18N1: armAsk's page hint language (src/index.js uiEnglish)
  });
  vm.runInContext(['gatedPageScript', 'passGate', 'gateStopped', 'readAfter', 'uploadState', 'temporalState',
    'routineCapture', 'locateScript', 'gatedLocateScript', 'locateTarget', 'claimPopups', 'popupProof', 'armAsk', 'armAck'].map(production).join('\n'), c);
  return { dom, load, become: load, B, c, evals, marked, CALL, ran: () => dom.w.__ran };
}
/** block.js answering with its own `error` (its catch): the verdict is unknown. */
const erring = h => { h.dom.w.document.querySelectorAll = () => { throw new Error('synthetic'); }; };

const entries = {
  readAfter: h => h.c.readAfter(1, 7, null, { set: 'tok', strict: true }),
  uploadState: h => h.c.uploadState(7, ['a.txt'], 1),
  temporalState: h => h.c.temporalState(7, { mode: 'status', token: 'tok' }),
  routineCapture: h => h.c.routineCapture(7, { mode: 'state' }),
  locateTarget: h => h.c.locateTarget(1, 7, { gated: true }),
  armAsk: h => h.c.armAsk(7, 1, 'password', null, 'focus-token'),
  armAck: h => h.c.armAck(7),   // r3b: arming marks the page
  selectInSession: h => {
    Object.assign(h.c, { SELECT_ERRORS: {}, targetLine: () => 'tab 7', sleep: async () => {}, post: async () => ({}) });
    vm.runInContext(production('selectInSession'), h.c);
    return h.c.selectInSession({}, { target: { tabId: 7 } }, { step() {}, panel() {} }, { marker: 1, option: 'B' });
  },
};

for (const [name, run] of Object.entries(entries)) {
  await check(`G2 new-fix: ${name} on a challenge document runs only block.js, in one eval`, async () => {
    const h = harness(CHALLENGE);
    const store = {};
    await assert.rejects(h.CALL.run(store, () => run(h)), e => e.code === 'site_blocked' && e.gateBlocked?.blocked?.kind === 'challenge');
    assert.deepEqual(h.ran(), [], 'no page script but block.js ran');
    assert.equal(h.evals.length, 1);
    if (name !== 'routineCapture') assert.equal(store.gateStop?.blocked?.kind, 'challenge', 'the stop is the input call\'s');
  });
  await check(`G2 new-fix: ${name} with an erring check reads nothing (cannot_check)`, async () => {
    const h = harness();
    erring(h);
    await assert.rejects(h.CALL.run({}, () => run(h)), e => e.code === 'cannot_check' && e.gateBlocked === null);
    assert.deepEqual(h.ran(), []);
    assert.equal(h.evals.length, 1);
  });
  await check(`G2 kept: ${name} on a clean document runs its script once, in one eval`, async () => {
    const h = harness();
    await h.CALL.run({}, () => run(h)).catch(() => {});   // the fixture page may not satisfy the script; it ran
    assert.deepEqual(h.ran(), [name === 'readAfter' || name === 'uploadState' ? 'after'
      : name === 'temporalState' ? 'temporal' : name === 'routineCapture' ? 'routine' : name === 'selectInSession' ? 'select' : name === 'armAsk' ? 'ask' : name === 'armAck' ? 'ack' : 'locate']);
    assert.equal(h.evals.length, 1);
  });
}

await check('G2 new-fix: routine runner reads mark a challenge; the recorder\'s capture does not', async () => {
  const h = harness(CHALLENGE);
  await assert.rejects(h.c.routineCapture(7, { mode: 'state' }), e => e instanceof RoutineError && e.code === 'site_blocked');
  assert.equal(h.marked.length, 0);
  await assert.rejects(h.c.routineCapture(7, { mode: 'state' }, { mark: true }), e => e.code === 'site_blocked');
  assert.equal(h.marked.length, 1);
  assert.equal(h.marked[0].tabId, 7);
  assert.deepEqual(h.ran(), []);
});

await check('G2 new-fix: a popup whose document is a challenge or unknown is not probed or claimed', async () => {
  for (const kind of ['challenge', 'unknown', 'clean']) {
    // r2 (Codex B): the real popupProof; the popup's referrer is the clicked page.
    const h = harness(kind === 'challenge' ? CHALLENGE : CLEAN, { referrer: 'https://example.test/src' });
    if (kind === 'unknown') erring(h);
    const claims = [];
    Object.assign(h.c, {
      getTab: async tab => tab === 1 ? { ownerPid: 1 } : null, isMine: () => true, findLiveTab: () => ({ windowId: 10 }),
      popupCandidates: () => [{ tabId: 2, windowId: 10, url: 'https://example.test/page' }],
      settledUrl: async (_t, u) => u,
      legacyTabs: async () => [], agentName: () => 'test', LEDGER: { apply() {} },
      claimTab: async (...a) => { claims.push(a); return true; },
    });
    const out = await h.c.claimPopups({}, {}, { target: { tabId: 1, windowId: 10 } },
      { noteable: true, since: 1, untouched: async () => true }, 'https://example.test/src');
    assert.equal(h.evals.length, 1, kind);
    assert.deepEqual(h.ran(), kind === 'clean' ? ['opener'] : [], kind);
    assert.equal(out.mine.length, kind === 'clean' ? 1 : 0, kind);
    assert.equal(claims.length, kind === 'clean' ? 1 : 0, kind);
  }
});

await check('G2 new-fix: relocation after a wheel burst onto a new challenge document reads nothing; the call stops', async () => {
  for (const viaPrep of [false, true]) {
    const h = harness();
    const posted = [];
    Object.assign(h.c, {
      planScrollStep: (_l, { exhausted }) => exhausted.size || posted.length ? { done: true } : { point: { x: 1, y: 1 }, notches: 2, dir: 'down', key: 'doc', index: 0 },
      aimClickable: () => false, MAX_SCROLL_BURSTS: 8, originFor: () => ({ x: 0, y: 0 }),
      pointerTo: async () => {}, sleep: async () => {}, settlePause: () => 0, between: () => 0, inputSpeedNow: () => 1,
      // The wheel reaches a page that navigates to a bot check.
      post: async (_s, _ctx, kind) => { posted.push(kind); h.become(CHALLENGE); return { sent: 2 }; },
      chainDelta: () => 0,
      geometryKey: () => 'k', GEOMETRY_UNVERIFIED: new Set(), sameGeometryBounds: () => true,
      invalidateGeometry() {}, corroborateGeometry: async () => { throw new Error('not used'); },
    });
    vm.runInContext([production('scrollToTarget'), production('locateForInput')].join('\n'), h.c);
    const ctx = { step() {}, check: async () => {} };
    const prep = viaPrep ? { target: { tabId: 7, windowId: 9, bounds: {} }, chromePid: 1, cgWindow: 2 } : undefined;
    const store = {};
    await assert.rejects(h.CALL.run(store, () => h.c.scrollToTarget({ request: async () => ({}) }, ctx, 1, 7, { rect: { y: 0 } }, true, viaPrep ? { prep } : {})),
      e => e.code === 'site_blocked');
    assert.deepEqual(posted, ['wheel']);
    assert.deepEqual(h.ran(), [], `locate.js did not run on the new document (prep=${viaPrep})`);
    assert.equal(store.gateStop?.blocked?.kind, 'challenge');
  }
});

await check('G2 new-fix: wait_for_user with a field: an erring check is not clean; nothing is located, clicked or marked', async () => {
  const h = harness();
  erring(h);
  const steps = [];
  Object.assign(h.c, {
    dialogRefusal: async () => new Error('dialog'), taskKey: () => '', inputBoundaryCheck() {}, waitMinutes: () => 1,
    callBudgetError: () => new Error('budget'), untilTime: p => p, TIMED_OUT: Symbol('t'), HANDOFFS: new Map(), TASK_HOLD: null,
    inputAction: async () => { steps.push('input'); return ''; }, markBlocked: async () => { steps.push('mark'); return {}; },
  });
  vm.runInContext([production('blockCheck'), production('waitForUserTool')].join('\n'), h.c);
  await assert.rejects(h.c.waitForUserTool({ tab: 7, field: 1, reason: 'password' }), e => e.code === 'cannot_check');
  assert.deepEqual(steps, []);
  assert.deepEqual(h.ran(), []);
  assert.equal(h.evals.length, 1);
});

/** inputAction itself, with its strict pre-input check and the stop raised after the input session. */
function inputHarness({ preVerdict = { ok: true, blocked: null }, action }) {
  const h = harness();
  const calls = [];
  Object.assign(h.c, {
    process: { env: {} }, HANDOFFS: new Map(), TASK_CANCELLED: null, pagePromptAuto: null,
    pausedCheck() {}, conversationInputCheck() {}, screenReady: async () => '', noteAgentDone: async () => {},
    dialogRefusal: async () => new Error('dialog'),
    siteGate: async (tab, read, attach, strict) => {
      calls.push(['siteGate', tab, strict]);
      if (preVerdict === null) return strict ? false : undefined;
      return true;
    },
    inputActionRun: async (_label, _prepare, act) => { calls.push('session'); return action(h, act); },
  });
  vm.runInContext(production('inputAction'), h.c);
  return { h, calls };
}

await check('G2 new-fix: the pre-input check is strict; unknown sends nothing', async () => {
  const { h, calls } = inputHarness({ preVerdict: null, action: async () => 'sent' });
  await assert.rejects(h.CALL.run({}, () => h.c.inputAction('click [1] tab 7', async () => null, async () => null)),
    e => e.code === 'cannot_check' && e.inputDelivery === 'not_sent');
  assert.deepEqual(calls, [['siteGate', 7, true]]);
});

await check('G2 new-fix: a read after sent input that meets a challenge ends the call with site_blocked, sent, no retry', async () => {
  const { h, calls } = inputHarness({ action: async (hh) => {
    hh.become(CHALLENGE);   // the focus click navigated
    // type_text's own callers turn a failed read into their own error; the gate's stop is the call's.
    try { await hh.c.readAfter(1, 7, null, { set: 'tok', strict: true }); }
    catch { throw Object.assign(new BridgeError('input_unconfirmed', 'field changed'), { inputDelivery: 'sent' }); }
  } });
  await assert.rejects(h.CALL.run({}, () => h.c.inputAction('type tab 7', async () => null, async () => null)),
    e => e.code === 'site_blocked' && e.inputDelivery === 'sent' && e.noRetry === true &&
      /已发送的输入结果未确认，不要重发/.test(e.message) && /STOP example\.test/.test(e.message));
  assert.deepEqual(calls, [['siteGate', 7, true], 'session']);
  assert.equal(h.marked.length, 1);
  assert.deepEqual(h.ran(), []);
});

await check('G2 new-fix: a swallowed stop still ends a call that returned', async () => {
  const { h } = inputHarness({ action: async (hh) => {
    erring(hh);
    await hh.c.readAfter(1, 7, null, { check: 'tok' }).catch(() => null);
    return 'typed; unconfirmed';
  } });
  await assert.rejects(h.CALL.run({}, () => h.c.inputAction('type tab 7', async () => null, async () => null)),
    e => e.code === 'cannot_check' && e.inputDelivery === 'sent' && e.noRetry === true && /没有读取页面内容/.test(e.message));
  assert.equal(h.marked.length, 0);
});

await check('G2 kept: a clean input call returns its result; the gate adds no eval', async () => {
  const { h } = inputHarness({ action: async (hh) => { await hh.c.readAfter(1, 7, null, { check: 'tok' }).catch(() => null); return 'done'; } });
  assert.equal(await h.CALL.run({}, () => h.c.inputAction('type tab 7', async () => null, async () => null)), 'done');
  assert.equal(h.evals.length, 1);
  assert.deepEqual(h.ran(), ['after']);
});

/* ---------------------------------------------------------------- round 2 (Codex QA A1–A3) */

/** runInputAction's delivery rule (guard.js: a stop after posted input is `sent`), for actions run by these stubs. */
const delivered = (posted, e) => { if (posted.length && e.inputDelivery === 'not_sent') { e.targetInputDelivery = 'not_sent'; e.inputDelivery = 'sent'; } if (posted.length) e.noRetry = true; return e; };

for (const kind of ['challenge', 'unknown']) {
  await check(`G2 r2 new-fix: scroll after the input-lock wait, the document changed to ${kind} while queued: no read, no input`, async () => {
    const posted = [];
    const { h, calls } = inputHarness({ action: async (hh, act) => {
      // The pre-input check passed on the old document; the page reloads while the call waits for the lock.
      if (kind === 'challenge') hh.become(CHALLENGE); else erring(hh);
      return act({}, { target: { tabId: 7, windowId: 9, bounds: {} }, chromePid: 1, cgWindow: 2 }, { check: async () => {}, step() {} });
    } });
    Object.assign(h.c, { geometryKey: () => 'k', GEOMETRY_UNVERIFIED: new Set(), sameGeometryBounds: () => true,
      invalidateGeometry() {}, corroborateGeometry: async () => { throw new Error('not used'); }, targetLine: () => 'tab 7',
      pointerTo: async () => { posted.push('move'); }, post: async (_s, _c, kind) => { posted.push(kind); return { sent: 1 }; },
      unoccludedPoint: async () => ({ x: 1, y: 1 }), originFor: () => ({ x: 0, y: 0 }) });
    vm.runInContext([production('locateForInput'), production('scrollInSession')].join('\n'), h.c);
    await assert.rejects(h.CALL.run({}, () => h.c.inputAction('scroll down tab 7', async () => null,
      (s, prep, ctx) => h.c.scrollInSession(s, prep, ctx, { direction: 'down' }))),
    e => e.code === (kind === 'challenge' ? 'site_blocked' : 'cannot_check') && e.inputDelivery === 'not_sent' && /没有发送输入/.test(e.message));
    assert.deepEqual(calls, [['siteGate', 7, true], 'session']);
    assert.deepEqual(h.ran(), [], 'locate.js did not run on the new document');
    assert.deepEqual(posted, [], 'no pointer move, no wheel');
    assert.equal(h.marked.length, kind === 'challenge' ? 1 : 0);
  });
}

await check('G2 r2 new-fix: press_key times 3, the first Return opens a challenge: no read on it, no further key', async () => {
  const posted = [];
  const { h } = inputHarness({ action: async (hh, act) => {
    try { return await act({}, { target: { tabId: 7 } }, { step() {} }); } catch (e) { throw delivered(posted, e); }
  } });
  h.dom.w.document.getElementById('f').focus();   // FOCUS4: press_key needs the page to own keyboard focus
  Object.assign(h.c, { persist: fn => fn({}), veilFor: () => null, taskKey: () => '', targetLine: () => 'tab 7',
    prepareActivate: async () => null, recoverNativeMenu: async () => null, guardNativeTarget: async () => {},
    refuseNativeSelect() { throw new Error('select'); },
    post: async (_s, _c, _k, req) => { posted.push(req.name); h.become(CHALLENGE); return {}; } });
  vm.runInContext([production('guardNativeSelect'), production('pressKeyTool')].join('\n'), h.c);
  await assert.rejects(h.CALL.run({}, () => h.c.pressKeyTool({ key: 'enter', times: 3, tab: 7 })),
    e => e.code === 'site_blocked' && e.inputDelivery === 'sent' && e.noRetry === true && /不要重发/.test(e.message));
  assert.deepEqual(posted, ['enter'], 'one key, none after the document changed');
  assert.deepEqual(h.ran(), [], 'native-select.js did not run on the new document');
  assert.equal(h.marked.length, 1);
});

await check('G2 r2 kept: press_key times 2 on a clean page reads native-select.js before each key', async () => {
  const posted = [];
  const { h } = inputHarness({ action: async (hh, act) => act({}, { target: { tabId: 7 } }, { step() {} }) });
  h.dom.w.document.getElementById('f').focus();   // FOCUS4: press_key needs the page to own keyboard focus
  Object.assign(h.c, { persist: fn => fn({}), veilFor: () => null, taskKey: () => '', targetLine: () => 'tab 7',
    prepareActivate: async () => null, guardNativeTarget: async () => {}, refuseNativeSelect() { throw new Error('select'); },
    post: async (_s, _c, _k, req) => { posted.push(req.name); return {}; } });
  vm.runInContext([production('guardNativeSelect'), production('pressKeyTool')].join('\n'), h.c);
  assert.match(await h.CALL.run({}, () => h.c.pressKeyTool({ key: 'enter', times: 2, tab: 7 })), /按了 enter 2 次/);
  assert.deepEqual(posted, ['enter', 'enter']);
  assert.deepEqual(h.ran(), ['native-select', 'native-select']);
  assert.equal(h.evals.length, 2);
});

/** The background page-prompt observer (bridge.js createPagePromptObserver), with its two chromectl children faked:
 * the native probe answers "no dialog", the DOM eval runs the written script in a jsdom document. */
async function observerRun(html, { err = false } = {}) {
  const { createPagePromptObserver } = await import('../src/bridge.js');
  const { EventEmitter } = await import('node:events');
  const h = harness(html);
  if (err) erring(h);
  let written = null;
  const target = { chromePid: 42, windowId: 9, tabId: 7, cgWindow: 70 };
  const observer = createPagePromptObserver({
    readScript: (name, vars) => h.B.pageScript(name, vars),   // counted in-script
    writeScript: async (_p, text) => { written = text; }, removeScript: async () => {},
    spawnChild: (_bin, argv) => {
      const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true;
      setImmediate(() => {
        const out = argv[0] === 'dialog' ? { ok: true, known: true, open: false }
          : { ok: true, ...target, result: h.dom.w.eval(written) };
        c.stdout.emit('data', Buffer.from(JSON.stringify(out))); c.emit('close', 0);
      });
      return c;
    },
  });
  const result = await observer.observe({ target, source: { kind: 'test' }, namespace: 'g2' });
  return { h, result };
}

for (const kind of ['challenge', 'unknown']) {
  await check(`G2 r2 new-fix: the background prompt observer on a ${kind} document runs no observation`, async () => {
    const { h, result } = await observerRun(kind === 'challenge' ? CHALLENGE : CLEAN, { err: kind === 'unknown' });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'site_gate');
    assert.deepEqual(h.ran(), [], 'prompt-observation.js did not run');
    assert.equal(h.dom.w[Symbol.for('mychrome.pagePrompt.g2')], undefined, 'no observer registry on the page');
  });
}
await check('G2 r2 kept: the background prompt observer on a clean document observes', async () => {
  const { h, result } = await observerRun(CLEAN);
  assert.deepEqual(h.ran(), ['prompt-observation']);
  assert.equal(result.status, 'observed');
  assert.ok(h.dom.w[Symbol.for('mychrome.pagePrompt.g2')], 'the clean page has the observer registry (the check above can fail)');
});

/* ---------------------------------------------------------------- round 3 (Codex QA r2: A2 residue) */

/** A real click call: production click → inputAction (strict pre-input check) → inputActionRun → the real input lock
 * (src/lock.js, held by another process meanwhile) → the real runInputAction (src/guard.js) → clickPreflight.
 * `during` runs while this call waits in the lock queue. Nothing reaches a helper: openOwnSession is never expected. */
async function realLockClick({ during, html = CLEAN }) {
  const os = await import('node:os'), path = await import('node:path'), fsp = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'g2-lock-'));
  const lockDir = path.join(dir, 'input.lock');   // the lock is this directory's existence: not created here
  process.env.CHROME_BRIDGE_LOCK = lockDir;
  const lockUrl = new URL('../src/lock.js', import.meta.url).href + `?g2=${Date.now()}`;   // a fresh module bound to `dir`
  const { withInputLock } = await import(lockUrl);
  const { runInputAction } = await import('../src/guard.js');
  // Another MyChrome process holds the input lock until told to let go.
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `const { withInputLock } = await import(${JSON.stringify(lockUrl)});
     await withInputLock('holder', async () => { process.stdout.write('held\\n'); await new Promise(r => process.stdin.once('data', r)); });
     process.exit(0);`], { env: { ...process.env, CHROME_BRIDGE_LOCK: lockDir }, stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('exit', code => reject(new Error(`holder exited ${code}`))); });
  const h = harness(html);
  const sessions = [], waits = [];
  const queued = { ms: null };
  Object.assign(h.c, {
    process: { env: {}, pid: process.pid }, HANDOFFS: new Map(), TASK_CANCELLED: null, TAKEOVER: false, TAKEOVER_LIMITS: {},
    PLAN: null, TASK_GAP_MS: 0, NATIVE_TARGETS: new Map(), pausedCheck() {}, conversationInputCheck() {},
    screenReady: async () => '', noteAgentDone: async () => {}, dialogRefusal: async () => new Error('dialog'),
    siteGate: async (_tab, _r, _a, strict) => { assert.equal(strict, true); return true; },   // clean when the call began
    persist: fn => fn({}), veilFor: () => null, taskKey: () => '', activationHint: () => null, prepareActivate: async () => null,
    actionReturnFocus: () => ({ mode: 'origin' }), inputBoundaryCheck() {}, lockInfo: () => ({}), withInputLock, runInputAction,
    withTurn: (ops, turn) => ({ ...ops, turn }), queueNote: () => '', userActedSince: async () => false, userClickedSince: async () => false,
    waitForUserIdle: async () => 0, waitForHandsOff: async () => 0, openOwnSession: async () => { sessions.push('session'); throw new Error('no helper in this test'); },
    debugLog() {}, focusReturnNote: () => '', LATE_USER_NOTE: () => '', boundsRect: b => b, guardNativeSelect: async () => { throw new Error('not reached'); },
  });
  h.B.chromeInfo = async () => ({ tabId: 7, windowId: 9, chromePid: 42, cgWindow: 70, bounds: { left: 0, top: 0, width: 1000, height: 800 }, url: 'https://example.test/page' });
  h.B.listTabs = async () => [];
  h.B.snapshotScene = async () => null; h.B.cgevent = async () => null;
  vm.runInContext(['click', 'clickPreflight', 'inputActionRun'].map(production).join('\n') + '\n' + production('inputAction'), h.c);
  const store = {};
  const call = h.CALL.run(store, () => h.c.click({ tab: 7, marker: 1 }));
  call.catch(() => {});
  // Queued: give the call time to reach the lock, change the document, then let the holder go.
  await new Promise(r => setTimeout(r, 400));
  await during(h);
  holder.stdin.write('go\n');
  try { return { h, sessions, waits, store, result: await call.then(v => ({ value: v }), e => ({ error: e })) }; }
  finally { holder.kill(); await fsp.rm(dir, { recursive: true, force: true }); }
}

for (const kind of ['challenge', 'unknown']) {
  await check(`G2 r3 new-fix: click queued behind the real input lock, the page reloads into ${kind}: the preflight reads nothing, nothing is sent`, async () => {
    const { h, sessions, result, store } = await realLockClick({ during: async hh => { if (kind === 'challenge') hh.become(CHALLENGE); else erring(hh); } });
    assert.ok(store.queueMs >= 300, `the call waited in the real lock queue (${store.queueMs} ms)`);
    assert.ok(result.error, 'the call fails');
    assert.equal(result.error.code, kind === 'challenge' ? 'site_blocked' : 'cannot_check', result.error.message);
    assert.equal(result.error.inputDelivery, 'not_sent');
    assert.match(result.error.message, /没有发送输入/);
    // r3b: the preflight's armAck is the production one (gated): neither script ran, nothing was armed.
    assert.deepEqual(h.ran(), [], 'neither locate.js nor ack.js ran on the new document');
    assert.equal(h.dom.w.__chromeBridgeAck, undefined, 'nothing armed on the new document');
    assert.deepEqual(sessions, [], 'no input session was opened');
    assert.equal(h.marked.length, kind === 'challenge' ? 1 : 0);
  });
}
await check('G2 r3 kept: the same queued click on an unchanged page runs locate.js once in its preflight', async () => {
  const { h, result, store } = await realLockClick({ during: async () => {} });
  assert.ok(store.queueMs >= 300, `queued (${store.queueMs} ms)`);
  assert.deepEqual([...h.ran()].sort(), ['ack', 'locate'], 'the preflight read the page and armed the listener');
  assert.equal(h.evals.length, 2, 'one eval each for the preflight locate and armAck (unchanged)');
  // jsdom gives the element no size, so locate.js answers with its own refusal: the page was read, not stopped at the gate.
  assert.ok(result.error && !['site_blocked', 'cannot_check'].includes(result.error.code), String(result.error?.code));
});

console.log(`G2 gate: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
