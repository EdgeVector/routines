// Test preload (bunfig.toml [test].preload). Runs once before every test file.
//
// The runner appends one heartbeat line per routine run to a filesystem log
// (src/heartbeat.ts). Its default path is the PRODUCTION fleet log
// ~/.last-stack/logs/routine-heartbeats.log. Tests that only isolate
// ROUTINES_HOME still resolve that default, so `bun test` (and the CI gate,
// which runs on the same Mac) appended fake rows such as
// `regular-failure error harness=claude model=test-model exit=1` to the real
// log that fleet-health readers tail. Point every test at a throwaway file
// unless the test set its own override first.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ROUTINES_HEARTBEATS_FILE && !process.env.LAST_STACK_HEARTBEATS_FILE) {
  const dir = mkdtempSync(join(tmpdir(), "routines-test-heartbeats-"));
  process.env.ROUTINES_HEARTBEATS_FILE = join(dir, "routine-heartbeats.log");
}
