#!/usr/bin/env bash
# Lint routine prompt files for the outcome-sink closeout contract.
#
# Two rules, and they pull in opposite directions on purpose:
#
#   1. MISSING CLOSEOUT — a prompt that never mentions the outcome sink leaves
#      its runs recording `unknown`. `unknown` is invisible on every triage
#      surface: it is neither ok, noop, nor error, so a run that succeeds for
#      19 minutes and exits 0 reads the same as one that died.
#      `coderings-weekly-fold` asks for neither surface and read `unknown` on 5
#      of its last 6 fires.
#
#   2. TRAILER CONTAMINATION — a prompt that spells the machine trailer token
#      glued to `outcome=<verdict>` poisons classification instead of helping
#      it. `parseOutcome` scans the transcript for exactly that shape, and
#      harnesses echo prompt text, so a worked example classifies every run
#      that merely READ the prompt. Name the token and the shape separately.
#
# Rule 1 is a warning by default, because routinesd now appends the closeout to
# every dispatched prompt (src/prompt.ts buildOutcomeCloseout) — a prompt that
# omits it is untidy, not broken. Rule 2 is always an error. Pass --strict to
# fail on rule 1 too.
#
# Usage:
#   bash scripts/lint-prompt-closeout.sh [--strict] [dir-or-file ...]
#
# With no paths, lints this repo's prompts/ plus ~/.last-stack/routines when it
# exists (the installed fleet prompts).
set -euo pipefail

strict=0
paths=()
for arg in "$@"; do
  case "$arg" in
    --strict) strict=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) paths+=("$arg") ;;
  esac
done

if [ "${#paths[@]}" -eq 0 ]; then
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  [ -d "$repo_root/prompts" ] && paths+=("$repo_root/prompts")
  last_stack_routines="${LAST_STACK_ROOT:-$HOME/.last-stack}/routines"
  [ -d "$last_stack_routines" ] && paths+=("$last_stack_routines")
fi

if [ "${#paths[@]}" -eq 0 ]; then
  echo "lint-prompt-closeout: no prompt directories to lint" >&2
  exit 0
fi

files=()
for p in "${paths[@]}"; do
  if [ -d "$p" ]; then
    # -L follows symlinks. ~/.last-stack/routines is a symlink into the
    # host-track artifact tree, and plain `find <symlink>` does not descend it:
    # the lint silently checked 0 fleet prompts while reporting success. A
    # check that cannot observe what it claims to check is worse than no check.
    while IFS= read -r f; do
      [ -n "$f" ] && files+=("$f")
    done < <(find -L "$p" -maxdepth 1 -type f -name '*.md' | sort)
  elif [ -f "$p" ]; then
    files+=("$p")
  else
    echo "lint-prompt-closeout: not found: $p" >&2
    exit 2
  fi
done

if [ "${#files[@]}" -eq 0 ]; then
  echo "lint-prompt-closeout: no .md prompts under: ${paths[*]}" >&2
  echo "  Refusing to report success on an empty scan." >&2
  exit 2
fi

errors=0
warnings=0
checked=0

# The contaminating shape: the trailer token, then `outcome=`, then a verdict
# word. Built from parts so this linter does not trip its own rule.
token='ROUTINE'
token="${token}_RESULT"
contaminating="${token}[[:space:]]+outcome[[:space:]]*=[[:space:]]*(ok|noop|error)\b"

for f in "${files[@]}"; do
  checked=$((checked + 1))

  if grep -qE "$contaminating" "$f"; then
    echo "ERROR $f: spells the machine trailer glued to a verdict word."
    echo "      parseOutcome scans the transcript for that exact shape, so this"
    echo "      example classifies any run that echoes the prompt. Write the"
    echo "      token and \`outcome=<kind>\` separately."
    grep -nE "$contaminating" "$f" | sed 's/^/      /'
    errors=$((errors + 1))
    continue
  fi

  if ! grep -q 'outcome\.txt' "$f"; then
    if [ "$strict" -eq 1 ]; then
      echo "ERROR $f: never mentions the outcome sink (outcome.txt)."
      errors=$((errors + 1))
    else
      echo "warn  $f: never mentions the outcome sink (outcome.txt); routinesd"
      echo "      appends one at dispatch, so runs still classify."
      warnings=$((warnings + 1))
    fi
  fi
done

echo "lint-prompt-closeout: checked=$checked errors=$errors warnings=$warnings"
[ "$errors" -eq 0 ]
