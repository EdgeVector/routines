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
  buildOutcomeCloseout,
  resolveDispatchPrompt,
  routineActor,
} from "../src/prompt.ts";
import { parseOutcome } from "../src/outcome.ts";

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
    expect(text).toContain("Foreground command ownership (required)");
    expect(text).toContain("keep polling that same call until it reaches a");
    expect(text).toContain("A tool's first-yield");
    expect(text).toContain("timeout is not the command's exit status");
    expect(text).toContain("Explicit routine outcome (required)");
    expect(text).toContain('$ROUTINES_RUN_DIR/outcome.txt');
    expect(text).toContain('outcomeSource="sink"');
    expect(text).toContain("legacy");
    expect(text).toContain("ROUTINE_RESULT outcome=...");
    expect(text).toContain("fallback");
    expect(text.indexOf("Dispatch envelope")).toBeLessThan(text.indexOf("Do work."));
    expect(text.indexOf("Foreground command ownership")).toBeLessThan(text.indexOf("Do work."));
    expect(text.indexOf("Explicit routine outcome")).toBeLessThan(text.indexOf("Do work."));
  });

  test("injects the outcome sink contract into the four initial adopter prompts", () => {
    tmp = mkdtempSync(join(tmpdir(), "routines-outcome-sink-"));
    process.env.ROUTINES_HOME = tmp;
    process.env.ROUTINES_SKIP_NOTICES = "1";

    for (const id of [
      "last-stack-fkanban-watch",
      "last-stack-feature-prove",
      "backup-restore-probe",
      "last-stack-pipeline-health",
    ]) {
      const entry = parseEntry(
        ['harness = "codex"', 'model = "m1"', 'rrule = "FREQ=HOURLY"', `prompt = "Run ${id}."`].join(
          "\n",
        ),
        join(tmp, `${id}.toml`),
      );
      const runDir = join(tmp, "runs", id, "2026-08-11T07-20-01-501Z");
      const text = resolveDispatchPrompt(entry, { runDir });

      expect(text).toContain(`Automation ID: ${id}`);
      expect(text).toContain(`Run directory: ${runDir}`);
      expect(text).toContain('$ROUTINES_RUN_DIR/outcome.txt');
      expect(text).toContain('outcomeSource="sink"');
      expect(text).toContain("ROUTINE_RESULT outcome=...");
      expect(text.indexOf("Explicit routine outcome")).toBeLessThan(text.indexOf(`Run ${id}.`));
    }
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

    expect(prompt).toContain("Before deleting or reporting a stale-lock recurrence");
    expect(prompt).toContain("currentRunDir");
    expect(prompt).toContain("`lastRunDir` is the last");
    expect(prompt).toContain("normal runner");
    expect(prompt).toContain("Operation not permitted");
    expect(prompt).toContain("EPERM");
    expect(prompt).toContain("is **not** dead-pid proof");
    expect(prompt).toContain("status:\"running\"");
    expect(prompt).toContain("No such");
    expect(prompt).toContain("process` / ESRCH");
  });

  test("re-proves stale red routine-error cards after likely fix commits land", () => {
    const prompt = readFileSync(
      new URL("../prompts/routine-fleet-health.md", import.meta.url),
      "utf8",
    );

    expect(prompt).toContain("Stale red re-proof before repeating old evidence");
    expect(prompt).toContain("same failed run dir / finished_at");
    expect(prompt).toContain("after the failed run's finished_at");
    expect(prompt).toContain("routines run <id> --quiet");
    expect(prompt).toContain("reproof=no-fix-commit");
    expect(prompt).toContain("PROOF-PENDING: post-failure fix commit seen; fresh run deferred");
    expect(prompt).toContain("Cap stale-red re-proofs at **1 routine per pass**");
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
    expect(env.TMPDIR).toBe(`${env.ROUTINES_RUN_DIR}/scratch`);
    expect(env.TMP).toBe(env.TMPDIR);
    expect(env.TEMP).toBe(env.TMPDIR);
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

describe("outcome-sink closeout is appended AFTER the routine body", () => {
  // The envelope already carries the sink contract, but it is PREPENDED to an
  // often-long body, so it scrolls out of the agent's working focus before the
  // body ends: 65 of 570 runs in the 24h to 2026-08-17T17:00Z finished
  // `outcome=unknown`. Prompt ORDER is the whole fix for that mechanism, and
  // order is only testable by position.
  const bodyOnlyEntry = (dir: string, body: string) =>
    parseEntry(
      [
        'harness = "codex"',
        'model = "m1"',
        'rrule = "FREQ=WEEKLY"',
        `prompt = ${JSON.stringify(body)}`,
      ].join("\n"),
      join(dir, "coderings-weekly-fold.toml"),
    );

  test("a prompt that asks for no closeout still gets one, after its body", () => {
    tmp = mkdtempSync(join(tmpdir(), "routines-mem-"));
    process.env.ROUTINES_HOME = tmp;
    process.env.ROUTINES_SKIP_NOTICES = "1";
    // `coderings-weekly-fold` asks for neither sink nor trailer, and read
    // `unknown` on 5 of its last 6 fires. Its prompt has no order to change.
    const entry = bodyOnlyEntry(tmp, "Capture the weekly fold snapshot.");
    const text = resolveDispatchPrompt(entry);

    expect(text).toContain("Capture the weekly fold snapshot.");
    expect(text).toContain("Close out this run");
    // The point of the card: closeout comes AFTER the body, not only before it.
    expect(text.lastIndexOf("Close out this run")).toBeGreaterThan(
      text.indexOf("Capture the weekly fold snapshot."),
    );
    // It must name the sink concretely enough to act on.
    expect(text).toContain("outcome.txt");
    expect(text).toContain("$ROUTINES_RUN_DIR/outcome.txt");
  });

  test("closeout points at the concrete run dir when one is known", () => {
    tmp = mkdtempSync(join(tmpdir(), "routines-mem-"));
    process.env.ROUTINES_HOME = tmp;
    process.env.ROUTINES_SKIP_NOTICES = "1";
    const entry = bodyOnlyEntry(tmp, "Body.");
    const runDir = join(tmp, "runs", "coderings-weekly-fold", "2026-08-31T00-00-00-000Z");
    const text = resolveDispatchPrompt(entry, { runDir });
    expect(text).toContain(join(runDir, "outcome.txt"));
  });

  test("closeout names the routine so a body-less prompt still identifies itself", () => {
    tmp = mkdtempSync(join(tmpdir(), "routines-mem-"));
    process.env.ROUTINES_HOME = tmp;
    const entry = bodyOnlyEntry(tmp, "Body.");
    expect(buildOutcomeCloseout(entry)).toContain("coderings-weekly-fold");
  });

  test("closeout text does not classify a run that merely echoes it", () => {
    tmp = mkdtempSync(join(tmpdir(), "routines-mem-"));
    process.env.ROUTINES_HOME = tmp;
    process.env.ROUTINES_SKIP_NOTICES = "1";
    const entry = bodyOnlyEntry(tmp, "Body.");
    // Harnesses echo prompt text into the transcript. A worked trailer example
    // in the prompt would classify every run that read it, which is worse than
    // the `unknown` this block exists to prevent.
    const outcome = parseOutcome("coderings-weekly-fold", resolveDispatchPrompt(entry), {
      exitCode: 0,
      timedOut: false,
      sink: null,
    });
    expect(outcome.kind).toBe("unknown");
  });
});
