#!/usr/bin/env bash
# Replace the two temporary launchd jobs with one routines-owned controller.
# Default is proof-only. --apply is deliberately explicit and only proceeds
# after the controller's dry-run can read an enabled, fresh policy.
set -euo pipefail

MODE=dry-run
[ "${1:-}" = "--apply" ] && MODE=apply

ROUTINES_BIN="${ROUTINES_BIN:-$(command -v routines || true)}"
[ -n "$ROUTINES_BIN" ] || { echo "routines CLI not found; set ROUTINES_BIN to an absolute path" >&2; exit 1; }
case "$ROUTINES_BIN" in /*) ;; *) echo "ROUTINES_BIN must be absolute for launchd: $ROUTINES_BIN" >&2; exit 1 ;; esac
LABEL="com.edgevector.routines-capacity-controller"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NOW="$(id -u)"

echo "capacity migration: proving controller before retiring legacy jobs"
"$ROUTINES_BIN" capacity-controller --dry-run --json

if [ "$MODE" != apply ]; then
  echo "DRY-RUN: proof passed; would install $LABEL and retire:"
  echo "  com.edgevector.vacation-capacity-pilot"
  echo "  com.edgevector.last-stack-idle-ladder"
  echo "Re-run with --apply after reviewing the dry-run decisions."
  exit 0
fi

mkdir -p "$(dirname "$PLIST")" "$HOME/.routines/logs"
TMP_PLIST="$(mktemp)"
trap 'rm -f "$TMP_PLIST"' EXIT
cat >"$TMP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$ROUTINES_BIN</string><string>capacity-controller</string><string>--json</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.routines/logs/capacity-controller.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.routines/logs/capacity-controller.err.log</string>
</dict></plist>
EOF
plutil -lint "$TMP_PLIST"
cp "$TMP_PLIST" "$PLIST"
launchctl bootout "gui/$UID_NOW/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NOW" "$PLIST"

# Only retire the temporary jobs after the replacement is loaded.
launchctl print "gui/$UID_NOW/$LABEL" >/dev/null
for old in com.edgevector.vacation-capacity-pilot com.edgevector.last-stack-idle-ladder; do
  launchctl bootout "gui/$UID_NOW/$old" 2>/dev/null || true
done
echo "capacity migration: installed $LABEL; temporary jobs retired"
