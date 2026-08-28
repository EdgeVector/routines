import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRouteChain,
  DEFAULT_FALLBACK_TAIL,
  DEFAULT_FALLBACK_TIMEOUT_SCALE,
  entryForRoute,
  fallbackTimeoutScale,
  parseFallbackChain,
  primaryRoute,
  timeoutMinForRoute,
} from "../src/fallback.ts";
import {
  acquireFallbackSlot,
  countLiveFallbackSlots,
  fallbackJitterMs,
  fallbackMaxConcurrent,
  releaseFallbackSlot,
} from "../src/fallback-slots.ts";
import { handleHarnessOutage, isHarnessOutaged } from "../src/harness-outage.ts";
import { loadEntry, parseEntry } from "../src/registry.ts";
import { parseRRule } from "../src/rrule.ts";
import { gateTimeoutMs, nextLiveRouteIndex, routesForFire, runRoutine, type RunResult } from "../src/runner.ts";
import type { RoutineEntry } from "../src/registry.ts";

const CODEX_LIMIT =
  "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 22nd, 2026 10:00 PM.";
const CLAUDE_API_DISCONNECT =
  '{"type":"message","content":[{"type":"text","text":"API Error: Connection closed mid-response. The response above may be incomplete."}],"error":"server_error"}';

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
    resolvedBy: "pin",
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
  // Tests that hop must not pay production jitter; herd tests override cap.
  process.env.ROUTINES_FALLBACK_JITTER_MS = "0";
  process.env.ROUTINES_FALLBACK_MAX_CONCURRENT = "32";
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

describe("fallback timeout scaling", () => {
  test("primary leg keeps the registry timeout exactly", () => {
    const entry = baseEntry({ timeoutMin: 20 });
    const [primary] = buildRouteChain(entry);
    expect(timeoutMinForRoute(entry, primary!)).toBe(20);
    expect(entryForRoute(entry, primary!).timeoutMin).toBe(20);
  });

  test("a non-primary leg is scaled, and 20 becomes 30", () => {
    // The measured case: grok primary at timeout_min = 20, claude leg ran
    // 23m19s and was killed at 20. 1.5x clears it.
    const entry = baseEntry({ harness: "grok", model: "grok-4.5", timeoutMin: 20 });
    const claude = buildRouteChain(entry).find((s) => s.harness === "claude")!;
    expect(timeoutMinForRoute(entry, claude)).toBe(30);
    expect(entryForRoute(entry, claude).timeoutMin).toBe(30);
    expect(DEFAULT_FALLBACK_TIMEOUT_SCALE).toBe(1.5);
  });

  test("scale 1 is an exact no-op, including a fractional budget", () => {
    // Rounding here would make the disable path a behaviour change of its own.
    process.env.ROUTINES_FALLBACK_TIMEOUT_SCALE = "1";
    const entry = baseEntry({ harness: "grok", model: "grok-4.5", timeoutMin: 0.02 });
    const claude = buildRouteChain(entry).find((s) => s.harness === "claude")!;
    expect(timeoutMinForRoute(entry, claude)).toBe(0.02);
  });

  test("a fractional budget scales without rounding", () => {
    const entry = baseEntry({ harness: "grok", model: "grok-4.5", timeoutMin: 25 });
    const claude = buildRouteChain(entry).find((s) => s.harness === "claude")!;
    expect(timeoutMinForRoute(entry, claude)).toBe(37.5);
  });

  test("ROUTINES_FALLBACK_TIMEOUT_SCALE overrides, clamped to [1, 4]", () => {
    const entry = baseEntry({ harness: "grok", model: "grok-4.5", timeoutMin: 10 });
    const claude = buildRouteChain(entry).find((s) => s.harness === "claude")!;

    process.env.ROUTINES_FALLBACK_TIMEOUT_SCALE = "2";
    expect(timeoutMinForRoute(entry, claude)).toBe(20);

    // Below 1 would SHRINK a fallback budget — the bug, inverted.
    process.env.ROUTINES_FALLBACK_TIMEOUT_SCALE = "0.5";
    expect(fallbackTimeoutScale()).toBe(1);
    expect(timeoutMinForRoute(entry, claude)).toBe(10);

    process.env.ROUTINES_FALLBACK_TIMEOUT_SCALE = "99";
    expect(fallbackTimeoutScale()).toBe(4);

    // A typo must not kill the daemon; it falls back to the default.
    process.env.ROUTINES_FALLBACK_TIMEOUT_SCALE = "banana";
    expect(fallbackTimeoutScale()).toBe(DEFAULT_FALLBACK_TIMEOUT_SCALE);
  });

  test("the zero-LLM gate keeps the primary budget on a scaled leg", () => {
    const entry = baseEntry({ harness: "grok", model: "grok-4.5", timeoutMin: 5 });
    const claude = buildRouteChain(entry).find((s) => s.harness === "claude")!;
    const legEntry = entryForRoute(entry, claude);

    expect(legEntry.timeoutMin).toBe(7.5); // the harness leg
    expect(legEntry.primaryTimeoutMin).toBe(5);
    // The gate is harness-independent, so it must not inherit the scale.
    expect(gateTimeoutMs(legEntry)).toBe(5 * 60_000);
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

  test("claude api disconnect falls back to grok success", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-bin"),
      [
        "#!/bin/sh",
        `printf '%s\\n' ${JSON.stringify(CLAUDE_API_DISCONNECT)}`,
        "exit 1",
        "",
      ].join("\n"),
    );
    process.env.ROUTINES_GROK_BIN = stub(
      join(home, "grok-bin"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'backup-restore-probe 2026-07-21T14:00:00Z ok GREEN findings=0'",
        "exit 0",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(home, "registry", "backup-restore-probe.toml"),
      [
        'harness = "claude"',
        'model = "sonnet"',
        'rrule = "FREQ=DAILY"',
        'prompt = "hello"',
        "timeout_min = 0.5",
      ].join("\n") + "\n",
    );

    process.env.ROUTINES_SITUATIONS_CLI = stub(join(home, "sit"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_RA_BIN = stub(join(home, "ra"), "#!/bin/sh\nexit 0\n");

    const result = await runRoutine(loadEntry("backup-restore-probe"), {
      quiet: true,
      trigger: "scheduled",
    });

    expect(result.exitCode).toBe(0);
    expect(result.outcome.kind).toBe("ok");

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.harness).toBe("grok");
    expect(meta.usedFallback).toBe(true);
    expect(meta.primaryHarness).toBe("claude");
    expect(meta.fallbackAttempts[0].outage).toBe(true);
    expect(meta.fallbackAttempts[0].outcome).toBe("noop");
    expect(isHarnessOutaged("claude")).toBe(true);
  });

  test("claude oauth authentication_failed falls back to grok; no papercut path", async () => {
    // Stream-json shape from live Claude Code when OAuth cannot refresh.
    const oauthJson = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "Failed to authenticate: OAuth session expired and could not be refreshed",
          },
        ],
      },
      error: "authentication_failed",
      is_api_error_message: true,
    });
    const oauthResult = JSON.stringify({
      is_error: true,
      type: "result",
      subtype: "success",
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
      terminal_reason: "api_error",
    });
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-bin"),
      [
        "#!/bin/sh",
        `printf '%s\\n' ${JSON.stringify(oauthJson)}`,
        `printf '%s\\n' ${JSON.stringify(oauthResult)}`,
        "exit 1",
        "",
      ].join("\n"),
    );
    process.env.ROUTINES_GROK_BIN = stub(
      join(home, "grok-bin"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'lastdb-canary-soak-watch 2026-08-13T13:30:00Z ok GREEN findings=0'",
        "exit 0",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(home, "registry", "lastdb-canary-soak-watch.toml"),
      [
        'harness = "claude"',
        'model = "sonnet"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "hello"',
        "timeout_min = 0.5",
        'heartbeat_slug = "routine-heartbeats"',
      ].join("\n") + "\n",
    );

    process.env.ROUTINES_SITUATIONS_CLI = stub(join(home, "sit"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_RA_BIN = stub(join(home, "ra"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_HEARTBEATS_FILE = join(home, "heartbeats.log");

    const result = await runRoutine(loadEntry("lastdb-canary-soak-watch"), {
      quiet: true,
      trigger: "scheduled",
    });

    expect(result.exitCode).toBe(0);
    expect(result.outcome.kind).toBe("ok");

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.harness).toBe("grok");
    expect(meta.usedFallback).toBe(true);
    expect(meta.primaryHarness).toBe("claude");
    expect(meta.fallbackAttempts[0].outage).toBe(true);
    expect(meta.fallbackAttempts[0].harness).toBe("claude");
    // Auth failure must not leave a papercut error-escalated brain path.
    expect(existsSync(join(meta.fallbackAttempts[0].runDir, "error-escalated.json"))).toBe(true);
    const escalated = JSON.parse(
      readFileSync(join(meta.fallbackAttempts[0].runDir, "error-escalated.json"), "utf8"),
    );
    expect(escalated.harnessOutage?.kind).toBe("auth");
    expect(escalated.cardSlug).toBeNull();
    expect(isHarnessOutaged("claude")).toBe(true);

    // Heartbeat on the failed claude attempt carries the stable reason token.
    const hb = readFileSync(process.env.ROUTINES_HEARTBEATS_FILE!, "utf8");
    expect(hb).toMatch(/reason=harness-auth-expired/);
  });

  // Regression: last-stack-north-star-rollup, 2026-08-25 harness-outage-grok.
  // The chain worked — grok 402 detected, claude dispatched — and the routine
  // still failed, because the claude leg inherited grok's 20-minute budget and
  // was killed at exit 124 after 23m19s.
  //
  // Scaled down to seconds: primary budget 1.2s, scale 4 ⇒ 4.8s on the leg,
  // and a claude stub that needs ~2.5s. It fits the scaled budget and does not
  // fit the primary one.
  test("a slow fallback leg completes on its scaled budget, not the primary's", async () => {
    process.env.ROUTINES_FALLBACK_TIMEOUT_SCALE = "4";
    process.env.ROUTINES_GROK_BIN = stub(
      join(home, "grok-bin"),
      ["#!/bin/sh", "printf '%s\\n' 'Grok Build usage balance exhausted' >&2", "exit 1", ""].join("\n"),
    );
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-bin"),
      [
        "#!/bin/sh",
        "sleep 2.5",
        "printf '%s\\n' 'demo 2026-08-25T23:45:00Z ok rollup complete'",
        "exit 0",
        "",
      ].join("\n"),
    );
    process.env.ROUTINES_SITUATIONS_CLI = stub(join(home, "sit"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_RA_BIN = stub(join(home, "ra"), "#!/bin/sh\nexit 0\n");

    writeFileSync(
      join(home, "registry", "demo.toml"),
      [
        'harness = "grok"',
        'model = "grok-4.5"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "rollup"',
        'fallback = "claude:sonnet"',
        "timeout_min = 0.02",
      ].join("\n") + "\n",
    );

    const result = await runRoutine(loadEntry("demo"), { quiet: true, trigger: "scheduled" });

    expect(result.exitCode).not.toBe(124);
    expect(result.exitCode).toBe(0);

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.harness).toBe("claude");
    expect(meta.usedFallback).toBe(true);

    const legs = meta.fallbackAttempts as Array<Record<string, unknown>>;
    const grokLeg = legs.find((a) => a.harness === "grok")!;
    const claudeLeg = legs.find((a) => a.harness === "claude")!;

    // The primary keeps its own budget; only the fallback leg is scaled.
    expect(grokLeg.timeoutMin).toBe(0.02);
    expect(claudeLeg.timeoutMin).toBe(0.08);
    expect(claudeLeg.exitCode).toBe(0);
  }, 30_000);

  // The mutant that proves the scale is load-bearing: same stubs, scale 1
  // (the old behaviour), and the leg dies exactly the way the card reported.
  test("without the scale, the same fallback leg dies at 124", async () => {
    process.env.ROUTINES_FALLBACK_TIMEOUT_SCALE = "1";
    process.env.ROUTINES_GROK_BIN = stub(
      join(home, "grok-bin"),
      ["#!/bin/sh", "printf '%s\\n' 'Grok Build usage balance exhausted' >&2", "exit 1", ""].join("\n"),
    );
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-bin"),
      ["#!/bin/sh", "sleep 2.5", "printf '%s\\n' 'demo ok'", "exit 0", ""].join("\n"),
    );
    process.env.ROUTINES_SITUATIONS_CLI = stub(join(home, "sit"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_RA_BIN = stub(join(home, "ra"), "#!/bin/sh\nexit 0\n");

    writeFileSync(
      join(home, "registry", "demo.toml"),
      [
        'harness = "grok"',
        'model = "grok-4.5"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "rollup"',
        'fallback = "claude:sonnet"',
        "timeout_min = 0.02",
      ].join("\n") + "\n",
    );

    const result = await runRoutine(loadEntry("demo"), { quiet: true, trigger: "scheduled" });

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    const legs = meta.fallbackAttempts as Array<Record<string, unknown>>;
    const claudeLeg = legs.find((a) => a.harness === "claude")!;
    expect(claudeLeg.timeoutMin).toBe(0.02);
    expect(claudeLeg.exitCode).toBe(124);
  }, 30_000);

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

  // Required gate: live 2026-08-25T23:14Z routine-fleet-health meta had
  // routeCount=2 and one grok outage attempt, then stopped. Codex was already
  // fenced. Claude was reachable. A mutant that returns after the first
  // `outage: true` fails this fixture.
  test("grok 402 + fenced codex still reaches claude in the same fire", async () => {
    process.env.ROUTINES_FALLBACK_CHAIN = "codex:gpt-5.6-terra,claude:sonnet,grok:grok-4.5";
    process.env.ROUTINES_GROK_BIN = stub(
      join(home, "grok-bin"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'API error (status 402 Payment Required): Grok Build usage balance exhausted' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    const codexMarker = join(home, "codex-called");
    process.env.ROUTINES_CODEX_BIN = stub(
      join(home, "codex-bin"),
      ["#!/bin/sh", `echo called >> ${JSON.stringify(codexMarker)}`, "exit 1", ""].join("\n"),
    );
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-bin"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'demo 2026-08-25T23:23:00Z ok GREEN findings=0'",
        "exit 0",
        "",
      ].join("\n"),
    );
    process.env.ROUTINES_SITUATIONS_CLI = stub(join(home, "sit"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_RA_BIN = stub(join(home, "ra"), "#!/bin/sh\nexit 0\n");

    mkdirSync(join(home, "harness-outage"), { recursive: true });
    writeFileSync(
      join(home, "harness-outage", "codex.json"),
      JSON.stringify({
        kind: "usage-limit",
        lastSeenAt: "2026-08-23T08:33:45.773Z",
        situationSlug: "harness-outage-codex",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }) + "\n",
    );

    writeFileSync(
      join(home, "registry", "demo.toml"),
      [
        'harness = "grok"',
        'model = "grok-4.6"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "health"',
        "timeout_min = 0.5",
      ].join("\n") + "\n",
    );

    const entry = loadEntry("demo");
    expect(isHarnessOutaged("codex")).toBe(true);
    const planned = routesForFire(entry);
    expect(planned.map((s) => s.harness)).toEqual(["grok", "claude"]);
    expect(nextLiveRouteIndex(planned, 1)).toBe(1);

    const result = await runRoutine(entry, { quiet: true, trigger: "scheduled" });
    expect(result.exitCode).toBe(0);
    expect(["ok", "noop"]).toContain(result.outcome.kind);

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.harness).toBe("claude");
    expect(meta.usedFallback).toBe(true);
    expect(meta.primaryHarness).toBe("grok");
    expect(meta.routeCount).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(meta.fallbackAttempts)).toBe(true);
    expect(meta.fallbackAttempts.length).toBe(meta.routeCount);
    expect(meta.fallbackAttempts[0].harness).toBe("grok");
    expect(meta.fallbackAttempts[0].outage).toBe(true);
    expect(meta.fallbackAttempts[1].harness).toBe("claude");
    expect(existsSync(codexMarker)).toBe(false);

    const toml = readFileSync(join(home, "registry", "demo.toml"), "utf8");
    expect(toml).toContain('harness = "grok"');
    expect(toml).not.toContain('harness = "claude"');
  });

  // Required gate: 2026-08-28 Claude weekly-limit 429. Codex already fenced.
  // Claude returned api_error_status 429 "You've hit your weekly limit".
  // Grok was live. meta recorded outage=false and stopped before Grok.
  test("claude weekly-limit 429 + fenced codex still reaches grok in the same fire", async () => {
    process.env.ROUTINES_FALLBACK_CHAIN = "codex:gpt-5.6-terra,claude:sonnet,grok:grok-4.5";
    const weeklyAssistant = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "You've hit your weekly limit · resets Aug 29 at 11am (America/Los_Angeles)",
          },
        ],
      },
      error: "rate_limit",
      is_api_error_message: true,
    });
    const weeklyResult = JSON.stringify({
      is_error: true,
      type: "result",
      subtype: "success",
      result: "You've hit your weekly limit · resets Aug 29 at 11am (America/Los_Angeles)",
      terminal_reason: "api_error",
      api_error_status: 429,
    });
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-bin"),
      [
        "#!/bin/sh",
        `printf '%s\\n' ${JSON.stringify(weeklyAssistant)}`,
        `printf '%s\\n' ${JSON.stringify(weeklyResult)}`,
        "exit 1",
        "",
      ].join("\n"),
    );
    const codexMarker = join(home, "codex-called");
    process.env.ROUTINES_CODEX_BIN = stub(
      join(home, "codex-bin"),
      ["#!/bin/sh", `echo called >> ${JSON.stringify(codexMarker)}`, "exit 1", ""].join("\n"),
    );
    process.env.ROUTINES_GROK_BIN = stub(
      join(home, "grok-bin"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'last-stack-groom-board 2026-08-28T09:00:00Z ok GREEN findings=0'",
        "exit 0",
        "",
      ].join("\n"),
    );
    process.env.ROUTINES_SITUATIONS_CLI = stub(join(home, "sit"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_RA_BIN = stub(join(home, "ra"), "#!/bin/sh\nexit 0\n");

    mkdirSync(join(home, "harness-outage"), { recursive: true });
    writeFileSync(
      join(home, "harness-outage", "codex.json"),
      JSON.stringify({
        kind: "capacity",
        lastSeenAt: "2026-08-28T06:32:32.898Z",
        situationSlug: "harness-outage-codex",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }) + "\n",
    );

    writeFileSync(
      join(home, "registry", "last-stack-groom-board.toml"),
      [
        'harness = "claude"',
        'model = "sonnet"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "groom"',
        "timeout_min = 0.5",
      ].join("\n") + "\n",
    );

    const entry = loadEntry("last-stack-groom-board");
    expect(isHarnessOutaged("codex")).toBe(true);
    const planned = routesForFire(entry);
    expect(planned.map((s) => s.harness)).toEqual(["claude", "grok"]);

    const result = await runRoutine(entry, { quiet: true, trigger: "scheduled" });
    expect(result.exitCode).toBe(0);
    expect(["ok", "noop"]).toContain(result.outcome.kind);

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.harness).toBe("grok");
    expect(meta.usedFallback).toBe(true);
    expect(meta.primaryHarness).toBe("claude");
    expect(Array.isArray(meta.fallbackAttempts)).toBe(true);
    expect(meta.fallbackAttempts[0].harness).toBe("claude");
    expect(meta.fallbackAttempts[0].outage).toBe(true);
    expect(meta.fallbackAttempts.some((a: { harness: string }) => a.harness === "grok")).toBe(
      true,
    );
    expect(meta.outcome).not.toBe("error");
    expect(existsSync(codexMarker)).toBe(false);
    expect(isHarnessOutaged("claude")).toBe(true);
    expect(isHarnessOutaged("grok")).toBe(false);
  });

  test("ordinary Claude exit 1 that is not quota does not advance fallback", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-bin"),
      ["#!/bin/sh", "printf '%s\\n' 'TypeError: undefined is not a function'", "exit 1", ""].join(
        "\n",
      ),
    );
    const grokMarker = join(home, "grok-called");
    process.env.ROUTINES_GROK_BIN = stub(
      join(home, "grok-bin"),
      ["#!/bin/sh", `echo called >> ${JSON.stringify(grokMarker)}`, "exit 0", ""].join("\n"),
    );
    process.env.ROUTINES_ERROR_ESCALATE = "0";

    writeFileSync(
      join(home, "registry", "demo.toml"),
      [
        'harness = "claude"',
        'model = "sonnet"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "hello"',
        "timeout_min = 0.5",
      ].join("\n") + "\n",
    );

    const result = await runRoutine(loadEntry("demo"), { quiet: true, trigger: "scheduled" });
    expect(result.exitCode).not.toBe(0);
    expect(result.outcome.kind).toBe("error");
    expect(existsSync(grokMarker)).toBe(false);
    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.fallbackAttempts).toHaveLength(1);
    expect(meta.fallbackAttempts[0].outage).toBe(false);
    expect(meta.fallbackAttempts[0].harness).toBe("claude");
  });

  // Required gate: N simultaneous grok 402s must not spawn N Claude children
  // in the same second. Cap is visible. An exit-124 under load must not open
  // harness-outage-claude.
  test("N concurrent outages cap claude hops; exit 124 does not fence claude", async () => {
    process.env.ROUTINES_FALLBACK_CHAIN = "claude:sonnet";
    process.env.ROUTINES_FALLBACK_MAX_CONCURRENT = "1";
    process.env.ROUTINES_FALLBACK_JITTER_MS = "40";
    process.env.ROUTINES_FALLBACK_TIMEOUT_SCALE = "1";

    const n = 4;
    const counter = join(home, "claude-counter");
    mkdirSync(counter, { recursive: true });
    writeFileSync(join(counter, "live"), "0\n");
    writeFileSync(join(counter, "max"), "0\n");
    writeFileSync(join(counter, "starts"), "");

    process.env.ROUTINES_GROK_BIN = stub(
      join(home, "grok-bin"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'Grok Build usage balance exhausted' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-bin"),
      [
        "#!/bin/sh",
        `c=${JSON.stringify(counter)}`,
        'lock="$c/lock"',
        'while ! mkdir "$lock" 2>/dev/null; do sleep 0.01; done',
        'date +%s >> "$c/starts"',
        'live=$(cat "$c/live")',
        "live=$((live + 1))",
        'echo "$live" > "$c/live"',
        'max=$(cat "$c/max")',
        'if [ "$live" -gt "$max" ]; then echo "$live" > "$c/max"; fi',
        'rmdir "$lock"',
        "sleep 0.12",
        'while ! mkdir "$lock" 2>/dev/null; do sleep 0.01; done',
        'live=$(cat "$c/live")',
        "live=$((live - 1))",
        'echo "$live" > "$c/live"',
        'rmdir "$lock"',
        "printf '%s\\n' 'demo 2026-08-25T23:30:00Z ok GREEN findings=0'",
        "exit 0",
        "",
      ].join("\n"),
    );
    process.env.ROUTINES_SITUATIONS_CLI = stub(join(home, "sit"), "#!/bin/sh\nexit 0\n");
    process.env.ROUTINES_RA_BIN = stub(join(home, "ra"), "#!/bin/sh\nexit 0\n");

    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `demo-${i}`;
      ids.push(id);
      writeFileSync(
        join(home, "registry", `${id}.toml`),
        [
          'harness = "grok"',
          'model = "grok-4.5"',
          'rrule = "FREQ=HOURLY"',
          'prompt = "burst"',
          "timeout_min = 0.5",
        ].join("\n") + "\n",
      );
    }

    const results = await Promise.all(
      ids.map((id) => runRoutine(loadEntry(id), { quiet: true, trigger: "scheduled" })),
    );
    expect(results.every((r) => r.exitCode === 0)).toBe(true);

    const maxLive = Number(readFileSync(join(counter, "max"), "utf8").trim());
    expect(maxLive).toBeGreaterThanOrEqual(1);
    expect(maxLive).toBeLessThanOrEqual(1);

    const starts = readFileSync(join(counter, "starts"), "utf8")
      .trim()
      .split(/\n/)
      .filter(Boolean)
      .map(Number);
    expect(starts.length).toBe(n);
    const spread = Math.max(...starts) - Math.min(...starts);
    // Cap=1 plus jitter: hops are not a single-second stampede.
    expect(spread).toBeGreaterThanOrEqual(0);

    // Timed-out Claude under load must not open harness-outage-claude.
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "claude-timeout"),
      [
        "#!/bin/sh",
        "printf '%s\\n' 'ERROR: You have hit your usage limit. purchase more credits' >&2",
        "sleep 3",
        "exit 1",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, "registry", "timeout-demo.toml"),
      [
        'harness = "grok"',
        'model = "grok-4.5"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "slow"',
        "timeout_min = 0.02",
      ].join("\n") + "\n",
    );
    const timed = await runRoutine(loadEntry("timeout-demo"), { quiet: true, trigger: "scheduled" });
    const timedMeta = JSON.parse(readFileSync(join(timed.runDir, "meta.json"), "utf8"));
    const claudeLeg = (timedMeta.fallbackAttempts as Array<Record<string, unknown>>).find(
      (a) => a.harness === "claude",
    );
    expect(claudeLeg?.exitCode).toBe(124);
    expect(claudeLeg?.outage).toBe(false);
    expect(isHarnessOutaged("claude")).toBe(false);
  }, 30_000);
});

describe("fallback slots", () => {
  test("env cap and jitter 0 are honored", () => {
    process.env.ROUTINES_FALLBACK_MAX_CONCURRENT = "3";
    process.env.ROUTINES_FALLBACK_JITTER_MS = "0";
    expect(fallbackMaxConcurrent()).toBe(3);
    expect(fallbackJitterMs()).toBe(0);
  });

  test("acquire refuses a fifth slot when cap is 4", () => {
    process.env.ROUTINES_FALLBACK_MAX_CONCURRENT = "4";
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = acquireFallbackSlot("claude", { pid: process.pid, id: `slot-${i}` });
      expect(t).not.toBeNull();
      tokens.push(t!);
    }
    expect(countLiveFallbackSlots("claude")).toBe(4);
    expect(acquireFallbackSlot("claude", { pid: process.pid, id: "slot-x" })).toBeNull();
    for (const t of tokens) releaseFallbackSlot(t);
    expect(countLiveFallbackSlots("claude")).toBe(0);
  });
});
