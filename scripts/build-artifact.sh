#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
bun build src/cli.ts --compile --outfile dist/routines
chmod 755 dist/routines
