# Source distribution

The development checkout includes private verification and research material. Publish only a reviewed source snapshot, preserving `LICENSE`; never push private development history. The first public release already established clean public Git history. Subsequent releases advance that existing public history with reviewed changes.

## Review and export

`release-manifest.json` is an explicit allowlist. Add only reviewed source, tests, fixtures and maintained documentation. Review and stage intentional files individually, including the manifest. Checks and exports read only the staged Git-index snapshot; unrelated unstaged changes stay in the development checkout. Staging is not a privacy review.

```bash
node scripts/export-release.mjs --list
node scripts/export-release.mjs --check
node test/release-export.test.mjs
node scripts/export-release.mjs --output /absolute/path/to/new-release-directory
```

The output directory must not exist and must be outside the source checkout. `--list` previews the worktree manifest; `--check` and `--output` use the staged manifest and staged file contents. The exporter checks tracked status, ordinary UTF-8 files, symlinks, forbidden data types, several high-confidence credential patterns, local documentation links and package script paths. It copies the inspected bytes and verifies their SHA-256 hashes on readback. Its JSON output is an inventory, not a claim that a repository was published.

The checks deliberately do not replace human review. They cannot identify every secret, private note, personal detail or insecure behavior. Binary helpers, arbitrary screenshots and recordings, logs, local runtime files and Git history are excluded. Build helpers from source in the exported directory.

## Reviewed public media

Only these exact paths are exceptions to the binary-file exclusion:

| Path | Maximum size |
|---|---|
| `site/assets/mychrome-overview.mp4` | 32 MiB |
| `site/assets/mychrome-overview.gif` | 12 MiB |
| `site/assets/mychrome-overview-poster.webp` | 4 MiB |
| `site/assets/social-card.png` | 4 MiB |

Each asset still needs an explicit manifest entry, staged ordinary-file bytes, non-executable mode, format/size checks and visual privacy review. A renamed file or another asset in the same directory is not automatically eligible. The former workspace and practice media paths are no longer allowed. Limits apply to the actual staged blob size, not a container's declared length. Media bytes also pass the credential scan.

For MP4, the exporter checks ISO BMFF box framing: an initial MP4-compatible `ftyp`, a single `moov` with framed movie/track headers, and non-empty `mdat` data. It validates standard and 64-bit extended lengths, rejects truncation, out-of-bounds boxes and duplicate file/movie headers, and accepts an EOF-sized final `mdat`. This is a container preflight, not a codec or playback check. Probe the final release file separately:

```bash
ffprobe -v error -show_entries format=format_name,duration,size:stream=codec_type,codec_name,width,height,pix_fmt -of json site/assets/mychrome-overview.mp4
```

Play the final compressed video and GIF, and inspect the poster and social card. Keep raw recordings outside the export. Public media must exclude real account details, private conversations, notifications and other personal data. Label an animated reconstruction clearly in the media and its accompanying description; do not describe it as a live browser recording. Show a publishing flow as an illustration when no real post was made, and do not claim a completed post, send or transaction without corresponding evidence. Disclose speed changes, cuts or crops used in actual recordings.

## Verify the isolated tree

```bash
cd /absolute/path/to/new-release-directory
npm ci
npm run build
npm test
npm run test:timing
npm pack --dry-run --ignore-scripts
```

Inspect the packed file list separately: npm's `files` field is a different allowlist. Keep live-site evidence private; neither an offline test run nor a package dry run proves account workflows or human takeover behavior.

## Advance the public release history

Use a separate checkout of the existing clean public repository. Apply the verified export there, reconcile reviewed additions/removals, and inspect the complete staged diff before making the next release commit and tag. Its parent must be the existing public history. Verify the remote commit, tag, visibility and released artifacts after the authorized push, then check a fresh clone.

The one-time fresh-history publication is complete. Do not recreate the repository, start a new root commit or replace public history for each version. Do not import the private development repository's commits, branches or tags into the public repository. Keep the private development checkout and the previous private archive intact; removing private material from a current tree does not remove it from old commits or release artifacts.

Publishing an npm package is a separate operation. Until a package is actually published and verified, document source installation.
