#!/usr/bin/env bash
# routines CI gate — run by the LastGit CI watcher on every pushed head; the
# required status `ci-required` that gated auto-merge waits on.
#
# Keep it cheap (seconds): it runs in a fresh clone per push. Written to be
# skeleton-tolerant (macOS bash 3.2, no arrays under set -u): loops simply
# don't execute while the repo has no src/ or test/ yet, and pick the files
# up automatically as the MVP lands.
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob

# 1. shell syntax of every script
for f in .lastgit/*.sh scripts/*.sh test/*.sh; do
  echo "bash -n $f"
  bash -n "$f"
done

# 2. typecheck / build every TS entrypoint
for f in src/*.ts test/*.ts; do
  echo "bun build $f"
  bun build "$f" --target=bun --outfile=/dev/null
done

# 3. unit tests, once any exist
found_tests=0
for f in test/*.test.ts src/*.test.ts; do
  found_tests=1
done
if [ "$found_tests" = 1 ]; then
  # Some daemon/escalation tests exercise real process dispatch and bounded
  # retry loops; the default 5s Bun test timeout is too tight under CI load.
  bun test --timeout=30000
else
  echo "ci: no tests yet (repo skeleton) — gate is syntax + typecheck"
fi
