import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  isLocked,
  readLockPid,
  releaseLock,
  releaseLockIfOwned,
  setLockOwnerPid,
} from "../src/daemon.ts";

const saved = { ...process.env };

beforeEach(() => {
  process.env = { ...saved };
  const home = mkdtempSync(join(tmpdir(), "routines-lock-"));
  process.env.ROUTINES_HOME = home;
  mkdirSync(join(home, "locks"), { recursive: true });
});

describe("single-flight lock pid ownership", () => {
  test("acquire records a live pid; setLockOwnerPid updates to harness pid", () => {
    expect(acquireLock("r1")).toBe(true);
    expect(isLocked("r1")).toBe(true);
    expect(readLockPid("r1")).toBe(process.pid);

    // Simulate harness child with this process's pid (still alive).
    setLockOwnerPid("r1", process.pid);
    expect(readLockPid("r1")).toBe(process.pid);
    expect(isLocked("r1")).toBe(true);
    expect(acquireLock("r1")).toBe(false); // cannot re-acquire while held

    releaseLock("r1");
    expect(isLocked("r1")).toBe(false);
    expect(readLockPid("r1")).toBeNull();
  });

  test("stale lock with dead pid is stealable", () => {
    // 1 is almost always init and may be alive; use a high unused pid.
    const dead = 999_999_999;
    setLockOwnerPid("r2", dead);
    // If somehow alive, skip assertion on steal; otherwise steal succeeds.
    try {
      process.kill(dead, 0);
      // alive — nothing to assert about steal
    } catch {
      expect(acquireLock("r2")).toBe(true);
      expect(readLockPid("r2")).toBe(process.pid);
      releaseLock("r2");
    }
  });

  test("conditional release only clears the matching lock owner", () => {
    setLockOwnerPid("owned", process.pid);

    expect(releaseLockIfOwned("owned", 999_999_999)).toBe(false);
    expect(readLockPid("owned")).toBe(process.pid);

    expect(releaseLockIfOwned("owned", process.pid)).toBe(true);
    expect(readLockPid("owned")).toBeNull();
  });
});
