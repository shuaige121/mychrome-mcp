import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import * as S from '../src/settings.js';

// Compile actual settings/lock/token functions with Foundation only. Every path
// is a newly-created fixture; no native UI, helper input or real settings.
const source = readFileSync(new URL('../src/menubar.swift', import.meta.url), 'utf8');
function block(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, marker);
  let bodyStart = start;
  if (/^(?:func|function) /.test(marker)) {
    let parentheses = 0;
    for (let i = source.indexOf('(', start); i < source.length; i++) {
      if (source[i] === '(') parentheses++;
      if (source[i] === ')' && --parentheses === 0) { bodyStart = i; break; }
    }
  }
  const open = source.indexOf('{', bodyStart);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(`Unclosed ${marker}`);
}
const build = mkdtempSync(path.join(os.tmpdir(), 'mychrome-pause-swift-'));
const binary = path.join(build, 'probe');
after(() => rmSync(build, { recursive: true, force: true }));
const functions = ['readJSON', 'jsonBool', 'jsonNum', 'withSettingsWriteLock',
  'settingsPauseTokens', 'requestSettingsPause', 'clearSettingsPauseTokens', 'writeSettingsObject']
  .map(name => block(source, `func ${name}(`)).join('\n');
writeFileSync(path.join(build, 'probe.swift'), `import Foundation
import CoreFoundation
import Darwin
let SETTINGS_FILE = CommandLine.arguments[1]
${functions}
${block(source, 'struct Settings:')}
func report(_ value: [String: Any]) {
    print(String(decoding: try! JSONSerialization.data(withJSONObject: value), as: UTF8.self)); fflush(stdout)
}
let command = CommandLine.arguments[2]
if command == "read" { report(["paused": Settings.read().paused]); exit(0) }
if command == "resume-commit-barrier" {
    let observed = settingsPauseTokens(SETTINGS_FILE)
    let ok = writeSettingsObject(SETTINGS_FILE, ["paused": false], afterCommit: {
        report(["ready": true]); _ = readLine()
        return clearSettingsPauseTokens(SETTINGS_FILE, observed)
    })
    report(["ok": ok, "paused": Settings.read().paused]); exit(0)
}
let pause = command.hasSuffix("pause") && !command.hasSuffix("resume")
guard let save = Settings.prepareWrite("paused", pause) else { report(["ok": false]); exit(0) }
if command.hasPrefix("prepare-") { report(["ready": true]); _ = readLine() }
report(["ok": save(), "paused": Settings.read().paused])
`);
execFileSync('/usr/bin/swiftc', [path.join(build, 'probe.swift'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
const native = (file, command) => JSON.parse(execFileSync(binary, [file, command], { encoding: 'utf8', timeout: 5000 }));
const activeWrites = new Set();
async function prepared(file, command) {
  const child = spawn(binary, [file, command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', timer;
  child.stderr.on('data', bytes => { stderr += bytes; });
  const lines = readline.createInterface({ input: child.stdout }), values = [];
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Prepared write did not become ready')), 3000);
    lines.on('line', line => { const value = JSON.parse(line); values.push(value); if (value.ready) { clearTimeout(timer); resolve(); } });
    child.once('error', reject);
  });
  const exited = new Promise((resolve, reject) => child.once('exit', code => {
    clearTimeout(timer); lines.close();
    if (code === 0) resolve(values.at(-1)); else reject(Error(stderr || `Swift exited ${code}`));
  }));
  exited.catch(() => {});
  let released = false;
  const write = { pid: child.pid, release() {
    if (!released) { released = true; child.stdin.end('continue\n'); }
    return exited.finally(() => activeWrites.delete(write));
  } };
  activeWrites.add(write);
  await ready;
  return write;
}
async function fixture(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mychrome-pause-'));
  const file = path.join(dir, 'settings.json'), env = { CHROME_BRIDGE_SETTINGS: file };
  writeFileSync(file, '{"future":"preserved","paused":false}');
  try { await run({ dir, file, env }); }
  finally {
    await Promise.allSettled([...activeWrites].map(write => write.release()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('emergency pause remains effective with malformed JSON; failed resume preserves it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mychrome-pause-'));
  const file = path.join(dir, 'settings.json'), env = { CHROME_BRIDGE_SETTINGS: file };
  try {
    writeFileSync(file, '{ broken settings');
    assert.doesNotThrow(() => S.writeSettings({ paused: true }, env));
    assert.equal(S.get('paused', env), true);
    assert.equal(readFileSync(file, 'utf8'), '{ broken settings');
    assert.throws(() => S.writeSettings({ paused: false }, env), e => e.code === 'settings_invalid');
    assert.equal(S.get('paused', env), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a live settings lock cannot block Node pause or the native reader', () => fixture(async ({ file, env }) => {
  const original = readFileSync(file, 'utf8'), lock = file + '.write-lock';
  const owner = `${process.pid}:${randomUUID()}`;
  symlinkSync(owner, lock);
  try {
    assert.doesNotThrow(() => S.writeSettings({ paused: true }, env));
    assert.deepEqual(S.setting('paused', env), { value: true, source: 'emergency' });
    assert.equal(native(file, 'read').paused, true);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(readlinkSync(lock), owner);
    assert.throws(() => S.writeSettings({ notify: false }, env), e => e.code === 'settings_busy');
    assert.throws(() => S.writeSettings({ paused: false }, env), e => e.code === 'settings_busy');
    assert.equal(S.get('paused', env), true);
  } finally { unlinkSync(lock); }
}));

test('Swift prepare publishes pause before its blocked save and preserves broken JSON', () => fixture(async ({ file, env }) => {
  writeFileSync(file, '{ malformed');
  const lock = file + '.write-lock'; symlinkSync(`${process.pid}:${randomUUID()}`, lock);
  try {
    const write = await prepared(file, 'prepare-pause');
    assert.equal(S.get('paused', env), true, 'pause must be visible before running the save closure');
    assert.deepEqual(await write.release(), { ok: true, paused: true });
    assert.equal(readFileSync(file, 'utf8'), '{ malformed');
    assert.deepEqual(native(file, 'resume'), { ok: false, paused: true });
  } finally { unlinkSync(lock); }
  assert.deepEqual(native(file, 'resume'), { ok: false, paused: true });
  assert.equal(readFileSync(file, 'utf8'), '{ malformed');
}));

test('an older Swift resume cannot clear a newly-arrived Node pause', () => fixture(async ({ file, env }) => {
  S.writeSettings({ paused: true }, env);
  const resume = await prepared(file, 'prepare-resume');
  S.writeSettings({ paused: true }, env);
  assert.deepEqual(await resume.release(), { ok: true, paused: true });
  assert.equal(readdirSync(file + '.paused').length, 1);
  assert.equal(S.get('paused', env), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).paused, false);
  assert.deepEqual(native(file, 'resume'), { ok: true, paused: false });
  assert.equal(S.get('paused', env), false);
}));

test('resume holds the shared lock until token cleanup; a delayed older pause cannot resurrect', () => fixture(async ({ file, env }) => {
  const pause = await prepared(file, 'prepare-pause');
  const resume = await prepared(file, 'resume-commit-barrier');
  assert.ok(readlinkSync(file + '.write-lock').startsWith(resume.pid + ':'));
  const oldSave = pause.release();
  assert.deepEqual(await resume.release(), { ok: true, paused: false });
  assert.deepEqual(await oldSave, { ok: true, paused: false });
  assert.equal(S.get('paused', env), false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).paused, false);
}));

test('resume ignores unknown files, nonempty UUID files and symlinks', () => fixture(async ({ dir, file, env }) => {
  const tokens = file + '.paused'; mkdirSync(tokens);
  const names = ['notes.txt', randomUUID(), randomUUID()];
  writeFileSync(path.join(tokens, names[0]), '');
  writeFileSync(path.join(tokens, names[1]), 'not a pause token');
  const target = path.join(dir, 'untouched'); writeFileSync(target, '');
  symlinkSync(target, path.join(tokens, names[2]));
  assert.equal(S.get('paused', env), false); assert.equal(native(file, 'read').paused, false);
  S.writeSettings({ paused: true }, env);
  assert.deepEqual(native(file, 'resume'), { ok: true, paused: false });
  assert.deepEqual(readdirSync(tokens).sort(), names.sort());
  assert.equal(readFileSync(target, 'utf8'), '');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).future, 'preserved');
}));

test('emergency tokens enter the production input gate and release a between-actions hold', () => fixture(async ({ file, env }) => {
  writeFileSync(file, '{ broken'); S.writeSettings({ paused: true }, env);
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  let released = 0, cleaned = 0, poll;
  const requests = [], th = { task: 'Synthetic task', kept: { session: { request: async x => { requests.push(x.op); } } } };
  const context = vm.createContext({ S: { get: key => S.get(key, env) }, TASK_HOLD: th,
    PLAN: { task: th.task }, YIELDING: null,
    setInterval: fn => { poll = fn; return 1; },
    endTaskHold: async () => { released++; }, pauseCleanup: () => { cleaned++; },
    pausedError: () => Object.assign(new Error('Paused'), { code: 'paused_by_user' }),
  });
  vm.runInContext(block(index, 'function pausedCheck(') + '\n' + block(index, 'function startGap('), context);
  assert.throws(() => context.pausedCheck(), e => e.code === 'paused_by_user');
  context.startGap(th); await poll();
  assert.equal(released, 1); assert.equal(cleaned, 2);
  assert.deepEqual(requests, ['veil'], 'the paused hold must release before another native status/action');
}));
