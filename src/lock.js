/**
 * One mouse, one keyboard, one frontmost window — shared by every agent.
 *
 * Reads run in parallel (Chrome can `execute` in any tab, visible or not), but a
 * real click / keystroke / wheel tick needs the target tab to be the one on
 * screen, and needs it to STAY there until the event lands. Each Claude session
 * spawns its own server process, so the lock must be cross-process: an atomic
 * mkdir, with the holder's pid inside so a crashed holder does not wedge
 * everyone else.
 *
 * Waiters queue first come, first served (owner 2026-10-09: several agents send work at once and
 * it is done in turn, not refused as "taken by another agent"): each takes a ticket in QUEUE_DIR
 * and only the oldest live ticket tries the lock. The tickets are also what the veil shows as
 * "N tasks waiting". A holder that is done while someone waits can hand its takeover straight to
 * the first waiter (offer / claim / transfer below): no putting the user's things back and taking
 * over again between two agents; the last one in the chain puts them back.
 */
import { mkdir, rm, writeFile, readFile, rename, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const LOCK_DIR = process.env.CHROME_BRIDGE_LOCK ||
  path.join(os.homedir(), 'Library', 'Caches', 'chrome-bridge-mcp', 'input.lock');
/** Beside the lock, not in it: a stale-steal (also by older servers) removes the lock dir only. */
export const QUEUE_DIR = LOCK_DIR + '.queue';

/**
 * A holder whose `since` is older than this is presumed wedged. A live holder
 * re-stamps `since` every HEARTBEAT_MS (the idle wait inside the lock plus a
 * long scroll can exceed 90 s), for at most HEARTBEAT_CAP_MS, so a wedged but
 * still running holder goes stale too. Older server builds read the same
 * `since` field.
 */
export const STALE_MS = 90_000;
export const HEARTBEAT_MS = 15_000;
export const HEARTBEAT_CAP_MS = 180_000;
const POLL_MS = 100;
/** A waiting ticket is re-stamped this often; one not re-stamped for TICKET_STALE_MS is dropped. */
const TICKET_BEAT_MS = Number(process.env.CHROME_BRIDGE_TICKET_BEAT_MS ?? 2_000);
const TICKET_STALE_MS = Number(process.env.CHROME_BRIDGE_TICKET_STALE_MS ?? 10_000);
/** How long a holder keeps its takeover up for the first waiter to take it (its page check and veil). */
let HANDOFF_WAIT_MS = Number(process.env.CHROME_BRIDGE_HANDOFF_WAIT_MS ?? 4_000);
export function __setHandoffWaitForTests(ms) { HANDOFF_WAIT_MS = ms; }
/** The default wait for a turn: the whole retry window (index.js persist), so a waiter keeps its place. */
export const TURN_TIMEOUT_MS = Number(process.env.CHROME_BRIDGE_RETRY_MAX_MS ?? 600_000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

/** Write a JSON file atomically: a reader never parses a half-written file. */
async function writeJson(p, obj) {
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, JSON.stringify(obj));
  await rename(tmp, p);
}

async function holder() {
  const j = await readJson(path.join(LOCK_DIR, 'owner.json'));
  if (j) return j;
  // Directory exists but owner not yet written (or unreadable): use its age.
  try {
    const s = await stat(LOCK_DIR);
    return { pid: null, since: s.mtimeMs };
  } catch { return null; }
}

/** Replace owner.json atomically (older servers read the same file, temp name included). */
async function writeOwner(owner) {
  const tmp = path.join(LOCK_DIR, `owner.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(owner));
  await rename(tmp, path.join(LOCK_DIR, 'owner.json'));
}

const newToken = () => `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function tryAcquire(label) {
  try {
    await mkdir(LOCK_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') {
      await mkdir(path.dirname(LOCK_DIR), { recursive: true });
      return tryAcquire(label);
    }
    if (e.code !== 'EEXIST') throw e;
    const h = await holder();
    const dead = h && h.pid && h.pid !== process.pid && !alive(h.pid);
    const stale = h && Date.now() - h.since > STALE_MS;
    if (dead || stale) {
      await rm(LOCK_DIR, { recursive: true, force: true });
      return tryAcquire(label);
    }
    return { ok: false, holder: h };
  }
  const token = newToken();
  await writeOwner({ pid: process.pid, since: Date.now(), label, token });
  return { ok: true, token };
}

async function release(token) {
  await ownerWrite(async () => {
    const h = await holder();
    // Only remove our own lock — after a stale-steal or a hand-over it belongs to someone else.
    if (h && h.token === token) await rm(LOCK_DIR, { recursive: true, force: true });
  });
}

/**
 * Every owner.json read-check-write of this process, one after another: a heartbeat that has read
 * "ours" cannot write after a hand-over has written the next owner in (Codex review A2).
 */
let OWNER_CHAIN = Promise.resolve();
function ownerWrite(fn) {
  const run = OWNER_CHAIN.then(fn, fn);
  OWNER_CHAIN = run.catch(() => {});
  return run;
}

/** Re-stamp `since` while fn runs, only while the lock is ours (same token: a no-op until a hand-over reaches it).
 * `token` may be a function: a hand-over's claim can end with a different token (stale-steal). */
function startHeartbeat(token, everyMs, capMs) {
  const tok = typeof token === 'function' ? token : () => token;
  const t0 = Date.now();
  let stopped = false, running = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped || Date.now() - t0 > capMs) return;
    running = running.then(() => ownerWrite(async () => {
      if (stopped) return;
      const h = await holder();
      if (!h || h.token !== tok()) return;
      await writeOwner({ ...h, since: Date.now() });
    })).catch(() => {});
  }, everyMs);
  timer.unref?.();
  return { async stop() { stopped = true; clearInterval(timer); await running; } };
}

/* ------------------------------------------------------------------ queue */

let SEQ = 0;
/** Tests: runs inside a ticket's re-stamp, after its `removed` check and before the write (a slow disk). */
let TICKET_BEAT_HOOK = null;
export function __setTicketBeatHookForTests(fn) { TICKET_BEAT_HOOK = fn; }
/** This process's tickets that wait for a claim to settle (the veil does not list its own agent). */
const PENDING = new Set();
export function pendingTickets() { return PENDING; }

/**
 * A place in the queue: a file named by the time it was taken (then pid, then a counter), so the
 * names sort first come, first served. `info` ({who, task}) is what the veil shows; `inherit`
 * says this waiter can take a holder's takeover over (only those are offered one). The ticket is
 * re-stamped on its own timer until removed — also while its process runs a hand-over's page
 * check outside the wait loop (Codex review A5).
 */
async function enqueue(label, info = {}, inherit = false) {
  await mkdir(QUEUE_DIR, { recursive: true });
  const name = `${String(Date.now()).padStart(14, '0')}-${String(process.pid).padStart(7, '0')}-${String(++SEQ).padStart(5, '0')}.json`;
  const p = path.join(QUEUE_DIR, name);
  const body = { pid: process.pid, label, who: info.who ?? null, task: info.task ?? null, inherit: !!inherit, since: Date.now() };
  let removed = false, chain = Promise.resolve();
  // Beats and the removal one after another: a beat already writing cannot put the ticket back after
  // remove() (Codex review round 2, A10).
  const queued = (fn) => (chain = chain.then(fn).catch(() => {}));
  const t = {
    name,
    beat() {
      return queued(async () => {
        if (removed) return;
        if (TICKET_BEAT_HOOK) await TICKET_BEAT_HOOK(name);
        await writeJson(p, { ...body, beat: Date.now() });
      });
    },
    remove() {
      removed = true; clearInterval(timer); PENDING.delete(name);
      return queued(() => rm(p, { force: true }));
    }
  };
  const timer = setInterval(() => { t.beat(); }, TICKET_BEAT_MS);
  timer.unref?.();
  await t.beat();
  return t;
}

/**
 * The live tickets, oldest first. Tickets of dead processes, or not re-stamped for
 * TICKET_STALE_MS (a process that stopped running), are removed on the way; so are
 * old decision files (see DECISION).
 * @returns {Promise<Array<{name, pid, label, who, task, inherit, since, beat}>>}
 */
export async function queueList() {
  let all;
  try { all = await readdir(QUEUE_DIR); } catch { return []; }
  for (const n of all.filter(n => n.startsWith('.decision-'))) {
    const p = path.join(QUEUE_DIR, n);
    try { if (Date.now() - (await stat(p)).mtimeMs > DECISION_KEEP_MS) await rm(p, { force: true }); } catch {}
  }
  const out = [];
  for (const name of all.filter(n => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    const p = path.join(QUEUE_DIR, name);
    const t = await readJson(p);
    if (!t) continue;                  // removed meanwhile
    if (!t.pid || !alive(t.pid) || Date.now() - (t.beat || 0) > TICKET_STALE_MS) {
      await rm(p, { force: true }).catch(() => {});
      continue;
    }
    out.push({ ...t, name });
  }
  return out;
}

const OFFER = () => path.join(LOCK_DIR, 'handoff.json');
/**
 * One per offer, beside the queue (not in the lock dir, which a release removes and the next holder
 * creates again): a withdrawn offer's cancel stays, so a claim that comes late — even after the lock
 * changed hands — finds it and fails (Codex review A1). Swept after DECISION_KEEP_MS.
 */
const DECISION = (id) => path.join(QUEUE_DIR, `.decision-${id}.json`);
const DECISION_KEEP_MS = 10 * 60_000;

const cancelledError = () => Object.assign(new Error('调用已取消，排队已撤销，没有发出任何输入。'), { code: 'cancelled' });

/**
 * Wait for a turn. Only the oldest ticket tries the lock; while it is held, an offer addressed to
 * that ticket (see offer()) ends the wait with `handoff` set — the ticket is kept until the claim.
 * `stallMs`: refused only after this long WITHOUT progress (the holder changed or our place moved up),
 * never while the queue moves (Codex review A8). `signal`: the call was cancelled → the place is given up.
 * @param opts.ticket  a ticket kept from an earlier wait whose hand-over fell through (keeps its place)
 */
async function acquire(label, stallMs, { info = {}, inherit = false, ticket = null, signal = null } = {}) {
  const t0 = Date.now();
  if (signal && signal.aborted) throw cancelledError();
  const tk = ticket || await enqueue(label, info, inherit);
  let lastHolder = null, ahead = 0, keep = false, progressAt = Date.now(), lastKey = null, lastIdx = Infinity;
  try {
    for (;;) {
      if (signal && signal.aborted) throw cancelledError();
      const q = await queueList();
      let idx = q.findIndex(x => x.name === tk.name);
      if (idx < 0) { await tk.beat(); idx = (await queueList()).findIndex(x => x.name === tk.name); }
      ahead = Math.max(ahead, idx);
      if (idx <= 0) {
        const got = await tryAcquire(label);
        if (got.ok) {
          const waitedMs = Date.now() - t0;
          return { token: got.token, waitedMs, ahead,
            waitedFor: waitedMs > POLL_MS && lastHolder ? (lastHolder.label || null) : null, handoff: null };
        }
        lastHolder = got.holder;
        if (inherit && lastHolder && lastHolder.token) {
          const o = await readJson(OFFER());
          if (o && o.id && o.from === lastHolder.token && o.to === tk.name) {
            keep = true;
            PENDING.add(tk.name);
            return { token: newToken(), waitedMs: Date.now() - t0, ahead, waitedFor: lastHolder.label || null,
              handoff: { offer: o, ticket: tk } };
          }
        }
      } else {
        lastHolder = await holder();
      }
      const key = lastHolder ? lastHolder.token || `${lastHolder.pid}:${lastHolder.since}` : 'free';
      if (key !== lastKey || idx < lastIdx) { progressAt = Date.now(); lastKey = key; lastIdx = idx; }
      if (Date.now() - progressAt > stallMs) {
        const e = new Error(
          `❌ 排了 ${Math.round((Date.now() - t0) / 1000)} 秒队，最近 ${Math.round((Date.now() - progressAt) / 1000)} 秒队伍一直没动` +
          (idx > 0 ? `：前面还有 ${idx} 个任务` : '') +
          (lastHolder ? `（正在做的是进程 ${lastHolder.pid} 的「${lastHolder.label || '?'}」）` : '') + '。');
        e.code = 'lock_timeout';
        throw e;
      }
      await sleep(POLL_MS);
    }
  } finally {
    if (!keep) await tk.remove();
  }
}

/**
 * Take the holder's takeover over (after this waiter's own veil is up, so the user's input stays
 * held): one decision file per offer, created exclusively — the holder's cancel and this claim
 * cannot both win. Then wait until the holder has closed its session and written us in as owner.
 * A holder that died meanwhile left nothing put back: we take the lock the usual way and still
 * put the user's things back at the end. If someone else holds the lock meanwhile (the holder was
 * wedged long enough to be stolen from) and it does not come free within CLAIM_STRANGER_MS, the
 * claim gives up: false, nothing restored by us.
 * @returns {Promise<boolean>} false: the offer was withdrawn, nothing of the holder's is ours
 */
const CLAIM_STRANGER_MS = 30_000;
async function claim(label, got) {
  const { offer, ticket } = got.handoff;
  try {
    await mkdir(QUEUE_DIR, { recursive: true });
    await writeFile(DECISION(offer.id), JSON.stringify({ taken: true, token: got.token, pid: process.pid, label }), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') { await ticket.beat(); PENDING.delete(ticket.name); return false; }
    throw e;
  }
  let strangerSince = null;
  for (;;) {
    const h = await holder();
    if (h && h.token === got.token) break;
    const holderGone = !h || (h.pid && !alive(h.pid)) || Date.now() - h.since > STALE_MS;
    if (holderGone) {
      const g = await tryAcquire(label);
      if (g.ok) { got.token = g.token; break; }
    } else if (h.token !== offer.from) {
      strangerSince ??= Date.now();
      if (Date.now() - strangerSince > CLAIM_STRANGER_MS) { PENDING.delete(ticket.name); return false; }
    }
    await sleep(25);
  }
  await ticket.remove();
  return true;
}

/**
 * Offer this holder's takeover to the first waiter that can take one, and wait up to
 * HANDOFF_WAIT_MS for its claim. The caller keeps its veil up meanwhile.
 * opts.onOffer(head): called once an offer is really made (the caller's veil can say so).
 * opts.shouldStop(): polled while waiting (about every 200 ms); true → the offer is withdrawn if it
 *   still can be (the user took the keyboard and mouse back).
 * @returns null: nobody took it (the caller puts things back as usual) — `stopped` set on the result
 *          of shouldStop when that is why; or {to, commit(), stopped}: call commit() right after
 *          closing the session (it writes the waiter in as owner); `stopped`: shouldStop said so but
 *          the waiter had already claimed.
 */
async function offer(turn, payload, { onOffer = null, shouldStop = null } = {}) {
  const q = await queueList();
  const head = q[0];
  if (!head || !head.inherit) return null;
  const h = await holder();
  if (!h || h.token !== turn.token) return null;
  if (onOffer) onOffer(head);
  const id = `${turn.token}-${++SEQ}`;
  await writeJson(OFFER(), { id, from: turn.token, to: head.name, at: Date.now(), fromLabel: h.label || null, ...payload });
  const t0 = Date.now();
  let stopped = false, lastStopCheck = 0;
  for (;;) {
    const d = await readJson(DECISION(id));
    if (d && d.taken) {
      return {
        to: { label: d.label || head.label, who: head.who, task: head.task, pid: d.pid },
        stopped,
        async commit() {
          turn.transferred = true;
          if (turn.stopHeartbeat) await turn.stopHeartbeat();
          await ownerWrite(async () => {
            const cur = await holder();
            if (cur && cur.token === turn.token) await writeOwner({ pid: d.pid, since: Date.now(), label: d.label, token: d.token });
            await rm(OFFER(), { force: true }).catch(() => {});
          });
          await rm(DECISION(id), { force: true }).catch(() => {});
        }
      };
    }
    if (shouldStop && !stopped && Date.now() - lastStopCheck >= 200) {
      lastStopCheck = Date.now();
      stopped = !!(await Promise.resolve(shouldStop()).catch(() => false));
    }
    const still = !stopped && Date.now() - t0 < HANDOFF_WAIT_MS && (await queueList()).some(x => x.name === head.name);
    if (!still) {
      try {
        await mkdir(QUEUE_DIR, { recursive: true });
        await writeFile(DECISION(id), '{"cancel":true}', { flag: 'wx' });
      } catch (e) {
        if (e.code === 'EEXIST') continue;          // claimed at the same moment: read it
        return null;
      }
      // The cancel stays (see DECISION): this holder now puts things back, and a waiter that sees the
      // offer only now must not claim it meanwhile.
      await rm(OFFER(), { force: true }).catch(() => {});
      return stopped ? { stopped: true, to: null, commit: null } : null;
    }
    await sleep(25);
  }
}

/**
 * One turn at the lock, as the code holding it sees it.
 *  handoff: {scene, pointer, touched, from} when this turn takes a holder's takeover over; then
 *           claim() must be called once this waiter's own veil is up (false: offer withdrawn)
 *  offer(payload, opts): hand this turn's takeover to the first waiter (see offer())
 */
function makeTurn(label, got) {
  const turn = {
    get token() { return got.token; },
    transferred: false,
    claimed: !got.handoff,
    stopHeartbeat: null,
    handoff: got.handoff ? {
      scene: got.handoff.offer.scene ?? null, pointer: got.handoff.offer.pointer ?? null,
      touched: !!got.handoff.offer.touched, from: got.handoff.offer.fromLabel ?? null
    } : null,
    async claim() {
      if (turn.claimed) return true;
      turn.claimed = await claim(label, got);
      return turn.claimed;
    },
    offer: (payload, opts) => offer(turn, payload, opts)
  };
  return turn;
}

/**
 * A long job's lease (index.js task hold): the lock held across several actions and the pauses
 * between them, re-stamped for as long as it is held, so other agents queue behind the job — until
 * it hands its turn to one of them (index.js yields between two steps when someone waits).
 * While it is held, withInputLock in this process runs inside it (re-entrant: one process is one agent).
 * @returns {Promise<{token, waitedMs, waitedFor, ahead, handoff, claim(), offer(), release():Promise<void>}>}
 */
let lease = null;
export async function acquireLease(label, { timeoutMs = TURN_TIMEOUT_MS, heartbeatMs = HEARTBEAT_MS, info = {}, inherit = false, ticket = null, signal = null } = {}) {
  const got = await acquire(label, timeoutMs, { info, inherit, ticket, signal });
  if (signal && signal.aborted && !got.handoff) {
    // Cancelled just as the turn came (nothing held yet): give it up (Codex review round 2, A9).
    await release(got.token).catch(() => {});
    throw cancelledError();
  }
  const turn = makeTurn(label, got);
  // The heartbeat follows the token: a hand-over's claim may swap it for a stale-steal's.
  const hb = startHeartbeat(() => got.token, heartbeatMs, Infinity);
  turn.stopHeartbeat = () => hb.stop();
  const l = {
    get token() { return got.token; },
    get transferred() { return turn.transferred; },
    get claimed() { return turn.claimed; },
    waitedMs: got.waitedMs, waitedFor: got.waitedFor, ahead: got.ahead,
    handoff: turn.handoff,
    claim: () => turn.claim(),
    offer: (payload, opts) => turn.offer(payload, opts),
    /** The ticket to keep the place in the queue when the hand-over fell through (claim() false). */
    get ticket() { return got.handoff && !turn.claimed ? got.handoff.ticket : null; },
    /** keepTicket: the hand-over fell through and the caller waits again with `ticket`. */
    async release({ keepTicket = false } = {}) {
      if (lease === l) lease = null;
      await hb.stop();
      if (!turn.transferred && turn.claimed) await release(got.token).catch(() => {});
      if (!keepTicket && got.handoff && !turn.claimed) await got.handoff.ticket.remove();
    }
  };
  lease = l;
  return l;
}
export function holdsLease() { return !!lease; }

/**
 * Run fn(turn) while holding the input lock. A turn that came as a hand-over whose claim fell
 * through (fn throws code 'handoff_lost' before claim() succeeded) waits again in the same place.
 * @param opts.inherit  this caller can take a holder's takeover over (see makeTurn)
 * @param opts.info     {who, task}: shown to the user while waiting
 * @param opts.signal   the call's AbortSignal: cancelled while waiting → the place is given up
 * @param opts.timeoutMs  refused after this long with no progress in the queue (see acquire)
 * @param opts.heartbeatMs / opts.heartbeatCapMs  see STALE_MS (tests shorten them)
 * @returns {Promise<{result:any, waitedMs:number, waitedFor:string|null, ahead:number, inherited:boolean}>}
 */
export async function withInputLock(label, fn, { timeoutMs = TURN_TIMEOUT_MS, heartbeatMs = HEARTBEAT_MS, heartbeatCapMs = HEARTBEAT_CAP_MS,
  info = {}, inherit = false, signal = null } = {}) {
  if (lease) return { result: await fn(null), waitedMs: 0, waitedFor: null, ahead: 0, inherited: false };
  const t0 = Date.now();
  let ticket = null;
  for (;;) {
    const got = await acquire(label, timeoutMs, { info, inherit, ticket, signal });
    const waitedMs = Date.now() - t0;
    const turn = makeTurn(label, got);
    const hb = startHeartbeat(() => got.token, heartbeatMs, heartbeatCapMs);
    turn.stopHeartbeat = () => hb.stop();
    let retry = false;
    try {
      // Cancelled just as the turn came (nothing held, nothing claimed yet): give it up.
      if (signal && signal.aborted && !got.handoff) throw cancelledError();
      const result = await fn(turn);
      return { result, waitedMs, waitedFor: got.waitedFor, ahead: got.ahead, inherited: !!got.handoff && turn.claimed };
    } catch (e) {
      if (e && e.code === 'handoff_lost' && !turn.claimed && !(signal && signal.aborted)) { retry = true; ticket = got.handoff.ticket; }
      else throw e;
    } finally {
      await hb.stop();
      if (!turn.transferred && turn.claimed) await release(got.token).catch(() => {});
      if (!retry && got.handoff && !turn.claimed) await got.handoff.ticket.remove();
    }
  }
}
