// Harness-outage classification for error escalation.
//
// Tom 2026-07-17: a Codex usage-limit exhaustion filed 15 P0 "routine errored"
// cards in two days — one per routine — while the actual problem was a single
// dead harness no agent could fix. That is not a papercut and must not become
// board noise. When a run dies because the HARNESS itself is out of service
// (usage limit / quota / capacity / auth), we instead:
//   1. Classify the run needs-human (triage-result.json → dashboard chip)
//   2. Upsert an active Situation fencing every routine on that harness, so
//      the scheduler stops spawning agents into a dead harness
//   3. Page Tom on Telegram via the remote agent (`ra notify --priority high`)
// and file NO kanban card and dispatch NO triage agent (it would run on the
// same dead harness).
//
// The Situation carries expires_at (parsed from the provider's "try again at
// …" hint when possible, else a short TTL): when it lapses the fleet resumes,
// and if the harness is still down the first failure re-fences it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAll, type RoutineEntry } from "./registry.ts";
import { routinesHome } from "./paths.ts";
import type { RunResult } from "./runner.ts";

export type HarnessOutageKind = "usage-limit" | "capacity" | "auth";

export interface HarnessOutage {
  kind: HarnessOutageKind;
  /** The log line that matched, for evidence. */
  evidence: string;
  /** Raw "try again at …" hint from the provider, when present. */
  resetHint: string | null;
  /** Parsed reset time (ISO), when the hint was parseable. */
  resetAt: string | null;
}

export interface HarnessOutageOptions {
  nowMs?: number;
  /** Override situations binary (tests). */
  situationsBin?: string;
  /** Override the Telegram notifier binary (tests). Default `ra`. */
  raBin?: string;
  /** Min gap between Telegram pages per harness. Default 12h. */
  notifyCooldownMs?: number;
  /** Min gap between Situation upserts per harness. Default 30m. */
  situationRefreshMs?: number;
  /** Fallback Situation TTL when no reset time is parseable. Default 6h. */
  defaultTtlMs?: number;
  quiet?: boolean;
}

const STATE_DIR_NAME = "harness-outage";
const DEFAULT_NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const DEFAULT_SITUATION_REFRESH_MS = 30 * 60 * 1000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
/** How much log tail to scan for outage signatures. */
const TAIL_BYTES = 16 * 1024;

interface OutageState {
  kind: HarnessOutageKind;
  lastSeenAt: string;
  lastSituationAt?: string;
  lastNotifiedAt?: string;
  situationSlug: string;
}

// Unambiguous provider phrases only — these are matched against harness
// stderr/stdout tails, which can echo prompt text, so every pattern here must
// be something no routine prompt plausibly contains as instructions.
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /you'?ve hit your usage limit/i,
  /usage limit reached/i,
  /purchase more credits/i,
  /out of credits/i,
  /insufficient[_\s]quota/i,
  /exceeded your current quota/i,
  /credit balance is too low/i,
];

const CAPACITY_PATTERNS: RegExp[] = [
  /selected model is at capacity/i,
  /model is (?:currently )?at capacity/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /api key (?:is )?(?:invalid|expired|revoked)/i,
  /authentication failed/i,
  /401 unauthorized/i,
];

function readTail(path: string): string {
  try {
    if (!existsSync(path)) return "";
    const size = statSync(path).size;
    const text = readFileSync(path, "utf8");
    return size > TAIL_BYTES ? text.slice(text.length - TAIL_BYTES) : text;
  } catch {
    return "";
  }
}

function matchLine(text: string, patterns: RegExp[]): string | null {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    for (const re of patterns) {
      if (re.test(line)) return line.trim().slice(0, 300);
    }
  }
  return null;
}

/** Parse provider reset hints like "try again at Jul 22nd, 2026 10:00 PM". */
export function parseResetHint(text: string, nowMs: number): {
  hint: string | null;
  iso: string | null;
} {
  const m = text.match(/try again (?:at|after) ([^.\n]+)/i);
  if (!m) return { hint: null, iso: null };
  const hint = m[1]!.trim();
  // Strip ordinal suffixes (22nd → 22) so Date.parse has a chance.
  const cleaned = hint.replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
  const ts = Date.parse(cleaned);
  if (Number.isNaN(ts) || ts <= nowMs) return { hint, iso: null };
  return { hint, iso: new Date(ts).toISOString() };
}

/**
 * Classify whether a failed run died because the harness itself is out of
 * service. Scans the run's log tails plus the outcome detail. Null when the
 * failure does not look harness-level.
 */
export function classifyHarnessOutage(
  result: RunResult,
  opts: HarnessOutageOptions = {},
): HarnessOutage | null {
  const nowMs = opts.nowMs ?? Date.now();
  const corpus = [
    readTail(join(result.runDir, "stderr.log")),
    readTail(join(result.runDir, "stdout.log")),
    result.outcome.detail ?? "",
  ].join("\n");

  const usage = matchLine(corpus, USAGE_LIMIT_PATTERNS);
  const capacity = usage ? null : matchLine(corpus, CAPACITY_PATTERNS);
  const auth = usage || capacity ? null : matchLine(corpus, AUTH_PATTERNS);
  const evidence = usage ?? capacity ?? auth;
  if (!evidence) return null;

  const { hint, iso } = parseResetHint(corpus, nowMs);
  return {
    kind: usage ? "usage-limit" : capacity ? "capacity" : "auth",
    evidence,
    resetHint: hint,
    resetAt: iso,
  };
}

export function outageSituationSlug(harness: string): string {
  return `harness-outage-${harness.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

function outageStateDir(): string {
  return join(routinesHome(), STATE_DIR_NAME);
}

function outageStatePath(harness: string): string {
  return join(outageStateDir(), `${harness.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`);
}

function readOutageState(harness: string): OutageState | null {
  const p = outageStatePath(harness);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as OutageState;
  } catch {
    return null;
  }
}

function writeOutageState(harness: string, st: OutageState): void {
  mkdirSync(outageStateDir(), { recursive: true });
  writeFileSync(outageStatePath(harness), JSON.stringify(st, null, 2) + "\n");
}

function logLine(quiet: boolean | undefined, msg: string): void {
  if (quiet) return;
  try {
    process.stderr.write(`[routines harness-outage] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

/** All registry routine ids on the given harness (fallback: just this one). */
function routineIdsForHarness(harness: string, fallbackId: string): string[] {
  try {
    const { entries } = loadAll();
    const ids = entries.filter((e) => e.harness === harness).map((e) => e.id);
    if (ids.length > 0) return ids.sort();
  } catch {
    /* fall through */
  }
  return [fallbackId];
}

function upsertSituation(
  entry: RoutineEntry,
  outage: HarnessOutage,
  scopeRoutines: string[],
  expiresAt: string,
  opts: HarnessOutageOptions,
): { ok: boolean; detail: string } {
  const bin =
    opts.situationsBin ??
    process.env.ROUTINES_SITUATIONS_CLI?.trim() ??
    process.env.ROUTINES_FSITUATIONS_BIN?.trim() ??
    "situations";
  const slug = outageSituationSlug(entry.harness);
  const reset = outage.resetAt ?? outage.resetHint;
  const record = {
    slug,
    title: `Harness outage: ${entry.harness} ${outage.kind}`,
    summary:
      `The ${entry.harness} harness is out of service (${outage.kind}); ` +
      `evidence from routine ${entry.id}: "${outage.evidence}". ` +
      `${scopeRoutines.length} routine(s) fenced until this clears` +
      (reset ? ` (provider reset hint: ${reset})` : "") +
      `. Filed by routinesd harness-outage; Tom paged via Telegram.`,
    status: "active",
    severity: "high",
    scope_systems: [`harness:${entry.harness}`],
    scope_routines: scopeRoutines,
    blocked_actions: [`dispatch-${entry.harness}-agents`],
    requires_human_clearance: false,
    preflight_message:
      `The ${entry.harness} harness is out of service (${outage.kind}). ` +
      `Do not spawn ${entry.harness} agents or retry-loop; wait for the reset ` +
      `or a human to restore credits/auth.`,
    owner: "routinesd",
    expires_at: expiresAt,
  };
  const res = spawnSync(bin, ["put", "-"], {
    input: JSON.stringify(record) + "\n",
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });
  if (res.error) return { ok: false, detail: `situations spawn: ${res.error.message}` };
  if (res.status !== 0) {
    return {
      ok: false,
      detail: `situations exit ${String(res.status)}: ${(res.stderr || res.stdout || "").slice(0, 300)}`,
    };
  }
  return { ok: true, detail: `situation ${slug} upserted (expires ${expiresAt})` };
}

function notifyTelegram(
  entry: RoutineEntry,
  outage: HarnessOutage,
  fencedCount: number,
  opts: HarnessOutageOptions,
): { ok: boolean; detail: string } {
  const bin = opts.raBin ?? process.env.ROUTINES_RA_BIN?.trim() ?? "ra";
  const reset = outage.resetAt ?? outage.resetHint ?? "unknown";
  const msg =
    `Needs human: ${entry.harness} harness ${outage.kind} — ` +
    `"${outage.evidence.slice(0, 160)}". ` +
    `${fencedCount} routine(s) fenced via situation ${outageSituationSlug(entry.harness)}; ` +
    `no P0 cards filed. Reset: ${reset}.`;
  const res = spawnSync(bin, ["notify", "--priority", "high", msg], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${join(routinesHome(), "..", ".local", "bin")}:${process.env.PATH ?? ""}`,
    },
  });
  if (res.error) return { ok: false, detail: `ra spawn: ${res.error.message}` };
  if (res.status !== 0) {
    return {
      ok: false,
      detail: `ra exit ${String(res.status)}: ${(res.stderr || res.stdout || "").slice(0, 300)}`,
    };
  }
  return { ok: true, detail: "paged Tom on Telegram" };
}

/**
 * Handle a harness-outage failure: needs-human verdict + Situation fence +
 * Telegram page. Files NO kanban card and dispatches NO triage agent.
 * Never throws.
 */
export function handleHarnessOutage(
  entry: RoutineEntry,
  result: RunResult,
  outage: HarnessOutage,
  opts: HarnessOutageOptions = {},
): { escalated: boolean; detail: string } {
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const now = new Date(nowMs).toISOString();
    const slug = outageSituationSlug(entry.harness);
    const prev = readOutageState(entry.harness);

    const scopeRoutines = routineIdsForHarness(entry.harness, entry.id);
    const detailParts: string[] = [`harness-outage:${outage.kind}`];

    // 1. needs-human verdict for the dashboard (escalate-status reads this).
    try {
      writeFileSync(
        join(result.runDir, "triage-result.json"),
        JSON.stringify(
          {
            finishedAt: now,
            result: "needs-human",
            needsHuman: true,
            detail: `${entry.harness} harness ${outage.kind}: ${outage.evidence}`,
            rootCause: `harness-outage:${outage.kind}`,
          },
          null,
          2,
        ) + "\n",
      );
    } catch {
      /* ignore */
    }

    // 2. Situation fence (rate-limited refresh; upsert is idempotent by slug).
    const refreshMs = opts.situationRefreshMs ?? DEFAULT_SITUATION_REFRESH_MS;
    const lastSit = prev?.lastSituationAt ? Date.parse(prev.lastSituationAt) : 0;
    let situationAt = prev?.lastSituationAt;
    if (Number.isNaN(lastSit) || nowMs - lastSit >= refreshMs) {
      const ttlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
      const expiresAt = outage.resetAt ?? new Date(nowMs + ttlMs).toISOString();
      const sit = upsertSituation(entry, outage, scopeRoutines, expiresAt, opts);
      detailParts.push(sit.ok ? sit.detail : `situation FAILED: ${sit.detail}`);
      if (sit.ok) situationAt = now;
      logLine(opts.quiet, sit.detail);
    } else {
      detailParts.push(`situation ${slug} fresh (refreshed ${prev?.lastSituationAt})`);
    }

    // 3. Telegram page (long cooldown — one page per outage episode).
    const notifyCooldown = opts.notifyCooldownMs ?? DEFAULT_NOTIFY_COOLDOWN_MS;
    const lastNotify = prev?.lastNotifiedAt ? Date.parse(prev.lastNotifiedAt) : 0;
    let notifiedAt = prev?.lastNotifiedAt;
    if (Number.isNaN(lastNotify) || nowMs - lastNotify >= notifyCooldown) {
      const page = notifyTelegram(entry, outage, scopeRoutines.length, opts);
      detailParts.push(page.ok ? page.detail : `telegram FAILED: ${page.detail}`);
      if (page.ok) notifiedAt = now;
      logLine(opts.quiet, page.detail);
    } else {
      detailParts.push(`telegram on cooldown (last ${prev?.lastNotifiedAt})`);
    }

    const st: OutageState = {
      kind: outage.kind,
      lastSeenAt: now,
      situationSlug: slug,
    };
    if (situationAt) st.lastSituationAt = situationAt;
    if (notifiedAt) st.lastNotifiedAt = notifiedAt;
    writeOutageState(entry.harness, st);

    const detail = detailParts.join("; ");

    // 4. Breadcrumb so the dashboard shows this run as escalated (needs-human
    //    comes from triage-result.json; no card, no triage agent by design).
    try {
      writeFileSync(
        join(result.runDir, "error-escalated.json"),
        JSON.stringify(
          {
            at: now,
            cardSlug: null,
            agent: `suppressed: ${detail}`,
            agentDispatched: false,
            harnessOutage: {
              kind: outage.kind,
              evidence: outage.evidence,
              situationSlug: slug,
              resetAt: outage.resetAt,
            },
          },
          null,
          2,
        ) + "\n",
      );
    } catch {
      /* ignore */
    }

    return { escalated: true, detail };
  } catch (err) {
    return { escalated: false, detail: `harness-outage threw: ${(err as Error).message}` };
  }
}
