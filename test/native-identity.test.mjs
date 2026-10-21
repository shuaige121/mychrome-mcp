/* Production identity decision against synthetic application metadata.
 * No running applications, browser, Accessibility, or input devices are accessed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const swift = fs.readFileSync(process.env.CHROMECTL_SOURCE || new URL('../src/chromectl.swift', import.meta.url), 'utf8');
function productionBlock(prefix) {
  const start = swift.indexOf(prefix);
  assert.ok(start >= 0, prefix);
  return swift.slice(start, swift.indexOf('\n}', start) + 2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-native-identity-'));
const program = `
import Foundation
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
var workspaceReads = 0
final class NSRunningApplication {
    let processIdentifier: pid_t
    let bundleIdentifier: String?
    let isTerminated: Bool
    init(_ row: [String: Any]) {
        processIdentifier = pid_t(row["pid"] as? Int ?? 7)
        bundleIdentifier = row["bundle"] as? String
        isTerminated = row["terminated"] as? Bool ?? false
    }
    convenience init?(processIdentifier: pid_t) {
        guard let row = fixture["direct"] as? [String: Any] else { return nil }
        self.init(row)
    }
}
final class NSWorkspace {
    static let shared = NSWorkspace()
    var runningApplications: [NSRunningApplication] {
        workspaceReads += 1
        return (fixture["workspace"] as? [[String: Any]] ?? []).map { NSRunningApplication($0) }
    }
}
${productionBlock('struct NativeInputProbeError:')}
${productionBlock('func nativeChromeIdentity(')}
var result: [String: Any]
do { result = ["ok": true, "source": try nativeChromeIdentity(pid: 7)] }
catch let error as NativeInputProbeError {
    result = ["ok": false, "error": error.code].merging(error.details) { first, _ in first }
}
result["workspaceReads"] = workspaceReads
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`;
let passed = 0;
try {
  const source = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'identity');
  fs.writeFileSync(source, program);
  execFileSync('/usr/bin/swiftc', [source, '-o', binary], { stdio: 'pipe' });
  const chrome = { pid: 7, bundle: 'com.google.Chrome', terminated: false };
  const run = fixture => {
    const r = spawnSync(binary, [JSON.stringify(fixture)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  for (const [name, fixture, source] of [
    ['verified direct identity needs no alternate lookup', { direct: chrome }, 'direct'],
    ['missing direct object is corroborated by same-PID workspace identity', { workspace: [chrome] }, 'workspace'],
    ['missing direct bundle is corroborated', { direct: { pid: 7 }, workspace: [chrome] }, 'workspace'],
    ['empty direct bundle is corroborated', { direct: { pid: 7, bundle: '' }, workspace: [chrome] }, 'workspace'],
  ]) {
    const r = run(fixture);
    assert.deepEqual(r, { ok: true, source, workspaceReads: source === 'direct' ? 0 : 1 }, name);
    passed++; console.log(`  ok  ${name}`);
  }
  for (const [name, fixture, reason, source] of [
    ['known wrong bundle cannot be overridden', { direct: { ...chrome, bundle: 'com.example.Other' }, workspace: [chrome] }, 'wrong_bundle', 'direct'],
    ['terminated direct process cannot be overridden', { direct: { ...chrome, terminated: true }, workspace: [chrome] }, 'terminated', 'direct'],
    ['direct PID mismatch cannot be overridden', { direct: { ...chrome, pid: 8 }, workspace: [chrome] }, 'pid_mismatch', 'direct'],
    ['missing identity remains blocked', {}, 'identity_unavailable', 'workspace'],
    ['another workspace PID is not accepted', { workspace: [{ ...chrome, pid: 8 }] }, 'identity_unavailable', 'workspace'],
    ['duplicate same-PID records are ambiguous', { workspace: [chrome, chrome] }, 'ambiguous_identity', 'workspace'],
    ['workspace bundle missing remains blocked', { workspace: [{ pid: 7 }] }, 'bundle_missing', 'workspace'],
    ['workspace bundle mismatch remains blocked', { workspace: [{ ...chrome, bundle: 'com.example.Other' }] }, 'wrong_bundle', 'workspace'],
    ['terminated workspace process remains blocked', { workspace: [{ ...chrome, terminated: true }] }, 'terminated', 'workspace'],
  ]) {
    const r = run(fixture);
    assert.equal(r.ok, false, name);
    assert.equal(r.error, 'wrong_app', name);
    assert.equal(r.requestedPid, 7, name);
    assert.equal(r.identityReason, reason, name);
    assert.equal(r.identitySource, source, name);
    assert.equal(r.workspaceReads, source === 'direct' ? 0 : 1, name);
    assert.equal(typeof r.appFound, 'boolean');
    assert.equal(typeof r.bundleMissing, 'boolean');
    assert.equal(typeof r.bundleMatches, 'boolean');
    passed++; console.log(`  ok  ${name}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`native-identity: ${passed} passed`);
