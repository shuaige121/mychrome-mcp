/* Actual readback script in jsdom; no Chrome or native input. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { BridgeError } from '../src/bridge.js';
import { typingSegments, typedCount, keyupCount, userStopMessage } from '../src/guard.js';

const afterSource = await fs.readFile(new URL('../src/page/after.js', import.meta.url), 'utf8');
const indexSource = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const production = name => {
  const start = indexSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return indexSource.slice(start, indexSource.indexOf('\n}', start) + 2);
};
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }
function page(html = '<input id="a"><input id="b">') {
  const d = new JSDOM(html, { url: 'https://example.test/form', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = d.window, field = w.document.getElementById('a');
  field.focus(); w.document.hasFocus = () => true;
  const read = (expected = null, bind = null) => JSON.parse(w.eval(afterSource
    .replace(/__MARKER__/g, 'null').replace(/__EXPECT__/g, () => JSON.stringify(expected))
    .replace(/__BIND__/g, () => JSON.stringify(bind))));
  return { w, field, read, close: () => w.close() };
}

await check('replacement requires a full selection in the exact bound field', () => {
  const p = page();
  try {
    p.field.value = 'existing'; p.field.setSelectionRange(3, 3);
    p.read(null, { set: 't', strict: true });
    assert.equal(p.read(null, { check: 't', selectAll: true }).selectionAll, false);
    p.field.setSelectionRange(0, p.field.value.length);
    assert.equal(p.read(null, { check: 't', selectAll: true }).selectionAll, true);
    p.field.value = 'new'; p.field.setSelectionRange(3, 3);
    const r = p.read('new', { check: 't' });
    assert.equal(r.fieldHasText, true); assert.equal(r.confirmedChars, 3);
    assert.doesNotMatch(JSON.stringify(r), /existing|"new"/);
  } finally { p.close(); }
});

await check('same-text replacement needs the caret evidence; swallowed input is not confirmed', () => {
  const p = page();
  try {
    p.field.value = 'same'; p.field.setSelectionRange(2, 2);
    p.read(null, { set: 't', strict: true });
    p.field.setSelectionRange(0, 4); p.read(null, { check: 't', selectAll: true });
    assert.equal(p.read('same', { check: 't' }).fieldHasText, false);
    p.field.setSelectionRange(4, 4);
    assert.equal(p.read('same', { check: 't' }).fieldHasText, true);
  } finally { p.close(); }
});

await check('partial selection, focus movement, re-render and value mutation refuse replacement', () => {
  for (const kind of ['partial', 'focus', 'rerender', 'value']) {
    const p = page();
    try {
      p.field.value = 'existing'; p.read(null, { set: 't', strict: true });
      p.field.setSelectionRange(0, 8);
      if (kind === 'partial') p.field.setSelectionRange(0, 3);
      if (kind === 'focus') p.w.document.getElementById('b').focus();
      if (kind === 'rerender') { const next = p.field.cloneNode(); p.field.replaceWith(next); next.focus(); }
      if (kind === 'value') { p.field.value = 'changed'; p.field.setSelectionRange(0, 7); }
      assert.equal(p.read(null, { check: 't', selectAll: true }).selectionAll, false, kind);
    } finally { p.close(); }
  }
});

await check('strict readback rejects matching prefixes with unexpected content or a moved caret', () => {
  const p = page();
  try {
    p.field.value = 'AB'; p.field.setSelectionRange(1, 1);
    p.read(null, { set: 't', strict: true });
    p.field.value = 'AnewB'; p.field.setSelectionRange(4, 4);
    assert.equal(p.read('new', { check: 't' }).confirmedChars, 3);
    p.field.value = 'AnewX'; p.field.setSelectionRange(4, 4);
    assert.equal(p.read('new', { check: 't' }).fieldHasText, false);
    p.field.value = 'AnewB'; p.field.setSelectionRange(0, 0);
    assert.equal(p.read('new', { check: 't' }).fieldHasText, false);
  } finally { p.close(); }
});

await check('contenteditable replacement verifies full selection and the final collapsed caret', () => {
  const p = page('<div id="a" contenteditable="true">old <b>draft</b></div>');
  try {
    const select = all => {
      const r = p.w.document.createRange(); r.selectNodeContents(p.field);
      if (!all) r.collapse(false);
      const s = p.w.getSelection(); s.removeAllRanges(); s.addRange(r);
    };
    select(false); p.read(null, { set: 'ce', strict: true });
    select(true); assert.equal(p.read(null, { check: 'ce', selectAll: true }).selectionAll, true);
    p.field.textContent = 'new draft'; select(false);
    const result = p.read('new draft', { check: 'ce' });
    assert.equal(result.fieldHasText, true); assert.equal(result.confirmedChars, 9);
    assert.doesNotMatch(JSON.stringify(result), /old draft|new draft/);
  } finally { p.close(); }
});

function harness(options = {}) {
  const p = page(options.html), calls = [], progress = [], state = { now: 0, chunks: 0 };
  p.field.value = options.value || ''; p.field.setSelectionRange(p.field.value.length, p.field.value.length);
  const context = { notifyProgress: async (n, total) => {
    progress.push({ n, total, value: p.field.value });
    if (options.moveAfterProgress) p.w.document.getElementById('b').focus();
    if (options.notifyFailure) throw Error('client disconnected');
  } };
  const session = { request: async req => {
    calls.push(req);
    if (req.op === 'routed') return { ok: true, allToChrome: true, ms: 1 };
    if (req.op === 'panel') return { ok: true };
    if (req.op === 'restoreClipboard') return { restored: true };
    throw Error(`unexpected request ${req.op}`);
  } };
  class Clock extends Date { static now() { return state.now; } }
  const c = vm.createContext({
    process: { env: {} }, S: { setting: () => ({ value: 1, source: 'default' }) },
    Date: Clock, Number, String, Math, BridgeError, typingSegments, typedCount, keyupCount,
    CALL: { getStore: () => context }, newToken: () => 'bound',
    temporalState: async () => ({ fail: 'not_temporal' }), targetLine: () => '',
    sleep: async ms => { state.now += ms; }, lognormalMs: () => 0,
    readAfter: async (_marker, _tab, expected, bind) => p.read(expected, bind),
    post: async (_s, _ctx, _kind, req) => {
      calls.push(req);
      if (req.op === 'key' && req.name === 'select_all') {
        p.field.setSelectionRange(0, options.partialSelection ? 1 : p.field.value.length);
        return { ok: true, postedInput: 1 };
      }
      if (req.op === 'type' || req.op === 'paste') {
        state.chunks++; state.now += typedCount(req.text) * (options.msPerChar || 1);
        const normalized = req.text.replace(/\r\n?/g, '\n').replace(/\t/g, req.op === 'type' ? '    ' : '\t');
        if (!options.swallow && !(options.stopAfter && state.chunks > options.stopAfter)) {
          const start = p.field.selectionStart, end = p.field.selectionEnd;
          p.field.value = p.field.value.slice(0, start) + normalized + p.field.value.slice(end);
          p.field.setSelectionRange(start + normalized.length, start + normalized.length);
        }
        return { typed: typedCount(req.text) };
      }
      throw Error(`unexpected input ${req.op}/${req.name}`);
    },
    waitAck: async () => ({ seen: true }), ackLine: () => '',
  });
  vm.runInContext(['inputSpeedNow', 'paceFloor', 'fieldConfirms', 'typingEstimate', 'typeInSession'].map(production).join('\n'), c);
  return { ...p, calls, progress, state,
    run: args => c.typeInSession(session, { target: { tabId: 7 }, ownNote: '' }, {
      step: text => calls.push({ step: text }), panel: () => {}, observe: () => {},
    }, args) };
}

await check('replace uses one real select_all request before keys or explicit paste', async () => {
  for (const mode of ['keys', 'paste']) {
    const h = harness({ value: 'old draft' });
    try {
      await h.run({ text: 'new draft', replace: true, input_mode: mode });
      assert.equal(h.field.value, 'new draft');
      assert.deepEqual(h.calls.filter(x => ['type', 'paste', 'key'].includes(x.op)).map(x => x.name || x.op), ['select_all', mode === 'keys' ? 'type' : 'paste']);
      assert.deepEqual(h.progress.map(x => x.n), [9]);
    } finally { h.close(); }
  }
});

await check('unconfirmed select_all leaves the draft intact without sending replacement text', async () => {
  const h = harness({ value: 'old draft', partialSelection: true });
  try {
    await assert.rejects(h.run({ text: 'new', replace: true }), e => e.code === 'replace_unconfirmed');
    assert.equal(h.field.value, 'old draft');
    assert.equal(h.calls.filter(x => ['type', 'paste'].includes(x.op)).length, 0);
  } finally { h.close(); }
});

await check('400 characters exceeding 120 seconds keep one binding, ordered keys and actual progress', async () => {
  const h = harness({ msPerChar: 500 });
  try {
    const text = 'abcdefghijklmnopqrst'.repeat(20);
    await h.run({ text });
    assert.equal(h.field.value, text); assert.ok(h.state.now > 120_000);
    const keys = h.calls.filter(x => x.op === 'type');
    assert.equal(keys.map(x => x.text).join(''), text);
    assert.ok(keys.length > 1); assert.equal(h.calls.some(x => x.op === 'paste'), false);
    assert.ok(keys.every(x => x.confirmedProgress === true && x.text.length <= 32));
    assert.equal(keys[0].firstDelay, true); assert.ok(keys.slice(1).every(x => !x.firstDelay && x.continueTyping));
    assert.ok(h.progress.every(x => x.n === x.value.length && x.total === 400));
    assert.equal(h.progress.at(-1).n, 400);
  } finally { h.close(); }
});

await check('swallowed chunks and focus changes stop before any further input; progress never guesses', async () => {
  for (const options of [{ swallow: true }, { stopAfter: 1 }, { moveAfterProgress: true }]) {
    const h = harness(options);
    try {
      await assert.rejects(h.run({ text: 'x'.repeat(100) }), e => e.code === 'input_unconfirmed');
      const sent = h.calls.filter(x => x.op === 'type');
      assert.equal(sent.length, options.stopAfter ? 2 : 1);
      assert.deepEqual(h.progress.map(x => x.n), options.swallow ? [] : [32]);
      assert.ok(h.progress.every(x => x.n === x.value.length));
    } finally { h.close(); }
  }
});

await check('chunk boundaries preserve CRLF and textarea caret positions without duplicated Returns', async () => {
  const h = harness({ html: '<textarea id="a"></textarea><input id="b">', value: 'old draft' });
  try {
    const text = 'a'.repeat(31) + '\r\n' + 'b'.repeat(31) + '\tend';
    await h.run({ text, replace: true });
    const expected = text.replace(/\r\n/g, '\n').replace(/\t/g, '    ');
    assert.equal(h.field.value, expected);
    const sent = h.calls.filter(x => x.op === 'type');
    assert.equal(sent.map(x => x.text).join(''), text);
    assert.equal(sent.filter(x => x.text.endsWith('\r')).length, 0);
    assert.ok(h.progress.every(x => x.n === x.value.length && x.total === expected.length));
  } finally { h.close(); }
});

await check('progress notification failure does not fail or resend already-confirmed text', async () => {
  const h = harness({ notifyFailure: true });
  try {
    const text = 'x'.repeat(70);
    await h.run({ text });
    assert.equal(h.field.value, text);
    assert.deepEqual(h.calls.filter(x => x.op === 'type').map(x => x.text.length), [32, 32, 6]);
    assert.deepEqual(h.progress.map(x => x.n), [32, 64, 70]);
  } finally { h.close(); }
});

await check('interruption separates sent characters from field-confirmed progress', () => {
  const pending = userStopMessage({ steps: [], error: { reply: { typed: 3, confirmationPending: true } } });
  assert.match(pending, /尚无已确认的输入/);
  assert.match(pending, /本段已发送 3 个字符，尚未读回确认/);
  assert.doesNotMatch(pending, /还没有发出任何输入|逐键输入了 3/);
  const partial = userStopMessage({ steps: ['已在输入框确认 32/100 个字符'], error: { reply: { typed: 4, confirmationPending: true } } });
  assert.match(partial, /已在输入框确认 32\/100/);
  assert.match(partial, /本段已发送 4 个字符，尚未读回确认/);
  assert.doesNotMatch(partial, /确认 36\/100/);
});

console.log(`typing-replace: ${passed} regression groups passed`);
