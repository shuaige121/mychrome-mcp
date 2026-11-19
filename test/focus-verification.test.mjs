// Production settling logic, fake clock and samples only. Never activates a real app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const swift = fs.readFileSync(new URL('../src/chromectl.swift', import.meta.url), 'utf8');
const start = swift.indexOf('func settleExactFocus(');
assert.ok(start >= 0);
const production = swift.slice(start, swift.indexOf('\n}', start) + 2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-focus-verify-'));
try {
  const source = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'verify');
  fs.writeFileSync(source, `import Foundation
${production}
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
var clock = 0.0, samples = 0
let r = settleExactFocus(pid: 42, cg: fixture["cg"] as? Int, now: { clock }, pause: { clock += $0 }) { remaining in
    assert(remaining > 0 && remaining <= 1)
    samples += 1
    clock += fixture["sampleDuration"] as? Double ?? 0.001
    let ready = samples >= (fixture["readyAt"] as? Int ?? 1)
    return (ready ? fixture["pid"] as? Int ?? 42 : 99,
            fixture["onTop"] as? Bool ?? true, fixture["key"] as? Bool ?? true)
}
print(String(data: try! JSONSerialization.data(withJSONObject: ["ready": r.ready, "pid": r.frontmostPid,
    "onTop": r.onTop, "key": r.key, "waitedMs": r.waitedMs, "samples": samples, "clock": clock]), encoding: .utf8)!)
`);
  execFileSync('/usr/bin/swiftc', [source, '-o', binary], { stdio: 'pipe' });
  const run = fixture => JSON.parse(execFileSync(binary, [JSON.stringify(fixture)], { encoding: 'utf8' }));
  for (const fixture of [{ cg: 7 }, { cg: 7, readyAt: 10 }]) {
    const r = run(fixture);
    assert.equal(r.ready, true);
    assert.equal(r.samples, fixture.readyAt ?? 1);
    assert.ok(r.clock < 1);
  }
  for (const fixture of [{}, { cg: 0 }, { cg: 7, pid: 99 }, { cg: 7, onTop: false },
    { cg: 7, key: false }, { cg: 7, readyAt: 300 }, { cg: 7, sampleDuration: 1.01 }]) {
    const r = run(fixture);
    assert.equal(r.ready, false, JSON.stringify(fixture));
    assert.ok(r.clock <= 1.01);
    if (!fixture.cg) assert.equal(r.samples, 0, 'missing exact CG identity cannot use bounds fallback');
  }
  // Physical adapter must use a CG number, never the bounds-only fallback helper.
  const adapter = swift.slice(swift.indexOf('func waitForExactChromeFocus('), swift.indexOf('// MARK: - Read-only native input probe'));
  assert.match(adapter, /axFocusedExactly/);
  assert.doesNotMatch(adapter, /axFocusedIs\(/);
  console.log('focus-verification: 9 bounded settling cases passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
