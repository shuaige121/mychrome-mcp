import path from 'node:path';

/** Presentation only: identify the client, never search prompts or command arguments. */
export function clientDisplayName(clientName, executable = '') {
  const name = String(clientName || '').trim().toLowerCase().replace(/[ _]+/g, '-');
  if (/^(?:openai-)?codex(?:-(?:cli|mcp-client|app|desktop))?$/.test(name)) return 'Codex';
  if (/^(?:claude|claude-code|claude-desktop|claude-ai)$/.test(name)) return 'Claude';
  if (/^(?:chatgpt|chatgpt-desktop)$/.test(name)) return 'ChatGPT';
  if (/^(?:cursor|cursor-vscode)$/.test(name)) return 'Cursor';
  if (name) return 'Agent';
  const bin = path.basename(String(executable || '').trim()).toLowerCase();
  return ({ codex: 'Codex', claude: 'Claude', chatgpt: 'ChatGPT', cursor: 'Cursor' })[bin] || 'Agent';
}
