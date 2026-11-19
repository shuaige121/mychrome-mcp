import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createPageFeedback, textTokens } from '../src/page-feedback.js';
const source = await readFile(new URL('../src/page/read.js', import.meta.url), 'utf8');
function page(html) {
  const { window: w } = new JSDOM(`<title>Demo</title><body>${html}</body>`, { url: 'https://example.test/article', runScripts: 'outside-only', pretendToBeVisual: true });
  w.Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 40, width: 900, height: 40 }; };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  return w;
}
const read = (w, req = {}) => JSON.parse(w.eval(source.replaceAll('__READ__', () => JSON.stringify(req))));
let passed = 0;
function test(name, fn) { fn(); console.log(`ok ${++passed} ${name}`); }
const article = `<header>ANNOUNCEMENT <a href="/home">Home</a></header><main><h1>Article title</h1><p>LEAD_BODY</p><h2>Chapter A</h2><p>CHAPTER_A_BODY</p><button>Save A</button><h3>Detail A1</h3><p>DETAIL_A1_BODY</p><h2>Chapter B</h2><p>CHAPTER_B_BODY</p></main>`;
test('default folds every body and all headings below the highest content heading', () => {
  const r = read(page(article));
  assert.match(r.text, /S1 Article title/);
  assert.doesNotMatch(r.text, /Chapter A|Detail A1|Chapter B|LEAD_BODY|CHAPTER_A_BODY|ANNOUNCEMENT|Save A/);
  assert.doesNotMatch(r.text, /提示：|这一屏|可点击元素索引|用 click/);
});
test('sections expands exactly one layer, preserving previously opened scopes', () => {
  const w = page(article);
  read(w);
  let r = read(w, { sections: ['S1'] });
  assert.match(r.text, /LEAD_BODY/);
  assert.match(r.text, /S2 Chapter A/);
  assert.match(r.text, /S4 Chapter B/);
  assert.doesNotMatch(r.text, /CHAPTER_A_BODY|DETAIL_A1_BODY|Detail A1/);
  r = read(w, { sections: ['S2'] });
  assert.match(r.text, /CHAPTER_A_BODY/);
  assert.match(r.text, /S3 Detail A1/);
  assert.doesNotMatch(r.text, /DETAIL_A1_BODY|CHAPTER_B_BODY/);
  const marks = r.text.match(/\[\d+\]/g) || [];
  assert.equal(marks.filter(x => x === '[2]').length, 1, 'click target must occur once, not inline plus index');
  r = read(w);
  assert.match(r.text, /CHAPTER_A_BODY/);
  assert.doesNotMatch(r.text, /DETAIL_A1_BODY/);
});
test('another reader starts folded and a replacement document gets a fresh identity', () => {
  const w = page(article);
  const first = read(w, { reader: 'a', sections: ['S1','S2'] });
  const other = read(w, { reader: 'b' });
  assert.doesNotMatch(other.text, /CHAPTER_A_BODY/);
  assert.ok(first.documentKey);
  assert.notEqual(read(page(article), { reader: 'a' }).documentKey, first.documentKey);
});
test('explicit refresh on a shared reader resets expanded scopes to the highest headings', () => {
  const w = page(article);
  const first = read(w, { reader: 'shared', sections: ['S1', 'S2'] });
  read(w, { reader: 'other', sections: ['S1', 'S2'] });
  const fresh = read(w, { reader: 'shared', refresh: true });
  assert.equal(fresh.documentKey, first.documentKey);
  assert.match(fresh.text, /S1 Article title \[collapsed\]/);
  assert.doesNotMatch(fresh.text, /Chapter A|LEAD_BODY|CHAPTER_A_BODY/);
  assert.doesNotMatch(read(w, { reader: 'shared' }).text, /CHAPTER_A_BODY/);
  assert.match(read(w, { reader: 'other' }).text, /CHAPTER_A_BODY/);
});
test('a headingless page has an expandable root, not an unsolicited body dump', () => {
  const w = page('<p>PLAIN_BODY</p><button>Action</button>');
  assert.match(read(w).text, /S0/);
  assert.doesNotMatch(read(w).text, /PLAIN_BODY|Action/);
  const expanded = read(w, { sections: ['S0'] });
  assert.match(expanded.text, /PLAIN_BODY/);
  assert.match(expanded.text, /\[1\].*Action/);
  assert.equal((expanded.text.match(/\[1\]/g) || []).length, 1);
});
test('open modal stays actionable without opening the background content', () => {
  const w = page(article + '<dialog open><p>Confirm choice</p><button>Confirm</button></dialog>');
  const r = read(w);
  assert.match(r.text, /Confirm choice/);
  assert.match(r.text, /\[3\].*Confirm/);
  assert.equal((r.text.match(/\[3\]/g) || []).length, 1);
  assert.doesNotMatch(r.text, /CHAPTER_A_BODY|ANNOUNCEMENT/);
});
test('explicit full and query still reach collapsed descendant content', () => {
  const w = page(article);
  assert.match(read(w, { full: true }).text, /DETAIL_A1_BODY/);
  assert.match(read(w, { query: 'DETAIL_A1_BODY', sections: ['S2'] }).text, /DETAIL_A1_BODY/);
});
test('default prioritizes content headings over site navigation and announcements', () => {
  const w = page('<header><h1>Site brand</h1><p>ANNOUNCEMENT</p></header><main><h2>Main article</h2><p>BODY</p><h3>Inner detail</h3></main><footer><h2>Newsletter</h2></footer>');
  const r = read(w);
  assert.match(r.text, /S2 Main article/);
  assert.doesNotMatch(r.text, /Site brand|Newsletter|ANNOUNCEMENT|Inner detail|BODY/);
});
test('an already-open popup remains actionable while its page body stays folded', () => {
  const w = page('<h1>Page</h1><p>HIDDEN_BODY</p><button aria-expanded="true" aria-controls="choices">Choose</button><ul id="choices" role="listbox"><li role="option">First option</li><li role="option">Second option</li></ul>');
  const r = read(w);
  assert.match(r.text, /Second option/);
  assert.doesNotMatch(r.text, /HIDDEN_BODY/);
  assert.equal((r.text.match(/\[3\]/g) || []).length, 1);
});
test('unnamed landmarks use their semantic name and do not leak body into the folded title', () => {
  const w = page('<main><p>BODY_MUST_STAY_FOLDED</p><form><input placeholder="Secret example"></form></main>');
  const r = read(w);
  assert.match(r.text, /S1/);
  assert.doesNotMatch(r.text, /BODY_MUST_STAY_FOLDED|Secret example/);
  assert.match(read(w, { sections: ['S1'] }).text, /BODY_MUST_STAY_FOLDED/);
});

test('section IDs stay bound to the same heading when another heading is inserted or removed', () => {
  const w = page('<main><h1>Root</h1><h2 id="a">Chapter A</h2><p>A_BODY</p><h2 id="b">Chapter B</h2><p>B_BODY</p></main>');
  try {
    assert.match(read(w, { sections: ['S1'] }).text, /S3 Chapter B/);
    const inserted = w.document.createElement('h2'); inserted.textContent = 'Inserted';
    w.document.getElementById('a').before(inserted);
    let r = read(w, { sections: ['S3'] });
    assert.match(r.text, /S3 Chapter B/);
    assert.match(r.text, /B_BODY/);
    assert.doesNotMatch(r.text, /A_BODY/);
    w.document.getElementById('a').remove(); inserted.remove();
    r = read(w, { sections: ['S3'] });
    assert.match(r.text, /S3 Chapter B/);
    assert.match(r.text, /B_BODY/);
  } finally { w.close(); }
});
test('renaming a heading preserves all already opened scopes', () => {
  const w = page(article);
  try {
    read(w, { sections: ['S1', 'S2', 'S4'] });
    w.document.querySelector('h1').textContent = 'Renamed title';
    const r = read(w);
    assert.match(r.text, /LEAD_BODY/);
    assert.match(r.text, /CHAPTER_A_BODY/);
    assert.match(r.text, /CHAPTER_B_BODY/);
    assert.match(r.text, /Renamed title/);
  } finally { w.close(); }
});
test('a replacement heading cannot reuse the old section ID even with the same HTML id and title', () => {
  const w = page('<main><h1>Root</h1><h2 id="a">Chapter A</h2><p>BODY</p></main>');
  try {
    read(w, { sections: ['S1'] });
    const old = w.document.getElementById('a'); old.replaceWith(old.cloneNode(true));
    const r = read(w, { sections: ['S2'] });
    assert.match(r.text, /Unknown sections: S2/);
    assert.match(r.text, /stale|refresh/);
    assert.doesNotMatch(r.text, /BODY/);
  } finally { w.close(); }
});
test('markers remain bound when delta budget has not delivered inserted controls or another reader reads', () => {
  const w = page('<main><h1>Root</h1><p id="body">Original body</p><button id="save">Save</button></main>');
  const cache = createPageFeedback();
  const render = r => cache.render({ ...r, target: { tabId: 7, windowId: 9 } }, { budget: 200 });
  try {
    render(read(w, { reader: 'a', sections: ['S1'] }));
    const save = w.document.getElementById('save'), marker = w.__chromeBridge.markers.indexOf(save);
    const nav = w.document.createElement('button'); nav.textContent = 'Inserted navigation';
    w.document.body.prepend(nav);
    w.document.getElementById('body').textContent = '字'.repeat(1500);
    const pending = render(read(w, { reader: 'a' }));
    assert.match(pending, /More: read_page/);
    assert.doesNotMatch(pending, /Save|Inserted navigation/);
    assert.equal(w.__chromeBridge.markers[marker], save, 'undelivered delta must not retarget an old marker');
    const other = read(w, { reader: 'b', sections: ['S1'] });
    assert.equal(w.__chromeBridge.markers[marker], save, 'all readers share the same node identity');
    assert.match(other.text, new RegExp('\\[' + marker + '\\].*Save'));
  } finally { w.close(); }
});
test('removed controls leave invalid IDs and replacement controls get new IDs; count excludes holes', () => {
  const w = page('<h1>Root</h1><button id="old">Action</button><button id="keep">Keep</button>');
  try {
    read(w, { sections: ['S1'] });
    const old = w.document.getElementById('old'), oldId = w.__chromeBridge.markers.indexOf(old);
    const replacement = old.cloneNode(true); old.replaceWith(replacement);
    let r = read(w);
    assert.equal(w.__chromeBridge.markers[oldId], undefined);
    assert.ok(w.__chromeBridge.markers.indexOf(replacement) > oldId);
    assert.equal(r.count, 2);
    replacement.remove();
    r = read(w); assert.equal(r.count, 1);
  } finally { w.close(); }
});
test('full and query list controls once with icon labels, nested fields, and select state intact', () => {
  const w = page('<h1>Root</h1><button aria-label="Choose icon"></button>' +
    '<label>Choose note <input placeholder="Choose text"></label>' +
    '<select><option>Choose first</option><option selected>Choose second</option><option disabled>Choose unavailable</option></select>');
  try {
    for (const req of [{ full: true }, { query: 'Choose' }]) {
      const r = read(w, req), marks = [...r.text.matchAll(/\[(\d+)\]/g)].map(m => m[1]);
      assert.equal(new Set(marks).size, marks.length, 'a control was listed twice');
      for (const node of w.document.querySelectorAll('button,label,input,select')) {
        const id = w.__chromeBridge.markers.indexOf(node);
        assert.equal(marks.filter(n => Number(n) === id).length, 1, node.outerHTML);
      }
      assert.match(r.text, /button \| Choose icon/);
      assert.match(r.text, /input\[text\] \| Choose text/);
      assert.match(r.text, /select \| Choose second/);
      assert.match(r.text, /Choose second」\[已选\]/);
      assert.match(r.text, /Choose unavailable」\[禁用\]/);
      assert.doesNotMatch(r.text, /可点击元素索引|上面这些段落里的可点击元素|提示：|目录见|换个更具体/);
      assert.equal(r.hint, '');
    }
  } finally { w.close(); }
});
test('full truncation keeps a complete actionable control after a long body', () => {
  const w = page('<h1>Root</h1><p>' + 'Long body text. '.repeat(3000) + '</p>' +
    '<select aria-label="Tail choice"><option>First</option><option selected>Second</option><option disabled>Unavailable</option></select>' +
    '<button aria-label="Tail icon"></button>');
  try {
    const r = read(w, { full: true });
    assert.ok(r.text.length <= 12000);
    assert.match(r.text, /Second」\[已选\]/);
    assert.match(r.text, /Unavailable」\[禁用\]/);
    assert.match(r.text, /button \| Tail icon/);
    assert.equal((r.text.match(/\[1\]/g) || []).length, 1);
    assert.equal((r.text.match(/\[2\]/g) || []).length, 1);
  } finally { w.close(); }
});
test('query beyond the front of a long control label retains its marker and matched context', () => {
  const w = page('<h1>Root</h1><a href="/target">' + 'Prefix '.repeat(100) + 'LATE_MATCH</a>');
  try {
    const r = read(w, { query: 'LATE_MATCH' });
    assert.match(r.text, /LATE_MATCH/);
    assert.equal((r.text.match(/\[1\]/g) || []).length, 1, 'snippet trimming lost or duplicated the target marker');
    assert.match(r.text, /\[1\] a \|/);
  } finally { w.close(); }
});
test('a headingless main has its own folded entry instead of inheriting site navigation headings', () => {
  const w = page('<nav><h2>Navigation A</h2><a href="/a">Nav link A</a><h2>Navigation B</h2><a href="/b">Nav link B</a></nav>' +
    '<main><p>MAIN_BODY</p><button>Main action</button></main><footer>FOOTER_BODY</footer>');
  try {
    const first = read(w);
    assert.equal(first.blocks.length, 1);
    assert.match(first.text, /主体.*\[collapsed\]/);
    assert.doesNotMatch(first.text, /Navigation|Nav link|MAIN_BODY|Main action|FOOTER_BODY/);
    const expanded = read(w, { sections: [first.blocks[0].id] });
    assert.match(expanded.text, /MAIN_BODY/);
    assert.match(expanded.text, /Main action/);
    assert.doesNotMatch(expanded.text, /Navigation|Nav link|FOOTER_BODY/);
  } finally { w.close(); }
});
test('all-headingless native and ARIA articles retain separate folded scopes, including inside main', () => {
  for (const tag of ['article', 'div role="article"']) for (const wrapped of [false, true]) {
    const end = tag.split(' ')[0];
    const articles = `<${tag} aria-label="First"><p>FIRST_BODY</p><button>First action</button></${end}>` +
      `<${tag} aria-label="Second"><p>SECOND_BODY</p><button>Second action</button></${end}>`;
    const w = page(wrapped ? `<main><p>MAIN_INTRO</p>${articles}</main>` : articles);
    try {
      let r = read(w);
      assert.doesNotMatch(r.text, /FIRST_BODY|SECOND_BODY|First action|Second action|MAIN_INTRO/);
      if (wrapped) {
        assert.equal(r.blocks.length, 1, 'main remains the first folded layer');
        r = read(w, { sections: [r.blocks[0].id] });
        assert.match(r.text, /MAIN_INTRO/);
        assert.doesNotMatch(r.text, /FIRST_BODY|SECOND_BODY|First action|Second action/);
      }
      const first = r.blocks.find(b => b.title.includes('First'));
      const second = r.blocks.find(b => b.title.includes('Second'));
      assert.ok(first && second && first.id !== second.id, `${tag}: independent named article scopes`);
      assert.match(first.lines[0], /\[collapsed\]/);
      assert.match(second.lines[0], /\[collapsed\]/);
      const expanded = read(w, { sections: [second.id] });
      assert.match(expanded.text, /SECOND_BODY/);
      assert.match(expanded.text, /Second action/);
      assert.doesNotMatch(expanded.text, /FIRST_BODY|First action/);
    } finally { w.close(); }
  }
});
test('ARIA article headings preserve native article sibling and parent-main boundaries', () => {
  for (const withMainTitle of [false, true]) {
    const w = page((withMainTitle ? '<main><h1>Page title</h1><p>PAGE_INTRO</p>' : '') +
      '<div role="article"><h1>First</h1><p>FIRST_BODY</p></div>' +
      '<div role="article"><h2>Second</h2><p>SECOND_BODY</p><h3>Detail</h3><p>DETAIL_BODY</p></div>' +
      '<div role="article" aria-label="Third"><p>THIRD_BODY</p></div>' + (withMainTitle ? '</main>' : ''));
    try {
      let r = read(w);
      if (withMainTitle) {
        assert.equal(r.blocks.length, 1);
        assert.match(r.text, /Page title/);
        assert.doesNotMatch(r.text, /First|Second|Third|PAGE_INTRO/);
        r = read(w, { sections: [r.blocks[0].id] });
        assert.match(r.text, /PAGE_INTRO/);
      }
      for (const title of ['First', 'Second', 'Third']) assert.ok(r.blocks.some(b => b.title.endsWith(title)), `${title} is a sibling scope`);
      assert.doesNotMatch(r.text, /FIRST_BODY|SECOND_BODY|THIRD_BODY|Detail|DETAIL_BODY/);
      const second = r.blocks.find(b => b.title.endsWith('Second'));
      r = read(w, { sections: [second.id] });
      assert.match(r.text, /SECOND_BODY/);
      assert.match(r.text, /Detail \[collapsed\]/);
      assert.doesNotMatch(r.text, /FIRST_BODY|THIRD_BODY|DETAIL_BODY/);
      const query = read(w, { sections: [second.id], query: 'BODY' });
      assert.match(query.text, /SECOND_BODY/);
      assert.match(query.text, /DETAIL_BODY/);
      assert.doesNotMatch(query.text, /FIRST_BODY|THIRD_BODY/);
    } finally { w.close(); }
  }
});
test('sibling article roots stay discoverable and do not nest by unrelated heading levels', () => {
  const w = page('<article><h1>First article</h1><p>FIRST_BODY</p></article>' +
    '<article><h2>Second article</h2><p>SECOND_BODY</p><h3>Second detail</h3><p>DETAIL_BODY</p><button>Detail action</button></article>' +
    '<article aria-label="Third article"><p>THIRD_BODY</p></article>');
  try {
    const first = read(w);
    assert.match(first.text, /S1 First article.*\[collapsed\]/);
    assert.match(first.text, /S2 Second article.*\[collapsed\]/);
    assert.match(first.text, /S4 Third article.*\[collapsed\]/);
    assert.doesNotMatch(first.text, /FIRST_BODY|SECOND_BODY|Second detail|DETAIL_BODY|THIRD_BODY/);
    const second = read(w, { sections: ['S2'] });
    assert.match(second.text, /SECOND_BODY/);
    assert.match(second.text, /S3 Second detail/);
    assert.doesNotMatch(second.text, /FIRST_BODY|DETAIL_BODY|Detail action/);
    const detail = read(w, { sections: ['S3'] });
    assert.match(detail.text, /DETAIL_BODY/);
    assert.match(detail.text, /Detail action/);
    assert.match(read(w, { sections: ['S4'] }).text, /THIRD_BODY/);
  } finally { w.close(); }
});
test('articles inside a main wrapper remain sibling scopes, including a headingless article', () => {
  const w = page('<main><article><h1>First</h1><p>FIRST_BODY</p></article>' +
    '<article><h2>Second</h2><p>SECOND_BODY</p></article>' +
    '<article aria-label="Third"><p>THIRD_BODY</p><button>Third action</button></article></main>');
  try {
    const first = read(w);
    assert.deepEqual(first.blocks.map(b => b.id), ['S1', 'S2', 'S3']);
    for (const title of ['First', 'Second', 'Third']) assert.match(first.text, new RegExp(title + ' \\[collapsed\\]'));
    assert.doesNotMatch(first.text, /FIRST_BODY|SECOND_BODY|THIRD_BODY|Third action/);
    const second = read(w, { sections: ['S2'] });
    assert.match(second.text, /SECOND_BODY/);
    assert.doesNotMatch(second.text, /FIRST_BODY|THIRD_BODY|Third action/);
    const third = read(w, { sections: ['S3'] });
    assert.match(third.text, /THIRD_BODY/);
    assert.match(third.text, /Third action/);
  } finally { w.close(); }
});
test('a main title keeps article roots as children and real article subheadings remain nested', () => {
  const w = page('<main><h1>Page title</h1><p>PAGE_INTRO</p>' +
    '<article><h2>First</h2><p>FIRST_BODY</p><h3>First detail</h3><p>DETAIL_BODY</p></article>' +
    '<article><h2>Second</h2><p>SECOND_BODY</p></article>' +
    '<article aria-label="Third"><p>THIRD_BODY</p></article></main>');
  try {
    assert.deepEqual(read(w).blocks.map(b => b.id), ['S1']);
    const root = read(w, { sections: ['S1'] });
    assert.deepEqual(root.blocks.map(b => b.id), ['S1', 'S2', 'S4', 'S5']);
    assert.match(root.text, /PAGE_INTRO/);
    assert.doesNotMatch(root.text, /FIRST_BODY|SECOND_BODY|THIRD_BODY|First detail|DETAIL_BODY/);
    const first = read(w, { sections: ['S2'] });
    assert.match(first.text, /FIRST_BODY/);
    assert.match(first.text, /S3 First detail \[collapsed\]/);
    assert.doesNotMatch(first.text, /DETAIL_BODY|SECOND_BODY|THIRD_BODY/);
    const second = read(w, { sections: ['S4'] });
    assert.match(second.text, /SECOND_BODY/);
    assert.doesNotMatch(second.text, /THIRD_BODY/);
    const query = read(w, { sections: ['S2'], query: 'BODY' });
    assert.match(query.text, /FIRST_BODY/);
    assert.match(query.text, /DETAIL_BODY/);
    assert.doesNotMatch(query.text, /SECOND_BODY|THIRD_BODY/);
  } finally { w.close(); }
});
test('long control continuations and late option changes identify the same select without repeating it whole', () => {
  const options = Array.from({ length: 30 }, (_, i) => `<option>Repeated option label ${i}</option>`).join('');
  const w = page(`<h1>Root</h1><select id="first">${options}</select><select id="second">${options}</select>`);
  const cache = createPageFeedback();
  const render = (req = {}, budget = 200) => cache.render({ ...read(w, req), target: { tabId: 7, windowId: 9 } }, { budget });
  try {
    let reply = render({ sections: ['S1'] }), attempts = 0;
    while (reply !== 'tab=7 unchanged' && attempts++ < 30) {
      assert.ok(textTokens(reply) <= 200, reply);
      if (/Repeated option/.test(reply)) assert.match(reply, /\[(?:1|2)\] select/, reply);
      const marks = [...reply.matchAll(/\[(\d+)\]/g)].map(m => m[1]);
      assert.equal(new Set(marks).size, marks.length, 'each control should be identified only once in a reply');
      reply = render();
    }
    assert.equal(reply, 'tab=7 unchanged');
    w.document.querySelector('#second option:last-child').disabled = true;
    const delta = render({}, 2500);
    assert.match(delta, /\[2\] select/);
    assert.match(delta, /label 29」\[禁用\]/);
    assert.doesNotMatch(delta, /\[1\]|label 0」|label 1」/, 'a tail-only change must not repeat the whole control');
    assert.equal(render(), 'tab=7 unchanged');
  } finally { w.close(); }
});
test('closing a partly delivered modal discards its pending text and keeps the main scope and marker', () => {
  const w = page('<main><h1>Root</h1><p>MAIN_BODY</p><button id="main">Main action</button></main>');
  const cache = createPageFeedback();
  const render = req => cache.render({ ...read(w, req), target: { tabId: 7, windowId: 9 } }, { budget: 200 });
  try {
    render({ sections: ['S1'] });
    const main = w.document.getElementById('main'), marker = w.__chromeBridge.markers.indexOf(main);
    const modal = w.document.createElement('dialog'); modal.setAttribute('open', '');
    modal.innerHTML = '<h2>Transient dialog</h2><p>' + 'PENDING_MODAL_BODY '.repeat(120) + '</p><button>Close dialog</button>';
    w.document.body.append(modal);
    const partial = render({});
    assert.match(partial, /More: read_page/);
    assert.match(partial, /Transient dialog/);
    modal.remove();
    const closed = render({});
    assert.match(closed, /Removed: Dialog: Transient dialog/);
    assert.doesNotMatch(closed, /PENDING_MODAL_BODY|Close dialog|More: read_page/);
    assert.equal(render({}), 'tab=7 unchanged');
    assert.match(read(w).text, /MAIN_BODY/);
    assert.equal(w.__chromeBridge.markers[marker], main);
  } finally { w.close(); }
});
test('query with a stale section refuses scope expansion to the whole page', () => {
  const w = page('<h1>Root</h1><h2 id="section">Chapter</h2><p>PRIVATE_OTHER_SCOPE_MATCH</p>');
  try {
    read(w, { sections: ['S1'] });
    const old = w.document.getElementById('section'); old.replaceWith(old.cloneNode(true));
    const r = read(w, { sections: ['S2'], query: 'PRIVATE_OTHER_SCOPE_MATCH' });
    assert.match(r.text, /Unknown sections: S2/);
    assert.doesNotMatch(r.text, /找到 1|PRIVATE_OTHER_SCOPE_MATCH/);
  } finally { w.close(); }
});
console.log(`${passed} hierarchy groups passed`);
