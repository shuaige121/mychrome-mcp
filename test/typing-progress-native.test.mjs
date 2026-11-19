// The local helper in DRY-RUN only. No real input or user clipboard.
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const child = spawn(new URL('../bin/cgevent', import.meta.url).pathname, ['session'], {
  env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: 'confirmed-typing', CHROME_BRIDGE_HABITS: 'off',
    CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.progress.${process.pid}` }, stdio: ['pipe', 'pipe', 'pipe'],
});
let id = 0; const pending = new Map();
const ended = new Promise(resolve => child.once('exit', resolve));
let stderr = ''; child.stderr.on('data', x => { stderr += x; });
readline.createInterface({ input: child.stdout }).on('line', line => {
  const r = JSON.parse(line); pending.get(r.id)?.(r); pending.delete(r.id);
});
const send = req => new Promise((resolve, reject) => {
  const key = ++id;
  const timer = setTimeout(() => reject(Error(`helper did not answer ${req.op}: ${stderr}`)), 15000);
  pending.set(key, r => { clearTimeout(timer); resolve(r); });
  child.stdin.write(JSON.stringify({ ...req, id: key }) + '\n');
});
try {
  const begin = await send({ op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 800, h: 600 },
    veil: { panel: { who: 'test', task: 'test', action: 'test', chars: 12, stages: [{ key: 'type', label: 'Typing', ms: 1000 }] } } });
  assert.equal(begin.dryRun, true);
  let r = await send({ op: 'type', text: 'abc', confirmedProgress: true });
  assert.equal(r.typed, 3);
  assert.deepEqual(r.panel.chars, [0, 12], 'posted keys must not increase confirmed progress');
  r = await send({ op: 'panel', confirmedChars: 3, totalChars: 12 });
  assert.deepEqual(r.panel.chars, [3, 12]);
  r = await send({ op: 'paste', text: 'def', confirmedProgress: true });
  assert.deepEqual(r.panel.chars, [3, 12], 'Cmd+V alone is not field confirmation');
  r = await send({ op: 'panel', confirmedChars: 6, totalChars: 12 });
  assert.deepEqual(r.panel.chars, [6, 12]);
  for (const n of [-1, 5, 13, 6.5]) {
    r = await send({ op: 'panel', confirmedChars: n, totalChars: 12 });
    assert.equal(r.ok, false);
    assert.deepEqual(r.panel.chars, [6, 12]);
  }
  r = await send({ op: 'key', name: 'select_all' });
  assert.equal(r.ok, true); assert.equal(r.postedInput, 1);
  r = await send({ op: 'type', text: 'ghi', confirmedProgress: true, continueTyping: true });
  assert.deepEqual(r.panel.chars, [6, 12]);
  r = await send({ op: 'panel', confirmedChars: 9, totalChars: 12 });
  assert.deepEqual(r.panel.chars, [9, 12]);
  const inject = send({ op: '_inject', kind: 'key', afterPosted: 3 });
  r = await send({ op: 'type', text: 'aBc', confirmedProgress: true, continueTyping: true });
  await inject;
  assert.equal(r.ok, false); assert.equal(r.error, 'interrupted');
  assert.equal(r.typed, 1, 'raw delivery count remains available without claiming field confirmation');
  assert.equal(r.confirmationPending, true);
  assert.deepEqual(r.panel.chars, [9, 12]);
  assert.ok(r.released.includes('shift'));
  console.log('typing-progress-native: confirmed-only counters, invalid updates, select_all and partial interruption passed');
} finally { child.stdin.end(); await ended; }
