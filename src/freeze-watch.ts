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
// It reads files and nothing else — no node, no board, no daemon, no dispatch —
// so it keeps working during exactly the outage it exists to catch.
//
// DISPATCH LIVENESS COMES FROM TWO SOURCES, NEWEST WINS
//
// routinesd's own log (`daemon/routinesd.err.log`) is authoritative: the daemon
// writes a `dispatch` record for every dispatch, unconditionally. The heartbeat
// log is corroboration only — `writeHeartbeat` fires solely when a routine sets
// `heartbeat_slug`, so it misses 53 of this host's 81 entries, and on
// 2026-10-02 it missed all 3 active ones and reported a 21 h freeze on a
// scheduler that had dispatched 100 s earlier. Keeping both and taking the
// newest removes that blind spot without ever inventing liveness: each source
// only reports dispatches it actually saw.
//
// It deliberately does NOT heal. A mass pause and a scheduler freeze have
// different correct repairs, and resuming 80 registry files blindly would
// activate the 42 that are legitimately paused/retired/dogfood-only. Surfacing
// is the whole job.

import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

import { daemonLogDir, registryDir, routinesHome } from "./paths.ts";

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

/**
 * A routinesd-written record in the daemon's OWN log, as `routinesd` emits it:
 * `{"ts":"<ISO>","kind":"dispatch","id":"<routine>","detail":"<harness/model>"}`
 *
 * WHY THIS SOURCE EXISTS, AND WHY IT IS THE AUTHORITATIVE ONE
 *
 * The heartbeat log above is NOT a complete record of dispatching. `writeHeartbeat`
 * in `src/heartbeat.ts` appends a line only when the routine's registry entry sets
 * `heartbeat_slug`, so the signal is opt-in PER ROUTINE. Measured 2026-10-02:
 * 28 of 81 registry entries set it, and **0 of the 3 then-active routines did**.
 * The fleet had been deliberately narrowed to those 3 by
 * `decision-2026-10-02-factory-drives-logical-resident-set-only`, so no dispatch
 * could reach the matcher at all:
 *
 *   routinesd daemon log, 19:08Z-21:17Z   11 dispatch + 11 complete
 *   newest heartbeat `harness=` line      2026-10-02T00:08:50.426Z
 *   `routines freeze-watch` verdict       FROZEN dispatch-stale age=76084s active=3/81
 *
 * The scheduler had dispatched 100 s before that probe. The arm had been false
 * since ~06:09Z (bound 21600 s), roughly 15 h, and would have stayed false for
 * as long as the posture held — a watchdog crying freeze at a healthy fleet,
 * which is the one failure that trains an operator to stop reading it.
 * (papercut-freeze-watch-dispatch-staleness-reads-an-opt-in-heartbeat-signal-20261002)
 *
 * routinesd writes these records itself, unconditionally, for every dispatch.
 * No registry opt-in, no cooperation from the dispatched agent.
 *
 * `tick` is deliberately NOT matched. During the 59h48m freeze the daemon kept
 * ticking `80 routines in_flight=0` and dispatched nothing; a matcher that
 * accepted ticks would read that log as fresh and mask the exact outage this
 * module exists to catch. A tick proves the daemon is alive, never that it
 * dispatched. `kind` is tested separately from `ts` so key order is not load-bearing.
 */
const DAEMON_DISPATCH_KIND = /"kind"\s*:\s*"(?:dispatch|complete)"/;
const DAEMON_TS = /"ts"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/;

/** Newest routinesd dispatch/complete timestamp in a daemon log, or null. */
export function newestDaemonDispatchAt(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!DAEMON_DISPATCH_KIND.test(line)) continue;
    const m = DAEMON_TS.exec(line);
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
  /**
   * Newest dispatch seen in the HEARTBEAT log, ISO, or null when it named none.
   *
   * Incomplete by construction — see `DAEMON_DISPATCH_KIND`. Kept as a source
   * because it is the only one on a host whose daemon log has been rotated
   * away, and because a heartbeat line is independent corroboration that a
   * dispatched routine actually ran its work.
   */
  newestDispatchAt: string | null;
  /** Whether the heartbeat log could be read at all. */
  dispatchLogReadable: boolean;
  /**
   * Newest dispatch seen in routinesd's OWN daemon log, ISO, or null.
   * Authoritative: routinesd writes it for every dispatch with no opt-in.
   */
  daemonDispatchAt?: string | null;
  /** Whether the daemon log could be read at all. */
  daemonLogReadable?: boolean;
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
  //
  // Two independent sources, and the NEWEST wins. Either one naming a recent
  // dispatch is positive proof the scheduler dispatched, so taking the newest
  // cannot invent liveness that neither source saw — it can only stop one
  // source's blind spot from reading as a freeze. The blind spots are real and
  // different: the heartbeat log misses every routine without `heartbeat_slug`,
  // and the daemon log is absent on a host where launchd rotated it away.
  //
  // `unknown` still wins over OK whenever NO source produced a usable
  // timestamp, so a watchdog that cannot see still says so.
  const sources: { name: string; readable: boolean; at: string | null }[] = [
    { name: "routinesd daemon log", readable: input.daemonLogReadable ?? false, at: input.daemonDispatchAt ?? null },
    { name: "heartbeat log", readable: input.dispatchLogReadable, at: input.newestDispatchAt },
  ];
  const unreadable = sources.filter((s) => !s.readable).map((s) => s.name);
  const silent = sources.filter((s) => s.readable && s.at == null).map((s) => s.name);
  const unparseable = sources.filter(
    (s) => s.readable && s.at != null && !Number.isFinite(Date.parse(s.at)),
  );
  const parsed = sources
    .filter((s) => s.readable && s.at != null && Number.isFinite(Date.parse(s.at)))
    .map((s) => Date.parse(s.at!));

  if (parsed.length === 0) {
    unknown = true;
    if (unreadable.length > 0) {
      reasons.push(`cannot judge dispatch recency: unreadable (${unreadable.join(", ")})`);
    }
    if (silent.length > 0) {
      reasons.push(
        `cannot judge dispatch recency: no routinesd-written line in the window read ` +
          `(${silent.join(", ")})`,
      );
    }
    for (const s of unparseable) {
      reasons.push(`cannot judge dispatch recency: unparseable timestamp ${s.at} (${s.name})`);
    }
  } else {
    dispatchAgeMs = input.nowMs - Math.max(...parsed);
    if (dispatchAgeMs > boundMs) {
      conditions.push("dispatch-stale");
      reasons.push(
        `scheduler freeze: last routinesd dispatch ${Math.round(dispatchAgeMs / 1000)}s ago ` +
          `(bound ${Math.round(boundMs / 1000)}s)`,
      );
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
 *
 * This SEEKS. The first version read the whole file with `readFileSync` and
 * then sliced the tail off it, which did the thing the paragraph above says not
 * to do — the comment was right and the code did not implement it. It mattered
 * once routinesd's own log became a source: measured 2026-10-02, the heartbeat
 * log is 10.4 MB and `~/.routines/daemon/routinesd.err.log` is **132.8 MB**, so
 * a slicing read would have pulled 143 MB through memory every 900 s to look at
 * 8 MB of it.
 *
 * A tail window can cut a line in half. That only ever drops the OLDEST line in
 * the window, which cannot change a "newest" answer that any later line
 * provides, and when the window holds nothing else the verdict degrades to
 * `unknown` rather than to OK.
 */
export function tailBytes(path: string, bytes: number = DEFAULT_TAIL_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const want = Math.min(size, Math.max(0, bytes));
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buf, read, want - read, size - want + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* a close failure cannot change the verdict */
      }
    }
  }
}

/**
 * routinesd's own log, resolved through the SAME helper `src/launchd.ts` uses to
 * write the daemon's `StandardErrorPath`. Deriving it from `daemonLogDir()`
 * rather than re-spelling the path is what keeps the reader and the writer from
 * drifting apart.
 */
export function routinesdLogPath(): string {
  return process.env.ROUTINESD_LOG_FILE || join(daemonLogDir(), "routinesd.err.log");
}

export interface FreezeWatchOptions {
  nowMs?: number;
  boundMs?: number;
  logPath?: string;
  /** routinesd's own log. Defaults to `routinesdLogPath()`. */
  daemonLogPath?: string;
  registry?: string;
  tailBytes?: number;
}

/** Read the live host and classify. No writes, no node, no daemon process. */
export function observeFreeze(opts: FreezeWatchOptions = {}): FreezeVerdict {
  const window = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const text = tailBytes(opts.logPath ?? heartbeatsLogPath(), window);
  const daemon = tailBytes(opts.daemonLogPath ?? routinesdLogPath(), window);
  return classifyFreeze({
    nowMs: opts.nowMs ?? Date.now(),
    dispatchLogReadable: text != null,
    newestDispatchAt: text == null ? null : newestDispatchAt(text),
    daemonLogReadable: daemon != null,
    daemonDispatchAt: daemon == null ? null : newestDaemonDispatchAt(daemon),
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
