import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.ts";

let home: string;
let binDir: string;
let stubSituations: string;
let oldHome: string | undefined;
let oldSituations: string | undefined;

beforeEach(() => {
  oldHome = process.env.ROUTINES_HOME;
  oldSituations = process.env.ROUTINES_FSITUATIONS_BIN;

  home = mkdtempSync(join(tmpdir(), "routines-cli-"));
  binDir = mkdtempSync(join(tmpdir(), "routines-cli-bins-"));
  stubSituations = join(binDir, "stub-fsituations");
  writeFileSync(stubSituations, "#!/bin/sh\necho '[]'\n");
  chmodSync(stubSituations, 0o755);

  process.env.ROUTINES_HOME = home;
  process.env.ROUTINES_FSITUATIONS_BIN = stubSituations;

  const reg = join(home, "registry");
  mkdirSync(reg, { recursive: true });
  writeFileSync(
    join(reg, "alpha.toml"),
    [
      'harness = "codex"',
      'model = "gpt-5"',
      'rrule = "FREQ=HOURLY"',
      'prompt = "hello alpha"',
      `cwd = "${home}"`,
      "timeout_min = 5",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.ROUTINES_HOME;
  else process.env.ROUTINES_HOME = oldHome;
  if (oldSituations === undefined) delete process.env.ROUTINES_FSITUATIONS_BIN;
  else process.env.ROUTINES_FSITUATIONS_BIN = oldSituations;
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test("status --json keeps rows and entries for stale jq consumers", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown, ...rest: unknown[]) => {
    logs.push([value, ...rest].map(String).join(" "));
  };
  try {
    const code = await main(["status", "--json"]);
    expect(code).toBe(0);
  } finally {
    console.log = originalLog;
  }

  const parsed = JSON.parse(logs.join("\n"));
  expect(parsed.rows.map((r: any) => r.id)).toEqual(["alpha"]);
  expect(parsed.entries.map((r: any) => r.id)).toEqual(["alpha"]);
  expect(parsed.entries).toEqual(parsed.rows);
});
