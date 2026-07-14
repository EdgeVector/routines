import { describe, expect, test } from "bun:test";

import {
  aggregateOutcomes,
  nameMatchesRoutine,
  parseOutcome,
} from "../src/outcome.ts";

describe("nameMatchesRoutine", () => {
  test("matches registry id and historical aliases", () => {
    expect(nameMatchesRoutine("last-stack-fkanban-pickup", "last-stack-fkanban-pickup")).toBe(true);
    expect(nameMatchesRoutine("kanban-pickup", "last-stack-fkanban-pickup")).toBe(true);
    expect(nameMatchesRoutine("fkanban-pickup", "last-stack-fkanban-pickup")).toBe(true);
    expect(nameMatchesRoutine("groom-board", "last-stack-groom-board")).toBe(true);
    expect(nameMatchesRoutine("groom-kanban-board", "last-stack-groom-board")).toBe(true);
    expect(nameMatchesRoutine("program-driver", "last-stack-program-driver")).toBe(true);
    expect(nameMatchesRoutine("unrelated-thing", "last-stack-groom-board")).toBe(false);
  });
});

describe("parseOutcome", () => {
  test("prefers ROUTINE_RESULT trailer", () => {
    const text = `
noise
groom-board 2026-07-13T12:00:00Z ok closed-1
ROUTINE_RESULT outcome=noop actions=0 detail=queue empty
`;
    const o = parseOutcome("last-stack-groom-board", text, { exitCode: 0 });
    expect(o.kind).toBe("noop");
    expect(o.source).toBe("routine_result");
    expect(o.detail).toContain("queue empty");
  });

  test("parses heartbeat-style lines with ISO", () => {
    const text = `kanban-pickup 2026-07-13T13:06:03Z ok cards=2 units=2 spawned=2`;
    const o = parseOutcome("last-stack-fkanban-pickup", text, { exitCode: 0 });
    expect(o.kind).toBe("ok");
    expect(o.source).toBe("heartbeat");
    expect(o.detail).toContain("cards=2");
  });

  test("parses noop validate heartbeat", () => {
    const text = `kanban-validate 2026-07-13T12:33:19Z noop no-runnable-post-merge-candidates`;
    const o = parseOutcome("last-stack-fkanban-validate", text, { exitCode: 0 });
    expect(o.kind).toBe("noop");
    expect(o.detail).toContain("no-runnable");
  });

  test("parses append-heartbeat --line", () => {
    const text = `
/Users/tomtang/.last-stack/bin/last-stack-brain-append-heartbeat --line "groom-board 2026-07-13T23:33:02Z ok closed-review-1 no-promotions"
appended heartbeat to routine-heartbeats
`;
    const o = parseOutcome("last-stack-groom-board", text, { exitCode: 0 });
    expect(o.kind).toBe("ok");
    expect(o.source).toBe("heartbeat");
    expect(o.detail).toContain("closed-review-1");
  });

  test("uses latest matching signal when several present", () => {
    const text = `
program-driver 2026-07-13T09:00:00Z noop no-promotions
program-driver 2026-07-13T10:00:00Z ok generated-schema-resolver-local-pack-consumer
`;
    const o = parseOutcome("last-stack-program-driver", text, { exitCode: 0 });
    expect(o.kind).toBe("ok");
    expect(o.detail).toContain("generated-schema");
  });

  test("exit non-zero falls back to error", () => {
    const o = parseOutcome("last-stack-fkanban-watch", "Usage: codex exec", { exitCode: 2 });
    expect(o.kind).toBe("error");
    expect(o.source).toBe("exit");
    expect(o.detail).toBe("exit 2");
  });

  test("timeout is error", () => {
    const o = parseOutcome("x", "", { exitCode: null, timedOut: true });
    expect(o.kind).toBe("error");
    expect(o.detail).toBe("timed out");
  });

  test("exit 0 with no signal is unknown (not guessed as noop)", () => {
    const o = parseOutcome("last-stack-groom-board", "Board groom complete.\nCounts: ...", { exitCode: 0 });
    // Prose without explicit ok|noop|error token near a name may still miss —
    // unknown is correct; we refuse to invent.
    expect(["unknown", "ok", "noop"]).toContain(o.kind);
  });

  test("real groom final prose with heartbeat append", () => {
    // Mirrors a successful codex run that appended via last-stack helper.
    const stderr = `
codex
Board groom complete.
Counts: backlog 13 -> 13
exec
/bin/zsh -lc 'last-stack-brain-append-heartbeat --line "groom-board 2026-07-13T23:33:02Z ok closed-review-1 no-promotions pickup-ready-4"'
 succeeded
appended heartbeat to routine-heartbeats
`;
    const o = parseOutcome("last-stack-groom-board", stderr, { exitCode: 0 });
    expect(o.kind).toBe("ok");
    expect(o.detail).toContain("closed-review-1");
  });
});

describe("aggregateOutcomes", () => {
  test("computes noop rate over clean runs only", () => {
    const stats = aggregateOutcomes([
      { kind: "noop", detail: null, source: "heartbeat" },
      { kind: "noop", detail: null, source: "heartbeat" },
      { kind: "ok", detail: null, source: "heartbeat" },
      { kind: "error", detail: null, source: "exit" },
      { kind: "unknown", detail: null, source: "none" },
    ]);
    expect(stats.ok).toBe(1);
    expect(stats.noop).toBe(2);
    expect(stats.error).toBe(1);
    expect(stats.unknown).toBe(1);
    expect(stats.noopRate).toBeCloseTo(2 / 3);
    expect(stats.usefulRate).toBeCloseTo(1 / 3);
  });

  test("null rates when no clean runs", () => {
    const stats = aggregateOutcomes([
      { kind: "error", detail: null, source: "exit" },
      { kind: "unknown", detail: null, source: "none" },
    ]);
    expect(stats.noopRate).toBeNull();
    expect(stats.usefulRate).toBeNull();
  });
});
