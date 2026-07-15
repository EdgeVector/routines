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
});

afterEach(() => {
  delete process.env.ROUTINES_HOME;
  delete process.env.ROUTINES_FSITUATIONS_BIN;
  rmSync(home, { recursive: true, force: true });
});

test("status prefers reparsed latest run outcome over persisted unknown state", () => {
  mkdirSync(join(home, "registry"), { recursive: true });
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
