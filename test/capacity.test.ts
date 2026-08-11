import { describe, expect, test } from "bun:test";

import {
  allowanceForHarness,
  planCapacity,
  planIdleLadder,
  type CapacityPolicy,
  type IdleLadderConfig,
} from "../src/capacity.ts";
import { parseEntry } from "../src/registry.ts";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function entry(id: string, tier?: "spine" | "worker" | "opportunistic") {
  return parseEntry(
    [
      'harness = "codex"',
      'model = "gpt-5.6"',
      'rrule = "FREQ=HOURLY"',
      'prompt = "test"',
      ...(tier ? [`tier = "${tier}"`] : []),
    ].join("\n"),
    `/registry/${id}.toml`,
  );
}

function policy(overrides: Partial<CapacityPolicy> = {}): CapacityPolicy {
  return {
    enabled: true,
    staleAfterSeconds: 3_600,
    unsetTier: "shed",
    harnesses: {
      codex: {
        usedPercent: 80,
        resetAt: "2026-08-11T22:00:00.000Z",
        observedAt: "2026-08-11T11:55:00.000Z",
        percentPerFire: 1,
      },
    },
    ...overrides,
  };
}

describe("capacity allowance", () => {
  test("computes remaining percentage per hour without a hardcoded reset", () => {
    const allowance = allowanceForHarness("codex", policy().harnesses.codex, NOW, 3_600);
    expect(allowance.state).toBe("fresh");
    expect(allowance.remainingPercent).toBe(20);
    expect(allowance.hoursUntilReset).toBe(10);
    expect(allowance.percentPerHour).toBe(2);
    expect(allowance.fireSlots).toBe(2);
  });

  test("fails closed for stale, missing, malformed, and expired quota", () => {
    expect(allowanceForHarness("codex", undefined, NOW, 3_600).state).toBe("missing");
    expect(
      allowanceForHarness(
        "codex",
        { ...policy().harnesses.codex!, observedAt: "2026-08-11T10:00:00.000Z" },
        NOW,
        3_600,
      ).state,
    ).toBe("stale");
    expect(
      allowanceForHarness(
        "codex",
        { ...policy().harnesses.codex!, usedPercent: 101 },
        NOW,
        3_600,
      ).state,
    ).toBe("invalid");
    expect(
      allowanceForHarness(
        "codex",
        { ...policy().harnesses.codex!, resetAt: "2026-08-11T11:00:00.000Z" },
        NOW,
        3_600,
      ).state,
    ).toBe("expired");
  });
});

describe("capacity admission", () => {
  test("never sheds spine and sheds opportunistic before worker", () => {
    const due = [
      entry("opportunistic", "opportunistic"),
      entry("worker-a", "worker"),
      entry("spine", "spine"),
      entry("worker-b", "worker"),
    ].map((e) => ({ entry: e, occ: NOW }));
    const decisions = planCapacity(due, policy(), NOW).decisions;
    expect(decisions.filter((d) => d.admitted).map((d) => d.entry.id)).toEqual([
      "spine",
      "worker-a",
    ]);
    expect(decisions.map((d) => d.entry.id)).toEqual([
      "spine",
      "worker-a",
      "worker-b",
      "opportunistic",
    ]);
    expect(decisions.find((d) => d.entry.id === "opportunistic")?.reason).toBe(
      "hourly allowance exhausted",
    );
  });

  test("charges a frequent routine by fires per hour instead of resetting slots each pass", () => {
    const fast = parseEntry(
      [
        'harness = "codex"',
        'model = "gpt-5.6"',
        'rrule = "FREQ=MINUTELY;INTERVAL=5"',
        'prompt = "test"',
        'tier = "worker"',
      ].join("\n"),
      "/registry/fast.toml",
    );
    const decisions = planCapacity(
      [{ entry: fast, occ: NOW }],
      policy({
        harnesses: {
          codex: {
            ...policy().harnesses.codex!,
            percentPerFire: 0.2,
          },
        },
      }),
      NOW,
    ).decisions;
    // 12 fires/hour * 0.2% = 2.4%/h, above the 2%/h allowance.
    expect(decisions[0]).toMatchObject({ admitted: false, reason: "hourly allowance exhausted" });
  });

  test("makes unset behavior explicit and protects spine when quota is unavailable", () => {
    const due = [entry("legacy"), entry("worker", "worker"), entry("spine", "spine")].map(
      (e) => ({ entry: e, occ: NOW }),
    );
    const decisions = planCapacity(due, policy({ harnesses: {} }), NOW).decisions;
    expect(decisions.find((d) => d.entry.id === "spine")?.admitted).toBe(true);
    expect(decisions.find((d) => d.entry.id === "worker")?.reason).toBe(
      "fail-closed missing quota",
    );
    expect(decisions.find((d) => d.entry.id === "legacy")?.reason).toBe("unset tier policy=shed");
  });
});

describe("ready-count idle ladder", () => {
  const config: IdleLadderConfig = {
    readyFloor: 0,
    dryTicksNeeded: 2,
    rungs: [
      { name: "unblock", cooldownSeconds: 100, routineIds: ["unblock"] },
      { name: "promote", cooldownSeconds: 200, routineIds: ["promote"] },
      { name: "derive", cooldownSeconds: 300, routineIds: ["derive"] },
      { name: "entropy", cooldownSeconds: 400, routineIds: ["entropy"] },
    ],
  };

  test("uses ready=0 hysteresis, then starts at unblock before entropy", () => {
    const first = planIdleLadder(0, { dryTicks: 0, lastRunByRung: {} }, config, 1_000, true);
    expect(first.action).toBe("wait");
    const second = planIdleLadder(0, first.nextState, config, 1_001, true);
    expect(second).toMatchObject({ action: "fire", rung: "unblock", routineId: "unblock" });
  });

  test("honors cooldowns and advances one rung", () => {
    const decision = planIdleLadder(
      0,
      { dryTicks: 2, lastRunByRung: { unblock: 950 } },
      config,
      1_000,
      true,
    );
    expect(decision).toMatchObject({ action: "fire", rung: "promote", routineId: "promote" });
  });

  test("leaves state untouched on failed board reads and holds when capacity is blind", () => {
    const state = { dryTicks: 1, lastRunByRung: { unblock: 5 } };
    expect(planIdleLadder(null, state, config, 1_000, true)).toMatchObject({
      action: "hold",
      nextState: state,
    });
    expect(planIdleLadder(0, state, config, 1_000, false)).toMatchObject({
      action: "hold",
      reason: "capacity fail-closed",
    });
  });
});
