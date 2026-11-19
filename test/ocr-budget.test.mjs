// Production wrapper, mocked process boundary: no screen capture or input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BridgeError, humanMessage } from '../src/bridge.js';
const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const start = source.indexOf('async function cgevent(');
const body = source.slice(start, source.indexOf('\n}', start) + 2);
let calls = [], failure;
const context = vm.createContext({ BridgeError, humanMessage, CGEVENT: '/fake/helper',
  execFileP: async (_bin, args, options) => {
    calls.push({ args, options });
    if (failure) throw failure;
    return { stdout: '{"ok":true}' };
  } });
vm.runInContext(body, context);
await context.cgevent(['ocr', '/fake/image.png']);
await context.cgevent(['click', 10, 20]);
assert.deepEqual(calls.map(c => c.options.timeout), [60000, 30000]);
failure = Object.assign(new Error('terminated'), { killed: true, signal: 'SIGTERM' });
await assert.rejects(context.cgevent(['ocr', '/fake/image.png']), { code: 'ocr_timeout' });
assert.equal(calls.length, 3, 'no retry or recapture after OCR timeout');
failure = new Error('native failure');
await assert.rejects(context.cgevent(['ocr', '/fake/image.png']), { code: 'ocr_failed' });
failure = Object.assign(new Error('structured failure'), { stdout: '{"error":"bad_image","message":"invalid image"}' });
await assert.rejects(context.cgevent(['ocr', '/fake/image.png']), { code: 'bad_image' });
failure = Object.assign(new Error('not installed'), { code: 'ENOENT' });
await assert.rejects(context.cgevent(['ocr', '/fake/image.png']), { code: 'helper_missing' });
console.log('ocr-budget: separate bounded OCR, input budget and accurate failures passed');
