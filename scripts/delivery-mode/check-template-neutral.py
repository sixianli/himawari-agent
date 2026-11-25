import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / 'packet-template'
BUILDER = HERE / 'hermes'
REHEARSAL_ONLY = (
    'acceptance/cloud/',
    'acceptance/helpers/test-composition-source-copy.py',
    'acceptance/helpers/test-resource-retention.py',
    'acceptance/helpers/run-hermes-rehearsal.py',
)
BUILDER_FILES = ('build-candidate.sh', 'run-release-walkthrough.sh', 'capture-build-source-inputs.template.mjs')
RULES = (
    ('service account number', re.compile(r'(?<![\w.])(999|988)(?![\w.])')),
    ('service account number in setpriv', re.compile(r'--(?:reuid|regid)=\d')),
    ('node binary fingerprint', re.compile(r'e6ec2c188d83')),
    ('python archive fingerprint', re.compile(r'f50d08e0304b')),
    ('qualification directory of the first install', re.compile(r'qualification/first-\d{8}')),
    ('target host name', re.compile(r'vmi3618928')),
    ('target address', re.compile(r'84\.247\.157\.41')),
    ('builder host name', re.compile(r'hermes-home')),
    ('builder account home or data root', re.compile(r'/home/andy/|/data/hermes/')),
    ('cpu architecture', re.compile(r'x86_64|amd64|linux-x64|process\.arch === "(?:x64|arm64)"')),
    ('node abi number', re.compile(r'abi127')),
)


def violations(template=TEMPLATE, builder=BUILDER):
    found = []
    files = [(path, path.relative_to(template).as_posix()) for path in sorted(template.rglob('*')) if path.is_file()]
    files = [(path, relative) for path, relative in files if not relative.endswith('OWNED-SHA256SUMS') and not any(relative == entry or (entry.endswith('/') and relative.startswith(entry)) for entry in REHEARSAL_ONLY)]
    files += [(builder / name, 'hermes/' + name) for name in BUILDER_FILES if (builder / name).is_file()]
    for path, relative in files:
        for number, line in enumerate(path.read_text().splitlines(), 1):
            for name, pattern in RULES:
                if pattern.search(line):
                    found.append(relative + ':' + str(number) + ' ' + name)
    return found


def main():
    found = violations()
    for item in found:
        print('TEMPLATE_MACHINE_BOUND ' + item)
    if found:
        print('TEMPLATE_NOT_NEUTRAL ' + str(len(found)) + ' machine-bound values in the packet template or builder scripts; read them from the target machine at prepare time and fill them with a __PKT_ placeholder (scripts/delivery-mode/make-packet.py discovery_script)')
        return 1
    print('TEMPLATE_NEUTRAL')
    return 0


if __name__ == '__main__':
    sys.exit(main())
