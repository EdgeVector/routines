import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAgentDispatchDetail,
  parseTriageHeartbeat,
  resolveEscalateStatus,
} from "../src/escalate-status.ts";

let home: string;
const prevHome = process.env.ROUTINES_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "routines-esc-status-"));
  process.env.ROUTINES_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.ROUTINES_HOME;
  else process.env.ROUTINES_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("parseAgentDispatchDetail", () => {
  test("parses dispatched pid+dir", () => {
    const p = parseAgentDispatchDetail(
      "dispatched pid=6454 dir=/Users/t/.routines/runs/routine-error-triage/2026-07-15T18-39-16-895Z",
    );
    expect(p.dispatched).toBe(true);
    expect(p.pid).toBe(6454);
    expect(p.dir).toContain("routine-error-triage");
  });

  test("cooldown", () => {
    const p = parseAgentDispatchDetail("cooldown (1800000ms) since 2026-07-15T10:00:00.000Z");
    expect(p.cooldown).toBe(true);
    expect(p.dispatched).toBe(false);
  });
});

describe("parseTriageHeartbeat", () => {
  test("reads last heartbeat", () => {
    const text = `
noise
routine-error-triage 2026-07-15T12:00:00Z ok failed=dogfood-onboarding result=card-updated detail=filed timeout budget note
`;
    const hb = parseTriageHeartbeat(text);
    expect(hb).not.toBeNull();
    expect(hb!.result).toBe("card-updated");
    expect(hb!.detail).toContain("timeout");
  });

  test("needs-human result", () => {
    const hb = parseTriageHeartbeat(
      "routine-error-triage 2026-07-15T12:00:00Z error failed=x result=needs-human detail=missing EXEMEM_SESSION_TOKEN",
    );
    expect(hb!.result).toBe("needs-human");
  });
});

describe("resolveEscalateStatus", () => {
  test("null when no breadcrumb", () => {
    const runDir = join(home, "runs", "r1", "t1");
    mkdirSync(runDir, { recursive: true });
    expect(resolveEscalateStatus(runDir)).toBeNull();
  });

  test("running triage + card failed => needs human for card", () => {
    const runDir = join(home, "runs", "dogfood-onboarding", "t1");
    const triageDir = join(home, "runs", "routine-error-triage", "t-triage");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(triageDir, { recursive: true });
    // Use this process pid so isPidAlive is true
    const pid = process.pid;
    writeFileSync(
      join(runDir, "error-escalated.json"),
      JSON.stringify({
        at: "2026-07-15T18:38:43.851Z",
        cardSlug: "routine-error-dogfood-onboarding",
        cardOk: false,
        cardDetail: "kanban exit 1: 503",
        agent: `dispatched pid=${pid} dir=${triageDir}`,
        agentDispatched: true,
        triageDir,
        triagePid: pid,
      }),
    );
    writeFileSync(
      join(triageDir, "meta.json"),
      JSON.stringify({
        id: "routine-error-triage",
        forRoutine: "dogfood-onboarding",
        failedRunDir: runDir,
        pid,
      }),
    );
    writeFileSync(join(triageDir, "stdout.log"), "");

    const st = resolveEscalateStatus(runDir);
    expect(st).not.toBeNull();
    expect(st!.triageStatus).toBe("running");
    expect(st!.triageRunning).toBe(true);
    expect(st!.needsHuman).toBe(true);
    expect(st!.needsHumanReason).toMatch(/card/i);
    expect(st!.cardSlug).toBe("routine-error-dogfood-onboarding");
  });

  test("triage-result.json fixed closes the loop", () => {
    const runDir = join(home, "runs", "db-perf-guard", "t1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "error-escalated.json"),
      JSON.stringify({
        at: "2026-07-15T09:00:00.000Z",
        cardSlug: "routine-error-db-perf-guard",
        cardOk: true,
        agent: "dispatched pid=1 dir=/tmp/gone",
        agentDispatched: true,
        triageDir: null,
        triagePid: 1,
      }),
    );
    writeFileSync(
      join(runDir, "triage-result.json"),
      JSON.stringify({
        finishedAt: "2026-07-15T09:20:00.000Z",
        result: "fixed",
        needsHuman: false,
        detail: "anchored RESULT parser + 60m timeout",
        rootCause: "false RESULT: ok from rust test summary",
      }),
    );

    const st = resolveEscalateStatus(runDir);
    expect(st!.triageStatus).toBe("fixed");
    expect(st!.needsHuman).toBe(false);
    expect(st!.triageDetail).toContain("anchored");
  });

  test("blocked verdict is needs-human", () => {
    const runDir = join(home, "runs", "x", "t1");
    const triageDir = join(home, "runs", "routine-error-triage", "t2");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(triageDir, { recursive: true });
    writeFileSync(
      join(runDir, "error-escalated.json"),
      JSON.stringify({
        at: "2026-07-15T10:00:00.000Z",
        cardSlug: "routine-error-x",
        cardOk: true,
        agent: `dispatched pid=999999 dir=${triageDir}`,
        agentDispatched: true,
        triageDir,
        triagePid: 999999,
      }),
    );
    writeFileSync(
      join(triageDir, "meta.json"),
      JSON.stringify({ failedRunDir: runDir, pid: 999999 }),
    );
    writeFileSync(
      join(triageDir, "stdout.log"),
      "routine-error-triage 2026-07-15T10:30:00Z ok failed=x result=blocked detail=waiting on EXEMEM_SESSION_TOKEN secret\n",
    );

    const st = resolveEscalateStatus(runDir);
    expect(st!.triageStatus).toBe("blocked");
    expect(st!.needsHuman).toBe(true);
    expect(st!.needsHumanReason).toMatch(/EXEMEM|blocked|token/i);
  });

  test("finds triage via failedRunDir when triageDir missing", () => {
    const runDir = join(home, "runs", "y", "t1");
    const triageDir = join(home, "runs", "routine-error-triage", "found-me");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(triageDir, { recursive: true });
    writeFileSync(
      join(runDir, "error-escalated.json"),
      JSON.stringify({
        at: "2026-07-15T11:00:00.000Z",
        cardSlug: "routine-error-y",
        cardOk: true,
        agent: "dispatched pid=1 dir=/nonexistent",
        agentDispatched: true,
      }),
    );
    writeFileSync(
      join(triageDir, "meta.json"),
      JSON.stringify({ failedRunDir: runDir, pid: 1 }),
    );
    writeFileSync(
      join(triageDir, "stdout.log"),
      "routine-error-triage 2026-07-15T11:10:00Z ok failed=y result=card-updated detail=tightened prompt\n",
    );

    const st = resolveEscalateStatus(runDir);
    expect(st!.triageDir).toBe(triageDir);
    expect(st!.triageStatus).toBe("card-updated");
    expect(st!.needsHuman).toBe(false);
  });
});
