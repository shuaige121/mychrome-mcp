#!/usr/bin/env node
import { refuseUnsafeLegacy, requireUnlocked } from './live-guard.mjs';
refuseUnsafeLegacy('round6-live.mjs');
/* Live (round 6), phase 1, local page only: hover menu (hover → its item gets a marker → click),
 * prompt() (click → dialog reported → answer_dialog with text), and a screenshot saved for a
 * look before click_at (phase 2 takes the point as arguments).
 *   node test/round6-live.mjs <out.json> <shot.png>            phase 1
 *   node test/round6-live.mjs <out.json> <shot.png> <tab> x y   phase 2: click_at, then screenshot again */
const { writeFileSync } = await import('node:fs');
const { startFixtureServer } = await import('./fixtures/server.mjs');
const { readPage, click, hoverTool, answerDialogTool, screenshotTool, clickAt, pressKeyTool, taskPlanTool, closeTabTool } = await import('../src/index.js');
await requireUnlocked();

const [out, shotPath, tabArg, xs, ys] = process.argv.slice(2);
const res = { steps: [] };
const T0 = Date.now();
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const r = await fn(); res.steps.push({ name, ok: true, ms: Date.now() - t0, out: String(r && r.text ? r.text : r).slice(0, 500) }); process.stderr.write(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ok ${name}\n`); return r; }
  catch (e) { res.steps.push({ name, ok: false, ms: Date.now() - t0, code: e.code, out: String(e.message).slice(0, 500) }); process.stderr.write(`[${((Date.now() - T0) / 1000).toFixed(1)}s] FAIL ${name}: ${e.code} ${String(e.message).split('\n')[0]}\n`); return null; }
};
const mk = (page, re) => { const m = page.match(re); return m ? Number(m[1]) : NaN; };
const pageOut = (page) => (page.match(/(menu: \w+|prompt: [^\n]*|date: [^\n]*|idle)/) || [])[1] || null;
let srv = null;
try {
  if (!tabArg) {
    srv = await startFixtureServer({ port: 0 });
    // Its own window: another session switching tabs in a shared window cannot pull it away (seen live).
    const b = await import('../src/bridge.js'), tabs = await import('../src/tabs.js');
    const w = await b.newWindow(srv.url + 'native-ui.html', { left: 160, top: 120, right: 1360, bottom: 900 });
    const tab = Number(w.tabId);
    await tabs.registerTab(tab, srv.url + 'native-ui.html', { windowId: w.windowId });
    res.tab = tab;
    await new Promise(r => setTimeout(r, 1200));
    await taskPlanTool({ task: 'round6 native UI', steps: ['hover menu', 'prompt', 'date picker'], estimate_minutes: 2 });
    let page = await readPage({ tab });
    await step('hover "Hover menu"', () => hoverTool({ tab, marker: mk(page, /\[(\d+)\][^\[\n]*Hover menu/), step: '1/3', note: '悬停打开菜单' }));
    page = await readPage({ tab });
    res.settingsMarker = mk(page, /\[(\d+)\][^\[\n]*Settings/);
    await step('click Settings (appeared on hover)', () => click({ tab, marker: res.settingsMarker, step: '1/3', note: '点悬停菜单里的 Settings' }));
    page = await readPage({ tab });
    res.afterMenu = pageOut(page);
    res.askClick = (await step('click Ask name (opens prompt)', () => click({ tab, marker: mk(page, /\[(\d+)\][^\[\n]*Ask name/), step: '2/3', note: '弹出 prompt' }))) || null;
    await step('answer prompt with text', () => answerDialogTool({ tab, button: '确定', text: '王小明' }).catch(() => answerDialogTool({ tab, button: 'OK', text: '王小明' })));
    page = await readPage({ tab });
    res.afterPrompt = pageOut(page);
    await step('click the date field', () => click({ tab, marker: mk(page, /\[(\d+)\][^\[\n]*(?:date|日期|年)/i), step: '3/3', note: '点日期输入框' }));
    const s = await step('screenshot', () => screenshotTool({ tab, step: '3/3', note: '截图找日历按钮' }));
    if (s && s.image) writeFileSync(shotPath, Buffer.from(s.image.data, 'base64'));
    await taskPlanTool({ done: true });
  } else {
    const tab = Number(tabArg);
    res.tab = tab;
    await step('screenshot (map)', () => screenshotTool({ tab }));
    await step(`click_at ${xs},${ys}`, () => clickAt({ tab, x: Number(xs), y: Number(ys) }));
    await new Promise(r => setTimeout(r, 800));
    const s = await step('screenshot after', () => screenshotTool({ tab }));
    if (s && s.image) writeFileSync(shotPath, Buffer.from(s.image.data, 'base64'));
    const page = await readPage({ tab }).catch(e => String(e.message));
    res.afterClickAt = pageOut(page);
  }
} catch (e) {
  res.fatal = { code: e.code, message: String(e.message).slice(0, 500) };
  process.stderr.write(`FATAL ${e.code} ${e.message}\n`);
} finally {
  if (srv && process.argv.includes('--close')) await closeTabTool({ tab: res.tab }).catch(() => {});
  writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(JSON.stringify({ tab: res.tab, afterMenu: res.afterMenu, afterPrompt: res.afterPrompt, afterClickAt: res.afterClickAt,
    steps: res.steps.map(s => [s.name, s.ok, s.ok ? s.out.split('\n').find(l => /✅|⚠️|截图|已/.test(l)) : s.out.split('\n')[0]]) }, null, 1));
  if (!srv) process.exit(0);
  srv.close?.(); process.exit(0);
}
