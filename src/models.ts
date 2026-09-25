// Known live models per harness.
//
// Strict validation: Grok has a limited, known set of models. When an unknown
// grok model is selected, catch it at routing time (before harness spawn).
// Other harnesses are more lenient — new models can be added by operators
// without scheduler changes.

import type { Harness } from "./registry.ts";

// Strict: grok has a tight, known set of live models.
// Lenient: other harnesses can have more flexibility for test/future models.
const STRICT_HARNESSES = new Set<Harness>(["grok"]);

export const KNOWN_MODELS: Record<Harness, Set<string>> = {
  claude: new Set(["haiku", "sonnet", "opus"]),
  codex: new Set(["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]),
  grok: new Set(["grok-4.5"]),
  gemini: new Set(["gemini-3.7-flash", "gemini-3.1-pro"]),
};

export class ModelValidationError extends Error {
  constructor(
    harness: string,
    model: string,
  ) {
    super(
      `unknown model ${JSON.stringify(model)} for harness ${JSON.stringify(harness)}; ` +
      `known models: ${[...KNOWN_MODELS[harness as Harness] || []].join(", ")}`,
    );
    this.name = "ModelValidationError";
  }
}

export function validateModel(harness: string, model: string): void {
  if (!STRICT_HARNESSES.has(harness as Harness)) return;
  const known = KNOWN_MODELS[harness as Harness];
  if (!known.has(model)) {
    throw new ModelValidationError(harness, model);
  }
}
