// Shared status snapshot: the single-pane view of every routine — harness,
// model, schedule, next fire, last run outcome, rolling noop rate,
// running/fenced flags, and logical display group.
//
// Both `routines status` (the CLI) and `routines web` (the dashboard) render
// from this one function so the two views can never drift. It is the same
// computation the daemon's dispatch loop uses (rrule nextAfter, the Situation
// fence, the per-routine single-flight lock, on-disk run state).

import { isLocked, readLockPid, reconcileOrphanedRuns } from "./daemon.ts";
import { compareGrouped, groupForId } from "./groups.ts";
import { effectiveRoute } from "./harness-outage.ts";
import { aggregateOutcomes, type OutcomeKind } from "./outcome.ts";
import { fenceFor, loadActiveSituations } from "./situations.ts";
import { loadAll, type Harness, type Status } from "./registry.ts";
import { listRuns, type RunSummary } from "./runs.ts";
import { routinesHome, runsDir } from "./paths.ts";
import { nextAfter } from "./rrule.ts";
import { readState } from "./state.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How many recent runs feed the rolling noop/useful rates. */
const OUTCOME_WINDOW = 10;

function latestRunIsCompleted(latest: RunSummary | undefined): boolean {
  return Boolean(latest?.finishedAt && latest.exitCode !== null && latest.timedOut === false);
}

function isCurrentlyRunning(id: string, latest: RunSummary | undefined): boolean {
  if (!isLocked(id)) return false;
  return !latestRunIsCompleted(latest);
}

/** Prefer lock file pid; fall back to early meta.harnessPid in the latest run dir. */
function resolveHarnessPid(id: string, latest: RunSummary | undefined): number | null {
  const lockPid = readLockPid(id);
  if (lockPid != null) return lockPid;
  if (!latest?.stamp) return null;
  const metaPath = join(runsDir(), id, latest.stamp, "meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { harnessPid?: unknown };
    const n = Number(meta.harnessPid);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface StatusRow {
  id: string;
  status: Status;
  harness: Harness;
  model: string;
  /**
   * The harness/model actually dispatched right now, honoring the same-run
   * fallback chain (buildRouteChain in fallback.ts). Differs from `harness`/
   * `model` exactly when the configured primary is presently outaged and a
   * fallback step is substituted — this is the field to trust; `harness`/
   * `model` are what the registry TOML declares, not what will run next.
   */
  effectiveHarness: Harness;
  effectiveModel: string;
  effort: string | null;
  rrule: string;
  cwd: string;
  nextFire: string | null;
  lastRun: string | null;
  lastExit: number | null;
  lastRunDir: string | null;
  running: boolean;
  /**
   * Pid of the live harness worker when `running` is true (from the
   * single-flight lock / early meta). null when not running.
   */
  harnessPid: number | null;
  /** false, or the slug of the active Situation whose scope_routines matches. */
  fenced: string | boolean;
  /** Display group id (board | brain | dogfood | …). */
  groupId: string;
  /** Human label for the group section header. */
  groupLabel: string;
  /** Short group blurb for the section subtitle. */
  groupBlurb: string;
  /** Last classified work outcome. */
  lastOutcome: OutcomeKind | null;
  lastOutcomeDetail: string | null;
  /** Rolling window size used for rates. */
  outcomeWindow: number;
  outcomeOk: number;
  outcomeNoop: number;
  outcomeError: number;
  outcomeUnknown: number;
  /** noop / (ok+noop), or null when no clean classified runs yet. */
  noopRate: number | null;
  usefulRate: number | null;
}

export interface StatusSnapshot {
  home: string;
  situationsOk: boolean;
  situationsError: string | null;
  rows: StatusRow[];
  errors: string[];
}

/** Compute the current status of every registered routine. */
export function collectStatus(now: Date = new Date()): StatusSnapshot {
  reconcileOrphanedRuns(now);
  const { entries, errors } = loadAll();
  const check = loadActiveSituations();
  const rows: StatusRow[] = entries.map((e) => {
    const st = readState(e.id);
    const next = e.status === "active" ? nextAfter(e.parsedRrule, now) : null;
    const fence = fenceFor(e.id, check.situations);
    const group = groupForId(e.id, e.group);
    const recent = listRuns(e.id, OUTCOME_WINDOW);
    const stats = aggregateOutcomes(
      recent.map((r) => ({
        kind: r.outcome,
        detail: r.outcomeDetail,
        source: r.outcomeSource,
      })),
    );
    const latest = recent[0];
    const running = isCurrentlyRunning(e.id, latest);
    const harnessPid = running ? resolveHarnessPid(e.id, latest) : null;
    const route = effectiveRoute(e, now.getTime());
    const stateOutcome: OutcomeKind | null =
      st.lastOutcome === "ok" ||
      st.lastOutcome === "noop" ||
      st.lastOutcome === "error" ||
      st.lastOutcome === "unknown"
        ? st.lastOutcome
        : null;
    // While a run is in flight, listRuns may only have "unknown" (we refuse to
    // classify from memory.md dumps mid-run). Prefer the last finished outcome
    // so the dashboard does not flash red/unknown over a healthy prior run.
    const displayRun =
      latest && latest.outcome !== "unknown"
        ? latest
        : (recent.find((r) => r.outcome && r.outcome !== "unknown") ?? latest);
    const lastOutcome: OutcomeKind | null =
      displayRun?.outcome ?? stateOutcome;
    const lastOutcomeDetail =
      displayRun?.outcomeDetail ?? st.lastOutcomeDetail ?? null;

    return {
      id: e.id,
      status: e.status,
      harness: e.harness,
      model: e.model,
      effectiveHarness: route.harness,
      effectiveModel: route.model,
      effort: e.effort ?? null,
      rrule: e.rrule,
      cwd: e.cwd,
      nextFire: next ? next.toISOString() : null,
      lastRun: st.lastRun ?? null,
      lastExit: st.lastExit ?? null,
      lastRunDir: st.lastRunDir ?? null,
      running,
      harnessPid,
      fenced: fence.fenced ? (fence.situationSlug ?? true) : false,
      groupId: group.id,
      groupLabel: group.label,
      groupBlurb: group.blurb,
      lastOutcome,
      lastOutcomeDetail,
      outcomeWindow: OUTCOME_WINDOW,
      outcomeOk: stats.ok,
      outcomeNoop: stats.noop,
      outcomeError: stats.error,
      outcomeUnknown: stats.unknown,
      noopRate: stats.noopRate,
      usefulRate: stats.usefulRate,
    };
  });
  rows.sort(compareGrouped);
  return {
    home: routinesHome(),
    situationsOk: check.ok,
    situationsError: check.error ?? null,
    rows,
    errors: errors.map((e) => e.message),
  };
}
