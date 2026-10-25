#!/usr/bin/env bash
set -u

usage() {
  echo "usage: evidence-gate.sh <handoff dir> <since epoch seconds>" >&2
  exit 2
}

[ $# -eq 2 ] || usage
handoff_dir=$1
since=$2
checker="$(cd "$(dirname "$0")" && pwd)/evidence-check.py"
failed=0
quiet_guard='if [ -e "$HOME/.agent-quiet-run" ] && read -r p l < "$HOME/.agent-quiet-run" && kill -0 "$p" 2>/dev/null; then echo "EVIDENCE_REMOTE_DEFERRED: guarded run $l (pid $p) is in progress on this host; rerun the gate after it ends"; exit 3; fi;'
python3 "$checker" --since "$since" "$handoff_dir" || failed=1
if [ -f "$handoff_dir/evidence-roots.txt" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *'|'*)
        command=${line%%|*}
        dir=${line#*|}
        read -r -a parts <<< "$command"
        "${parts[@]}" "$quiet_guard python3 - --since $since '$dir'" < "$checker" || failed=1
        ;;
      *) python3 "$checker" --since "$since" "$line" || failed=1 ;;
    esac
  done < "$handoff_dir/evidence-roots.txt"
fi
if [ "$failed" -ne 0 ]; then
  echo "EVIDENCE CHECK FAILED: fix the evidence above before accepting this batch"
  exit 3
fi
exit 0
