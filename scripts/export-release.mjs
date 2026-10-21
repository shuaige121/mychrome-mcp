#!/usr/bin/env node
/** Export a reviewed source allowlist, never the development repository's Git history or runtime data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'docs/release/release-manifest.json';
// Only these reviewed product assets may cross the binary-file boundary.
// Adding a name here requires visual privacy review as well as a manifest entry.
const PUBLIC_MEDIA = new Map([
  ['site/assets/mychrome-overview.mp4', { format: 'mp4', maxBytes: 32 * 1024 * 1024 }],
  ['site/assets/mychrome-overview.gif', { format: 'gif', maxBytes: 12 * 1024 * 1024 }],
  ['site/assets/mychrome-overview-poster.webp', { format: 'webp', maxBytes: 4 * 1024 * 1024 }],
  ['site/assets/social-card.png', { format: 'png', maxBytes: 4 * 1024 * 1024 }],
]);
const FORBIDDEN = /(^|\/)(?:\.git|\.ssh|\.aws|\.npmrc|\.netrc|node_modules|bin|verification|handover|experiments|sessions?|histories|cache|caches|logs|\.env(?:\..*)?|auth\.json|Codex\.local\.md|settings\.local\.json|[^/]*credentials[^/]*)(?:\/|$)|^docs\/(?:live|research|discussion[^/]*|marketing|routing-eval)(?:\/|$)|\.(?:log|jsonl|db|sqlite\d*|png|jpe?g|gif|webp|mp4|mov|tgz|zip)$/i;
const CONTENT_RULES = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];
// Binary fields (for example an mdat payload) can place a credential directly
// beside a word character. Text-token boundaries are not meaningful there.
const MEDIA_CONTENT_RULES = CONTENT_RULES.map(([kind, rule]) =>
  [kind, new RegExp(rule.source.replaceAll('\\b', ''), rule.flags)]);

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Walk box boundaries without allocating one object per box. Extended sizes are
// compared as BigInt before conversion, so high bits cannot wrap or lose precision.
function walkMp4Boxes(bytes, start, end, visit, allowFinalMdat = false) {
  for (let offset = start; offset < end;) {
    const remaining = end - offset;
    if (remaining < 8) return false;
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (remaining < 16) return false;
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended < 16n || extended > BigInt(remaining)) return false;
      size = Number(extended);
      header = 16;
    } else if (size === 0) {
      // The release accepts an EOF-sized mdat only at file level, not a child
      // box that could swallow the rest of its enclosing movie metadata.
      if (!allowFinalMdat || type !== 'mdat') return false;
      size = remaining;
    }
    if (size < header || size > remaining || !visit(type, offset + header, offset + size, offset)) return false;
    offset += size;
  }
  return true;
}

function validMp4Movie(bytes, start, end) {
  let headers = 0;
  let tracks = 0;
  const framed = walkMp4Boxes(bytes, start, end, (type, body, stop) => {
    if (type === 'mvhd') {
      headers++;
      return headers === 1 && (bytes[body] === 0 ? stop - body >= 100 : bytes[body] === 1 && stop - body >= 112);
    }
    if (type === 'trak') {
      tracks++;
      let trackHeaders = 0;
      return walkMp4Boxes(bytes, body, stop, (child, childBody, childEnd) => {
        if (child !== 'tkhd') return true;
        trackHeaders++;
        return trackHeaders === 1 && (bytes[childBody] === 0 ? childEnd - childBody >= 84 : bytes[childBody] === 1 && childEnd - childBody >= 96);
      }) && trackHeaders === 1;
    }
    return true;
  });
  return framed && headers === 1 && tracks > 0;
}

// Container preflight for the reviewed overview, not a codec or playback test.
// Release review must still decode/probe the final media independently.
function validMp4(bytes) {
  let fileTypes = 0;
  let movies = 0;
  let mediaData = 0;
  const framed = walkMp4Boxes(bytes, 0, bytes.length, (type, body, end, offset) => {
    if (offset === 0 && type !== 'ftyp') return false;
    if (type === 'ftyp') {
      fileTypes++;
      if (fileTypes !== 1 || end - body < 8 || (end - body - 8) % 4 !== 0) return false;
      const supported = brand => /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(brand);
      if (supported(bytes.toString('latin1', body, body + 4))) return true;
      for (let brand = body + 8; brand < end; brand += 4)
        if (supported(bytes.toString('latin1', brand, brand + 4))) return true;
      return false;
    }
    if (type === 'moov') return ++movies === 1 && validMp4Movie(bytes, body, end);
    if (type === 'mdat') { mediaData++; return end > body; }
    return true;
  }, true);
  return framed && fileTypes === 1 && movies === 1 && mediaData > 0;
}

function validatePublicMedia(name, bytes, mode) {
  const rule = PUBLIC_MEDIA.get(name);
  if (mode !== 0o644 || bytes.length < 14 || bytes.length > rule.maxBytes)
    throw new Error(`Invalid public media size or executable mode: ${name}`);
  let valid = false;
  if (rule.format === 'gif') {
    valid = /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) &&
      bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes.at(-1) === 0x3b;
  } else if (rule.format === 'png') {
    valid = bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
      bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
      bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
  } else if (rule.format === 'webp') {
    valid = bytes.length >= 30 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.readUInt32LE(4) === bytes.length - 8 && bytes.subarray(8, 12).toString('ascii') === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString('ascii'));
  } else if (rule.format === 'mp4') valid = validMp4(bytes);
  if (!valid) throw new Error(`Invalid ${rule.format} public media: ${name}`);
}

/** Reads only the reviewed Git index, never unstaged worktree changes or prior Git history. */
export async function inspectRelease(root = ROOT, manifestName = MANIFEST) {
  root = await fs.realpath(root);
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
  if (await fs.realpath(top) !== root) throw new Error('Source must be the Git repository root.');
  const index = new Map();
  for (const entry of execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
    if (match && match[3] === '0') index.set(match[4], { mode: match[1], oid: match[2] });
  }
  const stagedBytes = name => {
    const entry = index.get(name);
    if (!entry) throw new Error(`Not tracked in the Git index; review and stage it first: ${name}`);
    if (entry.mode === '120000') throw new Error(`Symlink is not allowed: ${name}`);
    if (!['100644', '100755'].includes(entry.mode)) throw new Error(`Not a regular source file: ${name}`);
    const media = PUBLIC_MEDIA.get(name);
    if (media) {
      // Check the immutable staged blob before reading it, including files larger
      // than cat-file's output buffer. Container-declared sizes are not a file cap.
      const size = Number(execFileSync('git', ['cat-file', '-s', entry.oid], { cwd: root, encoding: 'utf8' }).trim());
      if (entry.mode !== '100644' || !Number.isSafeInteger(size) || size < 14 || size > media.maxBytes)
        throw new Error(`Invalid public media size or executable mode: ${name}`);
    }
    return { bytes: execFileSync('git', ['cat-file', 'blob', entry.oid], { cwd: root, maxBuffer: 32 * 1024 * 1024 }),
      mode: entry.mode === '100755' ? 0o755 : 0o644 };
  };
  const manifest = JSON.parse(stagedBytes(manifestName).bytes.toString('utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error('Expected a version 1 manifest with an explicit, non-empty files array.');
  const files = new Map();
  const problems = [];
  for (const name of manifest.files) {
    if (typeof name !== 'string' || !name || name.includes('\\') || /[\0\r\n]/.test(name) ||
        path.posix.normalize(name) !== name || path.posix.isAbsolute(name) || name.startsWith('../') || name === '..') {
      problems.push('Manifest contains an invalid relative path.');
      continue;
    }
    if (files.has(name)) { problems.push(`Duplicate manifest path: ${name}`); continue; }
    const media = PUBLIC_MEDIA.has(name);
    if (FORBIDDEN.test(name) && !media) { problems.push(`Excluded data type in manifest: ${name}`); continue; }
    try {
      const { bytes, mode } = stagedBytes(name);
      const text = bytes.toString(media ? 'latin1' : 'utf8');
      if (media) validatePublicMedia(name, bytes, mode);
      else if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes))
        throw new Error(`Only UTF-8 source text is allowed: ${name}`);
      for (const [kind, re] of media ? MEDIA_CONTENT_RULES : CONTENT_RULES)
        if (re.test(text)) problems.push(`Potential ${kind} in ${name}; inspect locally before exporting.`);
      files.set(name, { bytes, text: media ? null : text, mode,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch (e) { problems.push(String(e.message)); }
  }
  if (!files.has('LICENSE')) problems.push('LICENSE must be included to preserve attribution.');
  if (!files.has(manifestName)) problems.push('The release manifest must include itself.');
  for (const [name, file] of files) {
    if (!name.endsWith('.md') && name !== 'llms.txt') continue;
    for (const match of file.text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const linked = path.posix.normalize(path.posix.join(path.posix.dirname(name), decodeURIComponent(target)));
      if (!files.has(linked)) problems.push(`Documentation link leaves the export: ${name} -> ${linked}`);
    }
  }
  const pkg = files.get('package.json');
  if (pkg) {
    try {
      const data = JSON.parse(pkg.text);
      for (const [script, command] of Object.entries(data.scripts ?? {})) {
        for (const match of String(command).matchAll(/\bnode\s+((?:test|scripts|src)\/[\w./-]+\.(?:mjs|js))/g))
          if (!files.has(match[1])) problems.push(`Missing package script dependency: ${script} -> ${match[1]}`);
      }
    } catch (e) { problems.push(`Invalid package.json: ${e.message}`); }
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return { root, files };
}

export async function exportRelease(inspection, destination) {
  const target = path.resolve(destination);
  const parent = await fs.realpath(path.dirname(target));
  const resolvedTarget = path.join(parent, path.basename(target));
  if (within(inspection.root, resolvedTarget)) throw new Error('Export destination must be outside the source repository.');
  // mkdir without recursive or overwrite semantics refuses even an existing empty directory.
  await fs.mkdir(resolvedTarget, { mode: 0o755 });
  for (const [name, file] of inspection.files) {
    const dest = path.join(resolvedTarget, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.bytes, { flag: 'wx', mode: file.mode });
    const digest = createHash('sha256').update(await fs.readFile(dest)).digest('hex');
    if (digest !== file.sha256) throw new Error(`Export readback differs: ${name}`);
  }
  return resolvedTarget;
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/export-release.mjs --list | --check | --output NEW_DIRECTORY\n--list previews the worktree manifest. Checks/exports use only staged Git-index bytes, including the manifest. Existing directories are never overwritten.');
    return;
  }
  if (!(args.length === 1 && ['--list', '--check'].includes(args[0])) &&
      !(args.length === 2 && args[0] === '--output'))
    throw new Error('Choose --list, --check, or --output NEW_DIRECTORY.');
  if (args[0] === '--list') {
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, MANIFEST), 'utf8'));
    for (const name of manifest.files) console.log(name);
    return;
  }
  const inspection = await inspectRelease();
  const target = args[0] === '--output' ? await exportRelease(inspection, args[1]) : null;
  console.log(JSON.stringify({
    ok: true, files: inspection.files.size, ...(target ? { destination: target } : {}),
    inventory: [...inspection.files].map(([name, file]) => ({ path: name, bytes: file.bytes.length, sha256: file.sha256 }))
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
