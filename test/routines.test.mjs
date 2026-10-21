#!/usr/bin/env node
// Local-only persistence tests: no Chrome, native helpers, user state or UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRoutineStore, ROUTINE_LIMITS } from '../src/routines.js';

const run = promisify(execFile);
const tmp = await mkdtemp(path.join(os.tmpdir(), 'mychrome-routines-test-'));
let n = 0;
const fixture = (sessionId = 'session-a') => {
  const dir = path.join(tmp, `case-${++n}`);
  return { dir, store: createRoutineStore({ dir, sessionId }) };
};
const at = (path = '/form', origin = 'https://example.test') => ({ origin, path });
const target = (name = 'Continue', tag = 'button') => ({ version: 1, tag, role: tag === 'button' ? 'button' : 'textbox', name });
const action = (extra = {}) => ({ tool: 'click', tab: 17, before: at(), after: at(), target: target(), ok: true, ...extra });

test('empty store is enabled and lives only in its supplied directory', async () => {
  const { store } = fixture();
  assert.deepEqual(await store.snapshot(), { enabled: true, sites: [], events: [], routines: [], candidates: [] });
});

test('sanitized records, exact origins, static descriptors and parameterized saves', async () => {
  const { store, dir } = fixture();
  const secret = 'NEVER_STORE_TYPED_VALUE_492857';
  const first = await store.record(action({ tool: 'type_text', task: secret,
    target: { ...target('Search', 'input'), type: 'search', value: secret, text: secret, raw: secret },
    before: { ...at('/form?token=' + secret + '#/edit?secret=' + secret), fingerprint: 'a'.repeat(64) },
    after: at('/form#/edit'), args: { text: secret, submit: true, input_mode: 'keys', token: secret }, metadata: secret }));
  const second = await store.record(action({ tool: 'select_option', task: secret, target: { ...target('Region', 'select'), role: 'combobox' },
    before: at('/form#/edit'), after: at('/form#/edit'), args: { value: secret, label: secret } }));
  const third = await store.record(action({ task: secret, before: at('/form#/edit'), after: at('/result'),
    target: { ...target('Apply'), testId: 'apply', href: 'https://example.test/result?token=' + secret },
    targetState: { disabled: false, checked: false, focused: false, text: secret }, afterState: { checked: true, focused: true } }));
  const routine = await store.save({ name: 'Search and apply', description: 'Find a region', eventIds: [first.id, second.id, third.id] });
  assert.deepEqual(routine.parameters, [{ name: 'input_1', label: 'Search' }, { name: 'option_1', label: 'Region' }]);
  assert.equal(routine.steps[0].args.textParam, 'input_1');
  assert.equal(routine.steps[1].args.valueParam, 'option_1');
  assert.equal(routine.steps[2].target.href, 'https://example.test/result');
  assert.deepEqual(routine.steps[2].targetState, { disabled: false, checked: false, focused: false });
  assert.deepEqual(routine.steps[2].afterState, { checked: true, focused: true });
  assert.equal(routine.steps[0].before.fingerprint, 'a'.repeat(64));
  assert.equal(routine.site, 'https://example.test');
  assert.equal(first.before.path, '/form#/edit');
  assert.equal((await store.get(routine.id)).id, routine.id);
  assert.equal(await store.get(randomUUID()), null);
  await store.record(action({ before: at('/', 'http://example.test'), after: at('/', 'http://example.test') }));
  await store.record(action({ before: at('/', 'https://example.test:8443'), after: at('/', 'https://example.test:8443') }));
  assert.equal((await store.snapshot()).sites.length, 3);
  const contents = await readFile(path.join(dir, 'state.json'), 'utf8');
  assert.ok(!contents.includes(secret));
  assert.ok(!contents.includes('"value":'));
  assert.ok(!contents.includes('"text":'));
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, 'state.json'))).mode & 0o777, 0o600);
});

test('unsupported, failed, sensitive and missing descriptors are recorded barriers', async () => {
  for (const gap of [
    action({ tool: 'answer_dialog' }), action({ ok: false, code: 'target_changed' }),
    action({ target: { ...target('Password', 'input'), type: 'password' }, replayable: true }),
    action({ target: undefined }), action({ replayable: false, reason: 'caller_refused' }),
    action({ before: at('/[REDACTED]') }), action({ args: {}, tool: 'press_key' }),
    action({ before: at('/', 'https://example.test'), after: at('/', 'https://other.test') })
  ]) {
    const { store } = fixture();
    const a = await store.record(action());
    const b = await store.record(gap);
    const c = await store.record(action());
    assert.equal(b.replayable, false);
    assert.equal((await store.snapshot()).events.length, 3);
    await assert.rejects(store.save({ name: 'Gap', eventIds: [a.id, c.id] }), { code: 'routine_gap' });
    await assert.rejects(store.save({ name: 'Barrier', eventIds: [a.id, b.id, c.id] }), { code: 'routine_barrier' });
    assert.ok((await store.snapshot()).candidates.every(x => x.eventIds.length === 1));
  }
});

test('save rejects every invalid selection rather than silently dropping events', async () => {
  const { store, dir } = fixture();
  const a = await store.record(action());
  const b = await store.record(action({ target: target('Next') }));
  const other = createRoutineStore({ dir, sessionId: 'session-b' });
  const c = await other.record(action());
  const d = await store.record(action({ tab: 18 }));
  const e = await store.record(action({ task: 'new-task' }));
  for (const ids of [[], [a.id, a.id], [b.id, a.id], [a.id, 'missing'], [a.id, c.id], [a.id, d.id], [b.id, e.id]]) {
    await assert.rejects(store.save({ name: 'Bad selection', eventIds: ids }));
  }
  const tooMany = [];
  for (let i = 0; i < 51; i++) tooMany.push((await store.record(action({ task: 'long' }))).id);
  await assert.rejects(store.save({ name: 'Too long', eventIds: tooMany }), { code: 'routine_selection' });
});

test('repeated mechanical sequences deduplicate with exact occurrence event IDs', async () => {
  const { store } = fixture();
  const occurrences = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const ids = [];
    ids.push((await store.record(action({ target: target('Open') }))).id);
    ids.push((await store.record(action({ tool: 'type_text', target: target('Search', 'input'), args: { text: `private-${repeat}` } }))).id);
    ids.push((await store.record(action({ target: target('Apply filter') }))).id);
    occurrences.push(ids);
  }
  const candidates = (await store.snapshot({ site: 'https://example.test', query: 'apply FILTER' })).candidates;
  const candidate = candidates.find(x => x.count === 3 && x.steps.length === 3);
  assert.ok(candidate);
  assert.deepEqual(candidate.eventIds, occurrences[2]);
  assert.deepEqual(candidate.occurrences.map(x => x.eventIds), occurrences);
  assert.match(candidate.name, /Apply filter/);
  const saved = await store.save({ name: candidate.name, eventIds: candidate.eventIds });
  assert.equal(saved.steps.length, 3);
  assert.equal((await store.snapshot({ query: 'apply FILTER' })).routines[0].id, saved.id);
  assert.equal((await store.snapshot({ site: 'https://wrong.test' })).events.length, 0);
});

test('recording toggle cuts continuity, and run metadata never stores parameters', async () => {
  const { store, dir } = fixture();
  const a = await store.record(action());
  assert.equal(await store.setEnabled(false), false);
  assert.equal(await store.record(action()), null);
  assert.equal((await store.snapshot()).enabled, false);
  await store.setEnabled(true);
  const b = await store.record(action());
  await assert.rejects(store.save({ name: 'Disabled gap', eventIds: [a.id, b.id] }), { code: 'routine_gap' });
  const routine = await store.save({ name: 'One action', eventIds: [b.id] });
  await store.recordRun({ id: routine.id, status: 'running', completed: 0, total: 1, parameters: { input_1: 'RUN_SECRET' } });
  await store.recordRun({ id: routine.id, status: 'completed', completed: 1, total: 1, output: 'RUN_SECRET' });
  let updated = await store.get(routine.id);
  assert.equal(updated.runCount, 1);
  assert.equal(updated.lastRun.status, 'completed');
  updated = await store.update(routine.id, { name: 'Renamed', archived: true });
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.archived, true);
  assert.ok(!(await readFile(path.join(dir, 'state.json'), 'utf8')).includes('RUN_SECRET'));
});

test('cross-process writers preserve every event and per-session sequence', async () => {
  const { store, dir } = fixture();
  const module = new URL('../src/routines.js', import.meta.url).href;
  const code = `import {createRoutineStore} from ${JSON.stringify(module)};const s=createRoutineStore({dir:process.argv[1],sessionId:process.argv[2]});for(let i=0;i<25;i++)await s.record(${JSON.stringify(action())});`;
  await Promise.all(Array.from({ length: 4 }, (_, i) => run(process.execPath, ['--input-type=module', '-e', code, dir, `writer-${i}`], { timeout: 30000 })));
  const events = (await store.snapshot({ limit: 200 })).events;
  assert.equal(events.length, 100);
  assert.equal(new Set(events.map(x => x.id)).size, 100);
  for (let i = 0; i < 4; i++) assert.deepEqual(events.filter(x => x.sessionId === `writer-${i}`).map(x => x.seq).reverse(), Array.from({ length: 25 }, (_, i) => i + 1));
});

test('corrupt or unsafe state fails closed without replacing any bytes', async () => {
  for (const contents of ['{broken', JSON.stringify({ version: 999 }), JSON.stringify({ version: 1, enabled: true, events: [], routines: [], runs: [], epoch: 0, unexpected: 'SECRET' })]) {
    const { store, dir } = fixture();
    await store.record(action());
    const file = path.join(dir, 'state.json');
    await writeFile(file, contents, { mode: 0o600 });
    await assert.rejects(store.snapshot(), { code: 'routines_corrupt' });
    await assert.rejects(store.record(action()), { code: 'routines_corrupt' });
    assert.equal(await readFile(file, 'utf8'), contents);
  }
  const { store, dir } = fixture();
  await store.setEnabled(true);
  const outside = path.join(tmp, 'outside.json');
  await writeFile(outside, 'untouched', { mode: 0o600 });
  await symlink(outside, path.join(dir, 'state.json.new-link'));
  // A separately created store with a symlink at its data path must not follow it.
  const linkedDir = path.join(tmp, `case-${++n}`);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(linkedDir, { mode: 0o700 });
  await symlink(outside, path.join(linkedDir, 'state.json'));
  await assert.rejects(createRoutineStore({ dir: linkedDir }).record(action()), { code: 'routines_unsafe' });
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
});

test('journal stays bounded without losing saved routines or allowing stale selections', async () => {
  const { store, dir } = fixture();
  const first = await store.record(action());
  const routine = await store.save({ name: 'Keep this', eventIds: [first.id] });
  const file = path.join(dir, 'state.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  for (let i = 1; i < ROUTINE_LIMITS.events; i++) data.events.push({ ...first, id: randomUUID(), seq: i + 1, at: first.at + i });
  await writeFile(file, JSON.stringify(data), { mode: 0o600 });
  await store.record(action());
  assert.equal((await store.snapshot({ limit: ROUTINE_LIMITS.events })).events.length, ROUTINE_LIMITS.events);
  assert.equal((await store.get(routine.id)).name, 'Keep this');
  await assert.rejects(store.save({ name: 'Expired', eventIds: [first.id] }), { code: 'routine_missing_event' });
});

test('safe key and scroll arguments survive; unknown and plaintext arguments do not', async () => {
  const { store } = fixture();
  const key = await store.record(action({ tool: 'press_key', args: { key: 'enter', times: 2, text: 'SECRET' } }));
  const scroll = await store.record(action({ tool: 'scroll', target: undefined, args: { direction: 'down', amount: 3, text: 'SECRET' } }));
  const routine = await store.save({ name: 'Move', eventIds: [key.id, scroll.id] });
  assert.deepEqual(routine.steps.map(x => x.args), [{ key: 'enter', times: 2 }, { direction: 'down', amount: 3 }]);
});

test('begin survives a restart as a barrier; only its owner can finish it exactly once', async () => {
  const { store, dir } = fixture();
  const first = await store.record(action());
  const pending = await store.begin(action({ tool: 'type_text', target: target('Search', 'input'), args: { text: 'PENDING_SECRET' } }));
  assert.equal(pending.reason, 'in_progress');
  assert.equal(pending.replayable, false);
  const reader = createRoutineStore({ dir, sessionId: 'reader' });
  assert.equal((await reader.snapshot()).events[0].reason, 'in_progress');
  await assert.rejects(reader.finish(pending.id, { ok: true, after: at() }), { code: 'routine_owner' });
  const last = await store.record(action());
  await assert.rejects(store.save({ name: 'Interrupted', eventIds: [first.id, pending.id, last.id] }), { code: 'routine_barrier' });
  const done = await store.finish(pending.id, { ok: true, after: at(), args: { text: 'FINISH_SECRET' }, result: 'RAW_SECRET' });
  assert.equal(done.id, pending.id);
  assert.equal(done.seq, pending.seq);
  assert.equal(done.at, pending.at);
  assert.equal(done.replayable, true);
  await assert.rejects(store.finish(pending.id, { ok: false }), { code: 'routine_finished' });
  assert.equal((await store.save({ name: 'Finished', eventIds: [first.id, pending.id, last.id] })).steps.length, 3);
  assert.ok(!/PENDING_SECRET|FINISH_SECRET|RAW_SECRET/.test(await readFile(path.join(dir, 'state.json'), 'utf8')));
});

test('disabling recording fences pending events even after recording is re-enabled', async () => {
  const { store } = fixture();
  const pending = await store.begin(action());
  await store.setEnabled(false);
  assert.equal(await store.begin(action()), null);
  await store.setEnabled(true);
  const done = await store.finish(pending.id, { ok: true, replayable: true });
  assert.equal(done.reason, 'recording_disabled');
  assert.equal(done.replayable, false);
  await assert.rejects(store.save({ name: 'Disabled', eventIds: [done.id] }), { code: 'routine_barrier' });
});

test('hover is mechanical only with a safe target; key repetition uses the actual times argument', async () => {
  const { store } = fixture();
  const hover = await store.record(action({ tool: 'hover' }));
  assert.equal(hover.replayable, true);
  const key = await store.record(action({ tool: 'press_key', args: { key: 'tab', times: 20 } }));
  assert.deepEqual(key.args, { key: 'tab', times: 20 });
  assert.equal((await store.record(action({ tool: 'press_key', args: { key: 'tab', times: 21 } }))).replayable, false);
  assert.equal((await store.record(action({ tool: 'hover', target: undefined }))).replayable, false);
  assert.equal((await store.record(action({ tool: 'press_key', target: undefined, args: { key: 'tab' } }))).replayable, false);
  assert.equal((await store.record(action({ tool: 'scroll', args: { direction: 'up', amount: 0.01 } }))).replayable, false);
});

test('pending sensitivity and explicit replay refusal cannot be erased by finish', async () => {
  for (const changed of [
    { sensitive: true }, { replayable: false }, { sensitive: true, after: undefined },
    { target: { ...target('Password', 'input'), type: 'password' } }
  ]) {
    const { store, dir } = fixture();
    const pending = await store.begin(action(changed));
    const done = await store.finish(pending.id, { ok: true, replayable: true, sensitive: false, after: at(), target: target('Safe') });
    assert.equal(done.replayable, false);
    await assert.rejects(store.save({ name: 'Refused', eventIds: [done.id] }), { code: 'routine_barrier' });
    assert.ok(!(await readFile(path.join(dir, 'state.json'), 'utf8')).includes('Password'));
  }
});

test('secret-bearing paths and descriptors never persist, including redacted helper paths', async () => {
  const { store, dir } = fixture();
  for (const input of [
    action({ before: at('/reset/credential-value') }),
    action({ before: at('/accounts/private.person@example.test') }),
    action({ before: at('/orders/123456789') }),
    action({ before: at('/access_token/opaque-secret') }),
    action({ before: at('/:redacted') }),
    action({ target: target('private.person@example.test') }),
    action({ target: { ...target('Apply'), id: 'private.person@example.test' } })
  ]) assert.equal((await store.record(input)).replayable, false);
  const contents = await readFile(path.join(dir, 'state.json'), 'utf8');
  assert.ok(!/credential-value|private\.person|123456789|opaque-secret/.test(contents));
  const safe = await store.record(action({ before: at('/app#!/settings?view=compact'), after: at('/app#!/settings') }));
  assert.equal(safe.before.path, '/app#!/settings');
});

test('query hashes are exact identities, raw queries are absent, and malformed hashes are barriers', async () => {
  const { store } = fixture();
  const a = await store.record(action({ before: { ...at(), queryHash: 'a'.repeat(64) }, after: { ...at(), queryHash: 'b'.repeat(64) },
    target: { ...target(), href: 'https://example.test/form?page=2', hrefQueryHash: 'c'.repeat(64) } }));
  assert.equal(a.before.queryHash, 'a'.repeat(64));
  assert.equal(a.target.hrefQueryHash, 'c'.repeat(64));
  assert.equal(a.target.href, 'https://example.test/form');
  const b = await store.record(action({ before: { ...at(), queryHash: 'd'.repeat(64) } }));
  await assert.rejects(store.save({ name: 'Different query', eventIds: [a.id, b.id] }), { code: 'routine_gap' });
  for (const queryHash of ['not-a-hash', 'A'.repeat(64), ['b'.repeat(64)]]) {
    assert.equal((await store.record(action({ before: { ...at(), queryHash } }))).replayable, false);
  }
});

test('concurrent finish permits one terminal update and preserves the event identity', async () => {
  const { store, dir } = fixture();
  const pending = await store.begin(action());
  const other = createRoutineStore({ dir, sessionId: 'session-a' });
  const results = await Promise.allSettled([store.finish(pending.id, { ok: true }), other.finish(pending.id, { ok: false })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'routine_finished');
  assert.equal((await store.snapshot()).events.length, 1);
});

test('default directory follows isolated settings and an explicit routines override', async () => {
  const saved = { settings: process.env.CHROME_BRIDGE_SETTINGS, routines: process.env.CHROME_BRIDGE_ROUTINES_DIR };
  try {
    process.env.CHROME_BRIDGE_SETTINGS = path.join(tmp, 'isolated-support', 'settings.json');
    delete process.env.CHROME_BRIDGE_ROUTINES_DIR;
    await createRoutineStore({ sessionId: 'default-test' }).record(action());
    assert.ok((await stat(path.join(tmp, 'isolated-support', 'routines', 'state.json'))).isFile());
    process.env.CHROME_BRIDGE_ROUTINES_DIR = path.join(tmp, 'explicit-routines');
    await createRoutineStore({ sessionId: 'default-test' }).record(action());
    assert.ok((await stat(path.join(tmp, 'explicit-routines', 'state.json'))).isFile());
  } finally {
    for (const [key, value] of [['CHROME_BRIDGE_SETTINGS', saved.settings], ['CHROME_BRIDGE_ROUTINES_DIR', saved.routines]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('site and query filtering happens before the candidate result cap', async () => {
  const { store } = fixture();
  const oldest = await store.record(action({ target: target('Find the oldest') }));
  for (let i = 0; i <= ROUTINE_LIMITS.candidates; i++) {
    const page = at('/', `https://other-${i}.test`);
    await store.record(action({ before: page, after: page }));
  }
  const site = await store.snapshot({ site: 'https://example.test' });
  assert.equal(site.candidates.length, 1);
  assert.deepEqual(site.candidates[0].eventIds, [oldest.id]);
  assert.equal((await store.snapshot({ query: 'find the oldest' })).candidates.length, 1);
});

test('candidate occurrence metadata is bounded while the full repetition count is retained', async () => {
  const { store } = fixture();
  let last;
  for (let i = 0; i < ROUTINE_LIMITS.occurrences + 3; i++) last = await store.record(action());
  const candidate = (await store.snapshot()).candidates[0];
  assert.equal(candidate.count, ROUTINE_LIMITS.occurrences + 3);
  assert.equal(candidate.occurrences.length, ROUTINE_LIMITS.occurrences);
  assert.deepEqual(candidate.eventIds, [last.id]);
});
