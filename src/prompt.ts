// Dispatch-time prompt composition.
//
// Routinesd injects a short envelope so harness agents always see the real
// registry id + a writable Automation memory path. Without this, agents fall
// back to inventing short names from skill frontmatter (`name: kanban-pickup`)
// and write to missing ~/.codex/automations/<short>/memory.md paths under a
// sandbox that cannot create them.

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

export type DispatchEnvelopeOptions = {
  /** When set, skip live `situations notices` (tests / offline). */
  noticesBanner?: string;
};

/**
 * Envelope prepended to every dispatched prompt. Agents must honor the
 * Automation memory path exactly (no short-alias invention). Always includes
 * a Situations notices FYI block (or a soft-degrade line if CLI unavailable).
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

  return [
    "## Dispatch envelope (routinesd)",
    "",
    `Automation ID: ${entry.id}`,
    `Automation memory: ${memoryPath}`,
    "",
    "Use ONLY the Automation memory path above for cross-run notes. Do not invent",
    "short aliases under ~/.codex/automations/ from the skill `name:` frontmatter.",
    "If that exact path is unwritable, note `memory_unwritable=<path>` in the",
    "heartbeat and continue — do not fail the whole run.",
    "",
    noticesBanner.trimEnd(),
    "",
    "---",
    "",
  ].join("\n");
}

/** Full prompt text routinesd dispatches to a harness. */
export function resolveDispatchPrompt(entry: RoutineEntry): string {
  const body = resolvePrompt(entry);
  const memoryPath = ensureMemoryPath(entry.id);
  return buildDispatchEnvelope(entry, memoryPath) + body;
}
