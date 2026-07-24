import { describe, expect, test } from "bun:test";

import { envFromProjectConfig, loadProjectConfig, resolveRoutineCwd, type ProjectConfig } from "../src/project-config.ts";

describe("project-config helpers", () => {
  test("explicit env workspace bypasses external config helpers", () => {
    const prevRoot = process.env.ROUTINES_WORKSPACE_ROOT;
    const prevPrompts = process.env.ROUTINES_PROMPTS_DIR;
    process.env.ROUTINES_WORKSPACE_ROOT = "/env-workspace";
    process.env.ROUTINES_PROMPTS_DIR = "/env-prompts";
    try {
      const pc = loadProjectConfig({ force: true });
      expect(pc.source).toBe("env");
      expect(pc.workspaceRoot).toBe("/env-workspace");
      expect(pc.routinesPromptsDir).toBe("/env-prompts");
    } finally {
      if (prevRoot === undefined) delete process.env.ROUTINES_WORKSPACE_ROOT;
      else process.env.ROUTINES_WORKSPACE_ROOT = prevRoot;
      if (prevPrompts === undefined) delete process.env.ROUTINES_PROMPTS_DIR;
      else process.env.ROUTINES_PROMPTS_DIR = prevPrompts;
      loadProjectConfig({ force: true });
    }
  });

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
