import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { rmSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { canonicalPromptOrigin } from './page-events.js';
import { startOcrJob, withinBudget, OCR_LANGS, OCR_MAX_PX } from './ocr-job.js';

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

/** Geometry of one proven page WebArea, never browser toolbar/bookmark text. `helper`: tests only. */
export function pageContentRect({ chromePid, cgWindow }, { helper = CHROMECTL } = {}) {
  if (![chromePid, cgWindow].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new BridgeError('page_content_unavailable', '❌ 无法确认网页内容区域，这次没有截图。');
  }
  return coldNativeProbe(['axcontent', String(chromePid), '--window', String(cgWindow)], helper);
}

const PROBE_LIMITS = new Set(['reads', 'visited', 'depth', 'deadline']);
const PROBE_COUNTS = ['reads', 'maxReads', 'visited', 'maxVisited', 'elapsedMs'];
/** The limit a native AX probe stopped on and its counts (chromectl NativeInputProbe.stopped), or null.
 * Only these six fields leave the reply: never page text, titles, URLs or AX names. */
export function probeLimitDetails(r) {
  if (!PROBE_LIMITS.has(r?.limit) || !PROBE_COUNTS.every(k => Number.isSafeInteger(r[k]) && r[k] >= 0)) return null;
  return Object.fromEntries([['limit', r.limit], ...PROBE_COUNTS.map(k => [k, r[k]])]);
}

async function coldNativeProbe(argv, helper = CHROMECTL) {
  let result;
  try {
    const { stdout } = await execFileP(helper, argv, { timeout: 3000, maxBuffer: 64 * 1024 });
    result = JSON.parse(stdout.trim());
  } catch (error) {
    throw new BridgeError(error.code === 'ENOENT' ? 'helper_missing' : 'ax_probe_failed',
      error.code === 'ENOENT' ? humanMessage('helper_missing') : '❌ 无法及时确认原生控件状态，这次没有输入；如有系统菜单，请先手动按 Esc 关闭。');
  }
  if (!result.ok) {
    const error = new BridgeError(result.error || 'ax_probe_failed', humanMessage(result.error, result.message));
    const details = probeLimitDetails(result);
    if (details) error.details = details;
    throw error;
  }
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
 * Pre-warmed chromectl processes (`chromectl --warm-read`). Each is declared
 * read-only when it is spawned (WARM_READ_COMMANDS, never a --pid binding), so
 * it chooses the Chrome process and makes its first read-only Apple Event
 * before its command arrives, then reports ready on fd 3 with the protocol
 * version and the Chrome pid it chose; stdout stays the command's one JSON
 * reply. Only a ready child bound to the pool's latest choice (the newest ready
 * child's pid, still running) is handed out, and the child itself confirms,
 * when its command arrives and before running anything, that this Chrome is
 * still the only one to choose. If not it answers warm_binding_stale
 * (not_sent): every pooled child bound to that pid is retired, refills pause
 * for WARM_RETRY_MS, and the same call runs cold. A child still warming is never
 * waited for: the command runs cold. One not ready within WARM_READY_MS is
 * killed, and a child that fails to warm pauses refills for WARM_RETRY_MS.
 * Cold-only reads (dialog, ax*, bound evals, cold list/info) neither take nor
 * refill the pool. `chromectl --warm` reads its command first (c31ca9b) and
 * saves only the process start, so the pool no longer uses it.
 * Measured on the install, which pre-warmed this way: `scene` 15 ms warm vs
 * ~190 ms cold. A few are kept ready and replaced as they are used; one older
 * than WARM_MAX_AGE_MS is retired (its choice of Chrome process may be stale).
 * CHROME_BRIDGE_WARM=0 turns this off.
 * The pool starts with the first call that wants it (a background sweep reads
 * cold: listTabs({cold})). After WARM_IDLE_MS with no warm command its idle
 * children get SIGTERM, so an unused session keeps none. A child taken for a
 * command is out of the pool, and nothing is reaped while one is in flight.
 */
const WARM_ON = process.env.CHROME_BRIDGE_WARM !== '0';
const WARM_POOL = 3;
const WARM_MAX_AGE_MS = 10 * 60_000;
const WARM_IDLE_MS = 5 * 60_000;
const WARM_READY_MS = 5_000;
const WARM_CALL_MS = 25_000;
const WARM_RETRY_MS = 30_000;
const WARM_READ_PROTOCOL = 1;
// Exactly what `chromectl --warm-read` accepts (chromectl.swift warmReadCommands).
const WARM_READ_COMMANDS = ['list', 'info', 'eval', 'scene', 'profiles'];
const warmPool = [];
const warmIdle = { lastUse: 0, busy: 0, timer: null };
let warmRetryAt = 0;
function helperIdentity() {
  try {
    const s = statSync(CHROMECTL);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch { return null; }
}
function spawnWarm(identity) {
  const child = spawn(CHROMECTL, ['--warm-read'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const w = { child, identity, out: '', err: '', dead: false, ready: false, chromePid: null, born: Date.now() };
  const readyPipe = child.stdio[3];
  let line = '';
  // Its own deadline: a child still choosing Chrome or stuck on its first Apple Event
  // (a system menu can hold every Apple Event) is killed, never handed out or awaited.
  const deadline = setTimeout(() => { if (!w.ready && !w.dead) child.kill('SIGKILL'); }, WARM_READY_MS);
  deadline.unref?.();
  readyPipe?.on('data', d => {
    if (w.ready || w.dead) return;
    line += d;
    const end = line.indexOf('\n');
    if (end < 0) { if (line.length > 200) child.kill('SIGKILL'); return; }
    let r = null;
    try { r = JSON.parse(line.slice(0, end)); } catch {}
    if (r?.ready === true && r.protocol === WARM_READ_PROTOCOL && Number.isSafeInteger(r.chromePid) &&
        r.chromePid > 0 && r.chromePid <= 2147483647) {
      w.ready = true; w.chromePid = r.chromePid; clearTimeout(deadline);
    } else child.kill('SIGKILL');
  });
  readyPipe?.on('error', () => {});
  child.stdout.on('data', d => { w.out += d; });
  child.stderr.on('data', d => { w.err += d; });
  // Ended before ready while still pooled = failed to warm (children this worker retires
  // leave the pool first). Drop it; refill no sooner than WARM_RETRY_MS.
  const ended = () => {
    w.dead = true; clearTimeout(deadline);
    const i = warmPool.indexOf(w);
    if (!w.ready && i >= 0) { warmPool.splice(i, 1); warmRetryAt = Date.now() + WARM_RETRY_MS; }
  };
  w.done = new Promise(res => child.on('exit', () => { ended(); res(); }));
  child.on('error', ended);
  // Warm processes must not keep a script (or the tests) alive.
  child.unref(); child.stdin.unref?.(); child.stdout.unref?.(); child.stderr.unref?.(); readyPipe?.unref?.();
  return w;
}
function takeWarm(argv) {
  // Only a declared read-only command, never one bound to an explicit Chrome pid,
  // uses a pre-warmed child; anything else neither takes nor refills the pool.
  if (!Array.isArray(argv) || !WARM_READ_COMMANDS.includes(argv[0]) || argv.includes('--pid')) return null;
  // A local helper upgrade must not leave up to three old binaries serving a
  // live worker. Only idle, unused pool children are retired here; in-flight
  // commands finish normally. Unknown identity uses the ordinary cold path.
  const identity = helperIdentity();
  const running = pid => { try { return Number.isSafeInteger(pid) && pid > 0 && process.kill(pid, 0); } catch { return false; } };
  const kept = [];
  for (const c of warmPool.splice(0)) {
    if (!c.dead && identity && c.identity === identity && Date.now() - c.born < WARM_MAX_AGE_MS &&
        (!c.ready || running(c.chromePid))) kept.push(c);
    else if (!c.dead) c.child.kill();
  }
  // The newest ready child made the latest choice of Chrome: a ready child bound to
  // another process is stale. A child still warming stays pooled and is not waited for.
  const current = kept.findLast(c => c.ready)?.chromePid;
  let w = null;
  for (const c of kept) {
    if (c.ready && c.chromePid !== current) c.child.kill();
    else if (c.ready && !w) w = c;
    else warmPool.push(c);
  }
  if (identity && Date.now() >= warmRetryAt) while (warmPool.length < WARM_POOL) warmPool.push(spawnWarm(identity));
  noteWarmUse();
  return w;
}
function noteWarmUse() {
  warmIdle.lastUse = performance.now();
  if (!warmIdle.timer && warmPool.length) armWarmReaper(WARM_IDLE_MS);
}
function armWarmReaper(ms) {
  warmIdle.timer = setTimeout(reapIdleWarm, ms);
  warmIdle.timer.unref?.();
}
function reapIdleWarm() {
  warmIdle.timer = null;
  const left = WARM_IDLE_MS - (performance.now() - warmIdle.lastUse);
  if (warmIdle.busy > 0 || left > 0) { armWarmReaper(left > 0 ? left : WARM_IDLE_MS); return; }
  // Only idle children this worker spawned; a taken (in-flight) child is no longer in warmPool.
  for (const c of warmPool.splice(0)) if (!c.dead) c.child.kill('SIGTERM');
}
async function runWarm(w, argv) {
  warmIdle.busy++;
  try {
    w.child.stdin.end(JSON.stringify(argv.map(String)) + '\n');
    // timerFired records only this parent timer killing a child that was still running. It is never
    // inferred from SIGKILL or empty output; a timed-out child's partial stdout is discarded, and
    // the caller does not wait another full interval by retrying the same call cold.
    let timerFired = false;
    const timer = setTimeout(() => { if (!w.dead) { timerFired = true; w.child.kill('SIGKILL'); } }, WARM_CALL_MS);
    await w.done;
    clearTimeout(timer);
    if (timerFired) return { stdout: '', stderr: w.err, timerFired: true };
    // Its Chrome is no longer the only choice (chromectl checked before running anything):
    // retire every pooled child bound to that pid and pause refills; the caller runs cold.
    let reply = null;
    if (w.out.includes('"warm_binding_stale"')) try { reply = JSON.parse(w.out.trim()); } catch {}
    if (reply?.ok === false && reply.error === 'warm_binding_stale' && reply.inputDelivery === 'not_sent') {
      for (const c of warmPool.splice(0)) {
        if (c.ready && c.chromePid === w.chromePid) { if (!c.dead) c.child.kill(); } else warmPool.push(c);
      }
      warmRetryAt = Date.now() + WARM_RETRY_MS;
      return { stdout: '', stderr: w.err, stale: true };
    }
    return { stdout: w.out, stderr: w.err };
  } finally {
    warmIdle.busy--;
    warmIdle.lastUse = performance.now();
  }
}

// Child facts are diagnostic only: never copy argv, output, paths or infer a timeout.
function driverFailureFacts(command, error, coldAttempt) {
  const own = key => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch { return undefined; }
  };
  const exitCode = coldAttempt ? own('code') : null;
  const signal = coldAttempt ? own('signal') : null;
  const killed = coldAttempt ? own('killed') : null;
  return {
    driverCommand: ['info', 'eval', 'dialog', 'list', 'profiles', 'scene'].includes(command) ? command : 'unavailable',
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    signal: ['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL',
      'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'SIGXCPU', 'SIGXFSZ'].includes(signal) ? signal : null,
    killed: typeof killed === 'boolean' ? killed : null,
    timedOut: null,
  };
}

/**
 * HI2: a retry exec inside one read (a second or third chromectl, a later screen-state read) is a new stage. The
 * caller (index.js) may refuse it, by throwing, once its input call's budget has reached the cut-off before any
 * write; the refusal is that call's own error and passes through unchanged (`readRetryRefused`).
 */
let readRetryGate = null;
export function setReadRetryGate(fn) { readRetryGate = typeof fn === 'function' ? fn : null; }
function beforeReadRetry() {
  if (!readRetryGate) return;
  try { readRetryGate(); } catch (e) { throw Object.assign(e, { readRetryRefused: true }); }
}

async function runDriver(args, tab = null, { cold = false, retryEmptyOutput = true } = {}) {
  const argv = tab != null ? [...args, '--tab', String(tab)] : args;
  let stdout, coldAttempt = false;
  try {
    const w = !cold && WARM_ON ? takeWarm(argv) : null;
    const runCold = () => {
      coldAttempt = true;
      return execFileP(CHROMECTL, argv.map(String), { timeout: 25000, maxBuffer: 32 * 1024 * 1024 });
    };
    let r = w ? await runWarm(w, argv) : await runCold();
    // A pre-warmed child whose Chrome binding went stale refused before running anything
    // (not_sent): this same call runs cold, once, eval included.
    if (w && r.stale === true) { beforeReadRetry(); r = await runCold(); }
    // A pre-started process that answered nothing (it died, or Chrome dropped the Apple event):
    // once more with a fresh one (seen live twice in round 5). Eval opts out:
    // missing output cannot prove that its script did not already execute.
    // The parent's own timer already spent a full interval on this call: report it, do not wait again.
    else if (retryEmptyOutput && w && !r.timerFired && !String(r.stdout || '').trim()) { beforeReadRetry(); r = await runCold(); }
    if (process.env.CHROMECTL_TRACE === '1' && r.stderr) process.stderr.write(`chromectl ${argv[0]}:\n${r.stderr}`);
    stdout = r.stdout;
    if (!String(stdout || '').trim()) throw Object.assign(new Error(r.stderr || 'chromectl gave no output'), { stdout: '', stderr: r.stderr });
  } catch (e) {
    if (e.readRetryRefused) throw e;
    if (e.code === 'ENOENT') {
      throw new BridgeError('helper_missing', humanMessage('helper_missing'));
    }
    stdout = e.stdout || '';
    if (!stdout.trim()) {
      throw Object.assign(new BridgeError('chromectl_failed', `❌ 调用 Chrome 失败：${String(e.stderr || e.message).trim().slice(0, 500)}`),
        driverFailureFacts(args[0], e, coldAttempt));
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
    if (parsed.error === 'dialog_probe_unknown' && parsed.stage === 'dialog_inspect' && [
      'native_attribute_deadline', 'native_attribute_read', 'native_windows_shape', 'native_subrole_shape',
      'native_sheets_shape', 'native_walk_guard', 'native_button_title', 'native_button_label',
      'native_text_value', 'native_children_read', 'native_dialog_final', 'cli_inspect_catch',
    ].includes(parsed.dialogProbePoint)) error.dialogProbePoint = parsed.dialogProbePoint;
    // NAT-RETRY: rescans after transient AX statuses (at most 4) and the last AXError code, both closed.
    if (parsed.error === 'dialog_probe_unknown' && ['dialog_inspect', 'dialog_binding', 'native_read_deadline'].includes(parsed.stage) &&
        Number.isInteger(parsed.axRetries) && parsed.axRetries >= 0 && parsed.axRetries <= 4) {
      error.axRetries = parsed.axRetries;
      if (Number.isInteger(parsed.axError) && parsed.axError >= -25212 && parsed.axError <= -25200) error.axError = parsed.axError;
    }
    const nativeReadPoint = Object.getOwnPropertyDescriptor(parsed, 'nativeReadPoint')?.value;
    const nativeReadReason = Object.getOwnPropertyDescriptor(parsed, 'nativeReadReason')?.value;
    const nativeReadGetter = ['windows', 'window_ids', 'window', 'bounds', 'minimized', 'index',
      'tabs', 'tab_ids', 'tab_urls', 'tab_url_ids', 'active_tab', 'active_tab_id', 'title'].includes(nativeReadPoint);
    const nativeReadShape = ['window_ids_shape', 'tab_url_ids_shape', 'row_shape'].includes(nativeReadPoint);
    // Keep a complete closed pair from this parsed error only; never retain the raw reply.
    if (Object.hasOwn(parsed, 'error') && Object.hasOwn(parsed, 'stage') && parsed.stage === 'native_read' && (
      (parsed.error === 'native_read_timeout' && nativeReadGetter && nativeReadReason === 'before_deadline') ||
      (parsed.error === 'native_read_unknown' && ((nativeReadGetter && ['nil_or_type', 'after_deadline', 'objc_exception'].includes(nativeReadReason)) ||
        (nativeReadShape && nativeReadReason === 'shape') || (nativeReadPoint === 'runner' && nativeReadReason === 'runner_other'))))) {
      error.nativeReadPoint = nativeReadPoint; error.nativeReadReason = nativeReadReason;
    }
    // CRASH1: a caught Objective-C exception's name, an identifier only (never its reason text).
    const exceptionName = Object.getOwnPropertyDescriptor(parsed, 'exceptionName')?.value;
    if (typeof exceptionName === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(exceptionName)) error.exceptionName = exceptionName;
    if (Number.isInteger(parsed.osStatus)) error.osStatus = parsed.osStatus;
    if (typeof parsed.stage === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(parsed.stage)) error.stage = parsed.stage;
    if (parsed.partial === true) error.partial = true;
    if (parsed.creationAttempted === true) error.creationAttempted = true;
    if (Number.isSafeInteger(parsed.createdWindowId) && parsed.createdWindowId > 0) error.createdWindowId = parsed.createdWindowId;
    if (['sent', 'unknown', 'not_sent'].includes(parsed.inputDelivery)) error.inputDelivery = parsed.inputDelivery;
    // CRASH1 r2: a helper failure that may follow execution (chromectl executeJavascript:) is never retried.
    if (parsed.noRetry === true) error.noRetry = true;
    if (typeof parsed.pressed === 'string') error.pressed = parsed.pressed;
    if (typeof parsed.sameStillOpen === 'boolean' || parsed.sameStillOpen === null) error.sameStillOpen = parsed.sameStillOpen;
    if (parsed.promptPending === true) error.promptPending = true;
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
      beforeReadRetry();
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

/** cold: a background read (the tab sweep) that neither takes, refills nor keeps alive the warm pool. */
export function listTabs(options) {
  return runDriver(['list'], null, { cold: options?.cold === true });
}

/**
 * Open url in a new tab (of `windowId`, else the front window). By default the
 * window's visible tab does not change; `select: true` leaves the new tab
 * active in its window (the agent window only: plan A6).
 */
/** Internal typed native route; no CLI fallback or write replay. */
async function nativeWrite(native, intent, options = {}) {
  if (typeof native !== 'function') throw Object.assign(new BridgeError('protected_write_requires_session',
    '❌ 原生操作需要当前输入会话，没有操作。'), { inputDelivery: 'not_sent', stage: 'native_dispatch' });
  try {
    const result = await native(intent, options);
    if (!result || typeof result !== 'object') throw Object.assign(new BridgeError('native_response_unknown',
      '❌ 原生操作没有完整回执；请检查当前状态，不要重复发送。'), { inputDelivery: 'unknown', noRetry: true });
    if (result.ok === false) throw sessionError(result);
    return result;
  } catch (error) {
    error.inputDelivery ??= 'unknown';
    if (error.inputDelivery !== 'not_sent') error.noRetry = true;
    throw error;
  }
}

export function openTab(url, windowId = null, { select = false, native } = {}) {
  return nativeWrite(native, { kind: 'openTab', url: String(url), windowId, select: select === true });
}

/**
 * Make `tabId` the active tab of its window without activating Chrome or
 * raising the window. Reply has the target fields plus changed,
 * prevFrontPutBack, frontmostChanged and cgWindow. With `windowId`, chromectl
 * refuses (tab_moved) unless the tab is still in that window.
 */
export function selectTab(tabId, { windowId = null, native } = {}) {
  return nativeWrite(native, { kind: 'selectTab', tabId, windowId });
}

/** New Chrome window at bounds {left, top, right, bottom} (points), first tab at url. */
export async function newWindow(url, b, profile = null, options = {}) {
  const { native, displayId } = options;
  if (Object.hasOwn(options, 'fitCurrent')) throw Object.assign(new BridgeError('native_request_invalid',
    '❌ 新建窗口不能使用 fit-current，没有创建。'), { inputDelivery: 'not_sent', stage: 'native_dispatch' });
  const bounds = b && { left: b.left, top: b.top, width: b.width ?? b.right - b.left, height: b.height ?? b.bottom - b.top };
  try {
    return await nativeWrite(native, { kind: 'newWindow', url: String(url), bounds, displayId, profile });
  } catch (error) {
    if (error.inputDelivery !== 'not_sent') {
      error.partial = true; error.creationAttempted = true; error.stage ??= 'new_window_response';
    }
    throw error;
  }
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
export async function activateChrome(tab = null, hint = null, options = {}) {
  const { native, fitCurrent } = options;
  if (Object.hasOwn(options, 'bounds') || Object.hasOwn(options, 'displayId') ||
      (Object.hasOwn(options, 'fitCurrent') && typeof fitCurrent !== 'boolean')) {
    throw Object.assign(new BridgeError('native_request_invalid', '❌ 激活窗口的几何意图无效，没有操作。'),
      { inputDelivery: 'not_sent', stage: 'native_dispatch' });
  }
  const focus = focusBackendIntent();
  let result;
  try {
    result = await nativeWrite(native, { kind: 'activate', tabId: tab, windowId: hint?.windowId ?? null,
      ...(fitCurrent !== undefined ? { fitCurrent } : {}), ...focus });
  } catch (error) {
    noteFocusFailure(error, focus);
    reportFocus(error);
    throw error;
  }
  if (FOCUS_BREAKER.open && focusBackendSetting() !== 'legacy') result = { ...result, focusFact: 'focus_backend_disabled' };
  reportFocus(result);
  return { ...result, url: result.url ?? null };
}

/* FOCUS2: the activation backend. MYCHROME_FOCUS_BACKEND=legacy|skylight|carbon (default legacy, which sends
 * exactly today's intent); MYCHROME_FOCUS_CARBON_FLAG=1|3 (default 3). The helper falls back to legacy on its own
 * before any private call. A skylight child that died by a signal, hung past its wait, answered outside the
 * protocol or could not be spawned opens this breaker for the server's lifetime: every later activation is
 * legacy, and its receipt carries the fact focus_backend_disabled. Probe-only knobs (focusReraise,
 * focusRecord) are never sent from here except MYCHROME_FOCUS_RERAISE=0, which selects the A/B's arm S. */
const FOCUS_BREAKER = { open: false, cause: null };
const FOCUS_BREAKS = new Set(['signal', 'timeout', 'malformed', 'spawn_failed']);
function focusBackendSetting(env = process.env) {
  const value = String(env.MYCHROME_FOCUS_BACKEND ?? '').trim().toLowerCase();
  return value === 'skylight' || value === 'carbon' ? value : 'legacy';
}
function focusBackendIntent(env = process.env) {
  const backend = focusBackendSetting(env);
  if (backend === 'legacy' || FOCUS_BREAKER.open) return {};
  if (backend === 'carbon') return { focusBackend: 'carbon', carbonFlag: String(env.MYCHROME_FOCUS_CARBON_FLAG ?? '').trim() === '1' ? 1 : 3 };
  return { focusBackend: 'skylight', ...(String(env.MYCHROME_FOCUS_RERAISE ?? '').trim() === '0' ? { focusReraise: false } : {}) };
}
function noteFocusFailure(error, focus) {
  if (!focus?.focusBackend || !error || typeof error !== 'object') return;
  let child;
  try { child = Object.getOwnPropertyDescriptor(error.reply ?? {}, 'focusChild')?.value; } catch { child = undefined; }
  if (FOCUS_BREAKS.has(child) && !FOCUS_BREAKER.open) Object.assign(FOCUS_BREAKER, { open: true, cause: child });
  if (FOCUS_BREAKER.open) error.focusFact = 'focus_backend_disabled';
}
/** Finite words and bounded ms only, from the helper's own reply (or its error's); nothing else is copied. */
const FOCUS_WORDS = {
  focusDriver: new Set(['legacy', 'skylight', 'carbon']),
  focusFallback: new Set(['symbols_missing', 'tab_unbound', 'off_screen', 'owner', 'layer', 'ax_window', 'mode_unknown', 'mode_not_normal', 'psn']),
  focusChild: new Set(['posted', 'front_only', 'post_refused', 'front_error', 'signal', 'timeout', 'malformed', 'spawn_failed']),
  focusFact: new Set(['focus_backend_disabled']),
  // PERM1 (ruling 5): a Chrome popup directly above the target after the activation, and what was done about it.
  popupKind: new Set(['permission', 'translate', 'indicator', 'js_dialog', 'unknown']),
  popupAction: new Set(['none', 'allow', 'dismiss', 'observe']),
  popupDelivery: new Set(['not_sent', 'sent', 'unknown']),
  popupResult: new Set(['cleared', 'remains', 'changed', 'unknown']),
};
export function focusFacts(value) {
  const facts = {};
  if (value === null || typeof value !== 'object') return facts;
  const own = key => { try { const d = Object.getOwnPropertyDescriptor(value, key); return d && Object.hasOwn(d, 'value') ? d.value : undefined; } catch { return undefined; } };
  for (const [key, words] of Object.entries(FOCUS_WORDS)) if (words.has(own(key))) facts[key] = own(key);
  for (const key of ['tSpawnMs', 'tKeyMs']) { const v = own(key); if (Number.isSafeInteger(v) && v >= 0 && v <= 60_000) facts[key] = v; }
  // FOCUS4 amendment A: the activation sent Chrome's `activate` Apple Event (Chrome was not frontmost after it).
  if (own('focusAppleActivate') === true) facts.focusAppleActivate = true;
  return facts;
}
/** index.js registers one observer that files these facts on the current call (its activity row and receipt). */
let FOCUS_OBSERVER = null;
export function onFocusFacts(fn) { FOCUS_OBSERVER = typeof fn === 'function' ? fn : null; }
function reportFocus(source) {
  if (!FOCUS_OBSERVER || source === null || typeof source !== 'object') return;
  let reply; try { reply = Object.getOwnPropertyDescriptor(source, 'reply')?.value; } catch { reply = undefined; }
  const facts = { ...focusFacts(reply), ...focusFacts(source) };
  if (Object.keys(facts).length) try { FOCUS_OBSERVER(facts); } catch { /* diagnostics never change the outcome */ }
}
/** The backend this server would ask for now, and the breaker (read-only; doctor and tests). */
export function focusBackendState(env = process.env) {
  return { setting: focusBackendSetting(env), effective: FOCUS_BREAKER.open ? 'legacy' : focusBackendSetting(env),
    breaker: FOCUS_BREAKER.open ? 'open' : 'closed', cause: FOCUS_BREAKER.cause };
}
export function __resetFocusBreakerForTests() { Object.assign(FOCUS_BREAKER, { open: false, cause: null }); }

/**
 * Run JS in a tab (default: active tab of the front window) and return the
 * parsed JSON + that tab's window bounds. Works in hidden tabs too.
 */
export async function evalInPage(source, tab = null, { lean = false, exactTarget = null } = {}) {
  if (exactTarget) { dialogTarget(exactTarget); if (tab !== exactTarget.tabId || lean) throw new BridgeError('page_auto_target_invalid', '自动验证需要原精确目标。'); }
  const tmp = path.join(os.tmpdir(), `chrome-bridge-${crypto.randomBytes(6).toString('hex')}.js`);
  await writeFile(tmp, source, 'utf8');
  try {
    const args = lean && tab != null ? ['eval', tmp, '--lean'] : ['eval', tmp, ...(exactTarget ? ['--pid', String(exactTarget.chromePid)] : [])];
    let res;
    try { res = await runDriver(args, tab, { cold: !!exactTarget, retryEmptyOutput: false }); }
    catch (error) {
      // chromectl resolves the explicit tab before executeJavascript in both
      // eval modes. This native stage exits before the script can run; result,
      // URL and bounds failures may follow execution and must never replay it.
      if (exactTarget || tab == null || !(error instanceof BridgeError) || error.code !== 'chrome_error' ||
          error.osStatus !== -1701 || error.stage !== 'find_tab_windows') throw error;
      beforeReadRetry();
      await new Promise(resolve => setTimeout(resolve, 250));
      res = await runDriver(args, tab, { cold: true, retryEmptyOutput: false });
    }
    if (exactTarget && ['chromePid', 'windowId', 'tabId'].some(k => res[k] !== exactTarget[k])) throw new BridgeError('page_auto_target_changed', '自动验证的目标已变化。');
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
  // Vision can spend ~31 seconds compiling a local recognition model before
  // returning text. Keep that read-only budget separate from input commands.
  const isOCR = args[0] === 'ocr', timeout = isOCR ? 60000 : 30000;
  try {
    const r = await execFileP(CGEVENT, args.map(String), { timeout });
    stdout = r.stdout;
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new BridgeError('helper_missing', humanMessage('helper_missing'));
    }
    if (isOCR && e.killed && e.signal) {
      throw new BridgeError('ocr_timeout', '❌ 本机文字识别超过 60 秒，未取得 OCR 结果；未重新截图或执行输入。');
    }
    // The helper prints structured JSON before exiting 1.
    try {
      const j = JSON.parse(String(e.stdout || '').trim());
      throw new BridgeError(j.error, humanMessage(j.error, j.message));
    } catch (inner) {
      if (inner instanceof BridgeError) throw inner;
      throw new BridgeError(isOCR ? 'ocr_failed' : 'cgevent_failed',
        `❌ ${isOCR ? '本机文字识别' : '鼠标/键盘操作'}失败：${String(e.stderr || e.message).slice(0, 400)}`);
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
export function restoreScene(s, { stopOnInput = false, since = null, native } = {}) {
  // The helper owns the recorded scene. Caller data cannot retarget restoration.
  return nativeWrite(native, { kind: 'restoreScene', preserveSelection: s?.preserveSelection === true }, { policy: 'restore' });
}

/**
 * Hand the front back to the user's app, only if Chrome is frontmost right
 * now and (with `noClickSince`, epoch ms) no mouse button went down since
 * then, (with `noInputSince`) no input at all; Chrome's windows and the
 * pointer are left as they are.
 * @returns chromectl's reply ({appFrontmost, skipped?})
 */
export function restoreApp(appPid, { noClickSince = null, noInputSince = null, native } = {}) {
  // Kept for monitored callers; the captured scene token determines the app.
  return nativeWrite(native, { kind: 'restoreScene' }, { policy: 'restore' });
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
    beforeReadRetry();
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

function dialogTarget(value, identity = false) {
  const keys = ['chromePid', 'tabId', 'windowId', 'cgWindow'];
  if (!value || !keys.every(k => Number.isSafeInteger(value[k]) && value[k] > 0) || value.chromePid > 2147483647 ||
      (identity && (value.version !== 1 || !Number.isSafeInteger(value.dialogCgWindow) || value.dialogCgWindow <= 0 ||
        typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)))) {
    throw Object.assign(new BridgeError(identity ? 'dialog_identity_required' : 'dialog_target_invalid',
      '❌ 对话框缺少完整的目标身份，没有操作。'), { stage: 'dialog_identity', inputDelivery: 'not_sent' });
  }
  return Object.fromEntries([...keys, ...(identity ? ['version', 'dialogCgWindow', 'token'] : [])].map(k => [k, value[k]]));
}
/** Read only. Native inspection must be complete; an unknown result never means closed. */
export async function pageDialog(target = null) {
  const bound = target == null ? null : dialogTarget(target);
  try {
    const result = await runDriver(['dialog', ...(bound ? ['--pid', String(bound.chromePid), '--target', JSON.stringify(bound)] : [])],
      null, { cold: true, retryEmptyOutput: false });
    let valid = result.known === true && typeof result.open === 'boolean';
    if (valid && result.open) {
      try {
        const identity = dialogTarget(result.identity, true);
        valid = !bound || Object.keys(bound).every(k => identity[k] === bound[k]);
      } catch { valid = false; }
    }
    if (!valid) throw Object.assign(new BridgeError('dialog_probe_unknown', '❌ 原生对话框身份不完整，请手动检查。'),
      { stage: 'dialog_inspect', inputDelivery: 'not_sent', dialogProbePoint: 'bridge_reply_invalid' });
    return result;
  } catch (error) {
    if (['chromectl_failed', 'bad_driver_output'].includes(error.code)) {
      throw Object.assign(new BridgeError('dialog_probe_unknown', '❌ 无法完整确认原生对话框状态，请手动检查。'),
        { stage: 'dialog_inspect', inputDelivery: 'not_sent',
          dialogProbePoint: error.code === 'chromectl_failed' ? 'bridge_child_failed' : 'bridge_output_invalid' });
    }
    error.stage ??= 'dialog_inspect'; error.inputDelivery ??= 'not_sent';
    throw error;
  }
}
/** Cold passive reads have their own cancellable child lifetime; no warm pool or retry. */
// Native cap allows Probe's 4s budget plus startup; completion is still not guaranteed.
// block.js for the observer's gate, read synchronously: no extra await between rendering and writing the script.
let BLOCK_SOURCE = null;
const blockSource = () => (BLOCK_SOURCE ??= readFileSync(path.join(HERE, 'page', 'block.js'), 'utf8'));
export function createPagePromptObserver({ spawnChild = spawn, readScript = pageScript, readGate = blockSource,
  writeScript = writeFile, removeScript = unlink, timer = setTimeout, untimer = clearTimeout,
  now = Date.now, nativeMs = 5000, domMs = 1000, settleMs = 250, getAudit = () => null } = {}) {
  let flight = null, attemptSequence = 0, childSequence = 0;
  // No buffer or executor replacement. Disabled auditing never projects transient facts.
  const note = makeFact => {
    try {
      const sink = getAudit();
      if (typeof sink === 'function') sink(makeFact());
    } catch { /* Audit failures cannot change the observer's effects or outcome. */ }
  };
  const auditTarget = value => {
    const keys = ['chromePid', 'tabId', 'windowId', 'cgWindow'];
    if (!value || !keys.every(k => Number.isSafeInteger(value[k]) && value[k] > 0) || value.chromePid > 2147483647) return null;
    return Object.fromEntries(keys.map(k => [k, value[k]]));
  };
  const auditArgv = (argv, kind, verifiedTarget, temporary) => {
    const target = auditTarget(verifiedTarget), invalid = { argv: null, argvValid: false };
    if (!target || !Array.isArray(argv) || !argv.every(value => typeof value === 'string')) return invalid;
    if (kind === 'native') {
      if (argv.length !== 5 || argv[0] !== 'dialog' || argv[1] !== '--pid' || argv[2] !== String(target.chromePid) || argv[3] !== '--target') return invalid;
      let matches = false;
      const order = (prefix, remaining) => {
        if (matches) return;
        if (!remaining.length) { matches = argv[4] === JSON.stringify(Object.fromEntries(prefix.map(k => [k, target[k]]))); return; }
        for (const key of remaining) order([...prefix, key], remaining.filter(k => k !== key));
      };
      order([], Object.keys(target));
      if (!matches) return invalid;
    } else if (argv.length !== 6 || argv[0] !== 'eval' || typeof temporary !== 'string' || temporary.length > 1024 || argv[1] !== temporary ||
      argv[2] !== '--pid' || argv[3] !== String(target.chromePid) || argv[4] !== '--tab' || argv[5] !== String(target.tabId)) return invalid;
    return { argv: [...argv], argvValid: true };
  };
  async function observe({ target, source, namespace, signal }) {
    const attempt = ++attemptSequence;
    note(() => ({ phase: 'begin', attempt }));
    const unavailable = reason => ({ status: 'unavailable', source, reason });
    if (flight) { note(() => ({ phase: 'rejected', attempt, reason: 'child_not_settled', holdingAttempt: flight.attempt })); return unavailable('child_not_settled'); }
    let verifiedTarget;
    try { verifiedTarget = dialogTarget(target); }
    catch { note(() => ({ phase: 'rejected', attempt, reason: 'target_unverified', holdingAttempt: null })); return unavailable('target_unverified'); }
    note(() => ({ phase: 'validated', attempt, target: auditTarget(verifiedTarget) }));
    if (signal?.aborted) { note(() => ({ phase: 'rejected', attempt, reason: 'preempted', holdingAttempt: null })); return { status: 'cancelled', source, reason: 'preempted' }; }
    const own = { child: null, cancelled: false, closed: Promise.resolve(), pending: false, attempt, auditChild: null };
    flight = own;
    const abort = () => { own.cancelled = true; try { own.child?.kill('SIGKILL'); } catch {}
      note(() => ({ phase: 'stop', attempt, child: own.auditChild, why: 'preempted', via: 'abort', toolStart: signal?.reason === 'tool_start' })); };
    signal?.addEventListener('abort', abort, { once: true });
    async function cold(argv, deadline) {
      if (own.cancelled || signal?.aborted) throw new Error('preempted');
      let closeResolve;
      own.closed = new Promise(resolve => { closeResolve = resolve; });
      own.pending = true;
      const childID = ++childSequence, kind = argv[0] === 'dialog' ? 'native' : 'dom';
      own.auditChild = childID;
      return await new Promise((resolve, reject) => {
        let out = '', errBytes = 0, reason = null, done = false, grace = null;
        const finish = (error, result) => { if (!done) { done = true; error ? reject(new Error(error)) : resolve(result); } };
        const stop = why => {
          reason ||= why;
          try { own.child?.kill('SIGKILL'); } catch {}
          note(() => ({ phase: 'stop', attempt, child: childID, why, via: 'cold', toolStart: why === 'preempted' && signal?.reason === 'tool_start' }));
          grace ??= timer(() => { note(() => ({ phase: 'grace_expired', attempt, child: childID })); finish('child_not_settled'); }, settleMs);
          grace?.unref?.();
        };
        let limit;
        try { own.child = spawnChild(CHROMECTL, argv, { stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch { own.pending = false; own.auditChild = null; closeResolve();
          note(() => ({ phase: 'spawn_failed', attempt, child: childID, kind })); finish('observer_spawn_failed'); return; }
        const child = own.child;
        note(() => ({ phase: 'spawn', attempt, child: childID, kind, ...auditArgv(argv, kind, verifiedTarget, temporary) }));
        const cancelled = () => stop('preempted');
        signal?.addEventListener('abort', cancelled, { once: true });
        child.stdout?.on('data', value => {
          if (Buffer.byteLength(out) + value.length > 65536) { stop('observer_output_limit'); return; }
          if (!reason && !own.cancelled) out += value.toString();
        });
        child.stderr?.on('data', value => { errBytes += value.length; if (errBytes > 65536) stop('observer_output_limit'); });
        child.once('error', () => stop('observer_spawn_failed'));
        child.once('close', code => {
          own.pending = false; own.child = null;
          own.auditChild = null;
          untimer(limit); if (grace) untimer(grace);
          signal?.removeEventListener('abort', cancelled);
          closeResolve();
          note(() => ({ phase: 'close', attempt, child: childID, kind, code: Number.isInteger(code) ? code : null, reason, cancelled: own.cancelled }));
          if (own.cancelled || signal?.aborted) { finish('preempted'); return; }
          if (reason) { finish(reason); return; }
          if (code !== 0) { finish('observer_child_failed'); return; }
          try { const result = JSON.parse(out); if (result.ok !== true) throw new Error();
            note(() => ({ phase: 'parsed', attempt, child: childID, kind })); finish(null, result); }
          catch { finish('observer_result_unknown'); }
        });
        limit = timer(() => stop('observer_timeout'), deadline); limit?.unref?.();
        if (signal?.aborted) cancelled();
      });
    }
    let temporary = null;
    try {
      const native = await cold(['dialog', '--pid', String(target.chromePid), '--target', JSON.stringify(target)], nativeMs);
      if (native.known !== true || typeof native.open !== 'boolean') { note(() => ({ phase: 'native_result', attempt, result: 'unknown' })); return unavailable('dialog_probe_unknown'); }
      if (native.open) {
        try { const identity = dialogTarget(native.identity, true); if (Object.keys(target).some(k => identity[k] !== target[k])) throw new Error(); }
        catch { note(() => ({ phase: 'native_result', attempt, result: 'identity_mismatch' })); return unavailable('dialog_probe_unknown'); }
        note(() => ({ phase: 'native_result', attempt, result: 'open' }));
        const title = typeof native.title === 'string' ? native.title : '';
        const texts = Array.isArray(native.texts) ? native.texts : [], buttons = Array.isArray(native.buttons) ? native.buttons : [];
        const complete = native.complete === true && typeof native.title === 'string' && texts.every(x => typeof x === 'string') && buttons.every(x => typeof x === 'string' && x.length <= 256) &&
          texts.length <= 32 && buttons.length <= 8 && [title, ...texts, ...buttons].join('').length <= 4096 && typeof native.hasField === 'boolean';
        const origin = canonicalPromptOrigin(native.origin);
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([title, texts, buttons, native.hasField])).digest('hex');
        return { status: 'observed', source, complete, observedAt: now(), observations: [{ schema: 1, source,
          observedAt: now(), kind: 'native', title: complete ? title : '[Incomplete native prompt]', texts: complete ? texts : [],
          buttons: complete ? buttons : [], hasField: native.hasField !== false, complete,
          origin,
          originEvidence: origin && native.originEvidence === 'native_current_snapshot' ? native.originEvidence : 'unverified',
          templateId: null, templateVersion: null, instance: { kind: 'native_episode', episodeId: fingerprint, fingerprint } }] };
      }
      note(() => ({ phase: 'native_result', attempt, result: 'closed' }));
      if (own.cancelled || signal?.aborted) throw new Error('preempted');
      const script = await readScript('prompt-observation', { PROMPT_OBSERVATION: { mode: 'observe', namespace } });
      note(() => ({ phase: 'render', attempt, script: typeof script === 'string' && script.length <= 65536 ? script : null,
        namespace: typeof namespace === 'string' && namespace.length <= 128 ? namespace : null }));
      if (own.cancelled || signal?.aborted) throw new Error('preempted');
      // G2 r2: the tab may hold a new document: block.js first in the same eval, as index.js gatedPageScript does;
      // a challenge or an unknown verdict runs no observation (no registry, no DOM or text scan).
      const gate = String(readGate()).trim().replace(/;$/, '');
      const gated = `(function () {\nvar gate = null;\ntry { gate = JSON.parse(${gate}); } catch (e) {}\n` +
        'if (!gate || typeof gate !== \'object\' || gate.error || gate.blocked === undefined || typeof gate.blocked !== \'object\' || gate.blocked) ' +
        'return JSON.stringify({ ok: true, gateOnly: true });\n' +
        `return (${String(script).trim().replace(/;$/, '')});\n})()`;
      temporary = path.join(os.tmpdir(), `mychrome-observe-${crypto.randomBytes(16).toString('hex')}.js`);
      await writeScript(temporary, gated, { encoding: 'utf8', mode: 0o600 });
      note(() => ({ phase: 'write', attempt, path: typeof temporary === 'string' && temporary.length <= 1024 ? temporary : null }));
      if (own.cancelled || signal?.aborted) throw new Error('preempted');
      const raw = await cold(['eval', temporary, '--pid', String(target.chromePid), '--tab', String(target.tabId)], domMs);
      if (raw.chromePid !== target.chromePid || raw.tabId !== target.tabId || raw.windowId !== target.windowId) { note(() => ({ phase: 'dom_result', attempt, result: 'target_changed' })); return unavailable('target_changed'); }
      let dom; try { dom = JSON.parse(raw.result); } catch { note(() => ({ phase: 'dom_result', attempt, result: 'unknown' })); return unavailable('observer_result_unknown'); }
      if (dom.gateOnly === true) { note(() => ({ phase: 'dom_result', attempt, result: 'unknown' })); return unavailable('site_gate'); }
      if (dom.ok !== true || dom.status !== 'observed' || !Array.isArray(dom.observations)) { note(() => ({ phase: 'dom_result', attempt, result: 'unknown' })); return unavailable('observer_result_unknown'); }
      note(() => ({ phase: 'dom_result', attempt, result: 'observed' }));
      return { status: 'observed', source, observedAt: now(), complete: dom.complete === true,
        observations: dom.observations.slice(0, 8).map(o => ({ ...o, schema: 1, source, observedAt: now() })) };
    } catch (error) {
      return own.cancelled || signal?.aborted ? { status: 'cancelled', source, reason: 'preempted' } : unavailable(error.message || 'observer_unavailable');
    } finally {
      signal?.removeEventListener('abort', abort);
      const cleanup = async () => { if (temporary) await removeScript(temporary).catch(() => {}); if (flight === own) { flight = null; note(() => ({ phase: 'released', attempt })); } };
      if (own.pending) own.closed.then(cleanup); else await cleanup();
    }
  }
  return { observe, async dispose() { const own = flight; if (!own) return; own.cancelled = true;
    try { own.child?.kill('SIGKILL'); } catch {}
    note(() => ({ phase: 'stop', attempt: own.attempt, child: own.auditChild, why: 'disposed', via: 'dispose', toolStart: false }));
    await own.closed; }, busy: () => !!flight };
}
let PAGE_PROMPT_OBSERVER_AUDIT = null;
const pagePromptObserver = createPagePromptObserver({ getAudit: () => PAGE_PROMPT_OBSERVER_AUDIT });
export function __setPagePromptObserverAuditForTests(sink) {
  if (sink !== null && typeof sink !== 'function') throw new TypeError('Observer audit sink must be a function or null');
  PAGE_PROMPT_OBSERVER_AUDIT = sink;
}
export const observePagePrompts = options => pagePromptObserver.observe(options);
export const disposePagePromptObserver = () => pagePromptObserver.dispose();

/** One exact, revalidated dialog transaction. Missing output must never resend it. */
export async function answerDialog(button, text = null, expectedIdentity = null, { native, autoConstraint } = {}) {
  dialogTarget(expectedIdentity, true);
  const token = expectedIdentity?.dialogToken;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw Object.assign(
    new BridgeError('dialog_identity_required', '❌ 对话框需要当前输入会话的身份，没有操作。'),
    { stage: 'dialog_identity', inputDelivery: 'not_sent' });
  const result = await nativeWrite(native, { kind: 'dialogAnswer', dialogToken: token,
    button: String(button), text: text == null ? null : String(text), ...(autoConstraint ? { autoConstraint } : {}) });
  if (result.pressed !== String(button) || result.inputDelivery !== 'sent' ||
      !(typeof result.sameStillOpen === 'boolean' || result.sameStillOpen === null)) {
    throw Object.assign(new BridgeError('dialog_response_unknown', '❌ 对话框没有完整的按键回执；请检查当前状态，不要重复发送。'),
      { stage: 'dialog_response', inputDelivery: 'unknown', noRetry: true, stages: result.stages ?? [] });
  }
  return result;
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

/**
 * A capture folder has holders: its owner (`dispose`, once) and each OCR child still reading it (`retain()` → its own
 * release, once; src/ocr-job.js). The last one out removes it (OCR1: a timed-out recognition keeps its image until its
 * child exits, not until the reply). `retain()` after removal returns null.
 */
async function shotDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chrome-bridge-shot-'));
  LIVE_SHOTS.add(dir);
  let holders = 1, ownerOut = false;
  const drop = async () => {
    if (--holders > 0) return;
    LIVE_SHOTS.delete(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  const retain = () => {
    if (holders <= 0) return null;
    holders++;
    let out = false;
    return async () => { if (!out) { out = true; await drop(); } };
  };
  return { dir, retain, dispose: async () => { if (!ownerOut) { ownerOut = true; await drop(); } } };
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
 * @param o.single  PERM1 r2: that one window only, never composed with other windows (no ownPopups: an overlapping
 *   menu of another Chrome window shares the pid, so the pid proves nothing about whose it is)
 */
export async function captureWindow({ cgWindow }, { maxPx = 1568, screencapture = SCREENCAPTURE, cg = cgevent, screenCheck, pageCrop = null, single = false } = {}) {
  if (cgWindow == null) throw new BridgeError('no_cg_window', '不知道这个窗口的系统窗口号');
  await requireScreenRecording(screencapture, screenCheck);
  const { dir, dispose, retain } = await shotDir();
  try {
    const st = await cg(['windowstack', String(cgWindow)]);
    if (!st || !st.ok || !st.bounds) throw new BridgeError('no_such_window', '系统里找不到这个窗口');
    if (st.onScreen === false) throw new BridgeError('window_off_screen', '这个窗口现在不在屏幕上（最小化或在别的桌面空间）');
    let rect = st.bounds;
    if (pageCrop && (st.id !== pageCrop.cgWindow || st.pid !== pageCrop.pid || st.layer !== 0 || st.onScreen !== true ||
        !sameCaptureRect(rect, pageCrop.windowBounds) || !insidePageRect(pageCrop.rect, rect))) {
      throw new BridgeError('page_content_changed', '❌ 网页内容边界已变化，这次没有截图。');
    }
    const lArgs = (id, file) => ['-x', '-o', '-a', '-t', 'png', '-l', String(id), file];
    const base = path.join(dir, 'window.png');
    await execFileP(screencapture, lArgs(cgWindow, base), { timeout: 15000 });
    const adds = [];
    // Back to front, so a popup drawn later is the one in front.
    for (const [i, p] of (pageCrop || single === true ? [] : ownPopups(st).reverse()).entries()) {
      const f = path.join(dir, `popup${i}.png`);
      try {
        await execFileP(screencapture, lArgs(p.id, f), { timeout: 15000 });
        adds.push(`${f}@${[p.bounds.x, p.bounds.y, p.bounds.w, p.bounds.h].join(',')}`);
      } catch {}
    }
    let full = base;
    if (pageCrop) {
      full = path.join(dir, 'page.png');
      const crop = await cg(['crop', '--out', full, '--base', base,
        '--rect', [rect.x, rect.y, rect.w, rect.h].join(','),
        '--crop', [pageCrop.rect.x, pageCrop.rect.y, pageCrop.rect.w, pageCrop.rect.h].join(',')]);
      if (crop?.ok !== true || !insidePageRect(crop.rect, rect) ||
          crop.rect.x < pageCrop.rect.x || crop.rect.y < pageCrop.rect.y ||
          crop.rect.x + crop.rect.w > pageCrop.rect.x + pageCrop.rect.w + 0.001 ||
          crop.rect.y + crop.rect.h > pageCrop.rect.y + pageCrop.rect.h + 0.001) {
        throw new BridgeError('page_content_unavailable', '❌ 无法安全裁切网页内容，这次没有截图。');
      }
      rect = crop.rect;
      await unlink(base); // Browser chrome is never returned or handed to OCR.
    }
    if (adds.length) {
      full = path.join(dir, 'composed.png');
      await cg(['compose', '--out', full, '--base', base, '--rect', [rect.x, rect.y, rect.w, rect.h].join(','),
        ...adds.flatMap(a => ['--add', a])]);
    }
    const shot = await finishShot(dir, full, rect, maxPx, { popups: adds.length, how: pageCrop ? 'page-content' : single === true ? 'single-window' : 'window' });
    // The picture should be the window's bounds at the display's scale: same proportions.
    shot.aspectOff = Math.abs((shot.fullWidth / shot.fullHeight) / (rect.w / rect.h) - 1) > 0.03;
    return { ...shot, dispose, retain };
  } catch (e) {
    await dispose();
    throw e instanceof BridgeError ? e : new BridgeError('capture_failed', String(e && (e.stderr || e.message) || e).slice(0, 300));
  }
}

const sameCaptureRect = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every(k =>
  Number.isFinite(a[k]) && Number.isFinite(b[k]) && Math.abs(a[k] - b[k]) < 0.01);
const insidePageRect = (r, w) => !!r && !!w && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(r[k]) && Number.isFinite(w[k])) &&
  r.w > 0 && r.h > 0 && w.w > 0 && w.h > 0 && r.x >= w.x && r.y > w.y &&
  r.x + r.w <= w.x + w.w && r.y + r.h <= w.y + w.h;

/** Browser screenshot/OCR entry: require reliable content geometry before and after capture.
 * No screenshot is returned when geometry is unavailable; no whole-window/region fallback. */
export async function capturePageContent(target, { contentProbe = pageContentRect, ...options } = {}) {
  const start = Date.now();
  // The native probe's own timeout text is English and says "no input was sent": say what happened to the screenshot.
  // A probe stopped on a limit keeps `details` (the limit and its counts), which the screenshot receipt names.
  const probe = async (t) => {
    try { return await contentProbe(t); }
    catch (e) {
      let rebuilt = null;
      if (e?.code === 'ax_probe_timeout' || e?.code === 'ax_probe_failed') {
        rebuilt = new BridgeError(e.code, '❌ 读取网页内容区域失败或超时（Chrome 正忙或页面很复杂），这次没有截图；可以直接重试。');
      } else if (e?.code === 'page_content_unavailable' && ['reads', 'visited', 'depth'].includes(e.details?.limit)) {
        rebuilt = new BridgeError(e.code, '❌ 网页内容区域没能在检查上限内确认，这次没有截图。');
      }
      if (!rebuilt) throw e;
      if (e.details) rebuilt.details = e.details;
      throw rebuilt;
    }
  };
  const before = await probe(target);
  const proven = p => p?.ok === true && p.pid === target.chromePid && p.cgWindow === target.cgWindow &&
    p.source === 'ax-web-area' && insidePageRect(p.rect, p.windowBounds);
  if (!proven(before)) throw new BridgeError('page_content_unavailable', '❌ 无法确认网页内容区域，这次没有截图。');
  const geometryMs = Date.now() - start;
  const shot = await captureWindow(target, { ...options, pageCrop: before });
  const captureMs = Date.now() - start - geometryMs;
  try {
    const after = await probe(target);
    if (!proven(after) || !sameCaptureRect(before.rect, after.rect) || !sameCaptureRect(before.windowBounds, after.windowBounds)) {
      throw new BridgeError('page_content_changed', '❌ 截图期间网页内容区域已变化，这次图像已丢弃。');
    }
    return { ...shot, timings: { geometryMs, captureMs, verifyMs: Date.now() - start - geometryMs - captureMs, totalMs: Date.now() - start } };
  } catch (error) { await shot.dispose(); throw error; }
}

/** Closed explicit placement or same-target fit-current; neither route raises a window. */
export function moveWindow(windowId, b, options = {}) {
  const { native, displayId, fitCurrent } = options;
  if (Object.hasOwn(options, 'fitCurrent') && fitCurrent !== true) throw Object.assign(
    new BridgeError('native_request_invalid', '❌ 窗口 fit-current 意图无效，没有操作。'),
    { inputDelivery: 'not_sent', stage: 'native_dispatch' });
  const bounds = b && { left: b.left, top: b.top, width: b.width ?? b.right - b.left, height: b.height ?? b.bottom - b.top };
  return nativeWrite(native, { kind: 'moveWindow', windowId,
    ...(b != null ? { bounds } : {}), ...(displayId !== undefined ? { displayId } : {}),
    ...(fitCurrent !== undefined ? { fitCurrent } : {}) });
}

/**
 * The screen inside `rect` (CG points), whatever is on top there (other apps' windows too):
 * only when the window itself cannot be captured.
 */
export async function captureRegion(rect, { maxPx = 1568, screencapture = SCREENCAPTURE, screenCheck } = {}) {
  await requireScreenRecording(screencapture, screenCheck);
  const { dir, dispose, retain } = await shotDir();
  try {
    const full = path.join(dir, 'region.png');
    const R = [rect.x, rect.y, rect.w, rect.h].map(v => Math.round(v)).join(',');
    await execFileP(screencapture, ['-x', '-t', 'png', '-R', R, full], { timeout: 15000 });
    return { ...(await finishShot(dir, full, rect, maxPx, { popups: 0, how: 'region' })), dispose, retain };
  } catch (e) {
    await dispose();
    throw e;
  }
}

/** A finished OCR child's failure, as cgevent() words it (the job hands over facts, not errors). */
function ocrFailure(f) {
  if (f.reason === 'missing') return new BridgeError('helper_missing', humanMessage('helper_missing'));
  if (f.reason === 'killed') return new BridgeError('ocr_timeout', '❌ 本机文字识别超过 60 秒，未取得 OCR 结果；未重新截图或执行输入。');
  if (f.reason === 'exit') {
    // The helper prints structured JSON before exiting 1.
    let j = null;
    try { j = JSON.parse(f.stdout.trim()); } catch {}
    if (j && typeof j.error === 'string') return new BridgeError(j.error, humanMessage(j.error, j.message));
  }
  return new BridgeError('ocr_failed', `❌ 本机文字识别失败：${String(f.stderr || f.message).slice(0, 400)}`);
}

/**
 * Text lines in a PNG, recognised on this Mac (`cgevent ocr`, Apple Vision): {width, height, lines:[{text, conf, x, y, w, h}], elapsedMs}.
 * One child per call, owned by a job (src/ocr-job.js) until it exits; `retain` (the capture's) keeps the image for it.
 * `bounded` (a relay's screenshot/read_page): resolves {pending:'timeout'} after OCR_WAIT_MS from OCR start, the child
 * running on and its text discarded, or {pending:'busy'} at once when OCR_MAX_LIVE are running. `record`: add `facts`
 * (numbers and fixed words) and stamp the completion. `kind: 'warm'` for the bundled warm-up image. `helper`: test seam.
 */
export function ocrImage(file, { langs = OCR_LANGS, maxPx = OCR_MAX_PX, helper = CGEVENT, retain = null, bounded = false, record = false, kind = 'real' } = {}) {
  const job = startOcrJob(file, { bin: helper, langs, maxPx, retain, record, kind, limit: bounded });
  if (job.busy) return Promise.resolve({ pending: 'busy', facts: job.facts });
  const settled = job.done.then(({ result, failure }) => {
    if (failure) throw Object.assign(ocrFailure(failure), job.facts ? { ocrFacts: job.facts } : {});
    return job.facts ? { ...result, facts: job.facts } : result;
  });
  return bounded ? withinBudget(settled, job.facts) : settled;
}

/** Close an owned tab once. A beforeunload prompt remains for an explicitly bound answer. */
export async function closeTab(tabId, { target = null, native } = {}) {
  const bound = target == null ? null : dialogTarget(target);
  if (bound && bound.tabId !== tabId) throw Object.assign(new BridgeError('close_target_invalid',
    '❌ 关闭目标与标签不一致，没有操作。'), { stage: 'close_identity', inputDelivery: 'not_sent' });
  return nativeWrite(native, { kind: 'closeTab', tabId });
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
  input_held: '⏸ 用户正按着某个键或鼠标键，这时接管会吞掉它的松开，所以先没有操作。',
  // PERM1: the one AXPress on a Chrome popup's button was entered but not confirmed (never retried).
  popup_press_unknown: '❌ 按 Chrome 弹出的询问里的按钮时，系统没有确认结果：这一步是否生效未知；网页里的点击或按键没有发送。\n' +
    '给 agent：不要自动重试同一步，先 read_page 看页面现状再决定。'
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
function sessionErrorBase(r) {
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

/** Preserve the native transaction's evidence even when Stop determines the error code. */
export function sessionError(r) {
  const error = sessionErrorBase(r);
  for (const key of ['inputDelivery', 'stages', 'stage', 'operationId', 'epoch', 'partial',
    'creationAttempted', 'createdWindowId', 'createdTabId', 'promptPending', 'noRetry',
    'osStatus', 'sameStillOpen', 'stillOpen', 'postcheckError', 'geometry']) {
    if (r && r[key] !== undefined) error[key] = r[key];
  }
  if (error.inputDelivery && error.inputDelivery !== 'not_sent') error.noRetry = true;
  return error;
}

/** HI2: a stop waits this long for the helper's acknowledgement, then (SIGKILL) this long for its exit; after an
 * acknowledgement, the stopped request's own reply gets a short grace. */
const STOP_ACK_MS = 2000, STOP_EXIT_MS = 1000, STOP_REPLY_MS = 500;
/** Requests whose timeout only rejects: the veil's fire-and-forget panel, and close's own `end` (it reaps). */
const NO_STOP_ON_TIMEOUT = new Set(['panel', 'end']);
/** Requests that post no input and write nothing in Chrome: after a confirmed stop their timeout is not_sent. */
const NO_INPUT_OPS = new Set(['prime', 'hold', 'status', 'veil', 'begin', 'inspectDialog', 'bindNativeTarget',
  'recordNativeScene', 'watchNavigation', 'navigationState', 'revokeNative', 'cancel']);
const STOP_UNCONFIRMED = '鼠标键盘助手没有确认停止，进程也没能确认已退出：输入是否还在继续无法确认。' +
  '\n给 agent：不要重试；先 read_page 核对页面，必要时请用户检查。';

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
 * HI2: a request that times out is not released while the helper may still act on it. stop() first sends the
 * priority stop (`cancel`, or `revokeNative` with the caller's reason) and waits for its acknowledgement (the helper
 * writes it only once it has set `aborted`, after which every input path refuses); without one it kills the child and
 * waits for the exit. Only then does the request reject, with `helperStop` 'ack' | 'exit' | 'unconfirmed'; with
 * neither, delivery is `unknown` and no-retry. From the stop on, nothing is written to the child except close's `end`,
 * and a late reply to the released request is ignored.
 *
 * @param opts.bin  helper binary (tests); opts.env  child environment; opts.kill  (tests) how SIGKILL is sent
 */
export function openInputSession({ bin = CGEVENT, env = process.env, timeoutMs = 60_000, stopAckMs = STOP_ACK_MS,
  stopExitMs = STOP_EXIT_MS, kill = (child, signal) => child.kill(signal) } = {}) {
  const child = spawn(bin, ['session'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let endReply = null;
  let exited = false;
  let stderr = '';
  let spawnError = null;
  let closing = null;
  let cancelling = null;
  let stopping = null;
  /** HI2: how the helper was confirmed stopped: 'ack', 'exit', or 'unconfirmed' (neither). */
  let stopState = null;
  /** Latest `interrupted` seen in any reply (sticky in the helper). */
  let interrupted = null;

  const failAll = (err) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(typeof err === 'function' ? err() : err); }
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
    // A released request's id is no longer pending: its late reply resolves nothing.
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
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const stoppedError = how => {
    const e = new BridgeError('session_closed', how === 'unconfirmed' ? `❌ ${STOP_UNCONFIRMED}` : '❌ 鼠标键盘助手已停止，没有继续发送。');
    e.helperStop = how;
    if (how === 'unconfirmed') { e.inputDelivery = 'unknown'; e.noRetry = true; }
    return e;
  };
  /** The released request's error, once the stop is decided. */
  const stopFacts = (e, op, how) => {
    e.helperStop = how;
    if (how === 'unconfirmed') {
      e.inputDelivery = 'unknown'; e.noRetry = true;
      e.message += `\n${STOP_UNCONFIRMED}`;
    } else {
      e.message += how === 'ack' ? '已让它停止，并收到了确认。' : '它没有确认停止，已结束它的进程。';
      if (NO_INPUT_OPS.has(op)) e.inputDelivery = 'not_sent';
      else { e.inputDelivery = 'unknown'; e.noRetry = true; }
    }
    return e;
  };

  function send(obj, ms = timeoutMs, internal = false) {
    if (spawnError) return Promise.reject(spawnError);
    if (exited || endReply) return Promise.reject(new BridgeError('session_closed', '❌ 鼠标键盘助手已经结束。'));
    // HI2: after a stop, nothing more reaches the child (close's `end` excepted); this request was never written.
    if (stopping && !internal && obj.op !== 'end') return Promise.reject(Object.assign(stoppedError(stopState || 'pending'), { notWritten: true }));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const e = new BridgeError('session_timeout', `❌ 鼠标键盘助手 ${Math.round(ms / 1000)} 秒没有回应（${obj.op}）。`);
        if (internal || NO_STOP_ON_TIMEOUT.has(obj.op)) { reject(e); return; }
        // HI2: not released while the helper may still act on it.
        stop('timeout').then(({ how }) => reject(stopFacts(e, obj.op, how)), () => reject(stopFacts(e, obj.op, 'unconfirmed')));
      }, ms);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...obj, id }) + '\n');
    });
  }

  /** HI2: stop the helper now and confirm it (acknowledgement, else exit). Resolves {how}; never rejects. */
  function stop(reason = 'timeout') {
    if (stopping) return stopping;
    stopping = (async () => {
      let how = null;
      if (spawnError || exited) how = 'exit';
      else {
        const ack = endReply ? null
          : await send(reason === 'timeout' ? { op: 'cancel' } : { op: 'revokeNative', reason }, stopAckMs, true).catch(() => null);
        if (ack && ack.ok === true && ack.cancelled === true) how = 'ack';
        else if (exited) how = 'exit';
        else {
          try { kill(child, 'SIGKILL'); } catch {}
          await Promise.race([exitPromise, delay(stopExitMs)]);
          how = exited ? 'exit' : 'unconfirmed';
        }
      }
      // The stopped request's own reply (its progress) follows the acknowledgement at once.
      for (const t = Date.now(); how === 'ack' && pending.size && Date.now() - t < STOP_REPLY_MS;) await delay(10);
      stopState = how;
      failAll(() => stoppedError(how));
      return { how, reason };
    })().catch(() => { stopState = 'unconfirmed'; return { how: 'unconfirmed', reason }; });
    return stopping;
  }

  return {
    get interrupted() { return interrupted; },
    get pid() { return child.pid; },
    /** HI2: 'ack' | 'exit' | 'unconfirmed' once a stop (or a close that got neither an end reply nor the exit) decided it. */
    get helperStop() { return stopState; },
    /** HI2 r2: a stop has been started (by a timeout or a caller), and the promise that settles when it is decided. */
    get stopStarted() { return !!stopping; },
    stopSettled() { return stopping || Promise.resolve(null); },
    /** @param opts.raw  resolve with failed replies instead of throwing */
    async request(obj, { raw = false, timeoutMs: ms } = {}) {
      let r;
      try { r = await send(obj, ms); }
      catch (error) {
        if (obj.op === 'nativeChrome' && !error.notWritten) { error.inputDelivery = 'unknown'; error.noRetry = true; error.operationId = obj.operationId; }
        throw error;
      }
      if (raw) return r;
      if (r.interrupted || r.ok === false) throw sessionError(r);
      return r;
    },
    /** Priority stop for this child only; return its acknowledgement without closing it. */
    cancel() {
      if (!cancelling) cancelling = send({ op: 'cancel' }, 3000, true);
      return cancelling;
    },
    stop,
    close() {
      if (closing) return closing;
      closing = (async () => {
        if (stopping) await stopping;
        // Stopped by exit, or killed with no exit seen: nothing more to send or reap.
        if (stopState === 'exit' || stopState === 'unconfirmed') { try { child.stdin.end(); } catch {} return endReply; }
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
          if (!exited) { kill(child, 'SIGTERM'); await wait(1000); }
          if (!exited) { kill(child, 'SIGKILL'); await wait(500); }
        };
        // Replied: the agent goes on while the helper finishes its fade-out.
        if (endReply) { reap(true).catch(() => {}); return endReply; }
        await reap(false).catch(() => {});
        // HI2: neither an end reply nor the exit confirms that the helper stopped.
        if (!exited && !spawnError) stopState = stopState || 'unconfirmed';
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
    const observation = async (target, since = start.startedAt) => {
        if (!target || !Number.isInteger(target.chromePid) || target.chromePid <= 0 ||
            !Number.isInteger(target.cgWindow) || target.cgWindow <= 0 ||
            !Number.isFinite(since) || since < start.startedAt) return { known: false, untouched: false };
        try {
          const r = await session.request({ op: 'navigationState',
            chromePid: target.chromePid, window: target.cgWindow, since });
          // Older helpers used untouched:false both for an exact target event and for a
          // Chrome event whose receiving window was unknown. Only explicit target evidence
          // may become sticky takeover; untouched:true keeps its existing strict meaning.
          // A later observation failure cannot erase an exact target event already recorded.
          const known = r.known === true && r.untouched === true || r.untouched === false && r.targetInput === true;
          return { known, untouched: known && r.untouched === true };
        } catch { return { known: false, untouched: false }; }
    };
    return {
      startedAt: start.startedAt,
      observation,
      async untouched(target, since = start.startedAt) { return (await observation(target, since)).untouched; },
      close: () => session.close(),
    };
  } catch (e) {
    await session.close().catch(() => {});
    throw e;
  }
}
