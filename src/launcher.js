/**
 * Updates without restarting the session (hot swap).
 *
 * The process a client starts (`node src/index.js`, stdio) becomes this small relay for the whole
 * session; MyChrome itself runs behind it as a worker (the same file, CHROME_BRIDGE_WORKER=1, with an
 * IPC channel). When src/*.js change on disk (an update), the worker is replaced at a quiet moment:
 *   1. the new code is loaded once on its own (`--probe`): a broken update leaves the old worker serving;
 *   2. the worker is asked to hand over (IPC `handover?`): it says no while it works or a job is on, else
 *      it clears its menu-bar card and leaves WITHOUT closing the session's tabs;
 *   3. a new worker starts, gets the client's `initialize` again (its answer stays here), then the
 *      messages that came meanwhile; the client hears `notifications/tools/list_changed`.
 * The client keeps its connection throughout (Claude Code does not restart a stdio server that exits:
 * the session would lose MyChrome until /mcp → Reconnect, measured 2026-10-19).
 *
 * Tabs the agent opens are registered to THIS process (CHROME_BRIDGE_LAUNCHER_PID → src/tabs.js
 * OWNER_PID), which lives as long as the session, so they outlive a swap and close when the session ends.
 * A worker that dies on its own is started again; requests it had are answered with an error to retry.
 *
 * Kept small, with no imports from the rest of src/: this file is loaded once per session and is the one
 * part an update does not reach (a change here needs the session restarted).
 * CHROME_BRIDGE_HOTSWAP=0: no relay (the server runs in this process, as before).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const POLL_MS = num(process.env.CHROME_BRIDGE_SWAP_POLL_MS, 10_000);     // how often src/ is looked at
const QUIET_MS = num(process.env.CHROME_BRIDGE_SWAP_QUIET_MS, 10_000);   // no traffic this long before a swap
const PROBE_MS = 20_000, ASK_MS = 5_000, INIT_MS = 20_000, EXIT_MS = 5_000;
const CRASHES_MAX = 3, CRASH_WINDOW_MS = 60_000;

/** src/*.js as src/settings.js sourceFingerprint hashes them (the panel's 「需要重启」 compares the same). */
export function srcFingerprint(srcDir) {
  const h = createHash('sha256');
  for (const n of readdirSync(srcDir).filter(n => n.endsWith('.js')).sort()) {
    h.update(n); h.update('\0'); h.update(readFileSync(path.join(srcDir, n))); h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}
/** Cheap look first: names, sizes and times. */
function srcStamp(srcDir) {
  return readdirSync(srcDir).filter(n => n.endsWith('.js')).sort()
    .map(n => { const s = statSync(path.join(srcDir, n)); return `${n}:${s.size}:${s.mtimeMs}`; }).join('|');
}

/** Newline-delimited JSON-RPC (MCP stdio): calls `fn(line)` per complete line. */
function lineReader(fn) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) fn(line);
    }
  };
}
const parse = (line) => { try { const m = JSON.parse(line); return m && typeof m === 'object' ? m : null; } catch { return null; } };
const idKey = (id) => JSON.stringify(id);

export async function runLauncher({ script, srcDir }) {
  const log = (s) => { try { process.stderr.write(`mychrome-mcp launcher: ${s}\n`); } catch {} };
  const baseEnv = { ...process.env, CHROME_BRIDGE_WORKER: '1', CHROME_BRIDGE_LAUNCHER_PID: String(process.pid),
    CHROME_BRIDGE_CLIENT_PID: String(process.ppid) };
  delete baseEnv.CHROME_BRIDGE_CARRY;
  let worker = null;            // the current generation: { child, pid, hash, stamp, exited, onExit, replies, recovered, handingOver }
  let state = 'starting';       // running | swapping | starting | stopping
  const inflight = new Map();   // client requests the worker has and has not answered: id → since
  let queue = [];               // client messages held while no worker takes them: { line, key }
  let initReq = null, initialized = false;
  let lastTraffic = Date.now();
  let pending = null, badHash = null, probedOk = null, looking = false, seq = 0;
  let carryOver = null;         // what the worker before handed over, kept until a new one has started with it
  const crashes = [];
  const waiters = new Map();    // internal request id → resolve

  const toClient = (line) => {
    try { process.stdout.write(line + '\n'); } catch { process.exit(0); }
  };
  process.stdout.on('error', () => process.exit(0));

  /**
   * A worker; with `carryOver` set (what the one before handed over) it asks for that over the IPC channel
   * and takes it before it answers anything.
   */
  function startWorker() {
    let hash = null, stamp = null;
    try { stamp = srcStamp(srcDir); hash = srcFingerprint(srcDir); } catch {}
    const carry = carryOver;
    const env = carry ? { ...baseEnv, CHROME_BRIDGE_CARRY: 'ipc' } : baseEnv;
    const child = spawn(process.execPath, [...process.execArgv, script, '--worker'], { env, stdio: ['pipe', 'pipe', 'inherit', 'ipc'] });
    const w = { child, pid: child.pid, hash, stamp, exited: false, onExit: [], replies: [], recovered: false, handingOver: false };
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', lineReader((line) => fromWorker(w, line)));
    child.on('message', (m) => {
      if (m && m.t === 'handover') {
        const r = w.replies.shift();
        if (r) r(m);
        // A yes after the wait gave up (it was slow): it goes now, and what it handed over still goes on
        // to the next worker, which its end starts (Codex r15 r3 A2).
        else if (m.ok && w === worker) carryOver = m.carry || null;
      }
      else if (m && m.t === 'carry?') { try { child.send({ t: 'carry', carry }); } catch {} }   // it asks once it listens
    });
    let ended = false;
    const finish = (code, sig) => {
      if (ended) return;
      ended = true;
      w.exited = true;
      // What it wrote before it went still reaches the client first (a request it answered is not answered twice).
      new Promise((res) => {
        if (!child.stdout || child.stdout.readableEnded || child.stdout.destroyed) return res();
        child.stdout.once('end', res); child.stdout.once('close', res);
        setTimeout(res, 1000).unref();
      }).then(() => {
        for (const f of w.onExit.splice(0)) f();
        onWorkerExit(w, code, sig);
      });
    };
    child.on('exit', (code, sig) => finish(code, sig));
    // Not started at all (EAGAIN…): as if it had ended.
    child.on('error', (e) => { log(`worker failed: ${e.message}`); finish(null, e.code || 'error'); });
    return w;
  }

  function fromWorker(w, line) {
    if (w !== worker || w.recovered) return;    // a worker given up on: its requests were answered already
    const m = parse(line);
    if (m && m.id != null && !('method' in m)) {
      const k = idKey(m.id);
      if (waiters.has(k)) { const r = waiters.get(k); waiters.delete(k); r(m); return; }
      inflight.delete(k);
    }
    lastTraffic = Date.now();
    toClient(line);
  }

  function toWorker(line, key) {
    if (state !== 'running' || !worker || worker.exited) { queue.push({ line, key }); return; }
    if (key) inflight.set(key, Date.now());
    worker.child.stdin.write(line + '\n');
  }

  function flush() {
    const q = queue;
    queue = [];
    for (const { line, key } of q) toWorker(line, key);
  }

  /** The new worker gets the client's initialize again; its answer stays here. null: it did not come up. */
  async function initWorker(w) {
    if (!initReq) return true;
    const id = `__mychrome_swap_${++seq}`, k = idKey(id);
    const got = new Promise((res) => {
      waiters.set(k, res);
      w.onExit.push(() => res(null));
      setTimeout(() => res(null), INIT_MS).unref();
    });
    w.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: initReq.params }) + '\n');
    const r = await got;
    waiters.delete(k);
    if (!r || r.error || w.exited) return false;
    if (initialized) w.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return true;
  }

  /**
   * A worker that ended (or did not come up) when nobody asked it to: once per worker. What it had is
   * answered with an error to retry, and another starts (more than CRASHES_MAX in a minute: this gives up).
   */
  function recover(w, why) {
    if (w !== worker || w.recovered || state === 'stopping') return;
    w.recovered = true;
    if (!w.exited) { try { w.child.kill('SIGKILL'); } catch {} }
    for (const k of inflight.keys()) {
      toClient(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(k), error: { code: -32603,
        message: 'MyChrome 的服务进程意外退出，已自动重新启动；请再调用一次。' } }));
    }
    inflight.clear();
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
    log(`worker ${w.pid} ended (${why})`);
    if (crashes.length > CRASHES_MAX) { log('worker keeps ending: giving up'); process.exit(1); }
    state = 'starting';
    setTimeout(async () => {
      if (state === 'stopping') return;
      const n = worker = startWorker();
      if (!(await initWorker(n))) { recover(n, 'did not start'); return; }
      if (n !== worker || state === 'stopping') return;
      carryOver = null;
      state = 'running';
      flush();
    }, 500);
  }

  function onWorkerExit(w, code, sig) {
    if (w !== worker) return;
    if (state === 'stopping') { process.exit(0); return; }
    if (state === 'swapping' || w.handingOver) return;    // the swap in progress looks after it
    recover(w, sig || `exit ${code}`);
  }

  /** Load the new code once on its own; nothing starts (no tabs, no menu bar, no lock). */
  function probe() {
    return new Promise((res) => {
      let out = '', done = false;
      const p = spawn(process.execPath, [...process.execArgv, script, '--probe'], { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      const end = (ok, why) => { if (done) return; done = true; clearTimeout(t); try { p.kill('SIGKILL'); } catch {} res({ ok, why }); };
      const t = setTimeout(() => end(false, 'timeout'), PROBE_MS);
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { out += d; });
      p.on('error', (e) => end(false, e.message));
      p.on('exit', (code) => end(code === 0 && out.includes('mychrome-probe-ok'), out.trim().split('\n').slice(-2).join(' | ')));
    });
  }

  const quiet = () => inflight.size === 0 && queue.length === 0 && Date.now() - lastTraffic >= QUIET_MS;

  /** Asked to make way: its answer ({ok, why, carry}), or no (it ended meanwhile, or did not answer in time). */
  function askHandover(w) {
    return new Promise((res) => {
      let done = false;
      const fin = (m) => { if (!done) { done = true; res(m); } };
      w.replies.push(fin);
      w.onExit.push(() => fin({ ok: false, why: 'ended' }));
      setTimeout(() => fin({ ok: false, why: 'no answer' }), ASK_MS).unref();
      try { w.child.send({ t: 'handover?' }); } catch { fin({ ok: false, why: 'no channel' }); }
    });
  }

  async function maybeSwap() {
    if (state !== 'running' || !worker || worker.exited) return;
    let stamp, hash;
    try {
      stamp = srcStamp(srcDir);
      if (stamp === worker.stamp) return;
      hash = srcFingerprint(srcDir);
    } catch { return; }
    if (hash === worker.hash) { worker.stamp = stamp; return; }
    if (hash === badHash) return;
    // The same new code on two looks in a row: not halfway through a checkout or a merge.
    if (!pending || pending.hash !== hash) { pending = { hash }; return; }
    if (!quiet()) return;
    if (probedOk !== hash) {
      const pr = await probe();
      if (!pr.ok) { badHash = hash; log(`new code does not load, staying on ${worker.hash}: ${pr.why}`); return; }
      probedOk = hash;
    }
    if (state !== 'running' || !quiet()) return;
    state = 'swapping';
    const old = worker;
    const answer = await askHandover(old);
    old.replies.length = 0;
    if (state === 'stopping') return;    // the session ended meanwhile: that stands
    if (!answer.ok) {
      state = 'running';
      if (old.exited) recover(old, `ended while asked to hand over`);
      else flush();
      return;
    }
    old.handingOver = true;
    if (!old.exited) {
      await new Promise((res) => { old.onExit.push(res); setTimeout(res, EXIT_MS).unref(); });
      if (!old.exited) { try { old.child.kill('SIGKILL'); } catch {} }
    }
    if (state === 'stopping') return;
    carryOver = answer.carry || null;
    const n = worker = startWorker();
    pending = null;
    if (!(await initWorker(n))) { recover(n, 'did not start'); return; }
    if (n !== worker || state === 'stopping') return;
    carryOver = null;
    state = 'running';
    log(`updated: ${old.hash} → ${n.hash}, worker ${old.pid} → ${n.pid}`);
    flush();
    if (initReq) toClient(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  }

  // The session ends: the worker ends it (closing the session's tabs) and this process goes with it.
  let ending = false;
  const end = (wait) => {
    if (ending) return;
    ending = true;
    state = 'stopping';
    try { worker && worker.child.stdin.end(); } catch {}
    if (!worker || worker.exited) process.exit(0);
    setTimeout(() => process.exit(0), wait).unref();
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', lineReader((line) => {
    const m = parse(line);
    let key = null;
    if (m && typeof m.method === 'string') {
      if (m.method === 'initialize' && m.id != null) initReq = m;
      if (m.method === 'notifications/initialized') initialized = true;
      if (m.id != null) key = idKey(m.id);
      // A cancelled request gets no answer (the SDK drops it): not under way any more; one still held never goes.
      if (m.method === 'notifications/cancelled' && m.params && m.params.requestId != null) {
        const k = idKey(m.params.requestId);
        inflight.delete(k);
        const held = queue.findIndex(q => q.key === k);
        if (held >= 0) { queue.splice(held, 1); lastTraffic = Date.now(); return; }
      }
    }
    lastTraffic = Date.now();
    toWorker(line, key);
  }));
  process.stdin.on('end', () => end(8000));
  process.stdin.on('close', () => end(8000));
  // A client stopping its server sends SIGINT, then SIGTERM, then SIGKILL within half a second:
  // the worker, told by its stdin closing, finishes on its own.
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => end(100));

  worker = startWorker();
  state = 'running';
  setInterval(() => {
    if (looking) return;
    looking = true;
    maybeSwap().catch((e) => {
      log(`swap failed: ${e.message}`);
      if (state === 'swapping') { state = 'running'; if (worker.exited) recover(worker, 'swap failed'); else flush(); }
    }).finally(() => { looking = false; });
  }, POLL_MS);
  await new Promise(() => {});
}
