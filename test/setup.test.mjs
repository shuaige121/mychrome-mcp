import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectApp, installGuiApp, parseSetupArgs, runSetup, setupInstructions, shellCommand, supportedNode, formatSetupReport } from '../src/setup.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function machine(overrides = {}) {
  const calls = [], installs = [], diagnostics = [];
  const p = {
    root: '/tmp/MyChrome source', nodePath: '/tmp/Node tools/node', home: '/tmp/isolated-user', platform: 'darwin', arch: 'arm64', nodeVersion: '24.0.0',
    env: { PATH: '/usr/bin:/bin', SAFE_SENTINEL: 'keep' }, exists: () => true, findExecutable: async () => '/tmp/Node tools/npm-cli.js',
    inspectApp: async () => ({ exists: false }),
    run: async (file, args, options) => { calls.push({ file, args, options }); return { code: 0, stdout: file.endsWith('sw_vers') ? '13.0\n' : '/mock/tool\n', stderr: '' }; },
    installGuiApp: async o => { installs.push(o); },
    doctor: async o => { diagnostics.push(o); return { ok: true, app: 'Test Host', checks: [] }; },
    ...overrides,
  };
  return { p, calls, installs, diagnostics };
}
async function isolated(fn) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mychrome-setup-test-')));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('source Node floor agrees with locked dependencies and package engines', async () => {
  for (const v of ['20.19.0', '20.20.0', '22.13.0', '24.0.0', '25.0.0']) assert.equal(supportedNode(v), true, v);
  for (const v of ['18.20.0', '20.18.9', '21.9.0', '22.12.9', '23.9.0', '24.0.0-beta', 'unknown']) assert.equal(supportedNode(v), false, v);
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.engines.node, lock.packages['node_modules/jsdom'].engines.node);
});

for (const [name, override] of [['Linux', { platform: 'linux' }], ['Intel or Rosetta Node', { arch: 'x64' }], ['old Node', { nodeVersion: '20.18.1' }]]) {
  test(`${name} stops before commands or installation`, async () => {
    const m = machine(override), r = await runSetup({}, m.p);
    assert.equal(r.ok, false); assert.equal(r.status, 'blocked'); assert.equal(m.calls.length, 0); assert.equal(m.installs.length, 0); assert.equal(m.diagnostics.length, 0);
  });
}

test('macOS 12 is blocked before any mutations', async () => {
  const m = machine(), base = m.p.run;
  m.p.run = (file, args, o) => file.endsWith('sw_vers') ? { code: 0, stdout: '12.7', stderr: '' } : base(file, args, o);
  const r = await runSetup({}, m.p);
  assert.equal(r.preflight.checks.find(c => c.id === 'macos_version').ok, false); assert.equal(m.installs.length, 0);
});

test('missing npm, Xcode, Swift and Chrome have actionable checks and no install', async () => {
  const m = machine({ findExecutable: async () => null, exists: p => !p.endsWith('Google Chrome.app') });
  const base = m.p.run;
  m.p.run = (file, args, o) => file.endsWith('xcode-select') ? { code: 1, stdout: '', stderr: 'missing' } : base(file, args, o);
  const r = await runSetup({}, m.p), checks = Object.fromEntries(r.preflight.checks.map(c => [c.id, c]));
  for (const id of ['npm', 'xcode', 'swift', 'chrome']) { assert.equal(checks[id].ok, false); assert.ok(checks[id].fix); }
  assert.match(checks.xcode.fix, /xcode-select --install/); assert.equal(m.installs.length, 0); assert.equal(m.diagnostics.length, 0);
  assert.ok(m.calls.every(c => !c.args.includes('ci')));
});

test('broken npm is detected before build', async () => {
  const m = machine(), base = m.p.run;
  m.p.run = (file, args, o) => args.includes('--version') ? { code: 1, stdout: '', stderr: 'broken npm' } : base(file, args, o);
  const r = await runSetup({}, m.p);
  assert.equal(r.preflight.checks.find(c => c.id === 'npm').ok, false); assert.equal(m.installs.length, 0);
});

test('incomplete exported source is blocked, but Git is never required', async () => {
  const m = machine({ exists: p => !p.endsWith('src/helper.swift') });
  const r = await runSetup({}, m.p);
  assert.equal(r.status, 'blocked'); assert.match(r.preflight.checks.find(c => c.id === 'source').detail, /helper.swift/);
  assert.ok(m.calls.every(c => !/git/.test(c.file)));
});

test('unknown App ownership blocks before dependency installation', async () => {
  const m = machine({ inspectApp: async () => { throw new Error('Existing app belongs to another installation'); } });
  const r = await runSetup({}, m.p);
  assert.equal(r.status, 'blocked'); assert.equal(m.installs.length, 0); assert.ok(m.calls.every(c => !c.args.includes('ci')));
});

test('check-only runs existing doctor without installing, opening, or prompting', async () => {
  const m = machine(); const appPath = '/tmp/isolated/MyChrome check.app';
  let inspected; m.p.inspectApp = async (...args) => { inspected = args; return { exists: false }; };
  const r = await runSetup({ check: true, appPath }, m.p);
  assert.equal(r.ok, true); assert.equal(r.installed, false); assert.equal(r.opened, false); assert.equal(m.installs.length, 0);
  assert.deepEqual(inspected, [appPath, m.p.root]); assert.equal(m.diagnostics.length, 1); assert.equal(m.diagnostics[0].askAutomation, false);
  assert.equal(m.diagnostics[0].probes.root, m.p.root); assert.ok(m.calls.every(c => !c.args.includes('ci') && c.file !== '/usr/bin/open'));
  assert.ok(r.commands.check.includes("'--app-path' '/tmp/isolated/MyChrome check.app'"));
  assert.ok(r.commands.setup.includes("'--app-path' '/tmp/isolated/MyChrome check.app'"));
});

test('instructions-only does no checks and never claims readiness', async () => {
  const m = machine(); const r = await runSetup({ instructions: true }, m.p);
  assert.equal(r.status, 'instructions'); assert.equal(r.ok, false); assert.equal(m.calls.length, 0); assert.equal(m.diagnostics.length, 0); assert.equal(m.installs.length, 0);
  assert.equal(r.practice, undefined); assert.equal(r.commands.practice, undefined);
  assert.equal(r.firstTask.launch, undefined); assert.equal(r.firstTask.url, undefined);
  for (const key of ['description', 'descriptionZh', 'prompt', 'promptZh']) assert.ok(r.firstTask[key].trim());
  const text = formatSetupReport(r);
  assert.ok(text.includes(r.firstTask.description) && text.includes(r.firstTask.prompt));
  assert.doesNotMatch(text, /examples\/first-task|serve\.mjs|weekend|practice task/);
});

test('setup check continues without the optional engineering fixture and does not start a task', async () => {
  const m = machine({ exists: file => !file.includes('examples/first-task') });
  const r = await runSetup({ check: true }, m.p);
  assert.equal(r.ok, true); assert.equal(r.preflight.checks.find(c => c.id === 'source').ok, true);
  assert.equal(r.installed, false); assert.equal(r.opened, false);
  assert.ok(m.calls.every(c => c.file !== '/usr/bin/open' && c.args.every(arg => !arg.includes('examples/first-task'))));
  assert.doesNotMatch(formatSetupReport(r), /practice|weekend/);
});

test('successful source setup uses absolute Node/argv, installs, diagnoses, then opens selected App', async () => {
  const m = machine(), r = await runSetup({ appPath: '/tmp/My app.app' }, m.p);
  assert.equal(r.ok, true); assert.equal(r.installed, true); assert.equal(r.opened, true);
  assert.deepEqual(r.steps.map(x => x.id), ['dependencies', 'build', 'app']);
  for (const call of m.calls.filter(c => c.args.includes('ci') || c.args.includes('build'))) {
    assert.equal(call.file, m.p.nodePath); assert.equal(call.options.cwd, m.p.root);
    assert.ok(call.options.env.PATH.startsWith('/tmp/Node tools:')); assert.equal(call.options.env.SAFE_SENTINEL, 'keep');
  }
  assert.deepEqual(m.installs[0], { root: m.p.root, nodePath: m.p.nodePath, appPath: '/tmp/My app.app' });
  assert.deepEqual(m.calls.at(-1).args, ['/tmp/My app.app']);
});

test('--no-open never launches an App', async () => {
  const m = machine(), r = await runSetup({ noOpen: true }, m.p);
  assert.equal(r.installed, true); assert.equal(r.opened, false); assert.ok(m.calls.every(c => c.file !== '/usr/bin/open'));
});

for (const failed of ['ci', 'build']) test(`${failed} failure stops and preserves its error, without App install or success claim`, async () => {
  const m = machine(), base = m.p.run;
  m.p.run = (file, args, o) => args.includes(failed) ? { code: 1, stdout: '', stderr: `${failed}: simulated failure` } : base(file, args, o);
  const r = await runSetup({}, m.p);
  assert.equal(r.ok, false); assert.equal(r.status, 'failed'); assert.match(r.error.detail, /simulated failure/); assert.equal(m.installs.length, 0); assert.equal(m.diagnostics.length, 0);
  assert.doesNotMatch(formatSetupReport(r), /Required checks passed|App installed:/);
});

test('failed permission checks keep installed-but-unready truth while opening the guide', async () => {
  const m = machine({ doctor: async () => ({ ok: false, app: 'Test Host', checks: [{ id: 'accessibility', title: 'Accessibility', required: true, ok: false, detail: 'Denied', fix: 'Open Settings' }] }) });
  const r = await runSetup({}, m.p);
  assert.equal(r.installed, true); assert.equal(r.opened, true); assert.equal(r.ok, false); assert.equal(r.status, 'needs_attention');
  const text = formatSetupReport(r); assert.match(text, /not fully ready/); assert.match(text, /actual AI client host/); assert.doesNotMatch(text, /Required checks passed/);
});

test('failed App open remains actionable and unready', async () => {
  const m = machine(), base = m.p.run;
  m.p.run = (file, args, o) => file === '/usr/bin/open' ? { code: 1, stdout: '', stderr: 'cannot open' } : base(file, args, o);
  const r = await runSetup({}, m.p);
  assert.equal(r.installed, true); assert.equal(r.opened, false); assert.equal(r.ok, false); assert.equal(r.error.step, 'open_app');
});

test('unexpected diagnostic failure still opens the installed guide without claiming readiness', async () => {
  const m = machine({ doctor: async () => { throw new Error('Simulated diagnostic failure'); } });
  const r = await runSetup({}, m.p);
  assert.equal(r.installed, true); assert.equal(r.opened, true); assert.equal(r.ok, false);
  assert.equal(r.doctor.checks[0].id, 'diagnostics'); assert.match(r.doctor.checks[0].detail, /Simulated/);
});

test('shell quoting executes literal spaces, apostrophes, dollars, and backticks', async () => {
  const values = ["/tmp/My Chrome's folder/$(printf BAD)`printf BAD`", 'a"b\\c', 'line\nbreak'];
  const command = shellCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...values]);
  assert.deepEqual(JSON.parse(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })), values);
  const instructions = setupInstructions({ root: values[0], nodePath: '/tmp/Node tools/node' });
  const config = JSON.parse(instructions.connection.claudeDesktopConfig);
  assert.equal(config.mcpServers.mychrome.command, '/tmp/Node tools/node'); assert.equal(config.mcpServers.mychrome.args[0], path.join(values[0], 'src/index.js'));
  assert.match(instructions.connection.codexConfig, /^\[mcp_servers\.mychrome\]/); assert.match(instructions.connection.codexConfig, /\ntool_timeout_sec = 900$/);
  assert.match(instructions.connection.codexNote, /add command alone does not set/);
  assert.equal(instructions.commands.practice, undefined);
});

test('CLI rejects ambiguous or relative output paths', () => {
  assert.throws(() => parseSetupArgs(['--check', '--instructions']), /either/);
  for (const args of [['--app-path'], ['--app-path', '../MyChrome.app'], ['--app-path', '/tmp/not-app'], ['--typo']]) assert.throws(() => parseSetupArgs(args));
  assert.deepEqual(parseSetupArgs(['--check', '--json', '--app-path', '/tmp/My Chrome.app', '--no-open']), { check: true, json: true, appPath: '/tmp/My Chrome.app', noOpen: true });
});

test('isolated App install is repeatable, records absolute Node, and preserves unrelated files', () => isolated(async dir => {
  const root = path.join(dir, "source's & tools"), appPath = path.join(dir, 'Applications', 'Test MyChrome.app');
  await mkdir(path.join(root, 'bin'), { recursive: true }); await writeFile(path.join(root, 'bin/cbmenu'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(root, 'bin/cbmenu'), 0o755);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.12.0' }));
  await installGuiApp({ root, appPath, nodePath: '/tmp/Node & tools/node' });
  await writeFile(path.join(appPath, 'untouched.txt'), 'keep');
  await installGuiApp({ root, appPath, nodePath: '/tmp/Node & tools/node' });
  assert.deepEqual(await inspectApp(appPath, root), { exists: true, owned: true });
  assert.equal(await readFile(path.join(appPath, 'untouched.txt'), 'utf8'), 'keep');
  const plist = await readFile(path.join(appPath, 'Contents/Info.plist'), 'utf8');
  assert.match(plist, /MyChromeNodePath<\/key><string>\/tmp\/Node &amp; tools\/node/); assert.match(plist, /source&apos;s &amp; tools/);
  assert.ok((await lstat(path.join(appPath, 'Contents/MacOS/MyChrome'))).mode & 0o111);
  await assert.rejects(inspectApp(appPath, '/different/checkout'), /another installation/);
}));

test('unowned bundles and bundle symlinks are refused without replacement', () => isolated(async dir => {
  const appPath = path.join(dir, 'Unknown.app'); await mkdir(appPath); await writeFile(path.join(appPath, 'keep'), 'original');
  await assert.rejects(inspectApp(appPath, dir), /ownership marker/);
  assert.equal(await readFile(path.join(appPath, 'keep'), 'utf8'), 'original');
  const link = path.join(dir, 'Linked.app'); await symlink(appPath, link); await assert.rejects(inspectApp(link, dir), /regular directory/);
  await mkdir(path.join(appPath, 'Contents')); await writeFile(path.join(appPath, 'Contents/mychrome-launcher.json'), JSON.stringify({ kind: 'mychrome-launcher', root: dir }));
  await symlink(path.join(appPath, 'keep'), path.join(appPath, 'Contents/Info.plist')); await assert.rejects(inspectApp(appPath, dir), /symlink/);
}));

test('exported source instructions run without Git or node_modules and emit exactly one JSON object', () => isolated(async dir => {
  const root = path.join(dir, "export with spaces and ' quote");
  for (const file of ['src/setup.js', 'src/node-support.js', 'src/doctor.js', 'scripts/setup.mjs', 'scripts/setup.sh', 'package.json']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await copyFile(path.join(ROOT, file), path.join(root, file));
  }
  const output = execFileSync('/bin/bash', [path.join(root, 'scripts/setup.sh'), '--instructions', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(output.trim().split('\n').length, 1); const r = JSON.parse(output); assert.equal(r.root, root); assert.equal(r.status, 'instructions'); assert.equal(r.ok, false);
  const child = spawn(process.execPath, [path.join(root, 'scripts/setup.mjs'), '--no-such-option', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', b => { text += b; });
  const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 2); assert.equal(JSON.parse(text).status, 'usage_error');
}));

test('shell bootstrap gives missing and obsolete Node instructions without npm or GUI', () => isolated(async dir => {
  await symlink('/usr/bin/dirname', path.join(dir, 'dirname'));
  let failure;
  try { execFileSync('/bin/bash', [path.join(ROOT, 'scripts/setup.sh')], { env: { PATH: dir }, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { failure = e; }
  assert.equal(failure.status, 1); assert.match(failure.stderr, /needs Node.js/);
  await writeFile(path.join(dir, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  try { execFileSync('/bin/bash', [path.join(ROOT, 'scripts/setup.sh')], { env: { PATH: dir }, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { failure = e; }
  assert.equal(failure.status, 1); assert.match(failure.stderr, /22.13\+/);
}));
