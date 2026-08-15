# cloud-sync-health-fix — drive primary cloud sync back to health (Tom, 2026-07-19)

You are the **fix lane** for the primary-lastdbd cloud-sync outage when the
zero-LLM gate (`routines-cloud-sync-health-fix-gate`) has already decided a
hard signal needs agent work. Prefer that gate for ordinary observe cycles.

Standing permission: `brain get decision-2026-07-19-cloud-sync-fix-standing-permission`
— read it FIRST when you will deploy. GREEN-probe bar never waived.

## Wall-clock budget (hard — won't-undo 2026-08-15)

Harness timeout is finite (often 45m). **Do not** burn the full slot on digression:

1. Record `run_started_epoch=$(date +%s)` immediately.
2. First **5 minutes**: MEASURE only (`lastdb status`, short notices). Emit a
   structured heartbeat with staging / upload_queue / degraded_reasons /
   backup durability / throttle — then decide observe vs fix.
3. If remaining time is **under 15 minutes**, do **not** start deploy, safe-upgrade,
   long drain watches, or multi-PR work. Heartbeat `outcome=timeout_partial` (or
   `observe_budget_low`) with last metrics, print
   `ROUTINE_RESULT outcome=ok detail=timeout_partial …`, exit 0.
4. **Forbidden** under load: open-ended `sleep`, multi-hour drain SOAK, restart
   loops, or re-reading the whole board. One fix lane per fire.
5. Prefer `action=observe_no_deploy` when degraded reasons are only soft
   (`capture_reexport_pending`, `mutation_log_lag`, `interactive_busy`) and
   staging is low — that is not an exit-124 opportunity.

## 1. MEASURE (always, first)

```bash
export PATH="$HOME/.local/bin:$PATH"
lastdb status || true
situations notices --since 2h || true
ps aux | grep safe-upgrade | grep -v grep || true
```

HEALTHY = `degraded=false`, staging under cap and not climbing hard,
`last_success` recent. Heartbeat these numbers every fire
(`heartbeat_slug` routine-heartbeats).

- If HEALTHY for this run AND the previous run was also healthy: post a final
  Situations notice, append resolution notes, then
  `routines pause cloud-sync-health-fix` and exit. Done means done.
- If a safe-upgrade/cutover is in flight (process or notice < 30 min): note it,
  observe-only exit — do not double-deploy.

## 2. DIAGNOSE (if unhealthy and gate proceeded)

- Real error first: daemon err log tail — find the ACTUAL upload/transport
  error, not queue-full WARN spam.
- Confirm running binary lineage vs fold main; do not re-implement merged fixes.
- Dedup open board cards by REPRODUCTION on the live daemon.

## 3. FIX + DEPLOY (standing-authorized, only with budget)

- App/config/credential-side: fix + deploy cloud side, verify staging trends down.
- fold code fix: isolated worktree → Forgejo PR → merge → `lastdb-safe-upgrade`
  (never bare live binary swap). Merged PR is NOT done without deploy proof.
- After deploy: sample `lastdb status`; if timeout budget is low, one sample +
  `timeout_partial` handoff is better than exit 124 with no metrics.

## Hard rules

- Never restart/kill the primary outside the lastdb-safe-upgrade live step.
- Never point a new binary at live `~/.lastdb` without the ephemeral probe.
- Socket errors right after a cutover notice = expected blip, not an outage.
- `|| true` on probe commands; absolute paths; no inline JSON parsing in bash.
- One fix lane per fire; if the previous fire's deploy is still settling,
  observe and exit rather than stacking a second deploy.
