#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: codex-launch.sh [--task <task>] <brief> <first-stop-file> -- <codex options...>" >&2
  echo "       --task names the long task the brief belongs to when the repository has more than one open one; the value goes unchanged to longtask.py check-brief --task" >&2
  echo "       run from the repository; the brief must name items of an open long task, unless no task is open or it has a line 只读任务：是" >&2
  exit 2
}

task=
if [ "${1:-}" = "--task" ]; then
  [ $# -ge 5 ] && [ -n "${2:-}" ] && [ "$5" = "--" ] || usage
  task=$2
  brief=$3
  stop=$4
  shift 5
else
  [ $# -ge 3 ] && [ "$3" = "--" ] || usage
  brief=$1
  stop=$2
  shift 3
fi

here=$(cd "$(dirname "$0")" && pwd)
if python3 - "$brief" <<'PY'
import sys
inside = False
for line in open(sys.argv[1], encoding="utf-8"):
    stripped = line.rstrip("\n")
    if stripped.startswith("```") or stripped.startswith("~~~"):
        inside = not inside
        continue
    if not inside and stripped == "只读任务：是":
        sys.exit(0)
sys.exit(1)
PY
then
  echo "READ_ONLY_BRIEF: the brief marks itself read-only (只读任务：是), so the long-task item check is skipped"
elif [ -n "$task" ]; then
  python3 "$here/../../long-task-planning/scripts/longtask.py" check-brief "$brief" --task "$task"
else
  python3 "$here/../../long-task-planning/scripts/longtask.py" check-brief "$brief"
fi
exec codex "$@" "Read $brief fully, then work per it. The first stop file is $stop."
