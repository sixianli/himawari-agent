#!/bin/bash
set -euo pipefail
usage() {
  echo "usage: bash $0 mac|hermes <root>... | remove-mac | remove-hermes" >&2
  exit 64
}
[[ "$#" -ge 1 ]] || usage
mode="$1"
shift
here="$(cd "$(dirname "$0")" && pwd)"
share="$HOME/.local/share/himawari"
copy="$share/prune-rebuildable.py"
label="com.himawari.prune-rebuildable"
plist="$HOME/Library/LaunchAgents/$label.plist"
marker="# himawari-prune-rebuildable"

remove_cron() {
  { crontab -l 2>/dev/null || true; } | { grep -vF "$marker" || true; } | crontab -
}

case "$mode" in
  remove-mac)
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "PRUNE_SCHEDULE_REMOVED mac"
    exit 0
    ;;
  remove-hermes)
    remove_cron
    echo "PRUNE_SCHEDULE_REMOVED hermes"
    exit 0
    ;;
  mac|hermes) ;;
  *) usage ;;
esac

[[ "$#" -ge 1 ]] || usage
roots=()
for root in "$@"; do
  [[ -d "$root" ]] || { echo "PRUNE_SCHEDULE_ROOT_MISSING $root" >&2; exit 2; }
  roots+=("$(cd "$root" && pwd)")
done
mkdir -p "$share"
install -m 0644 "$here/prune-rebuildable.py" "$copy"
/usr/bin/python3 -I "$copy" "${roots[@]}" | tail -n 1

if [[ "$mode" == mac ]]; then
  log="$HOME/Library/Logs/himawari-prune-rebuildable.log"
  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "<key>Label</key><string>$label</string>"
    echo '<key>ProgramArguments</key><array>'
    for argument in /usr/bin/python3 -I "$copy" --apply --skip-if-busy "${roots[@]}"; do
      echo "<string>$argument</string>"
    done
    echo '</array>'
    echo '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>'
    echo "<key>StandardOutPath</key><string>$log</string>"
    echo "<key>StandardErrorPath</key><string>$log</string>"
    echo '</dict></plist>'
  } > "$plist"
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "PRUNE_SCHEDULE_INSTALLED mac $plist log=$log"
else
  log="$HOME/.local/state/himawari/prune-rebuildable.log"
  mkdir -p "$(dirname "$log")"
  quoted=""
  for root in "${roots[@]}"; do quoted+=" $(printf '%q' "$root")"; done
  line="0 4 * * * /usr/bin/python3 -I $(printf '%q' "$copy") --apply --skip-if-busy$quoted >> $(printf '%q' "$log") 2>&1 $marker"
  { { crontab -l 2>/dev/null || true; } | { grep -vF "$marker" || true; }; echo "$line"; } | crontab -
  echo "PRUNE_SCHEDULE_INSTALLED hermes log=$log"
fi
