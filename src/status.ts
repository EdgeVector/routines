// Shared status snapshot: the single-pane view of every routine — harness,
// model, schedule, next fire, last run outcome, rolling noop rate,
// running/fenced flags, and logical display group.
//
// Both `routines status` (the CLI) and `routines web` (the dashboard) render
// from this one function so the two views can never drift. It is the same
// computation the daemon's dispatch loop uses (rrule nextAfter, the Situation
// fence, the per-routine single-flight lock, on-disk run state).

import { isLocked } from "./daemon.ts";
import { compareGrouped, groupForId } from "./groups.ts";
import { aggregateOutcomes, type OutcomeKind } from "./outcome.ts";
import { fenceFor, loadActiveSituations } from "./situations.ts";
import { loadAll, type Harness, type Status } from "./registry.ts";
import { listRuns } from "./runs.ts";
import { routinesHome } from "./paths.ts";
import { nextAfter } from "./rrule.ts";
import { readState } from "./state.ts";

/** How many recent runs feed the rolling noop/useful rates. */
const OUTCOME_WINDOW = 10;

export interface StatusRow {
  id: string;
  status: Status;
  harness: Harness;
  model: string;
  effort: string | null;
  rrule: string;
  cwd: string;
  nextFire: string | null;
  lastRun: string | null;
  lastExit: number | null;
  lastRunDir: string | null;
  running: boolean;
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

/** Compute the current status of every registered routine. Read-only. */
export function collectStatus(now: Date = new Date()): StatusSnapshot {
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
    const stateOutcome: OutcomeKind | null =
      st.lastOutcome === "ok" ||
      st.lastOutcome === "noop" ||
      st.lastOutcome === "error" ||
      st.lastOutcome === "unknown"
        ? st.lastOutcome
        : null;
    const lastOutcome: OutcomeKind | null =
      latest?.outcome ?? stateOutcome;
    const lastOutcomeDetail =
      latest?.outcomeDetail ?? st.lastOutcomeDetail ?? null;

    return {
      id: e.id,
      status: e.status,
      harness: e.harness,
      model: e.model,
      effort: e.effort ?? null,
      rrule: e.rrule,
      cwd: e.cwd,
      nextFire: next ? next.toISOString() : null,
      lastRun: st.lastRun ?? null,
      lastExit: st.lastExit ?? null,
      lastRunDir: st.lastRunDir ?? null,
      running: isLocked(e.id),
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
