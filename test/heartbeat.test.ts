import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeHeartbeat } from "../src/heartbeat.ts";
import type { RunResult } from "../src/runner.ts";
import type { RoutineEntry } from "../src/registry.ts";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

function makeEntry(): RoutineEntry {
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

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe("writeHeartbeat", () => {
  test("appends heartbeat lines through fbrain stdin with the reference type", () => {
    const dir = mkdtempSync(join(tmpdir(), "routines-heartbeat-"));
    const argsPath = join(dir, "args.txt");
    const stdinPath = join(dir, "stdin.txt");
    const stub = join(dir, "fbrain");
    writeExecutable(
      stub,
      `#!/bin/sh
printf '%s\\n' "$@" > "${argsPath}"
cat > "${stdinPath}"
exit 0
`,
    );
    process.env.ROUTINES_FBRAIN_BIN = stub;

    const outcome = writeHeartbeat(makeEntry(), makeResult());

    expect(outcome.ok).toBe(true);
    expect(readFileSync(argsPath, "utf8")).toBe("append\nroutine-heartbeats\n--type\nreference\n");
    const stdin = readFileSync(stdinPath, "utf8");
    expect(stdin).toContain("unit-routine ok harness=codex model=gpt-test exit=0");
    expect(stdin.endsWith("\n")).toBe(true);
  });

  test("records fbrain stderr when append fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "routines-heartbeat-"));
    const stub = join(dir, "fbrain");
    writeExecutable(
      stub,
      `#!/bin/sh
echo 'Unknown option --text' >&2
exit 2
`,
    );
    process.env.ROUTINES_FBRAIN_BIN = stub;

    const outcome = writeHeartbeat(makeEntry(), makeResult());

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("exited 2");
    expect(outcome.error).toContain("Unknown option --text");
  });
});
