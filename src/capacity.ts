import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { routinesHome } from "./paths.ts";
import type { Harness, RoutineEntry, RoutineTier } from "./registry.ts";
import { nextAfter } from "./rrule.ts";

export interface HarnessCapacitySnapshot {
  usedPercent: number;
  resetAt: string;
  observedAt: string;
  /** Measured average cost of one fire on this harness. */
  percentPerFire: number;
}

export interface IdleLadderConfig {
  readyFloor: number;
  dryTicksNeeded: number;
  rungs: Array<{ name: string; cooldownSeconds: number; routineIds: string[] }>;
}

export interface CapacityPolicy {
  enabled: boolean;
  staleAfterSeconds: number;
  /** Explicit legacy behavior; never infer a tier from the routine id. */
  unsetTier: RoutineTier | "shed";
  harnesses: Partial<Record<Harness, HarnessCapacitySnapshot>>;
  idleLadder?: IdleLadderConfig;
}

export interface HarnessAllowance {
  harness: Harness;
  state: "fresh" | "missing" | "stale" | "invalid" | "expired";
  remainingPercent: number;
  hoursUntilReset: number;
  percentPerHour: number;
  fireSlots: number;
  detail: string;
}

export interface CapacityDecision {
  entry: RoutineEntry;
  admitted: boolean;
  tier: RoutineTier | "unset";
  reason: string;
}

export interface CapacityPlan {
  decisions: CapacityDecision[];
  allowances: HarnessAllowance[];
}

const DEFAULT_POLICY: CapacityPolicy = {
  enabled: false,
  staleAfterSeconds: 14_400,
  unsetTier: "shed",
  harnesses: {},
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function allowanceForHarness(
  harness: Harness,
  snapshot: HarnessCapacitySnapshot | undefined,
  now: Date,
  staleAfterSeconds: number,
): HarnessAllowance {
  const closed = (state: HarnessAllowance["state"], detail: string): HarnessAllowance => ({
    harness,
    state,
    remainingPercent: 0,
    hoursUntilReset: 0,
    percentPerHour: 0,
    fireSlots: 0,
    detail,
  });
  if (!snapshot) return closed("missing", "quota snapshot missing");
  if (
    !finiteNumber(snapshot.usedPercent) ||
    !finiteNumber(snapshot.percentPerFire) ||
    snapshot.usedPercent < 0 ||
    snapshot.usedPercent > 100 ||
    snapshot.percentPerFire <= 0
  ) {
    return closed("invalid", "quota snapshot has invalid percentages");
  }
  const observedMs = Date.parse(snapshot.observedAt);
  const resetMs = Date.parse(snapshot.resetAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(resetMs)) {
    return closed("invalid", "quota snapshot has invalid timestamps");
  }
  const ageSeconds = (now.getTime() - observedMs) / 1000;
  if (ageSeconds < -60 || ageSeconds > staleAfterSeconds) {
    return closed("stale", `quota snapshot age=${Math.round(ageSeconds)}s`);
  }
  const hoursUntilReset = (resetMs - now.getTime()) / 3_600_000;
  if (hoursUntilReset <= 0) return closed("expired", "quota reset is not in the future");
  const remainingPercent = Math.max(0, 100 - snapshot.usedPercent);
  const percentPerHour = remainingPercent / hoursUntilReset;
  return {
    harness,
    state: "fresh",
    remainingPercent,
    hoursUntilReset,
    percentPerHour,
    fireSlots: Math.max(0, Math.floor(percentPerHour / snapshot.percentPerFire)),
    detail: `allowance=${percentPerHour.toFixed(3)}%/h cost=${snapshot.percentPerFire.toFixed(3)}%/fire`,
  };
}

function effectiveTier(entry: RoutineEntry, unsetTier: CapacityPolicy["unsetTier"]): RoutineTier | "shed" {
  return entry.tier ?? unsetTier;
}

const TIER_ORDER: Record<RoutineTier | "shed", number> = {
  spine: 0,
  worker: 1,
  opportunistic: 2,
  shed: 3,
};

/** Rank and admit due fires. Spine is unconditional; non-spine consumes the
 * fresh per-harness hourly fire budget, with opportunistic work shed first. */
export function planCapacity(
  due: Array<{ entry: RoutineEntry; occ: Date }>,
  policy: CapacityPolicy,
  now: Date,
): CapacityPlan {
  if (!policy.enabled) {
    return {
      allowances: [],
      decisions: due.map(({ entry }) => ({
        entry,
        admitted: true,
        tier: entry.tier ?? "unset",
        reason: "capacity controller disabled",
      })),
    };
  }

  const harnesses = [...new Set(due.map(({ entry }) => entry.harness))];
  const allowances = harnesses.map((harness) =>
    allowanceForHarness(harness, policy.harnesses[harness], now, policy.staleAfterSeconds),
  );
  const allowanceByHarness = new Map(allowances.map((allowance) => [allowance.harness, allowance]));
  const remainingPercentPerHour = new Map(
    allowances.map((allowance) => [allowance.harness, allowance.percentPerHour]),
  );
  const ranked = [...due].sort((a, b) => {
    const ta = TIER_ORDER[effectiveTier(a.entry, policy.unsetTier)];
    const tb = TIER_ORDER[effectiveTier(b.entry, policy.unsetTier)];
    if (ta !== tb) return ta - tb;
    if (a.occ.getTime() !== b.occ.getTime()) return a.occ.getTime() - b.occ.getTime();
    return a.entry.id.localeCompare(b.entry.id);
  });

  const decisions = ranked.map(({ entry }): CapacityDecision => {
    const tier = effectiveTier(entry, policy.unsetTier);
    const reportedTier = entry.tier ?? "unset";
    const snapshot = policy.harnesses[entry.harness];
    const next = nextAfter(entry.parsedRrule, now);
    const cadenceHours = next
      ? Math.max((next.getTime() - now.getTime()) / 3_600_000, 1 / 3_600)
      : 1;
    const burnPerHour = snapshot ? snapshot.percentPerFire / cadenceHours : 0;
    if (tier === "spine") {
      const remaining = remainingPercentPerHour.get(entry.harness) ?? 0;
      remainingPercentPerHour.set(entry.harness, remaining - burnPerHour);
      return {
        entry,
        admitted: true,
        tier: reportedTier,
        reason: `spine is never shed burn=${burnPerHour.toFixed(3)}%/h`,
      };
    }
    if (tier === "shed") {
      return { entry, admitted: false, tier: reportedTier, reason: "unset tier policy=shed" };
    }
    const allowance = allowanceByHarness.get(entry.harness);
    if (!allowance || allowance.state !== "fresh") {
      return {
        entry,
        admitted: false,
        tier: reportedTier,
        reason: `fail-closed ${allowance?.state ?? "missing"} quota`,
      };
    }
    const remaining = remainingPercentPerHour.get(entry.harness) ?? 0;
    if (burnPerHour > remaining + Number.EPSILON) {
      return { entry, admitted: false, tier: reportedTier, reason: "hourly allowance exhausted" };
    }
    remainingPercentPerHour.set(entry.harness, remaining - burnPerHour);
    return {
      entry,
      admitted: true,
      tier: reportedTier,
      reason: `${allowance.detail} burn=${burnPerHour.toFixed(3)}%/h`,
    };
  });
  return { decisions, allowances };
}

export interface IdleLadderState {
  dryTicks: number;
  lastRunByRung: Record<string, number | undefined>;
}

export interface IdleLadderDecision {
  action: "reset" | "wait" | "fire" | "hold" | "exhausted";
  nextState: IdleLadderState;
  rung?: string;
  routineId?: string;
  reason: string;
}

/** Pure ready-count ladder. null means an unreadable board and never advances
 * hysteresis; callers execute at most the returned single routine. */
export function planIdleLadder(
  ready: number | null,
  state: IdleLadderState,
  config: IdleLadderConfig,
  nowEpochSeconds: number,
  canGenerate: boolean,
): IdleLadderDecision {
  if (ready == null || !Number.isFinite(ready)) {
    return { action: "hold", nextState: state, reason: "board unreadable; state untouched" };
  }
  if (ready > config.readyFloor) {
    return {
      action: "reset",
      nextState: { dryTicks: 0, lastRunByRung: state.lastRunByRung },
      reason: `ready=${ready} above floor=${config.readyFloor}`,
    };
  }
  const dryTicks = state.dryTicks + 1;
  const nextState = { dryTicks, lastRunByRung: { ...state.lastRunByRung } };
  if (dryTicks < config.dryTicksNeeded) {
    return { action: "wait", nextState, reason: `hysteresis ${dryTicks}/${config.dryTicksNeeded}` };
  }
  if (!canGenerate) {
    return { action: "hold", nextState, reason: "capacity fail-closed" };
  }
  for (const rung of config.rungs) {
    const last = state.lastRunByRung[rung.name] ?? 0;
    if (nowEpochSeconds - last < rung.cooldownSeconds) continue;
    const routineId = rung.routineIds[0];
    if (!routineId) continue;
    nextState.lastRunByRung[rung.name] = nowEpochSeconds;
    return {
      action: "fire",
      nextState,
      rung: rung.name,
      routineId,
      reason: `ready=${ready} cooldown=${rung.cooldownSeconds}s`,
    };
  }
  return { action: "exhausted", nextState, reason: "all rungs cooling down" };
}

function capacityPolicyPath(): string {
  return process.env.ROUTINES_CAPACITY_POLICY ?? join(routinesHome(), "capacity-controller.json");
}

export function loadCapacityPolicy(path = capacityPolicyPath()): CapacityPolicy {
  if (!existsSync(path)) return DEFAULT_POLICY;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as CapacityPolicy;
  if (typeof parsed.enabled !== "boolean") throw new Error(`${path}: enabled must be boolean`);
  if (!finiteNumber(parsed.staleAfterSeconds) || parsed.staleAfterSeconds <= 0) {
    throw new Error(`${path}: staleAfterSeconds must be positive`);
  }
  if (!["spine", "worker", "opportunistic", "shed"].includes(parsed.unsetTier)) {
    throw new Error(`${path}: unsetTier must be spine|worker|opportunistic|shed`);
  }
  parsed.harnesses ??= {};
  return parsed;
}
