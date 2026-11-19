/* FOCUS2: the opt-in activation backends (skylight / carbon) in src/native-chrome.swift.
 *
 * A driver is compiled exactly as scripts/build-native.sh compiles the helpers (its flags, including
 * -D MYCHROME_FOCUS_BACKENDS, and its objc-try.h shim, recorded with a fake compiler) together with the real
 * src/native-chrome.swift. It calls the production Focus code with fakes: no window is activated, raised or keyed,
 * no event record is posted, and no private SkyLight function is called. The only processes started are /bin/sh
 * fixtures standing in for the `cgevent focus-front` child.
 *
 * Groups (FOCUS2_GROUP=new|kept runs one):
 *   new   fails on revert to 0bff57b, or under the targeted mutation runs/FOCUS2/rerun.sh applies to it;
 *   kept  legacy behaviour the backends must not change.
 * NATIVE_CHROME_SOURCE / BUILD_NATIVE_SCRIPT point at other copies. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'This suite compiles a macOS Swift driver.');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_PATH = process.env.NATIVE_CHROME_SOURCE || path.join(ROOT, 'src/native-chrome.swift');
const native = fs.readFileSync(NATIVE_PATH, 'utf8');
const BUILD = process.env.BUILD_NATIVE_SCRIPT || path.join(ROOT, 'scripts/build-native.sh');
const GROUP = process.env.FOCUS2_GROUP || 'all';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-focus2-'));
let passed = 0, failed = 0;
function check(group, name, fn) {
  if (GROUP !== 'all' && GROUP !== group) return;
  try { fn(); passed++; console.log(`  ok    [${group}] ${name}`); }
  catch (error) { failed++; console.log(`  FAIL  [${group}] ${name}\n        ${String(error.message).split('\n').slice(0, 8).join('\n        ')}`); }
}
function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: opts.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/* ------------------------------------------------ the build's own flags and shim (as sb-boundary.test.mjs) */
const build = (() => {
  const root = path.join(tmp, 'build-root'), stash = path.join(tmp, 'build-stash');
  for (const d of ['src', 'bin', 'scripts']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(stash);
  fs.copyFileSync(BUILD, path.join(root, 'scripts/build-native.sh'));
  for (const n of ['helper.swift', 'chromectl.swift', 'native-chrome.swift']) fs.writeFileSync(path.join(root, 'src', n), `// fixture ${n}\n`);
  const recorder = path.join(tmp, 'recorder.cjs');
  fs.writeFileSync(recorder, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),stash=process.env.FOCUS2_STASH;
const n=fs.readdirSync(stash).filter(x=>x.startsWith('argv-')).length,i=a.indexOf('-import-objc-header');
if(i>=0) fs.copyFileSync(a[i+1],path.join(stash,'objc-try-'+n+'.h'));
fs.writeFileSync(path.join(stash,'argv-'+n+'.json'),JSON.stringify(a));fs.writeFileSync(a[a.indexOf('-o')+1],'recorded');
`, { mode: 0o755 });
  const r = spawnSync('/bin/sh', [path.join(root, 'scripts/build-native.sh')], { encoding: 'utf8', env: { ...process.env, MYCHROME_SWIFTC: recorder, FOCUS2_STASH: stash } });
  const argvs = fs.readdirSync(stash).filter(x => x.startsWith('argv-')).sort().map(x => JSON.parse(fs.readFileSync(path.join(stash, x), 'utf8')));
  const flags = (argvs[0] ?? []).filter((x, k, a) => x !== '-o' && a[k - 1] !== '-o' && !x.endsWith('.swift') &&
    x !== '-import-objc-header' && a[k - 1] !== '-import-objc-header');
  const header = fs.existsSync(path.join(stash, 'objc-try-0.h')) ? path.join(stash, 'objc-try-0.h') : null;
  return { status: r.status, stderr: r.stderr, argvs, flags, header };
})();

// focusOrder, unchanged, as it sits inside Owner.focus (Chrome's own order only).
const orderStart = native.indexOf('            func focusOrder(');
const focusOrder = orderStart < 0 ? null : native.slice(orderStart, native.indexOf('\n            }\n', orderStart) + 14);

const DRIVER = String.raw`import Foundation
import AppKit
typealias Focus = ChromeNative.Focus
func out(_ v: Any) { print(String(data: try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]), encoding: .utf8)!) }
let input = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
func rows(_ value: Any?) -> [[String: Any]] {
    (value as? [[String: Any]] ?? []).map { r in
        let b = r["bounds"] as! [Double]
        var row: [String: Any] = [kCGWindowOwnerPID as String: r["pid"] as! Int, kCGWindowNumber as String: r["id"] as! Int,
            kCGWindowLayer as String: r["layer"] as? Int ?? 0, kCGWindowAlpha as String: r["alpha"] as? Double ?? 1,
            kCGWindowOwnerName as String: r["name"] as? String ?? "Fixture",
            kCGWindowBounds as String: CGRect(x: b[0], y: b[1], width: b[2], height: b[3]).dictionaryRepresentation as NSDictionary]
        if r["name"] is NSNull { row.removeValue(forKey: kCGWindowOwnerName as String) }
        return row
    }
}
${focusOrder ?? '// focusOrder missing'}
struct FixtureStop: Error {}
switch input["case"] as! String {
case "record":
    out(["bytes": Focus.keyRecord(wid: UInt32(input["wid"] as! Int)).map { Int($0) }])
case "request":
    let r = Focus.request(input["intent"] as! [String: Any])
    out(r.map { ["backend": $0.backend.rawValue, "carbonFlag": Int($0.carbonFlag), "reraise": $0.reraise, "record": $0.record] as [String: Any] } ?? ["legacy": true])
case "symbols":
    let missing = Set(input["missing"] as? [String] ?? [])
    out(Focus.symbolReport { missing.contains($0) ? nil : UnsafeMutableRawPointer(bitPattern: 0x1000) })
case "child":
    var calls: [String] = [], fronts: [[Int]] = [], posted: [[Int]] = []
    let reply = Focus.childSequence(pid: 77, wid: UInt32(input["wid"] as? Int ?? 4660), record: input["record"] as? Bool ?? true, calls: Focus.ChildCalls(
        psn: { pid, psn in calls.append("psn"); psn.lowLongOfPSN = 9; return OSStatus(input["psn"] as? Int ?? 0) },
        front: { psn, wid, mode in calls.append("front"); fronts.append([Int(psn.lowLongOfPSN), Int(wid), Int(mode)]); return Int32(input["front"] as? Int ?? 0) },
        post: { psn, bytes in calls.append("post"); posted.append((0..<Focus.recordSize).map { Int(bytes[$0]) }); return Int32(input["post"] as? Int ?? 0) }))
    out(["reply": reply, "calls": calls, "fronts": fronts, "posted": posted])
case "runchild":
    let t0 = ProcessInfo.processInfo.systemUptime
    var reaped = 0, blocking = 0
    let neverReaps = input["neverReaps"] as? Bool == true
    let r = neverReaps
        ? Focus.runChild(executable: input["exe"] as! String, arguments: input["args"] as? [String] ?? [], pid: 77, wid: 4660,
                         limit: input["limit"] as? Double ?? Focus.childLimit, service: { usleep(1000) },
                         wait: { _, _, flags in if flags == WNOHANG { return 0 }; blocking += 1; usleep(2_000_000); return -1 },
                         reaper: { _ in reaped += 1 })
        : Focus.runChild(executable: input["exe"] as! String, arguments: input["args"] as? [String] ?? [], pid: 77, wid: 4660,
                         limit: input["limit"] as? Double ?? Focus.childLimit, service: { usleep(1000) })
    out(["kind": r.kind, "ms": r.ms, "wall": (ProcessInfo.processInfo.systemUptime - t0) * 1000, "landed": r.landed, "breaks": r.breaks,
         "exit": r.exitCode.map { Int($0) as Any } ?? NSNull(), "signal": r.signal.map { Int($0) as Any } ?? NSNull(),
         "reaperCalls": reaped, "blockingWaits": blocking])
case "coverage":
    let list = rows(input["rows"])
    var r: [String: Any] = ["coverage": Focus.coverage(list, pid: 42, cg: 10, ownPid: 999).rawValue]
    if input["order"] as? Bool == true {
        let o = focusOrder(list, pid: 42, cg: 10, frontPid: 42, indicators: [], ownPid: 999)
        r["chromeOrderOnTop"] = o.onTop
    }
    out(r)
case "run":
    let w = input["world"] as? [String: Any] ?? [:]
    var clock = 100.0, log: [[String: Any]] = [], sampleIndex = 0, coverageIndex = 0, tabIndex = 0, appleDone = false
    func pick<T>(_ key: String, _ i: inout Int, _ fallback: T) -> T {
        guard let list = w[key] as? [Any], !list.isEmpty else { return fallback }
        let v = list[min(i, list.count - 1)]; i += 1; return v as? T ?? fallback
    }
    func note(_ what: String) { log.append(["at": Int(((clock - 100) * 1000).rounded()), "what": what]) }
    let child = w["child"] as? [String: Any] ?? ["kind": "posted", "ms": 20]
    let tx = ChromeNative.Transaction(operationId: "focus2-fixture", checkpoint: { _ in })
    let cost = w["sampleCost"] as? Double ?? 0.004
    let fx = Focus.Effects(
        now: { clock }, chromePid: 42, tabId: 5,
        symbols: { b in note("symbols:" + b.rawValue); return w["symbols"] as? Bool ?? true },
        tabBound: { note("tabBound"); return w["tabBound"] as? Bool ?? true },
        window: { note("window"); return Focus.WindowFacts(onScreen: w["onScreen"] as? Bool ?? true, owner: w["owner"] as? Int ?? 42,
                                                          layer: w["layer"] as? Int ?? 0, axMatches: w["ax"] as? Int ?? 1) },
        mode: { note("mode"); return w["mode"] is NSNull ? nil : (w["mode"] as? String ?? "normal") },
        psn: { note("psn"); return w["psn"] as? Bool ?? true },
        prepareMain: { note("prepare:main"); return { note("write:main"); clock += 0.001 } },
        prepareRaise: { stage in note("prepare:" + stage)
            if w["throwAt"] as? String == "prepareRaise" && stage == "activate_raise" { throw ChromeNative.Failure("native_target_changed", "native_window_binding") }
            if w["throwAt"] as? String == "reraiseWrite" && stage == "activate_reraise" {
                return { note("write:" + stage); throw ChromeNative.Failure("native_write_unknown", stage, osStatus: -25204) } }
            return { note("write:" + stage); clock += 0.001
                if w["throwAt"] as? String == "raiseWrite" && stage == "activate_raise" { throw ChromeNative.Failure("native_write_unknown", stage, osStatus: -25204) } } },
        prepareChild: { r in note("prepare:child" + (r.record ? "" : ":norecord")); return {
            note("child"); clock += (child["ms"] as? Double ?? 20) / 1000
            return Focus.ChildResult(kind: child["kind"] as! String, ms: child["ms"] as? Double ?? 20, frontStatus: child["frontStatus"] as? Int)
        } },
        prepareCarbon: { flag in note("prepare:carbon:\(flag)"); return { note("write:carbon"); clock += 0.001
            if let s = w["carbonStatus"] as? Int, s != 0 { throw ChromeNative.Failure("native_write_unknown", "activate_front", osStatus: s) } } },
        finalVerify: { note("finalVerify")
            if w["throwAt"] as? String == "finalVerify" { throw ChromeNative.Failure("native_target_changed", "native_binding", details: ["bindingReason": "window_missing"]) }
            return ChromeNative.WindowRow(id: 1, tabs: [5, 6], activeTab: w["activeTab"] as? Int ?? 5, index: 1,
                                                                        bounds: .zero, minimized: false, title: "fixture") },
        sample: { deadline in
            if clock + cost >= deadline { clock = deadline; throw ChromeNative.DialogFailure(code: "dialog_probe_unknown", stage: "native_read_deadline") }
            clock += cost
            if w["throwAt"] as? String == "sample" { throw ChromeNative.DialogFailure(code: "dialog_probe_unknown", stage: "native_ax_read") }
            if w["throwAt"] as? String == "stop" { throw FixtureStop() }
            var s = pick("samples", &sampleIndex, [String: Any]())
            if let late = w["late"] as? [String: Any], (clock - 100) * 1000 >= late["afterMs"] as! Double { s = late["sample"] as! [String: Any] }
            if appleDone, let after = w["afterApple"] as? [String: Any] { s = after }   // FOCUS4 A: the world after the Apple Event
            note("sample")
            return (s["onTop"] as? Bool ?? true, s["key"] as? Bool ?? true, s["front"] as? Int ?? 42, ["sample": sampleIndex])
        },
        coverage: { _ in
            if w["throwAt"] as? String == "coverage" { throw ChromeNative.Failure("native_focus_unknown", "native_focus_read") }
            let c = pick("coverage", &coverageIndex, "none"); note("coverage:" + c); return Focus.Coverage(rawValue: c)! },
        tabActive: { _ in let a = pick("tabActive", &tabIndex, true); note("tabActive:\(a)"); return a },
        pause: { until in clock = max(clock, until) },
        // FOCUS4 amendment A: "notFront" = Chrome is not the frontmost app after the activation, until the Apple Event.
        frontIsChrome: { let f = !(w["notFront"] as? Bool ?? false) || (appleDone && w["appleFails"] as? Bool != true); note("front:\(f)"); return f },
        appleActivate: { note("apple"); try tx.write("activate_apple", acknowledged: false) { clock += 0.001 }; appleDone = true })
    var outcome: [String: Any] = [:]
    do {
        if let done = try Focus.drive(Focus.Request(backend: Focus.Backend(rawValue: input["backend"] as? String ?? "skylight")!,
                                                  carbonFlag: UInt32(input["carbonFlag"] as? Int ?? 3), reraise: input["reraise"] as? Bool ?? true,
                                                  record: input["record"] as? Bool ?? true), fx, tx: tx) {
            outcome = tx.result(["ok": true, "targetOnTop": done.focus.0, "keyWindowIsTarget": done.focus.1, "details": done.focus.3])
        } else { outcome = tx.result(["fallback": true]) }
    } catch let f as ChromeNative.Failure { outcome = tx.result(f.json) }
    catch { outcome = tx.result(["ok": false, "thrown": String(describing: type(of: error))]) }
    outcome["log"] = log; outcome["elapsedMs"] = Int(((clock - 100) * 1000).rounded())
    out(outcome)
default: exit(70)
}
`;
const driver = (() => {
  let compiled = null;
  return input => {
    if (!compiled) {
      const dir = path.join(tmp, 'driver'); fs.mkdirSync(dir);
      const bin = path.join(dir, 'focus2'), main = path.join(dir, 'main.swift');
      fs.writeFileSync(main, DRIVER);
      const c = run('/usr/bin/xcrun', ['swiftc', ...build.flags, ...(build.header ? ['-import-objc-header', build.header] : []),
        '-o', bin, main, NATIVE_PATH], { timeout: 600_000 });
      fs.writeFileSync(path.join(dir, 'compile.log'), c.stderr);
      compiled = { bin, ok: c.status === 0, errors: c.stderr.split('\n').filter(l => /error:/.test(l)).slice(0, 5).join('\n') };
    }
    assert.ok(compiled.ok, `driver compile failed:\n${compiled.errors}`);
    const r = run(compiled.bin, [JSON.stringify(input)], { timeout: 30_000 });
    assert.equal(r.status, 0, `driver ${input.case}: status ${r.status} ${r.signal ?? ''}\n${r.stderr.slice(-600)}`);
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  };
})();
const writes = r => r.stages.map(s => s.stage);
const effects = r => r.log.map(e => e.what);

/* ------------------------------------------------ build */
check('new', 'build-native.sh compiles both helpers with -D MYCHROME_FOCUS_BACKENDS', () => {
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.argvs.length, 2);
  for (const a of build.argvs) { const i = a.indexOf('-D'); assert.ok(i >= 0 && a[i + 1] === 'MYCHROME_FOCUS_BACKENDS', JSON.stringify(a)); }
});

/* ------------------------------------------------ the record */
const WID = 0x0a0b0c0d;
function expectedRecord(wid) {
  const b = Buffer.alloc(0x100);
  b[0x04] = 0xf8; b[0x08] = 0x01; b.writeDoubleLE(300000, 0x20); b.writeDoubleLE(300000, 0x28); b[0x3a] = 0x10; b.writeUInt32LE(wid, 0x3c);
  return [...b];
}
check('new', 'record bytes: 0x100 zeroed, [04]=F8 [08]=01 [20..2F]=2×300000.0 [3A]=10 [3C..3F]=wid, nothing else', () => {
  const got = driver({ case: 'record', wid: WID }).bytes;
  assert.equal(got.length, 0x100);
  assert.deepEqual(got, expectedRecord(WID));
  assert.deepEqual(driver({ case: 'record', wid: 1 }).bytes, expectedRecord(1));
});
check('new', 'record fault mirror: each single-field fault of the expected record is told apart from the production bytes', () => {
  const got = driver({ case: 'record', wid: WID }).bytes, good = expectedRecord(WID);
  const faults = {
    'mouse-up instead of down': b => { b[0x08] = 0x02; }, 'length 0xF7': b => { b[0x04] = 0xf7; }, 'no 0x10 flag': b => { b[0x3a] = 0; },
    'wid byte-swapped': b => { b.writeUInt32BE(WID, 0x3c); }, 'point NaN (the legacy recipe)': b => { b.fill(0xff, 0x20, 0x30); },
    'point 300000 as Float32': b => { b.fill(0, 0x20, 0x30); b.writeFloatLE(300000, 0x20); b.writeFloatLE(300000, 0x24); },
    'stray byte past 0xF8': b => { b[0xfc] = 1; }, 'only 0xF8 allocated': b => b.subarray(0, 0xf8),
  };
  for (const [name, mutate] of Object.entries(faults)) {
    const copy = Buffer.from(good), mirror = [...(mutate(copy) ?? copy)];
    assert.notDeepEqual(mirror, good, `fault applied: ${name}`);
    assert.notDeepEqual(got, mirror, `production bytes must differ from the faulty mirror: ${name}`);
  }
});

/* ------------------------------------------------ the child's own sequence */
check('new', 'child: GetProcessForPID, one front (0x200, exact wid), exactly one record post; exit 0', () => {
  const r = driver({ case: 'child', wid: WID });
  assert.deepEqual(r.calls, ['psn', 'front', 'post']);
  assert.deepEqual(r.fronts, [[9, WID, 0x200]]);
  assert.equal(r.posted.length, 1, 'the post is called exactly once');
  assert.deepEqual(r.posted[0], expectedRecord(WID), 'the posted bytes are the record');
  assert.deepEqual(r.reply, { focusFront: 1, pid: 77, wid: WID, frontStatus: 0, posted: true, postStatus: 0, exit: 0 });
});
check('new', 'child: a front CGError posts nothing (exit 3); a refused post is not retried (exit 4); a PSN failure calls nothing private (exit 2)', () => {
  let r = driver({ case: 'child', front: -50 });
  assert.deepEqual(r.calls, ['psn', 'front']); assert.equal(r.reply.exit, 3); assert.equal(r.reply.frontStatus, -50);
  r = driver({ case: 'child', post: 1000 });
  assert.deepEqual(r.calls, ['psn', 'front', 'post']); assert.equal(r.reply.exit, 4); assert.equal(r.reply.postStatus, 1000);
  r = driver({ case: 'child', psn: -600 });
  assert.deepEqual(r.calls, ['psn']); assert.equal(r.reply.exit, 2); assert.equal(r.reply.stage, 'psn');
  r = driver({ case: 'child', record: false });
  assert.deepEqual(r.calls, ['psn', 'front']); assert.equal(r.reply.exit, 0); assert.equal(r.reply.posted, false);
});

/* ------------------------------------------------ the parent's wait for the child */
const sh = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
const reply = (exit, extra = '') => `{"exit":${exit},"focusFront":1,"pid":77,"wid":4660${extra}}`;
check('new', 'child outcomes: exit 0/4 land; exit 3 is a front error; signal, timeout, malformed and spawn failure open the breaker', () => {
  const cases = [
    ['posted', sh('ok.sh', `echo '${reply(0, ',"frontStatus":0,"posted":true,"postStatus":0')}'; exit 0`), true, false],
    ['post_refused', sh('refused.sh', `echo '${reply(4, ',"frontStatus":0,"posted":true,"postStatus":1000')}'; exit 4`), true, false],
    ['front_only', sh('frontonly.sh', `echo '${reply(0, ',"frontStatus":0,"posted":false')}'; exit 0`), true, false],
    ['front_error', sh('fronterr.sh', `echo '${reply(3, ',"frontStatus":-50')}'; exit 3`), false, false],
    // SIGKILL: same WIFSIGNALED path, and no crash report (a SIGSEGV child is held by ReportCrash and may read as timeout).
    ['signal', sh('signal.sh', 'kill -KILL $$'), false, true],
    ['malformed', sh('garbage.sh', 'echo not-json; exit 0'), false, true],
    ['malformed', sh('mismatch.sh', `echo '${reply(4, ',"frontStatus":0,"posted":true,"postStatus":1000')}'; exit 0`), false, true],
    ['malformed', sh('otherpid.sh', `echo '{"exit":0,"focusFront":1,"pid":78,"wid":4660,"frontStatus":0,"posted":true,"postStatus":0}'; exit 0`), false, true],
    ['malformed', sh('twolines.sh', `echo '${reply(0, ',"frontStatus":0,"posted":true,"postStatus":0')}'; echo '{}'; exit 0`), false, true],
    ['malformed', sh('exit2.sh', `echo '${reply(2, ',"stage":"psn"')}'; exit 2`), false, true],
    ['spawn_failed', path.join(tmp, 'does-not-exist'), false, true],
  ];
  for (const [kind, exe, landed, breaks] of cases) {
    // A 5 s limit here: macOS scans a freshly written executable on its first launch, which alone can pass 300 ms.
    // The production limit (300 ms) is the timeout case below; the real child is the already-running helper binary.
    const r = driver({ case: 'runchild', exe, limit: 5 });
    assert.equal(r.kind, kind, `${path.basename(exe)}: ${JSON.stringify(r)}`);
    assert.equal(r.landed, landed, path.basename(exe)); assert.equal(r.breaks, breaks, path.basename(exe));
  }
});
check('new', 'child timeout: the parent waits at most 300 ms, kills and reaps; nothing outlives the call', () => {
  const marker = path.join(tmp, 'late-marker');
  // One process (exec), as the real child: killed at the limit, it never writes the marker.
  const r = driver({ case: 'runchild', exe: sh('hang.sh', `exec '${process.execPath}' -e 'setTimeout(()=>require("fs").writeFileSync(process.argv[1],""),2000)' '${marker}'`) });
  assert.equal(r.kind, 'timeout'); assert.equal(r.breaks, true);
  assert.ok(r.wall < 450, `whole wait ${r.wall} ms`);
  spawnSync('/bin/sleep', ['2.3']);
  assert.equal(fs.existsSync(marker), false, 'the killed child never ran on');
});

check('new', 'r2.6 bounded reap: a child that is never reaped goes to the background reaper; the call returns <= 420 ms', () => {
  const r = driver({ case: 'runchild', exe: sh('hang-reap.sh', `exec '${process.execPath}' -e 'setTimeout(()=>{},5000)'`), neverReaps: true });
  assert.equal(r.kind, 'timeout'); assert.equal(r.breaks, true);
  assert.ok(r.wall <= 420, `whole call ${r.wall} ms`);
  assert.equal(r.reaperCalls, 1, 'handed to the background reaper once'); assert.equal(r.blockingWaits, 0, 'never a blocking waitpid on the caller');
});

/* ------------------------------------------------ the sequence, per backend */
const ok = (r, stages) => { assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(writes(r), stages); assert.equal(r.inputDelivery, 'sent'); };
check('new', 'skylight stages: activate_front_key (child) then activate_raise; never activate_main, activate_app or a second front', () => {
  const r = driver({ case: 'run', backend: 'skylight', world: {} });
  ok(r, ['activate_front_key', 'activate_raise']);
  assert.equal(effects(r).filter(e => e === 'child').length, 1);
  assert.equal(r.focusDriver, 'skylight'); assert.equal(r.focusChild, 'posted'); assert.equal(r.tSpawnMs, 20);
  assert.ok(Number.isInteger(r.tKeyMs) && r.tKeyMs >= 0, JSON.stringify(r));
  assert.deepEqual(effects(r).slice(0, 7), ['symbols:skylight', 'tabBound', 'window', 'mode', 'psn', 'prepare:child', 'child'],
    'the read-only preflight completes before the child is spawned');
});
check('new', 'no activate after a landed front: skylight and carbon write no activate_app; post_refused still only raises', () => {
  for (const [backend, world] of [['skylight', {}], ['skylight', { child: { kind: 'post_refused', ms: 15 } }], ['carbon', {}]]) {
    const r = driver({ case: 'run', backend, world });
    assert.equal(writes(r).includes('activate_app'), false, JSON.stringify(writes(r)));
    assert.equal(writes(r).filter(s => s.startsWith('activate_front')).length, 1);
  }
});
check('new', 'carbon stages: activate_main, activate_front (flag 3 by default, 1 on request), activate_raise; no repair', () => {
  let r = driver({ case: 'run', backend: 'carbon', world: { coverage: ['normal'] } });
  ok(r, ['activate_main', 'activate_front', 'activate_raise']);
  assert.ok(effects(r).includes('prepare:carbon:3')); assert.equal(r.focusDriver, 'carbon');
  assert.equal(effects(r).some(e => e.startsWith('coverage')), false, 'carbon never scans for the repair');
  r = driver({ case: 'run', backend: 'carbon', carbonFlag: 1, world: {} });
  assert.ok(effects(r).includes('prepare:carbon:1'));
  r = driver({ case: 'run', backend: 'carbon', world: { carbonStatus: -600 } });
  assert.equal(r.error, 'native_write_unknown'); assert.equal(r.inputDelivery, 'unknown'); assert.equal(r.noRetry, true);
  assert.deepEqual(writes(r), ['activate_main', 'activate_front']);
});
check('new', 'fallback to legacy only before any private call: each preflight failure writes nothing and names itself', () => {
  const cases = [['symbols_missing', { symbols: false }], ['tab_unbound', { tabBound: false }], ['off_screen', { onScreen: false }],
    ['owner', { owner: 77 }], ['layer', { layer: 3 }], ['ax_window', { ax: 0 }], ['ax_window', { ax: 2 }],
    ['mode_unknown', { mode: null }], ['mode_not_normal', { mode: 'incognito' }], ['psn', { psn: false }]];
  for (const backend of ['skylight', 'carbon']) for (const [reason, world] of cases) {
    const r = driver({ case: 'run', backend, world });
    assert.equal(r.fallback, true, `${backend} ${reason}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.stages, []); assert.equal(r.inputDelivery, 'not_sent');
    assert.equal(r.focusFallback, reason); assert.equal(r.focusDriver, 'legacy'); assert.equal(r.focusRequested, backend);
    assert.equal(effects(r).some(e => e.startsWith('prepare:') || e === 'child' || e.startsWith('write:')), false, `${backend} ${reason}`);
  }
});
check('new', 'after the child is entered any failure is unknown + noRetry and ends the transaction (no raise, no fallback)', () => {
  for (const kind of ['front_error', 'signal', 'timeout', 'malformed', 'spawn_failed']) {
    const r = driver({ case: 'run', backend: 'skylight', world: { child: { kind, ms: 300, frontStatus: kind === 'front_error' ? -50 : undefined } } });
    assert.equal(r.error, 'native_write_unknown', kind); assert.equal(r.stage, 'activate_front_key');
    assert.equal(r.inputDelivery, 'unknown'); assert.equal(r.noRetry, true);
    assert.deepEqual(writes(r), ['activate_front_key']); assert.equal(r.stages[0].delivery, 'unknown');
    assert.equal(r.focusChild, kind); assert.equal(r.focusDriver, 'skylight');
    assert.equal(effects(r).some(e => e.startsWith('prepare:activate_raise') || e === 'finalVerify'), false, kind);
    if (kind === 'front_error') assert.equal(r.focusFrontStatus, -50);
  }
});
// FOCUS4 (contracts-batch4.md G-b): the AX key window and CG order are facts for every backend; only a wrong active tab
// refuses. (FOCUS2 refused a never-key target with activate_unconfirmed here.)
check('new', 'FOCUS4: a backend activation whose target is never the AX key window completes with the fact; a wrong active tab still refuses', () => {
  const r = driver({ case: 'run', backend: 'skylight', world: { samples: [{ key: false }] } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.keyWindowIsTarget, false); assert.equal(r.targetOnTop, true);
  assert.equal(r.focusDriver, 'skylight'); assert.equal(r.tKeyMs, null, 'never key');
  assert.ok(r.elapsedMs < 150, `the first on-top sample decides; the key window is never waited for: ${r.elapsedMs}`);
  const order = driver({ case: 'run', backend: 'skylight', world: { samples: [{ onTop: false }] } });
  assert.equal(order.ok, true, JSON.stringify(order)); assert.equal(order.targetOnTop, false);
  assert.ok(order.elapsedMs >= 1000 && order.elapsedMs <= 1025, `never on top: settles to the 1 s deadline from just before the child: ${order.elapsedMs}`);
  const tab = driver({ case: 'run', backend: 'skylight', world: { activeTab: 6 } });
  assert.equal(tab.error, 'activate_unconfirmed', 'the wrong active tab is still refused');
  assert.equal(tab.focusVerdict, 'tab_not_current'); assert.equal(tab.noRetry, true);
});
// FOCUS4 amendment A (user decision 3): Chrome still not frontmost after a landed backend activation: one activate_apple
// write, the facts read again, focusAppleActivate; never when Chrome is frontmost; an error there is unknown + noRetry.
check('new', 'FOCUS4 A: Chrome not frontmost after the landed activation: the Apple Event activate once, then the facts again', () => {
  for (const backend of ['skylight', 'carbon']) {
    const r = driver({ case: 'run', backend, world: { notFront: true, samples: [{ front: 77, onTop: false, key: false }], afterApple: {} } });
    assert.equal(r.ok, true, `${backend}: ${JSON.stringify(r)}`);
    assert.equal(writes(r).filter(s => s === 'activate_apple').length, 1, `${backend}: ${JSON.stringify(writes(r))}`);
    assert.equal(r.focusAppleActivate, true); assert.equal(r.targetOnTop, true, 'the facts after the Apple Event');
    const front = driver({ case: 'run', backend, world: {} });
    assert.equal(writes(front).includes('activate_apple'), false, `${backend}: Chrome frontmost: no Apple Event`);
    assert.equal('focusAppleActivate' in front, false);
  }
  const fails = driver({ case: 'run', backend: 'skylight', world: { notFront: true, appleFails: true, samples: [{ front: 77, onTop: false }] } });
  assert.equal(fails.ok, true, 'still not front: the facts, not a refusal'); assert.equal(fails.focusAppleActivate, true);
  assert.equal(writes(fails).filter(s => s === 'activate_apple').length, 1, 'once only');
});

check('new', 'r2.5 after the landed point every error is terminal: native_write_unknown + unknown + noRetry, original code kept', () => {
  const cases = [
    ['skylight', 'prepareRaise', 'native_target_changed', 'native_window_binding'],
    ['skylight', 'raiseWrite', 'native_write_unknown', 'activate_raise'],
    ['skylight', 'finalVerify', 'native_target_changed', 'native_binding'],
    ['skylight', 'sample', 'dialog_probe_unknown', 'native_ax_read'],
    ['carbon', 'prepareRaise', 'native_target_changed', 'native_window_binding'],
    ['carbon', 'finalVerify', 'native_target_changed', 'native_binding'],
  ];
  for (const [backend, throwAt, code, stage] of cases) {
    const r = driver({ case: 'run', backend, world: { throwAt } });
    assert.equal(r.error, 'native_write_unknown', `${backend} ${throwAt}: ${JSON.stringify(r)}`);
    assert.equal(r.inputDelivery, 'unknown', `${backend} ${throwAt}`); assert.equal(r.noRetry, true);
    assert.equal(r.focusOriginalError, code); assert.equal(r.focusOriginalStage, stage); assert.equal(r.focusDriver, backend);
  }
  const repair = driver({ case: 'run', backend: 'skylight', world: { coverage: ['normal'], throwAt: 'coverage' } });
  assert.equal(repair.error, 'native_write_unknown'); assert.equal(repair.focusOriginalError, 'native_focus_unknown'); assert.equal(repair.inputDelivery, 'unknown');
  const rewrite = driver({ case: 'run', backend: 'skylight', world: { coverage: ['normal'], throwAt: 'reraiseWrite' } });
  assert.equal(rewrite.error, 'native_write_unknown'); assert.equal(rewrite.inputDelivery, 'unknown'); assert.equal(rewrite.focusOriginalStage, 'activate_reraise');
});
check('new', 'r2.5 a Stop after the landed point keeps its identity, and the ledger is unknown + noRetry', () => {
  const r = driver({ case: 'run', backend: 'skylight', world: { throwAt: 'stop' } });
  assert.equal(r.thrown, 'FixtureStop'); assert.equal(r.inputDelivery, 'unknown'); assert.equal(r.noRetry, true);
  assert.deepEqual(writes(r), ['activate_front_key', 'activate_raise']);
});
check('new', 'r2.5 before the landed point nothing is re-wrapped: a failing activate_front write stays its own native_write_unknown', () => {
  const r = driver({ case: 'run', backend: 'carbon', world: { carbonStatus: -600 } });
  assert.equal(r.error, 'native_write_unknown'); assert.equal(r.stage, 'activate_front'); assert.equal('focusOriginalError' in r, false);
});

/* ------------------------------------------------ the repair */
const reraises = r => r.log.filter(e => e.what === 'write:activate_reraise');
check('new', 'repair: Chrome order passes while a foreign layer-0 window covers -> held to the first sample >= 150 ms, then one AXRaise', () => {
  const r = driver({ case: 'run', backend: 'skylight', world: { coverage: [...Array(20).fill('normal'), 'none'] } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(writes(r), ['activate_front_key', 'activate_raise', 'activate_reraise']);
  assert.equal(reraises(r).length, 1);
  const t0 = r.log.find(e => e.what === 'child').at;
  assert.ok(reraises(r)[0].at - t0 >= 150, `re-raise at ${reraises(r)[0].at - t0} ms after the child started`);
  assert.equal(r.focusReraised, true);
  const before = r.log.slice(0, r.log.findIndex(e => e.what === 'write:activate_reraise')).map(e => e.what);
  assert.deepEqual(before.slice(-6), ['coverage:normal', 'tabActive:true', 'sample', 'coverage:normal', 'tabActive:true', 'prepare:activate_reraise'],
    'all four facts are read again right before the write');
});
check('new', 'repair at most once: coverage that stays after the AXRaise does not raise again', () => {
  const r = driver({ case: 'run', backend: 'skylight', world: { coverage: ['normal'] } });
  assert.equal(reraises(r).length, 1); assert.equal(r.ok, true);
});
check('new', 'repair never for a floating blocker, never without coverage: the first passing sample ends the settle', () => {
  for (const coverage of ['floating', 'none']) {
    const r = driver({ case: 'run', backend: 'skylight', world: { coverage: [coverage] } });
    assert.equal(r.ok, true); assert.deepEqual(writes(r), ['activate_front_key', 'activate_raise'], coverage);
    assert.equal(r.focusReraised, false);
    assert.ok(r.elapsedMs < 150, `${coverage}: not held to 150 ms (${r.elapsedMs})`);
  }
  // Key only from the decision sample (about 169 ms) on, a floating blocker over the target: still no repair.
  const late = driver({ case: 'run', backend: 'skylight', world: { coverage: ['floating'], samples: [...Array(6).fill({ key: false }), {}] } });
  assert.equal(late.ok, true); assert.equal(reraises(late).length, 0, JSON.stringify(effects(late).slice(-6)));
  assert.ok(effects(late).includes('coverage:floating'), 'the decision read the floating coverage');
});
check('new', 'repair withheld when a fact fails at the decision or at the re-read', () => {
  for (const [name, world] of [
    ['wrong tab', { coverage: ['normal'], tabActive: [false] }],
    ['Chrome not front at the decision', { coverage: ['normal'], late: { afterMs: 150, sample: { front: 77, onTop: false } } }],
    ['not key at the decision', { coverage: ['normal'], late: { afterMs: 150, sample: { key: false } } }],
    // Fake clock: six passing samples are held before 150 ms; the 7th read decides, the 8th is the re-read.
    ['coverage gone at the re-read', { coverage: [...Array(7).fill('normal'), 'none'] }],
  ]) {
    const r = driver({ case: 'run', backend: 'skylight', world });
    assert.equal(reraises(r).length, 0, `${name}: ${JSON.stringify(effects(r).slice(-8))}`);
    if (name === 'coverage gone at the re-read') assert.match(effects(r).join(','), /coverage:normal,tabActive:true,sample,coverage:none/);
  }
});
check('new', 'repair off (arm S): no hold, no coverage scan, no re-raise', () => {
  const r = driver({ case: 'run', backend: 'skylight', reraise: false, world: { coverage: ['normal'] } });
  assert.equal(r.ok, true); assert.deepEqual(writes(r), ['activate_front_key', 'activate_raise']);
  assert.equal(effects(r).some(e => e.startsWith('coverage')), false); assert.equal('focusReraised' in r, false);
});

/* ------------------------------------------------ the separate coverage scan */
const T = { pid: 42, id: 10, bounds: [100, 100, 800, 600] };
check('new', 'regression: Chrome\'s own order passes (focusOrder onTop) while a foreign window still covers -> coverage normal', () => {
  assert.ok(focusOrder, 'focusOrder extracted from Owner.focus');
  const r = driver({ case: 'coverage', order: true, rows: [{ pid: 300, id: 50, bounds: [300, 300, 400, 300], name: 'Decoy' }, T, { pid: 42, id: 11, bounds: [0, 0, 900, 700] }] });
  assert.equal(r.chromeOrderOnTop, true, 'focusOrder alone accepts this scene (unchanged semantics)');
  assert.equal(r.coverage, 'normal');
});
check('new', 'coverage scan: floating wins; own pid, Chrome, below-target, transparent, tiny, unnamed, menu-bar and touching windows do not count', () => {
  const cov = rows => driver({ case: 'coverage', rows }).coverage;
  assert.equal(cov([{ pid: 300, id: 51, layer: 3, bounds: [200, 200, 100, 100] }, { pid: 301, id: 52, bounds: [200, 200, 300, 300] }, T]), 'floating');
  assert.equal(cov([{ pid: 999, id: 53, layer: 0, bounds: [0, 0, 2000, 2000] }, T]), 'none', "this helper's own veil");
  assert.equal(cov([{ pid: 42, id: 11, bounds: [100, 100, 800, 600] }, T]), 'none', "Chrome's own windows are focusOrder's");
  assert.equal(cov([T, { pid: 300, id: 50, bounds: [100, 100, 800, 600] }]), 'none', 'below the target');
  assert.equal(cov([{ pid: 300, id: 50, alpha: 0.01, bounds: [100, 100, 800, 600] }, T]), 'none', 'transparent');
  assert.equal(cov([{ pid: 300, id: 50, bounds: [300, 300, 1, 1] }, T]), 'none', 'tiny');
  assert.equal(cov([{ pid: 300, id: 50, name: null, bounds: [300, 300, 100, 100] }, T]), 'none', 'unnamed');
  assert.equal(cov([{ pid: 300, id: 50, name: 'Window Server', bounds: [300, 300, 100, 100] }, T]), 'none');
  assert.equal(cov([{ pid: 300, id: 50, layer: 25, bounds: [0, 0, 2000, 25] }, T]), 'none', 'menu bar layer');
  assert.equal(cov([{ pid: 300, id: 50, bounds: [900, 100, 100, 100] }, T]), 'none', 'touching edge, no area');
  assert.equal(cov([{ pid: 300, id: 50, bounds: [300, 300, 100, 100] }]), 'none', 'target not on screen');
});

/* ------------------------------------------------ flag parsing and symbols */
check('new', 'intent: only an exact skylight/carbon asks for a backend; carbon flag 1|3 (default 3); probe knobs', () => {
  assert.deepEqual(driver({ case: 'request', intent: { kind: 'activate' } }), { legacy: true });
  for (const v of ['legacy', 'SkyLight', 'bogus', '', 1]) assert.deepEqual(driver({ case: 'request', intent: { focusBackend: v } }), { legacy: true }, String(v));
  assert.deepEqual(driver({ case: 'request', intent: { focusBackend: 'skylight' } }), { backend: 'skylight', carbonFlag: 3, reraise: true, record: true });
  assert.deepEqual(driver({ case: 'request', intent: { focusBackend: 'skylight', focusReraise: false, focusRecord: false } }), { backend: 'skylight', carbonFlag: 3, reraise: false, record: false });
  assert.deepEqual(driver({ case: 'request', intent: { focusBackend: 'carbon', carbonFlag: 1 } }), { backend: 'carbon', carbonFlag: 1, reraise: true, record: true });
  assert.deepEqual(driver({ case: 'request', intent: { focusBackend: 'carbon', carbonFlag: 7 } }).carbonFlag, 3);
});
check('new', 'symbols: either backend needs all of its symbols (a missing one selects legacy)', () => {
  assert.deepEqual(driver({ case: 'symbols' }), { GetProcessForPID: true, _SLPSSetFrontProcessWithOptions: true, SLPSPostEventRecordTo: true,
    SetFrontProcessWithOptions: true, skylight: true, carbon: true });
  const r = driver({ case: 'symbols', missing: ['SLPSPostEventRecordTo'] }); assert.equal(r.skylight, false); assert.equal(r.carbon, true);
  const g = driver({ case: 'symbols', missing: ['GetProcessForPID'] }); assert.equal(g.skylight, false); assert.equal(g.carbon, false);
});
check('new', 'Owner.execute enters the backend right after activate_index, inside #if MYCHROME_FOCUS_BACKENDS, before any legacy read', () => {
  // FOCUS4: the fallback continues into legacy's AX-optional assistance (axAssistWindow), not a mandatory exactWindow.
  const m = native.match(/stage: "activate_index", tx: tx\)\n(\s+)#if MYCHROME_FOCUS_BACKENDS\n[^\n]*\n\s+if let result = try activateBackend\(t, before: row, intent: intent, plan: geometryPlan, tx: tx\) \{ return result \}\n\s+#endif\n(?:\s+\/\/[^\n]*\n)*\s+if let ax = try axAssistWindow\(t, access: probe\(\)\)/);
  assert.ok(m, 'dispatch block');
  const glue = native.slice(native.indexOf('    func activateBackend('));
  assert.match(glue.split('\n').slice(0, 8).join('\n'), /guard let request = Focus\.request\(intent\) else \{ return nil \}/,
    'no request = nil before any effect');
});

/* ------------------------------------------------ the helper: child mode and the doctor symbol line */
check('new', 'helper.swift dispatches `focus-front` to Focus.childMain and `trust` reports focusSymbols; bin/cgevent obeys (usage path only)', () => {
  const helper = fs.readFileSync(process.env.HELPER_SOURCE || path.join(ROOT, 'src/helper.swift'), 'utf8');
  assert.match(helper, /\ncase "focus-front":\n(?:\s*\/\/[^\n]*\n)*\s+ChromeNative\.Focus\.childMain\(args\)\n/);
  assert.match(helper, /case "trust":[\s\S]{0,900}"focusSymbols": ChromeNative\.Focus\.symbolReport\(\)/);
  const bin = path.join(ROOT, 'bin/cgevent');
  if (!fs.existsSync(bin)) return console.log('        (bin/cgevent not built; source checks only)');
  // pid 0 is refused before NSApplication, dlsym or any private call.
  const usage = run(bin, ['focus-front', '--pid', '0', '--wid', '0']);
  assert.equal(usage.status, 2); assert.deepEqual(JSON.parse(usage.stdout), { exit: 2, focusFront: 1, stage: 'usage' });
  const trust = JSON.parse(run(bin, ['trust']).stdout);
  for (const k of ['GetProcessForPID', '_SLPSSetFrontProcessWithOptions', 'SLPSPostEventRecordTo', 'SetFrontProcessWithOptions', 'skylight', 'carbon'])
    assert.equal(typeof trust.focusSymbols?.[k], 'boolean', k);
});

/* ------------------------------------------------ kept: legacy */
// FOCUS4 changed legacy on purpose (the activate case: AX-optional assistance and the Apple Event fallback; the tail's
// verdict; settleFocus's end condition), pinned behaviourally by window-visibility-native and focus-destination. Every
// other part of Owner.execute, executeDry, focus, activateApp and awaitFront stays byte-identical to 0bff57b.
check('kept', 'legacy: Owner.execute outside FOCUS2\'s block and FOCUS4\'s activate case and verdict is byte-identical to 0bff57b, dry activate unchanged', () => {
  let base;
  try { base = execFileSync('git', ['-C', ROOT, 'show', '0bff57b:src/native-chrome.swift'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return console.log('        (0bff57b not in this checkout; skipped)'); }
  const execute = text => { const a = text.indexOf('        func execute(_ intent:'); return text.slice(a, text.indexOf('\n        }\n', a)); };
  const outside = text => {
    const cut = (t, from, to) => { const a = t.indexOf(from), b = t.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return t.slice(0, a) + t.slice(b); };
    let t = execute(text).replace(/\n\s+#if MYCHROME_FOCUS_BACKENDS\n[\s\S]*?\n\s+#endif/, '').replace('\n            var axWindowMissing = false', '');
    t = cut(t, '            case "activate":', '            default: throw Failure("native_request_invalid", "native_dispatch")');
    const tail = t.search(/\n {12}(?:let|var) focusState = /);
    assert.ok(tail > 0, 'the focus tail'); return t.slice(0, tail);
  };
  assert.equal(outside(native), outside(base));
  const dry = text => { const a = text.indexOf('        func executeDry('); return text.slice(a, text.indexOf('\n        }\n', a)); };
  assert.equal(dry(native), dry(base));
  for (const name of ['func focus(_ t: Target', 'func activateApp(', 'func awaitFront(']) {
    const block = text => { const a = text.indexOf(name); return text.slice(a, text.indexOf('\n        }\n', a)); };
    assert.equal(block(native), block(base), name);
  }
  const settle = text => { const a = text.indexOf('func settleFocus('); return text.slice(a, text.indexOf('\n        }\n', a)); };
  assert.equal(settle(native).replace('if let sample = last, sample.0 { return sample }', 'if let sample = last, sample.0 && sample.1 { return sample }'),
    settle(base), 'settleFocus: only its end condition changed (FOCUS4: the AX key window is never waited for)');
});
check('kept', 'legacy: Transaction.result adds no key while facts are empty', () => {
  const r = driver({ case: 'run', backend: 'skylight', world: { symbols: false } });
  assert.deepEqual(Object.keys(r).filter(k => !['log', 'elapsedMs'].includes(k)).sort(),
    ['fallback', 'focusDriver', 'focusFallback', 'focusRequested', 'inputDelivery', 'operationId', 'stages']);
  const base = native.slice(native.indexOf('        func result(_ value: [String: Any]) -> [String: Any] {'));
  assert.match(base, /for \(key, value\) in facts where r\[key\] == nil \{ r\[key\] = value \}/);
});

console.log(`${passed} passed, ${failed} failed (group ${GROUP}). Artifacts: ${tmp}`);
process.exitCode = failed ? 1 : 0;
