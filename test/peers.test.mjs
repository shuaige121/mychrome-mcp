/* src/peers.js: which browser tools the user already has, read from local files only; and the routing instructions
 * built from them (MyChrome last, except the user's visible page or own Chrome: MyChrome first, ROUTE1). A fake home
 * directory per case. Groups are tagged [new] (ROUTE1: fail with src/peers.js at 3acd761) or [kept]; a failed group
 * prints `FAIL  [tag] name`, the rest still run, and the exit code is 1. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPeers, routingInstructions, CLAUDE_IN_CHROME_ID, CHATGPT_EXTENSION_ID } from '../src/peers.js';

let passed = 0, failed = 0;
const run = (tag, name, fn) => {
  try { fn(); passed++; console.log(`  ok    [${tag}] ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  [${tag}] ${name}\n        ${String(e.message).split('\n').slice(0, 6).join('\n        ')}`); }
};
const t = (name, fn) => run('kept', name, fn);
const tNew = (name, fn) => run('new', name, fn);
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
  assert.ok(r.includes("3. Needs the user's logged-in browser and an extension is fine → Claude in Chrome or the ChatGPT / Codex Chrome extension " +
    '(extension files found in a Chrome profile on this Mac; not verified to be connected in this session, and they act in their own browser context, ' +
    'not necessarily the window in front of the user).'), r);
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
  assert.ok(routingInstructions(p).includes("3. Needs the user's logged-in browser and an extension is fine → Playwright MCP in extension mode " +
    "(Playwright MCP's --extension in an MCP client config; not verified to be connected in this session,"), routingInstructions(p));
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

/* ── ROUTE1 (contracts-batch4.md, inv-batch4/final.md ruling 9): the user's visible page goes to MyChrome ──
 * Every peer combination detectPeers can report (each field absent or present: 2^6 = 64 fixtures). These prove the
 * text's structure and consistency, not that a model obeys it. */
const CLAUSE = 'If the user asks you to work on a page they already have open, to collaborate on their visible page, or to use their own Chrome, ' +
  'use MyChrome on that exact tab. This takes precedence over every route below.';
const BLOCKER = 'If MyChrome cannot act on the page the user needs, keep that page requirement and report the blocker; screenshot + click_at is for an element ' +
  'with no number, not for a focus refusal, a user stop or a site challenge. Never switch browser tools to get around any of those.';
const LIMITS = '; not verified to be connected in this session, and they act in their own browser context, not necessarily the window in front of the user).';
const FIELDS = [['playwrightMcp', [], ['Claude Code', 'Codex']], ['playwrightExtension', false, true], ['devtoolsMcp', [], ['Cursor']],
  ['playwrightLib', false, true], ['claudeInChrome', false, true], ['codexExtension', false, true]];
const FIXTURES = Array.from({ length: 1 << FIELDS.length }, (_, n) => {
  const p = Object.fromEntries(FIELDS.map(([k, off, on], i) => [k, (n >> i) & 1 ? on : off]));
  const name = FIELDS.filter((f, i) => (n >> i) & 1).map(([k]) => k).join('+') || 'zero-peer';
  return { p, name, r: routingInstructions(p) };
});
const hasExt = p => p.claudeInChrome || p.codexExtension || p.playwrightExtension;
/** Each route in the text, with the requests it covers. A request goes to the first covering route in text order
 * ("Route each page to the first tool that fits"); a route missing from the text covers nothing. */
const ROUTES = [
  { find: CLAUSE, to: 'MyChrome, exact tab', covers: q => !!(q.visible || q.ownChrome) },
  { find: /^1\. Public page or API → WebFetch, curl or the API\./m, to: 'WebFetch / curl / API', covers: q => q.kind === 'public' },
  { find: /^2\. JavaScript page that needs no login → [^\n]*Playwright/m, to: 'Playwright', covers: q => q.kind === 'js' },
  { find: /^3\. Needs the user's logged-in browser and an extension is fine → /m, to: 'extension', covers: q => q.kind === 'login' && !!q.extensionFine },
  { find: /^\d\. Otherwise → MyChrome: /m, to: 'MyChrome', covers: () => true },
];
const route = (r, q) => ROUTES.map(x => ({ ...x, at: typeof x.find === 'string' ? r.indexOf(x.find) : r.search(x.find) }))
  .filter(x => x.at >= 0).sort((a, b) => a.at - b.at).find(x => x.covers(q))?.to ?? 'none';
const SCENARIOS = [
  ['visible page, public', { visible: true, kind: 'public' }, () => 'MyChrome, exact tab'],
  ['visible page, JavaScript only', { visible: true, kind: 'js' }, () => 'MyChrome, exact tab'],
  ['visible page, needs login (an extension would be fine)', { visible: true, kind: 'login', extensionFine: true }, () => 'MyChrome, exact tab'],
  ['user asks for their own Chrome, public page', { ownChrome: true, kind: 'public' }, () => 'MyChrome, exact tab'],
  ['unwatched page, public', { kind: 'public' }, () => 'WebFetch / curl / API'],
  ['unwatched page, JavaScript only', { kind: 'js' }, () => 'Playwright'],
  ['unwatched page, needs login, an extension is fine', { kind: 'login', extensionFine: true }, p => hasExt(p) ? 'extension' : 'MyChrome'],
  ['unwatched page, needs login, no extension', { kind: 'login' }, () => 'MyChrome'],
  ['unwatched site that blocks automation', { kind: 'blocked' }, () => 'MyChrome'],
];

t('the fixtures match detection: an empty home is combination 0, a home with everything is combination 63', () => {
  const h = home();
  put(h, '.claude.json', JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp@latest', '--extension'] } } }));
  put(h, '.codex/config.toml', '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n');
  put(h, '.cursor/mcp.json', JSON.stringify({ mcpServers: { dt: { command: 'npx', args: ['chrome-devtools-mcp'] } } }));
  fs.mkdirSync(path.join(h, 'Library/Caches/ms-playwright'), { recursive: true });
  ext(h, 'Default', CLAUDE_IN_CHROME_ID, 'Claude');
  ext(h, 'Profile 1', CHATGPT_EXTENSION_ID, 'ChatGPT');
  assert.deepEqual(detectPeers({ home: home(), execPath: noExec }), FIXTURES[0].p);
  assert.deepEqual(detectPeers({ home: h, execPath: noExec }), FIXTURES[63].p);
  assert.equal(new Set(FIXTURES.map(f => f.r)).size > 1, true);
});

tNew('precedence-clause-first: in all 64 peer combinations the visible-page clause appears once, before the routing sentence and every numbered route; the fallback sentence is limited to pages the user is not watching', () => {
  for (const { name, r } of FIXTURES) {
    assert.equal(r.split(CLAUSE).length - 1, 1, `${name}: the precedence clause is not there exactly once\n${r}`);
    const at = r.indexOf(CLAUSE);
    assert.ok(at < r.indexOf('Route each page to the first tool that fits'), `${name}: the clause comes after the routing sentence`);
    for (const m of r.matchAll(/^\d+\. /gm)) assert.ok(m.index > at, `${name}: route "${r.slice(m.index, m.index + 30)}" comes before the clause`);
    assert.ok(r.includes('It is the fallback, not the first choice, for pages the user is not watching.'), `${name}: the fallback sentence is unqualified`);
  }
});

tNew('visible-page-routing-matrix: a visible page that is public, JavaScript-only or needs login, or a request for the user\'s own Chrome, goes to MyChrome on that exact tab in every combination; unwatched pages keep their routes', () => {
  const bad = [], counts = new Map();
  for (const { p, name, r } of FIXTURES) {
    for (const [sid, q, want] of SCENARIOS) {
      const got = route(r, q);
      const k = `${sid} → ${got}`; counts.set(k, (counts.get(k) || 0) + 1);
      if (got !== want(p)) bad.push(`${name} / ${sid}: ${got}, expected ${want(p)}`);
    }
  }
  console.log(`        routing matrix: ${FIXTURES.length} fixtures × ${SCENARIOS.length} requests = ${FIXTURES.length * SCENARIOS.length} cells, ${bad.length} wrong`);
  for (const [k, n] of counts) console.log(`          ${k} ×${n}`);
  assert.deepEqual(bad.slice(0, 8), [], `${bad.length} cells routed wrongly`);
});

tNew('no-switch-after-mychrome-blocker: every combination keeps the page requirement and reports the blocker; no line sends a MyChrome failure to another browser tool; an extension is named only when detected', () => {
  for (const { p, name, r } of FIXTURES) {
    assert.ok(r.includes(BLOCKER + ' computer use can see browsers but not click in them.'), `${name}: the blocker sentence is missing\n${r}`);
    assert.doesNotMatch(r, /Claude in Chrome is the next step|does not queue with MyChrome|MyChrome itself cannot reach/, name);
    for (const line of r.split('\n').filter(l => /MyChrome (?:itself )?cannot|cannot (?:act|reach)/.test(l)))
      assert.doesNotMatch(line, /Claude in Chrome|ChatGPT|Codex|Playwright|DevTools|WebFetch|curl/, `${name}: ${line}`);
    if (!p.claudeInChrome) assert.doesNotMatch(r, /Claude in Chrome/, `${name}: names Claude in Chrome without detecting it`);
    if (!p.codexExtension) assert.doesNotMatch(r, /ChatGPT|Codex Chrome extension/, `${name}: names the ChatGPT/Codex extension without detecting it`);
    if (!p.playwrightExtension) assert.doesNotMatch(r, /extension mode/, `${name}: names Playwright extension mode without detecting it`);
  }
});

tNew('detection-is-not-connectivity: no combination says "installed here"; the extension route says what was found and that it is not verified connected nor bound to the window in front of the user', () => {
  for (const { p, name, r } of FIXTURES) {
    assert.doesNotMatch(r, /installed here|configured here/, name);
    const rule3 = r.split('\n').find(l => l.startsWith('3. Needs the user\'s logged-in browser'));
    assert.equal(!!rule3, hasExt(p), `${name}: rule 3 present ${!!rule3}`);
    if (rule3) {
      assert.ok(rule3.endsWith(LIMITS), `${name}: ${rule3}`);
      assert.equal(rule3.includes('(extension files found in a Chrome profile on this Mac'), p.claudeInChrome || p.codexExtension, `${name}: ${rule3}`);
      assert.equal(rule3.includes('Playwright MCP\'s --extension in an MCP client config'), p.playwrightExtension, `${name}: ${rule3}`);
    }
    if (p.playwrightLib && !p.playwrightMcp.length) assert.ok(r.includes('2. JavaScript page that needs no login → Playwright (found on this Mac; headless).'), name);
  }
});

t('pinned sentences in every combination: CAPTCHA, wait_for_user field, ownership, Esc, computer use, doctor once; numbered routes contiguous, MyChrome the last', () => {
  for (const { p, name, r } of FIXTURES) {
    for (const s of ['It is the fallback, not the first choice', 'that you actually have in this session',
      'A CAPTCHA or bot check is the user\'s: MyChrome stops (site_blocked); call wait_for_user. Never solve it or switch tools to get around it.',
      'instead of asking in chat, call wait_for_user', 'when an element has no number, screenshot then click_at.',
      'Do not treat another agent\'s ownership label as a read prohibition; do not close or modify its tab without a handoff.',
      'Esc pressed twice returns user_cancelled: ask the user, do not retry.', 'computer use can see browsers but not click in them.',
      'one-time setup: ask the user to run `mychrome-mcp doctor` in a terminal'])
      assert.ok(r.includes(s), `${name}: missing "${s}"`);
    assert.equal(r.split('\n').filter(l => /mychrome-mcp doctor/.test(l)).length, 1, name);
    const nums = [...r.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]));
    assert.deepEqual(nums, Array.from({ length: hasExt(p) ? 4 : 3 }, (_, i) => i + 1), name);
    assert.match(r, new RegExp(`^${nums.at(-1)}\\. Otherwise → MyChrome: `, 'm'), name);
  }
});

console.log(`\n${passed} test groups passed${failed ? `, ${failed} FAILED` : ''}.`);
if (failed) process.exit(1);
