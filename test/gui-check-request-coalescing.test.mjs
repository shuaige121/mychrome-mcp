// Actual requestChecks/state/grouping and contiguous pending+automatic Swift statements.
// Foundation-only synthetic snapshots; the sole String.write is replaced by a memory sink.
// No AppKit, full refresh/tick, product import, records, host, browser or input actions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sourcePath = new URL('../src/menubar.swift', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const directory = await mkdtemp(path.join(os.tmpdir(), 'mychrome-check-coalescing-'));
await chmod(directory, 0o700);
const hash = value => createHash('sha256').update(value).digest('hex');
const receipt = { schema: 1, sourceSha256: hash(source), testSha256: hash(await readFile(new URL(import.meta.url))),
  directory, scope: 'inert actual Swift request logic only; no real request files or product/native effects', variants: [] };
const save = (name, value) => writeFile(path.join(directory, name), value, { flag: 'wx', mode: 0o600 });

function between(text, start, end) {
  assert.equal(text.split(start).length, 2, `unique start: ${start}`);
  const offset = text.indexOf(start), finish = text.indexOf(end, offset);
  assert.ok(finish > offset, `end after start: ${end}`);
  return text.slice(offset, finish);
}
function line(text, exact) {
  assert.equal(text.split(exact).length, 2, `unique line: ${exact}`);
  return exact;
}
const pieces = {
  now: line(source, '    @Published var now = nowMs()\n'),
  settings: line(source, '    @Published var settings = Settings()\n'),
  servers: line(source, '    @Published var servers: [ServerInfo] = []\n'),
  state: between(source, '    @Published var checkRequestedAt: Double?', '    @Published var activity:'),
  grouping: between(source, 'func checksByApp(_ servers: [ServerInfo]) -> [SetupChecks] {', '/// One tool call from activity.jsonl:'),
  request: between(source, '    func requestChecks(force: Bool = false) {', '    var appChecks:'),
  appChecks: line(source, '    var appChecks: [SetupChecks] { checksByApp(servers) }\n'),
  snapshot: line(source, '        servers = sv\n'),
  refresh: between(source, '        if let at = checkRequestedAt, checksByApp(sv).contains', '        let attrs = [ACTIVITY_FILE, ACTIVITY_OLD]'),
};
const writeStatement = '        try? String(Int(at)).write(toFile: CHECK_REQUEST, atomically: true, encoding: .utf8)\n';
const memoryStatement = '        requestSink.append(String(Int(at)))\n';
assert.equal(pieces.request.split(writeStatement).length, 2, 'exactly one request I/O statement');
const inertRequest = pieces.request.replace(writeStatement, memoryStatement);
assert.equal(inertRequest.replace(memoryStatement, writeStatement), pieces.request, 'I/O replacement is fully reversible');
const extracted = Object.values(pieces).join('');
assert.doesNotMatch(extracted.replace(writeStatement, ''), /\b(?:AppKit|FileManager|Process|NSWorkspace|URLSession|DispatchQueue|refreshPanelData|tick)\b/);
receipt.extraction = Object.fromEntries(Object.entries(pieces).map(([name, text]) => [name, {
  sourceOffset: source.indexOf(text), bytes: Buffer.byteLength(text), sha256: hash(text),
}]));
receipt.transformation = { count: 1, from: writeStatement, to: memoryStatement,
  originalRequestSha256: hash(pieces.request), inertRequestSha256: hash(inertRequest),
  restoredRequestSha256: hash(inertRequest.replace(memoryStatement, writeStatement)) };
// These call sites are provenance controls, not an execution of UI or settings scheduling.
receipt.forceOrigins = [
  line(source, '                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.requestChecks(force: true) }\n'),
  line(source, '        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.requestChecks(force: true) }\n'),
  line(source, '                PlainButton(text: model.checkRequestedAt != nil ? L("正在检查…", "Checking…") : L("重新检查", "Check again")) { model.requestChecks(force: true) }\n'),   // I18N1: two-language
].map(text => ({ sourceOffset: source.indexOf(text), text, sha256: hash(text) }));

const prelude = `import Foundation

var clock = 0.0
func nowMs() -> Double { clock }
@propertyWrapper struct Published<Value> {
    var wrappedValue: Value
    init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
}
struct Settings { var paused = false }
struct Check { let id: String, ok: Bool, skipped: Bool }
struct SetupChecks { let at: Double, app: String?, items: [Check] }
struct ServerInfo {
    let id: Int, startedAt: Double
    var checks: SetupChecks?
    var managedSession = false
}
`;
const modelPrelude = `final class Model {
    var live = true
    var requestSink: [String] = []
`;
const scenarios = `
}
var checks = 0
var failures: [String] = []
var completed: [String] = []
var observations: [[String: Any]] = []
func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
    checks += 1
    if !condition() { failures.append(name) }
}
func scenario(_ name: String, _ body: () -> Void) {
    clock = 40_000; body(); completed.append(name)
}
func go(_ m: Model, _ at: Double) { clock = at; m.now = at }
func result(_ at: Double, _ app: String? = "A", _ items: [Check] = []) -> SetupChecks {
    SetupChecks(at: at, app: app, items: items)
}
func server(_ id: Int, _ check: SetupChecks? = nil, started: Double = 0, managed: Bool = false) -> ServerInfo {
    ServerInfo(id: id, startedAt: started, checks: check, managedSession: managed)
}
func note(_ name: String, _ m: Model) {
    observations.append(["name": name, "writes": m.requestSink, "pending": m.checkRequestedAt as Any? ?? NSNull()])
}

scenario("automatic-partial-answer-cooldown") {
    let m = Model(); m.refresh([server(1, result(1_000)), server(2)])
    expect(m.requestSink == ["40000"] && m.checkRequestedAt == 40_000, "automatic missing result issues first request")
    go(m, 41_000); m.refresh([server(1, result(41_000)), server(2)])
    note("automatic-partial-answer", m)
    expect(m.checkRequestedAt == nil, "one app answer still clears pending with existing contains semantics")
    expect(m.requestSink.count == 1, "automatic origin partial answer must not immediately rebroadcast")
    go(m, 69_999); m.refresh([server(1, result(41_000)), server(2)])
    expect(m.requestSink.count == 1, "automatic fallback stays quiet before 30 seconds")
    go(m, 70_000); m.refresh([server(1, result(41_000)), server(2)])
    expect(m.requestSink == ["40000", "70000"], "unanswered app retries at independent 30-second boundary")
    go(m, 71_000); m.refresh([server(1, result(71_000)), server(2)])
    expect(m.checkRequestedAt == nil && m.requestSink.count == 2, "partial answer also preserves the next cooldown")
    go(m, 100_000); m.refresh([server(1, result(71_000)), server(2)])
    expect(m.requestSink == ["40000", "70000", "100000"], "permanently missing result can retry in successive bounded windows")
}
scenario("manual-force-partial-answer") {
    let m = Model(); m.servers = [server(1, result(39_000)), server(2)]; m.requestChecks(force: true)
    expect(m.requestSink == ["40000"], "manual force bypasses ordinary freshness")
    go(m, 41_000); m.refresh([server(1, result(41_000)), server(2)])
    note("manual-force-partial-answer", m)
    expect(m.checkRequestedAt == nil, "manual answer retains contains pending completion")
    expect(m.requestSink.count == 1, "manual origin partial answer must not immediately rebroadcast")
    go(m, 70_000); m.refresh([server(1, result(41_000)), server(2)])
    expect(m.requestSink == ["40000", "70000"], "manual request establishes automatic retry window")
}
scenario("resume-force-partial-answer") {
    let m = Model(); m.settings.paused = true; m.servers = [server(1, result(39_000)), server(2)]
    m.requestChecks(force: true)
    expect(m.requestSink.isEmpty, "paused resume precursor cannot request")
    // Existing resume completion clears pending, then its callback reaches this actual force entry.
    m.settings.paused = false; m.checkRequestedAt = nil; m.requestChecks(force: true)
    expect(m.requestSink == ["40000"], "resume force reaches request issuance")
    go(m, 41_000); m.refresh([server(1, result(41_000)), server(2)])
    note("resume-force-partial-answer", m)
    expect(m.requestSink.count == 1, "resume origin partial answer must not immediately rebroadcast")
    expect(m.checkRequestedAt == nil, "resume answer preserves pending completion")
    go(m, 70_000); m.refresh([server(1, result(41_000)), server(2)])
    expect(m.requestSink == ["40000", "70000"], "resume request establishes automatic retry window")
}
scenario("chrome-gone-origin-partial-answer") {
    let m = Model(); let gone = Check(id: "chrome_running", ok: false, skipped: false)
    m.servers = [server(1, result(39_999, "A", [gone])), server(2)]; m.requestChecks()
    expect(m.requestSink == ["40000"], "fresh Chrome-gone result bypasses ordinary freshness")
    go(m, 41_000); m.refresh([server(1, result(41_000)), server(2)])
    expect(m.requestSink.count == 1, "Chrome-gone origin establishes automatic cooldown")
}
scenario("ordinary-origin-partial-answer") {
    let m = Model(); go(m, 400_000); m.servers = [server(1, result(100_000)), server(2)]; m.requestChecks()
    expect(m.requestSink == ["400000"], "ordinary request issues at five-minute boundary")
    go(m, 401_000); m.refresh([server(1, result(401_000)), server(2)])
    expect(m.requestSink.count == 1, "ordinary issuance also establishes automatic cooldown")
}
scenario("explicit-force-inside-cooldown") {
    let m = Model(); m.servers = [server(1, result(39_000))]; m.requestChecks(force: true)
    go(m, 41_000); m.refresh([server(1, result(41_000))]); go(m, 41_500); m.requestChecks(force: true)
    expect(m.requestSink == ["40000", "41500"], "explicit force remains allowed inside automatic cooldown")
    m.requestChecks(force: true)
    expect(m.requestSink.count == 2, "explicit force still respects an existing pending request")
    go(m, 42_000); m.refresh([server(1, result(42_000))]); go(m, 42_500); m.requestChecks(force: true)
    expect(m.requestSink == ["40000", "41500", "42500"], "repeated explicit force after answers is never cooldown-blocked")
    go(m, 43_000); m.refresh([server(1, result(43_000)), server(2)])
    go(m, 72_499); m.refresh([server(1, result(43_000)), server(2)])
    expect(m.requestSink.count == 3, "latest explicit request resets automatic window")
    go(m, 72_500); m.refresh([server(1, result(43_000)), server(2)])
    expect(m.requestSink.last == "72500" && m.requestSink.count == 4, "automatic retry uses latest explicit issuance time")
}
scenario("nonlive-paused-managed-and-empty") {
    let nonlive = Model(); nonlive.live = false; nonlive.refresh([server(1)]); nonlive.requestChecks(force: true)
    expect(nonlive.requestSink.isEmpty && nonlive.checkRequestedAt == nil, "nonlive never issues")
    let paused = Model(); paused.settings.paused = true; paused.refresh([server(1)]); paused.requestChecks(force: true)
    expect(paused.requestSink.isEmpty && paused.checkRequestedAt == nil, "paused never issues")
    let managed = Model(); managed.refresh([server(1, managed: true)]); managed.requestChecks(force: true)
    expect(managed.requestSink.isEmpty && managed.checkRequestedAt == nil, "managed-only never issues")
    let empty = Model(); empty.refresh([]); empty.requestChecks(force: true)
    expect(empty.requestSink.isEmpty && empty.checkRequestedAt == nil, "empty snapshot never issues")
    let mixed = Model(); mixed.refresh([server(1, result(39_000)), server(2, managed: true)])
    expect(mixed.requestSink.isEmpty, "managed missing result does not trigger fallback beside answered unmanaged")
    // Refused paths above must not establish a retry window.
    nonlive.live = true; nonlive.refresh([server(1)])
    paused.settings.paused = false; paused.refresh([server(1)])
    managed.refresh([server(1)]); empty.refresh([server(1)])
    expect([nonlive, paused, managed, empty].allSatisfy { $0.requestSink == ["40000"] }, "refused issuance leaves first automatic request eligible")
}
scenario("missing-age-boundary") {
    let m = Model(); m.refresh([server(1, started: 20_000)])
    expect(m.requestSink.isEmpty, "exactly 20 seconds old is not aged missing")
    go(m, 40_001); m.refresh([server(1, started: 20_000)])
    expect(m.requestSink == ["40001"], "older than 20 seconds triggers missing fallback")
}
scenario("pending-timeout-boundary") {
    let m = Model(); m.refresh([server(1)])
    go(m, 70_000); m.refresh([server(1)])
    expect(m.checkRequestedAt == 40_000 && m.requestSink == ["40000"], "pending remains at exactly 30 seconds")
    go(m, 70_001); m.refresh([server(1)])
    expect(m.checkRequestedAt == 70_001 && m.requestSink == ["40000", "70001"], "unanswered pending times out after 30 seconds and retries")
}
scenario("pending-answer-equality-and-managed-exclusion") {
    let m = Model(); m.servers = [server(1)]; m.requestChecks(force: true)
    go(m, 41_000); m.refresh([server(1, result(39_999)), server(2, result(41_000), managed: true)])
    expect(m.checkRequestedAt == 40_000, "older result and managed answer cannot complete pending")
    m.refresh([server(1, result(40_000)), server(2)])
    expect(m.checkRequestedAt == nil, "equal result timestamp completes pending")
    expect(m.requestSink == ["40000"], "equal completion cannot immediately rebroadcast for another missing session")
}
scenario("all-answered-and-missing-session-exits") {
    let all = Model(); all.refresh([server(1), server(2)])
    go(all, 41_000); all.refresh([server(1, result(41_000)), server(2, result(41_000, "B"))])
    expect(all.checkRequestedAt == nil && all.requestSink.count == 1, "both app answers complete without fallback")
    go(all, 100_000); all.refresh([server(1, result(41_000)), server(2, result(41_000, "B"))])
    expect(all.requestSink.count == 1, "answered apps do not retry merely because cooldown elapsed")
    let exited = Model(); go(exited, 40_000); exited.refresh([server(1), server(2)])
    go(exited, 41_000); exited.refresh([server(1, result(41_000))])
    go(exited, 70_000); exited.refresh([server(1, result(41_000))])
    expect(exited.checkRequestedAt == nil && exited.requestSink.count == 1, "missing session exit removes fallback reason")
}
scenario("empty-snapshot-pending-timeout") {
    let m = Model(); m.refresh([server(1)]); go(m, 41_000); m.refresh([])
    expect(m.checkRequestedAt == 40_000, "empty group does not vacuously complete pending")
    go(m, 70_000); m.refresh([])
    expect(m.checkRequestedAt == 40_000, "empty pending retains exact timeout boundary")
    go(m, 70_001); m.refresh([])
    expect(m.checkRequestedAt == nil && m.requestSink.count == 1, "empty pending eventually clears without rebroadcast")
}
scenario("same-app-copy-delay-and-grouping") {
    let m = Model(); m.refresh([server(1, result(1_000)), server(2)])
    go(m, 41_000); m.refresh([server(1, result(41_000)), server(2)])
    expect(m.appChecks.count == 1 && m.appChecks[0].at == 41_000, "same-app known result still groups to one answer")
    expect(m.requestSink.count == 1, "delayed same-app copy does not immediately cause a broadcast")
    go(m, 42_000); m.refresh([server(1, result(41_000)), server(2, result(41_000))])
    go(m, 70_000); m.refresh([server(1, result(41_000)), server(2, result(41_000))])
    expect(m.requestSink.count == 1 && m.appChecks.count == 1, "borrowed same-app copy arrives before retry without new request")
    let stillMissing = Model(); go(stillMissing, 40_000); stillMissing.refresh([server(1, result(1_000)), server(2)])
    go(stillMissing, 41_000); stillMissing.refresh([server(1, result(41_000)), server(2)])
    go(stillMissing, 70_000); stillMissing.refresh([server(1, result(41_000)), server(2)])
    expect(stillMissing.requestSink == ["40000", "70000"], "unknown ownership of nil checks remains eligible after cooldown")
    let grouped = checksByApp([server(1, result(10, "B")), server(2, result(20)), server(3, result(30)),
        server(4, result(90, "A"), managed: true), server(5)])
    expect(grouped.map { $0.app! } == ["A", "B"] && grouped.map { $0.at } == [30, 10], "grouping keeps freshest per app sorted and excludes managed or missing")
}
scenario("unknown-app-result") {
    let m = Model(); m.refresh([server(1, result(1_000, nil)), server(2)])
    go(m, 41_000); m.refresh([server(1, result(41_000, nil)), server(2)])
    expect(m.checkRequestedAt == nil && m.requestSink.count == 1, "unknown-app result preserves contains completion with bounded fallback")
    let grouped = checksByApp([server(1, result(10, nil)), server(2, result(20, nil)), server(3, result(30))])
    expect(grouped.count == 2 && grouped[0].app == nil && grouped[0].at == 20, "unknown apps retain shared question-mark grouping and newest result")
    go(m, 70_000); m.refresh([server(1, result(41_000, nil)), server(2)])
    expect(m.requestSink == ["40000", "70000"], "unknown-app missing result remains retryable")
}
scenario("ordinary-five-minute-freshness") {
    let m = Model(); go(m, 400_000); m.servers = [server(1, result(100_001))]; m.requestChecks()
    expect(m.requestSink.isEmpty, "ordinary opening avoids checks younger than five minutes")
    m.servers = [server(1, result(100_000))]; m.requestChecks()
    expect(m.requestSink == ["400000"], "ordinary opening requests at exactly five minutes")
    let newest = Model(); go(newest, 400_000); newest.servers = [server(1, result(1)), server(2, result(399_999, "B"))]; newest.requestChecks()
    expect(newest.requestSink.isEmpty, "ordinary freshness continues to use newest grouped app result")
}
scenario("chrome-gone-and-fresh-failure-controls") {
    for id in ["chrome_running", "chrome_installed"] {
        let m = Model(); m.servers = [server(1, result(39_999, "A", [Check(id: id, ok: false, skipped: false)]))]
        m.requestChecks(); expect(m.requestSink == ["40000"], id + " failure requests immediately")
        go(m, 41_000); m.refresh([server(1, result(41_000, "A", [Check(id: id, ok: false, skipped: false)]))])
        m.requestChecks(); expect(m.requestSink == ["40000", "41000"], id + " ordinary bypass remains allowed within cooldown")
        clock = 40_000
    }
    for check in [Check(id: "chrome_running", ok: true, skipped: false),
                  Check(id: "chrome_installed", ok: false, skipped: true),
                  Check(id: "accessibility", ok: false, skipped: false)] {
        let m = Model(); m.servers = [server(1, result(39_999, "A", [check]))]; m.requestChecks()
        expect(m.requestSink.isEmpty, "fresh non-Chrome-gone result stays suppressed: " + check.id + String(check.skipped))
    }
    let m = Model(); m.servers = [server(1, result(39_999)), server(2, result(40_000, "B", [Check(id: "chrome_running", ok: false, skipped: false)]), managed: true)]
    m.requestChecks(); expect(m.requestSink.isEmpty, "managed Chrome failure does not bypass freshness")
}
scenario("pause-during-window-and-resume-force") {
    let m = Model(); m.refresh([server(1)]); m.settings.paused = true
    go(m, 41_000); m.refresh([server(1, result(41_000)), server(2)])
    expect(m.checkRequestedAt == nil && m.requestSink.count == 1, "paused refresh can complete pending without issuing")
    go(m, 70_000); m.refresh([server(1, result(41_000)), server(2)])
    expect(m.requestSink.count == 1, "elapsed cooldown cannot issue while paused")
    m.settings.paused = false; m.checkRequestedAt = nil; m.requestChecks(force: true)
    expect(m.requestSink == ["40000", "70000"], "needed resume force still issues")
    go(m, 71_000); m.refresh([server(1, result(71_000)), server(2)])
    expect(m.requestSink.count == 2, "resume renews cooldown after paused interval")
}
scenario("request-clock-and-integer-payload") {
    let m = Model(); m.now = 50_000; clock = 50_001.75; m.servers = [server(1)]; m.requestChecks(force: true)
    expect(m.requestSink == ["50001"] && m.checkRequestedAt == 50_001.75, "request retains nowMs timestamp and integer wire payload")
    go(m, 51_000); m.refresh([server(1, result(51_000)), server(2)])
    go(m, 80_001); m.refresh([server(1, result(51_000)), server(2)])
    expect(m.requestSink.count == 1, "cooldown uses actual issuance timestamp rather than stale model now")
    go(m, 80_001.75); m.refresh([server(1, result(51_000)), server(2)])
    expect(m.requestSink == ["50001", "80001"], "fractional issuance timestamp reaches exact retry boundary")
}
let output: [String: Any] = ["schema": 1, "cases": completed, "checks": checks, "failures": failures, "observations": observations]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
exit(failures.isEmpty ? 0 : 86)
`;

async function child(label, argv, timeoutMs) {
  const stdoutPath = path.join(directory, `${label}.stdout.txt`), stderrPath = path.join(directory, `${label}.stderr.txt`);
  const stdout = await open(stdoutPath, 'wx', 0o600), stderr = await open(stderrPath, 'wx', 0o600);
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
          command.unref(); finish({ status: 'containment_unconfirmed', exitCode: null, signal: null });
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

async function variant(name, request, refresh) {
  const text = prelude + pieces.grouping + modelPrelude + pieces.now + pieces.settings + pieces.servers + pieces.state +
    request + pieces.appChecks + '    func refresh(_ sv: [ServerInfo]) {\n' + pieces.snapshot + refresh + '    }\n' + scenarios;
  const swift = path.join(directory, `${name}.swift`), binary = path.join(directory, name);
  await save(`${name}.swift`, text);
  const record = { name, swiftSha256: hash(text), requestSha256: hash(request), refreshSha256: hash(refresh), compile: null, run: null };
  receipt.variants.push(record);
  record.compile = await child(`${name}-compile`, ['swiftc', '-module-cache-path', path.join(directory, 'module-cache'), swift, '-o', binary], 60_000);
  assert.equal(record.compile.exitCode, 0, `${name}: compile failure is not a behavioral test result`);
  record.binarySha256 = hash(await readFile(binary));
  record.run = await child(`${name}-run`, [binary], 5000);
  record.result = JSON.parse(await readFile(record.run.streams.stdout.path, 'utf8'));
  assert.equal(record.result.schema, 1);
  assert.equal(record.result.cases.length, 18);
  assert.ok(record.result.checks >= 65);
  assert.ok(Array.isArray(record.result.failures));
  return record;
}

try {
  await save('source.swift', source);
  await save('extracted.json', JSON.stringify(pieces, null, 2) + '\n');
  const original = await variant('original', inertRequest, pieces.refresh);
  assert.equal(original.run.exitCode, 0, `production request assertions failed: ${original.result.failures.join('; ')}`);
  assert.deepEqual(original.result.failures, []);

  const cooldown = '(lastCheckRequestedAt.map { now - $0 >= 30_000 } ?? true), ';
  assert.equal(pieces.refresh.split(cooldown).length, 2, 'automatic cooldown is a unique production condition');
  const explicitGuard = '        guard live, checkRequestedAt == nil, !settings.paused else { return }\n';
  assert.equal(inertRequest.split(explicitGuard).length, 2, 'explicit request guard is unique');
  const mutants = [
    ['missing-automatic-cooldown', inertRequest, pieces.refresh.replace(cooldown, ''),
      'automatic origin partial answer must not immediately rebroadcast'],
    ['incorrectly-blocked-explicit', inertRequest.replace(explicitGuard,
      '        guard live, checkRequestedAt == nil, !settings.paused, (lastCheckRequestedAt.map { now - $0 >= 30_000 } ?? true) else { return }\n'),
      pieces.refresh, 'explicit force remains allowed inside automatic cooldown'],
  ];
  for (const [name, request, refresh, expected] of mutants) {
    assert.ok(request !== inertRequest || refresh !== pieces.refresh, `${name} changes an actual production statement`);
    const result = await variant(name, request, refresh);
    assert.equal(result.run.exitCode, 86, `${name}: only a behavioral failure kills this mutant`);
    assert.ok(result.result.failures.includes(expected), `${name}: expected request oracle was not triggered`);
    result.killedBy = expected;
  }
  assert.equal(hash(await readFile(sourcePath)), receipt.sourceSha256, 'production source stays unchanged throughout test');
  receipt.status = 'passed';
  console.log(`gui-check-coalescing: ${original.result.cases.length} scenarios, ${original.result.checks} assertions, 2 valid mutants; evidence ${directory}`);
} catch (error) {
  receipt.status = 'failed';
  receipt.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  await save('receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  if (receipt.status !== 'passed') console.error(`gui-check-coalescing evidence: ${directory}`);
}
