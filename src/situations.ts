// Dispatch-time Situation fence + agent-impact notice context.
//
// Before spawning a run, the daemon asks F-Situations for the active
// operational posture and skips any routine whose id matches an active
// Situation's `scope_routines` glob. Routines also self-check per workspace
// rules; this fence is defense in depth at the scheduler boundary.
//
// Separately, every dispatched prompt gets a short **notices** banner
// (non-blocking FYI: upgrades/restarts) so agents attribute flapping instead
// of opening false incidents. Notices never fence a run.
//
// The situations binary is overridable (ROUTINES_FSITUATIONS_BIN /
// ROUTINES_SITUATIONS_CLI) for tests. A failure to reach F-Situations is
// reported to the caller, which fails open (schedules the run) but logs the
// degraded check — the same posture the workspace rules take when the
// Situation check "can't run".

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

/** One row from `situations notices --json` (subset agents need). */
export interface RecentNotice {
  slug: string;
  kind: string;
  title: string;
  at: string;
  summary: string;
  scope_systems: string[];
}

export interface NoticesCheck {
  ok: boolean;
  notices: RecentNotice[];
  /** Human-readable block safe to prepend to a prompt. */
  banner: string;
  error?: string;
}

function fsituationsBinary(): string {
  return (
    process.env.ROUTINES_SITUATIONS_CLI?.trim() ||
    process.env.ROUTINES_FSITUATIONS_BIN?.trim() ||
    "situations"
  );
}

function runSituations(args: string[]): {
  ok: boolean;
  stdout: string;
  error?: string;
} {
  const bin = fsituationsBinary();
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.error) {
    return { ok: false, stdout: "", error: `${bin}: ${res.error.message}` };
  }
  if (typeof res.status === "number" && res.status !== 0) {
    // Older installs only have `fsituations` on PATH.
    if (bin === "situations") {
      const fallback = spawnSync("fsituations", args, {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (!fallback.error && fallback.status === 0) {
        return { ok: true, stdout: fallback.stdout ?? "" };
      }
    }
    return {
      ok: false,
      stdout: "",
      error: `${bin} exited ${res.status}: ${res.stderr?.trim() ?? ""}`,
    };
  }
  return { ok: true, stdout: res.stdout ?? "" };
}

export function loadActiveSituations(): SituationCheck {
  const res = runSituations(["list", "--json"]);
  if (!res.ok) {
    return { ok: false, situations: [], error: res.error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout || "[]");
  } catch (err) {
    return { ok: false, situations: [], error: `unparseable situations output: ${(err as Error).message}` };
  }
  const situations = normalizeSituations(parsed);
  return { ok: true, situations };
}

/**
 * Load recent non-blocking notices for the dispatch envelope.
 * Default window: last 2h (ROUTINES_NOTICES_SINCE overrides, e.g. "1h").
 */
export function loadRecentNotices(since?: string): NoticesCheck {
  const window = (since ?? process.env.ROUTINES_NOTICES_SINCE ?? "2h").trim() || "2h";
  const res = runSituations(["notices", "--since", window, "--json"]);
  if (!res.ok) {
    // Missing Notice schema / old CLI → soft degrade; still inject a one-liner.
    const banner = [
      "## Situations notices (FYI, non-blocking)",
      "",
      `(unavailable: ${res.error ?? "unknown error"})`,
      "If the brain/socket looks flappy, try: situations notices --since 1h",
      "Do not restart the primary brain solely for post-upgrade blips.",
      "",
    ].join("\n");
    return { ok: false, notices: [], banner, error: res.error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout || "[]");
  } catch (err) {
    const msg = `unparseable notices output: ${(err as Error).message}`;
    return {
      ok: false,
      notices: [],
      banner: `## Situations notices (FYI, non-blocking)\n\n(${msg})\n\n`,
      error: msg,
    };
  }
  const notices = normalizeNotices(parsed);
  return { ok: true, notices, banner: formatNoticesBanner(notices, window) };
}

export function formatNoticesBanner(notices: RecentNotice[], since = "2h"): string {
  const lines = [
    "## Situations notices (FYI, non-blocking — last " + since + ")",
    "",
    "These explain expected flapping (upgrades, restarts, cutovers). They never",
    "block this run. Before declaring an incident or restarting shared infra,",
    "attribute symptoms to a matching notice unless they outlast the notice window.",
    "",
  ];
  if (notices.length === 0) {
    lines.push(`No notices in the last ${since}.`);
    lines.push("");
    return lines.join("\n");
  }
  for (const n of notices.slice(0, 12)) {
    const systems = n.scope_systems.length ? ` systems=${n.scope_systems.join(",")}` : "";
    lines.push(`- [${n.kind}] ${n.at} ${n.slug}${systems}`);
    lines.push(`  ${n.title}${n.summary ? ` — ${n.summary}` : ""}`);
  }
  if (notices.length > 12) {
    lines.push(`- …and ${notices.length - 12} more (run: situations notices --since ${since})`);
  }
  lines.push("");
  return lines.join("\n");
}

function normalizeNotices(parsed: unknown): RecentNotice[] {
  const arr = Array.isArray(parsed) ? parsed : [];
  const out: RecentNotice[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const slug = typeof rec.slug === "string" ? rec.slug : "";
    if (!slug) continue;
    const systems = Array.isArray(rec.scope_systems)
      ? rec.scope_systems.filter((x): x is string => typeof x === "string")
      : [];
    out.push({
      slug,
      kind: typeof rec.kind === "string" ? rec.kind : "other",
      title: typeof rec.title === "string" ? rec.title : slug,
      at: typeof rec.at === "string" ? rec.at : "",
      summary: typeof rec.summary === "string" ? rec.summary : "",
      scope_systems: systems,
    });
  }
  return out;
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
