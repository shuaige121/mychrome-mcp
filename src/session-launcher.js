#!/usr/bin/env node
/** Native App entry point. Prompts arrive on stdin/IPC, never argv or receipt files. */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelCatalog, normalizeSessionRequest, sessionBase, sessionError } from './session-options.js';
import { requestGui } from './gui-ipc.js';

const worker = fileURLToPath(new URL('./session-worker.js', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw sessionError('unsafe_session_path');
  chmodSync(directory, 0o700);
}
function writeReceipt(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}
function readReceipt(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) {
    throw sessionError('unsafe_session_path');
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
const fingerprint = request => createHash('sha256').update(JSON.stringify(request)).digest('hex');

export async function launchManagedSession(request, {
  base = sessionBase(), spawnWorker = fork, timeoutMs = 40_000, verifySession = requestGui,
} = {}) {
  const directory = path.join(base, 'session-launches');
  privateDirectory(directory);
  const file = path.join(directory, `${request.nonce}.json`);
  const hash = fingerprint(request);
  let reservation;
  try {
    reservation = { hash, status: 'starting', ownerPid: process.pid, at: Date.now() };
    writeFileSync(file, JSON.stringify(reservation), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readReceipt(file);
    if (previous.hash !== hash) throw sessionError('nonce_conflict');
    if (previous.status === 'ready') {
      if (!alive(previous.result?.pid)) throw sessionError('session_ended');
      let observed;
      try { observed = await verifySession({ base, pid: previous.result.pid,
        instance: previous.result.instance, op: 'snapshot', timeoutMs: 3000 }); }
      catch { throw sessionError('launch_pending', 'unknown'); }
      if (observed?.snapshot?.bindingId !== previous.result.bindingId
          || observed?.snapshot?.threadId !== previous.result.threadId) throw sessionError('session_ended');
      return previous.result;
    }
    if (previous.status === 'failed') throw sessionError(previous.code || 'launch_failed');
    // An uncertain result must never start a second inference process.
    throw sessionError('launch_pending', 'unknown');
  }
  return new Promise((resolve, reject) => {
    let child, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.connected) child.disconnect();
      child?.unref();
      if (error) reject(error); else resolve(result);
    };
    const failed = code => {
      try { writeReceipt(file, { ...reservation, status: 'failed', code }); }
      catch { /* A filesystem failure cannot turn a failed launch into success. */ }
      finish(sessionError(code));
    };
    const timer = setTimeout(() => finish(sessionError('launch_pending', 'unknown')), timeoutMs);
    timer.unref?.();
    try {
      child = spawnWorker(worker, [], { detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, MYCHROME_SESSION_BASE: base } });
      child.once('error', () => {
        if (!settled) failed('launch_failed');
      });
      child.once('exit', () => {
        if (settled) return;
        let latest;
        try { latest = readReceipt(file); } catch {}
        // A receipt is not liveness evidence after its owning worker exited.
        failed(latest?.status === 'ready' ? 'session_ended' : latest?.code || 'launch_failed');
      });
      child.on('message', message => {
        if (message?.type === 'ready') finish(null, message.result);
        else if (message?.type === 'failed') finish(sessionError(message.code || 'launch_failed'));
      });
      child.send({ request, receipt: { file, hash } });
    } catch {
      failed('launch_failed');
    }
  });
}

export async function handleSessionRequest(raw, options = {}) {
  const request = normalizeSessionRequest(raw);
  if (request.op === 'catalog') {
    const catalog = await (options.catalog || modelCatalog)(request);
    return { ok: true, ...catalog, provider: request.provider };
  }
  return launchManagedSession(request, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const part of process.stdin) {
      input += part.toString('utf8');
      if (Buffer.byteLength(input) > 128 * 1024) throw sessionError('too_large');
    }
    process.stdout.write(JSON.stringify(await handleSessionRequest(JSON.parse(input))) + '\n');
  } catch (error) {
    const code = /^[a-z_]{1,80}$/.test(error?.code) ? error.code : 'launch_failed';
    process.stdout.write(JSON.stringify({ ok: false, code, delivery: error?.delivery || 'not_sent' }) + '\n');
    process.exitCode = 1;
  }
}
