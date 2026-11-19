import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import * as P from '../src/page-events.js';
import * as S from '../src/settings.js';
import { srcFingerprint } from '../src/launcher.js';
import { rule, settings } from './page-event-fixtures.mjs';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const menu = process.env.CBMENU_BIN || path.join(root, 'bin/cbmenu');
const dir = mkdtempSync(path.join(os.tmpdir(), 'mychrome-page-settings-'));
const file = path.join(dir, 'settings.json');
const env = { ...process.env, CHROME_BRIDGE_SETTINGS: file, CHROME_BRIDGE_ROOT: root };
const vectors = JSON.parse(readFileSync(new URL('./page-event-settings-vectors.json', import.meta.url)));
const swift = request => JSON.parse(execFileSync(menu, ['--validate-page-prompt', JSON.stringify(request)], { encoding: 'utf8', env, timeout: 10000 }));
const read = () => JSON.parse(readFileSync(file, 'utf8'));
function child(command, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', error = '';
    p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { error += b; });
    p.once('error', reject); p.once('close', code => code === 0 ? resolve(out) : reject(Error(`${command} exit ${code}: ${error} ${out}`)));
  });
}
const mutate = op => child(menu, ['--page-prompt-mutation', JSON.stringify(op)]);
const nodeMutate = op => child(process.execPath, ['--input-type=module', '-e',
  `import * as S from ${JSON.stringify(new URL('../src/settings.js', import.meta.url).href)}; const op=JSON.parse(process.argv[1]); op.op==='policy'?S.writePagePromptPolicy(op.policy):S.updatePagePromptRule(op);`, JSON.stringify(op)]);

test('actual candidate Swift CLI and Node agree on all 42 shared vectors', () => {
  let count = 0;
  for (const v of vectors.text) { assert.equal(swift({ text: v.input }).text, P.normalizePromptText(v.input)); count++; }
  for (const v of vectors.origin) { assert.equal(swift({ origin: v.input }).origin, P.canonicalPromptOrigin(v.input)); count++; }
  for (const v of vectors.settings) {
    assert.deepEqual(swift(Object.hasOwn(v, 'raw') ? { settings: v.raw } : {}), P.normalizePagePromptSettings(v.raw), v.name); count++;
  }
  for (const v of vectors.catalog) {
    const catalog = structuredClone(P.PAGE_PROMPT_CATALOG); Object.assign(catalog.templates[0], v.mutate); Object.assign(catalog, v.wrapperExtra);
    assert.deepEqual(swift({ catalog }), P.normalizePagePromptSettings(undefined, catalog), v.name); count++;
  }
  const catalog = structuredClone(P.PAGE_PROMPT_CATALOG); Object.assign(catalog.templates[0], vectors.compositionRule.catalogMutation);
  const raw = { ...settings, rules: [{ ...rule, ...vectors.compositionRule.ruleMutation }] };
  assert.deepEqual(swift({ catalog, settings: raw }), P.normalizePagePromptSettings(raw, catalog)); count++;
  assert.equal(count, 42);
  for (const catalog of [null, {}, { version: 2, templates: [] }]) assert.equal(swift({ catalog }).reason, 'catalog_unavailable');
});

test('Node and both GUI writer path share one lock and preserve unrelated concurrent mutations', async () => {
  writeFileSync(file, JSON.stringify({ future: { keep: ['yes', null] }, notify: false }));
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? mutate : nodeMutate)({ op: 'add', rule: { ...rule, id: `rule${i}`, enabled: false } })));
  assert.equal(read().pagePrompt.rules.length, 8); assert.deepEqual(read().future, { keep: ['yes', null] }); assert.equal(read().notify, false);
  await Promise.all([mutate({ op: 'toggle', id: 'rule0', enabled: true }), nodeMutate({ op: 'delete', id: 'rule1' }),
    mutate({ op: 'add', rule: { ...rule, id: 'new_rule', enabled: false } }), nodeMutate({ op: 'policy', policy: 'auto_safe' }),
    child(menu, ['--write-setting', 'inputSpeed', '1.5'])]);
  const final = read(); assert.equal(final.pagePrompt.rules.length, 8); assert.equal(final.pagePrompt.policy, 'auto_safe');
  assert.equal(final.pagePrompt.rules.find(r => r.id === 'rule0').enabled, true);
  assert.equal(final.pagePrompt.rules.some(r => r.id === 'rule1'), false); assert.equal(final.inputSpeed, 1.5);
  assert.deepEqual(final.future, { keep: ['yes', null] });
  assert.throws(() => S.writeSettings({ pagePrompt: settings }, env), /requires_locked_mutation/);
  assert.throws(() => S.updatePagePromptRule({ op: 'add', rule: { ...rule, id: 'rule0' } }, env), /rule_exists/);
});

test('malformed nested values survive unrelated old writers; reads never repair; invalid top level refuses overwrite', () => {
  for (const raw of [null, { version: 1, policy: 'ANY', rules: [] }, { unknown: 'kept' }]) {
    const text = JSON.stringify({ pagePrompt: raw, future: { text: '\uFEFFkept', flag: true }, notify: true }); writeFileSync(file, text);
    assert.equal(S.readPagePromptSettings(env).valid, false); execFileSync(menu, ['--read-settings'], { env }); assert.equal(readFileSync(file, 'utf8'), text);
    S.writeSettings({ inputSpeed: 1.5 }, env); execFileSync(menu, ['--write-setting', 'notify', 'false'], { env });
    assert.deepEqual(read().pagePrompt, raw); assert.deepEqual(read().future, { text: '\uFEFFkept', flag: true });
    assert.throws(() => S.writePagePromptPolicy('off', env), /invalid_page_prompt_settings/);
  }
  for (const raw of ['{bad', '[]', 'null']) {
    writeFileSync(file, raw); assert.throws(() => S.writeSettings({ notify: false }, env), /settings_invalid/);
    assert.throws(() => execFileSync(menu, ['--write-setting', 'notify', 'false'], { env, stdio: 'pipe' })); assert.equal(readFileSync(file, 'utf8'), raw);
  }
  writeFileSync(file, '{"future":{"large":9007199254740993,"maxUInt":18446744073709551615,"text":"\uFEFFkept","array":[false,null,1.5]},"notify":true}');
  execFileSync(menu, ['--write-setting', 'notify', 'false'], { env }); const raw = readFileSync(file, 'utf8');
  assert.match(raw, /9007199254740993/); assert.match(raw, /18446744073709551615/); assert.equal(read().future.text, '\uFEFFkept');
});

test('actual Node/launcher/Swift fingerprints agree and detect both catalog and page-script bytes', () => {
  const tmp = path.join(dir, 'fingerprint'); mkdirSync(path.join(tmp, 'src/page'), { recursive: true });
  writeFileSync(path.join(tmp, 'src/a.js'), 'first'); writeFileSync(path.join(tmp, 'src/Z.js'), 'last');
  writeFileSync(path.join(tmp, 'src/page-prompt-templates.json'), '{}'); writeFileSync(path.join(tmp, 'src/page/prompt-observation.js'), 'script');
  const source = readFileSync(path.join(root, 'src/menubar.swift'), 'utf8');
  const start = source.indexOf('func sourceFingerprint('), end = source.indexOf('\n}\n', start) + 2;
  const program = path.join(dir, 'fingerprint.swift'), binary = path.join(dir, 'fingerprint-probe');
  writeFileSync(program, `import Foundation\nimport CryptoKit\n${source.slice(start, end)}\nprint(sourceFingerprint(CommandLine.arguments[1]) ?? "unavailable")\n`);
  execFileSync('/usr/bin/swiftc', [program, '-o', binary], { timeout: 60000, stdio: 'pipe' });
  const hashes = () => [S.sourceFingerprint(tmp), srcFingerprint(path.join(tmp, 'src')), execFileSync(binary, [tmp], { encoding: 'utf8' }).trim()];
  let prior = hashes(); assert.equal(new Set(prior).size, 1);
  for (const name of ['page-prompt-templates.json', 'page/prompt-observation.js']) {
    writeFileSync(path.join(tmp, 'src', name), 'changed bytes'); const next = hashes(); assert.equal(new Set(next).size, 1); assert.notEqual(next[0], prior[0]); prior = next;
  }
});

test('actual producer status passes the exact Swift GUI parser with only bounded public fields', async () => {
  const { fixture, source: binding } = await import('./page-event-fixtures.mjs');
  const { createPageEventDelivery } = await import('../src/page-event-host.js');
  const h = fixture(), delivery = createPageEventDelivery({ source: binding, events: h.events });
  const index = readFileSync(path.join(root, 'src/index.js'), 'utf8');
  const start = index.indexOf('function publishPageEventStatus('), end = index.indexOf('\n}', start) + 2;
  let fields;
  const publish = new Function('PAGE_EVENTS', 'PAGE_DELIVERY', 'S', `const RECORD=true,LOCK_DIR='inert',PAGE_EVENT_SUSPENDED=false,PAGE_REASONS=new Set(['unbound_source']);${index.slice(start, end)};return publishPageEventStatus;`)(
    h.events, delivery, { writePresence(_lock, value) { fields = value; } });
  publish();
  const menuSource = readFileSync(path.join(root, 'src/menubar.swift'), 'utf8');
  const statusStart = menuSource.indexOf('struct PagePromptDeliveryStatus:'), statusEnd = menuSource.indexOf('\n}', statusStart) + 2;
  const program = path.join(dir, 'presence.swift'), binary = path.join(dir, 'presence-probe');
  writeFileSync(program, `import Foundation\nfunc L(_ zh: String, _ en: String) -> String { zh }   // I18N1: the production two-language pair (src/onboarding-ui.swift), Chinese here\n${menuSource.split('\n').find(s => s.startsWith('func promptExactKeys('))}\nfunc jsonNum(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }\n${menuSource.slice(statusStart, statusEnd)}\nlet raw=try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8))\nif let value=PagePromptDeliveryStatus.parse(raw) { print(value.observer) } else { print("invalid") }\n`);
  execFileSync('/usr/bin/swiftc', [program, '-o', binary], { timeout: 60000, stdio: 'pipe' });
  assert.equal(execFileSync(binary, [JSON.stringify(fields.pagePrompt)], { encoding: 'utf8' }).trim(), 'idle');
  assert.deepEqual(Object.keys(fields.pagePrompt).sort(), ['observer', 'route', 'transport', 'model', 'reason', 'openCount', 'updatedAt'].sort());
  assert.doesNotMatch(JSON.stringify(fields), /delivery_token|template|documentToken|Your session/);
  assert.equal(execFileSync(binary, [JSON.stringify({ ...fields.pagePrompt, text: 'extra-authority' })], { encoding: 'utf8' }).trim(), 'invalid');
});
