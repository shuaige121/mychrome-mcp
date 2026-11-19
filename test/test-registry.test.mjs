#!/usr/bin/env node
/* LOG-OS: every test/*.test.mjs added since 39989aa (the installed version), except -live files, is registered in
 * package.json `test`; a file nobody runs gives no protection. "Added" is judged against the working tree, so a file
 * that is staged, or not yet added at all, counts as well as committed ones (`git diff <base>` sees the index).
 * Uses git history; skipped (loudly) only when the history is not available. The staged case runs in a scratch
 * repository: nothing is ever staged in the real worktree. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const lines = s => s.split('\n').filter(Boolean);

/** Test files added since `base` in `cwd` (committed, staged or untracked), not -live, not in the `test` script. */
function unregistered(cwd, base, script) {
  const added = [
    ...lines(git(cwd, 'diff', '--name-only', '--diff-filter=A', base, '--', 'test/*.test.mjs')),
    ...lines(git(cwd, 'ls-files', '--others', '--exclude-standard', '--', 'test/*.test.mjs'))];
  const registered = new Set([...script.matchAll(/node (test\/[\w.-]+\.test\.mjs)/g)].map(m => m[1]));
  return { added: [...new Set(added)], missing: [...new Set(added)].filter(f => !/-live\.test\.mjs$/.test(f) && !registered.has(f)), registered };
}

/* The staged case: a scratch repo with a base commit, one registered test, and new tests in each state. */
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-registry-'));
  const sh = (...a) => git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
  sh('init', '-q'); mkdirSync(path.join(dir, 'test'));
  writeFileSync(path.join(dir, 'test/old.test.mjs'), '');
  sh('add', '.'); sh('commit', '-q', '-m', 'base');
  const base = lines(sh('rev-parse', 'HEAD'))[0];
  const script = 'node test/old.test.mjs && node test/new.test.mjs';
  writeFileSync(path.join(dir, 'test/new.test.mjs'), '');
  assert.deepEqual(unregistered(dir, base, script).missing, [], 'untracked but registered: fine');
  writeFileSync(path.join(dir, 'test/forgot.test.mjs'), '');
  assert.deepEqual(unregistered(dir, base, script).missing, ['test/forgot.test.mjs'], 'untracked and unregistered fails');
  sh('add', 'test/forgot.test.mjs');   // staged: in neither HEAD nor the untracked list
  assert.deepEqual(unregistered(dir, base, script).missing, ['test/forgot.test.mjs'], 'staged and unregistered must fail');
  writeFileSync(path.join(dir, 'test/x-live.test.mjs'), ''); sh('add', 'test/x-live.test.mjs');
  assert.deepEqual(unregistered(dir, base, script).missing, ['test/forgot.test.mjs'], '-live files are excluded');
  assert.deepEqual(unregistered(dir, base, script + ' && node test/forgot.test.mjs').missing, [], 'registering it fixes it');
  console.log('test-registry: scratch repo cases (untracked, staged, -live, registered) behave');
}

const BASE = '39989aa';
try { git(root, 'cat-file', '-e', `${BASE}^{commit}`); }
catch {
  console.log(`test-registry: SKIPPED the real check, git history for ${BASE} is not available here`);
  process.exit(0);
}
const script = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.test;
const { added, missing, registered } = unregistered(root, BASE, script);
assert.deepEqual(missing, [], `test files missing from package.json "test": ${missing.join(', ')}`);
assert.ok(registered.size > 100, 'the test script parses');
console.log(`test-registry: ${added.length} added test files checked, none missing`);
