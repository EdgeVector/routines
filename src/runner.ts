// Run executor: spawn one harness invocation for a routine, capture its output
// to a per-run log directory, enforce a timeout, and record the outcome +
// heartbeat.
//
// On harness-outage failures (credits / quota / capacity / auth), walks the
// fallback chain (primary → Claude Sonnet → Grok by default) in the same fire
// so work continues without fencing the fleet idle. See `fallback.ts`.
//
// Per-run logs land at $ROUTINES_HOME/runs/<id>/<ts>/ containing:
//   meta.json  — prompt-elided invocation, harness/model, exit code, timing
//   prompt.txt — the exact prompt dispatched
//   stdout.log / stderr.log — captured streams (appended as data arrives)
// This is the durable evidence the card's VERIFY asks for.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";

import { buildInvocation, type HarnessInvocation } from "./adapters.ts";
import { releaseLockIfOwned, setLockOwnerPid } from "./daemon.ts";
import { stripUnresolvedSentryLocators } from "./observability.ts";
import {
  buildRouteChain,
  entryForRoute,
  fallbackEnabled,
  formatRoute,
  timeoutMinForRoute,
  type RouteStep,
} from "./fallback.ts";
import {
  releaseFallbackSlot,
  waitForFallbackSlot,
} from "./fallback-slots.ts";
import {
  classifyHarnessOutage,
  handleHarnessOutage,
  isHarnessOutaged,
} from "./harness-outage.ts";
import type { RoutineEntry } from "./registry.ts";
import { buildRoutineAttributionEnv, resolveDispatchPrompt } from "./prompt.ts";
import { runsDir } from "./paths.ts";
import { writeHeartbeat, type HeartbeatOutcome } from "./heartbeat.ts";
import {
  filterBenignHarnessNoise,
  OUTCOME_SINK_FILENAME,
  parseOutcome,
  parseOutcomeSink,
  type RunOutcome,
} from "./outcome.ts";
import { readOutcomeSink } from "./runs.ts";
import { patchState, readState } from "./state.ts";
import { envFromProjectConfig, loadProjectConfig, resolveRoutineCwd } from "./project-config.ts";
import { discoveredRoutineSocketEnv } from "./socket-env.ts";
import {
  escalateRoutineError,
  retractEscalateStateIfRecovered,
  shouldAutoEscalateScheduledRun,
  shouldEscalate,
} from "./error-escalate.ts";
import { enrichWorktreeCleanupLivenessEnv } from "./worktree-liveness.ts";

export interface RunResult {
  id: string;
  runDir: string;
  invocation: HarnessInvocation;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  heartbeat: HeartbeatOutcome;
  outcome: RunOutcome;
  /** Live harness process id while running / last known after exit. */
  harnessPid: number | null;
}

// Timestamp safe for a directory name (no colons): 2026-07-12T21-05-00-123Z.
function runStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export interface RunOptions {
  /** Suppress live streaming to the parent's stdout/stderr (default: stream). */
  quiet?: boolean;
  /**
   * Scheduled daemon fires own fleet health state. Manual run-now is a
   * foreground verification path; it writes run logs but must not make the
   * scheduler look red or auto-file routine-error cards when the caller's local
   * harness environment is the only thing broken.
   */
  trigger?: "scheduled" | "manual";
  /** Skip same-run fallback chain (tests / explicit single-route). */
  noFallback?: boolean;
}

interface FallbackAttempt {
  harness: string;
  model: string;
  runDir: string;
  exitCode: number | null;
  outcome: string;
  outage: boolean;
  /**
   * Wall-clock budget this leg ran under, in minutes — scaled for a
   * non-primary harness. Recorded so an exit 124 can be read against the
   * budget that actually applied, without going back to the registry row.
   */
  timeoutMin: number;
}

const DEFAULT_RUN_LOG_MAX_BYTES = 2_000_000;
const MIN_RUN_LOG_MAX_BYTES = 8_192;

/** Write early meta.json so operators can inspect a live run before exit. */
export function writeEarlyMeta(args: {
  runDir: string;
  id: string;
  trigger: "scheduled" | "manual";
  harness: string;
  model: string;
  effort: string | null | undefined;
  cwd: string;
  command: string;
  startedAt: string;
  harnessPid: number | null;
  status?: "running" | "spawn_failed";
  resolvedBy?: "matrix" | "pin";
  difficulty?: string;
  matrixResolution?: RoutineEntry["matrixResolution"];
  gateCommand?: string | null;
  gateProceeded?: boolean;
  gateSkippedHarness?: boolean;
}): void {
  writeRunFile(
    join(args.runDir, "meta.json"),
    JSON.stringify(
      {
        id: args.id,
        trigger: args.trigger,
        harness: args.harness,
        model: args.model,
        effort: args.effort ?? null,
        cwd: args.cwd,
        command: args.command,
        startedAt: args.startedAt,
        harnessPid: args.harnessPid,
        daemonPid: process.pid,
        status: args.status ?? "running",
        resolvedBy: args.resolvedBy ?? "pin",
        difficulty: args.difficulty ?? null,
        matrixResolution: args.matrixResolution ?? null,
        exitCode: null,
        finishedAt: null,
        ...(args.gateCommand
          ? {
              gateCommand: args.gateCommand,
              gateProceeded: args.gateProceeded === true,
              gateSkippedHarness: args.gateSkippedHarness === true,
            }
          : {}),
      },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Append a chunk to a run-dir log file (create on first write). Log writes are
 * best-effort so disk-full errors do not kill the scheduler.
 */
export function appendRunLog(
  runDir: string,
  name: "stdout.log" | "stderr.log",
  chunk: string,
  maxBytes: number = runLogMaxBytes(),
): boolean {
  if (chunk.length === 0 || maxBytes <= 0) return true;
  const path = join(runDir, name);
  try {
    const current = fileSize(path);
    const remaining = maxBytes - current;
    if (remaining <= 0) return true;
    const buf = Buffer.from(chunk);
    appendFileSync(path, buf.byteLength <= remaining ? chunk : buf.subarray(0, remaining));
    return true;
  } catch {
    return false;
  }
}

/**
 * Select routes for this fire: skip harnesses already known-outaged when a
 * healthy alternate remains. If every step is outaged, try the full chain so
 * a recovered provider can clear itself on the next real success/failure.
 */
export function routesForFire(entry: RoutineEntry, nowMs: number = Date.now()): RouteStep[] {
  const chain = buildRouteChain(entry);
  if (!fallbackEnabled()) return chain.slice(0, 1);
  const healthy = chain.filter((s) => !isHarnessOutaged(s.harness, nowMs));
  return healthy.length > 0 ? healthy : chain;
}

/**
 * Next index in `routes` that is still live. A fenced middle hop is skipped,
 * not treated as "chain exhausted" — Codex already outaged must not stop a
 * grok-primary fire from reaching Claude.
 */
export function nextLiveRouteIndex(
  routes: RouteStep[],
  fromIndex: number,
  nowMs: number = Date.now(),
): number {
  for (let j = fromIndex; j < routes.length; j++) {
    if (!isHarnessOutaged(routes[j]!.harness, nowMs)) return j;
  }
  return -1;
}

/**
 * Run a routine, walking the fallback chain on harness-outage failures only.
 * Registry TOML is never rewritten — route changes are ephemeral per fire.
 */
export async function runRoutine(entry: RoutineEntry, opts: RunOptions = {}): Promise<RunResult> {
  const trigger = opts.trigger ?? "scheduled";
  const useFallback = fallbackEnabled() && !opts.noFallback;
  const routes = useFallback ? routesForFire(entry) : [buildRouteChain(entry)[0]!];
  const attempts: FallbackAttempt[] = [];
  let last: RunResult | null = null;

  const allRoutesFenced =
    routes.length > 0 && routes.every((step) => isHarnessOutaged(step.harness));
  if (allRoutesFenced) {
    const step = routes[0]!;
    const runEntry = entryForRoute(entry, step);
    const routeMeta: RunOnceMeta = {
      primaryHarness: entry.harness,
      primaryModel: entry.model,
      routeIndex: 0,
      routeCount: routes.length,
      allRoutesFenced: [...new Set(routes.map((route) => route.harness))],
    };

    // A zero-LLM gate is useful precisely when every provider is unavailable.
    // Let the gate finish the routine, but never let an exit-10 gate proceed
    // onto a harness that an active outage fence protects.
    if (runEntry.gateCommand) return runOnce(runEntry, opts, routeMeta);
    return recordAllRoutesFenced(runEntry, opts, routeMeta);
  }

  for (let i = 0; i < routes.length; i++) {
    const step = routes[i]!;
    // An already-fenced hop is skipped, not a reason to stop the fire.
    // Codex-fenced + grok-primary must still reach Claude.
    if (isHarnessOutaged(step.harness)) continue;

    const runEntry = entryForRoute(entry, step);
    const isFallbackLeg = step.harness !== entry.harness;
    let slotToken: string | null = null;
    if (isFallbackLeg) {
      const wait = await waitForFallbackSlot(
        step.harness,
        { pid: process.pid, id: entry.id },
        { deadlineMs: Math.max(1, timeoutMinForRoute(entry, step) * 60_000) },
      );
      if ("overloaded" in wait) {
        last = await recordOverloadedFallback(runEntry, opts, {
          primaryHarness: entry.harness,
          primaryModel: entry.model,
          routeIndex: attempts.length,
          routeCount: routes.length,
        });
        attempts.push({
          harness: step.harness,
          model: step.model,
          runDir: last.runDir,
          exitCode: last.exitCode,
          outcome: last.outcome.kind,
          outage: false,
          timeoutMin: runEntry.timeoutMin,
        });
        annotateFallbackMeta(last, entry, attempts, step);
        const next = nextLiveRouteIndex(routes, i + 1);
        if (next < 0) return last;
        continue;
      }
      slotToken = wait.token;
    }

    try {
      last = await runOnce(runEntry, opts, {
        primaryHarness: entry.harness,
        primaryModel: entry.model,
        routeIndex: attempts.length,
        routeCount: routes.length,
      });
    } finally {
      releaseFallbackSlot(slotToken);
    }

    // Classify outage when the harness itself died — including capacity /
    // usage-limit remapped to clean noop/safe_skip. Do NOT classify pure `ok`
    // runs: agents often quote Situation text containing "at capacity" in
    // successful logs, which re-opened harness-outage + re-paged Telegram in a
    // loop (Tom 2026-07-18).
    const outage =
      last.outcome.kind === "ok" ? null : classifyHarnessOutage(last);
    attempts.push({
      harness: step.harness,
      model: step.model,
      runDir: last.runDir,
      exitCode: last.exitCode,
      outcome: last.outcome.kind,
      outage: Boolean(outage),
      timeoutMin: runEntry.timeoutMin,
    });
    annotateFallbackMeta(last, entry, attempts, step);

    if (outage) {
      const next = nextLiveRouteIndex(routes, i + 1);
      const hasMore = next >= 0;
      try {
        handleHarnessOutage(runEntry, last, outage, {
          quiet: opts.quiet,
          // Fence all routines on this harness only when the chain is exhausted.
          fenceRoutines: !hasMore,
        });
      } catch {
        /* never break caller */
      }

      if (!hasMore) {
        // Outage path already suppressed per-routine cards; skip escalateRoutineError.
        return last;
      }

      if (!opts.quiet) {
        try {
          process.stderr.write(
            `[routines fallback] ${entry.id}: ${formatRoute(step)} outage → trying ${formatRoute(routes[next]!)}\n`,
          );
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    if (!shouldEscalate(last)) {
      // True success (or non-escalating non-outage outcome). Retract any
      // prior failure stamp so recovered routines cannot keep presenting
      // as errored.
      try {
        retractEscalateStateIfRecovered(last, { quiet: opts.quiet });
      } catch {
        /* never break caller */
      }
      return last;
    }

    // Real routine failure — do not hop agents; escalate as before.
    if (trigger === "scheduled" && shouldAutoEscalateScheduledRun(last)) {
      try {
        escalateRoutineError(entry, last, { quiet: opts.quiet });
      } catch {
        /* never break caller */
      }
    }
    return last;
  }

  return last!;
}

interface RunOnceMeta {
  primaryHarness: string;
  primaryModel: string;
  routeIndex: number;
  routeCount: number;
  allRoutesFenced?: string[];
}

/**
 * Record a clean no-dispatch result when every route has an active outage.
 * This keeps manual callers and the daemon out of the null-result path while
 * the harness-outage Situations remain the source of provider health truth.
 */
function recordAllRoutesFenced(
  entry: RoutineEntry,
  opts: RunOptions,
  routeMeta: RunOnceMeta,
  existing?: {
    runDir: string;
    startedAt: Date;
    gateCommand: string | null;
    gateProceeded: boolean;
  },
): RunResult {
  const trigger = opts.trigger ?? "scheduled";
  const startedAt = existing?.startedAt ?? new Date();
  const runDir = existing?.runDir ?? join(runsDir(), entry.id, runStamp(startedAt));
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "scratch"), { recursive: true });

  const harnesses = routeMeta.allRoutesFenced ?? [];
  const detail = `all-routes-fenced harnesses=${harnesses.join(",") || "none"}`;
  const stdout = `ROUTINE_RESULT outcome=noop detail=${detail}\n`;
  writeRunFile(join(runDir, "stdout.log"), stdout);
  writeRunFile(join(runDir, "stderr.log"), "");
  writeRunFile(
    join(runDir, "prompt.txt"),
    "(all routes fenced by active harness outages; harness not spawned)\n",
  );

  const finishedAt = new Date();
  const invocation: HarnessInvocation = {
    bin: "harness-outage-fence",
    args: [],
    display: "harness-outage-fence: all routes fenced",
  };
  const result: RunResult = {
    id: entry.id,
    runDir,
    invocation,
    exitCode: 0,
    signal: null,
    timedOut: false,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    heartbeat: { attempted: false, ok: true },
    outcome: { kind: "noop", detail, source: "safe_skip" },
    harnessPid: null,
  };
  result.heartbeat = writeHeartbeat(entry, result);

  writeRunFile(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        id: entry.id,
        trigger,
        harness: entry.harness,
        model: entry.model,
        effort: entry.effort ?? null,
        cwd: entry.cwd,
        command: invocation.display,
        gateCommand: existing?.gateCommand ?? null,
        gateSkippedHarness: true,
        gateProceeded: existing?.gateProceeded === true,
        fencedRoutes: harnesses,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        harnessPid: null,
        daemonPid: process.pid,
        status: "finished",
        outcome: result.outcome.kind,
        outcomeDetail: result.outcome.detail,
        outcomeSource: result.outcome.source,
        stdoutTail: stdout.trim(),
        stderrTail: "",
        heartbeat: result.heartbeat,
        primaryHarness: routeMeta.primaryHarness,
        primaryModel: routeMeta.primaryModel,
        routeIndex: routeMeta.routeIndex,
        routeCount: routeMeta.routeCount,
        resolvedBy: entry.resolvedBy,
        difficulty: entry.difficulty ?? null,
        matrixResolution: entry.matrixResolution ?? null,
      },
      null,
      2,
    ) + "\n",
  );

  const bootstrapManualStatus =
    trigger === "manual" && result.exitCode === 0 && !readState(entry.id).lastRun;
  if (trigger === "scheduled" || bootstrapManualStatus) {
    patchState(entry.id, {
      lastRun: result.finishedAt,
      lastExit: result.exitCode,
      lastRunDir: runDir,
      lastOutcome: result.outcome.kind,
      lastOutcomeDetail: result.outcome.detail ?? undefined,
    });
  }

  releaseLockIfOwned(entry.id, process.pid);
  return result;
}

/**
 * Fallback hop that could not take a fleet slot before its budget elapsed.
 * Exit 124 + timedOut so classifyHarnessOutage stays null (retry-later).
 */
async function recordOverloadedFallback(
  entry: RoutineEntry,
  opts: RunOptions,
  routeMeta: RunOnceMeta,
): Promise<RunResult> {
  const trigger = opts.trigger ?? "scheduled";
  const startedAt = new Date();
  const runDir = join(runsDir(), entry.id, runStamp(startedAt));
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "scratch"), { recursive: true });
  writeRunFile(join(runDir, "stdout.log"), "");
  writeRunFile(join(runDir, "stderr.log"), "fallback-overloaded retry-later\n");
  writeRunFile(
    join(runDir, "prompt.txt"),
    "(fallback slot overloaded; harness not spawned)\n",
  );
  const finishedAt = new Date();
  const outcome = {
    kind: "noop" as const,
    detail: "fallback-overloaded retry-later",
    source: "safe_skip" as const,
  };
  const invocation: HarnessInvocation = {
    bin: "fallback-slot",
    args: [],
    display: "fallback-slot: overloaded",
  };
  const result: RunResult = {
    id: entry.id,
    runDir,
    invocation,
    exitCode: 124,
    signal: null,
    timedOut: true,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    heartbeat: { attempted: false, ok: true },
    outcome,
    harnessPid: null,
  };
  result.heartbeat = writeHeartbeat(entry, result);
  writeRunFile(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        id: entry.id,
        trigger,
        harness: entry.harness,
        model: entry.model,
        effort: entry.effort ?? null,
        cwd: entry.cwd,
        command: invocation.display,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        harnessPid: null,
        daemonPid: process.pid,
        status: "finished",
        outcome: result.outcome.kind,
        outcomeDetail: result.outcome.detail,
        outcomeSource: result.outcome.source,
        stdoutTail: "",
        stderrTail: "fallback-overloaded retry-later",
        heartbeat: result.heartbeat,
        primaryHarness: routeMeta.primaryHarness,
        primaryModel: routeMeta.primaryModel,
        routeIndex: routeMeta.routeIndex,
        routeCount: routeMeta.routeCount,
        resolvedBy: entry.resolvedBy,
        difficulty: entry.difficulty ?? null,
        matrixResolution: entry.matrixResolution ?? null,
      },
      null,
      2,
    ) + "\n",
  );
  return result;
}

/** Single harness spawn (no fallback). */
async function runOnce(
  entry: RoutineEntry,
  opts: RunOptions,
  routeMeta?: RunOnceMeta,
): Promise<RunResult> {
  const trigger = opts.trigger ?? "scheduled";
  const startedAt = new Date();
  const runDir = join(runsDir(), entry.id, runStamp(startedAt));
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "scratch"), { recursive: true });
  // Prompt after runDir so the envelope can name Run directory / Run-Id trailers.
  const prompt = resolveDispatchPrompt(entry, { runDir });
  const invocation = buildInvocation(entry, prompt);
  writeRunFile(join(runDir, "prompt.txt"), prompt);
  // Empty logs so mid-flight `tail -f` works even before first chunk.
  writeRunFile(join(runDir, "stdout.log"), "");
  writeRunFile(join(runDir, "stderr.log"), "");

  const project = loadProjectConfig();
  const cwd = resolveRoutineCwd(entry.cwd, project);
  const configuredEnv = { ...process.env, ...envFromProjectConfig(project) };
  const childEnv = enrichWorktreeCleanupLivenessEnv(
    entry.id,
    stripUnresolvedSentryLocators(
      enrichGateEnv(entry, {
        ...configuredEnv,
        ...discoveredRoutineSocketEnv(configuredEnv),
        ...buildRoutineAttributionEnv(entry.id, runDir),
      }),
    ),
  );

  // Optional zero-LLM gate: skip expensive harness when the gate says so.
  // Contract (last-stack-kanban-pickup-gate and friends):
  //   exit 10 → proceed to harness
  //   exit 0  → skip harness; honor ROUTINE_RESULT outcome=ok|noop (else noop)
  //   other   → fail the run (config / unexpected error)
  let gateProceeded = false;
  const gateCommandUsed = entry.gateCommand ?? null;
  if (entry.gateCommand) {
    const gated = await runPreDispatchGate(entry, {
      cwd,
      env: childEnv,
      runDir,
      trigger,
      startedAt,
      routeMeta,
    });
    if (gated) return Promise.resolve(gated);
    gateProceeded = true;
  }

  if (routeMeta?.allRoutesFenced) {
    return recordAllRoutesFenced(entry, opts, routeMeta, {
      runDir,
      startedAt,
      gateCommand: gateCommandUsed,
      gateProceeded,
    });
  }

  const maxLogBytes = runLogMaxBytes();
  const stdoutCapture = new BoundedLogCapture(maxLogBytes);
  const stderrCapture = new BoundedLogCapture(maxLogBytes);
  let logWriteFailed = false;

  return new Promise<RunResult>((resolve) => {
    const child = spawn(invocation.bin, invocation.args, {
      cwd,
      env: childEnv,
      detached: true,
      stdio: [invocation.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const harnessPid = child.pid ?? null;
    // Single-flight lock should identify the live harness worker, not only the
    // long-lived daemon parent, so operators / isLocked can see the real owner.
    if (harnessPid != null) {
      setLockOwnerPid(entry.id, harnessPid);
    }

    writeEarlyMeta({
      runDir,
      id: entry.id,
      trigger,
      harness: entry.harness,
      model: entry.model,
      effort: entry.effort,
      cwd: entry.cwd,
      command: invocation.display,
      startedAt: startedAt.toISOString(),
      harnessPid,
      resolvedBy: entry.resolvedBy,
      difficulty: entry.difficulty,
      matrixResolution: entry.matrixResolution,
      gateCommand: gateCommandUsed,
      gateProceeded,
      gateSkippedHarness: false,
    });

    let timedOut = false;
    let sinkStop = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let sinkStopTimer: ReturnType<typeof setTimeout> | null = null;
    let sinkPoll: ReturnType<typeof setInterval> | null = null;
    let sinkWatcher: FSWatcher | null = null;
    const timeoutMs = entry.timeoutMin * 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildGroup(child, "SIGTERM");
      // Escalate if it ignores SIGTERM.
      killTimer = setTimeout(() => killChildGroup(child, "SIGKILL"), sigkillGraceMs());
      killTimer.unref();
    }, timeoutMs);

    const requestSinkStop = (): void => {
      if (sinkStop || timedOut) return;
      if (!parseOutcomeSink(readOutcomeSink(runDir))) return;
      sinkStop = true;
      sinkStopTimer = setTimeout(() => {
        if (timedOut) return;
        killChildGroup(child, "SIGTERM");
        killTimer = setTimeout(() => killChildGroup(child, "SIGKILL"), sigkillGraceMs());
        killTimer.unref();
      }, sinkStopGraceMs());
      sinkStopTimer.unref();
    };

    try {
      sinkWatcher = watch(runDir, () => requestSinkStop());
      sinkWatcher.on("error", () => {
        /* poll remains */
      });
    } catch {
      /* watch is best-effort; poll covers create-after-open */
    }
    sinkPoll = setInterval(() => requestSinkStop(), 250);
    sinkPoll.unref();

    if (invocation.stdin !== undefined) {
      child.stdin?.write(invocation.stdin);
      child.stdin?.end();
    }

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdoutCapture.push(s);
      if (!appendRunLog(runDir, "stdout.log", s, maxLogBytes)) logWriteFailed = true;
      if (!opts.quiet) {
        try {
          process.stdout.write(s);
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderrCapture.push(s);
      if (!appendRunLog(runDir, "stderr.log", s, maxLogBytes)) logWriteFailed = true;
      if (!opts.quiet) {
        try {
          process.stderr.write(s);
        } catch {
          /* ignore */
        }
      }
    });

    child.on("error", (err) => {
      // Spawn failure (e.g. binary not found): record as a failed run.
      const msg = `spawn error: ${err.message}\n`;
      stderrCapture.push(msg);
      if (!appendRunLog(runDir, "stderr.log", msg, maxLogBytes)) logWriteFailed = true;
      writeEarlyMeta({
        runDir,
        id: entry.id,
        trigger,
        harness: entry.harness,
        model: entry.model,
        effort: entry.effort,
        cwd: entry.cwd,
        command: invocation.display,
        startedAt: startedAt.toISOString(),
        harnessPid,
        status: "spawn_failed",
        resolvedBy: entry.resolvedBy,
        difficulty: entry.difficulty,
        matrixResolution: entry.matrixResolution,
        gateCommand: gateCommandUsed,
        gateProceeded,
        gateSkippedHarness: false,
      });
      finalize(null, null);
    });

    child.on("close", (code, signal) => {
      setImmediate(() => finalize(code, signal));
    });

    function finalize(code: number | null, signal: NodeJS.Signals | null): void {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (sinkStopTimer) clearTimeout(sinkStopTimer);
      if (sinkPoll) clearInterval(sinkPoll);
      if (sinkWatcher) {
        try {
          sinkWatcher.close();
        } catch {
          /* ignore */
        }
      }
      const finishedAt = new Date();
      const stdout = stdoutCapture.text();
      const stderr = stderrCapture.text();
      // Final rewrite ensures the on-disk logs match memory even if a chunk
      // handler raced; streaming already wrote the content for mid-flight tail.
      if (!writeRunLog(runDir, "stdout.log", stdout, maxLogBytes)) logWriteFailed = true;
      if (!writeRunLog(runDir, "stderr.log", stderr, maxLogBytes)) logWriteFailed = true;

      const rawExitCode = timedOut ? 124 : code;
      // Classify work quality from harness output (ok | noop | error | unknown).
      // Combined streams: agents often print the final heartbeat on either side.
      const filteredStderr = filterBenignHarnessNoise(stderr);
      const outcome = parseOutcome(entry.id, `${stdout}\n${filteredStderr}`, {
        exitCode: rawExitCode,
        timedOut,
        sink: readOutcomeSink(runDir),
      });
      const exitCode = completedExitCode(rawExitCode, timedOut, outcome);
      const result: RunResult = {
        id: entry.id,
        runDir,
        invocation,
        exitCode,
        signal,
        timedOut,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        heartbeat: { attempted: false, ok: true },
        outcome,
        harnessPid,
      };

      result.heartbeat = writeHeartbeat(entry, result);

      writeRunFile(
        join(runDir, "meta.json"),
        JSON.stringify(
          {
            id: entry.id,
            trigger,
            harness: entry.harness,
            model: entry.model,
            effort: entry.effort ?? null,
            cwd: entry.cwd,
            command: result.invocation.display,
            ...(gateCommandUsed
              ? {
                  gateCommand: gateCommandUsed,
                  gateProceeded,
                  gateSkippedHarness: false,
                }
              : {}),
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            durationMs: result.durationMs,
            harnessPid: result.harnessPid,
            daemonPid: process.pid,
            status: "finished",
            outcome: result.outcome.kind,
            outcomeDetail: result.outcome.detail,
            outcomeSource: result.outcome.source,
            stdoutTail: tail(stdout, 2000),
            stderrTail: tail(filteredStderr, 2000),
            logWriteFailed,
            logMaxBytes: maxLogBytes,
            heartbeat: result.heartbeat,
            primaryHarness: routeMeta?.primaryHarness ?? entry.harness,
            primaryModel: routeMeta?.primaryModel ?? entry.model,
            routeIndex: routeMeta?.routeIndex ?? 0,
            routeCount: routeMeta?.routeCount ?? 1,
            resolvedBy: entry.resolvedBy,
            difficulty: entry.difficulty ?? null,
            matrixResolution: entry.matrixResolution ?? null,
          },
          null,
          2,
        ) + "\n",
      );

      // Scheduled fires always own fleet health. A successful first manual run
      // may bootstrap an empty status record so a newly installed routine does
      // not remain lastRun=null after an explicit production smoke test. Once
      // scheduled health exists, manual runs never overwrite it (especially a
      // caller-local failure).
      const bootstrapManualStatus =
        trigger === "manual" && result.exitCode === 0 && !readState(entry.id).lastRun;
      if (trigger === "scheduled" || bootstrapManualStatus) {
        patchState(entry.id, {
          lastRun: result.finishedAt,
          lastExit: result.exitCode,
          lastRunDir: runDir,
          lastOutcome: result.outcome.kind,
          lastOutcomeDetail: result.outcome.detail ?? undefined,
        });
      }

      releaseLockIfOwned(entry.id, result.harnessPid ?? process.pid);

      resolve(result);
    }
  });
}

function annotateFallbackMeta(
  result: RunResult,
  primary: RoutineEntry,
  attempts: FallbackAttempt[],
  step: RouteStep,
): void {
  try {
    const metaPath = join(result.runDir, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    meta.fallbackAttempts = attempts;
    meta.usedFallback = step.harness !== primary.harness || step.model !== primary.model;
    meta.primaryHarness = primary.harness;
    meta.primaryModel = primary.model;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } catch {
    /* ignore */
  }
}

/**
 * Map external clean-stop signals to exit 0 so routine status and escalation
 * agree with the classified outcome.
 */
export function completedExitCode(
  rawExitCode: number | null,
  timedOut: boolean,
  outcome: RunOutcome,
): number | null {
  const declaredOk =
    (outcome.kind === "ok" || outcome.kind === "noop") &&
    (outcome.source === "heartbeat" ||
      outcome.source === "routine_result" ||
      outcome.source === "sink");
  if (declaredOk && rawExitCode !== 0) {
    return 0;
  }
  if (!timedOut && outcome.kind === "noop" && outcome.source === "safe_skip") {
    return 0;
  }
  return rawExitCode;
}


/** Exit code meaning "proceed to harness" for gate_command scripts. */
export const GATE_PROCEED_EXIT = 10;

/**
 * Gate wall clock. `ROUTINES_GATE_TIMEOUT_MS` is a test override (milliseconds).
 *
 * The budget is `timeout_min`, the same declared bound the harness path uses.
 * A silent 15-minute `Math.min` used to sit here. It bounded nothing the
 * registry did not already bound, and it was invisible: `routines status`, the
 * registry and `meta.json` all reported `timeout_min`, so an operator reading
 * `timeout_min = 90` had no way to learn the real ceiling was 15 minutes.
 *
 * That cost two routines. `last-stack-whats-wrong` (`timeout_min = 45`) was
 * killed at 901s. `lastdb-local-smoke-test` (`timeout_min = 90`) then merged an
 * 1800s inner gate budget whose stated reasoning cited `timeout_min = 90` as
 * the outer bound — so the gate could never fire its own timeout, and every
 * slow run reported an opaque external kill instead of a named cause.
 *
 * papercut-routines-gate-timeout-cap-silently-truncates-timeout-min
 * papercut-merged-smoke-gate-1800s-budget-exceeds-routines-900s-gate-cap
 */
export function gateTimeoutMs(entry: RoutineEntry): number {
  const raw = process.env.ROUTINES_GATE_TIMEOUT_MS;
  if (raw && /^\d+$/.test(raw)) {
    return Math.max(1, Number(raw));
  }
  // A fallback leg scales `timeoutMin` for a slower harness; the gate is
  // zero-LLM and harness-independent, so it stays on the primary budget.
  const budgetMin = entry.primaryTimeoutMin ?? entry.timeoutMin;
  return Math.max(1, budgetMin) * 60_000;
}

/**
 * Env enrichment for zero-LLM gates / dashboard-adjacent routines.
 * North-star rollup's dashboard binary defaults to 30s per subprocess; under
 * board load `kanban list --all` regularly exceeds that and the LLM harness
 * then heartbeats dashboard-script-crash-prior-snapshot-retained.
 */
export function enrichGateEnv(
  entry: RoutineEntry,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const id = entry.id.toLowerCase();
  if (
    id.includes("north-star-rollup") &&
    !env.LAST_STACK_NORTH_STAR_DASHBOARD_CMD_TIMEOUT
  ) {
    env.LAST_STACK_NORTH_STAR_DASHBOARD_CMD_TIMEOUT = "120";
  }
  return env;
}

/**
 * Run entry.gateCommand before spawning the LLM harness.
 * Returns a finished RunResult when the gate skips the harness; null to proceed.
 */
export async function runPreDispatchGate(
  entry: RoutineEntry,
  args: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    runDir: string;
    trigger: "scheduled" | "manual";
    startedAt: Date;
    routeMeta?: RunOnceMeta;
  },
): Promise<RunResult | null> {
  const cmd = entry.gateCommand;
  if (!cmd) return null;

  // Honor timeout_min fully. The old 120s hard cap, and the 15m cap that
  // replaced it, both aborted real work gates well inside their declared budget.
  const timeoutMs = gateTimeoutMs(entry);
  // A gate can run for minutes. Keep it off the daemon event loop so its wait
  // cannot delay timeout timers for harness children that already run.
  const result = await new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const stdoutCapture = new BoundedLogCapture(2_000_000);
    const stderrCapture = new BoundedLogCapture(2_000_000);
    const child = spawn(cmd, {
      cwd: args.cwd,
      env: args.env,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killChildGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killChildGroup(child, "SIGKILL"), sigkillGraceMs());
      killTimer.unref();
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => stdoutCapture.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => stderrCapture.push(data.toString()));

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status,
        signal,
        timedOut,
        stdout: stdoutCapture.text(),
        stderr: stderrCapture.text(),
      });
    };

    child.once("error", (err) => {
      stderrCapture.push(`spawn error: ${err.message}\n`);
      finish(null, null);
    });
    child.once("close", (status, signal) => finish(status, signal));
  });

  const stdout = result.stdout;
  const stderr = result.stderr;
  writeRunFile(join(args.runDir, "stdout.log"), stdout);
  writeRunFile(join(args.runDir, "stderr.log"), stderr);
  writeRunFile(join(args.runDir, "prompt.txt"), `(gate_command skipped prompt load)\ngate_command=${cmd}\n`);

  const timedOut = result.timedOut;
  const status = result.status;
  // Proceed
  if (!timedOut && status === GATE_PROCEED_EXIT) {
    // Leave logs as gate evidence; harness will overwrite on spawn path... actually
    // harness appends. Clear for clean harness capture.
    writeRunFile(join(args.runDir, "stdout.log"), "");
    writeRunFile(join(args.runDir, "stderr.log"), "");
    return null;
  }

  const finishedAt = new Date();
  const rawExit = timedOut ? 124 : status;
  const combined = `${stdout}\n${stderr}`;
  let outcome: RunOutcome;
  if (timedOut) {
    // A killed gate produced no verdict, so this is a failure to observe —
    // not an observed nothing. `noop`/`safe_skip` asserted the skip was safe
    // and hid `lastdb-local-smoke-test` going dark for two days: both runs
    // reported `lastOutcome=noop`, the same value a healthy idle run reports,
    // with 0 bytes of stdout and `gateProceeded: false`.
    //
    // `parseOutcome` already classifies the identical condition on the harness
    // path as `{ kind: "error", source: "exit" }`, and every `safe_skip`
    // producer in outcome.ts guards with `if (opts.timedOut) return null;`.
    // This branch was the one place that called a timeout safe.
    //
    // Keep naming the budget that fired: without it the reader cannot tell an
    // external kill from the gate's own self-classified timeout.
    // papercut-routines-gate-timeout-records-benign-noop-safe-skip
    outcome = {
      kind: "error",
      detail: `gate-timeout budget_s=${Math.max(1, Math.round(timeoutMs / 1000))}`,
      source: "exit",
    };
  } else if (status === 0) {
    outcome = parseOutcome(entry.id, combined, {
      exitCode: 0,
      timedOut: false,
      sink: readOutcomeSink(args.runDir),
    });
    if (outcome.kind === "error") {
      // The gate DID produce a verdict and the verdict is a failure. Observer
      // gates carry their verdict in the trailer and end `exit 0` on every
      // path, including the ones that print
      // `ROUTINE_RESULT outcome=error` — so the trailer is the only channel a
      // gate failure has. Folding it into the `noop`/`safe_skip` branch below
      // made `last-stack-why-stopped` report a healthy no-op on 10 of its last
      // 12 fires while its loom probe failed `rc=3` every time, and on the
      // last two while it also classified live freeze classes D+F.
      // Keep the source parseOutcome derived: `safe_skip` asserts the skip was
      // safe, which is the one thing an error is not.
      // papercut-routines-gate-exit0-error-trailer-recorded-as-noop
      outcome = {
        kind: "error",
        detail: outcome.detail ?? "gate-error",
        source: outcome.source,
      };
    } else if (outcome.kind === "ok" || outcome.kind === "noop") {
      // Preserve the gate's explicit ROUTINE_RESULT / sink classification.
      // Prior code forced every exit-0 gate to noop, which made real work
      // gates (dashboard regenerate) report false noops forever.
      outcome = {
        kind: outcome.kind,
        detail: outcome.detail ?? (outcome.kind === "ok" ? "gate-ok" : "gate-skip"),
        source:
          outcome.source === "sink" || outcome.source === "routine_result"
            ? outcome.source
            : "safe_skip",
      };
    } else {
      // Gate claimed success without a parseable trailer — still treat as noop skip.
      outcome = {
        kind: "noop",
        detail: "gate-skip no_card_claimed",
        source: "safe_skip",
      };
    }
  } else {
    outcome = parseOutcome(entry.id, combined, {
      exitCode: rawExit,
      timedOut,
      sink: readOutcomeSink(args.runDir),
    });
    if (outcome.kind === "unknown") {
      outcome = {
        kind: "error",
        detail: `gate-command-failed rc=${status ?? "null"}`,
        source: "exit",
      };
    }
  }

  // A gate_command run NEVER loads a prompt — prompt.txt holds only
  // "(gate_command skipped prompt load)". So no prompt-side instruction, at any
  // position, can ever make a gate write the outcome sink: measured 2026-08-21,
  // `last-stack-whats-wrong` (24 runs) and `last-stack-why-stopped` (12 runs)
  // finished with no outcome.txt at all, most exit 0 with a valid legacy
  // trailer. The runner is the only party present on this path, so the runner
  // persists the sink itself.
  //
  // Persisting it also makes a gate run survivable: reconcileOrphanedRuns()
  // recovers a verdict from outcome.txt when routinesd dies mid-run, and
  // reads `unknown` when the file is absent. Every gate run was in that
  // second class.
  //
  // The derived `source` is deliberately NOT rewritten. It is the triage
  // signal that says WHY — `exit` distinguishes an external kill from a gate's
  // own self-classified skip, and collapsing that into one "the runner wrote
  // it" label is what
  // papercut-routines-gate-timeout-records-benign-noop-safe-skip was about.
  // The file names its own author on a comment line instead; parseOutcomeSink
  // skips `#` lines, so a human sees who wrote it and the parser still reads
  // the verdict.
  // papercut-routines-outcome-sink-closeout-is-buried-before-routine-body
  if (readOutcomeSink(args.runDir) === null) {
    const detail = outcome.detail ? ` ${outcome.detail}` : "";
    writeRunFile(
      join(args.runDir, OUTCOME_SINK_FILENAME),
      `# written by routinesd: a gate_command run loads no prompt, so nothing\n` +
        `# instructs the routine to write this file (source=${outcome.source}).\n` +
        `${outcome.kind}${detail}\n`,
    );
  }

  const exitCode = timedOut || status === 0 ? 0 : completedExitCode(rawExit, timedOut, outcome);
  const invocation: HarnessInvocation = {
    bin: cmd,
    args: [],
    display: `gate_command: ${cmd}`,
  };
  const runResult: RunResult = {
    id: entry.id,
    runDir: args.runDir,
    invocation,
    exitCode,
    signal: result.signal ?? null,
    timedOut,
    startedAt: args.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - args.startedAt.getTime(),
    heartbeat: { attempted: false, ok: true },
    outcome,
    harnessPid: null,
  };
  runResult.heartbeat = writeHeartbeat(entry, runResult);

  writeRunFile(
    join(args.runDir, "meta.json"),
    JSON.stringify(
      {
        id: entry.id,
        trigger: args.trigger,
        harness: entry.harness,
        model: entry.model,
        effort: entry.effort ?? null,
        cwd: entry.cwd,
        command: invocation.display,
        gateCommand: cmd,
        // The applied wall clock, so a kill is diagnosable from meta alone.
        gateTimeoutMs: timeoutMs,
        gateSkippedHarness: timedOut || status === 0,
        gateProceeded: false,
        exitCode: runResult.exitCode,
        signal: runResult.signal,
        timedOut: runResult.timedOut,
        startedAt: runResult.startedAt,
        finishedAt: runResult.finishedAt,
        durationMs: runResult.durationMs,
        harnessPid: null,
        daemonPid: process.pid,
        status: "finished",
        outcome: runResult.outcome.kind,
        outcomeDetail: runResult.outcome.detail,
        outcomeSource: runResult.outcome.source,
        stdoutTail: tail(stdout, 2000),
        stderrTail: tail(stderr, 2000),
        heartbeat: runResult.heartbeat,
        primaryHarness: args.routeMeta?.primaryHarness ?? entry.harness,
        primaryModel: args.routeMeta?.primaryModel ?? entry.model,
        routeIndex: args.routeMeta?.routeIndex ?? 0,
        routeCount: args.routeMeta?.routeCount ?? 1,
        resolvedBy: entry.resolvedBy,
        difficulty: entry.difficulty ?? null,
        matrixResolution: entry.matrixResolution ?? null,
      },
      null,
      2,
    ) + "\n",
  );

  const bootstrapManualStatus =
    args.trigger === "manual" && runResult.exitCode === 0 && !readState(entry.id).lastRun;
  if (args.trigger === "scheduled" || bootstrapManualStatus) {
    patchState(entry.id, {
      lastRun: runResult.finishedAt,
      lastExit: runResult.exitCode,
      lastRunDir: args.runDir,
      lastOutcome: runResult.outcome.kind,
      lastOutcomeDetail: runResult.outcome.detail ?? undefined,
    });
  }

  releaseLockIfOwned(entry.id, process.pid);
  return runResult;
}

function killChildGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child as a portability fallback.
    }
  }
  child.kill(signal);
}

function sigkillGraceMs(): number {
  const raw = process.env.ROUTINES_SIGKILL_GRACE_MS;
  if (!raw) return 5_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5_000;
}

/** After a terminal outcome.txt, wait this long for trailing stdout, then SIGTERM. */
function sinkStopGraceMs(): number {
  const raw = process.env.ROUTINES_SINK_STOP_GRACE_MS;
  if (!raw) return 1_500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1_500;
}

function runLogMaxBytes(): number {
  const raw = process.env.ROUTINES_RUN_LOG_MAX_BYTES;
  if (!raw) return DEFAULT_RUN_LOG_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RUN_LOG_MAX_BYTES;
  return Math.max(MIN_RUN_LOG_MAX_BYTES, Math.floor(n));
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function writeRunLog(
  runDir: string,
  name: "stdout.log" | "stderr.log",
  text: string,
  maxBytes: number,
): boolean {
  try {
    writeFileSync(join(runDir, name), trimToLastBytes(text, maxBytes));
    return true;
  } catch {
    return false;
  }
}

function writeRunFile(path: string, text: string): boolean {
  try {
    writeFileSync(path, text);
    return true;
  } catch {
    return false;
  }
}

function trimToLastBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text);
  if (buf.byteLength <= maxBytes) return text;
  const marker = Buffer.from(`[routinesd log truncated to last ${maxBytes} bytes]\n`);
  const keep = Math.max(0, maxBytes - marker.byteLength);
  return Buffer.concat([marker, buf.subarray(buf.byteLength - keep)]).toString();
}

class BoundedLogCapture {
  private chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    let next = chunk;
    const nextBytes = Buffer.byteLength(next);
    if (nextBytes >= this.maxBytes) {
      this.chunks = [trimToLastBytes(next, this.maxBytes)];
      this.bytes = Buffer.byteLength(this.chunks[0]!);
      return;
    }

    this.chunks.push(next);
    this.bytes += nextBytes;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks.shift()!;
      this.bytes -= Buffer.byteLength(first);
    }
    if (this.bytes > this.maxBytes) {
      next = trimToLastBytes(this.chunks.join(""), this.maxBytes);
      this.chunks = [next];
      this.bytes = Buffer.byteLength(next);
    }
  }

  text(): string {
    return this.chunks.join("");
  }
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}
