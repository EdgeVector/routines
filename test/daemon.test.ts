import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonEvent } from "../src/daemon.ts";
import {
  DEFAULT_STAGGER_MS,
  dispatchDue,
  dueOccurrence,
  evaluateOnce,
  formatStagger,
  normalizeStaggerMs,
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
  process.env.ROUTINES_WORKSPACE_ROOT = home;
  process.env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES = "1";
  delete process.env.FOLDDB_SOCKET_PATH;
  delete process.env.FBRAIN_FOLDDB_SOCKET;
  delete process.env.LASTGIT_SOCKET;
  delete process.env.LASTDB_SOCKET_PATH;
  delete process.env.LASTDB_HOME;
  delete process.env.FOLDDB_HOME;
  delete process.env.ROUTINES_SITUATIONS_CLI;
  // Tests that assert the built-in fallback order must not inherit a live
  // fleet profile from the developer's shell.
  delete process.env.ROUTINES_FALLBACK_CHAIN;
  // A fallback leg sleeps a RANDOM 0..DEFAULT_FALLBACK_JITTER_MS (8s) before it
  // spawns, to spread a production burst. Inherited here it decided pass/fail by
  // coin flip: "harness-outage fence bypasses only when local state selects an
  // alternate route" measured 4.86s against bun's 5s default and failed roughly
  // every other run. test/fallback.test.ts already pins this to 0; daemon tests
  // need the same pin, since they assert scheduling, not burst spreading.
  process.env.ROUTINES_FALLBACK_JITTER_MS = "0";
  // Every dispatched routine builds a prompt envelope, and the envelope asks
  // the situations CLI for recent notices — one extra process spawn per
  // dispatch. Measured at ~190 ms per spawn on a loaded machine, that was
  // ~400 ms per test of wall time no assertion in this file reads. These tests
  // assert scheduling, not the notices banner, so take the supported skip.
  process.env.ROUTINES_SKIP_NOTICES = "1";
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
  test("matrix availability follows outage Situations while explicit pins stay fixed", async () => {
    const situationState = join(home, "situations.json");
    writeFileSync(situationState, "[]\n");
    process.env.ROUTINES_FSITUATIONS_BIN = stub(
      join(home, "availability-situations"),
      `#!/bin/sh\ncat ${JSON.stringify(situationState)}\n`,
    );
    process.env.ROUTINES_ROUTING_MATRIX_PATH = join(home, "routing-matrix.json");
    writeFileSync(process.env.ROUTINES_ROUTING_MATRIX_PATH, JSON.stringify({
      version: 4,
      providerOrder: ["grok", "codex", "claude"],
      matrix: {
        fast: { grok: { model: "g-fast" }, codex: { model: "c-fast" }, claude: { model: "a-fast" } },
        normal: { grok: { model: "g-normal" }, codex: { model: "c-normal" }, claude: { model: "a-normal" } },
        hard: { grok: { model: "g-hard" }, codex: { model: "c-hard" }, claude: { model: "a-hard" } },
      },
    }));
    const matrixRegistry = 'difficulty = "normal"\nrrule = "FREQ=SECONDLY"\nprompt = "matrix"\n';
    writeFileSync(join(home, "registry", "matrix-live.toml"), matrixRegistry);
    writeFileSync(
      join(home, "registry", "smoke-grok.toml"),
      'pin = true\nharness = "grok"\nmodel = "grok-smoke"\nrrule = "FREQ=SECONDLY"\nprompt = "pin"\n',
    );

    const fire = async () => {
      for (const id of ["matrix-live", "smoke-grok"]) {
        writeState({ id, lastFire: "2000-01-01T00:00:00.000Z" });
      }
      // staggerMs: 0 — this asserts routing across several routines in one pass.
      const results = await evaluateOnce({
        once: true,
        catchupMs: 60_000,
        staggerMs: 0,
        log: () => {},
      });
      return new Map(results.map((result) => [
        result.id,
        JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8")),
      ]));
    };

    let meta = await fire();
    expect(meta.get("matrix-live")).toMatchObject({
      harness: "grok",
      resolvedBy: "matrix",
      matrixResolution: { version: 4, difficulty: "normal", harness: "grok", model: "g-normal" },
    });

    writeFileSync(situationState, JSON.stringify([{
      slug: "harness-outage-grok",
      status: "active",
      scope_routines: ["matrix-live"],
    }]));
    meta = await fire();
    expect(meta.get("matrix-live")).toMatchObject({
      harness: "codex",
      resolvedBy: "matrix",
      matrixResolution: { version: 4, difficulty: "normal", harness: "codex", model: "c-normal" },
    });
    expect(meta.get("smoke-grok")).toMatchObject({
      harness: "grok",
      resolvedBy: "pin",
      matrixResolution: null,
    });
    expect(readFileSync(join(home, "registry", "matrix-live.toml"), "utf8")).toBe(matrixRegistry);

    writeFileSync(situationState, "[]\n");
    meta = await fire();
    expect(meta.get("matrix-live")).toMatchObject({
      harness: "grok",
      resolvedBy: "matrix",
      matrixResolution: { harness: "grok", model: "g-normal" },
    });
  });

  test("fires both harnesses, writes run logs + heartbeats, honors the fence", async () => {
    writeRoutine("e2e-claude", "claude");
    writeRoutine("e2e-codex", "codex");
    writeRoutine("test-fenced-routine", "claude");

    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      staggerMs: 0, // asserting both harnesses in one pass
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

  test("a slow pre-dispatch gate does not delay another routine timeout", async () => {
    process.env.ROUTINES_SIGKILL_GRACE_MS = "50";
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "hung-harness"),
      "#!/bin/sh\nsleep 5\n",
    );
    const slowGate = stub(
      join(home, "slow-gate"),
      [
        "#!/bin/sh",
        "sleep 2",
        "printf '%s\\n' 'ROUTINE_RESULT outcome=noop detail=gate-finished'",
        "exit 0",
        "",
      ].join("\n"),
    );

    writeRoutine("a-timeout", "claude", ["timeout_min = 0.002"]);
    writeRoutine("b-slow-gate", "claude", [
      "timeout_min = 1",
      `gate_command = ${JSON.stringify(slowGate)}`,
    ]);

    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      staggerMs: 0, // both routines must start together to race the gate
      log: () => {},
    });
    const timed = results.find((result) => result.id === "a-timeout");
    const gated = results.find((result) => result.id === "b-slow-gate");

    expect(timed?.timedOut).toBe(true);
    expect(timed?.durationMs).toBeLessThan(1_000);
    expect(gated?.outcome.kind).toBe("noop");
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

  test("first successful manual run bootstraps empty routine status", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "manual-smoke-harness"),
      '#!/bin/sh\nprintf \'%s\\n\' \'manual-smoke noop production-smoke-safe\'\nexit 0\n',
    );
    writeRoutine("manual-smoke", "claude");

    const result = await runRoutine(loadEntry("manual-smoke"), {
      quiet: true,
      trigger: "manual",
    });

    expect(result.exitCode).toBe(0);
    expect(result.outcome.kind).toBe("noop");
    expect(readState("manual-smoke")).toMatchObject({
      lastRun: result.finishedAt,
      lastExit: 0,
      lastRunDir: result.runDir,
      lastOutcome: "noop",
      lastOutcomeDetail: "production-smoke-safe",
    });
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

  test("coalesces stale hourly backlog to one latest due occurrence", () => {
    writeFileSync(
      join(home, "registry", "hourly-backlog.toml"),
      [
        'harness = "claude"',
        'model = "test-model"',
        'rrule = "DTSTART=20260721T000000;FREQ=HOURLY"',
        'prompt = "hourly backlog"',
        'heartbeat_slug = "routine-heartbeats"',
      ].join("\n") + "\n",
    );
    writeState({
      id: "hourly-backlog",
      lastFire: new Date(2026, 6, 21, 0, 0, 0).toISOString(),
    });
    const entry = loadEntry("hourly-backlog");
    const events: string[] = [];

    const occ = dueOccurrence(entry, new Date(2026, 6, 21, 5, 30, 0), 0, (e) => {
      events.push(`${e.kind}:${e.id ?? ""}:${e.detail ?? ""}`);
    });

    expect(occ?.getTime()).toBe(new Date(2026, 6, 21, 5, 0, 0).getTime());
    expect(events).toContain(
      `coalesce-backlog:hourly-backlog:since=${new Date(2026, 6, 21, 0, 0, 0).toISOString()}`,
    );
  });

  test("paused routines are skipped", async () => {
    writeRoutine("paused-one", "claude", ['status = "paused"']);
    const results = await evaluateOnce({ once: true, catchupMs: 60_000 });
    expect(results.length).toBe(0);
    expect(existsSync(join(home, "runs", "paused-one"))).toBe(false);
  });

  test("stale harness-outage Situation does not dispatch onto the fenced harness", async () => {
    const sit = stub(
      join(home, "stub-fsituations"),
      '#!/bin/sh\ncat <<\'JSON\'\n[{"slug":"harness-outage-claude","status":"active","scope_routines":["claude-primary"]}]\nJSON\n',
    );
    process.env.ROUTINES_FSITUATIONS_BIN = sit;
    writeRoutine("claude-primary", "claude");

    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      log: (e) => events.push(`${e.kind}:${e.id ?? ""}:${e.detail ?? ""}`),
    });

    expect(results.length).toBe(0);
    expect(events.some((e) => e.startsWith("skip-fence:claude-primary:"))).toBe(true);
    expect(existsSync(join(home, "runs", "claude-primary"))).toBe(false);
  });

  test("harness-outage fence bypasses only when local state selects an alternate route", async () => {
    const sit = stub(
      join(home, "stub-fsituations"),
      '#!/bin/sh\ncat <<\'JSON\'\n[{"slug":"harness-outage-claude","status":"active","scope_routines":["claude-primary"]}]\nJSON\n',
    );
    process.env.ROUTINES_FSITUATIONS_BIN = sit;
    writeRoutine("claude-primary", "claude");
    mkdirSync(join(home, "harness-outage"), { recursive: true });
    writeFileSync(
      join(home, "harness-outage", "claude.json"),
      JSON.stringify(
        {
          kind: "capacity",
          lastSeenAt: "2026-07-18T00:48:41.017Z",
          situationSlug: "harness-outage-claude",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      log: (e) => events.push(`${e.kind}:${e.id ?? ""}:${e.detail ?? ""}`),
    });

    expect(results.map((r) => r.id)).toEqual(["claude-primary"]);
    const meta = JSON.parse(readFileSync(join(results[0]!.runDir, "meta.json"), "utf8"));
    expect(meta.harness).toBe("grok");
    expect(meta.usedFallback).toBe(true);
    expect(events.some((e) => e.includes("bypassed via fallback chain"))).toBe(true);
  });

  // Regression: 2026-08-29. claude, codex and grok were all recorded outaged
  // at once. `routesForFire` returns the chain WHOLE when no hop is healthy,
  // so `[0]` was the fenced primary, the bypass was denied, and routinesd
  // dispatched nothing for 14h54m. A zero-LLM gate needs no provider at all,
  // and `runRoutine`'s own `allRoutesFenced` branch is written to run it.
  function fenceEveryHarness() {
    mkdirSync(join(home, "harness-outage"), { recursive: true });
    for (const harness of ["claude", "codex", "grok", "gemini"]) {
      writeFileSync(
        join(home, "harness-outage", `${harness}.json`),
        JSON.stringify(
          {
            kind: "usage-limit",
            lastSeenAt: "2026-08-29T04:00:00.000Z",
            situationSlug: `harness-outage-${harness}`,
            expiresAt: "2999-01-01T00:00:00.000Z",
          },
          null,
          2,
        ),
      );
    }
  }

  test("every harness fenced still runs a zero-LLM gate routine", async () => {
    process.env.ROUTINES_FSITUATIONS_BIN = stub(
      join(home, "stub-fsituations"),
      '#!/bin/sh\ncat <<\'JSON\'\n[{"slug":"harness-outage-grok","status":"active","scope_routines":["gated-routine"]}]\nJSON\n',
    );
    const gate = stub(
      join(home, "zero-llm-gate"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'ROUTINE_RESULT outcome=ok detail=gate-ran-without-a-provider'",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeRoutine("gated-routine", "grok", [`gate_command = ${JSON.stringify(gate)}`]);
    fenceEveryHarness();

    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      log: (e) => events.push(`${e.kind}:${e.id ?? ""}:${e.detail ?? ""}`),
    });

    expect(results.map((r) => r.id)).toEqual(["gated-routine"]);
    expect(results[0]!.outcome.kind).toBe("ok");
    expect(events.some((e) => e.startsWith("skip-fence:gated-routine:"))).toBe(false);
  });

  test("every harness fenced still fences a routine with no gate", async () => {
    process.env.ROUTINES_FSITUATIONS_BIN = stub(
      join(home, "stub-fsituations"),
      '#!/bin/sh\ncat <<\'JSON\'\n[{"slug":"harness-outage-grok","status":"active","scope_routines":["ungated-routine"]}]\nJSON\n',
    );
    writeRoutine("ungated-routine", "grok");
    fenceEveryHarness();

    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      log: (e) => events.push(`${e.kind}:${e.id ?? ""}:${e.detail ?? ""}`),
    });

    expect(results.length).toBe(0);
    expect(events.some((e) => e.startsWith("skip-fence:ungated-routine:"))).toBe(true);
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

  test("stagger off dispatches every due routine in one pass (no cap exists)", async () => {
    for (const id of ["u1", "u2", "u3", "u4", "u5"]) {
      writeRoutine(id, "claude");
    }
    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      staggerMs: 0,
      log: (e) => events.push(`${e.kind}:${e.id ?? e.detail ?? ""}`),
    });
    expect(results.map((r) => r.id).sort()).toEqual(["u1", "u2", "u3", "u4", "u5"]);
    expect(events.some((e) => e.startsWith("defer-stagger:"))).toBe(false);
    expect(events.some((e) => e.includes("stagger=off"))).toBe(true);
  });

  test("stagger admits one kickoff per pass and leaves the rest DUE, not skipped", async () => {
    writeRoutine("c1", "claude");
    writeRoutine("c2", "claude");
    writeRoutine("c3", "claude");
    const events: { kind: string; detail?: string }[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      log: (e) => events.push({ kind: e.kind, detail: e.detail }),
    });

    // Fair order is oldest-lastFire-first; none have fired, so it falls back to
    // id order. c1 starts; c2 and c3 are held by the 60s gap.
    expect(results.map((r) => r.id)).toEqual(["c1"]);

    // ONE summary line for the whole pass, not one per deferred routine.
    const defers = events.filter((e) => e.kind === "defer-stagger");
    expect(defers.length).toBe(1);
    expect(defers[0]?.detail).toContain("2 due");
    expect(defers[0]?.detail).toContain("c2");

    // The point of a stagger over a cap: the deferred runs are not lost. They
    // never recorded a lastFire, so the next tick still sees them as due.
    expect(readState("c1").lastFire).toBeTruthy();
    expect(readState("c2").lastFire).toBeFalsy();
    expect(readState("c3").lastFire).toBeFalsy();
  });
});

describe("normalizeStaggerMs / formatStagger", () => {
  test("unset falls back to ROUTINES_STAGGER_MS, then to the 60s default", () => {
    delete process.env.ROUTINES_STAGGER_MS;
    expect(normalizeStaggerMs(undefined)).toBe(DEFAULT_STAGGER_MS);
    expect(DEFAULT_STAGGER_MS).toBe(60_000);

    process.env.ROUTINES_STAGGER_MS = "5000";
    expect(normalizeStaggerMs(undefined)).toBe(5_000);
    process.env.ROUTINES_STAGGER_MS = "0";
    expect(normalizeStaggerMs(undefined)).toBe(0);
    delete process.env.ROUTINES_STAGGER_MS;
  });

  test("explicit 0 disables; junk falls back to the default", () => {
    expect(normalizeStaggerMs(0)).toBe(0);
    expect(normalizeStaggerMs(1_500)).toBe(1_500);
    expect(normalizeStaggerMs(-1)).toBe(DEFAULT_STAGGER_MS);
    expect(normalizeStaggerMs(NaN)).toBe(DEFAULT_STAGGER_MS);
    expect(formatStagger(0)).toBe("off");
    expect(formatStagger(60_000)).toBe("60000ms");
  });
});

describe("daemon free-slot pool", () => {
  test("kickoffs are spaced by the stagger, and runs still overlap (no cap)", async () => {
    // Harness sleeps ~600ms while the stagger is 100ms, so a later kickoff is
    // expected to land while an earlier run is still going. That margin is what
    // makes the overlap assertion robust on a loaded machine. HOURLY rrule so a
    // completed routine is not immediately due again.
    const slow = stub(
      join(home, "slow-harness"),
      "#!/bin/sh\nsleep 0.6\necho SLOW-OK\nexit 0\n",
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
    const staggerMs = 100;
    const handle = startDaemon({
      tickMs: 30,
      staggerMs,
      catchupMs: 3_600_000, // one hourly occurrence due
      log: (e) => events.push({ t: Date.now() - t0, kind: e.kind, id: e.id }),
    });

    // Generous: this asserts ordering, not speed, and CI hosts are often busy.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const doneIds = new Set(events.filter((e) => e.kind === "complete").map((e) => e.id));
      if (doneIds.size >= 3) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    handle.stop();
    await handle.done;

    const dispatches = events.filter((e) => e.kind === "dispatch").map((e) => e.id);
    const completes = events.filter((e) => e.kind === "complete").map((e) => e.id);
    expect(new Set(dispatches)).toEqual(new Set(["fs-a", "fs-b", "fs-c"]));
    expect(new Set(completes)).toEqual(new Set(["fs-a", "fs-b", "fs-c"]));

    // NOTE: "the rest were deferred, not dropped" is asserted by the
    // seeded-clock test below, not here. `staggerAllows` compares real
    // instants, so on a host slow enough to spend more than `staggerMs`
    // inside one tryDispatch, every kickoff is already spaced and
    // `defer-stagger` is never emitted. Asserting it here made a loaded host
    // red the whole ci-required gate (2026-08-29).

    // Every kickoff is separated by at least the stagger. Timer slop can only
    // make a gap longer, never shorter, so this is the whole contract: no two
    // routines ever start in the same instant.
    const kickoffs = events.filter((e) => e.kind === "dispatch").map((e) => e.t);
    expect(kickoffs.length).toBe(3);
    for (let i = 1; i < kickoffs.length; i++) {
      expect(kickoffs[i]! - kickoffs[i - 1]!).toBeGreaterThanOrEqual(staggerMs);
    }

    // Spacing kickoffs must NOT serialize the fleet. With a 600ms harness and a
    // 100ms gap, later kickoffs land while an earlier run is still in flight —
    // this is the regression guard for the removed concurrency cap.
    const timeline = events.filter((e) => e.kind === "dispatch" || e.kind === "complete");
    const firstCompleteIdx = timeline.findIndex((e) => e.kind === "complete");
    expect(firstCompleteIdx).toBeGreaterThanOrEqual(0);
    const dispatchesBeforeFirstComplete = timeline
      .slice(0, firstCompleteIdx)
      .filter((e) => e.kind === "dispatch").length;
    expect(dispatchesBeforeFirstComplete).toBeGreaterThanOrEqual(2);
  });

  test("a routine held by the stagger is deferred, not dropped", async () => {
    // Seed the kickoff clock instead of racing it. The gap is 60s and the
    // seeded kickoff is "just now", so no amount of host slowness can let a
    // routine through this pass — the deferral is the only possible outcome.
    for (const id of ["dz-a", "dz-b", "dz-c"]) {
      writeFileSync(
        join(home, "registry", `${id}.toml`),
        [
          'harness = "claude"',
          'model = "test-model"',
          'rrule = "FREQ=HOURLY"',
          `prompt = "hello from ${id}"`,
        ].join("\n") + "\n",
      );
    }

    const staggerMs = 60_000;
    const lastDispatch = { at: Date.now() };
    const held: DaemonEvent[] = [];
    const startedWhileHeld = dispatchDue({
      staggerMs,
      catchupMs: 3_600_000,
      lastDispatch,
      log: (e) => held.push(e),
    });
    await Promise.all(startedWhileHeld);

    expect(startedWhileHeld.length).toBe(0);
    expect(held.some((e) => e.kind === "dispatch")).toBe(false);
    const deferral = held.find((e) => e.kind === "defer-stagger");
    expect(deferral).toBeDefined();
    // One line for the whole backlog, naming how many were held.
    expect(held.filter((e) => e.kind === "defer-stagger").length).toBe(1);
    expect(deferral!.detail).toContain("3 due");

    // Deferred, not dropped: the same routines are still due, so the next pass
    // admits one as soon as the gap has elapsed.
    lastDispatch.at = Date.now() - staggerMs;
    const released: DaemonEvent[] = [];
    const startedAfterGap = dispatchDue({
      staggerMs,
      catchupMs: 3_600_000,
      lastDispatch,
      log: (e) => released.push(e),
    });
    await Promise.all(startedAfterGap);

    expect(startedAfterGap.length).toBe(1);
    const dispatched = released.filter((e) => e.kind === "dispatch").map((e) => e.id);
    expect(dispatched.length).toBe(1);
    expect(["dz-a", "dz-b", "dz-c"]).toContain(dispatched[0]!);
  });
});
