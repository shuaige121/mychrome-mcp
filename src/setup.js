/** Guided source setup. Client configuration is rendered, never read or changed. */
import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_APP, runChecks, formatReport } from './doctor.js';
import { NODE_REQUIREMENT, supportedNode } from './node-support.js';
export { NODE_REQUIREMENT, supportedNode } from './node-support.js';

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const shellCommand = (file, args = []) => [file, ...args].map(shellQuote).join(' ');
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

async function statOrNull(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Refuse an unknown app, a different checkout, or symlinks inside the bundle. */
export async function inspectApp(appPath, root) {
  if (!path.isAbsolute(appPath) || !appPath.endsWith('.app') || /[\0\r\n]/.test(appPath)) throw new Error('--app-path must be an absolute path ending in .app.');
  const app = await statOrNull(appPath);
  if (!app) return { exists: false, owned: false };
  if (app.isSymbolicLink() || !app.isDirectory()) throw new Error(`App destination is not a regular directory: ${appPath}`);
  for (const name of ['Contents', 'Contents/MacOS', 'Contents/Info.plist', 'Contents/mychrome-launcher.json', 'Contents/MacOS/MyChrome']) {
    const entry = await statOrNull(path.join(appPath, name));
    if (entry?.isSymbolicLink()) throw new Error(`App contains a symlink; refusing to replace it: ${name}`);
  }
  let marker;
  try { marker = JSON.parse(await readFile(path.join(appPath, 'Contents/mychrome-launcher.json'), 'utf8')); }
  catch { throw new Error(`Existing app has no valid MyChrome ownership marker: ${appPath}. Choose another --app-path.`); }
  if (marker.kind !== 'mychrome-launcher' || marker.root !== root) throw new Error(`Existing app belongs to another installation: ${appPath}. Run setup from that checkout, or choose another --app-path.`);
  return { exists: true, owned: true };
}

/** Shared with install-gui.mjs; writes only this explicitly selected, owned app bundle. */
export async function installGuiApp({ root = SOURCE_ROOT, appPath = path.join(os.homedir(), 'Applications/MyChrome.app'), nodePath = process.execPath } = {}) {
  root = await realpath(root);
  if (!path.isAbsolute(nodePath)) throw new Error('The Node executable path must be absolute.');
  const executable = path.join(root, 'bin/cbmenu');
  await access(executable, constants.X_OK);
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  await inspectApp(appPath, root);
  await mkdir(path.join(appPath, 'Contents/MacOS'), { recursive: true });
  const target = path.join(appPath, 'Contents/MacOS/MyChrome');
  const staged = `${target}.${randomUUID()}.new`;
  try {
    await copyFile(executable, staged, constants.COPYFILE_EXCL);
    await chmod(staged, 0o755);
    await rename(staged, target);
  } finally { await unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  await writeFile(path.join(appPath, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>work.mychrome.launcher</string>
<key>CFBundleName</key><string>MyChrome</string>
<key>CFBundleDisplayName</key><string>MyChrome</string>
<key>CFBundleExecutable</key><string>MyChrome</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${xml(version)}</string>
<key>MyChromeSourceRoot</key><string>${xml(root)}</string>
<key>MyChromeNodePath</key><string>${xml(nodePath)}</string>
<key>MyChromeOpensConversations</key><true/>
<key>LSUIElement</key><true/>
</dict></plist>
`);
  await writeFile(path.join(appPath, 'Contents/mychrome-launcher.json'), JSON.stringify({ kind: 'mychrome-launcher', root }) + '\n', { mode: 0o600 });
  return { appPath, version };
}

export function setupInstructions({ root = SOURCE_ROOT, nodePath = process.execPath, appPath = path.join(os.homedir(), 'Applications/MyChrome.app') } = {}) {
  if (!path.isAbsolute(root) || !path.isAbsolute(nodePath)) throw new Error('Source and Node paths must be absolute.');
  const entry = path.join(root, 'src/index.js'), setup = path.join(root, 'scripts/setup.mjs'), serve = path.join(root, 'examples/first-task/serve.mjs');
  const doctor = shellCommand(nodePath, [entry, 'doctor']);
  return {
    root, nodePath, appPath,
    commands: { setup: shellCommand(nodePath, [setup, '--app-path', appPath]), check: shellCommand(nodePath, [setup, '--check', '--app-path', appPath]), doctor,
      doctorAsk: `${doctor} --ask --open`, practice: shellCommand(nodePath, [serve, '--open']), openApp: shellCommand('/usr/bin/open', [appPath]) },
    connection: {
      claudeCommand: shellCommand('claude', ['mcp', 'add', '--scope', 'user', 'mychrome', '--', nodePath, entry]),
      codexCommand: shellCommand('codex', ['mcp', 'add', 'mychrome', '--', nodePath, entry]),
      codexConfig: `[mcp_servers.mychrome]\ncommand = ${JSON.stringify(nodePath)}\nargs = [${JSON.stringify(entry)}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 900`,
      codexNote: 'After registering, edit the existing [mcp_servers.mychrome] entry in ~/.codex/config.toml to match this block. Do not add a duplicate section. The add command alone does not set the required 900-second tool timeout.',
      claudeDesktopConfig: JSON.stringify({ mcpServers: { mychrome: { command: nodePath, args: [entry] } } }, null, 2),
      note: 'Register once per client. Review an existing mychrome entry before replacing it. Setup does not read or rewrite client configuration. Start a new client session, then ask it to use MyChrome.',
    },
    practice: {
      url: null, launch: { command: nodePath, args: [serve, '--open', '--json'] },
      prompt: 'Use MyChrome on the open MyChrome practice page. Read the weekend ideas, enter "Visit the weekend market" in Plan name, choose "Saturday morning" in When, and press "Save practice plan". Read the saved result and confirm both values. Use select_option for the dropdown. Stop when I cancel; I can press Esc twice quickly to stop and take control.',
      promptZh: '请用 MyChrome 操作已打开的 MyChrome 练习页。先读周末安排，把 Plan name 填为 Visit the weekend market，把 When 选为 Saturday morning，然后点击 Save practice plan。读取保存结果，确认这两项都正确。下拉选项用 select_option；我取消时请停止；我可以快速按两次 Esc 停止操作并接管。',
    },
  };
}

function realRun(file, args, { cwd, env, onOutput, timeout = 10_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const capture = (channel, data) => {
      const text = String(data);
      if (channel === 'stdout') stdout = (stdout + text).slice(-16384); else stderr = (stderr + text).slice(-16384);
      onOutput?.(text);
    };
    child.stdout.on('data', data => capture('stdout', data));
    child.stderr.on('data', data => capture('stderr', data));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, spawnError: error.code, stdout, stderr }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, ...(timedOut ? { spawnError: 'TIMEOUT' } : {}), stdout, stderr }); });
  });
}

async function findExecutable(name, searchPath = process.env.PATH || '') {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(dir, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  return null;
}

function systemDefaults() {
  return { root: SOURCE_ROOT, nodePath: process.execPath, home: os.homedir(), platform: process.platform,
    arch: process.arch, nodeVersion: process.versions.node, exists: existsSync, run: realRun,
    findExecutable, inspectApp, installGuiApp, doctor: runChecks, env: process.env };
}
const check = (id, title, ok, detail, fix = null) => ({ id, title, required: true, ok, detail, fix: ok ? null : fix });

export async function runSetup(options = {}, overrides = {}) {
  const p = { ...systemDefaults(), ...overrides };
  const appPath = options.appPath || path.join(p.home, 'Applications/MyChrome.app');
  const report = { schemaVersion: 1, ok: false, status: 'not_checked', ...setupInstructions({ root: p.root, nodePath: p.nodePath, appPath }),
    preflight: { ok: false, checks: [] }, doctor: null, installed: false, opened: false, steps: [] };
  if (options.instructions) { report.status = 'instructions'; return report; }
  const checks = report.preflight.checks, mac = p.platform === 'darwin' && p.arch === 'arm64';
  checks.push(check('platform', 'Apple Silicon Mac', mac, `${p.platform} / ${p.arch}`, 'Use an Apple Silicon Mac with native arm64 Node.js. Intel Macs, Rosetta Node, Linux and Windows are not supported.'));
  checks.push(check('node', NODE_REQUIREMENT, supportedNode(p.nodeVersion), `Node.js ${p.nodeVersion}`, 'Install the arm64 LTS release from https://nodejs.org, reopen Terminal, then run setup again.'));
  if (!mac || !checks.at(-1).ok) { report.status = 'blocked'; return report; }
  const osVersion = await p.run('/usr/bin/sw_vers', ['-productVersion']);
  checks.push(check('macos_version', 'macOS 13 or newer', osVersion.code === 0 && Number(osVersion.stdout.trim().split('.')[0]) >= 13,
    osVersion.stdout.trim() || 'Could not read macOS version.', 'Upgrade to macOS 13 or newer before building MyChrome.'));
  const npm = await p.findExecutable('npm'), npmVersion = npm ? await p.run(p.nodePath, [npm, '--version']) : null;
  checks.push(check('npm', 'npm', !!npm && npmVersion?.code === 0, npmVersion?.stdout?.trim() || 'npm was not found or could not run.', 'Install Node.js with npm from https://nodejs.org, reopen Terminal, then run setup again.'));
  const xcode = await p.run('/usr/bin/xcode-select', ['-p']);
  checks.push(check('xcode', 'Xcode Command Line Tools', xcode.code === 0, xcode.code === 0 ? xcode.stdout.trim() : 'Command Line Tools are missing.', 'Run xcode-select --install, finish the Apple installer, then run setup again.'));
  const swift = xcode.code === 0 ? await p.run('/usr/bin/xcrun', ['--find', 'swiftc']) : null;
  checks.push(check('swift', 'Swift compiler', swift?.code === 0, swift?.stdout?.trim() || 'Swift compiler is unavailable.', 'Install the Xcode Command Line Tools using xcode-select --install.'));
  checks.push(check('chrome', 'Google Chrome', p.exists(CHROME_APP), CHROME_APP, 'Install Google Chrome from https://www.google.com/chrome/ and move it to /Applications.'));
  const required = ['package.json', 'package-lock.json', 'src/index.js', 'src/helper.swift', 'src/chromectl.swift', 'src/menubar.swift', 'scripts/install-gui.mjs', 'examples/first-task/serve.mjs'];
  const missing = required.filter(name => !p.exists(path.join(p.root, name)));
  checks.push(check('source', 'Complete source checkout', missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : p.root,
    'Use the complete source release or Git checkout, keep it in a stable directory, and run scripts/setup.sh from there.'));
  try {
    const app = await p.inspectApp(appPath, p.root);
    checks.push(check('app_destination', 'App destination', true, app.exists ? `This checkout owns ${appPath}; setup may update it.` : `Will install to ${appPath}.`));
  } catch (error) { checks.push(check('app_destination', 'App destination', false, error.message, 'Keep the existing app. Run setup with --app-path /absolute/path/to/Another-MyChrome.app.')); }
  report.preflight.ok = checks.every(item => item.ok);
  if (!report.preflight.ok) { report.status = 'blocked'; return report; }
  if (!options.check) {
    const env = { ...p.env, PATH: `${path.dirname(p.nodePath)}${path.delimiter}${p.env.PATH || ''}` };
    for (const [id, args] of [['dependencies', [npm, 'ci']], ['build', [npm, 'run', 'build']]]) {
      options.onProgress?.(id === 'dependencies' ? 'Installing locked dependencies…' : 'Building the native helpers…');
      const result = await p.run(p.nodePath, args, { cwd: p.root, env, timeout: 600_000, onOutput: options.onOutput });
      report.steps.push({ id, ok: result.code === 0 && !result.spawnError });
      if (!report.steps.at(-1).ok) {
        report.status = 'failed'; report.error = { step: id, detail: result.stderr || result.stdout || result.spawnError || `Exit ${result.code}`, fix: `Resolve the ${id} error above, then rerun ${report.commands.setup}.` }; return report;
      }
    }
    try {
      options.onProgress?.('Installing the MyChrome app…');
      await p.installGuiApp({ root: p.root, appPath, nodePath: p.nodePath });
      report.installed = true; report.steps.push({ id: 'app', ok: true });
    } catch (error) { report.status = 'failed'; report.error = { step: 'app', detail: error.message, fix: 'Resolve the app destination or permissions issue, then run setup again.' }; return report; }
  }
  try {
    report.doctor = await p.doctor({ probes: { root: p.root, home: p.home, platform: p.platform, arch: p.arch, nodeVersion: p.nodeVersion }, askAutomation: false, probe: 'needed', self: report.commands.doctor });
  } catch (error) {
    report.doctor = { ok: false, app: null, checks: [check('diagnostics', 'Permission diagnostics', false, error.message,
      `Run ${report.commands.doctor} from the application that starts MyChrome.`)] };
  }
  report.ok = report.doctor.ok; report.status = report.ok ? 'checks_passed' : 'needs_attention';
  if (report.installed && !options.noOpen) {
    const opened = await p.run('/usr/bin/open', [appPath]); report.opened = opened.code === 0;
    if (!report.opened) { report.ok = false; report.status = 'needs_attention'; report.error = { step: 'open_app', detail: opened.stderr || opened.spawnError || 'The app could not be opened.', fix: `Open the installed app manually: ${report.commands.openApp}` }; }
  }
  return report;
}

export const SETUP_USAGE = `Usage: bash scripts/setup.sh [--check | --instructions] [--json] [--app-path ABSOLUTE.app] [--no-open]
  Default         Check prerequisites, npm ci, build, install, diagnose, then open MyChrome.
  --check         Diagnose only; no install, permission prompts, or client-config changes.
  --instructions  Render exact-path client and practice instructions without running checks.
  --json          Print one JSON object. Build progress goes to stderr.
  --app-path      Install/check an explicit App destination (default: ~/Applications/MyChrome.app).
  --no-open       Leave the installed App closed.
  --help          Show this help.
Keep this source directory in place. Existing client configuration is never rewritten.
Exit 0: required checks passed (or instructions/help requested); 1: action still needed; 2: usage error.
Passing checks does not prove that an AI client is connected or that the practice task succeeded.`;

export function parseSetupArgs(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') o.check = true;
    else if (arg === '--instructions') o.instructions = true;
    else if (arg === '--json') o.json = true;
    else if (arg === '--no-open') o.noOpen = true;
    else if (arg === '--help' || arg === '-h') o.help = true;
    else if (arg === '--app-path') {
      o.appPath = args[++i];
      if (!o.appPath || !path.isAbsolute(o.appPath) || !o.appPath.endsWith('.app') || /[\0\r\n]/.test(o.appPath)) throw new Error('--app-path needs an absolute path ending in .app.');
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (o.check && o.instructions) throw new Error('Choose either --check or --instructions.');
  return o;
}

export function formatSetupReport(report) {
  const lines = ['MyChrome source setup', ''];
  for (const c of report.preflight.checks) { lines.push(`${c.ok ? '✓' : '✗'} ${c.title}: ${c.detail}`); if (c.fix) lines.push(`  Next: ${c.fix}`); }
  if (report.doctor) lines.push('', formatReport(report.doctor));
  if (report.error) lines.push('', `Stopped at ${report.error.step}: ${report.error.detail}`, report.error.fix);
  if (report.installed) lines.push('', `App installed: ${report.appPath}`, report.opened ? 'MyChrome was opened. Continue in its welcome guide.' : `Open it when ready: ${report.commands.openApp}`);
  if (report.status !== 'instructions') lines.push('', report.ok ? 'Required checks passed for this app. Connect your AI client, then complete the local practice task to verify the full workflow.' : 'Setup is not fully ready. Complete the required steps above, then run the check again.');
  lines.push('', 'Connect Claude Code (register once):', report.connection.claudeCommand,
    '', 'Connect Codex (register once):', report.connection.codexCommand, report.connection.codexNote, report.connection.codexConfig,
    '', report.connection.note, 'Permissions belong to the app launching MyChrome; run doctor from your actual AI client host too.',
    'Claude supports browser tools and handoff. Live conversation text and direct GUI replies require a supported Codex host.',
    '', 'Try a local practice task (server stops after 30 minutes; Ctrl-C stops it sooner):', report.commands.practice, report.practice.prompt,
    '', `Recheck: ${report.commands.check}`);
  return lines.join('\n') + '\n';
}
