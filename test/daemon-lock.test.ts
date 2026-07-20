import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
let home: string;

beforeEach(() => {
  process.env = { ...saved };
  home = mkdtempSync(join(tmpdir(), "routines-lock-"));
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
    writeFileSync(join(home, "locks", "r2.lock"), String(dead));
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

  test("dead harness pid does not make a live daemon-owned lock stealable", () => {
    const dead = 999_999_999;
    expect(acquireLock("r3")).toBe(true);
    setLockOwnerPid("r3", dead);

    expect(readLockPid("r3")).toBe(dead);
    expect(isLocked("r3")).toBe(true);
    expect(acquireLock("r3")).toBe(false);

    const raw = JSON.parse(readFileSync(join(home, "locks", "r3.lock"), "utf8"));
    expect(raw.ownerPid).toBe(process.pid);
    expect(raw.harnessPid).toBe(dead);
    releaseLock("r3");
  });

  test("json lock with dead owner and dead harness is stealable", () => {
    const dead = 999_999_999;
    writeFileSync(
      join(home, "locks", "r4.lock"),
      JSON.stringify({ pid: dead, ownerPid: dead, harnessPid: dead }) + "\n",
    );

    try {
      process.kill(dead, 0);
      // alive — nothing to assert about steal
    } catch {
      expect(acquireLock("r4")).toBe(true);
      const raw = JSON.parse(readFileSync(join(home, "locks", "r4.lock"), "utf8"));
      expect(raw.ownerPid).toBe(process.pid);
      releaseLock("r4");
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
