/** Bounded, process-local read feedback. Only delivered records become the baseline.
 * Pending DOM text is continued on the next read; it never causes an OCR fallback.
 * Nothing is persisted to disk or shared with another MCP process.
 */
import { createHash } from 'node:crypto';

export function textTokens(text) {
  const s = String(text ?? '');
  const cjk = (s.match(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 3.5);
}
// Rows break where words do: never inside a word of a script written with spaces (Chinese, Japanese
// and Thai may break between any two characters). Only an unbroken token longer than a whole row (a URL)
// is split inside, and that row ends with ….
const CJK_COST = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const WORD_CHAR = /[\p{L}\p{N}\p{M}'’_]/u;
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const wordChar = c => !!c && WORD_CHAR.test(c) && !UNSPACED.test(c);
function chunks(text, limit = 90) {
  const chars = [...String(text ?? '')], result = [];
  let start = 0;
  while (start < chars.length) {
    let end = start, cost = 0;
    while (end < chars.length) {
      const n = CJK_COST.test(chars[end]) ? 1 : chars[end].length / 3.5;
      if (end > start && cost + n > limit) break;
      cost += n; end++;
    }
    if (end < chars.length && wordChar(chars[end - 1]) && wordChar(chars[end])) {
      let word = end;
      while (word > start && wordChar(chars[word - 1])) word--;
      if (word === start) { result.push(chars.slice(start, end).join('') + '…'); start = end; continue; }
      end = word;
    }
    result.push(chars.slice(start, end).join(''));
    start = end;
  }
  return result;
}
function short(text, max = 70) {
  const pieces = chunks(String(text ?? '').replace(/\s+/g, ' ').trim(), max), first = pieces[0] || '';
  return first + (pieces.length > 1 && !first.endsWith('…') ? '…' : '');
}
function subsequence(before, after) {
  let i = 0;
  for (const value of after) if (value === before[i]) i++;
  return i === before.length;
}
function orderChanged(before, after) {
  if (!before || subsequence(before.tokens, after.tokens) || subsequence(after.tokens, before.tokens)) return false;
  const beforeIds = new Set(before.ids), afterIds = new Set(after.ids);
  const retainedBefore = before.ids.filter(id => afterIds.has(id));
  const retainedAfter = after.ids.filter(id => beforeIds.has(id));
  return retainedBefore.some((id, i) => id !== retainedAfter[i]);
}
export function createPageFeedback({ maxEntries = 64, ttlMs = 15 * 60_000, now = Date.now } = {}) {
  const pages = new Map();
  return {
    clear(target = null) {
      if (target) pages.delete(`${target.windowId ?? '?'}:${target.tabId ?? '?'}`);
      else pages.clear();
    },
    render(res, { budget = 2500, notice = '' } = {}) {
      const limit = Math.max(200, Math.min(20000, Number(budget) || 2500));
      const tab = res.target?.tabId ?? '?';
      const key = `${res.target?.windowId ?? '?'}:${tab}`;
      const identity = `${res.documentKey || ''}\n${res.url || res.target?.url || ''}`;
      const at = now();
      let prior = pages.get(key);
      if (!prior || prior.identity !== identity || at - prior.at > ttlMs) prior = {
        identity, sent: new Map(), order: new Map(), reordered: new Set(), sectionReplay: null, notice: '', at
      };
      pages.delete(key); pages.set(key, prior);
      while (pages.size > maxEntries) pages.delete(pages.keys().next().value);
      prior.at = at;
      const rows = new Map();
      const order = new Map();
      for (const block of res.blocks || []) {
        const title = short(block.title || block.id, 35);
        const occurrences = new Map();
        const sequence = { tokens: [], ids: [] };
        order.set(block.id, sequence);
        (block.lines || []).forEach((line, lineIndex) => {
          const control = block.lineTargets?.[lineIndex] || null;
          // A preceding paragraph can move every line without changing any
          // delivered content. Scope text by whole-line content and occurrence:
          // equal real lines remain separate, with their own ordered fragments.
          // Hash once per line to keep fragment keys bounded for long paragraphs.
          // Controls retain their DOM marker identity and fragment position, so a
          // late option/state change updates only that part of the same control.
          const identity = control ? ['control', control]
            : lineIndex === 0 ? ['heading'] : ['text', createHash('sha256').update(String(line ?? '')).digest('hex')];
          const occurrenceKey = JSON.stringify(identity);
          const occurrence = occurrences.get(occurrenceKey) || 0;
          occurrences.set(occurrenceKey, occurrence + 1);
          const fragments = chunks(line);
          if (fragments.length) {
            sequence.tokens.push(occurrenceKey);
            sequence.ids.push(JSON.stringify([...identity, occurrence]));
          }
          fragments.forEach((value, part) => {
            rows.set(JSON.stringify([block.id, ...identity, occurrence, part]), { value, title, block: block.id,
              control, part, heading: lineIndex === 0 && part === 0 });
          });
        });
      }
      const deliveredBlocks = new Set([...prior.sent.values()].map(row => row.block));
      const beforeSections = [...prior.order.keys()], afterSections = [...order.keys()];
      const sectionOrderDiffers = beforeSections.length !== afterSections.length ||
        beforeSections.some((id, i) => id !== afterSections[i]);
      if ((deliveredBlocks.size && orderChanged(
        { tokens: beforeSections, ids: beforeSections }, { tokens: afterSections, ids: afterSections })) ||
          (prior.sectionReplay && sectionOrderDiffers)) prior.sectionReplay = { next: 0, lines: [] };
      if (prior.sectionReplay) {
        // Report section movement as an ordered outline, retaining all unchanged
        // body baselines. Adding a section alone never starts an outline replay.
        prior.sectionReplay.lines = (res.blocks || []).map(block => {
          const id = String(block.id), title = short(block.title || block.id, 35);
          return title === id || title.startsWith(id + ' ') ? title : `${id} ${title}`;
        });
      }
      for (const [block, sequence] of order) {
        if (deliveredBlocks.has(block) && orderChanged(prior.order.get(block), sequence)) prior.reordered.add(block);
      }
      for (const block of prior.reordered) if (!order.has(block)) prior.reordered.delete(block);
      // Remember observed order separately from delivered text. A budgeted replay
      // must not restart on every continuation of the same current sequence.
      prior.order = order;
      const changed = [...rows].filter(([id, row]) => prior.reordered.has(row.block) || prior.sent.get(id)?.value !== row.value);
      const removed = new Map();
      for (const [id, row] of prior.sent) {
        if (rows.has(id) || prior.reordered.has(row.block)) continue;
        if (!removed.has(row.block)) removed.set(row.block, { title: row.title, ids: [] });
        removed.get(row.block).ids.push(id);
      }
      const newNotice = notice && notice !== prior.notice ? short(notice, Math.min(400, Math.max(40, limit - 80))) : '';
      if (!changed.length && !removed.size && !newNotice && !prior.sectionReplay) return `tab=${tab} unchanged`;
      const first = prior.sent.size === 0;
      const output = [`tab=${tab}${first ? ' ' + short(res.title || 'Page', 25) : ' changed'}`];
      if (newNotice) { output.push(newNotice); prior.notice = notice; }
      const reserve = '\nMore: read_page()';
      const sectionReplay = prior.sectionReplay;
      if (sectionReplay) {
        const start = sectionReplay.next;
        const heading = start ? 'Section order (continued):' : 'Section order changed (current order):';
        while (sectionReplay.next < sectionReplay.lines.length) {
          const add = [...(sectionReplay.next === start ? [heading] : []), sectionReplay.lines[sectionReplay.next]];
          if (textTokens([...output, ...add].join('\n') + reserve) > limit) break;
          output.push(...add); sectionReplay.next++;
        }
        if (sectionReplay.next === sectionReplay.lines.length) prior.sectionReplay = null;
      }
      let removedDone = 0;
      for (const { title, ids } of removed.values()) {
        const line = `Removed: ${title} (${ids.length} line fragment${ids.length === 1 ? '' : 's'})`;
        if (textTokens([...output, line].join('\n') + reserve) > limit) break;
        output.push(line);
        ids.forEach(id => prior.sent.delete(id));
        removedDone++;
      }
      let previousBlock = null, previousControl = null, done = 0;
      for (const [id, row] of changed) {
        const add = [];
        const replay = prior.reordered.has(row.block);
        if (replay) add.push(`Order changed: ${row.title} (current order)`);
        else if (row.block !== previousBlock && !row.heading) add.push(row.title);
        if (row.control && row.part > 0 && row.control !== previousControl) add.push(`${row.control} (continued)`);
        add.push(row.value);
        if (textTokens([...output, ...add].join('\n') + reserve) > limit) break;
        output.push(...add);
        if (replay) {
          // Invalidate only this block, and only when its ordered replay actually
          // starts reaching the caller. Unsent content never becomes a baseline.
          for (const [sentId, sent] of prior.sent) if (sent.block === row.block) prior.sent.delete(sentId);
          prior.reordered.delete(row.block);
        }
        prior.sent.set(id, row);
        previousBlock = row.block;
        previousControl = row.control;
        done++;
      }
      if (done < changed.length || removedDone < removed.size || prior.sectionReplay) output.push('More: read_page()');
      return output.join('\n');
    }
  };
}
