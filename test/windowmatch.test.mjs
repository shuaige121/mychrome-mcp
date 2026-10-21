#!/usr/bin/env node
/* Chrome window -> CG window matching (chromectl matchWindows), through `chromectl windowmatch`:
 * the real Swift code on made-up window lists; nothing is read from Chrome or the screen.
 * Twins (same bounds: every maximized window on a display) are told apart by the AX window number
 * (_AXUIElementGetWindow, as JustTab does) before Chrome's z-order is paired with CoreGraphics'. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROMECTL = process.env.CHROMECTL_BIN || path.join(ROOT, 'bin', 'chromectl');
const match = (input) => JSON.parse(execFileSync(CHROMECTL, ['windowmatch'], { input: JSON.stringify(input), encoding: 'utf8' }));
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

const MAX = [0, 30, 1920, 970], SMALL = [100, 100, 800, 600];
const win = (id, rect, index, title, minimized = false) => ({ id, rect, index, title, minimized });
const cgw = (num, rect, onScreen = true) => ({ num, rect, onScreen });
const axw = (num, title, rect, minimized = false) => ({ num, title, rect, minimized });

console.log('chromectl windowmatch');
{
  const r = match({ chrome: [win(1, MAX, 1, 'A'), win(2, SMALL, 2, 'B')], cg: [cgw(10, MAX), cgw(20, SMALL)] });
  assert.deepEqual(r.map, { 1: 10, 2: 20 });
  assert.equal(r.axAsked, false);
  assert.equal(r.titlesAsked, 0);
  ok('distinct bounds: matched by bounds, Accessibility not asked');
}
{
  // Two maximized windows; Chrome's order and the CG order disagree (a raise in flight): z-order
  // pairing alone would swap them. The AX window numbers decide.
  const r = match({
    chrome: [win(1, MAX, 1, '邮箱'), win(2, MAX, 2, '文档')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(11, '邮箱 - Google Chrome', MAX), axw(10, '文档 - Google Chrome - 工作', MAX)]
  });
  assert.deepEqual(r.map, { 1: 11, 2: 10 });
  assert.equal(r.axAsked, true);
  ok('maximized twins: told apart by AX window number + active tab title, ahead of z-order pairing');
}
{
  const r = match({
    chrome: [win(1, MAX, 2, '新标签页'), win(2, MAX, 1, '新标签页')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 11, rect: MAX }, { num: 10, rect: MAX }],
    ax: [axw(10, '新标签页 - Google Chrome', MAX), axw(11, '新标签页 - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 2: 11, 1: 10 });
  ok('twins with the same title: AX cannot tell, z-order pairing still does');
}
{
  const r = match({
    chrome: [win(1, MAX, null, 'X'), win(2, MAX, null, 'X')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'X - Google Chrome', MAX), axw(11, 'X - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, {});
  ok('twins with the same title and no window order: no entry (refused, never guessed)');
}
{
  const r = match({
    chrome: [win(1, MAX, null, 'Foo'), win(2, MAX, null, 'Foo - Bar')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'Foo - Bar - Google Chrome', MAX), axw(11, 'Foo - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 11, 2: 10 });
  ok('a title that is the start of the other window\'s title: "<title> - Google Chrome" decides');
}
{
  const r = match({
    chrome: [win(1, MAX, null, '音乐'), win(2, MAX, null, '邮件')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, '音乐 - Audio playing - Google Chrome', MAX), axw(11, '邮件 - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 10, 2: 11 });
  ok('Chrome\'s state in the window title ("- Audio playing"): still matched');
}
{
  const r = match({
    chrome: [win(1, MAX, 1, 'A'), win(2, MAX, 2, 'B', true)],
    cg: [cgw(10, MAX, true), cgw(11, MAX, false)]
  });
  assert.deepEqual(r.map, { 1: 10, 2: 11 });
  assert.equal(r.axAsked, false);
  ok('a minimized and a normal twin: on-screen state decides, Accessibility not asked');
}
{
  const r = match({
    chrome: [win(1, MAX, null, 'X'), win(2, MAX, null, 'Y')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'X - Google Chrome', MAX), axw(10, 'Y - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, {});
  ok('one CG window claimed by two Chrome windows: neither gets it');
}
{
  const r = match({
    chrome: [win(1, MAX, null, ''), win(2, MAX, null, 'B')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, ' - Google Chrome', MAX), axw(11, 'B - Google Chrome', MAX, true)]
  });
  assert.deepEqual(r.map, {});
  const f = match({
    chrome: [win(1, MAX, null, 'X'), win(2, MAX, null, 'Y')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'X - Google Chrome', SMALL), axw(11, 'Y - Google Chrome', null)]
  });
  assert.deepEqual(f.map, {});
  ok('an empty title, or an AX window in another minimized state or frame: not matched');
}
{
  // Two windows with the same title and only one AX window answering with a number: AX names
  // neither (it cannot say which one), so z-order pairing still gets both.
  const r = match({
    chrome: [win(1, MAX, 1, 'X'), win(2, MAX, 2, 'X')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 11, rect: MAX }, { num: 10, rect: MAX }],
    ax: [axw(10, 'X - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 11, 2: 10 });
  ok('one AX window for two same-titled Chrome windows: AX names neither, z-order pairs both');
}
{
  const r = match({
    chrome: [win(1, MAX, 1, 'A'), win(2, MAX, 2, 'B'), win(3, MAX, 3, 'B')],
    cg: [cgw(10, MAX), cgw(11, MAX), cgw(12, MAX)],
    onOrder: [{ num: 12, rect: MAX }, { num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(12, 'A - Google Chrome', MAX), axw(10, 'B - Google Chrome', MAX), axw(11, 'B - Google Chrome', MAX)]
  });
  // A by AX (12); the two "B" windows by z-order among the CG windows nobody took (10 front, 11 back).
  assert.deepEqual(r.map, { 1: 12, 2: 10, 3: 11 });
  ok('three twins: one by AX, the other two paired by z-order among the CG windows left');
}
{
  // Codex r1 A: AX names one twin (the other page has no title): the last one is still paired by z-order.
  const r = match({
    chrome: [win(1, MAX, 1, 'Mail'), win(2, MAX, 2, '')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(10, 'Mail - Google Chrome', MAX), axw(11, ' - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 10, 2: 11 });
  ok('AX names one twin, the other page has no title: the last window is still paired (Codex r1 A)');
}
{
  // Codex r1 B3: the titles swap between the AX read and Chrome's (a page retitles itself, a tab switch).
  const r = match({
    chrome: [win(1, MAX, null, 'A', false), win(2, MAX, null, 'B', false)].map((w, i) => ({ ...w, title2: i ? 'A' : 'B' })),
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'A - Google Chrome', MAX), axw(11, 'B - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, {});
  assert.equal(r.titlesAsked, 4);
  ok('a title that changed while the AX table was read: that match is not used (Codex r1 B3)');
}
{
  // Codex r2 B1: both titled "A"; one retitles to "B" while AX (answering for one window only) still says
  // "A". Dropping just the changed title would leave the other "unique" and swap both; the group is skipped.
  const r = match({
    chrome: [{ ...win(1, MAX, 1, 'A'), title2: 'B' }, win(2, MAX, 2, 'A')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(10, 'A - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 10, 2: 11 });
  // Window 2 passes through "A" (B → A → C) just as AX reads it, and AX misses window 1: window 1's
  // steady "A" would take window 2's number if only the changed window were skipped.
  const t = match({
    chrome: [win(1, MAX, 1, 'A'), { ...win(2, MAX, 2, 'B'), title2: 'C' }],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(11, 'A - Google Chrome', MAX)]
  });
  assert.deepEqual(t.map, { 1: 10, 2: 11 });
  ok('a title changed in a group of twins: no title match in that group, z-order pairs them (Codex r2 B1)');
}
{
  // The bridge itself, read-only: a process without windows (this one) has none; bad usage is an error.
  assert.deepEqual(JSON.parse(execFileSync(CHROMECTL, ['axwindows', String(process.pid)], { encoding: 'utf8' })).windows, []);
  assert.equal(JSON.parse(execFileSync(CHROMECTL, ['axwindows'], { encoding: 'utf8' })).ok, false);
  ok('axwindows: a windowless process has no AX windows; no pid is a usage error');
}
{
  // `chromectl profiles`: the Apple Events JavaScript switch of a profile signed in to Chrome is kept with its
  // account (account_values.browser…), often with no local browser… key: that value is the one in force
  // (seen 2026-10-14: the owner's main profile read as off, and the panel said a permission was missing).
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-profiles-'));
  const prefs = {
    A: { account_values: { browser: { allow_javascript_apple_events: true } } },
    B: { browser: { allow_javascript_apple_events: true } },
    C: { account_values: { browser: { allow_javascript_apple_events: false } }, browser: { allow_javascript_apple_events: true } },
    D: {}
  };
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: { last_used: 'A', info_cache: Object.fromEntries(Object.keys(prefs).map(k => [k, { name: k }])) } }));
  for (const [k, v] of Object.entries(prefs)) { fs.mkdirSync(path.join(dir, k)); fs.writeFileSync(path.join(dir, k, 'Preferences'), JSON.stringify(v)); }
  const r = JSON.parse(execFileSync(CHROMECTL, ['profiles'], { encoding: 'utf8', env: { ...process.env, CHROME_BRIDGE_CHROME_DIR: dir } }));
  assert.deepEqual(Object.fromEntries(r.profiles.map(p => [p.dir, p.appleEventsJS])), { A: true, B: true, C: false, D: false });
  fs.rmSync(dir, { recursive: true, force: true });
  ok('profiles: the account value of the JavaScript switch wins (signed-in profiles); the local key otherwise; missing = off');
}
console.log(`\nwindowmatch checks passed (${passed}).`);
