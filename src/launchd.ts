// launchd integration for routinesd.
//
// Unattended loops must survive session exit (never a background subagent), so
// routinesd runs as a launchd user agent. `routines install-daemon` writes the
// plist and bootstraps it; `routines uninstall-daemon` reverses it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { daemonLogDir, routinesHome } from "./paths.ts";

export const LAUNCHD_LABEL = "com.edgevector.routinesd";

/**
 * The launchd QoS band a timer-driven job must ask for.
 *
 * macOS holds a `Background` job in the throttled band: low CPU priority,
 * low-priority disk I/O, and — the part that matters here — COALESCED TIMERS.
 * Child processes inherit the band, so every `spawnSync` on the dispatch path
 * inherits it too.
 *
 * Measured on Tom's Mac, 2026-09-05, same host and the same documented
 * `tickMs = 15_000`:
 *
 * | ProcessType | observed tick gaps        | dispatch rate |
 * |-------------|---------------------------|---------------|
 * | Background  | 90 s - 1153 s             | ~10-24 / hour |
 * | Standard    | 15.3 - 18.3 s             | ~60 / hour    |
 *
 * Under `Background` a freshly booted daemon logged NOTHING for 9m15s — not
 * even its own start line — while a `sample` put 3214 of 3214 main-thread
 * samples in `kevent64`. It was not busy. It was asleep on a 15 s timer that
 * the system declined to fire. The fleet shipped nothing for over four hours.
 *
 * `Standard` is the value that was measured, so `Standard` is what we write.
 * The papercut prescribed `Adaptive`; that value was never tested on this
 * host, and a generator that disagrees with the healed live plist is the
 * drift that caused this in the first place.
 *
 * See papercut-routinesd-tick-loop-stalls-as-inflight-grows-fleet-dispatch-stops-silently-20260905.
 */
export const SCHEDULER_PROCESS_TYPE = "Standard";

/**
 * ProcessType values that put a job in the throttled band.
 *
 * Apple documents `Background` as "not visible to the user, may be throttled".
 * A job whose correctness depends on firing ON TIME — a scheduler, a watchdog,
 * a memory guard — must never ask for it.
 */
export const THROTTLED_PROCESS_TYPES: readonly string[] = ["Background"];

/** Read the `ProcessType` value out of a rendered or on-disk plist. */
export function readProcessType(plistXml: string): string | null {
  const m = plistXml.match(/<key>ProcessType<\/key>\s*<string>([^<]*)<\/string>/);
  return m ? m[1]!.trim() : null;
}

/**
 * True only for a value we READ and recognised as throttled.
 *
 * `null` means the plist had no ProcessType key, or could not be read. That is
 * "I did not judge", not "it is fine", and callers must not render it as a
 * clean result.
 */
export function isThrottledProcessType(value: string | null): boolean {
  return value != null && THROTTLED_PROCESS_TYPES.includes(value);
}

/**
 * The shell wrapper launchd runs instead of the daemon binary, when present.
 *
 * The daemon needs two things that a plist cannot carry safely or cannot carry
 * at all:
 *
 * 1. `CLAUDE_CODE_OAUTH_TOKEN`, resolved at start time from `lastsecrets`. A
 *    secret must not be written into a world-readable plist, and the in-process
 *    resolver reaches the LOCKED login keychain from inside the daemon, so
 *    every claude leg 401s and re-arms `harness-outage-claude`.
 * 2. `ROUTINES_FALLBACK_CHAIN`, whose source of truth is `local-env.sh`. On
 *    2026-09-07 that file called itself the single source of truth and nothing
 *    sourced it; the live daemon carried 14 variables and none was the chain.
 *
 * A wrapper resolves both in a shell, before `exec`, so the value never lands
 * on disk. This generator therefore names the wrapper when it exists. Before
 * this, `renderPlist` always emitted `dist/routines daemon`, so every
 * `hygiene --ff-install` fast-forward silently reverted the daemon to a
 * credential-less launch and fenced 71 of 73 routines into `safe_skip`.
 *
 * See papercut-routines-plist-generator-fix-never-reaches-the-live-launchagent-20260905.
 */
export function routinesdLaunchWrapperPath(home: string = routinesHome()): string {
  return join(home, "daemon", "routinesd-launch.sh");
}

/** True only for a wrapper that exists AND launchd could actually execute. */
export function isExecutableWrapper(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Read `ROUTINES_FALLBACK_CHAIN` out of `~/.routines/daemon/local-env.sh`.
 *
 * `local-env.sh` is the declared source of truth for the chain, so the plist
 * must agree with it rather than with whatever the installing shell happened
 * to export. Returns `null` when the file is missing or names no chain — that
 * is "not stated here", not "empty chain", and callers fall back to the
 * environment.
 */
export function readFallbackChainFromLocalEnv(home: string = routinesHome()): string | null {
  const path = join(home, "daemon", "local-env.sh");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseFallbackChainAssignment(text);
}

/** Last `ROUTINES_FALLBACK_CHAIN=` assignment in a shell fragment, unquoted. */
export function parseFallbackChainAssignment(shell: string): string | null {
  let found: string | null = null;
  for (const line of shell.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^(?:export\s+)?ROUTINES_FALLBACK_CHAIN=(.*)$/);
    if (!m) continue;
    let value = m[1]!.trim();
    // Strip one matching quote pair; a `${VAR:-default}` form is not a literal
    // chain and must not be written into the plist as one.
    const quoted = value.match(/^"([^"]*)"$/) ?? value.match(/^'([^']*)'$/);
    if (quoted) value = quoted[1]!;
    if (!value || value.includes("$")) continue;
    found = value;
  }
  return found;
}

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export interface PlistOptions {
  /** Absolute path to the `routines` entrypoint (the CLI file or shim). */
  program: string;
  /** Runtime that runs the entrypoint (default: the current bun/node exec). */
  runtime?: string;
  /** The program is already a standalone executable; do not prepend a runtime. */
  direct?: boolean;
  /**
   * The program is the launch wrapper, which appends `daemon` itself.
   *
   * A wrapper `exec`s the daemon with its own argument list, so launchd must
   * not append a second `daemon` word after the script path.
   */
  wrapper?: boolean;
  /** Extra env to inject (e.g. LASTGIT_SOCKET, ROUTINES_HOME). */
  env?: Record<string, string>;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderPlist(opts: PlistOptions): string {
  const runtime = opts.runtime ?? process.execPath;
  const logDir = daemonLogDir();
  const args = opts.wrapper
    ? [opts.program]
    : opts.direct
      ? [opts.program, "daemon"]
      : [runtime, opts.program, "daemon"];
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
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>${SCHEDULER_PROCESS_TYPE}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, "routinesd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, "routinesd.err.log"))}</string>
</dict>
</plist>
`;
}

/**
 * Build launchd options for either a source CLI or Bun's compiled executable.
 *
 * A compiled Bun program reports an embedded `/$bunfs/...` argv[1]. Passing
 * that pseudo-path back to the binary makes it look like a user argument, so
 * launchd must execute process.execPath directly instead.
 */
export function plistOptionsForEntrypoint(opts: {
  execPath: string;
  entrypoint: string;
  env?: Record<string, string>;
  /** Wrapper to prefer. Defaults to the live one; pass `null` to ignore it. */
  wrapperPath?: string | null;
  /** Seam: decides whether the wrapper is runnable. Tests inject this. */
  wrapperIsExecutable?: (path: string) => boolean;
}): PlistOptions {
  // The wrapper wins over both binary forms. It ends in `exec …/current/dist/
  // routines daemon`, so launchd still supervises the same process; it only
  // gains the env that a plist cannot carry. Resolving it here — not in
  // `renderPlist` — keeps the renderer pure and every caller consistent.
  const wrapper =
    opts.wrapperPath === undefined ? routinesdLaunchWrapperPath() : opts.wrapperPath;
  const isExecutable = opts.wrapperIsExecutable ?? isExecutableWrapper;
  if (wrapper && isExecutable(wrapper)) {
    return { program: wrapper, direct: true, wrapper: true, env: opts.env };
  }
  if (opts.entrypoint.startsWith("/$bunfs/") || opts.entrypoint.startsWith("$bunfs/")) {
    return { program: stableHostTrackExecutable(opts.execPath), direct: true, env: opts.env };
  }
  return {
    program: opts.entrypoint,
    runtime: opts.execPath,
    env: opts.env,
  };
}

/**
 * Keep launchd on the stable host-track `current` link, not one version tree.
 *
 * A running daemon can outlive artifact pruning. If its plist names the old
 * immutable version, KeepAlive cannot execute that missing path after a later
 * SIGTERM. The app-specific current link always resolves to the active build.
 */
export function stableHostTrackExecutable(execPath: string): string {
  const normalized = execPath.replace(/\\/g, "/");
  return normalized.replace(
    /(\/\.host-track\/apps\/routines)\/versions\/[0-9a-f]{64}\//,
    "$1/current/",
  );
}

export interface InstallResult {
  plistPath: string;
  loaded: boolean;
  message: string;
}

export function writePlist(opts: PlistOptions): string {
  const p = plistPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(daemonLogDir(), { recursive: true });
  writeFileSync(p, renderPlist(opts));
  return p;
}

export type LaunchctlRunner = (args: string[]) => void;

function systemLaunchctl(args: string[]): void {
  execFileSync("launchctl", args, { stdio: "pipe" });
}

function daemonLoaded(uid: number, runLaunchctl: LaunchctlRunner): boolean {
  try {
    runLaunchctl(["print", `gui/${uid}/${LAUNCHD_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

/** Reload a daemon plist and recover if the first bootstrap loses the job. */
export function reloadDaemonPlist(
  p: string,
  uid: number,
  runLaunchctl: LaunchctlRunner = systemLaunchctl,
): Pick<InstallResult, "loaded" | "message"> {
  const domain = `gui/${uid}`;
  const service = `${domain}/${LAUNCHD_LABEL}`;
  try {
    runLaunchctl(["bootout", service]);
  } catch {
    /* not loaded yet */
  }

  const errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      runLaunchctl(["bootstrap", domain, p]);
    } catch (err) {
      errors.push(`bootstrap ${attempt}: ${(err as Error).message}`);
    }
    if (daemonLoaded(uid, runLaunchctl)) {
      const recovered = attempt > 1 || errors.length > 0 ? " after retry" : "";
      return { loaded: true, message: `bootstrapped ${service}${recovered}` };
    }
  }

  // `load -w` is the compatibility recovery path for a failed modern
  // bootstrap. Verify the service after it returns; command success alone is
  // not enough because the original incident left the plist but lost the job.
  try {
    runLaunchctl(["load", "-w", p]);
  } catch (err) {
    errors.push(`load: ${(err as Error).message}`);
  }
  if (daemonLoaded(uid, runLaunchctl)) {
    return { loaded: true, message: `loaded ${service} with compatibility recovery` };
  }

  return {
    loaded: false,
    message: `could not load ${service}: ${errors.join("; ") || "launchctl did not register the service"}`,
  };
}

export function installDaemon(opts: PlistOptions): InstallResult {
  const p = writePlist(opts);
  const uid = process.getuid?.() ?? 0;
  return { plistPath: p, ...reloadDaemonPlist(p, uid) };
}

export function uninstallDaemon(): InstallResult {
  const p = plistPath();
  const uid = process.getuid?.() ?? 0;
  let msg = "";
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: "pipe" });
    msg = `booted out gui/${uid}/${LAUNCHD_LABEL}`;
  } catch (err) {
    msg = `bootout skipped: ${(err as Error).message}`;
  }
  return { plistPath: p, loaded: false, message: msg + (existsSync(p) ? ` (plist left at ${p})` : "") };
}
