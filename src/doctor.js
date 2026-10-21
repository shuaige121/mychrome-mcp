/**
 * `mychrome-mcp doctor`: everything a new user must set up, checked read-only, each with what to
 * click. It changes no setting, never shows a permission prompt by itself (Automation only with
 * --ask, which lets macOS ask its own question), and touches Chrome only to read: its profile files,
 * and with the Automation answer already "allowed", `String(1 + 1)` in the front tab of an existing
 * window to confirm the Apple Events switch (no navigation, no new tab). No remote debugging port.
 *
 * runChecks() returns {ok, app, checks: [{id, title, required, ok, skipped, detail, fix, settings?}]};
 * detail and fix are Chinese, then English on the next line. runDoctorCli() is the command line.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_REQUIREMENT, supportedNode } from './node-support.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Lowest allowed major, retained for callers; supportedNode applies the complete version policy. */
export const MIN_NODE_MAJOR = 20;
/** chromectl opens the agent's window through this path (newwindow, --profile-directory). */
export const CHROME_APP = '/Applications/Google Chrome.app';
const CHROME_BUNDLE = 'com.google.Chrome';

/** System Settings panes, opened only with --open. */
export const SETTINGS_URL = {
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
};

/** AEDeterminePermissionToAutomateTarget results (`cgevent trust`). */
const AE_ALLOWED = 0, AE_DENIED = -1743, AE_NOT_ASKED = -1744, AE_NOT_RUNNING = -600;

/*
 * Pane names as this Mac's System Settings shows them, read from its own strings (they change:
 * macOS 27 calls Accessibility "Device Control and Data Access"); these when that file is missing.
 */
const PRIVACY_STRINGS = '/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex/Contents/Resources';
const PANE_FALLBACK = {
  privacy: { zh: '隐私与安全性', en: 'Privacy & Security' },
  automation: { zh: '自动化', en: 'Automation' },
  accessibility: { zh: '辅助功能', en: 'Accessibility' },
  screen: { zh: '屏幕录制', en: 'Screen Recording' }
};

const zhen = (zh, en) => `${zh}\n${en}`;

/* ------------------------------------------------------------- probes */

/** Run a program; never throws: {code, stdout, stderr} or {spawnError} (ENOENT, EACCES, TIMEOUT…). */
function realRun(file, args, { timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const r = { code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
      if (!err) return resolve(r);
      if (typeof err.code === 'string') return resolve({ ...r, code: null, spawnError: err.code });
      if (err.killed) return resolve({ ...r, code: null, spawnError: 'TIMEOUT' });
      resolve({ ...r, code: err.code ?? 1 });
    });
  });
}

/** A script file for `chromectl eval`, in a private temporary folder. */
async function realTmpScript(source) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mychrome-doctor-'));
  const file = path.join(dir, 'probe.js');
  await writeFile(file, source, 'utf8');
  return { file, dispose: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

/** Everything the checks read from the machine; tests replace any of it. */
export function realProbes() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    root: ROOT,
    home: os.homedir(),
    exists: (p) => existsSync(p),
    run: realRun,
    tmpScript: realTmpScript
  };
}

/** A helper's one JSON line: {ran, json, error, message}. */
async function helperJson(p, file, args, timeout = 10_000) {
  const r = await p.run(file, args, { timeout });
  if (r.spawnError) return { ran: false, json: null, error: r.spawnError, message: r.stderr };
  let json = null;
  try { json = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
  if (!json || typeof json !== 'object') return { ran: true, json: null, error: 'bad_output', message: String(r.stderr || r.stdout).slice(0, 200) };
  return { ran: true, json, error: json.ok === false ? json.error : null, message: json.message || '' };
}

/** Running Google Chrome main processes: [{pid, app, headless}]. */
async function chromeProcesses(p) {
  const r = await p.run('/bin/ps', ['-axww', '-o', 'pid=,args=']);
  const list = [];
  for (const line of String(r.stdout).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*?\/Google Chrome\.app)\/Contents\/MacOS\/Google Chrome(?:\s+(.*))?$/);
    if (m) list.push({ pid: Number(m[1]), app: m[2], headless: /(^|\s)--headless\b/.test(m[3] || '') });
  }
  return list;
}

async function paneNames(p) {
  const names = JSON.parse(JSON.stringify(PANE_FALLBACK));
  const read = async (file) => {
    const r = await p.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
    try { return JSON.parse(r.stdout); } catch { return null; }
  };
  const [loc, info] = await Promise.all([read(`${PRIVACY_STRINGS}/Localizable.loctable`), read(`${PRIVACY_STRINGS}/InfoPlist.loctable`)]);
  const take = (table, key, slot) => {
    for (const [lang, k] of [['zh_CN', 'zh'], ['en', 'en']]) {
      const v = table && table[lang] && table[lang][key];
      if (typeof v === 'string' && v.trim()) names[slot][k] = v.trim();
    }
  };
  take(info, 'CFBundleDisplayName', 'privacy');
  take(loc, 'AUTOMATION', 'automation');
  take(loc, 'ACCESSIBILITY', 'accessibility');
  take(loc, 'SCREEN_CAPTURE_HEADER', 'screen');
  return names;
}

function makeContext(p, o) {
  const memo = new Map();
  const once = (k, fn) => { if (!memo.has(k)) memo.set(k, fn()); return memo.get(k); };
  const bin = (n) => path.join(p.root, 'bin', n);
  return {
    p, o, bin, results: {},
    trust: () => once('trust', () => helperJson(p, bin('cgevent'), ['trust', ...(o.askAutomation ? ['--ask-automation'] : [])],
      o.askAutomation ? 180_000 : 10_000)),
    pick: () => once('pick', () => helperJson(p, bin('chromectl'), ['pick'])),
    profiles: () => once('profiles', () => helperJson(p, bin('chromectl'), ['profiles'])),
    chrome: () => once('chrome', () => chromeProcesses(p)),
    panes: () => once('panes', () => paneNames(p)),
    async app() {
      const t = await this.trust();
      const name = t.json && t.json.responsible && t.json.responsible.name;
      return name ? { zh: name, en: name, known: true } : { zh: '运行这个命令的 App', en: 'the app running this command', known: false };
    }
  };
}

/* ------------------------------------------------------------- checks */

const done = (id, title, required, ok, detail, fix = null, extra = {}) =>
  ({ id, title, required, ok, skipped: false, detail, fix: ok ? null : fix, ...extra });
const skipped = (id, title, required, detail) =>
  ({ id, title, required, ok: false, skipped: true, detail, fix: null });
const waitsFor = (what) => zhen(`等「${what.zh}」通过后再查。`, `Checked once "${what.en}" passes.`);

async function buildFix(c) {
  const cmd = `cd "${c.p.root}" && npm run build`;
  const x = await c.p.run('/usr/bin/xcode-select', ['-p']);
  if (x.code !== 0) {
    return zhen(`先装 Xcode 命令行工具：在终端运行 xcode-select --install，装完后运行：${cmd}`,
      `Install the Xcode Command Line Tools first (run: xcode-select --install), then run: ${cmd}`);
  }
  return zhen(`在终端运行：${cmd}（约 20 秒）`, `Run in a terminal: ${cmd} (about 20 s)`);
}

const MAC = { zh: 'macOS · Apple Silicon', en: 'macOS · Apple Silicon' };
async function checkMac(c) {
  const { p } = c, T = MAC.zh;
  if (p.platform !== 'darwin') {
    return done('macos', T, true, false, zhen(`这台电脑的系统是 ${p.platform}，不是 macOS。`, `This computer runs ${p.platform}, not macOS.`),
      zhen('MyChrome 只能在 Mac 上用。', 'MyChrome works on a Mac only.'));
  }
  const ver = (await p.run('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim();
  if (p.arch !== 'arm64') {
    const rosetta = (await p.run('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'])).stdout.trim() === '1';
    if (rosetta) {
      return done('macos', T, true, false,
        zhen(`Node 是 Intel 版（${p.arch}），在 Rosetta 转译下运行。`, `Node is the Intel build (${p.arch}), running under Rosetta.`),
        zhen('从 https://nodejs.org 安装 Apple Silicon（arm64）版 Node，然后重新运行。', 'Install the Apple Silicon (arm64) Node from https://nodejs.org, then run this again.'));
    }
    return done('macos', T, true, false,
      zhen(`这台 Mac 是 Intel 芯片（${p.arch}）。`, `This Mac has an Intel processor (${p.arch}).`),
      zhen('MyChrome 只在 Apple Silicon（M 系列芯片）的 Mac 上编译和测试过。', 'MyChrome is built and tested on Apple Silicon (M-series) Macs only.'));
  }
  return done('macos', T, true, true, zhen(`macOS ${ver || '?'}，Apple Silicon（arm64）。`, `macOS ${ver || '?'}, Apple Silicon (arm64).`));
}

const NODE = { zh: 'Node.js', en: 'Node.js' };
async function checkNode(c) {
  const v = c.p.nodeVersion;
  const ok = supportedNode(v);
  return done('node', NODE.zh, true, ok,
    zhen(`Node v${v}（需要 24 或更新版本（推荐）、22.x 的 22.13.0 起，或 20.x 的 20.19.0 起；仅支持正式版本）。`,
      `Node v${v} (requires ${NODE_REQUIREMENT}; stable releases only).`),
    zhen('从 https://nodejs.org 安装 Apple Silicon（arm64）版 LTS Node，然后重新运行。',
      'Install the Apple Silicon (arm64) LTS Node from https://nodejs.org, then run this again.'));
}

const HELPERS = { zh: '助手程序', en: 'Helper programs' };
async function checkHelpers(c) {
  const T = `${HELPERS.zh} / ${HELPERS.en}`;
  const missing = ['cgevent', 'chromectl', 'cbmenu'].filter(n => !c.p.exists(c.bin(n)));
  const needed = missing.filter(n => n !== 'cbmenu');
  if (needed.length) {
    const list = needed.map(n => `bin/${n}`);
    return done('helpers', T, true, false, zhen(`缺少 ${list.join('、')}（还没编译）。`, `Missing ${list.join(', ')} (not built yet).`), await buildFix(c));
  }
  const t = await c.trust();
  if (!t.ran) {
    return done('helpers', T, true, false, zhen(`bin/cgevent 运行不了（${t.error}）。`, `bin/cgevent does not run (${t.error}).`), await buildFix(c));
  }
  if (!t.json || t.json.ok !== true || typeof t.json.accessibility !== 'boolean') {
    return done('helpers', T, true, false,
      zhen('bin/cgevent 是旧版本编译的（不认识 trust 命令），需要重新编译。', 'bin/cgevent was built from an older version (it has no "trust" command): rebuild it.'),
      await buildFix(c));
  }
  const k = await c.pick();
  if (!k.ran || !k.json || !Array.isArray(k.json.candidates)) {
    return done('helpers', T, true, false, zhen(`bin/chromectl 运行不了（${k.error}）。`, `bin/chromectl does not run (${k.error}).`), await buildFix(c));
  }
  const menu = missing.includes('cbmenu');
  return done('helpers', T, true, true, zhen(
    `bin/cgevent、bin/chromectl 能运行${menu ? '；菜单栏程序 bin/cbmenu 没编译（可选）' : '，菜单栏程序 bin/cbmenu 也在'}。`,
    `bin/cgevent and bin/chromectl run${menu ? '; the menu-bar app bin/cbmenu is not built (optional)' : '; the menu-bar app bin/cbmenu is there too'}.`));
}

const INSTALLED = { zh: 'Google Chrome 已安装', en: 'Google Chrome installed' };
async function checkChromeInstalled(c) {
  const T = `${INSTALLED.zh} / ${INSTALLED.en}`;
  if (c.p.exists(CHROME_APP)) {
    const r = await c.p.run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', `${CHROME_APP}/Contents/Info.plist`]);
    const ver = r.code === 0 ? ` ${r.stdout.trim()}` : '';
    return done('chrome_installed', T, true, true, zhen(`Google Chrome${ver}，在「应用程序」文件夹里。`, `Google Chrome${ver}, in /Applications.`));
  }
  const elsewhere = [path.join(c.p.home, 'Applications', 'Google Chrome.app'), ...(await c.chrome()).map(x => x.app)]
    .find(x => x !== CHROME_APP && c.p.exists(x));
  if (elsewhere) {
    return done('chrome_installed', T, true, false,
      zhen(`Google Chrome 装在 ${elsewhere}，不在「应用程序」文件夹（/Applications）里。`, `Google Chrome is at ${elsewhere}, not in /Applications.`),
      zhen('退出 Chrome，把 Google Chrome 拖进「应用程序」文件夹，再打开它（MyChrome 为 agent 新开窗口时用的是 /Applications/Google Chrome.app）。',
        'Quit Chrome, drag Google Chrome into the Applications folder and open it again (MyChrome opens the agent\'s window through /Applications/Google Chrome.app).'));
  }
  return done('chrome_installed', T, true, false, zhen('没找到 Google Chrome。', 'Google Chrome was not found.'),
    zhen('从 https://www.google.com/chrome/ 下载 Google Chrome，装进「应用程序」文件夹。', 'Download Google Chrome from https://www.google.com/chrome/ and put it in the Applications folder.'));
}

const RUNNING = { zh: 'Google Chrome 在运行', en: 'Google Chrome running' };
async function checkChromeRunning(c) {
  const T = `${RUNNING.zh} / ${RUNNING.en}`;
  const all = await c.chrome();
  if (all.some(x => !x.headless)) return done('chrome_running', T, true, true, zhen('Google Chrome 正在运行。', 'Google Chrome is running.'));
  const open = zhen(`打开 Google Chrome（或运行 ${c.o.self} --open-chrome 让本检查替你打开）。`, `Open Google Chrome (or run ${c.o.self} --open-chrome to have this check open it).`);
  if (all.length) {
    return done('chrome_running', T, true, false,
      zhen('只有无界面（headless）的 Chrome 在运行，那是别的程序开的。', 'Only a headless Chrome (started by some other program) is running.'), open);
  }
  return done('chrome_running', T, true, false, zhen('Google Chrome 没有在运行。', 'Google Chrome is not running.'), open);
}

const AUTOMATION = { zh: '自动化：控制 Chrome', en: 'Automation: control Chrome' };
async function checkAutomation(c) {
  const T = `${AUTOMATION.zh} / ${AUTOMATION.en}`;
  if (!c.results.helpers.ok) return skipped('automation', T, true, waitsFor(HELPERS));
  if (!c.results.chrome_running.ok) {
    return skipped('automation', T, true, zhen('等 Chrome 打开后再查（macOS 只能对正在运行的 Chrome 回答）。', 'Checked once Chrome is open (macOS answers only for a running Chrome).'));
  }
  const [t, app, pn] = [await c.trust(), await c.app(), await c.panes()];
  const code = t.json.automation;
  if (code === AE_ALLOWED) {
    return done('automation', T, true, true, zhen(`已允许「${app.zh}」控制 Google Chrome。`, `"${app.en}" may control Google Chrome.`));
  }
  if (code === AE_DENIED) {
    return done('automation', T, true, false,
      zhen(`「${app.zh}」控制 Google Chrome 被拒绝了。`, `"${app.en}" was refused control of Google Chrome.`),
      zhen(`打开 系统设置 → ${pn.privacy.zh} → ${pn.automation.zh}，在「${app.zh}」下面打开「Google Chrome」的开关。`,
        `Open System Settings → ${pn.privacy.en} → ${pn.automation.en} and switch on "Google Chrome" under "${app.en}".`),
      { settings: SETTINGS_URL.automation });
  }
  if (code === AE_NOT_ASKED) {
    return done('automation', T, true, false,
      zhen(`macOS 还没问过「${app.zh}」能不能控制 Google Chrome。`, `macOS has not yet asked whether "${app.en}" may control Google Chrome.`),
      zhen(`运行 ${c.o.self} --ask，macOS 会弹窗问「“${app.zh}”想要控制“Google Chrome”」，点「允许」。不运行的话，agent 第一次用 MyChrome 时 macOS 也会这样问。`,
        `Run ${c.o.self} --ask: macOS asks '"${app.en}" wants access to control "Google Chrome"'; click Allow. Otherwise macOS asks the first time the agent uses MyChrome.`));
  }
  if (code === AE_NOT_RUNNING) {
    return skipped('automation', T, true, zhen('macOS 说 Chrome 没有在运行；打开 Chrome 后再查。', 'macOS says Chrome is not running; checked once it is open.'));
  }
  return done('automation', T, true, false, zhen(`无法判断（macOS 返回 ${code}）。`, `Could not tell (macOS returned ${code}).`),
    zhen(`打开 系统设置 → ${pn.privacy.zh} → ${pn.automation.zh}，看「${app.zh}」下面的「Google Chrome」是否打开。`,
      `Open System Settings → ${pn.privacy.en} → ${pn.automation.en} and check "Google Chrome" under "${app.en}".`),
    { settings: SETTINGS_URL.automation });
}

/**
 * The front tab of an existing window runs `String(1 + 1)`: only once Automation is allowed (else
 * the Apple event would make macOS ask), only on a web page (Chrome's own pages say nothing about
 * the switch), and by tab id so it is the tab whose URL was just read.
 * @returns {{state: 'ok'|'disabled'|'skipped'|'inconclusive', line: string}}
 */
async function probeFrontTab(c) {
  const line = (zh, en) => `前台标签实测 / front-tab test：${zh} / ${en}`;
  if (c.o.paused && c.o.paused()) return { state: 'skipped', line: line('MyChrome 已暂停，没有实测', 'not run, MyChrome is paused') };
  if (!c.results.chrome_running.ok) return { state: 'skipped', line: line('Chrome 没在运行，跳过', 'skipped, Chrome is not running') };
  if (!c.results.automation.ok) return { state: 'skipped', line: line('还没允许控制 Chrome，跳过', 'skipped until Automation is allowed') };
  const info = await helperJson(c.p, c.bin('chromectl'), ['info']);
  // Paused while Chrome answered: no script in the page (Codex r13 r4 B1).
  if (c.o.paused && c.o.paused()) return { state: 'skipped', line: line('MyChrome 已暂停，没有实测', 'not run, MyChrome is paused') };
  if (info.error === 'no_window') return { state: 'skipped', line: line('Chrome 没有打开的窗口，跳过', 'skipped, no Chrome window is open') };
  if (!info.json || info.json.ok !== true) return { state: 'inconclusive', line: line(`没读到前台标签（${info.error}）`, `could not read the front tab (${info.error})`) };
  if (!/^(https?|file):/i.test(String(info.json.url || ''))) {
    return { state: 'skipped', line: line('前台标签是 Chrome 自己的页面（如新标签页），打开任意网页后再测', 'the front tab is a Chrome page (e.g. New Tab); open any web page to test') };
  }
  const s = await c.p.tmpScript('String(1 + 1)');
  try {
    const ev = await helperJson(c.p, c.bin('chromectl'), ['eval', s.file, '--tab', String(info.json.tabId)]);
    if (ev.json && ev.json.ok === true && ev.json.result === '2') return { state: 'ok', line: line('网页里的脚本能运行', 'a script ran in the page') };
    // chromectl's own "empty result" text is not Chrome refusing (that error carries Chrome's words).
    if (ev.error === 'js_from_apple_events_disabled' && !/返回空结果/.test(ev.message)) {
      return { state: 'disabled', line: line('被 Chrome 拒绝：这个窗口所在的用户资料没打开开关', 'refused by Chrome: the switch is off in this window\'s profile') };
    }
    if (ev.error === 'TIMEOUT') return { state: 'inconclusive', line: line('Chrome 没有回应（网页可能开着对话框）', 'Chrome did not answer (the page may show a dialog)') };
    return { state: 'inconclusive', line: line(`没有结论（${ev.error || 'no result'}）`, `no verdict (${ev.error || 'no result'})`) };
  } finally {
    await s.dispose();
  }
}

const JS_SWITCH = { zh: 'Chrome：允许 Apple 事件中的 JavaScript', en: 'Allow JavaScript from Apple Events' };
/** Chrome's menu (zh: Chrome 154's zh_CN strings; its own error text says 查看 for the View menu). */
const JS_MENU = { zh: '显示（有的版本叫「查看」）→ 开发者 → 允许 Apple 事件中的 JavaScript', en: 'View → Developer → Allow JavaScript from Apple Events' };
async function checkAppleEventsJS(c) {
  const T = `${JS_SWITCH.zh} / ${JS_SWITCH.en}`;
  if (!c.results.helpers.ok) return skipped('apple_events_js', T, true, waitsFor(HELPERS));
  const pr = await c.profiles();
  if (!pr.json || pr.json.ok !== true || !Array.isArray(pr.json.profiles)) {
    return done('apple_events_js', T, true, false,
      zhen(`读不到 Chrome 的用户资料（${pr.error === 'no_local_state' ? '没有 Local State 文件' : pr.error}）。`, `Could not read Chrome's profiles (${pr.error === 'no_local_state' ? 'no Local State file' : pr.error}).`),
      zhen('打开一次 Google Chrome，再重新检查。', 'Open Google Chrome once, then check again.'));
  }
  const list = pr.json.profiles;
  const def = list.find(x => x.dir === pr.json.default) || (list.length === 1 ? list[0] : null);
  const state = (v) => v === true ? '开 / on' : v === false ? '关 / off' : '读不到设置文件 / no settings file';
  const lines = list.map(x => `「${x.name || x.dir}」（${x.dir}${x === def ? '，MyChrome 默认用它 / used by default' : ''}）：${state(x.appleEventsJS)}`);
  if (list.some(x => x !== def && x.appleEventsJS !== true)) {
    lines.push('其他用户资料只有让 agent 用它们时才需要打开。/ Other profiles need it only if the agent is told to use them.');
  }
  // The sessions' own checks (src/index.js selfCheck, o.probe 'needed'): no script in the user's front tab when the
  // profile file already says it is on (Fable r13 r2 B3); the command line always tests.
  const probe = c.o.probe === 'needed' && def && def.appleEventsJS === true
    ? { state: 'skipped', line: '前台标签实测 / front-tab test：设置文件已显示打开，这次没有实测 / not run, the profile file says it is on' }
    : await probeFrontTab(c);
  lines.push(probe.line);
  const ok = probe.state !== 'disabled' && ((def && def.appleEventsJS === true) || probe.state === 'ok');
  const where = probe.state === 'disabled' || !def
    ? { zh: '在最前面的 Chrome 窗口里', en: 'In the front Chrome window' }
    : { zh: `在「${def.name || def.dir}」的 Chrome 窗口里`, en: `In a Chrome window of profile "${def.name || def.dir}"` };
  return done('apple_events_js', T, true, ok, lines.join('\n'),
    zhen(`${where.zh}点菜单栏：${JS_MENU.zh}，让它打上勾。不用重启 Chrome；设置文件可能过几秒才更新。`,
      `${where.en}, click ${JS_MENU.en} so it is ticked. No restart needed; Chrome may take a few seconds to save it.`));
}

const ACCESS = { zh: '辅助功能：真实鼠标键盘', en: 'Accessibility: real mouse and keyboard' };
async function checkAccessibility(c) {
  const T = `${ACCESS.zh} / ${ACCESS.en}`;
  if (!c.results.helpers.ok) return skipped('accessibility', T, true, waitsFor(HELPERS));
  const [t, app, pn] = [await c.trust(), await c.app(), await c.panes()];
  if (t.json.accessibility === true) {
    return done('accessibility', T, true, true, zhen(`「${app.zh}」已在「${pn.accessibility.zh}」里打开。`, `"${app.en}" is on in "${pn.accessibility.en}".`));
  }
  return done('accessibility', T, true, false,
    zhen(`「${app.zh}」还没有「${pn.accessibility.zh}」权限，MyChrome 没法用真实鼠标键盘点击和输入。`,
      `"${app.en}" is not on in "${pn.accessibility.en}": MyChrome cannot click or type with the real mouse and keyboard.`),
    zhen(`打开 系统设置 → ${pn.privacy.zh} → ${pn.accessibility.zh}，打开「${app.zh}」的开关（列表里没有就点「+」把它加进去），然后完全退出「${app.zh}」再重新打开。`,
      `Open System Settings → ${pn.privacy.en} → ${pn.accessibility.en}, switch on "${app.en}" (not listed: add it with "+"), then quit "${app.en}" and open it again.`),
    { settings: SETTINGS_URL.accessibility });
}

const SCREEN = { zh: '屏幕录制：截图识字', en: 'Screen Recording: screenshots' };
async function checkScreenRecording(c) {
  const T = `${SCREEN.zh} / ${SCREEN.en}`;
  if (!c.results.helpers.ok) return skipped('screen_recording', T, false, waitsFor(HELPERS));
  const [t, app, pn] = [await c.trust(), await c.app(), await c.panes()];
  if (t.json.screenRecording === true) {
    return done('screen_recording', T, false, true, zhen(`「${app.zh}」已在「${pn.screen.zh}」里打开。`, `"${app.en}" is on in "${pn.screen.en}".`));
  }
  return done('screen_recording', T, false, false,
    zhen(`「${app.zh}」还没有「${pn.screen.zh}」权限：screenshot（截图识字）用不了，read_page 超出预算时也不能改读屏幕；其他功能照常。`,
      `"${app.en}" is not on in "${pn.screen.en}": screenshot (on-screen text) does not work, and read_page cannot fall back to the screen when a page is over budget; everything else works.`),
    zhen(`打开 系统设置 → ${pn.privacy.zh} → ${pn.screen.zh}，打开「${app.zh}」的开关（没有就点「+」添加），按 macOS 的提示退出并重新打开「${app.zh}」。本检查不会弹出系统的授权框。`,
      `Open System Settings → ${pn.privacy.en} → ${pn.screen.en}, switch on "${app.en}" (not listed: add it with "+"), then quit and reopen "${app.en}" when macOS asks. This check never shows the system prompt itself.`),
    { settings: SETTINGS_URL.screen_recording });
}

/** In order: later checks read earlier results (c.results). */
const CHECKS = [checkMac, checkNode, checkHelpers, checkChromeInstalled, checkChromeRunning, checkAutomation,
  checkAppleEventsJS, checkAccessibility, checkScreenRecording];

/**
 * Run every check once.
 * @param o.probes  replaces parts of realProbes() (tests)
 * @param o.askAutomation  let macOS ask its Automation question if it never has (--ask)
 * @param o.self  how to run doctor again, for the fix texts
 * @param o.probe 'always' (default) or 'needed': the front-tab test only when the profile file does not say the switch is on
 * @param o.paused  () => boolean: true skips the front-tab test (the panel's pause came while checking)
 * @returns {Promise<{ok: boolean, app: string|null, checks: object[]}>}
 */
export async function runChecks(o = {}) {
  const p = { ...realProbes(), ...(o.probes || {}) };
  const c = makeContext(p, { askAutomation: !!o.askAutomation, self: o.self || 'mychrome-mcp doctor', probe: o.probe || 'always', paused: o.paused || null });
  const checks = [];
  for (const fn of CHECKS) {
    let r;
    try { r = await fn(c); } catch (e) {
      r = { id: fn.name, title: fn.name, required: true, ok: false, skipped: false,
        detail: zhen(`检查本身出错：${e && e.message}`, `The check itself failed: ${e && e.message}`), fix: null };
    }
    c.results[r.id] = r;
    checks.push(r);
  }
  const app = c.results.helpers.ok ? await c.app() : null;
  return { ok: checks.every(x => x.ok || !x.required), app: app && app.known ? app.en : null, checks };
}

/* ----------------------------------------------------------- printing */

export function formatReport(r) {
  const out = ['MyChrome MCP 设置检查 / setup check', ''];
  const app = r.app || null;
  out.push(app
    ? `下面的系统权限是给「${app}」的（macOS 把权限记在启动程序的 App 名下）；agent 如果在别的 App 里运行（如 Claude 桌面版、Cursor），那个 App 也要同样打开。`
    : '下面的系统权限是给运行这个命令的 App 的（一般是你的终端）；agent 如果在别的 App 里运行，那个 App 也要同样打开。');
  out.push(app
    ? `The macOS permissions below are for "${app}" (macOS grants them to the app that starts the program); if your agent runs in another app (e.g. the Claude desktop app, Cursor), switch them on for that app too.`
    : 'The macOS permissions below are for the app running this command (usually your terminal); if your agent runs in another app, switch them on for that app too.');
  out.push('');
  for (const x of r.checks) {
    const mark = x.ok ? '✓' : x.skipped ? '–' : x.required ? '✗' : '!';
    out.push(`${mark} ${x.title}${x.required ? '' : '（推荐 / recommended）'}`);
    for (const l of String(x.detail || '').split('\n')) out.push(`    ${l}`);
    if (!x.ok && x.fix) {
      const [zh, en] = String(x.fix).split('\n');
      out.push(`    → 怎么做：${zh}`);
      if (en) out.push(`    → Fix: ${en}`);
    }
  }
  const req = r.checks.filter(x => x.required), bad = req.filter(x => !x.ok), rec = r.checks.filter(x => !x.required && !x.ok);
  out.push('');
  out.push(bad.length
    ? zhen(`还有 ${bad.length} 项必需的设置没完成（共 ${req.length} 项）。`, `${bad.length} of ${req.length} required checks not passed yet.`)
    : zhen(`必需的 ${req.length} 项都通过了${rec.length ? `；另有 ${rec.length} 项推荐设置未完成` : ''}。`, `All ${req.length} required checks passed${rec.length ? `; ${rec.length} recommended not set` : ''}.`));
  return out.join('\n') + '\n';
}

/* -------------------------------------------------------- command line */

const USAGE = zhen(
  `用法：mychrome-mcp doctor [--json] [--wait] [--open] [--open-chrome] [--ask]
  检查使用 MyChrome 前要做的设置，逐项告诉你点哪里。只读，不改任何设置。
  --json         机器可读的输出
  --wait         每 2 秒重新检查，必需项全部通过就结束（Ctrl-C 退出）
  --open         打开未通过的那几项对应的「系统设置」页面（只打开，不改）
  --open-chrome  Chrome 没开时替你打开它
  --ask          macOS 从没问过「自动化」时，让它现在弹窗问一次
  全部必需项通过时退出码为 0，否则为 1。`,
  `Usage: mychrome-mcp doctor [--json] [--wait] [--open] [--open-chrome] [--ask]
  Checks what MyChrome needs set up and says what to click. Read-only; changes no setting.
  --json         machine-readable output
  --wait         re-check every 2 s until every required check passes (Ctrl-C to stop)
  --open         open the System Settings pages of the checks that fail (opens only)
  --open-chrome  open Chrome if it is not running
  --ask          let macOS ask its Automation question now, if it never has
  Exit code 0 when every required check passes, 1 otherwise.`);

/** How the user can run doctor again, for the fix texts. */
export function selfCommand(env = process.env, argv1 = process.argv[1]) {
  if (env.npm_lifecycle_event === 'doctor') return 'npm run doctor --';
  if (env.npm_command === 'exec') return 'npx -y mychrome-mcp doctor';
  if (path.basename(String(argv1 || '')) === 'mychrome-mcp') return 'mychrome-mcp doctor';
  return `node "${argv1 || path.join(ROOT, 'src', 'index.js')}" doctor`;
}

/** Written and flushed before the caller exits (stdout to a pipe is asynchronous on macOS). */
const write = (out, s) => new Promise(res => out.write(s, () => res()));

/**
 * `mychrome-mcp doctor [flags]`.
 * @param o.out  where to print; o.probes  replaces machine probes (tests); o.sleep  between --wait rounds
 * @returns {Promise<number>} exit code
 */
export async function runDoctorCli(argv = [], o = {}) {
  const out = o.out || process.stdout;
  const known = new Set(['--json', '--wait', '--open', '--open-chrome', '--ask', '--help', '-h']);
  const bad = argv.filter(a => !known.has(a));
  if (bad.length || argv.includes('--help') || argv.includes('-h')) {
    await write(out, (bad.length ? `未知参数 / unknown option: ${bad.join(' ')}\n\n` : '') + USAGE + '\n');
    return bad.length ? 2 : 0;
  }
  const flag = (f) => argv.includes(f);
  const json = flag('--json'), wait = flag('--wait');
  const p = { ...realProbes(), ...(o.probes || {}) };
  const sleep = o.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const self = o.self || selfCommand();

  if (flag('--open-chrome') && !(await chromeProcesses(p)).some(x => !x.headless)) {
    await p.run('/usr/bin/open', ['-b', CHROME_BUNDLE]);
    for (let i = 0; i < 30 && !(await chromeProcesses(p)).some(x => !x.headless); i++) await sleep(500);
    if (!json) await write(out, '已打开 Google Chrome。/ Opened Google Chrome.\n\n');
  }

  let last = null, first = true;
  for (;;) {
    const r = await runChecks({ probes: o.probes, askAutomation: first && flag('--ask'), self });
    const sig = JSON.stringify(r.checks.map(x => [x.id, x.ok, x.skipped, x.detail]));
    if (sig !== last) {
      if (!first && !json) await write(out, `\n— ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 有变化 / changed —\n`);
      await write(out, json ? JSON.stringify(r) + '\n' : formatReport(r));
      last = sig;
      if (wait && !r.ok && !json) await write(out, '\n（每 2 秒重新检查，必需项全部通过会自动结束；Ctrl-C 退出）\n(Re-checking every 2 s; stops when every required check passes; Ctrl-C to quit.)\n');
    }
    if (first && flag('--open')) {
      for (const x of r.checks.filter(x => !x.ok && x.settings)) {
        await p.run('/usr/bin/open', [x.settings]);
        if (!json) await write(out, `已打开「系统设置」：${x.title} / Opened System Settings: ${x.title}\n`);
      }
    }
    first = false;
    if (r.ok || !wait) return r.ok ? 0 : 1;
    await sleep(2000);
  }
}
