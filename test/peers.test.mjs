/* src/peers.js: which browser tools the user already has, read from local files only; and the routing instructions
 * built from them (MyChrome last). A fake home directory per case. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPeers, routingInstructions, CLAUDE_IN_CHROME_ID, CHATGPT_EXTENSION_ID } from '../src/peers.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'peers-'));
const put = (h, rel, content) => { const p = path.join(h, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const ext = (h, prof, id, name) => put(h, `Library/Application Support/Google/Chrome/${prof}/Extensions/${id}/1.0_0/manifest.json`, JSON.stringify({ name }));
const noExec = '/nonexistent/bin/node';

console.log('src/peers.js');

t('nothing installed: no tool claimed, the routing still puts MyChrome last and keeps the CAPTCHA rule', () => {
  const p = detectPeers({ home: home(), execPath: noExec });
  assert.deepEqual(p, { playwrightMcp: [], playwrightExtension: false, devtoolsMcp: [], playwrightLib: false, claudeInChrome: false, codexExtension: false });
  const r = routingInstructions(p);
  assert.doesNotMatch(r, /installed here|configured in/);
  assert.match(r, /It is the fallback, not the first choice/);
  assert.match(r, /2\. JavaScript page that needs no login → Playwright headless/);
  assert.match(r, /3\. Otherwise → MyChrome: the site blocks automation/);
  assert.match(r, /Never solve it or switch tools to get around it/);
  assert.match(r, /that you actually have in this session/);
});

t('Playwright MCP in Claude Code (global or per project) and Codex, DevTools MCP, the Playwright install', () => {
  const h = home();
  put(h, '.claude.json', JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp@latest'] } },
    projects: { '/x': { mcpServers: { devtools: { command: 'npx', args: ['chrome-devtools-mcp@latest'] } } } } }));
  put(h, '.codex/config.toml', '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n\n[mcp_servers.other]\ncommand = "x"\n');
  fs.mkdirSync(path.join(h, 'Library/Caches/ms-playwright'), { recursive: true });
  const p = detectPeers({ home: h, execPath: noExec });
  assert.deepEqual(p.playwrightMcp, ['Claude Code', 'Codex']);
  assert.deepEqual(p.devtoolsMcp, ['Claude Code']);
  assert.equal(p.playwrightLib, true);
  const r = routingInstructions(p);
  assert.match(r, /Playwright MCP \(configured in Claude Code and Codex\)/);
  assert.match(r, /Chrome DevTools MCP \(configured in Claude Code\)/);
});

t('extensions in any Chrome profile: Claude in Chrome by id, the ChatGPT/Codex extension by id or name; listed as step 3, MyChrome becomes 4', () => {
  const h = home();
  ext(h, 'Profile 3', CLAUDE_IN_CHROME_ID, 'Claude');
  ext(h, 'Default', CHATGPT_EXTENSION_ID, 'ChatGPT');
  ext(h, 'Default', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '__MSG_appName__');
  const p = detectPeers({ home: h, execPath: noExec });
  assert.deepEqual([p.claudeInChrome, p.codexExtension], [true, true]);
  const r = routingInstructions(p);
  assert.match(r, /3\. Needs the user's logged-in browser and an extension is fine → Claude in Chrome \(installed here\) or the ChatGPT \/ Codex Chrome extension \(installed here\)/);
  assert.match(r, /4\. Otherwise → MyChrome/);
  // an unrelated extension whose name is a message key resolved from _locales
  const h2 = home();
  put(h2, `Library/Application Support/Google/Chrome/Default/Extensions/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/2.0/manifest.json`, JSON.stringify({ name: '__MSG_n__', default_locale: 'en' }));
  put(h2, `Library/Application Support/Google/Chrome/Default/Extensions/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/2.0/_locales/en/messages.json`, JSON.stringify({ n: { message: 'Codex helper' } }));
  assert.equal(detectPeers({ home: h2, execPath: noExec }).codexExtension, true);
});

t('Claude Desktop, Cursor and VS Code configs are read too', () => {
  const h = home();
  put(h, 'Library/Application Support/Claude/claude_desktop_config.json', JSON.stringify({ mcpServers: { browser: { command: 'npx', args: ['@playwright/mcp'] } } }));
  put(h, '.cursor/mcp.json', JSON.stringify({ mcpServers: { dt: { command: 'npx', args: ['chrome-devtools-mcp'] } } }));
  put(h, 'Library/Application Support/Code/User/mcp.json', JSON.stringify({ servers: { pw: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] } } }));
  const p = detectPeers({ home: h, execPath: noExec });
  assert.deepEqual(p.playwrightMcp, ['Claude Desktop', 'VS Code']);
  assert.deepEqual(p.devtoolsMcp, ['Cursor']);
});

t('Playwright MCP with --extension is listed with the logged-in-browser tools; without it, it is not', () => {
  const h = home();
  put(h, '.claude.json', JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp@latest', '--extension'] } } }));
  const p = detectPeers({ home: h, execPath: noExec });
  assert.equal(p.playwrightExtension, true);
  assert.match(routingInstructions(p), /3\. Needs the user's logged-in browser and an extension is fine → Playwright MCP in extension mode/);
  const h2 = home();
  put(h2, '.claude.json', JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] } } }));
  assert.equal(detectPeers({ home: h2, execPath: noExec }).playwrightExtension, false);
});

t('broken or odd files never throw: a bad .claude.json, an empty config, an extension without a manifest', () => {
  const h = home();
  put(h, '.claude.json', '{ not json');
  put(h, '.codex/config.toml', '');
  fs.mkdirSync(path.join(h, 'Library/Application Support/Google/Chrome/Default/Extensions/cccccccccccccccccccccccccccccccc'), { recursive: true });
  const p = detectPeers({ home: h, execPath: noExec });
  assert.deepEqual([p.playwrightMcp, p.claudeInChrome], [[], false]);
});

console.log(`\n${passed} test groups passed.`);
