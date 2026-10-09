#!/usr/bin/env bash
# routines CI gate — run by the GitHub Actions `gate` job (.github/workflows/ci-required.yml,
# macos-latest) on every PR and push; the job `ci-required` that branch protection
# requires needs it.
#
# Keep it cheap (seconds): it runs in a fresh clone per push. Written to be
# skeleton-tolerant (macOS bash 3.2, no arrays under set -u): loops simply
# don't execute while the repo has no src/ yet, and pick the files
# up automatically as the MVP lands. The repo has no tests (deleted 2026-10-09);
# the gate is syntax + typecheck + build.
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob

# 1. shell syntax of every script
for f in .lastgit/*.sh scripts/*.sh; do
  echo "bash -n $f"
  bash -n "$f"
done

# 1b. prompt closeout lint — this repo's prompts only. The fleet prompts under
# ~/.last-stack/routines are not present in a fresh CI clone, and the lint
# refuses to report success on an empty scan, so name the path explicitly.
if [ -f scripts/lint-prompt-closeout.sh ] && [ -d prompts ]; then
  echo "== prompt closeout lint =="
  bash scripts/lint-prompt-closeout.sh prompts
fi

# 2. typecheck / build every TS entrypoint
for f in src/*.ts; do
  echo "bun build $f"
  bun build "$f" --target=bun --outfile=/dev/null
done

# 2b. whole-program typecheck — per-file `bun build` misses cross-file type
# errors (e.g. a call site missing a required field of another module's type).
# Fresh clones have no node_modules; install first so @types/bun resolves
# (bun's global cache keeps this to ~a second).
if [ -f tsconfig.json ]; then
  echo "bun install --frozen-lockfile"
  bun install --frozen-lockfile
  echo "bunx tsc --noEmit"
  bunx tsc --noEmit
fi

# 2c. compile host-track artifact binaries (published after green gate)
echo "== artifact build =="
bun run build
