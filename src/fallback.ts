// Harness fallback chain for scheduled runs.
//
// Tom 2026-07-17: when the primary chat agent is out of service (credits /
// quota / capacity / auth), keep the routine working on the next agent instead
// of fencing the fleet idle. Default after primary: Claude Sonnet → Grok.
// Fallback is ephemeral — registry TOML is never rewritten.
//
// Disable with ROUTINES_FALLBACK=0. Override fleet tail with
// ROUTINES_FALLBACK_CHAIN=claude:sonnet,grok:grok-4.5 or per-routine
// `fallback = "claude:sonnet,grok:grok-4.5"` in the registry TOML.

import type { Harness, RoutineEntry } from "./registry.ts";
import { isHarness } from "./registry.ts";

export interface RouteStep {
  harness: Harness;
  model: string;
  effort?: string;
}

/** Default model per harness when the chain does not specify one. */
export const DEFAULT_HARNESS_MODELS: Record<Harness, string> = {
  claude: "sonnet",
  codex: "gpt-5.5",
  grok: "grok-4.5",
};

/** Fleet default tail after the routine's primary (order fixed by product). */
export const DEFAULT_FALLBACK_TAIL: RouteStep[] = [
  { harness: "claude", model: DEFAULT_HARNESS_MODELS.claude },
  { harness: "grok", model: DEFAULT_HARNESS_MODELS.grok },
];

export function fallbackEnabled(): boolean {
  const v = process.env.ROUTINES_FALLBACK;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

/**
 * Parse a chain string like `claude:sonnet,grok:grok-4.5` or `claude/sonnet`.
 * Invalid tokens are skipped (never throw — registry/env typos must not kill
 * the daemon).
 */
export function parseFallbackChain(raw: string | undefined | null): RouteStep[] {
  if (!raw || !raw.trim()) return [];
  const out: RouteStep[] = [];
  for (const part of raw.split(/[,;]+/)) {
    const token = part.trim();
    if (!token) continue;
    const sep = token.includes(":") ? ":" : token.includes("/") ? "/" : null;
    if (!sep) {
      if (isHarness(token)) {
        out.push({ harness: token, model: DEFAULT_HARNESS_MODELS[token] });
      }
      continue;
    }
    const [hRaw, ...rest] = token.split(sep);
    const h = (hRaw ?? "").trim();
    const model = rest.join(sep).trim();
    if (!isHarness(h) || !model) continue;
    out.push({ harness: h, model });
  }
  return out;
}

/** Primary route as recorded on the registry entry. */
export function primaryRoute(entry: RoutineEntry): RouteStep {
  const step: RouteStep = { harness: entry.harness, model: entry.model };
  if (entry.effort) step.effort = entry.effort;
  return step;
}

/**
 * Ordered routes for one fire: primary first, then the fallback tail.
 * Dedupes by harness (first wins) so a codex-primary routine does not re-hit
 * codex via a misconfigured tail.
 */
export function buildRouteChain(entry: RoutineEntry): RouteStep[] {
  const primary = primaryRoute(entry);
  if (!fallbackEnabled()) return [primary];

  const fromEntry = parseFallbackChain(entry.fallback);
  const fromEnv = parseFallbackChain(process.env.ROUTINES_FALLBACK_CHAIN);
  const tail = fromEntry.length > 0 ? fromEntry : fromEnv.length > 0 ? fromEnv : DEFAULT_FALLBACK_TAIL;

  const out: RouteStep[] = [primary];
  const seen = new Set<Harness>([primary.harness]);
  for (const step of tail) {
    if (seen.has(step.harness)) continue;
    seen.add(step.harness);
    out.push(step);
  }
  return out;
}

/** Apply a route step onto a clone of the registry entry (TOML untouched). */
export function entryForRoute(entry: RoutineEntry, step: RouteStep): RoutineEntry {
  const next: RoutineEntry = {
    ...entry,
    harness: step.harness,
    model: step.model,
  };
  if (step.effort) next.effort = step.effort;
  else if (step.harness !== entry.harness) delete next.effort;
  return next;
}

export function formatRoute(step: RouteStep): string {
  return `${step.harness}/${step.model}`;
}
