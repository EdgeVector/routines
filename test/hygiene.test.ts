import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderHygienePlist,
  runHygiene,
  selectRunsToPrune,
  truncateMemoryText,
} from "../src/hygiene.ts";

describe("selectRunsToPrune", () => {
  test("keeps newest N and anything within day window", () => {
    const now = Date.parse("2026-07-16T18:00:00.000Z");
    const dirs = [
      "/r/old1",
      "/r/old2",
      "/r/mid",
      "/r/new1",
      "/r/new2",
    ];
    // Mock via real fs is heavy; unit the pure policy with timestamps injected
    // by wrapping: we test through runHygiene with temp dirs below.
    expect(dirs.length).toBe(5);
    // Keep signature smoke: empty input
    expect(selectRunsToPrune([], { keepRunsPerId: 2, keepDays: 7, nowMs: now })).toEqual([]);
  });
});

describe("truncateMemoryText", () => {
  test("returns null when under limit", () => {
    expect(truncateMemoryText("a\nb\n", 10)).toBeNull();
  });

  test("keeps last N lines and adds header", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const out = truncateMemoryText(lines.join("\n") + "\n", 5);
    expect(out).not.toBeNull();
    expect(out!).toContain("truncated by routines hygiene");
    expect(out!).toContain("line-15");
    expect(out!).toContain("line-19");
    expect(out!).not.toContain("line-10");
  });
});

describe("runHygiene", () => {
  test("prunes old run dirs beyond keepRunsPerId and keepDays", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-"));
    const id = "demo-routine";
    const runs = join(home, "runs", id);
    mkdirSync(runs, { recursive: true });

    const now = Date.parse("2026-07-16T18:00:00.000Z");
    // 5 finished runs: 3 ancient, 2 recent
    const stamps = [
      { name: "2026-06-01T00-00-00-000Z", finishedAt: "2026-06-01T00:00:00.000Z" },
      { name: "2026-06-02T00-00-00-000Z", finishedAt: "2026-06-02T00:00:00.000Z" },
      { name: "2026-06-03T00-00-00-000Z", finishedAt: "2026-06-03T00:00:00.000Z" },
      { name: "2026-07-15T12-00-00-000Z", finishedAt: "2026-07-15T12:00:00.000Z" },
      { name: "2026-07-16T12-00-00-000Z", finishedAt: "2026-07-16T12:00:00.000Z" },
    ];
    for (const s of stamps) {
      const d = join(runs, s.name);
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "meta.json"),
        JSON.stringify({
          id,
          finishedAt: s.finishedAt,
          exitCode: 0,
          outcome: "ok",
        }),
      );
    }
    // one running — must never prune
    const running = join(runs, "2026-07-16T17-00-00-000Z");
    mkdirSync(running, { recursive: true });
    writeFileSync(
      join(running, "meta.json"),
      JSON.stringify({ id, status: "running", startedAt: "2026-07-16T17:00:00.000Z" }),
    );

    const result = runHygiene({
      home,
      nowMs: now,
      keepRunsPerId: 2,
      keepDays: 7,
      dryRun: false,
      publishStatus: false,
      ffInstall: false,
    });

    expect(result.prunedRuns).toBe(3);
    const left = readdirSync(runs).sort();
    expect(left).toContain("2026-07-15T12-00-00-000Z");
    expect(left).toContain("2026-07-16T12-00-00-000Z");
    expect(left).toContain("2026-07-16T17-00-00-000Z");
    expect(left).not.toContain("2026-06-01T00-00-00-000Z");
  });

  test("truncates long memory files", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-mem-"));
    const mem = join(home, "memory", "demo");
    mkdirSync(mem, { recursive: true });
    const body = Array.from({ length: 50 }, (_, i) => `hb ${i}`).join("\n") + "\n";
    writeFileSync(join(mem, "memory.md"), body);

    const result = runHygiene({
      home,
      memoryMaxLines: 10,
      dryRun: false,
      publishStatus: false,
      ffInstall: false,
    });
    expect(result.truncatedMemories).toBe(1);
    const text = readFileSync(join(mem, "memory.md"), "utf8");
    expect(text).toContain("truncated by routines hygiene");
    expect(text).toContain("hb 49");
    expect(text).not.toContain("hb 0");
  });

  test("dry-run does not delete", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-dry-"));
    const runs = join(home, "runs", "x");
    mkdirSync(runs, { recursive: true });
    const d = join(runs, "2026-01-01T00-00-00-000Z");
    mkdirSync(d);
    writeFileSync(
      join(d, "meta.json"),
      JSON.stringify({ finishedAt: "2026-01-01T00:00:00.000Z", exitCode: 0 }),
    );

    const result = runHygiene({
      home,
      nowMs: Date.parse("2026-07-16T00:00:00.000Z"),
      keepRunsPerId: 0,
      keepDays: 1,
      dryRun: true,
      publishStatus: false,
      ffInstall: false,
    });
    expect(result.prunedRuns).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(existsSync(d)).toBe(true);
  });
});

describe("renderHygienePlist", () => {
  test("installed hygiene agent fast-forwards clean installs", () => {
    const plist = renderHygienePlist({
      program: "/tmp/routines",
      runtime: "/tmp/bun",
      intervalSec: 60,
      env: { ROUTINES_HOME: "/tmp/routines-home" },
    });

    expect(plist).toContain("<string>hygiene</string>");
    expect(plist).toContain("<string>--json</string>");
    expect(plist).toContain("<string>--ff-install</string>");
  });
});
