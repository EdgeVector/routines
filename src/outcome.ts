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
  | "useful_work" // routine-specific concrete work evidence in the transcript
  | "safe_skip" // known successful skip transcript from a bounded maintenance routine
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

const BENIGN_HARNESS_NOISE_LINES: RegExp[] = [
  /^\s*ERROR\s+codex_models_manager::manager:\s+failed to renew cache TTL:\s+missing field supports_reasoning_summaries\b.*$/i,
];

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
  "north-star-rollup": "last-stack-north-star-rollup",
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

export function filterBenignHarnessNoise(text: string): string {
  if (!text) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !BENIGN_HARNESS_NOISE_LINES.some((re) => re.test(line)))
    .join("\n");
}

/**
 * Explicit machine trailer (strongest). Deliberately NOT anchored to
 * start-of-line: under the Claude stream-json harness, an agent's own final
 * text is a JSON string value ({"type":"assistant",...,"text":"...\nROUTINE_
 * RESULT outcome=ok..."}) — internal newlines are JSON-escaped as literal
 * `\n`, not real line breaks, so a genuine trailer almost never sits at a
 * real line start. Line-anchoring here silently makes every Claude-harness
 * ROUTINE_RESULT undetectable (falls through to "unknown"). Cross-run
 * contamination (a tool_result quoting another run's trailer) is guarded by
 * stripToolResultPayloads() below instead, which is structure-aware rather
 * than position-aware.
 */
const ROUTINE_RESULT_RE =
  /ROUTINE_RESULT\s+outcome\s*=\s*(ok|noop|error)(?=$|[\s;\n\r])([^;\n\r]*)/gim;

/**
 * Compact agent trailer used by some project prompts:
 *   RESULT: noop reason=DASHBOARD_SKIP ...
 *   RESULT: ok filed=1
 */
const RESULT_COLON_RE =
  /^[^\S\r\n]*RESULT:\s*(ok|noop|error)\b([^\n\r]*)/gim;

/**
 * Heartbeat-style lines, including:
 *   groom-board 2026-07-13T12:34:00Z ok closed-review-1
 *   kanban-pickup 2026-07-13T13:06:03Z noop cards=0
 *   kanban-validate <ISO-ts> noop no-candidates
 * and quoted forms inside --line "..."
 * Group 2 is the optional ISO timestamp (used to drop pre-run memory dumps).
 */
const HEARTBEAT_LINE_RE =
  /(?:^|[\s"'`])([A-Za-z][A-Za-z0-9._-]{2,80})\s+(?:(\d{4}-\d{2}-\d{2}T[^\s"']+)\s+)?(ok|noop|error)\b([^\n\r"']*)/gim;

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
  /** Optional ISO timestamp embedded in the heartbeat line (ms since epoch). */
  tsMs: number | null;
}

/** Parse a heartbeat ISO stamp into epoch ms, or null if unparseable. */
function heartbeatTsMs(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * True when a heartbeat ISO is older than the run's startedAt (with a small
 * skew allowance). Historical lines dumped from memory.md must not win.
 */
function isPreRunHeartbeat(
  tsMs: number | null,
  startedAtMs: number | null,
): boolean {
  if (tsMs == null || startedAtMs == null) return false;
  // 2 minutes of clock skew so a heartbeat stamped slightly before meta.startedAt still counts.
  return tsMs < startedAtMs - 120_000;
}

/**
 * Stream-json harnesses (Claude) wrap every turn in a JSONL envelope. A
 * `"type":"user"` line's content is a tool_result — data a prior Bash/kanban/
 * brain call RETURNED, not anything this run's own agent said. Routines that
 * research past incidents (daily-retro-prevention, routine-error-triage) very
 * often `kanban show`/`brain get` a card whose body itself quotes a literal
 * `ROUTINE_RESULT outcome=ok ...` string as evidence about a DIFFERENT run.
 * That quoted text must not be readable as *this* run's own result. Lines
 * that aren't valid single-line JSON (plain-text harnesses, stderr) pass
 * through unchanged — there's no tool_result structure to strip there.
 */
function stripToolResultPayloads(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      out.push(line);
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      out.push(line);
      continue;
    }
    const type = (obj as { type?: unknown } | null)?.type;
    if (type === "user") continue; // tool_result envelope — quoted data, not this agent's speech
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Parse the best outcome signal from combined harness output.
 * @param routineId registry id (used to prefer matching heartbeat names)
 * @param text stdout + stderr (order does not matter; we scan all)
 * @param opts.exitCode / timedOut for exit-based fallback
 * @param opts.startedAt ISO start of this run — heartbeats stamped earlier are ignored
 * @param opts.incomplete when true (live in-progress run), skip bare heartbeat
 *   lines that typically come from dumping memory.md; only trust strong trailers
 *   / explicit append-heartbeat commands so the dashboard cannot go red mid-run
 *   from historical memory.
 */
export function parseOutcome(
  routineId: string,
  text: string,
  opts: {
    exitCode?: number | null;
    timedOut?: boolean;
    startedAt?: string | null;
    incomplete?: boolean;
  } = {},
): RunOutcome {
  text = filterBenignHarnessNoise(text);
  const candidates: Candidate[] = [];
  const startedAtMs = heartbeatTsMs(opts.startedAt ?? null);
  // Highest-confidence, unscoped-by-name signals: only trust these from the
  // agent's own speech, never from a quoted tool_result (see
  // stripToolResultPayloads doc comment).
  const ownText = stripToolResultPayloads(text);

  for (const m of ownText.matchAll(ROUTINE_RESULT_RE)) {
    const kind = asKind(m[1]!);
    if (!kind) continue;
    const rest = clip(m[2] ?? "");
    // prefer detail=... if present
    const detailM = rest.match(/\bdetail\s*=\s*(.+)$/i);
    const detail = detailM ? clip(detailM[1]!) : rest || null;
    // Prompt fixtures / prose about the trailer format must not win.
    if (isPromptFixtureDetail(detail)) continue;
    candidates.push({
      kind,
      detail,
      source: "routine_result",
      score: 100,
      index: m.index ?? 0,
      tsMs: null,
    });
  }

  for (const m of ownText.matchAll(RESULT_COLON_RE)) {
    const kind = asKind(m[1]!);
    if (!kind) continue;
    const rest = clip(m[2] ?? "");
    if (isPromptFixtureDetail(rest)) continue;
    candidates.push({
      kind,
      detail: rest || null,
      source: "routine_result",
      score: 95,
      index: m.index ?? 0,
      tsMs: null,
    });
  }

  for (const m of text.matchAll(APPEND_LINE_RE)) {
    const inner = m[1] ?? "";
    const parsed = parseHeartbeatPhrase(inner, routineId);
    if (parsed) {
      if (isPreRunHeartbeat(parsed.tsMs, startedAtMs)) continue;
      candidates.push({
        ...parsed,
        source: "heartbeat",
        score: parsed.score + 10, // prefer explicit append-heartbeat
        index: m.index ?? 0,
      });
    }
  }

  // Incomplete/live runs: agents almost always `sed`/`cat` memory.md first,
  // which re-injects every historical heartbeat. Do not classify from those
  // bare lines until the run finishes (meta.outcome) or the agent emits a
  // strong trailer / append-heartbeat.
  if (!opts.incomplete) {
    for (const m of text.matchAll(HEARTBEAT_LINE_RE)) {
      const name = m[1]!;
      const tsMs = heartbeatTsMs(m[2] ?? null);
      const kind = asKind(m[3]!);
      if (!kind) continue;
      // reject common false positives
      if (isFalsePositiveName(name)) continue;
      const detail = clip(m[4] ?? "") || null;
      // ONLY accept heartbeats that name THIS routine. Transcripts (esp. retros)
      // quote other routines' ok/error lines; those must not steal the outcome.
      if (!nameMatchesRoutine(name, routineId)) continue;
      if (isPreRunHeartbeat(tsMs, startedAtMs)) continue;
      candidates.push({
        kind,
        detail,
        source: "heartbeat",
        // Prefer timestamped heartbeats over bare ones; same-score later uses ts.
        score: tsMs != null ? 82 : 80,
        index: m.index ?? 0,
        tsMs,
      });
    }
  }

  // Prefer highest score; tie-break: newest heartbeat ISO, then latest in log.
  if (candidates.length > 0) {
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        (b.tsMs ?? -1) - (a.tsMs ?? -1) ||
        b.index - a.index,
    );
    const best = candidates[0]!;
    const diskReclaimUsefulWork = parseDiskReclaimUsefulWork(routineId, text, opts, best);
    if (diskReclaimUsefulWork) return diskReclaimUsefulWork;
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

  const safeSkip = parseKnownSafeSkip(routineId, text, opts);
  if (safeSkip) return safeSkip;

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

function parseDiskReclaimUsefulWork(
  routineId: string,
  text: string,
  opts: { exitCode?: number | null; timedOut?: boolean },
  best: Candidate,
): RunOutcome | null {
  if (!nameMatchesRoutine("disk-reclaim", routineId)) return null;
  if (best.kind !== "noop") return null;
  if (opts.timedOut) return null;
  if (opts.exitCode !== undefined && opts.exitCode !== null && opts.exitCode !== 0) return null;

  const evidence = diskReclaimEvidence(text);
  if (!evidence) return null;

  const prior = best.detail ? `; prior-noop=${best.detail}` : "";
  return {
    kind: "ok",
    detail: clip(`disk-reclaim useful-work: ${evidence}${prior}`),
    source: "useful_work",
  };
}

function diskReclaimEvidence(text: string): string | null {
  const completion = text.search(/\bdisk reclaim completed\b/i);
  const nextCompletion =
    completion >= 0
      ? text.slice(completion + 1).search(/\bdisk reclaim completed\b/i)
      : -1;
  const end =
    completion >= 0 && nextCompletion >= 0
      ? completion + 1 + nextCompletion
      : completion >= 0
        ? completion + 2_000
        : text.length;
  const haystack = completion >= 0 ? text.slice(completion, end) : text;
  const reclaimed = firstPositiveNumber(
    haystack,
    /\breclaimed\s+(?:about\s+)?([0-9]+(?:\.[0-9]+)?)\s*(?:gib|gb|g)\b/gi,
  );
  if (reclaimed !== null) return `reclaimed=${formatGiB(reclaimed)}GiB`;

  const raised = firstPositiveDelta(
    haystack,
    /\b(?:raised|increased|moved)\b[\s\S]{0,120}?\bfrom\s+`?([0-9]+(?:\.[0-9]+)?)\s*(?:gib|gb|g)\s+free`?\s+\bto\s+`?([0-9]+(?:\.[0-9]+)?)\s*(?:gib|gb|g)\s+free`?/gi,
  );
  if (raised !== null) return `free-space-delta=${formatGiB(raised)}GiB`;

  const upFrom = firstPositiveDelta(
    haystack,
    /\bfree space\b[\s\S]{0,120}?\b(?:up|raised)\s+from\s+`?([0-9]+(?:\.[0-9]+)?)\s*(?:gib|gb|g)`?[\s\S]{0,80}?\b(?:to|now)\s+`?([0-9]+(?:\.[0-9]+)?)\s*(?:gib|gb|g)`?/gi,
  );
  if (upFrom !== null) return `free-space-delta=${formatGiB(upFrom)}GiB`;

  const pruned = firstPositiveNumber(
    haystack,
    /\b(?:pruned|removed|deleted)\s+([1-9][0-9]*)\b[^\n\r]{0,120}?\bworktrees?\b/gi,
  );
  if (pruned !== null) return `worktrees-removed=${Math.trunc(pruned)}`;

  return null;
}

function firstPositiveNumber(text: string, re: RegExp): number | null {
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function firstPositiveDelta(text: string, re: RegExp): number | null {
  for (const m of text.matchAll(re)) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) return to - from;
  }
  return null;
}

function formatGiB(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

function parseKnownSafeSkip(
  routineId: string,
  text: string,
  opts: { exitCode?: number | null; timedOut?: boolean },
): RunOutcome | null {
  const codexCapacity = parseCodexHarnessCapacitySkip(text, opts);
  if (codexCapacity) return codexCapacity;

  if (routineId !== "codex-stale-agent-memory-cleanup") return null;
  if (opts.timedOut) return null;
  if (opts.exitCode !== undefined && opts.exitCode !== null && opts.exitCode !== 0) return null;

  const lower = text.toLowerCase();
  if (!lower.includes("cleanup pass completed")) return null;
  if (!lower.includes("terminated pids/processes: none")) return null;
  if (
    !lower.includes("process enumeration was blocked") &&
    !lower.includes("cannot get process list")
  ) {
    return null;
  }

  return {
    kind: "noop",
    detail: "process-enumeration-blocked terminated=0",
    source: "safe_skip",
  };
}

function parseCodexHarnessCapacitySkip(
  text: string,
  opts: { exitCode?: number | null; timedOut?: boolean },
): RunOutcome | null {
  if (opts.timedOut) return null;

  const lower = text.toLowerCase();
  const externalBlocker =
    lower.includes("selected model is at capacity") ||
    lower.includes("you've hit your usage limit") ||
    lower.includes("you have hit your usage limit") ||
    lower.includes("usage limit");
  if (!externalBlocker) return null;

  // Once a worker has visibly claimed work or published a review artifact,
  // the routine contract requires normal rollback/handoff handling. Treat the
  // harness-only capacity path as a clean noop only when there is no durable
  // evidence that work left the unclaimed state.
  const claimedOrPublished =
    /"claimed"\s*:\s*true/i.test(text) ||
    /\bclaimed=true\b/i.test(text) ||
    /\breason=claimed\b/i.test(text) ||
    /\bpr_url\b/i.test(text) ||
    /\bPR:\s*(?:https?:\/\/|lastgit:\/\/)/i.test(text) ||
    /\bpr=(?:https?:\/\/|lastgit:\/\/)/i.test(text);
  if (claimedOrPublished) return null;

  return {
    kind: "noop",
    detail: "codex-capacity no_card_claimed",
    source: "safe_skip",
  };
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

/**
 * Prompt / docs text that mentions the trailer format without being a real
 * machine result (e.g. "example-from-prompt fixture from the Codex stderr").
 */
function isPromptFixtureDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const d = detail.toLowerCase();
  return (
    d.includes("example-from-prompt") ||
    d.includes("example only") ||
    d.includes("bites=<n>") ||
    d.includes("cards=<n>") ||
    /\bplaceholder\b/.test(d) ||
    /\bprompt fixture\b/.test(d) ||
    /\bfrom the (codex|claude) stderr diff\b/.test(d)
  );
}

function parseHeartbeatPhrase(
  phrase: string,
  routineId: string,
): Omit<Candidate, "source" | "index"> | null {
  // "name ISO ok detail", "name $iso_ts ok detail", or "name ok detail".
  // The append-line scanner sees the shell command before variable expansion.
  const m = phrase.match(
    /^\s*([A-Za-z][A-Za-z0-9._-]{2,80})\s+(?:(?!ok\b|noop\b|error\b)(\S+)\s+)?(ok|noop|error)\b(.*)$/i,
  );
  if (!m) return null;
  const name = m[1]!;
  const maybeIso = m[2] ?? null;
  const kind = asKind(m[3]!);
  if (!kind) return null;
  const detail = clip(m[4] ?? "") || null;
  const matched = nameMatchesRoutine(name, routineId);
  if (!matched) return null;
  const tsMs =
    maybeIso && /^\d{4}-\d{2}-\d{2}T/.test(maybeIso) ? heartbeatTsMs(maybeIso) : null;
  return {
    kind,
    detail,
    score: 85,
    tsMs,
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
    sourceRaw === "useful_work" ||
    sourceRaw === "safe_skip" ||
    sourceRaw === "exit" ||
    sourceRaw === "none"
      ? sourceRaw
      : "none";
  return { kind, detail, source };
}
