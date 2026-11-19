/* P2 (2026-10-29): clickReport's browser-URL read and tab list are independent read-only samples and run at
 * the same time; their results apply in the old order and a failed sample stays unknown. (read_page's
 * ownershipNote is not such a sample and stays serial: Codex QA r1 A2.)
 * Also read_page's gate (block.js, then read.js, in one eval): verdicts and failures behave as before P2.
 * Production functions run in a vm against fake bridges; nothing reaches Chrome or the input helper.
 *
 * Run: node test/independent-samples.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BridgeError } from '../src/bridge.js';
import { didClickRegister } from '../src/guard.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function production(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** clickReport's observation loop on a cross-site click: the page still shows the old URL and nothing changed. */
function clickHarness({ listFails = false, infoFails = false } = {}) {
  const events = [];
  let now = 0;
  class Clock extends Date { static now() { return now; } }
  const before = { href: 'https://fixture.test/login', texts: ['Sign in'], dialogs: [],
    targetState: { token: 'same-control', kind: 'button', checked: null } };
  const st = { tab: 5, marker: 3, hrefBefore: before.href, before, ack: { seen: true }, token: 'fixture',
    prep: { target: { tabId: 5 }, ownNote: '' }, listBefore: { windows: [{ id: 1, tabs: [{ id: 5 }] }] } };
  const context = { routineEvidence: null };
  const c = vm.createContext({
    Date: Clock, Number, String, Math, Set, Map, JSON, process: { env: {} }, didClickRegister,
    CALL: { getStore: () => context }, sleep: async ms => { now += ms; },
    clip: (s, n) => String(s || '').slice(0, n), redactUrl: s => s, redactText: s => s,
    waitAck: async () => { throw Error('the acknowledgement is already known'); },
    settledUrl: async (_tab, url) => { events.push('settle'); return url; },
    ledgerNavigated() {}, claimPopups: async () => ({ mine: [], theirs: [] }),
    diffNewTabs: (_before, after) => after.windows[0].tabs.filter(t => t.id !== 5).map(t => ({ tabId: t.id, windowId: 1, title: 'New', url: 'https://fixture.test/new' })),
    targetLine: () => 'tab=5', clickLines: () => [],
    B: {
      pageDialog: async () => { events.push('dialog'); return { open: false }; },
      pageScript: async () => '',
      // G1: the after-click observation carries block.js's verdict from the same eval; this page waits for no one.
      evalInPage: async () => { events.push('observe'); return { ...before, gate: { ok: true, blocked: null } }; },
      chromeInfo: async () => {
        events.push('info start'); await pause(30); events.push('info end');
        if (infoFails) throw new BridgeError('chromectl_failed', 'fixture info failure');
        return { url: 'https://fixture.test/account' };
      },
      listTabs: async () => {
        events.push('list start'); await pause(30); events.push('list end');
        if (listFails) throw new BridgeError('chromectl_failed', 'fixture list failure');
        return { windows: [{ id: 1, tabs: [{ id: 5 }] }] };
      },
    },
  });
  vm.runInContext(['clickObservation', 'clickChanges', 'clickReport'].map(production).join('\n'), c);
  return { run: () => c.clickReport(st), events, context };
}

await check('click observation: the browser URL and the tab list are read together, after the page observation', async () => {
  const h = clickHarness();
  const r = await h.run();
  assert.match(r.out, /^\[3\] → URL已变：https:\/\/fixture\.test\/account/);
  const at = e => h.events.indexOf(e);
  assert.ok(at('observe') >= 0 && at('observe') < at('info start') && at('observe') < at('list start'),
    `the URL read must follow the observation it depends on: ${h.events.join(', ')}`);
  assert.ok(at('list start') < at('info end') && at('info start') < at('list end'),
    `tab list and browser URL ran one after the other: ${h.events.join(', ')}`);
  assert.ok(at('settle') > at('info end') && at('settle') > at('list end'), h.events.join(', '));
  assert.equal(h.context.routineEvidence.confirmed, true);
});

await check('click observation: failed samples stay unknown (no new error path), and both settle before the receipt', async () => {
  const h = clickHarness({ listFails: true, infoFails: true });
  const r = await h.run();
  assert.match(r.out, /^\[3\] → URL未变；点击已发送，结果未确认/);
  assert.equal(h.events.filter(e => e === 'info end').length, h.events.filter(e => e === 'info start').length);
  assert.equal(h.events.filter(e => e === 'list end').length, h.events.filter(e => e === 'list start').length);
  assert.equal(h.context.routineEvidence.confirmed, false);
});

/** read_page's one eval, built by the production gatedReadScript, run against stand-ins for block.js and read.js. */
function gateHarness(block, read = '(function () { globalThis.readRan = true; return JSON.stringify({ ok: true, text: "Fixture text" }); })()') {
  const events = [], blocks = new Map([[5, { kind: 'challenge', site: 'fixture.test' }]]);
  const c = vm.createContext({
    BridgeError, BLOCKS: blocks, HANDOFFS: new Map(), dialogNote: () => '', blockText: () => 'a fixture check',
    writeTaskState: () => events.push('state'),
    markBlocked: async x => { events.push('marked'); return { site: 'fixture.test', kind: x.blocked.kind }; },
    B: {
      pageDialog: async () => { events.push('dialog'); return { open: false }; },
      pageScript: async name => (name === 'block' ? block : read),
      evalInPage: async (src, tab) => {
        events.push('eval');
        const page = {};
        let out;
        try { out = JSON.parse(vm.runInNewContext(src, page)); }
        catch (e) { events.push('eval failed'); throw new BridgeError('chrome_error', `fixture eval failed: ${e.message}`); }
        events.push(page.readRan ? 'read ran' : 'read skipped');
        return { ...out, target: { tabId: tab, url: 'https://fixture.test/' } };
      },
    },
  });
  vm.runInContext(['gatedReadScript', 'readAlone', 'blockCheck', 'blockedSaid', 'siteGate'].map(production).join('\n'), c);
  return { c, events, blocks };
}

// G1 (2026-11-02) reverses this group's earlier outcome (the page was read on an unknown verdict): nothing is read now.
await check('read_page gate: block.js throwing is unknown, as a check that could not run: nothing is read (G1), the old block record stays', async () => {
  const h = gateHarness('(function () { throw new Error("fixture block failure"); })()');
  await assert.rejects(h.c.siteGate(5, { full: true }), e => e.code === 'cannot_check' && /没有读取页面内容/.test(e.message));
  assert.deepEqual(h.events, ['dialog', 'eval', 'read skipped']);
  assert.equal(h.blocks.has(5), true, 'an unknown check must not clear the block record');
});

await check('read_page gate: nothing blocking: the page is read and the old block record is cleared', async () => {
  const h = gateHarness('JSON.stringify({ ok: true, blocked: null })');
  assert.equal((await h.c.siteGate(5, { full: true })).text, 'Fixture text');
  assert.deepEqual(h.events, ['dialog', 'eval', 'read ran', 'state']);
  assert.equal(h.blocks.has(5), false);
});

await check('read_page gate: a challenge stops inside the eval before the read script runs', async () => {
  const h = gateHarness('JSON.stringify({ ok: true, blocked: { kind: "challenge", vendor: "Fixture", evidence: "#challenge-form" } })');
  await assert.rejects(h.c.siteGate(5, { full: true }), e => e.code === 'site_blocked' && /#challenge-form/.test(e.message));
  assert.deepEqual(h.events, ['dialog', 'eval', 'read skipped', 'marked']);
});

await check('read_page gate: read.js throws after a clean check: the old block record is cleared first, then read.js runs on its own and its error surfaces', async () => {
  const h = gateHarness('JSON.stringify({ ok: true, blocked: null })',
    '(function () { globalThis.readRan = true; throw new Error("fixture read failure"); })()');
  await assert.rejects(h.c.siteGate(5, { full: true }), e => e.code === 'chrome_error' && /fixture read failure/.test(e.message));
  assert.deepEqual(h.events, ['dialog', 'eval', 'read ran', 'state', 'dialog', 'eval', 'eval failed']);
  assert.equal(h.blocks.has(5), false);
});

await check('read_page gate: read.js answering not-ok counts as a failed read; the verdict is applied first', async () => {
  const h = gateHarness('JSON.stringify({ ok: true, blocked: null })',
    '(function () { globalThis.readRan = true; return JSON.stringify({ ok: false, error: "page_error" }); })()');
  const page = await h.c.siteGate(5, { full: true });
  assert.equal(page.ok, false, 'the read on its own is returned as evalInPage gives it (the real one throws on not-ok)');
  assert.deepEqual(h.events, ['dialog', 'eval', 'read ran', 'state', 'dialog', 'eval', 'read ran']);
});

await check('read_page gate: the combined eval failing as a whole: the site check runs on its own (here: clears the record), then the read eval', async () => {
  const h = gateHarness('JSON.stringify({ ok: true, blocked: null })',
    '(function () { globalThis.readRan = true; return JSON.stringify({ ok: true, text: "Fixture text" }); })()');
  let first = true;
  const run = h.c.B.evalInPage;
  h.c.B.evalInPage = async (...a) => { if (first) { first = false; h.events.push('combined failed'); throw new BridgeError('chromectl_failed', 'fixture'); } return run(...a); };
  assert.equal((await h.c.siteGate(5, { full: true })).text, 'Fixture text');
  assert.deepEqual(h.events, ['dialog', 'combined failed', 'dialog', 'eval', 'read skipped', 'state', 'dialog', 'eval', 'read ran']);
  assert.equal(h.blocks.has(5), false);
});

await check('read_page gate: the combined eval failing as a whole on a challenge: the site check on its own stops it; no read eval', async () => {
  const h = gateHarness('JSON.stringify({ ok: true, blocked: { kind: "challenge", vendor: "Fixture", evidence: "#challenge-form" } })');
  let first = true;
  const run = h.c.B.evalInPage;
  h.c.B.evalInPage = async (...a) => { if (first) { first = false; h.events.push('combined failed'); throw new BridgeError('chromectl_failed', 'fixture'); } return run(...a); };
  await assert.rejects(h.c.siteGate(5, { full: true }), e => e.code === 'site_blocked');
  assert.deepEqual(h.events, ['dialog', 'combined failed', 'dialog', 'eval', 'read skipped', 'marked']);
});

console.log(`\n${passed} independent-sample groups passed; all browser/native IO faked`);
