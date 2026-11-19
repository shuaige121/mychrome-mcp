/* OCR1 test fixtures (not a test entry point): a fake `cgevent ocr` child and a fake screencapture. No screen, no Vision,
 * no input. The fake helper is one Node process (no grandchildren), so a kill reaches everything it runs. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A fake `cgevent` for `ocr <file> --langs … --max-px …`, configured by the JSON file named in FAKE_OCR_CFG (read when
 * each child starts): {delayMs, mode: ok|fail|malformed, text, helperMs}. Each child logs {ev:'start'|'end', pid, t, file,
 * argv, seen} to the log file; `seen` is what it found at the image path when it finished waiting: {bytes, sha} or {missing}.
 */
export function fakeOcrHelper(dir) {
  const bin = path.join(dir, 'fake-cgevent'), cfgFile = path.join(dir, 'fake-ocr.json'), log = path.join(dir, 'fake-ocr.log');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'), crypto = require('crypto');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_OCR_CFG, 'utf8'));
const argv = process.argv.slice(2), file = argv[1];
const note = o => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, t: Date.now(), file, ...o }) + '\\n');
note({ ev: 'start', argv });
setTimeout(() => {
  let seen;
  try { const b = fs.readFileSync(file); seen = { bytes: b.length, sha: crypto.createHash('sha256').update(b).digest('hex') }; }
  catch (e) { seen = { missing: e.code }; }
  note({ ev: 'end', seen });
  if (cfg.mode === 'fail') { process.stdout.write(JSON.stringify({ ok: false, error: 'bad_image', message: 'fixture failure' })); process.exit(1); }
  if (cfg.mode === 'malformed') { process.stdout.write('not json'); process.exit(0); }
  process.stdout.write(JSON.stringify({ ok: true, width: 1000, height: 420, langs: ['en-US'], autoLanguage: true,
    lines: [{ text: cfg.text || 'FIXTURE', conf: 1, x: 100, y: 40, w: 300, h: 30 }], elapsedMs: cfg.helperMs ?? 5 }));
}, cfg.delayMs || 0);
`);
  fs.chmodSync(bin, 0o755);
  process.env.FAKE_OCR_CFG = cfgFile;
  const set = cfg => fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  set({ delayMs: 0, mode: 'ok' });
  const entries = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { bin, log, set, entries,
    starts: (pred = () => true) => entries().filter(e => e.ev === 'start' && pred(e)),
    ends: (pred = () => true) => entries().filter(e => e.ev === 'end' && pred(e)),
    clear: () => fs.rmSync(log, { force: true }) };
}

/** A fake screencapture: copies `src` to its last argument (the capture's own file). */
export function fakeScreencapture(dir, src) {
  const bin = path.join(dir, 'fake-screencapture');
  fs.writeFileSync(bin, `#!/bin/sh\nfor last; do :; done\ncp ${JSON.stringify(src)} "$last"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

export const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, ms, step = 25) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

/** A runner printing `  ok    [group] name` / `  FAIL  [group] name` (the strict RED rule greps the FAIL line). */
export function runner() {
  const results = [];
  const only = process.env.OCR1_GROUP || null;
  async function check(group, name, fn) {
    if (only && only !== group) return;
    try { await fn(); results.push([group, name, null]); console.log(`  ok    [${group}] ${name}`); }
    catch (e) { results.push([group, name, e]); console.log(`  FAIL  [${group}] ${name}\n        ${String(e?.stack || e).split('\n').slice(0, 6).join('\n        ')}`); }
  }
  function summary(label) {
    for (const g of [...new Set(results.map(r => r[0]))]) {
      const mine = results.filter(r => r[0] === g);
      console.log(`${label} [${g}]: ${mine.filter(r => !r[2]).length}/${mine.length} passed`);
    }
    return results.filter(r => r[2]).length;
  }
  return { check, summary };
}
