#!/usr/bin/env node
// Only CGEVENT_DRYRUN sessions and their private pasteboards. Never install or run real input.
import './isolate-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openInputSession, sessionError } from '../src/bridge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.CGEVENT_BIN || path.join(ROOT, 'bin', 'cgevent');
const BEGIN = { op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, takeover: true, takeoverUntilDone: true };
let serial = 0;
async function open(t, { begin = true, takeover = true } = {}) {
  const s = openInputSession({ bin: BIN, timeoutMs: 10000, env: { ...process.env,
    CGEVENT_DRYRUN: '1', CGEVENT_SEED: 'routine-cancel', CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_INPUT_SPEED: '1',
    CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.routine-cancel.${process.pid}.${++serial}` } });
  t.after(async () => { await s.close(); });
  const reply = await s.request(begin ? { ...BEGIN, takeover } : { op: 'status' }, { raw: true });
  assert.equal(reply.ok, true);
  assert.ok(Array.isArray(reply.posted), 'refuse to continue unless this helper proves DRYRUN');
  if (begin) assert.equal(reply.dryRun, true);
  return s;
}

test('cancel releases only this held session and leaves cleanup available', async t => {
  const s = await open(t);
  const cancelled = await s.request({ op: 'cancel' }, { raw: true });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.takeover.active, false);
  assert.equal(cancelled.takeover.aborted, true);
  assert.equal(cancelled.takeover.abortedBy, 'caller_cancel');
  assert.equal(cancelled.takeover.releasedBy, 'caller_cancel');
  const refused = await s.request({ op: 'key', name: 'return' }, { raw: true });
  assert.equal(refused.error, 'aborted');
  assert.deepEqual(refused.posted, []);
  assert.equal((await s.request({ op: 'warp', to: { x: 10, y: 20 } }, { raw: true })).ok, true);
  assert.equal((await s.request({ op: 'handBack', pid: 99 }, { raw: true })).ok, true);
  assert.equal((await s.close()).reason, 'end');
});

test('priority bridge cancel interrupts long type, balances key releases and preserves clipboard restore', { timeout: 10000 }, async t => {
  const s = await open(t);
  assert.equal(typeof s.cancel, 'function');
  const original = [{ 'public.utf8-plain-text': 'PRIVATE_FIXTURE_CLIPBOARD', 'public.html': '<b>fixture</b>' }];
  await s.request({ op: '_pb', set: original }, { raw: true });
  assert.equal((await s.request({ op: 'paste', text: 'temporary fixture' }, { raw: true })).pendingRestore, true);
  // Existing DRYRUN notification fires after Shift-down and the first A-down.
  const keyDownObserved = s.request({ op: '_fake', afterPosted: 2 }, { raw: true });
  const text = 'A'.repeat(300);
  const typing = s.request({ op: 'type', text, firstDelay: false }, { raw: true, timeoutMs: 5000 });
  await keyDownObserved;
  const before = performance.now();
  const [cancelled, again] = await Promise.all([s.cancel(), s.cancel()]);
  const cancelMs = performance.now() - before;
  assert.equal(cancelled.ok, true);
  assert.deepEqual(again, cancelled);
  assert.ok(cancelMs < 1500, 'cancel must not wait for the long type to finish');
  const result = await typing;
  assert.equal(result.error, 'aborted');
  assert.equal(result.takeover.abortedBy, 'caller_cancel');
  assert.ok(result.typed >= 1 && result.typed < text.length, `only part of the text was sent: ${result.typed}`);
  const balance = new Map();
  for (const e of result.posted) if (e.type === 'keyDown' || e.type === 'keyUp') balance.set(e.key, (balance.get(e.key) ?? 0) + (e.type === 'keyDown' ? 1 : -1));
  assert.ok(balance.size > 0);
  assert.ok([...balance.values()].every(n => n === 0), 'every keyDown has a matching keyUp');
  assert.deepEqual(result.posted.filter(e => e.type === 'flagsChanged').at(-1)?.flags, []);
  t.diagnostic(`cancel acknowledged in ${Math.round(cancelMs)} ms; typed ${result.typed}/${text.length}; key releases balanced`);
  assert.equal((await s.request({ op: 'restoreClipboard' }, { raw: true })).restored, true);
  assert.deepEqual((await s.request({ op: '_pb' }, { raw: true })).items, original);
  const status = await s.request({ op: 'status' }, { raw: true });
  assert.equal(status.takeover.abortedBy, 'caller_cancel');
  assert.equal((await s.close()).reason, 'end');
});

test('cancel before begin cannot acquire a hold or send later input', async t => {
  const s = await open(t, { begin: false });
  const cancelled = await s.cancel();
  assert.equal(cancelled.ok, true);
  const begun = await s.request(BEGIN, { raw: true });
  assert.equal(begun.ok, false);
  assert.equal(begun.error, 'aborted');
  assert.equal(begun.takeover.active, false);
  const hold = await s.request({ op: 'hold', takeoverUntilDone: true }, { raw: true });
  assert.equal(hold.ok, false);
  assert.equal(hold.takeover.active, false);
  assert.deepEqual(hold.posted, []);
});

test('a navigation observer refuses cancel and remains read-only and usable', async t => {
  const s = await open(t, { begin: false });
  const start = await s.request({ op: 'watchNavigation', maxMs: 10000 });
  assert.equal(start.readOnly, true);
  const cancelled = await s.cancel();
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error, 'observer_read_only');
  const state = await s.request({ op: 'navigationState', chromePid: 42, window: 7, since: start.startedAt });
  assert.equal(state.known, true);
  assert.equal(state.untouched, true);
  const type = await s.request({ op: 'type', text: 'not sent' }, { raw: true });
  assert.equal(type.error, 'observer_read_only');
  assert.deepEqual(type.posted, []);
});

test('cancel preserves an earlier native failure and never cancels another session', async t => {
  const one = await open(t), two = await open(t);
  await one.request({ op: '_inject', kind: 'tapDisabled', reason: 'timeout' }, { raw: true });
  const result = await one.cancel();
  assert.equal(result.takeover.abortedBy, 'tap_disabled');
  assert.equal(result.takeover.releasedBy, 'tap_disabled');
  const other = await two.request({ op: 'status' }, { raw: true });
  assert.equal(other.takeover.active, true);
  assert.equal(other.takeover.aborted, false);
  assert.equal((await two.request({ op: 'type', text: 'ok' }, { raw: true })).typed, 2);
});

test('caller cancellation maps onto existing user_cancelled cleanup semantics', () => {
  const reply = { ok: false, error: 'aborted', takeover: { active: false, aborted: true, abortedBy: 'caller_cancel' } };
  const e = sessionError(reply);
  assert.equal(e.code, 'user_cancelled');
  assert.equal(e.reply, reply);
  assert.match(e.message, /停止/);
  assert.ok(!/Esc|超时|最长时限/.test(e.message));
});

test('cancel keeps an earlier Esc reason while its key-up release was pending', async t => {
  const s = await open(t);
  await s.request({ op: '_inject', kind: 'esc' }, { raw: true });
  const pending = await s.request({ op: '_inject', kind: 'esc' }, { raw: true });
  assert.equal(pending.takeover.active, true);
  assert.equal(pending.takeover.abortedBy, 'esc');
  const cancelled = await s.cancel();
  assert.equal(cancelled.takeover.active, false);
  assert.equal(cancelled.takeover.abortedBy, 'esc');
  assert.equal(cancelled.takeover.releasedBy, 'esc');
});

test('an older helper returning unsupported is not reported as successfully cancelled', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'routine-old-cancel-'));
  const bin = path.join(dir, 'helper.mjs');
  await writeFile(bin, '#!/usr/bin/env node\nimport readline from "node:readline";readline.createInterface({input:process.stdin}).on("line",line=>{const q=JSON.parse(line);console.log(JSON.stringify({id:q.id,op:q.op,ok:q.op==="end",error:q.op==="end"?undefined:"bad_request"}));if(q.op==="end")process.exit(0);});\n', { mode: 0o700 });
  const s = openInputSession({ bin, timeoutMs: 1000 });
  t.after(async () => { await s.close(); });
  assert.equal((await s.cancel()).ok, false);
  assert.equal((await s.cancel()).error, 'bad_request');
});
