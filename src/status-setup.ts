/** Explicit status schema setup. Ordinary requests read this config only.
 *
 * The one-time conversion of shared fleet values (`convert-status-schemas`) is gone.
 * It drove `POST /api/db/alternate-keys`, which LastDB API 15 removed together with the
 * app conversion capabilities. Setup requires API 13 or later, where every declared
 * schema owns its values. A new home starts empty, so `init-status` declares the owned schemas. */
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./paths.ts";
import { dataObject, LastDbPublishError, nodeApiVersion, object, OWNED_SCHEMAS_API_VERSION, type LastDbPublisherClient } from "./status-client.ts";
import { ACTIVE_SCHEMA_KEYS, canonicalDefinition, definitionIdentity, ROUTINES_APP_ID, SCHEMAS, type SchemaDefinition, type SchemaKey } from "./status-schema.ts";

type Binding = { identity: string; runtime: string };
export type StatusSchemaConfig = { version: 2; schemas: Partial<Record<SchemaKey, Binding>> };
const keys = Object.keys(SCHEMAS) as SchemaKey[];
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const identity = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new LastDbPublishError("status_schema_setup", message);
}
export function statusSchemaPath(): string { return process.env.ROUTINES_STATUS_SCHEMA_CONFIG || join(stateDir(), "status-schemas.json"); }
function readOptional(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function config(value: unknown): StatusSchemaConfig {
  const parsed = object(value), schemas = object(parsed.schemas);
  requireValue(parsed.version === 2 && ACTIVE_SCHEMA_KEYS.every((key) => schemas[key]), "The fleet schema config is incomplete. Run init-status.");
  for (const [key, value] of Object.entries(schemas)) {
    const binding = object(value);
    requireValue(keys.includes(key as SchemaKey) && identity(binding.identity) && typeof binding.runtime === "string" && binding.runtime,
      "The fleet schema config contains an invalid binding.");
    requireValue(binding.identity === definitionIdentity(canonicalDefinition(key as SchemaKey)), "A saved fleet definition differs from this app release.");
  }
  requireValue(new Set(Object.values(schemas).map((value) => object(value).runtime)).size === Object.keys(schemas).length,
    "Two fleet record types resolve to the same runtime schema.");
  return parsed as unknown as StatusSchemaConfig;
}
export function loadStatusSchemas(client: LastDbPublisherClient): Record<SchemaKey, string> {
  const path = statusSchemaPath();
  requireNoConversionScope(path);
  const raw = readOptional(path);
  requireValue(raw, "Fleet schemas are not configured. Run init-status.");
  const saved = config(JSON.parse(raw.toString()));
  client.bindSchemas(Object.fromEntries(Object.entries(saved.schemas).map(([key, binding]) => [binding!.runtime, { key: key as SchemaKey, canonical: true }])));
  return { status: saved.schemas.status!.runtime, fleetStatus: saved.schemas.fleetStatus?.runtime ?? "",
    fleetSummary: saved.schemas.fleetSummary!.runtime, runSummaryV2: saved.schemas.runSummaryV2!.runtime,
    snapshot: saved.schemas.snapshot?.runtime ?? "", runSummary: saved.schemas.runSummary?.runtime ?? "" };
}

// An older release saved a scope file next to the config while a conversion ran.
// This release cannot resume or abort that conversion, so it refuses to guess.
function requireNoConversionScope(path: string): void {
  requireValue(!existsSync(path + ".conversion"),
    `An older release left a fleet conversion scope at ${path}.conversion. This release has no conversion; review that file and remove it.`);
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
async function directory(client: LastDbPublisherClient): Promise<Record<string, unknown>[]> {
  const reply = dataObject(await client.request("GET", "/api/schemas"));
  requireValue(reply.ready === true && Array.isArray(reply.schemas), "The schema directory is not ready.");
  return reply.schemas.map(object).filter((schema) => schema.owner_app_id === ROUTINES_APP_ID);
}
async function metadata(client: LastDbPublisherClient, name: string): Promise<Record<string, unknown>> {
  const reply = dataObject(await client.request("GET", `/api/schema/${encodeURIComponent(name)}`));
  return object(reply.schema ?? reply);
}
function validateMetadata(source: Record<string, unknown>, definition: SchemaDefinition): Binding {
  const key = object(source.key);
  requireValue(source.owner_app_id === ROUTINES_APP_ID && source.descriptive_name === definition.descriptive_name &&
    source.schema_type === definition.schema_type && Array.isArray(source.fields) && same([...source.fields].sort(), [...definition.fields].sort()) &&
    key.hash_field === definition.key.hash_field && (key.range_field ?? null) === (definition.key.range_field ?? null) &&
    same(source.field_types, definition.field_types) && same(source.field_descriptions, definition.field_descriptions) &&
    same(source.field_data_classifications, definition.field_data_classifications) &&
    (!source.transform_fields || Object.keys(object(source.transform_fields)).length === 0) && source.identity_hash === definitionIdentity(definition) && typeof source.name === "string" && source.name,
    `Installed ${definition.name} differs from the reviewed fleet definition.`);
  return { identity: source.identity_hash as string, runtime: source.name as string };
}
// The one value-ownership check: from API 13 (lastdb#803) every declared schema owns its
// values, so no installed or declared schema needs its own check.
async function capabilities(client: LastDbPublisherClient): Promise<void> {
  const version = await client.nodeVersion(), flags = object(version.capabilities);
  requireValue(nodeApiVersion(version) >= OWNED_SCHEMAS_API_VERSION,
    `Fleet setup requires LastDB API ${OWNED_SCHEMAS_API_VERSION} or later, where every declared schema owns its values.`);
  requireValue(["owned_app_schemas_v1", "independent_hash_range_v1", "compound_alternate_keys_v1"].every((flag) => flags[flag] === true),
    "Fleet setup requires a compatible LastDB release with owned app schemas and named keys.");
}
function keyFor(source: Record<string, unknown>): SchemaKey {
  const key = keys.find((key) => SCHEMAS[key].name === source.descriptive_name);
  requireValue(key, "An unreviewed Routines schema requires owner review before setup.");
  return key;
}
function requireOwnedMetadata(source: Record<string, unknown>, key: SchemaKey): Binding {
  const definition = canonicalDefinition(key), binding = validateMetadata(source, definition);
  requireValue(binding.identity === definitionIdentity(definition) &&
    same(source.alternate_keys ?? {}, definition.alternate_keys ?? {}), "The installed fleet identity or keys differ from this release.");
  return binding;
}

export async function initializeStatusSchemas(client: LastDbPublisherClient): Promise<StatusSchemaConfig> {
  const path = statusSchemaPath(), release = lock(path);
  try {
    requireNoConversionScope(path);
    const previous = readOptional(path), saved = previous ? config(JSON.parse(previous.toString())) : { version: 2 as const, schemas: {} as StatusSchemaConfig["schemas"] };
    await capabilities(client);
    const installed = await directory(client);
    const current = await Promise.all(installed.map(async (entry) => {
      const key = keyFor(entry), source = await metadata(client, String(entry.name));
      return { key, binding: requireOwnedMetadata(source, key) };
    }));
    requireValue(new Set(current.map(({ key }) => key)).size === current.length, "Several installed schemas claim the same Routines record type.");
    for (const { key, binding } of current) {
      requireValue(!saved.schemas[key] || same(saved.schemas[key], binding), "A saved Routines binding differs from its installed schema.");
      saved.schemas[key] = binding;
    }
    const declared = await Promise.all(ACTIVE_SCHEMA_KEYS.map(async (key) => {
      const definition = canonicalDefinition(key), reply = await client.declareAppSchema(ROUTINES_APP_ID, definition);
      const binding = requireOwnedMetadata(await metadata(client, reply.canonical), key);
      requireValue(binding.identity === reply.identity, "A Routines declaration returned a different identity.");
      return { key, binding };
    }));
    for (const { key, binding } of declared) saved.schemas[key] = binding;
    save(path, previous, config(saved));
    return saved;
  } finally { release(); }
}
