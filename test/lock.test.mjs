#!/usr/bin/env node
/* Cross-process input lock: N real processes contend; their critical sections
 * must never overlap. Also proves the overlap check itself fires (run once
 * with the lock bypassed) and that a dead holder's lock is taken over. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as filesystem from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_JS = path.join(HERE, '..', 'src', 'lock.js');

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

/* Children for the queue and hand-over cases (each prints one JSON line). */
if (process.argv[2] === 'fifo') {
  // Wait `delay`, take a ticket, hold the lock `hold` ms: [asked, got, done].
  const [delay, hold] = process.argv.slice(3).map(Number);
  const { withInputLock } = await import(LOCK_JS);
  await sleepMs(delay);
  const asked = Date.now();
  const span = (await withInputLock('fifo', async () => { const got = Date.now(); await sleepMs(hold); return [asked, got, Date.now()]; },
    { info: { who: `w${delay}`, task: 't' } })).result;
  process.stdout.write(JSON.stringify(span));
  process.exit(0);
}
if (process.argv[2] === 'giver') {
  // Hold the lock; once someone waits, offer it; `die` exits after a claim without writing the waiter in;
  // `hb`: a heartbeat every 2 ms, racing the hand-over's write of the next owner.
  const mode = process.argv[3] || '';
  const L = await import(LOCK_JS);
  const out = await L.withInputLock('giver', async (turn) => {
    for (let i = 0; i < 200 && !(await L.queueList()).length; i++) await sleepMs(20);
    const t0 = Date.now();
    const h = await turn.offer({ scene: { appPid: 9, chromeTab: 5 }, pointer: { x: 1, y: 2 }, touched: true });
    if (h && mode === 'die') process.exit(0);
    if (h) { await sleepMs(50); await h.commit(); }
    // `slow`: putting things back takes a while after a withdrawn offer, the lock still held.
    if (!h && mode === 'slow') await sleepMs(800);
    return { taken: !!(h && h.commit), to: h ? h.to : null, offerMs: Date.now() - t0 };
  }, { info: { who: 'giver' }, ...(mode === 'hb' ? { heartbeatMs: 2 } : {}) });
  process.stdout.write(JSON.stringify(out.result));
  process.exit(0);
}
if (process.argv[2] === 'taker') {
  // Wait (able to take a hand-over unless `plain`); claim after `delay` ms; report what this turn got.
  const [delay, plain] = [Number(process.argv[3] || 0), process.argv[4] === 'plain'];
  const L = await import(LOCK_JS);
  let actions = 0, attempts = 0;
  const r = await L.withInputLock('taker', async (turn) => {
    attempts++;
    if (turn && turn.handoff) {
      await sleepMs(delay);
      if (!await turn.claim()) { const e = new Error('withdrawn'); e.code = 'handoff_lost'; throw e; }
    }
    actions++;
    const own = JSON.parse(await readFile(path.join(L.LOCK_DIR, 'owner.json'), 'utf8'));
    await sleepMs(100);
    return { handoff: turn ? turn.handoff : null, ownsLock: own.token === turn.token, pid: process.pid };
  }, { inherit: !plain, info: { who: 'taker', task: 'export' } }).catch(error => ({ error }));
  if (r.error) {
    process.stdout.write(JSON.stringify({ code: r.error.code, noRetry: r.error.noRetry, terminalInterrupted: r.error.terminalInterrupted, actions, attempts }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ ...r.result, inherited: r.inherited }));
  process.exit(0);
}

if (process.argv[2] === 'oldserver') {
  // An older server build: no ticket, just mkdir + owner.json; holds `hold` ms once it gets in.
  const hold = Number(process.argv[3] || 1000);
  const { LOCK_DIR } = await import(LOCK_JS);
  for (;;) {
    try { await mkdir(LOCK_DIR); break; } catch (e) { if (e.code === 'ENOENT') await mkdir(path.dirname(LOCK_DIR), { recursive: true }); else await sleepMs(20); }
  }
  await writeFile(path.join(LOCK_DIR, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now(), label: 'old', token: `old-${process.pid}` }));
  const got = Date.now();
  await sleepMs(hold);
  const { rm } = await import('node:fs/promises');
  await rm(LOCK_DIR, { recursive: true, force: true });
  process.stdout.write(JSON.stringify([got, Date.now()]));
  process.exit(0);
}
if (process.argv[2] === 'patient') {
  // Wait with a short no-progress limit `stall` ms: [ok, code, waited].
  const stall = Number(process.argv[3]);
  const { withInputLock } = await import(LOCK_JS);
  const t0 = Date.now();
  try { await withInputLock('patient', async () => {}, { timeoutMs: stall }); process.stdout.write(JSON.stringify([true, null, Date.now() - t0])); }
  catch (e) { process.stdout.write(JSON.stringify([false, e.code, Date.now() - t0])); }
  process.exit(0);
}

if (process.argv[2] === 'child') {
  const bypass = process.argv[3] === 'bypass';
  const { withInputLock } = await import(LOCK_JS);
  const body = async () => {
    const t0 = Date.now();
    await new Promise(r => setTimeout(r, 150));
    return [t0, Date.now()];
  };
  const span = bypass ? await body() : (await withInputLock('test', body)).result;
  process.stdout.write(JSON.stringify(span));
  process.exit(0);
}

function runChildren(n, lockPath, mode = '') {
  return Promise.all(Array.from({ length: n }, () => new Promise((res, rej) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', mode],
      { env: { ...process.env, CHROME_BRIDGE_LOCK: lockPath } });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('exit', code => code === 0 ? res(JSON.parse(out)) : rej(new Error('child failed')));
  })));
}

function overlaps(spans) {
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  let n = 0;
  for (let i = 1; i < s.length; i++) if (s[i][0] < s[i - 1][1]) n++;
  return n;
}


// Terminal retry policy runs the actual withInputLock/makeTurn functions with
// inert acquire/claim/heartbeat effects. It cannot touch the shared lock root.
const terminalLockSource=await readFile(LOCK_JS,'utf8');
function terminalLockFunction(name,code=terminalLockSource){
  const start=code.search(new RegExp(`(?:async )?function ${name}\\(`));assert.ok(start>=0,name);
  return code.slice(start,code.indexOf('\n}',start)+2);
}
async function terminalLockConsumer(flag=null,code=terminalLockSource){
  const counts={acquire:0,remove:0,heartbeat:0,release:0,attempts:0};
  const ticket={remove:async()=>counts.remove++};
  const c=vm.createContext({Error,Date,lease:null,TURN_TIMEOUT_MS:100,HEARTBEAT_MS:100,HEARTBEAT_CAP_MS:100,
    acquire:async(_label,_timeout,options)=>{
      if(++counts.acquire===1)return {token:'first',handoff:{offer:{scene:null},ticket}};
      if(options.ticket)await options.ticket.remove();return {token:'second'};
    },
    claim:async()=>false,offer:async()=>null,startHeartbeat:()=>({stop:async()=>counts.heartbeat++}),
    release:async()=>counts.release++,cancelledError:()=>Object.assign(Error('cancelled'),{code:'cancelled'})});
  vm.runInContext(['makeTurn','withInputLock'].map(name=>terminalLockFunction(name,code)).join('\n'),c);
  const error=Object.assign(Error('inert withdrawn claim'),{code:'handoff_lost',...(flag?{[flag]:true}:{})});
  const result=await c.withInputLock('inert terminal retry',async()=>{if(++counts.attempts===1)throw error;return 'healthy retry';},{inherit:true}).catch(e=>e);
  if(!flag){assert.equal(result.result,'healthy retry');assert.equal(counts.acquire,2);assert.equal(counts.attempts,2);assert.equal(counts.release,1);}
  else{assert.equal(result,error,'terminal flag must preserve the original error');assert.equal(counts.acquire,1);assert.equal(counts.attempts,1);assert.equal(counts.release,0);}
  assert.equal(counts.remove,1,'the unclaimed ticket is removed exactly once');assert.equal(counts.heartbeat,flag?1:2);
}
for(const flag of [null,'noRetry','terminalInterrupted']){
  await terminalLockConsumer(flag);console.log(`  ok  actual withInputLock ${flag||'healthy'} retry boundary`);
}
for(const flag of ['noRetry','terminalInterrupted']){
  const anchor=`&& e.${flag} !== true `;assert.equal(terminalLockSource.split(anchor).length-1,1,'unique valid lock mutation');
  await terminalLockConsumer(flag);
  await assert.rejects(terminalLockConsumer(flag,terminalLockSource.replace(anchor,'')),e=>e.code==='ERR_ASSERTION','only behavior failure kills retry mutant');
  console.log(`  ok  valid withInputLock ${flag} guard-dropping mutant`);
}
if(process.argv[2]==='--terminal-only'){console.log('5 inert terminal lock groups passed.');process.exit(0);}

// The actual complete lock module, with only filesystem paths/effects injected. Both parties use
// production offer/claim/withInputLock against one private temp directory; no helper or shared lock.
async function terminalHandoff(mode, code = terminalLockSource) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cb-handoff-terminal-')), lock = path.join(dir, 'input.lock');
  const counts = { attempts: 0, actions: 0 }, errors = {};
  let failCancel = false, failOwner = false, pauseOwner = false, transferred = false, corruptOwner = false, terminalOnOwner = false;
  let ticketDeletes = 0;
  let giverReady, waiterOffered, allowClaim, ownerPaused, resumeOwner;
  const ready = new Promise(r => giverReady = r), offered = new Promise(r => waiterOffered = r);
  const claimAllowed = new Promise(r => allowClaim = r), paused = new Promise(r => ownerPaused = r);
  const resumed = new Promise(r => resumeOwner = r);
  const c = vm.createContext({ os, path, Date, Math, Set, Promise, Error, setTimeout, setInterval, clearInterval,
    process: { pid: process.pid, env: { CHROME_BRIDGE_LOCK: lock, CHROME_BRIDGE_HANDOFF_WAIT_MS: '1000' },
      kill: (pid, signal) => { assert.equal(signal, 0, 'liveness check only'); return process.kill(pid, signal); } },
    mkdir: filesystem.mkdir, rm: filesystem.rm, stat: filesystem.stat, readdir: filesystem.readdir, link: filesystem.link,
    writeFile: async (p, data, options) => {
      if (failCancel && String(p).includes('.decision-') && String(data).includes('"terminal":true')) throw Object.assign(Error('cancel EIO'), { code: 'EIO' });
      if (mode === 'legacy_waiter' && String(data).includes('"inherit":true')) { const value = JSON.parse(data); delete value.handoffProtocol; data = JSON.stringify(value); }
      if (mode === 'legacy_giver' && String(p).includes('handoff.json')) { const value = JSON.parse(data); delete value.protocol; data = JSON.stringify(value); }
      if (corruptOwner && String(p).includes('owner.json') && String(data).includes('"handoffId"')) { const value = JSON.parse(data); delete value.handoffId; data = JSON.stringify(value); }
      return filesystem.writeFile(p, data, options);
    },
    rename: async (from, to) => {
      if (failOwner && to === path.join(lock, 'owner.json')) throw Object.assign(Error('owner EIO'), { code: 'EIO' });
      const result = await filesystem.rename(from, to);
      if (terminalOnOwner && to === path.join(lock, 'owner.json')) {
        const owner = JSON.parse(await filesystem.readFile(to, 'utf8'));
        await filesystem.writeFile(path.join(lock + '.queue', `.decision-${owner.handoffId}.json`), JSON.stringify({ terminal: true, cancel: true }));
      }
      return result;
    },
    readFile: async (...args) => {
      const value = await filesystem.readFile(...args);
      if (pauseOwner && args[0] === path.join(lock, 'owner.json')) { pauseOwner = false; ownerPaused(); await resumed; }
      return value;
    } });
  vm.runInContext(code.replace(/^import .*;$/mg, '').replace(/^export /mg, ''), c);
  if (mode === 'ticket_remove_error') {
    const enqueue = c.enqueue;
    c.enqueue = async (...args) => {
      const ticket = await enqueue(...args);
      if (args[2]) {
        const remove = ticket.remove; let first = true;
        ticket.remove = async () => { if (first) { first = false; throw Object.assign(Error('ticket EIO'), { code: 'EIO' }); }
          ticketDeletes++; return remove(); };
      }
      return ticket;
    };
  }
  const early = mode === 'early_stop' || mode === 'local_withdrawal';
  const giver = c.withInputLock('terminal-giver', async turn => {
    giverReady();
    while (!(await c.queueList()).length) await sleepMs(5);
    const h = await turn.offer({ scene: { appPid: 9 }, pointer: { x: 1, y: 2 } }, early ? {
      shouldStop: async () => { await offered; return { stop: true, terminal: mode === 'early_stop' }; }
    } : {});
    if (early) { allowClaim(); return; }
    if (mode.startsWith('legacy_')) { assert.equal(h, null, 'legacy wire protocol stays in the ordinary queue'); return; }
    assert.ok(h?.commit, 'actual waiter claimed the actual offer');
    if (mode.startsWith('race_') || mode === 'ack_terminal') { pauseOwner = true; await paused; }
    if (mode === 'owner_mismatch') await filesystem.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ token: 'stranger', pid: process.pid, since: Date.now() }));
    failOwner = mode === 'owner_error';
    failCancel = mode.includes('cancel_error');
    corruptOwner = mode === 'unverified_owner'; terminalOnOwner = mode === 'ack_terminal';
    try {
      if (['healthy', 'owner_error', 'owner_mismatch', 'ack_terminal', 'unverified_owner', 'ticket_remove_error'].includes(mode)) await h.commit();
      else await h.cancel?.('terminal_fixture');
    } catch (error) { errors.giver = { code: error.code, noRetry: error.noRetry, reason: error.handoffReason }; }
    transferred = turn.transferred;
  }, { heartbeatMs: 100000 });
  await ready;
  const waiter = c.withInputLock('terminal-waiter', async turn => {
    counts.attempts++;
    if (turn.handoff) {
      waiterOffered();
      if (early) await claimAllowed;
      if (!await turn.claim()) throw Object.assign(Error('healthy withdrawn offer'), { code: 'handoff_lost' });
    }
    counts.actions++;
    return 'acted';
  }, { inherit: true, heartbeatMs: 100000 }).catch(error => { errors.waiter = { code: error.code, noRetry: error.noRetry, terminalInterrupted: error.terminalInterrupted, reason: error.handoffReason }; });
  await giver.finally(() => resumeOwner());
  await waiter;
  const healthy = mode === 'healthy' || mode === 'local_withdrawal' || mode.startsWith('legacy_');
  assert.equal(counts.actions, healthy ? 1 : 0, `${mode}: an uncommitted or terminal claim must never execute`);
  assert.equal(counts.attempts, mode === 'local_withdrawal' ? 2 : 1, `${mode}: only healthy withdrawal may retry`);
  assert.equal(transferred, ['healthy', 'ack_terminal', 'ticket_remove_error'].includes(mode), `${mode}: transfer requires acknowledged matching owner write`);
  if (!healthy) { assert.equal(errors.waiter?.noRetry, true, `${mode}: terminal claimant keeps noRetry`); assert.equal(errors.waiter?.terminalInterrupted, true); }
  if (mode.includes('cancel_error') || mode === 'owner_error') assert.equal(errors.giver?.code, 'EIO', `${mode}: original write failure survives`);
  if (mode === 'owner_mismatch') assert.equal(JSON.parse(await filesystem.readFile(path.join(lock, 'owner.json'), 'utf8')).token, 'stranger', 'never overwrite or release another owner');
  else assert.equal(fsSync.existsSync(lock), false, `${mode}: failure after owner transfer releases only the claimant's token`);
  if (mode === 'ticket_remove_error') { assert.equal(errors.waiter?.code, 'EIO'); assert.equal(ticketDeletes, 1, 'caller performs the one successful ticket cleanup'); }
  assert.deepEqual((await filesystem.readdir(lock + '.queue')).filter(n => !n.startsWith('.')), [], `${mode}: claimant ticket removed once without resurrection`);
  return { mode, ...counts, transferred, errors };
}
const terminalHandoffSource = process.env.CHROME_BRIDGE_HANDOFF_SOURCE
  ? await readFile(process.env.CHROME_BRIDGE_HANDOFF_SOURCE, 'utf8') : terminalLockSource;
const handoffModes = ['healthy', 'cancel', 'cancel_error', 'race_cancel', 'race_cancel_error', 'early_stop', 'local_withdrawal', 'owner_error', 'owner_mismatch', 'legacy_waiter', 'legacy_giver', 'ack_terminal', 'unverified_owner', 'ticket_remove_error'];
for (const mode of handoffModes.filter(mode => !process.env.CHROME_BRIDGE_HANDOFF_CASE || mode === process.env.CHROME_BRIDGE_HANDOFF_CASE)) {
  await terminalHandoff(mode, terminalHandoffSource); console.log(`  ok  actual terminal handoff protocol ${mode}`);
}
if (!process.env.CHROME_BRIDGE_HANDOFF_SOURCE && !process.env.CHROME_BRIDGE_HANDOFF_CASE) {
  const anchor = "if (!h || (h.pid && !alive(h.pid)) || (h.token && h.token !== offer.from))";
  assert.equal(terminalLockSource.split(anchor).length - 1, 1, 'unique abandoned-claim mutation');
  const mutant = terminalLockSource.replace(anchor, "if (!h) { const g = await tryAcquire(label); if (g.ok) { got.token = g.token; await ticket.remove(); return true; } }\n      " + anchor);
  await assert.rejects(terminalHandoff('race_cancel_error', mutant), e => e.code === 'ERR_ASSERTION', 'actual forbidden action kills abandoned-claim recovery mutant');
  console.log('  ok  actual abandoned-claim recovery mutant killed by action count');
  const cleanup = "    await release(got.token).catch(() => {});\n    throw handoffLost(error.handoffReason || 'claim_failed', error);";
  assert.equal(terminalLockSource.split(cleanup).length - 1, 1, 'unique failed-claim owner cleanup mutation');
  await assert.rejects(terminalHandoff('ticket_remove_error', terminalLockSource.replace(cleanup,
    "    throw handoffLost(error.handoffReason || 'claim_failed', error);")), e => e.code === 'ERR_ASSERTION', 'claimant lock residue kills cleanup omission mutant');
  console.log('  ok  failed-claim own-token cleanup mutant killed by remaining lock');
}
// Each peer gets its own OWNER_CHAIN; a giver readback cannot serialize the claimant's action.
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }

async function terminalHandoffQA(mode, source = terminalLockSource) {
  const dir = await filesystem.mkdtemp(path.join(os.tmpdir(), 'cb-handoff-qa-')), lock = path.join(dir, 'input.lock');
  const giverReady = deferred(), waiterOffered = deferred(), claimAllowed = deferred(), partialRead = deferred();
  const delayedRead = deferred(), actionStarted = deferred(), finishAction = deferred();
  const counts = { attempts: 0, actions: 0 }, errors = {};
  let offset = 0, dead = false, transferred = false, commitSucceeded = false, cancelResult = null;
  let armWaiterRead = false, injectedWaiterRead = false, injectedWaiterStat = false;
  const waiterReadInjected = deferred();
  let ownerPublished = false, injectedReadback = false, partialCreated = false, waiterFinished = false, abandonedBeforeCommit = false;
  class Clock extends Date { static now() { return Date.now() + offset; } }
  const context = role => {
    const pid = role === 'giver' ? 101 : 202;
    const c = vm.createContext({ ...filesystem, os, path, Date: Clock, Math, Set, Promise, Error,
      setTimeout, setInterval, clearInterval,
      process: { pid, env: { CHROME_BRIDGE_LOCK: lock, CHROME_BRIDGE_HANDOFF_WAIT_MS: '500' },
        kill: (other, signal) => { assert.equal(signal, 0); if (![101, 202].includes(other) || (dead && other === 101)) throw Object.assign(Error('dead fixture pid'), { code: 'ESRCH' }); } },
      rename: async (from, to) => { const value = await filesystem.rename(from, to);
        if (role === 'giver' && to === path.join(lock, 'owner.json')) {
          const owner = JSON.parse(await filesystem.readFile(to, 'utf8'));
          if (owner.handoffId) ownerPublished = true;
        }
        return value;
      },
      stat: async (...args) => {
        if (role === 'waiter' && mode === 'unreadable_waiter_owner_stat' && injectedWaiterRead && !injectedWaiterStat && args[0] === lock) {
          injectedWaiterStat = true;
          throw Object.assign(Error('one-shot waiter owner stat EIO after unreadable owner'), { code: 'EIO' });
        }
        return filesystem.stat(...args);
      },
      readFile: async (...args) => {
        if (role === 'waiter' && armWaiterRead && !injectedWaiterRead && args[0] === path.join(lock, 'owner.json')) {
          injectedWaiterRead = true; waiterReadInjected.resolve();
          throw Object.assign(Error('one-shot waiter owner read EIO after taken'), { code: 'EIO' });
        }
        if (role === 'giver' && mode === 'landed_readback_failure' && ownerPublished && !injectedReadback && args[0] === path.join(lock, 'owner.json')) {
          injectedReadback = true;
          await actionStarted.promise;
          throw Object.assign(Error('readback EIO after actual claimant action'), { code: 'EIO' });
        }
        const value = await filesystem.readFile(...args);
        if (role === 'waiter' && offset && args[0] === path.join(lock, 'owner.json')) delayedRead.resolve();
        if (role === 'waiter' && mode === 'partial_withdrawal' && String(args[0]).includes('.decision-') && String(value) === '') partialRead.resolve();
        return value;
      },
      writeFile: async (p, data, options) => {
        const withdrawal = role === 'giver' && mode === 'partial_withdrawal' && String(data).includes('"cancel":true');
        if (withdrawal && options?.flag === 'wx' && path.basename(p).startsWith('.decision-') && !path.basename(p).endsWith('.tmp')) {
          const file = await filesystem.open(p, 'wx'); // real exclusive creation, deliberately delayed content
          partialCreated = true; claimAllowed.resolve();
          await partialRead.promise;
          await sleepMs(0); // let the original EEXIST/read-null branch finish before completing bytes
          await file.writeFile(data); await file.close();
          return;
        }
        const value = await filesystem.writeFile(p, data, options);
        // An atomic publication implementation may stage complete bytes before linking. Either
        // contender may win that healthy race; neither may become a terminal interruption.
        if (withdrawal) claimAllowed.resolve();
        return value;
      } });
    vm.runInContext(source.replace(/^import .*;$/mg, '').replace(/^export /mg, ''), c);
    return c;
  };
  const G = context('giver'), W = context('waiter');
  const giver = G.withInputLock('qa-giver', async turn => {
    giverReady.resolve();
    while (!(await G.queueList()).length) await sleepMs(2);
    const h = await turn.offer({ scene: { appPid: 9 }, pointer: { x: 1, y: 2 } }, mode === 'partial_withdrawal' ? {
      shouldStop: async () => { await waiterOffered.promise; return { stop: true, terminal: false }; }
    } : {});
    if (!h?.commit) return;
    if (mode === 'unreadable_waiter_owner' || mode === 'unreadable_waiter_owner_stat') {
      armWaiterRead = true; await waiterReadInjected.promise; await sleepMs(5);
      abandonedBeforeCommit = waiterFinished;
    }
    if (mode === 'late_commit' || mode === 'stale_live_giver' || mode === 'slow_then_cancel') {
      offset = mode === 'stale_live_giver' ? 100000 : 1000;
      await delayedRead.promise;
      await sleepMs(5); // waiter has completed its deterministic expired-clock predicate
      abandonedBeforeCommit = waiterFinished;
    }
    if (mode === 'dead_giver') { dead = true; await sleepMs(30); return; }
    if (mode === 'released_giver') return;
    try {
      if (mode === 'slow_then_cancel') cancelResult = await h.cancel('terminal_after_slow_close');
      else { await h.commit(); commitSucceeded = true; }
    } catch (error) {
      errors.giver = { code: error.code, noRetry: error.noRetry, reason: error.handoffReason };
      if (mode === 'landed_readback_failure') cancelResult = await h.cancel('commit_failed');
    }
    transferred = turn.transferred;
  }, { heartbeatMs: 1000000 });
  await giverReady.promise;
  const waiter = W.withInputLock('qa-waiter', async turn => {
    counts.attempts++;
    if (turn.handoff) {
      waiterOffered.resolve();
      if (mode === 'partial_withdrawal') await claimAllowed.promise;
      if (!await turn.claim()) throw Object.assign(Error('healthy withdrawal'), { code: 'handoff_lost' });
    }
    counts.actions++; actionStarted.resolve();
    if (mode === 'landed_readback_failure') await finishAction.promise;
  }, { inherit: true, heartbeatMs: 1000000 }).catch(error => {
    errors.waiter = { code: error.code, noRetry: error.noRetry, terminalInterrupted: error.terminalInterrupted, reason: error.handoffReason };
  }).finally(() => { waiterFinished = true; });
  await giver;
  const runningAtCancellation = counts.actions > 0 && !waiterFinished;
  finishAction.resolve();
  await waiter;
  let owner = null; try { owner = JSON.parse(await filesystem.readFile(path.join(lock, 'owner.json'), 'utf8')); } catch {}
  const result = { mode, ...counts, transferred, commitSucceeded, cancelResult, runningAtCancellation, abandonedBeforeCommit, injectedWaiterRead, injectedWaiterStat,
    partialCreated, ownerRemains: !!owner, owner: owner && { pid: owner.pid, token: owner.token, handoffId: owner.handoffId }, errors };
  const failures = [];
  const check = fn => { try { fn(); } catch (error) { failures.push(error.stack); } };
  if (['healthy', 'late_commit', 'stale_live_giver', 'unreadable_waiter_owner', 'unreadable_waiter_owner_stat'].includes(mode)) {
    check(() => assert.equal(commitSucceeded, true, `${mode}: healthy transfer commits`));
    check(() => assert.equal(counts.actions, 1, `${mode}: healthy claimant acts exactly once`));
    check(() => assert.equal(transferred, true, `${mode}: giver acknowledges transferred ownership`));
    check(() => assert.equal(owner, null, `${mode}: no orphaned claimant token after both calls end`));
    if (mode.startsWith('unreadable_waiter_owner')) {
      check(() => assert.equal(injectedWaiterRead, true, `${mode}: owner read fault was injected`));
      check(() => assert.equal(injectedWaiterStat, mode.endsWith('_stat'), `${mode}: owner stat fault matches the case`));
    }
  } else if (mode === 'landed_readback_failure') {
    check(() => assert.equal(counts.actions, 1, 'fault is injected only after actual claimant action'));
    check(() => assert.notEqual(cancelResult?.cancelled, true, 'a landed owner write cannot confirm cancellation after the claimant has acted'));
  } else if (mode === 'partial_withdrawal') {
    check(() => assert.equal(counts.actions, 1, 'healthy withdrawal retains ordinary queue completion'));
    check(() => assert.equal(errors.waiter, undefined, 'partial decision publication must not fabricate terminal interruption'));
  } else {
    check(() => assert.equal(counts.actions, 0, `${mode}: no action without transfer`));
    check(() => assert.equal(errors.waiter?.noRetry, true, `${mode}: abandoned/cancelled claim stays noRetry`));
    check(() => assert.equal(owner, null, `${mode}: cleanup does not orphan ownership`));
  }
  return { ...result, failures };
}
for (const mode of ['healthy', 'late_commit', 'stale_live_giver', 'landed_readback_failure', 'partial_withdrawal', 'dead_giver', 'released_giver', 'slow_then_cancel', 'unreadable_waiter_owner', 'unreadable_waiter_owner_stat']) {
  const result = await terminalHandoffQA(mode);
  assert.deepEqual(result.failures, [], `${mode}: actual independent-peer protocol`);
  console.log(`  ok  actual independent-peer protocol ${mode}`);
}

if(process.argv[2]==='--handoff-only'){console.log('Terminal handoff protocol groups passed.');process.exit(0);}

const dir = await mkdtemp(path.join(os.tmpdir(), 'cb-lock-'));

// 1. The check fires: without the lock, 6 concurrent 150 ms sections overlap.
const raw = await runChildren(6, path.join(dir, 'a.lock'), 'bypass');
assert.ok(overlaps(raw) > 0, 'overlap detector must fire when the lock is bypassed');
console.log(`  ok  without the lock: ${overlaps(raw)} overlapping sections detected (check can fail)`);

// 2. With the lock: zero overlap, and total time ~ serial.
const t0 = Date.now();
const spans = await runChildren(6, path.join(dir, 'b.lock'));
const wall = Date.now() - t0;
assert.equal(overlaps(spans), 0, 'critical sections overlapped under the lock');
assert.ok(wall >= 6 * 150, `6 x 150 ms under one lock finished in ${wall} ms — not serialized`);
console.log(`  ok  with the lock: 6 processes, 0 overlaps, ${wall} ms wall (>= 900 ms serial)`);

// 3. A lock left by a dead process is taken over instead of wedging everyone.
const stale = path.join(dir, 'c.lock');
await mkdir(stale);
await writeFile(path.join(stale, 'owner.json'), JSON.stringify({ pid: 999999, since: Date.now(), label: 'crashed', token: 'x' }));
const t1 = Date.now();
await runChildren(1, stale);
assert.ok(Date.now() - t1 < 3000, 'dead holder was not taken over');
console.log('  ok  lock held by a dead pid is taken over');

// 4. Heartbeat (review A5): a live holder keeps `since` fresh, so a long idle
// wait plus a long scroll cannot make its lock look stale to other servers.
process.env.CHROME_BRIDGE_LOCK = path.join(dir, 'd.lock');
const L = await import(LOCK_JS);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const owner = async () => JSON.parse(await readFile(path.join(L.LOCK_DIR, 'owner.json'), 'utf8'));
{
  let first, later, files;
  await L.withInputLock('hb', async () => {
    first = await owner();
    await sleep(400);
    later = await owner();
    files = await readdir(L.LOCK_DIR);
  }, { heartbeatMs: 50 });
  assert.ok(later.since > first.since + 200, `since not refreshed: ${first.since} -> ${later.since}`);
  assert.equal(later.token, first.token);
  assert.deepEqual(files, ['owner.json'], 'a temp file was left behind');
  console.log('  ok  a holder re-stamps `since` while it runs (atomic rename, same token)');
}
{
  let after;
  await L.withInputLock('hb2', async () => {
    const o = await owner();
    await writeFile(path.join(L.LOCK_DIR, 'owner.json'), JSON.stringify({ ...o, token: 'someone-else', since: 1 }));
    await sleep(300);
    after = await owner();
  }, { heartbeatMs: 50 });
  assert.deepEqual([after.token, after.since], ['someone-else', 1], 'the heartbeat overwrote a lock that is no longer ours');
  console.log('  ok  the heartbeat never writes over a lock whose token is not ours');
}
{
  let a, b;
  await L.withInputLock('hb3', async () => {
    await sleep(250);
    a = (await owner()).since;
    await sleep(300);
    b = (await owner()).since;
  }, { heartbeatMs: 50, heartbeatCapMs: 150 });
  assert.equal(a, b, 'a holder past the cap kept refreshing');
  console.log('  ok  the heartbeat stops after its cap (a wedged live holder still goes stale)');
}

/* ---- queue: first come, first served; the veil's waiting list; hand-over between agents ---- */

function spawnChild(args, env = {}) {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.map(String)], { env: { ...process.env, ...env } });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('exit', code => code === 0 ? res(out ? JSON.parse(out) : null) : rej(new Error(`child ${args[0]} failed: ${err}`)));
  });
}

// 5. Six waiters arriving 40 ms apart behind a holder get the lock in the order they asked.
{
  const lock = path.join(dir, 'e.lock');
  const env = { CHROME_BRIDGE_LOCK: lock };
  const holder = spawnChild(['fifo', 0, 500], env);
  await sleepMs(150);
  const waiters = await Promise.all([0, 40, 80, 120, 160, 200].map(d => spawnChild(['fifo', d, 60], env)));
  await holder;
  const byAsk = [...waiters].sort((a, b) => a[0] - b[0]);
  const gots = byAsk.map(s => s[1]);
  assert.deepEqual(gots, [...gots].sort((a, b) => a - b), `not first come, first served: asked ${byAsk.map(s => s[0])} got ${gots}`);
  assert.equal(overlaps(waiters.map(s => [s[1], s[2]])), 0);
  console.log('  ok  6 waiters behind a holder: served in the order they asked, no overlap');
}

// 6. The waiting list: who and what each waiter is; a dead waiter's ticket is dropped.
{
  const lock = path.join(dir, 'f.lock');
  const env = { CHROME_BRIDGE_LOCK: lock };
  const holder = spawnChild(['fifo', 0, 900], env);
  await sleepMs(150);
  const w = spawnChild(['fifo', 0, 10], env);
  await mkdir(lock + '.queue', { recursive: true });
  await writeFile(path.join(lock + '.queue', '00000000000001-0999999-00001.json'), JSON.stringify({ pid: 999999, label: 'ghost', beat: Date.now() }));
  await sleepMs(250);
  const { stdout } = await new Promise((res) => {
    const c = spawn(process.execPath, ['-e', `import(${JSON.stringify(LOCK_JS)}).then(async L => process.stdout.write(JSON.stringify(await L.queueList())))`],
      { env: { ...process.env, CHROME_BRIDGE_LOCK: lock } });
    let o = ''; c.stdout.on('data', d => { o += d; }); c.on('exit', () => res({ stdout: o }));
  });
  const q = JSON.parse(stdout);
  assert.deepEqual(q.map(t => [t.who, t.task]), [['w0', 't']], JSON.stringify(q));
  assert.ok(!(await readdir(lock + '.queue')).some(n => n.includes('0999999')), 'a dead waiter\'s ticket stayed in the queue');
  await Promise.all([holder, w]);
  console.log('  ok  the waiting list names each waiter and its task; a dead waiter\'s ticket is dropped');
}

// 7. Hand-over: the holder offers, the waiter claims and becomes the owner with the user's scene;
//    the holder's own release does not free the lock under it.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'g.lock') };
  const giver = spawnChild(['giver'], env);
  await sleepMs(150);
  const [g, t] = await Promise.all([giver, spawnChild(['taker', 0], env)]);
  assert.equal(g.taken, true, JSON.stringify(g));
  assert.equal(g.to.task, 'export');
  assert.deepEqual([t.inherited, t.ownsLock, t.handoff.scene, t.handoff.pointer, t.handoff.touched], [true, true, { appPid: 9, chromeTab: 5 }, { x: 1, y: 2 }, true]);
  assert.ok(!fsSync.existsSync(env.CHROME_BRIDGE_LOCK), 'lock left behind after the last holder');
  console.log('  ok  hand-over: the waiter claims, becomes the owner and gets the user\'s scene and pointer');
}

// 8. Withdrawn: the waiter is too slow to claim → the holder takes its offer back and puts things back
//    itself (still holding the lock); the waiter's late claim fails, it waits again in its place and gets
//    the lock the usual way once the holder is done.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'h.lock'), CHROME_BRIDGE_HANDOFF_WAIT_MS: '150' };
  const giver = spawnChild(['giver', 'slow'], env);
  await sleepMs(150);
  const [g, t] = await Promise.all([giver, spawnChild(['taker', 600], env)]);
  assert.equal(g.taken, false, JSON.stringify(g));
  assert.deepEqual([t.inherited, t.ownsLock], [false, true], JSON.stringify(t));
  console.log('  ok  a hand-over not claimed in time is withdrawn; the waiter then gets the lock the usual way');
}

// 9. A waiter that cannot take a takeover over is never offered one (no wait for it).
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'i.lock') };
  const giver = spawnChild(['giver'], env);
  await sleepMs(150);
  const [g, t] = await Promise.all([giver, spawnChild(['taker', 0, 'plain'], env)]);
  assert.equal(g.taken, false);
  assert.ok(g.offerMs < 300, `offered to a waiter that cannot take it (${g.offerMs} ms)`);
  assert.deepEqual([t.inherited, t.ownsLock, t.handoff], [false, true, null]);
  console.log('  ok  a waiter that cannot take a takeover over is not offered one');
}

// 10. A crash after claim is indistinguishable from terminal close with a lost cancellation receipt.
//     This inherited invocation stops without reacquiring; an unrelated plain waiter can still run.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'j.lock') };
  const giver = spawnChild(['giver', 'die'], env);
  await sleepMs(150);
  const [, t] = await Promise.all([giver, spawnChild(['taker', 0], env)]);
  assert.deepEqual([t.code, t.noRetry, t.terminalInterrupted, t.actions, t.attempts], ['handoff_lost', true, true, 0, 1], JSON.stringify(t));
  const next = await spawnChild(['taker', 0, 'plain'], env);
  assert.deepEqual([next.inherited, next.ownsLock], [false, true], 'unrelated queue acquisition remains available');
  console.log('  ok  an uncommitted dead-holder claim stops; an unrelated plain waiter still acquires');
}

// 11. Codex A1: a withdrawn offer stays withdrawn after the lock changed hands — here an older server
//     (no ticket) takes the freed lock before the slow waiter claims; the late claim must fail.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'k.lock'), CHROME_BRIDGE_HANDOFF_WAIT_MS: '150' };
  const giver = spawnChild(['giver'], env);
  await sleepMs(150);
  const taker = spawnChild(['taker', 900], env);
  await sleepMs(500);                                   // offer made and withdrawn, lock freed
  const old = spawnChild(['oldserver', 1200], env);
  const [g, t] = await Promise.all([giver, taker, old]);
  assert.equal(g.taken, false);
  assert.equal(t.inherited, false, `a late claim of a withdrawn offer succeeded in the next holder's lock: ${JSON.stringify(t)}`);
  console.log('  ok  Codex A1: a late claim of a withdrawn offer fails even after the lock changed hands');
}

// 12. Codex A2: a heartbeat racing the hand-over never writes the old owner back (5 hand-overs, heartbeat every 2 ms).
{
  for (let i = 0; i < 5; i++) {
    const env = { CHROME_BRIDGE_LOCK: path.join(dir, `l${i}.lock`) };
    const giver = spawnChild(['giver', 'hb'], env);
    await sleepMs(120);
    const t0 = Date.now();
    const [g, t] = await Promise.all([giver, spawnChild(['taker', 0], env)]);
    assert.deepEqual([g.taken, t.inherited, t.ownsLock], [true, true, true], JSON.stringify({ g, t }));
    assert.ok(Date.now() - t0 < 5000, `hand-over stalled ${Date.now() - t0} ms (old owner written back?)`);
  }
  console.log('  ok  Codex A2: 5 hand-overs with a 2 ms heartbeat: the next owner is never overwritten');
}

// 13. Codex A5: a waiter whose page check outlasts the ticket's stale limit keeps its place and its claim.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'm.lock'), CHROME_BRIDGE_TICKET_BEAT_MS: '100', CHROME_BRIDGE_TICKET_STALE_MS: '400',
    CHROME_BRIDGE_HANDOFF_WAIT_MS: '3000' };
  const giver = spawnChild(['giver'], env);
  await sleepMs(150);
  const taker = spawnChild(['taker', 1200], env);       // 3x the stale limit outside the wait loop
  await sleepMs(300);
  const later = spawnChild(['fifo', 0, 50], env);
  const [g, t, w] = await Promise.all([giver, taker, later]);
  assert.deepEqual([g.taken, t.inherited], [true, true], `the slow waiter lost its place: ${JSON.stringify({ g, t })}`);
  assert.ok(w[1] > g.offerMs, 'the later waiter went first');
  console.log('  ok  Codex A5: a slow page check (3x the ticket limit) keeps the waiter\'s place and claim');
}

// 14. Codex A8: refused only when the queue stops moving, not after a fixed total wait.
{
  const env = { CHROME_BRIDGE_LOCK: path.join(dir, 'n.lock') };
  const chain = [spawnChild(['fifo', 0, 400], env), spawnChild(['fifo', 50, 400], env), spawnChild(['fifo', 100, 400], env)];
  await sleepMs(200);
  const moving = await spawnChild(['patient', 700], env);   // waits ~1.0 s in all, never 700 ms without progress
  await Promise.all(chain);
  assert.deepEqual(moving.slice(0, 2), [true, null], `refused while the queue moved: ${moving}`);
  const stuck = spawnChild(['fifo', 0, 1500], env);
  await sleepMs(150);
  const stalled = await spawnChild(['patient', 500], env);
  await stuck;
  assert.deepEqual(stalled.slice(0, 2), [false, 'lock_timeout'], `not refused after 500 ms without progress: ${stalled}`);
  console.log(`  ok  Codex A8: a queue that moves is waited out (${moving[2]} ms > 700 ms limit); one that stops is refused`);
}

// 15. Codex A9: a call cancelled while it waits gives its place up at once.
{
  process.env.CHROME_BRIDGE_LOCK = path.join(dir, 'd.lock');
  const holder = spawnChild(['fifo', 0, 800], { CHROME_BRIDGE_LOCK: L.LOCK_DIR });
  await sleepMs(150);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  await assert.rejects(L.withInputLock('cancel', async () => 'ran', { signal: ac.signal }), (e) => e.code === 'cancelled');
  assert.ok(Date.now() - t0 < 600, 'kept waiting after the cancel');
  assert.deepEqual((await L.queueList()).filter(x => x.pid === process.pid), [], 'the cancelled waiter\'s ticket stayed');
  await holder;
  console.log('  ok  Codex A9: cancelled while waiting → rejected at once, ticket removed, nothing run');
}

// 16. Codex round 2 A10: a re-stamp already writing when the ticket is removed must not put it back.
//     The hook makes every re-stamp take 300 ms; the wait is cancelled while one is under way.
{
  process.env.CHROME_BRIDGE_LOCK = path.join(dir, 'd.lock');
  const holder = spawnChild(['fifo', 0, 4000], { CHROME_BRIDGE_LOCK: L.LOCK_DIR });
  await sleepMs(200);
  let writing = 0, mine = null;
  const ac = new AbortController();
  const waiting = L.withInputLock('a10', async () => 'ran', { signal: ac.signal }).catch(e => e);
  // Once the ticket is in the queue (its first write done), every later re-stamp is slow.
  let t0 = Date.now();
  while (!(await L.queueList()).some(t => t.pid === process.pid) && Date.now() - t0 < 2000) await sleepMs(10);
  L.__setTicketBeatHookForTests(async (name) => { mine = name; writing++; await sleepMs(300); writing--; });
  t0 = Date.now();
  while (!writing && Date.now() - t0 < 4000) await sleepMs(10);     // the 2 s re-stamp timer fired: a write is under way
  assert.ok(writing, 'no re-stamp started (test setup)');
  ac.abort();
  const e = await waiting;
  L.__setTicketBeatHookForTests(null);
  assert.equal(e.code, 'cancelled', String(e));
  await sleepMs(500);                                              // past the slow write
  const left = (await readdir(L.QUEUE_DIR)).filter(n => n === mine);
  assert.deepEqual(left, [], `the removed ticket was written back by a re-stamp under way: ${mine}`);
  assert.ok(!(await L.queueList()).some(t => t.name === mine), 'the removed ticket is still in the queue');
  await holder;
  console.log('  ok  Codex round 2 A10: a re-stamp under way when the ticket is removed does not put it back');
}

console.log('\nlock tests passed.');
