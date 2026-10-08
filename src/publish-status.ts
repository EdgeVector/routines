import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { collectStatus, type StatusRow } from "./status.ts";
import { listRuns, readRun, type RunSummary } from "./runs.ts";
import { stateDir } from "./paths.ts";

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

export interface PublisherMutation {
  schemaHash: string;
  keyHash: string;
  keyRange?: string;
  fields: FieldMap;
  mutationType: "create" | "update" | "delete";
}

export interface LastDbPublisherClient {
  autoIdentity(): Promise<{ userHash: string }>;
  declareAppSchema(appId: string, schema: SchemaDefinition): Promise<{ canonical: string; schemaName: string }>;
  queryByKey(opts: { schemaHash: string; keyHash: string; keyRange?: string; fields: string[] }): Promise<FieldMap | null>;
  queryByKeys(opts: { schemaHash: string; keyHashes: string[]; fields: string[] }): Promise<Array<{ keyHash: string; fields: FieldMap }>>;
  queryByHash(opts: { schemaHash: string; keyHash: string; fields: string[]; maxRows: number }): Promise<Array<{ keyRange: string; fields: FieldMap }>>;
  queryByHashRangeKeys(opts: {
    schemaHash: string;
    keys: Array<{ hash: string; range: string }>;
    fields: string[];
  }): Promise<Array<{ keyHash: string; keyRange: string; fields: FieldMap }>>;
  mutate(opts: PublisherMutation): Promise<void>;
  mutateBatch(ops: PublisherMutation[]): Promise<void>;
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
/** LastDB `/api/query` page cap (`MAX_QUERY_LIMIT`). Chunk HashKeys / HashRangeKeys at this size. */
const QUERY_KEYS_PAGE = 1000;
/** Conservative `/api/mutations/batch` chunk. One fleet publish stays in one chunk. */
const MUTATION_BATCH_PAGE = 500;
export const ROUTINE_STATUS_MAX_BYTES = 8 * 1024;
export const LAST_OUTCOME_DETAIL_MAX_BYTES = 1024;
export const FLEET_SUMMARY_MAX_BYTES = 4 * 1024;
export const RUN_SUMMARY_V2_MAX_BYTES = 8 * 1024;
export const RUN_SUMMARY_LOG_TAIL_MAX_BYTES = 2 * 1024;

// Keep this marker on the HashRange index. It prevents the catalog from
// reusing the Hash-keyed RoutineStatus layout for the fleet index.
const FLEET_STATUS_LAYOUT_VERSION = "1";
const FLEET_STATUS_SCHEMA_NAME = "FleetRoutineStatusV2";
const FLEET_ROUTINE_STATUS_FIELDS = [...STATUS_FIELDS, "schema_layout_version"] as const;

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
    FLEET_STATUS_SCHEMA_NAME,
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
    deletedStatusRows: 0,
    runSummaries: 0,
    fleetRows: 0,
    runSummariesV2: 0,
    deletedRunSummariesV2: 0,
    fleetSummaries: 0,
  };

  if (!options.dryRun) {
    const currentAddresses = new Map(preparedRows.map((row) => [
      requiredField(row, "id"),
      {
        fleetBucket: requiredField(row, "fleet_bucket"),
        sk: requiredField(row, "sk"),
      },
    ]));
    const { stale: staleRows, fleetByAddress } = await findStaleRoutineRows(
      client,
      schemaHashes.fleetStatus,
      currentAddresses,
    );
    const useWatermark = options.useWatermark !== false;
    const watermarkPath = options.watermarkPath ?? publishWatermarkPath();
    const capturedMs = new Date(publication.capturedAt).getTime();
    const state = useWatermark
      ? loadPublishWatermark(watermarkPath, schemaHashes.runSummaryV2)
      : emptyPublishWatermark(schemaHashes.runSummaryV2);
    const runsById = new Map<string, FieldMap[]>();
    for (const run of publication.runSummaries) {
      const id = requiredField(run, "id");
      const list = runsById.get(id) ?? [];
      list.push(run);
      runsById.set(id, list);
    }
    const runPlans = publication.rows.map((row) => planRoutineRuns(row, runsById, state, useWatermark, capturedMs));
    const statusIds = uniqueSortedIds([
      ...preparedRows.map((row) => requiredField(row, "id")),
      ...staleRows.filter((stale) => !currentAddresses.has(stale.id)).map((stale) => stale.id),
    ]);
    const runKeys = uniqueHashRangeKeys(
      runPlans.flatMap((plan) => plan.candidates.map((run) => ({ hash: plan.id, range: requiredField(run, "stamp") }))),
    );
    try {
      const [statusRows, existingRuns] = await Promise.all([
        statusIds.length === 0
          ? Promise.resolve([] as Array<{ keyHash: string; fields: FieldMap }>)
          : client.queryByKeys({
            schemaHash: schemaHashes.status,
            keyHashes: statusIds,
            fields: [...STATUS_FIELDS],
          }),
        runKeys.length === 0
          ? Promise.resolve([] as Array<{ keyHash: string; keyRange: string; fields: FieldMap }>)
          : client.queryByHashRangeKeys({
            schemaHash: schemaHashes.runSummaryV2,
            keys: runKeys,
            fields: [...RUN_SUMMARY_V2_FIELDS],
          }),
      ]);
      const existingStatus = new Map(statusRows.map((row) => [row.keyHash, row.fields]));
      const existingRunKeys = new Set(existingRuns.map((row) => `${row.keyHash}\0${row.keyRange}`));
      const mutations: PublisherMutation[] = [];
      for (const stale of staleRows) {
        const { id } = stale;
        if (!currentAddresses.has(id) && existingStatus.has(id)) {
          mutations.push({
            schemaHash: schemaHashes.status,
            keyHash: id,
            fields: {},
            mutationType: "delete",
          });
        }
        mutations.push({
          schemaHash: schemaHashes.fleetStatus,
          keyHash: stale.fleetBucket,
          keyRange: stale.sk,
          fields: {},
          mutationType: "delete",
        });
        written.deletedStatusRows += 1;
      }
      for (const prepared of preparedRows) {
        const id = requiredField(prepared, "id");
        const existing = existingStatus.get(id);
        if (existing?.content_digest !== prepared.content_digest) {
          mutations.push({
            schemaHash: schemaHashes.status,
            keyHash: id,
            fields: primaryStatusFields(prepared),
            mutationType: existing ? "update" : "create",
          });
          written.rows += 1;
        }
        const fleetBucket = requiredField(prepared, "fleet_bucket");
        const sk = requiredField(prepared, "sk");
        const existingFleet = fleetByAddress.get(fleetAddressKey(fleetBucket, sk));
        if (existingFleet?.content_digest !== prepared.content_digest) {
          mutations.push({
            schemaHash: schemaHashes.fleetStatus,
            keyHash: fleetBucket,
            keyRange: sk,
            fields: prepared,
            mutationType: existingFleet ? "update" : "create",
          });
          written.fleetRows += 1;
        }
      }
      const createdById = new Map<string, number>();
      for (const plan of runPlans) {
        for (const run of plan.candidates) {
          const stamp = requiredField(run, "stamp");
          if (existingRunKeys.has(`${plan.id}\0${stamp}`)) continue;
          mutations.push({
            schemaHash: schemaHashes.runSummaryV2,
            keyHash: plan.id,
            keyRange: stamp,
            fields: Object.fromEntries(RUN_SUMMARY_V2_FIELDS.map((field) => [field, run[field] ?? ""])),
            mutationType: "create",
          });
          written.runSummariesV2 += 1;
          createdById.set(plan.id, (createdById.get(plan.id) ?? 0) + 1);
        }
      }
      await client.mutateBatch(mutations);
      for (const plan of runPlans) {
        if (plan.maxStamp !== plan.watermark) state.runs[plan.id] = plan.maxStamp;
      }
      const retentionIds = runPlans
        .filter((plan) => plan.fullPass || (createdById.get(plan.id) ?? 0) > 0)
        .map((plan) => plan.id);
      const retentionDeletes = (
        await Promise.all(retentionIds.map((id) => collectRunSummaryRetentionDeletes(client, schemaHashes.runSummaryV2, {
          id,
          now: new Date(publication.capturedAt),
          keepCount: positiveInt(options.runRetentionCount, 100),
          keepDays: positiveInt(options.runRetentionDays, 30),
        })))
      ).flat();
      written.deletedRunSummariesV2 += retentionDeletes.length;
      for (const id of retentionIds) state.retention[id] = publication.capturedAt;
      await client.mutateBatch(retentionDeletes);
    } finally {
      if (useWatermark) savePublishWatermark(watermarkPath, state, publication.rows.map((row) => requiredField(row, "id")));
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

function fleetAddressKey(fleetBucket: string, sk: string): string {
  return `${fleetBucket}\0${sk}`;
}

interface StaleRoutineScan {
  stale: Array<{ id: string; fleetBucket: string; sk: string }>;
  fleetByAddress: Map<string, FieldMap>;
}

async function findStaleRoutineRows(
  client: LastDbPublisherClient,
  fleetStatusSchemaHash: string,
  currentAddresses: Map<string, { fleetBucket: string; sk: string }>,
): Promise<StaleRoutineScan> {
  const stale = new Map<string, { id: string; fleetBucket: string; sk: string }>();
  const fleetByAddress = new Map<string, FieldMap>();
  const pages = await Promise.all(
    Array.from({ length: FLEET_STATUS_BUCKET_COUNT }, async (_, bucket) => {
      const fleetBucket = fleetBucketKey(ROUTINES_FLEET_ID, bucket);
      const page = await client.queryByHash({
        schemaHash: fleetStatusSchemaHash,
        keyHash: fleetBucket,
        fields: ["id", "sk", "content_digest"],
        maxRows: 100_000,
      });
      return { fleetBucket, page };
    }),
  );
  for (const { fleetBucket, page } of pages) {
    for (const item of page) {
      const id = item.fields.id;
      const sk = item.fields.sk || item.keyRange;
      if (!id || !sk) continue;
      const address = fleetAddressKey(fleetBucket, sk);
      fleetByAddress.set(address, item.fields);
      const current = currentAddresses.get(id);
      if (!current || current.fleetBucket !== fleetBucket || current.sk !== sk) {
        stale.set(address, { id, fleetBucket, sk });
      }
    }
  }
  return {
    stale: [...stale.values()].sort((a, b) =>
      a.id.localeCompare(b.id) || a.fleetBucket.localeCompare(b.fleetBucket) || a.sk.localeCompare(b.sk)
    ),
    fleetByAddress,
  };
}

interface RoutineRunPlan {
  id: string;
  fullPass: boolean;
  watermark: string;
  maxStamp: string;
  candidates: FieldMap[];
}

function planRoutineRuns(
  row: FieldMap,
  runsById: Map<string, FieldMap[]>,
  state: PublishWatermark,
  useWatermark: boolean,
  capturedMs: number,
): RoutineRunPlan {
  const id = requiredField(row, "id");
  // Once per RETENTION_INTERVAL_MS a routine gets a full pass: every run in the
  // window is re-checked (self-heals a wiped store or a lost write) and retention runs.
  const lastRetentionMs = Date.parse(state.retention[id] ?? "");
  const fullPass = !useWatermark
    || !Number.isFinite(lastRetentionMs)
    || capturedMs - lastRetentionMs >= RETENTION_INTERVAL_MS
    || capturedMs < lastRetentionMs;
  const watermark = state.runs[id] ?? "";
  let maxStamp = watermark;
  const candidates: FieldMap[] = [];
  for (const run of runsById.get(id) ?? []) {
    const stamp = requiredField(run, "stamp");
    // Run summaries are immutable per id+stamp: at or below the watermark means already published.
    if (!fullPass && stamp <= watermark) continue;
    candidates.push(run);
    if (stamp > maxStamp) maxStamp = stamp;
  }
  return { id, fullPass, watermark, maxStamp, candidates };
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
  rowIds?: string[];
}): DeliveryStageRequest {
  return buildBoundedDeliveryStageRequests(opts)[0]!;
}

/** Live hourly seal limit is 87382 base64 chars. A HashRange bucket list still
 * serialized the whole 72-row fleet (~118 KiB) on each page. Hash-keyed
 * RoutineStatus batches of 12 match the last successful live slice size. */
const STATUS_IDS_PER_DELIVERY_PAGE = 12;

/** Deliver explicit RoutineStatus Hash keys in small pages. Do not query
 * FleetRoutineStatus from delivery: hash_keys on that HashRange schema still
 * sealed the full fleet. */
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
        fields: [...FLEET_SUMMARY_FIELDS],
        hash_keys: [ROUTINES_FLEET_ID],
      },
      ...(chunk.length === 0
        ? []
        : [{
            schema_name: opts.schemaHashes.status,
            fields: [...BOUNDED_STATUS_DELIVER_FIELDS],
            hash_keys: chunk,
          }]),
    ],
  }));
}

function uniqueSortedIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

function uniqueHashRangeKeys(keys: Array<{ hash: string; range: string }>): Array<{ hash: string; range: string }> {
  const seen = new Set<string>();
  const out: Array<{ hash: string; range: string }> = [];
  for (const key of keys) {
    const id = `${key.hash}\0${key.range}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

function chunkIds(ids: string[], chunkSize: number): string[][] {
  return chunkItems(ids, chunkSize);
}

function chunkItems<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    chunks.push(items.slice(offset, offset + chunkSize));
  }
  return chunks;
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
    schema_layout_version: FLEET_STATUS_LAYOUT_VERSION,
  };
  fields.content_digest = contentDigest(fields, new Set(["content_digest", "updated_at"]));
  assertSerializedSize(fields, ROUTINE_STATUS_MAX_BYTES, `RoutineStatus/${requiredField(row, "id")}`);
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
  assertSerializedSize(summary, FLEET_SUMMARY_MAX_BYTES, `FleetSummary/${ROUTINES_FLEET_ID}`);
  return summary;
}

function fleetContentDigest(rows: FieldMap[]): string {
  const normalized: Array<[string, string]> = rows
    .map((row): [string, string] => [requiredField(row, "id"), requiredField(row, "content_digest")])
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function collectRunSummaryRetentionDeletes(
  client: LastDbPublisherClient,
  schemaHash: string,
  opts: { id: string; now: Date; keepCount: number; keepDays: number },
): Promise<PublisherMutation[]> {
  const rows = await client.queryByHash({
    schemaHash,
    keyHash: opts.id,
    fields: [...RUN_SUMMARY_V2_FIELDS],
    maxRows: Math.max(opts.keepCount + 1, 4096),
  });
  rows.sort((a, b) => b.keyRange.localeCompare(a.keyRange));
  const cutoffMs = opts.now.getTime() - opts.keepDays * 24 * 60 * 60 * 1000;
  const deletes: PublisherMutation[] = [];
  for (const [index, row] of rows.entries()) {
    const startedMs = Date.parse(row.fields.started_at ?? "");
    const expired = Number.isFinite(startedMs) && startedMs < cutoffMs;
    if (index < opts.keepCount && !expired) continue;
    deletes.push({
      schemaHash,
      keyHash: opts.id,
      keyRange: row.keyRange,
      fields: row.fields,
      mutationType: "delete",
    });
  }
  return deletes;
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
    async queryByKeys({ schemaHash, keyHashes, fields }) {
      const unique = uniqueSortedIds(keyHashes);
      if (unique.length === 0) return [];
      const pages = await Promise.all(
        chunkIds(unique, QUERY_KEYS_PAGE).map((chunk) =>
          callJson("POST", "/api/query", {
            schema_name: schemaHash,
            fields,
            filter: { HashKeys: chunk },
            limit: chunk.length,
            offset: 0,
          }, userHash),
        ),
      );
      const wanted = new Set(unique);
      const out: Array<{ keyHash: string; fields: FieldMap }> = [];
      const seen = new Set<string>();
      for (const body of pages) {
        for (const row of queryRows(body)) {
          const keyHash = row.key.hash;
          if (!keyHash || !wanted.has(keyHash) || seen.has(keyHash)) continue;
          seen.add(keyHash);
          out.push({ keyHash, fields: row.fields });
        }
      }
      return out;
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
    async queryByHashRangeKeys({ schemaHash, keys, fields }) {
      const unique = uniqueHashRangeKeys(keys);
      if (unique.length === 0) return [];
      const pages = await Promise.all(
        chunkItems(unique, QUERY_KEYS_PAGE).map((chunk) =>
          callJson("POST", "/api/query", {
            schema_name: schemaHash,
            fields,
            filter: { HashRangeKeys: chunk.map((key) => [key.hash, key.range]) },
            limit: chunk.length,
            offset: 0,
          }, userHash),
        ),
      );
      const wanted = new Set(unique.map((key) => `${key.hash}\0${key.range}`));
      const out: Array<{ keyHash: string; keyRange: string; fields: FieldMap }> = [];
      const seen = new Set<string>();
      for (const body of pages) {
        for (const row of queryRows(body)) {
          const keyHash = row.key.hash;
          const keyRange = row.key.range;
          if (!keyHash || !keyRange) continue;
          const id = `${keyHash}\0${keyRange}`;
          if (!wanted.has(id) || seen.has(id)) continue;
          seen.add(id);
          out.push({ keyHash, keyRange, fields: row.fields });
        }
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
    async mutateBatch(ops) {
      if (ops.length === 0) return;
      for (const chunk of chunkItems(ops, MUTATION_BATCH_PAGE)) {
        await callJson("POST", "/api/mutations/batch", {
          mutations: chunk.map((op) => ({
            type: "mutation",
            schema: op.schemaHash,
            fields_and_values: op.fields,
            key_value: { hash: op.keyHash, range: op.keyRange ?? null },
            mutation_type: op.mutationType,
          })),
        }, userHash);
      }
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
