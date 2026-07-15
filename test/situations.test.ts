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
    { slug: "fold-db-node-dmg", scope_routines: ["*dmg*", "*desktop*", "*fold-app*"] },
    { slug: "other", scope_routines: ["specific-routine"] },
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
