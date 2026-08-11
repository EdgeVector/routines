import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  allowanceForHarness,
  loadCapacityPolicy,
  planIdleLadder,
  type IdleLadderDecision,
  type IdleLadderState,
} from "./capacity.ts";
import { routinesHome, stateDir } from "./paths.ts";
import { HARNESSES } from "./registry.ts";

export interface CapacityControllerResult {
  ready: number | null;
  decision: IdleLadderDecision | null;
  fired: string | null;
  dryRun: boolean;
  allowances: ReturnType<typeof allowanceForHarness>[];
}

function controllerStatePath(): string {
  return join(stateDir(), "capacity-controller-state.json");
}

function readControllerState(): IdleLadderState {
  const path = controllerStatePath();
  if (!existsSync(path)) return { dryTicks: 0, lastRunByRung: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as IdleLadderState;
    return {
      dryTicks: Number.isFinite(parsed.dryTicks) ? parsed.dryTicks : 0,
      lastRunByRung: parsed.lastRunByRung ?? {},
    };
  } catch {
    return { dryTicks: 0, lastRunByRung: {} };
  }
}

function readReadyCount(): number | null {
  const bin = process.env.ROUTINES_KANBAN_BIN ?? "kanban";
  try {
    const raw = execFileSync(bin, ["pickup", "status", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(raw) as { ready?: unknown; pickup_ready?: unknown };
    const ready = Number(parsed.ready ?? parsed.pickup_ready);
    return Number.isFinite(ready) && ready >= 0 ? ready : null;
  } catch {
    return null;
  }
}

function appendDecision(result: CapacityControllerResult): void {
  const dir = join(routinesHome(), "logs");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "capacity-controller.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), ...result }) + "\n",
  );
}

/** One bounded controller tick. It performs one board read and fires at most
 * one ladder routine. The daemon admission path independently consumes the
 * same policy file for tier shedding. */
export function runCapacityControllerTick(opts: {
  dryRun?: boolean;
  now?: Date;
  runRoutine?: (id: string) => void;
} = {}): CapacityControllerResult {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const policy = loadCapacityPolicy();
  if (!policy.enabled) throw new Error("capacity controller policy is disabled");
  const allowances = HARNESSES.map((harness) =>
    allowanceForHarness(harness, policy.harnesses[harness], now, policy.staleAfterSeconds),
  );
  const ready = readReadyCount();
  if (!policy.idleLadder) {
    const result = { ready, decision: null, fired: null, dryRun, allowances };
    appendDecision(result);
    return result;
  }
  const state = readControllerState();
  const canGenerate = allowances.some((allowance) => allowance.state === "fresh" && allowance.fireSlots > 0);
  const decision = planIdleLadder(
    ready,
    state,
    policy.idleLadder,
    Math.floor(now.getTime() / 1000),
    canGenerate,
  );
  let fired: string | null = null;
  if (decision.action === "fire" && decision.routineId) {
    fired = decision.routineId;
    if (!dryRun) opts.runRoutine?.(decision.routineId);
  }
  // Failed board reads return the identical state; dry-run never mutates it.
  if (!dryRun) {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(controllerStatePath(), JSON.stringify(decision.nextState, null, 2) + "\n");
  }
  const result = { ready, decision, fired, dryRun, allowances };
  appendDecision(result);
  return result;
}
