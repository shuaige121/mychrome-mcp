// Real native protocol in DRY-RUN only, with an isolated pasteboard. No UI/input.
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { userStopMessage } from '../src/guard.js';

for (const afterPosted of [1, 2]) {
  const child = spawn(new URL('../bin/cgevent', import.meta.url).pathname, ['session'], {
    env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: 'paste-confirmation', CHROME_BRIDGE_HABITS: 'off',
      CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.paste-progress.${process.pid}.${afterPosted}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 0, stderr = ''; const pending = new Map();
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.stderr.on('data', x => { stderr += x; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const r = JSON.parse(line); pending.get(r.id)?.(r); pending.delete(r.id);
  });
  const send = req => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => reject(Error(`No reply: ${req.op}: ${stderr}`)), 15000);
    pending.set(key, r => { clearTimeout(timer); resolve(r); });
    child.stdin.write(JSON.stringify({ ...req, id: key }) + '\n');
  });
  try {
    const begin = await send({ op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 800, h: 600 },
      veil: { panel: { who: 'test', task: 'test', action: 'test', chars: 5, stages: [{ key: 'type', label: 'Typing', ms: 1000 }] } } });
    assert.equal(begin.dryRun, true);
    const inject = send({ op: '_inject', kind: 'key', afterPosted });
    const r = await send({ op: 'paste', text: 'draft', confirmedProgress: true });
    await inject;
    assert.equal(r.ok, false); assert.equal(r.error, 'interrupted');
    assert.equal(r.postedInput, afterPosted === 1 ? 0 : 1, 'retry evidence still counts V-down only');
    assert.equal(r.pastePosted, afterPosted === 2);
    assert.equal(r.confirmationPending, true);
    assert.deepEqual(r.panel.chars, [0, 5]);
    assert.ok(r.released.includes('cmd'));
    if (afterPosted === 1) {
      assert.equal(r.restored, true); assert.equal(r.pendingRestore, false);
    } else {
      assert.equal(r.pendingRestore, true);
      assert.ok(r.released.includes('key'));
    }
    const receipt = userStopMessage({ steps: [], error: { reply: r } });
    if (afterPosted === 1) assert.match(receipt, /Cmd\+V 尚未发送，没有粘贴文字/);
    else {
      assert.match(receipt, /已发送 Cmd\+V，输入框内容尚未读回确认/);
      assert.doesNotMatch(receipt, /还没有发出任何输入|已确认 5/);
    }
    const restored = await send({ op: 'restoreClipboard' });
    assert.equal(restored.restored, afterPosted === 2, 'restore is deferred only after V-down');
  } finally { child.stdin.end(); await ended; }
}
console.log('paste-progress-native: before/after V-down interruption, truthful receipts and clipboard restore passed');
