import { describe, expect, test } from "bun:test";

import { extractRunSummary } from "../src/runs.ts";

describe("extractRunSummary", () => {
  test("prefers ROUTINE_RESULT", () => {
    const text = `
noise
{"type":"assistant"}
ROUTINE_RESULT outcome=ok detail=bites=5 cards=2
`;
    const s = extractRunSummary(text);
    expect(s.source).toBe("routine_result");
    expect(s.text).toContain("ok");
    expect(s.text).toContain("bites=5");
  });

  test("extracts Claude stream-json final result text", () => {
    const result = "Run complete.\\n\\n## Retro 2026-07-14 — 5 bites";
    const text = `{"type":"assistant","message":{}}
{"type":"result","subtype":"success","is_error":false,"result":"${result}","stop_reason":"end_turn"}
`;
    const s = extractRunSummary(text);
    expect(s.source).toBe("claude_result");
    expect(s.text).toContain("Run complete");
    expect(s.text).toContain("Retro 2026-07-14");
    expect(s.text).not.toContain("\\n\\n");
  });

  test("returns null when only noise", () => {
    const s = extractRunSummary('{"type":"assistant","message":{"content":[]}}');
    expect(s.text).toBeNull();
  });
});
