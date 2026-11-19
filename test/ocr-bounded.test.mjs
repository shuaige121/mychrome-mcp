#!/usr/bin/env node
/* OCR1, server level: a slow first OCR no longer stalls the agent. The production callTool → screenshotTool →
 * readOnlyCapture → readShot → bridge.js ocrImage (bounded job) → src/ocr-job.js, and the production warm-up trigger.
 * Doubles: the bridge's read-only Chrome facts (screen state, tab info, site check, AX probe: fixed fakes), the capture
 * (production captureRegion with a fake screencapture that copies the bundled warm-up image: no screen), and the
 * `cgevent` binary (a fake child, test/ocr-fixtures.mjs). Every other bridge entry fails closed. No Chrome, no Vision,
 * no input. OCR1_GROUP=new|kept runs one group (the slow case is shared by the first three new checks). */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fakeOcrHelper, fakeScreencapture, runner, sha256, sleep, until } from './ocr-fixtures.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ocr1-srv-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'lock', 'input.lock');
process.env.CHROME_BRIDGE_AGENT_STATE = path.join(tmp, 'agent-window.json');
Object.assign(process.env, { CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_HABITS: 'off', CHROME_BRIDGE_MENUBAR: '0',
  CHROME_BRIDGE_SWEEP: '0', CHROME_BRIDGE_WARM: '0', CHROME_BRIDGE_HOTSWAP: '0', CHROME_BRIDGE_LANG: 'zh',
  CHROME_BRIDGE_AGENT_NAME: 'ocr1-test' });
fs.mkdirSync(path.join(tmp, 'lock'));
fs.mkdirSync(path.join(tmp, 'home'));
process.env.HOME = path.join(tmp, 'home');   // no real home, lock or settings path is reachable from here
fs.writeFileSync(process.env.CHROME_BRIDGE_AGENT_STATE, JSON.stringify({ windowId: 9 }));
const LOCK = process.env.CHROME_BRIDGE_LOCK, OCRDIR = LOCK + '.ocr', STAMP = path.join(OCRDIR, 'last.json'), ACTIVITY = process.env.CHROME_BRIDGE_ACTIVITY;

const fake = fakeOcrHelper(tmp);
const bridge = await import('../src/bridge.js');
const J = await import('../src/ocr-job.js');
const idx = await import('../src/index.js');
const SRC = J.WARM_IMAGE;
const SC = fakeScreencapture(tmp, SRC);
const TARGET = { tabId: 7, windowId: 9, chromePid: 42, cgWindow: 5, tabActive: true, minimized: false,
  url: 'https://fixture.invalid/page', title: 'Fixture', bounds: { left: 100, top: 200, width: 800, height: 600 } };
const B = Object.fromEntries(idx.__bridgeKeysForTests().map(name => [name, () => { throw new Error(`Unexpected native entry point: ${name}`); }]));
Object.assign(B, {
  cgevent: async args => {
    assert.deepEqual(args, ['displays']);
    return { ok: true, locked: false, displaysAsleep: false, displays: [{ id: 1 }] };
  },
  chromeInfo: async () => ({ ok: true, ...TARGET }),
  pageDialog: async () => ({ ok: true, open: false }),
  pageScript: async name => `inert ${name}`,
  evalInPage: async (script, tab) => ({ blocked: null, target: { tabId: tab, url: TARGET.url } }),
  axInput: async () => null,
  capturePageContent: async () => ({ ...(await bridge.captureRegion({ x: 100, y: 300, w: 800, h: 500 }, { screencapture: SC })), how: 'page-content' }),
  ocrImage: (file, o = {}) => bridge.ocrImage(file, { ...o, helper: fake.bin }),
});
idx.__setBridgeForTests(B);
idx.__recordForTests(true);
const notifications = [];
idx.__notifyForTests({ send: text => notifications.push(text) });

const call = async (name, args) => {
  const r = await idx.callTool({ params: { name, arguments: args } }, {});
  return { r, text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), image: r.content.find(c => c.type === 'image') || null,
    isError: r.isError === true, code: r.structuredContent?.error?.code ?? null };
};
const rows = () => { try { return fs.readFileSync(ACTIVITY, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const lastRow = tool => rows().filter(r => r.tool === tool).at(-1);
const warmStarts = () => fake.starts(e => e.file === SRC);
const replies = [];
const { check, summary } = runner();
const SHOT_REFUSALS = ['no_screenshot', 'no_such_text', 'outside_shot', 'screenshot_changed'];

/* ------------------------------------------------ the slow first OCR (shared by the first three new checks) */

let slow = null;
async function slowShot() {
  if (slow) return slow;
  fake.clear(); fs.rmSync(OCRDIR, { recursive: true, force: true });
  fake.set({ delayMs: 12_000, mode: 'ok', text: 'LATE-SECRET-TEXT', helperMs: 11_900 });
  let lockSeen = false;
  const watcher = setInterval(() => { if (fs.existsSync(LOCK)) lockSeen = true; }, 50);
  const t0 = Date.now();
  const out = await call('screenshot', { tab: 7 });
  const replyAt = Date.now();
  clearInterval(watcher);
  replies.push(out.text);
  const start = fake.starts()[0];
  slow = { out, t0, replyAt, start, imageAtReply: !!start && fs.existsSync(start.file), lockSeen, row: lastRow('screenshot') };
  return slow;
}

await check('new', 'slow OCR: the reply comes ≤ 8.5 s after OCR start with the validated image and a neutral note; capture and total times apart', async () => {
  const { out, t0, replyAt, start, lockSeen, row } = await slowShot();
  assert.ok(start && start.t >= t0, 'no OCR child started');
  assert.ok(replyAt - start.t <= 8500, `reply ${replyAt - start.t} ms after OCR start`);
  // OCR starts after the capture and its checks: (call time − capture time) bounds OCR start → reply from above.
  assert.ok(replyAt - t0 - row.captureMs <= 8500, `reply up to ${replyAt - t0 - row.captureMs} ms after OCR start`);
  assert.equal(out.isError, false, out.text);
  assert.ok(out.image, 'no image in the fallback reply');
  assert.equal(out.image.data, fs.readFileSync(SRC).toString('base64'), 'not the validated capture');
  assert.match(out.text, /本地识字 8 秒内没有完成，这次没有文字结果，已附上截图图像。这张图没有文字编号（text_id），click_at 只能按图像坐标 x\/y 点击。/);
  assert.doesNotMatch(out.text, /\bt1\b|LATE-SECRET|稍后|下次|首次|30 ?s|约 ?30/);
  assert.equal(row.ocrStatus, 'timeout');
  assert.ok(row.ocrMs >= 7900 && row.ocrMs <= 8500, `ocrMs ${row.ocrMs}`);
  assert.ok(Number.isSafeInteger(row.captureMs) && row.captureMs >= 0, `captureMs ${row.captureMs}`);
  assert.ok(row.ms >= row.ocrMs + row.captureMs, `ms ${row.ms}`);
  assert.equal(Object.hasOwn(row, 'ocrHelperMs'), false, 'a timed-out row claims a helper time');
  assert.equal(row.ocrGapFrom, 'none');
  assert.equal(lockSeen, false, 'the input lock was taken for OCR');
  console.log(`        measure slow: callMs=${replyAt - t0} ocrStartToReplyMs=${replyAt - start.t} row.captureMs=${row.captureMs} row.ocrMs=${row.ocrMs} row.ms=${row.ms}`);
});

await check('new', 'the image outlives the reply until its child exits, then is removed', async () => {
  const { start, imageAtReply } = await slowShot();
  assert.equal(imageAtReply, true, 'the image was gone at the reply');
  const end = await until(() => fake.ends(e => e.pid === start.pid)[0], 8000);
  assert.ok(end, 'the child did not finish');
  assert.ok(end.t - start.t >= 11_900, 'the child read the image before the deadline');
  assert.deepEqual(end.seen, { bytes: fs.statSync(SRC).size, sha: sha256(SRC) }, 'the child did not find the capture after the reply');
  assert.equal(await until(() => !fs.existsSync(path.dirname(start.file)) && J.liveOcr() === 0, 3000), true, 'the capture folder outlived its child');
  console.log(`        measure retained: childReadImageAtMs=${end.t - start.t} (after OCR start) folderRemovedAfterChildExit=true`);
});

await check('new', 'a late result publishes nothing: no text ids (no_such_text); coordinates still work', async () => {
  const { start } = await slowShot();
  assert.ok(await until(() => fake.ends(e => e.pid === start.pid)[0] && J.liveOcr() === 0, 8000), 'the late child never finished');
  await sleep(50);
  const saved = idx.handoverCarry().shots.find(([id]) => id === 7)?.[1];
  assert.ok(saved, 'the screenshot record is gone');
  assert.deepEqual(saved.texts, [], 'late text ids were published');
  assert.deepEqual([saved.width, saved.height], [1000, 420]);
  const byText = await call('click_at', { tab: 7, text_id: 't1' });
  replies.push(byText.text);
  assert.equal(byText.code, 'no_such_text', byText.text);
  assert.match(byText.text, /那次没有识别到文字/);
  const outside = await call('click_at', { tab: 7, x: 5000, y: 10 });
  assert.equal(outside.code, 'outside_shot', outside.text);
  const byPoint = await call('click_at', { tab: 7, x: 100, y: 40 });
  replies.push(byPoint.text);
  assert.ok(!SHOT_REFUSALS.includes(byPoint.code), `coordinates refused by the screenshot record: ${byPoint.code}`);
  console.log(`        measure late: textIds=${saved.texts.length} click_at(t1)=${byText.code} click_at(x,y)=${byPoint.code} (past the screenshot checks; this bridge refuses input)`);
  assert.doesNotMatch(replies.join('\n') + fs.readFileSync(ACTIVITY, 'utf8'), /LATE-SECRET/);
});

await check('new', 'the next OCR row reports the last completed OCR on this Mac (here the late child): gap and wall time; numbers only', async () => {
  await slowShot();
  await until(() => J.liveOcr() === 0, 8000);
  fake.set({ delayMs: 30, mode: 'ok', text: 'FAST-TEXT', helperMs: 1234 });
  const out = await call('screenshot', { tab: 7 });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /t1 \(\d+,\d+\) FAST-TEXT/);
  assert.equal(out.image, null, 'a text-only request got an image');
  const row = lastRow('screenshot');
  assert.equal(row.ocrStatus, 'ok');
  assert.equal(row.ocrHelperMs, 1234);
  assert.equal(row.ocrGapFrom, 'real');
  assert.ok(row.ocrGapMs >= 0 && row.ocrGapMs < 60_000, `ocrGapMs ${row.ocrGapMs}`);
  assert.ok(row.ocrPrevMs >= 11_900 && row.ocrPrevMs < 15_000, `ocrPrevMs ${row.ocrPrevMs}`);
  assert.equal(row.ocrOverlap, 0);
  console.log(`        measure next: ocrMs=${row.ocrMs} ocrHelperMs=${row.ocrHelperMs} ocrGapFrom=${row.ocrGapFrom} ocrGapMs=${row.ocrGapMs} ocrPrevMs=${row.ocrPrevMs} ocrOverlap=${row.ocrOverlap}`);
  const log = fs.readFileSync(ACTIVITY, 'utf8');
  assert.doesNotMatch(log, /FAST-TEXT|LATE-SECRET|fixture\.invalid\/page/);
  for (const r of rows()) for (const [k, v] of Object.entries(r)) if (k.startsWith('ocr')) assert.ok(typeof v === 'number' || /^[a-z]+$/.test(v), `${k}=${v}`);
});

await check('new', 'read_page screen tier: a slow OCR returns the image with the same note and no text ids', async () => {
  await until(() => J.liveOcr() === 0, 15_000);
  fake.clear();
  fake.set({ delayMs: 9000, mode: 'ok', text: 'LATE-READ-TEXT', helperMs: 8900 });
  // An unreadable page (canvas only: no DOM text, opaque) sends read_page to its screen tier.
  const page = { pageScript: B.pageScript, evalInPage: B.evalInPage };
  idx.__setBridgeForTests({
    pageScript: async (name, vars) => `fakePage(${JSON.stringify(JSON.stringify({ name, vars }))})`,
    evalInPage: async src => JSON.parse(vm.runInNewContext(src, { fakePage: spec => {
      const script = JSON.parse(spec);
      if (script.name === 'block') return JSON.stringify({ blocked: null, target: { ok: true, ...TARGET } });
      if (script.name === 'read') return JSON.stringify({ ok: true, target: { ok: true, ...TARGET }, text: '', hint: '', count: 0,
        opaque: 1, visibility: 'visible', outline: [] });
      throw new Error(`unexpected page script ${script.name}`);
    } })) });
  let out;
  try { out = await call('read_page', { tab: 7 }); } finally { idx.__setBridgeForTests(page); }
  replies.push(out.text);
  assert.equal(out.isError, false, out.text);
  assert.ok(out.image, 'no image from the screen tier');
  assert.equal(out.image.data, fs.readFileSync(SRC).toString('base64'));
  assert.ok(out.text.includes('本地识字 8 秒内没有完成，这次没有文字结果，已附上截图图像。这张图没有文字编号（text_id），click_at 只能按图像坐标 x/y 点击。'),
    `read_page lost the OCR note: ${out.text}`);
  assert.doesNotMatch(out.text, /LATE-READ|\bt1\b/);
  assert.equal(lastRow('read_page').ocrStatus, 'timeout');
  assert.ok(await until(() => J.liveOcr() === 0, 8000), 'the late child never finished');
  assert.deepEqual(idx.handoverCarry().shots.find(([id]) => id === 7)?.[1]?.texts, [], 'late text ids were published');
  assert.doesNotMatch(replies.join('\n') + fs.readFileSync(ACTIVITY, 'utf8'), /LATE-READ/);
});

await check('new', 'warm-up through the server: not at import or arming, never awaited, single per window, waits for the input lock', async () => {
  await until(() => J.liveOcr() === 0, 8000);
  fake.clear(); fs.rmSync(OCRDIR, { recursive: true, force: true });
  fake.set({ delayMs: 2000, mode: 'ok', text: 'WARM' });
  await call('list_tabs', {});
  await sleep(400);
  assert.equal(warmStarts().length, 0, 'a warm-up ran before the server armed it');
  idx.__armOcrWarmForTests(true);
  await sleep(400);
  assert.equal(warmStarts().length, 0, 'arming launched a warm-up');
  const t0 = Date.now();
  await call('list_tabs', {});
  const took = Date.now() - t0;
  assert.equal(await until(() => warmStarts().length === 1, 1500), true, 'the read call launched no warm-up');
  assert.ok(took < 1000, `the call waited for its warm-up: ${took} ms`);
  assert.equal(fake.ends(e => e.file === SRC).length, 0, 'the warm-up was over before the call returned');
  assert.deepEqual(warmStarts()[0].argv, ['ocr', SRC, '--langs', 'zh-Hans,zh-Hant,en-US,ja-JP', '--max-px', '2048']);
  assert.equal(await until(() => J.liveOcr() === 0 && J.readStamp().from === 'warm', 5000), true, 'no warm completion stamp');
  await call('list_tabs', {}); await call('read_page', { tab: 7 });
  await sleep(400);
  assert.equal(warmStarts().length, 1, 'a second warm-up inside the freshness window');
  // A new window (one warm-up per window): no stamp, no window file.
  fs.rmSync(OCRDIR, { recursive: true, force: true });
  fake.set({ delayMs: 50, mode: 'ok', text: 'WARM' });
  fs.mkdirSync(LOCK);
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now(), label: 'click', token: 'other-relay' }));
  try {
    await call('list_tabs', {});
    await sleep(800);
    assert.equal(warmStarts().length, 1, 'a warm-up started while a relay held the input lock');
  } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
  const released = Date.now();
  assert.equal(await until(() => warmStarts().length === 2, 5000), true, 'the deferred warm-up never ran after the lock was released');
  console.log(`        measure warm: triggerCallMs=${took} launches=${warmStarts().length} deferredLaunchAfterReleaseMs=${warmStarts()[1].t - released}`);
  await until(() => J.liveOcr() === 0, 3000);
  idx.__armOcrWarmForTests(false);
});

/* ------------------------------------------------ kept behaviour */

await check('kept', 'a fast OCR still publishes its text ids, and click_at t1 passes the screenshot checks', async () => {
  await until(() => J.liveOcr() === 0, 8000);
  fake.set({ delayMs: 0, mode: 'ok', text: 'KEPT-TEXT', helperMs: 7 });
  const out = await call('screenshot', { tab: 7 });
  assert.match(out.text, /t1 \(\d+,\d+\) KEPT-TEXT/);
  assert.equal(out.image, null);
  const saved = idx.handoverCarry().shots.find(([id]) => id === 7)?.[1];
  assert.equal(saved.texts.length, 1);
  const click = await call('click_at', { tab: 7, text_id: 't1' });
  assert.ok(!SHOT_REFUSALS.includes(click.code), `t1 refused by the screenshot record: ${click.code}`);
});

await check('kept', 'an OCR failure within the budget reads as before; image only when asked', async () => {
  fake.set({ delayMs: 0, mode: 'fail' });
  const out = await call('screenshot', { tab: 7 });
  assert.equal(out.isError, false);
  assert.match(out.text, /本地识字失败（fixture failure）。要看画面就加 image: true 再截一次。/);
  assert.equal(out.image, null);
  assert.equal(lastRow('screenshot').ocrStatus, 'failed');
  const both = await call('screenshot', { tab: 7, image: true, ocr: true });
  assert.ok(both.image);
});

await check('kept', 'image-only screenshots start no OCR child', async () => {
  fake.clear();
  const out = await call('screenshot', { tab: 7, image: true });
  assert.ok(out.image);
  await sleep(200);
  assert.equal(fake.starts().length, 0);
});

assert.deepEqual(notifications.filter(n => !/AI 好像卡住了/.test(n)), [], 'no other notification');
const failed = summary('ocr-bounded');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
