/* Real Chromium native temporal segments, isolated-world production page scripts.
 * Production typeInSession runs with input delivered through an isolated headless
 * browser. This never connects to the user's Chrome or posts OS input.
 * PLAYWRIGHT_MODULE can name a local playwright/cli.js; otherwise use global npm.
 * It validates trusted browser input, not macOS AX/CGEvent integration. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pageScript, BridgeError } from '../src/bridge.js';
import { planTemporalKeys } from '../src/temporal.js';
import { typedCount, typingSegments } from '../src/guard.js';
import { viewportOrigin, rectToScreenRect } from '../src/coords.js';

const require = createRequire(process.env.PLAYWRIGHT_MODULE ||
  path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'noop.js'));
const { chromium } = require('playwright');
const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true });
let passed = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const cdp = await page.context().newCDPSession(page);
  const inWorld = async expression => {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'mychrome-temporal',
    });
    const r = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return JSON.parse(r.result.value);
  };
  let posts = [], probeHook = null, postHook = null, observed = null;
  const prep = { chromePid: 1, cgWindow: 2, target: { tabId: 7, bounds: { left: 0, top: 0, width: 1000, height: 700 } } };
  const getOrigin = async () => viewportOrigin(prep.target.bounds, await page.evaluate(() => ({
    innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY,
  })));
  const B = {
    pageScript, evalInPage: inWorld,
    axInput: async () => {
      if (probeHook) return probeHook();
      const origin = await getOrigin();
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const segments = [];
      for (const n of nodes.filter(n => n.role?.value === 'spinbutton')) {
        const props = Object.fromEntries((n.properties || []).map(p => [p.name, p.value.value]));
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId });
        const xs = model.border.filter((_, i) => i % 2 === 0), ys = model.border.filter((_, i) => i % 2 === 1);
        segments.push({ role: 'AXIncrementor', description: n.name?.value || '', min: props.valuemin,
          max: props.valuemax, rect: rectToScreenRect({ x: Math.min(...xs), y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }, origin) });
      }
      return { frontmost: true, windowMatches: true, nativePopup: false, menuOpen: false, segments };
    },
  };
  const ctx = { step() {}, panel() {}, observe(fn) { observed = fn; } };
  const c = vm.createContext({
    B, BridgeError, Date, Number, String, Math, planTemporalKeys, typedCount, typingSegments, rectToScreenRect,
    originFor: loc => viewportOrigin(loc.bounds, loc.view), targetLine: () => 'tab 7',
    newToken: () => `t-${Math.random()}`, locateTarget: async () => ({}),
    scrollToTarget: async () => {}, sleep: ms => new Promise(r => setTimeout(r, ms)),
    clickDeliver: async () => { throw new Error('a date field must not use the generic focus click'); },
    post: async (_s, _ctx, _kind, req) => {
      posts.push(req);
      if (postHook) return postHook(req);
      if (req.op === 'click') {
        const o = await getOrigin();
        await page.mouse.click((req.aim.x - o.originX) / o.scale, (req.aim.y - o.originY) / o.scale);
      } else if (req.op === 'type') await page.keyboard.type(req.text);
      else if (req.op === 'key') await page.keyboard.press(req.name === 'return' ? 'Enter' : req.name);
      else throw new Error(`unexpected native input op: ${req.op}`);
      return { typed: req.text ? typedCount(req.text) : 0 };
    },
    readAfter: async () => inWorld(await pageScript('after', { MARKER: 1, EXPECT: null, BIND: null })),
    waitForNavigation: async () => null, ledgerNavigated() {},
  });
  vm.runInContext(['temporalState', 'typeTemporalInSession', 'typeInSession'].map(productionFunction).join('\n'), c);
  const fresh = async (type, attrs = '') => {
    posts = []; probeHook = null; postHook = null; observed = null;
    await page.setContent(`<style>input{font-size:24px;margin:40px;width:420px}</style>
      <form><input id="field" type="${type}" ${attrs}><button>Submit</button></form><button id="other">Other</button>`);
    await inWorld(`window.__chromeBridge={url:location.href,markers:[null,document.getElementById('field')]};JSON.stringify(true)`);
    await page.evaluate(() => {
      window.events = []; window.submitted = 0;
      for (const kind of ['input', 'change', 'keydown', 'paste']) {
        document.querySelector('input').addEventListener(kind, e => events.push({ kind, trusted: e.isTrusted }));
      }
      document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); window.submitted++; });
    });
  };
  const type = (text, rest = {}) => c.typeInSession({}, prep, ctx, { marker: 1, text, ...rest });
  const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

  for (const [kind, attrs, value] of [
    ['date', 'value="2024-01-31"', '2028-02-29'],
    ['month', 'value="2024-01"', '2026-10'],
    ['week', 'value="2024-W01"', '2026-W43'],
    ['time', 'value="08:05"', '13:45'],
    ['time', 'step="0.001" value="08:05:07.123"', '13:45:09.250'],
    ['datetime-local', 'value="2024-01-31T08:05"', '2026-10-20T13:45'],
  ]) await check(`${kind} ${value}: real segment keys replace the old value and confirm exactly`, async () => {
    await fresh(kind, attrs);
    const out = await type(value);
    assert.match(out, /已逐段按键输入，并确认/);
    assert.equal(await page.locator('#field').inputValue(), value);
    const events = await page.evaluate(() => window.events);
    assert.ok(events.some(e => e.kind === 'input'), JSON.stringify(events));
    assert.ok(events.every(e => e.trusted && e.kind !== 'paste'), JSON.stringify(events));
    assert.ok(posts.every(p => ['click', 'type'].includes(p.op)));
    assert.equal(await page.evaluate(() => typeof window.__chromeBridgeTemporal), 'undefined');
  });
  await check('invalid date, range and step are rejected before any click or key', async () => {
    for (const [kind, attrs, value] of [['date', '', '2026-02-29'], ['date', 'min="2026-10-21"', '2026-10-20'],
      ['time', '', '13:45:01']]) {
      await fresh(kind, attrs);
      await assert.rejects(type(value), e => e.code === 'invalid_temporal_value');
      assert.equal(posts.length, 0);
    }
  });
  await check('unknown native layout does not type guessed values', async () => {
    await fresh('date');
    probeHook = () => ({ frontmost: true, windowMatches: true, segments: [] });
    await assert.rejects(type('2026-10-20'), e => e.code === 'temporal_layout_unknown');
    assert.equal(posts.length, 0);
  });
  await check('replacement on first input stops before another segment and reports partial input', async () => {
    await fresh('date', 'value="2024-01-31"');
    await page.evaluate(() => document.querySelector('input').addEventListener('input', e =>
      e.target.replaceWith(e.target.cloneNode()), { once: true }));
    await assert.rejects(type('2026-10-20'), e => e.code === 'temporal_field_changed' && /一部分/.test(e.message));
    assert.equal(posts.filter(p => p.op === 'type').length, 1);
  });
  await check('keys that do not change the field never produce success or submit', async () => {
    await fresh('date', 'value="2024-01-31"');
    postHook = async req => {
      if (req.op === 'click') await page.locator('#field').focus();
      return { typed: req.text ? typedCount(req.text) : 0 };
    };
    await assert.rejects(type('2026-10-20', { submit: true }), e => e.code === 'temporal_unconfirmed');
    assert.equal(posts.filter(p => p.op === 'key').length, 0);
    assert.equal(await page.evaluate(() => window.submitted), 0);
  });
  await check('submit follows exact value confirmation and sends a trusted Return', async () => {
    await fresh('date');
    await type('2026-10-20', { submit: true });
    assert.equal(posts.at(-1).name, 'return');
    assert.equal(await page.evaluate(() => window.submitted), 1);
    assert.match((await observed()).out, /按下回车/);
  });
  console.log(`\n${passed} native temporal Chromium checks passed.`);
} finally {
  await browser.close();
}
