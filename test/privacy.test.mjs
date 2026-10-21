#!/usr/bin/env node
// Synthetic credentials only. No browser, account, logs, or external requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { redactUrl, redactText, redactToolResult } from '../src/privacy.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const hidden = '[redacted]';

await check('OAuth callback credentials and URL userinfo are removed', () => {
  assert.equal(redactUrl('https://alice:secret@example.test/callback?code=short&state=nonce&lang=zh'),
    `https://${hidden}@example.test/callback?code=${hidden}&state=${hidden}&lang=zh`);
  assert.equal(redactUrl('https://example.test/?code=short&state=nonce'),
    `https://example.test/?code=${hidden}&state=${hidden}`);
});

await check('exam tokens and hash routes preserve all navigation structure', () => {
  const url = 'https://example.test/#/exam?paper=math-1&t=short&section=2#question-3';
  assert.equal(redactUrl(url), `https://example.test/#/exam?paper=math-1&t=${hidden}&section=2#question-3`);
  assert.equal(redactUrl('/exam?paper=reading&t=short'), `/exam?paper=reading&t=${hidden}`);
  assert.equal(redactUrl('#/quiz?t=short'), `#/quiz?t=${hidden}`);
});

await check('unambiguous credential keys are case/encoding tolerant and cover duplicates', () => {
  const keys = ['password', 'token', 'access_token', 'id_token', 'refresh_token', 'client_secret',
    'api-key', 'signature', 'X-Amz-Credential', '%61ccess_token'];
  for (const key of keys) {
    assert.equal(redactUrl(`https://example.test/?${key}=synthetic&${key.toUpperCase()}=other`),
      `https://example.test/?${key}=${hidden}&${key.toUpperCase()}=${hidden}`);
  }
});

await check('ordinary state/code/time/key query values remain readable', () => {
  const url = 'https://example.test/search?state=Singapore&t=1700000000&key=title&q=hello%20world&lang=zh#results';
  assert.equal(redactUrl(url), url);
  assert.equal(redactUrl('https://example.test/search?code=SG&key=title'), 'https://example.test/search?code=SG&key=title');
  assert.equal(redactUrl('https://example.test/video?t=1m30s'), 'https://example.test/video?t=1m30s');
  assert.equal(redactUrl('https://example.test/?state=California'), 'https://example.test/?state=California');
});

await check('opaque ambiguous values and signed/API keys are hidden', () => {
  for (const key of ['code', 'state', 't', 'key']) {
    assert.equal(redactUrl(`https://example.test/?${key}=TestOnlyOpaqueValue123`), `https://example.test/?${key}=${hidden}`);
  }
  assert.equal(redactUrl('https://example.test/api?key=short&q=1'), `https://example.test/api?key=${hidden}&q=1`);
  assert.equal(redactUrl('https://example.test/download?key=short&signature=signed'),
    `https://example.test/download?key=${hidden}&signature=${hidden}`);
});

await check('nested encoded redirects are redacted without changing innocent values', () => {
  const nested = 'https://example.test/callback?code=synthetic&state=nonce';
  const url = `https://login.test/authorize?redirect_uri=${encodeURIComponent(nested)}&q=a%2Fb`;
  assert.equal(redactUrl(url),
    `https://login.test/authorize?redirect_uri=${encodeURIComponent(`https://example.test/callback?code=${hidden}&state=${hidden}`)}&q=a%2Fb`);
});

await check('page/OCR/error prose redacts absolute, relative and query-fragment URLs', () => {
  const text = '点击 [here](https://example.test/callback?code=synthetic&state=nonce)。\n' +
    'OCR /exam?paper=1&t=examSynthetic\n?access_token=anotherSynthetic\n正常内容 42';
  const r = redactText(text);
  for (const secret of ['synthetic', 'nonce', 'examSynthetic', 'anotherSynthetic']) assert.ok(!r.includes(secret), secret);
  assert.match(r, /\)\u3002\nOCR/);
  assert.ok(r.endsWith('正常内容 42'));
  assert.equal(redactText('const code = 42; state = ready; t = 1; key = title'), 'const code = 42; state = ready; t = 1; key = title');
});

await check('redaction is idempotent across targetLine and the final MCP boundary', () => {
  for (const input of ['https://example.test/?token=secret',
    '[link](https://example.test/callback?code=short&state=nonce).',
    'https://alice:pass@example.test/?token=secret',
    'See /exam?paper=1&t=short。']) {
    const once = redactText(input);
    assert.equal(redactText(once), once);
  }
});

await check('all MCP text blocks are filtered while images remain byte-for-byte unchanged', () => {
  const image = { type: 'image', data: 'synthetic-image-data-https://x/?token=keep', mimeType: 'image/png' };
  const result = { content: [
    image, { type: 'text', text: 'OCR https://example.test/?access_token=onlyForTest' },
    { type: 'text', text: 'Error /callback?code=short&state=nonce' },
    { type: 'resource', resource: { uri: 'https://example.test/?token=onlyForTest', text: '?password=onlyForTest' } },
  ], isError: true, structuredContent: { url: 'https://example.test/?token=onlyForTest' } };
  const out = redactToolResult(result);
  assert.strictEqual(out.content[0], image);
  assert.equal(out.isError, true);
  assert.ok(JSON.stringify(out.content.slice(1)).includes('[redacted]'));
  assert.ok(!JSON.stringify(out.content.slice(1)).includes('onlyForTest'));
  assert.ok(!JSON.stringify(out.structuredContent).includes('onlyForTest'));
  assert.ok(JSON.stringify(result.content.slice(1)).includes('onlyForTest'), 'input objects must not be mutated');
});

const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = index.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  return index.slice(start, index.indexOf('\n}', start) + 2);
}
await check('the actual callTool boundary sanitizes every result branch and outer errors', async () => {
  let next;
  const ctx = vm.createContext({
    CALL: { run: (_state, fn) => fn() },
    callToolRun: async () => { if (next instanceof Error) throw next; return next; },
    redactText, redactToolResult,
  });
  vm.runInContext(productionFunction('callTool'), ctx);
  for (const name of ['list_tabs', 'open_tab', 'read_page', 'click', 'type_text', 'scroll', 'select_option',
    'task_plan', 'answer_dialog', 'wait_for_user', 'wake_screen', 'click_at', 'press_key', 'hover', 'screenshot']) {
    const image = { type: 'image', data: 'untouched', mimeType: 'image/png' };
    next = { content: [image, { type: 'text', text: 'https://example.test/callback?code=onlyForTest&state=nonce' }], isError: name === 'click' };
    const out = await ctx.callTool({ params: { name, arguments: {} } }, {});
    assert.ok(!JSON.stringify(out).includes('onlyForTest'), name);
    assert.strictEqual(out.content[0], image);
  }
  next = new Error('Failure https://example.test/?access_token=onlyForTest');
  const out = await ctx.callTool({ params: { name: 'read_page' } }, {});
  assert.equal(out.isError, true);
  assert.ok(!JSON.stringify(out).includes('onlyForTest'));
});

await check('targetLine redacts before clipping and leaves original navigation state intact', () => {
  const ctx = vm.createContext({ redactUrl, redactText, clip: (s, n) => s?.length > n ? s.slice(0, n) + '…' : s || '' });
  vm.runInContext(productionFunction('targetLine'), ctx);
  const target = { tabId: 1, title: 'Exam', url: 'https://example.test/#/exam?paper=math&t=onlyForTest' };
  const before = structuredClone(target);
  const out = ctx.targetLine(target);
  assert.ok(!out.includes('onlyForTest'));
  assert.deepEqual(target, before);
});

console.log(`\n${passed} privacy checks passed.`);
