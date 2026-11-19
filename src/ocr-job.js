/**
 * OCR1 (batch 4, Bug D): who owns a `cgevent ocr` child, how long a caller waits for it, and the opportunistic warm-up.
 *
 * Field facts (2026-11-04): a warm recognition takes ~0.25 s even in a fresh helper process, yet some took 25–40 s, most
 * of them the first OCR of a server and six not. A system-level cold load is the inference, not a proven cause. So:
 *  - A relay's caller waits at most OCR_WAIT_MS from OCR start (bridge.js `ocrImage(…, {bounded})`). Past it the reply
 *    goes out without text while the child keeps running: the job owns the child and the capture's image (`retain`)
 *    until the child exits, is killed at OCR_HARD_MS, or the process exits. What it recognises after the caller stopped
 *    waiting is dropped here: no late text ever reaches a reply, a text map or a file.
 *  - At most OCR_MAX_LIVE recognitions of one relay run at once; a bounded caller beyond that gets `busy` at once.
 *  - A warm-up recognises the bundled ocr-warm.png (no user content) when no OCR completed on this Mac within
 *    WARM_FRESH_MS: at most one per freshness window on this Mac (the relay that creates that window's file with O_EXCL;
 *    no file is ever taken over or released early, so no stale-lock recovery exists), never while any relay holds the
 *    input lock (deferred), never at server start, never awaited by a tool call (index.js ocrWarmSoon).
 *  - Telemetry is numbers and fixed words only (requestFacts; the row fields in settings.js activityRecord).
 *
 * Telemetry definitions (one row per screenshot/read_page that ran OCR):
 *  ocrMs       ms from this OCR's request until the call stopped waiting (result, failure, or the 8 s budget).
 *  ocrStatus   ok | failed | timeout (budget passed; text discarded) | busy (not started: OCR_MAX_LIVE running).
 *  ocrHelperMs the helper's own `elapsedMs` (image load + Vision request, inside the child; excludes process launch);
 *              only when the result arrived within the budget.
 *  ocrGapFrom  what the gap is measured from, read at request time from the completion stamp (any relay on this Mac):
 *              real | warm (kind of the most recent completed OCR), none (no stamp: first observation on this Mac),
 *              invalid (unreadable, malformed, non-finite, more than 1 s in the future, or older than 30 days).
 *  ocrGapMs    ms from that completion (child exit with a parsed result; a late real OCR counts) to this request.
 *              Request time is the job's start; a recognition still running at request time is not a completion.
 *  ocrPrevMs   the wall time (spawn to exit) of that completed OCR: how a timed-out or warm-up OCR really ended.
 *  ocrOverlap  OCR children running at request time: this relay's own, plus 1 when another live relay's warm-up of the
 *              current window has not finished (other relays' real OCR is not visible here).
 *  ocrPrevMs and ocrGapMs describe the most recent completed OCR on this Mac, from any relay: the stamp has no job
 *  identity, so they cannot be attributed to this relay's earlier timeout.
 */
import { execFile } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OCR_LANGS = ['zh-Hans', 'zh-Hant', 'en-US', 'ja-JP'];
export const OCR_MAX_PX = 2048;
/** How long a relay's caller waits from OCR start: the reply is out by 8.5 s after it. */
export const OCR_WAIT_MS = 8000;
/** The child's own limit (SIGTERM; cgevent's OCR budget before OCR1), and SIGKILL this much later. */
export const OCR_HARD_MS = 60_000;
const OCR_KILL_GRACE_MS = 2000;
/** Real recognitions of one relay alive at once; each holds at most one capture folder. */
export const OCR_MAX_LIVE = 2;
const OCR_STDOUT_MAX = 1024 * 1024;   // execFile's default, stated
export const WARM_FRESH_MS = 10 * 60_000;
export const WARM_RETRY_MS = 3000;
export const WARM_MAX_TRIES = 40;
const WARM_RUN_MAX_MS = OCR_HARD_MS + OCR_KILL_GRACE_MS;
const GAP_MAX_MS = 30 * 24 * 3600_000;
const CLOCK_SKEW_MS = 1000;
export const WARM_IMAGE = fileURLToPath(new URL('./ocr-warm.png', import.meta.url));
/**
 * The input lock's path, as src/lock.js LOCK_DIR computes it, read when used. This module must not import lock.js:
 * bridge.js imports this module, and an import of lock.js fixes LOCK_DIR at that moment, before a test (or a caller)
 * has set CHROME_BRIDGE_LOCK.
 */
const lockDirNow = () => process.env.CHROME_BRIDGE_LOCK || path.join(os.homedir(), 'Library', 'Caches', 'chrome-bridge-mcp', 'input.lock');
/** Beside the input lock, never in it: the lock directory existing IS the input lock (src/lock.js), and its release removes it. */
export const ocrDir = () => lockDirNow() + '.ocr';
const STAMP = () => path.join(ocrDir(), 'last.json');
/** The freshness window a moment belongs to; its warm-up file is `warm-<window>.lock`. */
export const warmWindow = (now = Date.now()) => Math.floor(now / WARM_FRESH_MS);
const WARM_FILE = w => path.join(ocrDir(), `warm-${w}.lock`);
const WARM_NAME = /^warm-(\d+)\.lock$/;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* ------------------------------------------------------------------ jobs */

const LIVE = new Set();
/** Recognitions of this process still running (of one kind, or all). */
export function liveOcr(kind = null) {
  let n = 0;
  for (const j of LIVE) if (!kind || j.kind === kind) n++;
  return n;
}

/**
 * Start one recognition. Returns {busy, facts, done}: `done` never rejects; it resolves {result, failure, ms} once the
 * child has exited and the image has been given back. `retain()` (the capture's, bridge.js shotDir) is taken before the
 * child starts and released after it exits, whatever the outcome. `limit`: refuse (busy) past OCR_MAX_LIVE of this kind.
 * `record`: compute request facts and stamp the completion (relay calls; tests and scripts calling ocrImage directly do not).
 */
export function startOcrJob(file, { bin, langs = OCR_LANGS, maxPx = OCR_MAX_PX, retain = null, record = false, kind = 'real',
  limit = false, hardMs = OCR_HARD_MS, spawn = execFile } = {}) {
  const facts = record ? requestFacts() : null;
  if (limit && liveOcr(kind) >= OCR_MAX_LIVE) return { busy: true, facts, done: null };
  const release = typeof retain === 'function' ? retain() : null;
  const job = { kind, startedAt: Date.now(), child: null };
  LIVE.add(job);
  let killTimer = null;
  const exited = new Promise(resolve => {
    if (typeof retain === 'function' && !release) {
      resolve({ error: Object.assign(new Error('the capture was already disposed'), { code: 'EGONE' }) });
      return;
    }
    try {
      job.child = spawn(bin, ['ocr', String(file), '--langs', langs.join(','), '--max-px', String(maxPx)],
        { timeout: hardMs, maxBuffer: OCR_STDOUT_MAX }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      // A child that outlives its SIGTERM is killed outright.
      killTimer = setTimeout(() => { try { job.child.kill('SIGKILL'); } catch {} }, hardMs + OCR_KILL_GRACE_MS);
      killTimer.unref?.();
    } catch (error) { resolve({ error }); }
  });
  const done = exited.then(async ({ error, stdout = '', stderr = '' }) => {
    clearTimeout(killTimer);
    LIVE.delete(job);
    const ms = Date.now() - job.startedAt;
    let result = null, failure = null;
    if (error) {
      failure = { reason: error.code === 'ENOENT' ? 'missing' : error.code === 'EGONE' ? 'gone' : error.killed && error.signal ? 'killed' : 'exit',
        stdout: String(stdout || '').slice(0, 4096), stderr: String(stderr || '').slice(0, 400), message: String(error.message || '').slice(0, 400) };
    } else {
      try { result = JSON.parse(String(stdout).trim()); }
      catch { failure = { reason: 'malformed', stdout: '', stderr: '', message: 'unreadable OCR output' }; }
    }
    if (result && record) noteDone(kind, ms);
    if (release) await Promise.resolve().then(release).catch(() => {});
    return { result, failure, ms };
  });
  return { busy: false, facts, done };
}

/**
 * The caller's side of a bounded recognition: `settled` (the job's result or error), or {pending:'timeout'} once waitMs
 * passed. Past the budget nothing of `settled` is kept: its text is dropped, its failure handled here.
 */
export function withinBudget(settled, facts = null, waitMs = OCR_WAIT_MS) {
  settled.catch(() => {});
  let timer;
  const budget = new Promise(resolve => { timer = setTimeout(() => resolve({ pending: 'timeout', ...(facts ? { facts } : {}) }), waitMs); });
  return Promise.race([settled, budget]).finally(() => clearTimeout(timer));
}

// A relay that exits (session end, hot swap, signal) leaves no recognition running; bridge.js removes the capture folders.
process.on('exit', () => {
  for (const j of LIVE) { try { j.child?.kill('SIGKILL'); } catch {} }
});

/* ------------------------------------------------------------- telemetry */

/** The most recent completed OCR on this Mac, as the stamp says: {from, doneAt?, ms?} (definitions at the top). */
export function readStamp(now = Date.now()) {
  let raw;
  try { raw = readFileSync(STAMP(), 'utf8'); } catch (e) { return { from: e.code === 'ENOENT' ? 'none' : 'invalid' }; }
  let j = null;
  try { j = JSON.parse(raw); } catch {}
  if (!j || j.v !== 1 || !['real', 'warm'].includes(j.kind) || !Number.isSafeInteger(j.doneAt) || j.doneAt <= 0 ||
      j.doneAt > now + CLOCK_SKEW_MS || now - j.doneAt > GAP_MAX_MS) return { from: 'invalid' };
  const ms = Number.isSafeInteger(j.ms) && j.ms >= 0 && j.ms <= OCR_HARD_MS + OCR_KILL_GRACE_MS ? j.ms : null;
  return { from: j.kind, doneAt: j.doneAt, ms };
}

/** Numbers and fixed words about this request (definitions at the top); never text. */
export function requestFacts(now = Date.now()) {
  const s = readStamp(now);
  const f = { gapFrom: s.from, overlap: Math.min(99, liveOcr() + (warmElsewhere(now) ? 1 : 0)) };
  if (s.from === 'real' || s.from === 'warm') {
    f.gapMs = Math.max(0, now - s.doneAt);
    if (s.ms != null) f.prevMs = s.ms;
  }
  return f;
}

function noteDone(kind, ms) {
  try {
    mkdirSync(ocrDir(), { recursive: true, mode: 0o700 });
    const tmp = path.join(ocrDir(), `.last.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, JSON.stringify({ v: 1, doneAt: Date.now(), kind, ms }), { mode: 0o600 });
    renameSync(tmp, STAMP());
  } catch {}
}

/* --------------------------------------------------------------- warm-up */

const WARM = { running: false, file: null, timer: null, tries: 0 };
const fresh = (s, now) => (s.from === 'real' || s.from === 'warm') && now - s.doneAt < WARM_FRESH_MS;

/**
 * Is any relay's input session open? The input lock is a directory that exists exactly while a relay holds it; one whose
 * holder process is gone does not count. Anything unreadable counts as open: the warm-up waits.
 */
export function inputActive(lockDir = lockDirNow()) {
  try { statSync(lockDir); } catch (e) { return e.code !== 'ENOENT'; }
  let owner = null;
  try { owner = JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); } catch {}
  return !(owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && !pidAlive(owner.pid));
}

/** Another live relay's warm-up of the current window that has not finished. */
function warmElsewhere(now) {
  try {
    const j = JSON.parse(readFileSync(WARM_FILE(warmWindow(now)), 'utf8'));
    return j.pid !== process.pid && Number.isSafeInteger(j.pid) && pidAlive(j.pid) && j.doneAt == null && now - j.at < WARM_RUN_MAX_MS;
  } catch { return false; }
}

/**
 * Claim this window's warm-up: create `warm-<window>.lock` with O_CREAT|O_EXCL. Exactly one relay succeeds per window;
 * nobody removes, renames or takes over a file of the current or the previous window, so an owner that died simply leaves
 * that window without a warm-up. Returns the file, or null (claimed already, or the folder is unusable).
 */
function claimWarm(now) {
  const w = warmWindow(now);
  try { mkdirSync(ocrDir(), { recursive: true, mode: 0o700 }); } catch { return null; }
  pruneWarm(w);
  const file = WARM_FILE(w);
  let fd;
  try { fd = openSync(file, 'wx', 0o600); } catch { return null; }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, at: now })); } finally { closeSync(fd); }
  return file;
}

/**
 * Remove files of windows that ended at least one whole window ago: a claim always names its own current window (computed
 * in the same synchronous step), so such a file can no longer be claimed or owned. The file this relay is using is kept.
 */
function pruneWarm(w) {
  let names = [];
  try { names = readdirSync(ocrDir()); } catch { return; }
  for (const n of names) {
    const m = WARM_NAME.exec(n), file = path.join(ocrDir(), n);
    if (m && Number(m[1]) <= w - 2 && file !== WARM.file) { try { unlinkSync(file); } catch {} }
  }
}

/** The owner notes the end of its warm-up in its own file (the path never disappears: nobody can claim it meanwhile). */
function warmDone(file, at) {
  try { writeFileSync(file, JSON.stringify({ pid: process.pid, at, doneAt: Date.now() }), { mode: 0o600 }); } catch {}
}

function deferWarm(opts) {
  if (++WARM.tries > (opts.maxTries ?? WARM_MAX_TRIES)) { WARM.tries = 0; return 'gave_up'; }
  WARM.timer = setTimeout(() => { WARM.timer = null; maybeWarm(opts).catch(() => {}); }, opts.retryMs ?? WARM_RETRY_MS);
  WARM.timer.unref?.();
  return 'deferred';
}

/**
 * One warm-up recognition of the bundled image, if this Mac needs one. `launch()` runs it (production: bridge.js ocrImage
 * of WARM_IMAGE with `kind: 'warm', record: true`; its child, stamp and cleanup are the job's). Resolves a status word:
 * off | running | deferred | gave_up | fresh | busy | held | launched. While any relay holds the input lock it is
 * deferred and retried every WARM_RETRY_MS, WARM_MAX_TRIES times at most. Everything up to the claim is synchronous, so
 * the input check and the claim see the same moment. Never call it with await on a tool's path.
 */
export async function maybeWarm(opts = {}) {
  const { launch } = opts;
  if (typeof launch !== 'function') return 'off';
  if (WARM.running) return 'running';
  if (WARM.timer) return 'deferred';
  const now = Date.now();
  if (fresh(readStamp(now), now)) { WARM.tries = 0; return 'fresh'; }
  if (inputActive()) return deferWarm(opts);
  if (liveOcr() > 0) return 'busy';   // a recognition of this relay is running: it loads the same models
  const file = claimWarm(now);
  if (!file) return 'held';
  WARM.running = true; WARM.file = file; WARM.tries = 0;
  try { await launch(); } catch {}
  finally { warmDone(file, now); WARM.running = false; WARM.file = null; }
  return 'launched';
}
