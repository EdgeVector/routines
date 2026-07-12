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
routines doctor               # validate registry + environment
routines daemon               # the scheduler loop (launchd entrypoint); --once, --catchup <s>
routines install-daemon       # install + load the launchd user agent
routines print-plist          # preview the launchd plist
```

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
bun test            # unit + daemon integration (39 tests)
bun run typecheck   # tsc --noEmit
bun run e2e         # full both-adapter dispatch e2e on a throwaway ROUTINES_HOME
```

The e2e stubs the leaf `claude`/`codex`/`fsituations`/`fbrain` binaries via env
overrides (`ROUTINES_CLAUDE_BIN`, `ROUTINES_CODEX_BIN`,
`ROUTINES_FSITUATIONS_BIN`, `ROUTINES_FBRAIN_BIN`) so it is hermetic and spends
no API credits while exercising the full dispatch → spawn → log → heartbeat
path that routines owns.

## Scope

MVP = the scheduler daemon + CLI + both adapters. **Out of scope** (separate
cards): the web dashboard (`routines status` is the MVP coordination view),
migrating/pausing existing Codex crons and Claude scheduled tasks, and any new
routine content.
