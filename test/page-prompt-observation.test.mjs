import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { template, rule } from './page-event-fixtures.mjs';
const script = readFileSync(new URL('../src/page/prompt-observation.js', import.meta.url), 'utf8');
const html = `<dialog open><h1>${template.title}</h1><p>${template.texts[0]}</p>${template.buttons.map(b => `<button>${b}</button>`).join('')}</dialog>`;
function page(body = html) {
  const dom = new JSDOM(`<body>${body}</body>`, { url: rule.origin, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () {
    const button = this.tagName === 'BUTTON';
    return { x: 20, y: 20, left: 20, top: 20, right: button ? 180 : 900, bottom: button ? 60 : 700, width: button ? 160 : 880, height: button ? 40 : 680 };
  };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  const computed = w.getComputedStyle.bind(w);
  w.getComputedStyle = el => { const s = computed(el); return new Proxy(s, { get(o, k) {
    if (k === 'opacity') return o[k] || '1'; if (k === 'overflowX' || k === 'overflowY') return o[k] || 'visible'; return o[k];
  } }); };
  w.document.elementFromPoint = () => w.document.querySelector('button');
  for (const name of ['click', 'focus', 'scrollIntoView']) w.HTMLElement.prototype[name] = () => { throw Error(`visible mutation: ${name}`); };
  const run = (request, code = script) => JSON.parse(w.eval(code.replace('__PROMPT_OBSERVATION__', () => JSON.stringify({ namespace: 'qa_fixture', ...request }))));
  const observe = () => run({ mode: 'observe' });
  const validate = instance => run({ mode: 'validate', ...instance, expectedOrigin: rule.origin, expectedTemplate: template, button: rule.button });
  return { w, dom, run, observe, validate, close: () => w.close() };
}
test('actual page script reads literal catalog and validates geometry without DOM/input mutation', () => {
  const h = page(); try {
    const before = h.w.document.body.outerHTML, observed = h.observe();
    assert.equal(observed.complete, true); assert.equal(observed.observations.length, 1);
    const o = observed.observations[0];
    for (const key of ['title', 'texts', 'buttons']) assert.deepEqual(o[key], template[key]);
    assert.equal(o.origin, rule.origin); assert.equal(o.complete, true); assert.equal(o.hasField, false);
    assert.equal(h.validate(o.instance).ok, true); assert.equal(h.w.document.body.outerHTML, before);
    assert.equal(h.observe().observations[0].instance.nodeToken, o.instance.nodeToken);
  } finally { h.close(); }
});
test('actual node replacement and observed close/reopen allocate new IDs; stale document refuses', () => {
  const h = page(); try {
    const first = h.observe().observations[0].instance, dialog = h.w.document.querySelector('dialog');
    dialog.replaceWith(dialog.cloneNode(true)); const second = h.observe().observations[0].instance;
    assert.notEqual(first.nodeToken, second.nodeToken); assert.equal(h.validate(first).ok, false);
    const current = h.w.document.querySelector('dialog'); current.removeAttribute('open'); assert.equal(h.observe().observations.length, 0);
    current.setAttribute('open', ''); assert.notEqual(h.observe().observations[0].instance.nodeToken, second.nodeToken);
    assert.equal(h.validate({ ...second, documentToken: 'other_document' }).reason, 'document_changed');
  } finally { h.close(); }
});
test('visible fixed prompt remains observable beneath zero-box portal/display:contents ancestors', () => {
  for (const display of ['block', 'contents']) {
    const h = page(`<div id="portal" style="display:${display}">${html}</div>`); try {
      const portal = h.w.document.getElementById('portal');
      portal.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
      portal.getClientRects = () => [];
      const result = h.observe(); assert.equal(result.observations.length, 1, display);
      assert.equal(result.observations[0].complete, true); assert.equal(h.validate(result.observations[0].instance).ok, true);
    } finally { h.close(); }
  }
});
test('offscreen portal boxes do not hide visible descendants; hidden/private parents still prune', () => {
  const h = page(`<div id="portal">${html}</div>`); try {
    h.w.document.getElementById('portal').getBoundingClientRect = () => ({ x: -300, y: -300, left: -300, top: -300, right: -200, bottom: -200, width: 100, height: 100 });
    assert.equal(h.observe().observations.length, 1);
  } finally { h.close(); }
  for (const attribute of ['hidden', 'aria-hidden="true"', 'inert', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"', 'contenteditable']) {
    const h = page(`<div ${attribute}>${html}</div>`); try { assert.equal(h.observe().observations.length, 0, attribute); } finally { h.close(); }
  }
  const p = page(`<div id="private">${html}</div>`); try {
    p.w.__chromeBridgePrivate = { set: new WeakSet([p.w.document.getElementById('private')]) };
    assert.equal(p.observe().observations.length, 0);
  } finally { p.close(); }
});
test('changed full body, origin, multiple/nested prompts and incomplete scans refuse', () => {
  for (const mutate of [h => { h.w.document.querySelector('p').append(' different suffix'); },
    h => h.dom.reconfigure({ url: 'http://127.0.0.1:17745' }),
    h => h.w.document.body.insertAdjacentHTML('beforeend', html),
    h => h.w.document.querySelector('dialog').insertAdjacentHTML('beforeend', '<div role="dialog">Nested</div>'),
    h => h.w.document.body.insertAdjacentHTML('beforeend', '<iframe></iframe>'),
    h => h.w.document.querySelector('p').textContent = 'x'.repeat(17000),
    h => h.w.document.querySelector('dialog').insertAdjacentHTML('beforeend', '<p>x</p>'.repeat(40))]) {
    const h = page(); try { const instance = h.observe().observations[0].instance; mutate(h); assert.equal(h.validate(instance).ok, false); } finally { h.close(); }
  }
});
test('fields, editable drafts and marked private content cannot authorize or expose private values', () => {
  for (const field of ['<input value="SECRET">', '<textarea>SECRET</textarea>', '<div contenteditable>SECRET</div>', '<div role="textbox">SECRET</div>']) {
    const h = page(); try {
      const instance = h.observe().observations[0].instance; h.w.document.querySelector('dialog').insertAdjacentHTML('beforeend', field);
      for (const input of h.w.document.querySelectorAll('input,textarea')) Object.defineProperty(input, 'value', { get() { throw Error('input value read'); } });
      const result = h.observe(); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
      assert.equal(result.observations[0].hasField, true); assert.equal(h.validate(instance).ok, false);
    } finally { h.close(); }
  }
  const h = page(); try {
    const p = h.w.document.querySelector('p'); p.textContent = 'SECRET'; h.w.__chromeBridgePrivate = { set: new WeakSet([p]) };
    assert.doesNotMatch(JSON.stringify(h.observe()), /SECRET/);
  } finally { h.close(); }
});
test('hidden/disabled/covered labels and disabled ancestors never validate', () => {
  for (const mutate of [h => { h.w.document.querySelector('button').disabled = true; },
    h => h.w.document.querySelector('dialog').setAttribute('aria-disabled', 'true'),
    h => { h.w.document.querySelector('button').style.display = 'none'; },
    h => { h.w.document.elementFromPoint = () => h.w.document.body; },
    h => h.w.document.querySelector('button').setAttribute('aria-label', 'Different'),
    h => h.w.document.querySelector('dialog').setAttribute('hidden', '')]) {
    const h = page(); try { const instance = h.observe().observations[0].instance; mutate(h); assert.equal(h.validate(instance).ok, false); } finally { h.close(); }
  }
});
test('DOM normalization preserves FEFF/ZWSP; candidates and template text stay bounded', () => {
  const h = page(); try {
    h.w.document.querySelector('p').textContent = '\uFEFFa\u200b'; assert.equal(h.observe().observations[0].texts[0], '\uFEFFa\u200b');
    h.w.document.body.innerHTML = html.repeat(10); const result = h.observe(); assert.equal(result.observations.length, 8); assert.equal(result.complete, false);
  } finally { h.close(); }
});
test('guard-removal negative: disabling hit-test rejection makes the covered-button assertion fail', () => {
  const h = page(); try {
    const instance = h.observe().observations[0].instance; h.w.document.elementFromPoint = () => h.w.document.body;
    const request = { mode: 'validate', ...instance, expectedOrigin: rule.origin, expectedTemplate: template, button: rule.button };
    const negative = code => assert.equal(h.run(request, code).ok, false);
    negative(script);
    const guard = "if (!hit || !(hit === target || target.contains(hit))) return fail('button_covered');";
    assert.ok(script.includes(guard)); assert.throws(() => negative(script.replace(guard, '/* fixture removes hit-test rejection */')), { code: 'ERR_ASSERTION' });
  } finally { h.close(); }
});
