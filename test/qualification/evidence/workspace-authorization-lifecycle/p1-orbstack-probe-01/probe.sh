#!/bin/bash
set -euo pipefail
root=/private/tmp/himawari-p1-orbstack-20260923-01
workspace="$root/workspace"
name=himawari-p1-setsid-stop-20260923
image=docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
mkdir -m 700 "$workspace"
test -z "$(/usr/local/bin/docker --context orbstack ps -aq --filter "name=^${name}$")"
/usr/local/bin/docker --context orbstack run --detach --name "$name" --restart=no --network none --mount "type=bind,source=$workspace,target=/probe" "$image" sh -c '
  setsid sh -c "echo \$\$ > /probe/child.pid; while :; do printf x >> /probe/writes.log; sleep 0.05; done" >/dev/null 2>&1 &
  echo $$ > /probe/leader.pid
  touch /probe/ready
  wait
' > "$root/container-id.txt"
for _ in $(seq 1 200); do
  if test -s "$workspace/child.pid" && test -s "$workspace/writes.log"; then break; fi
  sleep 0.05
done
test -s "$workspace/child.pid"
test -s "$workspace/writes.log"
leader=$(cat "$workspace/leader.pid")
child=$(cat "$workspace/child.pid")
processes=$(/usr/local/bin/docker --context orbstack exec "$name" sh -c "cat /proc/$leader/stat; cat /proc/$child/stat" | awk '{print $1, $5, $6}')
printf '%s\n' "$processes" > "$root/process-groups.txt"
leader_group=$(printf '%s\n' "$processes" | awk 'NR==1 {print $2}')
leader_session=$(printf '%s\n' "$processes" | awk 'NR==1 {print $3}')
child_group=$(printf '%s\n' "$processes" | awk 'NR==2 {print $2}')
child_session=$(printf '%s\n' "$processes" | awk 'NR==2 {print $3}')
test "$leader_group" != "$child_group"
test "$leader_session" != "$child_session"
initial_count=$(wc -c < "$workspace/writes.log" | tr -d ' ')
test "$initial_count" -gt 0
/usr/local/bin/docker --context orbstack stop --signal TERM --time 2 "$name" > "$root/stop-result.txt"
printf '%s\n' "$(/usr/local/bin/docker --context orbstack inspect --format '{{.State.Status}} {{.State.Running}} {{.State.Pid}} {{.State.ExitCode}}' "$name")" > "$root/container-state.txt"
count_at_stop=$(wc -c < "$workspace/writes.log" | tr -d ' ')
sleep 1
count_after_quiescence=$(wc -c < "$workspace/writes.log" | tr -d ' ')
printf 'initial=%s\nafter_stop=%s\nafter_quiescence=%s\n' "$initial_count" "$count_at_stop" "$count_after_quiescence" > "$root/write-counts.txt"
test "$(cat "$root/container-state.txt")" = 'exited false 0 137'
test "$count_at_stop" = "$count_after_quiescence"
/usr/local/bin/docker --context orbstack rm "$name" > "$root/remove-result.txt"
printf 'PASS\n' > "$root/result.txt"
