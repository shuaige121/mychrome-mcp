import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectRelease, exportRelease } from '../scripts/export-release.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mychrome-release-export-'));
const root = path.join(temp, 'source');
const manifestName = 'docs/release/release-manifest.json';
let passed = 0;
const run = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };
try {
  await fs.mkdir(path.join(root, 'docs/release'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  // The fixture repository must not inherit a developer's global ignore rules.
  execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: root });
  await fs.writeFile(path.join(root, 'LICENSE'), 'MIT fixture attribution\n');
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n[License](LICENSE)\n');
  await fs.writeFile(path.join(root, 'private.log'), 'private fixture, must not be exported\n');
  const standard = ['LICENSE', 'README.md', manifestName];
  const manifest = async files => {
    await fs.writeFile(path.join(root, manifestName), JSON.stringify({ version: 1, files }));
    execFileSync('git', ['add', '--', manifestName], { cwd: root });
  };
  const stage = () => execFileSync('git', ['add', '--', 'LICENSE', 'README.md', manifestName], { cwd: root });
  await manifest(standard); stage();

  await run('exports only reviewed tracked files; never .git or unrelated local data', async () => {
    const inspected = await inspectRelease(root);
    const target = await exportRelease(inspected, path.join(temp, 'release'));
    assert.equal(await fs.readFile(path.join(target, 'README.md'), 'utf8'), '# Fixture\n[License](LICENSE)\n');
    for (const excluded of ['.git', 'private.log']) await assert.rejects(fs.access(path.join(target, excluded)));
    assert.equal(inspected.files.size, 3);
  });
  await run('refuses existing destination and preserves its contents', async () => {
    const dest = path.join(temp, 'existing');
    await fs.mkdir(dest);
    await fs.writeFile(path.join(dest, 'keep'), 'unchanged');
    await assert.rejects(exportRelease(await inspectRelease(root), dest), /EEXIST/);
    assert.equal(await fs.readFile(path.join(dest, 'keep'), 'utf8'), 'unchanged');
  });
  await run('refuses an export inside the source checkout', async () => {
    await assert.rejects(exportRelease(await inspectRelease(root), path.join(root, 'export')), /outside/);
    await assert.rejects(fs.access(path.join(root, 'export')));
  });
  await run('rejects untracked allowlist additions before writing anything', async () => {
    await fs.writeFile(path.join(root, 'unreviewed.md'), 'unreviewed');
    await manifest([...standard, 'unreviewed.md']);
    await assert.rejects(inspectRelease(root), /Not tracked in the Git index/);
  });
  await run('rejects private file types even when explicitly listed', async () => {
    await manifest([...standard, 'private.log']);
    execFileSync('git', ['add', '--', 'private.log'], { cwd: root });
    await assert.rejects(inspectRelease(root), /Excluded data type/);
  });
  await run('rejects a symlinked directory instead of following it', async () => {
    await fs.mkdir(path.join(temp, 'elsewhere'));
    await fs.writeFile(path.join(temp, 'elsewhere/secret.md'), 'not source');
    await fs.symlink('../elsewhere', path.join(root, 'linked'));
    await manifest([...standard, 'linked']);
    execFileSync('git', ['add', '--', 'linked'], { cwd: root });
    await assert.rejects(inspectRelease(root), /Symlink is not allowed/);
  });
  await run('rejects a potential credential without echoing its value', async () => {
    const credential = 'gh' + 'p_' + 'A'.repeat(36);
    await fs.writeFile(path.join(root, 'README.md'), credential);
    execFileSync('git', ['add', '--', 'README.md'], { cwd: root });
    await manifest(standard);
    await assert.rejects(inspectRelease(root), err => err.message.includes('Potential GitHub token') && !err.message.includes(credential));
  });
  await run('requires document links and package script dependencies to be exported', async () => {
    await fs.writeFile(path.join(root, 'README.md'), '[Missing](missing.md)');
    execFileSync('git', ['add', '--', 'README.md'], { cwd: root });
    await assert.rejects(inspectRelease(root), /Documentation link leaves/);
    await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n');
    execFileSync('git', ['add', '--', 'README.md'], { cwd: root });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test/missing.test.mjs' } }));
    execFileSync('git', ['add', '--', 'package.json'], { cwd: root });
    await manifest([...standard, 'package.json']);
    await assert.rejects(inspectRelease(root), /Missing package script dependency/);
  });
  await run('unstaged worktree changes and an unstaged manifest never enter the export', async () => {
    await manifest(standard);
    await fs.writeFile(path.join(root, 'README.md'), 'private unstaged draft');
    await fs.writeFile(path.join(root, manifestName), JSON.stringify({ version: 1, files: [...standard, 'private.log'] }));
    const target = await exportRelease(await inspectRelease(root), path.join(temp, 'index-only'));
    assert.equal(await fs.readFile(path.join(target, 'README.md'), 'utf8'), '# Fixture\n');
    await assert.rejects(fs.access(path.join(target, 'private.log')));
  });
  await run('exports the inspected snapshot even if worktree files change later', async () => {
    await manifest(standard);
    const inspected = await inspectRelease(root);
    await fs.writeFile(path.join(root, 'README.md'), 'changed after inspection');
    const target = await exportRelease(inspected, path.join(temp, 'snapshot'));
    assert.equal(await fs.readFile(path.join(target, 'README.md'), 'utf8'), '# Fixture\n');
  });
  const mediaName = 'site/assets/mychrome-practice.gif';
  const pixelGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const stageMedia = async (name, bytes) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), bytes);
    execFileSync('git', ['add', '--', name], { cwd: root });
    await manifest([...standard, name]);
  };
  await run('allows only exact reviewed media names and preserves staged bytes on export', async () => {
    await stageMedia(mediaName, pixelGif);
    const inspected = await inspectRelease(root);
    await fs.writeFile(path.join(root, mediaName), 'unstaged private material');
    const target = await exportRelease(inspected, path.join(temp, 'public-media'));
    assert.deepEqual(await fs.readFile(path.join(target, mediaName)), pixelGif);
    await stageMedia('site/assets/private-screen.gif', pixelGif);
    await assert.rejects(inspectRelease(root), /Excluded data type/);
  });
  await run('rejects wrong media type, truncated frames, oversized assets and executable media', async () => {
    for (const bytes of [Buffer.from('plain text pretending to be an image'), pixelGif.subarray(0, -1), Buffer.alloc(12 * 1024 * 1024 + 1)]) {
      await stageMedia(mediaName, bytes);
      await assert.rejects(inspectRelease(root), /Invalid .*public media/);
    }
    await stageMedia(mediaName, pixelGif);
    execFileSync('git', ['update-index', '--chmod=+x', '--', mediaName], { cwd: root });
    await assert.rejects(inspectRelease(root), /Invalid public media size or executable mode/);
    execFileSync('git', ['update-index', '--chmod=-x', '--', mediaName], { cwd: root });
  });
  await run('approved media paths do not bypass symlink or credential checks', async () => {
    const credential = 'gh' + 'p_' + 'A'.repeat(36);
    await stageMedia(mediaName, Buffer.concat([pixelGif.subarray(0, -1), Buffer.from(credential), Buffer.from([0x3b])]));
    await assert.rejects(inspectRelease(root), err => err.message.includes('Potential GitHub token') && !err.message.includes(credential));
    await fs.unlink(path.join(root, mediaName));
    await fs.symlink('../../../elsewhere/secret.md', path.join(root, mediaName));
    execFileSync('git', ['add', '--', mediaName], { cwd: root });
    await assert.rejects(inspectRelease(root), /Symlink is not allowed/);
  });
  console.log(`release-export: ${passed} passed`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
