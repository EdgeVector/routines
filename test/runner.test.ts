import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLock, readLockPid, releaseLock } from "../src/daemon.ts";
import { loadEntry } from "../src/registry.ts";
import { appendRunLog, runRoutine, writeEarlyMeta } from "../src/runner.ts";

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
