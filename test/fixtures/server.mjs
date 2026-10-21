#!/usr/bin/env node
/* Serves test/fixtures/*.html on 127.0.0.1 and logs, as JSON lines, every
 * request's Referer and Sec-Fetch-* headers and every beacon the pages send.
 *
 *   node test/fixtures/server.mjs <log.jsonl> [port]     (default port 4560)
 *
 * /            -> recorder.html
 * /rec.js      -> the <script id="recorder"> block of recorder.html (one
 *                 recorder for every fixture)
 * /beacon      -> POST, body logged, 204
 * Import startFixtureServer() to run it inside a script. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_BEACON = 256 * 1024;

export async function recorderScript() {
  const html = await readFile(path.join(DIR, 'recorder.html'), 'utf8');
  const m = html.match(/<script id="recorder">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('recorder.html has no <script id="recorder"> block');
  return m[1];
}

function headerFields(req) {
  const h = req.headers;
  return {
    referer: h.referer ?? null,
    secFetchSite: h['sec-fetch-site'] ?? null,
    secFetchMode: h['sec-fetch-mode'] ?? null,
    secFetchUser: h['sec-fetch-user'] ?? null,
    secFetchDest: h['sec-fetch-dest'] ?? null
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n <= MAX_BEACON) chunks.push(c); });
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated: n > MAX_BEACON }));
    req.on('error', () => resolve({ text: '', truncated: false }));
  });
}

/**
 * @param opts.port  0 = any free port
 * @param opts.log   path of the JSON-lines log (appended), or null
 * @returns {Promise<{url:string, port:number, entries:object[], close:()=>Promise<void>}>}
 */
export async function startFixtureServer({ port = 4560, log = null } = {}) {
  const out = log ? createWriteStream(log, { flags: 'a' }) : null;
  const entries = [];
  const record = (e) => { entries.push(e); if (out) out.write(JSON.stringify(e) + '\n'); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const base = { t: Date.now(), method: req.method, path: u.pathname + u.search, ...headerFields(req) };
    try {
      if (u.pathname === '/beacon') {
        const { text, truncated } = await readBody(req);
        let body = text;
        try { body = JSON.parse(text); } catch {}
        record({ kind: 'beacon', ...base, contentType: req.headers['content-type'] ?? null, body, truncated });
        res.writeHead(204, { 'cache-control': 'no-store' }); res.end();
        return;
      }
      record({ kind: 'request', ...base });
      if (u.pathname === '/rec.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(await recorderScript());
        return;
      }
      const name = u.pathname === '/' ? 'recorder.html' : u.pathname.slice(1);
      if (!/^[a-z0-9-]+\.html$/.test(name)) { res.writeHead(404); res.end(); return; }
      const html = await readFile(path.join(DIR, name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}/`, port: actual, entries,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => (out ? out.end(resolve) : resolve()));
    })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = process.argv[2];
  if (!log) { console.error('usage: node test/fixtures/server.mjs <log.jsonl> [port]'); process.exit(2); }
  const s = await startFixtureServer({ log, port: Number(process.argv[3] || 4560) });
  console.log(`fixtures at ${s.url}  (recorder.html list.html tall.html fitts.html), log -> ${log}`);
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
