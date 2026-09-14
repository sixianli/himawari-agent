#!/bin/sh

# Prepare only the disposable qualification root on Hermes. This script must
# never be pointed at a product runtime or a broad filesystem path: the fixed
# directory is the explicit, user-authorized qualification target.

set -eu

QUALIFICATION_ROOT=/data/himawari-qualification-20260904
BUILD_ROOT=$QUALIFICATION_ROOT/build
PRLIMIT_SOURCE=$BUILD_ROOT/util-linux/prlimit
RUNTIME_ROOT=$QUALIFICATION_ROOT/runtime-root-probe-20260905-v2
PROBE_SOURCE_ROOT=$QUALIFICATION_ROOT/probe-source-v2
FORK_SOURCE=$PROBE_SOURCE_ROOT/linux-capability-fork-probe.c
FORK_TARGET=$RUNTIME_ROOT/usr/bin/fork-probe
PRLIMIT_TARGET=$RUNTIME_ROOT/usr/bin/prlimit
SHELL_SOURCE=/bin/sh
SLEEP_SOURCE=/bin/sleep
SIZE_LIMIT_KIB=2097152

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 0 ] || fail "this preparation script accepts no path overrides"
[ -d "$QUALIFICATION_ROOT" ] || fail "qualification root is missing"
[ "$(readlink -f -- "$QUALIFICATION_ROOT")" = "$QUALIFICATION_ROOT" ] || fail "qualification root is not canonical"
[ -x "$PRLIMIT_SOURCE" ] || fail "compiled prlimit is missing or not executable"
[ -f "$(dirname -- "$0")/linux-capability-fork-probe.c" ] || fail "fork probe source is missing"

existing_size=$(du -sk -- "$QUALIFICATION_ROOT" | awk '{print $1}')
case "$existing_size" in
  ''|*[!0-9]*) fail "could not measure qualification root" ;;
esac
[ "$existing_size" -le "$SIZE_LIMIT_KIB" ] || fail "qualification root exceeds the 2 GiB bound"

[ ! -e "$RUNTIME_ROOT" ] || fail "refusing to overwrite an existing runtime root"
[ ! -e "$PROBE_SOURCE_ROOT" ] && [ ! -L "$PROBE_SOURCE_ROOT" ] || fail "refusing to overwrite an existing probe source root"
mkdir -m 700 -- "$PROBE_SOURCE_ROOT"
cp -- "$(dirname -- "$0")/linux-capability-fork-probe.c" "$FORK_SOURCE"
chmod 600 -- "$FORK_SOURCE"
mkdir -p -- "$RUNTIME_ROOT"
chmod 700 -- "$RUNTIME_ROOT"
mkdir -m 700 -- \
  "$RUNTIME_ROOT/proc" \
  "$RUNTIME_ROOT/dev" \
  "$RUNTIME_ROOT/tmp" \
  "$RUNTIME_ROOT/workspace"

keep_runtime_root=0
cleanup() {
  status=$?
  if [ "$keep_runtime_root" -ne 1 ]; then
    rm -rf -- "$RUNTIME_ROOT"
    rm -f -- "$FORK_SOURCE"
  fi
  exit "$status"
}
trap cleanup EXIT

copy_file() {
  source_path=$1
  destination_path=$2
  destination=$RUNTIME_ROOT$destination_path
  source_real=$(readlink -f -- "$source_path")
  [ -f "$source_real" ] || fail "source is not a regular file: $source_path"
  mkdir -p -- "$(dirname -- "$destination")"
  chmod 700 -- "$(dirname -- "$destination")"
  cp -- "$source_real" "$destination"
  chmod 700 -- "$destination"
  [ ! -L "$destination" ] || fail "copied runtime file is a symlink: $destination_path"
}

copy_elf() {
  source_path=$1
  destination_path=$2
  copy_file "$source_path" "$destination_path"
  source_real=$(readlink -f -- "$source_path")
  dependencies=$(ldd "$source_real" 2>&1 | awk '/=>[[:space:]]*\// {print $3} /^[[:space:]]*\// {print $1}' || true)
  for dependency in $dependencies; do
    case "$dependency" in
      /*) ;;
      *) fail "ldd returned a non-absolute dependency: $dependency" ;;
    esac
    dependency_target=$RUNTIME_ROOT$dependency
    if [ -e "$dependency_target" ]; then
      [ ! -L "$dependency_target" ] || fail "dependency target is a symlink: $dependency"
      continue
    fi
    copy_file "$dependency" "$dependency"
  done
}

copy_elf "$PRLIMIT_SOURCE" "/usr/bin/prlimit"
copy_elf "$SHELL_SOURCE" "/bin/sh"
copy_elf "$SLEEP_SOURCE" "/bin/sleep"

cc -std=c11 -O2 -static -Wall -Wextra -Werror \
  "$FORK_SOURCE" \
  -o "$FORK_TARGET"
chmod 700 -- "$FORK_TARGET"

if readelf -l "$FORK_TARGET" | grep -q 'Requesting program interpreter'; then
  fail "fork probe is dynamically linked; refusing an incomplete runtime root"
fi

[ "$(sha256sum "$PRLIMIT_TARGET" | awk '{print $1}')" = "$(sha256sum "$PRLIMIT_SOURCE" | awk '{print $1}')" ] || fail "copied prlimit digest changed"
find "$RUNTIME_ROOT" -type d -exec chmod 700 {} +
[ "$(stat -c '%a' "$RUNTIME_ROOT")" = "700" ] || fail "runtime root mode is not 0700"
if find "$RUNTIME_ROOT" -type f ! -perm 0700 -print -quit | grep -q .; then
  fail "runtime root contains a file with an unsafe mode"
fi
if find "$RUNTIME_ROOT" -type d ! -perm 0700 -print -quit | grep -q .; then
  fail "runtime root contains a directory with an unsafe mode"
fi

final_size=$(du -sk -- "$QUALIFICATION_ROOT" | awk '{print $1}')
case "$final_size" in
  ''|*[!0-9]*) fail "could not measure prepared qualification root" ;;
esac
[ "$final_size" -le "$SIZE_LIMIT_KIB" ] || fail "prepared qualification root exceeds the 2 GiB bound"

keep_runtime_root=1
printf 'RUNTIME_ROOT=%s\n' "$RUNTIME_ROOT"
printf 'SANDBOX_PRLIMIT=/usr/bin/prlimit\n'
printf 'SANDBOX_FORK_PROBE=/usr/bin/fork-probe\n'
printf 'SANDBOX_HOLD_PROBE=/usr/bin/fork-probe\n'
printf 'PRLIMIT_SHA256=sha256:%s\n' "$(sha256sum "$PRLIMIT_TARGET" | awk '{print $1}')"
printf 'PROBE_SOURCE=%s\n' "$FORK_SOURCE"
