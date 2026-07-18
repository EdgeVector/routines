#!/usr/bin/env bash
# Product proof: same-run harness fallback continues work when Codex is out of credits.
# Exit 0 and print a line matching /^PASS/ on success.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.bun/bin:${PATH:-}"

echo "proof: running fallback unit + integration tests"
bun test test/fallback.test.ts test/harness-outage.test.ts test/runner.test.ts

echo "proof: simulating codex usage-limit → claude success via CLI harnesses"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fallback-proof.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

export ROUTINES_HOME="$TMP"
export ROUTINES_ALLOW_HARNESS_BIN_OVERRIDES=1
export ROUTINES_SIGKILL_GRACE_MS=50
mkdir -p "$TMP/registry" "$TMP/bin"

CODEX_LIMIT='ERROR: You'\''ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 22nd, 2026 10:00 PM.'

cat > "$TMP/bin/codex" <<'SH'
#!/bin/sh
printf '%s\n' "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 22nd, 2026 10:00 PM." >&2
exit 1
SH
cat > "$TMP/bin/claude" <<'SH'
#!/bin/sh
printf '%s\n' 'proof-fallback 2026-07-18T00:00:00Z ok GREEN findings=0'
exit 0
SH
cat > "$TMP/bin/grok" <<'SH'
#!/bin/sh
exit 99
SH
cat > "$TMP/bin/situations" <<'SH'
#!/bin/sh
exit 0
SH
cat > "$TMP/bin/ra" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$TMP/bin"/*

export ROUTINES_CODEX_BIN="$TMP/bin/codex"
export ROUTINES_CLAUDE_BIN="$TMP/bin/claude"
export ROUTINES_GROK_BIN="$TMP/bin/grok"
export ROUTINES_SITUATIONS_CLI="$TMP/bin/situations"
export ROUTINES_RA_BIN="$TMP/bin/ra"

cat > "$TMP/registry/proof-fallback.toml" <<'EOF'
harness = "codex"
model = "gpt-5.5"
rrule = "FREQ=HOURLY"
prompt = "proof"
timeout_min = 0.5
EOF

bun -e '
import { loadEntry } from "./src/registry.ts";
import { runRoutine } from "./src/runner.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const entry = loadEntry("proof-fallback");
const result = await runRoutine(entry, { quiet: true, trigger: "scheduled" });
const meta = JSON.parse(readFileSync(join(result.runDir, "meta.json"), "utf8"));
const toml = readFileSync(join(process.env.ROUTINES_HOME!, "registry", "proof-fallback.toml"), "utf8");

if (result.exitCode !== 0) {
  console.error("FAIL exit", result.exitCode, result.outcome);
  process.exit(1);
}
if (meta.harness !== "claude" || meta.usedFallback !== true) {
  console.error("FAIL expected claude fallback", meta);
  process.exit(1);
}
if (!toml.includes("harness = \"codex\"")) {
  console.error("FAIL TOML was rewritten", toml);
  process.exit(1);
}
console.log("PASS harness-fallback-chain: codex outage → claude/" + meta.model + " same-run; TOML still codex");
'
