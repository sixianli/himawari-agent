RUNNER_IDS="1 2 3"
RUNNER_HOST=ci-vps
RUNNER_CHECK_LABEL=ci-vps
RUNNER_GATE_LABEL=ci-vps-gate
RUNNER_LABELS="$RUNNER_CHECK_LABEL $RUNNER_GATE_LABEL"
RUNNER_CONTROLLER=ubuntu
RUNNER_SHARE_ROOT=/srv/gh-runner-share
RUNNER_SHARE_GROUP=gh-ci-share
RUNNER_SHARE_KEEP_MINUTES=360

runner_select() {
  case "$1" in
    1)
      RUNNER_USER=gh-runner
      RUNNER_ROOT=/srv/gh-runner
      RUNNER_UNIT=gh-runner.service
      RUNNER_NAME=ci-vps-1
      RUNNER_OTHER_ROOTS="/srv/gh-runner-2 /srv/gh-runner-gate"
      ;;
    2)
      RUNNER_USER=gh-runner-2
      RUNNER_ROOT=/srv/gh-runner-2
      RUNNER_UNIT=gh-runner-2.service
      RUNNER_NAME=ci-vps-2
      RUNNER_OTHER_ROOTS="/srv/gh-runner /srv/gh-runner-gate"
      ;;
    3)
      RUNNER_USER=gh-runner-gate
      RUNNER_ROOT=/srv/gh-runner-gate
      RUNNER_UNIT=gh-runner-gate.service
      RUNNER_NAME=ci-vps-gate
      RUNNER_OTHER_ROOTS="/srv/gh-runner /srv/gh-runner-2"
      ;;
    *)
      echo "unknown runner: ${1:-} (expected 1, 2 or 3)" >&2
      return 64
      ;;
  esac
  if [ "$1" = 3 ]; then
    RUNNER_LABEL=$RUNNER_GATE_LABEL
    RUNNER_SLICE=ghgate.slice
    RUNNER_MEMORY_MIN=2G
    RUNNER_MEMORY_HIGH=2G
    RUNNER_MEMORY_MAX=2G
    RUNNER_TASKS_MAX=1024
  else
    RUNNER_LABEL=$RUNNER_CHECK_LABEL
    RUNNER_SLICE=gh-runners.slice
    RUNNER_MEMORY_MIN=0
    RUNNER_MEMORY_HIGH=14G
    RUNNER_MEMORY_MAX=15G
    RUNNER_TASKS_MAX=2048
  fi
}

runner_label_for_name() {
  local id
  for id in $RUNNER_IDS; do
    runner_select "$id"
    [ "$RUNNER_NAME" = "$1" ] && { printf '%s\n' "$RUNNER_LABEL"; return 0; }
  done
  return 1
}

require_runner_host() {
  [ "$(hostname)" = "$RUNNER_HOST" ] || { echo "this script only runs on $RUNNER_HOST, not $(hostname)" >&2; exit 68; }
}

installed_runner_ids() {
  local id
  for id in $RUNNER_IDS; do
    runner_select "$id"
    id -u "$RUNNER_USER" > /dev/null 2>&1 && printf '%s\n' "$id"
  done
  return 0
}

runner_has_job() {
  pgrep -u "$1" -x Runner.Worker > /dev/null
}

render_runner_unit() {
  runner_select "$1" || return
  sed -e "s|@USER@|$RUNNER_USER|g" \
    -e "s|@ROOT@|$RUNNER_ROOT|g" \
    -e "s|@NAME@|$RUNNER_NAME|g" \
    -e "s|@OTHER_ROOTS@|$(printf ' -%s' $RUNNER_OTHER_ROOTS)|g" \
    -e "s|@SLICE@|$RUNNER_SLICE|g" \
    -e "s|@MEMORY_MIN@|$RUNNER_MEMORY_MIN|g" \
    -e "s|@MEMORY_HIGH@|$RUNNER_MEMORY_HIGH|g" \
    -e "s|@MEMORY_MAX@|$RUNNER_MEMORY_MAX|g" \
    -e "s|@TASKS_MAX@|$RUNNER_TASKS_MAX|g" \
    -e "s|@SHARE@|$RUNNER_SHARE_ROOT|g" \
    -e "s|@SHARE_GROUP@|$RUNNER_SHARE_GROUP|g" "$2"
}

runner_firewall_rules() {
  cat <<EOF
table inet gh_runner
delete table inet gh_runner
table inet gh_runner {
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid { $1 } ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } reject
    meta skuid { $1 } ip6 daddr { fc00::/7, fe80::/10 } reject
    meta skuid { $1 } fib daddr type local tcp dport { $2 } reject
  }
}
EOF
}

runner_sudoers_line() {
  local id action line=""
  for id in "$@"; do
    runner_select "$id" || return
    for action in start stop restart; do
      line="${line:+$line, }/usr/bin/systemctl $action $RUNNER_UNIT"
    done
  done
  printf '%s ALL=(root) NOPASSWD: %s\n' "$RUNNER_CONTROLLER" "$line"
}

runner_blocked_ports() {
  local listening previous=""
  listening=$(ss -ltnH) || return 1
  [ -f "$1" ] && previous=$(sed -nE 's/.*tcp dport \{ ([0-9, ]+) \}.*/\1/p' "$1" | tr ', ' '\n\n')
  { printf '%s\n' "$listening" | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/'; printf '%s\n' "$previous"; } \
    | awk '/^[0-9]+$/ && $0 != 53' | sort -un | paste -sd, -
}

backup_install_paths() {
  local backup=$1 path index=0
  shift
  : > "$backup/manifest"
  for path in "$@"; do
    index=$((index + 1))
    if [ -e "$path" ] || [ -L "$path" ]; then
      cp -a "$path" "$backup/$index" || return 1
      printf 'present\t%s\t%s\n' "$index" "$path" >> "$backup/manifest"
    else
      printf 'absent\t%s\t%s\n' "$index" "$path" >> "$backup/manifest"
    fi
  done
}

record_created_paths() {
  local backup=$1 path
  shift
  for path in "$@"; do
    [ -e "$path" ] || [ -L "$path" ] || printf '%s\n' "$path" >> "$backup/created-paths"
  done
}

record_created_account() {
  printf '%s\n' "$2" >> "$1/created-accounts"
}

record_created_group() {
  printf '%s\n' "$2" >> "$1/created-groups"
}

record_newly_enabled_units() {
  local backup=$1 unit
  shift
  for unit in "$@"; do
    systemctl is-enabled --quiet "$unit" || printf '%s\n' "$unit" >> "$backup/enabled-units"
  done
}

restore_install_paths() {
  local backup=$1 state index path user group unit failed=""
  if [ -f "$backup/enabled-units" ]; then
    while read -r unit; do
      systemctl disable --now "$unit" || failed="$failed unit:$unit"
    done < "$backup/enabled-units"
  fi
  while IFS=$'\t' read -r state index path; do
    if [ "$state" = present ]; then
      rm -rf -- "$path.restoring" &&
        cp -a "$backup/$index" "$path.restoring" &&
        rm -rf -- "$path" &&
        mv -- "$path.restoring" "$path" ||
        failed="$failed $path"
    else
      rm -rf -- "$path" || failed="$failed $path"
    fi
  done < "$backup/manifest"
  if [ -f "$backup/created-accounts" ]; then
    while read -r user; do
      id "$user" > /dev/null 2>&1 || continue
      pkill -KILL -u "$user" || true
      userdel "$user" || failed="$failed user:$user"
      if getent group "$user" > /dev/null; then
        groupdel "$user" || failed="$failed group:$user"
      fi
    done < "$backup/created-accounts"
  fi
  if [ -f "$backup/created-paths" ]; then
    while read -r path; do
      rm -rf -- "$path" || failed="$failed $path"
    done < "$backup/created-paths"
  fi
  if [ -f "$backup/created-groups" ]; then
    while read -r group; do
      getent group "$group" > /dev/null || continue
      groupdel "$group" || failed="$failed group:$group"
    done < "$backup/created-groups"
  fi
  [ -z "$failed" ] && return 0
  echo "RESTORE_INCOMPLETE could not put back:$failed (copies are in $backup)" >&2
  return 1
}

apply_runner_controls() {
  local ids uids ports rules sudoers id
  ids=$(installed_runner_ids)
  [ -n "$ids" ] || { echo "no runner account exists" >&2; return 1; }
  uids=""
  for id in $ids; do
    runner_select "$id"
    uids="${uids:+$uids, }$(id -u "$RUNNER_USER")"
  done
  ports=$(runner_blocked_ports /etc/gh-runner/nft.rules) || { echo "could not list local listening ports" >&2; return 1; }
  [ -n "$ports" ] || { echo "no local TCP port to block: nothing but DNS is listening and there are no earlier rules" >&2; return 1; }

  rules=$(mktemp)
  runner_firewall_rules "$uids" "$ports" > "$rules"
  nft -c -f "$rules" || { rm -f "$rules"; return 1; }
  install -d -m 0755 -o root -g root /etc/gh-runner || { rm -f "$rules"; return 1; }
  install -m 0644 -o root -g root "$rules" /etc/gh-runner/nft.rules || { rm -f "$rules"; return 1; }
  rm -f "$rules"

  sudoers=$(mktemp)
  runner_sudoers_line $ids > "$sudoers"
  visudo -cf "$sudoers" > /dev/null || { rm -f "$sudoers"; return 1; }
  install -m 0440 -o root -g root "$sudoers" /etc/sudoers.d/91-gh-runner-control || { rm -f "$sudoers"; return 1; }
  rm -f "$sudoers"

  nft -f /etc/gh-runner/nft.rules || return 1
  RUNNER_CONTROL_UIDS=$uids
  RUNNER_CONTROL_PORTS=$ports
}
