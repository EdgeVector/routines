import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEntry } from "../src/registry.ts";
import { runRoutine } from "../src/runner.ts";

let home: string;

const savedEnv = { ...process.env };

function stub(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  process.env = { ...savedEnv };
  home = mkdtempSync(join(tmpdir(), "routines-runner-"));
  process.env.ROUTINES_HOME = home;
  mkdirSync(join(home, "registry"), { recursive: true });

  const fbrainOut = join(home, "heartbeats.log");
  process.env.ROUTINES_FBRAIN_BIN = stub(
    join(home, "stub-fbrain"),
    `#!/bin/sh
test "$1" = append || exit 11
test "$2" = routine-heartbeats || exit 12
test "$3" = --type || exit 13
test "$4" = reference || exit 14
cat >> ${fbrainOut}
exit 0
`,
  );
});

function writeRoutine(id: string): void {
  writeFileSync(
    join(home, "registry", `${id}.toml`),
    [
      'harness = "claude"',
      'model = "test-model"',
      'rrule = "FREQ=SECONDLY"',
      'prompt = "hello"',
      'heartbeat_slug = "routine-heartbeats"',
      "timeout_min = 0.01",
    ].join("\n") + "\n",
  );
}

describe("runRoutine timeout handling", () => {
  test("explicit ok heartbeat completes a run even if the harness lingers until timeout", async () => {
    process.env.ROUTINES_CLAUDE_BIN = stub(
      join(home, "hanging-ok-harness"),
      '#!/bin/sh\necho "brain-stress-consistency 2026-07-14T20:43:29Z ok GREEN findings=0"\nexec sleep 1\n',
    );
    writeRoutine("brain-stress-consistency");

    const result = await runRoutine(loadEntry("brain-stress-consistency"), { quiet: true });

    expect(result.timedOut).toBe(true);
    expect(result.outcome.kind).toBe("ok");
    expect(result.outcome.source).toBe("heartbeat");
    expect(result.exitCode).toBe(0);

    const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
    expect(meta.exitCode).toBe(0);
    expect(meta.timedOut).toBe(true);
    expect(meta.outcome).toBe("ok");
  }, 15000);
});
