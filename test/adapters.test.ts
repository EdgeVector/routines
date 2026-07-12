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
    expect(inv.args).toEqual(["-p", "hello", "--model", "m1", "--output-format", "stream-json"]);
  });

  test("codex adapter shape with effort", () => {
    const inv = buildInvocation(entry("codex", 'effort = "high"'), "hello");
    expect(inv.bin).toBe("codex");
    expect(inv.args).toEqual(["exec", "hello", "--model", "m1", "--reasoning-effort", "high"]);
  });

  test("binary override via env", () => {
    process.env.ROUTINES_CLAUDE_BIN = "/tmp/stub-claude";
    expect(harnessBinary("claude")).toBe("/tmp/stub-claude");
    expect(buildInvocation(entry("claude"), "hello").bin).toBe("/tmp/stub-claude");
  });

  test("large prompt is elided in display", () => {
    const big = "x".repeat(500);
    const inv = buildInvocation(entry("claude"), big);
    expect(inv.display).toContain("<prompt:500 chars>");
    expect(inv.display).not.toContain(big);
  });
});
