import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.ts";
import {
  isHarnessOutaged,
  outageSituationSlug,
  readOutageState,
  reportExternalHarnessOutage,
  type ExternalReportOptions,
} from "../src/harness-outage.ts";

/** Real Grok CLI 402 stderr (2026-08-18). The external-caller outage shape. */
const GROK_BALANCE_STDERR =
  'Error: Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}';

/** Situation echo. classifyHarnessOutage must not treat this as a fresh outage. */
const GROK_SITUATION_ECHO =
  '{"slug":"harness-outage-grok","summary":"The grok harness is out of service (usage-limit); evidence: \\"API error (status 402 Payment Required): Grok Build usage balance exhausted\\". Filed by routinesd harness-outage; Tom paged via Telegram."}';

const NOW_MS = Date.parse("2026-10-02T12:00:00Z");

let home: string;
const prevHome = process.env.ROUTINES_HOME;
const prevSituations = process.env.ROUTINES_SITUATIONS_CLI;
const prevFsituations = process.env.ROUTINES_FSITUATIONS_BIN;
const prevRa = process.env.ROUTINES_RA_BIN;

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

/** Stub binary that records argv + stdin and exits with the given code. */
function stubBin(name: string, exitCode = 0): { bin: string; argsFile: string; stdinFile: string } {
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
exit ${exitCode}
`,
  );
  spawnSync("chmod", ["+x", bin]);
  return { bin, argsFile, stdinFile };
}

function reportOpts(
  situationsBin: string,
  raBin: string,
  extra: ExternalReportOptions = {},
): ExternalReportOptions {
  return {
    nowMs: NOW_MS,
    situationsBin,
    raBin,
    quiet: true,
    ...extra,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "routines-report-failure-"));
  process.env.ROUTINES_HOME = home;
  // A forgotten stub must fail closed. It must not call the real CLIs.
  process.env.ROUTINES_SITUATIONS_CLI = join(home, "bin", "situations-not-used");
  process.env.ROUTINES_RA_BIN = join(home, "bin", "ra-not-used");
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.ROUTINES_HOME;
  else process.env.ROUTINES_HOME = prevHome;
  if (prevSituations === undefined) delete process.env.ROUTINES_SITUATIONS_CLI;
  else process.env.ROUTINES_SITUATIONS_CLI = prevSituations;
  if (prevFsituations === undefined) delete process.env.ROUTINES_FSITUATIONS_BIN;
  else process.env.ROUTINES_FSITUATIONS_BIN = prevFsituations;
  if (prevRa === undefined) delete process.env.ROUTINES_RA_BIN;
  else process.env.ROUTINES_RA_BIN = prevRa;
  rmSync(home, { recursive: true, force: true });
});

describe("reportExternalHarnessOutage", () => {
  test("grok 402 files the same harness-outage Situation the fence reads", () => {
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    writeRegistryEntry("loom-pickup-grok", "grok");
    writeRegistryEntry("claude-only", "claude");

    const report = reportExternalHarnessOutage(
      "grok",
      GROK_BALANCE_STDERR,
      reportOpts(situations.bin, ra.bin, { requestId: "loom-canary-heal" }),
    );

    expect(report.matched).toBe(true);
    expect(report.reported).toBe(true);
    expect(report.kind).toBe("usage-limit");
    expect(report.provider).toBe("grok");
    expect(report.situationSlug).toBe(outageSituationSlug("grok"));
    expect(report.evidence).toContain("usage balance exhausted");
    expect(report.requestId).toBe("loom-canary-heal");
    expect(report.detail).toContain("harness-outage:usage-limit");

    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.slug).toBe("harness-outage-grok");
    expect(sit.status).toBe("active");
    expect(sit.severity).toBe("p1");
    expect(sit.scope_systems).toEqual(["harness:grok"]);
    expect(sit.scope_routines).toEqual(["loom-pickup-grok"]);
    expect(sit.scope_routines).not.toContain("claude-only");
    expect(sit.summary).toContain("external-loom-canary-heal");
    expect(sit.summary).toContain("usage balance exhausted");
    expect(sit.requires_human_clearance).toEqual([]);

    const state = readOutageState("grok");
    expect(state?.kind).toBe("usage-limit");
    expect(state?.situationSlug).toBe("harness-outage-grok");
    expect(isHarnessOutaged("grok", NOW_MS)).toBe(true);

    const crumb = JSON.parse(
      readFileSync(join(home, "harness-outage", "reports", "grok", "error-escalated.json"), "utf8"),
    );
    expect(crumb.cardSlug).toBeNull();
    expect(crumb.agentDispatched).toBe(false);
    expect(crumb.harnessOutage.situationSlug).toBe("harness-outage-grok");

    const raArgs = readFileSync(ra.argsFile, "utf8");
    expect(raArgs).toContain("notify");
    expect(raArgs).toContain("high");
  });

  test("a 402 still matches when the log also quotes a ROUTINE_RESULT trailer", () => {
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    const evidence = `${GROK_BALANCE_STDERR}\nROUTINE_RESULT outcome=error detail=provider failed\n`;
    const report = reportExternalHarnessOutage("grok", evidence, reportOpts(situations.bin, ra.bin));
    expect(report.matched).toBe(true);
    expect(report.reported).toBe(true);
    expect(report.kind).toBe("usage-limit");
  });

  test("claude 401 files harness-outage-claude and does not fence grok", () => {
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    const report = reportExternalHarnessOutage(
      "claude",
      "Error: 401 Unauthorized",
      reportOpts(situations.bin, ra.bin),
    );
    expect(report.matched).toBe(true);
    expect(report.kind).toBe("auth");
    expect(report.situationSlug).toBe("harness-outage-claude");
    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.slug).toBe("harness-outage-claude");
    expect(readOutageState("grok")).toBeNull();
  });

  test("an unrelated failure does not file a Situation", () => {
    const situations = stubBin("situations-stub", 1);
    const ra = stubBin("ra-stub", 1);
    const report = reportExternalHarnessOutage(
      "grok",
      "TypeError: undefined is not a function",
      reportOpts(situations.bin, ra.bin),
    );
    expect(report.matched).toBe(false);
    expect(report.reported).toBe(false);
    expect(report.kind).toBeNull();
    expect(report.situationSlug).toBeNull();
    expect(report.detail).toBe("not a recognized harness outage");
    expect(existsSync(situations.argsFile)).toBe(false);
    expect(existsSync(ra.argsFile)).toBe(false);
    expect(readOutageState("grok")).toBeNull();
    expect(isHarnessOutaged("grok", NOW_MS)).toBe(false);
  });

  test("a Situation echo of a grok 402 does not re-file the fence", () => {
    const situations = stubBin("situations-stub", 1);
    const ra = stubBin("ra-stub", 1);
    const report = reportExternalHarnessOutage(
      "grok",
      GROK_SITUATION_ECHO,
      reportOpts(situations.bin, ra.bin),
    );
    expect(report.matched).toBe(false);
    expect(report.reported).toBe(false);
    expect(existsSync(situations.argsFile)).toBe(false);
  });

  test("a second report inside the refresh window does not upsert or page again", () => {
    const situations = stubBin("situations-stub");
    const ra = stubBin("ra-stub");
    const first = reportExternalHarnessOutage(
      "grok",
      GROK_BALANCE_STDERR,
      reportOpts(situations.bin, ra.bin),
    );
    expect(first.reported).toBe(true);

    const again = reportExternalHarnessOutage(
      "grok",
      GROK_BALANCE_STDERR,
      reportOpts(situations.bin, ra.bin, { nowMs: NOW_MS + 60_000 }),
    );
    expect(again.matched).toBe(true);
    expect(again.reported).toBe(true);
    expect(again.detail).toContain("fresh");
    expect(again.detail).toContain("cooldown");

    const sitCalls = readFileSync(situations.argsFile, "utf8").match(/----/g)?.length ?? 0;
    const raCalls = readFileSync(ra.argsFile, "utf8").match(/----/g)?.length ?? 0;
    expect(sitCalls).toBe(1);
    expect(raCalls).toBe(1);
  });

  test("a situations failure stays best-effort: matched, not reported, no throw", () => {
    const situations = stubBin("situations-stub", 1);
    const ra = stubBin("ra-stub");
    const report = reportExternalHarnessOutage(
      "grok",
      GROK_BALANCE_STDERR,
      reportOpts(situations.bin, ra.bin),
    );
    expect(report.matched).toBe(true);
    expect(report.reported).toBe(false);
    expect(report.situationSlug).toBe("harness-outage-grok");
    expect(report.detail).toContain("situation FAILED");
  });
});

describe("routines agent-exec report-failure", () => {
  async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (value?: unknown, ...rest: unknown[]) => {
      stdout.push([value, ...rest].map(String).join(" "));
    };
    console.error = (value?: unknown, ...rest: unknown[]) => {
      stderr.push([value, ...rest].map(String).join(" "));
    };
    try {
      const code = await main(args);
      return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  test("help names the report-failure verb", async () => {
    const res = await run(["help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("report-failure");
    expect(res.stdout).toContain("harness-outage-<p>");
  });

  test("usage errors exit 2 and do not file a Situation", async () => {
    const situations = stubBin("situations-stub", 1);
    process.env.ROUTINES_SITUATIONS_CLI = situations.bin;
    const cases = [
      ["agent-exec", "report-failure"],
      ["agent-exec", "report-failure", "--provider", "grok"],
      ["agent-exec", "report-failure", "--provider", "nope", "--evidence", GROK_BALANCE_STDERR],
      ["agent-exec", "report-failure", "--provider", "grok", "--evidence", "   "],
    ];
    for (const args of cases) {
      const res = await run(args);
      expect(res.code).toBe(2);
      expect(res.stderr.length).toBeGreaterThan(0);
    }
    expect(existsSync(situations.argsFile)).toBe(false);
  });

  test("loom-canary-heal: a 402 reports, an unrelated failure does not", async () => {
    const situations = stubBin("situations-canary");
    const ra = stubBin("ra-canary");
    process.env.ROUTINES_SITUATIONS_CLI = situations.bin;
    process.env.ROUTINES_RA_BIN = ra.bin;
    writeRegistryEntry("loom-pickup-grok", "grok");

    const hit = await run([
      "agent-exec",
      "report-failure",
      "--provider",
      "grok",
      "--request-id",
      "loom-canary-heal",
      "--evidence",
      GROK_BALANCE_STDERR,
    ]);
    expect(hit.code).toBe(0);
    const hitJson = JSON.parse(hit.stdout);
    expect(hitJson.matched).toBe(true);
    expect(hitJson.reported).toBe(true);
    expect(hitJson.situationSlug).toBe("harness-outage-grok");
    expect(hitJson.kind).toBe("usage-limit");
    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.slug).toBe("harness-outage-grok");
    expect(sit.summary).toContain("external-loom-canary-heal");

    const miss = await run([
      "agent-exec",
      "report-failure",
      "--provider",
      "grok",
      "--request-id",
      "loom-canary-heal",
      "--evidence",
      "TypeError: undefined is not a function",
    ]);
    expect(miss.code).toBe(0);
    const missJson = JSON.parse(miss.stdout);
    expect(missJson.matched).toBe(false);
    expect(missJson.reported).toBe(false);
    // The no-op must not upsert again. One put, from the 402 above.
    const sitCalls = readFileSync(situations.argsFile, "utf8").match(/----/g)?.length ?? 0;
    expect(sitCalls).toBe(1);
  });

  test("land-card IMPLEMENT: a 402 reports, a build failure does not", async () => {
    const situations = stubBin("situations-land");
    const ra = stubBin("ra-land");
    process.env.ROUTINES_SITUATIONS_CLI = situations.bin;
    process.env.ROUTINES_RA_BIN = ra.bin;

    const miss = await run([
      "agent-exec",
      "report-failure",
      "--provider",
      "grok",
      "--request-id",
      "land-card-implement",
      "--evidence",
      "error: cannot find module './missing-card'",
    ]);
    expect(miss.code).toBe(0);
    expect(JSON.parse(miss.stdout).matched).toBe(false);
    expect(existsSync(situations.argsFile)).toBe(false);

    const hit = await run([
      "agent-exec",
      "report-failure",
      "--provider",
      "grok",
      "--request-id",
      "land-card-implement",
      "--evidence",
      "API error (status 402 Payment Required): Grok Build usage balance exhausted",
    ]);
    expect(hit.code).toBe(0);
    const hitJson = JSON.parse(hit.stdout);
    expect(hitJson.matched).toBe(true);
    expect(hitJson.reported).toBe(true);
    expect(hitJson.situationSlug).toBe("harness-outage-grok");
    expect(hitJson.requestId).toBe("land-card-implement");
    const sit = JSON.parse(readFileSync(situations.stdinFile, "utf8"));
    expect(sit.slug).toBe("harness-outage-grok");
    expect(sit.summary).toContain("external-land-card-implement");
  });

  test("a situations failure still exits 0", async () => {
    const situations = stubBin("situations-down", 1);
    const ra = stubBin("ra-down");
    process.env.ROUTINES_SITUATIONS_CLI = situations.bin;
    process.env.ROUTINES_RA_BIN = ra.bin;
    const res = await run([
      "agent-exec",
      "report-failure",
      "--provider",
      "grok",
      "--evidence",
      GROK_BALANCE_STDERR,
    ]);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout);
    expect(json.matched).toBe(true);
    expect(json.reported).toBe(false);
    expect(json.detail).toContain("situation FAILED");
  });
});
