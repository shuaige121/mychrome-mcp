#!/usr/bin/env node
import { refuseUnsafeLegacy, requireUnlocked } from './live-guard.mjs';
refuseUnsafeLegacy('round7-ocr-live.mjs');
/* Round 7, live and without takeover: window-only capture + on-device OCR on the owner's Chrome, own windows only.
 *   1. The fixture page in a window, then ANOTHER of our windows put right over it: capturing the first by its
 *      window number must show the first page's words and none of the covering page's (the -R leak, fixed).
 *   2. Hacker News: OCR text tokens vs the picture's tokens for the same window.
 *   node test/round7-ocr-live.mjs <out.json> */
const { writeFileSync } = await import('node:fs');
const { startFixtureServer } = await import('./fixtures/server.mjs');
const B = await import('../src/bridge.js');
const { layoutText, estimateTextTokens, estimateImageTokens } = await import('../src/index.js');
await requireUnlocked();

const out = process.argv[2];
const wait = ms => new Promise(r => setTimeout(r, ms));
const srv = await startFixtureServer({ port: 0 });
const res = { at: new Date().toISOString(), checks: [] };
const check = (name, ok, detail = '') => { res.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + String(detail).slice(0, 200)}`); };
const opened = [];
async function open(url, rect) { const w = await B.newWindow(url, rect); opened.push(Number(w.tabId)); await wait(3000); return Number(w.tabId); }
async function shotText(tab) {
  const info = await B.chromeInfo(tab);
  const shot = await B.captureWindow({ cgWindow: info.cgWindow });
  try {
    const o = await B.ocrImage(shot.fullPath);
    const lay = layoutText(o.lines, shot.width / o.width, shot.height / o.height);
    const text = [...lay.texts.values()].map(t => `${t.id} ${t.text} (${t.x},${t.y})`).join('\n');
    return { text, lines: lay.texts.size, how: shot.how, w: shot.width, h: shot.height, textTokens: estimateTextTokens(text), imageTokens: estimateImageTokens(shot.width, shot.height) };
  } finally { await shot.dispose?.(); }
}
try {
  const R = { left: 220, top: 160, right: 1220, bottom: 860 };
  const a = await open(srv.url + 'native-ui.html', R);
  await open(srv.url + 'world-probe.html', { left: 260, top: 200, right: 1180, bottom: 820 });   // covers most of the first
  const s1 = await shotText(a);
  res.coveredWindow = { lines: s1.lines, how: s1.how, sample: s1.text.split('\n').slice(0, 12) };
  check('covered window: its own words are read (Hover menu / Ask name)', /Hover menu/.test(s1.text) && /Ask name/.test(s1.text), s1.text.slice(0, 200));
  check('covered window: none of the covering window\'s words ("main-world sees", "A button")', !/main-world|A button/.test(s1.text), s1.text.slice(0, 300));
  check('captured by window number, not by screen region', s1.how === 'window', s1.how);
  const h = await open('https://news.ycombinator.com/', R);
  const s2 = await shotText(h);
  res.hackerNews = { lines: s2.lines, textTokens: s2.textTokens, imageTokens: s2.imageTokens, px: `${s2.w}×${s2.h}`, sample: s2.text.split('\n').slice(0, 10) };
  check('Hacker News: OCR text has the stories and costs fewer tokens than the picture', s2.lines > 40 && s2.textTokens < s2.imageTokens, `${s2.lines} lines, ${s2.textTokens} vs ${s2.imageTokens}`);
} catch (e) { res.fatal = `${e.code} ${String(e.message).slice(0, 300)}`; console.error('FATAL', res.fatal); }
finally {
  for (const t of opened) await B.closeTab(t).catch(() => {});
  srv.close?.();
  writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(`${res.checks.filter(c => c.ok).length}/${res.checks.length} passed`);
  process.exit(0);
}
