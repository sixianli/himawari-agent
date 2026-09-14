#!/usr/bin/python3
"""Install the explicitly authorized eight-hour sudo grant without handling a password."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess
import sys
import tempfile

RULE = Path('/etc/sudoers.d/99-himawari-codex-20260913')
CLEANUP = Path('/etc/himawari/codex-sudo-expiry-20260913.py')
UNIT = 'himawari-codex-sudo-expiry-20260913'
RECEIPT = Path('/data/hermes/himawari/qualifications/2026-09-13-temporary-sudo')
STAGING = Path('/data/hermes/himawari/builds/2026-09-13-loop-finalization')


def grant_rule(now):
    expires = now.astimezone(dt.timezone.utc).replace(microsecond=0) + dt.timedelta(hours=8)
    text = '# Explicit owner authorization: temporary full root access for andy.\n'
    text += f'andy ALL=(root) NOTAFTER={expires:%Y%m%d%H%M%SZ} NOPASSWD: ALL\n'
    return text.encode(), expires


def check_file(path, data):
    subprocess.run(['/usr/sbin/visudo', '-c', '-f', str(path)], check=True, capture_output=True)
    assert path.read_bytes() == data


def exclusive_write(path, data, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as file:
        os.fchmod(file.fileno(), mode)
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def main():
    assert socket.gethostname() == 'hermes-home'
    assert pwd.getpwnam('andy').pw_uid == 1000
    assert sys.argv[1:] in (['--validate'], ['--grant-eight-hours'])
    data, expires = grant_rule(dt.datetime.now(dt.timezone.utc))
    if sys.argv[1:] == ['--validate']:
        with tempfile.TemporaryDirectory(prefix='sudo-rule-validation-', dir=STAGING) as temp:
            path = Path(temp) / 'rule'
            path.write_bytes(data)
            check_file(path, data)
        print(json.dumps({'syntaxValidated': True, 'user': 'andy', 'runAs': 'root', 'commands': 'ALL', 'hours': 8}))
        return
    assert os.geteuid() == 0 and os.environ.get('SUDO_USER') == 'andy'
    for parent in (RULE.parent, CLEANUP.parent):
        info = parent.lstat()
        assert stat.S_ISDIR(info.st_mode) and parent.resolve() == parent
        assert info.st_uid == 0 and not info.st_mode & 0o022
    assert not RULE.exists() and not RULE.is_symlink(), 'TEMPORARY_RULE_ALREADY_EXISTS'
    assert not CLEANUP.exists() and not CLEANUP.is_symlink(), 'EXPIRY_HELPER_ALREADY_EXISTS'
    assert not RECEIPT.exists() and not RECEIPT.is_symlink(), 'GRANT_RECEIPT_ALREADY_EXISTS'
    assert subprocess.check_output(['findmnt', '-no', 'TARGET', '--target', str(STAGING)], text=True).strip() == '/data'
    for suffix in ('.timer', '.service'):
        state = subprocess.check_output(['systemctl', 'show', UNIT + suffix, '-p', 'LoadState', '--value'], text=True).strip()
        assert state == 'not-found', 'EXPIRY_UNIT_ALREADY_EXISTS'
    subprocess.run(['/usr/sbin/visudo', '-c'], check=True, capture_output=True)
    digest = hashlib.sha256(data).hexdigest()
    cleanup = f'''#!/usr/bin/python3
import datetime as dt, hashlib, os, stat
from pathlib import Path
assert os.geteuid() == 0
assert dt.datetime.now(dt.timezone.utc).timestamp() >= {expires.timestamp()!r}
p = Path({str(RULE)!r})
if p.exists() or p.is_symlink():
    s = p.lstat()
    assert stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1 and not s.st_mode & 0o022
    assert hashlib.sha256(p.read_bytes()).hexdigest() == {digest!r}, 'RULE_CHANGED_DO_NOT_REMOVE'
    p.unlink()
print('Temporary sudo rule expired and removed')
'''.encode()
    helper_created = False
    timer_created = False
    rule_created = False
    temporary = None
    try:
        fd, name = tempfile.mkstemp(prefix='.himawari-codex-pending-', dir=RULE.parent)
        temporary = Path(name)
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o440)
        check_file(temporary, data)
        exclusive_write(CLEANUP, cleanup, 0o700)
        helper_created = True
        subprocess.run(['systemd-run', '--quiet', '--unit=' + UNIT, '--on-active=8h', '--timer-property=AccuracySec=1s', '/usr/bin/python3', '-I', str(CLEANUP)], check=True)
        timer_created = True
        subprocess.run(['systemctl', 'is-active', '--quiet', UNIT + '.timer'], check=True)
        # link is atomic and refuses to overwrite an existing grant.
        os.link(temporary, RULE, follow_symlinks=False)
        rule_created = True
        temporary.unlink()
        temporary = None
        subprocess.run(['/usr/sbin/visudo', '-c'], check=True, capture_output=True)
        verified = subprocess.check_output(['/usr/sbin/runuser', '-u', 'andy', '--', '/usr/bin/sudo', '-n', '-k', '/usr/bin/id', '-u'], text=True).strip()
        assert verified == '0', 'NONINTERACTIVE_SUDO_VERIFICATION_FAILED'
        RECEIPT.mkdir(mode=0o755)
        RECEIPT.chmod(0o755)
        receipt = {'granted': True, 'user': 'andy', 'runAs': 'root', 'commands': 'ALL', 'rulePath': str(RULE), 'ruleSha256': digest, 'expiresAt': expires.isoformat(), 'expiryUnit': UNIT + '.timer', 'passwordHandled': False, 'verification': 'runuser andy sudo -n -k id -u returned 0', 'boundary': 'Expiration blocks new sudo commands; existing processes and prior changes are not reverted.'}
        exclusive_write(RECEIPT / 'receipt.json', (json.dumps(receipt, indent=2) + '\n').encode(), 0o644)
        print('Temporary sudo granted; expires at ' + expires.isoformat())
        print('Receipt: ' + str(RECEIPT / 'receipt.json'))
    except BaseException:
        if rule_created and RULE.is_file() and hashlib.sha256(RULE.read_bytes()).hexdigest() == digest:
            RULE.unlink()
        if timer_created:
            subprocess.run(['systemctl', 'stop', UNIT + '.timer'], check=False)
        if helper_created and CLEANUP.is_file() and CLEANUP.read_bytes() == cleanup:
            CLEANUP.unlink()
        raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
