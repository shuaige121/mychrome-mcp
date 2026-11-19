#!/usr/bin/env node
import { refuseUnsafeLegacy, requireUnlocked } from './live-guard.mjs';
refuseUnsafeLegacy('round6-read-live.mjs');
/* Live (round 6), no takeover (no keyboard or mouse, no veil): in the owner's Chrome, a window of
 * its own per page, then closed.
 *   1. modal-overlay.html: read_page lists the modal first and flags the page behind it.
 *   2. dropdown-semantics.html: <select> options, states, a listener-only menu opened by script → its options get numbers.
 *   3. native-ui.html: prompt() opened by script, answered through AX with Chinese text; then Cancel → null.
 *   node test/round6-read-live.mjs <out.json> */
const { writeFileSync } = await import('node:fs');
const { startFixtureServer } = await import('./fixtures/server.mjs');
const B = await import('../src/bridge.js');
const tabs = await import('../src/tabs.js');
const { readPage, answerDialogTool } = await import('../src/index.js');
await requireUnlocked();

const out = process.argv[2];
const res = { checks: [] };
const check = (name, ok, detail = '') => { res.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) }); process.stderr.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + String(detail).slice(0, 200)}\n`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const srv = await startFixtureServer({ port: 0 });
const opened = [];
async function open(page) {
  const w = await B.newWindow(srv.url + page, { left: 200, top: 140, right: 1300, bottom: 900 });
  const tab = Number(w.tabId);
  opened.push(tab);
  await tabs.registerTab(tab, srv.url + page, { windowId: w.windowId });
  await wait(1500);
  return tab;
}
// Page scripts answer JSON with ok:true (src/bridge.js evalInPage).
const js = async (tab, src) => (await B.evalInPage(`JSON.stringify({ ok: true, v: (() => { ${src} })() })`, tab)).v;
try {
  // 1. modal first
  let tab = await open('modal-overlay.html');
  let page = await readPage({ tab });
  res.modalHead = page.split('\n').slice(0, 4);
  check('modal: warning line names the dialog', /⚠️ 页面开着弹窗「订阅我们的通讯」/.test(page), page.slice(0, 300));
  check('modal: its elements come before the page behind it', page.indexOf('订阅') < page.indexOf('背景按钮'), '');
  check('modal: the background button is flagged as covered', /背景按钮[^\n]*\[被弹窗挡住\]|\[被弹窗挡住\][^\n]*背景按钮/.test(page), page.match(/[^\n]*背景按钮[^\n]*/g));
  check('modal: 订阅 is disabled until 同意条款', /订阅[^\n]*\[禁用\]|\[禁用\][^\n]*订阅/.test(page), page.match(/[^\n]*订阅[^\n]*/g));
  await js(tab, `document.getElementById('native').close(); return 1;`);
  page = await readPage({ tab });
  check('modal closed: no warning, nothing flagged', !/页面开着弹窗/.test(page) && !/被弹窗挡住/.test(page), page.slice(0, 200));

  // 2. dropdowns
  tab = await open('dropdown-semantics.html?filler=0');
  page = await readPage({ tab });
  check('select: options listed with the total', /选项（共 45 个/.test(page), page.match(/[^\n]*选项（共[^\n]*/));
  check('combobox: [收起] state on the closed city box', /城市[^\n]*\[收起\]|\[收起\][^\n]*城市/.test(page) || /combobox[^\n]*\[收起\]/.test(page), page.match(/[^\n]*\[收起\][^\n]*/g));
  check('listener-only fruit trigger gets a (推测可点) number', /\[\d+\][^\n]*选择水果[^\n]*推测可点|推测可点[^\n]*选择水果/.test(page), page.match(/[^\n]*水果[^\n]*/g));
  await js(tab, `document.getElementById('fruit').click(); return 1;`);
  await wait(400);
  page = await readPage({ tab });
  const fruits = (page.match(/\[\d+\][^\n]*(苹果|香蕉|榴莲|芒果)/g) || []);
  check('fruit menu (portal, listener-only) opened: its options have numbers', fruits.length >= 3, fruits);
  await js(tab, `document.getElementById('country').click(); return 1;`);
  await wait(400);
  page = await readPage({ tab });
  const regions = page.match(/\[\d+\][^\n\[]*地区 \d{3}/g) || [];
  check('country combobox opened: [展开], its 120 options numbered (portal kept past the cap), 005 disabled',
    /\[展开\]/.test(page) && new Set(regions.map(x => x.match(/地区 (\d{3})/)[1])).size === 120 && /地区 005（不可选）[^\n]*\[禁用\]|\[禁用\][^\n]*地区 005/.test(page),
    `${regions.length} numbered; ${page.match(/[^\n]*地区 005[^\n]*/g)}`);

  // 3. prompt() through AX
  tab = await open('native-ui.html');
  await js(tab, `setTimeout(() => document.getElementById('ask').click(), 200); return 1;`);
  await wait(1200);
  const d = await B.pageDialog();
  res.dialog = d;
  check('prompt: seen through AX, with a text field', d.open && d.hasField, JSON.stringify(d));
  let r = await answerDialogTool({ tab, button: (d.buttons || []).find(b => /确定|OK/.test(b)) || '确定', text: '王小明' }).catch(e => 'ERR ' + e.code + ' ' + e.message);
  await wait(500);
  let outText = await js(tab, `return document.getElementById('out').textContent;`).catch(e => 'ERR ' + e.message);
  res.promptAnswer = { r, outText };
  check('prompt: Chinese text reached the page', /prompt: 王小明/.test(JSON.stringify(outText)), JSON.stringify({ r, outText }));
  await js(tab, `setTimeout(() => document.getElementById('ask').click(), 200); return 1;`);
  await wait(1200);
  const d2 = await B.pageDialog();
  r = await answerDialogTool({ tab, button: (d2.buttons || []).find(b => /取消|Cancel/.test(b)) || '取消' }).catch(e => 'ERR ' + e.code + ' ' + e.message);
  await wait(500);
  outText = await js(tab, `return document.getElementById('out').textContent;`).catch(e => 'ERR ' + e.message);
  check('prompt: Cancel → null', /prompt: null/.test(JSON.stringify(outText)), JSON.stringify({ r, outText }));
  check('no dialog left open', !(await B.pageDialog()).open, '');
} catch (e) {
  res.fatal = { code: e.code, message: String(e.message).slice(0, 500) };
  process.stderr.write(`FATAL ${e.code} ${e.message}\n`);
} finally {
  for (const t of opened) await B.closeTab(t).catch(() => {});
  res.closed = opened;
  writeFileSync(out, JSON.stringify(res, null, 2));
  const n = res.checks.filter(c => c.ok).length;
  console.log(`${n}/${res.checks.length} passed${res.fatal ? ' (FATAL ' + res.fatal.code + ')' : ''}`);
  srv.close?.();
  process.exit(0);
}
