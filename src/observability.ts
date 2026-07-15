import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { RoutineEntry } from "./registry.ts";
import type { RunResult } from "./runner.ts";

type SentryEnv = Record<string, string | undefined>;

type SentryInitOptions = {
  service: string;
  env?: SentryEnv;
};

type SharedInitSentry = (options: {
  service: string;
  env?: SentryEnv;
  installProcessHandlers?: boolean;
}) => Promise<{ enabled: boolean; reason?: string }>;

type CaptureContext = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  level?: "error" | "warning" | "info";
};

type SentryCaptureModule = {
  captureException?: (error: unknown, context?: CaptureContext) => void;
  captureMessage?: (message: string, context?: CaptureContext) => void;
  flush?: (timeoutMs?: number) => Promise<boolean>;
};

export type RoutinesSentryResult =
  | { enabled: true; service: string }
  | {
      enabled: false;
      reason:
        | "disabled"
        | "missing_dsn"
        | "lastsecrets_failed"
        | "shared_helper_missing"
        | "shared_helper_failed";
    };

export interface RoutinesSentryTestDeps {
  initSentry?: SharedInitSentry;
  captureModule?: SentryCaptureModule;
  resolveSecret?: (locator: string) => string | undefined;
  helperPath?: string;
}

let initialized = false;
let captureModule: SentryCaptureModule | null = null;

export async function initRoutinesSentry(
  opts: SentryInitOptions,
  deps: RoutinesSentryTestDeps = {},
): Promise<RoutinesSentryResult> {
  if (process.env.ROUTINES_SENTRY_DISABLED === "1") {
    return { enabled: false, reason: "disabled" };
  }

  const env = { ...(opts.env ?? process.env) };
  const rawDsn = env.OBS_SENTRY_DSN?.trim();
  if (!rawDsn) {
    return { enabled: false, reason: "missing_dsn" };
  }

  const resolvedDsn = rawDsn.startsWith("lastsecrets://")
    ? (deps.resolveSecret ?? resolveLastSecretsLocator)(rawDsn)
    : rawDsn;
  if (!resolvedDsn) {
    return { enabled: false, reason: "lastsecrets_failed" };
  }
  env.OBS_SENTRY_DSN = resolvedDsn;

  const initSentry = deps.initSentry ?? (await loadSharedInit(deps.helperPath));
  if (!initSentry) {
    return { enabled: false, reason: "shared_helper_missing" };
  }

  try {
    const result = await initSentry({ service: opts.service, env });
    if (!result.enabled) {
      return { enabled: false, reason: (result.reason as RoutinesSentryResult["reason"]) ?? "missing_dsn" };
    }
  } catch {
    return { enabled: false, reason: "shared_helper_failed" };
  }

  initialized = true;
  captureModule = deps.captureModule ?? (await loadCaptureModule());
  return { enabled: true, service: opts.service };
}

export function captureRoutinesException(error: unknown, context: CaptureContext = {}): void {
  if (!initialized || !captureModule?.captureException) return;
  captureModule.captureException(error, scrubContext(context));
  void captureModule.flush?.(2000);
}

export function captureRoutineRunFailure(entry: RoutineEntry, result: RunResult): void {
  if (!initialized || !captureModule) return;
  const context = scrubContext({
    level: "error",
    tags: {
      service: "routinesd",
      routine_id: entry.id,
      harness: entry.harness,
      model: entry.model,
      exit_code: String(result.exitCode ?? "null"),
      timed_out: String(result.timedOut),
      outcome: result.outcome.kind,
    },
    extra: {
      run_dir: result.runDir,
      duration_ms: result.durationMs,
      outcome_detail: result.outcome.detail,
      heartbeat_attempted: result.heartbeat.attempted,
      heartbeat_ok: result.heartbeat.ok,
    },
  });
  if (captureModule.captureMessage) {
    captureModule.captureMessage("routine dispatch failed", context);
  } else {
    captureModule.captureException?.(new Error("routine dispatch failed"), context);
  }
  void captureModule.flush?.(2000);
}

function resolveLastSecretsLocator(locator: string): string | undefined {
  const slug = locator.slice("lastsecrets://".length).trim();
  if (!slug) return undefined;
  try {
    return execFileSync("lastsecrets", ["get", slug], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

async function loadSharedInit(helperPath?: string): Promise<SharedInitSentry | null> {
  const path = helperPath ?? join(process.env.LAST_STACK_ROOT ?? join(homedir(), ".last-stack"), "lib/observability/sentry.ts");
  if (!existsSync(path)) return null;
  const mod = (await import(pathToFileURL(path).href)) as { initSentry?: SharedInitSentry };
  return typeof mod.initSentry === "function" ? mod.initSentry : null;
}

async function loadCaptureModule(): Promise<SentryCaptureModule | null> {
  try {
    const moduleName = "@sentry/node";
    return (await import(moduleName)) as SentryCaptureModule;
  } catch {
    return null;
  }
}

function scrubContext(context: CaptureContext): CaptureContext {
  return {
    ...context,
    tags: scrubRecord(context.tags),
    extra: scrubRecord(context.extra),
  };
}

function scrubRecord<T>(record: Record<string, T> | undefined): Record<string, T | string> | undefined {
  if (!record) return undefined;
  const out: Record<string, T | string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = /password|token|secret|dsn|key/i.test(key) ? "[redacted]" : value;
  }
  return out;
}
