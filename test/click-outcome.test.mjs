/* Read-only click-result regressions: real DOM snapshots and production
 * decision/report functions, with browser I/O and time simulated. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { didClickRegister } from '../src/guard.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

await check('focus alone does not confirm the requested click outcome', () => {
  assert.equal(didClickRegister({ hrefChanged: false, activeIsTarget: true, hadFocusBefore: false }).observed, false);
});

await check('URL, visible content, a new dialog or a new tab are observable changes', () => {
  for (const evidence of [{ hrefChanged: true }, { contentChanged: true }, { dialogChanged: true }, { stateChanged: true }, { newTabs: 1 }]) {
    assert.equal(didClickRegister(evidence).observed, true);
  }
});

const pageSource = await fs.readFile(new URL('../src/page/click-observation.js', import.meta.url), 'utf8');
const indexSource = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function production(name) {
  const start = indexSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return indexSource.slice(start, indexSource.indexOf('\n}', start) + 2);
}
function page(html) {
  const d = new JSDOM(html, { url: 'https://example.test/login', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = d.window;
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    for (let p = this; p; p = p.parentElement) {
      if (p.hidden || w.getComputedStyle(p).display === 'none') return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
    }
    return { width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 };
  };
  return { w, snapshot: (observe = {}) => {
    const result = JSON.parse(w.eval(pageSource.replace(/__OBSERVE__/g, () => JSON.stringify(observe))));
    assert.equal(result.ok, true, 'evalInPage requires an ok envelope');
    return result;
  }, close: () => w.close() };
}

await check('DOM observation ignores focus, class and border changes', () => {
  const p = page('<main><button id="individual">Individual User</button></main>');
  try {
    const before = p.snapshot();
    const b = p.w.document.querySelector('button');
    b.focus(); b.className = 'selected'; b.style.border = '2px solid red';
    assert.deepEqual(p.snapshot(), before);
  } finally { p.close(); }
});

await check('native checkbox and radio changes confirm only the same bound control', () => {
  const p = page('<label id="label" for="choice">Choose account</label><input id="choice" type="radio">');
  try {
    const label = p.w.document.getElementById('label'), control = p.w.document.getElementById('choice');
    p.w.__chromeBridge = { url: p.w.location.href, markers: [null, label] };
    const before = p.snapshot({ marker: 1, bind: { set: 'choice' } });
    assert.equal(before.targetState.checked, false);
    control.checked = true;
    const after = p.snapshot({ marker: 1, bind: { check: 'choice' } });
    assert.equal(changes(before, after).stateChanged, true);
    assert.equal(changes(after, p.snapshot({ marker: 1, bind: { check: 'choice' } })).stateChanged, false);
    control.type = 'checkbox';
    assert.equal(changes(before, p.snapshot({ marker: 1, bind: { check: 'choice' } })).stateChanged, false);
    const next = p.snapshot({ marker: 1, bind: { set: 'checkbox' } });
    control.checked = false;
    assert.equal(changes(next, p.snapshot({ marker: 1, bind: { check: 'checkbox' } })).stateChanged, true);
  } finally { p.close(); }
});

await check('re-rendered controls, changed registries, missing markers and private fields are not state evidence', () => {
  const p = page('<label id="label" for="choice">Choose account</label><input id="choice" type="radio">');
  try {
    const label = p.w.document.getElementById('label'), control = p.w.document.getElementById('choice');
    p.w.__chromeBridge = { url: p.w.location.href, markers: [null, label] };
    const before = p.snapshot({ marker: 1, bind: { set: 'choice' } });
    const replacement = control.cloneNode(); replacement.checked = true; control.replaceWith(replacement);
    assert.equal(p.snapshot({ marker: 1, bind: { check: 'choice' } }).targetState, null);
    p.snapshot({ marker: 1, bind: { set: 'registry' } });
    p.w.__chromeBridge = { url: p.w.location.href, markers: [null, label] };
    assert.equal(p.snapshot({ marker: 1, bind: { check: 'registry' } }).targetState, null);
    assert.equal(p.snapshot({ marker: 9, bind: { set: 'missing' } }).targetState, null);
    p.w.__chromeBridgePrivate = { set: new Set([replacement]), forms: new Set(), like: [] };
    assert.equal(p.snapshot({ marker: 1, bind: { set: 'private' } }).targetState, null);
    assert.equal(changes(before, { ...before, targetState: null }).stateChanged, false);
  } finally { p.close(); }
});

await check('ARIA-only changes do not invent a visible result', () => {
  const p = page('<main><button>Individual User</button><div>Account choices</div></main>');
  try {
    const before = p.snapshot();
    p.w.document.querySelector('main').setAttribute('aria-hidden', 'true');
    assert.deepEqual(p.snapshot().texts, before.texts);
  } finally { p.close(); }
});

function changes(before, after) {
  const c = vm.createContext({ Set, Array });
  vm.runInContext(production('clickChanges'), c);
  return c.clickChanges(before, after);
}

await check('focus-induced scrolling and role-only dialog changes remain unconfirmed', () => {
  const before = { texts: ['Individual User'], dialogs: [], scrollX: 0, scrollY: 0 };
  const scroll = changes(before, { texts: ['Footer'], dialogs: [], scrollX: 0, scrollY: 600 });
  assert.equal(scroll.contentChanged, false);
  const semantic = changes(before, { ...before, dialogs: ['Individual User'] });
  assert.equal(semantic.dialogs.length, 0);
});

await check('an inner scroller moving unchanged text does not confirm a click result', () => {
  const p = page('<main><p id="first">First section</p><p id="second">Second section</p></main>');
  try {
    let moved = false;
    for (const id of ['first', 'second']) p.w.document.getElementById(id).getBoundingClientRect = () => {
      const top = (id === 'first') !== moved ? 10 : 2000;
      return { width: 100, height: 20, top, bottom: top + 20, left: 10, right: 110 };
    };
    const before = p.snapshot(); moved = true;
    const after = p.snapshot();
    assert.notDeepEqual(after.texts, before.texts);
    assert.equal(after.renderedHash, before.renderedHash);
    assert.equal(changes(before, after).contentChanged, false);
  } finally { p.close(); }
});

await check('missing and truncated baselines do not confirm a same-page result', () => {
  const after = { texts: ['Continue'], dialogs: ['Continue'], complete: true };
  assert.equal(changes(null, after).contentChanged, false);
  const truncated = changes({ texts: ['Start'], dialogs: [], complete: false }, after);
  assert.equal(truncated.contentChanged, false);
  assert.equal(truncated.dialogs.length, 0);
});

await check('visible dialogs and changed question text are captured; hidden and private content is excluded', () => {
  const p = page('<main><h2>Question 1</h2><button>Next</button><div hidden>Invisible answer</div>' +
    '<input type="password" value="secret password"><textarea>private textarea</textarea><div contenteditable>private draft</div></main>');
  try {
    const before = p.snapshot();
    assert.doesNotMatch(JSON.stringify(before), /secret password|private textarea|private draft|Invisible answer/);
    p.w.document.querySelector('h2').textContent = 'Question 2';
    const modal = p.w.document.createElement('div');
    modal.setAttribute('role', 'dialog'); modal.textContent = 'Continue with Singpass';
    p.w.document.body.append(modal);
    const after = p.snapshot();
    assert.ok(after.texts.includes('Question 2'));
    assert.ok(after.dialogs.some(text => text.includes('Singpass')));
    assert.notDeepEqual(after.texts, before.texts);
  } finally { p.close(); }
});

await check('ARIA editing controls and their descendants never expose drafts in click evidence', () => {
  for (const role of ['textbox', 'searchbox', 'combobox', 'spinbutton']) {
    const p = page(`<main><button>Next</button><div role="${role}" tabindex="0"><span>PRIVATE_ARIA_DRAFT</span></div></main>`);
    try {
      const before = p.snapshot();
      assert.doesNotMatch(JSON.stringify(before), /PRIVATE_ARIA_DRAFT/);
      p.w.document.querySelector('span').textContent = 'PRIVATE_CHANGED_DRAFT';
      const after = p.snapshot();
      assert.doesNotMatch(JSON.stringify(after), /PRIVATE_CHANGED_DRAFT/);
      assert.equal(changes(before, after).contentChanged, false);
    } finally { p.close(); }
  }
});

function reportHarness({ changedAt = Infinity, hrefChanged = false, newTab = false, nativeDialog = false, checkedAt = Infinity,
  readFails = false, readFailsUntil = 0 } = {}) {
  let now = 0, reads = 0, clicks = 1;
  const base = { href: 'https://example.test/login', texts: ['Individual User'], dialogs: [],
    targetState: { token: 'same-control', kind: 'checkbox', checked: false } };
  const st = { tab: 5, marker: 18, hrefBefore: base.href, before: base, ack: { seen: true }, token: 'test',
    loc: { hadFocus: false }, what: '[18] <button> Individual User', prep: { target: { tabId: 5 }, ownNote: '' },
    origin: { scale: 1 }, listBefore: { windows: [{ id: 1, tabs: [{ id: 5 }] }] } };
  const context = { routineEvidence: null };
  class Clock extends Date { static now() { return now; } }
  const c = vm.createContext({
    Date: Clock, Number, String, Math, Set, Map, process: { env: {} },
    CALL: { getStore: () => context }, didClickRegister,
    sleep: async ms => { now += ms; },
    clip: (s, n) => String(s || '').slice(0, n), redactUrl: s => s, redactText: s => s,
    waitAck: async () => { throw Error('ack already exists'); },
    settledUrl: async (_tab, url) => url,
    B: {
      pageDialog: async () => nativeDialog ? { open: true, texts: ['Confirm selection'], buttons: ['OK'] } : { open: false },
      pageScript: async () => '',
      chromeInfo: async () => ({ url: hrefChanged ? 'https://example.test/account' : base.href }),
      evalInPage: async () => {
        reads++;
        if (readFails || now < readFailsUntil) throw Error('page unavailable');
        // G1: the after-click observation carries block.js's verdict from the same eval; this page waits for no one.
        return { ...base, gate: { ok: true, blocked: null }, ...(now >= changedAt ? { texts: ['Continue with Singpass'], dialogs: ['Continue with Singpass'] } : {}),
          ...(now >= checkedAt ? { targetState: { ...base.targetState, checked: true } } : {}) };
      },
      listTabs: async () => ({ windows: [{ id: 1, tabs: newTab ? [{ id: 5 }, { id: 6 }] : [{ id: 5 }] }] }),
    },
    diffNewTabs: (_before, after) => after.windows[0].tabs.filter(t => t.id !== 5).map(t => ({ tabId: t.id, windowId: 1, title: 'Sign in', url: 'https://example.test/account' })),
    claimPopups: async () => ({ mine: [], theirs: [] }), ledgerNavigated() {},
    targetLine: () => 'tab=5', clickLines: () => ['落点：屏幕 x=100', '反应 50 ms'],
  });
  vm.runInContext(['clickObservation', 'clickChanges', 'clickReport'].map(production).join('\n'), c);
  return { run: () => c.clickReport(st), context, elapsed: () => now, reads: () => reads, clicks: () => clicks };
}

await check('focus-only acknowledged clicks stay unconfirmed after a bounded observation without re-clicking', async () => {
  const h = reportHarness();
  const r = await h.run();
  assert.match(r.out, /^\[18\] → .*URL未变.*结果未确认/);
  assert.doesNotMatch(r.out, /✅|页面没有.*变化|落点|反应|键盘焦点/);
  assert.equal(r.out.split('\n').length, 1);
  assert.equal(h.context.routineEvidence.confirmed, false);
  assert.ok(h.elapsed() >= 3000 && h.elapsed() <= 4000);
  assert.equal(h.clicks(), 1);
});

await check('a delayed same-URL dialog is reported without an extra model read or duplicate click', async () => {
  const h = reportHarness({ changedAt: 2200 });
  const r = await h.run();
  assert.match(r.out, /^\[18\] → URL未变；新弹层：Continue with Singpass/);
  assert.doesNotMatch(r.out, /结果未确认|落点|反应/);
  assert.equal(h.context.routineEvidence.confirmed, true);
  assert.ok(h.reads() > 1);
  assert.equal(h.clicks(), 1);
});

await check('immediate checkbox and content outcomes return without a fixed navigation wait', async () => {
  for (const options of [{ checkedAt: 0 }, { changedAt: 0 }]) {
    const h = reportHarness(options), r = await h.run();
    assert.match(r.out, /目标控件已选中|新弹层/);
    assert.equal(h.elapsed(), 0);
    assert.equal(h.context.routineEvidence.confirmed, true);
  }
});

await check('navigation, new tabs and native dialogs have concise factual receipts', async () => {
  const navigation = await reportHarness({ hrefChanged: true }).run();
  assert.match(navigation.out, /URL已变.*example.test\/account/);
  const tab = await reportHarness({ newTab: true }).run();
  assert.match(tab.out, /新标签.*tab=6/);
  const dialog = await reportHarness({ nativeDialog: true }).run();
  assert.match(dialog.out, /新弹窗.*Confirm selection.*OK/);
  for (const r of [navigation, tab, dialog]) {
    assert.equal(r.out.split('\n').length, 1);
    assert.doesNotMatch(r.out, /落点|反应|键盘焦点|元素可见部分/);
  }
});

await check('an unreadable result remains unknown even when the input event was acknowledged', async () => {
  const h = reportHarness({ readFails: true });
  const r = await h.run();
  assert.match(r.out, /结果未确认/);
  assert.equal(h.context.routineEvidence.confirmed, false);
});

await check('a transient stale read retries only observation, never the delivered click', async () => {
  const h = reportHarness({ readFailsUntil: 2000, changedAt: 2200 });
  const r = await h.run();
  assert.match(r.out, /新弹层：Continue with Singpass/);
  assert.equal(h.context.routineEvidence.confirmed, true);
  assert.ok(h.reads() > 2);
  assert.equal(h.clicks(), 1);
});

console.log(`click-outcome: ${passed} regression groups passed`);
