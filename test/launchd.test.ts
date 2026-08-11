import { describe, expect, test } from "bun:test";

import { plistOptionsForEntrypoint, renderPlist } from "../src/launchd.ts";

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
});
