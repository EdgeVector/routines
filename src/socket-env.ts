import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANONICAL_SOCKET = "folddb.sock";
const FULL_SURFACE_SOCKET = "folddb-full.sock";

const SOCKET_ENV_KEYS = [
  "FOLDDB_SOCKET_PATH",
  "FBRAIN_FOLDDB_SOCKET",
  "LASTGIT_SOCKET",
  "LASTDB_SOCKET_PATH",
] as const;

export type SocketEnvKey = (typeof SOCKET_ENV_KEYS)[number];

export function discoveredRoutineSocketEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<SocketEnvKey, string>> {
  const socket = discoverLiveSocket(env);
  if (!socket) return {};

  const out: Partial<Record<SocketEnvKey, string>> = {};
  for (const key of SOCKET_ENV_KEYS) {
    if (!env[key] || env[key]?.length === 0) out[key] = socket;
  }
  return out;
}

function discoverLiveSocket(env: NodeJS.ProcessEnv): string | null {
  const home = env.LASTDB_HOME || join(homedir(), ".lastdb");
  const dataDir = join(home, "data");
  if (existsSync(join(dataDir, CANONICAL_SOCKET))) return null;

  const full = join(dataDir, FULL_SURFACE_SOCKET);
  return existsSync(full) ? full : null;
}

