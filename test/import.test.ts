import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cronToRRule,
  normalizeRRule,
  normName,
  parseCodexAutomation,
  preserveExistingRouting,
  readCodexAutomations,
  readClaudeTasks,
  planImport,
  renderToml,
  planFiles,
  renderDiffTable,
} from "../src/import.ts";
import { parseEntry } from "../src/registry.ts";
import { parseRRule, nextAfter } from "../src/rrule.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "routines-import-"));
}

describe("cronToRRule", () => {
  test("daily at a fixed time", () => {
    expect(cronToRRule("40 2 * * *")).toBe("FREQ=DAILY;BYHOUR=2;BYMINUTE=40;BYSECOND=0");
  });
  test("every hour on the hour", () => {
    expect(cronToRRule("0 * * * *")).toBe("FREQ=HOURLY;BYMINUTE=0;BYSECOND=0");
  });
  test("step hours expand to an explicit BYHOUR list", () => {
    expect(cronToRRule("0 */4 * * *")).toBe("FREQ=DAILY;BYHOUR=0,4,8,12,16,20;BYMINUTE=0;BYSECOND=0");
    expect(cronToRRule("11 */2 * * *")).toBe(
      "FREQ=DAILY;BYHOUR=0,2,4,6,8,10,12,14,16,18,20,22;BYMINUTE=11;BYSECOND=0",
    );
  });
  test("comma hour list", () => {
    expect(cronToRRule("17 1,13 * * *")).toBe("FREQ=DAILY;BYHOUR=1,13;BYMINUTE=17;BYSECOND=0");
  });
  test("weekly by day-of-week", () => {
    expect(cronToRRule("0 11 * * 0")).toBe("FREQ=WEEKLY;BYDAY=SU;BYHOUR=11;BYMINUTE=0;BYSECOND=0");
  });
  test("every output is a parseable rrule", () => {
    for (const c of ["40 2 * * *", "0 * * * *", "0 */4 * * *", "17 1,13 * * *", "0 11 * * 0", "0 * * * 1-5"]) {
      expect(() => parseRRule(cronToRRule(c))).not.toThrow();
    }
  });
  test("rejects unsupported day-of-month / month", () => {
    expect(() => cronToRRule("0 0 1 * *")).toThrow(/day-of-month/);
    expect(() => cronToRRule("0 0 * 6 *")).toThrow(/month/);
  });
  test("rejects wrong field count", () => {
    expect(() => cronToRRule("0 0 * *")).toThrow(/5 fields/);
  });
  test("converted schedule fires at the expected wall-clock", () => {
    const r = parseRRule(cronToRRule("40 2 * * *"));
    const next = nextAfter(r, new Date(2026, 6, 12, 1, 0, 0));
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(2);
    expect(next!.getMinutes()).toBe(40);
  });
});

describe("normalizeRRule", () => {
  test("strips a stray RRULE: prefix", () => {
    expect(normalizeRRule("RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=0")).toBe("FREQ=HOURLY;INTERVAL=1;BYMINUTE=0");
  });
  test("leaves a bare rrule untouched", () => {
    expect(normalizeRRule("FREQ=DAILY")).toBe("FREQ=DAILY");
  });
});

describe("normName", () => {
  test("collapses last-stack- / daily- prefixes", () => {
    expect(normName("last-stack-program-driver")).toBe(normName("program-driver"));
    expect(normName("daily-self-improvement-loop")).toBe(normName("last-stack-self-improvement-loop"));
  });
  test("curated synonyms collapse the non-obvious pairs", () => {
    expect(normName("consolidate-fbrain")).toBe(normName("last-stack-consolidate-brain"));
    expect(normName("last-stack-fkanban-pickup")).toBe(normName("last-stack-kanban-pickup"));
    expect(normName("groom-fkanban-board")).toBe(normName("last-stack-groom-board"));
    expect(normName("daily-agent-papercut-sweep")).toBe(normName("last-stack-papercut-sweep"));
    expect(normName("clean-up-stale-worktrees")).toBe(normName("last-stack-worktree-cleanup"));
  });
  test("distinct routines stay distinct", () => {
    expect(normName("sentry-triage")).not.toBe(normName("db-perf-guard"));
  });
});

const CODEX_FIXTURE = `version = 1
id = "last-stack-program-driver"
kind = "cron"
name = "last-stack program-driver"
prompt = "Run the routine with a \\"quoted\\" word and a path C:\\\\x. Read foo.md."
status = "ACTIVE"
rrule = "FREQ=HOURLY;INTERVAL=1"
model = "gpt-5.5"
reasoning_effort = "medium"
execution_environment = "local"
target = { type = "project", project_id = "/Users/tomtang/code/edgevector" }
cwds = ["/Users/tomtang/code/edgevector"]
created_at = 1782353733453
`;

describe("parseCodexAutomation", () => {
  test("extracts scalars past arrays + inline tables", () => {
    const a = parseCodexAutomation(CODEX_FIXTURE, "/x/automation.toml")!;
    expect(a.id).toBe("last-stack-program-driver");
    expect(a.status).toBe("ACTIVE");
    expect(a.rrule).toBe("FREQ=HOURLY;INTERVAL=1");
    expect(a.model).toBe("gpt-5.5");
    expect(a.effort).toBe("medium");
    expect(a.cwd).toBe("/Users/tomtang/code/edgevector");
    expect(a.prompt).toContain('"quoted"');
    expect(a.prompt).toContain("C:\\x");
  });
  test("strips an RRULE: prefix from codex rrule", () => {
    const src = CODEX_FIXTURE.replace(
      'rrule = "FREQ=HOURLY;INTERVAL=1"',
      'rrule = "RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=0;BYDAY=MO"',
    );
    expect(parseCodexAutomation(src, "/x/a.toml")!.rrule).toBe("FREQ=HOURLY;INTERVAL=1;BYMINUTE=0;BYDAY=MO");
  });
  test("readCodexAutomations skips PAUSED", () => {
    const dir = tmp();
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "a", "automation.toml"), CODEX_FIXTURE);
    writeFileSync(join(dir, "b", "automation.toml"), CODEX_FIXTURE.replace('status = "ACTIVE"', 'status = "PAUSED"').replace('id = "last-stack-program-driver"', 'id = "paused-one"'));
    const { active, skipped } = readCodexAutomations(dir);
    expect(active.map((a) => a.id)).toEqual(["last-stack-program-driver"]);
    expect(skipped.some((s) => s.reason.includes("PAUSED"))).toBe(true);
  });
});

function writeClaudeRegistry(dir: string): string {
  const reg = join(dir, "scheduled-tasks.json");
  writeFileSync(
    reg,
    JSON.stringify({
      scheduledTasks: [
        { id: "sentry-triage", enabled: true, cronExpression: "25 8 * * *", cwd: "/w", filePath: "/skills/sentry-triage/SKILL.md" },
        { id: "old-thing", enabled: false, cronExpression: "0 0 * * *", cwd: "/w", filePath: "/x.md" },
        { id: "labs-filing", enabled: true, fireAt: 1784160000000, cwd: "/w", filePath: "/y.md" },
        { id: "program-driver", enabled: true, cronExpression: "5 */2 * * *", cwd: "/w", filePath: "/pd.md" },
      ],
    }),
  );
  return reg;
}

describe("readClaudeTasks", () => {
  test("keeps enabled cron tasks; skips disabled + one-shot", () => {
    const reg = writeClaudeRegistry(tmp());
    const { candidates, skipped } = readClaudeTasks(reg, "sonnet");
    expect(candidates.map((c) => c.id).sort()).toEqual(["program-driver", "sentry-triage"]);
    expect(candidates[0]!.promptPath).toBeDefined();
    expect(candidates[0]!.harness).toBe("claude");
    expect(candidates[0]!.model).toBe("sonnet");
    expect(skipped.find((s) => s.id === "old-thing")!.reason).toBe("disabled");
    expect(skipped.find((s) => s.id === "labs-filing")!.reason).toContain("one-shot");
  });
});

describe("planImport (fixtures)", () => {
  function fixtureDirs() {
    const codexDir = tmp();
    for (const [id, status] of [
      ["last-stack-program-driver", "ACTIVE"],
      ["last-stack-disk-reclaim", "ACTIVE"],
      ["last-stack-program-rollup", "PAUSED"],
    ] as const) {
      mkdirSync(join(codexDir, id));
      writeFileSync(
        join(codexDir, id, "automation.toml"),
        CODEX_FIXTURE.replace('id = "last-stack-program-driver"', `id = "${id}"`).replace('status = "ACTIVE"', `status = "${status}"`),
      );
    }
    const claudeReg = writeClaudeRegistry(tmp());
    return { codexDir, claudeReg };
  }

  test("codex ACTIVE + claude enabled imported; PAUSED/disabled skipped", () => {
    const { codexDir, claudeReg } = fixtureDirs();
    const plan = planImport({ codexDir, claudeRegistry: claudeReg });
    const created = plan.candidates.filter((c) => c.action === "create").map((c) => c.id).sort();
    // program-driver is a cross-scheduler duplicate -> claude copy dropped, codex kept.
    expect(created).toContain("last-stack-program-driver");
    expect(created).toContain("last-stack-disk-reclaim");
    expect(created).toContain("sentry-triage");
    expect(created).not.toContain("program-driver"); // dropped duplicate
    expect(created).not.toContain("last-stack-program-rollup"); // paused
  });

  test("cross-scheduler duplicate detected with codex precedence", () => {
    const { codexDir, claudeReg } = fixtureDirs();
    const plan = planImport({ codexDir, claudeRegistry: claudeReg, prefer: "codex" });
    const dup = plan.duplicates.find((d) => d.normName === "program-driver");
    expect(dup).toBeDefined();
    expect(dup!.kept).toEqual({ id: "last-stack-program-driver", source: "codex" });
    expect(dup!.dropped).toEqual([{ id: "program-driver", source: "claude" }]);
  });

  test("--keep-duplicates imports both", () => {
    const { codexDir, claudeReg } = fixtureDirs();
    const plan = planImport({ codexDir, claudeRegistry: claudeReg, keepDuplicates: true });
    const created = plan.candidates.filter((c) => c.action === "create").map((c) => c.id);
    expect(created).toContain("program-driver");
    expect(created).toContain("last-stack-program-driver");
    expect(plan.duplicates).toHaveLength(0);
  });

  test("prefer claude flips precedence", () => {
    const { codexDir, claudeReg } = fixtureDirs();
    const plan = planImport({ codexDir, claudeRegistry: claudeReg, prefer: "claude" });
    const dup = plan.duplicates.find((d) => d.normName === "program-driver");
    expect(dup!.kept.source).toBe("claude");
  });

  test("no claude registry still works", () => {
    const { codexDir } = fixtureDirs();
    const plan = planImport({ codexDir, claudeRegistry: null });
    expect(plan.candidates.every((c) => c.source === "codex")).toBe(true);
  });

  test("canonicalizes fkanban registry ids but preserves legacy source ids for pause targets", () => {
    const codexDir = tmp();
    mkdirSync(join(codexDir, "last-stack-fkanban-pickup"));
    writeFileSync(
      join(codexDir, "last-stack-fkanban-pickup", "automation.toml"),
      CODEX_FIXTURE.replace('id = "last-stack-program-driver"', 'id = "last-stack-fkanban-pickup"'),
    );
    const plan = planImport({ codexDir, claudeRegistry: null });
    expect(plan.candidates.map((c) => c.id)).toEqual(["last-stack-kanban-pickup"]);
    expect(plan.candidates[0]!.sourceId).toBe("last-stack-fkanban-pickup");
    const [file] = planFiles(plan);
    expect(file!.file).toBe("last-stack-kanban-pickup.toml");
    expect(parseEntry(file!.body, `/reg/${file!.file}`).id).toBe("last-stack-kanban-pickup");
  });
});

describe("renderToml round-trips through the real registry parser", () => {
  test("every generated file parses back (codex inline + claude prompt_path)", () => {
    const codexDir = tmp();
    mkdirSync(join(codexDir, "last-stack-program-driver"));
    writeFileSync(join(codexDir, "last-stack-program-driver", "automation.toml"), CODEX_FIXTURE);
    const claudeReg = writeClaudeRegistry(tmp());
    const plan = planImport({ codexDir, claudeRegistry: claudeReg });

    const files = planFiles(plan);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const e = parseEntry(f.body, `/reg/${f.file}`);
      expect(e.id).toBe(f.file.replace(/\.toml$/, ""));
      // rrule the daemon will schedule on must itself be valid.
      expect(() => parseRRule(e.rrule)).not.toThrow();
    }
  });

  test("inline prompt with quotes, backslashes, and newlines survives the round-trip", () => {
    const codexDir = tmp();
    const tricky = CODEX_FIXTURE.replace(
      'prompt = "Run the routine with a \\"quoted\\" word and a path C:\\\\x. Read foo.md."',
      'prompt = "line one\\nline \\"two\\" with C:\\\\path and a # hash"',
    );
    mkdirSync(join(codexDir, "last-stack-program-driver"));
    writeFileSync(join(codexDir, "last-stack-program-driver", "automation.toml"), tricky);
    const plan = planImport({ codexDir, claudeRegistry: null });
    const [file] = planFiles(plan);
    const e = parseEntry(file!.body, `/reg/${file!.file}`);
    expect(e.prompt).toBe('line one\nline "two" with C:\\path and a # hash');
  });

  test("force refresh can preserve an existing local route", () => {
    const reg = writeClaudeRegistry(tmp());
    const plan = planImport({ codexDir: tmp(), claudeRegistry: reg });
    const imported = plan.candidates.find((c) => c.id === "sentry-triage")!;
    const existing = renderToml({
      ...imported,
      harness: "codex",
      model: "gpt-5.5",
      effort: "medium",
    });

    const preserved = preserveExistingRouting(imported, existing, "/reg/sentry-triage.toml");
    const e = parseEntry(renderToml(preserved), "/reg/sentry-triage.toml");

    expect(e.harness).toBe("codex");
    expect(e.model).toBe("gpt-5.5");
    expect(e.effort).toBe("medium");
    expect(renderToml(preserved)).toContain("preserved local route codex/gpt-5.5");
  });
});

describe("renderDiffTable", () => {
  test("shows create + duplicate + skipped sections", () => {
    const codexDir = tmp();
    mkdirSync(join(codexDir, "last-stack-program-driver"));
    writeFileSync(join(codexDir, "last-stack-program-driver", "automation.toml"), CODEX_FIXTURE);
    const claudeReg = writeClaudeRegistry(tmp());
    const table = renderDiffTable(planImport({ codexDir, claudeRegistry: claudeReg }));
    expect(table).toContain("WILL CREATE");
    expect(table).toContain("CROSS-SCHEDULER DUPLICATES");
    expect(table).toContain("SKIPPED");
  });
});
