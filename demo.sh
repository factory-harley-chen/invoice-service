#!/usr/bin/env bash
# Entry point for the demo tooling; see ./demo.sh --help and SETUP.md.
# (It cannot be called ./demo: the demo/ folder already has that name.)
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL node is not installed. Fix: install Node 22.18 or later (see .nvmrc)" >&2
  exit 1
fi
version="$(node -p 'process.versions.node')"
major="${version%%.*}"
minor="${version#*.}"
minor="${minor%%.*}"
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; }; then
  echo "FAIL node $version cannot run TypeScript directly. Fix: install Node 22.18 or later (nvm install 22)" >&2
  exit 1
fi

exec node "$root/demo/cli/main.ts" "$@"
