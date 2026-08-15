#!/usr/bin/env bash
# Zero-LLM MEASURE path for cloud-sync-health-fix.
#
# Root cause this avoids: overnight ×3 exit-124 (45m harness kill) with no
# metrics when the LLM digresses or blocks under interactive_busy load.
#
# Intended as gate_command for registry id cloud-sync-health-fix:
#   gate_command = "routines-cloud-sync-health-fix-gate"
#   # or: gate_command = "bash /path/to/scripts/cloud-sync-health-fix-gate.sh"
#   timeout_min  = 15   # gate wall-clock is capped at 15m by the runner
#
# Exit codes (routines gate contract):
#   0  — skip harness; ROUTINE_RESULT outcome=ok|noop already printed
#   10 — proceed to LLM harness (true fix lane only)
#   1  — hard error with ROUTINE_RESULT outcome=error
#
# Hard wall-clock: every probe is timeboxed; on probe timeout we flush
# outcome=timeout_partial (exit 0) so operators still get a signal.
set -euo pipefail

ROUTINE_ID="cloud-sync-health-fix"
last_stack="${LAST_STACK_ROOT:-$HOME/.last-stack}"
export PATH="${HOME}/.local/bin:${last_stack}/bin:${PATH}"

started_epoch="$(date +%s)"
iso_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_id="${ROUTINES_RUN_ID:-}"
run_dir="${ROUTINES_RUN_DIR:-}"

# Outer budget for the whole gate body (seconds). Runner also caps gates at 15m.
OUTER_TIMEOUT_SEC="${CLOUD_SYNC_HEALTH_FIX_OUTER_TIMEOUT_SEC:-600}"
STATUS_TIMEOUT_SEC="${CLOUD_SYNC_HEALTH_FIX_STATUS_TIMEOUT_SEC:-90}"
NOTICES_TIMEOUT_SEC="${CLOUD_SYNC_HEALTH_FIX_NOTICES_TIMEOUT_SEC:-30}"
# If remaining wall clock drops below this, flush partial and exit 0.
RESERVE_SEC="${CLOUD_SYNC_HEALTH_FIX_RESERVE_SEC:-30}"

timeout_bin=""
if command -v gtimeout >/dev/null 2>&1; then
  timeout_bin="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  timeout_bin="timeout"
fi

elapsed() { echo $(( $(date +%s) - started_epoch )); }
remaining() {
  local e
  e="$(elapsed)"
  echo $(( OUTER_TIMEOUT_SEC - e ))
}

run_with_timeout() {
  # usage: run_with_timeout <seconds> <cmd...>
  local secs="$1"
  shift
  local rem
  rem="$(remaining)"
  if [ "$rem" -lt "$RESERVE_SEC" ]; then
    return 124
  fi
  if [ "$secs" -gt "$rem" ]; then
    secs="$rem"
  fi
  if [ "$secs" -lt 1 ]; then
    return 124
  fi
  if [ -n "$timeout_bin" ]; then
    "$timeout_bin" -k 5s "${secs}s" "$@"
  else
    "$@"
  fi
}

append_heartbeat() {
  local kind="$1"
  local detail="$2"
  local line="${ROUTINE_ID} ${iso_ts} outcome=${kind} ${detail}"
  if [ -n "$run_id" ]; then
    line="${line} run=${run_id}"
  fi
  if [ -x "$last_stack/bin/last-stack-brain-append-heartbeat" ]; then
    "$last_stack/bin/last-stack-brain-append-heartbeat" --line "$line" 2>/dev/null || true
  fi
  # Always echo so run logs retain metrics even when the helper is absent.
  printf '%s\n' "$line"
}

hb_line() {
  local kind="$1"
  local detail="$2"
  append_heartbeat "$kind" "$detail"
  # Machine trailer for routinesd outcome classifier (skip-harness path).
  printf '%s %s\n' 'ROUTINE_RESULT' "outcome=${kind} detail=${detail}"
}

flush_timeout_partial() {
  local why="$1"
  local partial="${2:-}"
  local detail="timeout_partial reason=${why} elapsed=$(elapsed)s outer=${OUTER_TIMEOUT_SEC}s"
  if [ -n "$partial" ]; then
    detail="${detail} ${partial}"
  fi
  # timeout_partial is a successful bounded observe (not a fleet error).
  hb_line ok "$detail"
  exit 0
}

# --- budget check before any probe ---
if [ "$(remaining)" -lt "$RESERVE_SEC" ]; then
  flush_timeout_partial "budget-exhausted-before-probe"
fi

# Fixture / dry path: inject status text without calling lastdb.
status_text=""
status_rc=0
if [ -n "${CLOUD_SYNC_HEALTH_FIX_STATUS_FILE:-}" ] && [ -f "$CLOUD_SYNC_HEALTH_FIX_STATUS_FILE" ]; then
  status_text="$(cat "$CLOUD_SYNC_HEALTH_FIX_STATUS_FILE")"
  status_rc=0
elif [ -n "${CLOUD_SYNC_HEALTH_FIX_STATUS_TEXT:-}" ]; then
  status_text="$CLOUD_SYNC_HEALTH_FIX_STATUS_TEXT"
  status_rc=0
else
  set +e
  status_text="$(run_with_timeout "$STATUS_TIMEOUT_SEC" lastdb status 2>&1)"
  status_rc=$?
  set -e
fi

if [ "$status_rc" -eq 124 ] || [ "$status_rc" -eq 137 ]; then
  flush_timeout_partial "status-probe-timeout" "status_rc=${status_rc}"
fi

if [ -n "$run_dir" ]; then
  mkdir -p "$run_dir" 2>/dev/null || true
  printf '%s\n' "$status_text" >"$run_dir/lastdb-status.txt" 2>/dev/null || true
fi

# Parse key fields from `lastdb status` human output (best-effort, stable keys).
# Example Sync line:
#   Sync: state=Dirty staging=0/100000 upload_queue=0/1024 ... degraded=true ...
#         last_success=1786807618 ... degraded_reasons=mutation_log_lag,capture_reexport_pending
extract() {
  # extract key=value token; first match
  local key="$1"
  printf '%s\n' "$status_text" | tr ' ' '\n' | sed -n "s/^${key}=//p" | head -1 | tr -d '\r'
}

degraded="$(extract degraded)"
staging="$(extract staging)"
upload_queue="$(extract upload_queue)"
last_success="$(extract last_success)"
degraded_reasons="$(extract degraded_reasons)"
throttle_reason="$(extract throttle_reason)"
# Build line: "Build:  0.23.3-630-g… (daemon and CLI agree)"
build="$(printf '%s\n' "$status_text" | sed -n 's/^Build:[[:space:]]*//p' | head -1 | awk '{print $1}')"
# Memory RSS snippet
rss="$(printf '%s\n' "$status_text" | sed -n 's/.*RSS \([0-9.]* GiB\) of \([0-9.]* GiB\).*/\1\/\2/p' | head -1)"
# Backup durability line
backup_line="$(printf '%s\n' "$status_text" | sed -n 's/^Backup durability:[[:space:]]*//p' | head -1 | tr ' ' '_' | cut -c1-80)"
pid="$(printf '%s\n' "$status_text" | sed -n 's/.*pid \([0-9][0-9]*\).*/\1/p' | head -1)"

# Defaults when status missing keys
degraded="${degraded:-unknown}"
staging="${staging:-?}"
upload_queue="${upload_queue:-?}"
last_success="${last_success:-unknown}"
degraded_reasons="${degraded_reasons:-}"
throttle_reason="${throttle_reason:-none}"
build="${build:-unknown}"
rss="${rss:-unknown}"
backup_line="${backup_line:-unknown}"
pid="${pid:-unknown}"

# Empty status / probe failure (non-timeout)
if [ -z "$status_text" ] || [ "$status_rc" -ne 0 ]; then
  detail="status_probe_failed status_rc=${status_rc} elapsed=$(elapsed)s"
  hb_line error "$detail"
  exit 1
fi

# Safe-upgrade / cutover notice (best-effort, short timeout).
notices_text=""
safe_upgrade_inflight=0
if [ "$(remaining)" -ge "$RESERVE_SEC" ]; then
  set +e
  notices_text="$(run_with_timeout "$NOTICES_TIMEOUT_SEC" situations notices --since 30m 2>/dev/null || true)"
  notices_rc=$?
  set -e
  if [ "${notices_rc:-0}" -eq 124 ] || [ "${notices_rc:-0}" -eq 137 ]; then
    # Do not fail the whole observe on notices timeout — continue with status metrics.
    notices_text=""
  fi
  case "$notices_text" in
    *safe-upgrade*|*lastdb-safe-upgrade*|*cutover*|*primary*restart*)
      safe_upgrade_inflight=1
      ;;
  esac
fi

# Staging fill ratio (staging=N/CAP)
staging_n=0
staging_cap=1
case "$staging" in
  */*)
    staging_n="${staging%%/*}"
    staging_cap="${staging##*/}"
    ;;
esac
staging_pct=0
if [ "${staging_cap:-0}" -gt 0 ] 2>/dev/null; then
  staging_pct=$(( staging_n * 100 / staging_cap ))
fi

metrics="staging=${staging} upload_queue=${upload_queue} degraded=${degraded} degraded_reasons=${degraded_reasons:-none} last_success=${last_success} throttle=${throttle_reason} backup=${backup_line} build=${build} rss=${rss} pid=${pid} elapsed=$(elapsed)s safe_upgrade_inflight=${safe_upgrade_inflight}"

# --- decision ---
# Healthy: degraded=false → skip harness.
if [ "$degraded" = "false" ]; then
  hb_line ok "healthy ${metrics} action=observe_no_deploy"
  exit 0
fi

# Mid-cutover: never stack deploys.
if [ "$safe_upgrade_inflight" -eq 1 ]; then
  hb_line ok "observe_safe_upgrade_inflight not_healthy ${metrics} action=observe_no_deploy"
  exit 0
fi

# Known soft/degraded reasons under load → observe only (this is the overnight
# digression path that burned 3×45m exit 124 with zero metrics).
soft=0
case ",${degraded_reasons}," in
  *,mutation_log_lag,*|*,capture_reexport_pending,*|*,slow_network,*|*,interactive_busy,*)
    soft=1
    ;;
esac
case "$throttle_reason" in
  interactive_busy*|slow_network*|auto*)
    soft=1
    ;;
esac

# Hard signals that still need the LLM fix lane.
hard=0
case ",${degraded_reasons}," in
  *auth*|*credential*|*403*|*401*|*429*|*quota*|*forbidden*|*unauthorized*)
    hard=1
    ;;
esac
if [ "$staging_pct" -ge 50 ] 2>/dev/null; then
  hard=1
fi
if [ "$last_success" = "never" ] || [ "$last_success" = "0" ]; then
  hard=1
fi

# Force observe for soak/dry runs.
if [ "${CLOUD_SYNC_HEALTH_FIX_FORCE_OBSERVE:-0}" = "1" ]; then
  hard=0
  soft=1
fi
# Force proceed (tests).
if [ "${CLOUD_SYNC_HEALTH_FIX_FORCE_PROCEED:-0}" = "1" ]; then
  hard=1
fi

if [ "$hard" -eq 1 ]; then
  # Metrics first so a later harness exit-124 still leaves an operator signal.
  # No ROUTINE_RESULT trailer here — exit 10 means proceed to harness.
  append_heartbeat ok "proceed_fix_lane not_healthy ${metrics} action=gate_proceed"
  printf '%s\n' "CLOUD_SYNC_HEALTH_FIX_GATE proceed hard_signal=1 staging_pct=${staging_pct}"
  exit 10
fi

# Default: degraded but soft / unknown under load → observe and skip harness.
# Prefer structured observe over empty exit-124.
hb_line ok "observe not_healthy soft=${soft} ${metrics} action=observe_no_deploy"
exit 0
