#!/bin/bash
set -euo pipefail

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/runners.sh"

usage() {
  cat >&2 <<EOF
usage: sudo bash install-gate-remote.sh key
       sudo bash install-gate-remote.sh trust <user@address> <ssh-ed25519 host key of that machine>
       sudo bash install-gate-remote.sh check
       sudo bash install-gate-remote.sh remove
key     creates the key the gate runner uses to fetch reports from the ARM machine (kept if it exists) and prints its public half
trust   records where the ARM machine is and which host key it must present
check   fetches a report that does not exist and expects the ARM machine to answer that it is missing
remove  deletes the key, the address and the host key
EOF
  exit 64
}

[ "$RUNNER_SITE" = vps ] || { echo "install-gate-remote.sh belongs to the CI VPS; run it without RUNNER_SITE" >&2; exit 64; }
require_runner_host
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }
runner_select 3
GATE_USER=$RUNNER_USER
DIR=$RUNNER_REMOTE_SHARE
KEY=$DIR/id_ed25519

ssh_options() {
  printf '%s\n' -F none -T -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none \
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$DIR/known_hosts" -o GlobalKnownHostsFile=/dev/null \
    -o UpdateHostKeys=no -o ConnectTimeout=15 -o ForwardAgent=no -o ClearAllForwardings=yes
}

case "${1:-}" in
  key)
    [ $# -eq 1 ] || usage
    for tool in ssh-keygen install; do
      command -v "$tool" > /dev/null || { echo "missing $tool" >&2; exit 66; }
    done
    id "$GATE_USER" > /dev/null 2>&1 || { echo "the gate runner account $GATE_USER does not exist; install the runners first" >&2; exit 69; }
    install -d -m 0755 -o root -g root "${DIR%/*}"
    install -d -m 0750 -o root -g "$GATE_USER" "$DIR"
    if [ ! -e "$KEY" ]; then
      WORK=$(mktemp -d)
      trap 'rm -rf "$WORK"' EXIT
      ssh-keygen -q -t ed25519 -N "" -C "" -f "$WORK/id_ed25519"
      install -m 0440 -o root -g "$GATE_USER" "$WORK/id_ed25519" "$KEY"
      install -m 0444 -o root -g root "$WORK/id_ed25519.pub" "$KEY.pub"
    elif [ ! -s "$KEY.pub" ]; then
      WORK=$(mktemp -d)
      trap 'rm -rf "$WORK"' EXIT
      ssh-keygen -y -f "$KEY" > "$WORK/id_ed25519.pub" || { echo "GATE_REMOTE_FAILED could not derive the public key from $KEY" >&2; exit 1; }
      install -m 0444 -o root -g root "$WORK/id_ed25519.pub" "$KEY.pub"
    fi
    PUBLIC=$(awk '{print $1 " " $2; exit}' "$KEY.pub")
    [[ "$PUBLIC" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]{60,100}$ ]] || { echo "GATE_REMOTE_FAILED $KEY.pub is not an ed25519 public key" >&2; exit 1; }
    echo "GATE_REMOTE_KEY $PUBLIC"
    ;;
  trust)
    [ $# -eq 3 ] || usage
    TARGET=$2
    HOST_KEY=$3
    [[ "$TARGET" =~ ^[a-z][a-z0-9-]{0,31}@[0-9A-Za-z][0-9A-Za-z.-]{0,252}$ ]] || { echo "GATE_REMOTE_FAILED the address must look like user@host" >&2; exit 64; }
    [[ "$HOST_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]{60,100}$ ]] || { echo "GATE_REMOTE_FAILED the host key must be 'ssh-ed25519 <key>' with no comment" >&2; exit 64; }
    [ -e "$KEY" ] || { echo "GATE_REMOTE_FAILED no key yet; run 'install-gate-remote.sh key' first" >&2; exit 1; }
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    printf '%s\n' "$TARGET" > "$WORK/target"
    printf '%s %s\n' "${TARGET#*@}" "$HOST_KEY" > "$WORK/known_hosts"
    install -m 0444 -o root -g root "$WORK/target" "$DIR/target"
    install -m 0444 -o root -g root "$WORK/known_hosts" "$DIR/known_hosts"
    echo "GATE_REMOTE_TRUSTED target=$TARGET"
    ;;
  check)
    [ $# -eq 1 ] || usage
    for name in id_ed25519 target known_hosts; do
      [ -e "$DIR/$name" ] || { echo "GATE_REMOTE_FAILED $DIR/$name is missing; run key and trust first" >&2; exit 1; }
    done
    TARGET=$(cat "$DIR/target")
    mapfile -t OPTIONS < <(ssh_options)
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    STATUS=0
    ANSWER=$(sudo -u "$GATE_USER" ssh "${OPTIONS[@]}" "$TARGET" 1-1/connection-check 2> "$WORK/ssh-errors") || STATUS=$?
    if [ "$ANSWER" = '{"error": "MISSING"}' ]; then
      echo "GATE_REMOTE_OK $TARGET answered through the fixed command"
      exit 0
    fi
    echo "GATE_REMOTE_FAILED status=$STATUS answer=${ANSWER:0:200} ssh said: $(head -c 400 "$WORK/ssh-errors" | tr '\n' ' ')" >&2
    exit 1
    ;;
  remove)
    [ $# -eq 1 ] || usage
    rm -rf -- "$DIR"
    [ ! -e "$DIR" ] || { echo "GATE_REMOTE_FAILED $DIR is still there" >&2; exit 1; }
    echo "GATE_REMOTE_REMOVED"
    ;;
  *) usage ;;
esac
