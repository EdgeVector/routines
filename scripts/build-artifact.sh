#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist bin
bun build src/cli.ts --compile --outfile "dist/routines"
chmod 755 "dist/routines"
# Host-track requires non-empty bin/; ship a thin launcher that execs dist.
cat > "bin/routines" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
exec "$root/dist/routines" "$@"
SH
chmod 755 "bin/routines"
