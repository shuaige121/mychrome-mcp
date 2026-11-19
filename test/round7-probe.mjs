import { refuseUnsafeLegacy, requireUnlocked } from './live-guard.mjs';
refuseUnsafeLegacy('round7-probe.mjs');
/* Round 7 measurement (no takeover; opens and closes its own windows): can the page see chrome-bridge globals, and how big read_page is on real pages. */
const { startFixtureServer } = await import('./fixtures/server.mjs');
const B = await import('../src/bridge.js');
const tabs = await import('../src/tabs.js');
const { readPage } = await import('../src/index.js');
await requireUnlocked();
const wait = ms => new Promise(r => setTimeout(r, ms));
const srv = await startFixtureServer({ port: 0 });
const out = {};
const opened = [];
async function open(url) { const w = await B.newWindow(url, { left: 200, top: 140, right: 1300, bottom: 900 }); const t = Number(w.tabId); opened.push(t); await tabs.registerTab(t, url, { windowId: w.windowId }); await wait(2500); return t; }
try {
  let t = await open(srv.url + 'world-probe.html');
  const p = await readPage({ tab: t });
  out.isolatedProbeReadOk = /A button/.test(p);
  const inner = await B.evalInPage(`JSON.stringify({ ok: true, own: Object.keys(window).filter(k => /chromeBridge/i.test(k)), seen: document.getElementById('seen').textContent })`, t);
  out.scriptWorldSees = inner.own; await wait(400);
  out.pageWorldSees = (await B.evalInPage(`JSON.stringify({ ok: true, seen: document.getElementById('seen').textContent })`, t)).seen;
  for (const [name, url] of [['wikipedia-zh', 'https://zh.wikipedia.org/wiki/%E6%96%B0%E5%8A%A0%E5%9D%A1'], ['wikipedia-en', 'https://en.wikipedia.org/wiki/Singapore'], ['hn', 'https://news.ycombinator.com/']]) {
    t = await open(url);
    const r = await readPage({ tab: t });
    const m = r.match(/页面共 (\d+) 个可点击元素/);
    out[name] = { chars: r.length, cjk: (r.match(/[㐀-鿿]/g) || []).length, markers: m ? Number(m[1]) : null, truncated: /已截断|已省略/.test(r) };
  }
} catch (e) { out.fatal = e.code + ' ' + e.message.slice(0, 200); }
finally { for (const t of opened) await B.closeTab(t).catch(() => {}); srv.close?.(); console.log(JSON.stringify(out, null, 1)); process.exit(0); }
