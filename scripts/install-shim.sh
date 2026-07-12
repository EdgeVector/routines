#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_bin="$repo_root/bin/routines"

if [ ! -x "$source_bin" ]; then
  chmod +x "$source_bin" 2>/dev/null || true
fi
if [ ! -f "$source_bin" ]; then
  echo "routines shim source not found: $source_bin" >&2
  exit 1
fi

if [ "${ROUTINES_INSTALL_BIN:-}" ]; then
  install_bin=$ROUTINES_INSTALL_BIN
elif [ -d "$HOME/.local/bin" ] || case ":$PATH:" in *":$HOME/.local/bin:"*) true ;; *) false ;; esac; then
  install_bin=$HOME/.local/bin
elif case ":$PATH:" in *":$HOME/bin:"*) true ;; *) false ;; esac; then
  install_bin=$HOME/bin
else
  install_bin=$HOME/.local/bin
fi

mkdir -p "$install_bin"
ln -sf "$source_bin" "$install_bin/routines"

echo "Installed routines shim: $install_bin/routines -> $source_bin"
