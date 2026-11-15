import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
packet = Path(__file__).resolve().parents[1]
scratch = Path(sys.argv[1]).resolve()
checker = packet / 'inputs/check-packet-consistency.py'
results = []


def copy(root):
    target = root / packet.name
    shutil.copytree(packet, target, ignore=shutil.ignore_patterns('materials', '.DS_Store'))
    (target / 'materials').symlink_to(packet / 'materials', target_is_directory=True)
    return target


def run(target):
    completed = subprocess.run([sys.executable, '-I', str(checker), str(target)], text=True, capture_output=True)
    return completed.returncode, json.loads(completed.stdout)['problems'] if completed.stdout.startswith('{') else [completed.stderr]


def case(name, mutate, expected):
    with tempfile.TemporaryDirectory(prefix='consistency-', dir=scratch) as temporary:
        target = copy(Path(temporary))
        mutate(target)
        code, problems = run(target)
        passed = code == 0 and not problems if expected is None else code == 1 and any(problem.startswith(expected) for problem in problems)
        results.append({'name': name, 'passed': passed, 'exitCode': code, 'problems': problems})


def stale_probe_digest(target):
    path = target / 'measurement/probe/bootstrap.mjs'
    text = path.read_text()
    digest = re.search(r'"job-host-main\.js": "([0-9a-f]{64})"', text).group(1)
    path.write_text(text.replace(digest, '0' * 64))


def unlisted_loaded_helper(target):
    path = target / 'acceptance/cloud/cloud-inputs.draft.json'
    manifest = json.loads(path.read_text())
    del manifest['files']['adapters/failure-scene.py']
    path.write_text(json.dumps(manifest, indent=2) + '\n')


def stale_owned_digest(target):
    path = target / 'acceptance/OWNED-SHA256SUMS'
    lines = path.read_text().splitlines()
    lines[0] = '0' * 64 + lines[0][64:]
    path.write_text('\n'.join(lines) + '\n')


def unlisted_imported_module(target):
    path = target / 'maintenance/OWNED-SHA256SUMS'
    path.write_text(''.join(line + '\n' for line in path.read_text().splitlines() if not line.endswith('  maintenance/raw-copy-recovery.mjs')))


def edited_listed_script(target):
    path = target / 'acceptance/cloud/run-stage-03.py'
    path.write_bytes(path.read_bytes() + b'\n')


def edited_cleanup_helper(target):
    path = target / 'acceptance/helpers/check-p5-scratch-cleanup.py'
    path.write_bytes(path.read_bytes() + b'\n')


def edit_draft(target, change):
    path = target / 'acceptance/cloud/cloud-inputs.draft.json'
    manifest = json.loads(path.read_text())
    change(manifest)
    path.write_text(json.dumps(manifest, indent=2) + '\n')


def previous_deployment_schema(target):
    edit_draft(target, lambda manifest: manifest.update({'schema': 'himawari-third-cloud-acceptance-inputs.v1'}))


def previous_deployment_profile(target):
    edit_draft(target, lambda manifest: manifest.update({'profile': 'cloud-third-deployment'}))


def previous_deployment_stage_path(target):
    edit_draft(target, lambda manifest: manifest['candidate'].update({'artifact': '/var/tmp/himawari-third-20261012/input/candidate.tar.gz'}))


def previous_deployment_runtime(target):
    edit_draft(target, lambda manifest: manifest.update({'runtime': '__PKT_OLD_PREFIX__/lib/himawari-agent'}))


case('accepts the current packet', lambda target: None, None)
case('rejects a probe digest that differs from the candidate archive', stale_probe_digest, 'PROBE_DIGEST_STALE job-host-main.js')
case('rejects a loaded helper missing from the cloud input list', unlisted_loaded_helper, 'REFERENCED_BUT_UNLISTED adapters/failure-scene.py')
case('rejects a stale owned digest', stale_owned_digest, 'OWNED_DIGEST_STALE acceptance/OWNED-SHA256SUMS')
case('rejects an imported module missing from an owned list', unlisted_imported_module, 'REFERENCED_BUT_UNLISTED maintenance/raw-copy-recovery.mjs')
case('rejects a listed script edited after its digest was recorded', edited_listed_script, 'CLOUD_INPUT_DIGEST_STALE run-stage-03.py')
case('rejects a cleanup helper edited after its bound digest was recorded', edited_cleanup_helper, 'CLOUD_INPUT_CLEANUP_HELPER_DIGEST_STALE')
case('rejects a cloud input schema left from another deployment', previous_deployment_schema, 'CLOUD_INPUT_IDENTITY_STALE schema')
case('rejects a cloud input profile left from another deployment', previous_deployment_profile, 'CLOUD_INPUT_IDENTITY_STALE profile')
case('rejects a cloud input path under another deployment stage', previous_deployment_stage_path, 'CLOUD_INPUT_IDENTITY_STALE candidate.artifact')
case('rejects a cloud input runtime from another release', previous_deployment_runtime, 'CLOUD_INPUT_IDENTITY_STALE runtime')
report = {'schema': 'himawari-packet-consistency-fixtures.v1', 'passed': all(item['passed'] for item in results), 'total': len(results), 'failed': sum(not item['passed'] for item in results), 'results': results}
print(json.dumps(report, indent=1))
sys.exit(0 if report['passed'] else 1)
