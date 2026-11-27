import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent

FAKE_NSPAWN = '''#!/bin/bash
printf '%s\\n' "$@" > "$FAKE_LOG/nspawn.args"
touch "$FAKE_LOG/machine.up"
sleep 30
'''

FAKE_MACHINECTL = '''#!/bin/bash
echo "machinectl $*" >> "$FAKE_LOG/calls"
case "$1" in
  show) [ -e "$FAKE_LOG/machine.up" ] ;;
  terminate) rm -f "$FAKE_LOG/machine.up"; pkill -f "$FAKE_LOG/tools/systemd-nspawn" || true ;;
esac
'''

FAKE_SYSTEMD_RUN = '''#!/bin/bash
echo "systemd-run $*" >> "$FAKE_LOG/calls"
[ -e "$FAKE_LOG/machine.up" ] || exit 1
while [[ "$1" == --* ]]; do
  case "$1" in --setenv=*) export "${1#--setenv=}" ;; esac
  shift
done
exec "$@"
'''

FAKE_SYSTEMCTL = '''#!/bin/bash
case "$1" in
  is-system-running) echo "${FAKE_SYSTEM_STATE:-running}"; [ "${FAKE_SYSTEM_STATE:-running}" = running ] ;;
  is-active) echo "${FAKE_UNIT_STATE:-active}"; [ "${FAKE_UNIT_STATE:-active}" = active ] ;;
esac
'''

FAKE_DEPLOY = '''#!/bin/bash
echo "deploy on_failure=$HIMAWARI_DEPLOY_ON_FAILURE packet=$1"
if [ -n "$FAKE_DEPLOY_FAIL_AT" ]; then
  echo "DEPLOY_STEP_START $FAKE_DEPLOY_FAIL_AT"
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
        for name, text in (('systemd-nspawn', FAKE_NSPAWN), ('machinectl', FAKE_MACHINECTL), ('systemd-run', FAKE_SYSTEMD_RUN), ('systemctl', FAKE_SYSTEMCTL)):
            executable(tools / name, text)
        self.tools = tools
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

    def run_rehearsal(self, **extra):
        environment = {'PATH': '/usr/bin:/bin', 'FAKE_LOG': str(self.log), 'HIMAWARI_SHADOW_TOOLS': str(self.tools), 'HIMAWARI_SHADOW_STATE_DATA': str(self.data), 'HIMAWARI_SHADOW_PARENT': str(self.parent), 'HIMAWARI_SHADOW_BOOT_WAIT': '5', 'HIMAWARI_SHADOW_SERVICE_WAIT': '3', **extra}
        return subprocess.run(['/bin/bash', str(self.scripts / 'shadow-rehearsal.sh'), str(self.packet)], capture_output=True, text=True, env=environment, timeout=120)

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
        self.assertEqual((self.data / 'product.sqlite').read_bytes(), before)
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assertIn('machinectl terminate himawari-shadow', (self.log / 'calls').read_text())

    def test_the_shadow_machine_is_an_offline_throwaway_overlay_of_this_host_with_the_copied_data(self):
        self.live_database()
        result = self.run_rehearsal()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SHADOW_REHEARSAL_PASSED', result.stdout)
        self.assertIn('SHADOW| deploy on_failure=keep packet=' + str(self.packet), result.stdout)
        arguments = (self.log / 'nspawn.args').read_text().splitlines()
        for expected in ('--directory=/', '--volatile=overlay', '--private-network', '--boot', '--machine=himawari-shadow'):
            self.assertIn(expected, arguments)
        bind = next(argument for argument in arguments if argument.startswith('--bind='))
        source, target = bind[len('--bind='):].split(':')
        self.assertEqual(target, str(self.data))
        self.assertTrue(source.startswith(str(self.parent / 'himawari-shadow.')))
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_the_old_release_must_start_on_the_copy_before_the_deploy_is_rehearsed(self):
        self.live_database()
        result = self.run_rehearsal(FAKE_UNIT_STATE='failed')
        self.assertEqual(result.returncode, 1)
        self.assertIn('SHADOW_REHEARSAL_FAILED OLD_SERVICE_NOT_ACTIVE', result.stderr)
        self.assertNotIn('SHADOW_DEPLOY_START', result.stdout)

    def test_too_little_disk_for_the_copy_refuses_before_copying(self):
        self.live_database()
        result = self.run_rehearsal(HIMAWARI_SHADOW_PARENT=str(self.parent), HIMAWARI_SHADOW_STATE_DATA=str(self.data), PATH=str(self.fake_df()) + ':/usr/bin:/bin')
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
