import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  escalateRoutineError,
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
