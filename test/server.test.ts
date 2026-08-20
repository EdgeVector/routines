// Dashboard server tests — exercise the JSON API end-to-end against a real
// Bun.serve instance on an ephemeral port and a throwaway ROUTINES_HOME, with
// the leaf harness stubbed. This is the card's e2e in test form: list, run-now
// for both a claude- and a codex-harness routine, pause/resume, re-route (and
// assert the registry TOML actually changed on disk), and run detail.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PAGE } from "../src/page.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

let home: string;
let server: ServerHandle;
let stubHarness: string;
let stubSituations: string;
const statusCommand = [process.execPath, new URL("./fixtures/status-command.ts", import.meta.url).pathname];

beforeAll(() => {
  // A stub harness that exits 0 quickly — no API credits, but the full
  // dispatch → spawn → log → state path runs for real.
  const dir = mkdtempSync(join(tmpdir(), "routines-srv-bins-"));
  stubHarness = join(dir, "stub-harness");
  writeFileSync(stubHarness, "#!/bin/sh\necho \"STUB ran: $*\"\nexit 0\n");
  stubSituations = join(dir, "stub-fsituations");
  // No active situations that scope these ids, so nothing is fenced.
  writeFileSync(stubSituations, "#!/bin/sh\necho '[]'\n");
  for (const f of [stubHarness, stubSituations]) require("node:fs").chmodSync(f, 0o755);
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "routines-srv-"));
  process.env.ROUTINES_HOME = home;
  process.env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES = "1";
  process.env.ROUTINES_CLAUDE_BIN = stubHarness;
  process.env.ROUTINES_CODEX_BIN = stubHarness;
  process.env.ROUTINES_GROK_BIN = stubHarness;
  process.env.ROUTINES_FSITUATIONS_BIN = stubSituations;
  process.env.ROUTINES_FBRAIN_BIN = "true"; // heartbeat no-op

  const reg = join(home, "registry");
  mkdirSync(reg, { recursive: true });
  writeFileSync(
    join(reg, "alpha.toml"),
    [
      'harness = "claude"',
      'model = "claude-opus-4-8"',
      'rrule = "FREQ=HOURLY"',
      'prompt = "hello alpha"',
      `cwd = "${home}"`,
      "timeout_min = 5",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(reg, "beta.toml"),
    [
      'harness = "codex"',
      'model = "gpt-5.5"',
      'effort = "medium"',
      'rrule = "FREQ=DAILY"',
      'prompt = "hello beta"',
      `cwd = "${home}"`,
      'status = "paused"',
      "timeout_min = 5",
      "",
    ].join("\n"),
  );

  server = startServer({ port: 0, statusCommand });
});

afterEach(() => {
  server.stop();
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.ROUTINES_HOME;
});

function u(path: string): string {
  return server.url.replace(/\/$/, "") + path;
}

test("GET / serves the self-contained dashboard page (no external assets)", async () => {
  const res = await fetch(u("/"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain("<title>routines &middot; dashboard</title>");
  // No external assets: no absolute/protocol-relative src/href to another host.
  expect(html).not.toMatch(/src="https?:\/\//);
  expect(html).not.toMatch(/href="https?:\/\//);
});

test("GET /api/routines returns the status snapshot for every routine", async () => {
  const snap = await fetch(u("/api/routines")).then((r) => r.json());
  const ids = snap.rows.map((r: any) => r.id).sort();
  expect(ids).toEqual(["alpha", "beta"]);
  const alpha = snap.rows.find((r: any) => r.id === "alpha");
  expect(alpha.harness).toBe("claude");
  expect(alpha.status).toBe("active");
  expect(alpha.nextFire).toBeTruthy(); // active → has a next fire
  const beta = snap.rows.find((r: any) => r.id === "beta");
  expect(beta.status).toBe("paused");
  expect(beta.nextFire).toBeNull(); // paused → no next fire
}, 30_000);

test("GET / stays responsive while one coalesced status collection is in flight", async () => {
  server.stop();
  const counter = join(home, "status-command-count");
  process.env.ROUTINES_TEST_STATUS_DELAY_MS = "250";
  process.env.ROUTINES_TEST_STATUS_COUNTER = counter;
  server = startServer({
    port: 0,
    statusCommand,
    statusTimeoutMs: 2_000,
  });

  const firstStatus = fetch(u("/api/routines"));
  const secondStatus = fetch(u("/api/routines"));
  await Bun.sleep(25);

  const startedAt = performance.now();
  const page = await fetch(u("/"));
  const elapsedMs = performance.now() - startedAt;
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>routines &middot; dashboard</title>");
  expect(elapsedMs).toBeLessThan(200);

  const [first, second] = await Promise.all([firstStatus, secondStatus]);
  const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(firstBody.home).toBe(home);
  expect(secondBody.home).toBe(home);
  expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
  delete process.env.ROUTINES_TEST_STATUS_DELAY_MS;
  delete process.env.ROUTINES_TEST_STATUS_COUNTER;
}, 5_000);

test("unknown routine → 404", async () => {
  const res = await fetch(u("/api/routines/nope/run"), { method: "POST" });
  expect(res.status).toBe(404);
});

test("pause + resume flip the registry status (same code path as CLI)", async () => {
  const p = await fetch(u("/api/routines/alpha/pause"), { method: "POST" }).then((r) => r.json());
  expect(p.status).toBe("paused");
  expect(readFileSync(join(home, "registry/alpha.toml"), "utf8")).toContain('status = "paused"');

  const r = await fetch(u("/api/routines/alpha/resume"), { method: "POST" }).then((res) => res.json());
  expect(r.status).toBe("active");
  expect(readFileSync(join(home, "registry/alpha.toml"), "utf8")).toContain('status = "active"');
});

test("re-route rewrites the registry TOML (model + harness)", async () => {
  const res = await fetch(u("/api/routines/beta/route"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "claude", model: "claude-sonnet-4-6" }),
  }).then((r) => r.json());
  expect(res.harness).toBe("claude");
  expect(res.model).toBe("claude-sonnet-4-6");
  const toml = readFileSync(join(home, "registry/beta.toml"), "utf8");
  expect(toml).toContain('harness = "claude"');
  expect(toml).toContain('model = "claude-sonnet-4-6"');
  expect(toml).toContain("pin = true");
  // Unrelated keys survive the in-place edit.
  expect(toml).toContain('rrule = "FREQ=DAILY"');
  expect(toml).toContain('effort = "medium"');
});

test("invalid harness on re-route → 400", async () => {
  const res = await fetch(u("/api/routines/alpha/route"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "gpt" }),
  });
  expect(res.status).toBe(400);
});

test("run-now fires a routine and the run shows up in run detail (both harnesses)", async () => {
  for (const id of ["alpha", "beta"]) {
    const started = await fetch(u(`/api/routines/${id}/run`), { method: "POST" });
    expect(started.status).toBe(202);

    // Wait for the run to complete (stub exits immediately).
    let detail: any = null;
    for (let i = 0; i < 60; i++) {
      const runsRes = await fetch(u(`/api/routines/${id}/runs`)).then((r) => r.json());
      if (runsRes.runs.length > 0 && runsRes.runs[0].exitCode !== null) {
        detail = await fetch(u(`/api/routines/${id}/runs/${encodeURIComponent(runsRes.runs[0].stamp)}`)).then((r) =>
          r.json(),
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(detail).not.toBeNull();
    expect(detail.exitCode).toBe(0);
    expect(detail.stdoutTail).toContain("STUB ran");
    expect(existsSync(join(home, "runs", id))).toBe(true);
  }
});

test("dashboard error rows follow classified lastOutcome, not leftover lastExit", () => {
  expect(PAGE).toContain("return r.lastOutcome === \"error\"");
  expect(PAGE).not.toContain("r.lastExit != null && r.lastExit !== 0");
});

test("run-now while already running is refused with 409", async () => {
  // Hold the single-flight lock by writing a live-pid lock file.
  const locks = join(home, "locks");
  mkdirSync(locks, { recursive: true });
  writeFileSync(join(locks, "alpha.lock"), String(process.pid));
  const res = await fetch(u("/api/routines/alpha/run"), { method: "POST" });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.started).toBe(false);
});
