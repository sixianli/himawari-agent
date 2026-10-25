#!/usr/bin/env python3
import codecs
import re
import subprocess
import sys

HEADER = re.compile(r'diff --git (?:"a/((?:[^"\\]|\\.)*)"|a/(\S+))')
PATH_LINE = re.compile(r"^(diff --git|index|---|\+\+\+) ")


def unquote(path):
    return codecs.escape_decode(path.encode("ascii"))[0].decode("utf-8")


def body_without_paths(chunk):
    lines = chunk.split("\n")
    first_hunk = next((i for i, line in enumerate(lines) if line.startswith("@@")), len(lines))
    header = [line for line in lines[:first_hunk] if not PATH_LINE.match(line)]
    return "\n".join(header + lines[first_hunk:]).strip()


def split_files(diff_text):
    files = {}
    for chunk in re.split(r"(?=^diff --git )", diff_text, flags=re.MULTILINE):
        match = HEADER.match(chunk)
        if match:
            name = unquote(match.group(1)) if match.group(1) is not None else match.group(2)
            files[name] = body_without_paths(chunk)
    return files


def main():
    if len(sys.argv) < 3:
        print("usage: snapshot-matches-commit.py <commit> <snapshot.patch>... [-- <pathspec>...]", file=sys.stderr)
        return 2
    args = sys.argv[1:]
    pathspec = []
    if "--" in args:
        split = args.index("--")
        args, pathspec = args[:split], args[split + 1 :]
    commit, patches = args[0], args[1:]
    shown = subprocess.run(
        ["git", "show", "--format=", commit, "--", *pathspec],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    committed = split_files(shown)
    problems = 0
    for patch in patches:
        with open(patch, encoding="utf-8") as handle:
            snapshot = split_files(handle.read())
        for name, body in sorted(committed.items()):
            if name not in snapshot:
                status = "MISSING (untracked new file? compare it separately)"
                problems += 1
            elif snapshot[name] != body:
                status = "DIFFERENT"
                problems += 1
            else:
                status = "same"
            print(f"{patch}: {name}: {status}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
