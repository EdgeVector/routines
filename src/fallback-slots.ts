// Fleet-wide cap + jitter for same-fire fallback legs.
//
// Measured 2026-08-25: a grok 402 burst sent ~15 routines onto Claude in one
// tick. 44 Claude CLI processes (8.8 GiB) plus lastdbd 6.1 GiB produced a
// jetsam; several of those fires then exited 124 and one 124 was misread as a
// Claude usage-limit outage. Primary legs stay uncapped (registry cadence
// already admits them). Only a hop onto a different harness takes a slot.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { routinesHome } from "./paths.ts";

export const DEFAULT_FALLBACK_MAX_CONCURRENT = 4;
export const DEFAULT_FALLBACK_JITTER_MS = 8_000;
const SLOT_POLL_MS = 25;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !raw.trim()) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** Max in-flight fallback legs per harness. 0 = unlimited (tests / operator). */
export function fallbackMaxConcurrent(): number {
  return positiveInt(process.env.ROUTINES_FALLBACK_MAX_CONCURRENT, DEFAULT_FALLBACK_MAX_CONCURRENT);
}

/**
 * Jitter before a fallback spawn, in ms. Env is a MAX; 0 disables.
 * Production default spreads a burst instead of launching every hop at t0.
 */
export function fallbackJitterMs(): number {
  const max = positiveInt(process.env.ROUTINES_FALLBACK_JITTER_MS, DEFAULT_FALLBACK_JITTER_MS);
  if (max <= 0) return 0;
  return Math.floor(Math.random() * (max + 1));
}

export function fallbackSlotsDir(harness: string): string {
  const safe = harness.replace(/[^a-zA-Z0-9._-]+/g, "-") || "unknown";
  return join(routinesHome(), "fallback-slots", safe);
}

function slotPid(name: string): number | null {
  const m = name.match(/^(\d+)-/);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) ? pid : null;
}

/** Drop files whose owner pid is dead so a crash cannot leak the cap. */
export function reapDeadFallbackSlots(harness: string): void {
  const dir = fallbackSlotsDir(harness);
  if (!existsSync(dir)) return;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = slotPid(name);
    if (pid == null || pidAlive(pid)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function countLiveFallbackSlots(harness: string): number {
  reapDeadFallbackSlots(harness);
  const dir = fallbackSlotsDir(harness);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

export type FallbackSlotToken = string;

/**
 * Try to take one slot. Returns a token to release, or null when at cap.
 * Cap 0 means unlimited and still records a slot so tests can observe it.
 */
export function acquireFallbackSlot(
  harness: string,
  owner: { pid: number; id: string },
): FallbackSlotToken | null {
  const cap = fallbackMaxConcurrent();
  reapDeadFallbackSlots(harness);
  if (cap > 0 && countLiveFallbackSlots(harness) >= cap) return null;
  const dir = fallbackSlotsDir(harness);
  mkdirSync(dir, { recursive: true });
  const token = join(dir, `${owner.pid}-${owner.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  writeFileSync(
    token,
    JSON.stringify({
      pid: owner.pid,
      id: owner.id,
      harness,
      acquiredAt: new Date().toISOString(),
    }) + "\n",
  );
  return token;
}

export function releaseFallbackSlot(token: FallbackSlotToken | null | undefined): void {
  if (!token) return;
  try {
    rmSync(token, { force: true });
  } catch {
    /* ignore */
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FallbackSlotWait =
  | { token: FallbackSlotToken }
  | { overloaded: true };

/**
 * Jitter, then wait until a slot is free or `deadlineMs` elapses.
 * Overloaded is retry-later — never harness-outage evidence.
 */
export async function waitForFallbackSlot(
  harness: string,
  owner: { pid: number; id: string },
  opts: { deadlineMs: number; jitterMs?: number } = { deadlineMs: 30_000 },
): Promise<FallbackSlotWait> {
  const jitter = opts.jitterMs ?? fallbackJitterMs();
  if (jitter > 0) await sleepMs(jitter);
  const start = Date.now();
  const deadline = Math.max(0, opts.deadlineMs);
  for (;;) {
    const token = acquireFallbackSlot(harness, owner);
    if (token) return { token };
    if (Date.now() - start >= deadline) return { overloaded: true };
    await sleepMs(SLOT_POLL_MS);
  }
}
