// Dispatch-time prompt composition.
//
// Routinesd injects a short envelope so harness agents always see the real
// registry id + a writable Automation memory path. Without this, agents fall
// back to inventing short names from skill frontmatter (`name: kanban-pickup`)
// and write to missing ~/.codex/automations/<short>/memory.md paths under a
// sandbox that cannot create them.
//
// Also injects a durable **attribution** contract so landings (commits / PRs /
// LastGit CRs) can be distinguished from interactive agent work after the fact.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { memoryPathFor } from "./paths.ts";
import { resolvePrompt, type RoutineEntry } from "./registry.ts";
import { loadRecentNotices } from "./situations.ts";

/** Ensure the memory file's parent dir exists; return the absolute path. */
export function ensureMemoryPath(id: string): string {
  const path = memoryPathFor(id);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Actor string recorded on LastGit CRs when a scheduled routine drives work. */
export function routineActor(automationId: string): string {
  return `routine:${automationId}`;
}

/**
 * Env vars injected into every harness child (and recommended for triage).
 * Interactive sessions do not set these — absence means "not a scheduled routine".
 */
export function buildRoutineAttributionEnv(
  automationId: string,
  runDir?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    DRIVEN_BY: "routine",
    AUTOMATION_ID: automationId,
    LASTGIT_ACTOR: routineActor(automationId),
  };
  if (runDir) {
    env.ROUTINES_RUN_DIR = runDir;
    // Basename of the run dir is the ISO stamp (colons → dashes).
    const parts = runDir.replace(/\\/g, "/").split("/");
    const stamp = parts[parts.length - 1] || "";
    if (stamp) env.ROUTINES_RUN_ID = stamp;
    // Codex workspace-write still denies host /tmp. Pin scratch under the
    // run dir (already --add-dir ~/.routines) so git/xcrun, os.tmpdir(),
    // and helpers that honor TMPDIR do not mkdir /tmp.
    const scratch = join(runDir, "scratch");
    env.TMPDIR = scratch;
    env.TMP = scratch;
    env.TEMP = scratch;
  }
  return env;
}

/** Git / PR trailers agents must append when DRIVEN_BY=routine. */
export function formatAttributionTrailers(env: {
  automationId: string;
  runId?: string;
}): string {
  const lines = [
    "Driven-By: routine",
    `Automation-Id: ${env.automationId}`,
  ];
  if (env.runId) lines.push(`Run-Id: ${env.runId}`);
  return lines.join("\n");
}

type DispatchEnvelopeOptions = {
  /** When set, skip live `situations notices` (tests / offline). */
  noticesBanner?: string;
  /** Absolute run dir for this dispatch (optional; set when known). */
  runDir?: string;
};

/**
 * Envelope prepended to every dispatched prompt. Agents must honor the
 * Automation memory path exactly (no short-alias invention). Always includes
 * a Situations notices FYI block (or a soft-degrade line if CLI unavailable)
 * and a mandatory attribution contract for git/LastGit landings.
 */
export function buildDispatchEnvelope(
  entry: RoutineEntry,
  memoryPath: string,
  opts: DispatchEnvelopeOptions = {},
): string {
  const noticesBanner =
    opts.noticesBanner ??
    (process.env.ROUTINES_SKIP_NOTICES === "1"
      ? "## Situations notices (FYI, non-blocking)\n\n(skipped: ROUTINES_SKIP_NOTICES=1)\n\n"
      : loadRecentNotices().banner);

  const runParts = (opts.runDir ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  const runId = runParts[runParts.length - 1] || undefined;
  const trailers = formatAttributionTrailers({ automationId: entry.id, runId });

  return [
    "## Dispatch envelope (routinesd)",
    "",
    `Automation ID: ${entry.id}`,
    `Automation memory: ${memoryPath}`,
    opts.runDir ? `Run directory: ${opts.runDir}` : null,
    "",
    "Use ONLY the Automation memory path above for cross-run notes. Do not invent",
    "short aliases under ~/.codex/automations/ from the skill `name:` frontmatter.",
    "If that exact path is unwritable, note `memory_unwritable=<path>` in the",
    "heartbeat and continue — do not fail the whole run.",
    "",
    "## Foreground command ownership (required)",
    "",
    "When a shell/tool call reports that it is still running and returns a session,",
    "cell, or process identifier, keep polling that same call until it reaches a",
    "terminal result before starting any dependent command. A tool's first-yield",
    "timeout is not the command's exit status. Do not infer a crash, timeout, or",
    "missing output from an in-progress result, and do not launch a second probe that",
    "can race the still-running command or read stale state.",
    "",
    "## Explicit routine outcome (required)",
    "",
    "Before exiting, write exactly one single-line verdict to",
    "`$ROUTINES_RUN_DIR/outcome.txt`. Use the real outcome and a concise, non-secret",
    "detail, for example:",
    "",
    "```bash",
    'outcome_line="ok worked=<slug> result=merged"',
    'printf \'%s\\n\' "$outcome_line" > "$ROUTINES_RUN_DIR/outcome.txt"',
    "```",
    "",
    "Allowed verdicts are `ok`, `noop`, and `error`. The sink is authoritative:",
    "`routines status --json` reports `outcomeSource=\"sink\"` and does not infer the",
    "result from transcript text when this file is valid. Write the sink after the",
    "heartbeat and before the final stdout trailer. Continue to print the legacy",
    "`ROUTINE_RESULT outcome=...` trailer as a fallback for old runners and",
    "unmigrated prompts; do not remove it.",
    "",
    "## Attribution (required — durable provenance)",
    "",
    "This run is a **scheduled routine**, not an interactive human session.",
    "Environment is already set: `DRIVEN_BY=routine`, `AUTOMATION_ID=<id>`,",
    "`LASTGIT_ACTOR=routine:<id>` (and `ROUTINES_RUN_DIR` / `ROUTINES_RUN_ID` when known).",
    "",
    "On **every** `git commit` and every PR / LastGit CR body that lands work,",
    "append these git trailers at the end of the message/body (exact keys):",
    "",
    "```",
    trailers,
    "```",
    "",
    "Prefer `$last_stack/bin/last-stack-git-commit` (or print trailers with",
    "`last-stack-attribution-trailers`) so you cannot forget. Interactive agents",
    "must NOT invent these trailers; only scheduled routines stamp `Driven-By: routine`.",
    "Situations notices you post should use `actor=routine:<Automation ID>`.",
    "",
    noticesBanner.trimEnd(),
    "",
    "---",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Closeout block appended AFTER the resolved routine body.
 *
 * The same contract also rides in the envelope, but the envelope is prepended
 * to an often-long body, so by the time an agent finishes the body the sink
 * instruction has scrolled out of its working focus. 65 of 570 runs in the
 * 24 h to 2026-08-17T17:00Z finished `outcome=unknown`, and `unknown` is
 * invisible on every triage surface: it is neither ok, noop, nor error, so a
 * successful 19-minute run that exits 0 and writes its heartbeat is
 * indistinguishable from one that died.
 *
 * It also covers the routine whose own prompt asks for no closeout at all
 * (`coderings-weekly-fold` read `unknown` on 5 of its last 6 fires). Prompt
 * ORDER cannot fix that one, because there is no order to change — only the
 * runner reaches a prompt it did not author.
 *
 * CONTAMINATION: never write a literal result-shaped trailer here. The trailer
 * token glued to `outcome=` and a verdict word is exactly what `parseOutcome`
 * scans the transcript for, and prompt text is echoed by some harnesses, so a
 * worked example would classify every run that merely READ it. Name the token
 * and the shape separately, as the envelope does — never glued together. The
 * lint in scripts/lint-prompt-closeout.sh enforces this.
 *
 * papercut-routines-outcome-sink-closeout-is-buried-before-routine-body
 */
export function buildOutcomeCloseout(entry: RoutineEntry, runDir?: string): string {
  const sinkPath = runDir ? join(runDir, "outcome.txt") : "$ROUTINES_RUN_DIR/outcome.txt";
  return [
    "",
    "",
    "---",
    "",
    "## Close out this run (routinesd — required, do this LAST)",
    "",
    `You are the scheduled routine \`${entry.id}\`. Whatever the body above told`,
    "you to do, this run is not finished until its verdict is recorded. Write",
    "exactly one single-line verdict to the outcome sink:",
    "",
    "```bash",
    `printf '%s\\n' "ok <concise non-secret detail>" > "${sinkPath}"`,
    "```",
    "",
    "Allowed verdicts are `ok`, `noop`, and `error`:",
    "",
    "- `ok` — you did the work (include what you did: slugs, counts, PR/CR url).",
    "- `noop` — you checked and there was nothing to do, or an external blocker",
    "  stopped you before any work (empty queue, busy node, rate limit).",
    "- `error` — the run failed in a way a human should see.",
    "",
    "This file is authoritative: `routines status --json` reports",
    '`outcomeSource="sink"` and does not guess the result from transcript text.',
    "Without it the run records `unknown`, which no triage surface counts as",
    "success OR failure — the run becomes invisible rather than merely bad.",
    "",
    "Write the sink after any heartbeat and before your final stdout line. Keep",
    "printing the legacy machine trailer too, for older runners.",
    "",
  ].join("\n");
}

/** Full prompt text routinesd dispatches to a harness. */
export function resolveDispatchPrompt(
  entry: RoutineEntry,
  opts: { runDir?: string } = {},
): string {
  const body = resolvePrompt(entry);
  const memoryPath = ensureMemoryPath(entry.id);
  return (
    buildDispatchEnvelope(entry, memoryPath, { runDir: opts.runDir }) +
    body +
    buildOutcomeCloseout(entry, opts.runDir)
  );
}
