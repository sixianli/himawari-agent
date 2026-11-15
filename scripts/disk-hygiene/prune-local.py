import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
DATED_PACKET = re.compile(r'^\d{4}-\d{2}-\d{2}-')
XCODE_BUSY_PATTERN = r'xcodebuild|simctl|swift-frontend|swiftc'
DAY = 86400


def load_rebuildable():
    spec = importlib.util.spec_from_file_location('prune_rebuildable', HERE / 'prune-rebuildable.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def positive_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def string_list(value):
    return isinstance(value, list) and all(isinstance(item, str) and item for item in value)


def load_config(path):
    try:
        config = json.loads(Path(path).read_text())
    except OSError:
        raise SystemExit(f'PRUNE_CONFIG_MISSING {path}')
    except ValueError:
        raise SystemExit(f'PRUNE_CONFIG_INVALID {path} json')
    problems = []
    if config.get('schemaVersion') != 1:
        problems.append('schemaVersion')
    for key in ('minAgeHours', 'xcodeIdleDays', 'worktreeIdleDays', 'packetSlimFileBytes'):
        if not positive_number(config.get(key)):
            problems.append(key)
    if not isinstance(config.get('keepPackets'), int) or isinstance(config.get('keepPackets'), bool) or config['keepPackets'] < 1:
        problems.append('keepPackets')
    for key in ('legacyXcodeDirs', 'worktreeKeep', 'worktreeIgnoredAllowed', 'worktreeParents', 'packetKeepSuffixes'):
        if not string_list(config.get(key)):
            problems.append(key)
    for key in ('appleCache', 'tmpXcodePrefix'):
        if not isinstance(config.get(key), str) or not config[key]:
            problems.append(key)
    if problems:
        raise SystemExit(f'PRUNE_CONFIG_INVALID {path} {",".join(problems)}')
    return config


def git(cwd, *args, check=True):
    child = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, check=False)
    if check and child.returncode != 0:
        raise RuntimeError(f'git {" ".join(args)}: {child.stderr.strip()}')
    return child


def newest_mtime(path, depth=2):
    newest = 0.0
    stack = [(Path(path), 0)]
    while stack:
        current, level = stack.pop()
        try:
            status = os.lstat(current)
        except OSError:
            continue
        newest = max(newest, status.st_mtime)
        if level < depth and current.is_dir() and not current.is_symlink():
            try:
                stack.extend((child, level + 1) for child in current.iterdir())
            except OSError:
                pass
    return newest


def tree_size(path):
    total = 0
    for directory, _, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(directory, name)).st_size
            except OSError:
                pass
    return total


def inside(path, root):
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False


def process_directories(proc_root):
    found = set()
    child = subprocess.run(['lsof', '-a', '-d', 'cwd', '-Fn'], capture_output=True, text=True, check=False) if shutil.which('lsof') else None
    if child is not None and child.returncode in (0, 1) and child.stdout:
        found.update(line[1:] for line in child.stdout.splitlines() if line.startswith('n'))
        return found
    proc = Path(proc_root)
    if not proc.is_dir():
        return None
    for entry in proc.iterdir():
        if entry.name.isdigit():
            try:
                found.add(os.readlink(entry / 'cwd'))
            except OSError:
                pass
    return found


class Run:
    def __init__(self, apply):
        self.apply = apply
        self.deleted = []
        self.kept = []
        self.errors = 0

    def delete(self, kind, path, size, action):
        print(f'{"DELETE" if self.apply else "WOULD_DELETE"} {size} {kind} {path}')
        if self.apply:
            try:
                action()
            except (OSError, RuntimeError) as error:
                self.errors += 1
                print(f'PRUNE_ERROR {kind} {path}: {error}', file=sys.stderr)
                return
        self.deleted.append({'kind': kind, 'path': str(path), 'bytes': size})

    def keep(self, kind, path, reason, size=None):
        print(f'KEEP {kind} {reason} {path}' + (f' bytes={size}' if size is not None else ''))
        self.kept.append({'kind': kind, 'path': str(path), 'reason': reason})


def remove_tree(path):
    target = Path(path)
    if target.is_symlink():
        raise OSError('refusing a symbolic link')
    shutil.rmtree(target)


def prune_xcode(run, config, repo, tmp, now, busy):
    if busy:
        run.keep('xcode', '-', 'xcode-busy')
        return
    cutoff = now - config['xcodeIdleDays'] * DAY
    candidates = []
    cache = Path(os.path.expanduser(config['appleCache'])) / 'DerivedData'
    if cache.is_dir():
        candidates += [child for child in cache.iterdir() if child.is_dir() and not child.name.endswith('.lock')]
    if repo:
        candidates += [repo / relative for relative in config['legacyXcodeDirs'] if (repo / relative).is_dir()]
    if tmp and Path(tmp).is_dir():
        candidates += [child for child in Path(tmp).iterdir() if child.name.startswith(config['tmpXcodePrefix']) and child.is_dir()]
    for path in sorted(candidates):
        if path.is_symlink():
            run.keep('xcode', path, 'symlink')
            continue
        if Path(f'{path}.lock').exists():
            run.keep('xcode', path, 'locked')
            continue
        if newest_mtime(path) >= cutoff:
            run.keep('xcode', path, 'recent')
            continue
        run.delete('xcode', path, tree_size(path), lambda path=path: remove_tree(path))


def worktrees(repo):
    raw = git(repo, 'worktree', 'list', '--porcelain', '-z').stdout
    entries, current = [], {}
    for field in raw.split('\0'):
        if field == '':
            if current:
                entries.append(current)
            current = {}
            continue
        key, _, value = field.partition(' ')
        current[key] = value or True
    if current:
        entries.append(current)
    return entries


def worktree_state(path, allowed_ignored):
    status = git(path, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', check=False)
    if status.returncode != 0:
        return 'status-failed'
    for record in status.stdout.split('\0'):
        if not record:
            continue
        code, name = record[:2], record[3:]
        if code == '!!':
            if not any(part in allowed_ignored for part in Path(name).parts):
                return 'ignored-files'
            continue
        return 'uncommitted-changes'
    return None


def worktree_age(path):
    gitdir = git(path, 'rev-parse', '--absolute-git-dir', check=False).stdout.strip()
    stamps = [newest_mtime(path, depth=1)]
    for name in ('HEAD', 'logs/HEAD'):
        candidate = Path(gitdir) / name if gitdir else None
        if candidate and candidate.exists():
            stamps.append(candidate.stat().st_mtime)
    return max(stamps)


def prune_worktrees(run, config, repo, now, process_dirs):
    if run.apply:
        git(repo, 'worktree', 'prune')
    else:
        child = git(repo, 'worktree', 'prune', '--dry-run', '--verbose', check=False)
        stale = (child.stdout + child.stderr).strip()
        for line in filter(None, stale.splitlines()):
            print(f'WOULD_PRUNE_WORKTREE_RECORD {line}')
    base = git(repo, 'rev-parse', '--verify', '--quiet', 'origin/main', check=False).stdout.strip()
    keep = [(repo / relative).resolve() for relative in config['worktreeKeep']]
    cutoff = now - config['worktreeIdleDays'] * DAY
    registered = set()
    entries = worktrees(repo)
    for entry in entries[1:]:
        path = Path(entry['worktree'])
        registered.add(path.resolve() if path.exists() else path)
        if 'prunable' in entry or not path.exists():
            continue
        if any(path.resolve() == kept or inside(path, kept) for kept in keep):
            reason = 'keep-list'
        elif 'locked' in entry:
            reason = 'locked'
        elif not base:
            reason = 'no-origin-main'
        elif process_dirs is None:
            reason = 'process-check-unavailable'
        elif any(inside(directory, path) for directory in process_dirs):
            reason = 'in-use'
        elif git(path, 'merge-base', '--is-ancestor', 'HEAD', base, check=False).returncode != 0:
            reason = 'unmerged-commits'
        else:
            reason = worktree_state(path, set(config['worktreeIgnoredAllowed']))
            if reason is None and worktree_age(path) >= cutoff:
                reason = 'recent'
        size = tree_size(path)
        if reason:
            run.keep('worktree', path, reason, size)
            continue
        run.delete('worktree', path, size, lambda path=path: git(repo, 'worktree', 'remove', str(path)))
    for parent in config['worktreeParents']:
        directory = repo / parent
        if not directory.is_dir():
            continue
        for child in sorted(directory.iterdir()):
            if child.is_dir() and child.resolve() not in registered:
                run.keep('worktree', child, 'not-a-registered-worktree', tree_size(child))


def prune_packets(run, config, roots, now):
    cutoff = now - config['minAgeHours'] * 3600
    suffixes = tuple(config['packetKeepSuffixes'])
    for root in roots:
        for production in [root, *root.rglob('production')]:
            if production.name != 'production' or not production.is_dir() or production.is_symlink():
                continue
            packets = [child for child in production.iterdir() if child.is_dir() and not child.is_symlink() and DATED_PACKET.match(child.name)]
            packets.sort(key=lambda child: (child.name[:10], child.stat().st_mtime), reverse=True)
            for packet in packets[config['keepPackets']:]:
                for directory, subdirectories, files in os.walk(packet):
                    subdirectories[:] = [name for name in subdirectories if not (Path(directory) / name).is_symlink()]
                    for name in files:
                        path = Path(directory) / name
                        if path.is_symlink() or name.endswith(suffixes):
                            continue
                        status = path.stat()
                        if status.st_size <= config['packetSlimFileBytes'] or status.st_mtime >= cutoff:
                            continue
                        run.delete('packet-file', path, status.st_size, path.unlink)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Expire local build caches, finished worktrees and large files in old packets (ADR 0276).')
    parser.add_argument('--config', default=str(HERE / 'retention.json'))
    parser.add_argument('--repo')
    parser.add_argument('--ci-output', action='append', default=[])
    parser.add_argument('--tmp', default=os.environ.get('TMPDIR', ''))
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--skip-if-busy', action='store_true')
    parser.add_argument('--proc-root', default='/proc')
    parser.add_argument('--now', type=float)
    options = parser.parse_args(argv)
    config = load_config(options.config)
    rebuildable = load_rebuildable()
    now = options.now or time.time()
    repo = Path(options.repo).expanduser().resolve() if options.repo else None
    if repo and not (repo / '.git').exists():
        raise SystemExit(f'PRUNE_REPO_INVALID {repo}')
    roots = [Path(path).expanduser().resolve() for path in options.ci_output]
    if not roots and repo and (repo / '.ci-output').is_dir():
        roots = [repo / '.ci-output']
    config_text = Path(options.config).read_bytes()
    script_text = Path(__file__).read_bytes()
    print('PRUNE_LOCAL_VERSION ' + json.dumps({'script': hashlib.sha256(script_text).hexdigest()[:12], 'config': hashlib.sha256(config_text).hexdigest()[:12]}))
    if options.skip_if_busy:
        host, _ = rebuildable.busy_processes(rebuildable.BUSY_PATTERN, options.proc_root)
        if host:
            print('PRUNE_SKIPPED_BUSY: a build or test is running')
            print('PRUNE_LOCAL_RESULT ' + json.dumps({'mode': 'skipped-busy', 'bytes': 0}))
            return 0
    xcode_busy = bool(rebuildable.busy_processes(XCODE_BUSY_PATTERN, options.proc_root)[0])
    run = Run(options.apply)
    prune_xcode(run, config, repo, options.tmp, now, xcode_busy)
    if repo:
        prune_worktrees(run, config, repo, now, process_directories(options.proc_root))
    prune_packets(run, config, roots, now)
    total = sum(item['bytes'] for item in run.deleted)
    print('PRUNE_LOCAL_RESULT ' + json.dumps({'mode': 'apply' if options.apply else 'dry-run', 'deleted': len(run.deleted), 'bytes': total, 'kept': len(run.kept), 'errors': run.errors}))
    return 1 if run.errors else 0


if __name__ == '__main__':
    sys.exit(main())
