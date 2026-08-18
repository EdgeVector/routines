/**
 * Fixture tests for scripts/cloud-sync-health-fix-gate.sh
 * (zero-LLM observe budget — no 45m exit-124 empty kills).
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "..");
const gate = join(repoRoot, "scripts", "cloud-sync-health-fix-gate.sh");

function runGate(env: Record<string, string>, statusBody: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "cshf-gate-"));
  const statusFile = join(dir, "status.txt");
  writeFileSync(statusFile, statusBody);
  // Stub heartbeat helper so tests never touch live brain.
  const hb = join(dir, "last-stack-brain-append-heartbeat");
  writeFileSync(
    hb,
    "#!/bin/sh\n# test stub — swallow --line\nwhile [ $# -gt 0 ]; do shift; done\nexit 0\n",
  );
  chmodSync(hb, 0o755);
  // Empty notices fixture so tests never read live notices. A PATH stub cannot
  // do this — the gate prepends ~/.local/bin ahead of the test dir — and the 1s
  // notices timeout is no shield either: a healthy node answers in well under a
  // second with the real feed, and any notice whose text happens to contain
  // "primary…restart" (e.g. a storage notice saying "on the primary … No
  // restart") flips safe_upgrade_inflight and inverts the gate verdict
  // (observed 2026-08-18: "hard staging pressure" expected exit 10, got 0).
  const noticesFile = join(dir, "notices.txt");
  writeFileSync(noticesFile, "");
  const lastStackBin = join(dir, "bin");
  spawnSync("mkdir", ["-p", lastStackBin], { stdio: "ignore" });
  spawnSync("ln", ["-sf", hb, join(lastStackBin, "last-stack-brain-append-heartbeat")], {
    stdio: "ignore",
  });

  const result = spawnSync("bash", [gate], {
    env: {
      ...process.env,
      PATH: `${dir}:${lastStackBin}:${process.env.PATH ?? ""}`,
      LAST_STACK_ROOT: dir,
      CLOUD_SYNC_HEALTH_FIX_STATUS_FILE: statusFile,
      CLOUD_SYNC_HEALTH_FIX_NOTICES_FILE: noticesFile,
      // Avoid live situations / lastdb.
      CLOUD_SYNC_HEALTH_FIX_OUTER_TIMEOUT_SEC: "120",
      CLOUD_SYNC_HEALTH_FIX_STATUS_TIMEOUT_SEC: "30",
      CLOUD_SYNC_HEALTH_FIX_NOTICES_TIMEOUT_SEC: "1",
      ...env,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const healthyStatus = `
lastdbd: running
Build:  0.23.3-630-g27f08e0d9 (daemon and CLI agree)
Memory: footprint 4.00 GiB · RSS 3.00 GiB of 12.00 GiB guard ceiling
Sync: state=Clean staging=0/100000 upload_queue=0/1024 local_writable=true degraded=false last_success=1786807618 recording=true log_lag=0 degraded_reasons=
Upload policy: mode=auto throttle_reason=none
Backup durability: last commit 5m ago · manifest #504
Uptime: 1h (pid 21180, since 2026-08-15T03:36:55Z)
`;

const softDegradedStatus = `
lastdbd: running
Build:  0.23.3-630-g27f08e0d9 (daemon and CLI agree)
Memory: footprint 11.85 GiB · RSS 6.88 GiB of 12.00 GiB guard ceiling
Sync: state=Dirty staging=0/100000 upload_queue=0/1024 local_writable=true degraded=true last_success=1786807618 recording=true log_lag=37834522000 degraded_reasons=mutation_log_lag,capture_reexport_pending
Upload policy: mode=auto throttle_reason=interactive_busy throttle_source=interactive_busy
Backup durability: last commit 1h29m ago · manifest #504
Uptime: 11h50m (pid 21180, since 2026-08-15T03:36:55Z)
`;

const hardStagingStatus = `
lastdbd: running
Build:  0.23.3-test
Memory: footprint 2.00 GiB · RSS 1.00 GiB of 12.00 GiB guard ceiling
Sync: state=Dirty staging=60000/100000 upload_queue=900/1024 local_writable=true degraded=true last_success=1786807618 recording=true degraded_reasons=upload_backlog
Upload policy: mode=auto throttle_reason=none
Backup durability: last commit 2h ago · manifest #1
Uptime: 1h (pid 99, since 2026-08-15T00:00:00Z)
`;

describe("cloud-sync-health-fix-gate", () => {
  test("healthy → exit 0 + ROUTINE_RESULT ok (skip harness)", () => {
    const r = runGate({}, healthyStatus);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=ok");
    expect(r.stdout).toMatch(/healthy|degraded=false/);
    expect(r.stdout).toContain("staging=0/100000");
    expect(r.stdout).toContain("action=observe_no_deploy");
  });

  test("soft degraded under load → exit 0 observe (no harness)", () => {
    const r = runGate({}, softDegradedStatus);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=ok");
    expect(r.stdout).toContain("degraded=true");
    expect(r.stdout).toContain("capture_reexport_pending");
    expect(r.stdout).toContain("action=observe_no_deploy");
    // Must not proceed to LLM on the overnight digression pattern.
    expect(r.stdout).not.toContain("CLOUD_SYNC_HEALTH_FIX_GATE proceed");
  });

  test("hard staging pressure → exit 10 proceed to harness", () => {
    const r = runGate({}, hardStagingStatus);
    expect(r.status).toBe(10);
    expect(r.stdout).toContain("CLOUD_SYNC_HEALTH_FIX_GATE proceed");
    expect(r.stdout).toContain("staging=60000/100000");
    // No skip-harness ROUTINE_RESULT on proceed path.
    expect(r.stdout).not.toMatch(/ROUTINE_RESULT outcome=ok detail=observe/);
  });

  test("FORCE_OBSERVE overrides hard signal → exit 0", () => {
    const r = runGate({ CLOUD_SYNC_HEALTH_FIX_FORCE_OBSERVE: "1" }, hardStagingStatus);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=ok");
    expect(r.stdout).toContain("action=observe_no_deploy");
  });

  test("status probe timeout → timeout_partial exit 0", () => {
    // Simulate timeout by setting OUTER budget already exhausted via RESERVE.
    // Easier: fake a non-file path with a slow command — use empty OUTER and
    // RESERVE so remaining < reserve before probe.
    const r = runGate(
      {
        CLOUD_SYNC_HEALTH_FIX_OUTER_TIMEOUT_SEC: "1",
        CLOUD_SYNC_HEALTH_FIX_RESERVE_SEC: "30",
        // Clear fixture so we hit the budget check / timeout path.
        CLOUD_SYNC_HEALTH_FIX_STATUS_FILE: "",
      },
      softDegradedStatus,
    );
    // With STATUS_FILE empty string, the env still sets the key — gate checks
    // -f which fails for "". Then it tries lastdb status under budget.
    // Budget 1s with reserve 30s → flush_timeout_partial before probe.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("timeout_partial");
    expect(r.stdout).toContain("ROUTINE_RESULT outcome=ok");
  });
});
