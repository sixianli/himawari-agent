import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


remote = load('release_cleanup_remote', 'release-cleanup-remote.py')
local = load('release_cleanup', 'release-cleanup.py')
MEBIBYTE = 1024 ** 2


class ProductionTree:
    def __init__(self, root):
        self.root = root
        self.releases = root / 'opt/himawari/releases'
        self.operations = root / 'opt/himawari/operations'
        self.tmp = root / 'var/tmp'
        self.lib = root / 'var/lib/himawari'
        self.etc = root / 'etc/himawari'
        for directory in (self.releases, self.operations, self.tmp, self.lib / 'state/data', self.etc, root / 'etc/systemd/system'):
            directory.mkdir(parents=True)
        (self.etc / 'config.json').write_text('{"stateRoot": "' + str(self.lib / 'state') + '"}\n')
        (self.lib / 'state/data/product.sqlite').write_bytes(b'SQLite format 3\0' + b'\0' * 64)
        self.unit = root / 'etc/systemd/system/himawari-prod.service'

    def file(self, path, size=10, data=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if data is not None else b'x' * size)
        return path

    def release(self, date, label, old_prefix):
        compact = date.replace('-', '')
        prefix = self.releases / (date + '-' + label)
        operations = self.operations / (label + '-' + compact)
        stage = self.tmp / ('himawari-' + label + '-' + compact)
        evidence = self.lib / (label + '-' + compact + '-evidence')
        upload = self.tmp / (label + '-packet-upload')
        self.file(prefix / 'lib/himawari-agent/node_modules/a/index.js', MEBIBYTE)
        binding = {'paths': {'newPrefix': str(prefix), 'oldPrefix': str(old_prefix), 'newOperations': str(operations), 'evidenceRoot': str(evidence), 'transportRoot': str(stage / 'input'), 'config': str(self.etc / 'config.json'), 'database': str(self.lib / 'state/data/product.sqlite')}, 'host': {'hostname': 'prod-host', 'address': '192.0.2.10'}, 'service': {'unit': 'himawari-prod.service', 'unitFragmentPath': str(self.unit)}}
        self.file(operations / 'inputs/bindings.json', data=json.dumps(binding).encode())
        self.file(operations / 'pair-supervisor.mjs')
        self.file(stage / 'packet/freeze-manifest.json')
        self.file(stage / 'packet/materials/node-modules.tar.gz', MEBIBYTE)
        self.file(stage / 'input/candidate.tar.gz', MEBIBYTE)
        self.file(stage / 'validation/source/node_modules/b/index.js', MEBIBYTE)
        self.file(stage / 'validation/source/report.json')
        self.file(stage / 'acceptance/s6-readback.json')
        self.file(stage / 'acceptance/runtime-tools/tool.bin', MEBIBYTE)
        self.file(upload / (date + '-' + label + '-change-packet-01/materials/candidate.tar.gz'), MEBIBYTE)
        self.file(upload / (date + '-' + label + '-change-packet-01/inputs/bindings.json'))
        self.file(upload / 'transport-1-result.json')
        self.file(evidence / 's1-result.json')
        self.file(evidence / 'build-cache.tar.gz', 11 * MEBIBYTE)
        self.file(evidence / (label + '-raw-schema66/data/product.sqlite'), 11 * MEBIBYTE)
        return {'prefix': prefix, 'operations': operations, 'stage': stage, 'evidence': evidence, 'upload': upload, 'binding': binding}

    def serve(self, release):
        self.unit.write_text('[Service]\nExecStart=/opt/himawari/node/bin/node --no-global-search-paths ' + str(release['operations']) + '/pair-supervisor.mjs --prefix ' + str(release['prefix']) + ' --config ' + str(self.etc / 'config.json') + ' \n')

    def plan(self, release):
        return {**local.cleanup_plan(release['binding']), 'lockPath': str(self.root / 'run/lock/cleanup.lock')}


class ReleaseCleanupTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.tree = ProductionTree(Path(self.directory.name))
        tree = self.tree
        self.first = tree.release('2026-10-20', 'seventeenth', tree.releases / '2026-10-15-sixteenth')
        self.previous = tree.release('2026-10-27', 'eighteenth', self.first['prefix'])
        self.serving = tree.release('2026-10-29', 'nineteenth', self.previous['prefix'])
        self.failed = tree.release('2026-10-30', 'twentieth', self.serving['prefix'])
        tree.serve(self.serving)
        for stamp, release in enumerate((self.first, self.previous, self.serving, self.failed), start=1):
            copy = self.database_copy(release)
            os.utime(copy, (stamp * 1000, stamp * 1000))
        self.leftover_release = tree.releases / '2026-10-27-eighteenth.attempt1-failed-20261027'
        tree.file(self.leftover_release / 'lib/x.js', MEBIBYTE)
        self.leftover_stage = tree.tmp / 'himawari-eighteenth-20261027.attempt1-failed-20261027'
        tree.file(self.leftover_stage / 'validation/source/node_modules/c.js', MEBIBYTE)
        self.unrelated = tree.file(tree.tmp / 'systemd-private-abc/keep.txt')
        self.unrelated_lib = tree.file(tree.lib / 'qualification/large.bin', 11 * MEBIBYTE)

    def tearDown(self):
        self.directory.cleanup()

    def database_copy(self, release):
        label = release['evidence'].name.split('-')[0]
        return release['evidence'] / (label + '-raw-schema66/data/product.sqlite')

    def run_cleanup(self, apply=True, references=(), current=None, **changes):
        return remote.cleanup({**self.tree.plan(current or self.failed), **changes}, apply, list(references), '20261030T010000Z')

    def test_after_a_failed_attempt_only_the_serving_and_rollback_releases_and_the_rollback_packet_remain(self):
        result = self.run_cleanup()
        self.assertEqual(sorted(os.listdir(self.tree.releases)), ['2026-10-27-eighteenth', '2026-10-29-nineteenth'])
        self.assertEqual(sorted(os.listdir(self.tree.tmp)), ['himawari-nineteenth-20261029', 'systemd-private-abc'])
        self.assertEqual(os.listdir(self.serving['stage']), ['packet'])
        self.assertTrue((self.serving['stage'] / 'packet/materials/node-modules.tar.gz').exists())
        self.assertFalse(self.failed['operations'].exists())
        self.assertTrue(self.serving['operations'].exists() and self.previous['operations'].exists())
        self.assertTrue(self.unrelated.exists() and self.unrelated_lib.exists())
        self.assertGreater(result['freedBytes'], 10 * MEBIBYTE)

    def test_failed_attempt_evidence_moves_aside_for_the_retry_and_keeps_only_small_files(self):
        self.run_cleanup()
        self.assertFalse(self.failed['evidence'].exists())
        moved = Path(str(self.failed['evidence']) + '.attempt-failed-20261030T010000Z')
        self.assertTrue((moved / 's1-result.json').exists())
        self.assertFalse((self.first['evidence'] / 'build-cache.tar.gz').exists())

    def test_the_three_newest_database_copies_stay_and_older_ones_go(self):
        result = self.run_cleanup()
        moved = Path(str(self.failed['evidence']) + '.attempt-failed-20261030T010000Z')
        self.assertTrue((moved / 'twentieth-raw-schema66/data/product.sqlite').exists())
        self.assertTrue(self.database_copy(self.serving).exists())
        self.assertTrue(self.database_copy(self.previous).exists())
        self.assertFalse(self.database_copy(self.first).exists())
        self.assertEqual(sorted(item['path'] for item in result['kept'] if item['reason'] == 'recent-database-copy'), sorted(str(path) for path in (self.database_copy(self.failed), self.database_copy(self.serving), self.database_copy(self.previous))))

    def test_the_number_of_database_copies_kept_follows_the_plan(self):
        self.run_cleanup(keepDatabaseCopies=1)
        self.assertFalse(self.database_copy(self.previous).exists())
        self.assertTrue(self.database_copy(self.serving).exists())

    def test_plan_keeps_three_database_copies(self):
        self.assertEqual(self.tree.plan(self.failed)['keepDatabaseCopies'], 3)

    def test_reports_logs_and_results_are_archived_before_their_copies_are_deleted(self):
        result = self.run_cleanup()
        archive = self.tree.lib / 'release-cleanup/20261030T010000Z'
        self.assertTrue((archive / 'twentieth-packet-upload/transport-1-result.json').exists())
        self.assertTrue((archive / 'himawari-nineteenth-20261029/acceptance/s6-readback.json').exists())
        self.assertFalse(any('change-packet-01' in path or '/validation/' in path or 'runtime-tools' in path for path in result['archived']))

    def test_plan_mode_changes_nothing(self):
        result = self.run_cleanup(apply=False)
        self.assertGreater(len(result['deleted']), 0)
        self.assertTrue(self.failed['stage'].exists() and self.failed['prefix'].exists() and self.leftover_release.exists())

    def test_release_named_by_the_database_unit_config_or_a_process_is_kept(self):
        database = self.tree.lib / 'state/data/product.sqlite'
        database.write_bytes(database.read_bytes() + str(self.first['prefix']).encode() + b'/lib/himawari-agent\0')
        (self.tree.etc / 'extra.json').write_text('{"runtime": "' + str(self.failed['prefix']) + '"}')
        result = self.run_cleanup(references=[str(self.leftover_release) + '/lib/x.js'])
        kept = {item['path']: item['reason'] for item in result['kept']}
        self.assertEqual(kept[str(self.first['prefix'])], 'named-by-database')
        self.assertEqual(kept[str(self.failed['prefix'])], 'named-by-unit-or-config')
        self.assertEqual(kept[str(self.leftover_release)], 'used-by-a-process')
        self.assertTrue(self.first['prefix'].exists() and self.failed['prefix'].exists() and self.leftover_release.exists())

    def test_a_similar_name_is_not_taken_for_a_reference(self):
        (self.tree.etc / 'extra.json').write_text('{"runtime": "' + str(self.leftover_release) + '-other/lib"}')
        self.run_cleanup()
        self.assertFalse(self.leftover_release.exists())

    def test_a_running_release_step_stops_the_cleanup_before_anything_is_deleted(self):
        with self.assertRaisesRegex(RuntimeError, 'CLEANUP_RELEASE_STEP_RUNNING'):
            self.run_cleanup(references=['/usr/bin/python3 -I /opt/himawari/operations/twentieth-20261030/steps/run-step.py --approved'])
        self.assertTrue(self.failed['stage'].exists() and self.leftover_release.exists())

    def test_an_unknown_serving_release_deletes_nothing(self):
        self.tree.unit.write_text('[Service]\nExecStart=/usr/bin/true\n')
        with self.assertRaisesRegex(RuntimeError, 'CLEANUP_SERVING_RELEASE_UNKNOWN'):
            self.run_cleanup()
        self.assertTrue(self.failed['stage'].exists() and self.previous['prefix'].exists())

    def test_after_a_successful_switch_the_new_release_serves_and_the_one_before_it_is_kept(self):
        self.tree.serve(self.failed)
        self.run_cleanup()
        self.assertEqual(sorted(os.listdir(self.tree.releases)), ['2026-10-29-nineteenth', '2026-10-30-twentieth'])
        self.assertEqual(os.listdir(self.failed['stage']), ['packet'])
        self.assertTrue((self.failed['evidence'] / 'twentieth-raw-schema66/data/product.sqlite').exists())
        self.assertTrue(self.failed['operations'].exists())

    def test_a_second_run_finds_nothing_more(self):
        self.run_cleanup()
        again = self.run_cleanup()
        self.assertEqual((again['deleted'], again['trimmed']), ([], []))


class CleanupPlanTest(unittest.TestCase):
    def test_plan_comes_from_the_packet_bindings(self):
        binding = {'host': {'hostname': 'vmi1'}, 'service': {'unit': 'himawari-prod.service', 'unitFragmentPath': '/etc/systemd/system/himawari-prod.service'}, 'paths': {'newPrefix': '/opt/himawari/releases/2026-10-30-twentieth', 'newOperations': '/opt/himawari/operations/twentieth-20261030', 'evidenceRoot': '/var/lib/himawari/twentieth-20261030-evidence', 'transportRoot': '/var/tmp/himawari-twentieth-20261030/input', 'config': '/etc/himawari/config.json', 'database': '/var/lib/himawari/state/data/product.sqlite'}}
        plan = local.cleanup_plan(binding)
        self.assertEqual((plan['releasesRoot'], plan['operationsRoot'], plan['tmpRoot'], plan['evidenceParent'], plan['configDirectory']), ('/opt/himawari/releases', '/opt/himawari/operations', '/var/tmp', '/var/lib/himawari', '/etc/himawari'))


if __name__ == '__main__':
    unittest.main()
