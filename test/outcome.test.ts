import { describe, expect, test } from "bun:test";

import {
  aggregateOutcomes,
  nameMatchesRoutine,
  parseOutcome,
} from "../src/outcome.ts";

describe("nameMatchesRoutine", () => {
  test("matches registry id and historical aliases", () => {
    expect(nameMatchesRoutine("last-stack-kanban-pickup", "last-stack-kanban-pickup")).toBe(true);
    expect(nameMatchesRoutine("last-stack-fkanban-pickup", "last-stack-kanban-pickup")).toBe(true);
    expect(nameMatchesRoutine("kanban-pickup", "last-stack-kanban-pickup")).toBe(true);
    expect(nameMatchesRoutine("fkanban-pickup", "last-stack-kanban-pickup")).toBe(true);
    expect(nameMatchesRoutine("kanban-pickup", "last-stack-fkanban-pickup")).toBe(true);
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
    const o = parseOutcome("last-stack-kanban-pickup", text, { exitCode: 0 });
    expect(o.kind).toBe("ok");
    expect(o.source).toBe("heartbeat");
    expect(o.detail).toContain("cards=2");
  });

  test("parses noop validate heartbeat", () => {
    const text = `kanban-validate 2026-07-13T12:33:19Z noop no-runnable-post-merge-candidates`;
    const o = parseOutcome("last-stack-kanban-validate", text, { exitCode: 0 });
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

  test("ignores other routines' error heartbeats quoted in a successful retro", () => {
    // daily-retro transcripts paste incident bodies that quote:
    //   canonicalize-daily 2026-07-13T17:14:57Z error also erroring...
    // That must not classify THIS run as error when exit 0 and no own heartbeat.
    const text = `
tool output: canonicalize-daily 2026-07-13T17:14:57Z error also erroring in the same window
kanban-pickup 2026-07-13T17:06:29Z ok cards=1
{"type":"result","subtype":"success","is_error":false,"result":"Retro complete. 5 bites addressed."}
`;
    const o = parseOutcome("daily-retro-prevention", text, { exitCode: 0 });
    expect(o.kind).toBe("ok");
    expect(o.detail).toMatch(/Retro complete|stream-json success/i);
  });

  test("prefers this routine's heartbeat over foreign ok lines", () => {
    const text = `
kanban-pickup 2026-07-13T13:06:03Z ok cards=2
daily-retro-prevention 2026-07-14T13:33:00Z ok bites=5 cards=2
`;
    const o = parseOutcome("daily-retro-prevention", text, { exitCode: 0 });
    expect(o.kind).toBe("ok");
    expect(o.detail).toContain("bites=5");
  });

  test("exit non-zero falls back to error", () => {
    const o = parseOutcome("last-stack-kanban-watch", "Usage: codex exec", { exitCode: 2 });
    expect(o.kind).toBe("error");
    expect(o.source).toBe("exit");
    expect(o.detail).toBe("exit 2");
  });

  test("timeout is error", () => {
    const o = parseOutcome("x", "", { exitCode: null, timedOut: true });
    expect(o.kind).toBe("error");
    expect(o.detail).toBe("timed out");
  });

  test("does not parse Rust test result output as a routine RESULT trailer", () => {
    const text =
      "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 353.65s";
    const clean = parseOutcome("db-perf-guard", text, { exitCode: 0 });
    expect(clean.kind).toBe("unknown");

    const timedOut = parseOutcome("db-perf-guard", text, { exitCode: 124, timedOut: true });
    expect(timedOut.kind).toBe("error");
    expect(timedOut.source).toBe("exit");
    expect(timedOut.detail).toBe("timed out");
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

  test("classifies stale-agent cleanup blocked enumeration as safe noop", () => {
    const text = `
Cleanup pass completed.

Terminated PIDs/processes: none.

Skipped: all possible Codex agents, because process enumeration was blocked by sandbox/system policy. \`ps\` returned \`operation not permitted\`; \`pgrep -afil codex\` returned \`Cannot get process list\` / \`sysmond service not found\`.
`;
    const o = parseOutcome("codex-stale-agent-memory-cleanup", text, { exitCode: 0 });
    expect(o.kind).toBe("noop");
    expect(o.source).toBe("safe_skip");
    expect(o.detail).toBe("process-enumeration-blocked terminated=0");
  });

  test("does not mask failed stale-agent cleanup exits as safe noop", () => {
    const text = `
Cleanup pass completed.
Terminated PIDs/processes: none.
Process enumeration was blocked by sandbox/system policy.
`;
    const o = parseOutcome("codex-stale-agent-memory-cleanup", text, { exitCode: 2 });
    expect(o.kind).toBe("error");
    expect(o.source).toBe("exit");
    expect(o.detail).toBe("exit 2");
  });

  test("classifies disk reclaim with concrete reclaimed space as useful work despite noop noise", () => {
    const text = `
ROUTINE_RESULT outcome=noop detail=board-read-unavailable
Disk reclaim completed. Reclaimed about 23 GiB total and raised \`/System/Volumes/Data\` from 9.7 GiB free to 32 GiB free.

Pruned 12 clean, zero-unique, \`done\` F-Kanban worktrees and deleted their local branches.
`;
    const o = parseOutcome("last-stack-disk-reclaim", text, { exitCode: 0 });
    expect(o.kind).toBe("ok");
    expect(o.source).toBe("useful_work");
    expect(o.detail).toContain("reclaimed=23GiB");
    expect(o.detail).toContain("prior-noop=");
    expect(o.detail).toContain("board-read-unavailable");
  });

  test("leaves zero-reclaim disk runs as noop when the explicit signal says noop", () => {
    const text = `
ROUTINE_RESULT outcome=noop detail=free-space-ok
Disk reclaim completed. Reclaimed 0 GiB. No worktrees were removed.
`;
    const o = parseOutcome("last-stack-disk-reclaim", text, { exitCode: 0 });
    expect(o.kind).toBe("noop");
    expect(o.source).toBe("routine_result");
    expect(o.detail).toContain("free-space-ok");
  });

  test("does not use historical memory reclaim evidence after the current disk summary", () => {
    const text = `
ROUTINE_RESULT outcome=noop detail=free-space-ok
Disk reclaim completed. Reclaimed 0 GiB. No worktrees were removed.

Prior memory:
- Yesterday: Disk reclaim completed. Reclaimed about 23 GiB total and pruned 12 worktrees.
`;
    const o = parseOutcome("last-stack-disk-reclaim", text, { exitCode: 0 });
    expect(o.kind).toBe("noop");
    expect(o.source).toBe("routine_result");
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
