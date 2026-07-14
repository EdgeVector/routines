// Per-routine run state: last fire time, last exit, last run dir. Used by the
// daemon to avoid double-firing a single scheduled instant and by `status` /
// `logs` to report the most recent run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "./paths.ts";

export interface RoutineState {
  id: string;
  /** ISO timestamp of the last dispatch the daemon fired for this routine. */
  lastFire?: string;
  /** ISO timestamp of the last completed run. */
  lastRun?: string;
  lastExit?: number | null;
  lastRunDir?: string;
  lastSkip?: string; // reason a run was skipped (fence/single-flight)
  /** Last classified work outcome: ok | noop | error | unknown. */
  lastOutcome?: string;
  lastOutcomeDetail?: string;
}

function statePath(id: string): string {
  return join(stateDir(), `${id}.json`);
}

export function readState(id: string): RoutineState {
  const p = statePath(id);
  if (!existsSync(p)) return { id };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as RoutineState;
    return { ...parsed, id };
  } catch {
    return { id };
  }
}

export function writeState(state: RoutineState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(state.id), JSON.stringify(state, null, 2) + "\n");
}

export function patchState(id: string, patch: Partial<RoutineState>): RoutineState {
  const cur = readState(id);
  const next = { ...cur, ...patch, id };
  writeState(next);
  return next;
}
