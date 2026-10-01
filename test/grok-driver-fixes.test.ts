import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { routeRoutine, ActionError } from "../src/actions.ts";
import { parseEntry } from "../src/registry.ts";
import { buildInvocation, filterHarnessEnv } from "../src/adapters.ts";
import { validateModel, ModelValidationError } from "../src/models.ts";
import { runRoutine } from "../src/runner.ts";

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
    CODEX_THREAD_ID: "thread-abc123",
    ROUTINES_HOME: "/home/test/.routines",
    PATH: "/usr/bin",
  };

  const filtered = filterHarnessEnv("grok", env);

  // Codex-specific vars should be removed from Grok environment
  expect(filtered.CODEX_SANDBOX_WORKSPACE_DIR).toBeUndefined();
  expect(filtered.CODEX_SANDBOX_FALLBACK_DIR).toBeUndefined();
  // papercut-routines-grok-inherits-codex-shell-identity-20260923: this is
  // the variable the papercut's own repro named as the actual trigger — the
  // two CODEX_SANDBOX_* vars above were the first (insufficient) guess.
  expect(filtered.CODEX_THREAD_ID).toBeUndefined();

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
    CODEX_THREAD_ID: "thread-abc123",
    ROUTINES_HOME: "/home/test/.routines",
  };

  const filteredClaude = filterHarnessEnv("claude", env);
  const filteredCodex = filterHarnessEnv("codex", env);

  // Claude and Codex should not filter these vars
  expect(filteredClaude.CODEX_SANDBOX_WORKSPACE_DIR).toBe("/tmp/codex");
  expect(filteredCodex.CODEX_SANDBOX_WORKSPACE_DIR).toBe("/tmp/codex");
  expect(filteredClaude.CODEX_THREAD_ID).toBe("thread-abc123");
  expect(filteredCodex.CODEX_THREAD_ID).toBe("thread-abc123");
});

// papercut-routines-grok-inherits-codex-shell-identity-20260923: the above
// two tests prove the env MAP no longer carries CODEX_THREAD_ID, but the
// original defect was a real shell side effect silently not happening (exit
// 0, no output) when a Grok routine's child process still saw the var. This
// test drives the actual dispatch path (runRoutine -> filterHarnessEnv ->
// spawn) with a stub "grok" binary standing in for the real CLI's reported
// breakage: the stub only writes its probe file when CODEX_THREAD_ID is
// absent from ITS OWN environment, exactly mirroring the papercut's
// echo/file-write repro. If the filter regresses, the probe file silently
// stops appearing, the same way the real symptom silently stopped happening.
test("Defect 2: a Grok routine dispatched from a Codex-parented shell still produces its real side effect", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-e2e-"));
  const probeFile = join(home, "probe.txt");
  const stubPath = join(home, "stub-grok");
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      // Simulate the reported real-world breakage: silently no-op (exit 0,
      // no output, no side effect) if CODEX_THREAD_ID leaked through.
      'if [ -n "$CODEX_THREAD_ID" ]; then exit 0; fi',
      `echo "ran" > ${JSON.stringify(probeFile)}`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(stubPath, 0o755);

  process.env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES = "1";
  process.env.ROUTINES_GROK_BIN = stubPath;
  process.env.ROUTINES_HOME = home;
  // Simulate being dispatched from inside a Codex-parented shell, same as
  // the papercut's original repro.
  process.env.CODEX_THREAD_ID = "thread-parent-codex-session";

  try {
    const e = entry("grok", "grok-4.6");
    e.sourcePath = join(home, "grok-e2e.toml");
    await runRoutine(e, { quiet: true, trigger: "manual" });

    expect(existsSync(probeFile)).toBe(true);
    expect(readFileSync(probeFile, "utf8").trim()).toBe("ran");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

test("Defect 4: every live grok model from `grok models` passes validation", () => {
  // Live roster as of 2026-09-27 (`grok models` on this host): grok-4.7
  // (default), grok-4.7-build-fast, grok-4.6, grok-4.5. Before this fix,
  // KNOWN_MODELS.grok only carried grok-4.6, so the difficulty matrix's own
  // "fast" tier value (grok-4.7-build-fast, set in the live
  // routing-matrix.json) and a re-application of the exact remediation this
  // repo's papercut record documents (`routines route --model
  // grok-4.7-build-fast`) would both be rejected as "unknown model".
  for (const model of ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]) {
    expect(() => validateModel("grok", model)).not.toThrow();
  }
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
