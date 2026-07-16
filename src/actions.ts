// Routine actions — the single implementation of pause/resume, re-route, and
// run-now. The CLI (`routines pause|resume|route|run`) and the web dashboard
// both call these so a button in the browser hits the exact same code path as
// the command line: no divergent second implementation to drift.

import { acquireLock, isLocked, releaseLock } from "./daemon.ts";
import { setKeys } from "./edit.ts";
import { isHarness, loadEntry, type RoutineEntry, type Status } from "./registry.ts";
import { runRoutine, type RunResult } from "./runner.ts";

/** Pause or resume a routine by rewriting its `status` key in place. Returns the
 * reloaded entry (validates the write round-trips). */
export function setStatus(entry: RoutineEntry, status: Status): RoutineEntry {
  setKeys(entry.sourcePath, { status });
  return loadEntry(entry.id);
}

export interface RouteUpdate {
  harness?: string;
  model?: string;
}

export class ActionError extends Error {}

/** Re-route a routine's harness and/or model, writing the registry TOML in
 * place (comments + unrelated lines survive). Returns the reloaded entry. */
export function routeRoutine(entry: RoutineEntry, update: RouteUpdate): RoutineEntry {
  const updates: Record<string, string> = {};
  if (update.harness !== undefined && update.harness !== "") {
    if (!isHarness(update.harness)) {
      throw new ActionError(`invalid harness: ${update.harness} (claude|codex|grok)`);
    }
    updates.harness = update.harness;
  }
  if (update.model !== undefined && update.model !== "") {
    updates.model = update.model;
  }
  if (Object.keys(updates).length === 0) {
    throw new ActionError("nothing to change (set harness and/or model)");
  }
  setKeys(entry.sourcePath, updates);
  return loadEntry(entry.id);
}

export interface RunNowStart {
  started: boolean;
  /** Why the run was refused (only set when started=false). */
  reason?: string;
  /** The in-flight run (only set when started=true); resolves when it finishes. */
  promise?: Promise<RunResult>;
}

/** Fire a routine now, sharing the daemon's per-routine single-flight lock so a
 * human-triggered run never overlaps a scheduled one (or another manual run).
 * The run executes through the same `runRoutine` the scheduler uses — same
 * spawn, same per-run log dir, same heartbeat. It is marked manual so a local
 * verification harness failure does not overwrite scheduled fleet status or
 * auto-file routine-error cards. Non-blocking: returns as soon as the run is
 * spawned; callers observe completion via the run's state/logs. */
export function startRunNow(entry: RoutineEntry): RunNowStart {
  if (isLocked(entry.id) || !acquireLock(entry.id)) {
    return { started: false, reason: "already running" };
  }
  const promise = runRoutine(entry, { quiet: true, trigger: "manual" }).finally(() => {
    releaseLock(entry.id);
  });
  // Swallow rejections here so an unobserved promise never crashes the server;
  // failures are already recorded to the run's meta.json + state by runRoutine.
  promise.catch(() => {});
  return { started: true, promise };
}
