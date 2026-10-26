import json
import sys
from pathlib import Path

repo = Path(__file__).resolve().parents[3]
draft_path = repo / '.ci-output/production/2026-10-26-twelfth-change-packet-01/inputs/bindings.draft.json'
apply = sys.argv[1:] == ['--apply']
draft = json.loads(draft_path.read_text())

candidate_keys = [
    'testedCommit', 'archivePath', 'archiveBytes', 'archiveSha256', 'contextPath', 'contextBytes', 'contextSha256',
    'sourceTreeDigest', 'materialReadback', 'layer3Status', 'layer3Fingerprint', 'layer3Counts', 'layer3Projects',
    'hermesLayer3Report', 'hermesLayer3ReportBytes', 'hermesLayer3ReportSha256', 'hermesLayer3TestsReport',
    'hermesLayer3TestsReportBytes', 'hermesLayer3TestsReportSha256', 'hermesLayer4Report', 'hermesLayer4ReportBytes',
    'hermesLayer4ReportSha256', 'layer4Scope', 'layer4FinalCandidateEvidence', 'layer4FinalCandidateEvidenceBytes',
    'layer4FinalCandidateEvidenceSha256', 'layer4CandidateRelation', 'evidenceIds', 'artifactRuntimeAndUiContentSha256',
    'installationRehearsalEvidence', 'installedPrefixDigestHermesOnly',
]
installation_keys = [
    'sourceBundlePath', 'sourceBundleBytes', 'sourceBundleSha256', 'sourceModeProofBytes', 'sourceModeProofSha256',
    'sourceModeProofRecordCount', 'sourceModeCounts', 'sourceModeProofDigestBeforeAndAfter',
]
targets = [(('candidate', key), 'candidate.' + key) for key in candidate_keys]
targets += [(('installationInputs', key), 'candidate.' + key) for key in installation_keys]
targets += [(('approvals', 'qualificationRule'), 'user.qualificationRule'), (('approvals', 'executionMethod'), 'user.executionMethod')]

old = {}
for (section, key), pending in targets:
    holder = draft[section]
    if key not in holder:
        raise SystemExit('DRAFT_PATH_MISSING ' + section + '.' + key)
    if isinstance(holder[key], str) and holder[key].startswith('PENDING:'):
        raise SystemExit('DRAFT_ALREADY_PENDING ' + section + '.' + key)
    old[section + '.' + key] = holder[key]
    holder[key] = 'PENDING:' + pending

if draft['d1Commit'] != draft['gateCommit'] or draft['d1Commit'] != old['candidate.testedCommit']:
    raise SystemExit('DRAFT_COMMITS_DISAGREE')
text = json.dumps(draft, ensure_ascii=False, indent=2) + '\n'
for leftover in ['925fb296', '1792949110912']:
    count = text.count(leftover)
    print('leftover', leftover, count)
print(json.dumps({'unfilled': len(targets)}, indent=1))
packet = draft_path.parents[1]
finalize = packet / 'inputs/finalize-bindings.py'
finalize_text = finalize.read_text()
head_lines = [line for line in finalize_text.splitlines() if line.startswith("head = '")]
if head_lines != ["head = '" + old['candidate.testedCommit'] + "'"]:
    raise SystemExit('FINALIZE_HEAD_LINE_UNEXPECTED')
old_config = {}
for name in ['systemd/S2-stop-and-inspect.py', 'maintenance/S9-control-files.py']:
    filename = packet / name
    content = filename.read_text()
    lines = [line for line in content.splitlines() if line.startswith("OLD_CONFIG_SHA = '")]
    if len(lines) != 1 or 'PENDING:' in lines[0]:
        raise SystemExit('OLD_CONFIG_LINE_UNEXPECTED ' + name)
    old_config[filename] = content.replace(lines[0], "OLD_CONFIG_SHA = 'PENDING:s0.service.configurationSha256'")
if apply:
    draft_path.write_text(text)
    finalize.write_text(finalize_text.replace(head_lines[0], "head = 'PENDING:candidate.testedCommit'"))
    for filename, content in old_config.items():
        filename.write_text(content)
    print('applied')
