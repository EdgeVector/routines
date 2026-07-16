// Run executor: spawn one harness invocation for a routine, capture its output
// to a per-run log directory, enforce a timeout, and record the outcome +
// heartbeat.
//
// Per-run logs land at $ROUTINES_HOME/runs/<id>/<ts>/ containing:
//   meta.json  — prompt-elided invocation, harness/model, exit code, timing
//   prompt.txt — the exact prompt dispatched
//   stdout.log / stderr.log — captured streams
// This is the durable evidence the card's VERIFY asks for.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildInvocation, type HarnessInvocation } from "./adapters.ts";
import type { RoutineEntry } from "./registry.ts";
import { buildRoutineAttributionEnv, resolveDispatchPrompt } from "./prompt.ts";
import { runsDir } from "./paths.ts";
import { writeHeartbeat, type HeartbeatOutcome } from "./heartbeat.ts";
import { parseOutcome, type RunOutcome } from "./outcome.ts";
import { patchState } from "./state.ts";
import { envFromProjectConfig, loadProjectConfig, resolveRoutineCwd } from "./project-config.ts";
import { discoveredRoutineSocketEnv } from "./socket-env.ts";
import { escalateRoutineError, shouldEscalate } from "./error-escalate.ts";

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
}

// Timestamp safe for a directory name (no colons): 2026-07-12T21-05-00-123Z.
function runStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export interface RunOptions {
  /** Suppress live streaming to the parent's stdout/stderr (default: stream). */
  quiet?: boolean;
}

export function runRoutine(entry: RoutineEntry, opts: RunOptions = {}): Promise<RunResult> {
  const startedAt = new Date();
  const runDir = join(runsDir(), entry.id, runStamp(startedAt));
  mkdirSync(runDir, { recursive: true });
  // Prompt after runDir so the envelope can name Run directory / Run-Id trailers.
  const prompt = resolveDispatchPrompt(entry, { runDir });
  const invocation = buildInvocation(entry, prompt);
  writeFileSync(join(runDir, "prompt.txt"), prompt);

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
      if (!opts.quiet) process.stdout.write(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderrChunks.push(s);
      if (!opts.quiet) process.stderr.write(s);
    });

    child.on("error", (err) => {
      // Spawn failure (e.g. binary not found): record as a failed run.
      stderrChunks.push(`spawn error: ${err.message}\n`);
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
      };

      result.heartbeat = writeHeartbeat(entry, result);

      writeFileSync(
        join(runDir, "meta.json"),
        JSON.stringify(
          {
            id: entry.id,
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
            outcome: result.outcome.kind,
            outcomeDetail: result.outcome.detail,
            outcomeSource: result.outcome.source,
            stdoutTail: tail(stdout, 2000),
            stderrTail: tail(stderr, 2000),
            heartbeat: result.heartbeat,
          },
          null,
          2,
        ) + "\n",
      );

      patchState(entry.id, {
        lastRun: result.finishedAt,
        lastExit: result.exitCode,
        lastRunDir: runDir,
        lastOutcome: result.outcome.kind,
        lastOutcomeDetail: result.outcome.detail ?? undefined,
      });

      // P0 fleet rule: every error run gets a board card + (rate-limited) triage
      // agent. Never await — must not stall the scheduler or re-throw.
      if (shouldEscalate(result)) {
        try {
          escalateRoutineError(entry, result, { quiet: opts.quiet });
        } catch {
          /* never break finalize */
        }
      }

      resolve(result);
    }
  });
}

/** Map timeout exit 124 → 0 when the agent still produced a durable ok/noop outcome. */
function completedExitCode(
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
