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
import { resolvePrompt, type RoutineEntry } from "./registry.ts";
import { automationMemoryDir, automationMemoryPath, runsDir } from "./paths.ts";
import { writeHeartbeat, type HeartbeatOutcome } from "./heartbeat.ts";
import { parseOutcome, type RunOutcome } from "./outcome.ts";
import { patchState } from "./state.ts";
import { envFromProjectConfig, loadProjectConfig, resolveRoutineCwd } from "./project-config.ts";

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
  const prompt = buildDispatchPrompt(entry, resolvePrompt(entry));
  const invocation = buildInvocation(entry, prompt);
  const startedAt = new Date();
  const runDir = join(runsDir(), entry.id, runStamp(startedAt));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "prompt.txt"), prompt);

  const project = loadProjectConfig();
  const cwd = resolveRoutineCwd(entry.cwd, project);
  const childEnv = { ...process.env, ...envFromProjectConfig(project) };

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  return new Promise<RunResult>((resolve) => {
    const child = spawn(invocation.bin, invocation.args, {
      cwd,
      env: childEnv,
      stdio: [invocation.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    const timeoutMs = entry.timeoutMin * 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Escalate if it ignores SIGTERM.
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
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
      finalize(code, signal);
    });

    function finalize(code: number | null, signal: NodeJS.Signals | null): void {
      clearTimeout(timer);
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

      resolve(result);
    }
  });
}

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

function buildDispatchPrompt(entry: RoutineEntry, prompt: string): string {
  const memoryPath = automationMemoryPath(entry.id);
  try {
    mkdirSync(automationMemoryDir(entry.id), { recursive: true });
  } catch {
    // The harness prompt tells the worker how to report an unwritable path.
  }
  return [
    "## Dispatch envelope (routinesd)",
    "",
    `Automation ID: ${entry.id}`,
    `Automation memory: ${memoryPath}`,
    "",
    "Use ONLY the Automation memory path above for cross-run notes. Do not invent",
    "short aliases under ~/.codex/automations/ from the skill `name:` frontmatter.",
    "If that exact path is unwritable, note `memory_unwritable=<path>` in the",
    "heartbeat and continue; do not fail the whole run.",
    "",
    "---",
    prompt,
  ].join("\n");
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}
