import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateKanbanIds } from "../src/kanban-id-migration.ts";
import { loadAll } from "../src/registry.ts";

const savedHome = process.env.ROUTINES_HOME;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "routines-kanban-migrate-"));
}

afterEach(() => {
  if (savedHome === undefined) delete process.env.ROUTINES_HOME;
  else process.env.ROUTINES_HOME = savedHome;
});

describe("migrateKanbanIds", () => {
  test("renames old fkanban registry/state/memory paths to canonical kanban ids", () => {
    const home = tmp();
    process.env.ROUTINES_HOME = home;
    for (const dir of ["registry", "state", "memory", "runs", "locks"]) {
      mkdirSync(join(home, dir), { recursive: true });
    }

    writeFileSync(
      join(home, "registry", "last-stack-fkanban-pickup.toml"),
      [
        'id = "last-stack-fkanban-pickup"',
        'harness = "codex"',
        'model = "gpt-5"',
        'rrule = "FREQ=HOURLY"',
        'prompt = "run pickup"',
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(home, "state", "last-stack-fkanban-pickup.json"),
      JSON.stringify({ id: "last-stack-fkanban-pickup", lastFire: "2026-07-14T01:00:00Z" }) + "\n",
    );
    mkdirSync(join(home, "memory", "last-stack-fkanban-pickup"));
    writeFileSync(join(home, "memory", "last-stack-fkanban-pickup", "memory.md"), "checkpoint\n");
    mkdirSync(join(home, "runs", "last-stack-fkanban-pickup", "20260714T010000Z"), { recursive: true });
    writeFileSync(join(home, "locks", "last-stack-fkanban-pickup.lock"), "123\n");

    const dry = migrateKanbanIds({ home });
    expect(dry.actions.length).toBe(5);
    expect(existsSync(join(home, "registry", "last-stack-fkanban-pickup.toml"))).toBe(true);

    const result = migrateKanbanIds({ home, write: true });
    expect(result.actions.map((a) => a.kind)).toEqual(["move", "move", "move", "move", "move"]);

    expect(existsSync(join(home, "registry", "last-stack-fkanban-pickup.toml"))).toBe(false);
    expect(readFileSync(join(home, "registry", "last-stack-kanban-pickup.toml"), "utf8")).toContain(
      'id = "last-stack-kanban-pickup"',
    );
    expect(readFileSync(join(home, "state", "last-stack-kanban-pickup.json"), "utf8")).toContain(
      '"id": "last-stack-kanban-pickup"',
    );
    expect(readFileSync(join(home, "memory", "last-stack-kanban-pickup", "memory.md"), "utf8")).toBe("checkpoint\n");
    expect(existsSync(join(home, "runs", "last-stack-kanban-pickup", "20260714T010000Z"))).toBe(true);
    expect(existsSync(join(home, "locks", "last-stack-kanban-pickup.lock"))).toBe(true);

    const { entries, errors } = loadAll();
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.id)).toEqual(["last-stack-kanban-pickup"]);
  });

  test("archives duplicate old registry files and merges state without losing the latest checkpoint", () => {
    const home = tmp();
    for (const dir of ["registry", "state"]) mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, "registry", "last-stack-kanban-watch.toml"), "new\n");
    writeFileSync(join(home, "registry", "last-stack-fkanban-watch.toml"), "old\n");
    writeFileSync(
      join(home, "state", "last-stack-kanban-watch.json"),
      JSON.stringify({ id: "last-stack-kanban-watch", lastFire: "2026-07-14T01:00:00Z" }) + "\n",
    );
    writeFileSync(
      join(home, "state", "last-stack-fkanban-watch.json"),
      JSON.stringify({ id: "last-stack-fkanban-watch", lastFire: "2026-07-14T02:00:00Z", lastOutcome: "ok" }) + "\n",
    );

    migrateKanbanIds({ home, write: true });

    expect(readdirSync(join(home, "registry")).some((f) => f.startsWith("last-stack-fkanban-watch.toml.migrated-"))).toBe(
      true,
    );
    const merged = JSON.parse(readFileSync(join(home, "state", "last-stack-kanban-watch.json"), "utf8"));
    expect(merged.id).toBe("last-stack-kanban-watch");
    expect(merged.lastFire).toBe("2026-07-14T02:00:00Z");
    expect(merged.lastOutcome).toBe("ok");
  });
});
