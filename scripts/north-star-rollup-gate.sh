#!/usr/bin/env bash
# Zero-LLM north-star-rollup work unit.
#
# Intended as gate_command for last-stack-north-star-rollup so an LLM harness
# is not required to regenerate the dashboard. Exit 0 with ROUTINE_RESULT
# outcome=ok|noop (never exit 10 — this gate *is* the work).
#
# Registry example (after this script is on PATH or absolute):
#   gate_command = "bash /path/to/scripts/north-star-rollup-gate.sh"
#   timeout_min  = 20
#
# Root causes this avoids:
#   1) LLM first-yield / incomplete shell → false dashboard-script-crash
#   2) Default 30s per dashboard subprocess under board load (kanban list --all)
set -euo pipefail

last_stack="${LAST_STACK_ROOT:-$HOME/.last-stack}"
export PATH="${HOME}/.local/bin:${last_stack}/bin:${PATH}"

# Raise per-command timeout for last-stack-north-star-dashboard (default 30s).
export LAST_STACK_NORTH_STAR_DASHBOARD_CMD_TIMEOUT="${LAST_STACK_NORTH_STAR_DASHBOARD_CMD_TIMEOUT:-120}"

html_path="${NORTH_STAR_DASHBOARD_HTML:-$HOME/code/edgevector/north-star-dashboard.html}"
dash_bin="${NORTH_STAR_DASHBOARD_BIN:-}"
if [ -z "$dash_bin" ]; then
  if [ -x "$last_stack/bin/last-stack-north-star-dashboard" ]; then
    dash_bin="$last_stack/bin/last-stack-north-star-dashboard"
  elif command -v last-stack-north-star-dashboard >/dev/null 2>&1; then
    dash_bin="$(command -v last-stack-north-star-dashboard)"
  else
    iso_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    detail="reason=dashboard-binary-missing path=$last_stack/bin/last-stack-north-star-dashboard"
    if [ -x "$last_stack/bin/last-stack-brain-append-heartbeat" ]; then
      "$last_stack/bin/last-stack-brain-append-heartbeat" --line \
        "north-star-rollup $iso_ts error $detail" 2>/dev/null || true
    fi
    printf '%s %s\n' 'ROUTINE_RESULT' "outcome=error detail=$detail"
    exit 1
  fi
fi

iso_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_dir="${ROUTINES_RUN_DIR:-}"
if [ -n "$run_dir" ]; then
  mkdir -p "$run_dir"
fi

prior_html_bytes=0
if [ -f "$html_path" ]; then
  prior_html_bytes="$(wc -c <"$html_path" | tr -d ' ')"
fi

# Capture prior generated stamp when brain is available (best-effort).
prior_generated=""
if command -v brain >/dev/null 2>&1; then
  prior_out="$(brain get north-star-dashboard --type reference 2>/dev/null || true)"
  prior_generated="$(
    printf '%s\n' "$prior_out" |
      sed -n 's/^Generated:[[:space:]]*//p; s/^\*\*Generated:\*\*[[:space:]]*`\([^`]*\)`.*/\1/p; s/.*Generated[[:space:]]*`\([^`]*\)`.*/\1/p' |
      head -1 |
      tr -d '\r'
  )"
fi

timeout_bin=""
if command -v gtimeout >/dev/null 2>&1; then
  timeout_bin="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  timeout_bin="timeout"
fi

outer_timeout_sec="${NORTH_STAR_ROLLUP_OUTER_TIMEOUT_SEC:-600}"
dash_stdout="${run_dir:+$run_dir/dashboard.stdout}"
dash_stderr="${run_dir:+$run_dir/dashboard.stderr}"
dash_stdout="${dash_stdout:-/tmp/north-star-rollup-dashboard.stdout}"
dash_stderr="${dash_stderr:-/tmp/north-star-rollup-dashboard.stderr}"
: >"$dash_stdout"
: >"$dash_stderr"

set +e
if [ -n "$timeout_bin" ]; then
  "$timeout_bin" -k 30s "${outer_timeout_sec}s" \
    "$dash_bin" --put-brain --html "$html_path" --stdout none \
    >"$dash_stdout" 2>"$dash_stderr"
  dash_rc=$?
else
  "$dash_bin" --put-brain --html "$html_path" --stdout none \
    >"$dash_stdout" 2>"$dash_stderr"
  dash_rc=$?
fi
set -e

err_tail="$(tail -c 2000 "$dash_stderr" 2>/dev/null || true)"
out_tail="$(tail -c 500 "$dash_stdout" 2>/dev/null || true)"
combined="$err_tail"$'\n'"$out_tail"

html_bytes=0
if [ -f "$html_path" ]; then
  html_bytes="$(wc -c <"$html_path" | tr -d ' ')"
fi

has_prior_snapshot=0
if [ "${prior_html_bytes:-0}" -gt 0 ] || [ -n "${prior_generated:-}" ]; then
  has_prior_snapshot=1
fi

is_busy=0
case "$combined" in
  *service_timeout*|*too\ many\ concurrent\ reads*|*node\ did\ not\ respond*|*uds_connection_limit*|*busy-node*)
    is_busy=1
    ;;
esac

is_cmd_timeout=0
if [ "$dash_rc" -eq 124 ] || [ "$dash_rc" -eq 137 ]; then
  is_cmd_timeout=1
fi
case "$combined" in
  *command\ timed\ out*|*timed\ out\ after*)
    is_cmd_timeout=1
    ;;
esac

# Confirm generated stamp after a claimed success.
generated=""
if [ "$dash_rc" -eq 0 ] && command -v brain >/dev/null 2>&1; then
  current_out="$(brain get north-star-dashboard --type reference 2>/dev/null || true)"
  generated="$(
    printf '%s\n' "$current_out" |
      sed -n 's/^Generated:[[:space:]]*//p; s/^\*\*Generated:\*\*[[:space:]]*`\([^`]*\)`.*/\1/p; s/.*Generated[[:space:]]*`\([^`]*\)`.*/\1/p' |
      head -1 |
      tr -d '\r'
  )"
fi

# Also parse HTML generated stamp as fallback confirmation.
if [ -z "$generated" ] && [ -f "$html_path" ]; then
  generated="$(
    sed -n 's/.*Generated[[:space:]]*<code>\([^<]*\)<\/code>.*/\1/p; s/.*Generated[[:space:]]*`\([^`]*\)`.*/\1/p' \
      "$html_path" 2>/dev/null | head -1
  )"
fi

iso_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Fresh stamp: same UTC hour or today's date prefix.
hour_stamp="$(date -u +%Y-%m-%dT%H)"
day_stamp="$(date -u +%Y-%m-%d)"
fresh=0
case "$generated" in
  ${hour_stamp}*) fresh=1 ;;
  ${day_stamp}*) fresh=1 ;;
esac

hb() {
  local kind="$1"
  local detail="$2"
  if [ -x "$last_stack/bin/last-stack-brain-append-heartbeat" ]; then
    "$last_stack/bin/last-stack-brain-append-heartbeat" --line \
      "north-star-rollup $iso_now $kind $detail" 2>/dev/null || true
  fi
  printf '%s %s\n' 'ROUTINE_RESULT' "outcome=$kind detail=$detail"
}

if [ "$dash_rc" -eq 0 ] && [ "$fresh" -eq 1 ] && [ "$html_bytes" -gt 0 ]; then
  # Best-effort pressure summary from stderr of a successful HTML write.
  detail="generated=$generated html=$html_path bytes=$html_bytes"
  # Prefer any active_ns line the binary printed.
  if printf '%s\n' "$combined" | grep -q 'active_ns='; then
    detail="$(printf '%s\n' "$combined" | tr '\n' ' ' | sed -n 's/.*\(active_ns=[^ ]*\).*/\1/p' | head -1) $detail"
  fi
  hb ok "$detail"
  exit 0
fi

# Transient load / timeout with durable prior snapshot → noop (not fleet error).
if [ "$has_prior_snapshot" -eq 1 ] && { [ "$is_cmd_timeout" -eq 1 ] || [ "$is_busy" -eq 1 ]; }; then
  reason="dashboard-timeout-prior-snapshot"
  if [ "$is_busy" -eq 1 ]; then
    reason="busy-node"
  fi
  detail="reason=$reason previous_generated=${prior_generated:-unknown} previous_html_bytes=$prior_html_bytes html=$html_path"
  hb noop "$detail"
  exit 0
fi

# Real failure: crash without usable prior, empty HTML, or non-timeout error.
if [ "$has_prior_snapshot" -eq 1 ]; then
  detail="reason=dashboard-script-crash-prior-snapshot-retained previous_generated=${prior_generated:-unknown} html=$html_path bytes=$html_bytes dash_rc=$dash_rc"
  # Still retain snapshot; mark error so operators see the failed regenerate.
  hb error "$detail"
  # Exit 0 so gate does not double-classify as gate-command-failed; outcome is error.
  exit 0
fi

detail="reason=dashboard-script-crash dash_rc=$dash_rc html=$html_path"
hb error "$detail"
exit 1
