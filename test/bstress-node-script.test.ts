import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";

const scriptPath = new URL("../scripts/bstress-node.sh", import.meta.url);
const execFileAsync = promisify(execFile);

async function runScript(statePath: string, ...args: string[]) {
  const { stdout, stderr } = await execFileAsync("bash", [scriptPath.pathname, ...args], {
    env: { ...process.env, BSTRESS_STATE: statePath },
    timeout: 2_000,
  });
  return { stdout, stderr, exitCode: 0 };
}

describe("bstress node helper", () => {
  test("prefers current lastdbd binary names before legacy lastdb_server", async () => {
    const script = await Bun.file(scriptPath).text();

    expect(script).toContain('$FOLD_ROOT/target/release/lastdbd');
    expect(script).toContain('$FOLD_ROOT/target/debug/lastdbd');
    expect(script.indexOf('$FOLD_ROOT/target/release/lastdbd')).toBeLessThan(
      script.indexOf("$DEFAULT_BIN"),
    );
    expect(script.indexOf("$DEFAULT_BIN")).toBeLessThan(
      script.indexOf('$FOLD_ROOT/target/release/lastdb_server'),
    );
  });

  test("launch passes the node home as data-dir so socket matches state", async () => {
    const script = await Bun.file(scriptPath).text();

    expect(script).toContain('SOCK="$HOME_DIR/data/folddb.sock"');
    expect(script).toContain('nohup "$BIN" --data-dir "$HOME_DIR"');
    expect(script).not.toContain('nohup "$BIN" --data-dir "$HOME_DIR/data"');
  });

  test("persists a slug-safe run id when set-run rewrites state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bstress-node-test-"));
    try {
      const state = join(dir, "state.env");
      const result = await runScript(state, "set-run", "bstress-20260714T202701");

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("bstress: run=bstress-20260714T202701");
      expect(result.stdout).toContain("bstress: slug_run_id=20260714t202701");

      const stateText = await Bun.file(state).text();
      expect(stateText).toContain("RUN=bstress-20260714T202701");
      expect(stateText).toContain("SLUG_RUN_ID=20260714t202701");

      const get = await runScript(state, "get-slug-run");
      expect(get.exitCode).toBe(0);
      expect(get.stdout).toBe("20260714t202701\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("set-slug-run sanitizes arbitrary ids for kanban slugs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bstress-node-test-"));
    try {
      const state = join(dir, "state.env");
      const result = await runScript(state, "set-slug-run", "BStress-ABC 123");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("bstress: slug_run_id=abc-123");

      const get = await runScript(state, "get", "SLUG_RUN_ID");
      expect(get.stdout).toBe("abc-123\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("state rewrite includes SLUG_RUN_ID so relaunch cannot drop it", async () => {
    const script = await Bun.file(scriptPath).text();

    expect(script).toContain("printf 'SLUG_RUN_ID=%q\\n' \"${SLUG_RUN_ID:-}\"");
    expect(script).toContain("for k in HOME_DIR SOCK BIN LOG FKCONFIG NODE_PID RUN SLUG_RUN_ID");
  });
});
