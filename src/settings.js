/**
 * The settings the menu-bar panel changes (src/menubar.swift, page 「设置」), for people who do not edit
 * MCP configs (owner 2026-10-14: the panel shows and sets too little for someone who does not code).
 *
 * One JSON file, ~/Library/Application Support/chrome-bridge-mcp/settings.json (CHROME_BRIDGE_SETTINGS
 * overrides). Every server reads it again when it changes (mtime), so a change applies to the next
 * action without a restart. A CHROME_BRIDGE_* variable set in the MCP config wins over the file; the
 * panel then shows that setting as fixed by the config (servers report which ones: presence files).
 *
 * Also here: the presence file each server keeps for the panel (servers/<pid>.json) and the activity
 * log (activity.jsonl): what the AI did, when, on which site and whether it worked. Never what was
 * typed, never a full URL or a page title: the host name only.
 */
import { readFileSync, statSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, rmdirSync, writeFileSync, mkdirSync, appendFileSync, renameSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'chrome-bridge-mcp');
/** A path override from the environment, with ~ expanded as the panel does (Codex r13 B3). */
const envPath = (v, def) => !v ? def : v === '~' ? os.homedir() : v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v;
export const settingsPath = (env = process.env) => envPath(env.CHROME_BRIDGE_SETTINGS, path.join(SUPPORT_DIR, 'settings.json'));

const PAUSE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Independent of JSON and its write lock. Only our zero-byte UUID files count. */
function pauseTokens(file) {
  const dir = `${file}.paused`;
  try {
    const directory = lstatSync(dir);
    if (!directory.isDirectory() || directory.uid !== process.getuid()) return [];
    return readdirSync(dir).filter(name => {
      if (!PAUSE_TOKEN.test(name)) return false;
      try {
        const entry = lstatSync(path.join(dir, name));
        return entry.isFile() && entry.size === 0 && entry.uid === process.getuid();
      } catch { return false; }
    });
  } catch { return []; }
}
function requestPause(file) {
  const dir = `${file}.paused`;
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.uid !== process.getuid()) throw new Error('pause_unavailable');
  const token = randomUUID();
  writeFileSync(path.join(dir, token), '', { flag: 'wx', mode: 0o600 });
  return token;
}

/**
 * key: { env, def, parse(raw) -> value | undefined (bad: ignored) }. The file holds the values as the
 * panel writes them; the env variable keeps its own old spelling (TAKEOVER=0, TAB_TTL_MIN=10...).
 */
// File values must have the JSON type (true, not 1; 3, not "3"): the panel reads them the same strict way.
const oneOf = (...xs) => (v) => xs.includes(v) ? v : undefined;
const num = (lo, hi) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
const bool = (v) => v === true || v === false ? v : undefined;
// Env values are strings.
const envNum = (lo, hi) => (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) >= lo && Number(v) <= hi ? Number(v) : undefined;
const envBool = (v) => v === '0' ? false : v === '1' ? true : undefined;
export const INPUT_SPEEDS = [0.5, 0.75, 1, 1.5, 2, 3];
export const SETTINGS = {
  /** Every tool but list_tabs refuses while true (the panel's 「暂停 AI 操作」). */
  paused: { env: null, def: false, file: bool },
  /** Where the agent's window goes: the display the user is not on / always the secondary / the main one / the user's own window. */
  agentDisplay: { env: 'CHROME_BRIDGE_AGENT_DISPLAY', def: 'away', file: oneOf('away', 'secondary', 'main', 'off'), fromEnv: oneOf('away', 'secondary', 'main', 'off') },
  /** Seconds the user's keys must rest before a takeover. */
  idleSeconds: { env: 'CHROME_BRIDGE_IDLE_S', def: 1.5, file: num(0.5, 10), fromEnv: envNum(0, 60) },
  /** An explicit user choice overrides an agent's input_mode; the default preserves the tool choice. */
  inputMode: { env: 'CHROME_BRIDGE_INPUT_MODE', def: 'auto', file: oneOf('auto', 'keys', 'paste'), fromEnv: oneOf('auto', 'keys', 'paste') },
  /** The native human timing model's pace, including keyboard and pointer operations. */
  inputSpeed: { env: 'CHROME_BRIDGE_INPUT_SPEED', def: 1, file: oneOf(...INPUT_SPEEDS),
    fromEnv: v => /^\d+(\.\d+)?$/.test(v) ? oneOf(...INPUT_SPEEDS)(Number(v)) : undefined },
  /** Minutes an agent tab may stay unused before the sweep closes it; 0 = never by age. */
  tabIdleMinutes: { env: 'CHROME_BRIDGE_TAB_TTL_MIN', def: 10, file: num(0, 24 * 60), fromEnv: envNum(0, 1e6) },
  /** System notifications (keys held during an action, a site that needs the user). */
  notify: { env: 'CHROME_BRIDGE_NOTIFY', def: true, file: bool, fromEnv: envBool },
  /** Keep the activity log for the panel's 「记录」 page. */
  activityLog: { env: null, def: true, file: bool }
};

let cache = { path: null, mtimeMs: -1, size: -1, data: {} };
/** The file as last read; re-read when its mtime or size changes. A missing or broken file is {}. */
export function readSettingsFile(env = process.env) {
  const p = settingsPath(env);
  let st = null;
  try { st = statSync(p); } catch {}
  if (!st) { cache = { path: p, mtimeMs: -1, size: -1, data: {} }; return cache.data; }
  if (cache.path === p && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.data;
  let data = {};
  try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) data = j; } catch {}
  cache = { path: p, mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

/** {value, source: 'env' | 'file' | 'default' | 'emergency'}. */
export function setting(key, env = process.env) {
  const s = SETTINGS[key];
  if (!s) throw new Error(`unknown setting ${key}`);
  if (key === 'paused' && pauseTokens(settingsPath(env)).length) return { value: true, source: 'emergency' };
  if (s.env && env[s.env] != null && String(env[s.env]).trim() !== '') {
    const v = s.fromEnv(String(env[s.env]).trim());
    if (v !== undefined) return { value: v, source: 'env' };
  }
  const f = readSettingsFile(env);
  if (Object.prototype.hasOwnProperty.call(f, key)) {
    const v = s.file(f[key]);
    if (v !== undefined) return { value: v, source: 'file' };
  }
  return { value: s.def, source: 'default' };
}
export const get = (key, env = process.env) => setting(key, env).value;

/** The settings an env variable fixes in this process, with their values (the panel shows them as fixed). */
export const envLocked = (env = process.env) =>
  Object.fromEntries(Object.keys(SETTINGS).map(k => [k, setting(k, env)]).filter(([, x]) => x.source === 'env').map(([k, x]) => [k, x.value]));

/** Same symlink protocol as both native writers. Never reclaim by age. */
function withSettingsWriteLock(file, write) {
  const lock = `${file}.write-lock`, recovery = `${file}.write-recovery`;
  const token = `${process.pid}:${randomUUID()}`;
  const owner = () => { try { return readlinkSync(lock); } catch { return null; } };
  const dead = value => {
    const match = /^(\d+):[0-9a-f-]{36}$/i.exec(value ?? '');
    const pid = match && Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
    try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
  };
  const until = Date.now() + 500;
  for (;;) {
    try { symlinkSync(token, lock); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (dead(owner())) {
      let claimed = false;
      try {
        mkdirSync(recovery, { mode: 0o700 }); claimed = true;
        // Another cleaner may already have freed the old lock. Re-read while
        // exclusively cleaning; an alive new writer can never be removed.
        if (dead(owner())) unlinkSync(lock);
      } catch { /* Busy or unknown recovery state stays closed. */ }
      finally { if (claimed) { try { rmdirSync(recovery); } catch {} } }
    }
    if (Date.now() >= until) throw Object.assign(new Error('settings_busy'), { code: 'settings_busy' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  try { return write(); }
  finally { if (owner() === token) unlinkSync(lock); }
}

/** Read under the write lock, without the UI read cache's permissive fallback. */
function settingsForWrite(file) {
  let data;
  try { data = readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') {
      try { lstatSync(file); } catch (missing) { if (missing.code === 'ENOENT') return {}; }
    }
    throw Object.assign(new Error('settings_unreadable'), { code: 'settings_unreadable' });
  }
  try {
    const value = JSON.parse(data);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw Object.assign(new Error('settings_invalid'), { code: 'settings_invalid' });
}

/** Change settings atomically under the shared native/Node lock. Bad data is never replaced. */
export function writeSettings(patch, env = process.env) {
  for (const [k, v] of Object.entries(patch)) {
    if (!SETTINGS[k]) throw new Error(`unknown setting ${k}`);
    if (SETTINGS[k].file(v) === undefined) throw new Error(`bad value for ${k}: ${JSON.stringify(v)}`);
  }
  const p = settingsPath(env);
  mkdirSync(path.dirname(p), { recursive: true });
  const token = patch.paused === true ? requestPause(p) : null;
  const observed = patch.paused === false ? pauseTokens(p) : [];
  try {
    withSettingsWriteLock(p, () => {
      const effective = { ...patch };
      // A delayed pause save must not resurrect a request already resumed.
      if (token && !pauseTokens(p).includes(token)) delete effective.paused;
      if (!Object.keys(effective).length) return;
      const cur = settingsForWrite(p), tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ ...cur, ...effective, version: 1 }, null, 2), { mode: 0o600 });
        renameSync(tmp, p);
      } finally { try { unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      const remaining = new Set(pauseTokens(p));
      for (const name of observed) if (remaining.has(name)) {
        try { unlinkSync(path.join(`${p}.paused`, name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    });
  } catch (error) {
    // A standalone pause already succeeded through its independent token.
    // Other preference writes and every failed resume still report failure.
    if (!token || Object.keys(patch).length !== 1) throw error;
  }
  cache = { path: null, mtimeMs: -1, size: -1, data: {} };
  const result = readSettingsFile(env);
  return pauseTokens(p).length ? { ...result, paused: true } : result;
}

/* ------------------------------------------------------- presence (servers/<pid>.json) */

/** Where the panel looks for the servers (next to tasks/, under the lock's folder). */
export const serversDir = (lockDir) => path.join(path.dirname(lockDir), 'servers');

/** Write this server's presence; fields merge into what was written before. Never throws. */
let presence = {};
export function writePresence(lockDir, fields, pid = process.pid) {
  presence = { ...presence, ...fields, pid, at: Date.now() };
  try {
    const dir = serversDir(lockDir);
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${pid}.json`), tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(presence));
    renameSync(tmp, p);
  } catch {}
}
export function removePresence(lockDir, pid = process.pid) {
  try { rmSync(path.join(serversDir(lockDir), `${pid}.json`), { force: true }); } catch {}
}

/**
 * What the server runs: the JS modules in src/ (page scripts are read at each use, the helpers are
 * started per action, the panel replaces itself). The panel hashes the same files the same way and
 * shows 「需要重启」 when they differ (Codex r13 A4: uncommitted edits; Fable r13 A3: a panel-only commit).
 * sha256 over "<name>\0<bytes>\0" for each src/*.js in name order; the first 16 hex digits.
 */
export function sourceFingerprint(root) {
  const dir = path.join(root, 'src');
  const h = createHash('sha256');
  for (const n of readdirSync(dir).filter(n => n.endsWith('.js')).sort()) {
    h.update(n); h.update('\0'); h.update(readFileSync(path.join(dir, n))); h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Another live server of the same app has a setup check at least as new as `since` (one answer per app):
 * that check (the newest), or null. A session that skips its own check keeps a copy (Codex r13 r4 A1).
 */
export function freshCheckFor(lockDir, app, since, selfPid = process.pid) {
  let names = [], best = null;
  try { names = readdirSync(serversDir(lockDir)); } catch { return null; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(serversDir(lockDir), n), 'utf8'));
      if (j.pid === selfPid || !j.checks || j.checks.app !== app || !(j.checks.at >= since)) continue;
      try { process.kill(j.pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; }
      if (!best || j.checks.at > best.at) best = j.checks;
    } catch {}
  }
  return best;
}

/**
 * Claim one panel request for one app (mkdir is atomic): true for the first session of that app only.
 * Claims older than a minute are removed by the next claim.
 */
export function claimCheck(lockDir, app, at) {
  const dir = path.join(path.dirname(lockDir), 'check-claims');
  const key = createHash('sha256').update(String(app)).digest('hex').slice(0, 12);
  try {
    mkdirSync(dir, { recursive: true });
    for (const n of readdirSync(dir)) {
      try { if (Date.now() - statSync(path.join(dir, n)).mtimeMs > 60_000) rmSync(path.join(dir, n), { recursive: true, force: true }); } catch {}
    }
    mkdirSync(path.join(dir, `${key}-${Math.round(at)}`));
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------- activity log */

export const activityPath = (env = process.env) => envPath(env.CHROME_BRIDGE_ACTIVITY, path.join(SUPPORT_DIR, 'activity.jsonl'));
/** The previous file: past ACTIVITY_MAX_BYTES the log is renamed to it and a new one starts (so 2 × the cap at most). */
export const activityOldPath = (p) => p.replace(/(\.jsonl)?$/, '.1.jsonl');
export const ACTIVITY_MAX_BYTES = 256 * 1024;

/** Tools that change nothing and say nothing about a site: not logged. */
const NOT_LOGGED = new Set(['list_tabs', 'task_plan', 'wake_screen']);

/** The host of a URL, nothing else (no path, no query: they can hold names, ids, search words). */
export function hostOf(url) {
  try { const u = new URL(String(url)); return /^https?:$/.test(u.protocol) ? u.hostname : u.protocol.replace(/:$/, ''); } catch { return null; }
}

/**
 * The line logged for one tool call: only these fields, whatever the tool was given. `text` of
 * type_text, `url` paths, keys pressed, page titles never reach the file.
 */
export function activityRecord({ tool, host = null, ok, code = null, ms = null, who = null, color = 0, pid = process.pid, t = Date.now() }) {
  return { t, pid, who: who == null ? null : String(who).slice(0, 80), color: Number(color) || 0, tool: String(tool),
    host: host == null ? null : String(host).slice(0, 253), ok: !!ok, code: code == null ? null : String(code).slice(0, 40),
    ms: Number.isFinite(ms) ? Math.round(ms) : null };
}

export function logActivity(rec, env = process.env) {
  if (NOT_LOGGED.has(rec.tool) || !get('activityLog', env)) return false;
  const p = activityPath(env);
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(activityRecord(rec)) + '\n', { mode: 0o600 });
    try { chmodSync(p, 0o600); } catch {}
    let size = 0;
    try { size = statSync(p).size; } catch {}
    if (size > ACTIVITY_MAX_BYTES) rotateActivity(p);
    return true;
  } catch { return false; }
}

/**
 * Rename, never rewrite: several servers append to the log, and a read-trim-rename would drop the lines
 * another one appended meanwhile (Codex/Fable r13 B). A line appended during the rename lands in one file
 * or the other. One server rotates at a time (a lock directory; one left by a crash is taken after 10 s).
 */
function rotateActivity(p) {
  const lock = `${p}.lock`;
  try { mkdirSync(lock); } catch {
    try { if (Date.now() - statSync(lock).mtimeMs < 10_000) return; rmSync(lock, { recursive: true, force: true }); mkdirSync(lock); } catch { return; }
  }
  try {
    let size = 0;
    try { size = statSync(p).size; } catch {}
    if (size > ACTIVITY_MAX_BYTES) renameSync(p, activityOldPath(p));
  } catch {} finally { try { rmSync(lock, { recursive: true, force: true }); } catch {} }
}
