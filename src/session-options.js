import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sessionError(code, delivery = 'not_sent') {
  return Object.assign(new Error(code), { code, delivery });
}

export function sessionBase(env = process.env) {
  return env.CHROME_BRIDGE_LOCK ? path.dirname(env.CHROME_BRIDGE_LOCK)
    : path.join(os.homedir(), 'Library/Caches/chrome-bridge-mcp');
}

export function installedClient(provider, env = process.env) {
  const name = provider === 'Codex' ? 'codex' : provider === 'Claude' ? 'claude' : null;
  if (!name) throw sessionError('invalid_provider');
  const directories = [...new Set([
    ...(env.PATH || '').split(path.delimiter).filter(p => path.isAbsolute(p)),
    path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
  ])];
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {}
  }
  throw sessionError('client_missing');
}

export function normalizeSessionRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw sessionError('invalid_request');
  if (!['Codex', 'Claude'].includes(raw.provider)) throw sessionError('invalid_provider');
  if (!['catalog', 'create'].includes(raw.op)) throw sessionError('invalid_request');
  let cwd;
  try {
    const requested = raw.cwd || os.homedir();
    if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0')) throw new Error();
    cwd = realpathSync(requested);
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch { throw sessionError('invalid_directory'); }
  const result = { op: raw.op, provider: raw.provider, cwd };
  if (raw.op === 'catalog') return result;
  if (typeof raw.nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(raw.nonce)) throw sessionError('invalid_nonce');
  for (const key of ['model', 'effort']) {
    if (raw[key] != null && (typeof raw[key] !== 'string' || raw[key].length > 256 || /[\u0000-\u001f]/.test(raw[key]))) {
      throw sessionError('invalid_request');
    }
  }
  const prompt = raw.prompt ?? '';
  if (typeof prompt !== 'string' || prompt.length > 24_000 || Buffer.byteLength(prompt) > 96 * 1024 || prompt.includes('\0')) throw sessionError('invalid_prompt');
  return { ...result, nonce: raw.nonce, model: raw.model || null, effort: raw.effort || null, prompt };
}

export function selectSessionModel(request, catalog) {
  if (!catalog || !Array.isArray(catalog.models) || !catalog.models.length) throw sessionError('models_unavailable');
  const selected = request.model ? catalog.models.find(m => m.id === request.model)
    : catalog.models.find(m => m.isDefault) ?? catalog.models[0];
  if (!selected) throw sessionError('model_unavailable');
  const supported = Array.isArray(selected.efforts) ? selected.efforts : [];
  // An omitted effort means inherit the client's configuration, even when
  // its model catalog advertises a separate model-level default.
  const effort = request.effort || null;
  if (effort && !supported.includes(effort)) throw sessionError('effort_unavailable');
  return { ...request, model: selected.id, effort };
}

export async function providerModule(provider) {
  if (provider === 'Codex') return import('./managed-codex.js');
  if (provider === 'Claude') return import('./managed-claude.js');
  throw sessionError('invalid_provider');
}

export async function modelCatalog(request, { load = providerModule, executable } = {}) {
  const module = await load(request.provider);
  const discover = request.provider === 'Codex' ? module.discoverCodexModels : module.discoverClaudeModels;
  return discover({ cwd: request.cwd, executable: executable || installedClient(request.provider) });
}
