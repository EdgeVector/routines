import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escalateRoutineError } from "../src/error-escalate.ts";
import {
  classifyHarnessOutage,
  handleHarnessOutage,
  outageSituationSlug,
  parseResetHint,
} from "../src/harness-outage.ts";
import type { RoutineEntry } from "../src/registry.ts";
import type { RunResult } from "../src/runner.ts";
import { parseRRule } from "../src/rrule.ts";

const CODEX_LIMIT_LINE =
  "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 22nd, 2026 10:00 PM.";
const CODEX_CAPACITY_LINE =
  "ERROR: Selected model is at capacity. Please try a different model.";

let home: string;
const prevHome = process.env.ROUTINES_HOME;

function entry(id = "last-stack-pipeline-health", harness: "codex" | "claude" = "codex"): RoutineEntry {
  return {
    id,
    harness,
    model: harness === "codex" ? "gpt-5.5" : "opus",
    rrule: "FREQ=HOURLY",
    parsedRrule: parseRRule("FREQ=HOURLY"),
    cwd: home,
    status: "active",
    timeoutMin: 30,
    sourcePath: join(home, "registry", `${id}.toml`),
  };
}

function result(stderr: string, id = "last-stack-pipeline-health"): RunResult {
  const runDir = join(home, "runs", id, "t1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "stdout.log"), "");
  writeFileSync(join(runDir, "stderr.log"), stderr);
  return {
    id,
    runDir,
    invocation: { bin: "true", args: [], display: "true" },
    exitCode: 1,
    signal: null,
    timedOut: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    heartbeat: { attempted: false, ok: true },
    outcome: { kind: "error", detail: "exit 1", source: "exit" },
    harnessPid: null,
  };
}

/** Stub binary that records argv + stdin into files and exits 0. */
function stubBin(name: string): { bin: string; argsFile: string; stdinFile: string } {
  const dir = join(home, "bin");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  const argsFile = join(dir, `${name}-args`);
  const stdinFile = join(dir, `${name}-stdin`);
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >> ${JSON.stringify(argsFile)}
printf -- '----\\n' >> ${JSON.stringify(argsFile)}
cat >> ${JSON.stringify(stdinFile)} 2>/dev/null || true
exit 0
`,
  );
  spawnSync("chmod", ["+x", bin]);
  return { bin, argsFile, stdinFile };
}

function writeRegistryEntry(id: string, harness: string): void {
  const dir = join(home, "registry");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.toml`),
    `id = "${id}"
harness = "${harness}"
model = "m"
rrule = "FREQ=HOURLY"
cwd = "${home}"
status = "active"
timeout_min = 10
prompt = "noop"
`,
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "routines-harness-outage-"));
  process.env.ROUTINES_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.ROUTINES_HOME;
  else process.env.ROUTINES_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("classifyHarnessOutage", () => {
  test("codex usage-limit stderr classifies as usage-limit with reset time", () => {
    const out = classifyHarnessOutage(result(CODEX_LIMIT_LINE), {
      nowMs: Date.parse("2026-07-17T18:00:00Z"),
    });
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("usage-limit");
    expect(out!.evidence).toContain("hit your usage limit");
    expect(out!.resetHint).toContain("Jul 22");
    expect(out!.resetAt).not.toBeNull();
  });

  test("insufficient_quota classifies as usage-limit", () => {
    const out = classifyHarnessOutage(result("openai error: insufficient_quota"));
    expect(out?.kind).toBe("usage-limit");
  });

  test("codex selected-model capacity classifies as capacity", () => {
    const out = classifyHarnessOutage(result(CODEX_CAPACITY_LINE));
    expect(out?.kind).toBe("capacity");
    expect(out?.evidence).toContain("Selected model is at capacity");
    expect(out?.resetAt).toBeNull();
  });

  test("invalid api key classifies as auth", () => {
    const out = classifyHarnessOutage(result("Error: invalid API key provided"));
    expect(out?.kind).toBe("auth");
  });

  test("ordinary failure is not an outage", () => {
    expect(classifyHarnessOutage(result("TypeError: undefined is not a function"))).toBeNull();
    expect(classifyHarnessOutage(result(""))).toBeNull();
  });
});

describe("parseResetHint", () => {
  test("parses ordinal date hints", () => {
    const { hint, iso } = parseResetHint(
      "try again at Jul 22nd, 2026 10:00 PM.",
      Date.parse("2026-07-17T00:00:00Z"),
    );
    expect(hint).toBe("Jul 22nd, 2026 10:00 PM");
    expect(iso).not.toBeNull();
    expect(new Date(iso!).getUTCFullYear()).toBe(2026);
  });

  test("unparseable hint keeps text but no iso", () => {
    const { hint, iso } = parseResetHint("try again at the next blue moon.", 0);
    expect(hint).toBe("the next blue moon");
    expect(iso).toBeNull();
  });

  test("no hint", () => {
    expect(parseResetHint("nothing here", 0)).toEqual({ hint: null, iso: null });
  });
});

describe("handleHarnessOutage via escalateRoutineError", () => {
  test("usage-limit: no card, needs-human verdict, situation fence, telegram page", () => {
    const kanban = stubBin("kanban-stub");
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    writeRegistryEntry("last-stack-pipeline-health", "codex");
    writeRegistryEntry("last-stack-merge-babysit", "codex");
    writeRegistryEntry("claude-only-routine", "claude");

    const r = result(CODEX_LIMIT_LINE);
    const out = escalateRoutineError(entry(), r, {
      kanbanBin: kanban.bin,
      quiet: true,
      nowMs: Date.parse("2026-07-17T18:00:00Z"),
      harnessOutage: { situationsBin: situations.bin, raBin: ra.bin },
    });

    expect(out.escalated).toBe(true);
    expect(out.detail).toContain("harness-outage:usage-limit");
    // No kanban card and no triage agent.
    expect(existsSync(kanban.argsFile)).toBe(false);
    expect(out.cardSlug).toBeUndefined();

    // needs-human verdict for the dashboard.
    const verdict = JSON.parse(readFileSync(join(r.runDir, "triage-result.json"), "utf8"));
    expect(verdict.result).toBe("needs-human");
    expect(verdict.needsHuman).toBe(true);
    expect(verdict.rootCause).toBe("harness-outage:usage-limit");

    // Situation fences exactly the codex routines.
    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.slug).toBe(outageSituationSlug("codex"));
    expect(sit.status).toBe("active");
    expect(sit.scope_routines).toEqual([
      "last-stack-merge-babysit",
      "last-stack-pipeline-health",
    ]);
    expect(sit.scope_routines).not.toContain("claude-only-routine");
    expect(typeof sit.expires_at).toBe("string");

    // Telegram page went out with high priority.
    const raArgs = readFileSync(ra.argsFile, "utf8");
    expect(raArgs).toContain("notify");
    expect(raArgs).toContain("high");
    expect(raArgs).toContain("Needs human");

    // Breadcrumb marks the run escalated without a card or triage agent.
    const crumb = JSON.parse(readFileSync(join(r.runDir, "error-escalated.json"), "utf8"));
    expect(crumb.cardSlug).toBeNull();
    expect(crumb.agentDispatched).toBe(false);
    expect(crumb.harnessOutage.kind).toBe("usage-limit");
  });

  test("model capacity: no card, needs-human verdict, situation fence, telegram page", () => {
    const kanban = stubBin("kanban-stub");
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    writeRegistryEntry("last-stack-fkanban-pickup-w3", "codex");

    const r = result(CODEX_CAPACITY_LINE, "last-stack-fkanban-pickup-w3");
    const out = escalateRoutineError(entry("last-stack-fkanban-pickup-w3"), r, {
      kanbanBin: kanban.bin,
      quiet: true,
      nowMs: Date.parse("2026-07-17T22:02:33Z"),
      harnessOutage: { situationsBin: situations.bin, raBin: ra.bin },
    });

    expect(out.escalated).toBe(true);
    expect(out.detail).toContain("harness-outage:capacity");
    expect(existsSync(kanban.argsFile)).toBe(false);

    const verdict = JSON.parse(readFileSync(join(r.runDir, "triage-result.json"), "utf8"));
    expect(verdict.result).toBe("needs-human");
    expect(verdict.needsHuman).toBe(true);
    expect(verdict.rootCause).toBe("harness-outage:capacity");

    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.slug).toBe(outageSituationSlug("codex"));
    expect(sit.summary).toContain("capacity");
    expect(sit.scope_routines).toEqual(["last-stack-fkanban-pickup-w3"]);

    const raArgs = readFileSync(ra.argsFile, "utf8");
    expect(raArgs).toContain("Needs human");

    const crumb = JSON.parse(readFileSync(join(r.runDir, "error-escalated.json"), "utf8"));
    expect(crumb.cardSlug).toBeNull();
    expect(crumb.agentDispatched).toBe(false);
    expect(crumb.harnessOutage.kind).toBe("capacity");
  });

  test("second outage within cooldown refreshes nothing and does not re-page", () => {
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    writeRegistryEntry("last-stack-pipeline-health", "codex");
    const nowMs = Date.parse("2026-07-17T18:00:00Z");

    const first = handleHarnessOutage(
      entry(),
      result(CODEX_LIMIT_LINE),
      classifyHarnessOutage(result(CODEX_LIMIT_LINE), { nowMs })!,
      { nowMs, situationsBin: situations.bin, raBin: ra.bin, quiet: true },
    );
    expect(first.escalated).toBe(true);

    const again = handleHarnessOutage(
      entry("last-stack-merge-babysit"),
      result(CODEX_LIMIT_LINE, "last-stack-merge-babysit"),
      classifyHarnessOutage(result(CODEX_LIMIT_LINE, "last-stack-merge-babysit"), {
        nowMs: nowMs + 60_000,
      })!,
      {
        nowMs: nowMs + 60_000,
        situationsBin: situations.bin,
        raBin: ra.bin,
        quiet: true,
      },
    );
    expect(again.escalated).toBe(true);
    expect(again.detail).toContain("fresh");
    expect(again.detail).toContain("cooldown");

    // Exactly one situations call and one telegram page across both runs.
    const sitCalls = readFileSync(situations.argsFile, "utf8").match(/----/g)?.length ?? 0;
    const raCalls = readFileSync(ra.argsFile, "utf8").match(/----/g)?.length ?? 0;
    expect(sitCalls).toBe(1);
    expect(raCalls).toBe(1);
  });

  test("situation expires_at uses provider reset time when parseable", () => {
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    writeRegistryEntry("last-stack-pipeline-health", "codex");
    const nowMs = Date.parse("2026-07-17T18:00:00Z");
    const outage = classifyHarnessOutage(result(CODEX_LIMIT_LINE), { nowMs })!;
    expect(outage.resetAt).not.toBeNull();

    handleHarnessOutage(entry(), result(CODEX_LIMIT_LINE), outage, {
      nowMs,
      situationsBin: situations.bin,
      raBin: ra.bin,
      quiet: true,
    });
    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.expires_at).toBe(outage.resetAt);
  });

  test("stub binary failures never throw and are recorded in detail", () => {
    writeRegistryEntry("last-stack-pipeline-health", "codex");
    const nowMs = Date.parse("2026-07-17T18:00:00Z");
    const outage = classifyHarnessOutage(result(CODEX_LIMIT_LINE), { nowMs })!;
    const out = handleHarnessOutage(entry(), result(CODEX_LIMIT_LINE), outage, {
      nowMs,
      situationsBin: join(home, "bin", "does-not-exist"),
      raBin: join(home, "bin", "does-not-exist"),
      quiet: true,
    });
    expect(out.escalated).toBe(true);
    expect(out.detail).toContain("situation FAILED");
    expect(out.detail).toContain("telegram FAILED");
  });
});
