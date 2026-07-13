// Load project constants from the configurations app so routines don't hard-code
// workspace paths. Prefer `configurations get workspace-config`; fall back to
// last-stack-config-get / env. Fail soft: missing config never stops the daemon.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProjectConfig = {
  /** Absolute workspace root (parent of repo checkouts). */
  workspaceRoot?: string;
  /** Directory of generic routine prompt markdown files. */
  routinesPromptsDir?: string;
  /** Shell PATH prefix export value, if present. */
  pathPrefix?: string;
  boardCli?: string;
  brainCli?: string;
  situationsCli?: string;
  /** Raw markdown body for debugging / doctor. */
  source: "configurations" | "last-stack-config-get" | "env" | "none";
  raw?: string;
};

const FIELD_MAP: Record<string, keyof ProjectConfig> = {
  workspace_root: "workspaceRoot",
  routines_prompts_dir: "routinesPromptsDir",
  path_prefix: "pathPrefix",
  board_cli: "boardCli",
  brain_cli: "brainCli",
  situations_cli: "situationsCli",
};

function extractField(body: string, key: string): string | undefined {
  const re = new RegExp(
    String.raw`(?:^|\n)\s*[-*]?\s*\*\*${key}\*\*:\s*(.+?)\s*(?:\n|$)`,
    "i",
  );
  const m = body.match(re);
  if (!m) return undefined;
  let v = m[1]!.trim();
  // Prefer fenced `value` if present
  const tick = v.match(/`([^`]+)`/);
  if (tick) return tick[1]!.trim();
  // Drop trailing parenthetical prose
  v = v.replace(/\s*\(.*$/, "").trim();
  return v || undefined;
}

function parseBody(body: string, source: ProjectConfig["source"]): ProjectConfig {
  const out: ProjectConfig = { source, raw: body };
  for (const [mdKey, field] of Object.entries(FIELD_MAP)) {
    const v = extractField(body, mdKey);
    if (v) (out as Record<string, unknown>)[field] = v;
  }
  // path_prefix may be `export PATH="..."` — keep as-is for env merge helpers
  if (out.routinesPromptsDir?.startsWith("~/")) {
    out.routinesPromptsDir = join(homedir(), out.routinesPromptsDir.slice(2));
  }
  if (out.workspaceRoot?.startsWith("~/")) {
    out.workspaceRoot = join(homedir(), out.workspaceRoot.slice(2));
  }
  return out;
}

function tryCmd(bin: string, args: string[]): string | null {
  try {
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      env: process.env,
      timeout: 8_000,
    });
    if (r.status !== 0) return null;
    const text = (r.stdout ?? "").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

let cached: ProjectConfig | null = null;
let cachedAt = 0;
const TTL_MS = 30_000;

/** Load workspace-config (cached ~30s). Safe to call every tick. */
export function loadProjectConfig(opts: { force?: boolean } = {}): ProjectConfig {
  const now = Date.now();
  if (!opts.force && cached && now - cachedAt < TTL_MS) return cached;

  // 1) configurations app
  const viaApp = tryCmd("configurations", ["get", "workspace-config"]);
  if (viaApp) {
    cached = parseBody(viaApp, "configurations");
    cachedAt = now;
    return cached;
  }

  // 2) last-stack helper
  const helper = process.env.LAST_STACK_ROOT
    ? join(process.env.LAST_STACK_ROOT, "bin", "last-stack-config-get")
    : join(homedir(), ".last-stack", "bin", "last-stack-config-get");
  const viaHelper = tryCmd(helper, ["workspace-config"]);
  if (viaHelper) {
    cached = parseBody(viaHelper, "last-stack-config-get");
    cachedAt = now;
    return cached;
  }

  // 3) env overrides
  const envRoot = process.env.ROUTINES_WORKSPACE_ROOT;
  if (envRoot && envRoot.length > 0) {
    cached = {
      source: "env",
      workspaceRoot: envRoot,
      routinesPromptsDir: process.env.ROUTINES_PROMPTS_DIR,
    };
    cachedAt = now;
    return cached;
  }

  cached = { source: "none" };
  cachedAt = now;
  return cached;
}

/** Env vars to inject into routine child processes. */
export function envFromProjectConfig(pc: ProjectConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (pc.workspaceRoot) env.ROUTINES_WORKSPACE_ROOT = pc.workspaceRoot;
  if (pc.routinesPromptsDir) env.ROUTINES_PROMPTS_DIR = pc.routinesPromptsDir;
  if (pc.boardCli) env.ROUTINES_BOARD_CLI = pc.boardCli.split("/")[0]!.trim();
  if (pc.brainCli) env.ROUTINES_BRAIN_CLI = pc.brainCli.split("/")[0]!.trim();
  if (pc.situationsCli) {
    env.ROUTINES_SITUATIONS_CLI = pc.situationsCli.split("/")[0]!.trim();
  }
  // Merge path_prefix into PATH if it looks like export PATH="..."
  if (pc.pathPrefix) {
    const m = pc.pathPrefix.match(/PATH\s*=\s*["']?([^"';\n]+)/);
    if (m) {
      const prefix = m[1]!.replace(/:\$PATH$/, "").replace(/\$PATH/, "");
      env.PATH = `${prefix}:${process.env.PATH ?? ""}`;
    }
  }
  return env;
}

/** Resolve default cwd for a routine when registry cwd is empty or "config:workspace". */
export function resolveRoutineCwd(registryCwd: string | undefined, pc: ProjectConfig): string {
  const cwd = (registryCwd ?? "").trim();
  if (!cwd || cwd === "config:workspace" || cwd === "from:workspace-config") {
    return pc.workspaceRoot ?? process.cwd();
  }
  return cwd;
}
