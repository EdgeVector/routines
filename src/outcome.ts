// Run outcome classification: did the routine do useful work, no-op, or fail?
//
// Agents already emit a three-way signal in heartbeats / final prose:
//   <name> <ISO?> <ok|noop|error> <one-line detail>
// optionally:
//   ROUTINE_RESULT outcome=ok|noop|error actions=N detail=...
//
// This module extracts that signal from captured stdout/stderr so the
// dashboard can show last outcome + rolling noop rates for cadence tuning.
// Classification is best-effort and never fails a run.

import { canonicalRoutineId } from "./kanban-id-migration.ts";

export type OutcomeKind = "ok" | "noop" | "error" | "unknown";

export type OutcomeSource =
  | "routine_result" // explicit ROUTINE_RESULT trailer
  | "heartbeat" // ok|noop|error line / append-heartbeat --line
  | "exit" // inferred from non-zero exit / timeout only
  | "none";

export interface RunOutcome {
  kind: OutcomeKind;
  /** Free-text detail (truncated). */
  detail: string | null;
  source: OutcomeSource;
}

export interface OutcomeStats {
  /** Runs considered (capped window). */
  n: number;
  ok: number;
  noop: number;
  error: number;
  unknown: number;
  /**
   * noop / (ok + noop) when at least one clean classified run exists.
   * Null when there is no ok/noop signal yet (only errors/unknown).
   */
  noopRate: number | null;
  /** ok / (ok + noop), same denominator rules as noopRate. */
  usefulRate: number | null;
}

const DETAIL_MAX = 240;

/** Names agents historically put in heartbeats that map to a registry id. */
const ALIAS_TO_CANONICAL: Record<string, string> = {
  "last-stack-fkanban-pickup": "last-stack-kanban-pickup",
  "kanban-pickup": "last-stack-kanban-pickup",
  "fkanban-pickup": "last-stack-kanban-pickup",
  "last-stack-fkanban-watch": "last-stack-kanban-watch",
  "kanban-watch": "last-stack-kanban-watch",
  "fkanban-watch": "last-stack-kanban-watch",
  "last-stack-fkanban-validate": "last-stack-kanban-validate",
  "kanban-validate": "last-stack-kanban-validate",
  "fkanban-validate": "last-stack-kanban-validate",
  "groom-board": "last-stack-groom-board",
  "groom-fkanban-board": "last-stack-groom-board",
  "groom-kanban-board": "last-stack-groom-board",
  "program-driver": "last-stack-program-driver",
  "drain-open-prs": "last-stack-drain-open-prs",
  "consolidate-brain": "last-stack-consolidate-brain",
  "consolidate-fbrain": "last-stack-consolidate-brain",
  "morning-sync": "last-stack-morning-sync",
  "papercut-sweep": "last-stack-papercut-sweep",
  "daily-agent-papercut-sweep": "last-stack-papercut-sweep",
  "self-improvement-loop": "last-stack-self-improvement-loop",
  "daily-self-improvement-loop": "last-stack-self-improvement-loop",
  "disk-reclaim": "last-stack-disk-reclaim",
  "worktree-cleanup": "last-stack-worktree-cleanup",
  "clean-up-stale-worktrees": "last-stack-worktree-cleanup",
  "pipeline-health": "last-stack-pipeline-health",
  "daily-retro": "daily-retro-prevention",
  "retro-prevention": "daily-retro-prevention",
};

/** Alternate names that should count as matching `routineId`. */
export function nameMatchesRoutine(name: string, routineId: string): boolean {
  const n = canonicalRoutineId(name.toLowerCase());
  const id = canonicalRoutineId(routineId.toLowerCase());
  if (n === id) return true;
  if (ALIAS_TO_CANONICAL[n] === id) return true;
  // strip common prefixes either way
  const strip = (s: string) =>
    s.replace(/^last-stack-/, "").replace(/^fkanban-/, "kanban-").replace(/^daily-/, "");
  if (strip(n) === strip(id)) return true;
  // id ends with name or name ends with significant id tail
  if (id.endsWith(n) || n.endsWith(id)) return true;
  return false;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= DETAIL_MAX ? t : t.slice(0, DETAIL_MAX - 1) + "…";
}

function asKind(raw: string): OutcomeKind | null {
  const k = raw.toLowerCase();
  if (k === "ok" || k === "noop" || k === "error") return k;
  return null;
}

/** Explicit machine trailer (strongest). */
const ROUTINE_RESULT_RE =
  /ROUTINE_RESULT\s+outcome\s*=\s*(ok|noop|error)\b([^;\n\r]*)/gi;

/**
 * Compact agent trailer used by some project prompts:
 *   RESULT: noop reason=DASHBOARD_SKIP ...
 *   RESULT: ok filed=1
 */
const RESULT_COLON_RE =
  /\bRESULT:\s*(ok|noop|error)\b([^\n\r]*)/gi;

/**
 * Heartbeat-style lines, including:
 *   groom-board 2026-07-13T12:34:00Z ok closed-review-1
 *   kanban-pickup 2026-07-13T13:06:03Z noop cards=0
 *   kanban-validate <ISO-ts> noop no-candidates
 * and quoted forms inside --line "..."
 */
const HEARTBEAT_LINE_RE =
  /(?:^|[\s"'`])([A-Za-z][A-Za-z0-9._-]{2,80})\s+(?:\d{4}-\d{2}-\d{2}T[^\s"']+\s+)?(ok|noop|error)\b([^\n\r"']*)/gim;

/** append-heartbeat --line '...'  (line may use double or single quotes). */
const APPEND_LINE_RE =
  /last-stack-brain-append-heartbeat[^\n\r]*?--line\s+["']([^"']+)["']/gi;

interface Candidate {
  kind: OutcomeKind;
  detail: string | null;
  source: OutcomeSource;
  /** Higher wins when scanning multiple matches; later match preferred at same score. */
  score: number;
  index: number;
}

/**
 * Parse the best outcome signal from combined harness output.
 * @param routineId registry id (used to prefer matching heartbeat names)
 * @param text stdout + stderr (order does not matter; we scan all)
 * @param opts.exitCode / timedOut for exit-based fallback
 */
export function parseOutcome(
  routineId: string,
  text: string,
  opts: { exitCode?: number | null; timedOut?: boolean } = {},
): RunOutcome {
  const candidates: Candidate[] = [];

  for (const m of text.matchAll(ROUTINE_RESULT_RE)) {
    const kind = asKind(m[1]!);
    if (!kind) continue;
    const rest = clip(m[2] ?? "");
    // prefer detail=... if present
    const detailM = rest.match(/\bdetail\s*=\s*(.+)$/i);
    const detail = detailM ? clip(detailM[1]!) : rest || null;
    candidates.push({
      kind,
      detail,
      source: "routine_result",
      score: 100,
      index: m.index ?? 0,
    });
  }

  for (const m of text.matchAll(RESULT_COLON_RE)) {
    const kind = asKind(m[1]!);
    if (!kind) continue;
    const rest = clip(m[2] ?? "");
    candidates.push({
      kind,
      detail: rest || null,
      source: "routine_result",
      score: 95,
      index: m.index ?? 0,
    });
  }

  for (const m of text.matchAll(APPEND_LINE_RE)) {
    const inner = m[1] ?? "";
    const parsed = parseHeartbeatPhrase(inner, routineId);
    if (parsed) {
      candidates.push({
        ...parsed,
        source: "heartbeat",
        score: parsed.score + 10, // prefer explicit append-heartbeat
        index: m.index ?? 0,
      });
    }
  }

  for (const m of text.matchAll(HEARTBEAT_LINE_RE)) {
    const name = m[1]!;
    const kind = asKind(m[2]!);
    if (!kind) continue;
    // reject common false positives
    if (isFalsePositiveName(name)) continue;
    const detail = clip(m[3] ?? "") || null;
    // ONLY accept heartbeats that name THIS routine. Transcripts (esp. retros)
    // quote other routines' ok/error lines; those must not steal the outcome.
    if (!nameMatchesRoutine(name, routineId)) continue;
    candidates.push({
      kind,
      detail,
      source: "heartbeat",
      score: 80,
      index: m.index ?? 0,
    });
  }

  // Prefer highest score; tie-break: latest in the log (highest index).
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score || b.index - a.index);
    const best = candidates[0]!;
    return { kind: best.kind, detail: best.detail, source: best.source };
  }

  // Smoke harness probes: "SMOKE_OK harness=claude" (often buried in stream-json).
  const smoke = text.match(/\bSMOKE_OK(?:\s+harness=([A-Za-z0-9._-]+))?/i);
  if (smoke && (opts.exitCode === 0 || opts.exitCode === undefined)) {
    const harness = smoke[1] ? ` harness=${smoke[1]}` : "";
    return {
      kind: "ok",
      detail: clip(`SMOKE_OK${harness}`),
      source: "heartbeat",
    };
  }

  // Claude Code stream-json final event (when the agent forgot a heartbeat line).
  // Last {"type":"result","subtype":"success","is_error":false,...} wins.
  if (opts.exitCode === 0 || opts.exitCode === undefined) {
    let lastClaude: { ok: boolean; detail: string | null } | null = null;
    const re =
      /"type"\s*:\s*"result"[\s\S]{0,1200}?"subtype"\s*:\s*"(success|error)"[\s\S]{0,400}?"is_error"\s*:\s*(true|false)/g;
    for (const m of text.matchAll(re)) {
      const ok = m[1] === "success" && m[2] === "false";
      lastClaude = { ok, detail: ok ? "claude stream-json success" : "claude stream-json error" };
    }
    if (lastClaude?.ok) {
      // Optional: pull a short prose summary from the last "result":"..." string.
      const tail = text.slice(Math.max(0, text.length - 12000));
      const resultM = [...tail.matchAll(/"result"\s*:\s*"((?:\\.|[^"\\]){0,200})"/g)].pop();
      if (resultM) {
        try {
          lastClaude.detail = clip(JSON.parse(`"${resultM[1]}"`));
        } catch {
          lastClaude.detail = clip(resultM[1]!.split("\\n").join(" "));
        }
      }
      return { kind: "ok", detail: lastClaude.detail, source: "heartbeat" };
    }
  }

  // Exit-based fallback — only for hard failures. Exit 0 alone is unknown
  // (could be useful or noop; we refuse to guess).
  if (opts.timedOut) {
    return { kind: "error", detail: "timed out", source: "exit" };
  }
  if (opts.exitCode !== undefined && opts.exitCode !== null && opts.exitCode !== 0) {
    return {
      kind: "error",
      detail: `exit ${opts.exitCode}`,
      source: "exit",
    };
  }

  return { kind: "unknown", detail: null, source: "none" };
}

function isFalsePositiveName(name: string): boolean {
  const n = name.toLowerCase();
  // stream-json / shell noise that can precede "ok"
  const ban = new Set([
    "type",
    "status",
    "result",
    "subtype",
    "message",
    "exit",
    "code",
    "state",
    "outcome",
    "error",
    "level",
    "success",
    "failed",
    "true",
    "false",
    "null",
    "stdout",
    "stderr",
    "return",
    "statuscode",
  ]);
  return ban.has(n);
}

function parseHeartbeatPhrase(
  phrase: string,
  routineId: string,
): Omit<Candidate, "source" | "index"> | null {
  // "name ISO ok detail" or "name ok detail"
  const m = phrase.match(
    /^\s*([A-Za-z][A-Za-z0-9._-]{2,80})\s+(?:\d{4}-\d{2}-\d{2}T\S+\s+)?(ok|noop|error)\b(.*)$/i,
  );
  if (!m) return null;
  const name = m[1]!;
  const kind = asKind(m[2]!);
  if (!kind) return null;
  const detail = clip(m[3] ?? "") || null;
  const matched = nameMatchesRoutine(name, routineId);
  // Unmatched names inside --line are still suspicious (wrong copy-paste); only
  // accept a weak score when the name at least looks like a routine slug.
  if (!matched && !name.includes("-")) return null;
  return {
    kind,
    detail,
    score: matched ? 85 : 45,
  };
}

/** Aggregate counts + rates over a window of outcomes (most-recent first ok). */
export function aggregateOutcomes(outcomes: readonly RunOutcome[]): OutcomeStats {
  const stats: OutcomeStats = {
    n: outcomes.length,
    ok: 0,
    noop: 0,
    error: 0,
    unknown: 0,
    noopRate: null,
    usefulRate: null,
  };
  for (const o of outcomes) {
    if (o.kind === "ok") stats.ok++;
    else if (o.kind === "noop") stats.noop++;
    else if (o.kind === "error") stats.error++;
    else stats.unknown++;
  }
  const clean = stats.ok + stats.noop;
  if (clean > 0) {
    stats.noopRate = stats.noop / clean;
    stats.usefulRate = stats.ok / clean;
  }
  return stats;
}

/** Rehydrate an outcome stored on meta.json (missing fields → unknown). */
export function outcomeFromMeta(meta: Record<string, unknown>): RunOutcome {
  const kindRaw = typeof meta.outcome === "string" ? meta.outcome : "unknown";
  const kind: OutcomeKind =
    kindRaw === "ok" || kindRaw === "noop" || kindRaw === "error" || kindRaw === "unknown"
      ? kindRaw
      : "unknown";
  const detail = typeof meta.outcomeDetail === "string" ? meta.outcomeDetail : null;
  const sourceRaw = typeof meta.outcomeSource === "string" ? meta.outcomeSource : "none";
  const source: OutcomeSource =
    sourceRaw === "routine_result" ||
    sourceRaw === "heartbeat" ||
    sourceRaw === "exit" ||
    sourceRaw === "none"
      ? sourceRaw
      : "none";
  return { kind, detail, source };
}
