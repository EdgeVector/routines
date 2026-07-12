import { describe, expect, test } from "bun:test";

import { fenceFor, globMatch, type ActiveSituation } from "../src/situations.ts";

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
