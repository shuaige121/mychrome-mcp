// Execute the complete actual check functions with memory-only dependencies.
// No product imports, real settings/doctor, host/PID checks, timers or native effects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const sha256 = text => createHash('sha256').update(text).digest('hex');
function actualFunction(name, asynchronous = false) {
  const matches = [...source.matchAll(new RegExp(`^${asynchronous ? 'async ' : ''}function ${name}\\(`, 'gm'))];
  assert.equal(matches.length, 1, `one actual ${name} declaration`);
  const start = matches[0].index;
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `complete top-level ${name} body`);
  return source.slice(start, end + 2);
}
const initializers = [...source.matchAll(/^const CHECK = .*;$/gm)];
assert.equal(initializers.length, 1, 'one actual CHECK initializer');
const actual = {
  initializer: initializers[0][0],
  adopt: actualFunction('adoptCheck'),
  self: actualFunction('selfCheck', true),
  request: actualFunction('onCheckRequest'),
};
const loaderExpression = "await import('./doctor.js')";
const loaderReplacement = 'await memoryDoctor()';
assert.equal(actual.self.split(loaderExpression).length - 1, 1, 'one exact doctor import expression');
const transformedSelf = actual.self.replace(loaderExpression, loaderReplacement);
assert.equal(transformedSelf.replace(loaderReplacement, loaderExpression), actual.self,
  'only the unique loader expression is transformed; control flow is byte-identical');
const capsule = [actual.initializer, actual.adopt, transformedSelf, actual.request].join('\n');
console.log(JSON.stringify({ suite: 'check-request-coalescing', source: sha256(source),
  actual: Object.fromEntries(Object.entries(actual).map(([key, text]) => [key, sha256(text)])),
  loader: { matches: 1, original: loaderExpression, replacement: loaderReplacement,
    originalHash: sha256(loaderExpression), replacementHash: sha256(loaderReplacement) },
  transformedSelf: sha256(transformedSelf), capsule: sha256(capsule) }));

const peer = (at, ok = true) => ({ at, app: 'TestApp', ok, items: [] });
const result = { app: 'TestApp', ok: true, checks: [
  { id: 'inert', title: 'Inert check', required: true, ok: true },
] };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function reaches(predicate, message) {
  for (let i = 0; i < 40 && !predicate(); i++) await Promise.resolve();
  assert.ok(predicate(), message);
}
function harness({ app = 'TestApp', paused = false, now = 1000, claim = true,
  appGate = null, sleepGate = null, doctorSteps = [], fresh = () => null,
  selfSource = transformedSelf, requestSource = actual.request } = {}) {
  const state = { now, paused, request: '0', appCalls: 0, loaderCalls: 0, doctors: [], probes: 0,
    freshCalls: [], claimCalls: [], writes: [], sleeps: [], timers: [], boundaryErrors: [], reads: 0 };
  const LOCK_DIR = 'memory://coalescing/lock', CHECK_REQ = 'memory://coalescing/request';
  function boundary(fn) {
    try { return fn(); } catch (error) { state.boundaryErrors.push(error); throw error; }
  }
  const context = vm.createContext({
    LOCK_DIR, CHECK_REQ, Math: { random: () => 0, max: Math.max }, Date: { now: () => state.now },
    S: {
      get: key => boundary(() => { assert.equal(key, 'paused'); return state.paused; }),
      writePresence: (dir, value) => boundary(() => {
        assert.equal(dir, LOCK_DIR); assert.deepEqual(Object.keys(value), ['checks']);
        state.writes.push(value.checks);
      }),
      freshCheckFor: (dir, name, since) => boundary(() => {
        assert.equal(dir, LOCK_DIR); state.freshCalls.push({ app: name, since });
        return fresh(state);
      }),
      claimCheck: (dir, name, at) => boundary(() => {
        assert.equal(dir, LOCK_DIR); state.claimCalls.push({ app: name, at }); return claim;
      }),
    },
    readFileSync: (file, encoding) => boundary(() => {
      assert.equal(file, CHECK_REQ); assert.equal(encoding, 'utf8'); state.reads++;
      if (state.request instanceof Error) throw state.request;
      return state.request;
    }),
    async checkApp() {
      state.appCalls++;
      return appGate && state.appCalls === 1 ? appGate.promise : app;
    },
    async memoryDoctor() {
      state.loaderCalls++;
      return { async runChecks(options) {
        boundary(() => { assert.equal(options.probe, 'needed'); assert.equal(typeof options.paused, 'function'); });
        const step = doctorSteps[state.doctors.length] || {};
        const call = { at: state.now, pausedAtEntry: options.paused() };
        state.doctors.push(call);
        if (step.gate) await step.gate.promise;
        if (step.error) throw step.error;
        // Model only the existing doctor pause contract, never a native probe.
        call.pausedAtProbe = options.paused();
        if (!call.pausedAtProbe) state.probes++;
        return step.result || result;
      } };
    },
    sleep(ms) {
      boundary(() => assert.equal(ms, 1000)); state.sleeps.push(ms);
      return sleepGate && state.sleeps.length === 1 ? sleepGate.promise : Promise.resolve();
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unrefs: 0, unref() { this.unrefs++; return this; } };
      state.timers.push(timer); return timer;
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script([actual.initializer, actual.adopt, selfSource, requestSource,
    'globalThis.calls = { CHECK, adoptCheck, selfCheck, onCheckRequest };'].join('\n'),
  { filename: 'actual-check-request-coalescing.js' }).runInContext(context, { timeout: 1000 });
  const h = { state, CHECK: context.calls.CHECK, adopt: context.calls.adoptCheck,
    self: context.calls.selfCheck,
    request(at) { state.request = String(at); context.calls.onCheckRequest(); },
    fire(delay) {
      const index = state.timers.findIndex(timer => timer.delay === delay);
      assert.notEqual(index, -1, `a memory timer at delay ${delay} exists`);
      const [timer] = state.timers.splice(index, 1);
      assert.equal(timer.unrefs, 1, 'timer is unreferenced'); return timer.callback();
    },
    async drain() {
      let count = 0;
      while (state.timers.some(timer => timer.delay === 0)) {
        assert.ok(++count <= 4, 'no unbounded follow-up loop'); await h.fire(0);
      }
    },
    clean() { assert.deepEqual(state.boundaryErrors, [], 'no swallowed memory-boundary assertion'); },
  };
  return h;
}
async function issue(h, at) {
  h.request(at); await h.fire(200); h.clean();
}
async function beginDoctor(h, options = { startup: true }) {
  const running = h.self(options);
  await reaches(() => h.state.doctors.length === 1, 'actual fake doctor entered and is suspended');
  assert.equal(h.CHECK.running, true); assert.equal(h.state.loaderCalls, 1); h.clean();
  return { running };
}
async function answeredWhileRunning(selfSource = transformedSelf, requestSource = actual.request, times = [1100], completedAt = 1500) {
  const gate = deferred();
  const h = harness({ selfSource, requestSource, doctorSteps: [{ gate }] });
  const { running } = await beginDoctor(h);
  // Timer scheduling and the wall clock are independent memory controls, so
  // equality can be tested without moving the completion clock backwards.
  for (const at of times) { h.state.now = Math.min(at + 200, completedAt); await issue(h, at); }
  assert.equal(h.state.doctors.length, 1, 'requests never overlap the suspended doctor');
  h.state.now = completedAt; gate.resolve(); await running;
  assert.equal(h.CHECK.at, completedAt, 'actual completion timestamp answers the request');
  await h.drain(); h.clean();
  assert.equal(h.state.doctors.length, 1, 'answered request must not run a second doctor');
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.writes[0].at, completedAt);
  return h;
}
async function olderStartup({ selfSource = transformedSelf, requestSource = actual.request,
  requests = [1100], adoptedAt = 1050, beforeDrain = null } = {}) {
  const gate = deferred();
  const h = harness({ appGate: gate, selfSource, requestSource,
    fresh: state => state.freshCalls.at(-1).since < 0 ? peer(adoptedAt) : null });
  const running = h.self({ startup: true });
  assert.equal(h.CHECK.running, true);
  for (const at of requests) { h.state.now = Math.max(h.state.now, at + 200); await issue(h, at); }
  h.state.now = 1500; gate.resolve('TestApp'); await running;
  assert.equal(h.CHECK.at, adoptedAt, 'startup actually adopts the older peer timestamp');
  assert.equal(h.state.doctors.length, 0, 'startup freshness avoids its own doctor');
  if (beforeDrain) await beforeDrain(h);
  await h.drain(); h.clean();
  return h;
}
async function needsFollowup(selfSource = transformedSelf, requestSource = actual.request) {
  const h = await olderStartup({ selfSource, requestSource });
  assert.equal(h.state.doctors.length, 1, 'unanswered request must run one follow-up doctor');
  assert.equal(h.state.loaderCalls, 1, 'necessary follow-up entered the memory doctor');
  assert.equal(h.CHECK.at, 1500); return h;
}
async function newestPending(selfSource = transformedSelf) {
  const h = await olderStartup({ selfSource, requests: [1200, 1100], adoptedAt: 1150 });
  assert.equal(h.state.doctors.length, 1, 'newest unanswered request survives the older event');
  assert.equal(h.CHECK.at, 1500);
}
async function queuedAnswer(selfSource = transformedSelf) {
  const h = await olderStartup({ selfSource, beforeDrain: h => h.adopt(peer(1100)) });
  assert.equal(h.state.doctors.length, 0, 'queued callback rechecks equality before running doctor');
  assert.equal(h.CHECK.at, 1100);
}
async function originalRequestTime(requestSource = actual.request) {
  const h = await olderStartup({ requestSource, adoptedAt: 1200 });
  assert.equal(h.state.doctors.length, 0, 'request keeps original timestamp across the jitter delay');
  assert.equal(h.CHECK.at, 1200);
}

test('running startup completion answers a request without an extra doctor', () => answeredWhileRunning());
test('completion exactly at the request timestamp also answers it', () => answeredWhileRunning(transformedSelf, actual.request, [1500], 1500));
test('multiple requests answered by one completion do not multiply work', () => answeredWhileRunning(transformedSelf, actual.request, [1100, 1200, 1400]));
test('older borrowed startup result preserves one necessary follow-up', () => needsFollowup());
test('newest pending timestamp survives a later older request event', () => newestPending());
test('failed first doctor retains a pending request but cannot self-loop', async () => {
  const gate = deferred();
  const h = harness({ doctorSteps: [{ gate, error: new Error('inert failure') }, { error: new Error('inert follow-up failure') }] });
  const { running } = await beginDoctor(h);
  await issue(h, 1100); gate.resolve(); await running; await h.drain(); h.clean();
  assert.equal(h.state.doctors.length, 2, 'one pending request permits exactly one failed follow-up');
  assert.equal(h.CHECK.at, 0); assert.equal(h.state.timers.length, 0);
});
test('failed doctor without another request does not self-loop', async () => {
  const h = harness({ doctorSteps: [{ error: new Error('inert failure') }] });
  await h.self({ startup: true }); await h.drain(); h.clean();
  assert.equal(h.state.doctors.length, 1); assert.equal(h.state.timers.length, 0);
});
test('answer before queued callback prevents a now-unnecessary follow-up', () => queuedAnswer());
test('pending timestamp remains the request time, not its callback time', () => originalRequestTime());
test('paused entry and paused request callback never enter doctor', async () => {
  const h = harness({ paused: true });
  await h.self({ startup: true }); await issue(h, 1100); await h.drain();
  assert.equal(h.state.doctors.length, 0); assert.equal(h.state.appCalls, 0);
});
test('pause before queued follow-up blocks it, resume request still runs', async () => {
  const h = await olderStartup({ beforeDrain: h => { h.state.paused = true; } });
  assert.equal(h.state.doctors.length, 0); assert.equal(h.state.timers.length, 0);
  h.state.paused = false; h.state.now = 1700; await issue(h, 1600);
  assert.equal(h.state.doctors.length, 1, 'fresh resume request runs the needed doctor');
  assert.equal(h.CHECK.at, 1700);
});
test('pause while doctor is suspended is observed by its existing pause callback', async () => {
  const gate = deferred(); const h = harness({ doctorSteps: [{ gate }] });
  const { running } = await beginDoctor(h); h.state.paused = true;
  gate.resolve(); await running; h.clean();
  assert.equal(h.state.probes, 0); assert.equal(h.state.doctors[0].pausedAtProbe, true);
});
test('startup freshness retains the same app and ten-minute lower bound', async () => {
  const h = harness({ now: 700000, fresh: () => peer(650000) });
  await h.self({ startup: true }); h.clean();
  assert.deepEqual(h.state.freshCalls, [{ app: 'TestApp', since: 100000 }]);
  assert.equal(h.CHECK.at, 650000); assert.equal(h.state.doctors.length, 0);
});
test('older/equal adopted results preserve newer local presence, newer is adopted', () => {
  const h = harness(); const current = peer(200, false); h.adopt(current);
  h.adopt(peer(100)); h.adopt(peer(200));
  assert.equal(h.CHECK.at, 200); assert.deepEqual(h.state.writes, [current]);
  const newer = peer(300); h.adopt(newer);
  assert.equal(h.CHECK.at, 300); assert.deepEqual(h.state.writes, [current, newer]); h.clean();
});
test('request claiming and unknown app retain their own-check paths', async () => {
  for (const app of ['TestApp', null]) {
    const h = harness({ app, now: 1500 }); await issue(h, 1100);
    assert.equal(h.state.doctors.length, 1); assert.equal(h.CHECK.at, 1500);
    assert.deepEqual(h.state.claimCalls, app ? [{ app, at: 1100 }] : []);
    assert.deepEqual(h.state.freshCalls, app ? [{ app, since: 1100 }] : []);
    assert.equal(h.state.writes[0].app, 'TestApp');
  }
});
test('immediate same-app peer answer skips claiming and doctor', async () => {
  const h = harness({ fresh: () => peer(1200) }); await issue(h, 1100);
  assert.deepEqual(h.state.freshCalls, [{ app: 'TestApp', since: 1100 }]);
  assert.equal(h.state.claimCalls.length, 0); assert.equal(h.state.doctors.length, 0);
  assert.equal(h.CHECK.at, 1200);
});
test('claim loser still waits at most thirty times for a same-app answer', async () => {
  const h = harness({ claim: false }); await issue(h, 1100);
  assert.equal(h.state.sleeps.length, 30); assert.equal(h.state.freshCalls.length, 31);
  assert.equal(h.state.doctors.length, 0);
  assert.ok(h.state.freshCalls.every(call => call.app === 'TestApp' && call.since === 1100));
});
test('claim loser adopts an eventual peer answer without own doctor', async () => {
  const h = harness({ claim: false, fresh: state => state.freshCalls.length > 1 ? peer(1200) : null });
  await issue(h, 1100); assert.equal(h.state.sleeps.length, 1);
  assert.equal(h.CHECK.at, 1200); assert.equal(h.state.doctors.length, 0);
});
test('request events before jitter fires read only the latest request once', async () => {
  const h = harness({ now: 1500 }); h.request(1100); h.request(1200); h.request(1300);
  assert.equal(h.state.timers.length, 1); await h.fire(200); h.clean();
  assert.equal(h.state.reads, 1); assert.deepEqual(h.state.claimCalls, [{ app: 'TestApp', at: 1300 }]);
  assert.equal(h.state.doctors.length, 1);
});
test('P42e app-await recheck retains equality and paused exits', async () => {
  for (const pause of [false, true]) {
    const gate = deferred(); const h = harness({ appGate: gate }); h.request(1100);
    const running = h.fire(200); assert.equal(h.state.appCalls, 1);
    if (pause) h.state.paused = true; else h.adopt(peer(1100));
    gate.resolve('TestApp'); await running; h.clean();
    assert.equal(h.state.freshCalls.length, 0); assert.equal(h.state.claimCalls.length, 0);
    assert.equal(h.state.doctors.length, 0);
  }
});
test('P42e peer-wait recheck retains equality and paused exits', async () => {
  for (const pause of [false, true]) {
    const gate = deferred(); const h = harness({ claim: false, sleepGate: gate }); h.request(1100);
    const running = h.fire(200); await reaches(() => h.state.sleeps.length === 1, 'actual peer wait entered');
    if (pause) h.state.paused = true; else h.adopt(peer(1100));
    gate.resolve(); await running; h.clean();
    assert.equal(h.state.freshCalls.length, 1); assert.equal(h.state.sleeps.length, 1);
    assert.equal(h.state.doctors.length, 0);
  }
});

test('pause during startup app await keeps the existing doctor pause contract', async () => {
  const gate = deferred(); const h = harness({ appGate: gate });
  const running = h.self({ startup: true }); h.state.paused = true;
  gate.resolve('TestApp'); await running; h.clean();
  assert.equal(h.state.doctors.length, 1, 'existing await path may invoke runChecks');
  assert.equal(h.state.doctors[0].pausedAtEntry, true);
  assert.equal(h.state.probes, 0, 'the paused callback prevents the memory probe');
});
test('a later local check answers a queued request before its callback', async () => {
  const h = await olderStartup({ beforeDrain: async h => {
    h.state.now = 1600; await h.self({ requestedAt: 1400 });
    assert.equal(h.CHECK.at, 1600); assert.equal(h.state.doctors.length, 1);
  } });
  assert.equal(h.state.doctors.length, 1, 'queued callback sees the completed local answer');
});
test('a request during the necessary follow-up is answered by that completion', async () => {
  const gate = deferred();
  // Hold an actual necessary follow-up so a newer request can overlap it.
  const appGate = deferred();
  const held = harness({ appGate, doctorSteps: [{ gate }],
    fresh: state => state.freshCalls.at(-1).since < 0 ? peer(1050) : null });
  const startup = held.self({ startup: true }); await issue(held, 1100);
  held.state.now = 1500; appGate.resolve('TestApp'); await startup;
  const following = held.fire(0);
  await reaches(() => held.state.doctors.length === 1, 'necessary follow-up doctor entered');
  held.state.now = 1700; await issue(held, 1600);
  held.state.now = 1800; gate.resolve(); await following; await held.drain(); held.clean();
  assert.equal(held.state.doctors.length, 1, 'follow-up completion answers the newer request too');
  assert.equal(held.CHECK.at, 1800);
});

// These are deliberate mutations of memory-only actual function copies. A kill
// requires VM compilation, invocation and the specified behavioral assertion;
// extraction, syntax, dependency-loader and unrelated assertion errors fail.
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length - 1, 1, 'one exact mutation target');
  return text.replace(before, after);
}
async function killed(name, code, run, message, actualValue, expectedValue) {
  let caught;
  try { await run(); } catch (error) { caught = error; }
  assert.ok(caught, `${name} must expose its intended regression`);
  assert.equal(caught.code, 'ERR_ASSERTION');
  assert.ok(caught.message.startsWith(message), `${name}: correct behavioral assertion`);
  assert.equal(caught.actual, actualValue); assert.equal(caught.expected, expectedValue);
  console.log(JSON.stringify({ mutant: name, hash: sha256(code), executed: true,
    assertion: { code: caught.code, message, actual: caught.actual, expected: caught.expected }, stack: caught.stack }));
}
const runningLine = '  if (CHECK.running) { if (!startup) CHECK.pendingAt = Math.max(CHECK.pendingAt, requestedAt); return; }';
const finallyBlock = `    const pendingAt = CHECK.pendingAt;
    CHECK.pendingAt = 0;
    if (pendingAt > CHECK.at) {
      setTimeout(() => { if (CHECK.at < pendingAt) return selfCheck({ requestedAt: pendingAt }); }, 0).unref();
    }`;
test('valid mutant: restoring boolean rerun causes an unnecessary second doctor', async () => {
  let mutant = replaceOnce(transformedSelf, runningLine,
    '  if (CHECK.running) { if (!startup) CHECK.again = true; return; }');
  mutant = replaceOnce(mutant, finallyBlock,
    '    if (CHECK.again) { CHECK.again = false; setTimeout(() => selfCheck(), 0).unref(); }');
  await killed('restore-boolean-rerun', mutant, () => answeredWhileRunning(mutant),
    'answered request must not run a second doctor', 2, 1);
});
test('valid mutant: discarding running requests drops a necessary follow-up', async () => {
  const mutant = replaceOnce(transformedSelf, runningLine, '  if (CHECK.running) return;');
  await killed('drop-pending-request', mutant, () => needsFollowup(mutant),
    'unanswered request must run one follow-up doctor', 0, 1);
});
test('valid mutant: overwriting latest timestamp loses a newer pending request', async () => {
  const mutant = replaceOnce(transformedSelf, 'Math.max(CHECK.pendingAt, requestedAt)', 'requestedAt');
  await killed('overwrite-latest-timestamp', mutant, () => newestPending(mutant),
    'newest unanswered request survives the older event', 0, 1);
});
test('valid mutant: removing queued recheck runs an already-answered request', async () => {
  const mutant = replaceOnce(transformedSelf, 'if (CHECK.at < pendingAt) return selfCheck', 'return selfCheck');
  await killed('remove-queued-recheck', mutant, () => queuedAnswer(mutant),
    'queued callback rechecks equality before running doctor', 1, 0);
});
test('valid mutant: omitting original request time invents a newer request', async () => {
  const mutant = replaceOnce(actual.request, 'await selfCheck({ requestedAt: at });', 'await selfCheck();');
  await killed('omit-original-request-time', mutant, () => originalRequestTime(mutant),
    'request keeps original timestamp across the jitter delay', 1, 0);
});
