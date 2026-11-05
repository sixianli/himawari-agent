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

apply_runner_controls() {
  local ids uids ports rules sudoers id
  ids=$(installed_runner_ids)
  [ -n "$ids" ] || { echo "no runner account exists" >&2; return 1; }
  uids=""
  for id in $ids; do
    runner_select "$id"
    uids="${uids:+$uids, }$(id -u "$RUNNER_USER")"
  done
  ports=$(ss -ltnH | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | grep -vx 53 | paste -sd, -)
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
