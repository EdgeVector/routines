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

  test("reports interrupted runs as partial and still cleans scratch cards", async () => {
    const script = await Bun.file(scriptPath).text();

    expect(script).toContain("trap interrupted INT TERM HUP");
    expect(script).toContain("PARTIAL:");
    expect(script).toContain("cleanup attempted");
    expect(script).toContain("cleanup_created");
    expect(script).toContain("partial=$partial");
    expect(script).toContain("harness interrupted before completion");
  });

  test("forces scratch todo creates through the milestone gate", async () => {
    const script = await Bun.file(scriptPath).text();
    const todoAdds = [...script.matchAll(/\$FK" add [^\n]*--column todo[^\n]*/g)];

    expect(todoAdds).toHaveLength(3);
    for (const add of todoAdds) {
      expect(add[0]).toContain("--force");
    }
  });
});
