// Compile the production restore adapter with injected OS replies. No cursor movement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const source = fs.readFileSync(new URL('../src/helper.swift', import.meta.url), 'utf8');
const start = source.indexOf('func restorePointer(');
assert.ok(start >= 0, 'production must read back pointer restoration');
const production = source.slice(start, source.indexOf('\n}', start) + 2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-pointer-restore-'));
const main = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'verify');
fs.writeFileSync(main, `import Foundation
import ApplicationServices
func pointJSON(_ p: CGPoint) -> [String: Double] { ["x": p.x, "y": p.y] }
${production}
let f = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
var calls: [String] = []
let r = restorePointer(to: CGPoint(x: 12, y: 34), warp: { _ in calls.append("warp"); return f["warpFail"] as? Bool == true ? .failure : .success }, associate: { calls.append("associate"); return f["associateFail"] as? Bool == true ? .failure : .success }, read: { calls.append("read"); return f["missing"] as? Bool == true ? nil : CGPoint(x: f["x"] as? Double ?? 12, y: f["y"] as? Double ?? 34) })
print(String(data: try! JSONSerialization.data(withJSONObject: ["result": r, "calls": calls]), encoding: .utf8)!)
`);
execFileSync('/usr/bin/swiftc', [main, '-o', binary], { stdio: 'pipe' });
const run = f => JSON.parse(execFileSync(binary, [JSON.stringify(f)], { encoding: 'utf8' }));
for (const f of [{}, { x: 12.25 }, { warpFail: true }, { associateFail: true }, { missing: true }, { x: 17 }]) {
  const r = run(f), expected = !(f.warpFail || f.associateFail || f.missing || f.x === 17);
  assert.equal(r.result.ok, expected);
  assert.equal(r.result.verified, expected);
  assert.deepEqual(r.calls, ['warp', 'associate', 'read']);
  if (!expected) assert.equal(r.result.error, 'pointer_restore_unconfirmed');
  if (f.x != null) assert.equal(r.result.warped.x, f.x, 'return actual position, never the requested echo');
  if (f.missing) assert.equal(r.result.warped, null);
}
const op = source.slice(source.indexOf('    func opWarp('), source.indexOf('    func opRouted('));
assert.match(op, /restorePointer\(to: p\)/);
assert.match(op, /result\["verified"\]/);
const cli = source.slice(source.indexOf('case "warp":\n'), source.indexOf('case "mousepos":\n'));
assert.match(cli, /restorePointer\(/);
console.log('pointer-restore: OS failures, missing/wrong readback, rounding and adapter wiring passed');
