/** Local record of the exact fleet schema names. The installer places the schemas. */
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./paths.ts";
import { LastDbPublishError, type LastDbPublisherClient } from "./status-client.ts";
import { SCHEMA_NAMES, type SchemaKey } from "./status-schema.ts";

type Binding = { name: string; runtime: string };
export type StatusSchemaConfig = { version: 3; schemas: Record<SchemaKey, Binding> };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new LastDbPublishError("status_schema_setup", message);
}
export function statusSchemaPath(): string { return process.env.ROUTINES_STATUS_SCHEMA_CONFIG || join(stateDir(), "status-schemas.json"); }
function readOptional(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function loadStatusSchemas(client: LastDbPublisherClient): Record<SchemaKey, string> {
  client.bindSchemas(Object.fromEntries((Object.keys(SCHEMA_NAMES) as SchemaKey[]).map((key) => [SCHEMA_NAMES[key], { key, canonical: true }])));
  return { ...SCHEMA_NAMES };
}

export function acquireStatusConfigLock(): () => void { return lock(statusSchemaPath()); }
function lock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const filename = path + ".lock";
  let fd: number;
  try { fd = openSync(filename, "wx", 0o600); }
  catch { throw new LastDbPublishError("status_schema_busy", "Another fleet schema operation owns this config. Review a stale lock before removal."); }
  writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd);
  const held = statSync(filename);
  return () => {
    closeSync(fd);
    let now;
    try { now = statSync(filename); }
    catch { throw new LastDbPublishError("status_schema_lock_changed", "The fleet config lock disappeared; review its owner before another write."); }
    requireValue(now.ino === held.ino && now.dev === held.dev && now.uid === held.uid, "The fleet config lock changed; it stays in place.");
    unlinkSync(filename);
  };
}
function save(path: string, previous: Buffer | null, value: unknown): Buffer {
  const current = readOptional(path);
  requireValue(current === null ? previous === null : previous !== null && current.equals(previous), "The saved fleet operation changed; review it before resume.");
  const next = bytes(value), temporary = `${path}.${process.pid}.${Date.now()}.new`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, next); fsyncSync(fd); }
  catch (error) { closeSync(fd); unlinkSync(temporary); throw error; }
  closeSync(fd);
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return next;
}

function binding(key: SchemaKey): Binding {
  return { name: SCHEMA_NAMES[key], runtime: SCHEMA_NAMES[key] };
}

export function initializeStatusSchemas(): StatusSchemaConfig {
  const path = statusSchemaPath(), release = lock(path);
  try {
    const previous = readOptional(path);
    const saved: StatusSchemaConfig = {
      version: 3,
      schemas: { status: binding("status"), runSummaryV2: binding("runSummaryV2"), fleetSummary: binding("fleetSummary") },
    };
    save(path, previous, saved);
    return saved;
  } finally { release(); }
}
