// In-place editor for registry TOML files. pause/resume/route change a single
// scalar key; we rewrite the raw text so comments and unrelated lines survive.
//
// Every key written is also recorded in `<ROUTINES_HOME>/registry-audit.log`.
// On 2026-10-01 the registry flipped to `status = "paused"` four times (38, 40,
// 40 and 80 files) and no pass could name the writer: this editor left no
// trace, and the `routines resume` that healed it overwrote the file mtimes,
// the only evidence. The log is that missing trace, in two parts:
//   - who wrote: `caller`, `client`, the routine identity env (`actor`), `cwd`,
//     `pid`, `ppid` and `argv`;
//   - what the file looked like before the rewrite: `from`, and `prev_mtime` and
//     `prev_size`, read just before the write. A heal that goes through setKeys
//     therefore carries the time of the flip it heals, in each line it
//     writes. A writer that never goes through setKeys leaves no line of its
//     own; its time shows only in the `prev_mtime` of the next setKeys write.
// It also makes each write reversible without a copy of the file: setKeys
// changes only the keys it is handed, so the logged `from` values are
// everything needed to undo it.

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { registryAuditLogPath } from "./paths.ts";

type TomlScalar = string | boolean;

/** Who asked for the write. `caller` is the entry point; `client` is the HTTP
 * User-Agent for `web` (the dashboard endpoints have no auth, so it is the only
 * hint to who called). A caller that passes nothing is logged as `unknown`. */
export interface AuditContext {
  caller: "cli" | "web";
  client?: string;
}

/** Env names that say a scheduled routine ran this process. buildRoutineAttributionEnv
 * (src/prompt.ts) injects them into every harness child, and its doc comment says
 * that their absence means "not a scheduled routine". This is an allowlist and
 * not a copy of process.env: the environment holds secrets. */
const ACTOR_ENV = ["DRIVEN_BY", "AUTOMATION_ID", "LASTGIT_ACTOR", "ROUTINES_RUN_ID"] as const;

/** The longest env value or User-Agent that one log line keeps. */
const MAX_FIELD = 200;

/** The routine identity env of this process. Empty when none is set, which is
 * what a human at a terminal looks like. For a `web` write this is the dashboard
 * server's env, not the HTTP client's. */
function actorFromEnv(): Record<string, string> {
  const actor: Record<string, string> = {};
  for (const name of ACTOR_ENV) {
    const value = process.env[name];
    if (value) actor[name] = value.slice(0, MAX_FIELD);
  }
  return actor;
}

/** process.cwd() throws when the directory was removed; that must not cost the line. */
function safeCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/** The file as it is on disk, read before the rewrite replaces it. */
interface FileStamp {
  mtime: string | null;
  size: number | null;
}

function stampFile(path: string): FileStamp {
  try {
    const st = statSync(path);
    return { mtime: st.mtime.toISOString(), size: st.size };
  } catch {
    return { mtime: null, size: null };
  }
}

interface KeyChange {
  key: string;
  /** The value the file held, or null when the key was appended. */
  from: TomlScalar | null;
  to: TomlScalar;
}

function render(value: TomlScalar): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The value text after `=` on a line, as the file holds it. Covers what this
 * editor writes (basic strings, booleans) plus literal strings and bare tokens;
 * a multi-line string is returned raw rather than guessed at. */
function readScalar(rest: string): TomlScalar {
  const rhs = rest.trim();
  if (rhs.startsWith('"""') || rhs.startsWith("'''")) return rhs;
  const basic = rhs.match(/^"((?:[^"\\]|\\.)*)"/);
  if (basic) return basic[1]!.replace(/\\(["\\])/g, "$1");
  const literal = rhs.match(/^'([^']*)'/);
  if (literal) return literal[1]!;
  const bare = rhs.replace(/\s+#.*$/, "").trim();
  if (bare === "true") return true;
  if (bare === "false") return false;
  return bare;
}

/** Append one JSON line per written key. Best effort by design: a pause must
 * never fail because the log could not be written, so a failure is reported on
 * stderr and swallowed. Called only after the registry write succeeded, so the
 * log never names a write that did not happen. A write that sets a key to the
 * value it already had is logged too: it still rewrites the file and bumps the
 * mtime, which is evidence a reader would otherwise misread. */
function recordAudit(
  sourcePath: string,
  changes: KeyChange[],
  before: FileStamp,
  audit: AuditContext | undefined,
): void {
  if (changes.length === 0) return;
  try {
    const ts = new Date().toISOString();
    const id = basename(sourcePath).replace(/\.toml$/i, "");
    const actor = actorFromEnv();
    const cwd = safeCwd();
    const lines = changes.map((c) =>
      JSON.stringify({
        ts,
        id,
        file: sourcePath,
        key: c.key,
        from: c.from,
        to: c.to,
        prev_mtime: before.mtime,
        prev_size: before.size,
        pid: process.pid,
        ppid: process.ppid,
        argv: process.argv.slice(0, 3),
        cwd,
        caller: audit?.caller ?? "unknown",
        client: audit?.client?.slice(0, MAX_FIELD),
        actor,
      }),
    );
    appendFileSync(registryAuditLogPath(), lines.join("\n") + "\n");
  } catch (err) {
    try {
      console.error(`routines: registry audit log not written: ${(err as Error).message}`);
    } catch {
      // stderr gone too; the registry write already succeeded and must stand.
    }
  }
}

/** Set string keys in a registry file, preserving all other content. A key that
 * already exists is replaced on its line; a new key is appended. Each key
 * written is recorded in the registry audit log (see the header). */
export function setKeys(sourcePath: string, updates: Record<string, TomlScalar>, audit?: AuditContext): void {
  const text = readFileSync(sourcePath, "utf8");
  const lines = text.split(/\r?\n/);
  const remaining = new Map(Object.entries(updates));
  const changes: KeyChange[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    const eq = trimmed.indexOf("=");
    if (eq < 0 || trimmed.startsWith("#")) continue;
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      const indent = line.slice(0, line.length - trimmed.length);
      const to = remaining.get(key)!;
      changes.push({ key, from: readScalar(trimmed.slice(eq + 1)), to });
      lines[i] = `${indent}${key} = ${render(to)}`;
      remaining.delete(key);
    }
  }

  const appended: string[] = [];
  for (const [key, value] of remaining) {
    changes.push({ key, from: null, to: value });
    appended.push(`${key} = ${render(value)}`);
  }

  let out = lines.join("\n");
  if (appended.length > 0) {
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    out += appended.join("\n") + "\n";
  }
  const before = stampFile(sourcePath); // the write below replaces this mtime
  writeFileSync(sourcePath, out);
  recordAudit(sourcePath, changes, before, audit);
}
