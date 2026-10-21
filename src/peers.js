/**
 * Which other browser tools this user already has (owner, 2026-10-07: "look for Playwright, Codex in
 * Chrome, Claude in Chrome first, and make yourself the fallback"). Read-only, local files only:
 * the MCP client configs, Chrome's extension folders, Playwright's install. Nothing leaves the Mac.
 * The result shapes the server's instructions (src/index.js): use these first, MyChrome last.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Chrome Web Store id of Claude in Chrome (https://chromewebstore.google.com/detail/fcoeoabgfenejglbffodgkkbkcdhcgfn). */
export const CLAUDE_IN_CHROME_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
/** "ChatGPT — Control your browser with ChatGPT" (OpenAI; what ChatGPT and Codex use to drive Chrome), Web Store id, checked 2026-10-07. */
export const CHATGPT_EXTENSION_ID = 'hehggadaopoacecdllhhajmbjkdcmajg';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const list = (p) => { try { return readdirSync(p); } catch { return []; } };

/** MCP servers named in the MCP clients' configs (Claude Code global and per project, Claude Desktop, Cursor, VS Code, Codex), as text to search. */
function mcpConfigs(home) {
  const found = [];
  const add = (servers, where) => {
    for (const [name, s] of Object.entries(servers || {})) found.push({ where, text: `${name} ${s?.command || ''} ${(Array.isArray(s?.args) ? s.args : []).join(' ')} ${s?.url || ''}` });
  };
  const json = (rel) => { try { return JSON.parse(read(path.join(home, rel)) || 'null'); } catch { return null; } };
  const cc = json('.claude.json');
  if (cc) {
    add(cc.mcpServers, 'Claude Code');
    for (const p of Object.values(cc.projects || {})) add(p?.mcpServers, 'Claude Code');
  }
  add(json('Library/Application Support/Claude/claude_desktop_config.json')?.mcpServers, 'Claude Desktop');
  add(json('.cursor/mcp.json')?.mcpServers, 'Cursor');
  add(json('Library/Application Support/Code/User/mcp.json')?.servers, 'VS Code');
  const codex = read(path.join(home, '.codex', 'config.toml'));
  // [mcp_servers.<name>] blocks, each up to the next table header
  for (const m of codex.matchAll(/^\[mcp_servers\.([^\]]+)\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) found.push({ where: 'Codex', text: `${m[1]} ${m[2]}` });
  return found;
}

/** Extension names in every Chrome profile: [{id, name}] (names resolved from _locales when the manifest uses __MSG_…__). */
function chromeExtensions(home) {
  const root = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  const out = [];
  for (const prof of list(root)) {
    const ext = path.join(root, prof, 'Extensions');
    for (const id of list(ext)) {
      const vers = list(path.join(ext, id)).filter(v => !v.startsWith('.'));
      const dir = vers.length ? path.join(ext, id, vers.sort().at(-1)) : null;
      let name = '';
      if (dir) {
        try {
          const man = JSON.parse(read(path.join(dir, 'manifest.json')) || '{}');
          name = man.name || '';
          const msg = name.match(/^__MSG_(.+)__$/);
          if (msg) {
            const loc = man.default_locale || 'en';
            const msgs = JSON.parse(read(path.join(dir, '_locales', loc, 'messages.json')) || '{}');
            const k = Object.keys(msgs).find(x => x.toLowerCase() === msg[1].toLowerCase());
            name = k ? msgs[k].message : name;
          }
        } catch {}
      }
      out.push({ id, name, profile: prof });
    }
  }
  return out;
}

/**
 * @param {{home?: string, execPath?: string}} o  (tests pass a fake home)
 * @returns {{playwrightMcp: string[], playwrightExtension: boolean, devtoolsMcp: string[], playwrightLib: boolean, claudeInChrome: boolean, codexExtension: boolean}}
 *   the *Mcp arrays name the clients whose config has the server (e.g. ["Claude Code", "Codex"])
 */
export function detectPeers({ home = os.homedir(), execPath = process.execPath } = {}) {
  const cfg = mcpConfigs(home);
  const where = (re) => [...new Set(cfg.filter(c => re.test(c.text)).map(c => c.where))];
  const exts = chromeExtensions(home);
  const globalModules = path.join(path.dirname(execPath), '..', 'lib', 'node_modules');
  return {
    playwrightMcp: where(/@playwright\/mcp|playwright-mcp|\bplaywright\b/i),
    // Playwright MCP's extension mode (--extension) drives the user's logged-in Chrome through its extension
    playwrightExtension: cfg.some(c => /@playwright\/mcp|playwright-mcp/i.test(c.text) && /--extension\b/.test(c.text)),
    devtoolsMcp: where(/chrome-devtools-mcp/i),
    playwrightLib: existsSync(path.join(globalModules, 'playwright')) || existsSync(path.join(home, 'Library', 'Caches', 'ms-playwright')),
    claudeInChrome: exts.some(e => e.id === CLAUDE_IN_CHROME_ID),
    codexExtension: exts.some(e => e.id === CHATGPT_EXTENSION_ID || /\bcodex\b/i.test(e.name)),
  };
}

/**
 * The server's instructions: which tool to use for which page, with what this user has, MyChrome last.
 * Said once here instead of in every tool's description.
 */
export function routingInstructions(p) {
  const pwWhere = p.playwrightMcp.length ? `Playwright MCP (configured in ${p.playwrightMcp.join(' and ')})` : p.playwrightLib ? 'Playwright (installed here; headless)' : 'Playwright headless';
  const ext = [p.claudeInChrome ? 'Claude in Chrome (installed here)' : '', p.codexExtension ? 'the ChatGPT / Codex Chrome extension (installed here)' : '', p.playwrightExtension ? 'Playwright MCP in extension mode (configured here)' : ''].filter(Boolean);
  const found = p.playwrightMcp.length || p.devtoolsMcp.length || p.playwrightLib || ext.length;
  const lines = [
    'This server (MyChrome) drives the user\'s OWN Chrome with the real mouse and keyboard (it briefly takes them over). It is the fallback, not the first choice. ' +
      `Route each page to the first tool that fits and that you actually have in this session${found ? ' ("installed here" means on this Mac, not necessarily connected to you)' : ''}:`,
    '1. Public page or API → WebFetch, curl or the API.',
    `2. JavaScript page that needs no login → ${pwWhere}.`,
    p.devtoolsMcp.length ? `   Debugging the user's own web app → Chrome DevTools MCP (configured in ${p.devtoolsMcp.join(' and ')}).` : '',
    ext.length ? `3. Needs the user's logged-in browser and an extension is fine → ${ext.join(' or ')}.` : '',
    `${ext.length ? 4 : 3}. Otherwise → MyChrome: the site blocks automation (403/429, a challenge page, a bot-blocking login wall), the page needs the user's login, ` +
      'you work on a page the user has open, the user asks for their Chrome, or the tools above failed or are not in this session. open_tab with `why`, then read_page and the action tools.',
    'A CAPTCHA or bot check is the user\'s: MyChrome stops (site_blocked); call wait_for_user. Never solve it or switch tools to get around it.',
    'A field only the user should fill (a password, a one-time code, details you were not given): instead of asking in chat, call wait_for_user ' +
      'with `field` (its number) and `reason`; the field is highlighted for them and the call returns once they press Return in it.',
    'Using it: read_page gives numbered elements ([12]) within a token budget — click/type_text/select_option take those numbers; ' +
      'for a multi-step job call task_plan ONCE for the whole job; when an element has no number, screenshot then click_at.',
    'list_tabs and read_page do not take the input lock. A new agent can discover and read existing authorized tabs while another agent works; mine:true only filters discovery. Physical input and opening tabs still queue. ' +
      'Do not treat another agent\'s ownership label as a read prohibition; do not close or modify its tab without a handoff.',
    'A task_plan keeps ONE continuous takeover across actions and reading. When a supported host provides a verified conversation binding, the sidebar mirrors its existing visible assistant messages; check task_plan\'s stream status. Do not generate extra notes or guessed completion checklists. ' +
      'Call done:true only after the whole job finishes or is abandoned, never between steps. Standalone actions give control back after each call. Esc pressed twice returns user_cancelled: ' +
      'ask the user, do not retry. Waits for the user or for another agent (one mouse; calls queue) happen inside the call: do not retry those yourself.',
    'If MyChrome itself cannot reach something, screenshot + click_at first; Claude in Chrome is the next step (it does not queue with MyChrome). ' +
      'computer use can see browsers but not click in them.',
    'A failure about a macOS permission or Chrome\'s Apple Events switch is one-time setup: ask the user to run `mychrome-mcp doctor` in a terminal, which says what to click.',
  ];
  return lines.filter(Boolean).join('\n');
}
