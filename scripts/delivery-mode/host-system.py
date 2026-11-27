import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def preflight():
    spec = importlib.util.spec_from_file_location('deploy_preflight', HERE / 'deploy-preflight.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REMOTE = r'''
import os, pathlib, subprocess, sys, tempfile
settings = json.loads(SETTINGS)
environment = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive', 'LANG': 'C.UTF-8'}


def fail(code, detail):
    print('HOST_SYSTEM_FAILED ' + code + ' ' + detail, flush=True)
    sys.exit(1)


def run(arguments):
    child = subprocess.run(arguments, capture_output=True, text=True, env=environment)
    if child.returncode != 0:
        fail('COMMAND_FAILED', ' '.join(arguments) + ' exit=' + str(child.returncode) + ' ' + (child.stderr or child.stdout).strip()[-600:])
    return child.stdout


def document_tools_ready():
    return 'documentTools=ok' in subprocess.run(['/bin/bash', '-c', settings['documentCheck']], capture_output=True, text=True).stdout


def boot_facts():
    output = run(['/usr/bin/python3', '-I', '-c', settings['bootReader'], *settings['bootPaths']])
    facts = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    return facts.get('nextBootKernel', ''), facts.get('savedBootKernel', '')


def ensure_document_tools():
    if document_tools_ready():
        print('HOST_SYSTEM_DOCUMENT_TOOLS already', flush=True)
        return
    run(['/usr/bin/apt-get', 'update', '-qq'])
    run(['/usr/bin/apt-get', 'install', '-y', '-qq', '--no-install-recommends', *settings['packages']])
    venv = pathlib.Path(settings['documentPython'])
    run(['/usr/bin/python3', '-m', 'venv', '--clear', str(venv)])
    with tempfile.NamedTemporaryFile('w', suffix='.txt') as requirements:
        requirements.write(settings['requirements'])
        requirements.flush()
        run([str(venv / 'bin/python'), '-I', '-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', '--require-hashes', '--only-binary=:all:', '--no-deps', '-r', requirements.name])
    run(['/usr/bin/chmod', '-R', 'go-w', str(venv)])
    if not document_tools_ready():
        fail('DOCUMENT_TOOLS_STILL_MISSING', 'the packages and ' + str(venv) + ' were installed but the preflight check still fails')
    print('HOST_SYSTEM_DOCUMENT_TOOLS installed', flush=True)


def running_entry_path(running):
    namespace = {}
    exec(settings['bootReader'].split('try:\n')[0], namespace)
    entries = namespace['menu'](pathlib.Path(settings['bootPaths'][0]).read_text())
    for entry in entries:
        for child in entry['children'] or []:
            if entry['id'] and child['children'] is None and child['kernel'] == running and child['id'] and 'recovery' not in child['title']:
                return entry['id'] + '>' + child['id']
    for entry in entries:
        if entry['children'] is None and entry['kernel'] == running and entry['id'] and 'recovery' not in entry['title']:
            return entry['id']
    fail('RUNNING_KERNEL_NOT_IN_GRUB', running + ' has no GRUB entry in ' + settings['bootPaths'][0])


def ensure_boot_pinned():
    running = run(['/usr/bin/uname', '-r']).strip()
    if boot_facts() == (running, running):
        print('HOST_SYSTEM_BOOT already ' + running, flush=True)
        return
    if not pathlib.Path(settings['bootPaths'][0]).is_file() or not pathlib.Path('/usr/sbin/update-grub').is_file():
        fail('GRUB_NOT_FOUND', 'this host does not boot through GRUB at ' + settings['bootPaths'][0])
    pathlib.Path('/etc/default/grub.d').mkdir(exist_ok=True)
    pathlib.Path('/etc/default/grub.d/99-himawari-saved-default.cfg').write_text('GRUB_DEFAULT=saved\n')
    run(['/usr/sbin/update-grub'])
    run(['/usr/bin/grub-set-default', running_entry_path(running)])
    run(['/usr/bin/grub-editenv', settings['bootPaths'][1], 'unset', 'next_entry'])
    if boot_facts() != (running, running):
        fail('BOOT_NOT_PINNED', 'GRUB still would not start ' + running + ' on the next reboot')
    print('HOST_SYSTEM_BOOT pinned ' + running, flush=True)


if __name__ == '__main__':
    if os.getuid() != 0:
        fail('NOT_ROOT', str(os.getuid()))
    ensure_document_tools()
    ensure_boot_pinned()
    print('HOST_SYSTEM_OK', flush=True)
'''


def remote_program():
    module = preflight()
    settings = {
        'documentCheck': module.DOCUMENT_TOOLS_CHECK,
        'packages': list(module.DOCUMENT_PACKAGES),
        'documentPython': module.DOCUMENT_PYTHON,
        'requirements': (HERE / 'document-python-requirements.txt').read_text(),
        'bootReader': module.READ_NEXT_BOOT_KERNEL,
        'bootPaths': [module.GRUB_CONFIG, module.GRUB_ENVIRONMENT, module.BOOT_DIRECTORY],
    }
    return 'import json\nSETTINGS = ' + json.dumps(json.dumps(settings)) + '\n' + REMOTE


if __name__ == '__main__':
    sys.stdout.write(remote_program())
