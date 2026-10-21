#!/usr/bin/env node
/* wait_for_user `field` page script (src/page/ask.js) in a real, headless Chromium (Playwright), run the
 * way MyChrome runs it: in an isolated world of the page, as AppleScript `execute javascript` does. What
 * jsdom cannot show: Chromium's own trusted keys and clicks, an IME composition's Return, the closed
 * shadow root and the spotlight letting clicks through, the form's real submit and navigation.
 * Touches neither the user's Chrome nor their keyboard. Needs a global Playwright (npm i -g playwright).
 *   npm run check:ask:chromium [-- --shot out.png]   (screenshot of the armed page, for a look) */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { pageScript } from '../src/bridge.js';
import { startFixtureServer } from './fixtures/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotAt = process.argv.indexOf('--shot');
const shot = shotAt > 0 ? process.argv[shotAt + 1] : null;
let chromium;
try {
  const req = createRequire(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'noop.js'));
  ({ chromium } = req('playwright'));
} catch (e) {
  console.error(`no global Playwright (npm i -g playwright): ${String(e.message).split('\n')[0]}`);
  process.exit(4);
}

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const TEXT = { title: '需要你输入：测试密码', hint: '输入完按回车，AI 会接着做', hintMulti: '输入完按 ⌘+回车，AI 会接着做', brand: 'MyChrome · AI 在等你', tab: '【需要你输入】' };
const SECRET = 'pw-' + Math.random().toString(36).slice(2, 10);

const srv = await startFixtureServer({ port: 0 });
const base = `http://127.0.0.1:${srv.port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  // A fresh isolated world for each call (a navigation drops the old one); globals persist per document, as in Chrome.
  const inWorld = async (expression) => {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'mychrome' });
    const r = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return JSON.parse(r.result.value);
  };
  const read = async () => inWorld(await pageScript('read', { READ: {} }));
  // `entered.at` (when the page saw the Return) is checked here and left out, so the results compare as data.
  const ask = async (a) => {
    const r = await inWorld(await pageScript('ask', { ASK: a }));
    if (r.entered) {
      assert.ok(Number.isFinite(r.entered.at) && Math.abs(r.entered.at - Date.now()) < 5000, `entered.at: ${JSON.stringify(r.entered)}`);
      delete r.entered.at;
    }
    return r;
  };
  const hosts = () => page.evaluate(() => document.querySelectorAll('[data-mychrome-ask]').length);
  const fresh = async () => {
    await page.goto(`${base}/ask.html`);
    const r = await read();
    const pw = Number((r.text.match(/\[(\d+)\][^[\n]*随便输几个字/) || [])[1]);
    const user = Number((r.text.match(/\[(\d+)\][^[\n]*输入框: demo/) || [])[1]);
    const label = Number((r.text.match(/\[(\d+)\] 密码/) || [])[1]);
    assert.ok(pw > 0 && user > 0 && label > 0, r.text);
    return { pw, user, label };
  };

  console.log('src/page/ask.js in headless Chromium, isolated world');
  {
    const m = await fresh();
    const a = await ask({ arm: 't1', marker: m.label, text: TEXT });
    assert.deepEqual([a.ok, a.kind, a.password], [true, 'single', true], JSON.stringify(a));
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.name), 'pw', 'the password field is not focused');
    assert.equal(await hosts(), 1);
    assert.equal(await page.title(), '【需要你输入】MyChrome 输入测试');
    // The page cannot see the isolated world's state, and cannot read into the closed shadow root.
    assert.equal(await page.evaluate(() => typeof window.__chromeBridgeAsk), 'undefined');
    assert.equal(await page.evaluate(() => document.querySelector('[data-mychrome-ask]').shadowRoot), null);
    // Clicks pass through the spotlight, ring and note over the field: the user can click into it (and next to it).
    // (The note sits above the field, over the left end of the user name field: see --shot.)
    const under = async (sel, dx = null) => {
      const b = await page.locator(sel).boundingBox();
      return page.evaluate(([x, y]) => document.elementFromPoint(x, y).getAttribute('name'), [b.x + (dx ?? b.width / 2), b.y + b.height / 2]);
    };
    assert.equal(await under('[name=pw]'), 'pw', 'the highlight catches clicks on the field');
    assert.equal(await under('[name=user]', 20), 'user', 'the note catches clicks on the field it covers');
    if (shot) { await page.waitForTimeout(400); await page.screenshot({ path: shot }); }
    ok('armed from the label\'s number on the password field: focused, page dimmed around it, tab title marked; the page sees neither the isolated world\'s state nor into the shadow root; clicks pass through');

    // A page script's own Return is not the user's.
    await page.evaluate(() => document.querySelector('[name=pw]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    // The user types (real keys): not done yet.
    await page.keyboard.type(SECRET);
    let r = await ask({ read: 't1' });
    assert.deepEqual([r.armed, r.entered], [true, null], JSON.stringify(r));
    // read_page while armed and after: the typed value is never printed.
    assert.doesNotMatch(JSON.stringify(await read()), new RegExp(SECRET));
    // The user's Return: the highlight is gone at once, the title back, done; the value never in the reply.
    await page.keyboard.press('Enter');
    assert.equal(await hosts(), 0, 'the highlight stayed after the Return');
    assert.equal(await page.title(), 'MyChrome 输入测试');
    r = await ask({ read: 't1' });
    assert.deepEqual(r.entered, { how: 'enter', filled: true });
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
    assert.deepEqual(await ask({ read: 't1' }), { ok: true, armed: false }, 'still armed after the agent read it done');
    await page.waitForURL(/done=1/, { timeout: 5000 });
    assert.equal(await hosts(), 0);
    ok('a page\'s synthetic Return and the user\'s typing do not end it; the user\'s Return does (highlight off at once, title back, the form submits and the page moves on); the value is in no result');
  }
  {
    // The page moves on before the agent looks: the next document says the Return brought it (sessionStorage, same origin).
    const m = await fresh();
    await ask({ arm: 'tc', marker: m.pw, text: TEXT });
    await page.keyboard.type(SECRET);
    await page.keyboard.press('Enter');
    await page.waitForURL(/done=1/, { timeout: 5000 });
    const r = await ask({ read: 'tc' });
    assert.equal(r.armed, false);
    assert.equal(r.carried && r.carried.how, 'enter', JSON.stringify(r));
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
    assert.equal(await page.evaluate(() => sessionStorage.length), 0, 'left in sessionStorage');
    ok('the Return survives the page\'s own navigation for the agent\'s next look (read once, nothing left, no value)');
  }
  {
    // An IME composition's Return (choosing a candidate) is not done: on the text field.
    const m = await fresh();
    await ask({ arm: 't2', marker: m.user, text: TEXT });
    await cdp.send('Input.imeSetComposition', { text: 'ceshi', selectionStart: 5, selectionEnd: 5 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Enter', code: 'Enter' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 229, key: 'Enter', code: 'Enter' });
    await cdp.send('Input.insertText', { text: '测试' });
    let r = await ask({ read: 't2' });
    assert.deepEqual([r.armed, r.entered], [true, null], `IME Return counted: ${JSON.stringify(r)}`);
    assert.equal(await hosts(), 1);
    await page.keyboard.press('Enter');
    r = await ask({ read: 't2' });
    assert.equal(r.entered && r.entered.how, 'enter');
    ok('an IME composition\'s Return (keyCode 229) does not end it; the Return after it does');
  }
  {
    // The user clicks the form's submit button instead of pressing Return.
    const m = await fresh();
    await ask({ arm: 't3', marker: m.pw, text: TEXT });
    await page.keyboard.type(SECRET);
    await page.locator('button[type=submit]').click();
    const r = await ask({ read: 't3' });
    assert.deepEqual(r.entered, { how: 'submit', filled: true }, JSON.stringify(r));
    assert.equal(await hosts(), 0);
    ok('a real click on the submit button ends it (submit), highlight off at once');
  }
  {
    // A page that submits by itself (requestSubmit, trusted in Chromium, no click before it) is not the user.
    const m = await fresh();
    await ask({ arm: 't4', marker: m.pw, text: TEXT });
    await page.evaluate(() => document.getElementById('f').requestSubmit());
    const r = await ask({ read: 't4' });
    assert.equal(r.entered, null, JSON.stringify(r));
    await ask({ disarm: 't4' });
    assert.equal(await hosts(), 0);
    assert.equal(await page.title(), 'MyChrome 输入测试');
    ok('the page\'s own requestSubmit() does not end it; disarm removes the highlight and the title mark');
  }
  console.log(`\nask Chromium checks passed (${passed}).`);
} finally {
  await browser.close();
  await srv.close();
}
