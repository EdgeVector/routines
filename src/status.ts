// Shared status snapshot: the single-pane view of every routine — harness,
// model, schedule, next fire, last run outcome, running/fenced flags.
//
// Both `routines status` (the CLI) and `routines web` (the dashboard) render
// from this one function so the two views can never drift. It is the same
// computation the daemon's dispatch loop uses (rrule nextAfter, the Situation
// fence, the per-routine single-flight lock, on-disk run state).

import { isLocked } from "./daemon.ts";
import { fenceFor, loadActiveSituations } from "./situations.ts";
import { loadAll, type Harness, type Status } from "./registry.ts";
import { routinesHome } from "./paths.ts";
import { nextAfter } from "./rrule.ts";
import { readState } from "./state.ts";

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
    };
  });
  return {
    home: routinesHome(),
    situationsOk: check.ok,
    situationsError: check.error ?? null,
    rows,
    errors: errors.map((e) => e.message),
  };
}
