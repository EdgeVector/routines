// Heartbeats. When a routine sets `heartbeat_slug`, each run appends one line
// to a **filesystem log** (not LastDB / brain). Full-body brain rewrites of
// routine-heartbeats ballooned Mini atom storage; heartbeats must stay off DB.
//
// Default: ~/.last-stack/logs/routine-heartbeats.log
// Override: LAST_STACK_HEARTBEATS_FILE, or ROUTINES_HEARTBEATS_FILE
//
// Writing is best-effort and NEVER fatal to a run.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { RunResult } from "./runner.ts";
import type { RoutineEntry } from "./registry.ts";

/** Resolve the heartbeats log path (filesystem only). */
function heartbeatsLogPath(): string {
  return (
    process.env.ROUTINES_HEARTBEATS_FILE ||
    process.env.LAST_STACK_HEARTBEATS_FILE ||
    join(homedir(), ".last-stack", "logs", "routine-heartbeats.log")
  );
}

/** One heartbeat line, matching the fleet convention:
 * `<ISO> <id> <ok|error> harness=<h> model=<m> exit=<n> dur=<s>s run=<dir>` */
function heartbeatLine(entry: RoutineEntry, result: RunResult): string {
  // Prefer outcome kind for clean harness skips (auth/capacity safe_skip → exit 0
  // but still a noop, not a successful agent turn).
  const state =
    result.exitCode === 0
      ? result.outcome.kind === "noop"
        ? "noop"
        : "ok"
      : "error";
  const dur = (result.durationMs / 1000).toFixed(1);
  let line =
    `${result.finishedAt} ${entry.id} ${state} ` +
    `harness=${entry.harness} model=${entry.model} ` +
    `exit=${result.exitCode ?? "null"} dur=${dur}s run=${result.runDir}`;
  // Stable fleet token for Claude OAuth / auth harness deaths (card VERIFY +
  // multi-routine storm collapse). Prefer outcome detail; fall back to kind.
  const detail = result.outcome.detail ?? "";
  if (
    /reason=harness-auth-expired|harness-auth-expired|authentication_failed|oauth session expired|failed to authenticate/i.test(
      detail,
    )
  ) {
    if (!/\breason=harness-auth-expired\b/i.test(line)) {
      line += " reason=harness-auth-expired";
    }
  }
  return line;
}

export interface HeartbeatOutcome {
  attempted: boolean;
  ok: boolean;
  line?: string;
  error?: string;
  path?: string;
}

export function writeHeartbeat(entry: RoutineEntry, result: RunResult): HeartbeatOutcome {
  // heartbeat_slug used to name a brain Reference record; now any truthy value
  // means "write a fleet heartbeat line" (shared file).
  if (!entry.heartbeatSlug) return { attempted: false, ok: true };
  const line = heartbeatLine(entry, result);
  const path = heartbeatsLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, { encoding: "utf8" });
    return { attempted: true, ok: true, line, path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { attempted: true, ok: false, line, path, error: msg };
  }
}
