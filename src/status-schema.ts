/** Fixed schema and key rules for fleet publication. No requests or state access. */
import { createHash } from "node:crypto";

export type SchemaKey = "snapshot" | "status" | "runSummary" | "fleetStatus" | "fleetSummary" | "runSummaryV2";
export type FieldType = "String" | { Array: "String" };

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
  independent_fields?: boolean;
  alternate_keys?: Record<string, { hash_field: string; range_field: null; range_separator: string;
    range_parts: Array<{ field: string; format: "text" }>; missing: "reject" }>;
}

export const SNAPSHOT_FIELDS = [
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

export const STATUS_FIELDS = [
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

export const RUN_SUMMARY_FIELDS = [
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

export const ROUTINES_APP_ID = "routines";
export const ROUTINES_FLEET_ID = "routines";
export const FLEET_STATUS_BUCKET_COUNT = 16;
export const ROUTINE_STATUS_MAX_BYTES = 8 * 1024;
export const LAST_OUTCOME_DETAIL_MAX_BYTES = 1024;
export const FLEET_SUMMARY_MAX_BYTES = 4 * 1024;
export const RUN_SUMMARY_V2_MAX_BYTES = 8 * 1024;
export const RUN_SUMMARY_LOG_TAIL_MAX_BYTES = 2 * 1024;

// Preserve the exact field set of the historical copied status records.
export const FLEET_STATUS_LAYOUT_VERSION = "1";
const FLEET_STATUS_SCHEMA_NAME = "FleetRoutineStatusV2";
export const FLEET_ROUTINE_STATUS_FIELDS = [...STATUS_FIELDS, "schema_layout_version"] as const;

export const FLEET_SUMMARY_FIELDS = [
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

export const RUN_SUMMARY_V2_FIELDS = RUN_SUMMARY_FIELDS.filter((field) => field !== "slug");

export const SCHEMAS: Record<SchemaKey, SchemaDefinition> = {
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

export const ACTIVE_SCHEMA_KEYS = ["status", "runSummaryV2", "fleetSummary"] as const;
export type ActiveSchemaKey = typeof ACTIVE_SCHEMA_KEYS[number];
export type KeptSchemaKey = SchemaKey;

type FieldRule = readonly [name: string, description: string];
const FIELD_RULES: Record<string, FieldRule> = {
  fleet_bucket: ["routine_fleet_bucket_key", "the stable routines fleet hash bucket for one routine"],
  sk: ["routine_fleet_order_key", "the routine status, display group identifier, and routine identifier joined by # in that order"],
  id: ["routine_identifier", "the stable identifier of one scheduled routine"],
  status: ["routine_schedule_status_text", "the active or paused state recorded in a routine schedule"],
  harness: ["routine_harness_name", "the configured agent harness name for a routine"],
  model: ["routine_model_name", "the configured model name for a routine"],
  rrule: ["routine_schedule_rule_text", "the recurrence rule text for a routine schedule"],
  group_id: ["routine_display_group_identifier", "the identifier of the display group for one routine"],
  group_label: ["routine_display_group_label", "the display label of the group for one routine"],
  next_fire: ["routine_next_fire_time_text", "the next routine dispatch time as RFC 3339 text, or empty when no dispatch is due"],
  last_run: ["routine_last_run_time_text", "the last routine run time as RFC 3339 text, or empty when no run exists"],
  last_exit: ["routine_last_exit_code_text", "the decimal exit code of the last routine run, or empty when no completed code exists"],
  running: ["routine_running_flag_text", "the text true or false that reports whether a routine run is active"],
  harness_pid: ["routine_harness_process_identifier_text", "the decimal operating system process identifier of an active routine harness, or empty when absent"],
  current_run: ["routine_current_run_stamp", "the run stamp of the active routine execution, or empty when absent"],
  current_run_dir: ["routine_current_run_directory", "the filesystem directory of the active routine execution, or empty when absent"],
  current_started_at: ["routine_current_start_time_text", "the active routine start time as RFC 3339 text, or empty when absent"],
  fenced: ["routine_dispatch_fence_text", "the routine dispatch fence state as false, true, or a Situation identifier"],
  last_outcome: ["routine_last_run_outcome", "the classified outcome of the most recent routine execution"],
  last_outcome_detail: ["routine_last_run_outcome_detail", "the bounded explanation of the most recent routine execution outcome"],
  noop_rate: ["routine_recent_noop_rate_text", "the recent no-op fraction as decimal text, or empty when no completed outcomes exist"],
  useful_rate: ["routine_recent_useful_rate_text", "the recent useful-outcome fraction as decimal text, or empty when no completed outcomes exist"],
  outcome_window: ["routine_outcome_window_count_text", "the decimal count of recent routine outcomes that form the reported rates"],
  content_digest: ["routine_status_content_sha256", "the SHA-256 digest of the bounded routine status fields excluding the digest and capture time"],
  updated_at: ["routine_record_update_time_text", "the RFC 3339 text for the publication time of a stored routine status or run record"],
  stamp: ["routine_run_stamp", "the stable timestamp stamp that identifies a run under one routine"],
  started_at: ["routine_run_start_time_text", "the routine execution start time as RFC 3339 text, or empty when absent"],
  finished_at: ["routine_run_finish_time_text", "the routine execution finish time as RFC 3339 text, or empty when the execution has no finish"],
  exit_code: ["routine_run_exit_code_text", "the decimal routine execution exit code, or empty when no code exists"],
  outcome: ["routine_run_outcome", "the classified outcome of one routine execution"],
  outcome_detail: ["routine_run_outcome_detail", "the bounded explanation of one routine execution outcome"],
  duration_ms: ["routine_run_duration_ms_text", "the decimal routine execution duration in milliseconds, or empty when no completed duration exists"],
  log_tail: ["routine_run_log_tail_text", "a bounded redacted suffix of routine execution output without its complete logs or prompts"],
  fleet_id: ["routine_fleet_identifier", "the identifier of one routines fleet"],
  captured_at: ["routine_fleet_capture_time_text", "the RFC 3339 text of the time a routines fleet publication was captured"],
  layout_version: ["routine_fleet_layout_version_text", "the decimal version text of the stable routines fleet bucket layout"],
  bucket_count: ["routine_fleet_bucket_count_text", "the decimal count of stable hash buckets in a routines fleet"],
  row_count: ["routine_fleet_record_count_text", "the decimal number of routine status records in a complete fleet publication"],
  active_count: ["routine_fleet_active_count_text", "the decimal number of active routine schedules in a fleet publication"],
  paused_count: ["routine_fleet_paused_count_text", "the decimal number of paused routine schedules in a fleet publication"],
  fenced_count: ["routine_fleet_fenced_count_text", "the decimal number of fenced routine schedules in a fleet publication"],
  running_count: ["routine_fleet_running_count_text", "the decimal number of active routine executions in a fleet publication"],
  error_count: ["routine_fleet_error_count_text", "the decimal number of routines whose latest recorded outcome is an error"],
  run_summary_count: ["routine_fleet_run_summary_count_text", "the decimal number of recent run summaries selected for a fleet publication"],
  situations_ok: ["routine_fleet_posture_read_flag_text", "the text true or false that reports whether the fleet posture read succeeded"],
  situations_error: ["routine_fleet_posture_error_text", "the error from a failed fleet posture read, or empty when the read succeeded"],
  home: ["routine_fleet_home_directory", "the filesystem home directory recorded by an earlier fleet snapshot"],
  rows_json: ["routine_fleet_snapshot_json", "the bounded JSON-encoded routine status list in an earlier fleet snapshot"],
  schema_hashes_json: ["routine_fleet_schema_bindings_json", "the JSON-encoded schema addresses recorded by an earlier fleet snapshot"],
  schema_layout_version: ["routine_status_layout_marker_text", "the layout marker text recorded on an earlier copied fleet status record"],
};

export function fieldRules(key: KeptSchemaKey): Record<string, FieldRule> {
  const rules = Object.fromEntries(SCHEMAS[key].fields.map((field) => {
    const rule = field === "slug"
      ? key === "snapshot"
        ? ["routine_fleet_snapshot_key", "the stable primary key of an earlier routines fleet snapshot"] as const
        : ["routine_run_legacy_key", "the routine identifier and run stamp joined by / for an earlier run-summary key"] as const
      : key === "fleetSummary" && field === "content_digest"
        ? ["routine_fleet_content_sha256", "the SHA-256 digest of the complete sorted routine identifier and status-digest pairs"] as const
        : FIELD_RULES[field];
    if (!rule) throw new Error(`No canonical field definition for ${SCHEMAS[key].name}.${field}`);
    return [field, rule];
  }));
  if (new Set(Object.values(rules).map(([name]) => name)).size !== SCHEMAS[key].fields.length) {
    throw new Error(`Canonical fields must be one-to-one for ${SCHEMAS[key].name}`);
  }
  return rules;
}

export function canonicalDefinition(key: KeptSchemaKey): SchemaDefinition {
  const source = SCHEMAS[key];
  const rules = fieldRules(key);
  const name = (field: string) => {
    const rule = rules[field];
    if (!rule) throw new Error(`Unknown ${source.name} field ${field}`);
    return rule[0];
  };
  return {
    ...source,
    key: { hash_field: name(source.key.hash_field), ...(source.key.range_field ? { range_field: name(source.key.range_field) } : {}) },
    fields: source.fields.map(name),
    field_types: Object.fromEntries(source.fields.map((field) => [name(field), source.field_types[field]!])),
    field_descriptions: Object.fromEntries(source.fields.map((field) => [name(field), rules[field]![1]])),
    field_data_classifications: Object.fromEntries(source.fields.map((field) => [name(field), source.field_data_classifications[field]!])),
    independent_fields: true,
    alternate_keys: key === "status" ? {
      by_fleet: { hash_field: name("fleet_bucket"), range_field: null, range_separator: "#",
        range_parts: ["status", "group_id", "id"].map((field) => ({ field: name(field), format: "text" })), missing: "reject" },
    } : {},
  };
}

/** Published identity algorithm v2. Runtime addresses always come from LastDB. */
export function definitionIdentity(schema: SchemaDefinition): string {
  const fields = [...new Set(schema.fields)].sort().join(",");
  return createHash("sha256").update(`app:${schema.owner_app_id}:${schema.descriptive_name}:${fields}:key:${schema.key.hash_field}:${schema.key.range_field ?? ""}`).digest("hex");
}

export function wireFields(key: KeptSchemaKey, fields: Record<string, string>): Record<string, string> {
  const rules = fieldRules(key);
  return Object.fromEntries(Object.entries(fields).map(([field, value]) => {
    if (!rules[field]) throw new Error(`Unknown ${SCHEMAS[key].name} field ${field}`);
    return [rules[field]![0], value];
  }));
}

export function wireFieldNames(key: KeptSchemaKey, fields: readonly string[]): string[] {
  const rules = fieldRules(key);
  return fields.map((field) => {
    const rule = rules[field];
    if (!rule) throw new Error(`Unknown ${SCHEMAS[key].name} field ${field}`);
    return rule[0];
  });
}

export function localFields(key: KeptSchemaKey, fields: Record<string, string>): Record<string, string> {
  const reverse = new Map(Object.entries(fieldRules(key)).map(([local, [canonical]]) => [canonical, local]));
  return Object.fromEntries(Object.entries(fields).map(([field, value]) => {
    const local = reverse.get(field);
    if (!local) throw new Error(`Unknown ${SCHEMAS[key].name} response field ${field}`);
    return [local, value];
  }));
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
