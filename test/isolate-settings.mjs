/* Imported first by every test that runs src/index.js or src/tabs.js: the owner's panel settings,
 * activity log and live conversation stream must stay outside offline test runs. */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-test-settings-'));
process.env.CHROME_BRIDGE_SETTINGS = path.join(dir, 'settings.json');
process.env.CHROME_BRIDGE_ACTIVITY = path.join(dir, 'activity.jsonl');
process.env.CHROME_BRIDGE_ROUTINE_RECORDING = '0';
// Production can discover the caller's live host from these inherited values.
// Protocol tests supply an explicit fake source instead of joining this session.
for (const name of ['CODEX_THREAD_ID', 'MYCHROME_VISIBLE_THREAD_ID', 'MYCHROME_VISIBLE_SOCKET',
  'CHROME_BRIDGE_INPUT_MODE', 'CHROME_BRIDGE_INPUT_SPEED']) {
  delete process.env[name];
}
// The Claude Code session running the tests passes its identity down (CLAUDE_CODE_SESSION_ID, CLAUDECODE, the kitty
// window, the messaging socket): an in-process server must never bind that real transcript or terminal (SIDEBAR-CC).
for (const name of Object.keys(process.env)) {
  if (/^(CLAUDE_CODE_|KITTY_)/.test(name) || name === 'CLAUDECODE' || name === 'CHROME_BRIDGE_CLAUDE_FEED') delete process.env[name];
}
