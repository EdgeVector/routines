/**
 * Fixture tests for scripts/llms-txt-install-smoke-gate.sh.
 *
 * The gate exists because the smoke's measured GREEN is 1086s and the claude
 * harness caps a foreground call at 600s, so the 2026-08-29 response shrank
 * the smoke's budget to 540s and would have made it print a false RED nightly
 * (papercut-llms-txt-smoke-budget-half-the-measured-work-emits-false-red).
 * The budget guard below is the anti-regression for exactly that.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = new URL("../scripts/llms-txt-install-smoke-gate.sh", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

type RunnerKind = "green" | "red" | "no-verdict";

function fixture(kind: RunnerKind, opts: { brainFails?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "routines-llms-txt-gate-"));
  roots.push(root);
  const runDir = join(root, "run");
  // Stub `timeout`: drop `-k 30s <bound>s` and exec the rest, so the fixture
  // runner is what actually runs.
  const timeout = executable(join(root, "timeout"), 'shift 3\nexec "$@"');
  // The runner records the budget env it was handed, so a test can assert the
  // gate raises it rather than letting run.sh keep its 540s LLM-path default.
  const budgetLog = join(root, "budget.txt");
  const emit =
    kind === "green"
      ? `printf '%s\\n' 'PASS (27)' 'FAIL (0): none' 'VERDICT: GREEN' 'RESULT: ok GREEN PASS (27)'`
      : kind === "red"
        ? `printf '%s\\n' 'PASS (20)' 'FAIL (7): install-apps' 'VERDICT: RED' 'RESULT: error RED FAIL (7): install-apps exit=1'\nexit 1`
        : `printf '%s\\n' 'RESULT: error RED incomplete-no-verdict exit=143'\nexit 2`;
  const runner = executable(
    join(root, "routine-run.sh"),
    `printf '%s %s\\n' "$SMOKE_TOTAL_BUDGET_SECS" "$SMOKE_WRAPPER_TIMEOUT_SECS" > '${budgetLog}'\n${emit}`,
  );
  const heartbeat = executable(
    join(root, "heartbeat"),
    `printf '%s\\n' "$*" >> '${join(root, "heartbeat.log")}'`,
  );
  const brain = executable(
    join(root, "brain"),
    opts.brainFails
      ? `exit 1`
      : `if [ "$1" = put ]; then cat > '${join(root, "brain-put.md")}'; exit 0; fi\n[ "$1" = get ] && exit 0\nexit 1`,
  );
  return { root, runDir, timeout, runner, heartbeat, brain, budgetLog };
}

function run(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bash", scriptPath], {
    env: {
      ...process.env,
      ROUTINES_RUN_DIR: f.runDir,
      ROUTINES_RUN_ID: "test-run",
      LLMS_TXT_SMOKE_TIMEOUT_BIN: f.timeout,
      LLMS_TXT_SMOKE_RUNNER: f.runner,
      LLMS_TXT_SMOKE_HEARTBEAT_BIN: f.heartbeat,
      LLMS_TXT_SMOKE_BRAIN_BIN: f.brain,
      LLMS_TXT_SMOKE_CLOSEOUT_RETRY_SLEEP_SEC: "0",
      ...extra,
    },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("llms-txt-install-smoke gate", () => {
  test("GREEN is outcome=ok and exits 0", () => {
    const f = fixture("green");
    const r = run(f);
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=ok");
    expect(r.stdout).toContain("verdict=GREEN");
    expect(r.code).toBe(0);
    expect(readFileSync(join(f.runDir, "outcome.txt"), "utf8")).toContain("ok verdict=GREEN");
  });

  test("raises the smoke budget above the 540s LLM-path default", () => {
    const f = fixture("green");
    run(f);
    // 2400/2460 — the gate has no harness foreground cap to fit under.
    expect(readFileSync(f.budgetLog, "utf8").trim()).toBe("2400 2460");
  });

  test("a budget at or under the measured GREEN refuses to start", () => {
    // This is the 2026-08-29 defect: a 540s budget against 1086s of work.
    const f = fixture("green");
    const r = run(f, { LLMS_TXT_SMOKE_BUDGET_SEC: "540" });
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=noop");
    expect(r.stdout).toContain("reason=budget-under-measured-work");
    expect(r.stdout).toContain("no_probe_started");
    expect(r.code).toBe(0);
    // The runner must never have been invoked.
    expect(() => readFileSync(f.budgetLog, "utf8")).toThrow();
  });

  test("an inverted budget ladder is an error, not a verdict", () => {
    const f = fixture("green");
    const r = run(f, {
      LLMS_TXT_SMOKE_BUDGET_SEC: "2400",
      LLMS_TXT_SMOKE_WRAPPER_BOUND_SEC: "2000",
    });
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=error");
    expect(r.stdout).toContain("reason=budget-ladder-inverted");
    expect(r.code).toBe(1);
  });

  test("a real RED verdict is outcome=error and exits 1", () => {
    const f = fixture("red");
    const r = run(f);
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=error");
    expect(r.stdout).toContain("verdict=RED");
    expect(r.code).toBe(1);
  });

  test("no VERDICT is reported as incomplete, never as a product RED", () => {
    const f = fixture("no-verdict");
    const r = run(f);
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=error");
    expect(r.stdout).toContain("reason=incomplete-no-verdict");
    // Nothing was measured, so no product verdict may be claimed.
    expect(r.stdout).not.toContain("verdict=RED");
    expect(r.code).toBe(1);
  });

  test("a failed closeout write does not veto a GREEN verdict", () => {
    // papercut-lastdb-smoke-gate-closeout-write-failure-overrides-green-verdict
    const f = fixture("green", { brainFails: true });
    const r = run(f);
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=ok");
    expect(r.stdout).toContain("closeout_report=write-failed");
    expect(r.code).toBe(0);
  });

  test("a missing runner is an error, not a silent pass", () => {
    const f = fixture("green");
    const r = run(f, { LLMS_TXT_SMOKE_RUNNER: join(f.root, "absent.sh") });
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=error");
    expect(r.stdout).toContain("reason=runner-missing");
    expect(r.code).toBe(1);
  });

  test("no command timebox is a classified noop, not a run", () => {
    const f = fixture("green");
    const r = run(f, { LLMS_TXT_SMOKE_TIMEOUT_BIN: join(f.root, "absent-timeout") });
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=noop");
    expect(r.stdout).toContain("reason=no-command-timebox");
    expect(r.code).toBe(0);
  });
});
