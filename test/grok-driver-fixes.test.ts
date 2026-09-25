import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { routeRoutine, ActionError } from "../src/actions.ts";
import { parseEntry } from "../src/registry.ts";
import { buildInvocation, filterHarnessEnv } from "../src/adapters.ts";
import { validateModel, ModelValidationError } from "../src/models.ts";

let home: string;
const savedEnv = { ...process.env };

function entry(harness: string, model: string, extra = "") {
  return parseEntry(
    [
      `harness = "${harness}"`,
      `model = "${model}"`,
      'rrule = "FREQ=DAILY"',
      'prompt = "test"',
      extra,
    ].join("\n"),
    "/test/r.toml",
  );
}

beforeEach(() => {
  process.env = { ...savedEnv };
  home = mkdtempSync(join(tmpdir(), "grok-driver-"));
  process.env.ROUTINES_HOME = home;
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(home, { recursive: true, force: true });
});

test("Defect 1: Unknown grok model ID is caught at routing time", () => {
  const e = entry("grok", "grok-build");
  // Write it to disk so routeRoutine can update it
  const tomlPath = join(home, "test.toml");
  writeFileSync(tomlPath, `harness = "grok"\nmodel = "grok-build"\nrrule = "FREQ=DAILY"\nprompt = "test"\n`);

  // Direct validation should fail
  expect(() => validateModel("grok", "grok-build")).toThrow(ModelValidationError);
  expect(() => validateModel("grok", "grok-build")).toThrow(/unknown model/);
});

test("Defect 1: Valid grok model passes validation", () => {
  // Should not throw
  expect(() => validateModel("grok", "grok-4.6")).not.toThrow();
});

test("Defect 1: Route command rejects unknown grok model with clear error", () => {
  const e = entry("grok", "grok-build");
  const tomlPath = join(home, "registry", "test.toml");
  const dir = join(home, "registry");
  try {
    const fs = require("node:fs");
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* dir exists */
  }

  const content = `harness = "grok"\nmodel = "grok-build"\nrrule = "FREQ=DAILY"\nprompt = "test"\n`;
  writeFileSync(tomlPath, content);

  const entryWithPath = parseEntry(content, tomlPath);
  entryWithPath.sourcePath = tomlPath;

  // Routing should fail with validation error
  expect(() => {
    routeRoutine(entryWithPath, { model: "grok-build" });
  }).toThrow(ActionError);
  expect(() => {
    routeRoutine(entryWithPath, { model: "grok-build" });
  }).toThrow(/unknown model/);
});

test("Defect 2: Grok filters Codex-specific environment variables", () => {
  const env: NodeJS.ProcessEnv = {
    HOME: "/home/test",
    CODEX_SANDBOX_WORKSPACE_DIR: "/tmp/codex",
    CODEX_SANDBOX_FALLBACK_DIR: "/tmp/fallback",
    ROUTINES_HOME: "/home/test/.routines",
    PATH: "/usr/bin",
  };

  const filtered = filterHarnessEnv("grok", env);

  // Codex-specific vars should be removed from Grok environment
  expect(filtered.CODEX_SANDBOX_WORKSPACE_DIR).toBeUndefined();
  expect(filtered.CODEX_SANDBOX_FALLBACK_DIR).toBeUndefined();

  // Other vars should survive
  expect(filtered.HOME).toBe("/home/test");
  expect(filtered.ROUTINES_HOME).toBe("/home/test/.routines");
  expect(filtered.PATH).toBe("/usr/bin");
});

test("Defect 2: Non-Grok harnesses do not filter environment", () => {
  const env: NodeJS.ProcessEnv = {
    HOME: "/home/test",
    CODEX_SANDBOX_WORKSPACE_DIR: "/tmp/codex",
    CODEX_SANDBOX_FALLBACK_DIR: "/tmp/fallback",
    ROUTINES_HOME: "/home/test/.routines",
  };

  const filteredClaude = filterHarnessEnv("claude", env);
  const filteredCodex = filterHarnessEnv("codex", env);

  // Claude and Codex should not filter these vars
  expect(filteredClaude.CODEX_SANDBOX_WORKSPACE_DIR).toBe("/tmp/codex");
  expect(filteredCodex.CODEX_SANDBOX_WORKSPACE_DIR).toBe("/tmp/codex");
});

test("Defect 3: Grok adapter still builds invocation with valid model", () => {
  const e = entry("grok", "grok-4.6");
  const inv = buildInvocation(e, "test prompt");

  expect(inv.bin).toBe("grok");
  expect(inv.args).toContain("-m");
  expect(inv.args).toContain("grok-4.6");
  expect(inv.args).toContain("--always-approve");
  expect(inv.args).toContain("--output-format");
  expect(inv.args).toContain("streaming-json");
});

test("Fixture: Model validation happens before harness spawn (pre-flight check)", () => {
  // When a routine with grok-build is loaded, validation should catch it
  // before the runner tries to spawn the grok binary
  const invalidGrokEntry = entry("grok", "grok-build");

  expect(() => validateModel(invalidGrokEntry.harness, invalidGrokEntry.model)).toThrow();

  // With valid model, no error
  const validGrokEntry = entry("grok", "grok-4.6");
  expect(() => validateModel(validGrokEntry.harness, validGrokEntry.model)).not.toThrow();
});
