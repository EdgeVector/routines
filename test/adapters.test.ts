import { afterEach, describe, expect, test } from "bun:test";

import { buildInvocation, harnessBinary } from "../src/adapters.ts";
import { parseEntry } from "../src/registry.ts";

function entry(harness: string, extra = "") {
  return parseEntry(
    [`harness = "${harness}"`, 'model = "m1"', 'rrule = "FREQ=DAILY"', 'prompt = "hello"', extra].join("\n"),
    "/x/r.toml",
  );
}

afterEach(() => {
  delete process.env.ROUTINES_CLAUDE_BIN;
  delete process.env.ROUTINES_CODEX_BIN;
});

describe("buildInvocation", () => {
  test("claude adapter shape", () => {
    const inv = buildInvocation(entry("claude"), "hello");
    expect(inv.bin).toBe("claude");
    expect(inv.args).toEqual([
      "-p",
      "--verbose",
      "--model",
      "m1",
      "--output-format",
      "stream-json",
      "hello",
    ]);
  });

  test("codex adapter shape with effort (flags before prompt)", () => {
    const inv = buildInvocation(entry("codex", 'effort = "high"'), "hello");
    expect(inv.bin).toBe("codex");
    expect(inv.args).toEqual([
      "exec",
      "--model",
      "m1",
      "--skip-git-repo-check",
      "--ephemeral",
      "-c",
      'model_reasoning_effort="high"',
      "hello",
    ]);
    // Prompt is last so multi-line bodies cannot swallow flags.
    expect(inv.args[inv.args.length - 1]).toBe("hello");
  });

  test("codex without effort omits -c", () => {
    const inv = buildInvocation(entry("codex"), "hi");
    expect(inv.args).toEqual([
      "exec",
      "--model",
      "m1",
      "--skip-git-repo-check",
      "--ephemeral",
      "hi",
    ]);
  });

  test("grok adapter shape (flags before -p prompt)", () => {
    const inv = buildInvocation(entry("grok", 'effort = "high"'), "hello\n## Setup");
    expect(inv.bin).toBe("grok");
    expect(inv.args).toEqual([
      "-m",
      "m1",
      "--always-approve",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "streaming-json",
      "--reasoning-effort",
      "high",
      "-p",
      "hello\n## Setup",
    ]);
    expect(inv.args[inv.args.length - 2]).toBe("-p");
  });

  test("binary override via env", () => {
    process.env.ROUTINES_CLAUDE_BIN = "/tmp/stub-claude";
    process.env.ROUTINES_GROK_BIN = "/tmp/stub-grok";
    expect(harnessBinary("claude")).toBe("/tmp/stub-claude");
    expect(harnessBinary("grok")).toBe("/tmp/stub-grok");
    expect(buildInvocation(entry("claude"), "hello").bin).toBe("/tmp/stub-claude");
  });

  test("large prompt is elided in display", () => {
    const big = "x".repeat(500);
    const inv = buildInvocation(entry("claude"), big);
    expect(inv.display).toContain("<prompt:500 chars>");
    expect(inv.display).not.toContain(big);
  });
});
