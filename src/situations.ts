// Dispatch-time Situation fence.
//
// Before spawning a run, the daemon asks F-Situations for the active
// operational posture and skips any routine whose id matches an active
// Situation's `scope_routines` glob. Routines also self-check per workspace
// rules; this fence is defense in depth at the scheduler boundary.
//
// The fsituations binary is overridable (ROUTINES_FSITUATIONS_BIN) for tests.
// A failure to reach F-Situations is reported to the caller, which fails open
// (schedules the run) but logs the degraded check — the same posture the
// workspace rules take when the Situation check "can't run".

import { spawnSync } from "node:child_process";

export interface ActiveSituation {
  slug: string;
  scope_routines: string[];
}

export interface SituationCheck {
  ok: boolean;
  situations: ActiveSituation[];
  error?: string;
}

function fsituationsBinary(): string {
  return process.env.ROUTINES_FSITUATIONS_BIN ?? "fsituations";
}

export function loadActiveSituations(): SituationCheck {
  const bin = fsituationsBinary();
  const res = spawnSync(bin, ["list", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.error) {
    return { ok: false, situations: [], error: `${bin}: ${res.error.message}` };
  }
  if (typeof res.status === "number" && res.status !== 0) {
    return { ok: false, situations: [], error: `${bin} exited ${res.status}: ${res.stderr?.trim() ?? ""}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout ?? "[]");
  } catch (err) {
    return { ok: false, situations: [], error: `unparseable fsituations output: ${(err as Error).message}` };
  }
  const situations = normalizeSituations(parsed);
  return { ok: true, situations };
}

function normalizeSituations(parsed: unknown): ActiveSituation[] {
  const arr = Array.isArray(parsed) ? parsed : [];
  const out: ActiveSituation[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const slug = typeof rec.slug === "string" ? rec.slug : "";
    const status = typeof rec.status === "string" ? rec.status : "active";
    if (status !== "active") continue;
    const scope = Array.isArray(rec.scope_routines)
      ? rec.scope_routines.filter((x): x is string => typeof x === "string")
      : [];
    out.push({ slug, scope_routines: scope });
  }
  return out;
}

export interface FenceResult {
  fenced: boolean;
  situationSlug?: string;
  pattern?: string;
}

/** Return the first active Situation whose scope_routines glob matches the id. */
export function fenceFor(id: string, situations: ActiveSituation[]): FenceResult {
  for (const s of situations) {
    for (const glob of s.scope_routines) {
      if (globMatch(glob, id)) {
        return { fenced: true, situationSlug: s.slug, pattern: glob };
      }
    }
  }
  return { fenced: false };
}

// Minimal shell-style glob: `*` matches any run of characters, `?` matches one.
// Matches the whole string. Mirrors the `scope_routines` patterns in
// fsituations records (e.g. "*dmg*", "*desktop*").
export function globMatch(glob: string, value: string): boolean {
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re).test(value);
}
