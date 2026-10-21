/* Two real MCP stdio processes share an isolated lock and tab registry.
 * Every browser/native entry point is replaced; this never opens Chrome or a
 * native input helper. It documents reads that remain available during a plan
 * while actions still wait for the plan's global input lease. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const self = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const body = reply => (reply.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');

async function worker() {
  const idx = await import('../src/index.js');
  const tabs = await import('../src/tabs.js');
  const { BridgeError } = await import('../src/bridge.js');
  const role = process.argv[3];
  const events = path.join(process.env.CHROME_BRIDGE_FIXTURE, `${role}.events`);
  const event = async name => appendFile(events, `${name}\n`);
  const config = async () => JSON.parse(await readFile(path.join(process.env.CHROME_BRIDGE_FIXTURE, `${role}.config`), 'utf8').catch(() => '{}'));
  let capturedConfig = null;
  const bounds = { left: 100, top: 60, width: 1000, height: 800 };
  const target = (tab = 501) => ({ ok: true, tabId: tab, windowId: 51,
    chromePid: 42, cgWindow: 71, url: `https://fixture.test/${tab}`, title: `Fixture ${tab}`,
    tabActive: tab !== 502, minimized: false, bounds, windowIndex: 1,
    frontmost: 'Google Chrome', targetOnTop: true, keyWindowIsTarget: true });
  const shot = () => ({ data: 'iVBORw0KGgo=', width: 1000, height: 800,
    fullWidth: 1000, fullHeight: 800, fullPath: '/fixture/no-real-image.png',
    rect: { x: 100, y: 60, w: 1000, h: 800 }, dispose: async () => event('dispose') });
  // Missing fakes fail closed rather than falling through to the user's apps.
  const fake = Object.fromEntries(idx.__bridgeKeysForTests().map(name => [name,
    () => { throw new Error(`Unexpected native entry point: ${name}`); }]));
  Object.assign(fake, {
    pageScript: async (name, vars) => ({ name, vars }),
    evalInPage: async (script, tab) => {
      if (script.name === 'block') return { blocked: null, target: target(tab) };
      if (script.name === 'locate' && script.vars.MODE === 'scroll') return { scroller: null };
      assert.equal(script.name, 'read');
      return { target: target(tab), text: `Readable fixture ${tab}\n${'DOM content '.repeat(200)}`,
        hint: '', count: 1, opaque: 0, visibility: tab === 502 ? 'hidden' : 'visible', outline: [] };
    },
    chromeInfo: async tab => {
      const options = await config(), base = { ...target(tab), ...options.before };
      return capturedConfig === options.id ? { ...base, ...options.after } : base;
    },
    listTabs: async () => ({ ok: true, frontmost: 'Google Chrome', chromePid: 42,
      windows: [{ id: 51, index: 1, minimized: false, tabs: [501, 502].map(id => ({
        id, url: target(id).url, title: target(id).title, active: id === 501 })) }] }),
    pageDialog: async () => ({ ok: true, open: false }),
    ensureScreenAwake: async () => ({ woke: false, displays: 1, locked: false }),
    activateChrome: async tab => { await event('activate'); return target(tab); },
    axInput: async () => ({ ok: true, pid: 42, expectedWindow: 71, frontmost: true, windowMatches: true, nodeFound: true,
      documentToken: 'fixture-document', focusedDocumentToken: 'fixture-document', nativeMenuOpen: true, menuOpen: true,
      ...(await config()).native }),
    axMenuState: async () => ({ ok: true, known: true, menuOpen: true }),
    keepAwake: () => () => {},
    openNavigationObserver: async () => ({ startedAt: Date.now(), untouched: async () => true, close: async () => {} }),
    captureWindow: async () => {
      await event('captureWindow');
      const options = await config();
      if (options.captureError) throw new BridgeError(options.captureError, `Fixture capture refused: ${options.captureError}`);
      capturedConfig = options.id;
      return shot();
    },
    captureRegion: async () => { await event('captureRegion'); throw new Error('Unexpected screen-region capture'); },
    ocrImage: async () => {
      await event('ocr');
      return { ok: true, width: 1000, height: 800,
        lines: [{ text: 'OCR fixture content', x: 10, y: 10, w: 200, h: 20, conf: 1 }] };
    },
    snapshotScene: async () => ({ app: 'fixture', appPid: 99, chromeWindow: 51, chromeTab: 501 }),
    restoreScene: async () => ({ ok: true, appFrontmost: true }),
    restoreApp: async () => ({ ok: true, appFrontmost: true }),
    cgevent: async args => {
      if (args[0] === 'idle') return { ok: true, idle: 100, clickIdle: 100, keyIdle: 100, held: [] };
      if (args[0] === 'mousepos') return { ok: true, x: 5, y: 5 };
      if (args[0] === 'warp') return { ok: true };
      if (args[0] === 'displays') {
        const options = await config();
        return { ok: true, displays: [{ id: 1 }], locked: false, displaysAsleep: false,
          ...options.screen, ...(capturedConfig === options.id ? options.afterScreen : {}) };
      }
      if (args[0] === 'escape-menu') { await event('escape-menu'); return { ok: true }; }
      throw new Error(`Unexpected native helper command: ${args[0]}`);
    },
    openInputSession: async () => {
      await event('openInputSession');
      let held = false;
      const status = () => ({ ok: true, held, takeover: { active: held, aborted: false } });
      return {
        get interrupted() { return null; },
        async request(req) {
          if (req.op === 'hold') { held = true; await event('hold'); }
          if (req.op === 'warp') return { ...status(), warped: req.to };
          if (!['prime', 'hold', 'begin', 'status', 'veil', 'panel', 'handBack'].includes(req.op))
            throw new Error(`Unexpected input operation: ${req.op}`);
          return { ...status(), pointer: { x: 5, y: 5 } };
        },
        async close() { held = false; await event('release'); return status(); }
      };
    }
  });
  idx.__setBridgeForTests(fake);
  idx.__recordForTests(false);
  idx.__notifyForTests({ send: () => { throw new Error('Unexpected notification'); } });
  if (role === 'A') await tabs.registerTab(501, target().url, { windowId: 51, agentName: 'Fixture A' });
  const transport = new StdioServerTransport();
  await idx.__connectForTests(transport);
  let ending = false;
  const end = async () => {
    if (ending) return;
    ending = true;
    await idx.taskPlanTool({ done: true }).catch(() => {});
    await transport.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on('end', end);
  process.stdin.on('close', end);
  process.on('SIGTERM', end);
}

async function main() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'cb-multi-agent-read-'));
  await mkdir(path.join(base, 'home'));
  const settings = path.join(base, 'settings.json');
  await writeFile(settings, JSON.stringify({ activityLog: false }));
  const env = {
    PATH: process.env.PATH, HOME: path.join(base, 'home'),
    CHROME_BRIDGE_HOTSWAP: '0', CHROME_BRIDGE_SWEEP: '0', CHROME_BRIDGE_MENUBAR: '0',
    CHROME_BRIDGE_WARM: '0', CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_HABITS: 'off',
    CHROME_BRIDGE_AGENT_DISPLAY: 'off', CHROME_BRIDGE_IDLE_S: '0',
    CHROME_BRIDGE_LOCK: path.join(base, 'input.lock'), CHROME_BRIDGE_SETTINGS: settings,
    CHROME_BRIDGE_ACTIVITY: path.join(base, 'activity.jsonl'), CHROME_BRIDGE_TAB_DIR: path.join(base, 'tabs'),
    CHROME_BRIDGE_AGENT_STATE: path.join(base, 'agent-window.json'), CHROME_BRIDGE_FIXTURE: base,
    CHROME_BRIDGE_RETRY_MAX_MS: '1200', CHROME_BRIDGE_TASK_GAP_MS: '200',
  };
  const clients = [];
  let passed = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };
  const events = async role => readFile(path.join(base, `${role}.events`), 'utf8').catch(() => '');
  let configId = 0;
  const configureB = options => writeFile(path.join(base, 'B.config'), JSON.stringify({ id: ++configId, ...options }));
  async function connect(role) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [self, '--worker', role], env, stderr: 'pipe' });
    let stderr = '';
    transport.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
    const client = new Client({ name: `Fixture ${role}`, version: 'multi-agent-read-test' });
    clients.push(client);
    await client.connect(transport);
    return { client, transport, stderr: () => stderr,
      call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 5000 }) };
  }
  try {
    const a = await connect('A'), b = await connect('B');
    assert.notEqual(a.transport.pid, b.transport.pid);
    assert.notEqual((await a.call('task_plan', { task: 'Fixture long plan' })).isError, true);
    const held = await a.call('scroll', { tab: 501, direction: 'down' });
    assert.notEqual(held.isError, true, body(held));
    assert.match(body(held), /整项任务持续接管中/);
    const owner = async () => JSON.parse(await readFile(path.join(env.CHROME_BRIDGE_LOCK, 'owner.json'), 'utf8'));
    assert.equal((await owner()).pid, a.transport.pid);

    await check('B lists A-owned tabs while A retains its complete plan', async () => {
      const out = await b.call('list_tabs');
      assert.notEqual(out.isError, true, body(out));
      assert.match(body(out), /tab=501/);
      assert.match(body(out), /另一个 agent「Fixture A」/);
      assert.equal((await owner()).pid, a.transport.pid);
    });
    await check('B reads A-owned DOM and a hidden tab without input or activation', async () => {
      for (const tab of [501, 502]) {
        const out = await b.call('read_page', { tab, full: true });
        assert.notEqual(out.isError, true, body(out));
        assert.match(body(out), new RegExp(`Readable fixture ${tab}`));
      }
      assert.equal(await events('B'), '');
      assert.equal((await owner()).pid, a.transport.pid);
    });
    await check('B OCR fallback captures the visible window without the input lease', async () => {
      const out = await b.call('read_page', { tab: 501, budget: 200 });
      assert.notEqual(out.isError, true, body(out));
      assert.match(body(out), /OCR fixture content/);
      assert.equal(await events('B'), 'captureWindow\nocr\ndispose\n');
      assert.equal((await owner()).pid, a.transport.pid);
    });
    await check('B hidden-page fallback stays DOM-only and does not activate', async () => {
      const before = await events('B');
      const out = await b.call('read_page', { tab: 502, budget: 200 });
      assert.notEqual(out.isError, true, body(out));
      assert.match(body(out), /Readable fixture 502/);
      assert.match(body(out), /读网页不会接管键鼠去截图/);
      assert.equal(await events('B'), before);
    });
    await check('automatic OCR keeps the original DOM when its target hides or navigates before capture', async () => {
      for (const beforeTarget of [{ tabActive: false }, { url: 'https://fixture.test/changed' }]) {
        await configureB({ before: beforeTarget });
        const before = await events('B');
        const out = await b.call('read_page', { tab: 501, budget: 200 });
        assert.notEqual(out.isError, true, body(out));
        assert.match(body(out), /Readable fixture 501/);
        assert.doesNotMatch(body(out), /OCR fixture content/);
        assert.equal(out.content.some(x => x.type === 'image'), false);
        assert.equal(await events('B'), before);
      }
      await configureB({});
    });
    await check('automatic OCR discards a capture whose tab/window identity changed and returns only DOM', async () => {
      for (const after of [{ tabActive: false }, { windowId: 52 }]) {
        await configureB({ after });
        const before = await events('B');
        const out = await b.call('read_page', { tab: 501, budget: 200 });
        assert.notEqual(out.isError, true, body(out));
        assert.match(body(out), /Readable fixture 501/);
        assert.doesNotMatch(body(out), /OCR fixture content/);
        assert.equal(out.content.some(x => x.type === 'image'), false);
        assert.equal((await events('B')).slice(before.length), 'captureWindow\ndispose\n');
        assert.equal((await owner()).pid, a.transport.pid);
      }
      await configureB({});
    });
    await check('B screenshot stays read-only and completes while A holds its entire task', async () => {
      const before = await events('A'), t0 = Date.now();
      const out = await b.call('screenshot', { tab: 501, image: true });
      assert.notEqual(out.isError, true, body(out));
      assert.ok(Date.now() - t0 < 1000, 'a fake capture must finish before the input-lock deadline');
      assert.match(body(out), /OCR fixture content/);
      assert.match(body(out), /只读截图/);
      assert.ok(out.content.some(x => x.type === 'image'));
      assert.doesNotMatch(await events('B'), /activate|openInputSession|hold|captureRegion/);
      assert.equal(await events('A'), before, 'a read must not touch or close the other agent helper');
      assert.equal((await owner()).pid, a.transport.pid);
      assert.deepEqual(await readdir(`${env.CHROME_BRIDGE_LOCK}.queue`).catch(() => []), []);
    });
    await check('B write queues while concurrent reads still complete and A never yields its plan', async () => {
      let settled = false;
      const pending = b.call('scroll', { tab: 501, direction: 'down' }).then(out => { settled = true; return out; });
      const deadline = Date.now() + 3000;
      let queued = false;
      while (Date.now() < deadline && !settled) {
        const names = await readdir(`${env.CHROME_BRIDGE_LOCK}.queue`).catch(() => []);
        if (names.some(name => name.endsWith('.json'))) { queued = true; break; }
        await pause(10);
      }
      assert.equal(queued, true, 'the write must reach the real shared lock queue');
      const read = await b.call('read_page', { tab: 502, full: true });
      assert.notEqual(read.isError, true, body(read));
      assert.equal(settled, false, 'a queued write must not serialize read requests in its own MCP process');
      const out = await pending;
      assert.equal(out.isError, true, body(out));
      assert.match(body(out), /排队|排了|等待|键盘|鼠标/);
      assert.doesNotMatch(await events('B'), /activate|openInputSession|hold/);
      assert.equal((await owner()).pid, a.transport.pid, 'an explicit plan never silently yields to queued writes');
    });
    await check('B open_tab also waits for the input lease before invoking the browser', async () => {
      const out = await b.call('open_tab', { url: 'https://fixture.test/new', why: 'user_asked' });
      assert.equal(out.isError, true, body(out));
      assert.match(body(out), /排队|排了|等待|键盘|鼠标/);
      assert.doesNotMatch(body(out), /Unexpected native entry point/);
      assert.equal((await owner()).pid, a.transport.pid);
    });
    await check('hidden/minimized/unknown targets refuse without capturing another tab or activating', async () => {
      for (const options of [
        { before: { tabActive: false } }, { before: { minimized: true } },
        { before: { cgWindow: null } }, { before: { chromePid: 0 } },
        { before: { tabId: 502 } }, { before: { windowId: null } },
      ]) {
        await configureB(options);
        const before = await events('B');
        const out = await b.call('screenshot', { tab: 501, image: true });
        assert.equal(out.isError, true, body(out));
        assert.equal(out.content.some(x => x.type === 'image'), false);
        assert.equal(await events('B'), before);
        assert.equal((await owner()).pid, a.transport.pid);
      }
    });
    await check('a capture identity change discards the image and never OCRs or caches it', async () => {
      for (const after of [
        { tabId: 502 }, { windowId: 52 }, { chromePid: 43 }, { cgWindow: 72 },
        { url: 'https://fixture.test/changed' }, { tabActive: false }, { minimized: true },
        { bounds: { left: 101, top: 60, width: 1000, height: 800 } },
      ]) {
        await configureB({ after });
        const before = await events('B');
        const out = await b.call('screenshot', { tab: 501, image: true });
        assert.equal(out.isError, true, body(out));
        assert.match(body(out), /截图期间目标标签或窗口已经变化/);
        assert.equal(out.content.some(x => x.type === 'image'), false);
        assert.equal((await events('B')).slice(before.length), 'captureWindow\ndispose\n');
        // Clear the fixture mutation, leaving production's screenshot cache untouched.
        await configureB({});
        const click = await b.call('click_at', { tab: 501, text_id: 't1' });
        assert.equal(click.isError, true);
        assert.match(body(click), /先 screenshot/);
      }
    });
    await check('Screen Recording and capture errors preserve refusal without region or activation fallback', async () => {
      for (const code of ['no_screen_recording', 'window_off_screen', 'capture_failed']) {
        await configureB({ captureError: code });
        const before = await events('B');
        const out = await b.call('screenshot', { tab: 501, image: true });
        assert.equal(out.isError, true, body(out));
        assert.match(body(out), new RegExp(code));
        assert.equal(out.content.some(x => x.type === 'image'), false);
        assert.equal((await events('B')).slice(before.length), 'captureWindow\n');
      }
    });
    await check('locked/asleep/unknown screen refuses without waking or taking input', async () => {
      for (const screen of [{ locked: true }, { displaysAsleep: true }, { locked: null }, { displays: [] }]) {
        await configureB({ screen });
        const before = await events('B');
        const out = await b.call('screenshot', { tab: 501 });
        assert.equal(out.isError, true, body(out));
        assert.equal(await events('B'), before);
        assert.equal((await owner()).pid, a.transport.pid);
      }
    });
    await check('a screen lock during capture discards the image before OCR', async () => {
      await configureB({ afterScreen: { locked: true } });
      const before = await events('B');
      const out = await b.call('screenshot', { tab: 501, image: true });
      assert.equal(out.isError, true, body(out));
      assert.match(body(out), /屏幕锁着/);
      assert.equal(out.content.some(x => x.type === 'image'), false);
      assert.equal((await events('B')).slice(before.length), 'captureWindow\ndispose\n');
    });
    await check('missing, occluded or mismatched native evidence grants no Escape recovery authority', async () => {
      for (const native of [
        { frontmost: false }, { windowMatches: false }, { nodeFound: false },
        { documentToken: null }, { pid: 43 }, { expectedWindow: 72 },
        { blocker: { appName: 'Fixture other app' } }, { ok: false },
      ]) {
        await configureB({ native });
        const out = await b.call('screenshot', { tab: 501 });
        assert.notEqual(out.isError, true, body(out));
        const before = await events('B');
        const escaped = await b.call('press_key', { tab: 501, key: 'escape' });
        assert.equal(escaped.isError, true, body(escaped));
        assert.match(body(escaped), /没有这个标签最近 15 秒内的原生窗口和页面身份/);
        assert.equal(await events('B'), before);
        assert.equal((await owner()).pid, a.transport.pid);
      }
    });
    assert.notEqual((await a.call('task_plan', { done: true })).isError, true);
    await check('matching native evidence still permits the separate guarded Escape path', async () => {
      await configureB({});
      assert.notEqual((await b.call('screenshot', { tab: 501 })).isError, true);
      const before = await events('B');
      const out = await b.call('press_key', { tab: 501, key: 'escape' });
      assert.notEqual(out.isError, true, body(out));
      assert.equal((await events('B')).slice(before.length), 'escape-menu\n');
    });
    await check('after A ends its plan B can acquire the input lease for a write', async () => {
      await configureB({});
      const out = await b.call('scroll', { tab: 501, direction: 'down' });
      assert.notEqual(out.isError, true, body(out));
      assert.match(await events('B'), /openInputSession/);
      assert.match(await events('B'), /hold/);
    });
    console.log(`multi-agent-read: ${passed} passed (two MCP processes; no real Chrome/native input)`);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await rm(base, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') await worker();
else await main();
