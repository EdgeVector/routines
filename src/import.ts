// One-time migration: import the two LEGACY schedulers into the routines
// registry.
//
// Sources (enumerate the DIRECTORY / live registry, never a possibly-stale
// fbrain doc — see the card CONTEXT and codex-automation-registry-edgevector):
//   1. ~/.codex/automations/*/automation.toml   — Codex internal cron. Only the
//      ACTIVE ones are live; PAUSED ones are already off and are skipped.
//   2. Claude scheduled-tasks.json               — the Claude-side scheduler's
//      registry (discovered under ~/Library/Application Support/Claude/...).
//      Only `enabled` recurring tasks are live; disabled + one-shot `fireAt`
//      reminders are skipped.
//
// The import is a right-sized one-time migration (no shipped back-compat). It
// PRESERVES each routine's prompt / rrule / model / cwd / harness faithfully,
// with two normalizations that are required for the entries to actually parse
// and dispatch:
//   - a stray "RRULE:" content-line prefix (some Codex automations carry one)
//     is stripped so the value is a bare RFC 5545 recurrence;
//   - 5-field cron expressions from Claude tasks are converted to the same
//     RRULE dialect the registry + rrule.ts already speak.
//
// The DUAL-SCHEDULER hazard is real (papercut-phantom-program-rollup-churn):
// many routines are scheduled in BOTH legacy schedulers under different ids
// (e.g. Claude `program-driver` and Codex `last-stack-program-driver` are the
// same loop). If both entries were imported and activated, routines would
// itself double-fire that loop after the legacy schedulers are paused. So the
// planner detects cross-scheduler duplicates by a normalized routine name and,
// by default, keeps ONE per group (Codex wins — credits moved to Codex
// 2026-06-25) and marks the rest skip-duplicate. Every collapsed group is shown
// in the diff table so a human resolves routing before the live cutover.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type { Harness, Status } from "./registry.ts";
import { canonicalRoutineId } from "./kanban-id-migration.ts";
import { parseRRule } from "./rrule.ts";

export interface ImportCandidate {
  id: string;
  /** Original legacy scheduler id before routines registry canonicalization. */
  sourceId?: string;
  source: "codex" | "claude";
  sourcePath: string;
  harness: Harness;
  model: string;
  effort?: string;
  rrule: string;
  cwd: string;
  status: Status;
  /** Inline prompt (Codex automations store the dispatched prompt inline). */
  prompt?: string;
  /** Prompt file (Claude tasks point at their SKILL.md). */
  promptPath?: string;
  timeoutMin: number;
  /** Normalized routine name used for cross-scheduler duplicate detection. */
  normName: string;
  action: "create" | "skip-duplicate";
  /** Human-readable note (why skipped, which entry it duplicates, etc.). */
  note?: string;
}

export interface SkippedSource {
  id: string;
  source: "codex" | "claude";
  reason: string;
}

export interface ImportPlan {
  /** Candidates that WOULD be written (action=create) plus skipped duplicates. */
  candidates: ImportCandidate[];
  /** Live-but-not-imported sources (paused/disabled/one-shot/unparseable). */
  skipped: SkippedSource[];
  /** Cross-scheduler duplicate groups. Each id is tagged with its source
   * because the two legacy schedulers sometimes use the SAME id for the same
   * routine (e.g. `dogfood-rotate` in both). */
  duplicates: {
    normName: string;
    kept: { id: string; source: "codex" | "claude" };
    dropped: { id: string; source: "codex" | "claude" }[];
  }[];
  prefer: "codex" | "claude";
}

export interface PlanOptions {
  codexDir?: string;
  claudeRegistry?: string | null;
  claudeModel?: string;
  prefer?: "codex" | "claude";
  keepDuplicates?: boolean;
}

// --- cron -> RRULE ---------------------------------------------------------

// Convert a 5-field cron expression ("min hour dom mon dow") to the RRULE
// dialect rrule.ts understands. We deliberately expand */step and comma lists
// into explicit BY* value lists rather than leaning on INTERVAL anchoring, so
// the result is unambiguous and DST-stable (matches how the Codex automations
// already hand-write their rrules, e.g. explicit BYHOUR lists).
export function cronToRRule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`unsupported cron (need 5 fields, got ${parts.length}): ${JSON.stringify(expr)}`);
  }
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (dom !== "*") throw new Error(`unsupported cron day-of-month ${JSON.stringify(dom)} (only * supported): ${expr}`);
  if (mon !== "*") throw new Error(`unsupported cron month ${JSON.stringify(mon)} (only * supported): ${expr}`);

  const minutes = expandCronField(min, 0, 59, "minute");
  const hourStar = hour === "*";
  const hours = hourStar ? [] : expandCronField(hour, 0, 23, "hour");
  const days = dow === "*" ? [] : expandCronDow(dow);

  const segs: string[] = [];
  if (days.length > 0) {
    segs.push("FREQ=WEEKLY");
    segs.push(`BYDAY=${days.join(",")}`);
    if (!hourStar) segs.push(`BYHOUR=${hours.join(",")}`);
    segs.push(`BYMINUTE=${minutes.join(",")}`);
  } else if (hourStar) {
    segs.push("FREQ=HOURLY");
    segs.push(`BYMINUTE=${minutes.join(",")}`);
  } else {
    segs.push("FREQ=DAILY");
    segs.push(`BYHOUR=${hours.join(",")}`);
    segs.push(`BYMINUTE=${minutes.join(",")}`);
  }
  segs.push("BYSECOND=0");
  const rrule = segs.join(";");
  parseRRule(rrule); // fail loudly if we produced something invalid
  return rrule;
}

function expandCronField(field: string, lo: number, hi: number, name: string): number[] {
  const set = new Set<number>();
  for (const tok of field.split(",")) {
    const t = tok.trim();
    if (t.length === 0) continue;
    const stepM = /^(\*|\d+-\d+)\/(\d+)$/.exec(t);
    if (t === "*") {
      for (let i = lo; i <= hi; i++) set.add(i);
    } else if (stepM) {
      const step = Number(stepM[2]);
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad ${name} step ${JSON.stringify(t)}`);
      let rlo = lo;
      let rhi = hi;
      if (stepM[1] !== "*") {
        const [a, b] = stepM[1]!.split("-").map(Number) as [number, number];
        rlo = a;
        rhi = b;
      }
      for (let i = rlo; i <= rhi; i += step) set.add(i);
    } else if (/^\d+-\d+$/.test(t)) {
      const [a, b] = t.split("-").map(Number) as [number, number];
      for (let i = a; i <= b; i++) set.add(i);
    } else if (/^\d+$/.test(t)) {
      set.add(Number(t));
    } else {
      throw new Error(`unsupported ${name} cron token ${JSON.stringify(t)}`);
    }
  }
  const out = [...set].filter((n) => n >= lo && n <= hi).sort((a, b) => a - b);
  if (out.length === 0) throw new Error(`empty ${name} field ${JSON.stringify(field)}`);
  return out;
}

const CRON_DOW: Record<string, string> = {
  "0": "SU",
  "1": "MO",
  "2": "TU",
  "3": "WE",
  "4": "TH",
  "5": "FR",
  "6": "SA",
  "7": "SU",
  SUN: "SU",
  MON: "MO",
  TUE: "TU",
  WED: "WE",
  THU: "TH",
  FRI: "FR",
  SAT: "SA",
};

function expandCronDow(field: string): string[] {
  const out = new Set<string>();
  for (const tok of field.split(",")) {
    const t = tok.trim().toUpperCase();
    if (t.length === 0) continue;
    if (/^\d+-\d+$/.test(t)) {
      const [a, b] = t.split("-").map(Number) as [number, number];
      for (let i = a; i <= b; i++) {
        const code = CRON_DOW[String(i)];
        if (!code) throw new Error(`bad cron weekday ${i}`);
        out.add(code);
      }
    } else {
      const code = CRON_DOW[t];
      if (!code) throw new Error(`unsupported cron weekday ${JSON.stringify(t)}`);
      out.add(code);
    }
  }
  if (out.size === 0) throw new Error(`empty weekday field ${JSON.stringify(field)}`);
  // Order SU..SA for stable output.
  const order = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  return order.filter((d) => out.has(d));
}

// --- normalizations --------------------------------------------------------

/** Strip a leading "RRULE:" (some Codex automations store it as a content
 * line with the property-name prefix). */
export function normalizeRRule(raw: string): string {
  return raw.trim().replace(/^RRULE:/i, "").trim();
}

// Curated synonyms for cross-scheduler duplicate detection where prefix
// stripping alone does not collapse the pair. Left = post-prefix-strip form of
// the id in one scheduler, right = canonical (the other scheduler's form).
const NORM_SYNONYMS: Record<string, string> = {
  "consolidate-fbrain": "consolidate-brain",
  "fkanban-pickup": "kanban-pickup",
  "fkanban-watch": "kanban-watch",
  "fkanban-validate": "kanban-validate",
  "groom-fkanban-board": "groom-board",
  "agent-papercut-sweep": "papercut-sweep",
  "clean-up-stale-worktrees": "worktree-cleanup",
};

/** Normalized routine name for cross-scheduler duplicate detection. Heuristic:
 * lowercase, drop the `last-stack-` / `daily-` scheduler prefixes, then apply a
 * small curated synonym map for the known non-obvious pairs. */
export function normName(id: string): string {
  let s = id.toLowerCase();
  s = s.replace(/^last-stack-/, "").replace(/^daily-/, "");
  return NORM_SYNONYMS[s] ?? s;
}

// --- codex automation.toml (tolerant scalar reader) ------------------------

// The registry's own toml.ts is deliberately strict (rejects arrays / inline
// tables). Codex automation.toml files carry `cwds = [...]` and
// `target = {...}`, so we read them with a focused, tolerant scalar extractor
// that only pulls the keys we care about and ignores the rest.
export interface CodexAutomation {
  id: string;
  status: string;
  rrule: string;
  model: string;
  effort?: string;
  prompt: string;
  cwd: string;
  sourcePath: string;
}

function readTopLevelScalar(text: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^${key}\\s*=\\s*(.*)$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    return parseTomlScalarRhs(m[1]!);
  }
  return undefined;
}

// Parse the RHS of a `key = <rhs>` line into a string. Handles basic strings
// ("..."), literal strings ('...'), the first element of a string array
// (["a", ...] -> "a"), and bare tokens (numbers/bools returned as text).
function parseTomlScalarRhs(rhs0: string): string {
  const rhs = rhs0.trim();
  if (rhs.startsWith('"')) return parseBasic(rhs);
  if (rhs.startsWith("'")) return parseLiteral(rhs);
  if (rhs.startsWith("[")) {
    // first string element of an inline array
    const inner = rhs.slice(1);
    const t = inner.trimStart();
    if (t.startsWith('"')) return parseBasic(t);
    if (t.startsWith("'")) return parseLiteral(t);
    return "";
  }
  // bare token up to a comment
  const hash = rhs.indexOf("#");
  return (hash >= 0 ? rhs.slice(0, hash) : rhs).trim();
}

function parseBasic(s: string): string {
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\") {
      const n = s[i + 1];
      i++;
      switch (n) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        default:
          out += n ?? "";
      }
      continue;
    }
    if (ch === '"') return out;
    out += ch;
  }
  return out; // unterminated — return what we have
}

function parseLiteral(s: string): string {
  const end = s.indexOf("'", 1);
  return end < 0 ? s.slice(1) : s.slice(1, end);
}

export function parseCodexAutomation(text: string, sourcePath: string): CodexAutomation | null {
  const id = readTopLevelScalar(text, "id");
  const status = readTopLevelScalar(text, "status");
  const rruleRaw = readTopLevelScalar(text, "rrule");
  const model = readTopLevelScalar(text, "model");
  const prompt = readTopLevelScalar(text, "prompt");
  const effort = readTopLevelScalar(text, "reasoning_effort");
  const cwd = readTopLevelScalar(text, "cwds") ?? readTopLevelScalar(text, "cwd");
  if (!id || !status || !rruleRaw || !model || !prompt) return null;
  const auto: CodexAutomation = {
    id,
    status,
    rrule: normalizeRRule(rruleRaw),
    model,
    prompt,
    cwd: cwd ?? process.cwd(),
    sourcePath,
  };
  if (effort) auto.effort = effort;
  return auto;
}

export function readCodexAutomations(dir: string): { active: CodexAutomation[]; skipped: SkippedSource[] } {
  const active: CodexAutomation[] = [];
  const skipped: SkippedSource[] = [];
  if (!existsSync(dir)) return { active, skipped };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(dir, entry.name, "automation.toml");
    if (!existsSync(p)) continue;
    let auto: CodexAutomation | null;
    try {
      auto = parseCodexAutomation(readFileSync(p, "utf8"), p);
    } catch (err) {
      skipped.push({ id: entry.name, source: "codex", reason: `parse error: ${(err as Error).message}` });
      continue;
    }
    if (!auto) {
      skipped.push({ id: entry.name, source: "codex", reason: "missing required fields (not a cron automation?)" });
      continue;
    }
    if (auto.status.toUpperCase() !== "ACTIVE") {
      skipped.push({ id: auto.id, source: "codex", reason: `status=${auto.status} (not ACTIVE)` });
      continue;
    }
    active.push(auto);
  }
  return { active, skipped };
}

// --- claude scheduled-tasks.json -------------------------------------------

interface ClaudeTask {
  id: string;
  enabled?: boolean;
  cronExpression?: string;
  fireAt?: number;
  filePath?: string;
  cwd?: string;
}

/** Discover the Claude scheduler registry under Application Support. The path
 * embeds session UUIDs, so we glob rather than hard-code. Returns the first
 * match (there is one live registry per install). */
export function discoverClaudeRegistry(home = homedir()): string | null {
  const root = join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
  if (!existsSync(root)) return null;
  for (const l1 of safeReaddir(root)) {
    const d1 = join(root, l1);
    for (const l2 of safeReaddir(d1)) {
      const p = join(d1, l2, "scheduled-tasks.json");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function readClaudeTasks(
  registryPath: string,
  claudeModel: string,
): { candidates: Omit<ImportCandidate, "action" | "normName">[]; skipped: SkippedSource[] } {
  const candidates: Omit<ImportCandidate, "action" | "normName">[] = [];
  const skipped: SkippedSource[] = [];
  const raw = JSON.parse(readFileSync(registryPath, "utf8")) as { scheduledTasks?: ClaudeTask[] };
  for (const t of raw.scheduledTasks ?? []) {
    if (!t.enabled) {
      skipped.push({ id: t.id, source: "claude", reason: "disabled" });
      continue;
    }
    if (!t.cronExpression) {
      skipped.push({
        id: t.id,
        source: "claude",
        reason: t.fireAt ? "one-shot fireAt reminder (not a recurring routine)" : "no cronExpression",
      });
      continue;
    }
    let rrule: string;
    try {
      rrule = cronToRRule(t.cronExpression);
    } catch (err) {
      skipped.push({ id: t.id, source: "claude", reason: `cron unconvertible: ${(err as Error).message}` });
      continue;
    }
    const cand: Omit<ImportCandidate, "action" | "normName"> = {
      id: t.id,
      source: "claude",
      sourcePath: registryPath,
      harness: "claude",
      model: claudeModel,
      rrule,
      cwd: t.cwd ?? process.cwd(),
      status: "active",
      timeoutMin: 30,
    };
    // The Claude scheduler stores no per-task prompt inline; the task's SKILL.md
    // IS the routine. Preserve it faithfully via prompt_path.
    if (t.filePath) cand.promptPath = t.filePath;
    else cand.prompt = `Run the scheduled routine ${t.id}.`;
    candidates.push(cand);
  }
  return { candidates, skipped };
}

// --- planning --------------------------------------------------------------

export function planImport(opts: PlanOptions = {}): ImportPlan {
  const codexDir = opts.codexDir ?? join(homedir(), ".codex", "automations");
  const claudeRegistry = opts.claudeRegistry === undefined ? discoverClaudeRegistry() : opts.claudeRegistry;
  const claudeModel = opts.claudeModel ?? "sonnet";
  const prefer = opts.prefer ?? "codex";

  const skipped: SkippedSource[] = [];
  const raw: Omit<ImportCandidate, "action" | "normName">[] = [];

  const codex = readCodexAutomations(codexDir);
  skipped.push(...codex.skipped);
  for (const a of codex.active) {
    raw.push({
      id: a.id,
      source: "codex",
      sourcePath: a.sourcePath,
      harness: "codex",
      model: a.model,
      ...(a.effort ? { effort: a.effort } : {}),
      rrule: a.rrule,
      cwd: a.cwd,
      status: "active",
      prompt: a.prompt,
      timeoutMin: 30,
    });
  }

  if (claudeRegistry) {
    const claude = readClaudeTasks(claudeRegistry, claudeModel);
    skipped.push(...claude.skipped);
    raw.push(...claude.candidates);
  }

  // Attach normalized names.
  const withNorm: ImportCandidate[] = raw.map((c) => {
    const id = canonicalRoutineId(c.id);
    return { ...c, id, sourceId: c.id, normName: normName(id), action: "create" };
  });

  const duplicates: ImportPlan["duplicates"] = [];
  if (!opts.keepDuplicates) {
    const byNorm = new Map<string, ImportCandidate[]>();
    for (const c of withNorm) {
      const g = byNorm.get(c.normName) ?? [];
      g.push(c);
      byNorm.set(c.normName, g);
    }
    for (const [nn, group] of byNorm) {
      if (group.length < 2) continue;
      // Deterministic precedence: preferred source wins; ties keep the first.
      const preferred = group.find((c) => c.source === prefer) ?? group[0]!;
      const dropped: { id: string; source: "codex" | "claude" }[] = [];
      for (const c of group) {
        if (c === preferred) continue;
        c.action = "skip-duplicate";
        c.note = `duplicate of ${preferred.id} (${preferred.source}); resolve routing via \`routines route\`/\`pause\``;
        dropped.push({ id: c.id, source: c.source });
      }
      preferred.note = `kept; also scheduled as [${dropped.map((d) => `${d.id} (${d.source})`).join(", ")}] in the other scheduler`;
      duplicates.push({ normName: nn, kept: { id: preferred.id, source: preferred.source }, dropped });
    }
  }

  // Stable ordering: source, then id.
  withNorm.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  skipped.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  duplicates.sort((a, b) => a.normName.localeCompare(b.normName));

  return { candidates: withNorm, skipped, duplicates, prefer };
}

// --- rendering -------------------------------------------------------------

function escapeTomlBasic(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Serialize a create-candidate to a registry TOML file body. The output is
 * guaranteed to round-trip through registry.parseEntry (asserted in tests). */
export function renderToml(c: ImportCandidate): string {
  const lines: string[] = [];
  lines.push(`# Imported from ${c.source} (${c.sourcePath}) by \`routines import\`.`);
  if (c.note) lines.push(`# ${c.note}`);
  lines.push(`id = "${c.id}"`);
  lines.push(`harness = "${c.harness}"`);
  lines.push(`model = "${escapeTomlBasic(c.model)}"`);
  if (c.effort) lines.push(`effort = "${escapeTomlBasic(c.effort)}"`);
  lines.push(`rrule = "${escapeTomlBasic(c.rrule)}"`);
  lines.push(`cwd = "${escapeTomlBasic(c.cwd)}"`);
  lines.push(`status = "${c.status}"`);
  lines.push(`timeout_min = ${c.timeoutMin}`);
  if (c.promptPath !== undefined) {
    lines.push(`prompt_path = "${escapeTomlBasic(c.promptPath)}"`);
  } else {
    lines.push(`prompt = "${escapeTomlBasic(c.prompt ?? "")}"`);
  }
  return lines.join("\n") + "\n";
}

export function renderDiffTable(plan: ImportPlan): string {
  const create = plan.candidates.filter((c) => c.action === "create");
  const dup = plan.candidates.filter((c) => c.action === "skip-duplicate");
  const out: string[] = [];

  out.push(`routines import — plan (prefer: ${plan.prefer})`);
  out.push(`  ${create.length} to create · ${dup.length} skip-duplicate · ${plan.skipped.length} skip-inactive`);
  out.push("");

  out.push("WILL CREATE:");
  out.push(pad("  ID", 40) + pad("HARNESS/MODEL", 22) + "RRULE");
  for (const c of create) {
    out.push(pad("  " + c.id, 40) + pad(`${c.harness}/${c.model}`, 22) + c.rrule);
  }

  if (plan.duplicates.length > 0) {
    out.push("");
    out.push("⚠ CROSS-SCHEDULER DUPLICATES (heuristic — REVIEW before live cutover):");
    out.push("  Same routine scheduled in both legacy schedulers. Kept one to avoid");
    out.push("  routines double-firing it; the dropped id(s) are NOT imported.");
    const tag = (x: { id: string; source: string }) => `${x.id} (${x.source})`;
    for (const d of plan.duplicates) {
      out.push(`  - ${d.normName}: keep ${tag(d.kept)} · drop ${d.dropped.map(tag).join(", ")}`);
    }
  }

  if (plan.skipped.length > 0) {
    out.push("");
    out.push("SKIPPED (inactive/disabled/one-shot/unparseable — not live):");
    for (const s of plan.skipped) {
      out.push(`  - [${s.source}] ${s.id}: ${s.reason}`);
    }
  }
  return out.join("\n");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}

/** Filenames + bodies the plan would write (action=create only). */
export function planFiles(plan: ImportPlan): { file: string; body: string }[] {
  return plan.candidates
    .filter((c) => c.action === "create")
    .map((c) => ({ file: `${c.id}.toml`, body: renderToml(c) }));
}
