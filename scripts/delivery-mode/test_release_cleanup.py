from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock

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
        self.scratch = root / 'tmp'
        self.scratch.mkdir()
        self.lib = root / 'var/lib/himawari'
        self.etc = root / 'etc/himawari'
        for directory in (self.releases, self.operations, self.tmp, self.lib / 'state/data', self.etc, root / 'etc/systemd/system'):
            directory.mkdir(parents=True)
        (self.etc / 'config.json').write_text('{"stateRoot": "' + str(self.lib / 'state') + '"}\n')
        self.database = self.lib / 'state/data/product.sqlite'
        with closing(sqlite3.connect(self.database)) as database, database:
            database.execute('create table runs (id integer primary key, detail text, payload blob)')
            database.execute("insert into runs (detail, payload) values ('no release here', x'00')")
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
        binding = {'paths': {'newPrefix': str(prefix), 'oldPrefix': str(old_prefix), 'newOperations': str(operations), 'evidenceRoot': str(evidence), 'transportRoot': str(stage / 'input'), 'config': str(self.etc / 'config.json'), 'database': str(self.lib / 'state/data/product.sqlite')}, 'host': {'hostname': 'prod-host', 'address': '192.0.2.10'}, 'service': {'unit': 'himawari-prod.service', 'unitFragmentPath': str(self.unit), 'newQualificationEvidenceRoot': str(self.lib / 'qualification' / (label + '-' + compact))}}
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

    def record(self, detail):
        with closing(sqlite3.connect(self.database)) as database, database:
            return database.execute('insert into runs (detail) values (?)', (detail,)).lastrowid

    def plan(self, release):
        return {**local.cleanup_plan(release['binding']), 'lockPath': str(self.root / 'run/lock/cleanup.lock'), 'scratchRoot': str(self.scratch), 'scratchOwnerUids': [os.getuid()]}

    def scene(self, name, mtime, mode=0o700, size=10):
        directory = self.scratch / name
        directory.mkdir(mode=mode)
        os.chmod(directory, mode)
        self.file(directory / 's/product.sqlite', size)
        os.utime(directory, (mtime, mtime))
        return directory


class CleanupCase(unittest.TestCase):
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



class ReleaseCleanupTest(CleanupCase):
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

    def test_a_failed_attempts_acceptance_files_survive_whatever_their_size_and_a_passed_deploy_keeps_none(self):
        diagnostics = self.tree.file(self.failed['stage'] / 'acceptance/run-01/original-start-diagnostics.json', 5 * MEBIBYTE)
        database = self.tree.file(self.failed['stage'] / 'acceptance/run-01/original-start-product.sqlite', 20 * MEBIBYTE)
        result = self.run_cleanup()
        saved = Path(self.failed['binding']['paths']['evidenceRoot']).parent / 'release-cleanup/failed-acceptance/20261030T010000Z-himawari-twentieth-20261030/run-01'
        self.assertEqual((saved / diagnostics.name).stat().st_size, 5 * MEBIBYTE)
        self.assertEqual((saved / database.name).stat().st_size, 20 * MEBIBYTE)
        self.assertFalse(diagnostics.exists())
        self.assertIn('failed-acceptance-evidence', {item['reason'] for item in result['kept']})
        self.assertFalse(any('runtime-tools' in item['path'] for item in result['kept']))

    def test_only_the_newest_two_failed_acceptance_copies_stay(self):
        root = Path(self.failed['binding']['paths']['evidenceRoot']).parent / 'release-cleanup/failed-acceptance'
        for name in ('20261001T000000Z-a', '20261002T000000Z-b', '20261003T000000Z-c'):
            self.tree.file(root / name / 'run-01/x.json')
        self.run_cleanup()
        self.assertEqual(sorted(os.listdir(root)), ['20261003T000000Z-c', '20261030T010000Z-himawari-twentieth-20261030'])

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
        self.tree.record('{"runtimeRoot": "' + str(self.first['prefix']) + '/lib/himawari-agent"}')
        config = self.tree.etc / 'config.json'
        config.write_text('{"runtime": "' + str(self.failed['prefix']) + '"}')
        result = self.run_cleanup(references=[str(self.leftover_release) + '/lib/x.js'])
        kept = {item['path']: item['reason'] for item in result['kept']}
        self.assertEqual(kept[str(self.first['prefix'])], 'named-by-database:runs.detail')
        self.assertEqual(kept[str(self.failed['prefix'])], 'named-by-unit-or-config')
        self.assertEqual(kept[str(self.leftover_release)], 'used-by-a-process')
        self.assertTrue(self.first['prefix'].exists() and self.failed['prefix'].exists() and self.leftover_release.exists())

    def test_a_deleted_database_row_that_still_sits_in_free_pages_does_not_keep_a_release(self):
        row = self.tree.record('{"runtimeRoot": "' + str(self.first['prefix']) + '/lib/himawari-agent"}')
        with closing(sqlite3.connect(self.tree.database)) as database, database:
            database.execute('pragma secure_delete = off')
            database.execute('delete from runs where id = ?', (row,))
        self.assertIn(str(self.first['prefix']).encode(), self.tree.database.read_bytes())
        self.run_cleanup()
        self.assertFalse(self.first['prefix'].exists())

    def test_an_old_configuration_backup_does_not_keep_a_release(self):
        (self.tree.etc / 'config.json.before-static-root-fix-20261025T120544Z').write_text('{"staticRoot": "' + str(self.first['prefix']) + '/share/ui"}')
        result = self.run_cleanup()
        self.assertFalse(self.first['prefix'].exists())
        self.assertEqual(result['unreadableTables'], [])

    def test_a_similar_name_is_not_taken_for_a_reference(self):
        (self.tree.etc / 'config.json').write_text('{"runtime": "' + str(self.leftover_release) + '-other/lib"}')
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

    def state_copies(self, count):
        copies = []
        for index in range(count):
            for directory in (self.tree.lib / 'state/data' / ('pre-migration-ab' + str(index)), self.tree.lib / 'state' / ('.raw-restore-r' + str(index) + '-original')):
                database = self.tree.file(directory / 'product.sqlite', 11 * MEBIBYTE)
                os.utime(database, (5000 + index, 5000 + index))
                copies.append(directory)
        return copies

    def test_the_three_newest_upgrade_and_restore_copies_stay_and_older_ones_go(self):
        copies = self.state_copies(5)
        result = self.run_cleanup()
        self.assertEqual([path.exists() for path in copies], [False, False, False, False, True, True, True, True, True, True])
        self.assertEqual(sorted(item['reason'] for item in result['deleted'] if item['reason'] == 'old-state-copy'), ['old-state-copy'] * 4)
        self.assertTrue(self.tree.database.exists())

    def test_plan_mode_keeps_upgrade_and_restore_copies(self):
        copies = self.state_copies(5)
        self.run_cleanup(apply=False)
        self.assertTrue(all(path.exists() for path in copies))

    def test_an_old_upgrade_copy_named_by_a_process_is_kept(self):
        copies = self.state_copies(5)
        result = self.run_cleanup(references=[str(copies[0] / 'product.sqlite')])
        self.assertTrue(copies[0].exists())
        self.assertIn('used-by-a-process', [item['reason'] for item in result['kept'] if item['path'] == str(copies[0])])

    def test_plan_keeps_three_upgrade_and_restore_copies_under_the_state_root(self):
        plan = self.tree.plan(self.failed)
        self.assertEqual((plan['keepStateCopies'], plan['stateRoot']), (3, str(self.tree.lib / 'state')))

    def test_p3_1_local_embedding_models_under_the_state_root_are_never_cleaned(self):
        self.state_copies(5)
        models = [self.tree.file(self.tree.lib / 'state/models' / name / (digit * 64) / 'model.onnx', 11 * MEBIBYTE) for name, digit in (('jina-embeddings-v5-text-small-retrieval-int8', 'a'), ('qwen3-embedding-0.6b-int8', 'b'))]
        for model in models:
            os.utime(model, (1000, 1000))
        result = self.run_cleanup()
        self.assertTrue(all(model.exists() for model in models))
        self.assertFalse([item for item in result['deleted'] + result['trimmed'] if '/models/' in item['path']])

    def test_a_second_run_finds_nothing_more(self):
        self.run_cleanup()
        again = self.run_cleanup()
        self.assertEqual((again['deleted'], again['trimmed']), ([], []))


class FailureSceneCleanupTest(CleanupCase):
    def deleted_scenes(self, result):
        return sorted(Path(item['path']).name for item in result['deleted'] if item['reason'] == 'failure-scene')

    def test_only_the_newest_failure_scene_stays(self):
        old, middle, newest = (self.tree.scene(name, stamp) for name, stamp in (('hh3uq', 1000), ('hQLLK', 2000), ('hga59', 3000)))
        result = self.run_cleanup()
        self.assertEqual(self.deleted_scenes(result), ['hQLLK', 'hh3uq'])
        self.assertEqual((old.exists(), middle.exists(), newest.exists()), (False, False, True))
        self.assertIn({'path': str(newest), 'reason': 'newest-failure-scene'}, result['kept'])

    def test_after_a_passed_deploy_no_failure_scene_stays(self):
        scenes = [self.tree.scene('hh3uq', 1000), self.tree.scene('hga59', 3000)]
        self.run_cleanup(keepFailureScenes=0)
        self.assertEqual([scene.exists() for scene in scenes], [False, False])

    def test_plan_mode_deletes_no_scene(self):
        scene = self.tree.scene('hh3uq', 1000)
        self.tree.scene('hga59', 3000)
        result = self.run_cleanup(apply=False)
        self.assertEqual(self.deleted_scenes(result), ['hh3uq'])
        self.assertTrue(scene.exists())

    def test_a_scene_a_process_uses_stays_and_does_not_count_as_the_newest(self):
        busy = self.tree.scene('hh3uq', 1000)
        older = self.tree.scene('hBkQ5', 500)
        newest = self.tree.scene('hga59', 3000)
        self.run_cleanup(references=[str(busy / 's')])
        self.assertEqual((busy.exists(), older.exists(), newest.exists()), (True, False, True))

    def test_directories_that_only_look_like_scenes_are_not_touched(self):
        wrong_mode = self.tree.scene('hVqoS', 1000, mode=0o755)
        wrong_owner = self.tree.scene('hR7tM', 1000)
        link = self.tree.scratch / 'hlink'
        link.symlink_to(wrong_mode)
        too_long = self.tree.scene('hhh3uq1', 1000)
        plain_file = self.tree.file(self.tree.scratch / 'hfile')
        systemd = self.tree.file(self.tree.scratch / 'systemd-private-x/keep.txt')
        self.run_cleanup(scratchOwnerUids=[os.getuid() + 1])
        for survivor in (wrong_mode, wrong_owner, too_long, plain_file, systemd):
            self.assertTrue(survivor.exists(), survivor)
        self.assertTrue(link.is_symlink())

    def test_a_second_run_finds_no_scene(self):
        self.tree.scene('hh3uq', 1000)
        self.tree.scene('hga59', 3000)
        self.run_cleanup()
        self.assertEqual(self.deleted_scenes(self.run_cleanup()), [])


class QualificationLeftoverCleanupTest(CleanupCase):
    def target(self):
        return Path(self.tree.plan(self.failed)['qualificationTarget'])

    def deleted(self, result):
        return [item['path'] for item in result['deleted'] if item['reason'] == 'empty-qualification-leftover']

    def test_plan_names_the_qualification_directory_of_this_release(self):
        self.assertEqual(self.target(), self.tree.lib / 'qualification' / 'twentieth-20261030')

    def test_empty_directory_left_by_a_failed_acceptance_is_removed(self):
        self.target().mkdir()
        result = self.run_cleanup()
        self.assertEqual(self.deleted(result), [str(self.target())])
        self.assertFalse(self.target().exists())

    def test_plan_mode_reports_but_keeps_it(self):
        self.target().mkdir()
        result = self.run_cleanup(apply=False)
        self.assertEqual(self.deleted(result), [str(self.target())])
        self.assertTrue(self.target().exists())

    def test_directory_with_content_is_cleared_and_its_reports_are_kept(self):
        self.target().mkdir()
        self.tree.file(self.target() / 'host-qualification-public-key.pem')
        self.tree.file(self.target() / 'publication.json')
        result = self.run_cleanup()
        self.assertFalse(self.target().exists())
        self.assertIn({'path': str(self.target()), 'bytes': unittest.mock.ANY, 'reason': 'failed-attempt-target-path'}, result['deleted'])
        archived = self.tree.lib / 'release-cleanup/failed-attempts/20261030T010000Z' / str(self.target()).lstrip('/') / 'publication.json'
        self.assertTrue(archived.exists())
        self.assertEqual(result['targetPathsLeft'], [])

    def test_a_process_using_it_keeps_it(self):
        self.target().mkdir()
        self.run_cleanup(references=[str(self.target())])
        self.assertTrue(self.target().exists())

    def test_other_releases_and_files_under_the_qualification_root_are_untouched(self):
        (self.tree.lib / 'qualification' / 'nineteenth-20261029').mkdir()
        self.target().mkdir()
        self.run_cleanup()
        self.assertTrue((self.tree.lib / 'qualification' / 'nineteenth-20261029').exists())
        self.assertTrue(self.unrelated_lib.exists())

    def test_a_symbolic_link_is_not_followed_or_removed(self):
        elsewhere = self.tree.root / 'elsewhere'
        elsewhere.mkdir()
        self.target().symlink_to(elsewhere)
        self.run_cleanup()
        self.assertTrue(self.target().is_symlink())
        self.assertTrue(elsewhere.exists())

    def test_a_target_outside_the_qualification_root_is_refused(self):
        outside = self.tree.root / 'var/lib/himawari/state'
        with self.assertRaisesRegex(RuntimeError, 'CLEANUP_QUALIFICATION_PATH_INVALID'):
            self.run_cleanup(qualificationTarget=str(outside))
        self.assertTrue(outside.exists())

    def test_a_second_run_finds_nothing(self):
        self.target().mkdir()
        self.run_cleanup()
        self.assertEqual(self.deleted(self.run_cleanup()), [])


class TargetPathClearingTest(CleanupCase):
    PREFLIGHT = load('deploy_preflight', 'deploy-preflight.py')

    def targets(self, release):
        return self.PREFLIGHT.target_paths(release['binding'])

    def test_cleanup_handles_exactly_the_paths_the_preflight_requires_absent(self):
        for release in (self.failed, self.serving):
            self.assertEqual(self.tree.plan(release)['targetPaths'], self.targets(release))

    def test_leftovers_of_every_kind_are_cleared_before_the_preflight(self):
        qualification = Path(self.failed['binding']['service']['newQualificationEvidenceRoot'])
        self.tree.file(qualification / 'publication.json')
        self.tree.file(self.failed['operations'] / 'run-01/s6-report.json')
        result = self.run_cleanup()
        self.assertEqual([path for path in self.targets(self.failed) if os.path.lexists(path)], [])
        self.assertEqual(result['targetPathsLeft'], [])
        attempt = self.tree.lib / 'release-cleanup/failed-attempts/20261030T010000Z'
        self.assertTrue((attempt / str(qualification).lstrip('/') / 'publication.json').exists())
        self.assertTrue((attempt / str(self.failed['operations']).lstrip('/') / 'run-01/s6-report.json').exists())

    def test_plan_mode_changes_nothing(self):
        qualification = Path(self.failed['binding']['service']['newQualificationEvidenceRoot'])
        self.tree.file(qualification / 'publication.json')
        result = self.run_cleanup(apply=False)
        self.assertTrue(qualification.exists())
        self.assertEqual(result['targetPathsLeft'], [])
        self.assertFalse((self.tree.lib / 'release-cleanup/failed-attempts').exists())

    def test_paths_of_the_serving_release_stay_and_are_reported(self):
        result = self.run_cleanup(current=self.serving)
        left = {item['path']: item['reason'] for item in result['targetPathsLeft']}
        self.assertEqual(left[str(self.serving['prefix'])], 'serving')
        self.assertEqual(left[str(self.serving['operations'])], 'serving')
        self.assertTrue(self.serving['prefix'].exists() and self.serving['operations'].exists())

    def test_the_serving_qualification_stays(self):
        qualification = Path(self.serving['binding']['service']['newQualificationEvidenceRoot'])
        self.tree.file(qualification / 'publication.json')
        result = self.run_cleanup(current=self.serving)
        self.assertTrue((qualification / 'publication.json').exists())
        self.assertIn({'path': str(qualification), 'reason': 'serving'}, result['targetPathsLeft'])

    def test_a_path_used_by_a_process_stays_and_is_reported(self):
        qualification = Path(self.failed['binding']['service']['newQualificationEvidenceRoot'])
        self.tree.file(qualification / 'publication.json')
        result = self.run_cleanup(references=[str(qualification)])
        self.assertTrue(qualification.exists())
        self.assertIn({'path': str(qualification), 'reason': 'used-by-a-process'}, result['targetPathsLeft'])

    def test_a_release_named_by_the_database_stays_and_is_reported(self):
        self.tree.record('tool ran from ' + str(self.failed['prefix']) + '/bin/x')
        result = self.run_cleanup()
        self.assertTrue(self.failed['prefix'].exists())
        self.assertIn({'path': str(self.failed['prefix']), 'reason': 'named-by-database:runs.detail'}, result['targetPathsLeft'])

    def test_paths_other_than_releases_named_by_the_database_stay_and_are_reported(self):
        qualification = Path(self.failed['binding']['service']['newQualificationEvidenceRoot'])
        self.tree.file(qualification / 'publication.json')
        self.tree.file(self.failed['operations'] / 'run-01/s6-report.json')
        self.tree.record('fingerprints in ' + str(self.failed['operations']) + '/runtime-fingerprints.json')
        self.tree.record('published to ' + str(qualification))
        result = self.run_cleanup()
        self.assertTrue((qualification / 'publication.json').exists() and (self.failed['operations'] / 'run-01/s6-report.json').exists())
        left = {item['path']: item['reason'] for item in result['targetPathsLeft']}
        self.assertEqual((left[str(qualification)], left[str(self.failed['operations'])]), ('named-by-database:runs.detail', 'named-by-database:runs.detail'))

    def test_a_database_row_naming_a_longer_sibling_path_does_not_keep_a_target_path(self):
        qualification = Path(self.failed['binding']['service']['newQualificationEvidenceRoot'])
        self.tree.file(qualification / 'publication.json')
        self.tree.record('published to ' + str(qualification) + '-older')
        result = self.run_cleanup()
        self.assertFalse(qualification.exists())
        self.assertEqual(result['targetPathsLeft'], [])

    def test_the_failed_release_keeps_its_reports_before_it_is_deleted(self):
        self.tree.file(self.failed['prefix'] / 'install-report.json')
        self.run_cleanup()
        attempt = self.tree.lib / 'release-cleanup/failed-attempts/20261030T010000Z'
        self.assertFalse(self.failed['prefix'].exists())
        self.assertTrue((attempt / str(self.failed['prefix']).lstrip('/') / 'install-report.json').exists())

    def test_an_unreadable_database_table_keeps_every_target_path(self):
        qualification = Path(self.failed['binding']['service']['newQualificationEvidenceRoot'])
        self.tree.file(qualification / 'publication.json')
        with unittest.mock.patch.object(remote, 'database_references', return_value={'unreadableTables': ['runs']}):
            result = self.run_cleanup()
        self.assertTrue(self.failed['prefix'].exists() and self.failed['operations'].exists() and qualification.exists())
        left = {item['path']: item['reason'] for item in result['targetPathsLeft']}
        self.assertEqual((left[str(self.failed['prefix'])], left[str(qualification)]), ('database-unreadable', 'database-unreadable'))

    def test_the_paths_of_a_passed_deploy_are_left_only_as_the_serving_release(self):
        result = self.run_cleanup(current=self.serving)
        self.assertEqual({item['reason'] for item in result['targetPathsLeft']}, {'serving'})

    def test_a_symbolic_link_stays_and_is_not_followed(self):
        elsewhere = self.tree.file(self.tree.root / 'elsewhere/keep.json')
        qualification = Path(self.failed['binding']['service']['newQualificationEvidenceRoot'])
        qualification.parent.mkdir(parents=True, exist_ok=True)
        qualification.symlink_to(elsewhere.parent)
        result = self.run_cleanup()
        self.assertTrue(qualification.is_symlink() and elsewhere.exists())
        self.assertIn({'path': str(qualification), 'reason': 'not-a-directory'}, result['targetPathsLeft'])

    def test_paths_outside_the_allowed_parents_are_refused(self):
        plan = self.tree.plan(self.failed)
        for path in ('/', str(self.tree.lib), str(self.tree.lib / 'qualification/../state'), str(self.tree.lib / 'state/data')):
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, 'CLEANUP_TARGET_PATH_INVALID'):
                self.run_cleanup(targetPaths=plan['targetPaths'] + [path])
        self.assertTrue(self.tree.database.exists())

    def test_only_the_newest_failed_attempts_are_kept(self):
        root = self.tree.lib / 'release-cleanup/failed-attempts'
        for stamp in ('20261001T000000Z', '20261002T000000Z', '20261003T000000Z'):
            self.tree.file(root / stamp / 'x/report.json')
        self.tree.file(Path(self.failed['binding']['service']['newQualificationEvidenceRoot']) / 'publication.json')
        self.run_cleanup()
        self.assertEqual(sorted(os.listdir(root)), ['20261003T000000Z', '20261030T010000Z'])

    def test_failed_attempts_over_the_byte_limit_are_trimmed_but_the_newest_stays(self):
        root = self.tree.lib / 'release-cleanup/failed-attempts'
        self.tree.file(root / '20261001T000000Z/x/report.json', 3 * MEBIBYTE)
        self.tree.file(root / '20261002T000000Z/x/report.json', 3 * MEBIBYTE)
        shutil.rmtree(self.failed['operations'])
        self.run_cleanup(failedAttemptBytes=MEBIBYTE)
        self.assertEqual(sorted(os.listdir(root)), ['20261002T000000Z'])

    def test_leftover_paths_make_the_local_run_exit_with_its_own_code(self):
        result = {'mode': 'apply', 'deleted': [], 'trimmed': [], 'renamed': [], 'kept': [], 'archived': [], 'freedBytes': 0, 'rootFreeBeforeBytes': 0, 'rootFreeAfterBytes': 0, 'targetPathsLeft': [{'path': '/opt/himawari/releases/x', 'reason': 'serving'}]}
        with unittest.mock.patch('sys.stdout'):
            self.assertEqual(local.report(result), local.TARGET_PATHS_LEFT_EXIT)
            self.assertEqual(local.report({**result, 'mode': 'plan'}), 0)
            self.assertEqual(local.report({**result, 'targetPathsLeft': []}), 0)


class StaleTransportTest(unittest.TestCase):
    SHA = 'a' * 64
    OTHER = 'b' * 64

    def spawn(self, flag, sha):
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)', flag, sha])
        self.addCleanup(lambda: (process.kill(), process.wait()))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and flag.encode() not in Path('/proc/%d/cmdline' % process.pid).read_bytes():
            time.sleep(0.01)
        return process

    def test_finds_only_a_transport_of_this_packets_freeze_sha(self):
        mine = self.spawn('--approved-r2l13-twentythird-transport', self.SHA)
        self.spawn('--approved-r2l13-twentythird-transport', self.OTHER)
        self.spawn('--approved-r2l13-twentythird-step', self.SHA)
        self.assertEqual(remote.stale_transports(self.SHA, os.getpid()), [mine.pid])

    def test_a_sha_that_only_appears_inside_a_longer_argument_does_not_match(self):
        self.spawn('--approved-r2l13-twentythird-transport', self.SHA + 'ff')
        self.assertEqual(remote.stale_transports(self.SHA, os.getpid()), [])

    def test_apply_stops_the_leftover_process_and_plan_does_not(self):
        process = self.spawn('--approved-r2l13-twentythird-transport', self.SHA)
        planned = remote.terminate([process.pid], False)
        self.assertEqual(planned, [{'pid': process.pid, 'terminated': False}])
        self.assertIsNone(process.poll())
        applied = remote.terminate([process.pid], True, wait=3)
        process.wait(timeout=5)
        self.assertEqual(applied, [{'pid': process.pid, 'terminated': True}])

    def test_a_process_that_ignores_sigterm_is_killed(self):
        script = 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)'
        process = subprocess.Popen([sys.executable, '-c', script, '--approved-r2l13-twentythird-transport', self.SHA])
        self.addCleanup(lambda: (process.kill(), process.wait()))
        time.sleep(0.3)
        result = remote.terminate([process.pid], True, wait=1)
        process.wait(timeout=5)
        self.assertEqual(result, [{'pid': process.pid, 'terminated': True}])

    def test_plan_carries_the_freeze_sha_of_the_packet(self):
        binding = CleanupPlanTest().binding()
        self.assertEqual(local.cleanup_plan(binding, 1, self.SHA)['freezeSha256'], self.SHA)
        self.assertIsNone(local.cleanup_plan(binding)['freezeSha256'])


class CleanupPlanTest(unittest.TestCase):
    def test_plan_keeps_one_failure_scene_in_tmp_unless_told_otherwise(self):
        plan = local.cleanup_plan(self.binding())
        self.assertEqual((plan['scratchRoot'], plan['keepFailureScenes']), ('/tmp', 1))
        self.assertEqual(local.cleanup_plan(self.binding(), 0)['keepFailureScenes'], 0)

    def test_scratch_name_rule_matches_what_the_acceptance_creates(self):
        creator = (HERE / 'packet-template/acceptance/helpers/check-p5-scratch-cleanup.py').read_text()
        checker = (HERE / 'packet-template/acceptance/cloud/run-stage-03.py').read_text()
        self.assertIn('pathlib.Path("/tmp/h" + "".join(secrets.choice(', creator)
        self.assertIn("re.fullmatch('/tmp/" + remote.SCRATCH_NAME.pattern + "'", checker)
        alphabet = re.search(r'secrets\.choice\("([a-z0-9]+)"\) for index in range\((\d+)\)', creator)
        self.assertEqual(int(alphabet.group(2)), 4)
        self.assertTrue(remote.SCRATCH_NAME.fullmatch('h' + alphabet.group(1)[:2] + alphabet.group(1)[-2:]))

    def binding(self):
        return {'host': {'hostname': 'vmi1'}, 'service': {'unit': 'himawari-prod.service', 'unitFragmentPath': '/etc/systemd/system/himawari-prod.service', 'newQualificationEvidenceRoot': '/var/lib/himawari/qualification/twentieth-20261030'}, 'paths': {'newPrefix': '/opt/himawari/releases/2026-10-30-twentieth', 'oldPrefix': '/opt/himawari/releases/2026-10-29-nineteenth', 'newOperations': '/opt/himawari/operations/twentieth-20261030', 'evidenceRoot': '/var/lib/himawari/twentieth-20261030-evidence', 'transportRoot': '/var/tmp/himawari-twentieth-20261030/input', 'config': '/etc/himawari/config.json', 'database': '/var/lib/himawari/state/data/product.sqlite'}}

    def test_plan_comes_from_the_packet_bindings(self):
        binding = {'host': {'hostname': 'vmi1'}, 'service': {'unit': 'himawari-prod.service', 'unitFragmentPath': '/etc/systemd/system/himawari-prod.service', 'newQualificationEvidenceRoot': '/var/lib/himawari/qualification/twentieth-20261030'}, 'paths': {'newPrefix': '/opt/himawari/releases/2026-10-30-twentieth', 'newOperations': '/opt/himawari/operations/twentieth-20261030', 'evidenceRoot': '/var/lib/himawari/twentieth-20261030-evidence', 'transportRoot': '/var/tmp/himawari-twentieth-20261030/input', 'config': '/etc/himawari/config.json', 'database': '/var/lib/himawari/state/data/product.sqlite'}}
        plan = local.cleanup_plan(binding)
        self.assertEqual((plan['releasesRoot'], plan['operationsRoot'], plan['tmpRoot'], plan['evidenceParent'], plan['config']), ('/opt/himawari/releases', '/opt/himawari/operations', '/var/tmp', '/var/lib/himawari', '/etc/himawari/config.json'))


if __name__ == '__main__':
    unittest.main()
