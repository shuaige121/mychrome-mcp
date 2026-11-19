// Actual clearActivity Swift/state with an in-memory clock, queue and filesystem.
// Only a Foundation-only capsule is compiled/executed. No GUI, product helper,
// activity records or real lock/deletion operations are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sourcePath = new URL('../src/menubar.swift', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const directory = await mkdtemp(path.join(os.tmpdir(), 'mychrome-clear-confirmation-'));
await chmod(directory, 0o700);
const hash = value => createHash('sha256').update(value).digest('hex');
const receipt = { schema: 1, sourceSha256: hash(source), testSha256: hash(await readFile(new URL(import.meta.url))),
  directory, scope: 'inert Swift timing only; no product/native GUI or activity files', variants: [] };
const save = (name, value) => writeFile(path.join(directory, name), value, { flag: 'wx', mode: 0o600 });

function between(text, start, end) {
  assert.equal(text.split(start).length, 2, `unique start: ${start}`);
  const offset = text.indexOf(start);
  const finish = text.indexOf(end, offset);
  assert.ok(finish > offset, `end after start: ${end}`);
  return text.slice(offset, finish);
}
const state = between(source, '    @Published var confirmClear = false', '    /// A rebuilt binary');
const method = between(source, '    func clearActivity() {', '    /// bin/cbmenu was rebuilt');
assert.doesNotMatch(state + method, /\b(?:Foundation|Darwin)\.|\b(?:Process|NSWorkspace|URLSession)\b/);
receipt.stateSha256 = hash(state);
receipt.methodSha256 = hash(method);

const prelude = `import Foundation
func L(_ zh: String, _ en: String) -> String { zh }   // I18N1: the production two-language pair (src/onboarding-ui.swift), Chinese here

var clock = 0.0
struct Date {
    let value: Double
    init() { value = clock }
    init(_ value: Double) { self.value = value }
    func timeIntervalSince(_ earlier: Date) -> Double { value - earlier.value }
}
struct Deadline {
    let value: Double
    static func now() -> Deadline { Deadline(value: clock) }
    static func + (left: Deadline, right: Double) -> Deadline { Deadline(value: left.value + right) }
}
final class DispatchQueue {
    static let main = DispatchQueue()
    struct Scheduled { let at: Double, ordinal: Int; let body: () -> Void }
    var pending: [Scheduled] = []
    var ordinal = 0
    func asyncAfter(deadline: Deadline, execute: @escaping () -> Void) {
        ordinal += 1
        pending.append(Scheduled(at: deadline.value, ordinal: ordinal, body: execute))
    }
    func advance(to time: Double) {
        precondition(time >= clock)
        while let next = pending.filter({ $0.at <= time }).min(by: {
            $0.at == $1.at ? $0.ordinal < $1.ordinal : $0.at < $1.at
        }) {
            pending.removeAll { $0.ordinal == next.ordinal }
            clock = next.at
            next.body()
        }
        clock = time
    }
    func reset() { pending = []; ordinal = 0; clock = 0 }
}
@propertyWrapper struct Published<Value> {
    var wrappedValue: Value
    init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
}
enum AttributeKey { case modificationDate }
enum FakeIO {
    static var canLock = false
    static var outcomes: [Bool] = []
    static var modifiedAt: Double? = nil
    static var events: [String] = []
    static func reset() { canLock = false; outcomes = []; modifiedAt = nil; events = [] }
}
final class FileManager {
    static let \`default\` = FileManager()
    func attributesOfItem(atPath: String) throws -> [AttributeKey: Any] {
        precondition(atPath == ACTIVITY_FILE + ".lock")
        FakeIO.events.append("attributes:" + atPath)
        return FakeIO.modifiedAt.map { [.modificationDate: Date($0)] } ?? [:]
    }
    func removeItem(atPath: String) throws {
        precondition([ACTIVITY_FILE, ACTIVITY_OLD, ACTIVITY_FILE + ".lock"].contains(atPath))
        FakeIO.events.append("remove:" + atPath)
    }
}
func mkdir(_ name: String, _ mode: Int) -> Int32 {
    precondition(name == ACTIVITY_FILE + ".lock" && mode == 0o755)
    FakeIO.events.append("mkdir:" + name)
    let success = FakeIO.outcomes.isEmpty ? FakeIO.canLock : FakeIO.outcomes.removeFirst()
    return success ? 0 : -1
}
func usleep(_ amount: Int) {
    precondition(amount == 25_000)
    FakeIO.events.append("usleep:25000")
}
@discardableResult func rmdir(_ name: String) -> Int32 {
    precondition(name == ACTIVITY_FILE + ".lock")
    FakeIO.events.append("rmdir:" + name)
    return 0
}
let ACTIVITY_FILE = "synthetic-current", ACTIVITY_OLD = "synthetic-old"
final class Model {
    var live = true
    var activity = ["synthetic item"]
    var activityStamp: (Double, Int) = (123, 2)
`;
const scenarios = `
}
final class WeakModel {
    weak var value: Model?
    init(_ value: Model?) { self.value = value }
}
var checks = 0
var failures: [String] = []
var completed: [String] = []
func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
    checks += 1
    if !condition() { failures.append(name) }
}
func scenario(_ name: String, _ body: () -> Void) {
    DispatchQueue.main.reset(); FakeIO.reset(); body(); completed.append(name)
}
func go(_ at: Double) { DispatchQueue.main.advance(to: at) }
func removed() -> [String] { FakeIO.events.filter { $0.hasPrefix("remove:") } }
let note = "记录正在整理，过几秒再点一次「再点一次，确认清空」。"

scenario("non-live") {
    let m = Model(); m.live = false; m.clearActivity()
    expect(!m.confirmClear && m.clearNote == nil, "non-live state unchanged")
    expect(DispatchQueue.main.pending.isEmpty && FakeIO.events.isEmpty, "non-live has no effects")
}
scenario("initial-expiry") {
    let m = Model(); m.clearActivity()
    expect(m.confirmClear && m.clearNote == nil, "first click asks for confirmation")
    expect(FakeIO.events.isEmpty, "first click does not try to clear")
    go(3.999); expect(m.confirmClear, "initial confirmation remains before four seconds")
    go(4); expect(!m.confirmClear, "initial confirmation expires at four seconds")
    go(5); m.clearActivity(); go(8.999)
    expect(m.confirmClear, "new confirmation has its own deadline")
    go(9); expect(!m.confirmClear && removed().isEmpty, "new confirmation expires without deleting")
}
scenario("busy-initial-callback-and-retry") {
    let m = Model(); m.clearActivity(); go(1); m.clearActivity()
    expect(m.confirmClear && m.clearNote == note, "lock busy retains confirmation and exact retry note")
    expect(FakeIO.events.filter { $0.hasPrefix("mkdir:") }.count == 12, "lock retry count unchanged")
    expect(FakeIO.events.filter { $0 == "usleep:25000" }.count == 12, "lock wait count unchanged")
    expect(removed().isEmpty, "busy lock deletes nothing")
    go(4)
    expect(m.confirmClear, "busy confirmation survives initial four-second callback")
    go(5); FakeIO.canLock = true; m.clearActivity()
    expect(removed() == ["remove:synthetic-old", "remove:synthetic-current"], "one retry click clears both synthetic records exactly once")
    expect(!m.confirmClear && m.clearNote == nil && m.activity.isEmpty, "successful retry clears confirmation note and items")
    expect(m.activityStamp.0 == -1 && m.activityStamp.1 == -1, "successful retry invalidates stamp")
    expect(FakeIO.events.last == "rmdir:synthetic-current.lock", "successful retry releases synthetic lock")
    go(7); expect(!m.confirmClear && m.clearNote == nil, "old busy callback leaves successful state alone")
}
scenario("busy-expiry") {
    let m = Model(); m.clearActivity(); go(1); m.clearActivity()
    go(6.999); expect(m.confirmClear && m.clearNote == note, "busy confirmation lasts full six seconds")
    go(7); expect(!m.confirmClear && m.clearNote == nil, "busy confirmation and note expire together")
    expect(removed().isEmpty, "busy expiry never deletes")
}
scenario("repeated-busy") {
    let m = Model(); m.clearActivity(); go(1); m.clearActivity()
    go(5); m.clearActivity(); go(7)
    expect(m.confirmClear && m.clearNote == note, "older busy callback cannot expire renewed retry")
    expect(FakeIO.events.filter { $0.hasPrefix("mkdir:") }.count == 24, "repeat click makes one bounded lock attempt")
    go(10.999); expect(m.confirmClear && m.clearNote == note, "renewed retry receives its full deadline")
    go(11); expect(!m.confirmClear && m.clearNote == nil, "renewed retry expires at its own deadline")
    expect(removed().isEmpty, "repeated contention never deletes")
}
scenario("success-then-new-cycle-initial-callback") {
    let m = Model(); m.clearActivity(); go(1); FakeIO.canLock = true; m.clearActivity()
    go(2); m.clearActivity(); go(4)
    expect(m.confirmClear, "old initial callback cannot expire a new confirmation")
    go(6); expect(!m.confirmClear, "new cycle expires on its own deadline")
    expect(removed().count == 2, "starting new cycle does not clear without confirmation")
}
scenario("success-then-new-cycle-busy-callback") {
    let m = Model(); m.clearActivity(); go(1); m.clearActivity()
    go(3); FakeIO.canLock = true; m.clearActivity()
    expect(!m.confirmClear && m.clearNote == nil, "success immediately clears retry state")
    go(6); m.clearActivity(); go(7)
    expect(m.confirmClear && m.clearNote == nil, "old busy callback cannot expire new confirmation")
    go(10); expect(!m.confirmClear && m.clearNote == nil, "new cycle after busy expires normally")
    expect(removed().count == 2, "busy old callback cannot repeat deletion")
}
scenario("stale-lock-control") {
    let m = Model(); m.clearActivity(); go(1)
    FakeIO.outcomes = [false, true]; FakeIO.modifiedAt = -10; m.clearActivity()
    expect(FakeIO.events == ["mkdir:synthetic-current.lock", "attributes:synthetic-current.lock",
        "remove:synthetic-current.lock", "mkdir:synthetic-current.lock", "remove:synthetic-old",
        "remove:synthetic-current", "rmdir:synthetic-current.lock"], "existing stale-lock and deletion order unchanged")
    expect(!m.confirmClear && m.clearNote == nil && m.activity.isEmpty, "stale-lock success resets state")
}
scenario("weak-owner") {
    var m: Model? = Model(); let weakModel = WeakModel(m)
    m!.clearActivity(); m = nil
    expect(weakModel.value == nil, "confirmation timer does not retain owner")
    go(4); expect(FakeIO.events.isEmpty, "expired deallocated owner has no effects")
}
let output: [String: Any] = ["schema": 1, "cases": completed, "checks": checks, "failures": failures]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
exit(failures.isEmpty ? 0 : 86)
`;

async function child(label, argv, timeoutMs) {
  const stdoutPath = path.join(directory, `${label}.stdout.txt`);
  const stderrPath = path.join(directory, `${label}.stderr.txt`);
  const stdout = await open(stdoutPath, 'wx', 0o600);
  const stderr = await open(stderrPath, 'wx', 0o600);
  const started = Date.now();
  let pid = null, timedOut = false, termAttempted = false, termAccepted = null;
  let command, deadline, grace;
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TMPDIR: directory,
    CLANG_MODULE_CACHE_PATH: path.join(directory, 'module-cache'), SWIFT_MODULECACHE_PATH: path.join(directory, 'module-cache') };
  const result = await new Promise(resolve => {
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(deadline); clearTimeout(grace); resolve(result);
    };
    try {
      command = spawn(argv[0], argv.slice(1), { cwd: directory, env, stdio: ['ignore', stdout.fd, stderr.fd] });
      pid = command.pid ?? null;
      command.once('error', error => finish({ status: 'spawn_error', errorCode: error.code ?? null, exitCode: null, signal: null }));
      command.once('close', (exitCode, signal) => finish({ status: 'closed', exitCode, signal }));
      deadline = setTimeout(() => {
        timedOut = true; termAttempted = true;
        try { termAccepted = command.kill('SIGTERM'); } catch { termAccepted = false; }
        grace = setTimeout(() => {
          command.unref();
          finish({ status: 'containment_unconfirmed', exitCode: null, signal: null });
        }, 2000);
      }, timeoutMs);
    } catch (error) {
      finish({ status: 'spawn_error', errorCode: error.code ?? null, exitCode: null, signal: null });
    }
  });
  await stdout.close(); await stderr.close();
  const streams = {};
  for (const [name, file] of [['stdout', stdoutPath], ['stderr', stderrPath]]) {
    const size = (await stat(file)).size;
    assert.ok(size < 8 * 1024 * 1024, `${label} ${name} exceeds bounded test output`);
    const bytes = await readFile(file);
    streams[name] = { path: file, bytes: bytes.length, sha256: hash(bytes) };
  }
  const record = { argv, pid, ...result, timeoutMs, timedOut, termAttempted, termAccepted,
    elapsedMs: Date.now() - started, streams, descendants: 'unobserved' };
  await save(`${label}.json`, JSON.stringify(record, null, 2) + '\n');
  assert.equal(result.status, 'closed', `${label}: process did not close normally`);
  assert.equal(timedOut, false, `${label}: process timed out`);
  assert.equal(result.signal, null, `${label}: process exited by signal`);
  return record;
}

async function variant(name, body) {
  const text = prelude + state + body + scenarios;
  const swift = path.join(directory, `${name}.swift`), binary = path.join(directory, name);
  await save(`${name}.swift`, text);
  const record = { name, swiftSha256: hash(text), methodSha256: hash(body), compile: null, run: null };
  receipt.variants.push(record);
  record.compile = await child(`${name}-compile`, ['swiftc', '-module-cache-path', path.join(directory, 'module-cache'), swift, '-o', binary], 60_000);
  assert.equal(record.compile.exitCode, 0, `${name}: compile failure is not a behavioral test result`);
  record.binarySha256 = hash(await readFile(binary));
  record.run = await child(`${name}-run`, [binary], 5000);
  record.result = JSON.parse(await readFile(record.run.streams.stdout.path, 'utf8'));
  assert.equal(record.result.schema, 1);
  assert.equal(record.result.cases.length, 9);
  assert.equal(record.result.checks, 37);
  assert.ok(Array.isArray(record.result.failures));
  return record;
}

try {
  const original = await variant('original', method);
  assert.equal(original.run.exitCode, 0, `production timing assertions failed: ${original.result.failures.join('; ')}`);
  assert.deepEqual(original.result.failures, []);

  const guard = '                guard let self, self.clearConfirmationGeneration == generation else { return }\n';
  assert.equal(method.split(guard).length, 3, 'both production timers have generation guards');
  const mutants = [
    ['unguarded-initial-timer', method.replace(guard, '                guard let self else { return }\n'),
      'busy confirmation survives initial four-second callback'],
    ['unguarded-busy-timer', method.slice(0, method.lastIndexOf(guard)) +
      method.slice(method.lastIndexOf(guard)).replace(guard, '                guard let self else { return }\n'),
      'old busy callback cannot expire new confirmation'],
    ['unchanged-generation', method.replace('        clearConfirmationGeneration &+= 1\n', ''),
      'old initial callback cannot expire a new confirmation'],
  ];
  for (const [name, mutated, expected] of mutants) {
    assert.notEqual(mutated, method, `${name} changes an actual production statement`);
    const result = await variant(name, mutated);
    assert.equal(result.run.exitCode, 86, `${name}: only a behavioral failure kills this mutant`);
    assert.ok(result.result.failures.includes(expected), `${name}: expected timing oracle was not triggered`);
    result.killedBy = expected;
  }
  assert.equal(hash(await readFile(sourcePath)), receipt.sourceSha256, 'production source stays unchanged throughout test');
  receipt.status = 'passed';
  console.log(`clear-confirmation: 9 scenarios, 37 assertions, 3 valid mutants; evidence ${directory}`);
} catch (error) {
  receipt.status = 'failed';
  receipt.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  await save('receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  if (receipt.status !== 'passed') console.error(`clear-confirmation evidence: ${directory}`);
}
