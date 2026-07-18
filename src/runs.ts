// Read per-routine run history for the "run detail" view: recent runs with
// their exit status, work outcome (ok/noop/error), + a tail of the captured
// log. Reads the same $ROUTINES_HOME/runs/<id>/<ts>/ evidence the runner
// writes and the CLI `logs` command reads.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  aggregateOutcomes,
  filterBenignHarnessNoise,
  outcomeFromMeta,
  parseOutcome,
  type OutcomeStats,
  type RunOutcome,
} from "./outcome.ts";
import {
  resolveEscalateStatus,
  type EscalateStatus,
} from "./escalate-status.ts";
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
  /** Present when error-escalate ran for this run (card + optional triage). */
  escalate: EscalateStatus | null;
}

export interface RunDetail extends RunSummary {
  id: string;
  dir: string;
  stdoutTail: string;
  stderrTail: string;
  /**
   * Best-effort human summary pulled out of harness noise (Claude stream-json
   * final result, ROUTINE_RESULT trailer, RESULT: line). Empty when we only
   * have raw logs. Dashboard shows this above the blob.
   */
  summary: string | null;
  /** Where summary came from (for UI badges). */
  summarySource: "routine_result" | "claude_result" | "result_colon" | "outcome_detail" | null;
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
  const stderr = filterBenignHarnessNoise(readText(join(runDir, "stderr.log")));
  // Prefer full logs; fall back to tails stored in meta if logs were pruned.
  const text =
    stdout || stderr
      ? `${stdout}\n${stderr}`
      : `${typeof meta.stdoutTail === "string" ? meta.stdoutTail : ""}\n${
          typeof meta.stderrTail === "string" ? meta.stderrTail : ""
        }`;
  const exitCode = typeof meta.exitCode === "number" ? meta.exitCode : null;
  const timedOut = meta.timedOut === true;
  const startedAt = typeof meta.startedAt === "string" ? meta.startedAt : null;
  // Live / unfinished runs: meta has no outcome yet. Re-parsing bare
  // heartbeats is unsafe because agents dump memory.md (full history) into
  // stderr before emitting their own line — that falsely marks the fleet red.
  const incomplete =
    meta.status === "running" ||
    (typeof meta.finishedAt !== "string" && !("exitCode" in meta));
  return parseOutcome(id, text, { exitCode, timedOut, startedAt, incomplete });
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
    escalate: resolveEscalateStatus(runDir),
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
  // Prefer fuller stdout for summary extraction (result is usually near the end).
  // Still cap so huge logs don't blow memory.
  const fullStdout = readTail(join(runDir, "stdout.log"), Math.max(tailBytes, 200_000));
  const stdout =
    fullStdout.length <= tailBytes ? fullStdout : fullStdout.slice(fullStdout.length - tailBytes);
  const stderr = filterBenignHarnessNoise(readTail(join(runDir, "stderr.log"), tailBytes));
  const summaryRow = summarize(id, target!, runDir, meta);
  const summary = extractRunSummary(fullStdout, summaryRow);
  return {
    ...summaryRow,
    id,
    dir: runDir,
    stdoutTail: stdout,
    stderrTail: stderr,
    summary: summary.text,
    summarySource: summary.source,
  };
}

/**
 * Pull a human-readable "what happened" string out of harness output.
 * Best-effort, never throws. Prefer machine trailers, then Claude final result.
 */
export function extractRunSummary(
  text: string,
  outcome?: RunSummary | null,
): { text: string | null; source: RunDetail["summarySource"] } {
  if (!text && outcome?.outcomeDetail) {
    return { text: outcome.outcomeDetail, source: "outcome_detail" };
  }
  if (!text) return { text: null, source: null };

  // 1) ROUTINE_RESULT outcome=ok detail=...
  const rr = [...text.matchAll(/ROUTINE_RESULT\s+outcome\s*=\s*(ok|noop|error)\b([^\n\r]*)/gi)];
  if (rr.length > 0) {
    const m = rr[rr.length - 1]!;
    const kind = m[1]!;
    const rest = (m[2] ?? "").trim();
    const detailM = rest.match(/\bdetail\s*=\s*(.+)$/i);
    const detail = (detailM ? detailM[1]! : rest).trim();
    const line = detail ? `${kind}: ${detail}` : kind;
    return { text: clipSummary(line), source: "routine_result" };
  }

  // 2) Claude stream-json final result envelope
  // Prefer last {"type":"result",...} with a string "result":"..."
  let lastClaudeResult: string | null = null;
  for (const m of text.matchAll(/"type"\s*:\s*"result"[\s\S]{0,8000}?"result"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    lastClaudeResult = m[1] ?? null;
  }
  // Also try standalone last "result":"..." near end if type:result matched loosely
  if (!lastClaudeResult) {
    const tail = text.slice(Math.max(0, text.length - 30_000));
    if (/"type"\s*:\s*"result"/.test(tail) && /"subtype"\s*:\s*"success"/.test(tail)) {
      const m = [...tail.matchAll(/"result"\s*:\s*"((?:\\.|[^"\\])*)"/g)].pop();
      if (m) lastClaudeResult = m[1] ?? null;
    }
  }
  if (lastClaudeResult) {
    let decoded = lastClaudeResult;
    try {
      decoded = JSON.parse(`"${lastClaudeResult}"`);
    } catch {
      decoded = lastClaudeResult
        .split("\\n")
        .join("\n")
        .split("\\t")
        .join("\t")
        .split('\\"')
        .join('"');
    }
    decoded = decoded.trim();
    if (decoded.length > 0) {
      return { text: clipSummary(decoded, 4000), source: "claude_result" };
    }
  }

  // 3) RESULT: ok ...
  const rc = [...text.matchAll(/\bRESULT:\s*(ok|noop|error)\b([^\n\r]*)/gi)];
  if (rc.length > 0) {
    const m = rc[rc.length - 1]!;
    const line = `${m[1]}${(m[2] ?? "").trim() ? ":" + m[2] : ""}`.trim();
    return { text: clipSummary(line), source: "result_colon" };
  }

  // 4) Fall back to classified outcome detail (already cleaned-ish)
  if (outcome?.outcomeDetail) {
    return { text: outcome.outcomeDetail, source: "outcome_detail" };
  }
  return { text: null, source: null };
}

function clipSummary(s: string, max = 2000): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function readTail(path: string, n: number): string {
  if (!existsSync(path)) return "";
  const s = readFileSync(path, "utf8");
  return s.length <= n ? s : s.slice(s.length - n);
}
