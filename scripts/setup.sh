#!/bin/bash
# Bootstrap without npm dependencies. No downloads, privileged actions, or settings changes here.
set -eu
SETUP_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'MyChrome needs Node.js. Install the Apple Silicon (arm64) LTS version from https://nodejs.org, reopen Terminal, and run this command again.' >&2
  exit 1
fi
# Older Node must receive useful guidance before parsing the modern setup module.
if ! node -e 'const [m,n]=process.versions.node.split(".").map(Number);process.exit(m>=24||(m===22&&n>=13)||(m===20&&n>=19)?0:1)'; then
  printf '%s\n' 'MyChrome source setup needs Node.js 24+ (recommended), 22.13+, or 20.19+. Install the arm64 LTS version from https://nodejs.org, reopen Terminal, and retry.' >&2
  exit 1
fi
exec node "$SETUP_DIR/setup.mjs" "$@"
