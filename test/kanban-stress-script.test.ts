import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProbePath } from "../src/probes.ts";

const scriptPath = new URL("../scripts/kanban-stress.sh", import.meta.url);

describe("kanban stress harness", () => {
  test("uses the live four-column board schema", async () => {
    const script = await Bun.file(scriptPath).text();

    expect(script).toContain("--columns backlog,todo,doing,done");
    expect(script).not.toContain("--columns backlog,todo,doing,review,done");
    expect(script).not.toContain("--columns a,b,c");
  });

  test("does not route cards through the retired review lane", async () => {
    const script = await Bun.file(scriptPath).text();

    expect(script).toContain("for col in doing done");
    expect(script).not.toContain("for col in doing review done");
  });

  test("reports interrupted runs as partial and still cleans scratch cards", async () => {
    const script = await Bun.file(scriptPath).text();

    expect(script).toContain("trap interrupted INT TERM HUP");
    expect(script).toContain("PARTIAL:");
    expect(script).toContain("cleanup attempted");
    expect(script).toContain("cleanup_created");
    expect(script).toContain("partial=$partial");
    expect(script).toContain("harness interrupted before completion");
    expect(script).toContain("trap finalize_on_exit EXIT");
    expect(script).toContain("harness exited before its terminal summary");
  });

  test("forces scratch todo creates through the milestone gate", async () => {
    const script = await Bun.file(scriptPath).text();
    const todoAdds = [...script.matchAll(/\$FK" add [^\n]*--column todo[^\n]*/g)];

    expect(todoAdds).toHaveLength(3);
    for (const add of todoAdds) {
      expect(add[0]).toContain("--force");
    }
  });

  test("resolves the harness from a compiled artifact without a source checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "routines-probe-artifact-"));
    try {
      const executable = join(root, "dist", "routines");
      const probe = join(root, "dist", "probes", "kanban-stress.sh");
      mkdirSync(join(root, "dist", "probes"), { recursive: true });
      writeFileSync(executable, "stub\n");
      writeFileSync(probe, "#!/bin/sh\n", { mode: 0o755 });
      chmodSync(probe, 0o755);

      expect(resolveProbePath("dogfood-kanban", { executable, sourceDir: join(root, "missing") })).toBe(
        realpathSync(probe),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown probe names", () => {
    expect(() => resolveProbePath("unknown-probe")).toThrow("unknown probe: unknown-probe");
  });
});
