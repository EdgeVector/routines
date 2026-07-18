import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRouteChain,
  DEFAULT_FALLBACK_TAIL,
  parseFallbackChain,
  primaryRoute,
} from "../src/fallback.ts";
import { handleHarnessOutage, isHarnessOutaged } from "../src/harness-outage.ts";
import { loadEntry, parseEntry } from "../src/registry.ts";
import { parseRRule } from "../src/rrule.ts";
import { runRoutine, type RunResult } from "../src/runner.ts";
import type { RoutineEntry } from "../src/registry.ts";

const CODEX_LIMIT =
  "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 22nd, 2026 10:00 PM.";

let home: string;
const savedEnv = { ...process.env };

function stub(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function baseEntry(over: Partial<RoutineEntry> = {}): RoutineEntry {
  return {
    id: "demo",
    harness: "codex",
    model: "gpt-5.5",
    rrule: "FREQ=HOURLY",
    parsedRrule: parseRRule("FREQ=HOURLY"),
    cwd: home,
    status: "active",
    timeoutMin: 30,
    sourcePath: join(home, "registry", "demo.toml"),
    ...over,
  };
}

beforeEach(() => {
  process.env = { ...savedEnv };
  home = mkdtempSync(join(tmpdir(), "routines-fallback-"));
  process.env.ROUTINES_HOME = home;
  process.env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES = "1";
  process.env.ROUTINES_SIGKILL_GRACE_MS = "50";
  delete process.env.ROUTINES_FALLBACK;
  delete process.env.ROUTINES_FALLBACK_CHAIN;
  mkdirSync(join(home, "registry"), { recursive: true });
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("parseFallbackChain / buildRouteChain", () => {
  test("parses colon and slash forms", () => {
    expect(parseFallbackChain("claude:sonnet,grok/grok-4.5")).toEqual([
      { harness: "claude", model: "sonnet" },
      { harness: "grok", model: "grok-4.5" },
    ]);
  });

  test("default chain is primary then claude then grok", () => {
    const chain = buildRouteChain(baseEntry());
    expect(chain.map((s) => `${s.harness}/${s.model}`)).toEqual([
      "codex/gpt-5.5",
      "claude/sonnet",
      "grok/grok-4.5",
    ]);
    expect(DEFAULT_FALLBACK_TAIL[0]!.harness).toBe("claude");
  });

  test("dedupes primary harness from the tail", () => {
    const chain = buildRouteChain(baseEntry({ harness: "claude", model: "sonnet" }));
    expect(chain.map((s) => s.harness)).toEqual(["claude", "grok"]);
  });

  test("ROUTINES_FALLBACK=0 disables tail", () => {
    process.env.ROUTINES_FALLBACK = "0";
    const chain = buildRouteChain(baseEntry());
    expect(chain).toEqual([primaryRoute(baseEntry())]);
  });

  test("per-routine fallback string overrides fleet default", () => {
    const chain = buildRouteChain(baseEntry({ fallback: "grok:grok-4.5" }));
    expect(chain.map((s) => `${s.harness}/${s.model}`)).toEqual([
      "codex/gpt-5.5",
      "grok/grok-4.5",
    ]);
  });

  test("registry parses optional fallback key", () => {
    const e = parseEntry(
      [
        'harness = "codex"',
        'model = "gpt-5.5"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "hi"',
        'fallback = "claude:sonnet,grok:grok-4.5"',
      ].join("\n"),
      "/x/demo.toml",
    );
    expect(e.fallback).toBe("claude:sonnet,grok:grok-4.5");
  });
});

describe("isHarnessOutaged", () => {
  test("records expiry and clears after", () => {
    const entry = baseEntry();
    const runDir = join(home, "runs", "demo", "t1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "stderr.log"), CODEX_LIMIT);
    writeFileSync(join(runDir, "stdout.log"), "");
    const result = {
      id: "demo",
      runDir,
      invocation: { bin: "true", args: [], display: "true" },
      exitCode: 1,
      signal: null,
      timedOut: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      heartbeat: { attempted: false, ok: true },
      outcome: { kind: "error" as const, detail: "exit 1", source: "exit" as const },
      harnessPid: null,
    } satisfies RunResult;

    const sit = stub(
      join(home, "stub-sit"),
      `#!/bin/sh
exit 0
`,
    );
    const ra = stub(
      join(home, "stub-ra"),
      `#!/bin/sh
exit 0
`,
    );

    handleHarnessOutage(entry, result, {
      kind: "usage-limit",
      evidence: CODEX_LIMIT,
      resetHint: null,
      resetAt: null,
    }, {
      situationsBin: sit,
      raBin: ra,
      quiet: true,
      fenceRoutines: false,
      defaultTtlMs: 60_000,
      nowMs: 1_000_000,
    });

    expect(isHarnessOutaged("codex", 1_000_000)).toBe(true);
    expect(isHarnessOutaged("codex", 1_000_000 + 61_000)).toBe(false);
  });
});

describe("runRoutine same-run fallback", () => {
  test("codex out-of-credits then claude success; TOML stays codex", async () => {
    const codex = stub(
      join(home, "codex-bin"),
      [
        "#!/bin/sh",
        `printf '%s\\n' ${JSON.stringify(CODEX_LIMIT)} >&2`,
        "exit 1",
        "",
      ].join("\n"),
    );
    const claude = stub(
      join(home, "claude-bin"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'demo 2026-07-18T00:00:00Z ok GREEN findings=0'",
        "exit 0",
        "",
      ].join("\n"),
    );
    process.env.ROUTINES_CODEX_BIN = codex;
    process.env.ROUTINES_CLAUDE_BIN = claude;
    // Avoid grok if claude somehow fails
    process.env.ROUTINES_GROK_BIN = stub(join(home, "grok-bin"), "#!/bin/sh\nexit 99\n");

    writeFileSync(
      join(home, "registry", "demo.toml"),
      [
        'harness = "codex"',
        'model = "gpt-5.5"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "hello"',
        "timeout_min = 0.5",
      ].join("\n") + "\n",
    );

    // Silent situation + ra
    process.env.ROUTINES_SITUATIONS_CLI = stub(join(home, "sit"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_RA_BIN = stub(join(home, "ra"), "#!/bin/sh\nexit 0\n");

    const entry = loadEntry("demo");
    const result = await runRoutine(entry, { quiet: true, trigger: "scheduled" });

    expect(result.exitCode).toBe(0);
    // Heartbeat ok preferred; some parsers may still land clean noop — either is success.
    expect(["ok", "noop"]).toContain(result.outcome.kind);

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.harness).toBe("claude");
    expect(meta.model).toBe("sonnet");
    expect(meta.usedFallback).toBe(true);
    expect(meta.primaryHarness).toBe("codex");
    expect(Array.isArray(meta.fallbackAttempts)).toBe(true);
    expect(meta.fallbackAttempts.length).toBeGreaterThanOrEqual(2);

    // Registry TOML not rewritten
    const toml = readFileSync(join(home, "registry", "demo.toml"), "utf8");
    expect(toml).toContain('harness = "codex"');
    expect(toml).not.toContain('harness = "claude"');

    // Codex marked outaged for next fire
    expect(isHarnessOutaged("codex")).toBe(true);
  });

  test("non-outage failure does not walk the chain", async () => {
    process.env.ROUTINES_CODEX_BIN = stub(
      join(home, "codex-bin"),
      ["#!/bin/sh", "printf '%s\\n' 'some agent bug exploded'", "exit 1", ""].join("\n"),
    );
    let claudeCalls = 0;
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-bin"),
      [
        "#!/bin/sh",
        `echo called >> ${JSON.stringify(join(home, "claude-called"))}`,
        "exit 0",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(home, "registry", "demo.toml"),
      [
        'harness = "codex"',
        'model = "gpt-5.5"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "hello"',
        "timeout_min = 0.5",
      ].join("\n") + "\n",
    );
    process.env.ROUTINES_ERROR_ESCALATE = "0";

    const result = await runRoutine(loadEntry("demo"), { quiet: true, trigger: "manual" });
    expect(result.exitCode).not.toBe(0);
    // claude must not have been invoked
    try {
      readFileSync(join(home, "claude-called"), "utf8");
      claudeCalls = 1;
    } catch {
      claudeCalls = 0;
    }
    expect(claudeCalls).toBe(0);
  });
});
