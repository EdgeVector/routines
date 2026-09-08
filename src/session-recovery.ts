import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { validSessionId } from "./execution-record.ts";
import { resolvePrompt, type RoutineEntry } from "./registry.ts";
import { runsDir } from "./paths.ts";

export interface WorktreeIdentity { cwd: string; gitDir: string; head: string; digest: string }
export function recoveryTaskHash(entry: RoutineEntry): string {
  return createHash("sha256").update(JSON.stringify({ prompt: resolvePrompt(entry), effort: entry.effort ?? null })).digest("hex");
}
export function worktreeIdentity(cwd: string): WorktreeIdentity | null {
  try {
    const root = realpathSync(cwd);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    if (realpathSync(git("rev-parse", "--show-toplevel").toString().trim()) !== root) return null;
    const hash = createHash("sha256");
    hash.update(git("status", "--porcelain=v1", "-z"));
    hash.update(git("diff", "HEAD", "--binary"));
    hash.update(git("diff", "--cached", "--binary"));
    hash.update(git("rev-parse", "--abbrev-ref", "HEAD"));
    const paths = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean);
    if (paths.length > 1000) return null;
    let bytes = 0;
    for (const path of paths.sort()) {
      const full = join(root, path);
      const st = lstatSync(full);
      bytes += st.size;
      if (!st.isFile() || bytes > 32 * 1024 * 1024) return null;
      hash.update(path + "\0"); hash.update(readFileSync(full));
    }
    return { cwd: root, gitDir: realpathSync(resolve(root, git("rev-parse", "--git-dir").toString().trim())),
      head: git("rev-parse", "HEAD").toString().trim(), digest: hash.digest("hex") };
  } catch { return null; }
}

// Resume is explicit, same provider/model, and never a fallback. A successful
// effect check means continuing this exact interrupted task is safe, not that
// its product outcome is complete. Missing evidence always refuses reuse.
export function validateResume(entry: RoutineEntry, from: string, cwd: string): string {
  if (entry.harness !== "codex" || entry.sessionMode !== "persistent") throw new Error("resume requires a persistent Codex routine");
  if (!entry.resumeCheck) throw new Error("resume requires a configured resume_check for external effects");
  const dir = realpathSync(from);
  const parent = realpathSync(join(runsDir(), entry.id));
  if (relative(parent, dir).startsWith("..") || relative(parent, dir).includes("/") || dir === parent) throw new Error("resume run must belong to this routine");
  if (existsSync(join(dir, "resume-claim.json"))) throw new Error("resume refused: prior run was already used for recovery");
  const read = (name: string) => {
    const path = join(dir, name);
    if (!lstatSync(path).isFile() || lstatSync(path).size > 262_144) throw new Error("invalid recovery metadata");
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const meta = read("meta.json");
  const execution = read("execution.json");
  if (meta.id !== entry.id || meta.harness !== "codex" || meta.model !== entry.model || meta.recoveryTaskHash !== recoveryTaskHash(entry) || meta.sessionMode !== "persistent" ||
      meta.status !== "finished" || !["error", "unknown"].includes(meta.outcome) || !validSessionId(execution.sessionId)) throw new Error("run has no eligible interrupted session");
  const current = worktreeIdentity(cwd);
  if (!current || !meta.recoveryWorktree || JSON.stringify(current) !== JSON.stringify(meta.recoveryWorktree)) throw new Error("resume refused: worktree identity or contents changed");
  const check = spawnSync("/bin/bash", ["-c", entry.resumeCheck], {
    cwd, timeout: 30_000, maxBuffer: 8192, stdio: "ignore",
    env: { ...process.env, ROUTINES_RESUME_RUN_DIR: dir, ROUTINES_RESUME_SESSION_ID: execution.sessionId },
  });
  if (check.status !== 0 || check.error) throw new Error("resume effect check failed or timed out");
  if (JSON.stringify(worktreeIdentity(cwd)) !== JSON.stringify(current)) throw new Error("resume effect check changed the worktree");
  return execution.sessionId;
}

export function claimResume(from: string, runDir: string): void {
  writeFileSync(join(realpathSync(from), "resume-claim.json"), JSON.stringify({ runDir }) + "\n", { flag: "wx", mode: 0o600 });
}
