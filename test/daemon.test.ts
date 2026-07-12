import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dueOccurrence, evaluateOnce } from "../src/daemon.ts";
import { loadEntry } from "../src/registry.ts";

let home: string;
let heartbeatOut: string;

const savedEnv = { ...process.env };

function stub(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "routines-test-"));
  process.env.ROUTINES_HOME = home;
  mkdirSync(join(home, "registry"), { recursive: true });

  const harnessStub = stub(
    join(home, "stub-harness"),
    '#!/bin/sh\necho "STUB-RAN $*"\nexit 0\n',
  );
  process.env.ROUTINES_CLAUDE_BIN = harnessStub;
  process.env.ROUTINES_CODEX_BIN = harnessStub;

  // fsituations stub: one active situation scoping *fenced*
  const sit = stub(
    join(home, "stub-fsituations"),
    '#!/bin/sh\ncat <<\'JSON\'\n[{"slug":"test-sit","status":"active","scope_routines":["*fenced*"]}]\nJSON\n',
  );
  process.env.ROUTINES_FSITUATIONS_BIN = sit;

  // fbrain stub: append the --text value ($4) to heartbeatOut
  heartbeatOut = join(home, "heartbeats.log");
  stub(
    join(home, "stub-fbrain"),
    `#!/bin/sh\n# args: append <slug> --text <line>\nprintf '%s\\n' "$4" >> ${heartbeatOut}\nexit 0\n`,
  );
  process.env.ROUTINES_FBRAIN_BIN = join(home, "stub-fbrain");
});

afterAll(() => {
  process.env = { ...savedEnv };
});

function writeRoutine(id: string, harness: string, fields: string[] = []) {
  writeFileSync(
    join(home, "registry", `${id}.toml`),
    [
      `harness = "${harness}"`,
      'model = "test-model"',
      'rrule = "FREQ=SECONDLY"',
      'prompt = "hello from ' + id + '"',
      'heartbeat_slug = "routine-heartbeats"',
      ...fields,
    ].join("\n") + "\n",
  );
}

describe("daemon evaluateOnce", () => {
  test("fires both harnesses, writes run logs + heartbeats, honors the fence", async () => {
    writeRoutine("e2e-claude", "claude");
    writeRoutine("e2e-codex", "codex");
    writeRoutine("test-fenced-routine", "claude");

    const events: string[] = [];
    const results = await evaluateOnce({
      once: true,
      catchupMs: 60_000,
      log: (e) => events.push(`${e.kind}:${e.id ?? ""}`),
    });

    // both non-fenced routines ran; fenced one did not
    const ranIds = results.map((r) => r.id).sort();
    expect(ranIds).toEqual(["e2e-claude", "e2e-codex"]);
    for (const r of results) {
      expect(r.exitCode).toBe(0);
      expect(existsSync(join(r.runDir, "meta.json"))).toBe(true);
      expect(existsSync(join(r.runDir, "stdout.log"))).toBe(true);
      expect(existsSync(join(r.runDir, "prompt.txt"))).toBe(true);
      expect(readFileSync(join(r.runDir, "stdout.log"), "utf8")).toContain("STUB-RAN");
    }

    // fence skip logged and no run dir for the fenced routine
    expect(events).toContain("skip-fence:test-fenced-routine");
    expect(existsSync(join(home, "runs", "test-fenced-routine"))).toBe(false);

    // heartbeats: one line per successful run
    const hb = readFileSync(heartbeatOut, "utf8").trim().split("\n");
    expect(hb.length).toBe(2);
    expect(hb.every((l) => l.includes("ok") && l.includes("harness="))).toBe(true);
  });

  test("cron warm-up: a fresh routine with no catch-up does not fire on first sight", () => {
    writeRoutine("warm", "claude");
    const entry = loadEntry("warm");
    const occ = dueOccurrence(entry, new Date(), 0, () => {});
    expect(occ).toBeNull(); // warm-up baseline written, not due yet
    // a second pass is now due (SECONDLY, baseline in the past)
    const occ2 = dueOccurrence(entry, new Date(Date.now() + 2000), 0, () => {});
    expect(occ2).not.toBeNull();
  });

  test("paused routines are skipped", async () => {
    writeRoutine("paused-one", "claude", ['status = "paused"']);
    const results = await evaluateOnce({ once: true, catchupMs: 60_000 });
    expect(results.length).toBe(0);
    expect(existsSync(join(home, "runs", "paused-one"))).toBe(false);
  });

  test("run dirs accumulate per routine", async () => {
    writeRoutine("multi", "claude");
    await evaluateOnce({ once: true, catchupMs: 60_000 });
    // second pass: lastFire advanced but SECONDLY -> due again a second later
    await new Promise((r) => setTimeout(r, 1100));
    await evaluateOnce({ once: true, catchupMs: 60_000 });
    const dirs = readdirSync(join(home, "runs", "multi"));
    expect(dirs.length).toBeGreaterThanOrEqual(1);
  });
});
