// Mechanical routines fleet hygiene — no LLM, no primary-brain restarts.
//
// Prunes run logs and memory growth that poison outcome parsers and fill disk,
// asserts routinesd is loaded, optionally publishes slim fleet status, and
// (opt-in) fast-forwards a *clean* install checkout to lastgit/main.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { daemonLogDir, routinesHome } from "./paths.ts";

export const HYGIENE_LAUNCHD_LABEL = "com.edgevector.routines-hygiene";

export interface HygieneOptions {
  /** Keep at most this many finished run dirs per routine id (default 20). */
  keepRunsPerId?: number;
  /** Also keep any run finished within this many days (default 7). */
  keepDays?: number;
  /** Truncate each memory.md to this many trailing lines (default 100). */
  memoryMaxLines?: number;
  /** Drop error-escalate state files older than this many days (default 14). */
  escalateMaxAgeDays?: number;
  /** When true, only report what would change. */
  dryRun?: boolean;
  /** Call `routines publish-status` when the CLI is available (default true). */
  publishStatus?: boolean;
  /** Opt-in: if the live CLI checkout is a clean git tree behind lastgit/main, ff-only. */
  ffInstall?: boolean;
  /** Opt-in with ffInstall: kickstart routinesd after a successful ff. */
  restartDaemonAfterFf?: boolean;
  /** Override now (tests). */
  nowMs?: number;
  /** Override home (tests). */
  home?: string;
}

export interface HygienePruneItem {
  kind: "run" | "memory" | "escalate";
  path: string;
  detail: string;
}

export interface HygieneResult {
  home: string;
  dryRun: boolean;
  prunedRuns: number;
  truncatedMemories: number;
  prunedEscalate: number;
  bytesFreedEstimate: number;
  items: HygienePruneItem[];
  daemon: {
    label: string;
    loaded: boolean;
    pid: number | null;
    lastExitStatus: number | null;
    detail: string;
  };
  publish: { attempted: boolean; ok: boolean; detail: string };
  installFf: {
    attempted: boolean;
    ok: boolean;
    detail: string;
    restarted: boolean;
  };
  warnings: string[];
}

const DEFAULT_KEEP_RUNS = 20;
const DEFAULT_KEEP_DAYS = 7;
const DEFAULT_MEMORY_LINES = 100;
const DEFAULT_ESCALATE_DAYS = 14;

function errorEscalateDir(home: string): string {
  return join(home, "error-escalate");
}

function dirSizeBytes(path: string): number {
  try {
    const st = statSync(path);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let total = 0;
    for (const name of readdirSync(path)) {
      total += dirSizeBytes(join(path, name));
    }
    return total;
  } catch {
    return 0;
  }
}

function runStampMtimeMs(runDir: string): number {
  const meta = join(runDir, "meta.json");
  try {
    if (existsSync(meta)) {
      const raw = JSON.parse(readFileSync(meta, "utf8")) as {
        finishedAt?: string;
        startedAt?: string;
      };
      const iso = raw.finishedAt ?? raw.startedAt;
      if (iso) {
        const t = Date.parse(iso);
        if (Number.isFinite(t)) return t;
      }
    }
  } catch {
    /* fall through */
  }
  try {
    return statSync(runDir).mtimeMs;
  } catch {
    return 0;
  }
}

function isRunningMeta(runDir: string): boolean {
  const meta = join(runDir, "meta.json");
  try {
    if (!existsSync(meta)) return false;
    const raw = JSON.parse(readFileSync(meta, "utf8")) as {
      status?: string;
      finishedAt?: string;
      exitCode?: number | null;
    };
    if (raw.status === "running") return true;
    if (typeof raw.finishedAt === "string") return false;
    if ("exitCode" in raw) return false;
    return true;
  } catch {
    return false;
  }
}

/** Select run dirs to delete for one routine id. */
export function selectRunsToPrune(
  runDirs: string[],
  opts: { keepRunsPerId: number; keepDays: number; nowMs: number },
): string[] {
  const cutoff = opts.nowMs - opts.keepDays * 86_400_000;
  const scored = runDirs
    .filter((d) => !isRunningMeta(d))
    .map((d) => ({ d, t: runStampMtimeMs(d) }))
    .sort((a, b) => b.t - a.t);

  const keep = new Set<string>();
  // Always keep the newest N.
  for (const row of scored.slice(0, opts.keepRunsPerId)) keep.add(row.d);
  // Plus anything within the day window.
  for (const row of scored) {
    if (row.t >= cutoff) keep.add(row.d);
  }
  return scored.filter((row) => !keep.has(row.d)).map((row) => row.d);
}

/** Truncate body to the last `maxLines` lines; returns new text or null if unchanged. */
export function truncateMemoryText(text: string, maxLines: number): string | null {
  if (maxLines < 1) return null;
  const lines = text.split("\n");
  // Preserve trailing newline semantics: if file ends with \n, last element is "".
  const nonEmptyCount =
    lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (nonEmptyCount <= maxLines) return null;
  const bodyLines =
    lines.length > 0 && lines[lines.length - 1] === ""
      ? lines.slice(0, -1)
      : lines.slice();
  const kept = bodyLines.slice(-maxLines);
  const header = `# truncated by routines hygiene ${new Date().toISOString()} (kept last ${maxLines} lines)\n\n`;
  return header + kept.join("\n") + "\n";
}

function probeDaemon(): HygieneResult["daemon"] {
  const label = "com.edgevector.routinesd";
  try {
    const out = execFileSync("launchctl", ["list", label], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // launchctl list prints a small dict-ish block with "PID" = N;
    const pidM = out.match(/"PID"\s*=\s*(\d+)/);
    const exitM = out.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
    const pid = pidM ? Number(pidM[1]) : null;
    const lastExitStatus = exitM ? Number(exitM[1]) : null;
    return {
      label,
      loaded: true,
      pid: Number.isFinite(pid) ? pid : null,
      lastExitStatus: Number.isFinite(lastExitStatus) ? lastExitStatus : null,
      detail: pid ? `loaded pid=${pid}` : `loaded but no pid (LastExitStatus=${lastExitStatus})`,
    };
  } catch (err) {
    return {
      label,
      loaded: false,
      pid: null,
      lastExitStatus: null,
      detail: `not loaded: ${(err as Error).message}`,
    };
  }
}

function tryPublishStatus(dryRun: boolean): HygieneResult["publish"] {
  if (dryRun) {
    return { attempted: false, ok: true, detail: "skipped (dry-run)" };
  }
  try {
    // Prefer PATH shim so we hit the same binary as the operator.
    execFileSync("routines", ["publish-status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      env: process.env,
    });
    return { attempted: true, ok: true, detail: "publish-status ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { attempted: true, ok: false, detail: `publish-status failed: ${msg}` };
  }
}

function tryFfInstall(
  dryRun: boolean,
  restart: boolean,
): HygieneResult["installFf"] {
  // Resolve the live CLI tree from the running binary / argv.
  const entry = process.argv[1] ?? "";
  let root: string | null = null;
  try {
    if (entry) {
      const real = execFileSync("python3", ["-c", "import os,sys; print(os.path.realpath(sys.argv[1]))", entry], {
        encoding: "utf8",
      }).trim();
      // entry is …/src/cli.ts or …/bin/routines → repo root is parent of src|bin
      const dir = real.replace(/\/src\/cli\.ts$/, "").replace(/\/bin\/routines$/, "");
      if (dir && existsSync(join(dir, ".git"))) root = dir;
    }
  } catch {
    /* ignore */
  }
  if (!root) {
    return {
      attempted: false,
      ok: true,
      detail: "no install git root resolved from CLI path",
      restarted: false,
    };
  }
  try {
    const status = execFileSync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
    });
    if (status.trim().length > 0) {
      return {
        attempted: false,
        ok: true,
        detail: `install tree dirty (${root}); skip ff`,
        restarted: false,
      };
    }
    execFileSync("git", ["-C", root, "fetch", "lastgit", "main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    const behind = execFileSync(
      "git",
      ["-C", root, "rev-list", "--count", "HEAD..lastgit/main"],
      { encoding: "utf8" },
    ).trim();
    const n = Number(behind) || 0;
    if (n === 0) {
      return {
        attempted: false,
        ok: true,
        detail: `install tree current (${root})`,
        restarted: false,
      };
    }
    if (dryRun) {
      return {
        attempted: true,
        ok: true,
        detail: `would ff-only ${n} commit(s) at ${root}`,
        restarted: false,
      };
    }
    execFileSync("git", ["-C", root, "merge", "--ff-only", "lastgit/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let restarted = false;
    if (restart) {
      const uid = process.getuid?.() ?? 0;
      try {
        execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/com.edgevector.routinesd`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        restarted = true;
      } catch (err) {
        return {
          attempted: true,
          ok: true,
          detail: `ff-only +${n} at ${root}; kickstart failed: ${(err as Error).message}`,
          restarted: false,
        };
      }
    }
    return {
      attempted: true,
      ok: true,
      detail: `ff-only +${n} at ${root}${restarted ? "; routinesd kickstarted" : ""}`,
      restarted,
    };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      detail: `install ff failed: ${(err as Error).message}`,
      restarted: false,
    };
  }
}

/** Run the full mechanical hygiene pass. */
export function runHygiene(opts: HygieneOptions = {}): HygieneResult {
  const home = opts.home ?? routinesHome();
  const nowMs = opts.nowMs ?? Date.now();
  const dryRun = opts.dryRun === true;
  const keepRunsPerId = opts.keepRunsPerId ?? DEFAULT_KEEP_RUNS;
  const keepDays = opts.keepDays ?? DEFAULT_KEEP_DAYS;
  const memoryMaxLines = opts.memoryMaxLines ?? DEFAULT_MEMORY_LINES;
  const escalateMaxAgeDays = opts.escalateMaxAgeDays ?? DEFAULT_ESCALATE_DAYS;
  const publishStatus = opts.publishStatus !== false;

  const items: HygienePruneItem[] = [];
  const warnings: string[] = [];
  let prunedRuns = 0;
  let truncatedMemories = 0;
  let prunedEscalate = 0;
  let bytesFreedEstimate = 0;

  // --- runs ---
  const runsBase = join(home, "runs");
  if (existsSync(runsBase)) {
    for (const id of readdirSync(runsBase)) {
      const idDir = join(runsBase, id);
      try {
        if (!statSync(idDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const children = readdirSync(idDir)
        .map((n) => join(idDir, n))
        .filter((p) => {
          try {
            return statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
      const doomed = selectRunsToPrune(children, { keepRunsPerId, keepDays, nowMs });
      for (const d of doomed) {
        const sz = dirSizeBytes(d);
        items.push({ kind: "run", path: d, detail: `delete run dir (~${sz} bytes)` });
        bytesFreedEstimate += sz;
        prunedRuns++;
        if (!dryRun) {
          try {
            rmSync(d, { recursive: true, force: true });
          } catch (err) {
            warnings.push(`failed to remove ${d}: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  // --- memory ---
  const memBase = join(home, "memory");
  if (existsSync(memBase)) {
    for (const id of readdirSync(memBase)) {
      const memFile = join(memBase, id, "memory.md");
      if (!existsSync(memFile)) continue;
      let text: string;
      try {
        text = readFileSync(memFile, "utf8");
      } catch (err) {
        warnings.push(`read ${memFile}: ${(err as Error).message}`);
        continue;
      }
      const next = truncateMemoryText(text, memoryMaxLines);
      if (!next) continue;
      const before = Buffer.byteLength(text, "utf8");
      const after = Buffer.byteLength(next, "utf8");
      items.push({
        kind: "memory",
        path: memFile,
        detail: `truncate to last ${memoryMaxLines} lines (${before}→${after} bytes)`,
      });
      bytesFreedEstimate += Math.max(0, before - after);
      truncatedMemories++;
      if (!dryRun) {
        try {
          writeFileSync(memFile, next, "utf8");
        } catch (err) {
          warnings.push(`write ${memFile}: ${(err as Error).message}`);
        }
      }
    }
  }

  // --- error-escalate state ---
  const escBase = errorEscalateDir(home);
  const escCutoff = nowMs - escalateMaxAgeDays * 86_400_000;
  if (existsSync(escBase)) {
    for (const name of readdirSync(escBase)) {
      if (!name.endsWith(".json")) continue;
      const p = join(escBase, name);
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (mtime >= escCutoff) continue;
      const sz = dirSizeBytes(p);
      items.push({
        kind: "escalate",
        path: p,
        detail: `delete escalate state older than ${escalateMaxAgeDays}d`,
      });
      bytesFreedEstimate += sz;
      prunedEscalate++;
      if (!dryRun) {
        try {
          rmSync(p, { force: true });
        } catch (err) {
          warnings.push(`remove ${p}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Ensure daemon log dir exists (harmless).
  try {
    mkdirSync(opts.home ? join(home, "daemon") : daemonLogDir(), { recursive: true });
  } catch {
    /* ignore */
  }

  const daemon = probeDaemon();
  if (!daemon.loaded) {
    warnings.push(`routinesd launchd not loaded (${daemon.detail})`);
  } else if (daemon.pid == null) {
    warnings.push(`routinesd loaded but no live pid (${daemon.detail})`);
  }

  const publish = publishStatus
    ? tryPublishStatus(dryRun)
    : { attempted: false, ok: true, detail: "skipped (--no-publish)" };
  if (publish.attempted && !publish.ok) warnings.push(publish.detail);

  const installFf = opts.ffInstall
    ? tryFfInstall(dryRun, opts.restartDaemonAfterFf !== false)
    : {
        attempted: false,
        ok: true,
        detail: "skipped (pass --ff-install to enable)",
        restarted: false,
      };
  if (installFf.attempted && !installFf.ok) warnings.push(installFf.detail);

  return {
    home,
    dryRun,
    prunedRuns,
    truncatedMemories,
    prunedEscalate,
    bytesFreedEstimate,
    items,
    daemon,
    publish,
    installFf,
    warnings,
  };
}

// --- launchd for hygiene ---

export function hygienePlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${HYGIENE_LAUNCHD_LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Render a StartInterval launchd plist that runs `routines hygiene`. */
export function renderHygienePlist(opts: {
  program: string;
  runtime?: string;
  intervalSec?: number;
  env?: Record<string, string>;
}): string {
  const runtime = opts.runtime ?? process.execPath;
  const interval = opts.intervalSec ?? 3600;
  const logDir = daemonLogDir();
  const args = [runtime, opts.program, "hygiene", "--json"];
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const env = { ROUTINES_HOME: routinesHome(), ...(opts.env ?? {}) };
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${HYGIENE_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, "hygiene.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, "hygiene.err.log"))}</string>
</dict>
</plist>
`;
}

export interface HygieneInstallResult {
  plistPath: string;
  loaded: boolean;
  message: string;
}

export function installHygieneDaemon(opts: {
  program: string;
  runtime?: string;
  intervalSec?: number;
  env?: Record<string, string>;
}): HygieneInstallResult {
  const p = hygienePlistPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(daemonLogDir(), { recursive: true });
  writeFileSync(p, renderHygienePlist(opts));
  const uid = process.getuid?.() ?? 0;
  try {
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${HYGIENE_LAUNCHD_LABEL}`], {
        stdio: "ignore",
      });
    } catch {
      /* not loaded */
    }
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, p], { stdio: "pipe" });
    return {
      plistPath: p,
      loaded: true,
      message: `bootstrapped gui/${uid}/${HYGIENE_LAUNCHD_LABEL}`,
    };
  } catch (err) {
    return {
      plistPath: p,
      loaded: false,
      message:
        `wrote plist but launchctl bootstrap failed: ${(err as Error).message}. ` +
        `Load manually: launchctl bootstrap gui/${uid} ${p}`,
    };
  }
}

export function uninstallHygieneDaemon(): HygieneInstallResult {
  const p = hygienePlistPath();
  const uid = process.getuid?.() ?? 0;
  let msg = "";
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${HYGIENE_LAUNCHD_LABEL}`], {
      stdio: "pipe",
    });
    msg = `booted out gui/${uid}/${HYGIENE_LAUNCHD_LABEL}`;
  } catch {
    msg = `${HYGIENE_LAUNCHD_LABEL} was not loaded`;
  }
  return {
    plistPath: p,
    loaded: false,
    message: msg + (existsSync(p) ? ` (plist left at ${p})` : ""),
  };
}
