RUNNER_IDS="1 2"

runner_select() {
  case "$1" in
    1)
      RUNNER_USER=gh-runner
      RUNNER_ROOT=/srv/gh-runner
      RUNNER_UNIT=gh-runner.service
      RUNNER_NAME=hermes-home
      RUNNER_OTHER_ROOT=/srv/gh-runner-2
      ;;
    2)
      RUNNER_USER=gh-runner-2
      RUNNER_ROOT=/srv/gh-runner-2
      RUNNER_UNIT=gh-runner-2.service
      RUNNER_NAME=hermes-home-2
      RUNNER_OTHER_ROOT=/srv/gh-runner
      ;;
    *)
      echo "unknown runner: ${1:-} (expected 1 or 2)" >&2
      return 64
      ;;
  esac
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
    -e "s|@OTHER_ROOT@|$RUNNER_OTHER_ROOT|g" "$2"
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
    meta skuid { $1 } ip daddr 127.0.0.0/8 tcp dport { $2 } reject
    meta skuid { $1 } ip6 daddr ::1 tcp dport { $2 } reject
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
  printf 'andy ALL=(root) NOPASSWD: %s\n' "$line"
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
    if [ -e "$path" ]; then
      cp -a "$path" "$backup/$index" || return 1
      printf 'present\t%s\t%s\n' "$index" "$path" >> "$backup/manifest"
    else
      printf 'absent\t%s\t%s\n' "$index" "$path" >> "$backup/manifest"
    fi
  done
}

record_created_account() {
  printf '%s\t%s\t%s\n' "$2" "$3" "$4" >> "$1/created-accounts"
}

restore_install_paths() {
  local backup=$1 state index path user root root_existed
  while IFS=$'\t' read -r state index path; do
    rm -rf -- "$path"
    [ "$state" = present ] && cp -a "$backup/$index" "$path"
  done < "$backup/manifest"
  [ -f "$backup/created-accounts" ] || return 0
  while IFS=$'\t' read -r user root root_existed; do
    userdel "$user"
    getent group "$user" > /dev/null && groupdel "$user"
    [ "$root_existed" = no ] && rm -rf -- "$root"
  done < "$backup/created-accounts"
  return 0
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
  ports=$(runner_blocked_ports /etc/gh-runner/nft.rules) || ports=""
  [ -n "$ports" ] || { echo "could not list local listening ports" >&2; return 1; }

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
