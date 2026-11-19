/**
 * CC-LIVE: one read-only tail of this relay's own Claude Code conversation, for the connection's lifetime. The GUI
 * conversation centre shows its assistant prose and the user's typed prompts; the takeover sidebar shows the
 * assistant prose only (index.js filters at its subscription).
 *
 * Binding: the launch environment. The relay is a child of the Claude Code process, which set CLAUDE_CODE_SESSION_ID
 * in its environment; the source is ~/.claude/projects/<project>/<that id>.jsonl, exactly one regular, user-owned,
 * non-symlink file, inode pinned, read from its EOF at connect. A session writes that file on its first message, so a
 * missing file is looked up again (same id only) on each poll; a file that appears later is read from its start, but
 * only records stamped from 2 s before the lookup began (lateFileSlackMs).
 *
 * Currency and ambiguity: Claude Code's per-process registry ~/.claude/sessions/<client pid>.json (fields read: pid,
 * sessionId, updatedAt, status). A different sessionId written after this relay started means the session changed
 * under it (/clear): shown entries are cleared, nothing more of the old file is read, and the new id's file is
 * followed from its EOF. Two live processes registered with the bound id → binding_ambiguous, stop. Only names
 * matching ^\d+\.json$ are ever opened in that directory; the .key files beside them never are.
 *
 * Integrity: truncation or rewrite under the read position, replacement, an owner change, a symlink or a duplicate
 * file stop the source (never a seek to zero, never another file). Admission: assistant `text` blocks through
 * visibleProse(); the user's typed prompts (no tool results, no meta/compact/sidechain records, no machine-tagged
 * text). Dedupe by `uuid`; display key `message.id:apiBlockIndex`. Every collection is bounded.
 *
 * This module never writes, sends or spawns, and reads no environment variable but CLAUDE_CODE_SESSION_ID.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { visibleProse } from './visible-feed.js';

export const CLAUDE_FEED_LIMITS = Object.freeze({
  entries: 80,                  // shown entries, both roles (oldest dropped), as the Codex feed
  textChars: 24_000,            // one text; larger is not shown at all, as the Codex feed
  lineBytes: 1 << 20,           // one JSONL record; larger is skipped unparsed
  chunkBytes: 1 << 20,          // one read
  readBytesPerPoll: 8 << 20,    // reads per poll; the rest waits for the next poll
  seenUuids: 4096,              // dedupe memory
  subscribers: 8,               // GUI host + sidebar (+ tests); more are refused
  registryBytes: 64 * 1024,     // one ~/.claude/sessions/<pid>.json
  registryFiles: 512,           // registry entries looked at per ambiguity scan
});
export const CLAUDE_FEED_TIMING = Object.freeze({
  pollMs: 1000,                 // tail + registry poll
  ambiguityEveryMs: 5000,       // two-process scan of the registry directory
  lateFileSlackMs: 2000,        // a file that appears later: records stamped from this long before the lookup began
});

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGISTRY_NAME = /^\d+\.json$/;
const STATUSES = new Set(['idle', 'busy', 'waiting']);
/** Machine-written user records (slash-command echoes, `!` shell output, reminders) and interrupt markers. */
const NOT_TYPED = /^\s*(?:<[a-z][\w-]*>|\[Request interrupted)/i;

function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function aliveDefault(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/**
 * The transcript file for `sid`: exactly one `<root>/<dir>/<sid>.jsonl` (dir a real directory), a regular non-symlink
 * file owned by `uid`. `size` is its EOF now. `missing: true` when there is none yet (looked up again later).
 */
export function resolveClaudeTranscript({ sid, home, uid = process.getuid?.() } = {}) {
  if (typeof sid !== 'string' || !SESSION_ID.test(sid)) return { ok: false, reason: 'transcript_unavailable' };
  if (typeof home !== 'string' || !path.isAbsolute(home)) return { ok: false, reason: 'transcript_unavailable' };
  const root = path.join(home, '.claude', 'projects');
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return { ok: false, reason: 'transcript_unavailable', missing: true }; }
  const found = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;   // symlinked directories are not followed
    const file = path.join(root, dir.name, `${sid}.jsonl`);
    let st;
    try { st = lstatSync(file); } catch { continue; }
    found.push({ file, st });
    if (found.length > 1) return { ok: false, reason: 'transcript_ambiguous' };
  }
  if (!found.length) return { ok: false, reason: 'transcript_unavailable', missing: true };
  const { file, st } = found[0];
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: 'transcript_not_regular' };
  if (!Number.isInteger(uid) || st.uid !== uid) return { ok: false, reason: 'transcript_owner' };
  return { ok: true, file, sid, dev: st.dev, ino: st.ino, size: st.size, uid };
}

/** One registry file: { pid, sessionId, updatedAt, status } or null. Nothing else is kept. */
function readRegistryFile(file, uid, maxBytes) {
  let fd = null;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || st.size > maxBytes) return null;
    const buffer = Buffer.alloc(st.size);
    if (readSync(fd, buffer, 0, st.size, 0) !== st.size) return null;
    const j = JSON.parse(buffer.toString('utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    return {
      pid: Number.isSafeInteger(j.pid) ? j.pid : null,
      sessionId: typeof j.sessionId === 'string' && SESSION_ID.test(j.sessionId) ? j.sessionId : null,
      updatedAt: Number.isFinite(j.updatedAt) ? j.updatedAt : null,
      status: STATUSES.has(j.status) ? j.status : null,
    };
  } catch { return null; } finally { if (fd !== null) { try { closeSync(fd); } catch {} } }
}

/** This relay's client process entry, ~/.claude/sessions/<pid>.json, opened by exact name. */
export function readClaudeRegistry({ home, pid, uid = process.getuid?.(), maxBytes = CLAUDE_FEED_LIMITS.registryBytes } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || typeof home !== 'string' || !path.isAbsolute(home)) return null;
  return readRegistryFile(path.join(home, '.claude', 'sessions', `${pid}.json`), uid, maxBytes);
}

/** Live processes whose registry entry names `sid`. Opens only ^\d+\.json$ names; never a .key file. */
export function claudeRegistryHolders({ home, sid, uid = process.getuid?.(), isAlive = aliveDefault, limits = CLAUDE_FEED_LIMITS } = {}) {
  let names;
  try { names = readdirSync(path.join(home, '.claude', 'sessions')); } catch { return 0; }
  let holders = 0, looked = 0;
  for (const name of names) {
    if (!REGISTRY_NAME.test(name)) continue;
    if (++looked > limits.registryFiles) break;
    const pid = Number(name.slice(0, -5));
    const entry = readRegistryFile(path.join(home, '.claude', 'sessions', name), uid, limits.registryBytes);
    if (entry && entry.pid === pid && entry.sessionId === sid && isAlive(pid)) holders++;
  }
  return holders;
}

/**
 * The connection-lifetime source. Returns { snapshot(), subscribe(listener) → unsubscribe, poll(), close() }.
 * snapshot(): { status, reason, canSend:false, sessionId, threadStatus, entries:[{ id, role, text, at }] }.
 */
export function connectClaudeSource({
  env = process.env, home, clientPid = null, uid = process.getuid?.(), startedAt = Date.now(), onChange = () => {},
  limits = {}, timing = {}, now = () => Date.now(), setInterval: every = setInterval, clearInterval: stopEvery = clearInterval,
  isAlive = aliveDefault,
} = {}) {
  const L = { ...CLAUDE_FEED_LIMITS, ...limits }, T = { ...CLAUDE_FEED_TIMING, ...timing };
  const entries = new Map();          // display key → { id, role, text, at }
  const seen = new Set();             // record uuids already taken
  const listeners = new Set();
  let status = 'connected', reason = null, threadStatus = null, stopped = false, closed = false, revision = 0;
  let sid = env.CLAUDE_CODE_SESSION_ID, t = null, floor = null, awaiting = false, lastScan = -Infinity;
  let fd = null, timer = null, offset = 0, partial = [], partialBytes = 0, skipping = false;
  let tail = Buffer.alloc(0);         // the last bytes before `offset`: a rewrite under them is a truncation
  const TAIL = 64;

  function snapshot() {
    return { status, reason, canSend: false, sessionId: sid ?? null, threadStatus,
      entries: [...entries.values()].map(e => ({ id: e.id, role: e.role, text: e.text, at: e.at })) };
  }
  function changed() {
    revision++;
    for (const listener of listeners) { try { listener(); } catch {} }
    try { onChange(); } catch {}
  }
  function release() {
    if (fd !== null) { try { closeSync(fd); } catch {} fd = null; }
    partial = []; partialBytes = 0; skipping = false; offset = 0; tail = Buffer.alloc(0);
  }
  function clear() { entries.clear(); seen.clear(); }
  function stop(why) {
    if (stopped) return;
    stopped = true;
    status = 'unavailable'; reason = why;
    clear(); release();
    if (timer) { stopEvery(timer); timer = null; }
  }
  function readTail() {
    const want = Math.min(TAIL, offset), out = Buffer.alloc(want);
    return want === 0 || readSync(fd, out, 0, want, offset - want) === want ? out : null;
  }
  /** Bind to `sid`'s file: from its EOF when it exists, else wait for it (records stamped from `since` − 2 s only). */
  function bind(since) {
    release();
    t = null; awaiting = false; floor = null;
    const found = resolveClaudeTranscript({ sid, home, uid });
    if (!found.ok && found.missing) { awaiting = true; floor = since - T.lateFileSlackMs; return true; }
    if (!found.ok) { stop(found.reason); return false; }
    return pin(found, found.size);
  }
  function pin(found, from) {
    try {
      fd = openSync(found.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.dev !== found.dev || st.ino !== found.ino) { stop('transcript_replaced'); return false; }
      if (st.uid !== found.uid) { stop('transcript_owner'); return false; }
      if (st.size < from) { stop('transcript_truncated'); return false; }
      t = found; offset = from;
      tail = readTail() ?? Buffer.alloc(0);
      // A boundary inside a record: that record began before the boundary, so it is skipped to its end.
      skipping = tail.length > 0 && tail[tail.length - 1] !== 0x0a;
      return true;
    } catch { stop('transcript_unavailable'); return false; }
  }

  function userText(record) {
    if (record.message?.role !== 'user' || record.isMeta === true || record.isCompactSummary === true
        || Object.hasOwn(record, 'toolUseResult')) return null;
    const content = record.message.content;
    let text;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content) && content.length > 0
        && content.every(block => block?.type === 'text' && typeof block.text === 'string')) {
      text = content.map(block => block.text).join('\n');
    } else return null;
    if (text.length > L.textChars || NOT_TYPED.test(text)) return null;
    return text;
  }
  function admit(entry) {
    if (!entry.text.trim()) return;
    const shown = entries.get(entry.id);
    if (shown) shown.text = entry.text;
    else entries.set(entry.id, entry);
    while (entries.size > L.entries) entries.delete(entries.keys().next().value);
    revision++;
  }
  function take(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    if (record.sessionId !== sid || record.isSidechain === true) return;
    const at = Date.parse(record.timestamp);
    if (floor !== null && !(at >= floor)) return;
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      if (entries.size) revision++;
      entries.clear();
      return;
    }
    if (!validId(record.uuid)) return;
    if (record.type === 'user') {
      const text = userText(record);
      if (text === null || seen.has(record.uuid)) return;
      remember(record.uuid);
      admit({ id: `user:${record.uuid}`, role: 'user', text: visibleProse(text), at: Number.isFinite(at) ? at : null });
      return;
    }
    if (record.type !== 'assistant' || record.message?.role !== 'assistant'
        || record.isApiErrorMessage === true || record.isMeta === true) return;
    const content = record.message.content;
    if (!Array.isArray(content) || seen.has(record.uuid)) return;
    remember(record.uuid);
    const messageId = validId(record.message.id) ? record.message.id : null;
    content.forEach((block, index) => {
      if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > L.textChars) return;
      const key = messageId && content.length === 1 && Number.isSafeInteger(record.apiBlockIndex) && record.apiBlockIndex >= 0
        ? `${messageId}:${record.apiBlockIndex}` : `${record.uuid}:${index}`;
      admit({ id: key, role: 'assistant', text: visibleProse(block.text), at: Number.isFinite(at) ? at : null });
    });
  }
  function remember(uuid) {
    seen.add(uuid);
    if (seen.size > L.seenUuids) seen.delete(seen.values().next().value);
  }
  function line(buffer) {
    let record;
    try { record = JSON.parse(buffer.toString('utf8')); } catch { return; }
    take(record);
  }
  function bytes(chunk) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) break;
      const piece = chunk.subarray(start, nl);
      if (skipping) skipping = false;
      else if (partialBytes + piece.length <= L.lineBytes) line(partial.length ? Buffer.concat([...partial, piece]) : piece);
      partial = []; partialBytes = 0;
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    if (!rest.length || skipping) return;
    if (partialBytes + rest.length > L.lineBytes) { partial = []; partialBytes = 0; skipping = true; return; }
    partial.push(Buffer.from(rest)); partialBytes += rest.length;
  }

  /** Claude Code's own entry for the client process: status, and whether the session changed under this relay. */
  function currency(at) {
    const entry = readClaudeRegistry({ home, pid: clientPid, uid, maxBytes: L.registryBytes });
    if (!entry || entry.pid !== clientPid || !entry.sessionId) return true;   // a hint only: the launch id stands
    if (entry.sessionId === sid) { threadStatus = entry.status; return true; }
    if (!(entry.updatedAt > startedAt)) return true;                          // an earlier process with this pid
    // The session changed (/clear): drop everything of the old one before reading anything of the new one.
    clear(); revision++;
    sid = entry.sessionId; threadStatus = entry.status;
    if (!bind(at)) { reason = 'session_changed'; return false; }
    lastScan = -Infinity;
    return true;
  }
  function ambiguity(at) {
    if (at - lastScan < T.ambiguityEveryMs) return true;
    lastScan = at;
    if (claudeRegistryHolders({ home, sid, uid, isAlive, limits: L }) < 2) return true;
    stop('binding_ambiguous');
    return false;
  }
  function read() {
    if (awaiting) {
      const found = resolveClaudeTranscript({ sid, home, uid });
      if (!found.ok && found.missing) return;
      if (!found.ok) { stop(found.reason); return; }
      awaiting = false;
      if (!pin(found, 0)) return;   // appeared after the lookup began: from its start, records after `floor` only
    }
    const link = lstatSync(t.file);
    if (link.isSymbolicLink() || !link.isFile() || link.dev !== t.dev || link.ino !== t.ino) { stop('transcript_replaced'); return; }
    const st = fstatSync(fd);
    if (st.uid !== t.uid || link.uid !== t.uid) { stop('transcript_owner'); return; }
    if (st.size < offset || !readTail()?.equals(tail)) { stop('transcript_truncated'); return; }
    let budget = L.readBytesPerPoll;
    const chunk = Buffer.alloc(Math.min(L.chunkBytes, budget));
    while (budget > 0 && offset < st.size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, budget, st.size - offset), offset);
      if (n <= 0) break;
      offset += n; budget -= n;
      tail = n >= TAIL ? Buffer.from(chunk.subarray(n - TAIL, n)) : Buffer.concat([tail, chunk.subarray(0, n)]).subarray(-TAIL);
      bytes(chunk.subarray(0, n));
    }
  }
  function poll() {
    if (stopped || closed) return snapshot();
    const before = `${status}:${reason}:${threadStatus}:${revision}`;
    const at = now();
    try {
      if (currency(at) && ambiguity(at) && !stopped) read();
    } catch { stop('transcript_unavailable'); }
    if (`${status}:${reason}:${threadStatus}:${revision}` !== before) changed();
    return snapshot();
  }

  if (typeof sid !== 'string' || !SESSION_ID.test(sid)) stop('transcript_unavailable');
  else if (bind(startedAt) && !stopped) {
    timer = every(poll, T.pollMs);
    timer?.unref?.();
    poll();
  }
  return {
    snapshot,
    poll,
    /** Sizes of the bounded bookkeeping (numbers only; tests and diagnostics). */
    stats: () => ({ entries: entries.size, seen: seen.size, listeners: listeners.size, partialBytes }),
    /** A bounded set of observers (GUI host, sidebar); each gets a call when the snapshot changes. */
    subscribe(listener) {
      if (typeof listener !== 'function' || closed || listeners.size >= L.subscribers) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) { stopEvery(timer); timer = null; }
      release(); listeners.clear();
    },
  };
}
