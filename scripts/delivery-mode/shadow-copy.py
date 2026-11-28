import os
import shutil
import sqlite3
import stat
import sys
from pathlib import Path

SQLITE_HEADER = b'SQLite format 3\x00'
SQLITE_SIDE_FILES = ('-wal', '-shm', '-journal')


def is_sqlite(path):
    with path.open('rb') as handle:
        return handle.read(len(SQLITE_HEADER)) == SQLITE_HEADER


def snapshot(source, target):
    connection = sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True)
    try:
        connection.execute('VACUUM INTO ?', (str(target),))
    finally:
        connection.close()
    check = sqlite3.connect('file:' + str(target) + '?mode=ro', uri=True)
    try:
        result = check.execute('PRAGMA quick_check').fetchone()[0]
    finally:
        check.close()
    if result != 'ok':
        raise RuntimeError('SHADOW_SNAPSHOT_CHECK_FAILED ' + str(source) + ' ' + result)


def keep_owner_and_mode(source_info, target):
    os.chown(target, source_info.st_uid, source_info.st_gid, follow_symlinks=False)
    if not stat.S_ISLNK(source_info.st_mode):
        os.chmod(target, stat.S_IMODE(source_info.st_mode))


def live_lease_expiry(database_path):
    connection = sqlite3.connect('file:' + str(database_path) + '?mode=ro', uri=True)
    try:
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authority_leases'").fetchone() is None:
            return None
        return connection.execute('SELECT MAX(expires_at) FROM authority_leases WHERE released_at IS NULL').fetchone()[0]
    finally:
        connection.close()


def copy_tree(source, target):
    sqlite_files = 0
    leases = []
    for parent, directories, files in os.walk(source):
        relative = Path(parent).relative_to(source)
        destination = target / relative
        destination.mkdir(exist_ok=True)
        keep_owner_and_mode(os.lstat(parent), destination)
        for name in directories:
            path = Path(parent) / name
            if path.is_symlink():
                os.symlink(os.readlink(path), destination / name)
                keep_owner_and_mode(os.lstat(path), destination / name)
        for name in files:
            path = Path(parent) / name
            try:
                info = os.lstat(path)
            except FileNotFoundError:
                continue
            if name.endswith(SQLITE_SIDE_FILES) and (Path(parent) / name[:name.rindex('-')]).exists():
                continue
            if stat.S_ISLNK(info.st_mode):
                os.symlink(os.readlink(path), destination / name)
            elif stat.S_ISREG(info.st_mode) and info.st_size > 0 and is_sqlite(path):
                snapshot(path, destination / name)
                sqlite_files += 1
                expiry = live_lease_expiry(destination / name)
                if expiry:
                    leases.append(expiry)
            elif stat.S_ISREG(info.st_mode):
                try:
                    shutil.copyfile(path, destination / name)
                except FileNotFoundError:
                    continue
            else:
                continue
            keep_owner_and_mode(info, destination / name)
    return sqlite_files, max(leases) if leases else None


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: shadow-copy.py <state data directory> <empty target directory>')
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    if not source.is_dir() or source.is_symlink() or not target.is_dir() or any(target.iterdir()):
        raise SystemExit('SHADOW_COPY_PATHS_INVALID')
    count, lease_expiry = copy_tree(source, target)
    print('SHADOW_COPY_SQLITE_FILES', count)
    if lease_expiry:
        print('SHADOW_COPY_LEASE_EXPIRES', lease_expiry)


if __name__ == '__main__':
    main()
