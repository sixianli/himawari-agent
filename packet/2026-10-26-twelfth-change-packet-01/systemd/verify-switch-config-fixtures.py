import ast
import copy
import json
from pathlib import Path
import subprocess
import sys

packet = Path(__file__).resolve().parents[1]
source = (packet / 'systemd' / 'S7-switch-start-readback.py').read_text()
function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'static_root_configuration')
namespace = {'copy': copy}
exec(compile(ast.Module(body=[function], type_ignores=[]), 'S7-switch-start-readback.py', 'exec'), namespace)
static_root_configuration = namespace['static_root_configuration']

old_static_root = '/opt/himawari/releases/2026-10-26-eleventh/share/control-center'
new_static_root = '/opt/himawari/releases/2026-10-26-twelfth/share/control-center'


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
        'publicFetch': web_route('himawari.public-fetch', 102400),
    },
    'secretReferences': [{'ref': 'vercel-gateway', 'version': 'v1', 'purpose': 'model-gateway', 'scope': 'deployment:one'}],
    'modelDescriptors': [{'ref': 'deepseek-primary', 'role': 'primary', 'contextWindow': 1000000, 'maxTokens': 32768, 'cost': {'input': 0.45, 'output': 1.8}}, {'ref': 'qwen-embedding', 'role': 'embedding', 'dimensions': 4096}],
    'capabilityDeployment': {'snapshotPath': '/fixture/snapshot', 'sha256': 'sha256:' + '1' * 64},
}

failures = []
before = json.dumps(original, sort_keys=True)
accepted = static_root_configuration(copy.deepcopy(original))
wanted = copy.deepcopy(original)
wanted['http']['staticRoot'] = new_static_root
if accepted != wanted:
    failures.append('SWITCH_EXPECTED_CONFIG_NOT_ONLY_STATIC_ROOT')
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


rejects('original static root already new', 'TWELFTH_SWITCH_ORIGINAL_STATIC_ROOT_CHANGED', lambda value: value['http'].update(staticRoot=new_static_root))
rejects('original context window old', 'TWELFTH_SWITCH_ORIGINAL_MODEL_DESCRIPTOR_CHANGED', lambda value: value['modelDescriptors'][0].update(contextWindow=32768))
rejects('original output limit old', 'TWELFTH_SWITCH_ORIGINAL_MODEL_DESCRIPTOR_CHANGED', lambda value: value['modelDescriptors'][0].update(maxTokens=2048))
rejects('original model missing', 'TWELFTH_SWITCH_ORIGINAL_MODEL_DESCRIPTOR_CHANGED', lambda value: value['modelDescriptors'].pop(0))
rejects('original budgets present', 'TWELFTH_SWITCH_ORIGINAL_BUDGETS_PRESENT', lambda value: value.update(budgets={'global': {'limitUsd': 1}}))
rejects('original fetch limit old', 'TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED', lambda value: value['runPolicy']['publicFetch'].update(maximumBytes=32768))
rejects('original without fetch route', 'TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED', lambda value: value['runPolicy'].pop('publicFetch'))

if failures:
    for failure in failures:
        print('SWITCH_CONFIG_FIXTURE_FAILED ' + failure)
    sys.exit(1)
print('SWITCH_CONFIG_FIXTURES_PASSED cases=9')
