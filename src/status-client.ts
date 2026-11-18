/** Fleet records go through the LastDB app API. */
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { AppApiError, LastDbClient, TransportError, UnexpectedResponseError, udsTransport, type ErrorEnvelope, type FieldValues, type ReadItem, type ReadResult, type Record as SdkRecord, type WriteItem } from "@lastdb/app-sdk";
import { FLEET_ALTERNATE, SCHEMA_NAMES, SCHEMAS, localFields, wireFields, type SchemaKey } from "./status-schema.ts";

export type FieldMap = Record<string, string>;
export type SchemaProfile = { key: SchemaKey; canonical: boolean };
export type StoredRecord = { fields: FieldMap; revision: string };
export type KeyRead = { schemaHash: string; keyHash: string; keyRange?: string; fields: string[] };
export type HashRead = { schemaHash: string; keyHash: string; fields: string[]; maxRows: number; keyName?: "by_fleet" };
export type Mutation = { schemaHash: string; keyHash: string; keyRange?: string; fields: FieldMap; mutationType: "create" | "replace" | "delete"; revision?: string };
export type HashRow = { keyHash: string; keyRange: string; fields: FieldMap; revision: string };
export interface LastDbPublisherClient {
  bindSchemas(profiles: Record<string, SchemaProfile>): void;
  queryByKeys(reads: KeyRead[]): Promise<(StoredRecord | null)[]>;
  queryByHashes(reads: HashRead[]): Promise<HashRow[][]>;
  mutateBatch(mutations: Mutation[]): Promise<void>;
}
export class LastDbPublishError extends Error {
  readonly name = "LastDbPublishError";
  constructor(readonly code: string, message: string, readonly response?: { status: number; body: unknown }) { super(message); }
}
export type LastDbClientOptions = { socketPath?: string };
const BATCH_SIZE = 64;
const READ_WORK_KEYS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;

function hashReadPageLimit(reads: readonly HashRead[]): number {
  // The page size stays on the old 10,000-key work gate. The app API returns
  // each full record, and this bound still keeps a range read finite.
  const keysPerRecord = reads.reduce((sum, read) => {
    const fields = new Set(read.fields);
    if (read.keyName) {
      fields.add(FLEET_ALTERNATE.hashField);
      for (const field of FLEET_ALTERNATE.rangeFields) fields.add(field);
    }
    return sum + 1 + 2 * fields.size;
  }, 0);
  return Math.max(1, Math.min(128, Math.floor((READ_WORK_KEYS / 2) / keysPerRecord)));
}

function defaultProfiles(): Record<string, SchemaProfile> {
  return Object.fromEntries((Object.keys(SCHEMA_NAMES) as SchemaKey[]).map((key) => [SCHEMA_NAMES[key], { key, canonical: true }]));
}

function socketPath(opts: LastDbClientOptions): string {
  return opts.socketPath || process.env.ROUTINES_LASTDB_SOCKET || process.env.LASTDB_SOCKET_PATH || process.env.FOLDDB_SOCKET_PATH ||
    join(process.env.LASTDB_HOME || join(homedir(), ".lastdb"), "data", "folddb.sock");
}

function mapSdkError(error: unknown): LastDbPublishError {
  if (error instanceof LastDbPublishError) return error;
  if (error instanceof AppApiError) {
    const response = { status: error.status, body: { code: error.code, message: error.message } };
    if (error.status === 409 || error.code === "conflict") return new LastDbPublishError("conflict", error.message, response);
    return new LastDbPublishError(`lastdb_http_${error.status}`, error.message, response);
  }
  if (error instanceof TransportError) return new LastDbPublishError("lastdb_unreachable", "LastDB did not complete the fleet request over the configured transport.");
  if (error instanceof UnexpectedResponseError) return new LastDbPublishError("bad_reply", error.message, { status: error.status, body: error.body });
  if (error instanceof Error) return new LastDbPublishError("lastdb_unreachable", error.message);
  return new LastDbPublishError("lastdb_unreachable", "LastDB did not complete the fleet request over the configured transport.");
}

function stringFields(record: FieldValues): FieldMap {
  const fields: FieldMap = {};
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "string") throw new LastDbPublishError("bad_query_row", "LastDB returned a non-string field value.");
    fields[name] = value;
  }
  return fields;
}

function isReadError(result: ReadResult): result is ErrorEnvelope {
  return "error" in result;
}

export function newLastDbPublisherClient(opts: LastDbClientOptions = {}): LastDbPublisherClient {
  const db = new LastDbClient("routines", udsTransport(socketPath(opts), { "X-LastDB-Client": "routines" }, { timeoutMs: REQUEST_TIMEOUT_MS }));
  let profiles = defaultProfiles();
  const selected = (schema: string) => {
    const profile = profiles[schema];
    if (!profile) throw new LastDbPublishError("schema_not_configured", "The fleet schema name is not one of the installed names.");
    return profile;
  };
  const mapped = (schema: string, record: FieldValues) => {
    const fields = stringFields(record);
    const profile = selected(schema);
    return profile.canonical ? localFields(profile.key, fields) : fields;
  };
  const readBatch = async (reads: ReadItem[]) => {
    try { return await db.read(reads); }
    catch (error) { throw mapSdkError(error); }
  };
  const readKeys = async (reads: KeyRead[]) => {
    const out: (StoredRecord | null)[] = [];
    for (let start = 0; start < reads.length; start += BATCH_SIZE) {
      const batch = reads.slice(start, start + BATCH_SIZE);
      const results = await readBatch(batch.map((read) => ({
        schema: read.schemaHash, key: { hash: read.keyHash, range: read.keyRange ?? null }, limit: 2,
      })));
      results.forEach((result, index) => {
        const read = batch[index]!;
        if (isReadError(result)) throw new LastDbPublishError("key_read_failed", result.error.message);
        if (!("records" in result)) throw new LastDbPublishError("bad_reply", "LastDB returned keys for a record read.");
        const wantedRange = read.keyRange ?? null;
        if (result.next_cursor !== null || result.records.length > 1 || result.records.some((row) =>
          row.key.hash !== read.keyHash || row.key.range !== wantedRange)) {
          throw new LastDbPublishError("key_read_ambiguous", "LastDB returned an incomplete or different key.");
        }
        const row = result.records[0];
        out.push(row ? { fields: mapped(read.schemaHash, row.record), revision: row.revision } : null);
      });
    }
    return out;
  };
  const readHashes = async (reads: HashRead[]) => {
    const out: HashRow[][] = reads.map(() => []);
    for (let start = 0; start < reads.length; start += BATCH_SIZE) {
      let pending = reads.slice(start, start + BATCH_SIZE).map((read, index) => ({ read, index: start + index, cursor: undefined as string | undefined }));
      const seen = new Map<number, Set<string>>();
      const primaryKeys = new Map<number, Set<string>>();
      const maxPages = 1 + Math.max(...pending.map(({ read }) => read.maxRows), 0);
      for (let page = 0; pending.length && page < maxPages; page++) {
        const limit = hashReadPageLimit(pending.map(({ read }) => ({ ...read,
          fields: read.fields.length ? read.fields : SCHEMAS[selected(read.schemaHash).key].fields })));
        const results = await readBatch(pending.map(({ read, cursor }) => ({
          schema: read.schemaHash, range: { hash: read.keyHash }, limit,
          ...(read.keyName ? { via: read.keyName } : {}), ...(cursor === undefined ? {} : { cursor }),
        })));
        const next: typeof pending = [];
        results.forEach((result, index) => {
          const query = pending[index]!, { read, cursor } = query;
          if (isReadError(result)) {
            recordRangePage(read, cursor, limit, 0, null, null, result.error.message);
            throw new LastDbPublishError("hash_read_failed", result.error.message);
          }
          if (!("records" in result)) throw new LastDbPublishError("bad_reply", "LastDB returned keys for a record read.");
          recordRangePage(read, cursor, limit, result.records.length, result.next_cursor, 200, null);
          for (const row of result.records) {
            const fields = mapped(read.schemaHash, row.record);
            const stored = storedRow(read, row, fields);
            const primary = JSON.stringify([stored.keyHash, row.key.range]);
            const keys = primaryKeys.get(query.index) ?? new Set<string>();
            if (keys.has(primary)) throw new LastDbPublishError("hash_membership_ambiguous", "A complete fleet hash returned a primary key more than once.");
            keys.add(primary); primaryKeys.set(query.index, keys);
            out[query.index]!.push(stored);
          }
          if (out[query.index]!.length > read.maxRows) throw new LastDbPublishError("hash_limit_exceeded", "A complete fleet read exceeds its configured record bound.");
          if (result.next_cursor !== null) {
            const cursorJson = JSON.stringify(result.next_cursor);
            const cursors = seen.get(query.index) ?? new Set<string>();
            if (result.next_cursor === "" || cursors.has(cursorJson)) {
              throw new LastDbPublishError("cursor_did_not_advance", "A fleet read lacks a fresh continuation cursor.");
            }
            cursors.add(cursorJson); seen.set(query.index, cursors); next.push({ ...query, cursor: result.next_cursor });
          }
        });
        pending = next;
      }
      if (pending.length) throw new LastDbPublishError("hash_page_limit", "A fleet read exceeds its complete-page bound.");
    }
    return out;
  };
  const mutate = async (mutations: Mutation[]) => {
    for (let start = 0; start < mutations.length; start += BATCH_SIZE) {
      const batch = mutations.slice(start, start + BATCH_SIZE).map((mutation) => appMutation(selected(mutation.schemaHash), mutation));
      try { await db.write(batch); }
      catch (error) { throw mapSdkError(error); }
    }
  };
  return {
    bindSchemas(next) { profiles = { ...next }; },
    queryByKeys: readKeys,
    queryByHashes: readHashes,
    async mutateBatch(mutations) { if (mutations.length) await mutate(mutations); },
  };
}

function storedRow(read: HashRead, row: SdkRecord, fields: FieldMap): HashRow {
  if (read.keyName) {
    if (row.key.range !== null || row.key.hash !== fields.id || fields.fleet_bucket !== read.keyHash || !fields.sk) {
      throw new LastDbPublishError("alternate_read_ambiguous", "A fleet alternate key does not match its primary record.");
    }
    return { keyHash: row.key.hash, keyRange: fields.sk, fields, revision: row.revision };
  }
  if (row.key.hash !== read.keyHash || typeof row.key.range !== "string" || !row.key.range) {
    throw new LastDbPublishError("hash_read_ambiguous", "A fleet hash returned different coordinates.");
  }
  return { keyHash: row.key.hash, keyRange: row.key.range, fields, revision: row.revision };
}

function appMutation(profile: SchemaProfile, mutation: Mutation): WriteItem {
  const key = { hash: mutation.keyHash, range: mutation.keyRange ?? null };
  if (mutation.mutationType === "delete") {
    if (!mutation.revision) throw new LastDbPublishError("revision_required", "A delete needs the revision from the read.");
    return { op: "delete", schema: mutation.schemaHash, key, revision: mutation.revision };
  }
  const record = profile.canonical ? wireFields(profile.key, mutation.fields) : mutation.fields;
  const alternates = profile.key === "status" ? statusAlternate(mutation.fields) : undefined;
  if (mutation.mutationType === "create") {
    return { op: "create", schema: mutation.schemaHash, key, record, ...(alternates ? { alternates } : {}) };
  }
  if (!mutation.revision) throw new LastDbPublishError("revision_required", "A replace needs the revision from the read.");
  return { op: "replace", schema: mutation.schemaHash, key, revision: mutation.revision, record, ...(alternates ? { alternates } : {}) };
}

function statusAlternate(fields: FieldMap): { by_fleet: { hash: string; range: string } } {
  const hash = fields.fleet_bucket, range = fields.sk;
  if (!hash || !range) throw new LastDbPublishError("alternate_incomplete", "A status write needs its fleet bucket and sort key.");
  return { by_fleet: { hash, range } };
}

// Page selectors only. Field values stay out of the trace.
function recordRangePage(read: HashRead, cursor: string | undefined, limit: number, returned: number, nextCursor: string | null, status: number | null, error: string | null): void {
  const file = process.env.ROUTINES_STATUS_READ_TRACE_FILE;
  if (!file || (!read.keyName && !(limit > 2))) return;
  const page = { call_id: process.env.ROUTINES_STATUS_READ_TRACE_ID ?? String(process.pid),
    schema: read.schemaHash, key_name: read.keyName ?? "primary", filter: { HashKey: read.keyHash },
    fields: read.fields, limit, offset: 0, cursor: cursor ?? null, status, returned_count: returned,
    has_more: nextCursor !== null, next_cursor: nextCursor, error };
  writeFileSync(file, JSON.stringify(page) + "\n", { flag: "a", mode: 0o600 });
}
