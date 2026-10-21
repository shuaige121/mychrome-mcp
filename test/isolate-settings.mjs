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
