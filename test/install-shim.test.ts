import { access, chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";

const execFileAsync = promisify(execFile);
const installShimSrc = new URL("../scripts/install-shim.sh", import.meta.url).pathname;
const buildArtifactSrc = new URL("../scripts/build-artifact.sh", import.meta.url).pathname;

/** Gate files install-shim.sh symlinks into the install bin, and the PATH name each gets. */
const GATES: Array<[file: string, name: string]> = [
  ["north-star-rollup-gate.sh", "routines-north-star-rollup-gate"],
  ["cloud-sync-health-fix-gate.sh", "routines-cloud-sync-health-fix-gate"],
  ["lastdb-local-smoke-gate.sh", "routines-lastdb-local-smoke-gate"],
];

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

describe("install-shim gate symlinks", () => {
  test("resolves gates from dist/probes when the artifact ships no scripts/ gates", async () => {
    // A host-track artifact ships only bin/ and dist/ (.lastgit/artifacts.json),
    // so scripts/*.sh is absent. The gate symlinks must still resolve, or every
    // registry gate_command pointing at them exits 127.
    const dir = await mkdtemp(join(tmpdir(), "routines-install-shim-probes-"));
    const tree = join(dir, "tree");
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    try {
      await mkdir(bin, { recursive: true });
      await mkdir(home, { recursive: true });
      await makeCompiledTree(tree);
      await mkdir(join(tree, "dist", "probes"), { recursive: true });
      for (const [file] of GATES) {
        await writeFile(join(tree, "dist", "probes", file), "#!/bin/sh\nexit 0\n", {
          mode: 0o644,
        });
      }

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

      for (const [file, name] of GATES) {
        const link = join(bin, name);
        expect(await readlink(link)).toBe(join(tree, "dist", "probes", file));
        // Resolves (not a dangling symlink) and is executable.
        await access(link, fsConstants.X_OK);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prefers scripts/ over dist/probes in a source checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "routines-install-shim-prefer-"));
    const tree = join(dir, "tree");
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    try {
      await mkdir(bin, { recursive: true });
      await mkdir(home, { recursive: true });
      await makeCompiledTree(tree);
      await mkdir(join(tree, "dist", "probes"), { recursive: true });
      for (const [file] of GATES) {
        await writeFile(join(tree, "scripts", file), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await writeFile(join(tree, "dist", "probes", file), "#!/bin/sh\nexit 0\n", {
          mode: 0o755,
        });
      }

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

      for (const [file, name] of GATES) {
        expect(await readlink(join(bin, name))).toBe(join(tree, "scripts", file));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("build-artifact.sh copies every gate install-shim.sh can link", async () => {
    // Drift guard: a gate added to install-shim.sh but not to the artifact
    // probe list would silently break only on host-track installs.
    const build = await readFile(buildArtifactSrc, "utf8");
    const shim = await readFile(installShimSrc, "utf8");
    for (const [file, name] of GATES) {
      expect(shim).toContain(`link_gate ${file} ${name}`);
      expect(build).toContain(file);
    }
  });
});
