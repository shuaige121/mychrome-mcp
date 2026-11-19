#!/usr/bin/env node
/* OCR1, module level: the OCR job owns its child and the capture's image (error, hard limit, relay exit), bounds the
 * children of a relay, keeps the warm-up single-flight across relays and off while the input lock is held, and reports
 * only numbers and fixed words. Production bridge.js (captureRegion, ocrImage) and src/ocr-job.js; the only doubles are
 * the `cgevent` binary (a fake child, test/ocr-fixtures.mjs) and screencapture (copies the bundled warm-up image).
 * No screen, no Vision, no Chrome, no input. OCR1_GROUP=new|kept runs one group. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeOcrHelper, fakeScreencapture, pidAlive, runner, sha256, sleep, until } from './ocr-fixtures.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ocr1-job-'));
fs.mkdirSync(path.join(tmp, 'lock'));
fs.mkdirSync(path.join(tmp, 'home'));
// Nothing here may reach the real lock, settings or home paths: the lock is a temp one and HOME a temp folder.
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.HOME = path.join(tmp, 'home');
const LOCK = process.env.CHROME_BRIDGE_LOCK, OCRDIR = LOCK + '.ocr', STAMP = path.join(OCRDIR, 'last.json');
const fake = fakeOcrHelper(tmp);
const bridge = await import('../src/bridge.js');
const J = await import('../src/ocr-job.js');
const S = await import('../src/settings.js');
const SRC = J.WARM_IMAGE;
const SC = fakeScreencapture(tmp, SRC);
const capture = () => bridge.captureRegion({ x: 0, y: 0, w: 500, h: 210 }, { screencapture: SC });
const { check, summary } = runner();
const wfile = w => path.join(OCRDIR, `warm-${w}.lock`);
// Window checks need the window to stay the same during a check: start none within 3 s of a window's end.
const reset = async () => {
  fake.clear(); fs.rmSync(OCRDIR, { recursive: true, force: true }); fs.rmSync(LOCK, { recursive: true, force: true });
  const left = J.WARM_FRESH_MS - (Date.now() % J.WARM_FRESH_MS);
  if (left < 3000) await sleep(left + 50);
};

/* ------------------------------------------------ new fix */

await check('new', 'error: a helper failure gives the image back and leaves no job', async () => {
  await reset(); fake.set({ delayMs: 400, mode: 'fail' });
  const shot = await capture(), dir = path.dirname(shot.fullPath);
  const p = bridge.ocrImage(shot.fullPath, { helper: fake.bin, retain: shot.retain, bounded: true, record: true });
  await until(() => fake.starts().length, 3000);
  await shot.dispose();   // the owner is done first: the child still holds the image
  assert.equal(fs.existsSync(shot.fullPath), true, 'the image left while its child was still running');
  await assert.rejects(p, e => e.code === 'bad_image' && e.ocrFacts?.gapFrom === 'none');
  assert.equal(fake.ends()[0].seen.sha, sha256(SRC), 'the child read the capture');
  assert.equal(J.liveOcr(), 0, 'a job is left after the child exited');
  assert.equal(fs.existsSync(dir), false, 'the capture folder is retained after a failed child exited');
});

await check('new', 'hard limit: a child past it is killed; no orphan, no retained image', async () => {
  await reset(); fake.set({ delayMs: 30_000, mode: 'ok' });
  const shot = await capture(), dir = path.dirname(shot.fullPath);
  const t0 = Date.now();
  const job = J.startOcrJob(shot.fullPath, { bin: fake.bin, retain: shot.retain, record: true, hardMs: 500 });
  await shot.dispose();
  const out = await job.done;
  assert.equal(out.failure?.reason, 'killed');
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  const pid = fake.starts()[0].pid;
  assert.equal(await until(() => !pidAlive(pid), 2000), true, `helper ${pid} still alive`);
  assert.equal(J.liveOcr(), 0);
  assert.equal(fs.existsSync(dir), false, 'the capture folder is retained after the child was killed');
  assert.equal(fs.existsSync(STAMP), false, 'a killed child is not a completion');
});

await check('new', 'relay exit: no OCR child keeps running and no capture folder is left', async () => {
  await reset(); fake.set({ delayMs: 30_000, mode: 'ok' });
  const script = path.join(tmp, 'worker.mjs');
  fs.writeFileSync(script, `
    import fs from 'node:fs'; import path from 'node:path';
    const b = await import(${JSON.stringify(new URL('../src/bridge.js', import.meta.url).href)});
    const shot = await b.captureRegion({ x: 0, y: 0, w: 500, h: 210 }, { screencapture: ${JSON.stringify(SC)} });
    b.ocrImage(shot.fullPath, { helper: ${JSON.stringify(fake.bin)}, retain: shot.retain, bounded: true, record: true }).catch(() => {});
    for (let i = 0; i < 400; i++) { try { if (fs.readFileSync(${JSON.stringify(fake.log)}, 'utf8').includes('"start"')) break; } catch {} await new Promise(r => setTimeout(r, 25)); }
    await shot.dispose();
    console.log(JSON.stringify({ dir: path.dirname(shot.fullPath), kept: fs.existsSync(shot.fullPath) }));
    process.exit(0);`);
  const out = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000 }).trim().split('\n').pop());
  const pid = fake.starts()[0]?.pid;
  try {
    assert.ok(pid, 'the worker started no child');
    assert.equal(out.kept, true, 'the image left before the child exited');
    assert.equal(await until(() => !pidAlive(pid), 2000), true, `OCR child ${pid} outlived its relay`);
    assert.equal(fs.existsSync(out.dir), false, 'the capture folder outlived its relay');
  } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
});

await check('new', 'bounded resources: a third concurrent recognition of a relay is refused (busy) without a child', async () => {
  await reset(); fake.set({ delayMs: 400, mode: 'ok' });
  const a = bridge.ocrImage(SRC, { helper: fake.bin, bounded: true, record: true });
  const b = bridge.ocrImage(SRC, { helper: fake.bin, bounded: true, record: true });
  const c = await bridge.ocrImage(SRC, { helper: fake.bin, bounded: true, record: true });
  assert.equal(c.pending, 'busy');
  assert.deepEqual(Object.keys(c.facts).sort(), ['gapFrom', 'overlap']);
  assert.equal(c.facts.overlap, 2);
  await Promise.all([a, b]);
  assert.equal(fake.starts().length, 2, `children started: ${fake.starts().length}`);
  assert.equal(J.liveOcr(), 0);
});

await check('new', 'two relays contend for the warm-up: one owner, one launch; then fresh for both', async () => {
  await reset(); fake.set({ delayMs: 600, mode: 'ok' });
  const A = await import('../src/ocr-job.js?relay=a'), B = await import('../src/ocr-job.js?relay=b');
  const launch = R => () => R.startOcrJob(R.WARM_IMAGE, { bin: fake.bin, kind: 'warm', record: true }).done;
  const got = await Promise.all([A.maybeWarm({ launch: launch(A) }), B.maybeWarm({ launch: launch(B) })]);
  assert.deepEqual(got.sort(), ['held', 'launched']);
  assert.equal(fake.starts().length, 1, `warm-ups launched: ${fake.starts().length}`);
  assert.deepEqual(fake.starts()[0].argv, ['ocr', SRC, '--langs', 'zh-Hans,zh-Hant,en-US,ja-JP', '--max-px', '2048']);
  const owner = JSON.parse(fs.readFileSync(wfile(J.warmWindow()), 'utf8'));
  assert.ok(owner.pid === process.pid && Number.isSafeInteger(owner.doneAt), 'the window file does not record a finished owner');
  assert.equal(J.readStamp().from, 'warm');
  assert.equal(await B.maybeWarm({ launch: launch(B) }), 'fresh');
  assert.equal(await A.maybeWarm({ launch: launch(A) }), 'fresh');
  assert.equal(fake.starts().length, 1);
});

await check('new', 'a window is never taken over (a dead owner leaves it without a warm-up); ended windows are ignored and pruned', async () => {
  await reset(); fake.set({ delayMs: 50, mode: 'ok' });
  const C = await import('../src/ocr-job.js?relay=c');
  const launch = () => C.startOcrJob(C.WARM_IMAGE, { bin: fake.bin, kind: 'warm', record: true }).done;
  const w = C.warmWindow();
  fs.mkdirSync(OCRDIR, { recursive: true });
  const dead = spawnSync('/usr/bin/true').pid, deadRecord = JSON.stringify({ pid: dead, at: Date.now() - 120_000 });
  fs.writeFileSync(wfile(w), deadRecord);
  assert.equal(await C.maybeWarm({ launch }), 'held');
  assert.equal(fake.starts().length, 0, 'the window of a dead owner was taken over');
  assert.equal(fs.readFileSync(wfile(w), 'utf8'), deadRecord, 'the window file was changed by a non-owner');
  fs.rmSync(wfile(w));   // as if the next window had begun
  fs.writeFileSync(wfile(w - 3), JSON.stringify({ pid: process.ppid, at: Date.now() - 1_800_000 }));
  fs.writeFileSync(wfile(w - 1), JSON.stringify({ pid: process.ppid, at: Date.now() - 600_000 }));
  assert.equal(await C.maybeWarm({ launch }), 'launched');
  assert.equal(fake.starts().length, 1);
  assert.equal(fs.existsSync(wfile(w - 3)), false, 'a window that ended long ago was not pruned');
  assert.equal(fs.existsSync(wfile(w - 1)), true, 'the previous window was pruned');
  const mine = JSON.parse(fs.readFileSync(wfile(w), 'utf8'));
  assert.ok(mine.pid === process.pid && Number.isSafeInteger(mine.doneAt));
});

await check('new', 'three relays (separate processes) race for one window: exactly one warm-up', async () => {
  await reset(); fake.set({ delayMs: 1500, mode: 'ok' });
  const go = path.join(tmp, `go-${Date.now()}`), script = path.join(tmp, 'relay.mjs');
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    const J = await import(${JSON.stringify(new URL('../src/ocr-job.js', import.meta.url).href)});
    process.stdout.write('ready\\n');
    while (!fs.existsSync(process.env.OCR1_GO)) await new Promise(r => setTimeout(r, 1));
    const s = await J.maybeWarm({ launch: () => J.startOcrJob(J.WARM_IMAGE, { bin: process.env.OCR1_FAKE, kind: 'warm', record: true }).done });
    process.stdout.write(s + '\\n');`);
  const env = { ...process.env, OCR1_GO: go, OCR1_FAKE: fake.bin };
  const relays = [0, 1, 2].map(() => spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  const outs = relays.map(c => { const o = { text: '' }; c.stdout.on('data', d => { o.text += d; }); return o; });
  const exits = relays.map(c => new Promise(r => c.on('exit', code => r(code))));
  const guard = setTimeout(() => relays.forEach(c => c.kill('SIGKILL')), 20_000);
  try {
    assert.equal(await until(() => outs.every(o => o.text.includes('ready')), 15_000), true, 'the relays did not start');
    fs.writeFileSync(go, '');
    const codes = await Promise.all(exits);
    assert.deepEqual(codes, [0, 0, 0]);
  } finally { clearTimeout(guard); }
  const statuses = outs.map(o => o.text.trim().split('\n').pop()).sort();
  assert.equal(fake.starts(e => e.file === SRC).length, 1, `warm-ups launched: ${fake.starts(e => e.file === SRC).length} (${statuses.join(', ')})`);
  assert.deepEqual(statuses, ['held', 'held', 'launched']);
  assert.equal(J.readStamp().from, 'warm');
});

await check('new', 'warm-up waits while any relay holds the input lock, then runs once', async () => {
  await reset(); fake.set({ delayMs: 50, mode: 'ok' });
  const D = await import('../src/ocr-job.js?relay=d');
  const launch = () => D.startOcrJob(D.WARM_IMAGE, { bin: fake.bin, kind: 'warm', record: true }).done;
  fs.mkdirSync(LOCK);
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now(), label: 'click', token: 't' }));
  assert.equal(D.inputActive(), true);
  assert.equal(await D.maybeWarm({ launch, retryMs: 100 }), 'deferred');
  await sleep(400);
  assert.equal(fake.starts().length, 0, 'a warm-up started while the input lock was held');
  fs.rmSync(LOCK, { recursive: true, force: true });
  assert.equal(await until(() => fake.ends().length && D.liveOcr() === 0, 3000), true, 'no warm-up after the lock was released');
  assert.equal(fake.starts().length, 1);
  assert.equal(D.readStamp().from, 'warm');
  // A lock whose holder is gone is not input.
  fs.mkdirSync(LOCK);
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: spawnSync('/usr/bin/true').pid, since: Date.now() }));
  assert.equal(D.inputActive(), false);
  fs.rmSync(LOCK, { recursive: true, force: true });
});

await check('new', 'telemetry: the completion stamp yields numbers and fixed words; bad stamps are "invalid"', async () => {
  await reset();
  const now = Date.now();
  assert.deepEqual(J.requestFacts(now), { gapFrom: 'none', overlap: 0 });
  fs.mkdirSync(OCRDIR, { recursive: true });
  const put = o => fs.writeFileSync(STAMP, typeof o === 'string' ? o : JSON.stringify(o));
  put({ v: 1, doneAt: now - 5000, kind: 'real', ms: 31000 });
  assert.deepEqual(J.requestFacts(now), { gapFrom: 'real', overlap: 0, gapMs: 5000, prevMs: 31000 });
  put({ v: 1, doneAt: now - 10, kind: 'warm', ms: 'SECRET' });
  assert.deepEqual(J.requestFacts(now), { gapFrom: 'warm', overlap: 0, gapMs: 10 });
  for (const bad of ['garbage', '{"v":1}', { v: 1, doneAt: now + 60_000, kind: 'real', ms: 1 }, { v: 1, doneAt: 'x', kind: 'real' },
    { v: 1, doneAt: now - 1.5, kind: 'real' }, { v: 2, doneAt: now, kind: 'real' }, { v: 1, doneAt: now, kind: 'SECRET TEXT' },
    { v: 1, doneAt: now - 40 * 24 * 3600_000, kind: 'real' }, { v: 1, doneAt: -5, kind: 'warm' }]) {
    put(bad);
    assert.deepEqual(J.requestFacts(now), { gapFrom: 'invalid', overlap: 0 }, JSON.stringify(bad));
  }
});

await check('new', 'telemetry: the activity row keeps OCR fields only as fixed words and bounded integers', () => {
  const base = { tool: 'screenshot', ok: true, t: 1, pid: 1 };
  const good = S.activityRecord({ ...base, ocrStatus: 'timeout', ocrHelperMs: 213, ocrGapMs: 5000, ocrGapFrom: 'warm', ocrPrevMs: 31000, ocrOverlap: 1 });
  assert.deepEqual([good.ocrStatus, good.ocrHelperMs, good.ocrGapMs, good.ocrGapFrom, good.ocrPrevMs, good.ocrOverlap], ['timeout', 213, 5000, 'warm', 31000, 1]);
  for (const bad of ['213', 'SECRET TEXT', NaN, Infinity, -1, 1.5, 10 ** 13, null, [213], { ms: 1 }]) {
    const r = S.activityRecord({ ...base, ocrStatus: bad, ocrHelperMs: bad, ocrGapMs: bad, ocrGapFrom: bad, ocrPrevMs: bad, ocrOverlap: bad });
    for (const k of ['ocrStatus', 'ocrHelperMs', 'ocrGapMs', 'ocrGapFrom', 'ocrPrevMs', 'ocrOverlap']) assert.equal(Object.hasOwn(r, k), false, `${k} kept ${String(bad)}`);
  }
  assert.deepEqual(S.activityRecord(base), S.activityRecord({ ...base, ocrStatus: undefined }), 'absent fields add nothing');
});

/* ------------------------------------------------ kept behaviour */

await check('kept', 'a direct ocrImage call keeps its contract: result or BridgeError, no facts, no stamp, no limit', async () => {
  await reset(); fake.set({ delayMs: 0, mode: 'ok', text: 'DIRECT' });
  const r = await bridge.ocrImage(SRC, { helper: fake.bin });
  assert.equal(r.lines[0].text, 'DIRECT');
  assert.equal(Object.hasOwn(r, 'facts'), false);
  assert.equal(fs.existsSync(STAMP), false);
  assert.deepEqual(fake.starts()[0].argv, ['ocr', SRC, '--langs', 'zh-Hans,zh-Hant,en-US,ja-JP', '--max-px', '2048']);
  fake.set({ delayMs: 0, mode: 'fail' });
  await assert.rejects(bridge.ocrImage(SRC, { helper: fake.bin }), e => e.code === 'bad_image' && e instanceof bridge.BridgeError);
  fake.set({ delayMs: 0, mode: 'malformed' });
  await assert.rejects(bridge.ocrImage(SRC, { helper: fake.bin }), e => e.code === 'ocr_failed');
  await assert.rejects(bridge.ocrImage(SRC, { helper: path.join(tmp, 'missing-helper') }), e => e.code === 'helper_missing');
  const all = await Promise.all([1, 2, 3].map(() => bridge.ocrImage(SRC, { helper: fake.bin }).catch(e => e.code)));
  assert.deepEqual(all, ['ocr_failed', 'ocr_failed', 'ocr_failed'], 'unbounded callers are not limited');
  assert.equal(J.liveOcr(), 0);
});

await check('kept', 'a capture without OCR is removed by its owner at once; dispose stays idempotent', async () => {
  const shot = await capture(), dir = path.dirname(shot.fullPath);
  await shot.dispose(); await shot.dispose();
  assert.equal(fs.existsSync(dir), false);
  assert.equal(shot.retain(), null, 'a removed capture cannot be retained');
});

await check('kept', 'importing bridge.js leaves the input lock path to the caller (CHROME_BRIDGE_LOCK set afterwards still counts)', async () => {
  // Tests import bridge.js or guard.js, then set CHROME_BRIDGE_LOCK, then import index.js/lock.js: lock.js must not have
  // been loaded by then, or LOCK_DIR is the real ~/Library/Caches one.
  const late = path.join(tmp, 'late', 'input.lock');
  const src = `await import(${JSON.stringify(new URL('../src/bridge.js', import.meta.url).href)});` +
    `await import(${JSON.stringify(new URL('../src/ocr-job.js', import.meta.url).href)});` +
    `process.env.CHROME_BRIDGE_LOCK = ${JSON.stringify(late)};` +
    `const l = await import(${JSON.stringify(new URL('../src/lock.js', import.meta.url).href)});` +
    `const j = await import(${JSON.stringify(new URL('../src/ocr-job.js', import.meta.url).href)});` +
    'console.log(JSON.stringify({ lock: l.LOCK_DIR, ocr: j.ocrDir() }));';
  const env = { ...process.env, HOME: path.join(tmp, 'home') };
  delete env.CHROME_BRIDGE_LOCK;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', env, timeout: 20_000 }).trim());
  assert.deepEqual(out, { lock: late, ocr: late + '.ocr' });
});

const failed = summary('ocr-job');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
