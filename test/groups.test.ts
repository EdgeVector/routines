import { describe, expect, test } from "bun:test";

import {
  compareGrouped,
  groupForId,
  GROUPS,
  isGroupId,
} from "../src/groups.ts";
import { parseEntry } from "../src/registry.ts";

describe("groupForId", () => {
  test("maps the live fleet into expected groups", () => {
    const cases: Array<[string, string]> = [
      ["last-stack-fkanban-pickup", "board"],
      ["last-stack-fkanban-watch", "board"],
      ["last-stack-fkanban-validate", "board"],
      ["last-stack-groom-board", "board"],
      ["last-stack-program-driver", "board"],
      ["last-stack-drain-open-prs", "board"],

      ["last-stack-consolidate-brain", "brain"],
      ["capture-knowledge-to-brain", "brain"],
      ["last-stack-morning-sync", "brain"],
      ["last-stack-papercut-sweep", "brain"],
      ["last-stack-self-improvement-loop", "brain"],
      ["owner-review-rotate", "brain"],
      ["daily-retro-prevention", "brain"],
      ["canonicalize-daily", "brain"],

      ["dogfood-rotate", "dogfood"],
      ["dogfood-kanban", "dogfood"],
      ["dogfood-onboarding", "dogfood"],
      ["lastdb-local-smoke-test", "dogfood"],

      ["last-stack-disk-reclaim", "hygiene"],
      ["last-stack-worktree-cleanup", "hygiene"],
      ["weekly-token-hygiene", "hygiene"],
      ["codex-stale-agent-memory-cleanup", "hygiene"],
      ["teardown-rotate", "hygiene"],

      ["db-perf-guard", "quality"],
      ["brain-stress-consistency", "quality"],
      ["sentry-triage", "quality"],
      ["lastdbd-mini-telemetry-dashboard-refresh", "quality"],

      ["coderings-capstone-exerciser", "product"],
      ["coderings-weekly-fold", "product"],

      ["smoke-claude", "smoke"],
      ["smoke-codex", "smoke"],
      ["smoke-grok", "smoke"],
    ];
    for (const [id, want] of cases) {
      expect(groupForId(id).id).toBe(want);
    }
  });

  test("pattern rules catch new ids in known families", () => {
    expect(groupForId("last-stack-fkanban-retry").id).toBe("board");
    expect(groupForId("dogfood-new-thing").id).toBe("dogfood");
    expect(groupForId("smoke-cursor").id).toBe("smoke");
    expect(groupForId("coderings-monthly-scan").id).toBe("product");
  });

  test("unknown ids fall into other", () => {
    expect(groupForId("totally-novel-routine").id).toBe("other");
  });

  test("registry override wins over heuristic", () => {
    expect(groupForId("smoke-claude", "board").id).toBe("board");
    expect(groupForId("smoke-claude", "nope").id).toBe("smoke"); // invalid → heuristic
  });

  test("catalog ids are unique and cover isGroupId", () => {
    const ids = GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isGroupId(id)).toBe(true);
    expect(isGroupId("nope")).toBe(false);
  });
});

describe("compareGrouped", () => {
  test("orders by group then id", () => {
    const rows = [
      { id: "z-other", groupId: "other" },
      { id: "b-board", groupId: "board" },
      { id: "a-board", groupId: "board" },
      { id: "m-smoke", groupId: "smoke" },
    ];
    rows.sort(compareGrouped);
    expect(rows.map((r) => r.id)).toEqual(["a-board", "b-board", "m-smoke", "z-other"]);
  });
});

describe("registry group key", () => {
  const base = [
    'harness = "claude"',
    'model = "sonnet"',
    'rrule = "FREQ=DAILY"',
    'prompt = "hi"',
  ].join("\n");

  test("accepts a known group", () => {
    const e = parseEntry(base + '\ngroup = "hygiene"', "/x/disk.toml");
    expect(e.group).toBe("hygiene");
  });

  test("rejects an unknown group", () => {
    expect(() => parseEntry(base + '\ngroup = "widgets"', "/x/disk.toml")).toThrow(/invalid group/);
  });
});
