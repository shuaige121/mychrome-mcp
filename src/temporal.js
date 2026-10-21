/* Native date/time input planning. The page validates HTML constraints; this
 * module maps the requested canonical value to AX-described keyboard fields. */
export const TEMPORAL_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

export function temporalParts(type, value) {
  const p = {};
  let rest = String(value);
  if (['date', 'datetime-local', 'month'].includes(type)) {
    const m = rest.match(/^(\d{4,})-(\d{2})(?:-(\d{2}))?(?:T(.*))?$/);
    if (!m || (type !== 'month' && !m[3]) || (type === 'datetime-local' && !m[4])) throw new Error('bad_temporal_value');
    [p.year, p.month] = [m[1], m[2]];
    if (m[3]) p.day = m[3];
    rest = m[4] || '';
  } else if (type === 'week') {
    const m = rest.match(/^(\d{4,})-W(\d{2})$/);
    if (!m) throw new Error('bad_temporal_value');
    [p.year, p.week] = [m[1], m[2]];
    rest = '';
  }
  if (type === 'time' || type === 'datetime-local') {
    const m = rest.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    if (!m) throw new Error('bad_temporal_value');
    [p.hour, p.minute, p.second, p.millisecond] = [m[1], m[2], m[3] || '00', (m[4] || '').padEnd(3, '0')];
  }
  if (!Object.keys(p).length) throw new Error('bad_temporal_type');
  return p;
}

function fieldKind(segment, type, parts) {
  const label = String(segment.description || '').trim().toLowerCase();
  const min = Number(segment.min), max = Number(segment.max);
  if (/year|年/.test(label) || max >= 9999) return 'year';
  if (/millisecond|毫秒/.test(label) || max === 999) return 'millisecond';
  if (/second|秒/.test(label)) return 'second';
  if (/minute|分钟|分鐘|分/.test(label)) return 'minute';
  if (/hour|小时|小時|时|時/.test(label)) return 'hour';
  if (/week|周|週/.test(label) || (min === 1 && (max === 52 || max === 53))) return 'week';
  if (/month|月/.test(label)) return 'month';
  if (/day|日|天/.test(label) || (min === 1 && max >= 28 && max <= 31)) return 'day';
  if (/am.?pm|上午|下午/.test(label)) return 'ampm';
  if (min === 0 && max === 23) return 'hour';
  if (min === 1 && max === 12) return type === 'time' ? 'hour' : parts.hour == null ? 'month' : null;
  return null;
}

/** Each returned rectangle is inside the bound DOM input. Unknown/duplicate
 * segments are refused rather than typing into a guessed locale order. */
export function planTemporalKeys(type, value, segments, fieldRect) {
  const parts = temporalParts(type, value), found = new Map();
  const candidates = (segments || []).filter(s => s && s.rect && s.rect.w > 0 && s.rect.h > 0);
  for (const s of candidates) {
    const r = s.rect, x = r.x + r.w / 2, y = r.y + r.h / 2;
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || !fieldRect ||
        x < fieldRect.x || x > fieldRect.x + fieldRect.w || y < fieldRect.y || y > fieldRect.y + fieldRect.h) {
      throw new Error('temporal_field_moved');
    }
    const k = fieldKind(s, type, parts);
    if (!k) continue;
    if (found.has(k)) throw new Error('ambiguous_temporal_fields');
    found.set(k, s);
  }
  // A 0..59 range alone cannot distinguish minutes from seconds. Infer only
  // the one field left after the other was explicitly identified.
  const unnamed60 = candidates.filter(s => !fieldKind(s, type, parts) && Number(s.min) === 0 && Number(s.max) === 59);
  if (unnamed60.length) {
    const missing = ['minute', 'second'].filter(k => !found.has(k));
    if (unnamed60.length !== 1 || missing.length !== 1) throw new Error('ambiguous_temporal_fields');
    found.set(missing[0], unnamed60[0]);
  }
  const required = Object.keys(parts).filter(k => !['second', 'millisecond'].includes(k) || Number(parts[k]) !== 0);
  if (required.some(k => !found.has(k))) throw new Error('missing_temporal_fields');
  const hour = found.get('hour');
  const twelve = hour && Number(hour.max) === 12;
  if (twelve && !found.has('ampm')) throw new Error('missing_temporal_fields');
  if (found.has('ampm')) {
    const label = String(found.get('ampm').description || '');
    if (!/am.?pm/i.test(label)) throw new Error('unsupported_temporal_period');
    parts.ampm = Number(parts.hour) >= 12 ? 'p' : 'a';
  }
  if (twelve) parts.hour = String(Number(parts.hour) % 12 || 12).padStart(2, '0');
  return Object.entries(parts).filter(([k]) => found.has(k)).map(([kind, text]) => ({ kind, text, rect: found.get(kind).rect }));
}
