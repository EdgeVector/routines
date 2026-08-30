#!/usr/bin/env bash
# Zero-LLM LastDB real-data smoke work unit.
#
# Intended as gate_command for lastdb-local-smoke-test. It is deliberately
# build-free: scheduled smoke runs resolve a staged lastdbd and either produce
# a bounded GREEN/RED verdict or stop with a classified noop. Cargo belongs to
# lastdb-canary-build-main, never to this gate.
set -euo pipefail

last_stack="${LAST_STACK_ROOT:-$HOME/.last-stack}"
export PATH="$HOME/.local/bin:$last_stack/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-}"

run_dir="${ROUTINES_RUN_DIR:-}"
if [ -n "$run_dir" ]; then
  mkdir -p "$run_dir"
fi

resolver="${LASTDB_LOCAL_SMOKE_RESOLVER:-$last_stack/bin/last-stack-canary-resolve-lastdbd}"
smoke_script="${LASTDB_LOCAL_SMOKE_SCRIPT:-$HOME/code/edgevector/.claude/run-lastdb-mini-smoke.sh}"
heartbeat_bin="${LASTDB_LOCAL_SMOKE_HEARTBEAT_BIN:-$last_stack/bin/last-stack-brain-append-heartbeat}"
brain_bin="${LASTDB_LOCAL_SMOKE_BRAIN_BIN:-$(command -v brain 2>/dev/null || true)}"
resolver_timeout_sec="${LASTDB_LOCAL_SMOKE_RESOLVER_TIMEOUT_SEC:-90}"
# 720s was under-budget from the day it landed (2026-08-20). The gate spends
# almost all of its wall clock on two phases that test nothing: the CoW clone
# of ~/.lastdb and the rm -rf of that clone. Both scale with database size.
# Timed end-to-end on the primary 2026-08-27, the smoke returned VERDICT: GREEN
# in 751s: clone 283s, boot+identity+schemas+Board query 22s, teardown 445s.
# A healthy candidate did not fit in 720s, so the gate reported a false RED on
# 7 of its last 10 runs. 1800s is 2.4x the measured GREEN run and still sits
# inside the routine's own timeout_min = 90 (5400s).
# papercut-lastdb-local-smoke-gate-720s-budget-reports-false-red
smoke_timeout_sec="${LASTDB_LOCAL_SMOKE_TIMEOUT_SEC:-1800}"
# The smoke verdict and the closeout report live in two different reliability
# domains: the verdict comes from an isolated CoW copy, the report is a write to
# the PRIMARY brain. The primary is briefly unwritable during a supervised
# restart or a full mutation capture queue, so retry the report write instead of
# letting one blip decide the routine outcome.
# routine-error-lastdb-local-smoke-test-closeout-false-negative-20260830
closeout_report_attempts="${LASTDB_LOCAL_SMOKE_CLOSEOUT_ATTEMPTS:-3}"
closeout_report_retry_sleep_sec="${LASTDB_LOCAL_SMOKE_CLOSEOUT_RETRY_SLEEP_SEC:-3}"

timeout_bin="${LASTDB_LOCAL_SMOKE_TIMEOUT_BIN:-}"
if [ -z "$timeout_bin" ]; then
  if command -v gtimeout >/dev/null 2>&1; then
    timeout_bin="$(command -v gtimeout)"
  elif command -v timeout >/dev/null 2>&1; then
    timeout_bin="$(command -v timeout)"
  fi
fi

iso_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

safe_token() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._:/=-' '_'
}

write_sink() {
  local kind="$1" detail="$2"
  if [ -n "$run_dir" ]; then
    printf '%s %s\n' "$kind" "$detail" >"$run_dir/outcome.txt"
  fi
}

heartbeat() {
  local kind="$1" detail="$2"
  if [ -x "$heartbeat_bin" ]; then
    "$heartbeat_bin" --line \
      "lastdb-local-smoke-test $(iso_now) $kind $detail" 2>/dev/null || true
  fi
}

finish() {
  local kind="$1" detail="$2" rc="${3:-0}"
  heartbeat "$kind" "$detail"
  write_sink "$kind" "$detail"
  printf '%s %s\n' 'ROUTINE_RESULT' "outcome=$kind detail=$detail"
  exit "$rc"
}

report_slug() {
  local seed="${ROUTINES_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
  seed="$(printf '%s' "$seed" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
  printf 'closeout-lastdb-local-smoke-%s\n' "$seed"
}

write_closeout_report() {
  local verdict="$1" detail="$2" log_path="$3"
  local slug report_file attempt
  [ -n "$brain_bin" ] && [ -x "$brain_bin" ] || return 1
  slug="$(report_slug)"
  report_file="${run_dir:+$run_dir/closeout.md}"
  report_file="${report_file:-${TMPDIR:-/tmp}/lastdb-local-smoke-closeout-$$.md}"
  {
    printf '%s\n' '---'
    printf '%s\n' 'type: reference'
    printf 'slug: %s\n' "$slug"
    printf 'title: Closeout — LastDB local real-data smoke %s\n' "$verdict"
    printf '%s\n' 'tags: [closeout, lastdb, smoke-test]'
    printf '%s\n\n' '---'
    printf '%s\n' '## What was done'
    printf 'Ran the build-free, bounded LastDB real-data CoW smoke gate. Verdict: %s.\n\n' "$verdict"
    printf '%s\n' '## Proof'
    printf '%s\n' "$detail"
    printf 'Sanitized smoke log: %s\n\n' "$log_path"
    printf '%s\n' '## Papercuts filed'
    printf '%s\n\n' '- none — the probe produced a classified product verdict; operational gate failures are surfaced by the routine outcome.'
    printf '%s\n' '## Leftovers'
    printf '%s\n' 'None beyond any blocker named by the verdict.'
  } >"$report_file"
  attempt=1
  while [ "$attempt" -le "$closeout_report_attempts" ]; do
    if "$brain_bin" put "$slug" --type reference <"$report_file" >/dev/null 2>&1 &&
      "$brain_bin" get "$slug" --type reference >/dev/null 2>&1; then
      return 0
    fi
    printf 'closeout-report write attempt %s/%s failed for %s\n' \
      "$attempt" "$closeout_report_attempts" "$slug" >&2
    attempt=$((attempt + 1))
    if [ "$attempt" -le "$closeout_report_attempts" ]; then
      sleep "$closeout_report_retry_sleep_sec"
    fi
  done
  return 1
}

if [ ! -x "$resolver" ]; then
  finish error "reason=resolver-missing path=$(safe_token "$resolver")" 1
fi
if [ ! -f "$smoke_script" ]; then
  finish error "reason=smoke-script-missing path=$(safe_token "$smoke_script")" 1
fi
if [ -z "$timeout_bin" ] || [ ! -x "$timeout_bin" ]; then
  finish noop "reason=no-command-timebox no_probe_started" 0
fi
if ! command -v jq >/dev/null 2>&1; then
  finish error "reason=jq-missing" 1
fi

resolver_err="${run_dir:+$run_dir/resolver.stderr}"
resolver_err="${resolver_err:-${TMPDIR:-/tmp}/lastdb-local-smoke-resolver-$$.stderr}"
set +e
resolver_json="$($timeout_bin -k 5s "${resolver_timeout_sec}s" \
  "$resolver" --json --allow-newest --allow-current 2>"$resolver_err")"
resolver_rc=$?
set -e
if [ "$resolver_rc" -eq 124 ] || [ "$resolver_rc" -eq 137 ]; then
  finish noop "reason=resolver-timeout seconds=$resolver_timeout_sec no_probe_started" 0
fi
if [ "$resolver_rc" -ne 0 ]; then
  finish error "reason=resolver-failed rc=$resolver_rc no_probe_started" 1
fi

resolver_status="$(printf '%s\n' "$resolver_json" | jq -r '.status // "error"' 2>/dev/null || true)"
wanted_oid="$(printf '%s\n' "$resolver_json" | jq -r '.wanted_oid // "unknown"' 2>/dev/null || true)"
resolved_oid="$(printf '%s\n' "$resolver_json" | jq -r '.resolved_oid // "unknown"' 2>/dev/null || true)"
source_kind="$(printf '%s\n' "$resolver_json" | jq -r '.source // "unknown"' 2>/dev/null || true)"
lastdbd_bin="$(printf '%s\n' "$resolver_json" | jq -r '.lastdbd // empty' 2>/dev/null || true)"
sha_drift="$(printf '%s\n' "$resolver_json" | jq -r '.sha_drift // false' 2>/dev/null || true)"

if [ "$resolver_status" = "need_build" ]; then
  finish noop "reason=no-staged-lastdbd sha=$(safe_token "$wanted_oid") no_probe_started" 0
fi
if [ "$resolver_status" != "ok" ] || [ -z "$lastdbd_bin" ] || [ ! -x "$lastdbd_bin" ]; then
  finish error "reason=resolver-invalid status=$(safe_token "$resolver_status") no_probe_started" 1
fi

# HR-N1: a probe must inherit the primary LaunchAgent's LASTDB_* tuning, while
# excluding home/data-dir variables that could point it back at live data.
env_file="${LASTDB_LOCAL_SMOKE_ENV_FILE:-}"
env_content=""
if [ -n "$env_file" ] && [ -s "$env_file" ]; then
  env_content="$(<"$env_file")"
else
  launchd_plist="${LASTDB_LAUNCHD_PLIST:-}"
  if [ -z "$launchd_plist" ]; then
    launchd_label="${LASTDB_LAUNCHD_LABEL:-}"
    if [ -z "$launchd_label" ]; then
      launchd_label="$(launchctl list 2>/dev/null | awk '{print $3}' | grep -E '\.lastdbd-primary(-[0-9]+)?$' | grep -v '^com\.REPLACE\.' | head -1 || true)"
    fi
    if [ -n "$launchd_label" ]; then
      launchd_plist="$HOME/Library/LaunchAgents/$launchd_label.plist"
    fi
  fi
  if [ -n "$launchd_plist" ] && [ -f "$launchd_plist" ]; then
    env_content="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables' "$launchd_plist" 2>/dev/null |
      awk -F' = ' '
        $1 ~ /^ *LASTDB_/ {
          key=$1; gsub(/^ +| +$/, "", key)
          if (key == "LASTDB_HOME" || key == "FOLDDB_HOME" || key == "LASTDB_DATA_DIR") next
          val=$2; gsub(/^ +| +$/, "", val)
          if (key != "" && val != "") print key "=" val
        }')"
  fi
fi
if [ -z "$env_content" ]; then
  finish noop "reason=primary-env-unavailable no_probe_started" 0
fi

env_pairs=()
while IFS= read -r pair; do
  case "$pair" in
    LASTDB_HOME=*|FOLDDB_HOME=*|LASTDB_DATA_DIR=*) ;;
    LASTDB_*=*) env_pairs+=("$pair") ;;
  esac
done <<<"$env_content"
if [ "${#env_pairs[@]}" -eq 0 ]; then
  finish noop "reason=primary-env-empty no_probe_started" 0
fi

smoke_log="${run_dir:+$run_dir/lastdb-local-smoke.log}"
smoke_log="${smoke_log:-${TMPDIR:-/tmp}/lastdb-local-smoke-$$.log}"
set +e
"$timeout_bin" -k 30s "${smoke_timeout_sec}s" \
  env "${env_pairs[@]}" BIN="$lastdbd_bin" bash "$smoke_script" 2>&1 |
  sed -E \
    -e 's/^(boot_env LASTDB_\*:).*/\1 <redacted>/' \
    -e 's/(boot_env LASTDB_\*:)[^)]*/\1 <redacted>/g' >"$smoke_log"
smoke_rc=${PIPESTATUS[0]}
set -e

# Keep stdout concise; the full sanitized diagnostic remains in the run dir.
sed -n '/^binary:/p; /^version:/p; /^identity ready:/p; /^schemas:/p; /^query:/p; /^VERDICT:/p; /^REASON:/p; /^SUMMARY:/p' \
  "$smoke_log" | tail -20

common_detail="wanted=$(safe_token "$wanted_oid") resolved=$(safe_token "$resolved_oid") source=$(safe_token "$source_kind") sha_drift=$(safe_token "$sha_drift")"
if [ "$smoke_rc" -eq 124 ] || [ "$smoke_rc" -eq 137 ]; then
  detail="reason=smoke-timeout seconds=$smoke_timeout_sec $common_detail"
  write_closeout_report RED "$detail" "$smoke_log" || true
  finish error "$detail" 1
fi
if [ "$smoke_rc" -eq 0 ] && grep -q '^VERDICT: GREEN$' "$smoke_log"; then
  detail="verdict=GREEN $common_detail"
  # The isolated-copy verdict is the only source of truth for the outcome. A
  # failed closeout-report write is visible in the detail and on stderr, but it
  # must not turn a real GREEN into a routine error.
  if ! write_closeout_report GREEN "$detail" "$smoke_log"; then
    detail="$detail closeout_report=write-failed"
  fi
  finish ok "$detail" 0
fi

reason="$(sed -n 's/^REASON:[[:space:]]*//p' "$smoke_log" | tail -1 | tr ' ' '_' | tr -c 'A-Za-z0-9._:/=-' '_' | cut -c1-240)"
detail="verdict=RED rc=$smoke_rc reason=${reason:-unknown} $common_detail"
write_closeout_report RED "$detail" "$smoke_log" || true
finish error "$detail" 1
