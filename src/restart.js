/**
 * `mychrome-mcp restart-all`: the panel's 「全部重启」. Every session still running old MyChrome code gets it
 * restarted. Claude Code does not restart a stdio server that exits (TODO.md, 2026-10-19), but `/mcp reconnect
 * <name>` typed into the session does: this types it into the session's kitty window or tmux pane once the session
 * is idle, in the foreground, with an empty input box and nobody typing, and restarts an idle background session
 * with `claude respawn <id>`. A session it cannot reach safely is listed with what to do by hand; leaving a session
 * alone is always the answer when in doubt (it is the owner's real work). Progress goes to <cache>/restart-all.json,
 * which the panel reads.
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serversDir, sourceFingerprint } from './settings.js';

const HERE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** The panel starts this with a short PATH: kitty, tmux and claude live here. */
const PATH_EXTRA = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
const fullPath = () => [process.env.PATH, ...PATH_EXTRA].filter(Boolean).join(':');

export function execRun(cmd, args, { env = {}, timeout = 10_000 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { env: { ...process.env, PATH: fullPath(), ...env }, timeout, maxBuffer: 16 << 20 },
      (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || '') }));
  });
}

const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };

/** Node options that take the next word as their value (when not written `--opt=value`). */
const NODE_VALUED = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions',
  '--input-type', '--env-file', '--env-file-if-exists', '--title', '--watch-path', '--inspect-port', '--debug-port',
  '--redirect-warnings', '--report-dir', '--report-filename', '--icu-data-dir', '--openssl-config', '--dns-result-order']);
/** Node options that run code that is not a script, or no script at all. */
const NODE_NOT_SCRIPT = new Set(['-e', '--eval', '-p', '--print', '-c', '--check', '-i', '--interactive', '--test', '-v', '--version', '-h', '--help',
  '--run']);
/** Node options written `--opt=value` that leave a script to run (any other `=` option: not parsed, r10 A1). */
const NODE_EQ = new Set(['--max-old-space-size', '--max-semi-space-size', '--stack-size', '--stack-trace-limit', '--inspect', '--inspect-brk',
  '--unhandled-rejections', '--max-http-header-size']);
/**
 * The script a `node [options] <script> …` command line runs, as a real path; null for anything else, and for an
 * option it does not know (it might take the next word as its value: Codex r15 restart r9 A2).
 */
export function scriptOf(cmd) {
  const w = String(cmd).split(/\s+/).filter(Boolean);
  if (!/(^|\/)node(js)?[\d.]*$/.test(w[0] || '')) return null;
  let i = 1;
  for (; i < w.length && w[i].startsWith('-'); i++) {
    const o = w[i];
    if (o === '--') { i++; break; }
    const name = o.split('=')[0];
    if (NODE_NOT_SCRIPT.has(name)) return null;
    if (o.includes('=')) { if (NODE_VALUED.has(name) || NODE_EQ.has(name)) continue; return null; }
    if (NODE_BOOL.has(o)) continue;
    if (NODE_VALUED.has(o)) { i++; continue; }
    return null;
  }
  const arg = w[i];
  return arg && arg.includes('/') ? realOr(arg) : null;
}
/** Node flags without a value seen in front of a script. */
const NODE_BOOL = new Set(['--enable-source-maps', '--no-warnings', '--no-deprecation', '--trace-warnings', '--trace-deprecation',
  '--trace-uncaught', '--expose-gc', '--inspect', '--inspect-brk', '--watch', '--experimental-vm-modules', '--preserve-symlinks',
  '--preserve-symlinks-main', '--no-experimental-fetch', '--throw-deprecation', '--pending-deprecation', '--abort-on-uncaught-exception']);

/* ------------------------------------------------------------------ processes */

/** `ps -o etime` ([[dd-]hh:]mm:ss) in ms. */
function etimeMs(e) {
  const x = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(e);
  return x ? (((Number(x[1] || 0) * 24 + Number(x[2] || 0)) * 60 + Number(x[3])) * 60 + Number(x[4])) * 1000 : null;
}

async function psTable(run, now = Date.now) {
  const r = await run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,etime=,tty=,command=']);
  const m = new Map(), at = now();
  for (const line of r.out.split('\n')) {
    const x = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!x) continue;
    const up = etimeMs(x[6]);
    m.set(Number(x[1]), { pid: Number(x[1]), ppid: Number(x[2]), pgid: Number(x[3]), tpgid: Number(x[4]), stat: x[5],
      startedAt: up === null ? null : at - up, tty: x[7], cmd: x[8] });
  }
  return m;
}

/** pid and the processes above it. */
function lineage(ps, pid) {
  const out = new Set();
  for (let p = pid; p > 1 && !out.has(p); p = ps.get(p)?.ppid ?? 0) out.add(p);
  return out;
}

/** The session owns its terminal: in the foreground group and not stopped (Ctrl+Z hands the terminal to the shell). */
const inForeground = (row) => !!row && row.tpgid > 0 && row.tpgid === row.pgid && !row.stat.includes('T');

/** The terminal variables a session started with (`ps -E`: the command line, then its environment). */
const ENV_KEYS = ['KITTY_WINDOW_ID', 'KITTY_LISTEN_ON', 'KITTY_PUBLIC_KEY', 'TMUX', 'TMUX_PANE'];
async function procEnv(run, pid) {
  const r = await run('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)]);
  const env = {};
  for (const k of ENV_KEYS) {
    const all = [...r.out.matchAll(new RegExp(`(?:^|\\s)${k}=(\\S+)`, 'g'))];
    if (all.length) env[k] = all[all.length - 1][1];
  }
  return env;
}

const isClaude = (cmd) => /^(\S*\/)?claude(\s|$)/.test(cmd) || cmd.includes('/ClaudeCode.app/') || cmd.includes('/claude/versions/');
const PRINT = /\s(-p|--print)(\s|$)/;

/** Every live session in `claude agents --json` (pid, kind, status, name, id), or null when it cannot run. */
async function claudeAgents(run) {
  const r = await run('claude', ['agents', '--json'], { timeout: 15_000 });
  try { const a = JSON.parse(r.out); return Array.isArray(a) ? a : null; } catch { return null; }
}

/** Milliseconds since the last keyboard or mouse input on this Mac (IOHIDSystem HIDIdleTime), or null. */
async function hidIdleMs(run) {
  const r = await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(r.out);
  return m ? Number(m[1]) / 1e6 : null;
}

/* ------------------------------------------------------------------ the server's name in the session */

/** Where a command in an MCP entry leads (a bare name through PATH), as a real path. */
function resolveCommand(a) {
  if (typeof a !== 'string' || !a) return null;
  if (a.includes('/')) return realOr(a);
  for (const d of fullPath().split(':')) {
    try { const p = path.join(d, a); if (statSync(p).isFile()) return realOr(p); } catch {}
  }
  return null;
}

/**
 * `--mcp-config <file|json>…` on a session's command line (values up to the next flag; a file relative to the
 * session's cwd), or null when one cannot be read back whole (inline JSON with spaces: ps joins the arguments with
 * spaces): a lower scope's name would then be a guess (Codex r15 restart r3 A2).
 */
function mcpConfigsOf(cmd, cwd) {
  const words = cmd.split(/\s+/), out = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== '--mcp-config' && !words[i].startsWith('--mcp-config=')) continue;
    const vals = words[i].includes('=') ? [words[i].slice(words[i].indexOf('=') + 1)] : [];
    for (let j = i + 1; !vals.length && j < words.length && !words[j].startsWith('--'); j++) vals.push(words[j]);
    for (let j = i + 1 + vals.length; words[i] === '--mcp-config' && j < words.length && !words[j].startsWith('--'); j++) vals.push(words[j]);
    if (!vals.length) return null;
    for (const v of vals) {
      let j = null;
      try { j = JSON.parse(v.startsWith('{') ? v : readFileSync(path.resolve(cwd || '/', v), 'utf8')); } catch {}
      if (!j || typeof j !== 'object') return null;
      out.push(j.mcpServers || {});
    }
  }
  return out;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/**
 * The name this checkout's server has in the session (`/mcp reconnect <name>`). The session's servers as Claude Code
 * resolves them, a name in a higher scope replacing the whole entry of a lower one: user (~/.claude.json
 * mcpServers) < project (<cwd>/.mcp.json) < local (~/.claude.json projects[cwd]) < `--mcp-config` on its command
 * line (only those with --strict-mcp-config); then the entries whose command or an argument leads to this
 * checkout's src/index.js. { name } or { error } when there is none or more than one: a guessed name could
 * reconnect another install and close its tabs (Codex r15 restart r1 A7, r2 A6).
 */
export function serverName({ cwd = null, cmd = '', root = HERE_ROOT, home = os.homedir() } = {}) {
  const script = realOr(path.join(root, 'src', 'index.js'));
  const scopes = [];
  if (!/\s--strict-mcp-config(\s|$)/.test(cmd)) {
    const j = readJson(path.join(home, '.claude.json')) || {};
    scopes.push(j.mcpServers, cwd && readJson(path.join(cwd, '.mcp.json'))?.mcpServers, cwd && j.projects?.[cwd]?.mcpServers);
  }
  const fromCli = mcpConfigsOf(cmd, cwd);
  if (!fromCli) return { error: '它的 --mcp-config 读不出来（内联 JSON 或找不到文件），不知道它叫什么' };
  scopes.push(...fromCli);
  const effective = {};
  for (const servers of scopes) if (servers && typeof servers === 'object') Object.assign(effective, servers);
  const names = new Set();
  for (const [k, v] of Object.entries(effective)) {
    if (!v || typeof v !== 'object') continue;
    if ([v.command, ...(Array.isArray(v.args) ? v.args : [])].some(a => resolveCommand(a) === script)) names.add(k);
  }
  if (names.size === 1) {
    const [name] = names;
    return /^[\w.@-]+$/.test(name) ? { name } : { error: `它的名字「${name}」没法直接输入` };
  }
  return { error: names.size ? `配置里有 ${names.size} 个指向这个目录的 MyChrome（${[...names].join('、')}），不知道该重连哪个`
    : '在它的 MCP 配置里找不到指向这个目录的 MyChrome，不知道它叫什么' };
}

/* ------------------------------------------------------------------ which servers */

/**
 * The MyChrome servers of this checkout: from the presence files (servers/<pid>.json; a file whose pid now runs
 * something else is a dead server's: Codex r15 restart r1 A8) and, for servers older than those files, from ps.
 * `client` is the process that started the session's server (under the hot-swap launcher, the launcher's parent);
 * `current` when it runs the code on disk now.
 */
export async function scan({ root, lockDir, run, now = Date.now }) {
  const ps = await psTable(run, now);
  const current = sourceFingerprint(root);
  const roots = new Set([root, realOr(root)]);
  const script = realOr(path.join(root, 'src', 'index.js'));
  /**
   * This checkout's server: node running a script whose real path is this checkout's src/index.js (directly or
   * through a linked `mychrome-mcp`: not another install, r2 A7), not any process with that path among its
   * arguments (r8 A2).
   */
  const isServer = (row) => !!row && scriptOf(row.cmd) === script;
  /** A presence file belongs to the process now holding its pid: that process started when the file says (r2 A7). */
  const sameStart = (row, at) => typeof at !== 'number' || row.startedAt === null || (at >= row.startedAt - 3000 && at <= row.startedAt + 120_000);
  const servers = [], known = new Set();
  let names = [];
  try { names = readdirSync(serversDir(lockDir)).filter(n => n.endsWith('.json')); } catch {}
  for (const n of names) {
    let j;
    try { j = JSON.parse(readFileSync(path.join(serversDir(lockDir), n), 'utf8')); } catch { continue; }
    if (!Number.isInteger(j.pid) || !isServer(ps.get(j.pid)) || !sameStart(ps.get(j.pid), j.startedAt)) continue;
    known.add(j.pid);
    if (Number.isInteger(j.launcher)) known.add(j.launcher);
    if (!roots.has(j.root)) continue;
    servers.push({ pid: j.pid, client: ps.get(j.launcher || j.pid)?.ppid ?? null, current: j.srcHash === current,
      launcher: Number.isInteger(j.launcher) ? j.launcher : null, who: typeof j.who === 'string' ? j.who : null });
  }
  for (const row of ps.values()) {
    if (known.has(row.pid) || !isServer(row) || /\s(doctor|restart-all|--probe)(\s|$)/.test(row.cmd)) continue;
    // A server without a file is an old one only once it is a minute old (a new one writes its file when it starts).
    if (row.startedAt === null || row.startedAt > now() - 60_000) continue;
    // A launcher's worker (or its look at new code), or a launcher whose worker has not written its file yet.
    if (isServer(ps.get(row.ppid)) || [...ps.values()].some(c => c.ppid === row.pid && isServer(c))) continue;
    servers.push({ pid: row.pid, client: row.ppid, current: false, launcher: null, who: null });
  }
  return { ps, servers, current, isServer };
}

/* ------------------------------------------------------------------ the input box */

/** Claude Code draws its box from column 0; a draft's lines are indented, so a rule or `❯` in a draft never is. */
const RULE = /^[─━]{8,}$/;
const PLACEHOLDER = /^Try "[^"\n]*"$/;
/** The box's top rule may carry a label (an older Claude Code: `── name ───`). */
const TOP_RULE = /^[─━]{3,}/;
/** Under the box Claude Code draws a few lines (status line, mode); more means something else is on screen. */
const BELOW_MAX = 6;
/**
 * Claude Code's input box on a screen: { text, first (the ❯ line's content as drawn, no separator), lines (how many
 * lines the box has inside), prompt (the ❯ line's index) }, or null when the screen shows no input box at its bottom
 * (a menu, a question, or a shell drawn over an old box). The box: the last full rule at column 0, the rule at column
 * 0 above it, between them the `❯` line at column 0 and only indented (or empty) lines under it — a draft holding
 * rules and a `❯` of its own is all indented, so it is the box's text, not a box (Codex r15 restart r7 A1).
 */
export function parseBox(screen) {
  const lines = stripAnsi(screen).replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let close = -1;
  for (let i = lines.length - 1; i >= 0 && close < 0; i--) if (RULE.test(lines[i])) close = i;
  if (close < 1 || lines.slice(close + 1).filter(l => l.trim()).length > BELOW_MAX) return null;
  let open = -1;
  for (let i = close - 1; i >= 0 && open < 0; i--) if (TOP_RULE.test(lines[i])) open = i;
  const inner = lines.slice(open + 1, close);
  if (open < 0 || !inner.length) return null;
  const m = /^[❯>](.*)$/.exec(inner[0]);
  if (!m || inner.slice(1).some(l => l !== '' && !/^\s/.test(l))) return null;
  const first = m[1].replace(/^[ \u00a0]/, '');
  return { text: [first, ...inner.slice(1)].map(l => l.trim()).join('\n').trim(), first, lines: inner.length, prompt: open + 1 };
}
export const inputBox = (screen) => parseBox(screen)?.text ?? null;

const ESC = /\x1b\[[0-9;:?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s) => String(s || '').replace(ESC, '');

/** The visible characters of a line with SGR codes, each with whether it is drawn dim (SGR 2). */
function dimChars(line) {
  const out = [];
  let dim = false;
  for (let i = 0; i < line.length;) {
    const m = /^\x1b\[([0-9;:]*)m/.exec(line.slice(i));
    if (m) {
      const ps = m[1] === '' ? ['0'] : m[1].split(';');
      for (let k = 0; k < ps.length; k++) {
        const p = ps[k];
        if (p.includes(':')) continue;                                      // 38:2:… colour
        if (p === '38' || p === '48' || p === '58') { k += ps[k + 1] === '5' ? 2 : ps[k + 1] === '2' ? 4 : 0; continue; }
        if (p === '2') dim = true;
        else if (p === '0' || p === '22' || p === '') dim = false;
      }
      i += m[0].length;
      continue;
    }
    const e = new RegExp(ESC.source, 'y');
    e.lastIndex = i;
    const x = e.exec(line);
    if (x) { i += x[0].length; continue; }
    out.push({ ch: line[i], dim });
    i++;
  }
  return out;
}

/** The terminal's cursor is at column `col` of line `row` (Claude Code keeps it where the next key would go). */
const cursorAt = (cursor, row, col) => !!cursor && cursor.row === row && cursor.col === col;

/**
 * The input box from a screen read with its colours and cursor: { box, empty }. Empty: one line inside, the cursor
 * right after `❯ `, and nothing on that line or only Claude Code's grey hint (`Try "…"` drawn dim). A draft of
 * spaces or empty lines reads like an empty line but moves the cursor or adds lines (Codex r15 restart r8 A1);
 * text the owner wrote is never dim, so a draft that reads like the hint is still a draft (r7 A2).
 */
export function readBox(screen, cursor) {
  const raw = String(screen || '').replace(/\r/g, '');
  const b = parseBox(raw);
  if (!b) return { box: null, empty: false };
  if (b.lines !== 1 || !cursorAt(cursor, b.prompt, 2)) return { box: b.text, empty: false };
  if (b.first === '') return { box: '', empty: true };
  if (!PLACEHOLDER.test(b.first)) return { box: b.text, empty: false };
  const vis = dimChars(raw.split('\n')[b.prompt] || '').slice(1).filter(c => c.ch.trim());
  return { box: b.text, empty: vis.length > 0 && vis.every(c => c.dim) };
}

/** The box holds exactly `cmd`, as typed here: one line, that text, the cursor right after it. */
export function holdsExactly(screen, cursor, cmd) {
  const b = parseBox(screen);
  return !!b && b.lines === 1 && b.first === cmd && cursorAt(cursor, b.prompt, 2 + cmd.length);
}

/* ------------------------------------------------------------------ terminals */

const KEYS = { kitty: { enter: 'enter', backspace: 'backspace' }, tmux: { enter: 'Enter', backspace: 'BSpace' } };
const cleanTitle = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim() || null;

function terminal(run, t, now = Date.now) {
  if (t.how === 'kitty') {
    const { to, window: w, key } = t.term;
    const k = (args, o = {}) => run('kitty', ['@', '--to', to, ...args], { env: key ? { KITTY_PUBLIC_KEY: key } : {}, ...o });
    const m = ['--match', `id:${w}`];
    return {
      /** The window, if it is still the one the session runs in (its shell is above the session's process). */
      async find(above) {
        const r = await k(['ls']);
        let d; try { d = JSON.parse(r.out); } catch { return { error: 'kitty 不接受远程控制（kitty.conf 的 allow_remote_control 或它的密码）' }; }
        for (const ow of d) for (const tab of ow.tabs || []) for (const win of tab.windows || []) {
          if (String(win.id) === String(w)) return above.has(win.pid) ? { title: cleanTitle(tab.title || win.title) } : null;
        }
        return null;
      },
      /** kitty input comes from this Mac's keyboard (HIDIdleTime covers it). */
      lastInputAgoMs: async () => Infinity,
      /** The screen with its colours (the grey hint is told from text by them) and the cursor (row, col from 0). */
      async screen() {
        const r = await k(['get-text', '--ansi', '--add-cursor', ...m]);
        if (r.code !== 0) return null;
        const c = /\x1b\[\?25([hl])\x1b\[(\d+);(\d+)H(?:\x1b\[\?12[hl])?\s*$/.exec(r.out);
        return { text: c ? r.out.slice(0, c.index) : r.out, cursor: c && c[1] === 'h' ? { row: Number(c[2]) - 1, col: Number(c[3]) - 1 } : null };
      },
      type: (text) => k(['send-text', ...m, '--', text]),
      key: (name, n = 1) => k(['send-key', ...m, ...Array(n).fill(KEYS.kitty[name])]),
    };
  }
  const { socket, pane } = t.term;
  const x = (args) => run('tmux', ['-S', socket, ...args]);
  return {
    async find(above) {
      const r = await x(['display-message', '-p', '-t', pane, '#{pane_pid}\t#{synchronize-panes}\t#{session_name}\t#{pane_title}']);
      if (r.code !== 0) return { error: 'tmux 里找不到这个会话的窗格' };
      const [pid, sync, session, title] = r.out.replace(/\n$/, '').split('\t');
      // Panes in sync get every key sent to one: another pane's draft would go with the Enter (Codex r15 restart r3 A1).
      if (sync !== '0') return { error: 'tmux 窗口开着 synchronize-panes（或读不出来），输入会同时进别的窗格' };
      return above.has(Number(pid)) ? { title: cleanTitle(title) ? `${session} · ${cleanTitle(title)}` : `tmux ${session}` } : null;
    },
    /** A tmux client attached to the session may be typing from anywhere (ssh too): its last key, ago. */
    async lastInputAgoMs() {
      const r = await x(['list-clients', '-t', pane, '-F', '#{client_activity}']);
      if (r.code !== 0) return 0;
      const acts = r.out.split('\n').filter(Boolean).map(Number);
      // Whole seconds: a key in second s may have come as late as s + 0.999 (Codex r15 restart r4 A1).
      return acts.length ? now() - (Math.max(...acts) + 1) * 1000 : Infinity;
    },
    async screen() {
      const r = await x(['capture-pane', '-e', '-p', '-t', pane]);
      if (r.code !== 0) return null;
      const c = await x(['display-message', '-p', '-t', pane, '#{cursor_x}\t#{cursor_y}\t#{cursor_flag}']);
      const [cx, cy, flag] = c.out.replace(/\n$/, '').split('\t');
      return { text: r.out, cursor: c.code === 0 && flag === '1' ? { row: Number(cy), col: Number(cx) } : null };
    },
    type: (text) => x(['send-keys', '-t', pane, '-l', text]),
    key: (name, n = 1) => x(['send-keys', '-t', pane, ...(n > 1 ? ['-N', String(n)] : []), KEYS.tmux[name]]),
  };
}

/* ------------------------------------------------------------------ restarting */

/** Sessions on old code, one per client process, with how each can be reached. */
export async function findTargets({ root = HERE_ROOT, lockDir, run = execRun, selfPid = process.pid, home = os.homedir(), now = Date.now } = {}) {
  const s = await scan({ root, lockDir, run, now });
  const list = await claudeAgents(run);
  const byPid = new Map((list || []).filter(a => Number.isInteger(a.pid)).map(a => [a.pid, a]));
  const groups = new Map();
  for (const v of s.servers) {
    if (v.current || v.launcher || !v.client) continue;
    const g = groups.get(v.client) || { client: v.client, servers: [], who: null };
    g.servers.push(v.pid);
    g.who = g.who || v.who;
    groups.set(v.client, g);
  }
  const mine = lineage(s.ps, selfPid);
  const out = [];
  for (const g of groups.values()) {
    const row = s.ps.get(g.client), a = byPid.get(g.client);
    const t = { client: g.client, clientCmd: row?.cmd || '', servers: g.servers, who: g.who, name: a?.name || null, label: null, cwd: a?.cwd || null,
      bgId: a?.kind === 'background' && a.id ? a.id : null, how: 'unknown', term: null, state: 'waiting', note: '', sentAt: null, server: null };
    const sn = serverName({ cwd: t.cwd, cmd: t.clientCmd, root, home });
    t.server = sn.name || null;
    t.serverError = sn.error || null;
    if (!row) t.how = 'gone';
    else if (!isClaude(row.cmd)) t.how = 'other';
    else if (PRINT.test(row.cmd)) t.how = 'print';
    else if (mine.has(g.client)) t.how = 'self';
    else if (t.bgId) t.how = 'background';
    else {
      const env = await procEnv(run, g.client);
      if (env.TMUX && env.TMUX_PANE) { t.how = 'tmux'; t.term = { socket: env.TMUX.split(',')[0], pane: env.TMUX_PANE }; }
      else if (env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON) {
        t.how = 'kitty';
        t.term = { to: env.KITTY_LISTEN_ON, window: env.KITTY_WINDOW_ID, key: env.KITTY_PUBLIC_KEY || null };
      }
    }
    if (t.term) t.label = (await terminal(run, t).find(lineage(s.ps, g.client)))?.title || null;
    out.push(t);
  }
  return { targets: out, agentsOk: !!list };
}

/** What each kind of session gets, before anything is done. */
function firstNote(t, agentsOk) {
  const cmd = `/mcp reconnect ${t.server || '<MyChrome 的名字>'}`;
  switch (t.how) {
    case 'gone': return ['done', '会话已经关了'];
    case 'other': return ['skipped', '不是 Claude Code 会话：关掉它再重开'];
    case 'print': return ['skipped', '一次性任务（claude -p），跑完会自己结束'];
    case 'self': return ['skipped', `就是运行这条命令的会话：命令结束后在这里输入 ${cmd}`];
    case 'unknown': return ['skipped', `不在 kitty 或 tmux 里，没法替你输入：在那个窗口里输入 ${cmd}，或者关掉重开`];
  }
  if (!agentsOk) return ['skipped', '读不到 claude agents，判断不了会话是不是空着，没动它'];
  if (t.how !== 'background' && !t.server) return ['skipped', `${t.serverError}：在那个会话里输入 /mcp 手动 Reconnect`];
  return ['waiting', t.how === 'background' ? '后台会话：空下来后用 claude respawn 重启' : `空下来后替你输入 ${cmd}`];
}

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

export async function restartAll({ root = HERE_ROOT, lockDir, run = execRun, sleep = sleepMs, now = Date.now, selfPid = process.pid,
  home = os.homedir(), pollMs = 3000, waitMs = 30 * 60_000, verifyMs = 30_000, typeSettleMs = 400, quietMs = 3000,
  finalMs = 500, bgIdleMs = 30_000, dryRun = false, onUpdate = () => {} } = {}) {
  const { targets, agentsOk } = await findTargets({ root, lockDir, run, selfPid, home, now });
  for (const t of targets) [t.state, t.note] = firstNote(t, agentsOk);
  if (dryRun) return targets;
  onUpdate(targets);
  const started = now();
  const open = () => targets.filter(t => t.state === 'waiting' || t.state === 'sent');
  const ctx = { root, lockDir, run, sleep, now, pollMs, verifyMs, typeSettleMs, quietMs, finalMs, bgIdleMs };
  while (open().length) {
    ctx.s = await scan({ root, lockDir, run, now });
    ctx.list = await claudeAgents(run) || [];
    if (!ctx.list.length) for (const t of targets) t.idleSince = null;
    for (const t of open()) {
      const before = t.state + t.note;
      await advance(t, ctx);
      if (t.state + t.note !== before) onUpdate(targets);
    }
    if (!open().length) break;
    if (now() - started >= waitMs) {
      const waited = waitMs < 60_000 ? `${Math.round(waitMs / 1000)} 秒` : `${Math.round(waitMs / 60_000)} 分钟`;
      for (const t of open()) {
        if (t.state === 'sent') [t.state, t.note] = ['failed', '发了重连命令，但一直没确认到换成新版'];
        else [t.state, t.note] = ['skipped', `等了 ${waited}还是没机会（${t.note}），没动它`];
      }
      break;
    }
    await sleep(pollMs);
  }
  onUpdate(targets);
  return targets;
}

/** The session's old servers still running in a ps table: the same pid, still this checkout's server, still under the session. */
function oldLeft(t, ps, script) {
  return t.servers.filter(p => !!ps.get(p) && scriptOf(ps.get(p).cmd) === script && (t.how === 'background' || lineage(ps, p).has(t.client)));
}

/** Right before acting: the session as `claude agents` sees it now (the round's list may be seconds old: r1 A6). */
async function idleNow(run, t) {
  const a = (await claudeAgents(run) || []).find(x => x.pid === t.client);
  return !!a && a.status === 'idle' && (t.how === 'background' ? a.kind === 'background' && a.id === t.bgId : a.kind !== 'background');
}

async function advance(t, { s, list, run, root, sleep, now, pollMs, verifyMs, typeSettleMs, quietMs, finalMs, bgIdleMs }) {
  const script = realOr(path.join(root, 'src', 'index.js'));
  const left = oldLeft(t, s.ps, script);
  if (t.state === 'sent') {
    const sess = t.how === 'background' ? list.find(a => a.id === t.bgId)?.pid : t.client;
    if (!left.length && s.servers.some(v => v.client === sess && v.current)) { [t.state, t.note] = ['done', '已重启，用上新版了']; return; }
    if (now() - t.sentAt < verifyMs) return;
    // No key is pressed here any more (an Escape for a menu could reach another dialog or window: r1 A4).
    [t.state, t.note] = left.length
      ? ['failed', `发了 /mcp reconnect ${t.server}，但 MyChrome 没换（这个会话的 Claude Code 可能太旧）：如果那里开着 /mcp 菜单，按 Esc 关掉，再选 ${t.server} → Reconnect，或者关掉重开`]
      : ['failed', `旧的 MyChrome 停了，新的没起来：在这个会话里输入 /mcp 看看 ${t.server} 的状态`];
    return;
  }
  const client = s.ps.get(t.client);
  if (!client || !isClaude(client.cmd)) { [t.state, t.note] = ['done', '会话已经关了']; return; }
  if (!left.length) { [t.state, t.note] = ['done', '已经换成新版了']; return; }
  const a = list.find(x => x.pid === t.client);
  if (!a) { t.idleSince = null; t.note = 'claude agents 里暂时找不到这个会话，等一下再看'; return; }
  if (a.status !== 'idle') { t.idleSince = null; t.note = '正在忙，等它停下'; return; }
  if (t.how === 'background') {
    // respawn restarts the process whatever it is doing: only after the session looked idle on every look for
    // bgIdleMs, and idle again right before (Codex r15 restart r2 A5); a missed look starts over (r3 B1).
    if (t.idleLook == null || now() - t.idleLook > 3 * pollMs) t.idleSince = null;
    t.idleLook = now();
    t.idleSince = t.idleSince ?? now();
    if (now() - t.idleSince < bgIdleMs) { t.note = `后台会话：连续空着 ${Math.round(bgIdleMs / 1000)} 秒后用 claude respawn 重启`; return; }
    // Restarted by someone meanwhile: nothing to do (Codex r15 restart r11 A1). Looked at first, so the idle check is
    // the last thing before respawn, and only an idle check that took under finalMs counts (r12 A1).
    if (!oldLeft(t, await psTable(run, now), script).length) { [t.state, t.note] = ['done', '已经换成新版了']; return; }
    const tIdle = now();
    if (!(await idleNow(run, t)) || now() - tIdle > finalMs) { t.idleSince = null; t.note = '正在忙，等它停下'; return; }
    const r = await run('claude', ['respawn', t.bgId], { timeout: 60_000 });
    if (r.code !== 0) { [t.state, t.note] = ['failed', `claude respawn ${t.bgId} 没成功：用 claude attach ${t.bgId} 打开它，输入 /mcp 手动 Reconnect`]; return; }
    [t.state, t.note, t.sentAt] = ['sent', '已用 claude respawn 重启，正在确认', now()];
    return;
  }
  const ops = terminal(run, t, now);
  const win = await ops.find(lineage(s.ps, t.client));
  if (!win || win.error) { [t.state, t.note] = ['skipped', `${win?.error || '找不到它所在的窗口'}：在那个会话里输入 /mcp reconnect ${t.server}`]; return; }
  t.label = win.title || t.label;
  const quiet = async () => Math.min((await hidIdleMs(run)) ?? 0, await ops.lastInputAgoMs());
  // Everything that decides whether to type, looked at fresh and together inside finalMs: the session idle (the
  // second time), still on old code, in its terminal's foreground, the window/pane still its own (tmux not in sync),
  // an empty input box, nobody typing. Done once to wait cheaply, then again right before typing: anything typed
  // cannot be taken back (Codex r15 restart r2 A3, r5 A1, r6 A1, r11 A1, r12 A1).
  const look = async ({ idle = false } = {}) => {
    const t1 = now();
    // Idle per claude agents, inside the same time limit: a turn can start by itself (a background task's notice).
    if (idle && !(await idleNow(run, t))) return { note: '正在忙，等它停下' };
    const ps = await psTable(run, now);
    // Still on old code: reconnected by hand meanwhile (claude agents can take seconds) → nothing to do (r11 A1).
    if (!oldLeft(t, ps, script).length) return { done: true };
    if (!inForeground(ps.get(t.client))) return { note: '它现在不在终端前台（被挂起了，或者在跑别的程序），等一下' };
    const w = await ops.find(lineage(ps, t.client));
    if (!w || w.error) return { lost: `${w?.error || '找不到它所在的窗口'}：在那个会话里输入 /mcp reconnect ${t.server}` };
    const sc = await ops.screen();
    const { box, empty } = readBox(sc?.text, sc?.cursor);
    if (box === null) return { note: '画面上没有空着的输入框（可能开着菜单或在等确认），等一下' };
    if (!empty) return { note: '输入框里有没发出去的字，等它清空' };
    if ((await quiet()) < quietMs) return { note: '你正在用电脑，等你停下几秒再输入' };
    const at = now();
    return at - t1 <= finalMs ? { ok: true, at } : { note: '这台电脑现在反应慢，等一下再试' };
  };
  const first = await look();
  if (first.done) { [t.state, t.note] = ['done', '已经换成新版了']; return; }
  if (first.lost) { [t.state, t.note] = ['skipped', first.lost]; return; }
  if (!first.ok) { t.note = first.note; return; }
  const gate = await look({ idle: true });
  if (gate.done) { [t.state, t.note] = ['done', '已经换成新版了']; return; }
  if (gate.lost) { [t.state, t.note] = ['skipped', gate.lost]; return; }
  if (!gate.ok) { t.note = gate.note; return; }
  const t0 = gate.at;
  const cmd = `/mcp reconnect ${t.server}`;
  await ops.type(cmd);
  await sleep(typeSettleMs);
  // The last looks and Enter close together: the foreground, the box, the keyboard, then Enter, and only when those
  // looks took under finalMs, so a slow look never leaves time for someone to change the box (r2 A2).
  const tLast = now();
  const idleStill = await idleNow(run, t);
  const ps = await psTable(run, now);
  // The window or pane again too: still the session's, and for tmux still not in sync with other panes (r4 A1).
  const still = inForeground(ps.get(t.client)) && oldLeft(t, ps, script).length > 0 && (await ops.find(lineage(ps, t.client)));
  const back = still && !still.error ? await ops.screen() : null;
  const untouched = idleStill && !!back && holdsExactly(back.text, back.cursor, cmd) && (await quiet()) >= now() - t0;
  if (untouched && now() - tLast <= finalMs) {
    await ops.key('enter');
    [t.state, t.note, t.sentAt] = ['sent', `已输入 /mcp reconnect ${t.server}，正在确认`, now()];
    return;
  }
  // Never a key after that: no Enter and no Backspace (the cursor may be anywhere: r2 A1). The command is the owner's now.
  [t.state, t.note] = ['skipped', `替你输入时有人在用电脑（或画面变了），没有按回车，也没删任何字：那个会话的输入框里留着 ${cmd}，要重启就按回车，不要就删掉`];
}

/* ------------------------------------------------------------------ the command */

const HOW = { kitty: 'kitty 标签页', tmux: 'tmux', background: '后台会话', print: 'claude -p', other: '其他程序', unknown: '其他终端', self: '本会话', gone: '已关闭' };
const STATE = { waiting: '等待', sent: '已发送', done: '完成', skipped: '没动', failed: '失败' };
export const targetName = (t) => t.label || t.name || t.who || `pid ${t.client}`;
const brief = (t) => ({ client: t.client, name: targetName(t), how: t.how, state: t.state, note: t.note });

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/**
 * One run at a time: a lock directory (mkdir is atomic) holding the owner's pid, taken before anything is looked at
 * and held until exit (Codex r15 restart r1 A5). A lock whose owner is gone is taken over, and taking over is itself
 * claimed with a second mkdir, so of two runs that both saw the dead owner only one gets it (r2 A4). A claim is never
 * removed by anyone but its maker (age proves nothing: r3 B2); one left behind by a run that died in that instant is
 * reported for the owner to delete. null when this run has the lock, else the owner's pid (-1: not known; -2: a claim
 * left behind; -3: a lock left without a pid).
 */
function takeLock(dir) {
  const pidFile = path.join(dir, 'pid'), claim = `${dir}.takeover`;
  const owner = () => { try { return Number(readFileSync(pidFile, 'utf8')) || 0; } catch { return 0; } };
  const mine = () => { writeFileSync(`${pidFile}.${process.pid}`, String(process.pid)); renameSync(`${pidFile}.${process.pid}`, pidFile); };
  mkdirSync(path.dirname(dir), { recursive: true });
  try { mkdirSync(dir); mine(); return null; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  let o = owner();
  if (o && alive(o)) return o;
  // No pid: just made by a run about to write it, or one that died right then; age proves neither, so it is left
  // for the owner to delete (r4 B1).
  if (!o) { try { return Date.now() - statSync(dir).mtimeMs < 5000 ? -1 : -3; } catch { return -1; } }
  try { mkdirSync(claim); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let c = 0;
    try { c = Number(readFileSync(path.join(claim, 'pid'), 'utf8')) || 0; } catch {}
    if (c) return alive(c) ? -1 : -2;
    // No pid in the claim: being made (young), or its maker died right then (old): reported, never taken (r5 B1).
    try { return Date.now() - statSync(claim).mtimeMs < 5000 ? -1 : -2; } catch { return -1; }
  }
  try {
    writeFileSync(path.join(claim, 'pid'), String(process.pid));
    o = owner();
    if (o && alive(o)) return o;
    mine();
    return null;
  } finally {
    rmSync(claim, { recursive: true, force: true });
  }
}
export const __takeLockForTests = takeLock;

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/** `restart-all [--dry-run] [--json] [--wait <minutes>] [--root <checkout>]`. Exit 0 unless a session failed. */
export async function runRestartCli(argv, { lockDir, out = (s) => process.stdout.write(s + '\n'), ...opts } = {}) {
  const dryRun = argv.includes('--dry-run'), json = argv.includes('--json');
  const wi = argv.indexOf('--wait');
  const waitMin = wi >= 0 && Number(argv[wi + 1]) > 0 ? Number(argv[wi + 1]) : 30;
  const ri = argv.indexOf('--root');
  const root = ri >= 0 && argv[ri + 1] ? path.resolve(argv[ri + 1]) : HERE_ROOT;
  const base = path.dirname(lockDir);
  const stateFile = path.join(base, 'restart-all.json'), runLock = path.join(base, 'restart-all.lock');
  const write = (o) => {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    try { mkdirSync(base, { recursive: true }); writeFileSync(tmp, JSON.stringify(o)); renameSync(tmp, stateFile); } catch {}
  };
  let release = () => {};
  const onSignal = () => { release(); process.exit(1); };
  if (!dryRun) {
    const owner = takeLock(runLock);
    if (owner === -2 || owner === -3) {
      const msg = `上次的重启没收拾干净：确认没有 restart-all 在跑后，删掉 ${owner === -2 ? `${runLock}.takeover` : runLock} 再点「全部重启」。`;
      write({ pid: process.pid, startedAt: Date.now(), at: Date.now(), finished: true, error: msg, items: [] });
      out(json ? JSON.stringify({ error: msg }) : msg);
      return 1;
    }
    if (owner) {
      out(json ? JSON.stringify({ running: owner }) : `已经在重启了${owner > 0 ? `（pid ${owner}）` : ''}，进度见面板。`);
      return 0;
    }
    release = () => {
      try { if (Number(readFileSync(path.join(runLock, 'pid'), 'utf8')) === process.pid) rmSync(runLock, { recursive: true, force: true }); } catch {}
    };
    process.once('exit', release);
    for (const sig of SIGNALS) process.once(sig, onSignal);
  }
  try {
    const startedAt = Date.now();
    const targets = await restartAll({ ...opts, root, lockDir, dryRun, waitMs: waitMin * 60_000,
      onUpdate: (ts) => write({ pid: process.pid, startedAt, at: Date.now(), finished: false, items: ts.map(brief) }) });
    if (!dryRun) write({ pid: process.pid, startedAt, at: Date.now(), finished: true, items: targets.map(brief) });
    if (json) out(JSON.stringify(targets.map(brief)));
    else if (!targets.length) out('没有需要重启的会话。');
    else for (const t of targets) out(`${targetName(t)}（${HOW[t.how] || t.how}）${dryRun ? '' : '：' + STATE[t.state]}：${t.note}`);
    return targets.some(t => t.state === 'failed') ? 1 : 0;
  } finally {
    release();
    process.off('exit', release);
    for (const sig of SIGNALS) process.off(sig, onSignal);
  }
}
