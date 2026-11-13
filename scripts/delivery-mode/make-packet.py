import argparse
from collections import Counter
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
TEMPLATE = HERE / 'packet-template'
INSTANCES = HERE / 'instances'
BUILDER = HERE / 'hermes'
PLACEHOLDER = re.compile(r'__PKT_[A-Z0-9_]+?__')
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']
UNITS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth']
TEENS = ['tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth']
TENS = [('twenty', 'twentieth'), ('thirty', 'thirtieth'), ('forty', 'fortieth'), ('fifty', 'fiftieth'), ('sixty', 'sixtieth'), ('seventy', 'seventieth'), ('eighty', 'eightieth'), ('ninety', 'ninetieth')]
ORDINALS = UNITS + TEENS + [word for base, ordinal in TENS for word in [ordinal] + [base + unit for unit in UNITS]]
MIGRATIONS = 'packages/persistence-sqlite/src/migrations'
MIGRATION_ENGINE = 'packages/persistence-sqlite/src/migration-engine.ts'
MIGRATION_COMPARED_TABLES = ('capability_declarations', 'product_state_records', 'execution_environment_release_receipts')
REGRESSION_SOURCE = 'test/integration/product-path-browser.test.ts'
WORKER_SERVICE_MAIN = 'apps/execution-worker/src/service-main.ts'
S0_SCRIPTS = ('s0-db/read-s0-db.mjs', 'signing/collect-system-tools.mjs', 'signing/cloud-system-tool-bindings.mjs', 'acceptance/helpers/observe-production-npm.py')
S0_OUTPUTS = ('s0-db-readback', 'system-tools-observed', 'npm-observed')
FREEZE_OUTPUTS = ('inputs/bindings.json', 'inputs/bindings.reviewed.json', 'freeze-manifest.json')
OLD_CONFIG_HOLDERS = ('systemd/S2-stop-and-inspect.py', 'maintenance/S9-control-files.py')
OLD_CONFIG_PENDING = "OLD_CONFIG_SHA = 'PENDING:s0.service.configurationSha256'"
OLD_CONFIG_LINE = re.compile(r"^OLD_CONFIG_SHA = '[^'\n]*'$", re.M)
OWNED_SUMS = {'measurement/OWNED-SHA256SUMS': 'measurement', 'systemd/OWNED-SHA256SUMS': 'systemd', 'acceptance/OWNED-SHA256SUMS': 'acceptance', 'maintenance/OWNED-SHA256SUMS': ''}
CLOUD_INPUTS = 'acceptance/cloud/cloud-inputs.draft.json'
CARRY_MANIFEST = 'acceptance/cloud/r2l6-source-manifest.json'
ADAPTATION_MANIFEST = 'acceptance/cloud/adaptation-manifest.json'
SOURCE_CACHE_NAME = 'source-cache.git'
PARAMETERS = 'packet-parameters.json'
CHECKS_RECORD = 'packet-checks.json'
PYTHON_MATERIAL = ('python-3.12.10.tar.gz', 'f50d08e0304b15d752b22932047135c1dc02f81977b284e51288be9d90627bca')
MATERIAL_FILES = ('context.json', 'source-build-inputs.json', 'node-modules.tar.gz', 'node-modules.json', 'npm-ls.json', PYTHON_MATERIAL[0])
EXECUTION_NOTE = 'G180'
DISCOVERED_KEYS = ('OLD_PREFIX', 'OLD_OPERATIONS', 'OLD_QUALIFICATION', 'ORIGINAL_CONTEXT_WINDOW', 'ORIGINAL_MAX_TOKENS', 'ORIGINAL_PUBLIC_FETCH_BYTES')
FAST_MODE_NOTE = 'skipped in fast delivery mode (DELIVERY_MODE=fast, ADR 0073, approved by Andy 2026-10-25T10:07Z; G180)'


def load_untested_claims():
    spec = importlib.util.spec_from_file_location('untested_claims', HERE / 'untested-claims.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


UNTESTED_CLAIMS = load_untested_claims()


class PacketError(Exception):
    pass


def refuse(code, detail=''):
    raise PacketError((code + ' ' + str(detail)).strip())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def git(*arguments, binary=False):
    child = subprocess.run(['git', '-C', str(REPO), *arguments], capture_output=True, check=False)
    if child.returncode != 0:
        refuse('PACKET_GIT_FAILED', ' '.join(arguments) + ' ' + child.stderr.decode(errors='replace').strip())
    return child.stdout if binary else child.stdout.decode().strip()


def load_instance(name):
    path = INSTANCES / (name + '.json')
    if not re.fullmatch(r'[a-z0-9-]+', name) or not path.is_file():
        refuse('PACKET_INSTANCE_UNKNOWN', name)
    return json.loads(path.read_text())


def next_label(running):
    if running not in ORDINALS or running == ORDINALS[-1]:
        refuse('PACKET_LABEL_NOT_DERIVABLE', running)
    return ORDINALS[ORDINALS.index(running) + 1]


def resolve_commit(reference):
    commit = git('rev-parse', '--verify', reference + '^{commit}')
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        refuse('PACKET_COMMIT_INVALID', reference)
    return commit


def require_current_scripts(commit):
    head = git('rev-parse', 'HEAD')
    if subprocess.run(['git', '-C', str(REPO), 'merge-base', '--is-ancestor', commit, head], capture_output=True, check=False).returncode != 0:
        refuse('PACKET_SCRIPTS_OLDER_THAN_COMMIT', 'these scripts are at ' + head + ', which does not contain ' + commit + '; run make-packet.py from a checkout of that commit')


TIMESTAMP_MIGRATION = re.compile(r'([0-9]{14})_([a-z][a-z0-9_]*)\.sql')
MIGRATION_META = re.compile(r'[0-9]{14}_[a-z][a-z0-9_]*\.meta\.json')


def migration_files(commit):
    legacy, timestamped = [], []
    for name in (Path(name).name for name in git('ls-tree', '--name-only', commit, MIGRATIONS + '/').splitlines()):
        legacy_match = re.fullmatch(r'([0-9]{4})_[a-z0-9_]+\.sql', name)
        timestamp_match = TIMESTAMP_MIGRATION.fullmatch(name)
        if legacy_match:
            legacy.append(int(legacy_match.group(1)))
        elif timestamp_match:
            timestamped.append((timestamp_match.group(1), timestamp_match.group(2), name))
        elif not MIGRATION_META.fullmatch(name):
            refuse('PACKET_MIGRATION_FILE_NOT_RECOGNIZED', name)
    legacy.sort()
    timestamped.sort()
    if not legacy or legacy != list(range(1, len(legacy) + 1)):
        refuse('PACKET_MIGRATIONS_NOT_CONTIGUOUS', legacy[-3:])
    if len({entry[0] for entry in timestamped}) != len(timestamped):
        refuse('PACKET_MIGRATION_IDS_NOT_UNIQUE', [entry[0] for entry in timestamped][-3:])
    return legacy, timestamped


def target_migration_ids(commit):
    legacy, timestamped = migration_files(commit)
    return ['%04d' % number for number in legacy] + [entry[0] for entry in timestamped]


def check_migration_replay(commit, applied_ids=None):
    command = ['node', str(REPO / 'scripts' / 'check-migration-conflicts.mjs'), '--commit', commit]
    if applied_ids is not None:
        command += ['--applied', ','.join(applied_ids)]
    try:
        child = subprocess.run(command, capture_output=True, text=True, check=False, timeout=300)
    except subprocess.TimeoutExpired:
        raise PacketError('MIGRATION_REPLAY_TIMED_OUT ' + commit)
    if child.returncode != 0:
        raise PacketError('MIGRATION_REPLAY_FAILED ' + (child.stderr or child.stdout).strip()[:400])


def target_schema(commit):
    check_migration_replay(commit)
    return len(target_migration_ids(commit))


def startup_ready_budget(instance, worker_source):
    seconds, margin = instance.get('startupReadyBudgetSeconds'), instance.get('startupReadyMarginSeconds')
    if type(seconds) is not int or seconds <= 0 or type(margin) is not int or margin <= 0:
        refuse('PACKET_STARTUP_BUDGET_INVALID', str(seconds) + '/' + str(margin))
    found = re.findall(r'^const DEFAULT_STARTUP_WAIT_TIMEOUT_MS = ([0-9_]+);$', worker_source, re.M)
    if len(found) != 1:
        refuse('PACKET_WORKER_STARTUP_WAIT_NOT_READABLE', WORKER_SERVICE_MAIN)
    wait = int(found[0].replace('_', ''))
    if (seconds + margin) * 1000 > wait:
        refuse('PACKET_STARTUP_BUDGET_LEAVES_NO_MARGIN', 'budgetMs=' + str(seconds * 1000) + ' marginMs=' + str(margin * 1000) + ' workerWaitMs=' + str(wait))
    return seconds * 1000


def startup_phase_baseline(instance):
    baseline = instance.get('startupPhaseBaselineMs')
    if type(baseline) is not dict or not baseline or not all(type(step) is str and re.fullmatch(r'[a-z]+(?:-[a-z]+)*', step) and type(ms) is int and ms > 0 for step, ms in baseline.items()):
        refuse('PACKET_STARTUP_PHASE_BASELINE_INVALID', json.dumps(baseline))
    return json.dumps(baseline, sort_keys=True)


def preserved_tables():
    source = (TEMPLATE / 's0-db' / 'read-s0-db.mjs').read_text()
    match = re.search(r'historyTables = Object\.freeze\(\[(.*?)\]\)', source, re.S)
    if not match:
        refuse('PACKET_HISTORY_TABLES_NOT_FOUND')
    return tuple(re.findall(r'"([a-z_]+)"', match.group(1))) + MIGRATION_COMPARED_TABLES


def migration_ledger(commit, current, target, applied_ids=None):
    if target == current and applied_ids is None:
        return []
    engine = git('show', commit + ':' + MIGRATION_ENGINE)
    entries = {int(sequence): {'sequence': int(sequence), 'name': name, 'phase': phase, 'file': filename} for sequence, name, phase, filename in re.findall(r'sequence: ([0-9]+),\s*name: "([a-z0-9_]+)",\s*changeSet: "[^"]*",\s*phase: "([a-z]+)" as const,\s*file: "([0-9]{4}_[a-z0-9_]+\.sql)"', engine)}
    _, timestamped = migration_files(commit)
    by_id = {entry[0]: entry for entry in timestamped}
    target_ids = target_migration_ids(commit)
    if applied_ids is None:
        target_ids = target_ids[:target]
    applied = list(applied_ids) if applied_ids is not None else target_ids[:current]
    if len(applied) != current or not set(applied) <= set(target_ids):
        refuse('PACKET_PRODUCTION_HAS_MIGRATIONS_NOT_IN_COMMIT', sorted(set(applied) - set(target_ids)))
    pending = [identifier for identifier in target_ids if identifier not in set(applied)]
    if len(pending) != target - current:
        refuse('PACKET_MIGRATION_COUNT_MISMATCH', str(len(pending)) + '/' + str(target - current))
    ledger = []
    tables = preserved_tables()
    for offset, identifier in enumerate(pending):
        sequence = current + offset + 1
        if identifier in by_id:
            file_name = by_id[identifier][2]
            entry = {'sequence': sequence, 'name': by_id[identifier][1], 'phase': 'expand', 'file': file_name}
        else:
            entry = entries.get(int(identifier))
            if entry is None or entry['file'] != '%04d_%s.sql' % (int(identifier), entry['name']):
                refuse('PACKET_MIGRATION_NOT_IN_ENGINE', identifier)
            entry = dict(entry, sequence=sequence)
        sql = git('show', commit + ':' + MIGRATIONS + '/' + entry['file'])
        touched = sorted(table for table in tables if re.search(r'\b(?:ALTER\s+TABLE|DROP\s+TABLE|UPDATE|DELETE\s+FROM|INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO)\s+"?' + table + r'\b', sql, re.I))
        if touched:
            refuse('PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES', entry['file'] + ' ' + ','.join(touched))
        ledger.append({key: entry[key] for key in ('sequence', 'name', 'phase')})
    return ledger


def discovery_script():
    return '\n'.join([
        'import hashlib, json, os, pathlib, socket, subprocess, sys',
        'unit_name, unit_path, config_path, model_ref, prefix_new, operations_new, source_cache = sys.argv[1:8]',
        'unit = pathlib.Path(unit_path).read_bytes()',
        'config_bytes = pathlib.Path(config_path).read_bytes()',
        'config = json.loads(config_bytes)',
        "models = [entry for entry in config.get('modelDescriptors', []) if isinstance(entry, dict) and entry.get('ref') == model_ref]",
        "fetch = config.get('runPolicy', {}).get('publicFetch', {})",
        'print(json.dumps({',
        "    'hostname': socket.gethostname(),",
        "    'active': subprocess.run(['/usr/bin/systemctl', 'is-active', unit_name], capture_output=True, text=True).stdout.strip(),",
        "    'execStart': [line for line in unit.decode().splitlines() if line.startswith('ExecStart=')],",
        "    'staticRoot': config.get('http', {}).get('staticRoot'),",
        "    'modelCount': len(models),",
        "    'model': {key: models[0].get(key) for key in ('contextWindow', 'maxTokens')} if len(models) == 1 else None,",
        "    'publicFetchMaximumBytes': fetch.get('maximumBytes') if isinstance(fetch, dict) else None,",
        "    'budgetsPresent': 'budgets' in config,",
        "    'configSha256': hashlib.sha256(config_bytes).hexdigest(),",
        "    'unitSha256': hashlib.sha256(unit).hexdigest(),",
        "    'newPathsExist': [path for path in (prefix_new, operations_new) if os.path.lexists(path)],",
        "    'sourceCacheCommits': subprocess.run(['/usr/bin/git', '-C', source_cache, 'for-each-ref', '--format=%(objectname)', 'refs/release'], capture_output=True, text=True).stdout.split() if os.path.isdir(source_cache) else [],",
        '}))',
    ]) + '\n'


def ssh_command(instance, remote):
    return [os.environ.get('HIMAWARI_PACKET_SSH', 'ssh'), *SSH_OPTIONS, 'root@' + instance['host']['address'], remote]


def run_remote(instance, remote, stdin_bytes, timeout=300):
    child = subprocess.run(ssh_command(instance, remote), input=stdin_bytes, capture_output=True, timeout=timeout, check=False)
    if child.returncode != 0:
        refuse('PACKET_SSH_FAILED', 'exit=' + str(child.returncode) + ' ' + child.stderr.decode(errors='replace').strip()[-400:])
    return child.stdout


def source_cache(instance):
    return str(Path(instance['fixedByTemplate']['releasesRoot']).parent / SOURCE_CACHE_NAME)


def discover(instance, label, date):
    fixed = instance['fixedByTemplate']
    compact = date.replace('-', '')
    arguments = [fixed['unit'], fixed['unitPath'], fixed['config'], instance['configTargets']['modelRef'], fixed['releasesRoot'] + '/' + date + '-' + (label or 'unknown'), fixed['operationsRoot'] + '/' + (label or 'unknown') + '-' + compact, source_cache(instance)]
    remote = '/usr/bin/python3 -I - ' + ' '.join(shlex.quote(argument) for argument in arguments)
    return json.loads(run_remote(instance, remote, discovery_script().encode(), timeout=60))


def interpret_discovery(facts, instance, label=None):
    fixed = instance['fixedByTemplate']
    if facts.get('hostname') != instance['host']['hostname']:
        refuse('PACKET_HOST_UNEXPECTED', facts.get('hostname'))
    if facts.get('active') != 'active':
        refuse('PACKET_SERVICE_NOT_ACTIVE', facts.get('active'))
    pattern = r'ExecStart=\S+ --no-global-search-paths (' + re.escape(fixed['operationsRoot']) + r'/([a-z]+)-([0-9]{8}))/pair-supervisor\.mjs --prefix (' + re.escape(fixed['releasesRoot']) + r'/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z]+) --config ' + re.escape(fixed['config']) + r' '
    starts = [re.match(pattern, line) for line in facts.get('execStart', [])]
    if len(starts) != 1 or starts[0] is None:
        refuse('PACKET_RUNNING_UNIT_NOT_RECOGNIZED', facts.get('execStart'))
    operations, running_label, prefix = starts[0].group(1), starts[0].group(2), starts[0].group(4)
    if facts.get('staticRoot') != prefix + '/share/control-center':
        refuse('PACKET_STATIC_ROOT_NOT_RUNNING_RELEASE', facts.get('staticRoot'))
    if facts.get('budgetsPresent') is not False:
        refuse('PACKET_CONFIG_BUDGETS_PRESENT')
    model = facts.get('model') or {}
    if facts.get('modelCount') != 1 or not all(type(model.get(key)) is int and model[key] > 0 for key in ('contextWindow', 'maxTokens')):
        refuse('PACKET_CONFIG_MODEL_LIMITS_NOT_READABLE', instance['configTargets']['modelRef'])
    fetch_bytes = facts.get('publicFetchMaximumBytes')
    if type(fetch_bytes) is not int or fetch_bytes <= 0:
        refuse('PACKET_CONFIG_PUBLIC_FETCH_NOT_READABLE', fetch_bytes)
    chosen = label or next_label(running_label)
    if not re.fullmatch(r'[a-z]+', chosen) or chosen == running_label:
        refuse('PACKET_LABEL_INVALID', chosen)
    if facts.get('newPathsExist'):
        refuse('PACKET_TARGET_PATHS_EXIST', facts['newPathsExist'])
    return {
        'LABEL': chosen,
        'OLD_LABEL': running_label,
        'OLD_PREFIX': prefix,
        'OLD_OPERATIONS': operations,
        'OLD_QUALIFICATION': fixed['qualificationRoot'] + '/' + Path(operations).name,
        'ORIGINAL_CONTEXT_WINDOW': model['contextWindow'],
        'ORIGINAL_MAX_TOKENS': model['maxTokens'],
        'ORIGINAL_PUBLIC_FETCH_BYTES': fetch_bytes,
        'DISCOVERED_CONFIG_SHA256': facts.get('configSha256'),
        'DISCOVERED_UNIT_SHA256': facts.get('unitSha256'),
        'SOURCE_CACHE_COMMITS': sorted(commit for commit in facts.get('sourceCacheCommits', []) if re.fullmatch(r'[0-9a-f]{40}', commit)),
    }


EMBEDDING_TARGET_KEYS = {'ref', 'role', 'provider', 'model', 'version', 'allowedDataClassifications', 'disclosure', 'secretRef', 'capabilities', 'cost', 'dimensions'}
EMBEDDING_PROFILES = {
    ('vercel-ai-gateway', 'alibaba/qwen3-embedding-8b'): (4096, 1024),
    ('local-onnx', 'jina-embeddings-v5-text-small-retrieval-int8'): (1024,),
    ('local-onnx', 'qwen3-embedding-0.6b-int8'): (1024,),
    ('local-onnx', 'embeddinggemma-2-fp32'): (768,),
}


def finite_non_negative(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(float(value)) and value >= 0
    except OverflowError:
        return False


def embedding_target(target):
    if target is None:
        return 'null'
    reference = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}')
    if not isinstance(target, dict) or target.get('role') != 'embedding' or not all(isinstance(target.get(key), str) and reference.fullmatch(target[key]) for key in ('ref', 'provider', 'model', 'version')):
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    local = target['provider'] == 'local-onnx'
    if set(target) != EMBEDDING_TARGET_KEYS | ({'artifactSha256'} if local else set()):
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    dimensions = EMBEDDING_PROFILES.get((target['provider'], target['model']))
    if dimensions is None or type(target['dimensions']) is not int or target['dimensions'] not in dimensions:
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    cost, capabilities, classifications = target['cost'], target['capabilities'], target['allowedDataClassifications']
    if not isinstance(cost, dict) or set(cost) != {'input', 'output', 'cacheRead', 'cacheWrite'} or not all(finite_non_negative(value) for value in cost.values()):
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    if not isinstance(capabilities, list) or 'embedding' not in capabilities or not all(isinstance(value, str) and reference.fullmatch(value) for value in capabilities) or len(set(capabilities)) != len(capabilities):
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    if not isinstance(classifications, list) or not classifications or not all(isinstance(value, str) for value in classifications) or not set(classifications) <= {'public', 'private', 'sensitive', 'restricted'} or len(set(classifications)) != len(classifications):
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    if target['disclosure'] not in ('local_only', 'trusted_remote', 'external_remote'):
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    if target['secretRef'] is not None and not (isinstance(target['secretRef'], str) and reference.fullmatch(target['secretRef'])):
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    if local and (target['disclosure'] != 'local_only' or target['secretRef'] is not None or any(value != 0 for value in cost.values()) or not isinstance(target['artifactSha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', target['artifactSha256']) or set(target['artifactSha256']) == {'0'}):
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    if target['provider'] == 'vercel-ai-gateway' and target['secretRef'] is None:
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    encoded = json.dumps(target, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    if "'" in encoded or '\\' in encoded:
        refuse('PACKET_EMBEDDING_TARGET_INVALID', target)
    return encoded


def base_parameters(instance, commit, date, discovered):
    targets = instance['configTargets']
    label = discovered['LABEL']
    return {
        **discovered,
        'LABEL_TITLE': label.capitalize(),
        'LABEL_UPPER': label.upper(),
        'DATE': date,
        'DATE_COMPACT': date.replace('-', ''),
        'HOSTNAME': instance['host']['hostname'],
        'ADDRESS': instance['host']['address'],
        'COMMIT': commit,
        'COMMIT8': commit[:8],
        'COMMIT7': commit[:7],
        'BUNDLE_NAME': 'source-' + commit[:7] + '.bundle',
        'TARGET_SCHEMA': target_schema(commit),
        'MODEL_REF': targets['modelRef'],
        'TARGET_CONTEXT_WINDOW': targets['contextWindow'],
        'TARGET_MAX_TOKENS': targets['maxTokens'],
        'TARGET_PUBLIC_FETCH_BYTES': targets['publicFetchMaximumBytes'],
        'TARGET_EMBEDDING_JSON': embedding_target(targets.get('embedding')),
        'STARTUP_READY_BUDGET_MS': startup_ready_budget(instance, git('show', commit + ':' + WORKER_SERVICE_MAIN)),
        'STARTUP_PHASE_BASELINE_MS': startup_phase_baseline(instance),
    }


def schema_parameters(parameters, s0):
    schema = s0.get('schema', {})
    current, writer = schema.get('current'), schema.get('minimumWriter')
    if type(current) is not int or current <= 1 or writer != current:
        refuse('PACKET_S0_SCHEMA_INVALID', schema)
    target = parameters['TARGET_SCHEMA']
    if target < current:
        refuse('PACKET_COMMIT_OLDER_THAN_PRODUCTION_SCHEMA', 'production=' + str(current) + ' commit=' + str(target))
    applied_ids = s0.get('migrationIds')
    if applied_ids is not None:
        digests = s0.get('migrationDigests')
        pairs = [identifier + ':' + digest for identifier, digest in zip(applied_ids, digests)] if isinstance(digests, list) and len(digests) == len(applied_ids) else applied_ids
        check_migration_replay(parameters['COMMIT'], pairs)
    ledger = migration_ledger(parameters['COMMIT'], current, target, applied_ids) if target != current or applied_ids is not None else []
    return {'CURRENT_SCHEMA': current, 'PREVIOUS_SCHEMA': current - 1, 'MIGRATION_LEDGER': json.dumps(ledger, separators=(',', ':'))}


def substitute(text, parameters, where):
    def value(match):
        key = match.group(0)[6:-2]
        if key not in parameters:
            refuse('PACKET_PARAMETER_MISSING', key + ' in ' + where)
        return str(parameters[key])
    return PLACEHOLDER.sub(value, text)


def template_files(only=None):
    files = sorted(path for path in TEMPLATE.rglob('*') if path.is_file())
    if only is not None:
        files = [path for path in files if path.relative_to(TEMPLATE).as_posix() in only]
    return files


def render(target, parameters, only=None):
    written = []
    for source in template_files(only):
        relative = substitute(source.relative_to(TEMPLATE).as_posix(), parameters, 'file names')
        text = substitute(source.read_text(), parameters, relative)
        if '__PKT_' in text or '__PKT_' in relative:
            refuse('PACKET_PLACEHOLDER_LEFT', relative)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text)
        destination.chmod(source.stat().st_mode & 0o777)
        written.append(relative)
    return written


def describe_materials(materials, commit):
    artifacts = sorted(materials.glob('linux-x64-abi127-' + commit + '-*-1.tar.gz'))
    if len(artifacts) != 1:
        refuse('PACKET_ARTIFACT_COUNT', len(artifacts))
    for name in MATERIAL_FILES + ('source-' + commit[:7] + '.bundle',):
        if not (materials / name).is_file():
            refuse('PACKET_MATERIAL_MISSING', name)
    if file_sha(materials / PYTHON_MATERIAL[0]) != PYTHON_MATERIAL[1]:
        refuse('PACKET_PYTHON_MATERIAL_CHANGED')
    if json.loads((materials / 'context.json').read_text()).get('testedSha') != commit:
        refuse('PACKET_CONTEXT_OTHER_COMMIT')
    proof = json.loads((materials / 'source-build-inputs.json').read_text())
    if not (proof.get('passed') is True and proof.get('sourceHead') == commit and proof['sourceTreeDigestBefore'] == proof['sourceTreeDigestAfter'] and proof.get('sourceWritesPerformed') is False and proof.get('permissionChangesPerformed') is False):
        refuse('PACKET_SOURCE_PROOF_INVALID')
    bundle = materials / ('source-' + commit[:7] + '.bundle')
    heads = subprocess.run(['git', 'bundle', 'list-heads', str(bundle)], capture_output=True, text=True, check=False).stdout.strip()
    if heads != commit + ' HEAD':
        refuse('PACKET_BUNDLE_HEADS_UNEXPECTED', heads)
    regression = git('show', commit + ':' + REGRESSION_SOURCE, binary=True)
    artifact = artifacts[0]
    return {
        'ARTIFACT_NAME': artifact.name,
        'ARTIFACT_SHA256': file_sha(artifact),
        'ARTIFACT_BYTES': artifact.stat().st_size,
        'CONTEXT_SHA256': file_sha(materials / 'context.json'),
        'CONTEXT_BYTES': (materials / 'context.json').stat().st_size,
        'BUNDLE_SHA256': file_sha(bundle),
        'BUNDLE_BYTES': bundle.stat().st_size,
        'SOURCE_TREE_SHA256': proof['sourceTreeDigestBefore'],
        'NODE_MODULES_TAR_SHA256': file_sha(materials / 'node-modules.tar.gz'),
        'NODE_MODULES_TAR_BYTES': (materials / 'node-modules.tar.gz').stat().st_size,
        'NODE_MODULES_JSON_SHA256': file_sha(materials / 'node-modules.json'),
        'NODE_MODULES_JSON_BYTES': (materials / 'node-modules.json').stat().st_size,
        'NPM_LS_SHA256': file_sha(materials / 'npm-ls.json'),
        'NPM_LS_BYTES': (materials / 'npm-ls.json').stat().st_size,
        'SOURCE_INPUT_RECORD_COUNT': len(proof['records']),
        'REGRESSION_SOURCE_SHA256': sha(regression),
        'REGRESSION_SOURCE_BYTES': len(regression),
    }


def candidate_values(packet, commit, materials):
    proof_path = materials / 'source-build-inputs.json'
    proof = json.loads(proof_path.read_text())
    archive = next(materials.glob('linux-x64-abi127-' + commit + '-*-1.tar.gz'))
    context = materials / 'context.json'
    bundle = materials / ('source-' + commit[:7] + '.bundle')
    not_run = 'not-run: Layer 3 and Layer 4 reruns at ' + commit[:8] + ' ' + FAST_MODE_NOTE + '; only a Hermes build was run'
    no_rehearsal = 'not-run: no installer rehearsal (fast delivery mode, ' + EXECUTION_NOTE + ')'
    values = {
        'candidate.testedCommit': commit,
        'candidate.archivePath': str(packet / 'materials' / archive.name),
        'candidate.archiveBytes': archive.stat().st_size,
        'candidate.archiveSha256': file_sha(archive),
        'candidate.contextPath': str(packet / 'materials' / 'context.json'),
        'candidate.contextBytes': context.stat().st_size,
        'candidate.contextSha256': file_sha(context),
        'candidate.sourceTreeDigest': proof['sourceTreeDigestBefore'],
        'candidate.materialReadback': 'Hermes build at ' + commit[:8] + ' (generated by scripts/delivery-mode/make-packet.py, build check passed) and a real-browser release walkthrough of this archive on Hermes (browser-acceptance/walkthrough.json, required by deploy.sh); no installer rehearsal (fast delivery mode, ' + EXECUTION_NOTE + ')',
        'candidate.evidenceIds': ['G177', 'G180'],
        'candidate.artifactRuntimeAndUiContentSha256': no_rehearsal,
        'candidate.installationRehearsalEvidence': no_rehearsal,
        'candidate.installedPrefixDigestHermesOnly': no_rehearsal,
        'candidate.sourceBundlePath': 'materials/' + bundle.name,
        'candidate.sourceBundleBytes': bundle.stat().st_size,
        'candidate.sourceBundleSha256': file_sha(bundle),
        'candidate.sourceModeProofBytes': proof_path.stat().st_size,
        'candidate.sourceModeProofSha256': file_sha(proof_path),
        'candidate.sourceModeProofRecordCount': len(proof['records']),
        'candidate.sourceModeCounts': dict(sorted(Counter(format(entry['mode'], '04o') for entry in proof['records']).items())),
        'candidate.sourceModeProofDigestBeforeAndAfter': proof['sourceTreeDigestBefore'],
        'user.qualificationRule': EXECUTION_NOTE,
        'user.executionMethod': EXECUTION_NOTE,
    }
    for key in ('layer3Status', 'layer3Fingerprint', 'layer3Counts', 'layer3Projects', 'hermesLayer3Report', 'hermesLayer3ReportBytes', 'hermesLayer3ReportSha256', 'hermesLayer3TestsReport', 'hermesLayer3TestsReportBytes', 'hermesLayer3TestsReportSha256', 'hermesLayer4Report', 'hermesLayer4ReportBytes', 'hermesLayer4ReportSha256', 'layer4Scope', 'layer4FinalCandidateEvidence', 'layer4FinalCandidateEvidenceBytes', 'layer4FinalCandidateEvidenceSha256', 'layer4CandidateRelation'):
        values['candidate.' + key] = not_run
    return values


def fill_draft(packet, values):
    draft_path = packet / 'inputs/bindings.draft.json'
    used = set()

    def fill(value):
        if isinstance(value, dict):
            return {key: fill(item) for key, item in value.items()}
        if isinstance(value, list):
            return [fill(item) for item in value]
        if isinstance(value, str) and value.startswith(('PENDING:candidate.', 'PENDING:user.')):
            key = value.removeprefix('PENDING:')
            if key not in values:
                refuse('PACKET_DRAFT_VALUE_UNKNOWN', key)
            used.add(key)
            return values[key]
        return value

    filled = fill(json.loads(draft_path.read_text()))
    if used != set(values):
        refuse('PACKET_DRAFT_VALUES_UNUSED', sorted(set(values) - used))
    if 'PENDING:' in json.dumps(filled):
        refuse('PACKET_DRAFT_STILL_PENDING')
    draft_path.write_text(json.dumps(filled, ensure_ascii=False, indent=2) + '\n')


def adapter_drift(packet, commit):
    manifest = json.loads((packet / ADAPTATION_MANIFEST).read_text())
    drifted = []
    for adapter in manifest['adapters']:
        if sha(git('show', commit + ':' + adapter['source'], binary=True)) != adapter['sourceSha256']:
            drifted.append(adapter['source'])
    return drifted


def refresh_carried_copies(packet, commit):
    carry_path = packet / CARRY_MANIFEST
    carry = json.loads(carry_path.read_text())
    adaptation_text = (packet / ADAPTATION_MANIFEST).read_text()
    refreshed = []
    for entry in carry['files']:
        if entry.get('byteIdentical') is not True:
            continue
        data = git('show', commit + ':' + entry['source'], binary=True)
        if sha(data) == entry['sha256']:
            continue
        pattern = re.compile(r'("sha256": ")' + entry['sha256'] + r'(",\s*"bytes": )' + str(entry['bytes']) + r'\b')
        adaptation_text, count = pattern.subn(r'\g<1>' + sha(data) + r'\g<2>' + str(len(data)), adaptation_text)
        if count != 1:
            refuse('PACKET_CARRIED_COPY_NOT_IN_ADAPTATION_MANIFEST', entry['source'])
        (packet / 'acceptance/cloud' / entry['packetCopy']).write_bytes(data)
        entry['sha256'], entry['bytes'] = sha(data), len(data)
        refreshed.append(entry['source'])
    carry_path.write_text(json.dumps(carry, indent=2) + '\n')
    (packet / ADAPTATION_MANIFEST).write_text(adaptation_text)
    return refreshed


def regenerate_hashes(packet):
    draft_path = packet / CLOUD_INPUTS
    manifest = json.loads(draft_path.read_text())
    for relative in manifest['files']:
        manifest['files'][relative] = file_sha(packet / 'acceptance/cloud' / relative)
    draft_path.write_text(json.dumps(manifest, indent=2) + '\n')
    for name, root in OWNED_SUMS.items():
        lines = []
        for line in (packet / name).read_text().splitlines():
            member = line.split('  ', 1)[1]
            path = packet / root / member
            if not path.is_file():
                refuse('PACKET_OWNED_MEMBER_MISSING', name + ' ' + member)
            lines.append(file_sha(path) + '  ' + member)
        (packet / name).write_text('\n'.join(lines) + '\n')


def set_old_config(packet, value):
    replacement = OLD_CONFIG_PENDING if value is None else "OLD_CONFIG_SHA = '" + value + "'"
    for holder in OLD_CONFIG_HOLDERS:
        path = packet / holder
        text, count = OLD_CONFIG_LINE.subn(replacement, path.read_text())
        if count != 1:
            refuse('PACKET_OLD_CONFIG_LINE_COUNT', holder + ' ' + str(count))
        path.write_text(text)


def read_s0(instance, scripts, output):
    collector = (scripts / 'signing/collect-system-tools.mjs').read_bytes()
    pinned = re.findall(rb'verifierSha256: "([0-9a-f]{64})"', collector)
    if len(pinned) != 1 or pinned[0].decode() != file_sha(scripts / 'signing/cloud-system-tool-bindings.mjs'):
        refuse('PACKET_S0_VERIFIER_CHANGED')
    hostname = shlex.quote(instance['host']['hostname'])
    fixed = instance['fixedByTemplate']
    commands = {
        's0-db-readback': ('s0-db/read-s0-db.mjs', 'test "$(hostname)" = ' + hostname + ' && umask 022 && /usr/sbin/runuser -u ' + shlex.quote(fixed['serviceAccount']) + ' -- env -i HOME=' + shlex.quote(fixed['stateRoot']) + ' PATH=/opt/himawari/node/bin:/usr/bin:/bin LANG=C.UTF-8 /opt/himawari/node/bin/node --no-global-search-paths --input-type=module -'),
        'system-tools-observed': ('signing/collect-system-tools.mjs', 'test "$(hostname)" = ' + hostname + ' && /opt/himawari/node/bin/node --no-global-search-paths --input-type=module -'),
        'npm-observed': ('acceptance/helpers/observe-production-npm.py', 'test "$(hostname)" = ' + hostname + ' && /usr/bin/python3 -I - --approved-' + npm_observer_label(scripts) + '-production-npm-readonly-observation'),
    }
    output.mkdir(parents=True, exist_ok=True)

    def one(name):
        script, remote = commands[name]
        data = run_remote(instance, remote, (scripts / script).read_bytes())
        try:
            json.loads(data)
        except ValueError:
            refuse('PACKET_S0_OUTPUT_INVALID', name)
        target = output / (name + '.json')
        if target.exists():
            refuse('PACKET_S0_TARGET_EXISTS', name)
        target.write_bytes(data)
        return name

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(one, S0_OUTPUTS))
    return json.loads((output / 's0-db-readback.json').read_text())


def npm_observer_label(scripts):
    match = re.search(r'--approved-([a-z]+)-production-npm-readonly-observation', (scripts / 'acceptance/helpers/observe-production-npm.py').read_text())
    if match is None:
        refuse('PACKET_NPM_OBSERVER_FLAG_NOT_FOUND')
    return match.group(1)


class Hermes:
    def __init__(self, run):
        self.settings = json.loads((BUILDER / 'builder.json').read_text())
        self.ssh_wrapper = os.environ.get('HIMAWARI_HERMES_SSH', str(REPO / '.ci-output/handoff/scripts/hermes-ssh.sh'))
        self.upload_wrapper = os.environ.get('HIMAWARI_HERMES_UPLOAD', str(REPO / '.ci-output/handoff/scripts/hermes-upload.sh'))
        self.poll_seconds = float(os.environ.get('HIMAWARI_HERMES_POLL_SECONDS', '15'))
        self.run_id = run
        self.work = self.settings['workRoot'] + '/' + run
        self.scripts = self.settings['scriptRoot'] + '/' + run

    def ssh(self, command, stdout=None):
        child = subprocess.run([self.ssh_wrapper, command], stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE, timeout=320, check=False)
        if child.returncode != 0:
            refuse('PACKET_HERMES_COMMAND_FAILED', 'exit=' + str(child.returncode) + ' ' + command[:120] + ' ' + child.stderr.decode(errors='replace').strip()[-400:])
        return b'' if stdout else child.stdout

    def upload(self, local, remote, code='PACKET_HERMES_UPLOAD_FAILED'):
        child = subprocess.run([self.upload_wrapper, str(local), remote], capture_output=True, timeout=320, check=False)
        if child.returncode != 0:
            refuse(code, str(local) + ' -> ' + remote + ' ' + child.stderr.decode(errors='replace').strip()[-400:])

    def fetch(self, remote, local, expected_sha):
        partial = local.with_name(local.name + '.partial')
        with partial.open('wb') as stream:
            self.ssh('cat ' + shlex.quote(remote), stdout=stream)
        if file_sha(partial) != expected_sha:
            refuse('PACKET_HERMES_FETCH_DIGEST', remote)
        partial.rename(local)

    def probe_uploads(self):
        probe = Path(tempfile.mkdtemp(prefix='packet-probe-')) / 'upload-probe'
        probe.write_text(self.run_id + '\n')
        self.ssh('mkdir -p ' + shlex.quote(self.scripts) + ' ' + shlex.quote(self.work + '-inputs'))
        targets = [self.work + '-inputs/upload-probe', self.scripts + '/upload-probe']
        try:
            for target in targets:
                self.upload(probe, target, 'PACKET_HERMES_UPLOAD_AREA_REFUSED')
        finally:
            shutil.rmtree(probe.parent)
        self.ssh('rm -f ' + ' '.join(shlex.quote(target) for target in targets))

    def preflight(self):
        child = subprocess.run([self.ssh_wrapper, 'bash ' + shlex.quote(self.scripts + '/run-release-walkthrough.sh') + ' --preflight'], capture_output=True, timeout=320, check=False)
        if child.returncode != 0:
            refuse('PACKET_HERMES_PREFLIGHT_FAILED', (child.stdout + child.stderr).decode(errors='replace').strip()[-400:])

    def install_scripts(self):
        self.ssh('mkdir -p ' + shlex.quote(self.scripts) + ' ' + shlex.quote(self.work + '-inputs'))
        for name in ('build-candidate.sh', 'layer3-verdict.py', 'builder.json', 'run-release-walkthrough.sh', 'require-git-modes.sh', 'install-dependencies-if-changed.sh', 'capture-build-source-inputs.template.mjs'):
            self.upload(BUILDER / name, self.scripts + '/' + name)
        self.upload(TEMPLATE / 'acceptance/helpers/collect-installer-dependencies.mjs', self.scripts + '/collect-installer-dependencies.mjs')
        self.upload(HERE / 'run-packet-checks.py', self.scripts + '/run-packet-checks.py')

    def start(self, name, command):
        log_root = self.work + '-inputs'
        wrapped = '(' + command + '); echo $? > ' + shlex.quote(log_root + '/' + name + '.exit')
        self.ssh('nohup bash -c ' + shlex.quote(wrapped) + ' > ' + shlex.quote(log_root + '/' + name + '.log') + ' 2>&1 < /dev/null & echo started')

    def wait(self, name):
        log_root = self.work + '-inputs'
        while True:
            state = self.ssh('cat ' + shlex.quote(log_root + '/' + name + '.exit') + ' 2>/dev/null || echo running').decode().strip()
            if state != 'running':
                break
            time.sleep(self.poll_seconds)
        if state != '0':
            tail = self.ssh('tail -n 20 ' + shlex.quote(log_root + '/' + name + '.log')).decode(errors='replace')
            refuse('PACKET_HERMES_STEP_FAILED', name + ' exit=' + state + '\n' + tail)

    def has_commit(self, commit):
        command = 'git -C ' + shlex.quote(self.settings['source']) + ' cat-file -e ' + shlex.quote(commit + '^{commit}')
        return subprocess.run([self.ssh_wrapper, command], capture_output=True, timeout=320, check=False).returncode == 0

    def build(self, bundle, commit):
        remote_bundle = self.work + '-inputs/' + bundle.name
        self.upload(bundle, remote_bundle)
        self.start('build', 'bash ' + shlex.quote(self.scripts + '/build-candidate.sh') + ' ' + shlex.quote(remote_bundle) + ' ' + commit + ' ' + self.run_id)

    def fetch_materials(self, materials):
        sums = self.ssh('cat ' + shlex.quote(self.work + '/SHA256SUMS')).decode()
        expected = dict(reversed(line.split('  ', 1)) for line in sums.splitlines() if line)
        for name, digest in expected.items():
            if '/' in name or name.startswith('.'):
                refuse('PACKET_HERMES_MATERIAL_NAME', name)
            if name == PYTHON_MATERIAL[0] and (materials / name).is_file() and file_sha(materials / name) == digest:
                continue
            self.fetch(self.work + '/materials/' + name, materials / name, digest)

    def start_walkthrough(self):
        self.start('walkthrough', 'bash ' + shlex.quote(self.scripts + '/run-release-walkthrough.sh') + ' ' + self.run_id)

    def fetch_walkthrough(self, packet):
        target = packet / 'browser-acceptance' / 'walkthrough.json'
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(self.ssh('cat ' + shlex.quote(self.work + '/walkthrough/browser-acceptance.json')))

    def upload_check_materials(self, packet):
        self.ssh('mkdir -p ' + shlex.quote(self.work + '/materials'))
        archive = json.loads((packet / PARAMETERS).read_text())['ARTIFACT_NAME']
        for name in (archive, 'context.json'):
            self.upload(packet / 'materials' / name, self.work + '/materials/' + name)

    def check_packet(self, packet):
        archive = Path(tempfile.mkdtemp(prefix='packet-upload-')) / 'packet.tgz'
        with tarfile.open(archive, 'w:gz') as stream:
            stream.add(packet, arcname='packet', filter=lambda member: None if member.name.startswith('packet/materials/') else member)
        remote = self.work + '-inputs/packet.tgz'
        self.upload(archive, remote)
        shutil.rmtree(archive.parent)
        checks = self.work + '-checks'
        self.start('checks', ' && '.join([
            'rm -rf ' + shlex.quote(checks), 'mkdir -p ' + shlex.quote(checks),
            'tar -xzf ' + shlex.quote(remote) + ' -C ' + shlex.quote(checks),
            'rmdir ' + shlex.quote(checks + '/packet/materials'),
            'ln -s ' + shlex.quote(self.work + '/materials') + ' ' + shlex.quote(checks + '/packet/materials'),
            'HIMAWARI_CI_PYTHON=' + shlex.quote(self.settings['tools'] + '/python/python/bin/python3') + ' /usr/bin/python3 -I ' + shlex.quote(self.scripts + '/run-packet-checks.py') + ' ' + shlex.quote(checks + '/packet') + ' --node ' + shlex.quote(self.settings['tools'] + '/bin/node') + ' --source ' + shlex.quote(self.settings['source']) + ' --logs ' + shlex.quote(checks + '/logs') + ' --record ' + shlex.quote(checks + '/record.json') + ' --pi-tools ' + shlex.quote(self.settings['piToolBin']),
        ]))

    def cleanup(self):
        child = subprocess.run([self.ssh_wrapper, hermes_cleanup_command(self.work)], capture_output=True, timeout=320, check=False)
        print(('PACKET_HERMES_CLEANED ' if child.returncode == 0 else 'PACKET_HERMES_CLEANUP_FAILED ') + self.work, flush=True)

    def fetch_checks(self, packet, commit):
        record = json.loads(self.ssh('cat ' + shlex.quote(self.work + '-checks/record.json')))
        if record.get('passed') is not True:
            refuse('PACKET_CHECKS_FAILED', record)
        record.update(commit=commit, host=self.settings['hostname'], checkedAt=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
        (packet / CHECKS_RECORD).write_text(json.dumps(record, indent=2) + '\n')

def hermes_cleanup_command(work):
    targets = [work + '/materials', work + '-checks/packet', work + '-inputs/packet.tgz']
    return 'rm -rf ' + ' '.join(shlex.quote(target) for target in targets) + ' && rm -f ' + shlex.quote(work + '-inputs') + '/*.bundle'


def step(name, started):
    print('PACKET_STEP ' + name + ' ' + str(round(time.monotonic() - started, 1)) + 's', flush=True)


def bundle_prerequisites(bundle):
    prerequisites = []
    with open(bundle, 'rb') as stream:
        stream.readline()
        for line in stream:
            if line.strip() == b'':
                break
            if line.startswith(b'-'):
                prerequisites.append(line[1:41].decode())
    return prerequisites


def commit_is_ancestor(ancestor, descendant):
    return subprocess.run(['git', '-C', str(REPO), 'merge-base', '--is-ancestor', ancestor, descendant], capture_output=True, check=False).returncode == 0


def choose_source_base(commit, cache_commits):
    if commit in cache_commits:
        parent = subprocess.run(['git', '-C', str(REPO), 'rev-parse', '--verify', '--quiet', commit + '^'], capture_output=True, text=True, check=False)
        return parent.stdout.strip() or None
    best = None
    for cached in cache_commits:
        if not commit_is_ancestor(cached, commit):
            continue
        distance = int(git('rev-list', '--count', commit, '^' + cached))
        if best is None or (distance, cached) < best:
            best = (distance, cached)
    return best[1] if best else None


def create_bundle(commit, target, base=None):
    clone = Path(tempfile.mkdtemp(prefix='packet-bundle-'))
    try:
        subprocess.run(['git', 'clone', '-q', '--shared', '--no-checkout', str(REPO), str(clone / 'repo')], check=True)
        subprocess.run(['git', '-C', str(clone / 'repo'), 'update-ref', '--no-deref', 'HEAD', commit], check=True)
        subprocess.run(['git', '-C', str(clone / 'repo'), 'bundle', 'create', '-q', str(target), 'HEAD', *(['^' + base] if base else [])], check=True)
    finally:
        shutil.rmtree(clone, ignore_errors=True)
    heads = subprocess.run(['git', 'bundle', 'list-heads', str(target)], capture_output=True, text=True, check=True).stdout.strip()
    if heads != commit + ' HEAD':
        refuse('PACKET_BUNDLE_HEADS_UNEXPECTED', heads)
    prerequisites = bundle_prerequisites(target)
    if base is None and prerequisites:
        refuse('PACKET_BUNDLE_UNEXPECTED_PREREQUISITES', prerequisites)
    if base is not None and (not prerequisites or any(not (item == base or commit_is_ancestor(item, base)) for item in prerequisites)):
        refuse('PACKET_BUNDLE_PREREQUISITES_UNEXPECTED', ','.join(prerequisites))


def make_source_bundles(arguments, commit, parameters, materials, work, hermes):
    base = None if getattr(arguments, 'full_source', False) else choose_source_base(commit, parameters.get('SOURCE_CACHE_COMMITS', []))
    parameters['SOURCE_BASE_COMMIT'] = base or ''
    packet_bundle = materials / parameters['BUNDLE_NAME']
    create_bundle(commit, packet_bundle, base)
    if base and not hermes.has_commit(base):
        builder_bundle = work / 'builder.bundle'
        create_bundle(commit, builder_bundle)
        return builder_bundle
    return packet_bundle


def packet_directory(root, date, label):
    for attempt in range(1, 100):
        candidate = root / (date + '-' + label + '-change-packet-' + format(attempt, '02d'))
        if not candidate.exists():
            return candidate
    refuse('PACKET_DIRECTORY_EXHAUSTED')


def reuse_materials(previous, commit, materials, parameters):
    old = json.loads((previous / PARAMETERS).read_text())
    parameters['SOURCE_BASE_COMMIT'] = old.get('SOURCE_BASE_COMMIT', '')
    if old['COMMIT'] != commit:
        refuse('PACKET_REUSE_OTHER_COMMIT', old['COMMIT'])
    for path in (previous / 'materials').iterdir():
        if path.is_file():
            os.link(path, materials / path.name)
    walkthrough = previous / 'browser-acceptance' / 'walkthrough.json'
    if not walkthrough.is_file():
        refuse('PACKET_REUSE_WITHOUT_WALKTHROUGH', previous)
    return walkthrough.read_bytes()


def assemble(packet, parameters, materials):
    render(packet, parameters)
    drifted = adapter_drift(packet, parameters['COMMIT'])
    if drifted:
        refuse('PACKET_ADAPTER_SOURCE_CHANGED', drifted)
    refreshed = refresh_carried_copies(packet, parameters['COMMIT'])
    fill_draft(packet, candidate_values(packet, parameters['COMMIT'], materials))
    regenerate_hashes(packet)
    (packet / PARAMETERS).write_text(json.dumps(dict(sorted(parameters.items())), indent=2) + '\n')
    return refreshed


def finalize(packet, *arguments):
    child = subprocess.run([sys.executable, '-I', str(packet / 'inputs/finalize-bindings.py'), *arguments], capture_output=True, text=True, check=False)
    if child.returncode != 0:
        refuse('PACKET_FINALIZE_FAILED', ' '.join(arguments) + ' ' + (child.stdout + child.stderr).strip()[-800:])


def freeze(packet, instance):
    parameters = json.loads((packet / PARAMETERS).read_text())
    discovered = interpret_discovery(discover(instance, parameters['LABEL'], parameters['DATE']), instance, parameters['LABEL'])
    changed = sorted(key for key in DISCOVERED_KEYS if discovered[key] != parameters[key])
    if changed:
        refuse('PACKET_PRODUCTION_CHANGED_SINCE_PREPARE', changed)
    for relative in FREEZE_OUTPUTS:
        (packet / relative).unlink(missing_ok=True)
    for name in S0_OUTPUTS:
        (packet / 'inputs' / (name + '.json')).unlink(missing_ok=True)
    set_old_config(packet, None)
    s0 = read_s0(instance, packet, packet / 'inputs')
    if s0.get('schema', {}).get('current') != parameters['CURRENT_SCHEMA']:
        refuse('PACKET_PRODUCTION_SCHEMA_CHANGED_SINCE_PREPARE', s0.get('schema'))
    configuration = s0.get('service', {}).get('configurationSha256')
    if not isinstance(configuration, str) or re.fullmatch(r'[0-9a-f]{64}', configuration) is None:
        refuse('PACKET_S0_CONFIGURATION_DIGEST_INVALID')
    set_old_config(packet, configuration)
    regenerate_hashes(packet)
    finalize(packet, '--candidate-from-s0')
    finalize(packet, '--freeze-reviewed-packet', 'round2/R2-L13/' + parameters['LABEL'] + '-' + parameters['DATE_COMPACT'] + '/reviewed')
    for command in ([sys.executable, '-I', str(packet / 'inputs/check-packet-consistency.py'), str(packet)], [sys.executable, '-I', str(HERE / 'browser-acceptance-gate.py'), str(packet)]):
        child = subprocess.run(command, capture_output=True, text=True, check=False)
        if child.returncode != 0:
            refuse('PACKET_FROZEN_CHECK_FAILED', Path(command[2]).name + ' ' + child.stdout.strip()[-800:])
    return configuration


def write_readme(packet, parameters):
    lines = [
        '# ' + parameters['DATE'] + ' ' + parameters['LABEL'] + ' 操作包',
        '',
        '由 `scripts/delivery-mode/make-packet.py` 生成，模板是 `scripts/delivery-mode/packet-template/`，参数全部记在 `' + PARAMETERS + '`。不要手改包里的文件：要改就改模板或参数，再重新生成。',
        '',
        '- 上线的提交：`' + parameters['COMMIT'] + '`',
        '- 正在运行的版本：`' + parameters['OLD_PREFIX'] + '`',
        '- 新版本目录：`/opt/himawari/releases/' + parameters['DATE'] + '-' + parameters['LABEL'] + '`',
        '- 数据库版本：生产 ' + str(parameters['CURRENT_SCHEMA']) + '，代码 ' + str(parameters['TARGET_SCHEMA']),
        '- 冻结后服务只要重启过一次，上线前检查就会拒绝；这时运行 `python3 scripts/delivery-mode/make-packet.py freeze <本目录>` 重新冻结，约一分钟。',
        '- 上线：`bash scripts/delivery-mode/deploy.sh <本目录>`；回滚：`bash scripts/delivery-mode/rollback.sh <本目录>`。',
    ]
    (packet / 'README.md').write_text('\n'.join(lines) + '\n')


def run_id(parameters):
    return parameters['LABEL'] + '-' + parameters['COMMIT8'] + '-' + datetime.now(timezone.utc).strftime('%Y%m%dt%H%M%S')


def previous_release_commit(root):
    found = []
    for path in sorted(root.glob('*-change-packet-*/' + PARAMETERS)) if root.is_dir() else []:
        try:
            found.append(json.loads(path.read_text())['COMMIT'])
        except (OSError, ValueError, KeyError):
            continue
    return found[-1] if found else None


def require_claims_proven(commit, since, root):
    since = resolve_commit(since) if since else previous_release_commit(root)
    if since is None:
        refuse('PACKET_SINCE_UNKNOWN', 'no earlier packet under ' + str(root) + '; pass --since <commit of the release now in production>')
    if subprocess.run(['git', '-C', str(REPO), 'merge-base', '--is-ancestor', since, commit], capture_output=True, check=False).returncode != 0:
        refuse('PACKET_SINCE_NOT_ANCESTOR', since + ' is not an ancestor of ' + commit)
    problem = UNTESTED_CLAIMS.check_range(since, commit, repo=str(REPO))
    if problem:
        refuse('PACKET_UNTESTED_CLAIM_WITHOUT_PROOF', problem)


def prepare(arguments):
    started = time.monotonic()
    if getattr(arguments, 'full_source', False) and arguments.reuse_materials:
        refuse('PACKET_FULL_SOURCE_WITH_REUSE', '--reuse-materials copies the earlier packet\'s source bundle, so --full-source cannot take effect; drop --reuse-materials')
    instance = load_instance(arguments.instance)
    commit = resolve_commit(arguments.commit)
    require_current_scripts(commit)
    require_claims_proven(commit, arguments.since, Path(arguments.output_root).resolve())
    date = arguments.date or datetime.now(timezone.utc).strftime('%Y-%m-%d')
    discovered = interpret_discovery(discover(instance, arguments.label, date), instance, arguments.label)
    if arguments.label is None:
        discovered = interpret_discovery(discover(instance, discovered['LABEL'], date), instance, discovered['LABEL'])
    parameters = base_parameters(instance, commit, date, discovered)
    hermes = Hermes(run_id(parameters))
    work = Path(tempfile.mkdtemp(prefix='packet-work-'))
    try:
        build_packet(arguments, instance, commit, date, parameters, hermes, work, started)
    finally:
        hermes.cleanup()
        shutil.rmtree(work, ignore_errors=True)


def build_packet(arguments, instance, commit, date, parameters, hermes, work, started):
    hermes.probe_uploads()
    hermes.install_scripts()
    hermes.preflight()
    step('discover', started)
    packet = packet_directory(Path(arguments.output_root).resolve(), date, parameters['LABEL'])
    render(work / 's0-scripts', parameters, only=set(S0_SCRIPTS))
    parameters.update(schema_parameters(parameters, read_s0(instance, work / 's0-scripts', work / 's0')))
    step('s0-schema', started)
    materials = work / 'materials'
    materials.mkdir()
    walkthrough = None
    if arguments.reuse_materials:
        walkthrough = reuse_materials(Path(arguments.reuse_materials).resolve(), commit, materials, parameters)
        step('reuse-materials', started)
    else:
        builder_bundle = make_source_bundles(arguments, commit, parameters, materials, work, hermes)
        step('bundle', started)
        hermes.build(builder_bundle, commit)
        hermes.wait('build')
        step('hermes-build', started)
        hermes.start_walkthrough()
        hermes.fetch_materials(materials)
        step('fetch-materials', started)
    parameters.update(describe_materials(materials, commit))
    packet.mkdir(parents=True)
    shutil.move(str(materials), str(packet / 'materials'))
    refreshed = assemble(packet, parameters, packet / 'materials')
    if refreshed:
        print('PACKET_CARRIED_COPIES_REFRESHED ' + json.dumps(refreshed), flush=True)
    for name in S0_OUTPUTS:
        shutil.copy(work / 's0' / (name + '.json'), packet / 'inputs' / (name + '.json'))
    write_readme(packet, parameters)
    step('render', started)
    if walkthrough is not None:
        hermes.upload_check_materials(packet)
    hermes.check_packet(packet)
    hermes.wait('checks')
    hermes.fetch_checks(packet, commit)
    step('hermes-checks', started)
    if walkthrough is None:
        hermes.wait('walkthrough')
        hermes.fetch_walkthrough(packet)
        step('hermes-walkthrough', started)
    else:
        (packet / 'browser-acceptance').mkdir(exist_ok=True)
        (packet / 'browser-acceptance' / 'walkthrough.json').write_bytes(walkthrough)
    configuration = freeze(packet, instance)
    step('freeze', started)
    print('PACKET_READY ' + json.dumps({'packet': str(packet), 'commit': commit, 'label': parameters['LABEL'], 'schema': parameters['CURRENT_SCHEMA'], 'oldConfigSha256': configuration, 'seconds': round(time.monotonic() - started, 1)}))


def main(argv=None):
    parser = argparse.ArgumentParser(prog='make-packet.py')
    commands = parser.add_subparsers(dest='command', required=True)
    prepare_parser = commands.add_parser('prepare')
    prepare_parser.add_argument('--instance', default='andy-production')
    prepare_parser.add_argument('--commit', default='origin/main')
    prepare_parser.add_argument('--label')
    prepare_parser.add_argument('--date')
    prepare_parser.add_argument('--output-root', default=str(REPO / '.ci-output' / 'production'))
    prepare_parser.add_argument('--reuse-materials')
    prepare_parser.add_argument('--full-source', action='store_true')
    prepare_parser.add_argument('--since')
    freeze_parser = commands.add_parser('freeze')
    freeze_parser.add_argument('packet')
    freeze_parser.add_argument('--instance', default='andy-production')
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == 'prepare':
            prepare(arguments)
        else:
            started = time.monotonic()
            configuration = freeze(Path(arguments.packet).resolve(), load_instance(arguments.instance))
            print('PACKET_FROZEN ' + json.dumps({'packet': str(Path(arguments.packet).resolve()), 'oldConfigSha256': configuration, 'seconds': round(time.monotonic() - started, 1)}))
    except PacketError as error:
        print('PACKET_REFUSED ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
