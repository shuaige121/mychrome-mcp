/* The npm package: the bin starts the server when run directly or through a link (npm's …/bin/mychrome-mcp,
 * node_modules/.bin/mychrome-mcp), importing src/index.js does not, and package.json ships the prebuilt helpers
 * without building anything at install time. Starts the server only to list tools: no Chrome call, a throwaway
 * tab registry and lock dir, no menu-bar app. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'src', 'index.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mychrome-pkg-'));

/** test/stdio-check.mjs against a command; its JSON line. */
function stdioCheck(...cmd) {
  try {
    return JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'test', 'stdio-check.mjs'), '--no-call', '--timeout-ms', '15000', '--', ...cmd],
      { encoding: 'utf8', timeout: 30_000 }).trim().split('\n').pop());
  } catch (e) {
    const line = String(e.stdout || '').trim().split('\n').pop();
    try { return JSON.parse(line); } catch { throw e; }
  }
}

console.log('package (npm bin, files, scripts)');

await t('started through a link the way npm installs the bin: the server answers with all its tools', async () => {
  const link = path.join(tmp, 'bin', 'mychrome-mcp');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(INDEX, link);
  const viaNode = stdioCheck(process.execPath, link);
  assert.equal(viaNode.error, null, JSON.stringify(viaNode));
  assert.equal(viaNode.tools, 17, JSON.stringify(viaNode));
  assert.ok(viaNode.names.includes('routines'));
  const direct = stdioCheck(process.execPath, INDEX);
  assert.deepEqual(viaNode.names, direct.names);
});

await t('imported by a script, src/index.js does not start a server (stdin left open, no "ready", exits by itself)', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(INDEX)}); console.log('imported');`],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'), CHROME_BRIDGE_LOCK: path.join(tmp, 'input.lock') } });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 15_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0, `exit ${code}; stderr: ${err}`);
  assert.match(out, /imported/);
  assert.doesNotMatch(err, /mychrome-mcp ready/);
});

await t('the bin is src/index.js with a node shebang', async () => {
  assert.equal(pkg.bin['mychrome-mcp'], 'src/index.js');
  assert.equal(fs.readFileSync(INDEX, 'utf8').split('\n')[0], '#!/usr/bin/env node');
});

await t('ships the three prebuilt helpers and no backups; nothing is built at install time', async () => {
  for (const f of ['bin/cgevent', 'bin/chromectl', 'bin/cbmenu']) assert.ok(pkg.files.includes(f), `files lacks ${f}`);
  assert.ok(!pkg.files.some(f => f === 'bin' || f === 'bin/' || f.includes('*') && f.startsWith('bin')), 'files must list the helpers one by one (bin/ also holds .bak-* copies)');
  for (const s of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[s], undefined, `scripts.${s} would run at the user's install`);
  assert.match(pkg.scripts.prepack, /npm run build/);
});

await t('every helper is built for the same explicit macOS target (the minimum the README states)', async () => {
  const targets = [...pkg.scripts.build.matchAll(/swiftc [^&]*?-target (arm64-apple-macos\d+)/g)].map(m => m[1]);
  assert.equal(targets.length, 3, pkg.scripts.build);
  assert.equal(new Set(targets).size, 1, targets.join(' '));
  const nn = targets[0].replace('arm64-apple-macos', '');
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), new RegExp(`macOS ${nn}(?:\\+| and later)`));
  assert.match(fs.readFileSync(path.join(ROOT, 'README.zh-CN.md'), 'utf8'), new RegExp(`macOS ${nn}`));
  assert.deepEqual(pkg.os, ['darwin']);
  assert.deepEqual(pkg.cpu, ['arm64']);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`package: ${passed} passed`);
