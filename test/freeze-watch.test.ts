// Guards for the out-of-fleet fleet-freeze watchdog.
//
// The defect these guard against is NOT "the bound is wrong". It is a detector
// that answers OK about a fleet it could not observe. Both 2026-10-01 incidents
// (a 59h48m dispatch freeze, an 81-minute mass `status = "paused"` flip) were
// reported by nothing, and the two routines whose job it was both answered `ok`
// minutes after each one ended. So every case below that asserts UNKNOWN or a
// fired condition is load-bearing.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  censusRegistry,
  classifyFreeze,
  decideSurfacing,
  DEFAULT_DISPATCH_BOUND_MS,
  episodeKey,
  newestDispatchAt,
  renderFreezeLine,
  type FreezeState,
  type RegistryCensus,
} from "../src/freeze-watch.ts";
import { isThrottledProcessType, readProcessType, renderFreezeWatchPlist } from "../src/launchd.ts";

// Real lines, copied from ~/.last-stack/logs/routine-heartbeats.log. The
// non-routinesd producers share the file and are the whole reason the matcher
// keys on the writer's own `harness=`/`exit=`/`dur=` tokens.
const ROUTINESD_LINE =
  "2026-10-01T21:11:19.487Z last-stack-pipeline-health noop harness=codex model=gpt-5.6-luna " +
  "exit=0 dur=14.9s run=/Users/tomtang/.routines/runs/last-stack-pipeline-health/2026-10-01T21-11-04-633Z";
const OLDER_ROUTINESD_LINE =
  "2026-10-01T21:05:38.919Z last-stack-merge-babysit noop harness=codex model=gpt-5.6-luna " +
  "exit=0 dur=18.0s run=/Users/tomtang/.routines/runs/last-stack-merge-babysit/2026-10-01T21-05-20-899Z";
const OTHER_PRODUCER_LINES = [
  "kanban-validate 2026-10-01T21:19:57Z noop no-candidates",
  "kanban-pickup 2026-10-01T21:21:07Z land-card outcome=noop detail=no_card_claimed reason=none",
  "kanban-validate 2026-10-01T21:21:00-0700 ok validated=some-card result=failed",
];

function census(over: Partial<RegistryCensus> = {}): RegistryCensus {
  return { registered: 80, active: 38, paused: 42, unreadable: 0, ...over };
}

const NOW = Date.parse("2026-10-01T22:00:00.000Z");

describe("newestDispatchAt", () => {
  test("returns the newest routinesd-written line, not the newest line", () => {
    const text = [OLDER_ROUTINESD_LINE, ROUTINESD_LINE, ...OTHER_PRODUCER_LINES].join("\n");
    expect(newestDispatchAt(text)).toBe("2026-10-01T21:11:19.487Z");
  });

  test("a log holding ONLY other producers' lines names no dispatch", () => {
    // The freeze case. During both 2026-10-01 incidents the pickup/validate
    // producers kept appending (they are not routinesd-dispatched legs), so a
    // matcher that accepted any timestamped line would have read the fleet as
    // dispatching one second ago, forever.
    expect(newestDispatchAt(OTHER_PRODUCER_LINES.join("\n"))).toBeNull();
  });

  test("empty text names no dispatch", () => {
    expect(newestDispatchAt("")).toBeNull();
  });
});

describe("classifyFreeze — condition A, dispatch staleness", () => {
  const base = { dispatchLogReadable: true, census: census(), nowMs: NOW };

  test("fires above the bound and names the measured age", () => {
    const v = classifyFreeze({
      ...base,
      newestDispatchAt: new Date(NOW - 7 * 3600_000).toISOString(),
    });
    expect(v.frozen).toBe(true);
    expect(v.conditions).toEqual(["dispatch-stale"]);
    expect(v.reasons.join(" ")).toContain("25200s");
  });

  test("does not fire inside the bound — a 2 h lull is ordinary on this host", () => {
    const v = classifyFreeze({
      ...base,
      newestDispatchAt: new Date(NOW - 2 * 3600_000).toISOString(),
    });
    expect(v.frozen).toBe(false);
    expect(v.unknown).toBe(false);
    expect(v.conditions).toEqual([]);
  });

  test("the default bound is the 6 h value derived from 18085 dispatches", () => {
    expect(DEFAULT_DISPATCH_BOUND_MS).toBe(21_600_000);
  });

  test("an unreadable log is UNKNOWN, never OK", () => {
    const v = classifyFreeze({ ...base, dispatchLogReadable: false, newestDispatchAt: null });
    expect(v.frozen).toBe(false);
    expect(v.unknown).toBe(true);
    expect(renderFreezeLine(v, "2026-10-01T22:00:00.000Z")).toContain("UNKNOWN");
    expect(renderFreezeLine(v, "2026-10-01T22:00:00.000Z")).not.toContain(" OK ");
  });

  test("a readable log naming no dispatch is UNKNOWN, never OK", () => {
    const v = classifyFreeze({ ...base, newestDispatchAt: null });
    expect(v.unknown).toBe(true);
    expect(v.reasons.join(" ")).toContain("no routinesd-written line");
  });

  test("an unparseable timestamp is UNKNOWN, never OK", () => {
    const v = classifyFreeze({ ...base, newestDispatchAt: "not-a-date" });
    expect(v.unknown).toBe(true);
    expect(v.frozen).toBe(false);
  });
});

describe("classifyFreeze — condition B, mass pause", () => {
  const fresh = { newestDispatchAt: new Date(NOW - 60_000).toISOString(), dispatchLogReadable: true };

  test("0 active of 80 registered fires with no bound involved", () => {
    // The exact 2026-10-01 18:50Z state: 38 active -> 0, 42 already paused.
    // Condition A could not fire for another 6 h; this fires on the next tick.
    const v = classifyFreeze({
      ...fresh,
      nowMs: NOW,
      census: census({ active: 0, paused: 80 }),
    });
    expect(v.frozen).toBe(true);
    expect(v.conditions).toEqual(["no-active-routines"]);
    expect(v.reasons.join(" ")).toContain("0 of 80");
  });

  test("ONE active routine does not fire — the fleet can still ship", () => {
    const v = classifyFreeze({
      ...fresh,
      nowMs: NOW,
      census: census({ active: 1, paused: 79 }),
    });
    expect(v.frozen).toBe(false);
    expect(v.conditions).toEqual([]);
  });

  test("an unread registry is UNKNOWN, not 'nothing active'", () => {
    // 0 active AND 0 registered is "I could not look". Reporting that as a mass
    // pause would make a missing ROUTINES_HOME indistinguishable from an outage.
    const v = classifyFreeze({
      ...fresh,
      nowMs: NOW,
      census: census({ registered: 0, active: 0, paused: 0 }),
    });
    expect(v.frozen).toBe(false);
    expect(v.unknown).toBe(true);
  });

  test("both conditions can fire together and both are named", () => {
    const v = classifyFreeze({
      nowMs: NOW,
      dispatchLogReadable: true,
      newestDispatchAt: new Date(NOW - 70 * 3600_000).toISOString(),
      census: census({ active: 0, paused: 80 }),
    });
    expect(v.conditions).toEqual(["dispatch-stale", "no-active-routines"]);
    expect(episodeKey(v)).toBe("frozen:dispatch-stale,no-active-routines");
  });
});

describe("censusRegistry", () => {
  test("counts active, paused, and treats a missing status key as active", () => {
    const dir = mkdtempSync(join(tmpdir(), "freeze-census-"));
    writeFileSync(join(dir, "a.toml"), 'id = "a"\nstatus = "active"\n');
    writeFileSync(join(dir, "b.toml"), 'id = "b"\nstatus = "paused"\n');
    // registry.parseEntry defaults an absent status to "active"; the watchdog
    // must agree with it or the two readers disagree about the same file.
    writeFileSync(join(dir, "c.toml"), 'id = "c"\nrrule = "FREQ=HOURLY"\n');
    writeFileSync(join(dir, "d.toml"), 'id = "d"\nstatus = "retired"\n');
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const c = censusRegistry(dir);
    expect(c).toEqual({ registered: 4, active: 2, paused: 1, unreadable: 1 });
  });

  test("a missing registry directory reports nothing read, not zero active", () => {
    const c = censusRegistry(join(tmpdir(), "freeze-census-does-not-exist-12345"));
    expect(c.registered).toBe(0);
  });
});

describe("decideSurfacing", () => {
  const frozen = classifyFreeze({
    nowMs: NOW,
    dispatchLogReadable: true,
    newestDispatchAt: new Date(NOW - 60_000).toISOString(),
    census: census({ active: 0, paused: 80 }),
  });
  const ok = classifyFreeze({
    nowMs: NOW,
    dispatchLogReadable: true,
    newestDispatchAt: new Date(NOW - 60_000).toISOString(),
    census: census(),
  });
  const iso = "2026-10-01T22:00:00.000Z";

  test("first frozen tick surfaces; the second does not", () => {
    const first = decideSurfacing({}, frozen, iso);
    expect(first.kind).toBe("freeze");
    const second = decideSurfacing(first.next, frozen, iso);
    expect(second.kind).toBe("none");
  });

  test("a changed condition set is a new episode and surfaces again", () => {
    const first = decideSurfacing({}, frozen, iso);
    const bothConditions = classifyFreeze({
      nowMs: NOW,
      dispatchLogReadable: true,
      newestDispatchAt: new Date(NOW - 70 * 3600_000).toISOString(),
      census: census({ active: 0, paused: 80 }),
    });
    expect(decideSurfacing(first.next, bothConditions, iso).kind).toBe("freeze");
  });

  test("recovery surfaces once after a notified freeze, then goes quiet", () => {
    const first = decideSurfacing({}, frozen, iso);
    const rec = decideSurfacing(first.next, ok, iso);
    expect(rec.kind).toBe("recovered");
    expect(decideSurfacing(rec.next, ok, iso).kind).toBe("none");
  });

  test("no all-clear for a freeze that was never surfaced", () => {
    const prev: FreezeState = { episode: "frozen:no-active-routines" };
    expect(decideSurfacing(prev, ok, iso).kind).toBe("none");
  });

  test("UNKNOWN surfaces too — a blind watchdog must say so", () => {
    const blind = classifyFreeze({
      nowMs: NOW,
      dispatchLogReadable: false,
      newestDispatchAt: null,
      census: census(),
    });
    expect(decideSurfacing({}, blind, iso).kind).toBe("unknown");
  });
});

describe("renderFreezeWatchPlist", () => {
  const xml = renderFreezeWatchPlist({ program: "/opt/routines/cli.ts", runtime: "/bin/bun" });

  test("runs the freeze-watch verb with --notify", () => {
    expect(xml).toContain("<string>freeze-watch</string>");
    expect(xml).toContain("<string>--notify</string>");
  });

  test("does NOT ask for the throttled band", () => {
    // A watchdog in `Background` is coalesced: measured 90-1153 s tick gaps on
    // this host against a declared 15 s. See SCHEDULER_PROCESS_TYPE.
    const pt = readProcessType(xml);
    expect(pt).not.toBeNull();
    expect(isThrottledProcessType(pt)).toBe(false);
  });

  test("declares a StartInterval so launchd, not routinesd, drives it", () => {
    expect(xml).toMatch(/<key>StartInterval<\/key>\s*<integer>\d+<\/integer>/);
  });
});

describe("tailBytes", () => {
  test("an unreadable path returns null so the caller reports UNKNOWN", async () => {
    const { tailBytes } = await import("../src/freeze-watch.ts");
    const dir = mkdtempSync(join(tmpdir(), "freeze-tail-"));
    const p = join(dir, "no-read.log");
    writeFileSync(p, `${ROUTINESD_LINE}\n`);
    chmodSync(p, 0o000);
    expect(tailBytes(p)).toBeNull();
    chmodSync(p, 0o644);
    expect(tailBytes(p)).toContain("harness=codex");
  });

  test("a window smaller than the newest dispatch degrades to UNKNOWN, not OK", () => {
    const text = [ROUTINESD_LINE, ...OTHER_PRODUCER_LINES].join("\n");
    const window = text.slice(-120);
    expect(newestDispatchAt(window)).toBeNull();
  });
});
