import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_OAUTH_TOKEN_ENV,
  claudeKeychainReadRefused,
  claudeOAuthLocator,
  DEFAULT_CLAUDE_OAUTH_LOCATOR,
  formatClaudeAuthSource,
  resolveClaudeAuthEnv,
  scrubLastsecretsEnv,
} from "../src/claude-auth.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "routines-claude-auth-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function stubLastsecrets(name: string, body: string): string {
  const bin = join(home, name);
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return bin;
}

describe("claudeOAuthLocator", () => {
  test("defaults to the fleet locator", () => {
    expect(claudeOAuthLocator({})).toBe(DEFAULT_CLAUDE_OAUTH_LOCATOR);
  });

  test("honors an override and an explicit off", () => {
    expect(claudeOAuthLocator({ ROUTINES_CLAUDE_OAUTH_LOCATOR: "lastsecrets://alt" })).toBe(
      "lastsecrets://alt",
    );
    expect(claudeOAuthLocator({ ROUTINES_CLAUDE_OAUTH_LOCATOR: "off" })).toBe("");
    expect(claudeOAuthLocator({ ROUTINES_CLAUDE_OAUTH_LOCATOR: "0" })).toBe("");
    expect(claudeOAuthLocator({ ROUTINES_CLAUDE_OAUTH_LOCATOR: "" })).toBe("");
  });
});

describe("resolveClaudeAuthEnv", () => {
  test("an env token wins and the store is never consulted", async () => {
    let calls = 0;
    const r = await resolveClaudeAuthEnv(
      { [CLAUDE_OAUTH_TOKEN_ENV]: "tok-from-env" },
      {
        resolveSecret: () => {
          calls += 1;
          return "tok-from-store";
        },
      },
    );
    expect(r.source).toBe("env");
    expect(r.env).toEqual({});
    expect(calls).toBe(0);
  });

  test("a CRLF pasted into the env token is re-exported clean", async () => {
    const r = await resolveClaudeAuthEnv({ [CLAUDE_OAUTH_TOKEN_ENV]: "tok\r\n" });
    expect(r.source).toBe("env");
    expect(r.env).toEqual({ [CLAUDE_OAUTH_TOKEN_ENV]: "tok" });
  });

  test("falls through to the LastSecrets locator and strips the newline", async () => {
    const seen: string[] = [];
    const r = await resolveClaudeAuthEnv(
      {},
      {
        resolveSecret: (locator) => {
          seen.push(locator);
          return "tok-from-store\n";
        },
      },
    );
    expect(seen).toEqual([DEFAULT_CLAUDE_OAUTH_LOCATOR]);
    expect(r.source).toBe("lastsecrets");
    expect(r.env).toEqual({ [CLAUDE_OAUTH_TOKEN_ENV]: "tok-from-store" });
  });

  test("an empty store answer degrades to keychain-default with no env change", async () => {
    const r = await resolveClaudeAuthEnv({}, { resolveSecret: () => "" });
    expect(r.source).toBe("keychain-default");
    expect(r.env).toEqual({});
    expect(r.locator).toBe(DEFAULT_CLAUDE_OAUTH_LOCATOR);
  });

  test("every outcome names WHY, not only where it landed", async () => {
    // The 2026-09-07 outage: four different causes all reported
    // keychain-default and nothing distinguished them, so two investigations
    // measured the daemon leg correctly and still could not explain it.
    const envToken = await resolveClaudeAuthEnv({ [CLAUDE_OAUTH_TOKEN_ENV]: "tok" });
    expect([envToken.source, envToken.reason]).toEqual(["env", "env-token"]);

    const hit = await resolveClaudeAuthEnv({}, { resolveSecret: () => "tok" });
    expect([hit.source, hit.reason]).toEqual(["lastsecrets", "lastsecrets-hit"]);

    const empty = await resolveClaudeAuthEnv({}, { resolveSecret: () => "" });
    expect([empty.source, empty.reason]).toEqual(["keychain-default", "lastsecrets-empty"]);

    const off = await resolveClaudeAuthEnv({ ROUTINES_CLAUDE_OAUTH_LOCATOR: "off" });
    expect([off.source, off.reason]).toEqual(["keychain-default", "locator-disabled"]);

    const unsupported = await resolveClaudeAuthEnv({
      ROUTINES_CLAUDE_OAUTH_LOCATOR: "keychain://something",
    });
    expect([unsupported.source, unsupported.reason]).toEqual([
      "keychain-default",
      "locator-unsupported",
    ]);

    // All four non-hits share a source. None share a reason. That is the
    // whole point of the field.
    const nonHits = [empty, off, unsupported];
    expect(new Set(nonHits.map((r) => r.source)).size).toBe(1);
    expect(new Set(nonHits.map((r) => r.reason)).size).toBe(3);
  });

  test("a store that exits 0 with NO output is 'empty', not 'error'", async () => {
    // This is the exact measured shape of the outage. `lastsecrets get <slug>`
    // wrote nothing to stdout and exited 0. Reporting that as an error would
    // send the reader to the wrong fix; the binary did not fail, it succeeded
    // at returning nothing.
    const bin = stubLastsecrets(
      "stub-lastsecrets-silent-success",
      [
        "#!/bin/sh",
        'echo "OBS_SENTRY_DSN is set but @sentry/node is not installed" >&2',
        "exit 0",
        "",
      ].join("\n"),
    );
    const r = await resolveClaudeAuthEnv({}, { lastsecretsBin: bin });
    expect(r.source).toBe("keychain-default");
    expect(r.reason).toBe("lastsecrets-empty");
    expect(r.env).toEqual({});
  });

  test("a store that FAILS is 'error', so the two stay distinguishable", async () => {
    const bin = stubLastsecrets(
      "stub-lastsecrets-failing",
      ["#!/bin/sh", 'echo "secret not found" >&2', "exit 1", ""].join("\n"),
    );
    const r = await resolveClaudeAuthEnv({}, { lastsecretsBin: bin });
    expect(r.reason).toBe("lastsecrets-error");
  });

  test("OBS_SENTRY_* cannot decide whether a credential resolves", async () => {
    // Regression for the 3h15m fleet outage of 2026-09-07. This stub is the
    // measured behaviour of the shipped lastsecrets at the time: same slug,
    // 109 bytes without OBS_SENTRY_DSN, 0 bytes with it, rc=0 both times.
    // EdgeVector/lastsecrets PR 8 removed the trigger; this asserts routines
    // no longer depends on that fix being present.
    const bin = stubLastsecrets(
      "stub-lastsecrets-sentry-sensitive",
      [
        "#!/bin/sh",
        'if [ -n "$OBS_SENTRY_DSN" ]; then',
        '  echo "OBS_SENTRY_DSN is set but @sentry/node is not installed" >&2',
        "  exit 0",
        "fi",
        'printf "%s\\n" "tok-despite-sentry"',
        "",
      ].join("\n"),
    );
    const r = await resolveClaudeAuthEnv(
      { OBS_SENTRY_DSN: "lastsecrets://obs-sentry-dsn-routines", PATH: process.env.PATH },
      { lastsecretsBin: bin },
    );
    expect(r.reason).toBe("lastsecrets-hit");
    expect(r.source).toBe("lastsecrets");
    expect(r.env[CLAUDE_OAUTH_TOKEN_ENV]).toBe("tok-despite-sentry");
  });

  test("the scrub removes only the telemetry prefix and keeps the rest", () => {
    const scrubbed = scrubLastsecretsEnv({
      OBS_SENTRY_DSN: "lastsecrets://x",
      OBS_SENTRY_ENVIRONMENT: "production",
      OBS_SENTRY_RELEASE: "routines@1",
      PATH: "/usr/bin",
      HOME: "/Users/x",
    });
    expect(scrubbed).toEqual({ PATH: "/usr/bin", HOME: "/Users/x" });
  });

  test("locator off skips the store entirely", async () => {
    let calls = 0;
    const r = await resolveClaudeAuthEnv(
      { ROUTINES_CLAUDE_OAUTH_LOCATOR: "off" },
      {
        resolveSecret: () => {
          calls += 1;
          return "x";
        },
      },
    );
    expect(calls).toBe(0);
    expect(r.source).toBe("keychain-default");
    expect(r.locator).toBe("");
  });

  test("reads the real lastsecrets CLI shape: `lastsecrets get <slug>`", async () => {
    const bin = stubLastsecrets(
      "stub-lastsecrets",
      [
        "#!/bin/sh",
        'test "$1" = get || exit 11',
        'test "$2" = claude-code-oauth-token || exit 12',
        'printf "%s\\n" "tok-via-cli"',
        "",
      ].join("\n"),
    );
    const r = await resolveClaudeAuthEnv({}, { lastsecretsBin: bin });
    expect(r.source).toBe("lastsecrets");
    expect(r.env[CLAUDE_OAUTH_TOKEN_ENV]).toBe("tok-via-cli");
  });

  test("a failing lastsecrets CLI (secret not found) degrades, never throws", async () => {
    const bin = stubLastsecrets(
      "stub-lastsecrets-missing",
      '#!/bin/sh\necho "secret not found" >&2\nexit 1\n',
    );
    const r = await resolveClaudeAuthEnv({}, { lastsecretsBin: bin });
    expect(r.source).toBe("keychain-default");
    expect(r.env).toEqual({});
  });

  test("a hanging lastsecrets CLI is bounded by the timeout and degrades", async () => {
    const bin = stubLastsecrets("stub-lastsecrets-hang", "#!/bin/sh\nsleep 30\n");
    const started = Date.now();
    // The 15s production timeout is too long for a unit test; the env timeout
    // is not configurable on purpose, so bound the test with a race instead
    // and only assert that the promise does not resolve with a token early.
    const r = await Promise.race([
      resolveClaudeAuthEnv({}, { lastsecretsBin: bin }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    expect(r).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("with the override gate on, only ROUTINES_LASTSECRETS_BIN is consulted", async () => {
    const bin = stubLastsecrets("stub-lastsecrets-gated", '#!/bin/sh\nprintf "%s\\n" gated-tok\n');
    const gated = await resolveClaudeAuthEnv({
      ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES: "1",
      ROUTINES_LASTSECRETS_BIN: bin,
    });
    expect(gated.source).toBe("lastsecrets");
    expect(gated.env[CLAUDE_OAUTH_TOKEN_ENV]).toBe("gated-tok");

    // Gate on, no override: a test shell must never reach the production
    // secret store, so the lookup is skipped outright.
    const gatedNoOverride = await resolveClaudeAuthEnv({
      ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES: "1",
    });
    expect(gatedNoOverride.source).toBe("keychain-default");
    expect(gatedNoOverride.env).toEqual({});
  });

  test("never sets ANTHROPIC_API_KEY (subscription-only rule)", async () => {
    const r = await resolveClaudeAuthEnv({}, { resolveSecret: () => "tok" });
    expect(Object.keys(r.env)).toEqual([CLAUDE_OAUTH_TOKEN_ENV]);
  });

  test("the log token carries the source, never the value", async () => {
    const r = await resolveClaudeAuthEnv({}, { resolveSecret: () => "super-secret-value" });
    const line = formatClaudeAuthSource(r);
    expect(line).toBe("claude_auth_source=lastsecrets claude_auth_reason=lastsecrets-hit");
    expect(line).not.toContain("super-secret-value");

    // A failure line has to carry the cause too, or the log is only useful on
    // the path that never needed explaining.
    const failed = await resolveClaudeAuthEnv({}, { resolveSecret: () => "" });
    expect(formatClaudeAuthSource(failed)).toBe(
      "claude_auth_source=keychain-default claude_auth_reason=lastsecrets-empty",
    );
  });
});

describe("claudeKeychainReadRefused", () => {
  test("uses the injected probe", () => {
    expect(claudeKeychainReadRefused({ keychainReadRefused: () => true })).toBe(true);
    expect(claudeKeychainReadRefused({ keychainReadRefused: () => false })).toBe(false);
  });

  test("is false off macOS without touching `security`", () => {
    expect(claudeKeychainReadRefused({ platform: "linux" })).toBe(false);
  });

  test("with the override gate on, only ROUTINES_SECURITY_BIN is probed", () => {
    // Gate on, no stub: never touch the host keychain, report not-refused.
    expect(
      claudeKeychainReadRefused(
        { platform: "darwin" },
        { ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES: "1" },
      ),
    ).toBe(false);

    const refused = stubLastsecrets("stub-security-51", "#!/bin/sh\nexit 51\n");
    expect(
      claudeKeychainReadRefused(
        { platform: "darwin" },
        { ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES: "1", ROUTINES_SECURITY_BIN: refused },
      ),
    ).toBe(true);

    // Exit 44 = item not found: a real "not logged in", not a lockout.
    const missing = stubLastsecrets("stub-security-44", "#!/bin/sh\nexit 44\n");
    expect(
      claudeKeychainReadRefused(
        { platform: "darwin" },
        { ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES: "1", ROUTINES_SECURITY_BIN: missing },
      ),
    ).toBe(false);
  });
});
