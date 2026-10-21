/** Local site routines. Captured values never reach disk; only static descriptors and parameters do. */
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, symlink, readlink, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { settingsPath } from './settings.js';

export const ROUTINE_LIMITS = Object.freeze({ events: 2000, routines: 200, runs: 100, steps: 50, candidates: 100, occurrences: 20 });
const TOOLS = new Set(['click', 'hover', 'type_text', 'select_option', 'press_key', 'scroll']);
const TARGETED = new Set(['click', 'hover', 'type_text', 'select_option', 'press_key']);
const KEYS = new Set(['escape', 'enter', 'tab', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'space', 'backspace']);
const STATUSES = new Set(['running', 'completed', 'blocked', 'cancelled', 'failed']);
const REASONS = new Set(['unsupported_tool', 'action_failed', 'sensitive_target', 'missing_descriptor', 'invalid_location', 'cross_site', 'invalid_arguments', 'not_replayable', 'in_progress', 'recording_disabled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const TOKEN = /^[a-zA-Z0-9_-]{1,128}$/;
const SENSITIVE = /password|passcode|one[\s_-]*time|verification[\s_-]*code|security[\s_-]*code|captcha|api[\s_-]*key|access[\s_-]*token|secret|验证码|密码/i;
const SECRET_KEY = /^(?:token|access[-_]?token|refresh[-_]?token|secret|password|passcode|otp|code|auth|authorization|session|sessionid|reset|reset[-_]?password)$/i;
const error = code => Object.assign(new Error(code), { code });
const hash = s => createHash('sha256').update(s).digest('hex');
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const text = (v, limit = 160) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const clone = v => structuredClone(v);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ownKeys = (o, keys) => plain(o) && Object.keys(o).every(k => keys.includes(k));
const sensitive = e => e.sensitive === true || e.target?.sensitive === true || ['password', 'hidden'].includes(e.target?.type) || SENSITIVE.test(['name', 'id', 'testId', 'type'].map(k => e.target?.[k] ?? '').join(' '));
const hasSecret = value => /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value) || /\d{6,}/.test(value)
  || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/.test(value)
  || /(?:token|secret|password|authorization|otp|code)\s*[:=]\s*\S+/i.test(value)
  || /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+\b/.test(value);

function origin(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
}

function cleanPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  // Keep hash-router paths, never a query or a non-route fragment.
  const [base, fragment] = value.split('#');
  let result = base.split('?')[0];
  if (/^!?\//.test(fragment ?? '')) result += `#${fragment.split('?')[0]}`;
  if (result.length > 1024 || /(?:\[redacted\]|:redacted)/i.test(result)) return null;
  let previousSecret = false;
  for (const part of result.replace(/#!?\//, '/').split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { return null; }
    if (previousSecret || hasSecret(decoded) || /[%\\/?#\u0000-\u0020\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(decoded)) return null;
    previousSecret = SECRET_KEY.test(decoded);
  }
  return result || '/';
}

function location(value) {
  if (!plain(value)) return null;
  const o = origin(value.origin), p = cleanPath(value.path);
  if (!o || !p) return null;
  const result = { origin: o, path: p };
  for (const key of ['fingerprint', 'queryHash']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !HEX.test(value[key])) return null;
    result[key] = value[key];
  }
  return result;
}

function descriptor(value) {
  if (!plain(value) || value.version !== 1 || !/^[a-z][a-z0-9-]{0,30}$/.test(value.tag ?? '') || typeof value.role !== 'string' || typeof value.name !== 'string') return null;
  if (['role', 'name', 'id', 'testId', 'type'].some(k => typeof value[k] === 'string' && hasSecret(value[k]))) return null;
  const result = { version: 1, tag: value.tag, role: text(value.role, 40), name: text(value.name) };
  for (const k of ['id', 'testId', 'type']) if (typeof value[k] === 'string' && text(value[k])) result[k] = text(value[k], k === 'type' ? 40 : 160);
  if (typeof value.href === 'string') {
    try {
      const u = new URL(value.href), loc = location({ origin: value.href, path: `${u.pathname}${u.hash}` });
      if (loc) result.href = `${loc.origin}${loc.path}`;
    } catch { /* A malformed link is never persisted. */ }
  }
  if (value.hrefQueryHash !== undefined) {
    if (!result.href || typeof value.hrefQueryHash !== 'string' || !HEX.test(value.hrefQueryHash)) return null;
    result.hrefQueryHash = value.hrefQueryHash;
  }
  if (!result.name && !result.id && !result.testId && !result.href) return null;
  return result;
}

function targetState(value) {
  if (!plain(value)) return undefined;
  const result = {};
  for (const k of ['disabled', 'checked', 'expanded', 'selected', 'focused']) if (typeof value[k] === 'boolean') result[k] = value[k];
  return Object.keys(result).length ? result : undefined;
}

function argumentsFor(tool, value = {}) {
  const a = plain(value) ? value : {};
  if (tool === 'click' || tool === 'hover') return {};
  if (tool === 'type_text') {
    const result = { textParam: 'input_1' };
    if (typeof a.submit === 'boolean') result.submit = a.submit;
    if (['keys', 'paste', 'auto'].includes(a.input_mode)) result.input_mode = a.input_mode;
    return result;
  }
  if (tool === 'select_option') return { valueParam: 'option_1' };
  if (tool === 'press_key' && KEYS.has(a.key) && (a.times === undefined || integer(a.times, 1, 20))) return { key: a.key, times: a.times ?? 1 };
  if (tool === 'scroll' && ['up', 'down'].includes(a.direction) && (a.amount === undefined || (typeof a.amount === 'number' && Number.isFinite(a.amount) && a.amount >= 0.1 && a.amount <= 20))) return { direction: a.direction, amount: a.amount ?? 1 };
  return null;
}

function sanitizedEvent(raw, sessionId, epoch, seq) {
  const e = plain(raw) ? raw : {};
  const tool = typeof e.tool === 'string' && /^[a-z_]{1,40}$/.test(e.tool) ? e.tool : 'unknown';
  const before = location(e.before), after = location(e.after), target = descriptor(e.target);
  const args = argumentsFor(tool, e.args);
  let reason;
  if (!TOOLS.has(tool)) reason = 'unsupported_tool';
  else if (e.ok !== true) reason = 'action_failed';
  else if (!before || !after) reason = 'invalid_location';
  else if (before.origin !== after.origin) reason = 'cross_site';
  else if (sensitive(e)) reason = 'sensitive_target';
  else if (TARGETED.has(tool) && !target) reason = 'missing_descriptor';
  else if (!args) reason = 'invalid_arguments';
  else if (e.replayable === false) reason = 'not_replayable';
  const result = {
    id: randomUUID(), sessionId, tab: integer(e.tab, 0, Number.MAX_SAFE_INTEGER) ? e.tab : null,
    seq, epoch, at: Date.now(), site: before?.origin ?? after?.origin ?? null,
    tool, before, after, args: args ?? {}, ok: e.ok === true, replayable: !reason
  };
  if (result.tab === null && !reason) reason = 'invalid_arguments';
  if (reason) { result.replayable = false; result.reason = reason; }
  if (target && !sensitive(e)) result.target = target;
  for (const k of ['targetState', 'afterState']) { const s = targetState(e[k]); if (s) result[k] = s; }
  if (typeof e.task === 'string' && e.task) result.taskHash = hash(e.task);
  if (typeof e.code === 'string' && CODE.test(e.code)) result.code = e.code;
  return result;
}

function makeSteps(events) {
  let inputs = 0, options = 0;
  const parameters = [];
  const steps = events.map(e => {
    const args = clone(e.args);
    if (e.tool === 'type_text') { args.textParam = `input_${++inputs}`; parameters.push({ name: args.textParam, label: e.target?.name || `Input ${inputs}` }); }
    if (e.tool === 'select_option') { args.valueParam = `option_${++options}`; parameters.push({ name: args.valueParam, label: e.target?.name || `Selection ${options}` }); }
    const step = { tool: e.tool, before: clone(e.before), after: clone(e.after), args };
    for (const k of ['target', 'targetState', 'afterState']) if (e[k]) step[k] = clone(e[k]);
    return step;
  });
  return { steps, parameters };
}

const sameStream = (a, b) => a.sessionId === b.sessionId && a.tab === b.tab;
const consecutive = (a, b) => sameStream(a, b) && b.seq === a.seq + 1 && a.epoch === b.epoch && a.site === b.site && a.taskHash === b.taskHash;
const connected = (a, b) => a.after?.origin === b.before?.origin && a.after?.path === b.before?.path && a.after?.queryHash === b.before?.queryHash;
const signature = events => hash(JSON.stringify(makeSteps(events).steps));

/** Extract maximal contiguous runs; split exact adjacent repeats, with no inference or AI. */
function candidatesFor(events) {
  const streams = new Map();
  for (const e of events) {
    const key = JSON.stringify([e.sessionId, e.tab]);
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push(e);
  }
  const groups = new Map();
  const add = selected => {
    if (!selected.length) return;
    const sig = signature(selected), last = selected.at(-1);
    let group = groups.get(sig);
    if (!group) {
      group = { id: `candidate_${sig.slice(0, 24)}`, site: selected[0].site, name: last.target?.name || ({ press_key: `Press ${last.args.key}`, scroll: `Scroll ${last.args.direction}` }[last.tool] ?? last.tool), ...makeSteps(selected), eventIds: [], occurrences: [], count: 0, lastAt: 0 };
      groups.set(sig, group);
    }
    const occurrence = { eventIds: selected.map(e => e.id), firstAt: selected[0].at, lastAt: last.at };
    group.count++;
    group.occurrences.push(occurrence);
    if (group.occurrences.length > ROUTINE_LIMITS.occurrences) group.occurrences.shift();
    if (last.at >= group.lastAt) { group.eventIds = occurrence.eventIds; group.lastAt = last.at; }
  };
  const splitRun = run => {
    // Compare canonical one-step tokens first; parameter names are assigned only to final runs.
    const tokens = run.map(e => signature([e]));
    let start = 0;
    while (start < run.length) {
      let repeat = null;
      for (let offset = start; offset < Math.min(run.length, start + ROUTINE_LIMITS.steps); offset++) {
        for (let size = 1; size <= Math.min(ROUTINE_LIMITS.steps, Math.floor((run.length - offset) / 2)); size++) {
          let count = 1;
          while (offset + (count + 1) * size <= run.length && tokens.slice(offset, offset + size).every((t, j) => t === tokens[offset + count * size + j])) count++;
          if (count >= 2 && (!repeat || offset < repeat.offset || (offset === repeat.offset && count * size > repeat.count * repeat.size))) repeat = { offset, size, count };
        }
        if (repeat) break;
      }
      if (!repeat) { add(run.slice(start, start + ROUTINE_LIMITS.steps)); start += ROUTINE_LIMITS.steps; continue; }
      if (repeat.offset > start) add(run.slice(start, repeat.offset));
      for (let i = 0; i < repeat.count; i++) add(run.slice(repeat.offset + i * repeat.size, repeat.offset + (i + 1) * repeat.size));
      start = repeat.offset + repeat.count * repeat.size;
    }
  };
  for (const stream of streams.values()) {
    let run = [];
    for (const e of stream) {
      if (!e.replayable || (run.length && (!consecutive(run.at(-1), e) || !connected(run.at(-1), e)))) { splitRun(run); run = []; }
      if (e.replayable) run.push(e);
    }
    splitRun(run);
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
}

function validLocation(v) { return v === null || (ownKeys(v, ['origin', 'path', 'fingerprint', 'queryHash']) && JSON.stringify(location(v)) === JSON.stringify(v)); }
function validTarget(v) { return v === undefined || (ownKeys(v, ['version', 'tag', 'role', 'name', 'id', 'testId', 'href', 'hrefQueryHash', 'type']) && JSON.stringify(descriptor(v)) === JSON.stringify(v)); }
function validState(v) { return v === undefined || (ownKeys(v, ['disabled', 'checked', 'expanded', 'selected', 'focused']) && Object.values(v).every(x => typeof x === 'boolean')); }
function validArgs(tool, args, step = false) {
  if (!plain(args)) return false;
  const expected = argumentsFor(tool, args);
  if (tool === 'type_text' && expected) expected.textParam = step && /^input_[1-9]\d*$/.test(args.textParam) ? args.textParam : 'input_1';
  if (tool === 'select_option' && expected) expected.valueParam = step && /^option_[1-9]\d*$/.test(args.valueParam) ? args.valueParam : 'option_1';
  return expected !== null && JSON.stringify(expected) === JSON.stringify(args);
}

function validate(data) {
  const bad = () => { throw error('routines_corrupt'); };
  if (!ownKeys(data, ['version', 'enabled', 'epoch', 'events', 'routines', 'runs']) || data.version !== 1 || typeof data.enabled !== 'boolean' || !integer(data.epoch, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(data.events) || data.events.length > ROUTINE_LIMITS.events || !Array.isArray(data.routines) || data.routines.length > ROUTINE_LIMITS.routines || !Array.isArray(data.runs) || data.runs.length > ROUTINE_LIMITS.runs) bad();
  const seen = new Set(), tails = new Map();
  for (const e of data.events) {
    if (!ownKeys(e, ['id', 'sessionId', 'tab', 'seq', 'epoch', 'at', 'site', 'tool', 'before', 'after', 'args', 'ok', 'replayable', 'reason', 'blockedReason', 'target', 'targetState', 'afterState', 'taskHash', 'code']) || typeof e.id !== 'string' || !UUID.test(e.id) || seen.has(e.id) || typeof e.sessionId !== 'string' || !TOKEN.test(e.sessionId) || !(e.tab === null || integer(e.tab, 0, Number.MAX_SAFE_INTEGER)) || !integer(e.seq, 1, Number.MAX_SAFE_INTEGER) || !integer(e.epoch, 0, data.epoch) || !integer(e.at, 0, Number.MAX_SAFE_INTEGER) || !(e.site === null || origin(e.site) === e.site) || typeof e.tool !== 'string' || !/^[a-z_]{1,40}$/.test(e.tool) || !validLocation(e.before) || !validLocation(e.after) || !validTarget(e.target) || !validState(e.targetState) || !validState(e.afterState) || typeof e.ok !== 'boolean' || typeof e.replayable !== 'boolean' || (e.code !== undefined && (typeof e.code !== 'string' || !CODE.test(e.code))) || (e.taskHash !== undefined && (typeof e.taskHash !== 'string' || !HEX.test(e.taskHash))) || (e.blockedReason !== undefined && (!REASONS.has(e.blockedReason) || e.reason !== 'in_progress')) || (e.target && sensitive(e))) bad();
    if (e.site !== (e.before?.origin ?? e.after?.origin ?? null)) bad();
    if (e.replayable) {
      if (!e.ok || !TOOLS.has(e.tool) || e.reason !== undefined || !e.before || !e.after || e.before.origin !== e.after.origin || e.tab === null || !validArgs(e.tool, e.args) || (TARGETED.has(e.tool) && !e.target) || sensitive(e)) bad();
    } else if (!REASONS.has(e.reason) || !plain(e.args) || (Object.keys(e.args).length && !validArgs(e.tool, e.args))) bad();
    const key = JSON.stringify([e.sessionId, e.tab]), previous = tails.get(key);
    if (previous && e.seq !== previous.seq + 1) bad();
    seen.add(e.id); tails.set(key, e);
  }
  const routineIds = new Set();
  for (const r of data.routines) {
    if (!ownKeys(r, ['id', 'site', 'name', 'description', 'createdAt', 'updatedAt', 'archived', 'steps', 'parameters', 'runCount', 'lastRun']) || typeof r.id !== 'string' || !UUID.test(r.id) || routineIds.has(r.id) || origin(r.site) !== r.site || typeof r.name !== 'string' || !r.name || text(r.name) !== r.name || typeof r.description !== 'string' || text(r.description, 500) !== r.description || !integer(r.createdAt, 0, Number.MAX_SAFE_INTEGER) || !integer(r.updatedAt, 0, Number.MAX_SAFE_INTEGER) || typeof r.archived !== 'boolean' || !integer(r.runCount, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(r.steps) || !r.steps.length || r.steps.length > ROUTINE_LIMITS.steps || !Array.isArray(r.parameters)) bad();
    for (const s of r.steps) {
      if (!ownKeys(s, ['tool', 'before', 'after', 'args', 'target', 'targetState', 'afterState']) || !TOOLS.has(s.tool) || !s.before || !s.after || !validLocation(s.before) || !validLocation(s.after) || s.before.origin !== r.site || s.after.origin !== r.site || !validArgs(s.tool, s.args, true) || !validTarget(s.target) || !validState(s.targetState) || !validState(s.afterState) || (TARGETED.has(s.tool) && !s.target) || sensitive(s)) bad();
    }
    const canonical = makeSteps(r.steps);
    if (JSON.stringify(canonical.parameters) !== JSON.stringify(r.parameters) || JSON.stringify(canonical.steps) !== JSON.stringify(r.steps) || (r.lastRun !== undefined && !validRun(r.lastRun, false))) bad();
    routineIds.add(r.id);
  }
  for (const r of data.runs) if (!validRun(r, true) || !routineIds.has(r.id)) bad();
  return data;
}

function validRun(r, withId) {
  return ownKeys(r, withId ? ['id', 'status', 'completed', 'total', 'code', 'at'] : ['status', 'completed', 'total', 'code', 'at']) && (!withId || UUID.test(r.id)) && STATUSES.has(r.status) && integer(r.completed, 0, ROUTINE_LIMITS.steps) && integer(r.total, 0, ROUTINE_LIMITS.steps) && r.completed <= r.total && integer(r.at, 0, Number.MAX_SAFE_INTEGER) && (r.code === undefined || CODE.test(r.code));
}

function defaultDir() {
  const selected = process.env.CHROME_BRIDGE_ROUTINES_DIR;
  if (selected === '~') return os.homedir();
  if (selected?.startsWith('~/')) return path.join(os.homedir(), selected.slice(2));
  return selected || path.join(path.dirname(settingsPath()), 'routines');
}

/** Every instance uses the same atomic file and a PID-verified exclusive lock. Unknown locks fail closed. */
export function createRoutineStore({ dir = defaultDir(), sessionId = randomUUID() } = {}) {
  dir = path.resolve(dir);
  sessionId = typeof sessionId === 'string' && TOKEN.test(sessionId) ? sessionId : hash(String(sessionId));
  const file = path.join(dir, 'state.json'), lock = path.join(dir, '.write-lock'), recovery = path.join(dir, '.write-recovery');
  let tail = Promise.resolve();
  async function prepare() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const s = await lstat(dir);
    if (!s.isDirectory() || (process.getuid && s.uid !== process.getuid()) || (s.mode & 0o077)) throw error('routines_unsafe');
  }
  async function read() {
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if (e.code === 'ENOENT') return { version: 1, enabled: true, epoch: 0, events: [], routines: [], runs: [] }; if (e.code === 'ELOOP') throw error('routines_unsafe'); throw error('routines_unreadable'); }
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw error('routines_unsafe');
      if (st.size > 16 * 1024 * 1024) throw error('routines_corrupt');
      let value;
      try { value = JSON.parse(await handle.readFile('utf8')); } catch { throw error('routines_corrupt'); }
      return validate(value);
    } finally { await handle.close(); }
  }
  async function write(value) {
    validate(value);
    const temp = path.join(dir, `.state-${process.pid}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temp, file);
      const directory = await open(dir, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { if (handle) await handle.close(); await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  const owner = async () => { try { return await readlink(lock); } catch { return null; } };
  const dead = value => {
    const match = /^(\d+):[0-9a-f-]{36}$/i.exec(value ?? '');
    if (!match || !integer(Number(match[1]), 1, 2147483647)) return false;
    try { process.kill(Number(match[1]), 0); return false; } catch (e) { return e.code === 'ESRCH'; }
  };
  async function locked(fn) {
    await prepare();
    const token = `${process.pid}:${randomUUID()}`, until = Date.now() + 5000;
    for (;;) {
      try { await symlink(token, lock); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (dead(await owner())) {
        let claimed = false;
        try { await mkdir(recovery, { mode: 0o700 }); claimed = true; if (dead(await owner())) await unlink(lock); }
        catch (e) { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; }
        finally { if (claimed) await rmdir(recovery); }
      }
      if (Date.now() >= until) throw error('routines_busy');
      await pause(5);
    }
    try { return await fn(); }
    finally { if (await owner() === token) await unlink(lock); }
  }
  const transaction = fn => {
    const result = tail.then(() => locked(async () => { const data = await read(); const value = await fn(data); await write(data); return clone(value); }));
    tail = result.catch(() => {});
    return result;
  };
  const readOnly = async fn => { await tail; await prepare(); return clone(fn(await read())); };
  const appendEvent = (data, event, pending) => {
    if (!data.enabled) return null;
    const tab = integer(event?.tab, 0, Number.MAX_SAFE_INTEGER) ? event.tab : null;
    const last = data.events.findLast(e => e.sessionId === sessionId && e.tab === tab);
    const e = sanitizedEvent(event, sessionId, data.epoch, (last?.seq ?? 0) + 1);
    if (pending) {
      if (!TOOLS.has(e.tool)) e.blockedReason = 'unsupported_tool';
      else if (sensitive(event ?? {})) e.blockedReason = 'sensitive_target';
      else if (event?.replayable === false) e.blockedReason = 'not_replayable';
      e.ok = false; e.replayable = false; e.reason = 'in_progress';
    }
    data.events.push(e);
    data.events = data.events.slice(-ROUTINE_LIMITS.events);
    return e;
  };
  return {
    record: event => transaction(data => appendEvent(data, event, false)),
    begin: event => transaction(data => appendEvent(data, event, true)),
    finish: (id, patch = {}) => transaction(data => {
      const index = data.events.findIndex(e => e.id === id);
      if (index < 0) throw error('routine_missing_event');
      const original = data.events[index];
      if (original.sessionId !== sessionId) throw error('routine_owner');
      if (original.reason !== 'in_progress') throw error('routine_finished');
      const input = { ...original, ...patch, tool: original.tool, tab: original.tab, before: original.before, args: original.args };
      // Pending flags describe persistence, not the completed action's result.
      if (patch.replayable === undefined) delete input.replayable;
      const e = sanitizedEvent(input, sessionId, original.epoch, original.seq);
      Object.assign(e, { id: original.id, at: original.at });
      if (original.taskHash) e.taskHash = original.taskHash;
      else delete e.taskHash;
      if (original.blockedReason) { e.replayable = false; e.reason = original.blockedReason; if (e.reason === 'sensitive_target') delete e.target; }
      if (!data.enabled || data.epoch !== original.epoch) { e.ok = false; e.replayable = false; e.reason = 'recording_disabled'; }
      data.events[index] = e;
      return e;
    }),
    snapshot: ({ site, query = '', limit = 100 } = {}) => readOnly(data => {
      if (site !== undefined && origin(site) !== site) throw error('routine_site');
      if (!integer(limit, 1, ROUTINE_LIMITS.events)) throw error('routine_limit');
      const q = text(query, 200).toLocaleLowerCase();
      const matches = v => (!site || v.site === site) && (!q || [v.name, v.description, v.site, v.tool, v.target?.name, v.before?.path].filter(Boolean).some(s => s.toLocaleLowerCase().includes(q)));
      const sites = new Map();
      for (const e of data.events) if (e.site && (!site || e.site === site)) { const s = sites.get(e.site) ?? { site: e.site, count: 0, lastAt: 0 }; s.count++; s.lastAt = Math.max(s.lastAt, e.at); sites.set(e.site, s); }
      for (const r of data.routines) if (!sites.has(r.site) && (!site || r.site === site)) sites.set(r.site, { site: r.site, count: 0, lastAt: r.updatedAt });
      return { enabled: data.enabled, sites: [...sites.values()].sort((a, b) => b.lastAt - a.lastAt || a.site.localeCompare(b.site)), events: data.events.filter(matches).slice(-limit).reverse(), routines: data.routines.filter(matches).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit), candidates: candidatesFor(data.events).filter(matches).slice(0, Math.min(limit, ROUTINE_LIMITS.candidates)) };
    }),
    save: ({ name, description = '', eventIds } = {}) => transaction(data => {
      if (!Array.isArray(eventIds) || !eventIds.length || eventIds.length > ROUTINE_LIMITS.steps || new Set(eventIds).size !== eventIds.length) throw error('routine_selection');
      if (typeof name !== 'string' || !text(name) || typeof description !== 'string') throw error('routine_name');
      if (data.routines.length >= ROUTINE_LIMITS.routines) throw error('routine_capacity');
      const events = eventIds.map(id => data.events.find(e => e.id === id));
      if (events.some(e => !e)) throw error('routine_missing_event');
      if (events.some(e => !e.replayable)) throw error('routine_barrier');
      for (let i = 1; i < events.length; i++) if (!consecutive(events[i - 1], events[i]) || !connected(events[i - 1], events[i])) throw error('routine_gap');
      const now = Date.now();
      const routine = { id: randomUUID(), site: events[0].site, name: text(name), description: text(description, 500), createdAt: now, updatedAt: now, archived: false, ...makeSteps(events), runCount: 0 };
      data.routines.push(routine);
      return routine;
    }),
    get: id => readOnly(data => data.routines.find(r => r.id === id) ?? null),
    setEnabled: enabled => transaction(data => { if (typeof enabled !== 'boolean') throw error('routine_enabled'); if (data.enabled !== enabled) { data.enabled = enabled; data.epoch++; } return data.enabled; }),
    update: (id, patch) => transaction(data => {
      if (!ownKeys(patch, ['name', 'archived']) || (patch.name !== undefined && (typeof patch.name !== 'string' || !text(patch.name))) || (patch.archived !== undefined && typeof patch.archived !== 'boolean')) throw error('routine_update');
      const r = data.routines.find(r => r.id === id);
      if (!r) throw error('routine_not_found');
      if (patch.name !== undefined) r.name = text(patch.name);
      if (patch.archived !== undefined) r.archived = patch.archived;
      r.updatedAt = Date.now();
      return r;
    }),
    recordRun: input => transaction(data => {
      const r = data.routines.find(r => r.id === input?.id);
      if (!r) throw error('routine_not_found');
      const entry = { id: r.id, status: input.status, completed: input.completed, total: input.total, at: integer(input.at, 0, Number.MAX_SAFE_INTEGER) ? input.at : Date.now() };
      if (typeof input.code === 'string' && CODE.test(input.code)) entry.code = input.code;
      if (!validRun(entry, true)) throw error('routine_run');
      data.runs.push(entry); data.runs = data.runs.slice(-ROUTINE_LIMITS.runs);
      const { id: _, ...lastRun } = entry;
      r.lastRun = lastRun;
      if (entry.status !== 'running') r.runCount++;
      r.updatedAt = Date.now();
      return r;
    })
  };
}
