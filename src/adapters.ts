// Harness adapters. Each adapter turns a routine + its resolved prompt into a
// concrete argv. The interface is intentionally tiny so a future harness is one
// more `case`.
//
// The leaf binary is overridable via env (ROUTINES_CLAUDE_BIN /
// ROUTINES_CODEX_BIN). Real defaults are `claude` and `codex` on PATH; the
// override exists so the e2e can point at a stub that echoes and exits without
// spending real API credits, while still exercising the full dispatch → spawn →
// log → heartbeat code path that routines actually owns.

import type { Harness, RoutineEntry } from "./registry.ts";

export interface HarnessInvocation {
  bin: string;
  args: string[];
  /** Human-readable command string for run logs (prompt elided). */
  display: string;
}

export function harnessBinary(harness: Harness): string {
  if (harness === "claude") return process.env.ROUTINES_CLAUDE_BIN ?? "claude";
  return process.env.ROUTINES_CODEX_BIN ?? "codex";
}

export function buildInvocation(entry: RoutineEntry, prompt: string): HarnessInvocation {
  const bin = harnessBinary(entry.harness);
  let args: string[];
  switch (entry.harness) {
    case "claude":
      // claude -p "<prompt>" --model <model> --output-format stream-json
      args = ["-p", prompt, "--model", entry.model, "--output-format", "stream-json"];
      break;
    case "codex":
      // codex exec "<prompt>" --model <model>
      args = ["exec", prompt, "--model", entry.model];
      if (entry.effort) args.push("--reasoning-effort", entry.effort);
      break;
    default: {
      const never: never = entry.harness;
      throw new Error(`unknown harness: ${String(never)}`);
    }
  }
  const display = displayArgs(bin, args);
  return { bin, args, display };
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
