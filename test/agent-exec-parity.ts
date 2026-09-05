// Parity proof: the public `routines agent-exec` command and the scheduler's
// own dispatch path (daemon.routeForAvailability) resolve identically.
//
// External agent hosts (Loom) treat `agent-exec` as the single source of truth
// for provider/model routing. This harness drives BOTH paths — the scheduler
// adapter in-process, the public command as a real subprocess of bin/routines —
// across a matrix of difficulty x mode x active-fence combinations, against
// the SAME fabricated Situations snapshot, and requires identical provider,
// model, and matrix version for every combination.
//
// Fully isolated: a temp ROUTINES_HOME, a private routing matrix, and a stub
// `situations` CLI that serves the fabricated snapshot from a file. It starts
// no agent process and never touches the live LastDB socket, so it consumes no
// provider credits.
//
// Standalone on purpose (not a bun:test file): it prints PASS/FAIL per
// combination and exits nonzero on any mismatch, so .lastgit/ci.sh can run it
// as an explicit gate and a human can run it by hand:
//
//   bun test/agent-exec-parity.ts

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "routines-parity-"));
const situationsFile = join(home, "parity-situations.json");
const matrixPath = join(home, "routing-matrix.json");

// Distinctive version + per-cell model names, so a copy-paste bug in either
// path cannot false-pass against the shipped defaults.
const MATRIX = {
  version: 43,
  providerOrder: ["grok", "codex", "claude"],
  matrix: {
    fast: { grok: { model: "grok-fast-p" }, codex: { model: "codex-fast-p" }, claude: { model: "claude-fast-p" } },
    normal: { grok: { model: "grok-normal-p" }, codex: { model: "codex-normal-p" }, claude: { model: "claude-normal-p" } },
    hard: { grok: { model: "grok-hard-p" }, codex: { model: "codex-hard-p" }, claude: { model: "claude-hard-p" } },
  },
} as const;
writeFileSync(matrixPath, JSON.stringify(MATRIX));

// Stub situations CLI: serve the fabricated snapshot for `list --json`. The
// subprocess and the in-process scheduler adapter therefore see the identical
// Situations state, and nothing reads the live socket.
const stub = join(home, "stub-situations");
writeFileSync(stub, '#!/bin/sh\ncat "$PARITY_SITUATIONS_FILE"\n');
chmodSync(stub, 0o755);

// The in-process side (registry-time resolveDifficulty + routeForAvailability)
// reads the same env the subprocess gets. Set it before importing src modules
// is not required — both read env at call time — but set it first anyway so a
// future load-time read cannot split the two configs.
process.env.ROUTINES_HOME = home;
process.env.ROUTINES_ROUTING_MATRIX_PATH = matrixPath;
process.env.ROUTINES_SITUATIONS_CLI = stub;
process.env.ROUTINES_FSITUATIONS_BIN = stub;
process.env.PARITY_SITUATIONS_FILE = situationsFile;

const { routeForAvailability } = await import("../src/daemon.ts");
const { resolveDifficulty, DIFFICULTIES } = await import("../src/difficulty-matrix.ts");
const { ROUTE_MODES } = await import("../src/route-engine.ts");

type Situation = { slug: string; status: string; scope_routines: string[] };

function outage(harness: string): Situation {
  return { slug: `harness-outage-${harness}`, status: "active", scope_routines: ["*"] };
}

const FENCES: { name: string; situations: Situation[] }[] = [
  { name: "none", situations: [] },
  // Preferred provider (providerOrder[0]) fenced by an active outage Situation.
  { name: "preferred-fenced", situations: [outage(MATRIX.providerOrder[0])] },
];

const binPath = join(import.meta.dir, "..", "bin", "routines");

interface CliDecision {
  harness: string | null;
  model: string | null;
  matrixVersion: number;
  requestId: string | null;
  empty: boolean;
}

/**
 * Run the real public command as a subprocess against the fabricated state.
 * bin/routines is invoked as the executable itself, not via `bun <path>`:
 * after `bun run build` the artifact step replaces it with a bash launcher
 * for the compiled dist/routines, so in CI this exercises the exact shipped
 * entry point external callers get.
 */
function runAgentExec(args: string[]): { exitCode: number; decision: CliDecision } {
  const res = spawnSync(binPath, ["agent-exec", ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ROUTINES_HOME: home,
      ROUTINES_ROUTING_MATRIX_PATH: matrixPath,
      ROUTINES_SITUATIONS_CLI: stub,
      ROUTINES_FSITUATIONS_BIN: stub,
      PARITY_SITUATIONS_FILE: situationsFile,
    },
    timeout: 30_000,
  });
  if (res.error) throw new Error(`agent-exec subprocess failed to start: ${res.error.message}`);
  let decision: CliDecision;
  try {
    decision = JSON.parse(res.stdout || "null");
  } catch {
    throw new Error(
      `agent-exec printed non-JSON (exit ${res.status}):\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  return { exitCode: res.status ?? -1, decision };
}

let pass = 0;
let fail = 0;

function report(ok: boolean, label: string, detail: string): void {
  if (ok) {
    pass += 1;
    console.log(`PASS ${label} → ${detail}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label} → ${detail}`);
  }
}

// --- 1. Matrix-routed parity: difficulty x mode x fence -------------------

for (const fence of FENCES) {
  writeFileSync(situationsFile, JSON.stringify(fence.situations));
  for (const difficulty of DIFFICULTIES) {
    for (const mode of ROUTE_MODES) {
      const label = `difficulty=${difficulty} mode=${mode} fence=${fence.name}`;

      // Scheduler path: a registry entry resolves its primary route at load
      // time with no fences (what loadAll does), then the dispatch pass
      // re-routes it against the active Situations snapshot.
      const loadTime = resolveDifficulty(difficulty);
      const scheduled = routeForAvailability(
        {
          id: `parity-${difficulty}-${mode}-${fence.name}`,
          harness: loadTime.harness,
          model: loadTime.model,
          difficulty,
          resolvedBy: "matrix",
          matrixResolution: loadTime,
        } as never,
        fence.situations,
      );

      // Public path: the real command, same snapshot.
      const requestId = `parity-${difficulty}-${mode}-${fence.name}`;
      const { exitCode, decision } = runAgentExec([
        "--difficulty", difficulty,
        "--mode", mode,
        "--timeout-ms", "60000",
        "--request-id", requestId,
      ]);

      const schedVersion = scheduled.matrixResolution?.version;
      const same =
        exitCode === 0 &&
        !decision.empty &&
        decision.requestId === requestId &&
        decision.harness === scheduled.harness &&
        decision.model === scheduled.model &&
        decision.matrixVersion === schedVersion;
      report(
        same,
        label,
        `scheduler=${scheduled.harness}/${scheduled.model} v${schedVersion} · ` +
          `agent-exec=${decision.harness}/${decision.model} v${decision.matrixVersion} (exit ${exitCode})`,
      );

      // Semantic anchors, so both-paths-wrong cannot slip through as "equal":
      // no fence → the configured primary; preferred fenced → not the primary.
      if (fence.name === "none" && scheduled.harness !== MATRIX.providerOrder[0]) {
        report(false, label, `anchor: expected primary ${MATRIX.providerOrder[0]}, got ${scheduled.harness}`);
      }
      if (fence.name === "preferred-fenced" && scheduled.harness === MATRIX.providerOrder[0]) {
        report(false, label, `anchor: fenced primary ${MATRIX.providerOrder[0]} was still selected`);
      }
    }
  }
}

// --- 2. Durable pin parity (pin live) -------------------------------------

// Preferred provider fenced, pin on an unfenced provider: both paths must hold
// the pin. The scheduler models a durable pin as a resolvedBy:"pin" entry the
// dispatch pass leaves untouched; agent-exec takes the pinned cell's model
// from the same matrix.
{
  const pinned = "claude";
  const difficulty = "hard";
  writeFileSync(situationsFile, JSON.stringify([outage(MATRIX.providerOrder[0])]));

  const scheduled = routeForAvailability(
    {
      id: "parity-pin",
      harness: pinned,
      model: MATRIX.matrix[difficulty][pinned].model,
      resolvedBy: "pin",
      routingPin: true,
    } as never,
    [outage(MATRIX.providerOrder[0])],
  );
  const { exitCode, decision } = runAgentExec([
    "--difficulty", difficulty,
    "--mode", "write",
    "--pin", pinned,
    "--request-id", "parity-pin",
  ]);
  const same =
    exitCode === 0 &&
    decision.harness === scheduled.harness &&
    decision.model === scheduled.model &&
    decision.matrixVersion === MATRIX.version;
  report(
    same,
    `difficulty=${difficulty} mode=write pin=${pinned} fence=preferred-fenced`,
    `scheduler=${scheduled.harness}/${scheduled.model} · ` +
      `agent-exec=${decision.harness}/${decision.model} v${decision.matrixVersion} (exit ${exitCode})`,
  );
}

// --- 3. Fenced pin: agent-exec refuses to start the provider ---------------

// Intentional asymmetry, asserted so it stays deliberate: when the pinned
// provider itself is fenced, agent-exec returns an EMPTY route (exit 3) — the
// external caller parks. The scheduler instead keeps the pinned entry and
// fences the run at dispatch (skip-fence), so no provider starts there either.
{
  writeFileSync(situationsFile, JSON.stringify([outage("claude")]));
  const { exitCode, decision } = runAgentExec([
    "--difficulty", "fast",
    "--mode", "write",
    "--pin", "claude",
    "--request-id", "parity-pin-fenced",
  ]);
  const ok = exitCode === 3 && decision.empty && decision.harness === null && decision.model === null;
  report(
    ok,
    "difficulty=fast mode=write pin=claude fence=pinned-provider",
    `agent-exec empty=${decision.empty} harness=${decision.harness} (exit ${exitCode}, want 3)`,
  );
}

rmSync(home, { recursive: true, force: true });

console.log("");
if (fail > 0) {
  console.log(`PARITY FAIL — ${fail} of ${pass + fail} checks mismatched`);
  process.exit(1);
}
console.log(`PARITY PASS — ${pass} checks: agent-exec matches scheduler dispatch`);
