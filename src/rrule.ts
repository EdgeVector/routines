// RFC 5545 RRULE evaluation — the subset the routine fleet actually uses.
//
// Codex automations and Claude scheduled tasks express schedules as RRULE
// strings, e.g. "FREQ=HOURLY;INTERVAL=2" or
// "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=8;BYMINUTE=10;BYSECOND=0".
// We support FREQ (SECONDLY..YEARLY), INTERVAL, BYDAY, BYHOUR, BYMINUTE,
// BYSECOND, BYMONTHDAY, and an optional DTSTART anchor. That covers the whole
// live dialect; anything unrecognized is rejected at parse time rather than
// silently ignored.
//
// nextAfter() computes the first occurrence strictly after a given instant by
// generating candidate datetimes day-by-day (earliest-first) and filtering by
// the BY* rules and INTERVAL alignment. All calendar math uses local date
// components via a proleptic-Gregorian day counter, so day/week/month interval
// alignment is DST-safe.

export type Freq =
  | "SECONDLY"
  | "MINUTELY"
  | "HOURLY"
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "YEARLY";

const FREQS: readonly Freq[] = [
  "SECONDLY",
  "MINUTELY",
  "HOURLY",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];

// RFC weekday codes -> JS Date.getDay() (0 = Sunday).
const WEEKDAYS: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

// Anchor used for INTERVAL alignment when a rule carries no DTSTART. A fixed
// epoch makes "every N hours/days" deterministic (e.g. HOURLY;INTERVAL=2 fires
// on even local hours) rather than drifting with process start time.
const DEFAULT_ANCHOR = new Date(1970, 0, 1, 0, 0, 0, 0);

export interface RRule {
  freq: Freq;
  interval: number;
  byhour?: number[];
  byminute?: number[];
  bysecond?: number[];
  byday?: number[]; // 0-6, Sunday-based
  bymonthday?: number[];
  dtstart?: Date;
  raw: string;
}

export class RRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RRuleError";
  }
}

export function parseRRule(input: string): RRule {
  const raw = input.trim();
  if (raw.length === 0) throw new RRuleError("empty rrule");
  const rule: Partial<RRule> = { interval: 1, raw };
  for (const part of raw.split(";")) {
    const seg = part.trim();
    if (seg.length === 0) continue;
    const eq = seg.indexOf("=");
    if (eq < 0) throw new RRuleError(`malformed rrule segment: ${JSON.stringify(seg)}`);
    const key = seg.slice(0, eq).trim().toUpperCase();
    const value = seg.slice(eq + 1).trim();
    switch (key) {
      case "FREQ": {
        const f = value.toUpperCase() as Freq;
        if (!FREQS.includes(f)) throw new RRuleError(`unsupported FREQ: ${value}`);
        rule.freq = f;
        break;
      }
      case "INTERVAL": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new RRuleError(`invalid INTERVAL: ${value}`);
        rule.interval = n;
        break;
      }
      case "BYHOUR":
        rule.byhour = numList(value, 0, 23, "BYHOUR");
        break;
      case "BYMINUTE":
        rule.byminute = numList(value, 0, 59, "BYMINUTE");
        break;
      case "BYSECOND":
        rule.bysecond = numList(value, 0, 59, "BYSECOND");
        break;
      case "BYMONTHDAY":
        rule.bymonthday = numList(value, 1, 31, "BYMONTHDAY");
        break;
      case "BYDAY":
        rule.byday = dayList(value);
        break;
      case "DTSTART":
        rule.dtstart = parseDtStart(value);
        break;
      case "COUNT":
      case "UNTIL":
        // Accepted but not enforced by nextAfter (the scheduler treats routines
        // as open-ended; bounded recurrences are out of scope for the MVP).
        break;
      case "WKST":
        break;
      default:
        throw new RRuleError(`unsupported rrule key: ${key}`);
    }
  }
  if (!rule.freq) throw new RRuleError("rrule missing FREQ");
  return rule as RRule;
}

function numList(value: string, lo: number, hi: number, name: string): number[] {
  const out: number[] = [];
  for (const tok of value.split(",")) {
    const t = tok.trim();
    if (t.length === 0) continue;
    const n = Number(t);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new RRuleError(`invalid ${name} value: ${t}`);
    }
    out.push(n);
  }
  if (out.length === 0) throw new RRuleError(`empty ${name}`);
  out.sort((a, b) => a - b);
  return out;
}

function dayList(value: string): number[] {
  const out: number[] = [];
  for (const tok of value.split(",")) {
    const t = tok.trim().toUpperCase();
    if (t.length === 0) continue;
    const d = WEEKDAYS[t];
    if (d === undefined) throw new RRuleError(`invalid BYDAY value: ${t}`);
    out.push(d);
  }
  if (out.length === 0) throw new RRuleError("empty BYDAY");
  out.sort((a, b) => a - b);
  return out;
}

function parseDtStart(value: string): Date {
  // Support YYYYMMDDTHHMMSS (local) and a trailing Z (UTC). Strip a TZID prefix
  // if present ("TZID=...:20260712T080000" -> the datetime tail).
  const colon = value.lastIndexOf(":");
  const dt = colon >= 0 ? value.slice(colon + 1) : value;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(dt.trim());
  if (!m) throw new RRuleError(`invalid DTSTART: ${value}`);
  const [, y, mo, d, h, mi, s, z] = m;
  const yy = Number(y);
  const MM = Number(mo);
  const dd = Number(d);
  const hh = Number(h);
  const mm = Number(mi);
  const ss = Number(s);
  if (z === "Z") return new Date(Date.UTC(yy, MM - 1, dd, hh, mm, ss));
  return new Date(yy, MM - 1, dd, hh, mm, ss);
}

// --- occurrence computation ---------------------------------------------

// Proleptic Gregorian day number (Howard Hinnant's algorithm). month is 1-12.
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function dayNum(d: Date): number {
  return daysFromCivil(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function isFinerOrEqual(a: Freq, b: Freq): boolean {
  return FREQS.indexOf(a) <= FREQS.indexOf(b);
}

/** First occurrence strictly after `after`, or null if none within the horizon. */
export function nextAfter(rule: RRule, after: Date): Date | null {
  const anchor = rule.dtstart ?? DEFAULT_ANCHOR;
  const interval = rule.interval > 0 ? rule.interval : 1;
  const freq = rule.freq;

  // Effective time-of-day expansion. A field defaults to "any value" only for
  // frequencies finer than it; otherwise it pins to the anchor's component
  // (RFC 5545 semantics for the common cases).
  const hours = rule.byhour ?? (isFinerOrEqual(freq, "HOURLY") ? range(0, 23) : [anchor.getHours()]);
  const minutes =
    rule.byminute ?? (isFinerOrEqual(freq, "MINUTELY") ? range(0, 59) : [anchor.getMinutes()]);
  const seconds =
    rule.bysecond ?? (isFinerOrEqual(freq, "SECONDLY") ? range(0, 59) : [anchor.getSeconds()]);

  const byday = rule.byday ?? (freq === "WEEKLY" ? [anchor.getDay()] : undefined);
  const bymonthday = rule.bymonthday ?? (freq === "MONTHLY" ? [anchor.getDate()] : undefined);

  const startDay = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  const MAX_DAYS = 366 * 2 + 2;

  for (let offset = 0; offset < MAX_DAYS; offset++) {
    const day = new Date(startDay.getTime());
    day.setDate(day.getDate() + offset);
    if (byday && !byday.includes(day.getDay())) continue;
    if (bymonthday && !bymonthday.includes(day.getDate())) continue;
    if (!intervalAligned(freq, interval, anchor, day)) continue;

    for (const h of hours) {
      for (const m of minutes) {
        for (const s of seconds) {
          const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, s, 0);
          if (cand.getTime() <= after.getTime()) continue;
          // HOURLY/MINUTELY/SECONDLY interval alignment is finer than a day, so
          // re-check against the concrete candidate.
          if (!intervalAlignedFine(freq, interval, anchor, cand)) continue;
          return cand;
        }
      }
    }
  }
  return null;
}

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

// Day-granularity alignment (DAILY/WEEKLY/MONTHLY/YEARLY). Sub-day frequencies
// are considered aligned at the day level and refined by intervalAlignedFine.
function intervalAligned(freq: Freq, interval: number, anchor: Date, day: Date): boolean {
  if (interval <= 1) return true;
  switch (freq) {
    case "DAILY":
      return mod(dayNum(day) - dayNum(anchor), interval) === 0;
    case "WEEKLY": {
      const w = (d: Date) => Math.floor((dayNum(d) - d.getDay()) / 7);
      return mod(w(day) - w(anchor), interval) === 0;
    }
    case "MONTHLY": {
      const md = (d: Date) => d.getFullYear() * 12 + d.getMonth();
      return mod(md(day) - md(anchor), interval) === 0;
    }
    case "YEARLY":
      return mod(day.getFullYear() - anchor.getFullYear(), interval) === 0;
    default:
      return true;
  }
}

function intervalAlignedFine(freq: Freq, interval: number, anchor: Date, cand: Date): boolean {
  if (interval <= 1) return true;
  switch (freq) {
    case "SECONDLY":
      return mod(Math.floor((cand.getTime() - anchor.getTime()) / 1000), interval) === 0;
    case "MINUTELY":
      return mod(Math.floor((cand.getTime() - anchor.getTime()) / 60000), interval) === 0;
    case "HOURLY":
      return mod(Math.floor((cand.getTime() - anchor.getTime()) / 3600000), interval) === 0;
    default:
      return true;
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
