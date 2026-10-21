/**
 * Tabs the agents opened themselves — and only those — get closed when the
 * agents are done with them: open_tab's (registerTab) and the ones an agent's
 * own click on its own tab opened (claimTab, create-only). A tab the user
 * opened is never in this registry, so nothing here can close it. A
 * registered tab the user may have taken over is never closed automatically either.
 *
 * One small file per tab (atomic write, no cross-process contention):
 *   ~/Library/Caches/chrome-bridge-mcp/agent-tabs-v2/<tabId>.json
 *   { tabId, ownerPid, windowId, expectedUrl, openedAt, lastUsed, takenOver, closeBlocked,
 *     agentName?, openedFrom? }
 * agentName (who opened it, for other agents' list_tabs) and openedFrom (the tab whose click
 * opened it) are optional: records of older builds lack them, and those builds keep them when
 * they rewrite a record (every write spreads the record read).
 *
 * Popups (claimTab: a tab the agent's own click opened) are kept as <tabId>.popup.json with
 * `popup: true` (and `proof`, how it is known the clicked page opened it). No sweep ever closes
 * one — not idle, not session end, not owner gone (decideSweep); only close_tab by its owner, with
 * every takeover refusal. The other file name keeps them out of the sight of older builds (they
 * read /^\d+\.json$/ only), which would otherwise close them when idle or orphaned: to those builds
 * a popup is an unregistered tab, which they never close. A <tabId>.json for the same id wins
 * (open_tab's registration overwrites, a claim never does).
 * plus create-only flag files <tabId>.taken.json / <tabId>.blocked.json, so a
 * concurrent read-modify-write of the record (touchTab in another server) can
 * never clear a flag once set. Only forgetTab removes them.
 *
 * The directory differs from the one older server builds use (agent-tabs/):
 * those builds do not know `takenOver` and would close such a tab when it
 * idles. They keep sweeping their own records; this build never touches them.
 *
 * Takeover (sticky): the tab is now in another window, its URL differs from
 * the last URL an agent navigation produced, or a sweep saw it as the active
 * tab of the front window while Chrome was frontmost and no input lock was
 * held. Only noteAgentNavigation moves expectedUrl; touchTab moves lastUsed.
 * There is no grace period: a URL is the agent's only when the agent itself
 * recorded it (open_tab after the load settled, an input action that followed
 * its navigation until it settled). A redirect that lands later marks the tab,
 * which leaks it rather than closing a tab the user may be using (codex2-3).
 * Records written by earlier builds may still carry `agentNavUntil`; it is ignored.
 *
 * Every closing path (sweep, session end, close_tab) goes through closeVerdict
 * and closeAndConfirm: a tab is forgotten only once a fresh listing shows it
 * gone; still there after CLOSE_CONFIRM_MS -> closeBlocked, never retried.
 */
import { mkdir, readdir, readFile, writeFile, rename, rm, stat, open, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LOCK_DIR, STALE_MS } from './lock.js';
import * as S from './settings.js';

const CACHE = path.join(os.homedir(), 'Library', 'Caches', 'chrome-bridge-mcp');
export const TAB_DIR = process.env.CHROME_BRIDGE_TAB_DIR || path.join(CACHE, 'agent-tabs-v2');
/** Registry of older server builds; read-only here (list_tabs may show it). */
export const LEGACY_TAB_DIR = path.join(CACHE, 'agent-tabs');
/** How long an agent tab may stay unused before a sweep closes it (the menu-bar panel sets it; 0 minutes = never by age). */
export const tabTtlMs = () => { const m = S.get('tabIdleMinutes'); return m > 0 ? m * 60_000 : Infinity; };
export const CLOSE_CONFIRM_MS = 3000;
const CLOSE_POLL_MS = 250;

const file = (id) => path.join(TAB_DIR, `${id}.json`);
const popupFile = (id) => path.join(TAB_DIR, `${id}.popup.json`);
const recFile = (rec) => rec.popup ? popupFile(rec.tabId) : file(rec.tabId);
const flagFile = (id, flag) => path.join(TAB_DIR, `${id}.${flag}.json`);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function put(rec) {
  await mkdir(TAB_DIR, { recursive: true });
  const tmp = `${recFile(rec)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(rec));
  await rename(tmp, recFile(rec));
}

/** Create-only: the first writer wins, later calls keep the original reason. */
async function setFlag(tabId, flag, info) {
  await mkdir(TAB_DIR, { recursive: true });
  let fh;
  try {
    fh = await open(flagFile(tabId, flag), 'wx');
    await fh.writeFile(JSON.stringify(info));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  } finally {
    await fh?.close();
  }
}

async function readFlag(tabId, flag) {
  try { return JSON.parse(await readFile(flagFile(tabId, flag), 'utf8')); } catch (e) {
    return e.code === 'ENOENT' ? null : {};
  }
}

async function withFlags(rec) {
  const [taken, blocked] = await Promise.all([readFlag(rec.tabId, 'taken'), readFlag(rec.tabId, 'blocked')]);
  const out = { ...rec };
  if (taken) Object.assign(out, { takenOver: true, takenOverWhy: taken.why ?? out.takenOverWhy ?? null, takenOverAt: taken.at ?? out.takenOverAt ?? null });
  if (blocked) Object.assign(out, { closeBlocked: true, closeBlockedAt: blocked.at ?? out.closeBlockedAt ?? null });
  return out;
}

/** Same URL for Chrome and for us ("https://a.com" vs "https://a.com/"); the fragment counts. */
export function sameUrl(a, b) {
  if (a == null || b == null) return false;
  const norm = (u) => { try { return new URL(u).href; } catch { return String(u); } };
  return norm(a) === norm(b);
}

/**
 * Whose tabs these are: the session's. Under the hot-swap launcher (src/launcher.js) that is the launcher,
 * which lives as long as the session while workers come and go; otherwise this process.
 */
export const OWNER_PID = Number(process.env.CHROME_BRIDGE_LAUNCHER_PID) || process.pid;

const newRecord = (tabId, url, { windowId = null, now = Date.now(), ownerPid = OWNER_PID, agentName = null, openedFrom = null }) => ({
  tabId: Number(tabId), ownerPid, windowId: windowId == null ? null : Number(windowId),
  expectedUrl: url, openedAt: now, lastUsed: now, agentDoneAt: now, takenOver: false, closeBlocked: false,
  ...(agentName ? { agentName: String(agentName) } : {}), ...(openedFrom != null ? { openedFrom: Number(openedFrom) } : {})
});

/**
 * Register a tab created by an explicit agent call (open_tab). A tab that
 * appeared during a click goes through claimTab instead (create-only).
 * @param opts  { windowId, now, ownerPid, agentName }; a number is taken as `now` (old signature)
 */
export async function registerTab(tabId, url, opts = {}) {
  await put(newRecord(tabId, url, typeof opts === 'number' ? { now: opts } : opts));
}

/**
 * Register a tab the agent's own click opened (target=_blank, window.open; see
 * popupCandidates) as a popup (never closed by a sweep, see above), create-only:
 * if any server registered this tab id first, it stays theirs. The record is
 * written whole, then linked into place.
 * @param opts  { windowId, now, ownerPid, agentName, openedFrom, proof }
 * @returns {Promise<boolean>}  true when this call created the record
 */
export async function claimTab(tabId, url, opts = {}) {
  await mkdir(TAB_DIR, { recursive: true });
  if (await stat(file(tabId)).then(() => true, () => false)) return false;
  const tmp = `${popupFile(tabId)}.${process.pid}.claim.tmp`;
  await writeFile(tmp, JSON.stringify({ ...newRecord(tabId, url, opts), popup: true, ...(opts.proof ? { proof: String(opts.proof) } : {}) }));
  try {
    await link(tmp, popupFile(tabId));
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * The agent finished an action on this tab (B4): from here on a mouse button going down is the
 * user's, not the agent's — "the user is looking at it" needs such a click, not just the tab being
 * in front (the agent itself leaves it there).
 */
export async function noteAgentDone(tabId, now = Date.now()) {
  if (tabId == null) return;
  const rec = await getTab(tabId);
  if (rec) await put({ ...rec, agentDoneAt: now });
}

export async function getTab(tabId) {
  const r = await readTabRecord(tabId);
  return r || null;
}

/**
 * Like getTab, but tells "no record" (null) from "could not read it right now" (undefined), so a
 * read error is never taken for a tab that was unregistered (src/index.js reconcileLedger).
 * <tabId>.json first, then the popup's <tabId>.popup.json.
 */
export async function readTabRecord(tabId) {
  for (const f of [file(tabId), popupFile(tabId)]) {
    let raw;
    try { raw = await readFile(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; return undefined; }
    try { return await withFlags(JSON.parse(raw)); } catch { return undefined; }
  }
  return null;
}

/** Mark an agent tab as just used (lastUsed only); a no-op for tabs the agent did not open. */
export async function touchTab(tabId, now = Date.now()) {
  if (tabId == null) return;
  const rec = await getTab(tabId);
  if (rec) await put({ ...rec, lastUsed: now });
}

/**
 * The only way expectedUrl changes: at the end of an agent input action the
 * user did not interrupt (and after its observation of the page settled), and
 * by open_tab. Does not clear takenOver.
 */
export async function noteAgentNavigation(tabId, url, now = Date.now()) {
  if (tabId == null) return null;
  const rec = await getTab(tabId);
  if (!rec) return null;
  const { agentNavUntil, ...rest } = rec;
  const next = { ...rest, expectedUrl: url, lastUsed: now };
  await put(next);
  return next;
}

/** Persist takeover (sticky; the first reason is kept). */
export async function markTakenOver(tabId, why, now = Date.now()) {
  await setFlag(tabId, 'taken', { why, at: now, observedByPid: process.pid, observedByOwnerPid: OWNER_PID });
  const rec = await getTab(tabId);
  if (rec) await put({ ...rec, takenOver: true });
  return rec;
}

/** Persist a close that did not happen (a beforeunload dialog or similar). */
export async function markCloseBlocked(tabId, now = Date.now()) {
  await setFlag(tabId, 'blocked', { at: now });
  const rec = await getTab(tabId);
  if (rec) await put({ ...rec, closeBlocked: true });
  return rec;
}

export async function forgetTab(tabId) {
  await Promise.all([file(tabId), popupFile(tabId), flagFile(tabId, 'taken'), flagFile(tabId, 'blocked')]
    .map(f => rm(f, { force: true })));
}

/** @param popups  also <tabId>.popup.json (this registry only); a <tabId>.json for the same id wins */
async function readRegistry(dir, withFlagFiles, { popups = false } = {}) {
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const pick = popups ? /^\d+(\.popup)?\.json$/ : /^\d+\.json$/;
  const sorted = names.filter(n => pick.test(n)).sort((a, b) => Number(a.includes('.popup')) - Number(b.includes('.popup')));
  const recs = await Promise.all(sorted.map(n => readFile(path.join(dir, n), 'utf8').then(JSON.parse).catch(() => null)));
  const seen = new Set();
  const ok = recs.filter(r => r && !seen.has(Number(r.tabId)) && seen.add(Number(r.tabId)));
  return withFlagFiles ? Promise.all(ok.map(withFlags)) : ok;
}

export function allTabs() { return readRegistry(TAB_DIR, true, { popups: true }); }

/** Records written by older server builds ({tabId, ownerPid, openedAt, lastUsed, url}); never closed here. */
export function legacyTabs() { return readRegistry(LEGACY_TAB_DIR, false); }

/* ------------------------------------------------------------ pure parts */

/**
 * A tab as a `chromectl list` result shows it.
 * @returns {{id:number, url:string, title:string, active:boolean, windowId:number,
 *            windowIndex:number, minimized:boolean}|null}
 */
export function findLiveTab(list, tabId) {
  for (const w of list?.windows || []) {
    const t = (w.tabs || []).find(x => Number(x.id) === Number(tabId));
    if (t) return { id: Number(t.id), url: t.url, title: t.title, active: !!t.active,
      windowId: Number(w.id), windowIndex: w.index, minimized: !!w.minimized };
  }
  return null;
}

/** Chrome is the frontmost app according to a listing. */
export function chromeFrontmost(list) {
  if (list?.frontmostPid != null && list?.chromePid != null) return Number(list.frontmostPid) === Number(list.chromePid);
  return list?.frontmost === 'Google Chrome';
}

/** The active tab of the front, non-minimized Chrome window while Chrome is frontmost; else null. */
export function frontActiveTabId(list) {
  if (!chromeFrontmost(list)) return null;
  const front = (list.windows || []).find(w => w.index === 1 && !w.minimized);
  const t = front && (front.tabs || []).find(x => x.active);
  return t ? Number(t.id) : null;
}

/**
 * Takeover check, run BEFORE any use of a registered tab and in every sweep.
 * @param rec        registry record (or null: not an agent tab)
 * @param liveTab    findLiveTab() result, or null when the tab is gone
 * @param opts.userTabId  tab the user is looking at with no input lock held
 *                   (sweep only; see observeUserTab), or null
 * @returns {{rec, changed:boolean, why:string|null}}
 *          why: moved_window | url_changed | user_viewing. Never changes expectedUrl.
 */
export function checkTakeover(rec, liveTab, { userTabId = null } = {}) {
  if (!rec || !liveTab) return { rec, changed: false, why: null };
  if (rec.takenOver) return { rec, changed: false, why: rec.takenOverWhy ?? null };
  const taken = (why) => ({ rec: { ...rec, takenOver: true, takenOverWhy: why }, changed: true, why });
  if (rec.windowId != null && Number(liveTab.windowId) !== Number(rec.windowId)) return taken('moved_window');
  if (!sameUrl(liveTab.url, rec.expectedUrl)) return taken('url_changed');
  if (userTabId != null && Number(userTabId) === Number(rec.tabId)) return taken('user_viewing');
  return { rec, changed: false, why: null };
}

/**
 * The one ownership check every closing path uses.
 * @returns {{ok:true}|{ok:false, reason:'not_agent_tab'|'gone'|'taken_over'|'close_blocked'}}
 */
export function closeVerdict(rec, liveTab) {
  if (!rec) return { ok: false, reason: 'not_agent_tab' };
  if (!liveTab) return { ok: false, reason: 'gone' };
  if (rec.takenOver) return { ok: false, reason: 'taken_over' };
  if (rec.closeBlocked) return { ok: false, reason: 'close_blocked' };
  return { ok: true };
}

/**
 * Pure decision: which registered tabs should be closed now.
 * @param recs      registry records (takeover already applied, see planSweep)
 * @param existing  Set of tab ids that still exist in Chrome
 * @param onScreen  tab id the user is looking at, or null — never closed
 * @param opts.exitingPid  close everything this pid owns (its session ended)
 * @returns {{close: object[], drop: object[]}}  drop = gone already, just unregister
 */
export function decideSweep(recs, existing, onScreen, { now = Date.now(), ttlMs = tabTtlMs(), exitingPid = null, isAlive = alive } = {}) {
  const close = [], drop = [];
  for (const r of recs) {
    if (!existing.has(Number(r.tabId))) { drop.push(r); continue; }
    // A popup an agent's click opened is never closed by a sweep: only by its owner's close_tab.
    if (r.takenOver || r.closeBlocked || r.popup) continue;
    if (onScreen != null && Number(r.tabId) === Number(onScreen)) continue;
    const reason =
      exitingPid != null && r.ownerPid === exitingPid ? 'session_end'
      : !isAlive(r.ownerPid) ? 'owner_gone'
      : now - r.lastUsed > ttlMs ? 'idle'
      : null;
    if (reason) close.push({ ...r, reason });
  }
  return { close, drop };
}

/**
 * Pure sweep over one listing: takeover marks first, then the close decision.
 * While an input lock was held during the listing, an agent may be moving or
 * navigating its own tab and has not yet reported it (noteAgentNavigation), so
 * that sweep only unregisters gone tabs: no marks, no closes.
 * @param lockQuiet  observeUserTab().quiet
 * @param userTabId  observeUserTab().userTabId
 * @returns {{marks:{tabId,why}[], close:object[], drop:object[]}}
 */
export function planSweep(recs, list, { userTabId = null, lockQuiet = true, ...opts } = {}) {
  const existing = new Set((list?.windows || []).flatMap(w => (w.tabs || []).map(t => Number(t.id))));
  if (!lockQuiet) return { marks: [], close: [], drop: recs.filter(r => !existing.has(Number(r.tabId))) };
  const marks = [];
  const checked = recs.map(r => {
    const c = checkTakeover(r, findLiveTab(list, r.tabId), { userTabId });
    if (c.changed) marks.push({ tabId: Number(r.tabId), why: c.why });
    return c.rec;
  });
  return { marks, ...decideSweep(checked, existing, frontActiveTabId(list), opts) };
}

/**
 * Tabs present after a click that were not there before (the user or another
 * agent may have opened some of them; popupCandidates picks the ones the
 * clicking agent may own).
 * @returns {{tabId, windowId, url, title}[]}
 */
export function diffNewTabs(before, after) {
  const had = new Set((before?.windows || []).flatMap(w => (w.tabs || []).map(t => Number(t.id))));
  const out = [];
  for (const w of after?.windows || []) {
    for (const t of w.tabs || []) {
      if (!had.has(Number(t.id))) out.push({ tabId: Number(t.id), windowId: Number(w.id), url: t.url, title: t.title });
    }
  }
  return out;
}

/**
 * Of the tabs that appeared during a click on the agent's own tab, the ones it
 * may register as its own (claimTab): only in the clicked tab's window or in a
 * window that did not exist before (window.open popups), and only web pages or
 * a page still loading (about:blank). A user's Cmd+T shows chrome://newtab and
 * is never one. The caller also requires that the click ended untouched by the
 * user and that no mouse button went down since (src/index.js claimPopups).
 * @param opts.srcWindowId  window of the clicked tab
 * @returns {{tabId, windowId, url, title}[]}
 */
export function popupCandidates(before, after, { srcWindowId }) {
  const hadWin = new Set((before?.windows || []).map(w => Number(w.id)));
  return diffNewTabs(before, after).filter(n =>
    (Number(n.windowId) === Number(srcWindowId) || !hadWin.has(Number(n.windowId))) &&
    (!n.url || /^(https?:\/\/|about:blank$)/i.test(n.url)));
}

/** Short Chinese status for list_tabs; null for an ordinary agent tab. */
export function tabStatus(rec) {
  if (!rec) return null;
  if (rec.closeBlocked) return '关闭没有完成（可能有未保存内容的提示框），不会再自动尝试';
  if (rec.takenOver) return '可能已被你接手，不会自动关闭';
  return null;
}

/* ------------------------------------------------------------ async parts */

async function defaultDeps() {
  const b = await import('./bridge.js');
  return { listTabs: b.listTabs, closeTab: b.closeTab, clickedSince: (t0) => clickedSince(b.cgevent, t0) };
}

/** Did a mouse button go down after t0 (epoch ms)? Unknown stays unknown: it may prevent a
 * close, but cannot become permanent evidence that the user took over an agent's tab. */
export async function clickedSince(cgevent, t0) {
  try {
    const r = await cgevent(['idle']);
    return Number.isFinite(r?.clickIdle) && r.clickIdle >= 0 && Number.isFinite(t0)
      ? r.clickIdle * 1000 <= Date.now() - t0 : null;
  } catch { return null; }
}

const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Input-lock state for the frontmost-active rule. `stamp` is the mtime of the
 * lock's parent directory, which changes whenever the lock is created or
 * removed, so an acquire+release between two snapshots is detectable.
 */
export async function inputLockSnapshot({ lockDir = LOCK_DIR, isAlive = alive, now = Date.now() } = {}) {
  let stamp = null;
  try { stamp = (await stat(path.dirname(lockDir))).mtimeMs; } catch {}
  let held = false;
  try {
    const s = await stat(lockDir);
    held = true;
    try {
      const o = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'));
      if ((o.pid && !isAlive(o.pid)) || now - o.since > STALE_MS) held = false;
    } catch {
      if (now - s.mtimeMs > STALE_MS) held = false;
    }
  } catch (e) {
    // An unreadable lock is not proof that no agent owns the mouse.
    if (e.code !== 'ENOENT') held = true;
  }
  return { held, stamp };
}

/**
 * One listing plus the tab the user is looking at. quiet = the input lock was
 * free and untouched across the whole listing; userTabId is null otherwise (an
 * agent action puts its own tab in front while it holds the lock).
 * @returns {Promise<{list, quiet:boolean, userTabId:number|null, viewingUnknown:boolean}>}
 */
export async function observeUserTab({ listTabs, lockDir = LOCK_DIR, clickedSince = null } = {}) {
  const a = await inputLockSnapshot({ lockDir });
  const list = await listTabs();
  const b = await inputLockSnapshot({ lockDir });
  let quiet = !a.held && !b.held && a.stamp === b.stamp;
  let userTabId = quiet ? frontActiveTabId(list) : null;
  let viewingUnknown = false;
  // B4: an agent tab left in front by the agent is not the user's unless they clicked since.
  if (userTabId != null && clickedSince) {
    const rec = await getTab(userTabId);
    if (rec && rec.agentDoneAt != null) {
      const clicked = await clickedSince(rec.agentDoneAt).catch(() => null);
      viewingUnknown = clicked !== true && clicked !== false;
      if (clicked !== true) userTabId = null;
    }
  }
  // The native idle probe and registry lookup can overlap another agent acquiring the lock.
  // Include them in the observation interval, otherwise its click looks like a user's click.
  const c = await inputLockSnapshot({ lockDir });
  quiet = quiet && !c.held && b.stamp === c.stamp;
  if (!quiet) userTabId = null;
  return { list, quiet, userTabId, viewingUnknown };
}

/**
 * Takeover check before an agent uses a tab; persists a new mark.
 * @param liveTab  {id, url, windowId} of the tab right now
 * @returns {Promise<{rec, takenOver:boolean, why:string|null}>}  rec null = not an agent tab
 */
export async function checkTabBeforeUse(tabId, liveTab, now = Date.now()) {
  const rec = await getTab(tabId);
  if (!rec) return { rec: null, takenOver: false, why: null };
  const c = checkTakeover(rec, liveTab);
  if (c.changed) await markTakenOver(tabId, c.why, now);
  return { rec: c.rec, takenOver: !!c.rec.takenOver, why: c.rec.takenOverWhy ?? c.why };
}

/**
 * Close tabs that passed closeVerdict, then confirm with fresh listings.
 * A tab is forgotten only once a listing no longer shows it; still listed
 * after confirmMs (from the close request) -> closeBlocked, kept, not retried.
 * @param deps  { listTabs, closeTab, sleep(ms), clock() -> ms, confirmMs, pollMs }
 * @returns {Promise<{closed:number[], blocked:number[]}>}
 */
export async function closeAndConfirm(tabIds, { listTabs, closeTab, sleep = realSleep, clock = Date.now, confirmMs = CLOSE_CONFIRM_MS, pollMs = CLOSE_POLL_MS } = {}) {
  const ids = tabIds.map(Number);
  if (!ids.length) return { closed: [], blocked: [] };
  const t0 = clock();
  // Wait for a call at most until `deadline` (clock time); a result that
  // arrives later is dropped. A close that opens a beforeunload dialog may not
  // return promptly, and a listing of a stalled Chrome may take up to the
  // driver's 25 s timeout: neither may hold the caller past the deadline.
  const until = async (fn, deadline) => {
    let done = false, value = null;
    Promise.resolve().then(fn).then(v => { value = v; }, () => {}).finally(() => { done = true; });
    while (!done && clock() < deadline) await sleep(Math.min(pollMs, 50, Math.max(1, deadline - clock())));
    return done ? value : null;
  };
  await until(() => Promise.all(ids.map(id => Promise.resolve().then(() => closeTab(id)).catch(() => null))), t0 + confirmMs);
  const pending = new Set(ids);
  const closed = [];
  for (let first = true; ; first = false) {
    // The first listing always gets a short window, even when the close used up the deadline.
    const list = await until(listTabs, first ? Math.max(t0 + confirmMs, clock() + pollMs) : t0 + confirmMs);
    if (list) {
      for (const id of [...pending]) {
        if (!findLiveTab(list, id)) { pending.delete(id); closed.push(id); await forgetTab(id); }
      }
    }
    if (!pending.size || clock() - t0 >= confirmMs) break;
    await sleep(Math.min(pollMs, Math.max(1, confirmMs - (clock() - t0))));
  }
  for (const id of pending) await markCloseBlocked(id, clock());
  return { closed, blocked: [...pending] };
}

/**
 * close_tab: the same takeover check (including the user looking at it) and
 * verdict as the sweep, then close + confirm. With the input lock held the
 * on-screen tab may be an agent's action or the user: it is not marked, but
 * not closed either (transient refusal, as decideSweep never closes it).
 * @param deps  closeAndConfirm deps + lockDir; listTabs/closeTab default to bridge.js
 * @returns {Promise<{ok:true, closed:true}|{ok:true, closed:false, reason:'gone'}|
 *                   {ok:false, reason:'not_agent_tab'|'taken_over'|'close_blocked', why?, transient?}>}
 */
export async function closeAgentTab(tabId, deps = {}) {
  const d = { ...(deps.listTabs && deps.closeTab ? {} : await defaultDeps()), ...deps };
  const rec0 = await getTab(tabId);
  if (!rec0) return { ok: false, reason: 'not_agent_tab' };
  const { list, quiet, userTabId, viewingUnknown } = await observeUserTab({ listTabs: d.listTabs, lockDir: d.lockDir ?? LOCK_DIR, clickedSince: d.clickedSince });
  const live = findLiveTab(list, tabId);
  const now = Date.now();
  const c = checkTakeover(rec0, live, { userTabId });
  if (c.changed) await markTakenOver(tabId, c.why, now);
  const v = closeVerdict(c.rec, live);
  if (!v.ok) {
    if (v.reason === 'gone') { await forgetTab(tabId); return { ok: true, closed: false, reason: 'gone' }; }
    return { ...v, why: c.rec.takenOverWhy ?? null };
  }
  if ((!quiet || viewingUnknown) && frontActiveTabId(list) === Number(tabId)) {
    return { ok: false, reason: 'taken_over', why: viewingUnknown ? 'viewing_unverified' : 'user_viewing', transient: true };
  }
  const r = await closeAndConfirm([tabId], d);
  return r.closed.length ? { ok: true, closed: true } : { ok: false, reason: 'close_blocked' };
}

/**
 * Sweep (timer, startup, and session end with exitingPid = this pid).
 * @param opts  { exitingPid, now, ttlMs, isAlive, lockDir } + closeAndConfirm deps
 * @returns {Promise<{closed:object[], blocked:object[], dropped:object[], marked:{tabId,why}[]}>}
 */
export async function sweepTabs({ exitingPid = null, now = Date.now(), ttlMs = tabTtlMs(), isAlive = alive, lockDir = LOCK_DIR, ...deps } = {}) {
  // 「暂停 AI 操作」 in the panel: no automatic closing either (Codex r13 A2); a later sweep does it after the resume.
  const none = { closed: [], blocked: [], dropped: [], marked: [] };
  if (S.get('paused')) return { ...none, paused: true };
  const recs = await allTabs();
  if (!recs.length) return none;
  const d = { ...(deps.listTabs && deps.closeTab ? {} : await defaultDeps()), ...deps };
  const { list, quiet, userTabId } = await observeUserTab({ listTabs: d.listTabs, lockDir, clickedSince: d.clickedSince });
  const plan = planSweep(recs, list, { userTabId, lockQuiet: quiet, exitingPid, now, ttlMs, isAlive });
  for (const m of plan.marks) await markTakenOver(m.tabId, m.why, now);
  for (const r of plan.drop) await forgetTab(r.tabId);
  const ok = plan.close.filter(r => closeVerdict(r, findLiveTab(list, r.tabId)).ok);
  if (ok.length && S.get('paused')) return { ...none, dropped: plan.drop, marked: plan.marks, paused: true };
  const res = await closeAndConfirm(ok.map(r => r.tabId), d);
  const pick = (ids) => ok.filter(r => ids.includes(Number(r.tabId)));
  return { closed: pick(res.closed), blocked: pick(res.blocked), dropped: plan.drop, marked: plan.marks };
}
