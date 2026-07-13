#!/usr/bin/env bun
// routines — unified scheduler + dispatcher for agent routines.
//
// One scheduler owns dispatch; each routine's on-disk config declares its
// harness (claude|codex) and model. See fbrain design-routines-orchestrator.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import pkg from "../package.json" with { type: "json" };
import { routeRoutine, setStatus, ActionError } from "./actions.ts";
import { evaluateOnce, startDaemon } from "./daemon.ts";
import { installDaemon, plistPath, renderPlist, uninstallDaemon } from "./launchd.ts";
import { loadActiveSituations } from "./situations.ts";
import { loadAll, loadEntry, resolvePrompt, type RoutineEntry } from "./registry.ts";
import { collectStatus } from "./status.ts";
import { registryDir, routinesHome, runsDir } from "./paths.ts";
import { runRoutine } from "./runner.ts";
import { startServer } from "./server.ts";

const HELP = `routines ${pkg.version} — one scheduler for agent routines (claude|codex)

Usage:
  routines <command> [options]

Commands:
  list                        list registered routines (--json)
  status                      last run / next fire / harness / model per routine (--json)
  run <id>                    run a routine now (foreground); --quiet to suppress streaming
  pause <id>                  set status = paused
  resume <id>                 set status = active
  route <id> --harness X --model Y   change a routine's harness and/or model
  logs <id>                   show recent runs for a routine (--json, --path, --tail)
  web                         serve the local dashboard (localhost); --port, --host
  doctor                      validate the registry + environment
  daemon                      run the scheduler loop (launchd entrypoint); --once, --catchup <s>
  install-daemon              install + load the launchd user agent
  uninstall-daemon            unload + remove the launchd user agent
  print-plist                 print the launchd plist that install-daemon would write
  version                     print version
  help                        print this help

Environment:
  ROUTINES_HOME               state root (default ~/.routines)
  ROUTINES_CLAUDE_BIN         claude binary (default: claude)
  ROUTINES_CODEX_BIN          codex binary (default: codex)
  ROUTINES_FSITUATIONS_BIN    fsituations binary (default: fsituations)
  ROUTINES_FBRAIN_BIN         fbrain binary for heartbeats (default: fbrain)`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return 0;
    case "version":
    case "-v":
    case "--version":
      console.log(pkg.version);
      return 0;
    case "list":
      return cmdList(rest);
    case "status":
      return cmdStatus(rest);
    case "run":
      return cmdRun(rest);
    case "pause":
      return cmdSetStatus(rest, "paused");
    case "resume":
      return cmdSetStatus(rest, "active");
    case "route":
      return cmdRoute(rest);
    case "logs":
      return cmdLogs(rest);
    case "web":
      return cmdWeb(rest);
    case "doctor":
      return cmdDoctor();
    case "daemon":
      return cmdDaemon(rest);
    case "install-daemon":
      return cmdInstallDaemon();
    case "uninstall-daemon":
      return cmdUninstallDaemon();
    case "print-plist":
      return cmdPrintPlist();
    default:
      console.error(`unknown command: ${command}\n`);
      console.error(HELP);
      return 2;
  }
}

function cmdList(rest: string[]): number {
  const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } }, allowPositionals: true });
  const { entries, errors } = loadAll();
  if (values.json) {
    console.log(JSON.stringify({ entries: entries.map(summarize), errors: errors.map((e) => e.message) }, null, 2));
    return errors.length > 0 ? 1 : 0;
  }
  if (entries.length === 0) console.log(`(no routines in ${registryDir()})`);
  for (const e of entries) {
    console.log(`${e.id}\t${e.status}\t${e.harness}/${e.model}\t${e.rrule}`);
  }
  for (const err of errors) console.error(`ERROR ${err.message}`);
  return errors.length > 0 ? 1 : 0;
}

function cmdStatus(rest: string[]): number {
  const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } }, allowPositionals: true });
  const snap = collectStatus();
  if (values.json) {
    // Preserve the historical CLI JSON shape (situationsOk + rows + errors); the
    // web API serves the fuller collectStatus() snapshot.
    console.log(JSON.stringify({ situationsOk: snap.situationsOk, rows: snap.rows, errors: snap.errors }, null, 2));
    return 0;
  }
  console.log(`routines @ ${snap.home}  (situations: ${snap.situationsOk ? "ok" : "DEGRADED"})`);
  for (const r of snap.rows) {
    const flags = [r.running ? "RUNNING" : "", r.fenced ? `FENCED:${r.fenced}` : ""].filter(Boolean).join(" ");
    console.log(
      `${r.id}  [${r.status}] ${r.harness}/${r.model}\n` +
        `    next: ${r.nextFire ?? "-"}  last: ${r.lastRun ?? "-"} (exit ${r.lastExit ?? "-"}) ${flags}`,
    );
  }
  for (const err of snap.errors) console.error(`ERROR ${err}`);
  return 0;
}

async function cmdRun(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { quiet: { type: "boolean" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) {
    console.error("usage: routines run <id> [--quiet]");
    return 2;
  }
  const entry = loadEntry(id);
  const result = await runRoutine(entry, { quiet: values.quiet === true });
  console.error(
    `run ${id}: exit=${result.exitCode} dur=${(result.durationMs / 1000).toFixed(1)}s log=${result.runDir}` +
      (result.heartbeat.attempted ? ` heartbeat=${result.heartbeat.ok ? "ok" : "FAILED"}` : ""),
  );
  return result.exitCode === 0 ? 0 : 1;
}

function cmdSetStatus(rest: string[], status: "active" | "paused"): number {
  const id = rest[0];
  if (!id) {
    console.error(`usage: routines ${status === "paused" ? "pause" : "resume"} <id>`);
    return 2;
  }
  const entry = loadEntry(id); // validates existence + shape
  setStatus(entry, status);
  console.log(`${id}: status = ${status}`);
  return 0;
}

function cmdRoute(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { harness: { type: "string" }, model: { type: "string" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id || (!values.harness && !values.model)) {
    console.error("usage: routines route <id> [--harness claude|codex] [--model <model>]");
    return 2;
  }
  const entry = loadEntry(id);
  try {
    const next = routeRoutine(entry, { harness: values.harness, model: values.model });
    console.log(`${id}: ${next.harness}/${next.model}`);
    return 0;
  } catch (err) {
    if (err instanceof ActionError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
}

function cmdLogs(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { json: { type: "boolean" }, path: { type: "boolean" }, tail: { type: "boolean" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) {
    console.error("usage: routines logs <id> [--json|--path|--tail]");
    return 2;
  }
  const dir = join(runsDir(), id);
  if (!existsSync(dir)) {
    console.error(`no runs for ${id} (${dir})`);
    return 1;
  }
  const stamps = readdirSync(dir).sort();
  if (stamps.length === 0) {
    console.error(`no runs for ${id}`);
    return 1;
  }
  const latest = stamps[stamps.length - 1]!;
  const latestDir = join(dir, latest);
  if (values.path) {
    console.log(latestDir);
    return 0;
  }
  const metaPath = join(latestDir, "meta.json");
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
  if (values.json) {
    console.log(JSON.stringify({ id, runs: stamps, latest: latestDir, meta }, null, 2));
    return 0;
  }
  if (values.tail) {
    const out = join(latestDir, "stdout.log");
    if (existsSync(out)) process.stdout.write(readFileSync(out, "utf8"));
    return 0;
  }
  console.log(`${id}: ${stamps.length} run(s), latest ${latest}`);
  console.log(`  dir:  ${latestDir}`);
  console.log(`  cmd:  ${meta.command ?? "-"}`);
  console.log(`  exit: ${meta.exitCode ?? "-"}  dur: ${meta.durationMs ? (meta.durationMs / 1000).toFixed(1) + "s" : "-"}`);
  return 0;
}

async function cmdWeb(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { port: { type: "string" }, host: { type: "string" } },
    allowPositionals: true,
  });
  const port = values.port ? Number(values.port) : Number(process.env.ROUTINES_WEB_PORT ?? 4778);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    console.error(`invalid port: ${values.port}`);
    return 2;
  }
  const host = values.host ?? "127.0.0.1";
  const handle = startServer({ port, host });
  console.error(`routines dashboard: ${handle.url}  (home=${routinesHome()})`);
  console.error(`serving the registry at ${registryDir()} — localhost only, no auth. Ctrl-C to stop.`);
  const stop = () => {
    handle.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Hold the process open until signalled.
  await new Promise<void>(() => {});
  return 0;
}

function cmdDoctor(): number {
  let problems = 0;
  console.log(`routines ${pkg.version}  home=${routinesHome()}`);
  console.log(`registry=${registryDir()} ${existsSync(registryDir()) ? "" : "(missing — no routines yet)"}`);

  const { entries, errors } = loadAll();
  console.log(`\n${entries.length} routine(s), ${errors.length} error(s)`);
  for (const err of errors) {
    problems++;
    console.log(`  BAD  ${err.message}`);
  }
  for (const e of entries) {
    const issues: string[] = [];
    if (e.promptPath && !existsSync(e.promptPath)) issues.push(`prompt_path missing: ${e.promptPath}`);
    if (!existsSync(e.cwd)) issues.push(`cwd missing: ${e.cwd}`);
    if (issues.length > 0) {
      problems += issues.length;
      console.log(`  WARN ${e.id}: ${issues.join("; ")}`);
    } else {
      console.log(`  ok   ${e.id} (${e.harness}/${e.model}, ${e.rrule})`);
    }
  }

  const check = loadActiveSituations();
  console.log(`\nSituation fence: ${check.ok ? `ok (${check.situations.length} active)` : `DEGRADED — ${check.error}`}`);
  if (!check.ok) problems++;

  console.log(`\nlaunchd: plist ${existsSync(plistPath()) ? "installed" : "not installed"} (${plistPath()})`);
  console.log(problems === 0 ? "\nAll good." : `\n${problems} problem(s) found.`);
  return problems === 0 ? 0 : 1;
}

async function cmdDaemon(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      once: { type: "boolean" },
      catchup: { type: "string" },
      "tick-ms": { type: "string" },
      concurrency: { type: "string" },
    },
    allowPositionals: true,
  });
  const catchupMs = values.catchup ? Number(values.catchup) * 1000 : 0;
  const concurrency = values.concurrency ? Number(values.concurrency) : 4;

  if (values.once) {
    const results = await evaluateOnce({ once: true, catchupMs, concurrency });
    console.error(`daemon --once: dispatched ${results.length} run(s)`);
    return 0;
  }

  const tickMs = values["tick-ms"] ? Number(values["tick-ms"]) : 15_000;
  const handle = startDaemon({ tickMs, concurrency, catchupMs });
  const stop = () => handle.stop();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.error(`routinesd started (tick=${tickMs}ms concurrency=${concurrency} home=${routinesHome()})`);
  await handle.done;
  return 0;
}

function selfProgram(): string {
  // The CLI entrypoint path (this file, or the shim that runs it).
  return process.argv[1] ?? join(import.meta.dir ?? ".", "cli.ts");
}

function cmdInstallDaemon(): number {
  const env: Record<string, string> = {};
  if (process.env.LASTGIT_SOCKET) env.LASTGIT_SOCKET = process.env.LASTGIT_SOCKET;
  const res = installDaemon({ program: selfProgram(), env });
  console.log(`plist: ${res.plistPath}`);
  console.log(res.message);
  return res.loaded ? 0 : 1;
}

function cmdUninstallDaemon(): number {
  const res = uninstallDaemon();
  console.log(res.message);
  return 0;
}

function cmdPrintPlist(): number {
  console.log(renderPlist({ program: selfProgram() }));
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

// Exported for tests / embedding.
export { main, summarize };

function summarize(e: RoutineEntry) {
  return {
    id: e.id,
    harness: e.harness,
    model: e.model,
    effort: e.effort ?? null,
    rrule: e.rrule,
    cwd: e.cwd,
    status: e.status,
    timeoutMin: e.timeoutMin,
    heartbeatSlug: e.heartbeatSlug ?? null,
    hasPrompt: e.prompt !== undefined,
    promptPath: e.promptPath ?? null,
    resolvedPromptChars: (() => {
      try {
        return resolvePrompt(e).length;
      } catch {
        return null;
      }
    })(),
  };
}
