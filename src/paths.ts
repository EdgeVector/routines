// Filesystem layout for routines state.
//
// The registry, run logs, locks, and per-routine state all live under a single
// home directory. It defaults to ~/.routines but is overridable via
// ROUTINES_HOME so tests and the e2e can run against a throwaway directory
// without ever touching the real registry (same isolation discipline the
// fkanban-agent skill requires for stateful checks).

import { homedir } from "node:os";
import { join } from "node:path";

export function routinesHome(): string {
  const override = process.env.ROUTINES_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".routines");
}

export function registryDir(): string {
  return join(routinesHome(), "registry");
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

// Daemon's own stdout/stderr log directory (distinct from per-run logs).
export function daemonLogDir(): string {
  return join(routinesHome(), "daemon");
}
