/* Compile the production Swift lookup helpers against a fake ScriptingBridge.
 * An Apple Event error must not become "tab gone"; no Chrome is contacted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const swift = fs.readFileSync(new URL('../src/chromectl.swift', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = swift.indexOf(`func ${name}(`);
  assert.ok(start >= 0, name);
  return swift.slice(start, swift.indexOf('\n}', start) + 2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-tab-lookup-'));
const program = `
import Foundation
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
final class ErrorCatcher { var last: String?; var lastCode: Int = 0 }
let catcher = ErrorCatcher()
var windowReads = 0, tabReads = 0, collectionSequence = 0
var windowCollections: [Int] = []
func emit(_ obj: [String: Any]) -> Never {
    var result = obj
    result["windowReads"] = windowReads
    result["tabReads"] = tabReads
    result["windowCollections"] = windowCollections
    print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    exit(0)
}
func fail(_ code: String, _ message: String) -> Never { emit(["ok": false, "error": code, "message": message]) }
final class SBObject { let id: Int; init(_ id: Int) { self.id = id } }
final class SBElementArray {
    let kind: String
    let serial: Int
    init(_ kind: String) { self.kind = kind; collectionSequence += 1; serial = collectionSequence }
    func value(forKey key: String) -> Any? {
        if kind == "windows" {
            windowReads += 1
            windowCollections.append(serial)
            if let outcomes = fixture["windowErrors"] as? [Any], windowReads <= outcomes.count,
               let code = outcomes[windowReads - 1] as? Int {
                catcher.last = "The first window lookup failed."
                catcher.lastCode = code
                return nil
            }
            if windowReads == 2 && fixture["nilRetry"] as? Bool == true { return nil }
            if windowReads == 2, let values = fixture["retryWindowIds"] { return values }
        } else { tabReads += 1 }
        if fixture["failAt"] as? String == kind {
            catcher.last = "The Apple Event failed."
            catcher.lastCode = fixture["errorCode"] as? Int ?? -1712
            return nil
        }
        return kind == "windows" ? ["1"] : (fixture["tabIds"] as? [String] ?? ["7"])
    }
    func object(withID id: String) -> Any { SBObject(Int(id)!) }
}
func windows() -> SBElementArray { SBElementArray("windows") }
func tabs(_ window: SBObject) -> SBElementArray { SBElementArray("tabs") }
${['classify', 'check', 'num', 'ids', 'tabLookupWindowIds', 'findTab'].map(productionFunction).join('\n')}
if let (_, _, wid) = findTab(7) { emit(["ok": true, "windowId": wid, "tabId": 7]) }
fail("no_such_tab", "The tab is absent from a successful listing.")
`;
let passed = 0;
try {
  const source = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'tab-lookup');
  fs.writeFileSync(source, program);
  execFileSync('/usr/bin/swiftc', [source, '-o', binary], { stdio: 'pipe' });
  const run = fixture => {
    const r = spawnSync(binary, [JSON.stringify(fixture)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  for (const [name, fixture, error] of [
    ['real tab', {}, null],
    ['genuinely missing tab', { tabIds: ['8'] }, 'no_such_tab'],
    ['window listing timed out', { failAt: 'windows', errorCode: -1712 }, 'chrome_error'],
    ['tab listing timed out', { failAt: 'tabs', errorCode: -1712 }, 'chrome_error'],
    ['missing descriptor during lookup', { failAt: 'tabs', errorCode: -1701 }, 'chrome_error'],
    ['permission denied while listing', { failAt: 'tabs', errorCode: -1743 }, 'no_automation_permission'],
    ['Chrome exited during lookup', { failAt: 'windows', errorCode: -600 }, 'chrome_not_running'],
  ]) {
    const r = run(fixture);
    assert.equal(r.error ?? null, error, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.ok, error == null);
    if (fixture.failAt) {
      assert.equal(r.osStatus, fixture.errorCode, name);
      assert.equal(r.stage, fixture.failAt === 'windows' ? 'find_tab_windows' : 'find_tab_tabs', name);
      assert.match(r.message, /Apple Event 阶段/);
    }
    passed++;
    console.log(`  ok  ${name}`);
  }
  for (const [name, fixture, expected] of [
    ['one failed window descriptor read is refreshed once', { windowErrors: [-1701, null] }, { ok: true, reads: 2 }],
    ['persistent window failure stops after two reads', { windowErrors: [-1701, -1701] }, { ok: false, reads: 2, code: -1701 }],
    ['a permission denial on retry remains a permission denial', { windowErrors: [-1701, -1743] }, { ok: false, reads: 2, code: -1743, error: 'no_automation_permission' }],
    ['a timeout on retry preserves its own status', { windowErrors: [-1701, -1712] }, { ok: false, reads: 2, code: -1712, error: 'chrome_error' }],
    ['Chrome exiting on retry preserves its own status', { windowErrors: [-1701, -600] }, { ok: false, reads: 2, code: -600, error: 'chrome_not_running' }],
    ['a nil retry without an error does not claim an empty collection', { windowErrors: [-1701], nilRetry: true }, { ok: false, reads: 2, code: -1701 }],
    ['malformed retry IDs preserve the original failure', { windowErrors: [-1701], retryWindowIds: ['not-an-id'] }, { ok: false, reads: 2, code: -1701 }],
    ['duplicate retry IDs preserve the original failure', { windowErrors: [-1701], retryWindowIds: ['1', '1'] }, { ok: false, reads: 2, code: -1701 }],
    ['other initial window failures are never retried', { windowErrors: [-1743, null] }, { ok: false, reads: 1, code: -1743 }],
    ['a tab descriptor failure never retries the window command', { failAt: 'tabs', errorCode: -1701 }, { ok: false, reads: 1, code: -1701, stage: 'find_tab_tabs' }],
  ]) {
    const r = run(fixture);
    assert.equal(r.ok, expected.ok, name);
    assert.equal(r.windowReads, expected.reads, name);
    assert.equal(new Set(r.windowCollections).size, expected.reads, `${name}: each read must fetch a fresh collection`);
    if (expected.code) {
      assert.equal(r.osStatus, expected.code, name);
      assert.equal(r.stage, expected.stage || 'find_tab_windows', name);
    }
    if (expected.error) assert.equal(r.error, expected.error, name);
    if (!r.ok && expected.stage !== 'find_tab_tabs') assert.equal(r.tabReads, 0, name);
    passed++;
    console.log(`  ok  ${name}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} tab lookup checks passed.`);
