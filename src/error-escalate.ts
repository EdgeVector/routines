// Automatic escalation when a routine run ends in error.
//
// Tom 2026-07-14: "I don't want error runs during routines… if a routine
// errors, dispatch an agent to figure it out or file a card… really
// important."
//
// On hard failure (non-zero exit / timeout / spawn failure) or soft
// outcome=error (agent heartbeat), we:
//   1. Upsert a P0 kanban card with run evidence (deterministic CLI)
//   2. Fire a one-shot triage harness agent (async, never blocks the
//      completing run) that investigates the run dir and either fixes or
//      tightens the card.
//
// Recursion / spam guards:
//   - Never escalate the triage runner itself
//   - Rate-limit agent dispatch per routine id (default 30m)
//   - Disable entirely with ROUTINES_ERROR_ESCALATE=0
//   - Never throw out of escalate paths (scheduler must not die)

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { harnessBinary } from "./adapters.ts";
import type { RoutineEntry } from "./registry.ts";
import { routinesHome, runsDir } from "./paths.ts";
import type { RunResult } from "./runner.ts";

const TRIAGE_ID = "routine-error-triage";
/** Min gap between triage agent dispatches for the same routine id. */
const DEFAULT_AGENT_COOLDOWN_MS = 30 * 60 * 1000;
/** Card upsert always; agent spawn is rate-limited. */
const STATE_DIR_NAME = "error-escalate";

export interface EscalateState {
  lastEscalatedAt: string;
  lastRunDir: string;
  lastCardSlug: string;
  lastAgentDispatchedAt?: string;
  lastExit?: number | null;
  lastOutcome?: string;
}

export interface EscalateOptions {
  /** Inject for tests. */
  nowMs?: number;
  agentCooldownMs?: number;
  /** When false, only file the card — do not spawn a triage agent. */
  dispatchAgent?: boolean;
  /** Override kanban binary (tests). */
  kanbanBin?: string;
  /** Suppress console noise. */
  quiet?: boolean;
}

function enabled(): boolean {
  const v = process.env.ROUTINES_ERROR_ESCALATE;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

function stateDir(): string {
  return join(routinesHome(), STATE_DIR_NAME);
}

function statePath(routineId: string): string {
  return join(stateDir(), `${safeId(routineId)}.json`);
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

function cardSlug(routineId: string): string {
  return `routine-error-${safeId(routineId)}`;
}

function isTriageRoutine(id: string): boolean {
  return id === TRIAGE_ID || id.startsWith("routine-error-triage");
}

/** True when this run should be escalated. */
export function shouldEscalate(result: RunResult): boolean {
  if (!enabled()) return false;
  if (isTriageRoutine(result.id)) return false;

  if (result.timedOut) {
    if (isCompletedTimeout(result)) return false;
    return true;
  }
  if (result.exitCode !== null && result.exitCode !== 0) return true;
  if (result.outcome.kind === "error") return true;
  // Spawn failures record exitCode null with stderr "spawn error:"
  if (result.exitCode === null && result.signal === null) {
    // May be clean if process was killed oddly — only escalate if outcome error/unknown with no success
    if (result.outcome.kind === "unknown" && result.durationMs < 2_000) return true;
  }
  return false;
}

function isCompletedTimeout(result: RunResult): boolean {
  return (
    result.exitCode === 0 &&
    (result.outcome.kind === "ok" || result.outcome.kind === "noop") &&
    (result.outcome.source === "heartbeat" || result.outcome.source === "routine_result")
  );
}

function defaultRepo(routineId: string): string {
  if (routineId.startsWith("last-stack-") || routineId.includes("fkanban")) {
    return "EdgeVector/last-stack";
  }
  if (
    routineId.startsWith("dogfood-") ||
    routineId.includes("smoke") ||
    routineId.includes("telemetry")
  ) {
    return "EdgeVector/routines";
  }
  return "EdgeVector/routines";
}

function readState(routineId: string): EscalateState | null {
  const p = statePath(routineId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as EscalateState;
  } catch {
    return null;
  }
}

function writeState(routineId: string, st: EscalateState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(routineId), JSON.stringify(st, null, 2) + "\n");
}

function logLine(quiet: boolean | undefined, msg: string): void {
  if (quiet) return;
  try {
    process.stderr.write(`[routines error-escalate] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function buildCardBody(entry: RoutineEntry, result: RunResult): string {
  const detail = result.outcome.detail ?? "(no detail)";
  const day = result.finishedAt.slice(0, 10);
  return `**Follow the kanban-agent skill — drive this through to a MERGED PR
(or a durable prompt/registry fix proven by a clean re-run).
A card is only done when this routine stops erroring.**

Repo: ${defaultRepo(entry.id)}
Base: main
Branch: kanban/${cardSlug(entry.id)}
Kind: pr
Priority: P0
North Star: north-star-lastgit-native-forge

## GOAL

Root-cause and fix why scheduled routine \`${entry.id}\` ended in **error**,
so the fleet no longer ships silent red runs.

## EVIDENCE (auto-filed by routinesd)

- routine: \`${entry.id}\`
- harness/model: \`${entry.harness}/${entry.model}\`
- finished_at: \`${result.finishedAt}\`
- exitCode: \`${String(result.exitCode)}\` timedOut=\`${String(result.timedOut)}\`
- outcome: \`${result.outcome.kind}\` source=\`${result.outcome.source}\`
- detail: ${detail}
- run_dir: \`${result.runDir}\`
- logs: \`stdout.log\` / \`stderr.log\` / \`meta.json\` under that run_dir

## STEPS

1. Read \`${result.runDir}/meta.json\`, tail stdout/stderr.
2. Classify: harness crash / prompt bug / missing tool / external blocker /
   intentional "error" heartbeat that should have been ok/noop with a card.
3. Fix the smallest durable layer (routine prompt, last-stack routine, routinesd,
   or product code). Prefer preventing recurrence over one-off recovery.
4. Re-run or wait for next schedule; confirm lastOutcome is ok or noop (not error)
   and exit 0.

## VERIFY

\`\`\`bash
# Last run for this id should not be error:
routines status --json 2>/dev/null | jq '.routines[]? | select(.id=="${entry.id}") | {id,lastOutcome,lastExit}'
# Or inspect newest run meta under ~/.routines/runs/${entry.id}/
ls -lt "$HOME/.routines/runs/${entry.id}" | head
\`\`\`

## DONE WHEN

A subsequent scheduled run of \`${entry.id}\` finishes with outcome ok|noop and
exit 0 (or the routine is intentionally paused/retired with a documented reason).

## OUT OF SCOPE

Restarting primary lastdbd/forgejo; force-green without a root cause; infinite
re-dispatch loops (triage agent must not re-escalate itself).

Auto-filed ${day} by routinesd error-escalate.
`;
}

function fileP0Card(
  entry: RoutineEntry,
  result: RunResult,
  opts: EscalateOptions,
): { ok: boolean; slug: string; detail: string } {
  const slug = cardSlug(entry.id);
  const body = buildCardBody(entry, result);
  const bodyPath = join(result.runDir, "error-escalate-card-body.md");
  try {
    writeFileSync(bodyPath, body);
  } catch (err) {
    return { ok: false, slug, detail: `write body failed: ${(err as Error).message}` };
  }

  const kanban = opts.kanbanBin ?? process.env.ROUTINES_KANBAN_BIN ?? "kanban";
  const title = `P0: routine ${entry.id} errored (exit=${String(result.exitCode)} outcome=${result.outcome.kind})`;
  const args = [
    "add",
    slug,
    "--title",
    title,
    "--column",
    "todo",
    "--priority",
    "P0",
    "--repo",
    defaultRepo(entry.id),
    "--base",
    "main",
    "--kind",
    "pr",
    "--tags",
    "routine,error,p0,agent-runnable,fleet",
    "--north-star",
    "north-star-lastgit-native-forge",
  ];

  const res = spawnSync(kanban, args, {
    input: body,
    encoding: "utf8",
    timeout: 60_000,
    env: process.env,
  });
  if (res.error) {
    return { ok: false, slug, detail: `kanban spawn: ${res.error.message}` };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      slug,
      detail: `kanban exit ${res.status}: ${(res.stderr || res.stdout || "").slice(0, 400)}`,
    };
  }

  // Best-effort rank so pickup drains P0 first.
  spawnSync(kanban, ["rank", "--column", "todo"], {
    encoding: "utf8",
    timeout: 60_000,
    env: process.env,
  });

  return { ok: true, slug, detail: (res.stdout || "").trim() || "card upserted" };
}

function buildTriagePrompt(entry: RoutineEntry, result: RunResult, cardSlugName: string): string {
  return `You are the **routine-error-triage** agent. A scheduled routine just
failed. Your only job is to figure out WHY and make the failure stop recurring.

## Failed routine
- id: ${entry.id}
- harness/model: ${entry.harness}/${entry.model}
- run_dir: ${result.runDir}
- exitCode: ${String(result.exitCode)} timedOut: ${String(result.timedOut)}
- outcome: ${result.outcome.kind} (${result.outcome.source}) detail: ${result.outcome.detail ?? ""}
- board card (P0, already filed): ${cardSlugName}

## Hard rules
- NEVER kill/restart primary lastdbd / brew Mini / forgejo.
- NEVER escalate or re-dispatch yourself (you ARE the triage).
- Prefer a durable fix (prompt / registry / last-stack / product code) + MERGED PR
  via the correct venue (last-stack-pr-venue).
- If you cannot fix in this session: update card ${cardSlugName} with root cause +
  next steps; leave it P0 in todo/review as appropriate. Use result=blocked when
  waiting on an external gate; use result=needs-human when Tom must decide.
- If this "error" was an intentional heartbeat about an external blocker and a
  card already tracks it, reclassify: document that the routine should heartbeat
  ok/noop after filing, and fix the prompt so soft blockers are not "error".

## Steps
1. Read ${result.runDir}/meta.json, stdout.log, stderr.log (tails ok if huge).
2. Identify root cause class: missing binary, PATH, prompt bug, timeout, API,
   real world blocker already carded, or product regression.
3. Fix or file precisely. Drive a small PR if code/prompt change is clear.
4. Write a structured verdict for the dashboard (required):
   path: ${result.runDir}/triage-result.json
   JSON shape:
   {"finishedAt":"<ISO>","result":"fixed|card-updated|blocked|needs-human","needsHuman":true|false,"detail":"<one line>","rootCause":"<short>"}
   Set needsHuman=true for blocked / needs-human / anything Tom must act on.
5. Heartbeat one line:
   routine-error-triage <ISO> ok|error failed=${entry.id} result=fixed|card-updated|blocked|needs-human detail=...

Then exit.
`;
}

function dispatchTriageAgent(
  entry: RoutineEntry,
  result: RunResult,
  cardSlugName: string,
  opts: EscalateOptions,
): { ok: boolean; detail: string; triageDir?: string; triagePid?: number | null } {
  if (opts.dispatchAgent === false) {
    return { ok: true, detail: "agent dispatch disabled" };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const triageDir = join(runsDir(), TRIAGE_ID, stamp);
  try {
    mkdirSync(triageDir, { recursive: true });
  } catch (err) {
    return { ok: false, detail: `mkdir triage: ${(err as Error).message}` };
  }

  const prompt = buildTriagePrompt(entry, result, cardSlugName);
  writeFileSync(join(triageDir, "prompt.txt"), prompt);
  writeFileSync(
    join(triageDir, "meta.json"),
    JSON.stringify(
      {
        id: TRIAGE_ID,
        forRoutine: entry.id,
        failedRunDir: result.runDir,
        cardSlug: cardSlugName,
        startedAt: new Date().toISOString(),
        harness: entry.harness,
        model: entry.model,
      },
      null,
      2,
    ) + "\n",
  );

  // Prefer the same harness that failed (it already has model routing); fall
  // back to codex for unknown.
  const harness = entry.harness;
  const bin = harnessBinary(harness);
  let args: string[];
  let stdin: string | undefined;
  if (harness === "codex") {
    args = ["exec", "--model", entry.model, "--skip-git-repo-check", "--ephemeral", "-"];
    if (entry.effort) {
      args.splice(args.length - 1, 0, "-c", `model_reasoning_effort=${JSON.stringify(entry.effort)}`);
    }
    stdin = prompt;
  } else if (harness === "claude") {
    args = ["-p", "--verbose", "--model", entry.model, "--output-format", "stream-json", prompt];
  } else {
    args = ["-m", entry.model, "--always-approve", "--permission-mode", "bypassPermissions", "-p", prompt];
  }

  const stdoutPath = join(triageDir, "stdout.log");
  const stderrPath = join(triageDir, "stderr.log");
  try {
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
  } catch {
    /* ignore */
  }

  // Detached: unref so the finishing routine is not blocked; capture streams.
  try {
    const stdoutFd = openSync(stdoutPath, "a");
    const stderrFd = openSync(stderrPath, "a");
    const child = spawn(bin, args, {
      cwd: entry.cwd || process.cwd(),
      env: process.env,
      stdio: [stdin !== undefined ? "pipe" : "ignore", stdoutFd, stderrFd],
      detached: true,
    });
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
    child.unref();
    const pid = child.pid ?? null;
    writeFileSync(
      join(triageDir, "meta.json"),
      JSON.stringify(
        {
          id: TRIAGE_ID,
          forRoutine: entry.id,
          failedRunDir: result.runDir,
          cardSlug: cardSlugName,
          startedAt: new Date().toISOString(),
          harness,
          model: entry.model,
          pid,
          command: [bin, ...args.filter((a) => a !== prompt), prompt.length > 80 ? "<prompt>" : prompt].join(" "),
        },
        null,
        2,
      ) + "\n",
    );
    return {
      ok: true,
      detail: `dispatched pid=${pid ?? "?"} dir=${triageDir}`,
      triageDir,
      triagePid: pid,
    };
  } catch (err) {
    return { ok: false, detail: `spawn triage: ${(err as Error).message}` };
  }
}

/**
 * File a P0 card and (rate-limited) dispatch a triage agent.
 * Never throws. Safe to call from runner finalize.
 */
export function escalateRoutineError(
  entry: RoutineEntry,
  result: RunResult,
  opts: EscalateOptions = {},
): { escalated: boolean; cardSlug?: string; agent?: string; detail: string } {
  try {
    if (!shouldEscalate(result)) {
      return { escalated: false, detail: "not an error run" };
    }

    const nowMs = opts.nowMs ?? Date.now();
    const cooldown = opts.agentCooldownMs ?? DEFAULT_AGENT_COOLDOWN_MS;
    const prev = readState(entry.id);

    const card = fileP0Card(entry, result, opts);
    logLine(opts.quiet, `card ${card.slug}: ${card.ok ? "ok" : "FAIL"} ${card.detail}`);

    let agentDetail = "skipped";
    let triageDir: string | undefined;
    let triagePid: number | null | undefined;
    let agentDispatched = false;
    const lastAgent = prev?.lastAgentDispatchedAt
      ? Date.parse(prev.lastAgentDispatchedAt)
      : 0;
    const allowAgent =
      opts.dispatchAgent !== false && (Number.isNaN(lastAgent) || nowMs - lastAgent >= cooldown);

    if (allowAgent) {
      const agent = dispatchTriageAgent(entry, result, card.slug, opts);
      agentDetail = agent.detail;
      triageDir = agent.triageDir;
      triagePid = agent.triagePid;
      agentDispatched = agent.ok && Boolean(agent.triageDir || /\bdispatched\b/i.test(agent.detail));
      logLine(opts.quiet, `agent: ${agent.detail}`);
    } else if (opts.dispatchAgent === false) {
      agentDetail = "agent dispatch disabled";
      logLine(opts.quiet, `agent: ${agentDetail}`);
    } else {
      agentDetail = `cooldown (${cooldown}ms) since ${prev?.lastAgentDispatchedAt ?? "never"}`;
      logLine(opts.quiet, `agent: ${agentDetail}`);
    }

    const st: EscalateState = {
      lastEscalatedAt: new Date(nowMs).toISOString(),
      lastRunDir: result.runDir,
      lastCardSlug: card.slug,
      lastExit: result.exitCode,
      lastOutcome: result.outcome.kind,
      lastAgentDispatchedAt: allowAgent && agentDispatched
        ? new Date(nowMs).toISOString()
        : prev?.lastAgentDispatchedAt,
    };
    writeState(entry.id, st);

    // Structured breadcrumb on the failed run dir (dashboard escalate chips).
    try {
      writeFileSync(
        join(result.runDir, "error-escalated.json"),
        JSON.stringify(
          {
            at: st.lastEscalatedAt,
            cardSlug: card.slug,
            cardOk: card.ok,
            cardDetail: card.ok ? null : card.detail,
            agent: agentDetail,
            agentDispatched,
            triageDir: triageDir ?? null,
            triagePid: triagePid ?? null,
          },
          null,
          2,
        ) + "\n",
      );
    } catch {
      /* ignore */
    }

    return {
      escalated: true,
      cardSlug: card.slug,
      agent: agentDetail,
      detail: card.ok ? "escalated" : `card-failed: ${card.detail}`,
    };
  } catch (err) {
    logLine(opts.quiet, `escalate threw: ${(err as Error).message}`);
    return { escalated: false, detail: `escalate threw: ${(err as Error).message}` };
  }
}
