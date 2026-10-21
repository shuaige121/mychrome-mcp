/* Offline tests for the injected page scripts (src/page/read.js, locate.js, after.js).
 *
 * Chrome's "Allow JavaScript from Apple Events" is off on this machine, so the
 * real browser path could not be exercised. jsdom gives the scripts a real DOM
 * and real CSS cascade; what it does NOT give is layout, so getBoundingClientRect
 * is stubbed from data-rect attributes on the fixture. That covers the traversal,
 * marker numbering, nesting rules, the index format and truncation — everything
 * except real geometry.
 *
 * Run: node test/page.test.mjs
 */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

// These check the built-in timing defaults; the user's recorded habits (test/habits.test.mjs) stay out.
process.env.CHROME_BRIDGE_HABITS = 'off';

/**
 * Dispatch an event the page sees as trusted (isTrusted true), the way
 * Chrome delivers a real CGEvent: jsdom's own dispatchEvent always clears it.
 * jsdom does not export this, so its internal wrapper utils are loaded by path.
 */
const jsdomUtils = createRequire(import.meta.url)(
  path.join(path.dirname(createRequire(import.meta.url).resolve('jsdom')), 'generated/idl/utils.js'));
function dispatchTrusted(target, event) {
  const ev = jsdomUtils.implForWrapper(event);
  ev.isTrusted = true;
  return jsdomUtils.implForWrapper(target)._dispatch(ev);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = await readFile(path.join(ROOT, 'src/page/read.js'), 'utf8');
const locateSrc = await readFile(path.join(ROOT, 'src/page/locate.js'), 'utf8');
const afterSrc = await readFile(path.join(ROOT, 'src/page/after.js'), 'utf8');
const ackSrc = await readFile(path.join(ROOT, 'src/page/ack.js'), 'utf8');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

/** Build a jsdom window with a fake layout engine driven by data-rect. */
function makeDom(html) {
  const dom = new JSDOM(`<!doctype html><html><head><title>测试页面</title></head><body>${html}</body></html>`, {
    url: 'https://example.test/page?a=1',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  return installLayout(dom.window);
}

/** A whole fixture page from test/fixtures, its own scripts running, with the same fake layout. */
function fixtureDom(html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  return installLayout(dom.window);
}

function installLayout(w) {
  // data-rect="x,y,w,h"; default 10,10,120,24; "0" means zero-sized (invisible).
  // Like a real engine, anything inside a display:none subtree generates no box
  // at all — that is what makes the ancestor-hidden test meaningful.
  w.Element.prototype.getBoundingClientRect = function () {
    for (let a = this; a && a.nodeType === 1; a = a.parentElement) {
      if (w.getComputedStyle(a).display === 'none') {
        return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0,
                 toJSON() { return this; } };
      }
    }
    const spec = this.getAttribute('data-rect');
    let x = 10, y = 10, width = 120, height = 24;
    if (spec === '0') { x = 0; y = 0; width = 0; height = 0; }
    else if (spec) { [x, y, width, height] = spec.split(',').map(Number); }
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height,
             toJSON() { return this; } };
  };
  w.Element.prototype.getClientRects = function () {
    const r = this.getBoundingClientRect();
    return (r.width === 0 && r.height === 0) ? [] : [r];
  };
  w.document.elementFromPoint = () => null;
  Object.defineProperty(w, 'innerWidth', { value: 1400, configurable: true });
  Object.defineProperty(w, 'innerHeight', { value: 812, configurable: true });
  Object.defineProperty(w, 'outerWidth', { value: 1400, configurable: true });
  Object.defineProperty(w, 'outerHeight', { value: 900, configurable: true });
  Object.defineProperty(w, 'screenX', { value: 100, configurable: true });
  Object.defineProperty(w, 'screenY', { value: 60, configurable: true });
  Object.defineProperty(w, 'devicePixelRatio', { value: 2, configurable: true });
  return w;
}

/** Run read.js the way src/index.js does (bridge.pageScript fills __READ__): {} = this screen + outline. */
function readScript(req = {}) { return readSrc.replaceAll('__READ__', () => JSON.stringify(req)); }
function runRead(w, req = {}) { return JSON.parse(w.eval(readScript(req))); }
/** The whole page, as read_page was before the outline (the round 1–6 tests below assert it unchanged). */
const FULL = { full: true };

console.log('src/page/read.js (jsdom, layout stubbed)');

const FIXTURE = `
  <h1>商品详情</h1>
  <p>这是一段普通正文，不应该带编号。</p>
  <a href="/home">返回首页</a>
  <button id="cart">加入购物车</button>
  <div style="display:none"><a href="/hidden">隐藏链接</a></div>
  <a href="/zero" data-rect="0">零尺寸链接</a>
  <span style="visibility:hidden"><button>看不见的按钮</button></span>
  <label for="qty">数量</label>
  <input id="qty" type="text" placeholder="请输入数量">
  <textarea placeholder="备注"></textarea>
  <select><option>红色</option><option selected>蓝色</option></select>
  <input type="submit" value="立即购买">
  <input type="hidden" name="csrf" value="xyz">
  <div role="button">收藏</div>
  <div onclick="void 0">分享</div>
  <a href="/outer">外层链接 <button>内层按钮</button></a>
  <a href="/withfield">外层链接带输入框 <input type="text" placeholder="内层输入"></a>
  <a>没有 href 的锚点</a>
`;

t('a server from before the outline (3a25299) loads read.js with __READ__ left in: the whole page, no ReferenceError', () => {
  // such a server reads src/page/*.js from disk on every call, so it meets this file right after a merge
  const old = JSON.parse(makeDom(FIXTURE).eval(readSrc));
  assert.equal(old.ok, true);
  assert.deepEqual(old, runRead(makeDom(FIXTURE), FULL));
});

t('a password field is never named by what it holds (no placeholder or label: its type, not the password)', () => {
  const w = makeDom('<form><input id="u" type="text"><input id="p" type="password"></form>');
  w.document.querySelector('#u').value = 'alice';
  w.document.querySelector('#p').value = 'hunter2-secret';
  for (const req of [{}, FULL, { query: 'password' }]) {
    const out = JSON.stringify(runRead(w, req));
    assert.doesNotMatch(out, /hunter2/, JSON.stringify(req));
  }
  assert.match(runRead(w, FULL).text, /password/);
});

t('marker numbers follow document order and skip invisible elements', () => {
  const w = makeDom(FIXTURE);
  const r = runRead(w, FULL);
  assert.equal(r.ok, true);
  const reg = w.__chromeBridge.markers;
  // spread first: reg is an Array from the jsdom realm, whose prototype is not
  // Node's, and deepStrictEqual compares prototypes.
  const tags = [...reg].slice(1).map(e => e.tagName.toLowerCase() +
    (e.getAttribute('href') ? `[${e.getAttribute('href')}]` : '') +
    (e.tagName === 'INPUT' ? `[${e.type}]` : ''));
  assert.deepEqual(tags, [
    'a[/home]', 'button', 'label', 'input[text]', 'textarea', 'select',
    'input[submit]', 'div', 'div', 'a[/outer]', 'a[/withfield]', 'input[text]'
  ]);
});

t('display:none, visibility:hidden, zero-rect and type=hidden are all excluded', () => {
  const w = makeDom(FIXTURE);
  runRead(w, FULL);
  const hrefs = w.__chromeBridge.markers.slice(1).map(e => e.getAttribute('href')).filter(Boolean);
  assert.ok(!hrefs.includes('/hidden'), 'display:none link leaked in');
  assert.ok(!hrefs.includes('/zero'), 'zero-sized link leaked in');
  const texts = w.__chromeBridge.markers.slice(1).map(e => e.textContent);
  assert.ok(!texts.some(x => x.includes('看不见的按钮')), 'visibility:hidden button leaked in');
  assert.ok(!w.__chromeBridge.markers.some(e => e && e.type === 'hidden'), 'input[type=hidden] leaked in');
  assert.ok(!texts.some(x => x.includes('没有 href 的锚点')), 'bare <a> leaked in');
});

t('a clickable inside a clickable collapses to the outer one...', () => {
  const w = makeDom(FIXTURE);
  runRead(w, FULL);
  const inner = w.document.querySelector('a[href="/outer"] button');
  assert.ok(!w.__chromeBridge.markers.includes(inner), 'nested <button> should not get its own marker');
});

t('...but a real form field nested in a link keeps its own marker', () => {
  const w = makeDom(FIXTURE);
  runRead(w, FULL);
  const nestedField = w.document.querySelector('a[href="/withfield"] input');
  assert.ok(w.__chromeBridge.markers.includes(nestedField), 'nested text input must stay addressable');
});

t('markers are inlined in the text next to their own label', () => {
  const w = makeDom(FIXTURE);
  const r = runRead(w, FULL);
  const n = w.__chromeBridge.markers.indexOf(w.document.getElementById('cart'));
  assert.match(r.text, new RegExp(`\\[${n}\\]\\s*加入购物车`));
  assert.match(r.text, /商品详情/);
  assert.match(r.text, /这是一段普通正文/);
});

t('form controls are described inline rather than left blank', () => {
  const w = makeDom(FIXTURE);
  const r = runRead(w, FULL);
  assert.match(r.text, /输入框: 请输入数量/);
  assert.match(r.text, /输入框: 备注/);
  assert.match(r.text, /下拉框: 蓝色/);
});

t('the index lists tag, 60-char text, and flags text fields', () => {
  const w = makeDom(FIXTURE);
  const r = runRead(w, FULL);
  assert.match(r.text, /=== 可点击元素索引（共 12 个）===/);
  assert.match(r.text, /^\[1\] a \| 返回首页$/m);
  assert.match(r.text, /^\[2\] button \| 加入购物车$/m);
  assert.match(r.text, /^\[4\] input\[text\] \| 请输入数量 \| 文本输入框$/m);
  assert.match(r.text, /^\[5\] textarea \| 备注 \| 文本输入框$/m);
  assert.match(r.text, /^\[6\] select \| 蓝色$/m);
  assert.match(r.text, /^\[8\] div\(role=button\) \| 收藏$/m);
  assert.match(r.text, /^\[7\] input\[submit\] \| 立即购买$/m);
  // Non-text-field rows must NOT be flagged.
  assert.doesNotMatch(r.text, /加入购物车 \| 文本输入框/);
  assert.doesNotMatch(r.text, /立即购买 \| 文本输入框/);
});

t('index text is trimmed to 60 characters with an ellipsis', () => {
  const long = 'A'.repeat(200);
  const w = makeDom(`<button>${long}</button>`);
  const r = runRead(w, FULL);
  const line = r.text.split('\n').find(l => l.startsWith('[1] button'));
  const label = line.split('| ')[1];
  assert.equal(label.length, 61, `expected 60 chars + ellipsis, got ${label.length}`);
  assert.ok(label.endsWith('…'));
});

t('text hidden by a zero-sized box does not leak into the body text', () => {
  const w = makeDom(FIXTURE);
  const r = runRead(w, FULL);
  assert.ok(!r.text.includes('零尺寸链接'), 'zero-box text leaked into the body');
  assert.ok(!r.text.includes('隐藏链接'), 'display:none text leaked into the body');
  assert.ok(!r.text.includes('看不见的按钮'), 'visibility:hidden text leaked into the body');
});

t('display:contents keeps its children visible', () => {
  const w = makeDom('<div style="display:contents"><button>包在 contents 里的按钮</button></div>');
  const r = runRead(w, FULL);
  assert.equal(r.count, 1);
  assert.ok(r.text.includes('包在 contents 里的按钮'), 'display:contents subtree was wrongly dropped');
});

t('no href ever appears in the output', () => {
  const w = makeDom(FIXTURE);
  const r = runRead(w, FULL);
  for (const h of ['/home', '/outer', '/withfield', '/zero']) {
    assert.ok(!r.text.includes(h), `href value ${h} leaked into output`);
  }
  // The page URL line at the top is intentional; nothing else may carry a link.
  const body = r.text.split('\n').slice(2).join('\n');
  assert.doesNotMatch(body, /https?:\/\//);
});

t('output is capped at ~12k characters and says so', () => {
  const filler = Array.from({ length: 400 }, (_, i) =>
    `<p>第 ${i} 段很长的正文内容，用来把页面撑到超过一万两千个字符的上限。</p>`).join('');
  const w = makeDom(filler + FIXTURE);
  const r = runRead(w, FULL);
  assert.ok(r.text.length <= 12000, `output ${r.text.length} chars exceeds the cap`);
  assert.match(r.text, /正文过长已截断/);
  // Truncating the body must not cost us the index.
  assert.match(r.text, /=== 可点击元素索引/);
});

t('a page with thousands of controls truncates the index, not the numbering', () => {
  const many = Array.from({ length: 900 }, (_, i) => `<button>按钮编号 ${i}</button>`).join('');
  const w = makeDom(many);
  const r = runRead(w, FULL);
  assert.equal(r.count, 900, 'every control must still get a number');
  assert.equal(w.__chromeBridge.markers.length, 901);
  assert.ok(r.text.length <= 12000);
  assert.match(r.text, /索引已截断/);
});

t('running twice is idempotent: same numbering, no DOM change', () => {
  const w = makeDom(FIXTURE);
  const before = w.document.body.innerHTML;
  const a = runRead(w, FULL);
  const b = runRead(w, FULL);
  assert.equal(a.text, b.text);
  assert.equal(a.count, b.count);
  assert.equal(w.document.body.innerHTML, before, 'read.js mutated the DOM');
});

t('empty page does not throw', () => {
  const w = makeDom('');
  const r = runRead(w, FULL);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
});

console.log('\nsrc/page/read.js — semantics: more targets, states, <select> options, modals, popups (round 6)');

const INDEX_HEAD = '=== 可点击元素索引';
const indexPart = (r) => r.text.slice(r.text.indexOf(INDEX_HEAD));
const bodyPart = (r) => r.text.slice(0, r.text.indexOf(INDEX_HEAD));
const regOf = (w) => [...w.__chromeBridge.markers].slice(1);
const idsOf = (w) => regOf(w).map(e => e.id || e.tagName.toLowerCase());
const mk = (w, sel) => w.__chromeBridge.markers.indexOf(w.document.querySelector(sel));
/** The index line of marker n (the index part only: body lines can start with [n] too). */
const lineOf = (r, n) => indexPart(r).split('\n').find(l => l.startsWith(`[${n}] `));
/** Marker numbers in the order the index lists them. */
const indexOrder = (r) => indexPart(r).split('\n').filter(l => /^\[\d+\] /.test(l)).map(l => Number(l.match(/^\[(\d+)\]/)[1]));
/** How many times each marker number appears in the body text. */
function bodyCounts(r) {
  const c = new Map();
  for (const m of bodyPart(r).matchAll(/\[(\d+)\]/g)) c.set(Number(m[1]), (c.get(Number(m[1])) || 0) + 1);
  return c;
}

t('goal1: role=combobox / treeitem / gridcell / menuitemradio and tabindex>=0 get markers; tabindex=-1 and focusable regions do not', () => {
  const w = makeDom(`
    <div id="cb" role="combobox">选择城市</div>
    <div role="tree"><div id="ti" role="treeitem">文件夹</div></div>
    <div role="grid"><div role="row"><div id="gc" role="gridcell">单元格</div></div></div>
    <div role="menu"><div id="mr" role="menuitemradio">按名称排序</div></div>
    <div id="t0" tabindex="0">可聚焦的卡片</div>
    <span id="t3" tabindex="3">正数 tabindex</span>
    <div id="tm" tabindex="-1">tabindex=-1</div>
    <div id="panel" role="tabpanel" tabindex="0">标签页面板正文</div>
    <section id="sec" tabindex="0">可滚动的区域</section>
    <ul id="lst" role="listbox" tabindex="0"></ul>`);
  const r = runRead(w, FULL);
  assert.deepEqual(idsOf(w), ['cb', 'ti', 'gc', 'mr', 't0', 't3']);
  assert.equal(lineOf(r, 1), '[1] div(role=combobox) | 选择城市');
  assert.equal(lineOf(r, 2), '[2] div(role=treeitem) | 文件夹');
  assert.equal(lineOf(r, 3), '[3] div(role=gridcell) | 单元格');
  assert.equal(lineOf(r, 4), '[4] div(role=menuitemradio) | 按名称排序');
  assert.equal(lineOf(r, 5), '[5] div | 可聚焦的卡片');
  assert.match(bodyPart(r), /\[6\] 正数 tabindex/);
});

t('goal1: a focusable wrapper around real controls is not a target; a combobox keeps its own options, a tree its child items', () => {
  const w = makeDom(`
    <div id="wrap" tabindex="0"><button id="inner">内部按钮</button></div>
    <div id="cb" role="combobox" aria-expanded="true">
      <input id="cbi" type="text" placeholder="城市">
      <ul role="listbox" tabindex="0"><li id="o1" role="option">新加坡</li><li id="o2" role="option">香港</li></ul>
    </div>
    <ul role="tree"><li id="p" role="treeitem" aria-expanded="true">父节点
      <ul role="group"><li id="c" role="treeitem">子节点</li></ul></li></ul>
    <div id="gc" role="gridcell"><button id="gb">删除这一行</button></div>
    <div id="btn" role="button" aria-expanded="true" aria-controls="menu">更多
      <div id="menu" role="menu"><div id="mi" role="menuitem">重命名</div></div></div>`);
  runRead(w, FULL);
  // The trigger whose menu is a DOM child keeps the menu items apart: the menu is an expanded popup.
  assert.deepEqual(idsOf(w), ['inner', 'cb', 'cbi', 'o1', 'o2', 'p', 'c', 'gc', 'gb', 'btn', 'mi']);
});

t('goal1: listener-only elements with cursor:pointer: only the outermost, with text or aria-label, outside other targets, flagged (推测可点)', () => {
  const w = makeDom(`
    <style>.opt { cursor: pointer } .off { cursor: default }</style>
    <div id="menu">
      <div id="f1" class="opt"><span>苹果</span> <b>Apple</b></div>
      <div id="f2" class="opt"><i class="icon"></i><span><em>香蕉</em></span></div>
      <div id="f3" class="opt" aria-label="关闭"></div>
      <div id="f4" class="opt"></div>
      <div id="f6" class="opt" style="display:none">看不见的</div>
      <a id="lnk" href="/x" class="opt"><span class="opt">链接里的字</span></a>
      <div id="f5" class="opt">卡片 <button id="fb">卡片按钮</button></div>
      <div id="f7" class="opt">外层 <span class="off"><span id="f8" class="opt">重新变成手形</span></span></div>
      <div id="f9" class="opt"><span>卡片标题</span> <span>卡片说明</span> <button id="fb2">收藏</button></div>
    </div>`);
  const r = runRead(w, FULL);
  // Inherited cursor: every span/b/em inside f1/f2 reports pointer too and gets nothing.
  assert.equal(w.getComputedStyle(w.document.querySelector('#f1 b')).cursor, 'pointer');
  // f9 wraps a real button, so neither it nor its inheriting spans are guessed: only the button counts.
  assert.deepEqual(idsOf(w), ['f1', 'f2', 'f3', 'lnk', 'fb', 'f7', 'fb2']);
  assert.equal(lineOf(r, 1), '[1] div | 苹果 Apple | (推测可点)');
  assert.equal(lineOf(r, 3), '[3] div | 关闭 | (推测可点)');
  assert.equal(lineOf(r, 4), '[4] a | 链接里的字');
  assert.equal(lineOf(r, 5), '[5] button | 卡片按钮');
  // (whitespace-only text nodes are dropped by the walk, as before)
  assert.match(bodyPart(r), /\[1\] \(推测可点\) 苹果\s*Apple/);
  assert.match(bodyPart(r), /\[2\] \(推测可点\) 香蕉/);
});

t('goal2: [展开]/[收起] from aria-expanded and <details>, inline and in the index', () => {
  const w = makeDom(`
    <button id="b1" aria-expanded="true">菜单</button>
    <button id="b2" aria-expanded="false">更多</button>
    <details><summary id="s1">说明</summary>内容</details>
    <details open><summary id="s2">已展开的说明</summary>内容</details>
    <input id="q" role="combobox" aria-expanded="false" placeholder="搜索城市">
    <button id="b3">普通按钮</button>`);
  const r = runRead(w, FULL);
  assert.equal(lineOf(r, 1), '[1] button | 菜单 | [展开]');
  assert.equal(lineOf(r, 2), '[2] button | 更多 | [收起]');
  assert.equal(lineOf(r, 3), '[3] summary | 说明 | [收起]');
  assert.equal(lineOf(r, 4), '[4] summary | 已展开的说明 | [展开]');
  assert.equal(lineOf(r, 5), '[5] input[text](role=combobox) | 搜索城市 | 文本输入框 [收起]');
  assert.equal(lineOf(r, 6), '[6] button | 普通按钮');
  const body = bodyPart(r);
  assert.match(body, /\[1\] \[展开\] 菜单/);
  assert.match(body, /\[2\] \[收起\] 更多/);
  assert.match(body, /\[3\] \[收起\] 说明/);
  assert.match(body, /\[5\] \[收起\] 输入框: 搜索城市/);
  assert.match(body, /\[6\] 普通按钮/);
});

t('goal2: [已选] from aria-selected, aria-checked, checked boxes and radios, and a label around a checked box', () => {
  const w = makeDom(`
    <div role="tablist"><div id="tab1" role="tab" aria-selected="true">概览</div><div id="tab2" role="tab" aria-selected="false">详情</div></div>
    <div id="sw" role="switch" aria-checked="true">通知</div>
    <input id="cb" type="checkbox" checked aria-label="记住我">
    <input id="rd" type="radio" name="r" aria-label="选项A">
    <label id="lb"><input type="checkbox" checked> 同意条款</label>
    <label id="lb2"><input type="checkbox"> 订阅</label>
    <ul role="listbox"><li id="op" role="option" aria-selected="true">香港</li><li id="op2" role="option">澳门</li></ul>`);
  const r = runRead(w, FULL);
  assert.deepEqual(idsOf(w), ['tab1', 'tab2', 'sw', 'cb', 'rd', 'lb', 'lb2', 'op', 'op2']);
  assert.equal(lineOf(r, 1), '[1] div(role=tab) | 概览 | [已选]');
  assert.equal(lineOf(r, 2), '[2] div(role=tab) | 详情');
  assert.equal(lineOf(r, 3), '[3] div(role=switch) | 通知 | [已选]');
  assert.equal(lineOf(r, 4), '[4] input[checkbox] | 记住我 | [已选]');
  assert.equal(lineOf(r, 5), '[5] input[radio] | 选项A');
  assert.equal(lineOf(r, 6), '[6] label | 同意条款 | [已选]');
  assert.equal(lineOf(r, 7), '[7] label | 订阅');
  assert.equal(lineOf(r, 8), '[8] li(role=option) | 香港 | [已选]');
  assert.equal(lineOf(r, 9), '[9] li(role=option) | 澳门');
  const body = bodyPart(r);
  assert.match(body, /\[1\] \[已选\] 概览/);
  assert.match(body, /\[4\] \[已选\] 控件: 记住我/);
  assert.match(body, /\[8\] \[已选\] 香港/);
  // The state follows the page: uncheck and read again.
  w.document.querySelector('#lb input').checked = false;
  assert.equal(lineOf(runRead(w, FULL), 6), '[6] label | 同意条款');
});

t('goal2: [禁用] from disabled, aria-disabled=true, a disabled fieldset (not its legend), inert, and a label of a disabled field', () => {
  const w = makeDom(`
    <button id="d1" disabled>提交</button>
    <div id="d2" role="button" aria-disabled="true">下一步</div>
    <fieldset disabled><legend><button id="lg">图例里的按钮</button></legend>
      <input id="d3" placeholder="禁用区里的输入框"><button id="d4">禁用区里的按钮</button></fieldset>
    <div inert><a id="d5" href="/a">惰性区域的链接</a></div>
    <div role="menu" aria-disabled="true"><div id="d6" role="menuitem">禁用的菜单项</div></div>
    <label id="d7" for="d3">输入框标签</label>
    <button id="ok">可用按钮</button>`);
  const r = runRead(w, FULL);
  assert.deepEqual(idsOf(w), ['d1', 'd2', 'lg', 'd3', 'd4', 'd5', 'd6', 'd7', 'ok']);
  const disabled = idsOf(w).filter((id, i) => /\[禁用\]/.test(lineOf(r, i + 1)));
  assert.deepEqual(disabled, ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
  assert.equal(lineOf(r, 4), '[4] input[text] | 禁用区里的输入框 | 文本输入框 [禁用]');
  assert.equal(lineOf(r, 3), '[3] button | 图例里的按钮');
  const body = bodyPart(r);
  assert.match(body, /\[1\] \[禁用\] 提交/);
  assert.match(body, /\[4\] \[禁用\] 输入框: 禁用区里的输入框/);
  assert.match(body, /\[6\] \[禁用\] 惰性区域的链接/);
  assert.match(body, /\[9\] 可用按钮/);
});

t('goal3: a native <select> lists all its options in the index: the selected one, disabled ones, a disabled optgroup', () => {
  const w = makeDom(`
    <select id="s">
      <option value="">请选择</option>
      <optgroup label="水果"><option>苹果</option><option selected>香蕉</option><option disabled>榴莲</option></optgroup>
      <optgroup label="停售" disabled><option>旧款</option></optgroup>
    </select>
    <select id="s2" disabled><option>只读的</option></select>`);
  const r = runRead(w, FULL);
  const idx = indexPart(r);
  assert.match(idx, /^\[1\] select \| 香蕉$/m);
  assert.match(idx, /^\[1\] select \| 香蕉\n    选项（共 5 个）：「请选择」 〔水果〕 「苹果」 「香蕉」\[已选\] 「榴莲」\[禁用\] 〔停售·禁用〕 「旧款」\[禁用\]$/m);
  assert.match(idx, /^\[2\] select \| 只读的 \| \[禁用\]\n    选项（共 1 个）：「只读的」\[已选\]$/m);
  // The text keeps the current value inline; the option list lives in the index only.
  assert.match(bodyPart(r), /\[1\] 下拉框: 香蕉/);
  assert.match(bodyPart(r), /\[2\] \[禁用\] 下拉框: 只读的/);
  assert.doesNotMatch(bodyPart(r), /榴莲/);
  // Changing the selection changes the marks.
  w.document.getElementById('s').selectedIndex = 1;
  assert.match(indexPart(runRead(w, FULL)), /「苹果」\[已选\] 「香蕉」 「榴莲」\[禁用\]/);
});

t('goal3: a <select> with more than 30 options lists the first 30 and gives the total; a selected option further down is still named', () => {
  const opts = Array.from({ length: 45 }, (_, i) => `<option${i === 39 ? ' selected' : ''}>选项 ${i + 1}</option>`).join('');
  const w = makeDom(`<select>${opts}</select>`);
  const r = runRead(w, FULL);
  const line = indexPart(r).split('\n').find(l => l.startsWith('    选项'));
  assert.match(line, /^    选项（共 45 个，只列前 30 个）：「选项 1」 「选项 2」 /);
  assert.equal((line.match(/「/g) || []).length, 31, '30 listed + the selected one named after them');
  assert.match(line, /「选项 30」 …；当前选中 「选项 40」（第 40 个）$/);
  assert.doesNotMatch(line, /「选项 31」/);
  assert.equal(lineOf(r, 1), '[1] select | 选项 40');
});

const MODAL_PAGE = `
  <nav><a id="home" href="/home">首页</a> <button id="bg">背景按钮</button></nav>
  <p>背景正文</p>
  <div id="cookie" style="position:fixed">我们使用 Cookie <button id="accept">接受</button></div>
  <dialog id="dlg" open aria-labelledby="dt"><h2 id="dt">订阅通讯</h2>
    <input id="email" type="email" placeholder="邮箱"> <button id="sub">订阅</button> <button id="close">关闭</button></dialog>`;

t('goal4: an open modal: a warning line first, its elements first in the text and the index, the rest keep their numbers, flagged [被弹窗挡住]', () => {
  const w = makeDom(MODAL_PAGE);
  const r = runRead(w, FULL);
  assert.equal(r.text.split('\n')[0], '⚠️ 页面开着弹窗「订阅通讯」：先列弹窗里的元素；弹窗外的元素被它挡住');
  // Numbers are document order, as always.
  assert.deepEqual(idsOf(w), ['home', 'bg', 'accept', 'email', 'sub', 'close']);
  assert.deepEqual(indexOrder(r), [4, 5, 6, 1, 2, 3]);
  assert.equal(lineOf(r, 4), '[4] input[email] | 邮箱 | 文本输入框');
  assert.equal(lineOf(r, 5), '[5] button | 订阅');
  assert.equal(lineOf(r, 1), '[1] a | 首页 | [被弹窗挡住]');
  assert.equal(lineOf(r, 3), '[3] button | 接受 | [被弹窗挡住]');
  assert.match(indexPart(r), /共 6 个；弹窗里的排在最前/);
  const body = bodyPart(r);
  assert.ok(body.indexOf('订阅通讯') < body.indexOf('背景正文'), 'the modal text comes first');
  assert.ok(body.indexOf('[4]') < body.indexOf('[1]'), 'the modal markers come first');
  assert.match(body, /--- 弹窗「订阅通讯」里的内容 ---/);
  assert.match(body, /--- 弹窗外的页面：下面的元素都\[被弹窗挡住\]，先处理弹窗 ---/);
  assert.match(body, /\[5\] 订阅 \[6\] 关闭/);
});

t('goal4: numbers do not move when a modal opens; each number once in the text and once in the index, matching the click registry', () => {
  const page = MODAL_PAGE.replace('<dialog id="dlg" open aria-labelledby="dt">', '<div id="dlg" role="dialog" aria-modal="true" aria-labelledby="dt">')
                         .replace('</dialog>', '</div>');
  const w = makeDom(page);
  const modal = runRead(w, FULL);
  const regModal = regOf(w);
  assert.match(modal.text, /^⚠️ 页面开着弹窗「订阅通讯」/);
  w.document.getElementById('dlg').removeAttribute('aria-modal');
  const plain = runRead(w, FULL);
  assert.doesNotMatch(plain.text, /页面开着弹窗|被弹窗挡住/);
  assert.deepEqual(regOf(w), regModal, 'same elements, same numbers with and without the modal');
  runRead(w.document.getElementById('dlg').setAttribute ? (w.document.getElementById('dlg').setAttribute('aria-modal', 'true'), w) : w);
  for (const r of [modal, plain]) {
    const order = indexOrder(r);
    assert.deepEqual([...order].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6], 'each number exactly once in the index');
    const counts = bodyCounts(r);
    for (let n = 1; n <= 6; n++) assert.equal(counts.get(n), 1, `[${n}] appears ${counts.get(n)} times in the text`);
    // Every index line names the element the registry holds under that number.
    for (const n of order) {
      const el = w.__chromeBridge.markers[n];
      const tagPart = lineOf(r, n).split(' | ')[0].replace(/^\[\d+\] /, '');
      assert.equal(tagPart.replace(/[[(].*$/, ''), el.tagName.toLowerCase(), `[${n}]`);
      const label = el.tagName === 'INPUT' ? el.placeholder : el.textContent.trim();
      assert.equal(lineOf(r, n).split(' | ')[1], label, `[${n}]`);
    }
  }
});

t('goal4: which dialogs count: visible aria-modal dialog/alertdialog, <dialog open>; not a hidden or non-modal one; nested → the inner one', () => {
  let w = makeDom(`<button>背景</button><div role="dialog" aria-label="非模态面板"><button>面板按钮</button></div>`);
  assert.doesNotMatch(runRead(w, FULL).text, /页面开着弹窗|被弹窗挡住/);
  w = makeDom(`<button>背景</button>
    <div role="dialog" aria-modal="true" style="display:none"><button>隐藏的</button></div>
    <dialog><button>关着的</button></dialog>`);
  assert.doesNotMatch(runRead(w, FULL).text, /页面开着弹窗|被弹窗挡住/);
  w = makeDom(`<button id="bg">背景</button>
    <div id="outer" role="dialog" aria-modal="true" aria-label="设置"><button id="ob">外层按钮</button>
      <div id="inner" role="alertdialog" aria-modal="true"><h3>确定要删除吗？</h3><button id="yes">删除</button></div></div>`);
  const r = runRead(w, FULL);
  assert.match(r.text, /^⚠️ 页面开着弹窗「确定要删除吗？」/);
  assert.deepEqual(indexOrder(r), [mk(w, '#yes'), mk(w, '#bg'), mk(w, '#ob')]);
  assert.match(lineOf(r, mk(w, '#ob')), /\| \[被弹窗挡住\]$/);
  assert.equal(lineOf(r, mk(w, '#yes')), `[${mk(w, '#yes')}] button | 删除`);
});

t('goal4: a list opened from inside the modal and rendered at the end of <body> is in front with the modal; a cookie bar is not', () => {
  const w = makeDom(`<button id="bg">背景</button>
    <div id="m" role="dialog" aria-modal="true" aria-label="编辑资料">
      <div id="cb" role="combobox" aria-expanded="true" aria-controls="lb">选择国家</div></div>
    <div id="cookie" style="position:fixed"><button id="ck">接受 Cookie</button></div>
    <ul id="lb" role="listbox" style="position:absolute"><li id="o1" role="option">新加坡</li><li id="o2" role="option">日本</li></ul>`);
  const r = runRead(w, FULL);
  assert.deepEqual(idsOf(w), ['bg', 'cb', 'ck', 'o1', 'o2']);
  assert.deepEqual(indexOrder(r), [2, 4, 5, 1, 3]);
  assert.equal(lineOf(r, 4), '[4] li(role=option) | 新加坡');
  assert.equal(lineOf(r, 3), '[3] button | 接受 Cookie | [被弹窗挡住]');
  const body = bodyPart(r);
  assert.ok(body.indexOf('新加坡') < body.indexOf('弹窗外的页面'), 'the list is in the modal part of the text');
  for (const [n, c] of bodyCounts(r)) assert.equal(c, 1, `[${n}] appears ${c} times`);
});

t('goal5: a long page with a modal at the end: the cut falls on the page text, the modal text and elements stay', () => {
  const filler = Array.from({ length: 400 }, (_, i) => `<p>第 ${i} 段很长的背景正文，用来把页面撑到超过一万两千个字符的上限。</p>`).join('');
  const many = Array.from({ length: 300 }, (_, i) => `<button>背景按钮 ${i}</button>`).join('');
  const w = makeDom(filler + many +
    '<dialog open aria-label="登录"><p>请先登录再继续</p><input id="user" placeholder="用户名"><button id="login">登录</button></dialog>');
  const r = runRead(w, FULL);
  assert.ok(r.text.length <= 12000, `output ${r.text.length} chars exceeds the cap`);
  assert.match(r.text, /正文过长已截断/);
  assert.match(r.text, /索引已截断/);
  const nUser = mk(w, '#user'), nLogin = mk(w, '#login');
  assert.equal(nLogin, 302);
  const body = bodyPart(r);
  assert.match(body, /请先登录再继续/);
  assert.match(body, new RegExp(`\\[${nUser}\\] 输入框: 用户名`));
  assert.match(body, new RegExp(`\\[${nLogin}\\] 登录`));
  assert.match(body, /第 0 段/);
  assert.doesNotMatch(body, /第 399 段/);
  assert.deepEqual(indexOrder(r).slice(0, 2), [nUser, nLogin]);
});

t('goal5: an expanded list (aria-controls) mid-page and a portal list at the end of <body> survive truncation; the rest of the text is cut', () => {
  const filler = Array.from({ length: 400 }, (_, i) => `<p>第 ${i} 段很长的正文内容，用来把页面撑到超过一万两千个字符的上限。</p>`).join('');
  const buttons = Array.from({ length: 300 }, (_, i) => `<button>工具栏按钮 ${i}</button>`).join('');
  const cities = Array.from({ length: 20 }, (_, i) => `<li role="option">城市 ${i + 1}</li>`).join('');
  const w = makeDom(`<div id="app">${buttons}${filler}
      <div id="cb" role="combobox" aria-expanded="true" aria-controls="lb1">城市</div>
      <ul id="lb1" role="listbox">${cities}</ul>
      <p>列表后面的正文：第二批填充</p>${filler.replace(/第 (\d+) 段/g, '尾部第 $1 段')}</div>
    <div id="portal" style="position:absolute"><div class="opt" style="cursor:pointer">弹层选项 甲</div><div class="opt" style="cursor:pointer">弹层选项 乙</div></div>`);
  const r = runRead(w, FULL);
  assert.ok(r.text.length <= 12000, `output ${r.text.length} chars exceeds the cap`);
  assert.match(r.text, /正文过长已截断：弹窗和展开的列表完整保留/);
  assert.match(r.text, /索引已截断.*弹窗和展开的列表里的元素已优先列出/);
  const body = bodyPart(r), idx = indexPart(r);
  for (let i = 1; i <= 20; i++) {
    const n = mk(w, `#lb1 li:nth-child(${i})`);
    assert.match(body, new RegExp(`\\[${n}\\] 城市 ${i}(?!\\d)`), `option ${i} lost from the text`);
    assert.equal(lineOf(r, n), `[${n}] li(role=option) | 城市 ${i}`, `option ${i} lost from the index`);
  }
  for (const label of ['弹层选项 甲', '弹层选项 乙']) {
    const n = regOf(w).findIndex(e => e.textContent === label) + 1;
    assert.ok(n > 0, `${label} has no marker`);
    assert.match(body, new RegExp(`\\[${n}\\] \\(推测可点\\) ${label}`));
    assert.equal(lineOf(r, n), `[${n}] div | ${label} | (推测可点)`);
  }
  assert.equal(lineOf(r, mk(w, '#cb')), `[${mk(w, '#cb')}] div(role=combobox) | 城市 | [展开]`);
  // What went: the tail of the ordinary text, and the middle of the toolbar index.
  assert.match(body, /第 0 段/);
  assert.doesNotMatch(body, /尾部第 399 段/);
  assert.match(body, /此处正文已省略/);
  assert.match(idx, /^\[1\] button \| 工具栏按钮 0$/m);
  assert.ok(!lineOf(r, 300), 'the index cut fell on the toolbar, not on the list');
});

t('goal5: portal layers: a flat portal root at the end of <body> is kept; a <main>/<footer> that merely contains a menu is not, so the page head survives', () => {
  const filler = (tag) => Array.from({ length: 400 }, (_, i) => `<p>${tag}第 ${i} 段很长的正文内容，用来把页面撑到超过一万两千个字符的上限。</p>`).join('');
  // A portal root whose popups are absolutely placed has a flat box of its own (as Chrome lays it out).
  let w = makeDom(`<div id="app"><h1>页首标题</h1><a href="/">首页</a>${filler('')}</div>
    <div id="pr" data-rect="0,0,800,0"><div style="position:absolute"><div style="cursor:pointer">弹层里的选项</div></div></div>`);
  let r = runRead(w, FULL);
  assert.match(bodyPart(r), /\(推测可点\) 弹层里的选项/);
  assert.match(r.text, /弹窗和展开的列表完整保留/);
  w = makeDom(`<header><a href="/">页首导航</a></header>
    <main><ul role="menu"><li role="menuitem">主体菜单项</li></ul>${filler('主体')}</main>
    <footer><div role="menu"><a href="/x" role="menuitem">页脚菜单</a></div>${filler('页脚')}</footer>`);
  r = runRead(w, FULL);
  assert.ok(r.text.length <= 12000);
  assert.match(bodyPart(r), /\[1\] 页首导航/);
  assert.match(bodyPart(r), /主体第 0 段/);
  assert.doesNotMatch(r.text, /弹窗和展开的列表完整保留/);
  assert.match(r.text, /正文过长已截断，只显示前 \d+ 个字符/);
});

const DROPDOWN_HTML = await readFile(path.join(ROOT, 'test/fixtures/dropdown-semantics.html'), 'utf8');
const MODAL_HTML = await readFile(path.join(ROOT, 'test/fixtures/modal-overlay.html'), 'utf8');
const markerByText = (w, re) => regOf(w).findIndex(e => re.test(e.textContent.trim())) + 1;

t('goal6: test/fixtures/dropdown-semantics.html: states follow the page as it is opened and picked, popups survive the 12k cap', () => {
  const w = fixtureDom(DROPDOWN_HTML, 'http://127.0.0.1:4560/dropdown-semantics.html');
  const d = w.document;
  // Layout as Chrome has it: the portal root holds only absolutely placed popups, so its own box is flat.
  d.getElementById('portal-root').setAttribute('data-rect', '0,0,828,0');
  let r = runRead(w, FULL);
  assert.ok(r.text.length <= 12000);
  assert.match(r.text, /正文过长已截断/, 'the fixture is meant to overflow the cap');
  assert.equal(lineOf(r, mk(w, '#city')), `[${mk(w, '#city')}] input[text](role=combobox) | 输入或选择城市 | 文本输入框 [收起]`);
  assert.equal(lineOf(r, mk(w, '#country')), `[${mk(w, '#country')}] div(role=combobox) | 请选择国家/地区 | [收起]`);
  assert.equal(lineOf(r, mk(w, '#fruit')), `[${mk(w, '#fruit')}] div | 选择水果▾ | (推测可点)`);
  assert.ok(!regOf(w).some(e => e.matches('[role=option], .fake-opt')), 'closed popups have no markers');

  // Select-only combobox: 120 options in the body-end portal.
  d.getElementById('country').click();
  r = runRead(w, FULL);
  assert.ok(r.text.length <= 12000);
  assert.match(lineOf(r, mk(w, '#country')), /\| \[展开\]$/);
  const opts = regOf(w).filter(e => e.closest('#country-list'));
  assert.equal(opts.length, 120);
  for (const o of opts) {
    const n = mk(w, `#${o.id}`);
    assert.ok(lineOf(r, n), `${o.id} missing from the index`);
    assert.match(bodyPart(r), new RegExp(`\\[${n}\\] `), `${o.id} missing from the text`);
  }
  assert.match(lineOf(r, mk(w, '#country-5')), /地区 005（不可选） \| \[禁用\]$/);
  assert.match(lineOf(r, mk(w, '#country-50')), /\| \[禁用\]$/);
  // Pick through the registry entry the index names.
  const n7 = markerByText(w, /^地区 007$/);
  assert.equal(lineOf(r, n7), `[${n7}] li(role=option) | 地区 007`);
  w.__chromeBridge.markers[n7].click();
  r = runRead(w, FULL);
  assert.equal(lineOf(r, mk(w, '#country')), `[${mk(w, '#country')}] div(role=combobox) | 地区 007 | [收起]`);
  assert.match(r.text, /国家\/地区 地区 007/);
  d.getElementById('country').click();
  r = runRead(w, FULL);
  assert.equal(lineOf(r, mk(w, '#country-7')), `[${mk(w, '#country-7')}] li(role=option) | 地区 007 | [已选]`);
  d.body.click();

  // Listener-only menu in the portal: the outermost pointer elements only.
  d.getElementById('fruit').click();
  r = runRead(w, FULL);
  const fruits = regOf(w).filter(e => e.closest('#fruit-menu'));
  assert.deepEqual(fruits.map(e => e.getAttribute('data-v')), ['苹果', '香蕉', '芒果'], 'not the not-allowed one, not the children of 芒果');
  for (const f of fruits) assert.match(lineOf(r, mk(w, `[data-v="${f.getAttribute('data-v')}"]`)), /\| \(推测可点\)$/);
  w.__chromeBridge.markers[mk(w, '[data-v="香蕉"]')].click();
  r = runRead(w, FULL);
  assert.match(lineOf(r, mk(w, '#fruit')), /\| 香蕉▾ \| \(推测可点\)$/);
  assert.match(r.text, /水果 香蕉/);

  // Editable combobox with its list in place: disabled option, then the picked one is [已选].
  d.getElementById('city').click();
  r = runRead(w, FULL);
  assert.match(lineOf(r, mk(w, '#city')), /\[展开\]$/);
  assert.match(lineOf(r, mk(w, '#city-bkk')), /曼谷（暂停服务） \| \[禁用\]$/);
  w.__chromeBridge.markers[mk(w, '#city-sg')].click();
  d.getElementById('city').click();
  r = runRead(w, FULL);
  assert.match(lineOf(r, mk(w, '#city-sg')), /新加坡 \| \[已选\]$/);
  assert.doesNotMatch(lineOf(r, mk(w, '#city-kl')), /已选/);

  // Native select: 45 options, first 30 listed, disabled option and optgroup marked.
  const opt = d.getElementById('plan');
  const sel = indexPart(r).split('\n')[indexPart(r).split('\n').indexOf(lineOf(r, mk(w, '#plan'))) + 1];
  assert.match(sel, /^    选项（共 45 个，只列前 30 个）：〔常用〕 「基础版」 「标准版」\[已选\] 「旗舰版（已售罄）」\[禁用\] 〔旧版（停售）·禁用〕 「旧版 v1」\[禁用\] 「旧版 v2」\[禁用\] 〔更多〕 「套餐 01」/);
  assert.equal(opt.options.length, 45);
});

t('goal6: test/fixtures/modal-overlay.html: native and ARIA modals, the cookie bar behind them, and the page after closing', () => {
  let w = fixtureDom(MODAL_HTML, 'http://127.0.0.1:4560/modal-overlay.html');
  let d = w.document;
  let r = runRead(w, FULL);
  assert.equal(r.text.split('\n')[0], '⚠️ 页面开着弹窗「订阅我们的通讯」：先列弹窗里的元素；弹窗外的元素被它挡住');
  const inModal = regOf(w).map((e, i) => (e.closest('#native') ? i + 1 : 0)).filter(Boolean);
  assert.equal(inModal.length, 5, 'email label, email, agree label, subscribe, close');
  assert.deepEqual(indexOrder(r).slice(0, inModal.length), inModal);
  assert.match(lineOf(r, mk(w, '#subscribe')), /订阅 \| \[禁用\]$/);
  for (const sel of ['#bg-btn', '#cookie-accept', '#cookie-reject', '#open-aria']) {
    assert.match(lineOf(r, mk(w, sel)), /\[被弹窗挡住\]$/, sel);
  }
  const before = new Map(['#bg-btn', '#cookie-accept', '#bg-search'].map(s => [s, mk(w, s)]));
  // Tick the box (its label carries the state), the subscribe button comes alive.
  const agreeLabel = d.getElementById('agree').closest('label');
  w.__chromeBridge.markers[regOf(w).indexOf(agreeLabel) + 1].click();
  r = runRead(w, FULL);
  assert.match(lineOf(r, regOf(w).indexOf(agreeLabel) + 1), /同意条款 \| \[已选\]$/);
  assert.doesNotMatch(lineOf(r, mk(w, '#subscribe')), /禁用/);
  // Close it: no warning, same numbers for the page behind.
  d.getElementById('native-close').click();
  r = runRead(w, FULL);
  assert.doesNotMatch(r.text, /页面开着弹窗|被弹窗挡住/);
  for (const [s, n] of before) assert.equal(mk(w, s), n, `${s} kept its number`);
  assert.match(r.text, /native dialog closed: close button/);

  w = fixtureDom(MODAL_HTML, 'http://127.0.0.1:4560/modal-overlay.html?modal=aria');
  d = w.document;
  r = runRead(w, FULL);
  assert.match(r.text, /^⚠️ 页面开着弹窗「确认删除」/);
  assert.deepEqual(indexOrder(r).slice(0, 2), [mk(w, '#aria-cancel'), mk(w, '#aria-confirm')]);
  assert.match(lineOf(r, mk(w, '#cookie-accept')), /\[被弹窗挡住\]$/);
  w.__chromeBridge.markers[mk(w, '#aria-cancel')].click();
  r = runRead(w, FULL);
  assert.doesNotMatch(r.text, /页面开着弹窗/);
  // The cookie bar works and goes away.
  w.__chromeBridge.markers[mk(w, '#cookie-accept')].click();
  r = runRead(w, FULL);
  assert.equal(mk(w, '#cookie-accept'), -1);
  assert.doesNotMatch(r.text, /接受全部/);

  w = fixtureDom(MODAL_HTML, 'http://127.0.0.1:4560/modal-overlay.html?modal=none');
  assert.doesNotMatch(runRead(w, FULL).text, /页面开着弹窗|被弹窗挡住/);
});

console.log('\nsrc/page/read.js — default = this screen + page outline; sections / query / full (round 7)');

/**
 * A flow layout for whole-page fixtures: block elements stack in 24 px rows down the page (a container
 * spans its children), inline elements share their block's row, an element with data-rect is placed there
 * and does not scroll (a fixed layer), display:none has no box. scrollY shifts the page up.
 */
const FLOW_BLOCK = new Set(('ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DETAILS DIALOG DIV DL DT FIELDSET FIGCAPTION FIGURE ' +
  'FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION TABLE TBODY THEAD TD TH TR UL SUMMARY').split(' '));
function flowLayout(w, { scrollY = 0 } = {}) {
  const ROW = 24, WIDTH = 860, ZERO = { x: 0, y: 0, width: 0, height: 0 };
  const rects = new Map(), fixed = new Set();
  const hidden = (el) => w.getComputedStyle(el).display === 'none';
  let y = 0;
  function lay(el) {
    if (hidden(el)) { rects.set(el, ZERO); for (const d of el.querySelectorAll('*')) rects.set(d, ZERO); return; }
    if (el.hasAttribute('data-rect')) {
      const [x, top, width, height] = el.getAttribute('data-rect').split(',').map(Number);
      rects.set(el, { x, y: top, width, height });
      fixed.add(el);
      return;
    }
    const kids = [...el.children].filter(c => !/^(SCRIPT|STYLE)$/.test(c.tagName));
    if (!kids.some(c => FLOW_BLOCK.has(c.tagName) || c.hasAttribute('data-rect'))) {
      rects.set(el, { x: 0, y, width: WIDTH, height: ROW });
      y += ROW;
      return;
    }
    const y0 = y;
    for (const c of kids) {
      if (FLOW_BLOCK.has(c.tagName) || c.hasAttribute('data-rect') || hidden(c)) lay(c);
      else { rects.set(c, { x: 0, y, width: 200, height: ROW }); y += ROW; }
    }
    rects.set(el, { x: 0, y: y0, width: WIDTH, height: y - y0 });
  }
  lay(w.document.body);
  for (const el of w.document.body.querySelectorAll('*')) {
    if (rects.has(el)) continue;
    let a = el.parentElement;
    while (a && !rects.has(a)) a = a.parentElement;
    rects.set(el, a ? rects.get(a) : ZERO);
    if (a && (fixed.has(a) || a.closest('[data-rect]'))) fixed.add(el);
  }
  const box = (el) => {
    const r = rects.get(el) || ZERO;
    const top = r.width || r.height ? r.y - (fixed.has(el) ? 0 : scrollY) : 0;
    return { x: r.x, y: top, width: r.width, height: r.height, left: r.x, top, right: r.x + r.width,
             bottom: top + r.height, toJSON() { return this; } };
  };
  w.Element.prototype.getBoundingClientRect = function () { return box(this); };
  w.Element.prototype.getClientRects = function () { const r = box(this); return r.width === 0 && r.height === 0 ? [] : [r]; };
  w.Range.prototype.getClientRects = function () {
    const host = this.startContainer.nodeType === 3 ? this.startContainer.parentElement : this.startContainer;
    return [host.getBoundingClientRect()];
  };
  Object.defineProperty(w, 'scrollY', { value: scrollY, configurable: true });
  Object.defineProperty(w.document.documentElement, 'scrollHeight', { value: y, configurable: true });
  return w;
}

const LONG_HTML = await readFile(path.join(ROOT, 'test/fixtures/long-article.html'), 'utf8');
const LONG_URL = 'http://127.0.0.1:4560/long-article.html';
/** test/fixtures/long-article.html laid out in a 1400×812 viewport (34 rows), optionally scrolled. */
function longArticle({ modal = false, scrollY = 0 } = {}) {
  return flowLayout(fixtureDom(LONG_HTML, LONG_URL + (modal ? '?modal=1' : '')), { scrollY });
}
// The same function read.js uses, taken from its source so the test and the page agree on one definition.
const estimateTokens = new Function(
  readSrc.match(/var CJK_RE = [^\n]+\n\s*function estimateTokens\(text, clicks\) \{[\s\S]*?\n  \}/)[0] +
  '\nreturn estimateTokens;')();
/** The text between two headings of the output ('=== 页面目录' … '=== 这一屏'). */
const between = (text, from, to) => {
  const a = text.indexOf(from);
  if (a === -1) return '';
  const b = to ? text.indexOf(to, a + from.length) : -1;
  return text.slice(a, b === -1 ? undefined : b);
};
/** Outline rows as printed: indent level, S id, title, tokens, clickables, flags. */
function outlineRows(text) {
  return between(text, '=== 页面目录', '=== 这一屏').split('\n').slice(1).filter(l => /^\s*S\d+ /.test(l)).map(l => {
    const m = l.match(/^( *)S(\d+) (.*?)（约 (\d+) token，(\d+) 个可点(?:，含 (\d+) 个子节)?）(.*)$/);
    assert.ok(m, `outline line not in the expected form: ${l}`);
    return { depth: m[1].length / 2, id: +m[2], title: m[3], tok: +m[4], clk: +m[5], folded: m[6] ? +m[6] : 0,
             big: /⚠️ 异常大/.test(m[7]), screen: /\[在屏上\]/.test(m[7]), line: l };
  });
}
/** Index lines ("[n] tag | label | flags") anywhere in the output. */
const indexLines = (text) => text.split('\n').filter(l => /^\[\d+\] \S+ \| /.test(l));
const numOf = (l) => Number(l.match(/^\[(\d+)\]/)[1]);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

t('round7: estimateTokens — a CJK character is 1 token, other text 3.5 characters a token, each clickable +6', () => {
  assert.equal(estimateTokens('新加坡', 0), 3);
  assert.equal(estimateTokens('abcdefg', 0), 2);
  assert.equal(estimateTokens('x'.repeat(7000), 0), 2000);
  assert.equal(estimateTokens('', 2), 12);
  assert.equal(estimateTokens('新加坡 Singapore', 1), Math.round(3 + 10 / 3.5 + 6));
  assert.equal(estimateTokens('，。（）「」', 0), 6, 'CJK and full-width punctuation count 1 each');
  // The same as the measurement script in docs/discussion-round7 (test/round7-viewport.mjs tok()).
  const tok = (s) => { const cjk = (s.match(/[㐀-鿿　-〿＀-￯]/g) || []).length; return Math.round(cjk + (s.length - cjk) / 3.5); };
  for (const s of ['新加坡共和国（Republic of Singapore）', 'Hacker News: 30 points by x 2 hours ago', '历史 History 1819 年']) {
    assert.equal(estimateTokens(s, 0), tok(s), s);
    assert.equal(estimateTokens(s, 3), tok(s) + 18, s);
  }
});

t('round7: long-article outline — heading levels (a single h1 is the page title), parents include their sub-sections, on-screen sections marked', () => {
  const w = longArticle();
  const r = runRead(w);
  assert.equal(r.mode, 'screen');
  const rows = outlineRows(r.text);
  assert.deepEqual(rows.map(x => `${'  '.repeat(x.depth)}S${x.id} ${x.title}${x.screen ? ' *' : ''}`), [
    'S0 （第一个标题之前） *', 'S1 狮城简史（测试长文） *', 'S2 地理 *', '  S3 气候 *', '  S4 地形 *',
    'S5 历史 *', '  S6 早期 *', '  S7 殖民时期', '    S8 海峡殖民地', '  S9 独立',
    'S10 经济', 'S11 社会', 'S12 尾声', 'S13 参考文献']);
  const row = (id) => rows.find(x => x.id === id);
  // Clickables: own + sub-sections (S5 owns the timeline link, S8 the "more" link).
  assert.equal(row(0).clk, 4);
  assert.equal(row(8).clk, 1);
  assert.equal(row(7).clk, 1);
  assert.equal(row(5).clk, 1 + row(6).clk + row(7).clk + row(9).clk);
  assert.equal(row(2).clk, row(3).clk + row(4).clk);
  assert.equal(row(13).clk, 302, '300 references + the footer (the last heading runs to the end)');
  // Tokens: exactly the estimate of the section's own text plus its sub-sections' text.
  const d = w.document;
  const textOf = (sel) => [...d.querySelectorAll(sel)].map(e => norm(e.textContent)).join('');
  const s8 = textOf('#h-straits') + textOf('[data-topic="海峡殖民地"] p') + textOf('#straits-more');
  assert.equal(row(8).tok, estimateTokens(s8, 1));
  assert.equal(row(7).tok, estimateTokens(textOf('#h-colonial') + textOf('[data-topic="殖民时期"] p') + s8, 1));
  assert.ok(row(5).tok >= row(6).tok + row(7).tok + row(9).tok, 'a parent is at least the sum of its sub-sections');
  // The JSON outline says the same.
  for (const x of rows) {
    const o = r.outline[x.id];
    assert.equal(o.tok, x.tok, `S${x.id}`);
    assert.equal(o.clk, x.clk, `S${x.id}`);
  }
  assert.match(r.text, /=== 页面目录（14 节；整页约 \d+ token、310 个可点）===/);
  assert.equal(r.text.split('\n').at(-1), r.hint);
  assert.match(r.hint, /^提示：展开几节用 read_page\(sections=\["S2","S5"\]\).*query.*full=true/);
});

t('round7: an abnormally large section (> 8000 tokens) is flagged and the others are not; a page over 50000 tokens says so at the top of the outline', () => {
  const r = runRead(longArticle());
  const rows = outlineRows(r.text);
  assert.deepEqual(rows.filter(x => x.big).map(x => x.id), [13]);
  assert.ok(rows.find(x => x.id === 13).tok > 8000);
  assert.match(rows.find(x => x.id === 13).line, new RegExp(`⚠️ 异常大（约 ${rows.find(x => x.id === 13).tok} token），多半是参考文献/导航/评论区，别整节展开，用 query`));
  assert.doesNotMatch(r.text, /整页约 \d+ token，异常大/);
  // The threshold itself: 7999 tokens is fine, 8001 is not; a parent over it says "or its sub-sections".
  let w = makeDom(`<h2>甲</h2><p>${'字'.repeat(7998)}</p><h2>乙</h2><p>${'字'.repeat(8000)}</p>` +
                  `<h2>丙</h2><h3>丙一</h3><p>${'字'.repeat(4500)}</p><h3>丙二</h3><p>${'字'.repeat(4500)}</p>`);
  let rr = outlineRows(runRead(w).text);
  assert.deepEqual(rr.map(x => [x.title, x.tok, x.big]), [
    ['甲', 7999, false], ['乙', 8001, true], ['丙', 9005, true], ['丙一', 4502, false], ['丙二', 4502, false]]);
  assert.match(rr[2].line, /别整节展开，用 query 或展开它的子节( \[在屏上\])?$/);
  // A whole page over 50000 tokens.
  w = makeDom(Array.from({ length: 6 }, (_, i) => `<h2>第 ${i} 部分</h2><p>${'字'.repeat(9000)}</p>`).join(''));
  const big = runRead(w).text;
  const head = between(big, '=== 页面目录', '=== 这一屏').match(/^=== 页面目录（6 节；整页约 (\d+) token、0 个可点）===\n⚠️ 整页约 (\d+) token，异常大：别用 full 整页读/);
  assert.ok(head && +head[1] > 50000 && head[1] === head[2], big.slice(0, 300));
  assert.doesNotMatch(runRead(makeDom('<h2>小</h2><p>一点点</p>')).text, /异常大/);
});

t('round7: default mode prints only what meets the viewport (stubbed layout); scrolled down, the late section is the one on screen', () => {
  let w = longArticle();
  let r = runRead(w);
  const screen = between(r.text, '=== 这一屏（', '\n提示：');
  assert.match(screen, /^=== 这一屏（整页约 14 屏，这是第 1 屏）===/);
  const shown = indexLines(screen).map(numOf);
  assert.deepEqual(shown, ['#site-home', '#site-login', '#site-search', '#print', '#climate-table', '#timeline-link'].map(s => mk(w, s)));
  assert.match(screen, /导言：这是给 read_page/);
  assert.match(screen, /【早期·第 7 段】/, 'the last row that meets the viewport');
  assert.doesNotMatch(screen, /【早期·第 8 段】/, 'the first row below the viewport');
  for (const gone of ['暗号', '尾声里的按钮', 'Reference 1:', '关于本站', '【经济']) assert.ok(!screen.includes(gone), `${gone} is not on screen`);
  assert.match(screen, /=== 这一屏的可点击元素（6 个；整页共 310 个，编号全页通用）===/);

  w = longArticle({ scrollY: 3600 });
  r = runRead(w);
  const s2 = between(r.text, '=== 这一屏（', '\n提示：');
  assert.match(s2, /^=== 这一屏（整页约 14 屏，这是第 5 屏）===/);
  assert.match(s2, /暗号 PINEAPPLE-42/);
  assert.match(s2, new RegExp(`\\[${mk(w, '#late-btn')}\\] 尾声里的按钮`));
  assert.ok(indexLines(s2).map(numOf).includes(mk(w, '#late-btn')));
  assert.ok(!indexLines(s2).map(numOf).includes(mk(w, '#site-home')), 'the header has scrolled away');
  assert.doesNotMatch(s2, /导言/);
  const rows = outlineRows(r.text);
  assert.deepEqual(rows.filter(x => x.screen).map(x => x.id), [11, 12, 13]);
});

t('round7: numbering — default (top and scrolled), sections, query and full mode give each element the same number, the one the click registry holds', () => {
  const runs = [
    [longArticle(), {}], [null, { sections: ['S5', 'S12'] }], [null, { query: 'reference' }], [null, FULL],
    [longArticle({ scrollY: 3600 }), {}], [null, { sections: ['S13'] }]];
  let w, reg0 = null;
  const lineOfN = new Map();
  for (const [nw, req] of runs) {
    if (nw) w = nw;
    const r = runRead(w, req);
    const reg = regOf(w);
    if (!reg0) reg0 = reg.map(e => e.id || e.textContent);
    assert.deepEqual(reg.map(e => e.id || e.textContent), reg0, `registry changed in ${JSON.stringify(req)}`);
    const lines = indexLines(r.text);
    assert.ok(lines.length > 0, JSON.stringify(req));
    for (const l of lines) {
      const n = numOf(l), el = w.__chromeBridge.markers[n];
      assert.ok(el, `[${n}] is not in the registry`);
      const [, tag, label] = l.match(/^\[\d+\] (\S+) \| (.*?)(?: \| |$)/);
      assert.equal(tag.replace(/[[(].*$/, ''), el.tagName.toLowerCase(), l);
      let want = el.tagName === 'INPUT' ? norm(el.placeholder) : (norm(el.textContent) || norm(el.getAttribute('aria-label')));
      if (want.length > 60) want = want.slice(0, 60) + '…';
      assert.equal(label, want, l);
      if (lineOfN.has(n)) assert.equal(l, lineOfN.get(n), `[${n}] is printed differently in ${JSON.stringify(req)}`);
      else lineOfN.set(n, l);
    }
    // Inline markers sit in front of their own element's text.
    const body = r.text.split('\n').filter(l => !/^\[\d+\] \S+ \| /.test(l)).join('\n');
    for (const m of body.matchAll(/\[(\d+)\] ([^\[\n]{4,})/g)) {
      const el = w.__chromeBridge.markers[Number(m[1])];
      if (el && /^(A|BUTTON)$/.test(el.tagName) && norm(el.textContent)) {
        assert.ok(m[2].startsWith(norm(el.textContent).slice(0, 4)), `[${m[1]}] is followed by «${m[2].slice(0, 20)}», not its own text`);
      }
    }
  }
  assert.ok(lineOfN.size > 40, `only ${lineOfN.size} numbers were compared`);
});

t('round7: sections — the section after 12000 characters (cut in full mode) expands whole; a parent comes with its sub-sections; unknown and nested picks are said; an oversized section is cut and says so', () => {
  const w = longArticle();
  const full = runRead(w, FULL);
  assert.match(full.text, /正文过长已截断/);
  assert.doesNotMatch(full.text, /PINEAPPLE-42/, 'the fixture is meant to put the late section past the full-mode cut');
  let r = runRead(w, { sections: ['S12'] });
  assert.equal(r.mode, 'sections');
  assert.match(r.text, /=== S12 尾声（约 \d+ token，1 个可点）===/);
  assert.match(r.text, /藏在一万两千字之后的段落：暗号 PINEAPPLE-42。/);
  assert.match(r.text, new RegExp(`\\[${mk(w, '#late-btn')}\\] 尾声里的按钮`));
  assert.deepEqual(indexLines(r.text), [`[${mk(w, '#late-btn')}] button | 尾声里的按钮`]);
  assert.doesNotMatch(r.text, /【社会|Reference 1:/, 'nothing from the neighbouring sections');
  assert.equal(r.text.split('\n').at(-1), r.hint);

  r = runRead(w, { sections: ['s5'] });
  const s5 = between(r.text, '=== S5 历史');
  assert.match(s5, /^=== S5 历史（约 \d+ token，2 个可点，含子节 S6–S9）===\n子节：\nS6 早期（[^\n]*\nS7 殖民时期（[^\n]*\n  S8 海峡殖民地（[^\n]*\nS9 独立（/);
  for (const p of ['历史部分按时期分成三小节', '【早期·第 12 段】', '【殖民时期·第 1 段】', '【海峡殖民地·第 10 段】', '【独立·第 12 段】']) {
    assert.ok(s5.includes(p), `S5 lacks ${p}`);
  }
  assert.deepEqual(indexLines(s5).map(numOf), [mk(w, '#timeline-link'), mk(w, '#straits-more')]);
  assert.doesNotMatch(s5, /【经济/);

  r = runRead(w, { sections: ['S7'] });
  assert.match(r.text, /【海峡殖民地·第 3 段】/);
  assert.doesNotMatch(r.text, /【独立/, 'a sibling section is not part of it');

  r = runRead(w, { sections: ['S5', 'S8', 'S99', 'S12'] });
  assert.match(r.text, /（目录里没有 S99：目录是 S0–S13，不带参数的 read_page 可以看目录）/);
  assert.match(r.text, /（S8 在一起展开的大节里，不再单列）/);
  assert.deepEqual([...r.text.matchAll(/^=== (S\d+) /gm)].map(m => m[1]), ['S5', 'S12']);

  r = runRead(w, { sections: ['S13'] });
  assert.ok(r.text.length <= 12000, `${r.text.length} characters`);
  assert.match(r.text, /…（S13 超过这次的预算，只显示了前 \d+ 字，或用 query 找需要的内容）/);
  assert.match(r.text, /--- S13 里的可点击元素（302 个）---/);
});

t('round7: query — case-insensitive, with its section; element names count (aria-label); at most 20 listed; sections narrow it', () => {
  const w = longArticle();
  let r = runRead(w, { query: 'pineapple-42' });
  assert.equal(r.mode, 'query');
  assert.match(r.text, /=== 查找「pineapple-42」（不区分大小写）：找到 1 处 ===\nS12 尾声：\n  藏在一万两千字之后的段落：暗号 PINEAPPLE-42。/);
  r = runRead(w, { query: '打印' });
  assert.match(r.text, new RegExp(`找到 1 处 ===\\nS0 （第一个标题之前）：\\n  \\[${mk(w, '#print')}\\] button \\| 打印本页`));
  r = runRead(w, { query: 'REFERENCE' });
  assert.match(r.text, /找到 300 处/);
  assert.equal((between(r.text, 'S13 参考文献：', '…（另有').match(/^  \[\d+\] Reference /gm) || []).length, 20);
  assert.match(r.text, /…（另有 280 处没列出：换个更具体的词，或加 sections 限定在某几节里）/);
  assert.match(r.text, /--- 上面这些段落里的可点击元素 ---\n\[\d+\] a \| Reference 1:/);
  r = runRead(w, { query: '第 3 段', sections: ['S3'] });
  assert.match(r.text, /（不区分大小写，只在指定的节里）：找到 1 处 ===\nS3 气候：\n  【气候·第 3 段】/);
  r = runRead(w, { query: '第 3 段', sections: ['S5'] });
  assert.match(r.text, /找到 4 处/, 'S5 with its four sub-sections: 早期, 殖民时期, 海峡殖民地, 独立');
  r = runRead(w, { query: '没有这个词' });
  assert.match(r.text, /：没有找到 ===\n（查了整页的正文和元素的文字，都没有「没有这个词」）/);
  r = runRead(w, { query: 'pineapple', sections: ['S99'] });
  assert.match(r.text, /（sections 里的节号目录里都没有，查的是整页）\n=== 查找「pineapple」（不区分大小写）：找到 1 处/);
});

t('round7: this screen keeps an expanded list whole past the viewport edge; a portal layer that is off screen (a closed drawer) is left out', () => {
  const opts = Array.from({ length: 10 }, (_, i) => `<li role="option" data-rect="10,${740 + i * 60},200,30">城市 ${i}</li>`).join('');
  const w = makeDom(`<p data-rect="10,10,300,24">页首正文</p>
    <div id="cb" role="combobox" aria-expanded="true" aria-controls="lb" data-rect="10,700,200,30">选择城市</div>
    <p data-rect="10,2000,200,24">很远的正文</p>
    <ul id="lb" role="listbox" data-rect="10,740,200,600">${opts}</ul>
    <div id="drawer" style="position:fixed" data-rect="-400,0,300,800"><a href="/x" data-rect="-400,10,200,24">抽屉里的链接</a></div>`);
  const r = runRead(w);
  const screen = between(r.text, '=== 这一屏（', '\n提示：');
  const shown = indexLines(screen).map(numOf);
  for (let i = 0; i < 10; i++) assert.ok(shown.includes(markerByText(w, new RegExp(`^城市 ${i}$`))), `option ${i}`);
  assert.match(screen, /城市 9/);
  assert.doesNotMatch(screen, /抽屉里的链接|很远的正文/);
  assert.match(runRead(w, FULL).text, /抽屉里的链接/);
});

t('round7: no headings — the outline falls back to landmarks (nested, S0 for the rest); with neither, it says the page has no heading structure', () => {
  let w = makeDom(`
    <header><a href="/">首页</a> <a href="/login">登录</a></header>
    <nav aria-label="主菜单"><a href="/a">产品</a> <a href="/b">价格</a></nav>
    <main><p>主体正文</p><form aria-label="搜索表单"><input placeholder="搜索"> <button>搜</button></form>
      <article><header><p>文章自己的页首</p></header><p>文章正文</p></article></main>
    <aside><a href="/ad">侧栏链接</a></aside>
    <div><p>不在任何区域里的一段</p></div>
    <footer><a href="/about">关于</a></footer>`);
  let r = runRead(w);
  assert.match(r.text, /=== 页面目录（页面没有标题，按页面区域分节；7 节；/);
  // A region without a name is titled by its first 30 characters (jsdom has no innerText, so blocks run together here).
  assert.deepEqual(outlineRows(r.text).map(x => `${'  '.repeat(x.depth)}S${x.id} ${x.title}`), [
    'S0 （不在任何区域里的内容）', 'S1 页首「首页 登录」', 'S2 导航「主菜单」', 'S3 主体「主体正文 搜 文章自己的页首文章正文」',
    '  S4 表单「搜索表单」', 'S5 侧栏「侧栏链接」', 'S6 页脚「关于」']);
  r = runRead(w, { sections: ['S3'] });
  assert.match(r.text, /主体正文[\s\S]*输入框: 搜索[\s\S]*文章正文/);
  assert.doesNotMatch(r.text, /侧栏链接|不在任何区域里的一段/);
  r = runRead(w, { sections: ['S0'] });
  assert.match(r.text, /不在任何区域里的一段/);
  assert.doesNotMatch(r.text, /主体正文/);

  w = makeDom('<div><p>第一行</p><a href="/x">一个链接</a></div>');
  r = runRead(w);
  assert.match(r.text, /（这个页面没有标题结构，也没有页首、导航、主体这类区域标记，所以没有目录：找内容用 query，整页用 full=true）/);
  assert.doesNotMatch(r.text, /=== 页面目录|S0 /);
  assert.match(r.text, /=== 这一屏[\s\S]*\[1\] 一个链接/);
  assert.match(r.hint, /这个页面没有目录可展开/);
  assert.match(runRead(w, { sections: ['S1'] }).text, /没有标题结构，没有可展开的节/);
});

t('round7: an open modal comes first and whole in default mode, before the outline; its headings stay out of the outline; the page behind is flagged', () => {
  const plain = runRead(longArticle()).text;
  const w = longArticle({ modal: true });
  const r = runRead(w);
  const lines = r.text.split('\n');
  assert.equal(lines[0], '⚠️ 页面开着弹窗「订阅长文周报」：先列弹窗里的元素；弹窗外的元素被它挡住');
  const iModal = r.text.indexOf('--- 弹窗「订阅长文周报」里的内容 ---'), iOutline = r.text.indexOf('=== 页面目录'), iScreen = r.text.indexOf('=== 这一屏');
  assert.ok(iModal > 0 && iModal < iOutline && iOutline < iScreen, 'modal → outline → this screen');
  const modalPart = r.text.slice(iModal, iOutline);
  assert.match(modalPart, /每周一封，随时退订。/);
  assert.match(modalPart, /--- 弹窗里的可点击元素（3 个）---/);
  for (const sel of ['#promo-email', '#promo-sub', '#promo-close']) assert.ok(indexLines(modalPart).map(numOf).includes(mk(w, sel)), sel);
  assert.doesNotMatch(between(r.text, '=== 页面目录', '=== 这一屏'), /订阅长文周报/);
  assert.deepEqual(outlineRows(r.text).map(x => x.line), outlineRows(plain).map(x => x.line), 'same outline behind the modal');
  const screenLines = indexLines(between(r.text, '=== 这一屏的可点击元素'));
  assert.equal(screenLines.length, 6);
  for (const l of screenLines) assert.match(l, /\[被弹窗挡住\]$/);
  assert.match(r.text, /=== 这一屏：弹窗外的页面，元素都\[被弹窗挡住\]，先处理弹窗/);
  assert.match(runRead(w, { sections: ['S12'] }).text, /^⚠️ 页面开着弹窗「订阅长文周报」：下面的元素都被它挡住，先处理弹窗/);
  // Closed: no warning, the page keeps its numbers.
  const before = mk(w, '#late-btn');
  w.document.getElementById('promo-close').click();
  flowLayout(w);
  const after = runRead(w);
  assert.doesNotMatch(after.text, /页面开着弹窗|被弹窗挡住|订阅长文周报/);
  assert.equal(mk(w, '#late-btn'), before);
});

t('round7: budgets — this screen stays within 6000 characters, the outline within 2500 (two levels, then cut); full mode keeps its 12000', () => {
  const filler = Array.from({ length: 400 }, (_, i) => `<p>第 ${i} 段很长的正文内容，用来把这一屏撑到超过六千个字符的上限。</p>`).join('');
  const buttons = Array.from({ length: 200 }, (_, i) => `<button>按钮 ${i}</button>`).join('');
  let r = runRead(makeDom(`<h1>标题</h1>${filler}${buttons}`));
  const screen = between(r.text, '=== 这一屏（', '\n提示：');
  assert.ok(screen.length <= 6000, `this screen is ${screen.length} characters`);
  assert.match(screen, /这一屏的文字超过预算/);
  assert.match(screen, /索引已截断/);

  const deep = Array.from({ length: 10 }, (_, i) => `<h2>第 ${i} 章</h2>` + Array.from({ length: 3 }, (_, j) =>
    `<h3>第 ${i}.${j} 节</h3>` + Array.from({ length: 4 }, (_, k) => `<h4>第 ${i}.${j}.${k} 小节</h4><p>正文</p>`).join('')).join('')).join('');
  r = runRead(makeDom(deep));
  let outline = between(r.text, '=== 页面目录', '=== 这一屏');
  assert.ok(outline.length <= 2500, `outline ${outline.length}`);
  assert.match(outline, /（目录太长，只列了前两层；展开一节时会列出它的子节）/);
  const rows = outlineRows(r.text);
  assert.equal(rows.length, 10 + 30, 'all h2 and h3, no h4');
  assert.doesNotMatch(outline, /还有 \d+ 行目录没列出/);
  assert.ok(rows.every(x => x.depth <= 1));
  assert.ok(rows.filter(x => x.depth === 1).every(x => x.folded === 4), 'each h3 says it holds 4 sub-sections');

  const wide = Array.from({ length: 300 }, (_, i) => `<h2>第 ${i} 章</h2><h3>第 ${i}.1 节</h3><p>正文</p>`).join('');
  r = runRead(makeDom(wide));
  outline = between(r.text, '=== 页面目录', '=== 这一屏');
  assert.ok(outline.length <= 2500, `outline ${outline.length}`);
  assert.match(outline, /…（还有 \d+ 行目录没列出：用 query 找，或展开前面的节）/);

  r = runRead(makeDom(`<h1>标题</h1>${filler}${buttons}`), FULL);
  assert.ok(r.text.length <= 12000 && r.text.length > 9000, `full mode ${r.text.length}`);
});

console.log('\nsrc/page/locate.js (jsdom, layout stubbed)');

/**
 * More layout for locate.js: client/scroll extents from data attributes
 * (data-client-h, data-scroll-h, data-scroll-top), a hit test that respects
 * clipping ancestors (topmost = last in document order, like painting), and
 * Range rects taken from the text's parent element.
 */
function withLayout(w, { docScrollH = 812 } = {}) {
  const P = w.Element.prototype;
  const num = (el, a, d) => (el.hasAttribute(a) ? Number(el.getAttribute(a)) : d);
  const def = (name, get) => Object.defineProperty(P, name, { get, configurable: true });
  def('clientWidth', function () { return num(this, 'data-client-w', this.getBoundingClientRect().width); });
  def('clientHeight', function () { return num(this, 'data-client-h', this.getBoundingClientRect().height); });
  def('scrollHeight', function () {
    return this === w.document.documentElement ? docScrollH : num(this, 'data-scroll-h', this.clientHeight);
  });
  def('scrollWidth', function () { return num(this, 'data-scroll-w', this.clientWidth); });
  def('scrollTop', function () { return num(this, 'data-scroll-top', 0); });
  def('clientTop', () => 0);
  def('clientLeft', () => 0);
  w.document.elementFromPoint = (x, y) => {
    let hit = null;
    const inRect = (r) => r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    for (const el of w.document.body.querySelectorAll('*')) {
      if (!inRect(el.getBoundingClientRect())) continue;
      let clipped = false;
      for (let a = el.parentElement; a && a !== w.document.body; a = a.parentElement) {
        const st = w.getComputedStyle(a);
        if ((st.overflowX !== 'visible' || st.overflowY !== 'visible') && !inRect(a.getBoundingClientRect())) clipped = true;
      }
      if (!clipped) hit = el;
    }
    // Like a browser: empty space inside the viewport hits <body>.
    return hit || (x >= 0 && y >= 0 && x <= w.innerWidth && y <= w.innerHeight ? w.document.body : null);
  };
  w.Range.prototype.getClientRects = function () {
    const host = this.startContainer.nodeType === 3 ? this.startContainer.parentElement : this.startContainer;
    return [host.getBoundingClientRect()];
  };
  // Any scroll from a page script is a failure in target mode (plan D1).
  const calls = { scrollIntoView: [], scrollTo: 0, scrollBy: 0 };
  P.scrollIntoView = function (o) { calls.scrollIntoView.push(o); };
  w.scrollTo = () => { calls.scrollTo++; };
  w.scrollBy = () => { calls.scrollBy++; };
  return calls;
}

function runLocate(w, marker, { mode = 'target', scroll = false, dir = null } = {}) {
  const vars = { MARKER: marker, MODE: mode, SCROLL: scroll, DIR: dir };
  let src = locateSrc;
  for (const [k, v] of Object.entries(vars)) src = src.replaceAll(`__${k}__`, () => JSON.stringify(v));
  return JSON.parse(w.eval(src));
}
function runAfter(w, marker, expect = null, bind = null) {
  const src = afterSrc.replaceAll('__MARKER__', () => JSON.stringify(marker))
                      .replaceAll('__EXPECT__', () => JSON.stringify(expect))
                      .replaceAll('__BIND__', () => JSON.stringify(bind));
  return JSON.parse(w.eval(src));
}
const markerOf = (w, sel) => w.__chromeBridge.markers.indexOf(w.document.querySelector(sel));
function runAck(w, ack) {
  return JSON.parse(w.eval(ackSrc.replaceAll('__ACK__', () => JSON.stringify(ack))));
}

t('resolves a marker to its full rect, visible rect, aim and window metrics — without scrolling', () => {
  const w = makeDom(FIXTURE);
  const calls = withLayout(w);
  runRead(w);
  const n = markerOf(w, '#cart');
  const loc = runLocate(w, n);
  assert.equal(loc.ok, true);
  assert.equal(loc.tag, 'button');
  assert.equal(loc.text, '加入购物车');
  assert.deepEqual(loc.rect, { x: 10, y: 10, width: 120, height: 24 });
  assert.deepEqual(loc.visible, { x: 10, y: 10, width: 120, height: 24 });
  assert.deepEqual(loc.aim, { x: 70, y: 22 });
  assert.equal(loc.view.innerHeight, 812);
  assert.equal(loc.programmaticScroll, false);
  assert.deepEqual(calls, { scrollIntoView: [], scrollTo: 0, scrollBy: 0 }, 'locate.js scrolled the page');
});

t('refuses a marker number that does not exist', () => {
  const w = makeDom(FIXTURE);
  withLayout(w);
  runRead(w);
  const loc = runLocate(w, 9999);
  assert.equal(loc.ok, false);
  assert.equal(loc.error, 'no_such_marker');
  assert.match(loc.message, /可用范围 1\.\.12/);
});

t('refuses when read_page has not run on this page', () => {
  const w = makeDom(FIXTURE);
  const loc = runLocate(w, 1);
  assert.equal(loc.ok, false);
  assert.equal(loc.error, 'stale');
  assert.match(loc.message, /重新调用 read_page/);
});

t('detects a stale marker after the element is removed', () => {
  const w = makeDom(FIXTURE);
  withLayout(w);
  runRead(w);
  const n = markerOf(w, '#cart');
  w.document.getElementById('cart').remove();
  const loc = runLocate(w, n);
  assert.equal(loc.ok, false);
  assert.equal(loc.error, 'stale');
});

t('a rect hanging off the top: full rect kept, visible part clipped to the viewport', () => {
  const w = makeDom('<button data-rect="-50,-10,200,60">半露在外</button>');
  withLayout(w);
  runRead(w);
  const loc = runLocate(w, 1);
  assert.equal(loc.ok, true);
  assert.deepEqual(loc.rect, { x: -50, y: -10, width: 200, height: 60 });
  assert.deepEqual(loc.visible, { x: 0, y: 0, width: 150, height: 50 });
});

t('an element entirely outside the viewport is reported, not refused and not scrolled', () => {
  const w = makeDom('<button data-rect="300,3000,100,30">很远</button>');
  const calls = withLayout(w, { docScrollH: 4000 });
  runRead(w);
  const loc = runLocate(w, 1);
  assert.equal(loc.ok, true);
  assert.equal(loc.visible, null);
  assert.equal(loc.hitOk, false);
  const doc = loc.chain.at(-1);
  assert.equal(doc.document, true);
  assert.equal(doc.scrollableY, true);
  assert.equal(doc.maxTop, 4000 - 812);
  assert.ok(doc.wheel.down, 'a pointer spot that scrolls the document down');
  assert.equal(doc.wheel.up, null, 'the document is at the top: it cannot scroll up');
  assert.equal(calls.scrollIntoView.length, 0);
});

t('SCROLL=true (the labelled fallback) uses scrollIntoView block:nearest, never centre', () => {
  const w = makeDom('<button data-rect="300,3000,100,30">很远</button>');
  const calls = withLayout(w, { docScrollH: 4000 });
  runRead(w);
  const loc = runLocate(w, 1, { scroll: true });
  assert.equal(loc.programmaticScroll, true);
  assert.equal(calls.scrollIntoView.length, 1);
  assert.equal(calls.scrollIntoView[0].block, 'nearest');
  assert.equal(calls.scrollIntoView[0].inline, 'nearest');
});

// Longhands: jsdom's computed style does not expand the `overflow` shorthand (Chrome does).
const NESTED = `
  <div id="outer" style="overflow-y:auto" data-rect="0,0,1400,812" data-scroll-h="3000">
    <p data-rect="0,0,1400,700">正文</p>
    <div id="inner" style="overflow-y:auto" data-rect="100,1500,600,300" data-scroll-h="1200">
      <button id="deep" data-rect="120,1900,200,40">Deep</button>
    </div>
  </div>`;

t('the whole clip/scroll ancestor chain comes back, innermost first, with extents and wheel spots', () => {
  const w = makeDom(NESTED);
  withLayout(w);
  runRead(w);
  const loc = runLocate(w, markerOf(w, '#deep'));
  assert.equal(loc.ok, true);
  assert.deepEqual(loc.chain.map(c => c.sig), ['div#inner', 'div#outer', 'document']);
  const [inner, outer, doc] = loc.chain;
  assert.equal(inner.scrollableY, true);
  assert.equal(inner.maxTop, 900);
  assert.equal(inner.visible, null, 'the inner scroller itself is below the fold');
  assert.deepEqual(inner.wheel, { down: null, up: null }, 'no pointer spot can reach it yet');
  assert.equal(outer.maxTop, 3000 - 812);
  assert.ok(outer.wheel.down, 'the outer scroller is reachable');
  assert.equal(doc.scrollableY, false);
  assert.equal(loc.visible, null);
});

const { planScrollStep } = await import('../src/guard.js');
t('locate → planScrollStep: the outer scroller moves first, at a spot where the wheel reaches it', () => {
  const w = makeDom(NESTED);
  withLayout(w);
  runRead(w);
  const loc = runLocate(w, markerOf(w, '#deep'));
  const step = planScrollStep(loc, { rng: () => 0.5 });
  assert.equal(step.sig, 'div#outer');
  assert.equal(step.dir, 'down');
  const hit = w.document.elementFromPoint(step.point.x, step.point.y);
  assert.ok(w.document.getElementById('outer').contains(hit));
  assert.ok(!w.document.getElementById('inner').contains(hit), 'the spot is not over the inner scroller');
});

t('a wide element is aimed at its text label, not its geometric centre (plan B9)', () => {
  const w = makeDom('<a href="/x" data-rect="0,100,600,30"><span data-rect="20,105,80,20">Buy now</span></a>');
  withLayout(w);
  runRead(w);
  const loc = runLocate(w, 1);
  assert.equal(loc.aimAt, 'label');
  assert.deepEqual(loc.aim, { x: 60, y: 115 });
  assert.equal(loc.hitOk, true);
});

t('hit test: a partly covered target is aimed at its uncovered part; a fully covered one is not hit', () => {
  let w = makeDom('<button data-rect="100,100,200,40">A</button><div class="cookie-bar" data-rect="0,90,1400,40">cookie</div>');
  withLayout(w);
  runRead(w);
  let loc = runLocate(w, 1);
  assert.equal(loc.hitOk, true);
  assert.equal(loc.aimAt, 'uncovered');
  assert.equal(loc.hitBy, 'div.cookie-bar');
  assert.ok(loc.aim.y > 130, `aim ${loc.aim.y} is under the bar`);

  w = makeDom('<button data-rect="100,100,200,40">A</button><div class="cookie-bar" data-rect="0,90,1400,60">cookie</div>');
  withLayout(w);
  runRead(w);
  loc = runLocate(w, 1);
  assert.equal(loc.hitOk, false);
  assert.equal(loc.hitBy, 'div.cookie-bar');
});

t('codex1-5/A1: a link wrapped over two lines lands only in the fragment that holds the aim', () => {
  const w = makeDom('<a id="wrap" href="/t" data-rect="100,300,700,48"><span data-rect="500,300,300,24">Title part one</span></a>' +
                    '<span id="before" data-rect="100,300,400,24">preceding text</span>');
  withLayout(w);
  const a = w.document.getElementById('wrap');
  const frag = (x, y, width, height) => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height });
  a.getClientRects = () => [frag(500, 300, 300, 24), frag(100, 324, 300, 24)];
  runRead(w);
  const loc = runLocate(w, markerOf(w, '#wrap'));
  assert.equal(loc.aimAt, 'label');
  assert.equal(loc.hitOk, true);
  assert.deepEqual(loc.visible, { x: 100, y: 300, width: 700, height: 48 }, 'the bounding box includes the gap');
  assert.deepEqual(loc.land, { x: 500, y: 300, width: 300, height: 24 });
});

t('codex1-5/A1: a badge over one corner of an otherwise clear target shrinks the landing rect around the aim', () => {
  const w = makeDom('<button id="card" data-rect="100,300,400,200">Card</button><div class="badge" data-rect="420,300,80,60">3</div>');
  withLayout(w);
  runRead(w);
  const loc = runLocate(w, markerOf(w, '#card'));
  assert.equal(loc.aimAt, 'center', 'the centre itself is clear');
  const l = loc.land;
  const inner = { x0: l.x + l.width * 0.1, x1: l.x + l.width * 0.9, y0: l.y + l.height * 0.1, y1: l.y + l.height * 0.9 };
  assert.ok(!(inner.x1 > 420 && inner.y0 < 360), `landing rect ${JSON.stringify(l)} still reaches the badge`);
  assert.ok(l.x <= loc.aim.x && loc.aim.x <= l.x + l.width && l.y <= loc.aim.y && loc.aim.y <= l.y + l.height);
});

t('codex1-5/A1: a plain uncovered element lands anywhere in its visible rect (no needless shrinking)', () => {
  const w = makeDom('<button data-rect="200,300,100,50">买</button>');
  withLayout(w);
  runRead(w);
  const loc = runLocate(w, 1);
  assert.deepEqual(loc.land, loc.visible);
});

t('codex1-5/A1: a partly covered target lands only in the uncovered part', () => {
  const w = makeDom('<button data-rect="100,100,200,40">A</button><div class="cookie-bar" data-rect="0,90,1400,40">cookie</div>');
  withLayout(w);
  runRead(w);
  const loc = runLocate(w, 1);
  assert.equal(loc.aimAt, 'uncovered');
  assert.ok(loc.land.y + loc.land.height * 0.1 > 130, `landing rect ${JSON.stringify(loc.land)} reaches under the bar`);
});

t('A2: a target inside a position:fixed layer: the document is marked as not moving it', () => {
  const w = makeDom('<header style="position:fixed" data-rect="0,0,1400,60"><a id="h" href="/x" data-rect="100,20,100,24">Home</a></header>' +
                    '<p data-rect="0,100,1400,3000">body</p>');
  withLayout(w, { docScrollH: 4000 });
  Object.defineProperty(w, 'scrollY', { get: () => 3000, configurable: true });
  runRead(w);
  const loc = runLocate(w, markerOf(w, '#h'));
  assert.equal(loc.fixed, true);
  assert.equal(loc.chain.at(-1).scrollTop, 3000);
  assert.equal(loc.chain.at(-1).movesAim, false);
  assert.equal(planScrollStep(loc, { rng: () => 0.5 }).done, true, 'a fixed header link needs no wheel');
});

t('hadFocus: whether keyboard focus was already on the target before the click', () => {
  const w = makeDom(FIXTURE);
  withLayout(w);
  runRead(w);
  w.document.getElementById('qty').focus();
  assert.equal(runLocate(w, markerOf(w, '#qty')).hadFocus, true);
  assert.equal(runLocate(w, markerOf(w, 'label[for=qty]')).hadFocus, true, 'a label counts its control');
  const cart = runLocate(w, markerOf(w, '#cart'));
  assert.equal(cart.hadFocus, false, JSON.stringify(cart).slice(0, 300));
});

t('MODE scroll: the document when it can scroll, and MODE measure reads it back', () => {
  const w = makeDom('<p data-rect="0,0,1400,800">长页面</p>');
  withLayout(w, { docScrollH: 3000 });
  const st = runLocate(w, null, { mode: 'scroll', dir: 'down' });
  assert.equal(st.scroller, 'document');
  assert.equal(st.height, 812);
  assert.equal(st.max, 3000 - 812);
  assert.ok(st.points.length > 0 && st.points.length <= 5);
  const m = runLocate(w, null, { mode: 'measure' });
  assert.deepEqual([m.scrollTop, m.max], [0, 3000 - 812]);
});

t('MODE scroll: a page that scrolls an inner container gets that container', () => {
  const w = makeDom(NESTED);
  withLayout(w);
  const st = runLocate(w, null, { mode: 'scroll', dir: 'down' });
  assert.equal(st.scroller, 'div#outer');
  assert.ok(st.points.length > 0);
  assert.equal(runLocate(w, null, { mode: 'scroll', dir: 'up' }).scroller, null, 'nothing can scroll up');
});

console.log('\nsrc/page/after.js (jsdom)');

t('focus report: document focus, target (label → its control), editable, and a yes/no text check', () => {
  const w = makeDom(FIXTURE);
  withLayout(w);
  runRead(w);
  w.document.hasFocus = () => true;
  const qty = w.document.getElementById('qty');
  qty.focus();
  qty.value = 'hello   world';
  const r = runAfter(w, markerOf(w, 'label[for=qty]'), 'hello world');
  assert.equal(r.hasFocus, true);
  assert.equal(r.activeIsTarget, true);
  assert.equal(r.activeEditable, true);
  assert.equal(r.fieldHasText, true, 'runs of spaces compare equal');
  assert.equal(runAfter(w, null, 'goodbye').fieldHasText, false);
  assert.equal(runAfter(w, null).fieldHasText, null);
  assert.ok(!JSON.stringify(runAfter(w, null, 'hello')).includes('"hello world'), 'field content is not returned');
});

t('a button is not an editable field; no focus in the document is reported as such', () => {
  const w = makeDom(FIXTURE);
  withLayout(w);
  runRead(w);
  w.document.getElementById('cart').focus();
  const r = runAfter(w, markerOf(w, '#cart'));
  assert.equal(r.activeIsTarget, true);
  assert.equal(r.activeEditable, false);
  w.document.hasFocus = () => false;
  assert.equal(runAfter(w, null).hasFocus, false);
});

t('codex1-6: with a bound field, another field holding the same text does not confirm typing', () => {
  const w = makeDom('<input id="a" data-rect="0,0,300,30"><input id="b" data-rect="0,40,300,30">');
  withLayout(w);
  w.document.hasFocus = () => true;
  const a = w.document.getElementById('a'), b = w.document.getElementById('b');
  a.focus();
  const set = runAfter(w, null, null, { set: 'tok1' });
  assert.equal(set.bound, true);
  a.value = 'hello';
  assert.equal(runAfter(w, null, 'hello', { check: 'tok1' }).fieldHasText, true);
  b.value = 'hello';
  b.focus();
  const moved = runAfter(w, null, 'hello', { check: 'tok1' });
  assert.equal(moved.fieldHasText, false, 'the other field confirmed the typing');
  assert.equal(moved.focusMoved, true);
  assert.equal(runAfter(w, null, 'hello').fieldHasText, true, 'without a binding the old check is unchanged');
  a.focus();
  assert.equal(runAfter(w, null, 'hello', { check: 'other-token' }).fieldHasText, false, 'a stale token binds nothing');
  w.document.hasFocus = () => false;
  assert.equal(runAfter(w, null, 'hello', { check: 'tok1' }).fieldHasText, false, 'the document lost keyboard focus');
  w.document.hasFocus = () => true;
  w.history.pushState({}, '', '/page?q=hello');
  assert.equal(runAfter(w, null, 'hello', { check: 'tok1' }).fieldHasText, true, 'a URL change while typing does not unbind the field');
});

t('codex2-8: text already in the field, or whitespace, never confirms input that did not arrive', () => {
  const w = makeDom('<input id="a" data-rect="0,0,300,30"><div id="ce" contenteditable="true" data-rect="0,40,300,60"></div>');
  withLayout(w);
  w.document.hasFocus = () => true;
  const a = w.document.getElementById('a');
  a.value = 'hello world';
  a.focus();
  a.setSelectionRange(11, 11);
  runAfter(w, null, null, { set: 'b1' });
  // The page dropped the keystrokes: the field is exactly as before.
  let r = runAfter(w, null, 'hello', { check: 'b1' });
  assert.deepEqual([r.fieldHasText, r.changed], [false, false], 'text that was already there confirmed the typing');
  // Whitespace-only text normalizes to "": an unchanged field must not confirm it.
  assert.equal(runAfter(w, null, ' ', { check: 'b1' }).fieldHasText, false);
  // The text really arrived (a second occurrence) → confirmed.
  a.value = 'hello worldhello';
  r = runAfter(w, null, 'hello', { check: 'b1' });
  assert.deepEqual([r.fieldHasText, r.changed], [true, true]);
  // A change that is not our text does not confirm it either.
  a.value = 'hello world!';
  assert.equal(runAfter(w, null, 'hello', { check: 'b1' }).fieldHasText, false);
  // Typed over a selection that held the same word: the caret position proves it.
  a.value = 'say hi';
  a.setSelectionRange(4, 6);
  runAfter(w, null, null, { set: 'b2' });
  a.value = 'say hi there';
  assert.equal(runAfter(w, null, 'hi there', { check: 'b2' }).fieldHasText, true);
  // Whitespace that really arrived grows the field by at least what was sent.
  const ce = w.document.getElementById('ce');
  ce.focus();
  ce.textContent = 'x';
  runAfter(w, null, null, { set: 'b3' });
  assert.equal(runAfter(w, null, '  ', { check: 'b3' }).fieldHasText, false);
  ce.textContent = 'x  ';
  assert.equal(runAfter(w, null, '  ', { check: 'b3' }).fieldHasText, true);
});

t('codex2-5: the delivery listener counts only trusted click / pointerup / key-ups, one-shot, per token', () => {
  const w = makeDom('<button id="b" data-rect="0,0,100,30">B</button><input id="i" data-rect="0,40,100,30">');
  const b = w.document.getElementById('b');
  assert.deepEqual(runAck(w, { arm: 't1' }), { ok: true, armed: true });
  b.click();   // an untrusted (script) click proves nothing
  let r = runAck(w, { read: 't1', need: { click: 1 } });
  assert.deepEqual([r.armed, r.met, r.click], [true, false, 0]);
  dispatchTrusted(b, new w.MouseEvent('click', { bubbles: true }));
  r = runAck(w, { read: 't1', need: { click: 1, pointerup: 1 } });
  assert.deepEqual([r.met, r.click], [true, 1]);
  assert.equal(runAck(w, { read: 't1' }).armed, false, 'one-shot: removed once met');
  dispatchTrusted(b, new w.MouseEvent('click', { bubbles: true }));
  assert.equal(runAck(w, { read: 't1' }).click, 0);
  // Key-ups: modifiers and Cmd shortcuts are not counted.
  runAck(w, { arm: 't2' });
  const i = w.document.getElementById('i');
  for (const init of [{ key: 'Shift' }, { key: 'H' }, { key: 'v', metaKey: true }, { key: 'i' }]) {
    dispatchTrusted(i, new w.KeyboardEvent('keyup', { bubbles: true, ...init }));
  }
  r = runAck(w, { read: 't2', need: { keyup: 3 } });
  assert.deepEqual([r.keyup, r.lastKey, r.met], [2, 'i', false]);
  assert.equal(runAck(w, { read: 'other' }).armed, false, 'another token reads nothing');
  assert.equal(runAck(w, { read: 't2', disarm: true }).armed, true);
  assert.equal(runAck(w, { read: 't2' }).armed, false);
  // Invisible to page scripts in Chrome (isolated world, F1); here: no DOM writes.
  assert.equal(w.document.body.innerHTML.includes('chromeBridge'), false);
});

t('a password field value never appears in the report; contenteditable counts as editable', () => {
  const w = makeDom('<input id="pw" type="password"><div id="ce" contenteditable="true" data-rect="0,0,300,100">草稿</div>');
  w.document.getElementById('pw').focus();
  w.document.getElementById('pw').value = 's3cret-value';
  const r = runAfter(w, null, 's3cret');
  assert.equal(r.fieldHasText, true);
  assert.ok(!JSON.stringify(r).includes('s3cret'), 'password leaked');
  w.document.getElementById('ce').focus();
  const c = runAfter(w, null, '草稿');
  assert.equal(c.activeEditable, true);
  assert.equal(c.fieldHasText, true);
});

console.log('\nsrc/page/*.js — no DOM writes, no page-visible scrolling (plan E7, A1, D1)');

const pageSources = {};
for (const name of ['read', 'locate', 'after', 'probe', 'ack']) {
  pageSources[name] = await readFile(path.join(ROOT, `src/page/${name}.js`), 'utf8');
}
t('the injected scripts never write to the DOM, and only locate.js may scroll (behind SCROLL)', () => {
  for (const [name, src] of Object.entries(pageSources)) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const re of [/setAttribute\s*\(/, /removeAttribute\s*\(/, /\.dataset\b/, /appendChild\s*\(/,
                      /insertBefore\s*\(/, /innerHTML\s*=/, /classList\./, /\.style\.\w+\s*=/,
                      /scrollBy\s*\(/, /scrollTo\s*\(/, /\.scrollTop\s*=[^=]/]) {
      assert.doesNotMatch(code, re, `${name}.js: ${re}`);
    }
    if (name !== 'locate') assert.doesNotMatch(code, /scrollIntoView/, `${name}.js scrolls`);
  }
  const loc = pageSources.locate.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal((loc.match(/scrollIntoView\(/g) || []).length, 2, 'scrollIntoView appears only in the SCROLL fallback (+ its catch)');
  assert.match(loc, /if \(SCROLL\) \{\s*try \{ el\.scrollIntoView\(\{ block: 'nearest'/);
});

console.log('\nlocate.js -> coords.js (the whole click pipeline, minus Chrome)');

{
  const { viewportOrigin, rectToScreenRect, toScreen } = await import('../src/coords.js');
  t('locate output becomes the helper rect and aim, both on the element', () => {
    const w = makeDom('<button data-rect="200,300,100,50">买</button>');
    withLayout(w);
    runRead(w);
    const loc = runLocate(w, 1);
    // Same window as test/coords.test.mjs: 1400x900 pt at (100, 60), 88px toolbar.
    const bounds = { left: 100, top: 60, width: 1400, height: 900 };
    const origin = viewportOrigin(bounds, loc.view);
    assert.deepEqual(rectToScreenRect(loc.visible, origin), { x: 300, y: 448, w: 100, h: 50 });
    assert.deepEqual(toScreen(loc.aim, origin), { x: 350, y: 473 });
  });
}


console.log('\nindex.js tool flows (jsdom page + the helper in DRY-RUN; no Chrome, nothing posted)');

/* The real click / type_text / scroll code of src/index.js, with every Chrome
 * call answered from a jsdom page and every input op going to `cgevent
 * session` in DRY-RUN. A small model stands in for the browser: a wheel
 * scrolls whatever is under the pointer, a click focuses and clicks the
 * element under the landing point, typed or pasted text lands in the focused
 * field. Lock and tab registry live in a temp dir. */
{
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-bridge-e2e-'));
  process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'input.lock');
  process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
  process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
  await fs.writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ windowId: 1 }));
  const bridge = await import('../src/bridge.js');
  // No desktop notifications from tests.
  process.env.CHROME_BRIDGE_NOTIFY = '0';
  const idx = await import('../src/index.js');
  // The tests below check single attempts in the polite mode; the in-call
  // retry and the takeover have their own tests.
  idx.__setRetryForTests({ maxMs: 0 });
  idx.__setTakeoverForTests(false);
  const { toScreen, viewportOrigin } = await import('../src/coords.js');
  const fsSync = await import('node:fs');
  const tabsMod = await import('../src/tabs.js');

  const BOUNDS = { left: 100, top: 60, width: 1400, height: 900 };
  const E2E = `
    <p data-rect="0,0,1400,190">顶部</p>
    <button id="near" data-rect="100,200,160,40">Near</button>
    <input id="q" data-rect="100,300,300,30" placeholder="搜索">
    <button id="plain" data-rect="100,400,160,40">Plain</button>
    <button id="far" data-rect="100,2000,160,40">Far</button>
    <div id="box" style="overflow-y:auto" data-rect="600,100,500,300" data-scroll-h="1500">
      <button id="inbox" data-rect="620,900,160,40">In box</button>
    </div>
    <button id="hid" data-rect="100,500,160,40">Hidden</button>
    <div class="modal" data-rect="80,490,300,80">modal</div>
    <div id="clip" style="overflow-y:hidden" data-rect="600,500,300,100">
      <button id="clipped" data-rect="620,700,100,30">Clipped</button>
    </div>
    <input id="q2" data-rect="100,700,300,30">
    <select id="sel" data-rect="420,300,160,30"><option>—</option><option>i</option><option>ii</option><option>iii</option><option>iv</option><option>v</option><option>vi</option></select>`;

  function page() {
    const w = makeDom(E2E);
    const calls = withLayout(w, { docScrollH: 3000 });
    const state = { sy: 0 };
    Object.defineProperty(w, 'scrollY', { get: () => state.sy, configurable: true });
    const base = w.Element.prototype.getBoundingClientRect;
    // Rects are given at scroll 0; scrolling ancestors and the document shift
    // them, except for a data-sticky element (stuck at its place).
    w.Element.prototype.getBoundingClientRect = function () {
      const r = base.call(this);
      if (this.hasAttribute('data-sticky')) return r;
      let dy = state.sy;
      for (let a = this.parentElement; a && a !== w.document.body; a = a.parentElement) {
        if (a.hasAttribute('data-scroll-top')) dy += Number(a.getAttribute('data-scroll-top'));
      }
      const y = r.y - dy;
      return { ...r, y, top: y, bottom: y + r.height, toJSON() { return this; } };
    };
    w.document.hasFocus = () => true;
    const clicks = {};
    for (const b of w.document.querySelectorAll('button')) {
      b.addEventListener('click', () => { clicks[b.id] = (clicks[b.id] || 0) + 1; });
    }
    w.document.getElementById('near').addEventListener('click', () => w.history.pushState({}, '', '/near-done'));
    runRead(w);
    return { w, state, clicks, calls };
  }

  const origin = viewportOrigin(BOUNDS, { innerWidth: 1400, innerHeight: 812, outerWidth: 1400, outerHeight: 900 });
  const toView = (p) => ({ x: p.x - origin.originX, y: p.y - origin.originY });
  let pg, log, opts, pbN = 0;

  function applyWheel(pt, dir, sent) {
    const { w, state } = pg;
    const v = toView(pt);
    const down = dir === 'down';
    for (let a = w.document.elementFromPoint(v.x, v.y); a && a !== w.document.body; a = a.parentElement) {
      if (!a.hasAttribute('data-scroll-h')) continue;
      const top = Number(a.getAttribute('data-scroll-top') || 0), max = a.scrollHeight - a.clientHeight;
      if (down ? top >= max : top <= 0) continue;
      a.setAttribute('data-scroll-top', String(Math.max(0, Math.min(max, top + (down ? 40 : -40) * sent))));
      return;
    }
    const max = 3000 - 812;
    state.sy = Math.max(0, Math.min(max, state.sy + (down ? 40 : -40) * sent));
  }
  function applyClick(pt) {
    const v = toView(pt);
    const el = pg.w.document.elementFromPoint(v.x, v.y);
    log.push(`click on ${el && el.id}`);
    if (!el) return;
    if (typeof el.focus === 'function') el.focus();
    // What Chrome delivers for a real press (trusted), unless the page "swallows" it.
    if (!opts.noAck) dispatchTrusted(el, new pg.w.PointerEvent('pointerup', { bubbles: true }));
    el.click();
  }
  /** Blink's type-ahead on a focused, closed <select> (a run of one character steps through its matches). */
  function typeahead(sel, text) {
    const o = [...sel.options], n = (x) => x.text.trim().toLowerCase(), t = text.toLowerCase();
    let k = sel.selectedIndex;
    if (/^(.)\1*$/.test(t)) {
      for (const ch of t) for (let j = 1; j <= o.length; j++) { const q = (k + j) % o.length; if (n(o[q]).startsWith(ch)) { k = q; break; } }
    } else {
      for (let j = 0; j < o.length; j++) { const q = (sel.selectedIndex + j) % o.length; if (n(o[q]).startsWith(t)) { k = q; break; } }
    }
    if (k !== sel.selectedIndex) { sel.selectedIndex = k; sel.dispatchEvent(new pg.w.Event('change', { bubbles: true })); }
  }
  function applyText(text) {
    if (opts.swallowText) return;
    const ae = pg.w.document.activeElement;
    if (ae && ae.tagName === 'SELECT') { if (!opts.noTypeahead) typeahead(ae, text); return; }
    if (ae && 'value' in ae) ae.value += text.replace(/\t/g, '    ');
  }
  /** The key-ups the page sees for a `type` op (tab = 4 spaces, newline = Return). */
  function applyKeyups(text) {
    if (opts.noKeyups) return;
    const ae = pg.w.document.activeElement || pg.w.document.body;
    for (const c of text.replace(/\r\n/g, '\n').replace(/\t/g, '    ')) {
      dispatchTrusted(ae, new pg.w.KeyboardEvent('keyup', { bubbles: true, key: c === '\n' || c === '\r' ? 'Enter' : c }));
    }
  }

  /** OCR lines in full-resolution (2×) pixels, top-left origin, as `cgevent ocr` gives them. */
  const FAKE_OCR = [
    { text: '登录', conf: 1, x: 400, y: 200, w: 200, h: 40 },
    { text: 'Sign up', conf: 1, x: 900, y: 204, w: 160, h: 36 },
    { text: '第一行正文，说明这页是做什么的', conf: 1, x: 300, y: 400, w: 900, h: 40 },
    { text: '第二行正文紧接着第一行', conf: 0.5, x: 300, y: 446, w: 700, h: 40 },
    { text: 'Footer', conf: 0.3, x: 300, y: 1500, w: 200, h: 40 }
  ];
  function fakeShot(rect, how) {
    const fw = Math.round(rect.w * 2), fh = Math.round(rect.h * 2), k = Math.min(1, 1568 / Math.max(fw, fh));
    const shot = { data: 'iVBORw0KGgo=', width: Math.round(fw * k), height: Math.round(fh * k), fullPath: `/fake/${how}.png`,
      fullWidth: fw, fullHeight: fh, rect, popups: 0, how, dispose: async () => { log.push(`dispose ${how}`); } };
    opts.lastShot = shot;
    return shot;
  }

  function fakeBridge() {
    const target = (extra = {}) => ({
      ok: true, tabId: 5, windowId: 1, url: pg.w.location.href, title: '测试页面', tabActive: true,
      windowIndex: 1, minimized: false, tabCount: 1, bounds: BOUNDS, chromePid: 42, cgWindow: 7,
      frontmost: 'Google Chrome', ...extra
    });
    return {
      activateChrome: async (tab, hint) => { log.push('activate'); opts.lastHint = hint; return target({ targetOnTop: true, keyWindowIsTarget: opts.keyWindow !== false, waitedMs: 40 }); },
      chromeInfo: async (tab) => {
        log.push('info');
        if (opts.onChromeInfo) opts.onChromeInfo(tab);
        return opts.chromeInfo ? opts.chromeInfo(tab, target) : target(opts.info || {});
      },
      openTab: async (url, windowId, o) => {
        log.push(`openTab ${url} ${windowId} select=${!!(o && o.select)} lock=${fsSync.existsSync(process.env.CHROME_BRIDGE_LOCK)}`);
        opts.extraTabs = [{ id: 88, url, title: 'new', active: !!(o && o.select) }];
        return { ok: true, tabId: 88, windowId, selected: !!(o && o.select) };
      },
      closeTab: async (id) => { log.push(`closeTab ${id}`); if (!opts.closeSticks) opts.extraTabs = []; return { ok: true, closed: true }; },
      selectTab: async (tab, o) => {
        log.push(`select window=${o && o.windowId}`);
        opts.selected = true;
        return target({ changed: true, frontmostChanged: false });
      },
      listTabs: async () => ({ ok: true, frontmost: 'Google Chrome', chromePid: 42,
        windows: [{ id: 1, index: 1, minimized: false, tabs: [{ id: 5, url: pg.w.location.href, title: 't', active: true }, ...(opts.extraTabs || [])] }] }),
      pageDialog: async () => opts.dialog ? { ok: true, open: true, ...opts.dialog } : { ok: true, open: false },
      ensureScreenAwake: async () => {
        log.push('screen');
        const sc = opts.screen || { woke: false, displays: 1, locked: false };
        if (opts.screenUnlockAfter != null && (opts.screenChecks = (opts.screenChecks || 0) + 1) > opts.screenUnlockAfter) return { woke: false, displays: 1, locked: false };
        return sc;
      },
      axInput: async () => ({ ok: true, frontmost: true, windowMatches: true, nodeFound: true,
        nativePopup: false, menuOpen: false, nativeMenuOpen: false, documentToken: 'offline-page', segments: [], blocker: null }),
      axMenuState: async () => ({ ok: true, known: true, menuOpen: false }),
      openNavigationObserver: async () => ({ startedAt: Date.now(),
        untouched: async () => opts.clickIdle !== 0 && opts.navigationUntouched !== false, close: async () => {} }),
      keepAwake: () => { log.push('keepAwake'); return () => log.push('awakeStop'); },
      moveWindow: async (id, b) => { log.push(`moveWindow ${id} ${b.left},${b.top},${b.right},${b.bottom}`); opts.moved = { id, b }; return { ok: true }; },
      // A shot as bridge.js returns it: the full capture at 2× (Retina) and the picture ≤ 1568 px on its longest side.
      captureRegion: async (rect) => { log.push('capture region'); opts.captured = rect; return fakeShot(rect, 'region'); },
      captureWindow: async (w) => {
        log.push(`capture window ${w.cgWindow}`);
        opts.capturedWindow = w;
        if (opts.windowCaptureFails) throw new bridge.BridgeError('window_off_screen', opts.windowCaptureFails);
        return fakeShot(opts.windowRect || { x: BOUNDS.left, y: BOUNDS.top, w: BOUNDS.width, h: BOUNDS.height }, 'window');
      },
      ocrImage: async (file) => {
        log.push(`ocr ${file}`);
        return { ok: true, width: opts.lastShot.fullWidth, height: opts.lastShot.fullHeight, lines: opts.ocrLines ?? FAKE_OCR };
      },
      answerDialog: async (b, text = null) => {
        log.push(`answerDialog ${b}`);
        opts.dialogText = text;
        if (!opts.dialog || !opts.dialog.buttons.includes(b)) return { ok: false, message: `对话框里没有「${b}」按钮`, buttons: opts.dialog && opts.dialog.buttons };
        opts.dialog = null;
        return { ok: true, open: true, pressed: b, stillOpen: false };
      },
      evalInPage: async (src) => {
        if (opts.onEval) opts.onEval(src);
        const payload = JSON.parse(pg.w.eval(src));
        if (!payload.ok) throw new bridge.BridgeError(payload.error, payload.message);
        return { ...payload, bounds: BOUNDS, target: target() };
      },
      cgevent: async (args) => {
        if (args[0] === 'idle') {
          // keyIdle/held (waitForHandsOff, takeover): `hands` readings in turn, then hands off.
          const h = opts.hands && opts.hands.length ? opts.hands.shift() : null;
          if (h) log.push('hands');
          const hv = typeof h === 'function' ? h() : h;
          return { ok: true, idle: opts.idle ?? 100, ...(opts.clickIdle != null ? { clickIdle: opts.clickIdle } : {}),
            ...(hv ? { keyIdle: hv.keyIdle, held: hv.held || [], ...(hv.keyAt != null ? { keyAt: hv.keyAt } : {}) } : opts.hands ? { keyIdle: 100, held: [] } : {}) };
        }
        if (args[0] === 'mousepos') return { ok: true, x: opts.mouse ? opts.mouse.x : 11, y: opts.mouse ? opts.mouse.y : 22 };
        if (args[0] === 'displays') return { ok: true, displays: opts.displays || [{ id: 1 }],
          locked: false, displaysAsleep: false, mouse: opts.mouse || { x: 11, y: 22 } };
        if (args[0] === 'warp') { log.push('warp'); return { ok: true }; }
        if (args[0] === 'windowsat') {
          return { ok: true, windows: [{ owner: 'Google Chrome', pid: 42, layer: 0, alpha: 1, bounds: { x: 100, y: 60, w: 1400, h: 900 } }] };
        }
        throw new Error(`unexpected cgevent ${args[0]}`);
      },
      snapshotScene: async () => { log.push('scene'); return { app: 'kitty', appPid: 9, chromeWindow: 1, chromeTab: 5 }; },
      newWindow: async (...a) => { if (opts.newWindow) return opts.newWindow(...a); throw new Error('newWindow reached in a test'); },
      profiles: async () => ({ ok: true, default: 'Profile 3', profiles: [{ dir: 'Profile 3', name: '庄严', user: 'u@test', appleEventsJS: true }] }),
      restoreScene: async (sc, o) => { log.push('restore'); opts.lastRestoreOpts = o; opts.lastRestoreScene = sc; return { ok: true }; },
      restoreApp: async (pid, o) => { log.push(`restoreApp ${pid}`); opts.lastRestoreAppOpts = o; return { ok: true, appFrontmost: true }; },
      openInputSession: () => {
        log.push('session');
        const real = bridge.openInputSession({ env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: `e2e${pbN}`,
          CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.e2e${process.pid}.${++pbN}` } });
        opts.lastReal = real;
        let cursor = null, pendingPaste = null;
        return {
          get interrupted() { return real.interrupted; },
          close: () => real.close(),
          async request(o, ro) {
            log.push(o.op);
            if (o.op === 'hold') opts.holdReq = o;
            if (o.op === 'click') opts.lastClickReq = o;
            if (o.op === 'warp') opts.lastWarpTo = o.to;
            if (o.op === 'veil' && o.hidden != null) log.push(`veil hidden=${o.hidden}`);
            // The page reads the pasteboard some time after Cmd+V; once the
            // user's clipboard is back, that read gets the user's content.
            if (o.op === 'restoreClipboard') pendingPaste = null;
            if ((o.op === 'hold' || o.op === 'begin') && opts.secureInput) await real.request({ op: '_fake', secureInput: opts.secureInput }, { raw: true });
            // A key of the user's down at the hold, for the first `heldTimes` attempts.
            if (o.op === 'hold' && (opts.heldLeft = opts.heldLeft ?? opts.heldTimes ?? 0) > 0) { opts.heldLeft--; await real.request({ op: '_fake', held: true }, { raw: true }); }
            const pending = real.request(o, ro);
            if (opts.injectDuring === o.op && (opts.injectTimes == null || (opts.injected = (opts.injected || 0) + 1) <= opts.injectTimes)) {
              setTimeout(() => real.request({ op: '_inject', kind: opts.injectKind ?? 'key' }, { raw: true }).catch(() => {}), opts.injectAfterMs ?? 300);
            }
            const r = await pending;
            // The dry-run helper reports the real pointer: a test that sets one gets that one.
            if (o.op === 'hold' && opts.mouse && r) r.pointer = { ...opts.mouse };
            if (r && r.panel) (opts.panels ||= []).push({ op: o.op, panel: r.panel });
            if (o.op === 'begin' && r.dryRun !== true) { await real.close(); throw new Error('helper is not in dry-run mode; stopping'); }
            if (opts.injectAfterOp === o.op && (opts.injectTimes == null || (opts.injected = (opts.injected || 0) + 1) <= opts.injectTimes)) {
              for (const kind of opts.injectKinds ?? [opts.injectKind ?? 'move']) await real.request({ op: '_inject', kind }, { raw: true });
            }
            if (o.op === 'move' || o.op === 'click') cursor = r.landed;
            if (o.op === 'wheel') applyWheel(cursor, o.dir, r.sent);
            if (o.op === 'click') applyClick(r.landed);
            if (o.op === 'type') { applyText(o.text); applyKeyups(o.text); }
            if (o.op === 'key') applyKeyups('\n');
            if (o.op === 'paste') {
              pendingPaste = o.text;
              setTimeout(() => { if (pendingPaste != null) applyText(pendingPaste); pendingPaste = null; }, opts.pasteLatencyMs ?? 0);
            }
            return r;
          }
        };
      }
    };
  }
  async function fresh(o = {}) {
    idx.__resetPanelTaskForTests();
    idx.__resetLedgerForTests();
    pg = page();
    log = [];
    opts = o;
    const fake = fakeBridge();
    // Only reading the local page scripts may stay real.
    const real = idx.__bridgeKeysForTests().filter(k => !(k in fake) && k !== 'pageScript');
    if (real.length) throw new Error(`the test bridge does not fake ${real.join(', ')}: that would reach the real Chrome`);
    // Every B.<fn>( the server calls must be in its table: a missing one passes here (the fake adds it)
    // and breaks only live (round 5: B.pageDialog).
    const used = [...new Set([...fsSync.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').matchAll(/\bB\.([A-Za-z]+)\(/g)].map(x => x[1]))];
    const missing = used.filter(k => !idx.__bridgeKeysForTests().includes(k));
    if (missing.length) throw new Error(`src/index.js calls B.${missing.join(', B.')} but its bridge table B has no such entry`);
    idx.__setBridgeForTests(fake);
  }
  const m = (sel) => markerOf(pg.w, sel);
  async function ta2(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

  await ta2('MCP records a contiguous prefix and replays it with fresh markers through the native input path', async () => {
    await fresh();
    process.env.CHROME_BRIDGE_ROUTINE_RECORDING = '1';
    const invoke = (name, args) => idx.callTool({ params: { name, arguments: args } }, {});
    try {
      const first = await invoke('click', { tab: 5, marker: m('#near') });
      assert.notEqual(first.isError, true, JSON.stringify(first));
      await invoke('read_page', { tab: 5, full: true });
      const second = await invoke('click', { tab: 5, marker: m('#plain') });
      assert.notEqual(second.isError, true, JSON.stringify(second));
      const history = (await invoke('routines', { action: 'history' })).structuredContent.result;
      const events = history.events.filter(event => event.replayable);
      assert.equal(events.length, 2, JSON.stringify(history));
      const saved = (await invoke('routines', { action: 'save', name: 'Reach the plain control', eventIds: events.map(event => event.id).reverse() })).structuredContent?.result;
      assert.ok(saved?.id, 'saving chronological range must succeed');
      process.env.CHROME_BRIDGE_ROUTINE_RECORDING = '0';
      await fresh();
      // Fixture-only change: a new control shifts marker numbers; the runner must resolve identities again.
      const unrelated = pg.w.document.createElement('button');
      unrelated.textContent = 'Unrelated'; unrelated.setAttribute('data-rect', '900,60,120,30');
      pg.w.document.body.prepend(unrelated);
      const result = (await invoke('routines', { action: 'run', id: saved.id, tab: 5, params: {}, nonce: 'offline-native-prefix' })).structuredContent?.result;
      assert.equal(result?.status, 'completed', JSON.stringify(result));
      assert.equal(result.completed, 2);
      assert.equal(pg.clicks.near, 1); assert.equal(pg.clicks.plain, 1);
      assert.equal(pg.w.location.pathname, '/near-done');
      assert.equal(log.filter(entry => entry === 'click').length, 2);
    } finally {
      process.env.CHROME_BRIDGE_ROUTINE_RECORDING = '0';
      await idx.endTaskHold();
      await idx.taskPlanTool({ done: true });
    }
  });

  await ta2('click: on-screen target, URL changes → ✅; scene restored and pointer warped back afterwards', async () => {
    await fresh();
    const out = await idx.click({ marker: m('#near') });
    assert.match(out, /^✅ 已点击 \[\d+\] <button> Near/m);
    assert.match(out, /页面地址已改变/);
    assert.doesNotMatch(out, /滚轮|程序滚动/);
    assert.equal(pg.clicks.near, 1);
    // park (warp before the session begins, i.e. before activation), then the
    // click, then the user's scene and pointer are put back.
    assert.deepEqual(log.filter(x => ['begin', 'click', 'restore', 'warp'].includes(x)), ['warp', 'begin', 'click', 'restore', 'warp']);
    assert.ok(log.indexOf('restore') > log.indexOf('click'));
  });

  await ta2('click: no URL change and no new focus → "no observable change", not ✅ (codex #5)', async () => {
    await fresh();
    pg.w.document.getElementById('plain').focus();
    const out = await idx.click({ marker: m('#plain') });
    assert.equal(pg.clicks.plain, 1);
    assert.match(out, /^已点击，页面没有可观察的变化（不代表没生效）/);
    assert.match(out, /点击前焦点已经在它上面/);
  });

  await ta2('click: target 2.5 screens down is wheeled into view (no programmatic scroll), then clicked', async () => {
    await fresh();
    const out = await idx.click({ marker: m('#far') });
    assert.equal(pg.clicks.far, 1, out);
    assert.match(out, /用真实滚轮滚了 \d+ 串/);
    assert.doesNotMatch(out, /程序滚动/);
    assert.ok(pg.state.sy > 1000, `document scrolled to ${pg.state.sy}`);
    const y = 2000 - pg.state.sy;
    assert.ok(y >= 812 * 0.1 && y + 40 <= 812 * 0.9 + 40, `target ends at ${y}`);
    assert.ok(log.filter(x => x === 'wheel').length >= 2, 'more than one burst');
  });

  await ta2('click: target inside an inner scroller: the pointer goes over that scroller and its content moves', async () => {
    await fresh();
    const out = await idx.click({ marker: m('#inbox') });
    assert.equal(pg.clicks.inbox, 1, out);
    assert.ok(Number(pg.w.document.getElementById('box').getAttribute('data-scroll-top')) > 0, 'inner box scrolled');
    assert.equal(pg.state.sy, 0, 'the document did not move');
    assert.doesNotMatch(out, /程序滚动/);
  });

  await ta2('click: a covered target is refused before any press; the scene is put back', async () => {
    await fresh();
    await assert.rejects(idx.click({ marker: m('#hid') }), (e) => {
      assert.equal(e.code, 'target_covered');
      assert.match(e.message, /div\.modal/);
      return true;
    });
    assert.ok(!log.includes('click'));
    assert.ok(log.includes('restore') && log.includes('warp'));
  });

  await ta2('click: activation not reaching the key window → refused, nothing pressed', async () => {
    await fresh({ keyWindow: false });
    await assert.rejects(idx.click({ marker: m('#near') }), (e) => e.code === 'not_key_window');
    // The session now starts before activation (it watches the user through
    // it); what must not happen is any input.
    assert.ok(!log.includes('click'));
  });

  await ta2('click: a tab that appears during the click is reported, not registered', async () => {
    await fresh();
    pg.w.document.getElementById('plain').addEventListener('click', () => {
      opts.extraTabs = [{ id: 77, url: 'https://example.test/popup', title: '弹出页', active: false }];
    });
    const out = await idx.click({ marker: m('#plain') });
    assert.match(out, /新出现了 1 个标签：tab=77/);
    assert.match(out, /没有登记为 agent 标签/);
    const { getTab } = await import('../src/tabs.js');
    assert.equal(await getTab(77), null);
  });

  await ta2('tab ledger: a click on my tab that opens a tab → registered to me (openedFrom), ready; the reply says so and lists my tabs', async () => {
    await fresh({ clickIdle: 100, chromeInfo: (tab, target) => Number(tab) === 77
      ? target({ tabId: 77, url: 'https://example.test/popup', title: '弹出页', tabActive: false }) : target() });
    await tabsMod.registerTab(5, pg.w.location.href, { windowId: 1, now: Date.now() - 60_000 });
    pg.w.document.getElementById('plain').addEventListener('click', () => {
      opts.extraTabs = [{ id: 77, url: 'https://example.test/popup', title: '弹出页', active: false }];
    });
    // This fake answers every tab from one page: the popup's opener check (src/page/opener.js) reads its referrer here.
    Object.defineProperty(pg.w.document, 'referrer', { value: 'https://example.test/page?a=1', configurable: true });
    const r = await idx.callTool({ params: { name: 'click', arguments: { marker: m('#plain'), tab: 5 } } }, {});
    const out = r.content[0].text;
    assert.match(out, /点击后新开了 1 个标签，已登记为你的标签（点击弹出的不会被自动关闭，用完请 close_tab）：tab=77（窗口 1）弹出页。读它：read_page\(tab=77\)。/);
    assert.match(out, /\n［你的标签有变化］tab=77 ready（tab=5 点出）「弹出页」；tab=5 ready「测试页面」$/);
    assert.doesNotMatch(out, /没有登记为 agent 标签/);
    const rec = await tabsMod.getTab(77);
    assert.deepEqual([rec.ownerPid, rec.openedFrom, rec.expectedUrl, rec.windowId], [process.pid, 5, 'https://example.test/popup', 1]);
    // The popup's referrer is the clicked page itself; it is kept as a popup, which no sweep closes.
    assert.deepEqual([rec.popup, rec.proof], [true, 'source']);
    const e = idx.__ledgerForTests().get(77);
    assert.deepEqual([e.state, e.from], ['ready', 5]);
    await tabsMod.forgetTab(77); await tabsMod.forgetTab(5);
  });

  await ta2('tab ledger: my navigating click or submit → stale; read_page → ready again', async () => {
    await fresh();
    const L = idx.__ledgerForTests();
    await tabsMod.registerTab(5, pg.w.location.href, { windowId: 1, now: Date.now() - 60_000 });
    await idx.readPage({ tab: 5 });
    assert.equal(L.get(5).state, 'ready');
    await idx.click({ marker: m('#plain'), tab: 5 });
    assert.equal(L.get(5).state, 'ready', 'a click that did not move the URL made the markers stale');
    const r = await idx.callTool({ params: { name: 'click', arguments: { marker: m('#near'), tab: 5 } } }, {});
    assert.equal(L.get(5).state, 'stale');
    assert.match(r.content[0].text, /页面地址：.*→ .*\/near-done/);
    assert.doesNotMatch(r.content[0].text, /［你的标签有变化］/, 'the click reply already says the URL changed: no reminder line');
    await idx.readPage({ tab: 5 });
    assert.equal(L.get(5).state, 'ready');
    pg.w.document.getElementById('q').addEventListener('keyup', (ev) => {
      if (ev.key === 'Enter') setTimeout(() => pg.w.history.pushState({}, '', '/results?q=z'), 350);
    });
    await idx.typeText({ marker: m('#q'), text: 'z', submit: true, tab: 5 });
    assert.equal(L.get(5).state, 'stale');
    assert.equal((await tabsMod.getTab(5)).takenOver, false);
    await tabsMod.forgetTab(5);
  });

  await ta2('type_text input_mode keys: short ASCII typed key by key into the clicked field, confirmed in the field', async () => {
    await fresh();
    const out = await idx.typeText({ marker: m('#q'), text: 'hello world', input_mode: 'keys' });
    assert.equal(pg.w.document.getElementById('q').value, 'hello world');
    assert.match(out, /✅ 已输入并在输入框里确认：逐键输入 11 个字符/);
    assert.match(out, /系统在 \d+ ms 内确认全部按键都已交给 Chrome/);
    assert.ok(log.includes('type') && !log.includes('paste'));
  });

  await ta2('type_text schema and runtime default send short ASCII with ordered keys', async () => {
    const tool = (await import('../src/index.js')).__toolsForTests().find(x => x.name === 'type_text');
    assert.deepEqual(tool.inputSchema.properties.input_mode.enum, ['paste', 'keys']);
    assert.equal(tool.inputSchema.properties.input_mode.default, 'keys');
    assert.doesNotMatch(tool.description, /120/);
    await fresh();
    const out = await idx.typeText({ marker: m('#q'), text: 'hi' });
    assert.equal(pg.w.document.getElementById('q').value, 'hi');
    assert.deepEqual(log.filter(x => ['type', 'paste'].includes(x)), ['type']);
    assert.match(out, /^✅ 已输入并在输入框里确认：逐键输入 2 个字符/);
    await assert.rejects(idx.typeText({ text: 'x', input_mode: 'typing' }), (e) => e.code === 'bad_input_mode');
  });

  await ta2('default and explicit keys refuse mixed text before clicking or sending partial input', async () => {
    for (const input_mode of [undefined, 'keys']) {
      await fresh();
      await assert.rejects(idx.typeText({ marker: m('#q'), text: 'Hi 你好 ok', input_mode }),
        e => e.code === 'unsupported_key_text');
      assert.equal(pg.w.document.getElementById('q').value, '');
      assert.deepEqual(log.filter(x => ['session', 'click', 'type', 'paste', 'restoreClipboard'].includes(x)), []);
    }
  });

  await ta2('codex2-8: whitespace-only text is refused; text already in the field does not confirm a swallowed input', async () => {
    await fresh();
    await assert.rejects(idx.typeText({ marker: m('#q'), text: ' \n ' }), (e) => e.code === 'blank_text');
    assert.ok(!log.includes('session'), 'a session was opened for blank text');
    for (const input_mode of ['paste', 'keys']) {
      await fresh({ swallowText: true });
      pg.w.document.getElementById('q').value = 'hello world';
      await assert.rejects(idx.typeText({ marker: m('#q'), text: 'hello', submit: true, input_mode }), e => {
        assert.equal(e.code, 'input_unconfirmed');
        assert.match(e.message, /^❌ 未确认已输入.*输入框的内容没有变化/, input_mode);
        assert.doesNotMatch(e.message, /✅ 已输入/);
        return true;
      });
      assert.ok(!log.includes('key'), `${input_mode}: Return pressed although nothing was typed`);
    }
  });

  await ta2('codex2-5: click hands the front back right after the page saw the click; the page is observed only afterwards', async () => {
    await fresh();
    const out = await idx.click({ marker: m('#near') });
    assert.match(out, /网页在 \d+ ms 内收到了这次点击/);
    assert.doesNotMatch(out, /随即交还前台|按上限交还前台/);
    const iClick = log.indexOf('click'), iRestore = log.indexOf('restore');
    assert.ok(iRestore > iClick);
    // One URL read is part of the hand-back (the status check); the navigation polling is not.
    assert.ok(log.slice(iClick, iRestore).filter(x => x === 'info').length <= 1, `tab polled before the hand-back: ${log.slice(iClick, iRestore)}`);
    assert.ok(log.slice(iRestore).includes('info'), 'the navigation was not observed after the hand-back');
    // The page never reports the click: handed back at the cap, and said so.
    await fresh({ noAck: true });
    const t0 = Date.now();
    let tRestore = null;
    const fake = { restoreScene: async () => { tRestore = Date.now(); log.push('restore'); return { ok: true }; } };
    idx.__setBridgeForTests(fake);
    const out2 = await idx.click({ marker: m('#plain') });
    assert.match(out2, /300 ms 内没看到网页收到这次点击的事件/);
    assert.ok(tRestore != null && tRestore - t0 < 5000);
  });

  await ta2('codex2-5: submit hands back after Return\'s key-up; the navigation it causes is recorded afterwards', async () => {
    await fresh();
    await tabsMod.registerTab(5, pg.w.location.href, { windowId: 1, now: Date.now() - 60_000 });
    // The navigation commits after the hand-back, as a real one does.
    pg.w.document.getElementById('q').addEventListener('keyup', (e) => {
      if (e.key === 'Enter') setTimeout(() => pg.w.history.pushState({}, '', '/results?q=x'), 350);
    });
    const out = await idx.typeText({ marker: m('#q'), text: 'x', submit: true });
    assert.match(out, /并已按下回车；系统在 \d+ ms 内确认回车已交给 Chrome/);
    assert.match(out, /页面地址：.*→ .*\/results\?q=x/);
    const iKey = log.lastIndexOf('key'), iRestore = log.indexOf('restore');
    assert.ok(iRestore > iKey && log.slice(iKey, iRestore).filter(x => x === 'info').length <= 1, log.join(','));
    assert.equal((await tabsMod.getTab(5)).expectedUrl, pg.w.location.href, 'the submit\'s navigation was not recorded');
    await tabsMod.forgetTab(5);
    // A mouse click since the hand-back: that URL is not taken as the agent's.
    await fresh({ clickIdle: 0 });
    await tabsMod.registerTab(5, pg.w.location.href, { windowId: 1, now: Date.now() - 60_000 });
    const before = pg.w.location.href;
    // The navigation commits after the hand-back, as a real one does.
    pg.w.document.getElementById('q').addEventListener('keyup', (e) => {
      if (e.key === 'Enter') setTimeout(() => pg.w.history.pushState({}, '', '/results?q=y'), 350);
    });
    const out2 = await idx.typeText({ marker: m('#q'), text: 'y', submit: true });
    assert.match(out2, /没有记为 agent 的导航/);
    assert.equal((await tabsMod.getTab(5)).expectedUrl, before);
    await tabsMod.forgetTab(5);
  });

  await ta2('type_text: Chinese is pasted in one go, then the clipboard is restored; submit presses Return after confirmation', async () => {
    await fresh({ pasteLatencyMs: 500 });
    const out = await idx.typeText({ marker: m('#q'), text: '你好，世界', input_mode: 'paste', submit: true });
    assert.equal(pg.w.document.getElementById('q').value, '你好，世界');
    assert.match(out, /一次 Cmd\+V 整段粘贴 5 个字符/);
    assert.match(out, /你的剪贴板已还原/);
    assert.match(out, /并已按下回车/);
    const seq = log.filter(x => ['paste', 'restoreClipboard', 'key'].includes(x));
    assert.deepEqual(seq, ['paste', 'restoreClipboard', 'key'], 'restore after confirmation, Return last');
  });

  await ta2('type_text: text not seen in the field → "未确认已输入", clipboard still restored, NO Return', async () => {
    await fresh({ swallowText: true });
    await assert.rejects(idx.typeText({ marker: m('#q'), text: '你好', input_mode: 'paste', submit: true }), e => {
      assert.equal(e.code, 'input_unconfirmed');
      assert.match(e.message, /^❌ 未确认已输入/);
      assert.match(e.message, /因此没有按回车提交/);
      return true;
    });
    assert.ok(log.includes('restoreClipboard'));
    assert.ok(!log.includes('key'));
  });

  await ta2('type_text: focus is not on an editable field → nothing typed', async () => {
    await fresh();
    pg.w.document.getElementById('plain').focus();
    await assert.rejects(idx.typeText({ text: 'abc' }), (e) => e.code === 'wrong_field');
    assert.ok(!log.includes('type') && !log.includes('paste'));
    pg.w.document.hasFocus = () => false;
    await assert.rejects(idx.typeText({ text: 'abc' }), (e) => e.code === 'no_page_focus');
  });

  await ta2('type_text: the user touches the keyboard mid-typing → stopped, only their app handed back, progress reported', async () => {
    // After the pre-typing pause (at most 2 s), so some keys are already down.
    await fresh({ injectDuring: 'type', injectAfterMs: 2600 });
    await assert.rejects(idx.typeText({ marker: m('#q'), text: 'a fairly long line of text', input_mode: 'keys' }), (e) => {
      assert.equal(e.code, 'user_interrupted');
      assert.match(e.message, /你开始操作了，已停止；完成了：点击了 \[\d+\]；逐键输入了 \d+ 个字符/);
      assert.match(e.message, /已把前台切回你原来用的 App（光标和 Chrome 窗口没有动）；你按下的第一个键可能已经进了 agent 的网页/);
      return true;
    });
    assert.ok(!log.includes('restore'), 'scene restored after the user took over');
    // The only warp allowed is the park before activation (before 'begin').
    assert.ok(!log.slice(log.indexOf('begin') + 1).includes('warp'), 'pointer warped after the user took over');
    assert.ok(log.includes('restoreApp 9'), `A3/A4: the user's app was not handed back: ${log.join(',')}`);
  });

  await ta2('codex1-7: the user takes over right after the click → their navigation is not recorded as the agent\'s; tab marked', async () => {
    await fresh({ injectAfterOp: 'click', injectKind: 'button' });
    const before = pg.w.location.href;
    await tabsMod.registerTab(5, before, { windowId: 1, now: Date.now() - 60_000 });
    const out = await idx.click({ marker: m('#near') });
    assert.match(out, /操作做完、还原之前你动了键盘鼠标/);
    assert.notEqual(pg.w.location.href, before);
    const rec = await tabsMod.getTab(5);
    assert.equal(rec.expectedUrl, before, 'expectedUrl moved to a URL the user may have navigated to');
    assert.deepEqual([rec.takenOver, rec.takenOverWhy], [true, 'user_interrupted']);
    assert.ok(!log.includes('restoreApp 9'), 'a click interruption must not hand the front back');
    await tabsMod.forgetTab(5);
  });

  await ta2('codex1-6: focus moves to another field holding the same text before Return → Return not pressed', async () => {
    let checks = 0;
    await fresh({ onEval: (src) => {
      if (!src.includes('"check"')) return;
      if (++checks === 2) {   // the check right before Return
        const q2 = pg.w.document.getElementById('q2');
        q2.value = 'hello world';
        q2.focus();
      }
    } });
    await assert.rejects(idx.typeText({ marker: m('#q'), text: 'hello world', submit: true, input_mode: 'keys' }), e => {
      assert.equal(e.code, 'submit_unconfirmed');
      assert.match(e.message, /^❌ 未提交：/);
      assert.match(e.message, /✅ 已输入并在输入框里确认/);
      assert.match(e.message, /键盘焦点已经不在刚才输入的那个框里/);
      return true;
    });
    assert.ok(!log.includes('key'), 'Return was pressed into another field');
  });

  await ta2('codex1-6: typing confirmed only in the field that was checked, not in one the page moved focus to', async () => {
    await fresh({ onEval: (src) => {
      if (!src.includes('"check"')) return;
      const q2 = pg.w.document.getElementById('q2');
      q2.value = 'hello world';
      q2.focus();
    }, swallowText: true });
    await assert.rejects(idx.typeText({ marker: m('#q'), text: 'hello world', submit: true, input_mode: 'keys' }), e => {
      assert.equal(e.code, 'input_unconfirmed');
      assert.match(e.message, /^❌ 未确认已输入.*键盘焦点已经离开了刚才输入的那个框/);
      return true;
    });
    assert.ok(!log.includes('key'));
  });

  await ta2('codex1-11: the user takes over while the wheel cannot reach the target → no programmatic scroll', async () => {
    await fresh({ injectAfterOp: 'begin' });
    await assert.rejects(idx.click({ marker: m('#clipped') }), (e) => e.code === 'user_interrupted');
    assert.equal(pg.calls.scrollIntoView.length, 0, 'scrollIntoView ran after the user took over');
    await fresh();
    const out = await idx.click({ marker: m('#clipped') }).catch(e => e.message);
    assert.equal(pg.calls.scrollIntoView.length, 1, `without a takeover the labelled fallback still runs: ${out}`);
  });

  const withRetry = async (o, fn) => {
    idx.__setRetryForTests({ maxMs: 20_000, pauseMs: 10, ...o });
    try { await fn(); } finally { idx.__setRetryForTests({ maxMs: 0, pauseMs: 400 }); }
  };
  const count = (op) => log.filter(x => x === op).length;

  await ta2('queue: input seen before anything is sent is waited out inside the call; one click, one answer', () => withRetry({}, async () => {
    await fresh({ injectAfterOp: 'begin', injectTimes: 2 });
    await tabsMod.registerTab(5, pg.w.location.href, { windowId: 1, now: Date.now() - 60_000 });
    const out = await idx.click({ marker: m('#near') });
    assert.match(out, /^（排队 \d+ 秒、自动重试 2 次后完成；之前几次都没有发出任何输入）/);
    assert.equal(pg.clicks.near, 1);
    assert.equal(count('click'), 1);
    assert.equal(count('begin'), 3);
    assert.equal((await tabsMod.getTab(5)).takenOver, false, 'pointer moves alone marked the tab as taken over');
    await tabsMod.forgetTab(5);
  }));

  await ta2('queue: the user moves the mouse during the pointer\'s travel (no press yet) → retried; the tab stays the agent\'s', () => withRetry({}, async () => {
    await fresh({ injectDuring: 'click', injectAfterMs: 30, injectTimes: 1, injectKind: 'move' });
    await tabsMod.registerTab(5, pg.w.location.href, { windowId: 1, now: Date.now() - 60_000 });
    const out = await idx.click({ marker: m('#near') });
    assert.match(out, /自动重试 1 次后完成/);
    assert.equal(pg.clicks.near, 1);
    assert.equal(count('click'), 2, 'the interrupted travel and the retry');
    assert.equal((await tabsMod.getTab(5)).takenOver, false, 'a pointer move before any press marked the tab as taken over');
    await tabsMod.forgetTab(5);
  }));

  await ta2('queue: interrupted after keys were sent → not retried; the agent is told to read the page first', () => withRetry({}, async () => {
    await fresh({ injectDuring: 'type', injectAfterMs: 2600 });
    pg.w.document.getElementById('q').focus();
    await assert.rejects(idx.typeText({ text: 'a fairly long line of text', input_mode: 'keys' }), (e) => {
      assert.equal(e.code, 'user_interrupted');
      assert.match(e.message, /给 agent：这次已经发出了部分输入，先 read_page/);
      return true;
    });
    assert.equal(count('begin'), 1);
    assert.equal(count('type'), 1);
  }));

  await ta2('queue: a cancelled call stops waiting and sends nothing', () => withRetry({}, async () => {
    await fresh({ injectAfterOp: 'begin' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(idx.click({ marker: m('#near') }, { signal: ac.signal }), (e) => e.code === 'cancelled');
    assert.equal(count('click'), 0);
    assert.equal(pg.clicks.near || 0, 0);
  }));

  await ta2('queue: past the deadline → one answer saying nothing was sent and that calling again is fine', () => withRetry({ maxMs: 2000 }, async () => {
    await fresh({ injectAfterOp: 'begin' });
    await assert.rejects(idx.click({ marker: m('#near') }), (e) => {
      assert.equal(e.code, 'user_interrupted');
      assert.match(e.message, /^⏸ 排队 \d+ 秒、自动重试 \d+ 次仍没做成，没有发出任何输入/);
      assert.match(e.message, /给 agent：可以直接再调用一次继续排队/);
      return true;
    });
    assert.equal(count('click'), 0);
    assert.ok(count('begin') >= 2, 'not retried before the deadline');
  }));

  await ta2('queue: a tab lookup that misses for a moment (another agent opening/closing tabs) is retried, then clicked once', () => withRetry({}, async () => {
    let misses = 1;
    await fresh({ chromeInfo: (tab, target) => {
      if (misses > 0) { misses--; throw new bridge.BridgeError('no_such_tab', '找不到标签 5（可能已关闭）。'); }
      return target();
    } });
    const out = await idx.click({ marker: m('#near') });
    assert.match(out, /自动重试 1 次后完成/);
    assert.equal(pg.clicks.near, 1);
  }));

  await ta2('queue: a disturbed activation is retried 3 times only; a covered target is not retried at all', () => withRetry({}, async () => {
    await fresh({ keyWindow: false });
    await assert.rejects(idx.click({ marker: m('#near') }), (e) => {
      assert.equal(e.code, 'not_key_window');
      assert.match(e.message, /此前已自动重试 3 次/);
      return true;
    });
    assert.equal(count('activate'), 4);
    assert.equal(count('click'), 0);
    await fresh();
    await assert.rejects(idx.click({ marker: m('#hid') }), (e) => e.code === 'target_covered');
    assert.equal(count('begin'), 1);
  }));

  const withTakeover = async (fn) => {
    idx.__setTakeoverForTests(true);
    try { await fn(); } finally { idx.__setTakeoverForTests(false); }
  };

  await ta2('takeover: the user typing during a click is held, not an interruption; no pointer park before the hold; the result says so', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ injectAfterOp: 'begin', injectKinds: ['key', 'move'] });
    const out = await idx.click({ marker: m('#near') });
    assert.equal(pg.clicks.near, 1);
    assert.equal(count('begin'), 1, 'retried although the input was held');
    assert.match(out, /操作期间键盘鼠标由 agent 接管，拦下了你的 1 个按键，没有送到任何程序/);
    assert.ok(log.indexOf('warp') > log.indexOf('click'), `pointer moved before the hold began: ${log.join(',')}`);
    assert.ok(log.includes('restore'));
  })));

  await ta2('takeover: a user who never pauses: taken over after the short wait; the held input does not read as an interruption; restore ignores it', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    const out = await idx.click({ marker: m('#near') });
    assert.equal(pg.clicks.near, 1, out);
    assert.equal(count('begin'), 1, 'the idle counter (reset by held input) was read as the user taking over');
    assert.equal(opts.lastRestoreOpts && opts.lastRestoreOpts.stopOnInput, false);
  })));

  await ta2('takeover: Esc-Esc, then the user types after getting control back → still user_cancelled, not retried', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ injectAfterOp: 'begin', injectKinds: ['esc', 'esc', 'escUp', 'key'] });
    await assert.rejects(idx.click({ marker: m('#near') }), (e) => e.code === 'user_cancelled');
    assert.equal(count('begin'), 1);
    assert.equal(pg.clicks.near || 0, 0);
  })));

  await ta2('takeover: Secure Input on → nothing sent, waited out (not three quick tries), then the agent is told which app holds it', () => withTakeover(() => withRetry({ maxMs: 400, pauseMs: 30 }, async () => {
    await fresh({ secureInput: '1Password' });
    await assert.rejects(idx.click({ marker: m('#near') }), (e) => {
      assert.equal(e.code, 'secure_input');
      assert.match(e.message, /「1Password」开着「安全输入」/);
      assert.match(e.message, /排队 \d+ 秒、自动重试 \d+ 次仍没做成，没有发出任何输入/);
      return true;
    });
    assert.ok(count('hold') > 4, `held only ${count('hold')} times: gave up after a few quick tries`);
    assert.equal(count('begin'), 0);
    assert.equal(pg.clicks.near || 0, 0);
  })));

  await ta2('takeover: veil and hold come first, then the user\'s scene is recorded, then Chrome is activated; no waiting for a pause', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    const t0 = Date.now();
    await idx.click({ marker: m('#near') });
    const at = (x) => log.indexOf(x);
    assert.ok(at('hold') >= 0 && at('hold') < at('scene') && at('scene') < at('activate') && at('activate') < at('click'),
      `order: ${log.join(',')}`);
    assert.ok(log.indexOf('begin') > at('hold'), 'begin after the hold');
    assert.deepEqual([opts.lastHint.windowId, opts.lastHint.cgWindow, opts.lastHint.tabActive], [1, 7, true],
      'the pre-check\'s window was not handed to the lean activation');
    assert.ok(Date.now() - t0 < 6000, 'waited for the user to pause');
  })));

  await ta2('takeover: Esc twice cancels → user_cancelled, nothing pressed, not retried; the user\'s app, window and pointer put back', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ injectAfterOp: 'begin', injectKinds: ['esc', 'esc'] });
    await assert.rejects(idx.click({ marker: m('#near') }), (e) => {
      assert.equal(e.code, 'user_cancelled');
      assert.match(e.message, /按了两次 Esc.*\n给 agent：不要自动重试/s);
      return true;
    });
    assert.equal(pg.clicks.near || 0, 0);
    assert.equal(count('begin'), 1);
    assert.ok(log.includes('restore'), `scene not restored: ${log.join(',')}`);
    assert.ok(log.slice(log.indexOf('begin')).includes('warp'), 'pointer not put back');
  })));

  await ta2('takeover veil: a click\'s hold carries the hole (pre-checked window), the subline from the element\'s text and the target point', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#near') });
    const v = opts.holdReq && opts.holdReq.veil;
    assert.ok(v, `hold sent no veil: ${JSON.stringify(opts.holdReq)}`);
    assert.deepEqual(v.rect, { x: BOUNDS.left, y: BOUNDS.top, w: BOUNDS.width, h: BOUNDS.height });
    assert.deepEqual(v.label, { zh: '正在点击「Near」', en: 'Clicking "Near"' });
    assert.ok(Number.isFinite(v.point.x) && Number.isFinite(v.point.y), JSON.stringify(v.point));
    assert.ok(v.point.x > BOUNDS.left && v.point.y > BOUNDS.top, 'target point outside the window');
  })));

  await ta2('takeover: scroll (no pre-check) is held, then begun with the window; the veil says scrolling (was a TypeError before)', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    const out = await idx.scroll({ direction: 'down', amount: 1 });
    assert.match(out, /✅ 已用真实滚轮向下滚动/);
    assert.ok(log.indexOf('hold') >= 0 && log.indexOf('hold') < log.indexOf('begin') && log.indexOf('begin') < log.indexOf('wheel'),
      `order: ${log.join(',')}`);
    assert.deepEqual(opts.holdReq.veil.label, { zh: '正在滚动', en: 'Scrolling' });
    assert.deepEqual(opts.holdReq.veil.rect, { x: BOUNDS.left, y: BOUNDS.top, w: BOUNDS.width, h: BOUNDS.height });
  })));

  await ta2('takeover: type_text without a marker is held, then begun; the veil never shows the text being typed', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    pg.w.document.getElementById('q').focus();
    await idx.typeText({ text: 'secret words', input_mode: 'paste' });
    assert.ok(log.indexOf('hold') < log.indexOf('begin') && log.indexOf('begin') < log.indexOf('paste'), `order: ${log.join(',')}`);
    assert.deepEqual(opts.holdReq.veil.label, { zh: '正在输入', en: 'Typing' });
    assert.equal(opts.holdReq.veil.rect, undefined);
    assert.deepEqual([opts.holdReq.veil.panel.chars, opts.holdReq.veil.panel.showCount], [0, false], 'length shown for a field not seen before the hold');
    assert.doesNotMatch(JSON.stringify(opts.holdReq), /secret/);
  })));

  await ta2('takeover: a key down at the hold while the user keeps typing → retried until free, then done; no "late takeover" note (live 2026-10-06)', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0, heldTimes: 2 });
    const out = await idx.click({ marker: m('#plain') });
    assert.equal(count('hold'), 3, `holds: ${count('hold')}`);
    assert.match(out, /自动重试 2 次后完成/);
    assert.doesNotMatch(out, /还原之前你动了键盘鼠标/);
  })));

  await ta2('takeover: the user is typing (a key down, then keys a moment ago) → waits until they are done, then holds once (owner 2026-10-13)', () => withTakeover(() => withRetry({}, async () => {
    const down = { keyIdle: 0, held: ['左 ⌘'] };
    await fresh({ idle: 0, hands: [down, down, down, { keyIdle: 0.2, held: [] }, { keyIdle: 1.45, held: [] }] });
    const out = await idx.click({ marker: m('#plain') });
    assert.equal(count('hands'), 5, `readings: ${count('hands')}`);
    assert.ok(log.lastIndexOf('hands') < log.indexOf('hold'), `held before the user was done: ${log.join(',')}`);
    assert.equal(count('hold'), 1);
    assert.match(out, /等你停手 \d+\.\d 秒后才操作/);
    assert.doesNotMatch(out, /自动重试/);
  })));

  await ta2('takeover: the pause comes while it waits for the user to stop typing → refused when they stop, nothing held (Codex r13 A1)', () => withTakeover(() => withRetry({}, async () => {
    const settingsFile = process.env.CHROME_BRIDGE_SETTINGS;
    const down = { keyIdle: 0, held: ['左 ⌘'] };
    const pause = () => { fsSync.writeFileSync(settingsFile, JSON.stringify({ paused: true })); const t = new Date(Date.now() + 5e6); fsSync.utimesSync(settingsFile, t, t); return down; };
    try {
      await fresh({ idle: 0, hands: [down, pause, { keyIdle: 0.2, held: [] }, { keyIdle: 1.45, held: [] }] });
      // A job running: the pause noticed here (not at the door) ends its card and keep-awake too (Codex/Fable r13 r2 A2).
      await idx.taskPlanTool({ task: 'Job P', steps: ['a', 'b'], estimate_minutes: 4 });
      const taskFile = path.join(path.dirname(process.env.CHROME_BRIDGE_LOCK), 'tasks', `${process.pid}.json`);
      assert.ok(fsSync.existsSync(taskFile));
      await assert.rejects(idx.click({ marker: m('#plain') }), (e) => e.code === 'paused_by_user' && /等你停手/.test(e.message));
      assert.equal(count('hold'), 0, `held after the pause: ${log.join(',')}`);
      assert.ok(!fsSync.existsSync(taskFile), 'the job card stayed after a pause noticed during the hands-off wait');
      assert.ok(log.includes('awakeStop'), 'the job keep-awake kept running');
    } finally { try { fsSync.rmSync(settingsFile); } catch {} }
  })));

  await ta2('takeover: key events no later than our own last session are ours — the next action does not wait for them', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain') });
    // The time of the session's last posted key or button, from the helper's end reply (Codex r12 A1).
    const own = idx.__ownInputEndForTests();
    assert.ok(own > Date.now() - 30_000 && own <= Date.now(), `own input end: ${own}`);
    // The last key event is our own button-up: not waited for.
    opts.hands = [{ keyIdle: 0.2, keyAt: own, held: [] }];
    const out = await idx.click({ marker: m('#plain') });
    assert.doesNotMatch(out, /等你停手/, 'waited for our own keys');
    assert.equal(count('hands'), 1);
    // A key 100 ms after our last one (the user typing during the hand-back): the user's, waited out.
    const own2 = idx.__ownInputEndForTests();
    opts.hands = [{ keyIdle: 0.1, keyAt: own2 + 100, held: [] }];
    const out2 = await idx.click({ marker: m('#plain') });
    assert.match(out2, /等你停手 \d+\.\d 秒后才操作/);
  })));

  await ta2('takeover: a key reads as down but nothing was pressed for 30 s (its release was lost) → told at once which key, nothing sent; Shift held or a drag is waited for', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    const own = idx.__ownInputEndForTests();
    opts.hands = [{ keyIdle: 31, held: ['键码 0'] }];
    const t0 = Date.now();
    await assert.rejects(idx.click({ marker: m('#plain') }), (e) => {
      assert.equal(e.code, 'input_stuck');
      assert.match(e.message, /「键码 0」一直按着/);
      assert.match(e.message, /按一下这个键再松开/);
      return true;
    });
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.equal(count('hold'), 0);
    assert.equal(idx.__ownInputEndForTests(), own, 'a call that posted nothing moved the own-input time (Codex r12 A1)');
    // Held without repeating (Shift while selecting, a slow drag): waited for, not called stuck (Codex r12 r2 A1).
    opts.hands = [{ keyIdle: 31, held: ['鼠标左键'] }, { keyIdle: 31, held: ['左 ⇧'] }, { keyIdle: 31, held: ['fn'] }, { keyIdle: 31, held: [] }];
    const out = await idx.click({ marker: m('#plain') });
    assert.equal(count('hands'), 5);
    assert.match(out, /✅/);
  })));

  await ta2('takeover: a modifier read as down for a whole round with no key event (its release was lost) → input_stuck; the hold time is reported for live checks', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    // maxWaitMs is bounded by the retry deadline: a 1.2 s round here.
    idx.__setRetryForTests({ maxMs: 1200, pauseMs: 10 });
    const stuck = { keyIdle: 70, held: ['左 ⌘'] };
    opts.hands = Array.from({ length: 40 }, () => stuck);
    await assert.rejects(idx.click({ marker: m('#plain') }), (e) => e.code === 'input_stuck' && /「左 ⌘」一直按着/.test(e.message));
    assert.equal(count('hold'), 0);
    // Pressed again within the round (the set changed): the user, waited for, not stuck.
    idx.__setRetryForTests({ maxMs: 20_000, pauseMs: 10 });
    opts.hands = [{ keyIdle: 70, held: ['左 ⇧'] }, { keyIdle: 0.1, held: ['左 ⇧', '键码 0'] }, { keyIdle: 1.6, held: [] }];
    const prev = process.env.CHROME_BRIDGE_TIMING_DETAIL;
    process.env.CHROME_BRIDGE_TIMING_DETAIL = '1';
    const t0 = Date.now();
    try {
      const out = await idx.click({ marker: m('#plain') });
      const at = Number((out.match(/接管于 (\d{13})/) || [])[1]);
      assert.ok(at >= t0 && at <= Date.now(), `接管于 missing or off: ${out.slice(-300)}`);
    } finally { if (prev == null) delete process.env.CHROME_BRIDGE_TIMING_DETAIL; else process.env.CHROME_BRIDGE_TIMING_DETAIL = prev; }
  })));

  await ta2('takeover: a key down at the hold every time for a while → waited out (not three quick tries and a refusal)', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0, heldTimes: 5 });
    const out = await idx.click({ marker: m('#plain') });
    assert.equal(count('hold'), 6, `holds: ${count('hold')}`);
    assert.match(out, /自动重试 5 次后完成/);
  })));

  await ta2('held-input notifications: at most one per window, the counts in between added up (a long job takes over 100+ times)', async () => {
    const sent = [];
    const note = idx.__notifyForTests({ send: (t) => sent.push(t), everyMs: 120 });
    note(2, 0); note(1, 1); note(3, 0);
    assert.equal(sent.length, 1, sent.join(' | '));
    assert.match(sent[0], /2 个按键/);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(sent.length, 2, sent.join(' | '));
    assert.match(sent[1], /4 个按键、1 次点击\/滚动/);
    note(0, 0);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sent.length, 2, 'notified with nothing held');
    idx.__notifyForTests({ send: () => {}, everyMs: 60000 });
  });

  // ── screen: lit when dark, never unlocked by us ──
  await ta2('screen: a dark screen is lit first and the action goes on (said in the result); a locked one is reported and waited for, then done', () => withRetry({ maxMs: 3000, pauseMs: 20 }, async () => {
    await fresh({ screen: { woke: true, displays: 2, locked: false } });
    const out = await idx.click({ marker: m('#plain') });
    assert.match(out, /^（屏幕原本熄灭了，已点亮）/);
    await fresh({ screen: { woke: true, displays: 1, locked: true }, screenUnlockAfter: 3 });
    const out2 = await idx.click({ marker: m('#plain') });
    assert.match(out2, /自动重试 3 次后完成/);
    await fresh({ screen: { woke: false, displays: 1, locked: true } });
    idx.__setRetryForTests({ maxMs: 200, pauseMs: 20 });
    await assert.rejects(idx.click({ marker: m('#plain') }), (e) => e.code === 'screen_locked' && /不会输入密码/.test(e.message));
    assert.ok(!log.includes('session'), 'something was started on a locked screen');
    await fresh({ screen: { woke: true, displays: 1, locked: false } });
    assert.match(await idx.wakeScreenTool(), /已点亮熄灭的屏幕/);
  }));

  await ta2('task_plan keeps the screen awake while the job runs and lets go at done', (async () => {
    await fresh();
    const stateFile = path.join(path.dirname(process.env.CHROME_BRIDGE_LOCK), 'tasks', `${process.pid}.json`);
    await idx.taskPlanTool({ task: 'Job W', steps: ['a', 'b'], estimate_minutes: 4 });
    assert.deepEqual([log.includes('keepAwake'), log.includes('awakeStop')], [true, false]);
    const st = JSON.parse(fsSync.readFileSync(stateFile, 'utf8'));
    assert.deepEqual([st.pid, st.task, st.step], [process.pid, 'Job W', ''], 'the menu bar must retain the task identity without invented step progress');
    // A supplied list/estimate is not evidence of completed work. Keep the
    // task visible and awake without presenting question counts or an ETA.
    assert.deepEqual([st.current, st.total, st.stepName, st.etaMs], [null, null, null, null]);
    assert.ok(Math.abs(st.since - Date.now()) < 5000, 'the task start time was lost');
    await idx.taskPlanTool({ done: true });
    assert.equal(log.includes('awakeStop'), true);
    assert.equal(fsSync.existsSync(stateFile), false, 'the task stayed listed after it was done');
  }));

  // ── fallback: look (screenshot) and point (click_at), keys, hover ──
  // The fake window is BOUNDS (1400×900 pt) captured at 2× (2800×1800 px), given as 1568×1008.
  const screenOf = (c) => [Math.round(c.rect.x + c.rect.w / 2), Math.round(c.rect.y + c.rect.h / 2)];
  await ta2('screenshot: the window by its number (no veil hiding), text lines with ids and centres, top to bottom; no picture by default', async () => {
    await fresh();
    const r = await idx.screenshotTool({});
    assert.equal(r.image, null, 'a picture was attached without image: true');
    assert.deepEqual(opts.capturedWindow, { cgWindow: 7 });
    assert.ok(!log.includes('capture region') && !log.some(x => /^veil hidden/.test(x)), log.join(','));
    assert.ok(log.indexOf('ocr /fake/window.png') > log.indexOf('capture window 7'), 'OCR not on the full capture');
    assert.ok(!log.some(x => /^(hold|session|activate|restore|screen)$/.test(x)), 'read-only screenshot acquired input or activated the screen');
    assert.ok(log.includes('dispose window'), 'the capture files were not deleted');
    assert.match(r.text, /画面：1568×1008 像素/);
    assert.match(r.text, /只截了这个窗口/);
    assert.doesNotMatch(r.text, /可能拍进/);
    // Rows: 登录 | Sign up on one row (same line), then the two body lines as one paragraph, a gap, the footer.
    const k = 1568 / 2800;
    const c = (x, y, w, h) => `(${Math.round((x + w / 2) * k)},${Math.round((y + h / 2) * k)})`;
    assert.ok(r.text.includes(`t1 ${c(400, 200, 200, 40)} 登录 | t2 ${c(900, 204, 160, 36)} Sign up`), r.text);
    assert.ok(r.text.includes(`t3 ${c(300, 400, 900, 40)} 第一行正文，说明这页是做什么的\nt4 ${c(300, 446, 700, 40)} 第二行正文紧接着第一行`), r.text);
    assert.ok(r.text.includes(`紧接着第一行\n\nt5 ${c(300, 1500, 200, 40)} Footer (?)\n`), r.text);
    assert.match(r.text, /带 \(\?\) 的行识别没把握/);
    assert.doesNotMatch(r.text, /一行\s*\(\?\)/, 'a line read with confidence 0.5 or more was marked unsure');
    assert.ok(r.text.indexOf('t1 ') < r.text.indexOf('t3 ') && r.text.indexOf('t4 ') < r.text.indexOf('t5 '));
    const est = r.text.match(/估算 token：这段文字约 (\d+)，同一画面的图片约 (\d+)/);
    assert.ok(est, r.text);
    assert.equal(Number(est[2]), Math.round(1568 * 1008 / 750));
    assert.ok(Number(est[1]) < Number(est[2]), 'text should be cheaper than the picture here');
    assert.doesNotMatch(r.text, /识别到的文字很少/);
  });

  await ta2('screenshot image:true → the picture as well as the text', async () => {
    await fresh();
    const r = await idx.screenshotTool({ image: true });
    assert.equal(r.image && r.image.data, 'iVBORw0KGgo=');
    assert.match(r.text, /t1 \(\d+,\d+\) 登录/);
    assert.match(r.text, /本次两者都给了/);
  });

  await ta2('click_at text_id → the centre of that line on screen (2× capture scaled to 1568 px mapped back to points); x/y unchanged', () => withTakeover(async () => {
    await fresh();
    await idx.screenshotTool({});
    // t1 '登录': full-res box 400,200 200×40 → centre (500, 220) px = (250, 110) pt into the window.
    const out = await idx.clickAt({ text_id: 't1' });
    assert.match(out, /t1「登录」的中心/);
    const [x, y] = screenOf(opts.lastClickReq);
    assert.ok(Math.abs(x - (BOUNDS.left + 250)) <= 1 && Math.abs(y - (BOUNDS.top + 110)) <= 1, `clicked ${x},${y}`);
    assert.equal(opts.holdReq.veil.label.zh, '正在点击「登录」');
    await idx.clickAt({ text_id: '5' });   // 'Footer' without the t
    const [x5, y5] = screenOf(opts.lastClickReq);
    assert.ok(Math.abs(x5 - (BOUNDS.left + 200)) <= 1 && Math.abs(y5 - (BOUNDS.top + 760)) <= 1, `clicked ${x5},${y5}`);
    await idx.clickAt({ x: 100, y: 50 });
    const [px, py] = screenOf(opts.lastClickReq);
    assert.deepEqual([px, py], [BOUNDS.left + Math.round(100 * 1400 / 1568), BOUNDS.top + Math.round(50 * 900 / 1008)]);
    await assert.rejects(idx.clickAt({ text_id: 't9' }), (e) => e.code === 'no_such_text' && /t1–t5/.test(e.message));
    await assert.rejects(idx.clickAt({ text_id: 't1', x: 1, y: 1 }), (e) => e.code === 'bad_args');
    await assert.rejects(idx.clickAt({ x: 1 }), (e) => e.code === 'bad_args');
    await assert.rejects(idx.clickAt({ x: 1600, y: 10 }), (e) => e.code === 'outside_shot');
  }));

  await ta2('screenshot: a window capture failure refuses without a screen-region fallback or activation', async () => {
    await fresh({ windowCaptureFails: '这个窗口现在不在屏幕上' });
    await assert.rejects(idx.screenshotTool({}), e => e.code === 'window_off_screen');
    assert.ok(log.includes('capture window 7'));
    assert.ok(!log.some(x => /^(hold|session|activate|restore|capture region|veil hidden)/.test(x)), log.join(','));
    await assert.rejects(idx.clickAt({ text_id: 't1' }), e => e.code === 'no_screenshot');
  });

  await ta2('screenshot: little or no text → suggests image: true; the window\'s own bounds (not the AppleScript ones) are what click_at maps', async () => {
    await fresh({ ocrLines: [] });
    let r = await idx.screenshotTool({});
    assert.match(r.text, /没有识别到文字。要看图标、图形就加 image: true/);
    await fresh({ ocrLines: [{ text: 'OK', conf: 1, x: 10, y: 10, w: 40, h: 20 }], windowRect: { x: 101, y: 61, w: 1400, h: 900 } });
    r = await idx.screenshotTool({});
    assert.match(r.text, /识别到的文字很少.*image: true/);
    await idx.clickAt({ x: 0, y: 0 });
    assert.deepEqual(screenOf(opts.lastClickReq), [101, 61]);
  });

  await ta2('click_at without a fresh screenshot is refused; press_key presses the key N times; hover moves without clicking', async () => {
    await fresh();
    idx.__resetShotsForTests();
    await assert.rejects(idx.clickAt({ x: 1, y: 1 }), (e) => e.code === 'no_screenshot' && /先 screenshot/.test(e.message));
    await idx.pressKeyTool({ key: 'down', times: 3 });
    assert.equal(count('key'), 3);
    await fresh();
    const h = await idx.hoverTool({ marker: m('#near') });
    assert.match(h, /光标已停在 \[\d+\].*没有点击/);
    assert.ok(log.includes('move') && !log.includes('click'), log.join(','));
  });

  await ta2('answer_dialog fills a prompt() before the button; refuses text for a dialog without a field', async () => {
    await fresh({ dialog: { title: 'x 显示', texts: ['Your name?'], buttons: ['取消', '确定'], hasField: true } });
    assert.match(await idx.answerDialogTool({ button: '确定', text: '王小明' }), /填入 3 个字后按了「确定」/);
    assert.equal(opts.dialogText, '王小明');
    await fresh({ dialog: { title: 'x 显示', texts: ['Sure?'], buttons: ['OK'], hasField: false } });
    await assert.rejects(idx.answerDialogTool({ button: 'OK', text: 'x' }), (e) => e.code === 'no_text_field');
  });

  // ── page dialogs (round 5: a confirm() froze the exam page; every read waited 25 s) ──
  await ta2('page dialog: read_page says what it asks and its buttons instead of hanging; answer_dialog presses one; then the page reads again', async () => {
    await fresh({ dialog: { title: 'exam.test 显示', texts: ['检测到你上次未完成的作答，是否继续？'], buttons: ['取消', '确定'] } });
    await assert.rejects(idx.readPage(), (e) => e.code === 'page_dialog' && /未完成的作答.*按钮：取消 \/ 确定/.test(e.message) && /answer_dialog/.test(e.message));
    await assert.rejects(idx.answerDialogTool({ button: '好' }), (e) => /没有「好」按钮.*取消 \/ 确定/.test(e.message));
    const ok = await idx.answerDialogTool({ button: '确定' });
    assert.match(ok, /按了「确定」；对话框已关闭/);
    assert.match(await idx.readPage(), /Near/);
    assert.match(await idx.answerDialogTool({ button: '确定' }), /现在没有网页对话框/);
  });

  await ta2('page dialog: a click that opens one reports it at once (no 25 s page reads behind it)', async () => {
    await fresh();
    const near = m('#near');
    opts.onEval = () => {};
    pg.w.document.getElementById('near').addEventListener('click', () => { opts.dialog = { title: 'x 显示', texts: ['Sure?'], buttons: ['Cancel', 'OK'] }; });
    const t0 = Date.now();
    const out = await idx.click({ marker: near });
    assert.match(out, /网页弹出了对话框.*Sure\?.*Cancel \/ OK/s);
    assert.ok(Date.now() - t0 < 8000);
  });

  // ── select_option (round 5: a clicked <select> opens a system menu that blocks the page) ──
  const sel = () => pg.w.document.getElementById('sel');
  await ta2('select_option: picks the option with real keys (type-ahead) without opening the menu; the page confirms it', async () => {
    await fresh();
    let changes = 0;
    sel().addEventListener('change', () => changes++);
    const out = await idx.selectOption({ marker: m('#sel'), option: 'iv' });
    assert.equal(sel().value, 'iv');
    assert.match(out, /已选「iv」（用键盘选中，没有打开下拉菜单/);
    assert.ok(log.includes('type') && !log.includes('click'), `ops: ${log.join(',')}`);
    assert.equal(changes, 1);
    const out2 = await idx.selectOption({ marker: m('#sel'), option: 'iii' });
    assert.equal(sel().value, 'iii', out2);
    assert.match(out2, /用键盘选中/);
  });

  await ta2('select_option: keys that do not land fail without changing the value or emitting input/change', async () => {
    await fresh({ noTypeahead: true });
    const before = sel().value, events = [];
    sel().addEventListener('input', () => events.push('input'));
    sel().addEventListener('change', () => events.push('change'));
    await assert.rejects(idx.selectOption({ marker: m('#sel'), option: 'VI' }),
      e => e.code === 'select_failed' && /没有改用网页脚本/.test(e.message));
    assert.equal(sel().value, before);
    assert.deepEqual(events, []);
    assert.ok(log.includes('type') && !log.includes('click'), `ops: ${log.join(',')}`);
  });

  await ta2('select_option: already chosen → nothing typed; no such option → the options are listed; not a <select> → refused', async () => {
    await fresh();
    sel().selectedIndex = 2;
    const same = await idx.selectOption({ marker: m('#sel'), option: 'ii' });
    assert.match(same, /本来就是「ii」，没有改动/);
    assert.ok(!log.includes('type'));
    await assert.rejects(idx.selectOption({ marker: m('#sel'), option: 'x' }), (e) => /没有「x」这个选项。现有选项：— \/ i \/ ii/.test(e.message));
    await assert.rejects(idx.selectOption({ marker: m('#plain'), option: 'i' }), (e) => /不是下拉框/.test(e.message));
  });

  // ── task hold: one takeover for a long job (round 5) ──
  const lockHeld = () => fsSync.existsSync(process.env.CHROME_BRIDGE_LOCK);
  const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 25)); return f(); };
  const withGap = (ms, fn) => async () => { idx.__setTaskGapForTests(ms); try { await fn(); } finally { await idx.endTaskHold(); idx.__setTaskGapForTests(30000); } };

  await ta2('task hold: three actions of one task → one helper session, one hold, nothing put back in between; all put back once after the gap; the lock is held throughout', withGap(600, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    const a = await idx.click({ marker: m('#plain'), task: 'IELTS test', step: '1/3' });
    assert.match(a, /长任务进行中/);
    assert.ok(lockHeld(), 'the lock was released between two actions of the job');
    await idx.click({ marker: m('#plain'), step: '2/3' });
    pg.w.document.getElementById('q').focus();
    await idx.typeText({ text: 'abc', input_mode: 'paste', step: '3/3' });
    assert.deepEqual([count('session'), count('hold'), count('restore'), count('warp')], [1, 1, 0, 0], log.join(','));
    assert.ok(count('veil') >= 4, `veil updates: ${count('veil')}`);
    assert.ok(await until(() => count('restore') === 1, 3000), `not put back after the gap: ${log.join(',')}`);
    assert.ok(await until(() => !lockHeld(), 2000), 'lock still held after the job ended');
    assert.equal(idx.__taskHoldForTests(), null);
    assert.ok(log.lastIndexOf('warp') > log.lastIndexOf('restore') - 1, 'pointer not put back');
  }))));

  await ta2('task hold: Esc twice releases control and keeps the same task cancelled until an explicit new plan', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'IELTS test' });
    for (const kind of ['esc', 'esc', 'escUp']) await opts.lastReal.request({ op: '_inject', kind }, { raw: true });
    assert.ok(await until(() => count('restore') === 1, 3000), `not put back after Esc-Esc: ${log.join(',')}`);
    assert.ok(await until(() => !lockHeld(), 2000));
    await assert.rejects(idx.click({ marker: m('#plain'), task: 'IELTS test' }), (e) => e.code === 'user_cancelled');
    assert.equal(count('hold'), 1, 'took over again after the user took control back');
    await assert.rejects(idx.click({ marker: m('#plain'), task: 'IELTS test' }), (e) => e.code === 'user_cancelled');
    assert.equal(count('hold'), 1, 'a repeated request resumed the cancelled task');
    await idx.taskPlanTool({ task: 'IELTS test', steps: ['Resume after user consent'] });
    await idx.click({ marker: m('#plain'), task: 'IELTS test' });
    assert.equal(count('hold'), 2, 'an explicit new plan did not clear the old cancellation');
  }))));

  // The lease's release held at a gate the test opens: the end of a hold, or a hand-over between steps, is caught in the middle.
  const gateRelease = (th) => {
    const g = { reached: false };
    const done = new Promise(r => { g.open = r; });
    const release = th.lease.release.bind(th.lease);
    th.lease.release = async (...a) => { g.reached = true; await done; return release(...a); };
    return g;
  };

  await ta2('task hold: no hot-swap hand-over while the job holds, nor while its end puts the user\'s things back and lets the lease go; after that, yes', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    assert.equal(idx.__handoverRefusalForTests(), null);
    await idx.click({ marker: m('#plain'), task: 'Swap job' });
    assert.equal(idx.__handoverRefusalForTests(), 'job');
    const g = gateRelease(idx.__taskHoldForTests());
    const ending = idx.endTaskHold();
    try {
      assert.equal(idx.__handoverRefusalForTests(), 'job_ending', 'handed over while the user\'s things were being put back');
      assert.ok(await until(() => g.reached, 5000), 'the end never reached the lease');
      assert.equal(count('restore'), 1);
      assert.equal(idx.__handoverRefusalForTests(), 'job_ending', 'handed over before the lease was let go');
    } finally { g.open(); }
    await ending;
    assert.equal(idx.__handoverRefusalForTests(), null);
  }))));

  await ta2('task hold: a new task ends the last one (put back) before taking over for itself; no task → one takeover per action as before', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'Job A' });
    await idx.click({ marker: m('#plain'), task: 'Job B' });
    assert.deepEqual([count('session'), count('hold'), count('restore')], [2, 2, 1], log.join(','));
    await idx.endTaskHold();
    assert.equal(count('restore'), 2);
  }))));

  await ta2('task hold: an action of the job that fails before sending anything keeps the job\'s hold (no putting back, no new takeover); the next action goes on in it', withGap(20000, () => withTakeover(() => withRetry({ few: 0 }, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'Job C' });
    await assert.rejects(idx.click({ marker: m('#hid'), task: 'Job C' }), (e) => e.code === 'target_covered');
    assert.ok(idx.__taskHoldForTests(), 'the job lost its hold on a failure that sent nothing');
    assert.ok(lockHeld());
    assert.equal(count('restore'), 0, log.join(','));
    await idx.click({ marker: m('#plain'), task: 'Job C' });
    assert.deepEqual([count('hold'), count('session')], [1, 1]);
  }))));

  await ta2('task_plan: guessed step indexes and notes never become completed questions or visible messages; done releases the one hold', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    const ok = await idx.taskPlanTool({ task: 'IELTS reading', steps: ['Passage 1', 'Passage 2', 'Passage 3', 'Check answers', 'Submit'], estimate_minutes: 10 });
    assert.match(ok, /整项任务/);
    await idx.click({ marker: m('#plain'), step: '1/5', note: 'Q1: paragraph A says so → TRUE' });
    await idx.click({ marker: m('#plain'), step: '2/5', note: 'Q2: not mentioned → NOT GIVEN' });
    assert.ok(opts.panels.every(x => !x.panel.notes?.length), 'tool notes must never become a message feed');
    const p = opts.panels.filter(x => x.op === 'veil').at(-1)?.panel || opts.panels.at(-1).panel;
    assert.equal(p.step, '');
    assert.deepEqual(p.stages, [], 'later action indexes cannot prove earlier work completed');
    assert.equal(p.feedMode, true);
    assert.equal(p.feedCount, 0, 'no host messages have been supplied');
    assert.equal(p.feedStatus, 'unavailable');
    assert.deepEqual([count('hold'), count('restore')], [1, 0]);
    const end = await idx.taskPlanTool({ done: true });
    assert.match(end, /任务「IELTS reading」结束/);
    assert.equal(count('restore'), 1);
    assert.ok(!lockHeld());
  }))));

  // ── several agents at once (owner 2026-10-09): served in turn, the takeover handed along ──
  const LOCK_TEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lock.test.mjs');
  const otherAgent = (...args) => new Promise((res, rej) => {
    const c = spawn(process.execPath, [LOCK_TEST, ...args.map(String)], { env: { ...process.env } });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('exit', code => code === 0 ? res(out ? JSON.parse(out) : null) : rej(new Error(`${args[0]}: ${err}`)));
  });

  await ta2('queue: a long job hands its turn to an agent waiting in another process between two steps — nothing put back, the waiter gets the user\'s scene; the job\'s next step queues behind it', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'Job Q' });
    assert.ok(idx.__taskHoldForTests());
    const waiter = await otherAgent('taker', 0);
    assert.deepEqual([waiter.inherited, waiter.ownsLock], [true, true], JSON.stringify(waiter));
    assert.deepEqual(waiter.handoff.scene, { app: 'kitty', appPid: 9, chromeWindow: 1, chromeTab: 5 });
    assert.equal(waiter.handoff.touched, true);
    assert.equal(idx.__taskHoldForTests(), null, 'the job kept its hold after handing over');
    assert.equal(count('restore'), 0, `put back before handing over: ${log.join(',')}`);
    assert.ok(!lockHeld(), 'lock left behind by the waiter');
    await idx.click({ marker: m('#plain'), task: 'Job Q' });
    assert.deepEqual([count('hold'), count('session')], [2, 2], 'the job\'s next step did not take over afresh');
  }))));

  await ta2('hot swap: no hand-over while a long job hands its turn to a waiting agent between steps (until the lease is let go)', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'Job Y' });
    const g = gateRelease(idx.__taskHoldForTests());
    const waiter = otherAgent('taker', 0);
    try {
      assert.ok(await until(() => g.reached, 15000), 'the hand-over between steps never reached the lease');
      assert.equal(idx.__taskHoldForTests(), null);
      assert.equal(idx.__handoverRefusalForTests(), 'job_ending', 'handed over while the turn was being passed on');
    } finally { g.open(); }
    await waiter;
    assert.ok(await until(() => idx.__handoverRefusalForTests() === null, 5000), String(idx.__handoverRefusalForTests()));
  }))));

  await ta2('queue: an agent takes over another agent\'s takeover — the user\'s scene is not read again, the handed one is put back at the end; the answer says so', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    const giver = otherAgent('giver');
    assert.ok(await until(() => lockHeld(), 3000), "the other agent never took the lock");
    const out = await idx.click({ marker: m('#plain') });
    const g = await giver;
    assert.equal(g.taken, true, JSON.stringify(g));
    assert.match(out, /直接接过上一个 agent 的接管/);
    assert.ok(!log.includes('scene'), `read the user's scene again: ${log.join(',')}`);
    assert.deepEqual(opts.lastRestoreScene, { appPid: 9, chromeTab: 5 });
    assert.deepEqual(opts.lastWarpTo, { x: 1, y: 2 });
    assert.equal(pg.clicks.plain >= 1, true);
    assert.ok(!lockHeld());
  })));

  await ta2('Codex A3: the job is ended (task_plan done) while a hand-over between steps is under way → handed over, nothing put back twice', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'Job S' });
    const waiter = otherAgent('taker', 700);             // claims 0.7 s after the offer
    await until(() => false, 900);                          // the offer is out by now
    await idx.endTaskHold();                                // the agent says the job is done meanwhile
    const w = await waiter;
    assert.deepEqual([w.inherited, w.ownsLock], [true, true], JSON.stringify(w));
    assert.equal(count('restore'), 0, `put back although handed over: ${log.join(',')}`);
    assert.equal(idx.__taskHoldForTests(), null);
  }))));

  await ta2('Codex A4: Esc twice between two steps while someone waits → the job is cancelled (not handed on), things put back; the waiter gets the lock afresh', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'Job T' });
    for (const kind of ['esc', 'esc', 'escUp']) await opts.lastReal.request({ op: '_inject', kind }, { raw: true });
    const w = await otherAgent('taker', 0);
    assert.equal(w.inherited, false, `a hold the user had cancelled was handed on: ${JSON.stringify(w)}`);
    assert.ok(await until(() => count('restore') === 1, 3000), log.join(','));
    await assert.rejects(idx.click({ marker: m('#plain'), task: 'Job T' }), (e) => e.code === 'user_cancelled');
  }))));

  await ta2('Codex round 2 A4: Esc twice while the job is offering its turn → handed over or not, the job the user stopped does not go on', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'Job U' });
    const offerFile = path.join(process.env.CHROME_BRIDGE_LOCK, 'handoff.json');
    const waiter = otherAgent('taker', 250);
    assert.ok(await until(() => fsSync.existsSync(offerFile), 3000), 'no offer was made');
    await new Promise(r => setTimeout(r, 120));
    for (const kind of ['esc', 'esc', 'escUp']) await opts.lastReal.request({ op: '_inject', kind }, { raw: true });
    const w = await waiter;
    await until(() => !idx.__taskHoldForTests(), 3000);
    await assert.rejects(idx.click({ marker: m('#plain'), task: 'Job U' }), (e) => e.code === 'user_cancelled',
      `the stopped job went on (waiter inherited=${w.inherited})`);
  }))));

  await ta2('queue: the veil lists the agents waiting behind this one (who and task), refreshed while it holds', withGap(20000, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'Job R' });
    const qdir = process.env.CHROME_BRIDGE_LOCK + '.queue';
    fsSync.mkdirSync(qdir, { recursive: true });
    // A waiter that cannot take a takeover over (so the job does not hand over to it), alive (this pid).
    const f = path.join(qdir, '00000000000002-0000001-00001.json');
    const beat = setInterval(() => fsSync.writeFileSync(f, JSON.stringify({ pid: process.pid, label: 'w', who: 'Codex · demo', task: 'export orders', inherit: false, beat: Date.now() })), 300);
    fsSync.writeFileSync(f, JSON.stringify({ pid: process.pid, label: 'w', who: 'Codex · demo', task: 'export orders', inherit: false, beat: Date.now() }));
    try {
      const st = async () => (await opts.lastReal.request({ op: 'status' }, { raw: true }));
      const seen = await until(() => (opts.queueSeen ||= []).length > 0, 10) || await (async () => {
        for (let i = 0; i < 60; i++) { const r = await st(); if (r.panel && r.panel.queue && r.panel.queue.length) return r.panel.queue; await new Promise(x => setTimeout(x, 50)); }
        return null;
      })();
      assert.deepEqual(seen, ['Codex · demo：export orders'], `veil queue: ${JSON.stringify(seen)}`);
      assert.ok(idx.__taskHoldForTests(), 'handed over to a waiter that cannot take it');
    } finally { clearInterval(beat); fsSync.rmSync(f, { force: true }); }
  }))));

  // ── the site wants a human (round 7): stop, hand back, tell the user, wait; never solve it ──
  const addCaptcha = () => {
    const f = pg.w.document.createElement('iframe');
    f.setAttribute('src', 'https://www.google.com/recaptcha/api2/anchor?k=1&size=normal');
    f.setAttribute('data-rect', '20,300,304,78');
    pg.w.document.body.appendChild(f);
    return f;
  };
  const told = [];
  const listen = () => { told.length = 0; idx.__notifyForTests({ send: (t, o) => told.push({ t, sound: !!(o && o.sound) }), everyMs: 60000 }); };
  const quiet = () => idx.__notifyForTests({ send: () => {}, everyMs: 60000 });
  const menuState = () => JSON.parse(fsSync.readFileSync(path.join(path.dirname(process.env.CHROME_BRIDGE_LOCK), 'tasks', `${process.pid}.json`), 'utf8'));

  await ta2('CAPTCHA on the page: read_page stops with site_blocked (never solves it), the user is told once with a sound, the menu bar shows it; nothing is taken over', async () => {
    await fresh(); listen();
    addCaptcha();
    await assert.rejects(idx.readPage({ tab: 5 }), (e) => e.code === 'site_blocked' && /reCAPTCHA/.test(e.message) && /wait_for_user/.test(e.message) && /不代做、也不绕过/.test(e.message));
    await assert.rejects(idx.readPage({ tab: 5 }), (e) => e.code === 'site_blocked');
    assert.equal(told.length, 1, `told ${told.length} times within five minutes`);
    assert.ok(told[0].sound && /需要你处理：example\.test/.test(told[0].t), JSON.stringify(told));
    assert.match(menuState().alert, /需要你处理：example\.test reCAPTCHA 人机验证/);
    assert.ok(!log.includes('session'), log.join(','));
    quiet();
  });

  await ta2('CHROME_BRIDGE_LANG=en: the CAPTCHA notification is in English (the agent-facing message stays Chinese)', async () => {
    await fresh(); listen();
    const prev = process.env.CHROME_BRIDGE_LANG; process.env.CHROME_BRIDGE_LANG = 'en';
    try {
      addCaptcha();
      await assert.rejects(idx.readPage({ tab: 5 }), (e) => e.code === 'site_blocked' && /不代做、也不绕过/.test(e.message));
      assert.equal(told.length, 1, JSON.stringify(told));
      assert.match(told[0].t, /^Needs you: example\.test is showing a reCAPTCHA check\. The AI has paused and given the keyboard and mouse back/);
      assert.ok(!/[\u4e00-\u9fff]/.test(told[0].t), told[0].t);
    } finally { if (prev === undefined) delete process.env.CHROME_BRIDGE_LANG; else process.env.CHROME_BRIDGE_LANG = prev; quiet(); }
  });

  await ta2('CAPTCHA: click stops before taking anything over (no session, no hold); site_blocked is not retried', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 }); quiet();
    addCaptcha();
    await assert.rejects(idx.click({ marker: m('#near'), tab: 5 }), (e) => e.code === 'site_blocked');
    assert.deepEqual([count('session'), count('hold')], [0, 0], log.join(','));
  })));

  await ta2('CAPTCHA during a long job: the job\'s hold ends at once (keyboard and mouse back to the user), the lock is free', withGap(600, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 }); quiet();
    await idx.taskPlanTool({ task: 'Job C', steps: ['a', 'b'] });
    await idx.click({ marker: m('#near'), tab: 5 });
    assert.ok(idx.__taskHoldForTests(), 'no job hold to end');
    addCaptcha();
    await assert.rejects(idx.click({ marker: m('#near'), tab: 5 }), (e) => e.code === 'site_blocked');
    assert.equal(idx.__taskHoldForTests(), null, 'the user still cannot use the keyboard and mouse');
    assert.ok(!lockHeld());
    await idx.taskPlanTool({ done: true });
  }))));

  await ta2('wait_for_user: reads the page every few seconds (no input) and returns once the check is gone; the alert clears', async () => {
    await fresh(); quiet();
    idx.__setWaitPollForTests(20);
    const f = addCaptcha();
    await assert.rejects(idx.readPage({ tab: 5 }), (e) => e.code === 'site_blocked');
    setTimeout(() => f.remove(), 150);
    const r = await idx.waitForUserTool({ tab: 5, minutes: 0.05 });
    assert.match(r, /验证\/拦截已经没有了/);
    assert.equal(idx.__blocksForTests().size, 0);
    assert.ok(!log.includes('session'));
    assert.match(await idx.readPage({ tab: 5 }), /Near/);
  });

  await ta2('wait_for_user: still there after `minutes` → says so and says not to solve it; the alert stays', async () => {
    await fresh(); quiet();
    idx.__setWaitPollForTests(20);
    addCaptcha();
    const r = await idx.waitForUserTool({ tab: 5, minutes: 0.01 });
    assert.match(r, /用户还没处理（reCAPTCHA 人机验证（验证码））/);
    assert.match(r, /不要自己去点验证码/);
    assert.equal(idx.__blocksForTests().size, 1);
    assert.match(menuState().alert, /需要你处理/);
  });

  await ta2('wait_for_user with a reason and no check (log in, approve a payment): the user is told; returns when the page moves on', async () => {
    await fresh(); listen();
    idx.__setWaitPollForTests(20);
    assert.match(await idx.waitForUserTool({ tab: 5 }), /不需要等/);
    setTimeout(() => pg.w.history.pushState({}, '', '/after-login'), 120);
    const r = await idx.waitForUserTool({ tab: 5, reason: '登录你的账号', minutes: 0.05 });
    assert.match(r, /页面已经变了/);
    assert.ok(told.some(x => x.sound && /登录你的账号/.test(x.t)), JSON.stringify(told));
    assert.equal(idx.__blocksForTests().size, 0);
    quiet();
  });

  await ta2('stuck: three failures in a row tell the user once ("AI 好像卡住了"); site_blocked does not count; a success resets', async () => {
    await fresh(); listen();
    const err = (code, msg) => Object.assign(new Error(msg), { code });
    idx.noteOutcome(false, err('no_such_marker', '❌ 没有编号为 [9] 的元素'));
    idx.noteOutcome(false, err('site_blocked', '⏸️ blocked'));
    idx.noteOutcome(false, err('not_on_top', '❌ 没能切到前面'));
    assert.equal(told.length, 0, 'told after two real failures');
    idx.noteOutcome(false, err('no_such_marker', '❌ 没有编号为 [9] 的元素'));
    assert.equal(told.length, 1);
    assert.match(told[0].t, /AI 好像卡住了：连续 3 次没做成（最近一次：没有编号为 \[9\] 的元素）/);
    idx.noteOutcome(false, err('x', 'again'));
    assert.equal(told.length, 1, 'told again within five minutes');
    assert.match(menuState().alert, /AI 好像卡住了/);
    idx.noteOutcome(true);
    assert.equal(idx.__stuckForTests().n, 0);
    quiet();
  });

  // ── two displays (owner, 2026-10-06): the agent works on the one the user is not on ──
  const MAIN = { id: 1, isMain: true, boundsPoints: { x: 0, y: 0, w: 1920, h: 1080 } };
  const SIDE = { id: 2, isMain: false, boundsPoints: { x: 1920, y: 0, w: 1728, h: 1117 } };
  const agentStateFile = process.env.CHROME_BRIDGE_AGENT_STATE;
  const setAgentState = (st) => fsSync.writeFileSync(agentStateFile, JSON.stringify(st));
  const readAgentState = () => JSON.parse(fsSync.readFileSync(agentStateFile, 'utf8'));

  await ta2('display choice: with two, the one the user\'s pointer is NOT on (largest of the others); one display → it; main/secondary modes as named', async () => {
    const p = idx.pickAgentDisplay;
    const BIG = { id: 3, isMain: false, boundsPoints: { x: -2560, y: 0, w: 2560, h: 1440 } };
    assert.equal(p([MAIN, SIDE], { x: 500, y: 500 }, 'away').id, 2);
    assert.equal(p([MAIN, SIDE], { x: 2500, y: 300 }, 'away').id, 1);
    assert.equal(p([MAIN, SIDE, BIG], { x: 500, y: 500 }, 'away').id, 3, 'not the largest of the others');
    assert.equal(p([MAIN], { x: 500, y: 500 }, 'away').id, 1);
    assert.equal(p([MAIN, SIDE], { x: 2500, y: 300 }, 'secondary').id, 2);
    assert.equal(p([MAIN, SIDE], { x: 500, y: 500 }, 'main').id, 1);
  });

  await ta2('two displays: the agent window on the user\'s display (where the agent put it) is moved to the other one before acting; the result says so', () => withTakeover(() => withRetry({}, async () => {
    const saved = fsSync.readFileSync(agentStateFile, 'utf8');
    try {
      await fresh({ idle: 0, displays: [MAIN, SIDE], mouse: { x: 600, y: 400 } }); quiet();
      setAgentState({ byProfile: { 'Profile 3': { windowId: 1, display: 1, placed: { ...BOUNDS } } } });
      const r = await idx.click({ marker: m('#near'), tab: 5 });
      assert.match(log.find(x => x.startsWith('moveWindow')) || '', /^moveWindow 1 1940,40,3628,1097$/, log.join(','));
      assert.ok(log.indexOf(log.find(x => x.startsWith('moveWindow'))) < log.indexOf('activate'), 'moved after it was raised');
      assert.match(r, /已挪到另一块屏幕/);
      assert.deepEqual(readAgentState().byProfile['Profile 3'].placed, { left: 1940, top: 40, width: 1688, height: 1057 });
    } finally { fsSync.writeFileSync(agentStateFile, saved); }
  })));

  await ta2('panel setting 「固定在副屏 / 主屏」 chosen after the window was made: the agent window is moved there (where the agent put it only); away keeps its rule (Codex r13 A3)', () => withTakeover(() => withRetry({}, async () => {
    const saved = fsSync.readFileSync(agentStateFile, 'utf8');
    const settingsFile = process.env.CHROME_BRIDGE_SETTINGS;
    const put = (o) => { fsSync.writeFileSync(settingsFile, JSON.stringify(o)); const t = new Date(Date.now() + Math.random() * 1e6); fsSync.utimesSync(settingsFile, t, t); };
    try {
      // On the main display, the user on the secondary: away leaves it (not in the user's way); secondary moves it there.
      for (const [mode, moved] of [['away', false], ['secondary', true], ['main', false]]) {
        put({ agentDisplay: mode });
        await fresh({ idle: 0, displays: [MAIN, SIDE], mouse: { x: 2500, y: 300 } }); quiet();
        setAgentState({ byProfile: { P: { windowId: 1, display: 1, placed: { ...BOUNDS } } } });
        const r = await idx.click({ marker: m('#near'), tab: 5 });
        const mv = log.find(x => x.startsWith('moveWindow'));
        assert.equal(!!mv, moved, `${mode}: ${log.join(',')}`);
        if (moved) { assert.match(mv, /^moveWindow 1 1940,40,3628,1097$/); assert.match(r, /按菜单栏里的设置，agent 窗口已挪到副屏/); }
      }
      // The user moved it themselves: never moved, whatever the setting.
      put({ agentDisplay: 'secondary' });
      await fresh({ idle: 0, displays: [MAIN, SIDE], mouse: { x: 600, y: 400 } }); quiet();
      setAgentState({ byProfile: { P: { windowId: 1, placed: { left: 5, top: 5, width: 300, height: 300 } } } });
      await idx.click({ marker: m('#near'), tab: 5 });
      assert.ok(!log.some(x => x.startsWith('moveWindow')), 'moved a window the user had moved');
    } finally { fsSync.writeFileSync(agentStateFile, saved); try { fsSync.rmSync(settingsFile); } catch {} }
  })));

  await ta2('open_tab creating the agent window: the user\'s scene put back, then the front checked once more (Chrome came forward late, live 2026-10-13)', async () => {
    const saved = fsSync.readFileSync(agentStateFile, 'utf8');
    try {
      await fresh({ displays: [MAIN], mouse: { x: 600, y: 400 }, chromeInfo: (tab, target) => target({ tabId: 88, url: 'http://example.test/' }),
        newWindow: async (url, b, prof) => { log.push(`newWindow ${prof}`); return { ok: true, windowId: 1, tabId: 88 }; } });
      setAgentState({ byProfile: {} });
      const out = await idx.openTabTool({ url: 'http://example.test/', why: 'needs_user_login' });
      const i = log.indexOf('newWindow Profile 3'), r = log.indexOf('restore', i), a = log.indexOf('restoreApp 9', i);
      assert.ok(i >= 0 && r > i && a > r, log.join(','));
      // Not over a click of the user's into Chrome since; moving the mouse or typing does not stop it (Fable r12 r3 B1).
      const o = opts.lastRestoreAppOpts;
      assert.ok(o && o.noClickSince > 0 && o.noInputSince == null, JSON.stringify(o));
      assert.match(out, /创建 agent 专用窗口 1/);
    } finally { fsSync.writeFileSync(agentStateFile, saved); await tabsMod.forgetTab(88).catch(() => {}); }
  });

  await ta2('two displays: NOT moved when the user moved/resized it, when it is not the agent\'s window, or when it is already on the other display', () => withTakeover(() => withRetry({}, async () => {
    const saved = fsSync.readFileSync(agentStateFile, 'utf8');
    try {
      for (const [why, st, mouse] of [
        ['the user moved it', { byProfile: { P: { windowId: 1, placed: { left: 1940, top: 40, width: 1688, height: 1057 } } } }, { x: 600, y: 400 }],
        ['not the agent\'s window', { byProfile: { P: { windowId: 99, placed: { ...BOUNDS } } } }, { x: 600, y: 400 }],
        ['the user is on the other display', { byProfile: { P: { windowId: 1, placed: { ...BOUNDS } } } }, { x: 2500, y: 300 }],
      ]) {
        await fresh({ idle: 0, displays: [MAIN, SIDE], mouse }); quiet();
        setAgentState(st);
        await idx.click({ marker: m('#near'), tab: 5 });
        assert.ok(!log.some(x => x.startsWith('moveWindow')), `${why}: moved anyway`);
      }
      // One display: nothing to move to.
      await fresh({ idle: 0, displays: [MAIN], mouse: { x: 600, y: 400 } }); quiet();
      setAgentState({ byProfile: { P: { windowId: 1, placed: { ...BOUNDS } } } });
      await idx.click({ marker: m('#near'), tab: 5 });
      assert.ok(!log.some(x => x.startsWith('moveWindow')));
    } finally { fsSync.writeFileSync(agentStateFile, saved); }
  })));

  // ── read_page tiers (owner, 2026-10-06): the page code within budget → the screen's text → the picture ──
  await ta2('read_page tiers: within budget → the page code, with its token count, nothing captured', async () => {
    await fresh(); quiet();
    const r = await idx.readPage({ tab: 5 });
    assert.equal(typeof r, 'string');
    assert.match(r, /（这次读的是网页代码，约 \d+ token）/);
    assert.ok(!log.some(x => x.startsWith('capture')), log.join(','));
  });

  await ta2('read_page tiers: over budget, page visible → the window captured directly (no takeover), its text recognised, lines usable by click_at text_id', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 }); quiet();
    const r = await idx.readPage({ tab: 5, budget: 200 });
    assert.equal(typeof r, 'string', 'gave a picture although the text fits');
    assert.match(r, /📖 网页代码这一屏约 \d+ token，超过预算 200，改为读屏幕上的字；网页可见，直接截了这个窗口（没有接管键鼠）/);
    assert.match(r, /t1 \(\d+,\d+\) 登录/);
    assert.match(r, /估算：网页代码这一屏约 \d+ token，屏幕识字约 \d+ token，整张图约 \d+ token/);
    assert.ok(log.includes('capture window 7') && !log.includes('hold') && !log.includes('session'), log.join(','));
    assert.ok(log.includes('dispose window'), 'the capture was not cleaned up');
    await idx.clickAt({ text_id: 't1', tab: 5 });
    assert.ok(opts.lastClickReq, 'click_at text_id did not click');
  })));

  await ta2('read_page tiers: the recognised text over budget too → the picture (bounded cost), with the reason and the estimates', async () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ text: '很长的一行屏幕文字'.repeat(6) + i, conf: 1, x: 100, y: 100 + i * 40, w: 1200, h: 30 }));
    await fresh({ ocrLines: long }); quiet();
    const r = await idx.readPage({ tab: 5, budget: 200 });
    assert.equal(typeof r, 'object');
    assert.ok(r.image && r.image.data && r.image.width > 0);
    assert.match(r.text, /屏幕上的字也有约 \d+ token，直接给这一屏的图/);
  });

  await ta2('read_page tiers: most of the screen is a canvas → the screen is read even within budget; the reason says so', async () => {
    await fresh(); quiet();
    const c = pg.w.document.createElement('canvas');
    c.setAttribute('data-rect', '0,0,1400,700');
    pg.w.document.body.appendChild(c);
    const r = await idx.readPage({ tab: 5 });
    assert.match(String(r.text || r), /这一屏约 \d+% 是网页代码读不出字的内容/);
    assert.ok(log.includes('capture window 7'));
  });

  // Reading never takes the keyboard and mouse or brings Chrome forward (Codex merge review, 2026-10-07).
  await ta2('read_page tiers: page not visible (another tab in front, covered) → the page code with the reason, nothing held, captured or brought forward', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 }); quiet();
    Object.defineProperty(pg.w.document, 'visibilityState', { get: () => 'hidden', configurable: true });
    const r = await idx.readPage({ tab: 5, budget: 200 });
    assert.equal(typeof r, 'string');
    assert.match(r, /（这次读的是网页代码，约 \d+ token：网页代码这一屏约 \d+ token，超过预算 200，但网页当时不在屏幕上[^\n]*读网页不会接管键鼠去截图。可继续用 full \/ sections \/ query 读取/);
    assert.match(r, /=== 这一屏[\s\S]*\[1\] Near/, 'the page code itself');
    assert.ok(!log.some(x => /^(hold|session|capture|activate)/.test(x)), log.join(','));
  })));

  await ta2('read_page tiers: page visible but its window cannot be captured → the page code with the reason, no takeover, no screen-area capture', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0, windowCaptureFails: 'window off screen' }); quiet();
    const r = await idx.readPage({ tab: 5, budget: 200 });
    assert.equal(typeof r, 'string');
    assert.match(r, /但这个窗口截不到；读网页不会接管键鼠去截图/);
    assert.ok(!log.some(x => /^(hold|session|capture region|activate)/.test(x)), log.join(','));
  })));

  await ta2('read_page tiers: asked for something specific (full, sections, query) → that, never the screen', async () => {
    await fresh(); quiet();
    for (const a of [{ full: true }, { sections: ['S1'] }, { query: 'Near' }]) {
      const r = await idx.readPage({ tab: 5, budget: 200, ...a }).catch(e => e.message);
      assert.equal(typeof r, 'string');
      assert.doesNotMatch(r, /📖/, JSON.stringify(a));
    }
    assert.ok(!log.some(x => x.startsWith('capture')), log.join(','));
  });

  // ── tool definitions routed (owner, 2026-10-07): the routing said once in the server instructions, tools kept short ──
  await ta2('tool definitions stay small (17 under 15,000 characters, including routines); no tool repeats the routing rule', async () => {
    const tools = idx.__toolsForTests();
    const size = JSON.stringify(tools).length;
    assert.equal(tools.length, 17);
    assert.ok(size <= 15000, `tool definitions grew to ${size} characters`);
    assert.ok(!tools.some(t => /WHEN TO USE/.test(t.description)), 'a tool carries the routing paragraph again');
  });

  await ta2('server instructions: the routing with MyChrome last, the CAPTCHA rule, the shared action behaviour', async () => {
    const r = idx.serverInstructions({ home: '/nonexistent-home', execPath: '/nonexistent/node' });
    assert.match(r, /It is the fallback, not the first choice/);
    assert.match(r, /Never solve it or switch tools to get around it/);
    assert.match(r, /Esc pressed twice returns user_cancelled/);
    assert.match(r, /computer use can see browsers but not click in them/);
  });

  await ta2('open_tab accepts why=other_tool_failed (another tool failed or was blocked); an unknown why is still refused', async () => {
    await fresh({ chromeInfo: (tab, target) => target({ tabId: 88, url: 'https://example.test/' }) });
    const out = await idx.openTabTool({ url: 'http://example.test/', why: 'other_tool_failed' });
    assert.match(out, /新开标签 tab=88/);
    await assert.rejects(idx.openTabTool({ url: 'http://example.test/', why: 'because' }), (e) => e.code === 'why_required' && /other_tool_failed/.test(e.message));
    await tabsMod.forgetTab(88);
  });

  // ── progress panel (docs/discussion-round4/summary.md) ──
  const keys = (p) => p.stages.map(x => x.key);
  const states = (p) => Object.fromEntries(p.stages.map(x => [x.key, x.state]));

  await ta2('panel: a click\'s hold carries who, the agent\'s task and step, and the click\'s stages; the helper ticks them off as the ops run', withGap(0, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#near'), task: '给供应商回信', step: '3/7' });
    const p = opts.holdReq.veil.panel;
    assert.ok(p, 'hold sent no panel');
    assert.match(JSON.stringify(p.who), /(Claude|Codex|Agent) · /, 'who: client · project folder');
    assert.ok(Number.isInteger(p.color) && p.color >= 0 && p.color < 6);
    assert.deepEqual([p.task, p.step], ['给供应商回信', '3/7']);
    assert.deepEqual(keys(p), ['hold', 'focus', 'move', 'press', 'restore']);
    assert.deepEqual(p.action, { zh: '正在点击「Near」', en: 'Clicking "Near"' });
    const after = (op) => opts.panels.find(x => x.op === op).panel;
    assert.deepEqual(states(after('hold')), { hold: 'done', focus: 'running', move: 'pending', press: 'pending', restore: 'pending' });
    assert.deepEqual(states(after('click')), { hold: 'done', focus: 'done', move: 'done', press: 'done', restore: 'running' });
    assert.ok(log.indexOf('panel') > log.indexOf('click'), `the restore stage was not announced after the action: ${log.join(',')}`);
    const last = opts.panels.at(-1).panel;
    assert.equal(last.fraction <= 1 && last.etaMs >= 0, true);
  }))));

  await ta2('panel: the task is kept for the session\'s next action; a step is not; a task repeating the text being typed is not shown', withGap(0, () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    await idx.click({ marker: m('#plain'), task: 'Reply to the supplier', step: '1/2' });
    await idx.click({ marker: m('#plain') });
    assert.deepEqual([opts.holdReq.veil.panel.task, opts.holdReq.veil.panel.step], ['Reply to the supplier', '']);
    pg.w.document.getElementById('q').focus();
    await idx.typeText({ text: 'the supplier', input_mode: 'paste', task: 'Reply to the supplier' });
    assert.equal(opts.holdReq.veil.panel.task, '', 'the task echoed the typed text');
    await idx.click({ marker: m('#plain') });
    assert.equal(opts.holdReq.veil.panel.task, '', 'a task dropped for echoing the typed text came back on the next call');
    await idx.click({ marker: m('#plain'), step: '9/3' });
    assert.equal(opts.holdReq.veil.panel.step, '', 'an impossible step was shown');
  }))));

  await ta2('panel: type_text into a field names it by its placeholder (never its value), counts characters typed key by key, confirms, then restores', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    pg.w.document.getElementById('q').value = 'old value';
    await idx.typeText({ marker: m('#q'), text: 'abc', input_mode: 'keys' });
    const p = opts.holdReq.veil.panel;
    assert.deepEqual(opts.holdReq.veil.label, { zh: '正在输入到「搜索」', en: 'Typing into "搜索"' });
    assert.doesNotMatch(JSON.stringify(opts.holdReq), /old value/);
    assert.deepEqual(keys(p), ['hold', 'focus', 'move', 'press', 'type', 'confirm', 'restore']);
    assert.deepEqual([p.chars, p.perChar, p.showCount], [3, true, true]);
    const typed = opts.panels.find(x => x.op === 'type').panel;
    assert.deepEqual(typed.chars, [3, 3]);
    assert.equal(states(typed).type, 'running');
    const restoreAt = log.lastIndexOf('panel');
    assert.ok(restoreAt > log.indexOf('type'), `order: ${log.join(',')}`);
  })));

  await ta2('panel: text the field does not show → the check is failed (red), Return and restore never turn green', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0, swallowText: true });
    await assert.rejects(idx.typeText({ marker: m('#q'), text: 'hello', submit: true }),
      e => e.code === 'input_unconfirmed' && /^❌ 未确认已输入/.test(e.message));
    const last = opts.panels.at(-1).panel;
    const st = Object.fromEntries(last.stages.map(x => [x.key, x.state]));
    assert.deepEqual([st.type, st.confirm, st.submit, st.restore], ['done', 'failed', 'pending', 'pending'], JSON.stringify(last.stages));
  })));

  await ta2('panel: a password field shows neither its name nor how many characters go in', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ idle: 0 });
    const q = pg.w.document.getElementById('q');
    q.setAttribute('type', 'password');
    q.setAttribute('placeholder', '登录密码');
    await idx.typeText({ marker: m('#q'), text: 'hunter22', input_mode: 'keys' });
    const v = opts.holdReq.veil;
    assert.deepEqual(v.label, { zh: '正在输入', en: 'Typing' });
    assert.deepEqual([v.panel.showCount, v.panel.chars, v.panel.perChar], [false, 0, false]);
    assert.doesNotMatch(JSON.stringify(v.panel.stages), /8/, 'the length is in a stage label or estimate');
    assert.ok(opts.panels.every(x => x.panel.stages.every(st => st.detail === '')), 'a count was shown for a password field');
    assert.doesNotMatch(JSON.stringify(v), /hunter22/);
  })));

  await ta2('panel: a click that fails after the hold marks its stage failed; nothing after it turns green', () => withTakeover(() => withRetry({}, async () => {
    await fresh({ injectAfterOp: 'begin', injectKinds: ['esc', 'esc'] });
    await assert.rejects(idx.click({ marker: m('#near') }), (e) => e.code === 'user_cancelled');
    const last = opts.panels.at(-1).panel;
    assert.ok(last.stages.some(x => x.state === 'failed'), JSON.stringify(last.stages));
    const i = last.stages.findIndex(x => x.state === 'failed');
    assert.ok(last.stages.slice(i + 1).every(x => x.state === 'pending'), JSON.stringify(last.stages));
  })));

  await ta2('A2: a stuck (sticky) header on a scrolled page: one burst shows the wheel does not move it, then it is clicked', async () => {
    await fresh();
    pg.state.sy = 1000;
    const bar = pg.w.document.createElement('a');
    bar.id = 'sticky'; bar.href = '#sticky'; bar.textContent = 'Menu';
    bar.setAttribute('data-rect', '100,20,100,24');
    bar.setAttribute('data-sticky', '');
    pg.w.document.body.append(bar);
    runRead(pg.w);
    const out = await idx.click({ marker: m('#sticky') });
    assert.doesNotMatch(out, /程序滚动/);
    assert.equal(log.filter(x => x === 'wheel').length, 1, `kept wheeling a page that does not move the target: ${out}`);
    assert.equal(pg.calls.scrollIntoView.length, 0);
  });

  await ta2('A2: a header link at the top of a page at scroll 0 → clicked in place, no programmatic scroll reported', async () => {
    await fresh();
    const top = pg.w.document.createElement('a');
    top.id = 'hdr'; top.href = '#hdr'; top.textContent = 'Header';
    top.setAttribute('data-rect', '100,20,100,24');
    pg.w.document.body.append(top);
    runRead(pg.w);
    const out = await idx.click({ marker: m('#hdr') });
    assert.doesNotMatch(out, /程序滚动/);
    assert.equal(pg.calls.scrollIntoView.length, 0);
    assert.ok(!log.includes('wheel'), 'wheeled a page that is already at the top');
  });

  await ta2('scroll: visible tab, real wheel only, pointer put back, the user\'s scene untouched', async () => {
    await fresh();
    const out = await idx.scroll({ direction: 'down', amount: 1 });
    assert.match(out, /✅ 已用真实滚轮向下滚动：整页 0 → \d+/);
    assert.ok(pg.state.sy >= 700, `moved ${pg.state.sy}`);
    assert.ok(!log.includes('activate') && !log.includes('restore'));
    assert.equal(log.at(-1), 'warp');
  });

  await ta2('scroll: a hidden tab in the user\'s own window is refused without touching anything', async () => {
    await fresh({ info: { tabActive: false, windowId: 2 } });
    await assert.rejects(idx.scroll({ direction: 'down' }), (e) => e.code === 'tab_hidden');
    assert.ok(!log.includes('session') && !log.includes('warp'));
  });

  await ta2('scroll: a hidden tab of the agent window is selected first (no activation), then wheeled', async () => {
    await fresh({ chromeInfo: (tab, target) => target({ tabActive: !!opts.selected }) });
    const out = await idx.scroll({ direction: 'down', amount: 0.5, tab: 5 });
    assert.ok(log.includes('select window=1'), `selectTab was not used with the agent window: ${log.join(',')}`);
    assert.ok(!log.includes('activate'));
    assert.match(out, /已先把它设为当前标签；没有把 Chrome 切到前面/);
    assert.ok(log.indexOf('select window=1') < log.indexOf('session'), 'select happens before the session');
  });

  await ta2('codex1-9: the tab is dragged into the user\'s window while queued → decided again under the lock, not selected', async () => {
    let n = 0;
    // First look (before the lock): hidden in the agent window 1. Under the lock: hidden in the user's window 2.
    await fresh({ chromeInfo: (tab, target) => target({ tabActive: false, windowId: n++ === 0 ? 1 : 2 }) });
    await assert.rejects(idx.scroll({ direction: 'down', tab: 5 }), (e) => e.code === 'tab_hidden');
    assert.ok(!log.some(x => x.startsWith('select')), `selected a tab in the user's window: ${log.join(',')}`);
    assert.ok(!log.includes('session'));
  });

  await ta2('A4: an agent scroll that rewrites the URL (replaceState) is recorded as the agent\'s, not a takeover', async () => {
    await fresh();
    await tabsMod.registerTab(5, pg.w.location.href, { windowId: 1, now: Date.now() - 60_000 });
    pg.w.addEventListener('scroll-model', () => {});
    const orig = pg.w.location.href;
    opts.onEval = (src) => { if (src.includes('"measure"')) pg.w.history.replaceState({}, '', '/page?p=2'); };
    await idx.scroll({ direction: 'down', amount: 0.5, tab: 5 });
    const rec = await tabsMod.getTab(5);
    assert.notEqual(pg.w.location.href, orig);
    assert.equal(rec.expectedUrl, pg.w.location.href, 'the URL at the end of the action was not recorded');
    assert.equal(rec.takenOver, false);
    const c = await tabsMod.checkTabBeforeUse(5, { id: 5, url: pg.w.location.href, windowId: 1 }, Date.now() + 60_000);
    assert.equal(c.takenOver, false, 'the next use check marked the agent\'s own URL change');
    await tabsMod.forgetTab(5);
  });

  await ta2('list_tabs: first line is the version; agent tabs are labelled', async () => {
    await fresh();
    await tabsMod.registerTab(5, pg.w.location.href, { windowId: 1 });
    const out = await idx.listTabsTool();
    assert.ok(out.split('\n')[0].startsWith(`MyChrome MCP 版本 ${idx.VERSION}`), out.split('\n')[0]);
    // Registered by this process: the session's own tab, listed first and labelled as its own (tab ledger).
    assert.match(out.split('\n')[1], /^你（这个会话）的标签（\d+ 个）：$/);
    assert.match(out, /^ {2}tab=5 ready /m);
    assert.match(out, /tab=5 .*［你的·ready］/);
    await tabsMod.forgetTab(5);
  });

  await ta2('open_tab: under the input lock, --select in the agent window, registered with its window; redirect recorded', async () => {
    const lockDuringSettle = [];
    await fresh({ chromeInfo: (tab, target) => target({ tabId: 88, url: 'https://example.test/landing' }),
      onChromeInfo: () => lockDuringSettle.push(fsSync.existsSync(process.env.CHROME_BRIDGE_LOCK)) });
    await assert.rejects(idx.openTabTool({ url: 'http://example.test/' }), (e) => {
      assert.equal(e.code, 'why_required');
      assert.match(e.message, /公开网页用 WebFetch\/curl 或网站的 API/);
      return true;
    });
    assert.ok(!log.some(x => x.startsWith('openTab')), 'opened a tab without a reason');
    const out = await idx.openTabTool({ url: 'http://example.test/', why: 'needs_user_login' });
    assert.match(out, /✅ 已在用户资料「庄严」（u@test）的 agent 专用窗口（1）新开标签 tab=88/);
    assert.ok(log.includes('openTab http://example.test/ 1 select=true lock=true'), log.join(','));
    assert.ok(!log.includes('session') && !log.includes('activate'), 'open_tab took the pointer');
    const rec = await tabsMod.getTab(88);
    assert.equal(rec.windowId, 1);
    assert.equal(rec.expectedUrl, 'https://example.test/landing');
    assert.match(out, /页面跳转到了/);
    assert.ok(lockDuringSettle.length > 0 && lockDuringSettle.every(Boolean),
      `A4: the redirect settled outside the input lock (a sweep could mark the tab): ${lockDuringSettle}`);
  });

  await ta2('close_tab: closes an agent tab and confirms it is gone; refuses user tabs and taken-over tabs', async () => {
    await fresh();
    opts.extraTabs = [{ id: 88, url: 'https://example.test/landing', title: 'new', active: false }];
    assert.match(await idx.closeTabTool({ tab: 88 }), /✅ 已关闭 agent 标签 88（已确认它不在了）/);
    assert.equal(await tabsMod.getTab(88), null);
    await assert.rejects(idx.closeTabTool({ tab: 5 }), (e) => e.code === 'not_agent_tab');
    await tabsMod.registerTab(89, 'https://example.test/a', { windowId: 1, now: Date.now() - 60_000 });
    opts.extraTabs = [{ id: 89, url: 'https://example.test/user-went-here', title: 'x', active: false }];
    await assert.rejects(idx.closeTabTool({ tab: 89 }), (e) => e.code === 'taken_over' && /可能已被你接手/.test(e.message));
    assert.ok(!log.includes('closeTab 89'), 'a taken-over tab was closed');
    await tabsMod.forgetTab(89);
  });

  await ta2('read_page on an agent tab the user navigated: marked taken over (sticky), said so', async () => {
    await fresh();
    await tabsMod.registerTab(5, 'https://example.test/elsewhere', { windowId: 1, now: Date.now() - 60_000 });
    const out = await idx.readPage({ tab: 5 });
    // Registered by this process: its own tab, so the note says what to do (tab ledger); another agent's tab keeps the old note.
    assert.match(out, /已标记为「可能已被用户接手」。可能被用户动过（它现在的网址不是 agent 打开或点出来的）：先 read_page\(tab=5\)/);
    assert.equal((await tabsMod.getTab(5)).takenOver, true);
    await tabsMod.forgetTab(5);
  });

  await ta2('read_page (round 7): default = this screen + outline with the expand hint as the last line; sections / query / full reach the page script; a bad section id is refused', async () => {
    await fresh();
    const d = await idx.readPage();
    assert.match(d.split('\n').at(-1), /^提示：这个页面没有目录可展开/);
    assert.match(d, /这个页面没有标题结构/);
    assert.match(d, /=== 这一屏[\s\S]*Near/);
    assert.doesNotMatch(d, /Far/, '#far is 2000 px down, off screen');
    assert.match(d, /（页面共 \d+ 个可点击元素；用 click 工具/);
    assert.ok(d.indexOf('（页面共') < d.lastIndexOf('提示：'), 'the hint comes after the click note');
    const f = await idx.readPage({ full: true });
    assert.match(f, /Far/);
    assert.match(f, /=== 可点击元素索引（共 \d+ 个）===/);
    assert.match(f.split('\n').at(-1), /^（想点的东西没有编号时/, 'full mode ends as before');
    const q = await idx.readPage({ query: 'FAR' });
    // The buttons sit inline in one block here, so the hit is that whole line.
    assert.match(q, new RegExp(`查找「FAR」（不区分大小写）：找到 1 处 ===\\n页面：\\n  [^\\n]*\\[${m('#far')}\\] Far`));
    await assert.rejects(idx.readPage({ sections: ['历史'] }), (e) => e.code === 'bad_sections' && /\["S3","S7"\]/.test(e.message));
    assert.match(await idx.readPage({ sections: 'S1, 2' }), /没有标题结构，没有可展开的节/);
    // The page script gets the request as given (normalized ids), under its placeholder.
    let seen = null;
    opts.onEval = (src) => { const mm = src.match(/var REQ = typeof \{.*?\} === 'undefined' \? \{ full: true \} : \((\{.*?\}) \|\| \{\}\);/); if (mm) seen = JSON.parse(mm[1]); };
    await idx.readPage({ sections: ['s3', '7'], query: ' 关键 词 ' });
    assert.deepEqual(seen, { sections: ['S3', 'S7'], query: '关键 词' });
    const tool = idx.__toolsForTests().find(x => x.name === 'read_page');
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['tab', 'budget', 'sections', 'query', 'full']);
    assert.ok(tool.description.length <= 1273, `description ${tool.description.length} > 1.5 × 849`);
  });

  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} test groups passed.`);
