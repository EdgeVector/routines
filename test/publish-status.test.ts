import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildFleetPublication,
  publishFleetStatus,
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

test("publishFleetStatus declares schemas and upserts snapshot, rows, and run summaries", async () => {
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
  });
  expect(result.written).toEqual({ snapshots: 1, rows: 1, runSummaries: 1 });
  expect(client.declared).toEqual(["RoutineFleetSnapshot", "RoutineStatus", "RoutineRunSummary"]);
  expect(client.writes.map((w) => [w.schemaHash, w.keyHash, w.mutationType])).toEqual([
    ["hash-RoutineFleetSnapshot", "fleet-latest", "create"],
    ["hash-RoutineStatus", "alpha", "create"],
    ["hash-RoutineRunSummary", "alpha/20260715T010203Z", "create"],
  ]);
});

class FakeClient implements LastDbPublisherClient {
  declared: string[] = [];
  writes: Array<{ schemaHash: string; keyHash: string; mutationType: "create" | "update" }> = [];

  async autoIdentity(): Promise<{ userHash: string }> {
    return { userHash: "user" };
  }

  async declareAppSchema(
    _appId: string,
    schema: { name: string },
  ): Promise<{ canonical: string; schemaName: string }> {
    this.declared.push(schema.name);
    return { canonical: `hash-${schema.name}`, schemaName: `routines/${schema.name}` };
  }

  async queryByKey(): Promise<Record<string, string> | null> {
    return null;
  }

  async mutate(opts: {
    schemaHash: string;
    keyHash: string;
    mutationType: "create" | "update";
  }): Promise<void> {
    this.writes.push(opts);
  }
}
