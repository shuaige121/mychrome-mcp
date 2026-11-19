#!/usr/bin/env node
import { refuseUnsafeLegacy, requireUnlocked } from './live-guard.mjs';
refuseUnsafeLegacy('round7-outline.mjs');
/* Round 7, the owner's idea (2026-10-06): read the page's headings first (big → small), let the agent pick which
 * sections to expand, the way people skim. Measures, per real page (window of its own, no takeover):
 *   - semantic headings (h1–h6, role=heading) and landmarks; the top-level outline (h1/h2 only) and the full outline, in tokens
 *   - each section's size (its text + clickable elements up to the next heading), so "expand one section" has a cost
 *   - visual headings where the markup has none: short block text noticeably larger or bolder than the body text
 * Token figures are estimates: CJK 1 token per character, other text 3.5 characters per token.
 *   node test/round7-outline.mjs <out.json> */
const { writeFileSync } = await import('node:fs');
const B = await import('../src/bridge.js');
const tabs = await import('../src/tabs.js');
await requireUnlocked();

const out = process.argv[2];
const wait = ms => new Promise(r => setTimeout(r, ms));
const tok = (s) => { const cjk = (s.match(/[㐀-鿿　-〿＀-￯]/g) || []).length; return Math.round(cjk + (s.length - cjk) / 3.5); };
const PROBE = `JSON.stringify((() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); if (!r.width && !r.height) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const isH = (el) => /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading';
  const level = (el) => /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : Number(el.getAttribute('aria-level') || 2);
  const CLICK = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]';
  const secs = [{ level: 0, title: '(标题之前)', chars: 0, clicks: 0 }];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    if (n.nodeType === 1) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.tagName)) { continue; }
      if (isH(n) && shown(n)) secs.push({ level: level(n), title: n.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80), chars: 0, clicks: 0 });
      else if (n.matches(CLICK) && shown(n)) secs[secs.length - 1].clicks++;
    } else {
      const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
      const t = n.textContent.replace(/\\s+/g, ' ').trim(); if (t) secs[secs.length - 1].chars += t.length;
    }
  }
  const landmarks = document.querySelectorAll('header,nav,main,aside,footer,form,[role=banner],[role=navigation],[role=main],[role=complementary],[role=contentinfo],[role=search],[role=form]').length;
  // Visual headings: short block-level text, larger (≥1.2×) or bolder than the body text, not a link, not inside a semantic heading.
  const base = parseFloat(getComputedStyle(document.querySelector('main') || document.body).fontSize) || 16;
  let visual = 0; const vsamples = [];
  for (const el of document.querySelectorAll('body *')) {
    if (isH(el) || el.closest('h1,h2,h3,h4,h5,h6,[role=heading]') || el.children.length > 2 || el.closest('a,button')) continue;
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 60 || !shown(el)) continue;
    const cs = getComputedStyle(el);
    if (!/^(block|flex|grid|table-cell|list-item)$/.test(cs.display)) continue;
    const big = parseFloat(cs.fontSize) >= base * 1.2, bold = Number(cs.fontWeight) >= 600 && parseFloat(cs.fontSize) >= base;
    if (big || bold) { visual++; if (vsamples.length < 6) vsamples.push(t.slice(0, 40)); }
  }
  return { ok: true, secs, landmarks, visual, vsamples, base };
})())`;
const PAGES = [
  ['wikipedia-zh', 'https://zh.wikipedia.org/wiki/%E6%96%B0%E5%8A%A0%E5%9D%A1'],
  ['wikipedia-en', 'https://en.wikipedia.org/wiki/Singapore'],
  ['hacker-news', 'https://news.ycombinator.com/'],
];
const res = { at: new Date().toISOString(), pages: {} };
const opened = [];
try {
  for (const [name, url] of PAGES) {
    const w = await B.newWindow(url, { left: 200, top: 140, right: 1300, bottom: 900 });
    const t = Number(w.tabId); opened.push(t);
    await tabs.registerTab(t, url, { windowId: w.windowId });
    await wait(3000);
    const r = await B.evalInPage(PROBE, t);
    const secs = r.secs.filter((s, i) => i === 0 ? s.chars > 0 : true);
    const line = (s, i) => `S${i} ${'#'.repeat(s.level || 1)} ${s.title}（${s.chars} 字，${s.clicks} 个可点）`;
    const top = secs.map((s, i) => [s, i]).filter(([s]) => s.level <= 2);
    const topOutline = top.map(([s, i]) => line(s, i)).join('\n');
    const fullOutline = secs.map(line).join('\n');
    const sizes = secs.slice(1).map(s => s.chars).sort((a, b) => a - b);
    const sectionTok = secs.slice(1).map(s => tok('x'.repeat(0)) + Math.round((name === 'wikipedia-zh' ? s.chars * 0.6 : s.chars / 3.5) + s.clicks * 6));
    sectionTok.sort((a, b) => a - b);
    res.pages[name] = {
      headings: secs.length - 1, landmarks: r.landmarks, visualHeadings: r.visual, visualSamples: r.vsamples,
      topLevel: { entries: top.length, chars: topOutline.length, tokensEst: tok(topOutline), sample: topOutline.split('\n').slice(0, 8) },
      fullOutline: { entries: secs.length, chars: fullOutline.length, tokensEst: tok(fullOutline) },
      sectionTokensEst: sectionTok.length ? { median: sectionTok[Math.floor(sectionTok.length / 2)], p90: sectionTok[Math.floor(sectionTok.length * 0.9)], max: sectionTok[sectionTok.length - 1] } : null,
      sectionCharsMedian: sizes.length ? sizes[Math.floor(sizes.length / 2)] : null,
    };
    await B.closeTab(t).catch(() => {}); opened.pop();
  }
} catch (e) { res.fatal = `${e.code} ${String(e.message).slice(0, 300)}`; }
finally {
  for (const t of opened) await B.closeTab(t).catch(() => {});
  writeFileSync(out, JSON.stringify(res, null, 2));
  for (const [k, v] of Object.entries(res.pages)) console.log(k, JSON.stringify({ h: v.headings, lm: v.landmarks, vis: v.visualHeadings, top: v.topLevel.entries + '/' + v.topLevel.tokensEst + 't', full: v.fullOutline.entries + '/' + v.fullOutline.tokensEst + 't', sec: v.sectionTokensEst }));
  for (const [k, v] of Object.entries(res.pages)) { console.log('--', k); console.log(v.topLevel.sample.join('\n')); console.log('visual:', v.visualSamples.join(' | ')); }
  if (res.fatal) console.log('FATAL', res.fatal);
  process.exit(0);
}
