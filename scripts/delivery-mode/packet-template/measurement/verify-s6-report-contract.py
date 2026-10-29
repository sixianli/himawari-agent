import ast
from pathlib import Path
import sys

sys.dont_write_bytecode = True
packet = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
PRODUCER = 'measurement/S6-service-read.py'
READERS = {'systemd/S7-switch-start-readback.py': 'probe', 'install/S9-clean-transport.py': 'service_read'}
CONDITIONAL = (ast.If, ast.IfExp, ast.For, ast.While, ast.ExceptHandler, ast.BoolOp, ast.comprehension)


def parse(relative):
    tree = ast.parse((packet / relative).read_text(), relative)
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            child.parent = node
    return tree


def constant_key(node):
    return node.slice.value if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str) else None


def conditional(node):
    while hasattr(node, 'parent'):
        node = node.parent
        if isinstance(node, CONDITIONAL):
            return True
    return False


def always_written(tree):
    keys = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'record' for target in node.targets) and isinstance(node.value, ast.Dict) and not conditional(node):
            keys |= {key.value for key in node.value.keys if isinstance(key, ast.Constant)}
        if isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Store) and isinstance(node.value, ast.Name) and node.value.id == 'record' and constant_key(node) and not conditional(node):
            keys.add(constant_key(node))
    return keys


def read_keys(tree, name):
    return {constant_key(node) for node in ast.walk(tree) if isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load) and isinstance(node.value, ast.Name) and node.value.id == name and constant_key(node)}


written = always_written(parse(PRODUCER))
problems = []
for reader, name in READERS.items():
    for key in sorted(read_keys(parse(reader), name) - written):
        problems.append('S6_REPORT_FIELD_NOT_ALWAYS_WRITTEN ' + reader + ' reads ' + name + "['" + key + "'] but " + PRODUCER + ' writes it only on some paths')
for problem in problems:
    print(problem)
print('S6_REPORT_CONTRACT ' + ('failed' if problems else 'passed') + ' fields=' + str(len(written)))
sys.exit(1 if problems else 0)
