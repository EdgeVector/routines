import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = new URL("../scripts/lastdb-local-smoke-gate.sh", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function fixture(status: "ok" | "need_build", smokeExit = 0, brainBody?: string) {
  const root = mkdtempSync(join(tmpdir(), "routines-lastdb-smoke-gate-"));
  roots.push(root);
  const runDir = join(root, "run");
  const fakeBin = executable(join(root, "lastdbd"), "exit 0");
  const timeout = executable(join(root, "timeout"), 'shift 3\nexec "$@"');
  const resolverPayload =
    status === "ok"
      ? {
          status: "ok",
          lastdbd: fakeBin,
          wanted_oid: "wanted123",
          resolved_oid: "resolved456",
          source: "test-stage",
          sha_drift: true,
        }
      : { status: "need_build", wanted_oid: "wanted123" };
  const resolver = executable(
    join(root, "resolver"),
    `printf '%s\\n' '${JSON.stringify(resolverPayload)}'`,
  );
  const smoke = executable(
    join(root, "smoke"),
    smokeExit === 0
      ? `[ "$BIN" = "${fakeBin}" ]\n[ "$LASTDB_TEST_TUNING" = "yes" ]\nprintf '%s\\n' 'VERDICT: GREEN' 'SUMMARY: fixture green'`
      : `printf '%s\\n' 'VERDICT: RED' 'REASON: fixture failed'\nexit ${smokeExit}`,
  );
  const envFile = join(root, "lastdb-env");
  writeFileSync(envFile, "LASTDB_TEST_TUNING=yes\nLASTDB_HOME=/must/not/pass\n");
  const heartbeat = executable(
    join(root, "heartbeat"),
    `printf '%s\\n' "$*" >> '${join(root, "heartbeat.log")}'`,
  );
  const brain = executable(
    join(root, "brain"),
    brainBody ??
      `if [ "$1" = put ]; then cat > '${join(root, "brain-put.md")}'; exit 0; fi\n[ "$1" = get ] && exit 0\nexit 1`,
  );
  return { root, runDir, timeout, resolver, smoke, envFile, heartbeat, brain };
}

function run(f: ReturnType<typeof fixture>) {
  return Bun.spawnSync(["bash", scriptPath], {
    env: {
      ...process.env,
      ROUTINES_RUN_DIR: f.runDir,
      ROUTINES_RUN_ID: "test-run",
      LASTDB_LOCAL_SMOKE_TIMEOUT_BIN: f.timeout,
      LASTDB_LOCAL_SMOKE_RESOLVER: f.resolver,
      LASTDB_LOCAL_SMOKE_SCRIPT: f.smoke,
      LASTDB_LOCAL_SMOKE_ENV_FILE: f.envFile,
      LASTDB_LOCAL_SMOKE_HEARTBEAT_BIN: f.heartbeat,
      LASTDB_LOCAL_SMOKE_BRAIN_BIN: f.brain,
      LASTDB_LOCAL_SMOKE_CLOSEOUT_RETRY_SLEEP_SEC: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("lastdb local smoke gate", () => {
  test("runs a staged binary, writes durable proof, and skips the LLM on GREEN", () => {
    const f = fixture("ok");
    const result = run(f);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("ROUTINE_RESULT outcome=ok detail=verdict=GREEN");
    expect(readFileSync(join(f.runDir, "outcome.txt"), "utf8")).toMatch(/^ok verdict=GREEN/);
    expect(readFileSync(join(f.runDir, "lastdb-local-smoke.log"), "utf8")).toContain("VERDICT: GREEN");
    expect(readFileSync(join(f.root, "brain-put.md"), "utf8")).toContain("LastDB local real-data smoke GREEN");
    expect(readFileSync(join(f.root, "heartbeat.log"), "utf8")).toContain("lastdb-local-smoke-test");
  });

  test("keeps a GREEN verdict ok when the closeout report write never succeeds", () => {
    const f = fixture("ok", 0, "exit 1");
    const result = run(f);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("ROUTINE_RESULT outcome=ok detail=verdict=GREEN");
    expect(stdout).toContain("closeout_report=write-failed");
    expect(stdout).not.toContain("closeout-write-failed");
    expect(readFileSync(join(f.runDir, "outcome.txt"), "utf8")).toMatch(
      /^ok verdict=GREEN .*closeout_report=write-failed/,
    );
    // The failure stays visible even though it no longer decides the outcome.
    expect(result.stderr.toString()).toContain("closeout-report write attempt 3/3 failed");
  });

  test("retries a transiently busy primary brain before giving up on the report", () => {
    const root = mkdtempSync(join(tmpdir(), "routines-lastdb-smoke-brain-"));
    roots.push(root);
    const counter = join(root, "attempts");
    const f = fixture(
      "ok",
      0,
      `if [ "$1" = put ]; then\n` +
        `  printf 'x' >> '${counter}'\n` +
        `  cat > /dev/null\n` +
        `  [ "$(wc -c < '${counter}' | tr -d ' ')" -ge 2 ] || exit 1\n` +
        `  exit 0\n` +
        `fi\n` +
        `[ "$1" = get ] && exit 0\nexit 1`,
    );
    const result = run(f);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("ROUTINE_RESULT outcome=ok detail=verdict=GREEN");
    expect(result.stdout.toString()).not.toContain("closeout_report=write-failed");
    expect(readFileSync(counter, "utf8").length).toBe(2);
  });

  test("classifies a missing staged candidate as a build-free noop", () => {
    const f = fixture("need_build");
    const result = run(f);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("outcome=noop detail=reason=no-staged-lastdbd");
    expect(readFileSync(join(f.runDir, "outcome.txt"), "utf8")).toMatch(/^noop reason=no-staged-lastdbd/);
  });

  test("returns a bounded error when the smoke command times out", () => {
    const f = fixture("ok");
    executable(
      f.timeout,
      `shift 3\ncase "$1" in\n  *resolver) exec "$@" ;;\n  *) exit 124 ;;\nesac`,
    );
    const result = run(f);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("outcome=error detail=reason=smoke-timeout");
    expect(readFileSync(join(f.runDir, "outcome.txt"), "utf8")).toMatch(/^error reason=smoke-timeout/);
  });
});
