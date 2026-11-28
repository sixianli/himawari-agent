calm_below="${calm_below:-40}"
calm_patience="${calm_patience:-180}"
calm_required=1

simulator_load() {
  ps -A -o ppid=,%cpu= | awk -v parent="$simulator_launchd" '$1 == parent { total += $2 } END { printf "%d", total }'
}

busiest_processes() {
  ps -A -o ppid=,pid=,%cpu=,comm= | awk -v parent="$simulator_launchd" '$1 == parent { $1 = ""; print }' | sort -k2 -rn | head -5 | sed 's/^ */UI_REVIEW_BUSY /' >&2
}

calm() {
  [ "$calm_required" -eq 0 ] || [ "$(simulator_load)" -lt "$calm_below" ]
}

wait_until_calm() {
  local quiet=0 waited=0
  [ "$calm_required" -eq 1 ] || return 0
  while [ "$quiet" -lt 3 ]; do
    if calm; then quiet=$((quiet + 1)); else quiet=0; fi
    [ "$quiet" -lt 3 ] || return 0
    if [ "$waited" -ge "$calm_patience" ]; then
      busiest_processes
      echo "UI_REVIEW_STILL_BUSY simulator load stayed at $(simulator_load)% for ${calm_patience}s (limit ${calm_below}%); this machine does not get quieter, so from now on only the scene marker and two identical screenshots decide when a shot is ready" >&2
      calm_required=0
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
}
