#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist/probes bin
bun build src/cli.ts --compile --outfile "dist/routines"
chmod 755 "dist/routines"
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
