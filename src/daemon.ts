// routinesd — the single scheduler/dispatcher.
//
// Free-slot pool (not batch-wait):
//   Each tick (and every time a run completes) the daemon loads the registry,
//   finds due routines, and starts as many as capacity allows. Completing a
//   run frees its slot immediately and the next due routine is admitted —
//   the scheduler never blocks on Promise.all of a whole batch.
//
// Dispatch constraints:
//   - per-routine single-flight (lock file; a routine never overlaps itself)
//   - optional global concurrency (0 / unset = unlimited — registry schedules
//     define what runs; no silent skip-cap starvation by default)
//   - per-run timeout_min (runner kills that process only)
//   - dispatch-time Situation fence
//
// `--once` runs a single evaluation pass and waits for the jobs it started
// (used by e2e/tests). The default loop runs until signalled.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { fenceFor, loadActiveSituations, type ActiveSituation } from "./situations.ts";
import { loadAll, type RoutineEntry } from "./registry.ts";
import { locksDir, runsDir } from "./paths.ts";
import { nextAfter } from "./rrule.ts";
import { patchState, readState } from "./state.ts";
import { isHarnessOutaged } from "./harness-outage.ts";
import { routesForFire, runRoutine, type RunResult } from "./runner.ts";
import { loadProjectConfig } from "./project-config.ts";
import { captureRoutineRunFailure, captureRoutinesException } from "./observability.ts";

/** True when at least one route in the chain is not currently outaged. */
function hasHealthyFallback(entry: RoutineEntry): boolean {
  try {
    return routesForFire(entry).some((r) => !isHarnessOutaged(r.harness));
  } catch {
    return false;
  }
}

export interface DaemonOptions {
  once?: boolean;
  /** ms between ticks in loop mode (default 15s). */
  tickMs?: number;
  /**
   * Max concurrently-running routines.
   * `0` or unset = unlimited (default). Positive N = hard cap (optional).
   */
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
    | "situations-degraded"
    | "reconcile-orphans";
  id?: string;
  detail?: string;
}

function defaultLog(event: DaemonEvent): void {
  process.stderr.write(JSON.stringify(event) + "\n");
}

/**
 * Normalize concurrency: `0` / negative / non-finite / undefined → unlimited (0).
 * Positive integers are a hard cap.
 */
export function normalizeConcurrency(raw: number | undefined | null): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/** Human-readable concurrency for logs (`unlimited` or a number). */
export function formatConcurrency(n: number): string {
  const c = normalizeConcurrency(n);
  return c <= 0 ? "unlimited" : String(c);
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

export interface OrphanedRunInfo {
  id: string;
  stamp: string;
  runDir: string;
  harnessPid: number | null;
  clearedLock: boolean;
}

/**
 * Scan runsDir for run dirs still marked `status:"running"` whose harness pid
 * is no longer alive — evidence of a prior routinesd process dying/restarting
 * mid-run without ever reaching the runner's finalize() (the only other place
 * that writes a terminal meta.json). Rewrite those to `status:"orphaned"` and
 * clear any matching dead single-flight lock so they stop looking
 * forever-running to status reads and fleet-health passes.
 */
export function reconcileOrphanedRuns(now: Date = new Date()): OrphanedRunInfo[] {
  const base = runsDir();
  if (!existsSync(base)) return [];
  const orphaned: OrphanedRunInfo[] = [];
  let ids: string[];
  try {
    ids = readdirSync(base);
  } catch {
    return [];
  }
  for (const id of ids) {
    const idDir = join(base, id);
    let stamps: string[];
    try {
      stamps = readdirSync(idDir);
    } catch {
      continue;
    }
    for (const stamp of stamps) {
      const runDir = join(idDir, stamp);
      const metaPath = join(runDir, "meta.json");
      if (!existsSync(metaPath)) continue;
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (meta.status !== "running") continue;
      const harnessPid = typeof meta.harnessPid === "number" ? meta.harnessPid : null;
      if (harnessPid != null && pidAlive(harnessPid)) continue; // legitimately still running
      meta.status = "orphaned";
      if (typeof meta.finishedAt !== "string") meta.finishedAt = now.toISOString();
      const lockPid = readLockPid(id);
      let clearedLock = false;
      if (lockPid != null && !pidAlive(lockPid)) {
        try {
          rmSync(lockPath(id), { force: true });
          clearedLock = true;
        } catch {
          /* best effort */
        }
      }
      try {
        writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
        orphaned.push({ id, stamp, runDir, harnessPid, clearedLock });
      } catch {
        /* best effort */
      }
    }
  }
  return orphaned;
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


/** Prefer never-fired, then oldest lastFire, so skip-capped work is not starved
 * by a just-completed (or catch-up) routine that sorts first alphabetically. */
function lastFireSortKey(id: string): number {
  const st = readState(id);
  if (!st.lastFire) return Number.NEGATIVE_INFINITY;
  const t = new Date(st.lastFire).getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

interface DispatchDeps {
  now: Date;
  situations: ActiveSituation[];
  inFlight: Set<string>;
  /** 0 = unlimited. */
  concurrency: number;
  log: (e: DaemonEvent) => void;
  running: Promise<RunResult>[];
  /** Free-slot pool: called after a run releases its slot. */
  onSlotFree?: () => void;
}

function tryDispatch(entry: RoutineEntry, occ: Date, deps: DispatchDeps): void {
  const { now, situations, inFlight, concurrency, log } = deps;

  // Already tracked as running in this daemon process.
  if (inFlight.has(entry.id)) {
    log({ ts: now.toISOString(), kind: "skip-single-flight", id: entry.id });
    return;
  }

  // Situation fence — check first so a fenced routine is never dispatched, and
  // advance its last-fire so we don't re-evaluate the same instant every tick.
  // Exception: harness-outage-* situations that left scope_routines empty (or
  // a stale fence on a harness that still has a healthy fallback) — runRoutine
  // will skip the dead primary and use the chain.
  const fence = fenceFor(entry.id, situations);
  if (fence.fenced) {
    const sitSlug = fence.situationSlug ?? "unknown";
    const canFallback =
      /^harness-outage-/.test(sitSlug) && hasHealthyFallback(entry);
    if (!canFallback) {
      patchState(entry.id, { lastFire: occ.toISOString(), lastSkip: `fence:${sitSlug}` });
      log({
        ts: now.toISOString(),
        kind: "skip-fence",
        id: entry.id,
        detail: `Situation ${sitSlug} scope_routines=${fence.pattern ?? ""}`,
      });
      return;
    }
    log({
      ts: now.toISOString(),
      kind: "dispatch",
      id: entry.id,
      detail: `fence ${sitSlug} bypassed via fallback chain`,
    });
  }

  // Optional hard cap only when concurrency > 0. Unlimited (0) never skip-caps.
  if (concurrency > 0 && inFlight.size >= concurrency) {
    log({
      ts: now.toISOString(),
      kind: "skip-cap",
      id: entry.id,
      detail: `at cap ${concurrency}`,
    });
    return; // leave lastFire unchanged — free-slot pool retries when a slot frees
  }

  if (isLocked(entry.id) || !acquireLock(entry.id)) {
    log({ ts: now.toISOString(), kind: "skip-single-flight", id: entry.id });
    return;
  }

  patchState(entry.id, { lastFire: occ.toISOString() });
  inFlight.add(entry.id);
  log({
    ts: now.toISOString(),
    kind: "dispatch",
    id: entry.id,
    detail: `${entry.harness}/${entry.model}`,
  });

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
      // Defer refill so we never re-enter the admit loop mid-dispatch scan.
      if (deps.onSlotFree) {
        queueMicrotask(() => deps.onSlotFree?.());
      }
    });
  deps.running.push(p);
}

export interface DispatchPassOptions extends DaemonOptions {
  /** Shared in-flight set (daemon loop). Fresh set per call if omitted. */
  inFlight?: Set<string>;
  /** Free-slot pool callback when any started run completes. */
  onSlotFree?: () => void;
  /** When false, do not emit a tick log line (internal refills). Default true. */
  emitTick?: boolean;
}

/**
 * Scan the registry and start every due routine that fits capacity.
 * Returns promises for runs *started this pass* (not all in-flight).
 * Does not await them — caller decides (evaluateOnce waits; startDaemon does not).
 */
export function dispatchDue(opts: DispatchPassOptions = {}): Promise<RunResult>[] {
  const log = opts.log ?? defaultLog;
  const concurrency = normalizeConcurrency(opts.concurrency);
  const catchupMs = opts.catchupMs ?? 0;
  const now = new Date();
  const inFlight = opts.inFlight ?? new Set<string>();
  const emitTick = opts.emitTick !== false;

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

  const running: Promise<RunResult>[] = [];
  const deps: DispatchDeps = {
    now,
    situations: check.situations,
    inFlight,
    concurrency,
    log,
    running,
    onSlotFree: opts.onSlotFree,
  };

  if (emitTick) {
    const cap = formatConcurrency(concurrency);
    log({
      ts: now.toISOString(),
      kind: "tick",
      detail: `${entries.length} routines in_flight=${inFlight.size} concurrency=${cap}`,
    });
  }

  // Collect due work first, then admit in fair order (never-fired / oldest lastFire).
  const due: { entry: (typeof entries)[number]; occ: Date }[] = [];
  for (const entry of entries) {
    if (entry.status !== "active") continue;
    const occ = dueOccurrence(entry, now, catchupMs, log);
    if (!occ) continue;
    due.push({ entry, occ });
  }
  due.sort((a, b) => {
    const ka = lastFireSortKey(a.entry.id);
    const kb = lastFireSortKey(b.entry.id);
    if (ka !== kb) return ka - kb;
    return a.entry.id.localeCompare(b.entry.id);
  });
  for (const { entry, occ } of due) {
    tryDispatch(entry, occ, deps);
  }

  return running;
}

/** One evaluation pass. Waits for every run started in this pass (tests / --once). */
export async function evaluateOnce(opts: DaemonOptions = {}): Promise<RunResult[]> {
  const started = dispatchDue(opts);
  return Promise.all(started);
}

export interface DaemonHandle {
  stop: () => void;
  done: Promise<void>;
}

/**
 * Run the scheduler as a free-slot pool until stop() is called.
 *
 * - Periodic ticks re-scan due work.
 * - When any run completes, a refill pass admits the next due routine immediately
 *   (does not wait for the rest of an artificial "batch" to finish).
 * - Default concurrency is unlimited; optional positive cap still works.
 */
export function startDaemon(opts: DaemonOptions = {}): DaemonHandle {
  const tickMs = opts.tickMs ?? 15_000;
  const concurrency = normalizeConcurrency(opts.concurrency);
  const catchupMs = opts.catchupMs ?? 0;
  const log = opts.log ?? defaultLog;

  const orphaned = reconcileOrphanedRuns();
  if (orphaned.length > 0) {
    log({
      ts: new Date().toISOString(),
      kind: "reconcile-orphans",
      detail: `finalized ${orphaned.length} orphaned run(s): ${orphaned
        .map((o) => `${o.id}/${o.stamp}`)
        .join(", ")}`,
    });
  }

  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  /** Persistent across ticks — the free-slot pool membership. */
  const inFlight = new Set<string>();

  // Serialize admit passes; queue another if a slot frees mid-scan.
  let admitting = false;
  let admitAgain = false;

  const admitDue = (): void => {
    if (stopped) return;
    if (admitting) {
      admitAgain = true;
      return;
    }
    admitting = true;
    try {
      do {
        admitAgain = false;
        // Fire-and-forget: do not await started runs (that was the batch freeze).
        dispatchDue({
          concurrency,
          catchupMs,
          log,
          inFlight,
          emitTick: true,
          onSlotFree: () => {
            if (!stopped) admitDue();
          },
        });
      } while (admitAgain && !stopped);
    } catch (err) {
      captureRoutinesException(err, { tags: { service: "routinesd", phase: "admit" } });
      log({
        ts: new Date().toISOString(),
        kind: "registry-error",
        detail: `admit failed: ${(err as Error).message}`,
      });
    } finally {
      admitting = false;
      if (admitAgain && !stopped) {
        // A completion arrived during finally — run one more pass.
        voidPromiseThen(() => admitDue());
      }
    }
  };

  const loop = async () => {
    while (!stopped) {
      try {
        admitDue();
      } catch (err) {
        captureRoutinesException(err, { tags: { service: "routinesd", phase: "tick" } });
        log({
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
  // Start the loop without blocking the caller.
  loop().catch((err) => {
    captureRoutinesException(err, { tags: { service: "routinesd", phase: "loop" } });
  });

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

/** Schedule fn on the next microtask without using the `void` operator (bun parse). */
function voidPromiseThen(fn: () => void): void {
  Promise.resolve().then(fn);
}
