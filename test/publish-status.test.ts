import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDeliveryStageRequest,
  buildBoundedDeliveryStageRequest,
  buildBoundedDeliveryStageRequests,
  buildFleetPublication,
  clearLegacyFleetSnapshot,
  deliverFleetStatus,
  fleetStatusBucket,
  newLastDbDeliveryClient,
  newLastDbPublisherClient,
  publishFleetStatus,
  readFleetStatus,
  type SchemaDefinition,
  type LastDbDeliveryClient,
  type LastDbPublisherClient,
} from "../src/publish-status.ts";

let home: string;
let binDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "routines-publish-"));
  binDir = mkdtempSync(join(tmpdir(), "routines-publish-bin-"));
  process.env.ROUTINES_HOME = home;
  const situations = join(binDir, "situations");
  writeFileSync(situations, "#!/bin/sh\necho '[]'\n");
  chmodSync(situations, 0o755);
  process.env.ROUTINES_SITUATIONS_CLI = situations;

  mkdirSync(join(home, "registry"), { recursive: true });
  writeFileSync(
    join(home, "registry", "alpha.toml"),
    [
      'harness = "codex"',
      'model = "gpt-5.5"',
      'effort = "medium"',
      'rrule = "FREQ=HOURLY"',
      'prompt = "do not publish this prompt"',
      `cwd = "${home}"`,
      "timeout_min = 5",
      "",
    ].join("\n"),
  );

  const runDir = join(home, "runs", "alpha", "20260715T010203Z");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        id: "alpha",
        exitCode: 0,
        startedAt: "2026-07-15T01:02:03.000Z",
        finishedAt: "2026-07-15T01:02:04.000Z",
        durationMs: 1000,
        outcome: "ok",
        outcomeDetail: "merged",
        outcomeSource: "routine_result",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(runDir, "stdout.log"), "ROUTINE_RESULT outcome=ok detail=merged\nAPI_TOKEN=abc123\n");
  writeFileSync(join(runDir, "stderr.log"), "");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  delete process.env.ROUTINES_HOME;
  delete process.env.ROUTINES_SITUATIONS_CLI;
  delete process.env.ROUTINES_FLEET_LEGACY_READ_UNTIL;
});

test("buildFleetPublication emits slim rows and capped redacted run summaries", () => {
  const pub = buildFleetPublication({
    now: new Date("2026-07-15T02:00:00.000Z"),
    runLimit: 1,
    logTailBytes: 200,
  });

  expect(pub.snapshot.slug).toBe("fleet-latest");
  expect(pub.snapshot.captured_at).toBe("2026-07-15T02:00:00.000Z");
  expect(pub.rows).toHaveLength(1);
  expect(pub.rows[0]!.id).toBe("alpha");
  expect(pub.rows[0]!.running).toBe("false");
  expect(pub.rows[0]!.last_outcome).toBe("ok");

  expect(pub.runSummaries).toHaveLength(1);
  expect(pub.runSummaries[0]!.slug).toBe("alpha/20260715T010203Z");
  expect(pub.runSummaries[0]!.log_tail).toContain("API_TOKEN=<redacted>");
  expect(pub.runSummaries[0]!.log_tail).not.toContain("abc123");
  expect(pub.snapshot.rows_json).not.toContain("do not publish this prompt");
});

test("publishFleetStatus declares schemas and writes only bounded fleet records", async () => {
  const client = new FakeClient();
  const result = await publishFleetStatus({
    client,
    now: new Date("2026-07-15T02:00:00.000Z"),
    runLimit: 1,
  });

  expect(result.schemaHashes).toEqual({
    snapshot: "hash-RoutineFleetSnapshot",
    status: "hash-RoutineStatus",
    runSummary: "hash-RoutineRunSummary",
    fleetStatus: "hash-FleetRoutineStatusV2",
    fleetSummary: "hash-FleetSummary",
    runSummaryV2: "hash-RoutineRunSummaryV2",
  });
  expect(result.written).toEqual({
    snapshots: 0,
    rows: 1,
    deletedStatusRows: 0,
    runSummaries: 0,
    fleetRows: 1,
    runSummariesV2: 1,
    deletedRunSummariesV2: 0,
    fleetSummaries: 1,
  });
  expect(client.declared.map((schema) => schema.name)).toEqual([
    "RoutineFleetSnapshot",
    "RoutineStatus",
    "RoutineRunSummary",
    "FleetRoutineStatusV2",
    "FleetSummary",
    "RoutineRunSummaryV2",
  ]);
  expect(client.declared[3]).toMatchObject({
    schema_type: "HashRange",
    key: { hash_field: "fleet_bucket", range_field: "sk" },
    fields: expect.arrayContaining(["fleet_bucket", "sk", "id", "status", "group_id", "schema_layout_version"]),
  });
  expect(client.declared[4]).toMatchObject({
    schema_type: "Hash",
    key: { hash_field: "fleet_id" },
    fields: [
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
    ],
  });
  expect(client.declared[4]!.fields).not.toContain("rows_json");
  expect(client.declared[5]).toMatchObject({
    schema_type: "HashRange",
    key: { hash_field: "id", range_field: "stamp" },
  });
  expect(client.declared[5]!.fields).not.toContain("slug");
  expect(client.writes.map((w) => [w.schemaHash, w.keyHash, w.mutationType])).toEqual([
    ["hash-RoutineStatus", "alpha", "create"],
    ["hash-FleetRoutineStatusV2", fleetStatusBucket("alpha"), "create"],
    ["hash-RoutineRunSummaryV2", "alpha", "create"],
    ["hash-FleetSummary", "routines", "create"],
  ]);
  const status = client.record("hash-RoutineStatus", "alpha");
  expect(status).toMatchObject({
    fleet_bucket: fleetStatusBucket("alpha"),
    sk: "active#other#alpha",
  });
  expect(status?.content_digest).toHaveLength(64);
  expect(status?.schema_layout_version).toBeUndefined();
  expect(client.record("hash-FleetRoutineStatusV2", status!.fleet_bucket!, status!.sk!)).toMatchObject({
    id: "alpha",
    schema_layout_version: "1",
  });
});

test("N seeded status rows use one HashKeys query and mutateBatch, with zero per-id queryByKey", async () => {
  const ids = ["alpha", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
  for (const id of ids.slice(1)) {
    writeFileSync(
      join(home, "registry", `${id}.toml`),
      [
        'harness = "codex"',
        'model = "gpt-5.5"',
        'effort = "medium"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "do not publish this prompt"',
        `cwd = "${home}"`,
        "timeout_min = 5",
        "",
      ].join("\n"),
    );
  }
  const client = new FakeClient();
  const first = await publishFleetStatus({
    client,
    now: new Date("2026-07-15T02:00:00.000Z"),
    runLimit: 1,
  });

  expect(first.written.rows).toBe(ids.length);
  expect(first.written.fleetRows).toBe(ids.length);
  expect(statusHashKeysQueries(client)).toHaveLength(1);
  expect(statusHashKeysQueries(client)[0]!.keyHashes).toEqual([...ids].sort());
  expect(statusKeyQueries(client)).toHaveLength(0);
  expect(client.batchMutations.length).toBeGreaterThanOrEqual(1);
  expect(client.batchMutations[0]!.filter((op) => op.schemaHash === "hash-RoutineStatus")).toHaveLength(ids.length);
  expect(client.writes.filter((write) => write.schemaHash === "hash-RoutineStatus" && write.mutationType === "create")).toHaveLength(ids.length);
  expect(client.writes.some((write) => write.schemaHash === "hash-RoutineStatus" && write.mutationType === "create")).toBe(true);

  client.hashKeysQueries = [];
  client.keyQueries = [];
  client.batchMutations = [];
  const writeStart = client.writes.length;
  const second = await publishFleetStatus({
    client,
    now: new Date("2026-07-15T02:00:00.000Z"),
    runLimit: 1,
  });

  expect(second.written.rows).toBe(0);
  expect(second.written.fleetRows).toBe(0);
  expect(statusHashKeysQueries(client)).toHaveLength(1);
  expect(statusHashKeysQueries(client)[0]!.keyHashes).toEqual([...ids].sort());
  expect(statusKeyQueries(client)).toHaveLength(0);
  expect(client.writes.slice(writeStart).some((write) => write.schemaHash === "hash-RoutineStatus")).toBe(false);
  expect(client.writes.slice(writeStart).some((write) => write.schemaHash === "hash-FleetRoutineStatusV2")).toBe(false);
  expect(client.batchMutations.some((batch) => batch.some((op) => op.schemaHash === "hash-RoutineStatus"))).toBe(false);
});

test("FleetSummary is the last write and a failed row pass does not advance it", async () => {
  const client = new FakeClient();
  client.failSchemaHash = "hash-RoutineRunSummaryV2";

  await expect(publishFleetStatus({
    client,
    now: new Date("2026-07-15T02:00:00.000Z"),
    runLimit: 1,
  })).rejects.toThrow("forced mutation failure");

  expect(client.record("hash-FleetSummary", "routines")).toBeNull();
  expect(client.writes.at(-1)?.schemaHash).toBe("hash-RoutineRunSummaryV2");
});

test("bounded reader validates FleetSummary against all fixed bucket pages", async () => {
  const client = new FakeClient();
  await publishFleetStatus({ client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 1 });
  client.hashQueries = [];

  const result = await readFleetStatus({
    client,
    schemaHashes: schemaHashes(),
  });

  expect(result.attempts).toBe(1);
  expect(result.rows.map((row) => row.id)).toEqual(["alpha"]);
  expect(result.summary.row_count).toBe("1");
  expect(client.hashQueries.filter((query) => query.schemaHash === "hash-FleetRoutineStatusV2")).toHaveLength(16);
});

test("bounded reader retries a partial bucket pass", async () => {
  const client = new FakeClient();
  await publishFleetStatus({ client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 1 });
  client.hideNextFleetRow = true;

  const result = await readFleetStatus({ client, schemaHashes: schemaHashes(), maxAttempts: 2 });

  expect(result.attempts).toBe(2);
  expect(result.rows).toHaveLength(1);
});

function addRun(stamp: string, startedAt: string): void {
  const runDir = join(home, "runs", "alpha", stamp);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      id: "alpha", exitCode: 0, startedAt, finishedAt: startedAt, durationMs: 1, outcome: "ok", outcomeDetail: stamp,
      outcomeSource: "routine_result",
    }),
  );
  writeFileSync(join(runDir, "stdout.log"), `ROUTINE_RESULT outcome=ok detail=${stamp}\n`);
  writeFileSync(join(runDir, "stderr.log"), "");
}

const runQueries = (c: FakeClient) => c.hashRangeKeyQueries.filter((q) => q.schemaHash === "hash-RoutineRunSummaryV2");
const runQueryStamps = (c: FakeClient) => runQueries(c).flatMap((q) => q.keys.map((key) => key.range));
const retentionQueries = (c: FakeClient) => c.hashQueries.filter((q) => q.schemaHash === "hash-RoutineRunSummaryV2");
const statusKeyQueries = (c: FakeClient) => c.keyQueries.filter((q) => q.schemaHash === "hash-RoutineStatus" || q.schemaHash === "hash-FleetRoutineStatusV2");
const statusHashKeysQueries = (c: FakeClient) => c.hashKeysQueries.filter((q) => q.schemaHash === "hash-RoutineStatus");

test("watermark path publishes the same fleet output as the full path", async () => {
  const oldClient = new FakeClient();
  const newClient = new FakeClient();
  const steps: Array<[string, () => void]> = [
    ["2026-07-15T02:00:00.000Z", () => {}],
    ["2026-07-15T03:00:00.000Z", () => {}],
    ["2026-07-15T04:00:00.000Z", () => addRun("20260715T033000Z", "2026-07-15T03:30:00.000Z")],
    ["2026-07-15T05:00:00.000Z", () => addRun("20260715T043000Z", "2026-07-15T04:30:00.000Z")],
    ["2026-07-15T06:00:00.000Z", () => {}],
  ];
  for (const [at, mutate] of steps) {
    mutate();
    const now = new Date(at);
    const full = await publishFleetStatus({ client: oldClient, now, runLimit: 5, useWatermark: false });
    const fast = await publishFleetStatus({ client: newClient, now, runLimit: 5 });
    expect(fast.written.runSummariesV2).toBe(full.written.runSummariesV2);
    expect(fast.fleetSummary).toEqual(full.fleetSummary);
    expect(fast.rows).toEqual(full.rows);
    expect(fast.runSummaries).toEqual(full.runSummaries);
  }
  expect(newClient.partition("hash-RoutineRunSummaryV2", "alpha")).toEqual(oldClient.partition("hash-RoutineRunSummaryV2", "alpha"));
  expect(newClient.partition("hash-RoutineRunSummaryV2", "alpha")).toHaveLength(3);
  expect(newClient.record("hash-FleetSummary", "routines")).toEqual(oldClient.record("hash-FleetSummary", "routines"));
  expect(newClient.record("hash-RoutineStatus", "alpha")).toEqual(oldClient.record("hash-RoutineStatus", "alpha"));
});

test("watermark persists and later publishes read only newer runs", async () => {
  const client = new FakeClient();
  await publishFleetStatus({ client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 5 });
  const saved = JSON.parse(readFileSync(join(home, "state", "publish-watermark.json"), "utf8"));
  expect(saved.runs.alpha).toBe("20260715T010203Z");

  client.hashRangeKeyQueries = [];
  await publishFleetStatus({ client, now: new Date("2026-07-15T03:00:00.000Z"), runLimit: 5 });
  expect(runQueries(client)).toHaveLength(0);

  addRun("20260715T033000Z", "2026-07-15T03:30:00.000Z");
  const result = await publishFleetStatus({ client, now: new Date("2026-07-15T04:00:00.000Z"), runLimit: 5 });
  expect(runQueryStamps(client)).toEqual(["20260715T033000Z"]);
  expect(result.written.runSummariesV2).toBe(1);
  const after = JSON.parse(readFileSync(join(home, "state", "publish-watermark.json"), "utf8"));
  expect(after.runs.alpha).toBe("20260715T033000Z");
});

test("retention runs on a new run and otherwise at most once a day", async () => {
  const client = new FakeClient();
  await publishFleetStatus({ client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 5 });
  expect(retentionQueries(client)).toHaveLength(1);

  await publishFleetStatus({ client, now: new Date("2026-07-15T03:00:00.000Z"), runLimit: 5 });
  await publishFleetStatus({ client, now: new Date("2026-07-15T04:00:00.000Z"), runLimit: 5 });
  expect(retentionQueries(client)).toHaveLength(1);

  addRun("20260715T043000Z", "2026-07-15T04:30:00.000Z");
  await publishFleetStatus({ client, now: new Date("2026-07-15T05:00:00.000Z"), runLimit: 5 });
  expect(retentionQueries(client)).toHaveLength(2);

  await publishFleetStatus({ client, now: new Date("2026-07-15T06:00:00.000Z"), runLimit: 5 });
  expect(retentionQueries(client)).toHaveLength(2);

  client.hashRangeKeyQueries = [];
  await publishFleetStatus({ client, now: new Date("2026-07-16T05:30:00.000Z"), runLimit: 5 });
  expect(retentionQueries(client)).toHaveLength(3);
  // The daily pass re-checks every run in the window (self-heal) with one HashRangeKeys query.
  expect(runQueries(client)).toHaveLength(1);
  expect(runQueryStamps(client).sort()).toEqual(["20260715T010203Z", "20260715T043000Z"]);
});

test("daily full pass repairs a store that lost a run summary", async () => {
  const client = new FakeClient();
  await publishFleetStatus({ client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 5 });
  const fresh = new FakeClient();
  const result = await publishFleetStatus({ client: fresh, now: new Date("2026-07-15T03:00:00.000Z"), runLimit: 5 });
  expect(result.written.runSummariesV2).toBe(0);
  const healed = await publishFleetStatus({ client: fresh, now: new Date("2026-07-16T03:00:00.000Z"), runLimit: 5 });
  expect(healed.written.runSummariesV2).toBe(1);
});

test("a corrupt or mismatched watermark falls back to a full pass", async () => {
  const client = new FakeClient();
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "publish-watermark.json"), "{not json");
  const result = await publishFleetStatus({ client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 5 });
  expect(result.written.runSummariesV2).toBe(1);
});

test("dry run neither reads nor writes the watermark", async () => {
  await publishFleetStatus({ client: new FakeClient(), dryRun: true, now: new Date("2026-07-15T02:00:00.000Z") });
  expect(existsSync(join(home, "state", "publish-watermark.json"))).toBe(false);
});

test("unchanged publication skips primary status and V2 run writes", async () => {
  const client = new FakeClient();
  const options = { client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 1 };
  await publishFleetStatus(options);
  const start = client.writes.length;

  const result = await publishFleetStatus(options);
  const writes = client.writes.slice(start);

  expect(result.written.rows).toBe(0);
  expect(result.written.fleetRows).toBe(0);
  expect(result.written.runSummariesV2).toBe(0);
  expect(result.written.snapshots).toBe(0);
  expect(result.written.runSummaries).toBe(0);
  expect(client.writes.some((write) => write.schemaHash === "hash-RoutineFleetSnapshot")).toBe(false);
  expect(client.writes.some((write) => write.schemaHash === "hash-RoutineRunSummary")).toBe(false);
  expect(writes.some((write) => write.schemaHash === "hash-RoutineStatus")).toBe(false);
  expect(writes.some((write) => write.schemaHash === "hash-FleetRoutineStatusV2")).toBe(false);
  expect(writes.some((write) => write.schemaHash === "hash-RoutineRunSummaryV2" && write.mutationType !== "delete")).toBe(false);
});

test("publication deletes routines that left the registry before advancing the summary", async () => {
  const client = new FakeClient();
  await publishFleetStatus({ client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 1 });
  const oldStatus = client.record("hash-RoutineStatus", "alpha")!;
  const writeStart = client.writes.length;
  rmSync(join(home, "registry", "alpha.toml"));

  const result = await publishFleetStatus({ client, now: new Date("2026-07-15T03:00:00.000Z"), runLimit: 1 });

  expect(result.written.deletedStatusRows).toBe(1);
  expect(client.record("hash-RoutineStatus", "alpha")).toBeNull();
  expect(client.record("hash-FleetRoutineStatusV2", oldStatus.fleet_bucket!, oldStatus.sk!)).toBeNull();
  expect(client.writes).toContainEqual({
    schemaHash: "hash-FleetRoutineStatusV2",
    keyHash: oldStatus.fleet_bucket!,
    keyRange: oldStatus.sk!,
    fields: {},
    mutationType: "delete",
  });
  const currentWrites = client.writes.slice(writeStart);
  expect(currentWrites.findIndex((write) => write.schemaHash === "hash-FleetRoutineStatusV2" && write.mutationType === "delete"))
    .toBeLessThan(currentWrites.findIndex((write) => write.schemaHash === "hash-FleetSummary"));
  expect(client.record("hash-FleetSummary", "routines")?.row_count).toBe("0");
  expect((await readFleetStatus({ client, schemaHashes: schemaHashes() })).rows).toEqual([]);
  expect(client.writes.at(-1)?.schemaHash).toBe("hash-FleetSummary");
});

test("status move deletes the old fleet sort key directly", async () => {
  const client = new FakeClient();
  await publishFleetStatus({ client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 1 });
  const before = client.record("hash-RoutineStatus", "alpha")!;
  writeFileSync(join(home, "registry", "alpha.toml"), [
    'harness = "codex"',
    'model = "gpt-5.5"',
    'effort = "medium"',
    'rrule = "FREQ=HOURLY"',
    'prompt = "do not publish this prompt"',
    `cwd = "${home}"`,
    "timeout_min = 5",
    'status = "paused"',
    "",
  ].join("\n"));

  const result = await publishFleetStatus({ client, now: new Date("2026-07-15T03:00:00.000Z"), runLimit: 1 });
  const after = client.record("hash-RoutineStatus", "alpha")!;

  expect(result.written.rows).toBe(1);
  expect(result.written.deletedStatusRows).toBe(1);
  expect(client.writes).toContainEqual({
    schemaHash: "hash-FleetRoutineStatusV2",
    keyHash: before.fleet_bucket!,
    keyRange: before.sk!,
    fields: {},
    mutationType: "delete",
  });
  expect(client.record("hash-FleetRoutineStatusV2", before.fleet_bucket!, before.sk!)).toBeNull();
  expect(after.sk).toBe("paused#other#alpha");
  expect(client.record("hash-FleetRoutineStatusV2", after.fleet_bucket!, after.sk!)).toMatchObject({ status: "paused" });
});

test("publication deletes an obsolete fleet address for a current routine", async () => {
  const client = new FakeClient();
  await publishFleetStatus({ client, now: new Date("2026-07-15T02:00:00.000Z"), runLimit: 1 });
  const current = client.record("hash-RoutineStatus", "alpha")!;
  const staleSk = "paused#other#alpha";
  client.seed("hash-FleetRoutineStatusV2", current.fleet_bucket!, staleSk, {
    ...current,
    status: "paused",
    sk: staleSk,
  });

  const result = await publishFleetStatus({ client, now: new Date("2026-07-15T03:00:00.000Z"), runLimit: 1 });

  expect(result.written.deletedStatusRows).toBe(1);
  expect(client.record("hash-RoutineStatus", "alpha")).toMatchObject({ status: "active" });
  expect(client.record("hash-FleetRoutineStatusV2", current.fleet_bucket!, current.sk!)).toMatchObject({ status: "active" });
  expect(client.record("hash-FleetRoutineStatusV2", current.fleet_bucket!, staleSk)).toBeNull();
});

test("retention deletes only old exact keys in one routine partition", async () => {
  const client = new FakeClient();
  for (const stamp of ["20260712T010203Z", "20260713T010203Z", "20260714T010203Z"]) {
    client.seed("hash-RoutineRunSummaryV2", "alpha", stamp, {
      id: "alpha",
      stamp,
      started_at: stamp === "20260712T010203Z" ? "2026-07-12T01:02:03.000Z" : "2026-07-14T01:02:03.000Z",
    });
  }

  const result = await publishFleetStatus({
    client,
    now: new Date("2026-07-15T02:00:00.000Z"),
    runLimit: 1,
    runRetentionCount: 2,
    runRetentionDays: 30,
  });

  expect(result.written.deletedRunSummariesV2).toBe(2);
  const deletes = client.writes.filter((write) => write.schemaHash === "hash-RoutineRunSummaryV2" && write.mutationType === "delete");
  expect(deletes.map((write) => write.keyRange).sort()).toEqual(["20260712T010203Z", "20260713T010203Z"]);
  expect(client.partition("hash-RoutineRunSummaryV2", "alpha").map((row) => row.keyRange).sort()).toEqual([
    "20260714T010203Z",
    "20260715T010203Z",
  ]);
});

test("stable fleet buckets spread independent routine ids", () => {
  expect(fleetStatusBucket("alpha")).toBe(fleetStatusBucket("alpha"));
  expect(fleetStatusBucket("alpha")).not.toBe(fleetStatusBucket("charlie"));
});

test("buildDeliveryStageRequest targets snapshot plus capped routine status rows", () => {
  const req = buildDeliveryStageRequest({
    schemaHashes: {
      snapshot: "hash-RoutineFleetSnapshot",
      status: "hash-RoutineStatus",
      runSummary: "hash-RoutineRunSummary",
      fleetStatus: "hash-FleetRoutineStatusV2",
      fleetSummary: "hash-FleetSummary",
      runSummaryV2: "hash-RoutineRunSummaryV2",
    },
    recipient: {
      recipientPubkey: "recipient-ed25519",
      messagingPublicKey: "messaging-x25519",
      messagingPseudonym: "00000000-0000-0000-0000-000000000001",
      recipientDisplayName: "admin",
    },
    maxRecords: 7,
  });

  expect(req).toMatchObject({
    recipient_pubkey: "recipient-ed25519",
    recipient_display_name: "admin",
    messaging_public_key: "messaging-x25519",
    messaging_pseudonym: "00000000-0000-0000-0000-000000000001",
    mode: "snapshot",
    max_records: 7,
  });
  expect(req.legs).toHaveLength(2);
  expect(req.legs[0]).toMatchObject({
    schema_name: "hash-RoutineFleetSnapshot",
    hash_keys: ["fleet-latest"],
  });
  expect(req.legs[0]!.fields).toContain("schema_hashes_json");
  expect(req.legs[1]).toMatchObject({ schema_name: "hash-RoutineStatus" });
  expect(req.legs[1]!.fields).toContain("last_outcome");
});

test("buildBoundedDeliveryStageRequests pages RoutineStatus ids and rejects a full-fleet inline field", () => {
  const ids = Array.from({ length: 72 }, (_, index) => `r${String(index).padStart(2, "0")}`);
  const pages = buildBoundedDeliveryStageRequests({
    schemaHashes: schemaHashes(),
    recipient: {
      recipientPubkey: "recipient-ed25519",
      messagingPublicKey: "messaging-x25519",
      messagingPseudonym: "00000000-0000-0000-0000-000000000001",
    },
    rowIds: ids,
  });

  expect(pages).toHaveLength(6);
  expect(pages.flatMap((page) => page.legs[1]?.hash_keys ?? [])).toEqual(ids);
  for (const page of pages) {
    const encoded = JSON.stringify(page);
    expect(encoded).not.toContain("rows_json");
    expect(page.legs[0]).toMatchObject({
      schema_name: "hash-FleetSummary",
      hash_keys: ["routines"],
    });
    expect(page.legs[1]!.schema_name).toBe("hash-RoutineStatus");
    expect(page.legs[1]!.hash_keys!.length).toBeGreaterThan(0);
    expect(page.legs[1]!.hash_keys!.length).toBeLessThanOrEqual(12);
    expect(page.max_records).toBe(page.legs[1]!.hash_keys!.length + 1);
    expect(encoded.length).toBeLessThan(64 * 1024);
    for (const leg of page.legs) {
      if (leg.schema_name === "hash-RoutineStatus" || leg.schema_name === "hash-FleetRoutineStatusV2") {
        expect(leg.hash_keys?.length ?? 0).toBeGreaterThan(0);
      }
      expect(leg.fields).not.toContain("rows_json");
    }
  }
  expect(buildBoundedDeliveryStageRequest({
    schemaHashes: schemaHashes(),
    recipient: {
      recipientPubkey: "recipient-ed25519",
      messagingPublicKey: "messaging-x25519",
      messagingPseudonym: "00000000-0000-0000-0000-000000000001",
    },
    rowIds: ids,
  })).toEqual(pages[0]!);
});

test("deliverFleetStatus publishes, stages, and optionally approves", async () => {
  const publisher = new FakeClient();
  const delivery = new FakeDeliveryClient();
  const result = await deliverFleetStatus({
    client: publisher,
    deliveryClient: delivery,
    now: new Date("2026-07-15T02:00:00.000Z"),
    runLimit: 1,
    maxRecords: 3,
    approve: true,
    recipient: {
      recipientPubkey: "recipient-ed25519",
      messagingPublicKey: "messaging-x25519",
      messagingPseudonym: "00000000-0000-0000-0000-000000000001",
    },
  });

  expect(publisher.writes.map((w) => w.schemaHash)).toContain("hash-RoutineStatus");
  expect(delivery.stagedRequests).toHaveLength(1);
  expect(delivery.stagedRequests[0]!.max_records).toBe(2);
  expect(delivery.approvedIds).toEqual(["delivery-1"]);
  expect(result.staged?.deliveryId).toBe("delivery-1");
  expect(result.approved?.shared).toBe(2);
  expect(result.stagedPages).toHaveLength(1);
  expect(result.approvedPages).toHaveLength(1);
  expect(result.boundedView?.rows).toHaveLength(1);
  expect(delivery.stagedRequests[0]!.legs.map((leg) => leg.schema_name)).toEqual([
    "hash-FleetSummary",
    "hash-RoutineStatus",
  ]);
  expect(delivery.stagedRequests[0]!.legs[1]!.hash_keys).toEqual(["alpha"]);
  expect(JSON.stringify(delivery.stagedRequests)).not.toContain("rows_json");
});

test("deliverFleetStatus permits the legacy view only inside the rollback window", async () => {
  const publisher = new FakeClient();
  publisher.seed("hash-RoutineFleetSnapshot", "fleet-latest", undefined, {
    slug: "fleet-latest",
    rows_json: JSON.stringify([{ id: "alpha" }]),
  });
  process.env.ROUTINES_FLEET_LEGACY_READ_UNTIL = "2026-07-16T00:00:00.000Z";
  const delivery = new FakeDeliveryClient();

  const result = await deliverFleetStatus({
    client: publisher,
    deliveryClient: delivery,
    legacyView: true,
    now: new Date("2026-07-15T02:00:00.000Z"),
    recipient: {
      recipientPubkey: "recipient-ed25519",
      messagingPublicKey: "messaging-x25519",
      messagingPseudonym: "00000000-0000-0000-0000-000000000001",
    },
  });

  expect(result.boundedView).toBeNull();
  expect(delivery.stagedRequests[0]!.legs.map((leg) => leg.schema_name)).toEqual([
    "hash-RoutineFleetSnapshot",
    "hash-RoutineStatus",
  ]);
});

test("deliverFleetStatus rejects an expired legacy rollback window", async () => {
  process.env.ROUTINES_FLEET_LEGACY_READ_UNTIL = "2026-07-15T01:00:00.000Z";
  await expect(deliverFleetStatus({
    client: new FakeClient(),
    deliveryClient: new FakeDeliveryClient(),
    legacyView: true,
    now: new Date("2026-07-15T02:00:00.000Z"),
    recipient: {
      recipientPubkey: "recipient-ed25519",
      messagingPublicKey: "messaging-x25519",
      messagingPseudonym: "00000000-0000-0000-0000-000000000001",
    },
  })).rejects.toThrow("ROUTINES_FLEET_LEGACY_READ_UNTIL");
});

test("clearLegacyFleetSnapshot clears the point row once", async () => {
  const client = new FakeClient();
  client.seed("hash-RoutineFleetSnapshot", "fleet-latest", undefined, {
    slug: "fleet-latest",
    rows_json: "large legacy value",
  });

  expect(await clearLegacyFleetSnapshot({ client, schemaHashes: schemaHashes() })).toBe(true);
  expect(client.record("hash-RoutineFleetSnapshot", "fleet-latest")?.rows_json).toBe("");
  const writeCount = client.writes.length;
  expect(await clearLegacyFleetSnapshot({ client, schemaHashes: schemaHashes() })).toBe(false);
  expect(client.writes).toHaveLength(writeCount);
});

test("deliverFleetStatus can validate and stage the bounded view", async () => {
  const publisher = new FakeClient();
  const delivery = new FakeDeliveryClient();
  const result = await deliverFleetStatus({
    client: publisher,
    deliveryClient: delivery,
    boundedView: true,
    now: new Date("2026-07-15T02:00:00.000Z"),
    runLimit: 1,
    recipient: {
      recipientPubkey: "recipient-ed25519",
      messagingPublicKey: "messaging-x25519",
      messagingPseudonym: "00000000-0000-0000-0000-000000000001",
    },
  });

  expect(result.boundedView?.rows).toHaveLength(1);
  expect(delivery.stagedRequests[0]!.legs.map((leg) => leg.schema_name)).toEqual([
    "hash-FleetSummary",
    "hash-RoutineStatus",
  ]);
  expect(delivery.stagedRequests[0]!.legs[1]!.hash_keys).toEqual(["alpha"]);
});

test("LastDB publisher identifies socket requests and preserves auth and JSON headers", async () => {
  const socketPath = join(home, "lastdb.sock");
  writeFileSync(socketPath, "");
  const requests: Array<{ url: string; init: RequestInit & { unix?: string } }> = [];
  const client = newLastDbPublisherClient({
    socketPath,
    nodeUrl: "http://127.0.0.1:9001",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      const body = String(input).endsWith("/api/system/auto-identity") ? { user_hash: "user-1" } : { data: [] };
      return Response.json(body);
    },
  });

  await client.autoIdentity();
  await client.queryByKey({ schemaHash: "schema-1", keyHash: "row-1", fields: ["slug"] });

  expect(requests).toHaveLength(2);
  expect(requests.every((request) => request.init.unix === socketPath)).toBe(true);
  expect(requests.map((request) => request.url)).toEqual([
    "http://localhost/api/system/auto-identity",
    "http://localhost/api/query",
  ]);
  expect(new Headers(requests[0]!.init.headers).get("X-LastDB-Client")).toBe("routines");
  const queryHeaders = new Headers(requests[1]!.init.headers);
  expect(queryHeaders.get("X-LastDB-Client")).toBe("routines");
  expect(queryHeaders.get("X-User-Hash")).toBe("user-1");
  expect(queryHeaders.get("Content-Type")).toBe("application/json");
});

test("LastDB publisher sends exact HashRange query and mutation keys", async () => {
  const socketPath = join(home, "lastdb.sock");
  writeFileSync(socketPath, "");
  const requests: Array<{ url: string; init: RequestInit & { unix?: string } }> = [];
  const client = newLastDbPublisherClient({
    socketPath,
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/api/system/auto-identity")) return Response.json({ user_hash: "user-1" });
      return Response.json({ results: [] });
    },
  });

  await client.autoIdentity();
  await client.queryByKey({
    schemaHash: "schema-1",
    keyHash: "fleet-07",
    keyRange: "active#group-a#alpha",
    fields: ["id"],
  });
  await client.mutate({
    schemaHash: "schema-1",
    keyHash: "fleet-07",
    keyRange: "active#group-a#alpha",
    fields: { id: "alpha" },
    mutationType: "create",
  });

  expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
    filter: { HashRangeKey: { hash: "fleet-07", range: "active#group-a#alpha" } },
  });
  expect(JSON.parse(String(requests[2]!.init.body))).toMatchObject({
    key_value: { hash: "fleet-07", range: "active#group-a#alpha" },
  });
});

test("LastDB publisher sends HashKeys queries and mutations/batch writes", async () => {
  const socketPath = join(home, "lastdb.sock");
  writeFileSync(socketPath, "");
  const requests: Array<{ url: string; init: RequestInit & { unix?: string } }> = [];
  const client = newLastDbPublisherClient({
    socketPath,
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/api/system/auto-identity")) return Response.json({ user_hash: "user-1" });
      if (String(input).endsWith("/api/query")) {
        return Response.json({
          results: [
            { key: { hash: "alpha", range: null }, fields: { id: "alpha" } },
            { key: { hash: "beta", range: null }, fields: { id: "beta" } },
          ],
        });
      }
      return Response.json({ count: 2 });
    },
  });

  await client.autoIdentity();
  const rows = await client.queryByKeys({
    schemaHash: "schema-1",
    keyHashes: ["beta", "alpha"],
    fields: ["id"],
  });
  await client.mutateBatch([
    {
      schemaHash: "schema-1",
      keyHash: "alpha",
      fields: { id: "alpha" },
      mutationType: "create",
    },
    {
      schemaHash: "schema-1",
      keyHash: "beta",
      fields: { id: "beta" },
      mutationType: "update",
    },
  ]);

  expect(rows.map((row) => row.keyHash).sort()).toEqual(["alpha", "beta"]);
  expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
    filter: { HashKeys: ["alpha", "beta"] },
    limit: 2,
  });
  expect(requests[2]!.url).toBe("http://localhost/api/mutations/batch");
  expect(JSON.parse(String(requests[2]!.init.body))).toMatchObject({
    mutations: [
      { schema: "schema-1", key_value: { hash: "alpha", range: null }, mutation_type: "create" },
      { schema: "schema-1", key_value: { hash: "beta", range: null }, mutation_type: "update" },
    ],
  });
});

test("LastDB delivery identifies explicit loopback requests", async () => {
  const requests: Array<{ url: string; init: RequestInit & { unix?: string } }> = [];
  const client = newLastDbDeliveryClient({
    socketPath: join(home, "missing-lastdb.sock"),
    nodeUrl: "http://127.0.0.1:19001",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return Response.json({
        data: {
          delivery: {
            delivery_id: "delivery-1",
            preview: { record_count: 1, fields: ["slug"] },
          },
          note: "staged",
        },
      });
    },
  });

  await client.stageDelivery({
    recipient_pubkey: "recipient-ed25519",
    messaging_public_key: "messaging-x25519",
    messaging_pseudonym: "00000000-0000-0000-0000-000000000001",
    mode: "snapshot",
    max_records: 1,
    legs: [{ schema_name: "schema-1", fields: ["slug"], hash_keys: ["fleet-latest"] }],
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("http://127.0.0.1:19001/api/sharing/deliver");
  expect(requests[0]!.init.unix).toBeUndefined();
  const headers = new Headers(requests[0]!.init.headers);
  expect(headers.get("X-LastDB-Client")).toBe("routines");
  expect(headers.get("Content-Type")).toBe("application/json");
});

class FakeClient implements LastDbPublisherClient {
  declared: SchemaDefinition[] = [];
  writes: Array<{
    schemaHash: string;
    keyHash: string;
    keyRange?: string;
    fields: Record<string, string>;
    mutationType: "create" | "update" | "delete";
  }> = [];
  private records = new Map<string, Record<string, string>>();
  hashQueries: Array<{ schemaHash: string; keyHash: string }> = [];
  keyQueries: Array<{ schemaHash: string; keyHash: string; keyRange?: string }> = [];
  hashKeysQueries: Array<{ schemaHash: string; keyHashes: string[] }> = [];
  hashRangeKeyQueries: Array<{ schemaHash: string; keys: Array<{ hash: string; range: string }> }> = [];
  batchMutations: Array<Array<{
    schemaHash: string;
    keyHash: string;
    keyRange?: string;
    fields: Record<string, string>;
    mutationType: "create" | "update" | "delete";
  }>> = [];
  hideNextFleetRow = false;
  failSchemaHash = "";

  async autoIdentity(): Promise<{ userHash: string }> {
    return { userHash: "user" };
  }

  async declareAppSchema(
    _appId: string,
    schema: SchemaDefinition,
  ): Promise<{ canonical: string; schemaName: string }> {
    this.declared.push(schema);
    return { canonical: `hash-${schema.name}`, schemaName: `routines/${schema.name}` };
  }

  async queryByKey(opts: { schemaHash: string; keyHash: string; keyRange?: string }): Promise<Record<string, string> | null> {
    this.keyQueries.push({ schemaHash: opts.schemaHash, keyHash: opts.keyHash, keyRange: opts.keyRange });
    return this.record(opts.schemaHash, opts.keyHash, opts.keyRange);
  }

  async queryByKeys(opts: { schemaHash: string; keyHashes: string[] }): Promise<Array<{ keyHash: string; fields: Record<string, string> }>> {
    this.hashKeysQueries.push({ schemaHash: opts.schemaHash, keyHashes: [...opts.keyHashes] });
    const out: Array<{ keyHash: string; fields: Record<string, string> }> = [];
    for (const keyHash of opts.keyHashes) {
      const fields = this.record(opts.schemaHash, keyHash);
      if (fields) out.push({ keyHash, fields });
    }
    return out;
  }

  async queryByHashRangeKeys(opts: {
    schemaHash: string;
    keys: Array<{ hash: string; range: string }>;
  }): Promise<Array<{ keyHash: string; keyRange: string; fields: Record<string, string> }>> {
    this.hashRangeKeyQueries.push({ schemaHash: opts.schemaHash, keys: opts.keys.map((key) => ({ ...key })) });
    const out: Array<{ keyHash: string; keyRange: string; fields: Record<string, string> }> = [];
    for (const key of opts.keys) {
      const fields = this.record(opts.schemaHash, key.hash, key.range);
      if (fields) out.push({ keyHash: key.hash, keyRange: key.range, fields });
    }
    return out;
  }

  async mutate(opts: {
    schemaHash: string;
    keyHash: string;
    keyRange?: string;
    fields: Record<string, string>;
    mutationType: "create" | "update" | "delete";
  }): Promise<void> {
    this.writes.push(opts);
    if (opts.schemaHash === this.failSchemaHash) throw new Error("forced mutation failure");
    const key = this.recordKey(opts.schemaHash, opts.keyHash, opts.keyRange);
    if (opts.mutationType === "delete") this.records.delete(key);
    else this.records.set(key, { ...opts.fields });
    if (opts.schemaHash === "hash-RoutineRunSummary" && opts.mutationType === "create") {
      const { slug: _slug, ...sharedFields } = opts.fields;
      this.records.set(
        this.recordKey("hash-RoutineRunSummaryV2", opts.fields.id!, opts.fields.stamp),
        sharedFields,
      );
    }
  }

  async mutateBatch(ops: Array<{
    schemaHash: string;
    keyHash: string;
    keyRange?: string;
    fields: Record<string, string>;
    mutationType: "create" | "update" | "delete";
  }>): Promise<void> {
    if (ops.length === 0) return;
    this.batchMutations.push(ops.map((op) => ({ ...op, fields: { ...op.fields } })));
    for (const op of ops) await this.mutate(op);
  }

  async queryByHash(opts: { schemaHash: string; keyHash: string; maxRows: number }) {
    this.hashQueries.push({ schemaHash: opts.schemaHash, keyHash: opts.keyHash });
    const rows = this.partition(opts.schemaHash, opts.keyHash).slice(0, opts.maxRows);
    if (opts.schemaHash === "hash-FleetRoutineStatusV2" && this.hideNextFleetRow && rows.length > 0) {
      this.hideNextFleetRow = false;
      return rows.slice(1);
    }
    return rows;
  }

  seed(schemaHash: string, keyHash: string, keyRange: string | undefined, fields: Record<string, string>): void {
    this.records.set(this.recordKey(schemaHash, keyHash, keyRange), { ...fields });
  }

  record(schemaHash: string, keyHash: string, keyRange?: string): Record<string, string> | null {
    return this.records.get(this.recordKey(schemaHash, keyHash, keyRange)) ?? null;
  }

  partition(schemaHash: string, keyHash: string): Array<{ keyRange: string; fields: Record<string, string> }> {
    const prefix = `${schemaHash}\u0000${keyHash}\u0000`;
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, fields]) => ({ keyRange: key.slice(prefix.length), fields }));
  }

  private recordKey(schemaHash: string, keyHash: string, keyRange?: string): string {
    return `${schemaHash}\u0000${keyHash}\u0000${keyRange ?? ""}`;
  }
}

function schemaHashes() {
  return {
    snapshot: "hash-RoutineFleetSnapshot",
    status: "hash-RoutineStatus",
    runSummary: "hash-RoutineRunSummary",
    fleetStatus: "hash-FleetRoutineStatusV2",
    fleetSummary: "hash-FleetSummary",
    runSummaryV2: "hash-RoutineRunSummaryV2",
  } as const;
}

class FakeDeliveryClient implements LastDbDeliveryClient {
  stagedRequests: Array<Parameters<LastDbDeliveryClient["stageDelivery"]>[0]> = [];
  approvedIds: string[] = [];

  async stageDelivery(request: Parameters<LastDbDeliveryClient["stageDelivery"]>[0]) {
    this.stagedRequests.push(request);
    return {
      deliveryId: `delivery-${this.stagedRequests.length}`,
      recordCount: 2,
      fields: ["id", "status"],
      note: "staged only",
    };
  }

  async approveDelivery(deliveryId: string) {
    this.approvedIds.push(deliveryId);
    return {
      deliveryId,
      shared: 2,
      messageType: "delivery_slice",
    };
  }
}
