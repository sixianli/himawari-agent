#!/usr/bin/env python3
import re
import subprocess
import sys

PHRASE = re.compile(r'^\s*(?:[-*]\s*)?(?:not covered by (?:a|any) test|unexplained|没有测试|未覆盖|原因不明)', re.I)
CLAIM = re.compile(r'^Untested-critical-path:(.*)$', re.M)
PROOF = re.compile(r'^(?:Real-env-proof|Waiver):[ \t]*(\S.*)$', re.M)
RESOLVES = re.compile(r'^Resolves-untested:[ \t]*([0-9a-f]+)[ \t]*$', re.M)
MIN_PREFIX = 7


def message_problems(message):
    problems = []
    claims = CLAIM.findall(message)
    if any(not value.strip() for value in claims):
        problems.append(('UNTESTED_CLAIM_EMPTY', 'Untested-critical-path: must say which path is untested'))
    if not claims and any(PHRASE.match(line) for line in message.splitlines()):
        problems.append(('UNTESTED_CLAIM_NOT_STRUCTURED', 'the message says something is not tested or not explained; write it as an "Untested-critical-path: <what>" line so make-packet.py can require proof before a release'))
    return problems


def has_claim(message):
    return any(value.strip() for value in CLAIM.findall(message))


def unresolved(commits):
    resolved = set()
    for sha, message in commits:
        if PROOF.search(message):
            resolved.update(prefix for prefix in RESOLVES.findall(message) if len(prefix) >= MIN_PREFIX)
    result = []
    for sha, message in commits:
        if not has_claim(message) or PROOF.search(message):
            continue
        if any(sha.startswith(prefix) for prefix in resolved):
            continue
        result.append((sha, message))
    return result


def git(repo, *arguments):
    child = subprocess.run(['git', '-C', repo, *arguments], capture_output=True, text=True, check=False)
    if child.returncode != 0:
        raise RuntimeError('git ' + ' '.join(arguments) + ': ' + child.stderr.strip())
    return child.stdout


def commits_between(since, head, repo='.'):
    shas = git(repo, 'rev-list', '--no-merges', since + '..' + head).split()
    return [(sha, git(repo, 'show', '-s', '--format=%B', sha)) for sha in shas]


def check_range(since, head, repo='.'):
    missing = unresolved(commits_between(since, head, repo))
    if not missing:
        return None
    lines = [sha[:12] + ' ' + CLAIM.search(message).group(1).strip() for sha, message in missing]
    return 'these commits say a critical path is untested and carry no proof; run it in a real environment and add "Real-env-proof: <evidence>" in a later commit with "Resolves-untested: <sha>", or add "Waiver: <who approved, where>": ' + '; '.join(lines)


def commit_msg(path):
    with open(path, encoding='utf-8') as handle:
        message = ''.join(line for line in handle if not line.startswith('#'))
    problems = message_problems(message)
    for code, text in problems:
        print(code + ' commit: ' + text, file=sys.stderr)
    return 1 if problems else 0


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'commit-msg':
        sys.exit(commit_msg(sys.argv[2]))
    print('usage: untested-claims.py commit-msg <file>', file=sys.stderr)
    sys.exit(2)
