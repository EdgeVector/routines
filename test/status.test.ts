import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectStatus } from "../src/status.ts";

let home: string;
let situationsBin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "routines-status-"));
  process.env.ROUTINES_HOME = home;

  situationsBin = join(home, "situations");
  writeFileSync(situationsBin, "#!/bin/sh\necho '[]'\n");
  chmodSync(situationsBin, 0o755);
  process.env.ROUTINES_FSITUATIONS_BIN = situationsBin;

  mkdirSync(join(home, "registry"), { recursive: true });
});

afterEach(() => {
  delete process.env.ROUTINES_HOME;
  delete process.env.ROUTINES_FSITUATIONS_BIN;
  rmSync(home, { recursive: true, force: true });
});

function writeRoutine(id: string): void {
  writeFileSync(
    join(home, "registry", `${id}.toml`),
    [
      'harness = "codex"',
      'model = "gpt-5"',
      'rrule = "FREQ=HOURLY"',
      'prompt = "hello"',
      `cwd = "${home}"`,
      "",
    ].join("\n"),
  );
}

function writeLiveLock(id: string): void {
  mkdirSync(join(home, "locks"), { recursive: true });
  writeFileSync(join(home, "locks", `${id}.lock`), String(process.pid));
}

test("status prefers reparsed latest run outcome over persisted unknown state", () => {
  writeFileSync(
    join(home, "registry/codex-stale-agent-memory-cleanup.toml"),
    [
      'harness = "codex"',
      'model = "gpt-5.5"',
      'rrule = "FREQ=HOURLY;INTERVAL=2"',
      'prompt = "cleanup"',
      `cwd = "${home}"`,
      "timeout_min = 30",
      "",
    ].join("\n"),
  );

  const stamp = "2026-07-15T14-02-07-213Z";
  const runDir = join(home, "runs/codex-stale-agent-memory-cleanup", stamp);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        exitCode: 0,
        timedOut: false,
        outcome: "unknown",
        outcomeDetail: null,
        outcomeSource: "none",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(runDir, "stdout.log"),
    [
      "Cleanup pass completed.",
      "",
      "Terminated PIDs/processes: none.",
      "",
      "Skipped: all possible Codex agents, because process enumeration was blocked by sandbox/system policy.",
      "`pgrep -afil codex` returned `Cannot get process list` / `sysmond service not found`.",
      "",
    ].join("\n"),
  );

  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(
    join(home, "state/codex-stale-agent-memory-cleanup.json"),
    JSON.stringify(
      {
        id: "codex-stale-agent-memory-cleanup",
        lastRun: "2026-07-15T14:04:05.250Z",
        lastExit: 0,
        lastRunDir: runDir,
        lastOutcome: "unknown",
      },
      null,
      2,
    ) + "\n",
  );

  const row = collectStatus(new Date("2026-07-15T15:00:00Z")).rows[0]!;
  expect(row.id).toBe("codex-stale-agent-memory-cleanup");
  expect(row.lastOutcome).toBe("noop");
  expect(row.lastOutcomeDetail).toBe("process-enumeration-blocked terminated=0");
  expect(row.outcomeNoop).toBe(1);
  expect(row.outcomeUnknown).toBe(0);
});

test("completed latest run suppresses stale running lock in status", () => {
  writeRoutine("done");
  writeLiveLock("done");
  const runDir = join(home, "runs", "done", "2026-07-16T15-58-40-903Z");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        finishedAt: "2026-07-16T15:58:40.903Z",
        exitCode: 0,
        timedOut: false,
        outcome: "ok",
      },
      null,
      2,
    ),
  );

  const row = collectStatus(new Date("2026-07-16T16:00:00Z")).rows.find((r) => r.id === "done");
  expect(row?.running).toBe(false);
  expect(row?.lastOutcome).toBe("ok");
});

test("live lock still reports running when the latest run has not completed", () => {
  writeRoutine("live");
  writeLiveLock("live");
  mkdirSync(join(home, "runs", "live", "2026-07-16T15-58-40-903Z"), { recursive: true });

  const row = collectStatus(new Date("2026-07-16T16:00:00Z")).rows.find((r) => r.id === "live");
  expect(row?.running).toBe(true);
});

test("status reports the effective fallback route, not just the configured primary", () => {
  // Reproduces the live confusion behind fkanban-pickup-harness-config-not-honored:
  // registry declares harness=codex, codex is outaged, so dispatch silently
  // substitutes claude. `routines status` must surface that substitution
  // instead of echoing the stale configured harness/model as if it were live.
  writeRoutine("codex-primary");

  mkdirSync(join(home, "harness-outage"), { recursive: true });
  writeFileSync(
    join(home, "harness-outage", "codex.json"),
    JSON.stringify({
      kind: "capacity",
      lastSeenAt: "2026-07-18T00:48:41.017Z",
      situationSlug: "harness-outage-codex",
      expiresAt: "2026-07-18T06:48:41.017Z",
    }),
  );

  const row = collectStatus(new Date("2026-07-18T02:00:00Z")).rows.find((r) => r.id === "codex-primary");
  expect(row?.harness).toBe("codex");
  expect(row?.model).toBe("gpt-5");
  expect(row?.effectiveHarness).toBe("claude");
  expect(row?.effectiveModel).toBe("sonnet");
});

test("status effective route matches configured route when no outage is active", () => {
  writeRoutine("codex-healthy");

  const row = collectStatus(new Date("2026-07-18T02:00:00Z")).rows.find((r) => r.id === "codex-healthy");
  expect(row?.harness).toBe("codex");
  expect(row?.effectiveHarness).toBe("codex");
  expect(row?.model).toBe("gpt-5");
  expect(row?.effectiveModel).toBe("gpt-5");
});
