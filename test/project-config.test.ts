import { describe, expect, test } from "bun:test";

import { envFromProjectConfig, resolveRoutineCwd, type ProjectConfig } from "../src/project-config.ts";

describe("project-config helpers", () => {
  test("resolveRoutineCwd uses workspace when registry cwd is sentinel", () => {
    const pc: ProjectConfig = { source: "configurations", workspaceRoot: "/ws" };
    expect(resolveRoutineCwd("config:workspace", pc)).toBe("/ws");
    expect(resolveRoutineCwd("from:workspace-config", pc)).toBe("/ws");
    expect(resolveRoutineCwd("/explicit", pc)).toBe("/explicit");
  });

  test("envFromProjectConfig exports workspace + PATH prefix", () => {
    const env = envFromProjectConfig({
      source: "configurations",
      workspaceRoot: "/ws",
      pathPrefix: 'export PATH="$HOME/.local/bin:$PATH"',
      boardCli: "kanban / fkanban",
    });
    expect(env.ROUTINES_WORKSPACE_ROOT).toBe("/ws");
    expect(env.ROUTINES_BOARD_CLI).toBe("kanban");
    expect(env.PATH).toContain(".local/bin");
  });
});
