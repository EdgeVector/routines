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

  test("skips when heartbeat_slug is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "routines-heartbeat-"));
    process.env.ROUTINES_HEARTBEATS_FILE = join(dir, "heartbeats.log");
    const outcome = writeHeartbeat(makeEntry({ heartbeatSlug: undefined }), makeResult());
    expect(outcome.attempted).toBe(false);
    expect(outcome.ok).toBe(true);
  });
});
