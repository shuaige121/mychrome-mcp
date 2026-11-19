// Real page scripts and click receipt logic. Browser/native IO and time are simulated.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { didClickRegister } from '../src/guard.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
// G1: block.js too: the after-click observation runs it first in the same eval.
const scripts = Object.fromEntries(await Promise.all(['read', 'click-observation', 'block'].map(async name =>
  [name, await fs.readFile(new URL(`../src/page/${name}.js`, import.meta.url), 'utf8')])));
function production(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
let passed = 0;
async function test(name, fn) { await fn(); console.log(`ok ${++passed} ${name}`); }
async function fixture(run, html = '') {
  const w = new JSDOM(`<title>Fixture</title><body><header>OLD_NAVIGATION</header><main><h1>OLD_PAGE_TITLE</h1><p>OLD_BODY</p><button id="login">Login</button>${html}</main></body>`, {
    url: 'https://fixture.invalid/login', runScripts: 'outside-only', pretendToBeVisual: true,
  }).window;
  w.Element.prototype.getBoundingClientRect = function () {
    for (let p = this; p; p = p.parentElement) {
      const s = w.getComputedStyle(p);
      if (p.hidden || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') {
        return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
      }
    }
    const top = this.dataset.offscreen === 'true' ? 2000 : 10;
    return { x: 10, y: top, top, left: 10, right: 410, bottom: top + 30, width: 400, height: 30 };
  };
  w.Element.prototype.getClientRects = function () { const r = this.getBoundingClientRect(); return r.width ? [r] : []; };
  let now = 0, tick = () => {};
  class Clock extends Date { static now() { return now; } }
  const context = { routineEvidence: null };
  const c = vm.createContext({
    Date: Clock, Number, String, Math, Set, Map, JSON, process: { env: {} }, didClickRegister,
    CALL: { getStore: () => context }, sleep: async ms => { now += ms; tick(now); },
    clip: (s, n) => String(s || '').slice(0, n), redactUrl: s => s, redactText: s => s,
    settledUrl: async (_tab, url) => url, ledgerNavigated() {},
    diffNewTabs: () => [], claimPopups: async () => ({ mine: [], theirs: [] }),
    B: {
      pageDialog: async () => ({ open: false }),
      pageScript: async (name, values = {}) => Object.entries(values).reduce((s, [key, value]) =>
        s.replaceAll(`__${key}__`, () => JSON.stringify(value)), scripts[name]),
      evalInPage: async script => JSON.parse(w.eval(script)),
      chromeInfo: async () => ({ url: w.location.href }),
      listTabs: async () => ({ windows: [{ id: 1, tabs: [{ id: 7 }] }] }),
    },
  });
  vm.runInContext(['clickObservation', 'clickChanges', 'clickReport'].map(production).join('\n'), c);
  // Register the original Login exactly as read_page does.
  w.eval(scripts.read.replaceAll('__READ__', () => JSON.stringify({ full: true })));
  const marker = w.__chromeBridge.markers.indexOf(w.document.getElementById('login'));
  const before = await c.clickObservation(7, marker, { set: 'single-click' });
  const st = { tab: 7, marker, observationToken: 'single-click', before,
    hrefBefore: w.location.href, ack: { seen: true }, prep: { target: { tabId: 7 }, ownNote: '' },
    listBefore: { windows: [{ id: 1, tabs: [{ id: 7 }] }] } };
  const h = { w, before, c, context, marker, elapsed: () => now,
    onTick(fn) { tick = fn; }, report: () => c.clickReport(st) };
  try { await run(h); } finally { w.close(); }
}
const choices = '<p>Please choose your login identity</p><button>Individual User</button><button>Business User</button>';
function assertChoiceReceipt(h, result) {
  assert.match(result.out, /\[\d+\].*Individual User/);
  assert.match(result.out, /\[\d+\].*Business User/);
  assert.match(result.out, /Please choose your login identity/);
  assert.doesNotMatch(result.out, /OLD_NAVIGATION|OLD_PAGE_TITLE|OLD_BODY/);
  for (const label of ['Individual User', 'Business User']) {
    const match = result.out.match(new RegExp(`\\[(\\d+)\\][^\\n]*${label}`));
    const node = h.w.__chromeBridge.markers[Number(match[1])];
    assert.equal(node.textContent, label, 'returned marker must resolve to this exact new choice');
    assert.equal((result.out.match(new RegExp(label, 'g')) || []).length, 1, 'do not repeat control labels');
  }
}

await test('same-URL inline Login choices return only new context and usable markers', () => fixture(async h => {
  h.w.document.querySelector('main').insertAdjacentHTML('beforeend', choices);
  assertChoiceReceipt(h, await h.report());
}));

await test('a hidden menu becoming visible is a delta even without navigation or dialog roles', () => fixture(async h => {
  h.w.document.getElementById('choices').hidden = false;
  assertChoiceReceipt(h, await h.report());
}, `<div id="choices" hidden>${choices}</div>`));

await test('a dialog inside a clickable backdrop exposes its own buttons and omits covered replacements', () => fixture(async h => {
  const d = h.w.document;
  // Frameworks can replace the original navigation button when opening a panel.
  d.getElementById('login').outerHTML = '<button id="login">Log In</button>';
  d.body.insertAdjacentHTML('beforeend', '<div id="backdrop" role="button"><div role="dialog"><p>Log in to continue</p><button id="close" aria-label="Close"></button><button id="singpass"><img alt="Log in with Singpass"></button></div></div>');
  const rect = h.w.Element.prototype.getBoundingClientRect;
  h.w.Element.prototype.getBoundingClientRect = function () {
    const r = rect.call(this), x = this.id === 'close' ? 500 : this.id === 'singpass' ? 600 : 10;
    return { ...r, x, left: x, width: 80, right: x + 80 };
  };
  d.elementFromPoint = x => d.getElementById(x >= 600 ? 'singpass' : x >= 500 ? 'close' : 'backdrop');
  const result = await h.report();
  for (const [id, label] of [['close', 'Close'], ['singpass', 'Log in with Singpass']]) {
    const match = result.out.match(new RegExp(`\\[(\\d+)\\] button \\| ${label}`));
    assert.ok(match, `missing ${label}: ${result.out}`);
    assert.equal(h.w.__chromeBridge.markers[+match[1]], d.getElementById(id));
  }
  assert.match(result.out, /Log in to continue/);
  assert.doesNotMatch(result.out, /button \| Log In(?:\n|$)|\] div \|/);
  assert.doesNotMatch(result.out, /OLD_/);
  const compact = JSON.parse(h.w.eval(scripts.read.replaceAll('__READ__', '{}')));
  assert.match(compact.text, /Log in with Singpass/);
  assert.match(compact.text, /Close/);
}));

await test('a nonmodal dialog preserves reachable background actions and hidden dialogs do not swallow triggers', () => fixture(async h => {
  const d = h.w.document;
  d.body.insertAdjacentHTML('beforeend', '<button id="outside">Outside action</button><div id="launcher" role="button">Open panel<div role="dialog" hidden><button>Hidden action</button></div></div><aside role="dialog"><button id="inside">Panel action</button></aside>');
  const rect = h.w.Element.prototype.getBoundingClientRect;
  h.w.Element.prototype.getBoundingClientRect = function () {
    const r = rect.call(this), x = this.id === 'inside' ? 600 : this.id === 'launcher' ? 500 : 10;
    return r.width ? { ...r, x, left: x, width: 80, right: x + 80 } : r;
  };
  d.elementFromPoint = x => d.getElementById(x >= 600 ? 'inside' : x >= 500 ? 'launcher' : 'outside');
  const result = await h.report();
  for (const label of ['Outside action', 'Open panel', 'Panel action']) assert.match(result.out, new RegExp(label));
  assert.ok(h.w.__chromeBridge.markers.includes(d.getElementById('launcher')));
  assert.ok(!h.w.__chromeBridge.markers.includes(d.querySelector('[hidden] button')));
}));

await test('delayed portal/dialog options are observed without another click', () => fixture(async h => {
  h.onTick(now => { if (now >= 1250 && !h.w.document.querySelector('dialog')) {
    h.w.document.body.insertAdjacentHTML('beforeend', `<dialog open>${choices}</dialog>`);
  } });
  assertChoiceReceipt(h, await h.report());
  assert.ok(h.elapsed() >= 1250 && h.elapsed() <= 3500);
}));

await test('a temporary loading message does not hide the choices that follow it', () => fixture(async h => {
  h.w.document.querySelector('main').insertAdjacentHTML('beforeend', '<div id="loading" role="status" aria-busy="true">Loading…</div>');
  h.onTick(now => { if (now >= 1000 && h.w.document.getElementById('loading')) {
    h.w.document.getElementById('loading').remove();
    h.w.document.querySelector('main').insertAdjacentHTML('beforeend', choices);
  } });
  assertChoiceReceipt(h, await h.report());
  assert.ok(h.elapsed() >= 1000);
}));

await test('an unchanged page returns no repeated content or old option', () => fixture(async h => {
  const result = await h.report();
  assert.match(result.out, /结果未确认/);
  assert.doesNotMatch(result.out, /OLD_|Business User/);
}, '<button>Business User</button>'));

await test('closing a dialog does not resend the already-known background controls', () => fixture(async h => {
  h.w.document.querySelector('dialog').remove();
  h.w.document.querySelector('main').insertAdjacentHTML('beforeend', '<p>Individual route selected</p>');
  const result = await h.report();
  assert.match(result.out, /Individual route selected/);
  assert.doesNotMatch(result.out, /button \| Login|OLD_NAVIGATION|OLD_PAGE_TITLE|OLD_BODY/);
}, `<dialog open>${choices}</dialog>`));

await test('editable values and private subtree text do not enter automatic deltas', () => fixture(async h => {
  h.w.document.body.insertAdjacentHTML('beforeend', '<div role="button">Continue<textarea>PRIVATE_DRAFT</textarea></div><input type="password" value="PRIVATE_PASSWORD"><div role="textbox">PRIVATE_EDITABLE</div>');
  const result = await h.report();
  assert.doesNotMatch(result.out, /PRIVATE_/);
}));

await test('revealed choices are not lost after a long unchanged page exhausts text sampling', () => fixture(async h => {
  h.w.document.body.insertAdjacentHTML('beforeend', `<div role="dialog" aria-modal="true">${choices}</div>`);
  const result = await h.report();
  assert.match(result.out, /\[\d+\].*Individual User/);
  assert.match(result.out, /\[\d+\].*Business User/);
  assert.doesNotMatch(result.out, /OLD_/);
}, Array.from({ length: 2600 }, (_, i) => `<span>OLD_${i}</span>`).join('')));

console.log(`${passed} click delta groups passed`);
