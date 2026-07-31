#!/usr/bin/env bash
# Mechanical routines fleet hygiene (no LLM).
#
# Thin wrapper around `routines hygiene` so launchd, cron, or humans can call
# one stable path. Prefer the CLI for flags; this script just forwards argv
# and ensures PATH includes ~/.local/bin.
set -euo pipefail

export PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin"
export ROUTINES_HOME="${ROUTINES_HOME:-$HOME/.routines}"

shim="${ROUTINES_SHIM:-$HOME/.local/bin/routines}"
if [ -x "$shim" ]; then
  exec "$shim" hygiene "$@"
fi

if command -v routines >/dev/null 2>&1; then
  resolved="$(command -v routines)"
  exec "$resolved" hygiene "$@"
fi

# Explicit fallback for development checkouts when no installed shim exists.
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -f "$here/src/cli.ts" ] && [ -x "${ROUTINES_BUN_BIN:-$HOME/.bun/bin/bun}" ]; then
  exec "${ROUTINES_BUN_BIN:-$HOME/.bun/bin/bun}" "$here/src/cli.ts" hygiene "$@"
fi

echo "routines hygiene: neither installed shim nor repo CLI found" >&2
exit 127
