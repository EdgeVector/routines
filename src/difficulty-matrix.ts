import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { routinesHome } from "./paths.ts";
import type { Harness } from "./registry.ts";

export const DIFFICULTIES = ["fast", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
const PROVIDERS = ["claude", "codex", "grok"] as const satisfies readonly Harness[];

export interface MatrixCell {
  model: string;
}

export interface DifficultyMatrix {
  version: number;
  /** Preference order. The availability resolver may skip unavailable providers. */
  providerOrder: Harness[];
  matrix: Record<Difficulty, Record<Harness, MatrixCell>>;
}

export interface MatrixResolution {
  version: number;
  difficulty: Difficulty;
  harness: Harness;
  model: string;
}

export class DifficultyMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DifficultyMatrixError";
  }
}

/**
 * Safe bootstrap matrix. A single optional file at
 * $ROUTINES_HOME/routing-matrix.json owns fleet overrides.
 */
export const DEFAULT_DIFFICULTY_MATRIX: DifficultyMatrix = {
  version: 1,
  providerOrder: ["grok", "codex", "claude"],
  matrix: {
    fast: {
      grok: { model: "grok-4.5" },
      codex: { model: "gpt-5.6-luna" },
      claude: { model: "haiku" },
    },
    normal: {
      grok: { model: "grok-4.5" },
      codex: { model: "gpt-5.6-terra" },
      claude: { model: "sonnet" },
    },
    hard: {
      grok: { model: "grok-4.5" },
      codex: { model: "gpt-5.6-sol" },
      claude: { model: "opus" },
    },
  },
};

export function difficultyMatrixPath(): string {
  return process.env.ROUTINES_ROUTING_MATRIX_PATH || join(routinesHome(), "routing-matrix.json");
}

export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

export function loadDifficultyMatrix(): DifficultyMatrix {
  const path = difficultyMatrixPath();
  if (!existsSync(path)) return DEFAULT_DIFFICULTY_MATRIX;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new DifficultyMatrixError(`${path}: invalid JSON: ${(err as Error).message}`);
  }
  return validateDifficultyMatrix(parsed, path);
}

export function resolveDifficulty(difficulty: Difficulty): MatrixResolution {
  const config = loadDifficultyMatrix();
  const harness = config.providerOrder[0]!;
  const cell = config.matrix[difficulty][harness];
  return { version: config.version, difficulty, harness, model: cell.model };
}

export function validateDifficultyMatrix(value: unknown, source = "routing matrix"): DifficultyMatrix {
  if (!isRecord(value)) throw new DifficultyMatrixError(`${source}: root must be an object`);
  const version = value.version;
  if (!Number.isInteger(version) || (version as number) < 1) {
    throw new DifficultyMatrixError(`${source}: version must be a positive integer`);
  }
  const providerOrder = value.providerOrder;
  if (!Array.isArray(providerOrder) || providerOrder.length !== PROVIDERS.length) {
    throw new DifficultyMatrixError(`${source}: providerOrder must contain exactly claude, codex, and grok`);
  }
  const providers = providerOrder.map((item) => {
    if (typeof item !== "string" || !(PROVIDERS as readonly string[]).includes(item)) {
      throw new DifficultyMatrixError(`${source}: invalid provider ${JSON.stringify(item)}`);
    }
    return item as Harness;
  });
  if (new Set(providers).size !== PROVIDERS.length) {
    throw new DifficultyMatrixError(`${source}: providerOrder must not contain duplicates`);
  }
  if (!isRecord(value.matrix)) throw new DifficultyMatrixError(`${source}: matrix must be an object`);

  const matrix = {} as DifficultyMatrix["matrix"];
  for (const difficulty of DIFFICULTIES) {
    const row = value.matrix[difficulty];
    if (!isRecord(row)) throw new DifficultyMatrixError(`${source}: missing ${difficulty} row`);
    const nextRow = {} as Record<Harness, MatrixCell>;
    for (const harness of PROVIDERS) {
      const cell = row[harness];
      if (!isRecord(cell) || typeof cell.model !== "string" || !cell.model.trim()) {
        throw new DifficultyMatrixError(`${source}: ${difficulty}.${harness}.model must be a non-empty string`);
      }
      nextRow[harness] = { model: cell.model.trim() };
    }
    matrix[difficulty] = nextRow;
  }
  return { version: version as number, providerOrder: providers, matrix };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
