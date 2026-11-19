#!/usr/bin/env node
import { refuseUnsafeLegacy, requireUnlocked } from './live-guard.mjs';
refuseUnsafeLegacy('round7-viewport.mjs');
/* Round 7, the fair control group (owner's point): a screenshot only shows what is in the window, so compare it
 * with reading only what is in the window — not with the whole page. Per page, in a window of its own (no takeover):
 *   full     read_page as it is now (whole page, capped)
 *   visible  the text nodes on screen + an index line per clickable element on screen ("[n] label")
 *   shot     the window captured the way the screenshot tool does (longest edge 1568), tokens ≈ w×h/750
 * Token figures are estimates: CJK 1 token per character, other text 3.5 characters per token.
 *   node test/round7-viewport.mjs <out.json> [<dir to keep the pictures>] */
const { writeFileSync } = await import('node:fs');
const path = await import('node:path');
const B = await import('../src/bridge.js');
const tabs = await import('../src/tabs.js');
const { readPage } = await import('../src/index.js');
await requireUnlocked();

const [out, keep] = process.argv.slice(2);
const wait = ms => new Promise(r => setTimeout(r, ms));
const tok = (s) => { const cjk = (s.match(/[㐀-鿿　-〿＀-￯]/g) || []).length; return Math.round(cjk + (s.length - cjk) / 3.5); };
const VISIBLE = `JSON.stringify((() => {
  const vw = innerWidth, vh = innerHeight;
  const on = (q) => q.width > 0 && q.height > 0 && q.bottom > 0 && q.top < vh && q.right > 0 && q.left < vw;
  const shown = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false; } return true; };
  const text = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const t = n.textContent.replace(/\\s+/g, ' ').trim();
    if (!t || !n.parentElement || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName)) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    if ([...r.getClientRects()].some(on) && shown(n.parentElement)) text.push(t);
  }
  const idx = [];
  for (const el of document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[onclick]')) {
    if (!on(el.getBoundingClientRect()) || !shown(el)) continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.value || el.title || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    idx.push('[' + (idx.length + 1) + '] ' + el.tagName.toLowerCase() + ' | ' + label);
  }
  return { ok: true, vw, vh, text: text.join(' '), index: idx.join('\\n') };
})())`;
const PAGES = [
  ['wikipedia-zh', 'https://zh.wikipedia.org/wiki/%E6%96%B0%E5%8A%A0%E5%9D%A1'],
  ['wikipedia-en', 'https://en.wikipedia.org/wiki/Singapore'],
  ['hacker-news', 'https://news.ycombinator.com/'],
];
const res = { at: new Date().toISOString(), window: '1100×760 points', pages: {} };
const opened = [];
try {
  for (const [name, url] of PAGES) {
    const w = await B.newWindow(url, { left: 200, top: 140, right: 1300, bottom: 900 });
    const t = Number(w.tabId); opened.push(t);
    await tabs.registerTab(t, url, { windowId: w.windowId });
    await wait(3000);
    const full = await readPage({ tab: t, full: true });
    const vis = await B.evalInPage(VISIBLE, t);
    const visible = vis.text + '\n' + vis.index;
    const b = vis.bounds;   // the window, as the screenshot tool captures it
    const shot = await B.captureRegion({ x: b.left, y: b.top, w: b.width, h: b.height });
    if (keep) writeFileSync(path.join(keep, `${name}.png`), Buffer.from(shot.data, 'base64'));
    res.pages[name] = {
      viewport: `${vis.vw}×${vis.vh}`,
      full: { chars: full.length, tokensEst: tok(full) },
      visible: { chars: visible.length, textChars: vis.text.length, clickable: vis.index ? vis.index.split('\n').length : 0, tokensEst: tok(visible) },
      shot: { px: `${shot.width}×${shot.height}`, tokensEst: Math.round(shot.width * shot.height / 750) },
    };
    await B.closeTab(t).catch(() => {}); opened.pop();
  }
} catch (e) { res.fatal = `${e.code} ${String(e.message).slice(0, 300)}`; }
finally {
  for (const t of opened) await B.closeTab(t).catch(() => {});
  writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 1));
  process.exit(0);
}
