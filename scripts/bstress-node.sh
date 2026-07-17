#!/usr/bin/env bash
# Ephemeral LastDB node lifecycle helper for brain stress routines.
#
# The helper persists node state in a fixed file so separate harness steps can
# launch, wait, stop, relaunch, and tear down the same isolated /tmp node.

set -o pipefail

STATE="${BSTRESS_STATE:-/tmp/bstress-state.env}"
FOLD_ROOT="${BSTRESS_FOLD_ROOT:-/Users/tomtang/code/edgevector/fold}"
DEFAULT_BIN="$FOLD_ROOT/fold_db_node/src/server/static-react/src-tauri/binaries/lastdb_server-aarch64-apple-darwin"
BIN_TRIED=""

_resolve_bin() {
  local c
  for c in "${BSTRESS_BIN:-}" \
           "/opt/homebrew/bin/lastdbd" \
           "$HOME/.lastdb/bin-with-upload-cap/lastdbd" \
           "$FOLD_ROOT/target/release/lastdbd" \
           "$FOLD_ROOT/target/debug/lastdbd" \
           "$DEFAULT_BIN" \
           "$FOLD_ROOT/target/release/lastdb_server" \
           "$FOLD_ROOT/target/debug/lastdb_server"; do
    [ -n "$c" ] || continue
    BIN_TRIED="$BIN_TRIED${BIN_TRIED:+, }$c"
    if [ -x "$c" ]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

_slugify_run_id() {
  local raw="$1" slug
  slug=$(printf '%s' "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^bstress-//; s/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')
  [ -n "$slug" ] && printf '%s\n' "$slug" || printf 'run\n'
}

_load() {
  [ -f "$STATE" ] && . "$STATE" || true
}

_write_state() {
  local tmp="$STATE.tmp.$$"
  {
    printf 'HOME_DIR=%q\n' "${HOME_DIR:-}"
    printf 'SOCK=%q\n' "${SOCK:-}"
    printf 'BIN=%q\n' "${BIN:-}"
    printf 'LOG=%q\n' "${LOG:-}"
    printf 'FKCONFIG=%q\n' "${FKCONFIG:-}"
    printf 'NODE_PID=%q\n' "${NODE_PID:-}"
    printf 'RUN=%q\n' "${RUN:-}"
    printf 'SLUG_RUN_ID=%q\n' "${SLUG_RUN_ID:-}"
  } >"$tmp" && mv -f "$tmp" "$STATE"
}

_launch_proc() {
  FOLDDB_HOME="$HOME_DIR" LASTDB_HOME="$HOME_DIR" \
  FOLDDB_DISABLE_KEYCHAIN=1 FOLDDB_PASSPHRASE="delmar" \
    nohup "$BIN" --data-dir "$HOME_DIR" >>"$LOG" 2>&1 &
  NODE_PID=$!
  disown "$NODE_PID" 2>/dev/null || true
}

_wait_ready() {
  local secs="${1:-30}" i r
  for i in $(seq 1 "$secs"); do
    if [ -S "$SOCK" ]; then
      r=$(curl -s --max-time 3 --unix-socket "$SOCK" http://localhost/api/system/status 2>/dev/null)
      if [ -n "$r" ]; then
        echo "bstress: ready=1 after=${i}s"
        return 0
      fi
    fi
    if [ -n "${NODE_PID:-}" ] && ! kill -0 "$NODE_PID" 2>/dev/null; then
      echo "bstress: ready=0 node_died_pid=$NODE_PID"
      tail -15 "$LOG" 2>/dev/null
      return 2
    fi
    /bin/sleep 1
  done
  echo "bstress: ready=0 timeout=${secs}s"
  return 1
}

_stop_pid() {
  local pid="$1" grace="${2:-20}" i
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 "$grace"); do
    kill -0 "$pid" 2>/dev/null || return 0
    /bin/sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
  /bin/sleep 1
}

cmd="${1:-}"
shift 2>/dev/null || true

case "$cmd" in
  statefile)
    echo "$STATE"
    ;;

  launch)
    BIN="$(_resolve_bin)"
    if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
      echo "bstress: error=bin_missing tried=$BIN_TRIED"
      exit 3
    fi
    HOME_DIR="/tmp/bs$$_$RANDOM"
    case "$HOME_DIR" in
      /tmp/bs*) ;;
      *) echo "bstress: error=refuse_home home=$HOME_DIR"; exit 3 ;;
    esac
    case "$HOME_DIR" in
      "$HOME/.folddb"*|"$HOME/.lastdb"*) echo "bstress: error=refuse_real_profile"; exit 3 ;;
    esac
    SOCK="$HOME_DIR/data/folddb.sock"
    LOG="$HOME_DIR/node.log"
    FKCONFIG="$HOME_DIR/kanban-config.json"
    RUN=""
    SLUG_RUN_ID=""
    mkdir -p "$HOME_DIR/data"
    _launch_proc
    _write_state
    echo "bstress: launched pid=$NODE_PID home=$HOME_DIR sock=$SOCK"
    echo "bstress: statefile=$STATE"
    ;;

  wait-ready)
    _load
    _wait_ready "${1:-30}"
    exit $?
    ;;

  set-run)
    _load
    RUN="${1:?run-id required}"
    SLUG_RUN_ID="$(_slugify_run_id "$RUN")"
    _write_state
    echo "bstress: run=$RUN"
    echo "bstress: slug_run_id=$SLUG_RUN_ID"
    ;;

  set-slug-run)
    _load
    SLUG_RUN_ID="$(_slugify_run_id "${1:?slug run-id required}")"
    _write_state
    echo "bstress: slug_run_id=$SLUG_RUN_ID"
    ;;

  get-slug-run)
    _load
    printf '%s\n' "${SLUG_RUN_ID:-}"
    ;;

  stop)
    _load
    echo "bstress: stopping pid=${NODE_PID:-}"
    _stop_pid "${NODE_PID:-}"
    [ -S "$SOCK" ] && echo "bstress: warn socket_still_present=$SOCK" || echo "bstress: socket_gone=1"
    ;;

  relaunch)
    _load
    if [ -z "${HOME_DIR:-}" ]; then
      echo "bstress: error=no_state"
      exit 3
    fi
    _launch_proc
    _write_state
    echo "bstress: relaunched pid=$NODE_PID home=$HOME_DIR"
    ;;

  teardown)
    _load
    _stop_pid "${NODE_PID:-}"
    if [ -n "${HOME_DIR:-}" ]; then
      for p in $(pgrep -f "$HOME_DIR" 2>/dev/null); do
        if ps -p "$p" -o command= 2>/dev/null | grep -q -- "$HOME_DIR"; then
          echo "bstress: reaping stray pid=$p"
          kill -9 "$p" 2>/dev/null || true
        fi
      done
      case "$HOME_DIR" in
        /tmp/bs*) rm -rf "$HOME_DIR" && echo "bstress: removed_home=$HOME_DIR" ;;
        *) echo "bstress: refuse_rm home=$HOME_DIR" ;;
      esac
    fi
    rm -f "$STATE"
    if [ -S "$HOME/.folddb/data/folddb.sock" ]; then
      echo "bstress: primary_brain=present_untouched"
    else
      echo "bstress: primary_brain=not_socket(ok if brain not running)"
    fi
    echo "bstress: teardown=done"
    ;;

  get)
    _load
    key="${1:?key required}"
    eval "printf '%s\n' \"\${$key:-}\""
    ;;

  env)
    _load
    for k in HOME_DIR SOCK BIN LOG FKCONFIG NODE_PID RUN SLUG_RUN_ID; do
      eval "printf 'export %s=%q\n' \"$k\" \"\${$k:-}\""
    done
    ;;

  *)
    echo "usage: bstress-node.sh {launch|wait-ready [secs]|set-run <id>|set-slug-run <id>|stop|relaunch|teardown|statefile|get <KEY>|get-slug-run|env}" >&2
    exit 64
    ;;
esac
