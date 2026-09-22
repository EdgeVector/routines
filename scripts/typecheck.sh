#!/usr/bin/env bash
# Whole-program typecheck that works in a fresh worktree.
#
# `tsc --noEmit` alone failed in a new worktree: there is no node_modules, so
# no tsc. `bunx tsc` then failed inside agent sandboxes before tsc ran, with
# "bun is unable to write files to tempdir: PermissionDenied", because the
# sandbox denies the system TMPDIR (papercut-bun-tsc-temp-cache-permission-20260922).
#
# This script keeps Bun's temp files inside the checkout (.cache/bun-tmp,
# gitignored), installs the locked devDependencies when tsc is missing, and runs
# the installed tsc. The CI gate (.lastgit/ci.sh) runs the same steps.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$PWD/.cache/bun-tmp"
mkdir -p "$tmp"
export BUN_TMPDIR="$tmp"
export TMPDIR="$tmp"

if [ ! -x node_modules/.bin/tsc ]; then
  echo "typecheck: installing locked devDependencies (no node_modules/.bin/tsc)" >&2
  bun install --frozen-lockfile
fi

exec node_modules/.bin/tsc --noEmit "$@"
