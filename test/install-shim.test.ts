import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";

const execFileAsync = promisify(execFile);
const installShimSrc = new URL("../scripts/install-shim.sh", import.meta.url).pathname;

async function makeCompiledTree(root: string) {
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  const shimText = await readFile(installShimSrc, "utf8");
  await writeFile(join(root, "scripts", "install-shim.sh"), shimText, { mode: 0o755 });
  const recorder = `#!/bin/sh
if [ -n "\${ROUTINES_ARGV_FILE:-}" ]; then
  printf '%s\\n' "\$@" > "\$ROUTINES_ARGV_FILE"
fi
exit 0
`;
  await writeFile(join(root, "dist", "routines"), recorder, { mode: 0o755 });
  await chmod(join(root, "dist", "routines"), 0o755);
}

describe("install-shim compiled host-track current", () => {
  test("installs without src/cli.ts and run-web.sh execs the compiled shim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "routines-install-shim-"));
    const tree = join(dir, "tree");
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    const argvFile = join(dir, "argv.txt");
    try {
      await mkdir(bin, { recursive: true });
      await mkdir(home, { recursive: true });
      await makeCompiledTree(tree);

      const { stdout, stderr } = await execFileAsync(
        "sh",
        [join(tree, "scripts", "install-shim.sh")],
        {
          env: {
            ...process.env,
            HOME: dir,
            ROUTINES_HOME: home,
            ROUTINES_INSTALL_BIN: bin,
            ROUTINES_SKIP_LAUNCHD_RELOAD: "1",
          },
          timeout: 10_000,
        },
      );
      expect(stderr).toBe("");
      expect(stdout).toContain("Installed routines shim");

      const runWeb = await readFile(join(home, "daemon", "run-web.sh"), "utf8");
      expect(runWeb).not.toContain("src/cli.ts");
      expect(runWeb).not.toMatch(/bun .*src\/cli\.ts/);
      expect(runWeb).toContain('exec_routines web --port "$PORT" --host "$HOST"');

      const runDaemon = await readFile(join(home, "daemon", "run-daemon.sh"), "utf8");
      expect(runDaemon).not.toContain("src/cli.ts");
      const runHygiene = await readFile(join(home, "daemon", "run-hygiene.sh"), "utf8");
      expect(runHygiene).not.toContain("src/cli.ts");

      await execFileAsync("bash", [join(home, "daemon", "run-web.sh")], {
        env: {
          ...process.env,
          HOME: dir,
          USER: "test",
          ROUTINES_HOME: home,
          ROUTINES_ARGV_FILE: argvFile,
          ROUTINES_WEB_PORT: "4778",
          ROUTINES_WEB_HOST: "127.0.0.1",
        },
        timeout: 10_000,
      });
      const argv = (await readFile(argvFile, "utf8")).trim();
      expect(argv).toBe("web\n--port\n4778\n--host\n127.0.0.1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("source checkout still generates a bun src/cli.ts fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "routines-install-shim-src-"));
    const tree = join(dir, "tree");
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    try {
      await mkdir(join(tree, "scripts"), { recursive: true });
      await mkdir(join(tree, "bin"), { recursive: true });
      await mkdir(join(tree, "src"), { recursive: true });
      await mkdir(bin, { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(
        join(tree, "scripts", "install-shim.sh"),
        await readFile(installShimSrc, "utf8"),
        { mode: 0o755 },
      );
      await writeFile(join(tree, "src", "cli.ts"), "// stub\n", { mode: 0o644 });
      await writeFile(
        join(tree, "bin", "routines"),
        "#!/bin/sh\necho source-shim\n",
        { mode: 0o755 },
      );
      await chmod(join(tree, "bin", "routines"), 0o755);

      await execFileAsync("sh", [join(tree, "scripts", "install-shim.sh")], {
        env: {
          ...process.env,
          HOME: dir,
          ROUTINES_HOME: home,
          ROUTINES_INSTALL_BIN: bin,
          ROUTINES_SKIP_LAUNCHD_RELOAD: "1",
        },
        timeout: 10_000,
      });
      const runWeb = await readFile(join(home, "daemon", "run-web.sh"), "utf8");
      expect(runWeb).toContain('$root/src/cli.ts');
      expect(runWeb).not.toContain(join(tree, "src", "cli.ts"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
