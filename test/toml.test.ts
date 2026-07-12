import { describe, expect, test } from "bun:test";

import { parseToml, TomlError } from "../src/toml.ts";

describe("parseToml", () => {
  test("parses scalar kinds", () => {
    const out = parseToml(
      [
        'id = "disk-reclaim"',
        "timeout_min = 30",
        "status = 'active'",
        "enabled = true",
        "ratio = 1.5",
        'rrule = "FREQ=HOURLY;INTERVAL=2"  # inline comment',
      ].join("\n"),
    );
    expect(out.id).toBe("disk-reclaim");
    expect(out.timeout_min).toBe(30);
    expect(out.status).toBe("active");
    expect(out.enabled).toBe(true);
    expect(out.ratio).toBe(1.5);
    expect(out.rrule).toBe("FREQ=HOURLY;INTERVAL=2");
  });

  test("keeps # inside quoted strings", () => {
    const out = parseToml('prompt = "run pass #1 now"');
    expect(out.prompt).toBe("run pass #1 now");
  });

  test("handles escapes in basic strings", () => {
    const out = parseToml('x = "a\\tb\\nc\\"d"');
    expect(out.x).toBe('a\tb\nc"d');
  });

  test("ignores blank lines and comments", () => {
    const out = parseToml("\n# a comment\n\nk = 1\n");
    expect(out.k).toBe(1);
  });

  test("rejects tables", () => {
    expect(() => parseToml("[table]\nk = 1")).toThrow(TomlError);
  });

  test("rejects arrays", () => {
    expect(() => parseToml("k = [1, 2]")).toThrow(TomlError);
  });

  test("rejects duplicate keys", () => {
    expect(() => parseToml("k = 1\nk = 2")).toThrow(TomlError);
  });

  test("rejects unquoted bareword", () => {
    expect(() => parseToml("k = active")).toThrow(TomlError);
  });
});
