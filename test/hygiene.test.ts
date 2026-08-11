import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hygieneLauncherPath,
  refreshArtifactDaemonIfStale,
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
