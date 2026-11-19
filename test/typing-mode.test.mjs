/* Production typing and MCP result paths with strict fakes. No Chrome, helper,
 * runtime state, clipboard or physical keyboard is opened by these tests.
 * These verify dispatch/confirmation semantics, not real macOS input events. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BridgeError } from '../src/bridge.js';
import { RoutineError, routineMessage } from '../src/routine-runner.js';
import { INPUT_MODES, typingSegments, typedCount, keyupCount } from '../src/guard.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `production function ${name}`);
  return (name === 'callToolInner' ? 'function noticeTerminalRefusal() {}\n' : '') + source.slice(start, source.indexOf('\n}', start) + 2);
}

function harness(options = {}) {
  const calls = [];
  const state = { now: 0, value: '', baseline: '', checks: 0, focus: true,
    failRead: false, swallow: false, routed: true, returnedCount: null,
    beforeSubmitChanged: false, ...options };
  const prep = { target: { tabId: 7 }, ownNote: '' };
  const invocation = {};
  let observer;
  const ctx = {
    step(text) { calls.push(['step', text]); },
    panel(stage, result) { calls.push(['panel', stage, result]); },
    observe(fn) { observer = fn; calls.push(['observe']); },
  };
  const session = {
    async request(req) {
      calls.push([req.op]);
      if (req.op === 'routed') return { ok: true, allToChrome: state.routed, ms: 1 };
      if (req.op === 'restoreClipboard') return { restored: true };
      if (req.op === 'panel') return { ok: true };
      throw new Error(`unexpected helper request: ${req.op}`);
    },
  };
  class Clock extends Date { static now() { return state.now; } }
  const c = vm.createContext({
    process: { env: {} },
    BridgeError, RoutineError, routineMessage, INPUT_MODES, typingSegments, typedCount, keyupCount,
    S: { setting: key => ({ value: key === 'inputSpeed' ? (state.speed ?? 1) : 'auto', source: 'default' }) },
    Date: Clock, String, Number, Math,
    newToken: () => 'binding',
    temporalState: async () => ({ fail: 'not_temporal' }),
    targetLine: () => 'tab 7',
    clickDeliver: async () => { calls.push(['click']); return { what: '[7] Answer' }; },
    clickLines: () => [],
    sleep: async ms => { state.now += ms; (state.sleeps ||= []).push(ms); },
    lognormalMs: () => state.sample ?? 0,
    async post(_s, _ctx, kind, req) {
      calls.push([req.op, req.text ?? req.name, kind]);
      if (req.op === 'type' || req.op === 'paste') {
        if (!state.swallow) state.value += req.text.replace(/\t/g, '    ');
        return { typed: state.returnedCount ?? typedCount(req.text) };
      }
      assert.equal(req.op, 'key');
      if (req.name === 'select_all') return { ok: true };
      assert.equal(req.name, 'return');
      return { ok: true };
    },
    async readAfter(_marker, _tab, expected, bind) {
      if (bind?.selectAll) return { selectionAll: true };
      if (bind?.set) {
        calls.push(['set']);
        state.baseline = state.value;
        if (state.wrongField) return { hasFocus: true, activeIsTarget: false, activeEditable: false, activeElement: { tag: 'body' } };
        return { hasFocus: true, activeIsTarget: true, activeEditable: true };
      }
      if (expected === null && bind?.check) return { bindingMatches: true, selectionStable: state.value === state.baseline };
      calls.push(['check', bind?.record === true]);
      if (state.failRead) throw new Error('page unavailable');
      state.checks++;
      const focusMoved = !state.focus || state.beforeSubmitChanged && state.checks > 1;
      const changed = state.value !== state.baseline;
      const fieldHasText = !focusMoved && changed && state.value.includes(expected);
      // read_page's typed-text record (src/page/after.js typedField), only when asked for.
      const typedField = bind?.record && fieldHasText
        ? { id: 'f7', value: state.recordNull ? null : state.value, replace: false, at: state.baseline.length, cut: 0 } : null;
      return { fieldHasText, confirmedChars: fieldHasText ? [...expected].length : 0,
        bindingMatches: !focusMoved, changed, focusMoved, href: 'https://fixture.invalid/', typedField };
    },
    waitAck: async () => ({ seen: false }),
    ackLine: () => 'unconfirmed key observation',
    armAck: async () => 'return-token',
    waitForNavigation: async () => null,
    ledgerNavigated() {},
    persist: async fn => { calls.push(['persist']); return fn({}); },
    prepareActivate: async () => prep,
    activationHint: () => null,
    clickPreflight: async () => ({}),
    veilFor: () => ({}),
    taskKey: () => 'Answer the paper',
    async inputAction(_name, _prepare, action) {
      calls.push(['action']);
      const result = await action(session, prep, ctx);
      calls.push(['action-returned']);
      return observer ? (await observer()).out : result;
    },
    PLAN: null,
    pauseGate: async () => {},
    touchTab: async () => {},
    noteOutcome: ok => calls.push(['outcome', ok]),
    CALL: { getStore: () => invocation },
    FALLBACK_CODES: new Set(),
    FALLBACK_HINT: '',
    goneTabNote: () => '',
    setupHint: () => '',
    TYPED: new Map(), TYPED_MAX: 32,
  });
  // rememberTyped (C7) only when the source has it, so the checks before it still run without it.
  vm.runInContext(['rememberTyped', 'inputSpeedNow', 'paceFloor', 'fieldConfirms', 'typingEstimate', 'typeInSession', 'typeText', 'callToolInner']
    .filter(name => name !== 'rememberTyped' || source.includes('function rememberTyped('))
    .map(productionFunction).join('\n'), c);
  return {
    state, calls, invocation, typed: c.TYPED,
    type: args => c.typeText({ marker: 7, ...args }),
    tool: args => c.callToolInner('type_text', { marker: 7, ...args }, {}, async () => ''),
  };
}
const inputCalls = h => h.calls.filter(x => ['type', 'paste', 'key'].includes(x[0]));
const resultText = result => result.content.map(x => x.text || '').join('\n');
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

await check('default dispatch is one ordered keystroke run; paste is explicit', () => {
  for (const text of ['hi', 'Hello, World! 123', 'a'.repeat(500), 'a\r\nb\tc']) {
    assert.deepEqual(typingSegments(text), [{ mode: 'type', text }]);
    assert.deepEqual(typingSegments(text, 'paste'), [{ mode: 'paste', text }]);
  }
  assert.deepEqual(typingSegments('你好', 'paste'), [{ mode: 'paste', text: '你好' }]);
  assert.deepEqual(typingSegments(''), []);
});
await check('unsupported characters never produce a mixed keys/paste plan', () => {
  for (const text of ['Hi 你好 ok', 'café', 'ok 👍', 'x\u0000y']) {
    for (const mode of [undefined, 'keys']) {
      assert.throws(() => typingSegments(text, mode), e => e.code === 'unsupported_key_text');
    }
  }
  assert.throws(() => typingSegments('abc', 'other'), e => e.code === 'bad_input_mode');
});
await check('MCP schema agrees with the runtime default', () => {
  const definition = source.slice(source.indexOf("name: 'type_text'"),
    source.indexOf("name: 'scroll'", source.indexOf("name: 'type_text'")));
  assert.match(definition, /input_mode: \{ type: 'string', enum: INPUT_MODES, default: 'keys'/);
  const description = JSON.parse(definition.match(/description:\s*("(?:[^"\\]|\\.)*")/)[1]);
  assert.match(description, /\bexplicit\b[^.]*\bpaste\b/i);
  assert.doesNotMatch(definition, /non-ASCII still pasted/);
  assert.match(definition, /replace: \{ type: 'boolean', default: false/);
});
await check('invalid replacement options refuse before takeover or input', async () => {
  for (const replace of ['true', 1, {}]) {
    const h = harness();
    const result = await h.tool({ text: 'draft', replace });
    assert.equal(result.isError, true);
    assert.equal(h.invocation.code, 'bad_replace');
    assert.equal(h.calls.some(x => ['persist', 'action', 'click'].includes(x[0])), false);
    assert.deepEqual(inputCalls(h), []);
  }
});
await check('omitted input_mode types ASCII and confirms before the action returns', async () => {
  const h = harness();
  const result = await h.tool({ text: 'answer seven' });
  assert.notEqual(result.isError, true);
  assert.deepEqual(inputCalls(h).map(x => [x[0], x[1]]), [['type', 'answer seven']]);
  assert.match(resultText(result), /^✅ 已输入并在输入框里确认：逐键输入 12 个字符/);
  assert.ok(h.calls.findIndex(x => x[0] === 'check') < h.calls.findIndex(x => x[0] === 'action-returned'));
  assert.equal(h.calls.some(x => x[0] === 'observe'), false);
});
await check('P3: speed scales the paste pause as max(floor, sample / speed); speed 1 leaves every sample alone', async () => {
  // First run floor 150 (sample range 150-900); the human pause is the sample, floored.
  for (const [speed, sample, want] of [[1, 150, 150], [1, 300, 300], [1, 900, 900], [3, 150, 150], [3, 300, 150], [3, 900, 300], [3, 600, 200], [2, 900, 450], [0.5, 300, 600]]) {
    const h = harness({ speed, sample });
    assert.notEqual((await h.tool({ text: '你好', input_mode: 'paste' })).isError, true);
    const pause = h.state.sleeps.find(ms => ms > 0);
    assert.ok(Math.abs(pause - want) < 1e-9, `speed ${speed} sample ${sample}: ${pause} vs ${want}`);
  }
});
await check('P3: ETA is chars x (285/speed + 15) ms, labelled as a calibrated estimate', async () => {
  for (const [speed, seconds] of [[1, 120], [3, 44], [0.5, 234], [1.5, 82]]) {
    const h = harness({ speed });
    h.invocation.notifyProgress = async (done, total, message) => h.calls.push(['progress', done, total, message]);
    assert.notEqual((await h.tool({ text: 'a'.repeat(400) })).isError, true);
    const line = h.calls.find(x => x[0] === 'progress')[3];
    assert.equal(line, `预计约 ${seconds} 秒（当前速度 ${speed}×，校准估计）`);
  }
});
await check('explicit paste restores the clipboard after the field confirms', async () => {
  const h = harness();
  const result = await h.tool({ text: '你好', input_mode: 'paste' });
  assert.notEqual(result.isError, true);
  assert.deepEqual(inputCalls(h).map(x => x[0]), ['paste']);
  assert.ok(h.calls.findIndex(x => x[0] === 'restoreClipboard') > h.calls.findIndex(x => x[0] === 'check'));
  assert.match(resultText(result), /^✅ 已输入并在输入框里确认：一次 Cmd\+V/);
});
await check('default and explicit keys refuse non-ASCII before takeover or focus click', async () => {
  for (const input_mode of [undefined, 'keys']) {
    const h = harness();
    const result = await h.tool({ text: 'Hi 你好 ok', input_mode });
    assert.equal(result.isError, true);
    assert.equal(h.invocation.code, 'unsupported_key_text');
    assert.deepEqual(inputCalls(h), []);
    assert.equal(h.calls.some(x => ['persist', 'action', 'click'].includes(x[0])), false);
    assert.match(resultText(result), /显式设置 input_mode/);
  }
});
await check('blank Q7 input is a top-level error with the failure first, with or without submit', async () => {
  for (const submit of [false, true]) {
    const h = harness({ swallow: true });
    const result = await h.tool({ text: 'answer seven', submit });
    assert.equal(result.isError, true);
    assert.equal(h.invocation.failed, true);
    assert.equal(h.invocation.code, 'input_unconfirmed');
    assert.match(resultText(result), /^❌ 未确认已输入：.*输入框的内容没有变化/);
    assert.doesNotMatch(resultText(result), /✅ 已输入/);
    assert.equal(inputCalls(h).some(x => x[0] === 'key'), false);
    assert.equal(h.calls.some(x => x[0] === 'outcome' && x[1] === true), false);
    assert.ok(h.calls.some(x => x[0] === 'panel' && x[1] === 'confirm' && x[2] === 'fail'));
  }
});
await check('blocked paste restores the clipboard and returns an error without Return', async () => {
  const h = harness({ swallow: true });
  const result = await h.tool({ text: '你好', input_mode: 'paste', submit: true });
  assert.equal(result.isError, true);
  assert.ok(h.calls.some(x => x[0] === 'restoreClipboard'));
  assert.deepEqual(inputCalls(h).map(x => x[0]), ['paste']);
  assert.match(resultText(result), /因此没有按回车提交/);
});
await check('text that was already present cannot confirm swallowed input', async () => {
  const h = harness({ value: 'answer seven', swallow: true });
  const result = await h.tool({ text: 'answer seven' });
  assert.equal(result.isError, true);
  assert.equal(h.state.value, 'answer seven');
});
await check('focus loss and an unreadable field each fail without submitting', async () => {
  for (const options of [{ focus: false }, { failRead: true }]) {
    const h = harness(options);
    const result = await h.tool({ text: 'answer seven', submit: true });
    assert.equal(result.isError, true);
    assert.equal(h.invocation.code, 'input_unconfirmed');
    assert.equal(inputCalls(h).some(x => x[0] === 'key'), false);
  }
});
await check('partial helper count or unconfirmed routing cannot become success from matching text', async () => {
  for (const options of [{ returnedCount: 2 }, { routed: false }]) {
    const h = harness(options);
    const result = await h.tool({ text: 'answer seven', submit: true });
    assert.equal(h.state.value, 'answer seven');
    assert.equal(result.isError, true);
    assert.match(resultText(result), /部分按键未确认完整送达/);
    assert.equal(inputCalls(h).some(x => x[0] === 'key'), false);
  }
});
await check('focus change before Return is a submit error, not completed submission', async () => {
  const h = harness({ beforeSubmitChanged: true });
  const result = await h.tool({ text: 'answer seven', submit: true });
  assert.equal(result.isError, true);
  assert.equal(h.invocation.code, 'submit_unconfirmed');
  assert.match(resultText(result), /^❌ 未提交：/);
  assert.equal(inputCalls(h).some(x => x[0] === 'key'), false);
});
await check('verified input permits exactly one Return when explicitly requested', async () => {
  const h = harness();
  const result = await h.tool({ text: 'answer seven', submit: true });
  assert.notEqual(result.isError, true);
  assert.deepEqual(inputCalls(h).map(x => [x[0], x[1]]), [['type', 'answer seven'], ['key', 'return']]);
  const enter = h.calls.findIndex(x => x[0] === 'key');
  assert.equal(h.calls.slice(0, enter).filter(x => x[0] === 'check').length, 2);
});
await check('invalid modes and whitespace-only text never enter an input session', async () => {
  for (const args of [{ text: 'answer', input_mode: 'other' }, { text: ' \n ' }]) {
    const h = harness();
    const result = await h.tool(args);
    assert.equal(result.isError, true);
    assert.equal(h.calls.some(x => x[0] === 'action'), false);
  }
});
await check('C7: only the last confirmation of a successful type records the field for read_page', async () => {
  const h = harness();
  const text = 'a'.repeat(70);   // three 32-character chunks, each confirmed
  assert.notEqual((await h.tool({ text })).isError, true);
  const asked = h.calls.filter(x => x[0] === 'check').map(x => x[1]);
  assert.equal(asked.filter(Boolean).length, 1, JSON.stringify(asked));
  assert.equal(asked.at(-1), true);
  const records = () => JSON.parse(JSON.stringify([...h.typed]));   // objects from the vm realm
  assert.deepEqual(records(), [['f7', { tab: 7, value: text, own: true }]]);
  // Appending to what the agent left there keeps it the agent's own text.
  assert.notEqual((await h.tool({ text: 'bc' })).isError, true);
  assert.deepEqual(records(), [['f7', { tab: 7, value: text + 'bc', own: true }]]);
  // A field that cannot be recorded exactly any more (or turned private) drops its old record.
  h.state.recordNull = true;
  assert.notEqual((await h.tool({ text: 'de' })).isError, true);
  assert.equal(h.typed.size, 0);
  // Unconfirmed input records nothing.
  const failed = harness({ swallow: true });
  assert.equal((await failed.tool({ text: 'answer seven' })).isError, true);
  assert.equal(failed.typed.size, 0);
});
await check('C8: text over 300 characters announces its estimated time before the first key, then records chars/second', async () => {
  const h = harness({ speed: 2 });
  h.invocation.notifyProgress = async (done, total, message) => h.calls.push(['progress', done, total, message]);
  const text = 'a'.repeat(500);
  const out = resultText(await h.tool({ text }));
  const announce = h.calls.findIndex(x => x[0] === 'progress' && /预计约 79 秒（当前速度 2×，校准估计）/.test(x[3] || ''));
  const firstKey = h.calls.findIndex(x => x[0] === 'type');
  assert.ok(announce >= 0, JSON.stringify(h.calls));
  assert.ok(announce < firstKey, 'the estimate must precede the first key');
  assert.ok(h.calls.findIndex(x => x[0] === 'step' && /预计约 79 秒/.test(x[1])) < firstKey);
  assert.match(out, /预计约 79 秒（当前速度 2×，校准估计）/);
  assert.match(out, /实际 [\d.]+ 字\/秒/);
  assert.ok(Number.isFinite(h.invocation.charsPerSec) && h.invocation.typedChars === 500);
  assert.ok(!JSON.stringify([h.invocation, h.calls.filter(x => x[0] === 'progress')]).includes('aaaa'), 'numbers only, never the text');
  // 300 characters or fewer, and paste, say nothing about time.
  for (const args of [{ text: 'a'.repeat(300) }, { text: 'a'.repeat(500), input_mode: 'paste' }]) {
    const q = harness();
    q.invocation.notifyProgress = async (...a) => q.calls.push(['progress', ...a]);
    assert.doesNotMatch(resultText(await q.tool(args)), /预计约/);
    assert.ok(!q.calls.some(x => x[0] === 'progress' && x[3]));
  }
});
await check('C8 QA: with replace:true the estimate is published before select_all and before the first type', async () => {
  const h = harness({ speed: 1 });
  h.invocation.notifyProgress = async (done, total, message) => h.calls.push(['progress', done, total, message]);
  assert.notEqual((await h.tool({ text: 'a'.repeat(400), replace: true })).isError, true);
  const eta = h.calls.findIndex(x => x[0] === 'progress' && /预计约 120 秒（当前速度 1×，校准估计）/.test(x[3] || ''));
  const selectAll = h.calls.findIndex(x => x[0] === 'key' && x[1] === 'select_all');
  const firstType = h.calls.findIndex(x => x[0] === 'type');
  const set = h.calls.findIndex(x => x[0] === 'set');
  assert.ok(selectAll >= 0 && firstType >= 0 && eta >= 0 && set >= 0, JSON.stringify(h.calls));
  assert.ok(set < eta && eta < selectAll && selectAll < firstType, `set ${set}, eta ${eta}, select_all ${selectAll}, type ${firstType}`);
});
await check('C8 QA A3: no-marker typing into a non-input refuses with wrong_field and announces no estimate', async () => {
  const h = harness({ speed: 1, wrongField: true });
  h.invocation.notifyProgress = async (done, total, message) => h.calls.push(['progress', done, total, message]);
  const result = await h.tool({ text: 'a'.repeat(400), marker: undefined });
  assert.equal(result.isError, true);
  assert.equal(h.invocation.code, 'wrong_field');
  assert.ok(!h.calls.some(x => (x[0] === 'progress' && /预计约/.test(x[3] || '')) || (x[0] === 'step' && /预计约/.test(x[1] || ''))), JSON.stringify(h.calls));
  assert.ok(!h.calls.some(x => x[0] === 'type' || x[0] === 'key'), JSON.stringify(h.calls));
});
console.log(`typing-mode: ${passed} passed`);
