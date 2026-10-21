#!/usr/bin/env node
/* Promo v0.2 footage: the four takes of docs/marketing/video/v0.2-storyboard.md §6, cut down to the
 * simple version in docs/marketing/launch-plan.md. One take per run, so the owner is asked before each:
 *
 *   node test/promo-record-v02.mjs <out_dir> <take> [screenDevice=4]        take: R0 | R1 | R2 | R3
 *
 *   R0  no takeover: a new window on Hacker News, recorded ~8 s; read_page at ~3 s, its text saved as R0-read_page.txt
 *   R1  takeover: the httpbin pizza form; the AI picks size Medium, ticks Extra Cheese, types a short delivery note
 *   R2  takeover: the same form, a long delivery note typed key by key; the owner presses Esc twice mid-way
 *   R3  takeover, then hand-back: a local page with one link to Google's public reCAPTCHA demo; the AI clicks it,
 *       MyChrome's own check stops, hands back and notifies; the owner ticks the box (up to 15 s, nothing held)
 *
 * Safety: an 18 s watchdog from the first takeover action (R0: from the start of recording) ends the job's hold,
 * closes the plan, ends any helper session still holding the keyboard and mouse, and stops recording; the same
 * runs in `finally`, which also closes every window this run opened. The screen is recorded only while a take
 * runs, into <out_dir>, which must be outside the repository. In R3 the only click is the link on the local
 * page: nothing touches the CAPTCHA box or Submit. No project module is imported until main() runs, so the
 * unit test (test/promo-record-v02.test.mjs) imports this file without reaching Chrome or the screen.
 * List screen devices: ffmpeg -f avfoundation -list_devices true -i "" */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');

export const TAKES = ['R0', 'R1', 'R2', 'R3'];
export const WATCHDOG_MS = 18_000;
export const OWNER_WAIT_MS = 15_000;
/** Set before src/index.js is loaded (it reads them once, at import). */
export const ENV = {
  CHROME_BRIDGE_TASK_GAP_MS: '3000',       // a job's hold ends 3 s after its last action (default 30 s)
  CHROME_BRIDGE_PLAN_GAP_MS: '3000',       // the same under a task_plan (default 90 s)
  CHROME_BRIDGE_HABITS: 'off',             // built-in timing, not the owner's recorded habits
  CHROME_BRIDGE_TAKEOVER_MAX_MS: '18000'   // single actions only: a job's actions use TASK_LIMITS (30 min), hence the watchdog
};
/** The panel's "who" line (storyboard §6.1 D3), unless the caller set one. */
export const ENV_IF_UNSET = { CHROME_BRIDGE_AGENT_NAME: 'Agent · mychrome-demo' };

export const URLS = {
  hn: 'https://news.ycombinator.com/',
  form: 'https://httpbin.org/forms/post',
  captcha: 'https://www.google.com/recaptcha/api2/demo'
};
// Panel task and step names follow CHROME_BRIDGE_LANG like the veil (zh for the Chinese cut); the page text stays English.
const ZH = /^zh/i.test(process.env.CHROME_BRIDGE_LANG || '');
export const R1 = { task: ZH ? '订一份披萨（演示）' : 'Order a pizza (demo)',
  steps: ZH ? ['选中号', '加芝士', '写配送备注'] : ['Choose size Medium', 'Add Extra Cheese', 'Write the delivery note'], note: 'Ring the bell.' };
export const R2 = { task: ZH ? '写配送备注（演示）' : 'Write a delivery note (demo)', text: 'Please ring the bell twice and leave it at the door.' };
export const R3 = { task: ZH ? '在演示页注册' : 'Sign up on the demo page', steps: ZH ? ['打开注册演示页', '填写注册表'] : ['Open the sign-up demo', 'Fill in the sign-up form'],
  link: 'Open the sign-up demo', fixture: /^en/i.test(process.env.CHROME_BRIDGE_LANG || '') ? 'signup-link-en.html' : 'signup-link.html' };
export const WINDOW = { menuBar: 33, dock: 76 };   // points; Dock always shown, bottom, tile size 54
export const T = {
  load: 2500,        // after opening a window, before anything else
  preRoll: 1500,     // recording before the first action (the veil appearing is in shot)
  postRoll: 2000,    // recording after the hold ended
  r0ReadAt: 3000,    // R0: read_page this long after recording starts
  r0Record: 8000,    // R0: recording length
  r3Settle: 1500,    // R3: after the click, before MyChrome's check reads the page
  r3Checks: 5,       // R3: reads (1 s apart) until the check reports the CAPTCHA
  r3PostRoll: 1500   // R3: after the owner's tick
};

/* ------------------------------------------------------------ read_page output */

/** read_page's element index ("=== 可点击元素索引"): "[12] label | Medium" → {marker: 12, tag: 'label', label: 'Medium', rest: ''}. */
export function parseIndex(text) {
  const s = String(text || '');
  const i = s.indexOf('=== 可点击元素索引');
  if (i < 0) return [];
  const out = [];
  for (const raw of s.slice(i).split('\n').slice(1)) {
    const line = raw.trim();
    if (!line) { if (out.length) break; continue; }
    const m = /^\[(\d+)\]\s+(\S+)(?:\s+\|\s+(.*))?$/.exec(line);
    if (!m) continue;
    const parts = (m[3] || '').split(' | ');
    out.push({ marker: Number(m[1]), tag: m[2], label: (parts[0] || '').trim(), rest: parts.slice(1).join(' | ').trim() });
  }
  return out;
}

/** The tab's URL from read_page's first line, 【tab=N】title｜url. */
export function pageUrl(text) {
  const m = /^【tab=\d+】.*｜([^｜\n]*)$/m.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

const NEVER_ON_FORM = (e) => /^(button|input\[(submit|text|tel|email)\])$/.test(e.tag) || /submit/i.test(e.label) ||
  /^(custname|custtel|custemail)$/.test(e.label);
function one(idx, ok, what) {
  const hits = idx.filter(ok);
  if (hits.length !== 1) throw new Error(`expected one ${what} on the form, found ${hits.length}; nothing was done`);
  if (NEVER_ON_FORM(hits[0])) throw new Error(`[${hits[0].marker}] ${hits[0].tag} "${hits[0].label}" is not a target for this take; nothing was done`);
  return hits[0].marker;
}
/** R1: the three targets on httpbin's form. Never the name, phone or e-mail fields (Chrome's autofill shows the
 * owner's real details there) and never Submit. */
export function r1Targets(text) {
  const idx = parseIndex(text);
  return {
    medium: one(idx, e => /^(label|input\[radio\])$/.test(e.tag) && e.label === 'Medium', 'size "Medium"'),
    topping: one(idx, e => /^(label|input\[checkbox\])$/.test(e.tag) && e.label === 'Extra Cheese', 'topping "Extra Cheese"'),
    note: one(idx, e => e.tag === 'textarea', 'delivery-instructions box')
  };
}
/** R2: the delivery-instructions box. */
export function r2Target(text) {
  return one(parseIndex(text), e => e.tag === 'textarea', 'delivery-instructions box');
}
/** R3: the link on the local page, and only there: the tab must show that page, and its one element must be the link. */
export function r3Link(text, fixtureUrl) {
  const url = pageUrl(text);
  if (!url || !url.startsWith(fixtureUrl)) throw new Error(`R3: the tab shows ${url || 'an unknown page'}, not the local link page; nothing was clicked`);
  const idx = parseIndex(text);
  if (idx.length !== 1 || idx[0].tag !== 'a' || idx[0].label !== R3.link) {
    throw new Error(`R3: the local page must have exactly one element, the link "${R3.link}" (found ${idx.length}); nothing was clicked`);
  }
  return idx[0].marker;
}

/* ------------------------------------------------------------ the watchdog */

/** Fires `onFire` once, `ms` after arm(), unless disarmed first. `fired` resolves when it fires. */
export function makeWatchdog(clock, ms, onFire) {
  let timer = null, armedAt = null, firedAt = null, resolveFired;
  const fired = new Promise(r => { resolveFired = r; });
  return {
    fired,
    get armedAt() { return armedAt; },
    get firedAt() { return firedAt; },
    get isFired() { return firedAt != null; },
    arm() {
      if (timer != null || firedAt != null) return;
      armedAt = clock.now();
      timer = clock.setTimeout(() => {
        timer = null;
        firedAt = clock.now();
        resolveFired();
        Promise.resolve().then(onFire).catch(() => {});
      }, ms);
    },
    disarm() { if (timer != null) { clock.clearTimeout(timer); timer = null; } }
  };
}

const firstLine = (e) => String((e && e.message) || e || '').split('\n')[0].slice(0, 200);
const brief = (v) => v == null ? null : String(typeof v === 'string' ? v : (v.text ?? JSON.stringify(v))).split('\n').slice(0, 3).join(' / ').slice(0, 300);

/* ------------------------------------------------------------ one take */

/**
 * Run one take. Every effect goes through `deps` (main() passes the real ones; the unit test fakes them):
 *   clock {now, setTimeout, clearTimeout, sleep}, log, writeFile, mainDisplay, newWindow, registerTab, forgetTab,
 *   listTabs, closeTab, readPage, click, typeText, taskPlan, endTaskHold, waitForUser, endHelperSessions,
 *   startRecorder(name) -> {file, stop()}, startFixtureServer() -> {url, close()}, onSignal(fn)?
 * Never throws: the result (also written to <out_dir>/<take>.json) carries `fatal`.
 */
export async function runTake(take, { outDir, deps, env = null }) {
  const { clock } = deps;
  const t0 = clock.now();
  const at = () => clock.now() - t0;
  const res = {
    take, startedAt: new Date(t0).toISOString(), env,
    watchdog: { ms: WATCHDOG_MS, armedAtMs: null, fired: false, firedAtMs: null, end: null },
    takeover: { startMs: null, endMs: null, ms: null, limitMs: WATCHDOG_MS, within: null },
    recording: null, window: null, windows: [], steps: [], events: [], fatal: null
  };
  const ev = (what) => { const t = at(); res.events.push({ t, what }); deps.log(`${take} +${(t / 1000).toFixed(1)} s  ${what}`); };
  const abort = new AbortController();
  const signal = abort.signal;
  const stopP = new Promise(r => signal.addEventListener('abort', r, { once: true }));
  const stopped = () => Object.assign(new Error('stopped: the watchdog or a signal ended this take'), { code: 'take_stopped' });
  const opened = [];
  let rec = null, srv = null, inFlight = null, ending = null;

  /** fn() (or a promise) settled within ms, never throwing: {ok, v} | {ok: false, e} | {ok: false, timeout: true}. */
  const within = (fn, ms) => new Promise(resolve => {
    const id = clock.setTimeout(() => resolve({ ok: false, timeout: true }), ms);
    Promise.resolve().then(typeof fn === 'function' ? fn : () => fn).then(v => { clock.clearTimeout(id); resolve({ ok: true, v }); },
      e => { clock.clearTimeout(id); resolve({ ok: false, e }); });
  });
  const how = (r) => r.ok ? 'ok' : r.timeout ? 'timed out' : `failed: ${(r.e && r.e.code) || ''} ${firstLine(r.e)}`.trim();

  const stopRecording = async () => {
    if (!rec) return;
    const r = await within(() => rec.stop(), 10_000);
    if (res.recording.stopMs == null) { res.recording.stopMs = at(); res.recording.stop = how(r); ev('recording stopped'); }
  };
  const beginTakeover = () => {
    wd.arm();
    res.watchdog.armedAtMs = at();
    res.takeover.startMs = at();
  };
  const endTakeover = () => {
    wd.disarm();
    if (res.takeover.startMs != null && res.takeover.endMs == null) {
      res.takeover.endMs = at();
      res.takeover.ms = res.takeover.endMs - res.takeover.startMs;
      res.takeover.within = res.takeover.ms <= WATCHDOG_MS;
    }
  };

  /**
   * End everything a take may hold, once: no new attempts (signal), the helper session of an action still
   * running (endTaskHold cannot reach it: a job's hold is known only after its first action returned, and a
   * running action's helper answers nothing else until it ends), the job's hold, the plan, any session left,
   * then the recording.
   */
  const endEverything = (why) => ending ??= (async () => {
    ev(`ending everything (${why})`);
    abort.abort();
    wd.disarm();
    const out = { why, atMs: at() };
    const sessions = async () => { const r = await within(() => deps.endHelperSessions(), 6000); return r.ok ? r.v : how(r); };
    try {
      if (inFlight) {
        const running = inFlight;
        out.inFlight = running.name;
        out.sessionsEndedInFlight = await sessions();
        out.inFlightSettled = how(await within(running.promise.catch(() => null), 5000));
      }
      out.endTaskHold = how(await within(() => deps.endTaskHold(), 5000));
      out.planDone = how(await within(() => deps.taskPlan({ done: true }), 5000));
      out.sessionsEndedAfter = await sessions();
    } finally {
      endTakeover();
      await stopRecording();
    }
    return out;
  })();
  const wd = makeWatchdog(clock, WATCHDOG_MS, async () => {
    res.watchdog.fired = true;
    res.watchdog.firedAtMs = at();
    ev(`WATCHDOG: ${WATCHDOG_MS / 1000} s`);
    res.watchdog.end = await endEverything('watchdog');
  });
  if (deps.onSignal) deps.onSignal(() => { endEverything('signal').catch(() => {}); });

  /** One awaited call, timed and logged; refused once the take is being ended. */
  const step = async (name, fn) => {
    if (signal.aborted) throw stopped();
    const s = { name, startMs: at() };
    res.steps.push(s);
    const promise = Promise.resolve().then(fn);
    inFlight = { name, promise };
    try {
      const v = await promise;
      s.ok = true;
      s.result = brief(v);
      return v;
    } catch (e) {
      s.ok = false;
      s.code = (e && e.code) || null;
      s.error = firstLine(e);
      throw e;
    } finally {
      s.endMs = at();
      if (inFlight && inFlight.promise === promise) inFlight = null;
    }
  };
  /** Wait; cut short (and then refused) once the take is being ended, unless `stoppable` is false. */
  const pause = async (ms, { stoppable = true } = {}) => {
    if (stoppable) {
      await Promise.race([clock.sleep(ms), stopP]);
      if (signal.aborted) throw stopped();
    } else await clock.sleep(ms);
  };
  const startRecording = () => {
    rec = deps.startRecorder(take);
    res.recording = { file: rec.file, startMs: at(), stopMs: null };
    ev('recording');
  };
  /** After the pre-roll: a recorder that already quit (wrong screen device, no Screen Recording permission) stops the take before any takeover. */
  const recordingRuns = () => {
    if (rec && typeof rec.alive === 'function' && !rec.alive()) {
      throw Object.assign(new Error('the screen recording quit by itself (check the screen device and Screen Recording permission); no takeover was started'), { code: 'recording_failed' });
    }
  };
  const openWindow = async (url) => {
    const b = await deps.mainDisplay();
    // The window fills the display between the menu bar and the Dock, so the full-screen recording shows
    // nothing but this window (2026-10-08: a 1100x760 window left the owner's terminals and another page in frame).
    const left = b.x, top = b.y + WINDOW.menuBar;
    const rect = { left, top, right: b.x + b.w, bottom: b.y + b.h - WINDOW.dock };
    const w = await deps.newWindow(url, rect);
    const tab = Number(w.tabId);
    opened.push({ tabId: tab, windowId: w.windowId });
    res.window = { rect, tabId: tab, windowId: w.windowId, rightGapPt: b.x + b.w - rect.right };
    ev(`window ${w.windowId} opened (tab ${tab}): ${url}`);
    await deps.registerTab(tab, url, { windowId: w.windowId });
    // Bring it in front of the owner's other windows before recording (and so a takeover restores to Chrome).
    if (deps.activate) { await deps.activate(tab, w.windowId); ev('window brought to the front'); }
    await pause(T.load);
    return tab;
  };
  /** Only the tabs this run opened; a window that still has other tabs afterwards is left alone and reported. */
  const closeOpened = async () => {
    for (const o of opened) {
      const r = { tabId: o.tabId, windowId: o.windowId, close: how(await within(() => deps.closeTab(o.tabId), 8000)) };
      await within(() => deps.forgetTab(o.tabId), 3000);
      const list = await within(() => deps.listTabs(), 8000);
      if (list.ok && list.v && Array.isArray(list.v.windows)) {
        const w = list.v.windows.find(x => String(x.id) === String(o.windowId));
        const tabStill = list.v.windows.some(x => (x.tabs || []).some(t => Number(t.id) === o.tabId));
        r.tabGone = !tabStill;
        r.windowGone = !w;
        if (w) r.windowLeftOpen = `${(w.tabs || []).length} tab(s) this run did not open`;
      } else r.checked = how(list);
      res.windows.push(r);
      ev(`window ${o.windowId}: tab ${o.tabId} ${r.tabGone === false ? 'STILL OPEN' : 'closed'}`);
    }
  };

  try {
    if (take === 'R0') {
      const tab = await openWindow(URLS.hn);
      startRecording();
      wd.arm();                               // no takeover in R0: the watchdog bounds the recording itself
      res.watchdog.armedAtMs = at();
      const rs = at();
      await pause(T.r0ReadAt);
      recordingRuns();
      const read = await step('read_page', () => deps.readPage({ tab }, { signal }));
      const text = typeof read === 'string' ? read : (read && read.text) || '';
      await deps.writeFile(path.join(outDir, 'R0-read_page.txt'), text);
      res.read = { file: 'R0-read_page.txt', chars: text.length, picture: !!(read && typeof read === 'object' && read.image),
        tier: /这次读的是网页代码/.test(text) ? 'page code' : 'screen text (window picture read on this Mac)' };
      await pause(Math.max(1000, T.r0Record - (at() - rs)));
      wd.disarm();
      await stopRecording();
      res.takeover.ms = 0;
      res.takeover.within = true;
    } else if (take === 'R1') {
      const tab = await openWindow(URLS.form);
      const m = r1Targets(await step('read_page (markers)', () => deps.readPage({ tab, full: true }, { signal })));
      res.markers = m;
      startRecording();
      await pause(T.preRoll);
      recordingRuns();
      await step('task_plan', () => deps.taskPlan({ task: R1.task, steps: R1.steps }));
      beginTakeover();
      await step('click Medium (1/3)', () => deps.click({ tab, marker: m.medium, task: R1.task, step: '1/3' }, { signal }));
      await step('click Extra Cheese (2/3)', () => deps.click({ tab, marker: m.topping, task: R1.task, step: '2/3' }, { signal }));
      await step('type the delivery note (3/3)', () => deps.typeText({ tab, marker: m.note, text: R1.note, input_mode: 'keys',
        task: R1.task, step: '3/3' }, { signal }));
      await step('task_plan done', () => deps.taskPlan({ done: true }));
      endTakeover();
      await pause(T.postRoll);
      await stopRecording();
    } else if (take === 'R2') {
      const tab = await openWindow(URLS.form);
      const note = r2Target(await step('read_page (markers)', () => deps.readPage({ tab, full: true }, { signal })));
      res.markers = { note };
      startRecording();
      deps.log(deps.autoEsc ? 'R2: experiments/fakeuser presses Esc twice about 4.5 s after the veil shows' : 'R2: press Esc twice while the long note is being typed');
      await pause(T.preRoll);
      recordingRuns();
      // The optional local helper sends untagged HID Esc presses; otherwise the owner presses Esc.
      const esc = deps.autoEsc ? deps.autoEsc() : null;
      beginTakeover();
      let typed = null, err = null;
      try {
        typed = await step('type the long note (1/1)', () => deps.typeText({ tab, marker: note, text: R2.text, input_mode: 'keys',
          task: R2.task, step: '1/1' }, { signal }));
      } catch (e) { err = e; }
      if (esc) res.autoEsc = await Promise.race([esc, new Promise(r => deps.clock.setTimeout(() => r({ ok: false, error: 'fakeuser_timeout' }), 3000))]).catch(e => ({ ok: false, error: String(e) }));
      res.cancel = { reported: !!err && err.code === 'user_cancelled', code: err ? err.code || null : null,
        message: err ? firstLine(err) : null, atMs: at(), result: brief(typed) };
      ev(res.cancel.reported ? 'the action reported a cancel (Esc twice)' : `no cancel reported${err ? ` (${err.code || 'error'})` : ''}`);
      if (signal.aborted) throw stopped();
      // Typed to the end: the job's hold would otherwise wait out its 3 s gap.
      await step('end the hold', () => deps.endTaskHold());
      endTakeover();
      await pause(T.postRoll);
      await stopRecording();
    } else if (take === 'R3') {
      srv = await deps.startFixtureServer();
      const fixtureUrl = srv.url + R3.fixture;
      const tab = await openWindow(fixtureUrl);
      const link = r3Link(await step('read_page (link)', () => deps.readPage({ tab, full: true }, { signal })), fixtureUrl);
      res.markers = { link };
      startRecording();
      await pause(T.preRoll);
      recordingRuns();
      await step('task_plan', () => deps.taskPlan({ task: R3.task, steps: R3.steps }));
      beginTakeover();
      await step('click the link (1/2)', () => deps.click({ tab, marker: link, task: R3.task, step: '1/2' }, { signal }));
      // From here on only reads: MyChrome checks the page before every read and stops at a CAPTCHA.
      const det = { detected: false, tries: 0, atMs: null, message: null, lastError: null };
      res.detection = det;
      await pause(T.r3Settle);
      for (let i = 1; i <= T.r3Checks && !det.detected; i++) {
        det.tries = i;
        try {
          await step(`read_page (check ${i})`, () => deps.readPage({ tab, full: true }, { signal }));
        } catch (e) {
          if (e && e.code === 'take_stopped') throw e;
          if (e && e.code === 'site_blocked') { det.detected = true; det.atMs = at(); det.message = firstLine(e); break; }
          det.lastError = `${(e && e.code) || ''} ${firstLine(e)}`.trim();
        }
        if (i < T.r3Checks) await pause(1000);
      }
      ev(det.detected ? 'MyChrome reported the CAPTCHA (hold ended, owner told)' : 'MyChrome did not report a CAPTCHA');
      // Its check ends the hold itself (markBlocked); end it here too in case it did not fire.
      await step('end the hold', () => deps.endTaskHold());
      endTakeover();
      // The owner ticks the box; nothing is held. MyChrome's own wait reads the page every 3 s.
      const w = await within(() => step('wait_for_user', () => deps.waitForUser({ tab, minutes: OWNER_WAIT_MS / 60_000 }, { signal })),
        OWNER_WAIT_MS + 3000);
      res.ownerWait = { result: w.ok ? brief(w.v) : how(w), endMs: at() };
      await step('task_plan done', () => deps.taskPlan({ done: true }));
      await pause(T.r3PostRoll, { stoppable: false });
      await stopRecording();
    } else {
      throw new Error(`unknown take ${take}`);
    }
  } catch (e) {
    res.fatal = `${(e && e.code) || ''} ${firstLine(e)}`.trim();
    ev(`FATAL ${res.fatal}`);
  } finally {
    res.end = await endEverything('finally');
    await closeOpened();
    if (srv) { await within(() => srv.close(), 3000); ev('local page server closed'); }
    res.endedAt = new Date(clock.now()).toISOString();
    await within(() => deps.writeFile(path.join(outDir, `${take}.json`), JSON.stringify(res, null, 2)), 5000);
  }
  return res;
}

/* ------------------------------------------------------------ live wiring */

/** ffmpeg screen recording (avfoundation), stopped with "q"; stop() is idempotent and bounded. */
function ffmpegRecorder(file, dev, log) {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-capture_cursor', '1',
    '-capture_mouse_clicks', '0', '-framerate', '30', '-i', `${dev}:none`, '-c:v', 'libx264', '-preset', 'ultrafast',
    '-crf', '16', '-pix_fmt', 'yuv420p', file], { stdio: ['pipe', 'ignore', 'inherit'] });
  let exited = false;
  const done = new Promise(r => { p.on('exit', () => { exited = true; r(); }); p.on('error', (e) => { exited = true; log(`ffmpeg: ${e.message}`); r(); }); });
  p.stdin.on('error', () => {});
  const wait = (ms) => Promise.race([done, new Promise(r => setTimeout(r, ms).unref())]);
  let stopping = null;
  return {
    file,
    alive: () => !exited,
    stop: () => stopping ??= (async () => {
      if (!exited) { try { p.stdin.write('q'); p.stdin.end(); } catch {} await wait(6000); }
      if (!exited) { p.kill('SIGINT'); await wait(2000); }
      if (!exited) { p.kill('SIGKILL'); await wait(1000); }
      return exited;
    })()
  };
}

/**
 * The helper sessions this process opens, so the watchdog can end a takeover that is still inside an action.
 * src/index.js reaches the helper only through its bridge table; this wraps the session opener there and only
 * watches (the session itself is unchanged). SIGTERM is the helper's own "stop now": the running action stops at
 * its next check, the keyboard and mouse are let go, the veil fades and the helper exits (src/helper.swift
 * finish("signal")); the action then fails and runInputAction puts the owner's windows and pointer back.
 */
function trackHelperSessions(idx, B) {
  if (typeof idx.__setBridgeForTests !== 'function' || !(idx.__bridgeKeysForTests?.() || []).includes('openInputSession')) {
    throw new Error('src/index.js no longer lets the session opener be wrapped: the watchdog could not end a running action; not recording');
  }
  const live = new Set();
  idx.__setBridgeForTests({
    openInputSession: (o) => {
      const h = B.openInputSession(o);
      live.add(h);
      const close = h.close;
      h.close = () => { live.delete(h); return close(); };
      return h;
    }
  });
  return {
    endAll: async () => {
      const hs = [...live];
      for (const h of hs) { try { if (h.pid) process.kill(h.pid, 'SIGTERM'); } catch {} }
      await Promise.all(hs.map(h => Promise.race([h.close().catch(() => null), new Promise(r => setTimeout(r, 4000).unref())])));
      return hs.length;
    }
  };
}

async function main() {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  for (const [k, v] of Object.entries(ENV_IF_UNSET)) if (!process.env[k]) process.env[k] = v;
  const { requireUnlocked } = await import('./live-guard.mjs');
  await requireUnlocked();

  const [outArg, takeArg, dev = '4'] = process.argv.slice(2);
  const take = String(takeArg || '').toUpperCase();
  if (!outArg || !TAKES.includes(take)) {
    console.error('usage: node test/promo-record-v02.mjs <out_dir> <R0|R1|R2|R3> [screenDevice=4]');
    process.exit(2);
  }
  const outDir = path.resolve(outArg);
  if (outDir === REPO || outDir.startsWith(REPO + path.sep)) {
    console.error(`REFUSED: <out_dir> ${outDir} is inside the repository; raw screen recordings stay outside git (e.g. ~/work/chrome-bridge-promo-raw/v0.2).`);
    process.exit(2);
  }
  const fs = await import('node:fs');
  const fsp = await import('node:fs/promises');
  fs.mkdirSync(outDir, { recursive: true });
  if (!process.env.CHROME_BRIDGE_DEBUG_LOG) process.env.CHROME_BRIDGE_DEBUG_LOG = path.join(outDir, `${take}-debug.jsonl`);

  const B = await import('../src/bridge.js');
  const tabs = await import('../src/tabs.js');
  const idx = await import('../src/index.js');
  const { startFixtureServer } = await import('./fixtures/server.mjs');
  const log = (m) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const sessions = trackHelperSessions(idx, B);
  const clock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)) };
  // Source distributions omit experimental binaries. Keep R2's manual Esc path available.
  const autoEscBin = path.join(REPO, 'experiments', 'fakeuser');
  const deps = {
    clock, log,
    writeFile: (f, s) => fsp.writeFile(f, s),
    mainDisplay: async () => {
      const ds = (await B.cgevent(['displays'])).displays || [];
      const d = ds.find(x => x.isMain) || ds[0];
      if (!d) throw new Error('no display');
      return d.boundsPoints;
    },
    newWindow: (url, rect) => B.newWindow(url, rect),
    activate: (tab) => B.activateChrome(tab),
    registerTab: tabs.registerTab, forgetTab: tabs.forgetTab,
    listTabs: () => B.listTabs(), closeTab: (id) => B.closeTab(id),
    readPage: idx.readPage, click: idx.click, typeText: idx.typeText, taskPlan: idx.taskPlanTool,
    endTaskHold: idx.endTaskHold, waitForUser: idx.waitForUserTool,
    endHelperSessions: sessions.endAll,
    startRecorder: (name) => ffmpegRecorder(path.join(outDir, `${name}.mkv`), dev, log),
    startFixtureServer: () => startFixtureServer({ port: 0 }),
    autoEsc: take === 'R2' && fs.existsSync(autoEscBin) ? () => new Promise((res, rej) => {
      const p = spawn(autoEscBin, ['esc2', '4500', '550'], { stdio: ['ignore', 'pipe', 'inherit'] }); let out = '';
      p.on('error', rej);
      p.stdout.on('data', d => { out += d; }); p.on('exit', () => { try { res(JSON.parse(out)); } catch { res({ raw: out }); } });
    }) : null,
    onSignal: (fn) => { process.once('SIGINT', fn); process.once('SIGTERM', fn); }
  };
  const env = Object.fromEntries([...Object.keys(ENV), ...Object.keys(ENV_IF_UNSET), 'CHROME_BRIDGE_TAKEOVER', 'CHROME_BRIDGE_DEBUG_LOG']
    .map(k => [k, process.env[k] ?? null]));
  log(`${take}: recording to ${outDir} (screen device ${dev}); watchdog ${WATCHDOG_MS / 1000} s`);
  const res = await runTake(take, { outDir, deps, env });
  console.log(JSON.stringify({ take, file: res.recording && res.recording.file, takeoverMs: res.takeover.ms, watchdogFired: res.watchdog.fired,
    cancel: res.cancel ?? null, detection: res.detection ?? null, windows: res.windows, fatal: res.fatal, json: path.join(outDir, `${take}.json`) }, null, 1));
  process.exit(res.fatal ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
