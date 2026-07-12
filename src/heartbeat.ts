// Heartbeats. When a routine sets `heartbeat_slug`, each run appends one line to
// the existing fbrain routine-heartbeats convention (unchanged format) so
// morning-digest / watchers need no changes.
//
// Writing is best-effort and NEVER fatal to a run: a brain outage must not stop
// the scheduler (brain-down standing rule). The fbrain binary is overridable
// (ROUTINES_FBRAIN_BIN) so the e2e can capture heartbeats without mutating the
// shared routine-heartbeats record.

import { spawnSync } from "node:child_process";

import type { RunResult } from "./runner.ts";
import type { RoutineEntry } from "./registry.ts";

function fbrainBinary(): string {
  return process.env.ROUTINES_FBRAIN_BIN ?? "fbrain";
}

/** One heartbeat line, matching the fleet convention:
 * `<ISO> <id> <ok|error> harness=<h> model=<m> exit=<n> dur=<s>s run=<dir>` */
export function heartbeatLine(entry: RoutineEntry, result: RunResult): string {
  const state = result.exitCode === 0 ? "ok" : "error";
  const dur = (result.durationMs / 1000).toFixed(1);
  return (
    `${result.finishedAt} ${entry.id} ${state} ` +
    `harness=${entry.harness} model=${entry.model} ` +
    `exit=${result.exitCode ?? "null"} dur=${dur}s run=${result.runDir}`
  );
}

export interface HeartbeatOutcome {
  attempted: boolean;
  ok: boolean;
  line?: string;
  error?: string;
}

export function writeHeartbeat(entry: RoutineEntry, result: RunResult): HeartbeatOutcome {
  if (!entry.heartbeatSlug) return { attempted: false, ok: true };
  const line = heartbeatLine(entry, result);
  const bin = fbrainBinary();
  const res = spawnSync(bin, ["append", entry.heartbeatSlug, "--text", line], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.error) return { attempted: true, ok: false, line, error: `${bin}: ${res.error.message}` };
  if (typeof res.status === "number" && res.status !== 0) {
    return { attempted: true, ok: false, line, error: `${bin} exited ${res.status}` };
  }
  return { attempted: true, ok: true, line };
}
