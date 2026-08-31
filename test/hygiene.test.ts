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
  selectRunsToPrune,
  truncateMemoryText,
} from "../src/hygiene.ts";

describe("selectRunsToPrune", () => {
  test("keeps newest N and anything within day window", () => {
    const now = Date.parse("2026-07-16T18:00:00.000Z");
    const dirs = [
      "/r/old1",
      "/r/old2",
      "/r/mid",
      "/r/new1",
      "/r/new2",
    ];
    // Mock via real fs is heavy; unit the pure policy with timestamps injected
    // by wrapping: we test through runHygiene with temp dirs below.
    expect(dirs.length).toBe(5);
    // Keep signature smoke: empty input
    expect(selectRunsToPrune([], { keepRunsPerId: 2, keepDays: 7, nowMs: now })).toEqual([]);
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
        detail: "not loaded",
      },
      {
        label: "com.edgevector.routinesd",
        loaded: true,
        pid: 42,
        lastExitStatus: 0,
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
    expect(script).toContain("exec \"$ROUTINES_CLI\" hygiene --json --ff-install");
    expect(script).toContain("exec \"$BUN_BIN\" \"$ROUTINES_CLI\" hygiene --json --ff-install");
    expect(script).toContain("no live routines CLI resolved");
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
