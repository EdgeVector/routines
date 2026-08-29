import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.ts";
import { routeForAvailability } from "../src/daemon.ts";
import { routeAgent } from "../src/route-engine.ts";
import type { ActiveSituation } from "../src/situations.ts";
import type { RoutineEntry } from "../src/registry.ts";

let home: string;
let binDir: string;
const savedEnv = { ...process.env };

/** Three providers, so a single fence still leaves a live route. */
const MATRIX = {
  version: 7,
  providerOrder: ["grok", "codex", "claude"],
  matrix: {
    fast: { grok: { model: "grok-fast" }, codex: { model: "codex-fast" }, claude: { model: "claude-fast" } },
    normal: { grok: { model: "grok-normal" }, codex: { model: "codex-normal" }, claude: { model: "claude-normal" } },
    hard: { grok: { model: "grok-hard" }, codex: { model: "codex-hard" }, claude: { model: "claude-hard" } },
  },
};

function outage(harness: string): ActiveSituation {
  return { slug: `harness-outage-${harness}`, scope_routines: ["*"] };
}

/** Record a local outage expiry, the retry hint the engine reports. */
function writeOutageState(harness: string, expiresAt: string): void {
  const dir = join(home, "harness-outage");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${harness}.json`),
    JSON.stringify({
      kind: "usage-limit",
      lastSeenAt: new Date().toISOString(),
      situationSlug: `harness-outage-${harness}`,
      expiresAt,
    }),
  );
}

beforeEach(() => {
  process.env = { ...savedEnv };
  home = mkdtempSync(join(tmpdir(), "routines-route-"));
  binDir = mkdtempSync(join(tmpdir(), "routines-route-bin-"));
  process.env.ROUTINES_HOME = home;
  const matrixPath = join(home, "routing-matrix.json");
  writeFileSync(matrixPath, JSON.stringify(MATRIX));
  process.env.ROUTINES_ROUTING_MATRIX_PATH = matrixPath;
  // No live Situations unless a test passes them explicitly.
  const stub = join(binDir, "stub-fsituations");
  writeFileSync(stub, "#!/bin/sh\necho '[]'\n");
  chmodSync(stub, 0o755);
  process.env.ROUTINES_FSITUATIONS_BIN = stub;
  process.env.ROUTINES_SITUATIONS_CLI = stub;
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test("normal selection takes the first provider in the matrix order", () => {
  const decision = routeAgent({ difficulty: "normal", mode: "read", situations: [] });
  expect(decision.empty).toBe(false);
  expect(decision.harness).toBe("grok");
  expect(decision.model).toBe("grok-normal");
  expect(decision.matrixVersion).toBe(7);
  expect(decision.fallback).toBe(false);
  expect(decision.guardRequired).toBe(false);
  expect(decision.fenced).toEqual([]);
  expect(decision.reasons).toContain("selected=grok model=grok-normal");
  expect(decision.retry.retryable).toBe(false);
});

test("an active fence blocks that provider and the route falls to the next", () => {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  writeOutageState("grok", expiresAt);
  const decision = routeAgent({
    difficulty: "hard",
    mode: "write",
    situations: [outage("grok")],
  });
  expect(decision.harness).toBe("codex");
  expect(decision.model).toBe("codex-hard");
  expect(decision.fallback).toBe(true);
  // A write that landed on a fallback must prove its guard token first.
  expect(decision.guardRequired).toBe(true);
  expect(decision.fenced).toEqual([
    { harness: "grok", situation: "harness-outage-grok", retryAt: expiresAt },
  ]);
  expect(decision.retry).toEqual({
    retryable: true,
    retryAt: expiresAt,
    situations: ["harness-outage-grok"],
  });
  expect(decision.reasons).toContain("fenced=grok:harness-outage-grok");
});

test("an ordinary agent error does not fence a provider", () => {
  // Local outage state exists (that is where agent errors land) but no
  // Situation is active, so the provider must still start.
  writeOutageState("grok", new Date(Date.now() + 3_600_000).toISOString());
  const decision = routeAgent({ difficulty: "normal", mode: "read", situations: [] });
  expect(decision.harness).toBe("grok");
  expect(decision.fenced).toEqual([]);
});

test("a durable pin wins over the matrix order", () => {
  const decision = routeAgent({
    difficulty: "fast",
    mode: "read",
    pin: "claude",
    situations: [],
  });
  expect(decision.harness).toBe("claude");
  expect(decision.model).toBe("claude-fast");
  expect(decision.pinned).toBe(true);
  expect(decision.reasons).toContain("pin=claude");
});

test("a fenced pin yields an empty route instead of falling off the pin", () => {
  const decision = routeAgent({
    difficulty: "fast",
    mode: "write",
    pin: "claude",
    situations: [outage("claude")],
  });
  expect(decision.empty).toBe(true);
  expect(decision.harness).toBeNull();
  expect(decision.model).toBeNull();
  expect(decision.retry.retryable).toBe(true);
  expect(decision.reasons).toContain("empty-route=pin-fenced:claude");
});

test("a pin outside the matrix is an empty route that waiting does not fix", () => {
  const decision = routeAgent({
    difficulty: "fast",
    mode: "read",
    pin: "gemini",
    situations: [],
  });
  expect(decision.empty).toBe(true);
  expect(decision.retry.retryable).toBe(false);
  expect(decision.reasons).toContain("empty-route=pin-not-in-matrix:gemini");
});

test("every provider fenced yields an empty route with the block evidence", () => {
  const situations = [outage("grok"), outage("codex"), outage("claude")];
  const decision = routeAgent({ difficulty: "normal", mode: "write", situations });
  expect(decision.empty).toBe(true);
  expect(decision.harness).toBeNull();
  expect(decision.retry.situations.sort()).toEqual([
    "harness-outage-claude",
    "harness-outage-codex",
    "harness-outage-grok",
  ]);
  expect(decision.reasons).toContain("empty-route=all-providers-fenced");
});

test("the scheduler keeps its configured primary when every provider is fenced", () => {
  const situations = [outage("grok"), outage("codex"), outage("claude")];
  const decision = routeAgent({
    difficulty: "normal",
    mode: "write",
    situations,
    allFenced: "primary",
  });
  expect(decision.empty).toBe(false);
  expect(decision.harness).toBe("grok");
  expect(decision.reasons).toContain("all-fenced-keep-primary=grok");
});

test("the scheduler and agent-exec pick the same provider for one difficulty", () => {
  const situations = [outage("grok")];
  const entry = {
    id: "parity",
    harness: "grok",
    model: "grok-hard",
    difficulty: "hard",
    resolvedBy: "matrix",
  } as unknown as RoutineEntry;

  const scheduled = routeForAvailability(entry, situations);
  const external = routeAgent({ difficulty: "hard", mode: "write", situations });

  expect(scheduled.harness).toBe(external.harness!);
  expect(scheduled.model).toBe(external.model!);
  expect(scheduled.matrixResolution?.version).toBe(external.matrixVersion);
});

test("agent-exec prints the decision as JSON and exits 3 on an empty route", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value));
  };
  try {
    const ok = await main(["agent-exec", "--difficulty", "normal", "--mode", "read", "--request-id", "loom-node-7"]);
    expect(ok).toBe(0);
    const decision = JSON.parse(lines.join("\n"));
    expect(decision.harness).toBe("grok");
    expect(decision.model).toBe("grok-normal");
    expect(decision.matrixVersion).toBe(7);
    expect(decision.requestId).toBe("loom-node-7");
    expect(Array.isArray(decision.reasons)).toBe(true);

    lines.length = 0;
    const fenced = join(binDir, "stub-fenced");
    writeFileSync(
      fenced,
      "#!/bin/sh\ncat <<'JSON'\n[{\"slug\":\"harness-outage-grok\",\"status\":\"active\",\"scope_routines\":[\"*\"]},{\"slug\":\"harness-outage-codex\",\"status\":\"active\",\"scope_routines\":[\"*\"]},{\"slug\":\"harness-outage-claude\",\"status\":\"active\",\"scope_routines\":[\"*\"]}]\nJSON\n",
    );
    chmodSync(fenced, 0o755);
    process.env.ROUTINES_SITUATIONS_CLI = fenced;

    const empty = await main(["agent-exec", "--difficulty", "hard", "--mode", "write"]);
    expect(empty).toBe(3);
    const blocked = JSON.parse(lines.join("\n"));
    expect(blocked.empty).toBe(true);
    expect(blocked.harness).toBeNull();
    expect(blocked.retry.situations).toContain("harness-outage-grok");
  } finally {
    console.log = originalLog;
  }
});

test("agent-exec rejects a missing or invalid difficulty and mode", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    expect(await main(["agent-exec", "--mode", "read"])).toBe(2);
    expect(await main(["agent-exec", "--difficulty", "sideways", "--mode", "read"])).toBe(2);
    expect(await main(["agent-exec", "--difficulty", "normal", "--mode", "sideways"])).toBe(2);
    expect(await main(["agent-exec", "--difficulty", "normal", "--mode", "read", "--pin", "nope"])).toBe(2);
    expect(
      await main(["agent-exec", "--difficulty", "normal", "--mode", "read", "--timeout-ms", "0"]),
    ).toBe(2);
  } finally {
    console.error = originalError;
  }
});
