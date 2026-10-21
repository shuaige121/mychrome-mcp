#!/usr/bin/env node
import { requestGui } from './gui-ipc.js';
import os from 'node:os';
import path from 'node:path';

// Invoked by the native GUI with the server identity on argv; user text only arrives on stdin.
const base = process.env.CHROME_BRIDGE_LOCK
  ? path.dirname(process.env.CHROME_BRIDGE_LOCK)
  : path.join(os.homedir(), 'Library/Caches/chrome-bridge-mcp');
try {
  const [pid, instance] = process.argv.slice(2);
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const part of process.stdin) {
    input += part;
    if (Buffer.byteLength(input) > 128 * 1024) throw new Error('too_large');
  }
  const request = JSON.parse(input);
  const result = await requestGui({ base, pid: Number(pid), instance, op: request?.op, payload: request?.payload });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ ok: false, code: 'connection_lost', delivery: 'unknown' }) + '\n');
  process.exitCode = 1;
}
