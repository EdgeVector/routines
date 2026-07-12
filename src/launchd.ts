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
  const args = [runtime, opts.program, "daemon"];
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

export function installDaemon(opts: PlistOptions): InstallResult {
  const p = writePlist(opts);
  // Prefer modern `bootstrap`; fall back to legacy `load`.
  const uid = process.getuid?.() ?? 0;
  try {
    // Unload first so re-install is idempotent.
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
    } catch {
      /* not loaded yet */
    }
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, p], { stdio: "pipe" });
    return { plistPath: p, loaded: true, message: `bootstrapped gui/${uid}/${LAUNCHD_LABEL}` };
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
