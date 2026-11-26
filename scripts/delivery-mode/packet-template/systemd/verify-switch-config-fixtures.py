import ast
import copy
import json
from pathlib import Path
import subprocess
import sys

packet = Path(__file__).resolve().parents[1]
source = (packet / 'systemd' / 'S7-switch-start-readback.py').read_text()
function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'static_root_configuration')
namespace = {'copy': copy, 'json': json}
exec(compile(ast.Module(body=[function], type_ignores=[]), 'S7-switch-start-readback.py', 'exec'), namespace)
static_root_configuration = namespace['static_root_configuration']

old_static_root = '__PKT_OLD_PREFIX__/share/control-center'
new_static_root = '/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/share/control-center'


def web_route(capability_ref, maximum_bytes):
    return {'scopeSource': 'private_temp', 'hostId': 'host:one', 'workerInstanceId': 'worker:one', 'capabilityRef': capability_ref, 'capabilityVersion': '1.0.0', 'maximumBytes': maximum_bytes, 'providers': ['exa-public', 'deepseek'], 'providerSecrets': {'deepseek': 'deepseek-web'}}


original = {
    'ownerId': 'owner:one',
    'agentId': 'agent:one',
    'deploymentId': 'deployment:one',
    'stateRoot': '/fixture/state',
    'http': {'host': '127.0.0.1', 'port': 8787, 'staticRoot': old_static_root},
    'runPolicy': {
        'maxWallTimeMs': 1500,
        'systemInstruction': '只在授权目录内工作。',
        'coding': {'hostId': 'host:one', 'workerInstanceId': 'worker:one', 'grantId': 'directory:himawari-prod-workspace-20261015', 'capabilityRef': 'himawari.pi-coding', 'capabilityVersion': '1.0.0', 'maximumBytes': 49152, 'enabledTools': ['read', 'write', 'edit', 'bash', 'find', 'grep', 'ls'], 'approval': 'workspace_auto'},
        'publicSearch': web_route('himawari.public-search', 4096),
        'publicFetch': web_route('himawari.public-fetch', __PKT_ORIGINAL_PUBLIC_FETCH_BYTES__),
    },
    'secretReferences': [{'ref': 'vercel-gateway', 'version': 'v1', 'purpose': 'model-gateway', 'scope': 'deployment:one'}],
    'modelDescriptors': [{'ref': '__PKT_MODEL_REF__', 'role': 'primary', 'contextWindow': __PKT_ORIGINAL_CONTEXT_WINDOW__, 'maxTokens': __PKT_ORIGINAL_MAX_TOKENS__, 'cost': {'input': 0.45, 'output': 1.8}}, {'ref': 'qwen-embedding', 'role': 'embedding', 'dimensions': 4096}],
    'memory': {'dimensions': 4096, 'minimumSimilarity': 0.6},
    'capabilityDeployment': {'snapshotPath': '/fixture/snapshot', 'sha256': 'sha256:' + '1' * 64},
}

failures = []
before = json.dumps(original, sort_keys=True)
accepted = static_root_configuration(copy.deepcopy(original))
wanted = copy.deepcopy(original)
wanted['http']['staticRoot'] = new_static_root
wanted['modelDescriptors'][0].update(contextWindow=__PKT_TARGET_CONTEXT_WINDOW__, maxTokens=__PKT_TARGET_MAX_TOKENS__)
wanted['runPolicy']['publicFetch']['maximumBytes'] = __PKT_TARGET_PUBLIC_FETCH_BYTES__
approved_embedding = json.loads('__PKT_TARGET_EMBEDDING_JSON__')
if approved_embedding is not None:
    wanted['modelDescriptors'][1] = approved_embedding
    wanted['memory'] = {'dimensions': approved_embedding['dimensions']}
approved_speech = json.loads('__PKT_TARGET_SPEECH_JSON__')
if approved_speech is not None:
    wanted['speech'] = approved_speech
if accepted != wanted:
    failures.append('SWITCH_EXPECTED_CONFIG_NOT_ONLY_APPROVED_FIELDS')
if json.dumps(original, sort_keys=True) != before:
    failures.append('SWITCH_EXPECTED_CONFIG_MUTATED_ORIGINAL')

common = (packet / 'maintenance' / 'maintenance-common.mjs').resolve().as_uri()
script = 'import { staticRootConfigurationBytes } from ' + json.dumps(common) + '; process.stdout.write(staticRootConfigurationBytes(JSON.parse(process.argv[1])));'
maintenance = subprocess.run([sys.argv[1], '--input-type=module', '-e', script, json.dumps(original, ensure_ascii=False)], capture_output=True, check=False)
if maintenance.returncode != 0:
    failures.append('SWITCH_MAINTENANCE_EXPECTATION_FAILED:' + maintenance.stderr.decode(errors='replace')[-400:])
elif maintenance.stdout != (json.dumps(accepted, indent=2, ensure_ascii=False) + '\n').encode():
    failures.append('SWITCH_AND_MAINTENANCE_EXPECTED_CONFIG_DIFFER')


def rejects(name, code, change):
    value = copy.deepcopy(original)
    change(value)
    try:
        static_root_configuration(value)
    except RuntimeError as error:
        if str(error) != code:
            failures.append(name + ':' + str(error))
        return
    failures.append(name + ':ACCEPTED')


rejects('original static root already new', '__PKT_LABEL_UPPER___SWITCH_ORIGINAL_STATIC_ROOT_CHANGED', lambda value: value['http'].update(staticRoot=new_static_root))
rejects('original context window old', '__PKT_LABEL_UPPER___SWITCH_ORIGINAL_MODEL_DESCRIPTOR_CHANGED', lambda value: value['modelDescriptors'][0].update(contextWindow=__PKT_ORIGINAL_CONTEXT_WINDOW__ - 1))
rejects('original output limit old', '__PKT_LABEL_UPPER___SWITCH_ORIGINAL_MODEL_DESCRIPTOR_CHANGED', lambda value: value['modelDescriptors'][0].update(maxTokens=__PKT_ORIGINAL_MAX_TOKENS__ - 1))
rejects('original model missing', '__PKT_LABEL_UPPER___SWITCH_ORIGINAL_MODEL_DESCRIPTOR_CHANGED', lambda value: value['modelDescriptors'].pop(0))
rejects('original budgets present', '__PKT_LABEL_UPPER___SWITCH_ORIGINAL_BUDGETS_PRESENT', lambda value: value.update(budgets={'global': {'limitUsd': 1}}))
rejects('original fetch limit old', '__PKT_LABEL_UPPER___SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED', lambda value: value['runPolicy']['publicFetch'].update(maximumBytes=__PKT_ORIGINAL_PUBLIC_FETCH_BYTES__ - 1))
rejects('original without fetch route', '__PKT_LABEL_UPPER___SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED', lambda value: value['runPolicy'].pop('publicFetch'))
if approved_embedding is not None:
    rejects('original embedding missing', '__PKT_LABEL_UPPER___SWITCH_ORIGINAL_EMBEDDING_DESCRIPTOR_CHANGED', lambda value: value['modelDescriptors'].pop(1))
    rejects('original memory missing', '__PKT_LABEL_UPPER___SWITCH_ORIGINAL_EMBEDDING_DESCRIPTOR_CHANGED', lambda value: value.pop('memory'))

if failures:
    for failure in failures:
        print('SWITCH_CONFIG_FIXTURE_FAILED ' + failure)
    sys.exit(1)
print('SWITCH_CONFIG_FIXTURES_PASSED cases=' + str(9 if approved_embedding is None else 11))
