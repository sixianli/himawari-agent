import ast
import hashlib
import json
from pathlib import Path
import sys


root = Path(sys.argv[1])
expected_root = Path('/data/hermes/himawari/tool-audit-round2/r30/evidence/r64/host-acceptance-preparation-04')
assert root == expected_root and root.resolve() == root
stage = 'host-network-preparation-01'
base = Path('/data/hermes/himawari/tool-audit-round2/r30')
source = Path('/home/andy/himawari-tests/round2/source')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def top_value(tree, name):
    values = [node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
    assert len(values) == 1, name
    return values[0]


def resolve(node, names):
    if isinstance(node, ast.Constant):
        assert isinstance(node.value, str)
        return node.value
    if isinstance(node, ast.Name):
        return names[node.id]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'Path':
        assert len(node.args) == 1 and not node.keywords
        return Path(resolve(node.args[0], names))
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        return resolve(node.left, names) / resolve(node.right, names)
    if isinstance(node, ast.JoinedStr):
        parts = []
        for part in node.values:
            if isinstance(part, ast.Constant):
                parts.append(part.value)
            else:
                assert isinstance(part, ast.FormattedValue) and part.conversion == -1 and part.format_spec is None
                parts.append(str(resolve(part.value, names)))
        return ''.join(parts)
    raise ValueError(ast.dump(node))


outer_path = root / 'run-stage-03.py'
network_path = root / 'run-network-preparation.py'
outer = ast.parse(outer_path.read_text(), filename=str(outer_path))
network = ast.parse(network_path.read_text(), filename=str(network_path))
names = {'base': base, 'source': source, 'evidence': root, 'stage': stage}
for tree in [outer, network]:
    assert resolve(top_value(tree, 'base'), {}) == base
    assert resolve(top_value(tree, 'source'), {}) == source
    assert resolve(top_value(tree, 'evidence'), names) == root
    evidence_writes = [node for node in ast.walk(tree) if isinstance(node, ast.Name) and node.id == 'evidence' and isinstance(node.ctx, ast.Store)]
    assert len(evidence_writes) == 1

commands = json.loads((root / 'commands-03.json').read_text())
assert list(commands) == [stage]
argv = commands[stage]
assert argv == [str(base / 'tools/python/python/bin/python3'), str(network_path), '--approved-question-12', '{scratch}']
helpers = ast.literal_eval(top_value(outer, 'helpers'))
matching_branches = [node for node in outer.body if isinstance(node, ast.If) and ast.dump(node.test) == ast.dump(ast.parse("stage == 'host-network-preparation-01'", mode='eval').body)]
assert len(matching_branches) == 1
call = matching_branches[0].body[0].value
assert isinstance(call.func, ast.Attribute) and call.func.value.id == 'helpers' and call.func.attr == 'extend'
helpers.extend(ast.literal_eval(call.args[0]))
assert len(helpers) == 13
outer_helpers = []
for name in helpers:
    path = root / name
    assert path.is_file() and path.resolve() == path
    outer_helpers.append({'path': str(path), 'sha256': digest(path)})

inputs = json.loads((root / 'question-12-inputs.json').read_text())
input_readback = []
for name, sha in inputs['files'].items():
    assert Path(name).name == name
    path = root / name
    assert path.is_file() and path.resolve() == path and digest(path) == sha
    input_readback.append({'path': str(path), 'sha256': sha})
assert inputs['candidate'] == json.loads((root / 'candidate-inputs.json').read_text())
manifest = json.loads((root / 'adaptation-manifest.json').read_text())
assert manifest['adapters'][0]['unchangedBeyondGuardAndImport'] is False
assert manifest['adapters'][0]['adapterSha256'] == digest(root / 'probe-foreground.mjs')
for name in ['probe-foreground.mjs', 'probe-authorized-network.mjs']:
    assert (root / name).read_text().splitlines()[0] == 'import { validateScratchRoot } from "./scratch-root.mjs";'

report = resolve(top_value(outer, 'report'), names)
assert report == source / '.ci-output/r64/host-acceptance-preparation-04' / (stage + '-vitest.json')
assert not report.parent.exists()
data_outputs = [resolve(top_value(outer, name), names) for name in ['run_path', 'retained_report']]
data_outputs.append(root / (stage + '-helper-inputs'))
for suffix in ['console.log', 'resources.jsonl', 'fp.json', 'workspace.patch', 'installation.log', 'proc-console.log', 'proc.jsonl', 'proc.stop', 'scratch.tar.gz', 'd3-readbacks', 's4-readbacks', 'mem0-readbacks', 'http-readbacks']:
    data_outputs.append(root / (stage + '-' + suffix))
for suffix in ['stdout', 'stderr']:
    for name in ['network-preparation-guard', 'network-preparation-fd-version', 'network-preparation-install', 'network-preparation-tool-bash', 'network-preparation-tool-rg', 'network-preparation-tool-fd', 'network-preparation-runtime-before', 'network-preparation-pi', 'network-preparation-network', 'network-preparation-runtime-after']:
        data_outputs.append(root / (name + '.' + suffix))
data_outputs.extend([root / 'question-12-downloads', root / 'network-preparation-report.json'])
assert all(path.is_relative_to(root) and not path.exists() and not path.is_symlink() for path in data_outputs)
assert not (root / '__pycache__').exists()
namespace_expressions = {}
for name, tree in [('run-stage-03.py', outer), ('run-network-preparation.py', network)]:
    namespace_expressions[name] = [{'line': node.lineno, 'expression': ast.unparse(node)} for node in ast.walk(tree) if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div) and isinstance(node.left, ast.Name) and node.left.id == 'evidence']
    old_namespace = 'evidence/r64/host-acceptance-preparation-01'
    assert old_namespace not in (root / name).read_text()
    assert '.ci-output/r64/host-acceptance-preparation-01' not in (root / name).read_text()

print(json.dumps({'passed': True, 'method': 'AST and JSON readback only; no import, eval, exec or execution of either entry', 'outerAcceptanceEntryExecuted': False, 'stage': stage, 'outerScript': str(outer_path), 'outerScriptSha256': digest(outer_path), 'resolvedEvidenceDirectory': str(root), 'commandsFile': str(root / 'commands-03.json'), 'resolvedInnerArgv': argv, 'outerHelperInputs': outer_helpers, 'question12Inputs': input_readback, 'manifestPath': str(root / 'adaptation-manifest.json'), 'manifestScope': manifest['scope'], 'relativeScratchImports': [str(root / 'scratch-root.mjs')], 'dataOutputPaths': list(map(str, data_outputs)), 'rootWorkingOutputDirectory': str(report.parent), 'rootWorkingReport': str(report), 'futureOutputPathsAbsent': True, 'oldEvidenceDirectoryReferenced': False, 'oldWorkingReportDirectoryReferenced': False, 'evidenceDirectoryAssignmentCount': {'outer': 1, 'inner': 1}, 'namespaceExpressions': namespace_expressions, 'fixedInputsOutsideNewDirectory': {'toolchainPython': argv[0], 'toolchainNode': str(base / 'tools/bin/node'), 'processSamplerLongtask': str(base / 'tools/longtask.py'), 'sourceCheckout': str(source), 'installer': str(source / 'scripts/install-node-runtime.mjs'), 'candidate': inputs['candidate'], 'scratchTemplate': '/tmp/hXXXX'}, 'syntaxOnlyPythonParsed': [str(outer_path), str(network_path)]}, indent=2))
