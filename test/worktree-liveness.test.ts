import { describe, expect, test } from "bun:test";

import { deriveWorktreeLivenessEnv } from "../src/worktree-liveness.ts";

const root = "/Users/test/.fkanban/worktrees";

describe("worktree cleanup host liveness snapshot", () => {
  test("injects conservative live cwd and executable paths when both probes are healthy", () => {
    const env = deriveWorktreeLivenessEnv(
      "last-stack-worktree-cleanup",
      { LAST_STACK_RECLAIM_EXTRA_LIVE_PATHS: `${root}/already-live` },
      {
        roots: [root],
        lsof: {
          status: 0,
          stdout: `p1\nn/Users/test/code\np2\nn${root}/card-a\n`,
        },
        ps: {
          status: 0,
          stdout: `  1 launchd /sbin/launchd\n 22 cargo ${root}/card-b/target/debug/app\n`,
        },
      },
    );

    expect(env.LAST_STACK_RECLAIM_SKIP_LSOF).toBe("1");
    expect(env.ROUTINES_HOST_LIVENESS_SNAPSHOT).toBe("verified");
    expect(env.LAST_STACK_RECLAIM_EXTRA_LIVE_PATHS).toBe(
      `${root}/already-live:${root}/card-a`,
    );
    expect(env.LAST_STACK_RECLAIM_EXTRA_LIVE_EXEC_PATHS).toBe(
      `${root}/card-b/target/debug/app`,
    );
  });

  test("fails closed when lsof cannot enumerate cwd rows", () => {
    const base = { KEEP: "yes" };
    const env = deriveWorktreeLivenessEnv("last-stack-worktree-cleanup", base, {
      roots: [root],
      lsof: { status: 1, stdout: "" },
      ps: { status: 0, stdout: "  1 launchd /sbin/launchd\n" },
    });

    expect(env).toEqual(base);
    expect(env.LAST_STACK_RECLAIM_SKIP_LSOF).toBeUndefined();
  });

  test("fails closed when ps cannot enumerate a pid", () => {
    const base = { KEEP: "yes" };
    const env = deriveWorktreeLivenessEnv("last-stack-worktree-cleanup", base, {
      roots: [root],
      lsof: { status: 0, stdout: "p1\nn/Users/test/code\n" },
      ps: { status: 1, stdout: "" },
    });

    expect(env).toEqual(base);
  });

  test("does not inspect or mutate unrelated routine environments", () => {
    const base = { KEEP: "yes" };
    const env = deriveWorktreeLivenessEnv("last-stack-fkanban-pickup", base, {
      roots: [root],
      lsof: { status: 0, stdout: `p1\nn${root}/card-a\n` },
      ps: { status: 0, stdout: "  1 launchd /sbin/launchd\n" },
    });

    expect(env).toEqual(base);
  });
});
