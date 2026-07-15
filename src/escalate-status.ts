// Resolve error-escalate + triage state for a failed routine run so the
// dashboard can show "taken care of" next to exit 124 / red runs.
//
// Evidence sources (all optional, never throws):
//   <runDir>/error-escalated.json     — written by error-escalate on failure
//   <runDir>/triage-result.json       — optional structured verdict from triage
//   runs/routine-error-triage/*/meta  — linked by failedRunDir / agent dir=
//   triage stdout heartbeat:
//     routine-error-triage <ISO> ok|error failed=<id> result=fixed|card-updated|blocked detail=...

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { runsDir } from "./paths.ts";

export const TRIAGE_ID = "routine-error-triage";

/** Machine verdict for how triage left the failure. */
export type TriageVerdict =
  | "fixed"
  | "card-updated"
  | "blocked"
  | "needs-human"
  | "running"
  | "unknown"
  | "not-dispatched"
  | "cooldown"
  | "dispatch-failed"
  | "disabled";

export interface EscalateStatus {
  escalated: true;
  at: string | null;
  cardSlug: string | null;
  cardOk: boolean | null;
  cardDetail: string | null;
  agentDetail: string | null;
  agentDispatched: boolean;
  triageDir: string | null;
  triagePid: number | null;
  triageRunning: boolean;
  triageFinishedAt: string | null;
  triageStatus: TriageVerdict;
  /** Short human-readable triage outcome / last heartbeat detail. */
  triageDetail: string | null;
  /** True when a human should look — missing card, blocked, or triage did not close the loop. */
  needsHuman: boolean;
  needsHumanReason: string | null;
}

interface EscalatedFile {
  at?: string;
  cardSlug?: string;
  cardOk?: boolean;
  cardDetail?: string;
  agent?: string;
  agentDispatched?: boolean;
  triageDir?: string;
  triagePid?: number | null;
}

interface TriageResultFile {
  finishedAt?: string;
  result?: string;
  needsHuman?: boolean;
  detail?: string;
  rootCause?: string;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Best-effort: true if pid exists (signal 0). */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parse `dispatched pid=6454 dir=/path/to/triage` style agent detail. */
export function parseAgentDispatchDetail(agent: string | null | undefined): {
  dispatched: boolean;
  pid: number | null;
  dir: string | null;
  cooldown: boolean;
  disabled: boolean;
  failed: boolean;
} {
  const a = (agent ?? "").trim();
  if (!a) {
    return {
      dispatched: false,
      pid: null,
      dir: null,
      cooldown: false,
      disabled: false,
      failed: false,
    };
  }
  const lower = a.toLowerCase();
  if (lower.includes("cooldown")) {
    return {
      dispatched: false,
      pid: null,
      dir: null,
      cooldown: true,
      disabled: false,
      failed: false,
    };
  }
  if (lower.includes("disabled") || lower.includes("dispatch disabled")) {
    return {
      dispatched: false,
      pid: null,
      dir: null,
      cooldown: false,
      disabled: true,
      failed: false,
    };
  }
  if (lower.startsWith("spawn triage:") || lower.startsWith("mkdir triage:")) {
    return {
      dispatched: false,
      pid: null,
      dir: null,
      cooldown: false,
      disabled: false,
      failed: true,
    };
  }
  const pidM = a.match(/\bpid=(\d+)\b/i);
  const dirM = a.match(/\bdir=(\S+)/i);
  const dispatched = lower.includes("dispatched") || Boolean(pidM || dirM);
  return {
    dispatched,
    pid: pidM ? Number(pidM[1]) : null,
    dir: dirM ? dirM[1]! : null,
    cooldown: false,
    disabled: false,
    failed: false,
  };
}

/**
 * Find the newest routine-error-triage run whose meta.failedRunDir matches.
 * Used when error-escalated.json lacks triageDir (older breadcrumbs).
 */
export function findTriageDirForFailedRun(failedRunDir: string): string | null {
  const root = join(runsDir(), TRIAGE_ID);
  if (!existsSync(root)) return null;
  let stamps: string[];
  try {
    stamps = readdirSync(root).sort().reverse();
  } catch {
    return null;
  }
  for (const stamp of stamps) {
    const dir = join(root, stamp);
    const meta = readJson(join(dir, "meta.json"));
    if (!meta) continue;
    if (typeof meta.failedRunDir === "string" && meta.failedRunDir === failedRunDir) {
      return dir;
    }
  }
  return null;
}

const HEARTBEAT_RE =
  /routine-error-triage\s+\S+\s+(ok|error)\s+failed=\S+\s+result=(fixed|card-updated|blocked|needs-human)\b(?:\s+detail=([^\n\r]*))?/gi;

/** Parse last triage heartbeat from free-form stdout. */
export function parseTriageHeartbeat(text: string): {
  ok: boolean;
  result: "fixed" | "card-updated" | "blocked" | "needs-human";
  detail: string | null;
} | null {
  if (!text) return null;
  let last: {
    ok: boolean;
    result: "fixed" | "card-updated" | "blocked" | "needs-human";
    detail: string | null;
  } | null = null;
  for (const m of text.matchAll(HEARTBEAT_RE)) {
    const result = m[2]!.toLowerCase() as
      | "fixed"
      | "card-updated"
      | "blocked"
      | "needs-human";
    last = {
      ok: (m[1] ?? "").toLowerCase() === "ok",
      result,
      detail: (m[3] ?? "").trim() || null,
    };
  }
  return last;
}

function looksNeedsHuman(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\bneeds[_\s-]?human\b|\bNEED_HUMAN\b|\bhuman clearance\b|\bblocked on (tom|human)\b/i.test(
    text,
  );
}

function normalizeVerdict(raw: string | null | undefined): TriageVerdict | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/_/g, "-");
  if (
    v === "fixed" ||
    v === "card-updated" ||
    v === "blocked" ||
    v === "needs-human" ||
    v === "running" ||
    v === "unknown" ||
    v === "not-dispatched" ||
    v === "cooldown" ||
    v === "dispatch-failed" ||
    v === "disabled"
  ) {
    return v;
  }
  if (v === "card_updated") return "card-updated";
  if (v === "needs_human") return "needs-human";
  return null;
}

/**
 * Resolve escalate/triage status for a routine run directory.
 * Returns null when the run was never escalated (no breadcrumb).
 */
export function resolveEscalateStatus(runDir: string): EscalateStatus | null {
  try {
    const escRaw = readJson(join(runDir, "error-escalated.json"));
    if (!escRaw) return null;
    const esc = escRaw as EscalatedFile;

    const parsed = parseAgentDispatchDetail(
      typeof esc.agent === "string" ? esc.agent : null,
    );
    const agentDispatched =
      typeof esc.agentDispatched === "boolean"
        ? esc.agentDispatched
        : parsed.dispatched;

    let triageDir: string | null =
      (typeof esc.triageDir === "string" && esc.triageDir) || parsed.dir || null;
    if (!triageDir || !existsSync(triageDir)) {
      triageDir = findTriageDirForFailedRun(runDir) ?? triageDir;
      if (triageDir && !existsSync(triageDir)) triageDir = null;
    }

    const triageMeta = triageDir ? readJson(join(triageDir, "meta.json")) : null;
    let triagePid: number | null =
      typeof esc.triagePid === "number"
        ? esc.triagePid
        : parsed.pid;
    if (
      triagePid == null &&
      triageMeta &&
      typeof triageMeta.pid === "number"
    ) {
      triagePid = triageMeta.pid;
    }

    const triageRunning = isPidAlive(triagePid);
    const triageResult = readJson(join(runDir, "triage-result.json")) as TriageResultFile | null;
    // Also accept result file inside triage dir
    const triageResultAlt = triageDir
      ? (readJson(join(triageDir, "triage-result.json")) as TriageResultFile | null)
      : null;
    const tr = triageResult ?? triageResultAlt;

    const stdout = triageDir ? readText(join(triageDir, "stdout.log")) : "";
    const stderr = triageDir ? readText(join(triageDir, "stderr.log")) : "";
    const hb = parseTriageHeartbeat(`${stdout}\n${stderr}`);

    let triageStatus: TriageVerdict;
    let triageDetail: string | null = null;
    let triageFinishedAt: string | null = null;

    if (parsed.disabled) {
      triageStatus = "disabled";
      triageDetail = typeof esc.agent === "string" ? esc.agent : "agent dispatch disabled";
    } else if (parsed.cooldown && !agentDispatched && !triageDir) {
      triageStatus = "cooldown";
      triageDetail = typeof esc.agent === "string" ? esc.agent : "agent on cooldown";
    } else if (parsed.failed && !triageDir) {
      triageStatus = "dispatch-failed";
      triageDetail = typeof esc.agent === "string" ? esc.agent : "triage spawn failed";
    } else if (!agentDispatched && !triageDir && !parsed.cooldown) {
      triageStatus = "not-dispatched";
      triageDetail = typeof esc.agent === "string" ? esc.agent : "no triage agent";
    } else if (triageRunning) {
      triageStatus = "running";
      triageDetail = "triage agent still running";
    } else if (tr && normalizeVerdict(tr.result)) {
      triageStatus = normalizeVerdict(tr.result)!;
      triageDetail =
        (typeof tr.detail === "string" && tr.detail) ||
        (typeof tr.rootCause === "string" && tr.rootCause) ||
        null;
      triageFinishedAt =
        typeof tr.finishedAt === "string" ? tr.finishedAt : null;
    } else if (hb) {
      triageStatus = hb.result;
      triageDetail = hb.detail;
    } else if (agentDispatched || triageDir) {
      triageStatus = "unknown";
      triageDetail = triageDir
        ? "triage finished without a parseable verdict"
        : typeof esc.agent === "string"
          ? esc.agent
          : "triage dispatched; status unknown";
    } else {
      triageStatus = "unknown";
      triageDetail = typeof esc.agent === "string" ? esc.agent : null;
    }

    // Prefer meta finishedAt when process is dead
    if (
      !triageRunning &&
      !triageFinishedAt &&
      triageMeta &&
      typeof triageMeta.finishedAt === "string"
    ) {
      triageFinishedAt = triageMeta.finishedAt;
    }

    const cardOk = typeof esc.cardOk === "boolean" ? esc.cardOk : null;
    const cardDetail =
      typeof esc.cardDetail === "string"
        ? esc.cardDetail
        : null;
    const cardSlug = typeof esc.cardSlug === "string" ? esc.cardSlug : null;

    // Explicit file flag wins when present
    let needsHuman =
      typeof tr?.needsHuman === "boolean" ? tr.needsHuman : false;
    let needsHumanReason: string | null = null;

    if (typeof tr?.needsHuman === "boolean" && tr.needsHuman) {
      needsHumanReason =
        (typeof tr.detail === "string" && tr.detail) ||
        "triage marked needsHuman";
    }

    if (cardOk === false) {
      needsHuman = true;
      needsHumanReason =
        needsHumanReason ??
        (cardDetail
          ? `board card not filed: ${cardDetail}`
          : "board card failed to file — no P0 on kanban");
    }

    if (triageStatus === "blocked" || triageStatus === "needs-human") {
      needsHuman = true;
      needsHumanReason =
        needsHumanReason ??
        triageDetail ??
        (triageStatus === "blocked"
          ? "triage blocked (external / human gate)"
          : "triage marked needs-human");
    }

    if (triageStatus === "dispatch-failed") {
      needsHuman = true;
      needsHumanReason =
        needsHumanReason ?? triageDetail ?? "triage agent failed to start";
    }

    if (
      triageStatus === "unknown" &&
      !triageRunning &&
      (agentDispatched || Boolean(triageDir))
    ) {
      needsHuman = true;
      needsHumanReason =
        needsHumanReason ??
        "triage exited without a clear fixed/card-updated/blocked verdict";
    }

    if (looksNeedsHuman(triageDetail) || looksNeedsHuman(cardDetail)) {
      needsHuman = true;
      needsHumanReason =
        needsHumanReason ?? triageDetail ?? cardDetail ?? "needs human";
    }

    // Happy path: fixed and card ok → clear needs-human unless explicit flag
    if (
      (triageStatus === "fixed" || triageStatus === "card-updated") &&
      cardOk !== false &&
      tr?.needsHuman !== true
    ) {
      needsHuman = false;
      needsHumanReason = null;
    }

    // Still running: not a needs-human yet (agent is on it) unless card missing
    if (triageRunning && cardOk !== false && tr?.needsHuman !== true) {
      // Keep card-failure needsHuman; otherwise soft while in flight
      if (needsHumanReason?.startsWith("board card")) {
        /* keep */
      } else if (triageStatus === "running") {
        needsHuman = false;
        needsHumanReason = null;
      }
    }

    return {
      escalated: true,
      at: typeof esc.at === "string" ? esc.at : null,
      cardSlug,
      cardOk,
      cardDetail,
      agentDetail: typeof esc.agent === "string" ? esc.agent : null,
      agentDispatched,
      triageDir,
      triagePid,
      triageRunning,
      triageFinishedAt,
      triageStatus,
      triageDetail,
      needsHuman,
      needsHumanReason,
    };
  } catch {
    return null;
  }
}
