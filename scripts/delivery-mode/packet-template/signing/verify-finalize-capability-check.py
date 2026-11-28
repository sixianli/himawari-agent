import copy
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
packet = Path(__file__).resolve().parents[1]
source_path = Path(sys.argv[1]) if len(sys.argv) == 2 else packet / 'signing/workspace-grant-binding.py'
if len(sys.argv) > 2:
    raise SystemExit('usage: verify-finalize-capability-check.py [workspace-grant-binding.py]')

specification = importlib.util.spec_from_file_location('workspace_grant_binding', source_path)
binding = importlib.util.module_from_spec(specification)
specification.loader.exec_module(binding)
if 'grant_validator.check_production_authorization(' not in (packet / 'signing/finalize-binding-inputs.py').read_text():
    raise SystemExit('FINALIZE_CAPABILITY_CHECK_NOT_SHARED')

s0 = json.loads((packet / 'inputs/s0-db-readback.json').read_text())
draft = json.loads((packet / 'inputs/bindings.draft.json').read_text())
frozen = {'paths': {'oldPrefix': draft['paths']['oldPrefix']}}
host_id = s0['identity']['hostId']
production = s0['authorization']['capabilities']
production_refs = sorted(entry['capabilityRef'] for entry in production)
if production_refs not in ([], ['himawari.pi-coding', 'himawari.public-fetch', 'himawari.public-search']):
    raise SystemExit('FINALIZE_CAPABILITY_FIXTURE_PRODUCTION_SET_CHANGED ' + json.dumps(production_refs))

def check(capabilities):
    problems = binding.capability_problems(capabilities, host_id, frozen['paths']['oldPrefix'])
    return problems[0] if problems else None

results = []
def expect(name, capabilities, accepted, prefix=None):
    outcome = check(capabilities)
    ok = outcome is None if accepted else outcome is not None and (prefix is None or outcome.startswith(prefix))
    results.append({'case': name, 'ok': ok, 'outcome': outcome})

expect('production-s0-accepted', copy.deepcopy(production), True)
for entry_index, entry in enumerate(production):
    for field in ['integrityMatchesSnapshot', 'declarationInvariantMatchesSnapshot', 'runnerMatchesRecorded']:
        changed = copy.deepcopy(production)
        changed[entry_index][field] = False
        expect(entry['capabilityRef'] + ':' + field + '-false', changed, False, 'OLD_APPROVED_CAPABILITY_CHANGED:' + entry['capabilityRef'])
        empty = copy.deepcopy(production)
        empty[entry_index][field] = None
        expect(entry['capabilityRef'] + ':' + field + '-none', empty, False, 'OLD_APPROVED_CAPABILITY_CHANGED:' + entry['capabilityRef'])
        missing = copy.deepcopy(production)
        del missing[entry_index][field]
        expect(entry['capabilityRef'] + ':' + field + '-missing', missing, False, 'OLD_APPROVED_CAPABILITY_CHANGED:' + entry['capabilityRef'])
    other_runner = copy.deepcopy(production)
    other_runner[entry_index]['actualRunnerSha256'] = '0' * 64
    expect(entry['capabilityRef'] + ':actual-runner-differs', other_runner, False, 'OLD_APPROVED_CAPABILITY_CHANGED:' + entry['capabilityRef'])
    other_root = copy.deepcopy(production)
    other_root[entry_index]['runtimeRoot'] = '/opt/himawari/releases/other/lib/himawari-agent'
    expect(entry['capabilityRef'] + ':runtime-root-differs', other_root, False, 'OLD_APPROVED_RUNTIME_IDENTITY_CHANGED')

failed = [result for result in results if not result['ok']]
print(json.dumps({'passed': not failed, 'source': str(source_path), 'cases': len(results), 'failed': failed}, ensure_ascii=False, indent=2))
sys.exit(1 if failed else 0)
