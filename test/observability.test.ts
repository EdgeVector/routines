import { describe, expect, test } from "bun:test";

import { initRoutinesSentry } from "../src/observability.ts";

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
