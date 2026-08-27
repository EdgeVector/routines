// launchd integration for routinesd.
//
// Unattended loops must survive session exit (never a background subagent), so
// routinesd runs as a launchd user agent. `routines install-daemon` writes the
// plist and bootstraps it; `routines uninstall-daemon` reverses it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { daemonLogDir, routinesHome } from "./paths.ts";

export const LAUNCHD_LABEL = "com.edgevector.routinesd";

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
  const args = opts.direct ? [opts.program, "daemon"] : [runtime, opts.program, "daemon"];
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
  <string>Background</string>
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
}): PlistOptions {
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
