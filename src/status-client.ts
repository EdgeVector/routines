/** Native owner-socket requests for fleet status. No schema declarations on reads or writes. */
import { homedir } from "node:os";
import { join } from "node:path";
import { fieldRules, localFields, wireFields, type KeptSchemaKey, type SchemaDefinition } from "./status-schema.ts";

export type FieldMap = Record<string, string>;
export type SchemaProfile = { key: KeptSchemaKey; canonical: boolean };
export type KeyRead = { schemaHash: string; keyHash: string; keyRange?: string; fields: string[] };
export type HashRead = { schemaHash: string; keyHash: string; fields: string[]; maxRows: number; keyName?: "by_fleet" };
export type Mutation = { schemaHash: string; keyHash: string; keyRange?: string; fields: FieldMap; mutationType: "create" | "update" | "delete";
  expected?: { field: string; value: string } };
export type HashRow = { keyHash: string; keyRange: string; fields: FieldMap };
export interface LastDbPublisherClient {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  bindSchemas(profiles: Record<string, SchemaProfile>): void;
  declareAppSchema(appId: string, schema: SchemaDefinition): Promise<{ identity: string; canonical: string; schemaName: string }>;
  queryByKeys(reads: KeyRead[]): Promise<(FieldMap | null)[]>;
  queryByHashes(reads: HashRead[]): Promise<HashRow[][]>;
  mutateBatch(mutations: Mutation[]): Promise<void>;
}
export interface LastDbDeliveryClient {
  stageDelivery(request: DeliveryStageRequest): Promise<DeliveryStageResult>;
  approveDelivery(deliveryId: string): Promise<DeliveryApproveResult>;
}
export interface DeliveryStageRequest {
  recipient_pubkey: string; recipient_display_name?: string;
  messaging_public_key: string; messaging_pseudonym: string; mode: "snapshot"; max_records: number;
  legs: Array<{ schema_name: string; fields: string[]; hash_keys?: string[] }>;
}
export interface DeliveryStageResult { deliveryId: string; recordCount: number; fields: string[]; note: string }
export interface DeliveryApproveResult { deliveryId: string; shared: number; messageType: string }
export class LastDbPublishError extends Error {
  readonly name = "LastDbPublishError";
  constructor(readonly code: string, message: string, readonly response?: { status: number; body: unknown }) { super(message); }
}
type Entry = Record<string, unknown>;
type FetchInit = RequestInit & { unix?: string };
type LastDbFetch = (input: Parameters<typeof globalThis.fetch>[0], init?: FetchInit) => Promise<Response>;
type LastDbClientOptions = { socketPath?: string; nodeUrl?: string; fetchImpl?: LastDbFetch };
const BATCH_SIZE = 64;

export function object(value: unknown): Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LastDbPublishError("bad_reply", "LastDB returned an invalid object.");
  return value as Entry;
}
export function dataObject(value: unknown): Entry {
  const body = object(value);
  return body.data === undefined ? body : object(body.data);
}

function rows(value: unknown): Array<{ hash: string; range: string | null; fields: FieldMap; matched?: { hash: string; range: string } }> {
  const reply = object(value);
  if (reply.ok !== true || reply.unresolved_rows !== 0 || !Array.isArray(reply.results) || typeof reply.has_more !== "boolean") {
    throw new LastDbPublishError("query_incomplete", "LastDB did not return a resolved query page.");
  }
  return reply.results.map((item) => {
    const row = object(item), key = object(row.key), fields = object(row.fields);
    if (typeof key.hash !== "string" || !key.hash || (key.range !== null && typeof key.range !== "string") ||
        Object.values(fields).some((field) => typeof field !== "string")) {
      throw new LastDbPublishError("bad_query_row", "LastDB returned invalid primary coordinates or field values.");
    }
    let matched: { hash: string; range: string } | undefined;
    if (row.matched_key !== undefined) {
      const address = object(row.matched_key);
      if (typeof address.hash !== "string" || typeof address.range !== "string") {
        throw new LastDbPublishError("bad_alternate_key", "LastDB returned invalid alternate coordinates.");
      }
      matched = { hash: address.hash, range: address.range };
    }
    return { hash: key.hash, range: key.range as string | null, fields: fields as FieldMap, matched };
  });
}

export function newLastDbPublisherClient(opts: LastDbClientOptions = {}): LastDbPublisherClient {
  const request = newLastDbJsonCaller(opts);
  let profiles: Record<string, SchemaProfile> = {};
  const selected = (schema: string) => {
    const profile = profiles[schema];
    if (!profile) throw new LastDbPublishError("schema_not_configured", "Run init-status or resume the explicit schema conversion first.");
    return profile;
  };
  const names = (schema: string, fields: string[]) => {
    const profile = selected(schema), rules = fieldRules(profile.key);
    return fields.map((field) => {
      if (!rules[field]) throw new LastDbPublishError("unknown_field", "A fleet request names an undeclared field.");
      return profile.canonical ? rules[field]![0] : field;
    });
  };
  const values = (schema: string, fields: FieldMap) => {
    const profile = selected(schema);
    return profile.canonical ? localFields(profile.key, fields) : fields;
  };
  const readKeys = async (reads: KeyRead[]) => {
    const out: (FieldMap | null)[] = [];
    for (let start = 0; start < reads.length; start += BATCH_SIZE) {
      const batch = reads.slice(start, start + BATCH_SIZE);
      const reply = dataObject(await request("POST", "/api/queries/batch", { queries: batch.map((read) => ({
        schema_name: read.schemaHash, fields: names(read.schemaHash, read.fields),
        filter: read.keyRange === undefined ? { HashKey: read.keyHash } : { HashRangeKey: { hash: read.keyHash, range: read.keyRange } }, limit: 2,
      })) }));
      if (reply.count !== batch.length || !Array.isArray(reply.results) || reply.results.length !== batch.length) {
        throw new LastDbPublishError("query_batch_incomplete", "LastDB did not return every requested key.");
      }
      reply.results.forEach((item, index) => {
        const result = object(item), read = batch[index]!;
        if (result.status !== 200) throw new LastDbPublishError("key_read_failed", "A fleet key read failed.");
        const page = object(result.response), resultRows = rows(page);
        if (page.has_more !== false || resultRows.length > 1 || resultRows.some((row) =>
          row.hash !== read.keyHash || row.range !== (read.keyRange ?? null))) {
          throw new LastDbPublishError("key_read_ambiguous", "LastDB returned an incomplete or different key.");
        }
        out.push(resultRows[0] ? values(read.schemaHash, resultRows[0].fields) : null);
      });
    }
    return out;
  };
  const readHashes = async (reads: HashRead[]) => {
    const out: HashRow[][] = reads.map(() => []);
    for (let start = 0; start < reads.length; start += BATCH_SIZE) {
      let pending = reads.slice(start, start + BATCH_SIZE).map((read, index) => ({ read, index: start + index, cursor: undefined as unknown }));
      const seen = new Map<number, Set<string>>();
      const primaryKeys = new Map<number, Set<string>>();
      for (let page = 0; pending.length && page < 1000; page++) {
        const reply = dataObject(await request("POST", "/api/queries/batch", { queries: pending.map(({ read, cursor }) => ({
          schema_name: read.schemaHash, fields: names(read.schemaHash, read.fields), filter: { HashKey: read.keyHash }, limit: 128,
          ...(read.keyName ? { key_name: read.keyName } : {}), ...(cursor === undefined ? {} : { cursor }),
        })) }));
        if (reply.count !== pending.length || !Array.isArray(reply.results) || reply.results.length !== pending.length) {
          throw new LastDbPublishError("query_batch_incomplete", "LastDB did not return every requested hash.");
        }
        const next: typeof pending = [];
        reply.results.forEach((item, index) => {
          const result = object(item), query = pending[index]!, { read } = query;
          if (result.status !== 200) throw new LastDbPublishError("hash_read_failed", "A fleet hash read failed.");
          const response = object(result.response);
          for (const row of rows(response)) {
            const address = read.keyName ? row.matched : { hash: row.hash, range: row.range };
            if (!address || address.hash !== read.keyHash || typeof address.range !== "string") {
              throw new LastDbPublishError("hash_read_ambiguous", "A fleet hash returned different coordinates.");
            }
            const fields = values(read.schemaHash, row.fields);
            if (read.keyName && (row.range !== null || row.hash !== fields.id || fields.fleet_bucket !== address.hash || fields.sk !== address.range)) {
              throw new LastDbPublishError("alternate_read_ambiguous", "A fleet alternate key does not match its primary record.");
            }
            const primary = JSON.stringify([row.hash, row.range]), keys = primaryKeys.get(query.index) ?? new Set<string>();
            if (keys.has(primary)) throw new LastDbPublishError("hash_membership_ambiguous", "A complete fleet hash returned a primary key more than once.");
            keys.add(primary); primaryKeys.set(query.index, keys);
            out[query.index]!.push({ keyHash: row.hash, keyRange: address.range, fields });
          }
          if (out[query.index]!.length > read.maxRows) throw new LastDbPublishError("hash_limit_exceeded", "A complete fleet read exceeds its configured record bound.");
          if (response.has_more) {
            const cursor = response.next_cursor, cursorJson = JSON.stringify(cursor);
            const cursors = seen.get(query.index) ?? new Set<string>();
            if (cursor === undefined || cursor === null || cursor === "" || cursors.has(cursorJson)) {
              throw new LastDbPublishError("cursor_did_not_advance", "A fleet read lacks a fresh continuation cursor.");
            }
            cursors.add(cursorJson); seen.set(query.index, cursors); next.push({ ...query, cursor });
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
      const batch = mutations.slice(start, start + BATCH_SIZE);
      const reply = dataObject(await request("POST", "/api/mutations/batch", { mutations: batch.map((mutation) => {
        const profile = selected(mutation.schemaHash);
        return { type: "mutation", schema: mutation.schemaHash,
          fields_and_values: profile.canonical ? wireFields(profile.key, mutation.fields) : mutation.fields,
          key_value: { hash: mutation.keyHash, range: mutation.keyRange ?? null }, mutation_type: mutation.mutationType,
          ...(mutation.expected ? { expected: { type: "value", field: names(mutation.schemaHash, [mutation.expected.field])[0], value: mutation.expected.value } } : {}) };
      }) }));
      const operations = object(reply.operations);
      if (reply.ok !== true || reply.count !== batch.length || !Array.isArray(reply.mutation_ids) || reply.mutation_ids.length !== batch.length ||
          reply.mutation_ids.some((id) => typeof id !== "string" || !id) || new Set(reply.mutation_ids).size !== batch.length ||
          operations.total !== batch.length || ![operations.created, operations.updated, operations.deleted, operations.no_op].every((count) => Number.isSafeInteger(count) && Number(count) >= 0) ||
          Number(operations.created) + Number(operations.updated) + Number(operations.deleted) + Number(operations.no_op) !== batch.length ||
          !["queued", "durable"].includes(String(reply.durability))) {
        throw new LastDbPublishError("mutation_not_confirmed", "LastDB did not confirm every fleet mutation.");
      }
    }
  };
  return {
    request,
    bindSchemas(next) { profiles = { ...next }; },
    async declareAppSchema(appId, schema) {
      const reply = dataObject(await request("POST", "/api/apps/declare-schema", { app_id: appId, schema }));
      if (reply.app_id !== appId || reply.schema_name !== `${appId}/${schema.name}` || reply.independent_fields !== true ||
          typeof reply.canonical !== "string" || !reply.canonical || typeof reply.identity_hash !== "string" || !/^[a-f0-9]{64}$/.test(reply.identity_hash)) {
        throw new LastDbPublishError("schema_declare_bad_response", "LastDB did not confirm the requested schema-owned definition.");
      }
      return { identity: reply.identity_hash, canonical: reply.canonical, schemaName: String(reply.schema_name) };
    },
    queryByKeys: readKeys,
    queryByHashes: readHashes,
    mutateBatch: mutate,
  };
}

export function newLastDbDeliveryClient(opts: LastDbClientOptions = {}): LastDbDeliveryClient {
  const request = newLastDbJsonCaller(opts);
  return {
    async stageDelivery(body) {
      const reply = dataObject(await request("POST", "/api/sharing/deliver", body));
      const delivery = object(reply.delivery), preview = object(delivery.preview);
      if (typeof delivery.delivery_id !== "string" || !delivery.delivery_id || !Number.isSafeInteger(preview.record_count) || !Array.isArray(preview.fields)) {
        throw new LastDbPublishError("delivery_stage_bad_response", "LastDB did not confirm the staged fleet delivery.");
      }
      return { deliveryId: delivery.delivery_id, recordCount: Number(preview.record_count), fields: preview.fields.map(String), note: String(reply.note ?? "") };
    },
    async approveDelivery(deliveryId) {
      const reply = dataObject(await request("POST", `/api/sharing/deliveries/${encodeURIComponent(deliveryId)}/approve`));
      if (reply.delivery_id !== deliveryId || !Number.isSafeInteger(reply.shared) || typeof reply.message_type !== "string") {
        throw new LastDbPublishError("delivery_approve_bad_response", "LastDB did not confirm the requested fleet delivery.");
      }
      return { deliveryId, shared: Number(reply.shared), messageType: reply.message_type };
    },
  };
}

function newLastDbJsonCaller(opts: LastDbClientOptions) {
  const socketPath = opts.socketPath || process.env.ROUTINES_LASTDB_SOCKET || process.env.LASTDB_SOCKET_PATH || process.env.FOLDDB_SOCKET_PATH ||
    join(process.env.LASTDB_HOME || join(homedir(), ".lastdb"), "data", "folddb.sock");
  const explicitUrl = opts.nodeUrl || process.env.ROUTINES_LASTDB_NODE_URL;
  const fetchImpl: LastDbFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(explicitUrl ? `${explicitUrl.replace(/\/+$/, "")}${path}` : `http://localhost${path}`, {
        method, headers: { "X-LastDB-Client": "routines", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(explicitUrl ? {} : { unix: socketPath }),
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw new LastDbPublishError("lastdb_unreachable", "LastDB did not complete the fleet request over the configured transport.");
    }
    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { parsed = text; }
    if (!response.ok) {
      throw new LastDbPublishError(`lastdb_http_${response.status}`, `LastDB ${method} ${path} returned HTTP ${response.status}.`, { status: response.status, body: parsed });
    }
    return parsed;
  };
}
