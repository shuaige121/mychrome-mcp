// Actual guard policy/cleanup regressions. Every OS/native effect is inert.
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runInputAction, releaseKept, normalizeReturnFocus, stopRestoreLine } from '../src/guard.js';
import { BridgeError, UserInterrupted } from '../src/bridge.js';

const original = await fs.readFile(new URL('../src/guard.js', import.meta.url), 'utf8');
const target = { chromePid: 42, windowId: 10, tabId: 3, cgWindow: 70 };
const policy = (mode, source = 'explicit') => ({ mode, source });
const failures = [];
let checks = 0, killed = 0;
async function check(name, fn) {
  try { await fn(); checks++; console.log(`ok ${checks} ${name}`); }
  catch (error) { failures.push({ name, stack: error.stack }); console.error(`FAIL ${name}\n${error.stack}`); }
}
function fixture(options = {}) {
  const events = [], writes = [], observations = [];
  const state = { held: false, closed: 0, actionDone: false, afterStatuses: 0, ...options };
  const session = { interrupted: null, request: async req => {
    events.push(req.op === 'panel' ? `panel:${req.stage || 'failure'}` : req.op);
    if (req.op === 'hold') { state.held = true; return { ok: true, epoch: 1, pointer: { x: 5, y: 6 }, heldAt: 1000 }; }
    if (req.op === 'recordNativeScene') return { ok: true, epoch: 1, restoreToken: 'r'.repeat(64) };
    if (req.op === 'veil') return { ok: true, epoch: 1, held: state.held };
    if (req.op === 'begin') {
      if (state.beginFailure) throw new BridgeError('prepare_failed', 'synthetic begin failure');
      return { ok: true, epoch: 1, inputMonitor: true, takeover: { active: state.held } };
    }
    if (req.op === 'status') {
      if (state.statusMissingAfterAction && state.actionDone) return null;
      const late = state.actionDone && ++state.afterStatuses === 2 && state.lateStatus;
      return { ok: true, epoch: 1, ...(late ? { interrupted: { kind: 'key', epoch: 1000 } } : {}),
        takeover: { active: state.held && !state.lost, aborted: !!state.stopped, abortedBy: state.stopped ? 'esc' : undefined } };
    }
    if (req.op === 'nativeChrome') {
      if (req.intent.kind === 'restoreScene') writes.push('nativeRestore');
      return { ok: true, epoch: 1, operationId: req.operationId, inputDelivery: 'sent', stages: [] };
    }
    if (req.op === 'warp' || req.op === 'handBack') writes.push(req.op);
    return { ok: true, epoch: 1, ...(req.op === 'warp' ? { verified: true, warped: req.to } : {}) };
  }, close: async () => {
    events.push('close'); state.closed++; state.held = false;
    if (state.endVariant === 'session_interrupted') session.interrupted = { kind: 'key', epoch: 1000 };
    if (state.endFailure) throw Error('synthetic missing end reply');
    return { ok: true, restored: true, released: ['shift'],
      ...(state.endVariant === 'interrupted' ? { interrupted: { kind: 'key', epoch: 1000 } } : {}),
      takeover: { active: false, ...(state.endVariant === 'aborted' ? { aborted: true, abortedBy: 'esc' } : {}) } };
  } };
  const ops = { takeover: state.takeover !== false, nativeTransactions: state.native === true, quietMs: 0,
    returnFocus: Object.hasOwn(options, 'returnFocus') ? options.returnFocus : policy(state.mode || 'origin'),
    now: () => 1000, waitForUserIdle: async () => 0, waitForHandsOff: async () => 0,
    snapshotScene: async () => { events.push('snapshot'); return { appPid: 9, chromeWindow: 99, chromeTab: 1 }; },
    mousepos: async () => ({ x: 5, y: 6 }), openSession: async () => { events.push('open'); return session; },
    userActedSince: async () => false, userClickedSince: async () => false,
    currentUrl: async () => null, navigationUntouched: async () => true,
    noteNavigation: async () => { events.push('noteNavigation'); },
    prepare: async (_pre, _scene, ctx) => {
      events.push('prepare');
      if (state.native) await ctx.bindNativeTarget(target);
      if (state.prepareFailure) throw new BridgeError('prepare_failed', 'synthetic prepare failure');
      return { chromePid: target.chromePid, cgWindow: target.cgWindow, target: { ...target }, touchesScene: true,
        windowBounds: { x: 0, y: 0, w: 1200, h: 900 } };
    },
    restoreScene: async (_scene, o = {}) => { writes.push('restoreScene'); if (state.native && o.native) await o.native({ kind: 'restoreScene' }, { policy: 'restore' }); return { ok: true, appFrontmost: true }; },
    restoreApp: async () => { writes.push('restoreApp'); return { ok: true, appFrontmost: true }; },
    warp: async () => { writes.push('fallbackWarp'); },
  };
  const action = async (_session, prep, ctx) => {
    events.push('action');
    ctx.observe(async observation => { events.push('observe'); observations.push(observation); return { out: 'observed', url: 'https://fixture.test/final' }; });
    if (state.actionError) throw new BridgeError('action_failed', 'synthetic action failure');
    if (state.userError) throw new UserInterrupted({ kind: 'key', epoch: 1000 });
    if (state.handoff) await ctx.handToHuman(state.badTarget ? { ...prep.target, tabId: 99 } : prep.target);
    state.actionDone = true;
    return 'done';
  };
  return { state, events, writes, observations, session, ops, action };
}
const noFocus = h => assert.deepEqual(h.writes, [], 'no focus write may be requested');
const closedOnce = h => assert.equal(h.state.closed, 1, 'original session closes exactly once');

await check('normalizer copies valid policy, defaults only new missing input, rejects malformed held state', () => {
  const p = policy('current'); const copy = normalizeReturnFocus(p);
  assert.deepEqual(copy, p); assert.notEqual(copy, p); p.mode = 'origin'; assert.equal(copy.mode, 'current');
  assert.deepEqual(normalizeReturnFocus(undefined, true), policy('origin', 'legacy_default'));
  for (const value of [undefined, null, {}, { mode: 'current' }, policy('bogus'), policy('current', 'bogus'), 'current']) assert.equal(normalizeReturnFocus(value), null);
});
for (const mode of ['origin', 'current']) for (const native of [false, true]) {
  await check(`${mode}/${native ? 'native' : 'held'} successful action observes and releases once`, async () => {
    const h = fixture({ mode, native }); const r = await runInputAction(h.ops, h.action);
    closedOnce(h); assert.equal(r.outcome, 'ok'); assert.equal(r.late, undefined);
    assert.equal(h.observations.length, 1); assert.equal(h.observations[0].noteable, true);
    assert.equal(h.events.filter(x => x === 'noteNavigation').length, 1);
    assert.equal(r.inputReleased, true); assert.equal(r.end.restored, true);
    if (mode === 'current') { noFocus(h); assert.equal(r.restored, false); assert.equal(r.focusRestoration, 'not_requested'); assert.equal(h.events.includes('panel:restore'), false); }
    else { assert.ok(h.writes.includes('restoreScene')); assert.ok(h.writes.includes('warp')); assert.equal(r.focusRestoration, 'requested'); }
  });
  for (const failure of ['actionError', 'prepareFailure', 'beginFailure']) await check(`${mode}/${native ? 'native' : 'held'} ${failure} preserves original error and cleanup`, async () => {
    const h = fixture({ mode, native, [failure]: true });
    const error = await runInputAction(h.ops, h.action).catch(e => e);
    assert.equal(error.code, failure === 'actionError' ? 'action_failed' : 'prepare_failed'); closedOnce(h);
    assert.equal(error.lateUser, undefined); assert.equal(h.observations.length, 0);
    if (mode === 'current') { noFocus(h); assert.equal(error.focusRestoration, 'not_requested'); }
    else assert.ok(h.writes.includes('restoreScene'), h.writes.join(','));
  });
}
for (const mode of ['origin', 'current']) for (const phase of ['userError', 'lateStatus']) await check(`${mode}/monitored ${phase} keeps real interruption and policy`, async () => {
  const h = fixture({ mode, takeover: false, [phase]: true }); const r = await runInputAction(h.ops, h.action);
  assert.equal(r.outcome, 'user'); closedOnce(h);
  if (phase === 'lateStatus') { assert.equal(r.late, true); assert.equal(h.observations.length, 1); assert.equal(h.observations[0].noteable, false); }
  if (mode === 'current') { noFocus(h); assert.equal(r.focusRestoration, 'not_requested'); assert.doesNotMatch(stopRestoreLine(r), /已把前台切回/); }
  else assert.ok(h.writes.includes('restoreApp'), h.writes.join(','));
});
for (const mode of ['origin', 'current']) await check(`${mode} kept mode is a copy and reuse overrides caller mode`, async () => {
  const h = fixture({ mode, native: true }); h.ops.keep = true;
  const supplied = h.ops.returnFocus; const first = await runInputAction(h.ops, h.action);
  assert.ok(first.kept); assert.notEqual(first.kept.returnFocus, supplied); assert.equal(h.state.closed, 0);
  supplied.mode = mode === 'current' ? 'origin' : 'current';
  assert.equal(first.kept.returnFocus.mode, mode);
  h.ops.reuse = first.kept; h.ops.returnFocus = policy(mode === 'current' ? 'origin' : 'current'); h.ops.keep = false;
  const second = await runInputAction(h.ops, h.action); closedOnce(h); assert.equal(second.returnFocus.mode, mode);
  if (mode === 'current') noFocus(h); else assert.ok(h.writes.includes('restoreScene'));
});
for (const bad of [undefined, null, {}, policy('bogus'), policy('origin', 'bogus')]) await check(`invalid kept ${JSON.stringify(bad)} never falls back to caller origin`, async () => {
  const h = fixture({ mode: 'origin' }); h.ops.keep = true; const first = await runInputAction(h.ops, h.action);
  first.kept.returnFocus = bad; h.ops.reuse = first.kept; h.ops.keep = false;
  const r = await runInputAction(h.ops, h.action); closedOnce(h); noFocus(h);
  assert.equal(r.focusRestoration, 'policy_invalid'); assert.equal(r.focusPolicyDiagnostic, 'missing_or_invalid_hold_policy');
});
for (const mode of ['origin', 'current']) for (const releaseReason of ['policy', 'human_handoff']) await check(`${mode} releaseKept ${releaseReason} preserves end facts and stored policy`, async () => {
  const h = fixture({ mode, native: true }); h.ops.keep = true; const first = await runInputAction(h.ops, h.action);
  const before = { ...first.kept.returnFocus };
  const r = await releaseKept(h.ops, first.kept, { releaseReason }); closedOnce(h);
  assert.deepEqual(first.kept.returnFocus, before); assert.equal(r.restored, true); assert.equal(r.inputReleased, true);
  assert.deepEqual(r.returnFocus, before); assert.equal(r.releaseReason, releaseReason);
  if (mode === 'current' || releaseReason === 'human_handoff') { noFocus(h); assert.equal(r.focusRestoration, 'not_requested'); }
  else assert.ok(h.writes.includes('restoreScene'));
});
for (const mode of ['origin', 'current']) for (const unhealthy of ['lost', 'stopped', 'unknown', 'revoked']) await check(`${mode} ${unhealthy} kept hold cannot write focus`, async () => {
  const h = fixture({ mode, native: true }); h.ops.keep = true; const first = await runInputAction(h.ops, h.action);
  if (unhealthy === 'unknown' || unhealthy === 'revoked') first.kept.nativeState[unhealthy] = true; else h.state[unhealthy] = true;
  await releaseKept(h.ops, first.kept); closedOnce(h); noFocus(h);
});
await check('unverified end under current does not claim release or close twice', async () => {
  const h = fixture({ mode: 'current', endFailure: true }); const r = await runInputAction(h.ops, h.action);
  closedOnce(h); noFocus(h); assert.equal(r.inputReleased, false); assert.equal(r.focusRestoration, 'not_requested');
});
for (const badTarget of [false, true]) await check(`human handoff ${badTarget ? 'rejects changed target' : 'does not require original scene window equality'}`, async () => {
  const h = fixture({ mode: 'origin', native: true, handoff: true, badTarget });
  const r = await runInputAction(h.ops, h.action).catch(e => e); closedOnce(h);
  if (badTarget) { assert.equal(r.code, 'native_target_changed'); assert.ok(h.writes.includes('restoreScene')); }
  else { assert.equal(r.outcome, 'ok'); assert.equal(r.releaseReason, 'human_handoff'); noFocus(h); }
});
await check('releaseAfter without a successful handoff marker retains origin restoration', async () => {
  const h = fixture({ mode: 'origin', native: true }); h.ops.releaseAfter = true;
  const r = await runInputAction(h.ops, h.action); assert.equal(r.releaseReason, 'policy'); assert.ok(h.writes.includes('restoreScene'));
});
for (const mode of ['origin', 'current']) await check(`${mode} guard after-action offer is policy gated`, async () => {
  const h = fixture({ mode }); let offered = 0, committed = 0;
  h.ops.handoff = async () => { offered++; return { to: 'peer', commit: async () => committed++ }; };
  const r = await runInputAction(h.ops, h.action); closedOnce(h);
  assert.equal(offered, mode === 'origin' ? 1 : 0); assert.equal(committed, offered);
  if (mode === 'current') noFocus(h); else assert.equal(r.handedOver, 'peer');
  assert.equal(h.observations.length, 1);
});

async function claimedHandoff(variant, run = runInputAction) {
  const h = fixture({ mode: 'origin', native: true, endFailure: variant === 'missing_end',
    endVariant: ['interrupted', 'session_interrupted'].includes(variant) ? variant : 'healthy' });
  const close = h.session.close, failure = Object.assign(Error('owner write failed'), { code: 'EIO' });
  let committed = 0, cancelled = 0;
  h.session.close = async () => {
    const end = await close();
    if (['esc', 'shake', 'caller', 'caller_cancel', 'routine'].includes(variant)) Object.assign(end.takeover, { aborted: true, abortedBy: variant });
    if (variant === 'failed_end') end.ok = false;
    if (variant === 'active_end') end.takeover.active = true;
    if (variant === 'missing_takeover') delete end.takeover;
    return end;
  };
  h.ops.handoff = async () => ({ to: 'peer',
    ...(variant === 'offer_stopped' ? { stopped: true, terminalStop: true } : {}),
    commit: async () => { committed++; if (variant === 'commit_error') throw failure; },
    cancel: async () => { cancelled++; return { cancelled: true }; } });
  const r = await run(h.ops, h.action).catch(error => error);
  const allowed = ['healthy', 'caller', 'caller_cancel'].includes(variant);
  closedOnce(h); noFocus(h); assert.equal(h.events.filter(x => x === 'action').length, 1);
  assert.equal(committed, allowed || variant === 'commit_error' ? 1 : 0);
  assert.equal(cancelled, allowed ? 0 : 1);
  if (allowed) { assert.equal(r.handedOver, 'peer'); assert.equal(r.outcome, variant === 'healthy' ? 'ok' : 'user'); }
  else { assert.equal(r.handedOver, undefined); assert.equal(r.noRetry, true); assert.equal(r.terminalInterrupted, true); }
  if (variant === 'commit_error') assert.equal(r, failure, 'original commit failure survives');
  assert.equal(h.events.filter(x => x === 'noteNavigation').length, variant === 'healthy' ? 1 : 0);
}
for (const variant of ['healthy', 'caller', 'caller_cancel', 'esc', 'shake', 'routine', 'interrupted',
  'session_interrupted', 'missing_end', 'failed_end', 'active_end', 'missing_takeover', 'offer_stopped', 'commit_error'])
  await check(`claimed handoff terminal boundary ${variant}`, () => claimedHandoff(variant));

// R2: every pre-close status stays healthy. Only the terminal reply changes.
for (const endVariant of ['healthy', 'aborted', 'interrupted', 'session_interrupted']) {
  await check(`terminal-only ${endVariant} human marker preserves cleanup and blocks attribution`, async () => {
    const h = fixture({ mode: 'origin', native: true, handoff: true, endVariant });
    const r = await runInputAction(h.ops, h.action);
    closedOnce(h); noFocus(h);
    assert.equal(r.inputReleased, true, 'confirmed physical release is separate from terminal interruption');
    assert.equal(r.releaseReason, 'human_handoff'); assert.equal(r.end.restored, true);
    assert.equal(r.outcome, endVariant === 'healthy' ? 'ok' : 'user', 'terminal interruption cannot complete human handoff');
    assert.equal(h.observations.length, 1);
    assert.equal(h.observations[0].noteable, endVariant === 'healthy');
    assert.equal(h.events.filter(x => x === 'noteNavigation').length, endVariant === 'healthy' ? 1 : 0);
  });
}
for (const mode of ['origin', 'current']) await check(`${mode} timing exposes only restoration actually requested`, async () => {
  const h = fixture({ mode, native: true }); const r = await runInputAction(h.ops, h.action);
  if (mode === 'origin') assert.ok(r.timing.handBack);
  else { noFocus(h); assert.equal(r.timing.handBack, undefined, 'current must not manufacture a handBack timestamp'); }
});

for (const endVariant of ['healthy', 'aborted', 'interrupted', 'session_interrupted']) for (const mode of ['origin', 'current']) {
  await check(`releaseKept ${mode}/${endVariant} exposes terminal evidence without changing release facts`, async () => {
    const h = fixture({ mode, native: true }); h.ops.keep = true;
    const first = await runInputAction(h.ops, h.action); h.state.endVariant = endVariant;
    const r = await releaseKept(h.ops, first.kept, { releaseReason: 'human_handoff' });
    closedOnce(h); noFocus(h); assert.equal(r.inputReleased, true); assert.equal(r.restored, true);
    assert.equal(r.terminalInterrupted, endVariant !== 'healthy'); assert.equal(r.releaseReason, 'human_handoff');
    if (endVariant !== 'healthy') assert.equal(r.noRetry, true);
    if (endVariant === 'aborted') assert.equal(r.terminalAbortedBy, 'esc');
    if (endVariant.includes('interrupted')) assert.equal(r.interrupted.kind, 'key');
  });
}
for (const endFailure of [false, true]) await check(`terminal close preserves a prior error and ${endFailure ? 'unconfirmed' : 'confirmed'} release`, async () => {
  const h = fixture({ mode: 'origin', native: true, endVariant: 'session_interrupted', endFailure });
  const originalError = new BridgeError('fixture_action_error', 'original error after marker');
  const error = await runInputAction(h.ops, async (_session, prep, ctx) => { await ctx.handToHuman(prep.target); throw originalError; }).catch(e => e);
  assert.equal(error, originalError); assert.equal(error.code, 'fixture_action_error'); assert.equal(error.noRetry, true);
  assert.equal(error.terminalInterrupted, true); assert.equal(error.interrupted.kind, 'key');
  assert.equal(error.releaseReason, 'human_handoff'); assert.equal(error.inputReleased, !endFailure); closedOnce(h); noFocus(h);
});
for (const mode of ['origin', 'current']) await check(`${mode} ordinary terminal interruption never writes after close`, async () => {
  const h = fixture({ mode, native: true, endVariant: 'interrupted' }); let writesAtClose;
  const close = h.session.close; h.session.close = async () => { writesAtClose = h.writes.length; return close(); };
  const r = await runInputAction(h.ops, h.action);
  assert.equal(r.outcome, 'user'); assert.equal(r.terminalInterrupted, true); assert.equal(r.inputReleased, true);
  assert.equal(h.writes.length, writesAtClose); assert.equal(h.observations[0].noteable, false); closedOnce(h);
  if (mode === 'current') noFocus(h); else assert.ok(h.writes.includes('restoreScene'), 'origin restoration completed before terminal evidence arrived');
});

for (const endVariant of ['healthy', 'aborted', 'interrupted', 'session_interrupted']) await check(`nonwatching ${endVariant} end gates legacy fallback without losing healthy recovery`, async () => {
  const h = fixture({ mode: 'origin', native: false, takeover: false, statusMissingAfterAction: true, endVariant });
  const r = await runInputAction(h.ops, h.action); closedOnce(h);
  if (endVariant === 'healthy') { assert.equal(r.outcome, 'ok'); assert.ok(h.writes.includes('restoreScene')); }
  else { assert.equal(r.outcome, 'user'); assert.equal(r.terminalInterrupted, true); assert.equal(r.noRetry, true); noFocus(h); }
  assert.equal(h.observations[0].noteable, endVariant === 'healthy');
});

for (const endVariant of ['interrupted', 'aborted']) await check(`known key plus ${endVariant} end preserves only permitted guarded app recovery`, async () => {
  const h = fixture({ mode: 'origin', native: false, takeover: false, userError: true, endVariant });
  const r = await runInputAction(h.ops, h.action); closedOnce(h); assert.equal(r.outcome, 'user');
  if (endVariant === 'interrupted') assert.deepEqual(h.writes, ['restoreApp'], 'ordinary known key keeps its A3 guarded app hand-back');
  else { assert.equal(r.terminalAborted, true); noFocus(h); }
});
await check('original action error plus end-only Stop never enters nonwatching recovery', async () => {
  const h = fixture({ mode: 'origin', native: false, takeover: false, statusMissingAfterAction: true, endVariant: 'aborted' });
  const originalError = new BridgeError('fixture_action_error', 'original error before close');
  const error = await runInputAction(h.ops, async () => { h.state.actionDone = true; throw originalError; }).catch(e => e);
  assert.equal(error, originalError); assert.equal(error.code, 'fixture_action_error'); assert.equal(error.noRetry, true);
  assert.equal(error.terminalAborted, true); assert.equal(error.inputReleased, true); closedOnce(h); noFocus(h);
});

// Valid module mutants are executed with the same semantic oracles. Import or
// fixture errors never count as kills; every negative must be ERR_ASSERTION.
async function mutant(name, from, to, oracle) {
  assert.equal(original.split(from).length - 1, 1, `${name} mutation anchor is unique`);
  const edited = original.replace(from, to).replace("from './bridge.js'", `from ${JSON.stringify(new URL('../src/bridge.js', import.meta.url).href)}`);
  const mod = await import('data:text/javascript;base64,' + Buffer.from(edited).toString('base64'));
  await oracle({ runInputAction, releaseKept });
  await assert.rejects(oracle(mod), e => e.code === 'ERR_ASSERTION', `${name} must fail its semantic assertion`);
  killed++; console.log(`mutant ${killed} ${name}`);
}
// Mutation anchors are fixed only after the corresponding production function
// exists; they remove one meaningful condition or propagation field, never an import.
const keepLine = original.split('\n').filter(x => x.includes('kept: { session, scene, pointer') && x.includes('returnFocus: normalizeReturnFocus(returnFocus)'));
assert.equal(keepLine.length, 2, 'both private and ordinary kept constructors carry policy');
await check('valid ordinary kept propagation mutant loses current policy evidence', async () => {
  const from = keepLine[1];
  await mutant('ordinary kept policy dropped', from + '\n    }', from.replace(', returnFocus: normalizeReturnFocus(returnFocus)', '') + '\n    }', async mod => {
    const h = fixture({ mode: 'current' }); h.ops.keep = true;
    const r = await mod.runInputAction(h.ops, h.action); assert.deepEqual(r.kept.returnFocus, policy('current'));
  });
});
await check('valid current offer mutant exposes forbidden transfer', async () => {
  await mutant('current offer allowed', 'if (restoreRequested && ops.handoff && !ops.keep', 'if (ops.handoff && !ops.keep', async mod => {
    const h = fixture({ mode: 'current' }); let offered = 0; h.ops.handoff = async () => { offered++; return null; };
    await mod.runInputAction(h.ops, h.action); assert.equal(offered, 0);
  });
});

async function privateKeep(mod) {
  const h = fixture({ mode: 'current', native: true }); h.ops.keep = true;
  const first = await mod.runInputAction(h.ops, h.action);
  const auto = { kept: first.kept, session: h.session, epoch: 1, target, attemptBudget: 1, noRetarget: true, check() {} };
  h.ops.reuse = first.kept; h.ops.pagePromptAuto = auto;
  h.ops.prepare = async () => ({ target: { ...target }, chromePid: target.chromePid, cgWindow: target.cgWindow, touchesScene: false });
  const next = await mod.runInputAction(h.ops, async () => 'private result');
  assert.deepEqual(next.kept.returnFocus, policy('current')); assert.notEqual(next.kept.returnFocus, first.kept.returnFocus);
  noFocus(h); assert.equal(h.state.closed, 0); return { h, first, next };
}
await check('private auto keeps a separate policy copy without expanding handoff capability', async () => {
  const { h, first, next } = await privateKeep({ runInputAction });
  h.ops.reuse = next.kept; h.ops.pagePromptAuto.kept = next.kept;
  await assert.rejects(runInputAction(h.ops, async (_session, _prep, ctx) => ctx.handToHuman(target)), e => e.code === 'page_auto_handoff_forbidden');
  assert.equal(next.kept.returnFocus.mode, 'current'); assert.equal(first.kept.returnFocus.mode, 'current'); noFocus(h); assert.equal(h.state.closed, 0);
});
await check('valid private kept propagation mutant loses copied current policy', async () => {
  const from = keepLine[0] + '\n    if (healthy && err';
  await mutant('private kept policy dropped', from, from.replace(', returnFocus: normalizeReturnFocus(returnFocus)', ''), privateKeep);
});
await check('valid unconditional origin decision mutant performs forbidden current focus writes', async () => {
  await mutant('restore decision ignores current', "let restoreRequested = returnFocus?.mode === 'origin';", 'let restoreRequested = true;', async mod => {
    const h = fixture({ mode: 'current' }); await mod.runInputAction(h.ops, h.action); noFocus(h);
  });
});
await check('valid skip-observer mutant cannot make a current action look complete', async () => {
  await mutant('current final observation skipped', 'await observe(!late, closedAt ?? ops.now());', 'if (restoreRequested) await observe(!late, closedAt ?? ops.now());', async mod => {
    const h = fixture({ mode: 'current' }); await mod.runInputAction(h.ops, h.action); assert.equal(h.observations.length, 1);
  });
});
await check('valid missing return policy fallback mutant is rejected by actual reuse behavior', async () => {
  await mutant('missing reused policy becomes new origin', 'normalizeReturnFocus(ops.reuse ? ops.reuse.returnFocus : ops.returnFocus, !ops.reuse)',
    'normalizeReturnFocus(ops.reuse?.returnFocus || ops.returnFocus, true)', async mod => {
      const h = fixture({ mode: 'origin' }); h.ops.keep = true; const first = await mod.runInputAction(h.ops, h.action);
      delete first.kept.returnFocus; h.ops.reuse = first.kept; h.ops.keep = false;
      await mod.runInputAction(h.ops, h.action); noFocus(h);
    });
});
await check('valid handBackApp leak mutant is rejected during a real current interruption', async () => {
  await mutant('current user branch restores app', '!restoreRequested || focus.blockRecovery || ops.takeover ? null : await handBackApp', 'focus.blockRecovery || ops.takeover ? null : await handBackApp', async mod => {
    const h = fixture({ mode: 'current', takeover: false, userError: true }); const r = await mod.runInputAction(h.ops, h.action); assert.equal(r.outcome, 'user'); noFocus(h);
  });
});
await check('valid false-late mutant is rejected after current scene-changing prepare failure', async () => {
  await mutant('skipped prepare restore becomes late', '(!healthy || (restoreRequested && !sceneRestored))', '(!healthy || !sceneRestored)', async mod => {
    const h = fixture({ mode: 'current', prepareFailure: true }); const e = await mod.runInputAction(h.ops, h.action).catch(e => e);
    assert.equal(e.code, 'prepare_failed'); assert.equal(e.lateUser, undefined);
  });
});
await check('new legacy call defaults origin, while direct missing kept release reports invalid policy', async () => {
  const h = fixture({ returnFocus: undefined }); h.ops.keep = true; const first = await runInputAction(h.ops, h.action);
  assert.deepEqual(first.kept.returnFocus, policy('origin', 'legacy_default')); delete first.kept.returnFocus;
  const r = await releaseKept(h.ops, first.kept); noFocus(h); closedOnce(h); assert.equal(r.focusRestoration, 'policy_invalid'); assert.equal(r.inputReleased, true);
});

await check('valid terminal-evidence-dropping mutant cannot make close-only Stop a successful handoff', async () => {
  await mutant('terminal evidence ignored', 'const terminalInterrupted = !!(interrupted || aborted);', 'const terminalInterrupted = false;', async mod => {
    const h = fixture({ mode: 'origin', native: true, handoff: true, endVariant: 'aborted' });
    const r = await mod.runInputAction(h.ops, h.action);
    assert.equal(r.outcome, 'user', 'end-only Stop remains an interruption');
    assert.equal(h.observations[0].noteable, false); assert.equal(r.noRetry, true); closedOnce(h); noFocus(h);
  });
});

await check('valid post-close recovery-gate mutant cannot restore after terminal Stop', async () => {
  await mutant('nonwatching recovery ignores terminal boundary',
    'restoreRequested && !focus.blockRecovery && !late && scene && touched && !sceneRestored && !ops.takeover && !ops.nativeTransactions',
    'restoreRequested && !late && scene && touched && !sceneRestored && !ops.takeover && !ops.nativeTransactions', async mod => {
      const h = fixture({ mode: 'origin', native: false, takeover: false, statusMissingAfterAction: true, endVariant: 'aborted' });
      const r = await mod.runInputAction(h.ops, h.action); assert.equal(r.outcome, 'user'); closedOnce(h); noFocus(h);
    });
});


for(const endVariant of ['aborted','interrupted','session_interrupted'])await check(`origin ${endVariant} terminal result retains known pre-close restoration facts`,async()=>{
  const h=fixture({mode:'origin',native:true,endVariant});let writesAtClose;
  const close=h.session.close;h.session.close=async()=>{writesAtClose=h.writes.length;return close();};
  const r=await runInputAction(h.ops,h.action);assert.equal(r.outcome,'user');assert.equal(r.terminalInterrupted,true);
  assert.equal(r.sceneRestored,true,'completed origin scene restoration must survive terminal classification');
  assert.equal(r.restore.ok,true);assert.ok(h.writes.includes('restoreScene'));assert.ok(h.writes.includes('warp'));
  assert.equal(h.writes.length,writesAtClose);closedOnce(h);
});
await check('valid origin-restoration-facts-dropping mutant cannot erase completed restoration at close',async()=>{
  await mutant('normal return drops completed origin restoration','restored: restoreRequested, sceneRestored, appRestored, steps','restored: restoreRequested, steps',async mod=>{
    const h=fixture({mode:'origin',native:true,endVariant:'aborted'});const r=await mod.runInputAction(h.ops,h.action);
    assert.equal(r.sceneRestored,true);assert.ok(h.writes.includes('restoreScene'));closedOnce(h);
  });
});


for(const native of [false,true])for(const endVariant of ['healthy','aborted','interrupted','session_interrupted'])await check(`original error ${native?'native':'held'}/${endVariant} retains pre-close restoration evidence`,async()=>{
  const h=fixture({mode:'origin',native,endVariant});const originalError=new BridgeError('fixture_action_error','original callback error must survive');
  let writesAtClose;const close=h.session.close;h.session.close=async()=>{writesAtClose=h.writes.length;return close();};
  const error=await runInputAction(h.ops,async()=>{throw originalError;}).catch(e=>e);
  assert.equal(error,originalError);assert.equal(error.code,'fixture_action_error');assert.equal(error.message,'original callback error must survive');
  assert.ok(h.writes.includes('restoreScene'));assert.ok(h.writes.includes('warp'));assert.equal(h.writes.length,writesAtClose);closedOnce(h);
  assert.equal(error.inputReleased,true);assert.equal(error.terminalInterrupted,endVariant!=='healthy');
  if(endVariant!=='healthy'){assert.equal(error.sceneRestored,true,'known scene restoration must remain on the original thrown error');assert.equal(error.noRetry,true);}
});
await check('original error terminal facts never infer successful restoration from policy or clipboard',async()=>{
  const h=fixture({mode:'origin',native:true,endVariant:'interrupted'});h.ops.restoreScene=async()=>({ok:false});
  const originalError=new BridgeError('fixture_action_error','unconfirmed scene');const error=await runInputAction(h.ops,async()=>{throw originalError;}).catch(e=>e);
  assert.equal(error,originalError);assert.equal(error.sceneRestored,false);assert.equal(error.terminalInterrupted,true);assert.equal(error.inputReleased,true);closedOnce(h);
});


await check('valid original-error-restoration-facts-dropping mutant cannot erase confirmed scene recovery',async()=>{
  await mutant('terminal thrown error drops recorded restoration','if (focus.terminal.terminalInterrupted) Object.assign(err, { sceneRestored, appRestored });',
    'if (false) Object.assign(err, { sceneRestored, appRestored });',async mod=>{
      const h=fixture({mode:'origin',native:true,endVariant:'interrupted'});const originalError=new BridgeError('fixture_action_error','original error');
      const error=await mod.runInputAction(h.ops,async()=>{throw originalError;}).catch(e=>e);
      assert.equal(error,originalError);assert.equal(error.sceneRestored,true);assert.equal(error.terminalInterrupted,true);closedOnce(h);
    });
});

// Known interruption provenance uses value snapshots of each raw source. A
// matching first event does not conceal a later reported identity or button.
async function knownInterruptionGuard(variant = 'repeat', run = runInputAction) {
  const h = fixture({ mode: 'origin', takeover: false });
  h.ops.nativeTransactions = true; // Match production monitored input routing.
  const known = { kind: 'move', t: 12.5, epoch: 1000, button: false };
  const altered = variant === 'missing-epoch' ? { kind: 'move', t: 12.5, button: false }
    : variant === 'missing-kind' ? { t: 12.5, epoch: 1000, button: false }
    : variant === 'invalid-kind' ? { ...known, kind: 'not-a-native-event' }
    : variant === 'string-time' ? { ...known, t: '12.5' }
    : variant === 'infinite-epoch' ? { ...known, epoch: Infinity } : known;
  let shared = null, writesAtClose = null;
  h.ops.preflight = async () => ({ session: target });
  const request = h.session.request;
  h.session.request = async req => {
    if (req.op !== 'status') return request(req);
    h.events.push('status');
    if (variant === 'mutable-all' && !h.state.actionDone) return { ok: true, epoch: 1, takeover: { active: false } };
    shared ||= { ...altered };
    const reported = variant === 'mutable-all' ? shared : { ...altered };
    h.session.interrupted = variant === 'mutable-all' ? shared
      : variant === 'pre-conflict' ? { ...known, epoch: 999, t: 11 } : { ...altered };
    return { ok: true, epoch: 1, interrupted: reported, takeover: { active: false } };
  };
  h.session.close = async () => {
    h.events.push('close'); h.state.closed++; writesAtClose = h.writes.length;
    const stickyBefore = h.session.interrupted;
    let endEvent = variant === 'no-echo' ? null : { ...altered };
    if (variant === 'end-earlier') endEvent = { ...known, epoch: 999, t: 11 };
    if (variant === 'end-button') endEvent.button = true;
    if (variant === 'session-earlier') h.session.interrupted = { ...known, epoch: 999, t: 11 };
    else if (variant === 'session-undefined') h.session.interrupted = undefined;
    else if (variant === 'session-null') h.session.interrupted = null;
    else if (variant === 'mutable-all') { shared.button = true; endEvent = shared; }
    else if (!['end-omitted-sticky', 'end-null-sticky'].includes(variant)) h.session.interrupted = endEvent && { ...endEvent };
    const end = { ok: true, restored: true, interrupted: endEvent,
      takeover: { active: false, ...(variant === 'abort' ? { aborted: true, abortedBy: 'shake' } : {}) } };
    if (variant === 'end-omitted-sticky') { delete end.interrupted; assert.equal(Object.hasOwn(end, 'interrupted'), false); }
    if (variant === 'end-null-sticky') { end.interrupted = null; assert.equal(Object.hasOwn(end, 'interrupted'), true); assert.equal(end.interrupted, null); }
    if (['end-omitted-sticky', 'end-null-sticky'].includes(variant)) {
      assert.equal(h.session.interrupted, stickyBefore, 'missing END evidence leaves the Session getter sticky');
      assert.deepEqual(h.session.interrupted, known);
    }
    if (['session-undefined', 'session-null'].includes(variant)) {
      assert.deepEqual(end.interrupted, known, 'inverse omission retains the independent complete END record');
      assert.equal(h.session.interrupted, variant === 'session-null' ? null : undefined);
    }
    return end;
  };
  const r = await run(h.ops, async () => { h.events.push('action'); h.state.actionDone = true; });
  closedOnce(h); assert.equal(r.outcome, 'user'); assert.deepEqual(r.sent, []);
  assert.equal(h.writes.length, writesAtClose); noFocus(h);
  if (variant === 'repeat') {
    assert.equal(r.terminalInterrupted, false, 'same complete pre-input event is a repeat, not terminal evidence');
    assert.equal(r.noRetry, undefined); assert.equal(h.events.includes('action'), false);
  } else {
    assert.equal(r.terminalInterrupted, true, `${variant} must remain terminal`); assert.equal(r.noRetry, true);
    assert.equal(h.events.includes('action'), variant === 'mutable-all');
  }
  return { h, r };
}
for (const variant of ['repeat', 'no-echo', 'pre-conflict', 'end-earlier', 'session-earlier', 'end-button', 'mutable-all',
  'abort', 'missing-epoch', 'missing-kind', 'invalid-kind', 'string-time', 'infinite-epoch'])
  await check(`actual guard known interruption provenance ${variant}`, () => knownInterruptionGuard(variant));
for (const variant of ['end-omitted-sticky', 'end-null-sticky', 'session-undefined', 'session-null'])
  await check(`R2 actual guard requires both post-close identity sources ${variant}`, () => knownInterruptionGuard(variant));

for (const variant of ['sent', 'unknown', 'late']) await check(`known pre-close evidence retains ${variant} protection`, async () => {
  const h = fixture({ mode: 'current', takeover: false }); h.ops.nativeTransactions = true;
  const known = { kind: 'move', t: 12.5, epoch: 1000, button: false };
  let completed = false, postStatuses = 0, originalError = null;
  const request = h.session.request;
  h.session.request = async req => {
    if (req.op !== 'status' || !completed) return request(req);
    h.events.push('status');
    const interrupted = variant === 'late' && ++postStatuses === 1 ? null : { ...known };
    if (interrupted) h.session.interrupted = { ...interrupted };
    return { ok: true, epoch: 1, interrupted, takeover: { active: false } };
  };
  h.session.close = async () => { h.state.closed++; h.events.push('close');
    h.session.interrupted = { ...known }; return { ok: true, interrupted: { ...known }, takeover: { active: false } }; };
  const result = await runInputAction(h.ops, async (_session, _prep, ctx) => {
    completed = true;
    if (variant === 'late') return 'completed before the late event';
    h.session.interrupted = { ...known };
    originalError = new UserInterrupted({ ...known });
    if (variant === 'sent') ctx.sent('keys');
    else Object.assign(originalError, { inputDelivery: 'unknown', noRetry: true });
    throw originalError;
  }).catch(error => error);
  closedOnce(h); noFocus(h); assert.equal(result.noRetry, true); assert.equal(result.terminalInterrupted, true);
  if (variant === 'unknown') { assert.equal(result, originalError); assert.equal(result.inputDelivery, 'unknown'); }
  else if (variant === 'sent') assert.deepEqual(result.sent, ['keys']);
  else { assert.equal(result.late, true); assert.equal(result.out, 'completed before the late event'); }
});

const provenanceMutants = [
  ['known repeat becomes terminal',
    'if (retryBeforeInput && confirmedEnd && !focus.terminal.terminalAborted && postSources.every(Boolean) && repeated(true))',
    'if (false)', 'repeat'],
  ['raw pre-close disagreement ignored',
    'before.every(x => sameInterruption(before[0], x, complete)) &&',
    'true &&', 'pre-conflict'],
  ['raw post-close disagreement ignored',
    'after.every(x => sameInterruption(before[0], x, complete));',
    'true;', 'end-earlier'],
  ['button escalation ignored',
    "return (a.button === true || a.kind === 'button') === (b.button === true || b.kind === 'button');",
    'return true;', 'end-button'],
  ['Stop omitted from retry exception',
    'retryBeforeInput && confirmedEnd && !focus.terminal.terminalAborted && postSources.every(Boolean) && repeated(true)',
    'retryBeforeInput && confirmedEnd && postSources.every(Boolean) && repeated(true)', 'abort'],
  ['pre-close snapshot retains mutable references',
    '.filter(Boolean).map(x => Object.freeze({ ...x }));',
    '.filter(Boolean).map(x => x);', 'mutable-all'],
  ['weaker recovery identity grants retry',
    '&& repeated(true))', '&& repeated(false))', 'missing-epoch'],
  ['malformed reported record discarded',
    'mergeInterrupted(reported) || reported.find(Boolean) || null',
    'mergeInterrupted(reported)', 'missing-kind'],
  ['missing post-close identity accepted',
    '(!confirmedEnd || (userInterruption && !after.length))',
    '(!confirmedEnd)', 'no-echo'],
];
for (const [name, from, to, variant] of provenanceMutants)
  await check(`valid known-interruption mutant ${name}`, () =>
    mutant(name, from, to, mod => knownInterruptionGuard(variant, mod.runInputAction)));

// Match the independent pre-begin safety oracle: an ordinary unsent failure
// may retain legacy user-attribution, but existing safety flags cannot be lost.
async function prebeginSafetyFlag(flag, run = runInputAction) {
  const originalError = Object.assign(new Error('original preparation refusal'),
    { code: 'user_busy', by: 'original-cause', ...(flag ? { [flag]: true } : {}) });
  const effects = [];
  const ops = { takeover: false, returnFocus: { mode: 'current', source: 'explicit' }, waitForUserIdle: async () => 0, now: () => 1000,
    snapshotScene: async () => ({ appPid: 1 }), mousepos: async () => ({ x: 1, y: 1 }), userActedSince: async () => true,
    openSession: async () => { effects.push('open'); throw Error('unexpected Session'); },
    prepare: async () => { throw originalError; }, restoreScene: async () => { effects.push('restore'); }, warp: async () => effects.push('warp') };
  let thrown = null;
  const result = await run(ops, async () => effects.push('input')).catch(error => { thrown = error; return null; });
  assert.deepEqual(effects, []);
  if (flag) { assert.equal(thrown, originalError, 'pre-begin safety refusal must preserve the original error'); assert.equal(thrown[flag], true); }
  else { assert.equal(thrown, null); assert.equal(result.outcome, 'user'); assert.equal(result.error.cause, originalError); }
}
for (const flag of [null, 'noRetry', 'terminalInterrupted', 'terminalAborted'])
  await check(`R2 actual pre-begin ${flag || 'unflagged legacy'} refusal preserves attribution`, () => prebeginSafetyFlag(flag));
await check('valid R2 independent post-source proof omission mutant cannot accept a sticky getter alone', () =>
  mutant('independent post-source proof omitted', 'postSources.every(Boolean) && ', '',
    mod => knownInterruptionGuard('end-omitted-sticky', mod.runInputAction)));
await check('valid R2 pre-begin flag veto omission mutant cannot replace an existing safety refusal', () =>
  mutant('pre-begin safety flag veto omitted',
    'e.noRetry !== true &&\n        e.terminalInterrupted !== true && e.terminalAborted !== true && ', '',
    async mod => { for (const flag of ['noRetry', 'terminalInterrupted', 'terminalAborted']) await prebeginSafetyFlag(flag, mod.runInputAction); }));

console.log(JSON.stringify({ checks, mutants: killed, failures: failures.length }));
if (failures.length) process.exitCode = 1;
