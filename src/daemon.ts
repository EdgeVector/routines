// routinesd — the single scheduler/dispatcher.
//
// Free-slot pool (not batch-wait):
//   Each tick (and every time a run completes) the daemon loads the registry,
//   finds due routines, and starts them. Completing a run frees its slot
//   immediately and the next due routine is admitted — the scheduler never
//   blocks on Promise.all of a whole batch.
//
// Dispatch constraints:
//   - per-routine single-flight (lock file; a routine never overlaps itself)
//   - a global minimum GAP between kickoffs (default 60s). There is no
//     concurrency cap: a cap SKIPS a due routine, and a skipped run is work
//     that silently never happened. A stagger delays instead, so every due
//     routine still runs — just not all in the same instant. This is what
//     stops a post-outage recovery tick from starting dozens of agent
//     harnesses at once.
//   - per-run timeout_min (runner kills that process only)
//   - dispatch-time Situation fence
//
// `--once` runs a single evaluation pass and waits for the jobs it started
// (used by e2e/tests). The default loop runs until signalled.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fenceFor, loadActiveSituations, type ActiveSituation } from "./situations.ts";
import { isHarness, loadAll, type Harness, type RoutineEntry } from "./registry.ts";
import { resolveDifficulty } from "./difficulty-matrix.ts";
import { daemonIdentityPath, daemonLogDir, locksDir, runsDir } from "./paths.ts";
import { nextAfter } from "./rrule.ts";
import { patchState, readState } from "./state.ts";
import { isHarnessOutaged } from "./harness-outage.ts";
import { routesForFire, runRoutine, type RunResult } from "./runner.ts";
import { readOutcomeSink } from "./runs.ts";
import { parseOutcomeSink, OUTCOME_SINK_FILENAME } from "./outcome.ts";
import { loadProjectConfig } from "./project-config.ts";
import { captureRoutineRunFailure, captureRoutinesException } from "./observability.ts";
import { loadCapacityPolicy, planCapacity, type CapacityPolicy } from "./capacity.ts";

function harnessFromOutageSituation(slug: string): string | null {
  const m = slug.match(/^harness-outage-(.+)$/);
  return m?.[1] ?? null;
}

/**
 * Resolve a matrix route against the active provider-outage Situations for
 * this dispatch pass. Explicit and legacy pins are deliberately unchanged.
 */
export function routeForAvailability(
  entry: RoutineEntry,
  situations: ActiveSituation[],
): RoutineEntry {
  if (entry.resolvedBy !== "matrix" || !entry.difficulty) return entry;
  const unavailable = new Set<Harness>();
  for (const situation of situations) {
    const harness = harnessFromOutageSituation(situation.slug);
    if (harness && isHarness(harness)) unavailable.add(harness);
  }
  const resolution = resolveDifficulty(entry.difficulty, unavailable);
  if (resolution.harness === entry.harness && resolution.model === entry.model) return entry;
  return {
    ...entry,
    harness: resolution.harness,
    model: resolution.model,
    matrixResolution: resolution,
  };
}

/** True when the route the runner would select avoids the fenced harness. */
function canBypassHarnessOutageFence(entry: RoutineEntry, situationSlug: string): boolean {
  const fencedHarness = harnessFromOutageSituation(situationSlug);
  if (!fencedHarness) return false;
  try {
    const route = routesForFire(entry)[0];
    if (!route || route.harness === fencedHarness) return false;
    return !isHarnessOutaged(route.harness);
  } catch {
    return false;
  }
}

export interface DaemonOptions {
  once?: boolean;
  /** ms between ticks in loop mode (default 15s). */
  tickMs?: number;
  /**
   * Minimum ms between any two routine kickoffs (default 60s, or
   * ROUTINES_STAGGER_MS). `0` disables staggering and lets every due routine
   * start in the same instant — the pre-2026-08-27 stampede behaviour.
   */
  staggerMs?: number;
  /** Consider a never-fired routine due if it has an occurrence within this
   * window (ms) before now. 0 = cron semantics (warm up, no catch-up). The e2e
   * passes a positive value so a fresh routine fires in a single --once pass. */
  catchupMs?: number;
  /** Structured log sink (default: stderr JSON lines). */
  log?: (event: DaemonEvent) => void;
  /** Tier-aware quota admission. Defaults to the routines-owned policy file. */
  capacityPolicy?: CapacityPolicy | false;
}

export interface DaemonEvent {
  ts: string;
  kind:
    | "tick"
    | "dispatch"
    | "complete"
    | "skip-fence"
    | "skip-single-flight"
    | "defer-stagger"
    | "skip-capacity-policy"
    | "capacity"
    | "warmup"
    | "registry-error"
    | "situations-degraded"
    | "reconcile-orphans"
    | "coalesce-backlog"
    | "start"
    | "stop";
  id?: string;
  detail?: string;
}

function defaultLog(event: DaemonEvent): void {
  process.stderr.write(JSON.stringify(event) + "\n");
}

/** Default minimum gap between two routine kickoffs. */
export const DEFAULT_STAGGER_MS = 60_000;

/**
 * Resolve the kickoff stagger: explicit option, else ROUTINES_STAGGER_MS, else
 * DEFAULT_STAGGER_MS. Negative / non-finite → the default. An explicit `0`
 * disables staggering (every due routine starts at once).
 */
export function normalizeStaggerMs(raw: number | undefined | null): number {
  if (raw == null) {
    const env = Number(process.env.ROUTINES_STAGGER_MS);
    if (Number.isFinite(env) && env >= 0) return Math.floor(env);
    return DEFAULT_STAGGER_MS;
  }
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_STAGGER_MS;
  return Math.floor(raw);
}

/** Human-readable stagger for logs (`off` or `<n>ms`). */
export function formatStagger(ms: number): string {
  return ms <= 0 ? "off" : `${ms}ms`;
}

function lockPath(id: string): string {
  return join(locksDir(), `${id}.lock`);
}

interface LockInfo {
  /** Legacy/plain owner pid, or the supervising daemon/manual caller pid. */
  pid: number | null;
  /** Supervising routinesd / routines run process that owns final cleanup. */
  ownerPid: number | null;
  /** Live harness child pid once spawn succeeds. */
  harnessPid: number | null;
}

function finitePid(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How long after host-track `current` flips we still name the stop as activate. */
export const HOST_TRACK_ACTIVATE_WINDOW_MS = 10 * 60 * 1000;

/** Who wrote `stopReason` onto this identity. */
export type DaemonStopSource = "self" | "reconstructed" | "inherited";

export interface DaemonIdentity {
  pid: number;
  startedAt: string;
  executable: string | null;
  stopReason: string | null;
  stoppedAt: string | null;
  /**
   * `self` — this pid logged its own graceful stop.
   * `reconstructed` — the successor boot named a prior abrupt death.
   * `inherited` — this pid preserved the prior graceful stop on boot.
   * Missing with a stopReason is a legacy self-stop (parent CR).
   */
  stopSource?: DaemonStopSource | null;
}

export interface ClassifyAbruptStopOptions {
  now?: Date;
  hostTrackCurrentPath?: string;
  windowMs?: number;
}

function currentExecutable(): string | null {
  const argv1 = process.argv[1];
  if (!argv1) return null;
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}

function defaultHostTrackCurrentPath(): string {
  return (
    process.env.ROUTINES_HOST_TRACK_CURRENT ||
    join(homedir(), ".host-track", "apps", "routines", "current")
  );
}

export function readDaemonIdentity(): DaemonIdentity | null {
  const p = daemonIdentityPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<DaemonIdentity>;
    if (typeof raw.pid !== "number" || !Number.isFinite(raw.pid)) return null;
    const stopSource =
      raw.stopSource === "self" ||
      raw.stopSource === "reconstructed" ||
      raw.stopSource === "inherited"
        ? raw.stopSource
        : null;
    return {
      pid: raw.pid,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      executable: typeof raw.executable === "string" ? raw.executable : null,
      stopReason: typeof raw.stopReason === "string" ? raw.stopReason : null,
      stoppedAt: typeof raw.stoppedAt === "string" ? raw.stoppedAt : null,
      stopSource,
    };
  } catch {
    return null;
  }
}

export function writeDaemonIdentity(identity: DaemonIdentity): void {
  mkdirSync(daemonLogDir(), { recursive: true });
  writeFileSync(daemonIdentityPath(), JSON.stringify(identity, null, 2) + "\n");
}

/** Stamp a graceful stop on this process's identity. Overwrites a reconstructed prior reason. */
export function recordDaemonStop(reason: string): void {
  const prev = readDaemonIdentity();
  if (!prev) return;
  if (prev.pid !== process.pid) return;
  if (prev.stopSource === "self") return;
  writeDaemonIdentity({
    ...prev,
    stopReason: reason,
    stoppedAt: new Date().toISOString(),
    stopSource: "self",
  });
}

/** True when the successor boot must emit a reconstructed kind=stop. */
export function priorStopNeedsReconstruct(prev: DaemonIdentity): boolean {
  if (prev.stopSource === "self") return false;
  if (prev.stopSource === "reconstructed" || prev.stopSource === "inherited") return true;
  return !prev.stopReason;
}

/**
 * Name why the previous routinesd died without a graceful stop line.
 * host-track activate is the measured 2026-08-26 cause (symlink mtime
 * at the restart instant, launchd program path under versions/<digest>/).
 */
export function classifyAbruptStop(
  prev: DaemonIdentity,
  opts: ClassifyAbruptStopOptions = {},
): "host-track-activate" | "unknown" {
  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? HOST_TRACK_ACTIVATE_WINDOW_MS;
  const currentPath = opts.hostTrackCurrentPath ?? defaultHostTrackCurrentPath();
  try {
    const st = lstatSync(currentPath);
    if (now.getTime() - st.mtimeMs <= windowMs) return "host-track-activate";
  } catch {
    /* current link missing — fall through */
  }
  if (prev.executable) {
    try {
      const live = realpathSync(currentPath);
      let prevExec = prev.executable;
      try {
        prevExec = realpathSync(prev.executable);
      } catch {
        /* keep the recorded path when it is gone */
      }
      if (live !== prevExec) return "host-track-activate";
    } catch {
      /* ignore */
    }
  }
  return "unknown";
}

function announceDaemonBoot(
  log: (event: DaemonEvent) => void,
  tickMs: number,
  staggerMs: number,
): void {
  const now = new Date();
  const prev = readDaemonIdentity();
  // Host-track activate often starts the new pid while the old pid is still
  // alive. Do not wait for pid death — that skip is why live 23:33Z had
  // kind=start and stopReason=null. Do not kill the prior pid or its locks.
  let reconstructed: { reason: string; priorPid: number } | null = null;
  let inherited: { reason: string; stoppedAt: string } | null = null;
  if (prev && prev.pid !== process.pid && priorStopNeedsReconstruct(prev)) {
    const reason = classifyAbruptStop(prev, { now });
    reconstructed = { reason, priorPid: prev.pid };
    log({
      ts: now.toISOString(),
      kind: "stop",
      detail: `tick loop ended reason=${reason} prior_pid=${prev.pid} reconstructed=true`,
    });
  } else if (prev && prev.pid !== process.pid && prev.stopReason) {
    inherited = {
      reason: prev.stopReason,
      stoppedAt: prev.stoppedAt ?? now.toISOString(),
    };
  }
  writeDaemonIdentity({
    pid: process.pid,
    startedAt: now.toISOString(),
    executable: currentExecutable(),
    stopReason: reconstructed?.reason ?? inherited?.reason ?? null,
    stoppedAt: reconstructed ? now.toISOString() : inherited?.stoppedAt ?? null,
    stopSource: reconstructed ? "reconstructed" : inherited ? "inherited" : null,
  });
  log({
    ts: now.toISOString(),
    kind: "start",
    detail: `pid=${process.pid} tick=${tickMs}ms stagger=${formatStagger(staggerMs)}`,
  });
}

function emitReconcile(log: (event: DaemonEvent) => void): void {
  const orphaned = reconcileOrphanedRuns();
  if (orphaned.length === 0) return;
  log({
    ts: new Date().toISOString(),
    kind: "reconcile-orphans",
    detail: `finalized ${orphaned.length} orphaned run(s): ${orphaned
      .map((o) => `${o.id}/${o.stamp}`)
      .join(", ")}`,
  });
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
function readLockInfo(id: string): LockInfo | null {
  const p = lockPath(id);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").trim();
  // Accept plain pid or JSON {"pid":N,...} for forward compatibility.
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as { pid?: unknown; ownerPid?: unknown; harnessPid?: unknown };
      return {
        pid: finitePid(j.pid),
        ownerPid: finitePid(j.ownerPid),
        harnessPid: finitePid(j.harnessPid),
      };
    } catch {
      return null;
    }
  }
  const pid = Number(raw);
  return Number.isFinite(pid) ? { pid, ownerPid: null, harnessPid: null } : null;
}

function lockInfoHasLiveOwner(info: LockInfo | null): boolean {
  if (!info) return false;
  const candidates = [info.harnessPid, info.ownerPid, info.pid];
  return candidates.some((pid) => pid != null && pidAlive(pid));
}

export function readLockPid(id: string): number | null {
  const info = readLockInfo(id);
  if (!info) return null;
  return info.harnessPid ?? info.ownerPid ?? info.pid;
}

export function lockHasLiveOwner(id: string): boolean {
  return lockInfoHasLiveOwner(readLockInfo(id));
}

export function acquireLock(id: string): boolean {
  mkdirSync(locksDir(), { recursive: true });
  const p = lockPath(id);
  if (existsSync(p)) {
    const info = readLockInfo(id);
    if (lockInfoHasLiveOwner(info)) return false;
    // stale lock: fall through and overwrite
  }
  writeFileSync(
    p,
    JSON.stringify({ pid: process.pid, ownerPid: process.pid, harnessPid: null }) + "\n",
  );
  return true;
}

/** Update the lock owner to the live harness worker after spawn. */
export function setLockOwnerPid(id: string, pid: number): void {
  mkdirSync(locksDir(), { recursive: true });
  const existing = readLockInfo(id);
  const ownerPid = existing?.ownerPid ?? existing?.pid ?? process.pid;
  writeFileSync(
    lockPath(id),
    JSON.stringify({ pid: ownerPid, ownerPid, harnessPid: pid }) + "\n",
  );
}

export function releaseLock(id: string): void {
  const p = lockPath(id);
  try {
    rmSync(p, { force: true });
  } catch {
    /* best effort */
  }
}

export function releaseLockIfOwned(id: string, ownerPid: number): boolean {
  if (readLockPid(id) !== ownerPid) return false;
  const p = lockPath(id);
  try {
    rmSync(p, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function isLocked(id: string): boolean {
  return lockHasLiveOwner(id);
}

export interface OrphanedRunInfo {
  id: string;
  stamp: string;
  runDir: string;
  harnessPid: number | null;
  clearedLock: boolean;
  /** Outcome recovered from the run's own sink, else "unknown". */
  outcome: string;
  outcomeDetail: string | null;
  /** "sink" when outcome.txt supplied the verdict, else "orphan". */
  outcomeSource: string;
  /** True when this run became the routine's visible last run in status. */
  statePatched: boolean;
}

/** Completion time of an orphan: the sink's mtime is the real finish instant. */
function sinkFinishedAt(runDir: string): string | null {
  try {
    return statSync(join(runDir, OUTCOME_SINK_FILENAME)).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Scan runsDir for every run dir still marked `status:"running"` (or with no
 * finishedAt and no terminal status) whose harness pid is no longer alive —
 * evidence of a prior routinesd process dying/restarting mid-run without ever
 * reaching the runner's finalize() (the only other place that writes a
 * terminal meta.json). Rewrite those to `status:"orphaned"` and clear any
 * matching dead single-flight lock so they stop looking forever-running to
 * status reads and fleet-health passes. Live harness pids are left alone.
 *
 * Two things beyond the meta rewrite make an orphan *visible*:
 *
 *  1. The run's own `outcome.txt` sink is authoritative. A detached agent
 *     frequently outlives the daemon that dispatched it and finishes its work;
 *     when it wrote a verdict, that verdict is the run's outcome, not a blank
 *     orphan.
 *  2. Per-routine state is patched, so `routines status --json` reports the
 *     orphaned dispatch instead of silently keeping the previous run's
 *     `lastRun`. State is only moved forward — a newer completed run always
 *     wins over a late-reconciled older orphan.
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
    stamps.sort();
    const newest = stamps.at(-1);
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
      if (!isOrphanCandidate(meta)) continue;
      const harnessPid = typeof meta.harnessPid === "number" ? meta.harnessPid : null;
      if (harnessPid != null && pidAlive(harnessPid)) continue; // legitimately still running

      const sink = parseOutcomeSink(readOutcomeSink(runDir));
      const finishedAt =
        typeof meta.finishedAt === "string"
          ? meta.finishedAt
          : (sink ? sinkFinishedAt(runDir) : null) ?? now.toISOString();
      const outcome = sink?.kind ?? "unknown";
      const outcomeDetail =
        sink?.detail ??
        `orphaned: routinesd restarted mid-run (harness pid ${harnessPid ?? "unknown"} gone, no outcome sink)`;
      const outcomeSource = sink ? "sink" : "orphan";

      meta.status = "orphaned";
      meta.finishedAt = finishedAt;
      meta.outcome = outcome;
      meta.outcomeDetail = outcomeDetail;
      meta.outcomeSource = outcomeSource;
      meta.reconciledAt = now.toISOString();

      let clearedLock = false;
      if (!lockInfoHasLiveOwner(readLockInfo(id))) {
        try {
          rmSync(lockPath(id), { force: true });
          clearedLock = true;
        } catch {
          /* best effort */
        }
      }
      try {
        writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
      } catch {
        continue; // could not finalize — do not claim it in status either
      }

      // Older unfinished dirs behind a newer stamp stay off lastRun.
      const statePatched =
        stamp === newest
          ? adoptOrphanIntoState(id, {
              runDir,
              finishedAt,
              startedAt: typeof meta.startedAt === "string" ? meta.startedAt : null,
              outcome,
              outcomeDetail,
            })
          : false;

      orphaned.push({
        id,
        stamp,
        runDir,
        harnessPid,
        clearedLock,
        outcome,
        outcomeDetail,
        outcomeSource,
        statePatched,
      });
    }
  }
  return orphaned;
}

/** Incomplete run: still running, or never wrote a terminal finishedAt. */
function isOrphanCandidate(meta: Record<string, unknown>): boolean {
  const status = typeof meta.status === "string" ? meta.status : null;
  if (status === "orphaned" || status === "finished") return false;
  if (status === "running") return true;
  if (meta.finishedAt == null && meta.exitCode == null) return true;
  return false;
}

/**
 * Make an orphaned dispatch the routine's visible last run — unless a newer run
 * already reported. Without this, `routines status` keeps the pre-restart
 * `lastRun` and the dispatch vanishes from every status read and fleet-health
 * pass, which is the failure this reconciliation exists to prevent.
 */
function adoptOrphanIntoState(
  id: string,
  run: {
    runDir: string;
    finishedAt: string;
    startedAt: string | null;
    outcome: string;
    outcomeDetail: string | null;
  },
): boolean {
  const st = readState(id);
  if (st.lastRunDir === run.runDir) return false; // already adopted
  // A run that finished after this one started is strictly newer; leave it.
  const boundary = run.startedAt ?? run.finishedAt;
  if (st.lastRun && st.lastRun > boundary) return false;
  patchState(id, {
    lastRun: run.finishedAt,
    lastRunDir: run.runDir,
    lastExit: null,
    lastOutcome: run.outcome,
    lastOutcomeDetail: run.outcomeDetail ?? undefined,
  });
  return true;
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
  let occ = nextAfter(entry.parsedRrule, since);
  if (!occ || occ.getTime() > now.getTime()) return null;

  // `since` can fall far behind `now` for reasons unrelated to the routine's
  // own cadence (a long Situation fence, a paused status just lifted, a
  // registry edit that widens the interval, daemon downtime). Naively
  // returning the *first* missed occurrence makes the caller replay every
  // instant the routine missed one dispatch at a time — each firing looks
  // "due" again the moment the previous run finishes, so a routine on an
  // hourly-or-slower RRULE tight-loops for as long as it takes to work
  // through the backlog instead of respecting its configured interval.
  // Coalesce: skip straight to the *latest* occurrence at or before `now` and
  // fire once for the whole backlog.
  for (let skipped = 0; skipped < MAX_COALESCE_BACKLOG; skipped++) {
    const next = nextAfter(entry.parsedRrule, occ);
    if (!next || next.getTime() > now.getTime()) break;
    occ = next;
    if (skipped === 0) {
      log({
        ts: now.toISOString(),
        kind: "coalesce-backlog",
        id: entry.id,
        detail: `since=${since.toISOString()}`,
      });
    }
  }
  return occ;
}

/** Safety bound on how many missed occurrences a single dueOccurrence() call
 * will skip past when coalescing a backlog (belt-and-suspenders against a
 * pathological RRULE; real backlogs seen in practice are under 20). */
const MAX_COALESCE_BACKLOG = 100_000;


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
  /** Minimum ms between kickoffs; 0 = no stagger. */
  staggerMs: number;
  /** Mutable, shared across ticks: epoch ms of the most recent kickoff. */
  lastDispatch: { at: number | null };
  log: (e: DaemonEvent) => void;
  running: Promise<RunResult>[];
  /** Free-slot pool: called after a run releases its slot. */
  onSlotFree?: () => void;
}

/**
 * Is a kickoff allowed right now?
 *
 * Deliberately NOT a concurrency cap. A cap decides a due routine does not
 * run, and that lost run leaves no trace afterwards. This decides only that it
 * does not run *yet*: the caller leaves `lastFire` untouched, so the routine
 * stays due and a later tick admits it. Because the admit list is sorted
 * oldest-lastFire-first, the longest-waiting routine goes first, so a backlog
 * drains in fair order rather than starving anyone.
 */
function staggerAllows(lastDispatch: { at: number | null }, staggerMs: number): boolean {
  if (staggerMs <= 0 || lastDispatch.at === null) return true;
  // Real time, NOT the pass's `now`. A pass stamps `now` before it loads the
  // registry, situations and the capacity policy, so by the time a routine
  // actually starts, `now` is already stale by however long that took. Gating
  // on `now` leaks that drift into the gap: measured kickoff-to-kickoff, two
  // routines could land ~40ms apart under a 100ms stagger. Comparing real
  // instants is what makes the promised gap the OBSERVED gap.
  return Date.now() - lastDispatch.at >= staggerMs;
}

function tryDispatch(entry: RoutineEntry, occ: Date, deps: DispatchDeps): void {
  const { now, situations, inFlight, lastDispatch, log } = deps;

  // Already tracked as running in this daemon process.
  if (inFlight.has(entry.id)) {
    log({ ts: now.toISOString(), kind: "skip-single-flight", id: entry.id });
    return;
  }

  // Situation fence — check first so a fenced routine is never dispatched, and
  // advance its last-fire so we don't re-evaluate the same instant every tick.
  // Exception: harness-outage-* situations that left scope_routines empty (or
  // a stale fence on a harness whose selected route has moved to an alternate)
  // — runRoutine will avoid the fenced harness and use the chain.
  const fence = fenceFor(entry.id, situations);
  if (fence.fenced) {
    const sitSlug = fence.situationSlug ?? "unknown";
    const canFallback =
      /^harness-outage-/.test(sitSlug) && canBypassHarnessOutageFence(entry, sitSlug);
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

  if (isLocked(entry.id) || !acquireLock(entry.id)) {
    log({ ts: now.toISOString(), kind: "skip-single-flight", id: entry.id });
    return;
  }

  patchState(entry.id, { lastFire: occ.toISOString() });
  inFlight.add(entry.id);
  lastDispatch.at = Date.now();
  log({
    ts: now.toISOString(),
    kind: "dispatch",
    id: entry.id,
    detail: `${entry.harness}/${entry.model}`,
  });

  let finishedResult: RunResult | null = null;
  const p = runRoutine(entry, { quiet: true })
    .then((result) => {
      finishedResult = result;
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
      releaseLockIfOwned(entry.id, finishedResult?.harnessPid ?? process.pid);
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
  /**
   * Shared last-kickoff clock (daemon loop). Fresh holder per call if omitted,
   * which means a standalone pass never defers its first dispatch.
   */
  lastDispatch?: { at: number | null };
  /** Free-slot pool callback when any started run completes. */
  onSlotFree?: () => void;
  /** When false, do not emit a tick log line (internal refills). Default true. */
  emitTick?: boolean;
}

/**
 * Scan the registry and start due routines, honouring the kickoff stagger.
 * Returns promises for runs *started this pass* (not all in-flight).
 * Routines held back by the stagger keep their lastFire, so they stay due.
 * Does not await them — caller decides (evaluateOnce waits; startDaemon does not).
 */
export function dispatchDue(opts: DispatchPassOptions = {}): Promise<RunResult>[] {
  const log = opts.log ?? defaultLog;
  const staggerMs = normalizeStaggerMs(opts.staggerMs);
  const catchupMs = opts.catchupMs ?? 0;
  const now = new Date();
  const inFlight = opts.inFlight ?? new Set<string>();
  const lastDispatch = opts.lastDispatch ?? { at: null };
  const emitTick = opts.emitTick !== false;

  const { entries: registryEntries, errors } = loadAll();
  for (const e of errors) {
    log({ ts: now.toISOString(), kind: "registry-error", detail: e.message });
  }

  // Warm project config cache (configurations app) so runners inherit PATH / workspace.
  loadProjectConfig();

  const check = loadActiveSituations();
  if (!check.ok) {
    log({ ts: now.toISOString(), kind: "situations-degraded", detail: check.error });
  }
  const entries = registryEntries.map((entry) => routeForAvailability(entry, check.situations));

  const running: Promise<RunResult>[] = [];
  const deps: DispatchDeps = {
    now,
    situations: check.situations,
    inFlight,
    staggerMs,
    lastDispatch,
    log,
    running,
    onSlotFree: opts.onSlotFree,
  };

  if (emitTick) {
    emitReconcile(log);
    log({
      ts: now.toISOString(),
      kind: "tick",
      detail: `${entries.length} routines in_flight=${inFlight.size} stagger=${formatStagger(staggerMs)}`,
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
  let policy: CapacityPolicy;
  try {
    policy = opts.capacityPolicy === false
      ? { enabled: false, staleAfterSeconds: 1, unsetTier: "shed", harnesses: {} }
      : (opts.capacityPolicy ?? loadCapacityPolicy());
  } catch (err) {
    // A malformed policy must fail closed for non-spine work without taking
    // the essential shipping loop down with it.
    policy = { enabled: true, staleAfterSeconds: 1, unsetTier: "shed", harnesses: {} };
    log({
      ts: now.toISOString(),
      kind: "capacity",
      detail: `invalid policy; spine-only fail-closed: ${(err as Error).message}`,
    });
  }
  const deferredByStagger: string[] = [];
  const capacityPlan = planCapacity(due, policy, now);
  for (const allowance of capacityPlan.allowances) {
    log({
      ts: now.toISOString(),
      kind: "capacity",
      detail: `${allowance.harness} ${allowance.state} ${allowance.detail} slots=${allowance.fireSlots}`,
    });
  }
  for (const decision of capacityPlan.decisions) {
    const entry = decision.entry;
    const occ = due.find((item) => item.entry.id === entry.id)?.occ;
    if (!occ) continue;
    if (!decision.admitted) {
      log({
        ts: now.toISOString(),
        kind: "skip-capacity-policy",
        id: entry.id,
        detail: `tier=${decision.tier} ${decision.reason}`,
      });
      continue;
    }
    if (!staggerAllows(lastDispatch, staggerMs)) {
      // Everything still in this pass shares one `now`, so nothing else can
      // clear the gate either. Count the rest and emit ONE line — a backlog
      // drain would otherwise log a deferral per routine per tick.
      deferredByStagger.push(entry.id);
      continue;
    }
    tryDispatch(entry, occ, deps);
  }

  if (deferredByStagger.length > 0) {
    const sinceMs = lastDispatch.at === null ? 0 : Date.now() - lastDispatch.at;
    log({
      ts: now.toISOString(),
      kind: "defer-stagger",
      detail:
        `${deferredByStagger.length} due, held ${sinceMs}ms into a ${staggerMs}ms gap: ` +
        `${deferredByStagger.slice(0, 5).join(",")}` +
        `${deferredByStagger.length > 5 ? ` +${deferredByStagger.length - 5} more` : ""}`,
    });
  }

  return running;
}

/** One evaluation pass. Waits for every run started in this pass (tests / --once). */
export async function evaluateOnce(opts: DaemonOptions = {}): Promise<RunResult[]> {
  const started = dispatchDue(opts);
  return Promise.all(started);
}

export interface DaemonHandle {
  /** `reason` is logged on the terminal `kind:"stop"` line (default "stop()"). */
  stop: (reason?: string) => void;
  done: Promise<void>;
}

/**
 * Run the scheduler as a free-slot pool until stop() is called.
 *
 * - Periodic ticks re-scan due work.
 * - When any run completes, a refill pass admits the next due routine immediately
 *   (does not wait for the rest of an artificial "batch" to finish).
 * - There is no concurrency cap. Kickoffs are separated by at least
 *   `staggerMs` (default 60s) so a recovery tick spreads its backlog over
 *   time instead of starting every due routine at once.
 */
export function startDaemon(opts: DaemonOptions = {}): DaemonHandle {
  const tickMs = opts.tickMs ?? 15_000;
  const staggerMs = normalizeStaggerMs(opts.staggerMs);
  const catchupMs = opts.catchupMs ?? 0;
  const log = opts.log ?? defaultLog;

  announceDaemonBoot(log, tickMs, staggerMs);
  emitReconcile(log);

  let stopped = false;
  let stopReason = "unknown";
  let wakeTick: (() => void) | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  /** Persistent across ticks — the free-slot pool membership. */
  const inFlight = new Set<string>();
  /** Persistent across ticks — when the last kickoff happened. */
  const lastDispatch: { at: number | null } = { at: null };

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
          staggerMs,
          catchupMs,
          log,
          inFlight,
          lastDispatch,
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
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const wake = () => {
          clearTimeout(timer);
          if (wakeTick === wake) wakeTick = null;
          resolve();
        };
        timer = setTimeout(wake, tickMs);
        wakeTick = wake;
      });
    }
    // The tick loop is the daemon's whole reason to exist. A gap in dispatches
    // is only diagnosable after the fact when its end is on the record, so
    // every exit path from here logs why.
    log({
      ts: new Date().toISOString(),
      kind: "stop",
      detail: `tick loop ended reason=${stopReason} in_flight=${inFlight.size}`,
    });
    resolveDone();
  };
  // Start the loop without blocking the caller.
  loop().catch((err) => {
    captureRoutinesException(err, { tags: { service: "routinesd", phase: "loop" } });
    log({
      ts: new Date().toISOString(),
      kind: "stop",
      detail: `tick loop threw reason=${(err as Error).message}`,
    });
    resolveDone();
  });

  return {
    stop: (reason = "stop()") => {
      if (!stopped) {
        stopReason = reason;
        recordDaemonStop(reason);
      }
      stopped = true;
      wakeTick?.();
    },
    done,
  };
}

/** Schedule fn on the next microtask without using the `void` operator (bun parse). */
function voidPromiseThen(fn: () => void): void {
  Promise.resolve().then(fn);
}
