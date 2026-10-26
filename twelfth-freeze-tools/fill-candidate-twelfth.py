import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

repo = Path(__file__).resolve().parents[3]
packet = repo / '.ci-output/production/2026-10-26-twelfth-change-packet-01'
if len(sys.argv) not in (3, 4) or not re.fullmatch(r'[0-9a-f]{40}', sys.argv[1]) or sys.argv[3:] not in ([], ['--apply']):
    raise SystemExit('usage: fill-candidate-twelfth.py <revision> <build summary> [--apply]')
head = sys.argv[1]
build_summary = Path(sys.argv[2])
apply = sys.argv[3:] == ['--apply']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


materials = json.loads((packet / 'install/p5-materials.json').read_text())
by_name = {entry['name']: entry for entry in materials['files']}
archive = packet / 'materials' / by_name['candidate.tar.gz']['sourceName']
context = packet / 'materials/context.json'
bundle = packet / 'materials' / ('source-' + head[:7] + '.bundle')
proof_path = packet / 'materials/source-build-inputs.json'
proof = json.loads(proof_path.read_text())
assert proof['passed'] is True and proof['sourceHead'] == head and proof['sourceTreeDigestBefore'] == proof['sourceTreeDigestAfter']
assert proof['sourceWritesPerformed'] is False and proof['permissionChangesPerformed'] is False
assert json.loads(context.read_text())['testedSha'] == head
assert sha(archive) == by_name['candidate.tar.gz']['sha256'] and sha(bundle) == by_name[bundle.name]['sha256']
summary_text = build_summary.read_text()
assert 'build-status=passed artifacts=1 verdict=LAYER3_VERDICT_PASSED checks=build' in summary_text and summary_text.rstrip().endswith('DONE')

not_run = 'not-run: Layer 3 and Layer 4 reruns at ' + head[:8] + ' skipped in fast delivery mode (DELIVERY_MODE=fast, ADR 0073, approved by Andy 2026-10-25T10:07Z; G180); only a Hermes build was run'
modes = Counter(format(entry['mode'], '04o') for entry in proof['records'])
values = {
    'candidate.testedCommit': head,
    'candidate.archivePath': str(archive),
    'candidate.archiveBytes': archive.stat().st_size,
    'candidate.archiveSha256': sha(archive),
    'candidate.contextPath': str(context),
    'candidate.contextBytes': context.stat().st_size,
    'candidate.contextSha256': sha(context),
    'candidate.sourceTreeDigest': proof['sourceTreeDigestBefore'],
    'candidate.materialReadback': 'Hermes build at ' + head[:8] + ' (cc-build-' + head[:8] + '-r1, build check passed) and a real-browser release walkthrough of this archive on Hermes (browser-acceptance/walkthrough.json, required by deploy.sh); no installer rehearsal (fast delivery mode, G180)',
    'candidate.layer3Status': not_run,
    'candidate.layer3Fingerprint': not_run,
    'candidate.layer3Counts': not_run,
    'candidate.layer3Projects': not_run,
    'candidate.hermesLayer3Report': not_run,
    'candidate.hermesLayer3ReportBytes': not_run,
    'candidate.hermesLayer3ReportSha256': not_run,
    'candidate.hermesLayer3TestsReport': not_run,
    'candidate.hermesLayer3TestsReportBytes': not_run,
    'candidate.hermesLayer3TestsReportSha256': not_run,
    'candidate.hermesLayer4Report': not_run,
    'candidate.hermesLayer4ReportBytes': not_run,
    'candidate.hermesLayer4ReportSha256': not_run,
    'candidate.layer4Scope': not_run,
    'candidate.layer4FinalCandidateEvidence': not_run,
    'candidate.layer4FinalCandidateEvidenceBytes': not_run,
    'candidate.layer4FinalCandidateEvidenceSha256': not_run,
    'candidate.layer4CandidateRelation': not_run,
    'candidate.evidenceIds': ['G177', 'G180'],
    'candidate.artifactRuntimeAndUiContentSha256': 'not-run: no installer rehearsal (fast delivery mode, G180)',
    'candidate.installationRehearsalEvidence': 'not-run: no installer rehearsal (fast delivery mode, G180)',
    'candidate.installedPrefixDigestHermesOnly': 'not-run: no installer rehearsal (fast delivery mode, G180)',
    'candidate.sourceBundlePath': str(bundle.relative_to(packet)),
    'candidate.sourceBundleBytes': bundle.stat().st_size,
    'candidate.sourceBundleSha256': sha(bundle),
    'candidate.sourceModeProofBytes': proof_path.stat().st_size,
    'candidate.sourceModeProofSha256': sha(proof_path),
    'candidate.sourceModeProofRecordCount': len(proof['records']),
    'candidate.sourceModeCounts': dict(sorted(modes.items())),
    'candidate.sourceModeProofDigestBeforeAndAfter': proof['sourceTreeDigestBefore'],
    'user.qualificationRule': 'G180',
    'user.executionMethod': 'G180',
}
draft_path = packet / 'inputs/bindings.draft.json'
draft = json.loads(draft_path.read_text())
used = set()


def fill(value):
    if isinstance(value, dict):
        return {key: fill(item) for key, item in value.items()}
    if isinstance(value, list):
        return [fill(item) for item in value]
    if isinstance(value, str) and value.startswith(('PENDING:candidate.', 'PENDING:user.')):
        key = value.removeprefix('PENDING:')
        used.add(key)
        return values[key]
    return value


filled = fill(draft)
assert used == set(values), sorted(set(values) ^ used)
assert 'PENDING:' not in json.dumps(filled)
finalize_path = packet / 'inputs/finalize-bindings.py'
finalize = finalize_path.read_text()
assert finalize.count("head = 'PENDING:candidate.testedCommit'\n") == 1
print(json.dumps({key: values[key] for key in sorted(values)}, indent=1, ensure_ascii=False))
if apply:
    draft_path.write_text(json.dumps(filled, ensure_ascii=False, indent=2) + '\n')
    finalize_path.write_text(finalize.replace("head = 'PENDING:candidate.testedCommit'\n", "head = '" + head + "'\n"))
    print('applied')
