// Filesystem layout for routines state.
//
// The registry, run logs, locks, and per-routine state all live under a single
// home directory. A restricted launch names that directory in LASTDB_APP_DATA.
// A direct run keeps ROUTINES_HOME, or ~/.routines when that is unset.

import { homedir } from "node:os";
import { join } from "node:path";

export function routinesHome(): string {
  const appData = process.env.LASTDB_APP_DATA;
  if (appData && appData.length > 0) return appData;
  const override = process.env.ROUTINES_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".routines");
}

export function registryDir(): string {
  return join(routinesHome(), "registry");
}

/**
 * Append-only JSONL of every key `setKeys` writes into a registry file (one
 * line per key). It sits beside the registry dir, not inside it: the scheduler
 * and `freeze-watch` scan `registry/` and must never see anything but entries.
 */
export function registryAuditLogPath(): string {
  return join(routinesHome(), "registry-audit.log");
}

export function runsDir(): string {
  return join(routinesHome(), "runs");
}

export function locksDir(): string {
  return join(routinesHome(), "locks");
}

export function stateDir(): string {
  return join(routinesHome(), "state");
}

/**
 * Copy `env` without this process's LastDB app id or app socket.
 *
 * The launcher sets `LASTDB_APP` and `LASTDB_SOCKET_PATH` on this process.
 * A program this process starts is not this app. It gets its own id and
 * socket from its own launcher. A re-exec of routines keeps both.
 */
export function withoutLastDbAppIdentity(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.LASTDB_APP;
  delete out.LASTDB_SOCKET_PATH;
  return out;
}

// Daemon's own stdout/stderr log directory (distinct from per-run logs).
export function daemonLogDir(): string {
  return join(routinesHome(), "daemon");
}

/** Last routinesd process identity (pid, exec, graceful-stop reason). */
export function daemonIdentityPath(): string {
  return join(daemonLogDir(), "routinesd.identity.json");
}

/**
 * Per-routine automation memory (durable cross-run notes). Lives under
 * ROUTINES_HOME so fleet harnesses can write without inventing short Codex
 * automation aliases or depending on PAUSED ~/.codex/automations trees.
 */
export function memoryDir(): string {
  return join(routinesHome(), "memory");
}

export function memoryPathFor(id: string): string {
  return join(memoryDir(), id, "memory.md");
}
