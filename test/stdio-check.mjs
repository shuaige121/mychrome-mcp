#!/usr/bin/env node
/* Start a MyChrome MCP server command over stdio, list its tools and (unless --no-call) call list_tabs.
 * For checking an installed package (npm bin, node_modules/.bin link) against `node src/index.js`.
 *
 *   node test/stdio-check.mjs [--no-call] [--timeout-ms N] -- <command> [args...]
 *
 * Prints one JSON line: tool count and names, and list_tabs' isError and FIRST line only (the rest
 * lists the user's tab titles and URLs). list_tabs is read-only. The server gets a throwaway tab
 * registry and lock dir and no menu-bar app, so starting and stopping it touches none of the user's state.
 * Exit code 0 when the tools were listed (and list_tabs, if called, returned isError false). */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) {
  console.error('usage: node test/stdio-check.mjs [--no-call] [--timeout-ms N] -- <command> [args...]');
  process.exit(2);
}
const opts = argv.slice(0, sep);
const [command, ...args] = argv.slice(sep + 1);
const call = !opts.includes('--no-call');
const timeoutMs = opts.includes('--timeout-ms') ? Number(opts[opts.indexOf('--timeout-ms') + 1]) : 20_000;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mychrome-stdio-'));
const out = { command, args, tools: 0, names: [], listTabs: null, error: null };
const transport = new StdioClientTransport({
  command, args, stderr: 'pipe',
  env: {
    ...process.env,
    CHROME_BRIDGE_MENUBAR: '0',
    CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'agent-tabs-v2'),
    CHROME_BRIDGE_LOCK: path.join(tmp, 'input.lock')
  }
});
let stderr = '';
transport.stderr?.on('data', (d) => { stderr += d; });
const client = new Client({ name: 'mychrome-stdio-check', version: '1.0.0' }, { capabilities: {} });
const within = (p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer within ${timeoutMs} ms`)), timeoutMs))]);

try {
  await within(client.connect(transport), 'connect');
  const { tools } = await within(client.listTools(), 'tools/list');
  out.tools = tools.length;
  out.names = tools.map(t => t.name).sort();
  if (call) {
    const r = await within(client.callTool({ name: 'list_tabs', arguments: {} }), 'list_tabs');
    const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    out.listTabs = { isError: !!r.isError, firstLine: text.split('\n')[0] };
  }
} catch (e) {
  out.error = e && e.message ? e.message : String(e);
}
out.serverStderr = stderr.trim().split('\n').filter(Boolean).slice(0, 3);
try { await within(client.close(), 'close'); } catch {}
rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify(out));
const ok = !out.error && out.tools > 0 && (!call || (out.listTabs && !out.listTabs.isError));
process.exit(ok ? 0 : 1);
