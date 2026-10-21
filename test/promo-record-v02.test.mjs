/* Offline tests for test/promo-record-v02.mjs (promo v0.2 takes). Nothing here opens a window, records the
 * screen, moves the mouse or reaches Chrome: every effect of a take goes through fake deps on a virtual clock,
 * and the read_page texts the takes parse come from the real read_page (src/index.js) run on jsdom pages with
 * every bridge call faked (a call that would reach Chrome throws).
 *   (a) the 18 s watchdog fires at 18 s and ends the running helper session, the hold and the plan, and stops recording
 *   (b) finally closes the windows the take opened and stops recording, also after a failure
 *   (c) R3 clicks only the link on the local page: never inside Google's reCAPTCHA page (box or Submit)
 * Run: node test/promo-record-v02.test.mjs */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = await mkdtemp(path.join(os.tmpdir(), 'promo-v02-test-'));
// src/index.js keeps its lock, tab registry, agent window and menu-bar task files here, never in the real cache.
Object.assign(process.env, {
  CHROME_BRIDGE_LOCK: path.join(tmp, 'input.lock'), CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'),
  CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'agent-window.json'), CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_HABITS: 'off'
});
delete process.env.CHROME_BRIDGE_DEBUG_LOG;

const P = await import('./promo-record-v02.mjs');
const idx = await import('../src/index.js');

// Every test runs (each has its own clock and fakes); the run fails at the end if any did.
let passed = 0;
const failed = [];
async function t(name, fn) {
  try { await fn(); } catch (e) { failed.push(name); console.error(`  FAIL  ${name}\n${e && e.stack || e}`); return; }
  passed++;
  console.log(`  ok  ${name}`);
}

/* ------------------------------------------------ real read_page on jsdom pages */

// Every bridge call fails loudly except reading the page scripts from disk and running them in jsdom.
const page = { w: null };
const fakeB = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, () => { throw new Error(`the test reached the real bridge: ${k}`); }]));
delete fakeB.pageScript;
Object.assign(fakeB, {
  pageDialog: async () => ({ ok: true, open: false }),
  evalInPage: async (src, tab) => {
    const p = JSON.parse(page.w.eval(src));
    if (!p.ok) throw Object.assign(new Error(p.message || p.error), { code: p.error });
    return { ...p, bounds: { left: 24, top: 40, width: 1100, height: 760 },
      target: { tabId: tab ?? 100, windowId: 1100, url: page.w.location.href, title: page.w.document.title, tabActive: true } };
  }
});
idx.__setBridgeForTests(fakeB);
const told = [];
idx.__notifyForTests({ send: (text) => told.push(text), everyMs: 60_000 });

/** jsdom with a fake layout (data-rect="x,y,w,h", default 10,10,120,24; nothing inside display:none). */
function dom(html, url) {
  const w = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true }).window;
  w.Element.prototype.getBoundingClientRect = function () {
    for (let a = this; a && a.nodeType === 1; a = a.parentElement) {
      if (w.getComputedStyle(a).display === 'none') return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, toJSON() { return this; } };
    }
    const spec = this.getAttribute('data-rect');
    const [x, y, width, height] = spec ? spec.split(',').map(Number) : [10, 10, 120, 24];
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() { return this; } };
  };
  w.Element.prototype.getClientRects = function () { const r = this.getBoundingClientRect(); return r.width || r.height ? [r] : []; };
  w.document.elementFromPoint = () => null;
  for (const [k, v] of Object.entries({ innerWidth: 1100, innerHeight: 700, outerWidth: 1100, outerHeight: 760, screenX: 24, screenY: 40, devicePixelRatio: 2 })) {
    Object.defineProperty(w, k, { value: v, configurable: true });
  }
  return w;
}
const realRead = (html, url, args = { full: true }) => { page.w = dom(html, url); return idx.readPage({ tab: 100, ...args }); };

// httpbin.org/forms/post as served (fetched 2026-10-08; the HTML5 spec's example form).
const HTTPBIN = `<!DOCTYPE html>
<html><head></head><body>
<form method="post" action="/post">
 <p><label>Customer name: <input name="custname"></label></p>
 <p><label>Telephone: <input type=tel name="custtel"></label></p>
 <p><label>E-mail address: <input type=email name="custemail"></label></p>
 <fieldset><legend> Pizza Size </legend>
  <p><label> <input type=radio name=size value="small"> Small </label></p>
  <p><label> <input type=radio name=size value="medium"> Medium </label></p>
  <p><label> <input type=radio name=size value="large"> Large </label></p>
 </fieldset>
 <fieldset><legend> Pizza Toppings </legend>
  <p><label> <input type=checkbox name="topping" value="bacon"> Bacon </label></p>
  <p><label> <input type=checkbox name="topping" value="cheese"> Extra Cheese </label></p>
  <p><label> <input type=checkbox name="topping" value="onion"> Onion </label></p>
  <p><label> <input type=checkbox name="topping" value="mushroom"> Mushroom </label></p>
 </fieldset>
 <p><label>Preferred delivery time: <input type=time min="11:00" max="21:00" step="900" name="delivery"></label></p>
 <p><label>Delivery instructions: <textarea name="comments"></textarea></label></p>
 <p><button>Submit order</button></p>
</form></body></html>`;
// Google's reCAPTCHA demo form (its fields are disabled); `widget`: the checkbox frame on screen, unsolved.
const DEMO = (widget) => `<!doctype html><html><head><title>ReCAPTCHA demo</title></head><body>
<form id="recaptcha-demo-form" method="POST"><fieldset><legend>Sample Form with ReCAPTCHA</legend>
<label for="input-1">First Name</label><input id="input-1" name="input1" type="text" value="Jane" disabled>
<label for="input-2">Last Name</label><input id="input-2" name="input2" type="text" value="Smith" disabled>
<div class="g-recaptcha">${widget ? '<iframe title="reCAPTCHA" data-rect="20,300,304,78" src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Le&co=aHR0&hl=en&size=normal"></iframe>' : ''}
<textarea id="g-recaptcha-response" name="g-recaptcha-response" style="display:none"></textarea></div>
<input id="recaptcha-demo-submit" type="submit" value="Submit"></fieldset></form></body></html>`;

const FIXTURE_HTML = fs.readFileSync(path.join(HERE, 'fixtures', P.R3.fixture), 'utf8');
const ORIGIN = 'http://127.0.0.1:4599/';
const FIXTURE_URL = ORIGIN + P.R3.fixture;

const FORM_READ = await realRead(HTTPBIN, P.URLS.form);
const FORM_NO_MEDIUM_READ = await realRead(HTTPBIN.replace(' Medium ', ' Regular '), P.URLS.form);
const LINK_READ = await realRead(FIXTURE_HTML, FIXTURE_URL);
const LINK_AT_GOOGLE_READ = await realRead(FIXTURE_HTML, P.URLS.captcha);
const DEMO_OPEN_READ = await realRead(DEMO(false), P.URLS.captcha);
const BLOCKED = await realRead(DEMO(true), P.URLS.captcha).then(() => null, (e) => e);
const HN_READ = '【tab=100】Hacker News｜https://news.ycombinator.com/\n1. Show HN: a thing\n（这次读的是网页代码，约 900 token）';

/* ------------------------------------------------ virtual clock and fake deps */

function virtualClock(start = Date.UTC(2026, 9, 8, 10, 0, 0)) {
  let now = start, seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, id }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    sleep: (ms) => new Promise(r => clock.setTimeout(r, ms))
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  /** Run `promise` to completion, jumping virtual time from timer to timer whenever nothing else can progress. */
  async function run(promise, maxMs = 300_000) {
    let settled = false, value, error;
    promise.then(v => { settled = true; value = v; }, e => { settled = true; error = e; });
    for (;;) {
      await flush();
      if (settled) break;
      if (!timers.size) throw new Error('virtual clock: nothing left to run and the take has not finished');
      const next = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (next.at - start > maxMs) throw new Error('virtual clock: the take ran past ' + maxMs + ' ms');
      timers.delete(next.id);
      now = Math.max(now, next.at);
      next.fn();
    }
    if (error) throw error;
    return value;
  }
  return { clock, run, start };
}

const OUT = '/virtual/out';
function world(vc, s = {}) {
  const calls = [], files = new Map(), tabs = new Map(), recs = [], running = new Set();
  let nextTab = 100, serverClosed = 0;
  const now = () => vc.clock.now();
  const note = (fn, args, extra = {}) => { const c = { t: now(), fn, args, ...extra }; calls.push(c); return c; };
  /** An input action lasting `ms` of virtual time, unless its helper session is ended first (then: terminated). */
  const act = (ms, outcome) => new Promise((resolve, reject) => {
    let id = null;
    const h = { kill: () => { running.delete(h); vc.clock.clearTimeout(id); reject(Object.assign(new Error('❌ 鼠标键盘助手在操作中途被结束了'), { code: 'terminated' })); } };
    id = vc.clock.setTimeout(() => { running.delete(h); try { resolve(outcome()); } catch (e) { reject(e); } }, ms);
    running.add(h);
  });
  const byUrl = (url, args) => {
    if (s.readPage) return s.readPage(url, args);
    if (url === P.URLS.form) return FORM_READ;
    if (url === P.URLS.hn) return HN_READ;
    if (url === FIXTURE_URL) return LINK_READ;
    if (url === P.URLS.captcha) { if (s.captchaOpen) return DEMO_OPEN_READ; throw BLOCKED; }
    throw new Error('no page for ' + url);
  };
  const deps = {
    clock: vc.clock,
    log: () => {},
    writeFile: async (f, text) => { note('writeFile', [f]); files.set(f, text); },
    mainDisplay: async () => ({ x: 0, y: 0, w: 1728, h: 1117 }),
    newWindow: async (url, rect) => { const tabId = nextTab++; tabs.set(tabId, { url, windowId: tabId + 1000, open: true }); note('newWindow', [url, rect]); return { ok: true, tabId, windowId: tabId + 1000 }; },
    registerTab: async (...a) => { note('registerTab', a); },
    forgetTab: async (...a) => { note('forgetTab', a); },
    listTabs: async () => ({ ok: true, windows: [...tabs].filter(([, x]) => x.open).map(([id, x]) => ({ id: x.windowId, tabs: [{ id, url: x.url }] })) }),
    closeTab: async (id) => { note('closeTab', [id]); const x = tabs.get(Number(id)); if (x) x.open = false; return { ok: true }; },
    readPage: async (args) => { const x = tabs.get(args.tab); note('readPage', [args], { url: x.url }); return byUrl(x.url, args); },
    click: (args) => {
      const x = tabs.get(args.tab);
      note('click', [args], { url: x.url });
      if (s.click) return s.click(args, act, x);
      return act(s.clickMs ?? 2000, () => { if (x.url === FIXTURE_URL) x.url = P.URLS.captcha; return '✅ 已点击'; });
    },
    typeText: (args) => {
      note('typeText', [args], { url: tabs.get(args.tab).url });
      return s.typeText ? s.typeText(args, act) : act(1500 + 260 * args.text.length, () => '✅ 已输入并在输入框里确认');
    },
    taskPlan: async (args) => { note('taskPlan', [args]); return args.done ? '✅ 任务结束' : '✅ 已记录任务'; },
    endTaskHold: async () => { note('endTaskHold', []); },
    waitForUser: (args) => { note('waitForUser', [args]); return s.waitForUser ? s.waitForUser(args) : vc.clock.sleep(6000).then(() => '✅ 验证/拦截已经没有了，等了 6 秒。'); },
    endHelperSessions: async () => { const n = running.size; note('endHelperSessions', [], { n }); for (const h of [...running]) h.kill(); return n; },
    startRecorder: (name) => {
      const r = { name, file: `${OUT}/${name}.mkv`, startedAt: now(), stops: [] };
      recs.push(r);
      note('startRecorder', [name]);
      return { file: r.file, alive: () => !s.recorderQuits, stop: async () => { r.stops.push(now()); note('recorderStop', [name]); } };
    },
    startFixtureServer: async () => { note('startFixtureServer', []); return { url: ORIGIN, close: async () => { serverClosed++; note('serverClose', []); } }; },
    autoEsc: s.autoEsc ? () => { note('autoEsc', []); return s.autoEsc(); } : undefined
  };
  return {
    deps, calls, files, tabs, recs,
    get serverClosed() { return serverClosed; },
    of: (fn) => calls.filter(c => c.fn === fn),
    abs: (rel) => vc.start + rel
  };
}
const take = (name, vc, W) => vc.run(P.runTake(name, { outDir: OUT, deps: W.deps }));
const inputs = (W) => W.calls.filter(c => c.fn === 'click' || c.fn === 'typeText');
/** (b): every window the take opened is closed again, after the recording stopped. */
function assertClosedAfterRecording(W) {
  const opened = W.of('newWindow');
  assert.ok(opened.length >= 1, 'no window was opened');
  for (const [id, x] of W.tabs) assert.equal(x.open, false, `tab ${id} (window ${x.windowId}) left open`);
  const closes = W.of('closeTab');
  assert.deepEqual(closes.map(c => c.args[0]).sort(), [...W.tabs.keys()].sort(), 'closeTab must close exactly the tabs this take opened');
  for (const r of W.recs) {
    assert.ok(r.stops.length >= 1, `recording ${r.name} never stopped`);
    assert.ok(closes.every(c => c.t >= r.stops[0]), 'a window was closed before the recording stopped');
  }
}

/* ------------------------------------------------ tests */

console.log('promo-record-v02: setup (real read_page on jsdom)');

await t('the real read_page output is what the takes parse: httpbin markers, the one link, the CAPTCHA stop', async () => {
  assert.deepEqual(P.r1Targets(FORM_READ), { medium: 8, topping: 11, note: 17 });
  assert.equal(P.r2Target(FORM_READ), 17);
  assert.match(FORM_READ, /^\[18\] button \| Submit order$/m);
  assert.match(FORM_READ, /^\[2\] input\[text\] \| custname/m);
  assert.equal(P.r3Link(LINK_READ, FIXTURE_URL), 1);
  assert.throws(() => P.r3Link(LINK_AT_GOOGLE_READ, FIXTURE_URL), /not the local link page; nothing was clicked/);
  assert.throws(() => P.r3Link(DEMO_OPEN_READ, FIXTURE_URL), /nothing was clicked/);
  assert.throws(() => P.r1Targets(FORM_NO_MEDIUM_READ), /expected one size "Medium" on the form, found 0/);
  assert.match(DEMO_OPEN_READ, /^\[\d+\] input\[submit\] \| Submit$/m);
  // MyChrome's own check (siteGate) on the demo page with the box on screen: stop, never solve; the owner is told once.
  assert.ok(BLOCKED && BLOCKED.code === 'site_blocked' && /不代做、也不绕过/.test(BLOCKED.message), String(BLOCKED && BLOCKED.message));
  assert.equal(told.length, 1);
  assert.match(told[0], /需要你处理：www\.google\.com/);
  // the fixture is the neutral page the storyboard asks for: one link, to Google's demo, nothing else
  assert.equal((FIXTURE_HTML.match(/<a\b/g) || []).length, 1);
  assert.match(FIXTURE_HTML, /<a href="https:\/\/www\.google\.com\/recaptcha\/api2\/demo">Open the sign-up demo<\/a>/);
  assert.doesNotMatch(FIXTURE_HTML, /<(script|form|iframe|input|button)\b/i);
});

await t('env set before src/index.js loads: task/plan gap 3 s, habits off, takeover max 18 s; the script imports no project module at load', async () => {
  assert.deepEqual(P.ENV, { CHROME_BRIDGE_TASK_GAP_MS: '3000', CHROME_BRIDGE_PLAN_GAP_MS: '3000', CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_TAKEOVER_MAX_MS: '18000' });
  assert.equal(P.WATCHDOG_MS, 18_000);
  const src = fs.readFileSync(path.join(HERE, 'promo-record-v02.mjs'), 'utf8');
  const staticFrom = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]);
  assert.ok(staticFrom.length && staticFrom.every(f => f.startsWith('node:')), `static imports: ${staticFrom.join(', ')}`);
});

console.log('(a) the 18 s watchdog');

await t('(a) R2, the owner does nothing and the typing would run 30 s: at exactly 18 s the running helper session, the hold and the plan are ended and recording stops; nothing is typed or clicked after', async () => {
  const vc = virtualClock();
  const W = world(vc, { typeText: (args, act) => act(30_000, () => '✅ 已输入') });
  const res = await take('R2', vc, W);
  assert.equal(res.watchdog.fired, true);
  assert.equal(res.watchdog.firedAtMs - res.watchdog.armedAtMs, 18_000);
  const fire = W.abs(res.watchdog.firedAtMs);
  const typing = W.of('typeText')[0];
  assert.equal(typing.t, W.abs(res.watchdog.armedAtMs), 'the watchdog is armed when the takeover action starts');
  const killed = W.of('endHelperSessions')[0];
  assert.ok(killed && killed.t === fire && killed.n === 1, `the running action's helper session was not ended at 18 s: ${JSON.stringify(killed)}`);
  const hold = W.of('endTaskHold')[0];
  assert.ok(hold && hold.t === fire, `endTaskHold not called at 18 s: ${JSON.stringify(hold)}`);
  assert.ok(W.of('taskPlan').some(c => c.args[0].done === true && c.t === fire), 'task_plan done not called at 18 s');
  assert.equal(W.recs[0].stops[0], fire, 'recording did not stop at 18 s');
  assert.ok(inputs(W).every(c => c.t < fire), 'an input action was issued after the watchdog');
  assert.deepEqual([res.cancel.reported, res.cancel.code], [false, 'terminated']);
  assert.deepEqual([res.takeover.ms, res.takeover.within], [18_000, true]);
  assert.match(res.fatal, /take_stopped/);
  assert.equal(res.end.why, 'watchdog');
  assertClosedAfterRecording(W);
});

await t('(a) R1, the first click never ends (a job hold endTaskHold cannot see yet): the watchdog still ends it at 18 s and the next steps never run', async () => {
  const vc = virtualClock();
  const W = world(vc, { clickMs: 60_000 });
  const res = await take('R1', vc, W);
  const fire = W.abs(res.watchdog.armedAtMs + 18_000);
  assert.equal(W.abs(res.watchdog.firedAtMs), fire);
  assert.ok(W.of('endHelperSessions').some(c => c.t === fire && c.n === 1));
  assert.ok(W.of('endTaskHold').some(c => c.t === fire));
  assert.equal(W.recs[0].stops[0], fire);
  assert.equal(inputs(W).length, 1, 'steps 2/3 and 3/3 must not start after the watchdog');
  assertClosedAfterRecording(W);
});

await t('(a) R1 in time (about 10 s): the watchdog does not fire; Medium, Extra Cheese and the note box only (never Submit or the name/phone/e-mail fields); hold ended before recording stops', async () => {
  const vc = virtualClock();
  const W = world(vc);
  const res = await take('R1', vc, W);
  assert.equal(res.watchdog.fired, false);
  assert.equal(res.fatal, null);
  assert.ok(res.takeover.ms > 0 && res.takeover.ms < 18_000 && res.takeover.within, `takeover ${res.takeover.ms} ms`);
  assert.deepEqual(inputs(W).map(c => [c.fn, c.args[0].marker, c.args[0].task, c.args[0].step]),
    [['click', 8, 'Order a pizza (demo)', '1/3'], ['click', 11, 'Order a pizza (demo)', '2/3'], ['typeText', 17, 'Order a pizza (demo)', '3/3']]);
  assert.deepEqual([W.of('typeText')[0].args[0].text, W.of('typeText')[0].args[0].input_mode], ['Ring the bell.', 'keys']);
  assert.ok(inputs(W).every(c => ![2, 4, 6, 18].includes(c.args[0].marker)));
  const plan = W.of('taskPlan');
  assert.deepEqual(plan[0].args[0], { task: P.R1.task, steps: P.R1.steps });
  const done = plan.find(c => c.args[0].done === true);
  assert.ok(done.t < W.recs[0].stops[0], 'the hold must end before the recording stops');
  assert.ok(W.recs[0].startedAt < W.of('click')[0].t, 'recording starts before the takeover');
  assert.ok(W.calls.indexOf(W.of('readPage')[0]) < W.calls.indexOf(W.of('startRecorder')[0]), 'markers are read before recording');
  assertClosedAfterRecording(W);
  const json = JSON.parse(W.files.get(`${OUT}/R1.json`));
  assert.equal(json.takeover.ms, res.takeover.ms);
});

await t('(a) R2, the owner presses Esc twice at ~4 s: the cancel is logged, the hold is ended, no watchdog', async () => {
  const vc = virtualClock();
  const W = world(vc, { typeText: (args, act) => act(4000, () => { throw Object.assign(new Error('⏹ 用户按了两次 Esc，取消了这次操作'), { code: 'user_cancelled' }); }) });
  const res = await take('R2', vc, W);
  assert.equal(res.watchdog.fired, false);
  assert.deepEqual([res.cancel.reported, res.cancel.code], [true, 'user_cancelled']);
  assert.equal(res.fatal, null);
  assert.ok(res.takeover.ms >= 4000 && res.takeover.ms < 5000, `takeover ${res.takeover.ms} ms`);
  const typing = W.of('typeText')[0].args[0];
  assert.deepEqual([typing.marker, typing.text, typing.input_mode, typing.task, typing.step], [17, P.R2.text, 'keys', P.R2.task, '1/1']);
  assert.ok(W.of('endTaskHold')[0].t <= W.recs[0].stops[0]);
  assertClosedAfterRecording(W);
});

await t('R2 without the owner (autoEsc): the fake user starts once, before the typing; its report is kept; R1 never starts it', async () => {
  const vc = virtualClock();
  const W = world(vc, { autoEsc: () => Promise.resolve({ ok: true, posted: 2 }),
    typeText: (args, act) => act(5000, () => { throw Object.assign(new Error('⏹ 用户按了两次 Esc'), { code: 'user_cancelled' }); }) });
  const res = await take('R2', vc, W);
  assert.equal(W.of('autoEsc').length, 1);
  assert.ok(W.of('autoEsc')[0].t <= W.of('typeText')[0].t, 'started before typing');
  assert.deepEqual(res.autoEsc, { ok: true, posted: 2 });
  assert.deepEqual([res.cancel.reported, res.watchdog.fired, res.fatal], [true, false, null]);
  const vc1 = virtualClock();
  const W1 = world(vc1, { autoEsc: () => Promise.resolve({ ok: true }) });
  await take('R1', vc1, W1);
  assert.equal(W1.of('autoEsc').length, 0);
  assertClosedAfterRecording(W);
});

await t('R0: no takeover, read_page 3 s into the recording, its text saved as R0-read_page.txt, about 8 s recorded', async () => {
  const vc = virtualClock();
  const W = world(vc);
  const res = await take('R0', vc, W);
  assert.equal(res.fatal, null);
  assert.equal(inputs(W).length, 0);
  assert.ok(W.of('taskPlan').every(c => c.args[0].done === true), 'R0 starts no task');
  assert.equal(W.of('readPage')[0].t - W.recs[0].startedAt, 3000);
  assert.equal(W.files.get(`${OUT}/R0-read_page.txt`), HN_READ);
  assert.equal(W.recs[0].stops[0] - W.recs[0].startedAt, 8000);
  assert.equal(res.takeover.ms, 0);
  assertClosedAfterRecording(W);
});

console.log('(b) finally');

await t('(b) R1, the second click fails: finally ends the hold and the plan, stops recording, closes the window, writes the log', async () => {
  const vc = virtualClock();
  let n = 0;
  const W = world(vc, { click: (args, act) => act(2000, () => { if (++n === 2) throw Object.assign(new Error('❌ not on top'), { code: 'not_on_top' }); return '✅'; }) });
  const res = await take('R1', vc, W);
  assert.match(res.fatal, /^not_on_top/);
  const end = W.of('endTaskHold');
  assert.ok(end.length >= 1 && W.of('taskPlan').some(c => c.args[0].done === true));
  assertClosedAfterRecording(W);
  assert.deepEqual(W.of('forgetTab').map(c => c.args[0]), [100]);
  assert.match(JSON.parse(W.files.get(`${OUT}/R1.json`)).fatal, /not_on_top/);
  assert.ok(res.windows[0].tabGone && res.windows[0].windowGone);
});

await t('(b) R1 on a changed form (no "Medium"): stops before recording or any takeover, and still closes the window', async () => {
  const vc = virtualClock();
  const W = world(vc, { readPage: () => FORM_NO_MEDIUM_READ });
  const res = await take('R1', vc, W);
  assert.match(res.fatal, /found 0; nothing was done/);
  assert.equal(W.recs.length, 0);
  assert.equal(inputs(W).length, 0);
  assert.ok(!W.of('taskPlan').some(c => c.args[0].steps));
  for (const [, x] of W.tabs) assert.equal(x.open, false);
});

await t('(b) R2 when the screen recording quits by itself (wrong device, no permission): no takeover starts, the window is closed', async () => {
  const vc = virtualClock();
  const W = world(vc, { recorderQuits: true });
  const res = await take('R2', vc, W);
  assert.match(res.fatal, /^recording_failed/);
  assert.equal(inputs(W).length, 0);
  assert.equal(res.takeover.startMs, null);
  assertClosedAfterRecording(W);
});

await t('(b) R3 fails mid-way: the local page server is closed as well as the window', async () => {
  const vc = virtualClock();
  const W = world(vc, { click: (args, act) => act(1000, () => { throw Object.assign(new Error('❌ boom'), { code: 'boom' }); }) });
  const res = await take('R3', vc, W);
  assert.match(res.fatal, /^boom/);
  assert.equal(W.serverClosed, 1);
  assertClosedAfterRecording(W);
});

console.log('(c) R3 never touches the CAPTCHA');

await t('(c) R3: one click, on the link of the local page; MyChrome stops at the CAPTCHA, the hold ends, then the owner gets 15 s with nothing held; nothing is clicked or typed on Google\'s page', async () => {
  const vc = virtualClock();
  const W = world(vc);
  const res = await take('R3', vc, W);
  assert.equal(res.fatal, null);
  const ins = inputs(W);
  assert.equal(ins.length, 1, `inputs: ${JSON.stringify(ins.map(c => [c.fn, c.args[0].marker, c.url]))}`);
  assert.deepEqual([ins[0].fn, ins[0].url, ins[0].args[0].marker, ins[0].args[0].task, ins[0].args[0].step], ['click', FIXTURE_URL, 1, P.R3.task, '1/2']);
  assert.ok(!W.calls.some(c => (c.fn === 'click' || c.fn === 'typeText') && /google\.com/.test(c.url)));
  assert.equal(res.detection.detected, true);
  const wait = W.of('waitForUser');
  assert.equal(wait.length, 1);
  assert.deepEqual(wait[0].args[0], { tab: 100, minutes: 0.25 });
  const holdEnd = W.of('endTaskHold')[0];
  assert.ok(holdEnd.t <= wait[0].t && W.abs(res.takeover.endMs) <= wait[0].t, 'the hold must be over before the owner is asked');
  assert.equal(res.watchdog.fired, false);
  assert.ok(res.takeover.ms < 18_000);
  assert.ok(W.recs[0].stops[0] > wait[0].t, 'recording runs through the owner\'s tick');
  assert.equal(W.serverClosed, 1);
  assertClosedAfterRecording(W);
});

await t('(c) R3 when MyChrome never reports the CAPTCHA (Submit is on the page): still no click on Submit or anything on Google\'s page', async () => {
  const vc = virtualClock();
  const W = world(vc, { captchaOpen: true });
  const res = await take('R3', vc, W);
  assert.deepEqual([res.detection.detected, res.detection.tries], [false, P.T.r3Checks]);
  const submit = Number(/^\[(\d+)\] input\[submit\] \| Submit$/m.exec(DEMO_OPEN_READ)[1]);
  assert.equal(inputs(W).length, 1);
  assert.ok(!inputs(W).some(c => c.args[0].marker === submit && c.url === P.URLS.captcha));
  assert.ok(!W.calls.some(c => (c.fn === 'click' || c.fn === 'typeText') && /google\.com/.test(c.url)));
  assertClosedAfterRecording(W);
});

await t('(c) R3 when the tab already shows Google\'s page at the start: nothing is clicked at all, no takeover, no recording', async () => {
  const vc = virtualClock();
  const W = world(vc, { readPage: (url) => url === FIXTURE_URL ? LINK_AT_GOOGLE_READ : (() => { throw BLOCKED; })() });
  const res = await take('R3', vc, W);
  assert.match(res.fatal, /nothing was clicked/);
  assert.equal(inputs(W).length, 0);
  assert.equal(W.recs.length, 0);
  assert.equal(W.serverClosed, 1);
  for (const [, x] of W.tabs) assert.equal(x.open, false);
});

await rm(tmp, { recursive: true, force: true });
if (failed.length) { console.error(`promo-record-v02: ${failed.length} failed, ${passed} passed`); process.exit(1); }
console.log(`promo-record-v02 tests passed (${passed})`);
process.exit(0);
