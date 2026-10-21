# Source distribution

The development checkout includes private verification and research material. Publish a reviewed source snapshot with new Git history, preserving `LICENSE`; never push its complete development history as a shortcut.

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

Four deliberate public assets are exceptions to the binary-file exclusion: `site/assets/mychrome-workspace.webp`, `site/assets/mychrome-practice-poster.webp`, `site/assets/mychrome-practice.gif` and `site/assets/social-card.png`. Each still needs an explicit manifest entry, staged ordinary-file bytes, format/size checks and visual privacy review. The path list is exact; another image in the same directory is not automatically eligible. These assets use synthetic demo content. Keep raw recordings outside the export and inspect the final compressed media, including first, middle and final frames.

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

Create a new Git repository in the exported directory only after these checks. Default to private visibility unless the owner explicitly requests public distribution. Verify the remote commit and visibility after the authorized push, then check a fresh clone. Preserve the original development checkout and its history.

Before changing an existing repository from private to public, review every reachable branch/tag, release attachment and Actions history. Removing private material from the current tree does not remove it from earlier commits. If an old private distribution contains material that should stay private, preserve it as a private archive and publish the reviewed snapshot with fresh history. Do not push the development history or silently delete earlier releases to make an audit pass.

Publishing an npm package is a separate operation. Until a package is actually published and verified, document source installation.
