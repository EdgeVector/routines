import { afterEach, describe, expect, test } from "bun:test";

import { homedir } from "node:os";

import { buildInvocation, codexWritableDirs, harnessBinary } from "../src/adapters.ts";
import { parseEntry } from "../src/registry.ts";

function entry(harness: string, extra = "") {
  return parseEntry(
    [`harness = "${harness}"`, 'model = "m1"', 'rrule = "FREQ=DAILY"', 'prompt = "hello"', extra].join("\n"),
    "/x/r.toml",
  );
}

afterEach(() => {
  delete process.env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES;
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
      "--",
      "hello",
    ]);
  });

  test("claude adapter protects YAML frontmatter prompts from option parsing", () => {
    const prompt = "---\nname: x\n---\nDo the thing.";
    const inv = buildInvocation(entry("claude"), prompt);
    expect(inv.args.slice(-2)).toEqual(["--", prompt]);
  });

  test("codex adapter uses stdin for the prompt (dash arg)", () => {
    const inv = buildInvocation(entry("codex", 'effort = "high"'), "hello\n---\nfrontmatter");
    expect(inv.bin).toBe("codex");
    // Prefix is stable; --add-dir list is host-dependent (ROUTINES_HOME/HOME).
    expect(inv.args.slice(0, 5)).toEqual([
      "exec",
      "--model",
      "m1",
      "--skip-git-repo-check",
      "--ephemeral",
    ]);
    expect(inv.args).toContain("--add-dir");
    expect(inv.args.at(-3)).toBe("-c");
    expect(inv.args.at(-2)).toBe('model_reasoning_effort="high"');
    expect(inv.args.at(-1)).toBe("-");
    expect(inv.stdin).toBe("hello\n---\nfrontmatter");
    expect(inv.display).toContain("prompt-stdin");
  });

  test("codex without effort omits -c", () => {
    const inv = buildInvocation(entry("codex"), "hi");
    expect(inv.args.slice(0, 5)).toEqual([
      "exec",
      "--model",
      "m1",
      "--skip-git-repo-check",
      "--ephemeral",
    ]);
    expect(inv.args).toContain("--add-dir");
    expect(inv.args.at(-1)).toBe("-");
    expect(inv.args).not.toContain("-c");
    expect(inv.stdin).toBe("hi");
  });

  test("codexWritableDirs includes last-stack state realpath and portal cache", () => {
    const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
    const dirs = codexWritableDirs();
    expect(dirs).toContain(`${home}/.last-stack`);
    // Entire managed layout (logs/proofs/dogfood) lives under state/
    expect(dirs).toContain(`${home}/.local/state/last-stack`);
    expect(dirs).toContain(`${home}/.cache/edgevector-git`);
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
    process.env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES = "1";
    process.env.ROUTINES_CLAUDE_BIN = "/tmp/stub-claude";
    process.env.ROUTINES_GROK_BIN = "/tmp/stub-grok";
    expect(harnessBinary("claude")).toBe("/tmp/stub-claude");
    expect(harnessBinary("grok")).toBe("/tmp/stub-grok");
    expect(buildInvocation(entry("claude"), "hello").bin).toBe("/tmp/stub-claude");
  });

  test("binary override requires explicit opt-in", () => {
    process.env.ROUTINES_CLAUDE_BIN = "/tmp/stub-claude";
    process.env.ROUTINES_GROK_BIN = "/tmp/stub-grok";
    expect(harnessBinary("claude")).toBe("claude");
    expect(harnessBinary("grok")).toBe("grok");
    expect(buildInvocation(entry("claude"), "hello").bin).toBe("claude");
  });

  test("large prompt is elided in display", () => {
    const big = "x".repeat(500);
    const inv = buildInvocation(entry("claude"), big);
    expect(inv.display).toContain("<prompt:500 chars>");
    expect(inv.display).not.toContain(big);
  });
});
