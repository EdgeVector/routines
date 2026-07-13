import { describe, expect, test } from "bun:test";

import { parseEntry, RegistryError } from "../src/registry.ts";

const base = [
  'harness = "claude"',
  'model = "opus"',
  'rrule = "FREQ=HOURLY;INTERVAL=2"',
  'prompt = "do the thing"',
].join("\n");

describe("parseEntry", () => {
  test("parses a valid entry, id from filename", () => {
    const e = parseEntry(base, "/x/disk-reclaim.toml");
    expect(e.id).toBe("disk-reclaim");
    expect(e.harness).toBe("claude");
    expect(e.model).toBe("opus");
    expect(e.status).toBe("active");
    expect(e.timeoutMin).toBe(30);
    expect(e.prompt).toBe("do the thing");
    expect(e.parsedRrule.freq).toBe("HOURLY");
  });

  test("id must match filename when set", () => {
    expect(() => parseEntry('id = "other"\n' + base, "/x/disk-reclaim.toml")).toThrow(RegistryError);
    const ok = parseEntry('id = "disk-reclaim"\n' + base, "/x/disk-reclaim.toml");
    expect(ok.id).toBe("disk-reclaim");
  });

  test("requires a prompt source", () => {
    const noPrompt = 'harness = "codex"\nmodel = "gpt"\nrrule = "FREQ=DAILY"';
    expect(() => parseEntry(noPrompt, "/x/r.toml")).toThrow(/prompt/);
  });

  test("rejects both prompt sources", () => {
    const both = base + '\nprompt_path = "/tmp/p.md"';
    expect(() => parseEntry(both, "/x/r.toml")).toThrow(/only one/);
  });

  test("rejects bad harness", () => {
    const bad = base.replace('harness = "claude"', 'harness = "gemini"');
    expect(() => parseEntry(bad, "/x/r.toml")).toThrow(/harness/);
  });

  test("accepts grok harness", () => {
    const text = [
      'harness = "grok"',
      'model = "grok-4.5"',
      'rrule = "FREQ=DAILY"',
      'prompt = "hi"',
    ].join("\n");
    const e = parseEntry(text, "/x/g.toml");
    expect(e.harness).toBe("grok");
    expect(e.model).toBe("grok-4.5");
  });

  test("rejects unknown key", () => {
    expect(() => parseEntry(base + '\nbogus = "x"', "/x/r.toml")).toThrow(/unknown key/);
  });

  test("rejects invalid rrule", () => {
    const bad = base.replace('rrule = "FREQ=HOURLY;INTERVAL=2"', 'rrule = "FREQ=NOPE"');
    expect(() => parseEntry(bad, "/x/r.toml")).toThrow(/rrule/);
  });

  test("carries optional effort + heartbeat_slug", () => {
    const e = parseEntry(base + '\neffort = "high"\nheartbeat_slug = "routine-heartbeats"', "/x/disk-reclaim.toml");
    expect(e.effort).toBe("high");
    expect(e.heartbeatSlug).toBe("routine-heartbeats");
  });
});
