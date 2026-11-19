/* Regression for an already-open native JavaScript dialog. Run the production
 * click + shared input entry, with strict browser/session fakes; no UI/native IO. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BridgeError } from '../src/bridge.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
function production(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness(dialog, probeError = null) {
  const calls = [];
  const state = { paused: false };
  const B = {
    pageDialog: async () => { calls.push('native-dialog'); if (probeError) throw probeError; return dialog; },
    evalInPage: async () => {
      calls.push('page-eval');
      if (dialog.open) throw new BridgeError('chrome_error', 'page JavaScript is frozen behind the dialog');
      return { ok: true };
    },
  };
  const c = vm.createContext({
    B, BridgeError, process: { env: {} }, String, HANDOFFS: new Map(),
    conversationInputCheck() {}, taskKey: args => args.task || '', persist: fn => fn({}),
    TASK_CANCELLED: null, taskCancelledError: () => new BridgeError('user_cancelled', 'stopped'),
    pausedCheck: () => { if (state.paused) throw new BridgeError('paused_by_user', 'paused'); },
    screenReady: async () => { calls.push('screen'); return ''; },
    siteGate: async () => { await B.evalInPage(); return true; },   // G2: the pre-input check is strict; a clean verdict
    CALL: { getStore: () => null },
    inputActionRun: async () => { calls.push('input-session'); return 'ordinary input'; },
    noteAgentDone: async () => { calls.push('done'); },
  });
  vm.runInContext(['dialogNote', 'dialogPlace', 'dialogRefusal', 'inputAction', 'gateStopped', 'click'].map(production).join('\n'), c);
  return { c, calls, state };
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

for (const [kind, buttons, hasField] of [
  ['alert', ['OK'], false], ['confirm', ['Cancel', 'OK'], false], ['prompt', ['Cancel', 'OK'], true],
]) {
  await check(`an existing ${kind} blocks click before page evaluation or native input`, async () => {
    const h = harness({ open: true, title: 'fixture.test', texts: ['SYNTHETIC_DIALOG'], buttons, hasField });
    await assert.rejects(h.c.click({ tab: 7, marker: 1 }), e => e.code === 'page_dialog' &&
      /SYNTHETIC_DIALOG/.test(e.message) && /answer_dialog/.test(e.message) && e.message.includes(buttons.join(' / ')));
    assert.deepEqual(h.calls, ['native-dialog'], 'no siteGate/eval, screen change, preflight or input session');
  });
}
await check('ordinary input keeps its previous site and session checks when no dialog is open', async () => {
  const h = harness({ open: false });
  assert.equal(await h.c.click({ tab: 7, marker: 1 }), 'ordinary input');
  assert.deepEqual(h.calls, ['native-dialog', 'screen', 'page-eval', 'input-session']);
});
await check('failed native dialog inspection does not fall through to potentially frozen page JavaScript', async () => {
  const h = harness({ open: false }, new BridgeError('ax_probe_failed', 'native dialog state unavailable'));
  await assert.rejects(h.c.click({ tab: 7, marker: 1 }), e => e.code === 'ax_probe_failed');
  assert.deepEqual(h.calls, ['native-dialog']);
});
await check('the shared input boundary also blocks other page inputs behind the same dialog', async () => {
  const h = harness({ open: true, texts: ['SYNTHETIC_DIALOG'], buttons: ['OK'] });
  await assert.rejects(h.c.inputAction('type tab 7', () => {}, () => {}), e => e.code === 'page_dialog');
  assert.deepEqual(h.calls, ['native-dialog']);
});
await check('Pause and explicit Stop take precedence over dialog probing and never retake input', async () => {
  const h = harness({ open: true, texts: ['SYNTHETIC_DIALOG'], buttons: ['OK'] });
  h.state.paused = true;
  await assert.rejects(h.c.click({ tab: 7, marker: 1 }), e => e.code === 'paused_by_user');
  h.state.paused = false; h.c.TASK_CANCELLED = 'fixture-task';
  await assert.rejects(h.c.click({ tab: 7, marker: 1, task: 'fixture-task' }), e => e.code === 'user_cancelled');
  assert.deepEqual(h.calls, []);
});
function readObservationHarness(failAt = 1, ack = null, code = 'dialog_probe_unknown') {
  const calls = [], context = {};
  let probes = 0;
  const st = { tab: 7, marker: 1, prep: { target: { tabId: 7 }, ownNote: '' }, ack };
  const c = vm.createContext({
    B: {
      pageDialog: async () => {
        calls.push('native-dialog');
        if (++probes === failAt) throw Object.assign(new BridgeError(code, 'native state unknown'), { inputDelivery: 'not_sent' });
        return { open: false };
      },
      evalInPage: async () => { calls.push('page-eval'); throw Error('DOM must not follow unknown native dialog state'); },
      pageScript: async () => { calls.push('page-script'); throw Error('page script must not follow unknown native dialog state'); },
    },
    BridgeError, Date, process: { env: {} }, CALL: { getStore: () => context }, sleep: async () => {},
    readRequest: () => ({ full: true }),
    waitAck: async () => { calls.push('ack-eval'); throw Error('ack must not run after unknown probe'); },
  });
  // read_page's only dialog check is blockCheck's, inside the actual siteGate (P2: one check, one eval).
  vm.runInContext(['gatedReadScript', 'blockCheck', 'siteGate', 'readPage', 'clickReport', 'dialogNote', 'dialogPlace', 'dialogRefusal'].map(production).join('\n'), c);
  return { c, calls, context, st };
}
await check('read_page propagates unknown native dialog state before the site check or any DOM read', async () => {
  const h = readObservationHarness();
  await assert.rejects(h.c.readPage({ tab: 7 }), e => e.code === 'dialog_probe_unknown' && e.inputDelivery === 'not_sent');
  assert.deepEqual(h.calls, ['native-dialog']);
});
await check('click observation keeps delivery/no-replay when the first or next native dialog probe is unknown', async () => {
  // P2: no separate probe before waitAck; with the acknowledgement known, the observation loop's probe is the first.
  for (const [failAt, ack] of [[1, null], [1, { seen: true }]]) {
    const h = readObservationHarness(failAt, ack);
    await assert.rejects(h.c.clickReport(h.st), e => {
      assert.equal(e.code, 'dialog_probe_unknown');
      assert.equal(e.inputDelivery, 'sent'); assert.equal(e.noRetry, true);
      assert.match(e.message, /已发送点击.*结果未确认.*不要重发点击/);
      return true;
    });
    assert.deepEqual(h.calls, Array(failAt).fill('native-dialog'));
    assert.equal(h.st.ack, ack, 'unknown probe must not invent a click acknowledgement');
    assert.equal(h.context.routineEvidence.confirmed, false);
  }
});
for (const code of ['dialog_probe_unknown', 'dialog_ambiguous']) {
  await check(`${code} blocks read, block and acknowledgement DOM access`, async () => {
    const h = readObservationHarness(1, null, code);
    await assert.rejects(h.c.readPage({ tab: 7 }), e => e.code === code);
    const after = readObservationHarness(1, null, code);
    await assert.rejects(after.c.clickReport(after.st), e => e.code === code && e.inputDelivery === 'sent' && e.noRetry);
    for (const name of ['blockCheck', 'waitAck']) {
      const local = readObservationHarness(1, null, code);
      vm.runInContext(production(name), local.c);
      await assert.rejects(name === 'blockCheck' ? local.c.blockCheck(7) : local.c.waitAck(7, 'token', {}, 1), e => e.code === code);
      assert.deepEqual(local.calls, ['native-dialog']);
    }
  });
}
for (const code of ['dialog_probe_unknown', 'dialog_ambiguous']) {
  await check(`real waitAck preserves sent/noRetry on its second probe: ${code}`, async () => {
    const verify = async (modified = source) => {
      const h = readObservationHarness(2, null, code);
      h.st.token = 'synthetic-ack'; h.c.ACK_CAP_MS = 1;
      const start = modified.indexOf('async function clickReport(');
      const actualClick = modified.slice(start, modified.indexOf('\n}', start) + 2);
      vm.runInContext(production('waitAck') + '\n' + actualClick, h.c);
      await assert.rejects(h.c.clickReport(h.st), e => {
        assert.equal(e.code, code); assert.equal(e.inputDelivery, 'sent'); assert.equal(e.noRetry, true);
        assert.match(e.message, /已发送点击.*结果未确认.*不要重发点击/); return true;
      });
      // P2: both probes are waitAck's; the ack read between them follows a known-closed probe.
      assert.deepEqual(h.calls, ['native-dialog', 'page-script', 'native-dialog']);
      assert.equal(h.st.ack, null); assert.equal(h.context.routineEvidence.confirmed, false);
      assert.equal(h.context.routineEvidence.inputDelivery, 'sent');
    };
    await verify();
    const guard = 'ACK_CAP_MS, inspectDialog);'; assert.ok(source.includes(guard));
    await assert.rejects(verify(source.replace(guard, 'ACK_CAP_MS);')), e => e.code === 'ERR_ASSERTION');
  });
}
await check('real waitAck known-open second probe reports that native dialog and cannot confirm a routine', async () => {
  const h = readObservationHarness(99);
  h.st.token = 'synthetic-ack'; h.c.ACK_CAP_MS = 1;
  h.c.clip = (s, n) => String(s).slice(0, n); h.c.redactText = s => s;
  let probes = 0;
  h.c.B.pageDialog = async () => {
    h.calls.push('native-dialog');
    return ++probes === 1 ? { open: false } : { open: true, texts: ['SYNTHETIC_SECOND_DIALOG'], buttons: ['Cancel', 'OK'] };
  };
  vm.runInContext(['dialogNote', 'dialogPlace', 'dialogRefusal', 'waitAck'].map(production).join('\n'), h.c);
  const result = await h.c.clickReport(h.st);
  assert.match(result.out, /新弹窗.*SYNTHETIC_SECOND_DIALOG.*Cancel \/ OK/);
  assert.deepEqual(h.calls, ['native-dialog', 'page-script', 'native-dialog']);
  assert.equal(h.st.ack.viaDialog, true);
  assert.equal(h.context.routineEvidence.code, 'page_dialog');
  assert.equal(h.context.routineEvidence.ok, false); assert.equal(h.context.routineEvidence.confirmed, false);
});
console.log(`${passed} page-dialog input groups passed; all browser/native IO faked`);
