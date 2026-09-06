import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  escalateRoutineError,
  escalateStatePath,
  isAtomContentTooLarge,
  isClassifiedErrorOutcome,
  retractEscalateStateIfRecovered,
  ROUTINE_PAPERCUT_ARCHIVE_MAX_CHARS,
  ROUTINE_PAPERCUT_HIGH_WATER_CHARS,
  ROUTINE_PAPERCUT_SLUG,
  rollRoutinePapercutLedger,
  shouldAutoEscalateScheduledRun,
  shouldEscalate,
  splitLedgerBodyForArchive,
} from "../src/error-escalate.ts";
import type { RoutineEntry } from "../src/registry.ts";
import type { RunResult } from "../src/runner.ts";
import { parseRRule } from "../src/rrule.ts";

let home: string;
const prevHome = process.env.ROUTINES_HOME;
const prevEsc = process.env.ROUTINES_ERROR_ESCALATE;

function entry(
  id = "last-stack-disk-reclaim",
  errorPriority: RoutineEntry["errorPriority"] = "P0",
): RoutineEntry {
  return {
    id,
    harness: "codex",
    model: "gpt-5.5",
    resolvedBy: "pin",
    rrule: "FREQ=HOURLY",
    parsedRrule: parseRRule("FREQ=HOURLY"),
    cwd: home,
    status: "active",
    timeoutMin: 30,
    errorPriority,
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

describe("isClassifiedErrorOutcome", () => {
  test("only classified error is an error row, not leftover lastExit", () => {
    expect(isClassifiedErrorOutcome("error")).toBe(true);
    expect(isClassifiedErrorOutcome("ok")).toBe(false);
    expect(isClassifiedErrorOutcome("noop")).toBe(false);
    expect(isClassifiedErrorOutcome("unknown")).toBe(false);
    expect(isClassifiedErrorOutcome(null)).toBe(false);
  });
});

describe("retractEscalateStateIfRecovered", () => {
  test("ok run unlinks a prior failure stamp", () => {
    process.env.ROUTINES_ERROR_ESCALATE = "1";
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const brainStub = join(stubDir, "brain-stub");
    const kanbanStub = join(stubDir, "kanban-stub");
    writeFileSync(
      brainStub,
      `#!/usr/bin/env bash
set -euo pipefail
echo appended
`,
    );
    writeFileSync(
      kanbanStub,
      `#!/usr/bin/env bash
set -euo pipefail
exit 1
`,
    );
    spawnSyncchmod(brainStub);
    spawnSyncchmod(kanbanStub);

    const failed = result({ exitCode: 1 });
    escalateRoutineError(entry("last-stack-disk-reclaim", "P3"), failed, {
      kanbanBin: kanbanStub,
      brainBin: brainStub,
      dispatchAgent: false,
      quiet: true,
    });
    const stamp = escalateStatePath("last-stack-disk-reclaim");
    expect(existsSync(stamp)).toBe(true);

    const recovered = result({
      exitCode: 0,
      timedOut: false,
      outcome: { kind: "ok", detail: "worked", source: "sink" },
    });
    expect(retractEscalateStateIfRecovered(recovered, { quiet: true })).toBe(true);
    expect(existsSync(stamp)).toBe(false);
  });

  test("error run does not retract", () => {
    const stamp = escalateStatePath("last-stack-disk-reclaim");
    mkdirSync(join(home, "error-escalate"), { recursive: true });
    writeFileSync(stamp, JSON.stringify({ lastOutcome: "error" }) + "\n");
    const stillBad = result({
      exitCode: 1,
      outcome: { kind: "error", detail: "still-broken", source: "exit" },
    });
    expect(retractEscalateStateIfRecovered(stillBad, { quiet: true })).toBe(false);
    expect(existsSync(stamp)).toBe(true);
  });

  test("noop is a recovery", () => {
    const stamp = escalateStatePath("last-stack-disk-reclaim");
    mkdirSync(join(home, "error-escalate"), { recursive: true });
    writeFileSync(stamp, JSON.stringify({ lastOutcome: "error" }) + "\n");
    const noop = result({
      exitCode: 0,
      outcome: { kind: "noop", detail: "nothing-to-do", source: "sink" },
    });
    expect(retractEscalateStateIfRecovered(noop, { quiet: true })).toBe(true);
    expect(existsSync(stamp)).toBe(false);
  });
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
  test("new routine failures default to P3 and append to Brain without a Kanban write", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const kanbanStub = join(stubDir, "kanban-stub");
    const kanbanArgsFile = join(stubDir, "kanban-args");
    const brainStub = join(stubDir, "brain-stub");
    const brainArgsFile = join(stubDir, "brain-args");
    const brainBodyFile = join(stubDir, "brain-body");
    writeFileSync(
      kanbanStub,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >> ${JSON.stringify(kanbanArgsFile)}
if [ "\${1:-}" = "show" ]; then exit 1; fi
echo "unexpected Kanban write" >&2
exit 97
`,
    );
    writeFileSync(
      brainStub,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > ${JSON.stringify(brainArgsFile)}
cat > ${JSON.stringify(brainBodyFile)}
echo "appended papercut"
`,
    );
    spawnSyncchmod(kanbanStub);
    spawnSyncchmod(brainStub);

    const r = result({ exitCode: 1 });
    const out = escalateRoutineError({ ...entry(), errorPriority: undefined }, r, {
      kanbanBin: kanbanStub,
      brainBin: brainStub,
      dispatchAgent: false,
      quiet: true,
    });

    expect(out.escalated).toBe(true);
    expect(out.cardSlug).toBeUndefined();
    expect(readFileSync(kanbanArgsFile, "utf8").trim()).toBe(
      "show\nroutine-error-last-stack-disk-reclaim\n--json",
    );
    expect(readFileSync(brainArgsFile, "utf8").split("\n")).toEqual(
      expect.arrayContaining(["append", "papercut-routine-non-p0-failures", "reference"]),
    );
    const body = readFileSync(brainBodyFile, "utf8");
    expect(body).toContain("priority: P3");
    expect(body).toContain("signature:");
    expect(body).toContain("routine:routinesd-error-escalate");
    const breadcrumb = JSON.parse(
      readFileSync(join(r.runDir, "error-escalated.json"), "utf8"),
    );
    expect(breadcrumb.cardSlug).toBeNull();
    expect(breadcrumb.brainSlug).toBe("papercut-routine-non-p0-failures");
    expect(breadcrumb.agentDispatched).toBe(false);
  });

  test("registry can opt a critical routine into P0", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "kanban-stub");
    const argsFile = join(stubDir, "args");
    const brainStub = join(stubDir, "brain-stub");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "show" ]; then exit 1; fi
if [ "\${1:-}" = "rank" ]; then exit 0; fi
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
cat >/dev/null
echo ok
`,
    );
    spawnSyncchmod(stub);
    writeFileSync(brainStub, "#!/usr/bin/env bash\necho unexpected >&2\nexit 98\n");
    spawnSyncchmod(brainStub);

    const out = escalateRoutineError(
      { ...entry("backup-restore-probe"), errorPriority: "P0" },
      result({ id: "backup-restore-probe", exitCode: 1 }),
      { kanbanBin: stub, brainBin: brainStub, dispatchAgent: false, quiet: true },
    );

    expect(out.escalated).toBe(true);
    expect(readFileSync(argsFile, "utf8").split("\n")).toContain("P0");
  });

  test("creates the consolidated Brain inbox when the first append finds no record", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const kanbanStub = join(stubDir, "kanban-stub");
    const brainStub = join(stubDir, "brain-stub");
    const brainCalls = join(stubDir, "brain-calls");
    const putBody = join(stubDir, "put-body");
    writeFileSync(kanbanStub, "#!/usr/bin/env bash\nexit 1\n");
    writeFileSync(
      brainStub,
      `#!/usr/bin/env bash
printf '%s\n' "$1" >> ${JSON.stringify(brainCalls)}
if [ "$1" = "append" ]; then
  echo "record not found" >&2
  exit 1
fi
if [ "$1" = "put" ]; then
  cat > ${JSON.stringify(putBody)}
  echo created
  exit 0
fi
exit 2
`,
    );
    spawnSyncchmod(kanbanStub);
    spawnSyncchmod(brainStub);

    const out = escalateRoutineError(
      { ...entry(), errorPriority: undefined },
      result({ exitCode: 1 }),
      {
        kanbanBin: kanbanStub,
        brainBin: brainStub,
        dispatchAgent: false,
        quiet: true,
      },
    );

    expect(out.detail).toContain("papercut-recorded");
    expect(readFileSync(brainCalls, "utf8").trim().split("\n")).toEqual([
      "get",
      "append",
      "put",
    ]);
    const body = readFileSync(putBody, "utf8");
    expect(body).toContain("type: reference");
    expect(body).toContain("slug: papercut-routine-non-p0-failures");
    expect(body).toContain("Status: OPEN");
    expect(body).toContain("priority: P3");
  });

  test("existing human-set non-P0 priority wins and routes to Brain", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "kanban-stub");
    const argsFile = join(stubDir, "args");
    const brainStub = join(stubDir, "brain-stub");
    const brainBodyFile = join(stubDir, "brain-body");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "show" ]; then
  echo '{"tags":["routine","error","p2"]}'
  exit 0
fi
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
exit 97
`,
    );
    spawnSyncchmod(stub);
    writeFileSync(
      brainStub,
      `#!/usr/bin/env bash
cat > ${JSON.stringify(brainBodyFile)}
echo ok
`,
    );
    spawnSyncchmod(brainStub);

    const out = escalateRoutineError(
      { ...entry(), errorPriority: "P0" },
      result({ exitCode: 1 }),
      { kanbanBin: stub, brainBin: brainStub, dispatchAgent: false, quiet: true },
    );

    expect(out.escalated).toBe(true);
    expect(out.cardSlug).toBeUndefined();
    expect(existsSync(argsFile)).toBe(false);
    expect(readFileSync(brainBodyFile, "utf8")).toContain("priority: P2");
  });

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
if [ "\${1:-}" = "show" ]; then
  exit 1
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

  test("rolls the ledger on atom_content_too_large then retries append once", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const kanbanStub = join(stubDir, "kanban-stub");
    const brainStub = join(stubDir, "brain-stub");
    const stateFile = join(stubDir, "state");
    const putsDir = join(stubDir, "puts");
    const getJson = join(stubDir, "get.json");
    mkdirSync(putsDir, { recursive: true });
    writeFileSync(stateFile, "0\n");
    writeFileSync(kanbanStub, "#!/usr/bin/env bash\nexit 1\n");
    const liveBody =
      "# preamble\n\n## 2026-07-22T00:29:00.000Z — a\n\n- x\n\n## 2026-09-04T09:47:11.710Z — b\n\n- y\n";
    writeFileSync(
      getJson,
      JSON.stringify({
        slug: "papercut-routine-non-p0-failures",
        title: "live",
        body: liveBody,
      }),
    );
    writeFileSync(
      brainStub,
      `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
const getJson = ${JSON.stringify(getJson)};
const putsDir = ${JSON.stringify(putsDir)};
const cmd = process.argv[2] ?? "";
const state = Number(readFileSync(stateFile, "utf8").trim() || "0");
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
if (cmd === "get") {
  if (state >= 1) {
    console.log(JSON.stringify({
      slug: "papercut-routine-non-p0-failures",
      body: "# pointer\\n",
      title: "live",
    }));
  } else {
    console.log(readFileSync(getJson, "utf8"));
  }
  process.exit(0);
}
if (cmd === "append") {
  if (state === 0) {
    console.error("error: Node /api/mutation returned HTTP 413: atom content too large: 524539 bytes exceeds hard limit of 524288 bytes");
    console.log(JSON.stringify({ error: "atom_content_too_large" }));
    process.exit(1);
  }
  console.log("appended after roll");
  process.exit(0);
}
if (cmd === "put") {
  const body = await readStdin();
  const m = body.match(/^slug:\\s*(\\S+)/m);
  if (!m) {
    console.error("no-slug");
    process.exit(3);
  }
  writeFileSync(putsDir + "/" + m[1], body);
  writeFileSync(stateFile, String(state + 1) + "\\n");
  console.log("put " + m[1]);
  process.exit(0);
}
console.error("unexpected " + cmd);
process.exit(2);
`,
    );
    spawnSyncchmod(kanbanStub);
    spawnSyncchmod(brainStub);

    const r = result({ exitCode: 1 });
    const out = escalateRoutineError(
      { ...entry(), errorPriority: undefined },
      r,
      {
        kanbanBin: kanbanStub,
        brainBin: brainStub,
        dispatchAgent: false,
        quiet: true,
        cardRetryDelayMs: 1,
      },
    );

    expect(out.detail).toContain("papercut-recorded");
    expect(out.detail).toContain("after ledger roll");
    const breadcrumb = JSON.parse(
      readFileSync(join(r.runDir, "error-escalated.json"), "utf8"),
    );
    expect(breadcrumb.brainOk).toBe(true);
    const putFiles = readdirSync(putsDir).filter((n) =>
      n.startsWith("papercut-routine-non-p0-failures"),
    );
    expect(putFiles.some((n) => n.includes("archive"))).toBe(true);
    expect(putFiles).toContain("papercut-routine-non-p0-failures");
    const livePut = readFileSync(join(putsDir, "papercut-routine-non-p0-failures"), "utf8");
    expect(livePut).toContain("Rotated");
    expect(livePut).toContain("[[papercut-routine-non-p0-failures-archive-");
  });

  test("announces papercut-failed on the run outcome when roll cannot recover", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const kanbanStub = join(stubDir, "kanban-stub");
    const brainStub = join(stubDir, "brain-stub");
    const hb = join(stubDir, "heartbeats.log");
    writeFileSync(kanbanStub, "#!/usr/bin/env bash\nexit 1\n");
    writeFileSync(
      brainStub,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "get" ]; then
  echo '{"slug":"papercut-routine-non-p0-failures","body":"small","title":"live"}'
  exit 0
fi
if [ "\${1:-}" = "append" ]; then
  echo 'HTTP 413: atom content too large' >&2
  exit 1
fi
if [ "\${1:-}" = "put" ]; then
  echo 'put refused' >&2
  exit 1
fi
exit 2
`,
    );
    spawnSyncchmod(kanbanStub);
    spawnSyncchmod(brainStub);
    process.env.ROUTINES_HEARTBEATS_FILE = hb;

    const r = result({ exitCode: 1 });
    const out = escalateRoutineError(
      { ...entry(), errorPriority: undefined },
      r,
      {
        kanbanBin: kanbanStub,
        brainBin: brainStub,
        dispatchAgent: false,
        quiet: true,
        cardRetryDelayMs: 1,
      },
    );

    expect(out.detail).toContain("papercut-failed");
    const breadcrumb = JSON.parse(
      readFileSync(join(r.runDir, "error-escalated.json"), "utf8"),
    );
    expect(breadcrumb.brainOk).toBe(false);
    const sink = readFileSync(join(r.runDir, "outcome.txt"), "utf8");
    expect(sink).toContain("escalate=papercut-failed");
    const stdout = readFileSync(join(r.runDir, "stdout.log"), "utf8");
    expect(stdout).toContain("ROUTINE_RESULT outcome=error");
    expect(stdout).toContain("escalate=papercut-failed");
    expect(readFileSync(hb, "utf8")).toContain("escalate=papercut-failed");
  });
});

describe("splitLedgerBodyForArchive", () => {
  test("keeps a small body as one segment", () => {
    const body = "## 2026-07-22T00:29:00.000Z — a\n\n- x\n";
    const segs = splitLedgerBodyForArchive(body, 10_000);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.entryCount).toBe(1);
    expect(segs[0]!.fromIso).toBe("2026-07-22T00:29:00.000Z");
  });

  test("splits a body over the single-atom archive limit into multiple segments", () => {
    const entries: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const day = String(i + 1).padStart(2, "0");
      entries.push(
        `## 2026-08-${day}T12:00:00.000Z — routine-${i}\n\n${"x".repeat(30_000)}\n\n`,
      );
    }
    const body = `# preamble\n\n${entries.join("")}`;
    expect(body.length).toBeGreaterThan(ROUTINE_PAPERCUT_ARCHIVE_MAX_CHARS);
    const segs = splitLedgerBodyForArchive(body, ROUTINE_PAPERCUT_ARCHIVE_MAX_CHARS);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.reduce((n, s) => n + s.entryCount, 0)).toBe(20);
    for (const seg of segs) {
      expect(seg.body.length).toBeLessThanOrEqual(ROUTINE_PAPERCUT_ARCHIVE_MAX_CHARS + 50_000);
    }
  });
});

describe("isAtomContentTooLarge", () => {
  test("matches the typed 413 body routinesd sees in the wild", () => {
    expect(
      isAtomContentTooLarge({
        status: 1,
        signal: null,
        output: [],
        pid: 0,
        stdout: "",
        stderr:
          "error: Node /api/mutation returned HTTP 413: atom content too large: 524539 bytes exceeds hard limit of 524288 bytes",
        error: undefined,
      } as ReturnType<typeof spawnSync>),
    ).toBe(true);
    expect(
      isAtomContentTooLarge({
        status: 1,
        signal: null,
        output: [],
        pid: 0,
        stdout: "",
        stderr: "record not found",
        error: undefined,
      } as ReturnType<typeof spawnSync>),
    ).toBe(false);
  });
});

describe("rollRoutinePapercutLedger", () => {
  test("writes multiple archives when the body exceeds one atom", () => {
    const stubDir = join(home, "bin");
    mkdirSync(stubDir, { recursive: true });
    const brainStub = join(stubDir, "brain-stub");
    const putsDir = join(stubDir, "puts");
    mkdirSync(putsDir, { recursive: true });
    const entries: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const day = String(i + 1).padStart(2, "0");
      entries.push(
        `## 2026-07-${day}T00:00:00.000Z — r${i}\n\n${"y".repeat(50_000)}\n\n`,
      );
    }
    const big = `# head\n\n${entries.join("")}`;
    expect(big.length).toBeGreaterThan(ROUTINE_PAPERCUT_HIGH_WATER_CHARS);

    // Bun stub avoids bash pipefail+SIGPIPE on large stdin.
    writeFileSync(
      brainStub,
      `#!/usr/bin/env bun
const putsDir = ${JSON.stringify(putsDir)};
const cmd = process.argv[2] ?? "";
if (cmd !== "put") {
  console.error("unexpected " + cmd);
  process.exit(2);
}
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(Buffer.from(c));
const body = Buffer.concat(chunks).toString("utf8");
const m = body.match(/^slug:\\s*(\\S+)/m);
if (!m) {
  console.error("no-slug");
  process.exit(3);
}
await Bun.write(putsDir + "/" + m[1], body);
console.log("ok");
`,
    );
    spawnSyncchmod(brainStub);

    const rolled = rollRoutinePapercutLedger(brainStub, {
      quiet: true,
      bodyOverride: big,
      nowMs: Date.parse("2026-09-06T00:12:00.000Z"),
    });
    expect(rolled.ok).toBe(true);
    expect(rolled.archives.length).toBeGreaterThan(1);
    expect(existsSync(join(putsDir, ROUTINE_PAPERCUT_SLUG))).toBe(true);
    for (const slug of rolled.archives) {
      expect(existsSync(join(putsDir, slug))).toBe(true);
    }
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
