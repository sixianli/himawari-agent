import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path

sys.dont_write_bytecode = True
packet = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else None
if packet is None or not packet.is_dir():
    raise SystemExit('usage: check-packet-consistency.py <packet>')
problems = []


def sha(data):
    return hashlib.sha256(data).hexdigest()


def files_under(root):
    return sorted(str(path.relative_to(root)) for path in root.rglob('*') if path.is_file() and path.name != '.DS_Store')


def referenced_but_unlisted(root, scope, listed, ignored):
    texts = {member: (root / member).read_bytes().decode('utf-8', 'replace') for member in listed}
    for candidate in files_under(scope):
        relative = str((scope / candidate).relative_to(root))
        if relative in listed or relative in ignored:
            continue
        name = Path(relative).name
        holders = sorted(member for member, text in texts.items() if member != relative and (relative in text or re.search(r'(?<![\w.-])' + re.escape(name) + r'(?![\w.-])', text)))
        if holders:
            problems.append(f'REFERENCED_BUT_UNLISTED {relative} referenced by {holders[:3]}')


cloud = packet / 'acceptance/cloud'
draft_path = cloud / 'cloud-inputs.draft.json'
draft = json.loads(draft_path.read_text())
for relative, expected in draft['files'].items():
    path = cloud / relative
    if not path.is_file():
        problems.append(f'CLOUD_INPUT_MISSING {relative}')
    elif sha(path.read_bytes()) != expected:
        problems.append(f'CLOUD_INPUT_DIGEST_STALE {relative}')
referenced_but_unlisted(cloud, cloud, {name for name in draft['files'] if (cloud / name).is_file()}, {'cloud-inputs.draft.json'})
helper_path = draft['cleanupHelper']['path']
helper_member = helper_path.split('/packet/', 1)[-1]
helper = packet / helper_member if helper_path.count('/packet/') == 1 and not helper_member.startswith('/') and '..' not in helper_member.split('/') else None
if helper is None or not helper.is_file():
    problems.append(f'CLOUD_INPUT_CLEANUP_HELPER_MISSING {helper_path}')
elif sha(helper.read_bytes()) != draft['cleanupHelper']['sha256']:
    problems.append(f'CLOUD_INPUT_CLEANUP_HELPER_DIGEST_STALE {helper_path}')

consumer = (cloud / 'finalize-cloud-inputs.py').read_text()
consumer_stage = re.search(r"^stage = Path\('([^']+)'\)$", consumer, re.M)
consumer_runtime = re.search(r"^runtime = Path\('([^']+)'\)$", consumer, re.M)
consumer_identity = re.search(r"manifest\['schema'\] != '([^']+)' or manifest\['profile'\] != '([^']+)'", consumer)
if not (consumer_stage and consumer_runtime and consumer_identity):
    problems.append('CLOUD_INPUT_CONSUMER_IDENTITY_NOT_FOUND finalize-cloud-inputs.py')
else:
    stage_root = consumer_stage.group(1)
    release_root = str(Path(consumer_runtime.group(1)).parents[1])
    expected_identity = {'schema': consumer_identity.group(1), 'profile': consumer_identity.group(2), 'runtime': consumer_runtime.group(1), 'sourceRoot': stage_root + '/validation/source', 'evidenceRoot': stage_root + '/acceptance'}
    for field, expected in expected_identity.items():
        if draft.get(field) != expected:
            problems.append(f'CLOUD_INPUT_IDENTITY_STALE {field} draft={draft.get(field)} consumer={expected}')

    def stale_paths(value, field):
        if isinstance(value, dict):
            for key, item in value.items():
                yield from stale_paths(item, f'{field}.{key}' if field else key)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                yield from stale_paths(item, f'{field}[{index}]')
        elif isinstance(value, str):
            if value.startswith('/var/tmp/') and not value.startswith(stage_root + '/'):
                yield field, value
            if value.startswith('/opt/himawari/releases/') and not value.startswith(release_root + '/'):
                yield field, value

    for field, value in stale_paths({key: item for key, item in draft.items() if key not in expected_identity and key != 'files'}, ''):
        problems.append(f'CLOUD_INPUT_IDENTITY_STALE {field} draft={value} consumer-stage={stage_root} consumer-release={release_root}')

owned = {
    'measurement/OWNED-SHA256SUMS': (packet / 'measurement', packet / 'measurement'),
    'systemd/OWNED-SHA256SUMS': (packet / 'systemd', packet / 'systemd'),
    'acceptance/OWNED-SHA256SUMS': (packet / 'acceptance', packet / 'acceptance'),
    'maintenance/OWNED-SHA256SUMS': (packet, packet / 'maintenance'),
}
for name, (root, scope) in owned.items():
    listed = set()
    for line in (packet / name).read_text().splitlines():
        expected, member = line.split('  ', 1)
        path = root / member
        listed.add(member)
        if not path.is_file():
            problems.append(f'OWNED_MEMBER_MISSING {name} {member}')
        elif sha(path.read_bytes()) != expected:
            problems.append(f'OWNED_DIGEST_STALE {name} {member}')
    referenced_but_unlisted(root, scope, {member for member in listed if (root / member).is_file()}, {str((packet / name).relative_to(root))})

materials = json.loads((packet / 'install/p5-materials.json').read_text())
archive_entry = next(entry for entry in materials['files'] if entry['name'] == 'candidate.tar.gz')
archive = packet / 'materials' / archive_entry.get('sourceName', archive_entry['name'])
bootstrap = (packet / 'measurement/probe/bootstrap.mjs').read_text()
originals = dict(re.findall(r'^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$', bootstrap, re.M))
if not originals:
    problems.append('PROBE_ORIGINALS_NOT_FOUND')
if not archive.is_file():
    problems.append(f'CANDIDATE_ARCHIVE_MISSING {archive.name}')
else:
    sources = {}
    with tarfile.open(archive, 'r:gz') as stream:
        for member in stream:
            for filename in originals:
                if member.isfile() and member.name.endswith('runtime-sandbox/dist/' + filename):
                    if filename in sources:
                        problems.append(f'PROBE_TARGET_AMBIGUOUS {filename}')
                    sources[filename] = stream.extractfile(member).read()
    for filename, expected in originals.items():
        if filename not in sources:
            problems.append(f'PROBE_TARGET_MISSING {filename}')
        elif sha(sources[filename]) != expected:
            problems.append(f'PROBE_DIGEST_STALE {filename} bootstrap={expected[:12]} candidate={sha(sources[filename])[:12]}')
    blocks = re.split(r'\n\s+(?:if|\} else if) \(basename === "([a-z-]+\.js)"', bootstrap)
    for index in range(1, len(blocks), 2):
        filename, body = blocks[index], blocks[index + 1]
        source = sources.get(filename, b'').decode('utf-8', 'replace')
        for quoted in re.findall(r'replace\(("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'),', body):
            anchor = quoted[1:-1].replace('\\"', '"').replace("\\'", "'")
            if source.count(anchor) != 1:
                problems.append(f'PROBE_ANCHOR_COUNT {filename} count={source.count(anchor)} {anchor[:60]}')

scripts = {str(path.relative_to(packet)): path.read_text(errors='replace') for path in packet.rglob('*') if path.is_file() and path.suffix in {'.py', '.mjs', '.sh', '.sql'} and 'fixtures' not in path.parts and 'materials' not in path.parts}
step_names = set(re.findall(r'\b(S[0-9]+_[A-Z0-9_]+)\b', '\n'.join(scripts.values())))
templated_results = {step.lower() + '-result.json' for step in step_names} if any('-result.json`' in text for text in scripts.values()) else set()
for reader in ['systemd/S7-switch-start-readback.py', 'systemd/S7-startup-readback.mjs']:
    text = scripts.get(reader)
    if text is None:
        problems.append(f'EVIDENCE_READER_MISSING {reader}')
        continue
    for name in sorted(set(re.findall(r"""['"](s[0-9][a-z0-9_.-]*\.json)['"]""", text))):
        written_here = re.search(r'retain_json\([^)]*' + re.escape(name), text)
        writers = [member for member, body in scripts.items() if member != reader and re.search(r"""['"`/]""" + re.escape(name) + r"""['"`]""", body)]
        if not (written_here or writers or name in templated_results):
            problems.append(f'EVIDENCE_NAME_WITHOUT_PRODUCER {reader} {name}')

print(json.dumps({'schema': 'himawari-packet-consistency.v1', 'packet': packet.name, 'passed': not problems, 'problems': problems}, indent=1))
sys.exit(1 if problems else 0)
