import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escalateRoutineError } from "../src/error-escalate.ts";
import {
  classifyHarnessOutage,
  handleHarnessOutage,
  isHarnessOutaged,
  outageSituationSlug,
  parseResetHint,
  reconcileOutageFences,
} from "../src/harness-outage.ts";
import type { RoutineEntry } from "../src/registry.ts";
import type { RunResult } from "../src/runner.ts";
import { parseRRule } from "../src/rrule.ts";

const CODEX_LIMIT_LINE =
  "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 22nd, 2026 10:00 PM.";
const CODEX_CAPACITY_LINE =
  "ERROR: Selected model is at capacity. Please try a different model.";
const CLAUDE_API_DISCONNECT_LINE =
  '{"type":"message","content":[{"type":"text","text":"API Error: Connection closed mid-response. The response above may be incomplete."}],"error":"server_error"}';
/** Real Claude Code stream-json OAuth expiry (2026-08-13 backup-restore-probe). */
const CLAUDE_OAUTH_EXPIRED_LINE =
  '{"type":"assistant","message":{"id":"eab9de6e-883b-48a1-b91e-fb550016a533","model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"Failed to authenticate: OAuth session expired and could not be refreshed"}]},"error":"authentication_failed","is_api_error_message":true}';
const CLAUDE_OAUTH_RESULT_LINE =
  '{"is_error":true,"type":"result","subtype":"success","result":"Failed to authenticate: OAuth session expired and could not be refreshed","terminal_reason":"api_error"}';
/** Real Grok CLI 402 stderr (2026-08-18 lastdb-canary-soak-watch, 12 fires misclassified). */
const GROK_BALANCE_STDERR =
  'Error: Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}';
/** Same failure as the grok CLI's streaming-json stdout one-liner. */
const GROK_BALANCE_STDOUT_LINE =
  '{"type":"error","message":"Internal error: {\\n  \\"message\\": \\"API error (status 402 Payment Required): Grok Build usage balance exhausted\\",\\n  \\"http_status\\": 402\\n}"}';
/** Real Claude Code weekly-limit 429 (2026-08-28 last-stack-groom-board). */
const CLAUDE_WEEKLY_LIMIT_ASSISTANT =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"You\'ve hit your weekly limit · resets Aug 29 at 11am (America/Los_Angeles)"}]},"error":"rate_limit","is_api_error_message":true}';
const CLAUDE_WEEKLY_LIMIT_RESULT =
  '{"is_error":true,"type":"result","subtype":"success","result":"You\'ve hit your weekly limit · resets Aug 29 at 11am (America/Los_Angeles)","terminal_reason":"api_error","api_error_status":429}';
/**
 * Real sentry-triage transcript (2026-09-06T15:25Z). SENTRY's API returned 401;
 * the routine finished, wrote `outcome.txt`, and its own summary line matched
 * AUTH_PATTERNS — which fenced codex fleet-wide for every routine.
 */
const SENTRY_401_TRANSCRIPT = [
  "curl: received 401: Unauthorized on the first project request.",
  "The keychain token is unavailable or invalid, so I will not file cards.",
  "No issue triage occurred because Sentry authentication failed.",
].join("\n");
/**
 * Real dogfood-onboarding transcript (2026-09-06T18:01Z): the routine listed
 * Situations and read back the 17:20Z heal notice, re-fencing codex 42 minutes
 * after a human-cleared false fence.
 */
const HEAL_NOTICE_READBACK =
  "Fleet dispatch restored: false codex harness fence cleared — 2026-09-06T17:20Z: " +
  "a live probe returned PROBE_OK; the arming evidence was \"You've hit your usage limit\" " +
  "quoted from the prior notice.";
const CLAUDE_TRANSIENT_429 =
  '{"is_error":true,"type":"result","result":"Too many requests","terminal_reason":"api_error","api_error_status":429}';

let home: string;
const prevHome = process.env.ROUTINES_HOME;

function entry(id = "last-stack-pipeline-health", harness: "codex" | "claude" = "codex"): RoutineEntry {
  return {
    id,
    harness,
    model: harness === "codex" ? "gpt-5.5" : "opus",
    resolvedBy: "pin",
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

  test("grok 402 usage-balance-exhausted stderr classifies as usage-limit", () => {
    const out = classifyHarnessOutage(result(GROK_BALANCE_STDERR));
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("usage-limit");
    expect(out!.evidence).toContain("usage balance exhausted");
  });

  test("grok 402 streaming-json stdout line classifies as usage-limit", () => {
    // Whole line is JSON — the billing boost must outweigh the JSON demotion.
    const out = classifyHarnessOutage(result(GROK_BALANCE_STDOUT_LINE));
    expect(out?.kind).toBe("usage-limit");
  });

  test("claude weekly-limit 429 stdout classifies as usage-limit", () => {
    const r = result("");
    writeFileSync(
      join(r.runDir, "stdout.log"),
      `${CLAUDE_WEEKLY_LIMIT_ASSISTANT}\n${CLAUDE_WEEKLY_LIMIT_RESULT}\n`,
    );
    const out = classifyHarnessOutage(r, { nowMs: Date.parse("2026-08-28T09:00:00Z") });
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("usage-limit");
    expect(out!.evidence.toLowerCase()).toContain("weekly limit");
    expect(out!.resetHint).toMatch(/Aug 29 at 11am/i);
    expect(out!.resetAt).toBe("2026-08-29T18:00:00.000Z");
  });

  test("claude weekly-limit result line alone classifies as usage-limit", () => {
    const r = result("");
    writeFileSync(join(r.runDir, "stdout.log"), `${CLAUDE_WEEKLY_LIMIT_RESULT}\n`);
    const out = classifyHarnessOutage(r);
    expect(out?.kind).toBe("usage-limit");
  });

  test("ordinary Claude 429 without weekly-limit is not an outage", () => {
    const r = result("");
    writeFileSync(join(r.runDir, "stdout.log"), `${CLAUDE_TRANSIENT_429}\n`);
    expect(classifyHarnessOutage(r)).toBeNull();
  });

  test("ignores claude weekly-limit text quoted inside a filed Situation summary", () => {
    const quoted =
      '{"slug":"harness-outage-claude","summary":"The claude harness is out of service (usage-limit); evidence: \\"You\'ve hit your weekly limit · resets Aug 29 at 11am (America/Los_Angeles)\\". Filed by routinesd harness-outage; Tom paged via Telegram."}';
    expect(classifyHarnessOutage(result(quoted))).toBeNull();
  });

  test("ignores grok 402 text quoted inside a filed Situation summary", () => {
    const quoted =
      '{"slug":"harness-outage-grok","summary":"The grok harness is out of service (usage-limit); evidence: \\"API error (status 402 Payment Required): Grok Build usage balance exhausted\\". Filed by routinesd harness-outage; Tom paged via Telegram."}';
    expect(classifyHarnessOutage(result(quoted))).toBeNull();
  });

  // 2026-09-06: two false codex fences in one day, both from runs that had
  // finished their work and written an outcome sink. A dead harness cannot
  // produce a routine-authored verdict, so those lines were never about codex.
  test("a routine-authored sink verdict is never a harness outage (sentry 401)", () => {
    const r = result(SENTRY_401_TRANSCRIPT);
    r.outcome = {
      kind: "error",
      detail: "sentry_api_401 auth_ref=keychain://sentry-auth-token/edge-vector cards=0",
      source: "sink",
    };
    expect(classifyHarnessOutage(r)).toBeNull();
  });

  test("a routine reading back a heal notice cannot re-fence the harness", () => {
    const r = result(HEAL_NOTICE_READBACK);
    r.outcome = {
      kind: "error",
      detail: "required routine contract returned no data; no DEV probe action ran",
      source: "sink",
    };
    expect(classifyHarnessOutage(r)).toBeNull();
  });

  test("a ROUTINE_RESULT trailer also proves the harness ran", () => {
    const r = result(SENTRY_401_TRANSCRIPT);
    r.outcome = { kind: "error", detail: "sentry_api_401", source: "routine_result" };
    expect(classifyHarnessOutage(r)).toBeNull();
  });

  // The guard must not blunt a real outage: a dead harness leaves no
  // routine-authored verdict, so the source stays exit/none and it still fences.
  test("real codex usage limit with no sink still classifies", () => {
    const r = result(CODEX_LIMIT_LINE);
    expect(r.outcome.source).toBe("exit");
    expect(classifyHarnessOutage(r)?.kind).toBe("usage-limit");
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

  test("claude oauth session expired stream-json classifies as auth", () => {
    // Must match even when the entire line is JSON (demotion outweighed by auth boost).
    const out = classifyHarnessOutage(
      result(`${CLAUDE_OAUTH_EXPIRED_LINE}\n${CLAUDE_OAUTH_RESULT_LINE}`),
    );
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("auth");
    expect(out!.evidence.toLowerCase()).toMatch(
      /authentication_failed|oauth session expired|failed to authenticate/,
    );
  });

  test("authentication_failed underscore token classifies as auth", () => {
    const out = classifyHarnessOutage(result("error: authentication_failed"));
    expect(out?.kind).toBe("auth");
  });

  test("claude api disconnect classifies as transient", () => {
    const out = classifyHarnessOutage(result(CLAUDE_API_DISCONNECT_LINE));
    expect(out?.kind).toBe("transient");
    expect(out?.evidence).toContain("Connection closed mid-response");
  });

  test("ordinary failure is not an outage", () => {
    expect(classifyHarnessOutage(result("TypeError: undefined is not a function"))).toBeNull();
    expect(classifyHarnessOutage(result(""))).toBeNull();
  });

  test("exit 124 / timedOut is retry-later, even when logs quote a usage-limit", () => {
    const timed = result(CODEX_LIMIT_LINE);
    timed.timedOut = true;
    timed.exitCode = 124;
    timed.outcome = { kind: "error", detail: "timed out", source: "exit" };
    expect(classifyHarnessOutage(timed)).toBeNull();

    const exitOnly = result(GROK_BALANCE_STDERR);
    exitOnly.timedOut = false;
    exitOnly.exitCode = 124;
    expect(classifyHarnessOutage(exitOnly)).toBeNull();
  });

  test("ignores capacity text inside Situation JSON quotes (false-positive loop)", () => {
    // Agents dump `situations list` into logs; that embeds the capacity phrase
    // without being a real harness failure.
    const quoted =
      '{"slug":"harness-outage-claude","summary":"The claude harness is out of service (capacity); evidence: \\"ERROR: Selected model is at capacity. Please try a different model.\\". Filed by routinesd harness-outage; Tom paged via Telegram."}';
    expect(classifyHarnessOutage(result(quoted))).toBeNull();
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

  test("parses Claude weekly-limit resets hint in America/Los_Angeles", () => {
    const { hint, iso } = parseResetHint(
      "You've hit your weekly limit · resets Aug 29 at 11am (America/Los_Angeles)",
      Date.parse("2026-08-28T09:00:00Z"),
    );
    expect(hint).toBe("Aug 29 at 11am (America/Los_Angeles)");
    expect(iso).toBe("2026-08-29T18:00:00.000Z");
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

  test("claude weekly-limit posts a Claude Situation and does not fence Grok", () => {
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    writeRegistryEntry("last-stack-groom-board", "claude");
    const r = result("");
    writeFileSync(
      join(r.runDir, "stdout.log"),
      `${CLAUDE_WEEKLY_LIMIT_ASSISTANT}\n${CLAUDE_WEEKLY_LIMIT_RESULT}\n`,
    );
    const nowMs = Date.parse("2026-08-28T09:00:00Z");
    const outage = classifyHarnessOutage(r, { nowMs })!;
    const out = handleHarnessOutage(entry("last-stack-groom-board", "claude"), r, outage, {
      nowMs,
      situationsBin: situations.bin,
      raBin: ra.bin,
      quiet: true,
      fenceRoutines: false,
    });
    expect(out.escalated).toBe(true);
    expect(out.detail).toContain("fence:none-fallback-active");
    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.slug).toBe(outageSituationSlug("claude"));
    expect(sit.scope_routines).toEqual([]);
    expect(sit.blocked_actions).toEqual(["dispatch-claude-agents"]);
    expect(sit.blocked_actions).not.toContain("dispatch-grok-agents");
    expect(sit.expires_at).toBe("2026-08-29T18:00:00.000Z");
  });

  test("claude outage while codex primaries are on fallback fences the whole substituted fleet", () => {
    // Reproduces the live fkanban-pickup incident: every worker's registry
    // declares harness=codex, codex is already outaged, so all of them are
    // silently running on the claude fallback. When claude *also* fails, the
    // Situation must fence every routine currently substituted onto claude —
    // not just the one whose run happened to trip the detector.
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    for (const id of [
      "last-stack-fkanban-pickup-w2",
      "last-stack-fkanban-pickup-w3",
      "last-stack-fkanban-pickup-w4",
      "last-stack-fkanban-pickup-w5",
      "last-stack-fkanban-pickup-w6",
    ]) {
      writeRegistryEntry(id, "codex");
    }

    const nowMs = Date.parse("2026-07-18T02:57:00Z");
    // Codex was already recorded outaged (real capacity incident) with a
    // not-yet-lapsed expiry, so every codex-primary routine's effective route
    // is currently claude.
    mkdirSync(join(home, "harness-outage"), { recursive: true });
    writeFileSync(
      join(home, "harness-outage", "codex.json"),
      JSON.stringify({
        kind: "capacity",
        lastSeenAt: "2026-07-18T00:48:41.017Z",
        situationSlug: outageSituationSlug("codex"),
        expiresAt: "2026-07-18T06:48:41.017Z",
      }),
    );

    // w3's fallback run (harness now "claude" per entryForRoute) also hits
    // capacity — the same-run fallback chain is exhausted.
    const w3ClaudeEntry = entry("last-stack-fkanban-pickup-w3", "claude");
    const out = handleHarnessOutage(
      w3ClaudeEntry,
      result(CODEX_CAPACITY_LINE, "last-stack-fkanban-pickup-w3"),
      classifyHarnessOutage(result(CODEX_CAPACITY_LINE), { nowMs })!,
      { nowMs, situationsBin: situations.bin, raBin: ra.bin, quiet: true },
    );
    expect(out.escalated).toBe(true);

    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.slug).toBe(outageSituationSlug("claude"));
    expect(sit.scope_routines).toEqual([
      "last-stack-fkanban-pickup-w2",
      "last-stack-fkanban-pickup-w3",
      "last-stack-fkanban-pickup-w4",
      "last-stack-fkanban-pickup-w5",
      "last-stack-fkanban-pickup-w6",
    ]);
  });
});

describe("reconcileOutageFences", () => {
  const HOUR = 60 * 60 * 1000;
  const nowMs = Date.parse("2026-09-06T07:00:00.000Z");

  function writeFence(
    harness: string,
    over: Partial<{ slug: string; lastSeenAt: string; lastSituationAt: string; expiresAt: string }> = {},
  ): string {
    const dir = join(home, "harness-outage");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${harness}.json`);
    writeFileSync(
      p,
      JSON.stringify({
        kind: "usage-limit",
        lastSeenAt: over.lastSeenAt ?? new Date(nowMs - HOUR).toISOString(),
        lastSituationAt: over.lastSituationAt ?? new Date(nowMs - HOUR).toISOString(),
        situationSlug: over.slug ?? outageSituationSlug(harness),
        expiresAt: over.expiresAt ?? new Date(nowMs + 5 * HOUR).toISOString(),
      }) + "\n",
    );
    return p;
  }

  // The measured 2026-09-06T07:0xZ divergence: the ledger carried
  // harness-outage-grok and harness-outage-claude and NO harness-outage-codex,
  // while the codex file fenced dispatch. Resolving a Situation must clear the
  // fence it named; the other two must survive untouched.
  test("clears a fence whose Situation is gone and keeps the ones still active", () => {
    const codex = writeFence("codex");
    const grok = writeFence("grok");
    const claude = writeFence("claude");
    expect(isHarnessOutaged("codex", nowMs)).toBe(true);

    const out = reconcileOutageFences(
      [outageSituationSlug("grok"), outageSituationSlug("claude"), "unrelated-situation"],
      { nowMs, quiet: true },
    );

    expect(out.cleared).toEqual(["codex"]);
    expect(existsSync(codex)).toBe(false);
    expect(existsSync(grok)).toBe(true);
    expect(existsSync(claude)).toBe(true);
    expect(isHarnessOutaged("codex", nowMs)).toBe(false);
    expect(isHarnessOutaged("grok", nowMs)).toBe(true);
  });

  // Fails CLOSED: a fresh outage writes the state file and upserts the
  // Situation in one call, so a slug missing from a ledger read taken seconds
  // later is far more likely a failed upsert than a resolved outage.
  test("keeps a fence inside the Situation grace window", () => {
    writeFence("codex", { lastSituationAt: new Date(nowMs - 60_000).toISOString() });
    const out = reconcileOutageFences([], { nowMs, quiet: true });
    expect(out.cleared).toEqual([]);
    expect(out.kept).toEqual([{ harness: "codex", reason: "within-situation-grace" }]);
    expect(isHarnessOutaged("codex", nowMs)).toBe(true);
  });

  test("keeps a fence whose state file records no situationSlug", () => {
    mkdirSync(join(home, "harness-outage"), { recursive: true });
    writeFileSync(
      join(home, "harness-outage", "codex.json"),
      JSON.stringify({ kind: "usage-limit", lastSeenAt: new Date(nowMs - HOUR).toISOString() }) + "\n",
    );
    const out = reconcileOutageFences([], { nowMs, quiet: true });
    expect(out.cleared).toEqual([]);
    expect(out.kept).toEqual([{ harness: "codex", reason: "no-situation-slug" }]);
  });

  test("is a no-op when no fence state exists", () => {
    expect(reconcileOutageFences([], { nowMs, quiet: true })).toEqual({ cleared: [], kept: [] });
  });
});

describe("credential-unreadable (login keychain locked)", () => {
  /** Real Claude Code stream-json 401 (2026-09-06 sentry-triage claude leg, keychain rc=51). */
  const CLAUDE_KEYCHAIN_LOCKED_401 =
    '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":544,"error_status":401,"error":"authentication_failed","session_id":"91a2d014-db7d-48c5-8254-10d44d47ab65","uuid":"6af96840-b3d6-4498-9342-3799c917397d"}';

  function claudeResult(line: string, source: "env" | "lastsecrets" | "keychain-default" | undefined) {
    const r = result(line);
    if (source) r.claudeAuthSource = source;
    return r;
  }

  test("claude 401 with keychain-default source and a refused keychain read", () => {
    const out = classifyHarnessOutage(
      claudeResult(CLAUDE_KEYCHAIN_LOCKED_401, "keychain-default"),
      { keychainReadRefused: () => true },
    );
    expect(out?.kind).toBe("credential-unreadable");
    expect(out?.evidence).toContain("authentication_failed");
  });

  test("same 401 with the keychain readable stays auth (a real expired token)", () => {
    const out = classifyHarnessOutage(
      claudeResult(CLAUDE_KEYCHAIN_LOCKED_401, "keychain-default"),
      { keychainReadRefused: () => false },
    );
    expect(out?.kind).toBe("auth");
  });

  test("same 401 with a LastSecrets-sourced token stays auth even if the keychain is locked", () => {
    // The child never needed the keychain, so a lockout cannot explain the 401.
    const out = classifyHarnessOutage(
      claudeResult(CLAUDE_KEYCHAIN_LOCKED_401, "lastsecrets"),
      { keychainReadRefused: () => true },
    );
    expect(out?.kind).toBe("auth");
  });

  test("a result without a claude auth source (codex leg) is never credential-unreadable", () => {
    const out = classifyHarnessOutage(claudeResult("error: authentication_failed", undefined), {
      keychainReadRefused: () => true,
    });
    expect(out?.kind).toBe("auth");
  });

  test("credits exhaustion stays usage-limit, never auth, even with the keychain locked", () => {
    const r = claudeResult(
      `${CLAUDE_WEEKLY_LIMIT_ASSISTANT}\n${CLAUDE_WEEKLY_LIMIT_RESULT}`,
      "keychain-default",
    );
    const out = classifyHarnessOutage(r, {
      nowMs: Date.parse("2026-08-28T09:00:00Z"),
      keychainReadRefused: () => true,
    });
    expect(out?.kind).toBe("usage-limit");
  });

  test("handle keeps the fence and the page, but the remedy names the locator", () => {
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    writeRegistryEntry("last-stack-pipeline-health", "claude");
    const nowMs = Date.parse("2026-09-06T15:29:00Z");
    const r = claudeResult(CLAUDE_KEYCHAIN_LOCKED_401, "keychain-default");
    const outage = classifyHarnessOutage(r, { nowMs, keychainReadRefused: () => true })!;
    expect(outage.kind).toBe("credential-unreadable");

    const res = handleHarnessOutage(entry("last-stack-pipeline-health", "claude"), r, outage, {
      nowMs,
      situationsBin: situations.bin,
      raBin: ra.bin,
      quiet: true,
    });
    expect(res.escalated).toBe(true);

    const verdict = JSON.parse(readFileSync(join(r.runDir, "triage-result.json"), "utf8"));
    expect(verdict.result).toBe("needs-human");
    expect(verdict.rootCause).toBe("harness-outage:credential-unreadable");

    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.slug).toBe(outageSituationSlug("claude"));
    expect(sit.blocked_actions).toEqual(["dispatch-claude-agents"]);
    expect(sit.scope_routines).toEqual(["last-stack-pipeline-health"]);
    expect(sit.summary).toContain("credential-unreadable");
    expect(sit.summary).toContain("lastsecrets://claude-code-oauth-token");
    expect(sit.summary).toContain("login keychain locked");
    expect(sit.preflight_message).toContain("lastsecrets://claude-code-oauth-token");
    expect(sit.preflight_message).not.toContain("restore credits/auth");

    const raArgs = readFileSync(ra.argsFile, "utf8");
    expect(raArgs).toContain("Needs human: claude harness credential-unreadable");
    expect(raArgs).toContain("lastsecrets://claude-code-oauth-token");
    expect(raArgs).not.toContain("/login");
  });

  test("plain auth outage text is unchanged (still says restore credits/auth)", () => {
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    writeRegistryEntry("last-stack-pipeline-health", "claude");
    const nowMs = Date.parse("2026-09-06T15:29:00Z");
    const r = claudeResult(CLAUDE_KEYCHAIN_LOCKED_401, "lastsecrets");
    const outage = classifyHarnessOutage(r, { nowMs, keychainReadRefused: () => true })!;
    expect(outage.kind).toBe("auth");
    handleHarnessOutage(entry("last-stack-pipeline-health", "claude"), r, outage, {
      nowMs,
      situationsBin: situations.bin,
      raBin: ra.bin,
      quiet: true,
    });
    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.preflight_message).toContain("restore credits/auth");
    expect(sit.summary).not.toContain("Remedy:");
  });
});
