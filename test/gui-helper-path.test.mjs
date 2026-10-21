import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compile the production path expressions in a tiny Foundation-only executable.
// It prints paths; it never launches the recorder or reads a user's summary.
const root = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(path.join(root, 'src/menubar.swift'), 'utf8');
const slice = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Production section missing: ${start}`);
  return source.slice(from, to);
};
const resolveRealPath = slice('func realPath(', '\n/// The checkout');
const resolveRoot = slice('let ROOT_DIR: String =', '\n/// A server of this checkout');
const resolveHabits = slice('func habitsPath()', '\n/// What the card shows');
const recording = slice('    func startRecording()', '\n    /// SIGTERM:');
const from = recording.indexOf('        let exe =');
const to = recording.indexOf('        let p = Process()', from);
assert.ok(from >= 0 && to > from, 'Recording helper path declaration missing');
const resolveHelper = recording.slice(from, to).trim();
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mychrome-gui-helper-path-'));
const sourceRoot = path.join(tmp, 'source & space');
const cli = path.join(sourceRoot, 'bin', 'probe');
const app = path.join(tmp, 'MyChrome.app', 'Contents');
const bundled = path.join(app, 'MacOS', 'MyChrome');
const env = { ...process.env };
delete env.CHROME_BRIDGE_HABITS;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
try {
  mkdirSync(path.dirname(cli), { recursive: true });
  mkdirSync(path.dirname(bundled), { recursive: true });
  const swift = path.join(tmp, 'probe.swift');
  writeFileSync(swift, `import Foundation\nimport Darwin\n${resolveRealPath}\n${resolveRoot}\n${resolveHabits}\n${resolveHelper}\nlet payload: [String: Any] = ["helper": exe.path, "habits": habitsPath() as Any? ?? NSNull()]\nlet data = try JSONSerialization.data(withJSONObject: payload)\nprint(String(decoding: data, as: UTF8.self))\n`);
  execFileSync('swiftc', ['-o', cli, swift], { timeout: 60_000, stdio: 'pipe' });
  const read = (exe, overrides = {}) => JSON.parse(execFileSync(exe, [], {
    encoding: 'utf8', env: { ...env, ...overrides }, timeout: 5000,
  }));
  const expected = path.join(realpathSync(sourceRoot), 'bin/cgevent');
  assert.equal(read(cli).helper, expected);
  console.log('ok - source CLI resolves cgevent from its installation root');

  copyFileSync(cli, bundled);
  writeFileSync(path.join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>work.mychrome.path-fixture</string><key>CFBundleExecutable</key><string>MyChrome</string><key>CFBundlePackageType</key><string>APPL</string><key>MyChromeSourceRoot</key><string>${xml(sourceRoot)}</string></dict></plist>`);
  assert.equal(read(bundled).helper, expected);
  assert.notEqual(read(bundled).helper, path.join(app, 'MacOS/cgevent'));
  console.log('ok - App bundle uses MyChromeSourceRoot, including spaces and XML-special characters');

  const linked = path.join(tmp, 'linked-probe');
  symlinkSync(cli, linked);
  assert.equal(read(linked).helper, expected);
  console.log('ok - a symlinked source executable retains its installation helper');

  assert.equal(read(bundled).habits, path.join(os.homedir(), 'Library/Application Support/chrome-bridge-mcp/habits.json'));
  assert.equal(read(bundled, { CHROME_BRIDGE_HABITS: '~/custom habits.json' }).habits, path.join(os.homedir(), 'custom habits.json'));
  for (const value of ['off', '0', 'false', 'no', 'none', 'OFF']) {
    assert.equal(read(bundled, { CHROME_BRIDGE_HABITS: value }).habits, null);
  }
  console.log('ok - App bundle preserves the default summary path, explicit override, and disabled modes');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
