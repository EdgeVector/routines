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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildInvocation, type HarnessInvocation } from "./adapters.ts";
import { setLockOwnerPid } from "./daemon.ts";
import {
  buildRouteChain,
  entryForRoute,
  fallbackEnabled,
  formatRoute,
  type RouteStep,
} from "./fallback.ts";
import {
  classifyHarnessOutage,
  handleHarnessOutage,
  isHarnessOutaged,
} from "./harness-outage.ts";
import type { RoutineEntry } from "./registry.ts";
import { buildRoutineAttributionEnv, resolveDispatchPrompt } from "./prompt.ts";
import { runsDir } from "./paths.ts";
import { writeHeartbeat, type HeartbeatOutcome } from "./heartbeat.ts";
import { parseOutcome, type RunOutcome } from "./outcome.ts";
import { patchState } from "./state.ts";
import { envFromProjectConfig, loadProjectConfig, resolveRoutineCwd } from "./project-config.ts";
import { discoveredRoutineSocketEnv } from "./socket-env.ts";
import { escalateRoutineError, shouldAutoEscalateScheduledRun, shouldEscalate } from "./error-escalate.ts";

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

export interface FallbackAttempt {
  harness: string;
  model: string;
  runDir: string;
  exitCode: number | null;
  outcome: string;
  outage: boolean;
}

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
}): void {
  writeFileSync(
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
        exitCode: null,
        finishedAt: null,
      },
      null,
      2,
    ) + "\n",
  );
}

/** Append a chunk to a run-dir log file (create on first write). */
export function appendRunLog(runDir: string, name: "stdout.log" | "stderr.log", chunk: string): void {
  appendFileSync(join(runDir, name), chunk);
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
 * Run a routine, walking the fallback chain on harness-outage failures only.
 * Registry TOML is never rewritten — route changes are ephemeral per fire.
 */
export async function runRoutine(entry: RoutineEntry, opts: RunOptions = {}): Promise<RunResult> {
  const trigger = opts.trigger ?? "scheduled";
  const useFallback = fallbackEnabled() && !opts.noFallback;
  const routes = useFallback ? routesForFire(entry) : [buildRouteChain(entry)[0]!];
  const attempts: FallbackAttempt[] = [];
  let last: RunResult | null = null;

  for (let i = 0; i < routes.length; i++) {
    const step = routes[i]!;
    const runEntry = entryForRoute(entry, step);
    last = await runOnce(runEntry, opts, {
      primaryHarness: entry.harness,
      primaryModel: entry.model,
      routeIndex: i,
      routeCount: routes.length,
    });

    // Classify outage even when outcome was remapped to clean noop/safe_skip
    // (capacity / usage-limit transcripts). Those must still walk the chain.
    const outage = classifyHarnessOutage(last);
    attempts.push({
      harness: step.harness,
      model: step.model,
      runDir: last.runDir,
      exitCode: last.exitCode,
      outcome: last.outcome.kind,
      outage: Boolean(outage),
    });
    annotateFallbackMeta(last, entry, attempts, step);

    if (outage) {
      const hasMore = i < routes.length - 1;
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
        // Outage path already suppressed P0 cards; skip escalateRoutineError.
        return last;
      }

      if (!opts.quiet) {
        try {
          process.stderr.write(
            `[routines fallback] ${entry.id}: ${formatRoute(step)} outage → trying ${formatRoute(routes[i + 1]!)}\n`,
          );
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    if (!shouldEscalate(last)) {
      // True success (or non-escalating non-outage outcome).
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
}

/** Single harness spawn (no fallback). */
function runOnce(
  entry: RoutineEntry,
  opts: RunOptions,
  routeMeta?: RunOnceMeta,
): Promise<RunResult> {
  const trigger = opts.trigger ?? "scheduled";
  const startedAt = new Date();
  const runDir = join(runsDir(), entry.id, runStamp(startedAt));
  mkdirSync(runDir, { recursive: true });
  // Prompt after runDir so the envelope can name Run directory / Run-Id trailers.
  const prompt = resolveDispatchPrompt(entry, { runDir });
  const invocation = buildInvocation(entry, prompt);
  writeFileSync(join(runDir, "prompt.txt"), prompt);
  // Empty logs so mid-flight `tail -f` works even before first chunk.
  writeFileSync(join(runDir, "stdout.log"), "");
  writeFileSync(join(runDir, "stderr.log"), "");

  const project = loadProjectConfig();
  const cwd = resolveRoutineCwd(entry.cwd, project);
  const configuredEnv = { ...process.env, ...envFromProjectConfig(project) };
  const childEnv = {
    ...configuredEnv,
    ...discoveredRoutineSocketEnv(configuredEnv),
    ...buildRoutineAttributionEnv(entry.id, runDir),
  };

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

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
    });

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutMs = entry.timeoutMin * 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildGroup(child, "SIGTERM");
      // Escalate if it ignores SIGTERM.
      killTimer = setTimeout(() => killChildGroup(child, "SIGKILL"), sigkillGraceMs());
      killTimer.unref();
    }, timeoutMs);

    if (invocation.stdin !== undefined) {
      child.stdin?.write(invocation.stdin);
      child.stdin?.end();
    }

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdoutChunks.push(s);
      appendRunLog(runDir, "stdout.log", s);
      if (!opts.quiet) process.stdout.write(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderrChunks.push(s);
      appendRunLog(runDir, "stderr.log", s);
      if (!opts.quiet) process.stderr.write(s);
    });

    child.on("error", (err) => {
      // Spawn failure (e.g. binary not found): record as a failed run.
      const msg = `spawn error: ${err.message}\n`;
      stderrChunks.push(msg);
      appendRunLog(runDir, "stderr.log", msg);
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
      });
      finalize(null, null);
    });

    child.on("close", (code, signal) => {
      setImmediate(() => finalize(code, signal));
    });

    function finalize(code: number | null, signal: NodeJS.Signals | null): void {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const finishedAt = new Date();
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      // Final rewrite ensures the on-disk logs match memory even if a chunk
      // handler raced; streaming already wrote the content for mid-flight tail.
      writeFileSync(join(runDir, "stdout.log"), stdout);
      writeFileSync(join(runDir, "stderr.log"), stderr);

      const rawExitCode = timedOut ? 124 : code;
      // Classify work quality from harness output (ok | noop | error | unknown).
      // Combined streams: agents often print the final heartbeat on either side.
      const outcome = parseOutcome(entry.id, `${stdout}\n${stderr}`, {
        exitCode: rawExitCode,
        timedOut,
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

      writeFileSync(
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
            stderrTail: tail(stderr, 2000),
            heartbeat: result.heartbeat,
            primaryHarness: routeMeta?.primaryHarness ?? entry.harness,
            primaryModel: routeMeta?.primaryModel ?? entry.model,
            routeIndex: routeMeta?.routeIndex ?? 0,
            routeCount: routeMeta?.routeCount ?? 1,
          },
          null,
          2,
        ) + "\n",
      );

      if (trigger === "scheduled") {
        patchState(entry.id, {
          lastRun: result.finishedAt,
          lastExit: result.exitCode,
          lastRunDir: runDir,
          lastOutcome: result.outcome.kind,
          lastOutcomeDetail: result.outcome.detail ?? undefined,
        });
      }

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
  if (
    timedOut &&
    (outcome.kind === "ok" || outcome.kind === "noop") &&
    (outcome.source === "heartbeat" || outcome.source === "routine_result")
  ) {
    return 0;
  }
  if (!timedOut && outcome.kind === "noop" && outcome.source === "safe_skip") {
    return 0;
  }
  return rawExitCode;
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

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}
