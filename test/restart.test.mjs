#!/usr/bin/env node
/* 「全部重启」 (src/restart.js): which sessions run old code and how each is reached; `/mcp reconnect` typed only
 * into an idle session whose input box is empty, what it typed taken back when someone types at the same moment,
 * `claude respawn` for a background session, and the check that the session really runs the new code afterwards.
 * ps, kitty, tmux and claude are faked here; nothing reaches a real terminal. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, stat, utimes } from 'node:fs/promises';
import { writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-restart-test-'));
const R = await import('../src/restart.js');
const { sourceFingerprint } = await import('../src/settings.js');
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const CMD = '/mcp reconnect chrome-bridge';

/* ---------------------------------------------------------------- a fake machine */

const RULE = '─'.repeat(60);
/** A screen as Claude Code draws it, with the cursor where the next key would go: { text, cursor (row, col from 0) }. */
function screenOf(box) {
  if (box.menu) return { text: ['Manage MCP servers', '', '❯ chrome-bridge · ✔ connected', '', 'Esc to close'].join('\n'), cursor: { row: 0, col: 0 } };
  // The grey hint dim (SGR 2), what was typed plain; continuation lines indented by two.
  const typed = box.text.split('\n');
  const lines = box.text === '' ? ['\x1b[39m❯ ' + (box.placeholder ? '\x1b[2mTry "fix lint errors"\x1b[0m' : '')] : typed.map((l, i) => (i ? '  ' : '\x1b[39m❯ ') + l);
  const head = ['▐▛███▜▌ Claude Code', '', '❯ /mcp reconnect chrome-bridge', '  ⎿  Successfully reconnected to chrome-bridge', '', RULE];
  const cursor = { row: head.length + typed.length - 1, col: 2 + typed[typed.length - 1].length };
  return { text: [...head, ...lines, RULE, '  ⏵⏵ auto mode on', ''].join('\n'), cursor };
}

let worlds = 0;
async function world() {
  const dir = path.join(tmp, `w${++worlds}`);
  const root = path.join(dir, 'repo');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.js'), 'export {};\n');
  await writeFile(path.join(root, 'src', 'index.js'), '');
  const lockDir = path.join(dir, 'lock', 'input.lock');
  const serversDir = path.join(dir, 'lock', 'servers');
  await mkdir(serversDir, { recursive: true });
  const W = { dir, root, lockDir, serversDir, current: sourceFingerprint(root), ps: new Map(), agents: [], windows: new Map(), panes: new Map(),
    sessions: [], log: [], prompts: [], nextPid: 5000, kittyTo: 'unix:/tmp/kitty-777', kittyKey: '1:pubkey', tmuxSock: '/tmp/tmux-501/default',
    t: 0, onTick: null, lastInput: -1e9, tmuxClients: [], agentsCalls: 0 };
  W.home = path.join(dir, 'home');
  await mkdir(W.home);
  // The user's config: this checkout is chrome-bridge.
  await writeFile(path.join(W.home, '.claude.json'), JSON.stringify({ mcpServers: { 'chrome-bridge': { command: 'node', args: [path.join(root, 'src', 'index.js')] } } }));
  W.proc = (pid, ppid, cmd, env = {}, o = {}) => W.ps.set(pid, { pid, ppid, pgid: o.pgid ?? pid, tpgid: o.tpgid ?? pid, stat: o.stat || 'S+', tty: 'ttys001', cmd, env, start: W.t });
  const etime = (ms) => { const t = Math.floor(ms / 1000); return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  W.server = (client, { current = false, presence = true, launcher = false, script = path.join(root, 'src', 'index.js') } = {}) => {
    let parent = client, launcherPid = null;
    if (launcher) { launcherPid = W.nextPid++; W.proc(launcherPid, client, `node ${script}`); parent = launcherPid; }
    const pid = W.nextPid++;
    W.proc(pid, parent, `node ${script}`);
    if (presence) writeFileSync(path.join(serversDir, `${pid}.json`), JSON.stringify({ pid, root, srcHash: current ? W.current : 'old0000000000000', who: 'Claude · x', launcher: launcherPid, startedAt: W.t + 300 }));
    return pid;
  };
  W.session = (o = {}) => {
    const login = W.nextPid++, shell = W.nextPid++, claude = W.nextPid++;
    W.proc(login, 1, '/usr/bin/login -f -l user');
    W.proc(shell, login, '-zsh');
    const env = {};
    if (o.how === 'kitty') Object.assign(env, { KITTY_WINDOW_ID: String(o.window ?? claude), KITTY_LISTEN_ON: W.kittyTo, KITTY_PUBLIC_KEY: W.kittyKey });
    if (o.how === 'tmux') Object.assign(env, { TMUX: `${W.tmuxSock},999,0`, TMUX_PANE: `%${claude}` });
    W.proc(claude, o.bg ? 1 : shell, o.cmd || (o.bg ? 'claude bg-spare --bg-spare /tmp/x.sock' : 'claude --dangerously-skip-permissions'), env,
      o.suspended ? { stat: 'T', tpgid: shell } : {});
    const s = { claude, how: o.how, box: { text: o.text || '', menu: false, placeholder: !!o.placeholder }, knows: o.knows !== false, broken: !!o.broken, servers: [] };
    if (o.how === 'kitty') W.windows.set(String(o.window ?? claude), { id: o.window ?? claude, pid: o.windowPid ?? login, title: `✳ ${o.title || 'tab ' + claude}`, s });
    if (o.how === 'tmux') W.panes.set(`%${claude}`, { pid: shell, title: `✳ ${o.title || 'pane'}`, session: 'butler', s });
    if (o.agent !== false) W.agents.push({ pid: claude, kind: o.bg ? 'background' : 'interactive', status: o.status || 'idle', name: o.name || `sess-${claude}`, cwd: '/x', ...(o.bg ? { id: `bg${claude}` } : {}) });
    for (let i = 0; i < (o.servers ?? 1); i++) s.servers.push(W.server(claude, { current: o.current, presence: o.presence !== false, launcher: o.launcher }));
    W.sessions.push(s);
    return s;
  };
  W.agent = (s) => W.agents.find(a => a.pid === s.claude);
  /** The session's old servers stop; a new one (current code) starts under it unless the reconnect is broken. */
  W.reconnect = (s) => {
    for (const p of s.servers) W.ps.delete(p);
    s.servers = s.broken ? [] : [W.server(s.claude, { current: true })];
  };
  W.submit = (s) => {
    const text = s.box.text;
    s.box.text = '';
    if (text === CMD && s.knows) W.reconnect(s);
    else if (text.startsWith('/mcp')) s.box.menu = true;
    else W.prompts.push(text);
  };
  W.keys = (s, keys) => {
    for (const k of keys) {
      if (k === 'enter' || k === 'Enter') W.submit(s);
      else if (k === 'escape' || k === 'Escape') s.box.menu = false;
      else if (k === 'backspace' || k === 'BSpace') s.box.text = s.box.text.slice(0, -1);
    }
  };
  W.typed = (s, text) => { if (W.onType) W.onType(s); if (!s.box.menu) s.box.text += text; };
  W.run = async (cmd, args, opts = {}) => {
    W.log.push([cmd, ...args].join(' '));
    if (cmd === '/bin/ps' && args[0] === '-axo') {
      assert.equal(args[1], 'pid=,ppid=,pgid=,tpgid=,stat=,etime=,tty=,command=');
      if (W.onPs) W.onPs();
      return { code: 0, out: [...W.ps.values()].map(p => `${p.pid} ${p.ppid} ${p.pgid} ${p.tpgid} ${p.stat} ${etime(W.t - p.start)} ${p.tty} ${p.cmd}`).join('\n') + '\n' };
    }
    if (cmd === '/usr/sbin/ioreg') return { code: 0, out: `    | |   "HIDIdleTime" = ${Math.round((W.t - W.lastInput) * 1e6)}\n` };
    if (cmd === '/bin/ps' && args[0] === '-E') {
      const p = W.ps.get(Number(args.at(-1)));
      return p ? { code: 0, out: `${p.cmd} TERM=xterm ${Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join(' ')}\n` } : { code: 1, out: '' };
    }
    if (cmd === 'claude' && args[0] === 'agents') {
      W.agentsCalls++;
      if (W.onAgents) W.onAgents(W.agentsCalls);
      return W.agentsBroken ? { code: 1, out: '' } : { code: 0, out: JSON.stringify(W.agents.filter(a => W.ps.has(a.pid))) };
    }
    if (cmd === 'claude' && args[0] === 'respawn') {
      const a = W.agents.find(x => x.id === args[1]);
      const s = a && W.sessions.find(x => x.claude === a.pid);
      if (!s || W.respawnFails) return { code: 1, out: '' };
      for (const p of [s.claude, ...s.servers]) W.ps.delete(p);
      s.claude = W.nextPid++;
      W.proc(s.claude, 1, 'claude bg-spare --bg-spare /tmp/y.sock');
      a.pid = s.claude;
      s.servers = [W.server(s.claude, { current: true })];
      return { code: 0, out: '' };
    }
    if (cmd === 'kitty') {
      assert.deepEqual(args.slice(0, 3), ['@', '--to', W.kittyTo]);
      if (opts.env?.KITTY_PUBLIC_KEY !== W.kittyKey) return { code: 1, out: 'Error: Password usage requested but KITTY_PUBLIC_KEY environment variable is not available' };
      const sub = args[3];
      if (sub === 'ls') return { code: 0, out: JSON.stringify([{ id: 1, tabs: [...W.windows.values()].map(w => ({ title: w.title, windows: [{ id: w.id, pid: w.pid, title: w.title }] })) }]) };
      const mi = args.indexOf('--match'), w = W.windows.get(args[mi + 1].replace(/^id:/, ''));
      if (!w) return { code: 1, out: '' };
      if (sub === 'get-text') {
        const sc = screenOf(w.s.box);
        return { code: 0, out: sc.text + (args.includes('--add-cursor') ? `\x1b[?25h\x1b[${sc.cursor.row + 1};${sc.cursor.col + 1}H\x1b[?12h` : '') };
      }
      if (sub === 'send-text') { W.typed(w.s, args[args.indexOf('--') + 1]); return { code: 0, out: '' }; }
      if (sub === 'send-key') { W.keys(w.s, args.slice(mi + 2)); return { code: 0, out: '' }; }
    }
    if (cmd === 'tmux') {
      assert.deepEqual(args.slice(0, 2), ['-S', W.tmuxSock]);
      const ti = args.indexOf('-t'), p = W.panes.get(args[ti + 1]);
      if (!p) return { code: 1, out: '' };
      if (args[2] === 'display-message' && args.at(-1) === '#{cursor_x}\t#{cursor_y}\t#{cursor_flag}') {
        const c = screenOf(p.s.box).cursor;
        return { code: 0, out: `${c.col}\t${c.row}\t1\n` };
      }
      if (args[2] === 'display-message') {
        assert.equal(args.at(-1), '#{pane_pid}\t#{synchronize-panes}\t#{session_name}\t#{pane_title}');
        return { code: 0, out: `${p.pid}\t${p.sync ?? 0}\t${p.session}\t${p.title}\n` };
      }
      if (args[2] === 'capture-pane') return { code: 0, out: screenOf(p.s.box).text };
      if (args[2] === 'list-clients') return { code: 0, out: W.tmuxClients.map(x => `${x}\n`).join('') };
      if (args[2] === 'send-keys') {
        const rest = args.slice(ti + 2);
        if (rest[0] === '-l') W.typed(p.s, rest[1]);
        else if (rest[0] === '-N') W.keys(p.s, Array(Number(rest[1])).fill(rest[2]));
        else W.keys(p.s, rest);
        return { code: 0, out: '' };
      }
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
  W.opts = (extra = {}) => ({ root, lockDir, run: W.run, home: W.home, selfPid: 1, pollMs: 3000, waitMs: 60_000, verifyMs: 9000, typeSettleMs: 400,
    now: () => W.t, sleep: async (ms) => { W.t += ms; if (W.onTick) W.onTick(W.t); }, ...extra });
  return W;
}
const typedCount = (W) => W.log.filter(l => / send-text | -l /.test(l)).length;

/* ---------------------------------------------------------------- the input box */

{
  const box = (text, o = {}) => R.inputBox(screenOf({ text, menu: false, placeholder: false, ...o }).text);
  const st = (o) => { const sc = screenOf({ text: '', menu: false, placeholder: false, ...o }); return R.readBox(sc.text, sc.cursor); };
  assert.equal(box(''), '');
  assert.equal(box('', { placeholder: true }), 'Try "fix lint errors"');
  // The grey hint is empty only when drawn dim; the same words typed are a draft (Codex r7 A2).
  assert.deepEqual(st({}), { box: '', empty: true });
  assert.deepEqual(st({ placeholder: true }), { box: 'Try "fix lint errors"', empty: true });
  assert.deepEqual(st({ text: 'Try "explain this function"' }), { box: 'Try "explain this function"', empty: false });
  const at2 = { row: 1, col: 2 };
  assert.equal(R.readBox([RULE, '❯ \x1b[2mTry "x"\x1b[0m', RULE].join('\n'), at2).empty, true);
  assert.equal(R.readBox([RULE, '❯ \x1b[38;2;2;2;2mTry "x"\x1b[0m', RULE].join('\n'), at2).empty, false, 'a colour with 2s in it is not dim');
  assert.equal(R.readBox([RULE, '❯ \x1b[2mTry "x\x1b[22m" more"', RULE].join('\n'), at2).empty, false, 'partly dim is not the hint');
  assert.equal(R.readBox([RULE, '❯ ', RULE].join('\n'), null).empty, false, 'cursor unknown: not known to be empty');
  // A draft of spaces or empty lines reads like an empty line: the cursor or the box's height tells (Codex r8 A1).
  assert.deepEqual(st({ text: ' ' }), { box: '', empty: false });
  assert.deepEqual(st({ text: '\n' }), { box: '', empty: false });
  assert.deepEqual(st({ text: '  \n ' }), { box: '', empty: false });
  // What was typed reads back only as exactly the command with the cursor right after it.
  const ex = (text) => { const sc = screenOf({ text, menu: false, placeholder: false }); return R.holdsExactly(sc.text, sc.cursor, CMD); };
  assert.ok(ex(CMD) && !ex(CMD + ' ') && !ex(' ' + CMD) && !ex(CMD + '\n') && !ex('x' + CMD));
  assert.equal(box('hello'), 'hello');
  assert.equal(box('hello\nsecond line'), 'hello\nsecond line');
  assert.ok(!st({ text: 'hello' }).empty && !st({ text: 'Try "this" and more' }).empty);
  assert.equal(box(CMD), CMD, 'a typed command reads back exactly');
  assert.equal(R.inputBox(screenOf({ text: '', menu: true }).text), null, 'a menu: no input box');
  assert.equal(R.inputBox(['❯ /mcp reconnect chrome-bridge', '  ⎿  done'].join('\n')), null, 'a transcript line is not the input box');
  assert.equal(R.inputBox([RULE, '❯ half-drawn'].join('\n')), null, 'no closing rule: not the input box');
  assert.equal(R.inputBox(null), null);
  // Real screens: a no-break space after ❯; an older Claude Code's labelled top rule.
  assert.equal(R.inputBox([RULE, '❯\u00a0继续', RULE, '  status'].join('\n')), '继续');
  assert.equal(R.inputBox(['──── w60 ' + '─'.repeat(40), '❯', RULE, '  status'].join('\n')), '');
  // A draft holding rules and a ❯ of its own (indented, as Claude Code draws continuation lines): its text, not a box (r7 A1).
  const nested = box(`intro\n${RULE}\n❯ \n${RULE}`);
  assert.ok(nested.includes('intro'), JSON.stringify(nested));
  assert.equal(st({ text: `intro\n${RULE}\n❯ \n${RULE}` }).empty, false);
  // A question or menu with a ❯ choice (no rule right above the ❯ line): not the input box.
  assert.equal(R.inputBox(['Do you want to proceed?', RULE, 'transcript', '❯ 1. Yes', '  2. No', RULE, '  status'].join('\n')), null);
  ok('input box: empty, placeholder (not empty), a draft (one and two lines, with a box of its own), a menu, a transcript line, real screens');
}

/* ---------------------------------------------------------------- which sessions */

{
  const W = await world();
  const kitty = W.session({ how: 'kitty', title: 'w60 · Pourtype' });
  const tmux = W.session({ how: 'tmux', title: '巡检 butler' });
  const bg = W.session({ bg: true, name: 'pm-nightly' });
  const two = W.session({ how: 'kitty', servers: 2 });
  const legacy = W.session({ how: 'kitty', presence: false });
  W.session({ how: 'kitty', current: true });                      // up to date
  W.session({ how: 'kitty', launcher: true });                     // updates itself
  const print = W.session({ cmd: 'claude -p "do it"' });
  const other = W.session({ cmd: '/opt/homebrew/bin/codex mcp' });
  const plain = W.session({});                                     // Terminal.app: no kitty, no tmux
  // Not servers: a doctor run, a launcher's look at new code, a launcher whose worker has not written its file yet,
  // and another checkout's server.
  W.proc(9001, plain.claude, `node ${path.join(W.root, 'src', 'index.js')} doctor`);
  W.proc(9002, 9003, `node ${path.join(W.root, 'src', 'index.js')} --probe`);
  W.proc(9003, plain.claude, `node ${path.join(W.root, 'src', 'index.js')}`);
  W.proc(9004, 9003, `node ${path.join(W.root, 'src', 'index.js')}`);
  W.server(other.claude, { script: '/elsewhere/src/index.js' });
  // An old server started through an installed command that links to this checkout (no file): found (r7 B3).
  const linked = W.session({ how: 'kitty', servers: 0 });
  await mkdir(path.join(W.dir, 'gbin'), { recursive: true });
  await symlink(path.join(W.root, 'src', 'index.js'), path.join(W.dir, 'gbin', 'mychrome-mcp'));
  W.proc(W.nextPid++, linked.claude, `node ${path.join(W.dir, 'gbin', 'mychrome-mcp')}`);
  W.t = 120_000;                                                    // the old ones without a file are over a minute old
  const { targets, agentsOk } = await R.findTargets({ root: W.root, lockDir: W.lockDir, run: W.run, home: W.home, selfPid: 1, now: () => W.t });
  assert.ok(agentsOk);
  const by = new Map(targets.map(t => [t.client, t]));
  assert.deepEqual([...by.keys()].sort(), [kitty, tmux, bg, two, legacy, print, other, plain, linked].map(s => s.claude).sort(), `old-code sessions only, one each: ${JSON.stringify([...by.keys()].sort())} vs ${JSON.stringify([kitty, tmux, bg, two, legacy, print, other, plain, linked].map(s => s.claude).sort())}`);
  assert.equal(by.get(kitty.claude).how, 'kitty');
  assert.equal(by.get(kitty.claude).label, 'w60 · Pourtype', 'named by its tab title');
  assert.deepEqual(by.get(kitty.claude).term, { to: W.kittyTo, window: String(kitty.claude), key: W.kittyKey });
  assert.equal(by.get(tmux.claude).how, 'tmux');
  assert.equal(by.get(tmux.claude).label, 'butler · 巡检 butler');
  assert.deepEqual(by.get(tmux.claude).term, { socket: W.tmuxSock, pane: `%${tmux.claude}` });
  assert.equal(by.get(bg.claude).how, 'background');
  assert.equal(R.targetName(by.get(bg.claude)), 'pm-nightly');
  assert.equal(by.get(two.claude).servers.length, 2);
  assert.equal(by.get(legacy.claude).how, 'kitty', 'a server older than presence files, from ps');
  assert.equal(by.get(print.claude).how, 'print');
  assert.equal(by.get(other.claude).how, 'other');
  assert.equal(by.get(plain.claude).how, 'unknown');
  assert.equal(typedCount(W), 0, 'looking types nothing');
  // The session this runs in is never typed into (it is busy running this).
  const self = await R.findTargets({ root: W.root, lockDir: W.lockDir, run: W.run, home: W.home, selfPid: kitty.claude, now: () => W.t });
  assert.equal(self.targets.find(t => t.client === kitty.claude).how, 'self');
  ok('targets: old code only (not up to date, not under the launcher, not a doctor run or a look at new code), how each is reached, named by its tab');
}

{
  const W = await world();
  const script = path.join(W.root, 'src', 'index.js');
  await writeFile(script, '');
  // An installed `mychrome-mcp` elsewhere and one linked to this checkout, found through PATH.
  const bin = path.join(W.dir, 'bin'), other = path.join(W.dir, 'other', 'src', 'index.js');
  await mkdir(path.dirname(other), { recursive: true });
  await writeFile(other, '');
  await mkdir(bin);
  await mkdir(path.join(W.dir, 'bin2'));
  await symlink(other, path.join(bin, 'mychrome-mcp'));
  await symlink(script, path.join(W.dir, 'bin2', 'mychrome-mcp-here'));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${path.join(W.dir, 'bin2')}:${oldPath}`;
  try {
    await writeFile(path.join(W.home, '.claude.json'), JSON.stringify({
      mcpServers: { global: { command: 'mychrome-mcp' }, mychrome: { command: 'node', args: [script] } },
      projects: { '/proj': { mcpServers: { 'cb-local': { command: 'mychrome-mcp-here' } } }, '/two': { mcpServers: { again: { command: 'node', args: [script] } } } } }));
    const name = (o) => R.serverName({ root: W.root, home: W.home, ...o });
    assert.deepEqual(name({ cwd: '/x' }), { name: 'mychrome' }, 'the installed one elsewhere is not this checkout');
    assert.match(name({ cwd: '/proj' }).error, /2 个指向这个目录的 MyChrome（(cb-local、mychrome|mychrome、cb-local)）/, 'two names in one session: none guessed');
    // Scopes as Claude Code resolves them: a local entry of the same name replaces the user's (and points elsewhere),
    // this checkout comes from the project's .mcp.json under another name (Codex r2 A6).
    const proj = path.join(W.dir, 'proj');
    await mkdir(proj);
    await writeFile(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'cb-here': { command: 'node', args: [script] } } }));
    await writeFile(path.join(W.home, '.claude.json'), JSON.stringify({
      mcpServers: { 'chrome-bridge': { command: 'node', args: [script] } },
      projects: { [proj]: { mcpServers: { 'chrome-bridge': { command: 'node', args: [other] } } } } }));
    assert.deepEqual(name({ cwd: proj }), { name: 'cb-here' }, 'the overridden user entry is not used');
    await writeFile(path.join(W.home, '.claude.json'), JSON.stringify({
      mcpServers: { 'chrome-bridge': { command: 'node', args: [script] } },
      projects: { [proj]: { mcpServers: { 'cb-here': { command: 'node', args: [other] } } } } }));
    assert.deepEqual(name({ cwd: proj }), { name: 'chrome-bridge' }, 'a local entry replaces the project one of the same name');
    await writeFile(path.join(W.home, '.claude.json'), JSON.stringify({
      mcpServers: { global: { command: 'mychrome-mcp' }, mychrome: { command: 'node', args: [script] } },
      projects: { '/proj': { mcpServers: { 'cb-local': { command: 'mychrome-mcp-here' } } }, '/two': { mcpServers: { again: { command: 'node', args: [script] } } } } }));
    assert.match(name({ cwd: '/x', home: path.join(W.dir, 'nohome') }).error, /找不到指向这个目录/, 'no entry: no guess');
    const cfg = path.join(W.dir, 'mcp.json');
    await writeFile(cfg, JSON.stringify({ mcpServers: { e2e: { command: 'node', args: [script] } } }));
    assert.deepEqual(name({ cwd: '/x', cmd: `claude --strict-mcp-config --mcp-config ${cfg}` }), { name: 'e2e' }, '--strict-mcp-config: only its file');
    assert.match(name({ cwd: '/x', cmd: `claude --mcp-config ${cfg}` }).error, /e2e、mychrome|mychrome、e2e/);
    // A relative file is the session's (its cwd), not this process's; an inline JSON that ps split at its spaces, or
    // a file that is not there: no guess from a lower scope (Codex r3 A2).
    assert.deepEqual(name({ cwd: W.dir, cmd: 'claude --strict-mcp-config --mcp-config mcp.json' }), { name: 'e2e' });
    assert.deepEqual(name({ cwd: W.dir, cmd: 'claude --strict-mcp-config --mcp-config=mcp.json' }), { name: 'e2e' });
    assert.match(name({ cwd: '/x', cmd: `claude --mcp-config {"mcpServers": {"chrome-bridge": {"command": "node", "args": ["${other}"]}}}` }).error, /--mcp-config 读不出来/);
    assert.match(name({ cwd: '/x', cmd: 'claude --mcp-config /nowhere.json' }).error, /--mcp-config 读不出来/);
    const W2 = await world();
    await writeFile(path.join(W2.home, '.claude.json'), JSON.stringify({ mcpServers: { global: { command: 'mychrome-mcp' } } }));
    W2.session({ how: 'kitty' });
    const [r] = await R.restartAll(W2.opts());
    assert.equal(r.state, 'skipped');
    assert.match(r.note, /不知道它叫什么/);
    assert.equal(typedCount(W2), 0, 'no name: nothing typed');
  } finally { process.env.PATH = oldPath; }
  ok('server name: only entries that lead to this checkout (not another install of mychrome-mcp), --mcp-config, none or two: left alone');
}

/* ---------------------------------------------------------------- restarting */

{
  const W = await world();
  const k = W.session({ how: 'kitty', placeholder: true });                // a fresh session shows the grey hint
  const t = W.session({ how: 'tmux' });
  const b = W.session({ bg: true });
  const done = await R.restartAll(W.opts());
  assert.deepEqual(done.map(x => x.state), ['done', 'done', 'done'], JSON.stringify(done.map(x => x.note)));
  for (const s of [k, t, b]) assert.ok(s.servers.length === 1 && W.ps.has(s.servers[0]), 'a new server runs');
  assert.equal(W.agents.find(a => a.id === `bg${b.claude}` || a.pid === b.claude).pid, b.claude, 'respawned: a new pid');
  assert.deepEqual(W.prompts, [], 'nothing reached a model');
  assert.ok(W.log.includes(`claude respawn ${W.agents.find(a => a.kind === 'background').id}`));
  const respawnAt = W.log.findIndex(l => l.startsWith('claude respawn'));
  assert.ok(respawnAt > 0);
  ok('restart: kitty and tmux get /mcp reconnect typed and sent, a background session claude respawn; each checked running new code');
}

{
  const W = await world();
  const b = W.session({ bg: true });
  let seenAt = null;
  W.onTick = (t) => { if (t === 9000) W.agent(b).status = 'busy'; if (t === 12_000) W.agent(b).status = 'idle'; };
  const opts = W.opts();
  const run = W.run;
  opts.run = async (cmd, args, o) => { if (cmd === 'claude' && args[0] === 'respawn') seenAt = W.t; return run(cmd, args, o); };
  const [r] = await R.restartAll(opts);
  assert.equal(r.state, 'done', r.note);
  assert.ok(seenAt >= 12_000 + 30_000, `respawned only after 30 s idle on every look (at ${seenAt})`);
  ok('a background session: respawned only once it looked idle on every look for 30 s, and idle right before');
}

{
  const W = await world();
  const s = W.session({ how: 'kitty', status: 'busy' });
  W.onTick = (t) => { if (t >= 12_000) W.agent(s).status = 'idle'; };
  const [r] = await R.restartAll(W.opts());
  assert.equal(r.state, 'done');
  const firstType = W.log.findIndex(l => l.includes(' send-text '));
  assert.ok(firstType > 0 && W.t >= 12_000, 'typed only once it was idle');
  ok('a busy session: waited for, then restarted');
}

{
  const W = await world();
  const s = W.session({ how: 'tmux', text: 'half a sentence\nthe user is writing' });
  const [r] = await R.restartAll(W.opts({ waitMs: 20_000 }));
  assert.equal(r.state, 'skipped');
  assert.match(r.note, /输入框里有没发出去的字/);
  assert.equal(s.box.text, 'half a sentence\nthe user is writing', 'the draft is untouched');
  assert.equal(typedCount(W), 0);
  assert.equal(W.ps.has(s.servers[0]), true);
  for (const text of ['Try "explain this function"', `intro\n${RULE}\n❯ \n${RULE}`, ' ', '\n', '\n\n']) {
    const Wx = await world();
    const sx = Wx.session({ how: 'kitty', text });
    const [rx] = await R.restartAll(Wx.opts({ waitMs: 20_000 }));
    assert.equal(rx.state, 'skipped');
    assert.equal(typedCount(Wx), 0, `not typed into: ${JSON.stringify(text)}`);
    assert.equal(sx.box.text, text);
  }
  ok('a draft in the input box (also one that reads like the hint, holds a box of its own, or is only spaces or empty lines): never typed into');
}

{
  const W = await world();
  const s = W.session({ how: 'kitty' });
  let raced = false;
  W.onType = (x) => { if (!raced) { raced = true; x.box.text = 'x'; W.lastInput = W.t; } };   // the user presses a key just then
  const [r] = await R.restartAll(W.opts());
  assert.equal(r.state, 'skipped');
  assert.match(r.note, /没有按回车，也没删任何字.*留着 \/mcp reconnect chrome-bridge/);
  assert.equal(s.box.text, 'x' + CMD, 'the key and the command are left for the owner');
  assert.ok(!W.log.some(l => l.includes(' send-key ')), 'no key at all: the cursor could be anywhere');
  assert.deepEqual(W.prompts, [], `nothing half-typed was sent: ${JSON.stringify(W.prompts)}`);
  ok('someone types just before the command lands: no Enter, nothing deleted, left to the owner');
}

{
  const W = await world();
  const s = W.session({ how: 'tmux' });
  const typed = W.typed;
  W.typed = (x, text) => { typed(x, text); x.box.text += 'x'; W.lastInput = W.t; W.typed = typed; };   // ...and right after it
  const [r] = await R.restartAll(W.opts());
  assert.equal(r.state, 'skipped');
  assert.match(r.note, /没有按回车，也没删任何字/);
  assert.equal(s.box.text, CMD + 'x', 'the user\'s key is kept');
  assert.ok(!W.log.some(l => /BSpace|Enter/.test(l)), 'no key pressed');
  assert.deepEqual(W.prompts, []);
  const W2 = await world();
  const s2 = W2.session({ how: 'kitty' });
  W2.onType = () => { W2.lastInput = W2.t + 100; };                       // a click somewhere while typing
  const [r2] = await R.restartAll(W2.opts());
  assert.equal(r2.state, 'skipped');
  assert.equal(s2.box.text, CMD);
  assert.ok(!W2.log.some(l => l.includes(' send-key ')), 'no Enter');
  // The last looks slow (a loaded Mac): someone could change the box meanwhile, so no Enter (Codex r2 A2).
  const W3 = await world();
  const s3 = W3.session({ how: 'tmux' });
  W3.onPs = () => { if (s3.box.text === CMD) W3.t += 2000; };
  const [r3] = await R.restartAll(W3.opts());
  assert.equal(r3.state, 'skipped');
  assert.ok(!W3.log.some(l => / send-keys .* Enter$/.test(l)), 'no Enter after a slow last look');
  for (const w of [W2, W3]) assert.deepEqual(w.prompts, []);
  ok('someone types after the command, any input on the Mac while typing, or the last looks slow: no key pressed at all');
}

{
  const W = await world();
  W.session({ how: 'kitty' });
  W.onTick = () => { W.lastInput = W.t; };                                // the owner keeps using the Mac
  W.lastInput = 0;
  const [r] = await R.restartAll(W.opts({ waitMs: 20_000 }));
  assert.equal(r.state, 'skipped');
  assert.match(r.note, /你正在用电脑/);
  const W2 = await world();
  W2.session({ how: 'tmux' });
  W2.tmuxClients = [0];
  W2.onTick = (t) => { W2.tmuxClients = [Math.floor(t / 1000)]; };        // someone attached to the tmux session, typing
  const [r2] = await R.restartAll(W2.opts({ waitMs: 20_000 }));
  assert.equal(r2.state, 'skipped');
  const W3 = await world();
  const s3 = W3.session({ how: 'kitty', suspended: true });               // Ctrl+Z: the shell has the terminal
  const [r3] = await R.restartAll(W3.opts({ waitMs: 20_000 }));
  assert.equal(r3.state, 'skipped');
  assert.match(r3.note, /不在终端前台/);
  const W4 = await world();
  const s4 = W4.session({ how: 'kitty' });
  W4.onAgents = (n) => { if (n === 3) W4.agent(s4).status = 'busy'; };    // starts a turn between the round's look and the action
  const [r4] = await R.restartAll(W4.opts({ waitMs: 20_000 }));
  assert.equal(r4.state, 'skipped');
  const W5 = await world();
  const s5 = W5.session({ how: 'kitty' });
  // Ctrl+Z after the round's ps (while another session was handled): the look right before typing sees it (r2 A3).
  W5.onAgents = (n) => { if (n === 3) Object.assign(W5.ps.get(s5.claude), { stat: 'T', tpgid: 1 }); };
  const [r5] = await R.restartAll(W5.opts({ waitMs: 20_000 }));
  assert.equal(r5.state, 'skipped');
  assert.match(r5.note, /不在终端前台/);
  for (const w of [W, W2, W3, W4, W5]) assert.equal(typedCount(w), 0, 'nothing typed');
  void s3;
  ok('not typed: the Mac in use, a tmux client typing, the session suspended (Ctrl+Z, also just before), the session busy again just before');
}

{
  const W = await world();
  const stale = W.session({ how: 'kitty' });
  // A server that died and left its file; its pid now runs a plain child of another session.
  const host = W.session({ how: 'kitty', current: true });
  W.ps.delete(stale.servers[0]);
  W.proc(stale.servers[0], host.claude, 'sleep 100');
  // Another: the pid now runs another install's mychrome-mcp; a third: this checkout's script, but started later.
  const s2 = W.session({ how: 'kitty' }), s3 = W.session({ how: 'kitty' });
  const otherBin = path.join(W.dir, 'other-bin', 'mychrome-mcp');
  await mkdir(path.dirname(otherBin), { recursive: true });
  await writeFile(otherBin, '');
  W.ps.get(s2.servers[0]).cmd = `node ${otherBin}`;
  W.t += 600_000;
  W.ps.get(s3.servers[0]).start = W.t;
  const { targets } = await R.findTargets({ root: W.root, lockDir: W.lockDir, run: W.run, home: W.home, selfPid: 1, now: () => W.t });
  assert.deepEqual(targets, [], 'a reused pid is not an old server');
  // A process under a session that only names this checkout's script among its arguments: not a server (r8 A2).
  const W7 = await world();
  const cur = W7.session({ how: 'kitty', current: true });
  W7.proc(W7.nextPid++, cur.claude, `node /some/watcher.js --source ${path.join(W7.root, 'src', 'index.js')}`);
  // ...or as a node option's value, or after -e (r9 A2).
  W7.proc(W7.nextPid++, cur.claude, `node --watch-path ${path.join(W7.root, 'src', 'index.js')} /some/watcher.js`);
  W7.proc(W7.nextPid++, cur.claude, `node -e x ${path.join(W7.root, 'src', 'index.js')}`);
  W7.proc(W7.nextPid++, cur.claude, `node --some-new-option ${path.join(W7.root, 'src', 'index.js')}`);
  W7.proc(W7.nextPid++, cur.claude, `node --run=watch ${path.join(W7.root, 'src', 'index.js')}`);
  W7.t += 120_000;
  const again = await R.findTargets({ root: W7.root, lockDir: W7.lockDir, run: W7.run, home: W7.home, selfPid: 1, now: () => W7.t });
  assert.deepEqual(again.targets, [], 'a watcher naming the path is not an old server');
  const S = path.join(W7.root, 'src', 'index.js'), real = realpathSync(S);
  assert.equal(R.scriptOf(`node ${S}`), real);
  assert.equal(R.scriptOf(`/x/bin/node --enable-source-maps --max-old-space-size=4096 ${S} --worker`), real);
  assert.equal(R.scriptOf(`node --import /t/hold.mjs ${S}`), real, 'a valued option is skipped with its value');
  assert.equal(R.scriptOf(`node --watch-path ${S} /w.js`), '/w.js', 'the script after a valued option, not its value');
  assert.equal(R.scriptOf(`node -e x ${S}`), null);
  assert.equal(R.scriptOf(`node --some-new-option ${S}`), null, 'an unknown option: not parsed, not a server');
  // A package script run by node --run, in both forms, and an unknown option written with = (r10 A1).
  assert.equal(R.scriptOf(`node --run=watch ${S}`), null);
  assert.equal(R.scriptOf(`node --run watch ${S}`), null);
  assert.equal(R.scriptOf(`node --some-new=1 ${S}`), null);
  assert.equal(R.scriptOf(`node --import=/t/hold.mjs ${S}`), real, 'a known valued option written with =');
  ok('a dead server\'s presence file whose pid was reused (any process, another install, a server just started), a process naming the path: not a target');
}

{
  const W = await world();
  const s = W.session({ how: 'kitty', knows: false });                    // an older Claude Code: /mcp opens its menu
  const [r] = await R.restartAll(W.opts());
  assert.equal(r.state, 'failed');
  assert.match(r.note, /可能太旧.*按 Esc 关掉/);
  assert.equal(s.box.menu, true, 'no key pressed after sending (the owner closes the menu)');
  assert.equal(W.log.filter(l => l.includes(' send-key ')).length, 1, 'only the Enter');
  assert.deepEqual(W.prompts, []);
  const W2 = await world();
  W2.session({ how: 'tmux', broken: true });                              // the old server stops, no new one starts
  const [r2] = await R.restartAll(W2.opts());
  assert.equal(r2.state, 'failed');
  assert.match(r2.note, /新的没起来/);
  ok('not confirmed: the reconnect not understood or no new server, reported as failed, no further keys');
}

{
  const W = await world();
  const s = W.session({ how: 'kitty', windowPid: 4242 });                  // window id now belongs to another shell
  W.proc(4242, 1, '-zsh');
  const W2 = await world();
  W2.session({ bg: true });
  W2.respawnFails = true;
  const W3 = await world();
  W3.session({ how: 'kitty' });
  W3.agentsBroken = true;
  const W4 = await world();
  W4.session({ how: 'kitty' });
  W4.kittyKey = 'another-instance';                                       // kitty refuses the request
  const [r] = await R.restartAll(W.opts());
  const [r2] = await R.restartAll(W2.opts());
  const [r3] = await R.restartAll(W3.opts());
  assert.equal(r.state, 'skipped');
  assert.match(r.note, /找不到它所在的窗口/);
  assert.equal(typedCount(W), 0, 'nothing typed into a window that is not the session');
  assert.equal(W.ps.has(s.servers[0]), true);
  assert.equal(r2.state, 'failed');
  assert.match(r2.note, /claude attach/);
  assert.equal(r3.state, 'skipped');
  assert.match(r3.note, /读不到 claude agents/);
  assert.equal(typedCount(W3), 0, 'no idle check: nothing typed');
  const [r4] = await R.restartAll(W4.opts());
  assert.equal(r4.state, 'skipped');
  assert.match(r4.note, /kitty 不接受远程控制/);
  assert.equal(typedCount(W4), 0);
  ok('a window that is no longer the session, kitty refusing, respawn failing, claude agents unreadable: nothing typed, reported');
}

{
  const W = await world();
  const s = W.session({ how: 'kitty' });
  W.session({ how: 'kitty', current: true });
  const lines = [];
  const code = await R.runRestartCli(['--root', W.root, '--wait', '1'], { lockDir: W.lockDir, out: (x) => lines.push(x), ...W.opts() });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^tab \d+（kitty 标签页）：完成：已重启，用上新版了$/);
  const st = JSON.parse(await readFile(path.join(W.dir, 'lock', 'restart-all.json'), 'utf8'));
  assert.equal(st.finished, true);
  assert.deepEqual(st.items.map(i => [i.client, i.state]), [[s.claude, 'done']]);
  const runLock = path.join(W.dir, 'lock', 'restart-all.lock');
  await assert.rejects(stat(runLock), 'the lock is let go at the end');
  // A run already going (its lock held by a live pid): a second one only points at it, whatever its --wait.
  await mkdir(runLock);
  await writeFile(path.join(runLock, 'pid'), String(process.ppid));
  const again = [];
  assert.equal(await R.runRestartCli(['--root', W.root, '--wait', '0.1'], { lockDir: W.lockDir, out: (x) => again.push(x), ...W.opts() }), 0);
  assert.match(again[0], new RegExp(`已经在重启了（pid ${process.ppid}）`));
  assert.ok((await stat(runLock)).isDirectory(), 'another run\'s lock is left alone');
  // Its owner gone: taken over.
  await writeFile(path.join(runLock, 'pid'), '999999');
  const W5 = await world();
  W5.session({ how: 'kitty' });
  const over = [];
  assert.equal(await R.runRestartCli(['--root', W5.root], { lockDir: W.lockDir, out: (x) => over.push(x), ...W5.opts({ root: W5.root }) }), 0);
  assert.match(over[0], /完成/);
  // Two at once (the panel clicked twice): one runs, the other points at it.
  const W6 = await world();
  W6.session({ how: 'kitty' });
  const both = [[], []];
  await Promise.all(both.map(o => R.runRestartCli(['--root', W6.root], { lockDir: W6.lockDir, out: (x) => o.push(x), ...W6.opts() })));
  assert.deepEqual(both.map(o => /已经在重启了/.test(o[0])).sort(), [false, true]);
  assert.equal(W6.log.filter(l => l.includes(' send-text ')).length, 1, 'typed once');
  const dry = [];
  W.session({ how: 'tmux' });
  await R.runRestartCli(['--root', W.root, '--dry-run'], { lockDir: W.lockDir, out: (x) => dry.push(x), ...W.opts() });
  assert.equal(dry.length, 1);
  assert.match(dry[0], /（tmux）：空下来后替你输入 \/mcp reconnect chrome-bridge$/);
  assert.equal(typedCount(W), 1, 'the dry run typed nothing');
  ok('restart-all command: progress file for the panel, one run at a time, --dry-run lists without touching anything');
}

{
  const W = await world();
  const s = W.session({ how: 'tmux' });
  W.panes.get(`%${s.claude}`).sync = 1;                                   // synchronize-panes on in that window
  const [r] = await R.restartAll(W.opts());
  assert.equal(r.state, 'skipped');
  assert.match(r.note, /synchronize-panes/);
  assert.equal(typedCount(W), 0);
  // A background session out of sight for a while (agents without it): its 30 s start over (r3 B1).
  const W2 = await world();
  const b = W2.session({ bg: true });
  let respawnAt = null;
  const hidden = (t) => t >= 6000 && t < 27_000;
  const run2 = W2.run;
  const opts = W2.opts();
  opts.run = async (cmd, args, o) => {
    if (cmd === 'claude' && args[0] === 'respawn') respawnAt = W2.t;
    if (cmd === 'claude' && args[0] === 'agents' && hidden(W2.t)) return { code: 0, out: JSON.stringify(W2.agents.filter(a => a !== W2.agent(b))) };
    return run2(cmd, args, o);
  };
  const [r2] = await R.restartAll(opts);
  assert.equal(r2.state, 'done', r2.note);
  assert.ok(respawnAt >= 27_000 + 30_000, `30 s counted again from when it came back (respawned at ${respawnAt})`);
  // Sync turned on while the command was being typed (a remote client): no Enter (r4 A1).
  const W3 = await world();
  const s3 = W3.session({ how: 'tmux' });
  const typed3 = W3.typed;
  W3.typed = (x, text) => { typed3(x, text); W3.panes.get(`%${s3.claude}`).sync = 1; };
  const [r3] = await R.restartAll(W3.opts({ waitMs: 20_000 }));
  assert.equal(r3.state, 'skipped');
  assert.ok(!W3.log.some(l => / send-keys .* Enter$/.test(l)), 'no Enter');
  // Sync turned on while claude agents is asked, just before typing: nothing typed at all (r5 A1).
  const W5 = await world();
  const s5 = W5.session({ how: 'tmux' });
  W5.onAgents = (n) => { if (n === 3) W5.panes.get(`%${s5.claude}`).sync = 1; };
  const [r5] = await R.restartAll(W5.opts({ waitMs: 20_000 }));
  assert.equal(r5.state, 'skipped');
  assert.equal(typedCount(W5), 0, 'nothing typed');
  // claude agents slow (8 s) and the owner starts a draft meanwhile: the looks after it see the draft, nothing typed (r6 A1).
  const W6 = await world();
  const s6 = W6.session({ how: 'kitty' });
  W6.onAgents = (n) => { if (n === 3) { W6.t += 8000; s6.box.text = 'draft written during agents lookup'; W6.lastInput = W6.t; } };
  const [r6] = await R.restartAll(W6.opts({ waitMs: 20_000 }));
  assert.equal(r6.state, 'skipped');
  assert.equal(typedCount(W6), 0, 'nothing typed');
  assert.equal(s6.box.text, 'draft written during agents lookup');
  // Reconnected by hand while claude agents was asked (8 s): already on new code, nothing typed, not reconnected again;
  // a background session restarted meanwhile: no respawn (Codex r11 A1).
  for (const how of ['kitty', 'tmux']) {
    const Wm = await world();
    const sm = Wm.session({ how });
    Wm.onAgents = (n) => { if (n === 3) { Wm.t += 8000; Wm.reconnect(sm); } };
    const fresh = () => sm.servers[0];
    const [rm] = await R.restartAll(Wm.opts({ waitMs: 20_000 }));
    assert.equal(rm.state, 'done', rm.note);
    assert.equal(typedCount(Wm), 0, `${how}: nothing typed`);
    assert.ok(Wm.ps.has(fresh()), `${how}: the server started by hand still runs`);
  }
  const Wb = await world();
  const sb = Wb.session({ bg: true });
  // Restarted by other means right after the round's ps, once its 30 s of idleness are up.
  let restartedBy = false;
  Wb.onAgents = () => { if (Wb.t >= 30_000 && !restartedBy) { restartedBy = true; Wb.reconnect(sb); } };
  const [rb] = await R.restartAll(Wb.opts());
  assert.equal(rb.state, 'done', rb.note);
  assert.ok(!Wb.log.some(l => l.startsWith('claude respawn')), 'no respawn of a session already on new code');
  // The last idle check slow (8 s) and the session busy by its end: no respawn; its 30 s start over (r12 A1).
  const Wi = await world();
  const si = Wi.session({ bg: true });
  let slowOnce = false, afterThirty = 0;
  const runI = Wi.run;
  const optsI = Wi.opts({ waitMs: 50_000 });
  optsI.run = async (cmd, args, o) => {
    const r = await runI(cmd, args, o);
    // After 30 s each round asks twice: the round's list, then the last idle check; slow down the second one, which
    // ends with the session busy.
    if (cmd === 'claude' && args[0] === 'agents' && Wi.t >= 30_000 && !slowOnce && ++afterThirty === 2) { slowOnce = true; Wi.t += 8000; Wi.agent(si).status = 'busy'; setTimeout(() => {}, 0); }
    return r;
  };
  const respawnsAt = [];
  const runI2 = optsI.run;
  optsI.run = async (cmd, args, o) => { if (cmd === 'claude' && args[0] === 'respawn') respawnsAt.push(Wi.t); return runI2(cmd, args, o); };
  const [ri] = await R.restartAll(optsI);
  assert.deepEqual(respawnsAt, [], `no respawn after a slow idle check that ended busy (${respawnsAt})`);
  void si; void ri;
  // A tmux key in the same second as the check: whole seconds count against it.
  const W4 = await world();
  const s4 = W4.session({ how: 'tmux' });
  W4.t = 10_900;
  const typed4 = W4.typed;
  W4.typed = (x, text) => { typed4(x, text); W4.tmuxClients = [Math.floor(W4.t / 1000)]; };   // a key at 10.9 s → "10"
  const [r4] = await R.restartAll(W4.opts({ waitMs: 20_000, typeSettleMs: 600 }));
  assert.equal(r4.state, 'skipped', r4.note);
  assert.equal(s4.box.text, CMD, 'no Enter');
  ok('tmux panes in sync (also turned on while typing): not sent; a tmux key in the same second counts; a background session out of sight: its idle time starts over');
}

{
  const dir = path.join(tmp, 'locks', 'restart-all.lock'), claim = `${dir}.takeover`;
  const take = R.__takeLockForTests;
  const owner = async () => Number(await readFile(path.join(dir, 'pid'), 'utf8'));
  assert.equal(take(dir), null, 'free: taken');
  assert.equal(await owner(), process.pid);
  assert.equal(take(dir), process.pid, 'held by a live pid');
  await writeFile(path.join(dir, 'pid'), '999999');
  // Another run is taking over the dead owner's lock right now: this one backs off and leaves both alone (r2 A4).
  await mkdir(claim);
  assert.equal(take(dir), -1);
  assert.equal(await owner(), 999999);
  // However old, a claim is not removed: its maker may only be slow (r3 B2). Its maker dead: reported (-2), kept.
  await utimes(claim, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(take(dir), -2, 'old and no pid: reported, not taken');
  await writeFile(path.join(claim, 'pid'), String(process.ppid));
  assert.equal(take(dir), -1, 'a live maker: wait for it');
  await writeFile(path.join(claim, 'pid'), '999998');
  assert.equal(take(dir), -2, 'a dead maker: reported');
  const bareClaim = path.join(tmp, 'locks', 'c.lock');
  await mkdir(bareClaim);
  await writeFile(path.join(bareClaim, 'pid'), '999999');
  await mkdir(`${bareClaim}.takeover`);
  assert.equal(take(bareClaim), -1, 'a claim with no pid yet: being made');
  await utimes(`${bareClaim}.takeover`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(take(bareClaim), -2, 'an old claim with no pid: reported (r5 B1)');
  assert.ok((await stat(claim)).isDirectory(), 'never removed by another run');
  assert.equal(await owner(), 999999);
  const lines = [];
  const lockDir2 = path.join(tmp, 'locks', 'input.lock');
  assert.equal(await R.runRestartCli([], { lockDir: lockDir2, out: (x) => lines.push(x) }), 1);
  assert.match(lines[0], /上次的重启没收拾干净.*restart-all\.lock\.takeover/);
  assert.match(JSON.parse(await readFile(path.join(tmp, 'locks', 'restart-all.json'), 'utf8')).error, /没收拾干净/);
  await import('node:fs/promises').then(f => f.rm(claim, { recursive: true }));
  assert.equal(take(dir), null, 'dead owner: taken over');
  // A lock left without a pid: being made (young) or left by a run that died right then (old): never taken (r4 B1).
  const bare = path.join(tmp, 'locks', 'bare.lock');
  await mkdir(bare);
  assert.equal(take(bare), -1);
  await utimes(bare, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(take(bare), -3);
  await assert.rejects(stat(path.join(bare, 'pid')), 'left alone');
  assert.equal(await owner(), process.pid);
  await assert.rejects(stat(claim), 'the claim is let go');
  ok('run lock: free, held, a takeover claimed by another run (never removed by age), a claim left by a dead run reported, a dead owner taken over');
}

console.log(`restart tests passed (${passed})`);
