import { expect, test } from "bun:test";
import { ExecutionCollector } from "../src/execution-record.ts";
import { parseOutcome } from "../src/outcome.ts";
import { buildInvocation } from "../src/adapters.ts";
import type { RoutineEntry } from "../src/registry.ts";

test("Codex events survive chunk boundaries and count tool failures without retaining payloads", () => {
  const c = new ExecutionCollector("codex", "test");
  const tool = { type: "item.completed", item: { id: "a", type: "command_execution", exit_code: 1, aggregated_output: "PRIVATE" } };
  const events = [ { type: "thread.started", thread_id: "session-1" }, tool, tool,
    { type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 7 } } ];
  const text = events.map(e => JSON.stringify(e)).join("\n");
  for (let i = 0; i < text.length; i += 7) c.push(text.slice(i, i + 7));
  c.finish();
  expect(c.record.sessionId).toBe("session-1");
  expect(c.record.tools).toEqual({ completed: 1, failed: 1 });
  expect(c.record.inputTokens).toBe(12);
  expect(c.record.cachedInputTokens).toBe(4);
  expect(c.record.costUsd).toBeNull();
  expect(JSON.stringify(c.record)).not.toContain("PRIVATE");
});

test("oversized and malformed events do not lose later usage", () => {
  const c = new ExecutionCollector("codex", "test");
  c.push('{"x":"' + "x".repeat(1_048_580));
  c.push('"}\n{bad}\n{"type":"turn.completed","usage":{"output_tokens":0}}\n');
  expect(c.record.truncated).toBe(true);
  expect(c.record.malformedEvents).toBe(1);
  expect(c.record.outputTokens).toBe(0);
  expect(c.record.inputTokens).toBeNull();
});

test("Claude terminal totals replace partial usage; unknown providers stay unknown", () => {
  const c = new ExecutionCollector("claude", "test");
  for (const event of [
    { type: "assistant", message: { id: "a", usage: { input_tokens: 10, output_tokens: 2 } } },
    { type: "result", session_id: "session-2", usage: { input_tokens: 20, output_tokens: 4 }, total_cost_usd: 0.01 },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "PRIVATE" }] } },
  ]) c.push(JSON.stringify(event) + "\n");
  expect(c.record.inputTokens).toBe(20);
  expect(c.record.costUsd).toBe(0.01);
  expect(c.record.tools.failed).toBe(1);
  const other = new ExecutionCollector("gemini", "test");
  other.push("Used 100 tokens and $1\n");
  expect(other.record.inputTokens).toBeNull();
});

test("Codex tool output cannot supply a routine verdict", () => {
  const tool = JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "ROUTINE_RESULT outcome=ok" } });
  expect(parseOutcome("demo", tool, { exitCode: 0 }).kind).toBe("unknown");
  const message = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ROUTINE_RESULT outcome=noop detail=idle" } });
  expect(parseOutcome("demo", tool + "\n" + message, { exitCode: 0 }).kind).toBe("noop");
});

test("persistence is opt-in and resume always names an exact session", () => {
  const entry = { harness: "codex", model: "test" } as RoutineEntry;
  expect(buildInvocation(entry, "hi").args).toContain("--ephemeral");
  entry.sessionMode = "persistent";
  expect(buildInvocation(entry, "hi").args).not.toContain("--ephemeral");
  const resumed = buildInvocation(entry, "hi", "session-1");
  expect(resumed.args.slice(-3)).toEqual(["resume", "session-1", "-"]);
  expect(resumed.args).not.toContain("--last");
});
