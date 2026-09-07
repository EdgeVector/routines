import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hygieneLauncherPath,
  isHostTrackRoutinesArtifact,
  isLaunchdServiceNotLoaded,
  refreshArtifactDaemonIfStale,
  tryArtifactDaemonRefresh,
  renderHygieneLauncher,
  renderHygienePlist,
  runHygiene,
  MIN_KEEP_RUNS,
  selectRunsToPrune,
  truncateMemoryText,
} from "../src/hygiene.ts";
import {
  isThrottledProcessType,
  readProcessType,
  SCHEDULER_PROCESS_TYPE,
} from "../src/launchd.ts";

describe("selectRunsToPrune", () => {
  const NOW = Date.parse("2026-07-16T18:00:00.000Z");
  const DAY = 86_400_000;

  /** Build one routine's run dirs; `ageDays[i]` is how old that finished run is. */
  function makeRuns(ageDays: number[]): { dir: string; runs: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "routines-prune-"));
    const runs: string[] = [];
    for (const age of ageDays) {
      const finishedAt = new Date(NOW - age * DAY).toISOString();
      const d = join(dir, finishedAt.replace(/[:.]/g, "-"));
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "meta.json"),
        JSON.stringify({ id: "demo", finishedAt, exitCode: 0, outcome: "ok" }),
      );
      runs.push(d);
    }
    return { dir, runs };
  }

  // The defect this file did not previously cover: every fixture had FEWER runs
  // inside the day window than the cap, so the cap never had to bind and the
  // union policy looked correct. A routine firing every 15 minutes holds ~670
  // runs inside a 7-day window. Give the window more runs than the cap.
  test("the day window cannot keep more runs than keepRunsPerId", () => {
    // 30 runs, all finished within the last 15 hours — all inside the window.
    const { runs } = makeRuns(Array.from({ length: 30 }, (_, i) => (i + 1) / 48));
    const doomed = selectRunsToPrune(runs, { keepRunsPerId: 20, keepDays: 7, nowMs: NOW });

    expect(doomed.length).toBe(10);
    // The survivors are the newest 20, and every pruned run is older than them.
    const kept = runs.filter((r) => !doomed.includes(r));
    expect(kept.length).toBe(20);
    for (const r of runs.slice(0, 20)) expect(kept).toContain(r);
    for (const r of runs.slice(20)) expect(doomed).toContain(r);
  });

  // MIN_KEEP_RUNS is a floor under the age policy, not under the count cap.
  test("keeps MIN_KEEP_RUNS when every run is older than keepDays", () => {
    const { runs } = makeRuns([30, 31, 32, 33, 34]);
    const doomed = selectRunsToPrune(runs, { keepRunsPerId: 20, keepDays: 7, nowMs: NOW });

    // Assert the literal, not MIN_KEEP_RUNS: an assertion written against the
    // constant it is testing moves with it and cannot fail when the floor drops.
    expect(MIN_KEEP_RUNS).toBe(3);
    expect(runs.length - doomed.length).toBe(3);
    for (const r of runs.slice(0, 3)) expect(doomed).not.toContain(r);
  });

  // Both knobs bind. Inside the cap the day window still deletes.
  test("prunes past the day window even when the routine is under the cap", () => {
    // 6 runs, 4 of them older than 7 days, cap of 20 never reached.
    const { runs } = makeRuns([1, 2, 9, 10, 11, 12]);
    const doomed = selectRunsToPrune(runs, { keepRunsPerId: 20, keepDays: 7, nowMs: NOW });

    // newest 2 are inside the window; index 2 survives on the MIN_KEEP floor.
    expect(doomed.length).toBe(3);
    for (const r of runs.slice(0, 3)) expect(doomed).not.toContain(r);
    for (const r of runs.slice(3)) expect(doomed).toContain(r);
  });

  test("empty input prunes nothing", () => {
    expect(selectRunsToPrune([], { keepRunsPerId: 2, keepDays: 7, nowMs: NOW })).toEqual([]);
  });
});

describe("truncateMemoryText", () => {
  test("returns null when under limit", () => {
    expect(truncateMemoryText("a\nb\n", 10)).toBeNull();
  });

  test("keeps last N lines and adds header", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const out = truncateMemoryText(lines.join("\n") + "\n", 5);
    expect(out).not.toBeNull();
    expect(out!).toContain("truncated by routines hygiene");
    expect(out!).toContain("line-15");
    expect(out!).toContain("line-19");
    expect(out!).not.toContain("line-10");
  });
});

describe("runHygiene", () => {
  // runHygiene probes the prompt doctor. Without an explicit override the probe
  // resolves `last-stack-routines-prompt-doctor` on the host PATH and runs the
  // machine's REAL doctor, which scans every installed prompt. Measured on a
  // loaded machine that spawn costs ~1.25 s, and these five tests were failing
  // bun's 5 s default at 5007-5053 ms — the whole overrun was one host binary
  // no assertion here looks at. Point it at an absent path so the probe returns
  // "skipped" and the tests measure this repo's code only. The doctor's real
  // behaviour is covered by the "prompt doctor probe" describe below, which
  // installs its own fixture doctor.
  const prevDoctor = process.env.ROUTINES_PROMPT_DOCTOR_BIN;
  beforeEach(() => {
    process.env.ROUTINES_PROMPT_DOCTOR_BIN = join(tmpdir(), "routines-absent-prompt-doctor");
  });
  afterEach(() => {
    if (prevDoctor === undefined) delete process.env.ROUTINES_PROMPT_DOCTOR_BIN;
    else process.env.ROUTINES_PROMPT_DOCTOR_BIN = prevDoctor;
  });

  // The pin above is the whole de-flake, so assert the cause directly rather
  // than trusting that the file got faster: with the override pointing at an
  // absent path the probe must report "not installed". If someone drops the
  // pin, this fails on the machine that has last-stack installed — which is
  // every machine that runs the fleet — instead of silently costing 1255 ms a
  // spawn again.
  test("does not run the host's prompt doctor", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-doctor-pin-"));
    const result = runHygiene({ home, dryRun: true, publishStatus: false });
    expect(result.promptDoctor.attempted).toBe(false);
    expect(result.promptDoctor.detail).toContain("not installed");
  });

  test("reports the daemon state after a successful artifact repair", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-daemon-"));
    const states = [
      {
        label: "com.edgevector.routinesd",
        loaded: false,
        pid: null,
        lastExitStatus: null,
        processType: "Standard",
        throttled: false,
        detail: "not loaded",
      },
      {
        label: "com.edgevector.routinesd",
        loaded: true,
        pid: 42,
        lastExitStatus: 0,
        processType: "Standard",
        throttled: false,
        detail: "loaded pid=42",
      },
    ];
    let probes = 0;
    const result = runHygiene({
      home,
      dryRun: false,
      publishStatus: false,
      ffInstall: true,
      daemonProbe: () => states[Math.min(probes++, states.length - 1)]!,
      ffInstallAction: () => ({
        attempted: true,
        ok: true,
        detail: "routinesd reinstalled",
        restarted: true,
      }),
    });
    expect(result.daemon.loaded).toBe(true);
    expect(result.daemon.pid).toBe(42);
    expect(result.warnings.some((warning) => warning.includes("not loaded"))).toBe(false);
    expect(probes).toBe(2);
  });

  test("prunes old run dirs beyond keepRunsPerId and keepDays", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-"));
    const id = "demo-routine";
    const runs = join(home, "runs", id);
    mkdirSync(runs, { recursive: true });

    const now = Date.parse("2026-07-16T18:00:00.000Z");
    // 5 finished runs: 3 ancient, 2 recent
    const stamps = [
      { name: "2026-06-01T00-00-00-000Z", finishedAt: "2026-06-01T00:00:00.000Z" },
      { name: "2026-06-02T00-00-00-000Z", finishedAt: "2026-06-02T00:00:00.000Z" },
      { name: "2026-06-03T00-00-00-000Z", finishedAt: "2026-06-03T00:00:00.000Z" },
      { name: "2026-07-15T12-00-00-000Z", finishedAt: "2026-07-15T12:00:00.000Z" },
      { name: "2026-07-16T12-00-00-000Z", finishedAt: "2026-07-16T12:00:00.000Z" },
    ];
    for (const s of stamps) {
      const d = join(runs, s.name);
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "meta.json"),
        JSON.stringify({
          id,
          finishedAt: s.finishedAt,
          exitCode: 0,
          outcome: "ok",
        }),
      );
    }
    // one running — must never prune
    const running = join(runs, "2026-07-16T17-00-00-000Z");
    mkdirSync(running, { recursive: true });
    writeFileSync(
      join(running, "meta.json"),
      JSON.stringify({ id, status: "running", startedAt: "2026-07-16T17:00:00.000Z" }),
    );

    const result = runHygiene({
      home,
      nowMs: now,
      keepRunsPerId: 2,
      keepDays: 7,
      dryRun: false,
      publishStatus: false,
      ffInstall: false,
    });

    expect(result.prunedRuns).toBe(3);
    const left = readdirSync(runs).sort();
    expect(left).toContain("2026-07-15T12-00-00-000Z");
    expect(left).toContain("2026-07-16T12-00-00-000Z");
    expect(left).toContain("2026-07-16T17-00-00-000Z");
    expect(left).not.toContain("2026-06-01T00-00-00-000Z");
  });

  test("truncates long memory files", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-mem-"));
    const mem = join(home, "memory", "demo");
    mkdirSync(mem, { recursive: true });
    const body = Array.from({ length: 50 }, (_, i) => `hb ${i}`).join("\n") + "\n";
    writeFileSync(join(mem, "memory.md"), body);

    const result = runHygiene({
      home,
      memoryMaxLines: 10,
      dryRun: false,
      publishStatus: false,
      ffInstall: false,
    });
    expect(result.truncatedMemories).toBe(1);
    const text = readFileSync(join(mem, "memory.md"), "utf8");
    expect(text).toContain("truncated by routines hygiene");
    expect(text).toContain("hb 49");
    expect(text).not.toContain("hb 0");
  });

  test("dry-run does not delete", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-dry-"));
    const runs = join(home, "runs", "x");
    mkdirSync(runs, { recursive: true });
    const d = join(runs, "2026-01-01T00-00-00-000Z");
    mkdirSync(d);
    writeFileSync(
      join(d, "meta.json"),
      JSON.stringify({ finishedAt: "2026-01-01T00:00:00.000Z", exitCode: 0 }),
    );

    const result = runHygiene({
      home,
      nowMs: Date.parse("2026-07-16T00:00:00.000Z"),
      keepRunsPerId: 0,
      keepDays: 1,
      dryRun: true,
      publishStatus: false,
      ffInstall: false,
    });
    expect(result.prunedRuns).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(existsSync(d)).toBe(true);
  });

  test("drops recovered escalate stamps regardless of age", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-esc-"));
    const esc = join(home, "error-escalate");
    const st = join(home, "state");
    mkdirSync(esc, { recursive: true });
    mkdirSync(st, { recursive: true });
    const recovered = join(esc, "repark-shared-checkouts.json");
    const stillRed = join(esc, "last-stack-card-reaper.json");
    writeFileSync(recovered, JSON.stringify({ lastOutcome: "error" }) + "\n");
    writeFileSync(stillRed, JSON.stringify({ lastOutcome: "error" }) + "\n");
    writeFileSync(
      join(st, "repark-shared-checkouts.json"),
      JSON.stringify({ id: "repark-shared-checkouts", lastOutcome: "ok" }) + "\n",
    );
    writeFileSync(
      join(st, "last-stack-card-reaper.json"),
      JSON.stringify({ id: "last-stack-card-reaper", lastOutcome: "error" }) + "\n",
    );

    const result = runHygiene({
      home,
      nowMs: Date.now(),
      escalateMaxAgeDays: 14,
      dryRun: false,
      publishStatus: false,
      ffInstall: false,
    });
    expect(result.prunedEscalate).toBe(1);
    expect(existsSync(recovered)).toBe(false);
    expect(existsSync(stillRed)).toBe(true);
    expect(result.items.some((i) => i.detail.includes("ok/noop recovery"))).toBe(true);
  });
});

describe("renderHygienePlist", () => {
  test("installed hygiene agent fast-forwards clean installs", () => {
    const plist = renderHygienePlist({
      program: "/tmp/routines",
      runtime: "/tmp/bun",
      intervalSec: 60,
      env: { ROUTINES_HOME: "/tmp/routines-home" },
    });

    expect(plist).toContain("<string>hygiene</string>");
    expect(plist).toContain("<string>--json</string>");
    expect(plist).toContain("<string>--ff-install</string>");
  });

  test("installed hygiene agent can run through a stable state launcher", () => {
    const home = "/tmp/routines-home";
    const launcher = hygieneLauncherPath(home);
    const plist = renderHygienePlist({
      program: launcher,
      direct: true,
      env: { ROUTINES_HOME: home },
    });

    expect(launcher).toBe("/tmp/routines-home/daemon/run-hygiene.sh");
    expect(plist).toContain(`<string>${launcher}</string>`);
    expect(plist).not.toContain("<string>hygiene</string>");
    expect(plist).not.toContain("/tmp/stale-checkout");
  });
});

describe("renderHygieneLauncher", () => {
  test("resolves the live installed shim at runtime", () => {
    const script = renderHygieneLauncher();

    expect(script).toContain("ROUTINES_SHIM");
    expect(script).toContain("$HOME/.local/bin/routines");
    expect(script).toContain("\"$ROUTINES_CLI\" hygiene --json --ff-install");
    expect(script).toContain("\"$BUN_BIN\" \"$ROUTINES_CLI\" hygiene --json --ff-install");
    expect(script).toContain("no live routines CLI resolved");
  });

  // The launcher must not `exec` the hygiene pass any more: the re-assert
  // guard below runs AFTER it, and an exec'd process never comes back.
  test("keeps the hygiene exit status while still running the guard", () => {
    const script = renderHygieneLauncher();

    expect(script).not.toContain("exec \"$ROUTINES_CLI\"");
    expect(script).toContain("|| rc=$?");
    expect(script).toContain('exit "$rc"');
  });

  // Defence in depth for a ROLLED-BACK artifact: an older `install-daemon`
  // still writes `dist/routines daemon` with no chain, and installFf runs it.
  // A current binary produces no drift, so this guard never fires then.
  test("re-asserts the wrapper and the chain after the hygiene pass", () => {
    const script = renderHygieneLauncher();

    expect(script).toContain("routinesd-launch.sh");
    expect(script).toContain("ROUTINES_FALLBACK_CHAIN");
    expect(script).toContain("PlistBuddy");
    // The chain is READ from local-env.sh. A hardcoded chain here would be a
    // second source of truth, which is what the hand-written STATE copy became.
    expect(script).toContain("local-env.sh");
    expect(script).not.toContain("codex:gpt-5.6-terra");
  });

  // The repair restarts the daemon, so it must never cut off a live routine.
  test("defers the restart while a harness leg is in flight", () => {
    const script = renderHygieneLauncher();

    expect(script).toContain("deferring restart");
    expect(script).toContain("pgrep");
    // kickstart does not re-read the plist; only bootout+bootstrap does.
    expect(script).toContain("launchctl bootout");
    expect(script).toContain("launchctl bootstrap");
    expect(script).not.toContain("launchctl kickstart");
  });

  // The drift repair must not restart with three unverified calls. `bootout`
  // is async and drains in-flight children, so a fixed sleep cannot stand in
  // for it; on 2026-09-07 the bootstrap raced a still-terminating job, failed
  // into /dev/null, and the fleet was dark for 57 minutes.
  test("restarts through the verified helper, never a fixed sleep", () => {
    const script = renderHygieneLauncher();

    expect(script).toContain("restart_routinesd || rc=1");
    expect(script).toContain("routinesd_loaded || break");
    // The old shape: bootout, sleep 3, bootstrap, all errors discarded.
    expect(script).not.toContain("sleep 3\n      launchctl bootstrap");
  });

  // The check is UNCONDITIONAL: the hygiene pass, `--ff-install`, and the
  // drift repair can each leave the job unloaded, so it cannot sit behind any
  // of their conditions.
  test("ends every pass with an unconditional routinesd check", () => {
    const script = renderHygieneLauncher();

    expect(script).toContain('ensure_routinesd_loaded "end-of-pass" || rc=1');
    // Nothing may guard it: the last line before the exit is the check itself.
    const tail = script.trimEnd().split("\n").slice(-3).join("\n");
    expect(tail).toContain('ensure_routinesd_loaded "end-of-pass" || rc=1');
    expect(tail).toContain('exit "$rc"');
  });
});

/**
 * Behaviour, not text. The generated wrapper runs against a FAKE `launchctl`
 * on PATH and a stub `routines` CLI, so the suite exercises the real script
 * without ever touching the live scheduler.
 */
describe("renderHygieneLauncher routinesd guard (executed)", () => {
  let dir = "";

  const runPass = (
    initialState: "loaded" | "unloaded",
    bootstrapFails: boolean,
  ): { code: number; stderr: string; finalState: string } => {
    writeFileSync(join(dir, "state"), `${initialState}\n`);
    const proc = Bun.spawnSync({
      cmd: ["bash", join(dir, "run-hygiene.sh")],
      env: {
        PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
        HOME: join(dir, "home"),
        USER: "test",
        FAKE_LAUNCHCTL_STATE: join(dir, "state"),
        FAKE_BOOTSTRAP_FAILS: bootstrapFails ? "1" : "0",
        // A throwaway label: the fake launchctl answers for it, and the real
        // com.edgevector.routinesd is never named.
        ROUTINESD_LABEL: "com.edgevector.routinesd-test-throwaway",
        ROUTINES_HYGIENE_BOOTSTRAP_ATTEMPTS: "2",
        ROUTINES_HYGIENE_BOOTSTRAP_SLEEP: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode ?? -1,
      stderr: proc.stderr.toString(),
      finalState: readFileSync(join(dir, "state"), "utf8").trim(),
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hygiene-guard-"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "home", ".local", "bin"), { recursive: true });

    const launchctl = [
      "#!/usr/bin/env bash",
      'state="$FAKE_LAUNCHCTL_STATE"',
      'case "$1" in',
      '  print)     [ "$(cat "$state" 2>/dev/null)" = "loaded" ] && exit 0 || exit 113 ;;',
      '  bootstrap) [ "${FAKE_BOOTSTRAP_FAILS:-0}" = "1" ] && exit 5; echo loaded > "$state"; exit 0 ;;',
      '  bootout)   echo unloaded > "$state"; exit 0 ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n");
    writeFileSync(join(dir, "bin", "launchctl"), launchctl, { mode: 0o755 });
    writeFileSync(
      join(dir, "home", ".local", "bin", "routines"),
      '#!/usr/bin/env bash\necho \'{"stub":true}\'\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "run-hygiene.sh"), renderHygieneLauncher(), { mode: 0o755 });
  });

  // The 2026-09-07 shape: the pass leaves routinesd booted out. It must heal.
  test("a pass that starts with routinesd unloaded leaves it loaded", () => {
    const r = runPass("unloaded", false);

    expect(r.finalState).toBe("loaded");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("routinesd NOT loaded (end-of-pass)");
    expect(r.stderr).toContain("routinesd loaded after attempt 1");
  });

  // The pass that exited 0 with `"daemon": {"loaded": false}` is the whole
  // reason the outage went unseen for 57 minutes.
  test("a bootstrap that fails every attempt makes the pass exit non-zero", () => {
    const r = runPass("unloaded", true);

    expect(r.code).not.toBe(0);
    expect(r.finalState).toBe("unloaded");
    expect(r.stderr).toContain("ERROR routinesd still NOT loaded after 2 attempts");
  });

  test("a healthy pass neither bootstraps nor complains", () => {
    const r = runPass("loaded", false);

    expect(r.code).toBe(0);
    expect(r.finalState).toBe("loaded");
    expect(r.stderr).not.toContain("NOT loaded");
  });
});

describe("artifact daemon refresh", () => {
  const current = "/host-track/apps/routines/versions/current/dist/routines";

  test("does nothing when launchd already names the current artifact", () => {
    let reinstalls = 0;
    const result = refreshArtifactDaemonIfStale({
      dryRun: false,
      restart: true,
      currentExecutable: current,
      launchctlPrint: `arguments = {\n\t${current}\n\tdaemon\n}`,
      reinstall: () => reinstalls++,
    });
    expect(result.attempted).toBe(false);
    expect(result.restarted).toBe(false);
    expect(reinstalls).toBe(0);
  });

  test("accepts a host-track versions digest and rejects a DEV path", () => {
    expect(
      isHostTrackRoutinesArtifact(
        "/Users/x/.host-track/apps/routines/versions/2eb07e371d8924078a602dcfabce78d55fc689a6586da54d48e8b819d79f7010/dist/routines",
      ),
    ).toBe(true);
    expect(
      isHostTrackRoutinesArtifact(
        "/Users/x/.fkanban/worktrees/routines-dev/src/cli.ts",
      ),
    ).toBe(false);
  });

  test("performs one supervised reinstall when launchd names an old artifact", () => {
    let reinstalls = 0;
    const result = refreshArtifactDaemonIfStale({
      dryRun: false,
      restart: true,
      currentExecutable: current,
      launchctlPrint:
        "arguments = {\n\t/host-track/apps/routines/versions/old/src/cli.ts\n\tdaemon\n}",
      reinstall: () => reinstalls++,
    });
    expect(result.ok).toBe(true);
    expect(result.attempted).toBe(true);
    expect(result.restarted).toBe(true);
    expect(reinstalls).toBe(1);
  });

  // 2026-08-27: routinesd stopped twice (05:48Z and 21:04Z) with its launchd
  // job left UNLOADED, costing 8h53m and then a further 29 min of a dead
  // fleet. Hourly hygiene saw `loaded: false` every time and healed nothing:
  // the heal ran `launchctl print` first, that call FAILS on an unloaded job,
  // and the catch returned before reaching its own reinstall(). The one state
  // that needs the heal was the one state that bailed out first.
  test("an unloaded daemon reinstalls; it is the state install-daemon repairs", () => {
    let reinstalls = 0;
    const result = refreshArtifactDaemonIfStale({
      dryRun: false,
      restart: true,
      currentExecutable: current,
      launchctlPrint: "",
      daemonAbsent: true,
      reinstall: () => reinstalls++,
    });
    expect(reinstalls).toBe(1);
    expect(result.restarted).toBe(true);
    expect(result.ok).toBe(true);
    // The wording has to say WHICH repair happened. "reinstalled onto current
    // artifact" alone reads as a routine digest refresh.
    expect(result.detail).toContain("not loaded");
  });

  test("an unloaded daemon under --no-restart says so and reinstalls nothing", () => {
    let reinstalls = 0;
    const result = refreshArtifactDaemonIfStale({
      dryRun: false,
      restart: false,
      currentExecutable: current,
      launchctlPrint: "",
      daemonAbsent: true,
      reinstall: () => reinstalls++,
    });
    expect(reinstalls).toBe(0);
    expect(result.restarted).toBe(false);
    expect(result.detail).toContain("not loaded");
  });

  test("an unloaded daemon under --dry-run reinstalls nothing", () => {
    let reinstalls = 0;
    const result = refreshArtifactDaemonIfStale({
      dryRun: true,
      restart: true,
      currentExecutable: current,
      launchctlPrint: "",
      daemonAbsent: true,
      reinstall: () => reinstalls++,
    });
    expect(reinstalls).toBe(0);
    expect(result.restarted).toBe(false);
    expect(result.detail).toContain("not loaded");
  });
});

describe("tryArtifactDaemonRefresh wiring", () => {
  const artifact =
    "/Users/x/.host-track/apps/routines/versions/" +
    "2eb07e371d8924078a602dcfabce78d55fc689a6586da54d48e8b819d79f7010" +
    "/dist/routines";

  // The bail. `launchctl print` fails on an UNLOADED job, and before this the
  // catch returned `attempted: true, ok: false, restarted: false` without ever
  // calling reinstall(). Hourly hygiene wrote that line for 8h53m on
  // 2026-08-27 and again for 29 min the same evening while the fleet ran
  // nothing. This is the regression that has to stay dead.
  test("reinstalls when launchctl print reports the job is not loaded", () => {
    const reinstalled: string[] = [];
    const result = tryArtifactDaemonRefresh(false, true, {
      currentLink: artifact,
      wrapperPath: null,
      resolveExecutable: () => artifact,
      readLaunchctlPrint: () => {
        throw new Error(
          'Command failed: launchctl print gui/501/com.edgevector.routinesd\n' +
            'Bad request.\nCould not find service "com.edgevector.routinesd" ' +
            "in domain for user gui: 501\n",
        );
      },
      reinstall: (exe) => reinstalled.push(exe),
    });
    expect(reinstalled).toEqual([artifact]);
    expect(result?.restarted).toBe(true);
    expect(result?.ok).toBe(true);
    expect(result?.detail).toContain("not loaded");
  });

  // The other half of the same judgement: a launchctl that cannot run is NOT
  // an absent job, and must not trigger a reinstall on unobserved state.
  test("an inspection failure still reports and reinstalls nothing", () => {
    const reinstalled: string[] = [];
    const result = tryArtifactDaemonRefresh(false, true, {
      currentLink: artifact,
      wrapperPath: null,
      resolveExecutable: () => artifact,
      readLaunchctlPrint: () => {
        throw new Error("spawnSync launchctl ENOENT");
      },
      reinstall: (exe) => reinstalled.push(exe),
    });
    expect(reinstalled).toEqual([]);
    expect(result?.ok).toBe(false);
    expect(result?.restarted).toBe(false);
    expect(result?.detail).toContain("cannot inspect");
  });

  // A loaded job already on the current artifact is left alone.
  test("a loaded current daemon is not touched", () => {
    const reinstalled: string[] = [];
    const result = tryArtifactDaemonRefresh(false, true, {
      currentLink: artifact,
      wrapperPath: null,
      resolveExecutable: () => artifact,
      readLaunchctlPrint: () => `arguments = {\n\t${artifact}\n\tdaemon\n}`,
      reinstall: (exe) => reinstalled.push(exe),
    });
    expect(reinstalled).toEqual([]);
    expect(result?.attempted).toBe(false);
    expect(result?.restarted).toBe(false);
  });
});

describe("isLaunchdServiceNotLoaded", () => {
  // The exact strings this machine produced on 2026-08-27 at 21:20Z.
  test("classifies both launchd wordings for an absent job", () => {
    expect(
      isLaunchdServiceNotLoaded(
        'Command failed: launchctl print gui/501/com.edgevector.routinesd\nBad request.\nCould not find service "com.edgevector.routinesd" in domain for user gui: 501\n',
      ),
    ).toBe(true);
    expect(
      isLaunchdServiceNotLoaded(
        'Command failed: launchctl list com.edgevector.routinesd\nCould not find service "com.edgevector.routinesd" in domain for port\n',
      ),
    ).toBe(true);
  });

  // A launchctl that cannot run at all must NOT be read as an absent job — a
  // reinstall there would be guessing at state nobody observed.
  test("does not classify an inspection failure as an absent job", () => {
    expect(isLaunchdServiceNotLoaded("spawnSync launchctl ENOENT")).toBe(false);
    expect(isLaunchdServiceNotLoaded("Command failed: launchctl print ... EPERM")).toBe(false);
    expect(isLaunchdServiceNotLoaded("Operation not permitted")).toBe(false);
  });
});

describe("prompt doctor probe", () => {
  // The doctor is a last-stack binary resolved from PATH. Shim it so the probe
  // is exercised without depending on last-stack being installed.
  function withStubDoctor<T>(script: string | null, fn: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), "routines-doctor-stub-"));
    if (script !== null) {
      const p = join(dir, "last-stack-routines-prompt-doctor");
      writeFileSync(p, script, { mode: 0o755 });
    }
    const prev = process.env.ROUTINES_PROMPT_DOCTOR_BIN;
    // Point at the stub by absolute path. Setting PATH is NOT enough — Bun
    // resolved the host's real doctor anyway, so this suite silently tested
    // the machine it ran on instead of the fixture.
    process.env.ROUTINES_PROMPT_DOCTOR_BIN = join(dir, "last-stack-routines-prompt-doctor");
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.ROUTINES_PROMPT_DOCTOR_BIN;
      else process.env.ROUTINES_PROMPT_DOCTOR_BIN = prev;
    }
  }

  const home = () => mkdtempSync(join(tmpdir(), "routines-hygiene-doctor-"));

  test("green doctor reports zero findings and raises no warning", () => {
    const r = withStubDoctor(
      "#!/bin/sh\necho 'LAST_STACK_ROUTINES_PROMPT_DOCTOR status=green findings=0'\n",
      () => runHygiene({ home: home(), dryRun: true, publishStatus: false }),
    );
    expect(r.promptDoctor.attempted).toBe(true);
    expect(r.promptDoctor.status).toBe("green");
    expect(r.promptDoctor.findings).toBe(0);
    expect(r.warnings.some((w) => w.includes("prompt drift"))).toBe(false);
  });

  test("a red doctor exits non-zero — that is a result, not a crash", () => {
    // This is the case that matters: the real doctor exits 1 when it finds
    // drift, and execFileSync throws. Its findings are on stdout regardless.
    const r = withStubDoctor(
      "#!/bin/sh\n" +
        "echo 'LAST_STACK_ROUTINES_PROMPT_DOCTOR status=red findings=2'\n" +
        "echo '  FINDING kind=version-pin id=a prompt_path=/x'\n" +
        "echo '  FINDING kind=registry-divergent-local id=b prompt_path=/y'\n" +
        "exit 1\n",
      () => runHygiene({ home: home(), dryRun: true, publishStatus: false }),
    );
    expect(r.promptDoctor.attempted).toBe(true);
    expect(r.promptDoctor.status).toBe("red");
    expect(r.promptDoctor.findings).toBe(2);
    expect(r.promptDoctor.kinds.sort()).toEqual([
      "registry-divergent-local",
      "version-pin",
    ]);
    expect(r.warnings.some((w) => w.includes("prompt drift"))).toBe(true);
  });

  test("runs even under --dry-run — a dry-run must still tell the truth", () => {
    const r = withStubDoctor(
      "#!/bin/sh\necho 'status=red findings=1'\necho '  FINDING kind=version-pin id=a'\nexit 1\n",
      () => runHygiene({ home: home(), dryRun: true, publishStatus: false }),
    );
    expect(r.dryRun).toBe(true);
    expect(r.promptDoctor.findings).toBe(1);
  });

  test("a missing doctor is skipped, not a failure", () => {
    const r = withStubDoctor(null, () =>
      runHygiene({ home: home(), dryRun: true, publishStatus: false }),
    );
    expect(r.promptDoctor.attempted).toBe(false);
    expect(r.promptDoctor.detail).toContain("not installed");
    expect(r.warnings.some((w) => w.includes("prompt drift"))).toBe(false);
  });
});

describe("throttled launchd band detection", () => {
  test("the hygiene plist is not throttled", () => {
    // StartInterval 3600 with a coalesced timer fired every 7-8 hours;
    // routine-fleet-health logged that stall seven times and never found it,
    // because `LastExitStatus=0` and `loaded` both read healthy.
    const plist = renderHygienePlist({ program: "/x/launcher.sh", direct: true });
    expect(readProcessType(plist)).toBe(SCHEDULER_PROCESS_TYPE);
    expect(isThrottledProcessType(readProcessType(plist))).toBe(false);
  });

  test("a throttled live plist is warned about even though the daemon is up", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-throttled-"));
    const result = runHygiene({
      home,
      dryRun: true,
      publishStatus: false,
      daemonProbe: () => ({
        label: "com.edgevector.routinesd",
        loaded: true,
        pid: 58025,
        lastExitStatus: 0,
        processType: "Background",
        throttled: true,
        detail: "loaded pid=58025",
      }),
    });

    expect(result.daemon.throttled).toBe(true);
    expect(result.daemon.processType).toBe("Background");
    const warning = result.warnings.find((w) => w.includes("throttled launchd band"));
    expect(warning).toBeDefined();
    // The warning must carry the heal, because kickstart does NOT re-read the
    // plist and an operator who only kickstarts will conclude the fix failed.
    expect(warning).toContain("bootout");
    expect(warning).toContain(SCHEDULER_PROCESS_TYPE);
    // A live pid must not suppress it: that combination IS the failure.
    expect(result.warnings.some((w) => w.includes("no live pid"))).toBe(false);
  });

  test("an unreadable band produces no throttle warning and no clean claim", () => {
    const home = mkdtempSync(join(tmpdir(), "routines-hygiene-unknown-band-"));
    const result = runHygiene({
      home,
      dryRun: true,
      publishStatus: false,
      daemonProbe: () => ({
        label: "com.edgevector.routinesd",
        loaded: true,
        pid: 42,
        lastExitStatus: 0,
        processType: null,
        throttled: false,
        detail: "loaded pid=42",
      }),
    });

    expect(result.warnings.some((w) => w.includes("throttled launchd band"))).toBe(false);
    // `null` is reported verbatim so a reader can tell "not measured" from
    // "measured and fine".
    expect(result.daemon.processType).toBeNull();
  });
});

describe("launch wrapper is a current daemon, not a stale one", () => {
  const artifact =
    "/Users/x/.host-track/apps/routines/versions/" +
    "2eb07e371d8924078a602dcfabce78d55fc689a6586da54d48e8b819d79f7010" +
    "/dist/routines";
  const wrapper = "/Users/x/.routines/daemon/routinesd-launch.sh";

  // A wrapper-launched daemon names the WRAPPER in ProgramArguments and never
  // a version digest, because the wrapper resolves `current` itself at exec
  // time. Without the alias the staleness test can never match, so hygiene
  // would reinstall and restart routinesd every hour, for ever.
  test("a wrapper-launched daemon is left alone", () => {
    const reinstalled: string[] = [];
    const result = tryArtifactDaemonRefresh(false, true, {
      currentLink: artifact,
      resolveExecutable: () => artifact,
      wrapperPath: wrapper,
      wrapperIsExecutable: (path) => path === wrapper,
      readLaunchctlPrint: () => `arguments = {\n\t${wrapper}\n}`,
      reinstall: (exe) => reinstalled.push(exe),
    });
    expect(reinstalled).toEqual([]);
    expect(result?.attempted).toBe(false);
    expect(result?.restarted).toBe(false);
  });

  test("a non-executable wrapper is not an alias, so a stale job still heals", () => {
    const reinstalled: string[] = [];
    const result = tryArtifactDaemonRefresh(false, true, {
      currentLink: artifact,
      resolveExecutable: () => artifact,
      wrapperPath: wrapper,
      wrapperIsExecutable: () => false,
      readLaunchctlPrint: () => `arguments = {\n\t${wrapper}\n}`,
      reinstall: (exe) => reinstalled.push(exe),
    });
    expect(reinstalled).toEqual([artifact]);
    expect(result?.restarted).toBe(true);
  });
});
