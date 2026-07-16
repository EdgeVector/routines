# routines

Unified scheduler + dispatcher for agent routines (Claude Code / Codex), with
per-routine model routing. **One scheduler owns dispatch; each routine's on-disk
config declares its harness and model.** Spec of record:
`fbrain get design-routines-orchestrator`.

Today routine configs are split across three registries with two live
schedulers (`~/.last-stack/routines/*.md` prompts, `~/.codex/automations/*`
Codex cron, `~/.claude/scheduled-tasks/`). routines unifies dispatch into a
single launchd-supervised daemon reading one on-disk registry.

## Install

```sh
bun install
bun run install-shim      # symlinks `routines` into ~/.local/bin
```

Run without the shim via `bun run src/cli.ts <command>` or `bun run routines`.

## Registry

One TOML file per routine at `$ROUTINES_HOME/registry/<id>.toml` (default
`~/.routines`). The registry lives on **disk, not in LastDB**, on purpose: the
scheduler must keep firing — or fail loudly — during a brain outage. Run history
and heartbeats still flow to fbrain.

```toml
# ~/.routines/registry/disk-reclaim.toml   (filename stem = id)
harness       = "claude"                       # claude | codex | grok
model         = "claude-opus-4-8"              # e.g. sonnet | gpt-5.5 | grok-4.5
effort        = "medium"                        # optional (codex reasoning effort)
rrule         = "FREQ=HOURLY;INTERVAL=2"        # RFC 5545, same dialect as Codex automations
prompt_path   = "/Users/you/.last-stack/routines/disk-reclaim.md"   # or inline `prompt = "..."`
cwd           = "/Users/you/code/edgevector"
status        = "active"                         # active | paused
timeout_min   = 30
heartbeat_slug = "routine-heartbeats"           # optional; runs append the fleet heartbeat line
```

Supported rrule keys: `FREQ` (SECONDLY..YEARLY), `INTERVAL`, `BYDAY`, `BYHOUR`,
`BYMINUTE`, `BYSECOND`, `BYMONTHDAY`, and an optional `DTSTART` anchor. An
example lives in `examples/`.

## CLI

```
routines list                 # registered routines
routines status               # last run / next fire / harness / model — the single-pane view
routines run <id>             # run a routine now (foreground)
routines pause|resume <id>    # toggle status
routines route <id> --harness codex --model gpt-5.5
routines route <id> --harness grok --model grok-4.5
routines logs <id>            # recent runs (--path, --tail, --json)
routines publish-status       # publish slim fleet status + recent run summaries to LastDB
routines deliver-status       # publish + stage/admin-approve a fleet-status delivery
routines hygiene              # mechanical cleanup (prune runs/memory, daemon check, publish)
routines hygiene --dry-run    # report only
routines import               # import the legacy schedulers into the registry (dry-run)
routines web                  # serve the local dashboard (localhost); --port, --host
routines doctor               # validate registry + environment (+ configurations project-config)
routines daemon               # the scheduler loop (launchd entrypoint); --once, --catchup <s>
routines install-daemon       # install + load the launchd user agent
routines install-hygiene      # install + load hourly mechanical hygiene launchd agent
routines print-plist          # preview the launchd plist
```

### Fleet hygiene (automatic cleanup)

Two complementary layers:

1. **`routines hygiene`** (mechanical, no LLM) — prunes old run dirs under
   `~/.routines/runs` (keep last 20 per id **or** last 7 days), truncates
   `memory.md` files to the last 100 lines, drops stale
   `error-escalate/*.json`, checks that `com.edgevector.routinesd` is loaded,
   and runs `publish-status`. Install hourly via `routines install-hygiene`
   (label `com.edgevector.routines-hygiene`). Shell wrapper:
   `scripts/routines-hygiene.sh`.
2. **`routine-fleet-health`** (agent, hourly) — closes healed
   `routine-error-*` cards, safe registry timeout bumps for chronic 124s,
   dedupes against error-escalate, files pickup cards only when needed.
   Canonical prompt: `prompts/routine-fleet-health.md` (copy into
   `~/.routines/prompts/` and/or last-stack as needed).


## Web dashboard

`routines web` serves the "coordinate them all from one place" view — the
single-pane `routines status` table rendered in the browser, with per-routine
actions. It is a single self-contained page (inline CSS + JS, **no external
assets**) plus a small JSON API on `127.0.0.1` only — **localhost, no auth**.

```sh
routines web                 # http://127.0.0.1:4778 (ROUTINES_WEB_PORT to override)
routines web --port 8080     # pick a port
```

The dashboard shows every routine's harness, model, schedule, status, next fire,
and last-run outcome, and wires each action to the **same code path as the CLI**
(`src/actions.ts`): run-now (shares the daemon's per-routine single-flight lock),
pause/resume (rewrites `status` in the registry TOML), and re-route harness/model
(rewrites `harness`/`model` in place). Expand a routine to see its recent runs
with exit status and a tail of the captured log. Serve it alongside the daemon —
it reads the same on-disk registry and run logs, so it reflects live scheduler
state.

The JSON API (for scripting): `GET /api/routines`, `GET /api/routines/<id>/runs`,
`GET /api/routines/<id>/runs/<stamp|latest>`, and `POST /api/routines/<id>/{run,pause,resume,route}`.

## LastDB fleet status publish

`routines publish-status` writes a slim, admin-deliverable fleet snapshot to the
local LastDB Mini socket. It reuses `collectStatus()` and `listRuns()`, declares
the app-owned schemas on first run, and upserts:

- `routines/RoutineFleetSnapshot` key `fleet-latest`
- `routines/RoutineStatus` key `<routine id>`
- `routines/RoutineRunSummary` key `<routine id>/<run stamp>`

The publisher intentionally excludes prompts and full logs. Recent run evidence
is capped (`--tail-bytes`, default 2048) and common secret-looking assignments
are redacted before write.

```sh
routines publish-status --json
routines publish-status --runs 5 --tail-bytes 2048
routines publish-status --dry-run --json
```

## Admin fleet status deliver

`routines deliver-status` dogfoods LastDB Mini deliver for the routines fleet
slice. It first runs the same publisher as `routines publish-status`, then
stages a `lastdb.slice.v1` delivery with two legs:

- `routines/RoutineFleetSnapshot` key `fleet-latest`
- a capped `routines/RoutineStatus` sample (`--max-records`, default 20)

Recipient keys are operational inputs, not repository config. Pass them as
flags or environment variables; do not commit them:

```sh
export ROUTINES_ADMIN_RECIPIENT_PUBKEY=...
export ROUTINES_ADMIN_MESSAGING_PUBLIC_KEY=...
export ROUTINES_ADMIN_MESSAGING_PSEUDONYM=...

routines deliver-status --dry-run --json
routines deliver-status --max-records 20
routines deliver-status --approve --max-records 20
```

Without `--approve`, the command stages only and prints the pending
`delivery_id`; with `--approve`, Mini seals and sends a `delivery_slice` through
Exemem messaging and prints non-secret evidence (`delivery_id`, shared count,
message type, schema hashes). Mailbox polling/decryption is intentionally left
to the receiving admin consumer tooling because the send path and read path are
owned by different apps.

## Daemon

`routinesd` is a launchd user agent (`com.edgevector.routinesd`, `KeepAlive`) so
it survives session exit. Each tick it:

1. loads the registry (per-file parse errors are reported, healthy routines
   still schedule),
2. computes which active routines are **due** from their rrule + last-fire
   state,
3. dispatches them as a **free-slot pool**: when a run finishes, the next due
   routine is admitted immediately (the scheduler does **not** wait for a whole
   batch to finish). Constraints are **per-routine single-flight** (lock file),
   an optional global concurrency cap (`--concurrency N`; default **unlimited** /
   `0`), and a per-run **timeout kill**,
4. enforces the **dispatch-time Situation fence**: a run whose id matches an
   active `fsituations` Situation's `scope_routines` glob is skipped and logged.

Per-run evidence lands at `$ROUTINES_HOME/runs/<id>/<ts>/`
(`meta.json`, `prompt.txt`, `stdout.log`, `stderr.log`).

```sh
routines install-daemon                          # bootstrap under launchd
routines daemon --once --catchup 60              # single evaluation pass (testing / e2e)
```

`routines install-daemon` also enables Sentry for the launchd-managed daemon by
setting `OBS_SENTRY_DSN=lastsecrets://obs-sentry-dsn-routines`,
`OBS_SENTRY_ENVIRONMENT=production`, and an `OBS_SENTRY_RELEASE` tag in the
plist. At process startup, routines resolves the locator with `lastsecrets get`
and initializes the shared Last Stack Bun/TypeScript Sentry helper from
`$LAST_STACK_ROOT/lib/observability/sentry.ts` (default `~/.last-stack`). If the
locator, helper, or `@sentry/node` dependency is unavailable, Sentry stays off
and the daemon/web process continues. Reported events include uncaught process
errors, daemon tick/dispatch exceptions, non-zero routine run exits tagged by
routine id/harness/model, and dashboard handler exceptions; prompt text and log
bodies are not sent.

## Forge

This repo merges through **LastGit-native change requests**, not GitHub PRs
(GitHub is a read-only mirror). Venue: `.last-stack/pr-venue`; CI gate:
`.lastgit/ci.sh` (`ci-required`). LastGit is homed at `lastdb:///routines` on
the canonical LastDB socket; see fbrain `sop-lastgit-native-forge-workflow`.

GitHub stays public for clone/browse only. It is not a review or CI venue:
repository Actions are disabled, this checkout contains no GitHub workflows,
and LastGit-to-GitHub mirror sync keeps `origin/main` aligned after CR merges.

Mirror sync proof: LastGit CRs are expected to appear on the GitHub mirror within
the configured sync interval (validated 2026-07-12T23:11:25Z).

## Test

```sh
bun test            # unit + daemon + dashboard integration (47 tests)
bun run typecheck   # tsc --noEmit
bun run e2e         # full both-adapter dispatch e2e on a throwaway ROUTINES_HOME
```

The e2e stubs the leaf `claude`/`codex`/`grok` binaries by setting
`ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES=1` plus the relevant `ROUTINES_*_BIN`
values. It also stubs `fsituations`/`fbrain` via `ROUTINES_FSITUATIONS_BIN` and
`ROUTINES_FBRAIN_BIN`, so it is hermetic and spends no API credits while
exercising the full dispatch → spawn → log → heartbeat path that routines owns.

## Migration (one-time cutover)

`routines import` reads the two **legacy** schedulers and generates registry
entries, preserving each routine's prompt / rrule / model / cwd / harness:

- `~/.codex/automations/*/automation.toml` — only the **ACTIVE** crons (PAUSED
  ones are already off). A stray `RRULE:` value prefix is stripped; the huge
  inline prompt is preserved verbatim.
- the Claude scheduler's `scheduled-tasks.json` (auto-discovered) — only
  **enabled** tasks with a cron; one-shot `fireAt` reminders and disabled tasks
  are skipped. 5-field cron is converted to the same RRULE dialect. Each task's
  `SKILL.md` is referenced via `prompt_path`. Claude tasks carry no per-task
  model, so they import at `--claude-model` (default `sonnet`); re-route with
  `routines route`.

```sh
routines import                 # DRY-RUN: print the diff table, write nothing
routines import --write         # generate ~/.routines/registry/<id>.toml files
routines import --json          # machine-readable plan (incl. pauseTargets)
```

Codex automation IDs that used `last-stack-fkanban-pickup`, `last-stack-fkanban-watch`,
or `last-stack-fkanban-validate` import as the canonical
`last-stack-kanban-pickup`, `last-stack-kanban-watch`, and
`last-stack-kanban-validate` registry IDs. Existing installs can run the
idempotent one-time filesystem migration before cutover:

```sh
routines migrate-kanban-ids          # DRY-RUN: registry/state/memory/lock/run moves
routines migrate-kanban-ids --write  # apply the moves under $ROUTINES_HOME
```

When both old and new paths exist, the migration keeps the new registry entry,
merges state/run/memory directories where possible, and archives the old path so
only the canonical `last-stack-kanban-*` registry files can fire.

**Dual-scheduler dedup.** Many routines are scheduled in *both* legacy
schedulers under different ids (e.g. Claude `program-driver` and Codex
`last-stack-program-driver` are one loop). Importing both would make routines
itself double-fire. `import` detects these by a normalized name and keeps one per
group (Codex wins by default — flip with `--prefer claude`, or import both with
`--keep-duplicates`). Every collapsed group is shown under **CROSS-SCHEDULER
DUPLICATES** so a human resolves routing before cutover. This is the
`papercut-phantom-program-rollup-churn` hazard, made visible.

Once the registry looks right, `scripts/cutover.sh` pauses the legacy schedulers
so routines becomes the **sole** scheduler:

```sh
scripts/cutover.sh              # DRY-RUN: print the plan + write the rollback manifest
scripts/cutover.sh --apply      # pause Codex ACTIVE->PAUSED + disable Claude tasks
scripts/cutover.sh --restore <manifest.json>   # reverse a cutover
```

> ⚠️ `--apply` is a **prod cutover** of shared scheduling infrastructure (it
> pauses the kanban-pickup / fleet routines). Run it attended, quit the Claude
> app first (its scheduler rewrites `scheduled-tasks.json` on every fire, so
> `--apply` refuses while a Claude process is running), and keep the rollback
> manifest. The manifest (every entry + its prior status) is written **even in
> dry-run**, so the rollback list exists before any change.

## Scope

Core = the scheduler daemon + CLI + both adapters + the local `routines web`
dashboard (single-pane coordination) + the one-time `import` + cutover tooling.
**Out of scope** (separate cards): remote/authenticated access and historical
analytics for the dashboard, and any new routine content.

## Error escalation (P0)

When a run ends with **non-zero exit**, **timeout**, or **outcome=error**,
`routinesd` automatically:

1. Upserts a **P0** kanban card `routine-error-<id>` with the run dir evidence
2. Dispatches a one-shot **triage agent** (same harness/model; 30m cooldown per id)
   that investigates `~/.routines/runs/<id>/…` and either fixes or updates the card

Disable with `ROUTINES_ERROR_ESCALATE=0`. The triage runner id
`routine-error-triage` is never re-escalated (no loops).
