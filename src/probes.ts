import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const PROBE_FILES: Record<string, string> = {
  "dogfood-kanban": "kanban-stress.sh",
};

export interface ProbePathOptions {
  executable?: string;
  sourceDir?: string;
}

export function resolveProbePath(id: string, options: ProbePathOptions = {}): string {
  const filename = PROBE_FILES[id];
  if (!filename) throw new Error(`unknown probe: ${id}`);

  const executable = options.executable ?? process.execPath;
  const sourceDir = options.sourceDir ?? import.meta.dir;
  const candidates = [
    join(dirname(executable), "probes", filename),
    join(sourceDir, "..", "scripts", filename),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`probe is not installed: ${id}`);
}
