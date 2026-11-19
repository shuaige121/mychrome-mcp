// Actual close tool, registry close policy and bridge adapters; synthetic IO only.
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mychrome-owner-round2-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(dir, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(dir, 'lock');
process.env.CHROME_BRIDGE_LAUNCHER_PID = String(process.ppid);
const T = await import('../src/tabs.js'), B = await import('../src/bridge.js');
assert.notEqual(T.OWNER_PID, process.pid);
await fs.mkdir(process.env.CHROME_BRIDGE_LOCK);
await fs.writeFile(path.join(process.env.CHROME_BRIDGE_LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function production(name, input = source) { const start = input.indexOf(`async function ${name}(`); assert.ok(start >= 0); return input.slice(start, input.indexOf('\n}', start) + 2); }
let passed = 0, nextTabId = 200;
async function test(name, fn) { await fn(); console.log(`ok ${++passed} ${name}`); }
async function closeFixture(kind, input = source) {
  const id = nextTabId++, events = [];
  const target = { tabId: id, windowId: 4, chromePid: 7, cgWindow: 9, url: 'https://fixture.test/', tabActive: true };
  const owner = kind === 'foreign' ? process.pid : T.OWNER_PID;
  await T.registerTab(id, target.url, { windowId: 4, ownerPid: owner });
  let exists = true, checks = 0;
  const ctx = { check: async () => { events.push('hold-check'); if (kind === 'stale' && ++checks >= 1) throw new B.BridgeError('native_epoch_changed', 'stale hold'); },
    sent: kind => events.push('sent:' + kind), unsent() {}, native: async () => ({ ok: true }) };
  const c = vm.createContext({ ...T, B: { listTabs: async () => ({ chromePid: 7, frontmost: 'Google Chrome',
    windows: [{ id: 4, index: 1, tabs: exists ? [{ id, active: true, url: target.url }] : [] }] }),
    closeTab: async () => { events.push('close'); exists = false; return { ok: true }; } }, BridgeError: B.BridgeError,
    NATIVE_TARGETS: new Map(), isMine: r => r?.ownerPid === T.OWNER_PID, pidAlive: () => true, ownerName: () => 'fixture',
    myEntry: async () => {}, reconcileOpenNavigation: async () => {}, forgetOpenNavigation: async () => {},
    LEDGER: { live: () => [], apply() {} }, recoveryLine: () => '', TAKEOVER_WHY: {}, taskKey: () => '',
    userClickedSince: async () => false, prepareNativeTarget: async () => ({ target, chromePid: 7, cgWindow: 9 }),
    inputAction: async (_label, prepare, run) => run({}, await prepare(null, null, ctx), ctx), process: { pid: process.pid } });
  vm.runInContext(production('nativeMutation', input) + '\n' + production('closeTabTool', input), c);
  let result, failure; try { result = await c.closeTabTool({ tab: id }); } catch (error) { failure = error; }
  return { result, failure, events, exists, id };
}
await test('actual closeTabTool and closeAgentTab permit original launcher owner under healthy same hold', async () => {
  const r = await closeFixture('healthy'); assert.equal(r.failure, undefined); assert.match(r.result, /已关闭/);
  assert.equal(r.events.filter(x => x === 'close').length, 1); assert.equal(r.exists, false);
});
await test('foreign owner and stale original hold are refused without a native close', async () => {
  for (const kind of ['foreign', 'stale']) { const r = await closeFixture(kind); assert.ok(r.failure); assert.equal(r.exists, true); assert.equal(r.events.includes('close'), false); }
});
await test('replacing registry OWNER_PID with worker PID reproduces the real front-tab refusal', async () => {
  const needle = 'verifiedOwnHold: { ownerPid: OWNER_PID,'; assert.ok(source.includes(needle));
  const r = await closeFixture('healthy', source.replace(needle, 'verifiedOwnHold: { ownerPid: process.pid,'));
  assert.equal(r.failure?.code, 'taken_over'); assert.equal(r.events.includes('close'), false);
});
// Native shape is produced by extracted Swift resultTarget in native-round2.test;
// here the real bridge + persistent caller checks consume that exact shape.
for (const op of ['activate', 'selectTab']) for (const current of ['https://fixture.test/', 'https://changed.test/', null]) {
  await test(`${op} current URL ${String(current)} has evidence-bounded ownership`, async () => {
    const id = 2000000 + passed, target = { tabId: id, windowId: 4, chromePid: 7, cgWindow: 9, url: current, title: null,
      bounds: { left: 0, top: 0, width: 800, height: 600 }, tabActive: true, minimized: false, windowIndex: 1 };
    await T.registerTab(id, 'https://fixture.test/', { windowId: 4 });
    const native = async intent => { assert.equal(intent.kind, op); assert.equal(intent.tabId, id); assert.equal(intent.windowId, null); return { ...target, ok: true }; };
    const receipt = op === 'activate' ? await B.activateChrome(id, null, { native }) : await B.selectTab(id, { native });
    assert.equal(receipt.url, current);
    const checked = await T.checkTabBeforeUse(id, { ...receipt, id });
    assert.equal(checked.takenOver, current === 'https://changed.test/');
    const rec = await T.getTab(id); assert.equal(!!rec.takenOver, current === 'https://changed.test/');
    if (current === null) assert.equal(T.closeVerdict(rec, receipt).reason, 'ownership_unverified');
  });
}
console.log(`${passed} native ownership round 2 groups; no browser/helper/UI calls.`);
