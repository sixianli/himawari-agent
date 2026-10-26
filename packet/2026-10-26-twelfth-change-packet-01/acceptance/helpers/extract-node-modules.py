#!/usr/bin/python3
import hashlib
import json
import os
import pathlib
import sys
import tarfile

if sys.executable != "/usr/bin/python3" or sys.flags.isolated != 1 or len(sys.argv) != 4:
    raise RuntimeError("P5_MODULE_EXTRACT_ARGUMENT_INVALID")
archive_path, record_path, source = map(pathlib.Path, sys.argv[1:])
record = json.loads(record_path.read_text())
if source.resolve() != source or record.get("schemaVersion") != 2 or record.get("scope") != "whole-locked-node-modules" or record.get("sourceHead") != "470b6d30a8664d5f85da2a8b261b59a4f5f18704" or record["lockCheck"]["exitCode"] != 0 or hashlib.sha256((source / "package-lock.json").read_bytes()).hexdigest() != record["packageLockSha256"]:
    raise RuntimeError("P5_MODULE_RECORD_INVALID")
lock = json.loads((source / "package-lock.json").read_text())
dependency_roots = sorted({relative.split("node_modules/", 1)[0] + "node_modules" for relative in lock["packages"] if relative.startswith("node_modules/") or "/node_modules/" in relative})
if not dependency_roots or record.get("dependencyRoots") != dependency_roots:
    raise RuntimeError("P5_MODULE_ROOT_SET_DIFFERENT")
for relative in dependency_roots:
    target = source / relative
    if os.path.lexists(target) or target.parent.resolve() != target.parent or not target.parent.is_dir():
        raise RuntimeError("P5_MODULE_ROOT_NOT_FRESH")
entries = {item["path"]: item for item in record["entries"]}
if any(entries.get(root, {}).get("type") != "directory" for root in dependency_roots):
    raise RuntimeError("P5_MODULE_ROOT_MISSING")
if len(entries) != len(record["entries"]):
    raise RuntimeError("P5_MODULE_DUPLICATE_PATH")
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    names = [member.name.rstrip("/") for member in members]
    if len(set(names)) != len(names) or set(names) != set(entries):
        raise RuntimeError("P5_MODULE_ARCHIVE_SET_DIFFERENT")
    for member, name in zip(members, names):
        parts = pathlib.PurePosixPath(name).parts
        item = entries[name]
        if not parts or not any(name == root or name.startswith(root + "/") for root in dependency_roots) or any(part in {"", ".", ".."} for part in parts) or name.startswith("/") or member.mode & 0o777 != item["mode"]:
            raise RuntimeError("P5_MODULE_ARCHIVE_PATH_OR_MODE_INVALID")
        if not ((item["type"] == "directory" and member.isdir()) or (item["type"] == "file" and member.isfile()) or (item["type"] == "symlink" and member.issym() and member.linkname == item["link"])):
            raise RuntimeError("P5_MODULE_ARCHIVE_TYPE_INVALID")
        if item["type"] == "symlink":
            destination = pathlib.Path(os.path.normpath(str((source / name).parent / item["link"])))
            if pathlib.Path(item["link"]).is_absolute() or (destination != source and source not in destination.parents):
                raise RuntimeError("P5_MODULE_LINK_OUTSIDE_SOURCE")
    for member, name in sorted(zip(members, names), key=lambda pair: (0 if pair[0].isdir() else 1 if pair[0].isfile() else 2, pair[1].count("/") if pair[0].isdir() else 0, pair[0].offset_data)):
        item, target = entries[name], source / name
        if member.isdir():
            target.mkdir(mode=item["mode"])
        elif member.isfile():
            payload = archive.extractfile(member)
            digest = hashlib.sha256()
            count = 0
            with target.open("xb") as output:
                for chunk in iter(lambda: payload.read(1024 * 1024), b""):
                    output.write(chunk)
                    digest.update(chunk)
                    count += len(chunk)
            os.chmod(target, item["mode"])
            if digest.hexdigest() != item["sha256"] or count != item["bytes"]:
                raise RuntimeError("P5_MODULE_FILE_CHANGED")
        else:
            target.symlink_to(item["link"])
print(json.dumps({"passed": True, "scope": record["scope"], "entries": len(entries), "sourceRoot": str(source)}))
