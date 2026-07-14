// Logical groupings for the routines fleet. Groups are a dashboard/CLI
// presentation concern: they do not affect scheduling. Assignment is
// heuristic by routine id, with an optional registry `group = "..."` override.

export interface RoutineGroup {
  /** Stable id (slug). Used in API rows and optional registry overrides. */
  id: string;
  /** Human label shown as a section header. */
  label: string;
  /** One-line description for the section header subtitle. */
  blurb: string;
  /** Sort order (lower first). */
  order: number;
}

/** Canonical catalog, ordered for display. */
export const GROUPS: readonly RoutineGroup[] = [
  {
    id: "board",
    label: "Board pipeline",
    blurb: "Kanban pickup, watch, validate, groom, program driver, open PRs",
    order: 10,
  },
  {
    id: "brain",
    label: "Brain & knowledge",
    blurb: "Consolidate, capture, morning sync, papercuts, retros, owner review",
    order: 20,
  },
  {
    id: "dogfood",
    label: "Dogfood",
    blurb: "Product dogfood loops and LastDB local smoke canary",
    order: 30,
  },
  {
    id: "hygiene",
    label: "Machine hygiene",
    blurb: "Disk, worktrees, tokens, stale agent memory, teardown",
    order: 40,
  },
  {
    id: "quality",
    label: "Quality & observability",
    blurb: "Perf guards, stress, Sentry triage, telemetry dashboards",
    order: 50,
  },
  {
    id: "product",
    label: "Product canaries",
    blurb: "External product pipeline / growth canaries",
    order: 60,
  },
  {
    id: "smoke",
    label: "Harness smoke",
    blurb: "One-shot claude / codex / grok adapter verification",
    order: 70,
  },
  {
    id: "other",
    label: "Other",
    blurb: "Uncategorized routines",
    order: 90,
  },
] as const;

const BY_ID = new Map(GROUPS.map((g) => [g.id, g]));

export function isGroupId(value: string): boolean {
  return BY_ID.has(value);
}

export function groupById(id: string): RoutineGroup {
  return BY_ID.get(id) ?? BY_ID.get("other")!;
}

/** Exact id → group. Keep this tight; fall through to pattern rules. */
const EXACT: Record<string, string> = {
  // Board pipeline
  "last-stack-kanban-pickup": "board",
  "last-stack-kanban-watch": "board",
  "last-stack-kanban-validate": "board",
  "last-stack-groom-board": "board",
  "last-stack-program-driver": "board",
  "last-stack-drain-open-prs": "board",

  // Brain & knowledge
  "last-stack-consolidate-brain": "brain",
  "capture-knowledge-to-brain": "brain",
  "last-stack-morning-sync": "brain",
  "last-stack-papercut-sweep": "brain",
  "last-stack-self-improvement-loop": "brain",
  "owner-review-rotate": "brain",
  "daily-retro-prevention": "brain",
  "canonicalize-daily": "brain",

  // Dogfood
  "dogfood-rotate": "dogfood",
  "dogfood-kanban": "dogfood",
  "dogfood-onboarding": "dogfood",
  "lastdb-local-smoke-test": "dogfood",

  // Machine hygiene
  "last-stack-disk-reclaim": "hygiene",
  "last-stack-worktree-cleanup": "hygiene",
  "weekly-token-hygiene": "hygiene",
  "codex-stale-agent-memory-cleanup": "hygiene",
  "teardown-rotate": "hygiene",

  // Quality & observability
  "db-perf-guard": "quality",
  "brain-stress-consistency": "quality",
  "sentry-triage": "quality",
  "lastdbd-mini-telemetry-dashboard-refresh": "quality",

  // Product canaries
  "coderings-capstone-exerciser": "product",
  "coderings-weekly-fold": "product",

  // Harness smoke
  "smoke-claude": "smoke",
  "smoke-codex": "smoke",
  "smoke-grok": "smoke",
};

/** Pattern rules applied when no exact match (order matters — first win). */
const PATTERNS: Array<{ re: RegExp; group: string }> = [
  { re: /(?:f)?kanban|groom-board|program-driver|drain-open-prs/, group: "board" },
  {
    re: /consolidat.*brain|capture-knowledge|morning-sync|papercut|self-improvement|owner-review|retro-prevention|canonicalize/,
    group: "brain",
  },
  { re: /^dogfood|lastdb-local-smoke/, group: "dogfood" },
  {
    re: /disk-reclaim|worktree-cleanup|token-hygiene|agent-memory-cleanup|teardown/,
    group: "hygiene",
  },
  { re: /db-perf|brain-stress|sentry|telemetry/, group: "quality" },
  { re: /coderings/, group: "product" },
  { re: /^smoke-/, group: "smoke" },
];

/**
 * Resolve the display group for a routine id.
 * @param id routine id
 * @param override optional registry `group` value (must be a known group id)
 */
export function groupForId(id: string, override?: string | null): RoutineGroup {
  if (override && isGroupId(override)) return groupById(override);
  const exact = EXACT[id];
  if (exact) return groupById(exact);
  for (const { re, group } of PATTERNS) {
    if (re.test(id)) return groupById(group);
  }
  return groupById("other");
}

/** Compare two routines for grouped display: group order, then id. */
export function compareGrouped(
  a: { groupId: string; id: string },
  b: { groupId: string; id: string },
): number {
  const ao = groupById(a.groupId).order;
  const bo = groupById(b.groupId).order;
  if (ao !== bo) return ao - bo;
  return a.id.localeCompare(b.id);
}
