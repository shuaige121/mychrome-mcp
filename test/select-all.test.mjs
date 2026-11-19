// Native session in dry-run only. No keyboard/mouse input or user clipboard is touched.
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const bin = new URL('../bin/cgevent', import.meta.url).pathname;
let serial = 0;
async function session(test) {
  const child = spawn(bin, ['session'], { env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_SEED: 'select-all',
    CHROME_BRIDGE_HABITS: 'off', CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.selectall.${process.pid}.${++serial}` }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0;
  const ended = new Promise(resolve => child.once('exit', resolve));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id);
  });
  const send = req => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => reject(new Error(`No reply: ${req.op}`)), 15000);
    pending.set(key, r => { clearTimeout(timer); resolve(r); });
    child.stdin.write(JSON.stringify({ ...req, id: key }) + '\n');
  });
  try {
    const begin = await send({ op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 800, h: 600 }, rateMs: 2 });
    assert.equal(begin.dryRun, true, 'refuse any non-dry session');
    assert.equal(begin.ok, true);
    await test(send);
  } finally { child.stdin.end(); await ended; }
}
await session(async send => {
  const r = await send({ op: 'key', name: 'select_all' });
  assert.equal(r.ok, true);
  assert.equal(r.postedInput, 1);
  assert.deepEqual(r.posted.map(x => [x.type, x.key, x.flags]), [
    ['flagsChanged', 55, ['cmd']], ['keyDown', 0, ['cmd']], ['keyUp', 0, ['cmd']], ['flagsChanged', 55, []],
  ]);
  assert.ok(r.posted.every(x => !Object.hasOwn(x, 'unicode')));
  const next = await send({ op: 'key', name: 'space' });
  assert.equal(next.ok, true);
  assert.deepEqual(next.posted.find(x => x.type === 'keyDown').flags, []);
});
await session(async send => {
  await send({ op: '_fake', frontPid: 99 });
  const r = await send({ op: 'key', name: 'select_all' });
  assert.equal(r.ok, false);
  assert.equal(r.postedInput, 0);
  assert.deepEqual(r.posted, []);
});
for (const afterPosted of [1, 2]) await session(async send => {
  const inject = send({ op: '_inject', kind: 'key', afterPosted });
  const r = await send({ op: 'key', name: 'select_all' });
  await inject;
  assert.equal(r.ok, false);
  assert.equal(r.postedInput, afterPosted === 2 ? 1 : 0);
  assert.ok(r.released.includes('cmd'));
  assert.deepEqual(r.posted.at(-1).flags, []);
  if (afterPosted === 2) assert.ok(r.released.includes('key'));
  assert.ok(r.posted.every(x => x.key !== 51), 'never sends Delete');
});
console.log('select-all: dry-run sequence, guard and interruption release checks passed');
