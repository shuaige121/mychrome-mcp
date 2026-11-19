import assert from 'node:assert/strict';
const mod = await import('../src/page-feedback.js').catch(() => ({}));
assert.equal(typeof mod.createPageFeedback, 'function', 'page reads need a bounded per-document feedback cache');
const { createPageFeedback, textTokens } = mod;
let passed = 0;
function test(name, fn) { fn(); console.log(`ok ${++passed} ${name}`); }
const result = (lines, extra = {}) => ({ documentKey: 'doc-a', target: { tabId: 5, windowId: 7 }, url: 'https://example.test/article', title: 'Article', blocks: [{ id: 'S1', title: 'S1 Article', lines }], ...extra });
test('unchanged expanded content returns one short line', () => {
  const cache = createPageFeedback();
  assert.match(cache.render(result(['S1 Article', 'Visible paragraph'])), /Visible paragraph/);
  const second = cache.render(result(['S1 Article', 'Visible paragraph']));
  assert.equal(second, 'tab=5 unchanged');
});
test('only changed lines of observed scopes are repeated, with section context', () => {
  const cache = createPageFeedback();
  cache.render(result(['S1 Article', 'Stable paragraph', '[3] button | Save']));
  const changed = cache.render(result(['S1 Article', 'Stable paragraph', '[3] button | Saved']));
  assert.match(changed, /S1 Article/);
  assert.match(changed, /\[3\].*Saved/);
  assert.doesNotMatch(changed, /Stable paragraph|button \| Save\n/);
  assert.equal((changed.match(/\[3\]/g) || []).length, 1);
});
test('prepending body text does not resend delivered lines by their shifted positions', () => {
  const cache = createPageFeedback();
  cache.render(result(['S1 Article', 'OLD_A', 'OLD_B', 'OLD_C']));
  const next = result(['S1 Article', 'NEW', 'OLD_A', 'OLD_B', 'OLD_C']);
  const changed = cache.render(next);
  assert.match(changed, /^NEW$/m);
  assert.doesNotMatch(changed, /OLD_A|OLD_B|OLD_C|Removed:/);
  assert.equal(cache.render(next), 'tab=5 unchanged');
});
test('swapped price associations resend the current block order instead of claiming unchanged', () => {
  const cache = createPageFeedback();
  const prices = lines => result([], { blocks: [{ id: 'S1', title: 'S1 Prices', lines }] });
  cache.render(prices(['S1 Prices', 'Product A', '10', 'Product B', '20']));
  const next = prices(['S1 Prices', 'Product A', '20', 'Product B', '10']);
  const changed = cache.render(next);
  assert.match(changed, /Order changed: S1 Prices/);
  assert.match(changed, /Product A\n20\nProduct B\n10/);
  assert.equal(cache.render(next), 'tab=5 unchanged');
});
test('pure reordering replays only the affected block in its current order', () => {
  const cache = createPageFeedback();
  const payload = lines => result([], { blocks: [
    { id: 'S1', title: 'S1 Article', lines },
    { id: 'S2', title: 'S2 Other', lines: ['S2 Other', 'UNCHANGED_OTHER_BLOCK'] }
  ] });
  cache.render(payload(['S1 Article', 'A', 'B', 'C']));
  const next = payload(['S1 Article', 'C', 'A', 'B']);
  const changed = cache.render(next);
  assert.match(changed, /Order changed: S1 Article/);
  assert.match(changed, /S1 Article\nC\nA\nB/);
  assert.doesNotMatch(changed, /S2 Other|UNCHANGED_OTHER_BLOCK|Removed:/);
  assert.equal(cache.render(next), 'tab=5 unchanged');
});
test('swapping sections reports their current order without repeating unchanged bodies', () => {
  const cache = createPageFeedback();
  const a = { id: 'S1', title: 'S1 Alpha', lines: ['S1 Alpha', 'OLD_ALPHA_BODY'] };
  const b = { id: 'S2', title: 'S2 Beta', lines: ['S2 Beta', 'OLD_BETA_BODY'] };
  cache.render(result([], { blocks: [a, b] }));
  const next = result([], { blocks: [b, a] });
  const changed = cache.render(next);
  assert.match(changed, /Section order changed/);
  assert.match(changed, /S2 Beta\nS1 Alpha/);
  assert.doesNotMatch(changed, /OLD_ALPHA_BODY|OLD_BETA_BODY|Removed:/);
  assert.equal(cache.render(next), 'tab=5 unchanged');
});
test('prepending a new section does not replay the existing sections or their order', () => {
  const cache = createPageFeedback();
  const a = { id: 'S1', title: 'S1 Alpha', lines: ['S1 Alpha', 'OLD_ALPHA_BODY'] };
  const b = { id: 'S2', title: 'S2 Beta', lines: ['S2 Beta', 'OLD_BETA_BODY'] };
  cache.render(result([], { blocks: [a, b] }));
  const next = result([], { blocks: [{ id: 'S3', title: 'S3 New', lines: ['S3 New', 'NEW_SECTION_BODY'] }, a, b] });
  const changed = cache.render(next);
  assert.match(changed, /NEW_SECTION_BODY/);
  assert.doesNotMatch(changed, /Section order|OLD_ALPHA_BODY|OLD_BETA_BODY|S1 Alpha|S2 Beta|Removed:/);
  assert.equal(cache.render(next), 'tab=5 unchanged');
});
test('long reordered section lists continue within budget in the new order without restarting', () => {
  const cache = createPageFeedback();
  const blocks = Array.from({ length: 30 }, (_, i) => ({ id: `S${i + 1}`,
    title: `S${i + 1} Section_${i + 1} ` + '节'.repeat(60),
    lines: [`S${i + 1} Section_${i + 1}`, `OLD_BODY_${i + 1}`] }));
  cache.render(result([], { blocks }), { budget: 20000 });
  const next = result([], { blocks: blocks.toReversed() });
  const outputs = [];
  for (let i = 0; i < 30; i++) {
    const out = cache.render(next, { budget: 200 });
    assert.ok(textTokens(out) <= 200);
    assert.doesNotMatch(out, /OLD_BODY_|Removed:/);
    outputs.push(out);
    if (!/More:/.test(out)) break;
  }
  const joined = outputs.join('\n');
  assert.deepEqual([...joined.matchAll(/^S(\d+) Section_/gm)].map(m => Number(m[1])),
    Array.from({ length: 30 }, (_, i) => 30 - i));
  assert.equal((joined.match(/Section order changed/g) || []).length, 1);
  assert.equal(cache.render(next, { budget: 200 }), 'tab=5 unchanged');
});
test('inserting equal values does not mistake unchanged existing order for a reorder', () => {
  const cache = createPageFeedback();
  cache.render(result(['S1 Article', 'Product A', '10', 'Product B', '10']));
  const next = result(['S1 Article', 'NEW', '10', 'Product A', '10', 'Product B', '10']);
  const changed = cache.render(next);
  assert.match(changed, /^NEW$/m);
  assert.equal((changed.match(/^10$/gm) || []).length, 1);
  assert.doesNotMatch(changed, /Order changed:|Product A|Product B|Removed:/);
  assert.equal(cache.render(next), 'tab=5 unchanged');
});
test('a reordered long block continues within budget without resetting or repeating delivered rows', () => {
  const cache = createPageFeedback();
  const body = Array.from({ length: 24 }, (_, i) => `ORDER_${i} ` + '字'.repeat(70));
  cache.render(result(['S1 Article', ...body]), { budget: 20000 });
  const next = result(['S1 Article', ...body.toReversed()]);
  const outputs = [];
  for (let i = 0; i < 30; i++) {
    const out = cache.render(next, { budget: 200 });
    assert.ok(textTokens(out) <= 200);
    assert.doesNotMatch(out, /Removed:/);
    outputs.push(out);
    if (!/More:/.test(out)) break;
  }
  const joined = outputs.join('\n');
  assert.equal((joined.match(/Order changed:/g) || []).length, 1);
  assert.deepEqual([...joined.matchAll(/ORDER_(\d+) /g)].map(m => Number(m[1])),
    Array.from({ length: 24 }, (_, i) => 23 - i));
  assert.equal(cache.render(next, { budget: 200 }), 'tab=5 unchanged');
});
test('an order replay deferred by budget does not erase delivered removal evidence', () => {
  const cache = createPageFeedback();
  const article = lines => ({ id: 'S1', title: 'S1 Article', lines });
  const prices = lines => ({ id: 'S2', title: 'S2 Prices', lines });
  cache.render(result([], { blocks: [article(['S1 Article']),
    prices(['S2 Prices', 'Product A', '10', 'Product B', '20'])] }));
  const expanded = article(['S1 Article', '字'.repeat(350)]);
  const deferred = cache.render(result([], { blocks: [expanded,
    prices(['S2 Prices', 'Product A', '20', 'Product B', '10'])] }), { budget: 200 });
  assert.match(deferred, /More:/);
  assert.doesNotMatch(deferred, /Order changed: S2 Prices/);
  const removed = cache.render(result([], { blocks: [expanded] }), { budget: 200 });
  assert.match(removed, /Removed: S2 Prices/);
  assert.ok(textTokens(removed) <= 200);
});
test('body insertion and deletion retain stable content while reporting the actual removal once', () => {
  const cache = createPageFeedback();
  cache.render(result(['S1 Article', 'OLD_A', 'OLD_B', 'OLD_C']));
  const next = result(['S1 Article', 'OLD_A', 'NEW', 'OLD_C']);
  const changed = cache.render(next);
  assert.match(changed, /^NEW$/m);
  assert.match(changed, /Removed: S1 Article \(1 line fragment\)/);
  assert.doesNotMatch(changed, /OLD_A|OLD_B|OLD_C/);
  assert.equal(cache.render(next), 'tab=5 unchanged');
});
test('equal real lines retain multiplicity when added or removed', () => {
  const cache = createPageFeedback();
  const count = out => (out.match(/^REPEATED$/gm) || []).length;
  assert.equal(count(cache.render(result(['S1 Article', 'REPEATED', 'REPEATED']))), 2);
  assert.equal(count(cache.render(result(['S1 Article', 'REPEATED', 'REPEATED', 'REPEATED']))), 1);
  const next = result(['S1 Article', 'REPEATED']);
  const removed = cache.render(next);
  assert.match(removed, /Removed: S1 Article \(2 line fragments\)/);
  assert.equal(count(removed), 0);
  assert.equal(cache.render(next), 'tab=5 unchanged');
});
test('a new long line sharing old fragments is delivered in its own order', () => {
  const cache = createPageFeedback();
  const common = 'SHARED_START ' + '字'.repeat(180);
  cache.render(result(['S1 Article', common + 'OLD_A', common + 'OLD_B']), { budget: 20000 });
  const next = result(['S1 Article', common + 'NEW_C', common + 'OLD_A', common + 'OLD_B']);
  const changed = cache.render(next, { budget: 20000 });
  assert.ok(changed.indexOf('SHARED_START') >= 0 && changed.indexOf('SHARED_START') < changed.indexOf('NEW_C'));
  assert.equal((changed.match(/SHARED_START/g) || []).length, 1);
  assert.equal((changed.match(/字/g) || []).length, 180);
  assert.doesNotMatch(changed, /OLD_A|OLD_B|Removed:/);
  assert.equal(cache.render(next), 'tab=5 unchanged');
});
test('prepending during budget continuation sends every retained row exactly once and never remembers undelivered rows', () => {
  const cache = createPageFeedback();
  const old = Array.from({ length: 10 }, (_, i) => `PENDING_${i} ` + '字'.repeat(60));
  const first = cache.render(result(['S1 Article', ...old]), { budget: 200 });
  assert.match(first, /More:/);
  assert.doesNotMatch(first, /PENDING_9/);
  const next = result(['S1 Article', 'NEW', ...old.slice(0, 9)]);
  const outputs = [first];
  for (let i = 0; i < 20; i++) {
    const out = cache.render(next, { budget: 200 });
    assert.ok(textTokens(out) <= 200);
    assert.doesNotMatch(out, /Removed:|PENDING_9/);
    outputs.push(out);
    if (!/More:/.test(out)) break;
  }
  const joined = outputs.join('\n');
  assert.equal((joined.match(/^NEW$/gm) || []).length, 1);
  for (let i = 0; i < 9; i++) assert.equal((joined.match(new RegExp(`PENDING_${i} `, 'g')) || []).length, 1);
  assert.equal(cache.render(next, { budget: 200 }), 'tab=5 unchanged');
});
test('moving a long control keeps its fragment identity while reporting late changes and new body text', () => {
  const cache = createPageFeedback();
  const control = '[8] select | EARLY_OPTIONS ' + '字'.repeat(780);
  const before = result([], { blocks: [{ id: 'S1', title: 'S1 Article',
    lines: ['S1 Article', control + 'OLD_TAIL'], lineTargets: { 1: '[8] select' } }] });
  cache.render(before, { budget: 20000 });
  const after = result([], { blocks: [{ id: 'S1', title: 'S1 Article',
    lines: ['S1 Article', 'NEW', control + 'NEW_TAIL'], lineTargets: { 2: '[8] select' } }] });
  const changed = cache.render(after, { budget: 20000 });
  assert.match(changed, /^NEW$/m);
  assert.match(changed, /\[8\] select \(continued\)/);
  assert.match(changed, /NEW_TAIL/);
  assert.doesNotMatch(changed, /EARLY_OPTIONS|OLD_TAIL|Removed:/);
  assert.equal(cache.render(after), 'tab=5 unchanged');
});
test('new document or navigation invalidates the snapshot even for identical text', () => {
  const cache = createPageFeedback();
  cache.render(result(['S1 Article']));
  assert.match(cache.render(result(['S1 Article'], { documentKey: 'doc-b' })), /S1 Article/);
  assert.match(cache.render(result(['S1 Article'], { documentKey: 'doc-b', url: 'https://example.test/next' })), /S1 Article/);
});
test('budgets keep DOM content available and repeated reads continue pending lines', () => {
  const cache = createPageFeedback();
  const lines = ['S1 Article', ...Array.from({ length: 18 }, (_, i) => `row-${i} ` + '字'.repeat(90))];
  const res = result(lines);
  let out = cache.render(res, { budget: 1200 });
  assert.ok(textTokens(out) <= 1200, `${textTokens(out)} tokens`);
  assert.match(out, /More: read_page\(\)/);
  let joined = out;
  for (let i = 0; i < 10 && /More:/.test(out); i++) {
    out = cache.render(res, { budget: 1200 });
    assert.ok(textTokens(out) <= 1200);
    joined += '\n' + out;
  }
  for (let i = 0; i < 18; i++) assert.match(joined, new RegExp(`row-${i} `));
  assert.equal(cache.render(res, { budget: 1200 }), 'tab=5 unchanged');
});
test('a single long body line continues within the minimum 200-token budget', () => {
  const cache = createPageFeedback();
  const res = result(['S1 Article', '字'.repeat(1500) + 'THE_END']);
  let out = '', joined = '';
  for (let i = 0; i < 30; i++) {
    out = cache.render(res, { budget: 200 });
    assert.ok(textTokens(out) <= 200);
    joined += out;
    if (!/More:/.test(out)) break;
  }
  assert.match(joined, /THE_END/);
  assert.equal(cache.render(res, { budget: 200 }), 'tab=5 unchanged');
});
test('removed blocks are reported once and another tab has an independent snapshot', () => {
  const cache = createPageFeedback();
  cache.render(result(['S1 Article', 'First']));
  const removed = cache.render(result(['S1 Article']));
  assert.match(removed, /Removed: S1 Article/);
  assert.doesNotMatch(removed, /First/);
  assert.equal(cache.render(result(['S1 Article'])), 'tab=5 unchanged');
  assert.match(cache.render(result(['S1 Article'], { target: { tabId: 6, windowId: 7 } })), /S1 Article/);
});
test('refresh clears only the selected tab baseline for a caller missing prior context', () => {
  const cache = createPageFeedback();
  const one = result(['S1 Article']);
  const two = result(['S1 Article'], { target: { tabId: 6, windowId: 7 } });
  cache.render(one); cache.render(two);
  cache.clear(one.target);
  assert.match(cache.render(one), /S1 Article/);
  assert.equal(cache.render(two), 'tab=6 unchanged');
});
test('removed section titles remain budgeted and continue without repeating old content', () => {
  const cache = createPageFeedback();
  const blocks = Array.from({ length: 30 }, (_, i) => ({ id: `S${i}`, title: `S${i} Removed section ${i}`, lines: [`S${i} Removed section ${i}`, `OLD_CONTENT_${i}`] }));
  cache.render(result([], { blocks }), { budget: 20000 });
  const after = result([], { blocks: [] });
  let joined = '';
  for (let i = 0; i < 30; i++) {
    const out = cache.render(after, { budget: 200 });
    assert.ok(textTokens(out) <= 200);
    assert.doesNotMatch(out, /OLD_CONTENT_/);
    joined += out + '\n';
    if (!/More:/.test(out)) break;
  }
  for (const block of blocks) assert.ok(joined.includes(`Removed: ${block.title} (`));
  assert.equal(cache.render(after), 'tab=5 unchanged');
});
test('cache eviction and TTL cannot return an unobserved unchanged result', () => {
  let now = 100;
  const cache = createPageFeedback({ maxEntries: 1, ttlMs: 10, now: () => now });
  cache.render(result(['S1 Article']));
  cache.render(result(['S1 Article'], { target: { tabId: 6, windowId: 7 } }));
  assert.match(cache.render(result(['S1 Article'])), /S1 Article/);
  now += 20;
  assert.match(cache.render(result(['S1 Article'])), /S1 Article/);
});
test('C7: a long row is split between words; only a token longer than a row is split inside, ending with …', () => {
  const cache = createPageFeedback();
  const option = '[8] select | Pick one\n    选项（共 3 个）：' + Array.from({ length: 3 }, (_, i) =>
    `「Answer ${i}: the storms at sea would calm down again one day, and everybody went home happily」`).join(' ');
  const token = 'TOKEN' + 'x9'.repeat(200);
  const out = cache.render(result([], { blocks: [{ id: 'S1', title: 'S1 Article',
    lines: ['S1 Article', option, `see ${token} end`], lineTargets: { 1: '[8] select' } }] }), { budget: 20000 });
  const rows = out.split('\n').slice(1).filter(row => row !== 'S1 Article');
  // The option rows put back together are the original line; no row starts or ends inside a word.
  const optionRows = rows.slice(0, rows.findIndex(row => row.startsWith('see ')));
  assert.ok(optionRows.length > 1, out);
  assert.equal(optionRows.join('\n').replace('\n    选项', '\u0000').split('\n').join('').replace('\u0000', '\n    选项'), option);
  for (let i = 1; i < optionRows.length; i++) {
    assert.ok(!/[A-Za-z0-9]$/.test(optionRows[i - 1]) || !/^[A-Za-z0-9]/.test(optionRows[i]), `split inside a word: «${optionRows[i - 1].slice(-12)}|${optionRows[i].slice(0, 12)}»`);
  }
  // The over-long token starts its own row and every row that cuts it ends with ….
  const tokenRows = rows.slice(rows.findIndex(row => row.startsWith('see ')));
  assert.equal(tokenRows[0], 'see ');
  assert.ok(tokenRows.length > 2 && tokenRows.slice(1, -1).every(row => row.endsWith('…')), JSON.stringify(tokenRows));
  assert.equal(tokenRows.map(row => row.replace(/…$/, '')).join(''), `see ${token} end`);
});
console.log(`${passed} feedback groups passed`);
