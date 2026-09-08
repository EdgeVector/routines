// Bounded, payload-free execution facts. Never retain prompts, tool arguments,
// tool output, or error messages here. Provider-reported cost is not estimated.
import type { Harness } from "./registry.ts";

export interface ExecutionRecord {
  version: 1;
  provider: Harness;
  model: string;
  sessionId: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  costUsd: number | null;
  tools: { completed: number; failed: number };
  modelErrors: number;
  malformedEvents: number;
  truncated: boolean;
}

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export const validSessionId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(v);

export class ExecutionCollector {
  readonly record: ExecutionRecord;
  private pending = "";
  private discard = false;
  private seen = new Set<string>();
  constructor(provider: Harness, model: string, private changed?: () => void) {
    this.record = { version: 1, provider, model, sessionId: null, inputTokens: null,
      cachedInputTokens: null, cacheCreationInputTokens: null, outputTokens: null,
      reasoningOutputTokens: null, costUsd: null, tools: { completed: 0, failed: 0 },
      modelErrors: 0, malformedEvents: 0, truncated: false };
  }

  // A single oversized event is discarded through its newline. Following
  // events remain parseable, even when the oversized event spans many chunks.
  push(chunk: string): void {
    for (const part of chunk.split(/(?<=\n)/)) {
      const ends = part.endsWith("\n");
      if (!this.discard) {
        if (this.pending.length + part.length > 1_048_576) {
          this.pending = "";
          this.discard = true;
          this.record.truncated = true;
        } else this.pending += part;
      }
      if (ends) {
        if (!this.discard) this.line(this.pending);
        this.pending = "";
        this.discard = false;
      }
    }
  }
  finish(): void {
    if (this.pending && !this.discard) this.line(this.pending);
    this.pending = "";
  }
  private once(id: string): boolean {
    if (this.seen.has(id)) return false;
    if (this.seen.size >= 8192) { this.record.truncated = true; return false; }
    this.seen.add(id);
    return true;
  }
  private usage(v: unknown, cumulative: boolean): void {
    const u = row(v);
    const fields = {
      inputTokens: u.input_tokens ?? u.prompt_tokens,
      cachedInputTokens: u.cached_input_tokens ?? u.cache_read_input_tokens ?? row(u.prompt_tokens_details).cached_tokens,
      cacheCreationInputTokens: u.cache_creation_input_tokens,
      outputTokens: u.output_tokens ?? u.completion_tokens,
      reasoningOutputTokens: u.reasoning_output_tokens ?? row(u.completion_tokens_details).reasoning_tokens,
    };
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      const n = number(fields[key]);
      if (n !== null) this.record[key] = cumulative ? n : (this.record[key] ?? 0) + n;
    }
  }
  private line(text: string): void {
    if (!text.trimStart().startsWith("{")) return;
    let e: Row;
    try { e = row(JSON.parse(text)); } catch { this.record.malformedEvents++; return; }
    const p = this.record.provider;
    if (p === "codex") {
      if (e.type === "thread.started" && validSessionId(e.thread_id)) this.record.sessionId = e.thread_id;
      if (e.type === "turn.completed") {
        this.usage(e.usage, false);
      }
      if (e.type === "turn.failed" || e.type === "error") this.record.modelErrors++;
      const item = row(e.item);
      if (e.type === "item.completed" && ["command_execution", "mcp_tool_call", "file_change", "web_search"].includes(String(item.type)) &&
          typeof item.id === "string" && this.once(`tool:${item.id}`)) {
        this.record.tools.completed++;
        if (item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0) || item.error != null) this.record.tools.failed++;
      }
    } else if (p === "claude" || p === "grok") {
      if ((e.type === "system" || e.type === "result") && validSessionId(e.session_id)) this.record.sessionId = e.session_id;
      const message = row(e.message);
      if (e.type === "assistant" && typeof message.id === "string" && this.once(`message:${message.id}`)) this.usage(message.usage, false);
      if (e.type === "result") {
        this.usage(e.usage, true);
        const cost = number(e.total_cost_usd ?? e.cost_usd);
        if (cost !== null) this.record.costUsd = cost;
        if (e.is_error === true) this.record.modelErrors++;
      }
      if (e.type === "error") this.record.modelErrors++;
      if (e.type === "user" && Array.isArray(message.content)) {
        for (const value of message.content) {
          const block = row(value);
          if (block.type === "tool_result" && typeof block.tool_use_id === "string" && this.once(`tool:${block.tool_use_id}`)) {
            this.record.tools.completed++;
            if (block.is_error === true) this.record.tools.failed++;
          }
        }
      }
    }
    // Text-only providers remain unknown. Never infer usage from prose.
    this.changed?.();
  }
}
