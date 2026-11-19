// Actual check-result functions with memory-only presence, requests and timers.
// Never imports the server, doctor, settings module or a native helper.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function actualFunction(name) {
  const start = new RegExp(`^function ${name}\\(`, 'gm');
  const matches = [...source.matchAll(start)];
  assert.equal(matches.length, 1, `exactly one actual ${name} declaration`);
  const at = matches[0].index;
  const end = source.indexOf('\n}', at);
  assert.ok(end > at, `complete top-level ${name} body`);
  return source.slice(at, end + 2);
}
const actual = {
  adopt: actualFunction('adoptCheck'),
  request: actualFunction('onCheckRequest'),
};
console.log(`check-result-order source=${sha256(source)} adopt=${sha256(actual.adopt)} request=${sha256(actual.request)}`);

const check = (at, ok = true) => ({ at, app: 'TestApp', ok, items: [] });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness({ local = null, request = '100', paused = false, app = 'TestApp',
  claim = true, fresh = () => null, appWait = null, sleepWait = null,
  adoptSource = actual.adopt, requestSource = actual.request } = {}) {
  const state = { now: 0, paused, request, presence: local, freshCalls: [], claimCalls: [],
    writes: [], appCalls: 0, selfChecks: 0, sleeps: [], scheduled: [], reads: 0 };
  const CHECK = { at: local?.at ?? 0, app, running: false, timer: null, again: false };
  const LOCK_DIR = 'memory://check-order/lock';
  const CHECK_REQ = 'memory://check-order/request';
  const context = vm.createContext({
    CHECK, LOCK_DIR, CHECK_REQ,
    Math: { random: () => 0 },
    S: {
      get(key) { assert.equal(key, 'paused'); return state.paused; },
      writePresence(dir, value) {
        assert.equal(dir, LOCK_DIR);
        assert.deepEqual(Object.keys(value), ['checks']);
        state.presence = value.checks;
        state.writes.push(value.checks);
      },
      freshCheckFor(dir, name, since) {
        assert.equal(dir, LOCK_DIR);
        state.freshCalls.push({ app: name, since });
        return fresh(state, CHECK);
      },
      claimCheck(dir, name, at) {
        assert.equal(dir, LOCK_DIR);
        state.claimCalls.push({ app: name, at });
        return claim;
      },
    },
    readFileSync(file, encoding) {
      assert.equal(file, CHECK_REQ);
      assert.equal(encoding, 'utf8');
      state.reads++;
      if (state.request instanceof Error) throw state.request;
      return state.request;
    },
    async checkApp() {
      state.appCalls++;
      return appWait ? appWait.promise : app;
    },
    async selfCheck() { state.selfChecks++; },
    sleep(ms) {
      assert.equal(ms, 1000);
      state.sleeps.push(ms);
      state.now += ms;
      return sleepWait && state.sleeps.length === 1 ? sleepWait.promise : Promise.resolve();
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unrefs: 0, unref() { this.unrefs++; return this; } };
      state.scheduled.push(timer);
      return timer;
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`${adoptSource}\n${requestSource}\nglobalThis.calls = { adoptCheck, onCheckRequest };`,
    { filename: 'actual-check-result-functions.js' });
  script.runInContext(context, { timeout: 1000 });
  const h = {
    state, CHECK,
    adopt: context.calls.adoptCheck,
    request: context.calls.onCheckRequest,
    completeLocal(value) {
      CHECK.at = value.at;
      state.presence = value;
    },
    fire() {
      assert.equal(state.scheduled.length, 1, 'one coalesced request timer');
      const timer = state.scheduled.shift();
      assert.equal(timer.delay, 200, 'existing minimum request jitter');
      assert.equal(timer.unrefs, 1, 'request timer remains unreferenced');
      state.now += timer.delay;
      return timer.callback();
    },
  };
  return h;
}

async function reachesSleep(h) {
  for (let step = 0; step < 8 && h.state.sleeps.length === 0; step++) await Promise.resolve();
  assert.equal(h.state.sleeps.length, 1, 'actual request callback reached its first wait');
}

function preservesOlder(adoptSource = actual.adopt) {
  const latest = check(200, false);
  const h = harness({ local: latest, adoptSource });
  h.adopt(check(100, true));
  assert.equal(h.CHECK.at, 200, 'older peer result must not move the local timestamp backwards');
  assert.equal(h.state.presence, latest, 'newer failed check remains visible');
  assert.equal(h.state.writes.length, 0, 'ignored old result must not rewrite presence');
}
function preservesEqual(adoptSource = actual.adopt) {
  const latest = check(200, false);
  const h = harness({ local: latest, adoptSource });
  h.adopt(check(200, true));
  assert.equal(h.state.presence, latest, 'equal timestamp must not replace local content');
  assert.equal(h.state.writes.length, 0, 'equal result must not rewrite presence');
}
async function stopsAfterApp(requestSource = actual.request, localAt = 200) {
  const gate = deferred();
  const h = harness({ appWait: gate, fresh: () => check(300), requestSource });
  h.request();
  const running = h.fire();
  assert.equal(h.state.appCalls, 1);
  const latest = check(localAt, false);
  h.completeLocal(latest);
  gate.resolve('TestApp');
  await running;
  assert.equal(h.state.freshCalls.length, 0, 'locally answered request must stop after checkApp await');
  assert.equal(h.state.claimCalls.length, 0);
  assert.equal(h.state.selfChecks, 0);
  assert.equal(h.state.presence, latest);
}
async function stopsAfterSleep(requestSource = actual.request, localAt = 200) {
  const gate = deferred();
  const h = harness({ claim: false, sleepWait: gate, requestSource,
    fresh: state => state.freshCalls.length === 1 ? null : check(100, true) });
  h.request();
  const running = h.fire();
  await reachesSleep(h);
  const latest = check(localAt, false);
  h.completeLocal(latest);
  gate.resolve();
  await running;
  assert.equal(h.state.freshCalls.length, 1, 'locally answered request must stop before another peer lookup');
  assert.equal(h.state.sleeps.length, 1, 'answered request must not continue waiting');
  assert.equal(h.state.writes.length, 0);
  assert.equal(h.state.presence, latest);
  assert.equal(h.CHECK.at, localAt);
}

test('older peer result cannot overwrite a newer local failure', () => preservesOlder());
test('equal timestamp cannot overwrite local content', () => preservesEqual());
test('newer peer result is still adopted once', () => {
  const h = harness({ local: check(100, false) });
  const newer = check(200);
  h.adopt(newer);
  assert.equal(h.CHECK.at, 200);
  assert.equal(h.state.presence, newer);
  assert.deepEqual(h.state.writes, [newer]);
});
test('a session without a local result can still borrow one', () => {
  const h = harness();
  const peer = check(100);
  h.adopt(peer);
  assert.equal(h.CHECK.at, 100);
  assert.equal(h.state.presence, peer);
  assert.deepEqual(h.state.writes, [peer]);
});
test('local answer during app discovery stops the waiting callback', () => stopsAfterApp());
test('local answer during peer wait stops the waiting callback', () => stopsAfterSleep());
test('request already answered locally does not discover or claim', async () => {
  const h = harness({ local: check(100, false) });
  h.request();
  await h.fire();
  assert.equal(h.state.appCalls, 0);
  assert.equal(h.state.freshCalls.length, 0);
  assert.equal(h.state.selfChecks, 0);
});
test('immediate peer answer preserves app and request matching', async () => {
  const peer = check(150);
  const h = harness({ fresh: () => peer });
  h.request();
  await h.fire();
  assert.deepEqual(h.state.freshCalls, [{ app: 'TestApp', since: 100 }]);
  assert.equal(h.state.claimCalls.length, 0);
  assert.equal(h.state.presence, peer);
  assert.equal(h.state.selfChecks, 0);
});
test('waiting peer answer is still adopted when local result is older than request', async () => {
  const peer = check(120);
  const h = harness({ local: check(50, false), claim: false,
    fresh: state => state.freshCalls.length === 1 ? null : peer });
  h.request();
  await h.fire();
  assert.deepEqual(h.state.claimCalls, [{ app: 'TestApp', at: 100 }]);
  assert.equal(h.state.sleeps.length, 1);
  assert.equal(h.state.presence, peer);
  assert.equal(h.CHECK.at, 120);
  assert.equal(h.state.selfChecks, 0);
});
test('missing peer result remains bounded to the existing thirty waits', async () => {
  const h = harness({ claim: false });
  h.request();
  await h.fire();
  assert.equal(h.state.sleeps.length, 30);
  assert.equal(h.state.freshCalls.length, 31);
  assert.equal(h.state.selfChecks, 0);
  assert.equal(h.state.writes.length, 0);
});
test('claim winner still performs one own check', async () => {
  const h = harness();
  h.request();
  await h.fire();
  assert.deepEqual(h.state.claimCalls, [{ app: 'TestApp', at: 100 }]);
  assert.equal(h.state.selfChecks, 1);
  assert.equal(h.state.sleeps.length, 0);
});
test('unknown app still takes the existing own-check path without claiming', async () => {
  const h = harness({ app: null });
  h.request();
  await h.fire();
  assert.equal(h.state.claimCalls.length, 0);
  assert.equal(h.state.freshCalls.length, 0);
  assert.equal(h.state.selfChecks, 1);
});
test('request events coalesce before the timer fires', async () => {
  const h = harness();
  h.request(); h.request(); h.request();
  assert.equal(h.state.scheduled.length, 1);
  await h.fire();
  assert.equal(h.CHECK.timer, null);
  assert.equal(h.state.reads, 1);
});
test('pause before the callback prevents discovery and work', async () => {
  const h = harness({ paused: true });
  h.request();
  await h.fire();
  assert.equal(h.state.appCalls, 0);
  assert.equal(h.state.selfChecks, 0);
});
test('pause during app discovery prevents peer adoption and claims', async () => {
  const gate = deferred();
  const h = harness({ appWait: gate, fresh: () => check(150) });
  h.request();
  const running = h.fire();
  h.state.paused = true;
  gate.resolve('TestApp');
  await running;
  assert.equal(h.state.freshCalls.length, 0);
  assert.equal(h.state.claimCalls.length, 0);
  assert.equal(h.state.writes.length, 0);
});
test('pause during peer wait prevents another lookup or adoption', async () => {
  const gate = deferred();
  const h = harness({ claim: false, sleepWait: gate,
    fresh: state => state.freshCalls.length === 1 ? null : check(150) });
  h.request();
  const running = h.fire();
  await reachesSleep(h);
  h.state.paused = true;
  gate.resolve();
  await running;
  assert.equal(h.state.freshCalls.length, 1);
  assert.equal(h.state.writes.length, 0);
  assert.equal(h.state.sleeps.length, 1);
});
test('unreadable or empty request preserves the existing early exit', async () => {
  for (const request of [new Error('inert unreadable request'), '', 'invalid']) {
    const h = harness({ request });
    h.request();
    await h.fire();
    assert.equal(h.state.appCalls, 0);
    assert.equal(h.state.selfChecks, 0);
  }
});

test('local answer exactly at request time also stops both await paths', async () => {
  await stopsAfterApp(actual.request, 100);
  await stopsAfterSleep(actual.request, 100);
});
test('local update still older than request does not stop peer waiting', async () => {
  const gate = deferred();
  const peer = check(120);
  const h = harness({ claim: false, sleepWait: gate,
    fresh: state => state.freshCalls.length === 1 ? null : peer });
  h.request();
  const running = h.fire();
  await reachesSleep(h);
  h.completeLocal(check(99, false));
  gate.resolve();
  await running;
  assert.equal(h.state.freshCalls.length, 2);
  assert.equal(h.state.presence, peer);
  assert.equal(h.CHECK.at, 120);
});

// Mutate only in-memory copies of the actual functions. A mutation is killed
// only by its specified behavioral assertion after compilation and invocation.
function replaceOnce(code, before, after) {
  assert.equal(code.split(before).length - 1, 1, 'one exact mutation target');
  return code.replace(before, after);
}
function intendedFailure(message, actualValue, expectedValue) {
  return error => error.code === 'ERR_ASSERTION' && error.message.startsWith(message) &&
    error.actual === actualValue && error.expected === expectedValue;
}
function mutationObserved(name, code) {
  console.log(`valid behavioral mutant ${name} sha256=${sha256(code)}`);
}
test('valid mutant: removing adoption order guard exposes older overwrite', () => {
  const mutant = replaceOnce(actual.adopt, '  if (c.at <= CHECK.at) return;\n', '');
  assert.throws(() => preservesOlder(mutant), intendedFailure(
    'older peer result must not move the local timestamp backwards', 100, 200));
  mutationObserved('remove-adoption-guard', mutant);
});
test('valid mutant: accepting equal timestamps exposes changed local content', () => {
  const mutant = replaceOnce(actual.adopt, 'c.at <= CHECK.at', 'c.at < CHECK.at');
  assert.throws(() => preservesEqual(mutant), error => error.code === 'ERR_ASSERTION' &&
    error.message.startsWith('equal timestamp must not replace local content') &&
    error.actual?.ok === true && error.expected?.ok === false);
  mutationObserved('accept-equal-peer', mutant);
});
const appGuard = "    const app = await checkApp();\n    if (CHECK.at >= at || S.get('paused')) return;";
const waitGuard = "        await sleep(1000);\n        if (CHECK.at >= at || S.get('paused')) return;";
test('valid mutant: missing app-await recheck continues an answered request', async () => {
  const mutant = replaceOnce(actual.request, appGuard, '    const app = await checkApp();');
  await assert.rejects(stopsAfterApp(mutant), intendedFailure(
    'locally answered request must stop after checkApp await', 1, 0));
  mutationObserved('remove-app-await-guard', mutant);
});
test('valid mutant: missing sleep-await recheck continues an answered request', async () => {
  const mutant = replaceOnce(actual.request, waitGuard, '        await sleep(1000);');
  await assert.rejects(stopsAfterSleep(mutant), intendedFailure(
    'locally answered request must stop before another peer lookup', 2, 1));
  mutationObserved('remove-sleep-await-guard', mutant);
});
test('valid mutant: app-await recheck must include the request timestamp boundary', async () => {
  const mutant = replaceOnce(actual.request, appGuard, appGuard.replace('>=', '>'));
  await assert.rejects(stopsAfterApp(mutant, 100), intendedFailure(
    'locally answered request must stop after checkApp await', 1, 0));
  mutationObserved('exclude-app-equal-boundary', mutant);
});
test('valid mutant: sleep-await recheck must include the request timestamp boundary', async () => {
  const mutant = replaceOnce(actual.request, waitGuard, waitGuard.replace('>=', '>'));
  await assert.rejects(stopsAfterSleep(mutant, 100), intendedFailure(
    'locally answered request must stop before another peer lookup', 2, 1));
  mutationObserved('exclude-sleep-equal-boundary', mutant);
});
