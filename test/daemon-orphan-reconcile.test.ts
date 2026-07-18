import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reconcileOrphanedRuns, startDaemon, type DaemonEvent } from "../src/daemon.ts";

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
