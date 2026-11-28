import os
from pathlib import Path
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent

FAKE_NSPAWN = '''#!/bin/bash
if [ "$1" = --version ]; then
  echo "systemd 255 (255.4-1ubuntu8)"
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_LOG/nspawn.args"
if [ -n "$FAKE_NSPAWN_REFUSES" ]; then
  echo "$FAKE_NSPAWN_REFUSES" >&2
  exit 1
fi
for argument in "$@"; do
  case "$argument" in --directory=*) [ -z "$FAKE_SAVE_ROOT" ] || cp -r "${argument#--directory=}/etc" "$FAKE_LOG/root-etc" ;; esac
done
touch "$FAKE_LOG/machine.up"
sleep 30
'''

FAKE_SOCAT = '''#!/bin/bash
echo "socat $*" >> "$FAKE_LOG/calls"
echo $$ >> "$FAKE_LOG/socat.pids"
exec sleep 60
'''

FAKE_UNSHARE = '''#!/bin/bash
echo "unshare $*" >> "$FAKE_LOG/calls"
while [[ "$1" != /* ]]; do shift; done
exec "$@"
'''

FAKE_MOUNT = '''#!/bin/bash
echo "mount $*" >> "$FAKE_LOG/calls"
if [ "$2" = overlay ]; then
  target="${@: -1}"
  upper="${5#*upperdir=}"; upper="${upper%%,*}"
  stat -c %a "$upper" > "$FAKE_LOG/upper.mode"
  mkdir -p "$target/etc/cloud" "$target/etc/systemd/system"
  printf '# comment\\nLABEL=cloudimg-rootfs / ext4 defaults 0 1\\nLABEL=UEFI /boot/efi vfat umask=0077 0 1\\n' > "$target/etc/fstab"
fi
'''

FAKE_FINDMNT = '''#!/bin/bash
echo "/ ext4"
echo "/boot/efi vfat"
echo "/snap/core22/1 squashfs"
[ -z "$FAKE_SUBMOUNT" ] || echo "$FAKE_SUBMOUNT ext4"
'''

FAKE_MKFS = '''#!/bin/bash
echo "mkfs.ext4 $*" >> "$FAKE_LOG/calls"
'''

FAKE_MACHINECTL = '''#!/bin/bash
echo "machinectl $*" >> "$FAKE_LOG/calls"
case "$1" in
  show)
    [ -e "$FAKE_LOG/machine.up" ] || exit 1
    [[ " $* " == *" -p Leader --value "* ]] && echo 4242
    exit 0 ;;
  terminate) rm -f "$FAKE_LOG/machine.up"; pkill -f "$FAKE_LOG/tools/systemd-nspawn" || true ;;
esac
'''

FAKE_NSENTER = '''#!/bin/bash
echo "nsenter $*" >> "$FAKE_LOG/calls"
[ -e "$FAKE_LOG/machine.up" ] || exit 1
[[ "$1" == --target=4242 ]] || exit 65
while [[ "$1" != -- ]]; do shift; done
shift
export FAKE_INSIDE=1
if [[ "$1" == /usr/bin/env && "$2" == -i ]]; then
  shift 2
  inside=()
  while IFS= read -r name; do inside+=("$name=${!name}"); done < <(compgen -e | grep -E '^FAKE_')
  exec /usr/bin/env -i "${inside[@]}" "$@"
fi
exec "$@"
'''

FAKE_SYSTEMCTL = '''#!/bin/bash
echo "systemctl $*" >> "$FAKE_LOG/calls"
if [ "$FAKE_INSIDE" != 1 ]; then
  echo "Failed to activate service 'org.freedesktop.systemd1': timed out (service_start_timeout=25000ms)" >&2
  exit 1
fi
case "$1" in
  is-system-running)
    [ -e "$FAKE_LOG/machine.up" ] || exit 1
    [ -z "$FAKE_SYSTEMCTL_HANGS" ] || exec sleep 60
    echo "${FAKE_SYSTEM_STATE:-running}"; [ "${FAKE_SYSTEM_STATE:-running}" = running ] ;;
  is-active)
    if [ -n "$FAKE_UNIT_FLAPS" ] && [ -e "$FAKE_LOG/unit.seen" ]; then echo failed; exit 3; fi
    touch "$FAKE_LOG/unit.seen"
    echo "${FAKE_UNIT_STATE:-active}"; [ "${FAKE_UNIT_STATE:-active}" = active ] ;;
  show)
    if [[ " $* " == *" -p NRestarts --value "* ]]; then
      if [ -n "$FAKE_UNIT_FLAPS" ] && [ -e "$FAKE_LOG/unit.counted" ]; then echo 1; else touch "$FAKE_LOG/unit.counted"; echo 0; fi
    else
      printf 'ActiveState=failed\nSubState=failed\nResult=exit-code\nMainPID=0\nNRestarts=1\nExecMainStatus=1\n'
    fi ;;
  list-jobs) echo "42 boot-efi.mount start running" ;;
  --failed) echo "cloud-init.service loaded failed failed" ;;
esac
'''

FAKE_DEPLOY = '''#!/bin/bash
touch "$FAKE_LOG/deploy.called"
echo "deploy on_failure=$HIMAWARI_DEPLOY_ON_FAILURE from=$HIMAWARI_DEPLOY_FROM_STEP host=${HIMAWARI_PACKET_HOST:-} shadow=${HIMAWARI_DEPLOY_SHADOW_REHEARSAL:-} path=$PATH packet=$1"
if [ -n "$FAKE_DEPLOY_FAIL_AT" ]; then
  echo "DEPLOY_STEP_START $FAKE_DEPLOY_FAIL_AT"
  echo '{"failureCode": "FIRST_S2_INITIAL_SERVICE_NOT_ACTIVE"}' > "$FAKE_LOG/step-report.json"
  echo "STEP_FAILURE_REPORT $FAKE_LOG/step-report.json {}"
  echo "MIGRATION_REFUSED bad timestamp in row 7" >&2
  echo "DEPLOY_STOPPED_AT $FAKE_DEPLOY_FAIL_AT exit=3" >&2
  exit 3
fi
echo "DEPLOY_PASSED"
'''


def executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


class ShadowRehearsalTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        self.scripts = self.directory / 'scripts'
        self.scripts.mkdir()
        for name in ('shadow-rehearsal.sh', 'shadow-copy.py'):
            shutil.copy(HERE / name, self.scripts / name)
        executable(self.scripts / 'deploy.sh', FAKE_DEPLOY)
        self.log = self.directory / 'log'
        self.log.mkdir()
        tools = self.log / 'tools'
        tools.mkdir()
        for name, text in (('systemd-nspawn', FAKE_NSPAWN), ('machinectl', FAKE_MACHINECTL), ('nsenter', FAKE_NSENTER), ('systemctl', FAKE_SYSTEMCTL), ('unshare', FAKE_UNSHARE), ('mount', FAKE_MOUNT), ('mkfs.ext4', FAKE_MKFS), ('findmnt', FAKE_FINDMNT), ('socat', FAKE_SOCAT)):
            executable(tools / name, text)
        self.tools = tools
        (self.log / 'filesystems').write_text('nodev\ttmpfs\nnodev\toverlay\n\text4\n')
        (self.log / 'loop-control').write_text('')
        self.data = self.directory / 'state' / 'data'
        (self.data / 'memory').mkdir(parents=True)
        (self.data / 'memory' / 'notes.json').write_text('{"a": 1}')
        os.chmod(self.data / 'memory' / 'notes.json', 0o600)
        self.parent = self.directory / 'shadows'
        self.parent.mkdir()
        self.packet = self.directory / 'packet'
        self.packet.mkdir()

    def live_database(self):
        database = sqlite3.connect(self.data / 'product.sqlite')
        database.execute('PRAGMA journal_mode=WAL')
        database.execute('PRAGMA wal_autocheckpoint=0')
        database.execute('CREATE TABLE grants (id TEXT, expires_at TEXT)')
        database.execute("INSERT INTO grants VALUES ('g1', '2027-01-01T09:00:00+09:00')")
        database.commit()
        self.addCleanup(database.close)
        return database

    def run_rehearsal(self, target=None, **extra):
        environment = {'PATH': '/usr/bin:/bin', 'FAKE_LOG': str(self.log), 'HIMAWARI_SHADOW_TOOLS': str(self.tools), 'HIMAWARI_SHADOW_SBIN': str(self.tools), 'HIMAWARI_SHADOW_UPPER_SIZE': '1M', 'HIMAWARI_SHADOW_PROC_FILESYSTEMS': str(self.log / 'filesystems'), 'HIMAWARI_SHADOW_LOOP_CONTROL': str(self.log / 'loop-control'), 'HIMAWARI_PACKET_HOST': '127.0.0.1', 'HIMAWARI_DEPLOY_SHADOW_REHEARSAL': '1', 'HIMAWARI_SHADOW_STATE_ROOT': str(self.data), 'HIMAWARI_SHADOW_PARENT': str(self.parent), 'HIMAWARI_SHADOW_BOOT_WAIT': '5', 'HIMAWARI_SHADOW_SERVICE_WAIT': '3', 'HIMAWARI_SHADOW_PROBE_TIMEOUT': '2', 'HIMAWARI_SHADOW_SERVICE_SETTLE': '1', 'HIMAWARI_SHADOW_CONFIG': str(self.directory / 'no-config.json'), **extra}
        return subprocess.run(['/bin/bash', str(self.scripts / 'shadow-rehearsal.sh'), target or str(self.packet)], capture_output=True, text=True, env=environment, timeout=120)

    def test_the_copy_holds_rows_still_in_the_write_ahead_log_and_keeps_owner_and_mode(self):
        self.live_database()
        (self.data / 'product.sqlite-wal').stat()
        target = self.directory / 'copy'
        target.mkdir()
        result = subprocess.run([sys.executable, '-I', str(HERE / 'shadow-copy.py'), str(self.data), str(target)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('SHADOW_COPY_SQLITE_FILES 1', result.stdout)
        self.assertFalse((target / 'product.sqlite-wal').exists())
        copied = sqlite3.connect(target / 'product.sqlite')
        self.addCleanup(copied.close)
        self.assertEqual(copied.execute('SELECT expires_at FROM grants').fetchall(), [('2027-01-01T09:00:00+09:00',)])
        self.assertEqual((target / 'memory' / 'notes.json').read_text(), '{"a": 1}')
        self.assertEqual((target / 'memory' / 'notes.json').stat().st_mode & 0o777, 0o600)

    def test_I120_a_deploy_step_that_fails_on_the_copy_stops_before_production_and_names_the_step(self):
        self.live_database()
        before = (self.data / 'product.sqlite').read_bytes()
        result = self.run_rehearsal(FAKE_DEPLOY_FAIL_AT='S7_CONFIG_APPLY')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('SHADOW_REHEARSAL_FAILED DEPLOY_S7_CONFIG_APPLY', result.stderr)
        self.assertIn('SHADOW| MIGRATION_REFUSED bad timestamp in row 7', result.stdout)
        self.assertIn('{"failureCode": "FIRST_S2_INITIAL_SERVICE_NOT_ACTIVE"}', result.stdout)
        self.assertIn('SHADOW_STEP_REPORT ' + str(self.log / 'step-report.json'), result.stdout)
        self.assertIn('SHADOW_AFTER_FAILURE service: ActiveState=failed', result.stdout)
        self.assertEqual((self.data / 'product.sqlite').read_bytes(), before)
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assertIn('machinectl terminate himawari-shadow', (self.log / 'calls').read_text())

    def test_the_shadow_machine_is_an_offline_throwaway_overlay_of_this_host_with_the_copied_data(self):
        self.live_database()
        result = self.run_rehearsal()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SHADOW_REHEARSAL_PASSED', result.stdout)
        self.assertIn('SHADOW| deploy on_failure=keep from=S2_STOP host=127.0.0.1 shadow= path=/usr/bin:/bin packet=' + str(self.packet), result.stdout)
        self.assertIn('SHADOW_HOST arch=', result.stdout)
        self.assertIn('overlay=yes loop=yes', result.stdout)
        self.assertIn('nspawn=systemd_255_(255.4-1ubuntu8)', result.stdout)
        self.assertIn('SHADOW_FSTAB_DROPPED LABEL=UEFI /boot/efi vfat umask=0077 0 1', result.stdout)
        self.assertIn('SHADOW_UNIT_MASKED oracle-keepalive.service', result.stdout)
        self.assertIn('SHADOW_UNIT_MASKED cloudflared.service', result.stdout)
        self.assertNotIn('SHADOW_FSTAB_DROPPED # comment', result.stdout)
        self.assertIn('SHADOW_SYSTEM_STATE running', result.stdout)
        arguments = (self.log / 'nspawn.args').read_text().splitlines()
        for expected in ('--private-network', '--boot', '--machine=himawari-shadow', '--link-journal=no', '--console=pipe'):
            self.assertIn(expected, arguments)
        directory = next(argument for argument in arguments if argument.startswith('--directory='))[len('--directory='):]
        shadow = Path(directory).parent
        self.assertEqual(Path(directory).name, 'root')
        self.assertTrue(str(shadow).startswith(str(self.parent / 'himawari-shadow.')))
        self.assertFalse(any(argument.startswith('--volatile') or argument.startswith('--ephemeral') for argument in arguments))
        calls = (self.log / 'calls').read_text()
        self.assertIn('unshare --mount --propagation private', calls)
        self.assertIn(f'mount -o loop {shadow}/upper.img {shadow}/layer', calls)
        self.assertIn(f'mount -t overlay overlay -o lowerdir=/,upperdir={shadow}/layer/upper,workdir={shadow}/layer/work {directory}', calls)
        bind = next(argument for argument in arguments if argument.startswith('--bind='))
        source, target = bind[len('--bind='):].split(':')
        self.assertEqual(target, str(self.data))
        self.assertEqual(source, str(shadow / 'state'))
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_I120_boot_only_starts_the_old_release_on_the_whole_copied_state_and_reports_it_without_a_packet_or_deploy(self):
        self.live_database()
        (self.data / 'authority.json').write_text('{"status": "active"}')
        result = self.run_rehearsal('--boot-only')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SHADOW_OLD_SERVICE_STABLE', result.stdout)
        self.assertIn('SHADOW_BOOT_ONLY_REPORT service: ActiveState=', result.stdout)
        self.assertIn('SHADOW_BOOT_ONLY_REPORT service journal:', result.stdout)
        self.assertIn('SHADOW_BOOT_ONLY_PASSED', result.stdout)
        self.assertNotIn('SHADOW_DEPLOY_START', result.stdout)
        self.assertFalse((self.log / 'deploy.called').exists())
        bind = next(argument for argument in (self.log / 'nspawn.args').read_text().splitlines() if argument.startswith('--bind='))
        self.assertEqual(bind.split(':')[-1], str(self.data))
        self.assertEqual(list(self.parent.iterdir()), [])

    def lease_database(self, seconds_left, released=False):
        database = self.live_database()
        database.execute('CREATE TABLE authority_leases (id TEXT, agent_id TEXT, expires_at TEXT, released_at TEXT)')
        expires = (datetime.now(timezone.utc) + timedelta(seconds=seconds_left)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        database.execute('INSERT INTO authority_leases VALUES (?, ?, ?, ?)', ('authority:a:old', 'a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'))
        database.execute('INSERT INTO authority_leases VALUES (?, ?, ?, ?)', ('authority:a:live', 'a', expires, expires if released else None))
        database.commit()
        return datetime.fromisoformat(expires.replace('Z', '+00:00'))

    def test_I120_the_old_release_boots_only_after_the_running_services_lease_in_the_copy_has_lapsed(self):
        expires = self.lease_database(3)
        result = self.run_rehearsal('--boot-only')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SHADOW_COPY_LEASE_EXPIRES ', result.stdout)
        self.assertRegex(result.stdout, r'SHADOW_LEASE_WAIT [1-9][0-9]*s: ')
        booted = datetime.fromtimestamp((self.log / 'nspawn.args').stat().st_mtime, timezone.utc)
        self.assertGreater(booted, expires)

    def test_a_released_lease_in_the_copy_needs_no_wait(self):
        self.lease_database(600, released=True)
        result = self.run_rehearsal('--boot-only')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('SHADOW_LEASE_WAIT', result.stdout)

    def test_a_copied_lease_that_runs_far_into_the_future_is_refused_before_booting(self):
        self.lease_database(3600)
        result = self.run_rehearsal('--boot-only')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('SHADOW_REHEARSAL_FAILED LEASE_TOO_LONG', result.stderr)
        self.assertFalse((self.log / 'nspawn.args').exists())
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_I120_the_shadow_writes_its_own_empty_journal_instead_of_copying_up_the_live_host_journal(self):
        self.live_database()
        result = self.run_rehearsal('--boot-only')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        binds = [argument[len('--bind='):].split(':') for argument in (self.log / 'nspawn.args').read_text().splitlines() if argument.startswith('--bind=')]
        journal = [source for source, target in binds if target == '/var/log/journal']
        self.assertEqual(len(journal), 1)
        self.assertEqual(Path(journal[0]).name, 'journal')
        self.assertTrue(Path(journal[0]).parent.name.startswith('himawari-shadow.'))

    def test_I120_the_granted_workspace_is_bound_read_only_so_the_shadow_sees_its_real_device_and_inode(self):
        self.live_database()
        workspace = self.directory / 'workspace'
        workspace.mkdir()
        result = self.run_rehearsal('--boot-only', HIMAWARI_SHADOW_WORKSPACE=str(workspace))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        arguments = (self.log / 'nspawn.args').read_text().splitlines()
        self.assertIn(f'--bind-ro={workspace}', arguments)
        self.assertFalse(any(argument.startswith('--bind=') and argument[len('--bind='):].split(':')[0] == str(workspace) for argument in arguments))
        self.assertIn(f'SHADOW_WORKSPACE_READ_ONLY {workspace}', result.stdout)

    def test_I120_a_host_without_the_granted_workspace_boots_without_binding_it(self):
        self.live_database()
        result = self.run_rehearsal('--boot-only', HIMAWARI_SHADOW_WORKSPACE=str(self.directory / 'absent-workspace'))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(any(argument.startswith('--bind-ro=') and 'absent-workspace' in argument for argument in (self.log / 'nspawn.args').read_text().splitlines()))

    def test_I120_the_host_system_tree_is_bound_read_only_so_tool_bindings_see_their_real_device_and_inode(self):
        self.live_database()
        result = self.run_rehearsal('--boot-only')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        arguments = (self.log / 'nspawn.args').read_text().splitlines()
        self.assertIn('--bind-ro=/usr', arguments)
        self.assertFalse(any(argument.startswith('--bind=/usr') for argument in arguments))
        self.assertIn('SHADOW_SYSTEM_TREE_READ_ONLY /usr', result.stdout)

    def test_I120_the_shadow_reaches_only_the_identity_key_address_the_service_fetches_before_it_listens(self):
        self.live_database()
        config = self.directory / 'config.json'
        config.write_text('{"identity": {"kind": "cloudflare-access", "jwksUrl": "https://team.cloudflareaccess.com/cdn-cgi/access/certs"}}')
        result = self.run_rehearsal('--boot-only', HIMAWARI_SHADOW_CONFIG=str(config), FAKE_SAVE_ROOT='1')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SHADOW_EGRESS_ALLOWED team.cloudflareaccess.com:443', result.stdout)
        arguments = (self.log / 'nspawn.args').read_text().splitlines()
        self.assertIn('--private-network', arguments)
        bind = next(argument for argument in arguments if argument.endswith(':/run/himawari-shadow-egress'))
        calls = (self.log / 'calls').read_text()
        self.assertIn('socat UNIX-LISTEN:' + bind[len('--bind='):-len(':/run/himawari-shadow-egress')] + '/1.sock,fork,mode=600 TCP:team.cloudflareaccess.com:443', calls)
        self.assertIn('127.0.1.1 team.cloudflareaccess.com', (self.log / 'root-etc' / 'hosts').read_text())
        unit = (self.log / 'root-etc' / 'systemd' / 'system' / 'himawari-shadow-egress-1.service').read_text()
        self.assertIn('ExecStart=/usr/bin/socat TCP-LISTEN:443,bind=127.0.1.1,fork,reuseaddr UNIX-CONNECT:/run/himawari-shadow-egress/1.sock', unit)
        self.assertIn('Before=himawari-prod.service', unit)
        self.assertTrue((self.log / 'root-etc' / 'systemd' / 'system' / 'multi-user.target.wants' / 'himawari-shadow-egress-1.service').is_symlink())
        for pid in (self.log / 'socat.pids').read_text().split():
            self.assertFalse(Path('/proc/' + pid).exists() and Path('/proc/' + pid + '/stat').read_text().split()[2] != 'Z')

    def test_a_built_in_identity_needs_no_way_out_of_the_shadow(self):
        self.live_database()
        config = self.directory / 'config.json'
        config.write_text('{"identity": {"kind": "built-in", "jwksUrl": "https://team.cloudflareaccess.com/cdn-cgi/access/certs"}}')
        result = self.run_rehearsal('--boot-only', HIMAWARI_SHADOW_CONFIG=str(config))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('SHADOW_EGRESS_ALLOWED', result.stdout)
        self.assertFalse(any(line.startswith('socat ') for line in (self.log / 'calls').read_text().splitlines()))

    def test_I120_the_host_root_itself_is_never_handed_to_nspawn_and_a_refusing_nspawn_fails_at_once(self):
        self.live_database()
        refusal = 'Spawning container on root directory is not supported. Consider using --ephemeral, --volatile=yes or --volatile=state.'
        result = self.run_rehearsal(FAKE_NSPAWN_REFUSES=refusal, HIMAWARI_SHADOW_BOOT_WAIT='100')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('SHADOW_REHEARSAL_FAILED BOOT_EXITED', result.stderr)
        self.assertRegex(result.stderr, r'nspawn exit=[1-9]')
        self.assertIn(refusal, result.stderr)
        arguments = (self.log / 'nspawn.args').read_text().splitlines()
        self.assertNotIn('--directory=/', arguments)
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_I120_a_filesystem_mounted_under_the_root_that_the_overlay_would_miss_is_named_before_booting(self):
        self.live_database()
        result = self.run_rehearsal(FAKE_SUBMOUNT='/var/lib/himawari')
        self.assertEqual(result.returncode, 1)
        self.assertIn('SHADOW_REHEARSAL_FAILED SUBMOUNTS_NOT_COPIED', result.stderr)
        self.assertIn('/var/lib/himawari', result.stderr)
        self.assertNotIn('/boot/efi', result.stderr)
        self.assertFalse((self.log / 'nspawn.args').exists())

    def test_a_kernel_without_overlay_is_refused_before_copying(self):
        self.live_database()
        (self.log / 'filesystems').write_text('nodev\ttmpfs\n\text4\n')
        result = self.run_rehearsal()
        self.assertEqual(result.returncode, 1)
        self.assertIn('SHADOW_REHEARSAL_FAILED OVERLAY_UNSUPPORTED', result.stderr)
        self.assertNotIn('SHADOW_COPY_START', result.stdout)

    def test_I120_a_boot_whose_status_never_answers_stops_at_the_deadline_and_names_the_waiting_units(self):
        self.live_database()
        started = time.monotonic()
        result = self.run_rehearsal(FAKE_SYSTEMCTL_HANGS='1', HIMAWARI_SHADOW_BOOT_WAIT='4')
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(result.returncode, 1)
        self.assertIn('SHADOW_REHEARSAL_FAILED BOOT_TIMEOUT', result.stderr)
        self.assertIn('state unreachable', result.stderr)
        self.assertIn('42 boot-efi.mount start running', result.stderr)
        self.assertNotIn('SHADOW_DEPLOY_START', result.stdout)
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_I120_status_and_the_deploy_reach_the_shadow_through_its_namespaces_not_its_message_bus(self):
        self.live_database()
        result = self.run_rehearsal()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SHADOW_BOOTED leader=4242', result.stdout)
        calls = (self.log / 'calls').read_text()
        self.assertNotIn('systemctl --machine', calls)
        self.assertNotIn('systemd-run', calls)
        self.assertIn('nsenter --target=4242 --mount --uts --ipc --net --pid --cgroup -- ' + str(self.tools / 'systemctl') + ' is-system-running', calls)
        self.assertIn('/usr/bin/env -i PATH=/usr/bin:/bin HIMAWARI_DEPLOY_ON_FAILURE=keep HIMAWARI_DEPLOY_FROM_STEP=S2_STOP', calls)

    def test_I120_the_rehearsed_deploy_runs_in_the_shadow_cgroup_namespace_that_the_stop_step_compares_with_its_first_process(self):
        self.live_database()
        result = self.run_rehearsal()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        deploy_calls = [line for line in (self.log / 'calls').read_text().splitlines() if line.startswith('nsenter ') and 'deploy.sh' in line]
        self.assertEqual(len(deploy_calls), 1)
        self.assertIn(' --mount --uts --ipc --net --pid --cgroup -- ', deploy_calls[0])
        stop_step = (HERE / 'packet-template' / 'systemd' / 'S2-stop-and-inspect.py').read_text()
        self.assertIn("os.readlink('/proc/self/ns/cgroup') == os.readlink('/proc/1/ns/cgroup')", stop_step)

    def test_I120_a_stuck_boot_reports_the_shadow_processes_and_journal(self):
        self.live_database()
        result = self.run_rehearsal(FAKE_SYSTEMCTL_HANGS='1', HIMAWARI_SHADOW_BOOT_WAIT='4')
        self.assertEqual(result.returncode, 1)
        self.assertIn('leader: 4242', result.stderr)
        self.assertIn('processes: ', result.stderr)
        self.assertIn('journal: ', result.stderr)

    def test_I120_the_shadow_root_keeps_the_host_root_permissions_so_service_accounts_can_enter_it(self):
        self.live_database()
        result = self.run_rehearsal()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.log / 'upper.mode').read_text().strip(), format(os.stat('/').st_mode & 0o7777, 'o'))

    def test_I120_emergency_mode_fails_at_once_with_the_failed_units(self):
        self.live_database()
        started = time.monotonic()
        result = self.run_rehearsal(FAKE_SYSTEM_STATE='maintenance', HIMAWARI_SHADOW_BOOT_WAIT='100')
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(result.returncode, 1)
        self.assertIn('SHADOW_REHEARSAL_FAILED BOOT_EMERGENCY', result.stderr)
        self.assertIn('cloud-init.service loaded failed failed', result.stderr)

    def test_a_shadow_left_by_a_cut_off_run_is_terminated_and_removed_first(self):
        self.live_database()
        leftover = self.parent / 'himawari-shadow.old123'
        (leftover / 'data').mkdir(parents=True)
        (self.log / 'machine.up').touch()
        result = self.run_rehearsal()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SHADOW_LEFTOVER_MACHINE himawari-shadow', result.stdout)
        self.assertIn('SHADOW_LEFTOVER_REMOVED ' + str(leftover), result.stdout)
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_the_old_release_must_start_on_the_copy_before_the_deploy_is_rehearsed(self):
        self.live_database()
        result = self.run_rehearsal(FAKE_UNIT_STATE='failed')
        self.assertEqual(result.returncode, 1)
        self.assertIn('SHADOW_REHEARSAL_FAILED OLD_SERVICE_NOT_ACTIVE', result.stderr)
        self.assertNotIn('SHADOW_DEPLOY_START', result.stdout)

    def test_I120_an_old_release_that_starts_and_then_falls_over_is_caught_before_the_rehearsed_deploy(self):
        self.live_database()
        result = self.run_rehearsal(FAKE_UNIT_FLAPS='1')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('SHADOW_REHEARSAL_FAILED OLD_SERVICE_NOT_STABLE', result.stderr)
        self.assertIn('service: ActiveState=failed', result.stderr)
        self.assertNotIn('SHADOW_DEPLOY_START', result.stdout)

    def test_too_little_disk_for_the_copy_refuses_before_copying(self):
        self.live_database()
        result = self.run_rehearsal(HIMAWARI_SHADOW_PARENT=str(self.parent), HIMAWARI_SHADOW_STATE_ROOT=str(self.data), PATH=str(self.fake_df()) + ':/usr/bin:/bin')
        self.assertEqual(result.returncode, 1)
        self.assertIn('SHADOW_REHEARSAL_FAILED DISK_LOW', result.stderr)
        self.assertFalse((self.log / 'nspawn.args').exists())

    def fake_df(self):
        bin_directory = self.directory / 'df-bin'
        bin_directory.mkdir()
        executable(bin_directory / 'df', '#!/bin/bash\necho Avail\necho 10\n')
        return bin_directory


if __name__ == '__main__':
    unittest.main()
