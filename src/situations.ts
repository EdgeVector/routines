// Dispatch-time Situation fence + agent-impact notice context.
//
// Before spawning a run, the daemon asks F-Situations for the active
// operational posture and skips any routine whose id matches an active
// Situation's `scope_routines` glob — but only when that Situation is p0 or
// p1. Routines also self-check per workspace rules; this fence is defense in
// depth at the scheduler boundary for genuine emergencies.
//
// `scope_routines` is informational metadata in the F-Situations app's own
// contract (its record validators document "scope_routines is not a panic
// button" — the real hazard belongs in `blocked_actions`/
// `requires_human_clearance`, which this fence does not currently read). A
// p2/p3 Situation naming a routine in Scope for context must not silently
// stall it. Fixed 2026-10-01 (papercut
// papercut-routines-fence-ignores-blocked-actions-scope-routines-hard-skip-20261001):
// an active p2 Situation (lastdb-brain-cleanout-use-gbrain-20260923, whose
// `blocked_actions` never named either routine) hard-fenced
// last-stack-milestone-driver and last-stack-north-star-driver — the only
// routines that turn North Stars into milestones and todo cards — for 2+
// days straight, starving the kanban board's todo column. A severity gate
// keeps the safety net for real incidents (almost always filed p0/p1)
// without letting informational Scope mentions silently stall routines
// indefinitely. A Situation with no severity (or an unrecognized one) still
// fences, fail-safe, same as before this fix.
//
// Separately, every dispatched prompt gets a short **notices** banner
// (non-blocking FYI: upgrades/restarts) so agents attribute flapping instead
// of opening false incidents. Notices never fence a run.
//
// The Situations binary accepts explicit caller configuration through
// ROUTINES_FSITUATIONS_BIN / ROUTINES_SITUATIONS_CLI. A failed read reports
// unknown posture. The direct route engine refuses a provider in that case.
// The scheduler handles cached posture separately.

import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

/** Severities whose active Situations may hard-fence a routine via scope_routines. */
const FENCING_SEVERITIES = new Set(["p0", "p1"]);

export interface ActiveSituation {
  slug: string;
  scope_routines: string[];
  /** "p0"..."p3", or "" when the record omitted/malformed it (fences fail-safe). */
  severity: string;
}

export interface SituationCheck {
  ok: boolean;
  situations: ActiveSituation[];
  error?: string;
  /** Age of the served answer in ms. Absent on a direct (uncached) read. */
  ageMs?: number;
  /** True when the answer came from the cache rather than a fresh spawn. */
  cached?: boolean;
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
  /** Age of the served answer in ms. Absent on a direct (uncached) read. */
  ageMs?: number;
  /** True when the answer came from the cache rather than a fresh spawn. */
  cached?: boolean;
}

function fsituationsBinary(): string {
  return (
    process.env.ROUTINES_SITUATIONS_CLI?.trim() ||
    process.env.ROUTINES_FSITUATIONS_BIN?.trim() ||
    "situations"
  );
}

function runSituations(args: string[], timeoutMs = 30_000): {
  ok: boolean;
  stdout: string;
  error?: string;
} {
  const bin = fsituationsBinary();
  // One deadline covers the primary process, its output, and the legacy CLI.
  // Giving the fallback a new timeout could double an external host's budget.
  const deadline = performance.now() + timeoutMs;
  const read = (command: string) => {
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) {
      return { ok: false, stdout: "", error: `${command}: read timed out after ${timeoutMs}ms` };
    }
    const res = spawnSync(command, args, {
      encoding: "utf8",
      timeout: remainingMs,
      // A CLI that ignores SIGTERM must not outlive the caller's route lease.
      killSignal: "SIGKILL",
    });
    if (performance.now() >= deadline) {
      return { ok: false, stdout: "", error: `${command}: read timed out after ${timeoutMs}ms` };
    }
    if (res.error) {
      return { ok: false, stdout: "", error: `${command}: ${res.error.message}` };
    }
    if (res.status !== 0) {
      return {
        ok: false,
        stdout: "",
        error: `${command} exited ${res.status ?? res.signal ?? "unknown"}: ${res.stderr?.trim() ?? ""}`,
      };
    }
    return { ok: true, stdout: res.stdout ?? "" };
  };
  const primary = read(bin);
  if (primary.ok || bin !== "situations") return primary;
  // Older installs can provide the legacy CLI. It gets only the time left.
  const fallback = read("fsituations");
  return fallback.ok
    ? fallback
    : { ok: false, stdout: "", error: `${primary.error}; legacy fallback: ${fallback.error}` };
}

export function loadActiveSituations(timeoutMs = 30_000): SituationCheck {
  const res = runSituations(["list", "--json"], timeoutMs);
  if (!res.ok) {
    return { ok: false, situations: [], error: res.error };
  }
  try {
    return { ok: true, situations: parseSituations(res.stdout) };
  } catch (err) {
    return { ok: false, situations: [], error: `unparseable situations output: ${(err as Error).message}` };
  }
}

/**
 * Load recent non-blocking notices for the dispatch envelope.
 * Default window: last 2h (ROUTINES_NOTICES_SINCE overrides, e.g. "1h").
 */
export function loadRecentNotices(since?: string, timeoutMs = 30_000): NoticesCheck {
  const window = (since ?? process.env.ROUTINES_NOTICES_SINCE ?? "2h").trim() || "2h";
  const res = runSituations(["notices", "--since", window, "--json"], timeoutMs);
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
    const severity = typeof rec.severity === "string" ? rec.severity : "";
    out.push({ slug, scope_routines: scope, severity });
  }
  return out;
}

export interface FenceResult {
  fenced: boolean;
  situationSlug?: string;
  pattern?: string;
}

/**
 * Return the first active, p0/p1 Situation whose scope_routines glob matches
 * the id. A p2/p3 (or otherwise non-fencing) match is informational only —
 * see the file-top comment and papercut
 * papercut-routines-fence-ignores-blocked-actions-scope-routines-hard-skip-20261001.
 * A Situation with no severity set still fences (fail-safe default).
 */
export function fenceFor(id: string, situations: ActiveSituation[]): FenceResult {
  for (const s of situations) {
    if (s.severity && !FENCING_SEVERITIES.has(s.severity)) continue;
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

// ---------------------------------------------------------------------------
// Non-blocking cache for the daemon's hot paths.
//
// `dispatchDue` (every tick) and `buildDispatchEnvelope` (every dispatch) both
// used to call `spawnSync` on a LastDB-reading binary from the daemon's single
// JS thread, so node latency set the scheduler's period directly. Measured
// 2026-09-05T18:24-18:39Z on an idle daemon: ONE tick in 14m54s against a
// documented tickMs of 15_000, with 1584 of 2413 main-thread samples in
// `__read_nocancel` — the synchronous read of a child's stdout pipe. Two
// chained 30 s spawnSync calls give a single tick up to 60 s of blocking.
// See papercut-routinesd-tick-loop-stalls-as-inflight-grows-fleet-dispatch-
// stops-silently-20260905.
//
// The cache serves the last good answer immediately and refreshes in the
// background with an async `spawn`. A STALE situations list is strictly better
// than what a timeout produced before, because a timeout returned the EMPTY
// list and an empty list fences nothing. Staleness never silently widens the
// fence; it only delays a new one.
//
// One cold read still blocks, bounded by SITUATIONS_PRIME_TIMEOUT_MS (5 s, vs
// the 30 s default), so a fresh daemon still fences its first pass correctly.

/** Serve a cached answer without spawning while it is younger than this. */
export const SITUATIONS_CACHE_TTL_MS = 60_000;
/** Past this age the cached answer is still SERVED, but reported degraded. */
export const SITUATIONS_CACHE_MAX_AGE_MS = 600_000;
/** The single blocking read allowed: only when nothing is cached yet. */
export const SITUATIONS_PRIME_TIMEOUT_MS = 5_000;
/** Deadline for a background refresh; the child is killed past it. */
export const SITUATIONS_REFRESH_TIMEOUT_MS = 20_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface CacheSlot<T> {
  value: T | null;
  /** Epoch ms of the last SUCCESSFUL load. 0 while nothing has ever loaded. */
  at: number;
  /** Single-flight guard: never run two refreshes of the same slot at once. */
  refreshing: boolean;
  /**
   * True once the ONE bounded blocking prime has been attempted. A failed
   * prime must not be retried synchronously: a CLI that is merely slower than
   * the prime budget would then charge every tick the full budget forever, and
   * still serve the empty fail-open list. After the first attempt the slot is
   * filled by background refresh only, which gets the longer deadline.
   */
  primeAttempted: boolean;
  /**
   * What produced the cached answer: the resolved CLI, plus any argument that
   * changes the answer. A cached answer belongs to its source, so when the key
   * moves the slot is cold again rather than silently serving another CLI's
   * reply. In production the key never changes; it is what keeps the module
   * honest for `routines agent-exec` and any future per-call window.
   */
  key: string;
  lastError?: string;
}

function emptySlot<T>(): CacheSlot<T> {
  return { value: null, at: 0, refreshing: false, primeAttempted: false, key: "" };
}

/**
 * The cache is OFF by default and the daemon turns it on at startup.
 *
 * Only a long-lived process has ticks to amortise a cached answer over. A
 * one-shot command (`routines run`, `routines status`, `routines agent-exec`)
 * pays the read once and must report the posture as of the
 * moment it was asked, so it keeps the direct read and this whole module stays
 * inert for it.
 */
let cacheEnabled = false;

/** Turn the cache on (daemon startup) or off. Returns the previous setting. */
export function enableSituationsCache(on = true): boolean {
  const before = cacheEnabled;
  cacheEnabled = on;
  return before;
}

export function situationsCacheEnabled(): boolean {
  return cacheEnabled;
}

const situationsSlot: CacheSlot<ActiveSituation[]> = emptySlot();
const noticesSlot: CacheSlot<RecentNotice[]> = emptySlot();

/** Drop every cached answer. */
export function resetSituationsCache(): void {
  situationsSlot.value = null;
  situationsSlot.at = 0;
  situationsSlot.refreshing = false;
  situationsSlot.primeAttempted = false;
  situationsSlot.key = "";
  situationsSlot.lastError = undefined;
  noticesSlot.value = null;
  noticesSlot.at = 0;
  noticesSlot.refreshing = false;
  noticesSlot.primeAttempted = false;
  noticesSlot.key = "";
  noticesSlot.lastError = undefined;
}

/**
 * Spawn the situations CLI without blocking the caller. Resolves with stdout
 * on a clean exit; never rejects, never throws into the event loop.
 */
function runSituationsAsync(
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const bin = fsituationsBinary();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, stdout: "", error: `${bin}: ${(err as Error).message}` });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const finish = (r: { ok: boolean; stdout: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout: "", error: `${bin}: refresh timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    // A pending refresh must never hold the daemon open at shutdown.
    if (typeof timer.unref === "function") timer.unref();
    child.stdout?.on("data", (c) => {
      out += String(c);
    });
    child.stderr?.on("data", (c) => {
      err += String(c);
    });
    child.on("error", (e) => finish({ ok: false, stdout: "", error: `${bin}: ${e.message}` }));
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, stdout: out });
      else finish({ ok: false, stdout: "", error: `${bin} exited ${code}: ${err.trim()}` });
    });
  });
}

/**
 * Kick a background refresh of one slot. Returns immediately. Single-flight:
 * a second call while one is in flight is a no-op, so a slow CLI cannot pile
 * up one child per tick.
 */
function refreshSlot<T>(
  slot: CacheSlot<T>,
  args: string[],
  parse: (stdout: string) => T,
): void {
  if (slot.refreshing) return;
  slot.refreshing = true;
  const timeoutMs = envMs("ROUTINES_SITUATIONS_REFRESH_TIMEOUT_MS", SITUATIONS_REFRESH_TIMEOUT_MS);
  void runSituationsAsync(args, timeoutMs).then((res) => {
    slot.refreshing = false;
    if (!res.ok) {
      slot.lastError = res.error;
      return;
    }
    try {
      slot.value = parse(res.stdout);
      slot.at = Date.now();
      slot.lastError = undefined;
    } catch (e) {
      slot.lastError = `unparseable situations output: ${(e as Error).message}`;
    }
  });
}

/** Drop a slot's contents when the thing that produced them has changed. */
function keySlot<T>(slot: CacheSlot<T>, key: string): void {
  if (slot.key === key) return;
  slot.key = key;
  slot.value = null;
  slot.at = 0;
  slot.primeAttempted = false;
  slot.lastError = undefined;
}

function parseSituations(stdout: string): ActiveSituation[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("expected a situations array");
  for (const [position, item] of parsed.entries()) {
    const label = `situations entry ${position}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}: expected an object`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.slug !== "string" || !rec.slug.trim()) {
      throw new Error(`${label}: expected a nonempty slug`);
    }
    // Legacy records omit these fields: status defaults to active and scope
    // defaults to empty. A supplied malformed value must not erase a fence.
    if (rec.status !== undefined && (
      typeof rec.status !== "string" || !rec.status.trim()
    )) {
      throw new Error(`${label}: expected a nonempty string status`);
    }
    if (rec.scope_routines !== undefined && (
      !Array.isArray(rec.scope_routines)
      || rec.scope_routines.some((scope) => typeof scope !== "string")
    )) {
      throw new Error(`${label}: expected an array of string scopes`);
    }
  }
  return normalizeSituations(parsed);
}

function parseNotices(stdout: string): RecentNotice[] {
  return normalizeNotices(JSON.parse(stdout || "[]"));
}

/**
 * The active Situations, served from cache. NEVER blocks once the cache holds
 * a value; the only blocking read is the cold prime, bounded at 5 s.
 *
 * Fail-open posture is unchanged from `loadActiveSituations`: when nothing can
 * be loaded at all, the answer is `ok:false` with an EMPTY list, which fences
 * nothing — the same behaviour a timeout produced before.
 */
export function loadActiveSituationsCached(now = Date.now()): SituationCheck {
  if (!cacheEnabled) return loadActiveSituations();
  keySlot(situationsSlot, `list|${fsituationsBinary()}`);
  const ttl = envMs("ROUTINES_SITUATIONS_CACHE_TTL_MS", SITUATIONS_CACHE_TTL_MS);
  const maxAge = envMs("ROUTINES_SITUATIONS_MAX_AGE_MS", SITUATIONS_CACHE_MAX_AGE_MS);

  if (situationsSlot.value === null) {
    if (!situationsSlot.primeAttempted) {
      // Cold: ONE bounded blocking read so a fresh daemon fences its first pass.
      situationsSlot.primeAttempted = true;
      const primed = loadActiveSituations(
        envMs("ROUTINES_SITUATIONS_PRIME_TIMEOUT_MS", SITUATIONS_PRIME_TIMEOUT_MS),
      );
      if (primed.ok) {
        situationsSlot.value = primed.situations;
        situationsSlot.at = now;
        situationsSlot.lastError = undefined;
        return { ok: true, situations: primed.situations, ageMs: 0, cached: false };
      }
      situationsSlot.lastError = primed.error;
      return { ok: false, situations: [], error: primed.error, ageMs: 0, cached: false };
    }
    // The prime already failed once. Fill in the background on the longer
    // deadline and fail open meanwhile — never block a second tick.
    refreshSlot(situationsSlot, ["list", "--json"], parseSituations);
    return {
      ok: false,
      situations: [],
      error: `situations cache not primed${situationsSlot.lastError ? `: ${situationsSlot.lastError}` : ""}`,
      ageMs: 0,
      cached: false,
    };
  }

  const ageMs = Math.max(0, now - situationsSlot.at);
  if (ageMs >= ttl) refreshSlot(situationsSlot, ["list", "--json"], parseSituations);
  if (ageMs > maxAge) {
    return {
      ok: false,
      situations: situationsSlot.value,
      error:
        `situations cache stale (${Math.round(ageMs / 1000)}s old, max ${Math.round(maxAge / 1000)}s)` +
        (situationsSlot.lastError ? `: ${situationsSlot.lastError}` : ""),
      ageMs,
      cached: true,
    };
  }
  return { ok: true, situations: situationsSlot.value, ageMs, cached: true };
}

/**
 * The notices banner for a dispatch envelope, served from cache. Same shape as
 * `loadRecentNotices`; the window is only consulted on a cold prime and on the
 * background refresh, so the banner text always names the window it was built
 * from.
 */
export function loadRecentNoticesCached(since?: string, now = Date.now()): NoticesCheck {
  const window = (since ?? process.env.ROUTINES_NOTICES_SINCE ?? "2h").trim() || "2h";
  if (!cacheEnabled) return loadRecentNotices(window);
  keySlot(noticesSlot, `notices|${window}|${fsituationsBinary()}`);
  const ttl = envMs("ROUTINES_SITUATIONS_CACHE_TTL_MS", SITUATIONS_CACHE_TTL_MS);
  const maxAge = envMs("ROUTINES_SITUATIONS_MAX_AGE_MS", SITUATIONS_CACHE_MAX_AGE_MS);

  if (noticesSlot.value === null) {
    if (!noticesSlot.primeAttempted) {
      // Bounded cold prime — never the 30 s default on the daemon's thread.
      noticesSlot.primeAttempted = true;
      const primed = loadRecentNotices(
        window,
        envMs("ROUTINES_SITUATIONS_PRIME_TIMEOUT_MS", SITUATIONS_PRIME_TIMEOUT_MS),
      );
      if (primed.ok) {
        noticesSlot.value = primed.notices;
        noticesSlot.at = now;
        noticesSlot.lastError = undefined;
        return { ...primed, ageMs: 0, cached: false };
      }
      noticesSlot.lastError = primed.error;
      return { ...primed, ageMs: 0, cached: false };
    }
    // Background-fill only. Build the soft-degrade banner in process: another
    // spawn here would put the blocking read straight back on the hot path.
    refreshSlot(noticesSlot, ["notices", "--since", window, "--json"], parseNotices);
    const reason = noticesSlot.lastError ?? "notices cache not primed";
    const banner = [
      "## Situations notices (FYI, non-blocking)",
      "",
      `(unavailable: ${reason})`,
      "If the brain/socket looks flappy, try: situations notices --since 1h",
      "Do not restart the primary brain solely for post-upgrade blips.",
      "",
    ].join("\n");
    return { ok: false, notices: [], banner, error: reason, ageMs: 0, cached: false };
  }

  const ageMs = Math.max(0, now - noticesSlot.at);
  if (ageMs >= ttl) {
    refreshSlot(noticesSlot, ["notices", "--since", window, "--json"], parseNotices);
  }
  const notices = noticesSlot.value;
  const banner = formatNoticesBanner(notices, window);
  if (ageMs > maxAge) {
    return {
      ok: false,
      notices,
      banner,
      error: `notices cache stale (${Math.round(ageMs / 1000)}s old)` +
        (noticesSlot.lastError ? `: ${noticesSlot.lastError}` : ""),
      ageMs,
      cached: true,
    };
  }
  return { ok: true, notices, banner, ageMs, cached: true };
}
