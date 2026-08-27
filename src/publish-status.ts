import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { collectStatus, type StatusRow } from "./status.ts";
import { listRuns, readRun, type RunSummary } from "./runs.ts";

export const ROUTINES_APP_ID = "routines";

type FieldMap = Record<string, string>;

export interface PublishStatusOptions {
  now?: Date;
  runLimit?: number;
  logTailBytes?: number;
  runRetentionCount?: number;
  runRetentionDays?: number;
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
  fleetSummary: FieldMap;
  written: {
    snapshots: number;
    rows: number;
    runSummaries: number;
    fleetRows: number;
    runSummariesV2: number;
    deletedRunSummariesV2: number;
    fleetSummaries: number;
  };
  dryRun: boolean;
}

export interface LastDbPublisherClient {
  autoIdentity(): Promise<{ userHash: string }>;
  declareAppSchema(appId: string, schema: SchemaDefinition): Promise<{ canonical: string; schemaName: string }>;
  queryByKey(opts: { schemaHash: string; keyHash: string; keyRange?: string; fields: string[] }): Promise<FieldMap | null>;
  queryByHash(opts: { schemaHash: string; keyHash: string; fields: string[]; maxRows: number }): Promise<Array<{ keyRange: string; fields: FieldMap }>>;
  mutate(opts: { schemaHash: string; keyHash: string; keyRange?: string; fields: FieldMap; mutationType: "create" | "update" | "delete" }): Promise<void>;
}

export interface LastDbDeliveryClient {
  stageDelivery(request: DeliveryStageRequest): Promise<DeliveryStageResult>;
  approveDelivery(deliveryId: string): Promise<DeliveryApproveResult>;
}

export interface DeliveryRecipient {
  recipientPubkey: string;
  messagingPublicKey: string;
  messagingPseudonym: string;
  recipientDisplayName?: string;
}

export interface DeliverStatusOptions extends PublishStatusOptions {
  recipient: DeliveryRecipient;
  maxRecords?: number;
  approve?: boolean;
  boundedView?: boolean;
  legacyView?: boolean;
  deliveryClient?: LastDbDeliveryClient;
}

export interface DeliverStatusResult extends PublishStatusResult {
  deliveryRequest: DeliveryStageRequest;
  staged: DeliveryStageResult | null;
  approved: DeliveryApproveResult | null;
  boundedView: FleetReadResult | null;
}

export interface FleetReadResult {
  summary: FieldMap;
  rows: FieldMap[];
  attempts: number;
}

export interface ReadFleetStatusOptions {
  client?: LastDbPublisherClient;
  schemaHashes?: Record<SchemaKey, string>;
  maxAttempts?: number;
}

export interface LegacyFleetReadResult {
  snapshot: FieldMap;
  rows: FieldMap[];
}

export interface LegacySnapshotOptions {
  client?: LastDbPublisherClient;
  schemaHashes?: Record<SchemaKey, string>;
}

export interface DeliveryStageRequest {
  recipient_pubkey: string;
  recipient_display_name?: string;
  messaging_public_key: string;
  messaging_pseudonym: string;
  mode: "snapshot";
  max_records: number;
  legs: Array<{
    schema_name: string;
    fields: string[];
    hash_keys?: string[];
  }>;
}

export interface DeliveryStageResult {
  deliveryId: string;
  recordCount: number;
  fields: string[];
  note: string;
}

export interface DeliveryApproveResult {
  deliveryId: string;
  shared: number;
  messageType: string;
}

type SchemaKey = "snapshot" | "status" | "runSummary" | "fleetStatus" | "fleetSummary" | "runSummaryV2";
type FieldType = "String" | { Array: "String" };

export interface SchemaDefinition {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement: string;
  schema_type: "Hash" | "HashRange";
  key: { hash_field: string; range_field?: string };
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
  "fleet_bucket",
  "sk",
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
  "harness_pid",
  "current_run",
  "current_run_dir",
  "current_started_at",
  "fenced",
  "last_outcome",
  "last_outcome_detail",
  "noop_rate",
  "useful_rate",
  "outcome_window",
  "content_digest",
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

export const ROUTINES_FLEET_ID = "routines";
export const FLEET_STATUS_BUCKET_COUNT = 16;
export const ROUTINE_STATUS_MAX_BYTES = 8 * 1024;
export const LAST_OUTCOME_DETAIL_MAX_BYTES = 1024;
export const FLEET_SUMMARY_MAX_BYTES = 4 * 1024;
export const RUN_SUMMARY_V2_MAX_BYTES = 8 * 1024;
export const RUN_SUMMARY_LOG_TAIL_MAX_BYTES = 2 * 1024;

const FLEET_ROUTINE_STATUS_FIELDS = [...STATUS_FIELDS] as const;

const FLEET_SUMMARY_FIELDS = [
  "fleet_id",
  "captured_at",
  "layout_version",
  "bucket_count",
  "row_count",
  "active_count",
  "paused_count",
  "fenced_count",
  "running_count",
  "error_count",
  "run_summary_count",
  "situations_ok",
  "situations_error",
  "content_digest",
] as const;

const RUN_SUMMARY_V2_FIELDS = RUN_SUMMARY_FIELDS.filter((field) => field !== "slug");

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
  fleetStatus: hashRangeSchema(
    "FleetRoutineStatus",
    `A bounded routine status index split across ${FLEET_STATUS_BUCKET_COUNT} stable fleet buckets; each row stays below ${ROUTINE_STATUS_MAX_BYTES} bytes`,
    [...FLEET_ROUTINE_STATUS_FIELDS],
    "fleet_bucket",
    "sk",
  ),
  fleetSummary: schema(
    "FleetSummary",
    `A bounded fleet manifest with counts and a digest; each row stays below ${FLEET_SUMMARY_MAX_BYTES} bytes`,
    [...FLEET_SUMMARY_FIELDS],
    "fleet_id",
  ),
  runSummaryV2: hashRangeSchema(
    "RoutineRunSummaryV2",
    `A bounded run summary keyed by routine and run stamp; each row stays below ${RUN_SUMMARY_V2_MAX_BYTES} bytes and log_tail stays below ${RUN_SUMMARY_LOG_TAIL_MAX_BYTES} bytes`,
    [...RUN_SUMMARY_V2_FIELDS],
    "id",
    "stamp",
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
  const preparedRows = publication.rows.map(routineStatusFields);
  const fleetSummary = buildFleetSummary(publication, preparedRows);
  const client = options.client ?? newLastDbPublisherClient();
  const schemaHashes = await declareSchemas(client);
  publication.snapshot.schema_hashes_json = JSON.stringify(schemaHashes);

  const written = {
    snapshots: 0,
    rows: 0,
    runSummaries: 0,
    fleetRows: 0,
    runSummariesV2: 0,
    deletedRunSummariesV2: 0,
    fleetSummaries: 0,
  };

  if (!options.dryRun) {
    for (const prepared of preparedRows) {
      const existing = await client.queryByKey({
        schemaHash: schemaHashes.status,
        keyHash: requiredField(prepared, "id"),
        fields: [...STATUS_FIELDS],
      });
      if (existing?.content_digest === prepared.content_digest) continue;
      await client.mutate({
        schemaHash: schemaHashes.status,
        keyHash: requiredField(prepared, "id"),
        fields: prepared,
        mutationType: existing ? "update" : "create",
      });
      written.rows += 1;
      written.fleetRows += 1;
    }
    for (const run of publication.runSummaries) {
      const id = requiredField(run, "id");
      const stamp = requiredField(run, "stamp");
      const existing = await client.queryByKey({
        schemaHash: schemaHashes.runSummaryV2,
        keyHash: id,
        keyRange: stamp,
        fields: [...RUN_SUMMARY_V2_FIELDS],
      });
      if (!existing) {
        const fields = Object.fromEntries(RUN_SUMMARY_V2_FIELDS.map((field) => [field, run[field] ?? ""]));
        await client.mutate({
          schemaHash: schemaHashes.runSummaryV2,
          keyHash: id,
          keyRange: stamp,
          fields,
          mutationType: "create",
        });
        written.runSummariesV2 += 1;
      }
    }
    for (const row of publication.rows) {
      written.deletedRunSummariesV2 += await enforceRunSummaryRetention(client, schemaHashes.runSummaryV2, {
        id: requiredField(row, "id"),
        now: new Date(publication.capturedAt),
        keepCount: positiveInt(options.runRetentionCount, 100),
        keepDays: positiveInt(options.runRetentionDays, 30),
      });
    }
    await upsert(
      client,
      schemaHashes.fleetSummary,
      requiredField(fleetSummary, "fleet_id"),
      fleetSummary,
      [...FLEET_SUMMARY_FIELDS],
    );
    written.fleetSummaries = 1;
  }

  return {
    ...publication,
    schemaHashes,
    fleetSummary,
    dryRun: options.dryRun === true,
    written,
  };
}

export async function deliverFleetStatus(options: DeliverStatusOptions): Promise<DeliverStatusResult> {
  const publisherClient = options.client ?? newLastDbPublisherClient();
  const publication = await publishFleetStatus({ ...options, client: publisherClient });
  const useLegacyView = options.legacyView === true;
  if (useLegacyView) assertLegacyReadWindow(options.now ?? new Date());
  const boundedView = !useLegacyView && !options.dryRun
    ? await readFleetStatus({ client: publisherClient, schemaHashes: publication.schemaHashes })
    : null;
  if (useLegacyView && !options.dryRun) {
    await readLegacyFleetStatus({ client: publisherClient, schemaHashes: publication.schemaHashes });
  }
  const deliveryRequest = useLegacyView
    ? buildDeliveryStageRequest({
        schemaHashes: publication.schemaHashes,
        recipient: options.recipient,
        maxRecords: options.maxRecords,
      })
    : buildBoundedDeliveryStageRequest({
        schemaHashes: publication.schemaHashes,
        recipient: options.recipient,
        maxRecords: options.maxRecords,
      });

  if (options.dryRun) {
    return { ...publication, deliveryRequest, staged: null, approved: null, boundedView };
  }

  const client = options.deliveryClient ?? newLastDbDeliveryClient();
  const staged = await client.stageDelivery(deliveryRequest);
  const approved = options.approve ? await client.approveDelivery(staged.deliveryId) : null;
  return { ...publication, deliveryRequest, staged, approved, boundedView };
}

export async function readFleetStatus(options: ReadFleetStatusOptions = {}): Promise<FleetReadResult> {
  const client = options.client ?? newLastDbPublisherClient();
  const schemaHashes = options.schemaHashes ?? await declareSchemas(client);
  const maxAttempts = positiveInt(options.maxAttempts, 3);
  let lastReason = "no attempt";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const summary = await client.queryByKey({
      schemaHash: schemaHashes.fleetSummary,
      keyHash: ROUTINES_FLEET_ID,
      fields: [...FLEET_SUMMARY_FIELDS],
    });
    if (!summary) {
      lastReason = "FleetSummary is missing";
      continue;
    }
    const bucketCount = boundedInt(summary.bucket_count, 1, 64);
    const expectedRows = boundedInt(summary.row_count, 0, 100_000);
    if (bucketCount === null || expectedRows === null) {
      lastReason = "FleetSummary has invalid counts";
      continue;
    }
    const rows: FieldMap[] = [];
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const page = await client.queryByHash({
        schemaHash: schemaHashes.fleetStatus,
        keyHash: fleetBucketKey(ROUTINES_FLEET_ID, bucket),
        fields: [...FLEET_ROUTINE_STATUS_FIELDS],
        maxRows: Math.max(expectedRows + bucketCount, 256),
      });
      rows.push(...page.map((item) => item.fields));
    }
    const stableSummary = await client.queryByKey({
      schemaHash: schemaHashes.fleetSummary,
      keyHash: ROUTINES_FLEET_ID,
      fields: [...FLEET_SUMMARY_FIELDS],
    });
    if (
      !stableSummary ||
      stableSummary.captured_at !== summary.captured_at ||
      stableSummary.content_digest !== summary.content_digest
    ) {
      lastReason = "FleetSummary changed during the bucket read";
      continue;
    }
    if (rows.length !== expectedRows) {
      lastReason = `row count mismatch: expected ${expectedRows}, read ${rows.length}`;
      continue;
    }
    const digest = fleetContentDigest(rows);
    if (digest !== summary.content_digest) {
      lastReason = `content digest mismatch: expected ${summary.content_digest}, read ${digest}`;
      continue;
    }
    const byId = new Map(rows.map((row) => [requiredField(row, "id"), row]));
    if (byId.size !== rows.length) {
      lastReason = "duplicate routine IDs exist across fleet buckets";
      continue;
    }
    return {
      summary,
      rows: [...byId.values()].sort((a, b) => requiredField(a, "sk").localeCompare(requiredField(b, "sk"))),
      attempts: attempt,
    };
  }
  throw new LastDbPublishError("fleet_view_inconsistent", `Bounded fleet view did not converge: ${lastReason}.`);
}

export async function readLegacyFleetStatus(options: LegacySnapshotOptions = {}): Promise<LegacyFleetReadResult> {
  const client = options.client ?? newLastDbPublisherClient();
  const schemaHashes = options.schemaHashes ?? await declareSchemas(client);
  const snapshot = await client.queryByKey({
    schemaHash: schemaHashes.snapshot,
    keyHash: "fleet-latest",
    fields: [...SNAPSHOT_FIELDS],
  });
  if (!snapshot) throw new LastDbPublishError("legacy_fleet_missing", "Legacy fleet snapshot is missing.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.rows_json ?? "");
  } catch {
    throw new LastDbPublishError("legacy_fleet_invalid", "Legacy fleet snapshot rows_json is invalid.");
  }
  if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new LastDbPublishError("legacy_fleet_invalid", "Legacy fleet snapshot rows_json is not a row array.");
  }
  return { snapshot, rows: parsed as FieldMap[] };
}

export async function clearLegacyFleetSnapshot(options: LegacySnapshotOptions = {}): Promise<boolean> {
  const client = options.client ?? newLastDbPublisherClient();
  const schemaHashes = options.schemaHashes ?? await declareSchemas(client);
  const existing = await client.queryByKey({
    schemaHash: schemaHashes.snapshot,
    keyHash: "fleet-latest",
    fields: [...SNAPSHOT_FIELDS],
  });
  if (!existing || !existing.rows_json) return false;
  const fields = Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, existing[field] ?? ""]));
  fields.rows_json = "";
  await client.mutate({
    schemaHash: schemaHashes.snapshot,
    keyHash: "fleet-latest",
    fields,
    mutationType: "update",
  });
  return true;
}

function assertLegacyReadWindow(now: Date): void {
  const raw = process.env.ROUTINES_FLEET_LEGACY_READ_UNTIL ?? "";
  const deadline = Date.parse(raw);
  const maxWindowMs = 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(deadline) || deadline <= now.getTime() || deadline - now.getTime() > maxWindowMs) {
    throw new LastDbPublishError(
      "legacy_read_window_closed",
      "Legacy fleet reads require ROUTINES_FLEET_LEGACY_READ_UNTIL within the next seven days.",
    );
  }
}

/** Snapshot fields safe for the ~64KB sealed-message cap. Exclude rows_json —
 * the admin tab reconstructs the grid from RoutineStatus rows, and embedding
 * the full fleet JSON twice is what blew past the Exemem size limit. */
const SNAPSHOT_DELIVER_FIELDS = SNAPSHOT_FIELDS.filter((f) => f !== "rows_json");

/** Status fields for deliver — drop free-text detail that can dominate size. */
const STATUS_DELIVER_FIELDS = STATUS_FIELDS.filter((f) => f !== "last_outcome_detail");

const BOUNDED_STATUS_DELIVER_FIELDS = [
  "fleet_bucket",
  "sk",
  "id",
  "status",
  "harness",
  "model",
  "group_id",
  "group_label",
  "next_fire",
  "last_run",
  "running",
  "fenced",
  "last_outcome",
  "noop_rate",
  "useful_rate",
  "content_digest",
  "updated_at",
] as const;

export function buildDeliveryStageRequest(opts: {
  schemaHashes: Record<SchemaKey, string>;
  recipient: DeliveryRecipient;
  maxRecords?: number;
}): DeliveryStageRequest {
  // Default 12 status rows + 1 snapshot keeps sealed size under Exemem's 64KB cap
  // on Tom's full fleet (~50 routines). Override with --max-records when needed.
  const maxRecords = positiveInt(opts.maxRecords, 12);
  return {
    recipient_pubkey: opts.recipient.recipientPubkey,
    ...(opts.recipient.recipientDisplayName ? { recipient_display_name: opts.recipient.recipientDisplayName } : {}),
    messaging_public_key: opts.recipient.messagingPublicKey,
    messaging_pseudonym: opts.recipient.messagingPseudonym,
    mode: "snapshot",
    max_records: maxRecords,
    legs: [
      {
        schema_name: opts.schemaHashes.snapshot,
        fields: [...SNAPSHOT_DELIVER_FIELDS],
        hash_keys: ["fleet-latest"],
      },
      {
        schema_name: opts.schemaHashes.status,
        fields: [...STATUS_DELIVER_FIELDS],
      },
    ],
  };
}

export function buildBoundedDeliveryStageRequest(opts: {
  schemaHashes: Record<SchemaKey, string>;
  recipient: DeliveryRecipient;
  maxRecords?: number;
}): DeliveryStageRequest {
  return {
    recipient_pubkey: opts.recipient.recipientPubkey,
    ...(opts.recipient.recipientDisplayName ? { recipient_display_name: opts.recipient.recipientDisplayName } : {}),
    messaging_public_key: opts.recipient.messagingPublicKey,
    messaging_pseudonym: opts.recipient.messagingPseudonym,
    mode: "snapshot",
    max_records: positiveInt(opts.maxRecords, 128),
    legs: [
      {
        schema_name: opts.schemaHashes.fleetSummary,
        fields: [...FLEET_SUMMARY_FIELDS],
        hash_keys: [ROUTINES_FLEET_ID],
      },
      {
        schema_name: opts.schemaHashes.fleetStatus,
        fields: [...BOUNDED_STATUS_DELIVER_FIELDS],
        hash_keys: Array.from({ length: FLEET_STATUS_BUCKET_COUNT }, (_, bucket) =>
          fleetBucketKey(ROUTINES_FLEET_ID, bucket),
        ),
      },
    ],
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
    harness_pid: row.harnessPid == null ? "" : String(row.harnessPid),
    current_run: row.currentRun ?? "",
    current_run_dir: row.currentRunDir ?? "",
    current_started_at: row.currentStartedAt ?? "",
    fenced: typeof row.fenced === "string" ? row.fenced : boolString(row.fenced),
    last_outcome: row.lastOutcome ?? "",
    last_outcome_detail: truncateUtf8(row.lastOutcomeDetail ?? "", LAST_OUTCOME_DETAIL_MAX_BYTES),
    noop_rate: rateString(row.noopRate),
    useful_rate: rateString(row.usefulRate),
    outcome_window: String(row.outcomeWindow),
    updated_at: capturedAt,
  };
}

function runSummaryFields(id: string, run: RunSummary, capturedAt: string, logTailBytes: number): FieldMap {
  const cappedLogTailBytes = Math.min(logTailBytes, RUN_SUMMARY_LOG_TAIL_MAX_BYTES);
  const detail = readRun(id, run.stamp, cappedLogTailBytes);
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
    outcome_detail: truncateUtf8(run.outcomeDetail ?? "", LAST_OUTCOME_DETAIL_MAX_BYTES),
    duration_ms: run.durationMs == null ? "" : String(run.durationMs),
    log_tail: redactLogTail(combinedTail, cappedLogTailBytes),
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

export function fleetStatusBucket(id: string, fleetId = ROUTINES_FLEET_ID): string {
  const bucket = createHash("sha256").update(id).digest()[0]! % FLEET_STATUS_BUCKET_COUNT;
  return fleetBucketKey(fleetId, bucket);
}

export function fleetBucketKey(fleetId: string, bucket: number): string {
  return `${fleetId}#${bucket.toString(16).padStart(2, "0")}`;
}

export function fleetStatusSortKey(fields: FieldMap): string {
  return `${requiredField(fields, "status")}#${requiredField(fields, "group_id")}#${requiredField(fields, "id")}`;
}

function routineStatusFields(row: FieldMap): FieldMap {
  const fields: FieldMap = {
    ...row,
    fleet_bucket: fleetStatusBucket(requiredField(row, "id")),
    sk: fleetStatusSortKey(row),
  };
  fields.content_digest = contentDigest(fields, new Set(["content_digest", "updated_at"]));
  assertSerializedSize(fields, ROUTINE_STATUS_MAX_BYTES, `RoutineStatus/${requiredField(row, "id")}`);
  return fields;
}

function buildFleetSummary(publication: FleetPublication, rows: FieldMap[]): FieldMap {
  const summary: FieldMap = {
    fleet_id: ROUTINES_FLEET_ID,
    captured_at: publication.capturedAt,
    layout_version: "1",
    bucket_count: String(FLEET_STATUS_BUCKET_COUNT),
    row_count: String(rows.length),
    active_count: String(rows.filter((row) => row.status === "active").length),
    paused_count: String(rows.filter((row) => row.status === "paused").length),
    fenced_count: String(rows.filter((row) => row.fenced !== "" && row.fenced !== "false").length),
    running_count: String(rows.filter((row) => row.running === "true").length),
    error_count: String(rows.filter((row) => row.last_outcome === "error").length),
    run_summary_count: String(publication.runSummaries.length),
    situations_ok: publication.snapshot.situations_ok ?? "false",
    situations_error: publication.snapshot.situations_error ?? "",
    content_digest: fleetContentDigest(rows),
  };
  assertSerializedSize(summary, FLEET_SUMMARY_MAX_BYTES, `FleetSummary/${ROUTINES_FLEET_ID}`);
  return summary;
}

function fleetContentDigest(rows: FieldMap[]): string {
  const normalized: Array<[string, string]> = rows
    .map((row): [string, string] => [requiredField(row, "id"), requiredField(row, "content_digest")])
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function enforceRunSummaryRetention(
  client: LastDbPublisherClient,
  schemaHash: string,
  opts: { id: string; now: Date; keepCount: number; keepDays: number },
): Promise<number> {
  const rows = await client.queryByHash({
    schemaHash,
    keyHash: opts.id,
    fields: [...RUN_SUMMARY_V2_FIELDS],
    maxRows: Math.max(opts.keepCount + 1, 4096),
  });
  rows.sort((a, b) => b.keyRange.localeCompare(a.keyRange));
  const cutoffMs = opts.now.getTime() - opts.keepDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const [index, row] of rows.entries()) {
    const startedMs = Date.parse(row.fields.started_at ?? "");
    const expired = Number.isFinite(startedMs) && startedMs < cutoffMs;
    if (index < opts.keepCount && !expired) continue;
    await client.mutate({
      schemaHash,
      keyHash: opts.id,
      keyRange: row.keyRange,
      fields: row.fields,
      mutationType: "delete",
    });
    deleted += 1;
  }
  return deleted;
}

function contentDigest(fields: FieldMap, excluded: Set<string>): string {
  const normalized = Object.keys(fields)
    .filter((key) => !excluded.has(key))
    .sort()
    .map((key) => [key, fields[key] ?? ""]);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function truncateUtf8(input: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(input);
  if (bytes.length <= maxBytes) return input;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function assertSerializedSize(fields: FieldMap, maxBytes: number, label: string): void {
  const size = new TextEncoder().encode(JSON.stringify(fields)).length;
  if (size > maxBytes) throw new LastDbPublishError("row_too_large", `${label} is ${size} bytes; limit is ${maxBytes}.`);
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

function hashRangeSchema(
  name: string,
  purpose: string,
  fields: string[],
  hashField: string,
  rangeField: string,
): SchemaDefinition {
  const definition = schema(name, purpose, fields, hashField);
  return {
    ...definition,
    schema_type: "HashRange",
    key: { hash_field: hashField, range_field: rangeField },
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

function boundedInt(value: string | undefined, min: number, max: number): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
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
type LastDbFetch = (input: Parameters<typeof globalThis.fetch>[0], init?: FetchInit) => Promise<Response>;
type LastDbClientOptions = {
  socketPath?: string;
  nodeUrl?: string;
  fetchImpl?: LastDbFetch;
};

export function newLastDbPublisherClient(opts: LastDbClientOptions = {}): LastDbPublisherClient {
  const callJson = newLastDbJsonCaller(opts);
  let userHash = "";

  return {
    async autoIdentity() {
      const body = await callJson("GET", "/api/system/auto-identity", undefined, userHash);
      const hash = objectString(body, "user_hash");
      if (!hash) throw new LastDbPublishError("auto_identity_bad_response", "LastDB auto-identity returned no user_hash.");
      userHash = hash;
      return { userHash };
    },
    async declareAppSchema(appId, schemaDef) {
      const body = await callJson("POST", "/api/apps/declare-schema", { app_id: appId, schema: schemaDef }, userHash);
      const canonical = objectString(body, "canonical") || objectString((body as Record<string, unknown>)?.data, "canonical");
      const schemaName = objectString(body, "schema") || `${appId}/${schemaDef.name}`;
      if (!canonical) {
        throw new LastDbPublishError("schema_declare_bad_response", `LastDB returned no canonical hash for ${appId}/${schemaDef.name}.`);
      }
      return { canonical, schemaName };
    },
    async queryByKey({ schemaHash, keyHash, keyRange, fields }) {
      const body = await callJson("POST", "/api/query", {
        schema_name: schemaHash,
        fields,
        filter: keyRange === undefined ? { HashKey: keyHash } : { HashRangeKey: { hash: keyHash, range: keyRange } },
        limit: 1,
        offset: 0,
      }, userHash);
      const rows = queryRows(body);
      return rows.find((row) => row.key.hash === keyHash && (keyRange === undefined || row.key.range === keyRange))?.fields ?? null;
    },
    async queryByHash({ schemaHash, keyHash, fields, maxRows }) {
      const pageSize = Math.min(200, maxRows);
      const out: Array<{ keyRange: string; fields: FieldMap }> = [];
      for (let offset = 0; out.length < maxRows; offset += pageSize) {
        const body = await callJson("POST", "/api/query", {
          schema_name: schemaHash,
          fields,
          filter: { HashKey: keyHash },
          limit: Math.min(pageSize, maxRows - out.length),
          offset,
        }, userHash);
        const rows = queryRows(body).filter((row) => row.key.hash === keyHash && row.key.range);
        out.push(...rows.map((row) => ({ keyRange: row.key.range!, fields: row.fields })));
        if (rows.length < pageSize) break;
      }
      return out;
    },
    async mutate({ schemaHash, keyHash, keyRange, fields, mutationType }) {
      await callJson("POST", "/api/mutation", {
        type: "mutation",
        schema: schemaHash,
        fields_and_values: fields,
        key_value: { hash: keyHash, range: keyRange ?? null },
        mutation_type: mutationType,
      }, userHash);
    },
  };
}

export function newLastDbDeliveryClient(opts: LastDbClientOptions = {}): LastDbDeliveryClient {
  const callJson = newLastDbJsonCaller(opts);
  return {
    async stageDelivery(request) {
      const body = await callJson("POST", "/api/sharing/deliver", request);
      const data = dataObject(body);
      const delivery = dataObject(data.delivery);
      const preview = dataObject(delivery.preview);
      const deliveryId = objectString(delivery, "delivery_id");
      if (!deliveryId) {
        throw new LastDbPublishError("delivery_stage_bad_response", "LastDB deliver stage returned no delivery_id.");
      }
      return {
        deliveryId,
        recordCount: objectNumber(preview, "record_count"),
        fields: objectStringArray(preview, "fields"),
        note: objectString(data, "note"),
      };
    },
    async approveDelivery(deliveryId) {
      const body = await callJson("POST", `/api/sharing/deliveries/${encodeURIComponent(deliveryId)}/approve`);
      const data = dataObject(body);
      return {
        deliveryId: objectString(data, "delivery_id") || deliveryId,
        shared: objectNumber(data, "shared"),
        messageType: objectString(data, "message_type"),
      };
    },
  };
}

function newLastDbJsonCaller(opts: LastDbClientOptions = {}) {
  const socketPath = resolveSocketPath(opts.socketPath);
  const nodeUrl = (opts.nodeUrl ?? process.env.ROUTINES_LASTDB_NODE_URL ?? "http://localhost:9001").replace(/\/+$/, "");
  const fetchImpl: LastDbFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return async function callJson(method: "GET" | "POST", path: string, body?: unknown, userHash = ""): Promise<unknown> {
    const headers: Record<string, string> = { "X-LastDB-Client": ROUTINES_APP_ID };
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
      res = await fetchImpl(url, init);
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

function objectNumber(value: unknown, key: string): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function objectStringArray(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function dataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const nested = obj.data;
  return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : obj;
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
