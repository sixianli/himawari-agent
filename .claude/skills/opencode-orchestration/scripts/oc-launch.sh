#!/usr/bin/env bash
set -u

usage() {
  cat >&2 <<'EOF'
usage:
  oc-launch.sh new [--task <task>] <brief> <run prefix> <provider/model> [title]
  oc-launch.sh resume <session id> <reply> <next stop file> <run prefix> <provider/model>
Starts opencode detached (it outlives the calling shell), writes <prefix>.jsonl,
.err, .pid and, when it ends, .rc. The prefix must name a directory other than
the current one (for example .ci-output/handoff/run-01); otherwise nothing
starts and the exit code is 2. Waits up to OC_STARTUP_SECONDS (default 180)
for the first event and prints its session id. The run connects to the task's
own server (oc-server.sh, state in OC_SERVER_DIR, default <prefix dir>/oc-server),
started here when it is not running, so oc-steer.sh can reach the session.
When OC_ALLOWED_MODELS names a file, or .opencode/allowed-models.txt exists in
the current directory, the model (without its #variant) must equal one of its
lines (blank lines and lines starting with # are ignored); otherwise nothing
starts and the exit code is 2.
When .agents/tasks exists in the current directory, a new session's brief must
name at least one long-task item (longtask.py check-brief), unless the brief
holds a line that is exactly 只读任务：是 outside fenced code: then the check is
skipped and READ_ONLY_BRIEF is printed. Use it only for work that changes no
file (reading code for a report, reviewing a document).
When the repository has more than one open long task, give new --task <task> to
say which task the brief belongs to; the value goes unchanged to
longtask.py check-brief --task.
When .opencode/opencode.json exists in the current directory, every text in a
bash deny pattern of the form *text* (no spaces or other wildcards) that the
brief or reply contains must also appear on a line starting with
本地禁止规则：, which tells the agent to read those files with its read tools;
otherwise nothing starts and the exit code is 2 (BRIEF_NAMES_DENIED_TEXT).
When .opencode/required-plugins.txt exists in the current directory, every
non-blank line that does not start with # must read <SHA-256>  <relative path>
and name a file whose contents hash to that value, so that a guard plugin the
run depends on is present and unchanged; a missing file refuses with
REQUIRED_PLUGIN_MISSING, a changed one with REQUIRED_PLUGIN_CHANGED, a line
that is not a digest and a relative path with REQUIRED_PLUGIN_BAD_LINE, and a
listing with no such line with REQUIRED_PLUGIN_LIST_EMPTY (nothing starts,
exit code 2). Neither list is required when the file is absent.
Before starting, the launcher asks the task's server for its model list
(GET /api/model) and prints LIVE_VARIANTS model=<id> variants=<comma list>:
the reasoning variants that exist right now, not a recorded snapshot. A model
the server does not list refuses with MODEL_NOT_SERVED, a #variant that is
not in the live list with VARIANT_UNAVAILABLE (exit code 2), and an unreadable
list with VARIANT_LIST_UNAVAILABLE (exit code 3). When OC_VARIANT_FLOOR names
a file, or .opencode/variant-floor.txt exists in the current directory, each
line <provider/model> <variant> sets the lowest variant that model may start
with: a lower or missing variant refuses with VARIANT_BELOW_FLOOR, a floor
that is not a live variant with VARIANT_FLOOR_UNKNOWN (exit code 2), and a
floor on a model whose live list is empty is ignored with a printed
VARIANT_FLOOR_IGNORED line.
The run's stop file is the resume argument, or for a new run the one path in
the brief ending in stop.md or stop-N.md that does not exist yet (paths that
exist are references to earlier runs); a brief naming none or several unwritten
ones is refused with STOP_FILE_UNCLEAR, and a resume naming an existing stop
file with STOP_FILE_EXISTS (exit code 2, nothing starts). When opencode exits
with code 0 while the stop file is missing, empty or still holds a placeholder
(for example 本节…填写 or 待填写), the same session is resumed with a message
saying an ended turn does not wait for background work, up to OC_AUTO_RESUMES
times (default 2); each resume adds an AUTO_RESUME line to <prefix>.err, and a
run still unfinished after the last one leaves <prefix>.unfinished.
EOF
  exit 2
}

[ $# -ge 1 ] || usage
mode=$1
shift
task=
script_dir=$(cd "$(dirname "$0")" && pwd)
longtask="$script_dir/../../long-task-planning/scripts/longtask.py"
startup=${OC_STARTUP_SECONDS:-180}
opencode_bin=${OC_OPENCODE:-opencode}

case "$mode" in
  new)
    if [ "${1:-}" = "--task" ]; then
      [ $# -ge 4 ] && [ -n "${2:-}" ] || usage
      task=$2
      shift 2
    fi
    [ $# -ge 3 ] || usage
    brief=$1 prefix=$2 model=$3 title=${4:-$(basename "$1" .md)}
    [ -f "$brief" ] || { echo "brief not found: $brief" >&2; exit 2; }
    document=$brief
    message="Read the attached brief fully, then do the work it describes. Write the stop file it names when it tells you to stop."
    set -- run --auto --format json -m "$model" --title "$title" -f "$brief" "$message"
    ;;
  resume)
    [ "${1:-}" = "--task" ] && usage
    [ $# -ge 5 ] || usage
    session=$1 reply=$2 stop=$3 prefix=$4 model=$5
    [ -f "$reply" ] || { echo "reply not found: $reply" >&2; exit 2; }
    document=$reply
    message="Read $reply fully, then continue per its ruling. The next stop file is $stop."
    set -- run --auto --format json -m "$model" -s "$session" "$message"
    ;;
  *)
    usage
    ;;
esac

if python3 -c 'import os, sys; sys.exit(os.path.realpath(os.path.dirname(sys.argv[1]) or ".") != os.path.realpath("."))' "$prefix"; then
  echo "PREFIX_WITHOUT_DIRECTORY: run prefix $prefix puts its run files and the task's server state (oc-server) in the current directory; name a task directory, for example .ci-output/handoff/run-01" >&2
  exit 2
fi

allowed_list=${OC_ALLOWED_MODELS:-}
if [ -n "$allowed_list" ] && [ ! -f "$allowed_list" ]; then
  echo "MODEL_LIST_MISSING: OC_ALLOWED_MODELS names $allowed_list, which does not exist" >&2
  exit 2
fi
[ -n "$allowed_list" ] || [ ! -f .opencode/allowed-models.txt ] || allowed_list=.opencode/allowed-models.txt
if [ -n "$allowed_list" ] &&
  ! grep -v -E '^[[:space:]]*(#|$)' "$allowed_list" | sed 's/[[:space:]]*$//' | grep -q -x -F -- "${model%%#*}"; then
  echo "MODEL_NOT_ALLOWED: $model is not listed in $allowed_list" >&2
  exit 2
fi
if [ -f .opencode/required-plugins.txt ]; then
  python3 -I - .opencode/required-plugins.txt <<'PY' || exit 2
import hashlib
import os
import re
import sys

listing = sys.argv[1]
seen = 0
for number, line in enumerate(open(listing, encoding="utf-8"), start=1):
    text = line.strip()
    if text == "" or text.startswith("#"):
        continue
    parts = text.split()
    if len(parts) != 2 or not re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
        print("REQUIRED_PLUGIN_BAD_LINE: %s line %d is not '<SHA-256>  <relative path>'" % (listing, number), file=sys.stderr)
        sys.exit(2)
    digest, name = parts[0].lower(), parts[1]
    if os.path.isabs(name) or ".." in name.split("/"):
        print("REQUIRED_PLUGIN_BAD_LINE: %s line %d names %s, which is not a relative path inside the project" % (listing, number, name), file=sys.stderr)
        sys.exit(2)
    seen += 1
    if not os.path.isfile(name):
        print("REQUIRED_PLUGIN_MISSING: %s line %d requires %s, which is not a file" % (listing, number, name), file=sys.stderr)
        sys.exit(2)
    actual = hashlib.sha256(open(name, "rb").read()).hexdigest()
    if actual != digest:
        print("REQUIRED_PLUGIN_CHANGED: %s line %d: %s has SHA-256 %s, not %s" % (listing, number, name, actual, digest), file=sys.stderr)
        sys.exit(2)
if seen == 0:
    print("REQUIRED_PLUGIN_LIST_EMPTY: %s lists no plugin to check" % listing, file=sys.stderr)
    sys.exit(2)
PY
fi
if [ -f .opencode/opencode.json ]; then
  python3 "$script_dir/brief-denied-text.py" .opencode/opencode.json "$document" || exit 2
fi
if [ "$mode" = new ]; then
  stop=$(python3 "$script_dir/stop-file.py" pick "$brief") || exit 2
elif [ -e "$stop" ]; then
  echo "STOP_FILE_EXISTS: $stop already exists; name a new stop file for this run" >&2
  exit 2
fi
if [ "$mode" = new ] && [ -d .agents/tasks ] && [ -f "$longtask" ]; then
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
  else
    if [ -n "$task" ]; then
      python3 "$longtask" check-brief "$brief" --task "$task" || { echo "check-brief refused the brief" >&2; exit 2; }
    else
      python3 "$longtask" check-brief "$brief" || { echo "check-brief refused the brief" >&2; exit 2; }
    fi
  fi
fi

for suffix in jsonl err pid rc; do
  if [ -e "$prefix.$suffix" ]; then
    echo "refusing to overwrite $prefix.$suffix; use a new run prefix" >&2
    exit 2
  fi
done
mkdir -p "$(dirname "$prefix")"
server_dir=${OC_SERVER_DIR:-$(dirname "$prefix")/oc-server}
bash "$script_dir/oc-server.sh" start "$server_dir" >&2 || { echo "the task's opencode server is not available" >&2; exit 3; }
server_url=$(cat "$server_dir/url")
OPENCODE_PASSWORD=$(cat "$server_dir/password")
export OPENCODE_PASSWORD

floor_file=${OC_VARIANT_FLOOR:-}
[ -n "$floor_file" ] || [ ! -f .opencode/variant-floor.txt ] || floor_file=.opencode/variant-floor.txt
live_file=$(mktemp "${TMPDIR:-/tmp}/oc-live-models.XXXXXX")
"$opencode_bin" api --server "$server_url" GET /api/model > "$live_file" 2>/dev/null
variant_report=$(python3 -I - "$model" "$floor_file" "$live_file" <<'PY'
import json
import sys

requested = sys.argv[1]
floor_path = sys.argv[2]
model_id, _, variant = requested.partition("#")
try:
    with open(sys.argv[3], encoding="utf-8") as live_listing:
        listing = json.load(live_listing)
    served = {f"{m['providerID']}/{m['id']}": [v["id"] for v in (m.get("variants") or [])] for m in listing["data"]}
except Exception as error:
    print(f"VARIANT_LIST_UNAVAILABLE: the server's model list could not be read ({type(error).__name__})")
    sys.exit(3)
if model_id not in served:
    print(f"MODEL_NOT_SERVED: {model_id} is not in the server's model list")
    sys.exit(2)
live = served[model_id]
shown = ",".join(live) if live else "none"
if variant and variant not in live:
    print(f"VARIANT_UNAVAILABLE: {requested}; live variants: {shown}")
    sys.exit(2)
floor = ""
if floor_path:
    for line in open(floor_path, encoding="utf-8"):
        parts = line.split()
        if len(parts) == 2 and not parts[0].startswith("#") and parts[0] == model_id:
            floor = parts[1]
notes = [f"LIVE_VARIANTS model={model_id} variants={','.join(live)}"]
if floor and not live:
    notes.append(f"VARIANT_FLOOR_IGNORED model={model_id} floor={floor} (the server lists no variants)")
elif floor:
    if floor not in live:
        print(f"VARIANT_FLOOR_UNKNOWN: floor {floor} for {model_id} is not a live variant: {shown}")
        sys.exit(2)
    if not variant:
        print(f"VARIANT_BELOW_FLOOR: {model_id} has no variant, floor {floor}; live variants: {shown}")
        sys.exit(2)
    if live.index(variant) < live.index(floor):
        print(f"VARIANT_BELOW_FLOOR: {requested} is below the floor {floor}; live variants: {shown}")
        sys.exit(2)
print("\n".join(notes))
PY
)
variant_rc=$?
rm -f "$live_file"
if [ "$variant_rc" -ne 0 ]; then
  echo "$variant_report" >&2
  exit "$variant_rc"
fi
echo "$variant_report"

nohup bash "$script_dir/oc-run.sh" "$prefix" "$stop" "$model" "$server_url" "${OC_AUTO_RESUMES:-2}" "$opencode_bin" "$1" --server "$server_url" "${@:2}" > /dev/null 2>&1 &
echo $! > "$prefix.pid"
pid=$(cat "$prefix.pid")

elapsed=0
while [ "$elapsed" -lt "$startup" ]; do
  if [ -s "$prefix.jsonl" ]; then
    session_id=$(head -1 "$prefix.jsonl" | python3 -c 'import json,sys; print(json.loads(sys.stdin.readline()).get("sessionID",""))' 2>/dev/null)
    echo "started pid=$pid session=$session_id model=$model"
    if grep -q -E '"type": ?"error"' "$prefix.jsonl"; then
      echo "first events contain an error:" >&2
      grep -E '"type": ?"error"' "$prefix.jsonl" | head -1 | cut -c1-400 >&2
      exit 4
    fi
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "opencode exited before any event (rc=$(cat "$prefix.rc" 2>/dev/null || echo unknown)); stderr:" >&2
    tail -20 "$prefix.err" >&2
    exit 4
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

echo "no event within ${startup}s; stopping pid $pid (startup stall, no session work was lost)" >&2
pkill -P "$pid" 2>/dev/null
kill "$pid" 2>/dev/null
exit 3
