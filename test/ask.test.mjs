#!/usr/bin/env node
/* wait_for_user with `field`: the page script (src/page/ask.js) in jsdom — the field highlighted and
 * focused, done on the user's trusted Return in it (or its form's submit), never on a page script's
 * synthetic key, an IME composition's Return, a Return elsewhere, or a plain Return in a multi-line
 * field; the field's content never in a result — and its wiring in src/index.js, with a fake bridge
 * that runs the real script in a jsdom window: the call returns once the user presses Return, after a
 * navigation, a reload or the field leaving the page; the highlight is removed on timeout; the menu
 * bar and the notification say what to type. Nothing reaches the real Chrome or the input helper. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-ask-test-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
process.env.CHROME_BRIDGE_NOTIFY = '0';
process.env.CHROME_BRIDGE_AGENT_NAME = 'ask-test';
process.env.CHROME_BRIDGE_HABITS = 'off';
process.env.CHROME_BRIDGE_MENUBAR = '0';
process.env.CHROME_BRIDGE_LANG = 'zh';
await mkdir(path.join(tmp, 'lock'));
await writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ byProfile: { Default: { windowId: 7, name: 'Me' } } }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = await readFile(path.join(ROOT, 'src/page/read.js'), 'utf8');
const askSrc = await readFile(path.join(ROOT, 'src/page/ask.js'), 'utf8');
const afterSrc = await readFile(path.join(ROOT, 'src/page/after.js'), 'utf8');
const blockSrc = await readFile(path.join(ROOT, 'src/page/block.js'), 'utf8');
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

/* A key or submit the page sees as trusted (a real key from macOS); jsdom's own dispatch clears isTrusted. */
const req = createRequire(import.meta.url);
const jsdomUtils = req(path.join(path.dirname(req.resolve('jsdom')), 'generated/idl/utils.js'));
function trusted(target, event) {
  const ev = jsdomUtils.implForWrapper(event);
  ev.isTrusted = true;
  return jsdomUtils.implForWrapper(target)._dispatch(ev);
}
const key = (w, el, o = {}) => trusted(el, new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, composed: true, ...o }));

const PAGE = `
  <form id="login" action="/session">
    <input id="user" type="text" placeholder="用户名">
    <input id="pw" type="password" placeholder="密码">
    <button id="go" type="submit">登录</button>
  </form>
  <input id="outside" type="text" placeholder="搜索">
  <textarea id="note" placeholder="备注"></textarea>
  <div id="rich" contenteditable="true">x</div>
  <button id="btn">一个按钮</button>
  <input id="ro" type="text" readonly placeholder="只读">
  <input id="cb" type="checkbox">`;

function makeDom(html = PAGE, url = 'https://shop.test/login') {
  const w = new JSDOM(`<!doctype html><html><head><title>登录</title></head><body>${html}</body></html>`,
    { url, runScripts: 'outside-only', pretendToBeVisual: true }).window;
  w.Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 100, width: 200, height: 24, left: 10, top: 100, right: 210, bottom: 124, toJSON() { return this; } };
  };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  w.Element.prototype.scrollIntoView = function () { w.__scrolled = this.id; };
  w.document.elementFromPoint = () => null;
  Object.defineProperty(w, 'innerWidth', { value: 1200, configurable: true });
  Object.defineProperty(w, 'innerHeight', { value: 800, configurable: true });
  // The note lives in a closed shadow root; open here so the test can read it (the script itself asks for closed).
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (o) { w.__shadowMode = o.mode; return attach.call(this, { ...o, mode: 'open' }); };
  return w;
}
const runRead = (w) => JSON.parse(w.eval(readSrc.replaceAll('__READ__', () => JSON.stringify({}))));
// `entered.at` (when the page saw the Return) is checked here and left out, so the results compare as data.
const askRaw = (w, a) => JSON.parse(w.eval(askSrc.replaceAll('__ASK__', () => JSON.stringify(a))));
const ask = (w, a) => {
  const r = askRaw(w, a);
  if (r.entered) {
    assert.ok(Number.isFinite(r.entered.at) && Math.abs(r.entered.at - Date.now()) < 5000, `entered.at: ${JSON.stringify(r.entered)}`);
    delete r.entered.at;
  }
  return r;
};
const markerOf = (w, sel) => w.__chromeBridge.markers.indexOf(w.document.querySelector(sel));
const TEXT = { title: '需要你输入：登录密码', hint: '输入完成后按回车，再回到原 AI 对话说“继续”', hintMulti: '输入完成后按 ⌘+回车，再回到原 AI 对话说“继续”', brand: 'MyChrome · AI 在等你', tab: '【需要你输入】' };
const host = (w) => w.document.querySelectorAll('[data-mychrome-ask]');
const noteText = (w) => [...host(w)].map(h => h.shadowRoot ? h.shadowRoot.textContent : '').join('|');

/* ------------------------------------------------------------ page script */

console.log('src/page/ask.js (jsdom)');
{
  const w = makeDom();
  const a = ask(w, { arm: 't1', marker: 3, text: TEXT });
  assert.deepEqual([a.ok, a.error], [false, 'stale']);
  runRead(w);
  const n = ask(w, { arm: 't1', marker: 999, text: TEXT });
  assert.deepEqual([n.ok, n.error], [false, 'no_such_marker']);
  // jsdom has no isContentEditable, so read.js leaves the contenteditable unnumbered; Chrome numbers it.
  if (markerOf(w, '#rich') < 1) w.__chromeBridge.markers.push(w.document.querySelector('#rich'));
  const numbered = [];
  for (const sel of ['#btn', '#ro', '#cb', '#rich']) {
    const m = markerOf(w, sel);
    if (m < 1) continue;   // not numbered at all by read_page: nothing to point at
    numbered.push(sel);
    const r = ask(w, { arm: 't1', marker: m, text: TEXT });
    assert.deepEqual([r.ok, r.error], [false, 'not_a_field'], sel);
    assert.match(r.message, /不是可输入的文本框/);
  }
  assert.ok(numbered.includes('#btn') && numbered.includes('#rich'), `refusals not exercised: ${numbered}`);
  assert.equal(host(w).length, 0, 'a refused arm drew something');
  ok('refuses before read_page, an unknown marker, and anything that is not an input or textarea (button, read-only, checkbox, contenteditable); draws nothing then');
}
{
  const w = makeDom();
  runRead(w);
  const m = markerOf(w, '#pw');
  w.document.querySelector('#outside').focus();
  const a = ask(w, { arm: 't1', marker: m, text: TEXT });
  assert.deepEqual([a.ok, a.armed, a.kind, a.password, a.filled], [true, true, 'single', true, false]);
  assert.equal(w.document.activeElement.id, 'pw', 'the field is not focused');
  assert.equal(w.__scrolled, 'pw', 'the field was not scrolled into view');
  assert.equal(host(w).length, 1);
  assert.equal(w.__shadowMode, 'closed');
  assert.match(noteText(w), /需要你输入：登录密码.*输入完成后按回车，再回到原 AI 对话说“继续”.*MyChrome · AI 在等你/);
  assert.equal(host(w)[0].style.pointerEvents, 'none', 'the highlight would catch the user\'s clicks');
  // Spotlight: the rest of the page dimmed around the field; the tab title says it too.
  const spot = host(w)[0].shadowRoot.firstElementChild;
  assert.match(spot.style.boxShadow, /200vmax/, 'no spotlight');
  assert.equal(spot.style.pointerEvents, 'none');
  assert.equal(w.document.title, '【需要你输入】登录');
  // Arming again (the agent calls again) replaces it: one highlight.
  ask(w, { arm: 't2', marker: m, text: TEXT });
  assert.equal(host(w).length, 1);
  assert.deepEqual(ask(w, { read: 't1' }), { ok: true, armed: false }, 'the replaced token still reads as armed');
  const r = ask(w, { read: 't2' });
  assert.deepEqual(r, { ok: true, armed: true, entered: null, connected: true });
  assert.equal(w.document.title, '【需要你输入】登录', 'the title prefix doubled on a new arm');
  key(w, w.document.querySelector('#pw'));
  assert.equal(host(w).length, 0, 'the highlight stayed after the Return, until the agent looks');
  assert.equal(w.document.title, '登录', 'the tab title was not put back');
  assert.equal(ask(w, { read: 't2' }).entered.how, 'enter');
  ok('arms on a password field: scrolled into view, focused, page dimmed around it, ring + note (closed shadow root, clicks pass through), tab title marked; a new arm replaces the old; gone the moment the user presses Return');
}
{
  // Codex r3 B3: the page keeps the mark but adds to its title ("(1) 【需要你输入】登录"): put back to the page's own title.
  const w = makeDom();
  runRead(w);
  ask(w, { arm: 't', marker: markerOf(w, '#pw'), text: TEXT });
  w.document.title = '(1) ' + w.document.title;
  await new Promise(r => setTimeout(r, 1300));   // the mark is checked about once a second: not added twice
  assert.equal(w.document.title, '(1) 【需要你输入】登录');
  w.document.title = '新消息';                    // the page rewrote it: marked again
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(w.document.title, '【需要你输入】新消息');
  w.document.title = '(1) ' + w.document.title;
  key(w, w.document.querySelector('#pw'));
  assert.equal(w.document.title, '(1) 新消息');
  // The Return is kept for the next document of the tab (sessionStorage, same origin): how and when, no value.
  const w2 = makeDom();
  runRead(w2);
  ask(w2, { arm: 'tok-9', marker: markerOf(w2, '#pw'), text: TEXT });
  w2.document.querySelector('#pw').value = 'carried-secret';
  key(w2, w2.document.querySelector('#pw'));
  w2.__chromeBridgeAsk = null;   // the next document: the isolated world starts empty, the tab's sessionStorage stays
  const c = ask(w2, { read: 'tok-9' });
  assert.equal(c.armed, false);
  assert.equal(c.carried && c.carried.how, 'enter');
  assert.ok(Math.abs(c.carried.at - Date.now()) < 5000);
  assert.doesNotMatch(JSON.stringify(c) + JSON.stringify({ ...w2.sessionStorage }), /carried-secret/);
  assert.deepEqual(ask(w2, { read: 'tok-9' }), { ok: true, armed: false }, 'read twice');
  assert.equal(ask(w2, { read: 'other' }).carried, undefined);
  // Seen in the same document: the agent got it there, nothing left behind; nothing written without a Return.
  const w3 = makeDom();
  runRead(w3);
  ask(w3, { arm: 't3', marker: markerOf(w3, '#pw'), text: TEXT });
  ask(w3, { disarm: 't3' });
  assert.equal(w3.sessionStorage.length, 0, 'written without a Return');
  ask(w3, { arm: 't4', marker: markerOf(w3, '#pw'), text: TEXT });
  key(w3, w3.document.querySelector('#pw'));
  assert.equal(ask(w3, { read: 't4' }).entered.how, 'enter');
  assert.equal(w3.sessionStorage.length, 0, 'left in sessionStorage after the agent read it');
  ok('a title the page added to loses only the mark; the Return is carried to the next document (how and when only, read once), never left behind or written without one');
}
{
  // Live run 2026-10-12: read_page printed "[3] 密码 [4] 输入框: …" and the label's number was passed.
  const w = makeDom(`<form id="f"><label id="lu">用户名<input id="u" name="user"></label>
    <label id="lp">密码<input id="p" name="pw" type="password"></label>
    <label id="lc"><input id="c" type="checkbox">记住我</label><button>登录</button></form>`);
  runRead(w);
  const lp = markerOf(w, '#lp');
  assert.ok(lp >= 1, 'read_page did not number the label');
  const a = ask(w, { arm: 't', marker: lp, text: TEXT });
  assert.deepEqual([a.ok, a.kind, a.password], [true, 'single', true]);
  assert.equal(w.document.activeElement.id, 'p', 'the label\'s field is not focused');
  w.document.querySelector('#p').value = 'x';
  key(w, w.document.querySelector('#p'));
  assert.equal(ask(w, { read: 't' }).entered?.how, 'enter');
  const c = ask(w, { arm: 't2', marker: markerOf(w, '#lc'), text: TEXT });
  assert.deepEqual([c.ok, c.error], [false, 'not_a_field'], 'a checkbox\'s label was taken for a text field');
  ok('a label\'s number means its text field (armed, focused, done on Return there); a checkbox\'s label is still refused');
}
{
  const w = makeDom();
  runRead(w);
  const pw = w.document.querySelector('#pw');
  ask(w, { arm: 't', marker: markerOf(w, '#pw'), text: TEXT });
  pw.value = 'hunter2-secret';
  // A page script's own Return (untrusted), an IME composition's Return, a Return outside the form: not done.
  pw.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  key(w, pw, { isComposing: true });
  key(w, pw, { keyCode: 229 });
  key(w, w.document.querySelector('#outside'));
  key(w, pw, { key: 'a' });
  assert.equal(ask(w, { read: 't' }).entered, null);
  // The user's Return in it: done, the page still gets the key (nothing prevented).
  const notCancelled = key(w, pw);
  assert.equal(notCancelled, true, 'the Return was prevented: the page would not submit');
  const r = ask(w, { read: 't' });
  assert.deepEqual(r, { ok: true, armed: true, entered: { how: 'enter', filled: true }, connected: true });
  assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  assert.equal(host(w).length, 0, 'the highlight stayed after the Return');
  assert.deepEqual(ask(w, { read: 't' }), { ok: true, armed: false }, 'one-shot: still armed after it reported');
  key(w, pw);   // listeners are gone too
  ok('done only on the user\'s Return in it (not a page\'s synthetic key, an IME Return, another field, another key); reports filled, never the value; then disarms');
}
{
  const w = makeDom();
  runRead(w);
  ask(w, { arm: 't', marker: markerOf(w, '#user'), text: TEXT });
  key(w, w.document.querySelector('#pw'));   // Return in the password field of the same form
  assert.deepEqual(ask(w, { read: 't' }).entered, { how: 'enter', filled: false });

  const w2 = makeDom();
  runRead(w2);
  ask(w2, { arm: 't', marker: markerOf(w2, '#pw'), text: TEXT });
  w2.document.querySelector('#pw').value = 'x';
  const f = w2.document.querySelector('#login');
  f.dispatchEvent(new w2.Event('submit', { bubbles: true, cancelable: true }));   // the page's own, untrusted
  assert.equal(ask(w2, { read: 't' }).entered, null, 'a submit the page dispatched itself counted as the user');
  trusted(f, new w2.Event('submit', { bubbles: true, cancelable: true }));        // requestSubmit(): trusted, but no click
  assert.equal(ask(w2, { read: 't' }).entered, null, 'a page\'s requestSubmit() counted as the user');
  trusted(w2.document.querySelector('#pw'), new w2.MouseEvent('click', { bubbles: true, cancelable: true }));   // a click into the field
  trusted(f, new w2.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(ask(w2, { read: 't' }).entered, null, 'a click into the field made a requestSubmit() the user\'s');
  // The page takes the button's click itself (no native submit), then submits by script.
  const go = w2.document.querySelector('#go');
  const own = (e) => e.preventDefault();
  go.addEventListener('click', own);
  trusted(go, new w2.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(ask(w2, { read: 't' }).entered, null, 'a cancelled click submitted');
  f.dispatchEvent(new w2.Event('submit', { bubbles: true, cancelable: true }));   // dispatched: untrusted, right after the click
  assert.equal(ask(w2, { read: 't' }).entered, null, 'an untrusted submit counted because a click came before it');
  trusted(f, new w2.Event('submit', { bubbles: true, cancelable: true }));        // requestSubmit() after the user's click
  assert.deepEqual(ask(w2, { read: 't' }).entered, { how: 'submit', filled: true });
  // The plain case: the user clicks the submit button and the browser submits.
  const w5 = makeDom();
  runRead(w5);
  ask(w5, { arm: 't', marker: markerOf(w5, '#pw'), text: TEXT });
  trusted(w5.document.querySelector('#go'), new w5.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(ask(w5, { read: 't' }).entered, { how: 'submit', filled: false });
  ok('a Return in another field of its form, or its button really clicked then the submit, also counts; a page-dispatched submit or requestSubmit() does not');
}
{
  const w = makeDom();
  runRead(w);
  const note = w.document.querySelector('#note');
  const a = ask(w, { arm: 't', marker: markerOf(w, '#note'), text: TEXT });
  assert.equal(a.kind, 'multi');
  assert.match(noteText(w), /⌘\+回车/);
  key(w, note);
  assert.equal(ask(w, { read: 't' }).entered, null, 'a plain Return in a textarea is a new line');
  key(w, note, { metaKey: true });
  assert.equal(ask(w, { read: 't' }).entered.how, 'enter');
  ok('a multi-line field: a plain Return is a new line; Cmd+Return is done (the note says ⌘+回车)');
}
{
  // The page re-renders the field while the user types (a framework swapping the node): followed, not "gone".
  const w = makeDom();
  runRead(w);
  ask(w, { arm: 't', marker: markerOf(w, '#pw'), text: TEXT });
  const swap = (sel, html) => { const old = w.document.querySelector(sel); old.insertAdjacentHTML('afterend', html); old.remove(); };
  swap('#pw', '<input id="pw" type="password" placeholder="密码">');
  key(w, w.document.querySelector('#pw'));   // Return in the new node before any read
  assert.deepEqual(ask(w, { read: 't' }), { ok: true, armed: true, entered: { how: 'enter', filled: false }, connected: true });
  const w2 = makeDom('<form><input name="otp" type="text"><button>确定</button></form>');
  runRead(w2);
  ask(w2, { arm: 't', marker: markerOf(w2, '[name=otp]'), text: TEXT });
  const o = w2.document.querySelector('[name=otp]');
  o.insertAdjacentHTML('afterend', '<input name="otp" type="text">'); o.remove();
  assert.deepEqual(ask(w2, { read: 't' }), { ok: true, armed: true, entered: null, connected: true }, 'a re-rendered field read as gone');
  key(w2, w2.document.querySelector('[name=otp]'));
  assert.equal(ask(w2, { read: 't' }).entered.how, 'enter');
  // No id, no name: the same placeholder in its form, one match only.
  const w3 = makeDom('<form id="f3"><input placeholder="短信验证码"><input placeholder="手机号"></form>');
  runRead(w3);
  ask(w3, { arm: 't', marker: markerOf(w3, '[placeholder=短信验证码]'), text: TEXT });
  const c3 = w3.document.querySelector('[placeholder=短信验证码]');
  c3.insertAdjacentHTML('afterend', '<input placeholder="短信验证码">'); c3.remove();
  assert.deepEqual(ask(w3, { read: 't' }), { ok: true, armed: true, entered: null, connected: true }, 'placeholder-only field read as gone');
  ok('a field the page re-renders (same id; same name and type; or same placeholder in its form) is followed: still waiting, and a Return in the new node counts');
}
{
  // What the user typed for the agent is never printed: read_page labels and after.js's focus description, also once the
  // wait is over and after the page re-rendered the field. A field nobody was asked about keeps today's label.
  const w = makeDom('<form><input name="otp"><button>确定</button></form>');
  runRead(w);
  ask(w, { arm: 't', marker: markerOf(w, '[name=otp]'), text: TEXT });
  const otp = w.document.querySelector('[name=otp]');
  otp.value = '123456';
  key(w, otp);
  assert.equal(ask(w, { read: 't' }).entered.how, 'enter');
  for (const req of [{}, { full: true }, { query: '确定' }]) assert.doesNotMatch(JSON.stringify(runRead(w, req)), /123456/, JSON.stringify(req));
  otp.insertAdjacentHTML('afterend', '<input name="otp">'); otp.remove();
  const again = w.document.querySelector('[name=otp]');
  again.value = '123456';
  assert.doesNotMatch(JSON.stringify(runRead(w, { full: true })), /123456/, 'the re-rendered copy printed its value');
  again.focus();
  const aft = JSON.parse(w.eval(afterSrc.replaceAll('__MARKER__', 'null').replaceAll('__EXPECT__', 'null').replaceAll('__BIND__', 'null')));
  assert.equal(aft.activeElement.tag, 'input');
  assert.doesNotMatch(JSON.stringify(aft), /123456/);
  // No id, name, placeholder or label: once re-rendered after the wait nothing ties the copy to it; its form's fields stay masked.
  const w4 = makeDom('<form id="f4"><input type="text"><button>下一步</button></form>');
  runRead(w4);
  ask(w4, { arm: 't', marker: markerOf(w4, '#f4 input'), text: TEXT });
  const an = w4.document.querySelector('#f4 input');
  an.value = '654321';
  key(w4, an);
  assert.equal(ask(w4, { read: 't' }).entered.how, 'enter');
  an.insertAdjacentHTML('afterend', '<input type="text">'); an.remove();
  w4.document.querySelector('#f4 input').value = '654321';
  assert.doesNotMatch(JSON.stringify(runRead(w4, { full: true })), /654321/, 'an anonymous re-rendered copy printed its value');
  const w2 = makeDom('<form><input name="otp"><button>确定</button></form>');
  w2.document.querySelector('[name=otp]').value = '123456';
  assert.match(JSON.stringify(runRead(w2, { full: true })), /123456/, 'control: an untouched field no longer shows its value — the check above proves nothing');
  ok('the value the user typed never reaches read_page or after.js (also after the wait and for a re-rendered copy); other fields unchanged');
}
{
  // The field sits in a same-origin frame that then loads another document: reported, not waited on forever.
  const w = makeDom('<iframe id="fr"></iframe>');
  const fr = w.document.querySelector('#fr');
  fr.contentDocument.body.innerHTML = '<form><input name="code"></form>';
  const input = fr.contentDocument.querySelector('input');
  w.__chromeBridge = { markers: [null, input], url: w.location.href, stamp: Date.now() };
  assert.equal(ask(w, { arm: 't', marker: 1, text: TEXT }).armed, true);
  assert.deepEqual(ask(w, { read: 't' }), { ok: true, armed: true, entered: null, connected: true });
  key(w, input, {});   // a Return in the frame's field is heard (listener in the frame's window)
  assert.equal(ask(w, { read: 't' }).entered.how, 'enter');
  ask(w, { arm: 't2', marker: 1, text: TEXT });
  fr.remove();
  assert.deepEqual(ask(w, { read: 't2' }), { ok: true, armed: true, entered: null, connected: false, reloaded: true });
  assert.equal(host(w).length, 0);
  ok('a field in a same-origin frame: its Return is heard; the frame going away or loading another page is reported (reloaded), not waited on');
}
{
  const w = makeDom();
  runRead(w);
  ask(w, { arm: 't', marker: markerOf(w, '#pw'), text: TEXT });
  w.document.querySelector('#login').remove();
  assert.deepEqual(ask(w, { read: 't' }), { ok: true, armed: true, entered: null, connected: false });
  assert.equal(host(w).length, 0);
  const w2 = makeDom();
  runRead(w2);
  ask(w2, { arm: 't', marker: markerOf(w2, '#pw'), text: TEXT });
  assert.deepEqual(ask(w2, { disarm: 'other' }), { ok: true, armed: false }, 'another token disarmed it');
  assert.equal(host(w2).length, 1);
  assert.deepEqual(ask(w2, { disarm: 't' }), { ok: true, armed: false, disarmed: true });
  assert.equal(host(w2).length, 0);
  ok('the field leaving the page is reported (connected:false) and disarms; disarm removes the highlight, only with its own token');
}

/* ------------------------------------------------------------- the wiring */

console.log('wait_for_user with field (src/index.js, fake bridge running ask.js in jsdom)');
const idx = await import('../src/index.js');
const T = await import('../src/tabs.js');
let page, log, notes, clickAt = 0, idleUnknown = false, onIdle = null;
function fakeBridge() {
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, async () => { throw new Error(`B.${k} reached in ask.test`); }]));
  const target = () => ({ tabId: 10, windowId: 7, url: page.location.href, title: page.document.title });
  return Object.assign(fake, {
    pageScript: async (name, vars = {}) => ({ name, vars }),
    evalInPage: async (s, tab) => {
      log.push(`eval ${s.name} ${tab} ${JSON.stringify(s.vars.ASK || {}).slice(0, 40)}`);
      if (page.gone) { const { BridgeError } = await import('../src/bridge.js'); throw new BridgeError('no_such_tab', '找不到标签'); }
      if (s.name === 'block') return { ...JSON.parse(page.eval(blockSrc)), target: target() };
      if (s.name !== 'ask') throw new Error(`unexpected page script ${s.name}`);
      const r = askRaw(page, s.vars.ASK);   // as the server gets it (entered.at included)
      if (!r.ok) { const { BridgeError } = await import('../src/bridge.js'); throw new BridgeError(r.error, r.message); }
      return { ...r, target: target() };
    },
    selectTab: async (id) => { log.push(`select ${id}`); return { ok: true }; },
    activateChrome: async (id) => { log.push(`activate ${id}`); return { ok: true, targetOnTop: true }; },
    chromeInfo: async () => (page.gone ? Promise.reject(new Error('gone')) : { url: page.location.href }),
    openNavigationObserver: async () => ({
      startedAt: Date.now(),
      untouched: async (_target, since) => { if (onIdle) onIdle(); return !idleUnknown && clickAt < since; },
      close: async () => {},
    }),
    // The user's last mouse button down (clickAt, epoch ms; 0 = long ago), as the helper says it: seconds ago.
    cgevent: async (args) => {
      if (args[0] !== 'idle') throw new Error(`B.cgevent ${args[0]} reached in ask.test`);
      if (onIdle) onIdle();
      return idleUnknown ? { ok: true, idle: 100 } : { ok: true, idle: 100, clickIdle: (Date.now() - clickAt) / 1000 };
    },
    listTabs: async () => ({ ok: true, frontmost: 'WeChat', chromePid: 42, windows: [{ id: 7, index: 1, minimized: false, mode: 'normal',
      tabs: [{ id: 10, url: page.location.href, title: page.document.title, active: true }] }] })
  });
}
async function world() {
  page = makeDom();
  runRead(page);
  log = []; notes = []; clickAt = 0; idleUnknown = false; onIdle = null;
  idx.__setBridgeForTests(fakeBridge());
  idx.__notifyForTests({ send: (t) => notes.push(t), everyMs: 60_000 });
  idx.__setWaitPollForTests(20, 15, 400);
  await T.registerTab(10, page.location.href, { windowId: 7, agentName: 'ask-test' });
}
const call = async (name, args = {}) => {
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError };
};
function assertContinuationRequired(text) {
  assert.match(text, /观察已结束/);
  assert.match(text, /不代表收到继续授权/);
  assert.match(text, /若用户尚未在本次交接后于原对话明确说“继续”，先等待/);
  assert.match(text, /收到后先 read_page 核对同一页面，再恢复原任务/);
  assert.match(text, /此前的任务授权不能替代本次继续指令/);
  assert.doesNotMatch(text, /自动接着做|自己接着做|不用回去|再接着做|用户应该已经提交|用户可能已经提交/);
}
const taskFile = path.join(tmp, 'lock', 'tasks', `${process.pid}.json`);
const readTask = async () => JSON.parse(await readFile(taskFile, 'utf8').catch(() => 'null'));
const later = (ms, f) => setTimeout(f, ms);

{
  await world();
  const m = markerOf(page, '#pw');
  let menu = null;
  later(60, async () => {
    menu = await readTask();
    assert.equal(host(page).length, 1, 'no highlight while waiting');
    assert.match(noteText(page), /输入完成后按回车，再回到原 AI 对话说“继续”/);
    page.document.querySelector('#pw').value = 'my-secret-pass';
    key(page, page.document.querySelector('#pw'));
  });
  const r = await call('wait_for_user', { tab: 10, field: m, reason: '登录密码', minutes: 0.05 });
  assert.equal(r.isError, false, r.text);
  assertContinuationRequired(r.text);
  assert.match(r.text, new RegExp(`^✅ 用户在 \\[${m}\\] 输入完按了回车，等了 \\d+ 秒。`));
  assert.doesNotMatch(r.text, /my-secret-pass/);
  assert.ok(log.includes('select 10'), log.join('\n'));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /完成后按回车，再回到原 AI 对话说“继续”/);
  assert.doesNotMatch(notes[0], /观察|自动|自己接着做/);
  assert.equal(menu && menu.alert, '需要你处理：shop.test 在高亮的框里输入：登录密码');
  assert.equal(menu && menu.alertTab, 10, 'the menu bar does not know which tab waits (「带我去」)');
  assert.ok(!log.some(l => l.startsWith('activate')), 'the wait brought Chrome forward by itself');
  assert.equal(host(page).length, 0, 'the highlight stayed');
  assert.equal(await readTask(), null, 'the menu-bar alert stayed after the user was done');
  ok('Return ends observation without a chat reply: result, page hint and notification require explicit continue before reading and resuming; no private value returned');
}
{
  await world();
  process.env.CHROME_BRIDGE_LANG = 'en';
  try {
    let hint;
    later(60, () => {
      hint = noteText(page);
      const button = page.document.querySelector('#go');
      button.addEventListener('click', event => event.preventDefault());
      trusted(button, new page.MouseEvent('click', { bubbles: true, cancelable: true }));
      trusted(page.document.querySelector('#login'), new page.Event('submit', { bubbles: true, cancelable: true }));
    });
    const result = await call('wait_for_user', { tab: 10, field: markerOf(page, '#pw'), reason: 'login password', minutes: 0.05 });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /提交了表单/);
    assertContinuationRequired(result.text);
    assert.match(hint, /Press Return when done, then say "continue" in your original AI conversation/);
    assert.match(notes[0], /Press Return when done, then say "continue" in your original AI conversation/);
    assert.doesNotMatch(hint + notes[0], /observation|carries on|automatically/);
    assert.equal(host(page).length, 0);
    assert.equal(await readTask(), null);
  } finally { process.env.CHROME_BRIDGE_LANG = 'zh'; }
  ok('trusted form submit ends the real field wait; English page hint and notification ask for continue in the original AI conversation');
}
{
  // Run the production detector and wait loop against a real jsdom page; no chat signal is supplied.
  for (const language of ['zh', 'en']) {
    await world();
    process.env.CHROME_BRIDGE_LANG = language;
    try {
      const challenge = page.document.createElement('iframe');
      challenge.src = 'https://www.google.com/recaptcha/api2/anchor?size=normal';
      challenge.getBoundingClientRect = () => ({ x: 10, y: 100, width: 304, height: 78, left: 10, top: 100, right: 314, bottom: 178 });
      page.document.body.appendChild(challenge);
      assert.equal(JSON.parse(page.eval(blockSrc)).blocked?.kind, 'captcha');
      later(60, () => challenge.remove());
      const result = await call('wait_for_user', { tab: 10, minutes: 0.05 });
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, /^✅ 验证\/拦截已经没有了/);
      assertContinuationRequired(result.text);
      assert.equal(notes.length, 1);
      assert.match(notes[0], language === 'en'
        ? /Handle this yourself, then say "continue" in your original AI conversation/
        : /请自行处理，完成后回到原 AI 对话说“继续”/);
      assert.doesNotMatch(notes[0], /观察|observation|carries on|自动接着做|处理完它会接着做/);
      assert.equal(idx.__blocksForTests().size, 0);
      assert.equal(await readTask(), null);
      assert.ok(log.every(entry => entry.startsWith('eval block ')), 'challenge observation sent an action');
    } finally { process.env.CHROME_BRIDGE_LANG = 'zh'; }
  }
  ok('a challenge disappearing ends observation without a chat gate; both notification languages and results require explicit continuation');
}
{
  for (const language of ['zh', 'en']) {
    await world();
    process.env.CHROME_BRIDGE_LANG = language;
    try {
      later(60, () => page.history.replaceState({}, '', '/signed-in'));
      const result = await call('wait_for_user', { tab: 10, reason: 'Finish signing in', minutes: 0.05 });
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, /^✅ 页面已经变了/);
      assertContinuationRequired(result.text);
      assert.match(notes[0], language === 'en'
        ? /Handle this yourself, then say "continue" in your original AI conversation/
        : /请自行处理，完成后回到原 AI 对话说“继续”/);
      assert.doesNotMatch(notes[0], /观察|observation|carries on|自动接着做/);
      assert.equal(await readTask(), null);
      assert.ok(log.every(entry => entry.startsWith('eval block ')), 'plain observation sent an action');
    } finally { process.env.CHROME_BRIDGE_LANG = 'zh'; }
  }
  ok('reason-only navigation returns an observation result, with natural bilingual notifications and no inferred continuation authorization');
}
{
  // The Return submits the form: the page navigates before the next look; then it reloads in place.
  await world();
  later(40, () => { page = makeDom('<p>欢迎</p>', 'https://shop.test/home'); });
  const r = await call('wait_for_user', { tab: 10, field: markerOf(page, '#pw'), reason: '登录密码', minutes: 0.05 });
  assert.match(r.text, /^✅ 页面已经跳转（shop\.test），尚未确认提交结果，等了 \d+ 秒。/);
  assertContinuationRequired(r.text);
  await world();
  later(40, () => { page = makeDom(); });
  const r2 = await call('wait_for_user', { tab: 10, field: markerOf(page, '#pw'), reason: '登录密码', minutes: 0.05 });
  assert.match(r2.text, /^✅ 页面重新加载了，尚未确认提交结果/);
  assertContinuationRequired(r2.text);
  await world();
  later(40, () => { page.document.querySelector('#login').remove(); });
  const r3 = await call('wait_for_user', { tab: 10, field: markerOf(page, '#pw'), reason: '登录密码', minutes: 0.05 });
  assert.match(r3.text, /^⚠️ \[\d+\] 这个框不在页面上了，用户没有在里面按回车（等了 \d+ 秒）。/);
  assertContinuationRequired(r3.text);
  await world();
  later(40, () => { page.gone = true; });
  const r4 = await call('wait_for_user', { tab: 10, field: markerOf(page, '#pw'), reason: '登录密码', minutes: 0.05 });
  assert.match(r4.text, /^❌ 这个标签已经不在了/);
  assertContinuationRequired(r4.text);
  // The field in a same-origin frame that goes away / loads another page: like a reload, not "the field is gone".
  await world();
  page = makeDom('<iframe id="fr"></iframe>');
  const fr = page.document.querySelector('#fr');
  fr.contentDocument.body.innerHTML = '<form><input name="code"></form>';
  page.__chromeBridge = { markers: [null, fr.contentDocument.querySelector('input')], url: page.location.href, stamp: Date.now() };
  later(40, () => fr.remove());
  const r5 = await call('wait_for_user', { tab: 10, field: 1, reason: '验证码', minutes: 0.05 });
  assert.match(r5.text, /^✅ 页面重新加载了，尚未确认提交结果/);
  assertContinuationRequired(r5.text);
  ok('navigation, reload, missing field and missing frame only end observation; no submission or continuation authorization inferred');
}
{
  // Live run 2026-10-12: the page navigated 1.5 s after the Return (a login redirect); the agent then took
  // its own tab for the user's and would not close it. The navigation is followed and the URL is the agent's.
  await world();
  const m = markerOf(page, '#pw');
  later(40, () => {
    page.document.querySelector('#pw').value = 'test-only';
    key(page, page.document.querySelector('#pw'));
    later(120, () => { page = makeDom('<h1>已提交</h1>', 'https://shop.test/home'); });
  });
  const r = await call('wait_for_user', { tab: 10, field: m, reason: '登录密码', minutes: 0.05 });
  assert.match(r.text, new RegExp(`^✅ 用户在 \\[${m}\\] 输入完按了回车，等了 \\d+ 秒，页面已经变了（shop\\.test）。`), r.text);
  assertContinuationRequired(r.text);
  const rec = await T.getTab(10);
  assert.deepEqual([rec.expectedUrl, !!rec.takenOver], ['https://shop.test/home', false], 'the redirect after the Return counts as a takeover');
  const chk = T.checkTakeover(rec, { id: 10, url: 'https://shop.test/home', windowId: 7 });
  assert.equal(chk.changed, false);
  // No navigation after the Return (a form that stays): the URL stays, nothing marked.
  await world();
  later(40, () => key(page, page.document.querySelector('#pw')));
  const r2 = await call('wait_for_user', { tab: 10, field: markerOf(page, '#pw'), reason: '登录密码', minutes: 0.05 });
  assert.doesNotMatch(r2.text, /页面已经变了/);
  assert.equal((await T.getTab(10)).expectedUrl, 'https://shop.test/login');
  // The Return, then the page moves on before the agent looks (a form POST): carried over, the URL is the agent's.
  await world();
  later(40, () => {
    key(page, page.document.querySelector('#pw'));
    const kept = { ...page.sessionStorage };
    page = makeDom('<p>欢迎</p>', 'https://shop.test/home');
    for (const [k, v] of Object.entries(kept)) page.sessionStorage.setItem(k, v);   // same tab, same origin
  });
  const r3 = await call('wait_for_user', { tab: 10, field: m, reason: '登录密码', minutes: 0.05 });
  assert.match(r3.text, new RegExp(`^✅ 用户在 \\[${m}\\] 输入完按了回车（?.*页面已经跳转（shop\\.test）`), r3.text);
  assertContinuationRequired(r3.text);
  assert.equal((await T.getTab(10)).expectedUrl, 'https://shop.test/home');
  // Codex r3 B1: the page moved on with no Return seen (the user went elsewhere themselves): not the agent's.
  await world();
  later(40, () => { page = makeDom('<p>别处</p>', 'https://shop.test/elsewhere'); });
  const r4 = await call('wait_for_user', { tab: 10, field: m, reason: '登录密码', minutes: 0.05 });
  assert.match(r4.text, /页面已经跳转（shop\.test），尚未确认提交结果/);
  assertContinuationRequired(r4.text);
  assert.equal((await T.getTab(10)).expectedUrl, 'https://shop.test/login');
  // The Return, then a click of theirs while the page moves: they went somewhere else, not the agent's.
  await world();
  later(40, () => {
    key(page, page.document.querySelector('#pw'));
    later(60, () => { clickAt = Date.now(); page = makeDom('<p>别处</p>', 'https://shop.test/elsewhere'); });
  });
  await call('wait_for_user', { tab: 10, field: m, reason: '登录密码', minutes: 0.05 });
  assert.equal((await T.getTab(10)).expectedUrl, 'https://shop.test/login', 'a click after the Return still made the URL the agent\'s');
  // Codex r4 B1: the click lands between the Return and the agent's look (the poll): still theirs.
  await world();
  idx.__setWaitPollForTests(20, 60, 400);
  later(40, () => {
    key(page, page.document.querySelector('#pw'));
    clickAt = Date.now() + 5;
    later(150, () => { page = makeDom('<p>别处</p>', 'https://shop.test/elsewhere'); });
  });
  await call('wait_for_user', { tab: 10, field: m, reason: '登录密码', minutes: 0.05 });
  assert.equal((await T.getTab(10)).expectedUrl, 'https://shop.test/login', 'a click before the agent looked was missed');
  idx.__setWaitPollForTests(20, 15, 400);
  // Codex r4 B4: the helper does not say when the last click was: as if they clicked.
  await world();
  idleUnknown = true;
  later(40, () => {
    key(page, page.document.querySelector('#pw'));
    later(120, () => { page = makeDom('<h1>已提交</h1>', 'https://shop.test/home'); });
  });
  await call('wait_for_user', { tab: 10, field: m, reason: '登录密码', minutes: 0.05 });
  assert.equal((await T.getTab(10)).expectedUrl, 'https://shop.test/login', 'an unknown last click counted as none');
  // Codex r3 B2: the wait cancelled while it follows the page: nothing recorded.
  await world();
  const ac = new AbortController();
  later(40, () => {
    key(page, page.document.querySelector('#pw'));
    later(30, () => ac.abort());
    later(120, () => { page = makeDom('<h1>已提交</h1>', 'https://shop.test/home'); });
  });
  await idx.callTool({ params: { name: 'wait_for_user', arguments: { tab: 10, field: m, reason: '登录密码', minutes: 0.05 } } }, { signal: ac.signal });
  assert.equal((await T.getTab(10)).expectedUrl, 'https://shop.test/login', 'recorded after the wait was cancelled');
  await new Promise(r => setTimeout(r, 200));   // let its page change land here, not in the next test
  // Codex r4 B2: cancelled while the helper is asked about clicks: nothing recorded either.
  await world();
  const ac2 = new AbortController();
  onIdle = () => ac2.abort();
  later(40, () => {
    key(page, page.document.querySelector('#pw'));
    later(120, () => { page = makeDom('<h1>已提交</h1>', 'https://shop.test/home'); });
  });
  await idx.callTool({ params: { name: 'wait_for_user', arguments: { tab: 10, field: m, reason: '登录密码', minutes: 0.05 } } }, { signal: ac2.signal });
  assert.equal((await T.getTab(10)).expectedUrl, 'https://shop.test/login', 'recorded after a cancel during the click check');
  onIdle = null;
  // Codex r4 B3: the page rewrote the carried time into the future (to hide a later click): not taken.
  await world();
  later(40, () => {
    key(page, page.document.querySelector('#pw'));
    const kept = Object.fromEntries(Object.entries({ ...page.sessionStorage }).map(([k, v]) => [k, JSON.stringify({ ...JSON.parse(v), at: Date.now() + 60_000 })]));
    page = makeDom('<p>欢迎</p>', 'https://shop.test/home');
    for (const [k, v] of Object.entries(kept)) page.sessionStorage.setItem(k, v);
  });
  await call('wait_for_user', { tab: 10, field: m, reason: '登录密码', minutes: 0.05 });
  assert.equal((await T.getTab(10)).expectedUrl, 'https://shop.test/login', 'a future carried time was taken');
  ok('the page navigates a moment after the Return (login redirect), or moves on before the agent looks with the Return carried over: its URL is the agent\'s; no Return seen, a click after it (even before the agent looked), an unknown last click, a made-up time, or the wait cancelled: not; no navigation: nothing changes');
}
{
  // Nobody comes: the highlight and the alert are removed; calling again highlights it again.
  await world();
  const m = markerOf(page, '#pw');
  const r = await call('wait_for_user', { tab: 10, field: m, reason: '短信验证码', minutes: 0.003 });
  assert.match(r.text, new RegExp(`^⏳ 等了 [\\d.]+ 分钟，用户还没在 \\[${m}\\] 输入完（短信验证码）。高亮已撤掉`));
  // Observing again does not authorize resuming input or asking for a secret in chat.
  assertContinuationRequired(r.text);
  assert.match(r.text, /若用户仍希望等待，可再调用 wait_for_user 观察；不要在对话里索要这项私密内容/);
  assert.equal(host(page).length, 0, 'a highlight left on the page after the wait gave up');
  assert.equal(await readTask(), null);
  later(40, () => key(page, page.document.querySelector('#pw')));
  const again = await call('wait_for_user', { tab: 10, field: m, reason: '短信验证码', minutes: 0.05 });
  assert.match(again.text, /（框是空的）/);
  // Without field (a reason only), the alert goes with the wait too: run out, or cancelled (2026-10-19: one stayed a day).
  const plain = await call('wait_for_user', { tab: 10, reason: '在这个页面登录', minutes: 0.003 });
  assert.match(plain.text, /^⏳ 等了 [\d.]+ 分钟，用户还没处理（在这个页面登录）/);
  assert.equal(await readTask(), null, 'the menu-bar alert stayed after a wait without field ran out');
  const ac = new AbortController();
  const shown = async () => { for (let t = Date.now(); Date.now() - t < 3000; await new Promise(r => setTimeout(r, 10))) { const j = await readTask(); if (j && j.alert) return j; } return null; };
  const cancelled = idx.callTool({ params: { name: 'wait_for_user', arguments: { tab: 10, reason: '在这个页面登录', minutes: 0.05 } } }, { signal: ac.signal });
  const during = await shown();
  ac.abort();
  await cancelled;
  assert.equal(during && during.alert, '需要你处理：shop.test 在这个页面登录');
  assert.equal(await readTask(), null, 'the menu-bar alert stayed after a wait without field was cancelled');
  // One put there meanwhile (the page itself now asks for a person) is not this wait's to take down.
  const captcha = { kind: 'captcha', vendor: '', evidence: 'recaptcha', site: 'shop.test', since: Date.now(), toldAt: Date.now() };
  const replaced = call('wait_for_user', { tab: 10, reason: '在这个页面登录', minutes: 0.003 });
  assert.ok(await shown(), 'the wait\'s own alert never showed');
  idx.__blocksForTests().set(10, captcha);
  await replaced;
  assert.equal(idx.__blocksForTests().get(10), captcha, 'a block put there during the wait was taken down with it');
  idx.__blocksForTests().delete(10);
  await call('wait_for_user', { tab: 10, reason: '在这个页面登录', minutes: 0.003 });   // the menu bar written clear again
  assert.equal(await readTask(), null);
  ok('nobody comes: the highlight and the menu-bar alert go (also without field: run out or cancelled); the next call highlights again; an empty field is said so');
}
{
  await world();
  const noReason = await call('wait_for_user', { tab: 10, field: markerOf(page, '#pw') });
  assert.equal(noReason.isError, true);
  assert.match(noReason.text, /带 field 时要写 reason/);
  const btn = await call('wait_for_user', { tab: 10, field: markerOf(page, '#go'), reason: '点登录' });
  assert.equal(btn.isError, true);
  assert.match(btn.text, /不是可输入的文本框/);
  assert.equal(host(page).length, 0);
  assert.equal(notes.length, 0, 'the user was told about a wait that never started');
  ok('field without reason, or pointing at a button: an error to the agent, nothing shown, nobody notified');
}
{
  // Two waits can overlap on one tab. Finishing the older one must not remove the newer card.
  await world();
  const shown = async (accept) => {
    for (const started = Date.now(); Date.now() - started < 3000; await new Promise(r => setTimeout(r, 10))) {
      const task = await readTask();
      if (task && accept(task)) return task;
    }
    throw new Error('the expected alert instance did not appear');
  };
  const marker = markerOf(page, '#pw'), ac = new AbortController();
  const older = idx.callTool({ params: { name: 'wait_for_user', arguments: { tab: 10, field: marker, reason: '第一个等待', minutes: 0.05 } } }, { signal: ac.signal });
  const oldTask = await shown(t => !!t.alertToken);
  const newer = call('wait_for_user', { tab: 10, field: marker, reason: '新的等待', minutes: 0.05 });
  const newTask = await shown(t => t.alertToken !== oldTask.alertToken);
  assert.equal(newTask.sessionGeneration, oldTask.sessionGeneration);
  ac.abort();
  await older;
  assert.equal((await readTask())?.alertToken, newTask.alertToken, 'older field cleanup erased a newer wait');
  key(page, page.document.querySelector('#pw'));
  await newer;
  assert.equal(await readTask(), null);
  // The successful Return path also clears only its own instance.
  await world();
  const finishing = call('wait_for_user', { tab: 10, field: markerOf(page, '#pw'), reason: '正在输入', minutes: 0.05 });
  await shown(t => !!t.alertToken);
  const replacement = { kind: 'user', evidence: '新的确认', site: 'shop.test', url: page.location.href, since: Date.now(), toldAt: Date.now() };
  idx.__blocksForTests().set(10, replacement);
  idx.__gotoForTests().writeTask();
  const replacementToken = (await readTask()).alertToken;
  key(page, page.document.querySelector('#pw'));
  await finishing;
  assert.equal((await readTask())?.alertToken, replacementToken, 'successful older wait erased a newer alert');
  idx.__blocksForTests().delete(10);
  idx.__gotoForTests().writeTask();
  // A renewed wait on the same persistent CAPTCHA is a new user-attention instance.
  await world();
  const fake = fakeBridge(), normalEval = fake.evalInPage;
  fake.evalInPage = async (script, tab) => script.name === 'block'
    ? { blocked: { kind: 'captcha', vendor: '', evidence: 'test check' }, target: { tabId: 10, url: page.location.href } }
    : normalEval(script, tab);
  idx.__setBridgeForTests(fake);
  await call('wait_for_user', { tab: 10, minutes: 0.01 });
  const firstCheck = (await readTask()).alertToken;
  await call('wait_for_user', { tab: 10, minutes: 0.01 });
  assert.notEqual((await readTask()).alertToken, firstCheck, 'renewed CAPTCHA wait reused the previous attention token');
  idx.__blocksForTests().delete(10);
  idx.__gotoForTests().writeTask();
  ok('waiting instance identity survives old field completion/cancellation; new field and persistent CAPTCHA waits get fresh tokens');
}
{
  // 「带我去」 (the menu bar, under 需要你处理): the panel writes goto-<pid>.json, this session brings the waiting tab forward.
  await world();
  const G = idx.__gotoForTests();
  const L = await import('../src/lock.js');
  const { execFile, spawn } = await import('node:child_process');
  const until = async (f, ms = 5000, what = 'a condition') => {
    const t = Date.now();
    while (!(await f())) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 10)); }
  };
  const watcher = G.watch();
  assert.ok(watcher, 'no watcher on the cache folder');
  const m = markerOf(page, '#pw');
  let wrote = null, shownBeforeReturn = null;
  // Once the menu bar shows the alert with its tab: the button (the real cbmenu); the Return after the tab came forward.
  const user = (async () => {
    await until(async () => (await readTask())?.alertTab === 10, 5000, 'the alert with its tab');
    const task = await readTask();
    assert.match(task.sessionGeneration, /^[0-9a-f-]{36}$/, 'the GUI cannot distinguish a reused worker PID');
    assert.match(task.alertToken, /^[0-9a-f-]{36}$/, 'the GUI cannot distinguish a replaced wait on the same tab');
    // A cbmenu built before --goto starts a whole panel instead and never exits (2026-10-18: npm test hung 30 h).
    wrote = await new Promise(res => execFile(process.env.CBMENU_BIN || path.join(ROOT, 'bin', 'cbmenu'), ['--goto', String(process.pid), '10'], { env: process.env, timeout: 5000 },
      (err, out) => { try { res(err ? { error: String(err) } : JSON.parse(out)); } catch { res({ error: `not JSON: ${JSON.stringify(out)}` }); } }));
    await until(() => log.includes('activate 10'), 3000, 'the tab brought forward').catch(() => {});
    shownBeforeReturn = log.includes('activate 10');
    key(page, page.document.querySelector('#pw'));
  })();
  const r = await call('wait_for_user', { tab: 10, field: m, reason: '登录密码', minutes: 0.2 });
  await user;
  assert.equal(wrote.ok, true, 'cbmenu --goto failed (use CBMENU_BIN for a matching candidate)');
  assert.equal(wrote.file, G.file, 'cbmenu --goto wrote somewhere else');
  assert.match(r.text, /^✅ 用户在 \[\d+\] 输入完按了回车/, r.text);
  assert.equal(shownBeforeReturn, true, 'the tab was not brought forward while the wait was on');
  assert.equal(log.filter(l => l === 'activate 10').length, 1, log.join('\n'));
  watcher.close();
  // What does nothing: no request, a tab nobody waits on, the wait over, a stale request, a pause; a failed activation is said so.
  const B = idx.__blocksForTests();
  const waiting = () => B.set(10, { kind: 'user', vendor: '', evidence: 'x', site: 'shop.test', url: page.location.href, since: Date.now(), toldAt: Date.now() });
  const request = (o = {}) => ({ id: randomUUID(), tab: 10, at: Date.now(), ...G.identity(10), ...o });
  const req = async (o = {}) => {
    const value = request(o), temporary = `${G.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, G.file);
    return G.run();
  };
  const result = async () => JSON.parse(await readFile(G.resultFile, 'utf8'));
  const reason = async () => (await result()).reason;
  const { writeSettings } = await import('../src/settings.js');
  log = [];
  assert.equal(await G.run(), 'none');
  assert.equal(await req({ tab: 10, at: Date.now() }), 'ignored', 'the wait was over and the tab still came forward');
  waiting();
  assert.equal(await req({ alertToken: null }), 'ignored');
  assert.equal(await reason(), 'invalid_request', 'a legacy request without a token was accepted');
  assert.equal(await req({ sessionGeneration: randomUUID() }), 'ignored');
  assert.equal(await reason(), 'session_changed', 'a reused worker PID was accepted');
  const previous = request();
  waiting();
  assert.equal(await req(previous), 'ignored');
  assert.equal(await reason(), 'alert_changed', 'a replaced wait on the same tab was accepted');
  assert.equal(await req({ tab: 11, at: Date.now() }), 'ignored', 'a tab nobody waits on came forward');
  assert.equal(await req({ tab: 10, at: Date.now() - 60_000 }), 'ignored', 'a request left from a minute ago came forward');
  writeSettings({ paused: true });
  assert.equal(await req({ tab: 10, at: Date.now() }), 'ignored', 'paused, and the tab still came forward');
  writeSettings({ paused: false });
  assert.deepEqual(log, [], log.join('\n'));
  assert.equal(await req({ tab: '10', at: String(Date.now()) }), 'ignored', 'malformed number types were accepted');
  assert.equal(await req(), 'shown');
  assert.equal(await reason(), 'shown');
  assert.deepEqual(log, ['activate 10']);
  // Exact request re-delivery is idempotent; reusing an id for a different target is refused.
  log = [];
  const duplicate = request();
  assert.equal(await req(duplicate), 'shown');
  assert.equal(await req(duplicate), 'shown');
  assert.equal(await req({ ...duplicate, tab: 11 }), 'ignored');
  assert.equal(await reason(), 'request_conflict');
  assert.deepEqual(log, ['activate 10']);
  // Queued behind another agent (it holds the input lock until told to let go; the request is seen in the queue):
  // The wait ends or MyChrome is paused while queued → nothing. Admission freshness and queue time
  // are separate: a still-current request does not expire just because another AI had the mouse.
  const holdLock = async () => {
    const p = spawn(process.execPath, ['--input-type=module', '-e',
      `const L = await import(${JSON.stringify(path.join(ROOT, 'src/lock.js'))}); const l = await L.acquireLease('other agent');
       console.log('held'); process.stdin.once('data', async () => { await l.release(); process.exit(0); });`],
      { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
    await new Promise((res, rej) => { p.stdout.on('data', d => /held/.test(String(d)) && res()); p.on('exit', () => rej(new Error('the lock holder quit'))); });
    return () => new Promise(res => { p.on('exit', res); p.stdin.write('go\n'); });
  };
  // `make()` builds the request once the other agent holds the lock (its time must not run out before it queues: Codex r14 r2 B1).
  const whileQueued = async (make, change) => {
    const release = await holdLock();
    const p = req(make());
    await until(async () => (await L.queueList()).some(t => t.pid === process.pid && t.label === 'goto'), 5000, 'the request in the queue');
    assert.equal((await result()).status, 'queued', 'the GUI was not told this request was waiting for the mouse');
    await change();
    await release();
    return p;
  };
  log = [];
  assert.equal(await whileQueued(() => ({ tab: 10, at: Date.now() }), () => B.delete(10)), 'ignored', 'the tab came forward after the wait ended while it queued');
  waiting();
  assert.equal(await whileQueued(() => ({ tab: 10, at: Date.now() }), () => writeSettings({ paused: true })), 'ignored', 'the tab came forward after a pause while it queued');
  writeSettings({ paused: false });
  let at = 0;
  assert.deepEqual(log, [], log.join('\n'));
  assert.equal(await whileQueued(() => ({ tab: 10, at: (at = Date.now() - 9_000) }), () => until(() => Date.now() > at + 10_100, 3000)), 'shown', 'a valid request expired only because it spent time in the queue');
  log = [];
  assert.equal(await whileQueued(() => ({ tab: 10, at: Date.now() }), () => {}), 'shown', 'queued, then the lock came: not shown');
  assert.deepEqual(log, ['activate 10']);
  // This session's own job holds the lock (the lock lets it in at once, mid-action): not then (Codex r14 A2).
  log = [];
  const own = await L.acquireLease('own job');
  try { assert.equal(await req({ tab: 10, at: Date.now() }), 'busy', 'brought forward inside this session\'s own job'); }
  finally { await own.release(); }
  assert.deepEqual(log, [], log.join('\n'));
  // Replacing the same tab's alert while queued must not open it on behalf of the older request.
  assert.equal(await whileQueued(() => request(), () => waiting()), 'ignored');
  assert.equal(await reason(), 'alert_changed');
  assert.deepEqual(log, []);
  // A navigation not yet noticed by the wait's poll must not open an unrelated page.
  page = makeDom(PAGE, 'https://shop.test/changed');
  assert.equal(await req(), 'ignored');
  assert.equal(await reason(), 'page_changed');
  assert.deepEqual(log, []);
  waiting();
  // A second click is acknowledged as busy; the first completion cannot overwrite that new result.
  const release = await holdLock();
  const first = request(), second = request();
  const running = req(first);
  await until(async () => (await result()).id === first.id && (await result()).status === 'queued');
  assert.equal(await req(first), 'queued', 'duplicate in-flight request was submitted twice');
  assert.equal(await req(second), 'busy');
  assert.equal((await result()).id, second.id);
  await release();
  assert.equal(await running, 'shown');
  assert.equal((await result()).id, second.id, 'a late completion overwrote the most recent click result');
  assert.deepEqual(log, ['activate 10']);
  log = [];
  // An absolute queue timeout reports failure and never activates later when the other agent leaves.
  const timeoutRelease = await holdLock();
  G.setQueueMaxMs(80);
  try {
    assert.equal(await req(), 'failed');
    assert.equal(await reason(), 'queue_timeout');
  } finally { G.setQueueMaxMs(15_000); await timeoutRelease(); }
  assert.deepEqual(log, []);
  // Validation is repeated after the asynchronous read-only page preflight.
  idx.__setBridgeForTests({ ...fakeBridge(), chromeInfo: async () => { waiting(); return { url: page.location.href }; } });
  assert.equal(await req(), 'ignored');
  assert.equal(await reason(), 'alert_changed');
  assert.deepEqual(log, []);
  idx.__setBridgeForTests(fakeBridge());
  idx.__setBridgeForTests({ ...fakeBridge(), activateChrome: async () => { throw new Error('Chrome is gone'); } });
  assert.equal(await req({ tab: 10, at: Date.now() }), 'failed');
  assert.equal(await reason(), 'target_unavailable');
  assert.doesNotMatch(JSON.stringify(await result()), /https:|shop\.test|Chrome is gone/, 'a raw page/error detail leaked into the GUI response');
  idx.__setBridgeForTests({ ...fakeBridge(), activateChrome: async () => ({ ok: false }) });
  assert.equal(await req(), 'failed', 'an unsuccessful activation was reported as shown');
  idx.__setBridgeForTests(fakeBridge());
  // Startup scan recovers an already-written request even when no fs.watch event is delivered.
  const startup = request();
  const temporary = `${G.file}.startup.tmp`;
  await writeFile(temporary, JSON.stringify(startup));
  await rename(temporary, G.file);
  const recoveredWatcher = G.watch();
  try { await until(async () => (await result()).id === startup.id && (await result()).status === 'shown'); }
  finally { recoveredWatcher.close(); }
  B.delete(10);
  assert.equal(await G.run(), 'none', 'the request file was left behind');
  ok('「带我去」: exact worker/alert identity, atomic queued/final acknowledgements, duplicate idempotence, bounded queue and late-result isolation; stale/replaced/paused/changed-page requests and own jobs never activate');
}
{
  // A field only the user can fill is observed for 10 minutes unless told otherwise.
  assert.deepEqual([idx.waitMinutes(undefined, 5), idx.waitMinutes(null, null), idx.waitMinutes(0.05, 5), idx.waitMinutes(50, null), idx.waitMinutes(0, 5)],
    [10, 3, 0.05, 10, 10]);
  const w = idx.__toolsForTests().find(t => t.name === 'wait_for_user');
  assert.equal(w.inputSchema.properties.minutes.default, undefined, 'a schema default of 3 would override the 10 for a field');
  assert.match(w.inputSchema.properties.minutes.description, /10 with field/);
  ok('a field wait lasts 10 minutes by default (3 without field, at most 10); the schema says so and has no default that would shorten it');
}
{
  const tools = idx.__toolsForTests();
  const w = tools.find(t => t.name === 'wait_for_user');
  assert.ok(w.inputSchema.properties.field, 'wait_for_user has no field');
  assert.match(w.description, /has not already explicitly said continue in the original conversation after this handoff, wait/);
  assert.match(w.description, /Once they have, read_page on the same tab before resuming/);
  assert.match(w.inputSchema.properties.field.description, /Return ends observation, not permission to resume/);
  const instructions = idx.serverInstructions({ home: '/nonexistent-home', execPath: '/nonexistent/node' });
  assert.match(instructions, /instead of asking in chat, call wait_for_user/);
  assert.match(instructions, /explicitly said "continue" in the original conversation after this handoff/);
  assert.match(instructions, /if already received, do not ask them to repeat it/);
  assert.match(instructions, /Earlier task authorization does not replace this continuation instruction/);
  assert.match(instructions, /server does not read chat replies or enforce a cross-client continuation gate/);
  ok('tool schema and server instructions require explicit continuation as an agent protocol, without claiming a server chat gate');
}

console.log(`\nask tests passed (${passed}).`);
process.exit(0);
