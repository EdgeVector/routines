import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseEntry } from "../src/registry.ts";
import {
  buildDispatchEnvelope,
  buildRoutineAttributionEnv,
  ensureMemoryPath,
  formatAttributionTrailers,
  resolveDispatchPrompt,
  routineActor,
} from "../src/prompt.ts";

const prevHome = process.env.ROUTINES_HOME;
let tmp: string | undefined;

afterEach(() => {
  if (prevHome === undefined) delete process.env.ROUTINES_HOME;
  else process.env.ROUTINES_HOME = prevHome;
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("dispatch prompt envelope", () => {
  test("ensureMemoryPath creates parent dir", () => {
    tmp = mkdtempSync(join(tmpdir(), "routines-mem-"));
    process.env.ROUTINES_HOME = tmp;
    const p = ensureMemoryPath("last-stack-fkanban-pickup");
    expect(p).toBe(join(tmp, "memory", "last-stack-fkanban-pickup", "memory.md"));
    expect(existsSync(join(tmp, "memory", "last-stack-fkanban-pickup"))).toBe(true);
  });

  test("resolveDispatchPrompt prepends Automation ID + memory path", () => {
    tmp = mkdtempSync(join(tmpdir(), "routines-mem-"));
    process.env.ROUTINES_HOME = tmp;
    process.env.ROUTINES_SKIP_NOTICES = "1";
    const entry = parseEntry(
      ['harness = "codex"', 'model = "m1"', 'rrule = "FREQ=HOURLY"', 'prompt = "Do work."'].join("\n"),
      join(tmp, "last-stack-fkanban-pickup.toml"),
    );
    const text = resolveDispatchPrompt(entry);
    expect(text).toContain("Automation ID: last-stack-fkanban-pickup");
    expect(text).toContain(
      `Automation memory: ${join(tmp, "memory", "last-stack-fkanban-pickup", "memory.md")}`,
    );
    expect(text).toContain("Do work.");
    expect(text).toContain("Situations notices");
    expect(text).toContain("Driven-By: routine");
    expect(text).toContain("Automation-Id: last-stack-fkanban-pickup");
    expect(text).toContain("Attribution (required");
    expect(text.indexOf("Dispatch envelope")).toBeLessThan(text.indexOf("Do work."));
  });

  test("envelope includes run directory and Run-Id when provided", () => {
    const runDir = "/tmp/runs/last-stack-fkanban-pickup/2026-07-16T12-00-00-000Z";
    const env = buildDispatchEnvelope({ id: "last-stack-fkanban-pickup" } as never, "/tmp/m.md", {
      noticesBanner: "## Situations notices (FYI, non-blocking)\n\nNo notices.\n",
      runDir,
    });
    expect(env).toContain(`Run directory: ${runDir}`);
    expect(env).toContain("Run-Id: 2026-07-16T12-00-00-000Z");
  });

  test("envelope names the memory path agents must use", () => {
    const env = buildDispatchEnvelope({ id: "x" } as never, "/tmp/x/memory.md", {
      noticesBanner: "## Situations notices (FYI, non-blocking)\n\nNo notices in the last 2h.\n",
    });
    expect(env).toContain("Automation ID: x");
    expect(env).toContain("Automation memory: /tmp/x/memory.md");
    expect(env).toContain("Do not invent");
    expect(env).toContain("No notices in the last 2h");
  });

  test("envelope injects provided notices banner", () => {
    const env = buildDispatchEnvelope({ id: "y" } as never, "/tmp/y/memory.md", {
      noticesBanner:
        "## Situations notices (FYI, non-blocking — last 2h)\n\n- [upgrade] LastDB upgraded\n",
    });
    expect(env).toContain("[upgrade] LastDB upgraded");
    expect(env.indexOf("Situations notices")).toBeLessThan(env.indexOf("---"));
  });
});

describe("routine-fleet-health prompt", () => {
  test("keeps transport-only board write failures non-red after a healthy snapshot", () => {
    const prompt = readFileSync(
      new URL("../prompts/routine-fleet-health.md", import.meta.url),
      "utf8",
    );

    expect(prompt).toContain("board/brain write failure is **transport backpressure**");
    expect(prompt).toContain("board_write_deferred=<n>");
    expect(prompt).toContain("Do not turn a healthy");
    expect(prompt).toContain("only board/brain follow-up writes were deferred");
  });

  test("treats harness-outage situations as read-only detector-owned state", () => {
    const prompt = readFileSync(
      new URL("../prompts/routine-fleet-health.md", import.meta.url),
      "utf8",
    );

    expect(prompt).toContain("Harness-outage Situations are detector-owned");
    expect(prompt).toContain("must never run `situations");
    expect(prompt).toContain("harness-outage-*");
    expect(prompt).toContain("must be allowed to");
    expect(prompt).toContain("expire");
    expect(prompt).toContain("do not refresh its `updated_at` / `expires_at`");
  });

  test("does not treat permission-denied kill probes as stale locks", () => {
    const prompt = readFileSync(
      new URL("../prompts/routine-fleet-health.md", import.meta.url),
      "utf8",
    );

    expect(prompt).toContain("Operation not permitted");
    expect(prompt).toContain("EPERM");
    expect(prompt).toContain("is **not** dead-pid proof");
    expect(prompt).toContain("status:\"running\"");
    expect(prompt).toContain("No such");
    expect(prompt).toContain("process` / ESRCH");
  });
});

describe("routine attribution env + trailers", () => {
  test("routineActor prefixes id", () => {
    expect(routineActor("last-stack-fkanban-pickup")).toBe("routine:last-stack-fkanban-pickup");
  });

  test("buildRoutineAttributionEnv sets LastGit actor and driven-by", () => {
    const env = buildRoutineAttributionEnv(
      "last-stack-fkanban-pickup",
      "/home/t/.routines/runs/last-stack-fkanban-pickup/2026-07-16T12-00-00-000Z",
    );
    expect(env.DRIVEN_BY).toBe("routine");
    expect(env.AUTOMATION_ID).toBe("last-stack-fkanban-pickup");
    expect(env.LASTGIT_ACTOR).toBe("routine:last-stack-fkanban-pickup");
    expect(env.ROUTINES_RUN_DIR).toContain("last-stack-fkanban-pickup");
    expect(env.ROUTINES_RUN_ID).toBe("2026-07-16T12-00-00-000Z");
  });

  test("formatAttributionTrailers is stable machine text", () => {
    expect(formatAttributionTrailers({ automationId: "x", runId: "rid" })).toBe(
      ["Driven-By: routine", "Automation-Id: x", "Run-Id: rid"].join("\n"),
    );
    expect(formatAttributionTrailers({ automationId: "x" })).toBe(
      ["Driven-By: routine", "Automation-Id: x"].join("\n"),
    );
  });
});
