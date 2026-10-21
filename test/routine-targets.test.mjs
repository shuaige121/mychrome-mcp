/* Real injected read/routine scripts on synthetic jsdom pages. Geometry only
 * is stubbed; no browser, credentials, runtime settings or native input. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const read = await readFile(new URL('../src/page/read.js', import.meta.url), 'utf8');
const routine = await readFile(new URL('../src/page/routine.js', import.meta.url), 'utf8');
const queryHash = (search = '', routeQuery = '') => createHash('sha256').update(JSON.stringify([search, routeQuery])).digest('hex');
const sha256Source = routine.slice(routine.indexOf('function sha256(input)'), routine.indexOf('function queryIdentity('));
const sha256 = Function(`${sha256Source}; return sha256;`)();
function page(html, url = 'https://fixture.test/courses?tracking=ignored#/list?sort=asc') {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () {
    const zero = this.getAttribute('data-zero') === 'yes';
    return { x: 10, y: 10, left: 10, top: 10, width: zero ? 0 : 120, height: zero ? 0 : 24, right: 130, bottom: 34 };
  };
  w.Element.prototype.getClientRects = function () { const r = this.getBoundingClientRect(); return r.width ? [r] : []; };
  function refresh() { return JSON.parse(w.eval(read.replaceAll('__READ__', () => JSON.stringify({ full: true })))); }
  function run(request) { return JSON.parse(w.eval(routine.replaceAll('__ROUTINE__', () => JSON.stringify(request)))); }
  function marker(selector) { return w.__chromeBridge.markers.indexOf(w.document.querySelector(selector)); }
  refresh();
  return { w, run, refresh, marker, close: () => w.close() };
}
async function fixture(html, run, url) { const p = page(html, url); try { await run(p); } finally { p.close(); } }

test('the injected SHA-256 implementation matches standard and Unicode vectors', () => {
  for (const input of ['', 'abc', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '中文 😀', 'a'.repeat(10000)]) {
    assert.equal(sha256(input), createHash('sha256').update(input).digest('hex'));
  }
});

test('state strips query/hash parameters and exposes a small public heading/modal view', () => fixture(
  '<h1>Courses</h1><h2>Practice</h2><dialog open aria-label="Choose a course"><input value="private-field-value"></dialog>',
  p => {
    const result = p.run({ mode: 'state' });
    assert.deepEqual(result.page, { origin: 'https://fixture.test', path: '/courses#/list', queryHash: queryHash('?tracking=ignored', '?sort=asc') });
    assert.deepEqual(result.view, [{ role: 'heading', name: 'Courses' }, { role: 'heading', name: 'Practice' }, { role: 'dialog', name: 'Choose a course' }]);
    assert.equal(result.replayable, true);
    assert.doesNotMatch(JSON.stringify(result), /tracking|sort|private-field-value/);
  }));

test('capture uses static accessible labels and returns descriptor, never the bridge target slot', () => fixture(
  '<label for="search">Course search</label><input id="search" data-testid="course-search" placeholder="Fallback" value="typed private words">', p => {
    const result = p.run({ mode: 'capture', marker: p.marker('#search') });
    assert.equal(result.ok, true); assert.equal(result.replayable, true); assert.equal(result.sensitive, false);
    assert.deepEqual(result.descriptor, { version: 1, tag: 'input', role: 'textbox', name: 'Course search', type: 'text', id: 'search', testId: 'course-search' });
    assert.deepEqual(result.targetState, { disabled: false, focused: false });
    assert.equal('target' in result, false); assert.equal('marker' in result, false);
    assert.doesNotMatch(JSON.stringify(result), /typed private words|value|coordinates/);
  }));

test('resolve finds a fresh marker after document order changes', () => fixture('<button id="continue">Continue</button>', p => {
  const captured = p.run({ mode: 'capture', marker: 1 });
  p.w.document.body.insertAdjacentHTML('afterbegin', '<button>New unrelated action</button>'); p.refresh();
  const result = p.run({ mode: 'resolve', target: captured.descriptor });
  assert.equal(result.ok, true); assert.equal(result.marker, 2);
  assert.deepEqual(result.descriptor, captured.descriptor);
}));

test('duplicate labels are ambiguous without a stable identity; IDs disambiguate', () => fixture(
  '<button>Continue</button><button>Continue</button><button id="named">Continue</button>', p => {
    const duplicate = p.run({ mode: 'capture', marker: 1 });
    assert.equal(duplicate.replayable, false); assert.equal(duplicate.reason, 'target_ambiguous');
    assert.equal(p.run({ mode: 'resolve', target: duplicate.descriptor }).reason, 'target_ambiguous');
    const unique = p.run({ mode: 'capture', marker: p.marker('#named') });
    assert.equal(unique.replayable, true);
    assert.equal(p.run({ mode: 'resolve', target: unique.descriptor }).marker, 3);
  }));

test('same-name navigation uses exact sanitized href and query fingerprints', () => fixture(
  '<a href="/course/alpha">Open</a><a href="/course/beta">Open</a><a href="/results?view=a">Results</a><a href="/results?view=b">Results</a>', p => {
    const beta = p.run({ mode: 'capture', marker: 2 });
    assert.equal(beta.descriptor.href, 'https://fixture.test/course/beta');
    assert.equal(p.run({ mode: 'resolve', target: beta.descriptor }).marker, 2);
    const query = p.run({ mode: 'capture', marker: 3 });
    assert.equal(query.replayable, true); assert.equal(query.descriptor.hrefQueryHash, queryHash('?view=a'));
    assert.equal(p.run({ mode: 'resolve', target: query.descriptor }).marker, 3);
    assert.doesNotMatch(JSON.stringify(query), /view=a/);
  }));

test('a query-based destination cannot silently become another same-name course', () => fixture('<a href="/course?id=alpha">Open course</a>', p => {
  const capture = p.run({ mode: 'capture', marker: 1 });
  assert.equal(capture.replayable, true); assert.equal(capture.descriptor.hrefQueryHash, queryHash('?id=alpha'));
  assert.doesNotMatch(JSON.stringify(capture), /alpha|\?id/);
  p.w.document.querySelector('a').setAttribute('href', '/course?id=beta'); p.refresh();
  assert.equal(p.run({ mode: 'resolve', target: capture.descriptor }).reason, 'target_missing');
}));

for (const search of ['?id=123456789012345', '?q=%E4%B8%AD%E6%96%87', '?id=one&id=two', '?q=' + 'a'.repeat(1200)]) {
  test('query SHA-256 agrees with node crypto without leaking query text: ' + search.slice(0, 28), () => fixture('<button>Go</button>', p => {
    const result = p.run({ mode: 'state' });
    assert.equal(result.replayable, true);
    assert.equal(result.page.queryHash, queryHash(search));
    assert.doesNotMatch(JSON.stringify(result), /123456789012345|%E4%B8%AD|id=one|aaaa/);
  }, 'https://fixture.test/course' + search));
}

test('query fingerprints distinguish main query from hash-route query and preserve exact ordering', () => fixture('<a href="/course?view=a#/list?sort=b">Open</a>', p => {
  const captured = p.run({ mode: 'capture', marker: 1 });
  assert.equal(captured.descriptor.href, 'https://fixture.test/course#/list');
  assert.equal(captured.descriptor.hrefQueryHash, queryHash('?view=a', '?sort=b'));
  p.w.document.querySelector('a').setAttribute('href', '/course?sort=b#/list?view=a'); p.refresh();
  assert.equal(p.run({ mode: 'resolve', target: captured.descriptor }).reason, 'target_missing');
}));

test('queryless and queried links cannot match each other, and identical query links remain ambiguous', () => fixture('<a href="/course">Open</a>', p => {
  const captured = p.run({ mode: 'capture', marker: 1 });
  p.w.document.querySelector('a').setAttribute('href', '/course?id=one'); p.refresh();
  assert.equal(p.run({ mode: 'resolve', target: captured.descriptor }).reason, 'target_missing');
  const queried = p.run({ mode: 'capture', marker: 1 });
  p.w.document.body.insertAdjacentHTML('beforeend', '<a href="/course?id=one">Open</a>'); p.refresh();
  assert.equal(p.run({ mode: 'resolve', target: queried.descriptor }).reason, 'target_ambiguous');
}));

test('sensitive link queries and oversized query strings produce no fingerprint', () => fixture('<a href="/course?sessionId=synthetic-private-session">Open</a>', p => {
  const captured = p.run({ mode: 'capture', marker: 1 });
  assert.equal(captured.reason, 'unsafe_link'); assert.equal('hrefQueryHash' in captured.descriptor, false);
  assert.doesNotMatch(JSON.stringify(captured), /synthetic-private-session/);
  p.w.document.querySelector('a').setAttribute('href', '/course?q=' + 'x'.repeat(8192)); p.refresh();
  const huge = p.run({ mode: 'capture', marker: 1 });
  assert.equal(huge.reason, 'unsafe_link'); assert.equal('hrefQueryHash' in huge.descriptor, false);
}));

test('no query means no fingerprint and ordinary fragment links remain unsupported', () => fixture('<a href="/course#section-a">Open</a>', p => {
  assert.equal('queryHash' in p.run({ mode: 'state' }).page, false);
  assert.equal(p.run({ mode: 'capture', marker: 1 }).reason, 'unsafe_link');
}, 'https://fixture.test/course'));

test('failure error preserves its reason through evalInPage BridgeError mapping', () => fixture('<button>Go</button>', p => {
  const result = p.run({ mode: 'capture', marker: 999 });
  assert.equal(result.ok, false); assert.equal(result.error, 'target_missing'); assert.equal(result.reason, result.error);
}));

test('associated credential labels are sensitive even when the field is an ordinary text input', () => fixture('<label for="credential">One time passcode</label><input id="credential">', p => {
  assert.equal(p.run({ mode: 'capture', marker: p.marker('#credential') }).sensitive, true);
}));

test('aria-labelledby reads static labels without inspecting nested editable content', () => fixture('<span id="label">Course <input value="private content"></span><button aria-labelledby="label">Fallback</button>', p => {
  const result = p.run({ mode: 'capture', marker: p.marker('button') });
  assert.equal(result.descriptor.name, 'Course');
  assert.doesNotMatch(JSON.stringify(result), /private content/);
}));

test('truncated and redacted names are never eligible for replay', () => fixture('<button id="long">' + 'x'.repeat(161) + '</button><button id="email">student@example.test</button>', p => {
  for (const marker of [1, 2]) {
    const result = p.run({ mode: 'capture', marker });
    assert.equal(result.replayable, false); assert.equal(result.reason, 'unsafe_label');
    assert.equal(p.run({ mode: 'resolve', target: result.descriptor }).ok, false);
  }
}));

for (const url of ['https://fixture.test/reset?token=synthetic-private-token', 'https://fixture.test/#/reset?code=synthetic-private-code', 'https://fixture.test/#access_token=synthetic-private-token', 'https://fixture.test/#session=synthetic-private-session', 'https://fixture.test/?authToken=synthetic-private-token', 'https://fixture.test/?q=student%40example.test']) {
  test('secret URL parameters never enter state or become a replayable route: ' + url.split('?')[0].split('#')[0], () => fixture('<button>Go</button>', p => {
    const result = p.run({ mode: 'state' });
    assert.equal(result.replayable, false); assert.equal('queryHash' in result.page, false);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private|student/);
  }, url));
}

test('hashbang routes preserve their distinct route identity', () => fixture('<button>Go</button>', p => {
  assert.equal(p.run({ mode: 'state' }).page.path, '/#!/courses');
}, 'https://fixture.test/#!/courses?sort=asc'));

test('a second fragment in a hash route cannot be silently discarded for replay', () => fixture('<button>Go</button>', p => {
  assert.equal(p.run({ mode: 'state' }).replayable, false);
  assert.equal(p.run({ mode: 'capture', marker: 1 }).reason, 'unsafe_page');
}, 'https://fixture.test/#/courses#another-route'));

for (const hash of ['#course-alpha', '#course-beta']) {
  test(`bare hash route ${hash} cannot lose its identity during replay`, () => fixture('<h1>Course</h1><button id="go">Go</button>', p => {
    assert.equal(p.run({ mode: 'state' }).replayable, false);
    const captured = p.run({ mode: 'capture', marker: 1 });
    assert.equal(captured.replayable, false); assert.equal(captured.reason, 'unsafe_page');
    const result = p.run({ mode: 'resolve', target: captured.descriptor });
    assert.equal(result.ok, false); assert.equal(result.error, 'unsafe_page');
  }, `https://fixture.test/course${hash}`));
}

test('focused capture must identify the actual registered control', () => fixture('<input id="query" aria-label="Query"><div id="other" tabindex="-1"></div>', p => {
  assert.equal(p.run({ mode: 'capture', marker: p.marker('#query') }).targetState.focused, false);
  p.w.document.querySelector('#query').focus();
  assert.equal(p.run({ mode: 'capture', focused: true }).descriptor.id, 'query');
  assert.equal(p.run({ mode: 'capture', focused: true }).targetState.focused, true);
  p.w.document.querySelector('#other').focus();
  assert.equal(p.run({ mode: 'capture', focused: true }).reason, 'unsupported_target');
  assert.equal(p.run({ mode: 'capture', focused: true, marker: 1 }).reason, 'bad_request');
}));

test('current field value is never consulted, even for an unnamed field', () => fixture('<input id="field"><textarea id="notes"></textarea><div role="textbox" contenteditable="true">Private editable prose</div>', p => {
  for (const el of p.w.document.querySelectorAll('input,textarea')) Object.defineProperty(el, 'value', { get() { throw Error('Value must not be read'); } });
  for (let marker = 1; marker < p.w.__chromeBridge.markers.length; marker++) {
    const captured = p.run({ mode: 'capture', marker });
    assert.equal(captured.descriptor.name, '');
    assert.doesNotMatch(JSON.stringify(captured), /Private editable prose/);
  }
}));

for (const attributes of [
  'type="password"', 'autocomplete="current-password"', 'autocomplete="new-password"',
  'autocomplete="one-time-code"', 'autocomplete="section-payment cc-number"',
  'autocomplete="cc-csc"', 'name="verification_code"', 'aria-label="Credit card number"',
  'placeholder="输入验证码"', 'name="otpCode"',
]) {
  test(`sensitive field ${attributes} does not expose its labels, IDs or content`, () => fixture(
    `<input ${attributes} id="private-field" data-testid="private-test" value="SUPER_PRIVATE_CONTENT">`, p => {
      const result = p.run({ mode: 'capture', marker: 1 });
      assert.equal(result.sensitive, true); assert.equal(result.replayable, false); assert.equal(result.reason, 'sensitive_target');
      assert.equal(result.descriptor.name, ''); assert.equal('id' in result.descriptor, false); assert.equal('testId' in result.descriptor, false);
      assert.doesNotMatch(JSON.stringify(result), /SUPER_PRIVATE_CONTENT|private-field|private-test/);
    }));
}

test('wait_for_user private fields and labels controlling passwords remain sensitive', () => fixture(
  '<label for="secret">A private field</label><input id="secret"><label for="pw">Password</label><input id="pw" type="password">', p => {
    p.w.__chromeBridgePrivate = { set: new Set([p.w.document.querySelector('#secret')]), like: [] };
    assert.equal(p.run({ mode: 'capture', marker: p.marker('#secret') }).sensitive, true);
    assert.equal(p.run({ mode: 'capture', marker: p.marker('label[for="pw"]') }).sensitive, true);
  }));

test('target states contain booleans only and can prove same-route changes', () => fixture(
  '<input id="agree" type="checkbox" aria-label="Agree"><button id="menu" aria-expanded="false">Menu</button><button role="tab" aria-selected="false">Details</button>', p => {
    const before = p.run({ mode: 'capture', marker: p.marker('#agree') });
    assert.equal(before.targetState.checked, false);
    p.w.document.querySelector('#agree').checked = true; p.refresh();
    assert.deepEqual(p.run({ mode: 'resolve', target: before.descriptor }).targetState, { disabled: false, focused: false, checked: true });
    assert.equal(p.run({ mode: 'capture', marker: p.marker('#menu') }).targetState.expanded, false);
    assert.equal(p.run({ mode: 'capture', marker: p.marker('[role="tab"]') }).targetState.selected, false);
  }));

test('focus state changes without altering the semantic descriptor or reading field values', () => fixture('<input id="query" aria-label="Query">', p => {
  const before = p.run({ mode: 'capture', marker: 1 });
  p.w.document.querySelector('input').focus();
  Object.defineProperty(p.w.HTMLInputElement.prototype, 'value', { get() { throw Error('Forbidden value'); } });
  const after = p.run({ mode: 'resolve', target: before.descriptor });
  assert.deepEqual(after.descriptor, before.descriptor);
  assert.equal(before.targetState.focused, false); assert.equal(after.targetState.focused, true);
}));

for (const [name, change, reason] of [
  ['disabled', el => { el.disabled = true; }, 'target_disabled'],
  ['hidden', el => { el.hidden = true; }, 'target_hidden'],
  ['ancestor hidden', el => { el.parentElement.style.display = 'none'; }, 'target_hidden'],
  ['inert', el => { el.setAttribute('inert', ''); }, 'target_disabled'],
  ['disconnected', el => { el.remove(); }, 'target_missing'],
]) {
  test(`a ${name} old marker cannot be replayed`, () => fixture('<div><button id="go">Go</button></div>', p => {
    const capture = p.run({ mode: 'capture', marker: 1 }); change(p.w.document.querySelector('#go'));
    assert.equal(p.run({ mode: 'resolve', target: capture.descriptor }).reason, reason);
  }));
}

test('stale URL and malformed registry are refused before using old marker numbers', () => fixture('<button>Go</button>', p => {
  const capture = p.run({ mode: 'capture', marker: 1 });
  p.w.history.replaceState(null, '', '/other');
  assert.equal(p.run({ mode: 'resolve', target: capture.descriptor }).reason, 'stale_registry');
  p.refresh(); p.w.__chromeBridge.markers = {};
  assert.equal(p.run({ mode: 'capture', marker: 1 }).reason, 'stale_registry');
}));

test('malicious descriptors cannot become selectors, coordinates, markers or executable links', () => fixture('<button id="go">Go</button>', p => {
  const target = p.run({ mode: 'capture', marker: 1 }).descriptor;
  for (const patch of [{ marker: 1 }, { x: 10, y: 10 }, { name: '\u202eGo' }, { id: 'go"] [onclick]' }, { version: 2 }, { href: 'javascript:alert(1)' }, { hrefQueryHash: 'a'.repeat(64) }, { href: 'https://fixture.test/', hrefQueryHash: 'A'.repeat(64) }, { frame: 'frame[0]' }, { frame: [] }]) {
    assert.equal(p.run({ mode: 'resolve', target: { ...target, ...patch } }).reason, 'malformed_target');
  }
  assert.equal(p.run({ mode: 'resolve', target: { ...target, frame: { id: 'frame-a' } } }).reason, 'unsupported_context');
}));

test('same-origin frames and shadow roots remain unsupported by the real read registry', () => fixture('<iframe id="frame"></iframe><div id="host"></div>', p => {
  const frame = p.w.document.querySelector('iframe'); frame.contentDocument.body.innerHTML = '<input aria-label="Frame query">';
  const input = frame.contentDocument.querySelector('input'); input.focus();
  assert.equal(p.run({ mode: 'capture', focused: true }).reason, 'unsupported_context');
  const root = p.w.document.querySelector('#host').attachShadow({ mode: 'open' }); root.innerHTML = '<input aria-label="Shadow query">';
  root.querySelector('input').focus();
  assert.equal(p.run({ mode: 'capture', focused: true }).reason, 'unsupported_context');
  p.w.__chromeBridge.markers.push(input, root.querySelector('input'));
  for (let marker = 1; marker < p.w.__chromeBridge.markers.length; marker++) assert.equal(p.run({ mode: 'capture', marker }).reason, 'unsupported_context');
}));

test('sensitive URL segments are redacted and make capture non-replayable', () => fixture('<button id="go">Go</button>', p => {
  const result = p.run({ mode: 'capture', marker: 1 });
  assert.equal(result.replayable, false); assert.equal(result.reason, 'unsafe_page');
  assert.equal(p.run({ mode: 'state' }).replayable, false);
  assert.doesNotMatch(JSON.stringify(result), /my-private-reset-secret/);
}, 'https://fixture.test/reset-password/my-private-reset-secret'));

test('secret labels and malicious attributes are omitted rather than used as replay identities', () => fixture('<button id="safe" aria-label="token=synthetic-secret">Visible</button><button id="bad&quot;id">Go</button>', p => {
  const secret = p.run({ mode: 'capture', marker: 1 });
  assert.equal(secret.reason, 'unsafe_label'); assert.equal(secret.descriptor.name, '');
  assert.doesNotMatch(JSON.stringify(secret), /synthetic-secret/);
  assert.equal(p.run({ mode: 'capture', marker: 2 }).reason, 'unsafe_identifier');
}));

test('view omits hidden, sensitive, editable and overly long content, and has a hard item cap', () => fixture(
  '<h1 hidden>Hidden</h1><h1>token=private-view-token</h1><h1>Verification code</h1><h1 contenteditable="true">Private draft</h1>' +
  '<h2>' + 'x'.repeat(161) + '</h2>' + Array.from({ length: 20 }, (_, i) => `<h2>Heading ${i}</h2>`).join(''), p => {
    const state = p.run({ mode: 'state' });
    assert.ok(state.view.length <= 12); assert.equal(state.view[0].name, 'Heading 0');
    assert.doesNotMatch(JSON.stringify(state.view), /private-view-token|Private draft|Verification|Hidden/);
  }));

test('view excludes hidden descendants while explicit aria-labelledby labels remain available', () => fixture('<h1>Courses<span hidden>Private hidden note</span><span style="display:none">Hidden extra</span></h1><span id="dialog-label" hidden>Choose course</span><dialog open aria-labelledby="dialog-label"></dialog>', p => {
  assert.deepEqual(p.run({ mode: 'state' }).view, [{ role: 'heading', name: 'Courses' }, { role: 'dialog', name: 'Choose course' }]);
}));

test('routine helper never mutates DOM, field values, scroll or focus', async () => fixture('<h1>Home</h1><input id="query" aria-label="Search"><button id="go">Go</button>', async p => {
  const mutations = [];
  const observer = new p.w.MutationObserver(items => mutations.push(...items)); observer.observe(p.w.document, { subtree: true, attributes: true, childList: true, characterData: true });
  for (const name of ['click', 'focus', 'scrollIntoView']) p.w.HTMLElement.prototype[name] = () => { throw Error(`Forbidden ${name}`); };
  p.w.scrollTo = p.w.scrollBy = () => { throw Error('Forbidden scroll'); };
  Object.defineProperty(p.w.HTMLInputElement.prototype, 'value', { get() { throw Error('Forbidden value read'); }, set() { throw Error('Forbidden value write'); } });
  const captured = p.run({ mode: 'capture', marker: p.marker('#query') });
  assert.equal(p.run({ mode: 'resolve', target: captured.descriptor }).ok, true);
  p.run({ mode: 'state' }); await Promise.resolve(); observer.disconnect();
  assert.equal(mutations.length, 0);
}));
