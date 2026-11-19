#!/usr/bin/env node
/* I18N1 string-coverage gate (problems-20261101, contracts-batch4.md goal 5). Every user-visible string of the native UI has
 * an English and a Chinese version:
 *   - the five panel/GUI sources (bin/cbmenu): every literal with Chinese is the Chinese half of L(zh, en) / t(zh, en) /
 *     onboardingText(zh, en) with a non-empty English half, or one of the reviewed exemptions below;
 *   - src/helper.swift (takeover card and sidebar): inside the regions marked "I18N1 user-facing", every Chinese literal is the
 *     zh branch of a `zh ? <zh> : <en>` copy (its agent-facing refusal texts are out of scope: contract goal 3);
 *   - src/index.js: every notification MyChrome sends the user goes through tellUser({zh, en}) or a two-language builder.
 * The gate proves it fires: each check also runs on a copy with one Chinese-only literal injected and must flag it
 * (rerun.sh adds the same literal to the real file and requires this test to FAIL). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, hasCJK, swiftLiterals } from './ui-strings-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(ROOT, f), 'utf8');
const UI = ['src/menubar.swift', 'src/conversation-ui.swift', 'src/onboarding-ui.swift', 'src/routine-ui.swift', 'src/new-session-ui.swift'];
/** Reviewed: a language named in its own words, the server's label matched to translate it, the setup note whose English
 * comes from setup.js. Anything else needs an English half. */
const EXEMPT = new Set(['中文', ' · 主目录', '在 ~/.codex/config.toml 找到已有的 [mcp_servers.mychrome] 条目，按下方配置更新，不要重复添加同名段落。仅运行注册命令不会设置所需的 900 秒工具超时。']);
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.log(`FAIL - ${name}\n${e?.message || e}`); }
};
/** r1 A2: the panel words a Restart-all outcome from restart.js's own notes. A literal matched against them must occur in
 * src/restart.js; a demo item's note must be one restart.js can write (its ${...} parts filled in). */
const RESTART = read('src/restart.js');
const RESTART_TEMPLATES = [...RESTART.matchAll(/(['`])((?:(?!\1)[^\\\n]|\\.)*[\u4e00-\u9fff](?:(?!\1)[^\\\n]|\\.)*)\1/g)]
  .map(m => new RegExp('^' + m[2].split(/\$\{[^}]*\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$'));
const exemptOk = (r, lineText) => {
  const reason = /\/\/ i18n-exempt: (.*)$/.exec(lineText)?.[1] ?? '';
  if (reason.startsWith('restart.js note matched')) return RESTART.includes(r.raw);
  if (reason.startsWith('restart.js output sample')) return RESTART_TEMPLATES.some(t => t.test(r.raw));
  return EXEMPT.has(r.raw);
};
const problems = (src, { regions = false } = {}) => { const lines = src.split('\n'); return classify(src, { regions })
  .filter(r => r.kind === 'bare' || r.kind === 'pair_without_english' || (r.kind === 'exempt' && !exemptOk(r, lines[r.line - 1])))
  .map(r => `line ${r.line}: ${r.kind} ${JSON.stringify(r.raw).slice(0, 90)}`); };
const INJECT = '\nlet I18N1_PROBE = Text("新加的中文")\n';

const counts = {};
for (const file of UI) {
  check(`gate ${file}: every Chinese literal has an English counterpart`, () => {
    const src = read(file);
    const rows = classify(src);
    counts[file] = rows.length;
    assert.ok(rows.filter(r => r.kind === 'pair').length >= 40, `${file}: only ${rows.filter(r => r.kind === 'pair').length} pairs (the scan lost the file)`);
    assert.deepEqual(problems(src), [], `${file}: Chinese-only or untranslated literals`);
    assert.ok(problems(src + INJECT).some(p => p.includes('新加的中文')), `${file}: the gate did not flag an injected Chinese-only literal`);
    for (const reason of ['restart.js note matched', 'restart.js output sample']) {
      assert.ok(problems(src + `\nlet I18N1_PROBE = "重启程序没写过的话"   // i18n-exempt: ${reason}\n`).some(p => p.includes('重启程序没写过的话')),
        `${file}: a "${reason}" exemption that restart.js never writes was not flagged`);
    }
    assert.ok(problems(src.replace(/\b(L|t)\("([^"\\]*[\u4e00-\u9fff][^"\\]*)", "[^"\\]*"\)/, '$1("$2", "")')).length > 0,
      `${file}: the gate did not flag an empty English half`);
  });
}

check('gate src/helper.swift: the takeover card and sidebar copy is two-language (regions marked "I18N1 user-facing")', () => {
  const src = read('src/helper.swift');
  const regions = (src.match(/\/\/ I18N1 user-facing: begin/g) || []).length;
  assert.ok(regions >= 2 && regions === (src.match(/\/\/ I18N1 user-facing: end/g) || []).length, `${regions} marked regions`);
  const rows = classify(src, { regions: true });
  counts['src/helper.swift'] = rows.length;
  assert.ok(rows.filter(r => r.kind === 'ternary').length >= 25, `only ${rows.length} two-language literals in the marked regions`);
  assert.deepEqual(problems(src, { regions: true }), []);
  const probe = src.replace('// I18N1 user-facing: end', '    let probe = "新加的中文"\n// I18N1 user-facing: end');
  assert.ok(problems(probe, { regions: true }).some(p => p.includes('新加的中文')), 'the gate did not flag an injected Chinese-only literal');
});

/** Notification calls in src/index.js that do not carry both languages. */
function notificationProblems(src) {
  const calls = [...src.matchAll(/(?<![\w.])(tellUser|notifySend)\(/g)].filter(m => !/function\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index)));
  const bad = [];
  for (const m of calls) {
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const line = src.slice(0, m.index).split('\n').length;
    const object = after.split('});')[0];
    if (m[1] === 'tellUser') {
      if (!/^\{\s*(?:en|zh):/.test(after) || !/\ben:/.test(object) || !/\bzh:/.test(object)) bad.push(`index.js:${line} tellUser without {zh, en}`);
    } else if (!/^(?:uiText\(|refusalNoticeText\(|text[,)])/.test(after)) bad.push(`index.js:${line} notifySend with ${after.slice(0, 40)}`);
  }
  return { count: calls.length, bad };
}

check('gate src/index.js: every notification to the user is two-language', () => {
  const src = read('src/index.js');
  const { count, bad } = notificationProblems(src);
  assert.ok(count >= 7, `${count} notification calls found`);
  assert.deepEqual(bad, []);
  // fires: a raw Chinese notification, and a {zh} without English, are flagged
  for (const probe of ['tellUser(`新加的通知`);', "tellUser({ zh: '新加的通知' });", 'notifySend(`新加的通知`);']) {
    const injected = src.replace('function noticeRefusal(facts) {', `function noticeRefusal(facts) {\n  ${probe}`);
    assert.ok(notificationProblems(injected).bad.length === 1, `the gate did not flag ${probe}`);
  }
});

check('gate: the English halves are English (no Chinese), and the scan sees every literal', () => {
  for (const file of UI) {
    for (const r of classify(read(file)).filter(r => r.kind === 'pair')) {
      assert.equal(hasCJK(r.english), false, `${file}:${r.line} ${r.english}`);
      // CC-LIVE's label rule holds in English too: no "unsupported" wording
      assert.doesNotMatch(r.english, /unsupported|not supported/i, `${file}:${r.line} ${r.english}`);
    }
  }
  // the scanner itself: interpolations with nested literals, escapes, comments
  const lits = swiftLiterals('let a = "x \\(b ? "中" : "y") z" // "注释"\n/* "块" */ let c = "\\"引\\""');
  assert.deepEqual(lits.map(l => l.raw), ['x \\(b ? "中" : "y") z', '\\"引\\"']);
});

console.log(`literal sites with Chinese per file: ${JSON.stringify(counts)}`);
console.log(failed ? `\nui-strings: ${failed} check(s) failed` : '\nui-strings: all checks passed');
process.exit(failed ? 1 : 0);
