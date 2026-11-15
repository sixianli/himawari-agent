#!/bin/bash
set -euo pipefail
usage() {
  echo "usage: bash $0 mac [--repo DIR [--apply-local]] <root>... | hermes <root>... | remove-mac | remove-hermes" >&2
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
local_copy="$share/prune-local.py"
local_config="$share/retention.json"
local_label="com.himawari.prune-local"
local_plist="$HOME/Library/LaunchAgents/$local_label.plist"
marker="# himawari-prune-rebuildable"

remove_cron() {
  { crontab -l 2>/dev/null || true; } | { grep -vF "$marker" || true; } | crontab -
}

case "$mode" in
  remove-mac)
    for file in "$plist" "$local_plist"; do
      launchctl bootout "gui/$(id -u)" "$file" 2>/dev/null || true
      rm -f "$file"
    done
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

repo=""
apply_local=""
while [[ "$#" -gt 0 && "$1" == --* ]]; do
  case "$1" in
    --repo) [[ "$#" -ge 2 && "$mode" == mac ]] || usage; repo="$2"; shift 2 ;;
    --apply-local) [[ "$mode" == mac ]] || usage; apply_local="--apply"; shift ;;
    *) usage ;;
  esac
done
[[ -z "$apply_local" || -n "$repo" ]] || usage
if [[ -n "$repo" ]]; then
  [[ -d "$repo/.git" || -f "$repo/.git" ]] || { echo "PRUNE_SCHEDULE_REPO_MISSING $repo" >&2; exit 2; }
  repo="$(cd "$repo" && pwd)"
fi
[[ "$#" -ge 1 ]] || usage
roots=()
for root in "$@"; do
  [[ -d "$root" ]] || { echo "PRUNE_SCHEDULE_ROOT_MISSING $root" >&2; exit 2; }
  roots+=("$(cd "$root" && pwd)")
done
mkdir -p "$share"
install -m 0644 "$here/prune-rebuildable.py" "$copy"
/usr/bin/python3 -I "$copy" "${roots[@]}" | tail -n 1
if [[ -n "$repo" ]]; then
  install -m 0644 "$here/prune-local.py" "$local_copy"
  install -m 0644 "$here/retention.json" "$local_config"
  preview=(/usr/bin/python3 -I "$local_copy" --config "$local_config" --repo "$repo" --tmp "${TMPDIR:-/tmp}")
  local_arguments=("${preview[@]}" --skip-if-busy)
  [[ -z "$apply_local" ]] || local_arguments+=("$apply_local")
  "${preview[@]}"
fi

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
  if [[ -n "$repo" ]]; then
    local_log="$HOME/Library/Logs/himawari-prune-local.log"
    {
      echo '<?xml version="1.0" encoding="UTF-8"?>'
      echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
      echo '<plist version="1.0"><dict>'
      echo "<key>Label</key><string>$local_label</string>"
      echo '<key>ProgramArguments</key><array>'
      for argument in "${local_arguments[@]}"; do
        echo "<string>$argument</string>"
      done
      echo '</array>'
      echo '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>10</integer></dict>'
      echo "<key>StandardOutPath</key><string>$local_log</string>"
      echo "<key>StandardErrorPath</key><string>$local_log</string>"
      echo '</dict></plist>'
    } > "$local_plist"
    launchctl bootout "gui/$(id -u)" "$local_plist" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$local_plist"
    echo "PRUNE_SCHEDULE_INSTALLED mac-local $local_plist mode=${apply_local:-report-only} log=$local_log"
  fi
else
  log="$HOME/.local/state/himawari/prune-rebuildable.log"
  mkdir -p "$(dirname "$log")"
  quoted=""
  for root in "${roots[@]}"; do quoted+=" $(printf '%q' "$root")"; done
  line="0 4 * * * /usr/bin/python3 -I $(printf '%q' "$copy") --apply --skip-if-busy$quoted >> $(printf '%q' "$log") 2>&1 $marker"
  { { crontab -l 2>/dev/null || true; } | { grep -vF "$marker" || true; }; echo "$line"; } | crontab -
  echo "PRUNE_SCHEDULE_INSTALLED hermes log=$log"
fi
