#!/usr/bin/env node
/* R-keys: held keys are named by the keyboard layout (ANSI fallback). Dry-run helper only
 * (CGEVENT_DRYRUN=1 posts nothing; `_fake` layout seam); no CGEvent, no tap, no Chrome. */
import './isolate-settings.mjs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { sessionError, BridgeError } from '../src/bridge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.CGEVENT_BIN || path.join(HERE, '..', 'bin', 'cgevent');
const index = fs.readFileSync(path.join(HERE, '..', 'src', 'index.js'), 'utf8');
const swift = fs.readFileSync(path.join(HERE, '..', 'src', 'helper.swift'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`); }
}
let pb = 0;

/** The production path: helper dry session `begin takeover` with fake held keys → reply → sessionError. */
async function refusal(heldKeys, fake = {}) {
  const child = spawn(BIN, ['session'], {
    env: { ...process.env, CGEVENT_DRYRUN: '1', CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.keys${process.pid}.${++pb}` },
    stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', l => lines.push(JSON.parse(l)));
  const done = new Promise(res => child.on('exit', res));
  child.stdin.write(JSON.stringify({ op: '_fake', heldKeys, ...fake, id: 1 }) + '\n' +
    JSON.stringify({ op: 'begin', chromePid: 42, window: 7, windowBounds: { x: 0, y: 0, w: 1200, h: 800 }, takeover: true, id: 2 }) + '\n{"op":"end"}\n');
  await Promise.race([done, sleep(15000).then(() => { child.kill('SIGKILL'); throw new Error('no exit'); })]);
  const b = lines.find(l => l.id === 2);
  assert.equal(b.error, 'input_held', JSON.stringify(b));
  return { reply: b, err: sessionError(b) };
}

console.log('new fix: layout names');
await check('explicit layout: keycodes are named by the injected layout (Dvorak-like, uppercase)', async () => {
  const { reply } = await refusal([0, 1], { layout: { 0: 'a', 1: 'o' } });
  assert.equal(reply.message, 'held: A、O');
});
await check('a printable punctuation result is kept as the name (Dvorak keycode 12 is ")', async () => {
  const { reply } = await refusal([12, 18], { layout: { 12: "'", 18: '&' } });
  assert.equal(reply.message, "held: '、&");
});
await check('empty, whitespace, control, multi-char or missing (translate error) results fall back to ANSI', async () => {
  const { reply } = await refusal([0, 1, 2, 3, 4, 12], { layout: { 0: '', 1: ' ', 2: '\u0001', 3: 'ab', 4: '\u00a0' } });
  assert.equal(reply.message, 'held: A、S、D、F、H、Q');
});
await check('explicit non-Latin layout: keycode 0 -> its letter, in the refusal text', async () => {
  const { err } = await refusal([0], { layout: { 0: 'ф' } });
  assert.match(err.message, /「Ф」正被按着/);
  assert.doesNotMatch(err.message, /键码/);
});
await check('digits come from the layout too', async () => {
  const { reply } = await refusal([18, 19], { layout: { 18: '1', 19: '٢' } });
  assert.equal(reply.message, 'held: 1、٢');
});
await check('fallback: layout data unavailable -> ANSI table', async () => {
  const { reply } = await refusal([0, 1, 18, 46], { layoutUnreadable: true, layout: { 0: 'x' } });
  assert.equal(reply.message, 'held: A、S、1、M');
});
await check('keycode 0 end to end (production heldKeyName + dry session + sessionError) names A, never 键码 0', async () => {
  for (const fake of [{ layout: { 0: 'a' } }, { layoutUnreadable: true }]) {
    const { err } = await refusal([0], fake);
    assert.match(err.message, /「A」正被按着/, JSON.stringify(fake));
    assert.doesNotMatch(err.message, /键码 0/);
  }
});
await check('keycode 0 with the machine\'s real layout (no seam): one printable non-space character (or the ANSI name), not 键码 0', async () => {
  const { reply } = await refusal([0]);
  assert.match(reply.message, /^held: [^\p{C}\p{Z}\s]$/u, reply.message);
});
await check('an unknown key code still reads 键码 N', async () => {
  const { reply } = await refusal([122, 0], { layoutUnreadable: true });
  assert.equal(reply.message, 'held: 键码 122、A');
});

console.log('kept behaviour: modifier and mouse names');
const MODS = { 55: '左 ⌘', 54: '右 ⌘', 56: '左 ⇧', 60: '右 ⇧', 58: '左 ⌥', 61: '右 ⌥', 59: '左 ⌃', 62: '右 ⌃', 63: 'fn', 36: '回车', 49: '空格', 53: 'Esc', 48: 'Tab', 51: '删除' };
await check('modifier / named keys keep their exact names, even if the layout would say otherwise', async () => {
  const codes = Object.keys(MODS).map(Number);
  const layout = Object.fromEntries(codes.map(k => [k, 'x']));
  for (const fake of [{ layout }, { layoutUnreadable: true }]) {
    const { reply } = await refusal(codes, fake);
    assert.equal(reply.message, 'held: ' + codes.map(k => MODS[k]).join('、'));
  }
});
await check('mouse names are unchanged in the helper source', () => {
  assert.ok(swift.includes('b == 0 ? "鼠标左键" : b == 1 ? "鼠标右键" : "鼠标键 \\(b + 1)"'));
});
const noRepeat = new RegExp(/const NO_REPEAT = \/(.*)\/;/.exec(index)[1]);
await check('index.js classifies by those names: modifiers/fn/mouse are NO_REPEAT, layout letters are not', () => {
  for (const n of ['左 ⌘', '右 ⇧', '左 ⌥', '右 ⌃', 'fn', '鼠标左键', '鼠标右键', '鼠标键 3']) assert.ok(noRepeat.test(n), n);
  for (const n of ['A', 'Ф', '1', '回车', '键码 122']) assert.ok(!noRepeat.test(n), n);
});

console.log('new fix: input_stuck receipt');
function fnSrc(name) {
  const s = index.search(new RegExp(`async function ${name}\\(`));
  return index.slice(s, index.indexOf('\n}', s) + 2);
}
async function hands(held, keyIdle, maxWaitMs = 60_000) {
  let now = 1_000_000;
  const c = vm.createContext({ Date: { now: () => now }, Number, Math, BridgeError, OWN_INPUT_END: 0, STUCK_KEY_S: 30,
    NO_REPEAT: noRepeat, userIdleS: () => 1.5, USER_IDLE_MAX_WAIT_MS: maxWaitMs,
    cancelledError: () => new BridgeError('cancelled', 'cancelled'),
    B: { cgevent: async () => ({ keyIdle, held }) }, sleep: async ms => { now += ms; } });
  vm.runInContext(fnSrc('waitForHandsOff'), c);
  return c.waitForHandsOff().then(() => null, e => e);
}
await check('input_stuck on keycode 0 names the key to press and release', async () => {
  const e = await hands(['A'], 31);
  assert.equal(e.code, 'input_stuck');
  assert.match(e.message, /请用户按一下这个键再松开（「A」）/);
});
await check('input_stuck names every stuck key', async () => {
  const e = await hands(['A', '1'], 40);
  assert.match(e.message, /再松开（「A、1」）/);
});

console.log('kept behaviour: user_busy');
await check('user_busy names a key only when one is held', async () => {
  const held = await hands(['左 ⇧'], 0.1, 500);
  assert.equal(held.code, 'user_busy');
  assert.match(held.message, /「左 ⇧」一直按着/);
  const none = await hands([], 0.1, 500);
  assert.equal(none.code, 'user_busy');
  assert.doesNotMatch(none.message, /「/);
  assert.match(none.message, /你一直在打字或点击/);
});

if (failures.length) { console.log(`\n${failures.length} FAILED`); process.exit(1); }
console.log('\nall passed');
