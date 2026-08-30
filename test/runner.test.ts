import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLock, readLockPid, releaseLock } from "../src/daemon.ts";
import { loadEntry } from "../src/registry.ts";
import { appendRunLog, completedExitCode, runRoutine, writeEarlyMeta } from "../src/runner.ts";

let home: string;
let outageSituationLog: string;
let outageRaLog: string;

const savedEnv = { ...process.env };

function stub(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  process.env = { ...savedEnv };
  home = mkdtempSync(join(tmpdir(), "routines-runner-"));
  process.env.ROUTINES_HOME = home;
  process.env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES = "1";
  process.env.ROUTINES_SIGKILL_GRACE_MS = "50";
  mkdirSync(join(home, "registry"), { recursive: true });

  const fbrainOut = join(home, "heartbeats.log");
  process.env.ROUTINES_FBRAIN_BIN = stub(
    join(home, "stub-fbrain"),
    `#!/bin/sh
test "$1" = append || exit 11
test "$2" = routine-heartbeats || exit 12
test "$3" = --type || exit 13
test "$4" = reference || exit 14
cat >> ${fbrainOut}
exit 0
`,
  );

  outageSituationLog = join(home, "situations-calls.log");
  process.env.ROUTINES_SITUATIONS_CLI = stub(
    join(home, "stub-situations"),
    `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(outageSituationLog)}
cat >/dev/null
exit 0
`,
  );
  outageRaLog = join(home, "ra-calls.log");
  process.env.ROUTINES_RA_BIN = stub(
    join(home, "stub-ra"),
    `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(outageRaLog)}
exit 0
`,
  );
});

function writeRoutine(id: string): void {
  writeFileSync(
    join(home, "registry", `${id}.toml`),
    [
      'harness = "claude"',
      'model = "test-model"',
      'rrule = "FREQ=SECONDLY"',
      'prompt = "hello"',
      'heartbeat_slug = "routine-heartbeats"',
      "timeout_min = 0.05",
    ].join("\n") + "\n",
  );
}

describe("runRoutine heartbeat handling", () => {
  test("run metadata records matrix versus pin resolution", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(join(home, "meta-claude"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_CODEX_BIN = stub(join(home, "meta-codex"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_GROK_BIN = stub(join(home, "meta-grok"), "#!/bin/sh\nexit 0\n");
    const matrixPath = join(home, "routing-matrix.json");
    writeFileSync(matrixPath, JSON.stringify({
      version: 3,
      providerOrder: ["codex", "grok", "claude"],
      matrix: {
        fast: { codex: { model: "c-fast" }, grok: { model: "g-fast" }, claude: { model: "a-fast" } },
        normal: { codex: { model: "c-normal" }, grok: { model: "g-normal" }, claude: { model: "a-normal" } },
        hard: { codex: { model: "c-hard" }, grok: { model: "g-hard" }, claude: { model: "a-hard" } },
      },
    }));
    process.env.ROUTINES_ROUTING_MATRIX_PATH = matrixPath;
    writeFileSync(
      join(home, "registry", "matrix-run.toml"),
      'difficulty = "fast"\nrrule = "FREQ=DAILY"\nprompt = "hi"\n',
    );
    const pinnedRoutes = [["smoke-claude", "claude"], ["smoke-codex", "codex"], ["smoke-grok", "grok"]] as const;
    for (const [id, harness] of pinnedRoutes) {
      writeFileSync(
        join(home, "registry", `${id}.toml`),
        `pin = true\nharness = "${harness}"\nmodel = "pinned-${harness}"\nrrule = "FREQ=DAILY"\nprompt = "hi"\n`,
      );
    }

    const matrixResult = await runRoutine(loadEntry("matrix-run"), {
      quiet: true,
      noFallback: true,
      trigger: "manual",
    });
    const matrixMeta = JSON.parse(readFileSync(join(matrixResult.runDir, "meta.json"), "utf8"));
    expect(matrixMeta.resolvedBy).toBe("matrix");
    expect(matrixMeta.matrixResolution).toEqual({
      version: 3,
      difficulty: "fast",
      harness: "codex",
      model: "c-fast",
    });
    for (const [id, harness] of pinnedRoutes) {
      const result = await runRoutine(loadEntry(id), { quiet: true, noFallback: true, trigger: "manual" });
      const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
      expect(meta.resolvedBy).toBe("pin");
      expect(meta.harness).toBe(harness);
      expect(meta.matrixResolution).toBeNull();
    }
  });

  test("explicit ok heartbeat completes a run", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "ok-harness"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'brain-stress-consistency 2026-07-14T20:43:29Z ok GREEN findings=0'",
        "",
      ].join("\n"),
    );
    writeRoutine("brain-stress-consistency");

    const result = await runRoutine(loadEntry("brain-stress-consistency"), { quiet: true });

    expect(result.timedOut).toBe(false);
    expect(result.outcome.kind).toBe("ok");
    expect(result.outcome.source).toBe("heartbeat");
    expect(result.exitCode).toBe(0);

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.exitCode).toBe(0);
    expect(meta.timedOut).toBe(false);
    expect(meta.outcome).toBe("ok");
    expect(meta.harnessPid).toBeTruthy();
  });

  test("finalize clears the owned single-flight lock", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "lock-clean-harness"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'lock-clean 2026-07-19T22:50:00Z ok lock-cleared'",
        "",
      ].join("\n"),
    );
    writeRoutine("lock-clean");
    expect(acquireLock("lock-clean")).toBe(true);

    const result = await runRoutine(loadEntry("lock-clean"), { quiet: true });

    expect(result.outcome.kind).toBe("ok");
    expect(readLockPid("lock-clean")).toBeNull();
  });

  test("post-success harness transient keeps durable ok exit", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "post-success-capacity-harness"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'last-stack-pipeline-health 2026-07-17T23:17:13Z ok open_cr=unknown deploy_blocked=already-carded'",
        "printf '%s\\n' 'ERROR: Selected model is at capacity. Please try a different model.' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    writeRoutine("last-stack-pipeline-health");

    const result = await runRoutine(loadEntry("last-stack-pipeline-health"), {
      quiet: true,
      noFallback: true,
    });

    expect(result.timedOut).toBe(false);
    expect(result.outcome.kind).toBe("ok");
    expect(result.outcome.source).toBe("heartbeat");
    expect(result.exitCode).toBe(0);

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.exitCode).toBe(0);
    expect(meta.outcome).toBe("ok");
    expect(meta.heartbeat.line).toContain("last-stack-pipeline-health ok");
    expect(meta.heartbeat.line).toContain("exit=0");
  });

  test("Codex capacity before claim records clean noop exit", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "capacity-harness"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'ERROR: Selected model is at capacity. Please try a different model.' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    writeRoutine("last-stack-fkanban-pickup-w3");

    // Isolate outcome classification from the same-run fallback chain.
    const result = await runRoutine(loadEntry("last-stack-fkanban-pickup-w3"), {
      quiet: true,
      noFallback: true,
    });

    expect(result.timedOut).toBe(false);
    expect(result.outcome.kind).toBe("noop");
    expect(result.outcome.source).toBe("safe_skip");
    expect(result.exitCode).toBe(0);

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.exitCode).toBe(0);
    expect(meta.outcome).toBe("noop");
    expect(meta.outcomeDetail).toBe("codex-capacity no_card_claimed");
    expect(readFileSync(outageSituationLog, "utf8")).toContain("put");
    expect(readFileSync(outageRaLog, "utf8")).toContain("notify");
  });

  test("non-outage failures do not touch harness-outage side-effect tools", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "regular-failure-harness"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'TypeError: undefined is not a function' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    process.env.ROUTINES_ERROR_ESCALATE = "0";
    writeRoutine("regular-failure");

    const result = await runRoutine(loadEntry("regular-failure"), {
      quiet: true,
      noFallback: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.outcome.kind).toBe("error");
    const situationCalls = existsSync(outageSituationLog)
      ? readFileSync(outageSituationLog, "utf8")
      : "";
    expect(situationCalls).not.toContain("put");
    expect(existsSync(outageRaLog)).toBe(false);
  });

  test("streams stdout to run-dir before finalize and records harness pid on the lock", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "slow-harness"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'chunk-one-live'",
        "sleep 0.35",
        "printf '%s\\n' 'chunk-two-done'",
        "printf '%s\\n' 'brain-stream-live 2026-07-16T00:00:00Z ok GREEN findings=0'",
        "",
      ].join("\n"),
    );
    writeRoutine("brain-stream-live");
    // timeout long enough for sleep; acquire lock like the daemon does
    writeFileSync(
      join(home, "registry", "brain-stream-live.toml"),
      [
        'harness = "claude"',
        'model = "test-model"',
        'rrule = "FREQ=SECONDLY"',
        'prompt = "hello"',
        'heartbeat_slug = "routine-heartbeats"',
        "timeout_min = 1",
      ].join("\n") + "\n",
    );

    expect(acquireLock("brain-stream-live")).toBe(true);
    const runP = runRoutine(loadEntry("brain-stream-live"), { quiet: true });

    // Poll until the first chunk is on disk (proves streaming, not finalize-only).
    let sawLive = false;
    for (let i = 0; i < 40; i++) {
      const lockPid = readLockPid("brain-stream-live");
      // After spawn the lock must name a live pid (harness), not only existence.
      if (lockPid != null && lockPid !== process.pid) {
        // harness child pid differs from this test process
      }
      // Find newest run dir
      try {
        const runsRoot = join(home, "runs", "brain-stream-live");
        const stamps = (await import("node:fs")).readdirSync(runsRoot);
        for (const s of stamps) {
          const log = join(runsRoot, s, "stdout.log");
          const meta = join(runsRoot, s, "meta.json");
          if ((await import("node:fs")).existsSync(log)) {
            const body = readFileSync(log, "utf8");
            if (body.includes("chunk-one-live")) {
              sawLive = true;
              const m = JSON.parse(readFileSync(meta, "utf8"));
              expect(m.status === "running" || m.harnessPid != null).toBe(true);
              expect(typeof m.harnessPid === "number" || m.harnessPid === null).toBe(true);
              if (typeof m.harnessPid === "number") {
                expect(readLockPid("brain-stream-live")).toBe(m.harnessPid);
              }
            }
          }
        }
      } catch {
        /* run dir not yet created */
      }
      if (sawLive) break;
      await Bun.sleep(50);
    }
    expect(sawLive).toBe(true);

    const result = await runP;
    releaseLock("brain-stream-live");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(result.runDir, "stdout.log"), "utf8")).toContain("chunk-one-live");
    expect(result.harnessPid).toBeTruthy();
  });

  test("writeEarlyMeta and appendRunLog are the shipped mid-flight surfaces", () => {
    const runDir = join(home, "manual-run");
    mkdirSync(runDir, { recursive: true });
    writeEarlyMeta({
      runDir,
      id: "x",
      trigger: "manual",
      harness: "claude",
      model: "m",
      effort: null,
      cwd: "/tmp",
      command: "echo",
      startedAt: new Date().toISOString(),
      harnessPid: 4242,
    });
    appendRunLog(runDir, "stdout.log", "hello-live\n");
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.harnessPid).toBe(4242);
    expect(meta.id).toBe("x");
    expect(meta.trigger).toBe("manual");
    expect(meta.status).toBe("running");
    expect(readFileSync(join(runDir, "stdout.log"), "utf8")).toBe("hello-live\n");
  });

  test("completedExitCode remaps a sink ok after SIGTERM or timeout", () => {
    expect(
      completedExitCode(124, true, { kind: "ok", detail: "merged", source: "sink" }),
    ).toBe(0);
    expect(
      completedExitCode(null, false, { kind: "ok", detail: "merged", source: "sink" }),
    ).toBe(0);
    expect(
      completedExitCode(1, false, { kind: "error", detail: "boom", source: "sink" }),
    ).toBe(1);
  });

  test("stops the harness when outcome.txt is written instead of waiting out the budget", async () => {
    process.env.ROUTINES_SINK_STOP_GRACE_MS = "50";
    process.env.ROUTINES_SIGKILL_GRACE_MS = "50";
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "linger-after-sink"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'ok worked=demo result=merged' > \"$ROUTINES_RUN_DIR/outcome.txt\"",
        "printf '%s\\n' 'ROUTINE_RESULT outcome=ok detail=worked=demo'",
        "sleep 30",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, "registry", "linger-after-sink.toml"),
      [
        'harness = "claude"',
        'model = "test-model"',
        'rrule = "FREQ=SECONDLY"',
        'prompt = "hello"',
        'heartbeat_slug = "routine-heartbeats"',
        "timeout_min = 1",
      ].join("\n") + "\n",
    );

    const started = Date.now();
    const result = await runRoutine(loadEntry("linger-after-sink"), {
      quiet: true,
      noFallback: true,
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(8_000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.outcome.kind).toBe("ok");
    expect(result.outcome.source).toBe("sink");
  });

  test("appendRunLog is best-effort when the log path cannot be written", () => {
    const notDir = join(home, "not-a-directory");
    writeFileSync(notDir, "x");

    expect(appendRunLog(notDir, "stdout.log", "hello\n")).toBe(false);
  });

  test("caps final run logs and preserves the outcome tail", async () => {
    process.env.ROUTINES_RUN_LOG_MAX_BYTES = "8192";
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "large-output-harness"),
      [
        "#!/bin/sh",
        "i=0",
        "while [ \"$i\" -lt 500 ]; do",
        "  printf 'line-%04d abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz\\n' \"$i\"",
        "  i=$((i + 1))",
        "done",
        "printf '%s\\n' 'large-output 2026-07-19T00:00:00Z ok GREEN findings=0'",
        "",
      ].join("\n"),
    );
    writeRoutine("large-output");

    const result = await runRoutine(loadEntry("large-output"), { quiet: true, noFallback: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcome.kind).toBe("ok");
    const stdout = readFileSync(join(result.runDir, "stdout.log"), "utf8");
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(8192);
    expect(stdout).toContain("large-output 2026-07-19T00:00:00Z ok GREEN findings=0");
    expect(stdout).not.toContain("line-0000");
    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.logMaxBytes).toBe(8192);
  });
});

describe("runRoutine gate_command", () => {
  test("exit 0 skips harness entirely", async () => {
    const harnessLog = join(home, "harness-should-not-run.log");
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "should-not-run-harness"),
      [
        "#!/bin/sh",
        `printf 'ran\\n' >> ${JSON.stringify(harnessLog)}`,
        "printf '%s\\n' 'should-not-run 2026-08-04T00:00:00Z ok leaked'",
        "exit 0",
        "",
      ].join("\n"),
    );
    const gate = stub(
      join(home, "skip-gate"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'kanban-pickup 2026-08-04T00:00:00Z noop no-eligible ready=0 no_card_claimed'",
        "printf '%s\\n' 'ROUTINE_RESULT outcome=noop detail=no-eligible ready=0 no_card_claimed'",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, "registry", "gate-skip.toml"),
      [
        'harness = "claude"',
        'model = "test-model"',
        'rrule = "FREQ=SECONDLY"',
        'prompt = "should not matter"',
        'heartbeat_slug = "routine-heartbeats"',
        "timeout_min = 1",
        `gate_command = ${JSON.stringify(gate)}`,
      ].join("\n") + "\n",
    );

    const result = await runRoutine(loadEntry("gate-skip"), { quiet: true, noFallback: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcome.kind).toBe("noop");
    expect(result.harnessPid).toBeNull();
    expect(existsSync(harnessLog)).toBe(false);
    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.gateSkippedHarness).toBe(true);
    expect(meta.command).toContain("gate_command");
  });

  test("exit 0 with an error trailer records error, not a gate-skip noop", async () => {
    // Observer gates end `exit 0` on every path, including the ones that print
    // ROUTINE_RESULT outcome=error, so the trailer is the only channel a gate
    // failure has. It used to be rewritten to noop/"gate-skip no_card_claimed".
    // papercut-routines-gate-exit0-error-trailer-recorded-as-noop
    const harnessLog = join(home, "error-gate-harness-should-not-run.log");
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "error-gate-should-not-run-harness"),
      [
        "#!/bin/sh",
        `printf 'ran\\n' >> ${JSON.stringify(harnessLog)}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    const gate = stub(
      join(home, "error-trailer-gate"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'error'",
        "printf '%s\\n' 'ROUTINE_RESULT outcome=error detail=classes=D+F loom=unavailable rc=3'",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, "registry", "gate-error-trailer.toml"),
      [
        'harness = "claude"',
        'model = "test-model"',
        'rrule = "FREQ=SECONDLY"',
        'prompt = "should not matter"',
        'heartbeat_slug = "routine-heartbeats"',
        "timeout_min = 1",
        `gate_command = ${JSON.stringify(gate)}`,
      ].join("\n") + "\n",
    );

    const result = await runRoutine(loadEntry("gate-error-trailer"), {
      quiet: true,
      noFallback: true,
    });

    expect(result.outcome.kind).toBe("error");
    expect(result.outcome.detail).toContain("loom=unavailable rc=3");
    expect(result.outcome.source).not.toBe("safe_skip");
    expect(existsSync(harnessLog)).toBe(false);
    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.outcome).toBe("error");
    expect(meta.outcomeDetail).not.toBe("gate-skip no_card_claimed");
  });

  test("exit 10 proceeds to harness", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "after-gate-harness"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'after-gate 2026-08-04T00:00:00Z ok worked'",
        "printf '%s\\n' 'ROUTINE_RESULT outcome=ok detail=worked'",
        "exit 0",
        "",
      ].join("\n"),
    );
    const gate = stub(
      join(home, "proceed-gate"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'PICKUP_GATE proceed ready=2'",
        "exit 10",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, "registry", "gate-proceed.toml"),
      [
        'harness = "claude"',
        'model = "test-model"',
        'rrule = "FREQ=SECONDLY"',
        'prompt = "hello"',
        'heartbeat_slug = "routine-heartbeats"',
        "timeout_min = 1",
        `gate_command = ${JSON.stringify(gate)}`,
      ].join("\n") + "\n",
    );

    const result = await runRoutine(loadEntry("gate-proceed"), { quiet: true, noFallback: true });

    expect(result.exitCode).toBe(0);
    expect(result.outcome.kind).toBe("ok");
    expect(result.harnessPid).toBeTruthy();
    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.gateSkippedHarness).not.toBe(true);
    expect(meta.gateProceeded).toBe(true);
    expect(meta.gateCommand).toBe(gate);
  });

  test("hung gate skips harness and records an error, not a benign noop", async () => {
    process.env.ROUTINES_GATE_TIMEOUT_MS = "400";
    const harnessLog = join(home, "hung-gate-harness.log");
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "hung-must-not-run"),
      [
        "#!/bin/sh",
        `printf 'ran\\n' >> ${JSON.stringify(harnessLog)}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    const gate = stub(
      join(home, "hung-gate"),
      ["#!/bin/sh", "sleep 5", "exit 10", ""].join("\n"),
    );
    writeFileSync(
      join(home, "registry", "gate-hung.toml"),
      [
        'harness = "claude"',
        'model = "test-model"',
        'rrule = "FREQ=SECONDLY"',
        'prompt = "should not matter"',
        'heartbeat_slug = "routine-heartbeats"',
        "timeout_min = 1",
        `gate_command = ${JSON.stringify(gate)}`,
      ].join("\n") + "\n",
    );

    const result = await runRoutine(loadEntry("gate-hung"), { quiet: true, noFallback: true });

    expect(result.exitCode).toBe(0);
    // A killed gate produced no verdict. Classifying that as a benign noop is
    // what let `lastdb-local-smoke-test` go dark for two days while reporting
    // `lastOutcome=noop` — the same value a healthy idle run reports.
    // `parseOutcome` already classifies a harness timeout this way.
    // papercut-routines-gate-timeout-records-benign-noop-safe-skip
    expect(result.outcome.kind).toBe("error");
    expect(result.outcome.source).toBe("exit");
    // The detail names the budget that fired, so a reader can tell this kill
    // from the gate's own self-classified timeout.
    expect(result.outcome.detail).toBe("gate-timeout budget_s=1");
    expect(result.harnessPid).toBeNull();
    expect(existsSync(harnessLog)).toBe(false);
    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.gateSkippedHarness).toBe(true);
    expect(meta.gateProceeded).not.toBe(true);
    expect(meta.command).toContain("gate_command");
    expect(meta.gateTimeoutMs).toBe(400);
  });

  test("exit 0 with ROUTINE_RESULT ok preserves outcome=ok (real work gate)", async () => {
    const harnessLog = join(home, "harness-must-not-run-ok-gate.log");
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "must-not-run-ok-gate"),
      [
        "#!/bin/sh",
        `printf 'ran\\n' >> ${JSON.stringify(harnessLog)}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    const gate = stub(
      join(home, "ok-work-gate"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'north-star-rollup 2026-08-14T00:00:00Z ok generated=2026-08-14T00:00Z html=/tmp/x.html'",
        "printf '%s\\n' 'ROUTINE_RESULT outcome=ok detail=generated=2026-08-14T00:00Z html=/tmp/x.html'",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, "registry", "last-stack-north-star-rollup.toml"),
      [
        'id = "last-stack-north-star-rollup"',
        'harness = "claude"',
        'model = "test-model"',
        'rrule = "FREQ=SECONDLY"',
        'prompt = "should not matter"',
        'heartbeat_slug = "routine-heartbeats"',
        "timeout_min = 5",
        `gate_command = ${JSON.stringify(gate)}`,
      ].join("\n") + "\n",
    );

    const result = await runRoutine(loadEntry("last-stack-north-star-rollup"), {
      quiet: true,
      noFallback: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.outcome.kind).toBe("ok");
    expect(result.outcome.detail).toContain("generated=");
    expect(result.harnessPid).toBeNull();
    expect(existsSync(harnessLog)).toBe(false);
    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.gateSkippedHarness).toBe(true);
  });
});

describe("child env Sentry locators", () => {
  test("spawned harness does not inherit lastsecrets OBS_SENTRY_DSN", async () => {
    const dump = join(home, "child-env.dump");
    process.env.OBS_SENTRY_DSN = "lastsecrets://obs-sentry-dsn-routines";
    process.env.SENTRY_DSN = "lastsecrets://obs-sentry-dsn-routines";
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "env-dump-harness"),
      [
        "#!/bin/sh",
        `env > ${JSON.stringify(dump)}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    writeRoutine("sentry-locator-child");

    const result = await runRoutine(loadEntry("sentry-locator-child"), {
      quiet: true,
      noFallback: true,
    });
    expect(result.timedOut).toBe(false);
    expect(existsSync(dump)).toBe(true);
    const dumped = readFileSync(dump, "utf8");
    expect(dumped).not.toMatch(/^OBS_SENTRY_DSN=lastsecrets:/m);
    expect(dumped).not.toMatch(/^SENTRY_DSN=lastsecrets:/m);
    expect(dumped).not.toContain("lastsecrets://obs-sentry-dsn-routines");
  });
});

describe("enrichGateEnv", () => {
  test("sets dashboard cmd timeout for north-star-rollup when unset", async () => {
    const { enrichGateEnv } = await import("../src/runner.ts");
    const env = enrichGateEnv(
      {
        id: "last-stack-north-star-rollup",
        harness: "codex",
        model: "x",
        resolvedBy: "pin",
        rrule: "FREQ=HOURLY",
        parsedRrule: { freq: "HOURLY" } as never,
        cwd: "/",
        status: "active",
        timeoutMin: 20,
        sourcePath: "/tmp/x.toml",
      },
      { PATH: "/usr/bin" },
    );
    expect(env.LAST_STACK_NORTH_STAR_DASHBOARD_CMD_TIMEOUT).toBe("120");
  });

  test("does not override an explicit dashboard cmd timeout", async () => {
    const { enrichGateEnv } = await import("../src/runner.ts");
    const env = enrichGateEnv(
      {
        id: "last-stack-north-star-rollup",
        harness: "codex",
        model: "x",
        resolvedBy: "pin",
        rrule: "FREQ=HOURLY",
        parsedRrule: { freq: "HOURLY" } as never,
        cwd: "/",
        status: "active",
        timeoutMin: 20,
        sourcePath: "/tmp/x.toml",
      },
      { LAST_STACK_NORTH_STAR_DASHBOARD_CMD_TIMEOUT: "45" },
    );
    expect(env.LAST_STACK_NORTH_STAR_DASHBOARD_CMD_TIMEOUT).toBe("45");
  });
});
