import { describe, expect, test } from "bun:test";

import {
  isThrottledProcessType,
  LAUNCHD_LABEL,
  plistOptionsForEntrypoint,
  readProcessType,
  reloadDaemonPlist,
  renderPlist,
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
      const plist = renderPlist(plistOptionsForEntrypoint(opts));
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
