#!/usr/bin/env bash
# routines cutover — pause the two LEGACY schedulers so `routines` becomes the
# SOLE scheduler. One-time migration; reversible.
#
#   ⚠️  This is a PROD CUTOVER of shared scheduling infrastructure. It pauses the
#       live Codex crons and disables the live Claude scheduled tasks — including
#       the fkanban-pickup / fleet routines. Do NOT run --apply unattended. A
#       human runs it, witnesses the 24h sole-scheduler validation, and keeps the
#       rollback manifest.
#
# What it does (against the exact LIVE set that `routines import` would import):
#   - Codex:  flips `status = "ACTIVE"` -> `status = "PAUSED"` in each
#             ~/.codex/automations/<id>/automation.toml.
#   - Claude: sets `enabled=false` for each task id in the Claude scheduler's
#             scheduled-tasks.json (backup taken first).
#   - Writes a rollback manifest (every entry + its prior status) to the run log,
#             ALWAYS — even in dry-run — so the rollback list exists up front.
#
# Modes:
#   (default)     DRY-RUN: print the plan + write the rollback manifest, mutate
#                 nothing.
#   --apply       perform the pause/disable edits.
#   --restore F   reverse a previous cutover using rollback manifest F.
#
# The Claude scheduler holds scheduled-tasks.json in memory and rewrites it on
# every fire, so editing it live gets clobbered (see the legacy
# _archived/purge-disabled.sh). --apply therefore REFUSES to touch the Claude
# registry while a Claude scheduler process is running; quit Claude first.
set -euo pipefail

MODE="dry-run"
RESTORE_FILE=""
ROUTINES_BIN="${ROUTINES_BIN:-}"
LOG_DIR="${ROUTINES_HOME:-$HOME/.routines}/cutover"

usage() {
  sed -n '2,40p' "$0"
  echo
  echo "usage: scripts/cutover.sh [--apply | --restore <manifest.json>] [--log-dir DIR]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE="apply" ;;
    --restore) MODE="restore"; shift; RESTORE_FILE="${1:-}" ;;
    --log-dir) shift; LOG_DIR="${1:-}" ;;
    --routines-bin) shift; ROUTINES_BIN="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

command -v jq >/dev/null 2>&1 || { echo "cutover: jq is required" >&2; exit 1; }

# Resolve the routines CLI: explicit ROUTINES_BIN, else `routines` on PATH, else
# `bun src/cli.ts` from the repo root.
run_routines() {
  if [ -n "$ROUTINES_BIN" ]; then
    # shellcheck disable=SC2086
    $ROUTINES_BIN "$@"
  elif command -v routines >/dev/null 2>&1; then
    routines "$@"
  else
    ( cd "$(dirname "$0")/.." && bun src/cli.ts "$@" )
  fi
}

TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"

# ---- restore mode ---------------------------------------------------------
if [ "$MODE" = "restore" ]; then
  [ -n "$RESTORE_FILE" ] && [ -f "$RESTORE_FILE" ] || { echo "cutover --restore: manifest not found: $RESTORE_FILE" >&2; exit 1; }
  echo "cutover: RESTORE from $RESTORE_FILE"
  # Codex: write back prior status per file.
  jq -r '.targets[] | select(.source=="codex") | [.sourcePath, .priorStatus] | @tsv' "$RESTORE_FILE" \
  | while IFS="$(printf '\t')" read -r path prior; do
      [ -f "$path" ] || { echo "  skip (missing): $path" >&2; continue; }
      sed -i '' -E "s/^status = \".*\"$/status = \"${prior}\"/" "$path"
      echo "  codex restored $path -> $prior"
    done
  # Claude: restore prior enabled per id in the shared registry.
  CLAUDE_REG="$(jq -r '[.targets[] | select(.source=="claude") | .sourcePath] | first // empty' "$RESTORE_FILE")"
  if [ -n "$CLAUDE_REG" ] && [ -f "$CLAUDE_REG" ]; then
    cp "$CLAUDE_REG" "$CLAUDE_REG.bak-restore-$TS"
    TMP="$(mktemp)"
    jq --argjson ids "$(jq '[.targets[] | select(.source=="claude") | {(.id): .priorEnabled}] | add // {}' "$RESTORE_FILE")" \
       '.scheduledTasks |= map(if ($ids[.id] != null) then .enabled = $ids[.id] else . end)' \
       "$CLAUDE_REG" > "$TMP" && mv "$TMP" "$CLAUDE_REG"
    echo "  claude registry restored: $CLAUDE_REG (backup $CLAUDE_REG.bak-restore-$TS)"
  fi
  echo "cutover: restore complete."
  exit 0
fi

# ---- build the pause set + rollback manifest ------------------------------
PLAN="$(run_routines import --json)"
MANIFEST="$LOG_DIR/cutover-rollback-$TS.json"

# Capture each live target's CURRENT status/enabled BEFORE any edit.
echo "$PLAN" | jq -r '.pauseTargets[] | [.id, .source, .sourcePath] | @tsv' > "$LOG_DIR/.targets-$TS.tsv"

{
  echo '{'
  echo "  \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo '  "targets": ['
  first=1
  while IFS="$(printf '\t')" read -r id source path; do
    [ -n "$id" ] || continue
    if [ "$source" = "codex" ]; then
      prior="$(grep -m1 '^status = ' "$path" 2>/dev/null | sed 's/^status = "//; s/"$//')"
      prior="${prior:-UNKNOWN}"
      row="{\"id\":$(jq -Rn --arg v "$id" '$v'),\"source\":\"codex\",\"sourcePath\":$(jq -Rn --arg v "$path" '$v'),\"priorStatus\":\"$prior\"}"
    else
      prior="$(jq --arg id "$id" '.scheduledTasks[] | select(.id==$id) | .enabled' "$path" 2>/dev/null | head -1)"
      prior="${prior:-true}"
      row="{\"id\":$(jq -Rn --arg v "$id" '$v'),\"source\":\"claude\",\"sourcePath\":$(jq -Rn --arg v "$path" '$v'),\"priorEnabled\":$prior}"
    fi
    if [ "$first" = 1 ]; then first=0; else echo ','; fi
    printf '    %s' "$row"
  done < "$LOG_DIR/.targets-$TS.tsv"
  echo
  echo '  ]'
  echo '}'
} > "$MANIFEST"
rm -f "$LOG_DIR/.targets-$TS.tsv"

CODEX_N="$(jq '[.targets[] | select(.source=="codex")] | length' "$MANIFEST")"
CLAUDE_N="$(jq '[.targets[] | select(.source=="claude")] | length' "$MANIFEST")"
echo "cutover: $CODEX_N codex automation(s) + $CLAUDE_N claude task(s) to pause."
echo "cutover: rollback manifest -> $MANIFEST"

if [ "$MODE" = "dry-run" ]; then
  echo
  echo "DRY-RUN. Would pause:"
  jq -r '.targets[] | "  [\(.source)] \(.id)"' "$MANIFEST"
  echo
  echo "Re-run with --apply to perform the cutover (quit Claude first)."
  echo "Reverse later with: scripts/cutover.sh --restore $MANIFEST"
  exit 0
fi

# ---- apply ----------------------------------------------------------------
# Refuse to edit the Claude registry while its scheduler is live.
# Match the Desktop app only — NOT ~/.claude/* MCP servers or the `claude` CLI
# (pgrep -f "Claude" false-positives on those and blocks a valid cutover).
if [ "$CLAUDE_N" -gt 0 ]; then
  if pgrep -f "/Applications/Claude\\.app/" >/dev/null 2>&1; then
    echo "cutover --apply: Claude Desktop is running; its scheduler will clobber edits to" >&2
    echo "  scheduled-tasks.json. Quit Claude fully, then re-run --apply." >&2
    echo "  (Codex automations were NOT modified.)" >&2
    exit 3
  fi
fi

# Codex: flip ACTIVE -> PAUSED (line-anchored; never touches the prompt line).
jq -r '.targets[] | select(.source=="codex") | .sourcePath' "$MANIFEST" \
| while IFS= read -r path; do
    [ -f "$path" ] || { echo "  skip (missing): $path" >&2; continue; }
    sed -i '' -E 's/^status = "ACTIVE"$/status = "PAUSED"/' "$path"
    echo "  codex paused: $path"
  done

# Claude: set enabled=false for every target id in the shared registry.
if [ "$CLAUDE_N" -gt 0 ]; then
  CLAUDE_REG="$(jq -r '[.targets[] | select(.source=="claude") | .sourcePath] | first' "$MANIFEST")"
  if [ -f "$CLAUDE_REG" ]; then
    cp "$CLAUDE_REG" "$CLAUDE_REG.bak-cutover-$TS"
    TMP="$(mktemp)"
    jq --argjson ids "$(jq '[.targets[] | select(.source=="claude") | .id]' "$MANIFEST")" \
       '.scheduledTasks |= map(if (.id as $i | $ids | index($i)) then .enabled = false else . end)' \
       "$CLAUDE_REG" > "$TMP" && mv "$TMP" "$CLAUDE_REG"
    echo "  claude disabled $CLAUDE_N task(s) in $CLAUDE_REG (backup $CLAUDE_REG.bak-cutover-$TS)"
  fi
fi

echo
echo "cutover: APPLIED. routines is now the sole scheduler."
echo "cutover: validate 24h of fires, then keep the rollback manifest: $MANIFEST"
echo "cutover: reverse with: scripts/cutover.sh --restore $MANIFEST"
