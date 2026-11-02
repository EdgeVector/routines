#!/usr/bin/env sh
# Installation and service hooks belong to the signed registry manifest.
set -eu
exec "$HOME/.local/bin/lastdb" app install routines "$@"
