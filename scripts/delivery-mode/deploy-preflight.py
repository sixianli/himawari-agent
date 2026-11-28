import importlib.util
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys


def load_target_paths():
    spec = importlib.util.spec_from_file_location('deploy_target_paths', Path(__file__).resolve().parent / 'deploy-target-paths.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


target_paths = load_target_paths().target_paths
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']
MINIMUM_FREE_FACTOR = 2
ACCEPTANCE_ROOT_FREE_BYTES = 10 * 1024 ** 3
ROOT_RESERVE_BYTES = 1024 ** 3
UNMEASURED_INSTALL_FACTOR = 3
MEASURED_INSTALL_HEADROOM = 1.2
LAST_INSTALL_USED = "import json, pathlib, re, sys; m = re.search(r'--no-global-search-paths \\S+/([a-z]+-[0-9]{8})/pair-supervisor[.]mjs', pathlib.Path(sys.argv[1]).read_text()); r = json.loads((pathlib.Path(sys.argv[2]) / (m.group(1) + '-evidence') / 's1-result.json').read_text()) if m else {}; print(r['rootFreeBeforeBytes'] - r['rootFreeAfterBytes'] if r.get('passed') else '')"
RUNNING_KERNEL = 'echo "runningKernel=$(/usr/bin/uname -r)"'
GRUB_CONFIG = '/boot/grub/grub.cfg'
GRUB_ENVIRONMENT = '/boot/grub/grubenv'
BOOT_DIRECTORY = '/boot'
READ_NEXT_BOOT_KERNEL = (
    'import pathlib, re, shlex, sys\n'
    'def menu(text):\n'
    '    root = []\n'
    '    stack = [("menu", root)]\n'
    '    for raw in text.splitlines():\n'
    '        line = raw.strip()\n'
    '        if line.startswith(("menuentry ", "submenu ")) and line.endswith("{"):\n'
    '            words = shlex.split(line[:-1])\n'
    '            marks = [index for index, word in enumerate(words[:-1]) if word in ("$menuentry_id_option", "--id")]\n'
    '            node = {"title": words[1], "id": words[marks[0] + 1] if marks else "", "children": [] if words[0] == "submenu" else None, "kernel": ""}\n'
    '            if stack[-1][0] == "menu":\n'
    '                stack[-1][1].append(node)\n'
    '            stack.append(("menu", node["children"]) if node["children"] is not None else ("entry", node))\n'
    '        elif line.endswith("{"):\n'
    '            stack.append(("other", None))\n'
    '        elif line == "}" and len(stack) > 1:\n'
    '            stack.pop()\n'
    '        elif stack[-1][0] == "entry":\n'
    '            found = re.match(r"linux(?:efi)?\\s+\\S*/vmlinuz-(\\S+)", line)\n'
    '            if found:\n'
    '                stack[-1][1]["kernel"] = found.group(1)\n'
    '    return root\n'
    'def resolve(entries, target):\n'
    '    node = None\n'
    '    for part in target.split(">"):\n'
    '        if node is not None:\n'
    '            if node["children"] is None:\n'
    '                return ""\n'
    '            entries = node["children"]\n'
    '        node = (entries[int(part)] if int(part) < len(entries) else None) if part.isdigit() else next((entry for entry in entries if part in (entry["id"], entry["title"])), None)\n'
    '        if node is None:\n'
    '            return ""\n'
    '    return node["kernel"]\n'
    'def installed(kernel):\n'
    '    return kernel if kernel and (pathlib.Path(sys.argv[3]) / ("vmlinuz-" + kernel)).is_file() else ""\n'
    'try:\n'
    '    config = pathlib.Path(sys.argv[1]).read_text()\n'
    '    environment = dict(line.split("=", 1) for line in pathlib.Path(sys.argv[2]).read_text(errors="replace").splitlines() if "=" in line and not line.startswith("#"))\n'
    '    lines = [" ".join(line.split()) for line in config.splitlines()]\n'
    '    defaults = [line for line in lines if line.startswith("set default=")]\n'
    '    standard = defaults == [\'set default="${next_entry}"\', \'set default="${saved_entry}"\'] and \'if [ "${next_entry}" ] ; then\' in lines and lines.index(\'if [ "${next_entry}" ] ; then\') + 1 == lines.index(defaults[0]) and lines[lines.index(defaults[1]) - 1] == "else"\n'
    '    entries = menu(config) if standard else []\n'
    '    saved = installed(resolve(entries, environment["saved_entry"])) if environment.get("saved_entry") else ""\n'
    '    once = environment.get("next_entry", "")\n'
    '    following = installed(resolve(entries, once)) if once else saved\n'
    '    print("nextBootKernel=" + (following if saved else ""))\n'
    '    print("savedBootKernel=" + saved)\n'
    'except Exception:\n'
    '    print("nextBootKernel=")\n'
    '    print("savedBootKernel=")\n'
)
READ_QUALIFIED_KERNEL = (
    'import json, pathlib, re, sys\n'
    'try:\n'
    '    receipts = sorted(pathlib.Path(sys.argv[1]).glob("*/installation-receipt.json"), key=lambda path: (path.stat().st_mtime, path.parent.name))\n'
    '    release = json.loads(receipts[-1].read_text()).get("osRelease", "") if receipts else ""\n'
    '    print("none" if not receipts else release if isinstance(release, str) and re.fullmatch(r"[0-9A-Za-z.+~_-]+", release) else "")\n'
    'except Exception:\n'
    '    print("")\n'
)
DOCUMENT_PACKAGES = ('python3-docx', 'python3-openpyxl', 'python3-pypdf', 'python3-pdfminer', 'weasyprint', 'fonts-noto-cjk', 'pandoc', 'python3-markdown', 'libharfbuzz-subset0', 'fonts-lxgw-wenkai', 'python3-venv')
DOCUMENT_PYTHON = '/usr/lib/himawari-document-python'
DOCUMENT_TOOLS_CHECK = 'if /usr/bin/python3 -I -c "import docx, openpyxl, pypdf, pdfminer, weasyprint, markdown" >/dev/null 2>&1 && /usr/bin/pandoc --version >/dev/null 2>&1 && /usr/bin/fc-list :lang=zh family 2>/dev/null | /usr/bin/grep -q "Noto Sans CJK" && /usr/bin/fc-list :lang=zh family 2>/dev/null | /usr/bin/grep -q "LXGW WenKai" && /usr/lib/himawari-document-python/bin/python -I -c "import weasyprint, pypdf; from weasyprint.text.ffi import harfbuzz_subset; assert weasyprint.__version__.split(chr(46))[0] == str(70) and harfbuzz_subset" >/dev/null 2>&1; then echo documentTools=ok; else echo documentTools=missing; fi'
SANDBOX_LINKS_SCRIPT = (Path(__file__).resolve().parent / 'sandbox-command-links.py').read_text()
EMBEDDING_ARTIFACT_SCRIPT = (Path(__file__).resolve().parent / 'embedding-artifact-check.py').read_text()
SANDBOX_READ_ROOTS = re.compile(r'readOnlyToolchainPaths: \[(.*?)protectedPaths: \[', re.DOTALL)
PROBE_UNIT_LINE = re.compile(r"^unit = '([A-Za-z0-9@._-]+\.service)'$", re.MULTILINE)


def packet_bytes(packet):
    return sum(path.stat().st_size for path in packet.rglob('*') if path.is_file() and 'run-logs' not in path.parts)


def probe_units(packet, binding):
    units = set()
    for script in sorted((packet / 'measurement').glob('*.py')):
        units.update(PROBE_UNIT_LINE.findall(script.read_text()))
    units.discard(binding['service']['unit'])
    return sorted(units)


def source_cache(binding):
    return str(Path(binding['paths']['newPrefix']).parent.parent / 'source-cache.git')


def source_base(packet):
    path = packet / 'packet-parameters.json'
    return json.loads(path.read_text()).get('SOURCE_BASE_COMMIT', '') if path.is_file() else ''


def local_embedding_target(packet):
    path = packet / 'packet-parameters.json'
    target = json.loads(json.loads(path.read_text()).get('TARGET_EMBEDDING_JSON', 'null')) if path.is_file() else None
    if not isinstance(target, dict) or target.get('provider') != 'local-onnx':
        return None
    if not isinstance(target.get('model'), str) or not isinstance(target.get('artifactSha256'), str) or type(target.get('dimensions')) is not int:
        raise SystemExit('PREFLIGHT_CHECK packet-parameters.json TARGET_EMBEDDING_JSON is not a complete local embedding target; rebuild the packet with make-packet.py')
    return target


def sandbox_read_roots(packet):
    seal = (packet / 'signing' / 'cloud-seal.mjs').read_text()
    block = SANDBOX_READ_ROOTS.search(seal)
    if not block:
        raise SystemExit('PREFLIGHT_CHECK sandbox read paths not found in signing/cloud-seal.mjs')
    return re.findall(r'"(/[^"]*)"', block.group(1))


def remote_script(binding, units=(), paths=(), roots=(), base='', embedding=None):
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
        'echo "scratchScenes=$(' + SCRATCH_SCENE_COUNT + ')"',
        DOCUMENT_TOOLS_CHECK,
        RUNNING_KERNEL,
        '/usr/bin/python3 -I -c ' + shlex.quote(READ_NEXT_BOOT_KERNEL) + ' ' + ' '.join(shlex.quote(path) for path in (GRUB_CONFIG, GRUB_ENVIRONMENT, BOOT_DIRECTORY)),
        'echo "qualifiedKernel=$(/usr/bin/python3 -I -c ' + shlex.quote(READ_QUALIFIED_KERNEL) + ' ' + shlex.quote(str(Path(binding['service']['newQualificationEvidenceRoot']).parent)) + ')"',
        *(['if /usr/bin/git -C ' + shlex.quote(source_cache(binding)) + ' cat-file -e ' + shlex.quote(base + '^{commit}') + ' 2>/dev/null; then echo sourceCacheBase=present; else echo sourceCacheBase=absent; fi'] if base else []),
        *(['/usr/bin/python3 -I -c ' + shlex.quote(EMBEDDING_ARTIFACT_SCRIPT) + ' ' + ' '.join(shlex.quote(value) for value in (binding['paths']['stateRoot'], embedding['model'], embedding['artifactSha256'], str(embedding['dimensions']))) + ' || echo embeddingArtifact=check-failed'] if embedding else []),
        '/usr/bin/python3 -I -c ' + shlex.quote(SANDBOX_LINKS_SCRIPT) + ' ' + ' '.join(shlex.quote(root) for root in roots) + ' || echo sandboxLinks=check-failed',
        *['echo ' + shlex.quote('probeUnit.' + unit) + '="$(/usr/bin/systemctl show -p LoadState --value ' + shlex.quote(unit) + ')"' for unit in units],
        *['if [ -e ' + shlex.quote(path) + ' ] || [ -L ' + shlex.quote(path) + ' ]; then echo ' + shlex.quote('targetPath.' + path + '=present') + '; else echo ' + shlex.quote('targetPath.' + path + '=absent') + '; fi' for path in paths],
    ])


MAX_FAILURE_SCENES = 1
SCRATCH_SCENE_COUNT = "/usr/bin/find /tmp -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '/tmp/h[A-Za-z0-9]{4}' | /usr/bin/wc -l"


FROZEN_STATE_CHECKS = ('CONFIG_UNCHANGED_SINCE_FREEZE', 'UNIT_UNCHANGED_SINCE_FREEZE', 'AUTHORITY_UNCHANGED_SINCE_FREEZE')


def predicted_install_bytes(facts, size):
    measured = int(facts.get('lastInstallUsed') or 0)
    return size + int(measured * MEASURED_INSTALL_HEADROOM) if measured > 0 else size * UNMEASURED_INSTALL_FACTOR


def space(facts, size):
    install = predicted_install_bytes(facts, size)
    free = int(facts.get('rootFree') or 0)
    return {'rootFree': free, 'predictedInstall': install, 'predictedFreeAfterInstall': free - install, 'needAfterInstall': ACCEPTANCE_ROOT_FREE_BYTES + ROOT_RESERVE_BYTES, 'measuredFromLastInstall': int(facts.get('lastInstallUsed') or 0) > 0}


def first_tools(packet):
    path = packet / 'packet-parameters.json'
    return path.is_file() and json.loads(path.read_text()).get('FIRST_TOOLS') == '1'


def checks(binding, facts, size, units=(), paths=(), base='', embedding=None, first=False):
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
        ('TMP_SCRATCH_WITHIN_LIMIT', int(facts.get('scratchScenes') or 0) <= MAX_FAILURE_SCENES),
        ('DOCUMENT_TOOLS_INSTALLED', facts.get('documentTools') == 'ok'),
        ('NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL', bool(facts.get('runningKernel')) and facts.get('nextBootKernel') == facts.get('runningKernel') == facts.get('savedBootKernel')),
        ('RUNNING_KERNEL_MATCHES_QUALIFICATION', bool(facts.get('runningKernel')) and (facts.get('qualifiedKernel') == facts.get('runningKernel') or (first and facts.get('qualifiedKernel') == 'none'))),
        *([('SOURCE_CACHE_HAS_BASE', facts.get('sourceCacheBase') == 'present')] if base else []),
        ('SANDBOX_COMMAND_LINKS_REACHABLE', facts.get('sandboxLinks') == 'ok'),
        *([('LOCAL_EMBEDDING_ARTIFACT_INSTALLED', facts.get('embeddingArtifact') == 'ok')] if embedding else []),
        *[('PROBE_UNIT_UNUSED ' + unit, facts.get('probeUnit.' + unit) == 'not-found') for unit in units],
        *[('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent') for path in paths],
    ]


def main():
    packet = Path(sys.argv[1]).resolve()
    binding = json.loads((packet / 'inputs' / 'bindings.json').read_text())
    units, paths, base, embedding = probe_units(packet, binding), target_paths(binding), source_base(packet), local_embedding_target(packet)
    child = subprocess.run(['ssh', *SSH_OPTIONS, 'root@' + binding['host']['address'], remote_script(binding, units, paths, sandbox_read_roots(packet), base, embedding)], capture_output=True, text=True, timeout=180 if embedding else 60, check=False)
    if child.returncode != 0:
        print('PREFLIGHT_CHECK SSH failed exit=' + str(child.returncode) + ' ' + child.stderr.strip())
        return 1
    facts = dict(line.split('=', 1) for line in child.stdout.splitlines() if '=' in line)
    failed = False
    first = first_tools(packet)
    results = checks(binding, facts, packet_bytes(packet), units, paths, base, embedding, first)
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
    if any(name == 'TMP_SCRATCH_WITHIN_LIMIT' and not passed for name, passed in results):
        print('PREFLIGHT_TMP_SCRATCH /tmp holds ' + facts.get('scratchScenes', '?') + ' acceptance scratch directories (h plus 4 characters) after the cleanup, more than the ' + str(MAX_FAILURE_SCENES) + ' failure scene allowed; see them with: ls -ld /tmp/h????, and see what the cleanup would remove with: python3 ' + str(Path(__file__).resolve().parent / 'release-cleanup.py') + ' ' + str(packet) + ' plan')
    if any(name == 'DOCUMENT_TOOLS_INSTALLED' and not passed for name, passed in results):
        print('PREFLIGHT_DOCUMENT_TOOLS the model sandbox needs these system packages; with the owner\'s approval run as root: apt-get update && apt-get install --no-install-recommends ' + ' '.join(DOCUMENT_PACKAGES) + ', then install the pinned WeasyPrint 70 into /usr/lib/himawari-document-python as ADR 0118 describes')
    if any(name == 'NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL' and not passed for name, passed in results):
        print('PREFLIGHT_NEXT_BOOT_KERNEL ' + ('first resolve PREFLIGHT_QUALIFIED_KERNEL below, then point GRUB at the kernel it settles on; ' if facts.get('qualifiedKernel') != facts.get('runningKernel') and not (first and facts.get('qualifiedKernel') == 'none') else '') + 'the server runs kernel ' + facts.get('runningKernel', '?') + ' but GRUB would start ' + (facts.get('nextBootKernel') or 'an unknown kernel') + ' on the next reboot and ' + (facts.get('savedBootKernel') or 'an unknown kernel') + ' on the reboots after it (unknown means ' + GRUB_CONFIG + ' or ' + GRUB_ENVIRONMENT + ' could not be read or parsed, grub.cfg does not boot only the saved entry, or the entry boots no kernel in ' + BOOT_DIRECTORY + '); the sandbox qualification is bound to the running kernel and the service would refuse to start on any other one. The running release, the service and GRUB were not changed. With the owner\'s approval, as root: if grub.cfg does not boot the saved entry, first set GRUB_DEFAULT=saved in /etc/default/grub and run update-grub; run grub-editenv ' + GRUB_ENVIRONMENT + ' list; point GRUB at the running kernel with its full quoted entry path, submenu id, then >, then entry id, replacing both ids with the real ones from: grep menuentry_id_option ' + GRUB_CONFIG + ', for example: grub-set-default \'gnulinux-advanced-<uuid>>gnulinux-' + facts.get('runningKernel', '<kernel>') + '-advanced-<uuid>\'; remove a one-time choice with: grub-editenv ' + GRUB_ENVIRONMENT + ' unset next_entry; run grub-editenv list again and run this check again. Keep the other installed kernels, they are the fallback')
    if any(name == 'RUNNING_KERNEL_MATCHES_QUALIFICATION' and not passed for name, passed in results):
        print('PREFLIGHT_QUALIFIED_KERNEL the running kernel ' + facts.get('runningKernel', '?') + ' differs from the kernel the latest installation receipt records (' + (facts.get('qualifiedKernel') or 'unreadable') + '); the sandbox qualification is bound to that kernel, and the service would refuse to start on any other one. With the owner\'s approval, either boot the kernel the receipt records once with grub-reboot and its full quoted entry path, keeping grub-set-default on the running kernel as the fallback, check with grub-editenv ' + GRUB_ENVIRONMENT + ' list and reboot, then make it the default with grub-set-default once it runs, or qualify the running kernel first with the sandbox qualification procedure before deploying; the running release, the service and GRUB were not changed')
    if any(name == 'SANDBOX_COMMAND_LINKS_REACHABLE' and not passed for name, passed in results):
        print('PREFLIGHT_SANDBOX_LINKS these commands in /usr/bin are links to a place the model sandbox is not allowed to read, so the model would get command not found for them (' + facts.get('sandboxLinks', 'no answer') + '); add the missing directory to readOnlyToolchainPaths in signing/cloud-seal.mjs, regenerate the packet and run this check again')
    if any(name == 'ROOT_FREE_FOR_ACCEPTANCE' and not passed for name, passed in results):
        print('PREFLIGHT_ROOT_SPACE after installing this release the root disk would have less than the 10 GiB production acceptance needs plus 1 GiB reserve; see what the cleanup would remove with: python3 ' + str(Path(__file__).resolve().parent / 'release-cleanup.py') + ' ' + str(packet) + ' plan')
    if any(name == 'SOURCE_CACHE_HAS_BASE' and not passed for name, passed in results):
        print('PREFLIGHT_SOURCE_BASE the source cache ' + source_cache(binding) + ' on the server does not hold ' + base + ', so this packet\'s incremental source bundle cannot be installed; nothing was uploaded; make a new packet that ships the whole history with: python3 ' + str(Path(__file__).resolve().parent / 'make-packet.py') + ' prepare --full-source')
    if any(name == 'LOCAL_EMBEDDING_ARTIFACT_INSTALLED' and not passed for name, passed in results):
        print('PREFLIGHT_EMBEDDING_ARTIFACT this release switches memory search to the local model ' + embedding['model'] + ', but ' + binding['paths']['stateRoot'] + '/models/' + embedding['model'] + '/' + embedding['artifactSha256'] + ' on the server is not a complete copy (' + facts.get('embeddingArtifact', 'no answer') + '); with the owner\'s approval build it with scripts/embedding-models/build-artifact.py and copy the whole directory there, owned by the service account, then rerun')
    if any(name in FROZEN_STATE_CHECKS and not passed for name, passed in results):
        print('PREFLIGHT_REFREEZE the production service restarted or changed after this packet was frozen; run: python3 ' + str(Path(__file__).resolve().parent / 'make-packet.py') + ' freeze ' + str(packet))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
