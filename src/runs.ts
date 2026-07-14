// Read per-routine run history for the "run detail" view: recent runs with
// their exit status, work outcome (ok/noop/error), + a tail of the captured
// log. Reads the same $ROUTINES_HOME/runs/<id>/<ts>/ evidence the runner
// writes and the CLI `logs` command reads.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  aggregateOutcomes,
  outcomeFromMeta,
  parseOutcome,
  type OutcomeStats,
  type RunOutcome,
} from "./outcome.ts";
import { runsDir } from "./paths.ts";

export interface RunSummary {
  stamp: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  timedOut: boolean;
  command: string | null;
  outcome: RunOutcome["kind"];
  outcomeDetail: string | null;
  outcomeSource: RunOutcome["source"];
}

export interface RunDetail extends RunSummary {
  id: string;
  dir: string;
  stdoutTail: string;
  stderrTail: string;
}

function runDirFor(id: string): string {
  return join(runsDir(), id);
}

function readMeta(dir: string): Record<string, unknown> {
  const p = join(dir, "meta.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve the work outcome for a run dir. Prefer meta.json fields written by
 * the runner; for older runs (pre-outcome), re-parse stdout/stderr so history
 * still feeds noop-rate without a re-run.
 */
export function resolveRunOutcome(id: string, runDir: string, meta: Record<string, unknown>): RunOutcome {
  if (typeof meta.outcome === "string" && meta.outcome !== "unknown") {
    return outcomeFromMeta(meta);
  }
  // Re-parse historical logs (or unknown meta) from captured streams.
  const stdout = readText(join(runDir, "stdout.log"));
  const stderr = readText(join(runDir, "stderr.log"));
  // Prefer full logs; fall back to tails stored in meta if logs were pruned.
  const text =
    stdout || stderr
      ? `${stdout}\n${stderr}`
      : `${typeof meta.stdoutTail === "string" ? meta.stdoutTail : ""}\n${
          typeof meta.stderrTail === "string" ? meta.stderrTail : ""
        }`;
  const exitCode = typeof meta.exitCode === "number" ? meta.exitCode : null;
  const timedOut = meta.timedOut === true;
  return parseOutcome(id, text, { exitCode, timedOut });
}

function summarize(id: string, stamp: string, runDir: string, meta: Record<string, unknown>): RunSummary {
  const outcome = resolveRunOutcome(id, runDir, meta);
  return {
    stamp,
    startedAt: typeof meta.startedAt === "string" ? meta.startedAt : null,
    finishedAt: typeof meta.finishedAt === "string" ? meta.finishedAt : null,
    exitCode: typeof meta.exitCode === "number" ? meta.exitCode : null,
    durationMs: typeof meta.durationMs === "number" ? meta.durationMs : null,
    timedOut: meta.timedOut === true,
    command: typeof meta.command === "string" ? meta.command : null,
    outcome: outcome.kind,
    outcomeDetail: outcome.detail,
    outcomeSource: outcome.source,
  };
}

/** True when a run dir never finished (e.g. web/daemon restart mid-run). */
function isCompleteRunDir(runDir: string, meta: Record<string, unknown>): boolean {
  if (!existsSync(join(runDir, "meta.json"))) return false;
  // meta must have an exitCode field (null is ok for spawn fail) OR finishedAt
  if (typeof meta.finishedAt === "string") return true;
  if ("exitCode" in meta) return true;
  return false;
}

/** List a routine's runs, most recent first (run-dir stamps sort chronologically). */
export function listRuns(id: string, limit = 20): RunSummary[] {
  const dir = runDirFor(id);
  if (!existsSync(dir)) return [];
  const stamps = readdirSync(dir)
    .filter((s) => {
      const rd = join(dir, s);
      return isCompleteRunDir(rd, readMeta(rd));
    })
    .sort()
    .reverse()
    .slice(0, limit);
  return stamps.map((s) => summarize(id, s, join(dir, s), readMeta(join(dir, s))));
}

/** Rolling outcome stats over the most recent `limit` runs (default 10). */
export function outcomeStatsFor(id: string, limit = 10): OutcomeStats {
  const runs = listRuns(id, limit);
  return aggregateOutcomes(
    runs.map((r) => ({
      kind: r.outcome,
      detail: r.outcomeDetail,
      source: r.outcomeSource,
    })),
  );
}

/** Read one run's detail, including a tail of stdout/stderr. `stamp` defaults to
 * the most recent run. Returns null if the routine has no such run. */
export function readRun(id: string, stamp?: string, tailBytes = 8000): RunDetail | null {
  const dir = runDirFor(id);
  if (!existsSync(dir)) return null;
  let target = stamp;
  if (!target) {
    const stamps = readdirSync(dir).sort();
    if (stamps.length === 0) return null;
    target = stamps[stamps.length - 1];
  }
  const runDir = join(dir, target!);
  if (!existsSync(runDir)) return null;
  const meta = readMeta(runDir);
  const stdout = readTail(join(runDir, "stdout.log"), tailBytes);
  const stderr = readTail(join(runDir, "stderr.log"), tailBytes);
  return {
    ...summarize(id, target!, runDir, meta),
    id,
    dir: runDir,
    stdoutTail: stdout,
    stderrTail: stderr,
  };
}

function readTail(path: string, n: number): string {
  if (!existsSync(path)) return "";
  const s = readFileSync(path, "utf8");
  return s.length <= n ? s : s.slice(s.length - n);
}
