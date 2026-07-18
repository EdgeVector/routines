import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dueOccurrence,
  evaluateOnce,
  formatConcurrency,
  normalizeConcurrency,
  startDaemon,
} from "../src/daemon.ts";
import { loadEntry } from "../src/registry.ts";
import { runRoutine } from "../src/runner.ts";
import { readState, writeState } from "../src/state.ts";

let home: string;
let heartbeatOut: string;

const savedEnv = { ...process.env };

function stub(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  process.env = { ...savedEnv };
  home = mkdtempSync(join(tmpdir(), "routines-test-"));
  process.env.ROUTINES_HOME = home;
  process.env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES = "1";
  delete process.env.FOLDDB_SOCKET_PATH;
  delete process.env.FBRAIN_FOLDDB_SOCKET;
  delete process.env.LASTGIT_SOCKET;
  delete process.env.LASTDB_SOCKET_PATH;
  delete process.env.LASTDB_HOME;
  delete process.env.FOLDDB_HOME;
  delete process.env.ROUTINES_SITUATIONS_CLI;
  mkdirSync(join(home, "registry"), { recursive: true });

  const harnessStub = stub(
    join(home, "stub-harness"),
    '#!/bin/sh\necho "STUB-RAN $*"\nexit 0\n',
  );
  process.env.ROUTINES_CLAUDE_BIN = harnessStub;
  process.env.ROUTINES_CODEX_BIN = harnessStub;
  process.env.ROUTINES_GROK_BIN = harnessStub;

  // fsituations stub: one active situation scoping *fenced*
  const sit = stub(
    join(home, "stub-fsituations"),
    '#!/bin/sh\ncat <<\'JSON\'\n[{"slug":"test-sit","status":"active","scope_routines":["*fenced*"]}]\nJSON\n',
  );
  process.env.ROUTINES_FSITUATIONS_BIN = sit;

  // Heartbeats now write straight to a filesystem log, not via fbrain.
  heartbeatOut = join(home, "heartbeats.log");
  process.env.ROUTINES_HEARTBEATS_FILE = heartbeatOut;
});

afterAll(() => {
  process.env = { ...savedEnv };
});

function writeRoutine(id: string, harness: string, fields: string[] = []) {
  writeFileSync(
    join(home, "registry", `${id}.toml`),
    [
      `harness = "${harness}"`,
      'model = "test-model"',
      'rrule = "FREQ=SECONDLY"',
      'prompt = "hello from ' + id + '"',
      'heartbeat_slug = "routine-heartbeats"',
      ...fields,
    ].join("\n") + "\n",
  );
}

describe("daemon evaluateOnce", () => {
  test("fires both harnesses, writes run logs + heartbeats, honors the fence", async () => {
    writeRoutine("e2e-claude", "claude");
    writeRoutine("e2e-codex", "codex");
    writeRoutine("test-fenced-routine", "claude");

    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      log: (e) => events.push(`${e.kind}:${e.id ?? ""}`),
    });

    // both non-fenced routines ran; fenced one did not
    const ranIds = results.map((r) => r.id).sort();
    expect(ranIds).toEqual(["e2e-claude", "e2e-codex"]);
    for (const r of results) {
      expect(r.exitCode).toBe(0);
      expect(existsSync(join(r.runDir, "meta.json"))).toBe(true);
      expect(existsSync(join(r.runDir, "stdout.log"))).toBe(true);
      expect(existsSync(join(r.runDir, "prompt.txt"))).toBe(true);
      expect(readFileSync(join(r.runDir, "stdout.log"), "utf8")).toContain("STUB-RAN");
    }

    // fence skip logged and no run dir for the fenced routine
    expect(events).toContain("skip-fence:test-fenced-routine");
    expect(existsSync(join(home, "runs", "test-fenced-routine"))).toBe(false);

    // heartbeats: one line per successful run
    const hb = readFileSync(heartbeatOut, "utf8").trim().split("\n");
    expect(hb.length).toBe(2);
    expect(hb.every((l) => l.includes("ok") && l.includes("harness="))).toBe(true);
  });

  test("manual run-now failure does not overwrite scheduled status or escalate", async () => {
    const failingHarness = stub(
      join(home, "failing-harness"),
      '#!/bin/sh\necho "local codex sandbox failed" >&2\nexit 1\n',
    );
    process.env.ROUTINES_CODEX_BIN = failingHarness;
    writeRoutine("manual-fail", "codex");
    writeState({
      id: "manual-fail",
      lastRun: "2026-07-16T18:00:00.000Z",
      lastExit: 0,
      lastRunDir: "/tmp/green-run",
      lastOutcome: "ok",
      lastOutcomeDetail: "scheduled green",
    });

    const entry = loadEntry("manual-fail");
    const result = await runRoutine(entry, { quiet: true, trigger: "manual" });

    expect(result.exitCode).toBe(1);
    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.trigger).toBe("manual");
    expect(readState("manual-fail")).toMatchObject({
      lastRun: "2026-07-16T18:00:00.000Z",
      lastExit: 0,
      lastRunDir: "/tmp/green-run",
      lastOutcome: "ok",
    });
    expect(existsSync(join(home, "error-escalate"))).toBe(false);
  });

  test("cron warm-up: a fresh routine with no catch-up does not fire on first sight", () => {
    writeRoutine("warm", "claude");
    const entry = loadEntry("warm");
    const occ = dueOccurrence(entry, new Date(), 0, () => {});
    expect(occ).toBeNull(); // warm-up baseline written, not due yet
    // a second pass is now due (SECONDLY, baseline in the past)
    const occ2 = dueOccurrence(entry, new Date(Date.now() + 2000), 0, () => {});
    expect(occ2).not.toBeNull();
  });

  test("paused routines are skipped", async () => {
    writeRoutine("paused-one", "claude", ['status = "paused"']);
    const results = await evaluateOnce({ once: true, catchupMs: 60_000 });
    expect(results.length).toBe(0);
    expect(existsSync(join(home, "runs", "paused-one"))).toBe(false);
  });

  test("dispatch envelope uses registry id for automation memory, not prompt frontmatter name", async () => {
    const prompt = [
      "---",
      "name: kanban-pickup",
      "description: frontmatter name differs from registry id",
      "---",
      "Do the work.",
    ].join("\n");
    writeFileSync(
      join(home, "registry", "last-stack-fkanban-pickup.toml"),
      [
        'harness = "codex"',
        'model = "test-model"',
        'rrule = "FREQ=SECONDLY"',
        `prompt = ${JSON.stringify(prompt)}`,
        'heartbeat_slug = "routine-heartbeats"',
      ].join("\n") + "\n",
    );

    const results = await evaluateOnce({ once: true, catchupMs: 60_000 });
    expect(results.map((r) => r.id)).toEqual(["last-stack-fkanban-pickup"]);

    const [result] = results;
    expect(result).toBeDefined();
    if (!result) throw new Error("expected dispatched run");

    const dispatched = readFileSync(join(result.runDir, "prompt.txt"), "utf8");
    const memoryPath = join(home, "memory", "last-stack-fkanban-pickup", "memory.md");
    expect(dispatched).toContain("## Dispatch envelope (routinesd)");
    expect(dispatched).toContain("Automation ID: last-stack-fkanban-pickup");
    expect(dispatched).toContain(`Automation memory: ${memoryPath}`);
    expect(dispatched).toContain("name: kanban-pickup");
    expect(dispatched).not.toContain(".codex/automations/kanban-pickup");
    expect(existsSync(join(home, "memory", "last-stack-fkanban-pickup"))).toBe(true);
  });

  test("run dirs accumulate per routine", async () => {
    writeRoutine("multi", "claude");
    await evaluateOnce({ once: true, catchupMs: 60_000 });
    // second pass: lastFire advanced but SECONDLY -> due again a second later
    await new Promise((r) => setTimeout(r, 1100));
    await evaluateOnce({ once: true, catchupMs: 60_000 });
    const dirs = readdirSync(join(home, "runs", "multi"));
    expect(dirs.length).toBeGreaterThanOrEqual(1);
  });

  test("injects live full-surface socket env when canonical socket is absent", async () => {
    const nodeHome = join(home, "node");
    const socket = join(nodeHome, "data", "folddb-full.sock");
    mkdirSync(join(nodeHome, "data"), { recursive: true });
    writeFileSync(socket, "");
    process.env.LASTDB_HOME = nodeHome;

    const harnessStub = stub(
      join(home, "socket-env-harness"),
      [
        "#!/bin/sh",
        'echo "FOLDDB_SOCKET_PATH=$FOLDDB_SOCKET_PATH"',
        'echo "FBRAIN_FOLDDB_SOCKET=$FBRAIN_FOLDDB_SOCKET"',
        'echo "LASTGIT_SOCKET=$LASTGIT_SOCKET"',
        'echo "LASTDB_SOCKET_PATH=$LASTDB_SOCKET_PATH"',
        "exit 0",
      ].join("\n") + "\n",
    );
    process.env.ROUTINES_CODEX_BIN = harnessStub;
    writeRoutine("socket-env", "codex");

    const [result] = await evaluateOnce({ once: true, catchupMs: 60_000, log: () => {} });
    if (!result) throw new Error("expected socket-env routine to dispatch");
    const stdout = readFileSync(join(result.runDir, "stdout.log"), "utf8");

    expect(stdout).toContain(`FOLDDB_SOCKET_PATH=${socket}`);
    expect(stdout).toContain(`FBRAIN_FOLDDB_SOCKET=${socket}`);
    expect(stdout).toContain(`LASTGIT_SOCKET=${socket}`);
    expect(stdout).toContain(`LASTDB_SOCKET_PATH=${socket}`);
  });

  test("default concurrency is unlimited (no skip-cap when many are due)", async () => {
    for (const id of ["u1", "u2", "u3", "u4", "u5"]) {
      writeRoutine(id, "claude");
    }
    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      // omit concurrency → unlimited
      log: (e) => events.push(`${e.kind}:${e.id ?? e.detail ?? ""}`),
    });
    expect(results.map((r) => r.id).sort()).toEqual(["u1", "u2", "u3", "u4", "u5"]);
    expect(events.some((e) => e.startsWith("skip-cap:"))).toBe(false);
    expect(events.some((e) => e.includes("concurrency=unlimited"))).toBe(true);
  });

  test("positive concurrency still skip-caps when full (evaluateOnce)", async () => {
    writeRoutine("c1", "claude");
    writeRoutine("c2", "claude");
    writeRoutine("c3", "claude");
    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      concurrency: 1,
      log: (e) => events.push(`${e.kind}:${e.id ?? ""}`),
    });
    // Alphabetical: c1 starts; c2 and c3 skip-cap in the same pass.
    expect(results.map((r) => r.id)).toEqual(["c1"]);
    expect(events.filter((e) => e.startsWith("skip-cap:")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("normalizeConcurrency / formatConcurrency", () => {
  test("0 / unset / negative mean unlimited", () => {
    expect(normalizeConcurrency(undefined)).toBe(0);
    expect(normalizeConcurrency(0)).toBe(0);
    expect(normalizeConcurrency(-1)).toBe(0);
    expect(normalizeConcurrency(NaN)).toBe(0);
    expect(formatConcurrency(0)).toBe("unlimited");
    expect(formatConcurrency(10)).toBe("10");
  });
});

describe("daemon free-slot pool", () => {
  test("when a slot frees, the next due routine starts without waiting for the whole batch", async () => {
    // Slow harness (~200ms). HOURLY rrule so a completed routine is not
    // immediately due again; free-slot + fair order must then drain b and c.
    const slow = stub(
      join(home, "slow-harness"),
      "#!/bin/sh\nsleep 0.2\necho SLOW-OK\nexit 0\n",
    );
    process.env.ROUTINES_CLAUDE_BIN = slow;
    process.env.ROUTINES_CODEX_BIN = slow;

    for (const id of ["fs-a", "fs-b", "fs-c"]) {
      writeFileSync(
        join(home, "registry", `${id}.toml`),
        [
          'harness = "claude"',
          'model = "test-model"',
          'rrule = "FREQ=HOURLY"',
          `prompt = "hello from ${id}"`,
          'heartbeat_slug = "routine-heartbeats"',
        ].join("\n") + "\n",
      );
    }

    const events: { t: number; kind: string; id?: string }[] = [];
    const t0 = Date.now();
    const handle = startDaemon({
      tickMs: 40,
      concurrency: 1,
      catchupMs: 3_600_000, // one hourly occurrence due
      log: (e) => events.push({ t: Date.now() - t0, kind: e.kind, id: e.id }),
    });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const doneIds = new Set(events.filter((e) => e.kind === "complete").map((e) => e.id));
      if (doneIds.size >= 3) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    handle.stop();
    await handle.done;

    const dispatches = events.filter((e) => e.kind === "dispatch").map((e) => e.id);
    const completes = events.filter((e) => e.kind === "complete").map((e) => e.id);
    expect(new Set(dispatches)).toEqual(new Set(["fs-a", "fs-b", "fs-c"]));
    expect(new Set(completes)).toEqual(new Set(["fs-a", "fs-b", "fs-c"]));

    // Free-slot: after first complete, another dispatch happens (not batch-wait).
    const timeline = events.filter((e) => e.kind === "dispatch" || e.kind === "complete");
    const firstCompleteIdx = timeline.findIndex((e) => e.kind === "complete");
    expect(firstCompleteIdx).toBeGreaterThanOrEqual(0);
    expect(timeline.slice(firstCompleteIdx + 1).some((e) => e.kind === "dispatch")).toBe(true);

    // Under concurrency=1 the other due routines skip-cap until a slot frees.
    expect(events.some((e) => e.kind === "skip-cap")).toBe(true);
  });
});
