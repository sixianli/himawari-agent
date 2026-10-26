import json
import sys
from pathlib import Path

target = Path(sys.argv[1]).resolve()
apply = sys.argv[2:] == ['--apply']
PAIRS = [
    ('run-eleventh-packet-s0.sh', 'run-twelfth-packet-s0.sh'),
    ('2026-10-26-eleventh', '2026-10-26-twelfth'),
    ('himawari-eleventh-read-20261026', 'himawari-twelfth-read-20261026'),
    ('eleventh-20261026', 'twelfth-20261026'),
    ('2026-10-26-tenth', '2026-10-26-eleventh'),
    ('himawari-tenth-read-20261026', 'himawari-eleventh-read-20261026'),
    ('tenth-20261026', 'eleventh-20261026'),
    ('eleventh', 'twelfth'),
    ('Eleventh', 'Twelfth'),
    ('ELEVENTH', 'TWELFTH'),
    ('tenth', 'eleventh'),
    ('Tenth', 'Eleventh'),
    ('TENTH', 'ELEVENTH'),
]


def convert(text):
    for index, (old, _) in enumerate(PAIRS):
        text = text.replace(old, f'\0R{index}\0')
    for index, (_, new) in enumerate(PAIRS):
        text = text.replace(f'\0R{index}\0', new)
    return text


files = [target] if target.is_file() else sorted(p for p in target.rglob('*') if p.is_file())
changed = []
for path in files:
    relative = path.relative_to(target) if target.is_dir() else Path(path.name)
    if relative.parts and relative.parts[0] in ('materials', 'run-logs'):
        continue
    try:
        text = path.read_bytes().decode('utf-8')
    except UnicodeDecodeError:
        continue
    after = convert(text)
    if after != text:
        changed.append(relative.as_posix())
        if apply:
            path.write_text(after, encoding='utf-8')
renamed = []
if target.is_dir():
    for path in sorted(target.rglob('*'), key=lambda p: -len(p.parts)):
        if 'materials' in path.relative_to(target).parts or not any(w in path.name for w in ('eleventh', 'tenth')):
            continue
        new = path.with_name(convert(path.name))
        renamed.append([str(path.relative_to(target)), str(new.relative_to(target))])
        if apply:
            path.rename(new)
print(json.dumps({'apply': apply, 'changedFiles': len(changed), 'renamed': renamed}, indent=1))
