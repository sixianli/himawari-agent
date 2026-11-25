#!/usr/bin/env python3
import json
import os
import posixpath
import re
import subprocess
import sys

EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
ZERO = '0' * 40
POLICY = 'ci/policy.json'
SOURCE = re.compile(r'^(?:apps|packages)/[^/]+/src/.+\.(?:ts|tsx|mts|cts|js|mjs|cjs)$')
TEST_NAME = re.compile(r'\.(?:test|spec)\.[^/]+$')
SPECIFIERS = (
    re.compile(r'\bfrom\s*["\']([^"\']+)["\']'),
    re.compile(r'\bimport\s*["\']([^"\']+)["\']'),
    re.compile(r'\bimport\s*\(\s*["\']([^"\']+)["\']'),
    re.compile(r'\brequire\s*\(\s*["\']([^"\']+)["\']'),
    re.compile(r'\bvi\s*\.\s*(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(\s*["\']([^"\']+)["\']'),
    re.compile(r'\bnew\s+URL\s*\(\s*["\']([^"\']+)["\']\s*,\s*import\.meta\.url'),
)
WHOLE_MOCK = re.compile(r'\bvi\s*\.\s*(?:mock|doMock)\s*\(\s*["\']([^"\']+)["\']')
EXPORT_START = re.compile(r'^\s*export\b')
EXPORT_LIST = re.compile(r'\bexport\s+(?:type\s+)?\{')
HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')
DECLARATION = re.compile(r'^Layer-0-tests:[ \t]*(\S.*?)[ \t]*$')
STEM = re.compile(r'(?:\.(?:unit|contract|compat|integration|e2e))?\.(?:test|spec)\.[^.]+$')
EXTENSIONS = ('.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs')


class Failure(Exception):
    pass


def git(*args, check=True):
    completed = subprocess.run(['git', *args], capture_output=True)
    if check and completed.returncode != 0:
        raise Failure(f'git {" ".join(args)} failed: {completed.stderr.decode("utf-8", "replace").strip()}')
    return completed.stdout.decode('utf-8', 'replace')


def split_z(text):
    return [item for item in text.split('\0') if item]


class Blobs:
    def __init__(self):
        self.process = None
        self.cache = {}

    def read(self, spec):
        if spec in self.cache:
            return self.cache[spec]
        if self.process is None:
            self.process = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.process.stdin.write(spec.encode('utf-8') + b'\n')
        self.process.stdin.flush()
        header = self.process.stdout.readline().decode('utf-8', 'replace').split()
        if len(header) != 3 or header[1] != 'blob':
            raise Failure(f'git cat-file --batch could not read {spec}: {" ".join(header)}')
        size = int(header[2])
        data = self.process.stdout.read(size)
        if len(data) != size or self.process.stdout.read(1) != b'\n':
            raise Failure(f'git cat-file --batch returned a truncated object for {spec}')
        text = data.decode('utf-8', 'replace')
        self.cache[spec] = text
        return text

    def close(self):
        if self.process is None:
            return 0
        self.process.stdin.close()
        self.process.stdout.close()
        return self.process.wait()


BLOBS = Blobs()


class Snapshot:
    def __init__(self, kind, revision=None, base=None):
        self.kind = kind
        self.revision = revision
        if kind == 'revision':
            self.files = set(split_z(git('ls-tree', '-r', '--name-only', '-z', revision)))
        elif kind == 'index':
            self.files = set(split_z(git('ls-files', '--cached', '-z')))
        else:
            tracked = set(split_z(git('ls-files', '--cached', '-z')))
            deleted = set(split_z(git('ls-files', '--deleted', '-z')))
            untracked = set(split_z(git('ls-files', '--others', '--exclude-standard', '-z')))
            self.files = (tracked - deleted) | untracked
        own = test_matcher(self.files, self.read)
        if base is not None and base != EMPTY_TREE and POLICY in set(split_z(git('ls-tree', '-r', '--name-only', '-z', base))):
            inherited = test_matcher({POLICY}, lambda path: BLOBS.read(f'{base}:{path}'))
        else:
            inherited = own
        self.required_tests = inherited
        self.tests = lambda path: inherited(path) or own(path)

    def read(self, path):
        if self.kind == 'worktree':
            try:
                with open(path, encoding='utf-8', errors='replace') as handle:
                    return handle.read()
            except OSError as error:
                raise Failure(f'cannot read {path}: {error}')
        prefix = f'{self.revision}:' if self.kind == 'revision' else ':'
        return BLOBS.read(prefix + path)


def glob_pattern(glob):
    out = ''
    index = 0
    while index < len(glob):
        if glob.startswith('**/', index):
            out += '(?:.*/)?'
            index += 3
        elif glob.startswith('**', index):
            out += '.*'
            index += 2
        elif glob[index] == '*':
            out += '[^/]*'
            index += 1
        else:
            out += re.escape(glob[index])
            index += 1
    return re.compile(f'^{out}$')


def test_matcher(files, read):
    if POLICY not in files:
        raise Failure(f'{POLICY} is missing, so test files cannot be identified')
    try:
        projects = json.loads(read(POLICY))['testProjects']
        rules = [
            ([glob_pattern(item) for item in project['include']], [glob_pattern(item) for item in project.get('exclude', [])])
            for project in projects
        ]
    except (ValueError, KeyError, TypeError) as error:
        raise Failure(f'{POLICY} has no usable testProjects: {error}')
    if not any(include for include, _ in rules):
        raise Failure(f'{POLICY} lists no test project includes')

    def is_test(path):
        return any(
            any(pattern.match(path) for pattern in include) and not any(pattern.match(path) for pattern in exclude)
            for include, exclude in rules
        )

    return is_test


def is_source(path):
    return SOURCE.match(path) is not None and TEST_NAME.search(path) is None


def diff_args(base, snapshot):
    if snapshot.kind == 'revision':
        return [base, snapshot.revision]
    if snapshot.kind == 'index':
        return ['--cached', base]
    return [base]


def changed_paths(base, snapshot):
    fields = split_z(git('diff', '--name-status', '-M', '-z', *diff_args(base, snapshot)))
    paths = []
    index = 0
    while index < len(fields):
        status = fields[index]
        if status[0] in 'RC':
            paths += [fields[index + 1], fields[index + 2]]
            index += 3
        else:
            paths.append(fields[index + 1])
            index += 2
    if snapshot.kind == 'worktree':
        paths += split_z(git('ls-files', '--others', '--exclude-standard', '-z'))
    return paths


def block_ranges(text):
    ranges = []
    lines = text.splitlines()
    number = 0
    while number < len(lines):
        match = EXPORT_LIST.search(lines[number])
        if match and '}' not in lines[number][match.end():]:
            start = number + 1
            end = start
            while end < len(lines) and '}' not in lines[end]:
                end += 1
            ranges.append((start, min(end + 1, len(lines))))
            number = end
        number += 1
    return ranges


def touches(changed, ranges):
    return any(start <= line <= end for line in changed for start, end in ranges)


def exports_changed(base, snapshot, source, base_files):
    old_text = BLOBS.read(f'{base}:{source}') if source in base_files else ''
    new_text = snapshot.read(source) if source in snapshot.files else ''
    if source not in base_files or source not in snapshot.files:
        return any(EXPORT_START.match(line) for line in (old_text or new_text).splitlines())
    diff = git('diff', '-U0', *diff_args(base, snapshot), '--', source)
    old_lines, new_lines = set(), set()
    for line in diff.splitlines():
        hunk = HUNK.match(line)
        if hunk:
            old_start, old_count = int(hunk.group(1)), int(hunk.group(2) or 1)
            new_start, new_count = int(hunk.group(3)), int(hunk.group(4) or 1)
            old_lines.update(range(old_start, old_start + old_count))
            new_lines.update(range(new_start, new_start + new_count))
        elif line[:1] in '+-' and not line.startswith(('+++', '---')) and EXPORT_START.match(line[1:]):
            return True
    return touches(old_lines, block_ranges(old_text)) or touches(new_lines, block_ranges(new_text))


def package_name(snapshot, source):
    manifest = '/'.join(source.split('/')[:2]) + '/package.json'
    if manifest not in snapshot.files:
        return None
    try:
        name = json.loads(snapshot.read(manifest))['name']
    except (ValueError, KeyError, TypeError) as error:
        raise Failure(f'{manifest} has no usable package name: {error}')
    if not isinstance(name, str) or not name:
        raise Failure(f'{manifest} has no usable package name')
    return name


def candidates(base):
    root, extension = posixpath.splitext(base)
    found = {base}
    if extension in ('.js', '.mjs', '.cjs'):
        found.update(root + other for other in EXTENSIONS)
    if not extension:
        found.update(base + other for other in EXTENSIONS)
        found.update(posixpath.join(base, 'index' + other) for other in EXTENSIONS)
    return found


def references(test, text):
    directory = posixpath.dirname(test)
    found = set()
    for pattern in SPECIFIERS:
        for match in pattern.finditer(text):
            specifier = match.group(1)
            if specifier.startswith('./') or specifier.startswith('../'):
                found |= candidates(posixpath.normpath(posixpath.join(directory, specifier)))
    return found


def same_stem(source, test):
    if source.split('/')[:2] != test.split('/')[:2]:
        return False
    stem = posixpath.splitext(posixpath.basename(source))[0]
    return STEM.sub('', posixpath.basename(test)) == stem


def required_tests(base, snapshot):
    sources = sorted({path for path in changed_paths(base, snapshot) if is_source(path)})
    if not sources:
        return sources, {}
    base_files = set(split_z(git('ls-tree', '-r', '--name-only', '-z', base)))
    exported = set()
    for source in sources:
        if exports_changed(base, snapshot, source, base_files):
            name = package_name(snapshot, source) if source in snapshot.files else None
            if name is None and source in base_files:
                manifest = '/'.join(source.split('/')[:2]) + '/package.json'
                if manifest in base_files:
                    try:
                        name = json.loads(BLOBS.read(f'{base}:{manifest}'))['name']
                    except (ValueError, KeyError, TypeError) as error:
                        raise Failure(f'{manifest} has no usable package name: {error}')
                    if not isinstance(name, str) or not name:
                        raise Failure(f'{manifest} has no usable package name')
            if name:
                exported.add(name)
    required = {}
    for test in sorted(path for path in snapshot.files if snapshot.required_tests(path)):
        text = snapshot.read(test)
        reasons = set()
        refs = references(test, text)
        for source in sources:
            if source in refs:
                reasons.add(f'imports {source}')
            if same_stem(source, test):
                reasons.add(f'same name as {source}')
        for match in WHOLE_MOCK.finditer(text):
            if match.group(1) in exported:
                reasons.add(f'mocks {match.group(1)} whose exports changed')
        if reasons:
            required[test] = sorted(reasons)
    return sources, required


def declared_tests(message):
    declared = []
    for line in message.splitlines():
        match = DECLARATION.match(line)
        if match:
            value = match.group(1)
            declared.append(value[2:] if value.startswith('./') else value)
    return declared


def check(base, snapshot, message):
    sources, required = required_tests(base, snapshot)
    declared = declared_tests(message)
    paths = [line for line in declared if line != 'none']
    problems = []
    unknown = [path for path in paths if path not in snapshot.files or not snapshot.tests(path)]
    if unknown:
        problems.append(('L0_RELATED_TESTS_UNKNOWN', 'declared on a Layer-0-tests line but not a collected test file in this commit', {path: [] for path in unknown}))
    if 'none' in declared and paths:
        problems.append(('L0_RELATED_TESTS_UNKNOWN', 'Layer-0-tests: none mixed with test paths', {}))
    if sources and not declared:
        problems.append(('L0_RELATED_TESTS_UNDECLARED', 'product source changed but the message has no Layer-0-tests line (write Layer-0-tests: none when nothing below is listed)', required))
    missing = {test: reasons for test, reasons in required.items() if test not in paths}
    if sources and declared and missing:
        problems.append(('L0_RELATED_TESTS_OMITTED', 'directly related test files missing from the Layer-0-tests lines', missing))
    return problems


def report(problems, label):
    for code, text, items in problems:
        print(f'{code} {label}: {text}', file=sys.stderr)
        for path, reasons in items.items():
            suffix = f'  ({"; ".join(reasons)})' if reasons else ''
            print(f'  {path}{suffix}', file=sys.stderr)
    if problems:
        print('Run these files in Layer 0 and declare each on its own "Layer-0-tests: <path>" line in the commit message', file=sys.stderr)
        print('(.agents/instructions/test-trigger-timing.md; docs/lessons.md#layer0-related-tests).', file=sys.stderr)


def head_base():
    if git('rev-parse', '--verify', '-q', 'HEAD', check=False).strip():
        return 'HEAD'
    branch = git('symbolic-ref', '-q', 'HEAD').strip()
    if git('show-ref', '--verify', branch, check=False).strip():
        raise Failure(f'HEAD names {branch}, which exists but cannot be read')
    return EMPTY_TREE


def read_message(path):
    try:
        with open(path, encoding='utf-8') as handle:
            return ''.join(line for line in handle if not line.startswith('#'))
    except (OSError, UnicodeDecodeError) as error:
        raise Failure(f'cannot read the commit message {path}: {error}')


def commit_msg(message_file):
    if git('rev-parse', '-q', '--verify', 'MERGE_HEAD', check=False).strip():
        print('L0_RELATED_TESTS_SKIPPED_MERGE commit: merge commits are not checked (test-trigger-timing.md)', file=sys.stderr)
        return 0
    message = read_message(message_file)
    base = head_base()
    problems = check(base, Snapshot('index', base=base), message)
    report(problems, 'commit')
    if problems:
        return 1
    print('L0_RELATED_TESTS_OK', file=sys.stderr)
    return 0


def check_commit(commit, message=None):
    parents = git('rev-list', '--parents', '-n', '1', commit).split()[1:]
    if len(parents) > 1:
        print(f'L0_RELATED_TESTS_SKIPPED_MERGE {commit[:12]}: merge commits are not checked (test-trigger-timing.md)', file=sys.stderr)
        return []
    if message is None:
        message = git('show', '-s', '--format=%B', commit)
    base = parents[0] if parents else EMPTY_TREE
    return check(base, Snapshot('revision', commit, base=base), message)


def new_commits(local, remote):
    exclude = ['^' + remote, '--not', '--remotes'] if remote != ZERO else ['--not', '--remotes']
    return git('rev-list', local, *exclude).split()


def pre_push(stdin):
    failed = False
    for line in stdin.read().splitlines():
        fields = line.split()
        if len(fields) != 4:
            raise Failure(f'unexpected pre-push input line: {line!r}')
        if fields[1] == ZERO:
            continue
        local, remote = fields[1], fields[3]
        for commit in new_commits(local, remote):
            problems = check_commit(commit)
            report(problems, commit[:12])
            failed = failed or bool(problems)
    return 1 if failed else 0


def derive(arguments):
    if arguments == ['--staged']:
        base = head_base()
        snapshot = Snapshot('index', base=base)
    elif len(arguments) == 1:
        parents = git('rev-list', '--parents', '-n', '1', arguments[0]).split()[1:]
        if len(parents) > 1:
            raise Failure('derive does not take merge commits')
        base = parents[0] if parents else EMPTY_TREE
        snapshot = Snapshot('revision', arguments[0], base=base)
    elif not arguments:
        base = head_base()
        snapshot = Snapshot('worktree', base=base)
    else:
        raise Failure('usage: derive [--staged | <revision>]')
    sources, required = required_tests(base, snapshot)
    for test, reasons in required.items():
        print(f'{test}\t{"; ".join(reasons)}')
    if sources and not required:
        print('none')
    return 0


def main(argv):
    argv = list(argv)
    if len(argv) == 3 and argv[1] == 'commit-msg' or len(argv) == 4 and argv[1] == 'check-commit':
        argv[-1] = os.path.abspath(argv[-1])
    try:
        status = run(argv)
    except Exception as error:
        print(f'L0_RELATED_TESTS_ERROR unexpected {type(error).__name__}: {error}', file=sys.stderr)
        status = 2
    try:
        closed = BLOBS.close()
    except OSError as error:
        print(f'L0_RELATED_TESTS_ERROR git cat-file --batch did not close: {error}', file=sys.stderr)
        return 2
    if closed != 0:
        print(f'L0_RELATED_TESTS_ERROR git cat-file --batch exited {closed}', file=sys.stderr)
        return 2
    return status


def run(argv):
    try:
        top = git('rev-parse', '--show-toplevel').strip()
        os.chdir(top)
        if len(argv) == 3 and argv[1] == 'commit-msg':
            return commit_msg(argv[2])
        if len(argv) == 2 and argv[1] == 'pre-push':
            return pre_push(sys.stdin)
        if len(argv) >= 2 and argv[1] == 'derive':
            return derive(argv[2:])
        if len(argv) in (3, 4) and argv[1] == 'check-commit':
            message = read_message(argv[3]) if len(argv) == 4 else None
            problems = check_commit(argv[2], message)
            report(problems, argv[2][:12])
            return 1 if problems else 0
    except Failure as error:
        print(f'L0_RELATED_TESTS_ERROR {error}', file=sys.stderr)
        return 2
    print('usage: check-layer0-tests.py commit-msg <file> | pre-push | derive [--staged | <revision>] | check-commit <revision> [<message file>]', file=sys.stderr)
    return 64


if __name__ == '__main__':
    sys.exit(main(sys.argv))
