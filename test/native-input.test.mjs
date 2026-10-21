// Offline native-boundary tests. No browser, native helper, filesystem runtime
// state or physical input is opened. Production functions run with strict fakes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BridgeError } from '../src/bridge.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness() {
  const calls = [];
  const token = 'a'.repeat(64);
  const prep = { chromePid: 50, cgWindow: 90, target: { tabId: 7 } };
  const standard = { ok: true, frontmost: true, windowMatches: true, nodeFound: true,
    documentToken: token, focusedDocumentToken: token, nativePopup: false,
    menuOpen: false, nativeMenuOpen: false, blocker: null };
  const cache = new Map([[7, { pid: 50, window: 90, documentToken: token, at: Date.now() }]]);
  const state = { next: [{ ...standard }], paused: false, menu: { known: true, menuOpen: false } };
  const c = vm.createContext({
    B: {
      axInput: async args => { calls.push(['ax', args]); return state.next.length > 1 ? state.next.shift() : state.next[0]; },
      axMenuState: async () => {
        calls.push(['cold']); state.onCold?.();
        if (state.menu instanceof Error) throw state.menu;
        return state.menu;
      },
      cgevent: async args => { calls.push(['input', args]); return { ok: true, postedInput: 1 }; },
    },
    BridgeError, Date, String, Number, Math, NATIVE_TARGETS: cache, NATIVE_TARGET_MS: 15000,
    TASK_HOLD: null, TASK_CANCELLED: null, BLOCKS: new Map(),
    pausedCheck: () => { if (state.paused) throw new BridgeError('paused_by_user', 'paused'); },
    cancelledError: () => new BridgeError('cancelled', 'cancelled'),
    taskCancelledError: () => new BridgeError('user_cancelled', 'cancelled by user'),
    taskKey: a => a.task || '', lockInfo: () => ({}),
    withInputLock: async (_label, fn) => { calls.push(['lock']); return { result: await fn() }; },
    persist: async () => { calls.push(['normal']); return 'ordinary key'; },
  });
  vm.runInContext(['refuseNativeSelect', 'rememberNativeTarget', 'guardNativeTarget', 'recoverNativeMenu', 'pressKeyTool']
    .map(productionFunction).join('\n'), c);
  return { c, prep, state, standard, cache, calls };
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

await check('native popup in a cross-origin or closed-shadow visual target is refused', async () => {
  const h = harness();
  h.state.next = [{ ...h.standard, nativePopup: true, roles: ['AXPopUpButton', 'AXWebArea'] }];
  await assert.rejects(h.c.guardNativeTarget(h.prep, { x: 20, y: 40 }), e => e.code === 'use_select_option');
  assert.equal(h.calls.filter(x => x[0] === 'input').length, 0);
});
await check('ordinary controls retain visual input capability across DOM boundaries', async () => {
  const h = harness();
  for (const role of ['AXButton', 'AXTextField', 'AXComboBox', 'AXIncrementor']) {
    h.state.next = [{ ...h.standard, roles: [role, 'AXWebArea'] }];
    await h.c.guardNativeTarget(h.prep, { x: 20, y: 40 });
  }
  assert.equal(h.cache.get(7).documentToken, h.standard.documentToken);
});
await check('occlusion names the blocking application without titles or page content', async () => {
  const h = harness();
  h.state.next = [{ ...h.standard, blocker: { appName: 'ChatGPT', pid: 800 } }];
  await assert.rejects(h.c.guardNativeTarget(h.prep, { x: 20, y: 40 }),
    e => e.code === 'target_covered' && /ChatGPT/.test(e.message) && /移开/.test(e.message));
});
await check('native recovery sends exactly one Escape and makes no Apple Events even for times=20', async () => {
  const h = harness();
  h.state.next = [{ ...h.standard, menuOpen: true, nativeMenuOpen: true }, { ...h.standard }];
  const result = await h.c.pressKeyTool({ tab: 7, key: 'escape', times: 20 });
  assert.match(result, /确认原生菜单关闭/);
  assert.deepEqual(h.calls.map(x => x[0]), ['lock', 'ax', 'input', 'ax']);
  assert.equal(h.calls[2][1][0], 'escape-menu');
  assert.equal(h.cache.size, 0);
});
await check('no menu uses the ordinary key path only after cold native inspection', async () => {
  const h = harness();
  assert.equal(await h.c.pressKeyTool({ tab: 7, key: 'escape' }), 'ordinary key');
  assert.deepEqual(h.calls.map(x => x[0]), ['lock', 'ax', 'normal']);
});
await check('missing/expired identity with a menu, or changed page identity, never falls through to Apple Events', async () => {
  for (const kind of ['missing', 'expired', 'changed', 'wrongwindow', 'background']) {
    const h = harness();
    if (kind === 'missing') h.cache.clear();
    if (kind === 'expired') h.cache.get(7).at -= 20000;
    h.state.menu = { known: true, menuOpen: true };
    if (kind === 'changed') h.state.next[0].focusedDocumentToken = 'b'.repeat(64);
    if (kind === 'wrongwindow') h.state.next[0].windowMatches = false;
    if (kind === 'background') h.state.next[0].frontmost = false;
    await assert.rejects(h.c.pressKeyTool({ tab: 7, key: 'escape' }), e => e.code === 'native_recovery_unavailable');
    assert.equal(h.calls.some(x => ['input', 'normal'].includes(x[0])), false);
  }
});
await check('without a fresh mapping, a proven menu-free frontmost Chrome permits ordinary Escape', async () => {
  for (const kind of ['missing', 'expired', 'hold']) {
    const h = harness();
    if (kind === 'missing') h.cache.clear();
    if (kind === 'expired') h.cache.get(7).at -= 20000;
    if (kind === 'hold') h.c.TASK_HOLD = {};
    assert.equal(await h.c.pressKeyTool({ tab: 7, key: 'escape' }), 'ordinary key');
    assert.deepEqual(h.calls.map(x => x[0]), ['cold', 'normal']);
  }
});
await check('unknown, malformed or failed cold menu evidence never sends Escape or enters the ordinary path', async () => {
  for (const evidence of [null, {}, { known: false }, { known: true }, Error('AX unavailable')]) {
    const h = harness(); h.cache.clear(); h.state.menu = evidence;
    await assert.rejects(h.c.pressKeyTool({ tab: 7, key: 'escape' }), e => e.code === 'native_recovery_unavailable');
    assert.deepEqual(h.calls.map(x => x[0]), ['cold']);
  }
});
await check('pause and cancellation arriving during a cold inspection are rechecked before normal input', async () => {
  for (const kind of ['paused', 'signal']) {
    const h = harness(), signal = { aborted: false };
    h.cache.clear();
    h.state.onCold = () => { if (kind === 'paused') h.state.paused = true; else signal.aborted = true; };
    await assert.rejects(h.c.pressKeyTool({ tab: 7, key: 'escape' }, { signal }));
    assert.deepEqual(h.calls.map(x => x[0]), ['cold']);
  }
});
await check('website blocks, user cancellation, pause and cancelled calls remain authoritative', async () => {
  for (const kind of ['blocked', 'cancelled', 'paused', 'signal']) {
    const h = harness();
    if (kind === 'blocked') h.c.BLOCKS.set(7, { kind: 'captcha' });
    if (kind === 'cancelled') h.c.TASK_CANCELLED = 'task';
    if (kind === 'paused') h.state.paused = true;
    await assert.rejects(h.c.pressKeyTool({ tab: 7, key: 'escape', task: 'task' },
      { signal: kind === 'signal' ? { aborted: true } : null }));
    assert.equal(h.calls.length, 0);
  }
});
await check('generic ARIA menus and an existing retained input hold cannot trigger native recovery', async () => {
  for (const kind of ['aria', 'hold']) {
    const h = harness();
    if (kind === 'hold') { h.c.TASK_HOLD = {}; h.state.menu = { known: true, menuOpen: true }; }
    else h.state.next = [{ ...h.standard, menuOpen: true, nativeMenuOpen: false }];
    await assert.rejects(h.c.pressKeyTool({ tab: 7, key: 'escape' }), e => e.code === 'native_recovery_unavailable');
    assert.equal(h.calls.some(x => x[0] === 'input'), false);
  }
});
await check('a failed native confirmation reports uncertainty without retrying', async () => {
  const h = harness();
  h.state.next = [{ ...h.standard, menuOpen: true, nativeMenuOpen: true }];
  assert.match(await h.c.pressKeyTool({ tab: 7, key: 'escape' }), /尚未确认同一页面的菜单关闭/);
  assert.equal(h.calls.filter(x => x[0] === 'input').length, 1);
});
await check('switching page during readback is not claimed as a verified menu dismissal', async () => {
  const h = harness();
  h.state.next = [{ ...h.standard, menuOpen: true, nativeMenuOpen: true },
    { ...h.standard, focusedDocumentToken: 'b'.repeat(64) }];
  assert.match(await h.c.pressKeyTool({ tab: 7, key: 'escape' }), /尚未确认同一页面的菜单关闭/);
  assert.equal(h.calls.filter(x => x[0] === 'input').length, 1);
});

console.log(`native-input: ${passed} passed`);
