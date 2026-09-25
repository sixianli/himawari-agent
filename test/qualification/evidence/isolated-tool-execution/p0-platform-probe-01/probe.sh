#!/bin/bash
set -uo pipefail

if [ $# -ne 2 ]; then
  echo "usage: DOCKER='docker --context orbstack' probe.sh <output-dir> <scratch-root>" >&2
  exit 2
fi
OUT=$1
ROOT=$2
DOCKER=${DOCKER:-docker}
IMAGE=${IMAGE:-docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e}
PREFIX=himawari-p0-$(date -u +%Y%m%d%H%M%S)
HOST_OS=$(uname)
TASK_USER=2002:2002
INIT_USER=2001:2001

mkdir -p "$OUT"
test ! -e "$ROOT" || { echo "scratch root already exists: $ROOT" >&2; exit 2; }
mkdir -p "$ROOT"
chmod 777 "$ROOT"
: > "$OUT/summary.tsv"
printf 'check\tverdict\tobserved\n' >> "$OUT/summary.tsv"

record() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$OUT/summary.tsv"; }
d() { $DOCKER "$@"; }
workdir() { mkdir -p "$ROOT/$1"; chmod 777 "$ROOT/$1"; printf '%s' "$ROOT/$1"; }
size_of() { if [ -e "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi; }
host_inode_links() {
  if [ "$HOST_OS" = Darwin ]; then stat -f '%i %l' "$1"; else stat -c '%i %h' "$1"; fi
}
SEC=(--restart=no --network none --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 64 --memory 256m --read-only --tmpfs /tmp:rw,size=16m,mode=1777
  --label "himawari.probe=$PREFIX")

{
  echo "prefix=$PREFIX"
  echo "started_at=$(date -u +%FT%TZ)"
  echo "host=$(uname -srm)"
  if [ "$HOST_OS" = Darwin ]; then sw_vers | tr '\n' ' '; echo; fi
  echo "image=$IMAGE"
  d version --format 'client={{.Client.Version}} server={{.Server.Version}} api={{.Server.APIVersion}}'
  d info --format 'os={{.OperatingSystem}} kernel={{.KernelVersion}} arch={{.Architecture}} storage={{.Driver}} cgroup_driver={{.CgroupDriver}} cgroup_version={{.CgroupVersion}} default_runtime={{.DefaultRuntime}} security={{json .SecurityOptions}}'
  d image inspect "$IMAGE" --format 'image_id={{.Id}} arch={{.Architecture}}'
  if [ "$HOST_OS" = Darwin ]; then
    dev=$(df "$ROOT" | tail -1 | awk '{print $1}')
    echo "scratch_fs=$(diskutil info "$dev" | grep -E 'File System Personality' | sed 's/.*: *//')"
  else
    echo "scratch_fs=$(findmnt -n -T "$ROOT" -o FSTYPE,OPTIONS)"
  fi
} > "$OUT/environment.txt" 2>&1

life=$(workdir life)
d run -d --name "$PREFIX-life" "${SEC[@]}" --user "$TASK_USER" \
  --mount "type=bind,source=$life,target=/work" "$IMAGE" sh -c '
  setsid sh -c "while :; do printf a >> /work/setsid.log; sleep 0.05; done" </dev/null >/dev/null 2>&1 &
  sh -c "(sh -c \"while :; do printf b >> /work/double-fork.log; sleep 0.05; done\" </dev/null >/dev/null 2>&1 &); exit 0"
  setsid sh -c "exec 0<&- 1>&- 2>&-; while :; do printf c >> /work/daemon.log; sleep 0.05; done" &
  exec sleep 3600' > "$OUT/life-container-id.txt" 2> "$OUT/life-run.err"
for _ in $(seq 1 100); do
  [ -s "$life/setsid.log" ] && [ -s "$life/double-fork.log" ] && [ -s "$life/daemon.log" ] && break
  sleep 0.1
done
d top "$PREFIX-life" -o pid,ppid,pgid,sid,user,args > "$OUT/life-processes-before-stop.txt" 2>&1
d inspect "$PREFIX-life" --format 'id={{.Id}} image={{.Image}} restart={{.HostConfig.RestartPolicy.Name}} readonly_rootfs={{.HostConfig.ReadonlyRootfs}} cap_drop={{json .HostConfig.CapDrop}} security_opt={{json .HostConfig.SecurityOpt}} pids_limit={{.HostConfig.PidsLimit}} memory={{.HostConfig.Memory}} network={{.HostConfig.NetworkMode}}' > "$OUT/life-inspect.txt"
before="$(size_of "$life/setsid.log") $(size_of "$life/double-fork.log") $(size_of "$life/daemon.log")"
d stop --time 2 "$PREFIX-life" > /dev/null
at_stop="$(size_of "$life/setsid.log") $(size_of "$life/double-fork.log") $(size_of "$life/daemon.log")"
sleep 3
later="$(size_of "$life/setsid.log") $(size_of "$life/double-fork.log") $(size_of "$life/daemon.log")"
state=$(d inspect "$PREFIX-life" --format '{{.State.Status}} running={{.State.Running}} pid={{.State.Pid}} exit={{.State.ExitCode}} restarts={{.RestartCount}}')
exec_after=$(d exec "$PREFIX-life" true 2>&1; echo "rc=$?")
printf 'bytes_before_stop(setsid double_fork daemon)=%s\nbytes_at_stop=%s\nbytes_3s_later=%s\nstate_3s_later=%s\nexec_after_stop=%s\n' \
  "$before" "$at_stop" "$later" "$state" "$exec_after" > "$OUT/life-result.txt"
case "$before" in *" 0"*|"0 "*) record life.writers_started fail "$before" ;; *) record life.writers_started pass "$before" ;; esac
[ "$at_stop" = "$later" ] && record life.all_writers_stopped pass "at_stop=[$at_stop] later=[$later]" || record life.all_writers_stopped fail "at_stop=[$at_stop] later=[$later]"
case "$state" in "exited running=false pid=0"*"restarts=0") record life.stays_stopped_no_restart pass "$state" ;; *) record life.stays_stopped_no_restart fail "$state" ;; esac
case "$exec_after" in *"rc=0") record life.exec_rejected_after_stop fail "$exec_after" ;; *) record life.exec_rejected_after_stop pass "$(echo "$exec_after" | tr '\n' ' ')" ;; esac

quota=$(workdir quota)
tmpfs_out=$(d run --rm "${SEC[@]}" --user "$TASK_USER" "$IMAGE" sh -c 'dd if=/dev/zero of=/tmp/fill bs=1048576 count=32 2>&1 | tail -1; echo "tmp_bytes=$(wc -c < /tmp/fill)"' 2>&1)
echo "$tmpfs_out" > "$OUT/quota-tmpfs.txt"
tmp_bytes=$(echo "$tmpfs_out" | sed -n 's/^tmp_bytes=//p')
[ -n "$tmp_bytes" ] && [ "$tmp_bytes" -le 16777216 ] && record quota.task_tmpfs_16m pass "wrote=${tmp_bytes}B of 32MiB requested" || record quota.task_tmpfs_16m fail "$tmpfs_out"
storage_opt=$(d run --rm --storage-opt size=64m --label "himawari.probe=$PREFIX" "$IMAGE" sh -c 'dd if=/dev/zero of=/fill bs=1048576 count=96 2>&1 | tail -1; echo "rootfs_bytes=$(wc -c < /fill)"' 2>&1; echo "rc=$?")
echo "$storage_opt" > "$OUT/quota-storage-opt.txt"
rootfs_bytes=$(echo "$storage_opt" | sed -n 's/^rootfs_bytes=//p')
if [ -z "$rootfs_bytes" ]; then
  record quota.rootfs_storage_opt rejected "$(echo "$storage_opt" | tr '\n' ' ' | cut -c1-240)"
elif [ "$rootfs_bytes" -le 67108864 ]; then
  record quota.rootfs_storage_opt enforced "rootfs_bytes=$rootfs_bytes of 96MiB requested"
else
  record quota.rootfs_storage_opt accepted_not_enforced "option accepted but container wrote rootfs_bytes=$rootfs_bytes past 64MiB"
fi
bind_out=$(d run --rm "${SEC[@]}" --user "$TASK_USER" --mount "type=bind,source=$quota,target=/work" "$IMAGE" sh -c 'dd if=/dev/zero of=/work/fill bs=1048576 count=96 2>&1 | tail -1' 2>&1)
bind_bytes=$(size_of "$quota/fill")
printf '%s\nhost_bytes=%s\n' "$bind_out" "$bind_bytes" > "$OUT/quota-bind-mount.txt"
[ "$bind_bytes" -lt 100663296 ] && record quota.bind_mount_64m_runtime_only pass "host_bytes=$bind_bytes" || record quota.bind_mount_64m_runtime_only fail "no runtime option limits a bind mount; container wrote host_bytes=$bind_bytes (96MiB) past an intended 64MiB limit"
rm -f "$quota/fill"

mask=$(workdir mask)
printf 'FAKE_SECRET_ENV\n' > "$mask/.env"
mkdir -p "$mask/secrets"; printf 'FAKE_SECRET_KEY\n' > "$mask/secrets/key.pem"
printf 'normal\n' > "$mask/normal.txt"
ln -s .env "$mask/link-to-env"
ln "$mask/.env" "$mask/hardlink-to-env"
: > "$ROOT/empty-mask"; chmod 444 "$ROOT/empty-mask"
chmod -R a+rwX "$mask"
d run -d --name "$PREFIX-mask" "${SEC[@]}" --user "$TASK_USER" \
  --mount "type=bind,source=$mask,target=/work" \
  --mount "type=bind,source=$ROOT/empty-mask,target=/work/.env,readonly" \
  --mount "type=tmpfs,destination=/work/secrets,tmpfs-size=1048576" \
  "$IMAGE" sleep 120 > /dev/null 2> "$OUT/mask-run.err"
printf 'FAKE_SECRET_LATE\n' > "$mask/late.env"
d exec "$PREFIX-mask" sh -c '
  echo "env=[$(cat /work/.env 2>&1)]"
  echo "secrets_dir=[$(ls -A /work/secrets 2>&1)]"
  echo "key=[$(cat /work/secrets/key.pem 2>&1)]"
  echo "symlink=[$(cat /work/link-to-env 2>&1)]"
  echo "hardlink=[$(cat /work/hardlink-to-env 2>&1)]"
  echo "late=[$(cat /work/late.env 2>&1)]"
  echo "umount=[$(umount /work/.env 2>&1; echo rc=$?)]"
  echo "rm_mask=[$(rm -f /work/.env 2>&1; echo rc=$?)]"
  echo "mv_mask=[$(mv /work/secrets /work/moved 2>&1; echo rc=$?)]"
  echo "write_mask=[$(sh -c "echo x > /work/.env" 2>&1; echo rc=$?)]"
' > "$OUT/mask-result.txt" 2>&1
d rm -f "$PREFIX-mask" > /dev/null
grep -q '^env=\[\]' "$OUT/mask-result.txt" && record mask.file_overlay pass "$(grep '^env=' "$OUT/mask-result.txt")" || record mask.file_overlay fail "$(grep '^env=' "$OUT/mask-result.txt")"
grep -q '^key=\[.*No such file' "$OUT/mask-result.txt" && record mask.dir_overlay pass "$(grep '^key=' "$OUT/mask-result.txt")" || record mask.dir_overlay fail "$(grep '^key=' "$OUT/mask-result.txt")"
grep -q '^symlink=\[\]' "$OUT/mask-result.txt" && record mask.symlink_follows_mask pass "$(grep '^symlink=' "$OUT/mask-result.txt")" || record mask.symlink_follows_mask fail "$(grep '^symlink=' "$OUT/mask-result.txt")"
grep -q 'FAKE_SECRET_ENV' <(grep '^hardlink=' "$OUT/mask-result.txt") && record mask.hardlink_bypass fail "hard link under another name exposes the masked content; path masks cannot cover it" || record mask.hardlink_bypass pass "$(grep '^hardlink=' "$OUT/mask-result.txt")"
grep -q 'FAKE_SECRET_LATE' <(grep '^late=' "$OUT/mask-result.txt") && record mask.file_created_after_start fail "a sensitive file added after creation is visible; masks are fixed at create time" || record mask.file_created_after_start pass "$(grep '^late=' "$OUT/mask-result.txt")"
grep -Eq '^(umount|rm_mask|mv_mask|write_mask)=\[.*rc=0\]' "$OUT/mask-result.txt" && record mask.task_cannot_remove_mask fail "$(grep -E '^(umount|rm_mask|mv_mask|write_mask)=' "$OUT/mask-result.txt" | tr '\n' ' ')" || record mask.task_cannot_remove_mask pass "$(grep -E '^(umount|rm_mask|mv_mask|write_mask)=' "$OUT/mask-result.txt" | tr '\n' ' ' | cut -c1-240)"

ident=$(workdir ident)
printf 'upper\n' > "$ident/Foo.txt"
printf 'one\n' > "$ident/h1"; ln "$ident/h1" "$ident/h2"
printf 'OUTSIDE\n' > "$ROOT/outside.txt"
ln -s ../outside.txt "$ident/rel-escape"
ln -s "$ROOT/outside.txt" "$ident/abs-link"
chmod -R a+rwX "$ident"
host_foo=$(host_inode_links "$ident/Foo.txt")
host_h1=$(host_inode_links "$ident/h1")
d run --rm "${SEC[@]}" --user "$TASK_USER" --mount "type=bind,source=$ident,target=/work" "$IMAGE" sh -c '
  echo "foo=$(stat -c "%i %h" /work/Foo.txt)"
  echo "h1=$(stat -c "%i %h" /work/h1)"
  echo "h2=$(stat -c "%i %h" /work/h2)"
  echo "lower_case_lookup=[$(cat /work/foo.txt 2>&1)]"
  touch /work/bar.txt /work/BAR.txt
  echo "case_pair_entries=$(ls /work | grep -ci "^bar.txt$")"
  ln /work/Foo.txt /work/Foo-container-link && echo "container_link=$(stat -c "%i %h" /work/Foo-container-link)"
  echo "rel_escape=[$(cat /work/rel-escape 2>&1)]"
  echo "abs_link=[$(cat /work/abs-link 2>&1)]"
' > "$OUT/identity-container.txt" 2>&1
host_case_pair=$(ls "$ident" | grep -ci '^bar.txt$')
host_link=$(host_inode_links "$ident/Foo-container-link" 2>/dev/null || echo missing)
printf 'host_foo=%s\nhost_h1=%s\nhost_case_pair_entries=%s\nhost_container_link=%s\nhost_rel_escape=[%s]\nhost_abs_link_target=[%s]\n' \
  "$host_foo" "$host_h1" "$host_case_pair" "$host_link" "$(cat "$ident/rel-escape")" "$(cat "$ident/abs-link")" > "$OUT/identity-host.txt"
c_foo=$(sed -n 's/^foo=//p' "$OUT/identity-container.txt")
c_h1=$(sed -n 's/^h1=//p' "$OUT/identity-container.txt")
c_h2=$(sed -n 's/^h2=//p' "$OUT/identity-container.txt")
c_case=$(sed -n 's/^case_pair_entries=//p' "$OUT/identity-container.txt")
c_link=$(sed -n 's/^container_link=//p' "$OUT/identity-container.txt")
[ "$c_foo" = "$host_foo" ] && record identity.inode_and_links_match pass "host=$host_foo container=$c_foo" || record identity.inode_and_links_match fail "host=$host_foo container=$c_foo"
[ "$c_h1" = "$host_h1" ] && [ "$c_h1" = "$c_h2" ] && record identity.host_hardlink_seen_in_container pass "host=$host_h1 container=$c_h1/$c_h2" || record identity.host_hardlink_seen_in_container fail "host=$host_h1 container=$c_h1/$c_h2"
[ "$c_link" = "$host_link" ] && record identity.container_hardlink_seen_on_host pass "container=$c_link host=$host_link" || record identity.container_hardlink_seen_on_host fail "container=$c_link host=$host_link"
[ "$c_case" = "$host_case_pair" ] && record identity.case_rules_match pass "container_entries=$c_case host_entries=$host_case_pair $(grep '^lower_case_lookup' "$OUT/identity-container.txt")" || record identity.case_rules_match fail "container_entries=$c_case host_entries=$host_case_pair $(grep '^lower_case_lookup' "$OUT/identity-container.txt")"
grep -q 'OUTSIDE' "$OUT/identity-container.txt" && record identity.symlink_resolution_matches pass "relative escape resolves the same way" || record identity.symlink_resolution_matches fail "host resolves rel-escape to OUTSIDE and abs-link to the host file; container resolves both inside its own filesystem: $(grep -E '^(rel_escape|abs_link)=' "$OUT/identity-container.txt" | tr '\n' ' ' | cut -c1-200)"

init=$(workdir init)
DEADLINE=25
start=$(date +%s)
d run -d --name "$PREFIX-init" "${SEC[@]}" --user "$INIT_USER" \
  --mount "type=bind,source=$init,target=/work" "$IMAGE" sleep "$DEADLINE" > "$OUT/init-container-id.txt" 2> "$OUT/init-run.err"
d exec -d --user "$TASK_USER" "$PREFIX-init" setsid sh -c 'while :; do printf d >> /work/writer.log; sleep 0.05; done' </dev/null
d exec --user "$TASK_USER" "$PREFIX-init" sh -c '
  echo "task_identity=$(id)"
  echo "init=$(ps -o pid,user,args | awk "\$1==1")"
  grep -E "^(NoNewPrivs|CapEff|CapPrm|CapBnd)" /proc/self/status | tr "\t" " "
  echo "kill_KILL=[$(kill -KILL 1 2>&1; echo rc=$?)]"
  echo "kill_TERM=[$(kill -TERM 1 2>&1; echo rc=$?)]"
  echo "kill_STOP=[$(kill -STOP 1 2>&1; echo rc=$?)]"
  out=$(dd if=/proc/1/mem of=/dev/null bs=1 count=1 2>&1); rc=$?; echo "ptrace_mem=[$(echo "$out" | head -1) rc=$rc]"
  out=$(cat /proc/1/environ 2>&1 >/dev/null); rc=$?; echo "ptrace_environ=[$out rc=$rc]"
  out=$(ls -l /proc/1/exe 2>&1); rc=$?; echo "ptrace_exe=[$(echo "$out" | sed "s/.*-> /target=/") rc=$rc]"
  echo "ptrace_scope=[$(cat /proc/sys/kernel/yama/ptrace_scope 2>&1)]"
  echo "replace_init=[$(sh -c "echo x > /bin/sleep" 2>&1; echo rc=$?)]"
  echo "remove_init=[$(rm -f /bin/sleep 2>&1; echo rc=$?)]"
  echo "write_proc1=[$(sh -c "echo 0 > /proc/1/oom_score_adj" 2>&1; echo rc=$?)]"
  echo "remount=[$(mount -o remount,rw / 2>&1; echo rc=$?)]"
  echo "set_clock=[$(date -s "2030-01-01 00:00:00" 2>&1; echo rc=$?)]"
  echo "docker_socket=[$(ls -l /var/run/docker.sock /run/docker.sock 2>&1 | tr "\n" " ")]"
  echo "init_alive_after=$(ps -o pid,args | awk "\$1==1")"
' > "$OUT/init-attacks.txt" 2>&1
while [ "$(d inspect -f '{{.State.Running}}' "$PREFIX-init" 2>/dev/null)" = true ]; do
  [ $(( $(date +%s) - start )) -gt $(( DEADLINE + 30 )) ] && break
  sleep 0.5
done
end=$(date +%s)
w1=$(size_of "$init/writer.log"); sleep 2; w2=$(size_of "$init/writer.log")
istate=$(d inspect "$PREFIX-init" --format '{{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}')
printf 'deadline=%ss observed_host_seconds=%s\nstate=%s\nwriter_bytes_at_exit=%s writer_bytes_2s_later=%s\n' "$DEADLINE" "$((end - start))" "$istate" "$w1" "$w2" > "$OUT/init-deadline.txt"
for k in kill_KILL kill_TERM kill_STOP ptrace_mem ptrace_environ ptrace_exe replace_init remove_init write_proc1 remount set_clock; do
  line=$(grep "^$k=" "$OUT/init-attacks.txt")
  if [ -z "$line" ] || echo "$line" | grep -q 'rc=0\]$'; then
    record "init.$k" fail "${line:-missing}"
  elif echo "$line" | grep -Eqi 'denied|not permitted|read-only|are you root'; then
    record "init.$k" pass "$(echo "$line" | cut -c1-200)"
  else
    record "init.$k" inconclusive "$(echo "$line" | cut -c1-200)"
  fi
done
grep -q '^init_alive_after=.*sleep' "$OUT/init-attacks.txt" && record init.alive_after_attacks pass "$(grep '^init_alive_after' "$OUT/init-attacks.txt")" || record init.alive_after_attacks fail "$(grep '^init_alive_after' "$OUT/init-attacks.txt")"
elapsed=$((end - start))
[ "$elapsed" -ge "$DEADLINE" ] && [ "$elapsed" -le $((DEADLINE + 5)) ] && [ "$w1" -gt 0 ] && [ "$w1" = "$w2" ] \
  && record init.deadline_stops_whole_environment pass "elapsed=${elapsed}s writer=$w1/$w2 $istate" \
  || record init.deadline_stops_whole_environment fail "elapsed=${elapsed}s writer=$w1/$w2 $istate"

pause=$(workdir pause)
start=$(date +%s)
d run -d --name "$PREFIX-pause" "${SEC[@]}" --user "$INIT_USER" "$IMAGE" sleep 20 > /dev/null
sleep 5; d pause "$PREFIX-pause" > /dev/null; sleep 20; d unpause "$PREFIX-pause" > /dev/null
while [ "$(d inspect -f '{{.State.Running}}' "$PREFIX-pause")" = true ]; do [ $(( $(date +%s) - start )) -gt 90 ] && break; sleep 0.5; done
record pause.freezer_deadline observed "sleep 20 with a 20s docker pause at t=5: exited after $(( $(date +%s) - start ))s host time"

d ps -a --filter "label=himawari.probe=$PREFIX" --format '{{.Names}} {{.Status}}' > "$OUT/containers-before-cleanup.txt"
d rm -f $(d ps -aq --filter "label=himawari.probe=$PREFIX") > /dev/null 2>&1
d ps -a --filter "label=himawari.probe=$PREFIX" --format '{{.Names}}' > "$OUT/containers-after-cleanup.txt"
[ -s "$OUT/containers-after-cleanup.txt" ] && record cleanup.probe_containers_removed fail "$(cat "$OUT/containers-after-cleanup.txt")" || record cleanup.probe_containers_removed pass "only containers labelled himawari.probe=$PREFIX were removed"
echo "finished_at=$(date -u +%FT%TZ)" >> "$OUT/environment.txt"
column -t -s $'\t' "$OUT/summary.tsv" | cut -c1-220
