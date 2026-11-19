/* I18N1: a small Swift lexer for the string-coverage gate (test/ui-strings.test.mjs). It finds every top-level string
 * literal (an interpolation's own literals belong to the literal around them), skipping // and nested block comments,
 * and classifies each one that contains Chinese:
 *   pair      the first argument of a two-language call — L(zh, en), t(zh, en), onboardingText(zh, en) — whose
 *             second argument is a literal with no Chinese (checked: `english` must be non-empty and CJK-free);
 *   ternary   the Chinese branch of the helper's `zh ? <zh> : <en>` copy (the same line carries `zh ?` before it and
 *             a CJK-free literal after a `:`);
 *   exempt    on a line that carries `// i18n-exempt: <reason>` (data that is matched or passed through, never shown
 *             as UI copy, or a language's own name such as 中文);
 *   bare      anything else: a Chinese-only literal, which the gate refuses.
 * A file can limit the gate to regions between `// I18N1 user-facing: begin` and `// I18N1 user-facing: end`
 * (helper.swift: its agent-facing refusal texts are out of scope, contract I18N1 goal 3). */
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;
export const hasCJK = s => CJK.test(s);

export function swiftLiterals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  // Returns the index after the closing quote(s) of the literal opening at `at`.
  function string(at, depth) {
    const multi = src.startsWith('"""', at);
    let j = at + (multi ? 3 : 1);
    const nested = [];
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        if (src[j + 1] === '(') { const r = code(j + 2, depth + 1, true); nested.push(...r.literals); j = r.end; continue; }
        j += 2; continue;
      }
      if (multi ? src.startsWith('"""', j) : c === '"') {
        const end = j + (multi ? 3 : 1);
        return { end, nested };
      }
      if (!multi && c === '\n') return { end: j, nested };   // unterminated: stop at the line end
      j++;
    }
    return { end: n, nested };
  }
  // Code until the matching ')' (inside an interpolation) or the end of the file.
  function code(at, depth, interpolation) {
    let j = at, parens = 0;
    const literals = [];
    while (j < n) {
      const c = src[j];
      if (c === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue; }
      if (c === '/' && src[j + 1] === '*') {
        let level = 1; j += 2;
        while (j < n && level) { if (src.startsWith('/*', j)) { level++; j += 2; } else if (src.startsWith('*/', j)) { level--; j += 2; } else j++; }
        continue;
      }
      if (c === '#' && src[j + 1] === '"') {   // raw string #"…"#
        const close = src.indexOf('"#', j + 2);
        const end = close < 0 ? n : close + 2;
        if (depth === 0) out.push({ start: j + 1, end: end - 1, raw: src.slice(j + 2, end - 2), rawString: true });
        j = end; continue;
      }
      if (c === '"') {
        const r = string(j, depth);
        const multi = src.startsWith('"""', j);
        const lit = { start: j, end: r.end, raw: src.slice(j + (multi ? 3 : 1), r.end - (multi ? 3 : 1)), multi };
        if (depth === 0) out.push(lit); else literals.push(lit);
        j = r.end; continue;
      }
      if (interpolation) {
        if (c === '(') parens++;
        else if (c === ')') { if (parens === 0) return { end: j + 1, literals }; parens--; }
      }
      j++;
    }
    return { end: n, literals };
  }
  code(0, 0, false);
  for (const lit of out) lit.line = src.slice(0, lit.start).split('\n').length;
  return out;
}

const PAIR_CALL = /(?:^|[^A-Za-z0-9_])(?:L|t|onboardingText)\(\s*$/;
export function classify(src, { regions = false } = {}) {
  const lits = swiftLiterals(src);
  const lines = src.split('\n');
  const inRegion = (() => {
    if (!regions) return () => true;
    const open = [];
    let begin = null;
    lines.forEach((l, k) => {
      if (/\/\/ I18N1 user-facing: begin/.test(l)) begin = k + 1;
      else if (/\/\/ I18N1 user-facing: end/.test(l) && begin != null) { open.push([begin, k + 1]); begin = null; }
    });
    return line => open.some(([a, b]) => line > a && line < b);
  })();
  const rows = [];
  lits.forEach((lit, k) => {
    if (!hasCJK(lit.raw) || !inRegion(lit.line)) return;
    const lineText = lines[lit.line - 1];
    const before = src.slice(Math.max(0, lit.start - 60), lit.start);
    const next = lits[k + 1];
    const between = next ? src.slice(lit.end, next.start) : '';
    let kind = 'bare', english = null;
    if (PAIR_CALL.test(before) && next && /^\s*,\s*$/.test(between)) {
      english = next.raw;
      kind = english.trim() && !hasCJK(english) ? 'pair' : 'pair_without_english';
    } else if (/\/\/ i18n-exempt: \S/.test(lineText)) kind = 'exempt';
    else {
      const head = lineText.slice(0, lineText.indexOf(src.slice(lit.start, lit.end)));
      // The English branch: the first literal after a ':' within the next two lines.
      const tail = src.slice(lit.end, lit.end + 400).split('\n').slice(0, 2).join('\n');
      const alt = tail.match(/:\s*[([]?\s*"((?:[^"\\]|\\.)*)"/);
      if (/\bzh\b\)?\s*\?/.test(head) && alt && alt[1].trim() && !hasCJK(alt[1])) { kind = 'ternary'; english = alt[1]; }
    }
    rows.push({ line: lit.line, raw: lit.raw, kind, english });
  });
  return rows;
}
