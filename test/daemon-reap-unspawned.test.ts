import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  dispatchTaskAlive,
  isLocked,
  markDispatchTaskSettled,
  reapUnspawnedDispatches,
  recordDispatchSlot,
  slotStillOwnedBy,
  setLockOwnerPid,
  unspawnedCount,
  type DaemonEvent,
} from "../src/daemon.ts";

const saved = { ...process.env };
let home: string;

const DEADLINE_MS = 600_000;
/** Comfortably past the deadline. */
const OLD_MS = DEADLINE_MS + 60_000;

beforeEach(() => {
  process.env = { ...saved };
  home = mkdtempSync(join(tmpdir(), "routines-reap-"));
  process.env.ROUTINES_HOME = home;
  mkdirSync(join(home, "locks"), { recursive: true });
  mkdirSync(join(home, "runs"), { recursive: true });
});

/** Kick off `id` at `ageMs` in the past, exactly as tryDispatch does. */
function dispatch(inFlight: Set<string>, id: string, ageMs: number): number {
  expect(acquireLock(id)).toBe(true);
  inFlight.add(id);
  return recordDispatchSlot(inFlight, id, Date.now() - ageMs);
}

/** Simulate a settled-but-leaked slot (promise finished, cleanup missed). */
function settle(inFlight: Set<string>, id: string, token: number): void {
  markDispatchTaskSettled(inFlight, id, token);
}

function collect(): { log: (e: DaemonEvent) => void; events: DaemonEvent[] } {
  const events: DaemonEvent[] = [];
  return { log: (e) => void events.push(e), events };
}

describe("reapUnspawnedDispatches", () => {
  test("frees the slot and the lock of a dispatch that never started", () => {
    const inFlight = new Set<string>();
    const token = dispatch(inFlight, "r1", OLD_MS);
    settle(inFlight, "r1", token);
    const { log, events } = collect();

    expect(reapUnspawnedDispatches(inFlight, log)).toEqual(["r1"]);
    expect(inFlight.has("r1")).toBe(false);
    expect(isLocked("r1")).toBe(false);

    const reap = events.find((e) => e.kind === "reap-unspawned");
    expect(reap?.id).toBe("r1");
    expect(reap?.detail).toContain("never started");
  });

  test("leaves a dispatch that is still inside the spawn deadline", () => {
    const inFlight = new Set<string>();
    const token = dispatch(inFlight, "r2", DEADLINE_MS - 60_000);
    settle(inFlight, "r2", token);
    const { log, events } = collect();

    expect(reapUnspawnedDispatches(inFlight, log)).toEqual([]);
    expect(inFlight.has("r2")).toBe(true);
    expect(isLocked("r2")).toBe(true);
    expect(events).toEqual([]);
  });

  test("leaves an old dispatch whose harness did spawn", () => {
    const inFlight = new Set<string>();
    const token = dispatch(inFlight, "r3", OLD_MS);
    settle(inFlight, "r3", token);
    // A real harness child recorded its pid on the lock.
    setLockOwnerPid("r3", process.pid);
    const { log } = collect();

    expect(reapUnspawnedDispatches(inFlight, log)).toEqual([]);
    expect(inFlight.has("r3")).toBe(true);
    expect(isLocked("r3")).toBe(true);
  });

  // The gate_command case. `runOnce` creates the run directory before the
  // zero-LLM gate, so a routine can sit for many minutes with no harness pid
  // and still be perfectly alive. Reaping it would break single-flight and let
  // the same routine dispatch twice.
  test("leaves an old dispatch with no harness pid once a run directory exists", () => {
    const inFlight = new Set<string>();
    const token = dispatch(inFlight, "r4", OLD_MS);
    settle(inFlight, "r4", token);
    mkdirSync(join(home, "runs", "r4", "20260906T000000Z"), { recursive: true });
    const { log } = collect();

    expect(reapUnspawnedDispatches(inFlight, log)).toEqual([]);
    expect(inFlight.has("r4")).toBe(true);
    expect(isLocked("r4")).toBe(true);
  });

  test("a run directory that already existed before the kickoff is not a start", () => {
    const inFlight = new Set<string>();
    // Prior runs of this routine exist; only a NEW one proves this dispatch ran.
    mkdirSync(join(home, "runs", "r5", "20260905T000000Z"), { recursive: true });
    const token = dispatch(inFlight, "r5", OLD_MS);
    settle(inFlight, "r5", token);
    const { log } = collect();

    expect(reapUnspawnedDispatches(inFlight, log)).toEqual(["r5"]);
    expect(inFlight.has("r5")).toBe(false);
  });

  test("leaves an in-flight id this daemon did not dispatch", () => {
    const inFlight = new Set<string>();
    inFlight.add("r6"); // no slot bookkeeping
    const { log } = collect();

    expect(reapUnspawnedDispatches(inFlight, log)).toEqual([]);
    expect(inFlight.has("r6")).toBe(true);
  });

  test("does not remove a lock owned by another process", () => {
    const inFlight = new Set<string>();
    const token = dispatch(inFlight, "r7", OLD_MS);
    settle(inFlight, "r7", token);
    // Another live daemon owns the lock now.
    writeFileSync(
      join(home, "locks", "r7.lock"),
      JSON.stringify({ pid: 1, ownerPid: 1, harnessPid: null }) + "\n",
    );
    const { log, events } = collect();

    expect(reapUnspawnedDispatches(inFlight, log)).toEqual(["r7"]);
    // Our slot is given back, but their lock file stays.
    expect(inFlight.has("r7")).toBe(false);
    expect(isLocked("r7")).toBe(true);
    expect(events.find((e) => e.kind === "reap-unspawned")?.detail).toContain("not ours");
  });

  // The fallback-slot wait: past the spawn deadline, no harness pid, and (if
  // createWaitingRunDir were skipped) no run directory — but the dispatch
  // promise is still alive. The reaper must leave it alone.
  test("leaves a live dispatch task even with no run directory past the deadline", () => {
    const inFlight = new Set<string>();
    dispatch(inFlight, "r8", OLD_MS);
    expect(dispatchTaskAlive(inFlight, "r8")).toBe(true);
    const { log, events } = collect();

    expect(reapUnspawnedDispatches(inFlight, log)).toEqual([]);
    expect(inFlight.has("r8")).toBe(true);
    expect(isLocked("r8")).toBe(true);
    expect(events).toEqual([]);
  });

  // Waiting run directory alone also protects a settled-but-slow cleanup, the
  // same way a gate_command run directory does.
  test("leaves a settled dispatch once a waiting run directory exists", () => {
    const inFlight = new Set<string>();
    const token = dispatch(inFlight, "r9", OLD_MS);
    mkdirSync(join(home, "runs", "r9", "20260906T010000Z"), { recursive: true });
    settle(inFlight, "r9", token);
    const { log } = collect();

    expect(reapUnspawnedDispatches(inFlight, log)).toEqual([]);
    expect(inFlight.has("r9")).toBe(true);
  });
});

describe("unspawnedCount", () => {
  test("counts in-flight ids with no live harness behind them", () => {
    const inFlight = new Set<string>();
    dispatch(inFlight, "a", 1_000);
    dispatch(inFlight, "b", 1_000);
    setLockOwnerPid("b", process.pid);

    expect(unspawnedCount(inFlight)).toBe(1);
  });

  test("a dead harness pid still counts as unspawned", () => {
    const inFlight = new Set<string>();
    dispatch(inFlight, "c", 1_000);
    setLockOwnerPid("c", 999_999_999);

    expect(unspawnedCount(inFlight)).toBe(1);
  });
});

describe("slotStillOwnedBy — the late-settle guard", () => {
  test("a live dispatch still owns its slot", () => {
    const inFlight = new Set<string>();
    const token = recordDispatchSlot(inFlight, "x");
    expect(slotStillOwnedBy(inFlight, "x", token)).toBe(true);
  });

  test("a reaped dispatch no longer owns its slot", () => {
    const inFlight = new Set<string>();
    expect(acquireLock("x")).toBe(true);
    inFlight.add("x");
    const token = recordDispatchSlot(inFlight, "x", Date.now() - OLD_MS);
    markDispatchTaskSettled(inFlight, "x", token);
    reapUnspawnedDispatches(inFlight, () => {});
    expect(slotStillOwnedBy(inFlight, "x", token)).toBe(false);
  });

  // The dangerous case: the routine was reaped and has since been dispatched
  // again. The stale cleanup and the live slot share an id and an owner pid.
  test("a reaped dispatch does not own the slot a later kickoff took", () => {
    const inFlight = new Set<string>();
    expect(acquireLock("x")).toBe(true);
    inFlight.add("x");
    const stale = recordDispatchSlot(inFlight, "x", Date.now() - OLD_MS);
    markDispatchTaskSettled(inFlight, "x", stale);
    reapUnspawnedDispatches(inFlight, () => {});

    // Same routine dispatched again after the reap.
    expect(acquireLock("x")).toBe(true);
    inFlight.add("x");
    const fresh = recordDispatchSlot(inFlight, "x");

    expect(slotStillOwnedBy(inFlight, "x", stale)).toBe(false);
    expect(slotStillOwnedBy(inFlight, "x", fresh)).toBe(true);
  });

  test("slots are scoped to their own in-flight set", () => {
    const a = new Set<string>();
    const b = new Set<string>();
    const token = recordDispatchSlot(a, "x");
    expect(slotStillOwnedBy(a, "x", token)).toBe(true);
    expect(slotStillOwnedBy(b, "x", token)).toBe(false);
  });
});
