// Never blame a different Chrome window when the diagnostic sample is the target.
// FOCUS4 (contracts-batch4.md, G-d): an activation whose CG order sample says "not on top" is no longer refused here and
// takes no window-centre diagnostic sample; the destination (landing point, page focus) decides later. The completed
// activation is handed to acceptGeometryResult unchanged.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function bringOnScreen(');
const fn = source.slice(start, source.indexOf('\n}', start) + 2);
class BridgeError extends Error { constructor(code, text) { super(text); this.code = code; } }
async function notOnTop(windows) {
  const effects = [];
  const ctx = { check: async () => effects.push('guard'), native: async () => ({ ok: true }) };
  const activation = { tabId: 7, chromePid: 42, cgWindow: 100, targetOnTop: false, keyWindowIsTarget: false,
    bounds: { left: 0, top: 0, width: 1000, height: 800 } };
  const c = vm.createContext({ BridgeError, B: {
    activateChrome: async (tab, hint, options) => {
      assert.equal(tab, 7); assert.equal(hint, null); assert.equal(options.native, ctx.native);
      assert.deepEqual(effects, ['guard']); effects.push('activate');
      return activation;
    },
    cgevent: async () => { effects.push('diagnostic'); return { windows }; },
  }, acceptGeometryResult: (hint, a) => { effects.push('accept'); return a; } });
  vm.runInContext(fn, c);
  const out = await c.bringOnScreen(7, null, ctx);
  assert.equal(out, activation, 'the completed activation is returned, not refused');
  assert.deepEqual(effects, ['guard', 'activate', 'accept'], 'no diagnostic sample, no refusal');
}
for (const windows of [[{ id: 100, pid: 42, layer: 0, owner: 'Google Chrome' }], [{ id: 101, pid: 42, layer: 0, owner: 'Google Chrome' }],
  [{ id: 300, pid: 55, layer: 0, owner: 'Example App' }], []]) await notOnTop(windows);

// Native activate refusal (the path the activate transaction actually takes): the same error
// object is rethrown, described only from the helper's own sample, never resampled or titled.
async function nativeRefusal(reply, code = 'activate_unconfirmed') {
  const effects = [];
  const original = new BridgeError(code, `❌ 鼠标键盘助手报错：${code}`);
  Object.assign(original, { reply, inputDelivery: 'sent', noRetry: true });
  const ctx = { check: async () => effects.push('guard'), native: async () => ({ ok: true }) };
  const c = vm.createContext({ BridgeError, B: {
    activateChrome: async () => { effects.push('activate'); throw original; },
    cgevent: async () => { effects.push('diagnostic'); return { windows: [] }; },
  } });
  vm.runInContext(fn, c);
  let error;
  try { await c.bringOnScreen(7, null, ctx); } catch (e) { error = e; }
  assert.equal(error, original, 'the native refusal itself is rethrown');
  assert.deepEqual(effects, ['guard', 'activate'], 'no later diagnostic sample');
  assert.deepEqual([error.code, error.inputDelivery, error.noRetry, error.reply], [code, 'sent', true, reply]);
  return error.message;
}
const privateFacts = { title: 'Private page title', url: 'https://private.invalid/page' };
const covered = await nativeRefusal({ ...privateFacts, targetOnTop: false, keyWindowIsTarget: true, frontmost: 'Example App',
  frontmostPid: 55, focusBlocker: { owner: 'Example App', pid: 55, layer: 0, width: 640, height: 480 } });
assert.match(covered, /标签 7 /);
assert.match(covered, /最前面的 App：「Example App」/);
assert.match(covered, /挡在目标窗口前面的是「Example App」的窗口（pid 55，layer 0，640×480）/);
assert.match(covered, /没有发送点击或按键/);
assert.doesNotMatch(covered, /Private page title|private\.invalid|鼠标键盘助手报错/);
const chrome = await nativeRefusal({ targetOnTop: false, keyWindowIsTarget: true, frontmost: 'Google Chrome', frontmostPid: 42,
  focusBlocker: { owner: 'Google Chrome', pid: 42, layer: 0, width: 800, height: 600 } });
assert.match(chrome, /最前面的 App：「Google Chrome」；挡在目标窗口前面的是「Google Chrome」的窗口（pid 42，layer 0，800×600）/);
const keyOnly = await nativeRefusal({ targetOnTop: true, keyWindowIsTarget: false, frontmost: 'Google Chrome', frontmostPid: 42, focusBlocker: null });
assert.match(keyOnly, /键盘焦点不在它上面/);
const sparse = await nativeRefusal({ targetOnTop: false });
assert.match(sparse, /最前面的 App：未知；没有找到挡在目标窗口前面的具体窗口/);
const odd = await nativeRefusal({ targetOnTop: false, frontmost: 'Evil\nApp', focusBlocker: { owner: 'A\u0007B', pid: 'x', layer: 0, width: null, height: 3 } });
assert.doesNotMatch(odd, /[\u0000-\u001f]/);
assert.match(odd, /「Evil App」.*「A B」的窗口（pid \?，layer 0，\?×3）/);
assert.equal(await nativeRefusal({ targetOnTop: false, frontmost: 'Example App' }, 'aborted'), '❌ 鼠标键盘助手报错：aborted',
  'other native errors keep their text');
// FOCUS4: a current helper refuses only a wrong active tab and says so; its sample's key/order facts are not the reason.
const tabOnly = await nativeRefusal({ targetOnTop: true, keyWindowIsTarget: false, frontmost: 'Google Chrome', frontmostPid: 42, focusBlocker: null,
  focusVerdict: 'tab_not_current', axWindowMissing: true });
assert.match(tabOnly, /标签 7 没有成为它所在窗口的当前标签/);
assert.match(tabOnly, /目标标签没有成为该窗口的当前标签/);
assert.doesNotMatch(tabOnly, /键盘焦点/);
console.log('4 not-on-top samples passed: no refusal, no diagnostic sample (FOCUS4)');
console.log('7 native activate refusal cases passed; same error object, no resample, no titles');
