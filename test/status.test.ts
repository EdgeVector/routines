import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

function writeRoutine(id: string, tier?: "spine" | "worker" | "opportunistic"): void {
  writeFileSync(
    join(home, "registry", `${id}.toml`),
    [
      'harness = "codex"',
      'model = "gpt-5"',
      'rrule = "FREQ=HOURLY"',
      'prompt = "hello"',
      ...(tier ? [`tier = "${tier}"`] : []),
      `cwd = "${home}"`,
      "",
    ].join("\n"),
  );
}

test("status exposes capacity tier without guessing a default", () => {
  writeRoutine("pickup-worker", "worker");
  writeRoutine("legacy-unclassified");

  const rows = collectStatus(new Date("2026-08-08T04:10:00.000Z")).rows;
  expect(rows.find((row) => row.id === "pickup-worker")?.tier).toBe("worker");
  expect(rows.find((row) => row.id === "legacy-unclassified")?.tier).toBeNull();
});

function writeLiveLock(id: string): void {
  mkdirSync(join(home, "locks"), { recursive: true });
  writeFileSync(join(home, "locks", `${id}.lock`), String(process.pid));
}

function writeDeadLock(id: string): string {
  mkdirSync(join(home, "locks"), { recursive: true });
  const path = join(home, "locks", `${id}.lock`);
  writeFileSync(path, "999999999");
  return path;
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

test("status reports a FINISHED run's unknown instead of an earlier run's outcome", () => {
  const id = "finished-without-a-result";
  writeRoutine(id);

  // An earlier fire that recorded a healthy outcome.
  const earlier = join(home, "runs", id, "2026-08-30T17-03-00-000Z");
  mkdirSync(earlier, { recursive: true });
  writeFileSync(
    join(earlier, "meta.json"),
    JSON.stringify({
      startedAt: "2026-08-30T17:03:00.000Z",
      finishedAt: "2026-08-30T17:13:00.000Z",
      exitCode: 0,
      timedOut: false,
      outcome: "ok",
      outcomeDetail: "worked=board-reconcile result=closed=3",
      outcomeSource: "sink",
    }),
  );

  // The newest fire FINISHED cleanly but emitted no ROUTINE_RESULT trailer,
  // so it recorded no outcome. Its stdout carries no parseable result either.
  const latest = join(home, "runs", id, "2026-08-30T18-32-00-000Z");
  mkdirSync(latest, { recursive: true });
  writeFileSync(
    join(latest, "meta.json"),
    JSON.stringify({
      startedAt: "2026-08-30T18:32:00.000Z",
      finishedAt: "2026-08-30T18:45:00.000Z",
      exitCode: 0,
      timedOut: false,
      outcome: "unknown",
      outcomeDetail: null,
      outcomeSource: "none",
    }),
  );
  writeFileSync(join(latest, "stdout.log"), "did some work and then stopped\n");

  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(
    join(home, "state", `${id}.json`),
    JSON.stringify({
      id,
      lastRun: "2026-08-30T18:45:00.000Z",
      lastExit: 0,
      lastRunDir: latest,
      lastOutcome: "unknown",
    }),
  );

  const row = collectStatus(new Date("2026-08-30T19:00:00.000Z")).rows.find(
    (candidate) => candidate.id === id,
  )!;

  // The row's lastRun/lastRunDir already point at the newest fire; its outcome
  // must point at the same fire, not at the healthy one before it.
  expect(row.lastRunDir).toBe(latest);
  expect(row.lastOutcome).toBe("unknown");
  expect(row.lastOutcomeDetail).toBeNull();
  expect(row.outcomeUnknown).toBe(1);
  expect(row.outcomeOk).toBe(1);
});

/**
 * The fixture is built with parallel async I/O on purpose.
 *
 * 36 routines x ~7 files is ~250 filesystem operations. Each *sync* operation
 * pays the full queue latency of the volume it lands on: measured 36-70 ms per
 * 12-byte writeFileSync while the machine was loaded, against 12 ms amortised
 * when the same writes are issued in parallel. Built serially this setup alone
 * took ~17 s and the test failed bun's 5 s default before `collectStatus` was
 * ever called. The wait is I/O queueing, not CPU, so overlapping it is the fix;
 * the subject under test is still measured synchronously below.
 */
test("status stays bounded and complete with 36 in-flight routines", async () => {
  writeFileSync(situationsBin, "#!/bin/sh\nwhile :; do :; done\n");

  const stateDir = join(home, "state");
  const ids = Array.from({ length: 36 }, (_, i) => `in-flight-${String(i).padStart(2, "0")}`);
  const completedDir = (id: string) => join(home, "runs", id, "2026-08-08T03-00-00-000Z");
  const currentDir = (id: string) => join(home, "runs", id, "2026-08-08T04-00-00-000Z");

  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(join(home, "locks"), { recursive: true }),
    ...ids.flatMap((id) => [
      mkdir(completedDir(id), { recursive: true }),
      mkdir(currentDir(id), { recursive: true }),
    ]),
  ]);

  await Promise.all(
    ids.flatMap((id) => [
      writeFile(
        join(home, "registry", `${id}.toml`),
        [
          'harness = "codex"',
          'model = "gpt-5"',
          'rrule = "FREQ=HOURLY"',
          'prompt = "hello"',
          `cwd = "${home}"`,
          "",
        ].join("\n"),
      ),
      writeFile(join(home, "locks", `${id}.lock`), String(process.pid)),
      writeFile(
        join(completedDir(id), "meta.json"),
        JSON.stringify({
          startedAt: "2026-08-08T03:00:00.000Z",
          finishedAt: "2026-08-08T03:05:00.000Z",
          exitCode: 0,
          timedOut: false,
          outcome: "ok",
          outcomeDetail: "last-finished",
        }),
      ),
      writeFile(
        join(currentDir(id), "meta.json"),
        JSON.stringify({
          status: "running",
          startedAt: "2026-08-08T04:00:00.000Z",
          harnessPid: process.pid,
          exitCode: null,
          finishedAt: null,
        }),
      ),
      writeFile(
        join(stateDir, `${id}.json`),
        JSON.stringify({
          id,
          lastRun: "2026-08-08T03:05:00.000Z",
          lastExit: 0,
          lastRunDir: completedDir(id),
          lastOutcome: "ok",
          lastOutcomeDetail: "last-finished",
        }),
      ),
    ]),
  );

  const started = performance.now();
  const snapshot = collectStatus(new Date("2026-08-08T04:10:00.000Z"), {
    situationsTimeoutMs: 50,
  });
  const elapsedMs = performance.now() - started;

  expect(elapsedMs).toBeLessThan(5_000);
  expect(snapshot.situationsOk).toBe(false);
  expect(snapshot.rows).toHaveLength(36);
  for (const row of snapshot.rows) {
    expect(row.running).toBe(true);
    expect(row.status).toBe("active");
    expect(row.timeoutMin).toBe(30);
    expect(row.lastExit).toBe(0);
    expect(row.lastOutcome).toBe("ok");
    expect(row.lastOutcomeDetail).toBe("last-finished");
    expect(row.nextFire).not.toBeNull();
  }
});

test("status reparses historical outcome from bounded log tail", () => {
  writeRoutine("large-log-history");
  const runDir = join(home, "runs/large-log-history", "2026-07-16T15-58-40-903Z");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        finishedAt: "2026-07-16T15:58:40.903Z",
        exitCode: 0,
        timedOut: false,
        outcome: "unknown",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(runDir, "stdout.log"),
    `${"noise\n".repeat(50_000)}ROUTINE_RESULT outcome=ok detail=large-log-tail\n`,
  );

  const row = collectStatus(new Date("2026-07-16T16:00:00Z")).rows.find(
    (r) => r.id === "large-log-history",
  );
  expect(row?.lastOutcome).toBe("ok");
  expect(row?.lastOutcomeDetail).toBe("large-log-tail");
});

test("status heals db-perf-guard stale memory_unwritable meta from successful append log", () => {
  writeRoutine("db-perf-guard");
  const runDir = join(home, "runs/db-perf-guard", "2026-08-01T08-30-28-136Z");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        startedAt: "2026-08-01T08:30:28.136Z",
        finishedAt: "2026-08-01T09:07:53.579Z",
        exitCode: 0,
        timedOut: false,
        outcome: "error",
        outcomeDetail:
          "memory_unwritable=/Users/tomtang/.routines/memory/db-perf-guard/memory.md tracked=db-perf-criterion-bench-profile-compile-timeout-20260801",
        outcomeSource: "heartbeat",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(runDir, "stdout.log"),
    [
      "db-perf-guard completed with a tracked finding.",
      "",
      "Memory guard was GREEN: `4 passed`.",
      "",
      "Logs are preserved in `/Users/tomtang/.routines/runs/db-perf-guard/2026-08-01T08-30-28-136Z/`.",
      "The worktree was removed, and heartbeat was appended to `/Users/tomtang/.routines/memory/db-perf-guard/memory.md`.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(runDir, "stderr.log"),
    [
      'exec',
      '/bin/zsh -lc "mkdir -p /Users/tomtang/.routines/memory/db-perf-guard; printf \'%s\\n\' \'db-perf-guard 2026-08-01T09:12:00Z ok tracked=db-perf-criterion-bench-profile-compile-timeout-20260801 memory_guard=green criterion=no-measurements-timeout stress=skipped teardown=ok\' >> /Users/tomtang/.routines/memory/db-perf-guard/memory.md || printf \'%s\\n\' \'db-perf-guard 2026-08-01T09:12:00Z error memory_unwritable=/Users/tomtang/.routines/memory/db-perf-guard/memory.md tracked=db-perf-criterion-bench-profile-compile-timeout-20260801\' || true"',
      " succeeded in 773ms:",
      "",
    ].join("\n"),
  );

  const row = collectStatus(new Date("2026-08-01T09:30:00Z")).rows.find(
    (r) => r.id === "db-perf-guard",
  );

  expect(row?.lastOutcome).toBe("ok");
  expect(row?.lastOutcomeDetail).toContain(
    "tracked=db-perf-criterion-bench-profile-compile-timeout-20260801",
  );
  expect(row?.outcomeError).toBe(0);
});

test("status heals stale Codex model cache error meta from open-cutovers empty pass logs", () => {
  writeRoutine("open-cutovers-driver");
  const runDir = join(home, "runs/open-cutovers-driver", "2026-08-02T16-41-16-177Z");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        startedAt: "2026-08-02T16:41:16.177Z",
        finishedAt: "2026-08-02T16:43:34.452Z",
        exitCode: 0,
        timedOut: false,
        outcome: "error",
        outcomeDetail:
          "codex_models_manager::manager: failed to renew cache TTL: missing field `supports_reasoning_summaries` at line 86 column 5",
        outcomeSource: "heartbeat",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(runDir, "stdout.log"),
    [
      "OPEN_CUTOVERS_LIVE=0 ADVANCED=none RESOLVED=none BLOCKED=none RESIDUE_SWEPT=none",
      "",
      "Completed the bounded scheduled pass. Situations preflight and fkanban read succeeded, `brain get open-cutovers --type reference` found zero live `status=open` cutovers.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(runDir, "stderr.log"),
    [
      "2026-08-02T16:41:41.868271Z ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `supports_reasoning_summaries` at line 86 column 5",
      "",
    ].join("\n"),
  );

  const row = collectStatus(new Date("2026-08-02T17:00:00Z")).rows.find(
    (r) => r.id === "open-cutovers-driver",
  );

  expect(row?.lastOutcome).toBe("noop");
  expect(row?.lastOutcomeDetail).toContain("live_count=0");
  expect(row?.outcomeNoop).toBe(1);
  expect(row?.outcomeError).toBe(0);
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

test("completed latest run clears dead single-flight lock", () => {
  writeRoutine("done-dead-lock");
  const lockPath = writeDeadLock("done-dead-lock");
  const runDir = join(home, "runs", "done-dead-lock", "2026-07-16T15-58-40-903Z");
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

  const row = collectStatus(new Date("2026-07-16T16:00:00Z")).rows.find(
    (r) => r.id === "done-dead-lock",
  );
  expect(row?.running).toBe(false);
  expect(existsSync(lockPath)).toBe(false);
});

test("live lock still reports running when the latest run has not completed", () => {
  writeRoutine("live");
  writeLiveLock("live");
  mkdirSync(join(home, "runs", "live", "2026-07-16T15-58-40-903Z"), { recursive: true });

  const row = collectStatus(new Date("2026-07-16T16:00:00Z")).rows.find((r) => r.id === "live");
  expect(row?.running).toBe(true);
});

test("running status exposes current run separately from last completed run", () => {
  writeRoutine("active-again");
  writeLiveLock("active-again");
  const completed = join(home, "runs", "active-again", "2026-07-16T15-00-00-000Z");
  mkdirSync(completed, { recursive: true });
  writeFileSync(
    join(completed, "meta.json"),
    JSON.stringify(
      {
        finishedAt: "2026-07-16T15:05:00.000Z",
        startedAt: "2026-07-16T15:00:00.000Z",
        exitCode: 0,
        timedOut: false,
        outcome: "ok",
      },
      null,
      2,
    ),
  );
  const current = join(home, "runs", "active-again", "2026-07-16T15-58-40-903Z");
  mkdirSync(current, { recursive: true });
  writeFileSync(
    join(current, "meta.json"),
    JSON.stringify(
      {
        status: "running",
        startedAt: "2026-07-16T15:58:40.903Z",
        harnessPid: process.pid,
        exitCode: null,
        finishedAt: null,
      },
      null,
      2,
    ),
  );

  const row = collectStatus(new Date("2026-07-16T16:00:00Z")).rows.find(
    (r) => r.id === "active-again",
  );

  expect(row?.running).toBe(true);
  expect(row?.lastRun).toBeNull();
  expect(row?.lastOutcome).toBe("ok");
  expect(row?.currentRun).toBe("2026-07-16T15-58-40-903Z");
  expect(row?.currentRunDir).toBe(current);
  expect(row?.currentStartedAt).toBe("2026-07-16T15:58:40.903Z");
});

test("running meta with exitCode null is not treated as latest completed history", () => {
  writeRoutine("active-history");
  writeLiveLock("active-history");
  const completed = join(home, "runs", "active-history", "2026-07-16T15-00-00-000Z");
  mkdirSync(completed, { recursive: true });
  writeFileSync(
    join(completed, "meta.json"),
    JSON.stringify(
      {
        finishedAt: "2026-07-16T15:05:00.000Z",
        exitCode: 0,
        timedOut: false,
        outcome: "ok",
      },
      null,
      2,
    ),
  );
  const current = join(home, "runs", "active-history", "2026-07-16T15-58-40-903Z");
  mkdirSync(current, { recursive: true });
  writeFileSync(
    join(current, "meta.json"),
    JSON.stringify(
      {
        status: "running",
        startedAt: "2026-07-16T15:58:40.903Z",
        harnessPid: process.pid,
        exitCode: null,
        finishedAt: null,
      },
      null,
      2,
    ),
  );

  const row = collectStatus(new Date("2026-07-16T16:00:00Z")).rows.find(
    (r) => r.id === "active-history",
  );

  expect(row?.running).toBe(true);
  expect(row?.lastOutcome).toBe("ok");
  expect(row?.currentRun).toBe("2026-07-16T15-58-40-903Z");
});

test("dead lock is cleared even when an unfinished run dir is newer than the completed run", () => {
  writeRoutine("dead-active-history");
  const lockPath = writeDeadLock("dead-active-history");
  const completed = join(home, "runs", "dead-active-history", "2026-07-16T15-00-00-000Z");
  mkdirSync(completed, { recursive: true });
  writeFileSync(
    join(completed, "meta.json"),
    JSON.stringify(
      {
        finishedAt: "2026-07-16T15:05:00.000Z",
        exitCode: 0,
        timedOut: false,
        outcome: "ok",
      },
      null,
      2,
    ),
  );
  const unfinished = join(home, "runs", "dead-active-history", "2026-07-16T15-58-40-903Z");
  mkdirSync(unfinished, { recursive: true });
  writeFileSync(
    join(unfinished, "meta.json"),
    JSON.stringify(
      {
        status: "running",
        startedAt: "2026-07-16T15:58:40.903Z",
        harnessPid: 999_999_999,
        exitCode: null,
        finishedAt: null,
      },
      null,
      2,
    ),
  );

  const row = collectStatus(new Date("2026-07-16T16:00:00Z")).rows.find(
    (r) => r.id === "dead-active-history",
  );

  expect(row?.running).toBe(false);
  // The newest run dir was reconciled as orphaned, so it is now a FINISHED run
  // that carries no outcome. It owns the row: reporting the earlier "ok" here
  // would hide an orphaned run behind the success before it.
  expect(row?.lastOutcome).toBe("unknown");
  expect(row?.lastOutcomeDetail).toContain("orphaned");
  expect(existsSync(lockPath)).toBe(false);
});

test("orphan reconciliation finalizes older unfinished run dirs without regressing lastRun", () => {
  writeRoutine("old-unfinished-history");
  const oldRun = join(home, "runs", "old-unfinished-history", "2026-07-16T14-00-00-000Z");
  mkdirSync(oldRun, { recursive: true });
  writeFileSync(
    join(oldRun, "meta.json"),
    JSON.stringify(
      {
        status: "running",
        startedAt: "2026-07-16T14:00:00.000Z",
        harnessPid: 999_999_999,
        exitCode: null,
        finishedAt: null,
      },
      null,
      2,
    ),
  );
  const completed = join(home, "runs", "old-unfinished-history", "2026-07-16T15-00-00-000Z");
  mkdirSync(completed, { recursive: true });
  writeFileSync(
    join(completed, "meta.json"),
    JSON.stringify(
      {
        status: "finished",
        finishedAt: "2026-07-16T15:05:00.000Z",
        exitCode: 0,
        timedOut: false,
        outcome: "ok",
      },
      null,
      2,
    ),
  );

  const row = collectStatus(new Date("2026-07-16T16:00:00Z")).rows.find(
    (r) => r.id === "old-unfinished-history",
  );
  const oldMeta = JSON.parse(readFileSync(join(oldRun, "meta.json"), "utf8"));

  expect(row?.running).toBe(false);
  expect(row?.lastOutcome).toBe("ok");
  expect(oldMeta.status).toBe("orphaned");
});

test("status self-heals stale running meta whose harness pid is dead", () => {
  writeRoutine("orphan");
  const runDir = join(home, "runs", "orphan", "2026-07-18T07-41-09-652Z");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        id: "orphan",
        status: "running",
        harnessPid: 999_999_999,
        startedAt: "2026-07-18T07:41:09.652Z",
        exitCode: null,
        finishedAt: null,
      },
      null,
      2,
    ),
  );

  const row = collectStatus(new Date("2026-07-18T07:50:00Z")).rows.find((r) => r.id === "orphan");
  const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));

  expect(row?.running).toBe(false);
  expect(meta.status).toBe("orphaned");
  expect(meta.finishedAt).toBe("2026-07-18T07:50:00.000Z");
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
