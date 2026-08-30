#!/usr/bin/env bash
# Zero-LLM work unit for llms-txt-install-smoke.
#
# Intended as gate_command for registry id llms-txt-install-smoke:
#   gate_command = "routines-llms-txt-install-smoke-gate"
#   timeout_min  = 45
#
# WHY THIS GATE EXISTS
#
# The smoke is already fully mechanical: skills/llms-txt-install-smoke/
# routine-run.sh prints a literal `VERDICT:` line and a `RESULT: ok|error ...`
# trailer, and exits 0 (GREEN) / 1 (RED) / 2 (incomplete). Nothing in it needs
# an LLM. Running it through the harness only imposed the harness's foreground
# cap on it, and that cap is what broke it.
#
# Measured 2026-08-27 (run 2026-08-27T20-15-11-374Z, harness codex): one
# foreground call to routine-run.sh `succeeded in 1085932ms` — 18m06s — with
# `PASS (27) / FAIL (0) / VERDICT: GREEN`. The routine also passed on grok.
# Its first and only run on the claude harness (2026-08-29) was killed at
# 10 minutes with no VERDICT, because the claude harness caps one foreground
# Bash call at 600s. The registry pins harness = "codex", but the active
# harness-outage-codex and harness-outage-grok Situations force
# effectiveHarness = claude, so the cap arrived under the routine by harness
# fallback and every future run inherits it.
#
# The 2026-08-29 response shrank run.sh's global budget to 540s to fit under
# that cap. 540s is half the measured 1086s GREEN, so from 2026-08-30 the
# smoke would reach its footer with the work unfinished and print a confident
# `VERDICT: RED` about a public install path that is not broken.
# papercut-llms-txt-smoke-budget-half-the-measured-work-emits-false-red
#
# A gate_command runs zero-LLM under routinesd, so no harness foreground cap
# applies and the routine can finally reach its own timeout_min. This gate
# therefore raises the smoke's budgets by environment (run.sh and
# routine-run.sh both read ${VAR:-default}, so the env wins). The 540s/570s
# defaults stay correct for the LLM path, which still has the cap.
#
# Budgets, all inside timeout_min = 45 (2700s):
#   run.sh internal deadline   2400s  (2.21x the measured 1086s GREEN)
#   routine-run.sh outer bound 2460s  (above the internal budget, as that
#                                      wrapper's own rule requires)
#   this gate's bound          2520s  (above the wrapper)
#   leaves ~180s for the closeout write and teardown.
#
# Exit codes (routines gate contract):
#   0 — ROUTINE_RESULT outcome=ok|noop already printed
#   1 — ROUTINE_RESULT outcome=error already printed
set -euo pipefail

ROUTINE_ID="llms-txt-install-smoke"
last_stack="${LAST_STACK_ROOT:-$HOME/.last-stack}"
export PATH="$HOME/.local/bin:$last_stack/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-}"

run_dir="${ROUTINES_RUN_DIR:-}"
if [ -n "$run_dir" ]; then
  mkdir -p "$run_dir"
fi

runner="${LLMS_TXT_SMOKE_RUNNER:-$last_stack/skills/llms-txt-install-smoke/routine-run.sh}"
heartbeat_bin="${LLMS_TXT_SMOKE_HEARTBEAT_BIN:-$last_stack/bin/last-stack-brain-append-heartbeat}"
brain_bin="${LLMS_TXT_SMOKE_BRAIN_BIN:-$(command -v brain 2>/dev/null || true)}"

# See the budget table above. Each is overridable for tests.
smoke_budget_sec="${LLMS_TXT_SMOKE_BUDGET_SEC:-2400}"
wrapper_bound_sec="${LLMS_TXT_SMOKE_WRAPPER_BOUND_SEC:-2460}"
gate_bound_sec="${LLMS_TXT_SMOKE_GATE_BOUND_SEC:-2520}"

closeout_report_attempts="${LLMS_TXT_SMOKE_CLOSEOUT_ATTEMPTS:-3}"
closeout_report_retry_sleep_sec="${LLMS_TXT_SMOKE_CLOSEOUT_RETRY_SLEEP_SEC:-3}"

timeout_bin="${LLMS_TXT_SMOKE_TIMEOUT_BIN:-}"
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
      "$ROUTINE_ID $(iso_now) $kind $detail" 2>/dev/null || true
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
  printf 'closeout-llms-txt-install-smoke-%s\n' "$seed"
}

write_closeout_report() {
  local verdict="$1" detail="$2" log_path="$3"
  local slug report_file attempt
  [ -n "$brain_bin" ] && [ -x "$brain_bin" ] || return 1
  slug="$(report_slug)"
  report_file="${run_dir:+$run_dir/closeout.md}"
  report_file="${report_file:-${TMPDIR:-/tmp}/llms-txt-install-smoke-closeout-$$.md}"
  {
    printf '%s\n' '---'
    printf '%s\n' 'type: reference'
    printf 'slug: %s\n' "$slug"
    printf 'title: Closeout — llms.txt first-run install smoke %s\n' "$verdict"
    printf '%s\n' 'tags: [closeout, lastdb, smoke-test, install]'
    printf '%s\n\n' '---'
    printf '%s\n' '## What was done'
    printf 'Ran the isolated public llms.txt first-run install smoke as a zero-LLM gate. Verdict: %s.\n\n' "$verdict"
    printf '%s\n' '## Proof'
    printf '%s\n' "$detail"
    printf 'Smoke log: %s\n\n' "$log_path"
    printf '%s\n' '## Papercuts filed'
    printf '%s\n\n' '- none — the gate produced a classified product verdict; operational gate failures are surfaced by the routine outcome.'
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

# A budget that does not exceed the measured runtime is the defect this gate
# exists to remove. Refuse to run under one rather than shipping a verdict the
# clock decided. 1086s is the measured GREEN (2026-08-27).
measured_green_sec="${LLMS_TXT_SMOKE_MEASURED_GREEN_SEC:-1086}"
if [ "$smoke_budget_sec" -le "$measured_green_sec" ]; then
  finish noop \
    "reason=budget-under-measured-work budget=${smoke_budget_sec}s measured_green=${measured_green_sec}s no_probe_started" 0
fi
if [ "$wrapper_bound_sec" -le "$smoke_budget_sec" ] || [ "$gate_bound_sec" -le "$wrapper_bound_sec" ]; then
  finish error \
    "reason=budget-ladder-inverted budget=${smoke_budget_sec}s wrapper=${wrapper_bound_sec}s gate=${gate_bound_sec}s" 1
fi
if [ ! -f "$runner" ]; then
  finish error "reason=runner-missing path=$(safe_token "$runner")" 1
fi
if [ -z "$timeout_bin" ] || [ ! -x "$timeout_bin" ]; then
  finish noop "reason=no-command-timebox no_probe_started" 0
fi

smoke_log="${run_dir:+$run_dir/llms-txt-install-smoke.log}"
smoke_log="${smoke_log:-${TMPDIR:-/tmp}/llms-txt-install-smoke-$$.log}"

set +e
"$timeout_bin" -k 30s "${gate_bound_sec}s" \
  env \
  SMOKE_TOTAL_BUDGET_SECS="$smoke_budget_sec" \
  SMOKE_WRAPPER_TIMEOUT_SECS="$wrapper_bound_sec" \
  bash "$runner" >"$smoke_log" 2>&1
smoke_rc=$?
set -e

# Keep stdout concise; the full log stays in the run dir.
sed -n '/^PASS (/p; /^FAIL (/p; /^VERDICT:/p; /^RESULT:/p' "$smoke_log" | tail -20

verdict_line="$(grep -E '^VERDICT: (GREEN|RED)' "$smoke_log" | tail -n1 || true)"
result_line="$(grep -E '^RESULT: ' "$smoke_log" | tail -n1 || true)"
result_detail="$(printf '%s' "$result_line" | sed -E 's/^RESULT: //' | cut -c1-240)"
common_detail="budget=${smoke_budget_sec}s rc=$smoke_rc"

if [ "$smoke_rc" -eq 124 ] || [ "$smoke_rc" -eq 137 ]; then
  detail="reason=gate-timeout seconds=$gate_bound_sec $common_detail"
  write_closeout_report RED "$detail" "$smoke_log" || true
  finish error "$detail" 1
fi

# routine-run.sh exits 2 when it produced no VERDICT. That is an incomplete
# run, not a product RED: nothing was measured, so nothing may be claimed.
if [ -z "$verdict_line" ]; then
  detail="reason=incomplete-no-verdict $common_detail result=$(safe_token "${result_detail:-none}")"
  write_closeout_report RED "$detail" "$smoke_log" || true
  finish error "$detail" 1
fi

if [ "$smoke_rc" -eq 0 ] && printf '%s' "$verdict_line" | grep -q '^VERDICT: GREEN'; then
  pass_line="$(grep -E '^PASS \(' "$smoke_log" | tail -n1 || true)"
  detail="verdict=GREEN $(safe_token "${pass_line:-pass=unknown}") $common_detail"
  # The smoke verdict is the only source of truth for the outcome. A failed
  # closeout-report write is visible in the detail and on stderr, but it must
  # not turn a real GREEN into a routine error.
  # papercut-lastdb-smoke-gate-closeout-write-failure-overrides-green-verdict
  if ! write_closeout_report GREEN "$detail" "$smoke_log"; then
    detail="$detail closeout_report=write-failed"
  fi
  finish ok "$detail" 0
fi

fail_line="$(grep -E '^FAIL \(' "$smoke_log" | tail -n1 || true)"
detail="verdict=RED $(safe_token "${fail_line:-fail=unknown}") $common_detail"
write_closeout_report RED "$detail" "$smoke_log" || true
finish error "$detail" 1
