#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: codex-session.sh <log|status|stop> <session-uuid> [--force]" >&2
  echo "       codex-session.sh new <file-written-just-before-launch> [timeout-seconds=120]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
cmd=$1

if [ "$cmd" = "new" ]; then
  since=$2
  [ -e "$since" ] || { echo "no such file: $since" >&2; exit 1; }
  deadline=$(( $(date +%s) + ${3:-120} ))
  since_stamp=$(date -r "$since" +%Y-%m-%dT%H-%M-%S)
  while :; do
    found=""
    while IFS= read -r candidate; do
      started=$(basename "$candidate" | sed -E 's/^rollout-([0-9T-]{19})-.*/\1/')
      [[ "$started" < "$since_stamp" ]] && continue
      grep -Eq '"model": *"codex-auto-review"' "$candidate" && continue
      if grep -q '"turn_context"' "$candidate"; then found=$candidate; break; fi
    done < <(find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -newer "$since" 2>/dev/null | sort)
    [ -n "$found" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || { echo "no new session log with a turn after $since" >&2; exit 1; }
    sleep 3
  done
  new_id=$(basename "$found" .jsonl | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  echo "session: $new_id"
  exec "$0" status "$new_id"
fi

id=$2
force=${3:-}

log=$(find "$HOME/.codex/sessions" -name "rollout-*-${id}.jsonl" -print 2>/dev/null | head -1)
[ -n "$log" ] || { echo "no session log for $id" >&2; exit 1; }

native_pids() { lsof -t "$log" 2>/dev/null || true; }

last_type() {
  tail -1 "$log" | python3 -c 'import json,sys
d=json.loads(sys.stdin.read())
p=d.get("payload") or {}
print(p.get("type") or d.get("type"))'
}

idle_seconds() { echo $(( $(date +%s) - $(stat -f %m "$log") )); }

case "$cmd" in
  log)
    echo "$log"
    ;;
  status)
    echo "log: $log"
    echo "modified: $(stat -f '%Sm' "$log") ($(idle_seconds)s ago)"
    echo "last event: $(last_type)"
    pids=$(native_pids)
    if [ -n "$pids" ]; then
      for p in $pids; do ps -o pid=,ppid=,etime= -p "$p" | awk '{print "process: pid " $1 " parent " $2 " elapsed " $3}'; done
    else
      echo "process: none holds the log open"
    fi
    python3 - "$log" <<'PY'
import json, sys
ctx = tier = usage = None
for line in open(sys.argv[1]):
    if '"turn_context"' in line or '"service_tier"' in line or '"token_count"' in line:
        d = json.loads(line)
        p = d.get("payload") or {}
        if d.get("type") == "turn_context":
            ctx = p
        if "service_tier" in line:
            t = (
                p.get("service_tier")
                or (p.get("info") or {}).get("service_tier")
                or (p.get("thread_settings") or {}).get("service_tier")
            )
            tier = t or tier
        if p.get("type") == "token_count" and p.get("info"):
            usage = p["info"].get("total_token_usage") or usage
if ctx:
    print(f"model: {ctx.get('model')}  effort: {ctx.get('effort')}  approval: {ctx.get('approval_policy')}")
missing = 'not in log (check the TUI footer: fast shows as "fast")'
print(f"service_tier: {tier or missing}")
if usage:
    i, c, o = usage.get("input_tokens", 0), usage.get("cached_input_tokens", 0), usage.get("output_tokens", 0)
    rate = f"{c / i:.1%}" if i else "n/a"
    print(f"tokens: input {i:,}  cached {c:,} ({rate})  output {o:,}")
PY
    ;;
  stop)
    pids=$(native_pids)
    [ -n "$pids" ] || { echo "no running process for $id"; exit 0; }
    if [ "$force" != "--force" ] && { [ "$(last_type)" != "task_complete" ] || [ "$(idle_seconds)" -lt 30 ]; }; then
      echo "refusing: last event is $(last_type), log idle $(idle_seconds)s; Codex may be working; pass --force to stop anyway" >&2
      exit 1
    fi
    for p in $pids; do
      parent=$(ps -o ppid= -p "$p" | tr -d ' ')
      if ps -o command= -p "$parent" | grep -q "codex"; then target=$parent; else target=$p; fi
      kill -TERM "$target"
      echo "sent TERM to $target"
    done
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -z "$(native_pids)" ] && { echo "stopped"; exit 0; }
      sleep 1
    done
    echo "still running after 10s" >&2
    exit 1
    ;;
  *)
    usage
    ;;
esac
