/* Ownership evidence must distinguish a real click, no click, and an unavailable
 * observation. All files and browser listings here are isolated test fixtures. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-ownership-observation-'));
process.env.CHROME_BRIDGE_TAB_DIR = path.join(tmp, 'tabs');
process.env.CHROME_BRIDGE_LOCK = path.join(tmp, 'locks', 'input.lock');
const T = await import('../src/tabs.js');
const lockDir = process.env.CHROME_BRIDGE_LOCK;
await mkdir(path.dirname(lockDir));
const tabId = 901, windowId = 81;
const url = 'https://fixture.test/exam';
const listing = () => ({
  frontmost: 'Google Chrome',
  windows: [{ id: windowId, index: 1, minimized: false,
    tabs: [{ id: tabId, url, active: true }] }],
});
let closed = 0, passed = 0;
const deps = {
  lockDir, listTabs: async () => listing(),
  closeTab: async () => { closed++; },
};
async function register() {
  await T.forgetTab(tabId);
  await T.registerTab(tabId, url, { windowId, now: Date.now() - 60_000 });
}
async function check(name, fn) {
  await register();
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

try {
  await check('unknown native click observations are not reported as clicks', async () => {
    for (const probe of [
      async () => { throw new Error('native helper unavailable'); },
      async () => ({}),
      async () => ({ clickIdle: NaN }),
      async () => ({ clickIdle: -1 }),
    ]) assert.equal(await T.clickedSince(probe, Date.now() - 1000), null);
    assert.equal(await T.clickedSince(async () => ({ clickIdle: 0 }), Date.now() - 1000), true);
    assert.equal(await T.clickedSince(async () => ({ clickIdle: 100 }), Date.now() - 1000), false);
  });

  await check('a failed probe never creates a sticky user_viewing flag', async () => {
    const clickedSince = t0 => T.clickedSince(async () => { throw Error('unavailable'); }, t0);
    const observed = await T.observeUserTab({ ...deps, clickedSince });
    assert.equal(observed.quiet, true);
    assert.equal(observed.viewingUnknown, true);
    assert.equal(observed.userTabId, null);
    const swept = await T.sweepTabs({ ...deps, clickedSince, ttlMs: 0 });
    assert.deepEqual(swept.marked, []);
    assert.deepEqual(swept.closed, []);
    const result = await T.closeAgentTab(tabId, { ...deps, clickedSince });
    assert.equal(result.ok, false);
    assert.equal(result.transient, true, 'unknown evidence blocks a close only transiently');
    assert.equal(result.why, 'viewing_unverified');
    assert.equal((await T.getTab(tabId)).takenOver, false);
    assert.equal(closed, 0);
  });

  await check('a throwing observation dependency is also unknown', async () => {
    const observed = await T.observeUserTab({
      ...deps, clickedSince: async () => { throw Error('transport failed'); },
    });
    assert.equal(observed.userTabId, null);
    assert.equal(observed.viewingUnknown, true);
  });

  await check('an agent acquiring its lease during the probe cannot be mistaken for the user', async () => {
    const observed = await T.observeUserTab({ ...deps, clickedSince: async () => {
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, 'owner.json'),
        JSON.stringify({ pid: process.pid, since: Date.now() }));
      return true;
    } });
    assert.equal(observed.quiet, false);
    assert.equal(observed.userTabId, null);
    await rm(lockDir, { recursive: true });
  });

  await check('an acquire and release during the probe also invalidate its evidence', async () => {
    const observed = await T.observeUserTab({ ...deps, clickedSince: async () => {
      await mkdir(lockDir);
      await new Promise(resolve => setTimeout(resolve, 20));
      await rm(lockDir, { recursive: true });
      return true;
    } });
    assert.equal(observed.quiet, false);
    assert.equal(observed.userTabId, null);
  });

  await check('a confirmed click still marks takeover and records which observer saw it', async () => {
    const result = await T.sweepTabs({ ...deps, clickedSince: async () => true });
    assert.deepEqual(result.marked, [{ tabId, why: 'user_viewing' }]);
    assert.equal((await T.getTab(tabId)).takenOver, true);
    const flag = JSON.parse(await readFile(path.join(T.TAB_DIR, `${tabId}.taken.json`), 'utf8'));
    assert.equal(flag.observedByPid, process.pid);
    assert.equal(flag.observedByOwnerPid, T.OWNER_PID);
    assert.equal(closed, 0);
  });
  console.log(`ownership-observation: ${passed} passed`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
