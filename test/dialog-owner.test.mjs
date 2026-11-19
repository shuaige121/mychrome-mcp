/* Contract D (2026-11-01): where a native page dialog is, and no page eval while one may block.
 * Runs the production functions from src/index.js in a vm with fake bridge/registry; no Chrome or input. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BridgeError } from '../src/bridge.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function production(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

const OWNER = 4242;
const dialog = tabId => ({ open: true, title: 'fixture', texts: ['SYNTHETIC'], buttons: ['OK'],
  identity: { version: 1, tabId, windowId: 1, chromePid: 42, cgWindow: 7, dialogCgWindow: 90, token: 'f'.repeat(64) } });

function placeHarness(records, current = 5) {
  const calls = [];
  const c = vm.createContext({ Number, BridgeError,
    readTabRecord: async id => { calls.push(`record ${id}`); const r = records[id]; if (r instanceof Error) return undefined; return r ?? null; },
    isMine: rec => !!rec && Number(rec.ownerPid) === OWNER,
    B: { chromeInfo: async tab => { calls.push(`info ${tab}`); return { tabId: current }; } } });
  vm.runInContext(['dialogNote', 'dialogPlace', 'dialogRefusal'].map(production).join('\n'), c);
  return { c, calls };
}

await check('dialogPlace: the native binding decides the owner tab; registry decides whose it is', async () => {
  const cases = [
    [{ 9: { ownerPid: OWNER } }, 5, { tabId: 9, who: 'mine' }],
    [{ 9: { ownerPid: OWNER, takenOver: true } }, 5, { tabId: 9, who: 'user' }],
    [{ 9: { ownerPid: 7 } }, 5, { tabId: 9, who: 'agent' }],
    [{}, 5, { tabId: 9, who: 'user' }],
    [{ 9: new Error('unreadable') }, 5, null],
  ];
  for (const [records, tab, want] of cases) {
    const h = placeHarness(records);
    assert.deepEqual(JSON.parse(JSON.stringify(await h.c.dialogPlace(dialog(9), tab))), want);
  }
  // Round 2 (v4 A1): being the call's target never overrides the registry. Each tab targeted explicitly.
  for (const [records, want] of [
    [{ 9: { ownerPid: 7 } }, 'agent'],                          // another agent's tab
    [{ 9: { ownerPid: OWNER, takenOver: true } }, 'user'],      // taken over (this session's record)
    [{ 9: { ownerPid: 7, takenOver: true } }, 'user'],          // taken over (another session's record)
    [{ 9: { ownerPid: OWNER } }, 'mine'],
    [{}, 'mine'],                                               // no record: the call's own target (round 5)
  ]) assert.equal((await placeHarness(records).c.dialogPlace(dialog(9), 9)).who, want, JSON.stringify(records));
  // No tab given: Chrome's current tab stands in for the target, only for a tab with no record.
  const cur = placeHarness({}, 9);
  assert.deepEqual({ ...await cur.c.dialogPlace(dialog(9), null) }, { tabId: 9, who: 'mine' });
  assert.deepEqual(cur.calls, ['record 9', 'info null']);
  assert.equal((await placeHarness({ 9: { ownerPid: 7 } }, 9).c.dialogPlace(dialog(9), null)).who, 'agent');
  assert.equal((await placeHarness({ 9: { ownerPid: OWNER, takenOver: true } }, 9).c.dialogPlace(dialog(9), null)).who, 'user');
  assert.equal((await placeHarness({}, 5).c.dialogPlace(dialog(9), null)).who, 'user');
  // No native binding: unknown, the generic text as before.
  assert.equal(await placeHarness({}).c.dialogPlace({ open: true, texts: [], buttons: ['OK'] }, 5), null);
});

await check('dialogRefusal: mine names answer_dialog(tab=M); someone else\'s never suggests answering', async () => {
  const mine = await placeHarness({ 9: { ownerPid: OWNER } }).c.dialogRefusal(dialog(9), 5);
  assert.equal(mine.code, 'page_dialog');
  assert.match(mine.message, /「SYNTHETIC」，按钮：OK。标签 9 开着对话框.*answer_dialog（tab=9/);
  const user = await placeHarness({}).c.dialogRefusal(dialog(9), 5);
  assert.match(user.message, /对话框在标签 9（用户的标签）.*告诉用户去处理/);
  assert.doesNotMatch(user.message, /answer_dialog/);
});

function fieldHarness(probe) {
  let now = 1000;
  const calls = [];
  const c = vm.createContext({ Number, String, Math, BridgeError,
    Date: { now: () => now }, sleep: async ms => { now += ms; },
    BLOCKS: new Map(), writeTaskState() {}, pausedCheck() {}, siteOf: u => u, CALL: { getStore: () => null },
    followSubmit: async () => null, ledgerNavigated() {}, noteAgentNavigation: async () => {},
    B: {
      pageDialog: async () => { calls.push('dialog'); return probe(now); },
      pageScript: async (name, vars) => JSON.stringify({ name, vars }),
      evalInPage: async script => { calls.push(`eval ${JSON.parse(script).vars.ASK.read ? 'read' : 'disarm'}`);
        return { target: { url: 'https://fixture.test/' }, armed: true, connected: true, entered: { how: 'enter', filled: true, at: 0 } }; },
      chromeInfo: async () => null,
    } });
  vm.runInContext([source.match(/^const HANDOFF_NEXT\b.*$/m)[0], source.match(/^function blockToken\b.*$/m)[0],
    ...['clearBlock', 'notDone', 'disarmAsk', 'waitForFieldObserved'].map(production)].join('\n'), c);
  c.ASK_POLL_MS = 700;
  const wait = () => c.waitForFieldObserved({ tabId: 5, startUrl: 'https://fixture.test/', field: 3, why: 'code',
    ask: { token: 'ask', alertToken: 'a', done: false }, ms: 10_000, t0: 1000, waitStartedAt: 1000 }, null);
  return { c, calls, wait };
}

await check('field hand-off poll: no ask eval while a dialog is open anywhere or the probe is unknown', async () => {
  for (const probe of [() => dialog(9), () => { throw new BridgeError('dialog_probe_unknown', 'fixture'); }]) {
    const h = fieldHarness(probe);
    const out = await h.wait();
    assert.match(out, /用户还没在 \[3\] 输入完/);
    assert.ok(h.calls.length > 5 && h.calls.every(x => x === 'dialog'), h.calls.join(','));
  }
  // Once the dialog is gone the poll reads the page again and sees the user's Return.
  const h = fieldHarness(now => now < 4000 ? dialog(9) : { open: false });
  assert.match(await h.wait(), /用户在 \[3\] 输入完按了回车/);
  assert.equal(h.calls.filter(x => x === 'eval read').length, 1);
  assert.ok(h.calls.indexOf('eval read') > h.calls.indexOf('dialog'));
});

await check('field hand-off cleanup: the highlight is withdrawn only when no dialog may block the page', async () => {
  for (const [probe, evals] of [[() => dialog(9), 0], [() => { throw new BridgeError('dialog_ambiguous', 'x'); }, 0], [() => ({ open: false }), 1]]) {
    const h = fieldHarness(probe);
    const r = await h.c.disarmAsk({ token: 'ask' }, 5);
    assert.equal(h.calls.filter(x => x === 'eval disarm').length, evals);
    if (!evals) assert.equal(r, null, 'withdrawal unconfirmed');
  }
});

console.log(`dialog-owner: ${passed} groups passed; all browser/native IO faked`);
