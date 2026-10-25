#!/usr/bin/env python3
import argparse
import os
import sys
import tarfile
import zipfile

FORBIDDEN = {"node_modules", ".git"}
REASONS = "EVIDENCE-REASONS.txt"
TAR_SUFFIXES = (".tar", ".tar.gz", ".tgz", ".tar.xz", ".tar.bz2", ".tar.zst")


def arrived_after(path, since):
    return os.lstat(path).st_ctime >= since


def reasons_in(directory):
    path = os.path.join(directory, REASONS)
    found = {}
    if os.path.isfile(path):
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                name, sep, reason = line.partition(":")
                if sep and reason.strip():
                    found[name.strip()] = reason.strip()
    return found


def archive_members(path):
    if path.endswith(".zip"):
        with zipfile.ZipFile(path) as archive:
            return archive.namelist()
    with tarfile.open(path, "r:*") as archive:
        return [member.name for member in archive]


def holds_forbidden(names):
    for name in names:
        if FORBIDDEN.intersection(name.replace("\\", "/").split("/")):
            return name
    return None


def check(root, since, max_file_bytes, out):
    violations = 0
    files = 0
    for directory, subdirs, names in os.walk(root):
        reasons = reasons_in(directory) if REASONS in names else {}
        for sub in list(subdirs):
            full = os.path.join(directory, sub)
            if sub in FORBIDDEN:
                subdirs.remove(sub)
                if sub not in reasons and any(arrived_after(p, since) for p in walk_paths(full)):
                    out.append(f"EVIDENCE_VIOLATION dependency-or-git-directory {full} (or add '{sub}: <reason>' to {REASONS} beside it)")
                    violations += 1
        for name in names:
            full = os.path.join(directory, name)
            if os.path.islink(full) or not arrived_after(full, since):
                continue
            files += 1
            size = os.path.getsize(full)
            if name in reasons:
                continue
            if size > max_file_bytes:
                out.append(f"EVIDENCE_VIOLATION large-file-without-reason {full} bytes={size} (add '{name}: <reason>' to {REASONS} beside it)")
                violations += 1
            if name.endswith(TAR_SUFFIXES) or name.endswith(".zip"):
                try:
                    member = holds_forbidden(archive_members(full))
                except (tarfile.TarError, zipfile.BadZipFile, OSError, EOFError) as error:
                    out.append(f"EVIDENCE_VIOLATION unreadable-archive {full} {type(error).__name__}")
                    violations += 1
                    continue
                if member:
                    out.append(f"EVIDENCE_VIOLATION archive-holds-dependency-or-git {full} member={member} (or add '{name}: <reason>' to {REASONS} beside it)")
                    violations += 1
    return violations, files


def walk_paths(top):
    yield top
    for directory, subdirs, names in os.walk(top):
        for name in subdirs + names:
            yield os.path.join(directory, name)


def main():
    parser = argparse.ArgumentParser(description="Fail when new evidence holds dependency or git copies, unexplained large files, or archives of them.")
    parser.add_argument("--since", type=float, default=0, help="only entries whose ctime is at or after this epoch second")
    parser.add_argument("--max-file-bytes", type=int, default=50 * 1024 * 1024)
    parser.add_argument("roots", nargs="+")
    args = parser.parse_args()
    out = []
    total_violations = 0
    missing = False
    for root in args.roots:
        if not os.path.isdir(root):
            out.append(f"EVIDENCE_ERROR missing-root {root}")
            missing = True
            continue
        violations, files = check(root, args.since, args.max_file_bytes, out)
        total_violations += violations
        if not violations:
            out.append(f"EVIDENCE_OK {root} new_files={files}")
    print("\n".join(out))
    if missing:
        return 2
    return 1 if total_violations else 0


if __name__ == "__main__":
    sys.exit(main())
