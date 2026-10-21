#!/usr/bin/env node
// Screen wake and lock transitions, with an injected clock/display probe.
// No display is slept/woken, no input is posted, and Chrome is never contacted.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureScreenAwake } from '../src/bridge.js';

const awake = { displays: [{ id: 1 }], displaysAsleep: false, locked: false };
const sleeping = { displays: [{ id: 1 }], displaysAsleep: true, locked: true };
const awakeLocked = { ...awake, locked: true };
const unavailable = { displays: [], displaysAsleep: true, locked: false };

function machine(samples, { wakeError = null } = {}) {
  const state = { at: 0, reads: 0, wakes: 0, sleeps: [] };
  const probes = {
    now: () => state.at,
    sleep: async (ms) => { state.sleeps.push(ms); state.at += ms; },
    readDisplays: async () => samples[Math.min(state.reads++, samples.length - 1)],
    wake: async () => { state.wakes++; if (wakeError) throw wakeError; },
  };
  return { state, run: (options = {}) => ensureScreenAwake({ probes, waitMs: 1000, ...options }) };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

await check('awake and unlocked: no wake or delay', async () => {
  const m = machine([awake]);
  assert.deepEqual(await m.run(), { woke: false, displays: 1, locked: false });
  assert.equal(m.state.wakes, 0);
  assert.equal(m.state.at, 0);
});

await check('a sleeping display may remain listed; wait until both display and lock state settle', async () => {
  const m = machine([sleeping, awakeLocked, awakeLocked, awake]);
  assert.deepEqual(await m.run(), { woke: true, displays: 1, locked: false });
  assert.equal(m.state.wakes, 1);
  assert.equal(m.state.reads, 4);
  assert.equal(m.state.at, 600);
});

await check('a stale lock after another caller woke the screen settles without another wake', async () => {
  const m = machine([awakeLocked, awakeLocked, awake]);
  assert.deepEqual(await m.run(), { woke: false, displays: 1, locked: false });
  assert.equal(m.state.wakes, 0);
  assert.equal(m.state.at, 400);
});

await check('an actual locked screen remains locked at the deadline', async () => {
  const m = machine([sleeping, awakeLocked]);
  assert.deepEqual(await m.run(), { woke: true, displays: 1, locked: true });
  assert.equal(m.state.wakes, 1);
  assert.equal(m.state.at, 1000);
});

await check('a still sleeping display is never reported as usable or successfully woken', async () => {
  const m = machine([{ ...sleeping, locked: false }]);
  assert.deepEqual(await m.run(), { woke: false, displays: 0, locked: false });
  assert.equal(m.state.at, 1000);
});

await check('no display cannot become a false ready state', async () => {
  const m = machine([unavailable]);
  assert.deepEqual(await m.run(), { woke: false, displays: 0, locked: false });
  assert.equal(m.state.wakes, 1);
});

await check('the last sleep fits the deadline, including a zero budget', async () => {
  const m = machine([awakeLocked]);
  assert.equal((await m.run({ waitMs: 250 })).locked, true);
  assert.deepEqual(m.state.sleeps, [200, 50]);
  const zero = machine([awakeLocked]);
  assert.equal((await zero.run({ waitMs: 0 })).locked, true);
  assert.equal(zero.state.reads, 1);
});

await check('unknown/malformed state fails closed rather than claiming unlocked', async () => {
  for (const sample of [null, {}, { ...awake, locked: undefined }, { ...awake, displaysAsleep: undefined },
    { ...awake, displays: null }]) {
    const m = machine([sample]);
    await assert.rejects(m.run(), e => e.code === 'screen_state_unknown');
    assert.equal(m.state.wakes, 0);
  }
  const duringWake = machine([sleeping, null]);
  await assert.rejects(duringWake.run(), e => e.code === 'screen_state_unknown');
});

await check('wake failure propagates rather than becoming success', async () => {
  const failure = new Error('wake failed');
  const m = machine([sleeping], { wakeError: failure });
  await assert.rejects(m.run(), e => e === failure);
  assert.equal(m.state.reads, 1);
});

// Compile the real Swift displays command against deterministic CoreGraphics responses. This
// covers active-but-sleeping monitors and unavailable sessions without sleeping the user's Mac.
// The command body is read from production source, not a second implementation of its rules.
const swift = fs.readFileSync(new URL('../src/helper.swift', import.meta.url), 'utf8');
const begin = swift.indexOf('case "displays":\n');
const end = swift.indexOf('\ncase "windowsat":', begin);
assert.ok(begin > 0 && end > begin, 'the production display command must be present');
const displayBody = swift.slice(begin + 'case "displays":\n'.length, end);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-screen-state-'));
try {
  const harness = `
import Foundation
import struct CoreGraphics.CGRect
import struct CoreGraphics.CGPoint
typealias CGDirectDisplayID = UInt32
enum CGError { case success, failure }
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
let rows = fixture["displays"] as? [[String: Any]] ?? []
let archName = "test"
func row(_ id: UInt32) -> [String: Any] { rows[Int(id) - 1] }
func CGGetActiveDisplayList(_ max: UInt32, _ ids: inout [UInt32], _ count: inout UInt32) -> CGError {
    if fixture["displayError"] as? Bool == true { return .failure }
    count = UInt32(min(rows.count, Int(max)))
    for i in 0..<Int(count) { ids[i] = UInt32(i + 1) }
    return .success
}
func CGDisplayBounds(_ id: UInt32) -> CGRect {
    CGRect(x: 0, y: 0, width: row(id)["width"] as? Double ?? 800, height: 600)
}
func CGDisplayIsAsleep(_ id: UInt32) -> UInt32 { row(id)["asleep"] as? Bool == true ? 1 : 0 }
func CGDisplayPixelsWide(_ id: UInt32) -> Int { 1600 }
func CGDisplayPixelsHigh(_ id: UInt32) -> Int { 1200 }
func CGDisplayIsMain(_ id: UInt32) -> UInt32 { id == 1 ? 1 : 0 }
func CGSessionCopyCurrentDictionary() -> Any? { fixture["session"] }
func currentMouse() -> CGPoint { .zero }
func emit(_ value: [String: Any]) {
    print(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
}
func fail(_ code: String, _ message: String) -> Never { emit(["ok": false, "error": code]); exit(1) }
${displayBody}
`;
  const source = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'screen-state');
  fs.writeFileSync(source, harness);
  execFileSync('/usr/bin/swiftc', [source, '-o', binary], { stdio: 'pipe' });
  const session = { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true };
  const displayProbe = (over = {}) => {
    const r = spawnSync(binary, [JSON.stringify({ displays: [{}], session, ...over })], { encoding: 'utf8' });
    assert.equal(r.signal, null, r.stderr);
    return { code: r.status, ...JSON.parse(r.stdout) };
  };

  await check('Swift excludes active-but-asleep and zero-size monitors from usable displays', () => {
    const sleeping = displayProbe({ displays: [{ asleep: true }] });
    assert.equal(sleeping.code, 0);
    assert.equal(sleeping.displaysAsleep, true);
    assert.deepEqual(sleeping.displays, []);
    assert.equal(sleeping.unionPoints, null);
    const mixed = displayProbe({ displays: [{ asleep: true }, {}, { width: 0 }] });
    assert.equal(mixed.displaysAsleep, false);
    assert.deepEqual(mixed.displays.map(d => d.id), [2]);
  });

  await check('Swift preserves real locking, including a locked display that is awake', () => {
    assert.equal(displayProbe().locked, false);
    assert.equal(displayProbe({ session: { ...session, CGSSessionScreenIsLocked: false } }).locked, false);
    assert.equal(displayProbe({ session: { ...session, CGSSessionScreenIsLocked: true } }).locked, true);
    const lockedSleeping = displayProbe({ displays: [{ asleep: true }], session: { ...session, CGSSessionScreenIsLocked: true } });
    assert.equal(lockedSleeping.locked, true);
    assert.equal(lockedSleeping.displaysAsleep, true);
  });

  await check('Swift refuses missing, switched-out, incomplete, and malformed session states', () => {
    for (const bad of [null, {}, { ...session, kCGSSessionOnConsoleKey: false },
      { ...session, kCGSessionLoginDoneKey: false }, { ...session, CGSSessionScreenIsLocked: 'false' }]) {
      const r = displayProbe({ session: bad });
      assert.equal(r.code, 1, JSON.stringify(bad));
      assert.equal(r.error, 'screen_state_unknown');
      assert.equal(r.locked, undefined);
    }
    assert.equal(displayProbe({ displayError: true }).error, 'screen_state_unknown');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} screen-state checks passed.`);
