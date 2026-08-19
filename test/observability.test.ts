import { describe, expect, test } from "bun:test";

import {
  initRoutinesSentry,
  isLastSecretsLocator,
  stripUnresolvedSentryLocators,
} from "../src/observability.ts";

describe("routines Sentry init", () => {
  test("is a no-op without a DSN", async () => {
    const result = await initRoutinesSentry(
      { service: "routinesd", env: {} },
      {
        helperPath: "/definitely/missing/sentry.ts",
      },
    );

    expect(result).toEqual({ enabled: false, reason: "missing_dsn" });
  });

  test("resolves lastsecrets locator before calling the shared helper", async () => {
    let helperEnv: Record<string, string | undefined> | undefined;
    const result = await initRoutinesSentry(
      { service: "routinesd", env: { OBS_SENTRY_DSN: "lastsecrets://obs-sentry-dsn-routines" } },
      {
        resolveSecret: (locator) => (locator === "lastsecrets://obs-sentry-dsn-routines" ? "https://dsn.example/1" : undefined),
        initSentry: async (opts) => {
          helperEnv = opts.env;
          return { enabled: true };
        },
        captureModule: {},
      },
    );

    expect(result).toEqual({ enabled: true, service: "routinesd" });
    expect(helperEnv?.OBS_SENTRY_DSN).toBe("https://dsn.example/1");
  });

  test("continues without Sentry when lastsecrets resolution fails", async () => {
    const result = await initRoutinesSentry(
      { service: "routinesd", env: { OBS_SENTRY_DSN: "lastsecrets://obs-sentry-dsn-routines" } },
      {
        resolveSecret: () => undefined,
        initSentry: async () => {
          throw new Error("must not call helper");
        },
      },
    );

    expect(result).toEqual({ enabled: false, reason: "lastsecrets_failed" });
  });
});

describe("stripUnresolvedSentryLocators", () => {
  test("treats lastsecrets locators as unresolved", () => {
    expect(isLastSecretsLocator("lastsecrets://obs-sentry-dsn-routines")).toBe(true);
    expect(isLastSecretsLocator("lastsecrets:obs-sentry-dsn-routines")).toBe(true);
    expect(isLastSecretsLocator("https://dsn.example/1")).toBe(false);
    expect(isLastSecretsLocator(undefined)).toBe(false);
  });

  test("omits lastsecrets OBS_SENTRY_DSN and SENTRY_DSN from child env", () => {
    const env = stripUnresolvedSentryLocators({
      PATH: "/usr/bin",
      OBS_SENTRY_DSN: "lastsecrets://obs-sentry-dsn-routines",
      SENTRY_DSN: "lastsecrets://obs-sentry-dsn-routines",
      OBS_SENTRY_ENVIRONMENT: "production",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OBS_SENTRY_ENVIRONMENT).toBe("production");
    expect(env.OBS_SENTRY_DSN).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
    expect("OBS_SENTRY_DSN" in env).toBe(false);
    expect("SENTRY_DSN" in env).toBe(false);
  });

  test("keeps a resolved https DSN", () => {
    const env = stripUnresolvedSentryLocators({
      OBS_SENTRY_DSN: "https://dsn.example/1",
    });
    expect(env.OBS_SENTRY_DSN).toBe("https://dsn.example/1");
  });
});
