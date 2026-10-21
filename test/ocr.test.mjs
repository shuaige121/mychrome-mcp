#!/usr/bin/env node
/* Screenshot support, offline: `cgevent ocr` (Apple Vision) on pictures rendered offscreen
 * (`cgevent veilsnap`: the takeover panel, Chinese and English), `cgevent compose`, and
 * bridge.js captureWindow / captureRegion with a fake screencapture (records its arguments,
 * writes a prepared PNG). Nothing here captures the screen, shows a window or posts input. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as bridge from '../src/bridge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.CGEVENT_BIN || path.join(HERE, '..', 'bin', 'cgevent');
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n${e.stack}`);
  }
}
const helper = (args) => JSON.parse(execFileSync(BIN, args, { encoding: 'utf8', timeout: 60000 }));
const helperFails = (args) => {
  try { execFileSync(BIN, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return JSON.parse(String(e.stdout).trim()); }
  throw new Error(`cgevent ${args[0]} did not fail`);
};
const pngSize = (f) => {
  const out = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf8' });
  return { w: Number(out.match(/pixelWidth:\s*(\d+)/)[1]), h: Number(out.match(/pixelHeight:\s*(\d+)/)[1]) };
};
const find = (lines, re) => lines.find(l => re.test(l.text));
const centre = (l) => ({ x: l.x + l.w / 2, y: l.y + l.h / 2 });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ocr-test-'));
try {
  // The takeover panel's sample states, rendered offscreen: a dark row above a light row, 7 panels each
  // (a fixed set: the sheet's size, and so how small its text gets in the captures below, stays the same).
  const ZH = path.join(dir, 'sheet-zh.png'), EN = path.join(dir, 'sheet-en.png');
  const FRAMES = 'start,moving,typing,done,failed,card,plan';
  const zhSheet = helper(['veilsnap', '--out', ZH, '--lang', 'zh', '--frames', FRAMES]);
  helper(['veilsnap', '--out', EN, '--lang', 'en', '--frames', FRAMES]);

  await check('ocr: Chinese and English on the offscreen panel sheet; pixel boxes top-left origin, inside the image; lines top to bottom', async () => {
    const r = helper(['ocr', ZH]);
    const { w: W, h: H } = pngSize(ZH);
    assert.deepEqual([r.width, r.height], [W, H]);
    assert.deepEqual(r.langs, ['zh-Hans', 'zh-Hant', 'en-US', 'ja-JP']);
    assert.ok(r.lines.length > 50, `only ${r.lines.length} lines`);
    for (const l of r.lines) {
      assert.ok(typeof l.text === 'string' && l.text && l.conf >= 0 && l.conf <= 1, JSON.stringify(l));
      assert.ok(l.x >= 0 && l.y >= 0 && l.w > 0 && l.h > 0 && l.x + l.w <= W + 1 && l.y + l.h <= H + 1, JSON.stringify(l));
    }
    for (let i = 1; i < r.lines.length; i++) assert.ok(r.lines[i].y >= r.lines[i - 1].y, 'lines not sorted top to bottom');
    // Each panel's title is in both rows: 7 dark ones in the top half, 7 light ones in the bottom half.
    const titles = r.lines.filter(l => /正在操作电脑/.test(l.text));
    assert.ok(titles.filter(l => centre(l).y < H / 2).length >= 6 && titles.filter(l => centre(l).y > H / 2).length >= 6,
      `titles: ${titles.map(l => `${l.x},${l.y}`).join(' ')}`);
    assert.ok(find(r.lines, /Claude/) && find(r.lines, /Esc/i), 'English words on the sheet were not read');
    // runVeilSnap centers each block plus a 28 pt margin in equal cells separated by 12 pt.
    // Derive the first block from the renderer's dimensions, not a previous panel's pixel position.
    const margin = 28, gap = 12, scale = zhSheet.scale;
    const cellW = Math.max(...zhSheet.frames.map(f => Math.ceil(f.block[0] + 2 * margin)));
    const cellH = Math.max(...zhSheet.frames.map(f => Math.ceil(f.block[1] + 2 * margin)));
    const [bw, bh] = zhSheet.frames[0].block;
    const block = {
      x: (gap + (cellW - Math.ceil(bw + 2 * margin)) / 2 + margin) * scale,
      y: (gap + (cellH - Math.ceil(bh + 2 * margin)) / 2 + margin) * scale,
      w: bw * scale, h: bh * scale,
    };
    assert.deepEqual([W, H], zhSheet.size.map(v => Math.round(v * scale)));
    const first = r.lines.filter(l => {
      const p = centre(l);
      return p.x > block.x && p.x < block.x + block.w && p.y > block.y && p.y < block.y + block.h;
    });
    const order = [/正在操作电脑/, /正在输入到/, /给供应商回信/, /连按两次/].map(re => {
      const l = find(first, re);
      assert.ok(l, `not read in the first panel: ${re}`);
      return centre(l).y;
    });
    for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `top-to-bottom order wrong: ${order.join(' < ')}`);
    const t = find(first, /正在操作电脑/);
    assert.ok(t.x >= block.x && t.x + t.w <= block.x + block.w &&
      t.y >= block.y && t.y + t.h <= block.y + block.h, `title box ${JSON.stringify(t)} outside ${JSON.stringify(block)}`);
    assert.ok(t.y + t.h < find(first, /正在输入到/).y, 'title overlaps the subtitle');
    return `${r.lines.length} lines; first panel title at ${t.x},${t.y} ${t.w}×${t.h}`;
  });

  await check('ocr: --langs is passed to Vision (unsupported codes dropped); a missing file fails cleanly', async () => {
    const r = helper(['ocr', EN, '--langs', 'en-US,xx-YY']);
    assert.deepEqual(r.langs, ['en-US']);
    assert.ok(r.lines.filter(l => /is using your computer/i.test(l.text)).length >= 10);
    assert.equal(helperFails(['ocr', path.join(dir, 'nope.png')]).error, 'bad_image');
    assert.equal(helperFails(['ocr']).error, 'usage');
  });

  await check('windowstack: an unknown window number fails cleanly (read-only, no pixels)', async () => {
    assert.equal(helperFails(['windowstack', '999999999']).error, 'no_such_window');
  });

  // A fake screencapture: records each call, writes the English sheet for window 11 (a popup), the Chinese one otherwise.
  const LOG = path.join(dir, 'sc.log');
  const FAKE = path.join(dir, 'screencapture');
  fs.writeFileSync(FAKE, '#!/bin/sh\necho "$*" >> "$FAKE_SC_LOG"\nfor last; do :; done\n' +
    'case " $* " in *" -l 11 "*) cp "$FAKE_SC_POPUP" "$last";; *) cp "$FAKE_SC_BASE" "$last";; esac\n');
  fs.chmodSync(FAKE, 0o755);
  process.env.FAKE_SC_LOG = LOG;
  process.env.FAKE_SC_BASE = ZH;
  process.env.FAKE_SC_POPUP = EN;
  const calls = () => fs.readFileSync(LOG, 'utf8').trim().split('\n');

  // Window 7 of Chrome (pid 42) at 1000,500, half the sheet's pixel size in pt (the sheet is its 2× capture;
  // its size follows the number of sample panels). In front of it: its own popup 11 over the right half's
  // top, another app's window 12, a second Chrome browser window 13.
  const { w: SW, h: SH } = pngSize(ZH);
  const PW = SW / 2, PH = SH / 2;
  const STACK = {
    ok: true, id: 7, pid: 42, layer: 0, onScreen: true, bounds: { x: 1000, y: 500, w: PW, h: PH },
    above: [
      { id: 11, pid: 42, layer: 101, alpha: 1, bounds: { x: 1000 + PW / 2, y: 500, w: PW / 2, h: PH / 2 } },
      { id: 12, pid: 77, layer: 0, alpha: 1, bounds: { x: 900, y: 400, w: 800, h: 600 } },
      { id: 13, pid: 42, layer: 0, alpha: 1, bounds: { x: 1100, y: 550, w: 3000, h: 1100 } }
    ]
  };
  const cg = async (args) => args[0] === 'windowstack' ? { ...STACK, asked: args[1] } : bridge.cgevent(args);

  await check('captureWindow: screencapture -l <window> (no shadow, no attached windows), own popups composed in at their bounds; other windows never captured', async () => {
    fs.rmSync(LOG, { force: true });
    const shot = await bridge.captureWindow({ cgWindow: 7 }, { screencapture: FAKE, cg });
    try {
      const c = calls();
      assert.equal(c.length, 2, c.join(' / '));
      assert.match(c[0], /^-x -o -a -t png -l 7 \S+window\.png$/);
      assert.match(c[1], /^-x -o -a -t png -l 11 \S+popup0\.png$/);
      // -R as a flag (the temporary folder's random name can hold "-R": 2026-10-19, two failed full runs).
      assert.ok(!c.some(x => / -l 1[23] /.test(x) || /(^|\s)-R(\s|$)/.test(x)), 'captured another window or a screen area');
      assert.deepEqual(shot.rect, STACK.bounds);
      assert.equal(shot.how, 'window');
      assert.equal(shot.popups, 1);
      assert.equal(shot.aspectOff, false);
      assert.deepEqual([shot.fullWidth, shot.fullHeight], [SW, SH]);
      // sips -Z limits the longest side and truncates the other dimension to whole pixels.
      const ratio = Math.min(1, 1568 / Math.max(SW, SH));
      assert.deepEqual([shot.width, shot.height], [Math.floor(SW * ratio), Math.floor(SH * ratio)]);
      assert.deepEqual(pngSize(shot.fullPath), { w: SW, h: SH });
      assert.ok(Buffer.from(shot.data, 'base64').subarray(1, 4).toString() === 'PNG');
      // The popup (the English sheet at half size) covers the top-right quarter: its first title is at
      // (PW + x/2, y/2) (its top-left panel's title); the Chinese titles that were under it are gone.
      const o = await bridge.ocrImage(shot.fullPath);
      const en = helper(['ocr', EN]).lines.filter(l => /is using your computer/i.test(l.text) && centre(l).y < PH - 14).sort((a, b) => a.x - b.x)[0];
      const want = { x: PW + centre(en).x / 2, y: centre(en).y / 2 };
      const got = o.lines.filter(l => /is using your computer/i.test(l.text)).map(centre);
      assert.ok(got.some(p => Math.abs(p.x - want.x) < 25 && Math.abs(p.y - want.y) < 25),
        `popup title not at ${Math.round(want.x)},${Math.round(want.y)}: ${got.map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ')}`);
      assert.ok(got.every(p => p.x > PW && p.y < PH), 'popup text outside its rect');
      assert.ok(!o.lines.some(l => /正在操作电脑/.test(l.text) && centre(l).x > PW + 40 && centre(l).y < PH - 64), 'base text left under the popup');
    } finally {
      await shot.dispose();
    }
    assert.equal(fs.existsSync(path.dirname(shot.fullPath)), false, 'temporary capture files left behind');
  });

  await check('captureWindow: no popups → the -l capture as is; no window number, window gone or off screen → refused (index.js falls back)', async () => {
    fs.rmSync(LOG, { force: true });
    const shot = await bridge.captureWindow({ cgWindow: 7 }, { screencapture: FAKE, cg: async (a) => a[0] === 'windowstack' ? { ...STACK, above: [] } : bridge.cgevent(a) });
    await shot.dispose();
    assert.equal(calls().length, 1);
    assert.equal(shot.popups, 0);
    await assert.rejects(bridge.captureWindow({ cgWindow: null }, { screencapture: FAKE, cg }), (e) => e.code === 'no_cg_window');
    await assert.rejects(bridge.captureWindow({ cgWindow: 999999999 }, { screencapture: FAKE }), (e) => e.code === 'no_such_window');
    await assert.rejects(bridge.captureWindow({ cgWindow: 7 }, { screencapture: FAKE, cg: async () => ({ ...STACK, onScreen: false }) }),
      (e) => e.code === 'window_off_screen');
    await assert.rejects(bridge.captureWindow({ cgWindow: 7 }, { screencapture: '/usr/bin/false', cg }), (e) => e.code === 'capture_failed');
  });

  await check('ownPopups: same app, in front, not another full browser window', async () => {
    assert.deepEqual(bridge.ownPopups(STACK).map(w => w.id), [11]);
    const bubble = { id: 14, pid: 42, layer: 0, alpha: 1, bounds: { x: 1200, y: 600, w: 300, h: 200 } };
    const ghost = { id: 15, pid: 42, layer: 3, alpha: 0, bounds: { x: 1200, y: 600, w: 300, h: 200 } };
    assert.deepEqual(bridge.ownPopups({ ...STACK, above: [...STACK.above, bubble, ghost] }).map(w => w.id), [11, 14]);
  });

  await check('captureRegion (the fallback): screencapture -R by screen area; a small picture is not scaled up', async () => {
    fs.rmSync(LOG, { force: true });
    const small = path.join(dir, 'small.png');
    fs.copyFileSync(ZH, small);
    execFileSync('/usr/bin/sips', ['-Z', '800', small], { stdio: 'ignore' });
    process.env.FAKE_SC_BASE = small;
    const shot = await bridge.captureRegion({ x: 10.4, y: 20.6, w: 400, h: 149 }, { screencapture: FAKE });
    await shot.dispose();
    process.env.FAKE_SC_BASE = ZH;
    assert.match(calls()[0], /^-x -t png -R 10,21,400,149 \S+region\.png$/);
    assert.deepEqual([shot.width, shot.height], [800, pngSize(small).h]);
    assert.equal(shot.how, 'region');
  });

  await check('a capture nobody disposed (e.g. a measuring script) is removed when the process exits', async () => {
    const src = `const b = await import(${JSON.stringify(new URL('../src/bridge.js', import.meta.url).href)});` +
      `const s = await b.captureRegion({ x: 0, y: 0, w: 400, h: 149 }, { screencapture: ${JSON.stringify(FAKE)} });` +
      'console.log(s.fullPath);';
    const left = execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', env: process.env }).trim();
    assert.match(left, /chrome-bridge-shot-.*region\.png$/);
    assert.equal(fs.existsSync(path.dirname(left)), false, `left behind: ${left}`);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures.length) { console.log(`ocr tests FAILED: ${failures.length}`); process.exit(1); }
console.log('ocr tests passed');
