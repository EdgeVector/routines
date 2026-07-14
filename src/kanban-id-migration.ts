import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { locksDir, registryDir, routinesHome, runsDir, stateDir } from "./paths.ts";

export const KANBAN_ID_RENAMES = [
  { old: "last-stack-fkanban-pickup", next: "last-stack-kanban-pickup" },
  { old: "last-stack-fkanban-watch", next: "last-stack-kanban-watch" },
  { old: "last-stack-fkanban-validate", next: "last-stack-kanban-validate" },
] as const;

const OLD_TO_NEW: ReadonlyMap<string, string> = new Map(KANBAN_ID_RENAMES.map((r) => [r.old, r.next]));

export function canonicalRoutineId(id: string): string {
  return OLD_TO_NEW.get(id) ?? id;
}

export interface KanbanIdMigrationAction {
  kind: "move" | "merge" | "archive" | "skip";
  path: string;
  dest?: string;
  reason?: string;
}

export interface KanbanIdMigrationResult {
  write: boolean;
  actions: KanbanIdMigrationAction[];
}

interface MigrationPaths {
  home: string;
  registry: string;
  state: string;
  locks: string;
  runs: string;
  memory: string;
}

export function migrateKanbanIds(opts: { write?: boolean; home?: string } = {}): KanbanIdMigrationResult {
  const home = opts.home ?? routinesHome();
  const paths: MigrationPaths = {
    home,
    registry: opts.home ? join(home, "registry") : registryDir(),
    state: opts.home ? join(home, "state") : stateDir(),
    locks: opts.home ? join(home, "locks") : locksDir(),
    runs: opts.home ? join(home, "runs") : runsDir(),
    memory: join(home, "memory"),
  };
  const write = opts.write === true;
  const actions: KanbanIdMigrationAction[] = [];

  for (const { old, next } of KANBAN_ID_RENAMES) {
    migrateRegistry(paths.registry, old, next, write, actions);
    migrateState(paths.state, old, next, write, actions);
    migrateFile(paths.locks, `${old}.lock`, `${next}.lock`, write, actions);
    migrateDir(paths.runs, old, next, write, actions);
    migrateDir(paths.memory, old, next, write, actions);
  }

  return { write, actions };
}

function migrateRegistry(root: string, old: string, next: string, write: boolean, actions: KanbanIdMigrationAction[]) {
  const oldPath = join(root, `${old}.toml`);
  const nextPath = join(root, `${next}.toml`);
  if (!existsSync(oldPath)) return;

  if (!existsSync(nextPath)) {
    actions.push({ kind: "move", path: oldPath, dest: nextPath });
    if (write) {
      mkdirSync(dirname(nextPath), { recursive: true });
      renameSync(oldPath, nextPath);
      rewriteRegistryId(nextPath, old, next);
    }
    return;
  }

  const archive = archivePath(oldPath);
  actions.push({ kind: "archive", path: oldPath, dest: archive, reason: `${basename(nextPath)} already exists` });
  if (write) renameSync(oldPath, archive);
}

function migrateState(root: string, old: string, next: string, write: boolean, actions: KanbanIdMigrationAction[]) {
  const oldPath = join(root, `${old}.json`);
  const nextPath = join(root, `${next}.json`);
  if (!existsSync(oldPath)) return;

  if (!existsSync(nextPath)) {
    actions.push({ kind: "move", path: oldPath, dest: nextPath });
    if (write) {
      mkdirSync(dirname(nextPath), { recursive: true });
      renameSync(oldPath, nextPath);
      rewriteJsonId(nextPath, next);
    }
    return;
  }

  actions.push({ kind: "merge", path: oldPath, dest: nextPath, reason: `${basename(nextPath)} already exists` });
  if (write) {
    const oldState = readJson(oldPath);
    const nextState = readJson(nextPath);
    writeFileSync(nextPath, JSON.stringify(mergeState(oldState, nextState, next), null, 2) + "\n");
    renameSync(oldPath, archivePath(oldPath));
  }
}

function migrateFile(root: string, oldName: string, nextName: string, write: boolean, actions: KanbanIdMigrationAction[]) {
  const oldPath = join(root, oldName);
  const nextPath = join(root, nextName);
  if (!existsSync(oldPath)) return;
  if (existsSync(nextPath)) {
    const archive = archivePath(oldPath);
    actions.push({ kind: "archive", path: oldPath, dest: archive, reason: `${nextName} already exists` });
    if (write) renameSync(oldPath, archive);
    return;
  }
  actions.push({ kind: "move", path: oldPath, dest: nextPath });
  if (write) {
    mkdirSync(dirname(nextPath), { recursive: true });
    renameSync(oldPath, nextPath);
  }
}

function migrateDir(root: string, oldName: string, nextName: string, write: boolean, actions: KanbanIdMigrationAction[]) {
  const oldPath = join(root, oldName);
  const nextPath = join(root, nextName);
  if (!existsSync(oldPath)) return;
  if (!existsSync(nextPath)) {
    actions.push({ kind: "move", path: oldPath, dest: nextPath });
    if (write) {
      mkdirSync(dirname(nextPath), { recursive: true });
      renameSync(oldPath, nextPath);
    }
    return;
  }
  if (!statSync(oldPath).isDirectory() || !statSync(nextPath).isDirectory()) {
    actions.push({ kind: "archive", path: oldPath, dest: archivePath(oldPath), reason: `${nextName} already exists` });
    if (write) renameSync(oldPath, archivePath(oldPath));
    return;
  }

  actions.push({ kind: "merge", path: oldPath, dest: nextPath, reason: `${nextName} already exists` });
  if (write) {
    mergeDirectory(oldPath, nextPath);
    rmSync(oldPath, { recursive: true, force: true });
  }
}

function rewriteRegistryId(path: string, old: string, next: string) {
  const text = readFileSync(path, "utf8");
  const replaced = text.replace(new RegExp(`^id\\s*=\\s*"${escapeRe(old)}"\\s*$`, "m"), `id = "${next}"`);
  if (replaced !== text) writeFileSync(path, replaced);
}

function rewriteJsonId(path: string, id: string) {
  const raw = readJson(path);
  writeFileSync(path, JSON.stringify({ ...raw, id }, null, 2) + "\n");
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mergeState(oldState: Record<string, unknown>, nextState: Record<string, unknown>, id: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...oldState, ...nextState, id };
  for (const key of ["lastFire", "lastRun"] as const) {
    const oldValue = typeof oldState[key] === "string" ? (oldState[key] as string) : undefined;
    const nextValue = typeof nextState[key] === "string" ? (nextState[key] as string) : undefined;
    out[key] = latestIso(oldValue, nextValue);
  }
  return out;
}

function latestIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function mergeDirectory(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    let dest = join(to, name);
    if (existsSync(dest)) dest = join(to, `${name}.from-fkanban-${Date.now()}`);
    renameSync(src, dest);
  }
}

function archivePath(path: string): string {
  return `${path}.migrated-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
