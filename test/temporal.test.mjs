/* Native date/time value validation and AX keyboard planning, no input posted. */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pageScript } from '../src/bridge.js';
import { temporalParts, planTemporalKeys } from '../src/temporal.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }
function fixture(type, extra = '') {
  const w = new JSDOM(`<input id="field" type="${type}" ${extra}>`, {
    url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true,
  }).window;
  const el = w.document.querySelector('input');
  w.__chromeBridge = { markers: [null, el], url: w.location.href };
  let events = 0;
  el.addEventListener('input', () => events++);
  el.addEventListener('change', () => events++);
  const run = async (mode, text = null, over = {}) => JSON.parse(w.eval(await pageScript('temporal', {
    TEMPORAL: { mode, marker: 1, text, token: 'test', ...over },
  })));
  return { w, el, run, events: () => events, close: () => w.close() };
}

await check('all native temporal types validate on a detached clone without touching the field', async () => {
  for (const [type, value] of [['date', '2028-02-29'], ['time', '13:45'], ['month', '2026-10'],
    ['week', '2026-W43'], ['datetime-local', '2026-10-20T13:45']]) {
    const f = fixture(type);
    try {
      const plan = await f.run('plan', value);
      assert.equal(plan.fail, undefined, JSON.stringify(plan));
      assert.equal(plan.expected, value);
      assert.equal(plan.type, type);
      assert.equal(f.el.value, '');
      assert.equal(f.events(), 0);
      assert.equal(plan.selected, false);
    } finally { f.close(); }
  }
});

await check('impossible dates, invalid times and out-of-range/step-mismatched values are rejected', async () => {
  for (const [type, value, attrs] of [
    ['date', '2026-02-29', ''], ['date', '10/20/2026', ''], ['date', '0000-01-01', ''],
    ['time', '25:00', ''], ['time', '13:30:05', ''], ['week', '2026-W54', ''],
    ['date', '2026-10-20', 'min="2026-10-21"'], ['month', '2026-11', 'max="2026-10"'],
  ]) {
    const f = fixture(type, attrs);
    try { assert.equal((await f.run('plan', value)).fail, 'invalid_value', `${type}: ${value}`); assert.equal(f.el.value, ''); }
    finally { f.close(); }
  }
});

await check('seconds and milliseconds are accepted only when the field permits their precision', async () => {
  const f = fixture('time', 'step="0.001"');
  try {
    const plan = await f.run('plan', '13:30:05.250');
    assert.equal(plan.fail, undefined);
    assert.deepEqual(temporalParts(plan.type, plan.expected), { hour: '13', minute: '30', second: '05', millisecond: '250' });
  } finally { f.close(); }
});

await check('disabled/read-only controls are not used and a label resolves to its native field', async () => {
  for (const attr of ['disabled', 'readonly']) {
    const f = fixture('date', attr);
    try { assert.equal((await f.run('plan', '2026-10-20')).fail, 'disabled'); }
    finally { f.close(); }
  }
  const f = fixture('date');
  const label = f.w.document.createElement('label');
  label.htmlFor = 'field'; f.w.document.body.prepend(label); f.w.__chromeBridge.markers[1] = label;
  try { assert.equal((await f.run('plan', '2026-10-20')).fail, undefined); }
  finally { f.close(); }
});

await check('confirmation requires the exact bound field, exact value, and current validity', async () => {
  const f = fixture('date');
  try {
    await f.run('plan', '2026-10-20');
    f.el.value = '2026-10-21';
    assert.equal((await f.run('check')).selected, false);
    f.el.value = '2026-10-20';
    assert.equal((await f.run('check')).selected, true);
    assert.equal((await f.run('check', null, { token: 'other' })).fail, 'field_changed');
    f.el.outerHTML = '<input type="date" value="2026-10-20">';
    assert.equal((await f.run('check')).fail, 'field_changed');
  } finally { f.close(); }
});

const rect = { x: 100, y: 100, w: 400, h: 40 };
const segment = (description, min, max, x) => ({ description, min, max, rect: { x, y: 105, w: 40, h: 30 } });
await check('AX labels and ranges identify fields independently of locale order', () => {
  const segments = [segment('月', 1, 12, 110), segment('日', 1, 31, 160), segment('年', 1, 275760, 210)];
  const plan = planTemporalKeys('date', '2026-10-20', segments, rect);
  assert.deepEqual(plan.map(x => [x.kind, x.text, x.rect.x]), [['year', '2026', 210], ['month', '10', 110], ['day', '20', 160]]);
});
await check('time fields include zero seconds when shown, and 12-hour time includes its period', () => {
  const segments = [segment('Hours', 1, 12, 110), segment('Minutes', 0, 59, 160),
    segment('Seconds', 0, 59, 210), segment('AM/PM', 0, 1, 260)];
  const plan = planTemporalKeys('time', '13:45', segments, rect);
  assert.deepEqual(plan.map(x => [x.kind, x.text]), [['hour', '01'], ['minute', '45'], ['second', '00'], ['ampm', 'p']]);
});
await check('missing, ambiguous and shifted AX fields are refused instead of guessing', () => {
  const y = segment('Year', 1, 275760, 110), m = segment('Month', 1, 12, 160), d = segment('Day', 1, 31, 210);
  assert.throws(() => planTemporalKeys('date', '2026-10-20', [y, m], rect), /missing/);
  assert.throws(() => planTemporalKeys('date', '2026-10-20', [y, m, d, { ...d }], rect), /ambiguous/);
  assert.throws(() => planTemporalKeys('date', '2026-10-20', [y, m, { ...d, rect: { ...d.rect, x: 700 } }], rect), /moved/);
  assert.throws(() => planTemporalKeys('time', '13:45', [segment('Hours', 1, 12, 110), segment('Minutes', 0, 59, 160)], rect), /missing/);
});

await check('unnamed minute/second fields are refused unless exactly one can be inferred', () => {
  const hour = segment('Hours', 0, 23, 110), minute = segment('Minutes', 0, 59, 160);
  const unknown = segment('', 0, 59, 210), otherUnknown = segment('', 0, 59, 260);
  assert.throws(() => planTemporalKeys('time', '13:45:08', [hour, unknown, otherUnknown], rect), /ambiguous/);
  assert.throws(() => planTemporalKeys('time', '13:45', [hour, unknown], rect), /ambiguous/);
  assert.deepEqual(planTemporalKeys('time', '13:45:08', [hour, minute, unknown], rect).map(p => p.kind),
    ['hour', 'minute', 'second']);
});

console.log(`\n${passed} temporal checks passed.`);
