#!/usr/bin/env node
/* STUCK1 (problems-20261101, contracts-batch4.md): a non-modifier key that reads as held although the readings contradict a
 * real hold (another key was pressed after it, or no key activity at all for the 30 s stuck threshold) is released by
 * MyChrome itself: inside the held takeover, before any input of its own, one key-up per key from an event source of the
 * HID system state, then the state is read again. Cleared: the action proceeds, `stuckKeyCleared` on the row and receipt.
 * Still held: input_stuck as before, and only then is the user asked to press the key. Modifiers, fn and mouse buttons keep
 * their rules; never a key-down; at most one attempt per key per call; never outside the hold.
 *
 * Helper level: the production bin/cgevent in dry-run sessions (CGEVENT_DRYRUN=1 posts nothing; the `_fake` seams stand in
 * for the hardware state: held key codes, keyIdle, and whether a key-up from the HID-system-state source clears the key).
 * Call level: production callTool with a fake bridge (as test/notice-refusal.test.mjs) whose input session sends `hold` to
 * such a dry helper and fakes everything else; the `cgevent idle` readings come from a keyboard model on the real clock.
 * Kinds: new (the fix itself), guard (a limit of the new code: no release where one must not happen), kept (existing
 * behaviour). Each new and guard case is RED under its targeted mutation in runs/STUCK1/rerun.sh (problems-20261101).
 * r1 (coordinator rulings after Codex QA round 1): the release is accounted for in every "nothing was sent" (receipt, error
 * facts, the NOTICE1 notification in both languages; a lost hold reply: may have been sent); at most four keys per call and
 * the union of what was cleared on the row and receipt; the 「带我去」 goto path; finite key names in the new prose.
 * r2: one per-call, per-key ledger from the helper's per-key reports (posted, still held); every statement and record
 * derives from it: Secure Input before posting claims nothing; a key not released is never called released; a partial
 * clear records the key that cleared and names only the one still held.
 * r3: the per-key report is set before every exit of the hold (a stop before it, not only Secure Input); a reply without
 * a report is worded as such, never as "no reply".
 * STUCK1_CASE=<name>[,…] runs those cases. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'cgevent');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-stuck1-'));
for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|KITTY_)/.test(k) || k === 'CLAUDECODE') delete process.env[k];
Object.assign(process.env, {
  HOME: path.join(tmp, 'home'), TMPDIR: tmp,
  CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'), CHROME_BRIDGE_LOCK: path.join(tmp, 'lock', 'input.lock'),
  CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'agent-window.json'), CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_AGENT_NAME: 'stuck1-test',
  CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_LANG: 'zh', CHROME_BRIDGE_WARM: '0',
});
for (const k of ['MYCHROME_FOCUS_BACKEND', 'MYCHROME_FOCUS_CARBON_FLAG', 'MYCHROME_FOCUS_RERAISE', 'CHROME_BRIDGE_RETRY_MAX_MS',
  'CHROME_BRIDGE_CALL_BUDGET_MS', 'CHROME_BRIDGE_IDLE_S', 'CHROME_BRIDGE_IDLE_MAX_MS', 'CHROME_BRIDGE_TAKEOVER',
  'CGEVENT_DRYRUN', 'CGEVENT_BIN']) delete process.env[k];
await mkdir(path.join(tmp, 'lock'));
await mkdir(process.env.HOME);
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const idx = await import('../src/index.js');
const bridge = await import('../src/bridge.js');
const T = await import('../src/tabs.js');
const S = await import('../src/settings.js');
const ACTIVITY = process.env.CHROME_BRIDGE_ACTIVITY;
const ONLY = process.env.STUCK1_CASE ? process.env.STUCK1_CASE.split(',') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
idx.__recordForTests(true);
idx.__notifyForTests({ send: () => {}, everyMs: 60_000 });   // no real notification can leave this file
let pbN = 0;
const dryEnv = () => ({ ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.stuck1.${process.pid}.${++pbN}` });
/** The stale-key releases a dry helper recorded (its `posted` list), from any number of replies. */
const releases = replies => replies.flatMap(r => (r && Array.isArray(r.posted) ? r.posted : []).filter(p => p.stuckClear === true));
const keyDowns = replies => replies.flatMap(r => (r && Array.isArray(r.posted) ? r.posted : []).filter(p => p.type === 'keyDown'));

/* ------------------------------------------------------------ helper level */

/** One dry-run helper session: the requests in order, then `end`; every reply in order (the last is the end reply). */
async function helperRun(reqs) {
  const child = spawn(BIN, ['session'], { env: dryEnv(), stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let d; try { d = JSON.parse(line); } catch { return; }
    waiting.get(d.id)?.(d);
  });
  const exited = new Promise(r => child.on('exit', r));
  const replies = [];
  try {
    for (const [i, q] of [...reqs, { op: 'end' }].entries()) {
      const id = i + 1;
      replies.push(await Promise.race([
        new Promise(r => { waiting.set(id, r); child.stdin.write(JSON.stringify({ ...q, id }) + '\n'); }),
        sleep(15_000).then(() => { throw new Error(`helper: no reply to ${q.op}`); })]));
    }
  } finally {
    child.stdin.end();
    await Promise.race([exited, sleep(5000).then(() => child.kill('SIGKILL'))]);
  }
  return replies;
}
const FAKE = (o) => ({ op: '_fake', layoutUnreadable: true, ...o });
const HOLD = (clear) => ({ op: 'hold', ...(clear ? { clearStuck: clear } : {}) });
const BEGIN = (o = {}) => ({ op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 1200, h: 900 }, ...o });

const cases = [];
const add = (kind, name, label, fn) => cases.push({ kind, name, label, fn });
const evidence = [];

add('new', 'helper-cleared', 'stale A requested: one key-up for A, from the HID-system-state source (state ID 1), posted inside the hold; reads up after it; no key-down; the end reply counts it as our own key event', async () => {
  const [, h, end] = await helperRun([FAKE({ heldKeys: [0], stuckClears: true, keyIdle: 5 }), HOLD({ keys: [0], quietS: 3 })]);
  const ups = releases([h]);
  evidence.push(`helper-cleared: ${h.ok ? 'ok' : h.error}, ${h.stuckKeyClear}; ${JSON.stringify(ups.map(({ t, ...p }) => p))}`);
  assert.equal(ups.length, 1, JSON.stringify(h));
  assert.equal(ups[0].holding, true, 'posted outside the hold');
  assert.equal(ups[0].type, 'keyUp', 'not a key-up');
  assert.deepEqual(keyDowns([h]), [], 'a key-down was posted');
  assert.equal(ups[0].key, 0);
  assert.equal(ups[0].sourceStateID, 1, 'not created from the HID-system-state source');
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.stuckKeyClear, 'cleared');
  assert.deepEqual(h.stuckKeys, [{ key: 0, posted: true, held: false }]);
  assert.ok(Number.isFinite(end.lastPostedAt), `the release is not counted as our own key event: ${JSON.stringify(end)}`);
});

add('new', 'helper-failed-once', 'still held after the key-up: input_stuck (nothing else posted); a second hold in the same session posts no second key-up', async () => {
  const [, h, h2] = await helperRun([FAKE({ heldKeys: [0], stuckClears: false, keyIdle: 50 }), HOLD({ keys: [0], quietS: 30 }), HOLD({ keys: [0], quietS: 30 })]);
  evidence.push(`helper-failed-once: first ${h.error}/${h.stuckKeyClear}, second ${h2.error}/${h2.stuckKeyClear}; releases ${releases([h, h2]).length}`);
  assert.equal(h.ok, false); assert.equal(h.error, 'input_stuck', JSON.stringify(h));
  assert.equal(h.stuckKeyClear, 'failed');
  assert.deepEqual(h.stuckKeys, [{ key: 0, posted: true, held: true }]);
  assert.equal(h.postedInput, 0);
  assert.equal(releases([h]).length, 1);
  assert.equal(h2.ok, false);
  assert.equal(releases([h, h2]).length, 1, 'the clear was retried');
  assert.deepEqual(keyDowns([h, h2]), []);
});

add('new', 'helper-secure-input', 'r2: Secure Input refuses the clearing hold before posting: the reply reports the requested key as not posted (no key-up)', async () => {
  const [, h] = await helperRun([FAKE({ heldKeys: [0], stuckClears: true, keyIdle: 50, secureInput: 'Fixture App' }), HOLD({ keys: [0], quietS: 30 })]);
  assert.equal(h.error, 'secure_input', JSON.stringify(h));
  assert.equal(releases([h]).length, 0);
  assert.deepEqual(h.stuckKeys, [{ key: 0, posted: false }], `no per-key report of the refusal: ${JSON.stringify(h)}`);
});

add('new', 'helper-stop-before-hold', 'r3: a stop request before the clearing hold (checkStop): the refusal reports the requested key as not posted (no key-up)', async () => {
  const [, , h] = await helperRun([FAKE({ heldKeys: [0], stuckClears: true, keyIdle: 50 }), { op: 'revokeNative', reason: 'caller' }, HOLD({ keys: [0], quietS: 30 })]);
  assert.equal(h.ok, false, JSON.stringify(h));
  assert.equal(h.error, 'aborted', JSON.stringify(h));
  assert.equal(releases([h]).length, 0);
  assert.deepEqual(h.stuckKeys, [{ key: 0, posted: false }], `no per-key report of the refusal: ${JSON.stringify(h)}`);
});

add('new', 'helper-partial', 'r2: A and S released, only A reads up afterwards: the reply reports A posted and up, S posted and still held; input_stuck names S only', async () => {
  const [, h] = await helperRun([FAKE({ heldKeys: [0, 1], stuckClears: [0], keyIdle: 50 }), HOLD({ keys: [0, 1], quietS: 30 })]);
  assert.equal(h.error, 'input_stuck', JSON.stringify(h));
  assert.equal(h.stuckKeyClear, 'failed');
  assert.deepEqual(h.stuckKeys, [{ key: 0, posted: true, held: false }, { key: 1, posted: true, held: true }], JSON.stringify(h));
  assert.equal(h.message, 'held: S');
  assert.equal(releases([h]).length, 2);
});

add('guard', 'helper-fresh-activity', 'a key or button event since the decision (keyIdle below the decision\'s quiet time: a real hold repeats): no key-up, input_held as before', async () => {
  const [, h] = await helperRun([FAKE({ heldKeys: [0], stuckClears: true, keyIdle: 0.2 }), HOLD({ keys: [0], quietS: 3 })]);
  assert.equal(h.error, 'input_held', JSON.stringify(h));
  assert.equal(h.stuckKeyClear, 'skipped');
  assert.equal(releases([h]).length, 0, 'released a key that may really be held');
});

add('guard', 'helper-modifier', 'a modifier (left ⌘) is never released, even when requested: no key-up, input_held as before', async () => {
  const [, h] = await helperRun([FAKE({ heldKeys: [55], stuckClears: true, keyIdle: 70 }), HOLD({ keys: [55], quietS: 30 })]);
  assert.equal(h.error, 'input_held', JSON.stringify(h));
  assert.equal(h.message, 'held: 左 ⌘');
  assert.equal(releases([h]).length, 0, 'a modifier was released');
});

add('guard', 'helper-not-requested', 'what is held is not exactly the requested keys (another key too; or an unnamed held input): no key-up', async () => {
  const [, a] = await helperRun([FAKE({ heldKeys: [0, 1], stuckClears: true, keyIdle: 50 }), HOLD({ keys: [0], quietS: 30 })]);
  const [, b] = await helperRun([FAKE({ held: true, stuckClears: true, keyIdle: 50 }), HOLD({ keys: [0], quietS: 30 })]);
  assert.equal(a.error, 'input_held', JSON.stringify(a)); assert.equal(b.error, 'input_held', JSON.stringify(b));
  assert.equal(releases([a, b]).length, 0);
});

add('guard', 'helper-five-keys', 'r1 A3: five stale keys requested and held: more than four are never released (no key-up, input_held)', async () => {
  const keys = [0, 1, 2, 3, 5];
  const [, h] = await helperRun([FAKE({ heldKeys: keys, stuckClears: true, keyIdle: 50 }), HOLD({ keys, quietS: 30 })]);
  assert.equal(releases([h]).length, 0, `released more than four keys: ${JSON.stringify(h.posted)}`);
  assert.equal(h.error, 'input_held', JSON.stringify(h));
});

add('guard', 'helper-outside-hold', 'outside a takeover (begin without takeover, with a stale-key request attached): no key-up', async () => {
  const [, b, s] = await helperRun([FAKE({ heldKeys: [0], stuckClears: true, keyIdle: 50 }), BEGIN({ clearStuck: { keys: [0], quietS: 3 } }), { op: 'status' }]);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.takeover, false);
  assert.equal(releases([b, s]).length, 0, 'a key-up outside the hold');
});

add('kept', 'helper-no-request', 'a held key without a stale-key request: input_held before any hold, as before (no key-up, no stuck fields)', async () => {
  const [, h] = await helperRun([FAKE({ heldKeys: [0], stuckClears: true, keyIdle: 50 }), HOLD(null)]);
  assert.equal(h.error, 'input_held'); assert.equal(h.message, 'held: A');
  assert.equal(h.stuckKeyClear, undefined);
  assert.equal(releases([h]).length, 0);
});

add('new', 'row-field-finite', 'the row field takes finite key names only (ANSI caps, five named keys, key0–key127, up to four joined by +)', async () => {
  const row = v => S.activityRecord({ tool: 'click', ok: true, stuckKeyCleared: v }).stuckKeyCleared;
  for (const v of ['A', '7', 'return', 'key122', 'A+S', 'A+S+D+F']) assert.equal(row(v), v, v);
  for (const v of ['a', 'Ф', '键码 0', 'key128', 'key01', 'A+S+D+F+G', 'A+', '', 'https://x', 7, null]) assert.equal(row(v), undefined, String(v));
});

/* ------------------------------------------------------------ call level */

const BOUNDS = { left: 0, top: 0, width: 1200, height: 900 };
const SENT = ['activate_tab', 'activate_index', 'activate_main', 'activate_raise', 'activate_app']
  .map((stage, i) => ({ sequence: i + 1, stage, entered: true, delivery: 'sent', acknowledged: true }));
const own = id => ({ epoch: 1, operationId: id, chromePid: 42, windowId: 7, tabId: 10, cgWindow: state.cg, url: state.urls[10], title: 't10' });
const confirmed = () => id => ({ ok: true, inputDelivery: 'sent', stages: SENT, ...own(id), bounds: { ...BOUNDS }, tabActive: true,
  minimized: false, windowIndex: 1, frontmost: 'Google Chrome', frontmostPid: 42, waitedMs: 0, targetOnTop: true, keyWindowIsTarget: true,
  frontmostChanged: false, prevFrontPutBack: false,
  geometry: { mode: 'fit-current', beforeBounds: { ...BOUNDS }, displayId: 1, branch: 'usable', changed: false, possiblyChanged: false } });
const refused = code => id => ({ ok: false, error: code, stage: 'activate_tab', inputDelivery: 'not_sent', stages: [], epoch: 1, operationId: id });
const unconfirmed = id => ({ ok: false, error: 'activate_unconfirmed', stage: 'activate_verify', inputDelivery: 'sent', noRetry: true,
  stages: SENT, ...own(id), focusSamples: 40, targetOnTop: false, keyWindowIsTarget: false, frontmost: 'Terminal', frontmostPid: 555, focusBlocker: null });

/* The keyboard model behind `cgevent idle` (real clock, epoch ms): stale codes read as held until a release clears them;
 * user presses {code, from, to} (a key event at each end); a real hold repeats every 50 ms while down (autorepeat). */
const NAMES = { 0: 'A', 1: 'S', 2: 'D', 3: 'F', 5: 'G', 55: '左 ⌘' };
function reading(now = Date.now()) {
  const kb = state.kb;
  if (kb.firstRead == null) { kb.firstRead = now; kb.onFirstRead?.(now); }
  const down = kb.presses.filter(p => p.from <= now && now < p.to);
  const codes = [...new Set([...kb.stale, ...down.map(p => p.code)])].sort((a, b) => a - b);
  let keyAt = kb.lastAt;
  for (const p of kb.presses) {
    if (p.from <= now) keyAt = Math.max(keyAt, p.from);
    if (p.to <= now) keyAt = Math.max(keyAt, p.to);
    if (p.repeat && p.from <= now) keyAt = Math.max(keyAt, p.from + Math.floor((Math.min(now, p.to) - p.from) / 50) * 50);
  }
  const keyIdle = Math.max(0, (now - keyAt) / 1000);
  return { ok: true, idle: keyIdle, clickIdle: 100, keyIdle, keyAt, held: codes.map(c => kb.names?.[c] ?? NAMES[c]), heldCodes: codes };
}

let state, log;
const note = e => log.push(e);
const target = id => ({ tabId: id, windowId: 7, chromePid: 42, cgWindow: state.cg, tabActive: true, minimized: false,
  bounds: { ...BOUNDS }, url: state.urls[id], title: `t${id}` });
function page(kind, vars, tab) {
  const t = target(tab == null ? 10 : Number(tab));
  if (kind === 'block') return { ok: true, blocked: null, target: t };
  if (kind === 'locate') return { bounds: t.bounds, view: { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900 },
    aim: { x: 100, y: 112 }, rect: { x: 10, y: 100, width: 200, height: 24 }, visible: { x: 10, y: 100, width: 200, height: 24 },
    hitOk: true, chain: [], tag: 'button', target: t };
  if (kind === 'ack') return { ok: true, armed: true, target: t };
  if (kind === 'native-select') return { ok: true, nativeSelect: false, hasFocus: true, target: t };
  throw new Error(`unexpected page script ${kind}`);
}
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in stuck1 test`); }]));
  return Object.assign(fake, {
    pageDialog: async () => ({ ok: true, open: false }),
    keepAwake: () => () => {},
    ensureScreenAwake: async () => ({ locked: false, displays: 1, woke: false }),
    axInput: async () => ({ ok: true, frontmost: true, windowMatches: true, nodeFound: true, documentToken: 'doc1', focusedDocumentToken: 'doc1',
      menuOpen: false, nativeMenuOpen: false, nativePopup: false }),
    pageScript: async (kind, vars = {}) => `fakePage(${JSON.stringify(kind)}, ${JSON.stringify(vars)})`,
    evalInPage: async (src, tab) => JSON.parse(vm.runInNewContext(src, { fakePage: (k, v) => JSON.stringify(page(k, v, tab)) })),
    pageContentRect: async () => ({ ok: false }),
    chromeInfo: async tab => target(tab == null ? 10 : Number(tab)),
    listTabs: async () => ({ ok: true, frontmost: 'Google Chrome', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
      tabs: [{ id: 10, url: state.urls[10], title: 't10', active: true }] }] }),
    openInputSession: async () => {
      let held = false, real = null;
      return {
        get interrupted() { return null; },
        request: async req => {
          note(`session ${req.op}`);
          if (req.op === 'hold') {
            // The hold goes to the production helper (dry run), its fake hardware state taken from the model right now.
            const k = reading();
            real ||= bridge.openInputSession({ env: dryEnv() });
            await real.request(FAKE({ heldKeys: k.heldCodes, keyIdle: k.keyIdle, stuckClears: state.stuckClears,
              ...(state.secureInput ? { secureInput: state.secureInput } : {}) }), { raw: true });
            // r3: a stop request reaches the session before its hold (the helper refuses before posting).
            if (state.stopBeforeHold) await real.request({ op: 'revokeNative', reason: 'caller' }, { raw: true });
            const r = await real.request(req, { raw: true });
            state.holds.push({ clearStuck: req.clearStuck ?? null, reply: r });
            // r3: a reply without the per-key report (an older helper, an internal error).
            if (state.dropReport) {
              const { stuckKeys, ...rest } = r;
              if (r.ok === false) return rest;
              held = true;
              return { ...rest, pointer: { x: 10, y: 20 } };
            }
            if (r.stuckKeyClear === 'cleared') state.kb.cleared(Date.now());
            // r1 A2: the helper acted, its reply never came back (the bridge's timeout after a confirmed stop: hold is not_sent).
            if (state.loseHoldReply) {
              throw Object.assign(new bridge.BridgeError('session_timeout', '❌ 鼠标键盘助手 30 秒没有回应（hold）。已让它停止，并收到了确认。'),
                { inputDelivery: 'not_sent', helperStop: 'ack' });
            }
            if (r.ok === false) return r;
            held = true;
            return { ...r, pointer: { x: 10, y: 20 } };
          }
          if (req.op === 'recordNativeScene') return { ok: true, epoch: 1, restoreToken: 'r'.repeat(64) };
          if (req.op === 'nativeChrome' && req.intent?.kind === 'activate') {
            state.activations++;
            return state.activation(req.operationId, state.activations);
          }
          if (req.op === 'veil') return { ok: true, held, takeover: { active: held } };
          if (['click', 'key', 'type', 'paste', 'wheel', 'move'].includes(req.op)) state.inputs.push(req.op);
          return { ok: true, epoch: 1, operationId: req.operationId, stages: [], inputDelivery: req.op === 'nativeChrome' ? 'sent' : undefined,
            inputMonitor: true, takeover: { active: held }, ...(req.op === 'warp' ? { verified: true, warped: req.to } : {}) };
        },
        close: async () => {
          note('session close'); held = false;
          const end = real ? await real.close().catch(() => null) : null;
          return { ok: true, takeover: { active: false, swallowedKeys: 0, swallowedPointer: 0 },
            ...(end && Number.isFinite(end.lastPostedAt) ? { lastPostedAt: end.lastPostedAt } : {}) };
        },
      };
    },
    snapshotScene: async () => ({ appPid: 99, chromeWindow: 7, chromeTab: 10 }),
    restoreScene: async (_scene, options) => { await options.native({ kind: 'restoreScene' }, { policy: 'restore' }); return { ok: true, appFrontmost: true }; },
    activateChrome: bridge.activateChrome,
    selectTab: async (id, o) => { await o.native({ kind: 'selectTab', tabId: id, windowId: o.windowId }); return { ok: true, ...target(id), changed: false }; },
    openNavigationObserver: async () => ({ startedAt: Date.now(), untouched: async () => true, close: async () => {} }),
    cgevent: async args => {
      if (args[0] === 'displays') return { displays: [] };
      if (args[0] === 'mousepos') return { x: 10, y: 20 };
      if (args[0] === 'windowsat') return { windows: [] };
      if (args[0] !== 'idle') throw new Error(`B.cgevent ${args[0]} reached in stuck1 test`);
      note('idle');
      return reading();
    },
  });
}
/** A keyboard: `stale` codes read as held; the last key event `restMs` ago; `presses`, or `onFirstRead(t)` adding them. */
function keyboard({ stale = [], restMs = 1500, presses = [], onFirstRead = null, afterClear = null, names = null } = {}) {
  const kb = { stale: new Set(stale), lastAt: Date.now() - restMs, presses: [...presses], firstRead: null, onFirstRead, names,
    // A release from the HID-system-state source clears the stale keys and is a key event itself (ours: F18).
    cleared: t => { kb.stale.clear(); kb.lastAt = Math.max(kb.lastAt, t); afterClear?.(kb); } };
  return kb;
}
async function world(o = {}) {
  for (const t = Date.now(); idx.__taskHoldForTests() && Date.now() - t < 3000;) await sleep(20);
  idx.__resetPanelTaskForTests(); idx.__resetLedgerForTests(); idx.__resetNativeTargetsForTests(); idx.__resetShotsForTests();
  idx.__setTakeoverForTests(true);
  idx.__setRetryForTests({ maxMs: 20_000, pauseMs: 10 });
  S.writeSettings({ inputMode: 'auto', inputSpeed: 1 });
  state = { urls: { 10: 'https://shop.test/form' }, cg: 70, activations: 0, activation: confirmed(), stuckClears: true,
    holds: [], inputs: [], kb: keyboard(), ...o };
  log = [];
  idx.__setBridgeForTests(fakeBridge());
  await T.registerTab(10, state.urls[10], { windowId: 7, agentName: 'stuck1-test' });
  await rm(ACTIVITY, { force: true });
}
async function run(name, args) {
  const started = Date.now();
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  const rows = (await readFile(ACTIVITY, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const replies = state.holds.map(h => h.reply);
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError,
    error: r.structuredContent?.error || null, ms: Date.now() - started, row: rows.at(-1) ?? null,
    holds: state.holds.length, asked: state.holds.filter(h => h.clearStuck).map(h => h.clearStuck),
    releases: releases(replies), keyDowns: keyDowns(replies), inputs: [...state.inputs] };
}
const said = r => `${r.ms} ms; ${r.holds} hold(s), clear asked ${JSON.stringify(r.asked)}; ${r.releases.length} release(s); inputs ${r.inputs}; ` +
  `${r.isError ? r.error?.code : 'ok'}; row ${JSON.stringify(r.row && { code: r.row.code, stuckKeyCleared: r.row.stuckKeyCleared })}`;
/** The user pressed and released S once, 150 ms after the first reading showed A held (A itself stays held: stale). */
const typedAfter = () => keyboard({ stale: [0], restMs: 1500, onFirstRead: t => state.kb.presses.push({ code: 1, from: t + 150, to: t + 230 }) });

add('new', 'after-other-key', 'the field case: A reads held while the user typed S after it, then paused: one key-up for A inside the hold, the key press proceeds, stuckKeyCleared A on the row and receipt, no request to press the key', async () => {
  await world({ kb: typedAfter() });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`after-other-key: ${said(r)}`);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.asked, [{ keys: [0], quietS: 3 }]);
  assert.equal(r.releases.length, 1, said(r));
  assert.equal(r.releases[0].holding, true);
  assert.deepEqual(r.keyDowns, []);
  assert.deepEqual(r.inputs, ['key'], 'the action did not proceed');
  assert.equal(r.row?.stuckKeyCleared, 'A', JSON.stringify(r.row));
  assert.match(r.text, /stuckKeyCleared: A/);
  assert.match(r.text, /卡住的键 A 各发了一次松开/);
  assert.doesNotMatch(r.text, /按一下这个键/);
  assert.ok(log.indexOf('session hold') < log.findIndex(e => e === 'session key'), log.join(' > '));
});

add('new', 'silent-threshold', 'A reads held with no key activity for 31 s (the existing stuck threshold): released inside the hold and the key press proceeds (before: input_stuck)', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000 }) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`silent-threshold: ${said(r)}`);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.asked, [{ keys: [0], quietS: 30 }]);
  assert.equal(r.releases.length, 1);
  assert.deepEqual(r.inputs, ['key']);
  assert.equal(r.row?.stuckKeyCleared, 'A');
  assert.match(r.text, /stuckKeyCleared: A/);
});

add('new', 'clear-fails', 'the key-up does not clear it: input_stuck as before, now saying a release was tried; the user is asked to press A; exactly one key-up, one hold, no input, no retry', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000 }), stuckClears: false });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`clear-fails: ${said(r)}; text ${JSON.stringify(r.text.split('\n').slice(0, 2))}`);
  assert.equal(r.error?.code, 'input_stuck', r.text);
  assert.equal(r.row?.code, 'input_stuck');
  assert.equal(r.row?.stuckKeyCleared, undefined);
  assert.equal(r.releases.length, 1, said(r));
  assert.equal(r.holds, 1, said(r));
  assert.deepEqual(r.inputs, []);
  assert.match(r.text, /替卡住的键 A 各发了一次松开；系统仍显示 A 按着，所以没有操作。/);
  assert.match(r.text, /请用户按一下这个键再松开（「A」）/);
});

add('new', 'retry-once-per-call', 'cleared on the first attempt, the activation then refused (retried); A reads held again on the second attempt: no second key-up in the call, input_stuck asking for the key', async () => {
  // The second attempt's readings: A held again with 31 s of no key activity (the fixture states the facts as given).
  await world({ kb: keyboard({ stale: [0], restMs: 31_000, afterClear: kb => setTimeout(() => { kb.stale.add(0); kb.lastAt = Date.now() - 31_000; }, 0) }),
    activation: (id, n) => (n === 1 ? refused('focus_unconfirmed')(id) : confirmed()(id)) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`retry-once-per-call: ${said(r)}`);
  assert.equal(r.releases.length, 1, `released twice in one call: ${said(r)}`);
  assert.equal(r.asked.length, 1, said(r));
  assert.equal(r.error?.code, 'input_stuck', r.text);
  assert.match(r.text, /这次已替卡住的键 A 发过一次松开/);
  assert.match(r.text, /请用户按一下这个键再松开（「A」）/);
  assert.deepEqual(r.inputs, []);
  assert.equal(r.row?.stuckKeyCleared, 'A', 'the first attempt\'s release is on the row');
});

add('new', 'error-receipt', 'released, then the action refused for another reason (another app in front): the error receipt and the row carry stuckKeyCleared', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000 }), activation: unconfirmed });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`error-receipt: ${said(r)}; error ${JSON.stringify(r.error)}`);
  assert.equal(r.error?.code, 'activate_unconfirmed', r.text);
  assert.equal(r.error?.stuckKeyCleared, 'A');
  assert.equal(r.row?.stuckKeyCleared, 'A');
  assert.equal(r.releases.length, 1);
});

add('guard', 'real-hold', 'A really held (repeating every 50 ms) for 1.2 s, then released: nothing requested or released; the hold waits until the user is done, as before', async () => {
  await world({ kb: keyboard({ stale: [], restMs: 5000, onFirstRead: t => state.kb.presses.push({ code: 0, from: t - 400, to: t + 1200, repeat: true }) }) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`real-hold: ${said(r)}`);
  assert.deepEqual(r.asked, [], 'a release was requested for a key really held');
  assert.equal(r.releases.length, 0);
  assert.equal(r.isError, false, r.text);
  assert.ok(r.ms >= 1200 + 1400, `did not wait for the user: ${r.ms} ms`);
});

add('guard', 'modifier-unchanged', 'left ⌘ reads held for a whole round with no key event: input_stuck as before (asks for the key), nothing requested or released, no hold', async () => {
  await world({ kb: keyboard({ stale: [55], restMs: 70_000 }) });
  idx.__setRetryForTests({ maxMs: 1200, pauseMs: 10 });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`modifier-unchanged: ${said(r)}`);
  assert.deepEqual(r.asked, [], 'a modifier release was requested');
  assert.equal(r.releases.length, 0);
  assert.equal(r.holds, 0);
  assert.equal(r.error?.code, 'input_stuck', r.text);
  assert.match(r.text, /「左 ⌘」一直按着/);
});

/* ---- r1 */

/** The NOTICE1 notifications of one run (the stub is the only sender), in the UI language given. */
async function withNotices(lang, fn) {
  const sends = [];
  idx.__notifyForTests({ send: text => sends.push(text), everyMs: 60_000, enabled: true });
  process.env.CHROME_BRIDGE_UI_LANG = lang;
  try { return { r: await fn(), sends: sends.filter(t => /^(agent 想操作 Chrome|The AI tried to use Chrome)/.test(t)) }; }
  finally { delete process.env.CHROME_BRIDGE_UI_LANG; idx.__notifyForTests({ send: () => {}, everyMs: 60_000 }); }
}

add('new', 'focus-refusal-after-clear', 'r1 A2: A released, then the focus check refuses (another app in front): the receipt and the NOTICE1 notification (zh and en) say only one release of A was sent and the requested input was not, never "nothing was sent"', async () => {
  for (const lang of ['zh', 'en']) {
    await world({ kb: keyboard({ stale: [0], restMs: 31_000 }), activation: unconfirmed });
    const { r, sends } = await withNotices(lang, () => run('press_key', { tab: 10, key: 'enter' }));
    evidence.push(`focus-refusal-after-clear ${lang}: ${said(r)}; notice ${JSON.stringify(sends)}`);
    assert.equal(r.error?.code, 'activate_unconfirmed', r.text);
    assert.equal(r.releases.length, 1);
    assert.equal(r.error?.stuckKeyReleased, 'A', JSON.stringify(r.error));
    // The refusal says 「没有发送点击或按键」; the reply's line scopes it to the requested input and names the release.
    assert.match(r.text, /没有发送点击或按键/, 'fixture: the focus refusal no longer says nothing was sent');
    assert.match(r.text, /\n注：这次调用里 MyChrome 只替卡住的键 A 各发了一次松开（stuckKeyCleared: A）；回复里说没有发送的，指这次要做的点击或按键。/, r.text);
    assert.equal(sends.length, 1, `notifications: ${JSON.stringify(sends)}`);
    if (lang === 'zh') {
      assert.match(sends[0], /只替卡住的键 A 发了一次松开；没有发送这次要做的点击或按键。/, sends[0]);
      assert.doesNotMatch(sends[0], /没有发送任何点击或按键/);
    } else {
      assert.match(sends[0], /Only one release of the stuck key A was sent; the requested click or key was not sent\./, sends[0]);
      assert.doesNotMatch(sends[0], /No click or key was sent/);
    }
  }
});

add('new', 'lost-hold-reply', 'r1 A2: the clearing hold\'s reply is lost (timeout after a confirmed stop: hold counts as not_sent): the receipt says a release may have been sent; the error facts say stuckKeyRelease unknown', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000 }), loseHoldReply: true });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`lost-hold-reply: ${said(r)}; error ${JSON.stringify(r.error)}; last line ${JSON.stringify(r.text.split('\n').filter(l => l.startsWith('注：')))}`);
  assert.equal(r.error?.code, 'session_timeout', r.text);
  assert.deepEqual(r.inputs, []);
  assert.equal(r.error?.stuckKeyMaybeReleased, 'A', JSON.stringify(r.error));
  assert.equal(r.error?.stuckKeyReleased, undefined);
  assert.match(r.text, /\n注：这次调用里 MyChrome 可能已替卡住的键 A 发过一次松开（helper 没有回复，无法确认）；回复里说没有发送的，指这次要做的点击或按键。/, r.text);
});

add('guard', 'five-stale-keys', 'r1 A3: five keys read held with no key activity for 31 s: more than four are not handed to the hold; today\'s input_stuck, no key-up', async () => {
  await world({ kb: keyboard({ stale: [0, 1, 2, 3, 5], restMs: 31_000 }) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`five-stale-keys: ${said(r)}`);
  assert.deepEqual(r.asked, [], 'more than four keys were handed to the hold');
  assert.equal(r.releases.length, 0);
  assert.equal(r.error?.code, 'input_stuck', r.text);
  assert.match(r.text, /请用户按一下这个键再松开（「A、S、D、F、G」）/);
});

add('new', 'two-keys-one-call', 'r1 A3: A released on the first attempt (activation refused, retried), S released on the second: both on the row and the receipt (A+S)', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000, afterClear: kb => setTimeout(() => {
      if (kb.secondDone) return;
      kb.secondDone = true; kb.stale.add(1); kb.lastAt = Date.now() - 31_000;
    }, 0) }),
    activation: (id, n) => (n === 1 ? refused('focus_unconfirmed')(id) : confirmed()(id)) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`two-keys-one-call: ${said(r)}`);
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.asked, [{ keys: [0], quietS: 30 }, { keys: [1], quietS: 30 }]);
  assert.equal(r.releases.length, 2);
  assert.equal(r.row?.stuckKeyCleared, 'A+S', JSON.stringify(r.row));
  assert.match(r.text, /stuckKeyCleared: A\+S/);
});

add('new', 'layout-name-prose', 'r1 B1: the layout names keycode 0 「Ф」: the new prose and the row use the finite name A only', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000, names: { 0: 'Ф' } }) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`layout-name-prose: ${said(r)}`);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /卡住的键 A 各发了一次松开（stuckKeyCleared: A）/, r.text);
  assert.doesNotMatch(r.text, /Ф/);
  assert.equal(r.row?.stuckKeyCleared, 'A');
});

add('new', 'goto-clears', 'r1 A4: 「带我去」 with A stale (31 s, no key activity): one key-up inside the goto\'s hold, then the goto proceeds (shown)', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000 }) });
  const G = idx.__gotoForTests();
  const blocks = idx.__blocksForTests();
  blocks.set(10, { kind: 'user', vendor: '', evidence: 'x', site: 'shop.test', url: state.urls[10], since: Date.now(), toldAt: Date.now() });
  try {
    const temporary = `${G.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ id: `goto-${Date.now()}`, tab: 10, at: Date.now(), ...G.identity(10) }));
    await rename(temporary, G.file);
    const status = await G.run();
    const result = JSON.parse(await readFile(G.resultFile, 'utf8'));
    const ups = releases(state.holds.map(h => h.reply));
    evidence.push(`goto-clears: ${status}/${result.reason}; holds ${state.holds.length}, asked ${JSON.stringify(state.holds.map(h => h.clearStuck))}; ` +
      `releases ${ups.length}; activations ${state.activations}`);
    assert.equal(status, 'shown', JSON.stringify(result));
    assert.deepEqual(state.holds.map(h => h.clearStuck), [{ keys: [0], quietS: 30 }]);
    assert.equal(ups.length, 1);
    assert.equal(ups[0].holding, true);
    assert.equal(state.activations, 1, 'the goto did not proceed to the tab');
  } finally { blocks.delete(10); }
});

/* ---- r2 */

add('new', 'secure-input-retry', 'r2: after a decision, Secure Input refuses every clearing hold before posting: no key-up, and the final refusal claims no release (no release prose, no note, no release facts)', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000 }), secureInput: 'Fixture App' });
  idx.__setRetryForTests({ maxMs: 1500, pauseMs: 50 });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`secure-input-retry: ${said(r)}; reports ${JSON.stringify(state.holds.map(h => h.reply.stuckKeys))}; error ${JSON.stringify(r.error)}`);
  assert.equal(r.error?.code, 'secure_input', r.text);
  assert.ok(r.asked.length >= 2, `retried with the same decision: ${said(r)}`);
  assert.equal(r.releases.length, 0);
  assert.doesNotMatch(r.text, /松开/, `a release is claimed: ${r.text}`);
  assert.equal(r.error?.stuckKeyReleased, undefined); assert.equal(r.error?.stuckKeyMaybeReleased, undefined);
  assert.equal(r.row?.stuckKeyCleared, undefined);
});

add('new', 'retry-a-then-as', 'r2: A released on the first attempt; on the retry A and S read held (31 s): the refusal says only A was released (S never), the note names A only', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000, afterClear: kb => setTimeout(() => { kb.stale.add(0); kb.stale.add(1); kb.lastAt = Date.now() - 31_000; }, 0) }),
    activation: (id, n) => (n === 1 ? refused('focus_unconfirmed')(id) : confirmed()(id)) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`retry-a-then-as: ${said(r)}; text ${JSON.stringify(r.text.split('\n').filter(l => /松开/.test(l)))}`);
  assert.equal(r.error?.code, 'input_stuck', r.text);
  assert.equal(r.releases.length, 1);
  assert.match(r.text, /MyChrome 这次已替卡住的键 A 发过一次松开，它仍显示按着/, r.text);
  assert.match(r.text, /\n注：这次调用里 MyChrome 只替卡住的键 A 各发了一次松开（stuckKeyCleared: A）；/, r.text);
  for (const line of r.text.split('\n').filter(l => /松开/.test(l))) {
    assert.doesNotMatch(line.replace(/「[^」]*」/g, ''), /键 [^ ，；]*S[^ ，；]* (各)?发/, `S described as released: ${line}`);
  }
  assert.equal(r.error?.stuckKeyReleased, 'A');
  assert.equal(r.row?.stuckKeyCleared, 'A');
});

add('new', 'partial-clear', 'r2: A and S stale, only A clears after its key-up: stuckKeyCleared A on the row and the receipt; the refusal names only S as still held', async () => {
  await world({ kb: keyboard({ stale: [0, 1], restMs: 31_000 }), stuckClears: [0] });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`partial-clear: ${said(r)}; error ${JSON.stringify(r.error)}; text ${JSON.stringify(r.text.split('\n').slice(0, 2))}`);
  assert.equal(r.error?.code, 'input_stuck', r.text);
  assert.equal(r.releases.length, 2);
  assert.match(r.text, /替卡住的键 A\+S 各发了一次松开，A 已松开（stuckKeyCleared: A）；系统仍显示 S 按着/, r.text);
  assert.match(r.text, /请用户按一下这个键再松开（「S」）/);
  assert.doesNotMatch(r.text, /仍显示 A|「A」）/);
  assert.equal(r.row?.stuckKeyCleared, 'A', JSON.stringify(r.row));
  assert.equal(r.error?.stuckKeyCleared, 'A', JSON.stringify(r.error));
  assert.equal(r.error?.stuckKeyReleased, 'A+S');
});

/* ---- r3 */

add('new', 'stop-before-hold', 'r3: a stop request reaches the session before its clearing hold: the refusal claims no release (no release prose, no note, no release facts)', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000 }), stopBeforeHold: true });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`stop-before-hold: ${said(r)}; reports ${JSON.stringify(state.holds.map(h => h.reply.stuckKeys))}; error ${JSON.stringify(r.error)}`);
  assert.ok(r.isError, r.text);
  assert.equal(r.releases.length, 0);
  assert.ok(state.holds.length >= 1);
  for (const h of state.holds) assert.deepEqual(h.reply.stuckKeys, [{ key: 0, posted: false }], `a hold without the not-posted report: ${JSON.stringify(h.reply)}`);
  assert.doesNotMatch(r.text, /松开/, `a release is claimed: ${r.text}`);
  assert.equal(r.error?.stuckKeyReleased, undefined); assert.equal(r.error?.stuckKeyMaybeReleased, undefined);
});

add('new', 'reply-without-report', 'r3: the clearing hold\'s reply comes back without the per-key report: "may have been sent" with the report missing, never "no reply"', async () => {
  await world({ kb: keyboard({ stale: [0], restMs: 31_000 }), dropReport: true });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  evidence.push(`reply-without-report: ${said(r)}; text ${JSON.stringify(r.text.split('\n').filter(l => /松开/.test(l)))}`);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /可能已替卡住的键 A 发过一次松开（helper 的回复没有带松开报告，无法确认）/, r.text);
  assert.doesNotMatch(r.text, /没有回复/, `"no reply" although the helper replied: ${r.text}`);
  assert.equal(r.row?.stuckKeyCleared, undefined, 'cleared without a report');
});

add('kept', 'no-stale-key', 'nothing held: the hold carries no request and nothing is released (control)', async () => {
  await world({ kb: keyboard({ stale: [], restMs: 60_000 }) });
  const r = await run('press_key', { tab: 10, key: 'enter' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.asked, []); assert.equal(r.releases.length, 0);
  assert.equal(r.row?.stuckKeyCleared, undefined);
  assert.doesNotMatch(r.text, /stuckKeyCleared/);
});

add('kept', 'monitored-mode', 'outside a takeover (CHROME_BRIDGE_TAKEOVER=0 mode): no hold, no request, no key-up', async () => {
  await world({ kb: typedAfter() });
  idx.__setTakeoverForTests(false);
  idx.__setRetryForTests({ maxMs: 1500, pauseMs: 10 });
  try {
    const r = await run('press_key', { tab: 10, key: 'enter' });
    evidence.push(`monitored-mode: ${said(r)}`);
    assert.equal(r.holds, 0); assert.deepEqual(r.asked, []); assert.equal(r.releases.length, 0);
    assert.equal(log.includes('session hold'), false);
  } finally { idx.__setTakeoverForTests(true); }
});

/* ------------------------------------------------------------ run */

let passed = 0, failed = 0;
for (const kind of ['new', 'guard', 'kept']) {
  for (const c of cases.filter(x => x.kind === kind && (!ONLY || ONLY.includes(x.name)))) {
    try { await c.fn(); passed++; console.log(`  ok    [${kind}] ${c.name}: ${c.label}`); }
    catch (e) { failed++; console.log(`FAIL  [${kind}] ${c.name}: ${c.label}\n${e.stack}`); }
  }
}
assert.ok(passed + failed > 0, `no case named ${ONLY}`);
idx.__resetPanelTaskForTests();
for (const line of evidence) console.log(`  evidence  ${line}`);
console.log(`\nstuck-key-clear tests: ${passed} passed, ${failed} failed.`);
await rm(tmp, { recursive: true, force: true }).catch(() => {});
process.exit(failed ? 1 : 0);
