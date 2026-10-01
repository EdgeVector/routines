import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeHeartbeat } from "../src/heartbeat.ts";
import type { RunResult } from "../src/runner.ts";
import type { RoutineEntry } from "../src/registry.ts";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

function makeEntry(overrides: Partial<RoutineEntry> = {}): RoutineEntry {
  return {
    id: "unit-routine",
    harness: "codex",
    model: "gpt-test",
    resolvedBy: "pin",
    rrule: "FREQ=SECONDLY",
    parsedRrule: { freq: "SECONDLY", interval: 1, raw: "FREQ=SECONDLY" },
    cwd: "/tmp",
    status: "active",
    timeoutMin: 5,
    heartbeatSlug: "routine-heartbeats",
    sourcePath: "/tmp/unit-routine.toml",
    ...overrides,
  };
}

function makeResult(): RunResult {
  return {
    id: "unit-routine",
    runDir: "/tmp/unit-run",
    invocation: { bin: "true", args: [], display: "true" },
    exitCode: 0,
    signal: null,
    timedOut: false,
    startedAt: "2026-07-14T16:00:00.000Z",
    finishedAt: "2026-07-14T16:00:01.000Z",
    durationMs: 1000,
    heartbeat: { attempted: false, ok: true },
    outcome: { kind: "ok", detail: null, source: "exit" },
    harnessPid: null,
  };
}

describe("writeHeartbeat", () => {
  test("appends heartbeat lines to a filesystem log (not brain)", () => {
    const dir = mkdtempSync(join(tmpdir(), "routines-heartbeat-"));
    const logPath = join(dir, "heartbeats.log");
    process.env.ROUTINES_HEARTBEATS_FILE = logPath;

    const outcome = writeHeartbeat(makeEntry(), makeResult());

    expect(outcome.ok).toBe(true);
    expect(outcome.path).toBe(logPath);
    const body = readFileSync(logPath, "utf8");
    expect(body).toContain("unit-routine ok harness=codex model=gpt-test exit=0");
    expect(body.endsWith("\n")).toBe(true);
  });

  test("a safe_skip is noop, not error, even with a non-zero exit", () => {
    // The overloaded fallback slot records exit 124 + timedOut on purpose so
    // classifyHarnessOutage stays null. It never spawned a harness and nothing
    // failed, so the fleet log must not read it as a routine failure.
    const dir = mkdtempSync(join(tmpdir(), "routines-heartbeat-"));
    const logPath = join(dir, "heartbeats.log");
    process.env.ROUTINES_HEARTBEATS_FILE = logPath;

    const result = makeResult();
    result.exitCode = 124;
    result.timedOut = true;
    result.outcome = {
      kind: "noop",
      detail: "fallback-overloaded retry-later",
      source: "safe_skip",
    };

    writeHeartbeat(makeEntry(), result);

    const body = readFileSync(logPath, "utf8");
    expect(body).toContain("unit-routine noop harness=codex");
    expect(body).not.toContain("unit-routine error");
    // The exit code itself stays truthful; only the state word changes.
    expect(body).toContain("exit=124");
  });

  test("a real non-zero exit is still an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "routines-heartbeat-"));
    const logPath = join(dir, "heartbeats.log");
    process.env.ROUTINES_HEARTBEATS_FILE = logPath;

    const result = makeResult();
    result.exitCode = 1;
    result.outcome = { kind: "error", detail: "boom", source: "exit" };

    writeHeartbeat(makeEntry(), result);

    expect(readFileSync(logPath, "utf8")).toContain("unit-routine error harness=codex");
  });

  test("a missed-fire names its reason on the line", () => {
    // Nothing ran: routinesd back-filled a FREQ=DAILY occurrence it never
    // started. Without the token the reason lived only in the run directory,
    // so the line was indistinguishable from a routine that ran and failed.
    const dir = mkdtempSync(join(tmpdir(), "routines-heartbeat-"));
    const logPath = join(dir, "heartbeats.log");
    process.env.ROUTINES_HEARTBEATS_FILE = logPath;

    const result = makeResult();
    result.exitCode = 1;
    result.durationMs = 0;
    result.outcome = {
      kind: "error",
      detail:
        "missed-fire since=2026-09-28T13:45:00.000Z " +
        "first=2026-09-29T13:45:00.000Z coalesced_to=2026-10-01T13:45:00.000Z",
      source: "sink",
    };

    writeHeartbeat(makeEntry(), result);

    const body = readFileSync(logPath, "utf8");
    expect(body).toContain("reason=missed-fire");
    // The state word and exit code stay truthful; a missed daily fire IS worth
    // seeing as an error. Only the duration and the reason were wrong.
    expect(body).toContain("unit-routine error harness=codex");
    expect(body).toContain(" dur=0.0s ");
  });

  test("a detail that merely mentions missed-fire is not tagged", () => {
    // The check is anchored: only a detail that IS a missed-fire record gets
    // the token. A gate that talks about missed fires in passing ran, took real
    // wall clock, and must not be laundered into "nothing started".
    const dir = mkdtempSync(join(tmpdir(), "routines-heartbeat-"));
    const logPath = join(dir, "heartbeats.log");
    process.env.ROUTINES_HEARTBEATS_FILE = logPath;

    const result = makeResult();
    result.exitCode = 1;
    result.durationMs = 91_000;
    result.outcome = {
      kind: "error",
      detail: "healed missed-fire backlog for 3 routines",
      source: "sink",
    };

    writeHeartbeat(makeEntry(), result);

    const body = readFileSync(logPath, "utf8");
    expect(body).not.toContain("reason=missed-fire");
    expect(body).toContain(" dur=91.0s ");
  });

  test("skips when heartbeat_slug is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "routines-heartbeat-"));
    process.env.ROUTINES_HEARTBEATS_FILE = join(dir, "heartbeats.log");
    const outcome = writeHeartbeat(makeEntry({ heartbeatSlug: undefined }), makeResult());
    expect(outcome.attempted).toBe(false);
    expect(outcome.ok).toBe(true);
  });
});
