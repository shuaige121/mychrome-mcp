#!/usr/bin/env node
/**
 * MyChrome MCP (mychrome-mcp) — drive the user's OWN running Google Chrome.
 * Internal names keep the old one (chrome-bridge): CHROME_BRIDGE_* variables, ~/Library/Caches/chrome-bridge-mcp,
 * the input lock. Servers of older and newer versions then still share one lock and queue for the one mouse.
 *
 * No --remote-debugging-port, no second profile, no extension: the page side
 * goes through Chrome's AppleScript `execute javascript`, and every click,
 * keystroke and wheel tick is a real system-level CGEvent, so the page sees
 * exactly what it would see from a human.
 *
 * Every input action runs as one `cgevent session` (docs/impl-contract.md
 * §1, §3): the helper watches the real mouse and keyboard while it acts, and
 * the moment the user touches either one it stops, releases what it holds,
 * and this server leaves the screen as the user has it.
 */
import { detectPeers, routingInstructions } from './peers.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { execFileSync, spawn } from 'node:child_process';
import { statSync, appendFileSync, writeFileSync, mkdirSync, rmSync, readFileSync, realpathSync, renameSync, watch } from 'node:fs';
import { readFile as readFileP, writeFile as writeFileP, mkdir as mkdirP } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  evalInPage, pageScript, cgevent, axInput, axMenuState, chromeInfo, activateChrome, listTabs, openTab, selectTab, BridgeError,
  snapshotScene, restoreScene, restoreApp, newWindow, closeTab, openInputSession, openNavigationObserver, profiles, pageDialog, answerDialog, ensureScreenAwake, keepAwake, captureRegion, captureWindow, ocrImage, moveWindow, ROOT
} from './bridge.js';
import {
  registerTab, touchTab, allTabs, legacyTabs, noteAgentNavigation, checkTabBeforeUse, closeAgentTab,
  sweepTabs, diffNewTabs, tabStatus, chromeFrontmost, getTab, markTakenOver, noteAgentDone,
  claimTab, popupCandidates, findLiveTab, readTabRecord, clickedSince, observeUserTab, checkTakeover, OWNER_PID
} from './tabs.js';
import { TabLedger, mineSection, footerLine, recoveryLine, ownerName, classifyRecord, nextAction, takeoverKind } from './ledger.js';
import { withInputLock, acquireLease, queueList, pendingTickets, LOCK_DIR } from './lock.js';
import { viewportOrigin, toScreen, rectToScreenRect, squareToScreenRect, intersectRect } from './coords.js';
import {
  didClickRegister, checkViewportGeometry, planScrollStep, chainDelta, typingSegments, typedCount, keyupCount,
  runInputAction, releaseKept, userStopMessage, stopRestoreLine, targetWindowOnTop, aimClickable,
  MAX_SCROLL_BURSTS, PX_PER_NOTCH, BURST_MIN, BURST_MAX, INPUT_MODES
} from './guard.js';

import { setupHint } from './bridge.js';
import * as S from './settings.js';
import { redactUrl, redactText, redactToolResult } from './privacy.js';
import { clientDisplayName } from './client.js';
import { planTemporalKeys } from './temporal.js';
import { normalizeConversationBinding, startConversationService } from './gui-service.js';
import { createRoutineIntegration, ROUTINE_ACTIONS } from './routine-integration.js';
import { routinePage, pageMatches, RoutineError, routineMessage } from './routine-runner.js';

// Open the existing native conversation center without creating an MCP session.
if (process.argv[2] === 'gui') {
  const child = spawn(path.join(ROOT, 'bin', 'cbmenu'), ['--gui'], { detached: true, stdio: 'ignore' });
  child.on('error', () => { process.stderr.write('Build MyChrome first: npm run build\n'); process.exitCode = 1; });
  child.unref();
  await new Promise(resolve => { child.once('spawn', resolve); child.once('error', resolve); });
  process.exit(process.exitCode || 0);
}

// `mychrome-mcp doctor [flags]`: the setup check (src/doctor.js) runs instead of the server.
if (process.argv[2] === 'doctor') {
  const { runDoctorCli } = await import('./doctor.js');
  process.exit(await runDoctorCli(process.argv.slice(3)));
}

// `mychrome-mcp restart-all [--dry-run] [--json] [--wait <minutes>] [--root <checkout>]`: the panel's 「全部重启」 (src/restart.js).
if (process.argv[2] === 'restart-all') {
  const { runRestartCli } = await import('./restart.js');
  process.exit(await runRestartCli(process.argv.slice(3), { lockDir: LOCK_DIR }));
}

// The process a client starts becomes the hot-swap relay for the session (src/launcher.js): MyChrome runs
// behind it as a worker, replaced by the new code after an update, so the session never needs restarting.
if (process.env.CHROME_BRIDGE_WORKER !== '1' && process.env.CHROME_BRIDGE_HOTSWAP !== '0' && process.argv[2] !== '--probe' && isMainModule()) {
  const { runLauncher } = await import('./launcher.js');
  const self = fileURLToPath(import.meta.url);
  await runLauncher({ script: self, srcDir: path.dirname(self) });
}

/**
 * Everything that reaches Chrome or the input helper goes through B, so the
 * offline tests can run the real tool flows against jsdom pages and the
 * helper's DRY-RUN mode (test/page.test.mjs). Nothing else replaces it.
 */
const B = {
  evalInPage, pageScript, cgevent, axInput, axMenuState, chromeInfo, activateChrome, listTabs, openTab, selectTab,
  snapshotScene, restoreScene, restoreApp, newWindow, closeTab, openInputSession, openNavigationObserver, profiles, pageDialog, answerDialog,
  ensureScreenAwake, keepAwake, captureRegion, captureWindow, ocrImage, moveWindow
};
export function __setBridgeForTests(overrides) { Object.assign(B, overrides); }
/** The names a test fake must cover, so no test reaches the real Chrome or helper. */
export function __bridgeKeysForTests() { return Object.keys(B); }

/* ------------------------------------------------------------- version */

const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/**
 * Which code this process runs (plan T6): servers load their modules once at
 * start, so a session started before an update keeps the old behaviour.
 * Printed to stderr at start and as the first line of list_tabs.
 * A git checkout reports its commit; an npm install (not a checkout, or inside someone else's
 * repository) reports the package version instead of whatever repository happens to contain it.
 */
function versionStamp() {
  let mtime = '?';
  try { mtime = new Date(statSync(fileURLToPath(import.meta.url)).mtimeMs).toLocaleString('zh-CN', { hour12: false }); } catch {}
  const git = (args) => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  let checkout = false;
  try { checkout = realpathSync(git(['rev-parse', '--show-toplevel'])) === realpathSync(ROOT); } catch {}
  if (!checkout) return PACKAGE_VERSION;
  let head;
  try { head = git(['rev-parse', '--short', 'HEAD']); } catch { return `未知提交（src/index.js 修改于 ${mtime}）`; }
  let dirty = false;
  try { git(['diff', '--quiet', 'HEAD', '--', 'src']); } catch (e) { dirty = e.status === 1; }
  return dirty ? `${head}+未提交改动（src/index.js 修改于 ${mtime}）` : head;
}
const VERSION = versionStamp();
const STARTED_AT = new Date().toLocaleString('zh-CN', { hour12: false });

/* --------------------------------------------------------------- tools */

const TAB = {
  type: 'integer',
  description: 'Tab id from list_tabs. Omit = front tab.'
};

/** Task identity only. Progress text comes from existing host messages, never tool arguments. */
const PANEL_ARGS = {
  task: { type: 'string', maxLength: 80,
    description: 'Job name on the overlay (no secrets).' },
  note: { type: 'string', maxLength: 120,
    description: 'Deprecated; ignored.' },
  step: { type: 'string', pattern: '^[0-9]{1,3}/[0-9]{1,3}$',
    description: 'Deprecated; ignored by task progress.' }
};

const WHY_VALUES = ['site_restricts_automation', 'needs_user_login', 'same_page_with_user', 'user_asked', 'other_tool_failed'];

const TOOLS = [
  {
    name: 'routines',
    description: 'Local website action history and reusable routines. list/history finds recorded sequences; save names a contiguous eventIds range. run executes the saved steps with real input and no model calls between steps. Supply an explicit tab, runtime params and a unique nonce; reuse that nonce to query/recover an uncertain request, never resend with a new nonce. start returns immediately; status and stop accept runId or nonce. Never auto-retry a blocked step.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'history', 'snapshot', 'save', 'run', 'start', 'status', 'stop', 'cancel', 'settings', 'update', 'tabs'] },
      site: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 2000 },
      id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
      eventIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
      tab: TAB, params: { type: 'object', additionalProperties: { type: 'string' } },
      nonce: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' }, runId: { type: 'string' },
      enabled: { type: 'boolean' }, archived: { type: 'boolean' }
    }, required: ['action'], additionalProperties: false }
  },
  {
    name: 'list_tabs',
    description: "Read-only discovery, without the input lock: lists your tabs first, then all Chrome windows and tabs with their ids and owners. Use the default list to find an existing page from another agent; mine:true only filters to this session's tabs.",
    inputSchema: { type: 'object', properties: { mine: { type: 'boolean', description: 'Only your tabs (cheap)' } }, additionalProperties: false }
  },
  {
    name: 'open_tab',
    description: "Open a URL in a new tab of the agent's own Chrome window (Chrome is not brought forward); returns the tab id. Fallback only: public pages and APIs → WebFetch/curl; JavaScript pages without login → Playwright. Use this when the site blocks automation, the page needs the user's login or is open in their Chrome, or other tools failed (`why`). First page of a site only, then click its links; close_tab when done.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to open' },
        why: { type: 'string', enum: WHY_VALUES,
          description: "site_restricts_automation (403/429, challenge page, bot-blocking login) | needs_user_login | same_page_with_user | user_asked | other_tool_failed (WebFetch/Playwright/an extension tool failed or was blocked)" },
        profile: { type: 'string', description: "Chrome profile by name, email or folder; default: the user's own." }
      },
      required: ['url', 'why'],
      additionalProperties: false
    }
  },
  {
    name: 'close_tab',
    description: "Close a tab the agent opened (answers the page's \"Leave site?\" itself). Tabs the user may have taken over are not closed.",
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'integer', description: 'Tab id returned by open_tab' } },
      required: ['tab'],
      additionalProperties: false
    }
  },
  {
    name: 'read_page',
    description: "Read any user-authorized tab, including another agent's, without the input lock or bringing it forward. An open modal first, the page outline (S1, S2…, token sizes), then what is on screen; clickable elements numbered like [12], the same in every mode. Within `budget` tokens, else the screen's recognised text (t1… for click_at), else its picture. More: sections, query, full. Read again after changes.",
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        budget: { type: 'integer', minimum: 200, maximum: 20000, description: 'Token budget for the default read (default 2500)' },
        sections: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Outline sections to expand, e.g. ["S3","S7"]' },
        query: { type: 'string', description: 'Find the blocks and elements containing this text (case-insensitive), at most 20' },
        full: { type: 'boolean', description: 'The whole page in one text, capped ~12000 characters' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'click',
    description: "Click a read_page marker with the real mouse (moves like a hand; brings the element into view with the wheel). ✅ only on an observable change (URL or focus moved); \"no observable change\" does not mean nothing happened. Tabs it opens are reported.",
    inputSchema: {
      type: 'object',
      properties: {
        marker: { type: 'integer', minimum: 1, description: 'The marker number from read_page, e.g. 12' },
        scroll_into_view: { type: 'boolean', default: true, description: 'Scroll the element into view with the mouse wheel first if needed (default true)' },
        tab: TAB,
        ...PANEL_ARGS
      },
      required: ['marker'],
      additionalProperties: false
    }
  },
  {
    name: 'type_text',
    description: "Type into focus or click marker. User keys/paste setting wins; auto follows input_mode (default keys). Keys reject unsupported text; explicit paste uses Cmd+V. Unconfirmed text never submits.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to enter (not only whitespace)' },
        input_mode: { type: 'string', enum: INPUT_MODES, default: 'keys',
          description: "keys (ASCII) or paste (Cmd+V); user keys/paste overrides, auto follows this." },
        submit: { type: 'boolean', default: false, description: "Press Return if the text is confirmed in the field" },
        marker: { type: 'integer', minimum: 1, description: 'Optional: click this read_page marker first' },
        tab: TAB,
        ...PANEL_ARGS
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'screenshot',
    description: "Read-only window capture and local OCR (t1… centres for click_at). Requires the target tab visible; never activates, switches tabs or takes the input lock. Hidden/minimized: use read_page or wait. Image only with image:true.",
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'boolean', default: false, description: 'Also return the picture (many more tokens)' },
        tab: TAB, ...PANEL_ARGS
      },
      additionalProperties: false
    }
  },
  {
    name: 'click_at',
    description:
      'Click on the LAST screenshot of that tab with the real mouse (same takeover and checks as click): text_id (a line id from it, e.g. "t12": ' +
      'its centre) or x, y (that screenshot\'s pixels). Screenshot again if the page may have changed.',
    inputSchema: {
      type: 'object',
      properties: {
        text_id: { type: 'string', pattern: '^[tT]?[0-9]{1,4}$', description: 'A text line id from the last screenshot; instead of x/y' },
        x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, tab: TAB, ...PANEL_ARGS
      },
      additionalProperties: false
    }
  },
  {
    name: 'press_key',
    description:
      'Send a real key to the page focus. escape closes a menu or popup; up/down move through lists. `times` repeats the key (≤20).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['escape', 'enter', 'tab', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'space', 'backspace'] },
        times: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
        tab: TAB, ...PANEL_ARGS
      },
      required: ['key'],
      additionalProperties: false
    }
  },
  {
    name: 'hover',
    description:
      'Move the real pointer onto a marker WITHOUT clicking, for menus that open on hover. Inside a task_plan job the pointer stays ' +
      'there until your next action (outside one it is put back at once, and the menu may close), so call task_plan first.',
    inputSchema: {
      type: 'object',
      properties: { marker: { type: 'integer', minimum: 1 }, tab: TAB, ...PANEL_ARGS },
      required: ['marker'],
      additionalProperties: false
    }
  },
  {
    name: 'wake_screen',
    description: "Light up sleeping displays (no input sent) and say whether the screen is locked; it never types the password.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'wait_for_user',
    description: "A human is needed: a CAPTCHA / bot check / block (other tools stop with site_blocked), or a step that is the user's (log in, pay, a field only they fill: pass `field`). Waits, sending no input, until done or `minutes` pass. Never solve a CAPTCHA yourself.",
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'What the user must do (not needed for a check on the page)' },
        field: { type: 'integer', minimum: 1, description: 'That field\'s marker: highlighted with `reason`, done when they press Return in it' },
        minutes: { type: 'number', minimum: 0.1, maximum: 10, description: 'Default 3 (10 with field), at most 10; call again to wait longer' },
        tab: TAB
      },
      additionalProperties: false
    }
  },
  {
    name: 'answer_dialog',
    description:
      'Answer a page alert/confirm/prompt using its exact button text. read_page and click list buttons when a dialog blocks the page.',
    inputSchema: {
      type: 'object',
      properties: {
        button: { type: 'string', description: 'The button text exactly as listed, e.g. "确定" or "OK"' },
        text: { type: 'string', description: 'For a prompt() dialog: the text to type into its field before the button' },
        tab: TAB
      },
      required: ['button'],
      additionalProperties: false
    }
  },
  {
    name: 'task_plan',
    description: "ONCE per whole job: retain takeover through reading/actions until done:true or Stop. Sidebar mirrors existing visible messages; no extra notes or guessed checklists. done:true releases control, not proof of success.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', maxLength: 80, description: 'The job in a few words (e.g. "IELTS reading test")' },
        steps: { type: 'array', items: { type: 'string', maxLength: 80 }, minItems: 1, maxItems: 100,
          description: "Optional legacy context; never displayed as completed steps" },
        conversation_id: { type: 'string', description: 'Current host thread ID for the visible message stream.' },
        estimate_minutes: { type: 'number', minimum: 0.1, maximum: 240, description: 'Your estimate for the whole job' },
        done: { type: 'boolean', description: "true at the end: the user's things are put back" }
      },
      additionalProperties: false
    }
  },
  {
    name: 'select_option',
    description: "Choose a <select> with real keys, keeping its menu closed. Confirm the selected option; a failed selection returns an error without a script fallback.",
    inputSchema: {
      type: 'object',
      properties: {
        marker: { type: 'integer', minimum: 1, description: 'The <select> marker from read_page' },
        option: { type: 'string', description: "The option's text as read_page lists it, or its value" },
        tab: TAB,
        ...PANEL_ARGS
      },
      required: ['marker', 'option'],
      additionalProperties: false
    }
  },
  {
    name: 'scroll',
    description: "Scroll with real mouse-wheel events, `amount` in screens. The tab must be visible in its window (an agent-window tab is made visible first; hidden tabs of the user's windows are refused — read_page reaches the whole page anyway).",
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        amount: { type: 'number', default: 1, minimum: 0.1, maximum: 20, description: 'How many screens to scroll (default 1)' },
        tab: TAB,
        ...PANEL_ARGS
      },
      required: ['direction'],
      additionalProperties: false
    }
  }
];

/** The tool list as served (schema tests). */
export function __toolsForTests() { return TOOLS; }

const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : (t || ''));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const between = (a, b) => a + Math.random() * (b - a);
/** Lognormal around `median` ms (σ in log space), clamped. */
function lognormalMs(median, sigma, lo, hi) {
  const u = 1 - Math.random(), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(hi, Math.max(lo, median * Math.exp(sigma * z)));
}

function targetLine(t) {
  if (!t || t.tabId == null) return '';
  return `【tab=${t.tabId}】${clip(redactText(t.title), 60)}｜${clip(redactUrl(t.url), 120)}`;
}

/* ------------------------------------------------------ agent window */

/**
 * Agents get their own Chrome window, parked on a display the user is not
 * working on (default: the non-main one), so clicking an agent tab raises a
 * window THERE instead of covering the user's screen. `off` = old behaviour
 * (tabs in the user's front window).
 */
// away (default): with two or more displays, the one the user is not working on (owner, 2026-10-06);
// secondary / main: always that one; off: tabs go into the user's own front window.
// Read at each use: the menu-bar panel changes it without a restart (src/settings.js; the env variable wins).
const agentDisplay = () => S.get('agentDisplay');
const AGENT_STATE = process.env.CHROME_BRIDGE_AGENT_STATE ||
  path.join(os.homedir(), 'Library', 'Caches', 'chrome-bridge-mcp', 'agent-window.json');

/** Agent-window state: { byProfile: { <dir>: {windowId, display} } } (older files: {windowId}). */
async function agentState() {
  try {
    const j = JSON.parse(await readFileP(AGENT_STATE, 'utf8'));
    return j.byProfile ? j : { byProfile: j.windowId != null ? { _legacy: { windowId: j.windowId, display: j.display } } : {} };
  } catch { return { byProfile: {} }; }
}

/** `isDefault`: an old single-window state file (no profile recorded) counts for the default profile only. */
async function agentWindowStateId(profileDir = null, isDefault = false) {
  const st = await agentState();
  const e = (profileDir && st.byProfile[profileDir]) || (isDefault ? st.byProfile._legacy : null);
  return e ? e.windowId : null;
}

/** Resolve a profile name or directory (null = the user's default) against `chromectl profiles`. */
async function resolveProfile(profile) {
  const pr = await B.profiles();
  const want = profile == null || profile === '' ? pr.default : profile;
  const hit = pr.profiles.find(p => p.dir === want || p.name === want || p.user === want);
  if (hit) hit.isDefault = hit.dir === pr.default;
  if (!hit) {
    throw new BridgeError('no_such_profile', `❌ 找不到 Chrome 用户资料「${profile}」。现有：` +
      pr.profiles.map(p => `${p.name}（${p.user || p.dir}）`).join('、'));
  }
  return hit;
}

/** Ids of every agent window this tool created (all profiles). */
async function agentWindowIds() {
  const st = await agentState();
  return new Set(Object.values(st.byProfile).map(e => String(e.windowId)));
}

/** After creating the agent window: how long to wait before checking that the front is still the user's app. */
const NEW_WINDOW_SETTLE_MS = Number(process.env.CHROME_BRIDGE_NEW_WINDOW_SETTLE_MS ?? 400);

async function agentWindowId(profileDir = null, isDefault = false) {
  const id = await agentWindowStateId(profileDir, isDefault);
  if (id == null) return null;
  const { windows } = await B.listTabs();
  return windows.some(w => String(w.id) === String(id)) ? id : null;
}

const inDisplay = (p, d) => p && d && p.x >= d.boundsPoints.x && p.x < d.boundsPoints.x + d.boundsPoints.w && p.y >= d.boundsPoints.y && p.y < d.boundsPoints.y + d.boundsPoints.h;
/** The display the agent works on. away: not the one under the user's pointer (the largest of the others). */
export function pickAgentDisplay(displays, pointer, mode = agentDisplay()) {
  if (!displays || !displays.length) return null;
  const main = displays.find(x => x.isMain) || displays[0];
  if (mode === 'main' || displays.length === 1) return mode === 'main' ? main : displays[0];
  if (mode === 'secondary') return displays.find(x => !x.isMain) || main;
  const user = displays.find(d => inDisplay(pointer, d)) || null;
  const others = displays.filter(d => d !== user).sort((a, b) => b.boundsPoints.w * b.boundsPoints.h - a.boundsPoints.w * a.boundsPoints.h);
  return others[0] || main;
}
function windowOn(d, reserveFeed = false) {
  const b = d.boundsPoints;
  // Leave an actual blank strip for the 360 pt feed and its spacing, provided
  // the page can retain at least 1000 pt. Never compress a small display.
  const aside = reserveFeed && b.w - 40 >= 1440 ? 440 : 0;
  return { left: b.x + 20, top: b.y + 40, right: b.x + b.w - 20 - aside, bottom: b.y + b.h - 20 };
}

async function agentWindowBounds() {
  const { displays, mouse } = await B.cgevent(['displays']);
  const d = pickAgentDisplay(displays, mouse);
  if (!d) {
    throw new BridgeError('displays_asleep', '❌ 现在没有处于工作状态的显示器（都在睡眠），没法安排 agent 窗口，这次没有打开。等屏幕亮起来再试。');
  }
  // leave room for the per-display menu bar
  return { ...windowOn(d, true), display: d };
}

let DISPLAYS = { at: 0, list: null };
/** The user's pointer when this action took over (guard.js hands it to prepare); see keepAgentAway. */
let USER_POINTER = null;
/**
 * Two or more displays: put the agent's own window where the setting says before raising it. away (the
 * default): it sits on the display the user is working on (their pointer is there) → move it to another,
 * so it never covers their work. secondary / main (the panel's 「固定在副屏 / 主屏」, chosen after the window
 * was made: Codex r13 A3): not on that display → move it there. Never when the user moved or resized it
 * themselves (it is no longer where the agent put it), and never a window that is not the agent's.
 */
async function keepAgentAway(tab, pointer) {
  const mode = agentDisplay();
  if (mode === 'off' || (mode === 'away' && !pointer)) return '';
  if (!DISPLAYS.list || Date.now() - DISPLAYS.at > 10_000) DISPLAYS = { at: Date.now(), list: (await B.cgevent(['displays'])).displays || [] };
  const displays = DISPLAYS.list;
  if (!displays.length || (displays.length < 2 && !PLAN)) return '';
  const info = await B.chromeInfo(tab);
  const st = await agentState();
  const entry = Object.values(st.byProfile).find(e => String(e.windowId) === String(info.windowId));
  const wb = info.bounds;
  if (!entry || !wb) return '';
  const here = displays.find(d => inDisplay({ x: wb.left + wb.width / 2, y: wb.top + wb.height / 2 }, d));
  const user = pointer ? displays.find(d => inDisplay(pointer, d)) : null;
  const near = (a, b) => a && b && ['left', 'top', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= 4);
  if (!entry.placed) {
    // An older window, placed before positions were recorded: from now on, where it is counts as ours unless it is in the user's way.
    if (here !== user) { entry.placed = { left: wb.left, top: wb.top, width: wb.width, height: wb.height }; await saveAgentState(st); }
    return '';
  }
  if (!here || !near(entry.placed, wb)) return '';
  const to = pickAgentDisplay(displays, pointer, mode);
  if (!to) return '';
  const nb = windowOn(to, !!PLAN);
  const reserveHere = !!PLAN && to === here && wb.width > nb.right - nb.left + 4;
  if (to === here && !reserveHere) return '';
  if (!reserveHere && mode === 'away' && (!user || here !== user || to === user)) return '';
  await B.moveWindow(info.windowId, nb);
  entry.placed = { left: nb.left, top: nb.top, width: nb.right - nb.left, height: nb.bottom - nb.top };
  entry.display = to.id;
  await saveAgentState(st);
  debugLog({ label: `agent window ${info.windowId} moved (${mode})`, from: here.id, to: to.id });
  if (reserveHere) return '（已在 agent 窗口旁留出空白，用于显示当前会话进度）\n';
  return mode === 'away' ? `（agent 窗口原本在你正在用的屏幕上，已挪到另一块屏幕再操作）\n`
    : `（按菜单栏里的设置，agent 窗口已挪到${to.isMain ? '主屏' : '副屏'}）\n`;
}
async function saveAgentState(st) {
  await mkdirP(path.dirname(AGENT_STATE), { recursive: true });
  await writeFileP(AGENT_STATE, JSON.stringify(st));
}

/* -------------------------------------------------------- tab ownership */

const TAKEOVER_WHY = {
  moved_window: '它被移到了别的窗口',
  url_changed: '它现在的网址不是 agent 打开或点出来的',
  user_viewing: '你当时正在看它',
  user_interrupted: 'agent 操作它的时候你接手了键盘鼠标',
  navigation_unverified: '无法确认加载期间的导航仍由 agent 发起'
};

/**
 * Takeover check before an agent uses a tab (plan T1, contract §4). A tab the
 * user may have taken over is still usable, but is never closed automatically
 * again; say so once it is marked.
 */
/** Tabs whose "may have been taken over" note was already given (once per tab: a long job would repeat it every step). */
const NOTED_TAKEN = new Set();

/** Opt-in diagnostics contain only stages, booleans, and numeric native state.
 * Never pass URLs, page text, input, account data, or raw helper objects here. */
function heldNavigationDebug(stage, facts = {}) {
  if (process.env.CHROME_BRIDGE_DEBUG_LOG) debugLog({ label: 'held_navigation', stage, ...facts });
}

function heldNavigationStatusFacts(st, session) {
  const boolean = value => typeof value === 'boolean' ? value : null;
  const number = value => Number.isFinite(value) ? value : null;
  return { present: !!st, ok: boolean(st?.ok), interrupted: !!st?.interrupted,
    sessionInterrupted: !!session?.interrupted, takeoverPresent: !!st?.takeover,
    active: boolean(st?.takeover?.active), aborted: boolean(st?.takeover?.aborted),
    hasAbortReason: !!st?.takeover?.abortedBy, hasReleaseReason: !!st?.takeover?.releasedBy,
    tapDiagnostic: !!st?.takeover?.tapDiagnostic,
    swallowedKeys: number(st?.takeover?.swallowedKeys),
    swallowedPointer: number(st?.takeover?.swallowedPointer) };
}

/** Capture an owned URL before input. Deferred clicks deliberately leave
 * prep.lastUrl null, so their eventual report cannot supply this old anchor. */
async function heldNavigationAnchor(prep, session, plan) {
  const th = TASK_HOLD, target = prep?.target;
  const current = () => PLAN === plan && plan && !plan.interrupted &&
    TASK_HOLD === th && (!th || th.kept?.session === session) &&
    !TASK_CANCELLED && !S.get('paused') && !YIELDING && !HOLD_ENDING;
  if (!current() || !target?.url || target.tabId == null || target.windowId == null) {
    heldNavigationDebug('anchor_precondition', { epoch: current(), target: !!target,
      urlPresent: !!target?.url, tabPresent: target?.tabId != null, windowPresent: target?.windowId != null });
    return null;
  }
  const rec = await getTab(target.tabId).catch(() => null);
  const checks = { epoch: current(), record: !!rec, mine: isMine(rec), untouched: !!rec && !rec.takenOver,
    windowMatches: !!rec && Number(rec.windowId) === Number(target.windowId),
    urlMatches: !!rec && rec.expectedUrl === target.url };
  const accepted = Object.values(checks).every(Boolean);
  heldNavigationDebug('anchor_registry', { ...checks, accepted });
  return accepted ? rec.expectedUrl : null;
}

/** Keep attribution for a delayed page response only inside the same explicit
 * task's uninterrupted native hold. taskRun starts these with takeoverUntilDone;
 * an implicit hold, a replacement plan/session, or an action posting no input
 * cannot establish this evidence. No timer-based URL grace is granted. */
function rememberHeldNavigation(result, { inputCount, session, plan, expectedUrl }) {
  const th = TASK_HOLD, target = result?.prep?.target;
  const checks = { inputSent: inputCount > 0, outcomeOK: result?.outcome === 'ok',
    kept: !!result?.kept, hold: !!th, sameKept: !!th && th.kept === result?.kept,
    sameSession: !!th && th.kept?.session === session, plan: !!plan, samePlan: !!plan && PLAN === plan,
    planUninterrupted: !!plan && !plan.interrupted, sameTask: !!th && !!plan && th.task === plan.task,
    notCancelled: !TASK_CANCELLED, notPaused: !S.get('paused'),
    target: !!target, tabPresent: target?.tabId != null, windowPresent: target?.windowId != null,
    anchorPresent: !!expectedUrl, pidValid: Number.isInteger(result?.prep?.chromePid),
    cgWindowValid: Number.isInteger(result?.prep?.cgWindow) };
  if (!Object.values(checks).every(Boolean)) { heldNavigationDebug('remember_rejected', checks); return; }
  th.pendingNavigation = { hold: th, session, plan, expectedUrl, tabId: target.tabId,
    windowId: target.windowId, chromePid: result.prep.chromePid, cgWindow: result.prep.cgWindow };
  heldNavigationDebug('remember_stored');
}

/** A submit may keep the old URL past clickReport's bounded wait. Before calling
 * that a user navigation, verify the original hold and exact focused target.
 * Failed/unknown proof is discarded, and an existing taken-over flag stays set. */
async function reconcileHeldNavigation(t) {
  const th = TASK_HOLD, p = th?.pendingNavigation;
  if (!p || !t || Number(t.tabId) !== Number(p.tabId) || !t.url || t.url === p.expectedUrl) {
    heldNavigationDebug('reconcile_skipped', { hold: !!th, pending: !!p, target: !!t,
      sameTab: !!p && !!t && Number(t.tabId) === Number(p.tabId),
      urlPresent: !!t?.url, unchanged: !!p && t?.url === p.expectedUrl });
    return;
  }
  const current = () => TASK_HOLD === th && p.hold === th && th.pendingNavigation === p &&
    th.kept?.session === p.session && PLAN === p.plan && !p.plan.interrupted &&
    !TASK_CANCELLED && !S.get('paused') && !YIELDING && !HOLD_ENDING;
  const healthy = st => st?.ok === true && !st.interrupted && !p.session.interrupted &&
    st.takeover?.active === true && st.takeover.aborted === false &&
    !st.takeover.abortedBy && !st.takeover.releasedBy && !st.takeover.tapDiagnostic &&
    st.takeover.swallowedKeys === 0 && st.takeover.swallowedPointer === 0;
  let stage = 'epoch';
  try {
    if (!current() || Number(t.windowId) !== Number(p.windowId)) {
      heldNavigationDebug('epoch_rejected', { sameHold: TASK_HOLD === th && p.hold === th,
        samePending: th.pendingNavigation === p, sameSession: th.kept?.session === p.session,
        samePlan: PLAN === p.plan, planInterrupted: !!p.plan.interrupted, cancelled: !!TASK_CANCELLED,
        paused: !!S.get('paused'), yielding: !!YIELDING, ending: !!HOLD_ENDING,
        sameWindow: Number(t.windowId) === Number(p.windowId) });
      return;
    }
    stage = 'registry';
    const rec = await getTab(p.tabId);
    if (!current() || !rec || !isMine(rec) || rec.takenOver || rec.expectedUrl !== p.expectedUrl) {
      heldNavigationDebug('registry_rejected', { epoch: current(), present: !!rec,
        mine: isMine(rec), takenOver: !!rec?.takenOver, anchorMatches: rec?.expectedUrl === p.expectedUrl });
      return;
    }
    stage = 'status_before';
    const st = await p.session.request({ op: 'status' }, { raw: true });
    heldNavigationDebug(stage, { epoch: current(), ...heldNavigationStatusFacts(st, p.session) });
    if (!current() || !healthy(st)) return;
    stage = 'target';
    const live = await B.chromeInfo(p.tabId);
    if (!current() || Number(live.tabId) !== Number(p.tabId) ||
        Number(live.windowId) !== Number(p.windowId) || live.chromePid !== p.chromePid ||
        live.cgWindow !== p.cgWindow || live.tabActive !== true || live.url !== t.url) {
      heldNavigationDebug('target_rejected', { epoch: current(),
        sameTab: Number(live.tabId) === Number(p.tabId), sameWindow: Number(live.windowId) === Number(p.windowId),
        samePid: live.chromePid === p.chromePid, sameCGWindow: live.cgWindow === p.cgWindow,
        active: live.tabActive === true, urlMatchesRead: live.url === t.url });
      return;
    }
    stage = 'focus';
    const focus = await B.axInput({ pid: p.chromePid, window: p.cgWindow });
    // A result page can focus its body with no AX hitWindow. The focused native
    // window is sufficient here; field-level windowMatches is an input guard.
    if (!current() || focus?.ok !== true || focus.frontmost !== true ||
        focus.pid !== p.chromePid || focus.expectedWindow !== p.cgWindow ||
        focus.focusedWindow !== p.cgWindow) {
      heldNavigationDebug('focus_rejected', { epoch: current(), present: !!focus, ok: focus?.ok === true,
        frontmost: focus?.frontmost === true, samePid: focus?.pid === p.chromePid,
        expectedWindowMatches: focus?.expectedWindow === p.cgWindow,
        focusedWindowPresent: focus?.focusedWindow != null, focusedWindowMatches: focus?.focusedWindow === p.cgWindow });
      return;
    }
    stage = 'status_after';
    const last = await p.session.request({ op: 'status' }, { raw: true });
    heldNavigationDebug(stage, { epoch: current(), ...heldNavigationStatusFacts(last, p.session) });
    if (!current() || !healthy(last)) return;
    stage = 'note';
    await noteAgentNavigation(p.tabId, live.url);
    NATIVE_TARGETS.delete(Number(p.tabId));
    ledgerNavigated(p.tabId, live.url);
    heldNavigationDebug('attributed');
  } catch { heldNavigationDebug('read_failed', { at: stage }); }
  finally { if (th.pendingNavigation === p) delete th.pendingNavigation; }
}

async function ownershipNote(t) {
  if (!t || t.tabId == null) return '';
  const call = CALL.getStore();
  if (call) { call.target = t.tabId; call.url = t.url; }
  await reconcileHeldNavigation(t);
  const c = await checkTabBeforeUse(t.tabId, { id: t.tabId, url: t.url, windowId: t.windowId }).catch(() => null);
  if (c) await ledgerSee(t.tabId, c, t);
  if (!c || !c.rec || !c.takenOver || NOTED_TAKEN.has(t.tabId)) return '';
  NOTED_TAKEN.add(t.tabId);
  if (!isMine(c.rec)) return `（这是 agent 开的标签，但${TAKEOVER_WHY[c.why] || '可能已被你接手'}，已标记为「可能已被你接手」，不会再被自动关闭）`;
  // This session's own tab: what to do now, by how sure the takeover is (src/ledger.js nextAction).
  const e = LEDGER.get(t.tabId);
  if (!e || e.state !== 'taken_over') return '';
  if (call) call.explained.add(t.tabId);
  return `（tab=${t.tabId} 是你这个会话开的 agent 标签，已标记为「可能已被用户接手」。${nextAction(e)}。` +
    `${takeoverKind(e) === 'leave' ? recoveryLine(LEDGER.live()) : ''}）`;
}

/* ----------------------------------------------------------- tab ledger */

/**
 * This session's tabs and their state (src/ledger.js). Ownership is the shared
 * registry's (ownerPid = this process); the ledger adds ready / stale /
 * taken_over / closed / gone as this process saw them, shows them first in
 * list_tabs, and adds one line to the next reply when they changed.
 */
const LEDGER = new TabLedger();
export function __ledgerForTests() { return LEDGER; }
/**
 * Per tool call: `target` the tab a tool resolved when the agent passed none (ownershipNote);
 * `explained` tabs whose change this reply states itself (a takeover note, a URL change it reports);
 * `listed` the reply already lists this session's usable tabs.
 */
const CALL = new AsyncLocalStorage();
let ORDINARY_INPUTS = 0;
let ORDINARY_TAIL = Promise.resolve();
const ROUTINE_EXCLUSIVE = new Set([...ROUTINE_ACTIONS, 'open_tab', 'close_tab', 'wait_for_user', 'task_plan', 'wake_screen']);
// Long human waits exclude routine starts but only their setup uses this queue.
const ORDINARY_WRITES = new Set([...ROUTINE_ACTIONS, 'open_tab', 'close_tab', 'task_plan', 'wake_screen']);

/** Page probes are read-only; native dialogs must be detected before an Apple Event. */
async function routineCapture(tab, request) {
  const dialog = await B.pageDialog();
  if (dialog?.open) throw new RoutineError('page_dialog');
  return B.evalInPage(await B.pageScript('routine', { ROUTINE: request }), tab);
}
async function routineGuard(guard) {
  routineCheck(guard.signal);
  const current = await routineCapture(guard.tab, guard.descriptor
    ? { mode: 'resolve', target: guard.descriptor, ...(guard.tool === 'press_key' ? { focused: true } : {}) }
    : { mode: 'state' });
  if (!pageMatches(routinePage(current), guard.before, { fingerprint: guard.firstInput !== false })) throw new RoutineError('page_changed');
  if (guard.descriptor && current.marker !== guard.marker) throw new RoutineError('target_changed');
  if (guard.tool === 'press_key' && current.targetState?.focused !== true) throw new RoutineError('target_changed');
  routineCheck(guard.signal);
}
function routineCheck(signal) {
  if (signal?.aborted) throw new RoutineError('cancelled');
  pausedCheck();
  conversationInputCheck();
}
const ROUTINES = createRoutineIntegration({ adapter: {
  capture: routineCapture,
  async tabs() {
    const result = await B.listTabs();
    return result.windows.flatMap(window => window.tabs.map(tab => ({ tabId: tab.id, title: tab.title, url: redactUrl(tab.url) })));
  },
  async inspect(tab, { signal, refresh } = {}) {
    if (signal?.aborted) throw new RoutineError('cancelled');
    pausedCheck();
    conversationInputCheck();
    if (refresh) await readPage({ tab, full: true }, { signal });
    else await siteGate(tab);
    return { page: routinePage(await routineCapture(tab, { mode: 'state' })) };
  },
  async resolve(tab, target, { signal, focused, refresh } = {}) {
    if (signal?.aborted) throw new RoutineError('cancelled');
    if (refresh) await readPage({ tab, full: true }, { signal });
    const resolved = await routineCapture(tab, { mode: 'resolve', target });
    if (focused && resolved.targetState?.focused !== true) throw new RoutineError('target_changed');
    return resolved;
  },
  async begin(run, routine) {
    if (ORDINARY_INPUTS > 0) throw new RoutineError('routine_busy');
    if (PLAN?.interrupted || TASK_CANCELLED) throw new RoutineError('task_interrupted');
    pausedCheck();
    conversationInputCheck();
    if (!PLAN) {
      try { await taskPlanTool({ task: routine.name }); }
      finally { run.ownedPlan = PLAN; run.plan = PLAN; }
    }
    run.plan = PLAN;
  },
  async act(tool, args, { signal, run, descriptor, before }) {
    const context = { target: null, explained: new Set(), listed: false, routineRun: run.id };
    context.routineCheck = () => routineCheck(signal);
    context.routineSignal = signal;
    context.routineGuard = () => routineGuard({ tool, tab: args.tab, marker: args.marker ?? context.focusedMarker,
      descriptor, before, signal, firstInput: context.routineInputStarted !== true });
    // press_key has no marker argument, but its exact focused element is bound before any input.
    if (tool === 'press_key') context.focusedMarker = (await routineCapture(args.tab, { mode: 'resolve', target: descriptor, focused: true })).marker;
    return CALL.run(context, async () => {
      const result = await callToolInner(tool, { ...args, task: run.plan?.task }, { signal }, async () => '');
      return { ok: !result.isError && context.routineEvidence?.ok !== false,
        code: context.code || context.routineEvidence?.code };
    });
  },
  async finish(run, { status }) {
    // begin may have refused an unrelated active call; never release that call's hold.
    if (!run.plan) return;
    if (run.ownedPlan && PLAN === run.ownedPlan) {
      clearTaskPlan(); closeTaskFeed(); PANEL_TASK = { text: '', at: 0 }; writeTaskState();
    } else if (status === 'completed') return;
    else if (PLAN === run.plan) interruptTaskPlan('routine_stopped', routineMessage(run.code));
    const end = await endTaskHold();
    if (end && end.inputReleased !== true) throw new RoutineError('cleanup_unconfirmed');
  }
} });
export function __routinesForTests() { return ROUTINES; }
/** Tabs not this session's that a reply already warned about (once per tab: work on the user's page would repeat it every step). */
const WARNED_NOT_MINE = new Set();
export function __resetLedgerForTests() { LEDGER.tabs.clear(); LEDGER.seq = LEDGER.reportedSeq = 0; WARNED_NOT_MINE.clear(); NOTED_TAKEN.clear(); }

/** Who this session is on the tabs it registers: CHROME_BRIDGE_AGENT_NAME, else the MCP client's own name (the pid is in the record). */
function agentName() {
  const env = String(process.env.CHROME_BRIDGE_AGENT_NAME || '').trim();
  if (env) return env;
  try { const c = server.getClientVersion(); if (c && c.name) return String(c.name); } catch {}
  return null;
}

const isMine = (rec) => !!rec && Number(rec.ownerPid) === OWNER_PID;
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** Ledger entry of a tab registered to this process; one the ledger has not seen yet is adopted (null: not mine). */
async function myEntry(tabId, rec = undefined) {
  if (tabId == null) return null;
  const e = LEDGER.get(tabId);
  if (e) return e;
  const r = rec === undefined ? await getTab(tabId).catch(() => null) : rec;
  if (!isMine(r)) return null;
  // Adopting it is no news; a takeover flag on it is (list_tabs shows it, a use check's note explains it).
  LEDGER.apply(tabId, { type: r.openedFrom != null ? 'popup' : 'open', url: r.expectedUrl, from: r.openedFrom ?? null }, { told: true });
  if (r.takenOver) LEDGER.apply(tabId, { type: 'takeover', why: r.takenOverWhy ?? null });
  return LEDGER.get(tabId);
}

/**
 * What a use check (checkTabBeforeUse) found, into the ledger. A takeover is news: the reply that
 * shows ownershipNote's note marks it explained; a call that fails before its reply carries the
 * note gets the reminder line instead.
 */
async function ledgerSee(tabId, c, t = {}) {
  if (isMine(c.rec)) {
    await myEntry(tabId, c.rec);
    LEDGER.info(tabId, { title: t.title ?? null, url: t.url ?? null });
    if (c.takenOver) LEDGER.apply(tabId, { type: 'takeover', why: c.why, seenAt: c.rec.takenOverAt });
    // What the tab shows right now, whatever the sticky first reason was (a helped tab dragged away later).
    const now = t.windowId != null ? checkTakeover({ ...c.rec, takenOver: false }, { id: tabId, url: t.url, windowId: t.windowId }) : null;
    if (now && now.changed) LEDGER.apply(tabId, { type: 'takeover', why: now.why, seenAt: Date.now() });
  } else if (LEDGER.get(tabId)) {
    LEDGER.drop(tabId);
  }
}

/**
 * My click / typing ended with the tab on `url` (only for a tab of mine). `reported`: the reply
 * says so itself (click / submit print the URL change and say to read again): no reminder line.
 */
function ledgerNavigated(tabId, url, { reported = false } = {}) {
  if (tabId == null || !url || !LEDGER.get(tabId)) return;
  LEDGER.apply(tabId, { type: 'navigated', url });
  const call = CALL.getStore();
  if (reported && call) call.explained.add(Number(tabId));
}

/**
 * Bring the ledger up to date with the registry (and a listing, when one is at
 * hand): forgotten records are gone tabs, takeover flags are taken_over, a tab
 * registered to another process now is not mine. Reads only this session's records.
 */
async function reconcileLedger(list = null, recs = null) {
  const byId = recs ? new Map(recs.map(x => [Number(x.tabId), x])) : null;
  for (const e of LEDGER.entries()) {
    if (e.state === 'closed' || e.state === 'gone') continue;
    const rec = byId ? (byId.get(e.tabId) || null) : await readTabRecord(e.tabId).catch(() => undefined);
    if (rec === undefined) continue;   // could not read it right now: no conclusion
    const live = list ? findLiveTab(list, e.tabId) : undefined;
    if (rec && !isMine(rec)) { LEDGER.drop(e.tabId); continue; }
    if (!rec && live) { LEDGER.drop(e.tabId); continue; }
    if (!rec || live === null) { LEDGER.apply(e.tabId, { type: 'missing' }); continue; }
    if (live) {
      LEDGER.info(e.tabId, { title: live.title, url: live.url });
      LEDGER.apply(e.tabId, { type: 'navigated', url: live.url });
    }
    if (rec.takenOver) LEDGER.apply(e.tabId, { type: 'takeover', why: rec.takenOverWhy ?? null, seenAt: rec.takenOverAt ?? undefined });
  }
}

/**
 * With a listing at hand (list_tabs, also with mine:true): this session's tabs get the takeover
 * check a sweep gives them — another window, a URL not the agent's (checkTakeover), the user
 * looking at it (observeUserTab: lock-aware, a click since the agent's last action) — before any
 * state is shown, so both forms of list_tabs show one state. A new mark is persisted (create-only
 * flag, as checkTabBeforeUse does). While an input lock was held across the listing, nothing is
 * concluded (an action may be moving or navigating its tab and has not reported it yet: planSweep).
 * @param obs  observeUserTab's {list, quiet, userTabId}
 */
async function checkMyTabs(recs, { list, quiet, userTabId }) {
  if (!quiet) return;
  for (const rec of recs) {
    if (!isMine(rec)) continue;
    const live = findLiveTab(list, rec.tabId);
    if (!live) continue;
    let now = checkTakeover({ ...rec, takenOver: false }, live, { userTabId });
    // The user on it now outranks a URL the agent did not open (the login redirect a wait_for_user
    // ended on): userTabId needs a click since the agent's last action or wait (observeUserTab).
    if (now.why === 'url_changed' && userTabId != null && Number(userTabId) === Number(rec.tabId)) now = { ...now, why: 'user_viewing' };
    if (!now.changed) continue;
    const at = Date.now();
    if (!rec.takenOver) {
      await markTakenOver(rec.tabId, now.why, at).catch(() => {});
      Object.assign(rec, { takenOver: true, takenOverWhy: now.why, takenOverAt: at });
    }
    await myEntry(rec.tabId, rec);
    LEDGER.apply(rec.tabId, { type: 'takeover', why: now.why, seenAt: at });
  }
}

/** Tools without a tab of their own: no "not your tab" warning. */
const NO_TAB_TOOLS = new Set(['list_tabs', 'open_tab', 'close_tab', 'task_plan', 'wake_screen']);

/**
 * A call used a tab that is not this session's (explicit `tab`, or the front tab when none was
 * passed): say whose it is, once per tab. Another agent's tab always; the user's only while this
 * session has tabs of its own (working on the user's page is otherwise the point).
 */
async function notMineWarning(args, { withList = true } = {}) {
  const call = CALL.getStore();
  if (call && call.listed) withList = false;
  const explicit = args.tab != null;
  const tabId = explicit ? Number(args.tab) : call && call.target != null ? Number(call.target) : null;
  if (tabId == null || !Number.isFinite(tabId) || WARNED_NOT_MINE.has(tabId)) return '';
  const e = LEDGER.get(tabId);
  if (e && e.state !== 'closed' && e.state !== 'gone') return '';
  const rec = await getTab(tabId).catch(() => null);
  if (isMine(rec)) return '';
  let line;
  if (rec) {
    line = pidAlive(Number(rec.ownerPid))
      ? `（tab=${tabId} 是另一个 ${ownerName(rec)}开的。可读取；键鼠操作需排队，未经交接不要修改或关闭它。）`
      : `（tab=${tabId} 是一个已退出的 ${ownerName(rec)}开的，不是你的。）`;
  } else if (LEDGER.live().length) {
    line = `（tab=${tabId} 不是你这个会话开的标签${explicit ? '' : '：没传 tab，用的是最前面的标签'}。）`;
  } else return '';
  WARNED_NOT_MINE.add(tabId);
  return `\n${line}${withList ? recoveryLine(LEDGER.live()) : ''}`;
}

/**
 * What goes after a reply's own text: the "not your tab" warning, then — only when this
 * session's tabs changed since the last reply (a tab its click opened, one gone stale, taken
 * over or gone) — one line listing them. Nothing at all otherwise (token cost).
 */
async function ledgerTail(name, args, { ok = true, error = null } = {}) {
  if (name === 'list_tabs' && ok) { LEDGER.markReported(); return ''; }
  if (LEDGER.size) await reconcileLedger().catch(() => {});
  const call = CALL.getStore();
  // One snapshot: a concurrent call's markReported cannot empty the line half way.
  const all = LEDGER.entries();
  const shown = new Set(LEDGER.fresh().filter(e => !(ok && call && call.explained.has(e.tabId))).map(e => e.tabId));
  const gone = error && error.code === 'no_such_tab';
  const warn = NO_TAB_TOOLS.has(name) || gone ? '' : await notMineWarning(args, { withList: !shown.size }).catch(() => '');
  const line = shown.size ? footerLine(all, { first: shown }) : '';
  LEDGER.markReported();
  return warn + (line ? '\n' + line : '');
}

/** A failed call on a tab that is no longer in Chrome: mark it gone if it was mine, and say what this session can use. */
function goneTabNote(name, args, e) {
  if (!e || e.code !== 'no_such_tab' || args.tab == null || NO_TAB_TOOLS.has(name)) return '';
  const had = LEDGER.get(args.tab);
  if (had) LEDGER.apply(args.tab, { type: 'missing' }, { told: true });
  // Working on the user's pages with no tabs of its own: nothing of this session's to point to.
  if (!had && !LEDGER.live().length) return '';
  const call = CALL.getStore();
  if (call) call.listed = true;
  return `\n${had ? `tab=${args.tab} 是你的标签，但它已经不在 Chrome 里了。` : ''}${recoveryLine(LEDGER.live())}`;
}

/**
 * After open_tab or a click that navigated: wait until the tab's URL stops
 * changing (redirects), up to `ms`, and return it. Used to record the URL the
 * agent's own navigation ended on, so a redirect is not later mistaken for
 * the user navigating.
 */
async function settledUrl(tabId, first, ms = 6000, signal = null, { stopOnPause = false } = {}) {
  const deadline = Date.now() + ms;
  let last = first, quietSince = null;
  while (Date.now() < deadline && !(signal && signal.aborted)) {
    await sleep(300);
    // The wait after the user's Return stops reading once paused; an agent's own open or click (already under way)
    // still settles, or the URL it registers would be the one before the redirect (Fable r13 r4 B1).
    if (stopOnPause && S.get('paused')) break;
    let info;
    try { info = await B.chromeInfo(tabId); } catch { break; }
    const url = info.url;
    if (!url || url === 'about:blank') { quietSince = null; continue; }
    // Chrome can expose an intermediate URL for seconds while the request is
    // pending. Allow a short loaded-document quiet period as well: login
    // callback pages often complete their redirect from a client-side timer.
    if (url !== last || info.loading === true) {
      last = url;
      quietSince = null;
      continue;
    }
    quietSince ??= Date.now();
    if (Date.now() - quietSince >= 1200) break;
  }
  return last;
}

/* ---------------------------------------------------------- list_tabs */

async function listTabsTool({ mine = false } = {}) {
  // One listing, with whether an input lock was held across it and the tab the user is looking at.
  const obs = await observeUserTab({ listTabs: () => B.listTabs(), lockDir: LOCK_DIR, clickedSince: (t0) => userClickedSince(t0) });
  const r = obs.list;
  const [recs, legacy, agentWin] = await Promise.all([
    allTabs().catch(() => []), legacyTabs().catch(() => []), mine ? new Set() : agentWindowIds()
  ]);
  // This session's tabs: the registry says which (ownerPid), the ledger in what state; the listing says what is still there.
  for (const rec of recs) if (isMine(rec)) await myEntry(rec.tabId, rec);
  await checkMyTabs(recs, obs);
  await reconcileLedger(r, recs);
  const section = mineSection(LEDGER.entries(), { pid: mine ? OWNER_PID : null });
  if (mine) return section.join('\n');
  const agentRecs = new Map(recs.map(x => [Number(x.tabId), x]));
  const legacyIds = new Set(legacy.map(x => Number(x.tabId)));
  const wins = [...r.windows].sort((a, b) => a.index - b.index);
  const total = wins.reduce((n, w) => n + w.tabs.length, 0);
  const chromeFront = chromeFrontmost(r);
  const agentSt = await agentState();
  const out = [
    `MyChrome MCP 版本 ${VERSION}（本服务进程 ${process.pid}，启动于 ${STARTED_AT}）`,
    ...section,
    '',
    `Chrome 共 ${wins.length} 个窗口、${total} 个标签（当前最前面的 App：${r.frontmost || '未知'}）`
  ];
  for (const w of wins) {
    const isAgentWin = agentWin.has(String(w.id));
    const tags = [
      w.index === 1 ? '最前面的 Chrome 窗口' : `第 ${w.index} 层`,
      w.minimized ? '已最小化' : null,
      w.mode === 'incognito' ? '无痕' : null
    ].filter(Boolean).join('，');
    const agentProf = isAgentWin ? Object.entries(agentSt.byProfile).find(([, e]) => String(e.windowId) === String(w.id)) : null;
    out.push('', `窗口 ${w.id}（${tags}${isAgentWin ? `，agent 专用窗口${agentProf && agentProf[1].name ? `·用户资料「${agentProf[1].name}」` : ''}` : ''}）`);
    for (const t of w.tabs) {
      const onScreen = t.active && w.index === 1 && !w.minimized && chromeFront;
      const mark = onScreen ? '▶ 屏幕上' : t.active ? '● 窗口当前' : '  ';
      const rec = agentRecs.get(Number(t.id));
      out.push(`  ${mark} tab=${t.id}  ${clip(redactText(t.title), 80) || '(无标题)'}${tabOwnerLabel(rec, legacyIds.has(Number(t.id)), isAgentWin, t.id)}`, `      ${clip(redactUrl(t.url), 160)}`);
    }
  }
  out.push('', '把 tab=… 的数字作为 tab 参数传给 read_page / click / type_text / scroll。' +
    '读取不会切换标签；点击、打字会先把该标签切到屏幕上，滚动只需要该标签在它的窗口里可见，并与其他 agent 排队。');
  return out.join('\n');
}

/** Whose a tab is, for the window listing: mine (with its state), another agent's (by name), an exited agent's, older builds', or nobody's. */
function tabOwnerLabel(rec, legacy, isAgentWin, tabId) {
  if (rec) {
    const st = tabStatus(rec);
    const kind = classifyRecord(rec, { myPid: OWNER_PID, isAlive: pidAlive });
    if (kind === 'mine') {
      const e = LEDGER.get(tabId);
      return `  ［你的·${e ? e.state : 'ready'}${rec.closeBlocked ? '：' + st : ''}］`;
    }
    const pop = rec.popup ? '点击弹出，不会被自动关' : null;
    if (kind === 'other_agent') return `  ［另一个 ${ownerName(rec)}开的${[pop, st].filter(Boolean).map(x => '：' + x).join('')}］`;
    return `  ［无主：开它的 ${ownerName(rec)}已退出${[pop, st].filter(Boolean).map(x => '；' + x).join('')}］`;
  }
  if (legacy) return '  ［旧版本服务开的，由旧版本管理］';
  if (isAgentWin) return '  ［未登记（可能是旧版本遗留、点击弹出或你拖进来的），不会自动关］';
  return '';
}

/* ---------------------------------------------------- open / close tab */

/** Run fn under the input lock only: no idle wait, no pointer, no session. */
async function lockOnly(label, fn) {
  try {
    return (await withInputLock(label, (t) => { pausedCheck('（在排队时）'); return fn(t); }, { info: lockInfo() })).result;
  } catch (e) {
    if (e.code === 'lock_timeout') throw new BridgeError('lock_timeout', e.message);
    throw e;
  }
}

/**
 * Wait for a just-opened tab's redirects and register it with the URL its load
 * settled on, still under the lock: sweeps do nothing while the lock is held,
 * and the registry only ever holds a URL the agent's own navigation ended on
 * (there is no grace period for a URL that changes later, codex2-3).
 */
async function registerSettled(r, url, observer) {
  const finalUrl = await settledUrl(r.tabId, url);
  const target = await B.chromeInfo(r.tabId).catch(() => null);
  const verified = !!observer && target && Number(target.windowId) === Number(r.windowId) &&
    await observer.untouched(target).catch(() => false);
  // The input lock excludes other agents, not the user. Never adopt a URL they typed while
  // this tab was loading, or reset the ownership baseline to after that interaction.
  await registerTab(r.tabId, verified ? finalUrl || url : url, { windowId: r.windowId, agentName: agentName() });
  LEDGER.apply(r.tabId, { type: 'open', url: finalUrl || url });
  if (!verified) {
    await markTakenOver(r.tabId, 'navigation_unverified');
    LEDGER.apply(r.tabId, { type: 'takeover', why: 'navigation_unverified' });
  }
  return { ...r, finalUrl, navigationVerified: verified };
}

async function openAndRegister(open, url) {
  // Arm before open/newWindow: even an immediate keyboard navigation is covered.
  const observer = await B.openNavigationObserver().catch(() => null);
  try { return await registerSettled(await open(), url, observer); }
  finally { if (observer) await observer.close().catch(() => {}); }
}

async function openTabTool(args) {
  const woke = await screenReady();
  return woke + await openTabRun(args);
}

async function openTabRun({ url, profile = null, why = null }) {
  if (!WHY_VALUES.includes(why)) {
    throw new BridgeError('why_required',
      '❌ 用 MyChrome 打开网页要先说明理由（参数 why），这次没有打开。它会用用户本人的 Chrome 和真实键鼠，只在这几种情况用：' +
      '网站限制 AI 或自动化访问（WebFetch 被 403/429/验证页拦下，或小红书、微信/企业微信后台、LinkedIn、Facebook 这类风控站）→ ' +
      'site_restricts_automation；需要用户 Chrome 里的登录状态 → needs_user_login；和用户在同一个网页上协作 → same_page_with_user；' +
      '用户明确要求用他的 Chrome → user_asked；WebFetch、Playwright 或扩展类工具试过但失败或被拦 → other_tool_failed。\n' +
      '都不是的话请改用别的工具：公开网页用 WebFetch/curl 或网站的 API；需要 JavaScript 但不用登录的，用 Playwright headless。');
  }
  if (!/^https?:\/\//i.test(url || '')) throw new BridgeError('bad_url', '❌ url 必须以 http:// 或 https:// 开头。');
  let r, where, note = '';
  const display = agentDisplay();
  if (display === 'off') {
    // Tabs go into the user's own front window: never change its visible tab.
    r = await lockOnly('open_tab', () => openAndRegister(() => B.openTab(url), url));
    where = `已在后台新开标签 tab=${r.tabId}（窗口 ${r.windowId}），当前屏幕上的标签没有切换。`;
  } else {
    // Under the input lock: opening and selecting changes the agent window's
    // visible tab, which another agent may be clicking in right now.
    const prof = await resolveProfile(profile);
    // Chrome writes Preferences lazily, so "off" in the file may be stale
    // (seen: the user had just switched it on). Warn, don't refuse; a real
    // read failure reports js_from_apple_events_disabled by itself.
    if (prof.appleEventsJS === false) {
      note += `（提示：用户资料「${prof.name}」的设置文件里「允许 Apple 事件中的 JavaScript」显示未开启；刚打开的话可能只是还没写入。读不了网页时，请在「${prof.name}」的窗口里点 显示 → 开发者 → 允许 Apple 事件中的 JavaScript。）\n`;
    }
    r = await lockOnly('open_tab', () => openAndRegister(async () => {
      const existing = await agentWindowId(prof.dir, prof.isDefault);
      if (existing) return B.openTab(url, existing, { select: true });
      // First use: create the window. `make new window` brings Chrome
      // forward, so the user's scene is put back afterwards.
      const scene = await B.snapshotScene().catch(() => null);
      try {
        const b = await agentWindowBounds();
        const created = await B.newWindow(url, b, prof.dir);
        // macOS may clamp a requested frame to its menu-bar/work-area bounds.
        // Record what Chrome actually accepted, not our requested rectangle.
        const placedInfo = await B.chromeInfo(created.tabId).catch(() => null);
        const actual = placedInfo?.windowId === created.windowId ? placedInfo.bounds : null;
        const st = await agentState();
        st.byProfile[prof.dir] = { windowId: created.windowId, display: b.display.id, name: prof.name,
          ...(actual ? { placed: { left: actual.left, top: actual.top, width: actual.width, height: actual.height } } : {}) };
        await mkdirP(path.dirname(AGENT_STATE), { recursive: true });
        await writeFileP(AGENT_STATE, JSON.stringify(st));
        note = `已在${b.display.isMain ? '主屏' : '副屏'}（display ${b.display.id}${display === 'away' ? '，不是你鼠标所在的那块' : ''}）为用户资料「${prof.name}」创建 agent 专用窗口 ${created.windowId}。\n`;
        return created;
      } finally {
        if (scene) {
          await B.restoreScene(scene).catch(() => {});
          // Chrome can still come forward a moment later (its own activation for the new window): look
          // once more and hand the front back, unless the user clicked since (a click into Chrome is theirs).
          // Not on any input: the user moving the mouse or typing in their app is who this protects
          // (Fable r12 r3 B1); a ⌘-Tab into Chrome within these 400 ms is undone (accepted).
          const t = Date.now();
          await sleep(NEW_WINDOW_SETTLE_MS);
          if (scene.appPid != null) await B.restoreApp(scene.appPid, { noClickSince: t }).catch(() => {});
        }
      }
    }, url));
    where = `已在用户资料「${prof.name}」（${prof.user || prof.dir}）的 agent 专用窗口（${r.windowId}）新开标签 tab=${r.tabId}，并设为该窗口的当前标签` +
      '（没有把 Chrome 切到前面，你的窗口没有变化）。';
  }
  const finalUrl = r.finalUrl;
  return `✅ ${where}\n${note}` +
    (r.navigationVerified === false ? '（加载期间的导航归属无法确认，已保护这个标签，不会自动关闭；可以继续读取。）\n' : '') +
    (finalUrl && finalUrl !== url ? `页面跳转到了：${clip(finalUrl, 160)}\n` : '') +
    `页面可能还在加载；稍后用 read_page(tab=${r.tabId}) 读取。`;
}

async function closeTabTool({ tab }) {
  NATIVE_TARGETS.delete(Number(tab));
  // Another agent's tab, while that agent runs: its work, not ours to end. A tab whose agent has exited may be closed.
  // A popup an agent's click opened: only that agent closes it, also after it exited (it is never swept either).
  const owner = await getTab(tab).catch(() => null);
  if (owner && !isMine(owner) && (owner.popup || pidAlive(Number(owner.ownerPid)))) {
    throw new BridgeError('not_your_tab', owner.popup && !pidAlive(Number(owner.ownerPid))
      ? `❌ 标签 ${tab} 是一个已退出的 ${ownerName(owner)}点击弹出的，只有它自己能关，没有关闭；要关请用户自己关。${recoveryLine(LEDGER.live())}`
      : `❌ 标签 ${tab} 是另一个 ${ownerName(owner)}开的，不是你的，没有关闭。${recoveryLine(LEDGER.live())}`);
  }
  if (isMine(owner)) {
    await myEntry(tab, owner);
    // Our retained hold can leave this tab foremost. Restore/release it before the
    // normal user-viewing checks; another agent's hold and real takeover guards stay in force.
    await endTaskHold();
  }
  const r = await closeAgentTab(tab, { listTabs: () => B.listTabs(), closeTab: (id) => B.closeTab(id), clickedSince: (t0) => userClickedSince(t0) });
  if (r.ok) {
    // The reply says what happened to it: no reminder line for this tab.
    LEDGER.apply(tab, { type: r.closed ? 'close' : 'missing' }, { told: true });
    return r.closed ? `✅ 已关闭 agent 标签 ${tab}（已确认它不在了）` : `标签 ${tab} 已经不在了，已从记录中移除。`;
  }
  if (r.reason === 'not_agent_tab') {
    throw new BridgeError('not_agent_tab',
      `❌ 标签 ${tab} 不是 agent 用 open_tab 打开的，不会关闭它（用户自己开的标签一律不动）。${recoveryLine(LEDGER.live())}`);
  }
  if (r.reason === 'taken_over' && !r.transient) LEDGER.apply(tab, { type: 'takeover', why: r.why ?? null }, { told: true });
  if (r.reason === 'taken_over' && r.transient) {
    throw new BridgeError('taken_over',
      `⚠️ 标签 ${tab} 现在正显示在最前面的 Chrome 窗口里（可能是你在看，也可能是另一个 agent 正在操作它），这次没有关闭。稍后再试。`);
  }
  if (r.reason === 'taken_over') {
    throw new BridgeError('taken_over',
      `⚠️ 标签 ${tab} 可能已被你接手（${TAKEOVER_WHY[r.why] || '原因见 list_tabs'}），不会关闭它。需要关的话请你自己关。`);
  }
  throw new BridgeError('close_blocked',
    `⚠️ 标签 ${tab} 没能关掉：3 秒后它还在（常见原因是网页弹出了「有未保存的内容」提示框）。` +
    '不会再自动尝试，请你自己看一下。');
}

/* ------------------------------------------------------------ read_page */

/** What the agent is told about a page dialog (alert / confirm / prompt) that blocks the page. */
function dialogNote(d) {
  const text = (d.texts || []).join(' ').replace(/\s+/g, ' ').trim();
  return `⚠️ 网页弹出了对话框（${d.title || '网页对话框'}）：「${text}」，按钮：${(d.buttons || []).join(' / ')}。` +
    '对话框开着时网页读不了也点不了；用 answer_dialog（button 写按钮上的字）选一个，再继续。';
}

/**
 * What read_page prints, for src/page/read.js (__READ__): {} = this screen + the page outline;
 * {sections} = those outline sections with their sub-sections; {query} = the blocks that contain it;
 * {full: true} = the whole page as before.
 */
function readRequest({ sections = null, query = null, full = false } = {}) {
  const req = {};
  if (full === true) req.full = true;
  if (sections != null) {
    const ids = (Array.isArray(sections) ? sections : String(sections).split(/[\s,，、]+/))
      .map(x => String(x).trim()).filter(Boolean);
    const bad = ids.filter(x => !/^[Ss]?\d+$/.test(x));
    if (bad.length) {
      throw new BridgeError('bad_sections',
        `❌ sections 要写目录里的节号，例如 ["S3","S7"]；看不懂：${bad.join('、')}。不带参数的 read_page 会列出目录。`);
    }
    if (ids.length) req.sections = ids.slice(0, 20).map(x => `S${x.replace(/^[Ss]/, '')}`);
  }
  if (query != null && String(query).trim()) req.query = String(query).replace(/\s+/g, ' ').trim().slice(0, 200);
  return req;
}

/** Default read_page budget, in estimated tokens (owner, 2026-10-06: headings first, then the screen's text, then the picture). */
const READ_BUDGET = Number(process.env.CHROME_BRIDGE_READ_BUDGET) > 0 ? Number(process.env.CHROME_BRIDGE_READ_BUDGET) : 2500;
/** This much of the screen being canvas / frames / pictures without words: read the screen, not the code. */
const OPAQUE_SHARE = 0.3;

async function readPage({ tab = null, sections = null, query = null, full = false, budget = null } = {}, { signal = null } = {}) {
  const req = readRequest({ sections, query, full });
  const dlg = await B.pageDialog().catch(() => null);
  if (dlg && dlg.open) throw new BridgeError('page_dialog', dialogNote(dlg));
  await siteGate(tab);
  const src = await B.pageScript('read', { READ: req });
  const res = await B.evalInPage(src, tab);
  const own = await ownershipNote(res.target);
  // Markers are fresh now (only a tab of mine; ownershipNote has put it in the ledger).
  if (res.target && res.target.tabId != null && LEDGER.get(res.target.tabId)) {
    LEDGER.apply(res.target.tabId, { type: 'read', url: res.target.url, title: res.target.title });
  }
  // The page's own last line says how to expand; it stays the last line of the result.
  const hint = res.hint || '';
  const text = hint && res.text.endsWith(hint) ? res.text.slice(0, -hint.length).trimEnd() : res.text;
  const lines = [
    targetLine(res.target),
    own,
    text,
    '',
    `（页面共 ${res.count} 个可点击元素；用 click 工具加上方括号里的编号来点击` +
      (res.target && res.target.tabId != null ? `，并带上 tab=${res.target.tabId}）` : '）') +
      '\n（想点的东西没有编号时：screenshot 读出画面上的字（t1…），再 click_at text_id；悬停菜单用 hover，原生下拉框用 select_option，自制下拉菜单可用 press_key 上下键）',
    hint
  ];
  const out = lines.filter(x => x !== '').join('\n').replace(/\n(?=（页面共)/, '\n\n');
  // Asked for something specific (sections, a word, the whole page): that is what they get.
  if (req.full || req.sections || req.query) return out;
  const limit = Math.min(20000, Math.max(200, Math.round(Number(budget) || READ_BUDGET)));
  const domTok = estimateTextTokens(out);
  const opaque = Number(res.opaque) || 0;
  if (domTok <= limit && opaque < OPAQUE_SHARE) {
    // The note goes just above the page's own last line (how to expand), which stays last.
    const note = `（这次读的是网页代码，约 ${domTok} token）`;
    return hint && out.endsWith(hint) ? `${out.slice(0, -hint.length)}${note}\n${hint}` : `${out}\n${note}`;
  }
  const why = domTok > limit
    ? `网页代码这一屏约 ${domTok} token，超过预算 ${limit}`
    : `这一屏约 ${Math.round(opaque * 100)}% 是网页代码读不出字的内容（画布、内嵌页面、没有文字说明的图片）`;
  return readScreen({ target: res.target, own, visibility: res.visibility, outline: res.outline, why, domTok, limit, dom: out, hint, signal });
}

/** The top level of the page outline, for a result that reads the screen instead of the code. */
function outlineTop(outline) {
  const secs = (outline || []).filter(x => x && x.id > 0);
  if (!secs.length) return '';
  const top = Math.min(...secs.map(x => x.depth));
  const rows = secs.filter(x => x.depth === top).slice(0, 30)
    .map(x => `S${x.id} ${x.title}（约 ${x.tok} token${x.scr ? '，在屏上' : ''}）`);
  return `页面目录（大标题；read_page(sections=["S…"]) 展开）：\n${rows.join('\n')}`;
}

/**
 * read_page's second and third tier: the tab's window as a picture, its text recognised on this Mac.
 * Only a visible page, captured by window number: reading never takes the keyboard and mouse or brings
 * Chrome forward (Codex merge review, 2026-10-07: the description promises it, and a read in one session
 * must not seize the screen while the user works). A page that cannot be captured that way gets the page
 * code, over budget, with a pointer to screenshot. The text when it fits the budget, else the picture.
 * @returns string, or {text, image} for the picture
 */
async function readScreen(o) {
  const tabId = o.target && o.target.tabId != null ? o.target.tabId : null;
  let shot = null, how = '';
  try {
    if (o.visibility === 'visible' && tabId != null) {
      try {
        const cap = await readOnlyCapture({ tab: tabId }, o.signal, o.target);
        shot = cap.shot;
        o = { ...o, target: cap.target, own: [...new Set([o.own, cap.own].filter(Boolean))].join('\n') };
        how = '网页可见，直接截了这个窗口（没有接管键鼠）';
      } catch (e) {
        // An identity/capture failure leaves the already-read DOM available.
        // User Stop/pause and website restrictions must still stop this call.
        if (['site_blocked', 'paused_by_user', 'cancelled'].includes(e?.code)) throw e;
      }
    }
    if (!shot) {
      const note = `（这次读的是网页代码，约 ${o.domTok} token：${o.why}，但${o.visibility === 'visible' ? '这个窗口截不到' : '网页当时不在屏幕上（后台标签、被盖住或最小化）'}；` +
        '读网页不会接管键鼠去截图。可继续用 full / sections / query 读取；需要画面时，等目标标签显示在窗口中再调用 screenshot）';
      return o.hint && o.dom.endsWith(o.hint) ? `${o.dom.slice(0, -o.hint.length)}${note}\n${o.hint}` : `${o.dom}\n${note}`;
    }
    const { layout, error } = await readShot(shot, tabId);
    const body = layout && layout.texts.size ? textBlock(layout) : '';
    const ocrTok = estimateTextTokens(body);
    const imgTok = estimateImageTokens(shot.width, shot.height);
    const useText = !error && body && ocrTok <= o.limit;
    const head = [targetLine(o.target), o.own,
      `📖 ${o.why}，${useText ? '改为读屏幕上的字' : '屏幕上的字也' + (error ? `识别失败（${error}）` : body ? `有约 ${ocrTok} token` : '几乎没有') + '，直接给这一屏的图'}；${how}。`,
      outlineTop(o.outline)].filter(Boolean);
    const tail = `估算：网页代码这一屏约 ${o.domTok} token，屏幕识字约 ${ocrTok} token，整张图约 ${imgTok} token（宽×高/750）。\n` +
      `要点：click_at(${useText ? 'text_id="t3", ' : ''}x, y, tab=${tabId}) 按画面坐标点；要网页代码版本：read_page(full: true / sections / query)。`;
    if (useText) {
      return [...head, `屏幕上的文字（${layout.texts.size} 行，括号里是中心坐标）：`, body, tail].join('\n');
    }
    return { text: [...head, tail].join('\n'), image: { data: shot.data, width: shot.width, height: shot.height } };
  } finally {
    if (shot) await shot.dispose();
  }
}

/**
 * Before anything that needs the screen: sleeping displays are lit (like touching the mouse; no
 * input is sent); a locked screen is reported — the password is the user's to type, never ours.
 * @returns note for the result ('' when nothing had to be done)
 */
async function screenReady() {
  let r;
  try { r = await B.ensureScreenAwake(); }
  catch (e) {
    if (e instanceof BridgeError && e.code !== 'screen_state_unknown') throw e;
    throw new BridgeError('screen_state_unknown', '❌ 无法确认屏幕是否可用，这次没有操作。请稍后重试。');
  }
  if (!r || typeof r.locked !== 'boolean' || !Number.isFinite(r.displays)) {
    throw new BridgeError('screen_state_unknown', '❌ 无法确认屏幕是否可用，这次没有操作。请稍后重试。');
  }
  if (r.locked) {
    throw new BridgeError('screen_locked', '⏸ 屏幕锁着' + (r.woke ? '（已把熄灭的显示器点亮）' : '') +
      '。agent 不会输入密码，需要你解锁；这次没有操作，解锁后请重新发起。');
  }
  if (!r.displays) throw new BridgeError('displays_asleep', '❌ 显示器点不亮（可能合着盖或没接显示器），这次没有操作。');
  return r.woke ? '（屏幕原本熄灭了，已点亮）\n' : '';
}

/** wake_screen: light up sleeping displays and say whether the screen is locked. */
async function wakeScreenTool() {
  const r = await B.ensureScreenAwake();
  if (r.locked) return `屏幕锁着${r.woke ? '（显示器已点亮）' : ''}：需要用户解锁，agent 不会输入密码。`;
  if (!r.displays) return '❌ 显示器点不亮（可能合着盖或没接显示器）。';
  return r.woke ? `✅ 已点亮熄灭的屏幕（${r.displays} 块显示器），没有锁屏，可以继续。` : `✅ 屏幕本来就亮着（${r.displays} 块显示器），没有锁屏。`;
}

/** answer_dialog: press a button of the page's dialog (alert / confirm / prompt). */
async function answerDialogTool({ button, text = null, tab = null }) {
  const d = await B.pageDialog();
  if (!d.open) return '现在没有网页对话框；可以直接继续（read_page 看页面）。';
  // Only the tab's own dialog: its title names the site that opened it ("exam.example.com 显示").
  if (tab != null) {
    const info = await B.chromeInfo(tab).catch(() => null);
    const host = info && info.url ? (() => { try { return new URL(info.url).host; } catch { return ''; } })() : '';
    if (host && d.title && !String(d.title).includes(host)) {
      throw new BridgeError('other_dialog', `❌ 开着的对话框（${d.title}）不是标签 ${tab}（${host}）弹出的，没有动它。`);
    }
  }
  if (text != null && !d.hasField) throw new BridgeError('no_text_field', '❌ 这个对话框没有输入框（不是 prompt），不能填文字；只选按钮即可。');
  if (typeof button !== 'string' || !button.trim()) throw new BridgeError('bad_button', `❌ 要写按钮上的字：${(d.buttons || []).join(' / ')}`);
  const r = await B.answerDialog(button.trim(), text).catch((e) => ({ ok: false, message: e.message, buttons: d.buttons }));
  if (!r.ok) throw new BridgeError('no_such_button', `❌ ${r.message || '没能按下'}（对话框的按钮：${(r.buttons || d.buttons || []).join(' / ')}）`);
  const said = (d.texts || []).join(' ').slice(0, 80);
  return `✅ 已在${said ? `对话框「${said}」里` : '对话框里'}${text != null ? `填入 ${[...String(text)].length} 个字后` : ''}按了「${button.trim()}」` +
    (r.stillOpen ? '；⚠️ 对话框还在（可能又弹了一个），请再看一次。' : '；对话框已关闭。接着 read_page 看页面。');
}

/* ------------------------------------------------------ input actions */

function queueNote(waitedMs, waitedFor, { ahead = 0, inherited = false } = {}) {
  const chain = '直接接过上一个 agent 的接管，中间没有还原再接管';
  if (!(waitedMs > 200)) return inherited ? `（${chain}）\n` : '';
  return `（排队 ${(waitedMs / 1000).toFixed(1)} 秒后按先来后到轮到这次` +
    (ahead > 0 ? `，当时前面有 ${ahead} 个任务` : '') +
    (waitedFor ? `；之前在做的是「${waitedFor}」` : '') +
    (inherited ? `；${chain}` : '') + '）\n';
}

/** What a waiting ticket says about this agent (lock.js queue; the holder's veil lists the waiting ones). */
function lockInfo(task = '') {
  const id = agentIdentity();
  return { who: id.who, task: task || (Date.now() - PANEL_TASK.at <= PANEL_TASK_KEEP_MS ? PANEL_TASK.text : '') || null };
}

/** The holder side of a turn for runInputAction: a hand-over to take, and a way to hand over. */
function withTurn(ops, turn) {
  if (!turn || !ops.takeover) return ops;
  return { ...ops, ...(turn.handoff ? { inherit: { ...turn.handoff, claim: () => turn.claim() } } : {}),
    handoff: (payload, opts) => turn.offer(payload, opts) };
}

/**
 * While a session holds the user's input, its veil lists the tasks waiting for the mouse
 * (lock.js queue), refreshed every second; stops when the session closes.
 */
const QUEUE_POLL_MS = Number(process.env.CHROME_BRIDGE_QUEUE_POLL_MS ?? 1000);
function queueLabel(t) {
  const who = t.who && typeof t.who === 'object' ? t.who : { zh: t.who || 'AI', en: t.who || 'AI' };
  return t.task ? { zh: `${who.zh}：${t.task}`, en: `${who.en}: ${t.task}` } : who;
}
const zhText = (v) => typeof v === 'string' ? v : (v && (v.zh || v.en)) || '';
function watchQueue(session) {
  if (!session || typeof session.request !== 'function') return session;
  let last = '[]', stopped = false, busy = false;   // nothing sent while nobody waits
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const q = await queueList().catch(() => null);
      if (!q || stopped) return;
      const mine = pendingTickets();
      const labels = q.filter(t => !(t.pid === process.pid && mine.has(t.name))).map(queueLabel);
      const key = JSON.stringify(labels);
      if (key === last) return;
      last = key;
      await session.request({ op: 'panel', queue: labels }, { raw: true }).catch(() => {});
    } finally { busy = false; }
  };
  const timer = setInterval(tick, QUEUE_POLL_MS);
  timer.unref?.();
  tick();
  const close = session.close.bind(session);
  session.close = (...a) => { stopped = true; clearInterval(timer); return close(...a); };
  return session;
}

/** Take the pointer only after the user has been hands-off this long (seconds; 0 = don't wait). The panel sets it. */
const userIdleS = () => S.get('idleSeconds');
/** Give up (without acting) if the user never pauses for this long. */
const USER_IDLE_MAX_WAIT_MS = Number(process.env.CHROME_BRIDGE_IDLE_MAX_MS ?? 60000);

/**
 * Takeover (default on; CHROME_BRIDGE_TAKEOVER=0 for the old polite mode):
 * for the length of each action the helper holds the user's keyboard and
 * mouse, shows a light overlay ("Esc twice to cancel") and gives both back
 * when the scene is restored. Before taking over it waits briefly for a
 * pause in the user's typing, then takes over anyway.
 */
let TAKEOVER = process.env.CHROME_BRIDGE_TAKEOVER !== '0';
/** Tell the user (not only the agent) when their own keys or clicks were held: they would think the keyboard failed. */
const notifyEnabled = () => notifyOverride ?? S.get('notify');
/**
 * Held input is told to the user by a system notification, at most one per NOTIFY_EVERY_MS: a long
 * job takes over a hundred times, and one notification per action would bury the screen (round 5).
 * Counts in between are added up and told when the window ends.
 */
let NOTIFY_EVERY_MS = 60_000;
let notifySend = (text, o = {}) => {
  try {
    const p = spawn('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(text)} with title "MyChrome"${o.sound ? ' sound name "Glass"' : ''}`],
      { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
};
let notifyOverride = null;   // tests only
const heldNote = { keys: 0, pointer: 0, last: -Infinity, timer: null };
function flushHeldNote() {
  if (heldNote.timer) clearTimeout(heldNote.timer);
  heldNote.timer = null;
  const { keys, pointer } = heldNote;
  if (!keys && !pointer) return;
  heldNote.keys = heldNote.pointer = 0;
  heldNote.last = Date.now();
  const parts = [keys ? `${keys} 个按键` : '', pointer ? `${pointer} 次点击/滚动` : ''].filter(Boolean);
  notifySend(`agent 操作期间拦下了你的 ${parts.join('、')}，没有送到任何程序，需要的话请重新输入。`);
}
function notifyUserHeld(keys, pointer) {
  if (!notifyEnabled() || !(keys || pointer)) return;
  heldNote.keys += keys;
  heldNote.pointer += pointer;
  const wait = heldNote.last + NOTIFY_EVERY_MS - Date.now();
  if (wait <= 0) return flushHeldNote();
  if (!heldNote.timer) heldNote.timer = setTimeout(flushHeldNote, wait);
}
export function __notifyForTests({ send, everyMs }) {
  notifySend = send; NOTIFY_EVERY_MS = everyMs; notifyOverride = true;
  Object.assign(heldNote, { keys: 0, pointer: 0, last: -Infinity });
  return (k, p) => notifyUserHeld(k, p);
}

/* ---------------------------------------------- the site wants a human */

/**
 * CAPTCHAs, bot checks, rate limits, "access denied": MyChrome neither solves nor gets around
 * them (owner, 2026-10-06: a tool that saves the user's time on their own computer, not one that
 * escapes CAPTCHAs). What it must not do either is sit there stuck: it stops, hands the keyboard
 * and mouse back if a job held them, tells the user (a notification with a sound, the menu-bar
 * panel) and the agent waits for them with wait_for_user.
 */
const BLOCKS = new Map();   // tabId -> { kind, vendor, evidence, site, url, since, toldAt, alertToken }
const SESSION_GENERATION = randomUUID(); // PID alone can be reused after a worker exits.
function blockToken(block) { return block ? (block.alertToken ||= randomUUID()) : null; }
function clearBlock(tabId, token) {
  if (!token || blockToken(BLOCKS.get(tabId)) !== token) return false;
  BLOCKS.delete(tabId);
  writeTaskState();
  return true;
}
const TELL_EVERY_MS = 5 * 60_000;
const BLOCK_KIND = { captcha: '人机验证（验证码）', challenge: '人机检查页', rate_limit: '「访问过于频繁」限制', forbidden: '「拒绝访问」页面' };
// The notification in English when CHROME_BRIDGE_LANG=en (the overlay follows the same switch in helper.swift).
const BLOCK_KIND_EN = { captcha: 'a CAPTCHA', challenge: 'a bot check', rate_limit: 'a "too many requests" limit', forbidden: 'an "access denied" page' };
const blockText = (b) => b.kind === 'user' ? b.evidence : (b.vendor ? `${b.vendor} ` : '') + (BLOCK_KIND[b.kind] || '需要真人处理的页面');
const siteOf = (url) => { try { return new URL(url).host || String(url); } catch { return url ? String(url) : '网页'; } };
function tellUser(text) {
  if (!notifyEnabled()) return;
  // The native prompt has real action buttons; do not also post an inert AppleScript banner.
  if (!notifyOverride) {
    try {
      const state = JSON.parse(readFileSync(path.join(path.dirname(LOCK_DIR), 'menubar-state.json'), 'utf8'));
      if (state.handoffGUI === true && Date.now() - state.at < 5000 && Date.now() >= state.at) return;
    } catch {}
  }
  notifySend(text, { sound: true });
}

/** What the page shows now: { blocked, tabId, url }; null when the check itself could not run. */
async function blockCheck(tab) {
  try {
    const r = await B.evalInPage(await B.pageScript('block'), tab, { lean: tab != null });
    return { blocked: r.blocked || null, tabId: r.target && r.target.tabId != null ? r.target.tabId : tab, url: (r.target && r.target.url) || '' };
  } catch { return null; }
}

/** Note a page that waits for a human: hand the keyboard and mouse back, tell the user (at most every 5 minutes), show it in the menu bar. */
async function markBlocked(c, { newWait = false } = {}) {
  const prev = BLOCKS.get(c.tabId);
  const same = prev && prev.kind === c.blocked.kind && prev.vendor === c.blocked.vendor
    && prev.evidence === c.blocked.evidence && prev.url === c.url;
  const b = { ...c.blocked, site: siteOf(c.url), url: c.url,
    since: same ? prev.since : Date.now(), toldAt: same ? prev.toldAt : 0,
    alertToken: same && !newWait ? blockToken(prev) : randomUUID() };
  BLOCKS.set(c.tabId, b);
  if (TASK_HOLD) await endTaskHold().catch(() => {});
  if (Date.now() - b.toldAt > TELL_EVERY_MS) {
    b.toldAt = Date.now();
    tellUser(/^en/i.test(process.env.CHROME_BRIDGE_LANG || '')
      ? `Needs you: ${b.site} is showing ${b.kind === 'user' ? b.evidence : b.vendor ? `a ${b.vendor} check` : (BLOCK_KIND_EN[b.kind] || 'a page that needs a person')}. The AI has paused and given the keyboard and mouse back; it carries on once you are done.`
      : `需要你处理：${b.site} 出现了${blockText(b)}。AI 已暂停并交还键盘鼠标，你处理完它会接着做。`);
  }
  writeTaskState();
  debugLog({ label: `site blocked tab ${c.tabId}`, blocked: c.blocked, site: b.site });
  return b;
}

/** Before reading or acting: a page that waits for a human stops the agent here (and only here). */
async function siteGate(tab) {
  const c = await blockCheck(tab);
  if (!c) return;   // the check could not run: it never stands in the way of work
  if (!c.blocked) { if (BLOCKS.delete(c.tabId)) writeTaskState(); return; }
  const b = await markBlocked(c);
  throw new BridgeError('site_blocked',
    `⏸️ ${b.site} 出现了${blockText(b)}（${c.blocked.evidence}）。这是网站要求真人处理的环节，MyChrome 不代做、也不绕过。\n` +
    `已经提醒用户（系统通知 + 菜单栏），键盘鼠标已交还。\n` +
    `不要重试，也不要换别的工具去绕过。调用 wait_for_user（tab=${c.tabId}）等用户处理完再继续；或者结束任务，告诉用户卡在哪里。`);
}

let WAIT_POLL_MS = 3000;
/** With `field`: how often the page is asked whether the user pressed Return (one small script, no input). */
let ASK_POLL_MS = 700;
// After the user's Return: how long to watch for the page's own navigation (a login redirect a moment later).
let SUBMIT_FOLLOW_MS = 5000;
export function __setWaitPollForTests(ms, askMs = null, followMs = null) {
  WAIT_POLL_MS = ms;
  if (askMs != null) ASK_POLL_MS = askMs;
  if (followMs != null) SUBMIT_FOLLOW_MS = followMs;
}
export function __blocksForTests() { return BLOCKS; }

/** wait_for_user: the user has been told; read the page every few seconds (no input) until they are done. */
/** A reply that is not an error but not done either (a wait that ran out, a tab gone): the activity log says 没做成. */
function notDone(code, text) {
  const st = CALL.getStore();
  if (st) { st.failed = true; st.code = code; }
  return text;
}

/** How long one wait_for_user call waits: `minutes`, else 3; a field only the user can fill, 10 (they may be away from the computer). */
export function waitMinutes(minutes, field) {
  return Math.min(10, Math.max(0.01, Number(minutes) || (field != null ? 10 : 3)));
}

async function waitForUserTool({ tab = null, reason = '', minutes = null, field = null } = {}, { signal = null, waitReady = null } = {}) {
  const ms = waitMinutes(minutes, field) * 60_000;
  const t0 = Date.now();
  let c = await blockCheck(tab);
  if (!c) throw new BridgeError('cannot_check', '❌ 现在读不了这个页面（可能有网页对话框开着，先 answer_dialog），没法判断用户处理完没有。');
  const tabId = c.tabId, startUrl = c.url, first = c.blocked;
  const why = String(reason).trim().slice(0, 80);
  let ask = null, plainAlert = null, alertToken = null;
  if (first) alertToken = blockToken(await markBlocked(c, { newWait: true }));
  else if (field != null) {
    // A field only the user should fill: point at it in the page; their Return there ends the wait.
    if (!why) throw new BridgeError('bad_args', '❌ 带 field 时要写 reason：告诉用户在这个框里输入什么（例如「登录密码」「短信验证码」）。');
    // A job's takeover ends first: the keyboard is the user's, and putting their tabs back must not undo the select below.
    if (TASK_HOLD) await endTaskHold().catch(() => {});
    ask = await armAsk(tabId, field, why);
    await B.selectTab(tabId).catch(() => {});    // the tab its window shows; Chrome is not brought forward
    alertToken = ask.alertToken = randomUUID();
    BLOCKS.set(tabId, { kind: 'user', vendor: '', evidence: `在高亮的框里输入：${why}`, site: siteOf(startUrl), url: startUrl, since: Date.now(), toldAt: Date.now(), alertToken });
    writeTaskState();
    tellUser(/^en/i.test(process.env.CHROME_BRIDGE_LANG || '')
      ? `Needs you: type ${why} in the highlighted field (${siteOf(startUrl)}) and press Return; the AI carries on by itself.`
      : `需要你输入：${why}（${siteOf(startUrl)}）。在 Chrome 里高亮的框中输入，按回车后 AI 会自己接着做，不用回去找它。`);
  } else {
    if (!String(reason).trim()) return '现在页面上没有验证码或拦截，不需要等。若下一步只能由用户来做（登录、确认付款等），带上 reason 再调用。';
    alertToken = randomUUID();
    plainAlert = { kind: 'user', vendor: '', evidence: String(reason).trim().slice(0, 80), site: siteOf(startUrl), url: startUrl, since: Date.now(), toldAt: Date.now(), alertToken };
    BLOCKS.set(tabId, plainAlert);
    tellUser(`需要你处理：${String(reason).trim().slice(0, 80)}（${siteOf(startUrl)}）。AI 在等你，处理完它会接着做。`);
  }
  // A tab of mine handed to the user, and actually waited on: a takeover seen while waiting is at the agent's request.
  // `until` is set when the wait ends; a takeover seen after that (dragged away, viewed) wins again (src/ledger.js).
  const helped = await myEntry(tabId).catch(() => null) ? { since: t0, until: null } : null;
  if (helped) LEDGER.mark(tabId, { helped });
  try {
    // Finish the short setup before letting another call use this worker's
    // native lease. The read-only wait itself must remain concurrent so a new
    // alert can replace an older one without waiting for the older response.
    if (TASK_HOLD) await endTaskHold().catch(() => {});
    waitReady?.();
    return ask ? await waitForFieldLoop({ tabId, startUrl, field, why, ask, ms, t0, signal })
      : await waitForUserLoop({ tabId, startUrl, first, reason, ms, t0, signal, alertToken });
  } finally {
    if (ask && !ask.done) {
      await B.evalInPage(await B.pageScript('ask', { ASK: { disarm: ask.token } }), tabId, { lean: true }).catch(() => {});
      clearBlock(tabId, ask.alertToken);
    }
    // A wait on the agent's reason alone: the alert is its own and goes with it, run out or cancelled too
    // (2026-10-19: one said 需要你处理 in the menu bar for a day after its wait ran out). Not one put there since.
    if (plainAlert && BLOCKS.get(tabId) === plainAlert) { BLOCKS.delete(tabId); writeTaskState(); }
    const e = LEDGER.get(tabId), until = Date.now();
    if (helped && e && e.helped === helped) LEDGER.mark(tabId, { helped: { ...helped, until } });
    // Clicks made during the wait were at the agent's request: "the user is looking at it" needs one after it.
    await noteAgentDone(tabId, until).catch(() => {});
    // However the wait ended (also the user's Return followed into a pause: Codex r13 r3 A1), a pause ends the job's card.
    if (S.get('paused')) pauseCleanup();
  }
}

/** Highlight `field` (a read_page marker) in the tab with what to type; throws stale / no_such_marker / not_a_field. */
async function armAsk(tabId, field, why) {
  const text = /^en/i.test(process.env.CHROME_BRIDGE_LANG || '')
    ? { title: `Needs you: ${why}`, hint: 'Press Return when done; the AI carries on.', hintMulti: 'Press ⌘+Return when done; the AI carries on.', brand: 'MyChrome · the AI is waiting for you', tab: '[Input needed] ' }
    : { title: `需要你输入：${why}`, hint: '输入完按回车，AI 会接着做', hintMulti: '输入完按 ⌘+回车，AI 会接着做', brand: 'MyChrome · AI 在等你', tab: '【需要你输入】' };
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await B.evalInPage(await B.pageScript('ask', { ASK: { arm: token, marker: Number(field), text } }), tabId, { lean: true });
  return { token, kind: r.kind, password: !!r.password, done: false };
}

/**
 * Wait for the user's Return in the highlighted field (or its form's submit, a navigation, a reload,
 * the field leaving the page). The reply never repeats what they typed.
 */
async function waitForFieldLoop({ tabId, startUrl, field, why, ask, ms, t0, signal }) {
  const observer = await B.openNavigationObserver({ maxMs: ms + 10_000 }).catch(() => null);
  try { return await waitForFieldObserved({ tabId, startUrl, field, why, ask, ms, t0, signal }, observer); }
  finally { if (observer) await observer.close().catch(() => {}); }
}

async function waitForFieldObserved({ tabId, startUrl, field, why, ask, ms, t0, signal }, observer) {
  // `own`: the page went where the user's Return or submit (asked for by the agent) took it, so the
  // URL it settled on is the agent's, as after its own click: not a takeover (live run 2026-10-12).
  const done = async (text, url, own = false) => {
    ask.done = true;
    clearBlock(tabId, ask.alertToken);
    if (url && url !== startUrl) {
      if (own && !(signal && signal.aborted)) await noteAgentNavigation(tabId, url).catch(() => {});
      ledgerNavigated(tabId, url, { reported: true });
    }
    return text;
  };
  const secs = () => Math.round((Date.now() - t0) / 1000);
  const next = '先 read_page 看现在的页面，再接着做；不要在回复里复述用户输入的内容。';
  while (Date.now() - t0 < ms) {
    if (signal && signal.aborted) break;
    pausedCheck('（在等用户输入时）');
    await sleep(ASK_POLL_MS);
    pausedCheck('（在等用户输入时）');
    let r;
    try { r = await B.evalInPage(await B.pageScript('ask', { ASK: { read: ask.token } }), tabId, { lean: true }); }
    catch (e) {
      if (e && e.code === 'no_such_tab') return notDone('tab_gone', await done(`❌ 这个标签已经不在了（被关掉或移走），用户没在 [${field}] 输入完。list_tabs 看看现在的标签。`));
      continue;   // a dialog open, the page busy: ask again
    }
    const url = (r.target && r.target.url) || '';
    const moved = url && url !== startUrl ? `，页面已经变了（${siteOf(url)}）` : '';
    // The URL the page lands on is the agent's only after the user's Return or submit (`t`: when the page saw it),
    // with no later keyboard/mouse input routed to that window, the wait not cancelled, and a complete
    // native observation. Typing in another app is unrelated; missing evidence never grants ownership.
    const cancelled = () => !!(signal && signal.aborted);
    const ownSince = async (t) => {
      if (cancelled() || !Number.isFinite(t) || t < t0 - 1000 || t > Date.now()) return false;   // a time the page made up
      if (!observer) return false;
      const target = await B.chromeInfo(tabId).catch(() => null);
      const untouched = target && await observer.untouched(target, t).catch(() => false);
      return !cancelled() && !!untouched;
    };
    if (r.entered) {
      const how = r.entered.how === 'submit' ? '提交了表单' : '输入完按了回车';
      const s = secs(), at = Number(r.entered.at);
      const to = (await followSubmit(tabId, url || startUrl, signal)) || url;
      const went = to && to !== startUrl ? `，页面已经变了（${siteOf(to)}）` : '';
      return done(`✅ 用户在 [${field}] ${how}${r.entered.filled ? '' : '（框是空的）'}，等了 ${s} 秒${went}。${next}`, to, await ownSince(at));
    }
    if (!r.armed || r.reloaded) {
      const s = secs(), to = moved ? await settledUrl(tabId, url, 3000, signal, { stopOnPause: true }) : url;
      // The page moved on before the agent looked: r.carried is the Return / submit the old page saw (same origin only).
      const c = r.carried;
      if (c && moved) return done(`✅ 用户在 [${field}] ${c.how === 'submit' ? '提交了表单' : '输入完按了回车'}，页面已经跳转（${siteOf(to)}），等了 ${s} 秒。${next}`, to, await ownSince(c.at));
      return done(`✅ ${moved ? `页面已经跳转（${siteOf(to)}），用户应该已经提交了` : '页面重新加载了（用户可能已经提交）'}，等了 ${s} 秒。${next}`, to);
    }
    // Gone without a Return: the page moved on, or re-drew the field in a way it cannot be followed.
    if (!r.connected) return notDone('field_gone', await done(`⚠️ [${field}] 这个框不在页面上了${moved}，用户没有在里面按回车（等了 ${secs()} 秒）。先 read_page：页面已经往下走了就接着做；那个框还在、用户还没填完，就再调用 wait_for_user。`, url));
  }
  return notDone(signal && signal.aborted ? 'cancelled' : 'wait_timeout', `⏳ 等了 ${Math.round((Date.now() - t0) / 60_000 * 10) / 10} 分钟，用户还没在 [${field}] 输入完（${why}）。高亮已撤掉。用户可能暂时不在电脑前：直接再调用 wait_for_user（同样的 field 和 reason），高亮会重新出现；不要改到对话里向用户要这项内容。只有用户说过不用等，才结束任务并告诉用户卡在哪里。`);
}

/** The page's navigation after the user's Return, followed until it settles (null: none within SUBMIT_FOLLOW_MS). */
async function followSubmit(tabId, from, signal = null) {
  const deadline = Date.now() + SUBMIT_FOLLOW_MS;
  // Paused meanwhile: stop following (the user's Return is reported as it is; nothing more is read).
  while (Date.now() < deadline && !(signal && signal.aborted) && !S.get('paused')) {
    await sleep(Math.min(300, ASK_POLL_MS));
    if (S.get('paused')) return null;
    let url;
    try { url = (await B.chromeInfo(tabId)).url; } catch { return null; }
    if (url && url !== 'about:blank' && url !== from) return settledUrl(tabId, url, 3000, signal, { stopOnPause: true });
  }
  return null;
}

async function waitForUserLoop({ tabId, startUrl, first, reason, ms, t0, signal, alertToken }) {
  let c;
  writeTaskState();
  while (Date.now() - t0 < ms) {
    if (signal && signal.aborted) break;
    pausedCheck('（在等用户处理时）');
    await sleep(WAIT_POLL_MS);
    pausedCheck('（在等用户处理时）');
    c = await blockCheck(tabId);
    if (!c) continue;
    const gone = first ? !c.blocked : (c.url && c.url !== startUrl && !c.blocked);
    if (gone) {
      clearBlock(tabId, alertToken);
      // This reply says the page changed and to read it first.
      if (c.url) ledgerNavigated(tabId, c.url, { reported: true });
      const s = Math.round((Date.now() - t0) / 1000);
      return `✅ ${first ? '验证/拦截已经没有了' : `页面已经变了（${siteOf(c.url)}）`}，等了 ${s} 秒。先 read_page 看现在的页面，再接着做。`;
    }
  }
  const still = first ? blockText(BLOCKS.get(tabId) || { ...first }) : String(reason).trim();
  return notDone(signal && signal.aborted ? 'cancelled' : 'wait_timeout', `⏳ 等了 ${Math.round((Date.now() - t0) / 60_000 * 10) / 10} 分钟，用户还没处理（${still}）。可以再调用 wait_for_user 继续等，或者结束任务并告诉用户卡在哪里。不要自己去点验证码。`);
}

/** Several failures in a row: the agent may be stuck; the user hears about it (at most every 5 minutes). */
const STUCK = { n: 0, last: '', toldAt: 0, since: 0 };
const STUCK_AFTER = 3;
function noteOutcome(ok, e = null) {
  if (ok) { if (STUCK.n >= STUCK_AFTER) { STUCK.n = 0; writeTaskState(); } STUCK.n = 0; return; }
  if (e && e.code === 'site_blocked') return;   // told already, with its own words
  if (STUCK.n === 0) STUCK.since = Date.now();
  STUCK.n++;
  STUCK.last = String((e && e.message) || e || '').split('\n')[0].replace(/^❌\s*/, '').slice(0, 60);
  if (STUCK.n >= STUCK_AFTER) {
    if (Date.now() - STUCK.toldAt > TELL_EVERY_MS) {
      STUCK.toldAt = Date.now();
      tellUser(`AI 好像卡住了：连续 ${STUCK.n} 次没做成（最近一次：${STUCK.last}）。方便的话看一眼 Chrome。`);
    }
    writeTaskState();
  }
}
export function __stuckForTests() { return STUCK; }
/** Held while the action works; released after this long with nothing running (default 10 s) or after the max (default 10 min). */
const TAKEOVER_LIMITS = Object.fromEntries(Object.entries({
  takeoverIdleMs: Number(process.env.CHROME_BRIDGE_TAKEOVER_IDLE_MS),
  takeoverMaxMs: Number(process.env.CHROME_BRIDGE_TAKEOVER_MAX_MS)
}).filter(([, v]) => v > 0));
export function __setTakeoverForTests(on) { TAKEOVER = !!on; }

/**
 * Wait until the user's hands have been off for userIdleS(). Only meaningful
 * before we post anything: our own events reset the same counter (F18).
 */
async function waitForUserIdle({ idleS = userIdleS(), maxWaitMs = USER_IDLE_MAX_WAIT_MS, signal = null, proceed = false } = {}) {
  if (!(idleS > 0)) return 0;
  const t0 = Date.now();
  for (;;) {
    if (signal && signal.aborted) throw cancelledError();
    let idle = Infinity;
    try { idle = (await B.cgevent(['idle'])).idle; } catch { return 0; }
    if (idle >= idleS) return Date.now() - t0;
    if (Date.now() - t0 > maxWaitMs) {
      if (proceed) return Date.now() - t0;
      throw new BridgeError('user_busy',
        `⏸ 你一直在用键盘鼠标（${Math.round(maxWaitMs / 1000)} 秒内没有停过 ${idleS} 秒），` +
        '为了不跟你抢，这次没有操作。稍后重试即可。');
    }
    await sleep(Math.max(150, (idleS - idle) * 1000));
  }
}

/** When a session of this process last posted a key or mouse button (epoch ms, the helper's end reply):
 * key events up to then are our own, not the user's typing. */
let OWN_INPUT_END = 0;
/** The input session, noting on close when it last posted a key or button (waitForHandsOff). */
async function openOwnSession() {
  conversationInputCheck();
  const s = watchQueue(await B.openInputSession());
  const request = s.request.bind(s);
  s.request = async (req, opts) => {
    if (['hold', 'begin', 'click', 'move', 'wheel', 'type', 'key', 'paste'].includes(req.op)) conversationInputCheck();
    return request(req, opts);
  };
  const close = s.close.bind(s);
  s.close = async (...a) => {
    const end = await close(...a);
    if (end && Number.isFinite(end.lastPostedAt)) OWN_INPUT_END = Math.max(OWN_INPUT_END, end.lastPostedAt);
    return end;
  };
  return s;
}
/** A key physically down, with no key or button event for this long: its release was lost (a screen lock,
 * a KVM switch). Not for modifiers and fn, nor mouse buttons: those are held for long without repeating
 * (Shift while selecting, a slow drag) and are waited for (Codex r12 r2 A1). */
const STUCK_KEY_S = 30;
const NO_REPEAT = /^(左|右) (⌘|⇧|⌥|⌃)$|^fn$|^鼠标/;
export function __ownInputEndForTests() { return OWN_INPUT_END; }

/**
 * Takeover: wait until the user is done typing or clicking — no key or mouse button physically
 * down, and none pressed or released for idleS — before holding their input (a hold drops what
 * they type, and a release it swallows leaves the key stuck for their app). Moving the pointer
 * does not count: it is frozen and put back. Key events no later than our own last session are
 * ours (F18) and are not waited out.
 */
async function waitForHandsOff({ idleS = userIdleS(), maxWaitMs = USER_IDLE_MAX_WAIT_MS, signal = null } = {}) {
  if (!(idleS > 0)) return 0;
  const t0 = Date.now();
  let firstHeld = null;
  for (;;) {
    if (signal && signal.aborted) throw cancelledError();
    let r;
    try { r = await B.cgevent(['idle']); } catch { return Date.now() - t0; }
    if (typeof r.keyIdle !== 'number') return Date.now() - t0;
    const held = Array.isArray(r.held) ? r.held : [];
    if (firstHeld == null) firstHeld = held.join('、');
    const keyAt = Number.isFinite(r.keyAt) ? r.keyAt : Date.now() - r.keyIdle * 1000;
    const ours = OWN_INPUT_END > 0 && keyAt <= OWN_INPUT_END + 20;
    if (!held.length && (r.keyIdle >= idleS || ours)) return Date.now() - t0;
    // Also a modifier or fn that read as down for this whole round with no key event at all (Fable r12 r3 B2:
    // nobody holds Shift for a minute without pressing anything). Not mouse buttons: a slow drag.
    const stale = held.length && !held.some(h => h.startsWith('鼠标')) && held.join('、') === firstHeld &&
      Date.now() - t0 > maxWaitMs && r.keyIdle * 1000 >= maxWaitMs;
    if (held.length && (stale || (r.keyIdle >= STUCK_KEY_S && !held.some(h => NO_REPEAT.test(h))))) {
      throw new BridgeError('input_stuck', `⏸ 系统显示「${held.join('、')}」一直按着，但 ${Math.round(r.keyIdle)} 秒没有任何按键动静：` +
        '多半是它松开的信号丢了（锁屏、切换 KVM 时会这样），接管会一直等不到它松开，所以没有操作。' +
        '\n给 agent：请用户按一下这个键再松开，然后重试；没有发出任何输入。');
    }
    if (Date.now() - t0 > maxWaitMs) {
      throw new BridgeError('user_busy', held.length
        ? `⏸ 「${held.join('、')}」一直按着（${Math.round(maxWaitMs / 1000)} 秒），为了不吞掉它的松开，这次没有操作。稍后重试即可。`
        : `⏸ 你一直在打字或点击（${Math.round(maxWaitMs / 1000)} 秒内没有停过 ${idleS} 秒），为了不跟你抢，这次没有操作。稍后重试即可。`);
    }
    await sleep(held.length ? 100 : Math.max(100, (idleS - r.keyIdle) * 1000));
  }
}

const cancelledError = () => new BridgeError('cancelled', '❌ 调用已被取消，没有操作。');

/**
 * Whether a failed session request posted nothing the page could act on,
 * from the helper's own record: a held button or key is released (and
 * listed) on the way out, `typed`/`sent` count what went out, and the
 * clipboard is put back at once only when V never went down.
 */
function postedNothing(op, e) {
  const r = e && e.reply;
  // The helper counts every key-down, button-down and wheel event it posted in
  // this request; only an explicit zero counts as nothing posted.
  return !!r && r.postedInput === 0;
}

/** Post input the page may act on, recording it for the retry decision (persist). */
async function post(s, ctx, kind, req, ro) {
  conversationInputCheck();
  const context = CALL.getStore(), started = context?.routineInputStarted === true;
  await context?.routineGuard?.();
  context?.routineCheck?.();
  if (context?.routineGuard) context.routineInputStarted = true;
  ctx.sent(kind);
  try {
    return await s.request(req, ro);
  } catch (e) {
    if (postedNothing(req.op, e)) {
      ctx.unsent(kind);
      if (context?.routineGuard) context.routineInputStarted = started;
    }
    throw e;
  }
}

/**
 * Did any HID input happen after t0? Valid only while nothing of ours has
 * been posted (activation and window ordering post no input events).
 */
async function userActedSince(t0) {
  if (!(userIdleS() > 0)) return false;
  let idle;
  try { idle = (await B.cgevent(['idle'])).idle; } catch { return false; }
  return idle * 1000 < Date.now() - t0 - 50;
}

/**
 * Did a mouse button go down after t0 (epoch ms)? Used after the session has
 * closed, when nothing of ours is posted any more. Unknown stays unknown;
 * ownership observations keep the tab without marking it as the user's.
 */
async function userClickedSince(t0) {
  return clickedSince(B.cgevent, t0);
}

const boundsRect = (b) => ({ x: b.left, y: b.top, w: b.width, h: b.height });

/**
 * What the takeover veil shows (helper `hold` → veil): the subline in both languages (the helper
 * picks by the system language and middle-truncates it to one line), the Chrome window as the
 * hole when the pre-check knows it (else `begin` opens it), and the target point. Never the text
 * being typed.
 */
function veilLabel(kind, text = '', field = null) {
  const short = (x) => { let t = String(x || '').replace(/\s+/g, ' ').trim(); return t.length > 120 ? `${t.slice(0, 60)}…${t.slice(-59)}` : t; };
  // A form field is named by its label or placeholder, never by its value (it may be a password).
  const f = field ? short(field.name) : '';
  const t = field ? '' : short(text);
  if (kind === 'click') {
    if (field) return f ? { zh: `正在点击输入框「${f}」`, en: `Clicking the field "${f}"` } : { zh: '正在点击输入框', en: 'Clicking a field' };
    return t ? { zh: `正在点击「${t}」`, en: `Clicking "${t}"` } : { zh: '正在点击', en: 'Clicking' };
  }
  if (kind === 'type') return f && !sensitiveField(field) ? { zh: `正在输入到「${f}」`, en: `Typing into "${f}"` } : { zh: '正在输入', en: 'Typing' };
  if (kind === 'select') { const o = short(text); return o ? { zh: `正在选择「${o}」`, en: `Choosing "${o}"` } : { zh: '正在选择', en: 'Choosing' }; }
  if (kind === 'screenshot') return { zh: '正在看页面（截图）', en: 'Looking at the page' };
  if (kind === 'key') return { zh: '正在按键', en: 'Pressing a key' };
  if (kind === 'hover') return t ? { zh: `正在把光标移到「${t}」上`, en: `Hovering over "${t}"` } : { zh: '正在移动光标', en: 'Hovering' };
  return { zh: '正在滚动', en: 'Scrolling' };
}

/** Password, one-time code, card number…: the panel shows neither the text nor how long it is. */
function sensitiveField(field) {
  if (!field) return false;
  return /password/.test(field.type || '') ||
    /password|one-time-code|cc-|csc/.test(field.autocomplete || '') ||
    /密码|验证码|口令|password|passcode|one.?time|otp|\bpin\b|security code|cvv|cvc/i.test(field.name || '');
}

/** Who is at work, for the panel: client · project directory, and a colour kept for this session. */
let IDENTITY = null, IDENTITY_KEY = null, CLIENT_EXECUTABLE = null;
function agentIdentity() {
  let clientName = '';
  try { clientName = server.getClientVersion()?.name || ''; } catch {}
  const env = String(process.env.CHROME_BRIDGE_AGENT_NAME || '').trim();
  const key = `${clientName}\0${env}`;
  if (IDENTITY && IDENTITY_KEY === key) return IDENTITY;
  // The program that started MyChrome (under the hot-swap launcher: the launcher's parent).
  const clientPid = Number(process.env.CHROME_BRIDGE_CLIENT_PID) || process.ppid;
  if (!clientName && CLIENT_EXECUTABLE == null) {
    try {
      CLIENT_EXECUTABLE = execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(clientPid)],
        { encoding: 'utf8', timeout: 1000 }).trim();
    } catch { CLIENT_EXECUTABLE = ''; }
  }
  const client = clientDisplayName(clientName, CLIENT_EXECUTABLE);
  const cwd = process.cwd();
  const dir = cwd === os.homedir() || cwd === '/' ? null : path.basename(cwd);
  let h = 7;
  for (const c of `${clientPid}:${cwd}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  IDENTITY_KEY = key;
  IDENTITY = {
    who: env || (dir ? `${client} · ${dir}` : { zh: `${client} · 主目录`, en: `${client} · home folder` }),
    color: h % 6
  };
  return IDENTITY;
}

/** Only host-originated, user-visible assistant messages enter this in-memory feed. */
let VISIBLE_FEED = null;
let VISIBLE_FEED_THREAD = null;
let VISIBLE_FEED_REASON = null;
let VISIBLE_FEED_SOURCE = null;
let FEED_PUSH = null;
let FEED_GENERATION = 0;
function feedSnapshot() {
  const s = VISIBLE_FEED?.snapshot() ?? { entries: [], status: 'unavailable' };
  return { feedMode: true, feedEntries: s.entries.map(x => x.text), feedStatus: s.status,
    feedReason: s.reason || VISIBLE_FEED_REASON, feedSource: VISIBLE_FEED_SOURCE };
}
function scheduleFeedPush() {
  if (FEED_PUSH) return;
  FEED_PUSH = setTimeout(() => {
    FEED_PUSH = null;
    const th = TASK_HOLD;
    if (!th || !PLAN) return;
    th.kept.session.request({ op: 'panel', ...feedSnapshot() }, { raw: true }).catch(() => {});
  }, 80);
  FEED_PUSH.unref?.();
}
async function connectTaskFeed(threadId, { sameTask = false } = {}) {
  const provider = bindGuiThread(threadId);
  const gui = GUI_SERVICE?.visibleFeedSnapshot?.();
  const explicit = typeof threadId === 'string' && threadId.length > 0;
  const retained = sameTask && VISIBLE_FEED_THREAD;
  const fromGui = gui?.provider === 'Codex' && gui.verified
    && ['manual', 'carry'].includes(gui.origin) && gui.threadId;
  const id = provider === 'Codex' ? (explicit ? threadId : retained || fromGui
    || process.env.MYCHROME_VISIBLE_THREAD_ID || process.env.CODEX_THREAD_ID) : null;
  const conflict = !!id && gui?.provider === 'Codex' && !!gui.threadId && gui.threadId !== id;
  VISIBLE_FEED_SOURCE = !id ? null : explicit ? 'task' : retained ? VISIBLE_FEED_SOURCE : fromGui ? 'gui' : 'environment';
  VISIBLE_FEED_REASON = provider !== 'Codex' ? 'unsupported_client' : !id ? 'unbound_thread'
    : conflict ? 'binding_conflict' : null;
  if (VISIBLE_FEED && VISIBLE_FEED_THREAD === id &&
      ['connected', 'connecting'].includes(VISIBLE_FEED.snapshot().status)) return;
  const generation = ++FEED_GENERATION;
  VISIBLE_FEED?.close();
  VISIBLE_FEED = null;
  VISIBLE_FEED_THREAD = id ?? null;
  if (!id) { scheduleFeedPush(); return; }
  if (GUI_SERVICE && gui?.provider === 'Codex' && gui.threadId === id) {
    // The task pins its source. A later GUI selection must never become this task's prose.
    let last = { entries: [], status: 'connecting', reason: null };
    let unsubscribe = () => {}, detaching = false;
    unsubscribe = GUI_SERVICE.subscribeVisibleFeed(state => {
      if (state.provider === 'Codex' && state.threadId === id) {
        last = { entries: state.entries, status: state.status, reason: state.status === 'connected' ? null : state.reason };
      } else if (!detaching) {
        detaching = true;
        let stillCodex = false;
        try { stillCodex = clientDisplayName(server.getClientVersion()?.name || '') === 'Codex'; } catch {}
        last = { ...last, status: stillCodex ? 'connecting' : 'unavailable',
          reason: stillCodex ? 'reconnecting' : 'unsupported_client' };
        VISIBLE_FEED_REASON = stillCodex ? 'binding_conflict' : 'unsupported_client';
        // The GUI is free to browse another conversation. Retain this task's
        // exact source and already-observed prose without changing the GUI back.
        queueMicrotask(() => {
          unsubscribe();
          if (stillCodex && generation === FEED_GENERATION) connectIndependentTaskFeed(id, generation, last.entries);
        });
      }
      scheduleFeedPush();
    });
    VISIBLE_FEED = { snapshot: () => last, close: unsubscribe };
    scheduleFeedPush();
    return;
  }
  await connectIndependentTaskFeed(id, generation);
}
async function connectIndependentTaskFeed(id, generation, previousEntries = []) {
  try {
    const { connectVisibleFeed } = await import('./visible-feed-host.js');
    if (generation !== FEED_GENERATION) return;
    const feed = await connectVisibleFeed({ threadId: id, onChange: scheduleFeedPush });
    if (generation !== FEED_GENERATION) { feed.close(); return; }
    let retainedEntries = previousEntries;
    VISIBLE_FEED = {
      close: () => feed.close(),
      snapshot() {
        const state = feed.snapshot();
        if (state.resetRevision > 0) retainedEntries = [];
        const keys = new Set(state.entries.map(entry => `${entry.turnId}:${entry.id}`));
        return { ...state, entries: [...retainedEntries.filter(entry => !keys.has(`${entry.turnId}:${entry.id}`)),
          ...state.entries].slice(-80) };
      },
    };
    scheduleFeedPush();
  } catch {
    if (generation !== FEED_GENERATION) return;
    VISIBLE_FEED_REASON = 'host_unavailable';
    VISIBLE_FEED = { snapshot: () => ({ entries: previousEntries, status: 'unavailable' }), close() {} };
    scheduleFeedPush();
  }
}
function taskFeedMessage() {
  const feed = feedSnapshot();
  if (feed.feedReason === 'binding_conflict') return '侧栏固定为本次任务的对话；GUI 当前选择了另一对话，不会混入它的文字。';
  if (feed.feedReason === 'unsupported_client') return '当前客户端没有已验证的可见文字接口，侧栏进度流不可用。';
  if (feed.feedReason === 'unbound_thread') return '尚未绑定具体对话，侧栏进度流未连接；请关联当前对话或提供 conversation_id。';
  if (feed.feedStatus === 'connected') return '侧栏已连接当前对话，只展示接入后已有的可见自然语言。';
  if (feed.feedStatus === 'connecting') return '侧栏进度流正在连接，接入后才会显示当前对话的新可见文字。';
  return '侧栏进度流未连接，当前没有可显示的实时文字；不会生成替代进度。';
}
function closeTaskFeed() {
  FEED_GENERATION++;
  clearTimeout(FEED_PUSH);
  FEED_PUSH = null;
  VISIBLE_FEED?.close();
  VISIBLE_FEED = null;
  VISIBLE_FEED_THREAD = null;
  VISIBLE_FEED_REASON = null;
  VISIBLE_FEED_SOURCE = null;
}

/** The task named by `task` on an earlier call of this session stays on the panel this long. */
const PANEL_TASK_KEEP_MS = 10 * 60 * 1000;
let PANEL_TASK = { text: '', at: 0 };

/** Does `task` repeat a piece (6 characters, or all of a shorter text) of what is being typed? */
function echoesTyped(task, typed) {
  const t = String(task).toLowerCase(), x = [...String(typed || '').toLowerCase()];
  if (x.length < 2) return false;
  const n = Math.min(6, x.length);
  for (let i = 0; i + n <= x.length; i++) if (t.includes(x.slice(i, i + n).join(''))) return true;
  return false;
}

function panelTask(args) {
  const given = typeof args.task === 'string' ? args.task.replace(/\s+/g, ' ').trim() : '';
  if (given) PANEL_TASK = { text: given.length > 40 ? given.slice(0, 39) + '…' : given, at: Date.now() };
  else if (Date.now() - PANEL_TASK.at > PANEL_TASK_KEEP_MS) PANEL_TASK = { text: '', at: 0 };
  else PANEL_TASK.at = Date.now();
  // A task that repeats what is being typed is dropped, also for the later calls (it would show then).
  if (PANEL_TASK.text && echoesTyped(PANEL_TASK.text, args.text)) PANEL_TASK = { text: '', at: 0 };
  return PANEL_TASK.text;
}

function panelStep(step) {
  const m = /^(\d{1,3})\/(\d{1,3})$/.exec(String(step || ''));
  return m && +m[1] >= 1 && +m[1] <= +m[2] ? `${+m[1]}/${+m[2]}` : '';
}

/**
 * The checklist for one action: the stages the session goes through, in order, with a rough
 * time at 1× (the helper replaces it with the real plan when the stage starts; `paced` stages
 * follow ↑/↓). Keys match the helper's own transitions (helper.swift PanelModel).
 */
function panelStages(kind, { marker = null, chars = 0, perChar = false, submit = false, amount = 1 } = {}) {
  const L = (zh, en) => ({ zh, en });
  const st = [{ key: 'hold', label: L('接管键盘鼠标', 'Hold keyboard and mouse'), est: 150 }];
  if (kind !== 'scroll') st.push({ key: 'focus', label: L('把网页切到前面', 'Bring the page forward'), est: 300 });
  if (kind === 'click' || (kind === 'type' && marker != null)) {
    st.push({ key: 'move', label: kind === 'click' ? L('移动鼠标到目标', 'Move to the target') : L('移动鼠标到输入框', 'Move to the field'), est: 700, paced: true });
    st.push({ key: 'press', label: kind === 'click' ? L('点击', 'Click') : L('点一下输入框', 'Click the field'), est: 150, paced: true });
  }
  if (kind === 'type') {
    st.push({ key: 'type', label: perChar ? L(`逐键输入 ${chars} 个字`, `Type ${chars} characters`) : L('输入文字', 'Enter the text'),
      est: perChar ? chars * 260 : 1500, paced: true });
    st.push({ key: 'confirm', label: L('确认输入框里有了', 'Check the field'), est: 300 });
    if (submit) st.push({ key: 'submit', label: L('按回车', 'Press Return'), est: 500, paced: true });
  }
  if (kind === 'hover') st.push({ key: 'move', label: L('移动鼠标到目标（不点击）', 'Move onto the target (no click)'), est: 700, paced: true });
  if (kind === 'key') st.push({ key: 'type', label: L('按键', 'Press the key'), est: 500, paced: true });
  if (kind === 'screenshot') st.push({ key: 'confirm', label: L('截图', 'Take the picture'), est: 400 });
  if (kind === 'select') {
    st.push({ key: 'type', label: L('用键盘选中选项', 'Pick the option with the keyboard'), est: 900, paced: true });
    st.push({ key: 'confirm', label: L('确认下拉框显示了它', 'Check the dropdown shows it'), est: 300 });
  }
  if (kind === 'scroll') {
    st.push({ key: 'move', label: L('光标移到页面上', 'Move onto the page'), est: 600, paced: true });
    st.push({ key: 'wheel', label: L('滚动', 'Scroll'), est: Math.round(1200 * Math.min(20, Math.max(0.1, amount))), paced: true });
  }
  st.push({ key: 'restore', label: L('还原你的窗口和光标', 'Put your windows and pointer back'), est: 250 });
  return st;
}

/**
 * What the takeover veil shows (helper `hold` → veil): the subline, the Chrome window as the
 * hole when the pre-check knows it (else `begin` opens it), the target point, and the progress
 * panel (who, task, step, the checklist; text length only for fields that are not sensitive).
 */
function veilFor(kind, pre, rect = null, args = {}) {
  const loc = pre && pre.loc;
  const field = loc && loc.field && loc.field.type ? loc.field : null;
  const v = { label: veilLabel(kind, kind === 'select' ? args.option : loc ? loc.text : '', kind === 'select' ? null : field) };
  const r = rect || (pre && pre.session && pre.session.windowBounds);
  if (r) v.rect = r;
  try {
    if (loc && loc.aim) {
      const p = toScreen(loc.aim, originFor(loc));
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) v.point = { x: p.x, y: p.y };
    }
  } catch {}
  const text = kind === 'type' ? String(args.text || '') : '';
  // How long the text is, only for a field known not to be sensitive: a field seen before the
  // hold (marker) that is no password, code or card field. Otherwise no count, no length in the
  // row's label, and a fixed time estimate (the time left would give the length away).
  const known = kind === 'type' && !!field && !sensitiveField(field);
  const chars = known ? [...text.replace(/\r\n/g, '\n')].length : 0;
  const perChar = known && args.input_mode === 'keys' && typingSegments(text, 'keys').some(x => x.mode === 'type');
  const id = agentIdentity();
  if (PLAN && taskKey(args) === PLAN.task) {
    v.panel = { who: id.who, color: id.color, task: PLAN.task, step: '', action: v.label,
      stages: [], chars: 0, perChar: false, showCount: false, elapsedMs: Date.now() - PLAN.t0,
      ...feedSnapshot() };
    return v;
  }
  v.panel = {
    who: id.who, color: id.color, task: panelTask(args), step: panelStep(args.step), action: v.label,
    stages: panelStages(kind, { marker: args.marker ?? null, chars, perChar, submit: !!args.submit, amount: Number(args.amount) || 1 }),
    chars, perChar, showCount: known
  };
  return v;
}

/** The note for an action after which the user took over while things were being put back. */
const LATE_USER_NOTE = (sceneRestored, appRestored = null) => sceneRestored
  ? '\n（还原的过程中你动了键盘鼠标：前台 App 已切回，光标没有拉回原处）'
  : appRestored
    ? '\n（还原之前你动了键盘鼠标：只把前台切回了你原来用的 App，光标和 Chrome 窗口没有动）'
    : '\n（还原之前你动了键盘鼠标：没有把光标和前台窗口拉回原处）';

/** CHROME_BRIDGE_DEBUG_LOG=<file>: one JSON line per input action (outcome, hold, why it ended). */
function debugLog(rec) {
  const p = process.env.CHROME_BRIDGE_DEBUG_LOG;
  if (!p) return;
  try { appendFileSync(p, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...rec }) + '\n'); } catch {}
}

/* ------------------------------------------------- task state (menu bar) */

/** This server's task in progress, for the menu-bar item (src/menubar.swift): one file per server. */
const TASK_STATE_FILE = path.join(path.dirname(LOCK_DIR), 'tasks', `${process.pid}.json`);
function writeAtomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
function writeTaskState() {
  const [blockedTab, blocked] = [...BLOCKS.entries()][0] || [null, null];
  const stuck = STUCK.n >= STUCK_AFTER ? { count: STUCK.n, last: STUCK.last, since: STUCK.since } : null;
  const task = PLAN ? PLAN.task : TASK_HOLD ? TASK_HOLD.task : (blocked || stuck) ? (PANEL_TASK.text || (blocked ? `在 ${blocked.site} 上做事` : 'AI 任务')) : null;
  try {
    if (!task) { rmSync(TASK_STATE_FILE, { force: true }); return; }
    const id = agentIdentity();
    const who = typeof id.who === 'string' ? id.who : id.who.zh;
    writeAtomicJson(TASK_STATE_FILE, { pid: process.pid, sessionGeneration: SESSION_GENERATION, who, color: id.color, task,
      step: '', current: null, total: null, stepName: null, etaMs: null, etaAt: Date.now(), since: PLAN ? PLAN.t0 : Date.now(),
      // What the user must do now, in plain words (the menu-bar panel shows it in red).
      alert: PLAN?.interrupted ? `任务未完成，接管已暂停：${PLAN.interrupted.reason}` : blocked ? `需要你处理：${blocked.site} ${blockText(blocked)}` : stuck ? `AI 好像卡住了：连续 ${stuck.count} 次没做成` : null,
      alertSince: blocked ? blocked.since : stuck ? stuck.since : null,
      // The tab the user is asked to come to: the panel's 「带我去」 sends it back (onGotoRequest).
      alertTab: blocked ? blockedTab : null, alertToken: blockToken(blocked) });
  } catch {}
}

/* ------------------------------------------------- presence and activity (menu bar) */

/**
 * The panel's 「AI 会话」 list and 「记录」 page: this server's presence file (who, version, busy or not;
 * removed when it exits) and one activity line per tool call (src/settings.js). Only the server
 * itself writes them; modules that import this file (tests) do not, unless a test asks.
 */
let RECORD = false;
let GUI_SERVICE = null, GUI_POLL = null, GUI_THREAD = null, GUI_RESTORE = null;
function bindGuiThread(threadId) {
  if (typeof threadId === 'string') GUI_THREAD = threadId;
  let clientName = '';
  try { clientName = server.getClientVersion()?.name || ''; } catch {}
  // A child CLI can inherit its parent's CODEX_THREAD_ID; only a verified Codex client may use it.
  const provider = clientName ? clientDisplayName(clientName) : null;
  GUI_SERVICE?.bind(GUI_THREAD || process.env.MYCHROME_VISIBLE_THREAD_ID || process.env.CODEX_THREAD_ID, provider);
  return provider;
}
async function startGuiIntegration() {
  try {
    GUI_SERVICE = await startConversationService({ base: path.dirname(LOCK_DIR), restoreBinding: GUI_RESTORE,
      routines: payload => ROUTINES.query(payload),
      onPresence: fields => {
        if (RECORD) S.writePresence(LOCK_DIR, fields);
        if (fields.conversationPending > 0) suspendForConversationReply().catch(() => {});
      } });
    GUI_RESTORE = null;
    bindGuiThread();
    GUI_POLL = setInterval(() => bindGuiThread(), 2000);
    GUI_POLL.unref();
  } catch { /* Browser control still works if the optional conversation adapter cannot start. */ }
}
export function __recordForTests(on) { RECORD = !!on; }
function presenceStart() {
  RECORD = true;
  const id = agentIdentity();
  let script = process.argv[1] || '', root = ROOT;
  try { script = realpathSync(script); } catch {}
  try { root = realpathSync(ROOT); } catch {}
  let srcHash = null;
  try { srcHash = S.sourceFingerprint(ROOT); } catch {}
  S.writePresence(LOCK_DIR, { version: VERSION, srcHash, startedAt: Date.now(), sessionGeneration: SESSION_GENERATION, who: typeof id.who === 'string' ? id.who : id.who.zh, color: id.color,
    node: process.execPath, script, root, envLocked: S.envLocked(), busy: null,
    // Under the hot-swap launcher (that process is part of this session, not an old server): updates itself.
    launcher: OWNER_PID !== process.pid ? OWNER_PID : null });
  // The setup check runs here, in this session's own app (its permissions are the ones that count: Codex r13 A6);
  // again when the panel asks (it writes <cache>/check-request), one session per app answering.
  setTimeout(() => selfCheck({ startup: true }), 3000).unref();
  watchCheckRequests();
  startGuiIntegration();
}

const CHECK_REQ = path.join(path.dirname(LOCK_DIR), 'check-request');
const CHECK = { at: 0, app: null, running: false, timer: null, again: false };
/** The app this session runs in (its permissions are the ones that count), from `cgevent trust`: no Chrome involved. */
async function checkApp() {
  if (!CHECK.app) { try { CHECK.app = (await B.cgevent(['trust'])).responsible.name || null; } catch {} }
  return CHECK.app;
}
/**
 * startup: skipped when another session of the same app checked in the last 10 minutes (its result stands for
 * this one: the panel groups by app), so opening sessions does not run the front-tab test each time (Fable r13 r3 B2).
 */
/** Another session's check of this app stands for this one too: keep a copy (it outlives that session: Codex r13 r4 A1). */
export function __selfCheckForTests(o) { return selfCheck(o); }
function adoptCheck(c) {
  CHECK.at = c.at;
  S.writePresence(LOCK_DIR, { checks: c });
}
async function selfCheck({ startup = false } = {}) {
  // Paused: nothing touches Chrome, the check neither (Codex r13 r2 B2); the panel asks again on resume.
  if (S.get('paused')) return;
  // A request while a check runs is answered by one more run after it (Fable r13 r4 B4).
  if (CHECK.running) { if (!startup) CHECK.again = true; return; }
  CHECK.running = true;
  try {
    const app = await checkApp();
    const recent = startup && app ? S.freshCheckFor(LOCK_DIR, app, Date.now() - 10 * 60_000) : null;
    if (recent) { adoptCheck(recent); return; }
    const { runChecks } = await import('./doctor.js');
    // A pause that comes while it runs stops the front-tab test (Codex r13 r3 B3).
    const r = await runChecks({ probe: 'needed', paused: () => S.get('paused') });
    CHECK.at = Date.now();
    CHECK.app = r.app || null;
    S.writePresence(LOCK_DIR, { checks: { at: CHECK.at, app: CHECK.app, ok: !!r.ok, items: r.checks.map(c => ({ id: c.id, title: c.title,
      required: !!c.required, ok: !!c.ok, skipped: !!c.skipped, detail: c.detail || '', fix: c.fix || null, settings: c.settings || null })) } });
  } catch {} finally {
    CHECK.running = false;
    if (CHECK.again) { CHECK.again = false; setTimeout(() => selfCheck(), 0).unref(); }
  }
}
function watchCheckRequests() {
  try {
    mkdirSync(path.dirname(CHECK_REQ), { recursive: true });
    const w = watch(path.dirname(CHECK_REQ), (ev, name) => {
      if (name === path.basename(CHECK_REQ)) onCheckRequest();
      else if (name === path.basename(GOTO_REQ)) onGotoRequest().catch(() => {});
    });
    // fs.watch is only a wake-up hint. Recover a request written before this watcher started,
    // or an event coalesced by the filesystem, without ever replaying an already claimed request.
    const poll = setInterval(() => onGotoRequest().catch(() => {}), 1000);
    poll.unref();
    const close = w.close.bind(w);
    w.close = () => { clearInterval(poll); return close(); };
    queueMicrotask(() => onGotoRequest().catch(() => {}));
    w.on('error', () => {});
    w.unref();
    return w;
  } catch { return null; }
}

/**
 * The panel's explicit 「带我去」 uses a request id, worker generation and exact alert token.
 * The atomic result file acknowledges queuing and the final outcome; it contains no page URL.
 * The request must arrive within 10 s. Once admitted, it has a separate bounded queue deadline.
 * All identity, pause and own-job guards are checked again under the shared input lock.
 */
const GOTO_REQ = path.join(path.dirname(LOCK_DIR), `goto-${process.pid}.json`);
const GOTO_RESULT = path.join(path.dirname(LOCK_DIR), `goto-result-${process.pid}.json`);
const GOTO = { running: false, latest: null, seen: new Map(), entryMaxMs: 10_000, queueMaxMs: 15_000 };
const GOTO_MESSAGES = {
  queued: '正在等待其他 AI 交还鼠标，稍后打开。',
  shown: '已打开需要你处理的页面。',
  invalid_request: '跳转请求不完整，请刷新列表后重试。',
  session_changed: '这个 AI 会话已经更新，请刷新列表。',
  alert_changed: '这条等待提示已经结束或被替换，请刷新列表。',
  stale_request: '跳转请求已过期，请重新点击。',
  paused: 'MyChrome 已暂停，请恢复后重新点击。',
  busy: '这个 AI 正在操作，请稍后重新点击。',
  queue_timeout: '等待鼠标超时，请稍后重新点击。',
  page_changed: '等待的页面已经变化，请刷新列表。',
  target_unavailable: '暂时无法打开这个页面，请确认 Chrome 和标签页仍在。',
  request_conflict: '这个请求编号已经使用，请重新点击。',
  too_many_requests: '跳转请求过多，请稍后重试。',
  result_unavailable: '无法保存跳转结果，请稍后重试。'
};
function publishGoto(record) {
  if (GOTO.latest !== record) return true; // An older completion must not overwrite a newer click.
  try { writeAtomicJson(GOTO_RESULT, record.result); return true; } catch { return false; }
}
function finishGoto(record, status, reason) {
  record.result = { ...record.result, status, reason, message: GOTO_MESSAGES[reason], at: Date.now() };
  publishGoto(record);
  return status;
}
function gotoIdentityReason(req) {
  if (req.sessionGeneration !== SESSION_GENERATION) return 'session_changed';
  const block = BLOCKS.get(req.tab);
  if (!block || blockToken(block) !== req.alertToken) return 'alert_changed';
  if (S.get('paused')) return 'paused';
  if (TASK_HOLD) return 'busy';
  return null;
}
async function onGotoRequest() {
  const claimed = `${GOTO_REQ}.${randomUUID()}.claimed`;
  try { renameSync(GOTO_REQ, claimed); } catch { return 'none'; }
  let req;
  try { req = JSON.parse(readFileSync(claimed, 'utf8')); }
  catch { return 'none'; }
  finally { rmSync(claimed, { force: true }); }
  const validId = typeof req?.id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(req.id);
  const valid = validId && Number.isSafeInteger(req.tab) && req.tab > 0
    && Number.isSafeInteger(req.at) && typeof req.sessionGeneration === 'string'
    && typeof req.alertToken === 'string' && req.alertToken.length > 0 && req.alertToken.length <= 128;
  const record = { result: { id: validId ? req.id : null, pid: process.pid,
    tab: Number.isSafeInteger(req?.tab) ? req.tab : null,
    sessionGeneration: SESSION_GENERATION, alertToken: valid ? req.alertToken : null,
    requestedAt: Number.isSafeInteger(req?.at) ? req.at : null } };
  GOTO.latest = record;
  if (!valid) return finishGoto(record, 'ignored', 'invalid_request');
  const fingerprint = JSON.stringify([req.tab, req.at, req.sessionGeneration, req.alertToken]);
  const known = GOTO.seen.get(req.id);
  if (known) {
    if (known.fingerprint !== fingerprint) return finishGoto(record, 'ignored', 'request_conflict');
    GOTO.latest = known;
    publishGoto(known);
    return known.result.status;
  }
  const now = Date.now();
  if (req.at > now + 1000 || now - req.at >= GOTO.entryMaxMs) return finishGoto(record, 'ignored', 'stale_request');
  const invalid = gotoIdentityReason(req);
  if (invalid) return finishGoto(record, invalid === 'busy' ? 'busy' : 'ignored', invalid);
  for (const [id, old] of GOTO.seen) if (now - old.acceptedAt > 60_000 && old !== GOTO.active) GOTO.seen.delete(id);
  if (GOTO.seen.size >= 128) return finishGoto(record, 'busy', 'too_many_requests');
  Object.assign(record, { fingerprint, acceptedAt: now });
  GOTO.seen.set(req.id, record);
  if (GOTO.running) return finishGoto(record, 'busy', 'busy');
  record.result = { ...record.result, status: 'queued', reason: 'queued', message: GOTO_MESSAGES.queued, at: now };
  if (!publishGoto(record)) return finishGoto(record, 'failed', 'result_unavailable');
  GOTO.running = true;
  GOTO.active = record;
  const controller = new AbortController();
  const deadline = now + GOTO.queueMaxMs;
  const timer = setTimeout(() => controller.abort(), GOTO.queueMaxMs);
  timer.unref();
  try {
    const r = await withInputLock('goto', async (turn) => {
      const reason = gotoIdentityReason(req);
      if (reason) return { status: reason === 'busy' ? 'busy' : 'ignored', reason };
      // A lease already owned by this process is re-entrant; a user jump must not join its action.
      if (!turn) return { status: 'busy', reason: 'busy' };
      if (Date.now() >= deadline || controller.signal.aborted) return { status: 'failed', reason: 'queue_timeout' };
      const block = BLOCKS.get(req.tab);
      const info = await B.chromeInfo(req.tab);
      const changed = gotoIdentityReason(req);
      if (changed) return { status: changed === 'busy' ? 'busy' : 'ignored', reason: changed };
      if (!block?.url || info?.url !== block.url) return { status: 'ignored', reason: 'page_changed' };
      if (Date.now() >= deadline || controller.signal.aborted) return { status: 'failed', reason: 'queue_timeout' };
      const activated = await B.activateChrome(req.tab);
      return activated?.ok === true ? { status: 'shown', reason: 'shown' } : { status: 'failed', reason: 'target_unavailable' };
    }, { timeoutMs: GOTO.queueMaxMs, signal: controller.signal, info: lockInfo('带你去要处理的页面') });
    return finishGoto(record, r.result.status, r.result.reason);
  } catch (e) {
    return finishGoto(record, 'failed', controller.signal.aborted || e?.code === 'lock_timeout' ? 'queue_timeout' : 'target_unavailable');
  } finally { clearTimeout(timer); GOTO.running = false; GOTO.active = null; }
}
export function __gotoForTests() {
  return { file: GOTO_REQ, resultFile: GOTO_RESULT, run: onGotoRequest, watch: watchCheckRequests,
    identity: (tab) => ({ sessionGeneration: SESSION_GENERATION, alertToken: blockToken(BLOCKS.get(tab)) }),
    writeTask: writeTaskState, setQueueMaxMs: (ms) => { GOTO.queueMaxMs = ms; } };
}
function onCheckRequest() {
  if (CHECK.timer) return;
  // Spread out, so one session per app answers and the others see its result (freshCheckFor).
  CHECK.timer = setTimeout(async () => {
    CHECK.timer = null;
    let at = 0;
    try { at = Number(readFileSync(CHECK_REQ, 'utf8').trim()) || 0; } catch { return; }
    if (CHECK.at >= at || S.get('paused')) return;
    // The first session of an app to claim this request runs it; the others wait for its result (Fable r13 r2 B1;
    // the app is known even for a session whose own first check was skipped while paused: Codex r13 r3 B2).
    const app = await checkApp();
    const answered = app ? S.freshCheckFor(LOCK_DIR, app, at) : null;
    if (answered) { adoptCheck(answered); return; }
    if (app && !S.claimCheck(LOCK_DIR, app, at)) {
      // Another session of this app runs it: keep a copy of its result when it comes (up to 30 s).
      for (let i = 0; i < 30 && !S.get('paused'); i++) {
        await sleep(1000);
        const c = S.freshCheckFor(LOCK_DIR, app, at);
        if (c) { adoptCheck(c); return; }
      }
      return;
    }
    await selfCheck();
  }, 200 + Math.random() * 1500);
  CHECK.timer.unref();
}
/** Calls in progress (they can overlap: MCP allows it); the panel shows the newest one still running (Codex/Fable r13 B). */
const ACTIVE = new Map();
let callSeq = 0;
function presenceBusy(tool, id = null) {
  if (!RECORD) return null;
  if (tool) { id = ++callSeq; ACTIVE.set(id, tool); } else ACTIVE.delete(id);
  const now = [...ACTIVE.values()].at(-1) || null;
  const identity = agentIdentity();
  const who = typeof identity.who === 'string' ? identity.who : identity.who.zh;
  S.writePresence(LOCK_DIR, { who, color: identity.color,
    ...(now ? { busy: now } : { busy: null, lastActionAt: Date.now() }) });
  return id;
}

/** A sweep of agent tabs; each tab it closed is a line in the activity log (「自动关闭标签」, why, the host). */
async function sweep(o = {}) {
  try {
    const r = await sweepTabs(o);
    if (RECORD) for (const t of r.closed || []) {
      S.logActivity({ tool: 'auto_close', host: S.hostOf(t.expectedUrl || t.url), ok: true, code: t.reason || null,
        who: t.agentName || 'MyChrome', color: 0 });
    }
    return r;
  } catch { return null; }
}

/** The menu-bar item (keep the screen awake, see the agents' tasks): started once, if built. */
function startMenuBar() {
  if (process.env.CHROME_BRIDGE_MENUBAR === '0') return;
  const bin = path.join(ROOT, 'bin', 'cbmenu');
  try { statSync(bin); } catch { return; }
  try { spawn(bin, [], { stdio: 'ignore', detached: true, env: process.env }).unref(); } catch {}
}

/* ------------------------------------------------------------ task plan */

/**
 * A whole job owns one takeover. Its sidebar mirrors the host's existing visible
 * assistant messages; action indexes and estimates cannot establish completion.
 */
let PLAN = null;   // { task, steps, estimateMs, t0, current, currentSince }

/** End the plan's card and wake assertion, retaining the task identity for a cancelled job. */
function clearTaskPlan() {
  const p = PLAN;
  PLAN = null;
  if (p && p.stopAwake) p.stopAwake();
  writeTaskState();
}

/** A failed or interrupted takeover does not complete the user's project. Keep
 * its identity and cause, but require an explicit plan restart before more input. */
function interruptTaskPlan(code, reason) {
  if (!PLAN) return;
  closeTaskFeed();
  if (!PLAN.interrupted) PLAN.interrupted = { code, reason, at: Date.now() };
  if (PLAN.stopAwake) { PLAN.stopAwake(); PLAN.stopAwake = null; }
  writeTaskState();
}

function taskInterruptionReason(by) {
  return by === 'esc' || by === 'shake' ? '用户停止了接管'
    : by === 'tap_disabled' || by === 'tap_disabled_user_input' ? '系统中断了输入接管'
    : by === 'timeout' || by === 'idle' ? '接管的安全时限已到'
    : by ? '输入接管已经中断' : '暂时无法确认输入接管状态';
}

function taskInterruptedError() {
  const why = PLAN?.interrupted?.reason || '输入接管已经中断';
  return new BridgeError('task_interrupted',
    `⏸ 任务「${PLAN?.task || '当前任务'}」尚未完成：${why}。没有继续输入。` +
    '先 read_page 检查当前状态，确认可继续后重新 task_plan；不要把这次中断当作任务完成。');
}

/** A host question hands input back. Resolving it does not silently restart an interrupted plan. */
function conversationInputCheck() {
  if (!GUI_SERVICE?.snapshot().pending?.length && PLAN?.interrupted?.code !== 'conversation_waiting') return;
  throw new BridgeError('conversation_waiting',
    '⏸ AI 正在等待你的回复，尚未继续操作。请在会话中心回答；回复后先检查页面，再继续任务。');
}

async function suspendForConversationReply() {
  interruptTaskPlan('conversation_waiting', '正在等待你的回复');
  // A running action unwinds through runInputAction, so restoration cannot race its input.
  if (TASK_HOLD && !TASK_HOLD.busy) await endTaskHold();
}

/** A recoverable tool failure while the same healthy helper owns input leaves
 * the whole job in place. If ownership is unknown or lost, release it and keep
 * an interrupted plan instead of silently deleting the project. Never retake. */
async function maintainTaskAfterError(error) {
  const plan = PLAN;
  if (!plan || plan.interrupted) return false;
  const th = TASK_HOLD;
  const mustStop = ['user_cancelled', 'cancelled', 'paused_by_user', 'site_blocked',
    'task_hold_lost', 'takeover_expired', 'tap_disabled', 'conversation_waiting'].includes(error?.code);
  let st = null;
  if (th && !mustStop) {
    st = await th.kept.session.request({ op: 'status' }, { raw: true }).catch(() => null);
    if (PLAN === plan && TASK_HOLD === th && holdActive(st) && !st.interrupted && st.ok !== false) return true;
  }
  await endTaskHold().catch(() => {});
  if (PLAN !== plan) return false;
  const by = error?.by || givenBackBy(st);
  if (by === 'esc' || by === 'shake' || error?.code === 'user_cancelled') TASK_CANCELLED = plan.task;
  const code = by || (th && !mustStop && !st ? 'hold_unverified' : error?.code || 'tool_error');
  const reason = by || code === 'hold_unverified' ? taskInterruptionReason(by)
    : code === 'user_cancelled' || code === 'cancelled' ? '任务已被停止'
    : '这一步没有完成，接管已暂停';
  interruptTaskPlan(code, reason);
  return false;
}

async function taskPlanTool(args) {
  if (args.done === true) {
    const p = PLAN;
    clearTaskPlan();
    closeTaskFeed();
    PANEL_TASK = { text: '', at: 0 };
    const end = await endTaskHold();
    const facts = end ? [
      end.inputReleased ? '键盘鼠标接管已结束' : '未确认键盘鼠标接管已解除',
      end.appRestored ? '前台 App 已切回' : null,
      end.pointerRestored ? '光标已放回原处' : '光标恢复未确认',
      '窗口和标签恢复未确认',
    ].filter(Boolean).join('；') : '';
    return p ? `${p.interrupted ? '⏸' : '✅'} 任务「${p.task}」结束：用时 ${Math.round((Date.now() - p.t0) / 1000)} 秒${facts ? `；${facts}` : ''}${p.interrupted ? `；任务未完成：${p.interrupted.reason}` : ''}。`
      : `没有进行中的任务计划${facts ? `；${facts}` : ''}。`;
  }
  const task = typeof args.task === 'string' ? args.task.replace(/\s+/g, ' ').trim() : '';
  const steps = Array.isArray(args.steps) ? args.steps.map(x => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 100) : [];
  if (!task) throw new BridgeError('bad_plan', '❌ task_plan 需要 task（任务名）。结束任务时传 done:true。');
  // An implicit hold already has gap/max timers in both processes. Start a fresh
  // explicit-plan hold rather than inheriting those timers under a new plan.
  // Compare the original name, not its shortened panel label; distinct long
  // names can share that label, and repeating one long name must retain its hold.
  const samePlan = PLAN && (PLAN.fullTask ?? PLAN.task) === task;
  if (TASK_HOLD && (!samePlan || TASK_HOLD.task !== PLAN.task)) await endTaskHold();
  if (PLAN && PLAN.stopAwake) PLAN.stopAwake();
  TASK_CANCELLED = null; // A new explicit plan is the agent's deliberate restart, after user consent.
  const now = Date.now();
  PLAN = { stopAwake: B.keepAwake(), fullTask: task, task: task.length > 40 ? task.slice(0, 39) + '…' : task, steps: steps.map(x => x.length > 60 ? x.slice(0, 59) + '…' : x),
    estimateMs: Number(args.estimate_minutes) > 0 ? Number(args.estimate_minutes) * 60_000 : null, t0: now, current: 1, currentSince: now };
  PANEL_TASK = { text: PLAN.task, at: now };
  const started = PLAN;
  await connectTaskFeed(args.conversation_id, { sameTask: !!samePlan });
  if (PLAN !== started) return '任务已停止，未启动新的接管。';
  writeTaskState();
  return `✅ 已记录整项任务「${PLAN.task}」。首次输入后保持一次接管，直到 done:true 或用户 Stop。` +
    taskFeedMessage() + '不要额外生成 note 或题号完成清单。结束任务不代表试卷已完成；须核对页面和保存结果。';
}

/* ----------------------------------------------------------- task hold */

/**
 * A long job (the agent passes `task`): one takeover for the whole job instead of one per action
 * (owner, round 5: a paper of 40 questions need not switch back and forth 100 times). The first
 * action takes over as usual and keeps the session, the hold and the user's scene; each next
 * action of the same task runs inside them; between actions the veil says the agent is working out
 * the next step. The input lock is held as a lease while the job works; when another agent waits
 * (lock.js queue), an implicit job may hand its turn over between steps. An explicit PLAN
 * owns the whole turn, including reading and reasoning gaps, until done, user Stop or an
 * interruption. Only implicit jobs expire after TASK_GAP_MS. The helper's liveness watchdog
 * and client-disconnect cleanup remain active for both.
 */
let TASK_GAP_MS = Number(process.env.CHROME_BRIDGE_TASK_GAP_MS ?? 30_000);
export function __setTaskGapForTests(ms) { TASK_GAP_MS = ms; }
let TASK_HOLD = null;          // { task, lease, kept, timer, poll }
let YIELDING = null;           // a hand-over between two steps under way (yieldTurn)
let TASK_CANCELLED = null;     // the task whose hold the user took back
let HOLD_ENDING = 0;           // holds being ended: the user's things being put back, the lease let go
/** Implicit jobs retain a bounded hold. Explicit plans use the helper's liveness watchdog. */
const TASK_LIMITS = { takeoverMaxMs: 1_800_000, takeoverIdleMs: 60_000 };
const TASK_NOTE = () => PLAN?.interrupted
  ? `\n（任务未完成，接管已暂停：${PLAN.interrupted.reason}）`
  : PLAN
  ? '\n（整项任务持续接管中：读题、思考和步骤切换期间保持接管；全部完成后 done:true，连按两次 Esc 可随时停止）'
  : `\n（长任务进行中：键盘鼠标继续由 agent 接管，${Math.round(TASK_GAP_MS / 1000)} 秒内没有下一步就把你的窗口和光标还原）`;
export function __taskHoldForTests() { return TASK_HOLD; }
export function __resetPanelTaskForTests() { PANEL_TASK = { text: '', at: 0 }; TASK_CANCELLED = null; PLAN = null; closeTaskFeed(); BLOCKS.clear(); Object.assign(STUCK, { n: 0, last: '', toldAt: 0, since: 0 }); DISPLAYS = { at: 0, list: null }; USER_POINTER = null; }

/** The job an action belongs to: its `task`, or the one this session named last (PANEL_TASK_KEEP_MS). */
function taskKey(args) {
  if (PLAN) return PLAN.task;
  const given = typeof args.task === 'string' ? args.task.replace(/\s+/g, ' ').trim() : '';
  if (given) return given.length > 40 ? given.slice(0, 39) + '…' : given;
  if (TASK_CANCELLED) return TASK_CANCELLED;
  return Date.now() - PANEL_TASK.at <= PANEL_TASK_KEEP_MS ? PANEL_TASK.text : '';
}

const taskRestoreOps = () => ({
  now: Date.now,
  restoreScene: (sc, o = {}) => B.restoreScene(sc, { stopOnInput: !o.held, since: o.since ?? null })
});

/** End the job's hold: put the user's things back, close the session, release the lease. */
export async function endTaskHold() {
  // A hand-over between steps under way decides first: handed over → nothing is ours to put back (Codex review A3).
  if (YIELDING) await YIELDING;
  return TASK_HOLD ? await endTaskHoldNow(TASK_HOLD) : null;
}

/** endTaskHold's work, for a hold known to be current (yieldTurn calls it from inside a hand-over). */
async function endTaskHoldNow(th) {
  if (!th || TASK_HOLD !== th) return;
  TASK_HOLD = null;
  HOLD_ENDING++;
  writeTaskState();
  clearTimeout(th.timer);
  clearInterval(th.poll);
  try {
    const end = await releaseKept(taskRestoreOps(), th.kept);
    const tk = end && end.takeover;
    debugLog({ label: 'task hold ended', task: th.task, takeover: tk || null, interrupted: (end && end.interrupted) || null });
    if (tk) notifyUserHeld(tk.swallowedKeys || 0, tk.swallowedPointer || 0);
    return end;
  } finally {
    await th.lease.release().catch(() => {});
    HOLD_ENDING--;
  }
}

/** Between actions: retain the plan and panel, watch Stop/liveness, expire only implicit jobs. */
function startGap(th) {
  th.busy = false;
  th.kept.session.request({ op: 'veil', veil: { label: { zh: '正在想下一步…', en: 'Working out the next step…' } } }, { raw: true }).catch(() => {});
  const planned = PLAN && PLAN.task === th.task;
  th.timer = planned ? null : setTimeout(() => { if (TASK_HOLD === th) endTaskHold().catch(() => {}); }, TASK_GAP_MS);
  th.poll = setInterval(async () => {
    if (th.checking || TASK_HOLD !== th || YIELDING) return;
    th.checking = true;
    if (S.get('paused')) {
      th.checking = false;
      await endTaskHold().catch(() => {});
      pauseCleanup();
      return;
    }
    const st = await th.kept.session.request({ op: 'status' }, { raw: true }).catch(() => null);
    const active = holdActive(st) && st.ok !== false && !st.interrupted;
    // Still held (not given back by Esc or a shake) and someone waits for the mouse: their turn while
    // this agent works out its next step (Codex review A4: the hold's state is read before yielding).
    if (active && TASK_HOLD === th && !th.busy && !(PLAN && PLAN.task === th.task)) {
      const q = await queueList().catch(() => []);
      if (q.length && q[0].inherit && TASK_HOLD === th && !th.busy && !YIELDING) {
        th.checking = false;
        YIELDING = yieldTurn(th).catch(() => {}).finally(() => { YIELDING = null; });
        return;
      }
    }
    th.checking = false;
    if (TASK_HOLD !== th || th.busy || active) return;
    const by = st && st.takeover ? (st.takeover.abortedBy || st.takeover.releasedBy) : null;
    debugLog({ label: 'task hold lost between actions', task: th.task, by, takeover: (st && st.takeover) || null });
    if (by === 'esc' || by === 'shake') TASK_CANCELLED = th.task;
    await endTaskHold().catch(() => {});
    if (PLAN && PLAN.task === th.task) interruptTaskPlan(by || 'hold_unverified', taskInterruptionReason(by));
  }, 500);
}

/**
 * Between two steps of a job, another agent waits: hand it the takeover (lock.js offer) — its veil
 * comes up before ours goes, nothing of the user's is put back (the scene goes with the turn).
 * Not taken in time: the gap goes on as before.
 */
async function yieldTurn(th) {
  th.busy = true;
  clearTimeout(th.timer); clearInterval(th.poll); th.timer = th.poll = null;
  let by = null;
  const h = await th.lease.offer({ scene: th.kept.scene, pointer: th.kept.pointer, touched: true }, {
    onOffer: () => th.kept.session.request({ op: 'veil', veil: { label: { zh: '让排队的下一个任务先做…', en: 'Letting the next task in the queue go first…' } } }, { raw: true }).catch(() => {}),
    // The user takes the keyboard and mouse back meanwhile (Esc twice, a shake): withdraw if still possible.
    shouldStop: async () => {
      const st = await th.kept.session.request({ op: 'status' }, { raw: true }).catch(() => null);
      if (holdActive(st)) return false;
      by = givenBackBy(st);
      return true;
    }
  }).catch(() => null);
  let cancelled = by === 'esc' || by === 'shake';
  if (!h || !h.commit) {
    // Not handed over: as before — the gap goes on, or the user's cancel ends the job (things put back).
    if (h && h.stopped) {
      if (cancelled) TASK_CANCELLED = th.task;
      debugLog({ label: 'task hold lost while offering', task: th.task, by });
      if (TASK_HOLD === th) { th.busy = false; await endTaskHoldNow(th); }
      return;
    }
    if (TASK_HOLD === th) startGap(th);
    return;
  }
  // Claimed: the waiter's veil is up and the scene is its to put back. Ours goes, nothing restored.
  // The user may have stopped the job after the last look (Codex review round 2): read it once more,
  // and from the session's end reply.
  if (!cancelled) {
    const st = await th.kept.session.request({ op: 'status' }, { raw: true }).catch(() => null);
    if (!holdActive(st)) { by = givenBackBy(st); cancelled = by === 'esc' || by === 'shake'; }
  }
  if (TASK_HOLD === th) TASK_HOLD = null;
  writeTaskState();
  const end = await th.kept.session.close().catch(() => null);
  if (!cancelled && end && end.takeover && ['esc', 'shake'].includes(end.takeover.abortedBy)) cancelled = true;
  if (cancelled) TASK_CANCELLED = th.task;      // the job the user stopped does not go on
  await h.commit().catch(() => {});
  await th.lease.release().catch(() => {});
  debugLog({ label: 'task hold handed over between steps', task: th.task, to: h.to, cancelledMeanwhile: cancelled });
}

/** A hold still the agent's: active and not given back (Esc twice marks it aborted before the key-up releases it). */
const holdActive = (st) => !!(st && st.takeover && st.takeover.active && !st.takeover.aborted);
const givenBackBy = (st) => st && st.takeover ? (st.takeover.abortedBy || st.takeover.releasedBy || null) : null;

const taskCancelledError = () => new BridgeError('user_cancelled',
  '⏹ 你在 agent 做这个任务的过程中收回了键盘鼠标（连按两次 Esc），后面的步骤没有做，你的窗口和光标已还原。\n' +
  '给 agent：不要自动重试，先问用户要不要继续。');

/** One action of a long job (see above). Same result shape as withInputLock. */
async function taskRun(label, ops, action, task) {
  if (YIELDING) await YIELDING;
  if (TASK_CANCELLED === task) throw taskCancelledError();
  if (PLAN?.interrupted) throw taskInterruptedError();
  conversationInputCheck();
  let th = TASK_HOLD;
  if (th && th.task !== task) { await endTaskHold(); th = null; }
  if (th) { th.busy = true; clearTimeout(th.timer); clearInterval(th.poll); th.timer = th.poll = null; }
  const t0 = Date.now();
  let lease = th ? th.lease : null, ticket = null, r, waitedMs = 0;
  for (;;) {
    if (!th) { lease = await acquireLease(label, { info: lockInfo(task), inherit: true, ticket, signal: ops.signal }); waitedMs = Date.now() - t0; }
    try {
      conversationInputCheck();
      r = await runInputAction({ ...ops, keep: true, reuse: th ? th.kept : null,
        ...(!th && lease.handoff ? { inherit: { ...lease.handoff, claim: () => lease.claim() } } : {}),
        takeoverLimits: { ...ops.takeoverLimits, ...TASK_LIMITS,
          ...(PLAN && PLAN.task === task ? { takeoverUntilDone: true } : {}) } }, action);
      break;
    } catch (e) {
      // The holder withdrew its hand-over before we claimed it: wait again, in the same place.
      if (e.code === 'handoff_lost' && !th && !lease.claimed && !(ops.signal && ops.signal.aborted)) { ticket = lease.ticket; await lease.release({ keepTicket: true }); continue; }
      r = e;
      break;
    }
  }
  if (r instanceof Error) {
    const e = r;
    if (e.keptHold && th) {
      // Nothing was sent and the job still holds: keep it for the retry (persist) and the next steps.
      startGap(th);
      throw e;
    }
    // Failed: runInputAction has put the user's things back and closed the session.
    if (TASK_HOLD === th) TASK_HOLD = null;
    await lease.release().catch(() => {});
    if (e.code === 'task_hold_lost') {
      if (e.by === 'esc' || e.by === 'shake') {
        TASK_CANCELLED = task;
        if (PLAN && PLAN.task === task) interruptTaskPlan(e.by, taskInterruptionReason(e.by));
        throw taskCancelledError();
      }
      if (PLAN && PLAN.task === task) {
        interruptTaskPlan(e.by || 'hold_unverified', taskInterruptionReason(e.by));
        throw e; // An interrupted plan must not silently retake control.
      }
      return taskRun(label, ops, action, task);     // lost for another reason: a fresh hold
    }
    if (e.code === 'user_cancelled') TASK_CANCELLED = task;
    throw e;
  }
  if (r.kept) {
    const nth = th || { task, lease };
    nth.kept = r.kept;
    TASK_HOLD = nth;
    if (!th) writeTaskState();
    if (GUI_SERVICE?.snapshot().pending?.length || PLAN?.interrupted?.code === 'conversation_waiting') {
      await suspendForConversationReply();
      // This action ended before the question arrived, but its hold must not survive it.
      await endTaskHold();
      conversationInputCheck();
    }
    startGap(nth);
  } else {
    if (TASK_HOLD === th) TASK_HOLD = null;
    await lease.release().catch(() => {});
  }
  return { result: r, waitedMs: th ? 0 : waitedMs, waitedFor: th ? null : lease.waitedFor,
    ahead: th ? 0 : lease.ahead, inherited: !th && !!lease.handoff && lease.claimed };
}

/**
 * One locked input action (contract §3): lock → idle wait → scene snapshot
 * → prepare → session → action → end; see runInputAction for the outcomes.
 * `prepare` returns {chromePid, cgWindow, windowBounds, touchesScene, target, ...}.
 *
 * The tab's URL at the end of an action the user did not touch becomes its
 * expected URL (noteAgentNavigation). After a user interruption it does not:
 * whatever the tab shows may be the user's doing, and an agent tab the action
 * had started on is marked as taken over.
 */
async function inputAction(label, prepare0, action, { doneNote = '\n（操作完已把光标、前台 App 和你原来看的 Chrome 标签还原）', activates = true, preflight = null, idle = {}, veil = null, task = '' } = {}) {
  conversationInputCheck();
  // B4: the tab this action works on; once it is over, a click is the user's, not the agent's.
  let actedTab = null;
  const prepare = async (pre, ctx) => {
    conversationInputCheck();
    USER_POINTER = (ctx && ctx.pointer) || null;
    const p = await prepare0(pre);
    conversationInputCheck();
    if (p && p.target && p.target.tabId != null) actedTab = p.target.tabId;
    return p;
  };
  try {
    const woke = await screenReady();
    // A CAPTCHA or bot check on the page: stop before taking anything over (the label names the tab when the agent did).
    const named = String(label).match(/\btab (\d+)/);
    await siteGate(named ? Number(named[1]) : null);
    return woke + await inputActionRun(label, prepare, action, { doneNote, activates, preflight, idle, veil, task });
  }
  finally { if (actedTab != null) await noteAgentDone(actedTab).catch(() => {}); }
}

async function inputActionRun(label, prepare, action, { doneNote, activates, preflight, idle, veil, task }) {
  if (TASK_CANCELLED && TASK_CANCELLED === task) throw taskCancelledError();
  const takeover = TAKEOVER;
  let navigationObserver = null, routineAbortCleanup = null;
  let inputCount = 0, actionSession = null, navigationAnchor = null;
  const actionPlan = PLAN;
  const observedAction = async (session, prep, ctx, pre) => {
    conversationInputCheck();
    const context = CALL.getStore();
    await context?.routineGuard?.();
    await ROUTINES.beforeInput(context, prep.target.tabId);
    context?.routineCheck?.();
    actionSession = session;
    const signal = CALL.getStore()?.routineSignal;
    if (signal && typeof session.cancel === 'function') {
      const cancel = () => { session.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      routineAbortCleanup = () => signal.removeEventListener('abort', cancel);
    }
    if (TASK_HOLD) delete TASK_HOLD.pendingNavigation;
    navigationObserver = await B.openNavigationObserver().catch(() => null);
    if (takeover && actionPlan) navigationAnchor = await heldNavigationAnchor(prep, session, actionPlan);
    conversationInputCheck();
    let actionOut, nativeObserver = null;
    // runInputAction invokes this before releasing the physical lease. Keep
    // the original observer first (click/type confirmation), then persist its
    // postcondition. since=null means the lease was handed off: only a barrier.
    ctx.observe(async observation => {
      let report;
      try { report = nativeObserver ? await nativeObserver(observation) : { out: actionOut }; }
      catch (error) { await ROUTINES.afterInput(context, { isError: true }); throw error; }
      await ROUTINES.afterInput(context, {}, { observation });
      return report;
    });
    actionOut = await action(session, prep, {
      ...ctx,
      observe(fn) { nativeObserver = fn; },
      sent(kind) { ctx.sent(kind); inputCount++; },
      unsent(kind) { ctx.unsent(kind); inputCount = Math.max(0, inputCount - 1); }
    }, pre);
    return actionOut;
  };
  const ops = {
    takeover,
    takeoverLimits: TAKEOVER_LIMITS,
    waitForUserIdle: async () => { const r = await waitForUserIdle(idle); pausedCheck('（在等你停手时）'); conversationInputCheck(); return r; },
    waitForHandsOff: async () => { const ms = await waitForHandsOff(idle); pausedCheck('（在等你停手时）'); conversationInputCheck(); return ms; },
    now: Date.now,
    snapshotScene: () => B.snapshotScene().catch(() => null),
    mousepos: () => B.cgevent(['mousepos']).catch(() => null),
    prepare,
    userActedSince,
    openSession: openOwnSession,
    // While held, the user's input cannot move anything: restore without watching for it.
    restoreScene: (sc, o = {}) => B.restoreScene(sc, { stopOnInput: !o.held, since: o.since ?? null }),
    restoreApp: (sc, o = {}) => B.restoreApp(sc.appPid, { noClickSince: o.noClickSince ?? null }),
    userClickedSince,
    navigationUntouched: async (prep, since) => {
      if (!navigationObserver) return false;
      const target = await B.chromeInfo(prep.target.tabId).catch(() => null);
      if (!target || (prep.chromePid != null && target.chromePid !== prep.chromePid) ||
          (prep.cgWindow != null && target.cgWindow !== prep.cgWindow) ||
          (prep.target.windowId != null && Number(target.windowId) !== Number(prep.target.windowId))) return false;
      return navigationObserver.untouched(target, since == null ? navigationObserver.startedAt : since);
    },
    warp: (p) => B.cgevent(['warp', Number(p.x).toFixed(1), Number(p.y).toFixed(1)]),
    currentUrl: async (prep) => prep.lastUrl !== undefined ? prep.lastUrl : ((await B.chromeInfo(prep.target.tabId)).url || null),
    noteNavigation: (prep, url) => {
      navigationAnchor = url;
      NATIVE_TARGETS.delete(Number(prep.target.tabId));
      try { ledgerNavigated(prep.target.tabId, url); } catch {}
      return noteAgentNavigation(prep.target.tabId, url);
    },
    activates,
    signal: (idle && idle.signal) || null,
    ...(preflight ? { preflight } : {}),
    ...(veil ? { veil } : {})
  };
  let res;
  try {
    res = takeover && task && (PLAN || TASK_GAP_MS > 0) ? await taskRun(label, ops, observedAction, task)
      : await withInputLock(label, (turn) => { pausedCheck('（在排队时）'); conversationInputCheck(); return runInputAction(withTurn(ops, turn), observedAction); }, { info: lockInfo(task), inherit: takeover, signal: ops.signal });
  } catch (e) {
    debugLog({ label, task, outcome: 'error', code: e.code || null, message: String(e.message || '').split('\n')[0].slice(0, 200),
      takeover: (e.reply && e.reply.takeover) || null, interrupted: e.interrupted || (e.reply && e.reply.interrupted) || null,
      lateUser: !!e.lateUser, steps: e.steps || null });
    if (e.code === 'lock_timeout') throw new BridgeError('lock_timeout', e.message);
    if (e.lateUser) e.message += LATE_USER_NOTE(e.sceneRestored, e.appRestored);
    throw e;
  } finally {
    routineAbortCleanup?.();
    if (navigationObserver) await navigationObserver.close().catch(() => {});
  }
  const r = res.result;
  if (inputCount > 0) rememberHeldNavigation(r,
    { inputCount, session: actionSession, plan: actionPlan, expectedUrl: navigationAnchor });
  debugLog({ label, task, outcome: r.outcome, late: !!r.late, kept: !!r.kept, kind: r.kind || null,
    takeover: (r.end && r.end.takeover) || null, interrupted: (r.end && r.end.interrupted) || null, sent: r.sent || null,
    steps: r.steps || null, waitedMs: res.waitedMs, restore: r.restore || null });
  const head = queueNote(res.waitedMs, res.waitedFor, res) +
    (r.idleWait > 300 ? `（等你停手 ${(r.idleWait / 1000).toFixed(1)} 秒后才操作）\n` : '');
  const tk = r.end && r.end.takeover;
  const heldParts = tk ? [tk.swallowedKeys ? `${tk.swallowedKeys} 个按键` : '', tk.swallowedPointer ? `${tk.swallowedPointer} 次点击/滚动` : ''].filter(Boolean) : [];
  const heldNote = heldParts.length ? `\n（操作期间键盘鼠标由 agent 接管，拦下了你的 ${heldParts.join('、')}，没有送到任何程序）` : '';
  if (heldParts.length) notifyUserHeld(tk.swallowedKeys || 0, tk.swallowedPointer || 0);
  if (r.outcome === 'user') {
    const context = CALL.getStore();
    if (context) context.routineEvidence = { ok: false, code: 'user_cancelled' };
    if (r.late) return head + r.out + '\n' + LATE_USER_NOTE(r.sceneRestored, r.appRestored).trim();
    const tab = r.prep && r.prep.target && r.prep.target.tabId;
    // Pointer moves or a lone modifier, with nothing of ours posted, cannot
    // have changed the tab: no reason to treat it as the user's from now on.
    const harmless = r.out == null && !(r.sent && r.sent.length) && (r.kind === 'move' || r.kind === 'flags');
    if (r.began && !harmless && tab != null && await getTab(tab).catch(() => null)) {
      await markTakenOver(tab, 'user_interrupted').catch(() => {});
    }
    if (r.out != null) {
      return head + r.out + '\n\n⏸ 操作做完、还原之前你动了键盘鼠标：' + stopRestoreLine(r);
    }
    const e = new BridgeError('user_interrupted', head + userStopMessage(r));
    e.sent = r.sent || [];
    throw e;
  }
  const handed = r.handedOver ? `\n（做完直接交给排队的下一个任务「${zhText(queueLabel(r.handedOver))}」，由它切到自己的页面；` +
    '最后一个做完的会把你的窗口、标签和光标还原）' : null;
  return head + r.out + (r.kept ? TASK_NOTE() : handed || doneNote) + heldNote + timingLine(r.timing);
}

/* ------------------------------------------------------ retry in place */

/**
 * Failures after which nothing the page could act on was posted and that
 * usually pass on their own: someone was using keyboard or mouse, another
 * agent held the input, the activation was disturbed. They are retried here,
 * so the agent gets one answer per call (done, or a failure that needs its
 * decision) instead of spending a turn on every attempt.
 */
// input_held: a key or button was down the instant the hold began — the user is at the keyboard; the
// next attempt waits until they are done (waitForHandsOff), as long as it takes.
const RETRY_WAIT = new Set(['user_interrupted', 'user_busy', 'lock_timeout', 'input_held',
  'guard_cursor_moved', 'guard_modifier_held', 'guard_not_frontmost', 'guard_key_window']);
/** Disturbed activation: retried a few times only, it may not be transient. */
// no_such_tab: another agent opening/closing tabs in the same window can make a lookup miss for a
// moment (seen live 2026-10-05); a tab that is really gone still fails after the few retries.
const RETRY_FEW = new Set(['activate_failed', 'not_on_top', 'not_key_window', 'window_changed', 'secure_input',
  'no_such_tab']);
/** Secure Input on (a password dialog, a password field): waited out this long, not just a few quick tries — someone may be
 * typing a password for a minute (round 5: a system password dialog stopped a long job after three tries). */
const SECURE_WAIT_MS = Number(process.env.CHROME_BRIDGE_SECURE_WAIT_MS ?? 120_000);
let RETRY = {
  maxMs: Number(process.env.CHROME_BRIDGE_RETRY_MAX_MS ?? 600_000),
  few: 3,
  pauseMs: 400
};
export function __setRetryForTests(o) { RETRY = { ...RETRY, ...o }; }

/**
 * Hands-off time required before attempt n. The user is watched from the
 * idle check through preparation and activation (about 1–2 s), so after an
 * interruption a longer pause is asked for than the first 1.5 s.
 */
const idleForAttempt = (n) => { const s = userIdleS(); return (s > 0 && n > 0) ? Math.min(s + 1.5 * n, 6) : s; };

const AGENT_PARTIAL = '\n给 agent：这次已经发出了部分输入，先 read_page 看页面现状再决定是否重做；不需要请用户停手或代为操作。';

/**
 * Run `attempt(idle)` until it succeeds, fails in a way retrying cannot fix,
 * the deadline passes, or the call is cancelled.
 */
async function persist(attempt, signal = null) {
  const t0 = Date.now();
  let n = 0, few = 0;
  for (;;) {
    if (signal && signal.aborted) throw cancelledError();
    const left = RETRY.maxMs - (Date.now() - t0);
    try {
      const out = await attempt({ idleS: idleForAttempt(n), maxWaitMs: Math.max(1000, Math.min(USER_IDLE_MAX_WAIT_MS, left)), signal });
      if (!n) return out;
      return `（排队 ${Math.round((Date.now() - t0) / 1000)} 秒、自动重试 ${n} 次后完成；之前几次都没有发出任何输入）\n` + out;
    } catch (e) {
      const code = e && e.code;
      if (code === 'cancelled') throw e;
      const clean = !(e && e.sent && e.sent.length) && !(e && e.lateUser);
      if (!clean) {
        if (code === 'user_interrupted' && e instanceof BridgeError) e.message += AGENT_PARTIAL;
        throw e;
      }
      const retryable = RETRY_WAIT.has(code) ||
        ((code === 'secure_input' || code === 'screen_locked') && Date.now() - t0 < Math.min(SECURE_WAIT_MS, RETRY.maxMs)) ||
        (RETRY_FEW.has(code) && ++few <= RETRY.few);
      if (!retryable || !(RETRY.maxMs > 0)) {
        if (n && e instanceof BridgeError) e.message += `\n（此前已自动重试 ${n} 次）`;
        throw e;
      }
      if (Date.now() - t0 >= RETRY.maxMs) {
        const err = new BridgeError(code,
          `⏸ 排队 ${Math.round((Date.now() - t0) / 1000)} 秒、自动重试 ${n} 次仍没做成，没有发出任何输入，页面没变。最后一次的原因：\n` +
          e.message + '\n给 agent：可以直接再调用一次继续排队；不需要请用户停手或代为操作，除非用户自己这样要求。');
        err.sent = [];
        throw err;
      }
      n++;
      await sleep(RETRY.pauseMs);
    }
  }
}

/** 分段耗时：准备（不占前台）/ 前台 / 切回后观察。 */
function timingLine(T) {
  if (!T || !T.activated) return '';
  const ms = (a, b) => (T[a] && T[b]) ? Math.round(T[b] - T[a]) : null;
  const parts = [
    ms('idleEnd', 'preEnd') != null ? `准备 ${ms('idleEnd', 'preEnd')} ms（不占前台）` : null,
    ms('activated', 'handBack') != null ? `前台 ${ms('activated', 'handBack')} ms` : null,
    ms('handBack', 'observeEnd') != null ? `切回后观察 ${ms('handBack', 'observeEnd')} ms` :
      ms('statusDone', 'observeEnd') != null ? `接管中观察 ${ms('statusDone', 'observeEnd')} ms` : null
  ].filter(Boolean);
  const seq = [['activated','a:relocated','复查位置'],['a:relocated','a:preClick','滚动检查等'],['a:preClick','a:clicked','反应+移动+按下'],
    ['a:clicked','a:acked','等点击确认'],['a:acked','urlRead','读网址'],['urlRead','statusDone','查状态/记导航'],['statusDone','handBack','还原窗口']];
  const fg = seq.map(([a, b, n]) => (T[a] && T[b]) ? `${n} ${Math.round(T[b] - T[a])}` : null).filter(Boolean);
  if (process.env.CHROME_BRIDGE_TIMING_DETAIL === '1' && fg.length) parts.push(`前台明细：${fg.join(' / ')} ms`);
  if (process.env.CHROME_BRIDGE_TIMING_DETAIL === '1' && T.holdStart) {
    const tk = [['holdStart','held','接管+遮罩'],['held','sceneRead','读现场'],['sceneRead','begun','begin'],['begun','activated','切到前台'],
      ['activated','a:preClick','点前检查'],['a:preClick','a:clicked','拟人动作'],['a:clicked','a:acked','等网页确认'],['a:acked','statusDone','读网址/状态'],
      ['statusDone','handBack','交还前台App'],['handBack','restored','还原窗口'],['restored','warped','光标归位'],['warped','closed','解除接管']]
      .map(([a, b, n]) => (T[a] && T[b]) ? `${n} ${Math.round(T[b] - T[a])}` : null).filter(Boolean);
    parts.push(`接管明细：${tk.join(' / ')} ms`);
    if (T.heldAt || T.held) parts.push(`接管于 ${Math.round(T.heldAt || T.held)}`);
  }
  return parts.length ? `\n耗时：${parts.join('，')}` : '';
}

/**
 * Bring `tab` on screen (or, with tab=null, the front window's active tab)
 * and return the activation record, pinned to a concrete tab id. Must run
 * under the input lock: another agent's activation would otherwise pull a
 * different tab forward between this and the event we are about to post.
 */
async function bringOnScreen(tab, hint = null) {
  let activation;
  try {
    activation = await B.activateChrome(tab, hint);
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError('activate_failed', `❌ 无法把 Chrome 切到最前面：${e.message}`);
  }
  if (activation.targetOnTop === false) {
    // Say what is in the way: another app, or another Chrome window (often another agent at work).
    let who = '';
    try {
      const bd = activation.bounds;
      const r = await B.cgevent(['windowsat', (bd.left + bd.width / 2).toFixed(1), (bd.top + Math.min(bd.height / 2, 300)).toFixed(1)]);
      const top = (r.windows || []).find(w => w.layer === 0);
      if (top) who = top.pid === activation.chromePid ? 'Chrome 的另一个窗口（可能是别的 agent 或你正在用它）' : `「${top.owner}」的窗口`;
    } catch {}
    throw new BridgeError('not_on_top',
      `❌ 没能把标签 ${activation.tabId} 切到屏幕最前面${who ? `：被${who}盖住了` : '（可能在切换过程中被人动过）'}，已放弃操作。请重试。`);
  }
  return activation;
}

/** prepare() for click / type_text: the target must be the key window with a known CG window number. */
async function prepareActivate(tab, hint = null) {
  // A new activation invalidates any earlier tab/window identity, including a
  // different tab in the same native Chrome window.
  NATIVE_TARGETS.clear();
  const away = await keepAgentAway(tab, USER_POINTER).catch(() => '');
  const a = await bringOnScreen(tab, hint);
  if (!a.keyWindowIsTarget) {
    throw new BridgeError('not_key_window',
      `❌ 标签 ${a.tabId} 的窗口已经切到前面，但系统报告的键盘焦点窗口不是它，` +
      '为了不把点击或按键送到别的窗口，没有操作。请重试。');
  }
  if (a.cgWindow == null) {
    throw new BridgeError('no_cg_window',
      `❌ 无法唯一确定标签 ${a.tabId} 所在的系统窗口（常见原因：两个 Chrome 窗口位置大小相同、当前网页的标题也相同，` +
      '或窗口在别的桌面空间），为了不点错窗口，没有操作。把其中一个窗口挪动一下后重试。');
  }
  return {
    chromePid: a.chromePid, cgWindow: a.cgWindow, windowBounds: boundsRect(a.bounds),
    target: a, touchesScene: true, ownNote: away + await ownershipNote(a)
  };
}

function locateScript(vars) {
  return B.pageScript('locate', { MARKER: null, MODE: 'target', SCROLL: false, DIR: null, ...vars });
}
async function locateTarget(marker, tab, { scroll = false } = {}) {
  await CALL.getStore()?.routineGuard?.();
  const loc = await B.evalInPage(await locateScript({ MARKER: marker, SCROLL: scroll }), tab);
  if (!loc.bounds) throw new BridgeError('no_window', '❌ 取不到 Chrome 窗口位置，无法换算屏幕坐标。');
  return loc;
}
/** @param bind  null | {set: token} | {check: token}: see src/page/after.js */
async function readAfter(marker, tab, expect = null, bind = null) {
  // Page payload only (focus, field, href): lean read, ~0.15 s cheaper per call.
  return B.evalInPage(await B.pageScript('after', { MARKER: marker ?? null, EXPECT: expect, BIND: bind }), tab, { lean: tab != null });
}

/** Refuse rather than act on a window model that does not hold (DevTools / side panel docked). */
function originFor(loc) {
  const origin = viewportOrigin(loc.bounds, loc.view);
  const geo = checkViewportGeometry(origin, loc.view);
  if (!geo.ok) throw new BridgeError(`bad_geometry_${geo.reason}`, geo.message);
  return origin;
}

/** The wheel lands where the pointer is: put it on this viewport point first. */
async function pointerTo(s, point, origin) {
  const context = CALL.getStore(), started = context?.routineInputStarted === true;
  await context?.routineGuard?.();
  context?.routineCheck?.();
  if (context?.routineGuard) context.routineInputStarted = true;
  try { return await s.request({ op: 'move', to: toScreen(point, origin), rect: squareToScreenRect(point, 20, origin) }); }
  catch (error) {
    if (context?.routineGuard && postedNothing('move', error)) context.routineInputStarted = started;
    throw error;
  }
}

const UNREACHABLE = {
  horizontal: '目标在横向可视区域之外（只模拟竖向滚轮）',
  not_scrollable: '目标被一个不能用滚轮滚动的区域裁掉了',
  at_limit: '需要滚动的区域已经滚到头了',
  no_progress: '滚轮没有让那个区域移动',
  no_pointer_spot: '找不到能让滚轮滚到那个区域的光标位置',
  too_many: `滚了 ${MAX_SCROLL_BURSTS} 串还没到位`
};

/**
 * Bring the aim point into view with wheel bursts (plan D1, codex #11):
 * outermost scroll box first, re-locating after each burst; at most
 * MAX_SCROLL_BURSTS. Progress is the target's own movement: a box that
 * scrolled without moving it (a fixed or stuck header) is not tried again.
 * If the wheel cannot get there and the aim is not already clickable, one
 * programmatic scrollIntoView({block:'nearest'}), reported as such.
 *
 * Nothing here posts input between the helper's requests, so a user who
 * takes over during the pauses is only seen at the next request: `status` is
 * asked after each pause and before the programmatic scroll (UserInterrupted).
 */
async function scrollToTarget(s, ctx, marker, tab, loc, allowWheel) {
  let bursts = 0, notches = 0, programmatic = false, reason = null, done = false;
  const exhausted = new Set(), pxByScroller = new Map();
  for (;;) {
    const step = planScrollStep(loc, { exhausted, pxByScroller });
    if (step.done) { done = true; break; }
    if (!allowWheel) break;
    if (bursts >= MAX_SCROLL_BURSTS && aimClickable(loc)) { done = true; break; }
    if (step.unreachable || bursts >= MAX_SCROLL_BURSTS) { reason = step.unreachable || 'too_many'; break; }
    await pointerTo(s, step.point, originFor(loc));
    CALL.getStore()?.routineCheck?.();
    const w = await s.request({ op: 'wheel', notches: step.notches, dir: step.dir });
    bursts++;
    notches += w.sent;
    ctx.step(`用真实滚轮滚了 ${bursts} 串（${notches} 格）`, 'wheel');
    // Let the smooth-scroll animation finish; also the pause between bursts.
    await sleep(between(300, 700));
    await s.request({ op: 'status' });
    const next = await locateTarget(marker, tab);
    const d = chainDelta(loc, next, step.index);
    const moved = next.rect && loc.rect ? next.rect.y - loc.rect.y : d;
    if (!d || !(Math.abs(moved) >= 1)) exhausted.add(step.key);
    else if (Number.isFinite(w.sent) && w.sent > 0) {
      pxByScroller.set(step.key, Math.min(400, Math.max(5, Math.abs(moved) / w.sent)));
    }
    loc = next;
  }
  if (!done && allowWheel && !CALL.getStore()?.routineRun) {
    await s.request({ op: 'status' });
    loc = await locateTarget(marker, tab, { scroll: true });
    programmatic = true;
    ctx.step('用程序滚动（scrollIntoView）把目标滚进了可视区');
  }
  return { loc, bursts, notches, programmatic, reason, done };
}

/** Poll the tab's URL (browser side, works mid-navigation) for a change; settle on the final one. */
async function waitForNavigation(tab, before, ms = 1500) {
  const deadline = Date.now() + ms;
  for (;;) {
    await sleep(300);
    try {
      const info = await B.chromeInfo(tab);
      if (info.url && info.url !== before) return settledUrl(tab, info.url);
    } catch { /* fall through to the page read */ }
    if (Date.now() >= deadline) return null;
  }
}

/* ------------------------------------------------ delivery acknowledgment */

/**
 * Longest wait for the page to report our click or key-ups before the front is
 * handed back anyway (impl-contract §7). There is no fixed delay otherwise.
 */
const ACK_CAP_MS = 300;
const newToken = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Arm the isolated-world listener (src/page/ack.js); null when the page could not be reached. */
async function armAck(tab) {
  const token = newToken();
  try {
    await B.evalInPage(await B.pageScript('ack', { ACK: { arm: token } }), tab, { lean: tab != null });
    return token;
  } catch {
    return null;
  }
}

/**
 * Poll the listener armed under `token` until one counter reaches its `need`,
 * the document was replaced (a navigation: the old page consumed the input),
 * or `capMs` passes. The listener goes away with the first two; after the cap
 * it is removed without waiting.
 * @returns {{seen:boolean, gone?:boolean, capped?:boolean, ms:number}}
 */
async function waitAck(tab, token, need, capMs = ACK_CAP_MS) {
  const t0 = Date.now();
  if (!token) return { seen: false, capped: true, ms: 0 };
  const read = async (disarm) => {
    try { return await B.evalInPage(await B.pageScript('ack', { ACK: { read: token, need, disarm } }), tab, { lean: true }); } catch { return null; }
  };
  for (;;) {
    const a = await read(false);
    const ms = Date.now() - t0;
    // Every page read also returns the tab's URL: callers reuse it instead of
    // a separate chromectl call (~0.4 s in the foreground, measured).
    const url = a && a.target ? a.target.url : undefined;
    if (a && a.met) return { seen: true, ms, url };
    if (a && !a.armed) return { seen: false, gone: true, ms, url };
    if (ms >= capMs) { read(true); return { seen: false, capped: true, ms, url }; }
    await sleep(25);
  }
}

/** Acknowledgement only; inputActionRun reports whether control was retained or released. */
function ackLine(ack, what, next = '') {
  const suffix = next ? `，${next}` : '';
  if (ack.seen) return `网页在 ${ack.ms} ms 内收到了这次${what}${suffix}`;
  if (ack.gone) return `网页在 ${ack.ms} ms 内换成了新文档（${what}已被处理）${suffix}`;
  return `⚠️ ${ACK_CAP_MS} ms 内没看到网页收到这次${what}的事件（网页可能拦下了它，或目标在内嵌框架里）` +
    (next ? `，等满上限后${next}` : '');
}

/* ---------------------------------------------------------------- click */

/**
 * Locate (no scrolling), wheel the target into view, arm the delivery
 * listener, click through the session and wait until the page has seen the
 * click (≤ ACK_CAP_MS). Nothing is observed here: that runs after the front
 * is handed back (clickReport). Runs inside an input action; `prep` is from
 * prepareActivate.
 */
async function clickDeliver(s, prep, ctx, { marker, scroll_into_view = true }, pre = null, { deferAck = false } = {}) {
  const tab = prep.target.tabId;
  const listBefore = pre ? pre.listBefore : await B.listTabs().catch(() => null);

  // Re-read the position once in the foreground (the preflight value may be
  // a few hundred ms old); everything else was prepared before activation.
  // The preflight position is reused when fresh: activation does not move the
  // page, the parked pointer caused no events, and the helper's last guard
  // still checks the window under the press point. Re-reading cost ~0.37 s of
  // foreground time (measured).
  let loc = pre && pre.loc && Date.now() - pre.at < PRE_LOC_FRESH_MS ? pre.loc : await locateTarget(marker, tab);
  ctx.mark('relocated');
  originFor(loc);
  const sc = await scrollToTarget(s, ctx, marker, tab, loc, scroll_into_view !== false);
  loc = sc.loc;
  // Also used by type_text: its focus click must not bypass click()'s guard.
  await guardNativeSelect(tab, { marker });
  const what = `[${marker}] <${loc.tag}> ${loc.text || '(无文字)'}`;
  // Wheel-scrolled targets must sit in the comfort zone, or be clickable where
  // no wheel can move them any more; without scrolling (scroll_into_view=false)
  // or after the programmatic fallback, visible is enough.
  const inView = sc.done || planScrollStep(loc, { rng: () => 0.5 }).done;
  if (!loc.visible || (scroll_into_view !== false && !inView && !sc.programmatic)) {
    throw new BridgeError('off_screen', scroll_into_view === false
      ? `❌ ${what} 不在可视区域内（scroll_into_view=false，没有滚动），没有点击。`
      : `❌ ${what} 滚动后仍不在可视区域内，没有点击。`);
  }
  if (!loc.hitOk) {
    throw new BridgeError('target_covered',
      `❌ ${what} 被「${loc.hitBy || '别的元素'}」盖住了（弹窗 / 悬浮条），为了不点到别的东西，没有点击。` +
      '先关掉遮挡物（重新 read_page 找它的编号）再试。');
  }

  const origin = originFor(loc);
  // The helper may press anywhere in the inner 80% of this rect, so it is the
  // part around the aim that locate.js hit-tested (loc.land). Without it: a
  // partly covered target lands near its uncovered point, else anywhere visible.
  const landIn = loc.land || (loc.aimAt === 'uncovered'
    ? intersectRect({ x: loc.aim.x - 6, y: loc.aim.y - 6, width: 12, height: 12 }, loc.visible) || loc.visible
    : loc.visible);
  const rect = rectToScreenRect(landIn, origin);
  const aim = toScreen(loc.aim, origin);
  await guardNativeTarget(prep, aim);
  const hrefBefore = loc.url;
  const token = pre && pre.token ? pre.token : await armAck(tab);
  ctx.mark('preClick');
  const c = await post(s, ctx, 'click', { op: 'click', rect, aim, clickCount: 1 });
  ctx.mark('clicked');
  ctx.step(`点击了 [${marker}]`);
  // Mouse events go to the window under the press, not to whatever app is in
  // front when they are processed, so the front can be handed back right
  // after mouseUp; the page's acknowledgment is awaited after the hand-back
  // (clickReport). Keys and paste still wait in front (they follow the front app).
  if (deferAck) {
    prep.lastUrl = null;   // the URL is read after the hand-back instead
    ctx.mark('acked');
    return { tab, marker, prep, listBefore, loc, sc, what, origin, hrefBefore, c, ack: null, token };
  }
  // A click before typing must have landed (focus in the field) before any key.
  const ack = await waitAck(tab, token, { click: 1, pointerup: 1 });
  if (ack.url !== undefined) prep.lastUrl = ack.url;
  ctx.mark('acked');
  return { tab, marker, prep, listBefore, loc, sc, what, origin, hrefBefore, c, ack, token };
}

/** What was clicked, where and how: known right after delivery. */
function clickLines(st, next = undefined) {
  const { loc, c, sc, prep } = st;
  const t = c.timing || {};
  return [
    `落点：屏幕 x=${c.landed.x}, y=${c.landed.y}（单位 point）；瞄准${loc.aimAt === 'label' ? '文字标签' : loc.aimAt === 'uncovered' ? '元素没被遮住的部分' : '元素中部'}；` +
      `元素可见部分 x=${Math.round(loc.visible.x)}, y=${Math.round(loc.visible.y)}, w=${Math.round(loc.visible.width)}, h=${Math.round(loc.visible.height)}（视口 CSS px）`,
    c.skippedMove
      ? `光标原本就在目标上，没有移动；反应 ${Math.round(t.reaction ?? 0)} ms、停顿 ${Math.round(t.dwell ?? 0)} ms 后按下，按住 ${Math.round(t.hold ?? 0)} ms`
      : `反应 ${Math.round(t.reaction ?? 0)} ms 后开始移动：${c.submovements} 段（${c.points} 个点），从开始移动到按下 ${Math.round(t.T ?? 0)} ms，按住 ${Math.round(t.hold ?? 0)} ms`,
    sc.bursts ? `点击前用真实滚轮滚了 ${sc.bursts} 串（共 ${sc.notches} 格）把目标滚进可视区` : '',
    sc.programmatic
      ? `⚠️ 使用了程序滚动：真实滚轮没能把目标滚到位（${UNREACHABLE[sc.reason] || sc.reason}），` +
        '改用 scrollIntoView（nearest）。这一步网页能看出不是滚轮滚的。'
      : '',
    `Chrome 已切到最前面（等待 ${prep.target.waitedMs ?? '?'} ms）；${ackLine(st.ack, '点击', next)}`
  ];
}

/**
 * Tabs that appeared during a click on a tab of mine, registered to me (create-only, claimTab):
 *  - the same conditions under which the click's own navigation counts as the agent's: the action
 *    ended without the user (noteable) and native routing confirms no keyboard/mouse input in
 *    the popup's window since the hand-back; not after a hand-over to the next agent (since null);
 *  - popupCandidates' window and URL rules;
 *  - its URL left to settle first, as open_tab does (a redirect is not taken for the user), and
 *    still there afterwards (a download tab that closed itself is not claimed);
 *  - opened by the clicked page (src/page/opener.js), recorded as `proof`: 'source' (a same-origin
 *    opener whose URL, or a referrer that, is the clicked page's URL), 'site' (a referrer of its
 *    origin only, as cross-origin links send), 'opener' (an opener we cannot read). A URL another
 *    program opened into the agent window during the click has neither; nor has a rel="noreferrer"
 *    link's tab: both are left unregistered as before.
 * A claimed popup is never closed by a sweep (src/tabs.js): a wrong claim at worst lists a tab as
 * the agent's; it is closed only by the owner's close_tab, with every takeover refusal.
 * @param obs  {noteable, since} from runInputAction's observation
 * @param srcUrl  the clicked tab's URL before the click
 * @returns {Promise<{mine: object[], theirs: object[]}>}  registered to me / found registered to another server
 */
async function claimPopups(listBefore, listAfter, prep, obs, srcUrl = null) {
  const none = { mine: [], theirs: [] };
  const src = prep.target.tabId;
  if (!obs || !obs.noteable || obs.since == null || !listBefore || !listAfter) return none;
  const srcRec = await getTab(src).catch(() => null);
  if (!isMine(srcRec) || srcRec.takenOver) return none;
  const srcLive = findLiveTab(listAfter, src) || findLiveTab(listBefore, src);
  const cands = popupCandidates(listBefore, listAfter, { srcWindowId: srcLive ? srcLive.windowId : prep.target.windowId });
  if (!cands.length) return none;
  const theirs = [], open = [];
  for (const c of cands) {
    const r = await getTab(c.tabId).catch(() => null);
    if (r && !isMine(r)) theirs.push(c); else if (!r) open.push(c);
  }
  // In parallel: each may take up to 6 s, under the input lock.
  const settled = await Promise.all(open.map(async (c) => ({ ...c, url: await settledUrl(c.tabId, c.url || 'about:blank') })));
  const mine = [];
  for (const c of settled) {
    if (!/^https?:\/\//i.test(c.url || '')) continue;
    const who = await B.evalInPage(await B.pageScript('opener'), c.tabId, { lean: true }).catch(() => null);
    if (!who) continue;   // gone already, or unreadable: not claimed
    const proof = popupProof(who, srcUrl);
    if (!proof) continue;
    if (!obs.untouched || !(await obs.untouched({ target: { tabId: c.tabId, windowId: c.windowId } }))) continue;
    if ((await legacyTabs().catch(() => [])).some(r => Number(r.tabId) === c.tabId)) continue;
    const ok = await claimTab(c.tabId, c.url, { windowId: c.windowId, agentName: agentName(), openedFrom: src, proof }).catch(() => false);
    if (!ok) { theirs.push(c); continue; }
    LEDGER.apply(c.tabId, { type: 'popup', url: c.url, title: c.title || null, from: src });
    mine.push(c);
  }
  return { mine, theirs };
}

export function __claimPopupsForTests(...a) { return claimPopups(...a); }

/**
 * How it is known the clicked page (at `srcUrl`) opened a tab, from src/page/opener.js:
 * 'source' > 'site' > 'opener', null when nothing says so. A referrer never carries the fragment.
 */
export function popupProof(who, srcUrl) {
  const noHash = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return null; } };
  const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };
  const src = srcUrl ? noHash(srcUrl) : null;
  if (src && ((who.openerUrl && noHash(who.openerUrl) === src) || (who.referrer && noHash(who.referrer) === src))) return 'source';
  if (srcUrl && who.referrer && origin(who.referrer) && origin(who.referrer) === origin(srcUrl)) return 'site';
  if (who.opener) return 'opener';
  return null;
}

/**
 * After the front was handed back: ask the page what actually changed. A
 * cross-site navigation keeps the OLD location.href until the new page
 * commits, so the tab's URL is polled browser-side first.
 * @param obs  {noteable, since} (runInputAction): whether tabs it opened may be registered as mine
 * @returns {Promise<{out:string, url:string|null}>}  url: the settled new URL, if it changed
 */
async function clickReport(st, obs = null) {
  // A page dialog opened by the click freezes the page: every read would wait for it (25 s each).
  const dlg = await B.pageDialog().catch(() => null);
  if (dlg && dlg.open) {
    const context = CALL.getStore();
    if (context) context.routineEvidence = { ok: false, code: 'page_dialog', confirmed: false };
    // The page cannot be asked whether it saw the click; the dialog it opened is the evidence.
    if (!st.ack) st.ack = { seen: true, ms: 0, viaDialog: true };
    return { out: [`✅ 已点击 ${st.what}`, targetLine(st.prep.target), st.prep.ownNote, ...clickLines(st), '', dialogNote(dlg)]
      .filter(x => x !== '').join('\n'), url: null };
  }
  if (!st.ack) st.ack = await waitAck(st.tab, st.token, { click: 1, pointerup: 1 });
  const { tab, marker, prep, listBefore, loc, what, origin, hrefBefore } = st;
  const navUrl = await waitForNavigation(tab, hrefBefore);
  let after = null, afterError = null;
  try { after = await readAfter(marker, tab); } catch (e) {
    afterError = e && e.message ? String(e.message).split('\n')[0] : String(e);
  }
  const hrefNow = navUrl || (after && after.href) || null;
  const hrefChanged = !!hrefNow && hrefNow !== hrefBefore;
  const listAfter = listBefore ? await B.listTabs().catch(() => null) : null;
  const newTabs = listBefore && listAfter ? diffNewTabs(listBefore, listAfter) : [];
  // My click moved my tab: the markers of my last read are gone (also when the user clicked since, unlike expectedUrl).
  // This reply prints the URL change and says to read again: no reminder line for it.
  if (hrefChanged) ledgerNavigated(tab, hrefNow, { reported: true });
  const claim = newTabs.length ? await claimPopups(listBefore, listAfter, prep, obs, hrefBefore) : { mine: [], theirs: [] };
  const popups = claim.mine;

  const { observed, reasons } = didClickRegister({
    hrefChanged, activeIsTarget: !!(after && after.activeIsTarget), hadFocusBefore: !!loc.hadFocus
  });
  const context = CALL.getStore();
  if (context) context.routineEvidence = { ok: newTabs.length === 0,
    confirmed: !afterError && newTabs.length === 0 && (st.ack?.seen === true || hrefChanged || observed),
    ...(newTabs.length ? { code: 'new_tab' } : {}) };
  const lines = [
    observed ? `✅ 已点击 ${what}` : `已点击，页面没有可观察的变化（不代表没生效）—— ${what}`,
    targetLine(prep.target),
    prep.ownNote,
    ...clickLines(st)
  ];
  if (after) {
    lines.push(
      `页面地址：${hrefChanged ? `${hrefBefore}  →  ${hrefNow}` : `${after.href}（未变化）`}`,
      `键盘焦点：${after.activeElement
        ? `<${after.activeElement.tag}>${after.activeElement.id ? '#' + after.activeElement.id : ''}` +
          `${after.activeElement.text ? ' ' + after.activeElement.text : ''}`
        : '无'}` + (after.activeIsTarget ? (loc.hadFocus ? '（就是刚点的元素，但点击前焦点已经在它上面）' : '（就是刚点的那个元素）') : '')
    );
  } else if (hrefChanged) {
    lines.push(`页面地址：${hrefBefore}  →  ${hrefNow}`);
  } else {
    lines.push(`⚠️ 点击后读不到页面状态，无法确认效果：${afterError}`);
  }
  if (observed) {
    lines.push(`判定依据：${reasons.join('；')}`);
  } else {
    lines.push('地址没变，焦点也没有新落到目标上。很多按钮（展开、点赞、切换）本来就不改地址也不拿焦点，',
      '所以这不代表没生效：需要确认时重新 read_page 看页面内容有没有变化。');
  }
  if (popups.length) {
    lines.push(`点击后新开了 ${popups.length} 个标签，已登记为你的标签（点击弹出的不会被自动关闭，用完请 close_tab）：` +
      popups.map(n => `tab=${n.tabId}（窗口 ${n.windowId}）${clip(n.title, 40) || clip(n.url, 60)}`).join('；') +
      `。读它：read_page(tab=${popups[0].tabId})。`);
  }
  if (claim.theirs.length) {
    lines.push(`点击后新出现的 ${claim.theirs.map(n => `tab=${n.tabId}`).join('、')} 已由另一个 agent 登记，不是你的。`);
  }
  const others = newTabs.filter(n => !popups.some(p => p.tabId === n.tabId) && !claim.theirs.some(p => p.tabId === n.tabId));
  if (others.length) {
    lines.push(`点击后新出现了 ${others.length} 个标签：` +
      others.map(n => `tab=${n.tabId}（窗口 ${n.windowId}）${clip(n.title, 40) || clip(n.url, 60)}`).join('；') +
      '。它们没有登记为 agent 标签，不会被自动关闭；要用就传 tab=…，用完可以请用户关。');
  }
  if (origin.scale !== 1) lines.push(`（页面缩放系数 ${origin.scale.toFixed(3)}，已换算）`);
  lines.push('', '提示：页面可能已经变化，需要新的元素编号时请重新调用 read_page。');
  return {
    out: lines.filter(x => x !== '').join('\n').replace(/\n(?=提示：)/, '\n\n'),
    url: hrefChanged ? hrefNow : null
  };
}

/**
 * Everything a click needs that does not need the foreground, done before
 * Chrome is activated: the target tab and its CG window (no activation),
 * the tab list for spotting new tabs, the target's position, and the
 * delivery listener. The session then starts watching the user before the
 * activation (runInputAction), so input during it cancels the click.
 */
async function clickPreflight(args) {
  const info = await B.chromeInfo(args.tab ?? null);
  const tab = info.tabId;
  const [listBefore, loc, token] = await Promise.all([
    B.listTabs().catch(() => null), locateTarget(args.marker, tab), armAck(tab)
  ]);
  const session = info.cgWindow != null
    ? { chromePid: info.chromePid, cgWindow: info.cgWindow, windowBounds: boundsRect(info.bounds) }
    : null;
  // Under takeover the pointer is the user's until the session holds it: no park before that.
  if (session && PARK_POINTER && !TAKEOVER) await parkPointer(loc).catch(() => {});
  return { tab, windowId: info.windowId, window: { bounds: info.bounds, tabActive: info.tabActive, minimized: info.minimized, url: info.url },
    listBefore, loc, token, session, at: Date.now() };
}

/** What a fresh pre-check already knows about the target window (lean activation). */
const activationHint = (pre) => pre && pre.windowId != null
  ? { windowId: pre.windowId, cgWindow: pre.session ? pre.session.cgWindow : null, ...(pre.window || {}) } : null;
const PRE_LOC_FRESH_MS = 1500;

/** Park the pointer near the target before activation (off: CHROME_BRIDGE_PARK=0). */
const PARK_POINTER = process.env.CHROME_BRIDGE_PARK !== '0';

/**
 * Measured: while Chrome is not the frontmost app the page receives no
 * pointer/mouse move events at all (0 events from two posted strokes over the
 * agent window). So before activating, the pointer is warped — which posts no
 * event (F13) — to a resting point 60–350 pt from the target inside the
 * viewport; after activation only the short final approach is seen, as when a
 * person switches back with the pointer already over the page. The user's
 * own pointer position is restored afterwards as before.
 */
async function parkPointer(loc) {
  if (!loc || !loc.visible || !loc.aim || !loc.view) return;
  const origin = originFor(loc);
  const w = Number(loc.view.innerWidth) || 0, h = Number(loc.view.innerHeight) || 0;
  if (w < 80 || h < 80) return;
  const d = lognormalMs(180, 0.4, 60, 350);
  const a = Math.random() * 2 * Math.PI;
  const x = Math.min(w - 20, Math.max(20, loc.aim.x + d * Math.cos(a)));
  const y = Math.min(h - 20, Math.max(20, loc.aim.y + d * Math.sin(a)));
  const p = toScreen({ x, y }, origin);
  await B.cgevent(['warp', Number(p.x).toFixed(1), Number(p.y).toFixed(1)]);
}

async function click(args, { signal = null } = {}) {
  return persist((idle) => inputAction(`click [${args.marker}]${args.tab != null ? ' tab ' + args.tab : ''}`,
    (pre) => prepareActivate(pre ? pre.tab : (args.tab ?? null), activationHint(pre)),
    async (s, prep, ctx, pre) => {
      const st = await clickDeliver(s, prep, ctx, args, pre, { deferAck: true });
      ctx.observe((obs) => clickReport(st, obs));
      return null;
    }, { preflight: async () => {
      const p = await clickPreflight(args);
      // A clicked <select> opens a system menu on macOS that blocks the page until it closes (live 2026-10-06).
      if (p.loc && p.loc.tag === 'select') await guardNativeSelect(p.tab, { marker: args.marker });
      return p;
    }, idle, veil: (pre) => veilFor('click', pre, null, args), task: taskKey(args) }), signal);
}

/* ------------------------------------------------------------ type_text */

async function temporalState(tab, request) {
  return B.evalInPage(await B.pageScript('temporal', { TEMPORAL: request }), tab, { lean: true });
}

/** Native calendar fields contain locale-dependent segments. Only AX-identified
 * segments receive keys; the DOM is used for validation and exact readback. */
async function typeTemporalInSession(s, prep, ctx, { text, submit, marker }, initial, token, preflight) {
  const tab = prep.target.tabId;
  let state = initial, sent = false;
  const fail = (code, detail) => {
    throw new BridgeError(code, `❌ ${detail}${sent ? '日期或时间可能已输入一部分，请先 read_page 确认当前值。' : '没有输入。'}`);
  };
  if (marker == null && !state.focused) fail('no_page_focus', '日期或时间输入框没有键盘焦点，');
  if (marker != null) {
    const loc = preflight?.loc || await locateTarget(marker, tab);
    await scrollToTarget(s, ctx, marker, tab, loc, true);
  }
  const refresh = async (extra = {}) => {
    const r = await temporalState(tab, { mode: 'status', token, ...extra });
    if (r.fail) fail('temporal_field_changed', '日期或时间输入框已改变、失效或被遮挡，');
    return r;
  };
  const layout = async () => {
    state = await refresh();
    const origin = originFor({ bounds: prep.target.bounds, view: state.view });
    const field = rectToScreenRect(state.rect, origin);
    if (!(field.w > 0 && field.h > 0)) fail('temporal_layout_unknown', '日期或时间输入框当前不可见，');
    let ax;
    try {
      ax = await B.axInput({ pid: prep.chromePid, window: prep.cgWindow,
        point: { x: field.x + field.w / 2, y: field.y + field.h / 2 } });
    } catch (e) {
      if (!sent) throw e;
      fail(e.code || 'ax_probe_failed', '后续原生控件检查失败，');
    }
    if (!ax || !ax.frontmost || !ax.windowMatches || ax.menuOpen || ax.nativePopup || ax.blocker) {
      fail('temporal_layout_unknown', '无法确认日期或时间输入框的原生分段，');
    }
    let parts;
    try { parts = planTemporalKeys(state.type, state.expected, ax.segments, field); }
    catch { fail('temporal_layout_unknown', '无法可靠识别日期或时间输入框的分段顺序，'); }
    return { parts, origin };
  };
  if (!state.selected) {
    let next = await layout();
    // Re-read before each segment: input handlers can move or replace the field.
    const kinds = next.parts.map(p => p.kind);
    for (let i = 0; i < kinds.length; i++) {
      if (i) next = await layout();
      const part = next.parts.find(p => p.kind === kinds[i]);
      if (!part) fail('temporal_layout_unknown', '日期或时间输入框的分段发生变化，');
      const aim = { x: part.rect.x + part.rect.w / 2, y: part.rect.y + part.rect.h / 2 };
      await refresh({ mode: 'aim', point: {
        x: (aim.x - next.origin.originX) / next.origin.scale,
        y: (aim.y - next.origin.originY) / next.origin.scale
      } });
      sent = true;
      await post(s, ctx, 'click', { op: 'click', rect: part.rect, aim, clickCount: 1 });
      state = await refresh();
      if (!state.focused) fail('wrong_field', '点击后键盘焦点不在同一个日期或时间输入框，');
      const r = await post(s, ctx, 'key', { op: 'type', text: part.text, firstDelay: i === 0 });
      if (r.typed !== typedCount(part.text)) fail('temporal_unconfirmed', '部分按键未确认送达，');
      ctx.step('已输入一个日期或时间分段', 'typed');
    }
    ctx.panel('confirm');
    const deadline = Date.now() + 2000;
    do {
      state = await refresh();
      if (state.selected) break;
      if (Date.now() >= deadline) fail('temporal_unconfirmed', '按键已发送，但字段中的有效值与请求不一致，');
      await sleep(100);
    } while (true);
  }
  const lines = [
    sent ? `✅ 已逐段按键输入，并确认日期或时间：${state.expected}` : `✅ 日期或时间已经是：${state.expected}`,
    targetLine(prep.target), prep.ownNote].filter(Boolean);
  if (!submit) return lines.join('\n');
  state = await refresh();
  if (!state.selected || !state.focused) {
    throw new BridgeError('submit_unconfirmed',
      ['❌ 未提交：准备按回车时，输入框的值或焦点变了，没有按回车。', ...lines].join('\n'));
  }
  const before = await readAfter(marker, tab);
  await post(s, ctx, 'enter', { op: 'key', name: 'return' });
  ctx.step('按了回车');
  lines.push('已按下回车。');
  ctx.observe(async () => {
    const nav = before.href ? await waitForNavigation(tab, before.href) : null;
    if (nav) { lines.push(`页面地址：${before.href}  →  ${nav}`); ledgerNavigated(tab, nav, { reported: true }); }
    return { out: lines.join('\n'), url: nav };
  });
  return null;
}

/**
 * Poll until the field checked before typing (bound by `token`) still has
 * keyboard focus and holds the new text (see src/page/after.js: changed since
 * the baseline, one more occurrence), or `ms` passes. A field that merely has
 * the same text after focus moved does not count.
 * @returns {Promise<{ok:boolean, focusMoved:boolean, changed:boolean|null, href:string|null}>}
 */
async function fieldConfirms(marker, tab, expect, token, ms = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let r = null;
    try { r = await readAfter(marker, tab, expect, { check: token }); } catch {}
    if (r && r.fieldHasText) return { ok: true, focusMoved: false, changed: true, href: r.href ?? null };
    if (Date.now() >= deadline) {
      return { ok: false, focusMoved: !!(r && r.focusMoved), changed: r ? r.changed ?? null : null, href: r ? r.href ?? null : null };
    }
    await sleep(200);
  }
}

/**
 * Click the field (optional), check focus, send the text per input_mode and
 * confirm it in that same field before reporting success or pressing Return.
 * Event delivery alone does not prove a field accepted the text. Verification
 * failures must throw inside the action, not become a successful observation.
 */
async function typeInSession(s, prep, ctx, { text, submit = false, marker = null, input_mode = 'keys' }, preflight = null) {
  const segs = typingSegments(text, input_mode);
  const tab = prep.target.tabId;
  const temporalToken = newToken();
  const temporal = await temporalState(tab, { mode: 'plan', marker, text, token: temporalToken });
  if (!temporal.fail) {
    if (input_mode === 'paste') throw new BridgeError('temporal_paste_unsupported',
      '❌ 这个日期或时间控件需要逐字键盘，暂不支持直接粘贴；没有点击或输入。请切换为逐字键盘后再试。');
    return typeTemporalInSession(s, prep, ctx, { text, submit, marker }, temporal, temporalToken, preflight);
  }
  if (temporal.fail === 'invalid_value') {
    throw new BridgeError('invalid_temporal_value', '❌ 日期或时间须使用有效的标准格式（例如 2026-10-20 或 13:45），并符合输入框的范围和步长限制；没有输入。');
  }
  if (temporal.fail === 'disabled') {
    throw new BridgeError('disabled_field', '❌ 日期或时间输入框已禁用或只读，没有输入。');
  }
  const lines = [];
  if (marker != null) {
    const st = await clickDeliver(s, prep, ctx, { marker }, preflight);
    lines.push(`已点击 ${st.what}`, targetLine(prep.target), prep.ownNote, ...clickLines(st, '接着输入'), '');
  } else {
    lines.push(targetLine(prep.target), prep.ownNote);
  }

  // The page must have keyboard focus, on the intended field (codex #4, #13).
  // Activation is asynchronous, so give document.hasFocus() up to ~1 s. The
  // field seen here is remembered in the isolated world under `token`, with
  // its content as the baseline, and every later check is made against it.
  const token = newToken();
  let f = null;
  for (let i = 0; i < 6; i++) {
    f = await readAfter(marker, tab, null, { set: token });
    if (f.hasFocus) break;
    await sleep(200);
  }
  const say = (m) => [m, ...lines].filter(Boolean).join('\n');
  if (!f.hasFocus) {
    throw new BridgeError('no_page_focus', say(
      '❌ 网页没有拿到键盘焦点（焦点可能在地址栏或别处），为了不把字打到别的地方，没有输入。' +
      (marker == null ? '带上 marker 先点一下输入框再试。' : '')));
  }
  const fieldOk = marker != null ? f.activeIsTarget && f.activeEditable : f.activeEditable;
  if (!fieldOk) {
    const now = f.activeElement ? `<${f.activeElement.tag}>${f.activeElement.text ? ' ' + f.activeElement.text : ''}` : '没有元素';
    throw new BridgeError('wrong_field', say(marker != null
      ? `❌ 点了 [${marker}] 之后，键盘焦点在 ${now} 上，不是可以输入的 [${marker}]，没有输入。`
      : `❌ 当前键盘焦点在 ${now} 上，不是输入框，没有输入。带上 marker 指定要输入的框再试。`));
  }

  const typedText = segs.filter(x => x.mode === 'type').map(x => x.text).join('');
  const keyToken = null;   // key delivery comes from the system's routing record (op 'routed')
  let expect = '', typed = 0, pasted = 0, pasteRuns = 0, delivered = true, conf = null;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.mode === 'type') {
      if (i > 0) await sleep(lognormalMs(220, 0.4, 80, 700));
      const r = await post(s, ctx, 'key', { op: 'type', text: seg.text, firstDelay: i === 0 }, { timeoutMs: 300_000 });
      typed += r.typed;
      if (r.typed !== typedCount(seg.text)) delivered = false;
      ctx.step(`逐键发送了 ${typed} 个字符`, 'typed');
      expect += seg.text.replace(/\t/g, '    ');
    } else {
      // Focus to first key, as for typing (plan A5); a shorter pause between runs.
      // Click the field, then Cmd+V right away: a person's paste follows the click quickly.
      await sleep(i === 0 ? lognormalMs(300, 0.35, 150, 900) : lognormalMs(220, 0.4, 80, 700));
      await post(s, ctx, 'paste', { op: 'paste', text: seg.text });
      pasted += [...seg.text].length;
      pasteRuns++;
      ctx.step(segs.length === 1 ? '整段粘贴了文字' : `粘贴了 ${pasted} 个非英文字符`, 'pasted');
      expect += seg.text;
      // The page must have read this run before the next one changes the
      // clipboard or types after it.
      if (i < segs.length - 1) {
        conf = await fieldConfirms(marker, tab, expect, token);
        if (!conf.ok) break;
      }
    }
  }
  // Keys: the system's own routing record (annotated session tap) says when
  // every key has been assigned to a process — atomic, ~20 ms — instead of
  // polling the page for key-ups (~220 ms). The field still has to confirm
  // the resulting value before this operation can succeed.
  let keyAck = null;
  ctx.panel('confirm');
  if (typedText && !(conf && !conf.ok)) {
    const rt = await s.request({ op: 'routed' }, { raw: true }).catch(() => null);
    keyAck = rt && rt.ok !== undefined
      ? { routed: true, seen: rt.ok && rt.allToChrome, ms: rt.ms, misrouted: rt.ok && !rt.allToChrome }
      : await waitAck(tab, keyToken, { keyup: keyupCount(typedText) });
  }

  const how = input_mode === 'keys'
    ? `逐键输入 ${typed} 个字符`
    : `一次 Cmd+V 整段粘贴 ${[...text].length} 个字符`;
  const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  const unconfirmed = (c, clipNote) => [
    !delivered
      ? `❌ 未确认已输入：${how}${clipNote}，部分按键未确认完整送达，请先检查输入框里的内容。`
      : c.focusMoved
      ? `❌ 未确认已输入：${how}${clipNote}，但键盘焦点已经离开了刚才输入的那个框（网页把焦点移走了）。`
      : c.changed === false
        ? `❌ 未确认已输入：${how}${clipNote}，但输入框的内容没有变化（网页可能拦截了输入）。`
        : `❌ 未确认已输入：${how}${clipNote}，但 2 秒内没在输入框里看到新输入的这段文字（网页可能拦截或改写了输入）。`,
    `内容：${preview}`, submit ? '因此没有按回车提交。' : '', '需要确认时请重新 read_page 看输入框里的内容。'];
  const keyLine = !keyAck ? '' : keyAck.routed
    ? (keyAck.seen ? `系统在 ${keyAck.ms} ms 内确认全部按键都已交给 Chrome`
                   : keyAck.misrouted ? '⚠️ 系统显示有按键被交给了 Chrome 以外的程序，请检查输入是否完整'
                   : '⚠️ 150 ms 内没等到系统确认全部按键已交给 Chrome')
    : ackLine(keyAck, '逐键输入的最后一次松键');

  if (keyAck && keyAck.routed && !keyAck.seen) delivered = false;

  // The text must be in the field before the clipboard goes back (Chrome may
  // read it late) and before any submit (codex #13).
  if (!conf || conf.ok) conf = await fieldConfirms(marker, tab, expect, token);
  let clipNote = '';
  if (pasteRuns) {
    const rc = await s.request({ op: 'restoreClipboard' });
    if (rc.restored) { ctx.step('剪贴板已还原'); clipNote = '，你的剪贴板已还原'; }
    else if (rc.reason === 'changed') clipNote = '，⚠️ 剪贴板在此期间被别的程序改过，没有覆盖回去';
  }
  if (!conf.ok || !delivered) {
    ctx.panel('confirm', 'fail');
    throw new BridgeError('input_unconfirmed',
      [...unconfirmed(conf, clipNote), ...lines, keyLine].filter(Boolean).join('\n'));
  }
  lines.unshift(`✅ 已输入并在输入框里确认：${how}${clipNote}`, `内容：${preview}`);
  lines.push(keyLine);
  if (!submit) return lines.filter(x => x !== '').join('\n');

  // Return goes to whatever has focus: check once more that it is still
  // the same field, with the text, right before pressing.
  const pre = await readAfter(marker, tab, expect, { check: token }).catch(() => null);
  if (!pre || !pre.fieldHasText) {
    ctx.panel('submit', 'fail');
    throw new BridgeError('submit_unconfirmed',
      ['❌ 未提交：准备按回车时，键盘焦点已经不在刚才输入的那个框里（或框里的文字变了），没有按回车。',
        ...lines].filter(Boolean).join('\n'));
  }
  const hrefBefore = pre.href ?? null;
  const enterToken = await armAck(tab);
  await post(s, ctx, 'enter', { op: 'key', name: 'return' });
  ctx.step('按了回车');
  const rtE = await s.request({ op: 'routed' }, { raw: true }).catch(() => null);
  const enterAck = rtE && rtE.ok !== undefined ? null : await waitAck(tab, enterToken, { keyup: 1 });
  lines.push(`✅ 并已按下回车；${enterAck ? ackLine(enterAck, '回车') : rtE.ok && rtE.allToChrome ? `系统在 ${rtE.ms} ms 内确认回车已交给 Chrome` : '⚠️ 没能确认回车已交给 Chrome'}`);
  ctx.observe(async () => {
    const nav = hrefBefore ? await waitForNavigation(tab, hrefBefore) : null;
    if (nav) { lines.push(`页面地址：${hrefBefore}  →  ${nav}`); ledgerNavigated(tab, nav, { reported: true }); }
    return { out: lines.filter(x => x !== '').join('\n'), url: nav };
  });
  return null;
}

async function typeText(args, { signal = null } = {}) {
  if (typeof args.text !== 'string' || !args.text) throw new BridgeError('empty_text', '❌ text 不能为空。');
  if (!args.text.trim()) {
    throw new BridgeError('blank_text', '❌ text 只有空白字符：输入框里无法确认它有没有输进去，没有输入。');
  }
  const resolveMode = () => {
    const preference = S.setting('inputMode');
    const mode = preference.value === 'auto' ? args.input_mode ?? 'keys' : preference.value;
    if (!INPUT_MODES.includes(mode)) {
      throw new BridgeError('bad_input_mode', `❌ input_mode 只能是 ${INPUT_MODES.join(' 或 ')}。`);
    }
    try { typingSegments(args.text, mode); }
    catch (e) {
      if (e.code === 'unsupported_key_text' && preference.value === 'keys') {
        throw new BridgeError(e.code, preference.source === 'env'
          ? '❌ 输入方式由 CHROME_BRIDGE_INPUT_MODE 固定为逐字键盘，这段文字含暂不支持的字符，没有输入。需要粘贴时请更新此配置，不会自动切换。'
          : '❌ MyChrome 设置已选择逐字键盘，这段文字含暂不支持的字符，没有输入。需要粘贴时请在设置里选择直接粘贴，不会自动切换。');
      }
      throw e;
    }
    return mode;
  };
  let mode = resolveMode();
  // Validate the whole text before taking over or clicking a field. No partial
  // keystrokes and no silent clipboard fallback for unsupported characters.
  const withMarker = args.marker != null;
  const preflight = async () => {
    mode = resolveMode();
    if (mode === 'paste') {
      const target = await temporalState(args.tab ?? null, {
        mode: 'plan', marker: args.marker ?? null, text: args.text, token: newToken(),
      });
      if (!target.fail || target.fail === 'invalid_value' || target.fail === 'disabled') {
        throw new BridgeError('temporal_paste_unsupported',
          '❌ 这个日期或时间控件需要逐字键盘，暂不支持直接粘贴；没有点击或输入。请切换为逐字键盘后再试。');
      }
    }
    return withMarker ? clickPreflight(args) : null;
  };
  return persist((idle) => inputAction(`type${args.tab != null ? ' tab ' + args.tab : ''}`,
    (pre) => prepareActivate(pre ? pre.tab : (args.tab ?? null), activationHint(pre)),
    (s, prep, ctx, pf) => {
      // A GUI preference may change while this action waits for physical input.
      // Recheck before typeInSession can click the field or send any text.
      mode = resolveMode();
      return typeInSession(s, prep, ctx, { ...args, input_mode: mode }, pf);
    },
    withMarker ? { preflight, idle, veil: (pre) => veilFor('type', pre, null, { ...args, input_mode: mode }), task: taskKey(args) }
      : { preflight, idle, veil: () => veilFor('type', null, null, { ...args, input_mode: mode }), task: taskKey(args) }), signal);
}

/* -------------------------------------------------------- select_option */

function refuseNativeSelect(marker = null) {
  throw new BridgeError('use_select_option', `❌ ${marker != null ? `[${marker}]` : '目标'}是下拉框（<select>），操作会打开挡住 Chrome 的系统菜单，这次没有操作。` +
    (marker == null ? '先 read_page 找到下拉框编号，再用 select_option（marker + option）。' : '改用 select_option（marker + option）。'));
}

async function guardNativeSelect(tab, { marker = null, point = null, bounds = null } = {}) {
  const r = await B.evalInPage(await B.pageScript('native-select', {
    MODE: point ? 'point' : marker != null ? 'marker' : 'focus', MARKER: marker, POINT: point, BOUNDS: bounds
  }), tab, { lean: true });
  if (r.nativeSelect) refuseNativeSelect(r.marker);
}

const NATIVE_TARGETS = new Map();
const NATIVE_TARGET_MS = 15_000;
export function __resetNativeTargetsForTests() { NATIVE_TARGETS.clear(); }

function rememberNativeTarget(prep, probe) {
  if (!probe.frontmost || !probe.windowMatches || typeof probe.documentToken !== 'string') return;
  NATIVE_TARGETS.clear();
  NATIVE_TARGETS.set(Number(prep.target.tabId), {
    pid: prep.chromePid, window: prep.cgWindow, documentToken: probe.documentToken, at: Date.now()
  });
}

/** AX adds cross-origin iframe and closed-shadow coverage without excluding
 * those ordinary visual controls. It reads roles/geometry, never field values. */
async function guardNativeTarget(prep, point = null) {
  const probe = await B.axInput({ pid: prep.chromePid, window: prep.cgWindow, point });
  if (probe.blocker) {
    throw new BridgeError('target_covered', `❌ 目标位置被「${probe.blocker.appName || '另一个应用'}」窗口盖住了，没有点击。请把遮挡窗口移开，或调整 Chrome 窗口后重新 screenshot。`);
  }
  if (!probe.frontmost || !probe.windowMatches || !probe.nodeFound) {
    throw new BridgeError('native_target_changed', '❌ 原生控件不再属于已验证的前台 Chrome 窗口，没有输入。请重新 screenshot 或 read_page。');
  }
  rememberNativeTarget(prep, probe);
  if (probe.nativePopup) refuseNativeSelect();
  return probe;
}

/** A single Esc recovery has no Apple Events, activation, automatic retry or
 * task continuation. Without page identity, only a proven absence of native menus
 * permits the ordinary guarded Escape path; recovery itself still requires the mapping. */
async function recoverNativeMenu(args, signal) {
  const task = taskKey(args);
  const check = () => {
    pausedCheck();
    if (signal && signal.aborted) throw cancelledError();
    if (TASK_CANCELLED && (!task || TASK_CANCELLED === task)) throw taskCancelledError();
    if (BLOCKS.has(Number(args.tab))) throw new BridgeError('site_blocked',
      '⏸️ 这个标签正在等待用户处理，未发送 Esc。请调用 wait_for_user；不要重试或换工具绕过。');
  };
  check();
  const missing = () => new BridgeError('native_recovery_unavailable',
    '❌ 没有这个标签最近 15 秒内的原生窗口和页面身份，无法安全关闭系统菜单。请用户手动按 Esc，再重新 screenshot 或 read_page。');
  const cached = NATIVE_TARGETS.get(Number(args.tab));
  if (!cached || Date.now() - cached.at > NATIVE_TARGET_MS || TASK_HOLD) {
    const state = await B.axMenuState().catch(() => null);
    check();
    // This only selects the normal path, which verifies the requested tab before posting.
    // A menu or an unknown native state never falls through to an Apple Event.
    if (state?.known === true && state.menuOpen === false) return null;
    if (!TASK_HOLD) throw missing();
  }
  // A retained job already owns the lock; re-entering it would deadlock. Its
  // normal end may send Apple Events, so leave it untouched and ask for Esc.
  if (TASK_HOLD) throw new BridgeError('native_recovery_unavailable',
    '❌ 任务仍持有键盘鼠标，不能安全切换到菜单恢复。请用户按 Esc 关闭菜单；不要自动重试。');
  const result = await withInputLock(`dismiss native menu tab ${args.tab}`, async () => {
    check();
    if (NATIVE_TARGETS.get(Number(args.tab)) !== cached || Date.now() - cached.at > NATIVE_TARGET_MS) throw missing();
    const since = Date.now();
    const probe = await B.axInput({ pid: cached.pid, window: cached.window });
    if (!probe.frontmost || !probe.windowMatches || probe.focusedDocumentToken !== cached.documentToken) {
      NATIVE_TARGETS.delete(Number(args.tab));
      throw missing();
    }
    if (!probe.menuOpen) return null;
    if (!probe.nativeMenuOpen) throw missing();
    check();
    await B.cgevent(['escape-menu', cached.pid, cached.window, cached.documentToken, since]);
    NATIVE_TARGETS.delete(Number(args.tab));
    const after = await B.axInput({ pid: cached.pid, window: cached.window }).catch(() => null);
    if (!after || after.menuOpen || !after.frontmost || !after.windowMatches ||
        after.focusedDocumentToken !== cached.documentToken) {
      return '⚠️ 只发送了一次 Esc，但尚未确认同一页面的菜单关闭。请用户确认；不要重复发送或继续任务。';
    }
    return '✅ 已发送一次 Esc，并确认原生菜单关闭。请重新 read_page 检查页面和网站限制，再决定下一步。';
  }, { info: lockInfo(task), signal });
  return result.result;
}

const SELECT_ERRORS = {
  stale_marker: (m) => `❌ 编号 [${m}] 已经失效（页面变了），请重新 read_page。`,
  not_select: (m, r) => `❌ [${m}] 是 <${r.tag}>，不是下拉框（<select>）。普通按钮或自制下拉菜单用 click。`,
  multiple: (m) => `❌ [${m}] 是可以多选的列表框，select_option 只选单个选项。`,
  disabled: (m, r) => `❌ [${m}] 的选项「${r.text || ''}」或整个下拉框被禁用了，没有操作。`,
  no_option: (m, r, o) => `❌ [${m}] 里没有「${o}」这个选项。现有选项：${(r.options || []).join(' / ')}`
};

/**
 * Focus the select (its menu stays closed), type the option's type-ahead with real keys, check the
 * page shows it. A failed keyboard attempt never falls back to a DOM value write.
 */
async function selectInSession(s, prep, ctx, { marker, option }) {
  const tab = prep.target.tabId;
  const run = async (mode) => B.evalInPage(await B.pageScript('select', { MARKER: marker, OPTION: option, MODE: mode }), tab);
  const failed = (r) => new BridgeError(r.fail === 'stale_marker' ? 'stale_marker' : 'bad_select',
    (SELECT_ERRORS[r.fail] || (() => `❌ 下拉框 [${marker}] 出错：${r.fail}`))(marker, r, option));
  let plan = await run('plan');
  if (plan.fail) throw failed(plan);
  const head = [targetLine(prep.target), prep.ownNote];
  if (plan.current === plan.index) return head.concat(`下拉框 [${marker}] 本来就是「${plan.text}」，没有改动。`).filter(x => x !== '').join('\n');
  for (let i = 0; i < 6 && !(plan.focused && plan.hasFocus); i++) {
    await sleep(200);
    plan = await run('plan');
    if (plan.fail) throw failed(plan);
  }
  let how = null;
  if (plan.focused && plan.hasFocus && /^[\x20-\x7e]+$/.test(plan.typeahead || '')) {
    await post(s, ctx, 'key', { op: 'type', text: plan.typeahead, firstDelay: false });
    ctx.step(`键盘输入了选项「${plan.text}」`);
    ctx.panel('confirm');
    const c = await run('check');
    if (!c.fail && c.selected) how = 'keys';
  }
  if (!how) {
    throw new BridgeError('select_failed', `❌ 键盘未确认把下拉框 [${marker}] 选成「${plan.text}」，没有改用网页脚本。请重新读取当前选项。`);
  }
  return head.concat(`✅ 下拉框 [${marker}] 已选「${plan.text}」（用键盘选中，没有打开下拉菜单，页面已确认）`)
    .filter(x => x !== '').join('\n');
}

async function selectOption(args, { signal = null } = {}) {
  if (typeof args.option !== 'string' || !args.option.trim()) throw new BridgeError('empty_option', '❌ option 不能为空。');
  return persist((idle) => inputAction(`select [${args.marker}]${args.tab != null ? ' tab ' + args.tab : ''}`,
    (pre) => prepareActivate(pre ? pre.tab : (args.tab ?? null), activationHint(pre)),
    (s, prep, ctx) => selectInSession(s, prep, ctx, args),
    { preflight: () => clickPreflight(args), idle, veil: (pre) => veilFor('select', pre, null, args), task: taskKey(args) }), signal);
}

/* ------------------------------------------------- fallback: look and point */

/**
 * The last screenshot per tab: which screen rect it shows, its size (the coordinates the agent
 * was given) and its text lines by id (t1…, centre points in those coordinates), for click_at.
 */
const SHOTS = new Map();
export function __resetShotsForTests() { SHOTS.clear(); }
const SHOT_FRESH_MS = 5 * 60_000;
const FALLBACK_CODES = new Set(['no_such_marker', 'stale_marker', 'target_covered', 'off_screen',
  'wrong_field', 'no_page_focus', 'chromectl_failed', 'bad_page_result']);
// computer use grants browsers the "read" tier (it can see Chrome, never click or type in it): not a way to click here.
const FALLBACK_HINT = '\n看不到或点不到时：screenshot 读出画面上的字和坐标，再 click_at（或 press_key）；仍然不行，可以改用 Claude in Chrome' +
  '（要先选好它连的浏览器；它和 MyChrome 不排队，换过去前确认没有别的 agent 在操作）。computer use 只能看浏览器、不能点，不要用它点网页。';

/** Rough token counts (the measure.md rule): a CJK character 1, other text 3.5 characters; a picture w×h/750. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
export function estimateTextTokens(s) {
  let cjk = 0, other = 0;
  for (const ch of String(s)) { if (CJK.test(ch)) cjk++; else other++; }
  return Math.ceil(cjk + other / 3.5);
}
export const estimateImageTokens = (w, h) => Math.round(w * h / 750);

/**
 * OCR lines (full-resolution pixels) → the picture's coordinates (× sx, sy), grouped into rows
 * (centres within half a line height) read left to right, rows top to bottom; ids t1… in that
 * order. A new paragraph starts after a vertical gap of more than ~0.6 line or when the rows do
 * not overlap sideways. Each line keeps its own id and centre.
 * @returns {{rows: Array<Array<{id,text,x,y,conf}>>, breaks: boolean[], texts: Map}}
 */
export function layoutText(lines, sx = 1, sy = 1) {
  const items = (lines || []).filter(l => l && String(l.text || '').trim()).map(l => ({
    text: String(l.text).trim(), conf: l.conf ?? 1,
    l: l.x * sx, t: l.y * sy, w: l.w * sx, h: Math.max(1, l.h * sy)
  })).map(o => ({ ...o, cx: o.l + o.w / 2, cy: o.t + o.h / 2 }));
  items.sort((a, b) => a.cy - b.cy || a.l - b.l);
  const rows = [];
  for (const it of items) {
    const row = rows.at(-1);
    if (row && Math.abs(it.cy - row.cy) <= 0.5 * Math.min(it.h, row.h)) { row.items.push(it); continue; }
    rows.push({ cy: it.cy, h: it.h, items: [it] });
  }
  const texts = new Map();
  let n = 0;
  const out = rows.map(r => {
    r.items.sort((a, b) => a.l - b.l);
    r.top = Math.min(...r.items.map(i => i.t));
    r.bottom = Math.max(...r.items.map(i => i.t + i.h));
    r.left = Math.min(...r.items.map(i => i.l));
    r.right = Math.max(...r.items.map(i => i.l + i.w));
    return r.items.map(i => {
      const id = `t${++n}`;
      const e = { id, text: i.text, x: Math.round(i.cx), y: Math.round(i.cy), conf: i.conf };
      texts.set(id, e);
      return e;
    });
  });
  const breaks = rows.map((r, k) => {
    if (!k) return false;
    const p = rows[k - 1];
    const lineH = Math.max(p.bottom - p.top, r.bottom - r.top);
    return r.top - p.bottom > 0.6 * lineH || r.left > p.right || r.right < p.left;
  });
  return { rows: out, breaks, texts };
}

/** The text block of a screenshot result: one row per line, rows of one paragraph together, a blank line between paragraphs. */
function textBlock(layout) {
  const lines = [];
  layout.rows.forEach((row, k) => {
    if (layout.breaks[k]) lines.push('');
    lines.push(row.map(e => `${e.id} (${e.x},${e.y}) ${e.text}${e.conf < 0.5 ? ' (?)' : ''}`).join(' | '));
  });
  return lines.join('\n');
}

/** Recognise the text of a capture (after the keyboard and mouse are handed back) and remember it for click_at. */
async function readShot(shot, tabId) {
  let layout = null, error = null;
  try {
    const o = await B.ocrImage(shot.fullPath);
    layout = layoutText(o.lines, shot.width / (o.width || shot.fullWidth), shot.height / (o.height || shot.fullHeight));
  } catch (e) { error = String((e && e.message) || e).split('\n')[0].replace(/^❌\s*/, '').slice(0, 160); }
  SHOTS.set(tabId, { rect: shot.rect, width: shot.width, height: shot.height, at: Date.now(), texts: layout ? layout.texts : new Map() });
  return { layout, error };
}

/** Capture only a proven visible tab, without changing another agent's input
 * turn. Pin and recheck browser/native identity around the capture; never fall
 * back to a screen region which could expose a different app or tab. */
async function readOnlyCapture(args, signal = null, expectedTarget = null) {
  let shot = null, tabId = null;
  const check = () => {
    pausedCheck();
    if (signal?.aborted) throw cancelledError();
  };
  const screen = async () => {
    const state = await B.cgevent(['displays']).catch(() => null);
    if (!state || typeof state.locked !== 'boolean' || typeof state.displaysAsleep !== 'boolean' || !Array.isArray(state.displays)) {
      throw new BridgeError('screen_state_unknown', '❌ 无法确认屏幕是否可用，这次没有截图。可先用 read_page 读取网页。');
    }
    if (state.locked) throw new BridgeError('screen_locked', '⏸ 屏幕锁着，这次没有截图。需要用户解锁后再看画面。');
    if (state.displaysAsleep || !state.displays.length) throw new BridgeError('displays_asleep',
      '⏸ 显示器未亮，这次没有截图或唤醒屏幕。可用 read_page 读取网页，或等屏幕亮起后再截图。');
  };
  const same = (a, b) => b && b.tabActive === true && b.minimized === false &&
    ['tabId', 'windowId', 'chromePid', 'cgWindow', 'url'].every(k => a[k] === b[k]) &&
    ['left', 'top', 'width', 'height'].every(k => a.bounds?.[k] === b.bounds?.[k]);
  try {
    check();
    if (args.tab != null) { SHOTS.delete(Number(args.tab)); NATIVE_TARGETS.delete(Number(args.tab)); }
    await screen();
    const before = await B.chromeInfo(args.tab ?? null);
    tabId = before?.tabId;
    if (tabId != null) { SHOTS.delete(tabId); NATIVE_TARGETS.delete(Number(tabId)); }
    if (![tabId, before?.windowId, before?.chromePid, before?.cgWindow].every(x => Number.isSafeInteger(x) && x > 0) ||
        (args.tab != null && Number(args.tab) !== tabId) ||
        typeof before.url !== 'string' || !before.url || !before.bounds ||
        !['left', 'top', 'width', 'height'].every(k => Number.isFinite(before.bounds[k])) ||
        before.bounds.width <= 0 || before.bounds.height <= 0) {
      throw new BridgeError('no_cg_window', '❌ 无法唯一确认目标标签及其系统窗口，这次没有截图。先用 list_tabs / read_page 核对目标。');
    }
    if (before.tabActive !== true || before.minimized !== false) throw new BridgeError('tab_hidden',
      `❌ 标签 ${tabId} 当前没有显示在它的窗口中${before.minimized ? '（窗口已最小化）' : ''}，这次没有截图。` +
      '用 read_page 读取内容，或等该标签显示后再截图；截图不会切换标签或接管键鼠。');
    if (expectedTarget && ['tabId', 'windowId', 'url'].some(k => expectedTarget[k] == null || expectedTarget[k] !== before[k])) {
      throw new BridgeError('screenshot_changed', '❌ 读取网页后目标标签或地址已经变化，这次没有截图。');
    }
    await siteGate(tabId);
    check();
    shot = await B.captureWindow({ cgWindow: before.cgWindow });
    // AX only supplies evidence for a later guarded native-menu recovery. A
    // missing/occluded/unfocused probe never grants permission to send Escape.
    const b = boundsRect(before.bounds);
    const native = await B.axInput({ pid: before.chromePid, window: before.cgWindow,
      point: { x: b.x + b.w / 2, y: b.y + b.h / 2 } }).catch(() => null);
    const after = await B.chromeInfo(tabId);
    await screen();
    check();
    if (!same(before, after)) throw new BridgeError('screenshot_changed',
      '❌ 截图期间目标标签或窗口已经变化，这次图像已丢弃。先用 read_page 核对页面，等目标稳定后再截图。');
    const own = await ownershipNote(after);
    if (native?.ok === true && native.pid === after.chromePid && native.expectedWindow === after.cgWindow &&
        native.nodeFound === true && !native.blocker) {
      rememberNativeTarget({ target: after, chromePid: after.chromePid, cgWindow: after.cgWindow }, native);
    }
    const r = shot.rect;
    const head = [targetLine(after), own,
      `画面：${shot.width}×${shot.height} 像素，是标签 ${tabId} 所在窗口现在的样子（屏幕 x=${Math.round(r.x)}, y=${Math.round(r.y)}, ${Math.round(r.w)}×${Math.round(r.h)} point）；` +
        `只截了这个窗口${shot.popups ? `和它自己的 ${shot.popups} 个弹出层` : ''}，盖在上面的别的窗口不在图里。`,
      '（只读截图，没有切换窗口、标签或接管键鼠）',
      shot.aspectOff ? '⚠️ 截图的长宽比和窗口对不上，按坐标点击可能有偏差；能用 read_page 的编号就用编号。' : ''
    ].filter(Boolean).join('\n');
    return { head, shot, tabId, target: after, own };
  } catch (e) {
    if (shot) await shot.dispose();
    throw e;
  }
}

async function screenshotTool(args, { signal = null } = {}) {
  let cap = null;
  const wantImage = args.image === true;
  try {
    cap = await readOnlyCapture(args, signal);
    const { head, shot, tabId } = cap;
    // OCR is local and read-only; no native input hold exists for this capture.
    const { layout, error: ocrError } = await readShot(shot, tabId);
    const n = layout ? layout.texts.size : 0;
    const chars = layout ? [...layout.texts.values()].reduce((a, e) => a + e.text.length, 0) : 0;
    const parts = [head, ''];
    if (ocrError) parts.push(`本地识字失败（${ocrError}）。${wantImage ? '' : '要看画面就加 image: true 再截一次。'}`);
    else if (!n) parts.push(`画面上没有识别到文字。${wantImage ? '' : '要看图标、图形就加 image: true 再截一次。'}`);
    else {
      const unsure = [...layout.texts.values()].some(e => e.conf < 0.5);
      parts.push(`识别到的文字（${n} 行；括号里是该行中心在画面上的坐标${unsure ? '；带 (?) 的行识别没把握' : ''}）：`, textBlock(layout), '');
      if (n < 3 || chars < 15) parts.push(`识别到的文字很少：画面可能以图形为主${wantImage ? '' : '，要看图就加 image: true 再截一次'}。`);
    }
    parts.push(`要点画面上的东西：click_at(text_id="t3", tab=${tabId}) 点那一行的中心，或 click_at(x, y, tab=${tabId})；画面变了就重新 screenshot。`);
    const body = parts.join('\n');
    const imgTok = estimateImageTokens(shot.width, shot.height);
    const text = body + `\n估算 token：这段文字约 ${estimateTextTokens(body)}，同一画面的图片约 ${imgTok}（宽×高/750）` +
      (wantImage ? '；本次两者都给了。' : '；图片没有附上。');
    return { text, image: wantImage ? { data: shot.data, width: shot.width, height: shot.height } : null };
  } finally {
    if (cap && cap.shot) await cap.shot.dispose();
  }
}

async function clickAt(args, { signal = null } = {}) {
  const tab = args.tab ?? null;
  const byText = args.text_id != null && String(args.text_id) !== '';
  if (byText && (args.x != null || args.y != null)) throw new BridgeError('bad_args', '❌ text_id 和 x/y 只能给一种，没有点击。');
  if (!byText && (args.x == null || args.y == null)) {
    throw new BridgeError('bad_args', '❌ 要么给 text_id（screenshot 识别出的行，如 "t12"），要么同时给 x 和 y，没有点击。');
  }
  const info = await B.chromeInfo(tab);
  const shot = SHOTS.get(info.tabId);
  if (!shot || Date.now() - shot.at > SHOT_FRESH_MS) {
    throw new BridgeError('no_screenshot', `❌ 标签 ${info.tabId} 没有 5 分钟内的截图：先 screenshot，再按那次的结果 click_at。`);
  }
  let x, y, what, line = null;
  if (byText) {
    const id = 't' + String(args.text_id).trim().replace(/^[tT]/, '').replace(/^0+(?=\d)/, '');
    line = shot.texts && shot.texts.get(id);
    if (!line) {
      throw new BridgeError('no_such_text', `❌ 标签 ${info.tabId} 最近一次截图里没有 ${id}` +
        (shot.texts && shot.texts.size ? `（有 t1–t${shot.texts.size}）` : '（那次没有识别到文字）') + '，没有点击。');
    }
    x = line.x; y = line.y;
    what = `${id}「${clip(line.text, 30)}」的中心 (${x}, ${y})`;
  } else {
    x = Number(args.x); y = Number(args.y);
    what = `截图坐标 (${Math.round(x)}, ${Math.round(y)})`;
  }
  if (!(x >= 0 && y >= 0 && x <= shot.width && y <= shot.height)) {
    throw new BridgeError('outside_shot', `❌ (${x}, ${y}) 不在截图里（截图 ${shot.width}×${shot.height}），没有点击。`);
  }
  const sx = shot.rect.x + x * shot.rect.w / shot.width, sy = shot.rect.y + y * shot.rect.h / shot.height;
  return persist((idle) => inputAction(`click_at ${Math.round(x)},${Math.round(y)} tab ${info.tabId}`,
    (pre) => prepareActivate(info.tabId, null),
    async (s, prep, ctx) => {
      await guardNativeSelect(prep.target.tabId, { point: { x: sx, y: sy }, bounds: prep.target.bounds });
      await guardNativeTarget(prep, { x: sx, y: sy });
      const c = await post(s, ctx, 'click', { op: 'click', rect: { x: sx - 3, y: sy - 3, w: 6, h: 6 }, aim: { x: sx, y: sy }, clickCount: 1 });
      ctx.step(`在${what}点击了`);
      return [targetLine(prep.target),
        `✅ 已在${what}点击（屏幕 x=${c.landed.x}, y=${c.landed.y}）。效果请再 screenshot 或 read_page 确认。`].join('\n');
    }, { idle, veil: () => veilFor('click', line ? { loc: { text: line.text } } : null, null, { ...args, text: '' }), task: taskKey(args) }), signal);
}

async function pressKeyTool(args, { signal = null } = {}) {
  const key = String(args.key || '').toLowerCase();
  const times = Math.max(1, Math.min(20, Number(args.times) || 1));
  if (key === 'escape') {
    const recovered = await recoverNativeMenu(args, signal);
    if (recovered !== null) return recovered;
  }
  return persist((idle) => inputAction(`press ${key}×${times}${args.tab != null ? ' tab ' + args.tab : ''}`,
    (pre) => prepareActivate(args.tab ?? null, null),
    async (s, prep, ctx) => {
      for (let i = 0; i < times; i++) {
        // A native popup blocks every subsequent Apple Event, including our
        // normal Esc path. Type-ahead belongs to select_option; leave/cancel
        // keys stay available without another page read.
        if (key !== 'escape' && key !== 'tab') await guardNativeSelect(prep.target.tabId);
        if (key !== 'escape' && key !== 'tab') await guardNativeTarget(prep);
        await post(s, ctx, 'key', { op: 'key', name: key });
        ctx.step(`按了 ${key}${times > 1 ? ` ${i + 1}/${times}` : ''}`, 'key');
      }
      return [targetLine(prep.target), `✅ 已在页面里按了 ${key}${times > 1 ? ` ${times} 次` : ''}（发给当时有焦点的元素）。`].join('\n');
    }, { idle, veil: () => veilFor('key', null, null, args), task: taskKey(args) }), signal);
}

async function hoverTool(args, { signal = null } = {}) {
  return persist((idle) => inputAction(`hover [${args.marker}]${args.tab != null ? ' tab ' + args.tab : ''}`,
    (pre) => prepareActivate(pre ? pre.tab : (args.tab ?? null), activationHint(pre)),
    async (s, prep, ctx, pre) => {
      // The pre-check's position only while fresh: the hold may have waited for the user to finish typing (Fable r12 r2 B2).
      const loc = pre && pre.loc && Date.now() - pre.at < PRE_LOC_FRESH_MS ? pre.loc : await locateTarget(args.marker, prep.target.tabId);
      await pointerTo(s, loc.aim, originFor(loc));
      ctx.step(`把光标移到了 [${args.marker}] 上`);
      return [targetLine(prep.target), `✅ 光标已停在 [${args.marker}] <${loc.tag}> ${loc.text || ''} 上（没有点击）。悬停菜单打开后 read_page 看新出现的项。` +
        (TASK_HOLD || PLAN ? '' : '\n⚠️ 不在长任务里：操作完光标会放回原处，菜单可能随之收起；先 task_plan 再 hover。')].join('\n');
    }, { preflight: () => clickPreflight(args), idle, veil: (pre) => veilFor('hover', pre, null, args), task: taskKey(args) }), signal);
}

/* --------------------------------------------------------------- scroll */

/**
 * Whether a hidden tab may be made visible for the wheel: only in the agent
 * window, and only when that window is not minimized. Throws otherwise.
 * @returns the agent window id
 */
async function requireSelectable(info) {
  const agentWins = await agentWindowIds().catch(() => new Set());
  const agentWin = agentWins.has(String(info.windowId)) ? info.windowId : null;
  if (agentWin == null) {
    throw new BridgeError('tab_hidden',
      `❌ 标签 ${info.tabId} 在你的窗口里但当前没有显示${info.minimized ? '（窗口已最小化）' : '（不是该窗口的当前标签）'}，` +
      '为了不切换你的标签，没有滚动。\n读内容不需要滚动：read_page 有全页目录，屏幕外的部分用 sections / query / full 读。');
  }
  if (info.minimized) {
    throw new BridgeError('agent_window_minimized',
      '❌ agent 专用窗口被最小化了，滚轮送不到里面的标签，没有滚动。' +
      '把它还原（不用切到前面）后重试；只是读内容的话用 read_page 即可（屏幕外的部分用 sections / query / full），不需要滚动。');
  }
  return agentWin;
}

/**
 * prepare() for scroll: no activation. Decided again here, under the lock and
 * after the idle wait: the tab may have been dragged into one of the user's
 * windows meanwhile. A hidden tab of the agent window is made that window's
 * visible tab first (plan D2), and chromectl refuses if it has left that
 * window by then. `touchesScene` only when that unexpectedly changed the
 * frontmost app.
 */
async function prepareScroll(tab) {
  let t = await B.chromeInfo(tab), frontChanged = false, selected = false;
  if (!t.tabActive || t.minimized) {
    const agentWin = await requireSelectable(t);
    try {
      t = await B.selectTab(t.tabId, { windowId: agentWin });
    } catch (e) {
      if (e.code === 'tab_moved') {
        throw new BridgeError('tab_hidden', `❌ 标签 ${tab} 刚刚被移出了 agent 专用窗口，为了不切换你的标签，没有滚动。`);
      }
      throw e;
    }
    frontChanged = !!t.frontmostChanged;
    selected = t.changed !== false;
  }
  if (!t.tabActive || t.minimized) {
    throw new BridgeError('tab_hidden', `❌ 标签 ${t.tabId} 没有显示在它的窗口里，滚轮送不到它，没有滚动。`);
  }
  if (t.cgWindow == null) {
    throw new BridgeError('no_cg_window',
      `❌ 无法唯一确定标签 ${t.tabId} 所在的系统窗口（常见原因：两个 Chrome 窗口位置大小相同、当前网页的标题也相同，` +
      '或窗口在别的桌面空间），为了不滚到别的窗口，没有滚动。');
  }
  return {
    chromePid: t.chromePid, cgWindow: t.cgWindow, windowBounds: boundsRect(t.bounds), target: t,
    touchesScene: frontChanged, selected, ownNote: await ownershipNote(t)
  };
}

/** First candidate viewport point where the target window is on top (read-only `windowsat`). */
async function unoccludedPoint(points, origin, prep) {
  for (const p of points || []) {
    const sp = toScreen(p, origin);
    try {
      const r = await B.cgevent(['windowsat', sp.x.toFixed(1), sp.y.toFixed(1)]);
      if (targetWindowOnTop(r.windows, prep.chromePid, prep.windowBounds)) return p;
    } catch {}
  }
  return null;
}

async function scrollInSession(s, prep, ctx, { direction, amount = 1 }) {
  const tab = prep.target.tabId;
  const arrow = direction === 'down' ? '向下' : '向上';
  const st = await B.evalInPage(await locateScript({ MODE: 'scroll', DIR: direction }), tab);
  const head = [targetLine(prep.target), prep.ownNote,
    prep.selected ? '（这个标签原本不是 agent 窗口的当前标签，已先把它设为当前标签；没有把 Chrome 切到前面）' : ''];
  if (!st.scroller) {
    return head.concat(`页面${arrow}已经滚不动了（到头了，或者没有可滚动的区域），没有发出滚轮。`)
      .filter(x => x !== '').join('\n');
  }
  const origin = originFor(st);
  const spot = await unoccludedPoint(st.points, origin, prep);
  if (!spot) {
    throw new BridgeError('window_covered',
      '❌ 这个标签的窗口在可滚动区域上被别的窗口挡住了（或找不到能滚到它的光标位置），' +
      '滚轮会落到别的 App 上，所以没有滚动。');
  }
  await pointerTo(s, spot, origin);
  ctx.step('把光标移到了页面上');

  const goal = Math.round(st.height * amount);
  const measure = await locateScript({ MODE: 'measure' });
  let px = PX_PER_NOTCH, moved = 0, sent = 0, bursts = 0, last = st.scrollTop, stuck = false, max = st.max;
  while (moved < goal - px / 2 && bursts < 40) {
    const n = Math.max(1, Math.min(Math.ceil((goal - moved) / px),
      BURST_MIN + Math.floor(Math.random() * (BURST_MAX - BURST_MIN + 1))));
    const w = await post(s, ctx, 'wheel', { op: 'wheel', notches: n, dir: direction });
    sent += w.sent;
    bursts++;
    ctx.step(`滚轮发出 ${sent} 格`, 'wheel');
    // Smooth-scroll settle plus the pause between bursts (plan D3: 250–900 ms).
    await sleep(between(300, 900));
    const m = await B.evalInPage(measure, tab);
    const d = Math.abs(m.scrollTop - last);
    last = m.scrollTop;
    max = m.max;
    if (d === 0) { stuck = true; break; }
    moved += d;
    px = Math.min(400, Math.max(5, d / Math.max(1, w.sent)));
  }
  const area = st.scroller === 'document' ? '整页' : `页面内滚动区（${st.scroller}）`;
  const atEnd = direction === 'down' ? last >= max - 2 : last <= 0;
  return head.concat(
    `✅ 已用真实滚轮${arrow}滚动：${area} ${st.scrollTop} → ${last}（移动 ${moved}px，目标约 ${goal}px；共 ${bursts} 串 ${sent} 格）`,
    atEnd ? (direction === 'down' ? '已经到底了。' : '已经到顶了。') : '',
    stuck && !atEnd ? '⚠️ 最后一串滚轮没有让页面移动，停下了。' : ''
  ).filter(x => x !== '').join('\n');
}

async function scroll(args, { signal = null } = {}) {
  const { direction, amount = 1 } = args;
  if (direction !== 'up' && direction !== 'down') throw new BridgeError('bad_direction', '❌ direction 只能是 up 或 down。');
  // A quick refusal before queueing; prepareScroll decides again under the lock.
  const info = await B.chromeInfo(args.tab ?? null);
  const tab = info.tabId;
  if (!info.tabActive || info.minimized) await requireSelectable(info);
  return persist((idle) => inputAction(`scroll${args.tab != null ? ' tab ' + args.tab : ''}`,
    () => prepareScroll(tab),
    (s, prep, ctx) => scrollInSession(s, prep, ctx, { direction, amount }),
    { doneNote: '\n（滚完已把光标放回原处）', activates: false, idle,
      // The window from the look before the lock; `begin` corrects the hole if it has moved.
      veil: () => veilFor('scroll', null, info.bounds ? boundsRect(info.bounds) : null, args), task: taskKey(args) }), signal);
}

/* ---------------------------------------------------------------- server */

// Instructions: the routing rule, said once, with the browser tools this user already has (src/peers.js).
export function serverInstructions(o) { return routingInstructions(detectPeers(o)); }
const server = new Server(
  { name: 'mychrome-mcp', version: PACKAGE_VERSION },
  { capabilities: { tools: { listChanged: true } }, instructions: serverInstructions() }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, (req, extra) => callTool(req, extra));
/** Tests: serve over another transport (the SDK's InMemoryTransport) — the MCP path, clientInfo included, without stdio. */
export async function __connectForTests(transport) { await server.connect(transport); }

/** Calls under way, and when the last one ended: the hot-swap launcher replaces this process only when quiet. */
let INFLIGHT = 0, LAST_CALL_END = 0;

/** One tool call, as the MCP handler answers it (exported for tests): the tool's reply, then ledgerTail. */
async function callTool(req, extra) {
  try {
    const result = await CALL.run({ target: null, explained: new Set(), listed: false }, () => callToolRun(req, extra));
    return redactToolResult(result);
  } catch (e) {
    // Even an error outside the tool's ordinary catch (for example presence/ledger setup)
    // must pass through output privacy. Keep navigation state and the original error private.
    return { content: [{ type: 'text', text: redactText(`❌ 出错了：${e && e.message ? e.message : String(e)}`) }], isError: true };
  }
}

async function callToolRun(req, extra) {
  const { name, arguments: args = {} } = req.params;
  const call = { signal: extra && extra.signal ? extra.signal : null };
  // The ledger's words after the reply's own; a failure there never costs the reply.
  // Menu recovery must also avoid the reply footer's Apple-Event tab listing.
  const tail = name === 'press_key' && String(args.key || '').toLowerCase() === 'escape'
    ? async () => '' : (o) => ledgerTail(name, args, o).catch(() => '');
  const t0 = Date.now();
  const busyId = presenceBusy(name);
  const context = CALL.getStore();
  const exclusive = ROUTINE_EXCLUSIVE.has(name);
  if (exclusive && ROUTINES.runner.busy()) {
    if (context) { context.failed = true; context.code = 'routine_busy'; }
    presenceBusy(null, busyId);
    return { isError: true, content: [{ type: 'text', text: routineMessage('routine_busy') }] };
  }
  let ordinaryDone;
  if (exclusive) ORDINARY_INPUTS++;
  if (ORDINARY_WRITES.has(name) || name === 'wait_for_user') {
    // The shared native lease excludes other workers; this queue also excludes
    // re-entrant calls using this worker's long-task lease through finalization.
    const previous = ORDINARY_TAIL;
    ORDINARY_TAIL = new Promise(resolve => { ordinaryDone = resolve; });
    await previous;
  }
  if (name === 'wait_for_user') call.waitReady = () => { ordinaryDone?.(); ordinaryDone = null; };
  if (context && ROUTINE_ACTIONS.has(name)) context.routineAttempt = { tool: name, args, task: args.task || PLAN?.task };
  let result;
  INFLIGHT++;
  try {
    // User input during a wait cannot be joined to earlier automated actions.
    // The matching final boundary runs on success, timeout and cancellation.
    if (name === 'wait_for_user') await ROUTINES.barrier(args.tab ?? context?.target, name);
    result = await callToolInner(name, args, call, tail);
    return result;
  } finally {
    try {
      await ROUTINES.afterInput(context, result);
      if (exclusive && !ROUTINE_ACTIONS.has(name)) await ROUTINES.barrier(args.tab ?? context?.target, name);
    } finally {
      if (exclusive) ORDINARY_INPUTS--;
      ordinaryDone?.();
      INFLIGHT--;
      LAST_CALL_END = Date.now();
      presenceBusy(null, busyId);
    }
    if (RECORD) {
      const r = CALL.getStore() || {}, id = agentIdentity();
      S.logActivity({ tool: name, host: S.hostOf(name === 'open_tab' ? args.url : r.url), ok: !r.failed, code: r.failed ? r.code : null,
        ms: Date.now() - t0, who: typeof id.who === 'string' ? id.who : id.who.zh, color: id.color });
    }
  }
}

/**
 * 「暂停 AI 操作」 in the menu-bar panel. Checked when a call comes in (pauseGate), again right before the
 * keyboard and mouse are taken over or the input lock's work starts (a call queued or waiting for the user
 * to stop typing when the pause came: Codex r13 A1), and in wait_for_user's polling.
 */
const pausedError = (during = '') => new BridgeError('paused_by_user',
  `⏸ 用户已暂停 MyChrome（「暂停 AI 操作」）${during}，这次什么也没做。\n` +
  '给 agent：告诉用户需要用浏览器，等用户在 MyChrome 窗口点击「继续 AI 操作」或从菜单栏恢复后再试；不要自己重试，也不要换别的工具绕过。');
function pausedCheck(during = '') { if (S.get('paused')) { pauseCleanup(); throw pausedError(during); } }
/**
 * What a pause ends wherever it is noticed (at the door or in a call already running: Codex/Fable r13 r2 A2):
 * the task card and the keep-awake of a job (the agent stops and may never call done), a pending Esc×2.
 */
function pauseCleanup() {
  closeTaskFeed();
  TASK_CANCELLED = null;
  const card = !!PLAN || BLOCKS.size > 0;
  if (PLAN) { const p = PLAN; PLAN = null; if (p.stopAwake) p.stopAwake(); }
  // "Needs you" notes are the stopped agent's: the panel stops showing them (a page still blocked is found again on resume).
  BLOCKS.clear();
  if (card) { PANEL_TASK = { text: '', at: 0 }; writeTaskState(); }
}
/** list_tabs answers (only this session's tabs while paused); task_plan done:true must always pass (Fable r13 A1). */
const PAUSE_FREE = new Set(['list_tabs']);
async function pauseGate(name, args) {
  if (name === 'routines' && !['start', 'run'].includes(args.action)) return;
  if (PAUSE_FREE.has(name) || !S.get('paused')) return;
  // A long job holding the keyboard and mouse between its steps gives them back now; its card and its
  // keep-awake end (the agent stops here and may never call done); a pending Esc×2 is not carried past the pause.
  if (TASK_HOLD) await endTaskHold().catch(() => {});
  pauseCleanup();
  if (name === 'task_plan' && args && args.done === true) return;
  throw pausedError();
}

async function callToolInner(name, args, call, tail) {
  try {
    await pauseGate(name, args);
    if (args.tab != null && name !== 'close_tab') await touchTab(args.tab).catch(() => {});
    let text;
    switch (name) {
      case 'routines': {
        const cancellable = ['start', 'run'].includes(args.action) && call.signal;
        if (cancellable && call.signal.aborted) throw new RoutineError('cancelled');
        const pending = ROUTINES.query(args);
        const cancel = () => { try { ROUTINES.runner.cancelRequest(args); } catch {} };
        if (cancellable) {
          call.signal.addEventListener('abort', cancel, { once: true });
          if (call.signal.aborted) cancel();
        }
        try {
          const result = await pending;
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
        } finally { if (cancellable) call.signal.removeEventListener('abort', cancel); }
      }
      case 'list_tabs': text = S.get('paused')
        ? '⏸ 用户暂停了 MyChrome（菜单栏「暂停 AI 操作」），暂停期间只列出你自己的标签。\n' + await listTabsTool({ mine: true })
        : await listTabsTool({ mine: args.mine === true }); break;
      case 'open_tab': text = await openTabTool(args); break;
      case 'close_tab': text = await closeTabTool(args); break;
      case 'read_page': {
        const r = await readPage(args, call);
        if (r && typeof r === 'object') {
          noteOutcome(true);
          return { content: [{ type: 'image', data: r.image.data, mimeType: 'image/png' }, { type: 'text', text: r.text + await tail() }] };
        }
        text = r;
        break;
      }
      case 'click': text = await click(args, call); break;
      case 'type_text': text = await typeText(args, call); break;
      case 'scroll': text = await scroll(args, call); break;
      case 'select_option': text = await selectOption(args, call); break;
      case 'task_plan': text = await taskPlanTool(args); break;
      case 'answer_dialog': text = await answerDialogTool(args); break;
      case 'wait_for_user': text = await waitForUserTool(args, call); break;
      case 'wake_screen': text = await wakeScreenTool(); break;
      case 'click_at': text = await clickAt(args, call); break;
      case 'press_key': text = await pressKeyTool(args, call); break;
      case 'hover': text = await hoverTool(args, call); break;
      case 'screenshot': {
        const r = await screenshotTool(args, call);
        noteOutcome(true);
        return { content: [...(r.image ? [{ type: 'image', data: r.image.data, mimeType: 'image/png' }] : []), { type: 'text', text: r.text + await tail() }] };
      }
      default: {
        const st = CALL.getStore();
        if (st) { st.failed = true; st.code = 'unknown_tool'; }
        return { content: [{ type: 'text', text: `未知的工具：${name}` }], isError: true };
      }
    }
    noteOutcome(true);
    return { content: [{ type: 'text', text: text + await tail() }] };
  } catch (e) {
    const st = CALL.getStore();
    if (st) { st.failed = true; st.code = (e && e.code) || 'error'; }
    // A tool error is not the end of a long project. Keep a verified healthy
    // hold; otherwise preserve the interruption and refuse automatic retaking.
    if (PLAN && name !== 'routines') await maintainTaskAfterError(e);
    if (!(e && e.code === 'paused_by_user')) noteOutcome(false, e);
    // Every expected failure already carries a plain-Chinese instruction.
    let msg = e instanceof RoutineError ? routineMessage(e.code) : e instanceof BridgeError ? e.message : `❌ 出错了：${e && e.message ? e.message : String(e)}`;
    // What the marker tools could not reach may still be reached by looking and pointing.
    if (FALLBACK_CODES.has(e && e.code)) msg += FALLBACK_HINT;
    msg += goneTabNote(name, args, e);
    // A permission or switch the user sets once: point them to the setup check.
    msg += setupHint(e && e.code);
    if (PLAN?.interrupted && e?.code !== 'task_interrupted') {
      msg += `\n任务「${PLAN.task}」尚未完成，计划已保留：${PLAN.interrupted.reason}。` +
        (TASK_CANCELLED === PLAN.task ? '等用户明确恢复后重新 task_plan。'
          : '先检查当前状态，确认可继续后重新 task_plan。');
    }
    return { content: [{ type: 'text', text: msg + await tail({ ok: false, error: e }) }], isError: true,
      ...(name === 'routines' ? { structuredContent: { error: { code: /^[a-z_]{1,80}$/.test(e?.code ?? '') ? e.code : 'unavailable' } } } : {}) };
  }
}

// Exported for the smoke and live scripts.
export { listTabsTool, openTabTool, closeTabTool, readPage, click, typeText, scroll, selectOption, taskPlanTool, answerDialogTool, wakeScreenTool, waitForUserTool, noteOutcome,
  screenshotTool, clickAt, pressKeyTool, hoverTool, chromeInfo, viewportOrigin, VERSION, callTool };

/**
 * Start the stdio server only when this file is the program: `node src/index.js`, or the npm bin link
 * (…/bin/mychrome-mcp, node_modules/.bin/mychrome-mcp), whose argv[1] Node resolves but does not
 * realpath. Tests and scripts that import this module must not start it.
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

/**
 * Why this worker cannot make way for new code now (hot swap; null: it can): a call, a job's hold or its end
 * (the user's things being put back, the lease let go), a hand-over between steps, 「带我去」, a plan between steps.
 */
function handoverRefusal(exiting = false) {
  return exiting ? 'exiting' : INFLIGHT > 0 ? 'busy' : TASK_HOLD ? 'job' : HOLD_ENDING > 0 || YIELDING ? 'job_ending'
    : ROUTINES.runner.busy() || ROUTINES.runner.hasPending() ? 'routine' : GOTO.running ? 'goto' : PLAN ? 'plan' : GUI_SERVICE?.snapshot().sending ? 'reply'
      : GUI_SERVICE?.snapshot().pending?.length ? 'reply_wait' : null;
}
export function __handoverRefusalForTests() { return handoverRefusal(); }

/**
 * What a worker hands to the one replacing it (hot swap, src/launcher.js): the ledger of this session's
 * tabs (states, `helped`, news), the warnings already given, a stop the user asked for that the agent
 * has not heard yet, the job actions without `task` belong to, and screenshots click_at may still use.
 * Everything else is in files or starts afresh.
 */
export function handoverCarry() {
  const guiBinding = GUI_SERVICE ? GUI_SERVICE.exportBinding() : GUI_RESTORE;
  return { ledger: { tabs: [...LEDGER.tabs.entries()], seq: LEDGER.seq, reportedSeq: LEDGER.reportedSeq },
    routines: ROUTINES.runner.exportCarry(),
    warned: [...WARNED_NOT_MINE], noted: [...NOTED_TAKEN], taskCancelled: TASK_CANCELLED,
    ...(guiBinding ? { guiBinding } : {}),
    // The job an action without `task` belongs to (a stop the user asked for matches it: Codex r15 r2 A1).
    panelTask: { ...PANEL_TASK },
    // Screenshots still good for click_at (5 minutes): screenshot, a swap, then click_at must still work (Codex r15 r3 B2).
    shots: [...SHOTS].filter(([, v]) => Date.now() - v.at <= SHOT_FRESH_MS).map(([id, v]) => [id, { ...v, texts: [...(v.texts || new Map())] }]) };
}
export function applyCarry(c) {
  if (!c || typeof c !== 'object') return 0;
  ROUTINES.runner.importCarry(c.routines);
  GUI_RESTORE = normalizeConversationBinding(c.guiBinding);
  const l = c.ledger || {};
  if (Array.isArray(l.tabs)) for (const [id, e] of l.tabs) if (e && typeof e === 'object') LEDGER.tabs.set(Number(id), e);
  if (Number.isFinite(l.seq)) LEDGER.seq = l.seq;
  if (Number.isFinite(l.reportedSeq)) LEDGER.reportedSeq = l.reportedSeq;
  for (const id of Array.isArray(c.warned) ? c.warned : []) WARNED_NOT_MINE.add(id);
  for (const id of Array.isArray(c.noted) ? c.noted : []) NOTED_TAKEN.add(id);
  if (typeof c.taskCancelled === 'string') TASK_CANCELLED = c.taskCancelled;
  const pt = c.panelTask;
  if (pt && typeof pt.text === 'string' && Number.isFinite(pt.at)) PANEL_TASK = { text: pt.text, at: pt.at };
  for (const [id, v] of Array.isArray(c.shots) ? c.shots : []) {
    if (v && typeof v === 'object') SHOTS.set(Number(id), { ...v, texts: new Map(Array.isArray(v.texts) ? v.texts : []) });
  }
  return Array.isArray(l.tabs) ? l.tabs.length : 0;
}

if (isMainModule()) {
  // The hot-swap launcher's look at new code: everything above loaded and ran; nothing starts.
  if (process.argv[2] === '--probe') { process.stdout.write(`mychrome-probe-ok ${VERSION}\n`); process.exit(0); }
  const UNDER_LAUNCHER = process.env.CHROME_BRIDGE_WORKER === '1' && !!process.send;
  let carried = null;
  if (UNDER_LAUNCHER && process.env.CHROME_BRIDGE_CARRY === 'ipc') {
    // What the worker before handed over, asked for once this one listens; taken before anything is answered.
    delete process.env.CHROME_BRIDGE_CARRY;
    const c = await new Promise((res) => {
      const t = setTimeout(() => { process.off('message', on); res(null); }, 5000);
      function on(m) { if (m && m.t === 'carry') { clearTimeout(t); process.off('message', on); res(m.carry); } }
      process.on('message', on);
      try { process.send({ t: 'carry?' }); } catch { clearTimeout(t); res(null); }
    });
    // Not had: this worker does not start without it (a stop the user asked for would be lost); the launcher
    // still has it and starts another (Codex r15 r3 A1).
    if (!c) { process.stderr.write('mychrome-mcp worker: the hand-over did not arrive\n'); process.exit(4); }
    carried = applyCarry(c);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`mychrome-mcp ready (stdio), version ${VERSION}, pid ${process.pid}${carried != null ? `, carried ${carried} tab(s) over` : ''}\n`);

  // Agent tabs: one sweep right away (plan T9: nobody may have swept since
  // the last server died), then every minute; this session's own tabs are
  // closed when the client goes away. All paths share the ownership checks
  // in src/tabs.js.
  // CHROME_BRIDGE_SWEEP=0: no sweeps at all (a server that only looks, e.g. a smoke test beside the user's sessions).
  const SWEEP = process.env.CHROME_BRIDGE_SWEEP !== '0';
  if (SWEEP) sweep();
  presenceStart();
  process.on('exit', () => S.removePresence(LOCK_DIR));
  startMenuBar();
  const timer = setInterval(() => { if (SWEEP) sweep(); }, 60_000);
  timer.unref();
  let exiting = false, sessionEnded = false;
  // sessionEnd false: only this process goes (a hot-swap worker the launcher will replace): the session's tabs stay.
  // The session ending while that runs still counts (Codex r15 r2 B2).
  const bye = async ({ sessionEnd = true } = {}) => {
    if (sessionEnd) sessionEnded = true;
    if (exiting) return;
    exiting = true;
    closeTaskFeed();
    clearInterval(GUI_POLL);
    GUI_SERVICE?.close();
    await Promise.race([endTaskHold().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    PLAN = null;
    writeTaskState();
    if (SWEEP && sessionEnded) {
      await Promise.race([
        sweep({ exitingPid: OWNER_PID }),
        new Promise(r => setTimeout(r, 5000))
      ]);
    }
    process.exit(0);
  };
  process.stdin.on('end', () => bye());
  process.stdin.on('close', () => bye());
  // Under the hot-swap launcher the session's end is the launcher's to say (this stdin closing, the channel
  // going). A signal to this process alone ends only this process (the launcher starts another); a client
  // stopping the whole group closes the launcher too, which says so first.
  const onSignal = UNDER_LAUNCHER
    ? () => { if (!exiting) setTimeout(() => bye({ sessionEnd: !pidAlive(OWNER_PID) }), 600).unref(); }
    : () => bye();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, onSignal);
  if (UNDER_LAUNCHER) {
    // Makes way for new code when asked, only while nothing is under way (handoverRefusal).
    process.on('disconnect', () => bye());
    process.on('message', (m) => {
      if (!m || m.t !== 'handover?') return;
      const why = handoverRefusal(exiting);
      if (why) { process.send({ t: 'handover', ok: false, why }); return; }
      if (process.env.CHROME_BRIDGE_TEST_HANDOVER === 'die') process.exit(3);   // test/hotswap.test.mjs: ends while asked
      exiting = true;
      closeTaskFeed();
      clearInterval(GUI_POLL);
      const carry = handoverCarry();
      GUI_SERVICE?.close();
      PLAN = null;
      BLOCKS.clear();
      Object.assign(STUCK, { n: 0 });
      writeTaskState();
      debugLog({ label: 'handover to new code', tabs: carry.ledger.tabs.length });
      // The session ending meanwhile (stdin closed, bye() came too late to act): its tabs still close (Codex r15 r3 B1).
      process.send({ t: 'handover', ok: true, carry }, async () => {
        if (sessionEnded && SWEEP) await Promise.race([sweep({ exitingPid: OWNER_PID }), new Promise(r => setTimeout(r, 5000))]);
        process.exit(0);
      });
    });
  }
}
