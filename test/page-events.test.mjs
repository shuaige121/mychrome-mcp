import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as P from '../src/page-events.js';
import { fixture, observation, source, context, template, settings, rule, ack, tick } from './page-event-fixtures.mjs';
const vectors = JSON.parse(readFileSync(new URL('./page-event-settings-vectors.json', import.meta.url)));

test('shared core vectors use the production validators, including exact Unicode and strict authority', () => {
  for (const v of vectors.text) assert.equal(P.normalizePromptText(v.input), v.expected);
  for (const v of vectors.origin) assert.equal(P.canonicalPromptOrigin(v.input), v.expected);
  for (const v of vectors.settings) assert.equal(P.normalizePagePromptSettings(v.raw).valid, v.valid, v.name);
  for (const v of vectors.catalog) {
    const c = structuredClone(P.PAGE_PROMPT_CATALOG); Object.assign(c.templates[0], v.mutate); Object.assign(c, v.wrapperExtra);
    assert.equal(P.validatePromptCatalog(c), v.valid, v.name);
  }
  const c = structuredClone(P.PAGE_PROMPT_CATALOG); Object.assign(c.templates[0], vectors.compositionRule.catalogMutation);
  assert.equal(P.normalizePagePromptSettings({ ...settings, rules: [{ ...rule, ...vectors.compositionRule.ruleMutation }] }, c).valid, false);
  for (const c of [null, {}, { version: 2, templates: [] }]) {
    assert.equal(P.normalizePagePromptSettings(settings, c).reason, 'catalog_unavailable');
  }
  assert.equal(P.validatePromptCatalog(P.PAGE_PROMPT_CATALOG.templates), true);
  assert.equal(P.normalizePagePromptSettings({ ...settings, rules: Array.from({ length: 33 }, (_, i) => ({ ...rule, id: `r${i}` })) }).valid, false);
});

test('full exact origin/template/button and one enabled rule are required', () => {
  const normalized = P.normalizePagePromptSettings(settings);
  assert.deepEqual(P.matchPromptRule(observation(), normalized), rule);
  for (const patch of [{ complete: false }, { hasField: true }, { origin: 'https://example.com' },
    { originEvidence: 'unverified' }, { texts: [template.texts[0] + ' extra'] },
    { buttons: [...template.buttons].reverse() }, { buttons: [template.buttons[0]] }, { title: template.title.toLowerCase() }]) {
    assert.equal(P.matchPromptRule(observation(patch), normalized), null, JSON.stringify(patch));
  }
  for (const raw of [{ ...settings, policy: 'notify_ai' }, { ...settings, rules: [{ ...rule, enabled: false }] },
    { ...settings, rules: [rule, { ...rule, id: 'other' }] }]) assert.equal(P.matchPromptRule(observation(), P.normalizePagePromptSettings(raw)), null);
});

test('identity, expiry tombstones, complete absence and one lifetime attempt', () => {
  const h = fixture(), first = h.event();
  assert.equal(h.event().eventId, first.eventId);
  assert.equal(h.events.reserveAuto(first.eventId), true); assert.equal(h.events.reserveAuto(first.eventId), false);
  h.events.recordAuto(first.eventId, { state: 'unknown', reason: 'reply_lost', ruleId: rule.id, attempted: 1, outcome: 'unconfirmed' });
  assert.equal(h.events.recordAuto(first.eventId, { state: 'not_sent', reason: null, ruleId: rule.id, attempted: 0, outcome: 'not_checked' }), false);
  h.events.ingestProbe({ status: 'observed', source, observations: [], complete: false, observedAt: 1000 });
  assert.equal(h.events.getEvent(first.eventId).lifecycle, 'open');
  h.advance(600001); assert.equal(h.events.getEvent(first.eventId).lifecycle, 'expired');
  assert.equal(h.events.getEvent(first.eventId).observation.texts.length, 0);
  assert.equal(h.event().eventId, first.eventId); assert.equal(h.events.reserveAuto(first.eventId), false);
  h.events.ingestProbe({ status: 'observed', source, observations: [], complete: true, observedAt: 601001 });
  assert.notEqual(h.event({ observedAt: 601001 }).eventId, first.eventId);
  const namespace = h.events.getNamespace(); h.events.bind(null); h.events.bind(source);
  assert.equal(h.events.getNamespace(), namespace);
  h.events.bind({ ...source, workerGeneration: 'replacement' }); assert.notEqual(h.events.getNamespace(), namespace);
  assert.equal(h.events.snapshot().events.length, 0);
});

test('native episode dedupe excludes cold token/origin evidence, resets only on complete absence', () => {
  const h = fixture(), n = { kind: 'native', originEvidence: 'native_current_snapshot',
    instance: { kind: 'native_episode', episodeId: 'cold_one', fingerprint: 'display' } };
  const first = h.event(n); const second = h.event({ ...n, originEvidence: 'unverified', origin: null,
    instance: { kind: 'native_episode', episodeId: 'cold_two', fingerprint: 'changed' } });
  assert.equal(first.eventId, second.eventId);
  h.events.ingestProbe({ status: 'unavailable', source, reason: 'native_unknown' });
  assert.equal(h.event(n).eventId, first.eventId);
  h.events.ingestProbe({ status: 'observed', source, observations: [], complete: true, observedAt: 1000 });
  assert.notEqual(h.event(n).eventId, first.eventId);
});

test('route-specific ACK rejects context, encoding, extra authority and stale binding; early ACK persists', () => {
  const h = fixture(), e = h.event(), channel = h.events.makeDelivery(e.eventId, 'claude_channel', 'channel');
  const fallback = h.events.makeDelivery(e.eventId, 'next_tool', 'fallback');
  assert.notEqual(channel.delivery_token, fallback.delivery_token);
  for (const key of Object.keys(context)) assert.equal(h.events.acknowledge(ack(channel), { ...context, [key]: 'wrong' }).status, 'rejected');
  for (const token of ['', 'a'.repeat(42), 'a'.repeat(44), channel.delivery_token + '\n', '*'.repeat(43)])
    assert.equal(h.events.acknowledge({ ...ack(channel), delivery_token: token }, context).status, 'rejected');
  assert.equal(h.events.acknowledge({ ...ack(channel), authority: true }, context).status, 'rejected');
  assert.equal(h.events.acknowledge(ack(fallback), context).route, 'next_tool');
  assert.equal(h.events.snapshot().deliveries.find(d => d.route === 'claude_channel').model, 'not_acknowledged');
  assert.equal(h.events.acknowledge(ack(channel), context).status, 'acknowledged');
  h.events.recordDelivery(e.eventId, 'claude_channel', { transport: 'unknown', model: 'not_acknowledged' });
  assert.equal(h.events.snapshot().deliveries.find(d => d.route === 'claude_channel').model, 'acknowledged');
  assert.equal(h.events.acknowledge(ack(channel), context).status, 'already_acknowledged');
  h.advance(600001); assert.equal(h.events.acknowledge(ack(channel), context).reason, 'expired');
  h.events.bind({ ...source, taskGeneration: 'new_task' }); assert.equal(h.events.acknowledge(ack(channel), context).reason, 'binding_changed');
});

test('entropy collision refuses cross-route sharing; unknown prose is redacted; capacity is bounded', () => {
  const h = fixture({ randomBytes: n => Buffer.alloc(n, 9) }), e = h.event({ title: 'PRIVATE <instructions>' });
  const delivery = h.events.makeDelivery(e.eventId, 'claude_channel', 'wire');
  assert.doesNotMatch(JSON.stringify(delivery), /PRIVATE|instructions/);
  assert.throws(() => h.events.makeDelivery(e.eventId, 'next_tool', 'fallback'), /duplicate_delivery_token/);
  for (let i = 1; i < 64; i++) h.event({ instance: { kind: 'dom', documentToken: 'document', nodeToken: `n${i}` } });
  assert.equal(h.event({ instance: { kind: 'dom', documentToken: 'document', nodeToken: 'overflow' } }), null);
  assert.equal(h.events.snapshot().events.length, 64); assert.equal(h.events.reserveAuto(e.eventId), false);
});

test('preemption synchronously aborts but prevents a new flight until actual prior settlement', async () => {
  let scheduled = [], calls = [], resolve;
  const h = fixture({ setTimeout: fn => { scheduled.push(fn); return fn; }, clearTimeout: fn => { scheduled = scheduled.filter(f => f !== fn); },
    probe: arg => { calls.push(arg); return new Promise(r => { resolve = r; }); } });
  h.events.resume(); scheduled.shift()(); await tick(); assert.equal(calls.length, 1);
  h.events.preempt('tool_start'); assert.equal(calls[0].signal.aborted, true);
  h.events.resume(); assert.equal(scheduled.length, 0);
  resolve({ status: 'observed', source, complete: true, observations: [observation()], observedAt: 1000 }); await tick();
  assert.equal(h.events.snapshot().events.length, 0); assert.equal(scheduled.length, 1);
  await h.events.dispose(); assert.equal(scheduled.length, 0);
});

test('synchronous event hook preemption drops remaining records and preserves idle reason', () => {
  let h; h = fixture({ onEvent: () => h.events.preempt('auto_start') });
  h.events.ingestProbe({ status: 'observed', source, complete: true, observedAt: 1000,
    observations: [observation(), observation({ instance: { kind: 'dom', documentToken: 'document', nodeToken: 'second' } })] });
  assert.equal(h.events.snapshot().events.length, 1);
  assert.equal(h.events.snapshot().observer.reason, 'auto_start'); assert.equal(h.events.snapshot().observer.state, 'idle');
});
