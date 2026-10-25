#!/usr/bin/env bash
set -u

usage() {
  cat >&2 <<'EOF'
usage:
  oc-steer.sh <run prefix> <message file>
  oc-steer.sh <run prefix> <message file> --interrupt <next stop file> <next run prefix> <provider/model>
The first form sends the message to the running session; opencode reads it
after its current step and follows it without stopping. A step that is one long
command finishes first.
--interrupt stops the current step at once, waits for the run to end
(OC_INTERRUPT_SECONDS, default 30), then resumes the same session with the
message through oc-launch.sh. Use it when the running step itself is the waste.
The message file is the record; each send is appended to <prefix>.steer.log.
EOF
  exit 2
}

[ $# -eq 2 ] || { [ $# -eq 6 ] && [ "$3" = "--interrupt" ]; } || usage
prefix=$1
message=$2
[ -f "$message" ] || { echo "message file not found: $message (write the message to a file first; it is the record)" >&2; exit 2; }
[ -f "$prefix.jsonl" ] || { echo "no run at $prefix" >&2; exit 2; }
if [ -e "$prefix.rc" ]; then
  echo "the run at $prefix has ended; continue the session with oc-launch.sh resume instead" >&2
  exit 2
fi
session=$(head -1 "$prefix.jsonl" | python3 -c 'import json,sys; print(json.loads(sys.stdin.readline()).get("sessionID",""))' 2>/dev/null)
[ -n "$session" ] || { echo "no session id in $prefix.jsonl yet" >&2; exit 2; }
server_dir=${OC_SERVER_DIR:-$(dirname "$prefix")/oc-server}
[ -f "$server_dir/url" ] && [ -f "$server_dir/password" ] || { echo "no task server state in $server_dir" >&2; exit 2; }
script_dir=$(cd "$(dirname "$0")" && pwd)
opencode_bin=${OC_OPENCODE:-opencode}
url=$(cat "$server_dir/url")
OPENCODE_PASSWORD=$(cat "$server_dir/password")
export OPENCODE_PASSWORD
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ $# -eq 2 ]; then
  body=$(python3 - "$message" <<'EOF'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    text = handle.read()
print(json.dumps({"text": f"Message from the supervisor (recorded at {path}). Follow it before continuing:\n\n{text}", "delivery": "steer"}))
EOF
)
  "$opencode_bin" api --server "$url" POST "/api/session/$session/prompt" -d "$body" > /dev/null || {
    echo "sending the message failed" >&2
    exit 1
  }
  printf '%s steer %s %s\n' "$stamp" "$session" "$message" >> "$prefix.steer.log"
  echo "sent to $session: $message"
  exit 0
fi

next_stop=$4
next_prefix=$5
model=$6
"$opencode_bin" api --server "$url" POST "/api/session/$session/interrupt" > /dev/null || {
  echo "interrupting the current step failed" >&2
  exit 1
}
limit=${OC_INTERRUPT_SECONDS:-30}
waited=0
while [ ! -e "$prefix.rc" ]; do
  if [ "$waited" -ge "$limit" ]; then
    echo "the run at $prefix did not end within ${limit}s after the interrupt; nothing was resumed" >&2
    exit 3
  fi
  sleep 1
  waited=$((waited + 1))
done
printf '%s interrupt %s %s -> %s\n' "$stamp" "$session" "$message" "$next_prefix" >> "$prefix.steer.log"
bash "$script_dir/oc-launch.sh" resume "$session" "$message" "$next_stop" "$next_prefix" "$model"
