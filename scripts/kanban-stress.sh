#!/usr/bin/env bash
# kanban-stress.sh — consistency stress harness for the kanban board over the
# LastDB Unix-socket transport (/Users/tomtang/.folddb/data/folddb.sock).
#
# WHY: after kanban moved to the socket version of LastDB, writes have looked
# inconsistent (acked writes not reading back, flapping reads). This harness
# hammers the REAL socket write path on an ISOLATED scratch board and asserts
# write→read-back consistency, so a regression surfaces as a concrete finding
# instead of a vague "the board feels flaky".
#
# It writes ONLY to a scratch board (default `agent-dogfood-scratch`) using a
# per-run slug prefix, then soft-deletes everything it created. It never touches
# Tom's real `default` board and never restarts/kills the primary folddb_server node.
#
# OUTPUT (stdout, machine-readable):
#   FINDING: <category> | <detail>     ← a real consistency VIOLATION (DB bug)
#   ERROR:   <detail>                  ← transport/harness problem (not a bug,
#                                          but file a card if it reproduces)
#   PARTIAL: <detail>                  ← interrupted before all legs completed
#   SUMMARY: findings=<n> errors=<n> partial=<0|1> board=<b> run=<id>
#
# Exit is ALWAYS 0 — an erroring exit cancels the scheduled-run queue
# (feedback_no_erroring_commands_cancel_queue). The caller reads the report.
#
# Tunables (env): FKANBAN (cli cmd, default `kanban`), KSTRESS_BOARD,
#   KSTRESS_N (cards/batch, default 8), KSTRESS_BURST (concurrent writers, 10).

set -o pipefail

FK="${FKANBAN:-${KANBAN:-fkanban}}"
if ! command -v "$FK" >/dev/null 2>&1 && command -v kanban >/dev/null 2>&1; then
  FK="kanban"
fi
BOARD="${KSTRESS_BOARD:-agent-dogfood-scratch}"
N="${KSTRESS_N:-8}"
BURST="${KSTRESS_BURST:-10}"
RUN="kstress-$(date +%s)-$$"

findings=()
errors=()
created=()
partial=0
cleaned=0

finding() { findings+=("$1 | $2"); printf 'FINDING: %s | %s\n' "$1" "$2"; }
errlog()  { errors+=("$1");        printf 'ERROR: %s\n' "$1"; }
partiallog() { partial=1; printf 'PARTIAL: %s\n' "$1"; }

fkjson() { "$FK" show "$1" --json 2>/dev/null; }            # read-back one card
field()  { fkjson "$1" | jq -r "$2 // empty" 2>/dev/null; } # one field via jq

cleanup_created() {
  [ "$cleaned" = 1 ] && return
  cleaned=1
  if [ "${#created[@]}" -gt 0 ]; then
    for s in "${created[@]}"; do "$FK" rm "$s" >/dev/null 2>&1 || true; done
  fi
}

summary() {
  echo "SUMMARY: findings=${#findings[@]} errors=${#errors[@]} partial=$partial board=$BOARD run=$RUN"
}

interrupted() {
  partiallog "interrupted before all legs completed; cleanup attempted; caller should treat as noop/partial, not a consistency failure"
  errlog "harness interrupted before completion"
  cleanup_created
  summary
  exit 0
}

trap interrupted INT TERM HUP

# ── Preflight ──────────────────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found — cannot assert JSON read-backs"
  echo "SUMMARY: findings=0 errors=1 partial=0 board=$BOARD run=$RUN"
  exit 0
fi
if ! "$FK" board list --json >/dev/null 2>&1; then
  echo "ERROR: node/board unreachable — skipping stress run (retries next schedule)"
  echo "SUMMARY: findings=0 errors=1 partial=0 board=$BOARD run=$RUN"
  exit 0
fi
# Ensure the isolated scratch board exists (no-op if already there).
"$FK" board create "$BOARD" --title "agent dogfood scratch" --columns backlog,todo,doing,done >/dev/null 2>&1 || true

echo "kanban-stress run=$RUN board=$BOARD N=$N burst=$BURST"

# ── 1. create → read-back (xN) ──────────────────────────────────────────────
i=1
while [ "$i" -le "$N" ]; do
  s="$RUN-c$i"; title="stress $RUN card $i"; body="body-$RUN-$i"
  # Capture stdout only — the CLI prints a cosmetic "pickup will skip" warning to
  # stderr that would otherwise corrupt the JSON we parse. A real failure comes
  # back as a JSON error envelope on stdout (or a non-.slug payload).
  # --repo keeps the card pickup-eligible: kanban's add guard hard-rejects a
  # header-less card in `todo` ("not agent-runnable: Missing Repo header"), which
  # would otherwise make every add fail and produce phantom consistency findings.
  res=$("$FK" add "$s" --title "$title" --board "$BOARD" --column todo --tags kstress --repo EdgeVector/fold --body "$body" --json 2>/dev/null)
  if ! printf '%s' "$res" | jq -e '.slug' >/dev/null 2>&1; then
    errlog "add $s did not ACK: $(printf '%s' "$res" | tr '\n' ' ')"
    i=$((i+1)); continue
  fi
  created+=("$s")
  j=$(fkjson "$s")
  if [ -z "$j" ]; then
    finding "lost-write" "$s: add ACKed but show read back nothing"
    i=$((i+1)); continue
  fi
  gt=$(printf '%s' "$j" | jq -r '.title // empty')
  gb=$(printf '%s' "$j" | jq -r '.body // empty')
  gc=$(printf '%s' "$j" | jq -r '.column // empty')
  [ "$gt" = "$title" ] || finding "stale-read-title" "$s: wrote '$title' read '$gt'"
  case "$gb" in *"$body"*) : ;; *) finding "stale-read-body" "$s: wrote '$body' not found in read-back '$gb'" ;; esac
  [ "$gc" = "todo" ]   || finding "wrong-column"     "$s: wrote todo read '$gc'"
  i=$((i+1))
done

# ── 2. update → read-back (no stale read) ───────────────────────────────────
if [ "$N" -ge 1 ]; then
  s="$RUN-c1"; new="updated-$RUN-$(date +%s%N)"
  "$FK" add "$s" --title "$new" --board "$BOARD" --repo EdgeVector/fold >/dev/null 2>&1
  got=$(field "$s" '.title')
  [ "$got" = "$new" ] || finding "stale-read-update" "$s: updated to '$new' but read '$got'"
fi

# ── 3. move → read-back through columns ─────────────────────────────────────
if [ "$N" -ge 1 ]; then
  s="$RUN-c1"
  for col in doing done; do
    "$FK" move "$s" "$col" --force >/dev/null 2>&1
    got=$(field "$s" '.column')
    [ "$got" = "$col" ] || finding "move-not-persisted" "$s: moved to $col but read '$got'"
  done
fi

# ── 4. tag add/rm → read-back ───────────────────────────────────────────────
if [ "$N" -ge 4 ]; then
  s="$RUN-c4"
  "$FK" tag add "$s" zztag1 >/dev/null 2>&1
  field "$s" '.tags[]' | grep -qx zztag1 || finding "tag-add-not-persisted" "$s: tag add zztag1 not read back"
  "$FK" tag rm "$s" zztag1 >/dev/null 2>&1
  if field "$s" '.tags[]' | grep -qx zztag1; then finding "tag-rm-not-persisted" "$s: tag rm zztag1 still present"; fi
fi

# ── 5. read stability (flapping detection) ──────────────────────────────────
if [ "$N" -ge 5 ]; then
  s="$RUN-c5"; a=$(fkjson "$s"); k=1
  while [ "$k" -le 4 ]; do
    b=$(fkjson "$s")
    [ "$a" = "$b" ] || { finding "unstable-read" "$s: consecutive read-backs differ (flapping socket read)"; break; }
    a="$b"; k=$((k+1))
  done
fi

# ── 6. concurrency burst — lost writes under parallel socket writes ─────────
tmp=$(mktemp -d 2>/dev/null || echo "/tmp/kstress.$$"); mkdir -p "$tmp"
i=1
while [ "$i" -le "$BURST" ]; do
  s="$RUN-b$i"
  ( "$FK" add "$s" --title "burst $i $RUN" --board "$BOARD" --column todo --tags kstress --repo EdgeVector/fold --json >"$tmp/b$i.out" 2>/dev/null; echo $? >"$tmp/b$i.rc" ) &
  i=$((i+1))
done
wait
i=1
while [ "$i" -le "$BURST" ]; do
  s="$RUN-b$i"
  rc=$(cat "$tmp/b$i.rc" 2>/dev/null || echo 1)
  ack=$(jq -r '.slug // empty' "$tmp/b$i.out" 2>/dev/null)
  if [ "$rc" != "0" ] || [ -z "$ack" ]; then
    errlog "concurrent add $s failed rc=$rc out=$(tr '\n' ' ' <"$tmp/b$i.out" 2>/dev/null)"
    i=$((i+1)); continue
  fi
  created+=("$s")
  if [ -z "$(field "$s" '.slug')" ]; then
    finding "lost-write-concurrent" "$s: add ACKed (rc0 + slug echoed) but absent on read-back — inconsistent socket write"
  fi
  i=$((i+1))
done

# ── 7. concurrent updates to ONE card — torn write / lost update ────────────
if [ "$N" -ge 2 ]; then
  u="$RUN-c2"; vals=""; i=1
  while [ "$i" -le "$BURST" ]; do
    v="v$i-$RUN"; vals="$vals|$v|"
    ( "$FK" add "$u" --title "$v" --board "$BOARD" --repo EdgeVector/fold >/dev/null 2>&1 ) &
    i=$((i+1))
  done
  wait
  r1=$(field "$u" '.title'); r2=$(field "$u" '.title'); r3=$(field "$u" '.title')
  if [ "$r1" != "$r2" ] || [ "$r2" != "$r3" ]; then
    finding "unstable-read-after-concurrent-update" "$u: reads diverged '$r1'/'$r2'/'$r3' after concurrent updates"
  fi
  case "$vals" in
    *"|$r1|"*) : ;;
    *) finding "torn-write" "$u: final title '$r1' is not any written value — torn/garbled concurrent write" ;;
  esac
fi

rm -rf "$tmp" 2>/dev/null || true

# ── 8. search index consistency (search vs show divergence) ─────────────────
if [ "$N" -ge 6 ]; then
  tok="kdogtok$(date +%s)"
  ss="$RUN-s1"
  "$FK" add "$ss" --title "find me $tok" --board "$BOARD" --column todo --tags kstress --repo EdgeVector/fold >/dev/null 2>&1
  created+=("$ss")
  if ! "$FK" search "$tok" --board "$BOARD" --json --all 2>/dev/null | grep -q "$ss"; then
    if [ -n "$(field "$ss" '.slug')" ]; then
      finding "search-index-divergence" "$ss: readable via show but search('$tok') missed it"
    else
      errlog "search test card $ss not created"
    fi
  fi
fi

# ── 9. delete → read-back (soft-delete consistency) ─────────────────────────
if [ "$N" -ge 3 ]; then
  d="$RUN-c3"
  "$FK" rm "$d" >/dev/null 2>&1
  if [ -n "$(field "$d" '.slug')" ]; then
    finding "delete-not-persisted" "$d: rm ACKed but card still readable via show"
  fi
fi

# ── 10. board-RECORD durability + enumeration consistency ───────────────────
# The 2026-07-05 miss: a live board RECORD vanished from the table while its
# cards survived, so `add`/`requireBoard` hard-failed ("Board default does not
# exist") while card ops kept working — and NOTHING caught it. This leg asserts
# board records persist and read back. Uses a fixed, reused slug set so it never
# grows the board table.
#
# ROBUSTNESS (learned 2026-07-05): `board list --json` can return an EMPTY/partial
# set under heavy node load — an unreliable READ, not a vanished record. If this
# leg naively flagged "missing => vanished", it would cry wolf every build storm
# and recreate the exact false-diagnosis problem it exists to kill. So EVERY
# "missing" verdict is RE-CONFIRMED, and an empty/failed read is a liveness
# ERROR (never a consistency FINDING).
#
# board_state <slug> -> echoes: present | missing | readfail
#   missing is only returned when the slug is absent from TWO independent
#   NON-EMPTY reads (a single non-empty read missing it could be partial).
board_state() {
  local s="$1" a b
  a=$("$FK" board list --json 2>/dev/null | jq -r '[.[]?.slug]|join(",")' 2>/dev/null)
  [ -z "$a" ] && { echo readfail; return; }
  case ",$a," in *",$s,"*) echo present; return;; esac
  b=$("$FK" board list --json 2>/dev/null | jq -r '[.[]?.slug]|join(",")' 2>/dev/null)
  [ -z "$b" ] && { echo readfail; return; }
  case ",$b," in *",$s,"*) echo present; return;; esac
  echo missing
}
bd=(zz-kstress-bd-1 zz-kstress-bd-2 zz-kstress-bd-3)
for b in "${bd[@]}"; do
  "$FK" board create "$b" --title "kstress board-durability" --columns backlog,todo,doing,done >/dev/null 2>&1
  case "$(board_state "$b")" in
    missing)  finding "board-create-not-readback" "$b: board create ACKed but CONFIRMED absent from board list (2 non-empty reads)";;
    readfail) errlog "board list empty/unreadable during create-readback of $b (liveness, not a vanish)";;
  esac
done
# durability across the run's card churn: the created boards + the scratch board
# must still be present (re-confirmed) after all the card writes above.
for b in "${bd[@]}" "$BOARD"; do
  case "$(board_state "$b")" in
    missing)  finding "board-record-vanished" "$b: present-then-CONFIRMED-absent (2 non-empty reads) — the 2026-07-05 failure mode";;
    readfail) errlog "board list empty/unreadable during durability re-check of $b (liveness, not a vanish)";;
  esac
done
# concurrent board-create burst — lost board writes under parallel socket writes
i=0; while [ "$i" -lt 4 ]; do ( "$FK" board create "zz-kstress-bcburst-$i" --title "bc $RUN" --columns backlog,todo,doing,done >/dev/null 2>&1 ) & i=$((i+1)); done; wait
lost=0; rf=0; i=0
while [ "$i" -lt 4 ]; do
  case "$(board_state "zz-kstress-bcburst-$i")" in missing) lost=$((lost+1));; readfail) rf=$((rf+1));; esac
  i=$((i+1))
done
[ "$lost" -gt 0 ] && finding "board-concurrent-lost-write" "$lost/4 boards from a concurrent create burst were CONFIRMED absent afterward"
[ "$rf" -gt 0 ] && errlog "board list unreadable for $rf/4 concurrent-burst re-checks (liveness, not lost writes)"
# clean up the durability + burst boards (fixed slugs → reused next run, table stays bounded)
for b in "${bd[@]}" zz-kstress-bcburst-0 zz-kstress-bcburst-1 zz-kstress-bcburst-2 zz-kstress-bcburst-3; do
  "$FK" board rm "$b" --force >/dev/null 2>&1 || true
done

# ── Cleanup: soft-delete everything this run created ────────────────────────
cleanup_created

summary
exit 0
