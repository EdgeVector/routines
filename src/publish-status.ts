import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { collectStatus, type StatusRow, type StatusSnapshot } from "./status.ts";
import { listRuns, readRun, type RunSummary } from "./runs.ts";

export const ROUTINES_APP_ID = "routines";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type FieldMap = Record<string, string>;

export interface PublishStatusOptions {
  now?: Date;
  runLimit?: number;
  logTailBytes?: number;
  dryRun?: boolean;
  client?: LastDbPublisherClient;
}

export interface FleetPublication {
  capturedAt: string;
  snapshot: FieldMap;
  rows: FieldMap[];
  runSummaries: FieldMap[];
}

export interface PublishStatusResult extends FleetPublication {
  schemaHashes: Record<SchemaKey, string>;
  written: {
    snapshots: number;
    rows: number;
    runSummaries: number;
  };
  dryRun: boolean;
}

export interface LastDbPublisherClient {
  autoIdentity(): Promise<{ userHash: string }>;
  declareAppSchema(appId: string, schema: SchemaDefinition): Promise<{ canonical: string; schemaName: string }>;
  queryByKey(opts: { schemaHash: string; keyHash: string; fields: string[] }): Promise<FieldMap | null>;
  mutate(opts: { schemaHash: string; keyHash: string; fields: FieldMap; mutationType: "create" | "update" }): Promise<void>;
}

type SchemaKey = "snapshot" | "status" | "runSummary";
type FieldType = "String" | { Array: "String" };

interface SchemaDefinition {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement: string;
  schema_type: "Hash";
  key: { hash_field: string };
  fields: string[];
  field_types: Record<string, FieldType>;
  field_descriptions: Record<string, string>;
  field_data_classifications: Record<string, { sensitivity_level: number; data_domain: string }>;
}

const SNAPSHOT_FIELDS = [
  "slug",
  "captured_at",
  "home",
  "situations_ok",
  "situations_error",
  "rows_json",
  "row_count",
  "run_summary_count",
  "schema_hashes_json",
] as const;

const STATUS_FIELDS = [
  "id",
  "status",
  "harness",
  "model",
  "rrule",
  "group_id",
  "group_label",
  "next_fire",
  "last_run",
  "last_exit",
  "running",
  "fenced",
  "last_outcome",
  "last_outcome_detail",
  "noop_rate",
  "useful_rate",
  "outcome_window",
  "updated_at",
] as const;

const RUN_SUMMARY_FIELDS = [
  "slug",
  "id",
  "stamp",
  "started_at",
  "finished_at",
  "exit_code",
  "outcome",
  "outcome_detail",
  "duration_ms",
  "log_tail",
  "updated_at",
] as const;

const SCHEMAS: Record<SchemaKey, SchemaDefinition> = {
  snapshot: schema(
    "RoutineFleetSnapshot",
    "A slim point-in-time routines fleet snapshot safe for admin delivery",
    [...SNAPSHOT_FIELDS],
    "slug",
  ),
  status: schema(
    "RoutineStatus",
    "One slim status row per routine for admin delivery",
    [...STATUS_FIELDS],
    "id",
  ),
  runSummary: schema(
    "RoutineRunSummary",
    "A capped recent run summary for one routine execution, without prompts or full logs",
    [...RUN_SUMMARY_FIELDS],
    "slug",
  ),
};

export function buildFleetPublication(options: PublishStatusOptions = {}): FleetPublication {
  const now = options.now ?? new Date();
  const capturedAt = now.toISOString();
  const runLimit = positiveInt(options.runLimit, 5);
  const logTailBytes = positiveInt(options.logTailBytes, 2048);
  const snap = collectStatus(now);
  const rows = snap.rows.map((row) => statusFields(row, capturedAt));
  const runSummaries = snap.rows.flatMap((row) =>
    listRuns(row.id, runLimit).map((run) => runSummaryFields(row.id, run, capturedAt, logTailBytes)),
  );
  const snapshot: FieldMap = {
    slug: "fleet-latest",
    captured_at: capturedAt,
    home: snap.home,
    situations_ok: boolString(snap.situationsOk),
    situations_error: snap.situationsError ?? "",
    rows_json: JSON.stringify(rows),
    row_count: String(rows.length),
    run_summary_count: String(runSummaries.length),
    schema_hashes_json: "",
  };
  return { capturedAt, snapshot, rows, runSummaries };
}

export async function publishFleetStatus(options: PublishStatusOptions = {}): Promise<PublishStatusResult> {
  const publication = buildFleetPublication(options);
  const client = options.client ?? newLastDbPublisherClient();
  const schemaHashes = await declareSchemas(client);
  publication.snapshot.schema_hashes_json = JSON.stringify(schemaHashes);

  if (!options.dryRun) {
    await upsert(client, schemaHashes.snapshot, requiredField(publication.snapshot, "slug"), publication.snapshot, [...SNAPSHOT_FIELDS]);
    for (const row of publication.rows) {
      await upsert(client, schemaHashes.status, requiredField(row, "id"), row, [...STATUS_FIELDS]);
    }
    for (const run of publication.runSummaries) {
      await upsert(client, schemaHashes.runSummary, requiredField(run, "slug"), run, [...RUN_SUMMARY_FIELDS]);
    }
  }

  return {
    ...publication,
    schemaHashes,
    dryRun: options.dryRun === true,
    written: options.dryRun
      ? { snapshots: 0, rows: 0, runSummaries: 0 }
      : { snapshots: 1, rows: publication.rows.length, runSummaries: publication.runSummaries.length },
  };
}

async function declareSchemas(client: LastDbPublisherClient): Promise<Record<SchemaKey, string>> {
  await client.autoIdentity();
  const out = {} as Record<SchemaKey, string>;
  for (const key of Object.keys(SCHEMAS) as SchemaKey[]) {
    const declared = await client.declareAppSchema(ROUTINES_APP_ID, SCHEMAS[key]);
    out[key] = declared.canonical;
  }
  return out;
}

async function upsert(
  client: LastDbPublisherClient,
  schemaHash: string,
  keyHash: string,
  fields: FieldMap,
  queryFields: string[],
): Promise<void> {
  const existing = await client.queryByKey({ schemaHash, keyHash, fields: queryFields });
  await client.mutate({
    schemaHash,
    keyHash,
    fields,
    mutationType: existing ? "update" : "create",
  });
}

function statusFields(row: StatusRow, capturedAt: string): FieldMap {
  return {
    id: row.id,
    status: row.status,
    harness: row.harness,
    model: row.model,
    rrule: row.rrule,
    group_id: row.groupId,
    group_label: row.groupLabel,
    next_fire: row.nextFire ?? "",
    last_run: row.lastRun ?? "",
    last_exit: row.lastExit == null ? "" : String(row.lastExit),
    running: boolString(row.running),
    fenced: typeof row.fenced === "string" ? row.fenced : boolString(row.fenced),
    last_outcome: row.lastOutcome ?? "",
    last_outcome_detail: row.lastOutcomeDetail ?? "",
    noop_rate: rateString(row.noopRate),
    useful_rate: rateString(row.usefulRate),
    outcome_window: String(row.outcomeWindow),
    updated_at: capturedAt,
  };
}

function runSummaryFields(id: string, run: RunSummary, capturedAt: string, logTailBytes: number): FieldMap {
  const detail = readRun(id, run.stamp, logTailBytes);
  const combinedTail = detail
    ? [detail.summary ?? "", detail.stdoutTail, detail.stderrTail].filter(Boolean).join("\n")
    : "";
  return {
    slug: `${id}/${run.stamp}`,
    id,
    stamp: run.stamp,
    started_at: run.startedAt ?? "",
    finished_at: run.finishedAt ?? "",
    exit_code: run.exitCode == null ? "" : String(run.exitCode),
    outcome: run.outcome,
    outcome_detail: run.outcomeDetail ?? "",
    duration_ms: run.durationMs == null ? "" : String(run.durationMs),
    log_tail: redactLogTail(combinedTail, logTailBytes),
    updated_at: capturedAt,
  };
}

function redactLogTail(input: string, maxBytes: number): string {
  const redacted = input
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|DSN|CREDENTIAL)[A-Z0-9_]*)=([^\s]+)/gi, "$1=<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>");
  const bytes = new TextEncoder().encode(redacted);
  if (bytes.length <= maxBytes) return redacted;
  return new TextDecoder().decode(bytes.slice(bytes.length - maxBytes));
}

function schema(name: string, purpose: string, fields: string[], hashField: string): SchemaDefinition {
  return {
    name,
    owner_app_id: ROUTINES_APP_ID,
    descriptive_name: name,
    purpose_statement: purpose,
    schema_type: "Hash",
    key: { hash_field: hashField },
    fields,
    field_types: Object.fromEntries(fields.map((field) => [field, "String"])) as Record<string, FieldType>,
    field_descriptions: Object.fromEntries(fields.map((field) => [field, field.replaceAll("_", " ")])),
    field_data_classifications: Object.fromEntries(
      fields.map((field) => [field, { sensitivity_level: 0, data_domain: "routines" }]),
    ),
  };
}

function boolString(value: boolean): string {
  return value ? "true" : "false";
}

function rateString(value: number | null): string {
  return value == null ? "" : value.toFixed(3);
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

function requiredField(fields: FieldMap, key: string): string {
  const value = fields[key];
  if (value === undefined) throw new Error(`missing required field ${key}`);
  return value;
}

export class LastDbPublishError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LastDbPublishError";
    this.code = code;
  }
}

type FetchInit = RequestInit & { unix?: string };

export function newLastDbPublisherClient(opts: { socketPath?: string; nodeUrl?: string } = {}): LastDbPublisherClient {
  const socketPath = resolveSocketPath(opts.socketPath);
  const nodeUrl = (opts.nodeUrl ?? process.env.ROUTINES_LASTDB_NODE_URL ?? "http://localhost:9001").replace(/\/+$/, "");
  let userHash = "";

  async function callJson(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (userHash) headers["X-User-Hash"] = userHash;
    let requestBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
    const useSocket = isLoopback(nodeUrl) && existsSync(socketPath);
    const init: FetchInit = { method, headers, body: requestBody };
    if (useSocket) init.unix = socketPath;
    const url = useSocket ? `http://localhost${path}` : `${nodeUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new LastDbPublishError(
        "lastdb_unreachable",
        useSocket
          ? `LastDB is not reachable over ${socketPath}: ${err instanceof Error ? err.message : String(err)}`
          : `LastDB is not reachable at ${nodeUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    const parsed = parseJson(text);
    if (!res.ok) {
      throw new LastDbPublishError(`lastdb_http_${res.status}`, `LastDB ${method} ${path} returned ${res.status}: ${messageFor(parsed)}`);
    }
    return parsed;
  }

  return {
    async autoIdentity() {
      const body = await callJson("GET", "/api/system/auto-identity");
      const hash = objectString(body, "user_hash");
      if (!hash) throw new LastDbPublishError("auto_identity_bad_response", "LastDB auto-identity returned no user_hash.");
      userHash = hash;
      return { userHash };
    },
    async declareAppSchema(appId, schemaDef) {
      const body = await callJson("POST", "/api/apps/declare-schema", { app_id: appId, schema: schemaDef });
      const canonical = objectString(body, "canonical") || objectString((body as Record<string, unknown>)?.data, "canonical");
      const schemaName = objectString(body, "schema") || `${appId}/${schemaDef.name}`;
      if (!canonical) {
        throw new LastDbPublishError("schema_declare_bad_response", `LastDB returned no canonical hash for ${appId}/${schemaDef.name}.`);
      }
      return { canonical, schemaName };
    },
    async queryByKey({ schemaHash, keyHash, fields }) {
      const body = await callJson("POST", "/api/query", {
        schema_name: schemaHash,
        fields,
        filter: { HashKey: keyHash },
        limit: 1,
        offset: 0,
      });
      const rows = queryRows(body);
      return rows.find((row) => row.key.hash === keyHash)?.fields ?? null;
    },
    async mutate({ schemaHash, keyHash, fields, mutationType }) {
      await callJson("POST", "/api/mutation", {
        type: "mutation",
        schema: schemaHash,
        fields_and_values: fields,
        key_value: { hash: keyHash, range: null },
        mutation_type: mutationType,
      });
    },
  };
}

function resolveSocketPath(override?: string): string {
  if (override) return override;
  for (const key of [
    "ROUTINES_LASTDB_SOCKET",
    "LASTDB_SOCKET_PATH",
    "FOLDDB_SOCKET_PATH",
    "FBRAIN_FOLDDB_SOCKET",
    "LASTGIT_SOCKET",
  ]) {
    const value = process.env[key];
    if (value) return value;
  }
  const home = process.env.LASTDB_HOME || join(homedir(), ".lastdb");
  return join(home, "data", "folddb.sock");
}

function isLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function objectString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

function messageFor(body: unknown): string {
  return objectString(body, "message") || objectString(body, "error") || JSON.stringify(body)?.slice(0, 300) || "";
}

function queryRows(body: unknown): Array<{ key: { hash: string | null; range: string | null }; fields: FieldMap }> {
  const raw =
    body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).results)
      ? ((body as Record<string, unknown>).results as unknown[])
      : body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).rows)
        ? ((body as Record<string, unknown>).rows as unknown[])
        : [];
  return raw.map((item) => {
    const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const keyRaw = rec.key;
    const key =
      keyRaw && typeof keyRaw === "object" && !Array.isArray(keyRaw)
        ? {
            hash: objectString(keyRaw, "hash") || null,
            range: objectString(keyRaw, "range") || null,
          }
        : { hash: typeof keyRaw === "string" ? keyRaw : null, range: null };
    const fields = rec.fields && typeof rec.fields === "object" && !Array.isArray(rec.fields) ? (rec.fields as FieldMap) : {};
    return { key, fields };
  });
}
