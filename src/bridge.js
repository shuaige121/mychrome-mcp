import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const CHROMECTL = path.join(ROOT, 'bin', 'chromectl');
const CGEVENT = path.join(ROOT, 'bin', 'cgevent');

/** Errors that carry a ready-to-show Chinese message. */
export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const CHINESE = {
  js_from_apple_events_disabled: [
    '❌ Chrome 还没有允许「来自 Apple 事件的 JavaScript」，所以读不了网页。',
    '',
    '请在 Chrome 里点一次（只需要设置这一次）：',
    '  菜单栏「显示」→「开发者」→ 勾选「允许来自 Apple 事件的 JavaScript」',
    '  英文界面是 View → Developer → Allow JavaScript from Apple Events',
    '',
    '如果看不到「开发者」菜单，先到「Chrome →「设置」→「高级」里打开开发者选项，或直接在地址栏访问 chrome://settings/ 搜索 Developer。',
    '勾选之后重新试一次即可，不需要重启 Chrome。'
  ].join('\n'),

  no_automation_permission: [
    '❌ 系统没有允许当前这个 App 控制 Google Chrome。',
    '',
    '请打开 系统设置 →「隐私与安全性」→「自动化」，',
    '找到运行本工具的 App（通常是你的终端，例如 Terminal / iTerm / kitty / Claude Code），',
    '把它下面的「Google Chrome」打上勾，然后重新运行一次。'
  ].join('\n'),

  no_accessibility: [
    '❌ 系统没有给当前这个 App「辅助功能」权限，所以没法模拟鼠标和键盘。',
    '',
    '请打开 系统设置 →「隐私与安全性」→「辅助功能」，',
    '把运行本工具的 App（通常是你的终端，例如 Terminal / iTerm / kitty）打上勾，',
    '然后完全退出并重新打开该 App。'
  ].join('\n'),

  no_screen_recording: [
    '❌ 系统没有给当前这个 App「屏幕录制」权限，所以截不了 Chrome 窗口（截图识字要用它），这次没有截图。',
    '',
    '请打开 系统设置 →「隐私与安全性」→「屏幕录制」（新版 macOS 叫「录屏与系统录音」），',
    '把运行本工具的 App（通常是你的终端）打上勾，然后按提示退出并重新打开该 App。',
    '英文界面是 System Settings → Privacy & Security → Screen Recording（Screen & System Audio Recording）。',
    'MyChrome 不会自己弹出系统的授权框。'
  ].join('\n'),

  chrome_not_running: '❌ Google Chrome 没有在运行。请先打开 Chrome，再重试。（本工具不会自己启动或关闭 Chrome。）',

  no_window: '❌ Chrome 正在运行，但没有可用的窗口。请先打开一个 Chrome 窗口。',

  helper_missing: [
    '❌ 找不到鼠标/键盘助手程序 bin/cgevent。',
    '请在项目目录里运行一次：npm run build'
  ].join('\n')
};

export function humanMessage(code, fallback) {
  return CHINESE[code] || fallback || `❌ 出错了：${code}`;
}

/** Failures that are a one-time setup step `mychrome-mcp doctor` walks the user through. */
export const SETUP_CODES = new Set(['js_from_apple_events_disabled', 'no_automation_permission', 'no_accessibility',
  'no_screen_recording', 'helper_missing']);

/** The line a tool reply ends with when it failed for a setup reason ('' otherwise). */
export function setupHint(code) {
  if (!SETUP_CODES.has(code)) return '';
  const local = `node "${path.join(ROOT, 'src', 'index.js')}" doctor`;
  return `\n给 agent：这是一次性的设置问题，请用户在终端运行 mychrome-mcp doctor（本机：${local}），按它的提示逐项设置。` +
    ' / For the agent: a one-time setup problem; ask the user to run mychrome-mcp doctor in a terminal and follow its steps.';
}

/* ------------------------------------------------------------ chromectl */

/** Read native roles only. Never use the warm pool: its first Apple Event can
 * block while a macOS menu is open. The native command has its own AX deadline. */
export async function axInput({ pid, window, point = null }) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(window) || window <= 0 ||
      (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y)))) {
    throw new BridgeError('bad_native_target', '❌ 原生控件检查缺少已验证的 Chrome 窗口，没有操作。');
  }
  const argv = ['axinput', String(pid), '--window', String(window),
    ...(point ? ['--point', String(point.x), String(point.y)] : ['--focus'])];
  return coldNativeProbe(argv);
}

/** Inspect only the frontmost Chrome's menu state; never infer tab ownership or send input. */
export function axMenuState() {
  return coldNativeProbe(['axmenustate']);
}

async function coldNativeProbe(argv) {
  let result;
  try {
    const { stdout } = await execFileP(CHROMECTL, argv, { timeout: 3000, maxBuffer: 64 * 1024 });
    result = JSON.parse(stdout.trim());
  } catch (error) {
    throw new BridgeError(error.code === 'ENOENT' ? 'helper_missing' : 'ax_probe_failed',
      error.code === 'ENOENT' ? humanMessage('helper_missing') : '❌ 无法及时确认原生控件状态，这次没有输入；如有系统菜单，请先手动按 Esc 关闭。');
  }
  if (!result.ok) throw new BridgeError(result.error || 'ax_probe_failed', humanMessage(result.error, result.message));
  return result;
}

/**
 * Every Chrome call goes through bin/chromectl, which addresses ONE Chrome
 * process by pid (ScriptingBridge). The earlier AppleScript/JXA drivers
 * addressed "Google Chrome" by name, and macOS delivered those events to
 * whichever instance it chose: with a Hermes PDF job's headless Chrome
 * running, every call saw 0 windows (2026-09-28). chromectl skips --headless
 * processes and prefers the one with windows on screen; CHROME_BRIDGE_PID
 * overrides.
 */
/*
 * Warm chromectl processes (`chromectl --warm`): each has already started,
 * chosen the Chrome process and made its first Apple Event round trip, and
 * waits for one command. Measured: `scene` 15 ms warm vs ~190 ms cold. A few
 * are kept ready and replaced as they are used; one older than WARM_MAX_AGE_MS
 * is retired (its choice of Chrome process may be stale). CHROME_BRIDGE_WARM=0
 * turns this off.
 */
const WARM_ON = process.env.CHROME_BRIDGE_WARM !== '0';
const WARM_POOL = 3;
const WARM_MAX_AGE_MS = 10 * 60_000;
const warmPool = [];
function spawnWarm() {
  const child = spawn(CHROMECTL, ['--warm'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { child, out: '', err: '', dead: false, born: Date.now() };
  child.stdout.on('data', d => { w.out += d; });
  child.stderr.on('data', d => { w.err += d; });
  w.done = new Promise(res => child.on('exit', () => { w.dead = true; res(); }));
  child.on('error', () => { w.dead = true; });
  // Warm processes must not keep a script (or the tests) alive.
  child.unref(); child.stdin.unref?.(); child.stdout.unref?.(); child.stderr.unref?.();
  return w;
}
function takeWarm() {
  let w = null;
  while (warmPool.length && !w) {
    const c = warmPool.shift();
    if (!c.dead && Date.now() - c.born < WARM_MAX_AGE_MS) w = c;
    else if (!c.dead) c.child.kill();
  }
  while (warmPool.length < WARM_POOL) warmPool.push(spawnWarm());
  return w;
}
async function runWarm(w, argv) {
  w.child.stdin.end(JSON.stringify(argv.map(String)) + '\n');
  const timer = setTimeout(() => w.child.kill('SIGKILL'), 25000);
  await w.done;
  clearTimeout(timer);
  return { stdout: w.out, stderr: w.err };
}

async function runDriver(args, tab = null, { cold = false, retryEmptyOutput = true } = {}) {
  const argv = tab != null ? [...args, '--tab', String(tab)] : args;
  let stdout;
  try {
    const w = !cold && WARM_ON ? takeWarm() : null;
    const runCold = () => execFileP(CHROMECTL, argv.map(String), { timeout: 25000, maxBuffer: 32 * 1024 * 1024 });
    let r = w ? await runWarm(w, argv) : await runCold();
    // A pre-started process that answered nothing (it died, or Chrome dropped the Apple event):
    // once more with a fresh one (seen live twice in round 5). Eval opts out:
    // missing output cannot prove that its script did not already execute.
    if (retryEmptyOutput && w && !String(r.stdout || '').trim()) r = await runCold();
    if (process.env.CHROMECTL_TRACE === '1' && r.stderr) process.stderr.write(`chromectl ${argv[0]}:\n${r.stderr}`);
    stdout = r.stdout;
    if (!String(stdout || '').trim()) throw Object.assign(new Error(r.stderr || 'chromectl gave no output'), { stdout: '', stderr: r.stderr });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new BridgeError('helper_missing', humanMessage('helper_missing'));
    }
    stdout = e.stdout || '';
    if (!stdout.trim()) {
      throw new BridgeError('chromectl_failed', `❌ 调用 Chrome 失败：${String(e.stderr || e.message).trim().slice(0, 500)}`);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new BridgeError('bad_driver_output', `❌ Chrome 返回了无法解析的内容：${stdout.slice(0, 300)}`);
  }
  if (!parsed.ok) {
    const error = new BridgeError(parsed.error, humanMessage(parsed.error, parsed.message));
    if (Number.isInteger(parsed.osStatus)) error.osStatus = parsed.osStatus;
    if (typeof parsed.stage === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(parsed.stage)) error.stage = parsed.stage;
    throw error;
  }
  return parsed;
}

/** Target tab (default: active tab of the front window) + its window bounds. */
export async function chromeInfo(tab = null) {
  try {
    return await runDriver(['info'], tab);
  } catch (error) {
    // Only this read-only metadata lookup may refresh a failed descriptor.
    // A fresh process gets one attempt; commands that change the page never use this path.
    if (error instanceof BridgeError && error.code === 'chrome_error' &&
        error.osStatus === -1701 && error.stage === 'find_tab_windows') {
      return runDriver(['info'], tab, { cold: true });
    }
    throw error;
  }
}

/** Every window and tab: ids, titles, URLs, which tab is active. */
/** Chrome profiles: dir, name, account, Apple-Events JS on/off. */
export function profiles() {
  return runDriver(['profiles']);
}

export function listTabs() {
  return runDriver(['list']);
}

/**
 * Open url in a new tab (of `windowId`, else the front window). By default the
 * window's visible tab does not change; `select: true` leaves the new tab
 * active in its window (the agent window only: plan A6).
 */
export function openTab(url, windowId = null, { select = false } = {}) {
  const args = windowId ? ['open', url, String(windowId)] : ['open', url];
  return runDriver(select ? [...args, '--select'] : args);
}

/**
 * Make `tabId` the active tab of its window without activating Chrome or
 * raising the window. Reply has the target fields plus changed,
 * prevFrontPutBack, frontmostChanged and cgWindow. With `windowId`, chromectl
 * refuses (tab_moved) unless the tab is still in that window.
 */
export function selectTab(tabId, { windowId = null } = {}) {
  return runDriver(['select', String(tabId), ...(windowId != null ? ['--window', String(windowId)] : [])]);
}

/** New Chrome window at bounds {left, top, right, bottom} (points), first tab at url. */
export function newWindow(url, b, profile = null) {
  return runDriver(['newwindow', url, b.left, b.top, b.right, b.bottom, ...(profile ? [profile] : [])]);
}

/**
 * Make the target tab visible (un-minimize, select, raise ONLY its window),
 * bring Chrome to the front and wait (up to ~1s) until macOS reports it
 * frontmost. Required before any synthetic click: activation is
 * asynchronous, and a click posted while macOS is still switching apps is
 * delivered to the app that was in front.
 * The reply also carries `targetOnTop`, `keyWindowIsTarget` (AX focused
 * window is this one) and `cgWindow` (its CoreGraphics window number, null
 * when ambiguous); the input session needs all three before any input.
 * @returns {Promise<{frontmost:string, waitedMs:number, targetOnTop:boolean,
 *                    keyWindowIsTarget:boolean, cgWindow:number|null, chromePid:number}>}
 */
export async function activateChrome(tab = null, hint = null) {
  // With the window id and CG window from a fresh pre-check: the lean foreground path.
  if (tab != null && hint && hint.windowId != null) {
    const b = hint.bounds;
    const a = await runDriver(['activate', '--lean', '--window', String(hint.windowId),
      ...(hint.cgWindow != null ? ['--cg', String(hint.cgWindow)] : []),
      ...(hint.tabActive && !hint.minimized ? ['--assume-active'] : []),
      ...(b ? ['--bounds', [b.left, b.top, b.width, b.height].join(',')] : [])], tab);
    // The lean path reads no URL: the pre-check's (taken moments ago, under the input lock).
    return { ...a, url: a.url ?? hint.url ?? null };
  }
  return runDriver(['activate'], tab);
}

/**
 * Run JS in a tab (default: active tab of the front window) and return the
 * parsed JSON + that tab's window bounds. Works in hidden tabs too.
 */
export async function evalInPage(source, tab = null, { lean = false } = {}) {
  const tmp = path.join(os.tmpdir(), `chrome-bridge-${crypto.randomBytes(6).toString('hex')}.js`);
  await writeFile(tmp, source, 'utf8');
  try {
    const args = lean && tab != null ? ['eval', tmp, '--lean'] : ['eval', tmp];
    let res;
    try { res = await runDriver(args, tab, { retryEmptyOutput: false }); }
    catch (error) {
      // chromectl resolves the explicit tab before executeJavascript in both
      // eval modes. This native stage exits before the script can run; result,
      // URL and bounds failures may follow execution and must never replay it.
      if (tab == null || !(error instanceof BridgeError) || error.code !== 'chrome_error' ||
          error.osStatus !== -1701 || error.stage !== 'find_tab_windows') throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
      res = await runDriver(args, tab, { cold: true, retryEmptyOutput: false });
    }
    let payload;
    try {
      payload = JSON.parse(res.result);
    } catch {
      throw new BridgeError('bad_page_result',
        `❌ 页面脚本返回了非 JSON 内容：${String(res.result).slice(0, 300)}`);
    }
    if (!payload.ok) {
      throw new BridgeError(payload.error || 'page_error', payload.message || '页面脚本执行失败');
    }
    const target = {
      tabId: res.tabId, windowId: res.windowId, url: res.url, title: res.title,
      tabActive: res.tabActive, windowIndex: res.windowIndex, minimized: res.minimized
    };
    return { ...payload, bounds: res.bounds, target };
  } finally {
    unlink(tmp).catch(() => {});
  }
}

/** Load a script from src/page and substitute __PLACEHOLDERS__. */
export async function pageScript(name, vars = {}) {
  let src = await readFile(path.join(HERE, 'page', `${name}.js`), 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    // A function replacer: a string one would expand `$&` etc. inside the value.
    const lit = JSON.stringify(v === undefined ? null : v);
    src = src.replaceAll(`__${k}__`, () => lit);
  }
  return src;
}

/* -------------------------------------------------------------- CGEvent */

export async function cgevent(args) {
  let stdout;
  try {
    const r = await execFileP(CGEVENT, args.map(String), { timeout: 30000 });
    stdout = r.stdout;
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new BridgeError('helper_missing', humanMessage('helper_missing'));
    }
    // The helper prints structured JSON before exiting 1.
    try {
      const j = JSON.parse(String(e.stdout || '').trim());
      throw new BridgeError(j.error, humanMessage(j.error, j.message));
    } catch (inner) {
      if (inner instanceof BridgeError) throw inner;
      throw new BridgeError('cgevent_failed',
        `❌ 鼠标/键盘操作失败：${String(e.stderr || e.message).slice(0, 400)}`);
    }
  }
  return JSON.parse(stdout.trim());
}

/* ------------------------------------------------- the user's scene */

/**
 * What the user had on screen before we take the pointer: front app (pid),
 * and Chrome's front window + its active tab. Enough to put it all back.
 */
export async function snapshotScene() {
  const r = await runDriver(['scene']);
  return { app: r.app, appPid: r.appPid, chromeWindow: r.chromeWindow, chromeTab: r.chromeTab };
}

/**
 * Undo what activation did: user's tab, user's Chrome window, user's app.
 * `stopOnInput`: chromectl neither activates the app nor reorders Chrome's
 * windows once it sees HID input (the user took over mid-restore), counted
 * from `since` (epoch ms: the caller's last look at the user) or else from
 * chromectl's own start.
 * @returns chromectl's reply ({appFrontmost, chromeReordered, userInput, activated, ...})
 */
export function restoreScene(s, { stopOnInput = false, since = null } = {}) {
  return runDriver(['restore', s.appPid ?? '-', s.chromeWindow ?? '-', s.chromeTab ?? '-',
    ...(stopOnInput ? ['--stop-on-input'] : []),
    ...(stopOnInput && since != null ? ['--since', String(Math.round(since))] : [])]);
}

/**
 * Hand the front back to the user's app, only if Chrome is frontmost right
 * now and (with `noClickSince`, epoch ms) no mouse button went down since
 * then, (with `noInputSince`) no input at all; Chrome's windows and the
 * pointer are left as they are.
 * @returns chromectl's reply ({appFrontmost, skipped?})
 */
export function restoreApp(appPid, { noClickSince = null, noInputSince = null } = {}) {
  return runDriver(['restore', appPid, '-', '-', '--if-chrome-front',
    ...(noClickSince != null ? ['--no-click-since', String(Math.round(noClickSince))] : []),
    ...(noInputSince != null ? ['--stop-on-input', '--since', String(Math.round(noInputSince))] : [])]);
}

/**
 * Light up sleeping displays the way touching the mouse would — a declared user activity
 * (`caffeinate -u`), no input event — and wait for them; say whether the screen is locked
 * (then nothing more can be done here: the password is the user's to type).
 * @returns {Promise<{woke:boolean, displays:number, locked:boolean}>}
 */
export async function ensureScreenAwake({ waitMs = 4000, probes = {} } = {}) {
  const now = probes.now || (() => performance.now());
  const sleep = probes.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const readDisplays = probes.readDisplays || (() => cgevent(['displays']));
  const read = async () => {
    const d = await readDisplays();
    if (!d || !Array.isArray(d.displays) || typeof d.displaysAsleep !== 'boolean' || typeof d.locked !== 'boolean') {
      throw new BridgeError('screen_state_unknown', '❌ 无法确认屏幕是否可用，这次没有操作。请稍后重试。');
    }
    return d;
  };
  const wake = probes.wake || (() => new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/caffeinate', ['-u', '-t', '2'], { stdio: 'ignore', detached: true });
    child.once('error', () => reject(new BridgeError('screen_wake_failed', '❌ 无法唤醒显示器，这次没有操作。请稍后重试。')));
    child.once('spawn', () => { child.unref(); resolve(); });
  }));
  const asleep = (d) => d.displaysAsleep || !d.displays.length;
  let d = await read();
  const wasAsleep = asleep(d);
  if (wasAsleep) await wake();
  const deadline = now() + Math.max(0, Number.isFinite(waitMs) ? waitMs : 4000);
  // macOS may retain its lock flag briefly after display wake, even with automatic locking off.
  // Wait for the flag to clear; never infer "unlocked" from the user's screen-lock preference.
  // Also settle a recent wake performed by another caller, when the display is already active.
  while ((asleep(d) || d.locked) && now() < deadline) {
    await sleep(Math.min(200, deadline - now()));
    d = await read();
  }
  return { woke: wasAsleep && !asleep(d), displays: asleep(d) ? 0 : d.displays.length, locked: d.locked };
}

/** While a long job runs: keep the displays on and the screen from locking (caffeinate -di). */
export function keepAwake() {
  try {
    const c = spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true });
    c.unref();
    return () => { try { c.kill(); } catch {} };
  } catch { return () => {}; }
}

/** The page dialog (alert / confirm / prompt) Chrome shows, if any: {open, title, texts, buttons}. */
export function pageDialog() {
  return runDriver(['dialog']);
}
/** Press one of the page dialog's buttons by its title (after typing `text` into a prompt's field). */
export function answerDialog(button, text = null) {
  return runDriver(['dialog', '--press', String(button), ...(text != null ? ['--text', String(text)] : [])]);
}

/*
 * Screenshots. A shot is {data (base64 PNG, longest side ≤ maxPx), width, height (of that PNG:
 * the picture's coordinates, which click_at maps), fullPath, fullWidth, fullHeight (the
 * full-resolution capture, kept for text recognition), rect (CG points the picture shows),
 * popups, dispose()}. Its files sit in a private temporary folder until dispose() (they may show
 * anything that was in the window): the caller must call it.
 */
const SCREENCAPTURE = '/usr/sbin/screencapture';

/*
 * Screen Recording, asked before a capture without the system prompt (`cgevent trust`:
 * CGPreflightScreenCaptureAccess): screencapture itself would make macOS ask, or hand back a
 * picture without the window's contents. true / false / null (unknown: e.g. a helper built before
 * `trust`, then the capture goes ahead as before). A yes is kept for a minute; a no is asked again.
 */
let screenOkAt = 0;
export async function screenRecordingAllowed(cg = cgevent) {
  if (Date.now() - screenOkAt < 60_000) return true;
  try {
    const r = await cg(['trust']);
    if (r && r.ok === true && typeof r.screenRecording === 'boolean') {
      if (r.screenRecording) screenOkAt = Date.now();
      return r.screenRecording;
    }
  } catch {}
  return null;
}

/** Only the real screencapture needs the permission: a test's stand-in (o.screencapture) is not asked about. */
async function requireScreenRecording(screencapture, screenCheck) {
  const check = screenCheck !== undefined ? screenCheck : (screencapture === SCREENCAPTURE ? screenRecordingAllowed : null);
  if (check && (await check()) === false) throw new BridgeError('no_screen_recording', humanMessage('no_screen_recording'));
}

async function pngSize(file) {
  const { stdout } = await execFileP('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 15000 });
  return { w: Number((stdout.match(/pixelWidth:\s*(\d+)/) || [])[1]) || 0, h: Number((stdout.match(/pixelHeight:\s*(\d+)/) || [])[1]) || 0 };
}

/** The picture the agent gets: a copy of `full`, scaled down (never up) to ≤ maxPx on its longest side. */
async function finishShot(dir, full, rect, maxPx, extra) {
  const fs = await pngSize(full);
  if (!(fs.w > 0 && fs.h > 0)) throw new BridgeError('capture_failed', '截图文件是空的');
  const small = path.join(dir, 'shot.png');
  await copyFile(full, small);
  if (Math.max(fs.w, fs.h) > maxPx) await execFileP('/usr/bin/sips', ['-Z', String(maxPx), small], { timeout: 15000 });
  const ss = await pngSize(small);
  const data = (await readFile(small)).toString('base64');
  return { data, width: ss.w, height: ss.h, fullPath: full, fullWidth: fs.w, fullHeight: fs.h, rect, ...extra };
}

/** Capture folders not disposed yet: removed at exit anyway (a caller that forgets must not leave screen contents behind). */
const LIVE_SHOTS = new Set();
process.on('exit', () => { for (const d of LIVE_SHOTS) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

async function shotDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chrome-bridge-shot-'));
  LIVE_SHOTS.add(dir);
  return { dir, dispose: async () => { LIVE_SHOTS.delete(dir); await rm(dir, { recursive: true, force: true }).catch(() => {}); } };
}

/**
 * Of the windows in front of the target (windowstack's `above`), the target app's own popups:
 * select menus, date/colour pickers, bubbles, autofill. Another app's window never; nor a
 * Chrome window at the normal layer as large as half the target (another browser window).
 */
export function ownPopups(stack) {
  const b = stack.bounds, area = b.w * b.h;
  return (stack.above || []).filter(w => w.pid === stack.pid && w.layer >= 0 && w.alpha > 0.05 &&
    (w.layer > 0 || w.bounds.w * w.bounds.h < area / 2));
}

/**
 * Only the Chrome window itself (`screencapture -l`), plus its own popup windows composed over
 * it: windows of other apps (and the takeover veil, the helper's own window) that cover it are
 * not in the picture. `-a` leaves attached windows out of the -l capture, so the image is exactly
 * the window's bounds; the popups (attached or not) are drawn in at their own bounds instead.
 * @param {{cgWindow:number}} w
 * @param o.screencapture, o.cg, o.screenCheck  test seams (the screencapture binary, the helper call,
 *   the Screen Recording question: null skips it)
 */
export async function captureWindow({ cgWindow }, { maxPx = 1568, screencapture = SCREENCAPTURE, cg = cgevent, screenCheck } = {}) {
  if (cgWindow == null) throw new BridgeError('no_cg_window', '不知道这个窗口的系统窗口号');
  await requireScreenRecording(screencapture, screenCheck);
  const { dir, dispose } = await shotDir();
  try {
    const st = await cg(['windowstack', String(cgWindow)]);
    if (!st || !st.ok || !st.bounds) throw new BridgeError('no_such_window', '系统里找不到这个窗口');
    if (st.onScreen === false) throw new BridgeError('window_off_screen', '这个窗口现在不在屏幕上（最小化或在别的桌面空间）');
    const rect = st.bounds;
    const lArgs = (id, file) => ['-x', '-o', '-a', '-t', 'png', '-l', String(id), file];
    const base = path.join(dir, 'window.png');
    await execFileP(screencapture, lArgs(cgWindow, base), { timeout: 15000 });
    const adds = [];
    // Back to front, so a popup drawn later is the one in front.
    for (const [i, p] of ownPopups(st).reverse().entries()) {
      const f = path.join(dir, `popup${i}.png`);
      try {
        await execFileP(screencapture, lArgs(p.id, f), { timeout: 15000 });
        adds.push(`${f}@${[p.bounds.x, p.bounds.y, p.bounds.w, p.bounds.h].join(',')}`);
      } catch {}
    }
    let full = base;
    if (adds.length) {
      full = path.join(dir, 'composed.png');
      await cg(['compose', '--out', full, '--base', base, '--rect', [rect.x, rect.y, rect.w, rect.h].join(','),
        ...adds.flatMap(a => ['--add', a])]);
    }
    const shot = await finishShot(dir, full, rect, maxPx, { popups: adds.length, how: 'window' });
    // The picture should be the window's bounds at the display's scale: same proportions.
    shot.aspectOff = Math.abs((shot.fullWidth / shot.fullHeight) / (rect.w / rect.h) - 1) > 0.03;
    return { ...shot, dispose };
  } catch (e) {
    await dispose();
    throw e instanceof BridgeError ? e : new BridgeError('capture_failed', String(e && (e.stderr || e.message) || e).slice(0, 300));
  }
}

/** Move one of the agent's own windows (never the user's) to b = {left, top, right, bottom}; nothing is raised. */
export function moveWindow(windowId, b) {
  return runDriver(['move', String(windowId), Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]);
}

/**
 * The screen inside `rect` (CG points), whatever is on top there (other apps' windows too):
 * only when the window itself cannot be captured.
 */
export async function captureRegion(rect, { maxPx = 1568, screencapture = SCREENCAPTURE, screenCheck } = {}) {
  await requireScreenRecording(screencapture, screenCheck);
  const { dir, dispose } = await shotDir();
  try {
    const full = path.join(dir, 'region.png');
    const R = [rect.x, rect.y, rect.w, rect.h].map(v => Math.round(v)).join(',');
    await execFileP(screencapture, ['-x', '-t', 'png', '-R', R, full], { timeout: 15000 });
    return { ...(await finishShot(dir, full, rect, maxPx, { popups: 0, how: 'region' })), dispose };
  } catch (e) {
    await dispose();
    throw e;
  }
}

/** Text lines in a PNG, recognised on this Mac (`cgevent ocr`, Apple Vision): {width, height, lines:[{text, conf, x, y, w, h}]}. */
export function ocrImage(file, { langs = ['zh-Hans', 'zh-Hant', 'en-US', 'ja-JP'] } = {}) {
  return cgevent(['ocr', file, '--langs', langs.join(',')]);
}

/** Close a tab by id (callers only pass tabs the agent opened itself), answering the page's
 * "leave this site?" prompt with Leave instead of leaving it on the user's screen. */
export function closeTab(tabId) {
  return runDriver(['close', String(tabId), '--leave']);
}

/* ------------------------------------------------------ input session */

/** Thrown when the user touched mouse or keyboard while we held the input. */
export class UserInterrupted extends BridgeError {
  constructor(interrupted, reply = null) {
    super('user_interrupted', '⏸ 你开始操作了，已停止。');
    this.interrupted = interrupted;
    this.reply = reply;
  }
}

const GUARD_WHY = {
  not_frontmost: 'Chrome 已经不是最前面的 App',
  key_window: '最前面的 Chrome 窗口不是目标窗口',
  window_not_top: '落点处最上层的窗口不是目标 Chrome 窗口（被别的窗口挡住了）',
  cursor_moved: '按下前光标不在落点上',
  modifier_held: 'Cmd / Ctrl / Option 键正被按着，这时按键或点击会变成快捷键'
};

const SESSION_ERRORS = {
  no_input_monitor: '❌ 没能开启键盘鼠标监听，所以无法在你动手时立刻停下；为了不跟你抢，这次没有操作。',
  no_accessibility: CHINESE.no_accessibility,
  terminated: '❌ 鼠标键盘助手在操作中途被结束了，操作没有完成。',
  not_ascii: '❌ 逐键输入只支持英文字符（内部错误：这段文字本应走粘贴）。',
  aborted: '⏹ 用户按了两次 Esc，取消了这次操作，键盘鼠标已经还给用户。\n给 agent：不要自动重试；先问用户要不要继续。',
  abortedShake: '⏹ 用户左右晃动鼠标，取消了这次操作，键盘鼠标已经还给用户。\n给 agent：不要自动重试；先问用户要不要继续。',
  takeover_expired: '⏹ 接管键盘鼠标已解除，这次操作在那一刻停止了。\n给 agent：先 read_page 看页面现状，再决定下一步。',
  no_takeover_tap: '❌ 没能接管键盘鼠标（系统没有允许创建输入拦截），这次没有操作。',
  input_held: '⏸ 用户正按着某个键或鼠标键，这时接管会吞掉它的松开，所以先没有操作。'
};

/** Secure Event Input: the keyboard cannot be held, so nothing is typed or clicked. */
function secureInputMessage(holder, midway) {
  return (midway
    ? '⏸ 操作中途有程序开启了「安全输入」（多半是有密码框在输入），键盘拦不住了，操作在那一刻停止。'
    : `⏸ 「${holder || '某个程序'}」开着「安全输入」（多半是密码框正在输入，或终端开了「安全键盘输入」），` +
      '这时键盘拦不住，为了不把用户的按键送进 agent 的页面，这次没有操作。') +
    '\n给 agent：稍后再调用一次；如果一直如此，请用户退出该程序的密码输入（或锁屏再解锁一次）。';
}

/** A failed session reply as a BridgeError with a Chinese message. */
export function sessionError(r) {
  // A lost hold wins over any input the user made afterwards: Esc-Esc is a cancel
  // (never retried), a timeout stops the action.
  if (r && r.error === 'secure_input') {
    const e = new BridgeError('secure_input', secureInputMessage(r.message, false));
    e.reply = r;
    return e;
  }
  if (r && r.takeover && r.takeover.abortedBy === 'secure_input') {
    const e = new BridgeError('secure_input', secureInputMessage(null, true));
    e.reply = r;
    return e;
  }
  if (r && (r.error === 'aborted' || (r.takeover && r.takeover.aborted))) {
    // Esc-Esc, shaking the mouse or an explicit caller stop: never retry.
    const by = r.takeover ? r.takeover.abortedBy : 'esc';
    const byUser = by === 'esc' || by === 'shake' || by === 'caller_cancel';
    const reason = {
      tap_disabled: '系统中断了输入拦截，MyChrome 已停止并交还键盘鼠标',
      timeout: '接管达到最长时限，MyChrome 已停止并交还键盘鼠标',
      idle: '等待下一步过久，MyChrome 已停止并交还键盘鼠标',
      untrusted: '辅助功能权限已不可用，MyChrome 已停止并交还键盘鼠标'
    }[by];
    const e = new BridgeError(byUser ? 'user_cancelled' : 'takeover_expired',
      byUser ? (by === 'caller_cancel' ? '⏹ 已停止当前操作。' : by === 'shake' ? SESSION_ERRORS.abortedShake : SESSION_ERRORS.aborted) :
        reason ? `⏹ ${reason}。\n给 agent：先 read_page 看页面现状，再决定下一步。` : SESSION_ERRORS.takeover_expired);
    if (by === 'tap_disabled' && r.takeover?.tapDiagnostic) {
      const d = r.takeover.tapDiagnostic;
      const cause = d.reason === 'timeout' ? 'timeout' : d.reason === 'user_input' ? 'user_input' : 'unknown';
      const stage = String(d.slowestStage?.stage || d.stage || 'unknown').replace(/[^a-z_]/g, '').slice(0, 48);
      const gap = Number(d.longestRunLoopGapMs);
      const duration = Number(d.slowestStage?.ms);
      e.message += `\n输入拦截诊断：${cause}；主循环最长间隔 ${Number.isFinite(gap) ? Math.round(gap) : '?'} ms；` +
        `${stage} ${Number.isFinite(duration) ? Math.round(duration) : '?'} ms。`;
    }
    e.reply = r;
    return e;
  }
  if (r && r.interrupted) return new UserInterrupted(r.interrupted, r);
  const code = (r && r.error) || 'session_failed';
  let msg;
  if (code === 'guard') msg = `❌ ${GUARD_WHY[r.why] || `安全检查未通过（${r.why}）`}，没有继续操作。`;
  else if (code === 'input_held' && r && typeof r.message === 'string' && r.message.startsWith('held: ') && r.message !== 'held: ?') {
    // Which key: one whose release was lost (screen lock, KVM switch) reads as down until pressed again.
    msg = `⏸ 检测到「${r.message.slice(6)}」正被按着，这时接管会吞掉它的松开，所以先没有操作。如果其实没人按着，按一下这个键再松开就好。`;
  } else msg = SESSION_ERRORS[code] || `❌ 鼠标键盘助手报错：${code}${r && r.message ? `（${r.message}）` : ''}`;
  const e = new BridgeError(code === 'guard' ? `guard_${r.why}` : code, msg);
  e.reply = r;
  return e;
}

/**
 * One `cgevent session` child for one locked action (JSON Lines over stdio,
 * docs/impl-contract.md §1). request() resolves with the reply of that id;
 * a reply with ok:false or a non-null `interrupted` rejects (UserInterrupted
 * for the latter), unless `raw` is set. close() sends `end` and resolves with
 * its reply (released, restored, interrupted) as soon as it arrives: the
 * helper stays a moment longer to fade its veil out (≤ ~0.4 s), and its exit
 * is awaited in the background (killed if it does not go). Without an end
 * reply it waits for the exit (or kills) before resolving with null. Safe to
 * call more than once.
 *
 * @param opts.bin  helper binary (tests); opts.env  child environment
 */
export function openInputSession({ bin = CGEVENT, env = process.env, timeoutMs = 60_000 } = {}) {
  const child = spawn(bin, ['session'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let endReply = null;
  let exited = false;
  let stderr = '';
  let spawnError = null;
  let closing = null;
  let cancelling = null;
  /** Latest `interrupted` seen in any reply (sticky in the helper). */
  let interrupted = null;

  const failAll = (err) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  };
  const exitPromise = new Promise(res => child.on('exit', () => {
    exited = true;
    failAll(new BridgeError('session_exited',
      `❌ 鼠标键盘助手意外退出了${stderr.trim() ? `：${stderr.trim().slice(-300)}` : ''}`));
    res();
  }));
  child.on('error', (e) => {
    spawnError = e.code === 'ENOENT'
      ? new BridgeError('helper_missing', humanMessage('helper_missing'))
      : new BridgeError('session_failed', `❌ 启动鼠标键盘助手失败：${e.message}`);
    failAll(spawnError);
  });
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  child.stdin.on('error', () => {});
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let r;
    try { r = JSON.parse(line); } catch { return; }
    if (r.interrupted) interrupted = r.interrupted;
    const p = r.id != null ? pending.get(r.id) : null;
    if (p) {
      pending.delete(r.id);
      clearTimeout(p.timer);
      p.resolve(r);
    }
    if (r.op === 'end') {
      endReply = r;
      failAll(new BridgeError('terminated', SESSION_ERRORS.terminated));
    }
  });

  function send(obj, ms = timeoutMs) {
    if (spawnError) return Promise.reject(spawnError);
    if (exited || endReply) return Promise.reject(new BridgeError('session_closed', '❌ 鼠标键盘助手已经结束。'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError('session_timeout', `❌ 鼠标键盘助手 ${Math.round(ms / 1000)} 秒没有回应（${obj.op}）。`));
      }, ms);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...obj, id }) + '\n');
    });
  }

  return {
    get interrupted() { return interrupted; },
    get pid() { return child.pid; },
    /** @param opts.raw  resolve with failed replies instead of throwing */
    async request(obj, { raw = false, timeoutMs: ms } = {}) {
      const r = await send(obj, ms);
      if (raw) return r;
      if (r.interrupted || r.ok === false) throw sessionError(r);
      return r;
    },
    /** Priority stop for this child only; return its acknowledgement without closing it. */
    cancel() {
      if (!cancelling) cancelling = send({ op: 'cancel' }, 3000);
      return cancelling;
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        if (!exited && !endReply && !spawnError) {
          await send({ op: 'end' }, 3000).catch(() => null);
        }
        try { child.stdin.end(); } catch {}
        // In the background the timers must not keep this process alive (the child handle does).
        const reap = async (background) => {
          const wait = (ms) => Promise.race([exitPromise, new Promise(r => {
            const t = setTimeout(r, ms);
            if (background) t.unref();
          })]);
          await wait(2000);
          if (!exited) { child.kill('SIGTERM'); await wait(1000); }
          if (!exited) { child.kill('SIGKILL'); await wait(500); }
        };
        // Replied: the agent goes on while the helper finishes its fade-out.
        if (endReply) { reap(true).catch(() => {}); return endReply; }
        await reap(false);
        return endReply;
      })();
      return closing;
    }
  };
}

/**
 * Scoped, read-only attribution while a navigation settles. The helper records only the
 * receiving process/window and event time, in memory; no keys/text, input posting, or veil.
 * Its stdin EOF and bounded deadline also clean up after a crashed/replaced MCP worker.
 */
export async function openNavigationObserver({ openSession = openInputSession, maxMs = 120_000 } = {}) {
  const session = openSession({ timeoutMs: 4000 });
  try {
    const start = await session.request({ op: 'watchNavigation', maxMs });
    if (start.readOnly !== true || !Number.isFinite(start.startedAt)) {
      throw new BridgeError('navigation_unverified', '无法确认导航期间的用户操作。');
    }
    return {
      startedAt: start.startedAt,
      async untouched(target, since = start.startedAt) {
        if (!target || !Number.isFinite(target.chromePid) || !Number.isFinite(target.cgWindow) ||
            !Number.isFinite(since) || since < start.startedAt) return false;
        try {
          const r = await session.request({ op: 'navigationState',
            chromePid: target.chromePid, window: target.cgWindow, since });
          return r.known === true && r.untouched === true;
        } catch { return false; }
      },
      close: () => session.close(),
    };
  } catch (e) {
    await session.close().catch(() => {});
    throw e;
  }
}
