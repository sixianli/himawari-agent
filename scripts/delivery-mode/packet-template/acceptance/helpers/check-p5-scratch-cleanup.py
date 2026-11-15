#!/usr/bin/python3
import argparse
import datetime
import fcntl
import json
import os
import pathlib
import secrets
import select
import signal
import stat
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument("--create-scratch", action="store_true")
mode.add_argument("--run", action="store_true")
mode.add_argument("--scratch")
parser.add_argument("--evidence")
parser.add_argument("--owned-processes", required=True)
parser.add_argument("--controller-pid", type=int)
parser.add_argument("--search-root", action="append", default=[])
parser.add_argument("--report-name", default="cleanup")
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
if sys.executable != "/usr/bin/python3" or sys.flags.isolated != 1 or not hasattr(time, "CLOCK_BOOTTIME"):
    raise RuntimeError("P5_CLEANUP_SYSTEM_PYTHON_INVALID")
registry = pathlib.Path(args.owned_processes)
if not registry.is_absolute() or registry.parent.resolve() != registry.parent:
    raise RuntimeError("P5_PROCESS_RECORD_PATH_INVALID")
hz = os.sysconf("SC_CLK_TCK")
boot_id = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()

def process_identity(pid):
    directory = pathlib.Path("/proc") / str(pid)
    raw = (directory / "stat").read_text()
    left, right = raw.find("("), raw.rfind(")")
    fields = raw[right + 1:].split()
    if left < 1 or right <= left or len(fields) < 20 or int(raw[:left].strip()) != pid:
        raise RuntimeError("P5_PROC_STAT_INVALID")
    return {"pid": pid, "comm": raw[left + 1:right], "state": fields[0], "ppid": int(fields[1]), "startTime": int(fields[19]), "uid": directory.stat().st_uid}

def read_record():
    info = registry.lstat()
    if not stat.S_ISREG(info.st_mode) or registry.resolve() != registry or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RuntimeError("P5_PROCESS_RECORD_UNSAFE")
    record = json.loads(registry.read_text())
    if record.get("schemaVersion") != 2 or record["bootId"] != boot_id or record["clockTicksPerSecond"] != hz or record["ownedUid"] != os.geteuid():
        raise RuntimeError("P5_PROCESS_RECORD_IDENTITY_INVALID")
    return record

def add_identities(items, registration_error=None):
    with registry.with_suffix(".lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = read_record()
        identities = {(item["pid"], item["startTime"]) for item in record["ownedProcesses"]}
        for item in items:
            if (item["pid"], item["startTime"]) not in identities:
                record["ownedProcesses"].append(item)
                identities.add((item["pid"], item["startTime"]))
        if registration_error is not None:
            record["registrationErrors"].append(registration_error)
        temporary = registry.with_name(registry.name + "." + str(os.getpid()) + ".next")
        with temporary.open("x") as output:
            os.chmod(output.name, 0o600)
            json.dump(record, output, indent=2)
            output.write("\n")
        temporary.replace(registry)

def identities_now():
    result = {}
    for directory in pathlib.Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        try:
            item = process_identity(int(directory.name))
            result[item["pid"]] = item
        except (FileNotFoundError, ProcessLookupError, RuntimeError, ValueError):
            pass
    return result

if args.create_scratch:
    evidence = pathlib.Path(args.evidence or "")
    if not evidence.is_absolute() or evidence.resolve() != evidence or not evidence.is_dir() or evidence.stat().st_uid != os.geteuid() or stat.S_IMODE(evidence.stat().st_mode) != 0o700 or registry.parent != evidence or args.controller_pid is None or registry.exists():
        raise RuntimeError("P5_SCRATCH_CREATE_ARGUMENT_INVALID")
    controller = process_identity(args.controller_pid)
    if controller["uid"] != os.geteuid():
        raise RuntimeError("P5_SCRATCH_CONTROLLER_UID_INVALID")
    for attempt in range(32):
        scratch = pathlib.Path("/tmp/h" + "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for index in range(4)))
        before = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
        try:
            scratch.mkdir(mode=0o700)
            break
        except FileExistsError:
            continue
    else:
        raise RuntimeError("P5_SCRATCH_CREATE_FAILED")
    after = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    info = scratch.stat()
    record = {"schemaVersion": 2, "bootId": boot_id, "clockTicksPerSecond": hz, "ownedUid": os.geteuid(), "scratch": str(scratch), "device": info.st_dev, "inode": info.st_ino, "createdBeforeBoottimeNs": before, "createdAfterBoottimeNs": after, "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "controller": controller, "ownedProcesses": [], "registrationErrors": [], "registrationMethod": "payload launch PID/stat22 plus observed descendant identities"}
    with registry.open("x") as output:
        os.chmod(output.name, 0o600)
        json.dump(record, output, indent=2)
        output.write("\n")
    print(str(scratch), flush=True)
    sys.exit(0)

if args.run:
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise RuntimeError("P5_PROCESS_COMMAND_MISSING")
    read_record()
    child = subprocess.Popen(command)
    try:
        root = process_identity(child.pid)
        add_identities([root])
        known = {(root["pid"], root["startTime"])}
        while child.poll() is None:
            current = identities_now()
            tree = {pid for pid, item in current.items() if (pid, item["startTime"]) in known}
            changed = True
            while changed:
                added = {pid for pid, item in current.items() if item["ppid"] in tree} - tree
                changed = bool(added)
                tree.update(added)
            found = [current[pid] for pid in tree if (pid, current[pid]["startTime"]) not in known]
            if found:
                add_identities(found)
                known.update((item["pid"], item["startTime"]) for item in found)
            time.sleep(0.025)
        sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
    except Exception as error:
        add_identities([], {"pid": child.pid, "error": str(error), "at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        child.wait()
        raise

scratch = pathlib.Path(args.scratch)
evidence = pathlib.Path(args.evidence or "")
record = read_record()
info = scratch.lstat()
if str(scratch) != record["scratch"] or len(str(scratch)) != 10 or not str(scratch).startswith("/tmp/h") or scratch.resolve() != scratch or info.st_uid != record["ownedUid"] or stat.S_IMODE(info.st_mode) != 0o700 or info.st_dev != record["device"] or info.st_ino != record["inode"] or evidence.resolve() != evidence or scratch == evidence or scratch in evidence.parents or not args.report_name.replace("-", "").isalnum():
    raise RuntimeError("P5_CLEANUP_SCRATCH_INVALID")
owned = {(item["pid"], item["startTime"]) for item in record["ownedProcesses"]}
owned_pids = {item["pid"] for item in record["ownedProcesses"]} | {record["controller"]["pid"]}
remaining = [{"reason": "payload-registration-incomplete", "error": item} for item in record["registrationErrors"]]
owned_readback = []
for item in record["ownedProcesses"]:
    try:
        current = process_identity(item["pid"])
        exited = current["startTime"] != item["startTime"]
        if not exited:
            descriptor = os.pidfd_open(item["pid"], 0)
            try:
                verified = process_identity(item["pid"])
                if verified["startTime"] != item["startTime"]:
                    exited = True
                else:
                    poller = select.poll()
                    poller.register(descriptor, select.POLLIN)
                    exited = bool(poller.poll(0))
            finally:
                os.close(descriptor)
    except (FileNotFoundError, ProcessLookupError):
        current, exited = None, True
    owned_readback.append({"registered": item, "current": current, "exited": exited})
    if not exited:
        remaining.append({"pid": item["pid"], "startTime": item["startTime"], "reason": "registered-payload-still-present"})
controller_original = record["controller"]
controller, controller_before, controller_exited = None, None, None
controller_exit_evidence, controller_error = "unproven", None
try:
    controller = process_identity(controller_original["pid"])
    controller_before = controller
    if controller["startTime"] != controller_original["startTime"]:
        verified = process_identity(controller_original["pid"])
        controller = verified
        if verified["startTime"] != controller_before["startTime"] or verified["uid"] != controller_before["uid"]:
            raise RuntimeError("P5_CLEANUP_CONTROLLER_IDENTITY_RACE")
        controller_exited, controller_exit_evidence = True, "startTime-reused"
    elif controller["uid"] != controller_original["uid"]:
        raise RuntimeError("P5_CLEANUP_CONTROLLER_UID_CHANGED_WITH_SAME_STARTTIME")
    else:
        descriptor = os.pidfd_open(controller_original["pid"], 0)
        try:
            verified = process_identity(controller_original["pid"])
            controller = verified
            if verified["startTime"] != controller_before["startTime"] or verified["uid"] != controller_before["uid"]:
                raise RuntimeError("P5_CLEANUP_CONTROLLER_IDENTITY_RACE")
            poller = select.poll()
            poller.register(descriptor, select.POLLIN)
            controller_exited = any(flags & select.POLLIN for _, flags in poller.poll(0))
            controller_exit_evidence = "pidfd-readable" if controller_exited else "identity-still-live"
        finally:
            os.close(descriptor)
except (FileNotFoundError, ProcessLookupError):
    controller, controller_exited, controller_exit_evidence = None, True, "pid-absent"
except Exception as error:
    controller_error = str(error)
    remaining.append({"pid": controller_original["pid"], "startTime": controller_original["startTime"], "reason": controller_error})
controller_identity_readback = {"registered": controller_original, "before": controller_before, "current": controller, "exited": controller_exited, "exitEvidence": controller_exit_evidence, "error": controller_error}


def under_scratch(value):
    value = value.removesuffix(" (deleted)")
    return value == str(scratch) or value.startswith(str(scratch) + "/")

def parent_chain(item):
    chain, seen = [], {item["pid"]}
    parent = item["ppid"]
    while parent:
        if parent in seen:
            raise RuntimeError("P5_PROC_PARENT_CYCLE")
        seen.add(parent)
        ancestor = process_identity(parent)
        chain.append(ancestor)
        if parent in owned_pids:
            raise RuntimeError("P5_PROC_PARENT_IS_TASK_PROCESS")
        verified = process_identity(parent)
        if verified["startTime"] != ancestor["startTime"] or verified["ppid"] != ancestor["ppid"]:
            raise RuntimeError("P5_PROC_PARENT_IDENTITY_CHANGED")
        parent = ancestor["ppid"]
    return chain

inspections = []
for directory in pathlib.Path("/proc").iterdir():
    if not directory.name.isdigit() or int(directory.name) == os.getpid():
        continue
    pid = int(directory.name)
    try:
        before = process_identity(pid)
        if before["uid"] != record["ownedUid"]:
            continue
        references = []
        denied = False
        try:
            for name in ["cwd", "exe"]:
                if under_scratch(os.readlink(directory / name)):
                    references.append(name)
            for descriptor in (directory / "fd").iterdir():
                try:
                    if under_scratch(os.readlink(descriptor)):
                        references.append("fd")
                except FileNotFoundError:
                    pass
            for line in (directory / "maps").read_text().splitlines():
                fields = line.split(maxsplit=5)
                if len(fields) == 6 and under_scratch(fields[5].replace("\\040", " ")):
                    references.append("maps")
        except PermissionError:
            denied = True
        after = process_identity(pid)
        if before["startTime"] != after["startTime"] or before["uid"] != after["uid"] or before["ppid"] != after["ppid"]:
            raise RuntimeError("P5_CLEANUP_PROCESS_IDENTITY_CHANGED")
        inspection = {"identity": after, "readable": not denied, "references": sorted(set(references))}
        if denied:
            try:
                earlier = (after["startTime"] + 1) * 1000000000 < record["createdBeforeBoottimeNs"] * hz
                if not earlier:
                    raise RuntimeError("P5_UNREADABLE_PROCESS_NOT_STRICTLY_OLDER")
                inspection["parentChain"] = parent_chain(after)
                final = process_identity(pid)
                if final["startTime"] != after["startTime"] or final["ppid"] != after["ppid"]:
                    raise RuntimeError("P5_UNREADABLE_PROCESS_IDENTITY_CHANGED")
                inspection["strictlyPredatesScratch"] = True
            except (FileNotFoundError, ProcessLookupError):
                try:
                    process_identity(pid)
                    inspection["error"] = "P5_PROC_PARENT_UNAVAILABLE"
                    remaining.append({"pid": pid, "reason": "P5_PROC_PARENT_UNAVAILABLE"})
                except (FileNotFoundError, ProcessLookupError):
                    inspection["exitedDuringParentInspection"] = True
            except Exception as error:
                inspection["error"] = str(error)
                remaining.append({"pid": pid, "reason": str(error)})
        if references:
            remaining.append({"pid": pid, "startTime": after["startTime"], "references": sorted(set(references))})
        inspections.append(inspection)
    except (FileNotFoundError, ProcessLookupError):
        pass
    except Exception as error:
        remaining.append({"pid": pid, "reason": str(error)})
roots = [pathlib.Path(value) for value in args.search_root] + [evidence]
if not args.search_root or any(not root.is_absolute() or root.resolve() != root or not root.is_dir() or root == scratch or scratch in root.parents for root in roots):
    raise RuntimeError("P5_CLEANUP_REFERENCE_ROOT_INVALID")
search = subprocess.run(["rg", "--hidden", "--no-ignore", "--files-with-matches", "--fixed-strings", "--", str(scratch), *map(str, roots)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
(evidence / (args.report_name + "-reference-search.stdout")).write_text(search.stdout)
(evidence / (args.report_name + "-reference-search.stderr")).write_text(search.stderr)
references = search.stdout.splitlines()
external = [name for name in references if not name.startswith(str(evidence) + "/")]
report = {"schemaVersion": 2, "scratch": str(scratch), "ownedUid": record["ownedUid"], "ownedProcessReadback": owned_readback, "controllerReadback": controller, "controllerIdentityReadback": controller_identity_readback, "processInspections": inspections, "processesRemaining": remaining, "recursiveRoots": list(map(str, roots)), "referenceFiles": references, "externalReferences": external, "argvValuesRetained": False, "referenceContentsRetained": False, "currentEvidenceReferenceReason": "Rebuildable inputs and installation live in scratch; retained logs, reports and registry are outside scratch.", "deleteAllowed": not remaining and not external and search.returncode in [0, 1], "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
with (evidence / (args.report_name + "-decision.json")).open("x") as output:
    os.chmod(output.name, 0o600)
    json.dump(report, output, indent=2)
    output.write("\n")
print(json.dumps({"scratch": str(scratch), "deleteAllowed": report["deleteAllowed"], "decision": str(evidence / (args.report_name + "-decision.json"))}), flush=True)
sys.exit(0 if report["deleteAllowed"] else 1)
