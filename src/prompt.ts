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
import { dirname } from "node:path";

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

export type DispatchEnvelopeOptions = {
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

/** Full prompt text routinesd dispatches to a harness. */
export function resolveDispatchPrompt(
  entry: RoutineEntry,
  opts: { runDir?: string } = {},
): string {
  const body = resolvePrompt(entry);
  const memoryPath = ensureMemoryPath(entry.id);
  return buildDispatchEnvelope(entry, memoryPath, { runDir: opts.runDir }) + body;
}
