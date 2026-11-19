// Synthetic PNG + fake screencapture only. No real screen capture, browser or user input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as bridge from '../src/bridge.js';

assert.equal(typeof bridge.capturePageContent, 'function');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-page-capture-'));
try {
  const source = path.join(tmp, 'fixture.swift'), png = path.join(tmp, 'fixture.png');
  fs.writeFileSync(source, `import CoreGraphics
import CoreText
import ImageIO
import Foundation
let c = CGContext(data: nil, width: 800, height: 600, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
c.setFillColor(CGColor(gray: 1, alpha: 1)); c.fill(CGRect(x: 0, y: 0, width: 800, height: 600))
for (text, y) in [("PRIVATE BOOKMARK TEST", 540.0), ("PUBLIC PAGE CONTENT", 300.0)] {
 let a = NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 30, nil)])
 c.textPosition = CGPoint(x: 40, y: y); CTLineDraw(CTLineCreateWithAttributedString(a), c)
}
let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(d, c.makeImage()!, nil); assert(CGImageDestinationFinalize(d))
`);
  const renderer = path.join(tmp, 'renderer');
  execFileSync('/usr/bin/swiftc', [source, '-o', renderer], { stdio: 'pipe' });
  execFileSync(renderer, [png]);
  const fake = path.join(tmp, 'screencapture'), log = path.join(tmp, 'calls');
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PAGE_CAPTURE_LOG"\nfor last; do :; done\ncp "$PAGE_CAPTURE_FIXTURE" "$last"\n');
  fs.chmodSync(fake, 0o755);
  process.env.PAGE_CAPTURE_LOG = log; process.env.PAGE_CAPTURE_FIXTURE = png;
  const target = { cgWindow: 7, chromePid: 42 };
  const rect = { x: 100, y: 350, w: 800, h: 450 }, windowBounds = { x: 100, y: 200, w: 800, h: 600 };
  const geometry = { ok: true, pid: 42, cgWindow: 7, rect, windowBounds, source: 'ax-web-area' };
  const stack = { ok: true, id: 7, pid: 42, layer: 0, onScreen: true, bounds: windowBounds,
    above: [{ id: 99, pid: 42, layer: 101, alpha: 1, bounds: rect }] };
  const cg = async args => args[0] === 'windowstack' ? stack : bridge.cgevent(args);
  const opts = { screencapture: fake, cg, contentProbe: async () => geometry };
  const shot = await bridge.capturePageContent(target, opts);
  try {
    assert.equal(shot.how, 'page-content');
    assert.deepEqual(shot.rect, rect);
    assert.deepEqual([shot.fullWidth, shot.fullHeight], [800, 450]);
    assert.equal(shot.popups, 0);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'browser popup must not be captured');
    assert.deepEqual(fs.readdirSync(path.dirname(shot.fullPath)).sort(), ['page.png', 'shot.png']);
    const ocr = await bridge.ocrImage(shot.fullPath, { langs: ['en-US'] });
    const text = ocr.lines.map(x => x.text).join(' ');
    assert.match(text, /PUBLIC PAGE CONTENT/);
    assert.doesNotMatch(text, /PRIVATE|BOOKMARK/);
    assert.ok(ocr.elapsedMs >= 0);
    assert.ok(shot.timings.totalMs >= shot.timings.captureMs);
  } finally { await shot.dispose(); }
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').length;
  for (const bad of [null, { ...geometry, pid: 99 }, { ...geometry, rect: windowBounds },
    { ...geometry, rect: { ...rect, h: 1000 } }, { ...geometry, source: 'guessed-toolbar' }]) {
    const before = calls();
    await assert.rejects(bridge.capturePageContent(target, { ...opts, contentProbe: async () => bad }), { code: 'page_content_unavailable' });
    assert.equal(calls(), before, 'unproven geometry must never capture pixels');
  }
  let probes = 0;
  await assert.rejects(bridge.capturePageContent(target, { ...opts, contentProbe: async () =>
    ++probes === 1 ? geometry : { ...geometry, rect: { ...rect, y: 351, h: 449 } } }), { code: 'page_content_changed' });
  const failedFile = fs.readFileSync(log, 'utf8').trim().split('\n').at(-1).split(' ').at(-1);
  assert.equal(fs.existsSync(path.dirname(failedFile)), false, 'discard unstable screenshot');
  for (const changed of [{ pid: 99 }, { id: 8 }, { layer: 101 }, { onScreen: undefined },
    { bounds: { ...windowBounds, y: 201 } }]) {
    const before = calls();
    await assert.rejects(bridge.capturePageContent(target, { ...opts, cg: async () => ({ ...stack, ...changed }) }), { code: 'page_content_changed' });
    assert.equal(calls(), before, 'changed native source/bounds must not capture pixels');
  }
  await assert.rejects(bridge.capturePageContent(target, { ...opts, cg: async args => {
    if (args[0] === 'crop') return { ok: true, rect: { ...rect, y: 300, h: 500 } };
    return cg(args);
  } }), { code: 'page_content_unavailable' });
  console.log('page-capture: content crop privacy, stability and no-fallback checks passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
