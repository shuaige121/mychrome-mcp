#!/usr/bin/env node
/* Read-only pre-warm (`chromectl --warm-read`) and the bridge's warm pool. Nothing here reaches
 * Chrome, an Apple Event, Accessibility, the mouse or the keyboard:
 *  A. The production chromectl startup/dispatch source compiled with inert doubles for Chrome
 *     discovery, ScriptingBridge and the native probes; plus two reverted-source mutants.
 *  B. The production pool functions from src/bridge.js spawning an inert shell stand-in. */
import { spawn, execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

assert.equal(process.platform, 'darwin', 'This suite compiles a macOS Swift capsule.');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swift = fs.readFileSync(path.join(ROOT, 'src/chromectl.swift'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-warm-read-'));
const started = [];
let passed = 0;
const ok = name => { passed++; console.log(`  ok  ${name}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, ms, what) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) assert.fail(`timed out: ${what}`); await sleep(10); }
}
function unique(text, needle) {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, needle); assert.equal(text.indexOf(needle, at + needle.length), -1, needle);
  return at;
}

/* ------------------------------------------------ A. chromectl startup capsule */

const PROTECTED = [['open', 'https://example.invalid/'], ['newwindow', 'https://example.invalid/'], ['move', '1', '0,0,800,600'],
  ['close', '5'], ['select', '5'], ['activate', '--tab', '5'], ['restore', '9'], ['dialog', '--press', 'OK'], ['dialog', '--text', 'fixture']];
const NOT_DECLARED = [['dialog'], ['dialog', '--pid', '4242'], ['axinput', '4242', '--window', '5', '--focus'],
  ['axcontent', '4242', '--window', '5'], ['axmenustate'], ['pick'], ['axwindows', '1'], ['windowmatch'],
  ['eval', '/fixture.js', '--pid', '4242'], ['info', '--pid', '4242'], ['bogus']];

const fnSource = prefix => { const at = unique(swift, prefix); return swift.slice(at, swift.indexOf('\n}', at) + 2); };
const sliceStart = unique(swift, 'func preWarmReadOnly(');
const startup = swift.slice(swift.lastIndexOf('\n', swift.lastIndexOf('///', sliceStart)) + 1,
  unique(swift, '// Must stay before SBApplication initialization.'));
// The declared allowlist the bridge must mirror.
const swiftCommands = JSON.parse(startup.match(/let warmReadCommands: Set<String> = (\[[^\]]+\])/)[1]);

const doubles = String.raw`import Foundation
import CoreFoundation
import CoreGraphics // CGRect/CGPoint values only; the CG query below is an inert local double.
${fnSource('func emit(')}
${fnSource('func fail(')}
func qa(_ line: String) { FileHandle.standardError.write(Data((line + "\n").utf8)) }
func trace(_ what: String) { qa("trace:" + what) }
final class QACatcher { var last: String? }
let catcher = QACatcher()
// Google Chrome processes running when the command arrives: QA_RUNNING "pid[:headless|:unreadable],..." (default: QA_PID alone).
func qaRunning() -> [(pid: pid_t, kind: String)] {
    let env = ProcessInfo.processInfo.environment
    return (env["QA_RUNNING"] ?? env["QA_PID"] ?? "").split(separator: ",").compactMap { item in
        let parts = item.split(separator: ":", maxSplits: 1).map(String.init)
        guard let pid = pid_t(parts[0]) else { return nil }
        return (pid, parts.count > 1 ? parts[1] : "")
    }
}
final class NSRunningApplication {
    let processIdentifier: pid_t; var isTerminated = false
    init(_ pid: pid_t) { processIdentifier = pid }
    convenience init?(processIdentifier pid: pid_t) { guard qaRunning().contains(where: { $0.pid == pid }) else { return nil }; self.init(pid) }
    static func runningApplications(withBundleIdentifier id: String) -> [NSRunningApplication] {
        id == "com.google.Chrome" ? qaRunning().map { NSRunningApplication($0.pid) } : []
    }
}
func processArgsNow(_ pid: pid_t) -> String? {
    switch qaRunning().first(where: { $0.pid == pid })?.kind { case "headless": return "chrome --headless"; case "unreadable": return nil; default: return "chrome" }
}
func pickChrome() -> (NSRunningApplication?, [[String: Any]]) {
    qa("pick")
    guard let s = ProcessInfo.processInfo.environment["QA_PID"], let pid = pid_t(s) else { return (nil, []) }
    return (NSRunningApplication(pid), [["pid": Int(pid), "reason": "fixture"]])
}
final class SBElementArray {
    var count: Int {
        qa("apple_event:count")
        if ProcessInfo.processInfo.environment["QA_AE_FAIL"] == "1" { catcher.last = "fixture refusal" }
        return 2
    }
}
final class SBApplication {
    var delegate: QACatcher?
    init?(processIdentifier: pid_t) { qa("connect:\(processIdentifier)") }
    func value(forKey key: String) -> Any? { SBElementArray() }
}
func profilesReport() -> [String: Any] { ["ok": true, "qaProfiles": true] }
struct ChromeWin { let id: Int, rect: CGRect, minimized: Bool, index: Int? }
func matchWindows(_ cw: [ChromeWin], cg: [(num: Int, rect: CGRect, onScreen: Bool)],
                  onOrder: () -> [(num: Int, rect: CGRect)], ax: () -> [(num: Int, title: String, minimized: Bool, rect: CGRect?)],
                  title: (Int) -> String) -> [Int: Int] { [:] }
func CGWindowListCopyWindowInfo(_ options: CGWindowListOption, _ id: CGWindowID) -> CFArray? { qa("cg"); return nil }
func axWindowTable(pid: pid_t) -> [(num: Int, title: String, minimized: Bool, rect: CGRect?)] { qa("ax:\(pid)"); return [] }
func sameRect(_ a: CGRect, _ b: CGRect) -> Bool { false }
struct NativeInputProbeError: Error { let code: String; let message: String; var details: [String: Any] = [:] }
func nativePageContent(pid: pid_t, expectedWindow: Int) throws -> [String: Any] { qa("probe:content"); return ["ok": true, "qaContent": Int(pid)] }
func nativeInputProbe(pid: pid_t, expectedWindow: Int, point: CGPoint?) throws -> [String: Any] { qa("probe:input"); return ["ok": true, "qaInput": Int(pid)] }
func nativeDialogCommand(_ args: [String]) -> Never { qa("probe:dialog"); emit(["ok": true, "qaDialog": args.count]) }
`;
const tail = String.raw`
qa("command_phase")
emit(["ok": true, "qaCommand": cmd, "chromePid": chromeProc.map { Int($0.processIdentifier) } ?? -1,
      "preWarmedChrome": warmChrome != nil && warmChrome === preWarmed?.chrome])
`;
function compile(name, body) {
  const program = doubles + body + tail, file = path.join(tmp, name + '.swift'), binary = path.join(tmp, name);
  assert.doesNotMatch(program, /import (?:AppKit|ScriptingBridge|ApplicationServices)|NSWorkspace|Process\(|processArgs\(|AXUIElement/);
  fs.writeFileSync(file, program);
  execFileSync('/usr/bin/swiftc', [file, '-o', binary], { stdio: 'pipe', timeout: 120000 });
  return binary;
}
// Mutant 1 (the c31ca9b order for --warm-read): the command is read before the pre-warm.
const preWarmLine = 'let preWarmed = warmRead ? preWarmReadOnly() : nil\n', cmdLine = 'let cmd = cmdArgs.first ?? ""\n';
unique(startup, preWarmLine); unique(startup, cmdLine);
const commandFirst = startup.replace(preWarmLine, '').replace(cmdLine, cmdLine + preWarmLine);
// Mutant 2: no declared allowlist.
const refusalAt = unique(startup, 'if warmRead && (!warmReadCommands.contains(cmd)');
const refusal = startup.slice(refusalAt, startup.indexOf('\n}\n', refusalAt) + 3);
const undeclared = startup.replace(refusal, '');
// Mutant 3: no binding check when the command arrives.
const bindingAt = unique(startup, 'if warmRead, let bound = preWarmed?.pick.0 {');
const unchecked = startup.replace(startup.slice(bindingAt, startup.indexOf('\n}\n', bindingAt) + 3), '');

const current = compile('current', startup), mutantOrder = compile('command-first', commandFirst), mutantOpen = compile('no-allowlist', undeclared),
  mutantUnchecked = compile('no-binding-check', unchecked);

/** One run with fd 3 as the ready channel (or none). With waitReady, the command is sent only after ready. */
function runCapsule(binary, args, { env = {}, command = null, readyChannel = true, waitReady = true, readyMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: { ...process.env, CHROME_BRIDGE_PID: '', ...env }, stdio: ['pipe', 'pipe', 'pipe', ...(readyChannel ? ['pipe'] : [])] });
    const r = { out: '', err: '', ready: '', readyBeforeCommand: null, code: null, signal: null, errAtReady: null };
    child.stdout.on('data', d => { r.out += d; }); child.stderr.on('data', d => { r.err += d; });
    child.stdin.on('error', () => {});   // a child that already exited may not read its command
    const send = () => { if (command) child.stdin.end(JSON.stringify(command) + '\n'); else child.stdin.end(); };
    const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
    let timer = null;
    if (readyChannel) child.stdio[3].on('data', d => {
      r.ready += d;
      if (waitReady && r.readyBeforeCommand === null && r.ready.includes('\n')) {
        // stderr and fd 3 are separate pipes: let the earlier stderr lines land before the snapshot.
        r.readyBeforeCommand = true; clearTimeout(timer); setTimeout(() => { r.errAtReady = r.err; send(); }, 100);
      }
    });
    if (waitReady && readyChannel) timer = setTimeout(() => { r.readyBeforeCommand = false; send(); }, readyMs);
    else setTimeout(send, waitReady ? 0 : 300);
    child.on('error', reject);
    child.on('close', (code, signal) => { clearTimeout(kill); clearTimeout(timer); Object.assign(r, { code, signal }); resolve(r); });
  });
}
const qaLines = err => err.split('\n').filter(l => l && !l.startsWith('trace:'));
const count = (err, line) => qaLines(err).filter(l => l === line).length;

{
  // S1: ready on fd 3 before the command, after one discovery and one read-only Apple Event;
  // stdout carries only the command's reply; the command reuses that Chrome (no second pick or connection).
  const r = await runCapsule(current, ['--warm-read'], { env: { QA_PID: '4242' }, command: ['list', '--tab', '7'] });
  assert.equal(r.readyBeforeCommand, true, 'ready must arrive before any command is sent');
  assert.deepEqual(qaLines(r.errAtReady), ['pick', 'connect:4242', 'apple_event:count']);
  assert.deepEqual(JSON.parse(r.ready), { ready: true, protocol: 1, chromePid: 4242 });
  assert.equal(r.ready.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(r.out), { ok: true, qaCommand: 'list', chromePid: 4242, preWarmedChrome: true });
  assert.equal(r.out.trim().split('\n').length, 1); assert.doesNotMatch(r.out, /ready|protocol/);
  assert.deepEqual(qaLines(r.err), ['pick', 'connect:4242', 'apple_event:count', 'command_phase']);
  assert.equal(r.code, 0);
  // The same scenario fails when the command is read first (reverted source).
  const m = await runCapsule(mutantOrder, ['--warm-read'], { env: { QA_PID: '4242' }, command: ['list'], readyMs: 800 });
  assert.equal(m.readyBeforeCommand, false, 'command-first mutant must not be ready before its command');
  assert.throws(() => assert.equal(m.readyBeforeCommand, true), assert.AssertionError);
  ok('--warm-read: one pick + one read-only Apple Event, ready {protocol, chromePid} on fd 3 before the command; stdout = reply only');
}
for (const command of swiftCommands) {
  const r = await runCapsule(current, ['--warm-read'], { env: { QA_PID: '4242' }, command: [command, ...(command === 'eval' ? ['/fixture.js'] : [])] });
  assert.equal(r.readyBeforeCommand, true);
  assert.deepEqual(JSON.parse(r.out), command === 'profiles' ? { ok: true, qaProfiles: true }
    : { ok: true, qaCommand: command, chromePid: 4242, preWarmedChrome: true }, command);
  assert.equal(count(r.err, 'pick'), 1); assert.equal(count(r.err, 'apple_event:count'), 1);
}
ok(`--warm-read runs each declared command (${swiftCommands.join(', ')}) on the pre-warmed Chrome`);
{
  // S2: protected commands: refused, no further Apple Event, no command phase.
  for (const command of PROTECTED) {
    const r = await runCapsule(current, ['--warm-read'], { env: { QA_PID: '4242' }, command });
    assert.equal(r.readyBeforeCommand, true);
    const reply = JSON.parse(r.out);
    assert.deepEqual([reply.ok, reply.error, reply.inputDelivery], [false, 'native_session_required', 'not_sent'], command.join(' '));
    assert.deepEqual(qaLines(r.err), ['pick', 'connect:4242', 'apple_event:count'], command.join(' '));
  }
  ok('--warm-read: every protected command is refused (native_session_required, not_sent) with zero further effects');
}
{
  // S3: anything not declared at spawn (cold-only probes, pick, a --pid binding): refused before any effect.
  for (const command of NOT_DECLARED) {
    const r = await runCapsule(current, ['--warm-read'], { env: { QA_PID: '4242' }, command });
    const reply = JSON.parse(r.out);
    assert.deepEqual([reply.ok, reply.error, reply.inputDelivery], [false, 'warm_read_refused', 'not_sent'], command.join(' '));
    assert.deepEqual(qaLines(r.err), ['pick', 'connect:4242', 'apple_event:count'], command.join(' '));
  }
  // Without the declaration the same commands would run (reverted source).
  const open = await runCapsule(mutantOpen, ['--warm-read'], { env: { QA_PID: '4242' }, command: ['dialog'] });
  assert.equal(JSON.parse(open.out).qaDialog, 1);
  const pick = await runCapsule(mutantOpen, ['--warm-read'], { env: { QA_PID: '4242' }, command: ['eval', '/fixture.js', '--pid', '4242'] });
  assert.equal(JSON.parse(pick.out).qaCommand, 'eval');
  ok('--warm-read refuses undeclared and --pid-bound commands (warm_read_refused); the no-allowlist mutant runs them');
}
{
  // S4/S5: no ready line and no output when the read-only Apple Event fails or no Chrome is chosen.
  const failed = await runCapsule(current, ['--warm-read'], { env: { QA_PID: '4242', QA_AE_FAIL: '1' }, command: ['list'], readyMs: 800 });
  assert.deepEqual([failed.code, failed.ready, failed.out], [1, '', '']); assert.notEqual(failed.readyBeforeCommand, true);
  assert.deepEqual(qaLines(failed.err), ['pick', 'connect:4242', 'apple_event:count']);
  const none = await runCapsule(current, ['--warm-read'], { command: ['list'], readyMs: 800 });
  assert.deepEqual([none.code, none.ready, none.out], [1, '', '']);
  assert.deepEqual(qaLines(none.err), ['pick'], 'no Chrome chosen: no connection, no Apple Event');
  ok('--warm-read exits 1 with no ready line and no stdout when its Apple Event fails or no Chrome is chosen');
}
{
  // S6: --warm keeps the c31ca9b order: nothing before its command, then discovery like a cold run.
  const r = await runCapsule(current, ['--warm'], { env: { QA_PID: '4242' }, command: ['list'], waitReady: false });
  assert.equal(r.ready, '');
  assert.deepEqual(JSON.parse(r.out), { ok: true, qaCommand: 'list', chromePid: 4242, preWarmedChrome: false });
  assert.deepEqual(qaLines(r.err), ['pick', 'connect:4242', 'apple_event:count', 'command_phase']);
  const idle = spawn(current, ['--warm'], { env: { ...process.env, QA_PID: '4242' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let early = ''; idle.stderr.on('data', d => { early += d; });
  await sleep(400);
  assert.deepEqual(qaLines(early), [], '--warm must not choose Chrome before its command');
  idle.stdin.end(JSON.stringify(['close', '5']) + '\n');
  const out = await new Promise(r => { let o = ''; idle.stdout.on('data', d => { o += d; }); idle.on('close', () => r(o)); });
  assert.equal(JSON.parse(out).error, 'native_session_required'); assert.deepEqual(qaLines(early), []);
  // S7: a run without a ready channel (by hand, a timing script) still serves its command.
  const bare = await runCapsule(current, ['--warm-read'], { env: { QA_PID: '4242' }, command: ['scene'], readyChannel: false, waitReady: false });
  assert.deepEqual(JSON.parse(bare.out), { ok: true, qaCommand: 'scene', chromePid: 4242, preWarmedChrome: true });
  ok('--warm still reads its command before discovery; --warm-read without fd 3 still serves its command');
}
{
  // S8: the binding is checked when the command arrives, before anything runs (no pick, no Apple Event).
  const stale = { ok: false, error: 'warm_binding_stale', inputDelivery: 'not_sent', stage: 'warm_binding' };
  const cases = [
    ['4242,5151', null, false, 'two Chromes: several candidates'], ['5151', null, false, 'it quit, another started'],
    ['', null, false, 'none running'], ['4242,6161:unreadable', null, false, 'a candidate whose arguments cannot be read'],
    ['4242,5151:headless', null, true, 'the other one is headless'], ['4242,5151', '4242', true, 'CHROME_BRIDGE_PID names it'],
    ['4242,5151', '5151', false, 'CHROME_BRIDGE_PID names the other'], ['4242', null, true, 'still the only one'],
  ];
  for (const [running, override, valid, why] of cases) for (const command of [['list'], ['eval', '/fixture.js'], ['profiles']]) {
    const env = { QA_PID: '4242', QA_RUNNING: running, ...(override ? { CHROME_BRIDGE_PID: override } : {}) };
    const r = await runCapsule(current, ['--warm-read'], { env, command });
    assert.equal(r.readyBeforeCommand, true, why);
    const reply = JSON.parse(r.out);
    if (valid) assert.ok(reply.ok === true, `${why}: ${command[0]} must run`);
    else {
      assert.equal(r.out.trim().split('\n').length, 1);
      assert.equal(reply.ok, false); assert.equal(reply.error, stale.error, why);
      assert.deepEqual({ ok: reply.ok, error: reply.error, inputDelivery: reply.inputDelivery, stage: reply.stage }, stale);
      assert.deepEqual(qaLines(r.err), ['pick', 'connect:4242', 'apple_event:count'], `${why}: nothing ran (${command[0]})`);
    }
  }
  // The same stale cases run their command when the check is removed (reverted source).
  for (const running of ['4242,5151', '5151', '']) {
    const m = await runCapsule(mutantUnchecked, ['--warm-read'], { env: { QA_PID: '4242', QA_RUNNING: running }, command: ['list'] });
    assert.equal(JSON.parse(m.out).qaCommand, 'list', `unchecked mutant runs on a stale binding (${running || 'none'})`);
  }
  ok('--warm-read checks its Chrome binding when the command arrives: stale (several/other/none/unreadable) → warm_binding_stale, not_sent, nothing run');
}
{
  // The production in-process argument reader, on a process of this test (never Chrome): same text as `ps`.
  const at = unique(swift, 'func processArgsNow('), reader = swift.slice(at, swift.indexOf('\n}', at) + 2);
  const file = path.join(tmp, 'args.swift'), binary = path.join(tmp, 'args');
  fs.writeFileSync(file, `import Foundation\n${reader}\nprint(processArgsNow(pid_t(CommandLine.arguments[1])!) ?? "nil")\n`);
  execFileSync('/usr/bin/swiftc', [file, '-o', binary], { stdio: 'pipe', timeout: 120000 });
  const subject = spawn('/bin/sh', ['-c', 'sleep 5; :', 'qa-args-marker', '--headless'], { stdio: 'ignore' });
  started.push(subject);
  await sleep(100);
  const mine = execFileSync(binary, [String(subject.pid)], { encoding: 'utf8' }).trim();
  const ps = execFileSync('/bin/ps', ['-o', 'args=', '-p', String(subject.pid)], { encoding: 'utf8' }).trim();
  assert.equal(mine, ps); assert.ok(mine.includes('--headless'));
  assert.equal(execFileSync(binary, ['2147483646'], { encoding: 'utf8' }).trim(), 'nil', 'no such process: unreadable');
  subject.kill('SIGKILL');
  ok('processArgsNow (sysctl, no child process) reads the same argument text as ps; a missing process is unreadable');
}

/* ------------------------------------------------ B. bridge pool, inert stand-in */

const fnBridge = name => {
  const at = unique(bridge, `function ${name}(`), s = bridge.slice(at, bridge.indexOf('\n}', at) + 2);
  return bridge.slice(at - 6, at) === 'async ' ? `async ${s}` : s;
};
const constant = name => JSON.parse(JSON.stringify(vm.runInNewContext(bridge.match(new RegExp(`^const ${name} = (.+);$`, 'm'))[1])));
assert.deepEqual(constant('WARM_READ_COMMANDS'), swiftCommands, 'bridge allowlist must equal chromectl warmReadCommands');
assert.equal(constant('WARM_READ_PROTOCOL'), 1);
const READY_MS = constant('WARM_READY_MS'), RETRY_MS = constant('WARM_RETRY_MS');
assert.ok(READY_MS > 0 && READY_MS <= 10_000 && RETRY_MS >= READY_MS, 'bounded warm-up and a refill pause');
ok('bridge allowlist equals chromectl warmReadCommands; WARM_READY_MS bounded, WARM_RETRY_MS ≥ it');

const fake = path.join(tmp, 'chromectl');
const fakeScript = tag => `#!/bin/sh
# Inert stand-in for chromectl --warm-read (${tag}): no Chrome, no Apple Event, no input.
[ "$1" = "--warm-read" ] || { echo '{"ok":false,"error":"fake_wrong_mode"}'; exit 2; }
case "$FAKE_WARM_MODE" in
  hang) exec sleep 30 ;;
  exit) exit 1 ;;
  garbage) printf 'not json\\n' >&3; exec sleep 30 ;;
esac
printf '{"ready":true,"protocol":1,"chromePid":%s}\\n' "$FAKE_WARM_PID" >&3
exec 3>&-
IFS= read -r command || exit 0
[ "$FAKE_WARM_MODE" = stall ] && exec sleep 30
[ "$FAKE_WARM_MODE" = empty ] && exit 0
if [ "$FAKE_WARM_MODE" = partial ]; then printf '{"ok":true,"fake":"partial-success"}\\n'; exec sleep 30; fi
if [ -n "$FAKE_CHOICE_FILE" ] && [ "$(cat "$FAKE_CHOICE_FILE")" != "$FAKE_WARM_PID" ]; then
  echo '{"ok":false,"error":"warm_binding_stale","inputDelivery":"not_sent","stage":"warm_binding"}'; exit 0
fi
[ -n "$FAKE_EXEC_LOG" ] && echo "$FAKE_WARM_PID $command" >> "$FAKE_EXEC_LOG"
printf '{"ok":true,"chromePid":%s,"fake":"warm","command":%s}\\n' "$FAKE_WARM_PID" "$command"
`;
const installFake = tag => { const next = fake + '.next'; fs.writeFileSync(next, fakeScript(tag), { mode: 0o755 }); fs.renameSync(next, fake); };
installFake('v1');

const timers = [], cold = [];
let coldDelayMs = 0;
const ctx = vm.createContext({
  CHROMECTL: fake, WARM_ON: true, WARM_POOL: constant('WARM_POOL'), WARM_MAX_AGE_MS: constant('WARM_MAX_AGE_MS'),
  WARM_IDLE_MS: constant('WARM_IDLE_MS'), WARM_READY_MS: 400, WARM_CALL_MS: constant('WARM_CALL_MS'), WARM_RETRY_MS: RETRY_MS, WARM_READ_PROTOCOL: 1,
  WARM_READ_COMMANDS: constant('WARM_READ_COMMANDS'), warmPool: [], warmIdle: { lastUse: 0, busy: 0, timer: null }, warmRetryAt: 0,
  spawn: (...a) => { const c = spawn(...a); started.push(c); return c; }, statSync, Date, performance, process,
  // The command timer keeps its production 25000 ms request; only its real delay is shortened here.
  setTimeout: (f, ms) => { timers.push(ms); return setTimeout(f, ms === 25000 ? 300 : ms); }, clearTimeout,
  execFileP: async (_file, argv) => { cold.push(Array.from(argv)); if (coldDelayMs) await sleep(coldDelayMs); return { stdout: JSON.stringify({ ok: true, fake: 'cold', chromePid: process.pid }) + '\n', stderr: '' }; },
  BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
  humanMessage: (code, message) => message || code,
  readRetryGate: null,   // HI2: the production read-retry gate, none registered
});
vm.runInContext(['beforeReadRetry', 'helperIdentity', 'spawnWarm', 'takeWarm', 'noteWarmUse', 'armWarmReaper', 'reapIdleWarm', 'runWarm',
  'driverFailureFacts', 'runDriver'].map(fnBridge).join('\n'), ctx);
const plain = v => JSON.parse(JSON.stringify(v));
const reset = (mode, pid = process.pid) => {
  for (const w of ctx.warmPool.splice(0)) if (!w.dead) w.child.kill('SIGKILL');
  ctx.warmRetryAt = 0; process.env.FAKE_WARM_MODE = mode; process.env.FAKE_WARM_PID = String(pid);
};
const exited = w => w.child.exitCode !== null || w.child.signalCode !== null;

// Pool children are unref'd (production); this test keeps its own loop alive while it awaits them.
const keepAlive = setInterval(() => {}, 1000);
try {
  {
    // Never ready: not handed out or waited for (the command runs cold); killed at its own deadline; no refill loop.
    reset('hang');
    assert.equal(ctx.takeWarm(['list']), null);
    const pool = [...ctx.warmPool]; assert.equal(pool.length, 3);
    const before = cold.length, t0 = Date.now();
    assert.equal(plain(await ctx.runDriver(['list'])).fake, 'cold');
    assert.ok(Date.now() - t0 < 300 && cold.length === before + 1, 'a warming child is not waited for');
    await until(() => pool.every(exited), 3000, 'deadline kill');
    assert.ok(pool.every(w => w.child.signalCode === 'SIGKILL' && !w.ready));
    assert.equal(ctx.warmPool.length, 0); assert.ok(ctx.warmRetryAt > Date.now());
    const spawned = started.length;
    assert.equal(ctx.takeWarm(['list']), null);
    assert.equal(started.length, spawned, 'no refill during WARM_RETRY_MS');
    ok('Apple Event never returns: child never handed out, killed at WARM_READY_MS, refills paused');
  }
  {
    // Exits before ready (no Chrome, no permission): dropped, never handed out, refills paused.
    reset('exit');
    assert.equal(ctx.takeWarm(['list']), null);
    const pool = [...ctx.warmPool];
    await until(() => pool.every(w => w.dead), 3000, 'early exit');
    assert.ok(pool.every(w => !w.ready && w.child.exitCode === 1));
    assert.equal(ctx.warmPool.length, 0); assert.ok(ctx.warmRetryAt > Date.now());
    const spawned = started.length;
    assert.equal(ctx.takeWarm(['list']), null); assert.equal(started.length, spawned);
    // A malformed ready line is a failure too.
    reset('garbage');
    ctx.takeWarm(['list']);
    const bad = [...ctx.warmPool];
    await until(() => bad.every(exited), 3000, 'bad ready line');
    assert.ok(bad.every(w => !w.ready && w.child.signalCode === 'SIGKILL'));
    ok('child exits before ready, or reports a malformed ready line: dropped, never handed out, refills paused');
  }
  {
    // Ready: survives past its deadline, handed out; the handshake never reaches the reply.
    reset('normal');
    assert.equal(ctx.takeWarm(['list']), null);
    const pool = [...ctx.warmPool];
    await until(() => pool.every(w => w.ready), 3000, 'ready');
    await sleep(600);
    assert.ok(pool.every(w => !w.dead && w.chromePid === process.pid), 'a ready child outlives WARM_READY_MS');
    const before = cold.length;
    const reply = plain(await ctx.runDriver(['list'], 7));
    assert.deepEqual(reply, { ok: true, chromePid: process.pid, fake: 'warm', command: ['list', '--tab', '7'] });
    assert.equal(cold.length, before);
    assert.equal(pool[0].out, JSON.stringify(reply) + '\n', 'stdout holds only the reply');
    assert.equal(pool[0].err, '');
    ok('ready child: kept past the deadline, handed out; ready handshake stays off stdout (reply parses alone)');
  }
  {
    // Ready, then stuck on its command: the parent's own 25 s timer SIGKILLs it and the call fails
    // as chromectl_failed; it does not wait a second interval by retrying cold. (A cold run that
    // would hang for another full interval is modelled by coldDelayMs = one mocked timer.)
    assert.equal(constant('WARM_CALL_MS'), 25000, 'production command timer is 25 s');
    reset('stall');
    ctx.takeWarm(['list']);
    await until(() => ctx.warmPool.every(w => w.ready), 3000, 'ready');
    const target = ctx.warmPool[0], before = cold.length, marks = timers.length;
    coldDelayMs = 300;
    const t0 = Date.now();
    let err = null;
    try { await ctx.runDriver(['list']); } catch (e) { err = e; } finally { coldDelayMs = 0; }
    const waited = Date.now() - t0;
    assert.ok(timers.slice(marks).includes(25000), 'the command used the 25000 ms timer');
    assert.equal(target.child.signalCode, 'SIGKILL');
    assert.equal(err?.code, 'chromectl_failed');
    assert.equal(cold.length, before, 'no cold retry after the parent timer fired');
    assert.ok(waited < 550, `one timer interval, not two (${waited} ms)`);
    ok('ready then stuck: the parent 25 s timer SIGKILLs it; chromectl_failed, no second cold wait');
  }
  {
    // Same for eval (retryEmptyOutput:false): the error, not a replay.
    reset('stall');
    ctx.takeWarm(['eval']);
    await until(() => ctx.warmPool.every(w => w.ready), 3000, 'ready');
    const before = cold.length;
    await assert.rejects(ctx.runDriver(['eval', '/x.js'], 3, { retryEmptyOutput: false }), e => e.code === 'chromectl_failed');
    assert.equal(cold.length, before);
    ok('eval stuck: chromectl_failed, no cold run');
  }
  {
    // A complete success-looking line on stdout from a child the timer had to kill is not a success.
    reset('partial');
    ctx.takeWarm(['list']);
    await until(() => ctx.warmPool.every(w => w.ready), 3000, 'ready');
    const before = cold.length;
    await assert.rejects(ctx.runDriver(['list']), e => e.code === 'chromectl_failed');
    assert.equal(cold.length, before);
    ok('stdout left by a child killed by the timer is never parsed as success');
  }
  {
    // The child exits by itself with no output: the one cold retry stays (timerFired is false).
    reset('empty');
    ctx.takeWarm(['list']);
    await until(() => ctx.warmPool.every(w => w.ready), 3000, 'ready');
    const target = ctx.warmPool[0], before = cold.length, marks = timers.length;
    const reply = plain(await ctx.runDriver(['list']));
    assert.notEqual(target.child.signalCode, 'SIGKILL', 'killed by nobody: it exited on its own');
    assert.equal(reply.fake, 'cold'); assert.equal(cold.length, before + 1);
    assert.ok(timers.slice(marks).includes(25000));
    ok('child exits by itself with no output: still one cold retry');
  }
  {
    // Helper replaced: ready children of the old binary are retired, never handed out.
    reset('normal');
    ctx.takeWarm(['list']);
    const old = [...ctx.warmPool];
    await until(() => old.every(w => w.ready), 3000, 'ready');
    installFake('v2');
    assert.equal(ctx.takeWarm(['list']), null, 'old helper must not be handed out');
    await until(() => old.every(exited), 3000, 'old retired');
    assert.ok(ctx.warmPool.length === 3 && ctx.warmPool.every(w => !old.includes(w)));
    assert.equal(ctx.warmRetryAt, 0, 'retiring is not a warm-up failure');
    await until(() => ctx.warmPool.every(w => w.ready), 3000, 'new ready');
    assert.ok(!old.includes(ctx.takeWarm(['list'])));
    ok('helper replaced: old ready children retired, not handed out; new children serve');
  }
  {
    // Bound to a Chrome that is gone: not handed out.
    reset('normal', 2147483646);
    ctx.takeWarm(['list']);
    const gone = [...ctx.warmPool];
    await until(() => gone.every(w => w.ready), 3000, 'ready');
    process.env.FAKE_WARM_PID = String(process.pid);
    assert.equal(ctx.takeWarm(['list']), null, 'Chrome pid no longer running');
    await until(() => gone.every(exited), 3000, 'retired');
    ok('ready child bound to a Chrome that is no longer running: never handed out');
  }
  const A = process.pid, B = process.ppid;   // two running processes stand in for two running Chromes
  const choice = path.join(tmp, 'choice'), execLog = path.join(tmp, 'executed');
  const executed = () => fs.readFileSync(execLog, 'utf8');
  process.env.FAKE_CHOICE_FILE = choice; process.env.FAKE_EXEC_LOG = execLog;
  {
    // Both alive; the choice moves from A to B while B's child is not ready yet. A's child checks its
    // binding before running anything: no command runs on A, this call runs cold once, every pooled
    // child bound to A is retired, and the stale binding does not refill the pool.
    fs.writeFileSync(choice, String(A)); fs.writeFileSync(execLog, '');
    reset('normal', A);
    ctx.takeWarm(['list']);
    const bound = [...ctx.warmPool];
    await until(() => bound.every(w => w.ready), 3000, 'ready on A');
    fs.writeFileSync(choice, String(B));
    process.env.FAKE_WARM_MODE = 'hang'; process.env.FAKE_WARM_PID = String(B);
    const before = cold.length;
    const reply = plain(await ctx.runDriver(['list']));
    assert.equal(reply.fake, 'cold');
    assert.deepEqual(cold.slice(before), [['list']], 'this same call ran cold, once');
    assert.equal(executed(), '', 'no command ran on the stale binding');
    await until(() => bound.every(exited), 3000, 'every child bound to A retired');
    assert.ok(ctx.warmPool.length === 1 && !ctx.warmPool[0].ready && ctx.warmPool[0].chromePid === null, 'only the warming B child stays');
    assert.ok(ctx.warmRetryAt > Date.now(), 'the stale binding pauses refills');
    const spawned = started.length, next = cold.length;
    assert.equal(plain(await ctx.runDriver(['list'])).fake, 'cold', 'a child still warming is not handed out');
    assert.deepEqual([cold.length - next, started.length - spawned, executed()], [1, 0, '']);
    ok('two Chromes, choice moves while the new child warms: the old binding runs no command; cold once; A children retired; no refill');
  }
  {
    // Eval (retryEmptyOutput:false) on a stale binding also runs cold, once: the refusal ran nothing.
    // Once B's child is ready, it serves the next call warm.
    fs.writeFileSync(choice, String(A)); fs.writeFileSync(execLog, '');
    reset('normal', A);
    ctx.takeWarm(['list']);
    const bound = [...ctx.warmPool];
    await until(() => bound.every(w => w.ready), 3000, 'ready on A');
    fs.writeFileSync(choice, String(B)); process.env.FAKE_WARM_PID = String(B);
    const before = cold.length;
    assert.equal(plain(await ctx.runDriver(['eval', '/x.js'], 3, { retryEmptyOutput: false })).fake, 'cold');
    assert.deepEqual(cold.slice(before).map(a => a[0]), ['eval']); assert.equal(executed(), '');
    const fresh = ctx.warmPool.filter(w => !bound.includes(w));
    await until(() => fresh.length === 1 && fresh[0].ready, 3000, 'B ready');
    const served = plain(await ctx.runDriver(['list']));
    assert.deepEqual([served.fake, served.chromePid], ['warm', B]);
    assert.equal(executed().trim().split(' ')[0], String(B));
    ok('eval on a stale binding runs cold once; the ready child bound to the new choice then serves warm');
  }
  delete process.env.FAKE_CHOICE_FILE; delete process.env.FAKE_EXEC_LOG;
  {
    // Cold-only, protected and --pid-bound commands neither take nor refill the pool.
    reset('normal');
    const spawned = started.length;
    for (const argv of [['dialog'], ['dialog', '--pid', '1'], ['axinput', '1', '--window', '2', '--focus'], ['axcontent', '1', '--window', '2'],
      ['axmenustate'], ['pick'], ['eval', '/x.js', '--pid', '5'], ['close', '5'], ['activate'], ['open', 'https://example.invalid/']]) {
      assert.equal(ctx.takeWarm(argv), null, argv.join(' '));
    }
    await ctx.runDriver(['dialog'], null, { cold: true });
    await ctx.runDriver(['eval', '/x.js', '--pid', '5'], 3);
    await ctx.runDriver(['list'], null, { cold: true });
    assert.equal(started.length, spawned); assert.equal(ctx.warmPool.length, 0);
    assert.deepEqual(cold.slice(-3).map(a => a[0]), ['dialog', 'eval', 'list']);
    ok('cold-only, protected and --pid-bound commands neither take nor refill the warm pool');
  }
} finally {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await until(() => started.every(c => c.exitCode !== null || c.signalCode !== null), 5000, 'cleanup');
  delete process.env.FAKE_WARM_MODE; delete process.env.FAKE_WARM_PID; delete process.env.FAKE_CHOICE_FILE; delete process.env.FAKE_EXEC_LOG;
  fs.rmSync(tmp, { recursive: true, force: true });
  clearInterval(keepAlive);
}
console.log(`\nwarm-read checks passed (${passed}); children started ${started.length}, all ended.`);
