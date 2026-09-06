import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  dispatchTaskAlive,
  reapUnspawnedDispatches,
  recordDispatchSlot,
} from "../src/daemon.ts";
import {
  acquireFallbackSlot,
  waitForFallbackSlot,
} from "../src/fallback-slots.ts";
import { createWaitingRunDir } from "../src/runner.ts";
import { parseRRule } from "../src/rrule.ts";
import type { RoutineEntry } from "../src/registry.ts";
import { collectStatus } from "../src/status.ts";

const saved = { ...process.env };
let home: string;
const DEADLINE_MS = 600_000;
const OLD_MS = DEADLINE_MS + 60_000;

function entry(id: string): RoutineEntry {
  return {
    id,
    harness: "claude",
    model: "sonnet",
    resolvedBy: "pin",
    rrule: "FREQ=HOURLY",
    parsedRrule: parseRRule("FREQ=HOURLY"),
    cwd: home,
    status: "active",
    timeoutMin: 30,
    sourcePath: join(home, "registry", `${id}.toml`),
  };
}

beforeEach(() => {
  process.env = { ...saved };
  home = mkdtempSync(join(tmpdir(), "routines-wait-reap-"));
  process.env.ROUTINES_HOME = home;
  process.env.ROUTINES_FALLBACK_JITTER_MS = "0";
  process.env.ROUTINES_FALLBACK_MAX_CONCURRENT = "1";
  mkdirSync(join(home, "locks"), { recursive: true });
  mkdirSync(join(home, "runs"), { recursive: true });
  mkdirSync(join(home, "registry"), { recursive: true });
});

describe("fallback-slot wait vs unspawned reaper", () => {
  test("a waiting run dir + live task survive a reaper past the spawn deadline", () => {
    const inFlight = new Set<string>();
    const id = "pickup-w2";
    expect(acquireLock(id)).toBe(true);
    inFlight.add(id);
    recordDispatchSlot(inFlight, id, Date.now() - OLD_MS);

    const waiting = createWaitingRunDir(entry(id), { quiet: true }, "claude");
    expect(readdirSync(join(home, "runs", id)).length).toBe(1);
    const meta = JSON.parse(readFileSync(join(waiting.runDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("waiting");
    expect(meta.waitingForHarness).toBe("claude");
    expect(dispatchTaskAlive(inFlight, id)).toBe(true);

    expect(reapUnspawnedDispatches(inFlight, () => {})).toEqual([]);
    expect(inFlight.has(id)).toBe(true);
  });

  test("waitForFallbackSlot emits onWait after the configured threshold", async () => {
    // Saturate the cap so the waiter blocks.
    const holder = acquireFallbackSlot("claude", { pid: process.pid, id: "holder" });
    expect(holder).toBeTruthy();

    const events: Array<{ harness: string; queueDepth: number }> = [];
    const waiter = waitForFallbackSlot(
      "claude",
      { pid: process.pid, id: "waiter" },
      {
        deadlineMs: 200,
        jitterMs: 0,
        waitLogAfterMs: 30,
        onWait: (info) => events.push({ harness: info.harness, queueDepth: info.queueDepth }),
      },
    );

    const result = await waiter;
    expect("overloaded" in result).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0]?.harness).toBe("claude");
    expect(events[0]?.queueDepth).toBeGreaterThanOrEqual(1);
  });

  test("collectStatus surfaces waitDetail for a waiting run directory", () => {
    const id = "status-wait";
    // Filename is the routine id; mirror status.test.ts writeRoutine shape.
    writeFileSync(
      join(home, "registry", `${id}.toml`),
      [
        'harness = "codex"',
        'model = "gpt-5.5"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "hello"',
        `cwd = "${home}"`,
        "",
      ].join("\n"),
    );
    expect(acquireLock(id)).toBe(true);
    createWaitingRunDir(entry(id), { quiet: true }, "grok");

    const snap = collectStatus(new Date());
    const row = snap.rows.find((r) => r.id === id);
    expect(row).toBeTruthy();
    expect(row?.running).toBe(true);
    expect(row?.waitDetail).toContain("waiting for grok slot since");
  });
});
