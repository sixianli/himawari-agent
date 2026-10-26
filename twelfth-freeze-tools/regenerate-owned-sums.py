import hashlib
import re
import sys
from pathlib import Path

if len(sys.argv) not in (2, 3) or sys.argv[2:] not in ([], ['--apply']):
    raise SystemExit('usage: regenerate-owned-sums.py <packet> [--apply]')
packet = Path(sys.argv[1]).resolve()
apply = sys.argv[2:] == ['--apply']
roots = {
    'measurement/OWNED-SHA256SUMS': packet / 'measurement',
    'systemd/OWNED-SHA256SUMS': packet / 'systemd',
    'acceptance/OWNED-SHA256SUMS': packet / 'acceptance',
    'maintenance/OWNED-SHA256SUMS': packet,
}
for name, root in roots.items():
    lines = []
    changed = 0
    for line in (packet / name).read_text().splitlines():
        recorded, member = line.split('  ', 1)
        path = root / member
        if not path.is_file():
            raise SystemExit(f'OWNED_MEMBER_MISSING {name} {member}')
        if re.search(r"'PENDING:(s0|candidate|user)\.", path.read_text(errors='ignore')):
            raise SystemExit(f'OWNED_MEMBER_STILL_PENDING {name} {member}')
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        changed += actual != recorded
        lines.append(f'{actual}  {member}')
    print(f'{name}: {changed} of {len(lines)} entries updated')
    if apply:
        (packet / name).write_text('\n'.join(lines) + '\n')
