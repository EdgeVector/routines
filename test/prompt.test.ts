import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseEntry } from "../src/registry.ts";
import { buildDispatchEnvelope, ensureMemoryPath, resolveDispatchPrompt } from "../src/prompt.ts";

const prevHome = process.env.ROUTINES_HOME;
let tmp: string | undefined;

afterEach(() => {
  if (prevHome === undefined) delete process.env.ROUTINES_HOME;
  else process.env.ROUTINES_HOME = prevHome;
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("dispatch prompt envelope", () => {
  test("ensureMemoryPath creates parent dir", () => {
    tmp = mkdtempSync(join(tmpdir(), "routines-mem-"));
    process.env.ROUTINES_HOME = tmp;
    const p = ensureMemoryPath("last-stack-fkanban-pickup");
    expect(p).toBe(join(tmp, "memory", "last-stack-fkanban-pickup", "memory.md"));
    expect(existsSync(join(tmp, "memory", "last-stack-fkanban-pickup"))).toBe(true);
  });

  test("resolveDispatchPrompt prepends Automation ID + memory path", () => {
    tmp = mkdtempSync(join(tmpdir(), "routines-mem-"));
    process.env.ROUTINES_HOME = tmp;
    const entry = parseEntry(
      ['harness = "codex"', 'model = "m1"', 'rrule = "FREQ=HOURLY"', 'prompt = "Do work."'].join("\n"),
      join(tmp, "last-stack-fkanban-pickup.toml"),
    );
    const text = resolveDispatchPrompt(entry);
    expect(text).toContain("Automation ID: last-stack-fkanban-pickup");
    expect(text).toContain(
      `Automation memory: ${join(tmp, "memory", "last-stack-fkanban-pickup", "memory.md")}`,
    );
    expect(text).toContain("Do work.");
    expect(text.indexOf("Dispatch envelope")).toBeLessThan(text.indexOf("Do work."));
  });

  test("envelope names the memory path agents must use", () => {
    const env = buildDispatchEnvelope({ id: "x" } as never, "/tmp/x/memory.md");
    expect(env).toContain("Automation ID: x");
    expect(env).toContain("Automation memory: /tmp/x/memory.md");
    expect(env).toContain("Do not invent");
  });
});
