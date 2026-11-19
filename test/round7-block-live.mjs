#!/usr/bin/env node
import { refuseUnsafeLegacy, requireUnlocked } from './live-guard.mjs';
refuseUnsafeLegacy('round7-block-live.mjs');
/* Round 7, live and without takeover: does the block check see real CAPTCHA / 429 pages and leave a normal one alone?
 * Opens and closes its own windows; a real notification (with a sound) is sent for the CAPTCHA, and while
 * wait_for_user waits the menu-bar panel shows the alert.
 *   node test/round7-block-live.mjs <out.json> [waitMinutes] */
const { writeFileSync } = await import('node:fs');
const B = await import('../src/bridge.js');
const tabs = await import('../src/tabs.js');
const { readPage, waitForUserTool } = await import('../src/index.js');
await requireUnlocked();

const [out, waitMin = '0.25'] = process.argv.slice(2);
const wait = ms => new Promise(r => setTimeout(r, ms));
const PAGES = [
  ['recaptcha-demo', 'https://www.google.com/recaptcha/api2/demo', 'captcha'],
  ['http-429', 'https://httpbin.org/status/429', 'rate_limit'],
  ['hacker-news', 'https://news.ycombinator.com/', null],
];
const res = { at: new Date().toISOString(), pages: {} };
const opened = [];
try {
  for (const [name, url, expect] of PAGES) {
    const w = await B.newWindow(url, { left: 200, top: 140, right: 1300, bottom: 900 });
    const t = Number(w.tabId); opened.push(t);
    await tabs.registerTab(t, url, { windowId: w.windowId });
    await wait(4000);
    let code = null, msg = '';
    try { msg = (await readPage({ tab: t })).slice(0, 120); } catch (e) { code = e.code; msg = String(e.message).split('\n')[0].slice(0, 200); }
    const got = code === 'site_blocked' ? (/限制/.test(msg) ? 'rate_limit' : /拒绝/.test(msg) ? 'forbidden' : /检查页/.test(msg) ? 'challenge' : 'captcha') : null;
    res.pages[name] = { expect, got, pass: got === expect, code, msg };
    console.error(`${got === expect ? 'PASS' : 'FAIL'} ${name}: ${code || 'read ok'} — ${msg.slice(0, 100)}`);
    if (name === 'recaptcha-demo' && code === 'site_blocked') {
      const r = await waitForUserTool({ tab: t, minutes: Number(waitMin) });
      res.pages[name].wait = r.split('\n')[0];
      console.error(`wait_for_user: ${res.pages[name].wait}`);
    }
    await B.closeTab(t).catch(() => {}); opened.pop();
  }
} catch (e) { res.fatal = `${e.code} ${String(e.message).slice(0, 300)}`; }
finally {
  for (const t of opened) await B.closeTab(t).catch(() => {});
  writeFileSync(out, JSON.stringify(res, null, 2));
  process.exit(0);
}
