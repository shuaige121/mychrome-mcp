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
  const mediaName = 'site/assets/mychrome-overview.gif';
  const videoName = 'site/assets/mychrome-overview.mp4';
  const pixelGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const pixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRk0AAAAASUVORK5CYII=', 'base64');
  const pixelWebp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  // Small ISO BMFF container fixtures exercise framing, not codec decoding.
  // Playback/codec checks belong to the separate release-time ffprobe review.
  const box = (type, payload = Buffer.alloc(0), { extended = false, toEnd = false } = {}) => {
    const header = Buffer.alloc(extended ? 16 : 8);
    header.writeUInt32BE(extended ? 1 : toEnd ? 0 : header.length + payload.length);
    header.write(type, 4, 4, 'ascii');
    if (extended) header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
    return Buffer.concat([header, payload]);
  };
  const fileType = box('ftyp', Buffer.from('69736f6d0000020069736f6d69736f32617663316d703431', 'hex'));
  const movie = box('moov', Buffer.concat([
    box('mvhd', Buffer.alloc(100)), box('trak', box('tkhd', Buffer.alloc(84))),
  ]));
  const mediaData = box('mdat', Buffer.from([0, 0, 0, 1, 0x65]));
  const video = Buffer.concat([fileType, movie, mediaData]);
  const reviewedMedia = [
    [videoName, video, 32 * 1024 * 1024],
    [mediaName, pixelGif, 12 * 1024 * 1024],
    ['site/assets/mychrome-overview-poster.webp', pixelWebp, 4 * 1024 * 1024],
    ['site/assets/social-card.png', pixelPng, 4 * 1024 * 1024],
  ];
  const stageMedia = async (name, bytes) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), bytes);
    execFileSync('git', ['add', '--', name], { cwd: root });
    await manifest([...standard, name]);
  };
  await run('allows only exact reviewed media names and preserves staged bytes on export', async () => {
    for (const [name, bytes] of reviewedMedia) {
      await stageMedia(name, bytes);
      const inspected = await inspectRelease(root);
      await fs.writeFile(path.join(root, name), 'unstaged private material');
      const target = await exportRelease(inspected, path.join(temp, path.basename(name)));
      assert.deepEqual(await fs.readFile(path.join(target, name)), bytes);
    }
  });
  await run('rejects old asset names and other media even in the approved directory', async () => {
    for (const [name, bytes] of [
      ['site/assets/mychrome-workspace.webp', pixelWebp],
      ['site/assets/mychrome-practice-poster.webp', pixelWebp],
      ['site/assets/mychrome-practice.gif', pixelGif],
      ['site/assets/private-screen.gif', pixelGif],
      ['site/assets/private-video.mp4', video],
    ]) {
      await stageMedia(name, bytes);
      await assert.rejects(inspectRelease(root), /Excluded data type/, name);
    }
  });
  await run('rejects wrong image formats and truncated media', async () => {
    for (const bytes of [Buffer.from('plain text pretending to be an image'), pixelGif.subarray(0, -1)]) {
      await stageMedia(mediaName, bytes);
      await assert.rejects(inspectRelease(root), /Invalid .*public media/);
    }
    for (const [name, bytes] of reviewedMedia) {
      await stageMedia(name, bytes.subarray(0, -1));
      await assert.rejects(inspectRelease(root), /Invalid .*public media/, name);
    }
  });
  await run('accepts MP4 movie ordering, padding, extended sizes and terminal mdat to EOF', async () => {
    for (const bytes of [
      Buffer.concat([fileType, mediaData, movie]),
      Buffer.concat([fileType, box('free'), movie, mediaData, mediaData]),
      Buffer.concat([
        box('ftyp', fileType.subarray(8), { extended: true }),
        box('moov', movie.subarray(8), { extended: true }),
        box('mdat', mediaData.subarray(8), { extended: true }),
      ]),
      Buffer.concat([fileType, movie, box('mdat', mediaData.subarray(8), { toEnd: true })]),
    ]) {
      await stageMedia(videoName, bytes);
      assert.deepEqual((await inspectRelease(root)).files.get(videoName).bytes, bytes);
    }
  });
  await run('rejects MP4 impostors, missing content and duplicate file/movie headers', async () => {
    for (const [label, bytes] of [
      ['image with an mp4 name', pixelGif],
      ['signatures in plain text', Buffer.from('pretend ftyp isom moov mvhd trak mdat movie')],
      ['missing ftyp', Buffer.concat([movie, mediaData])],
      ['missing moov', Buffer.concat([fileType, mediaData])],
      ['missing mdat', Buffer.concat([fileType, movie])],
      ['empty movie', Buffer.concat([fileType, box('moov'), mediaData])],
      ['movie without a header', Buffer.concat([fileType, box('moov', box('trak', box('tkhd', Buffer.alloc(84)))), mediaData])],
      ['movie without a track', Buffer.concat([fileType, box('moov', box('mvhd', Buffer.alloc(100))), mediaData])],
      ['track without a header', Buffer.concat([fileType, box('moov', Buffer.concat([box('mvhd', Buffer.alloc(100)), box('trak')])), mediaData])],
      ['empty media data', Buffer.concat([fileType, movie, box('mdat')])],
      ['duplicate ftyp', Buffer.concat([fileType, fileType, movie, mediaData])],
      ['duplicate moov', Buffer.concat([fileType, movie, mediaData, movie])],
      ['wrong file brand', Buffer.concat([box('ftyp', Buffer.from('qt  \0\0\0\0qt  ', 'latin1')), movie, mediaData])],
      ['partial compatible brand', Buffer.concat([box('ftyp', fileType.subarray(8, -1)), movie, mediaData])],
      ['movie box containing plain text', Buffer.concat([fileType, box('moov', Buffer.from('not a movie header')), mediaData])],
    ]) {
      await stageMedia(videoName, bytes);
      await assert.rejects(inspectRelease(root), /Invalid mp4 public media/, label);
    }
  });
  await run('rejects truncated or overflowing MP4 box sizes, including 64-bit claims', async () => {
    const tooShort = Buffer.from(mediaData); tooShort.writeUInt32BE(7);
    const outside = Buffer.from(mediaData); outside.writeUInt32BE(mediaData.length + 1);
    const huge = box('mdat', mediaData.subarray(8), { extended: true });
    huge.writeBigUInt64BE(0x1000000000000010n, 8);
    const wrapped = box('mdat', mediaData.subarray(8), { extended: true });
    wrapped.writeBigUInt64BE(0x100000000n + BigInt(wrapped.length), 8);
    const shortExtended = box('mdat', mediaData.subarray(8), { extended: true });
    shortExtended.writeBigUInt64BE(15n, 8);
    const invalidChild = Buffer.from(movie);
    invalidChild.writeUInt32BE(movie.length, 8);
    for (const [label, bytes] of [
      ['missing payload byte', video.subarray(0, -1)],
      ['partial final header', Buffer.concat([fileType, movie, mediaData.subarray(0, 7)])],
      ['size below header', Buffer.concat([fileType, movie, tooShort])],
      ['size outside file', Buffer.concat([fileType, movie, outside])],
      ['truncated extended header', Buffer.concat([fileType, movie, huge.subarray(0, 15)])],
      ['extended size beyond safe integer', Buffer.concat([fileType, movie, huge])],
      ['extended size with plausible low bits', Buffer.concat([fileType, movie, wrapped])],
      ['extended size below header', Buffer.concat([fileType, movie, shortExtended])],
      ['movie child beyond its parent', Buffer.concat([fileType, invalidChild, mediaData])],
      ['trailing bytes', Buffer.concat([video, Buffer.from([0, 0, 0])])],
      ['mdat to EOF hides the movie', Buffer.concat([fileType, box('mdat', Buffer.concat([mediaData.subarray(8), movie]), { toEnd: true })])],
    ]) {
      await stageMedia(videoName, bytes);
      await assert.rejects(inspectRelease(root), /Invalid mp4 public media/, label);
    }
  });
  await run('enforces actual-byte media limits and accepts an MP4 exactly at 32 MiB', async () => {
    const limit = 32 * 1024 * 1024;
    const boundary = Buffer.concat([fileType, movie, box('mdat', Buffer.alloc(limit - fileType.length - movie.length - 8))]);
    assert.equal(boundary.length, limit);
    await stageMedia(videoName, boundary);
    assert.equal((await inspectRelease(root)).files.get(videoName).bytes.length, limit);
    for (const [name, bytes, maxBytes] of reviewedMedia) {
      const oversized = Buffer.alloc(maxBytes + 1);
      bytes.copy(oversized);
      await stageMedia(name, oversized);
      await assert.rejects(inspectRelease(root), /Invalid public media size or executable mode/, name);
    }
    // A small declared mdat must never hide bytes past the actual 32 MiB cap.
    const undersizedClaim = Buffer.concat([boundary, Buffer.from([0])]);
    undersizedClaim.writeUInt32BE(8, fileType.length + movie.length);
    await stageMedia(videoName, undersizedClaim);
    await assert.rejects(inspectRelease(root), /Invalid public media size or executable mode/);
  });
  await run('rejects executable media regardless of its valid format', async () => {
    for (const [name, bytes] of reviewedMedia) {
      await stageMedia(name, bytes);
      execFileSync('git', ['update-index', '--chmod=+x', '--', name], { cwd: root });
      await assert.rejects(inspectRelease(root), /Invalid public media size or executable mode/);
      execFileSync('git', ['update-index', '--chmod=-x', '--', name], { cwd: root });
    }
  });
  await run('approved media paths do not bypass symlink or credential checks', async () => {
    const credential = 'gh' + 'p_' + 'A'.repeat(36);
    for (const [name, bytes] of [
      [mediaName, Buffer.concat([pixelGif.subarray(0, -1), Buffer.from(credential), Buffer.from([0x3b])])],
      [videoName, Buffer.concat([fileType, movie, box('mdat', Buffer.from(credential))])],
    ]) {
      await stageMedia(name, bytes);
      await assert.rejects(inspectRelease(root), err => err.message.includes('Potential GitHub token') && !err.message.includes(credential), name);
      await fs.unlink(path.join(root, name));
      await fs.symlink('../../../elsewhere/secret.md', path.join(root, name));
      execFileSync('git', ['add', '--', name], { cwd: root });
      await assert.rejects(inspectRelease(root), /Symlink is not allowed/);
    }
  });
  console.log(`release-export: ${passed} passed`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
