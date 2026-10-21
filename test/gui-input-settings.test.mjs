/* User input preferences through the production resolver and native dry-run
 * helper. All settings and pasteboards are synthetic; no Chrome or real input. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as S from '../src/settings.js';
import { INPUT_MODES, typingSegments } from '../src/guard.js';
import { BridgeError } from '../src/bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mychrome-input-settings-'));
const env = { ...process.env, CHROME_BRIDGE_SETTINGS: path.join(tmp, 'settings.json'),
  CHROME_BRIDGE_LOCK: path.join(tmp, 'input.lock'), CHROME_BRIDGE_HABITS: 'off',
  CGEVENT_DRYRUN: '1', CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.settings.${process.pid}` };
for (const setting of Object.values(S.SETTINGS)) if (setting.env) delete env[setting.env];
const source = await fs.readFile(path.join(root, 'src/index.js'), 'utf8');
const start = source.indexOf('async function typeText(');
const typeText = source.slice(start, source.indexOf('\n}', start) + 2);
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`  ok  ${name}`); };
const clear = () => fs.writeFile(env.CHROME_BRIDGE_SETTINGS, '{}');

function typingHarness(beforeAction = () => {}, temporal = { fail: 'not_temporal' }) {
  const calls = [];
  const c = vm.createContext({
    S: { setting: key => S.setting(key, env) }, BridgeError, INPUT_MODES, typingSegments,
    persist: async fn => { calls.push('persist'); return fn({}); },
    inputAction: async (_label, _prepare, action, options) => {
      beforeAction(); calls.push('action');
      await options.preflight?.();
      await _prepare();
      return action({}, {}, {}, {});
    },
    typeInSession: async (_s, _prep, _ctx, args) => { calls.push(args.input_mode); return args; },
    prepareActivate: () => { calls.push('activate'); }, activationHint: () => {}, clickPreflight: () => {},
    temporalState: async () => temporal, newToken: () => 'synthetic-binding',
    veilFor: () => {}, taskKey: () => 'Synthetic input settings',
  });
  vm.runInContext(typeText, c);
  return { calls, type: args => c.typeText(args) };
}

await check('defaults and strict, live settings resolve with environment precedence', async () => {
  await clear();
  assert.deepEqual(S.setting('inputMode', env), { value: 'auto', source: 'default' });
  assert.deepEqual(S.setting('inputSpeed', env), { value: 1, source: 'default' });
  S.writeSettings({ inputMode: 'paste', inputSpeed: 0.75 }, env);
  assert.deepEqual(S.setting('inputMode', env), { value: 'paste', source: 'file' });
  assert.equal(S.get('inputSpeed', env), 0.75);
  const fixed = { ...env, CHROME_BRIDGE_INPUT_MODE: 'keys', CHROME_BRIDGE_INPUT_SPEED: '3' };
  assert.deepEqual(S.envLocked(fixed), { inputMode: 'keys', inputSpeed: 3 });
  for (const value of [true, '2', 0, 1.2, 4]) assert.throws(() => S.writeSettings({ inputSpeed: value }, env), /bad value/);
  assert.throws(() => S.writeSettings({ inputMode: 'other' }, env), /bad value/);
});

await check('user choice overrides tool mode; no preference retains explicit paste and keys default', async () => {
  await clear();
  const h = typingHarness();
  assert.equal((await h.type({ text: 'abc' })).input_mode, 'keys');
  assert.equal((await h.type({ text: '中文', input_mode: 'paste' })).input_mode, 'paste');
  S.writeSettings({ inputMode: 'paste' }, env);
  assert.equal((await h.type({ text: '中文', input_mode: 'keys' })).input_mode, 'paste');
  S.writeSettings({ inputMode: 'keys' }, env);
  const refused = typingHarness();
  await assert.rejects(refused.type({ text: '中文', input_mode: 'paste' }), e => e.code === 'unsupported_key_text');
  assert.deepEqual(refused.calls, [], 'unsupported keys stop before takeover or focus click');
  assert.equal((await h.type({ text: 'abc', input_mode: 'paste' })).input_mode, 'keys');
  S.writeSettings({ inputMode: 'auto' }, env);
  assert.equal((await h.type({ text: '中文', input_mode: 'paste' })).input_mode, 'paste');
  assert.equal((await h.type({ text: 'abc' })).input_mode, 'keys');
  env.CHROME_BRIDGE_INPUT_MODE = 'paste';
  assert.equal((await h.type({ text: '中文', input_mode: 'keys' })).input_mode, 'paste');
  env.CHROME_BRIDGE_INPUT_MODE = 'auto';
  S.writeSettings({ inputMode: 'keys' }, env);
  assert.equal((await h.type({ text: '中文', input_mode: 'paste' })).input_mode, 'paste');
  delete env.CHROME_BRIDGE_INPUT_MODE;
});

await check('a preference changed while queued is rechecked before text or focus click', async () => {
  S.writeSettings({ inputMode: 'paste' }, env);
  const h = typingHarness(() => S.writeSettings({ inputMode: 'keys' }, env));
  await assert.rejects(h.type({ text: '中文' }), e => e.code === 'unsupported_key_text');
  assert.deepEqual(h.calls, ['persist', 'action']);
});

await check('date/time paste is rejected in preflight before activation, focus or text', async () => {
  for (const mode of ['paste', 'auto']) {
    S.writeSettings({ inputMode: mode }, env);
    const h = typingHarness(() => {}, { type: 'date', expected: '2026-10-21' });
    await assert.rejects(h.type({ marker: 7, text: '2026-10-21', input_mode: 'paste' }),
      e => e.code === 'temporal_paste_unsupported');
    assert.deepEqual(h.calls, ['persist', 'action']);
  }
});

let speedProbe, speedFunctions;
await check('production arrow-speed persistence preserves unrelated preferences and rejects invalid data', async () => {
  const swift = await fs.readFile(path.join(root, 'src/helper.swift'), 'utf8');
  const menuSource = await fs.readFile(path.join(root, 'src/menubar.swift'), 'utf8');
  const speeds = swift.match(/^let PANEL_SPEEDS: \[Double\] = (\[[^\n]+\])/m);
  assert.ok(speeds);
  assert.deepEqual(JSON.parse(speeds[1]), S.INPUT_SPEEDS);
  assert.deepEqual(JSON.parse(menuSource.match(/static let inputSpeeds: \[Double\] = (\[[^\n]+\])/)[1]), S.INPUT_SPEEDS);
  const names = ['panelSpeedPath', 'panelSpeedSettingsPath', 'panelSpeedFromEnvironment',
    'configuredPanelSpeed', 'withSettingsWriteLock', 'writeSettingsObject', 'savePanelSpeed', 'panelSpeedStep'];
  const functions = names.map(name => {
    const at = swift.indexOf(`func ${name}(`);
    assert.ok(at >= 0, name);
    return swift.slice(at, swift.indexOf('\n}', at) + 2);
  }).join('\n');
  speedFunctions = functions;
  const probeSource = path.join(tmp, 'speed-probe.swift'), probe = path.join(tmp, 'speed-probe');
  speedProbe = probe;
  await fs.writeFile(probeSource, `import Foundation\nimport CoreFoundation\n` +
    `${speeds[0]}\n` +
    `func veilStampPath() -> String { ProcessInfo.processInfo.environment["CHROME_BRIDGE_LOCK"]! + ".stamp" }\n` +
    functions + '\nlet before = configuredPanelSpeed(dry: false) ?? 1\n' +
    'let next = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1])! : panelSpeedStep(before, 1)\n' +
    'exit(savePanelSpeed(next) ? 0 : 2)\n');
  execFileSync('swiftc', ['-o', probe, probeSource], { timeout: 60_000, stdio: 'pipe' });
  await fs.writeFile(env.CHROME_BRIDGE_SETTINGS, JSON.stringify({ inputMode: 'paste', inputSpeed: 1, future: { keep: true } }));
  execFileSync(probe, [], { env, timeout: 5000 });
  assert.deepEqual(JSON.parse(await fs.readFile(env.CHROME_BRIDGE_SETTINGS, 'utf8')),
    { version: 1, inputMode: 'paste', inputSpeed: 1.5, future: { keep: true } });
  assert.equal(S.get('inputSpeed', env), 1.5);
  assert.throws(() => execFileSync(probe, [], { env: { ...env, CHROME_BRIDGE_INPUT_SPEED: '3' }, timeout: 5000, stdio: 'pipe' }));
  assert.equal(S.get('inputSpeed', env), 1.5, 'environment-fixed speed never rewrites user preference');
  await fs.writeFile(env.CHROME_BRIDGE_SETTINGS, '{ invalid JSON');
  assert.throws(() => execFileSync(probe, [], { env, timeout: 5000, stdio: 'pipe' }));
  assert.equal(await fs.readFile(env.CHROME_BRIDGE_SETTINGS, 'utf8'), '{ invalid JSON');
  await clear();
});

await check('pending arrow saves cannot roll back; latest receipt wins and failure restores visibly', async () => {
  const swift = await fs.readFile(path.join(root, 'src/helper.swift'), 'utf8');
  const methods = ['changeSpeed', 'finishSpeedSave', 'refreshSpeedSetting', 'settleSpeedSaveBeforeExit'].map(name => {
    const at = swift.indexOf(`    func ${name}(`);
    assert.ok(at >= 0, name);
    return swift.slice(at, swift.indexOf('\n    }', at) + 6);
  }).join('\n');
  const probeSource = path.join(tmp, 'pending-speed.swift'), probe = path.join(tmp, 'pending-speed');
  await fs.writeFile(probeSource, `import Foundation\nimport CoreFoundation\n` +
    `let PANEL_SPEEDS: [Double] = [0.5, 0.75, 1, 1.5, 2, 3]\n` +
    `func veilStampPath() -> String { ProcessInfo.processInfo.environment["CHROME_BRIDGE_LOCK"]! + ".stamp" }\n` +
    speedFunctions + '\nlet panelSpeedSaveQueue = DispatchQueue(label: "synthetic-speed-save")\n' +
    `final class Panel { var state = "idle"; func setSpeed(_ value: Double) {}; func setSpeedSaveState(_ value: String) { state = value } }\n` +
    `final class Probe { var holding = true, releasePending = false, dry = false\n` +
    `var speed = 1.0, speedLoaded = false; var configuredSpeed: Double?\n` +
    `var speedSaveGeneration = 0; var pendingSpeedSave: Int?; var speedSaveState = "idle"\nvar panel: Panel? = Panel()\n` + methods + '\n}\n' +
    `let file = panelSpeedSettingsPath(), lock = file + ".write-lock"\n` +
    `func claim() { precondition(symlink("\\(getpid()):\\(UUID().uuidString)", lock) == 0) }\n` +
    `func settle(_ p: Probe) { let end = Date().addingTimeInterval(2); while p.pendingSpeedSave != nil && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.005)) }; precondition(p.pendingSpeedSave == nil) }\n` +
    `precondition(writeSettingsObject(file, ["inputSpeed": 1]))\nlet p = Probe(); p.refreshSpeedSetting(); claim()\n` +
    `p.changeSpeed(1); precondition(p.speed == 1.5 && p.pendingSpeedSave != nil); p.refreshSpeedSetting(); precondition(p.speed == 1.5)\n` +
    `_ = unlink(lock); p.settleSpeedSaveBeforeExit(); precondition(p.pendingSpeedSave == nil && p.speed == 1.5 && p.speedSaveState == "saved")\n` +
    `claim(); p.changeSpeed(1); p.changeSpeed(1); let latest = p.pendingSpeedSave!\n` +
    `p.finishSpeedSave(latest - 1, saved: true); precondition(p.pendingSpeedSave == latest && p.speed == 3)\n` +
    `_ = unlink(lock); settle(p); precondition(p.speed == 3 && configuredPanelSpeed(dry: false) == 3)\n` +
    `claim(); p.changeSpeed(-1); precondition(p.speed == 2); settle(p)\n` +
    `precondition(p.speed == 3 && p.speedSaveState == "failed" && p.panel!.state == "failed"); _ = unlink(lock)\n` +
    `print("pending/saved/failed states verified")\n`);
  execFileSync('swiftc', ['-o', probe, probeSource], { timeout: 60_000, stdio: 'pipe' });
  assert.match(execFileSync(probe, [], { env, timeout: 10_000, encoding: 'utf8' }), /states verified/);
});

const menu = process.env.CBMENU_BIN || path.join(root, 'bin/cbmenu');
await check('all writers refuse a live lock and preserve damaged settings', async () => {
  await clear();
  const lock = env.CHROME_BRIDGE_SETTINGS + '.write-lock', token = `${process.pid}:${randomUUID()}`;
  await fs.symlink(token, lock);
  try {
    assert.throws(() => S.writeSettings({ inputMode: 'paste' }, env), e => e.code === 'settings_busy');
    for (const [bin, args] of [[menu, ['--write-setting', 'notify', 'false']], [speedProbe, ['2']]]) {
      assert.throws(() => execFileSync(bin, args, { env, stdio: 'pipe', timeout: 5000 }));
    }
    assert.equal(await fs.readlink(lock), token, 'live owner is not reclaimed by age or contention');
    assert.equal(await fs.readFile(env.CHROME_BRIDGE_SETTINGS, 'utf8'), '{}');
  } finally { await fs.unlink(lock); }
  for (const bad of ['{broken', 'null', '[]']) {
    await fs.writeFile(env.CHROME_BRIDGE_SETTINGS, bad);
    assert.throws(() => S.writeSettings({ inputMode: 'paste' }, env), e => e.code === 'settings_invalid');
    for (const [bin, args] of [[menu, ['--write-setting', 'notify', 'false']], [speedProbe, ['2']]]) {
      assert.throws(() => execFileSync(bin, args, { env, stdio: 'pipe', timeout: 5000 }));
    }
    assert.equal(await fs.readFile(env.CHROME_BRIDGE_SETTINGS, 'utf8'), bad);
  }
  await clear();
});

await check('dead owners recover safely; unknown owners and interrupted cleanup stay closed', async () => {
  const deadChild = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(deadChild, 'exit');
  const lock = env.CHROME_BRIDGE_SETTINGS + '.write-lock';
  const writers = [() => S.writeSettings({ inputMode: 'paste' }, env),
    () => execFileSync(menu, ['--write-setting', 'notify', 'false'], { env, stdio: 'pipe' }),
    () => execFileSync(speedProbe, ['2'], { env, stdio: 'pipe' })];
  for (const write of writers) {
    await fs.symlink(`${deadChild.pid}:${randomUUID()}`, lock);
    write();
    await assert.rejects(fs.lstat(lock), e => e.code === 'ENOENT');
  }
  await fs.symlink('not-an-owner', lock);
  try { for (const write of writers) assert.throws(write); }
  finally { await fs.unlink(lock); }
  await fs.symlink(`${deadChild.pid}:${randomUUID()}`, lock);
  await fs.mkdir(env.CHROME_BRIDGE_SETTINGS + '.write-recovery');
  try { for (const write of writers) assert.throws(write); }
  finally { await fs.unlink(lock); await fs.rmdir(env.CHROME_BRIDGE_SETTINGS + '.write-recovery'); }
});

await check('real Node, GUI CLI and production helper writers preserve concurrent updates', async () => {
  const runner = path.join(tmp, 'writer.mjs');
  const moduleURL = new URL('../src/settings.js', import.meta.url).href;
  await fs.writeFile(runner, `import fs from 'node:fs'; import { execFileSync } from 'node:child_process';\n` +
    `import { writeSettings } from ${JSON.stringify(moduleURL)};\n` +
    `while (!fs.existsSync(process.argv[2])) await new Promise(r => setTimeout(r, 2));\n` +
    `if (process.argv[3] === 'node') writeSettings({ inputMode: 'paste' });\n` +
    `else execFileSync(process.argv[3], process.argv.slice(4), { stdio: 'pipe' });\n`);
  const launch = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(err || `writer exit ${code}`)));
  });
  for (let round = 0; round < 5; round++) {
    await fs.writeFile(env.CHROME_BRIDGE_SETTINGS, JSON.stringify({ inputMode: 'auto', notify: true,
      inputSpeed: 1, future: { keep: true }, padding: 'x'.repeat(250_000) }));
    const barrier = path.join(tmp, `barrier-${round}`);
    const writes = [launch([barrier, 'node']), launch([barrier, menu, '--write-setting', 'notify', 'false']),
      launch([barrier, speedProbe, '1.5'])];
    await fs.writeFile(barrier, 'go');
    await Promise.all(writes);
    const saved = JSON.parse(await fs.readFile(env.CHROME_BRIDGE_SETTINGS, 'utf8'));
    assert.equal(saved.inputMode, 'paste'); assert.equal(saved.notify, false); assert.equal(saved.inputSpeed, 1.5);
    assert.deepEqual(saved.future, { keep: true }); assert.equal(saved.padding.length, 250_000);
    assert.equal(saved.version, 1);
  }
});

const bin = process.env.CGEVENT_BIN || path.join(root, 'bin/cgevent');
async function native(extra = {}) {
  const child = spawn(bin, ['session'], { env: { ...env, CGEVENT_SEED: 'gui-input-settings', ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let seq = 0, stderr = '';
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const r = JSON.parse(line), p = pending.get(r.id);
    if (p) { clearTimeout(p.timer); pending.delete(r.id); p.resolve(r); }
  });
  const send = req => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native ${req.op} timed out: ${stderr}`)); }, 15_000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ ...req, id }) + '\n');
  });
  const panel = { who: 'Synthetic settings test', action: 'type', stages: [{ key: 'type', label: 'Typing', est: 1000, paced: true }] };
  const held = await send({ op: 'hold', veil: { panel } });
  assert.equal(held.ok, true);
  const begin = await send({ op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, takeover: true });
  assert.equal(begin.dryRun, true);
  return { send, async close() {
    await send({ op: 'end' }); child.stdin.end(); await exited; lines.close();
    assert.equal(child.exitCode, 0, stderr);
  } };
}

await check('a fresh native session defaults to 1× even with a recent legacy speed cache', async () => {
  await clear();
  await fs.writeFile(path.join(path.dirname(env.CHROME_BRIDGE_LOCK), 'speed'), JSON.stringify({ speed: 3, at: Date.now() }));
  const s = await native();
  try {
    const result = await s.send({ op: 'type', text: 'abc', firstDelay: false });
    assert.equal(result.panel.speed, 1);
  } finally { await s.close(); }
});

await check('persistent speed reaches the native helper and changes within the same held session', async () => {
  S.writeSettings({ inputSpeed: 0.5 }, env);
  const s = await native();
  try {
    const slow = await s.send({ op: 'type', text: 'abcdef', firstDelay: false });
    assert.equal(slow.panel.speed, 0.5);
    assert.equal(slow.typed, 6);
    S.writeSettings({ inputSpeed: 3 }, env);
    const fast = await s.send({ op: 'type', text: 'abcdef', firstDelay: false });
    assert.equal(fast.panel.speed, 3);
    assert.equal(fast.typed, 6);
    const duration = r => r.posted.at(-1).t - r.posted[0].t;
    assert.ok(duration(fast) < duration(slow) * 0.6, 'native pacing changed, not only panel JSON');
    const events = fast.posted.filter(e => e.type === 'keyDown' || e.type === 'keyUp');
    for (let i = 0; i + 1 < events.length; i += 2) {
      assert.ok(events[i + 1].t - events[i].t >= 29, 'existing 30 ms minimum key dwell retained');
    }
    assert.equal(fast.takeover.active, true, 'same continuous hold remains active');
  } finally { await s.close(); }
});

await check('native environment speed is fixed; arrow keys cannot silently override it', async () => {
  S.writeSettings({ inputSpeed: 0.5 }, env);
  const s = await native({ CHROME_BRIDGE_INPUT_SPEED: '2' });
  try {
    const first = await s.send({ op: 'type', text: 'a', firstDelay: false });
    assert.equal(first.panel.speed, 2);
    const down = await s.send({ op: '_inject', kind: 'speedDown' });
    assert.equal(down.speed, 2);
    S.writeSettings({ inputSpeed: 3 }, env);
    const next = await s.send({ op: 'type', text: 'b', firstDelay: false });
    assert.equal(next.panel.speed, 2);
  } finally { await s.close(); }
});

await check('native settings reader and validated CLI setter match server settings', async () => {
  execFileSync(menu, ['--write-setting', 'inputMode', 'paste'], { env });
  execFileSync(menu, ['--write-setting', 'inputSpeed', '1.5'], { env });
  const st = JSON.parse(execFileSync(menu, ['--read-settings'], { env, encoding: 'utf8' }));
  assert.equal(st.inputMode, 'paste'); assert.equal(st.inputSpeed, 1.5);
  assert.equal(S.get('inputSpeed', env), 1.5);
  for (const [key, value] of [['inputMode', 'other'], ['inputSpeed', '1.2']]) {
    assert.throws(() => execFileSync(menu, ['--write-setting', key, value], { env, stdio: 'pipe' }));
  }
  assert.equal(S.get('inputMode', env), 'paste');
  assert.equal(S.get('inputSpeed', env), 1.5);
});

console.log(`gui input settings: ${checks} checks passed (native dry-run only)`);
