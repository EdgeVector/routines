import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { collectStatus, type StatusRow } from "./status.ts";
import { listRuns, readRun, type RunSummary } from "./runs.ts";
import { stateDir } from "./paths.ts";
import { acquireStatusConfigLock, loadStatusSchemas } from "./status-setup.ts";

import { ROUTINES_APP_ID, ROUTINES_FLEET_ID, FLEET_STATUS_BUCKET_COUNT, ROUTINE_STATUS_MAX_BYTES,
  LAST_OUTCOME_DETAIL_MAX_BYTES, FLEET_SUMMARY_MAX_BYTES, RUN_SUMMARY_V2_MAX_BYTES,
  RUN_SUMMARY_LOG_TAIL_MAX_BYTES, SNAPSHOT_FIELDS, STATUS_FIELDS,
  RUN_SUMMARY_V2_FIELDS, FLEET_SUMMARY_FIELDS, wireFields, wireFieldNames, type SchemaKey } from "./status-schema.ts";
export { ROUTINES_APP_ID, ROUTINES_FLEET_ID, FLEET_STATUS_BUCKET_COUNT, ROUTINE_STATUS_MAX_BYTES,
  LAST_OUTCOME_DETAIL_MAX_BYTES, FLEET_SUMMARY_MAX_BYTES, RUN_SUMMARY_V2_MAX_BYTES, RUN_SUMMARY_LOG_TAIL_MAX_BYTES } from "./status-schema.ts";

import { newLastDbPublisherClient, newLastDbDeliveryClient, LastDbPublishError,
  type FieldMap, type LastDbPublisherClient, type LastDbDeliveryClient, type DeliveryStageRequest,
  type DeliveryStageResult, type DeliveryApproveResult, type Mutation } from "./status-client.ts";
export { newLastDbPublisherClient, newLastDbDeliveryClient, LastDbPublishError } from "./status-client.ts";
export type { FieldMap, LastDbPublisherClient, LastDbDeliveryClient, DeliveryStageRequest, DeliveryStageResult, DeliveryApproveResult } from "./status-client.ts";

export interface PublishStatusOptions {
  now?: Date;
  runLimit?: number;
  logTailBytes?: number;
  runRetentionCount?: number;
  runRetentionDays?: number;
  dryRun?: boolean;
  client?: LastDbPublisherClient;
  /** Override the watermark file path (default: <ROUTINES_HOME>/state/publish-watermark.json). */
  watermarkPath?: string;
  /** Set false to ignore and not write the watermark (every run is re-checked, retention runs for all). */
  useWatermark?: boolean;
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
    deletedStatusRows: number;
    runSummaries: number;
    fleetRows: number;
    runSummariesV2: number;
    deletedRunSummariesV2: number;
    fleetSummaries: number;
  };
  dryRun: boolean;
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
  deliveryRequests: DeliveryStageRequest[];
  staged: DeliveryStageResult | null;
  stagedPages: DeliveryStageResult[];
  approved: DeliveryApproveResult | null;
  approvedPages: DeliveryApproveResult[];
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

export function buildFleetPublication(options: PublishStatusOptions = {}): FleetPublication {
  const now = options.now ?? new Date();
  const capturedAt = now.toISOString();
  const runLimit = positiveInt(options.runLimit, 5);
  const logTailBytes = positiveInt(options.logTailBytes, 2048);
  const snap = collectStatus(now);
  if (snap.errors.length) throw new LastDbPublishError("registry_incomplete", "The routine registry is incomplete; no fleet mutation follows this snapshot.");
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
  const release = acquireStatusConfigLock();
  try {
    const client = options.client ?? newLastDbPublisherClient();
    const schemaHashes = loadStatusSchemas(client);
    const publication = buildFleetPublication(options);
    const preparedRows = publication.rows.map(routineStatusFields);
    const fleetSummary = buildFleetSummary(publication, preparedRows);
    publication.snapshot.schema_hashes_json = JSON.stringify(schemaHashes);
    const written = { snapshots: 0, rows: 0, deletedStatusRows: 0, runSummaries: 0,
      fleetRows: 0, runSummariesV2: 0, deletedRunSummariesV2: 0, fleetSummaries: 0 };
    if (!options.dryRun) {
      const currentIds = new Set(preparedRows.map((row) => requiredField(row, "id")));
      const [stale, existing] = await Promise.all([
        findStaleRoutineRows(client, schemaHashes.status, currentIds),
        client.queryByKeys(preparedRows.map((row) => ({
          schemaHash: schemaHashes.status, keyHash: requiredField(row, "id"), fields: [...STATUS_FIELDS],
        }))),
      ]);
      const statusWrites: Mutation[] = stale.map((row) => ({
        schemaHash: schemaHashes.status, keyHash: requiredField(row, "id"), fields: {}, mutationType: "delete",
        expected: { field: "updated_at", value: requiredField(row, "updated_at") },
      }));
      preparedRows.forEach((row, index) => {
        if (existing[index]?.content_digest === row.content_digest) return;
        statusWrites.push({ schemaHash: schemaHashes.status, keyHash: requiredField(row, "id"),
          fields: primaryStatusFields(row), mutationType: existing[index] ? "update" : "create",
          ...(existing[index] ? { expected: { field: "updated_at", value: requiredField(existing[index]!, "updated_at") } } : {}) });
        written.rows++;
      });
      await client.mutateBatch(statusWrites);
      written.deletedStatusRows = stale.length;

      const useWatermark = options.useWatermark !== false;
      const watermarkPath = options.watermarkPath ?? publishWatermarkPath();
      const capturedMs = Date.parse(publication.capturedAt);
      const state = useWatermark ? loadPublishWatermark(watermarkPath, schemaHashes.runSummaryV2) : emptyPublishWatermark(schemaHashes.runSummaryV2);
      const fullPass = new Set(publication.rows.map((row) => requiredField(row, "id")).filter((id) => {
        const previous = Date.parse(state.retention[id] ?? "");
        return !useWatermark || !Number.isFinite(previous) || capturedMs < previous || capturedMs - previous >= RETENTION_INTERVAL_MS;
      }));
      const selectedRuns = publication.runSummaries.filter((run) => fullPass.has(requiredField(run, "id")) ||
        requiredField(run, "stamp") > (state.runs[requiredField(run, "id")] ?? ""));
      const savedRuns = await client.queryByKeys(selectedRuns.map((run) => ({ schemaHash: schemaHashes.runSummaryV2,
        keyHash: requiredField(run, "id"), keyRange: requiredField(run, "stamp"), fields: [...RUN_SUMMARY_V2_FIELDS] })));
      const runWrites: Mutation[] = [];
      const retentionIds = new Set(fullPass);
      selectedRuns.forEach((run, index) => {
        if (savedRuns[index]) return;
        const id = requiredField(run, "id");
        const fields = Object.fromEntries(RUN_SUMMARY_V2_FIELDS.map((field) => [field, run[field] ?? ""]));
        assertSerializedSize(wireFields("runSummaryV2", fields), RUN_SUMMARY_V2_MAX_BYTES, `RoutineRunSummaryV2/${id}/${requiredField(run, "stamp")}`);
        runWrites.push({ schemaHash: schemaHashes.runSummaryV2, keyHash: id, keyRange: requiredField(run, "stamp"),
          fields, mutationType: "create" });
        retentionIds.add(id);
      });
      await client.mutateBatch(runWrites);
      written.runSummariesV2 = runWrites.length;
      for (const run of selectedRuns) {
        const id = requiredField(run, "id"), stamp = requiredField(run, "stamp");
        if (stamp > (state.runs[id] ?? "")) state.runs[id] = stamp;
      }
      try {
        const ids = [...retentionIds];
        const rows = await client.queryByHashes(ids.map((id) => ({ schemaHash: schemaHashes.runSummaryV2, keyHash: id,
          fields: [...RUN_SUMMARY_V2_FIELDS], maxRows: 100_000 })));
        const deletes = rows.flatMap((rows, index) => retentionMutations(schemaHashes.runSummaryV2, ids[index]!, rows, {
          now: new Date(publication.capturedAt), keepCount: positiveInt(options.runRetentionCount, 100), keepDays: positiveInt(options.runRetentionDays, 30),
        }));
        await client.mutateBatch(deletes);
        written.deletedRunSummariesV2 = deletes.length;
        for (const id of ids) state.retention[id] = publication.capturedAt;
      } finally {
        if (useWatermark) savePublishWatermark(watermarkPath, state, publication.rows.map((row) => requiredField(row, "id")));
      }
      const [summary] = await client.queryByKeys([{ schemaHash: schemaHashes.fleetSummary,
        keyHash: requiredField(fleetSummary, "fleet_id"), fields: [...FLEET_SUMMARY_FIELDS] }]);
      await client.mutateBatch([{ schemaHash: schemaHashes.fleetSummary, keyHash: requiredField(fleetSummary, "fleet_id"),
        fields: fleetSummary, mutationType: summary ? "update" : "create",
        ...(summary ? { expected: { field: "captured_at", value: requiredField(summary, "captured_at") } } : {}) }]);
      written.fleetSummaries = 1;
    }
    return { ...publication, schemaHashes, fleetSummary, dryRun: options.dryRun === true, written };
  } finally { release(); }
}

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface PublishWatermark {
  version: 1;
  /** RoutineRunSummaryV2 schema hash the watermark was recorded against. */
  schemaHash: string;
  /** Newest run stamp confirmed present in the store, per routine id. */
  runs: Record<string, string>;
  /** ISO time of the last full pass (all window runs re-checked + retention), per routine id. */
  retention: Record<string, string>;
}

export function publishWatermarkPath(): string {
  return join(stateDir(), "publish-watermark.json");
}

function emptyPublishWatermark(schemaHash: string): PublishWatermark {
  return { version: 1, schemaHash, runs: {}, retention: {} };
}

function loadPublishWatermark(path: string, schemaHash: string): PublishWatermark {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PublishWatermark>;
    if (parsed.version === 1 && parsed.schemaHash === schemaHash && parsed.runs && parsed.retention) {
      return { version: 1, schemaHash, runs: { ...parsed.runs }, retention: { ...parsed.retention } };
    }
  } catch {
    // Missing or corrupt file: start empty, which means one full pass.
  }
  return emptyPublishWatermark(schemaHash);
}

/** Merge with the on-disk file so two publishers do not erase each other; keep the newer value. */
function savePublishWatermark(path: string, state: PublishWatermark, currentIds: string[]): void {
  try {
    const disk = loadPublishWatermark(path, state.schemaHash);
    const runs: Record<string, string> = {};
    const retention: Record<string, string> = {};
    for (const id of currentIds) {
      const a = state.runs[id] ?? "";
      const b = disk.runs[id] ?? "";
      if (a || b) runs[id] = a > b ? a : b;
      const ra = state.retention[id] ?? "";
      const rb = disk.retention[id] ?? "";
      if (ra || rb) retention[id] = ra > rb ? ra : rb;
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, schemaHash: state.schemaHash, runs, retention }, null, 2));
    renameSync(tmp, path);
  } catch {
    // The watermark is an optimization. A failed save only costs one extra full pass.
  }
}

async function findStaleRoutineRows(client: LastDbPublisherClient, schema: string, currentIds: Set<string>): Promise<FieldMap[]> {
  const pages = await client.queryByHashes(Array.from({ length: FLEET_STATUS_BUCKET_COUNT }, (_, bucket) => ({
    schemaHash: schema, keyName: "by_fleet" as const, keyHash: fleetBucketKey(ROUTINES_FLEET_ID, bucket),
    fields: ["id", "fleet_bucket", "sk", "updated_at"], maxRows: 100_000,
  })));
  const fields = pages.flat().map((row) => row.fields), ids = fields.map((row) => requiredField(row, "id"));
  if (new Set(ids).size !== ids.length) throw new LastDbPublishError("fleet_membership_ambiguous", "The fleet alternate contains duplicate routine identifiers.");
  return fields.filter((row) => !currentIds.has(requiredField(row, "id")));
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
  const deliveryRequests = useLegacyView
    ? [buildDeliveryStageRequest({
        schemaHashes: publication.schemaHashes,
        recipient: options.recipient,
        maxRecords: options.maxRecords,
      })]
    : buildBoundedDeliveryStageRequests({
        schemaHashes: publication.schemaHashes,
        recipient: options.recipient,
        maxRecords: options.maxRecords,
        rowIds: (boundedView?.rows ?? publication.rows).map((row) => row.id ?? ""),
      });
  const deliveryRequest = deliveryRequests[0]!;

  if (options.dryRun) {
    return {
      ...publication,
      deliveryRequest,
      deliveryRequests,
      staged: null,
      stagedPages: [],
      approved: null,
      approvedPages: [],
      boundedView,
    };
  }

  const client = options.deliveryClient ?? newLastDbDeliveryClient();
  const stagedPages: DeliveryStageResult[] = [];
  const approvedPages: DeliveryApproveResult[] = [];
  for (const request of deliveryRequests) {
    const page = await client.stageDelivery(request);
    stagedPages.push(page);
    if (options.approve) approvedPages.push(await client.approveDelivery(page.deliveryId));
  }
  return {
    ...publication,
    deliveryRequest,
    deliveryRequests,
    staged: stagedPages[0] ?? null,
    stagedPages,
    approved: approvedPages[0] ?? null,
    approvedPages,
    boundedView,
  };
}

export async function readFleetStatus(options: ReadFleetStatusOptions = {}): Promise<FleetReadResult> {
  const client = options.client ?? newLastDbPublisherClient();
  const schemaHashes = configuredSchemas(client, options.schemaHashes);
  const maxAttempts = positiveInt(options.maxAttempts, 3);
  let lastReason = "no attempt";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const [summary] = await client.queryByKeys([{
      schemaHash: schemaHashes.fleetSummary,
      keyHash: ROUTINES_FLEET_ID,
      fields: [...FLEET_SUMMARY_FIELDS],
    }]);
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
    const pages = await client.queryByHashes(Array.from({ length: bucketCount }, (_, bucket) => ({
        schemaHash: schemaHashes.status,
        keyHash: fleetBucketKey(ROUTINES_FLEET_ID, bucket),
        keyName: "by_fleet" as const,
        fields: [...STATUS_FIELDS],
        maxRows: Math.max(expectedRows + bucketCount, 256),
    })));
    const rows = pages.flat().map((item) => item.fields);
    const [stableSummary] = await client.queryByKeys([{
      schemaHash: schemaHashes.fleetSummary,
      keyHash: ROUTINES_FLEET_ID,
      fields: [...FLEET_SUMMARY_FIELDS],
    }]);
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
    if (rows.some((row) => row.content_digest !== contentDigest(row, new Set(["content_digest", "updated_at"])))) {
      lastReason = "a routine status record differs from its content digest";
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
  const schemaHashes = configuredSchemas(client, options.schemaHashes);
  if (!schemaHashes.snapshot) throw new LastDbPublishError("legacy_fleet_missing", "No historical fleet snapshot schema is configured.");
  const [snapshot] = await client.queryByKeys([{
    schemaHash: schemaHashes.snapshot,
    keyHash: "fleet-latest",
    fields: [...SNAPSHOT_FIELDS],
  }]);
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
  const schemaHashes = configuredSchemas(client, options.schemaHashes);
  if (!schemaHashes.snapshot) return false;
  const [existing] = await client.queryByKeys([{
    schemaHash: schemaHashes.snapshot,
    keyHash: "fleet-latest",
    fields: [...SNAPSHOT_FIELDS],
  }]);
  if (!existing || !existing.rows_json) return false;
  const fields = Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, existing[field] ?? ""]));
  fields.rows_json = "";
  await client.mutateBatch([{
    schemaHash: schemaHashes.snapshot,
    keyHash: "fleet-latest",
    fields,
    mutationType: "update",
  }]);
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
        fields: wireFieldNames("snapshot", SNAPSHOT_DELIVER_FIELDS),
        hash_keys: ["fleet-latest"],
      },
      {
        schema_name: opts.schemaHashes.status,
        fields: wireFieldNames("status", STATUS_DELIVER_FIELDS),
      },
    ],
  };
}

export function buildBoundedDeliveryStageRequest(opts: {
  schemaHashes: Record<SchemaKey, string>;
  recipient: DeliveryRecipient;
  maxRecords?: number;
  rowIds?: string[];
}): DeliveryStageRequest {
  return buildBoundedDeliveryStageRequests(opts)[0]!;
}

/** Live hourly seal limit is 87382 base64 chars. A HashRange bucket list still
 * serialized the whole 72-row fleet (~118 KiB) on each page. Hash-keyed
 * RoutineStatus batches of 12 match the last successful live slice size. */
const STATUS_IDS_PER_DELIVERY_PAGE = 12;

/** Deliver explicit primary keys in bounded pages, after the complete by_fleet read. */
export function buildBoundedDeliveryStageRequests(opts: {
  schemaHashes: Record<SchemaKey, string>;
  recipient: DeliveryRecipient;
  maxRecords?: number;
  rowIds?: string[];
}): DeliveryStageRequest[] {
  const ids = uniqueSortedIds(opts.rowIds ?? []);
  const chunkSize = positiveInt(opts.maxRecords, STATUS_IDS_PER_DELIVERY_PAGE);
  const chunks = ids.length === 0 ? [[]] : chunkIds(ids, chunkSize);
  return chunks.map((chunk) => ({
    recipient_pubkey: opts.recipient.recipientPubkey,
    ...(opts.recipient.recipientDisplayName ? { recipient_display_name: opts.recipient.recipientDisplayName } : {}),
    messaging_public_key: opts.recipient.messagingPublicKey,
    messaging_pseudonym: opts.recipient.messagingPseudonym,
    mode: "snapshot" as const,
    max_records: Math.max(chunk.length + 1, 1),
    legs: [
      {
        schema_name: opts.schemaHashes.fleetSummary,
        fields: wireFieldNames("fleetSummary", FLEET_SUMMARY_FIELDS),
        hash_keys: [ROUTINES_FLEET_ID],
      },
      ...(chunk.length === 0
        ? []
        : [{
            schema_name: opts.schemaHashes.status,
            fields: wireFieldNames("status", BOUNDED_STATUS_DELIVER_FIELDS),
            hash_keys: chunk,
          }]),
    ],
  }));
}

function uniqueSortedIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

function chunkIds(ids: string[], chunkSize: number): string[][] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    chunks.push(ids.slice(offset, offset + chunkSize));
  }
  return chunks;
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
  assertSerializedSize(wireFields("status", fields), ROUTINE_STATUS_MAX_BYTES, `RoutineStatus/${requiredField(row, "id")}`);
  return fields;
}

function primaryStatusFields(row: FieldMap): FieldMap {
  return Object.fromEntries(STATUS_FIELDS.map((field) => [field, row[field] ?? ""]));
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
  assertSerializedSize(wireFields("fleetSummary", summary), FLEET_SUMMARY_MAX_BYTES, `FleetSummary/${ROUTINES_FLEET_ID}`);
  return summary;
}

function fleetContentDigest(rows: FieldMap[]): string {
  const normalized: Array<[string, string]> = rows
    .map((row): [string, string] => [requiredField(row, "id"), requiredField(row, "content_digest")])
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function retentionMutations(schemaHash: string, id: string, rows: Array<{ keyRange: string; fields: FieldMap }>,
  opts: { now: Date; keepCount: number; keepDays: number }): Mutation[] {
  const sorted = [...rows].sort((a, b) => b.keyRange.localeCompare(a.keyRange));
  const cutoffMs = opts.now.getTime() - opts.keepDays * 24 * 60 * 60 * 1000;
  return sorted.filter((row, index) => {
    const startedMs = Date.parse(row.fields.started_at ?? "");
    return index >= opts.keepCount || (Number.isFinite(startedMs) && startedMs < cutoffMs);
  }).map((row) => ({ schemaHash, keyHash: id, keyRange: row.keyRange, fields: {}, mutationType: "delete",
    expected: { field: "updated_at", value: requiredField(row.fields, "updated_at") } }));
}

function configuredSchemas(client: LastDbPublisherClient, supplied?: Record<SchemaKey, string>): Record<SchemaKey, string> {
  const configured = loadStatusSchemas(client);
  if (supplied && Object.entries(configured).some(([key, runtime]) => supplied[key as SchemaKey] !== runtime)) {
    throw new LastDbPublishError("status_schema_changed", "The fleet schema config changed; repeat the request with its current bindings.");
  }
  return configured;
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
