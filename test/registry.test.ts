import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("resolves a difficulty-only entry from the versioned global matrix", () => {
    const dir = mkdtempSync(join(tmpdir(), "routines-matrix-"));
    const matrixPath = join(dir, "routing-matrix.json");
    writeFileSync(matrixPath, JSON.stringify({
      version: 7,
      providerOrder: ["codex", "grok", "claude"],
      matrix: {
        fast: { codex: { model: "fast-c" }, grok: { model: "fast-g" }, claude: { model: "fast-a" } },
        normal: { codex: { model: "normal-c" }, grok: { model: "normal-g" }, claude: { model: "normal-a" } },
        hard: { codex: { model: "hard-c" }, grok: { model: "hard-g" }, claude: { model: "hard-a" } },
      },
    }));
    const old = process.env.ROUTINES_ROUTING_MATRIX_PATH;
    process.env.ROUTINES_ROUTING_MATRIX_PATH = matrixPath;
    try {
      const e = parseEntry('difficulty = "hard"\nrrule = "FREQ=DAILY"\nprompt = "hi"', "/x/matrix.toml");
      expect(e.harness).toBe("codex");
      expect(e.model).toBe("hard-c");
      expect(e.resolvedBy).toBe("matrix");
      expect(e.matrixResolution).toEqual({ version: 7, difficulty: "hard", harness: "codex", model: "hard-c" });
    } finally {
      if (old === undefined) delete process.env.ROUTINES_ROUTING_MATRIX_PATH;
      else process.env.ROUTINES_ROUTING_MATRIX_PATH = old;
    }
  });

  test("explicit pin wins while legacy harness/model remains a migration bridge", () => {
    const pinned = parseEntry(
      'difficulty = "hard"\npin = true\nharness = "grok"\nmodel = "grok-pinned"\nrrule = "FREQ=DAILY"\nprompt = "hi"',
      "/x/smoke-grok.toml",
    );
    expect(pinned.resolvedBy).toBe("pin");
    expect(pinned.routingPin).toBe(true);
    expect(pinned.harness).toBe("grok");
    expect(parseEntry(base, "/x/legacy.toml").resolvedBy).toBe("pin");
  });

  test("difficulty migration removes duplicated harness/model fields", () => {
    expect(() => parseEntry('difficulty = "normal"\n' + base, "/x/mixed.toml")).toThrow(
      /remove harness\/model/,
    );
  });

  test("rejects an incomplete global matrix", () => {
    const dir = mkdtempSync(join(tmpdir(), "routines-bad-matrix-"));
    const matrixPath = join(dir, "routing-matrix.json");
    writeFileSync(matrixPath, JSON.stringify({
      version: 1,
      providerOrder: ["grok", "codex", "claude"],
      matrix: { fast: {}, normal: {}, hard: {} },
    }));
    const old = process.env.ROUTINES_ROUTING_MATRIX_PATH;
    process.env.ROUTINES_ROUTING_MATRIX_PATH = matrixPath;
    try {
      expect(() =>
        parseEntry('difficulty = "fast"\nrrule = "FREQ=DAILY"\nprompt = "hi"', "/x/bad-matrix.toml"),
      ).toThrow(/fast\.claude\.model/);
    } finally {
      if (old === undefined) delete process.env.ROUTINES_ROUTING_MATRIX_PATH;
      else process.env.ROUTINES_ROUTING_MATRIX_PATH = old;
    }
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

  test("accepts the three capacity tiers", () => {
    for (const tier of ["spine", "worker", "opportunistic"] as const) {
      const e = parseEntry(base + `\ntier = "${tier}"`, "/x/disk-reclaim.toml");
      expect(e.tier).toBe(tier);
    }
  });

  test("rejects an invalid capacity tier", () => {
    expect(() => parseEntry(base + '\ntier = "critical"', "/x/disk-reclaim.toml")).toThrow(
      /tier.*spine\|worker\|opportunistic/,
    );
  });

  test("accepts an explicit routine error priority", () => {
    const e = parseEntry(base + '\nerror_priority = "P0"', "/x/disk-reclaim.toml");
    expect(e.errorPriority).toBe("P0");
  });

  test("rejects an invalid routine error priority", () => {
    expect(() =>
      parseEntry(base + '\nerror_priority = "urgent"', "/x/disk-reclaim.toml"),
    ).toThrow(/error_priority.*P0\|P1\|P2\|P3/);
  });

  test("carries optional gate_command", () => {
    const e = parseEntry(
      base + '\ngate_command = "/usr/local/bin/last-stack-kanban-pickup-gate"',
      "/x/disk-reclaim.toml",
    );
    expect(e.gateCommand).toBe("/usr/local/bin/last-stack-kanban-pickup-gate");
  });
});
