#!/usr/bin/python3 -I
import base64
import json
import os
import re
import stat
import sys

SHARE = "@SHARE@"
MAX_FILES = 500
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_DEPTH = 8
REQUEST = re.compile(r"([1-9][0-9]{0,19}-[1-9][0-9]{0,5})/([a-z][a-z0-9-]{0,63})")
SEGMENT = re.compile(r"[A-Za-z0-9._-]{1,128}")


class Refused(Exception):
    pass


def read_tree(directory_fd, prefix, depth, files, total):
    if depth > MAX_DEPTH:
        raise Refused("TOO_DEEP")
    for name in sorted(os.listdir(directory_fd)):
        if not SEGMENT.fullmatch(name) or name in (".", ".."):
            raise Refused("ENTRY_NAME")
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        relative = f"{prefix}{name}"
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                total = read_tree(child, f"{relative}/", depth + 1, files, total)
            finally:
                os.close(child)
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise Refused("ENTRY_TYPE")
        if len(files) >= MAX_FILES:
            raise Refused("TOO_MANY_FILES")
        if info.st_size > MAX_FILE_BYTES:
            raise Refused("FILE_TOO_LARGE")
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        try:
            with os.fdopen(descriptor, "rb", closefd=False) as handle:
                data = handle.read(MAX_FILE_BYTES + 1)
        finally:
            os.close(descriptor)
        if len(data) > MAX_FILE_BYTES:
            raise Refused("FILE_TOO_LARGE")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise Refused("TOTAL_TOO_LARGE")
        files.append({"path": relative, "data": base64.b64encode(data).decode("ascii")})
    return total


def main():
    match = REQUEST.fullmatch(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    if not match:
        raise Refused("REQUEST_INVALID")
    run, name = match.groups()
    try:
        root = os.open(SHARE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        run_fd = os.open(run, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        report = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=run_fd)
    except OSError:
        raise Refused("MISSING") from None
    files = []
    read_tree(report, "", 1, files, 0)
    if not files:
        raise Refused("EMPTY")
    return {"run": run, "name": name, "files": files}


try:
    sys.stdout.write(json.dumps(main(), separators=(",", ":")) + "\n")
except Refused as refusal:
    sys.stdout.write(json.dumps({"error": str(refusal)}) + "\n")
    sys.exit(2)
except OSError:
    sys.stdout.write(json.dumps({"error": "READ_FAILED"}) + "\n")
    sys.exit(3)
