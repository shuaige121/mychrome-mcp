/* upload_file through the production tool path (contract C6, field 2026-10-27 #2):
 * callTool → uploadFile → inputAction → guard.js runInputAction → the real `cgevent session` in DRY-RUN
 * (helper.swift opKey "file_panel" → opFilePanel). A jsdom page built from test/fixtures/site/upload.html
 * stands in for the tab, `_fake filePanel` (fired at the helper's own checkpoints) for the macOS Open panel.
 * No Chrome, no Apple Events, nothing posted to the real mouse or keyboard.
 *
 * Run: node test/upload-file.test.mjs */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

process.env.CHROME_BRIDGE_HABITS = 'off';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = await fs.readFile(path.join(ROOT, 'src/page/read.js'), 'utf8');
const fixtureHtml = await fs.readFile(path.join(ROOT, 'test/fixtures/site/upload.html'), 'utf8');

/** A page event marked trusted, as Chrome delivers it (jsdom's dispatchEvent always clears it). */
const jsdomUtils = createRequire(import.meta.url)(
  path.join(path.dirname(createRequire(import.meta.url).resolve('jsdom')), 'generated/idl/utils.js'));
function dispatchTrusted(target, event) {
  const ev = jsdomUtils.implForWrapper(event);
  ev.isTrusted = true;
  return jsdomUtils.implForWrapper(target)._dispatch(ev);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-bridge-upload-'));
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'input.lock');
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
process.env.CHROME_BRIDGE_NOTIFY = '0';
await fs.writeFile(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ windowId: 1 }));
const bridge = await import('../src/bridge.js');
const idx = await import('../src/index.js');
idx.__setRetryForTests({ maxMs: 0 });
idx.__setTakeoverForTests(true);

// The caller's file: its name is read back from the page; its bytes never are.
const FILE = path.join(tmp, 'Resume-2026.pdf');
await fs.writeFile(FILE, 'synthetic fixture bytes');

const BOUNDS = { left: 100, top: 60, width: 1400, height: 900 };
const TOOLBAR = 88;
const DISPLAYS = [{ id: 1, left: 0, top: 0, width: 1920, height: 1080, main: true }];
// `focus`: where AX says the keyboard is: the panel itself, its Go-to sheet `goto`, another sheet in it, or none.
const PANEL = { pid: 42, app: 'Google Chrome', window: 90, identifier: 'open-panel', shaped: true, focus: 'panel' };

let pg, log, opts, posted, controls, serial = 0;
let bounds = { ...BOUNDS }, identity = { chromePid: 42, cgWindow: 7, windowId: 1, tabId: 5 };

function page() {
  const dom = new JSDOM(fixtureHtml, { url: 'https://example.test/apply', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  // Layout stand-in: data-rect="x,y,w,h" in CSS px; "0" = no box.
  w.document.getElementById('pick').setAttribute('data-rect', '100,200,180,40');
  w.document.getElementById('resume').setAttribute('data-rect', '0');
  w.document.getElementById('plain').setAttribute('data-rect', '100,300,260,30');
  w.document.getElementById('shadowpick').setAttribute('data-rect', '100,500,160,36');
  w.document.getElementById('next').setAttribute('data-rect', '100,600,120,36');
  w.document.getElementById('bodyfile').setAttribute('data-rect', '400,600,260,30');
  w.document.getElementById('out').setAttribute('data-rect', '100,700,400,30');
  w.Element.prototype.getBoundingClientRect = function () {
    for (let a = this; a && a.nodeType === 1; a = a.parentElement) {
      if (w.getComputedStyle(a).display === 'none') return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, toJSON() { return this; } };
    }
    const spec = this.getAttribute('data-rect');
    let [x, y, width, height] = spec === '0' ? [0, 0, 0, 0] : spec ? spec.split(',').map(Number) : [0, 0, 1400, 812];
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() { return this; } };
  };
  w.Element.prototype.getClientRects = function () { const r = this.getBoundingClientRect(); return r.width || r.height ? [r] : []; };
  w.Range.prototype.getClientRects = function () {
    const host = this.startContainer.nodeType === 3 ? this.startContainer.parentElement : this.startContainer;
    return [host.getBoundingClientRect()];
  };
  // Only the laid-out controls take a press; the rest of the page is background.
  w.document.elementFromPoint = (x, y) => {
    let hit = null;
    for (const el of w.document.body.querySelectorAll('[data-rect]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit = el;
    }
    return hit || w.document.body;
  };
  for (const [key, value] of Object.entries({ outerWidth: bounds.width, outerHeight: bounds.height, innerWidth: bounds.width,
    innerHeight: bounds.height - TOOLBAR, screenX: bounds.left, screenY: bounds.top, devicePixelRatio: 2, scrollY: 0 })) {
    Object.defineProperty(w, key, { value, configurable: true });
  }
  w.document.hasFocus = () => true;
  w.eval(readSrc.replaceAll('__READ__', () => JSON.stringify({ full: true })));
  return { w, clicked: null };
}
const marker = (sel) => pg.w.__chromeBridge.markers.indexOf(pg.w.document.querySelector(sel));
const toView = (p) => ({ x: p.x - bounds.left, y: p.y - bounds.top - TOOLBAR });

/** The file input a click on `el` opens in Chrome: the input, a label's control, or one in its shadow root. */
const chooserOf = (el) => el && (el.tagName === 'LABEL' ? el.control : el.type === 'file' ? el
  : el.shadowRoot?.querySelector('input[type=file]') || null);
/**
 * Chrome after the Open panel's Open: the input that opened the panel (or `opts.fileTo`) gets the chosen
 * file (name only) and a trusted change event. `opts.pageClears`: the page's own change handler (after
 * ours) empties the input (a site that uploads on change). `opts.noChange`: the input ends up empty with
 * no change event at all. `opts.shows`: text the page then shows beside the input.
 */
function chromeChoosesFile(name) {
  const input = opts.fileTo ? pg.w.document.querySelector(opts.fileTo) : chooserOf(pg.clicked);
  assert.ok(input && input.type === 'file', 'the click landed on a file control');
  const set = (files) => Object.defineProperty(input, 'files', { value: files, configurable: true });
  set([new pg.w.File([''], name)]);
  if (opts.pageClears) input.addEventListener('change', () => set([]));
  if (opts.shows != null) {
    const note = pg.w.document.createElement('span');
    note.textContent = opts.shows;
    input.parentNode.append(note);
  }
  if (opts.noChange) { set([]); return; }
  dispatchTrusted(input, new pg.w.Event('change', { bubbles: true }));
}

function fakeBridge() {
  const target = (extra = {}) => ({ ok: true, ...identity, url: pg.w.location.href, title: 'upload fixture', tabActive: true,
    windowIndex: 1, minimized: false, tabCount: 1, bounds: { ...bounds }, frontmost: 'Google Chrome', ...extra });
  const nativeWindow = (r) => {
    assert.equal(r?.ok, true, 'the DRY native transaction must succeed');
    bounds = { ...r.bounds };
    return r;
  };
  return {
    activateChrome: async (tab, hint, route) => {
      const r = nativeWindow(await route.native({ kind: 'activate', tabId: tab, windowId: hint.windowId,
        ...(route.fitCurrent !== undefined ? { fitCurrent: route.fitCurrent } : {}) }));
      log.push('activate');
      return target({ ...r, url: pg.w.location.href, targetOnTop: true, keyWindowIsTarget: true, waitedMs: 40 });
    },
    chromeInfo: async () => { log.push('info'); return target(); },
    openTab: async () => { throw new Error('openTab reached in a test'); },
    closeTab: async () => { throw new Error('closeTab reached in a test'); },
    selectTab: async () => { throw new Error('selectTab reached in a test'); },
    newWindow: async () => { throw new Error('newWindow reached in a test'); },
    listTabs: async () => ({ ok: true, frontmost: 'Google Chrome', chromePid: 42,
      windows: [{ id: 1, index: 1, minimized: false, tabs: [{ id: 5, url: pg.w.location.href, title: 't', active: true }] }] }),
    pageDialog: async () => { log.push('pageDialog'); return { ok: true, open: false, known: true }; },
    answerDialog: async () => { throw new Error('answerDialog reached in a test'); },
    ensureScreenAwake: async () => ({ woke: false, displays: 1, locked: false }),
    axInput: async () => ({ ok: true, frontmost: true, windowMatches: true, nodeFound: true,
      nativePopup: false, menuOpen: false, nativeMenuOpen: false, documentToken: 'offline-page', segments: [], blocker: null }),
    axMenuState: async () => ({ ok: true, known: true, menuOpen: false }),
    pageContentRect: async ({ chromePid, cgWindow }) => ({ ok: true, pid: chromePid, cgWindow, source: 'ax-web-area',
      rect: { x: bounds.left, y: bounds.top + TOOLBAR, w: bounds.width, h: bounds.height - TOOLBAR },
      windowBounds: { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height } }),
    openNavigationObserver: async () => ({ startedAt: Date.now(), untouched: async () => true, close: async () => {} }),
    keepAwake: () => () => {},
    moveWindow: async () => { throw new Error('moveWindow reached in a test'); },
    captureRegion: async () => { throw new Error('captureRegion reached in a test'); },
    // PERM1: the private look at a Chrome popup (never reached here: no fixture reports a popup).
    captureWindow: async () => { throw new Error('captureWindow reached in a test'); },
    capturePageContent: async () => { throw new Error('capturePageContent reached in a test'); },
    ocrImage: async () => { throw new Error('ocrImage reached in a test'); },
    profiles: async () => ({ ok: true, default: 'Default', profiles: [] }),
    observePagePrompts: async () => ({ status: 'unavailable', reason: 'fixture_observer_disabled' }),
    disposePagePromptObserver: async () => {},
    evalInPage: async (src) => {
      log.push(/__chromeBridgeFiles/.test(src) && /"(arm|check)":/.test(src) ? 'files' : 'eval');
      const payload = JSON.parse(pg.w.eval(src));
      if (!payload.ok) throw new bridge.BridgeError(payload.error, payload.message);
      return { ...payload, bounds: { ...bounds }, target: target() };
    },
    cgevent: async (args) => {
      if (args[0] === 'idle') return { ok: true, idle: 100, keyIdle: 100, held: [] };
      if (args[0] === 'mousepos') return { ok: true, x: 11, y: 22 };
      if (args[0] === 'displays') return { ok: true, displays: [{ id: 1, isMain: true, boundsPoints: { x: 0, y: 0, w: 1920, h: 1080 } }],
        locked: false, displaysAsleep: false, mouse: { x: 11, y: 22 } };
      if (args[0] === 'warp') { log.push('warp'); return { ok: true }; }
      if (args[0] === 'windowsat') return { ok: true, windows: [{ owner: 'Google Chrome', id: 7, pid: 42, layer: 0, alpha: 1,
        bounds: { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height } }] };
      throw new Error(`unexpected cgevent ${args[0]}`);
    },
    snapshotScene: async () => { log.push('scene'); return { app: 'kitty', appPid: 9, chromePid: 42, chromeWindow: 1, chromeTab: 5 }; },
    restoreScene: async (_sc, o) => { await o.native({ kind: 'restoreScene' }, { policy: 'restore' }); log.push('restore'); return { ok: true }; },
    restoreApp: async (pid) => { log.push(`restoreApp ${pid}`); return { ok: true, appFrontmost: true }; },
    openInputSession: () => {
      log.push('session');
      const real = bridge.openInputSession({ env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: `upload${++serial}`,
        CHROME_BRIDGE_INPUT_SPEED: '3', CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.upload${process.pid}.${serial}` } });
      let init = null;
      const initialize = () => init ||= real.request({ op: '_native', seedBounds: { ...bounds }, displays: DISPLAYS }, { raw: true })
        .then(r => assert.equal(r?.ok, true, 'DRY native fixture configuration was rejected'));
      // A scripted system reaction, fired by the helper at its own checkpoint (or after N posted events).
      const control = (c) => real.request(c, { raw: true, timeoutMs: 600_000 })
        .then(r => { controls.push(r); }, () => {});
      return {
        get interrupted() { return real.interrupted; },
        close: async () => { await initialize(); return real.close(); },
        async request(o, ro) {
          await initialize();
          log.push(o.op === 'key' ? `key:${o.name}` : o.op);
          if (o.op === 'begin' || o.op === 'hold') {
            if (opts.frontChromeWindow) await real.request({ op: '_fake', frontChromeWindow: opts.frontChromeWindow }, { raw: true });
          }
          if (o.op === 'key' && o.name === 'file_panel') {
            opts.panelReq = o;
            for (const c of opts.panel || []) control(c);
          }
          const r = await real.request(o, ro).catch(e => { if (e.reply) posted.push(...(e.reply.posted || []).map(p => ({ ...p, op: o.op }))); throw e; });
          if (o.op === 'begin' && r.dryRun !== true) { await real.close(); throw new Error('helper is not in dry-run mode; stopping'); }
          posted.push(...(r.posted || []).map(p => ({ ...p, op: o.op })));
          if (o.op === 'click') {
            const v = toView(r.landed);
            pg.clicked = pg.w.document.elementFromPoint(v.x, v.y);
            log.push(`click on ${pg.clicked && pg.clicked.id}`);
          }
          if (o.op === 'key' && o.name === 'file_panel' && r.ok && opts.chromeGivesFile !== false) {
            chromeChoosesFile(typeof opts.chromeGivesFile === 'string' ? opts.chromeGivesFile : path.basename(o.path));
          }
          return r;
        }
      };
    }
  };
}

function fresh(o = {}) {
  idx.__resetPanelTaskForTests();
  idx.__resetLedgerForTests();
  pg = page(); log = []; opts = o; posted = []; controls = [];
  bounds = { ...BOUNDS }; identity = { chromePid: 42, cgWindow: 7, windowId: 1, tabId: 5 };
  const fake = fakeBridge();
  const real = idx.__bridgeKeysForTests().filter(k => !(k in fake) && k !== 'pageScript');
  if (real.length) throw new Error(`the test bridge does not fake ${real.join(', ')}: that would reach the real Chrome`);
  idx.__setBridgeForTests(fake);
}

/** The Open panel's life as macOS would show it to the helper, keyed to the helper's checkpoints. */
const panelAppears = { op: '_fake', at: 'file_panel_wait', frontChromeWindow: 90, filePanel: PANEL };
const gotoAppears = { op: '_fake', at: 'file_panel_goto', frontChromeWindow: 91, filePanel: { ...PANEL, focus: 'goto', goto: 91 } };
const gotoCloses = { op: '_fake', at: 'file_panel_go', frontChromeWindow: 90, filePanel: PANEL };
const panelCloses = { op: '_fake', at: 'file_panel_open', frontChromeWindow: 7, filePanel: null };
const NORMAL = [panelAppears, gotoAppears, gotoCloses, panelCloses];

const call = (args) => idx.callTool({ params: { name: 'upload_file', arguments: { tab: 5, ...args } } }, {});
const text = (r) => r.content.map(c => c.text || '').join('\n');
const keyDowns = (op = 'key') => posted.filter(p => p.op === op && p.type === 'keyDown');
const typedText = () => keyDowns().filter(p => p.unicode).map(p => p.unicode).join('');
/**
 * Stop (A1 ruling): from the `stopAt`-th event of the Open-panel op on, only releases of keys and modifiers
 * that op itself still held (keyUp / flagsChanged lowering the flags): no key-down, no pointer event,
 * nothing from a later request; and nothing is left held.
 */
function onlyReleasesAfter(stopAt) {
  const first = posted.findIndex(p => p.op === 'key');
  assert.ok(first >= 0, 'the Open-panel op posted something before the stop');
  assert.ok(posted.slice(first).every(p => p.op === 'key'), `no other request posted after the panel op: ${JSON.stringify(posted.slice(first).map(p => p.op))}`);
  const events = posted.slice(first), held = new Set();
  let flags = [];
  events.forEach((e, i) => {
    if (i >= stopAt) {
      assert.ok(e.type === 'keyUp' || e.type === 'flagsChanged', `event ${i} after Stop is ${e.type}`);
      if (e.type === 'keyUp') assert.ok(held.has(e.key), `keyUp ${e.key} after Stop releases nothing held`);
      if (e.type === 'flagsChanged') assert.ok(e.flags.length < flags.length, `flagsChanged after Stop presses ${e.flags}`);
    }
    if (e.type === 'keyDown') held.add(e.key);
    if (e.type === 'keyUp') held.delete(e.key);
    if (e.type === 'flagsChanged') flags = e.flags;
  });
  assert.equal(held.size, 0, 'no key left down');
  assert.deepEqual(flags, [], 'no modifier left down');
  assert.ok(events.length > stopAt, 'something was held at the stop point');
}
const noControlMisrouted = () => assert.ok(!controls.some(r => r?.error === 'bad_request'), `a scripted control was read as a request: ${JSON.stringify(controls)}`);

// Optional focused rerun (RED checks); the default runs every group and says how many were skipped.
const FILTER = process.env.UPLOAD_FILE_TEST_FILTER || '';
let passed = 0, skipped = 0;
async function check(name, fn) {
  if (FILTER && !name.includes(FILTER)) { skipped++; return; }
  await fn(); passed++; console.log(`  ok  ${name}`);
}

console.log('upload_file (jsdom page + the helper in DRY-RUN; nothing posted)');

await check('tool definition: upload_file takes marker + path, and the 19 tools stay within 15,000 characters', async () => {
  const tools = idx.__toolsForTests();
  const tool = tools.find(t => t.name === 'upload_file');
  assert.ok(tool, 'upload_file is listed');
  assert.deepEqual(tool.inputSchema.required, ['marker', 'path']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tools.length, 19);
  assert.ok(JSON.stringify(tools).length <= 15000);
});

await check('normal path: label click → this Chrome\'s Open panel → Cmd+Shift+G → path key by key → Return, Return → page shows the file name', async () => {
  fresh({ panel: NORMAL });
  const m = marker('#pick');
  assert.ok(m > 0, 'the upload label has a read_page marker');
  const r = await call({ marker: m, path: FILE });
  assert.notEqual(r.isError, true, text(r));
  assert.match(text(r), /✅ 已通过「打开」面板选择「Resume-2026\.pdf」，\[\d+\] 的文件框已收到它/);
  noControlMisrouted();
  // The real click went to the label (the fixture's hidden input is its control).
  assert.ok(log.includes('click on pick'), log.join(','));
  assert.equal(log.filter(x => x === 'click').length, 1);
  // One helper op typed it: Cmd+Shift+G first, then exactly the path, then two Returns; no Esc, no paste.
  const downs = keyDowns();
  assert.deepEqual([downs[0].key, downs[0].flags], [5, ['shift', 'cmd']], 'Cmd+Shift+G');
  assert.equal(typedText(), FILE, 'the path, one real key per character');
  assert.deepEqual(downs.slice(-2).map(d => [d.key, d.flags]), [[36, []], [36, []]], 'Return (Go to Folder), Return (Open)');
  assert.equal(downs.filter(d => d.key === 53).length, 0, 'no Esc on the normal path');
  assert.equal(downs.length, 1 + FILE.length + 2);
  assert.equal(posted.filter(p => p.op === 'paste').length, 0);
  // Modifiers were released after the chord: the path keys carry no Cmd.
  assert.ok(downs.slice(1).every(d => !d.flags.includes('cmd')), 'no Cmd held while typing the path');
  // The page read the file name; the scene was put back afterwards.
  assert.equal(pg.w.document.getElementById('out').textContent, 'selected: Resume-2026.pdf');
  assert.ok(log.indexOf('restore') > log.indexOf('key:file_panel'), log.join(','));
  assert.equal(r.structuredContent, undefined);
});

await check('panel never appears: error after the click, no key sent, input given back, not retried', async () => {
  fresh({ panel: [] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.isError, true);
  assert.match(text(r), /已点击 \[\d+\]，但 6 秒内没有出现 Chrome 的「打开」面板，没有输入路径/);
  assert.deepEqual(r.structuredContent.error, { code: 'file_panel_missing', stage: 'unobserved', inputDelivery: 'sent' });
  assert.equal(keyDowns().length, 0, 'nothing typed');
  assert.equal(log.filter(x => x === 'click').length, 1, 'the click was not repeated');
  assert.ok(log.includes('restore'), 'the user\'s scene was put back');
  assert.equal(pg.w.document.getElementById('out').textContent, 'no file');
});

await check('panel owned by another app: refused by name, no key sent, nothing of that app pressed', async () => {
  fresh({ panel: [{ op: '_fake', at: 'file_panel_wait', frontPid: 4242,
    filePanel: { pid: 4242, app: 'Preview', window: 300, identifier: 'open-panel', shaped: true, focus: 'panel' } }] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.isError, true);
  assert.match(text(r), /键盘焦点在「Preview」上，不在这个 Chrome 的「打开」面板里；为了不把路径打进别的程序，没有输入路径/);
  assert.equal(r.structuredContent.error.code, 'file_panel_other_app');
  assert.equal(keyDowns().length, 0);
  noControlMisrouted();
});

await check('a Chrome sheet that is not an Open panel (no "open-panel" identifier): no key, not even Esc', async () => {
  fresh({ panel: [{ ...panelAppears, filePanel: { ...PANEL, identifier: '' } }] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'file_panel_unidentified');
  assert.match(text(r), /无法确认是「打开」面板，没有输入路径，也没有按键关闭它/);
  assert.equal(keyDowns().length, 0);
});

await check('path does not exist (or is relative, a folder, or not typeable): refused before any lock, session or input', async () => {
  for (const [p, code] of [[path.join(tmp, 'missing.pdf'), 'upload_path_missing'], [tmp, 'upload_path_missing'],
    ['Resume-2026.pdf', 'upload_path_invalid'], [`${tmp}/../${path.basename(tmp)}/Resume-2026.pdf`, 'upload_path_invalid'],
    [path.join(tmp, '简历.pdf'), 'upload_path_invalid'], ['~/Resume-2026.pdf', 'upload_path_invalid']]) {
    fresh({ panel: NORMAL });
    const r = await call({ marker: marker('#pick'), path: p });
    assert.equal(r.isError, true, p);
    assert.deepEqual(r.structuredContent.error, { code, stage: 'unobserved', inputDelivery: 'not_sent' }, p);
    assert.match(text(r), /没有点击或输入/);
    assert.deepEqual(log.filter(x => ['session', 'hold', 'begin', 'click', 'activate'].includes(x)), [], `${p}: ${log.join(',')}`);
  }
});

await check('a disabled file input is refused before the click (locate.js reports the file control)', async () => {
  fresh({ panel: NORMAL });
  pg.w.document.getElementById('plain').disabled = true;
  const r = await call({ marker: marker('#plain'), path: FILE });
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent.error, { code: 'disabled_field', stage: 'unobserved', inputDelivery: 'not_sent' });
  assert.equal(log.filter(x => x === 'click').length, 0);
  assert.equal(keyDowns().length, 0);
});

await check('the file disappears after the call started: refused at the click boundary, nothing pressed', async () => {
  const gone = path.join(tmp, 'gone.pdf');
  await fs.writeFile(gone, 'x');
  fresh({ panel: NORMAL });
  // Removed once the hold exists: after the preflight's check, before the action's.
  const b = fakeBridge(), snapshot = b.snapshotScene;
  idx.__setBridgeForTests({ ...b, snapshotScene: async () => { await fs.rm(gone, { force: true }); return snapshot(); } });
  const r = await call({ marker: marker('#pick'), path: gone });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'upload_path_missing');
  assert.equal(log.filter(x => x === 'click').length, 0);
  assert.equal(keyDowns().length, 0);
});

await check('Stop (Esc twice) while the path is being typed: user_cancelled, typing stops, no Return or Esc sent, panel left for the user', async () => {
  fresh({ panel: [panelAppears, gotoAppears, gotoCloses, panelCloses,
    { op: '_inject', kind: 'esc', afterPosted: 11 }, { op: '_inject', kind: 'esc', afterPosted: 11 }] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'user_cancelled');
  assert.match(text(r), /按了两次 Esc/);
  assert.match(text(r), /路径已逐键输入 \d+ 个字符。「打开」面板可能仍开着：请用户点「取消」关闭它，agent 不要再按键/);
  const downs = keyDowns();
  assert.ok(typedText().length > 0 && typedText().length < FILE.length, `stopped part way: ${typedText()}`);
  assert.equal(downs.filter(d => d.key === 36 || d.key === 53).length, 0, 'no Return or Esc after Stop');
  onlyReleasesAfter(11);
  assert.equal(log.filter(x => x === 'click').length, 1, 'not retried');
  assert.equal(pg.w.document.getElementById('out').textContent, 'no file');
  noControlMisrouted();
});

await check('another app takes the keyboard while the path is typed: the next key is refused, no Esc sent into it, panel left for the user', async () => {
  fresh({ panel: [panelAppears, gotoAppears, gotoCloses, panelCloses,
    { op: '_fake', afterPosted: 12, frontPid: 4242, filePanel: { ...PANEL, pid: 4242, app: 'Preview', focus: 'goto', goto: 91 } }] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'guard_not_frontmost');
  assert.match(text(r), /Chrome 不再是最前面的 App，没有继续按键。\n路径已逐键输入 \d+ 个字符。「打开」面板可能仍开着/);
  assert.ok(typedText().length > 0 && typedText().length < FILE.length, typedText());
  assert.equal(keyDowns().filter(d => d.key === 36 || d.key === 53).length, 0, 'no Return, no Esc into the other app');
  noControlMisrouted();
});

await check('Go to Folder never appears: the panel is closed with Esc into the verified panel only, nothing typed', async () => {
  fresh({ panel: [panelAppears, { op: '_fake', at: 'file_panel_esc', frontChromeWindow: 7, filePanel: null }] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'file_panel_goto_missing');
  assert.match(text(r), /按 Cmd\+Shift\+G 后没有出现「前往文件夹」输入框，没有输入路径。\n「打开」面板已关闭，网页没有收到文件/);
  assert.equal(typedText(), '');
  assert.deepEqual(keyDowns().map(d => d.key), [5, 53], 'Cmd+Shift+G, then one Esc');
});

await check('Chrome keeps the file to itself: the panel closed but the page shows no file name → upload_unconfirmed, not repeated', async () => {
  fresh({ panel: NORMAL, chromeGivesFile: false });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent.error, { code: 'upload_unconfirmed', stage: 'unobserved', inputDelivery: 'sent' });
  assert.match(text(r), /未能从 \[\d+\] 的文件框确认文件名「Resume-2026\.pdf」.*先 read_page 或 screenshot 核对，不要重复上传/s);
  assert.equal(log.filter(x => x === 'click').length, 1);
});

await check('the page got a different file than asked: refused as upload_unconfirmed without reading that file\'s name', async () => {
  fresh({ panel: NORMAL, chromeGivesFile: 'Other.pdf' });
  const r = await call({ marker: marker('#plain'), path: FILE });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'upload_unconfirmed');
  assert.match(text(r), /\[\d+\] 的文件框收到的不是「Resume-2026\.pdf」.*请用户检查并移除这个文件/s);
  assert.doesNotMatch(text(r), /Other\.pdf/, 'the other file is not named');
  assert.ok(log.includes('click on plain'), log.join(','));
});

await check('A1 Stop while Cmd+Shift+G is held: after Stop only the releases of G, Shift and Cmd go out, then nothing', async () => {
  fresh({ panel: [...NORMAL, { op: '_inject', kind: 'esc', afterPosted: 3 }, { op: '_inject', kind: 'esc', afterPosted: 3 }] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.structuredContent.error.code, 'user_cancelled');
  const events = posted.filter(p => p.op === 'key');
  assert.deepEqual(events.slice(0, 3).map(e => [e.type, e.key]), [['flagsChanged', 55], ['flagsChanged', 56], ['keyDown', 5]]);
  assert.deepEqual(events.slice(3).map(e => [e.type, e.key, e.flags]),
    [['keyUp', 5, ['shift', 'cmd']], ['flagsChanged', 56, ['cmd']], ['flagsChanged', 55, []]]);
  onlyReleasesAfter(3);
  assert.equal(typedText(), '');
  assert.match(text(r), /「打开」面板可能仍开着：请用户点「取消」关闭它/);
});

await check('A2 the keyboard moves to another sheet inside the panel while the CG front window stays the Go-to sheet: the next key is refused, no Esc', async () => {
  fresh({ panel: [...NORMAL,
    { op: '_fake', afterPosted: 12, frontChromeWindow: 91, filePanel: { ...PANEL, focus: 'sub', goto: 92, field: true } }] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'guard_key_window');
  assert.match(text(r), /键盘焦点已不在这个 Chrome 的「打开」面板里，没有继续按键/);
  assert.ok(typedText().length > 0 && typedText().length < FILE.length, `stopped part way: ${typedText()}`);
  assert.equal(keyDowns().filter(d => d.key === 36 || d.key === 53).length, 0, 'no Return, no Esc into an unverified sheet');
  noControlMisrouted();
});

await check('A2 a sheet that was already open before Cmd+Shift+G is not taken for Go to Folder: nothing typed', async () => {
  fresh({ panel: [{ ...panelAppears, filePanel: { ...PANEL, goto: 91 } }, gotoAppears] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.structuredContent.error.code, 'file_panel_goto_missing');
  assert.equal(typedText(), '');
  assert.deepEqual(keyDowns().map(d => d.key), [5], 'only Cmd+Shift+G; no Esc into an unverified sheet');
});

await check('A2 a new sheet with a text field that is not parented to the verified panel is not Go to Folder: nothing typed', async () => {
  fresh({ panel: [panelAppears, { ...gotoAppears, filePanel: { ...PANEL, focus: 'goto', goto: 91, gotoParent: 'other' } }] });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.structuredContent.error.code, 'file_panel_goto_missing');
  assert.equal(typedText(), '');
  assert.deepEqual(keyDowns().map(d => d.key), [5]);
});

await check('A3 upload_file refuses before any input when the takeover is off', async () => {
  idx.__setTakeoverForTests(false);
  try {
    fresh({ panel: NORMAL });
    const r = await call({ marker: marker('#pick'), path: FILE });
    assert.deepEqual(r.structuredContent.error, { code: 'upload_takeover_required', stage: 'unobserved', inputDelivery: 'not_sent' });
    assert.deepEqual(log.filter(x => ['session', 'hold', 'begin', 'click', 'activate'].includes(x)), []);
  } finally { idx.__setTakeoverForTests(true); }
});

await check('A3 the native Open-panel op refuses unless upload_file armed it in this session under an active hold (one use)', async () => {
  const open = () => bridge.openInputSession({ env: { ...process.env, CGEVENT_DRYRUN: '1', CHROME_BRIDGE_INPUT_SPEED: '3',
    CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.upload${process.pid}.${++serial}` } });
  const begin = { op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 100, y: 60, w: 1400, h: 900 } };
  const panelOp = (token) => ({ op: 'key', name: 'file_panel', path: FILE, appearMs: 300, settleMs: 300, ...(token ? { token } : {}) });
  const TOKEN = 'a'.repeat(32);
  // No hold (polite session): neither arming nor the op.
  let s = open();
  try {
    assert.equal((await s.request(begin, { raw: true })).dryRun, true);
    const armed = await s.request({ op: 'key', name: 'file_panel_begin', token: TOKEN }, { raw: true });
    assert.equal(armed.error, 'file_panel_not_held');
    const r = await s.request(panelOp(TOKEN), { raw: true });
    assert.equal(r.error, 'file_panel_not_armed'); assert.deepEqual(r.posted, []);
  } finally { await s.close(); }
  // Held, but not armed / wrong token / armed then consumed.
  s = open();
  try {
    assert.equal((await s.request({ op: 'hold' }, { raw: true })).ok, true);
    assert.equal((await s.request(begin, { raw: true })).dryRun, true);
    let r = await s.request(panelOp(TOKEN), { raw: true });
    assert.equal(r.error, 'file_panel_not_armed'); assert.deepEqual(r.posted, []);
    assert.equal((await s.request({ op: 'key', name: 'file_panel_begin', token: TOKEN }, { raw: true })).ok, true);
    r = await s.request(panelOp('b'.repeat(32)), { raw: true });
    assert.equal(r.error, 'file_panel_not_armed', 'a wrong token also consumes the arming'); assert.deepEqual(r.posted, []);
    r = await s.request(panelOp(TOKEN), { raw: true });
    assert.equal(r.error, 'file_panel_not_armed'); assert.deepEqual(r.posted, []);
    assert.equal((await s.request({ op: 'key', name: 'file_panel_begin', token: TOKEN }, { raw: true })).ok, true);
    r = await s.request(panelOp(TOKEN), { raw: true });
    assert.equal(r.error, 'file_panel_missing', 'armed: the op runs (no panel in this session)'); assert.deepEqual(r.posted, []);
    r = await s.request(panelOp(TOKEN), { raw: true });
    assert.equal(r.error, 'file_panel_not_armed', 'one arming, one op'); assert.deepEqual(r.posted, []);
    assert.equal((await s.request({ op: 'key', name: 'file_panel_begin', token: TOKEN }, { raw: true })).ok, true);
    assert.equal((await s.request({ op: 'key', name: 'file_panel_end' }, { raw: true })).ok, true);
    r = await s.request(panelOp(TOKEN), { raw: true });
    assert.equal(r.error, 'file_panel_not_armed', 'file_panel_end disarms'); assert.deepEqual(r.posted, []);
  } finally { await s.close(); }
});

await check('A5 a longer name that contains the requested one (Other-Resume-2026.pdf) is not a match: upload_unconfirmed', async () => {
  fresh({ panel: NORMAL, chromeGivesFile: 'Other-Resume-2026.pdf' });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'upload_unconfirmed');
  assert.match(text(r), /文件框收到的不是「Resume-2026\.pdf」/);
  assert.doesNotMatch(text(r), /Other-Resume/);
  assert.equal(pg.w.document.getElementById('out').textContent, 'selected: Other-Resume-2026.pdf', 'the page itself shows the longer name');
});

await check('A5 (i) the page empties the input in its own change handler after a trusted change with the exact name: confirmed', async () => {
  fresh({ panel: NORMAL, pageClears: true });
  const r = await call({ marker: marker('#plain'), path: FILE });
  assert.notEqual(r.isError, true, text(r));
  assert.match(text(r), /文件框已收到它/);
  assert.doesNotMatch(text(r), /旁边显示/);
  assert.equal(pg.w.document.getElementById('plain').files.length, 0, 'the page did empty it');
});

await check('A5 (ii) the input ends up empty with no change event while the page shows the exact name beside it: upload_unconfirmed', async () => {
  fresh({ panel: NORMAL, noChange: true, shows: 'uploaded: Resume-2026.pdf' });
  const r = await call({ marker: marker('#plain'), path: FILE });
  assert.equal(r.structuredContent?.error?.code, 'upload_unconfirmed', text(r));
  assert.match(text(r), /read_page/);
});

await check('A4 a file input directly in <body>: no trusted change, the exact name elsewhere in the body: upload_unconfirmed', async () => {
  fresh({ panel: NORMAL, noChange: true, shows: 'Resume-2026.pdf' });
  const m = marker('#bodyfile');
  assert.ok(m > 0, 'the body-level input has a marker');
  const r = await call({ marker: m, path: FILE });
  assert.equal(r.structuredContent?.error?.code, 'upload_unconfirmed', text(r));
  assert.ok(pg.w.document.body.textContent.includes('Resume-2026.pdf'), 'the exact name is in the body text');
});

await check('A5 a trusted change carrying "Other Resume-2026.pdf" (space before the name) is not that file: upload_unconfirmed', async () => {
  fresh({ panel: NORMAL, chromeGivesFile: 'Other Resume-2026.pdf' });
  const r = await call({ marker: marker('#plain'), path: FILE });
  assert.equal(r.structuredContent?.error?.code, 'upload_unconfirmed', text(r));
  assert.match(text(r), /收到的不是「Resume-2026\.pdf」/);
});

await check('A5 a change on another, unbound file input does not confirm this upload', async () => {
  fresh({ panel: NORMAL, fileTo: '#plain' });
  const r = await call({ marker: marker('#pick'), path: FILE });
  assert.equal(r.structuredContent?.error?.code, 'upload_unconfirmed', text(r));
  assert.equal(pg.w.document.getElementById('out').textContent, 'selected: Resume-2026.pdf', 'the other input did get it');
});

await check('A5 an uploader whose file input is in an open shadow root: bound through the button; exact name confirms, a longer one does not', async () => {
  fresh({ panel: NORMAL });
  const m = marker('#shadowpick');
  assert.ok(m > 0, 'the shadow uploader has a marker');
  let r = await call({ marker: m, path: FILE });
  assert.notEqual(r.isError, true, text(r));
  assert.match(text(r), /文件框已收到它/);
  fresh({ panel: NORMAL, chromeGivesFile: 'Other-Resume-2026.pdf' });
  r = await call({ marker: marker('#shadowpick'), path: FILE });
  assert.equal(r.structuredContent?.error?.code, 'upload_unconfirmed', text(r));
  assert.equal(pg.w.document.getElementById('cvname').textContent, 'Other-Resume-2026.pdf');
});

await check('A4 a marker with no file input of its own, or a private file input, is refused before the click', async () => {
  fresh({ panel: NORMAL });
  let r = await call({ marker: marker('#next'), path: FILE });
  assert.deepEqual(r.structuredContent.error, { code: 'wrong_field', stage: 'unobserved', inputDelivery: 'not_sent' });
  assert.match(text(r), /找不到 \[\d+\] 对应的唯一文件框/);
  assert.equal(log.filter(x => x === 'click').length, 0);
  fresh({ panel: NORMAL });
  const plain = pg.w.document.getElementById('plain');
  pg.w.__chromeBridgePrivate = { set: new pg.w.WeakSet([plain]), like: [], forms: new pg.w.WeakSet() };
  r = await call({ marker: marker('#plain'), path: FILE });
  assert.deepEqual(r.structuredContent.error, { code: 'wrong_field', stage: 'unobserved', inputDelivery: 'not_sent' });
  assert.match(text(r), /文件框已交给用户处理/);
  assert.equal(log.filter(x => x === 'click').length, 0);
});

await check('B2 the page-side listener is gone after success, a panel error and Stop', async () => {
  for (const [o, code] of [[{ panel: NORMAL }, null], [{ panel: [] }, 'file_panel_missing'],
    [{ panel: [...NORMAL, { op: '_inject', kind: 'esc', afterPosted: 3 }, { op: '_inject', kind: 'esc', afterPosted: 3 }] }, 'user_cancelled']]) {
    fresh(o);
    const r = await call({ marker: marker('#pick'), path: FILE });
    assert.equal(r.structuredContent?.error?.code ?? null, code, text(r));
    assert.equal(pg.w.__chromeBridgeFiles ?? null, null, `${code}: listener still armed`);
  }
});

await check('the exemption lives only inside upload_file: press_key with the panel in front is refused by the target-window guard', async () => {
  fresh({ frontChromeWindow: 90 });
  const r = await idx.callTool({ params: { name: 'press_key', arguments: { tab: 5, key: 'enter' } } }, {});
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'guard_key_window');
  assert.equal(keyDowns().length, 0);
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`upload-file: ${passed} groups passed${skipped ? `, ${skipped} skipped by UPLOAD_FILE_TEST_FILTER` : ''}`);
process.exit(0);
