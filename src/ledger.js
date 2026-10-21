/**
 * Per-session tab ledger: which Chrome tabs this server process (one agent
 * session) owns and what state each one is in, so the agent is told where its
 * pages are — in list_tabs, and in one short line on other replies when that
 * changed (owner 2026-10-10: "agent 有时候搞不清楚自己的页面在哪里").
 *
 * Ownership itself lives in the shared registry (src/tabs.js, `ownerPid`);
 * this file adds the state as this process sees it, in memory. No I/O here.
 *
 * States (owner = this server process)
 *   ready        mine and live; the markers of my last read_page are usable (or not read yet)
 *   stale        mine and live, but its URL changed after my last read_page: markers expired
 *   taken_over   mine, but the user may have taken it over (registry flag): do not operate it
 *   closed       I closed it (close_tab confirmed)                              terminal
 *   gone         it disappeared from Chrome (or from the registry)               terminal
 *   other_agent  registered to another server process that is alive
 *   orphan       registered to a server process that has exited
 *   (a tab the user opened is in no registry: never mine, never in a ledger)
 *
 * Transitions (nextTabState): row = state before, column = event; · = unchanged
 *
 *                open   popup  navigated  read   takeover    close   missing  foreign      owner_dead
 *   (none)       ready  ready  ·          ·      ·           ·       ·        other_agent  ·
 *   ready        ready  ready  stale¹     ready  taken_over  closed  gone     ·            ·
 *   stale        ready  ready  stale      ready  taken_over  closed  gone     ·            ·
 *   taken_over   ready  ready  ·          ·      taken_over² ·       gone     ·            ·
 *   closed       ready  ready  ·          ·      ·           ·       ·        ·            ·
 *   gone         ready  ready  ·          ·      ·           ·       ·        ·            ·
 *   other_agent  ·      ·      ·          ·      ·           ·       gone     ·            orphan
 *   orphan       ·      ·      ·          ·      ·           ·       gone     ·            ·
 *
 *   open   open_tab registered it to me; popup: my own click opened it and it was registered
 *          to me (`from` = the tab clicked). Both start the entry afresh (Chrome may reuse an id).
 *          A popup is never closed by a sweep (not idle, not session end, not owner gone): only by
 *          its owner's close_tab, which still refuses a taken-over tab or one the user is viewing
 *          (src/tabs.js claimTab / decideSweep). open_tab's tabs are swept as before.
 *   navigated  its URL is now `url` (my click / typing / select ended there, or a listing shows it).
 *          ¹ stale only when that differs from the URL I last saw (my read_page, else open/popup).
 *   read   read_page read it: its markers are fresh. Taken over stays taken over (sticky, as the
 *          registry flag is).
 *   takeover  the registry flag is set (moved window, URL not the agent's, user viewing or
 *          interrupting: src/tabs.js checkTakeover). close_tab refuses such a tab, so close never
 *          moves it. What the agent is told to do depends on why (nextAction): dragged away or the
 *          user looking at it → leave it; the URL not the agent's or the user touching the input
 *          during an action can also be a slow navigation or a bumped mouse → read it first and
 *          leave it if it is not the expected page; a tab the agent handed to the user
 *          (wait_for_user, `helped`: only while that wait ran or after it, for what happened then)
 *          → read it and carry on.
 *          ² sticky, except that a helped tab seen dragged away or viewed by the user (`seenAt`)
 *          after the wait ended is no longer helped: that newer reason wins (and is news).
 *   foreign / owner_dead classify another process's tab for list_tabs; such tabs never enter
 *          this process's ledger.
 */
import { sameUrl } from './tabs.js';

export const STATES = ['ready', 'stale', 'taken_over', 'closed', 'gone', 'other_agent', 'orphan'];
export const EVENTS = ['open', 'popup', 'navigated', 'read', 'takeover', 'close', 'missing', 'foreign', 'owner_dead'];
const MINE = new Set(['ready', 'stale', 'taken_over', 'closed', 'gone']);
const LIVE = new Set(['ready', 'stale']);
const TERMINAL = new Set(['closed', 'gone']);
/** Takeover reasons that mean "the user has it now" (takeoverKind 'leave'). */
const LEAVE = new Set(['moved_window', 'user_viewing']);

/**
 * The one transition function. Pure: returns `entry` itself when nothing changes.
 * @param entry  {tabId, state, url, title, base, from, why, owner, at} or null
 * @param ev     {type, tabId?, url?, title?, from?, why?, owner?, at?}
 * @returns the next entry, or null (no entry and nothing to start one)
 */
export function nextTabState(entry, ev) {
  const at = ev.at ?? Date.now();
  const s = entry ? entry.state : null;
  const to = (state, extra = {}) => ({ ...entry, ...extra, state, at });
  switch (ev.type) {
    case 'open':
    case 'popup':
      if (s === 'other_agent' || s === 'orphan') return entry;
      return { tabId: Number(ev.tabId ?? entry?.tabId), state: 'ready', url: ev.url ?? null, title: ev.title ?? null,
        base: ev.url ?? null, from: ev.type === 'popup' ? (ev.from ?? null) : null, why: null, owner: null, at };
    case 'navigated':
      if ((s !== 'ready' && s !== 'stale') || ev.url == null) return entry;
      if (s === 'ready' && !sameUrl(ev.url, entry.base)) return to('stale', { url: ev.url });
      return sameUrl(ev.url, entry.url) ? entry : { ...entry, url: ev.url };
    case 'read': {
      if (s !== 'ready' && s !== 'stale') return entry;
      const url = ev.url ?? entry.url;
      if (s === 'ready' && sameUrl(url, entry.base) && sameUrl(url, entry.url) && (ev.title == null || ev.title === entry.title)) return entry;
      return to('ready', { url, base: url, title: ev.title ?? entry.title });
    }
    case 'takeover': {
      // A tab handed to the user (wait_for_user) and taken over again after that wait ended:
      // the newer reason wins over the old help (²). seenAt: when that evidence was observed.
      const h = entry && entry.helped;
      const newer = h && h.until != null && typeof ev.seenAt === 'number' && ev.seenAt > h.until && LEAVE.has(ev.why);
      if (s === 'taken_over') return newer ? to('taken_over', { why: ev.why, helped: null }) : entry;
      if (s !== 'ready' && s !== 'stale') return entry;
      return to('taken_over', { why: ev.why ?? null, ...(newer ? { helped: null } : {}) });
    }
    case 'close':
      if (s !== 'ready' && s !== 'stale') return entry;
      return to('closed');
    case 'missing':
      if (s === null || TERMINAL.has(s)) return entry;
      return to('gone');
    case 'foreign':
      if (s !== null) return entry;
      return { tabId: Number(ev.tabId), state: 'other_agent', url: ev.url ?? null, title: ev.title ?? null,
        base: null, from: null, why: null, owner: ev.owner ?? null, at };
    case 'owner_dead':
      return s === 'other_agent' ? to('orphan') : entry;
    default:
      throw new Error(`unknown ledger event ${ev.type}`);
  }
}

/** A change the agent should hear about on its next reply: a tab my click opened, or one that went stale / taken over / gone. */
export function isNews(prev, next, ev) {
  if (next === prev || !next) return false;
  if (ev.type === 'popup') return true;
  if (prev && prev.helped && !next.helped && next.state === 'taken_over') return true;   // help over: now "leave it"
  return next.state !== (prev && prev.state) && (next.state === 'stale' || next.state === 'taken_over' || next.state === 'gone');
}

/** This process's tabs: the ledger proper (in memory, one per server process). */
export class TabLedger {
  constructor() { this.tabs = new Map(); this.seq = 0; this.reportedSeq = 0; }
  get size() { return this.tabs.size; }
  get(tabId) { return this.tabs.get(Number(tabId)) || null; }
  /**
   * Apply one event; returns the entry after it (null: none).
   * @param o.told  the reply this happens in says so itself: not news for the reminder line
   */
  apply(tabId, ev, { told = false } = {}) {
    const id = Number(tabId);
    const prev = this.tabs.get(id) || null;
    const next = nextTabState(prev, { ...ev, tabId: id });
    if (next === prev || !next) return next;
    if (!MINE.has(next.state)) return prev;          // others' tabs are classified, never kept
    if (!told && isNews(prev, next, ev)) next.newsSeq = ++this.seq;
    else if (prev && prev.newsSeq && ev.type !== 'open' && ev.type !== 'popup') next.newsSeq = prev.newsSeq;
    this.tabs.set(id, next);
    return next;
  }
  /** Attributes that are not a state: `helped` (the agent handed it to the user with wait_for_user). */
  mark(tabId, attrs) {
    const e = this.get(tabId);
    if (e) this.tabs.set(e.tabId, { ...e, ...attrs });
  }
  /** Title / URL from a listing; not a state change. */
  info(tabId, { url, title } = {}) {
    const e = this.get(tabId);
    if (!e) return;
    this.tabs.set(e.tabId, { ...e, ...(title != null ? { title } : {}), ...(url != null && !LIVE.has(e.state) ? { url } : {}) });
  }
  /**
   * The registry now gives this tab to another process (a race on a popup): it is not mine. Not news:
   * a later use of it is warned about as another agent's tab.
   */
  drop(tabId) {
    const e = this.get(tabId);
    if (e) this.tabs.delete(e.tabId);
  }
  /** Mine, in list order: live ones first (by tab id), then taken over, then closed / gone. */
  entries() {
    const rank = { ready: 0, stale: 0, taken_over: 1, closed: 2, gone: 2 };
    return [...this.tabs.values()].sort((a, b) => (rank[a.state] - rank[b.state]) || (a.tabId - b.tabId));
  }
  /** The ones the agent can still use. */
  live() { return this.entries().filter(e => LIVE.has(e.state)); }
  /** Mine that changed since the last reply that showed the ledger. */
  fresh() { return this.entries().filter(e => (e.newsSeq || 0) > this.reportedSeq); }
  hasNews() { return this.fresh().length > 0; }
  /** A reply has shown the ledger (or said nothing was new): closed / gone entries were told once and go. */
  markReported() {
    this.reportedSeq = this.seq;
    for (const e of [...this.tabs.values()]) if (TERMINAL.has(e.state)) this.tabs.delete(e.tabId);
  }
}

/* ------------------------------------------------------------ wording */

const clip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const hostOf = (u) => { try { return new URL(u).host || String(u || ''); } catch { return String(u || ''); } };

/** Why a tab counts as taken over, in the agent's words (src/index.js TAKEOVER_WHY has the same keys). */
export const TAKEOVER_WHY = {
  moved_window: '它被移到了别的窗口',
  url_changed: '它现在的网址不是 agent 打开或点出来的',
  user_viewing: '用户当时正在看它',
  user_interrupted: 'agent 操作它的时候用户接手了键盘鼠标',
  navigation_unverified: '无法确认加载期间的导航仍由 agent 发起'
};

/**
 * How sure the takeover is: 'helped' (the agent handed it to the user: carry on after reading it),
 * 'check' (could also be a slow navigation or a bumped mouse: read it first), 'leave' (dragged away,
 * the user looking at it: do not operate it).
 */
export function takeoverKind(e) {
  if (e.helped) return 'helped';
  return e.why === 'url_changed' || e.why === 'user_interrupted' ? 'check' : 'leave';
}

/** One-line next step for a tab of mine that is not ready (null: nothing to do). */
export function nextAction(e) {
  switch (e.state) {
    case 'stale': return `网址在你上次 read_page 之后变了，编号已失效：先 read_page(tab=${e.tabId})`;
    case 'taken_over': {
      const why = TAKEOVER_WHY[e.why] || '原因不明';
      const k = takeoverKind(e);
      if (k === 'helped') return `用户按你的请求（wait_for_user）处理过它：先 read_page(tab=${e.tabId}) 看现在的页面，再接着做；它不会再被自动关闭`;
      if (k === 'check') return `可能被用户动过（${why}）：先 read_page(tab=${e.tabId}) 看现在的页面；确认用户已交回后在这个标签继续，未确认时先问用户。不要另开标签替代；它不会再被自动关闭`;
      return `可能已被用户接手（${why}）：先不要点击、输入或关闭；可 read_page 查看现状。用户明确交回后在原标签继续，不要另开标签替代`;
    }
    case 'gone': return '已经不在 Chrome 里了（不用关）；还要用就重新 open_tab';
    case 'closed': return '你已关闭';
    default: return null;
  }
}

/** Who opened a registered tab, for others' tabs: "<name>（进程 N）"; records of older builds carry no name. */
export function ownerName(rec) {
  const name = rec && typeof rec.agentName === 'string' && rec.agentName.trim() ? rec.agentName.trim() : null;
  return name ? `agent「${clip(name, 40)}」（进程 ${rec.ownerPid}）` : `agent（进程 ${rec && rec.ownerPid}）`;
}

/**
 * Classify a registered record from this process's point of view (pure).
 * @returns 'mine' | 'other_agent' | 'orphan'
 */
export function classifyRecord(rec, { myPid, isAlive }) {
  if (Number(rec.ownerPid) === Number(myPid)) return 'mine';
  let e = nextTabState(null, { type: 'foreign', tabId: rec.tabId });
  if (!isAlive(Number(rec.ownerPid))) e = nextTabState(e, { type: 'owner_dead' });
  return e.state;
}

/** The section of list_tabs with this session's tabs (lines; titles and URLs from `entries`). */
export function mineSection(entries, { pid = null } = {}) {
  const head = `你（这个会话${pid != null ? `，进程 ${pid}` : ''}）的标签`;
  if (!entries.length) return [`${head}：没有。open_tab 打开的、和你在自己标签里点击弹出的新标签会列在这里。`];
  const out = [`${head}（${entries.length} 个）：`];
  for (const e of entries) {
    const from = e.from != null ? `（tab=${e.from} 点击弹出）` : '';
    const where = TERMINAL.has(e.state) ? '' : `  ${clip(e.title, 60) || '(无标题)'}｜${clip(e.url, 100)}`;
    out.push(`  tab=${e.tabId} ${e.state}${where}${from}`);
    const next = nextAction(e);
    if (next) out.push(`      → ${next}`);
  }
  return out;
}

/** One tab in a footer or a recovery line, at most `width` characters. */
export function shortItem(e, width = 80) {
  const TK = { helped: '·用户处理过，先 read_page', check: '·先 read_page 确认', leave: '·别再操作' };
  const note = e.state === 'stale' ? '·先 read_page' : e.state === 'taken_over' ? TK[takeoverKind(e)] : e.state === 'gone' ? '·已不在' : '';
  const from = e.from != null && e.state === 'ready' ? `（tab=${e.from} 点出）` : '';
  const head = `tab=${e.tabId} ${e.state}${note}${from}`;
  if (TERMINAL.has(e.state)) return head;
  const name = clip(e.title, 28) || hostOf(e.url);
  return clip(`${head}「${name}」`, width);
}

/**
 * The reminder appended to a reply when the ledger changed: one line, at most `cap` tabs.
 * Changed tabs come first (`first`: their ids; else those with newsSeq > sinceSeq). '' when there is nothing to list.
 */
export function footerLine(entries, { cap = 5, width = 80, sinceSeq = 0, first = null } = {}) {
  if (!entries.length) return '';
  const fresh = first ? (e) => first.has(e.tabId) : (e) => (e.newsSeq || 0) > sinceSeq;
  const order = [...entries.filter(fresh), ...entries.filter(e => !fresh(e))];
  const shown = order.slice(0, cap).map(e => shortItem(e, width));
  const more = order.length > cap ? `；另 ${order.length - cap} 个见 list_tabs(mine:true)` : '';
  return `［你的标签有变化］${shown.join('；')}${more}`;
}

/** For an error or warning about a tab that is not usable: what this session can use instead. */
export function recoveryLine(live, { cap = 5, width = 80 } = {}) {
  if (!live.length) return '你这个会话当前没有登记为可用的自有标签；先 list_tabs 查找用户指定的现有标签，再 read_page 查看。继续输入前确认交接，不要直接新开标签。';
  const shown = live.slice(0, cap).map(e => shortItem(e, width));
  const more = live.length > cap ? `；另 ${live.length - cap} 个见 list_tabs(mine:true)` : '';
  return `你这个会话现在可用的标签：${shown.join('；')}${more}`;
}
