import json
from pathlib import Path
import re
import sys

PLACEHOLDER = "OLD_CONFIG_SHA = 'PENDING:s0.service.configurationSha256'\n"
HOLDERS = ['systemd/S2-stop-and-inspect.py', 'maintenance/S9-control-files.py']

if len(sys.argv) not in [2, 3] or (len(sys.argv) == 3 and sys.argv[2] != '--apply'):
    raise SystemExit('usage: fill-old-config.py <packet> [--apply]')
packet = Path(sys.argv[1]).resolve()
apply = len(sys.argv) == 3
s0 = json.loads((packet / 'inputs/s0-db-readback.json').read_text())
value = s0['service']['configurationSha256']
if not isinstance(value, str) or re.fullmatch('[a-f0-9]{64}', value) is None:
    raise SystemExit('S0_CONFIGURATION_DIGEST_INVALID')
updates = []
for name in HOLDERS:
    filename = packet / name
    text = filename.read_text()
    if text.count(PLACEHOLDER) != 1:
        raise SystemExit('OLD_CONFIG_PLACEHOLDER_MISSING:' + name)
    updates.append((filename, text.replace(PLACEHOLDER, "OLD_CONFIG_SHA = '" + value + "'\n")))
if apply:
    for filename, text in updates:
        filename.write_text(text)
        if filename.read_text() != text:
            raise SystemExit('OLD_CONFIG_READBACK_FAILED:' + str(filename))
print(json.dumps({'applied': apply, 'configurationSha256': value, 'files': HOLDERS}))
