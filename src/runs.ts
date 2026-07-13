// Read per-routine run history for the "run detail" view: recent runs with
// their exit status + a tail of the captured log. Reads the same
// $ROUTINES_HOME/runs/<id>/<ts>/ evidence the runner writes and the CLI `logs`
// command reads.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { runsDir } from "./paths.ts";

export interface RunSummary {
  stamp: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  timedOut: boolean;
  command: string | null;
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

function summarize(stamp: string, meta: Record<string, unknown>): RunSummary {
  return {
    stamp,
    startedAt: typeof meta.startedAt === "string" ? meta.startedAt : null,
    finishedAt: typeof meta.finishedAt === "string" ? meta.finishedAt : null,
    exitCode: typeof meta.exitCode === "number" ? meta.exitCode : null,
    durationMs: typeof meta.durationMs === "number" ? meta.durationMs : null,
    timedOut: meta.timedOut === true,
    command: typeof meta.command === "string" ? meta.command : null,
  };
}

/** List a routine's runs, most recent first (run-dir stamps sort chronologically). */
export function listRuns(id: string, limit = 20): RunSummary[] {
  const dir = runDirFor(id);
  if (!existsSync(dir)) return [];
  const stamps = readdirSync(dir)
    .filter((s) => existsSync(join(dir, s, "meta.json")) || existsSync(join(dir, s)))
    .sort()
    .reverse()
    .slice(0, limit);
  return stamps.map((s) => summarize(s, readMeta(join(dir, s))));
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
    ...summarize(target!, meta),
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
