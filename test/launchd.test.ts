import { describe, expect, test } from "bun:test";

import {
  isThrottledProcessType,
  LAUNCHD_LABEL,
  parseFallbackChainAssignment,
  plistOptionsForEntrypoint,
  readProcessType,
  readFallbackChainFromLocalEnv,
  reloadDaemonPlist,
  renderPlist,
  routinesdLaunchWrapperPath,
  SCHEDULER_PROCESS_TYPE,
  THROTTLED_PROCESS_TYPES,
} from "../src/launchd.ts";

function programArguments(plist: string): string[] {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
  return [...block.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]!);
}

describe("routinesd launchd entrypoint", () => {
  test("source entrypoint is run through Bun", () => {
    const opts = plistOptionsForEntrypoint({
      execPath: "/opt/bun/bin/bun",
      entrypoint: "/checkout/src/cli.ts",
      wrapperPath: null,
    });
    expect(programArguments(renderPlist(opts))).toEqual([
      "/opt/bun/bin/bun",
      "/checkout/src/cli.ts",
      "daemon",
    ]);
  });

  test("compiled entrypoint runs the executable directly", () => {
    const opts = plistOptionsForEntrypoint({
      execPath: "/host-track/routines/current/dist/routines",
      entrypoint: "/$bunfs/root/routines",
      wrapperPath: null,
    });
    const args = programArguments(renderPlist(opts));
    expect(args).toEqual(["/host-track/routines/current/dist/routines", "daemon"]);
    expect(args.join(" ")).not.toContain("/$bunfs/");
  });

  test("versioned host-track entrypoint uses the stable current link", () => {
    const digest = "a".repeat(64);
    const opts = plistOptionsForEntrypoint({
      execPath: `/Users/test/.host-track/apps/routines/versions/${digest}/dist/routines`,
      entrypoint: "/$bunfs/root/routines",
      wrapperPath: null,
    });
    expect(programArguments(renderPlist(opts))).toEqual([
      "/Users/test/.host-track/apps/routines/current/dist/routines",
      "daemon",
    ]);
  });
});

describe("routinesd launchd reload", () => {
  test("retries a failed bootstrap and verifies the service", () => {
    const calls: string[][] = [];
    let bootstraps = 0;
    let loaded = false;
    const result = reloadDaemonPlist("/tmp/routinesd.plist", 501, (args) => {
      calls.push(args);
      if (args[0] === "bootout") return;
      if (args[0] === "bootstrap") {
        bootstraps++;
        if (bootstraps === 1) throw new Error("transient bootstrap failure");
        loaded = true;
        return;
      }
      if (args[0] === "print" && !loaded) throw new Error("not loaded");
    });

    expect(result.loaded).toBe(true);
    expect(result.message).toContain("after retry");
    expect(calls.filter(([verb]) => verb === "bootstrap")).toHaveLength(2);
    expect(calls).toContainEqual(["print", `gui/501/${LAUNCHD_LABEL}`]);
  });

  test("uses compatibility load when bootstrap never registers the job", () => {
    let loaded = false;
    const result = reloadDaemonPlist("/tmp/routinesd.plist", 501, (args) => {
      if (args[0] === "bootout") return;
      if (args[0] === "bootstrap") throw new Error("bootstrap failed");
      if (args[0] === "load") {
        loaded = true;
        return;
      }
      if (args[0] === "print" && !loaded) throw new Error("not loaded");
    });

    expect(result.loaded).toBe(true);
    expect(result.message).toContain("compatibility recovery");
  });

  test("reports unloaded when every recovery path fails", () => {
    const result = reloadDaemonPlist("/tmp/routinesd.plist", 501, (args) => {
      if (args[0] === "bootout") return;
      throw new Error(`${args[0]} failed`);
    });

    expect(result.loaded).toBe(false);
    expect(result.message).toContain("bootstrap 1");
    expect(result.message).toContain("bootstrap 2");
    expect(result.message).toContain("load:");
  });
});

describe("launchd QoS band", () => {
  // A scheduler that asks for the throttled band gets coalesced timers, and
  // every other surface still reports it healthy. On 2026-09-05 that cost the
  // fleet four hours of dispatch with `launchctl list` reporting a live pid
  // the whole time. This guard is the reason a generator cannot reintroduce it.
  const entrypoints = [
    { execPath: "/opt/bun/bin/bun", entrypoint: "/checkout/src/cli.ts" },
    {
      execPath: "/host-track/routines/current/dist/routines",
      entrypoint: "/$bunfs/root/routines",
    },
    {
      execPath: `/Users/test/.host-track/apps/routines/versions/${"a".repeat(64)}/dist/routines`,
      entrypoint: "/$bunfs/root/routines",
    },
  ];

  for (const opts of entrypoints) {
    test(`the routinesd plist is not throttled (${opts.entrypoint})`, () => {
      const plist = renderPlist(plistOptionsForEntrypoint({ ...opts, wrapperPath: null }));
      const band = readProcessType(plist);
      expect(band).toBe(SCHEDULER_PROCESS_TYPE);
      expect(isThrottledProcessType(band)).toBe(false);
    });
  }

  test("Background is recognised as throttled", () => {
    expect(THROTTLED_PROCESS_TYPES).toContain("Background");
    expect(isThrottledProcessType("Background")).toBe(true);
    expect(isThrottledProcessType(SCHEDULER_PROCESS_TYPE)).toBe(false);
  });

  test("an unreadable band is not judged clean", () => {
    // `null` means "I did not measure it". It must not read as "fine", which
    // is the exact failure the daemon probe had: loaded pid=N on a job that
    // was firing one tick in twelve minutes.
    expect(readProcessType("<plist><dict></dict></plist>")).toBeNull();
    expect(isThrottledProcessType(null)).toBe(false);
  });

  test("readProcessType reads the value out of a real rendered plist", () => {
    const plist = renderPlist({ program: "/x/routines", runtime: "/x/bun" });
    expect(readProcessType(plist)).toBe(SCHEDULER_PROCESS_TYPE);
    expect(readProcessType(plist.replace(SCHEDULER_PROCESS_TYPE, "Background"))).toBe(
      "Background",
    );
  });
});

function environmentVariables(plist: string): Record<string, string> {
  const block =
    plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  const pairs = [...block.matchAll(/<key>(.*?)<\/key>\s*<string>(.*?)<\/string>/g)];
  return Object.fromEntries(pairs.map((m) => [m[1]!, m[2]!]));
}

const WRAPPER = "/Users/test/.routines/daemon/routinesd-launch.sh";
const CHAIN = "codex:gpt-5.6-terra,claude:sonnet,grok:grok-4.5";

describe("routinesd launch wrapper", () => {
  // The regression this file exists for: `renderPlist` emitted
  // `dist/routines daemon` unconditionally, so every `hygiene --ff-install`
  // fast-forward reverted the daemon to a credential-less launch. The claude
  // leg then 401d on the locked keychain and `harness-outage-claude` fenced 71
  // of 73 routines into `safe_skip`. Both fields are asserted on the RENDERED
  // plist, because the rendered bytes are what launchd reads.
  test("the wrapper becomes ProgramArguments, with no second daemon word", () => {
    const plist = renderPlist(
      plistOptionsForEntrypoint({
        execPath: "/opt/bun/bin/bun",
        entrypoint: "/checkout/src/cli.ts",
        wrapperPath: WRAPPER,
        wrapperIsExecutable: (path) => path === WRAPPER,
      }),
    );
    // The wrapper ends in `exec … daemon`; launchd must not append its own.
    expect(programArguments(plist)).toEqual([WRAPPER]);
  });

  test("the wrapper wins over a compiled host-track entrypoint too", () => {
    const plist = renderPlist(
      plistOptionsForEntrypoint({
        execPath: `/Users/test/.host-track/apps/routines/versions/${"a".repeat(64)}/dist/routines`,
        entrypoint: "/$bunfs/root/routines",
        wrapperPath: WRAPPER,
        wrapperIsExecutable: () => true,
      }),
    );
    expect(programArguments(plist)).toEqual([WRAPPER]);
  });

  test("a missing or non-executable wrapper leaves the binary form intact", () => {
    const plist = renderPlist(
      plistOptionsForEntrypoint({
        execPath: "/opt/bun/bin/bun",
        entrypoint: "/checkout/src/cli.ts",
        wrapperPath: WRAPPER,
        wrapperIsExecutable: () => false,
      }),
    );
    expect(programArguments(plist)).toEqual([
      "/opt/bun/bin/bun",
      "/checkout/src/cli.ts",
      "daemon",
    ]);
  });

  test("the rendered plist carries ROUTINES_FALLBACK_CHAIN", () => {
    const plist = renderPlist(
      plistOptionsForEntrypoint({
        execPath: "/opt/bun/bin/bun",
        entrypoint: "/checkout/src/cli.ts",
        wrapperPath: WRAPPER,
        wrapperIsExecutable: () => true,
        env: { ROUTINES_FALLBACK_CHAIN: CHAIN },
      }),
    );
    expect(environmentVariables(plist).ROUTINES_FALLBACK_CHAIN).toBe(CHAIN);
  });

  test("the wrapper path is under the routines home", () => {
    expect(routinesdLaunchWrapperPath("/Users/test/.routines")).toBe(WRAPPER);
  });
});

describe("ROUTINES_FALLBACK_CHAIN from local-env.sh", () => {
  test("reads the exported assignment", () => {
    expect(parseFallbackChainAssignment(`export ROUTINES_FALLBACK_CHAIN="${CHAIN}"\n`)).toBe(
      CHAIN,
    );
  });

  test("the last assignment wins and comments are ignored", () => {
    const shell = [
      `# export ROUTINES_FALLBACK_CHAIN="claude:sonnet"`,
      `export ROUTINES_FALLBACK_CHAIN="grok:grok-4.5"`,
      `export ROUTINES_FALLBACK_CHAIN='${CHAIN}'`,
    ].join("\n");
    expect(parseFallbackChainAssignment(shell)).toBe(CHAIN);
  });

  test("an unexpanded shell default is not a literal chain", () => {
    // `${VAR:-default}` written into a plist would be run as a chain name.
    expect(
      parseFallbackChainAssignment('export ROUTINES_FALLBACK_CHAIN="${OTHER:-claude:sonnet}"'),
    ).toBeNull();
    expect(parseFallbackChainAssignment('export ROUTINES_FALLBACK_CHAIN=""')).toBeNull();
  });

  test("a missing local-env.sh reads as not-stated, not empty", () => {
    expect(readFallbackChainFromLocalEnv("/nonexistent/routines/home")).toBeNull();
  });
});
