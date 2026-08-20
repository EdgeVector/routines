import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

type Probe = {
  status: number | null;
  stdout: string;
};

export type WorktreeLivenessSamples = {
  lsof: Probe;
  ps: Probe;
  roots: string[];
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function underRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function mergePathList(existing: string | undefined, values: string[]): string | undefined {
  const prior = existing?.split(":").filter(Boolean) ?? [];
  const merged = unique([...prior, ...values]);
  return merged.length > 0 ? merged.join(":") : undefined;
}

/**
 * Convert host-level lsof/ps output into the conservative fixture inputs
 * already understood by last-stack-worktree-reclaim.
 *
 * Fail closed: both instruments must succeed and prove they can enumerate the
 * host before LAST_STACK_RECLAIM_SKIP_LSOF is enabled in the harness child.
 */
export function deriveWorktreeLivenessEnv(
  entryId: string,
  base: NodeJS.ProcessEnv,
  samples: WorktreeLivenessSamples,
): NodeJS.ProcessEnv {
  if (entryId !== "last-stack-worktree-cleanup") return { ...base };

  const lsofRows = samples.lsof.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("n") && line.length > 1)
    .map((line) => line.slice(1).replace(/\/$/, ""));
  const psHasPid = samples.ps.stdout.split(/\r?\n/).some((line) => /^\s*\d+\s/.test(line));
  if (samples.lsof.status !== 0 || lsofRows.length === 0 || samples.ps.status !== 0 || !psHasPid) {
    return { ...base };
  }

  const liveCwds = unique(lsofRows.filter((path) => underRoot(path, samples.roots)));
  const liveExecPaths: string[] = [];
  for (const line of samples.ps.stdout.split(/\r?\n/)) {
    for (const root of samples.roots) {
      let offset = 0;
      while (true) {
        const found = line.indexOf(root, offset);
        if (found < 0) break;
        const suffix = line.slice(found);
        const path = suffix.split(/\s/, 1)[0]!.replace(/["']+$/, "");
        if (underRoot(path, samples.roots)) liveExecPaths.push(path);
        offset = found + root.length;
      }
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...base,
    LAST_STACK_RECLAIM_SKIP_LSOF: "1",
    ROUTINES_HOST_LIVENESS_SNAPSHOT: "verified",
  };
  const cwdList = mergePathList(base.LAST_STACK_RECLAIM_EXTRA_LIVE_PATHS, liveCwds);
  const execList = mergePathList(base.LAST_STACK_RECLAIM_EXTRA_LIVE_EXEC_PATHS, liveExecPaths);
  if (cwdList) env.LAST_STACK_RECLAIM_EXTRA_LIVE_PATHS = cwdList;
  if (execList) env.LAST_STACK_RECLAIM_EXTRA_LIVE_EXEC_PATHS = execList;
  return env;
}

/** Capture process liveness before the Codex/Claude/Grok harness sandbox starts. */
export function enrichWorktreeCleanupLivenessEnv(
  entryId: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (entryId !== "last-stack-worktree-cleanup") return { ...base };

  const home = base.HOME && base.HOME.length > 0 ? base.HOME : homedir();
  const roots = [join(home, ".fkanban", "worktrees"), join(home, ".kanban", "worktrees")];
  let username = base.USER;
  if (!username) {
    try {
      username = userInfo().username;
    } catch {
      return { ...base };
    }
  }

  const lsof = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-u", username, "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    maxBuffer: 8_000_000,
  });
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,comm=,command="], {
    encoding: "utf8",
    maxBuffer: 8_000_000,
  });

  return deriveWorktreeLivenessEnv(entryId, base, {
    roots,
    lsof: { status: lsof.status, stdout: lsof.stdout ?? "" },
    ps: { status: ps.status, stdout: ps.stdout ?? "" },
  });
}
