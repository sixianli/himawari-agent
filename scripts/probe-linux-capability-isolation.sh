#!/bin/sh

# This is a bounded Linux qualification probe. It is intentionally independent
# of Node and never injects a host executable into the sandbox payload. The
# runtime root must already contain a complete, provisioned loader/runtime.

set -eu

if [ "$#" -ne 8 ]; then
  printf '%s\n' "usage: $0 BWRAP OUTER_PRLIMIT RUNTIME_ROOT SANDBOX_PRLIMIT SANDBOX_FORK_PROBE SANDBOX_HOLD_PROBE PROBE_DIR PRLIMIT_SHA256" >&2
  exit 64
fi

bwrap_path=$1
outer_prlimit_path=$2
runtime_root=$3
sandbox_prlimit=$4
sandbox_fork_probe=$5
sandbox_hold_probe=$6
probe_dir=$7
expected_prlimit_sha256=$8
kill_path=/bin/kill

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

absolute_path() {
  case "$1" in
    /*) ;;
    *) fail "path is not absolute: $1" ;;
  esac
}

canonical_sandbox_path() {
  case "$1" in
    /*) ;;
    *) fail "sandbox path is not absolute: $1" ;;
  esac
  case "$1" in
    */../*|*/..|*/./*|*/.) fail "sandbox path is not canonical: $1" ;;
  esac
}

absolute_path "$bwrap_path"
absolute_path "$outer_prlimit_path"
absolute_path "$runtime_root"
absolute_path "$probe_dir"
canonical_sandbox_path "$sandbox_prlimit"
canonical_sandbox_path "$sandbox_fork_probe"
canonical_sandbox_path "$sandbox_hold_probe"

[ -x "$bwrap_path" ] || fail "bubblewrap is not executable"
[ -x "$outer_prlimit_path" ] || fail "outer prlimit is not executable"
[ -x "$kill_path" ] || fail "trusted host kill utility is missing"
[ -d "$runtime_root" ] || fail "runtime root is not a directory"
[ ! -L "$runtime_root" ] || fail "runtime root is a symlink"
[ "$(stat -c '%a' "$runtime_root" 2>/dev/null || stat -f '%Lp' "$runtime_root")" = "700" ] || fail "runtime root mode is not 0700"
[ -n "$expected_prlimit_sha256" ] || fail "expected prlimit digest is empty"
case "$expected_prlimit_sha256" in
  sha256:[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) fail "expected prlimit digest is not sha256-prefixed" ;;
esac

runtime_file() {
  sandbox_path=$1
  host_path=$runtime_root$sandbox_path
  [ -f "$host_path" ] || fail "runtime file is missing: $sandbox_path"
  [ ! -L "$host_path" ] || fail "runtime file is a symlink: $sandbox_path"
  [ -x "$host_path" ] || fail "runtime file is not executable: $sandbox_path"
  resolved_root=$(readlink -f -- "$runtime_root")
  resolved_file=$(readlink -f -- "$host_path")
  case "$resolved_file" in
    "$resolved_root"/*) ;;
    *) fail "runtime file escapes runtime root: $sandbox_path" ;;
  esac
  printf '%s\n' "$host_path"
}

runtime_prlimit_host=$(runtime_file "$sandbox_prlimit")
runtime_file "$sandbox_fork_probe" >/dev/null
runtime_file "$sandbox_hold_probe" >/dev/null

case "$(sha256sum "$runtime_prlimit_host" | awk '{print $1}')" in
  "${expected_prlimit_sha256#sha256:}") ;;
  *) fail "runtime prlimit bytes do not match the frozen digest" ;;
esac

probe_root=$(mktemp -d "$probe_dir/isolation-probe.XXXXXX")
probe_pid=
reader_pid=

cleanup() {
  if [ -n "$probe_pid" ]; then
    "$kill_path" -KILL -- "-$probe_pid" 2>/dev/null || true
    "$kill_path" -KILL -- "$probe_pid" 2>/dev/null || true
  fi
  if [ -n "$reader_pid" ]; then
    "$kill_path" -KILL -- "$reader_pid" 2>/dev/null || true
  fi
  rm -rf -- "$probe_root"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

run_sandbox() {
  "$outer_prlimit_path" \
    --cpu=5 \
    --as=134217728 \
    --fsize=1048576 \
    -- \
    "$bwrap_path" \
    --unshare-all \
    --unshare-user \
    --clearenv \
    --new-session \
    --die-with-parent \
    --disable-userns \
    --ro-bind "$runtime_root" / \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --bind "$probe_root" /workspace \
    --chdir /workspace \
    -- \
    "$sandbox_prlimit" \
    --nproc=2 \
    -- \
    "$@"
}

# The control has no inner NPROC limit and proves that the provisioned fork
# probe itself can fork. It is not a no-limits production launch path.
run_sandbox_without_nproc() {
  "$outer_prlimit_path" \
    --cpu=5 \
    --as=134217728 \
    --fsize=1048576 \
    -- \
    "$bwrap_path" \
    --unshare-all \
    --unshare-user \
    --clearenv \
    --new-session \
    --die-with-parent \
    --disable-userns \
    --ro-bind "$runtime_root" / \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --bind "$probe_root" /workspace \
    --chdir /workspace \
    -- \
    "$@"
}

run_sandbox_without_nproc "$sandbox_fork_probe" --probe-unbounded >/dev/null 2>&1 || fail "unbounded fork control failed"
printf '%s\n' 'NPROC_UNBOUNDED_CONTROL=PASS'

# The fork probe must return 0 only after observing EAGAIN at the configured
# process ceiling. A successful extra fork is a failure, not a soft warning.
run_sandbox "$sandbox_fork_probe" --assert-nproc >/dev/null 2>&1 || fail "inner NPROC fork probe failed"
printf '%s\n' 'NPROC_INTERNAL_FORK=PASS'

start_long_running() {
  rm -f -- "$probe_root/child.ready" "$probe_root/child.pipe"
  mkfifo "$probe_root/child.pipe"
  cat "$probe_root/child.pipe" >/dev/null &
  reader_pid=$!
  setsid "$outer_prlimit_path" \
    --cpu=5 \
    --as=134217728 \
    --fsize=1048576 \
    -- \
    "$bwrap_path" \
    --unshare-all \
    --unshare-user \
    --clearenv \
    --new-session \
    --die-with-parent \
    --disable-userns \
    --ro-bind "$runtime_root" / \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --bind "$probe_root" /workspace \
    --chdir /workspace \
    -- \
    "$sandbox_prlimit" \
    --nproc=2 \
    -- \
    "$sandbox_hold_probe" \
    --hold-fd \
    /workspace/child.pipe \
    /workspace/child.ready \
    >/dev/null 2>&1 &
  probe_pid=$!
  attempt=0
  while [ ! -s "$probe_root/child.ready" ] && [ "$attempt" -lt 100 ]; do
    sleep 0.02
    attempt=$((attempt + 1))
  done
  [ -s "$probe_root/child.ready" ] || fail "long-running sandbox did not start"
}

wait_for_exit() {
  process_id=$1
  attempt=0
  while "$kill_path" -0 -- "$process_id" 2>/dev/null && [ "$attempt" -lt 100 ]; do
    process_state=$(ps -o stat= -p "$process_id" 2>/dev/null | tr -d ' ' || true)
    case "$process_state" in
      Z*) break ;;
    esac
    sleep 0.02
    attempt=$((attempt + 1))
  done
  process_state=$(ps -o stat= -p "$process_id" 2>/dev/null | tr -d ' ' || true)
  case "$process_state" in
    ""|Z*) ;;
    *) fail "sandbox parent did not exit before the bounded wait" ;;
  esac
  wait "$process_id" 2>/dev/null || true
}

wait_reader_closed() {
  attempt=0
  while "$kill_path" -0 -- "$reader_pid" 2>/dev/null && [ "$attempt" -lt 100 ]; do
    reader_state=$(ps -o stat= -p "$reader_pid" 2>/dev/null | tr -d ' ' || true)
    case "$reader_state" in
      Z*) break ;;
    esac
    sleep 0.02
    attempt=$((attempt + 1))
  done
  reader_state=$(ps -o stat= -p "$reader_pid" 2>/dev/null | tr -d ' ' || true)
  case "$reader_state" in
    ""|Z*) ;;
    *) fail "sandbox child still holds the inherited FIFO" ;;
  esac
  if ! wait "$reader_pid" 2>/dev/null; then
    :
  fi
  if "$kill_path" -0 -- "$reader_pid" 2>/dev/null; then
    fail "sandbox child still holds the inherited FIFO"
  fi
  reader_pid=
}

# A process-group termination must close the payload's inherited descriptor.
start_long_running
"$kill_path" -TERM -- "-$probe_pid" 2>/dev/null || fail "process-group signal was not delivered"
wait_for_exit "$probe_pid"
wait_reader_closed
probe_pid=
printf '%s\n' 'PROCESS_GROUP_CLEANUP=PASS'

# Killing only the outer parent exercises bubblewrap --die-with-parent. The
# FIFO reader exits only when the sandbox child closes its descriptor.
start_long_running
"$kill_path" -KILL -- "$probe_pid" 2>/dev/null || fail "parent-death signal was not delivered"
wait_for_exit "$probe_pid"
wait_reader_closed
probe_pid=
printf '%s\n' 'PARENT_DEATH_CLEANUP=PASS'
