import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

REBUILDABLE_FILES = ('*.bundle', 'node-modules.tar.gz', '*-abi[0-9]*-*.tar.gz', 'python-[0-9]*.tar.gz')
TEMPORARY_COPY_PARENTS = ('doc-check',)
SKIPPED_DIRECTORIES = ('.git', 'node_modules')
DATED_PACKET = re.compile(r'^\d{4}-\d{2}-\d{2}-')
BUSY_PATTERN = r'vitest|playwright|scripts/ci/(run|local|test|build|execute)\.mjs|npm (test|run (build|check|test))'


def is_rebuildable(name):
    return any(fnmatch.fnmatch(name, pattern) for pattern in REBUILDABLE_FILES)


def tree_size(path):
    total = 0
    for directory, _, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(directory, name)).st_size
            except OSError:
                pass
    return total


def protected_packets(root, keep_packets):
    protected = set()
    for production in [root, *root.rglob('production')]:
        if production.name != 'production' or not production.is_dir():
            continue
        packets = [child for child in production.iterdir() if child.is_dir() and DATED_PACKET.match(child.name)]
        packets.sort(key=lambda child: (child.name[:10], child.stat().st_mtime), reverse=True)
        protected.update(child.resolve() for child in packets[:keep_packets])
    return protected


def candidates(root, protected, cutoff):
    for directory, subdirectories, files in os.walk(root):
        current = Path(directory)
        kept = []
        for name in subdirectories:
            child = current / name
            if name in SKIPPED_DIRECTORIES or child.is_symlink() or child.resolve() in protected:
                continue
            if name == 'tools' and current.name == '.ci-output':
                continue
            if current.name in TEMPORARY_COPY_PARENTS:
                if child.stat().st_mtime < cutoff:
                    yield child, tree_size(child), True
                continue
            kept.append(name)
        subdirectories[:] = kept
        for name in files:
            path = current / name
            if not is_rebuildable(name) or path.is_symlink():
                continue
            status = path.stat()
            if status.st_mtime < cutoff:
                yield path, status.st_size, False


CONTAINER_CGROUP_SEGMENT = re.compile(
    r'(?:^|/)(?:docker[-/][0-9a-f]{12,}|libpod-[0-9a-f]{12,}|cri-containerd-[0-9a-f]{12,}|kubepods[^/]*)(?:\.scope)?(?:/|$)'
)


def runs_in_container(pid, proc_root):
    try:
        text = (Path(proc_root) / pid / 'cgroup').read_text()
    except OSError:
        return False
    return any(CONTAINER_CGROUP_SEGMENT.search(line.split(':', 2)[-1]) for line in text.splitlines())


def busy_processes(pattern, proc_root='/proc'):
    child = subprocess.run(['pgrep', '-f', pattern], capture_output=True, text=True, check=False)
    own = {str(os.getpid()), str(os.getppid())}
    host, container = [], []
    for pid in child.stdout.split():
        if pid in own:
            continue
        (container if runs_in_container(pid, proc_root) else host).append(pid)
    return host, container


def main(argv=None):
    parser = argparse.ArgumentParser(description='Delete rebuildable build and packet artifacts; never logs, reports, evidence, or scripts.')
    parser.add_argument('roots', nargs='+')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--keep-packets', type=int, default=2)
    parser.add_argument('--keep', action='append', default=[])
    parser.add_argument('--min-age-hours', type=float, default=24)
    parser.add_argument('--low-free-gb', type=float, default=10)
    parser.add_argument('--skip-if-busy', action='store_true')
    parser.add_argument('--busy-pattern', default=BUSY_PATTERN)
    parser.add_argument('--proc-root', default='/proc')
    options = parser.parse_args(argv)

    roots = [Path(root).expanduser().resolve() for root in options.roots]
    roots = [root for root in roots if root.is_dir()]
    host_busy, container_ignored = busy_processes(options.busy_pattern, options.proc_root) if options.skip_if_busy else ([], [])
    if container_ignored:
        print('PRUNE_IGNORED_CONTAINER_PROCESSES ' + json.dumps({'count': len(container_ignored), 'pids': container_ignored[:20]}))
    if host_busy:
        print('PRUNE_SKIPPED_BUSY: a build or test is running')
        print('PRUNE_RESULT ' + json.dumps({'mode': 'skipped-busy', 'files': 0, 'directories': 0, 'bytes': 0, 'roots': [str(root) for root in roots]}))
        return 0

    cutoff = time.time() - options.min_age_hours * 3600
    keep = {Path(path).expanduser().resolve() for path in options.keep}
    verb = 'DELETE' if options.apply else 'WOULD_DELETE'
    files = directories = total = errors = 0
    free = {}
    for root in roots:
        protected = protected_packets(root, options.keep_packets) | keep
        for path, size, is_directory in list(candidates(root, protected, cutoff)):
            print(f'{verb} {size} {path}')
            if options.apply:
                try:
                    shutil.rmtree(path) if is_directory else path.unlink()
                except OSError as error:
                    errors += 1
                    print(f'PRUNE_ERROR {path}: {error}', file=sys.stderr)
                    continue
            directories += is_directory
            files += not is_directory
            total += size
        free[str(root)] = shutil.disk_usage(root).free
    low = [root for root, available in free.items() if available < options.low_free_gb * 1024 ** 3]
    for root in low:
        print(f'PRUNE_LOW_DISK {root}: {free[root] / 1024 ** 3:.1f} GB free after pruning')
    print('PRUNE_RESULT ' + json.dumps({'mode': 'apply' if options.apply else 'dry-run', 'files': files, 'directories': directories, 'bytes': total, 'errors': errors, 'freeBytes': free, 'lowDisk': bool(low)}))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
