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
harness       = "claude"                       # claude | codex
model         = "claude-opus-4-8"
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
routines logs <id>            # recent runs (--path, --tail, --json)
routines import               # import the legacy schedulers into the registry (dry-run)
routines web                  # serve the local dashboard (localhost); --port, --host
routines doctor               # validate registry + environment
routines daemon               # the scheduler loop (launchd entrypoint); --once, --catchup <s>
routines install-daemon       # install + load the launchd user agent
routines print-plist          # preview the launchd plist
```

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

## Daemon

`routinesd` is a launchd user agent (`com.edgevector.routinesd`, `KeepAlive`) so
it survives session exit. Each tick it:

1. loads the registry (per-file parse errors are reported, healthy routines
   still schedule),
2. computes which active routines are **due** from their rrule + last-fire
   state,
3. dispatches them subject to **per-routine single-flight** (a lock file), a
   **global concurrency cap**, and a timeout kill,
4. enforces the **dispatch-time Situation fence**: a run whose id matches an
   active `fsituations` Situation's `scope_routines` glob is skipped and logged.

Per-run evidence lands at `$ROUTINES_HOME/runs/<id>/<ts>/`
(`meta.json`, `prompt.txt`, `stdout.log`, `stderr.log`).

```sh
routines install-daemon                          # bootstrap under launchd
routines daemon --once --catchup 60              # single evaluation pass (testing / e2e)
```

## Forge

This repo merges through **LastGit-native change requests**, not GitHub PRs
(GitHub is a read-only mirror). Venue: `.last-stack/pr-venue`; CI gate:
`.lastgit/ci.sh` (`ci-required`). Pin `LASTGIT_SOCKET` to the dedicated forge
node socket (`~/.lastgit/forge/data/folddb.sock`) for every lastgit call — see
fbrain `sop-lastgit-native-forge-workflow`.

Mirror sync proof: LastGit CRs are expected to appear on the GitHub mirror within
the configured sync interval (validated 2026-07-12T23:11:25Z).

## Test

```sh
bun test            # unit + daemon + dashboard integration (47 tests)
bun run typecheck   # tsc --noEmit
bun run e2e         # full both-adapter dispatch e2e on a throwaway ROUTINES_HOME
```

The e2e stubs the leaf `claude`/`codex`/`fsituations`/`fbrain` binaries via env
overrides (`ROUTINES_CLAUDE_BIN`, `ROUTINES_CODEX_BIN`,
`ROUTINES_FSITUATIONS_BIN`, `ROUTINES_FBRAIN_BIN`) so it is hermetic and spends
no API credits while exercising the full dispatch → spawn → log → heartbeat
path that routines owns.

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
> pauses the fkanban-pickup / fleet routines). Run it attended, quit the Claude
> app first (its scheduler rewrites `scheduled-tasks.json` on every fire, so
> `--apply` refuses while a Claude process is running), and keep the rollback
> manifest. The manifest (every entry + its prior status) is written **even in
> dry-run**, so the rollback list exists before any change.

## Scope

Core = the scheduler daemon + CLI + both adapters + the local `routines web`
dashboard (single-pane coordination) + the one-time `import` + cutover tooling.
**Out of scope** (separate cards): remote/authenticated access and historical
analytics for the dashboard, and any new routine content.
