// Exercise the production screenshot orchestration without Chrome or a display.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BridgeError } from '../src/bridge.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function readOnlyCapture(');
const geometryStart = source.indexOf('function geometryTarget(');
const geometryCode = source.slice(geometryStart, source.indexOf('\n}', geometryStart) + 2);
const code = geometryCode + '\n' + source.slice(start, source.indexOf('\n}', start) + 2);
function harness({ failedCrop = false, changed = false } = {}) {
  const calls = [];
  const target = { tabId: 7, windowId: 9, chromePid: 42, cgWindow: 70,
    tabActive: true, minimized: false, url: 'https://fixture.invalid/',
    bounds: { left: 0, top: 0, width: 1000, height: 800 } };
  let captured = false;
  const shot = { rect: { x: 0, y: 120, w: 1000, h: 680 }, width: 1000, height: 680,
    fullPath: '/fixture/content-only.png', dispose: async () => calls.push('dispose') };
  const context = vm.createContext({
    BridgeError, Number, Math, Date, SHOTS: new Map(), NATIVE_TARGETS: new Map(),
    CALL: { getStore: () => null },
    pausedCheck() {}, cancelledError: () => new Error('cancelled'), siteGate: async () => {},
    boundsRect: b => ({ x: b.left, y: b.top, w: b.width, h: b.height }),
    ownershipNote: async () => '', targetLine: () => 'tab=7', rememberNativeTarget() {},
    B: {
      cgevent: async () => ({ locked: false, displaysAsleep: false, displays: [{}] }),
      chromeInfo: async () => ({ ...target, ...(captured && changed ? { tabId: 8 } : {}) }),
      axInput: async () => null,
      captureWindow: async () => { throw new Error('whole-window capture reached'); },
      capturePageContent: async t => {
        assert.deepEqual(JSON.parse(JSON.stringify(t)), { cgWindow: 70, chromePid: 42 });
        calls.push('content');
        if (failedCrop) throw new BridgeError('page_content_unavailable', 'content bounds unknown');
        captured = true;
        return shot;
      },
    },
  });
  vm.runInContext(code, context);
  return { calls, shot, run: () => context.readOnlyCapture({ tab: 7 }) };
}

{
  const h = harness(), result = await h.run();
  assert.equal(result.shot, h.shot);
  assert.deepEqual(h.calls, ['content']);
  assert.match(result.head, /网页区域/);
}
{
  const h = harness({ failedCrop: true });
  await assert.rejects(h.run(), error => error.code === 'page_content_unavailable');
  assert.deepEqual(h.calls, ['content'], 'unknown crop must not fall back to browser chrome');
}
{
  const h = harness({ changed: true });
  await assert.rejects(h.run(), error => error.code === 'screenshot_changed');
  assert.deepEqual(h.calls, ['content', 'dispose']);
}
console.log('screenshot-content-scope: 3 groups passed');

{
  const begin = source.indexOf('async function screenshotTool(');
  const captureCode = source.slice(begin, source.indexOf('\n}', begin) + 2);
  const calls = [], shots = new Map();
  const context = vm.createContext({
    BridgeError, Date, Map, SHOTS: shots,
    readOnlyCapture: async () => ({ head: '网页区域：100×80 像素', tabId: 7,
      target:{tabId:7,windowId:9,chromePid:42,cgWindow:70,bounds:{left:0,top:0,width:100,height:200}},
      shot: { data: 'cropped-png', width: 100, height: 80, rect: { x: 0, y: 120, w: 100, h: 80 },
        dispose: async () => calls.push('dispose') } }),
    readShot: async () => { calls.push('ocr'); return { layout: null, error: null }; },
    estimateImageTokens: () => 10, estimateTextTokens: () => 5,
  });
  vm.runInContext(geometryCode + '\n' + captureCode, context);
  const result = await context.screenshotTool({ image: true });
  assert.equal(result.image.data, 'cropped-png');
  assert.deepEqual(calls, ['dispose'], 'image-only requests must not wait for unused OCR');
  assert.equal(shots.get(7).texts.size, 0, 'image coordinates remain usable without OCR ids');
  calls.length = 0;
  await context.screenshotTool({ image: true, ocr: true });
  assert.deepEqual(calls, ['ocr', 'dispose'], 'OCR remains explicitly available with an image');
}
console.log('screenshot image mode: 2 groups passed');
