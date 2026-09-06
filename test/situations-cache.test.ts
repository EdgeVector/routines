// Guards for the non-blocking situations cache on the daemon's hot paths.
//
// The defect these exist for: `dispatchDue` called `spawnSync` on a
// LastDB-reading binary from the daemon's single JS thread, so a saturated
// node set the scheduler's period directly. Measured 2026-09-05T18:24-18:39Z
// on an IDLE daemon: one tick in 14m54s against tickMs=15_000.
// papercut-routinesd-tick-loop-stalls-as-inflight-grows-fleet-dispatch-stops-
// silently-20260905.
//
// Every test drives a stub `situations` CLI through ROUTINES_SITUATIONS_CLI
// and counts its invocations, so "did the hot path spawn?" is a fact rather
// than an inference. No live node, no live daemon.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enableSituationsCache,
  loadActiveSituationsCached,
  loadRecentNoticesCached,
  resetSituationsCache,
} from "../src/situations.ts";

let dir: string;
let counter: string;
const saved: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "ROUTINES_SITUATIONS_CLI",
  "ROUTINES_FSITUATIONS_BIN",
  "ROUTINES_SITUATIONS_CACHE_TTL_MS",
  "ROUTINES_SITUATIONS_MAX_AGE_MS",
  "ROUTINES_SITUATIONS_PRIME_TIMEOUT_MS",
  "ROUTINES_SITUATIONS_REFRESH_TIMEOUT_MS",
  "ROUTINES_NOTICES_SINCE",
];

/** Write a stub CLI that appends one line per call and prints `body`. */
function stub(body: string, sleepSeconds = 0): string {
  const path = join(dir, "situations");
  const script = [
    "#!/bin/sh",
    `echo "$@" >> ${JSON.stringify(counter)}`,
    sleepSeconds > 0 ? `sleep ${sleepSeconds}` : "",
    `cat <<'JSON'`,
    body,
    "JSON",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function calls(): number {
  if (!existsSync(counter)) return 0;
  return readFileSync(counter, "utf8").split("\n").filter((l) => l.trim()).length;
}

const ONE_SITUATION = JSON.stringify([
  { slug: "harness-outage-codex", status: "active", scope_routines: ["*codex*"] },
]);

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "routines-situations-cache-"));
  counter = join(dir, "calls.log");
  resetSituationsCache();
  enableSituationsCache(true);
  process.env.ROUTINES_SITUATIONS_CLI = join(dir, "situations");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  resetSituationsCache();
  enableSituationsCache(false);
  rmSync(dir, { recursive: true, force: true });
});

describe("loadActiveSituationsCached", () => {
  test("primes once, then serves every later tick without spawning", () => {
    stub(ONE_SITUATION);
    const first = loadActiveSituationsCached();
    expect(first.ok).toBe(true);
    expect(first.cached).toBe(false);
    expect(first.situations.map((s) => s.slug)).toEqual(["harness-outage-codex"]);
    expect(calls()).toBe(1);

    for (let i = 0; i < 5; i++) {
      const again = loadActiveSituationsCached();
      expect(again.ok).toBe(true);
      expect(again.cached).toBe(true);
      expect(again.situations.map((s) => s.slug)).toEqual(["harness-outage-codex"]);
    }
    // The whole point: five more ticks, still one spawn.
    expect(calls()).toBe(1);
  });

  test("a slow CLI cannot block a warm read — the tick returns in milliseconds", () => {
    stub(ONE_SITUATION);
    expect(loadActiveSituationsCached().ok).toBe(true);

    // Swap in a CLI that takes 3s, and expire the cache so a refresh is due.
    stub(ONE_SITUATION, 3);
    process.env.ROUTINES_SITUATIONS_CACHE_TTL_MS = "1";

    const started = Date.now();
    const warm = loadActiveSituationsCached();
    const elapsed = Date.now() - started;

    expect(warm.ok).toBe(true);
    expect(warm.cached).toBe(true);
    expect(warm.situations.map((s) => s.slug)).toEqual(["harness-outage-codex"]);
    // Before the fix this call was the 30s spawnSync. 500ms leaves generous
    // headroom on a loaded host while staying far under the 3s stub.
    expect(elapsed).toBeLessThan(500);
  }, 30_000);

  test("refresh is single-flight: many due ticks spawn one child", async () => {
    stub(ONE_SITUATION);
    expect(loadActiveSituationsCached().ok).toBe(true);
    expect(calls()).toBe(1);

    stub(ONE_SITUATION, 1);
    process.env.ROUTINES_SITUATIONS_CACHE_TTL_MS = "1";
    for (let i = 0; i < 10; i++) loadActiveSituationsCached();
    // Let the one spawned child reach its first line. Without the guard the
    // ten due ticks each start their own refresh.
    await Bun.sleep(400);
    expect(calls()).toBe(2);
    await Bun.sleep(1500);
  }, 30_000);

  test("past max age the cached list is still SERVED, and reported degraded", () => {
    stub(ONE_SITUATION);
    expect(loadActiveSituationsCached().ok).toBe(true);

    process.env.ROUTINES_SITUATIONS_MAX_AGE_MS = "1";
    process.env.ROUTINES_SITUATIONS_CACHE_TTL_MS = "100000";
    const stale = loadActiveSituationsCached(Date.now() + 5_000);
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain("stale");
    // Serving the list is the whole safety argument: an empty list fences
    // nothing, so degrading to [] would silently UNFENCE every routine.
    expect(stale.situations.map((s) => s.slug)).toEqual(["harness-outage-codex"]);
  });

  test("a failed prime is never re-blocked; the cache fills in the background", async () => {
    // The exact defect the live before/after found in the first draft of this
    // change: a CLI SLOWER than the prime budget but perfectly healthy. Every
    // call re-primed, so every tick paid the full budget AND still served the
    // empty fail-open list — worse than the blocking code it replaced.
    stub(ONE_SITUATION, 2);
    process.env.ROUTINES_SITUATIONS_PRIME_TIMEOUT_MS = "300";

    const t0 = Date.now();
    const cold = loadActiveSituationsCached();
    const primeMs = Date.now() - t0;
    expect(cold.ok).toBe(false);
    expect(primeMs).toBeLessThan(3_000);

    // Second and later ticks must not block at all.
    const t1 = Date.now();
    for (let i = 0; i < 5; i++) loadActiveSituationsCached();
    expect(Date.now() - t1).toBeLessThan(300);

    // …and the background refresh, on its longer deadline, fills the cache so
    // the fence becomes correct without any tick ever paying for it.
    await Bun.sleep(4_000);
    const warm = loadActiveSituationsCached();
    expect(warm.ok).toBe(true);
    expect(warm.situations.map((s) => s.slug)).toEqual(["harness-outage-codex"]);
  }, 30_000);

  test("a different CLI is a cold cache, not a stale answer", () => {
    stub(ONE_SITUATION);
    expect(loadActiveSituationsCached().situations.map((s) => s.slug)).toEqual([
      "harness-outage-codex",
    ]);

    // Point the reader at a DIFFERENT binary. The cached answer belonged to the
    // old one; serving it here would attribute one CLI's reply to another.
    const other = join(dir, "other-situations");
    writeFileSync(
      other,
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(counter)}\n` +
        `cat <<'JSON'\n[{"slug":"other-situation","status":"active","scope_routines":["*x*"]}]\nJSON\n`,
    );
    chmodSync(other, 0o755);
    process.env.ROUTINES_SITUATIONS_CLI = other;

    const fresh = loadActiveSituationsCached();
    expect(fresh.ok).toBe(true);
    expect(fresh.situations.map((s) => s.slug)).toEqual(["other-situation"]);
  });

  test("a cold failure fails open with an empty list, as before", () => {
    process.env.ROUTINES_SITUATIONS_CLI = join(dir, "does-not-exist");
    const check = loadActiveSituationsCached();
    expect(check.ok).toBe(false);
    expect(check.situations).toEqual([]);
    expect(check.error).toBeDefined();
  });

  test("the cold prime is bounded well under the 30s default", () => {
    stub(ONE_SITUATION, 10);
    process.env.ROUTINES_SITUATIONS_PRIME_TIMEOUT_MS = "300";
    const started = Date.now();
    const check = loadActiveSituationsCached();
    const elapsed = Date.now() - started;
    expect(check.ok).toBe(false);
    expect(check.situations).toEqual([]);
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);
});

describe("cache scope", () => {
  test("OFF in a fresh process — observed, not asserted from this module", () => {
    // This module's flag has already been set by beforeEach, so asking it here
    // would prove nothing. Read the DEFAULT out of a fresh interpreter.
    const probe = join(dir, "default-probe.ts");
    const mod = new URL("../src/situations.ts", import.meta.url).pathname;
    writeFileSync(
      probe,
      `import { situationsCacheEnabled } from ${JSON.stringify(mod)};\n` +
        "console.log(situationsCacheEnabled() ? \"on\" : \"off\");\n",
    );
    const res = Bun.spawnSync(["bun", probe], { stdout: "pipe", stderr: "pipe" });
    expect(res.stdout.toString().trim()).toBe("off");
  }, 30_000);

  test("while OFF a one-shot command still reads exactly, every call", () => {
    enableSituationsCache(false);
    stub(ONE_SITUATION);
    for (let i = 0; i < 3; i++) {
      const r = loadActiveSituationsCached();
      expect(r.ok).toBe(true);
      expect(r.cached).toBeUndefined();
    }
    // `routines status` must never report a posture older than the command.
    expect(calls()).toBe(3);
    expect(loadRecentNoticesCached().ok).toBe(true);
    expect(calls()).toBe(4);
  });

  test("startDaemon turns the cache on", async () => {
    // Structural: the whole fix is inert unless the long-lived process enables
    // it, and nothing else in the tree does. Cheap to assert, and the failure
    // it prevents (a silently inert cache) is invisible at runtime.
    const src = await Bun.file(new URL("../src/daemon.ts", import.meta.url)).text();
    const start = src.indexOf("export function startDaemon(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 1200);
    expect(body).toContain("enableSituationsCache(true)");
  });
});

describe("loadRecentNoticesCached", () => {
  test("primes once, then serves the banner without spawning", () => {
    stub(
      JSON.stringify([
        {
          slug: "notice-upgrade-lastdb",
          kind: "upgrade",
          title: "LastDB upgraded",
          at: "2026-09-06T00:00:00.000Z",
          summary: "blips expected",
          scope_systems: ["lastdbd"],
        },
      ]),
    );
    const first = loadRecentNoticesCached();
    expect(first.ok).toBe(true);
    expect(first.banner).toContain("notice-upgrade-lastdb");
    expect(calls()).toBe(1);

    for (let i = 0; i < 5; i++) {
      const again = loadRecentNoticesCached();
      expect(again.cached).toBe(true);
      expect(again.banner).toContain("notice-upgrade-lastdb");
    }
    expect(calls()).toBe(1);
  });

  test("a slow notices CLI cannot block a dispatch", () => {
    stub(JSON.stringify([]));
    expect(loadRecentNoticesCached().ok).toBe(true);

    stub(JSON.stringify([]), 3);
    process.env.ROUTINES_SITUATIONS_CACHE_TTL_MS = "1";
    const started = Date.now();
    const warm = loadRecentNoticesCached();
    const elapsed = Date.now() - started;
    expect(warm.cached).toBe(true);
    expect(elapsed).toBeLessThan(500);
  }, 30_000);
});
