"""Create deterministic archives and extract only prevalidated ordinary files."""

import argparse
import gzip
import json
import sys
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile


MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024 + 256 * 1024 * 1024


def safe_name(name):
    parts = PurePosixPath(name).parts
    if not name or "\\" in name or "\x00" in name or name.startswith("/") or any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError(f"ARTIFACT_UNSAFE_PATH:{name}")
    if not parts:
        raise ValueError("ARTIFACT_EMPTY_PATH")
    return parts


def create(source, archive):
    source = source.resolve(strict=True)
    with open(archive, "xb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as zipped:
            with tarfile.open(mode="w|", fileobj=zipped, format=tarfile.PAX_FORMAT) as tar:
                for filename in sorted(source.rglob("*")):
                    if filename.is_symlink():
                        raise ValueError("ARTIFACT_LINK_FORBIDDEN")
                    if filename.is_dir():
                        continue
                    if filename.name == ".DS_Store":
                        continue
                    if not filename.is_file():
                        raise ValueError("ARTIFACT_SPECIAL_FILE_FORBIDDEN")
                    name = filename.relative_to(source).as_posix()
                    safe_name(name)
                    info = tar.gettarinfo(str(filename), arcname=name)
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ""
                    with filename.open("rb") as content:
                        tar.addfile(info, content)


def preflight(tar):
    members = tar.getmembers()
    names = set()
    total = 0
    for member in members:
        safe_name(member.name)
        if not member.isfile() or member.issym() or member.islnk():
            raise ValueError("ARTIFACT_NON_REGULAR_MEMBER")
        if member.name in names:
            raise ValueError("ARTIFACT_DUPLICATE_MEMBER")
        if member.mode & ~0o777 or member.mode & 0o022:
            raise ValueError("ARTIFACT_UNSAFE_MODE")
        names.add(member.name)
        total += member.size
        if member.size < 0 or total > 2 * 1024 * 1024 * 1024:
            raise ValueError("ARTIFACT_SIZE_LIMIT")
    if not members:
        raise ValueError("ARTIFACT_EMPTY_ARCHIVE")
    for name in names:
        if any(str(parent) in names for parent in PurePosixPath(name).parents if str(parent) != "."):
            raise ValueError("ARTIFACT_FILE_DIRECTORY_COLLISION")
    return members


def stream(archive):
    with tarfile.open(archive, "r:gz") as tar:
        for member in preflight(tar):
            header = json.dumps({"name": member.name, "size": member.size}, ensure_ascii=True).encode("utf8") + b"\n"
            sys.stdout.buffer.write(header)
            with tar.extractfile(member) as content:
                shutil.copyfileobj(content, sys.stdout.buffer)
        sys.stdout.buffer.flush()


def make_directory(directory, exist_ok=False, cache=None):
    if exist_ok and cache is not None and directory in cache:
        return
    try:
        directory.mkdir()
    except FileNotFoundError:
        make_directory(directory.parent, exist_ok=True, cache=cache)
        return make_directory(directory, exist_ok=exist_ok, cache=cache)
    except FileExistsError:
        if not exist_ok or not directory.is_dir():
            raise
    else:
        os.chmod(directory, 0o755)
    if cache is not None:
        cache.add(directory)


def extract(archive, destination):
    if destination.exists():
        raise ValueError("ARTIFACT_EXTRACTION_TARGET_EXISTS")
    temporary_parent = destination.parent
    while not temporary_parent.is_dir():
        parent = temporary_parent.parent
        if parent == temporary_parent:
            raise FileNotFoundError(temporary_parent)
        temporary_parent = parent
    with gzip.open(archive, "rb") as zipped, tempfile.TemporaryFile(dir=temporary_parent) as unpacked:
        total = 0
        while chunk := zipped.read(min(1024 * 1024, MAX_EXTRACT_BYTES - total + 1)):
            total += len(chunk)
            if total > MAX_EXTRACT_BYTES:
                raise ValueError("ARTIFACT_SIZE_LIMIT")
            unpacked.write(chunk)
        unpacked.seek(0)
        with tarfile.open(fileobj=unpacked, mode="r:") as tar:
            members = preflight(tar)
            directories = set()
            make_directory(destination, cache=directories)
            try:
                for member in members:
                    target = destination.joinpath(*safe_name(member.name))
                    make_directory(target.parent, exist_ok=True, cache=directories)
                    with tar.extractfile(member) as content, target.open("xb") as output:
                        shutil.copyfileobj(content, output)
                    os.chmod(target, member.mode)
            except BaseException:
                shutil.rmtree(destination)
                raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["create", "extract", "stream"])
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, nargs="?")
    args = parser.parse_args()
    if args.operation == "stream":
        if args.destination is not None:
            parser.error("stream does not take a destination")
        stream(args.source)
        return
    if args.destination is None:
        parser.error("destination required")
    if args.operation == "create":
        create(args.source, args.destination)
    else:
        extract(args.source, args.destination)


if __name__ == "__main__":
    main()
