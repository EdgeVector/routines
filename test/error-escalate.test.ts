import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  escalateRoutineError,
  shouldAutoEscalateScheduledRun,
  shouldEscalate,
} from "../src/error-escalate.ts";
import type { RoutineEntry } from "../src/registry.ts";
import type { RunResult } from "../src/runner.ts";
import { parseRRule } from "../src/rrule.ts";

let home: string;
const prevHome = process.env.ROUTINES_HOME;
const prevEsc = process.env.ROUTINES_ERROR_ESCALATE;

function entry(id = "last-stack-disk-reclaim"): RoutineEntry {
  return {
    id,
    harness: "codex",
    model: "gpt-5.5",
    rrule: "FREQ=HOURLY",
    parsedRrule: parseRRule("FREQ=HOURLY"),
    cwd: home,
    status: "active",
    timeoutMin: 30,
    sourcePath: join(home, "registry", `${id}.toml`),
  };
}

function result(partial: Partial<RunResult> & { id?: string } = {}): RunResult {
  const runDir = join(home, "runs", partial.id ?? "last-stack-disk-reclaim", "t1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "stdout.log"), "boom\n");
  writeFileSync(join(runDir, "stderr.log"), "");
  return {
    id: partial.id ?? "last-stack-disk-reclaim",
    runDir,
    invocation: { bin: "true", args: [], display: "true" },
    exitCode: partial.exitCode ?? 1,
    signal: partial.signal ?? null,
    timedOut: partial.timedOut ?? false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: partial.durationMs ?? 100,
    heartbeat: { attempted: false, ok: true },
    outcome: partial.outcome ?? {
      kind: "error",
      detail: "unit-test failure",
      source: "exit",
    },
    harnessPid: null,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "routines-err-esc-"));
  process.env.ROUTINES_HOME = home;
  delete process.env.ROUTINES_ERROR_ESCALATE;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.ROUTINES_HOME;
  else process.env.ROUTINES_HOME = prevHome;
  if (prevEsc === undefined) delete process.env.ROUTINES_ERROR_ESCALATE;
  else process.env.ROUTINES_ERROR_ESCALATE = prevEsc;
  rmSync(home, { recursive: true, force: true });
});

describe("shouldEscalate", () => {
  test("non-zero exit", () => {
    expect(shouldEscalate(result({ exitCode: 1 }))).toBe(true);
  });
  test("timeout", () => {
    expect(shouldEscalate(result({ exitCode: 124, timedOut: true }))).toBe(true);
  });
  test("completed ok heartbeat timeout is not escalated", () => {
    expect(
      shouldEscalate(
        result({
          exitCode: 0,
          timedOut: true,
          outcome: { kind: "ok", detail: "GREEN findings=0", source: "heartbeat" },
        }),
      ),
    ).toBe(false);
  });
  test("completed ok routine-result timeout with raw 124 is not escalated", () => {
    expect(
      shouldEscalate(
        result({
          exitCode: 124,
          timedOut: true,
          outcome: {
            kind: "ok",
            detail: "worked=card result=merged",
            source: "routine_result",
          },
        }),
      ),
    ).toBe(false);
  });
  test("completed noop routine-result timeout with raw 124 is not escalated", () => {
    expect(
      shouldEscalate(
        result({
          exitCode: 124,
          timedOut: true,
          outcome: {
            kind: "noop",
            detail: "idle=nothing-safe",
            source: "routine_result",
          },
        }),
      ),
    ).toBe(false);
  });
  test("soft outcome error with exit 0", () => {
    expect(
      shouldEscalate(
        result({
          exitCode: 0,
          outcome: { kind: "error", detail: "deploy blocked", source: "heartbeat" },
        }),
      ),
    ).toBe(true);
  });
  test("ok exit 0 not escalated", () => {
    expect(
      shouldEscalate(
        result({
          exitCode: 0,
          outcome: { kind: "ok", detail: "fine", source: "heartbeat" },
        }),
      ),
    ).toBe(false);
  });
  test("triage id never escalated", () => {
    expect(
      shouldEscalate(result({ id: "routine-error-triage", exitCode: 1 })),
    ).toBe(false);
  });
  test("disabled via env", () => {
    process.env.ROUTINES_ERROR_ESCALATE = "0";
    expect(shouldEscalate(result({ exitCode: 1 }))).toBe(false);
  });
  test("auto scheduled escalation skips throwaway routines homes unless explicitly enabled", () => {
    const r = result({ exitCode: 1 });

    expect(shouldEscalate(r)).toBe(true);
    expect(shouldAutoEscalateScheduledRun(r)).toBe(false);

    process.env.ROUTINES_ERROR_ESCALATE = "1";
    expect(shouldAutoEscalateScheduledRun(r)).toBe(true);
  });
});

describe("escalateRoutineError", () => {
  test("files card via stub kanban and writes state", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "kanban-stub");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
echo "created card $2"
exit 0
`,
    );
    // executable
    spawnSyncchmod(stub);

    const r = result({ exitCode: 1 });
    const out = escalateRoutineError(entry(), r, {
      kanbanBin: stub,
      dispatchAgent: false,
      quiet: true,
    });
    expect(out.escalated).toBe(true);
    expect(out.cardSlug).toBe("routine-error-last-stack-disk-reclaim");
    expect(existsEscalatedJson(r.runDir)).toBe(true);
  });

  test("retries kanban add failures before recording success", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "kanban-stub");
    const countFile = join(stubDir, "count");
    const bodyPrefix = join(stubDir, "body-");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "rank" ]; then
  exit 0
fi
count_file=${JSON.stringify(countFile)}
body_prefix=${JSON.stringify(bodyPrefix)}
n=0
if [ -f "$count_file" ]; then
  n=$(cat "$count_file")
fi
n=$((n + 1))
echo "$n" > "$count_file"
cat > "\${body_prefix}\${n}.md"
if [ "$n" -lt 3 ]; then
  echo "temporary 503 attempt $n" >&2
  exit 1
fi
echo "created card $2"
exit 0
`,
    );
    spawnSyncchmod(stub);

    const r = result({ exitCode: 1 });
    const out = escalateRoutineError(entry(), r, {
      kanbanBin: stub,
      dispatchAgent: false,
      quiet: true,
      nowMs: 1_700_000_000_000,
      cardRetryDelayMs: 0,
    });

    expect(out.escalated).toBe(true);
    expect(readFileSync(countFile, "utf8").trim()).toBe("3");
    const breadcrumb = readEscalatedJson(r.runDir);
    expect(breadcrumb.cardOk).toBe(true);
    expect(breadcrumb.cardDetail).toBeNull();
    expect(readFileSync(join(stubDir, "body-1.md"), "utf8")).toContain(
      "Root-cause and fix why scheduled routine",
    );
    expect(readFileSync(join(stubDir, "body-3.md"), "utf8")).toContain(
      "Root-cause and fix why scheduled routine",
    );
  });

  test("records final kanban stderr when all card retries fail", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "kanban-stub");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
echo "temporary 503 from attempt" >&2
exit 1
`,
    );
    spawnSyncchmod(stub);

    const r = result({ exitCode: 1 });
    const out = escalateRoutineError(entry(), r, {
      kanbanBin: stub,
      dispatchAgent: false,
      quiet: true,
      nowMs: 1_700_000_000_000,
      cardRetryDelayMs: 0,
    });

    expect(out.escalated).toBe(true);
    const breadcrumb = readEscalatedJson(r.runDir);
    expect(breadcrumb.cardOk).toBe(false);
    expect(breadcrumb.cardDetail ?? "").toContain("kanban add failed after 3 attempts");
    expect(breadcrumb.cardDetail ?? "").toContain("temporary 503 from attempt");
  });

  test("rate-limits agent dispatch", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "kanban-stub");
    writeFileSync(stub, "#!/usr/bin/env bash\necho ok\nexit 0\n");
    spawnSyncchmod(stub);

    const e = entry();
    const r1 = result({ exitCode: 1 });
    const t0 = Date.now();
    const a = escalateRoutineError(e, r1, {
      kanbanBin: stub,
      dispatchAgent: true,
      nowMs: t0,
      agentCooldownMs: 60_000,
      quiet: true,
    });
    expect(a.escalated).toBe(true);

    const r2 = result({ exitCode: 2 });
    const b = escalateRoutineError(e, r2, {
      kanbanBin: stub,
      dispatchAgent: true,
      nowMs: t0 + 1_000,
      agentCooldownMs: 60_000,
      quiet: true,
    });
    expect(b.escalated).toBe(true);
    expect(b.agent ?? "").toContain("cooldown");
  });
});

function spawnSyncchmod(path: string): void {
  spawnSync("chmod", ["+x", path]);
}

function existsEscalatedJson(runDir: string): boolean {
  try {
    readFileSync(join(runDir, "error-escalated.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function readEscalatedJson(runDir: string): {
  cardOk: boolean | null;
  cardDetail: string | null;
} {
  return JSON.parse(readFileSync(join(runDir, "error-escalated.json"), "utf8"));
}
