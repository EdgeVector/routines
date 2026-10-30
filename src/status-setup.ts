/** Explicit status schema setup and scope-bound value conversion. Ordinary requests read this config only. */
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { stateDir } from "./paths.ts";
import { dataObject, LastDbPublishError, object, type LastDbPublisherClient } from "./status-client.ts";
import { ACTIVE_SCHEMA_KEYS, canonicalDefinition, definitionIdentity, fieldRules, ROUTINES_APP_ID, SCHEMAS, type SchemaDefinition, type SchemaKey } from "./status-schema.ts";

type Binding = { identity: string; runtime: string };
export type StatusSchemaConfig = { version: 2; schemas: Partial<Record<SchemaKey, Binding>> };
type Request = { schema: string; expected_identity: string; target_definition_identity?: string; field_map?: Record<string, string>;
  alternate_keys: NonNullable<SchemaDefinition["alternate_keys"]>; membership: { kind: "field_exists"; field: string } };
type Receipt = { change_id: string; phase: string; durable: true; converted_schemas: string[]; retired_schemas: string[];
  schemas: Request[]; processed_keys: number; expected_keys: number; selected_keys: number; expected_selected_keys: number };
type Scope = { version: 1; source_config_sha256: string | null; target_config_sha256: string; requests: Request[];
  target: StatusSchemaConfig; change_id: string };
const ROUTE = "/api/db/alternate-keys";
const keys = Object.keys(SCHEMAS) as SchemaKey[];
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const identity = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new LastDbPublishError("status_schema_conversion", message);
}
export function statusSchemaPath(): string { return process.env.ROUTINES_STATUS_SCHEMA_CONFIG || join(stateDir(), "status-schemas.json"); }
function readOptional(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function config(value: unknown): StatusSchemaConfig {
  const parsed = object(value), schemas = object(parsed.schemas);
  requireValue(parsed.version === 2 && ACTIVE_SCHEMA_KEYS.every((key) => schemas[key]), "The fleet schema config is incomplete. Run init-status or resume its conversion.");
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
  requireValue(!existsSync(path + ".conversion"), "Resume the saved fleet schema conversion before a normal request.");
  const raw = readOptional(path);
  requireValue(raw, "Fleet schemas are not configured. Run init-status, or convert-status-schemas for existing values.");
  const saved = config(JSON.parse(raw.toString()));
  client.bindSchemas(Object.fromEntries(Object.entries(saved.schemas).map(([key, binding]) => [binding!.runtime, { key: key as SchemaKey, canonical: true }])));
  return { status: saved.schemas.status!.runtime, fleetStatus: saved.schemas.fleetStatus?.runtime ?? "",
    fleetSummary: saved.schemas.fleetSummary!.runtime, runSummaryV2: saved.schemas.runSummaryV2!.runtime,
    snapshot: saved.schemas.snapshot?.runtime ?? "", runSummary: saved.schemas.runSummary?.runtime ?? "" };
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
function removeScope(path: string, expected: Buffer): void {
  requireValue(readFileSync(path).equals(expected), "The saved fleet conversion scope changed.");
  unlinkSync(path);
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
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
    (!source.field_mappers || Object.keys(object(source.field_mappers)).length === 0) &&
    (!source.transform_fields || Object.keys(object(source.transform_fields)).length === 0) && source.identity_hash === definitionIdentity(definition) && typeof source.name === "string" && source.name,
    `Installed ${definition.name} differs from the reviewed fleet definition. No data conversion follows this metadata.`);
  return { identity: source.identity_hash as string, runtime: source.name as string };
}
async function capabilities(client: LastDbPublisherClient, conversion: boolean): Promise<void> {
  const flags = object(dataObject(await client.request("GET", "/api/version")).capabilities);
  requireValue(["owned_app_schemas_v1", "independent_hash_range_v1", "compound_alternate_keys_v1"].every((flag) => flags[flag] === true),
    "Fleet setup requires a compatible LastDB release with owned app schemas and named keys.");
  if (conversion) requireValue(flags.app_schema_conversion_v1 === true && flags.app_schema_field_mapping_v1 === true,
    "Fleet conversion requires a compatible release with app_schema_field_mapping_v1 before the removal upgrade.");
}
function keyFor(source: Record<string, unknown>): SchemaKey {
  const key = keys.find((key) => SCHEMAS[key].name === source.descriptive_name);
  requireValue(key, "An unreviewed Routines schema requires owner review before setup or conversion.");
  return key;
}
function requireOwnedMetadata(source: Record<string, unknown>, key: SchemaKey): Binding {
  const definition = canonicalDefinition(key), binding = validateMetadata(source, definition);
  requireValue(source.independent_fields === true && binding.identity === definitionIdentity(definition) &&
    same(source.alternate_keys ?? {}, definition.alternate_keys ?? {}), "The installed fleet keys or value ownership differ from this release.");
  return binding;
}

export async function initializeStatusSchemas(client: LastDbPublisherClient): Promise<StatusSchemaConfig> {
  const path = statusSchemaPath(), release = lock(path);
  try {
    requireValue(!existsSync(path + ".conversion"), "Resume the saved fleet conversion before setup.");
    const previous = readOptional(path), saved = previous ? config(JSON.parse(previous.toString())) : { version: 2 as const, schemas: {} as StatusSchemaConfig["schemas"] };
    await capabilities(client, false);
    const installed = await directory(client);
    requireValue(installed.every((schema) => schema.independent_fields === true), "Existing Routines values require convert-status-schemas before setup. No schema was declared.");
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

function receipt(value: unknown): Receipt {
  const report = object(dataObject(value).app_schema_conversion);
  requireValue(report.durable === true && typeof report.change_id === "string" && report.change_id &&
    ["backfill", "verifying", "verified", "retiring", "ready", "aborting", "complete", "aborted"].includes(String(report.phase)) &&
    Array.isArray(report.schemas) && Array.isArray(report.converted_schemas) && Array.isArray(report.retired_schemas) && report.retired_schemas.length === 0 &&
    [report.processed_keys, report.expected_keys, report.selected_keys, report.expected_selected_keys].every((count) => Number.isSafeInteger(count) && Number(count) >= 0) &&
    Number(report.processed_keys) <= Number(report.expected_keys) && Number(report.selected_keys) <= Number(report.expected_selected_keys),
    "The node did not return a complete durable fleet conversion receipt.");
  return report as unknown as Receipt;
}
async function conversionStatus(client: LastDbPublisherClient): Promise<Receipt | null> {
  try { return receipt(await client.request("POST", ROUTE, { action: "app_status" })); }
  catch (error) {
    if (error instanceof LastDbPublishError && error.response?.status === 404 && error.response.body === "app conversion is absent") return null;
    throw error;
  }
}
function checkScope(report: Receipt, scope: Scope): void {
  requireValue((!scope.change_id || report.change_id === scope.change_id) && same(report.schemas, scope.requests) &&
    report.retired_schemas.length === 0 && same([...report.converted_schemas].sort(), scope.requests.map(({ schema }) => schema).sort()),
    "Another conversion owns this node, or its fleet membership, fields, keys, or identities differ.");
}
export async function convertStatusSchemas(client: LastDbPublisherClient, options: { apply?: boolean; maintenance?: boolean; abort?: boolean }) {
  requireValue(!options.abort || (options.apply && options.maintenance), "Abort requires --apply --maintenance.");
  const path = statusSchemaPath(), scopePath = path + ".conversion", release = lock(path);
  try {
    await capabilities(client, true);
    const previous = readOptional(path);
    let scopeBytes = readOptional(scopePath), scope: Scope | null = scopeBytes ? JSON.parse(scopeBytes.toString()) : null;
    let report = await conversionStatus(client);
    const pending = report && !["complete", "aborted"].includes(report.phase);
    if (scope) {
      requireValue(scope.version === 1 && same(config(scope.target), scope.target) && digest(bytes(scope.target)) === scope.target_config_sha256 &&
        ((previous === null && scope.source_config_sha256 === null) || (previous !== null && [scope.source_config_sha256, scope.target_config_sha256].includes(digest(previous)))),
        "The saved fleet scope or config changed; review it before resume.");
      requireValue(report || !scope.change_id, "The saved fleet scope has no node receipt.");
      if (report) checkScope(report, scope);
    } else {
      requireValue(!pending && !options.abort, "An active conversion has no saved fleet scope. Owner review is required.");
      const installed = await directory(client);
      requireValue(installed.length > 0, "No existing Routines schemas require conversion; use init-status.");
      const sources = await Promise.all(installed.map(async (entry) => ({ key: keyFor(entry), source: await metadata(client, String(entry.name)) })));
      requireValue(new Set(sources.map(({ key }) => key)).size === sources.length && ACTIVE_SCHEMA_KEYS.every((key) => sources.some((source) => source.key === key)),
        "The existing fleet schema set is incomplete or duplicated. It stays unchanged.");
      const target: StatusSchemaConfig = { version: 2, schemas: {} }, requests: Request[] = [];
      for (const { key, source } of sources) {
        const canonical = canonicalDefinition(key), isCanonical = source.identity_hash === definitionIdentity(canonical);
        const binding = validateMetadata(source, isCanonical ? canonical : SCHEMAS[key]);
        requireValue(source.independent_fields !== true || isCanonical, "An independently owned Routines schema needs a separate supported field transition.");
        target.schemas[key] = { identity: definitionIdentity(canonical), runtime: binding.runtime };
        requests.push({ schema: binding.runtime, expected_identity: binding.identity,
          ...(isCanonical ? {} : { target_definition_identity: definitionIdentity(canonical), field_map: Object.fromEntries(Object.entries(fieldRules(key)).map(([field, [name]]) => [field, name])) }),
          alternate_keys: canonical.alternate_keys ?? {}, membership: { kind: "field_exists", field: String(object(source.key).hash_field) } });
      }
      if (sources.every(({ key, source }) => source.independent_fields === true && same(source.alternate_keys ?? {}, canonicalDefinition(key).alternate_keys ?? {}))) {
        requireValue(previous && same(config(JSON.parse(previous.toString())), target), "Converted Routines values need their exact saved config.");
        return { phase: "complete", already_converted: true };
      }
      requireValue(sources.every(({ source }) => source.independent_fields !== true), "Routines schema models differ; no partial conversion starts.");
      scope = { version: 1, source_config_sha256: previous ? digest(previous) : null, target_config_sha256: digest(bytes(target)), target, requests, change_id: "" };
    }
    requireValue(scope.requests.length === Object.keys(scope.target.schemas).length &&
      new Set(scope.requests.map(({ schema }) => schema)).size === scope.requests.length &&
      Object.entries(scope.target.schemas).every(([key, binding]) => {
        const request = scope.requests.find(({ schema }) => schema === binding!.runtime);
        const canonical = canonicalDefinition(key as SchemaKey);
        if (!request || !identity(request.expected_identity) || !same(request.alternate_keys, canonical.alternate_keys ?? {})) return false;
        const mapped = request.target_definition_identity !== undefined || request.field_map !== undefined;
        return mapped
          ? request.target_definition_identity === binding!.identity &&
            same(request.field_map, Object.fromEntries(Object.entries(fieldRules(key as SchemaKey)).map(([field, [name]]) => [field, name]))) &&
            same(request.membership, { kind: "field_exists", field: SCHEMAS[key as SchemaKey].key.hash_field })
          : request.expected_identity === binding!.identity &&
            same(request.membership, { kind: "field_exists", field: canonical.key.hash_field });
      }), "The saved fleet field, membership, key, or definition scope is invalid.");
    if (!options.apply) return { phase: report?.phase === "aborted" ? "aborted" : "plan", schemas: scope.requests, retire: [] };
    requireValue(options.maintenance, "Use --apply --maintenance for the explicit node request pause.");
    if (!pending) {
      if (report?.phase === "complete" && scope.change_id === report.change_id) {
        requireValue(previous && digest(previous) === scope.target_config_sha256 && scopeBytes, "The completed fleet config or scope differs.");
        removeScope(scopePath, scopeBytes); return report;
      }
      if (report?.phase === "aborted" && scopeBytes) {
        requireValue(previous === null ? scope.source_config_sha256 === null : digest(previous) === scope.source_config_sha256,
          "The aborted fleet conversion does not match the source config.");
        removeScope(scopePath, scopeBytes); scopeBytes = null; scope.change_id = "";
        if (options.abort) return report;
      }
      requireValue(!options.abort, "No unpublished fleet conversion is active.");
      await Promise.all(Object.entries(scope.target.schemas).map(async ([key, binding]) => {
        const request = scope!.requests.find(({ schema }) => schema === binding!.runtime)!;
        const source = await metadata(client, binding!.runtime);
        const actual = validateMetadata(source, request.field_map ? SCHEMAS[key as SchemaKey] : canonicalDefinition(key as SchemaKey));
        requireValue(actual.identity === request.expected_identity && source.independent_fields !== true,
          "A fleet source changed before the request pause. No conversion starts.");
      }));
      scopeBytes = save(scopePath, scopeBytes, scope);
      report = receipt(await client.request("POST", ROUTE, { action: "app_begin", schemas: scope.requests, retire: [], maintenance: true }));
      checkScope(report, scope);
    }
    requireValue(report, "The fleet conversion has no node receipt.");
    scope.change_id = report.change_id;
    scopeBytes = save(scopePath, scopeBytes, scope);
    for (let page = 0; page < 100000; page++) {
      requireValue(readFileSync(scopePath).equals(scopeBytes), "The saved fleet scope changed during conversion.");
      const now = readOptional(path);
      requireValue(now === null ? previous === null : previous !== null && now.equals(previous), "The fleet config changed during conversion.");
      const action = options.abort ? "app_abort" : ["backfill", "verifying"].includes(report.phase) ? "app_page"
        : report.phase === "verified" ? "app_commit" : report.phase === "retiring" ? "app_cleanup"
          : report.phase === "ready" ? "app_finish" : null;
      if (report.phase === "complete" || report.phase === "aborted") {
        removeScope(scopePath, scopeBytes); return report;
      }
      requireValue(action, `Fleet conversion ${report.change_id} remains in ${report.phase}; resume or abort its current phase.`);
      if (action === "app_finish") {
        requireValue(report.processed_keys === report.expected_keys && report.selected_keys === report.expected_selected_keys,
          "Fleet conversion coverage is incomplete; no config is published.");
        await Promise.all(Object.entries(scope.target.schemas).map(async ([key, binding]) => {
          const actual = requireOwnedMetadata(await metadata(client, binding!.runtime), key as SchemaKey);
          requireValue(same(actual, binding), "A published fleet schema differs from its saved target.");
        }));
        save(path, previous, config(scope.target));
        const finished = receipt(await client.request("POST", ROUTE, { action, change_id: report.change_id }));
        checkScope(finished, scope);
        requireValue(finished.phase === "complete", "Resume the fleet conversion to finish its request pause.");
        removeScope(scopePath, scopeBytes); return finished;
      }
      const next = receipt(await client.request("POST", ROUTE, { action, change_id: report.change_id }));
      checkScope(next, scope); report = next;
    }
    throw new LastDbPublishError("conversion_page_limit", "Resume the same fleet conversion after its page bound.");
  } finally { release(); }
}
