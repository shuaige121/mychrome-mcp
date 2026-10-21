/* src/page/block.js in jsdom (layout stubbed: data-rect="x,y,w,h", default 10,10,120,24; "0" = no box).
 * The page wants a human (CAPTCHA, bot check, rate limit, access denied) → blocked; everything that only
 * looks like one (an invisible badge, a solved widget, an SMS-code field, an article about CAPTCHAs) → not. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(path.join(ROOT, 'src/page/block.js'), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

function run(html, { title = '登录', url = 'https://shop.example.test/login' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>${title}</title></head><body>${html}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () {
    for (let a = this; a && a.nodeType === 1; a = a.parentElement) if (w.getComputedStyle(a).display === 'none') return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
    const spec = this.getAttribute('data-rect');
    let [x, y, width, height] = [10, 10, 120, 24];
    if (spec === '0') [x, y, width, height] = [0, 0, 0, 0]; else if (spec) [x, y, width, height] = spec.split(',').map(Number);
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  };
  const r = JSON.parse(w.eval(src));
  assert.equal(r.ok, true);
  return r.blocked;
}
const RC = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc&co=aHR0&hl=zh-CN&size=normal';
const FORM = '<form><input name="user" placeholder="用户名"><input type="password"><button>登录</button></form>';

console.log('src/page/block.js (jsdom, layout stubbed)');

t('reCAPTCHA checkbox on screen → captcha (reCAPTCHA)', () => {
  const b = run(`${FORM}<iframe src="${RC}" data-rect="20,300,304,78"></iframe><textarea id="g-recaptcha-response" name="g-recaptcha-response" style="display:none"></textarea>`);
  assert.deepEqual([b && b.kind, b && b.vendor], ['captcha', 'reCAPTCHA']);
  assert.match(b.evidence, /recaptcha\/api2\/anchor$/, 'evidence: the frame address without its query');
});
t('… solved (its response field filled) → not blocked', () => {
  assert.equal(run(`${FORM}<iframe src="${RC}" data-rect="20,300,304,78"></iframe><textarea name="g-recaptcha-response" style="display:none">03AFcWeA…</textarea>`), null);
});
t('invisible reCAPTCHA (size=invisible badge) and a hidden challenge frame → not blocked', () => {
  assert.equal(run(`${FORM}<iframe src="https://www.google.com/recaptcha/api2/anchor?k=1&size=invisible" data-rect="1200,700,256,60"></iframe>`), null);
  assert.equal(run(`${FORM}<div style="visibility:hidden"><iframe src="https://www.google.com/recaptcha/api2/bframe?k=1" data-rect="300,100,400,580"></iframe></div>`), null);
  assert.equal(run(`${FORM}<iframe src="${RC}" data-rect="0"></iframe>`), null);
});
t('hCaptcha, Turnstile (unsolved) → captcha; Turnstile solved → not', () => {
  assert.equal(run(`<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox" data-rect="20,300,303,78"></iframe>`).vendor, 'hCaptcha');
  const ts = '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/0x4AAA/auto/fbE/new/normal/auto/" data-rect="20,300,300,65"></iframe>';
  assert.equal(run(`${ts}<input type="hidden" name="cf-turnstile-response" value="">`).vendor, 'Cloudflare Turnstile');
  assert.equal(run(`${ts}<input type="hidden" name="cf-turnstile-response" value="0.abc">`), null);
});
t('Chinese sliders and puzzles: 极验, 网易易盾, 阿里滑块, 腾讯 (frame) → captcha; a hidden one → not', () => {
  assert.equal(run('<div class="geetest_panel" data-rect="400,200,340,380"><div class="geetest_slider">拖动滑块</div></div>').vendor, '极验');
  assert.equal(run('<div class="yidun_popup" data-rect="400,200,340,300"></div>').vendor, '网易易盾');
  assert.equal(run('<div id="nc_1_wrapper" data-rect="40,300,300,34"></div>').vendor, '阿里滑块');
  assert.equal(run('<iframe src="https://turing.captcha.qcloud.com/cap_union_new_show?aid=1" data-rect="400,200,360,360"></iframe>').vendor, '腾讯验证码');
  assert.equal(run('<div class="geetest_panel" style="display:none" data-rect="400,200,340,380"></div>'), null);
});
t('Cloudflare interstitial (by its form, or by the title) → challenge', () => {
  assert.equal(run('<div id="challenge-running" data-rect="0,0,800,200">Checking your browser…</div>', { title: 'Just a moment...' }).kind, 'challenge');
  assert.equal(run('<p>Verifying you are human. This may take a few seconds.</p>', { title: '请稍候…' }).kind, 'challenge');
});
t('short error pages: 429 / 访问过于频繁 → rate_limit; 403 → forbidden', () => {
  assert.equal(run('<h1>429 Too Many Requests</h1><hr><center>nginx</center>', { title: '429 Too Many Requests' }).kind, 'rate_limit');
  assert.equal(run('<div>您的访问过于频繁，请稍后再试。</div>', { title: '提示' }).kind, 'rate_limit');
  assert.equal(run('<h1>403 Forbidden</h1>', { title: '403 Forbidden' }).kind, 'forbidden');
  assert.equal(run('<h1>Access Denied</h1><p>You don\'t have permission to access this server.</p>', { title: 'Access Denied' }).kind, 'forbidden');
});
t('the document\'s HTTP status: 429 → rate_limit (any page); 403 → forbidden only on a short page', () => {
  const withStatus = (code, html) => {
    const dom = new JSDOM(`<!doctype html><title>x</title><body>${html}</body>`, { runScripts: 'outside-only' });
    dom.window.performance.getEntriesByType = (k) => k === 'navigation' ? [{ responseStatus: code }] : [];
    dom.window.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34 });
    return JSON.parse(dom.window.eval(src)).blocked;
  };
  assert.deepEqual(withStatus(429, '<p>hello</p>'), { kind: 'rate_limit', vendor: '', evidence: 'HTTP 429' });
  assert.equal(withStatus(403, '<p>no</p>').kind, 'forbidden');
  assert.equal(withStatus(403, '<main>' + '<p>你没有权限查看这个项目的设置，但可以看下面的内容。</p>'.repeat(150) + '</main>'), null);
  assert.equal(withStatus(200, '<p>hello</p>'), null);
});
t('a short page asking for a slider or "verify you are human" → captcha', () => {
  assert.equal(run('<p>请完成安全验证</p><p>拖动下方滑块完成拼图</p>', { title: '安全验证' }).kind, 'captcha');
  assert.equal(run('<p>Please verify you are a human</p>', { title: 'Verify' }).kind, 'captcha');
});
t('NOT blocked: an article about CAPTCHAs (long page), a login with an SMS code, a 4xx number inside an article', () => {
  const long = '<article><h1>如何看待 too many requests 和人机验证</h1>' + '<p>验证码、滑块、403 和 429 都是网站常见的保护手段。'.repeat(150) + '</p></article>';
  assert.equal(run(long, { title: '人机验证的历史' }), null);
  // Short, but the heading only mentions it and the body does not ask for anything.
  assert.equal(run('<h1>如何看待 429 Too Many Requests</h1>' + '<p>网站限流是一种保护手段，下面讲讲原理。</p>'.repeat(5), { title: '博客' }), null);
  assert.equal(run('<form><input placeholder="手机号"><input placeholder="短信验证码"><button>获取验证码</button><button>登录</button></form>'), null);
  assert.equal(run('<h1>订单 403 号已发货</h1>' + '<p>详情</p>'.repeat(10), { title: '订单详情' }), null);
});
t('picture CAPTCHA in a form (code field + its image) → captcha (图形验证码); an SMS field next to an image → not', () => {
  const b = run('<form><input placeholder="用户名"><div><input placeholder="请输入图形验证码" data-rect="20,200,120,30"><img src="/captcha.jpg" data-rect="150,200,100,36"></div></form>');
  assert.deepEqual([b && b.kind, b && b.vendor], ['captcha', '图形验证码']);
  assert.equal(run('<form><div><input placeholder="短信验证码"><img src="/icon.png" data-rect="150,200,40,36"></div></form>'), null);
});
t('the check never stands in the way: an exception inside → not blocked (with the error)', () => {
  const dom = new JSDOM('<!doctype html><body><iframe src="' + RC + '"></iframe></body>', { runScripts: 'outside-only' });
  dom.window.Element.prototype.getBoundingClientRect = () => { throw new Error('boom'); };
  const r = JSON.parse(dom.window.eval(src));
  assert.deepEqual([r.ok, r.blocked], [true, null]);
  assert.match(r.error, /boom/);
});

console.log(`\n${passed} test groups passed.`);
