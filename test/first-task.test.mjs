import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { JSDOM } from 'jsdom';
import { startPracticeServer, MAX_LIFETIME_MS } from '../examples/first-task/serve.mjs';

test('loopback practice serves explicit assets only, with no network/form permissions', async () => {
  const p = await startPracticeServer();
  try {
    assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.equal(p.expiresInSeconds, 1800);
    const response = await fetch(p.url); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'; form-action 'none'/);
    assert.match(await response.text(), /MyChrome practice/);
    for (const route of ['practice.css', 'practice.js']) assert.equal((await fetch(p.url + route)).status, 200);
    for (const route of ['README.md', 'serve.mjs', 'package.json', '%2e%2e/package.json', 'missing']) assert.equal((await fetch(p.url + route)).status, 404);
    assert.equal((await fetch(p.url, { method: 'POST', body: 'nothing is saved' })).status, 403);
    const status = await new Promise((resolve, reject) => { const req = http.get(p.url, { headers: { Host: 'other-site.example' } }, r => { r.resume(); resolve(r.statusCode); }); req.once('error', reject); });
    assert.equal(status, 403);
  } finally { await p.close(); }
  assert.equal(p.server.listening, false); await p.close();
});

test('server lifetime is bounded and expiration closes its port', async () => {
  await assert.rejects(startPracticeServer({ lifetimeMs: MAX_LIFETIME_MS + 1 }), /30 minutes/);
  await assert.rejects(startPracticeServer({ port: -1 }), /Port/);
  const p = await startPracticeServer({ lifetimeMs: 35 });
  await once(p.server, 'close'); assert.equal(p.server.listening, false);
});

test('practice starts empty and only saves submitted valid values in visible DOM', async () => {
  const html = await readFile(new URL('../examples/first-task/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../examples/first-task/practice.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:45678/', runScripts: 'outside-only' });
  try {
    const { window: w } = dom, d = w.document;
    w.fetch = () => { throw new Error('Network must never be used'); };
    w.eval(script);
    assert.equal(d.getElementById('saved-result').hidden, true);
    assert.match(d.getElementById('task-prompt').value, /http:\/\/127\.0\.0\.1:45678\//);
    const submit = () => d.getElementById('plan-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    submit(); assert.equal(d.getElementById('saved-result').hidden, true);
    d.getElementById('plan-name').value = 'Visit the weekend market';
    d.getElementById('plan-name').dispatchEvent(new w.Event('input'));
    d.getElementById('plan-when').value = 'Saturday morning'; submit();
    assert.equal(d.getElementById('saved-result').hidden, false); assert.equal(d.getElementById('saved-plan').textContent, 'Visit the weekend market'); assert.equal(d.getElementById('saved-when').textContent, 'Saturday morning');
    d.getElementById('plan-name').value = '<img src=x onerror=alert(1)>'; submit();
    assert.equal(d.getElementById('saved-plan').textContent, '<img src=x onerror=alert(1)>'); assert.equal(d.getElementById('saved-plan').children.length, 0);
    assert.equal(w.localStorage.length, 0); assert.equal(w.sessionStorage.length, 0); assert.equal(d.cookie, '');
  } finally { dom.window.close(); }
});

test('headless CLI emits one ready URL and closes on SIGTERM without opening Chrome', async () => {
  const child = spawn(process.execPath, [new URL('../examples/first-task/serve.mjs', import.meta.url).pathname, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const closed = once(child, 'close');
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Practice startup timed out')), 5000);
      child.stdout.on('data', b => { stdout += b; if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout)); } });
      child.once('error', reject);
    });
    assert.equal(ready.pid, child.pid); assert.equal((await fetch(ready.url)).status, 200); assert.equal(ready.expiresInSeconds, 1800);
  } finally { child.kill('SIGTERM'); await closed; }
  assert.equal(stdout.trim().split('\n').length, 1); assert.equal(stderr, '');
});
