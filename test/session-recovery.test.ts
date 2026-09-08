import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "routines-resume-"));
  const cwd = join(root, "work");
  const home = join(root, "state");
  mkdirSync(cwd); mkdirSync(join(home, "registry"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(cwd, "file"), "initial\n"); git("add", "file"); git("commit", "-m", "fixture");
  const bin = join(root, "codex");
  writeFileSync(bin, `#!/bin/sh
cat >/dev/null
printf '%s\\n' "$@" >> "$FIXTURE_ARGS"
printf '%s\\n' '{"type":"thread.started","thread_id":"fixture-session"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"tool-1","type":"command_execution","exit_code":0}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":17,"output_tokens":3}}'
case " $* " in
  *" resume fixture-session "*) printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ROUTINE_RESULT outcome=ok detail=complete"}}'; exit 0 ;;
esac
printf 'partial\\n' > untracked
exit 1
`, { mode: 0o755 });
  const registry = join(home, "registry", "fixture.toml");
  const config = `pin = true\nharness = "codex"\nmodel = "test"\nrrule = "FREQ=DAILY"\nprompt = "fixture"\ncwd = ${JSON.stringify(cwd)}\nsession_mode = "persistent"\nresume_check = "test -f ../safe"\n`;
  writeFileSync(registry, config);
  writeFileSync(join(root, "safe"), "effect check fixture");
  const env = { ...process.env, ROUTINES_HOME: home, ROUTINES_WORKSPACE_ROOT: cwd,
    ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES: "1", ROUTINES_CODEX_BIN: bin, ROUTINES_FALLBACK: "0",
    ROUTINES_HEARTBEATS_FILE: join(root, "heartbeats"), FIXTURE_ARGS: join(root, "args"), OBS_SENTRY_DSN: "" };
  const executable = process.env.ROUTINES_TEST_EXECUTABLE ?? process.execPath;
  const prefix = process.env.ROUTINES_TEST_EXECUTABLE ? [] : [resolve(import.meta.dir, "../src/cli.ts")];
  const run = (prior?: string) => spawnSync(executable, [...prefix, "run", "fixture", "--quiet", ...(prior ? ["--resume-run", prior] : [])],
    { env, cwd, encoding: "utf8", timeout: 30_000 });
  const first = run();
  expect(first.status).toBe(1);
  const previous = join(home, "runs", "fixture", readdirSync(join(home, "runs", "fixture"))[0]!);
  return { root, cwd, home, previous, run, registry, config };
}

test("exact session recovery crosses a process boundary and consumes the prior attempt", () => {
  const f = fixture();
  const record = JSON.parse(readFileSync(join(f.previous, "execution.json"), "utf8"));
  expect(record.sessionId).toBe("fixture-session");
  expect(record.inputTokens).toBe(17);
  expect(record.costUsd).toBeNull();
  const result = f.run(f.previous);
  expect(result.stderr).not.toContain("resume refused");
  expect(result.status).toBe(0);
  expect(readFileSync(join(f.root, "args"), "utf8")).toContain("resume\nfixture-session\n-\n");
  expect(f.run(f.previous).status).not.toBe(0);
});

test("changed untracked bytes with the same porcelain status refuse reuse before spawn", () => {
  const f = fixture();
  const before = readFileSync(join(f.root, "args"), "utf8");
  writeFileSync(join(f.cwd, "untracked"), "different\n");
  const result = f.run(f.previous);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("worktree identity or contents changed");
  expect(readFileSync(join(f.root, "args"), "utf8")).toBe(before);
});

test("a failed effect check and changed provider model refuse reuse", () => {
  const f = fixture();
  writeFileSync(f.registry, f.config.replace('test -f ../safe', 'exit 1'));
  expect(f.run(f.previous).stderr).toContain("effect check failed");
  writeFileSync(f.registry, f.config.replace('model = "test"', 'model = "other"'));
  expect(f.run(f.previous).stderr).toContain("no eligible interrupted session");
  writeFileSync(f.registry, f.config.replace('prompt = "fixture"', 'prompt = "new task"'));
  expect(f.run(f.previous).stderr).toContain("no eligible interrupted session");
});
