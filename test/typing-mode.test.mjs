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
  return source.slice(start, source.indexOf('\n}', start) + 2);
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
      throw new Error(`unexpected helper request: ${req.op}`);
    },
  };
  class Clock extends Date { static now() { return state.now; } }
  const c = vm.createContext({
    BridgeError, RoutineError, routineMessage, INPUT_MODES, typingSegments, typedCount, keyupCount,
    S: { setting: () => ({ value: 'auto', source: 'default' }) },
    Date: Clock, String, Number, Math,
    newToken: () => 'binding',
    temporalState: async () => ({ fail: 'not_temporal' }),
    targetLine: () => 'tab 7',
    clickDeliver: async () => { calls.push(['click']); return { what: '[7] Answer' }; },
    clickLines: () => [],
    sleep: async ms => { state.now += ms; },
    lognormalMs: () => 0,
    async post(_s, _ctx, kind, req) {
      calls.push([req.op, req.text ?? req.name, kind]);
      if (req.op === 'type' || req.op === 'paste') {
        if (!state.swallow) state.value += req.text.replace(/\t/g, '    ');
        return { typed: state.returnedCount ?? typedCount(req.text) };
      }
      assert.equal(req.op, 'key');
      assert.equal(req.name, 'return');
      return { ok: true };
    },
    async readAfter(_marker, _tab, expected, bind) {
      if (bind?.set) {
        state.baseline = state.value;
        return { hasFocus: true, activeIsTarget: true, activeEditable: true };
      }
      calls.push(['check']);
      if (state.failRead) throw new Error('page unavailable');
      state.checks++;
      const focusMoved = !state.focus || state.beforeSubmitChanged && state.checks > 1;
      const changed = state.value !== state.baseline;
      return { fieldHasText: !focusMoved && changed && state.value.includes(expected),
        changed, focusMoved, href: 'https://fixture.invalid/' };
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
  });
  vm.runInContext(['fieldConfirms', 'typeInSession', 'typeText', 'callToolInner']
    .map(productionFunction).join('\n'), c);
  return {
    state, calls, invocation,
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
console.log(`typing-mode: ${passed} passed`);
