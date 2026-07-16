// routinesd — the single scheduler/dispatcher.
//
// Each tick it loads the on-disk registry, computes which active routines are
// due (per their rrule and last-fire state), and dispatches them subject to:
//   - per-routine single-flight (a lock file; a routine never overlaps itself),
//   - a global concurrency cap,
//   - the dispatch-time Situation fence (skip a run whose id matches an active
//     Situation's scope_routines glob, and log why).
//
// `--once` runs a single evaluation pass (used by the e2e and for testing);
// the default loop runs until signalled. The daemon loop legitimately uses
// timers between ticks — that is a long-lived supervised process, not an agent
// "sleep-to-wait".

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { fenceFor, loadActiveSituations, type ActiveSituation } from "./situations.ts";
import { loadAll, type RoutineEntry } from "./registry.ts";
import { locksDir } from "./paths.ts";
import { nextAfter } from "./rrule.ts";
import { patchState, readState } from "./state.ts";
import { runRoutine, type RunResult } from "./runner.ts";
import { loadProjectConfig } from "./project-config.ts";
import { captureRoutineRunFailure, captureRoutinesException } from "./observability.ts";

export interface DaemonOptions {
  once?: boolean;
  /** ms between ticks in loop mode (default 15s). */
  tickMs?: number;
  /** Max concurrently-running routines (default 4). */
  concurrency?: number;
  /** Consider a never-fired routine due if it has an occurrence within this
   * window (ms) before now. 0 = cron semantics (warm up, no catch-up). The e2e
   * passes a positive value so a fresh routine fires in a single --once pass. */
  catchupMs?: number;
  /** Structured log sink (default: stderr JSON lines). */
  log?: (event: DaemonEvent) => void;
}

export interface DaemonEvent {
  ts: string;
  kind:
    | "tick"
    | "dispatch"
    | "complete"
    | "skip-fence"
    | "skip-single-flight"
    | "skip-cap"
    | "warmup"
    | "registry-error"
    | "situations-degraded";
  id?: string;
  detail?: string;
}

function defaultLog(event: DaemonEvent): void {
  process.stderr.write(JSON.stringify(event) + "\n");
}

function lockPath(id: string): string {
  return join(locksDir(), `${id}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Acquire a per-routine single-flight lock. Returns false if a live run holds
// it. Steals a lock whose owning pid is dead (crashed daemon). Exported so the
// web dashboard's run-now can share the daemon's single-flight discipline — a
// routine never overlaps itself, whether fired by the scheduler or a human.
/**
 * Read the pid recorded in a routine's single-flight lock file, or null if
 * missing/unparseable. The lock holds the live harness worker pid once the
 * child has spawned (via setLockOwnerPid); before that it holds the daemon pid
 * that acquired the lock.
 */
export function readLockPid(id: string): number | null {
  const p = lockPath(id);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").trim();
  // Accept plain pid or JSON {"pid":N,...} for forward compatibility.
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as { pid?: unknown; harnessPid?: unknown };
      const n = Number(j.harnessPid ?? j.pid);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  const pid = Number(raw);
  return Number.isFinite(pid) ? pid : null;
}

export function acquireLock(id: string): boolean {
  mkdirSync(locksDir(), { recursive: true });
  const p = lockPath(id);
  if (existsSync(p)) {
    const pid = readLockPid(id);
    if (pid != null && pidAlive(pid)) return false;
    // stale lock: fall through and overwrite
  }
  writeFileSync(p, String(process.pid));
  return true;
}

/** Update the lock owner to the live harness worker after spawn. */
export function setLockOwnerPid(id: string, pid: number): void {
  mkdirSync(locksDir(), { recursive: true });
  writeFileSync(lockPath(id), String(pid));
}

export function releaseLock(id: string): void {
  const p = lockPath(id);
  try {
    rmSync(p, { force: true });
  } catch {
    /* best effort */
  }
}

export function isLocked(id: string): boolean {
  const pid = readLockPid(id);
  return pid != null && pidAlive(pid);
}

/** Decide whether a routine is due at `now`, and (as a side effect) write a
 * warm-up baseline the first time an un-fired routine is seen. Returns the due
 * occurrence instant, or null if not due. */
export function dueOccurrence(
  entry: RoutineEntry,
  now: Date,
  catchupMs: number,
  log: (e: DaemonEvent) => void,
): Date | null {
  const st = readState(entry.id);
  let since: Date;
  if (st.lastFire) {
    since = new Date(st.lastFire);
  } else if (catchupMs > 0) {
    since = new Date(now.getTime() - catchupMs);
  } else {
    // First sight with no catch-up: record a baseline and don't fire yet.
    patchState(entry.id, { lastFire: now.toISOString() });
    log({ ts: now.toISOString(), kind: "warmup", id: entry.id });
    return null;
  }
  const occ = nextAfter(entry.parsedRrule, since);
  if (!occ || occ.getTime() > now.getTime()) return null;
  return occ;
}

interface DispatchDeps {
  now: Date;
  situations: ActiveSituation[];
  inFlight: Set<string>;
  concurrency: number;
  log: (e: DaemonEvent) => void;
  running: Promise<RunResult>[];
}

function tryDispatch(entry: RoutineEntry, occ: Date, deps: DispatchDeps): void {
  const { now, situations, inFlight, concurrency, log } = deps;

  // Situation fence — check first so a fenced routine is never dispatched, and
  // advance its last-fire so we don't re-evaluate the same instant every tick.
  const fence = fenceFor(entry.id, situations);
  if (fence.fenced) {
    patchState(entry.id, { lastFire: occ.toISOString(), lastSkip: `fence:${fence.situationSlug}` });
    log({
      ts: now.toISOString(),
      kind: "skip-fence",
      id: entry.id,
      detail: `Situation ${fence.situationSlug} scope_routines=${fence.pattern}`,
    });
    return;
  }

  if (inFlight.size >= concurrency) {
    log({ ts: now.toISOString(), kind: "skip-cap", id: entry.id, detail: `at cap ${concurrency}` });
    return; // leave lastFire unchanged — retry next tick
  }

  if (isLocked(entry.id) || !acquireLock(entry.id)) {
    log({ ts: now.toISOString(), kind: "skip-single-flight", id: entry.id });
    return;
  }

  patchState(entry.id, { lastFire: occ.toISOString() });
  inFlight.add(entry.id);
  log({ ts: now.toISOString(), kind: "dispatch", id: entry.id, detail: `${entry.harness}/${entry.model}` });

  const p = runRoutine(entry, { quiet: true })
    .then((result) => {
      log({
        ts: new Date().toISOString(),
        kind: "complete",
        id: entry.id,
        detail: `exit=${result.exitCode} run=${result.runDir}`,
      });
      if (result.exitCode !== 0 || result.outcome.kind === "error") {
        captureRoutineRunFailure(entry, result);
      }
      return result;
    })
    .catch((err) => {
      captureRoutinesException(err, {
        tags: { service: "routinesd", routine_id: entry.id, phase: "dispatch" },
      });
      throw err;
    })
    .finally(() => {
      inFlight.delete(entry.id);
      releaseLock(entry.id);
    });
  deps.running.push(p);
}

/** One evaluation pass. Returns the promises of any runs it dispatched. */
export async function evaluateOnce(opts: DaemonOptions = {}): Promise<RunResult[]> {
  const log = opts.log ?? defaultLog;
  const concurrency = opts.concurrency ?? 4;
  const catchupMs = opts.catchupMs ?? 0;
  const now = new Date();

  const { entries, errors } = loadAll();
  for (const e of errors) {
    log({ ts: now.toISOString(), kind: "registry-error", detail: e.message });
  }

  // Warm project config cache (configurations app) so runners inherit PATH / workspace.
  loadProjectConfig();

  const check = loadActiveSituations();
  if (!check.ok) {
    log({ ts: now.toISOString(), kind: "situations-degraded", detail: check.error });
  }

  const inFlight = new Set<string>();
  const running: Promise<RunResult>[] = [];
  const deps: DispatchDeps = { now, situations: check.situations, inFlight, concurrency, log, running };

  log({ ts: now.toISOString(), kind: "tick", detail: `${entries.length} routines` });

  for (const entry of entries) {
    if (entry.status !== "active") continue;
    const occ = dueOccurrence(entry, now, catchupMs, log);
    if (!occ) continue;
    tryDispatch(entry, occ, deps);
  }

  return Promise.all(running);
}

export interface DaemonHandle {
  stop: () => void;
  done: Promise<void>;
}

/** Run the scheduler loop until stop() is called. */
export function startDaemon(opts: DaemonOptions = {}): DaemonHandle {
  const tickMs = opts.tickMs ?? 15_000;
  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const loop = async () => {
    while (!stopped) {
      try {
        await evaluateOnce(opts);
      } catch (err) {
        captureRoutinesException(err, { tags: { service: "routinesd", phase: "tick" } });
        (opts.log ?? defaultLog)({
          ts: new Date().toISOString(),
          kind: "registry-error",
          detail: `tick failed: ${(err as Error).message}`,
        });
      }
      if (stopped) break;
      await sleep(tickMs);
    }
    resolveDone();
  };
  void loop();

  return {
    stop: () => {
      stopped = true;
    },
    done,
  };
}

function sleep(ms: number): Promise<void> {
  // Keep the timer *ref'd* so the event loop stays alive between ticks.
  // unref() made routinesd exit immediately after the first evaluateOnce
  // (launchd KeepAlive then thrash-restarted it with exit 0).
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
