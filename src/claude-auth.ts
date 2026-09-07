// Claude harness credential path that does not depend on the macOS login
// keychain.
//
// Claude Code on macOS keeps its OAuth credential in the keychain item
// "Claude Code-credentials". When the login keychain refuses reads
// (`security find-generic-password -w` exits 51 = errSecAuthFailed, item
// present, no stderr) the CLI has no usable credential, the API answers 401
// `authentication_failed`, and the outage classifier reports an expired token
// with the remedy "run claude /login" — an interactive fix that the next
// lockout undoes (2026-09-06, brain
// papercut-claude-harness-oauth-401-is-a-locked-keychain-read-not-an-expired-token-20260906).
//
// Resolution order for the child env, first non-empty wins:
//   1. CLAUDE_CODE_OAUTH_TOKEN already in the daemon env      → source "env"
//   2. `lastsecrets get <slug>` for ROUTINES_CLAUDE_OAUTH_LOCATOR
//      (default lastsecrets://claude-code-oauth-token)         → source "lastsecrets"
//   3. nothing: the child falls back to Claude Code's own store → "keychain-default"
//
// CLAUDE_CODE_OAUTH_TOKEN is the token `claude setup-token` mints for headless
// use; it bills the Claude subscription, not the Console API meter. The
// subscription-only rule (brain preference-claude-cli-subscription-only-no-api-key)
// is untouched: this module never sets ANTHROPIC_API_KEY, and
// ~/.routines/daemon/local-env.sh keeps unsetting it.
//
// The token value is never logged. Only the source label is recorded.

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ClaudeAuthSource = "env" | "lastsecrets" | "keychain-default";

/**
 * WHY the resolution ended where it did.
 *
 * `source` alone says where the credential came from and never says why it did
 * not come from somewhere better. On 2026-09-07 every failed leg collapsed to
 * `keychain-default`, which is what a locked keychain, a disabled locator and a
 * silently-empty secret store all look like from the outside. Two separate
 * investigations measured the daemon leg correctly and still could not explain
 * it, because the one field that would have named the cause did not exist.
 *
 * These are causes, not places:
 *   env-token            the daemon env already carried a usable token
 *   locator-disabled     ROUTINES_CLAUDE_OAUTH_LOCATOR is off/empty by choice
 *   locator-unsupported  the locator is not a lastsecrets:// URL
 *   lastsecrets-hit      the store returned a value
 *   lastsecrets-empty    the store answered with NOTHING and did not fail —
 *                        the 2026-09-07 shape exactly
 *   lastsecrets-error    the lookup threw, timed out, or the binary is absent
 */
export type ClaudeAuthReason =
  | "env-token"
  | "locator-disabled"
  | "locator-unsupported"
  | "lastsecrets-hit"
  | "lastsecrets-empty"
  | "lastsecrets-error";

/**
 * Environment variables removed before `lastsecrets` is executed.
 *
 * Measured 2026-09-07: `lastsecrets get <slug>` writes NOTHING to stdout and
 * exits 0 whenever OBS_SENTRY_DSN is set, printing only "OBS_SENTRY_DSN is set
 * but @sentry/node is not installed" to stderr. Same slug, same shell: 109
 * bytes without the variable, 0 bytes with it, rc=0 both times. The routinesd
 * LaunchAgent set that variable, so every lookup the daemon made returned a
 * false success with no value, and the whole LLM fleet went dark for 3h15m.
 *
 * EdgeVector/lastsecrets PR 8 removed the trigger. This scrub is the second
 * layer: a telemetry variable must not be able to decide whether a credential
 * resolves, whatever any future version of that binary does with it.
 */
export const LASTSECRETS_SCRUBBED_ENV_PREFIXES = ["OBS_SENTRY_"] as const;

/** A copy of `env` with the telemetry variables above removed. */
export function scrubLastsecretsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (LASTSECRETS_SCRUBBED_ENV_PREFIXES.some((prefix) => k.startsWith(prefix))) continue;
    out[k] = v;
  }
  return out;
}

export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const DEFAULT_CLAUDE_OAUTH_LOCATOR = "lastsecrets://claude-code-oauth-token";
/** Keychain item Claude Code uses on macOS for its OAuth credential. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
/** `security` exit code for OSStatus -25293 errSecAuthFailed (low byte 0x33). */
export const SECURITY_AUTH_FAILED_EXIT = 51;

export interface ClaudeAuthDeps {
  /** Override the locator resolver (tests). Return undefined on miss. */
  resolveSecret?: (locator: string) => string | undefined;
  /** Override the keychain probe (tests). */
  keychainReadRefused?: () => boolean;
  /** Override the lastsecrets binary (tests). */
  lastsecretsBin?: string;
  /** Override the platform check (tests). */
  platform?: NodeJS.Platform;
}

export interface ClaudeAuthResolution {
  /** Env patch to merge into the claude child env (empty when nothing changed). */
  env: Record<string, string>;
  source: ClaudeAuthSource;
  /** Why the resolution landed on `source`. Never a value, always a cause. */
  reason: ClaudeAuthReason;
  /** The locator consulted (or that would be consulted), for logs. Never a value. */
  locator: string;
}

/**
 * The locator routinesd reads for the Claude harness. `ROUTINES_CLAUDE_OAUTH_LOCATOR`
 * overrides it; an explicit empty string / `0` / `off` disables the LastSecrets
 * lookup entirely (the child then uses Claude Code's own credential store).
 */
export function claudeOAuthLocator(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ROUTINES_CLAUDE_OAUTH_LOCATOR;
  if (raw === undefined) return DEFAULT_CLAUDE_OAUTH_LOCATOR;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "0" || trimmed.toLowerCase() === "off") return "";
  return trimmed;
}

function lastsecretsBinary(deps: ClaudeAuthDeps, env: NodeJS.ProcessEnv): string | null {
  if (deps.lastsecretsBin) return deps.lastsecretsBin;
  // Same gate as the harness binaries, in both directions: a test shell must
  // not leak a stub into the production daemon, and a test shell (gate on)
  // must never reach the production secret store — with the gate on, only an
  // explicit ROUTINES_LASTSECRETS_BIN is consulted.
  if (env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES === "1") {
    const override = env.ROUTINES_LASTSECRETS_BIN?.trim();
    return override ? override : null;
  }
  return "lastsecrets";
}

/**
 * Outcome of one locator lookup. `value` is undefined on every non-hit; the
 * reason says which non-hit it was, because "empty" and "threw" need different
 * fixes and used to be indistinguishable.
 */
interface LocatorLookup {
  value?: string;
  reason: ClaudeAuthReason;
}

async function resolveLocator(
  locator: string,
  deps: ClaudeAuthDeps,
  env: NodeJS.ProcessEnv,
): Promise<LocatorLookup> {
  if (deps.resolveSecret) {
    const injected = deps.resolveSecret(locator);
    return injected === undefined || injected === ""
      ? { reason: "lastsecrets-empty" }
      : { value: injected, reason: "lastsecrets-hit" };
  }
  const prefix = "lastsecrets://";
  if (!locator.startsWith(prefix)) return { reason: "locator-unsupported" };
  const slug = locator.slice(prefix.length).trim();
  if (!slug) return { reason: "locator-unsupported" };
  const bin = lastsecretsBinary(deps, env);
  if (!bin) return { reason: "lastsecrets-error" };
  try {
    // Async on purpose: this runs on the daemon event loop right before a
    // dispatch, and a busy LastDB node can take a second or more to answer.
    // A synchronous call here delayed other routines' timeout timers.
    // stderr → ignore: a "secret not found" message must not reach run logs
    // where it could be mistaken for the value; stdout is the value itself and
    // is consumed here only.
    const { stdout } = await execFileAsync(bin, ["get", slug], {
      encoding: "utf8",
      timeout: 15_000,
      // Scrubbed: see LASTSECRETS_SCRUBBED_ENV_PREFIXES. A telemetry variable
      // in the daemon env must not decide whether this returns a value.
      env: scrubLastsecretsEnv(env),
    });
    // An empty stdout with a zero exit is a MISS, and it is the miss that took
    // the fleet down. Name it, so no caller has to infer it from the absence
    // of a token.
    return cleanToken(stdout).length > 0
      ? { value: stdout, reason: "lastsecrets-hit" }
      : { reason: "lastsecrets-empty" };
  } catch {
    return { reason: "lastsecrets-error" };
  }
}

/** Strip CR/LF only — a trailing newline in the token is a silent 401. */
function cleanToken(raw: string | undefined): string {
  return (raw ?? "").replace(/[\r\n]+/g, "");
}

/**
 * Resolve the Claude harness credential for one child spawn. Pure with
 * respect to `base`: returns a patch, never mutates.
 */
export async function resolveClaudeAuthEnv(
  base: NodeJS.ProcessEnv,
  deps: ClaudeAuthDeps = {},
): Promise<ClaudeAuthResolution> {
  const locator = claudeOAuthLocator(base);
  const fromEnv = cleanToken(base[CLAUDE_OAUTH_TOKEN_ENV]);
  if (fromEnv.length > 0) {
    // Re-export the cleaned value so a CRLF pasted into launchd env cannot
    // reach the child as a broken bearer.
    return {
      env: fromEnv === base[CLAUDE_OAUTH_TOKEN_ENV] ? {} : { [CLAUDE_OAUTH_TOKEN_ENV]: fromEnv },
      source: "env",
      reason: "env-token",
      locator,
    };
  }
  if (!locator) {
    return { env: {}, source: "keychain-default", reason: "locator-disabled", locator };
  }
  const lookup = await resolveLocator(locator, deps, base);
  const fromStore = cleanToken(lookup.value);
  if (fromStore.length > 0) {
    return {
      env: { [CLAUDE_OAUTH_TOKEN_ENV]: fromStore },
      source: "lastsecrets",
      reason: "lastsecrets-hit",
      locator,
    };
  }
  return { env: {}, source: "keychain-default", reason: lookup.reason, locator };
}

/**
 * True when the login keychain refuses to hand out the Claude Code credential
 * (exit 51, errSecAuthFailed). The item's existence is not checked: a missing
 * item exits 44 and is a real "not logged in", not a lockout.
 *
 * The password itself is never captured: stdout goes to /dev/null.
 */
export function claudeKeychainReadRefused(
  deps: ClaudeAuthDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (deps.keychainReadRefused) return deps.keychainReadRefused();
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return false;
  // Same gate as the harness binaries: with overrides allowed (test shells),
  // the host keychain is never probed unless ROUTINES_SECURITY_BIN names a
  // stub. Otherwise the fallback tests classify by whatever state the
  // developer's login keychain happens to be in.
  let bin = "security";
  if (env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES === "1") {
    const override = env.ROUTINES_SECURITY_BIN?.trim();
    if (!override) return false;
    bin = override;
  }
  try {
    const res = spawnSync(
      bin,
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 },
    );
    return res.status === SECURITY_AUTH_FAILED_EXIT;
  } catch {
    return false;
  }
}

/**
 * One-line log token; safe for run logs and Situations.
 *
 * The reason travels with the source. A line that says only where the
 * credential came from cannot be read backwards to why, and that is the gap
 * this whole module was extended to close.
 */
export function formatClaudeAuthSource(r: ClaudeAuthResolution): string {
  return `claude_auth_source=${r.source} claude_auth_reason=${r.reason}`;
}
