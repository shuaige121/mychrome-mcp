#!/usr/bin/env node
/* `mychrome-mcp doctor` (src/doctor.js) against a fake Mac: every check's pass and fail branch, the
 * command line (--json, --wait, --open, --open-chrome, --ask, exit codes); the server side: the
 * setup hint on a failed tool call, the Screen Recording question before a capture, the
 * instructions; and the real helpers' read-only parts (`cgevent trust` shape, `chromectl profiles`
 * on a fake Chrome folder). Nothing here changes a setting, shows a prompt, or talks to Chrome. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks, runDoctorCli, formatReport, selfCommand, MIN_NODE_MAJOR, CHROME_APP, SETTINGS_URL } from '../src/doctor.js';
import { NODE_ENGINE_RANGE, NODE_REQUIREMENT, supportedNode } from '../src/node-support.js';
import { supportedNode as setupSupportedNode } from '../src/setup.js';
import * as bridge from '../src/bridge.js';
import { routingInstructions } from '../src/peers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${String(e && e.message).split('\n').join('\n       ')}`); }
}

const CHROME_ARGS = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** A fully set-up Mac; `over` changes any part. Records every program run in st.calls. */
function machine(over = {}) {
  const st = {
    platform: 'darwin', arch: 'arm64', node: '24.14.1', translated: '0',
    files: new Set(['cgevent', 'chromectl', 'cbmenu'].map(n => path.join(ROOT, 'bin', n)).concat(CHROME_APP)),
    ps: [`100 ${CHROME_ARGS}`, `101 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer`],
    trust: { ok: true, accessibility: true, screenRecording: true, automation: 0, responsible: { pid: 1, name: 'Terminal' }, arch: 'arm64' },
    trustOut: null, trustSpawn: null,
    pick: { ok: true, pid: 100, candidates: [{ pid: 100 }] },
    profiles: { ok: true, default: 'Default', profiles: [{ dir: 'Default', name: 'Me', user: 'me@example.com', appleEventsJS: true }] },
    info: { ok: true, tabId: 5, url: 'https://example.com/' },
    eval: { ok: true, result: '2' },
    loctable: null, xcode: 0,
    calls: [], scripts: [], disposed: 0,
    ...over
  };
  const J = (o) => ({ code: o && o.ok === false ? 1 : 0, stdout: JSON.stringify(o) + '\n', stderr: '' });
  const run = async (file, args) => {
    const b = path.basename(file);
    st.calls.push([b, ...args]);
    switch (b) {
      case 'sw_vers': return { code: 0, stdout: '27.0.1\n', stderr: '' };
      case 'sysctl': return { code: 0, stdout: `${st.translated}\n`, stderr: '' };
      case 'ps': return { code: 0, stdout: st.ps.join('\n') + '\n', stderr: '' };
      case 'plutil':
        if (args.includes('-extract')) return { code: 0, stdout: '154.0.8037.98\n', stderr: '' };
        if (st.loctable && args[args.length - 1].endsWith('Localizable.loctable')) return { code: 0, stdout: JSON.stringify(st.loctable.loc), stderr: '' };
        if (st.loctable && args[args.length - 1].endsWith('InfoPlist.loctable')) return { code: 0, stdout: JSON.stringify(st.loctable.info), stderr: '' };
        return { code: 1, stdout: '', stderr: 'no such file' };
      case 'xcode-select': return { code: st.xcode, stdout: st.xcode === 0 ? '/Library/Developer/CommandLineTools\n' : '', stderr: '' };
      case 'cgevent':
        if (st.trustSpawn) return { code: null, stdout: '', stderr: '', spawnError: st.trustSpawn };
        if (st.trustOut != null) return { code: 1, stdout: st.trustOut, stderr: '' };
        return J(st.trust);
      case 'chromectl': return J(st[args[0]]);
      case 'open': return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected program: ${file} ${args.join(' ')}`);
  };
  const probes = {
    platform: st.platform, arch: st.arch, nodeVersion: st.node, root: ROOT, home: '/Users/test',
    exists: (p) => st.files.has(p), run,
    tmpScript: async (src) => { st.scripts.push(src); return { file: '/tmp/fake-probe.js', dispose: async () => { st.disposed++; } }; }
  };
  return { st, probes };
}
const runOn = async (over, o = {}) => { const m = machine(over); const r = await runChecks({ probes: m.probes, self: 'mychrome-mcp doctor', ...o }); return { ...m, r, c: Object.fromEntries(r.checks.map(x => [x.id, x])) }; };
const without = (...names) => new Set([...machine().st.files].filter(f => !names.some(n => f.endsWith(n))));
const sink = () => { const s = { text: '', write(chunk, cb) { s.text += chunk; if (cb) cb(); return true; } }; return s; };

console.log('src/doctor.js');

await check('a set-up Mac: all nine checks pass, required ones decide ok, the app is named, no fix texts', async () => {
  const { r, c } = await runOn({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map(x => x.id), ['macos', 'node', 'helpers', 'chrome_installed', 'chrome_running', 'automation', 'apple_events_js', 'accessibility', 'screen_recording']);
  assert.ok(r.checks.every(x => x.ok && !x.skipped && x.fix === null), JSON.stringify(r.checks.filter(x => !x.ok)));
  assert.equal(r.app, 'Terminal');
  assert.equal(c.screen_recording.required, false);
  assert.ok(r.checks.filter(x => x.id !== 'screen_recording').every(x => x.required));
  for (const x of r.checks) assert.match(x.detail, /\n/, `${x.id}: detail is Chinese, then English`);
});

await check('macos: not macOS → fail; Intel Mac (x64) → fail; Intel Node under Rosetta → fail with the arm64 Node fix', async () => {
  let { c } = await runOn({ platform: 'linux' });
  assert.equal(c.macos.ok, false); assert.match(c.macos.detail, /linux/);
  ({ c } = await runOn({ arch: 'x64' }));
  assert.equal(c.macos.ok, false); assert.match(c.macos.detail, /Intel/); assert.match(c.macos.fix, /Apple Silicon/);
  ({ c } = await runOn({ arch: 'x64', translated: '1' }));
  assert.equal(c.macos.ok, false); assert.match(c.macos.detail, /Rosetta/); assert.match(c.macos.fix, /arm64/);
  ({ c } = await runOn({}));
  assert.match(c.macos.detail, /macOS 27\.0\.1/);
});

await check('node: stable 20.19+, 22.13+ and 24+ boundaries match setup; lower versions and 21/23 fail', async () => {
  assert.equal(setupSupportedNode, supportedNode, 'doctor and setup use one version policy');
  const accepted = ['20.19.0', '20.19.1', '20.20.0', '22.13.0', '22.13.1', '22.14.0', '24.0.0', '25.0.0', '26.0.0'];
  const rejected = ['16.20.2', '18.20.0', '20.0.0', '20.18.9', '21.9.0', '22.0.0', '22.12.9', '23.9.0'];
  for (const [versions, expected] of [[accepted, true], [rejected, false]]) {
    for (const node of versions) {
      const { c, r } = await runOn({ node });
      assert.equal(c.node.ok, expected, node);
      assert.equal(r.ok, expected, `${node}: required Node failure affects the full report`);
      assert.equal(c.node.ok, setupSupportedNode(node), `${node}: setup agreement`);
      if (!expected) { assert.match(c.node.fix, /nodejs\.org/); assert.match(c.node.fix, /arm64/); }
      assert.ok(c.node.detail.includes(NODE_REQUIREMENT));
      assert.doesNotMatch(c.node.detail, /tested|测试过/);
    }
  }
});

await check('node: malformed and prerelease versions never report ready', async () => {
  for (const node of ['24.0.0-beta', '24.0.0-rc.1', '20.19.0-rc.1', '22.13.0-rc.1', 'unknown', '24', '24.0', 'v24.0.0', '24.0.0 trailing', '024.0.0', '24.00.0', '999999999999999999999999.0.0']) {
    const { c, r } = await runOn({ node });
    assert.equal(c.node.ok, false, node); assert.equal(r.ok, false, node);
    assert.equal(setupSupportedNode(node), false, node);
  }
});

await check('node: the shared policy equals package engines and the locked source dependency floor', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.engines.node, NODE_ENGINE_RANGE);
  assert.equal(lock.packages[''].engines.node, NODE_ENGINE_RANGE);
  assert.equal(lock.packages['node_modules/jsdom'].engines.node, NODE_ENGINE_RANGE);
  const sdk = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8'));
  assert.ok(MIN_NODE_MAJOR >= Number(sdk.engines.node.match(/\d+/)[0]));
});

await check('helpers: a missing bin/cgevent → fail with "npm run build" in this folder; the checks that need it wait (skipped)', async () => {
  const { r, c } = await runOn({ files: without('/bin/cgevent') });
  assert.equal(c.helpers.ok, false);
  assert.match(c.helpers.detail, /bin\/cgevent/);
  assert.ok(c.helpers.fix.includes(`cd "${ROOT}" && npm run build`), c.helpers.fix);
  for (const id of ['automation', 'apple_events_js', 'accessibility', 'screen_recording']) assert.equal(c[id].skipped, true, id);
  assert.equal(r.ok, false);
});

await check('helpers: no Xcode Command Line Tools → the fix says xcode-select --install first', async () => {
  const { c } = await runOn({ files: without('/bin/chromectl'), xcode: 2 });
  assert.match(c.helpers.fix, /xcode-select --install/);
});

await check('helpers: cgevent that will not start (wrong architecture), one from before `trust`, a broken chromectl → fail; only cbmenu missing → pass', async () => {
  let { c } = await runOn({ trustSpawn: 'EBADARCH' });
  assert.equal(c.helpers.ok, false); assert.match(c.helpers.detail, /EBADARCH/);
  ({ c } = await runOn({ trustOut: JSON.stringify({ ok: false, error: 'usage', message: 'unknown subcommand: trust' }) }));
  assert.equal(c.helpers.ok, false); assert.match(c.helpers.detail, /older version/);
  ({ c } = await runOn({ pick: 'not json' }));
  assert.equal(c.helpers.ok, false); assert.match(c.helpers.detail, /chromectl/);
  ({ c } = await runOn({ files: without('/bin/cbmenu') }));
  assert.equal(c.helpers.ok, true); assert.match(c.helpers.detail, /optional/);
});

await check('chrome_installed: in ~/Applications → fail (the agent window opens through /Applications); nowhere → fail with the download link', async () => {
  const files = without(CHROME_APP); files.add('/Users/test/Applications/Google Chrome.app');
  let { c } = await runOn({ files });
  assert.equal(c.chrome_installed.ok, false);
  assert.match(c.chrome_installed.detail, /\/Users\/test\/Applications\/Google Chrome\.app/);
  assert.match(c.chrome_installed.fix, /Applications/);
  ({ c } = await runOn({ files: without(CHROME_APP), ps: [] }));
  assert.equal(c.chrome_installed.ok, false); assert.match(c.chrome_installed.fix, /google\.com\/chrome/);
  ({ c } = await runOn({}));
  assert.match(c.chrome_installed.detail, /154\.0\.8037\.98/);
});

await check('chrome_running: not running → fail (suggests --open-chrome), Automation waits; only a headless Chrome → fail; a renderer helper alone is not Chrome', async () => {
  let { c } = await runOn({ ps: [] });
  assert.equal(c.chrome_running.ok, false); assert.match(c.chrome_running.fix, /--open-chrome/);
  assert.equal(c.automation.skipped, true);
  ({ c } = await runOn({ ps: [`200 ${CHROME_ARGS} --headless=new --user-data-dir=/tmp/x`] }));
  assert.equal(c.chrome_running.ok, false); assert.match(c.chrome_running.detail, /headless/);
  ({ c } = await runOn({ ps: [machine().st.ps[1]] }));
  assert.equal(c.chrome_running.ok, false);
});

await check('automation: -1743 (denied) → fail, System Settings path naming the app, opens the Automation pane; -1744 (never asked) → fail, --ask; 0 → pass; -600 → skipped', async () => {
  const t = (automation) => ({ ...machine().st.trust, automation });
  let { c } = await runOn({ trust: t(-1743) });
  assert.equal(c.automation.ok, false);
  assert.match(c.automation.fix, /Terminal/); assert.match(c.automation.fix, /Google Chrome/); assert.match(c.automation.fix, /自动化/);
  assert.equal(c.automation.settings, SETTINGS_URL.automation);
  ({ c } = await runOn({ trust: t(-1744) }));
  assert.equal(c.automation.ok, false); assert.match(c.automation.fix, /mychrome-mcp doctor --ask/); assert.match(c.automation.fix, /允许/);
  ({ c } = await runOn({ trust: t(-600) }));
  assert.equal(c.automation.skipped, true);
  ({ c } = await runOn({ trust: t(0) }));
  assert.equal(c.automation.ok, true);
});

await check('apple_events_js: setting on in the default profile and the front-tab test runs → pass; the test is String(1 + 1) on that tab id, its file disposed', async () => {
  const { c, st } = await runOn({});
  assert.equal(c.apple_events_js.ok, true);
  assert.match(c.apple_events_js.detail, /「Me」（Default，MyChrome 默认用它/);
  assert.doesNotMatch(c.apple_events_js.detail, /me@example\.com/, 'an account email in the output');
  assert.deepEqual(st.scripts, ['String(1 + 1)']);
  assert.ok(st.calls.some(x => x[0] === 'chromectl' && x[1] === 'eval' && x[3] === '--tab' && x[4] === '5'), JSON.stringify(st.calls));
  assert.equal(st.disposed, 1);
  assert.ok(!st.calls.some(x => x[0] === 'chromectl' && ['open', 'newwindow', 'activate', 'select', 'close'].includes(x[1])), 'touched tabs');
});

await check('apple_events_js: setting off in the prefs file and Chrome refuses the test → fail with the menu path in Chinese and English', async () => {
  const { c } = await runOn({
    profiles: { ok: true, default: 'Default', profiles: [{ dir: 'Default', name: 'Me', appleEventsJS: false }] },
    eval: { ok: false, error: 'js_from_apple_events_disabled', message: 'Executing JavaScript through AppleScript is turned off. https://support.google.com/chrome/?p=applescript' }
  });
  assert.equal(c.apple_events_js.ok, false);
  assert.match(c.apple_events_js.detail, /关 \/ off/); assert.match(c.apple_events_js.detail, /refused by Chrome/);
  assert.match(c.apple_events_js.fix, /开发者 → 允许 Apple 事件中的 JavaScript/);
  assert.match(c.apple_events_js.fix, /View → Developer → Allow JavaScript from Apple Events/);
});

await check('apple_events_js: no Preferences file (null) and no live test (Automation not allowed: no Apple event sent) → fail; off in the file but the test runs (file not saved yet) → pass', async () => {
  let { c, st } = await runOn({
    profiles: { ok: true, default: 'Default', profiles: [{ dir: 'Default', name: 'Me', appleEventsJS: null }] },
    trust: { ...machine().st.trust, automation: -1744 }
  });
  assert.equal(c.apple_events_js.ok, false); assert.match(c.apple_events_js.detail, /no settings file/);
  assert.ok(!st.calls.some(x => x[0] === 'chromectl' && (x[1] === 'info' || x[1] === 'eval')), 'probed Chrome without Automation');
  ({ c } = await runOn({ profiles: { ok: true, default: 'Default', profiles: [{ dir: 'Default', name: 'Me', appleEventsJS: false }] } }));
  assert.equal(c.apple_events_js.ok, true);
});

await check('apple_events_js: on in the default profile but the front window (another profile) refuses → fail, fix points at the front window; other profiles off are only a note', async () => {
  const profiles = { ok: true, default: 'Profile 1', profiles: [{ dir: 'Default', name: 'Other', appleEventsJS: false }, { dir: 'Profile 1', name: 'Work', appleEventsJS: true }] };
  let { c } = await runOn({ profiles, eval: { ok: false, error: 'js_from_apple_events_disabled', message: 'turned off support.google.com/chrome/?p=applescript' } });
  assert.equal(c.apple_events_js.ok, false); assert.match(c.apple_events_js.fix, /最前面的 Chrome 窗口/);
  ({ c } = await runOn({ profiles }));
  assert.equal(c.apple_events_js.ok, true);
  assert.match(c.apple_events_js.detail, /「Work」（Profile 1，MyChrome 默认用它/);
  assert.match(c.apple_events_js.detail, /Other profiles need it only/);
});

await check('apple_events_js: a Chrome page in front (chrome://newtab) is not tested; chromectl\'s "empty result" is no verdict; no window → skipped; no Local State → fail', async () => {
  const off = { ok: true, default: 'Default', profiles: [{ dir: 'Default', name: 'Me', appleEventsJS: false }] };
  let { c, st } = await runOn({ info: { ok: true, tabId: 5, url: 'chrome://newtab/' } });
  assert.equal(c.apple_events_js.ok, true); assert.match(c.apple_events_js.detail, /Chrome page/);
  assert.ok(!st.calls.some(x => x[1] === 'eval'));
  ({ c } = await runOn({ profiles: off, eval: { ok: false, error: 'js_from_apple_events_disabled', message: 'Chrome 返回空结果，通常表示「允许来自 Apple 事件的 JavaScript」未开启' } }));
  assert.equal(c.apple_events_js.ok, false); assert.match(c.apple_events_js.detail, /no verdict/);
  ({ c } = await runOn({ info: { ok: false, error: 'no_window', message: '' } }));
  assert.match(c.apple_events_js.detail, /no Chrome window/);
  ({ c } = await runOn({ profiles: { ok: false, error: 'no_local_state', message: '' } }));
  assert.equal(c.apple_events_js.ok, false); assert.match(c.apple_events_js.fix, /Open Google Chrome once/);
});

await check('accessibility: not trusted → fail, names the app, "+", quit and reopen, opens its pane; trusted → pass', async () => {
  let { c } = await runOn({ trust: { ...machine().st.trust, accessibility: false } });
  assert.equal(c.accessibility.ok, false);
  assert.match(c.accessibility.fix, /Terminal/); assert.match(c.accessibility.fix, /「\+」/); assert.match(c.accessibility.fix, /quit "Terminal" and open it again/);
  assert.equal(c.accessibility.settings, SETTINGS_URL.accessibility);
  ({ c } = await runOn({}));
  assert.equal(c.accessibility.ok, true);
});

await check('screen_recording: not allowed → fail but recommended only (overall ok stays true); allowed → pass', async () => {
  let { r, c } = await runOn({ trust: { ...machine().st.trust, screenRecording: false } });
  assert.equal(c.screen_recording.ok, false); assert.equal(c.screen_recording.required, false);
  assert.equal(c.screen_recording.settings, SETTINGS_URL.screen_recording);
  assert.match(c.screen_recording.fix, /never shows the system prompt/);
  assert.equal(r.ok, true);
  assert.match(formatReport(r), /^! 屏幕录制/m);
  ({ c } = await runOn({}));
  assert.equal(c.screen_recording.ok, true);
});

await check('pane names: read from this Mac\'s System Settings strings when present (macOS 27: Device Control and Data Access), else the classic names', async () => {
  const loctable = {
    loc: { en: { ACCESSIBILITY: 'Device Control and Data Access', AUTOMATION: 'Automation', SCREEN_CAPTURE_HEADER: 'Screen & System Audio Recording' },
      zh_CN: { ACCESSIBILITY: '设备控制和数据访问', AUTOMATION: '自动化', SCREEN_CAPTURE_HEADER: '录屏与系统录音' } },
    info: { en: { CFBundleDisplayName: 'Privacy & Security' }, zh_CN: { CFBundleDisplayName: '隐私与安全' } }
  };
  let { c } = await runOn({ loctable, trust: { ...machine().st.trust, accessibility: false } });
  assert.match(c.accessibility.fix, /系统设置 → 隐私与安全 → 设备控制和数据访问/);
  assert.match(c.accessibility.fix, /System Settings → Privacy & Security → Device Control and Data Access/);
  ({ c } = await runOn({ trust: { ...machine().st.trust, accessibility: false } }));
  assert.match(c.accessibility.fix, /隐私与安全性 → 辅助功能/);
});

await check('report: ✓ / ✗ / – marks, both languages, the fix lines, the totals', async () => {
  const { r } = await runOn({ trust: { ...machine().st.trust, accessibility: false }, ps: [] });
  const s = formatReport(r);
  assert.match(s, /^✓ macOS · Apple Silicon/m);
  assert.match(s, /^✗ Google Chrome 在运行/m);
  assert.match(s, /^– 自动化/m);
  assert.match(s, /→ 怎么做：/); assert.match(s, /→ Fix: /);
  assert.match(s, /还有 \d+ 项必需的设置没完成/); assert.match(s, /required checks not passed yet/);
});

console.log('command line');

await check('exit codes: all required pass → 0; one fails → 1; unknown option → 2 with usage; --help → 0', async () => {
  let out = sink();
  assert.equal(await runDoctorCli([], { out, probes: machine().probes, self: 'x' }), 0);
  assert.match(out.text, /必需的 8 项都通过了/);
  out = sink();
  assert.equal(await runDoctorCli([], { out, probes: machine({ node: '16.0.0' }).probes, self: 'x' }), 1);
  out = sink();
  assert.equal(await runDoctorCli(['--bogus'], { out, probes: machine().probes }), 2);
  assert.match(out.text, /unknown option: --bogus/); assert.match(out.text, /Usage:/);
  out = sink();
  assert.equal(await runDoctorCli(['--help'], { out, probes: machine().probes }), 0);
});

await check('--json: one JSON document with ok, app and every check\'s {id, ok, detail, fix}', async () => {
  const out = sink();
  const code = await runDoctorCli(['--json'], { out, probes: machine({ trust: { ...machine().st.trust, accessibility: false } }).probes, self: 'x' });
  assert.equal(code, 1);
  const j = JSON.parse(out.text);
  assert.equal(j.ok, false); assert.equal(j.app, 'Terminal');
  const a = j.checks.find(x => x.id === 'accessibility');
  assert.deepEqual(['id', 'ok', 'detail', 'fix'].map(k => k in a), [true, true, true, true]);
  assert.equal(a.ok, false);
});

await check('--wait: re-checks until the required checks pass (prints only on change, sleeps 2 s between), then exits 0', async () => {
  const m = machine({ trust: { ...machine().st.trust, accessibility: false } });
  let rounds = 0;
  const sleeps = [];
  const out = sink();
  const code = await runDoctorCli(['--wait'], { out, probes: m.probes, self: 'x', sleep: async (ms) => { sleeps.push(ms); if (++rounds === 2) m.st.trust = { ...m.st.trust, accessibility: true }; } });
  assert.equal(code, 0);
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal(out.text.match(/MyChrome MCP 设置检查/g).length, 2, 'printed an unchanged round again');
  assert.match(out.text, /有变化 \/ changed/);
});

await check('--open: opens the System Settings pane of each failing permission, once; nothing without --open', async () => {
  const over = { trust: { ...machine().st.trust, accessibility: false, screenRecording: false } };
  let m = machine(over);
  await runDoctorCli(['--open'], { out: sink(), probes: m.probes, self: 'x' });
  const opened = m.st.calls.filter(x => x[0] === 'open').map(x => x[1]);
  assert.deepEqual(opened, [SETTINGS_URL.accessibility, SETTINGS_URL.screen_recording]);
  m = machine(over);
  await runDoctorCli([], { out: sink(), probes: m.probes, self: 'x' });
  assert.ok(!m.st.calls.some(x => x[0] === 'open'), 'opened something without --open');
});

await check('--open-chrome: opens Chrome only when it is not running; never by default', async () => {
  let m = machine({ ps: [] });
  await runDoctorCli(['--open-chrome'], { out: sink(), probes: m.probes, self: 'x', sleep: async () => { m.st.ps = [`100 ${CHROME_ARGS}`]; } });
  assert.deepEqual(m.st.calls.filter(x => x[0] === 'open'), [['open', '-b', 'com.google.Chrome']]);
  m = machine({});
  await runDoctorCli(['--open-chrome'], { out: sink(), probes: m.probes, self: 'x' });
  assert.ok(!m.st.calls.some(x => x[0] === 'open'), 'opened a running Chrome');
  m = machine({ ps: [] });
  await runDoctorCli([], { out: sink(), probes: m.probes, self: 'x' });
  assert.ok(!m.st.calls.some(x => x[0] === 'open'), 'opened Chrome without --open-chrome');
});

await check('--ask: only then does cgevent trust get --ask-automation, and only in the first round', async () => {
  let m = machine({ trust: { ...machine().st.trust, accessibility: false } });
  let n = 0;
  await runDoctorCli(['--ask', '--wait'], { out: sink(), probes: m.probes, self: 'x', sleep: async () => { if (++n === 2) m.st.trust = { ...m.st.trust, accessibility: true }; } });
  const trusts = m.st.calls.filter(x => x[0] === 'cgevent').map(x => x.slice(1).join(' '));
  assert.deepEqual(trusts, ['trust --ask-automation', 'trust', 'trust']);
  m = machine({});
  await runDoctorCli([], { out: sink(), probes: m.probes, self: 'x' });
  assert.ok(m.st.calls.filter(x => x[0] === 'cgevent').every(x => !x.includes('--ask-automation')));
});

await check('the command it tells the user to re-run matches how they ran it', async () => {
  assert.equal(selfCommand({ npm_lifecycle_event: 'doctor' }, '/x/src/index.js'), 'npm run doctor --');
  assert.equal(selfCommand({ npm_command: 'exec' }, '/x/.bin/mychrome-mcp'), 'npx -y mychrome-mcp doctor');
  assert.equal(selfCommand({}, '/usr/local/bin/mychrome-mcp'), 'mychrome-mcp doctor');
  assert.equal(selfCommand({}, '/x/src/index.js'), 'node "/x/src/index.js" doctor');
});

console.log('server side');

await check('setupHint: the five setup failures end with the doctor line (with this install\'s path); anything else gets nothing', async () => {
  for (const code of ['js_from_apple_events_disabled', 'no_automation_permission', 'no_accessibility', 'no_screen_recording', 'helper_missing']) {
    const h = bridge.setupHint(code);
    assert.match(h, /^\n给 agent：/, code);
    assert.match(h, /mychrome-mcp doctor/);
    assert.doesNotMatch(h, /npx/, 'source installs must not suggest an unpublished package');
    assert.ok(h.includes(`node "${path.join(ROOT, 'src', 'index.js')}" doctor`), h);
    assert.match(h, /For the agent:/);
    assert.equal(h.trim().split('\n').length, 1, 'more than one line');
  }
  for (const code of ['chrome_not_running', 'site_blocked', 'user_cancelled', undefined, null]) assert.equal(bridge.setupHint(code), '', String(code));
});

await check('captures ask about Screen Recording first: no → no_screen_recording before screencapture runs; yes or unknown → the capture goes ahead', async () => {
  const marker = path.join(os.tmpdir(), `doctor-sc-${process.pid}`);
  fs.rmSync(marker, { force: true });
  const sc = path.join(os.tmpdir(), `doctor-sc-${process.pid}.sh`);
  fs.writeFileSync(sc, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  try {
    const cg = async (a) => a[0] === 'windowstack' ? { ok: true, id: 7, pid: 42, onScreen: true, bounds: { x: 0, y: 0, w: 100, h: 100 }, above: [] } : { ok: true };
    await assert.rejects(bridge.captureWindow({ cgWindow: 7 }, { screencapture: sc, cg, screenCheck: async () => false }),
      (e) => e.code === 'no_screen_recording' && /屏幕录制/.test(e.message) && /Screen Recording/.test(e.message));
    await assert.rejects(bridge.captureRegion({ x: 0, y: 0, w: 10, h: 10 }, { screencapture: sc, screenCheck: async () => false }), (e) => e.code === 'no_screen_recording');
    assert.equal(fs.existsSync(marker), false, 'screencapture ran without the permission');
    await assert.rejects(bridge.captureRegion({ x: 0, y: 0, w: 10, h: 10 }, { screencapture: sc, screenCheck: async () => true }), (e) => e.code !== 'no_screen_recording');
    assert.equal(fs.existsSync(marker), true);
    fs.rmSync(marker, { force: true });
    await assert.rejects(bridge.captureRegion({ x: 0, y: 0, w: 10, h: 10 }, { screencapture: sc, screenCheck: async () => null }), (e) => e.code !== 'no_screen_recording');
    assert.equal(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(marker, { force: true }); fs.rmSync(sc, { force: true });
  }
});

await check('screenRecordingAllowed: no → false (asked again next time); an old helper or an error → null; yes → true, then kept for a minute', async () => {
  let n = 0;
  assert.equal(await bridge.screenRecordingAllowed(async () => { n++; return { ok: true, screenRecording: false }; }), false);
  assert.equal(await bridge.screenRecordingAllowed(async () => { n++; return { ok: true, trusted: true }; }), null);
  assert.equal(await bridge.screenRecordingAllowed(async () => { n++; throw new Error('usage'); }), null);
  assert.equal(await bridge.screenRecordingAllowed(async (a) => { n++; assert.deepEqual(a, ['trust']); return { ok: true, screenRecording: true }; }), true);
  assert.equal(await bridge.screenRecordingAllowed(async () => { n++; return { ok: true, screenRecording: false }; }), true);
  assert.equal(n, 4);
});

await check('server instructions: one sentence sends setup failures to mychrome-mcp doctor', async () => {
  const p = { playwrightMcp: [], playwrightExtension: false, devtoolsMcp: [], playwrightLib: false, claudeInChrome: false, codexExtension: false };
  const r = routingInstructions(p);
  assert.equal(r.split('\n').filter(l => /mychrome-mcp doctor/.test(l)).length, 1);
  assert.match(r, /macOS permission or Chrome's Apple Events switch is one-time setup/);
});

await check('end to end, a copy without bin/ (HOME moved to a temp folder): a tool call fails with helper_missing plus the doctor line; `index.js doctor --json` exits 1 naming the build', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-e2e-')));   // module paths are real paths
  try {
    const copy = path.join(tmp, 'pkg');
    fs.mkdirSync(copy);
    fs.cpSync(path.join(ROOT, 'src'), path.join(copy, 'src'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(copy, 'package.json'));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'));
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const env = { PATH: process.env.PATH, HOME: home, CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_WARM: '0', CHROME_BRIDGE_HABITS: 'off' };

    const d = spawnSync(process.execPath, [path.join(copy, 'src', 'index.js'), 'doctor', '--json'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(d.status, 1, d.stderr);
    const j = JSON.parse(d.stdout);
    const h = j.checks.find(x => x.id === 'helpers');
    assert.equal(h.ok, false);
    assert.ok(h.fix.includes(`cd "${copy}"`), h.fix);

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'doctor-test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(copy, 'src', 'index.js')], env, stderr: 'ignore' }));
    try {
      assert.match(client.getInstructions(), /mychrome-mcp doctor/);
      const res = await client.callTool({ name: 'list_tabs', arguments: {} });
      assert.equal(res.isError, true);
      const text = res.content.map(x => x.text).join('\n');
      assert.match(text, /bin\/cgevent|npm run build/);
      assert.ok(text.includes(`node "${path.join(copy, 'src', 'index.js')}" doctor`), text);
    } finally {
      await client.close();
    }
    assert.deepEqual(fs.readdirSync(home).filter(x => x !== 'Library'), [], 'wrote outside Library in the temp home');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log('real helpers (read-only)');

await check('bin/cgevent trust: booleans for Accessibility and Screen Recording, a number for Automation, the responsible app; no prompt', async () => {
  const j = JSON.parse(execFileSync(path.join(ROOT, 'bin', 'cgevent'), ['trust'], { encoding: 'utf8', timeout: 20000 }));
  assert.equal(j.ok, true);
  assert.equal(typeof j.accessibility, 'boolean'); assert.equal(typeof j.screenRecording, 'boolean');
  assert.equal(typeof j.automation, 'number');
  assert.ok(j.responsible && 'pid' in j.responsible, JSON.stringify(j.responsible));
});

await check('bin/chromectl profiles on a fake Chrome folder: setting on → true, off → false, key missing → false, no Preferences → null; default = last used or CHROME_BRIDGE_PROFILE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-chrome-'));
  try {
    const put = (rel, o) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(o)); };
    put('Local State', { profile: { last_used: 'Profile 2', info_cache: { Default: { name: 'On' }, 'Profile 1': { name: 'Off' }, 'Profile 2': { name: 'Unset' }, 'Profile 3': { name: 'NoFile' } } } });
    put('Default/Preferences', { browser: { allow_javascript_apple_events: true } });
    put('Profile 1/Preferences', { browser: { allow_javascript_apple_events: false } });
    put('Profile 2/Preferences', { browser: { other: 1 } });
    const run = (extra = {}) => JSON.parse(execFileSync(path.join(ROOT, 'bin', 'chromectl'), ['profiles'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, CHROME_BRIDGE_CHROME_DIR: dir, ...extra } }));
    const j = run();
    assert.equal(j.ok, true);
    assert.deepEqual(Object.fromEntries(j.profiles.map(p => [p.name, p.appleEventsJS])), { On: true, Off: false, Unset: false, NoFile: null });
    assert.equal(j.default, 'Profile 2');
    assert.equal(run({ CHROME_BRIDGE_PROFILE: 'Off' }).default, 'Profile 1');
    fs.rmSync(path.join(dir, 'Local State'));
    assert.equal(run().error, 'no_local_state');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length) { console.log(`doctor tests FAILED: ${failures.length} (${failures.join('; ')})`); process.exit(1); }
console.log(`doctor tests passed (${passed})`);
