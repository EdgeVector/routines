import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reconcileOrphanedRuns, startDaemon, type DaemonEvent } from "../src/daemon.ts";
import { readState, writeState } from "../src/state.ts";

const saved = { ...process.env };

let home: string;

beforeEach(() => {
  process.env = { ...saved };
  home = mkdtempSync(join(tmpdir(), "routines-orphan-"));
  process.env.ROUTINES_HOME = home;
  mkdirSync(join(home, "registry"), { recursive: true });
});

function writeMeta(runDir: string, meta: Record<string, unknown>): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

describe("reconcileOrphanedRuns", () => {
  test("finalizes a running run whose harness pid is dead", () => {
    const runDir = join(home, "runs", "foo", "2026-07-18T01-00-00-000Z");
    writeMeta(runDir, {
      id: "foo",
      status: "running",
      harnessPid: 999_999_999, // near-certainly dead
      startedAt: "2026-07-18T01:00:00.000Z",
      exitCode: null,
      finishedAt: null,
    });

    const orphaned = reconcileOrphanedRuns(new Date("2026-07-18T02:00:00.000Z"));

    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]).toMatchObject({ id: "foo", harnessPid: 999_999_999 });

    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("orphaned");
    expect(meta.exitCode).toBeNull();
    expect(meta.finishedAt).toBe("2026-07-18T02:00:00.000Z");
  });

  test("clears a dead single-flight lock for an orphaned run", () => {
    const runDir = join(home, "runs", "locked", "2026-07-18T01-00-00-000Z");
    const deadPid = 999_999_999;
    writeMeta(runDir, {
      id: "locked",
      status: "running",
      harnessPid: deadPid,
      startedAt: "2026-07-18T01:00:00.000Z",
      exitCode: null,
      finishedAt: null,
    });
    const lockPath = join(home, "locks", "locked.lock");
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(lockPath, String(deadPid));

    const orphaned = reconcileOrphanedRuns(new Date("2026-07-18T02:00:00.000Z"));

    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.clearedLock).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("leaves a running run alone when its harness pid is still alive", () => {
    const runDir = join(home, "runs", "bar", "2026-07-18T01-00-00-000Z");
    writeMeta(runDir, {
      id: "bar",
      status: "running",
      harnessPid: process.pid, // this test process — definitely alive
      startedAt: "2026-07-18T01:00:00.000Z",
      exitCode: null,
      finishedAt: null,
    });

    const orphaned = reconcileOrphanedRuns();

    expect(orphaned).toHaveLength(0);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("running");
  });

  test("leaves already-finished runs untouched", () => {
    const runDir = join(home, "runs", "baz", "2026-07-18T01-00-00-000Z");
    writeMeta(runDir, {
      id: "baz",
      status: "finished",
      harnessPid: 999_999_999,
      exitCode: 0,
      finishedAt: "2026-07-18T01:05:00.000Z",
    });

    const orphaned = reconcileOrphanedRuns();

    expect(orphaned).toHaveLength(0);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("finished");
  });

  test("returns empty when runs dir does not exist", () => {
    expect(reconcileOrphanedRuns()).toEqual([]);
  });
});

describe("startDaemon orphan reconciliation", () => {
  test("finalizes a stuck-running run at startup and logs it", async () => {
    const runDir = join(home, "runs", "stuck-routine", "2026-07-18T01-00-00-000Z");
    writeMeta(runDir, {
      id: "stuck-routine",
      status: "running",
      harnessPid: 999_999_999,
      startedAt: "2026-07-18T01:00:00.000Z",
      exitCode: null,
      finishedAt: null,
    });

    const events: DaemonEvent[] = [];
    const handle = startDaemon({ tickMs: 50, log: (e) => events.push(e) });
    handle.stop();
    await handle.done;

    const reconcileEvent = events.find((e) => e.kind === "reconcile-orphans");
    expect(reconcileEvent).toBeDefined();
    expect(reconcileEvent?.detail).toContain("stuck-routine");

    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("orphaned");
  });
});

describe("orphaned runs stay visible in per-routine state", () => {
  test("adopts the orphaned run as lastRun so status cannot silently skip it", () => {
    writeState({
      id: "dropped",
      lastRun: "2026-08-24T10:05:00.000Z",
      lastRunDir: join(home, "runs", "dropped", "2026-08-24T10-00-00-000Z"),
      lastExit: 0,
      lastOutcome: "ok",
      lastOutcomeDetail: "prior run",
    });
    const runDir = join(home, "runs", "dropped", "2026-08-24T11-00-00-000Z");
    writeMeta(runDir, {
      id: "dropped",
      status: "running",
      harnessPid: 999_999_999,
      startedAt: "2026-08-24T11:00:00.000Z",
      exitCode: null,
      finishedAt: null,
    });

    const orphaned = reconcileOrphanedRuns(new Date("2026-08-24T11:59:16.000Z"));

    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.statePatched).toBe(true);
    const st = readState("dropped");
    expect(st.lastRunDir).toBe(runDir);
    expect(st.lastRun).toBe("2026-08-24T11:59:16.000Z");
    expect(st.lastOutcome).toBe("unknown");
    expect(st.lastOutcomeDetail).toContain("orphaned");
  });

  test("recovers the real verdict from the run's own outcome sink", () => {
    const runDir = join(home, "runs", "detached", "2026-08-24T11-00-00-000Z");
    writeMeta(runDir, {
      id: "detached",
      status: "running",
      harnessPid: 999_999_999,
      startedAt: "2026-08-24T11:00:00.000Z",
      exitCode: null,
      finishedAt: null,
    });
    // The agent outlived the daemon that dispatched it and reported for itself.
    writeFileSync(join(runDir, "outcome.txt"), "ok worked=some-card result=merged\n");

    const orphaned = reconcileOrphanedRuns(new Date("2026-08-24T11:59:16.000Z"));

    expect(orphaned[0]).toMatchObject({ outcome: "ok", outcomeSource: "sink" });
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("orphaned");
    expect(meta.outcome).toBe("ok");
    expect(meta.outcomeSource).toBe("sink");
    const st = readState("detached");
    expect(st.lastOutcome).toBe("ok");
    expect(st.lastOutcomeDetail).toContain("worked=some-card");
    // finishedAt is the sink's real write time, not the reconcile instant.
    expect(st.lastRun).not.toBe("2026-08-24T11:59:16.000Z");
  });

  test("never regresses state onto an orphan older than a newer completed run", () => {
    const newerRun = join(home, "runs", "raced", "2026-08-24T12-00-00-000Z");
    writeState({
      id: "raced",
      lastRun: "2026-08-24T12:05:00.000Z",
      lastRunDir: newerRun,
      lastExit: 0,
      lastOutcome: "ok",
      lastOutcomeDetail: "newer run",
    });
    const stale = join(home, "runs", "raced", "2026-08-24T11-00-00-000Z");
    writeMeta(stale, {
      id: "raced",
      status: "running",
      harnessPid: 999_999_999,
      startedAt: "2026-08-24T11:00:00.000Z",
      exitCode: null,
      finishedAt: null,
    });
    // Newest-stamp-only scan needs the stale dir to be the newest to be seen.
    writeMeta(join(home, "runs", "raced", "2026-08-24T10-00-00-000Z"), {
      id: "raced",
      status: "finished",
      exitCode: 0,
    });

    const orphaned = reconcileOrphanedRuns(new Date("2026-08-24T13:00:00.000Z"));

    expect(orphaned[0]?.statePatched).toBe(false);
    const st = readState("raced");
    expect(st.lastRunDir).toBe(newerRun);
    expect(st.lastOutcomeDetail).toBe("newer run");
  });

  test("is idempotent — a second pass does not re-adopt the same run", () => {
    const runDir = join(home, "runs", "twice", "2026-08-24T11-00-00-000Z");
    writeMeta(runDir, {
      id: "twice",
      status: "running",
      harnessPid: 999_999_999,
      startedAt: "2026-08-24T11:00:00.000Z",
      exitCode: null,
      finishedAt: null,
    });

    expect(reconcileOrphanedRuns(new Date("2026-08-24T11:59:16.000Z"))).toHaveLength(1);
    // meta is terminal now, so the run is no longer a reconcile candidate.
    expect(reconcileOrphanedRuns(new Date("2026-08-24T12:10:00.000Z"))).toHaveLength(0);
    expect(readState("twice").lastRun).toBe("2026-08-24T11:59:16.000Z");
  });
});

describe("daemon tick-loop stop is on the record", () => {
  test("logs a stop event naming why the loop ended", async () => {
    const events: DaemonEvent[] = [];
    const handle = startDaemon({ tickMs: 50, log: (e) => events.push(e) });
    handle.stop("signal:SIGTERM");
    await handle.done;

    const stop = events.find((e) => e.kind === "stop");
    expect(stop).toBeDefined();
    expect(stop?.detail).toContain("signal:SIGTERM");
  });

  test("defaults the reason when stop() is called bare", async () => {
    const events: DaemonEvent[] = [];
    const handle = startDaemon({ tickMs: 50, log: (e) => events.push(e) });
    handle.stop();
    await handle.done;

    expect(events.find((e) => e.kind === "stop")?.detail).toContain("reason=stop()");
  });
});
