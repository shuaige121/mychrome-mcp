import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { ORIGIN, DELAY_MS, parseOptions, fixtureHTML, startFixture, procedure } from './page-event-live.mjs';
const token = '00000000-0000-4000-8000-000000000000';
test('default and --check only report readiness/procedure with no UI, host, native or serving effects', () => {
  for (const argv of [[], ['--check']]) {
    const r = spawnSync(process.execPath, ['test/page-event-live.mjs', ...argv], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); const output = JSON.parse(r.stdout);
    assert.equal(output.uiEffects, false); assert.equal(output.hostEffects, false); assert.equal(output.nativeInput, false);
    assert.equal(output.procedureOnly, true); assert.equal(output.channelLoaded, 'unverified'); assert.equal(output.modelReceipt, 'unverified');
    assert.equal(output.origin, ORIGIN); assert.equal(output.delayMs, 4000);
  }
});
test('live execution requires both flags and fixed origin; no arbitrary port or trust/config options', () => {
  for (const args of [['--run'], ['--run', '--check', '--root-operator'], ['--port', '0'], ['--origin', 'https://example.test'], ['--trust'], ['--seconds', '0']]) assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(['--run', '--root-operator', '--runtime', '/fixture']).sourceKind, 'installed');
  const steps = JSON.stringify(procedure()); assert.match(steps, /actual terminal Claude/); assert.match(steps, /shared input lock/);
  assert.match(steps, /native live remains pending/); assert.match(steps, /page_event_ack/);
});
function fixtureDOM(html = fixtureHTML(token)) {
  const timers = [], receipts = []; let now = 100000;
  const dom = new JSDOM(html, { url: `${ORIGIN}/fixture-${token}`, runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window.performance, 'now', { value: () => now });
      window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
      window.fetch = (url, options) => { receipts.push({ url, body: JSON.parse(options.body) }); return Promise.resolve({ ok: true }); };
    } });
  return { dom, timers, receipts, advance(ms) { now += ms; } };
}
test('fixture is inert on load and an untrusted arm never starts its delay', () => {
  const h = fixtureDOM();
  try {
    assert.equal(h.timers.length, 0, 'loading the document must not schedule the prompt');
    const arm = h.dom.window.document.querySelector('#arm'); assert.ok(arm);
    h.advance(9000); arm.click(); arm.onclick({ isTrusted: false });
    assert.equal(h.timers.length, 0); assert.equal(h.receipts.length, 0);
    assert.equal(h.dom.window.document.querySelector('[role="dialog"]'), null);
  } finally { h.dom.window.close(); }
});
test('the actual folded page reader exposes a fresh arm marker through the documented query without arming it', () => {
  const h = fixtureDOM(), w = h.dom.window;
  try {
    // jsdom has no layout: supply only inert geometry, never browser input.
    w.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, right: 170, bottom: 40, width: 160, height: 30 });
    w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
    w.document.elementFromPoint = () => null;
    const code = readFileSync(new URL('../src/page/read.js', import.meta.url), 'utf8');
    const read = args => JSON.parse(w.eval(code.replaceAll('__READ__', () => JSON.stringify(args))));
    assert.doesNotMatch(read({}).text, /Start delayed prompt/);
    const queried = read({ query: 'Start delayed prompt' });
    const marker = queried.text.match(/\[(\d+)\].*Start delayed prompt/); assert.ok(marker, queried.text);
    const registered = w.__chromeBridge.markers[Number(marker[1])];
    assert.equal(registered.control || registered, w.document.querySelector('#arm'));
    assert.equal(h.timers.length, 0);
  } finally { w.close(); }
});
test('actual trusted-handler branch arms once, changes visible content immediately and measures 4000 ms from arm', () => {
  // Calling the handler with a synthetic trusted flag covers fixture logic only;
  // it is NOT evidence that a browser/native input was trusted or delivered.
  for (const choice of [0, 1]) {
    const h = fixtureDOM(), doc = h.dom.window.document;
    try {
      const arm = doc.querySelector('#arm'); assert.ok(arm);
      h.advance(9000); arm.onclick({ isTrusted: true });
      assert.match(doc.querySelector('#result').textContent, /^Armed:/); assert.equal(arm.disabled, true);
      assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, 4000); assert.ok(DELAY_MS > 3000);
      h.advance(500); arm.onclick({ isTrusted: true }); assert.equal(h.timers.length, 1);
      assert.equal(doc.querySelector('[role="dialog"]'), null);
      h.advance(3500); h.timers[0].fn(); const dialog = doc.querySelector('[role="dialog"]'); assert.ok(dialog);
      assert.equal(dialog.querySelector('h2').textContent, 'Session inactive');
      assert.deepEqual([...dialog.querySelectorAll('p')].map(x => x.textContent), ['Your session is inactive. Keep this session open?']);
      const buttons = [...dialog.querySelectorAll('button')]; assert.deepEqual(buttons.map(x => x.textContent), ['Keep session', 'Exit session']);
      buttons[choice].click(); assert.equal(h.receipts.length, 0); assert.ok(doc.querySelector('[role="dialog"]'));
      h.advance(9000); buttons[choice].onclick({ isTrusted: true });
      assert.equal(doc.querySelector('[role="dialog"]'), null);
      assert.deepEqual(h.receipts, [{ url: `/receipt-${token}`, body: { shownAfterMs: 4000, choice: choice === 0 ? 'keep' : 'exit' } }]);
      buttons[choice].onclick({ isTrusted: true }); assert.equal(h.receipts.length, 1);
    } finally { h.dom.window.close(); }
  }
});
test('fixed-port conflict refuses instead of retrying or widening origin', async () => {
  let attempts = 0;
  await assert.rejects(startFixture({ token, listen(server) { attempts++; queueMicrotask(() => server.emit('error', { code: 'EADDRINUSE' })); } }), e => e.code === 'fixture_port_in_use');
  assert.equal(attempts, 1);
});

// Use the actual exported public schemas, with isolated settings and no transport/input.
await import('./isolate-settings.mjs');
const { __toolsForTests } = await import('../src/index.js');
const schemas = new Map(__toolsForTests().map(tool => [tool.name, tool.inputSchema]));
function validate(schema, value, label) {
  assert.equal(schema.type === 'integer' ? Number.isInteger(value) : typeof value === schema.type && (schema.type !== 'object' || value !== null && !Array.isArray(value)), true, label + ' type');
  if (schema.enum) assert.ok(schema.enum.includes(value), label + ' enum');
  if (schema.minLength != null) assert.ok(value.length >= schema.minLength, label + ' minLength');
  if (schema.maxLength != null) assert.ok(value.length <= schema.maxLength, label + ' maxLength');
  if (schema.minimum != null) assert.ok(value >= schema.minimum, label + ' minimum');
  if (schema.type === 'object') {
    for (const key of schema.required || []) assert.ok(key in value, label + ' missing ' + key);
    for (const [key, item] of Object.entries(value)) {
      assert.ok(schema.properties[key] || schema.additionalProperties !== false, label + ' unknown ' + key);
      if (schema.properties[key]) validate(schema.properties[key], item, label + '.' + key);
    }
  }
}
const observations = () => ({ opened_tab: 71, arm_marker: 9,
  received: { event_id: 'synthetic-event', task_generation: 'synthetic-task', delivery_token: 'A'.repeat(43) },
  arm_click_confirmed: true, armed_content_seen: true, fresh_arm_document: true, task_interrupted: false, hold_unknown: false,
  listed_tab: 71, tab_on_screen: true, window_minimized: false, visibility_snapshot_timing: 'before_prompt',
  event_from_fresh_arm: true, event_matches_case_document: true, ack_current_route_accepted: true, input_release_confirmed: true });
const resolve = (value, data) => value?.$ref ? value.$ref.split('.').reduce((o, k) => o?.[k], data) : value;
function verifyProcedureCase(shared, steps, data = observations()) {
  const facts = new Set(), calls = [];
  for (const step of [...shared, ...steps]) {
    for (const fact of step.requiresEvidence) assert.ok(facts.has(fact), `${step.id} requires prior evidence: ${fact}`);
    for (const call of step.calls) {
      const schema = schemas.get(call.tool); assert.ok(schema, 'unknown public tool ' + call.tool);
      const args = Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, resolve(value, data)]));
      validate(schema, args, call.tool);
      if (call.tool === 'task_plan' && !args.done) assert.ok(args.task?.trim(), 'task_plan nonempty task');
      if ('tab' in args) assert.equal(args.tab, data.opened_tab, 'same returned tab');
      if (call.tool === 'click') assert.equal(args.marker, data.arm_marker, 'fresh arm marker');
      if (call.tool === 'page_event_ack') assert.deepEqual(args, data.received, 'exact received ACK fields');
      calls.push({ tool: call.tool, args });
    }
    for (const check of step.checks) {
      if ('equals' in check) assert.equal(data[check.fact], check.equals, check.fact);
      if ('sameAs' in check) assert.equal(data[check.fact], data[check.sameAs], check.fact);
      if ('oneOf' in check) assert.ok(check.oneOf.includes(data[check.fact]), check.fact);
    }
    for (const fact of step.invalidatesEvidence) facts.delete(fact);
    for (const fact of step.recordEvidence) facts.add(fact);
  }
  assert.deepEqual(calls.map(c => c.tool), ['task_plan', 'open_tab', 'read_page', 'read_page', 'click', 'list_tabs', 'page_event_ack', 'task_plan']);
  assert.equal(calls[3].args.query, 'Start delayed prompt'); assert.deepEqual(calls.at(-1).args, { done: true });
  return facts;
}
test('actual public payloads prepare separate fresh cases, check the target, ACK all received fields and verify release before GUI cleanup', () => {
  const plan = procedure(), notify = plan.cases.find(c => c.id === 'notify_only'), auto = plan.cases.find(c => c.id === 'auto');
  assert.ok(notify && auto); verifyProcedureCase(plan.shared, notify.steps);
  assert.ok(verifyProcedureCase(plan.shared, auto.steps).has('cleanup_recorded'));
  assert.notEqual(notify.steps.find(s => s.id === 'fresh_task').calls[0].args.task, auto.steps.find(s => s.id === 'fresh_task').calls[0].args.task);
  assert.equal(notify.steps.some(s => s.id === 'one_attempt_receipt'), false);
  assert.ok(auto.steps.find(s => s.id === 'fresh_task').invalidatesEvidence.includes('input_released'));
  for (const missing of ['deliberately_enable_rule', 'read_arm_marker', 'ordinary_arm_click', 'verify_preparation', 'verify_release'])
    assert.throws(() => verifyProcedureCase(plan.shared, auto.steps.filter(s => s.id !== missing)), /requires prior evidence/);
  for (const [id, before, reason] of [['fresh_task', 'select_auto_safe', 'case_policy_ready'], ['ordinary_arm_click', 'read_arm_marker', 'fresh_arm_marker'],
    ['observe_new_event', 'verify_preparation', 'preparation_confirmed'], ['gui_cleanup_after_release', 'verify_release', 'input_released']]) {
    const reordered = [...auto.steps], moved = reordered.splice(reordered.findIndex(s => s.id === id), 1)[0];
    reordered.splice(reordered.findIndex(s => s.id === before), 0, moved);
    assert.throws(() => verifyProcedureCase(plan.shared, reordered), new RegExp(reason));
  }
});
test('preparation refusals, unknown hold, hidden/minimized target, old event, rejected ACK and unverified release stop the procedure', () => {
  const plan = procedure(), auto = plan.cases.find(c => c.id === 'auto');
  const bad = { arm_click_confirmed: false, armed_content_seen: false, fresh_arm_document: false, task_interrupted: true, hold_unknown: true,
    listed_tab: 72, tab_on_screen: false, window_minimized: true, visibility_snapshot_timing: 'unrecorded',
    event_from_fresh_arm: false, event_matches_case_document: false, ack_current_route_accepted: false, input_release_confirmed: false };
  for (const [fact, value] of Object.entries(bad)) {
    assert.throws(() => verifyProcedureCase(plan.shared, auto.steps, { ...observations(), [fact]: value }), new RegExp(fact));
    // Remove the actual procedure gate: the same bad observation is then accepted.
    // This shows the refusal above depends on that executable prerequisite.
    const mutant = structuredClone(auto.steps);
    for (const step of mutant) step.checks = step.checks.filter(check => check.fact !== fact);
    assert.doesNotThrow(() => verifyProcedureCase(plan.shared, mutant, { ...observations(), [fact]: value }));
  }
});
test('busy-model collection accepts a later snapshot for the same fresh event without claiming pre-event visibility', () => {
  const plan = procedure(), auto = plan.cases.find(c => c.id === 'auto');
  for (const timing of ['after_prompt', 'relative_time_unknown'])
    assert.doesNotThrow(() => verifyProcedureCase(plan.shared, auto.steps, { ...observations(), visibility_snapshot_timing: timing }));
  const verification = auto.steps.find(s => s.id === 'verify_preparation');
  assert.equal(verification.recordEvidence.some(fact => /before|not_yet/.test(fact)), false);
  assert.match(verification.text, /NOT proof of pre-event visibility/);
});
test('invalid required public payloads, wrong ids and incomplete or mismatched ACKs fail actual exported schemas/bindings', () => {
  const plan = procedure(), auto = plan.cases.find(c => c.id === 'auto');
  for (const mutate of [
    s => { delete s.find(x => x.id === 'fresh_document').calls[0].args.why; },
    s => { s.find(x => x.id === 'fresh_document').calls[0].args.why = 'fixture'; },
    s => { s.find(x => x.id === 'fresh_task').calls[0].args.task = ''; },
    s => { s.find(x => x.id === 'read_arm_marker').calls[1].args.tab = 72; },
    s => { delete s.find(x => x.id === 'ordinary_arm_click').calls[0].args.marker; },
    s => { s.find(x => x.id === 'ordinary_arm_click').calls[0].args.marker = 0; },
    s => { s.find(x => x.id === 'ordinary_arm_click').calls[0].args.tab = 72; },
    ...['event_id', 'task_generation', 'delivery_token'].map(key => s => { delete s.find(x => x.id === 'actual_route_ack').calls[0].args[key]; }),
    s => { s.find(x => x.id === 'actual_route_ack').calls[0].args.delivery_token = 'B'.repeat(43); },
    s => { s.find(x => x.id === 'end_task').calls[0].args = { done: 'true' }; }
  ]) { const changed = structuredClone(auto.steps); mutate(changed); assert.throws(() => verifyProcedureCase(plan.shared, changed)); }
});
test('removing the actual arm trusted/one-shot guard reproduces untrusted or repeated scheduling', () => {
  const html = fixtureHTML(token), guard = 'if(!e.isTrusted||armed)return;'; assert.ok(html.includes(guard));
  for (const [replacement, trusted, times] of [['if(armed)return;', false, 1], ['if(!e.isTrusted)return;', true, 2]]) {
    const h = fixtureDOM(html.replace(guard, replacement));
    try {
      const arm = h.dom.window.document.querySelector('#arm'); arm.onclick({ isTrusted: trusted });
      if (times === 2) arm.onclick({ isTrusted: true });
      assert.equal(h.timers.length, times);
    } finally { h.dom.window.close(); }
  }
});
