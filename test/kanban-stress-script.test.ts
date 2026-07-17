import { describe, expect, test } from "bun:test";

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
});
