#!/usr/bin/env node
/** One App-created conversation. Existing MCP workers and external clients are untouched. */
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGuiIPC } from './gui-ipc.js';
import { removePresence, sourceFingerprint, writePresence } from './settings.js';
import { installedClient, modelCatalog, normalizeSessionRequest, providerModule, selectSessionModel, sessionBase, sessionError } from './session-options.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const sourceHash = sourceFingerprint(root);
const base = process.env.MYCHROME_SESSION_BASE || sessionBase();
const lock = path.join(base, 'input.lock');
const bindingId = randomUUID();
let adapter, transport, tick, started = false, closed = false, currentRequest;
const born = Date.now();

function receipt(record, payload) {
  const temporary = `${record.file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ hash: record.hash, at: Date.now(), ...payload }), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, record.file);
}
function snapshot() {
  const state = adapter?.snapshot() || {};
  return { ...state, bindingId, resetRevision: 0, managedSession: true,
    title: state.title || `${currentRequest?.provider || 'AI'} 新对话` };
}
function publish() {
  if (!transport || !adapter || closed) return;
  const state = snapshot();
  writePresence(lock, {
    version, srcHash: sourceHash, startedAt: born, sessionGeneration: bindingId,
    who: `${currentRequest.provider} · 新对话`, color: currentRequest.provider === 'Codex' ? 1 : 2,
    node: process.execPath, script: fileURLToPath(import.meta.url), root, envLocked: {}, busy: null,
    managedSession: true, cwd: currentRequest.cwd, model: state.model ?? null, effort: state.effort ?? null,
    guiInstance: transport.instance, conversationThread: state.threadId,
    conversationBinding: bindingId, conversationProvider: currentRequest.provider,
    conversationStatus: state.status || 'unavailable', conversationPending: state.pending?.length || 0,
    conversationRequestKey: JSON.stringify((state.pending || []).map(p => [typeof p.requestId, p.requestId])),
    // Only explicit session metadata belongs in presence, never message text.
    conversationTitle: `${currentRequest.provider} 新对话`,
  });
  try { chmodSync(path.join(base, 'servers', `${process.pid}.json`), 0o600); } catch {}
}
async function shutdown() {
  if (closed) return;
  closed = true; clearInterval(tick);
  transport?.close();
  try { await adapter?.close(); } catch {}
  removePresence(lock);
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.on('disconnect', () => {}); // Closing the App/client must not kill ongoing work.

process.once('message', async message => {
  if (started) return;
  started = true;
  const record = message?.receipt;
  let validatedReceipt = false;
  try {
    const request = normalizeSessionRequest(message?.request);
    if (request.op !== 'create' || !record?.file || !record?.hash) throw sessionError('invalid_request');
    const expected = path.join(base, 'session-launches', `${request.nonce}.json`);
    if (record.file !== expected) throw sessionError('invalid_request');
    validatedReceipt = true;
    const executable = installedClient(request.provider);
    const catalog = await modelCatalog(request, { executable });
    currentRequest = selectSessionModel(request, catalog);
    const module = await providerModule(request.provider);
    const create = request.provider === 'Codex' ? module.createCodexSession : module.createClaudeSession;
    adapter = await create({ ...currentRequest, executable, onChange: publish });
    const state = adapter.snapshot();
    if (!state.threadId || state.status !== 'connected') throw sessionError('launch_failed');
    transport = await startGuiIPC({ base, snapshot,
      send: async payload => {
        if (payload?.bindingId !== bindingId || payload?.threadId !== adapter.snapshot().threadId) {
          throw sessionError('conversation_changed');
        }
        let result;
        if (payload.requestId != null) result = await adapter.answer({ requestId: payload.requestId, answers: payload.answers });
        else {
          if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 24_000 || Buffer.byteLength(payload.text) > 96 * 1024) {
            throw sessionError('invalid_prompt');
          }
          result = await adapter.send(payload.text);
        }
        publish();
        return result?.delivery === 'accepted' ? { ...result, status: 'accepted' }
          : { ...result, status: 'unknown', delivery: 'unknown' };
      },
      interrupt: async () => { await adapter.interrupt(); publish(); return { status: 'accepted' }; },
    });
    publish();
    tick = setInterval(publish, 5000);
    const result = { ok: true, pid: process.pid, instance: transport.instance, threadId: state.threadId, bindingId };
    receipt(record, { status: 'ready', result });
    if (process.connected) process.send({ type: 'ready', result });
    // The App retains the initial prompt as a conversation-bound draft, then
    // sends it through the same nonce/delivery ledger as subsequent messages.
    // Creating a session itself must never silently send or lose a message.
    currentRequest.prompt = '';
  } catch (error) {
    const code = /^[a-z_]{1,80}$/.test(error?.code) ? error.code : 'launch_failed';
    if (validatedReceipt) {
      try { receipt(record, { status: 'failed', code }); } catch {}
    }
    if (process.connected) process.send({ type: 'failed', code });
    await shutdown();
  }
});
// A parent that never supplies a request must not leave an orphan worker.
setTimeout(() => { if (!started) shutdown(); }, 10_000).unref();
