import json
from pathlib import Path
import re
import shlex
import subprocess
import sys

SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']
MINIMUM_FREE_FACTOR = 2
ACCEPTANCE_ROOT_FREE_BYTES = 10 * 1024 ** 3
ROOT_RESERVE_BYTES = 1024 ** 3
UNMEASURED_INSTALL_FACTOR = 3
MEASURED_INSTALL_HEADROOM = 1.2
LAST_INSTALL_USED = "import json, pathlib, re, sys; m = re.search(r'--no-global-search-paths \\S+/([a-z]+-[0-9]{8})/pair-supervisor[.]mjs', pathlib.Path(sys.argv[1]).read_text()); r = json.loads((pathlib.Path(sys.argv[2]) / (m.group(1) + '-evidence') / 's1-result.json').read_text()) if m else {}; print(r['rootFreeBeforeBytes'] - r['rootFreeAfterBytes'] if r.get('passed') else '')"
DOCUMENT_TOOLS_CHECK = 'if /usr/bin/python3 -I -c "import docx, openpyxl, pypdf, pdfminer, weasyprint, markdown" >/dev/null 2>&1 && /usr/bin/pandoc --version >/dev/null 2>&1 && /usr/bin/fc-list :lang=zh family 2>/dev/null | /usr/bin/grep -q "Noto Sans CJK" && /usr/bin/fc-list :lang=zh family 2>/dev/null | /usr/bin/grep -q "LXGW WenKai" && /usr/lib/himawari-document-python/bin/python -I -c "import weasyprint, pypdf; from weasyprint.text.ffi import harfbuzz_subset; assert weasyprint.__version__.split(chr(46))[0] == str(70) and harfbuzz_subset" >/dev/null 2>&1; then echo documentTools=ok; else echo documentTools=missing; fi'
PROBE_UNIT_LINE = re.compile(r"^unit = '([A-Za-z0-9@._-]+\.service)'$", re.MULTILINE)


def packet_bytes(packet):
    return sum(path.stat().st_size for path in packet.rglob('*') if path.is_file() and 'run-logs' not in path.parts)


def probe_units(packet, binding):
    units = set()
    for script in sorted((packet / 'measurement').glob('*.py')):
        units.update(PROBE_UNIT_LINE.findall(script.read_text()))
    units.discard(binding['service']['unit'])
    return sorted(units)


def target_paths(binding):
    paths = binding['paths']
    return sorted({paths[key] for key in ('newPrefix', 'newOperations', 'evidenceRoot') if key in paths} | ({str(Path(paths['transportRoot']).parent)} if 'transportRoot' in paths else set()))


def remote_script(binding, units=(), paths=()):
    state_parent = str(Path(binding['paths']['stateRoot']).parent)
    mirror = str(Path(binding['paths']['stateRoot']) / 'authority.json')
    return '; '.join([
        'set -u',
        'echo "hostname=$(/usr/bin/hostname)"',
        'echo "active=$(/usr/bin/systemctl is-active ' + shlex.quote(binding['service']['unit']) + ')"',
        'echo "optFree=$(/usr/bin/df --output=avail -B1 /opt | /usr/bin/tail -n 1 | /usr/bin/tr -d \' \')"',
        'echo "stateFree=$(/usr/bin/df --output=avail -B1 ' + shlex.quote(state_parent) + ' | /usr/bin/tail -n 1 | /usr/bin/tr -d \' \')"',
        'echo "uid=$(/usr/bin/id -u)"',
        'echo "configSha256=$(/usr/bin/sha256sum ' + shlex.quote(binding['paths']['config']) + ' | /usr/bin/cut -d \' \' -f 1)"',
        'echo "unitSha256=$(/usr/bin/sha256sum ' + shlex.quote(binding['service']['unitFragmentPath']) + ' | /usr/bin/cut -d \' \' -f 1)"',
        'echo "authority=$(/usr/bin/python3 -I -c \'import json, sys; mirror = json.load(open(sys.argv[1])); print(mirror["authorityEpoch"], mirror["fencingToken"])\' ' + shlex.quote(mirror) + ')"',
        'echo "rootFree=$(/usr/bin/df --output=avail -B1 / | /usr/bin/tail -n 1 | /usr/bin/tr -d \' \')"',
        'echo "lastInstallUsed=$(/usr/bin/python3 -I -c ' + shlex.quote(LAST_INSTALL_USED) + ' ' + shlex.quote(binding['service']['unitFragmentPath']) + ' ' + shlex.quote(str(Path(binding['paths']['evidenceRoot']).parent) if 'evidenceRoot' in binding['paths'] else '/var/lib/himawari') + ' 2>/dev/null)"',
        DOCUMENT_TOOLS_CHECK,
        *['echo ' + shlex.quote('probeUnit.' + unit) + '="$(/usr/bin/systemctl show -p LoadState --value ' + shlex.quote(unit) + ')"' for unit in units],
        *['if [ -e ' + shlex.quote(path) + ' ] || [ -L ' + shlex.quote(path) + ' ]; then echo ' + shlex.quote('targetPath.' + path + '=present') + '; else echo ' + shlex.quote('targetPath.' + path + '=absent') + '; fi' for path in paths],
    ])


FROZEN_STATE_CHECKS = ('CONFIG_UNCHANGED_SINCE_FREEZE', 'UNIT_UNCHANGED_SINCE_FREEZE', 'AUTHORITY_UNCHANGED_SINCE_FREEZE')


def predicted_install_bytes(facts, size):
    measured = int(facts.get('lastInstallUsed') or 0)
    return size + int(measured * MEASURED_INSTALL_HEADROOM) if measured > 0 else size * UNMEASURED_INSTALL_FACTOR


def space(facts, size):
    install = predicted_install_bytes(facts, size)
    free = int(facts.get('rootFree') or 0)
    return {'rootFree': free, 'predictedInstall': install, 'predictedFreeAfterInstall': free - install, 'needAfterInstall': ACCEPTANCE_ROOT_FREE_BYTES + ROOT_RESERVE_BYTES, 'measuredFromLastInstall': int(facts.get('lastInstallUsed') or 0) > 0}


def checks(binding, facts, size, units=(), paths=()):
    needed = size * MINIMUM_FREE_FACTOR
    room = space(facts, size)
    authority = str(binding['authority']['authorityEpoch']) + ' ' + str(binding['authority']['fencingToken'])
    return [
        ('ROOT_LOGIN', facts.get('uid') == '0'),
        ('HOSTNAME', facts.get('hostname') == binding['host']['hostname']),
        ('SERVICE_ACTIVE', facts.get('active') == 'active'),
        ('OPT_FREE', int(facts.get('optFree') or 0) >= needed),
        ('STATE_FREE', int(facts.get('stateFree') or 0) >= needed),
        ('CONFIG_UNCHANGED_SINCE_FREEZE', facts.get('configSha256') == binding['service']['oldConfigSha256']),
        ('UNIT_UNCHANGED_SINCE_FREEZE', facts.get('unitSha256') == binding['service']['oldUnitSha256']),
        ('AUTHORITY_UNCHANGED_SINCE_FREEZE', facts.get('authority') == authority),
        ('ROOT_FREE_FOR_ACCEPTANCE', room['predictedFreeAfterInstall'] >= room['needAfterInstall']),
        ('DOCUMENT_TOOLS_INSTALLED', facts.get('documentTools') == 'ok'),
        *[('PROBE_UNIT_UNUSED ' + unit, facts.get('probeUnit.' + unit) == 'not-found') for unit in units],
        *[('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent') for path in paths],
    ]


def main():
    packet = Path(sys.argv[1]).resolve()
    binding = json.loads((packet / 'inputs' / 'bindings.json').read_text())
    units, paths = probe_units(packet, binding), target_paths(binding)
    child = subprocess.run(['ssh', *SSH_OPTIONS, 'root@' + binding['host']['address'], remote_script(binding, units, paths)], capture_output=True, text=True, timeout=60, check=False)
    if child.returncode != 0:
        print('PREFLIGHT_CHECK SSH failed exit=' + str(child.returncode) + ' ' + child.stderr.strip())
        return 1
    facts = dict(line.split('=', 1) for line in child.stdout.splitlines() if '=' in line)
    failed = False
    results = checks(binding, facts, packet_bytes(packet), units, paths)
    for name, passed in results:
        print('PREFLIGHT_CHECK ' + name + ' ' + ('passed' if passed else 'failed'))
        failed = failed or not passed
    print('PREFLIGHT_FACTS ' + json.dumps(facts))
    print('PREFLIGHT_SPACE ' + json.dumps(space(facts, packet_bytes(packet))))
    for name, passed in results:
        if not passed and name.startswith('PROBE_UNIT_UNUSED '):
            print('PREFLIGHT_LEFTOVER_UNIT a failed earlier attempt left this transient unit loaded; after saving its status and journal run: systemctl reset-failed ' + name.split(' ', 1)[1])
        if not passed and name.startswith('TARGET_PATH_ABSENT '):
            print('PREFLIGHT_LEFTOVER_PATH an earlier attempt left this path and the cleanup before the preflight could not remove it; see what is left with: python3 ' + str(Path(__file__).resolve().parent / 'release-cleanup.py') + ' ' + str(packet) + ' plan: ' + name.split(' ', 1)[1])
    if any(name == 'DOCUMENT_TOOLS_INSTALLED' and not passed for name, passed in results):
        print('PREFLIGHT_DOCUMENT_TOOLS the model sandbox needs these system packages; with the owner\'s approval run as root: apt-get update && apt-get install --no-install-recommends python3-docx python3-openpyxl python3-pypdf python3-pdfminer weasyprint fonts-noto-cjk pandoc python3-markdown libharfbuzz-subset0 fonts-lxgw-wenkai python3-venv, then install the pinned WeasyPrint 70 into /usr/lib/himawari-document-python as ADR 0118 describes')
    if any(name == 'ROOT_FREE_FOR_ACCEPTANCE' and not passed for name, passed in results):
        print('PREFLIGHT_ROOT_SPACE after installing this release the root disk would have less than the 10 GiB production acceptance needs plus 1 GiB reserve; see what the cleanup would remove with: python3 ' + str(Path(__file__).resolve().parent / 'release-cleanup.py') + ' ' + str(packet) + ' plan')
    if any(name in FROZEN_STATE_CHECKS and not passed for name, passed in results):
        print('PREFLIGHT_REFREEZE the production service restarted or changed after this packet was frozen; run: python3 ' + str(Path(__file__).resolve().parent / 'make-packet.py') + ' freeze ' + str(packet))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
