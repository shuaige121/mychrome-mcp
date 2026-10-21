#!/usr/bin/env node
/** A temporary loopback-only practice server. No request logs, persistence, or remote services. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/practice.css': ['practice.css', 'text/css; charset=utf-8'], '/practice.js': ['practice.js', 'text/javascript; charset=utf-8'] };
export const MAX_LIFETIME_MS = 30 * 60 * 1000;

export async function startPracticeServer({ port = 0, lifetimeMs = MAX_LIFETIME_MS } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > MAX_LIFETIME_MS) throw new Error('Practice lifetime must be between 1 ms and 30 minutes.');
  // Load only this explicit public allowlist, once. Never map a request to an arbitrary filesystem path.
  const files = new Map(await Promise.all(Object.entries(FILES).map(async ([route, [file, type]]) => [route, { body: await readFile(path.join(ROOT, file)), type }])));
  const server = http.createServer((req, res) => {
    const route = req.url?.split('?')[0];
    const item = files.get(route);
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expectedHost || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('This local practice server accepts local page reads only.'); return;
    }
    if (!item) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': item.type, 'Content-Length': item.body.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(req.method === 'HEAD' ? undefined : item.body);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  let timer, stopping;
  const close = () => {
    if (!stopping) {
      clearTimeout(timer);
      stopping = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
    }
    return stopping;
  };
  timer = setTimeout(() => void close(), lifetimeMs);
  timer.unref();
  return { server, close, url: `http://127.0.0.1:${server.address().port}/`, expiresInSeconds: Math.ceil(lifetimeMs / 1000) };
}

async function main(args) {
  let port = 0, open = false, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--open') open = true;
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] || '')) port = Number(args[++i]);
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node examples/first-task/serve.mjs [--open] [--json] [--port 0]\nServes only on 127.0.0.1 for up to 30 minutes. Ctrl-C stops it. --open opens the practice in Google Chrome.'); return;
    } else throw new Error(`Unknown option or invalid value: ${args[i]}`);
  }
  const practice = await startPracticeServer({ port });
  const stop = () => { void practice.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  practice.server.once('close', () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
  if (open) {
    try {
      await new Promise((resolve, reject) => execFile('/usr/bin/open', ['-a', '/Applications/Google Chrome.app', practice.url], { timeout: 10000 }, error => error ? reject(error) : resolve()));
    } catch (error) { await practice.close(); throw new Error(`Could not open Chrome: ${error.message}. Run without --open, then open the printed URL yourself.`); }
  }
  const result = { url: practice.url, pid: process.pid, expiresInSeconds: practice.expiresInSeconds };
  process.stdout.write(json ? JSON.stringify(result) + '\n' : `MyChrome practice: ${practice.url}\nKeep this terminal open. Ctrl-C stops the server; it also stops after 30 minutes.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Practice could not start: ${error.message}\n`); process.exitCode = 1; });
}
