import { describe, expect, test } from "bun:test";

import { nextAfter, parseRRule, RRuleError } from "../src/rrule.ts";

describe("parseRRule", () => {
  test("parses the full live dialect", () => {
    const r = parseRRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=8;BYMINUTE=10;BYSECOND=0");
    expect(r.freq).toBe("WEEKLY");
    expect(r.byday).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.byhour).toEqual([8]);
    expect(r.byminute).toEqual([10]);
    expect(r.bysecond).toEqual([0]);
    expect(r.interval).toBe(1);
  });

  test("defaults interval to 1", () => {
    expect(parseRRule("FREQ=DAILY").interval).toBe(1);
  });

  test("rejects missing FREQ", () => {
    expect(() => parseRRule("INTERVAL=2")).toThrow(RRuleError);
  });

  test("rejects bad FREQ / BYDAY / key", () => {
    expect(() => parseRRule("FREQ=FORTNIGHTLY")).toThrow(RRuleError);
    expect(() => parseRRule("FREQ=WEEKLY;BYDAY=XX")).toThrow(RRuleError);
    expect(() => parseRRule("FREQ=DAILY;BOGUS=1")).toThrow(RRuleError);
    expect(() => parseRRule("FREQ=DAILY;BYHOUR=99")).toThrow(RRuleError);
  });
});

describe("nextAfter", () => {
  test("weekly-all-days at 08:10:00 behaves like daily-at-time", () => {
    const r = parseRRule("FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;BYHOUR=8;BYMINUTE=10;BYSECOND=0");
    const after = new Date(2026, 6, 12, 7, 0, 0); // 2026-07-12 07:00 local
    const n = nextAfter(r, after);
    expect(n).not.toBeNull();
    expect(n!.getTime()).toBe(new Date(2026, 6, 12, 8, 10, 0).getTime());

    // strictly-after: exactly at fire time returns the next day
    const n2 = nextAfter(r, new Date(2026, 6, 12, 8, 10, 0));
    expect(n2!.getTime()).toBe(new Date(2026, 6, 13, 8, 10, 0).getTime());
  });

  test("specific weekday only", () => {
    const r = parseRRule("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0");
    const after = new Date(2026, 6, 12, 10, 0, 0);
    const n = nextAfter(r, after);
    expect(n).not.toBeNull();
    expect(n!.getDay()).toBe(1); // Monday
    expect(n!.getHours()).toBe(9);
    expect(n!.getMinutes()).toBe(0);
    expect(n!.getTime()).toBeGreaterThan(after.getTime());
  });

  test("hourly interval aligned to explicit DTSTART", () => {
    const r = parseRRule("DTSTART=20260712T000000;FREQ=HOURLY;INTERVAL=3");
    const n = nextAfter(r, new Date(2026, 6, 12, 1, 30, 0));
    // 00, 03, 06, ... -> first after 01:30 is 03:00
    expect(n!.getTime()).toBe(new Date(2026, 6, 12, 3, 0, 0).getTime());
  });

  test("minutely fires at the next minute boundary", () => {
    const r = parseRRule("FREQ=MINUTELY");
    const n = nextAfter(r, new Date(2026, 6, 12, 10, 0, 30));
    expect(n!.getTime()).toBe(new Date(2026, 6, 12, 10, 1, 0).getTime());
  });

  test("secondly fires at the next second", () => {
    const r = parseRRule("FREQ=SECONDLY");
    const n = nextAfter(r, new Date(2026, 6, 12, 10, 0, 0, 500));
    expect(n!.getTime()).toBe(new Date(2026, 6, 12, 10, 0, 1).getTime());
  });

  test("daily at a fixed time", () => {
    const r = parseRRule("FREQ=DAILY;BYHOUR=9;BYMINUTE=30;BYSECOND=0");
    const n = nextAfter(r, new Date(2026, 6, 12, 12, 0, 0));
    expect(n!.getTime()).toBe(new Date(2026, 6, 13, 9, 30, 0).getTime());
  });
});
