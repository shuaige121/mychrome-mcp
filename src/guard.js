/**
 * Click guards — the decision logic that decides whether a click may be sent
 * at all, and whether it may be *reported* as having worked.
 *
 * Everything here is pure or takes its side effects as an injected `ops`
 * object, so `test/guard.test.mjs` can exercise every branch — including the
 * two that cannot be staged on a real desktop (a foreign window covering the
 * target, and the physical mouse being moved mid-flight).
 *
 * Why this exists: on 2026-09-04 a click on a nav link returned ✅ with
 * verified-correct coordinates, yet the page never navigated, and the cursor
 * was found ~90 points away from the target afterwards. The click was reported
 * as a success that nobody had observed. These guards make that impossible.
 */
import { randomUUID } from 'node:crypto';
import { BridgeError, UserInterrupted, sessionError } from './bridge.js';

/** How far the cursor may sit from the intended point at press time (points). */
export const CURSOR_TOLERANCE_PT = 3;
/** A retry path is short on purpose: less time for a hand to interfere again. */
export const RETRY_MOVE_MS = 120;
/** Windows fainter than this are see-through overlays, not real occluders. */
export const MIN_WINDOW_ALPHA = 0.05;
/**
 * Highest window layer we treat as a real occluder. The Dock sits at layer 20
 * and owns a window the full size of the main display (measured on this machine
 * 2026-09-05), so anything from 20 up is system chrome that would veto every
 * click if we believed it.
 */
export const MAX_WINDOW_LAYER = 19;

/** Chrome's own chrome (tab strip + omnibox + bookmarks bar) is ~177pt here. */
export const MAX_PLAUSIBLE_TOOLBAR_PT = 260;
/** macOS Chrome has no left/right window chrome: outerWidth === innerWidth. */
export const MAX_PLAUSIBLE_SIDE_INSET_PT = 8;

/**
 * Is the window→viewport model coords.js uses actually true for this window?
 *
 * coords.js derives the viewport's screen origin from `outerHeight - innerHeight`
 * and assumes any horizontal difference is split evenly between a left and a
 * right border. That holds for a plain macOS Chrome window and nothing else.
 * Dock DevTools (or a side panel) to the right and innerWidth drops by ~390
 * while the window keeps its size, so half of that is charged to a phantom left
 * border and the derived toolbar height collapses to 0 — the computed point
 * then lands in the tab strip.
 *
 * Measured live 2026-09-05: window 1496x938 at (-87,30), viewport 1110x753,
 * ⇒ sideInset 193, toolbarHeight max(0, 938-753-193) = 0. A click aimed at the
 * page header selected a different tab instead, and (before this check) it was
 * reported as a success because the URL had indeed changed.
 *
 * There is no API that reports the viewport's screen offset, so a wrong model
 * cannot be corrected here — only detected. Detected ⇒ refuse to click.
 *
 * A zero or missing size is a different case ('not_shown'): a tab that is not
 * displayed yet (open_tab opens in the background) reports a 0×0 window with a
 * normal viewport (field 2026-10-27: 0×0, viewport 1220×921). Nothing is docked
 * then, so that message must not send anyone looking for DevTools; a docked
 * panel only shrinks the viewport inside a window of normal, positive size.
 */
export function checkViewportGeometry(origin, view) {
  if (!['outerWidth', 'outerHeight', 'innerWidth', 'innerHeight'].every(k => Number(view[k]) > 0)) {
    const n = v => Number.isFinite(Number(v)) ? Math.round(Number(v)) : '?';
    return { ok: false, reason: 'not_shown',
      message: `❌ 标签尚未显示：网页报告的窗口是 ${n(view.outerWidth)}×${n(view.outerHeight)}，可视区 ${n(view.innerWidth)}×${n(view.innerHeight)}，` +
        '说明这个标签还没有在 Chrome 窗口里显示出来（刚在后台打开的标签常见），无法换算屏幕坐标，已放弃这次操作。' +
        '\n请先 read_page 核对页面当前状态（此前可能已有滚动），再决定下一步；不要改用估算的坐标点击。' };
  }
  const dw = Math.abs(Number(view.outerWidth) - Number(view.innerWidth));
  const dh = Math.abs(Number(view.outerHeight) - Number(view.innerHeight));
  // True fullscreen / kiosk: no window chrome at all, and the model is exact.
  if (dw <= 1 && dh <= 1) return { ok: true };

  const size = `窗口 ${Math.round(view.outerWidth)}×${Math.round(view.outerHeight)}，` +
               `网页可视区 ${Math.round(view.innerWidth)}×${Math.round(view.innerHeight)}`;
  const advice =
    '\n常见原因：这个标签页里停靠着开发者工具（DevTools）或侧边栏，把网页挤小了。' +
    '\n请把它关掉（或改成独立窗口），然后重试。';

  if (origin.sideInset > MAX_PLAUSIBLE_SIDE_INSET_PT) {
    return { ok: false, reason: 'side_inset',
      message: `❌ 网页可视区比 Chrome 窗口窄了 ${Math.round(view.outerWidth - view.innerWidth)} point（${size}），` +
        `无法可靠换算屏幕坐标，已放弃点击。${advice}` };
  }
  if (origin.toolbarHeight <= 0) {
    return { ok: false, reason: 'toolbar_zero',
      message: `❌ 算出来的 Chrome 工具栏高度是 0（${size}），这不可能，说明窗口和网页尺寸对不上，已放弃点击。${advice}` };
  }
  if (origin.toolbarHeight > MAX_PLAUSIBLE_TOOLBAR_PT) {
    return { ok: false, reason: 'toolbar_tall',
      message: `❌ 算出来的 Chrome 工具栏高度是 ${Math.round(origin.toolbarHeight)} point，远超正常值（${size}），` +
        `说明网页可视区被挤小了，无法可靠换算屏幕坐标，已放弃点击。${advice}` };
  }
  return { ok: true };
}

export function distance(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Which application owns the top-most real window at a point?
 *
 * `windows` is the front-to-back list of on-screen windows containing the
 * point, as produced by `cgevent windowsat` (CGWindowListCopyWindowInfo with
 * kCGWindowListOptionOnScreenOnly, which is documented to be ordered front to
 * back). Skipped, in order: fully transparent windows, anything below the
 * normal window layer (the desktop picture and the desktop icon layer both
 * cover every point on the screen and occlude nothing), anything at or above
 * the Dock's layer (see MAX_WINDOW_LAYER), degenerate 1-point windows, and the
 * Window Server's own bookkeeping windows.
 *
 * Returns null when nothing qualifies — "cannot tell", not "nothing there".
 * The same rule is implemented in `topOwner(at:)` in src/helper.swift, which
 * re-checks it atomically at press time.
 *
 * @param {Array<{owner?:string, layer?:number, alpha?:number,
 *                bounds?:{x:number,y:number,w:number,h:number}}>} windows
 * @returns {string|null}
 */
export function pickTopWindowOwner(windows) {
  const w = pickTopWindow(windows);
  return w ? w.owner : null;
}

/**
 * The top-most real window at a point (same rules as pickTopWindowOwner),
 * as the whole entry. `skipSmallOfPid` also skips that process's windows under
 * 100 pt in either dimension — Chrome's link-status bubble is a window of its
 * own; the input helper's window guard skips it the same way.
 */
export function pickTopWindow(windows, { skipSmallOfPid = null } = {}) {
  if (!Array.isArray(windows)) return null;
  for (const w of windows) {
    if (!w || typeof w !== 'object') continue;
    if (typeof w.alpha === 'number' && w.alpha <= MIN_WINDOW_ALPHA) continue;
    if (typeof w.layer === 'number' && (w.layer < 0 || w.layer > MAX_WINDOW_LAYER)) continue;
    const b = w.bounds;
    if (b && (Number(b.w) < 2 || Number(b.h) < 2)) continue;
    if (w.owner === 'Window Server') continue;
    if (!w.owner) continue;
    if (skipSmallOfPid != null && Number(w.pid) === Number(skipSmallOfPid) && b &&
        (Number(b.w) < 100 || Number(b.h) < 100)) continue;
    return w;
  }
  return null;
}

/**
 * Is the window on top at a point (`cgevent windowsat` list) the target
 * Chrome window: owned by chromePid, with the target's bounds (±2 pt)?
 * @param bounds  {x,y,w,h} screen points
 */
export function targetWindowOnTop(windows, chromePid, bounds) {
  const w = pickTopWindow(windows, { skipSmallOfPid: chromePid });
  if (!w || Number(w.pid) !== Number(chromePid) || !w.bounds || !bounds) return false;
  const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 2;
  return near(w.bounds.x, bounds.x) && near(w.bounds.y, bounds.y) &&
         near(w.bounds.w, bounds.w) && near(w.bounds.h, bounds.h);
}

/** Chrome's on-screen windows are owned by the process named "Google Chrome". */
export function isChromeOwner(name) {
  return typeof name === 'string' && /^google chrome\b/i.test(name.trim());
}

/**
 * Did the click produce anything we can actually observe?
 *
 * Confirm visible results, not input delivery: navigation, changed visible
 * content, a newly visible dialog or a new tab. Focus and style changes alone
 * do not establish that the button's requested action happened. No observed
 * result within the bounded wait means unknown, not that nothing happened.
 *
 * @returns {{observed:boolean, reasons:string[]}}
 */
export function didClickRegister({ hrefChanged, contentChanged, dialogChanged, stateChanged, newTabs = 0 }) {
  const reasons = [];
  if (hrefChanged) reasons.push('页面地址已改变');
  if (dialogChanged) reasons.push('出现了新的弹层');
  if (contentChanged) reasons.push('可见内容已更新');
  if (stateChanged) reasons.push('目标控件的选中状态已改变');
  if (newTabs > 0) reasons.push('出现了新标签');
  return { observed: reasons.length > 0, reasons };
}

/* ------------------------------------------------ scroll to the target */

/** Top and bottom 10% of the viewport are not a comfortable place to click. */
export const COMFORT_MARGIN = 0.1;
/** Wheel bursts before falling back to a programmatic scroll. */
export const MAX_SCROLL_BURSTS = 12;
/** First guess of CSS px per wheel tick; replaced by what a burst actually moved. */
export const PX_PER_NOTCH = 40;
/** Notches per burst when more than one burst is needed (plan D3 default). */
export const BURST_MIN = 3;
export const BURST_MAX = 8;
/** Only a calibrated scroller more than two viewports away may use a longer burst. */
export const FAR_BURST_MAX = 24;

/**
 * Every box that must show the aim point but does not: each clipping
 * ancestor (the aim must be inside its clip box, a few px in from the edge)
 * and the viewport (the aim must be inside its comfort zone, 10% margins top
 * and bottom). `loc` is src/page/locate.js output (target mode).
 *
 * Boxes are judged innermost first, and an outer box is judged on where the
 * scrollers inside it can put the aim, not on the aim's raw position: a
 * target deep inside an on-screen list is brought into view by the list
 * alone, and the page must not move for it.
 *
 * A box whose scrolling does not move the target (`movesAim: false`: the
 * target sits in a position:fixed layer inside it) has no comfort zone: it
 * blocks only when the aim is outside its clip box, and then nothing can fix
 * it (`pinned`).
 *
 * @returns {Array<{index:number, axis:'x'|'y', dir?:'down'|'up', need?:number, pinned?:boolean}>}
 *          need = CSS px to scroll that box so the aim lands at a random
 *          point in the middle 40% of its zone (not always the centre).
 */
export function aimBlockers(loc, rng = Math.random) {
  const out = [];
  const x = loc.aim.x;
  let y = loc.aim.y;
  (loc.chain || []).forEach((c, index) => {
    const b = c.clip;
    if (c.movesAim === false) {
      if (x < b.x || x > b.x + b.width) out.push({ index, axis: 'x', pinned: true });
      else if (y < b.y || y > b.y + b.height) out.push({ index, axis: 'y', dir: y < b.y ? 'up' : 'down', need: 0, pinned: true });
      return;
    }
    let x0 = b.x, x1 = b.x + b.width, y0, y1;
    if (c.document) {
      y0 = b.y + b.height * COMFORT_MARGIN;
      y1 = b.y + b.height * (1 - COMFORT_MARGIN);
    } else {
      const m = Math.min(8, b.height * COMFORT_MARGIN);
      y0 = b.y + m; y1 = b.y + b.height - m;
      const mx = Math.min(2, b.width * COMFORT_MARGIN);
      x0 += mx; x1 -= mx;
    }
    if (x < x0 || x > x1) { out.push({ index, axis: 'x' }); return; }
    if (y < y0 || y > y1) {
      const zoneTop = b.y + b.height * COMFORT_MARGIN;
      const zoneH = b.height * (1 - 2 * COMFORT_MARGIN);
      const goal = zoneTop + zoneH * (0.3 + 0.4 * rng());
      out.push(y > y1
        ? { index, axis: 'y', dir: 'down', need: y - goal }
        : { index, axis: 'y', dir: 'up', need: goal - y });
    }
    // Where this box can put the aim for the boxes outside it: into its own
    // band, as far as its remaining scroll range allows.
    if (c.scrollableY && !c.document) {
      const lo = y - Math.max(0, c.maxTop - c.scrollTop), hi = y + Math.max(0, c.scrollTop);
      y = Math.min(hi, Math.max(lo, Math.min(y1, Math.max(y0, y))));
    }
  });
  return out;
}

/**
 * Can the aim be pressed where it is: inside the visible part of the target
 * (clipped by every ancestor and the viewport) and hit-tested as the target?
 * The comfort zone is a preference; this is the requirement.
 */
export function aimClickable(loc) {
  const v = loc && loc.visible, a = loc && loc.aim;
  if (!v || !a || !loc.hitOk) return false;
  return a.x >= v.x + 1 && a.x <= v.x + v.width - 1 && a.y >= v.y + 1 && a.y <= v.y + v.height - 1;
}

/**
 * The next wheel burst that brings the target closer (plan D1, codex #11):
 * of the boxes that still hide the aim, the OUTERMOST one the pointer can
 * reach (locate.js found a point where a wheel in that direction scrolls it)
 * and that can still move that way.
 *
 * When no box can move any more but the aim is already clickable (a header
 * link on a page scrolled to the top, a sticky bar), that is done too
 * (`edge:true`): the comfort zone is not worth a programmatic scroll.
 *
 * @param loc        locate.js target-mode result
 * @param opts.exhausted  Set of chain keys (`${index}:${sig}`) whose last burst did not move the target
 * @param opts.pxPerNotch CSS px one wheel tick moved last time
 * @param opts.pxByScroller Map of chain keys to measured CSS px per tick; measurements are local to each box
 * @returns {{done:true, edge?:true} |
 *           {unreachable:'horizontal'|'not_scrollable'|'at_limit'|'no_progress'|'no_pointer_spot'} |
 *           {index:number, key:string, sig:string, dir:'down'|'up', need:number, notches:number, point:{x,y}}}
 */
export function planScrollStep(loc, { rng = Math.random, exhausted = new Set(), pxPerNotch = PX_PER_NOTCH,
                                     pxByScroller = new Map() } = {}) {
  const blockers = aimBlockers(loc, rng);
  if (!blockers.length) return { done: true };
  const stuck = (unreachable) => (aimClickable(loc) ? { done: true, edge: true } : { unreachable });
  if (blockers.some(b => b.axis === 'x')) return stuck('horizontal');
  const chain = loc.chain;
  const why = (b) => {
    const c = chain[b.index];
    if (b.pinned || !c.scrollableY) return 'not_scrollable';
    if (b.dir === 'down' ? c.scrollTop >= c.maxTop - 1 : c.scrollTop <= 0) return 'at_limit';
    if (exhausted.has(`${b.index}:${c.sig}`)) return 'no_progress';
    return c.wheel && c.wheel[b.dir] ? null : 'no_pointer_spot';
  };
  const usable = blockers.filter(b => !why(b));
  if (!usable.length) {
    const reasons = blockers.map(why);
    return stuck(['not_scrollable', 'at_limit', 'no_progress', 'no_pointer_spot'].find(r => reasons.includes(r)));
  }
  const b = usable.reduce((o, x) => (x.index > o.index ? x : o));
  const c = chain[b.index];
  const key = `${b.index}:${c.sig}`;
  const measured = pxByScroller.get(key);
  const calibrated = Number.isFinite(measured) && measured > 1;
  const px = calibrated ? measured : pxPerNotch > 1 ? pxPerNotch : PX_PER_NOTCH;
  let notches = Math.max(1, Math.ceil(b.need / px));
  const viewport = loc.view && loc.view.innerHeight;
  if (calibrated && Number.isFinite(viewport) && viewport > 0 && b.need > 2 * viewport) {
    notches = Math.max(1, Math.min(FAR_BURST_MAX, Math.floor(0.8 * b.need / px)));
  } else if (notches > BURST_MAX) {
    notches = BURST_MIN + Math.floor(rng() * (BURST_MAX - BURST_MIN + 1));
  }
  return { index: b.index, key, sig: c.sig, dir: b.dir,
    need: Math.round(b.need), notches, point: c.wheel[b.dir] };
}

/** How far a chain box moved between two locate results (CSS px, signed), or null. */
export function chainDelta(before, after, index) {
  const a = before?.chain?.[index], b = after?.chain?.[index];
  if (!a || !b || a.sig !== b.sig) return null;
  return b.scrollTop - a.scrollTop;
}

/* ---------------------------------------------------------------- typing */

/** type_text's input modes. Clipboard input always requires an explicit choice. */
export const INPUT_MODES = ['paste', 'keys'];

/**
 * How type_text sends `text`:
 *  - 'keys' (default): real US keyboard events in character order.
 *  - 'paste': the whole text in one explicit Cmd+V.
 * Characters without a supported key are refused before any input; a request
 * for keys must never silently switch to the clipboard partway through.
 * @returns {{mode:'type'|'paste', text:string}[]}
 */
export function typingSegments(text, inputMode = 'keys') {
  const s = String(text);
  if (!INPUT_MODES.includes(inputMode)) {
    throw new BridgeError('bad_input_mode', `❌ input_mode 只能是 ${INPUT_MODES.join(' 或 ')}。`);
  }
  if (inputMode === 'paste') return s ? [{ mode: 'paste', text: s }] : [];
  if (/[^\x20-\x7e\n\r\t]/.test(s)) {
    throw new BridgeError('unsupported_key_text',
      '❌ 逐键模式暂不支持这段文字中的非 ASCII 字符或控制字符，没有输入。需要粘贴时请显式设置 input_mode: "paste"，不会自动改用剪贴板。');
  }
  return s ? [{ mode: 'type', text: s }] : [];
}

/**
 * Characters the helper's `type` op counts as delivered (`typed`): one per
 * character, CR LF being one Return (it iterates Swift Characters).
 */
export function typedCount(text) {
  return [...String(text).replace(/\r\n/g, '\n')].length;
}

/**
 * Non-modifier key-ups a page sees for `text` typed with `type`: one per
 * character, four for a tab (typed as four spaces).
 */
export function keyupCount(text) {
  return [...String(text).replace(/\r\n/g, '\n')].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);
}

/* ------------------------------------------------ one locked input action */

/**
 * The sequence every input action follows (docs/impl-contract.md §3, §7), with
 * its side effects injected so test/guard.test.mjs can drive every outcome:
 *
 *   wait for the user's hands to be off  (only valid before we post, F18)
 *   → snapshot their scene and pointer
 *   → prepare(): bring the target on screen and return {chromePid, cgWindow,
 *     windowBounds, touchesScene}; it throws to refuse, before any input
 *   → no user input since the idle wait ended (nothing of ours posted yet)
 *   → session `begin` (refused without the input monitor)
 *   → action(session, prep, ctx): delivers the input and returns as soon as
 *     the page is known to have consumed it; what is left to watch (URL
 *     change, new tabs) is registered with ctx.observe(fn)
 *   → then, when returnFocus requests origin restoration:
 *       success           → restore the scene, warp the pointer back, WHILE the
 *                           session's tap still watches: a user who takes over
 *                           during the restore is not pulled back
 *       user interrupted  → leave the pointer and Chrome's windows as the user
 *                           has them (codex #9); only hand the front back to
 *                           the user's app when our activation left Chrome in
 *                           front and the user did not click (see handBackApp)
 *       other failure     → as success, then report
 *     current, invalid held policy, or a marked human handoff → close without
 *     app/window/tab/pointer restoration; keep the same observation/error path.
 *   → the observation, after the release/restoration (still under the input lock, so
 *     sweeps stay inert): its URL becomes the tab's expected URL only when the
 *     action ended without the user and no mouse button went down since.
 *   A refusal before anything was posted (prepare, begin) is re-checked
 *   against the idle counter: a user who acted meanwhile is an interruption.
 *   When the session cannot answer any more, the idle counter is used again
 *   from the last clean status (nothing of ours is posted after it).
 *
 * ops: { waitForUserIdle() -> ms, now() -> epoch ms, snapshotScene() -> scene|null,
 *        waitForHandsOff() -> ms              optional, takeover: until the user is done typing/clicking
 *        mousepos() -> {x,y}|null, prepare(pre, {pointer, session, scene}, ctx) -> prep, userActedSince(ms) -> bool,
 *        openSession() -> {request, close, interrupted},
 *        restoreScene(scene, {since}) -> reply   since: epoch ms of the last clean look
 *        warp(point) (only when the session is gone),
 *        restoreApp(scene, {noClickSince}) -> reply   optional, see handBackApp
 *        currentUrl(prep) -> url|null,
 *        noteNavigation(prep, url)            optional: the tab's URL at the end of an
 *                                             action the user did not touch is the agent's
 *        userClickedSince(ms) -> bool         optional: a mouse button went down since
 *        navigationUntouched(prep, since) -> bool  scoped native routing evidence covering
 *                                             keyboard and mouse input in the target window
 *        activates: false                     the action never brings Chrome forward (scroll)
 *        returnFocus: {mode,source}             frozen at first hold; reuse policy always wins
 *        veil(pre) -> {rect?, label, point?}  optional, takeover: what the veil shows (hold's `veil`)
 *        inherit: {scene, pointer, touched, claim()}  optional, takeover: the previous agent's takeover
 *                                             is taken over (lock.js hand-over): no scene is read; once
 *                                             this session holds, claim() — false: withdrawn, nothing
 *                                             of anyone's was touched (code handoff_lost)
 *        handoff(payload, {onOffer}) -> null|{to, commit()}  optional, takeover: done and someone waits → their
 *                                             turn instead of putting things back (see below) }
 * ctx.step(text, key?) records what has been completed, for the interruption report.
 * ctx.observe(fn) registers fn({noteable, since}) -> {out, url?} to run after the hand-back; its
 * `out` replaces the action's result. It runs only when the action returned. noteable: the action
 * ended without the user; since: epoch ms after which a mouse button going down is the user's
 * (null: the next agent's takeover holds the input; undefined: the user interrupted).
 *
 * @returns {Promise<{outcome:'ok'|'user', out:any, idleWait:number, restored:boolean,
 *                    steps:string[], end:object|null, began:boolean, prep:object|null,
 *                    late?:boolean, sceneRestored?:boolean, kind?:string|null,
 *                    appRestored?:boolean|null, error?:Error}>}
 *          late: the action finished but the user took over while things were
 *          being put back, so the rest was left alone.
 *          Throws the failure for any other outcome, with `lateUser` set when
 *          the same happened while putting things back after it.
 */
/** Quiet window before activation: user input seen by the running session aborts it. */
export const PRE_ACTIVATE_QUIET_MS = 250;

/** Copy a policy at the call/hold boundary; only new legacy calls get a default. */
export function normalizeReturnFocus(value, legacyDefault = false) {
  if (value === undefined && legacyDefault) return Object.freeze({ mode: 'origin', source: 'legacy_default' });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { mode, source } = value;
  if (!['current', 'origin'].includes(mode) || !['explicit', 'legacy_default', 'why_signal'].includes(source)) return null;
  return Object.freeze({ mode, source });
}

function focusReturnMetadata(returnFocus, releaseReason = 'policy') {
  return { returnFocus, releaseReason,
    focusRestoration: !returnFocus ? 'policy_invalid'
      : releaseReason === 'human_handoff' || returnFocus.mode === 'current' ? 'not_requested' : 'requested',
    ...(!returnFocus ? { focusPolicyDiagnostic: 'missing_or_invalid_hold_policy' } : {}) };
}

/** Closing can confirm release and still be the first reply that reports Stop. */
function terminalInputFacts(end, sessionInterrupted = null, status = null) {
  const reported = [status?.interrupted, end?.interrupted, sessionInterrupted];
  // A malformed reported record is still interruption evidence, even when it
  // cannot supply the identity needed by mergeInterrupted or a retry proof.
  const interrupted = mergeInterrupted(reported) || reported.find(Boolean) || null;
  const aborted = end?.takeover?.aborted === true ? end.takeover
    : status?.takeover?.aborted === true ? status.takeover : null;
  const terminalInterrupted = !!(interrupted || aborted);
  return { terminalInterrupted, terminalAborted: !!aborted,
    ...(terminalInterrupted ? { noRetry: true } : {}),
    ...(interrupted ? { interrupted } : {}),
    ...(aborted?.abortedBy ? { terminalAbortedBy: aborted.abortedBy } : {}) };
}

/** Compare raw first-event facts, never the merged earliest-epoch receipt. */
function sameInterruption(a, b, complete) {
  if (!a || !b || !['move', 'button', 'wheel', 'key', 'flags'].includes(a.kind) || a.kind !== b.kind) return false;
  const clocks = ['t', 'epoch'];
  if (complete ? !clocks.every(k => Number.isFinite(a[k]) && Number.isFinite(b[k]))
    : !clocks.some(k => Number.isFinite(a[k]) && Number.isFinite(b[k]))) return false;
  if (!clocks.every(k => (a[k] == null && b[k] == null) ||
      (Number.isFinite(a[k]) && Number.isFinite(b[k]) && a[k] === b[k]))) return false;
  if ([a, b].some(x => x.button != null && typeof x.button !== 'boolean')) return false;
  return (a.button === true || a.kind === 'button') === (b.button === true || b.kind === 'button');
}

/** NAT-RETRY: one internal id per MCP call context (index.js CALL, shared by its internal attempts), sent with
 * ordinary native requests so the helper can tell this call's writes from an earlier call's in a held Session. */
const NATIVE_CALLS = new WeakMap();
function nativeCallTag(call) {
  if (!call || typeof call !== 'object') return {};
  let id = NATIVE_CALLS.get(call);
  if (!id) NATIVE_CALLS.set(call, id = randomUUID());
  return { call: id };
}
export async function runInputAction(ops, action) {
  const detach = [];
  const onSession = ops.onSession;
  // A reused hold is authoritative, including a missing/invalid policy. Never
  // cover a dropped held policy with a fresh caller's compatibility default.
  const focus = { returnFocus: normalizeReturnFocus(ops.reuse ? ops.reuse.returnFocus : ops.returnFocus, !ops.reuse),
    releaseReason: 'policy', closed: false, end: null, blockRecovery: false, terminal: { terminalInterrupted: false, terminalAborted: false } };
  const facts = (prior = null) => ({ ...focusReturnMetadata(focus.returnFocus, focus.releaseReason), ...focus.terminal,
    ...(prior?.terminalInterrupted === true || prior?.terminalAborted === true ? { terminalInterrupted: true, noRetry: true } : {}),
    ...(prior?.terminalAborted === true ? { terminalAborted: true } : {}),
    ...(prior?.terminalAbortedBy && !focus.terminal.terminalAbortedBy ? { terminalAbortedBy: prior.terminalAbortedBy } : {}),
    ...(prior?.noRetry === true ? { noRetry: true } : {}),
    ...(prior?.interrupted ? { interrupted: mergeInterrupted([prior.interrupted, focus.terminal.interrupted]) || prior.interrupted } : {}),
    ...(focus.closed ? { inputReleased: focus.end?.ok === true && focus.end?.takeover?.active !== true } : {}) });
  // HI2: a session whose helper was neither confirmed stopped (acknowledgement) nor confirmed gone (exit).
  const sessions = new Set();
  const unconfirmed = () => [...sessions].some(s => s?.helperStop === 'unconfirmed');
  // HI2 r2: every return waits for a stop this call started (a caller cancel, a timeout), and a stopped session is never
  // handed back as a job's healthy kept hold: it is closed here and the call reports the stop.
  const stopped = () => [...sessions].filter(s => s?.stopStarted === true);
  const settleStops = async () => {
    for (const s of stopped()) await s.stopSettled?.().catch(() => null);
    for (const s of stopped()) await s.close?.().catch(() => null);
  };
  try {
    let result = await runInputActionCore({ ...ops, onSession(session) {
      sessions.add(session);
      const cleanup = onSession?.(session);
      if (typeof cleanup === 'function') detach.push(cleanup);
    } }, action, focus);
    if (stopped().length) {
      await settleStops();
      if (result.kept) {
        throw Object.assign(new BridgeError('cancelled', '⏹ 调用已取消：键盘鼠标助手已停止，接管已结束，没有保留给后续步骤。' +
          '\n给 agent：不要自动重试；先 read_page 核对页面，再决定下一步。'),
        { steps: result.steps, sent: result.sent || [], inputDelivery: 'unknown', noRetry: true,
          helperStop: stopped().map(s => s.helperStop).find(Boolean) || null });
      }
    }
    if (unconfirmed()) {
      throw Object.assign(new BridgeError('session_failed', '❌ 操作已执行，但无法确认鼠标键盘助手已经停止（没有结束回复，进程也没能确认退出）。' +
        '\n给 agent：不要重试；先 read_page 核对页面。'), { steps: result.steps, sent: result.sent || [], helperStop: 'unconfirmed' });
    }
    return { ...result, ...facts(result.error),
      ...(focus.terminal.terminalInterrupted && result.outcome === 'ok' ? { outcome: 'user', late: true, restored: false } : {}) };
  } catch (error) {
    if (stopped().length) {
      await settleStops();
      // A stopped session is not the job's hold any more: nothing is kept for a retry (taskRun releases the lease).
      if (error.keptHold) { delete error.keptHold; error.noRetry = true; }
    }
    const terminal = facts(error);
    Object.assign(error, terminal);
    // HI2: with neither, whatever the helper may still do is unknown: never not_sent, never retried.
    if (unconfirmed()) Object.assign(error, { inputDelivery: 'unknown', noRetry: true, helperStop: 'unconfirmed' });
    throw error;
  } finally { for (const cleanup of detach) cleanup(); }
}

async function runInputActionCore(ops, action, focus) {
  const returnFocus = focus.returnFocus;
  let restoreRequested = returnFocus?.mode === 'origin';
  if (!ops.reuse && ops.inherit && !restoreRequested) {
    throw Object.assign(new BridgeError('focus_handoff_conflict', '当前归还策略不能接过其他任务的原场景；没有发送输入。'),
      { inputDelivery: 'not_sent', noRetry: true });
  }
  const pagePromptAuto = ops.pagePromptAuto || null;
  // NAT-RETRY: sent with ordinary native requests only (bind, normal nativeChrome), never with restore.
  const callTag = nativeCallTag(ops.nativeCall);
  const checkAuto = () => {
    if (!pagePromptAuto) return;
    const reuse = ops.reuse;
    if (!ops.takeover || !ops.keep || !reuse || reuse !== pagePromptAuto.kept ||
        reuse.session !== pagePromptAuto.session || reuse.nativeState?.epoch !== pagePromptAuto.epoch ||
        pagePromptAuto.attemptBudget !== 1 || pagePromptAuto.noRetarget !== true ||
        !['chromePid', 'windowId', 'tabId', 'cgWindow'].every(k => reuse.nativeState?.target?.[k] === pagePromptAuto.target?.[k]) ||
        typeof pagePromptAuto.check !== 'function') {
      throw Object.assign(new BridgeError('page_auto_hold_changed', '原接管身份已变化，未自动操作。'), { inputDelivery: 'not_sent', noRetry: true });
    }
    pagePromptAuto.check();
  };
  // Refuse before idle, scene preparation or any possible Session acquisition.
  checkAuto();
  const T = { start: Date.now() };  // diagnostic timing only (not ops.now)
  // Takeover: the hold comes first; the user's scene is recorded only once it is frozen. Right before
  // it the user finishes typing or clicking (hold: waitForHandsOff).
  let idleWait = ops.takeover ? 0 : await ops.waitForUserIdle();
  const idleEnd = ops.now();
  T.idleEnd = Date.now();
  // HI1 v3: without takeover these reads come first; the call budget's boundary precedes each (no-op without a budget).
  if (!ops.takeover) await ops.budgetCheck?.();
  let scene = ops.takeover ? null : await ops.snapshotScene();
  if (!ops.takeover) await ops.budgetCheck?.();
  let pointer = ops.takeover ? null : await ops.mousepos();
  const steps = [];
  const keyed = new Map();
  const sent = new Map();
  // An empty local ledger cannot erase delivery already reported by the error.
  const sentKinds = error => [...new Set([...(Array.isArray(error?.sent) ? error.sent : []), ...sent.keys()])];
  let observer = null;
  const nativeState = ops.reuse?.nativeState || {
    epoch: null, target: null, restoreToken: null, sequence: 0, unknown: false, preserveSelection: false
  };
  const nativeFailure = (code, message) => Object.assign(new BridgeError(code, message), { inputDelivery: 'not_sent' });
  const checkBoundary = async (restore = false) => {
    try { checkAuto(); await (restore ? ops.beforeRestore?.() : ops.beforeSend?.()); }
    catch (error) {
      // A changed rule or expired auto snapshot cancels only this private attempt.
      // It is not a task Stop and must not revoke an otherwise healthy task Session.
      if (pagePromptAuto && String(error.code || '').startsWith('page_auto_')) throw error;
      const reason = error.code === 'paused_by_user' ? 'pause' : error.code === 'conversation_waiting' ? 'conversation'
        : error.code === 'cancelled' ? 'caller' : 'task';
      if (reason !== 'pause') nativeState.revoked = true;
      if (ops.nativeTransactions && session) await session.request({ op: 'revokeNative', reason }, { raw: true }).catch(() => {});
      throw error;
    }
  };
  const captureEpoch = reply => {
    if (!ops.nativeTransactions) return;
    if (!Number.isSafeInteger(reply?.epoch) || reply.epoch < 1 ||
        (nativeState.epoch != null && nativeState.epoch !== reply.epoch)) {
      throw nativeFailure('native_epoch_changed', '原生 Session 代次已失效，没有继续发送。');
    }
    nativeState.epoch = reply.epoch;
  };
  let settleMs = ops.reuse?.settleMs || 0;
  const ctx = {
    steps,
    /** HI1 v3: the call budget's boundary for a prepare step right before its first write (activation, tab selection). */
    budget: () => budgetCheck(),
    /** HI v3.3: the first write or input request is issued now (after its chokepoint check): no budget check after it. */
    issued: () => { if (!pagePromptAuto) ops.issued?.(); },
    /** Call right BEFORE posting input the page may act on (click, key, paste, enter, wheel)... */
    sent(kind) {
      // HI v3.2: the call's first write or input event checks the budget right before it is sent (index.js firstWrite).
      if (!pagePromptAuto) ops.firstWrite?.();
      if (pagePromptAuto && pagePromptAuto.dispatched) throw Object.assign(new BridgeError('page_auto_attempt_used', '自动处理已尝试，不会重复发送。'), { inputDelivery: 'not_sent', noRetry: true });
      if (pagePromptAuto) pagePromptAuto.dispatched = true;
      sent.set(kind, (sent.get(kind) || 0) + 1);
    },
    /** ...and this when the helper reports that request posted none of it after all. */
    unsent(kind) { const n = (sent.get(kind) || 0) - 1; if (n > 0) sent.set(kind, n); else sent.delete(kind); },
    /** Creation can activate Chrome late; its final restoration stays under the same hold. */
    settleScene(ms) { settleMs = Math.max(settleMs, Number(ms) || 0); },
    /** Mark a prepared field for the human; this grants no native write authority. */
    async handToHuman(target) {
      if (pagePromptAuto) throw nativeFailure('page_auto_handoff_forbidden', '自动处理不能发起人工交接。');
      if (!nativeState.target || !target || ['chromePid', 'windowId', 'tabId', 'cgWindow'].some(k => target[k] !== nativeState.target[k])) {
        throw nativeFailure('native_target_changed', '不能交接未经绑定的标签选择。');
      }
      if (!ops.nativeTransactions || !ops.takeover || ops.keep || !held || !session || !Number.isSafeInteger(nativeState.epoch) ||
          nativeState.epoch < 1 || nativeState.unknown || nativeState.revoked) {
        throw nativeFailure('native_session_required', '原接管无法确认，没有发起人工交接。');
      }
      const captured = session, epoch = nativeState.epoch;
      await ctx.check();
      if (session !== captured || nativeState.epoch !== epoch || nativeState.unknown || nativeState.revoked ||
          ['chromePid', 'windowId', 'tabId', 'cgWindow'].some(k => target[k] !== nativeState.target?.[k])) {
        throw nativeFailure('native_target_changed', '人工交接前原接管或目标已变化。');
      }
      focus.releaseReason = 'human_handoff';
      restoreRequested = false;
    },
    async bindNativeTarget(target) {
      if (pagePromptAuto) {
        checkAuto();
        if (!['chromePid', 'windowId', 'tabId', 'cgWindow'].every(k => target?.[k] === pagePromptAuto.target[k])) {
          throw nativeFailure('page_auto_retarget', '自动处理不能改变原目标。');
        }
        return;
      }
      if (!ops.nativeTransactions) return;
      if (!target || !['chromePid', 'windowId', 'tabId', 'cgWindow'].every(k => Number.isSafeInteger(target[k]) && target[k] > 0)) {
        throw nativeFailure('native_target_unknown', '原生目标身份不完整，没有发送。');
      }
      if (!ops.takeover && !began) await begin({ ...target, windowBounds: target.bounds ? {
        x: target.bounds.left, y: target.bounds.top, w: target.bounds.width, h: target.bounds.height
      } : undefined });
      await ctx.check();
      const reply = await session.request({ op: 'bindNativeTarget', schema: 1, epoch: nativeState.epoch, ...callTag,
        target: Object.fromEntries(['chromePid', 'windowId', 'tabId', 'cgWindow'].map(k => [k, target[k]])) });
      captureEpoch(reply);
      nativeState.target = { ...target };
      if (!ops.takeover && !nativeState.restoreToken) await ctx.recordNativeScene(scene);
    },
    async recordNativeScene(original) {
      if (pagePromptAuto) throw nativeFailure('page_auto_scene_forbidden', '自动处理不能重新记录场景。');
      if (!ops.nativeTransactions || nativeState.restoreToken) return;
      if (!original || !session || nativeState.epoch == null) throw nativeFailure('native_scene_unknown', '原场景尚未记录，没有发送。');
      const reply = await session.request({ op: 'recordNativeScene', schema: 1, epoch: nativeState.epoch, scene: original });
      captureEpoch(reply);
      if (typeof reply.restoreToken !== 'string' || !reply.restoreToken) throw nativeFailure('native_scene_unknown', '原场景凭据缺失，没有发送。');
      nativeState.restoreToken = reply.restoreToken;
    },
    async native(intent, { policy = 'normal', beforeCloseEnqueue = null } = {}) {
      // Private synchronous gate for this held close attempt, never a generic
      // callback or a restore hook. A Promise cannot grant enqueue authority.
      if (beforeCloseEnqueue != null && (typeof beforeCloseEnqueue !== 'function' ||
          Object.prototype.toString.call(beforeCloseEnqueue) === '[object AsyncFunction]' ||
          policy !== 'normal' || intent?.kind !== 'closeTab' || intent.tabId !== nativeState.target?.tabId)) {
        throw nativeFailure('native_session_required', '关闭发送边界无效，没有发送。');
      }
      if (pagePromptAuto && (policy !== 'normal' || intent?.kind !== 'dialogAnswer' || intent.autoConstraint !== pagePromptAuto.autoConstraint)) {
        throw nativeFailure('page_auto_native_forbidden', '自动处理只能回答已验证的原对话框。');
      }
      const captured = session;
      if (!ops.nativeTransactions || !captured || nativeState.epoch == null || nativeState.unknown || nativeState.revoked ||
          !['normal', 'restore'].includes(policy) || (policy === 'restore' && intent?.kind !== 'restoreScene')) {
        throw nativeFailure('native_session_required', '同一原生 Session 已失效，没有继续发送。');
      }
      if (policy === 'normal') await ctx.check();
      else {
        await checkBoundary(true);
        const status = await captured.request({ op: 'status' }, { raw: true }).catch(() => null);
        if (!status || status.ok === false || status.interrupted || status.takeover?.aborted ||
            (ops.takeover && !status.takeover?.active) || (status.nativePaused && !status.takeover?.active)) {
          throw nativeFailure('task_hold_lost', '接管已经结束，没有还原写入。');
        }
        captureEpoch(status);
      }
      // HI v3.2: ...and so does a native write (activation, tab selection, window move, dialog answer). Never a restore.
      if (policy === 'normal' && !pagePromptAuto) { ops.firstWrite?.(); ops.issued?.(); }   // checked, then issued below
      const operationId = `native-${++nativeState.sequence}`;
      try {
        if (beforeCloseEnqueue != null) {
          const allowed = beforeCloseEnqueue();
          if (allowed !== true) {
            if (allowed && typeof allowed.then === 'function') Promise.resolve(allowed).catch(() => {});
            throw nativeFailure('native_session_required', '关闭发送边界未同步授权，没有发送。');
          }
        }
        const reply = await captured.request({ op: 'nativeChrome', schema: 1, operationId, epoch: nativeState.epoch,
          intent: { ...intent, ...(policy === 'restore' ? { preserveSelection: nativeState.preserveSelection } : {}) },
          policy, ...(policy === 'restore' ? { restoreToken: nativeState.restoreToken } : callTag) });
        if (!reply || reply.epoch !== nativeState.epoch || reply.operationId !== operationId ||
            !['sent', 'not_sent', 'unknown'].includes(reply.inputDelivery) || !Array.isArray(reply.stages)) throw Object.assign(new BridgeError('native_delivery_unknown', '原生回执缺少同代次凭据，不会重试或还原。'),
          { reply, inputDelivery: 'unknown', stages: reply?.stages, noRetry: true });
        if (reply.inputDelivery === 'unknown') throw Object.assign(new BridgeError('native_delivery_unknown', '原生发送状态未知，不会重试或还原。'),
          { reply, inputDelivery: 'unknown', stages: reply.stages, noRetry: true });
        return reply;
      } catch (error) {
        if (error.inputDelivery === 'unknown' || error.reply?.inputDelivery === 'unknown') {
          nativeState.unknown = true; nativeState.error = error; error.nativeDeliveryUnknown = true; error.inputDelivery = 'unknown'; error.noRetry = true;
        }
        throw error;
      }
    },
    async check() {
      await checkBoundary();
      if (ops.takeover) {
        const q = await session?.request({ op: 'status' }, { raw: true }).catch(() => null);
        if (!q || q.ok === false || q.interrupted || session?.interrupted || !q.takeover?.active || q.takeover.aborted) {
          if (q?.takeover?.aborted || q?.error === 'aborted') throw sessionError(q);
          const e = new Error('接管状态无法确认，已停止，没有继续发送。');
          e.code = 'task_hold_lost';
          e.by = q?.takeover?.abortedBy || q?.takeover?.releasedBy || null;
          throw e;
        }
        captureEpoch(q);
      }
      if (ops.nativeTransactions && !ops.takeover && began) {
        const q = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
        if (!q || q.ok === false || q.interrupted || session.interrupted) throw sessionError(q || { error: 'session_failed' });
        captureEpoch(q);
      }
      if (nativeState.unknown) throw Object.assign(nativeFailure('native_delivery_unknown', '此前发送状态未知，不会继续。'), { inputDelivery: 'unknown', noRetry: true });
      await checkBoundary();
    },
    /** PERM1 r1 A3: a healthy physical hold right now (takeover mode, held, and the session's status confirms it). The
     * probe of type_text needs it; monitored mode or a lost hold answers false (observe only). */
    async holdHealthy() {
      if (!ops.takeover || !held || !session) return false;
      const q = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
      return !!q && q.ok !== false && !q.interrupted && !session.interrupted && q.takeover?.active === true && !q.takeover.aborted;
    },
    /** Record a completed step; a `key` replaces that key's earlier entry (running totals). */
    step(text, key = null) {
      if (key != null && keyed.has(key)) { steps[keyed.get(key)] = text; return; }
      if (key != null) keyed.set(key, steps.length);
      steps.push(text);
    },
    /** Diagnostic timestamp inside the action (shown in the timing line). */
    mark(name) { T['a:' + name] = Date.now(); },
    /** Page observation for after the hand-back: fn({noteable, since}) -> {out, url?}. */
    observe(fn) { observer = fn; },
    /** The takeover panel: `stage` is under way (`state` 'done', or 'fail': it did not happen). Fire and forget. */
    panel(stage, state = 'run') {
      if (session && held) session.request({ op: 'panel', stage, state }, { raw: true }).catch(() => {});
    }
  };
  let prep = null, session = null, out, err = null, began = false, failedAt = null, pre = null;
  let priorCloseAborts = [];
  // Closing is resource cleanup in every policy, and a failed reply is not
  // permission to close or restore a second time through a fallback branch.
  const closeSession = async ({ statuses = [], interruptions = [], userInterruption = false, retryBeforeInput = false } = {}) => {
    if (!session) return null;
    if (!focus.closed) {
      // Freeze each source separately before close can replace or mutate the
      // sticky Session record. beforeBegin is a local annotation, not identity.
      const before = [err?.interrupted, err?.reply?.interrupted, session.interrupted,
        ...statuses.map(s => s?.interrupted), ...interruptions].filter(Boolean).map(x => Object.freeze({ ...x }));
      priorCloseAborts = Object.freeze([err?.reply, ...statuses].filter(s => s?.takeover?.aborted === true)
        .map(s => Object.freeze({ aborted: true, abortedBy: s.takeover.abortedBy })));
      const priorAbort = priorCloseAborts.length ? { takeover: priorCloseAborts[0] } : null;
      focus.closed = true;
      focus.end = await session.close().catch(() => null);
      const sessionInterrupted = session.interrupted;
      const postSources = [focus.end?.interrupted, sessionInterrupted];
      const after = postSources.filter(Boolean).map(x => ({ ...x }));
      const confirmedEnd = focus.end?.ok === true && focus.end?.takeover?.active !== true;
      const repeated = complete => before.length > 0 && after.length > 0 &&
        before.every(x => sameInterruption(before[0], x, complete)) &&
        after.every(x => sameInterruption(before[0], x, complete));
      focus.terminal = terminalInputFacts(focus.end, sessionInterrupted, priorAbort);
      if ((before.length || userInterruption) && (!confirmedEnd || (userInterruption && !after.length))) {
        focus.terminal.terminalInterrupted = true;
        focus.terminal.noRetry = true;
        if (before.length) focus.terminal.interrupted ||= mergeInterrupted(before) || before[0];
      }
      // Only the ordinary monitored, clean-before-input branch may retain its
      // existing retry policy when confirmed close repeats that exact event.
      if (retryBeforeInput && confirmedEnd && !focus.terminal.terminalAborted && postSources.every(Boolean) && repeated(true)) {
        focus.terminal.terminalInterrupted = false;
        delete focus.terminal.noRetry;
      }
      // A terminal Stop or newly discovered interruption cannot authorize a
      // post-close recovery. Preserve the existing guarded app hand-back for
      // an ordinary known event using its available clock fields (A3/A4).
      // That weaker legacy recovery proof never grants retry permission.
      focus.blockRecovery = focus.terminal.terminalAborted || err?.terminalInterrupted === true || err?.terminalAborted === true ||
        (before.length > 0 && !confirmedEnd) || (after.length > 0 && !repeated(false));
      T.releaseDone = Date.now();
    }
    return focus.end;
  };
  // While the session holds the user's input (takeover), what they do never
  // reaches any app, but it still resets the idle counters: those checks are skipped.
  let held = false;
  // A long job's next action (index.js task hold): the session, the hold and the user's scene are
  // the job's, kept from its first action; nothing is held, begun or recorded again.
  const reuse = ops.reuse || null;
  if (reuse) { session = reuse.session; held = true; began = true; scene = reuse.scene; pointer = reuse.pointer; ops.onSession?.(session); }
  const ensureSession = async () => {
    checkAuto();
    if (pagePromptAuto && !session) throw nativeFailure('page_auto_session_required', '原输入会话已结束，未重新接管。');
    if (!session) { session = await ops.openSession(); ops.onSession?.(session); }
    return session;
  };
  // HI1 (v3): the call budget's stage boundary (index.js inputBudgetGate), before the preflight, the hands-off wait,
  // the hold and the activation. It throws; it aborts nothing, and a stage that has started runs to its end.
  // Outside checkBoundary: a refusal here revokes nothing, so a job's kept hold survives it.
  const budgetCheck = async () => { if (ops.budgetCheck) await ops.budgetCheck(); };
  let dialogToken = null;
  const inspectNativeDialog = async target => {
    const own = await ensureSession();
    const identity = Object.fromEntries(['chromePid', 'windowId', 'tabId', 'cgWindow'].map(k => [k, target[k]]));
    const reply = await own.request({ op: 'inspectDialog', schema: 1, target: identity, ...(dialogToken ? { dialogToken } : {}) });
    if (reply.known !== true || (reply.open && !reply.identity?.dialogToken)) throw nativeFailure('dialog_probe_unknown', '无法确认原生对话框身份。');
    if (reply.open && !dialogToken) dialogToken = reply.identity.dialogToken;
    return reply;
  };
  // The previous agent's takeover handed over (lock.js): its user scene becomes ours once claimed.
  const inherit = !reuse && ops.takeover && ops.inherit ? ops.inherit : null;
  const windowChanged = (a, b) => {
    const e = new Error(`窗口在准备和切到前台之间变了（${a} → ${b}），没有操作。`);
    e.code = 'window_changed';
    return e;
  };
  const begin = async (p) => {
    if (reuse) { if (p.cgWindow !== reuse.cgWindow) throw windowChanged(reuse.cgWindow, p.cgWindow); return; }
    await ensureSession();
    const b = await session.request({ op: 'begin', chromePid: p.chromePid, window: p.cgWindow,
      windowBounds: p.windowBounds, ...(ops.takeover && !held ? { takeover: true, ...ops.takeoverLimits } : {}) });
    captureEpoch(b);
    if (b.inputMonitor === false) throw sessionError({ ok: false, error: 'no_input_monitor' });
    held = held || !!(b.takeover && b.takeover.active === true);
    began = true;
  };
  /** Takeover: veil up and the user's input held, THEN read where they were. */
  const hold = async () => {
    T.holdStart = Date.now();
    if (reuse) {
      // Still held: only what the veil says changes. Lost meanwhile (Esc, shake, timeout): stop here.
      let veil = null;
      try { veil = ops.veil ? ops.veil(pre) : null; } catch {}
      const v = await session.request({ op: 'veil', ...(veil ? { veil } : {}) }, { raw: true }).catch(() => null);
      if (!v || v.ok === false || v.held !== true) {
        const e = new Error('长任务的接管已经结束了');
        e.code = 'task_hold_lost';
        e.by = v && v.takeover ? (v.takeover.abortedBy || v.takeover.releasedBy) : null;
        throw e;
      }
      T.held = Date.now();
      return;
    }
    await ensureSession();
    // Wait for the user to be done typing or clicking only now, after the page work (preflight), so they
    // cannot start again in between — not when the input is already held (a hand-over from the previous agent).
    if (!inherit && ops.waitForHandsOff) { await budgetCheck(); idleWait = await ops.waitForHandsOff(); T.holdStart = Date.now(); }
    await budgetCheck();
    await checkBoundary();
    // The veil: the Chrome window from the pre-check (the hole), what is being done, the target point.
    let veil = null;
    try { veil = ops.veil ? ops.veil(pre) : null; } catch {}
    const h = await session.request({ op: 'hold', ...ops.takeoverLimits, ...(veil ? { veil } : {}) }, { raw: true });
    if (!h || h.ok === false) throw sessionError(h || { ok: false, error: 'session_failed' });
    captureEpoch(h);
    held = true;
    T.held = Date.now();
    // When the helper's tap began holding (its own clock), for the timing detail line.
    if (Number.isFinite(h.heldAt)) T.heldAt = h.heldAt;
    if (inherit) {
      // Our veil is up and the user's input held: only now may the previous holder let go.
      if (!await inherit.claim()) {
        const e = new Error('上一个 agent 撤回了交接');
        e.code = 'handoff_lost';
        throw e;
      }
      scene = inherit.scene;
      pointer = inherit.pointer;
      T.sceneRead = Date.now();
      await ctx.recordNativeScene(scene);
      // Cancelled while it waited: the handed scene is ours now, so it is put back (below), nothing else done.
      if (ops.signal && ops.signal.aborted) throw Object.assign(new Error('调用已取消：接过的接管直接还原，没有操作。'), { code: 'cancelled' });
      return;
    }
    [scene, pointer] = await Promise.all([ops.snapshotScene(), h.pointer ? h.pointer : ops.mousepos()]);
    T.sceneRead = Date.now();
    await ctx.recordNativeScene(scene);
  };
  try {
    // Page-only preparation (locate, arm the delivery listener) touches nothing of
    // the user's and runs before the hold; everything after it is under the hold.
    // Without takeover the session starts before activation and watches the user through it.
    if (ops.takeover && !reuse) {
      // Started now, primed (tap built, veil built, both off) while the page is being located.
      await ensureSession();
      session.request({ op: 'prime' }, { raw: true }).catch(() => {});
    }
    if (ops.preflight) {
      await budgetCheck();
      pre = await ops.preflight({ inspectNativeDialog, boundary: budgetCheck });
      T.preEnd = Date.now();
    }
    if (ops.takeover) await hold();
    if (pre && pre.session) {
      await begin(pre.session);
      T.begun = Date.now();
      if (!held) {
        await new Promise(r => setTimeout(r, ops.quietMs ?? PRE_ACTIVATE_QUIET_MS));
        const q = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
        if (q && q.interrupted) throw new UserInterrupted({ ...q.interrupted, beforeBegin: true }, q);
      }
    }
    if (session && !held && await ops.userActedSince(idleEnd)) {
      throw new UserInterrupted({ kind: 'input', t: null, beforeBegin: true });
    }
    // The call was cancelled while it waited for its turn: nothing activated, nothing sent.
    if (ops.signal && ops.signal.aborted) throw Object.assign(new Error('调用已取消，没有操作。'), { code: 'cancelled' });
    // Where the user's pointer was when this began: the display they are working on (index.js keeps the agent off it).
    await budgetCheck();
    if (ops.takeover || ops.beforeSend) await ctx.check();
    prep = await ops.prepare(pre, { pointer, session, scene }, ctx);
    // PERM1 (ruling 2, the deferred preflight): a Chrome popup answered inside this hold may have moved the page under
    // it, so the preflight's page evidence (located geometry) is stale: the action measures again, under the hold.
    if (prep?.popupResolved === true && pre && typeof pre === 'object') pre.stale = true;
    checkAuto();
    if (pagePromptAuto && (prep?.touchesScene !== false ||
        !['chromePid', 'windowId', 'tabId', 'cgWindow'].every(k => prep?.target?.[k] === pagePromptAuto.target[k]))) {
      throw nativeFailure('page_auto_retarget', '自动处理不允许前台或目标准备变化。');
    }
    T.activated = Date.now();
    if (!session) {
      if (await ops.userActedSince(idleEnd)) {
        throw new UserInterrupted({ kind: 'input', t: null, beforeBegin: true });
      }
      await begin(prep);
    } else if (reuse) {
      if (prep.cgWindow !== reuse.cgWindow) throw windowChanged(reuse.cgWindow, prep.cgWindow);
    } else if (!began) {
      // Held without a pre-check (scroll, type without a marker): the window is known only now.
      await begin(prep);
    } else if (prep.cgWindow !== (pre?.session?.cgWindow ?? nativeState.target?.cgWindow)) {
      throw windowChanged(pre?.session?.cgWindow ?? nativeState.target?.cgWindow, prep.cgWindow);
    }
    if (ops.takeover || ops.beforeSend) await ctx.check();
    out = await action(session, prep, ctx, pre);
    T.actionEnd = Date.now();
    if (restoreRequested && !ops.keep && !ops.leaveVisible) ctx.panel('restore');
  } catch (e) {
    err = e;
    if (e.inputDelivery === 'unknown' || e.reply?.inputDelivery === 'unknown') { nativeState.unknown = true; nativeState.error = e; e.nativeDeliveryUnknown = true; }
    if (sent.size && e.inputDelivery === 'not_sent') { e.targetInputDelivery = 'not_sent'; e.inputDelivery = 'sent'; }
    if (sent.size && !e.inputDelivery) e.inputDelivery = 'unknown';
    if (sentKinds(e).length) e.noRetry = true;
    if (sentKinds(e).length && e.code === 'paused_by_user') {
      e.message = e.message.replace('这次什么也没做。', '已停止后续操作；此前可能已有操作送达。');
    }
    failedAt = ops.now();
    if (session && held && !(ops.keep && reuse && !sentKinds(e).length)) session.request({ op: 'panel', fail: true }, { raw: true }).catch(() => {});
    // Refused before anything of ours was posted: the user switching windows
    // during activation is a common cause, and the idle counter still tells.
    // Existing safety refusals keep their original error and terminal facts.
    if (!ops.takeover && !began && !sentKinds(e).length && e.noRetry !== true &&
        e.terminalInterrupted !== true && e.terminalAborted !== true && !(e instanceof UserInterrupted) &&
        await ops.userActedSince(idleEnd).catch(() => false)) {
      const u = new UserInterrupted({ kind: 'input', t: null, beforeBegin: true });
      u.cause = e;
      err = u;
    }
  }

  if (pagePromptAuto) {
    // Private one-attempt work never restores, reacquires, retries, or hands off.
    // It either leaves the same healthy hold intact, or closes that exact Session.
    const status = await session?.request({ op: 'status' }, { raw: true }).catch(() => null);
    const healthy = session === pagePromptAuto.session && nativeState.epoch === pagePromptAuto.epoch &&
      status?.epoch === pagePromptAuto.epoch && status.ok !== false && !status.interrupted && !session?.interrupted &&
      status.takeover?.active === true && status.takeover?.aborted !== true && !nativeState.unknown && !nativeState.revoked;
    if (healthy && !err && prep) return { outcome: 'ok', out, idleWait, restored: false, steps, end: null, began, prep, timing: T,
      kept: { session, scene, pointer, cgWindow: prep.cgWindow, chromePid: prep.chromePid, settleMs, nativeState, native: ctx.native, returnFocus: normalizeReturnFocus(returnFocus) } };
    if (healthy && err && !sentKinds(err).length) { err.keptHold = true; err.steps = steps; err.sent = sentKinds(err); err.noRetry = true; throw err; }
    if (sentKinds(err).length) nativeState.unknown = true;
    await closeSession();
    const error = err || nativeFailure('page_auto_hold_lost', '自动处理后原接管无法确认，已停止。');
    error.noRetry = true; error.sent = sentKinds(error);
    error.inputDelivery = err?.inputDelivery ?? err?.reply?.inputDelivery ?? (error.sent.length ? 'unknown' : 'not_sent');
    throw error;
  }

  // A long job's action that failed before anything of ours was posted (a tab lookup that missed for a
  // moment, a page read that timed out): the job keeps its hold and scene instead of putting
  // everything back and taking over again for the retry (seen live 2026-10-06 as needless switching).
  if (!nativeState.unknown && ops.keep && reuse && err && !sentKinds(err).length && !(err instanceof UserInterrupted) &&
      !['user_cancelled', 'takeover_expired', 'task_hold_lost', 'window_changed', 'cancelled', 'conversation_waiting', 'paused_by_user'].includes(err.code)) {
    const q = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
    if (q && q.ok !== false && !q.interrupted && q.takeover && q.takeover.active && !q.takeover.aborted) {
      if (ops.keep && session && held) session.request({ op: 'veil', veil: { label: { zh: '正在重试…', en: 'Retrying…' } } }, { raw: true }).catch(() => {});
      err.keptHold = true;
      err.steps = steps;
      err.sent = sentKinds(err);
      throw err;
    }
  }

  let watching = began && !!session;
  // A cancel (Esc-Esc) or a lost hold is never turned into "the user took over".
  const ended = !!(err && (err.code === 'user_cancelled' || err.code === 'takeover_expired'));
  let user = !ended && (err instanceof UserInterrupted || !!(session && session.interrupted));
  let st = null, st2 = null, statusAt = null, late = false, lateIntr = null, lateSince = null;
  if (watching && !user) {
    // The URL is read BEFORE the status check: if that finds no user input,
    // whatever the URL became came from the action (or the page itself).
    let url = null;
    if (ops.currentUrl && prep && prep.target && prep.target.tabId != null) {
      url = await ops.currentUrl(prep).catch(() => null);
    }
    T.urlRead = Date.now();
    statusAt = ops.now();
    st = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
    if (!st || (st.ok === false && !st.interrupted)) watching = false;
    else if (st.interrupted && !ended) user = true;
    else if (st.interrupted) { late = true; lateIntr = st.interrupted; }
    if (watching && !user && url && ops.noteNavigation) await ops.noteNavigation(prep, url).catch(() => {});
    // Recording the URL takes time: ask again right before putting anything
    // back (codex2-2). Input seen now is a late takeover: nothing is restored.
    if (watching && !user) {
      st2 = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
      if (!st2 || (st2.ok === false && !st2.interrupted)) watching = false;
      else if (st2.interrupted) { late = true; lateIntr = st2.interrupted; }
    }
  }
  T.statusDone = Date.now();
  // A takeover handed along a chain: an earlier agent may have brought Chrome forward even when this action did not.
  const touched = (prep ? prep.touchesScene !== false : ops.activates !== false) || !!(inherit && scene && inherit.touched);
  const observe = async (noteable, since) => {
    if (err || !observer) return;
    // The end reply can be the first evidence of interruption after the last
    // healthy status. It never authorizes a new write or attributed observation.
    if (focus.terminal.terminalInterrupted) noteable = false;
    const untouched = async (target = prep) => ops.navigationUntouched
      ? await ops.navigationUntouched(target, since).catch(() => false)
      : false;
    // The observer gets the same facts noteNavigation is gated on (a tab the action opened is claimed on them, index.js).
    const o = await observer({ noteable, since, untouched }).catch((e) => ({ out: `（${restoreRequested ? '交还前台后' : '操作后'}读取页面变化失败：${e && e.message ? e.message : e}）` }));
    out = o.out;
    if (!noteable || !o.url || !ops.noteNavigation || !prep || !prep.target || prep.target.tabId == null) return;
    // Even a hand-over needs complete routing evidence; missing observation grants no ownership.
    if (!(await untouched())) {
      out += '\n（无法确认加载期间目标窗口没有被用户操作，这次看到的网址变化没有记为 agent 的导航）';
      return;
    }
    await ops.noteNavigation(prep, o.url).catch(() => {});
  };

  // A long job (ops.keep): done and still held → nothing is put back; the session, the hold and
  // the user's scene stay for the job's next action (released by releaseKept).
  if (ops.keep && !err && !user && !late && watching && held && prep) {
    const last = st2 || st;
    if (last && last.ok !== false && !last.interrupted && last.takeover && last.takeover.active && !last.takeover.aborted) {
      await observe(true, ops.now());
      T.observeEnd = Date.now();
      return { outcome: 'ok', out, idleWait, restored: false, steps, end: null, began, prep, timing: T,
        kept: { session, scene, pointer, cgWindow: prep.cgWindow, chromePid: prep.chromePid, settleMs, nativeState, native: ctx.native, returnFocus: normalizeReturnFocus(returnFocus) } };
    }
  }

  // Done, still held, and another agent waits: its turn now, with this veil up until its own is.
  // Nothing is put back here; the scene goes with the turn and the last agent of the chain restores it.
  if (restoreRequested && ops.handoff && !ops.keep && !ops.releaseAfter && !settleMs && !err && !user && !late && watching && held && prep) {
    const last = st2 || st;
    if (last && last.ok !== false && !last.interrupted && last.takeover && last.takeover.active && !last.takeover.aborted) {
      const h = await ops.handoff({ scene, pointer, touched }, { onOffer: () =>
        session.request({ op: 'veil', veil: { label: { zh: '交给排队的下一个任务…', en: 'Handing over to the next task…' } } }, { raw: true }).catch(() => {})
      }).catch(() => null);
      if (h && h.commit) {
        const beforeClose = [st, st2].filter(Boolean).map(s => ({ ok: s.ok, interrupted: !!s.interrupted,
          takeover: s.takeover ? { ...s.takeover } : null }));
        const end = await closeSession({ statuses: [st, st2] });
        // A caller abort belongs to this call, not to another authorized task. Input/Stop or
        // unconfirmed release cannot transfer the already-claimed handoff to that task.
        const localAbort = s => !s?.takeover?.aborted || ['caller', 'caller_cancel'].includes(s.takeover.abortedBy);
        const transferable = end?.ok === true && end.takeover?.active === false &&
          !end.interrupted && !session.interrupted && localAbort(end) &&
          beforeClose.every(s => s.ok !== false && !s.interrupted && localAbort(s)) &&
          !(h.stopped && h.terminalStop !== false) && !nativeState.unknown && !nativeState.revoked;
        const cancelTransfer = async reason => {
          try { return (await h.cancel?.(reason))?.cancelled === true; } catch { return false; }
        };
        if (!transferable) {
          Object.assign(focus.terminal, { terminalInterrupted: true, noRetry: true });
          focus.blockRecovery = true;
          const handoffCancellationConfirmed = await cancelTransfer('terminal_or_unknown_close');
          await observe(false);
          T.observeEnd = Date.now();
          return { outcome: 'user', late: true, out, idleWait, restored: false, steps, sent: sentKinds(err), end, began, prep, timing: T,
            handoffCancellationConfirmed };
        }
        try { await h.commit(); }
        catch (error) {
          Object.assign(error, { steps, sent: sentKinds(error), noRetry: true, terminalInterrupted: true,
            handoffCancellationConfirmed: await cancelTransfer('commit_failed') });
          throw error;
        }
        T.handedOver = Date.now();
        await observe(true, null);
        T.observeEnd = Date.now();
        return { outcome: 'ok', out, idleWait, restored: false, handedOver: h.to, steps, end, began, prep, timing: T };
      }
    }
  }

  if (user) {
    const cleanBeforeInput = !ops.takeover && !held && !ops.keep && !reuse && !pagePromptAuto &&
      focus.releaseReason === 'policy' && !sentKinds(err).length && out == null && !late && !err?.lateUser &&
      !nativeState.unknown && !nativeState.revoked &&
      (!err || err instanceof UserInterrupted) && !err?.noRetry && !err?.terminalInterrupted && !err?.terminalAborted &&
      [err?.inputDelivery, err?.reply?.inputDelivery].every(delivery => delivery == null || delivery === 'not_sent');
    const end = await closeSession({ statuses: [st, st2], userInterruption: true,
      retryBeforeInput: cleanBeforeInput && !ops.signal?.aborted });
    if (cleanBeforeInput && err instanceof UserInterrupted && ops.signal?.aborted &&
        priorCloseAborts.every(abort => abort.abortedBy === 'caller') && end?.ok === true &&
        end.takeover?.active !== true && end.takeover?.aborted === true && end.takeover.abortedBy === 'caller') {
      // Caller abort may already be in the status, or arrive during close.
      // Preserve that object and the terminal facts; never retry it.
      err.message = '调用已取消，没有操作。\n' + err.message;
      Object.assign(err, { code: 'cancelled', steps, sent: sentKinds(err), noRetry: true });
      throw err;
    }
    if (nativeState.unknown && nativeState.error) {
      Object.assign(nativeState.error, { steps, sent: sentKinds(nativeState.error), noRetry: true });
      throw nativeState.error;
    }
    const intr = mergeInterrupted([err && err.interrupted, session && session.interrupted, st && st.interrupted,
      end && end.interrupted]);
    const kind = intr ? intr.kind : null;
    // Input seen before `begin` came after the idle wait; nothing of ours was pressed since.
    const since = intr && intr.epoch != null ? intr.epoch
      : intr && intr.beforeBegin ? idleEnd : (failedAt ?? statusAt ?? idleEnd);
    const appRestored = !restoreRequested || focus.blockRecovery || ops.takeover ? null : await handBackApp(ops, scene, prep, touched, intr, since);
    await observe(false);
    return { outcome: 'user', out, idleWait, restored: false, steps, sent: sentKinds(err), end, error: err, began, prep, kind, appRestored };
  }

  let end = null, sceneRestored = false, closedAt = null, restoreReply = null;
  if (nativeState.unknown || nativeState.revoked) late = true;
  // Only the explicit GUI handoff may leave its successfully shown page visible.
  if (ops.leaveVisible === true && !err && !user && !late) {
    end = await closeSession();
    return { outcome: 'ok', out, idleWait, restored: false, steps, end, began, prep, timing: T };
  }
  if (watching) {
    // An offer/observer may have awaited since st2: recheck immediately before cleanup writes.
    if (ops.takeover && !late) {
      const q = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
      if (!held || !q || q.ok === false || q.interrupted || !q.takeover?.active || q.takeover.aborted) {
        late = true; lateIntr = q?.interrupted || lateIntr;
      }
    }
    if (restoreRequested && !ops.nativeTransactions && !late && scene && touched && scene.appPid != null && prep && scene.appPid !== prep.chromePid) {
      // Front to the user's app first, from the running session (fast); the
      // Chrome window/tab order is fixed right after, with Chrome already in
      // the background.
      const hb = await session.request({ op: 'handBack', pid: scene.appPid }, { raw: true }).catch(() => null);
      if (hb && hb.interrupted) { late = true; lateIntr = hb.interrupted; }
      T.handBack = Date.now();
    }
    if (restoreRequested && !late && scene && touched) {
      // Still holding right now (not merely at begin): only then may restore ignore input.
      const last = st2 || st;
      const heldNow = held && !!(last && last.ok !== false && !last.interrupted && last.takeover && last.takeover.active && !last.takeover.aborted);
      const rs = ops.takeover && !heldNow ? null
        : await restoreHeldScene(ops, session, scene, { since: statusAt, held: heldNow, settleMs, native: ctx.native });
      sceneRestored = !!rs && rs.ok !== false && rs.activated !== false;
      restoreReply = rs;
      if (ops.takeover && !rs) late = true;
      if (rs && rs.userInput) { late = true; lateSince = statusAt; }
      T.restored = Date.now();
    }
    if (nativeState.unknown || nativeState.revoked) late = true;
    if (restoreRequested && !late && pointer && ops.takeover) {
      const q = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
      if (!q || q.ok === false || q.interrupted || !q.takeover?.active || q.takeover.aborted) late = true;
    }
    if (restoreRequested && !late && pointer) {
      const w = await session.request({ op: 'warp', to: { x: pointer.x, y: pointer.y } }, { raw: true }).catch(() => null);
      if (w && w.interrupted) { late = true; lateIntr = w.interrupted; }
      else if (!w || w.ok === false) watching = false;
      T.warped = Date.now();
    }
    end = await closeSession({ statuses: [st, st2], interruptions: [lateIntr] });
    closedAt = ops.now();
    T.closed = Date.now();
  }
  let pointerBack = false;
  if (!watching && scene && held && session && !focus.closed && !user && !nativeState.unknown && !nativeState.revoked) {
    // Fresh creation and inherited preparation can change a scene before begin.
    // Check the hold even when no restoration was requested: an absent status
    // is still evidence of a lost hold, not a successful current-mode release.
    const q = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
    const healthy = !!(q && q.ok !== false && !q.interrupted && q.takeover && q.takeover.active && !q.takeover.aborted);
    if (restoreRequested && healthy) {
      const rs = await restoreHeldScene(ops, session, scene, { since: ops.now(), held: true, settleMs, native: ctx.native });
      sceneRestored = !!rs && rs.ok !== false && rs.activated !== false;
      restoreReply = rs;
      // The pointer only while still held (Esc during the restore: it is the user's again; Codex round 3, A11).
      const q2 = pointer ? await session.request({ op: 'status' }, { raw: true }).catch(() => null) : null;
      if (!nativeState.unknown && !nativeState.revoked && q2 && q2.ok !== false && !q2.interrupted && q2.takeover && q2.takeover.active && !q2.takeover.aborted) { await session.request({ op: 'warp', to: pointer }, { raw: true }).catch(() => {}); }
      pointerBack = true;
    }
    // A skipped restoration is not user input. An unhealthy hold (or an
    // unsuccessful requested restore) still prevents a clean-success outcome.
    if (ops.takeover) { pointerBack = true; if (!healthy || (restoreRequested && !sceneRestored)) late = true; }
  }
  if (!watching) {
    if (session && !end) end = await closeSession({ statuses: [st, st2], interruptions: [lateIntr] });
    // Nothing of ours is posted after the idle wait (no session) or after the
    // last clean status (the action had returned), so from then on the idle
    // counter is the user's.
    const base = began ? (statusAt ?? ops.now()) : idleEnd;
    closedAt = began ? ops.now() : null;
    // Refused before anything of ours happened (no activation, no session begun: e.g. the hold was
    // refused because a key was down): nothing to put back, so the user's input since is not a
    // "late takeover" — that would also stop the retry (seen live 2026-10-06 while the user typed).
    const touchedAny = began || !!prep || sent.size > 0;
    const acted = () => touchedAny ? ops.userActedSince(base).catch(() => false) : Promise.resolve(false);
    if (!late && await acted()) { late = true; lateSince = base; }
    if (restoreRequested && !focus.blockRecovery && !late && scene && touched && !sceneRestored && !ops.takeover && !ops.nativeTransactions) {
      const rs = await ops.restoreScene(scene, { since: base }).catch(() => null);
      sceneRestored = !(rs && rs.activated === false);
      restoreReply = rs;
      if (rs && rs.userInput) { late = true; lateSince = base; }
    }
    if (!late && await acted()) { late = true; lateSince = base; }
    if (restoreRequested && !focus.blockRecovery && !late && pointer && !pointerBack && !ops.takeover && !ops.nativeTransactions) await ops.warp(pointer).catch(() => {});
  }
  let appRestored = null;
  if (restoreRequested && !focus.blockRecovery && late && !sceneRestored && !ops.takeover && !ops.nativeTransactions) {
    const intr = mergeInterrupted([lateIntr, end && end.interrupted]);
    appRestored = await handBackApp(ops, scene, prep, touched, intr,
      intr && intr.epoch != null ? intr.epoch : (lateSince ?? statusAt ?? ops.now()));
  }
  if (!err && nativeState.unknown) err = nativeState.error;
  if (err) {
    err.steps = steps;
    err.sent = sentKinds(err);
    if (focus.terminal.terminalInterrupted) Object.assign(err, { sceneRestored, appRestored });
    if (late && !nativeState.unknown && !nativeState.revoked) { err.lateUser = true; err.sceneRestored = sceneRestored; err.appRestored = appRestored; }
    throw err;
  }
  if (restoreRequested) T.handBack = T.handBack ?? Date.now();
  await observe(!late, closedAt ?? ops.now());
  T.observeEnd = Date.now();
  if (late) return { outcome: 'user', late: true, out, idleWait, restored: false, sceneRestored, appRestored, steps, end, began, prep, timing: T, restore: restoreReply };
  return { outcome: 'ok', out, idleWait, restored: restoreRequested, sceneRestored, appRestored, steps, end, began, prep, timing: T, restore: restoreReply };
}

/** Restore and catch delayed window activation before releasing a healthy hold. */
async function restoreHeldScene(ops, session, scene, { since, held, settleMs = 0, native = null }) {
  if (held) {
    const q = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
    if (!q || q.ok === false || q.interrupted || !q.takeover?.active || q.takeover.aborted) return null;
  } else if (settleMs > 0) return null;
  const restore = () => ops.restoreScene(scene, { since, held, native }).catch(() => null);
  let reply = await restore();
  if (held && settleMs > 0) {
    await (ops.sleep ? ops.sleep(settleMs) : new Promise(resolve => setTimeout(resolve, settleMs)));
    const q = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
    if (!q || q.ok === false || q.interrupted || !q.takeover?.active || q.takeover.aborted) return null;
    reply = await restore();
  }
  return reply;
}

/**
 * End a long job's hold (index.js task hold). A valid origin policy restores the user's app,
 * Chrome window/tab and pointer before closing. Current, invalid policy and human handoff close only.
 * Restoration requires the same healthy hold; released (Esc, shake) means resource cleanup only.
 * @returns the session's end reply fields plus confirmed restoration facts. `restored` remains
 *          the helper's clipboard result; restoring a window is not inferred from an attempted write.
 */
export async function releaseKept(ops, kept, { releaseReason = 'policy' } = {}) {
  releaseReason = releaseReason === 'human_handoff' ? 'human_handoff' : 'policy';
  const returnFocus = normalizeReturnFocus(kept.returnFocus);
  const restoreRequested = returnFocus?.mode === 'origin' && releaseReason !== 'human_handoff';
  const { session, scene, pointer, chromePid } = kept;
  const st = await session.request({ op: 'status' }, { raw: true }).catch(() => null);
  const heldNow = !kept.nativeState?.unknown && !kept.nativeState?.revoked && !!(st && st.ok !== false && !st.interrupted && st.takeover && st.takeover.active && !st.takeover.aborted);
  const handBack = restoreRequested && !kept.native && heldNow && scene && scene.appPid != null && scene.appPid !== chromePid
    ? await session.request({ op: 'handBack', pid: scene.appPid }, { raw: true }).catch(() => null) : null;
  const restore = restoreRequested && heldNow && scene ? await restoreHeldScene(ops, session, scene,
    { since: ops.now(), held: heldNow, settleMs: kept.settleMs, native: kept.native }) : null;
  const q = restoreRequested && heldNow && pointer ? await session.request({ op: 'status' }, { raw: true }).catch(() => null) : null;
  const canWarp = !kept.nativeState?.unknown && !kept.nativeState?.revoked && !!(q && q.ok !== false && !q.interrupted && q.takeover?.active && !q.takeover.aborted);
  const warp = canWarp && pointer
    ? await session.request({ op: 'warp', to: { x: pointer.x, y: pointer.y } }, { raw: true }).catch(() => null) : null;
  const end = await session.close().catch(() => null);
  return { ...(end || {}), ...focusReturnMetadata(returnFocus, releaseReason),
    ...terminalInputFacts(end, session.interrupted, st),
    ...(kept.nativeState?.unknown ? { inputDelivery: 'unknown', noRetry: true,
      stages: kept.nativeState.error?.stages || kept.nativeState.error?.reply?.stages || [] } : {}),
    inputReleased: end?.ok === true && end?.takeover?.active !== true,
    appRestored: restore?.ok === true && restore.appFrontmost === true && !restore.skipped && !restore.userInput,
    pointerRestored: warp?.ok === true && warp.verified === true && !warp.interrupted &&
      Math.hypot(warp.warped?.x - pointer?.x, warp.warped?.y - pointer?.y) <= 1,
    restoration: { handBack, scene: restore, pointer: warp },
  };
}

/**
 * One view of the interruption records seen (helper replies, bridge, end):
 * the first kind, the earliest wall-clock time, and whether any of them saw
 * a mouse button (the helper keeps watching after the first event).
 * @returns {{kind, epoch?, button:boolean, beforeBegin?}|null}
 */
export function mergeInterrupted(list) {
  const xs = list.filter(x => x && x.kind);
  if (!xs.length) return null;
  const epochs = xs.map(x => x.epoch).filter(Number.isFinite);
  return { ...xs[0], button: xs.some(x => x.button === true || x.kind === 'button'),
    ...(epochs.length ? { epoch: Math.min(...epochs) } : {}) };
}

/**
 * After the user took over: our activation may have left Chrome in front of
 * the app they were using, and everything they type next would go into the
 * agent's page (review A3/A4). Hand the front back to their app — nothing
 * else: no pointer warp, no Chrome window or tab change — and only when
 *  - this action brought Chrome forward (not scroll),
 *  - their app was not Chrome itself,
 *  - no mouse button was seen (a click into Chrome is a choice), neither by the
 *    session (`button`, also after a first move) nor, checked inside chromectl
 *    right before activating, since `since` (epoch ms, the interruption),
 *  - Chrome is still frontmost (checked inside chromectl, so an app switch of
 *    their own is not undone).
 * @param interrupted  mergeInterrupted() result, or a kind string (older callers)
 * @returns true: handed back; false: tried, did not take; null: not attempted
 */
export async function handBackApp(ops, scene, prep, touched, interrupted = null, since = null) {
  const intr = typeof interrupted === 'string' ? { kind: interrupted } : interrupted;
  if (ops.takeover || ops.nativeTransactions || !ops.restoreApp || !scene || scene.appPid == null || !touched) return null;
  if (prep && prep.chromePid != null && Number(scene.appPid) === Number(prep.chromePid)) return null;
  if (intr && (intr.kind === 'button' || intr.button === true)) return null;
  const r = await ops.restoreApp(scene, { noClickSince: since }).catch(() => null);
  return !!(r && r.appFrontmost === true && !r.skipped);
}

/**
 * What to tell the agent when the user took over: stopped, what was done,
 * and what was (not) put back. `r` is a runInputAction result with
 * outcome 'user'.
 */
export function userStopMessage(r) {
  const done = [...r.steps];
  const rep = r.error && r.error.reply;
  const inputSent = (Array.isArray(r.sent) && r.sent.length > 0) ||
    (Array.isArray(r.error?.sent) && r.error.sent.length > 0) ||
    r.error?.inputDelivery === 'sent' || rep?.inputDelivery === 'sent';
  let pending = '';
  if (rep) {
    if (typeof rep.typed === 'number' && rep.typed > 0) {
      if (rep.confirmationPending) pending = `本段已发送 ${rep.typed} 个字符，尚未读回确认；请先查看输入框，勿直接重复输入。`;
      else done.push(`逐键输入了 ${rep.typed} 个字符`);
    }
    else if (rep.confirmationPending && rep.postedInput > 0) pending = '本段已有按键发出，输入框内容尚未读回确认；请先查看输入框，勿直接重复输入。';
    if (rep.pastePosted === true) pending = '已发送 Cmd+V，输入框内容尚未读回确认；请先查看输入框，勿直接重复粘贴。';
    else if (rep.pastePosted === false) pending = 'Cmd+V 尚未发送，没有粘贴文字。';
    if (typeof rep.sent === 'number' && rep.sent > 0) done.push(`滚轮发出 ${rep.sent} 格`);
    if (rep.restored === true) done.push('剪贴板已还原');
  }
  if (r.end && r.end.restored === true) done.push('剪贴板已还原');
  if (r.end && r.end.restored === false) done.push('⚠️ 剪贴板在此期间被改过，没有覆盖回去');
  const released = [...(rep && rep.released) || [], ...(r.end && r.end.released) || []];
  const lines = [
    `⏸ 你开始操作了，已停止；完成了：${done.length ? done.join('；') : pending ? '尚无已确认的输入' : inputSent ? '已有输入发出，页面结果尚未确认' : '还没有发出任何输入'}。`
  ];
  if (pending) lines.push(pending);
  if (r.error && r.error.interrupted && r.error.interrupted.beforeBegin) {
    lines.push('（在把 Chrome 切到前面的过程中检测到了你的键盘鼠标输入）');
  }
  if (released.length) lines.push('（已松开工具按着的键 / 鼠标键）');
  lines.push(stopRestoreLine(r));
  return lines.join('\n');
}

/** The "what was put back" line for a user outcome (also used after a completed action). */
export function stopRestoreLine(r) {
  if (r.focusRestoration === 'not_requested' || r.focusRestoration === 'policy_invalid') {
    const released = r.inputReleased === true ? '键盘鼠标接管已结束。' : r.inputReleased === false ? '键盘鼠标释放尚未确认。' : '';
    return (r.focusRestoration === 'policy_invalid'
      ? '归还策略缺失或无效，没有请求焦点恢复。'
      : '未请求焦点恢复。') + released + '请核对当前页面；等待用户明确继续，不会自动重试。';
  }
  const kind = r.kind ?? [r.error && r.error.interrupted, r.end && r.end.interrupted].find(x => x && x.kind)?.kind;
  if (r.appRestored) {
    return '已把前台切回你原来用的 App（光标和 Chrome 窗口没有动）' +
      (kind === 'key' || kind === 'flags' ? '；你按下的第一个键可能已经进了 agent 的网页，请检查一下。' : '。') +
      '需要的话，等你停手后让 agent 重试。';
  }
  return '没有把光标和前台窗口拉回原处，一切保持你现在的样子。需要的话，等你停手后让 agent 重试。';
}

/**
 * Move the pointer to `point` and press, refusing to press when the pointer is
 * not where we put it.
 *
 * `ops` is injected so this whole sequence is unit-testable:
 *   windowsAt(point)   -> array of windows (front to back) covering the point
 *   move(point, ms|null) -> {durationMs}
 *   mousepos()         -> {x, y}
 *   press(point)       -> {afterX, afterY, drift}; may throw code 'cursor_moved'
 *
 * The pointer is checked twice: here, right after the travel animation, and
 * again inside the helper microseconds before mouse-down. A hand on the mouse
 * during the 150–400 ms path is the failure this is built for.
 *
 * The tools no longer press this way: they click through the input session
 * (`cgevent session`), whose guards run inside the helper right before each
 * mouse-down. This path stays for test/click-hardening-check.mjs, which calls
 * the legacy `move` / `press` subcommands.
 */
export async function guardedClick({ point, ops, tolerance = CURSOR_TOLERANCE_PT, retryMs = RETRY_MOVE_MS }) {
  const owner = pickTopWindowOwner(await ops.windowsAt(point));
  if (owner && !isChromeOwner(owner)) {
    throw new BridgeError('window_not_chrome',
      `❌ 点击位置（x=${Math.round(point.x)}, y=${Math.round(point.y)}）最上层的窗口属于「${owner}」，不是 Chrome，已放弃点击。\n` +
      `请把「${owner}」的窗口移开，或先点一下 Chrome 让它到最前面，然后重试。`);
  }

  let moveMs = null;
  let retried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const mv = await ops.move(point, attempt === 0 ? null : retryMs);
    if (attempt === 0 && mv && typeof mv.durationMs === 'number') moveMs = mv.durationMs;

    const pos = await ops.mousepos();
    const off = distance(pos, point);
    if (off <= tolerance) {
      try {
        const pressed = await ops.press(point);
        return {
          owner,
          moveMs,
          retried,
          cursorAtPress: pos,
          cursorAfter: { x: pressed.afterX, y: pressed.afterY },
          drift: typeof pressed.drift === 'number' ? pressed.drift : distance({ x: pressed.afterX, y: pressed.afterY }, point)
        };
      } catch (e) {
        // The helper's own last-moment check fired: same failure, one layer down.
        if (e && e.code !== 'cursor_moved') throw e;
      }
    }
    retried = true;
  }

  throw new BridgeError('mouse_interrupted', '❌ 鼠标在移动过程中被其他输入打断，未点击。');
}
