import assert from 'node:assert/strict';
import { clientDisplayName } from '../src/client.js';

assert.equal(clientDisplayName('codex_mcp_client'), 'Codex');
assert.equal(clientDisplayName('claude-code'), 'Claude');
assert.equal(clientDisplayName('ChatGPT'), 'ChatGPT');
assert.equal(clientDisplayName('', '/Applications/Codex.app/Contents/MacOS/codex'), 'Codex');
assert.equal(clientDisplayName('', '/Users/example/.codex/bin/node'), 'Agent');
assert.equal(clientDisplayName('', '/bin/zsh -c "codex task"'), 'Agent');
assert.equal(clientDisplayName('test-client-with-codex-in-its-name', '/usr/bin/codex'), 'Agent');
assert.equal(clientDisplayName('claude-code', '/usr/bin/codex'), 'Claude');
console.log('ok client identity uses handshake or exact executable, never prompt substrings');
