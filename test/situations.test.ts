import { describe, expect, test } from "bun:test";

import {
  fenceFor,
  formatNoticesBanner,
  globMatch,
  type ActiveSituation,
  type RecentNotice,
} from "../src/situations.ts";

describe("globMatch", () => {
  test("wildcards", () => {
    expect(globMatch("*dmg*", "fold-remove-dmg-machinery")).toBe(true);
    expect(globMatch("*desktop*", "test-desktop-fence")).toBe(true);
    expect(globMatch("*dmg*", "disk-reclaim")).toBe(false);
    expect(globMatch("exact", "exact")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "ac")).toBe(false);
  });

  test("escapes regex metacharacters", () => {
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("a.b", "a.b")).toBe(true);
  });
});

describe("fenceFor", () => {
  const situations: ActiveSituation[] = [
    { slug: "fold-db-node-dmg", scope_routines: ["*dmg*", "*desktop*", "*fold-app*"], severity: "p1" },
    { slug: "other", scope_routines: ["specific-routine"], severity: "p0" },
  ];

  test("matches a scoped routine", () => {
    const r = fenceFor("nightly-desktop-dogfood", situations);
    expect(r.fenced).toBe(true);
    expect(r.situationSlug).toBe("fold-db-node-dmg");
    expect(r.pattern).toBe("*desktop*");
  });

  test("passes an unscoped routine", () => {
    expect(fenceFor("disk-reclaim", situations).fenced).toBe(false);
  });

  test("exact match in a second situation", () => {
    expect(fenceFor("specific-routine", situations).situationSlug).toBe("other");
  });

  // papercut-routines-fence-ignores-blocked-actions-scope-routines-hard-skip-20261001:
  // a p2 Situation naming a routine in scope_routines for context (not as a
  // real block — its blocked_actions never named the routine) hard-fenced
  // last-stack-milestone-driver and last-stack-north-star-driver for 2+ days.
  test("a p2 situation does not fence (informational scope only)", () => {
    const informational: ActiveSituation[] = [
      { slug: "brain-cleanout-note", scope_routines: ["last-stack-milestone-driver"], severity: "p2" },
    ];
    expect(fenceFor("last-stack-milestone-driver", informational).fenced).toBe(false);
  });

  test("a p3 situation does not fence either", () => {
    const informational: ActiveSituation[] = [
      { slug: "low-priority-note", scope_routines: ["some-routine"], severity: "p3" },
    ];
    expect(fenceFor("some-routine", informational).fenced).toBe(false);
  });

  test("p0 and p1 situations still fence (real incidents, defense in depth)", () => {
    const p0: ActiveSituation[] = [{ slug: "forge-primary-down", scope_routines: ["last-stack-merge-babysit"], severity: "p0" }];
    const p1: ActiveSituation[] = [{ slug: "harness-outage-codex", scope_routines: ["last-stack-fkanban-pickup"], severity: "p1" }];
    expect(fenceFor("last-stack-merge-babysit", p0).fenced).toBe(true);
    expect(fenceFor("last-stack-fkanban-pickup", p1).fenced).toBe(true);
  });

  test("a situation with no severity set still fences (fail-safe default)", () => {
    const noSeverity: ActiveSituation[] = [{ slug: "legacy-record", scope_routines: ["any-routine"], severity: "" }];
    expect(fenceFor("any-routine", noSeverity).fenced).toBe(true);
  });
});

describe("formatNoticesBanner", () => {
  test("empty list is explicit", () => {
    const banner = formatNoticesBanner([], "2h");
    expect(banner).toContain("No notices in the last 2h");
    expect(banner).toContain("non-blocking");
  });

  test("lists kind/title/at", () => {
    const notices: RecentNotice[] = [
      {
        slug: "notice-upgrade-lastdb",
        kind: "upgrade",
        title: "LastDB upgraded to 0.22.8",
        at: "2026-07-14T19:12:03.000Z",
        summary: "brief blips expected",
        scope_systems: ["lastdbd"],
      },
    ];
    const banner = formatNoticesBanner(notices, "1h");
    expect(banner).toContain("[upgrade]");
    expect(banner).toContain("notice-upgrade-lastdb");
    expect(banner).toContain("LastDB upgraded to 0.22.8");
    expect(banner).toContain("systems=lastdbd");
  });
});
