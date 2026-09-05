#!/usr/bin/env bash
# Proof for the code-identity step in scripts/build-artifact.sh.
#
# WHY the step exists: routinesd is the parent of every routine agent, so macOS
# attributes file access to `routines` and asks the owner for Desktop/Documents/
# Downloads/Photos. The dialog also blocks the command. `bun --compile` emits an
# ad-hoc binary (Identifier=a.out) installed at a content-hashed path, so each
# version was a new code identity and the grant never survived an upgrade.
#
# This test runs on any host. It exercises the two paths that do not need a real
# certificate: graceful skip, and strict failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SCRIPT="$ROOT/scripts/build-artifact.sh"
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# The identifier must stay fixed. It is the first term of the designated
# requirement that lets one grant cover every later version.
grep -q -- '--identifier com.edgevector.routines' "$SCRIPT" || {
  echo "build-artifact.sh must sign with the fixed identifier com.edgevector.routines" >&2
  exit 1
}

# Never sign inside host-track post-install: host-track re-hashes installed files
# against the published manifest, so an edit after install reads as corruption.
grep -q 'never in host-track post-install' "$SCRIPT" || {
  echo "build-artifact.sh must keep the note about not signing after install" >&2
  exit 1
}

# Extract just the signing block so the test needs no bun build.
block="$tmp/sign-block.sh"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  awk '/^# ── Stable code identity/,/^fi$/' "$SCRIPT"
} > "$block"
chmod 755 "$block"
bash -n "$block"

# Fake tools: a Darwin host whose keychain holds no identity.
mkdir -p "$tmp/bin" "$tmp/dist"
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/codesign"
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/security"   # prints nothing: no identity
printf '#!/bin/sh\necho Darwin\n' > "$tmp/bin/uname"
chmod 755 "$tmp/bin/codesign" "$tmp/bin/security" "$tmp/bin/uname"

# 1. No identity, default mode: the build continues and warns.
out="$(cd "$tmp" && PATH="$tmp/bin:$PATH" bash "$block" 2>&1)" || {
  echo "missing identity must not fail the default build" >&2
  exit 1
}
printf '%s' "$out" | grep -q 'no codesigning identity' || {
  echo "missing identity must warn on stderr" >&2
  exit 1
}
printf '%s' "$out" | grep -q 're-prompt' || {
  echo "the warning must say what the owner will experience" >&2
  exit 1
}

# 2. No identity, strict mode: the build fails loudly.
if (cd "$tmp" && PATH="$tmp/bin:$PATH" ROUTINES_REQUIRE_CODESIGN=1 bash "$block" >/dev/null 2>&1); then
  echo "ROUTINES_REQUIRE_CODESIGN=1 must fail when no identity is found" >&2
  exit 1
fi

# 3. Identity present: the block signs and verifies.
printf '#!/bin/sh\necho "  1) AAAA Developer ID Application: Someone (TEAM1234)"\n' > "$tmp/bin/security"
cat > "$tmp/bin/codesign" <<'STUB'
#!/bin/sh
echo "codesign $*" >> "$CODESIGN_LOG"
exit 0
STUB
chmod 755 "$tmp/bin/security" "$tmp/bin/codesign"
printf '#!/bin/sh\necho 0.0.0-test\n' > "$tmp/dist/routines"
chmod 755 "$tmp/dist/routines"
export CODESIGN_LOG="$tmp/codesign.log"
: > "$CODESIGN_LOG"
out="$(cd "$tmp" && PATH="$tmp/bin:$PATH" bash "$block" 2>&1)"
grep -q -- '--identifier com.edgevector.routines' "$CODESIGN_LOG" || {
  echo "signing path must pass the fixed identifier" >&2; exit 1; }
grep -q -- '--verify --strict' "$CODESIGN_LOG" || {
  echo "signing path must verify the result" >&2; exit 1; }
printf '%s' "$out" | grep -q 'signed dist/routines' || {
  echo "signing path must report what it signed" >&2; exit 1; }

echo "ok build-artifact-codesign"
