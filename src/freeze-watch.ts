// Out-of-fleet fleet-freeze watchdog.
//
// WHY THIS IS NOT A ROUTINE
//
// Every detector that watched routinesd was itself dispatched BY routinesd, so
// each one shared the fate of its subject. Measured on 2026-10-01:
//
//   * routinesd dispatched NOTHING for 59h48m across four daemon generations.
//     `last-stack-why-stopped` ran 17 minutes after it ended and answered
//     `classes=none ... may be idle or healthy`; `routine-fleet-health` ran and
//     reported `ok`. Both are routines, so both were dead for the duration.
//     (papercut-routinesd-dispatched-nothing-for-60h-across-four-daemon-generations-20261001)
//   * 38 active routines flipped to `status = "paused"` in a ~4 minute window.
//     The daemon kept ticking `80 routines in_flight=0` and dispatched nothing
//     from 18:49:43Z until a human-triggered `routines resume` at 20:10:5xZ;
//     the first dispatch after that landed 20:11:01Z, 3 s later. Nothing
//     reported the 81-minute stop — it was found by chance.
//     (papercut-routine-registry-status-mass-flip-to-paused-no-backup-20261001)
//
// Both records name the same missing half: a watcher with NO dependency on
// routinesd dispatching anything. This module is that watcher's decision logic.
// It reads two files and nothing else — no node, no board, no daemon, no
// dispatch — so it keeps working during exactly the outage it exists to catch.
//
// It deliberately does NOT heal. A mass pause and a scheduler freeze have
// different correct repairs, and resuming 80 registry files blindly would
// activate the 42 that are legitimately paused/retired/dogfood-only. Surfacing
// is the whole job.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { registryDir, routinesHome } from "./paths.ts";

/**
 * Staleness bound for condition A, in milliseconds.
 *
 * 6 h, derived from this host's own dispatch-gap distribution over 18085
 * dispatches / 79 days: p50 150 s, p90 735 s, p99 3432 s. 105 gaps above 1 h
 * and 17 above 2 h are ordinary lulls; all 8 gaps above 6 h were real freezes
 * (9.5 h to 107 h). 6 h is the smallest bound that fires on every freeze and on
 * no lull. Same constant `last-stack-why-stopped` Class G uses, on purpose —
 * two detectors of one condition must not carry two different bounds.
 */
export const DEFAULT_DISPATCH_BOUND_MS = 21_600_000;

/** Default re-read window for the heartbeat log, in bytes (see `tailBytes`). */
export const DEFAULT_TAIL_BYTES = 4_194_304;

/**
 * A routinesd-written heartbeat line, as `src/heartbeat.ts` emits it:
 * `<ISO> <id> <ok|noop|error> harness=<h> model=<m> exit=<n> dur=<s>s run=<dir>`
 *
 * The log is shared with other producers (kanban-pickup, kanban-validate, …)
 * whose lines carry neither `harness=` nor `exit=`. Matching on the writer's
 * own three tokens is what keeps another producer's line from reading as a
 * dispatch and silently clearing a freeze.
 */
const ROUTINESD_LINE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\S+\s+\S+\s+.*\bharness=\S+.*\bexit=\S+.*\bdur=\S+/;

/** Newest routinesd-written dispatch timestamp in `text`, or null if none. */
export function newestDispatchAt(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = ROUTINESD_LINE.exec(lines[i] ?? "");
    if (m) return m[1]!;
  }
  return null;
}

export interface RegistryCensus {
  registered: number;
  active: number;
  paused: number;
  /** Files that did not parse as a registry entry at all. */
  unreadable: number;
}

/**
 * Count `status` across `~/.routines/registry/*.toml` by reading the raw text.
 *
 * This does NOT go through `parseEntry`. A watchdog must survive a registry
 * that one invalid field makes unparseable — the whole point is to keep
 * answering when the fleet is broken — so it reads the one key it needs and
 * counts anything it cannot classify as `unreadable` rather than throwing.
 */
export function censusRegistry(dir: string = registryDir()): RegistryCensus {
  let active = 0;
  let paused = 0;
  let unreadable = 0;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".toml"));
  } catch {
    return { registered: 0, active: 0, paused: 0, unreadable: 0 };
  }
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      unreadable++;
      continue;
    }
    const m = /^\s*status\s*=\s*"(active|paused)"\s*$/m.exec(text);
    // An entry with no `status` key parses as active (registry.ts defaults it),
    // so count it that way here or the two readers would disagree.
    if (m == null) {
      if (/^\s*status\s*=/m.test(text)) unreadable++;
      else active++;
      continue;
    }
    if (m[1] === "active") active++;
    else paused++;
  }
  return { registered: active + paused + unreadable, active, paused, unreadable };
}

/** Condition identifiers, stable tokens — logs and notices are grepped for them. */
export type FreezeCondition = "dispatch-stale" | "no-active-routines";

export interface FreezeInput {
  nowMs: number;
  /** Newest routinesd dispatch, ISO, or null when the log named none. */
  newestDispatchAt: string | null;
  /** Why the dispatch timestamp is absent, when it is. */
  dispatchLogReadable: boolean;
  census: RegistryCensus;
  boundMs?: number;
}

export interface FreezeVerdict {
  /** A condition fired. The fleet cannot be shipping. */
  frozen: boolean;
  /**
   * Could not judge. NEVER render this as healthy: a watchdog that cannot read
   * its dependency and reports the corpus clean is the failure mode that let
   * both 2026-10-01 incidents run unreported.
   */
  unknown: boolean;
  conditions: FreezeCondition[];
  /** One line per condition / per reason it could not judge. */
  reasons: string[];
  dispatchAgeMs: number | null;
  boundMs: number;
  census: RegistryCensus;
}

export function classifyFreeze(input: FreezeInput): FreezeVerdict {
  const boundMs = input.boundMs ?? DEFAULT_DISPATCH_BOUND_MS;
  const conditions: FreezeCondition[] = [];
  const reasons: string[] = [];
  let unknown = false;
  let dispatchAgeMs: number | null = null;

  // Condition A — the scheduler is not dispatching.
  if (!input.dispatchLogReadable) {
    unknown = true;
    reasons.push("cannot judge dispatch recency: heartbeat log unreadable");
  } else if (input.newestDispatchAt == null) {
    unknown = true;
    reasons.push("cannot judge dispatch recency: no routinesd-written line in the window read");
  } else {
    const t = Date.parse(input.newestDispatchAt);
    if (!Number.isFinite(t)) {
      unknown = true;
      reasons.push(`cannot judge dispatch recency: unparseable timestamp ${input.newestDispatchAt}`);
    } else {
      dispatchAgeMs = input.nowMs - t;
      if (dispatchAgeMs > boundMs) {
        conditions.push("dispatch-stale");
        reasons.push(
          `scheduler freeze: last routinesd dispatch ${Math.round(dispatchAgeMs / 1000)}s ago ` +
            `(bound ${Math.round(boundMs / 1000)}s)`,
        );
      }
    }
  }

  // Condition B — the registry itself says nothing may run.
  //
  // Needs no bound and cannot false-positive: a fleet with routines registered
  // and none active is always wrong, whatever the cause. This is the condition
  // that catches a mass `status = "paused"` flip in one tick instead of waiting
  // out condition A's 6 h.
  if (input.census.registered === 0) {
    unknown = true;
    reasons.push("cannot judge registry: no registry files read");
  } else if (input.census.active === 0) {
    conditions.push("no-active-routines");
    reasons.push(
      `mass pause: 0 of ${input.census.registered} registered routines are active ` +
        `(paused=${input.census.paused} unreadable=${input.census.unreadable})`,
    );
  }

  return {
    frozen: conditions.length > 0,
    unknown,
    conditions,
    reasons,
    dispatchAgeMs,
    boundMs,
    census: input.census,
  };
}

/** Resolve the heartbeats log path the same way `src/heartbeat.ts` writes it. */
export function heartbeatsLogPath(): string {
  return (
    process.env.ROUTINES_HEARTBEATS_FILE ||
    process.env.LAST_STACK_HEARTBEATS_FILE ||
    join(process.env.HOME ?? "", ".last-stack", "logs", "routine-heartbeats.log")
  );
}

/**
 * Read the last `bytes` of a file as text.
 *
 * The heartbeat log is ~10 MB and grows forever; a watchdog that runs every 15
 * minutes must not read all of it. A window that holds no routinesd line is
 * reported as `unknown`, never as healthy — so a window too small degrades to
 * "I did not look", which is the honest answer.
 */
export function tailBytes(path: string, bytes: number = DEFAULT_TAIL_BYTES): string | null {
  try {
    const buf = readFileSync(path);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8");
  } catch {
    return null;
  }
}

export interface FreezeWatchOptions {
  nowMs?: number;
  boundMs?: number;
  logPath?: string;
  registry?: string;
  tailBytes?: number;
}

/** Read the live host and classify. No writes, no node, no daemon. */
export function observeFreeze(opts: FreezeWatchOptions = {}): FreezeVerdict {
  const logPath = opts.logPath ?? heartbeatsLogPath();
  const text = tailBytes(logPath, opts.tailBytes ?? DEFAULT_TAIL_BYTES);
  return classifyFreeze({
    nowMs: opts.nowMs ?? Date.now(),
    dispatchLogReadable: text != null,
    newestDispatchAt: text == null ? null : newestDispatchAt(text),
    census: censusRegistry(opts.registry ?? registryDir()),
    boundMs: opts.boundMs,
  });
}

/**
 * One line, with the verdict word FIRST so a log tail is greppable.
 *
 * `unknown` prints as UNKNOWN, never OK. A detector whose dependency is missing
 * and whose render says OK is worse than no detector, because it reads as
 * coverage.
 */
export function renderFreezeLine(v: FreezeVerdict, nowIso: string): string {
  const word = v.frozen ? "FROZEN" : v.unknown ? "UNKNOWN" : "OK";
  const age = v.dispatchAgeMs == null ? "-" : `${Math.round(v.dispatchAgeMs / 1000)}s`;
  const head =
    `${nowIso} freeze-watch ${word} conditions=${v.conditions.join(",") || "none"} ` +
    `dispatch_age=${age} bound=${Math.round(v.boundMs / 1000)}s ` +
    `active=${v.census.active}/${v.census.registered}`;
  return v.reasons.length > 0 ? `${head} :: ${v.reasons.join(" :: ")}` : head;
}

/**
 * Episode identity, so the watchdog surfaces once per freeze instead of once
 * per tick. A 6 h freeze at a 15 min cadence would otherwise post 24 notices.
 */
export function episodeKey(v: FreezeVerdict): string {
  return v.frozen ? `frozen:${[...v.conditions].sort().join(",")}` : v.unknown ? "unknown" : "ok";
}

export function freezeStatePath(home: string = routinesHome()): string {
  return join(home, "state", "freeze-watch.json");
}

export interface FreezeState {
  /** Episode key the last notice was posted for. */
  notifiedEpisode?: string;
  /** When the current episode was first observed, ISO. */
  episodeSince?: string;
  /** Episode key observed on the previous tick. */
  episode?: string;
}

export type SurfaceKind = "none" | "freeze" | "unknown" | "recovered";

export interface SurfaceDecision {
  kind: SurfaceKind;
  episode: string;
  next: FreezeState;
}

/**
 * Decide whether this tick should surface anything.
 *
 * Once per EPISODE, not once per tick: a 6 h freeze at a 15 min cadence would
 * otherwise post 24 identical notices and train every reader to skip them. A
 * recovery is surfaced too — a notice timeline that opens incidents and never
 * closes them is how a lapsed Situation sticks open forever.
 */
export function decideSurfacing(
  prev: FreezeState,
  v: FreezeVerdict,
  nowIso: string,
): SurfaceDecision {
  const episode = episodeKey(v);
  const wasBad = prev.episode != null && prev.episode !== "ok";
  const next: FreezeState = {
    episode,
    episodeSince: prev.episode === episode ? (prev.episodeSince ?? nowIso) : nowIso,
    notifiedEpisode: prev.notifiedEpisode,
  };

  if (episode === "ok") {
    // Recovery is reported once, and only when a bad episode was actually
    // NOTIFIED. A bad tick we never surfaced must not produce an all-clear for
    // an incident nobody was told about.
    if (wasBad && prev.notifiedEpisode != null && prev.notifiedEpisode !== "ok") {
      next.notifiedEpisode = "ok";
      return { kind: "recovered", episode, next };
    }
    next.notifiedEpisode = "ok";
    return { kind: "none", episode, next };
  }

  if (prev.notifiedEpisode === episode) return { kind: "none", episode, next };
  next.notifiedEpisode = episode;
  return { kind: v.frozen ? "freeze" : "unknown", episode, next };
}
