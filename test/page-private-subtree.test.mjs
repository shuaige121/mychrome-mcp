// Private-field handoffs must also hide textarea default text from ancestor labels/titles.
// Pure DOM fixtures; nothing reaches Chrome, the input helper, or a real account.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const readSource = await readFile(new URL('../src/page/read.js', import.meta.url), 'utf8');
const askSource = await readFile(new URL('../src/page/ask.js', import.meta.url), 'utf8');
const SECRET = 'SYNTHETIC_PRIVATE_SENTINEL';
function page(html) {
  const w = new JSDOM(`<title>Demo</title><body>${html}</body>`, {
    url: 'https://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  }).window;
  w.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 40, width: 900, height: 40 };
  };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  w.Element.prototype.scrollIntoView = function () {};
  return w;
}
const read = (w, request = {}) => JSON.parse(w.eval(readSource.replaceAll('__READ__', () => JSON.stringify(request))));
function arm(w) {
  read(w);
  const field = w.document.querySelector('textarea');
  // Synthetic native focus and the fresh field identity; ask.js only verifies them.
  field.focus({ preventScroll: true });
  const focusToken = 'private-subtree-focus';
  w.__chromeBridgeFieldTarget = { token: focusToken, el: field, marker: w.__chromeBridge.markers.indexOf(field), url: w.location.href };
  const request = { arm: 'private-subtree-test', focusToken, marker: w.__chromeBridge.markers.indexOf(field),
    text: { title: 'Enter private text', hint: 'Done', hintMulti: 'Done' } };
  const result = JSON.parse(w.eval(askSource.replaceAll('__ASK__', () => JSON.stringify(request))));
  assert.equal(result.armed, true);
  // Controlled textarea implementations can mirror the current value into defaultValue.
  field.value = SECRET;
  field.defaultValue = SECRET;
  return field;
}
function assertPrivate(w, query = 'Private label') {
  for (const request of [{}, { sections: ['S1'] }, { full: true }, { query }]) {
    assert.doesNotMatch(JSON.stringify(read(w, request)), new RegExp(SECRET), JSON.stringify(request));
  }
}
let passed = 0;
function test(name, run) { run(); console.log(`ok ${++passed} ${name}`); }

test('private textarea text never escapes through ancestor labels or clickable containers in any read mode', () => {
  for (const wrapper of ['label', 'div role="button"', 'div style="cursor:pointer"']) {
    const tag = wrapper.split(' ')[0];
    const w = page(`<h1>Root</h1><${wrapper}>Private label <span>visible suffix</span><textarea name="private"></textarea></${tag}>`);
    try {
      const field = arm(w), before = w.document.body.outerHTML;
      assertPrivate(w);
      assert.match(read(w, { sections: ['S1'] }).text, /Private label visible suffix/);
      assert.equal(field.value, SECRET);
      assert.equal(field.defaultValue, SECRET);
      assert.equal(w.document.body.outerHTML, before, 'privacy extraction must not mutate the page');
    } finally { w.close(); }
  }
});

test('private subtree filtering also applies when rendered ancestor innerText contains its text', () => {
  const w = page('<h1>Root</h1><label>Private label <textarea id="private"></textarea></label>');
  try {
    arm(w);
    Object.defineProperty(w.document.querySelector('label'), 'innerText', { value: `Private label ${SECRET}` });
    assertPrivate(w);
    assert.match(read(w, { sections: ['S1'] }).text, /Private label/);
  } finally { w.close(); }
});

test('section titles and dialog title fallbacks do not re-expose private descendant text', () => {
  for (const html of [
    '<h1>Private label <textarea id="private"></textarea></h1>',
    '<h1>Root</h1><dialog open><label>Private label <textarea id="private"></textarea></label><button>Confirm</button></dialog>',
    '<h1>Root</h1><dialog open aria-labelledby="caption"><label id="caption">Private label <textarea id="private"></textarea></label><button>Confirm</button></dialog>',
    '<main aria-labelledby="caption"><label id="caption">Private label <textarea id="private"></textarea></label></main>',
  ]) {
    const w = page(html);
    try { arm(w); assertPrivate(w); } finally { w.close(); }
  }
});

test('a re-rendered named textarea stays private inside its label', () => {
  const w = page('<h1>Root</h1><label>Private label <textarea name="private"></textarea></label>');
  try {
    const field = arm(w), replacement = field.cloneNode(true);
    field.replaceWith(replacement);
    replacement.value = SECRET;
    assertPrivate(w);
  } finally { w.close(); }
});

test('ordinary labels and textarea text remain readable without a private handoff', () => {
  const w = page('<h1>Root</h1><label>Ordinary <span>visible label</span> <textarea>PUBLIC_NOTE</textarea></label>');
  try {
    for (const request of [{ sections: ['S1'] }, { full: true }, { query: 'Ordinary' }]) {
      const result = read(w, request);
      assert.match(result.text, /Ordinary visible label/);
      assert.match(result.text, /PUBLIC_NOTE/);
    }
  } finally { w.close(); }
});

// type_text's record step (src/page/after.js) on a focused textarea: bind, the text arrives, last confirmation.
const afterSource = await readFile(new URL('../src/page/after.js', import.meta.url), 'utf8');
function typedRecord(w, field, text) {
  const run = (expect, bind) => JSON.parse(w.eval(afterSource.replaceAll('__MARKER__', 'null')
    .replaceAll('__EXPECT__', () => JSON.stringify(expect)).replaceAll('__BIND__', () => JSON.stringify(bind))));
  w.document.hasFocus = () => true;
  field.focus({ preventScroll: true });
  run(null, { set: 'typed-record', strict: true });
  field.value = text;
  return run(text, { check: 'typed-record', record: true }).typedField;
}

test('C7: a field the agent typed into and the user then filled is never compared: no slot, no value back', () => {
  const modes = [{}, { sections: ['S1'] }, { full: true }, { query: 'Private label' }];
  // Control: an ordinary typed field gets its slot and returns its content to the server only.
  const open = page('<h1>Root</h1><label>Ordinary label <textarea name="note"></textarea></label>');
  try {
    read(open);
    const id = typedRecord(open, open.document.querySelector('textarea'), 'TYPED_BY_AGENT').id;
    for (const request of modes.slice(1)) {
      const r = read(open, { ...request, typed: [id] });
      assert.deepEqual(r.typed, { [id]: 'TYPED_BY_AGENT' }, JSON.stringify(request));
      assert.match(r.text, new RegExp(`\u0003${id}\u0003`), JSON.stringify(request));
      assert.doesNotMatch(r.text, /TYPED_BY_AGENT/, JSON.stringify(request));
    }
  } finally { open.close(); }
  const w = page('<h1>Root</h1><label>Private label <textarea name="private"></textarea></label>');
  try {
    read(w);
    const id = typedRecord(w, w.document.querySelector('textarea'), 'TYPED_BEFORE_HANDOFF').id;
    arm(w);
    for (const request of modes) {
      const r = read(w, { ...request, typed: [id] });
      assert.deepEqual(r.typed, {}, JSON.stringify(request));
      assert.doesNotMatch(JSON.stringify(r), new RegExp(`${SECRET}|TYPED_BEFORE_HANDOFF|\\\\u0003`), JSON.stringify(request));
    }
  } finally { w.close(); }
});

console.log(`${passed} private subtree groups passed`);
