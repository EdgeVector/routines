#!/usr/bin/env bash
# routines MVP end-to-end: exercise the FULL dispatch path (registry -> rrule ->
# fence -> spawn -> run log -> heartbeat) for BOTH harness adapters, plus the
# run-now command and the Situation fence — all against a throwaway
# ROUTINES_HOME, never the real registry or brain.
#
# The leaf harness/fsituations/fbrain binaries are stubbed via env overrides so
# the e2e is hermetic and spends no API credits, while every line of code
# routines itself owns is executed for real.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
run() { bun "$ROOT/src/cli.ts" "$@"; }

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/routines-e2e.XXXXXX")"
export ROUTINES_HOME="$HOME_DIR"
trap 'rm -rf "$HOME_DIR"' EXIT

echo "== routines e2e =="
echo "ROUTINES_HOME=$ROUTINES_HOME"

# --- stub leaf binaries -------------------------------------------------
STUB_HARNESS="$HOME_DIR/stub-harness"
cat > "$STUB_HARNESS" <<'SH'
#!/bin/sh
echo "STUB-HARNESS ran: $*"
exit 0
SH
chmod +x "$STUB_HARNESS"
export ROUTINES_CLAUDE_BIN="$STUB_HARNESS"
export ROUTINES_CODEX_BIN="$STUB_HARNESS"

STUB_SIT="$HOME_DIR/stub-fsituations"
cat > "$STUB_SIT" <<'SH'
#!/bin/sh
cat <<'JSON'
[{"slug":"fold-db-node-dmg-temporary-deprecation","status":"active","scope_routines":["*dmg*","*desktop*","*fold-app*"]}]
JSON
SH
chmod +x "$STUB_SIT"
export ROUTINES_FSITUATIONS_BIN="$STUB_SIT"

HEARTBEATS="$HOME_DIR/heartbeats.log"
STUB_FBRAIN="$HOME_DIR/stub-fbrain"
cat > "$STUB_FBRAIN" <<SH
#!/bin/sh
# args: append <slug> --text <line>
printf '%s\n' "\$4" >> "$HEARTBEATS"
exit 0
SH
chmod +x "$STUB_FBRAIN"
export ROUTINES_FBRAIN_BIN="$STUB_FBRAIN"

# --- register routines --------------------------------------------------
mkdir -p "$HOME_DIR/registry"
PROMPT_FILE="$HOME_DIR/disk-reclaim.md"
echo "Run one bounded disk-reclaim pass. (e2e prompt)" > "$PROMPT_FILE"

cat > "$HOME_DIR/registry/e2e-disk-reclaim-claude.toml" <<TOML
harness = "claude"
model = "claude-opus-4-8"
rrule = "FREQ=SECONDLY"
prompt_path = "$PROMPT_FILE"
cwd = "$HOME_DIR"
heartbeat_slug = "routine-heartbeats"
timeout_min = 5
TOML

cat > "$HOME_DIR/registry/e2e-disk-reclaim-codex.toml" <<TOML
harness = "codex"
model = "gpt-5.5"
effort = "medium"
rrule = "FREQ=SECONDLY"
prompt_path = "$PROMPT_FILE"
cwd = "$HOME_DIR"
heartbeat_slug = "routine-heartbeats"
timeout_min = 5
TOML

# a routine whose id matches the active Situation's scope_routines glob
cat > "$HOME_DIR/registry/e2e-desktop-dogfood.toml" <<TOML
harness = "claude"
model = "claude-opus-4-8"
rrule = "FREQ=SECONDLY"
prompt = "should be fenced"
cwd = "$HOME_DIR"
timeout_min = 5
TOML

echo
echo "-- routines doctor --"
run doctor || true

echo
echo "-- routines list --"
run list

# --- 1. daemon fires BOTH adapters in one pass --------------------------
echo
echo "-- routinesd --once (fires due routines) --"
DAEMON_ERR="$HOME_DIR/daemon.err"
run daemon --once --catchup 60 2>"$DAEMON_ERR" || true
cat "$DAEMON_ERR"

fail() { echo "E2E FAIL: $1" >&2; exit 1; }

CLAUDE_RUN="$HOME_DIR/runs/e2e-disk-reclaim-claude"
CODEX_RUN="$HOME_DIR/runs/e2e-disk-reclaim-codex"
[ -d "$CLAUDE_RUN" ] || fail "claude routine did not fire"
[ -d "$CODEX_RUN" ]  || fail "codex routine did not fire"

CLAUDE_LOG="$(run logs e2e-disk-reclaim-claude --path)"
CODEX_LOG="$(run logs e2e-disk-reclaim-codex --path)"
grep -q "STUB-HARNESS ran" "$CLAUDE_LOG/stdout.log" || fail "no claude run output"
grep -q "STUB-HARNESS ran" "$CODEX_LOG/stdout.log"  || fail "no codex run output"
grep -q '"exitCode": 0' "$CLAUDE_LOG/meta.json" || fail "claude run non-zero exit"
grep -q '"exitCode": 0' "$CODEX_LOG/meta.json"  || fail "codex run non-zero exit"

# --- 2. Situation fence skip logged, fenced routine did NOT run ----------
grep -q '"kind":"skip-fence","id":"e2e-desktop-dogfood"' "$DAEMON_ERR" || fail "fence skip not logged"
[ -d "$HOME_DIR/runs/e2e-desktop-dogfood" ] && fail "fenced routine should not have run" || true

# --- 3. heartbeats written (one line per successful run) ----------------
[ -f "$HEARTBEATS" ] || fail "no heartbeats written"
HB_COUNT="$(wc -l < "$HEARTBEATS" | tr -d ' ')"
[ "$HB_COUNT" -ge 2 ] || fail "expected >=2 heartbeat lines, got $HB_COUNT"

# --- 4. run-now works for both harnesses --------------------------------
echo
echo "-- routines run (run-now) for both harnesses --"
run run e2e-disk-reclaim-claude --quiet
run run e2e-disk-reclaim-codex --quiet

# --- 5. launchd plist renders and is well-formed ------------------------
echo
echo "-- launchd plist render --"
run print-plist > "$HOME_DIR/routinesd.plist"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$HOME_DIR/routinesd.plist" || fail "plist failed plutil lint"
fi
grep -q "com.edgevector.routinesd" "$HOME_DIR/routinesd.plist" || fail "plist missing label"

echo
echo "== E2E PASS =="
echo "claude run log: $CLAUDE_LOG"
echo "codex  run log: $CODEX_LOG"
echo "heartbeats:     $HEARTBEATS ($HB_COUNT lines)"
