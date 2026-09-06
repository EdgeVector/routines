#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist/probes bin
bun build src/cli.ts --compile --outfile "dist/routines"
chmod 755 "dist/routines"

# ── Stable code identity for macOS privacy (TCC) ─────────────────────────────
# routinesd is the parent of every routine agent, so macOS attributes each file
# access to the responsible process `routines` and asks the owner:
#   "routines would like to access files in your Desktop folder".
# The dialog also BLOCKS the command until a human clicks it, which is the cause
# of the recorded "find $HOME hung past 15 min" routine stalls.
#
# `bun build --compile` emits an ad-hoc, linker-signed binary (Identifier=a.out),
# and host-track installs it at a content-hashed path. TCC keys a grant to that
# code identity, so every new version was a new app with no grants and the
# dialogs came back after each upgrade.
#
# A Developer ID signature with a FIXED identifier gives every build the same
# designated requirement:
#   identifier "com.edgevector.routines" and anchor apple generic
#   and ... certificate leaf[subject.OU] = <team>
# One answer from the owner then survives every later version.
#
# Sign here, at build time, and never in host-track post-install: host-track
# re-hashes each installed file against the published manifest on every refresh
# (artifact_version_needs_restage), so a post-install edit would look like tree
# corruption and trigger a restage loop every 20 minutes.
#
# No hardened runtime: the bun-compiled binary needs JIT, and this artifact is
# installed locally, not notarized. Signing is best effort — a build host with
# no identity still publishes a working ad-hoc binary.
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign_identity="${ROUTINES_CODESIGN_IDENTITY:-Developer ID Application}"
  if security find-identity -v -p codesigning 2>/dev/null | grep -q "$codesign_identity"; then
    # Identity present is not enough: a locked login keychain returns
    # errSecInternalComponent (rc=51) from codesign and used to fail the whole
    # gate. Signing stays best-effort unless ROUTINES_REQUIRE_CODESIGN=1.
    if codesign --force --identifier com.edgevector.routines \
      --sign "$codesign_identity" "dist/routines" \
      && codesign --verify --strict "dist/routines" \
      && "./dist/routines" --version >/dev/null; then
      echo "build-artifact: signed dist/routines as com.edgevector.routines ($codesign_identity)"
    else
      echo "build-artifact: codesign failed (keychain locked or identity unusable);" \
        "shipping ad-hoc — unlock the login keychain or set ROUTINES_REQUIRE_CODESIGN=1" >&2
      if [ "${ROUTINES_REQUIRE_CODESIGN:-0}" = "1" ]; then
        echo "build-artifact: ROUTINES_REQUIRE_CODESIGN=1 and codesign failed" >&2
        exit 1
      fi
    fi
  else
    echo "build-artifact: no codesigning identity matching '$codesign_identity';" \
      "shipping ad-hoc — macOS will re-prompt for file access after each install" >&2
    # The publish host is expected to hold the identity. Set this on that host
    # so a silent loss of the signature fails the build instead of quietly
    # restoring the prompt storm.
    if [ "${ROUTINES_REQUIRE_CODESIGN:-0}" = "1" ]; then
      echo "build-artifact: ROUTINES_REQUIRE_CODESIGN=1 and no identity found" >&2
      exit 1
    fi
  fi
fi
# Scheduled probes and zero-LLM gates cannot depend on a source checkout.
# .lastgit/artifacts.json ships only bin/ and dist/, and portals contain no
# product source, so publish every installable shell entry point beside the
# compiled CLI. scripts/install-shim.sh resolves the same names from
# dist/probes/ when scripts/ is absent, which keeps the ~/.local/bin gate
# symlinks pointing at a path the artifact actually contains.
for probe in \
  kanban-stress.sh \
  north-star-rollup-gate.sh \
  cloud-sync-health-fix-gate.sh \
  lastdb-local-smoke-gate.sh \
  llms-txt-install-smoke-gate.sh
do
  cp "scripts/$probe" "dist/probes/$probe"
  chmod 755 "dist/probes/$probe"
done
# Host-track requires non-empty bin/; ship a thin launcher that execs dist.
cat > "bin/routines" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
exec "$root/dist/routines" "$@"
SH
chmod 755 "bin/routines"
