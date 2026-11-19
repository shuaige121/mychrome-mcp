// Production VeilScreen layout in a hidden NSWindow. No screen takeover/input.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bin = fileURLToPath(new URL('../bin/cgevent', import.meta.url));
for (const lang of ['zh', 'en']) {
  const result = JSON.parse(execFileSync(bin, ['veillayout'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, CHROME_BRIDGE_LANG: lang },
  }));
  assert.equal(result.shown, false);
  assert.ok(result.cases.length >= 6);
  assert.deepEqual(result.failures, [], JSON.stringify(result, null, 2));
  assert.equal(result.ok, true);
  console.log(`ok real hidden-window HUD layout: ${lang}, ${result.cases.length} transitions`);
}
