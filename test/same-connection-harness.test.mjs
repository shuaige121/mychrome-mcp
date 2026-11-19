// Offline regression: run the actual complete worker body with inert dependencies.
// The overlap schedule uses Promise gates, never sleeps or product/native imports.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTerminalReceipt } from './harness-terminal.mjs';

const sourceURL = new URL('./reliability-reset-live.mjs', import.meta.url);
const helperURL = new URL('./harness-terminal.mjs', import.meta.url);
const digest = text => createHash('sha256').update(text).digest('hex');
const [source, helper, testSource] = await Promise.all([
  fs.readFile(sourceURL, 'utf8'), fs.readFile(helperURL, 'utf8'), fs.readFile(fileURLToPath(import.meta.url), 'utf8'),
]);
const baselineSourceSha256 = '8551a127cf2c56644cc5e2911b719557dc3f5438afbd1f6ba95d4902bba6f0fe';
assert.equal(digest(helper), '07916e1f8fac6b30e86add6e84d9b24991c2e8ea98bf3a7c8f99b0e2591037b9', 'terminal helper remains frozen');
const evidenceRoot = process.env.MYCHROME_QUEUE_QA_EVIDENCE_DIR
  || await fs.mkdtemp(path.join(os.tmpdir(), 'mychrome-same-connection-'));
await fs.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(evidenceRoot, 'source.snapshot.mjs'), source);
await fs.writeFile(path.join(evidenceRoot, 'test.snapshot.mjs'), testSource);

// Exact outer anchors retain all helper declarations and the complete worker,
// including ingress, fresh/own/fence, dispatch, deny, finally and send callback.
const workerStart = source.indexOf('\nasync function fixtureWorker() {');
const workerEnd = source.indexOf('\nasync function makeWorker(', workerStart);
assert.ok(workerStart >= 0 && workerEnd > workerStart, 'complete worker anchors');
const originalPrefix = source.slice(0, workerEnd);
const staticImports = [...originalPrefix.matchAll(/^import\b[^;]*;\n/gm)].map(match => match[0]);
assert.ok(staticImports.length >= 9, 'static import inventory');
for (const statement of staticImports) {
  const specifier = statement.match(/from\s+['"]([^'"]+)['"]/)?.[1];
  assert.ok(specifier?.startsWith('node:') || ['./harness-terminal.mjs', './native-bounds-evidence.mjs'].includes(specifier),
    `unapproved static dependency: ${specifier}`);
}
function injectSource(text) { return text
  .replace(/^#![^\n]*\n/, '')
  .replace(/^import\b[^;]*;\n/gm, statement => `// Inert dependency injection: ${statement.trim()}\n`)
  .replace(/^export /gm, '')
  .replaceAll('import.meta.url', JSON.stringify(sourceURL.href))
  .replace(/\bimport\s*\(/g, 'inertImport('); }
const injectedPrefix = injectSource(originalPrefix);
assert.ok(!/\bimport\s*\(/.test(injectedPrefix), 'all dynamic imports are inert');
await fs.writeFile(path.join(evidenceRoot, 'worker.original-prefix.mjs'), originalPrefix);
await fs.writeFile(path.join(evidenceRoot, 'worker.injected-prefix.js'), injectedPrefix);
const manifest = { baselineSourceSha256, sourceSha256: digest(source), helperSha256: digest(helper),
  testSha256: digest(testSource), testBytes: Buffer.byteLength(testSource),
  originalPrefixSha256: digest(originalPrefix), injectedPrefixSha256: digest(injectedPrefix), staticImports };
await fs.writeFile(path.join(evidenceRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

function replaceOnce(text, before, after, label) {
  assert.equal(text.split(before).length - 1, 1, `unique source mutation anchor: ${label}`);
  return text.replace(before, after);
}

function workerMutation(text, kind) {
  if (!kind) return text;
  if (kind === 'shared-current-call' || kind === 'cross-call-finally') {
    text = replaceOnce(text, '  let eventSequence = 0, firstTerminal = null;',
      '  let eventSequence = 0, firstTerminal = null; let currentCall = null;', kind);
    text = replaceOnce(text, '      const callContext = requestContext.getStore();',
      '      currentCall = requestContext.getStore();', kind);
    assert.ok(text.includes('callContext.'), 'actual request-local accesses');
    text = text.replaceAll('callContext.', 'currentCall.').replace('!callContext ||', '!currentCall ||');
    if (kind === 'cross-call-finally') text = replaceOnce(text, 'finally { controllers.delete(m.id); }',
      'finally { controllers.delete(m.id); currentCall = null; }', kind);
  } else if (kind === 'latest-terminal') {
    text = replaceOnce(text, '  let eventSequence = 0, firstTerminal = null;',
      '  let eventSequence = 0, firstTerminal = null; let latestContext = null;', kind);
    text = replaceOnce(text, '    const context = requestContext.getStore();', '    const context = latestContext;', kind);
    text = replaceOnce(text, '    requestContext.run(context, () => {\n      const send',
      '    if (context) latestContext = context;\n    requestContext.run(context, () => {\n      const send', kind);
  } else if (kind === 'missing-own') {
    text = replaceOnce(text, "        if (m.args.tab != null && !(await own(m.args.tab)).exact) throw error('fixture_identity_changed');",
      '        /* Mutant removes this real per-call ownership check. */', kind);
  } else if (kind === 'missing-fresh-after-reply') {
    text = replaceOnce(text, "          else {\n            if (m.name === 'scroll') audit?.actionEnd();\n            await fresh();\n          }",
      "          else {\n            if (m.name === 'scroll') audit?.actionEnd();\n            void 0;\n          }", kind);
  } else if (kind === 'asynchronous-terminal') {
    text = replaceOnce(text, '    disposeTerminal({ directory: env.MYCHROME_FIXTURE_DIR, binding: rpcToken,',
      '    queueMicrotask(() => disposeTerminal({ directory: env.MYCHROME_FIXTURE_DIR, binding: rpcToken,', kind);
    text = replaceOnce(text, '      diagnostic: retained.responseLost ? retained.proof : null });',
      '      diagnostic: retained.responseLost ? retained.proof : null }));', kind);
  } else if (kind === 'return-only-terminal') {
    const start = text.indexOf('    disposeTerminal({ directory: env.MYCHROME_FIXTURE_DIR, binding: rpcToken,');
    const endAnchor = '    throw error(workerState.terminal);';
    const end = text.indexOf(endAnchor, start);
    assert.ok(start >= 0 && end > start, 'complete actual terminal call and throw');
    text = text.slice(0, start) + '    return; // Mutant returns without synchronous sealing.\n'
      + text.slice(end + endAnchor.length);
  } else if (kind === 'third-write-allowed') {
    text = replaceOnce(text, "        const field = ['A', 'B'][sameConnectionWriteCount];",
      "        const field = ['A', 'B'][sameConnectionWriteCount % 2];", kind);
  } else throw Error(`unknown worker mutant: ${kind}`);
  return text;
}

function capsule(order, overlap, directory, scenario = {}, workerText = injectedPrefix) {
  return `
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { disposeTerminal as actualDisposeTerminal, productErrorFact, workerFailureFact, rpcFailureFact } from ${JSON.stringify(helperURL.href)};
const scenario = ${JSON.stringify(scenario)};
const trace = [], listeners = [];
function note(effect, fields = {}) {
  const entry = { sequence: trace.length + 1, effect, ...fields };
  trace.push(entry); console.log(JSON.stringify(entry));
  for (const listener of [...listeners]) if (listener.predicate(entry)) {
    listeners.splice(listeners.indexOf(listener), 1); listener.resolve(entry);
  }
}
function waitFor(predicate) {
  const present = trace.find(predicate);
  return present ? Promise.resolve(present) : new Promise(resolve => listeners.push({ predicate, resolve }));
}
const gates = new Map(['A', 'B'].map(slot => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return [slot, { promise, release }];
}));
const stores = [], contextRecords = new Map(), callbacks = new Map(), wireSlots = new Map();
class ObservedContext extends AsyncLocalStorage { constructor() { super(); stores.push(this); } }
const active = () => stores[0]?.getStore() ?? null;
const slotOf = value => wireSlots.get(value?.id) || (value?.id === 11 ? 'A' : value?.id === 12 ? 'B' : null);
const attribution = () => { const c = active(); return c ? { id: c.id, tool: c.tool, startedAt: c.startedAt, responseAt: c.responseAt } : null; };
let replyReturned = false, fixturePage = null, fixtureFields = null, fixtureInput = null, sampleReads = 0, deferredAText = '';
let resumeBPreflight;
const bPreflight = new Promise(resolve => { resumeBPreflight = resolve; });
const fakeProcess = new EventEmitter();
Object.assign(fakeProcess, { pid: process.pid, ppid: 100, connected: true, argv: [],
  env: { MYCHROME_FIXTURE_PARENT: '100', MYCHROME_FIXTURE_TOKEN: 'inert',
    MYCHROME_FIXTURE_RPC_TOKEN: 'inert-rpc-binding', MYCHROME_FIXTURE_SOURCE: '/inert-product',
    MYCHROME_FIXTURE_CASE: scenario.mode || 'input', MYCHROME_FIXTURE_DIR: ${JSON.stringify(scenario.missingDirectory ? path.join(directory, 'missing') : directory)} },
  exit: code => process.exit(code),
  send: (message, callback) => {
    note('ipc.send', { message });
    if (scenario.kind === 'ipc-callback' && message.id === 11) { callbacks.set(11, callback); return; }
    queueMicrotask(() => callback?.(null));
  },
});
const syntheticURL = 'http://127.0.0.1/fixture-inert';
const hold = { kept: { session: { pid: 43210,
  request: async () => { note('fence.status', { context: attribution() });
    return { ok: true, takeover: { active: !(scenario.fault === 'fence' && slotOf(active()) === 'B') } }; } } },
  lease: { token: 'inert-lease' } };
const api = { __connectForTests: async () => note('transport.connect-server'), __taskHoldForTests: () => hold };
const B = {
  cgevent: async args => {
    if (JSON.stringify(args) === '["idle"]') { note('observe.idle'); return { held: [] }; }
    assert.equal(JSON.stringify(args), '["displays"]'); note('fence.health', { context: attribution() });
    if (scenario.kind === 'unattributed-read' && !active()) throw Object.assign(Error('inert_read_failure'), { code: 'inert_read_failure' });
    const locked = (scenario.fault === 'fresh' && slotOf(active()) === 'B')
      || (scenario.kind === 'post-response-fresh' && replyReturned);
    return { locked, displaysAsleep: false };
  },
  chromeInfo: async tab => {
    note('own.info', { tab, context: attribution() });
    const info = { url: syntheticURL, tabId: tab, windowId: 9, chromePid: 20, cgWindow: 29 };
    if (scenario.identityFault && sampleReads > 0) info[scenario.identityFault]++;
    return info;
  },
  snapshotScene: async () => { note('observe.scene'); return { appPid: 10, chromeWindow: 9, chromeTab: 7 }; },
  evalInPage: async (script, tab) => {
    assert.equal(tab, 7); assert.ok(fixturePage, 'only the fixed inert fixture can be sampled');
    note('fixture.sample', { ordinal: ++sampleReads, script });
    return JSON.parse(vm.runInContext(script, fixturePage, { filename: 'actual-fixed-sampler.js' }));
  },
};
const tabs = { readTabRecord: async tab => { note('own.record', { tab, context: attribution() });
  return { ownerPid: process.pid, expectedUrl: scenario.fault === 'own' && slotOf(active()) === 'B' ? 'inert-mismatch' : syntheticURL, windowId: 9 }; } };
class Client {
  async connect() { note('transport.connect-client'); }
  async callTool(request) {
    const slot = request.arguments.qaSlot || (scenario.mode === 'same-connection-writes' && request.name === 'type_text'
      ? request.arguments.text === 'fixture-A-17' ? 'A' : request.arguments.text === 'fixture-B-29' ? 'B' : null : null);
    if (!slot && scenario.kind === 'parent-wire') {
      note('client.dispatch', { slot: null, tool: request.name, context: attribution() });
      assert.ok(['task_plan', 'open_tab', 'read_page', 'close_tab'].includes(request.name), 'fixed setup call');
      note('client.settle', { slot: null, tool: request.name });
      return { isError: false, content: request.name === 'open_tab' ? [{ type: 'text', text: 'tab=7' }] : [] };
    }
    assert.ok(gates.has(slot), 'known inert gate');
    contextRecords.set(slot, active());
    note('client.dispatch', { slot, tool: request.name, context: attribution() });
    const reply = await gates.get(slot).promise;
    if (scenario.mode === 'same-connection-writes') applyFixtureWrite(slot, request.arguments.text);
    note('client.settle', { slot, tool: request.name }); replyReturned = true;
    return reply;
  }
}
async function inertImport(specifier) {
  const value = String(specifier);
  note('dependency.stub', { specifier: value });
  const dependencies = new Map([
    ['file:///inert-product/src/index.js', api], ['file:///inert-product/src/bridge.js', B],
    ['file:///inert-product/src/tabs.js', tabs], ['file:///inert-product/src/settings.js', { get: () => false }],
    ['file:///inert-product/src/lock.js', { LOCK_DIR: '/inert-lock' }],
    ['@modelcontextprotocol/sdk/client/index.js', { Client }],
    ['@modelcontextprotocol/sdk/inMemory.js', { InMemoryTransport: { createLinkedPair: () => [{}, { close: async () => note('transport.close') }] } }],
  ]);
  assert.ok(dependencies.has(value), 'unapproved inert import: ' + value); return dependencies.get(value);
}
const forbidden = name => () => { note('forbidden', { name }); throw Error('forbidden dependency: ' + name); };
const inertFS = { readdir: async filename => { assert.equal(filename, '/inert-lock.queue'); note('observe.queue'); return []; }, readFile: async filename => {
  assert.equal(filename, '/inert-lock/owner.json'); note('fence.lease', { context: attribution() });
  if (scenario.kind === 'external-preflight' && active()) {
    note('preflight.blocked', { slot: slotOf(active()), context: attribution() }); await new Promise(() => {});
  }
  if (scenario.nonOverlap && slotOf(active()) === 'B') {
    note('preflight.B-held-for-no-overlap', { context: attribution() }); await bPreflight;
  }
  return JSON.stringify({ pid: process.pid, token: scenario.fault === 'lease' && slotOf(active()) === 'B' ? 'changed-inert-lease' : 'inert-lease' });
} };
let now = 1000, followupsArmed = false;
class Clock extends Date { static now() {
  if (active()?.dispatchSequence) note('worker.response', { slot: slotOf(active()), context: attribution() });
  if (scenario.kind === 'queued-terminal' && active()?.id === 11 && active()?.dispatchSequence && !followupsArmed) {
    followupsArmed = true; note('driver.followups-armed');
    queueMicrotask(() => {
      note('queued.second-continuation');
      for (const [id, op, fields] of [[91, 'call', { name: 'task_plan', args: { done: true } }],
        [92, 'call', { name: 'read_page', args: { tab: 7 } }], [93, 'sample', { tab: 7 }]]) {
        note('queued.followup-request', { id, op, name: fields.name ?? null });
        fakeProcess.emit('message', { token: 'inert-rpc-binding', id, op, ...fields });
      }
    });
  }
  return ++now;
} }
const context = vm.createContext({ assert, path, fs: inertFS, os: {}, createHash,
  randomUUID: () => 'inert-diagnostic-session', fileURLToPath, pathToFileURL,
  createServer: forbidden('createServer'), fork: forbidden('fork'),
  disposeTerminal: facts => { note('terminal', { code: facts.terminal.code, stage: facts.terminal.stage,
    call: facts.call ? { ...facts.call } : null, productError: facts.productError ?? null }); actualDisposeTerminal(facts); },
  readTerminalReceipt: forbidden('readTerminalReceipt'), productErrorFact, workerFailureFact, rpcFailureFact,
  createBoundsEvidenceCollector: forbidden('boundsCollector'), readBoundsEvidenceReceipt: forbidden('boundsReceipt'),
  process: fakeProcess, Date: Clock, AbortController, AsyncLocalStorage: ObservedContext, URL, console,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, inertImport,
});
vm.runInContext(${JSON.stringify(workerText + '\nglobalThis.startInertWorker = fixtureWorker;\nglobalThis.makeInertSameFixture = sameConnectionFixtureHTML;')}, context, { filename: 'actual-worker-prefix.js' });
function emitInput(slot, text) {
  const field = fixtureFields[slot];
  for (const char of text) {
    field.value += char;
    const trusted = scenario.eventFault !== 'untrusted';
    fixtureInput({ target: field, isTrusted: trusted });
    note('fixture.input', { field: slot, length: field.value.length, trusted });
  }
}
function applyFixtureWrite(slot, text) {
  if (scenario.eventFault === 'wrong-value' && slot === 'B') text = 'X' + text.slice(1);
  if (scenario.eventFault === 'interleave' && slot === 'A') {
    emitInput('A', text.slice(0, 1)); deferredAText = text.slice(1); return;
  }
  if (scenario.eventFault === 'interleave' && slot === 'B') {
    emitInput('B', text.slice(0, 1)); emitInput('A', deferredAText); emitInput('B', text.slice(1));
  } else emitInput(slot, text);
  if (slot === 'B' && scenario.eventFault === 'duplicate') fixtureInput({ target: fixtureFields.B, isTrusted: true });
  if (slot === 'B' && scenario.eventFault === 'extra-field') fixtureInput({ target: { value: '' }, isTrusted: true });
  if (slot === 'B' && scenario.eventFault === 'overflow') for (let i = 0; i < 130; i++) fixtureInput({ target: fixtureFields.B, isTrusted: true });
}
if (scenario.mode === 'same-connection-writes') {
  const html = context.makeInertSameFixture('inert');
  const begin = html.indexOf('<script>') + '<script>'.length, end = html.indexOf('</script>', begin);
  assert.ok(begin >= '<script>'.length && end > begin, 'actual fixed fixture script');
  const meta = { content: '{}' };
  fixtureFields = { A: { value: '' }, B: { value: '' } };
  const document = {
    querySelector: selector => selector === 'meta[name="fixture-token"]' ? { content: 'inert' }
      : selector === 'meta[name="fixture-state"]' ? meta : null,
    getElementById: id => id === 'field-a' ? fixtureFields.A : id === 'field-b' ? fixtureFields.B : null,
    addEventListener: (kind, callback) => { assert.equal(kind, 'input'); fixtureInput = callback; },
  };
  const markers = { indexOf: field => scenario.markerFault === 'duplicate' ? 1 : scenario.markerFault === 'missing' ? -1
    : field === fixtureFields.A ? 1 : field === fixtureFields.B ? 2 : -1 };
  fixturePage = vm.createContext({ document, location: { href: syntheticURL }, window: { __chromeBridge: { url: syntheticURL, markers } } });
  vm.runInContext(html.slice(begin, end), fixturePage, { filename: 'actual-fixed-fixture-script.js' });
  note('fixture.initialized', { htmlSha256: createHash('sha256').update(html).digest('hex') });
}
await context.startInertWorker();
const send = message => fakeProcess.emit('message', { token: 'inert-rpc-binding', ...message });
send({ id: 1, op: 'init', url: syntheticURL });
await waitFor(row => row.effect === 'ipc.send' && row.message.id === 1);
const ids = { A: 11, B: 12 }, names = { A: 'click', B: 'type_text' };
const sendCall = slot => { note('driver.start', { slot });
  send({ id: ids[slot], op: 'call', name: names[slot], args: { tab: 7, qaSlot: slot } });
};
const start = async slot => { sendCall(slot);
  await waitFor(row => row.effect === 'client.dispatch' && row.slot === slot);
};
const normalReply = slot => ({ isError: false, content: [], qaSlot: slot });
const errorReply = { isError: true, content: [], structuredContent: { error: {
  code: 'native_target_changed', stage: 'native_prepare', inputDelivery: scenario.delivery || 'sent' } } };
const release = async (slot, reply = normalReply(slot)) => { note('driver.release', { slot });
  gates.get(slot).release(reply);
  await waitFor(row => row.effect === 'ipc.send' && row.message.id === ids[slot]);
};
const order = ${JSON.stringify(order)};
if (scenario.kind === 'preflight') {
  await start('A'); sendCall('B');
  await waitFor(row => row.effect === 'client.dispatch' && row.slot === 'B');
  note('driver.unexpected-dispatch', { slot: 'B' });
} else if (scenario.kind === 'external-preflight') {
  for (const slot of ['A', 'B']) { sendCall(slot); await waitFor(row => row.effect === 'preflight.blocked' && row.slot === slot); }
  note('driver.external', { action: scenario.action });
  if (scenario.action === 'disconnect') fakeProcess.emit('disconnect'); else send({ id: 90, op: 'abort' });
} else if (scenario.kind === 'machine-error' || scenario.kind === 'queued-terminal') {
  await start('A'); await start('B');
  if (scenario.kind === 'queued-terminal') {
    note('driver.release', { slot: 'A' }); gates.get('A').release(errorReply);
    note('driver.release', { slot: 'B' }); gates.get('B').release(normalReply('B'));
    await new Promise(resolve => setImmediate(resolve));
    note('driver.unexpected-terminal-return');
  } else { await release('A', errorReply); note('driver.unexpected-terminal-reply'); }
} else if (scenario.kind === 'post-response-fresh') {
  await start('A'); await release('A'); note('driver.unexpected-unhealthy-reply');
} else if (scenario.kind === 'ipc-callback') {
  await start('A'); await start('B'); await release('A');
  note('driver.callback-context', { slot: 'B' });
  stores[0].run(contextRecords.get('B'), () => callbacks.get(11)(Error('inert callback failure')));
} else if (scenario.kind === 'unknown-operation' || scenario.kind === 'unattributed-read' || scenario.kind === 'invalid-envelope') {
  await start('A');
  if (scenario.kind === 'invalid-envelope') send({ id: 0, op: 'call' });
  else send({ id: 90, op: scenario.kind === 'unattributed-read' ? 'observe' : 'unknown-inert-op' });
  await new Promise(resolve => setImmediate(resolve));
  note('driver.unexpected-unattributed-return');
} else if (${overlap}) { await start('A'); await start('B'); for (const slot of order) await release(slot); }
else { for (const slot of order) { await start(slot); await release(slot); } }
note('driver.complete');
`;
}

async function runChild(name, order, overlap, scenario = {}, mutant = null, generator = null) {
  const directory = path.join(evidenceRoot, name);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const workerText = generator ? injectedPrefix : workerMutation(injectedPrefix, mutant);
  const code = generator ? await generator(directory) : capsule(order, overlap, directory, scenario, workerText);
  await fs.writeFile(path.join(directory, 'capsule.mjs'), code);
  if (mutant && !generator) await fs.writeFile(path.join(directory, 'mutated-worker-prefix.js'), workerText);
  if (scenario.occupiedReceipt) await fs.writeFile(path.join(directory, 'terminal-receipt.json'), 'inert-exclusive-write-conflict\n', { mode: 0o600, flag: 'wx' });
  const argv = [process.execPath, '--input-type=module', '-'];
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  let stdout = '', stderr = '', timedOut = false, termSent = false, graceExpired = false;
  let timeout, grace;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', failure => { stderr += String(failure) + '\n'; });
  const ended = new Promise(resolve => {
    child.once('error', failure => resolve({ code: null, signal: null, spawnError: String(failure) }));
    child.once('close', (code, signal) => resolve({ code, signal }));
    timeout = setTimeout(() => {
      timedOut = true; termSent = child.kill('SIGTERM');
      grace = setTimeout(() => { graceExpired = true;
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        resolve({ code: null, signal: null, ownChildCompletion: 'unconfirmed' }); }, 2000);
    }, 5000);
  });
  child.stdin.end(code);
  const exit = await ended;
  clearTimeout(timeout); clearTimeout(grace);
  await Promise.all([
    fs.writeFile(path.join(directory, 'stdout.txt'), stdout), fs.writeFile(path.join(directory, 'stderr.txt'), stderr),
    fs.writeFile(path.join(directory, 'exit.json'), JSON.stringify({ argv, ...exit, timedOut, termSent, graceExpired }, null, 2) + '\n'),
  ]);
  let trace = [], traceParseError = null;
  try { trace = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (failure) { traceParseError = String(failure); }
  let receipt = null, receiptError = null;
  try { receipt = await readTerminalReceipt(directory, 'inert-rpc-binding', child.pid); }
  catch (failure) { receiptError = failure.code || failure.message; }
  const result = { name, order, overlap, scenario, mutant, argv, stdinSha256: digest(code), workerPrefixSha256: generator ? null : digest(workerText), childPid: child.pid,
    ...exit, timedOut, termSent, graceExpired, receipt, receiptError, trace, traceParseError, stderr };
  await Promise.all([
    fs.writeFile(path.join(directory, 'stdout.txt'), stdout), fs.writeFile(path.join(directory, 'stderr.txt'), stderr),
    fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n'),
  ]);
  return result;
}

// The real makeWorker runs against a new inert child, never the requested live
// entrypoint. Its pending map, receipt checks and terminal handling are intact.
function wireWorkerCapsule(directory, scenario = {}, workerText = injectedPrefix) {
  let code = capsule([], false, directory, { ...scenario, kind: 'parent-wire' }, workerText);
  const driverStart = code.indexOf('\nconst send = message => fakeProcess.emit');
  assert.ok(driverStart > 0, 'inert driver boundary');
  code = code.slice(0, driverStart);
  return replaceOnce(code, 'await context.startInertWorker();', `
fakeProcess.send = (message, callback) => { note('ipc.send', { message }); process.send(message, callback); };
Object.defineProperty(fakeProcess, 'connected', { get: () => process.connected });
process.on('message', message => {
  if (message.qaControl === 'release') {
    note('driver.release', { slot: message.slot }); gates.get(message.slot).release(message.reply); return;
  }
  if (message.qaControl === 'resume-B-preflight') { note('driver.resume-B-preflight'); resumeBPreflight(); return; }
  if (message.op === 'call') {
    const slot = message.args?.qaSlot || (message.args?.text === 'fixture-A-17' ? 'A' : message.args?.text === 'fixture-B-29' ? 'B' : null);
    if (slot) wireSlots.set(message.id, slot);
  }
  fakeProcess.emit('message', message);
});
process.on('disconnect', () => fakeProcess.emit('disconnect'));
await context.startInertWorker();`, 'replace only the inert driver transport');
}

function parentParts(mutant = null) {
  const end = source.indexOf('\nasync function live(');
  const start = source.indexOf('  const state = { terminal:', end);
  const finish = source.indexOf('\n  try {\n    const w = await makeWorker(', start);
  assert.ok(end > workerEnd && start > end && finish > start, 'complete makeWorker and parent-core anchors');
  let core = source.slice(start, finish);
  if (mutant === 'copied-worker-product-error') core = replaceOnce(core,
    "        ...(receipt ? { workerTerminalRef: { workerPid: receipt.workerPid, schema: receipt.schema }, terminalRpcAttribution: 'unknown' } : {}),",
    "        ...(receipt?.productError ? { productError: receipt.productError } : {}),\n        ...(receipt ? { workerTerminalRef: { workerPid: receipt.workerPid, schema: receipt.schema }, terminalRpcAttribution: 'unknown' } : {}),", mutant);
  else assert.ok([null, 'missing-overlap', 'missing-event-order', 'third-write-allowed'].includes(mutant), 'known parent/case mutant');
  let prefix = injectSource(source.slice(0, end));
  if (mutant === 'missing-overlap') prefix = replaceOnce(prefix,
    '    && a.dispatchSequence < b.dispatchSequence && b.dispatchSequence < a.settleSequence;', ';', mutant);
  if (mutant === 'missing-event-order') prefix = replaceOnce(prefix,
    "      && event.field === field && event.kind === 'input' && event.sequence === index + 1",
    "      && event.kind === 'input' && event.sequence === index + 1", mutant);
  return { prefix, core, executable: `${prefix}\nglobalThis.makeInertWorker = makeWorker;\nglobalThis.executeInertCase = executeCase;\n`
    + `globalThis.buildInertParent = async function(report, options, directory, url, token) {\n${core}\n`
    + 'return { state, report, workers, owned, inflight, call, settleCall, sameConnectionWrites, adapter, abort,\n'
    + 'cleanup: () => cleanupFixtures({ state, owned, workers, observe, readWorker, call, check, report }) };\n};' };
}

async function parentCapsule(directory, scenario, mutant = null) {
  const parts = parentParts(mutant);
  const workerDirectory = path.join(directory, 'worker');
  const nestedWorkerPrefix = mutant === 'third-write-allowed' ? workerMutation(injectedPrefix, mutant) : injectedPrefix;
  const workerCode = wireWorkerCapsule(workerDirectory, scenario, nestedWorkerPrefix);
  await Promise.all([
    fs.writeFile(path.join(directory, 'parent.prefix.js'), parts.prefix),
    fs.writeFile(path.join(directory, 'parent.core.js'), parts.core),
    fs.writeFile(path.join(directory, 'worker.prefix.js'), nestedWorkerPrefix),
    fs.writeFile(path.join(directory, 'worker.capsule.mjs'), workerCode),
    fs.writeFile(path.join(directory, 'subject-manifest.json'), JSON.stringify({ sourceSha256: digest(source),
      parentPrefixSha256: digest(parts.prefix), parentCoreSha256: digest(parts.core), parentExecutableSha256: digest(parts.executable),
      workerPrefixSha256: digest(nestedWorkerPrefix), workerCapsuleSha256: digest(workerCode), mutant }, null, 2) + '\n'),
  ]);
  let generated = `
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readTerminalReceipt, productErrorFact, workerFailureFact, rpcFailureFact } from ${JSON.stringify(helperURL.href)};
const scenario = ${JSON.stringify(scenario)}, directory = ${JSON.stringify(directory)}, workerDirectory = ${JSON.stringify(workerDirectory)};
const workerCode = ${JSON.stringify(workerCode)};
const trace = [], waiters = [];
function note(effect, fields = {}) {
  const row = { sequence: trace.length + 1, effect, ...fields }; trace.push(row); console.log(JSON.stringify(row));
  for (const waiter of [...waiters]) if (waiter.predicate(row)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(row); }
}
function waitFor(predicate) { const found = trace.find(predicate);
  return found ? Promise.resolve(found) : new Promise(resolve => waiters.push({ predicate, resolve })); }
const fakeParent = new EventEmitter(); Object.assign(fakeParent, { pid: process.pid, env: {}, argv: [], exitCode: 0 });
const inertTimers = new Set();
const fakeTimeout = (fn, ms) => { const token = { fn, ms }; inertTimers.add(token); return token; };
const fakeClear = token => inertTimers.delete(token);
let workerChild, workerClosed, altered = false;
const fork = (requestedFile, requestedArgs) => {
  note('fork.inert-substitution', { requestedFile, requestedArgs });
  const argv = [process.execPath, '--input-type=module', '-'];
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: {} });
  workerChild = child;
  let stdout = '', stderr = '', buffered = '', traceError = null, timedOut = false, termSent = false, graceExpired = false, timer, grace;
  child.stdout.on('data', data => {
    stdout += data; buffered += data;
    let end;
    while ((end = buffered.indexOf('\\n')) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (!line) continue;
      try { note('worker.trace', { row: JSON.parse(line) }); } catch (failure) { traceError = String(failure); }
    }
  });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', failure => { stderr += String(failure) + '\\n'; });
  const realSend = child.send.bind(child), realEmit = child.emit.bind(child);
  child.sendControl = message => realSend(message, () => {});
  child.send = (message, callback) => { note('parent.request', { message }); return realSend(message, callback); };
  child.emit = (event, ...args) => {
    if (event !== 'message') return realEmit(event, ...args);
    let message = args[0]; note('transport.received', { message });
    if (scenario.fault && message.receipt && !altered) {
      altered = true; message = structuredClone(message);
      if (scenario.fault === 'wrong-envelope-id') message.id += 100;
      else if (scenario.fault === 'wrong-receipt-id') message.receipt.id += 100;
      else if (scenario.fault === 'wrong-tool') message.receipt.tool = 'close_tab';
      else if (scenario.fault === 'missing-receipt') delete message.receipt;
      note('transport.injected-fault', { fault: scenario.fault, message });
      const value = realEmit(event, message, ...args.slice(1));
      if (scenario.fault === 'duplicate') { note('transport.duplicate', { message }); realEmit(event, message, ...args.slice(1)); }
      return value;
    }
    return realEmit(event, ...args);
  };
  workerClosed = new Promise(resolve => {
    child.once('close', async (code, signal) => {
      clearTimeout(timer); clearTimeout(grace);
      const result = { argv, code, signal, childPid: child.pid, timedOut, termSent, graceExpired, traceError };
      await Promise.all([fs.writeFile(path.join(directory, 'worker.stdout.txt'), stdout), fs.writeFile(path.join(directory, 'worker.stderr.txt'), stderr),
        fs.writeFile(path.join(directory, 'worker-result.json'), JSON.stringify(result, null, 2) + '\\n')]);
      note('worker.closed', result); resolve(result);
    });
    timer = setTimeout(() => { timedOut = true; termSent = child.kill('SIGTERM');
      grace = setTimeout(async () => {
        graceExpired = true; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        const result = { argv, code: null, signal: null, timedOut, termSent, graceExpired, ownChildCompletion: 'unconfirmed', traceError };
        await Promise.all([fs.writeFile(path.join(directory, 'worker.stdout.txt'), stdout), fs.writeFile(path.join(directory, 'worker.stderr.txt'), stderr),
          fs.writeFile(path.join(directory, 'worker-result.json'), JSON.stringify(result, null, 2) + '\\n')]);
        note('worker.closed', result); resolve(result);
      }, 2000);
    }, 1800);
  });
  child.stdin.end(workerCode); return child;
};
const forbidden = name => () => { note('forbidden', { name }); throw Error('forbidden parent dependency: ' + name); };
const context = vm.createContext({ assert, fs, path, os: {}, createHash, randomUUID: () => 'inert-rpc-binding',
  fileURLToPath, pathToFileURL, fork, readTerminalReceipt, productErrorFact, workerFailureFact, rpcFailureFact,
  disposeTerminal: forbidden('parent.disposeTerminal'), createServer: forbidden('createServer'),
  createBoundsEvidenceCollector: forbidden('boundsCollector'), readBoundsEvidenceReceipt: forbidden('boundsReceipt'),
  process: fakeParent, Date, AbortController, AsyncLocalStorage, URL, console,
  setTimeout: fakeTimeout, clearTimeout: fakeClear, setInterval: forbidden('setInterval'), clearInterval: fakeClear,
  inertImport: forbidden('parent.dynamicImport'),
});
vm.runInContext(${JSON.stringify(parts.executable)}, context, { filename: 'actual-parent-core.js' });
const fingerprint = vm.runInContext('({ legacy: fixtureHTML("inert"), scroll: scrollFixtureHTML("inert"), pins: JSON.stringify(SCROLL_SOURCE_PINS) })', context);
note('frozen.fixtures', Object.fromEntries(Object.entries(fingerprint).map(([name, value]) => [name + 'Sha256', createHash('sha256').update(value).digest('hex')])));
const options = { case: scenario.mode || 'input', source: '/inert-product', seconds: 10 };
const url = 'http://127.0.0.1/fixture-inert';
const worker = await context.makeInertWorker(options, workerDirectory, 'inert', url);
const report = { calls: [], checks: [], observations: [], cleanup: [] };
const h = await context.buildInertParent(report, options, directory, url, 'inert');
h.workers.push(worker);
if (!scenario.mode) h.owned.push({ worker, tabId: 7, windowId: 9, chromePid: 20, cgWindow: 29, exact: true, closable: true });
const originalDelete = h.inflight.delete.bind(h.inflight);
h.inflight.delete = request => { note('inflight.delete', { terminal: h.state.terminal, rpcId: request.rpcId }); return originalDelete(request); };
note('parent.ready');
const settle = promise => promise.then(value => ({ status: 'fulfilled', value }), failure => ({ status: 'rejected', code: failure.code,
  name: failure.name, message: failure.message, inputDelivery: failure.inputDelivery, noRetry: failure.noRetry }));
const a = settle(h.call(worker, 'click', { tab: 7, qaSlot: 'A' }));
await waitFor(row => row.effect === 'worker.trace' && row.row.effect === 'client.dispatch' && row.row.slot === 'A');
const b = settle(h.call(worker, 'type_text', { tab: 7, qaSlot: 'B' }));
await waitFor(row => row.effect === 'worker.trace' && row.row.effect === 'client.dispatch' && row.row.slot === 'B');
const normal = slot => ({ isError: false, content: [], qaSlot: slot });
const release = (slot, reply) => { note('parent.release', { slot }); workerChild.sendControl({ qaControl: 'release', slot, reply }); };
if (scenario.kind === 'terminal') release('A', { isError: true, content: [], structuredContent: { error: {
  code: 'native_target_changed', stage: 'native_prepare', inputDelivery: scenario.delivery || 'sent' } } });
else if (scenario.kind === 'external-abort') h.abort('operator_abort');
else {
  release('B', normal('B'));
  await waitFor(row => row.effect === 'transport.received' && row.message.receipt?.tool === 'type_text');
  if (!scenario.fault) release('A', normal('A'));
}
const results = await Promise.all([a, b]);
note('parent.results', { results });
if (scenario.kind === 'terminal' || scenario.kind === 'external-abort' || scenario.fault) {
  const count = trace.filter(row => row.effect === 'parent.request').length;
  const after = await settle(h.call(worker, 'read_page', { tab: 7 }));
  await h.cleanup();
  note('parent.after-terminal', { after, requestCountBefore: count, requestCountAfter: trace.filter(row => row.effect === 'parent.request').length });
}
if (!scenario.fault && scenario.kind !== 'terminal' && scenario.kind !== 'external-abort') await worker.disconnect();
const closed = await workerClosed;
if (scenario.fault) {
  const sentBefore = trace.filter(row => row.effect === 'parent.request').length;
  const future = worker.rpc('call', { name: 'read_page', args: { tab: 7 } });
  const futureResult = await settle(future);
  note('parent.protocol-future', { futureResult, rpcId: future.rpcId,
    sentBefore, sentAfter: trace.filter(row => row.effect === 'parent.request').length });
}
note('parent.report', { calls: report.calls, terminalReceipts: report.terminalReceipts || [], state: h.state,
  inflight: h.inflight.size, closed, receiptFrozen: report.calls.filter(row => row.receipt).map(row => Object.isFrozen(row.receipt)),
  samePublicReplies: results.filter(row => row.status === 'fulfilled').map(row => row.value) });
note('driver.complete');
`;
  if (scenario.mode === 'same-connection-writes') {
    const start = generated.indexOf("const a = settle(h.call(worker, 'click'");
    const end = generated.lastIndexOf("note('driver.complete');");
    assert.ok(start > 0 && end > start, 'replace only the inert parent scenario driver');
    generated = generated.slice(0, start) + caseDriver() + generated.slice(end);
  }
  return generated;
}

function caseDriver() { return `
const normal = slot => ({ isError: false, content: [], qaSlot: slot });
const release = (slot, reply = normal(slot)) => { note('parent.release', { slot }); workerChild.sendControl({ qaControl: 'release', slot, reply }); };
let caseResult, thirdResult = null;
if (scenario.kind === 'worker-invalid-payload') {
  const adapter = h.adapter(worker);
  await adapter.plan(); const tab = await adapter.open();
  await h.call(worker, 'read_page', { tab, full: true });
  const prepared = await worker.rpc('sample', { tab });
  const args = { tab, marker: prepared.markers.A, text: 'fixture-A-17', input_mode: 'keys', submit: false };
  if (scenario.payloadFault === 'marker') args.marker = prepared.markers.B;
  if (scenario.payloadFault === 'text') args.text = 'unexpected-inert-text';
  if (scenario.payloadFault === 'input-mode') args.input_mode = 'paste';
  if (scenario.payloadFault === 'submit') args.submit = true;
  note('case.invalid-payload', { payloadFault: scenario.payloadFault });
  caseResult = await settle(worker.rpc('call', { name: 'type_text', args }));
  note('case.result', { result: caseResult });
} else {
  const task = settle(context.executeInertCase('same-connection-writes', h.adapter(worker))).then(result => {
    note('case.result', { result }); return result;
  });
  const first = await waitFor(row => row.effect === 'case.result'
    || (row.effect === 'worker.trace' && row.row.effect === 'client.dispatch' && row.row.slot === 'A'));
  if (first.effect !== 'case.result') {
    if (scenario.nonOverlap) {
      release('A');
      await waitFor(row => row.effect === 'transport.received' && row.message.receipt?.tool === 'type_text');
      workerChild.sendControl({ qaControl: 'resume-B-preflight' });
      await waitFor(row => row.effect === 'worker.trace' && row.row.effect === 'client.dispatch' && row.row.slot === 'B');
      release('B');
    } else {
      await waitFor(row => row.effect === 'worker.trace' && row.row.effect === 'client.dispatch' && row.row.slot === 'B');
      if (scenario.kind === 'case-terminal') release('A', { isError: true, content: [], structuredContent: { error: {
        code: 'native_target_changed', stage: 'native_prepare', inputDelivery: 'sent' } } });
      else {
        const firstSlot = scenario.eventFault === 'B-first' ? 'B' : 'A';
        release(firstSlot);
        await waitFor(row => row.effect === 'transport.received' && row.message.receipt?.tool === 'type_text');
        release(firstSlot === 'A' ? 'B' : 'A');
      }
    }
  }
  caseResult = await task;
  if (caseResult.status === 'fulfilled' && scenario.kind === 'worker-third-write') {
    const third = worker.rpc('call', { name: 'type_text', args: { tab: 7, marker: 1, text: 'fixture-A-17', input_mode: 'keys', submit: false } });
    thirdResult = await settle(third); note('case.third-write', { rpcId: third.rpcId, result: thirdResult });
  }
  if (caseResult.status === 'fulfilled' && scenario.kind === 'case-healthy') {
    const before = trace.filter(row => row.effect === 'parent.request').length;
    const repeated = await settle(h.sameConnectionWrites(worker, 7));
    note('case.repeat-helper', { result: repeated, requestCountBefore: before,
      requestCountAfter: trace.filter(row => row.effect === 'parent.request').length });
  }
}
if (workerChild.connected && !h.state.terminal) await worker.disconnect();
const closed = await workerClosed, terminalEvidence = await worker.terminalEvidence();
note('parent.report', { calls: report.calls, terminalReceipts: report.terminalReceipts || [], state: h.state,
  inflight: h.inflight.size, closed, caseResult, thirdResult, terminalEvidence,
  sameConnectionWrites: report.sameConnectionWrites || null, ownedCount: h.owned.length,
  checks: report.checks, receiptFrozen: report.calls.filter(row => row.receipt).map(row => Object.isFrozen(row.receipt)) });
`; }

let failures = 0;
const checks = [];
async function test(name, fn) {
  try {
    await fn(); checks.push({ name, completed: true }); console.log(`ok ${name}`);
  } catch (failure) {
    failures++; checks.push({ name, completed: false, error: failure.stack }); console.error(`not ok ${name}\n${failure.stack}`);
  }
}

function validChild(result) {
  assert.equal(result.traceParseError, null, 'non-JSON capsule output is an infrastructure failure, with complete streams retained');
  assert.equal(result.timedOut, false, 'controlled child must not time out');
  assert.equal(result.signal, null, 'controlled child must not be signalled');
  assert.equal(result.graceExpired, false, 'owned child completion must be confirmed');
  assert.doesNotMatch(result.stderr, /SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|ERR_VM_DYNAMIC_IMPORT/,
    'capsule compilation/import failures are never behavioral results');
  assert.ok(result.trace.some(row => row.effect === 'ipc.send' && row.message.ready === true), 'actual worker initialized');
  assert.equal(result.trace.some(row => row.effect === 'forbidden'), false, 'only inert dependencies execute');
}

function successfulPair(result, order, overlap) {
  validChild(result);
  const dispatches = result.trace.filter(row => row.effect === 'client.dispatch');
  assert.deepEqual(dispatches.map(row => row.slot), ['A', 'B'], 'both actual dispatch bodies reached the inert client');
  const releases = result.trace.filter(row => row.effect === 'driver.release');
  assert.deepEqual(releases.map(row => row.slot), order, 'gates released in the selected order');
  if (overlap) assert.ok(dispatches[1].sequence < releases[0].sequence, 'both actual dispatches overlap');
  assert.equal(result.code, 0, `${result.name}: independent successful RPCs must both reply; actual terminal=${result.receipt?.terminal?.code}, call=${JSON.stringify(result.receipt?.call)}`);
  const replies = result.trace.filter(row => row.effect === 'ipc.send' && [11, 12].includes(row.message.id));
  assert.deepEqual(replies.map(row => row.message.id), order.map(slot => slot === 'A' ? 11 : 12), 'each RPC keeps its own reply id');
  assert.equal(result.trace.some(row => row.effect === 'terminal'), false, 'successful overlap is not terminal');
  for (const { message } of replies) {
    const slot = message.id === 11 ? 'A' : 'B', receipt = message.receipt;
    assert.deepEqual(Object.keys(receipt).sort(), ['id', 'tool', 'startedSequence', 'dispatchSequence', 'settleSequence'].sort(),
      'each successful RPC owns a complete bounded receipt');
    assert.equal(receipt.id, message.id); assert.equal(receipt.tool, slot === 'A' ? 'click' : 'type_text');
    assert.deepEqual(message.value, { isError: false, content: [], qaSlot: slot }, 'the public reply is not replaced with metadata');
    assert.ok([receipt.startedSequence, receipt.dispatchSequence, receipt.settleSequence].every(n => Number.isSafeInteger(n) && n > 0));
    assert.ok(receipt.startedSequence < receipt.dispatchSequence && receipt.dispatchSequence < receipt.settleSequence,
      'one call cannot borrow another call settlement');
  }
  const all = replies.flatMap(row => ['startedSequence', 'dispatchSequence', 'settleSequence'].map(key => row.message.receipt[key]));
  assert.equal(new Set(all).size, 6, 'worker call events are distinct');
  if (overlap) {
    const a = replies.find(row => row.message.id === 11).message.receipt;
    const b = replies.find(row => row.message.id === 12).message.receipt;
    assert.ok(a.dispatchSequence < b.dispatchSequence && b.dispatchSequence < a.settleSequence, 'actual worker receipts prove overlap');
  }
}

function terminal(result, reason, slot, { response = false, productError = null } = {}) {
  validChild(result);
  assert.equal(result.code, 86, 'actual synchronous terminal helper must exit 86');
  assert.equal(result.receipt?.schema, 1); assert.equal(result.receipt.terminal.code, reason);
  assert.equal(result.receipt.terminal.inputDelivery, 'unknown'); assert.equal(result.receipt.terminal.noRetry, true);
  if (slot === null) {
    assert.equal(result.receipt.call, null, 'unattributed terminal cannot borrow a pending RPC');
    assert.equal(result.receipt.terminal.stage, 'worker');
  } else {
    const expected = result.trace.map(row => row.context).find(c => c?.id === (slot === 'A' ? 11 : 12));
    assert.ok(expected, 'actual context was observed at a dependency boundary');
    assert.equal(result.receipt.call?.tool, slot === 'A' ? 'click' : 'type_text', 'terminal must retain the initiating call tool');
    assert.equal(result.receipt.call.startedAt, expected.startedAt, 'terminal must retain the initiating call start');
    if (response) assert.ok(result.receipt.call.responseAt > expected.startedAt, 'own response timestamp is present');
    else assert.equal(result.receipt.call.responseAt, null, 'preflight terminal has no fabricated response time');
  }
  if (productError) assert.deepEqual(result.receipt.productError, productError, 'only initiating response supplies productError');
  else assert.equal(Object.hasOwn(result.receipt, 'productError'), false, 'absent productError stays absent');
  const seals = result.trace.filter(row => row.effect === 'terminal');
  assert.equal(seals.length, 1, 'the first synchronous terminal seals once');
  assert.deepEqual(result.trace.filter(row => row.sequence > seals[0].sequence), [], 'no continuation after the real seal');
}

async function killWorkerMutant(name, scenario, oracle, { order = ['A', 'B'], overlap = true } = {}) {
  const result = await runChild(`mutant-${name}`, order, overlap, scenario, name);
  validChild(result);
  let failure;
  try { oracle(result); } catch (caught) { failure = caught; }
  assert.ok(failure?.code === 'ERR_ASSERTION', `valid mutant ${name} must fail its behavioral oracle`);
  await fs.writeFile(path.join(evidenceRoot, `mutant-${name}`, 'killed-by.json'), JSON.stringify({
    mutant: name, assertion: failure.message, stack: failure.stack, sourceSha256: digest(source),
    workerPrefixSha256: result.workerPrefixSha256, capsuleSha256: result.stdinSha256,
  }, null, 2) + '\n');
}

for (const [name, order, overlap] of [
  ['sequential-control', ['A', 'B'], false], ['overlap-a-first', ['A', 'B'], true], ['overlap-b-first', ['B', 'A'], true],
]) await test(name, async () => successfulPair(await runChild(name, order, overlap), order, overlap));

const preflightReasons = { fresh: 'screen_locked_or_unreadable', own: 'fixture_identity_changed',
  fence: 'original_hold_unhealthy', lease: 'original_lease_changed' };
function refusedB(result, fault) {
  validChild(result);
  assert.deepEqual(result.trace.filter(row => row.effect === 'client.dispatch').map(row => row.slot), ['A'],
    'B preflight refusal must happen before any B client dispatch');
  terminal(result, preflightReasons[fault], 'B');
}
for (const fault of Object.keys(preflightReasons)) await test(`worker-B-${fault}-while-A-pending`, async () =>
  refusedB(await runChild(`worker-B-${fault}`, ['A', 'B'], true, { kind: 'preflight', fault }), fault));

const machineError = delivery => ({ code: 'native_target_changed', stage: 'native_prepare', inputDelivery: delivery });
for (const delivery of ['sent', 'not_sent', 'unknown']) await test(`worker-A-machine-error-${delivery}-while-B-pending`, async () => {
  const r = await runChild(`worker-A-error-${delivery}`, ['A', 'B'], true, { kind: 'machine-error', delivery });
  terminal(r, 'unexpected_mcp_error', 'A', { response: true, productError: machineError(delivery) });
  assert.deepEqual(r.trace.filter(row => row.effect === 'client.dispatch').map(row => row.slot), ['A', 'B']);
  assert.equal(r.trace.some(row => row.effect === 'ipc.send' && [11, 12].includes(row.message.id)), false);
});

for (const action of ['abort', 'disconnect']) await test(`worker-external-${action}-has-null-preflight-context`, async () => {
  const r = await runChild(`worker-external-${action}`, [], false, { kind: 'external-preflight', action });
  terminal(r, action === 'abort' ? 'parent_abort' : 'parent_disconnected', null);
  assert.deepEqual(r.trace.filter(row => row.effect === 'preflight.blocked').map(row => row.slot), ['A', 'B']);
  assert.equal(r.trace.some(row => row.effect === 'client.dispatch'), false);
});

await test('worker-IPC-callback-restores-A-context-even-when-invoked-under-B', async () => {
  const r = await runChild('worker-IPC-callback', [], true, { kind: 'ipc-callback' });
  terminal(r, 'ipc_response_lost', 'A', { response: true });
  assert.ok(r.trace.some(row => row.effect === 'driver.callback-context' && row.slot === 'B'));
});
for (const [kind, reason] of [['unknown-operation', 'unknown_worker_operation'],
  ['unattributed-read', 'inert_read_failure'], ['invalid-envelope', 'invalid_worker_envelope']]) {
  await test(`worker-${kind}-has-null-context`, async () =>
    terminal(await runChild(`worker-${kind}`, [], false, { kind }), reason, null));
}
function freshAfterReply(result) {
  terminal(result, 'screen_locked_or_unreadable', 'A', { response: true });
  assert.equal(result.trace.some(row => row.effect === 'ipc.send' && row.message.id === 11), false, 'unhealthy return cannot send success');
}
await test('worker-post-response-fresh-remains-required', async () =>
  freshAfterReply(await runChild('worker-post-response-fresh', [], false, { kind: 'post-response-fresh' })));

function queuedTerminal(result) {
  validChild(result);
  assert.equal(result.trace.some(row => row.effect === 'queued.second-continuation' || row.effect === 'queued.followup-request'
    || (row.effect === 'worker.response' && row.slot === 'B')), false,
  'already-queued second RPC/read/sample/release continuations must not run');
  terminal(result, 'unexpected_mcp_error', 'A', { response: true, productError: machineError('sent') });
  assert.deepEqual(result.trace.filter(row => row.effect === 'driver.release').map(row => row.slot), ['A', 'B'], 'both promises were released before terminal');
  assert.ok(result.trace.some(row => row.effect === 'driver.followups-armed'), 'followups were queued from the actual A response clock boundary');
  assert.equal(result.trace.some(row => row.effect === 'ipc.send' && [11, 12].includes(row.message.id)), false, 'no IPC success after terminal');
}
await test('worker-real86-stops-already-queued-second-RPC-and-followups', async () =>
  queuedTerminal(await runChild('worker-real86', [], true, { kind: 'queued-terminal' })));
for (const [name, fault] of [['missing-directory', { missingDirectory: true }], ['exclusive-write-conflict', { occupiedReceipt: true }]]) {
  await test(`worker-real87-${name}`, async () => {
    const r = await runChild(`worker-real87-${name}`, [], true, { kind: 'queued-terminal', ...fault });
    validChild(r); assert.equal(r.code, 87, 'actual protected helper write failure exits 87');
    assert.equal(r.receipt, null); assert.ok(r.receiptError, 'receipt validation must actually fail');
    assert.ok(r.trace.some(row => row.effect === 'terminal' && row.code === 'unexpected_mcp_error'));
    assert.equal(r.trace.some(row => row.effect.startsWith('queued.')), false, 'write failure still exits synchronously');
  });
}

await test('mutant-shared-current-call-is-killed', async () =>
  killWorkerMutant('shared-current-call', {}, r => successfulPair(r, ['A', 'B'], true)));
await test('mutant-cross-call-finally-is-killed', async () =>
  killWorkerMutant('cross-call-finally', {}, r => successfulPair(r, ['A', 'B'], true)));
await test('mutant-latest-terminal-is-killed', async () =>
  killWorkerMutant('latest-terminal', { kind: 'machine-error' }, r => terminal(r, 'unexpected_mcp_error', 'A', { response: true, productError: machineError('sent') })));
await test('mutant-missing-own-is-killed', async () =>
  killWorkerMutant('missing-own', { kind: 'preflight', fault: 'own' }, r => refusedB(r, 'own')));
await test('mutant-missing-fresh-is-killed', async () =>
  killWorkerMutant('missing-fresh-after-reply', { kind: 'post-response-fresh' }, freshAfterReply));
for (const kind of ['asynchronous-terminal', 'return-only-terminal']) await test(`mutant-${kind}-is-killed`, async () =>
  killWorkerMutant(kind, { kind: 'queued-terminal' }, queuedTerminal));

function validParent(result) {
  assert.equal(result.traceParseError, null, 'parent capsule stream is valid NDJSON');
  assert.equal(result.timedOut, false); assert.equal(result.signal, null); assert.equal(result.graceExpired, false);
  assert.doesNotMatch(result.stderr, /SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/);
  assert.equal(result.code, 0, 'parent capsule completes, independently of behavioral assertions');
  assert.ok(result.trace.some(row => row.effect === 'parent.ready'));
  assert.ok(result.trace.some(row => row.effect === 'driver.complete'));
  assert.equal(result.trace.some(row => row.effect === 'forbidden' || (row.effect === 'worker.trace' && row.row.effect === 'forbidden')), false);
  const closed = result.trace.find(row => row.effect === 'worker.closed');
  assert.ok(closed, 'actual owned inert worker completion is captured');
  assert.equal(closed.signal, null); assert.equal(closed.timedOut, false); assert.equal(closed.termSent, false);
  assert.equal(closed.graceExpired, false); assert.equal(closed.traceError, null);
  assert.deepEqual(closed.argv, [process.execPath, '--input-type=module', '-'], 'the requested live entrypoint was never executed');
  return result.trace.find(row => row.effect === 'parent.report');
}
const parentRun = (name, scenario, mutant = null) => runChild(name, [], false, scenario, mutant,
  directory => parentCapsule(directory, scenario, mutant));

await test('actual-parent-reverse-replies-retain-own-id-tool-events-and-public-value', async () => {
  const r = await parentRun('parent-reverse-success', { kind: 'success' });
  const report = validParent(r);
  assert.equal(report.closed.code, 0); assert.equal(report.state.terminal, null); assert.equal(report.inflight, 0);
  assert.deepEqual(report.calls.map(row => row.tool), ['type_text', 'click']);
  assert.deepEqual(report.receiptFrozen, [true, true], 'accepted internal receipts are immutable');
  const requests = r.trace.filter(row => row.effect === 'parent.request' && row.message.op === 'call');
  assert.deepEqual(requests.map(row => row.message.name), ['click', 'type_text']);
  assert.equal(new Set(requests.map(row => row.message.id)).size, 2);
  for (const row of report.calls) {
    const request = requests.find(item => item.message.name === row.tool).message;
    assert.equal(row.rpcId, request.id); assert.equal(row.receipt.id, request.id); assert.equal(row.receipt.tool, request.name);
    assert.ok(row.receipt.startedSequence < row.receipt.dispatchSequence && row.receipt.dispatchSequence < row.receipt.settleSequence);
  }
  assert.deepEqual(report.samePublicReplies, [{ isError: false, content: [], qaSlot: 'A' }, { isError: false, content: [], qaSlot: 'B' }]);
});

function parentTerminalRows(result, expectedReason = 'dispatched_rpc_rejected', delivery = 'sent') {
  const report = validParent(result);
  assert.equal(report.closed.code, 86); assert.equal(report.state.terminal, expectedReason); assert.equal(report.inflight, 0);
  assert.equal(report.terminalReceipts.length, 1, 'one worker terminal is recorded once for multiple pending RPCs');
  const receipt = report.terminalReceipts[0];
  assert.equal(receipt.schema, 1); assert.equal(receipt.terminal.inputDelivery, 'unknown'); assert.equal(receipt.terminal.noRetry, true);
  if (expectedReason === 'operator_abort') { assert.equal(receipt.call, null); assert.equal(Object.hasOwn(receipt, 'productError'), false); }
  else { assert.equal(receipt.call.tool, 'click'); assert.deepEqual(receipt.productError, machineError(delivery)); }
  assert.equal(report.calls.length, 2); assert.equal(new Set(report.calls.map(row => row.rpcId)).size, 2);
  const sent = result.trace.filter(row => row.effect === 'parent.request' && row.message.op === 'call').map(row => row.message);
  for (const row of report.calls) {
    assert.equal(row.tool, sent.find(request => request.id === row.rpcId).name, 'failed row retains its own request facts');
    assert.equal(row.inputDelivery, 'unknown'); assert.equal(row.noRetry, true);
    assert.equal(Object.hasOwn(row, 'productError'), false, 'worker productError must never be forged as a pending call fact');
    assert.deepEqual(row.workerTerminalRef, { workerPid: receipt.workerPid, schema: 1 });
    assert.equal(row.terminalRpcAttribution, 'unknown', 'schema1 receipt has no RPC id');
  }
  assert.ok(result.trace.filter(row => row.effect === 'inflight.delete').every(row => row.terminal === expectedReason), 'terminal precedes inflight removal');
  const after = result.trace.find(row => row.effect === 'parent.after-terminal');
  assert.equal(after.after.status, 'rejected'); assert.equal(after.requestCountAfter, after.requestCountBefore, 'no parent call/read/cleanup continuation');
}
for (const delivery of ['sent', 'not_sent', 'unknown']) await test(`actual-parent-two-pending-one-terminal-${delivery}`, async () =>
  parentTerminalRows(await parentRun(`parent-two-pending-terminal-${delivery}`, { kind: 'terminal', delivery }), 'dispatched_rpc_rejected', delivery));
await test('actual-parent-external-abort-does-not-invent-last-call-attribution', async () =>
  parentTerminalRows(await parentRun('parent-external-abort', { kind: 'external-abort' }), 'operator_abort'));

for (const fault of ['wrong-envelope-id', 'wrong-receipt-id', 'wrong-tool', 'missing-receipt', 'duplicate']) {
  await test(`actual-parent-${fault}-fails-closed`, async () => {
    const r = await parentRun(`parent-protocol-${fault}`, { kind: 'protocol', fault });
    const report = validParent(r);
    assert.equal(report.closed.code, 86); assert.equal(report.state.terminal, 'dispatched_rpc_rejected');
    assert.ok(report.calls.some(row => row.code === 'worker_reply_invalid'));
    assert.equal(r.trace.filter(row => row.effect === 'parent.request' && row.message.op === 'abort').length, 1, 'protocol failure sends one sealing abort');
    const future = r.trace.find(row => row.effect === 'parent.protocol-future');
    assert.equal(future.futureResult.status, 'rejected'); assert.equal(future.futureResult.code, 'worker_reply_invalid');
    assert.equal(future.futureResult.inputDelivery, 'unknown'); assert.equal(future.futureResult.noRetry, true);
    assert.equal(future.sentAfter, future.sentBefore, 'protocol failure forbids future transport sends');
  });
}
await test('mutant-copied-worker-product-error-is-killed-by-two-pending-parent-rows', async () => {
  const r = await parentRun('mutant-copied-worker-product-error', { kind: 'terminal' }, 'copied-worker-product-error');
  validParent(r);
  let failure;
  try { parentTerminalRows(r); } catch (caught) { failure = caught; }
  assert.ok(failure?.code === 'ERR_ASSERTION'); assert.match(failure.message, /worker productError/);
  await fs.writeFile(path.join(evidenceRoot, 'mutant-copied-worker-product-error', 'killed-by.json'), JSON.stringify({
    mutant: 'copied-worker-product-error', assertion: failure.message, stack: failure.stack, capsuleSha256: r.stdinSha256,
  }, null, 2) + '\n');
});

const caseRun = (name, scenario, mutant = null) => parentRun(name, { mode: 'same-connection-writes', ...scenario }, mutant);
const publicWrites = result => result.trace.filter(row => row.effect === 'parent.request' && row.message.op === 'call' && row.message.name === 'type_text');
const workerRows = result => result.trace.filter(row => row.effect === 'worker.trace').map(row => row.row);
const typeDispatches = result => workerRows(result).filter(row => row.effect === 'client.dispatch' && row.tool === 'type_text');

function healthyCase(result) {
  const report = validParent(result);
  assert.equal(report.closed.code, 0); assert.equal(report.caseResult.status, 'fulfilled');
  assert.equal(report.state.terminal, null); assert.equal(report.ownedCount, 1);
  assert.equal(result.trace.filter(row => row.effect === 'fork.inert-substitution').length, 1, 'one worker');
  assert.equal(workerRows(result).filter(row => row.effect === 'transport.connect-client').length, 1, 'one SDK Client');
  const requests = result.trace.filter(row => row.effect === 'parent.request');
  assert.equal(requests.filter(row => row.message.name === 'task_plan').length, 1, 'one task');
  assert.equal(requests.filter(row => row.message.name === 'open_tab').length, 1, 'one fixture target');
  assert.equal(requests.filter(row => row.message.name === 'read_page').length, 1, 'one marker preparation read');
  const writes = publicWrites(result);
  assert.equal(writes.length, 2, 'the bounded helper submits exactly two public writes');
  assert.deepEqual(writes.map(row => row.message.args), [
    { tab: 7, marker: 1, text: 'fixture-A-17', input_mode: 'keys', submit: false },
    { tab: 7, marker: 2, text: 'fixture-B-29', input_mode: 'keys', submit: false },
  ]);
  assert.ok(writes.every(row => /^[\x20-\x7e]{1,32}$/.test(row.message.args.text)));
  assert.deepEqual(requests.filter(row => row.sequence > writes[0].sequence && row.sequence < writes[1].sequence), [],
    'no parent read/sample/observe/third RPC occurs inside the dual-write interval');
  const samples = requests.filter(row => row.message.op === 'sample');
  assert.equal(samples.length, 2); assert.ok(samples[0].sequence < writes[0].sequence, 'both markers are sampled before writing');
  const typedIds = writes.map(row => row.message.id);
  const replies = result.trace.filter(row => row.effect === 'transport.received' && typedIds.includes(row.message.id));
  assert.equal(replies.length, 2); assert.ok(replies.every(row => row.sequence < samples[1].sequence), 'both successful replies precede the final sampler');
  assert.deepEqual(typeDispatches(result).map(row => row.slot), ['A', 'B']);
  for (const id of typedIds) {
    const own = workerRows(result).find(row => row.effect === 'own.record' && row.context?.id === id);
    const fresh = workerRows(result).find(row => row.effect === 'fence.health' && row.context?.id === id);
    const dispatch = workerRows(result).find(row => row.effect === 'client.dispatch' && row.context?.id === id);
    assert.ok(own && fresh && dispatch && own.sequence < dispatch.sequence && fresh.sequence < dispatch.sequence,
      'each of the two actual worker calls keeps fresh and own preflight');
  }
  const receipts = report.sameConnectionWrites.receipts;
  assert.ok(receipts[0].dispatchSequence < receipts[1].dispatchSequence && receipts[1].dispatchSequence < receipts[0].settleSequence,
    'actual worker receipts, not parent promise timing, prove overlap');
  const sample = report.state.sameConnectionEvidence.sample;
  assert.deepEqual(sample.identity, { chromePid: 20, windowId: 9, tabId: 7, cgWindow: 29 });
  assert.equal(sample.events.length, 'fixture-A-17'.length + 'fixture-B-29'.length);
  assert.deepEqual(sample.events.map(row => row.field), [...Array('fixture-A-17'.length).fill('A'), ...Array('fixture-B-29'.length).fill('B')]);
  assert.equal(sample.valueMatchesA, true); assert.equal(sample.valueMatchesB, true); assert.equal(sample.untrusted, 0); assert.equal(sample.overflow, false);
  assert.equal(Object.values(sample).some(value => typeof value === 'string'), false, 'sampler reports bounded facts, not page text');
  const repeat = result.trace.find(row => row.effect === 'case.repeat-helper');
  if (repeat) { assert.equal(repeat.result.status, 'rejected'); assert.equal(repeat.result.code, 'same_connection_case_refused');
    assert.equal(repeat.requestCountAfter, repeat.requestCountBefore, 'the helper is one-shot'); }
  const frozen = result.trace.find(row => row.effect === 'frozen.fixtures');
  assert.equal(frozen.legacySha256, '8d64f86cd48cace0c9c4a5e800766b04ed61fcbf955d916b2f2c02df5ec9bfd5', 'legacy fixture output matches the actual RED baseline');
  assert.equal(frozen.scrollSha256, '2c11cc02a878147f9143f6ee8ffa21c8f6a81c5cd8cb57d4c0f879b29997d387', 'scroll fixture output matches the actual RED baseline');
  assert.match(frozen.pinsSha256, /^[0-9a-f]{64}$/, 'SC1 source pin hashes are recorded, not pinned');
}
await test('actual-case-healthy-fixed-fixture-worker-helper-and-sampler', async () =>
  healthyCase(await caseRun('case-healthy', { kind: 'case-healthy' })));

for (const markerFault of ['missing', 'duplicate']) await test(`actual-case-rejects-${markerFault}-markers-before-write`, async () => {
  const r = await caseRun(`case-marker-${markerFault}`, { kind: 'case-invalid', markerFault });
  const report = validParent(r);
  assert.equal(report.caseResult.status, 'rejected'); assert.equal(report.caseResult.code, 'same_connection_markers_invalid');
  assert.equal(publicWrites(r).length, 0); assert.equal(typeDispatches(r).length, 0);
});
for (const identityFault of ['tabId', 'windowId', 'chromePid', 'cgWindow']) await test(`actual-case-rejects-original-${identityFault}-drift`, async () => {
  const r = await caseRun(`case-identity-${identityFault.toLowerCase()}`, { kind: 'case-invalid', identityFault });
  const report = validParent(r);
  assert.equal(report.caseResult.status, 'rejected'); assert.equal(report.closed.code, 86);
  assert.equal(report.terminalEvidence.receipt.terminal.code, 'fixture_identity_changed');
  assert.equal(publicWrites(r).length, 0); assert.equal(typeDispatches(r).length, 0);
});

function rejectedFieldEvidence(result) {
  const report = validParent(result);
  assert.equal(report.caseResult.status, 'rejected', 'wrong field evidence must not count as covered');
  assert.equal(report.caseResult.name, 'AssertionError');
  assert.match(report.caseResult.message, /same_connection_exact_trusted_ordered_fields/);
  assert.equal(report.checks.find(row => row.name === 'same_connection_exact_trusted_ordered_fields').actual, false);
  assert.equal(publicWrites(result).length, 2); assert.equal(typeDispatches(result).length, 2);
}
for (const eventFault of ['wrong-value', 'B-first', 'interleave', 'untrusted', 'duplicate', 'extra-field', 'overflow']) {
  await test(`actual-case-rejects-${eventFault}-through-real-fixture-collector`, async () =>
    rejectedFieldEvidence(await caseRun(`case-events-${eventFault.toLowerCase()}`, { kind: 'case-invalid', eventFault })));
}

function noOverlap(result) {
  const report = validParent(result);
  assert.equal(report.caseResult.status, 'rejected', 'no actual overlap is not covered');
  assert.equal(report.caseResult.code, 'insufficient_overlap');
  assert.equal(report.sameConnectionWrites.actualOverlap, false);
  const [a, b] = report.sameConnectionWrites.receipts;
  assert.ok(a.settleSequence < b.dispatchSequence, 'controlled worker preflight made the calls truly non-overlapping');
  assert.equal(result.trace.filter(row => row.effect === 'parent.request' && row.message.op === 'sample').length, 1,
    'no final sampler after insufficient overlap');
}
await test('actual-case-rejects-real-non-overlap-without-sleeps-or-retry', async () =>
  noOverlap(await caseRun('case-no-overlap', { kind: 'case-invalid', nonOverlap: true })));

for (const payloadFault of ['marker', 'text', 'input-mode', 'submit']) await test(`actual-same-connection-worker-rejects-${payloadFault}`, async () => {
  const r = await caseRun(`case-worker-invalid-${payloadFault}`, { kind: 'worker-invalid-payload', payloadFault });
  const report = validParent(r);
  assert.equal(report.caseResult.status, 'rejected'); assert.equal(report.closed.code, 86);
  assert.equal(report.terminalEvidence.receipt.terminal.code, 'same_connection_write_refused');
  assert.equal(typeDispatches(r).length, 0, 'invalid same-connection write never reaches the inert product client');
});

await test('actual-case-terminal-between-writes-forbids-final-sampler', async () => {
  const r = await caseRun('case-terminal', { kind: 'case-terminal' });
  const report = validParent(r);
  assert.equal(report.caseResult.status, 'rejected'); assert.equal(report.closed.code, 86);
  assert.equal(report.state.terminal, 'dispatched_rpc_rejected');
  assert.equal(resultCount(r, 'sample'), 1, 'only the preparation sampler ran');
  assert.equal(workerRows(r).filter(row => row.effect === 'fixture.sample').length, 1);
  const terminalRow = workerRows(r).find(row => row.effect === 'terminal');
  assert.deepEqual(workerRows(r).filter(row => row.sequence > terminalRow.sequence), []);
});
function resultCount(result, op) { return result.trace.filter(row => row.effect === 'parent.request' && row.message.op === op).length; }

function rejectsThirdWrite(result) {
  const report = validParent(result);
  assert.equal(report.caseResult.status, 'fulfilled', 'the first bounded pair is healthy');
  assert.equal(typeDispatches(result).length, 2, 'the third public write must not reach client.callTool');
  assert.equal(publicWrites(result).length, 3, 'the control genuinely attempted a third public RPC');
  assert.equal(report.thirdResult.status, 'rejected'); assert.equal(report.closed.code, 86);
  assert.equal(report.terminalEvidence.receipt.terminal.code, 'same_connection_write_refused');
}
await test('actual-same-connection-worker-rejects-real-third-RPC', async () =>
  rejectsThirdWrite(await caseRun('case-worker-third-write', { kind: 'worker-third-write' })));

for (const [mutant, scenario, oracle, assertion] of [
  ['missing-overlap', { kind: 'case-invalid', nonOverlap: true }, noOverlap, /no actual overlap is not covered/],
  ['missing-event-order', { kind: 'case-invalid', eventFault: 'B-first' }, rejectedFieldEvidence, /wrong field evidence/],
  ['third-write-allowed', { kind: 'worker-third-write' }, rejectsThirdWrite, /third public write/],
]) await test(`mutant-${mutant}-is-killed-by-actual-case-boundary`, async () => {
  const r = await caseRun(`mutant-${mutant}`, scenario, mutant); validParent(r);
  let failure;
  try { oracle(r); } catch (caught) { failure = caught; }
  assert.ok(failure?.code === 'ERR_ASSERTION', 'valid source mutant must fail the same normal-control oracle');
  assert.match(failure.message, assertion);
  await fs.writeFile(path.join(evidenceRoot, `mutant-${mutant}`, 'killed-by.json'), JSON.stringify({
    mutant, assertion: failure.message, stack: failure.stack, capsuleSha256: r.stdinSha256,
  }, null, 2) + '\n');
});

await fs.writeFile(path.join(evidenceRoot, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
console.log(JSON.stringify({ evidenceRoot, ...manifest, failures }));
if (failures) process.exitCode = 1;
