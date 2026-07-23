// Harness adapters. Each adapter turns a routine + its resolved prompt into a
// concrete argv. The interface is intentionally tiny so a future harness is one
// more `case`.
//
// The leaf binary is overridable via env (ROUTINES_CLAUDE_BIN /
// ROUTINES_CODEX_BIN) only when ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES=1.
// The override exists so tests can point at a stub that echoes and exits without
// spending real API credits, but production daemons must not inherit a temp
// harness from a previous test shell.

import { homedir } from "node:os";
import { join } from "node:path";

import type { Harness, RoutineEntry } from "./registry.ts";
import { memoryDir, routinesHome } from "./paths.ts";

export interface HarnessInvocation {
  bin: string;
  args: string[];
  /** Human-readable command string for run logs (prompt elided). */
  display: string;
  /**
   * If set, written to the child's stdin. Codex `exec` is reliable when the
   * prompt is fed via `-` + stdin; multi-line prompts that start with `---`
   * (YAML frontmatter) are rejected as unexpected argv when passed positionally.
   */
  stdin?: string;
}

export function harnessBinary(harness: Harness): string {
  switch (harness) {
    case "claude":
      return harnessOverride("ROUTINES_CLAUDE_BIN") ?? "claude";
    case "codex":
      return harnessOverride("ROUTINES_CODEX_BIN") ?? "codex";
    case "grok":
      return harnessOverride("ROUTINES_GROK_BIN") ?? "grok";
    default: {
      const never: never = harness;
      throw new Error(`unknown harness: ${String(never)}`);
    }
  }
}

function harnessOverride(envKey: string): string | undefined {
  if (process.env.ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES !== "1") return undefined;
  const value = process.env[envKey];
  return value && value.length > 0 ? value : undefined;
}

export function buildInvocation(entry: RoutineEntry, prompt: string): HarnessInvocation {
  const bin = harnessBinary(entry.harness);
  let args: string[];
  switch (entry.harness) {
    case "claude":
      // Options BEFORE the prompt. stream-json requires --verbose with -p/--print
      // (Claude Code: "When using --print, --output-format=stream-json requires --verbose").
      // End option parsing with `--` so prompts that start with `---` (YAML
      // skill frontmatter) are not mistaken for unknown long options.
      args = [
        "-p",
        "--verbose",
        "--model",
        entry.model,
        "--output-format",
        "stream-json",
        "--",
        prompt,
      ];
      break;
    case "codex": {
      // Options before `-`. Feed the prompt on stdin — positional prompts that
      // start with `---` (skill frontmatter) are rejected as unexpected args by
      // clap on current codex. Effort via config override (no --reasoning-effort).
      // --skip-git-repo-check: fleet cwds may be workspace roots, not a git repo.
      // --ephemeral: no session persist noise for scheduled runs.
      // --add-dir: automation memory + LastDB socket homes live outside the
      // workspace cwd; without these, agents report memory_unwritable and cannot
      // talk to socket-backed CLIs that need writeable state dirs.
      args = [
        "exec",
        "--model",
        entry.model,
        "--skip-git-repo-check",
        "--ephemeral",
      ];
      for (const dir of codexWritableDirs()) {
        args.push("--add-dir", dir);
      }
      if (entry.effort) {
        args.push("-c", `model_reasoning_effort=${JSON.stringify(entry.effort)}`);
      }
      args.push("-"); // read prompt from stdin
      const inv: HarnessInvocation = {
        bin,
        args,
        display: displayArgs(bin, [...args.slice(0, -1), `<prompt-stdin:${prompt.length} chars>`]),
        stdin: prompt,
      };
      return inv;
    }
    case "grok":
      // Grok Build headless: -p/--single prints and exits. Options before -p.
      // --always-approve for unattended fleet runs (tools may run without prompts).
      // Docs also mention --yolo; current CLI exposes --always-approve.
      args = [
        "-m",
        entry.model,
        "--always-approve",
        "--permission-mode",
        "bypassPermissions",
        "--output-format",
        "streaming-json",
      ];
      if (entry.effort) {
        args.push("--reasoning-effort", entry.effort);
      }
      // -p takes the prompt as its value; keep it last so multi-line bodies are one arg.
      args.push("-p", prompt);
      break;
    default: {
      const never: never = entry.harness;
      throw new Error(`unknown harness: ${String(never)}`);
    }
  }
  const display = displayArgs(bin, args);
  return { bin, args, display };
}

/**
 * Extra dirs Codex may write outside the routine cwd (workspace-write sandbox).
 *
 * Policy (brain `concepts-edgevector-run-dev-state-board`): allow **pretty**
 * homes agents name *and* **real** XDG/state paths behind managed symlinks.
 * Codex follows symlink realpaths on write — e.g. `~/.last-stack/logs` →
 * `~/.local/state/last-stack/runtime/logs`. Omitting the realpath causes
 * EPERM after green work (heartbeats, proofs, dogfood under runtime/).
 *
 * Do not add host-track `current` as a write target; agents must not develop
 * there (RUN bucket). DEV is worktrees only.
 */
export function codexWritableDirs(): string[] {
  const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
  const dirs = [
    memoryDir(),
    routinesHome(),
    join(home, ".codex", "automations"),
    join(home, ".lastdb"),
    join(home, ".folddb"), // legacy alias → often symlink to ~/.lastdb
    join(home, ".kanban"), // legacy alias → often symlink to ~/.fkanban
    join(home, ".fkanban"),
    join(home, ".last-stack"), // compat root (mostly symlinks into state/)
    // STATE realpath for entire managed last-stack layout (logs, proofs, …)
    join(home, ".local", "state", "last-stack"),
    join(home, ".lastgit"),
    join(home, ".brain"),
    // Portal git cache (wt fetch); read/write during routine portal ops
    join(home, ".cache", "edgevector-git"),
  ];
  // De-dupe while preserving order (ROUTINES_HOME may equal ~/.routines).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

// Render the invocation with the (potentially huge) prompt argument elided so
// run logs stay readable and never leak a full prompt into a one-line summary.
function displayArgs(bin: string, args: string[]): string {
  const shown = args.map((a) => (a.length > 80 ? `<prompt:${a.length} chars>` : shellQuote(a)));
  return [bin, ...shown].join(" ");
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
