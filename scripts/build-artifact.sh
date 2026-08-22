#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist/probes bin
bun build src/cli.ts --compile --outfile "dist/routines"
chmod 755 "dist/routines"
# Scheduled probes cannot depend on a source checkout. Portals contain no
# product source, so publish the versioned harness beside the compiled CLI.
cp "scripts/kanban-stress.sh" "dist/probes/kanban-stress.sh"
chmod 755 "dist/probes/kanban-stress.sh"
# Host-track requires non-empty bin/; ship a thin launcher that execs dist.
cat > "bin/routines" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
exec "$root/dist/routines" "$@"
SH
chmod 755 "bin/routines"
