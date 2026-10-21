/* Offline regression for macOS native select menus. No browser, helper, or user data.
 * Run the production action functions with their input/session boundary replaced;
 * the page guard itself runs against real jsdom documents. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { pageScript, BridgeError } from '../src/bridge.js';
import { viewportOrigin, toScreen, rectToScreenRect } from '../src/coords.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) return '';
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n${e.stack}`); }
}

const bounds = { left: 100, top: 60, width: 1000, height: 800 };
function harness(html = '<select id="sel"><option>A</option><option>B</option></select><button id="button">OK</button>') {
  const w = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only' }).window;
  for (const [key, value] of Object.entries({ innerWidth: 1000, innerHeight: 700, outerWidth: 1000, outerHeight: 800 })) {
    Object.defineProperty(w, key, { value, configurable: true });
  }
  const sel = w.document.querySelector('select');
  w.__chromeBridge = { markers: [null, sel], url: w.location.href };
  w.document.elementFromPoint = () => sel;
  const posted = [], steps = [];
  const target = { tabId: 7, bounds };
  const loc = { tag: 'select', bounds, view: { innerWidth: 1000, innerHeight: 700, outerWidth: 1000, outerHeight: 800 },
    rect: { x: 20, y: 20, width: 200, height: 40 }, visible: { x: 20, y: 20, width: 200, height: 40 },
    aim: { x: 100, y: 40 }, hitOk: true, text: 'A B', url: w.location.href };
  const ctx = { step: s => steps.push(s), mark() {}, observe() {}, panel() {} };
  const B = {
    pageScript,
    chromeInfo: async () => target,
    evalInPage: async src => ({ ...JSON.parse(w.eval(src)), bounds }),
    listTabs: async () => [],
  };
  const c = vm.createContext({
    B, BridgeError, Date, Number, String, Math, sleep: async () => {},
    SHOTS: new Map([[7, { width: 1000, height: 800, rect: { x: 100, y: 60, w: 1000, h: 800 }, at: Date.now() }]]),
    SHOT_FRESH_MS: 300000, PRE_LOC_FRESH_MS: 1500,
    post: async (_s, _ctx, _kind, req) => { posted.push(req); return { landed: req.aim || { x: 120, y: 180 } }; },
    persist: fn => fn({}),
    inputAction: async (_label, prepFn, action, opts) => {
      const pre = opts.preflight ? await opts.preflight() : null;
      return action({}, await prepFn(pre), ctx, pre);
    },
    prepareActivate: async () => ({ target }),
    clickPreflight: async () => ({ tab: 7, loc, at: Date.now() }),
    activationHint: () => null,
    targetLine: () => 'tab 7', veilFor: () => ({}), taskKey: () => '',
    locateTarget: async () => loc, originFor: x => viewportOrigin(x.bounds, x.view),
    scrollToTarget: async (_s, _ctx, _marker, _tab, l) => ({ loc: l, done: true }),
    planScrollStep: () => ({ done: true }), rectToScreenRect, toScreen,
    armAck: async () => 'ack', waitAck: async () => ({ seen: true }),
    clip: s => s, screenReady: null,
    guardNativeTarget: async () => ({}), recoverNativeMenu: async () => null,
  });
  vm.runInContext(source.match(/const SELECT_ERRORS = \{[\s\S]*?\n\};/)[0], c);
  const names = ['refuseNativeSelect', 'guardNativeSelect', 'clickDeliver', 'click', 'clickAt', 'pressKeyTool', 'screenReady', 'selectInSession'];
  vm.runInContext(names.map(productionFunction).join('\n'), c);
  return { w, sel, c, loc, posted, B, ctx, close: () => w.close() };
}
const rejectsSelect = p => assert.rejects(p, e => e.code === 'use_select_option' && /select_option/.test(e.message));

await check('coordinate clicks refuse native selects before any mouse event', async () => {
  const h = harness();
  try { await rejectsSelect(h.c.clickAt({ x: 50, y: 150, tab: 7 })); assert.equal(h.posted.length, 0); }
  finally { h.close(); }
});

await check('coordinate clicks on a label cannot bypass the select guard', async () => {
  const h = harness('<label for="sel"><span id="label">Plan</span></label><select id="sel"><option>A</option></select>');
  h.w.document.elementFromPoint = () => h.w.document.querySelector('#label');
  try { await rejectsSelect(h.c.clickAt({ x: 50, y: 150, tab: 7 })); assert.equal(h.posted.length, 0); }
  finally { h.close(); }
});

await check('clickDeliver also guards the click performed by type_text', async () => {
  const h = harness();
  try { await rejectsSelect(h.c.clickDeliver({}, { target: { tabId: 7 } }, h.ctx, { marker: 1 })); assert.equal(h.posted.length, 0); }
  finally { h.close(); }
});

await check('label marker clicks cannot open the native select menu', async () => {
  const h = harness('<label for="sel">Plan</label><select id="sel"><option>A</option></select>');
  h.loc.tag = 'label';
  h.w.__chromeBridge.markers[1] = h.w.document.querySelector('label');
  try { await rejectsSelect(h.c.click({ marker: 1, tab: 7 })); assert.equal(h.posted.length, 0); }
  finally { h.close(); }
});

await check('menu-opening keys on focused selects are refused before keydown', async () => {
  const h = harness();
  h.sel.focus();
  try {
    for (const key of ['space', 'enter', 'up', 'down']) await rejectsSelect(h.c.pressKeyTool({ key, tab: 7 }));
    assert.equal(h.posted.length, 0);
  } finally { h.close(); }
});

await check('ordinary buttons, custom dropdowns, and leaving a select retain real input', async () => {
  const h = harness('<select id="sel"><option>A</option></select><button id="button" role="combobox">Custom</button>');
  h.w.document.elementFromPoint = () => h.w.document.querySelector('#button');
  try {
    await h.c.clickAt({ x: 50, y: 150, tab: 7 });
    h.w.document.querySelector('#button').focus();
    await h.c.pressKeyTool({ key: 'enter', tab: 7 });
    h.sel.focus();
    await h.c.pressKeyTool({ key: 'escape', tab: 7 });
    await h.c.pressKeyTool({ key: 'tab', tab: 7 });
    assert.deepEqual(h.posted.map(x => x.op), ['click', 'key', 'key', 'key']);
  } finally { h.close(); }
});

await check('inline listboxes retain coordinate clicks and arrow keys without a system popup', async () => {
  for (const attr of ['multiple', 'size="3"']) {
    const h = harness(`<select ${attr}><option>A</option><option>B</option></select>`);
    try {
      await h.c.clickAt({ x: 50, y: 150, tab: 7 });
      h.sel.focus();
      await h.c.pressKeyTool({ key: 'down', tab: 7 });
      await h.c.click({ marker: 1, tab: 7 });
      assert.deepEqual(h.posted.map(x => x.op), ['click', 'key', 'click']);
    } finally { h.close(); }
  }
});

await check('coordinate and focus guards descend into same-origin frames', async () => {
  const h = harness('<iframe></iframe>');
  const frame = h.w.document.querySelector('iframe'), doc = frame.contentDocument;
  doc.body.innerHTML = '<select><option>A</option></select>';
  const sel = doc.querySelector('select');
  h.w.document.elementFromPoint = () => frame;
  frame.getBoundingClientRect = () => ({ left: 10, top: 10, width: 400, height: 300 });
  Object.defineProperty(frame, 'offsetWidth', { value: 200 });
  Object.defineProperty(frame, 'offsetHeight', { value: 150 });
  let hit = null;
  doc.elementFromPoint = (x, y) => { hit = { x, y }; return sel; };
  try {
    await rejectsSelect(h.c.clickAt({ x: 50, y: 150, tab: 7 }));
    assert.ok(Math.abs(hit.x - 20) < 2 && Math.abs(hit.y - 20) < 2, JSON.stringify(hit));
    sel.focus();
    await rejectsSelect(h.c.pressKeyTool({ key: 'space', tab: 7 }));
    assert.equal(h.posted.length, 0);
  } finally { h.close(); }
});

await check('coordinate and focus guards descend into open shadow roots', async () => {
  const h = harness('<div id="host"></div>');
  const host = h.w.document.querySelector('#host'), root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<select><option>A</option></select>';
  h.w.document.elementFromPoint = () => host;
  root.elementFromPoint = () => root.querySelector('select');
  try {
    await rejectsSelect(h.c.clickAt({ x: 50, y: 150, tab: 7 }));
    root.querySelector('select').focus();
    await rejectsSelect(h.c.pressKeyTool({ key: 'space', tab: 7 }));
    assert.equal(h.posted.length, 0);
  } finally { h.close(); }
});

await check('coordinate guard maps screen points through page zoom before hit testing', async () => {
  const h = harness();
  Object.defineProperty(h.w, 'outerWidth', { value: 500 });
  Object.defineProperty(h.w, 'innerWidth', { value: 500 });
  Object.defineProperty(h.w, 'outerHeight', { value: 400 });
  Object.defineProperty(h.w, 'innerHeight', { value: 350 });
  let point = null;
  h.w.document.elementFromPoint = (x, y) => { point = { x, y }; return h.sel; };
  try {
    await rejectsSelect(h.c.clickAt({ x: 50, y: 150, tab: 7 }));
    assert.ok(Math.abs(point.x - 25) < 2 && Math.abs(point.y - 25) < 2, JSON.stringify(point));
  } finally { h.close(); }
});

await check('a button inside a label still activates the button', async () => {
  const h = harness('<label for="sel"><button>Help</button></label><select id="sel"><option>A</option></select>');
  h.w.document.elementFromPoint = () => h.w.document.querySelector('button');
  try { await h.c.clickAt({ x: 50, y: 150, tab: 7 }); assert.equal(h.posted.length, 1); }
  finally { h.close(); }
});

await check('read_page keeps a directly usable select marker inside its label or clickable wrapper', async () => {
  for (const wrapper of ['label', 'div role="button"']) {
    const tag = wrapper.split(' ')[0];
    const h = harness(`<${wrapper}>Plan <select><option>A</option><option>B</option></select></${tag}>`);
    h.w.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, top: 10, left: 10, width: 200, height: 40, right: 210, bottom: 50 });
    h.w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
    try {
      const read = JSON.parse(h.w.eval(await pageScript('read', { READ: { full: true } })));
      const marker = h.w.__chromeBridge.markers.indexOf(h.sel);
      assert.ok(marker > 0, `missing select marker inside ${wrapper}`);
      assert.match(read.text, new RegExp(`\\[${marker}\\] select`));
      const plan = JSON.parse(h.w.eval(await pageScript('select', { MARKER: marker, OPTION: 'B', MODE: 'plan' })));
      assert.equal(plan.fail, undefined);
      assert.equal(plan.text, 'B');
    } finally { h.close(); }
  }
});

await check('read_page still collapses a labelled checkbox to its label marker', async () => {
  const h = harness('<label>Accept<input type="checkbox"></label>');
  h.w.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, top: 10, left: 10, width: 200, height: 40, right: 210, bottom: 50 });
  h.w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  try {
    h.w.eval(await pageScript('read', { READ: { full: true } }));
    assert.deepEqual(Array.from(h.w.__chromeBridge.markers).slice(1).map(el => el.tagName), ['LABEL']);
  } finally { h.close(); }
});

await check('disabled select, option, optgroup and fieldset are refused before key input', async () => {
  for (const html of [
    '<select disabled><option>A</option><option>B</option></select>',
    '<select><option>A</option><option disabled>B</option></select>',
    '<select><option>A</option><optgroup disabled><option>B</option></optgroup></select>',
    '<fieldset disabled><select><option>A</option><option>B</option></select></fieldset>',
  ]) {
    const h = harness(html);
    let events = 0;
    h.sel.addEventListener('input', () => events++);
    h.sel.addEventListener('change', () => events++);
    try {
      const result = JSON.parse(h.w.eval(await pageScript('select', { MARKER: 1, OPTION: 'B', MODE: 'plan' })));
      assert.equal(result.fail, 'disabled', html);
      assert.equal(h.sel.selectedIndex, 0);
      assert.equal(events, 0);
    } finally { h.close(); }
  }
});

await check('a select in the first legend of a disabled fieldset stays usable', async () => {
  const h = harness('<fieldset disabled><legend><select><option>A</option><option>B</option></select></legend></fieldset>');
  try {
    const plan = JSON.parse(h.w.eval(await pageScript('select', { MARKER: 1, OPTION: 'B', MODE: 'plan' })));
    assert.equal(plan.fail, undefined);
    assert.equal(plan.text, 'B');
  } finally { h.close(); }
});

await check('repeated-character type-ahead skips disabled options and optgroups', async () => {
  const h = harness('<select><option>Start</option><option disabled>i</option><optgroup disabled><option>ii</option></optgroup><option>iii</option></select>');
  try {
    const plan = JSON.parse(h.w.eval(await pageScript('select', { MARKER: 1, OPTION: 'iii', MODE: 'plan' })));
    assert.equal(plan.typeahead, 'i');
    assert.equal(plan.index, 3);
  } finally { h.close(); }
});

await check('legacy set mode refuses before focus, value mutation, or input/change events', async () => {
  for (const disabled of ['', ' disabled']) {
    const h = harness(`<select${disabled}><option>A</option><option>B</option></select><button>Keep focus</button>`);
    const events = [];
    h.sel.addEventListener('input', () => events.push('input'));
    h.sel.addEventListener('change', () => events.push('change'));
    const button = h.w.document.querySelector('button');
    button.focus();
    try {
      const result = JSON.parse(h.w.eval(await pageScript('select', { MARKER: 1, OPTION: 'B', MODE: 'set' })));
      assert.equal(result.fail, 'bad_mode');
      assert.equal(h.sel.value, 'A');
      assert.deepEqual(events, []);
      assert.equal(h.w.document.activeElement, button);
    } finally { h.close(); }
  }
});

await check('failed keyboard selection never invokes set or emits synthetic input/change', async () => {
  const h = harness(), modes = [], events = [];
  h.w.document.hasFocus = () => true;
  h.sel.addEventListener('input', () => events.push('input'));
  h.sel.addEventListener('change', () => events.push('change'));
  h.B.pageScript = async (name, vars) => { modes.push(vars.MODE); return pageScript(name, vars); };
  try {
    await assert.rejects(h.c.selectInSession({}, { target: { tabId: 7 } }, h.ctx, { marker: 1, option: 'B' }),
      e => e.code === 'select_failed' && /没有改用网页脚本/.test(e.message));
    assert.deepEqual(modes, ['plan', 'check']);
    assert.equal(h.posted.length, 1);
    assert.equal(h.posted[0].op, 'type');
    assert.equal(h.posted[0].text, 'b');
    assert.equal(h.sel.value, 'A');
    assert.deepEqual(events, []);
  } finally { h.close(); }
});

await check('keyboard selection succeeds only after the requested option is read back', async () => {
  const h = harness(), modes = [];
  h.w.document.hasFocus = () => true;
  h.B.pageScript = async (name, vars) => { modes.push(vars.MODE); return pageScript(name, vars); };
  h.c.post = async (_s, _ctx, _kind, req) => {
    h.posted.push(req);
    // This fake models the browser applying the posted key, not a production DOM fallback.
    h.sel.selectedIndex = 1;
    return {};
  };
  try {
    const result = await h.c.selectInSession({}, { target: { tabId: 7 } }, h.ctx, { marker: 1, option: 'B' });
    assert.match(result, /已选「B」（用键盘选中/);
    assert.deepEqual(modes, ['plan', 'check']);
    assert.equal(h.posted.length, 1);
    assert.equal(h.posted[0].op, 'type');
    assert.equal(h.sel.value, 'B');
  } finally { h.close(); }
});

await check('unsupported type-ahead fails without posting keys or changing the selection', async () => {
  const h = harness('<select><option>A</option><option>中文</option></select>'), events = [];
  h.w.document.hasFocus = () => true;
  h.sel.addEventListener('input', () => events.push('input'));
  h.sel.addEventListener('change', () => events.push('change'));
  try {
    await assert.rejects(h.c.selectInSession({}, { target: { tabId: 7 } }, h.ctx, { marker: 1, option: '中文' }),
      e => e.code === 'select_failed');
    assert.equal(h.posted.length, 0);
    assert.equal(h.sel.value, 'A');
    assert.deepEqual(events, []);
  } finally { h.close(); }
});

await check('select errors never recommend click_at or press_key as a bypass', async () => {
  const decl = source.match(/const FALLBACK_CODES = new Set\([\s\S]*?\);/)[0];
  const codes = vm.runInNewContext(`${decl}\nFALLBACK_CODES`);
  for (const code of ['use_select_option', 'bad_select', 'select_failed']) assert.equal(codes.has(code), false, code);
});

await check('an unreadable display state fails closed; a locked screen does not promise an automatic retry', async () => {
  const h = harness();
  try {
    h.B.ensureScreenAwake = async () => { throw new Error('display probe unavailable'); };
    await assert.rejects(h.c.screenReady(), e => e.code === 'screen_state_unknown');
    h.B.ensureScreenAwake = async () => ({ locked: true, displays: 1 });
    await assert.rejects(h.c.screenReady(), e => e.code === 'screen_locked' && !/自动接着/.test(e.message));
    h.B.ensureScreenAwake = async () => ({ locked: false, displays: 1 });
    assert.equal(await h.c.screenReady(), '');
  } finally { h.close(); }
});

console.log(`\nNative select guards: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
