// Guards for the out-of-fleet fleet-freeze watchdog.
//
// The defect these guard against is NOT "the bound is wrong". It is a detector
// that answers OK about a fleet it could not observe. Both 2026-10-01 incidents
// (a 59h48m dispatch freeze, an 81-minute mass `status = "paused"` flip) were
// reported by nothing, and the two routines whose job it was both answered `ok`
// minutes after each one ended. So every case below that asserts UNKNOWN or a
// fired condition is load-bearing.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  censusRegistry,
  classifyFreeze,
  decideSurfacing,
  DEFAULT_DISPATCH_BOUND_MS,
  episodeKey,
  newestDaemonDispatchAt,
  newestDispatchAt,
  observeFreeze,
  renderFreezeLine,
  routinesdLogPath,
  tailBytes,
  type FreezeState,
  type RegistryCensus,
} from "../src/freeze-watch.ts";
import {
  assertRunnableLaunchdArgv,
  FREEZE_WATCH_VERB,
  isThrottledProcessType,
  launchdArgvForVerb,
  readProcessType,
  renderFreezeWatchPlist,
} from "../src/launchd.ts";

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

// The two argv shapes the INSTALLED artifact actually produces. The original
// test fixture was `{program: "/opt/routines/cli.ts", runtime: "/bin/bun"}` — a
// source-checkout shape that exercises neither, which is why an agent that could
// not run shipped green.
const COMPILED = {
  // `process.execPath` of the installed artifact, and the `process.argv[1]` a
  // compiled Bun binary reports. Both read off the live host 2026-10-01.
  execPath:
    "/Users/tomtang/.host-track/apps/routines/versions/" +
    "0f961583dbd30590942e874b349c05e2c82194e0f6cec7222d8d2d9d2eb97736/dist/routines",
  entrypoint: "/$bunfs/root/cli.ts",
};
const STABLE = "/Users/tomtang/.host-track/apps/routines/current/dist/routines";

describe("launchdArgvForVerb", () => {
  test("a compiled artifact runs the binary DIRECTLY, never its own pseudo-path", () => {
    // Measured against the shipped artifact: passing the pseudo-path back gives
    // `unknown command: /$bunfs/root/cli.ts`, exit 2 — every tick, forever.
    const argv = launchdArgvForVerb({ ...COMPILED, verb: FREEZE_WATCH_VERB });
    expect(argv).toEqual([STABLE, "freeze-watch", "--notify"]);
    expect(argv.join(" ")).not.toContain("$bunfs");
  });

  test("the runtime path is the stable `current` link, not one version tree", () => {
    const argv = launchdArgvForVerb({ ...COMPILED, verb: FREEZE_WATCH_VERB });
    expect(argv[0]).toContain("/current/");
    expect(argv[0]).not.toMatch(/\/versions\/[0-9a-f]{64}\//);
  });

  test("a source checkout still runs runtime + entrypoint", () => {
    const argv = launchdArgvForVerb({
      execPath: "/bin/bun",
      entrypoint: "/opt/routines/cli.ts",
      verb: FREEZE_WATCH_VERB,
    });
    expect(argv).toEqual(["/bin/bun", "/opt/routines/cli.ts", "freeze-watch", "--notify"]);
  });
});

describe("assertRunnableLaunchdArgv", () => {
  test("refuses a Bun pseudo-path anywhere in argv", () => {
    expect(() =>
      assertRunnableLaunchdArgv(["/bin/bun", "/$bunfs/root/cli.ts", "freeze-watch"]),
    ).toThrow(/pseudo-path/);
  });

  test("refuses a path pinned to one host-track version tree", () => {
    expect(() => assertRunnableLaunchdArgv([COMPILED.execPath, "freeze-watch"])).toThrow(
      /pinned to one host-track version tree/,
    );
  });

  test("accepts the resolved form", () => {
    expect(() => assertRunnableLaunchdArgv([STABLE, "freeze-watch", "--notify"])).not.toThrow();
  });
});

describe("renderFreezeWatchPlist", () => {
  const xml = renderFreezeWatchPlist({
    argv: launchdArgvForVerb({ ...COMPILED, verb: FREEZE_WATCH_VERB }),
  });

  test("the rendered argv is one the binary can run", () => {
    expect(xml).toContain(`<string>${STABLE}</string>`);
    expect(xml).not.toContain("$bunfs");
    expect(xml).not.toMatch(/versions\/[0-9a-f]{64}/);
  });

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

  test("refuses to WRITE an unrunnable argv, even if a caller hand-builds one", () => {
    // The renderer is the last point before the bytes reach disk. A future
    // caller that skips `launchdArgvForVerb` must fail here rather than install
    // an agent that exits 2 every tick.
    expect(() =>
      renderFreezeWatchPlist({ argv: [COMPILED.execPath, COMPILED.entrypoint, "freeze-watch"] }),
    ).toThrow(/pseudo-path/);
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

// ---------------------------------------------------------------------------
// The authoritative dispatch source: routinesd's OWN log.
//
// The defect these guard against was measured on 2026-10-02. `freeze-watch`
// inferred scheduler liveness ONLY from the heartbeat log, and `writeHeartbeat`
// appends there only when a routine sets `heartbeat_slug` — 28 of 81 entries,
// and 0 of the 3 routines the fleet had been deliberately narrowed to. So the
// watchdog read FROZEN dispatch-stale age=76084s while routinesd's own log held
// 11 dispatches in the preceding 2 h and a `complete` 100 s before the probe.
// A watchdog crying freeze at a healthy fleet is the one failure that trains an
// operator to stop reading it.
// ---------------------------------------------------------------------------

// Real lines, copied from ~/.routines/daemon/routinesd.err.log.
const DAEMON_DISPATCH =
  '{"ts":"2026-10-02T21:15:05.460Z","kind":"dispatch","id":"last-stack-fkanban-pickup-w2",' +
  '"detail":"grok/grok-4.7-build-fast"}';
const DAEMON_COMPLETE =
  '{"ts":"2026-10-02T21:16:10.928Z","kind":"complete","id":"last-stack-fkanban-pickup-w2",' +
  '"detail":"exit=0 run=/Users/tomtang/.routines/runs/last-stack-fkanban-pickup-w2/2026-10-02T21-15-05-550Z"}';
const DAEMON_TICKS = [
  '{"ts":"2026-10-02T21:17:00.668Z","kind":"tick","detail":"81 routines in_flight=0 unspawned=0 stagger=60000ms"}',
  '{"ts":"2026-10-02T21:17:20.103Z","kind":"tick","detail":"81 routines in_flight=0 unspawned=0 stagger=60000ms"}',
  '{"ts":"2026-10-02T21:17:42.336Z","kind":"tick","detail":"81 routines in_flight=0 unspawned=0 stagger=60000ms"}',
];

describe("newestDaemonDispatchAt", () => {
  test("returns the newest dispatch/complete record", () => {
    const text = [DAEMON_DISPATCH, DAEMON_COMPLETE, ...DAEMON_TICKS].join("\n");
    expect(newestDaemonDispatchAt(text)).toBe("2026-10-02T21:16:10.928Z");
  });

  test("a log of ONLY ticks names no dispatch — a tick is not a dispatch", () => {
    // THE load-bearing case. Through the 59h48m freeze the daemon kept ticking
    // `80 routines in_flight=0` and dispatched nothing. A matcher that accepted
    // ticks would read that log as fresh forever and mask the exact outage this
    // module exists to catch, while looking healthier than the old code did.
    expect(newestDaemonDispatchAt(DAEMON_TICKS.join("\n"))).toBeNull();
  });

  test("key order is not load-bearing", () => {
    expect(
      newestDaemonDispatchAt('{"kind":"dispatch","ts":"2026-10-02T21:15:05.460Z","id":"x"}'),
    ).toBe("2026-10-02T21:15:05.460Z");
  });

  test("empty text and non-JSON text name no dispatch", () => {
    expect(newestDaemonDispatchAt("")).toBeNull();
    expect(newestDaemonDispatchAt("not json at all\nnor this")).toBeNull();
  });
});

describe("classifyFreeze — the two dispatch sources", () => {
  const recent = new Date(NOW - 100_000).toISOString();
  const ancient = new Date(NOW - 21 * 3600_000).toISOString();

  test("THE REGRESSION: a fresh daemon dispatch clears a stale heartbeat log", () => {
    // 2026-10-02 verbatim: heartbeat silent for 21 h because no active routine
    // sets `heartbeat_slug`, daemon dispatched 100 s ago. The old code read
    // only the heartbeat source and answered FROZEN.
    const v = classifyFreeze({
      nowMs: NOW,
      census: census({ registered: 81, active: 3, paused: 78 }),
      dispatchLogReadable: true,
      newestDispatchAt: ancient,
      daemonLogReadable: true,
      daemonDispatchAt: recent,
    });
    expect(v.frozen).toBe(false);
    expect(v.unknown).toBe(false);
    expect(v.conditions).toEqual([]);
    expect(v.dispatchAgeMs).toBe(100_000);
  });

  test("a fresh heartbeat line clears a stale daemon log — the reverse also holds", () => {
    const v = classifyFreeze({
      nowMs: NOW,
      census: census(),
      dispatchLogReadable: true,
      newestDispatchAt: recent,
      daemonLogReadable: true,
      daemonDispatchAt: ancient,
    });
    expect(v.frozen).toBe(false);
    expect(v.dispatchAgeMs).toBe(100_000);
  });

  test("BOTH sources stale still fires — a real freeze is still a freeze", () => {
    // The whole point of the change is to remove a false POSITIVE without
    // buying a false negative. Nothing may clear a freeze both sources saw.
    const v = classifyFreeze({
      nowMs: NOW,
      census: census(),
      dispatchLogReadable: true,
      newestDispatchAt: ancient,
      daemonLogReadable: true,
      daemonDispatchAt: ancient,
    });
    expect(v.frozen).toBe(true);
    expect(v.conditions).toEqual(["dispatch-stale"]);
  });

  test("a missing daemon log is not a fault when the heartbeat log answers", () => {
    // Hosts whose launchd rotated the daemon log away must not go UNKNOWN on
    // that alone; the heartbeat source is exactly why it is kept.
    const v = classifyFreeze({
      nowMs: NOW,
      census: census(),
      dispatchLogReadable: true,
      newestDispatchAt: recent,
      daemonLogReadable: false,
      daemonDispatchAt: null,
    });
    expect(v.frozen).toBe(false);
    expect(v.unknown).toBe(false);
  });

  test("a daemon dispatch alone is enough — no heartbeat log at all", () => {
    const v = classifyFreeze({
      nowMs: NOW,
      census: census(),
      dispatchLogReadable: false,
      newestDispatchAt: null,
      daemonLogReadable: true,
      daemonDispatchAt: recent,
    });
    expect(v.frozen).toBe(false);
    expect(v.unknown).toBe(false);
  });

  test("NO source usable is UNKNOWN, never OK, and names every source", () => {
    const v = classifyFreeze({
      nowMs: NOW,
      census: census(),
      dispatchLogReadable: true,
      newestDispatchAt: null,
      daemonLogReadable: false,
      daemonDispatchAt: null,
    });
    expect(v.unknown).toBe(true);
    expect(v.frozen).toBe(false);
    const reasons = v.reasons.join(" ");
    expect(reasons).toContain("routinesd daemon log");
    expect(reasons).toContain("heartbeat log");
    expect(renderFreezeLine(v, "2026-10-02T21:00:00.000Z")).toContain("UNKNOWN");
  });

  test("omitting the daemon fields entirely keeps the old single-source behaviour", () => {
    // Callers that predate the second source must not silently go UNKNOWN.
    const v = classifyFreeze({
      nowMs: NOW,
      census: census(),
      dispatchLogReadable: true,
      newestDispatchAt: ancient,
    });
    expect(v.frozen).toBe(true);
    expect(v.conditions).toEqual(["dispatch-stale"]);
  });
});

describe("tailBytes seeks instead of slurping", () => {
  test("returns only the tail window of a file larger than it", () => {
    const dir = mkdtempSync(join(tmpdir(), "freeze-tail-"));
    const path = join(dir, "big.log");
    // 'a' * 5000 then a marker: a 64-byte window must hold the marker ONLY.
    writeFileSync(path, "a".repeat(5000) + "MARKER-AT-THE-END");
    const got = tailBytes(path, 17);
    expect(got).toBe("MARKER-AT-THE-END");
    expect(got!.length).toBe(17);
  });

  test("a window larger than the file returns the whole file", () => {
    const dir = mkdtempSync(join(tmpdir(), "freeze-tail-"));
    const path = join(dir, "small.log");
    writeFileSync(path, "short");
    expect(tailBytes(path, 4_194_304)).toBe("short");
  });

  test("an unreadable path is null, not a throw", () => {
    expect(tailBytes(join(tmpdir(), "freeze-tail-does-not-exist", "x.log"), 64)).toBeNull();
  });

  test("routinesdLogPath resolves under the routines daemon log dir", () => {
    // Derived from `daemonLogDir()`, the same helper that writes routinesd's
    // StandardErrorPath, so the reader cannot drift from the writer.
    expect(routinesdLogPath().endsWith("/daemon/routinesd.err.log")).toBe(true);
  });
});

describe("observeFreeze wiring — the caller, not just the classifier", () => {
  // Found by a mutation probe: deleting the daemon read from `observeFreeze`
  // broke NO test, because every case above feeds `classifyFreeze` directly.
  // Testing the function is not testing its caller, and the caller is where
  // "which files do we actually read" lives — which is the whole fix.
  function host(opts: { daemon?: string; heartbeat?: string; active?: number }) {
    const dir = mkdtempSync(join(tmpdir(), "freeze-observe-"));
    const registry = join(dir, "registry");
    mkdirSync(registry, { recursive: true });
    for (let i = 0; i < (opts.active ?? 3); i++) {
      writeFileSync(join(registry, `r${i}.toml`), 'status = "active"\n');
    }
    const daemonLogPath = join(dir, "routinesd.err.log");
    const logPath = join(dir, "heartbeats.log");
    writeFileSync(daemonLogPath, opts.daemon ?? "");
    writeFileSync(logPath, opts.heartbeat ?? "");
    return { registry, daemonLogPath, logPath };
  }

  const NOW_MS = Date.parse("2026-10-02T21:25:54.000Z");
  const freshDaemon =
    '{"ts":"2026-10-02T21:16:10.928Z","kind":"complete","id":"last-stack-fkanban-pickup-w2","detail":"exit=0"}';
  const staleHeartbeat =
    "2026-10-02T00:08:50.426Z last-stack-revenant-watch error harness=codex model=gpt-6-luna " +
    "exit=1 dur=9.0s run=/x";

  test("reads routinesd's log, so a fresh dispatch there clears a stale heartbeat log", () => {
    const h = host({ daemon: freshDaemon, heartbeat: staleHeartbeat });
    const v = observeFreeze({ ...h, nowMs: NOW_MS });
    expect(v.frozen).toBe(false);
    expect(v.unknown).toBe(false);
    // 21:25:54 - 21:16:10.928 = 583.072s -> 584s after Math.round of the age.
    expect(Math.round(v.dispatchAgeMs! / 1000)).toBe(583);
  });

  test("still reads the heartbeat log, so it alone can clear a freeze", () => {
    const h = host({
      daemon: '{"ts":"2026-10-02T21:17:42.336Z","kind":"tick","detail":"81 routines in_flight=0"}',
      heartbeat:
        "2026-10-02T21:16:10.928Z last-stack-fkanban-pickup ok harness=codex model=x exit=0 dur=1.0s run=/x",
    });
    const v = observeFreeze({ ...h, nowMs: NOW_MS });
    expect(v.frozen).toBe(false);
    // `unknown` must be false too, or this case passes when the heartbeat read
    // is deleted: a dropped source degrades to UNKNOWN, which is also not
    // `frozen`. A mutation probe caught exactly that — asserting one field of a
    // three-state verdict tests less than it looks like it does.
    expect(v.unknown).toBe(false);
    expect(Math.round(v.dispatchAgeMs! / 1000)).toBe(583);
  });

  test("both logs stale still FROZEN through the real read path", () => {
    const h = host({
      daemon: '{"ts":"2026-09-29T04:00:00.000Z","kind":"dispatch","id":"x","detail":"y"}',
      heartbeat: staleHeartbeat,
    });
    const v = observeFreeze({ ...h, nowMs: NOW_MS });
    expect(v.frozen).toBe(true);
    expect(v.conditions).toEqual(["dispatch-stale"]);
  });

  test("a daemon log of only ticks does not clear a freeze through the read path", () => {
    const h = host({
      daemon: '{"ts":"2026-10-02T21:17:42.336Z","kind":"tick","detail":"81 routines in_flight=0"}',
      heartbeat: "",
    });
    const v = observeFreeze({ ...h, nowMs: NOW_MS });
    expect(v.unknown).toBe(true);
    expect(v.frozen).toBe(false);
  });
});
