// The one route engine.
//
// Routines owns provider policy for the whole fleet. Two callers need the same
// decision:
//
//   - the scheduler dispatch pass (daemon.routeForAvailability), and
//   - external agent hosts (Loom) via the public `routines agent-exec` command.
//
// Both call `routeAgent` here, so there is exactly one implementation of the
// matrix lookup and the provider-fence check. A second copy is how the fleet
// ends up dispatching one provider while an external caller believes another
// is live.
//
// Fence source: **active harness-outage Situations only**. An ordinary agent
// error must not prevent process creation, so the local outage-state files
// (which classify agent errors) are read for retry timing only — never to add
// a fence. See design `design-loom-use-routines-global-agent-route`.

import {
  DifficultyMatrixError,
  loadDifficultyMatrix,
  resolveDifficulty,
  type Difficulty,
} from "./difficulty-matrix.ts";
import { outageSituationSlug, readOutageState } from "./harness-outage.ts";
import { isHarness, type Harness } from "./registry.ts";
import { loadActiveSituations, type ActiveSituation } from "./situations.ts";

/** What the caller intends to do with the agent it is about to start. */
export type RouteMode = "read" | "write";

export const ROUTE_MODES = ["read", "write"] as const satisfies readonly RouteMode[];

export function isRouteMode(value: string): value is RouteMode {
  return (ROUTE_MODES as readonly string[]).includes(value);
}

/**
 * What to do when every candidate provider is fenced.
 *
 * - `empty` (default, and what an external caller wants): return no route so
 *   the caller parks the node instead of starting a provider that is down.
 * - `primary`: keep the configured primary. The scheduler uses this because
 *   the runner's own recovery chain probes for a provider that has recovered.
 */
export type AllFencedPolicy = "empty" | "primary";

export interface RouteRequest {
  difficulty: Difficulty;
  mode: RouteMode;
  /**
   * Durable provider pin. A pin is not a preference: when the pinned provider
   * is fenced the route is empty, because falling off a durable pin would put
   * the caller on a provider it deliberately excluded.
   */
  pin?: Harness;
  /** Caller's wall-clock budget in ms. Carried through; not enforced here. */
  timeoutMs?: number;
  /** Stable caller id, echoed back so an attempt log can join on it. */
  requestId?: string;
  /** Pre-loaded active Situations (the scheduler already has them). */
  situations?: ActiveSituation[];
  /** Default `empty`. */
  allFenced?: AllFencedPolicy;
  nowMs?: number;
}

export interface FencedProvider {
  harness: Harness;
  /** The active Situation slug that fences it. */
  situation: string;
  /** When the provider is expected back (ISO), when local state knows. */
  retryAt: string | null;
}

export interface RouteRetryState {
  /** True when the empty route is expected to clear on its own. */
  retryable: boolean;
  /** Earliest known ISO time a fenced provider returns. null = unknown. */
  retryAt: string | null;
  /** Active fence Situation slugs, for the caller's block record. */
  situations: string[];
}

export interface RouteDecision {
  requestId: string | null;
  difficulty: Difficulty;
  mode: RouteMode;
  timeoutMs: number | null;
  matrixVersion: number;
  /** Configured preference order, for the caller's evidence. */
  providerOrder: Harness[];
  harness: Harness | null;
  model: string | null;
  /** True when no provider may start. `harness`/`model` are null. */
  empty: boolean;
  /** True when the decision honored a durable pin. */
  pinned: boolean;
  /** True when the selection is not the first provider in the order. */
  fallback: boolean;
  /**
   * True when the caller must prove an unchanged guard token before it starts
   * this route: a write that landed on a fallback provider mid-flight.
   */
  guardRequired: boolean;
  /** Machine-readable reason tokens, in decision order. */
  reasons: string[];
  fenced: FencedProvider[];
  retry: RouteRetryState;
  /** False when the Situations check itself failed (routing failed open). */
  situationsOk: boolean;
}

/** The provider a `harness-outage-<harness>` Situation slug fences. */
export function harnessFromOutageSituation(slug: string): string | null {
  const m = slug.match(/^harness-outage-(.+)$/);
  return m?.[1] ?? null;
}

/** The providers fenced by the active harness-outage Situations. */
export function fencedHarnesses(situations: ActiveSituation[]): Set<Harness> {
  const fenced = new Set<Harness>();
  for (const situation of situations) {
    const harness = harnessFromOutageSituation(situation.slug);
    if (harness && isHarness(harness)) fenced.add(harness);
  }
  return fenced;
}

function retryAtFor(harness: Harness, nowMs: number): string | null {
  const state = readOutageState(harness);
  const expiresAt = state?.expiresAt;
  if (!expiresAt) return null;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed) || parsed <= nowMs) return null;
  return expiresAt;
}

/**
 * Resolve one route request against the global matrix and the active provider
 * fences. Pure with respect to the caller: it starts no process.
 */
export function routeAgent(request: RouteRequest): RouteDecision {
  const nowMs = request.nowMs ?? Date.now();
  const allFenced: AllFencedPolicy = request.allFenced ?? "empty";
  const reasons: string[] = [];

  let situations: ActiveSituation[];
  let situationsOk = true;
  if (request.situations) {
    situations = request.situations;
  } else {
    const check = loadActiveSituations();
    situations = check.situations;
    situationsOk = check.ok;
    if (!check.ok) reasons.push(`situations-degraded:${check.error ?? "unknown"}`);
  }

  const config = loadDifficultyMatrix();
  const fencedSet = fencedHarnesses(situations);
  const fenced: FencedProvider[] = [...fencedSet].map((harness) => ({
    harness,
    situation: outageSituationSlug(harness),
    retryAt: retryAtFor(harness, nowMs),
  }));
  const retry = buildRetryState(fenced);

  reasons.push(`matrix-version=${config.version}`);
  reasons.push(`difficulty=${request.difficulty}`);
  reasons.push(`mode=${request.mode}`);
  reasons.push(`provider-order=${config.providerOrder.join(",")}`);
  for (const entry of fenced) reasons.push(`fenced=${entry.harness}:${entry.situation}`);

  const base = {
    requestId: request.requestId ?? null,
    difficulty: request.difficulty,
    mode: request.mode,
    timeoutMs: request.timeoutMs ?? null,
    matrixVersion: config.version,
    providerOrder: config.providerOrder,
    fenced,
    retry,
    situationsOk,
  };

  if (request.pin) {
    reasons.push(`pin=${request.pin}`);
    const cell = config.matrix[request.difficulty][request.pin];
    if (!cell) {
      reasons.push(`empty-route=pin-not-in-matrix:${request.pin}`);
      return {
        ...base,
        harness: null,
        model: null,
        empty: true,
        pinned: true,
        fallback: false,
        guardRequired: false,
        // A matrix that does not carry the pin is a config fact, not an
        // outage: waiting does not fix it.
        retry: { ...retry, retryable: false },
        reasons,
      };
    }
    if (fencedSet.has(request.pin)) {
      reasons.push(`empty-route=pin-fenced:${request.pin}`);
      return {
        ...base,
        harness: null,
        model: null,
        empty: true,
        pinned: true,
        fallback: false,
        guardRequired: false,
        reasons,
      };
    }
    reasons.push(`selected=${request.pin} model=${cell.model}`);
    return {
      ...base,
      harness: request.pin,
      model: cell.model,
      empty: false,
      pinned: true,
      fallback: false,
      guardRequired: false,
      reasons,
    };
  }

  // No pin: reuse the matrix resolver the scheduler already used, so the two
  // callers cannot drift.
  let resolution;
  try {
    resolution = resolveDifficulty(request.difficulty, fencedSet);
  } catch (err) {
    if (err instanceof DifficultyMatrixError) {
      reasons.push(`empty-route=matrix-error:${err.message}`);
      return {
        ...base,
        harness: null,
        model: null,
        empty: true,
        pinned: false,
        fallback: false,
        guardRequired: false,
        retry: { ...retry, retryable: false },
        reasons,
      };
    }
    throw err;
  }

  // `resolveDifficulty` keeps the configured primary when every provider is
  // fenced. That is the scheduler's documented posture, not a live route.
  if (fencedSet.has(resolution.harness)) {
    if (allFenced === "empty") {
      reasons.push("empty-route=all-providers-fenced");
      return {
        ...base,
        harness: null,
        model: null,
        empty: true,
        pinned: false,
        fallback: false,
        guardRequired: false,
        reasons,
      };
    }
    reasons.push(`all-fenced-keep-primary=${resolution.harness}`);
  }

  const fallback = resolution.harness !== config.providerOrder[0];
  if (fallback) reasons.push(`fallback-from=${config.providerOrder[0]}`);
  const guardRequired = fallback && request.mode === "write";
  if (guardRequired) reasons.push("write-fallback-guard-required");
  reasons.push(`selected=${resolution.harness} model=${resolution.model}`);

  return {
    ...base,
    harness: resolution.harness,
    model: resolution.model,
    empty: false,
    pinned: false,
    fallback,
    guardRequired,
    reasons,
  };
}

function buildRetryState(fenced: FencedProvider[]): RouteRetryState {
  const situations = fenced.map((entry) => entry.situation);
  let retryAt: string | null = null;
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of fenced) {
    if (!entry.retryAt) continue;
    const parsed = Date.parse(entry.retryAt);
    if (Number.isNaN(parsed) || parsed >= earliest) continue;
    earliest = parsed;
    retryAt = entry.retryAt;
  }
  return { retryable: fenced.length > 0, retryAt, situations };
}
