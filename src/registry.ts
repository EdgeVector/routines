// Routine registry: one TOML file per routine at
// $ROUTINES_HOME/registry/<id>.toml.
//
// The registry lives on disk (NOT in LastDB) on purpose: the scheduler must
// keep firing — or fail loudly — during a brain outage, per the workspace
// brain-down standing rules. Run history and heartbeats still flow to fbrain.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { registryDir } from "./paths.ts";
import { parseRRule, type RRule } from "./rrule.ts";
import { parseToml, type TomlValue } from "./toml.ts";

export const HARNESSES = ["claude", "codex", "grok"] as const;
export type Harness = (typeof HARNESSES)[number];
export type Status = "active" | "paused";
export const ERROR_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type ErrorPriority = (typeof ERROR_PRIORITIES)[number];

export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

export interface RoutineEntry {
  id: string;
  /** Path to a prompt file (usually ~/.last-stack/routines/<name>.md). */
  promptPath?: string;
  /** Inline prompt text (mutually exclusive with promptPath). */
  prompt?: string;
  harness: Harness;
  model: string;
  effort?: string;
  rrule: string;
  parsedRrule: RRule;
  cwd: string;
  status: Status;
  timeoutMin: number;
  /** Priority for a newly filed routine-error card. Defaults to P3. */
  errorPriority?: ErrorPriority;
  heartbeatSlug?: string;
  /**
   * Optional dashboard group override (`board` | `brain` | `dogfood` | …).
   * When unset, the status snapshot assigns a group heuristically from the id.
   */
  group?: string;
  /**
   * Optional comma-separated fallback chain after primary, e.g.
   * `claude:sonnet,grok:grok-4.5`. When unset, fleet default applies.
   */
  fallback?: string;
  /** Absolute path of the source TOML file. */
  sourcePath: string;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "RegistryError";
  }
}

const KNOWN_KEYS = new Set([
  "id",
  "prompt_path",
  "prompt",
  "harness",
  "model",
  "effort",
  "rrule",
  "cwd",
  "status",
  "timeout_min",
  "error_priority",
  "heartbeat_slug",
  "group",
  "fallback",
]);

export function parseEntry(text: string, sourcePath: string): RoutineEntry {
  const raw = parseToml(text);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) throw new RegistryError(`unknown key ${JSON.stringify(key)}`, sourcePath);
  }

  const fileId = basename(sourcePath).replace(/\.toml$/i, "");
  const id = str(raw, "id", sourcePath) ?? fileId;
  if (id !== fileId) {
    throw new RegistryError(`id ${JSON.stringify(id)} must match filename ${JSON.stringify(fileId)}`, sourcePath);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new RegistryError(`invalid id ${JSON.stringify(id)} (allowed: A-Za-z0-9._-)`, sourcePath);
  }

  const promptPath = str(raw, "prompt_path", sourcePath);
  const prompt = str(raw, "prompt", sourcePath);
  if (!promptPath && !prompt) {
    throw new RegistryError("must set either prompt_path or prompt", sourcePath);
  }
  if (promptPath && prompt) {
    throw new RegistryError("set only one of prompt_path or prompt", sourcePath);
  }

  const harnessRaw = req(str(raw, "harness", sourcePath), "harness", sourcePath);
  if (!isHarness(harnessRaw)) {
    throw new RegistryError(
      `invalid harness ${JSON.stringify(harnessRaw)} (${HARNESSES.join("|")})`,
      sourcePath,
    );
  }
  const harness: Harness = harnessRaw;

  const model = req(str(raw, "model", sourcePath), "model", sourcePath);

  const rruleStr = req(str(raw, "rrule", sourcePath), "rrule", sourcePath);
  let parsedRrule: RRule;
  try {
    parsedRrule = parseRRule(rruleStr);
  } catch (err) {
    throw new RegistryError(`invalid rrule: ${(err as Error).message}`, sourcePath);
  }

  const statusRaw = str(raw, "status", sourcePath) ?? "active";
  if (statusRaw !== "active" && statusRaw !== "paused") {
    throw new RegistryError(`invalid status ${JSON.stringify(statusRaw)} (active|paused)`, sourcePath);
  }
  const status: Status = statusRaw;

  const cwd = str(raw, "cwd", sourcePath) ?? process.cwd();

  const timeoutMin = num(raw, "timeout_min", sourcePath) ?? 30;
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
    throw new RegistryError(`invalid timeout_min ${timeoutMin}`, sourcePath);
  }

  const errorPriorityRaw = str(raw, "error_priority", sourcePath);
  if (
    errorPriorityRaw !== undefined &&
    !(ERROR_PRIORITIES as readonly string[]).includes(errorPriorityRaw)
  ) {
    throw new RegistryError(
      `invalid error_priority ${JSON.stringify(errorPriorityRaw)} (${ERROR_PRIORITIES.join("|")})`,
      sourcePath,
    );
  }

  const group = str(raw, "group", sourcePath);
  if (group !== undefined) {
    // Lazy import avoided: validate against a fixed set here so registry
    // parse stays free of circular deps with status/groups consumers.
    const known = new Set([
      "board",
      "brain",
      "dogfood",
      "hygiene",
      "quality",
      "product",
      "smoke",
      "other",
    ]);
    if (!known.has(group)) {
      throw new RegistryError(
        `invalid group ${JSON.stringify(group)} (${[...known].join("|")})`,
        sourcePath,
      );
    }
  }

  const entry: RoutineEntry = {
    id,
    harness,
    model,
    rrule: rruleStr,
    parsedRrule,
    cwd,
    status,
    timeoutMin,
    sourcePath,
  };
  if (promptPath) entry.promptPath = promptPath;
  if (prompt) entry.prompt = prompt;
  const effort = str(raw, "effort", sourcePath);
  if (effort) entry.effort = effort;
  const heartbeatSlug = str(raw, "heartbeat_slug", sourcePath);
  if (heartbeatSlug) entry.heartbeatSlug = heartbeatSlug;
  if (errorPriorityRaw) entry.errorPriority = errorPriorityRaw as ErrorPriority;
  if (group) entry.group = group;
  const fallback = str(raw, "fallback", sourcePath);
  if (fallback) entry.fallback = fallback;
  return entry;
}

export function loadEntry(id: string): RoutineEntry {
  const p = join(registryDir(), `${id}.toml`);
  if (!existsSync(p)) throw new RegistryError("no such routine", p);
  return parseEntry(readFileSync(p, "utf8"), p);
}

export interface LoadResult {
  entries: RoutineEntry[];
  errors: RegistryError[];
}

/** Load every registry file, collecting per-file parse errors rather than
 * aborting the whole load — a doctor/daemon should report a broken entry and
 * still schedule the healthy ones. */
export function loadAll(): LoadResult {
  const dir = registryDir();
  const entries: RoutineEntry[] = [];
  const errors: RegistryError[] = [];
  if (!existsSync(dir)) return { entries, errors };
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".toml"))
    .sort();
  for (const f of files) {
    const p = join(dir, f);
    try {
      entries.push(parseEntry(readFileSync(p, "utf8"), p));
    } catch (err) {
      if (err instanceof RegistryError) errors.push(err);
      else errors.push(new RegistryError((err as Error).message, p));
    }
  }
  return { entries, errors };
}

/** Resolve the prompt text an entry will dispatch (reads prompt_path lazily). */
export function resolvePrompt(entry: RoutineEntry): string {
  if (entry.prompt !== undefined) return entry.prompt;
  if (entry.promptPath !== undefined) {
    if (!existsSync(entry.promptPath)) {
      throw new RegistryError(`prompt_path not found: ${entry.promptPath}`, entry.sourcePath);
    }
    return readFileSync(entry.promptPath, "utf8");
  }
  throw new RegistryError("no prompt", entry.sourcePath);
}

function str(raw: Record<string, TomlValue>, key: string, file: string): string | undefined {
  if (!(key in raw)) return undefined;
  const v = raw[key];
  if (typeof v !== "string") throw new RegistryError(`${key} must be a string`, file);
  return v;
}

function num(raw: Record<string, TomlValue>, key: string, file: string): number | undefined {
  if (!(key in raw)) return undefined;
  const v = raw[key];
  if (typeof v !== "number") throw new RegistryError(`${key} must be a number`, file);
  return v;
}

function req<T>(v: T | undefined, key: string, file: string): T {
  if (v === undefined) throw new RegistryError(`missing required key ${key}`, file);
  return v;
}
