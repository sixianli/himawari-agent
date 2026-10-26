import json
import os
import signal
import sys


def reply(request_id, status, result):
    try:
        sys.stdout.write(json.dumps({"id": request_id, "status": status, "result": result}, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        pass


metadata = {
    "sysExecutable": sys.executable,
    "sysVersion": sys.version,
    "isolated": sys.flags.isolated,
    "pidfdOpen": callable(getattr(os, "pidfd_open", None)),
    "pidfdSendSignal": callable(getattr(signal, "pidfd_send_signal", None)),
}
if not (
    sys.executable == "/usr/bin/python3"
    and sys.flags.isolated == 1
    and sys.version_info >= (3, 9)
    and sys.platform == "linux"
    and metadata["pidfdOpen"]
    and metadata["pidfdSendSignal"]
):
    reply(None, "error", {"errorCode": "PIDFD_PREREQUISITE_FAILED", "metadata": metadata})
    sys.exit(1)

import select
import hashlib
import stat
import time


class ControllerError(Exception):
    def __init__(self, code, details=None):
        super().__init__(code)
        self.details = details


def error_result(error):
    return {
        "errorCode": str(error) if isinstance(error, ControllerError) else type(error).__name__,
        "errno": getattr(error, "errno", None),
        "details": getattr(error, "details", None),
    }


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def exited(fd):
    return bool(select.select([fd], [], [], 0)[0])


def proc_stat(pid):
    with open(f"/proc/{pid}/stat", "rb") as source:
        value = source.read(16384)
    tail = value[value.rfind(b")") + 2 :].split()
    if not value.startswith(f"{pid} (".encode()) or len(tail) < 20 or not tail[19].isdigit():
        raise ControllerError("PROCESS_STAT_INVALID")
    return {
        "state": tail[0].decode("ascii"),
        "parentPid": int(tail[1]),
        "processGroupId": int(tail[2]),
        "sessionId": int(tail[3]),
        "startTime": tail[19].decode("ascii"),
    }


def snapshot(pid):
    first = proc_stat(pid)
    with open(f"/proc/{pid}/status", "rb") as source:
        uid_lines = [line for line in source.read(65536).splitlines() if line.startswith(b"Uid:")]
    if len(uid_lines) != 1:
        raise ControllerError("PROCESS_UID_INVALID")
    uids = [int(value) for value in uid_lines[0].split()[1:]]
    if len(uids) != 4 or any(value != os.getuid() for value in uids):
        raise ControllerError("PROCESS_UID_MISMATCH")
    executable = os.readlink(f"/proc/{pid}/exe")
    if not os.path.isabs(executable) or os.path.realpath(executable) != executable:
        raise ControllerError("PROCESS_EXECUTABLE_INVALID")
    executable_stat = os.stat(f"/proc/{pid}/exe")
    with open(f"/proc/{pid}/cmdline", "rb") as source:
        encoded_args = source.read(131073)
    if len(encoded_args) > 131072 or not encoded_args or not encoded_args.endswith(b"\0"):
        raise ControllerError("PROCESS_ARGS_INVALID")
    args = [value.decode("utf-8") for value in encoded_args[:-1].split(b"\0")]
    last = proc_stat(pid)
    if any(first[key] != last[key] for key in ("startTime", "parentPid", "processGroupId", "sessionId")):
        raise ControllerError("PROCESS_IDENTITY_CHANGED_DURING_READ")
    return {
        "pid": pid,
        "uid": uids[0],
        "uids": uids,
        "executable": executable,
        "executableDevice": executable_stat.st_dev,
        "executableInode": executable_stat.st_ino,
        "args": args,
        **last,
    }


def same_identity(first, second, allow_reparent=False):
    keys = ("pid", "uid", "uids", "startTime", "executable", "executableDevice", "executableInode", "args", "processGroupId", "sessionId")
    if not allow_reparent:
        keys += ("parentPid",)
    if any(first[key] != second[key] for key in keys):
        raise ControllerError("PROCESS_IDENTITY_CHANGED")


def marker_check(expected, evidence):
    evidence.update({"passed": False, "path": expected.get("path"), "checkedAtMs": time.time_ns() / 1000000, "checkedAtMonotonicNs": str(time.monotonic_ns())})
    fd = None
    try:
        filename, content = expected.get("path"), expected.get("expectedContent")
        metadata_keys = ("device", "inode", "size", "mtimeNs", "ctimeNs")
        if not (
            isinstance(filename, str)
            and os.path.isabs(filename)
            and os.path.realpath(filename) == filename
            and os.path.basename(filename) == "r2-l6-marker"
            and isinstance(content, str)
            and 1 <= len(content.encode("utf-8")) <= 4096
            and isinstance(expected.get("sha256"), str)
            and len(expected["sha256"]) == 64
            and all(value in "0123456789abcdef" for value in expected["sha256"])
            and all(isinstance(expected.get(key), str) and 1 <= len(expected[key]) <= 64 and all(value in "0123456789" for value in expected[key]) for key in metadata_keys)
        ):
            raise ControllerError("MARKER_ARGUMENT_INVALID")
        before = os.lstat(filename)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid():
            raise ControllerError("MARKER_FILE_UNSAFE")
        fd = os.open(filename, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        first = os.fstat(fd)
        if not stat.S_ISREG(first.st_mode) or first.st_uid != os.getuid() or (before.st_dev, before.st_ino) != (first.st_dev, first.st_ino):
            raise ControllerError("MARKER_FILE_IDENTITY_CHANGED")
        actual = os.read(fd, 4097)
        last, named = os.fstat(fd), os.lstat(filename)
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        evidence.update({key: str(getattr(last, field)) for key, field in zip(metadata_keys, fields)})
        evidence.update({"uid": last.st_uid, "sha256": hashlib.sha256(actual).hexdigest(), "contentMatches": actual == content.encode("utf-8")})
        if any(getattr(first, field) != getattr(last, field) or getattr(last, field) != getattr(named, field) for field in fields) or not stat.S_ISREG(named.st_mode) or named.st_uid != os.getuid():
            raise ControllerError("MARKER_CHANGED_DURING_READ")
        if not evidence["contentMatches"] or any(evidence[key] != expected[key] for key in metadata_keys + ("sha256",)):
            raise ControllerError("MARKER_CONTENT_OR_IDENTITY_CHANGED")
        evidence["passed"] = True
        return evidence
    except BaseException as error:
        evidence["error"] = error_result(error)
        raise
    finally:
        if fd is not None:
            os.close(fd)
        evidence.update({"checkedAtMs": time.time_ns() / 1000000, "checkedAtMonotonicNs": str(time.monotonic_ns())})


class Controller:
    roles = ("oldAgent", "oldWorker", "originalHost", "newAgent", "newWorker")

    def __init__(self):
        if os.getuid() == 0 or os.geteuid() != os.getuid():
            raise ControllerError("CONTROLLER_ORDINARY_UID_REQUIRED")
        own_fd = os.pidfd_open(os.getpid(), 0)
        try:
            signal.pidfd_send_signal(own_fd, 0, None, 0)
        finally:
            os.close(own_fd)
        parent = snapshot(os.getppid())
        parent_fd = os.pidfd_open(parent["pid"], 0)
        try:
            same_identity(parent, snapshot(parent["pid"]))
            if exited(parent_fd):
                raise ControllerError("PROBE_PARENT_EXITED")
        except BaseException:
            os.close(parent_fd)
            raise
        self.parent = parent
        self.parent_fd = parent_fd
        self.handles = {}
        self.original_marker = None
        self.old_pair_killed = False
        self.cleaning = False
        self.cleanup_requested = False
        self.cleanup_deadline = None
        self.fault = {"events": []}

    def parent_present(self):
        if not self.cleaning and exited(self.parent_fd):
            raise ControllerError("PROBE_PARENT_EXITED")

    def handle(self, role):
        if role not in self.handles:
            raise ControllerError("PROCESS_ROLE_NOT_REGISTERED")
        return self.handles[role]

    def checked(self, role):
        handle = self.handle(role)
        if exited(handle["fd"]):
            raise ControllerError("REGISTERED_PROCESS_EXITED")
        current = snapshot(handle["identity"]["pid"])
        worker = self.handles.get("oldWorker")
        allow_reparent = role == "originalHost" and worker is not None and exited(worker["fd"])
        same_identity(handle["identity"], current, allow_reparent)
        if exited(handle["fd"]):
            raise ControllerError("REGISTERED_PROCESS_EXITED")
        return current

    def register(self, request):
        role, expected = request.get("role"), request.get("identity")
        if role not in self.roles or role in self.handles or not isinstance(expected, dict):
            raise ControllerError("REGISTER_ARGUMENT_INVALID")
        if not (
            integer(expected.get("pid"), 2, 4194304)
            and expected["pid"] not in (os.getpid(), self.parent["pid"])
            and expected.get("uid") == os.getuid()
            and isinstance(expected.get("startTime"), str)
            and expected["startTime"].isdigit()
            and 1 <= len(expected["startTime"]) <= 64
            and integer(expected.get("parentPid"), 2, 4194304)
            and isinstance(expected.get("executable"), str)
            and expected["executable"] == self.parent["executable"]
            and isinstance(expected.get("args"), list)
            and 1 <= len(expected["args"]) <= 256
            and all(isinstance(value, str) and "\0" not in value for value in expected["args"])
        ):
            raise ControllerError("REGISTER_IDENTITY_INVALID")
        if role == "originalHost":
            if expected["parentPid"] != self.checked("oldWorker")["pid"]:
                raise ControllerError("REGISTER_HOST_PARENT_MISMATCH")
        elif expected["parentPid"] != self.parent["pid"]:
            raise ControllerError("REGISTER_SERVICE_PARENT_MISMATCH")
        if role in ("newAgent", "newWorker") and not self.old_pair_killed:
            raise ControllerError("REGISTER_NEW_PAIR_PHASE_INVALID")
        first = snapshot(expected["pid"])
        if first["executableDevice"] != self.parent["executableDevice"] or first["executableInode"] != self.parent["executableInode"]:
            raise ControllerError("REGISTER_NODE_IDENTITY_MISMATCH")
        if role == "originalHost" and (first["processGroupId"] != first["pid"] or first["sessionId"] != first["pid"]):
            raise ControllerError("REGISTER_HOST_GROUP_MISMATCH")
        required = ("pid", "uid", "startTime", "executable", "args", "parentPid")
        optional = tuple(key for key in ("processGroupId", "sessionId", "executableDevice", "executableInode") if key in expected)
        if any(expected[key] != first[key] for key in required + optional):
            raise ControllerError("REGISTER_EXPECTED_IDENTITY_MISMATCH")
        fd = os.pidfd_open(first["pid"], 0)
        try:
            if exited(fd):
                raise ControllerError("REGISTER_PROCESS_EXITED")
            last = snapshot(first["pid"])
            same_identity(first, last)
            if any(expected[key] != last[key] for key in required + optional) or exited(fd):
                raise ControllerError("REGISTER_EXPECTED_IDENTITY_MISMATCH")
        except BaseException:
            os.close(fd)
            raise
        self.handles[role] = {"fd": fd, "identity": last, "frozen": False}
        return {"role": role, "identity": last}

    def task_tree(self, identity, evidence):
        evidence.update({"passed": False, "entries": [], "checkedAtMs": time.time_ns() / 1000000, "checkedAtMonotonicNs": str(time.monotonic_ns())})
        try:
            host = self.checked("originalHost")
            pid = identity["pid"]
            seen = set()
            for _ in range(128):
                if pid <= 1 or pid in seen:
                    raise ControllerError("ORIGINAL_TASK_TREE_MISMATCH")
                seen.add(pid)
                current = proc_stat(pid)
                if os.stat(f"/proc/{pid}").st_uid != os.getuid():
                    raise ControllerError("ORIGINAL_TASK_TREE_UID_MISMATCH")
                evidence["entries"].append({"pid": pid, **current})
                if pid == host["pid"]:
                    if current["startTime"] != host["startTime"]:
                        raise ControllerError("ORIGINAL_TASK_HOST_IDENTITY_CHANGED")
                    break
                pid = current["parentPid"]
            else:
                raise ControllerError("ORIGINAL_TASK_TREE_TOO_DEEP")
            for entry in evidence["entries"]:
                current = proc_stat(entry["pid"])
                if any(current[key] != entry[key] for key in ("startTime", "parentPid", "processGroupId", "sessionId")):
                    raise ControllerError("ORIGINAL_TASK_TREE_CHANGED")
            same_identity(host, self.checked("originalHost"))
            evidence["passed"] = True
            return evidence
        except BaseException as error:
            evidence["error"] = error_result(error)
            raise
        finally:
            evidence.update({"checkedAtMs": time.time_ns() / 1000000, "checkedAtMonotonicNs": str(time.monotonic_ns())})

    def register_original_task(self, request):
        expected, marker = request.get("identity"), request.get("marker")
        evidence = {"processes": {}, "taskTree": {}, "marker": {}}
        self.fault = {"stage": "registerOriginalTask", "preflight": evidence, "events": []}
        if self.old_pair_killed or "originalBash" in self.handles or not isinstance(expected, dict) or not isinstance(marker, dict):
            raise ControllerError("REGISTER_ORIGINAL_TASK_ARGUMENT_INVALID")
        if not (
            integer(expected.get("pid"), 2, 4194304)
            and expected["pid"] not in (os.getpid(), self.parent["pid"])
            and expected.get("uid") == os.getuid()
            and isinstance(expected.get("startTime"), str)
            and 1 <= len(expected["startTime"]) <= 64
            and all(value in "0123456789" for value in expected["startTime"])
            and integer(expected.get("parentPid"), 2, 4194304)
            and isinstance(expected.get("executable"), str)
            and os.path.isabs(expected["executable"])
            and os.path.basename(expected["executable"]) == "bash"
            and isinstance(expected.get("args"), list)
            and 1 <= len(expected["args"]) <= 256
            and all(isinstance(value, str) and "\0" not in value for value in expected["args"])
        ):
            raise ControllerError("REGISTER_ORIGINAL_TASK_IDENTITY_INVALID")
        process_evidence = {"passed": False, "expectedIdentity": expected, "checkedAtMs": time.time_ns() / 1000000, "checkedAtMonotonicNs": str(time.monotonic_ns())}
        evidence["processes"]["originalBash"] = process_evidence
        first = snapshot(expected["pid"])
        process_evidence["identity"] = first
        required = ("pid", "uid", "startTime", "executable", "args", "parentPid")
        optional = tuple(key for key in ("processGroupId", "sessionId", "executableDevice", "executableInode") if key in expected)
        if any(expected[key] != first[key] for key in required + optional) or first["state"] in ("T", "t", "Z", "X"):
            raise ControllerError("REGISTER_ORIGINAL_TASK_IDENTITY_MISMATCH")
        fd = os.pidfd_open(first["pid"], 0)
        try:
            process_evidence["pidfdExited"] = exited(fd)
            if process_evidence["pidfdExited"]:
                raise ControllerError("REGISTER_ORIGINAL_TASK_EXITED")
            self.task_tree(first, evidence["taskTree"])
            marker_check(marker, evidence["marker"])
            if not any(marker["expectedContent"] in value for value in first["args"]):
                raise ControllerError("REGISTER_ORIGINAL_TASK_MARKER_COMMAND_MISMATCH")
            last = snapshot(first["pid"])
            process_evidence.update({"identity": last, "pidfdExited": exited(fd)})
            same_identity(first, last)
            if any(expected[key] != last[key] for key in required + optional) or process_evidence["pidfdExited"] or last["state"] in ("T", "t", "Z", "X"):
                raise ControllerError("REGISTER_ORIGINAL_TASK_IDENTITY_MISMATCH")
            process_evidence["passed"] = True
        except BaseException as error:
            process_evidence["error"] = error_result(error)
            os.close(fd)
            raise
        finally:
            process_evidence.update({"checkedAtMs": time.time_ns() / 1000000, "checkedAtMonotonicNs": str(time.monotonic_ns())})
        self.handles["originalBash"] = {"fd": fd, "identity": last, "frozen": False}
        self.original_marker = dict(marker)
        return {"role": "originalBash", "identity": last, "taskTree": evidence["taskTree"], "marker": evidence["marker"]}

    def preflight_process(self, role, evidence):
        evidence.update({"passed": False, "pidfdExited": exited(self.handle(role)["fd"]), "expectedIdentity": self.handle(role)["identity"], "checkedAtMs": time.time_ns() / 1000000, "checkedAtMonotonicNs": str(time.monotonic_ns())})
        try:
            current = self.checked(role)
            evidence["identity"] = current
            if self.handle(role)["frozen"] or current["state"] in ("T", "t", "Z", "X"):
                raise ControllerError("FREEZE_PROCESS_STATE_INVALID")
            evidence["passed"] = True
            return current
        except BaseException as error:
            evidence["error"] = error_result(error)
            raise
        finally:
            evidence.update({"checkedAtMs": time.time_ns() / 1000000, "checkedAtMonotonicNs": str(time.monotonic_ns())})

    def send(self, role, sig):
        current = self.checked(role)
        signal.pidfd_send_signal(self.handle(role)["fd"], sig, None, 0)
        return current

    def wait_exit(self, role, deadline):
        fd = self.handle(role)["fd"]
        poller = select.poll()
        poller.register(fd, select.POLLIN | select.POLLHUP)
        while not exited(fd):
            self.parent_present()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            poller.poll(max(1, min(20, int(remaining * 1000))))
        return True

    def freeze(self, request):
        observed_at_ms = request.get("observedAtMs")
        deadline_at_ms = request.get("deadlineAtMs")
        if not integer(observed_at_ms, 1, 9999999999999) or not integer(deadline_at_ms, 1, 9999999999999):
            raise ControllerError("FREEZE_EVIDENCE_TIME_INVALID")
        if self.old_pair_killed:
            raise ControllerError("FREEZE_PHASE_INVALID")
        preflight = {"measurementPoint": "before-first-SIGSTOP", "processes": {}, "taskTree": {}, "marker": {}, "observationAgeIsGate": False}
        self.fault = {"stage": "preflight", "preflight": preflight, "events": []}
        self.checked("oldAgent")
        if self.original_marker is None:
            raise ControllerError("FREEZE_ORIGINAL_TASK_NOT_REGISTERED")
        for role in ("oldWorker", "originalHost", "originalBash"):
            self.preflight_process(role, preflight["processes"].setdefault(role, {}))
        self.task_tree(preflight["processes"]["originalBash"]["identity"], preflight["taskTree"])
        marker_check(self.original_marker, preflight["marker"])
        started = time.monotonic_ns()
        first_signal_ms = time.time_ns() / 1000000
        remaining_before_signal_ms = deadline_at_ms - first_signal_ms
        preflight.update({"checkedAtMs": first_signal_ms, "checkedAtMonotonicNs": str(started), "observationAgeMs": first_signal_ms - observed_at_ms, "remainingDeadlineMs": remaining_before_signal_ms, "remainingDeadlineBeforeFirstSignalMs": remaining_before_signal_ms})
        if remaining_before_signal_ms < 1500:
            raise ControllerError("FREEZE_EVIDENCE_GATE_FAILED", preflight)
        events = []
        self.fault = {"stage": "freeze", "startedAtMonotonicNs": str(started), "preflight": preflight, "events": events}
        for role in ("oldWorker", "originalHost"):
            self.handle(role)["frozen"] = True
            event = {"role": role, "signal": "SIGSTOP", "delivered": False, "requestedAtMonotonicNs": str(time.monotonic_ns())}
            events.append(event)
            signal.pidfd_send_signal(self.handle(role)["fd"], signal.SIGSTOP, None, 0)
            event.update({"delivered": True, "atMonotonicNs": str(time.monotonic_ns())})
        while True:
            self.parent_present()
            identities = {role: self.checked(role) for role in ("oldWorker", "originalHost")}
            confirmed_at = time.monotonic_ns()
            elapsed_ms = (confirmed_at - started) / 1000000
            self.fault.update({"identities": identities, "elapsedMs": elapsed_ms})
            if elapsed_ms > 250:
                raise ControllerError("FREEZE_250MS_GATE_FAILED", self.fault)
            if all(identity["state"] == "T" for identity in identities.values()):
                both_stopped_ms = time.time_ns() / 1000000
                remaining_at_confirmation_ms = deadline_at_ms - both_stopped_ms
                self.fault.update({"checkedAtMs": both_stopped_ms, "remainingDeadlineMs": remaining_at_confirmation_ms, "remainingDeadlineBeforeFirstSignalMs": remaining_before_signal_ms})
                if remaining_at_confirmation_ms < 1500:
                    raise ControllerError("FREEZE_CONFIRMATION_DEADLINE_GATE_FAILED", self.fault)
                return {"events": events, "identities": identities, "elapsedMs": elapsed_ms, "bothStoppedAtMonotonicNs": str(confirmed_at), "checkedAtMs": both_stopped_ms, "observationAgeMs": first_signal_ms - observed_at_ms, "observationAgeIsGate": False, "remainingDeadlineMs": remaining_at_confirmation_ms, "remainingDeadlineBeforeFirstSignalMs": remaining_before_signal_ms, "observationAgeAtConfirmationMs": both_stopped_ms - observed_at_ms, "preflight": preflight}
            select.select([self.parent_fd], [], [], 0.001)

    def kill_old_pair(self):
        if self.old_pair_killed or not all(self.handle(role)["frozen"] for role in ("oldWorker", "originalHost")):
            raise ControllerError("KILL_OLD_PAIR_PHASE_INVALID")
        if any(self.checked(role)["state"] != "T" for role in ("oldWorker", "originalHost")):
            raise ControllerError("KILL_OLD_PAIR_NOT_FROZEN")
        events = []
        self.fault = {"stage": "killOldPair", "events": events}
        for role in ("oldWorker", "oldAgent"):
            identity = self.send(role, signal.SIGKILL)
            signalled_at = time.monotonic_ns()
            event = {"role": role, "signal": "SIGKILL", "identity": identity, "atMonotonicNs": str(signalled_at), "exited": False}
            events.append(event)
            if not self.wait_exit(role, time.monotonic() + 5):
                raise ControllerError("KILL_OLD_PAIR_EXIT_TIMEOUT", self.fault)
            event.update({"exited": True, "exitedAtMonotonicNs": str(time.monotonic_ns())})
        self.old_pair_killed = True
        return {"events": events, "hostIdentity": self.checked("originalHost")}

    def continue_host(self):
        if not self.old_pair_killed or not self.handle("originalHost")["frozen"]:
            raise ControllerError("CONTINUE_HOST_PHASE_INVALID")
        if self.checked("originalHost")["state"] != "T":
            raise ControllerError("CONTINUE_HOST_NOT_FROZEN")
        identity = self.send("originalHost", signal.SIGCONT)
        self.handle("originalHost")["frozen"] = False
        return {"role": "originalHost", "signal": "SIGCONT", "identity": identity, "atMonotonicNs": str(time.monotonic_ns())}

    def cleanup(self, timeout_ms=30000):
        self.cleaning = True
        self.cleanup_requested = True
        started = time.monotonic()
        requested_deadline = started + timeout_ms / 1000
        self.cleanup_deadline = requested_deadline if self.cleanup_deadline is None else min(self.cleanup_deadline, requested_deadline)
        deadline = self.cleanup_deadline
        events, errors = [], []
        for role in ("originalHost", "oldWorker"):
            handle = self.handles.get(role)
            if handle is not None and handle["frozen"] and not exited(handle["fd"]):
                try:
                    self.send(role, signal.SIGCONT)
                    handle["frozen"] = False
                    events.append({"role": role, "signal": "SIGCONT"})
                except Exception as error:
                    if not exited(handle["fd"]):
                        errors.append({"role": role, "stage": "resume", **error_result(error)})
        for role in ("newAgent", "oldAgent", "newWorker", "oldWorker", "originalHost"):
            handle = self.handles.get(role)
            if handle is None or exited(handle["fd"]):
                continue
            try:
                self.send(role, signal.SIGTERM)
                events.append({"role": role, "signal": "SIGTERM"})
                if not self.wait_exit(role, min(time.monotonic() + 5, deadline)):
                    self.send(role, signal.SIGKILL)
                    events.append({"role": role, "signal": "SIGKILL"})
                    self.wait_exit(role, min(time.monotonic() + 5, deadline))
            except Exception as error:
                if not exited(handle["fd"]):
                    errors.append({"role": role, "stage": "terminate", **error_result(error)})
        for role, handle in self.handles.items():
            if role != "originalBash" and not exited(handle["fd"]):
                try:
                    self.send(role, signal.SIGKILL)
                    events.append({"role": role, "signal": "SIGKILL"})
                except Exception as error:
                    if not exited(handle["fd"]):
                        errors.append({"role": role, "stage": "kill", **error_result(error)})
        for role in self.handles:
            self.wait_exit(role, deadline)
        remaining = [{"role": role, "pid": handle["identity"]["pid"], "startTime": handle["identity"]["startTime"], "frozen": handle["frozen"]} for role, handle in self.handles.items() if not exited(handle["fd"])]
        self.cleaning = False
        return {"events": events, "errors": errors, "processesRemaining": remaining, "elapsedMs": (time.monotonic() - started) * 1000}

    def dispatch(self, request):
        self.parent_present()
        command = request.get("command")
        if self.cleanup_requested and command not in ("metadata", "inspect", "waitExit", "cleanup", "close"):
            raise ControllerError("CONTROLLER_CLEANUP_ALREADY_REQUESTED")
        if command == "metadata":
            return {**metadata, "uid": os.getuid(), "parentIdentity": self.parent}
        if command == "register":
            return self.register(request)
        if command == "registerOriginalTask":
            return self.register_original_task(request)
        if command == "freeze":
            return self.freeze(request)
        if command == "killOldPair":
            return self.kill_old_pair()
        if command == "continueHost":
            return self.continue_host()
        if command == "inspect":
            role = request.get("role")
            handle = self.handle(role)
            return {"role": role, "exited": exited(handle["fd"]), "identity": handle["identity"] if exited(handle["fd"]) else self.checked(role)}
        if command == "waitExit":
            role, timeout_ms = request.get("role"), request.get("timeoutMs")
            if not integer(timeout_ms, 1, 30000):
                raise ControllerError("WAIT_EXIT_TIMEOUT_INVALID")
            started = time.monotonic()
            return {"role": role, "exited": self.wait_exit(role, started + timeout_ms / 1000), "elapsedMs": (time.monotonic() - started) * 1000}
        if command in ("cleanup", "close"):
            timeout_ms = request.get("timeoutMs", 30000)
            if not integer(timeout_ms, 1, 30000):
                raise ControllerError("CLEANUP_TIMEOUT_INVALID")
            return self.cleanup(timeout_ms)
        raise ControllerError("CONTROLLER_COMMAND_INVALID")

    def requests(self):
        buffer = b""
        while True:
            ready = select.select([sys.stdin.fileno(), self.parent_fd], [], [])[0]
            if self.parent_fd in ready:
                raise ControllerError("PROBE_PARENT_EXITED")
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                if buffer:
                    raise ControllerError("CONTROLLER_INCOMPLETE_REQUEST")
                raise ControllerError("CONTROLLER_INPUT_ENDED")
            buffer += data
            if len(buffer) > 131072:
                raise ControllerError("CONTROLLER_REQUEST_TOO_LARGE")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                request = json.loads(line)
                request_id = request.get("id") if isinstance(request, dict) else None
                if not isinstance(request, dict) or not (type(request_id) is int or isinstance(request_id, str) and 1 <= len(request_id) <= 200):
                    raise ControllerError("CONTROLLER_REQUEST_INVALID")
                yield request

    def close_fds(self):
        for handle in self.handles.values():
            os.close(handle["fd"])
        os.close(self.parent_fd)


controller = None
request_id = None
exit_code = 1
failure_seen = False


def interrupted(signum, frame):
    if controller is None or not controller.cleaning:
        raise ControllerError("CONTROLLER_INTERRUPTED")


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    controller = Controller()
    reply(None, "ok", {"event": "ready", **metadata, "uid": os.getuid(), "parentIdentity": controller.parent})
    for request in controller.requests():
        request_id = request["id"]
        result = controller.dispatch(request)
        status = "error" if result.get("processesRemaining") or result.get("errors") else "ok"
        failure_seen = failure_seen or status == "error"
        reply(request_id, status, result)
        if request["command"] == "close":
            exit_code = 0 if status == "ok" and not failure_seen else 1
            break
        request_id = None
except BaseException as error:
    reply(request_id, "error", {**error_result(error), "metadata": metadata, "fault": controller.fault if controller is not None else None})
finally:
    if controller is not None:
        try:
            result = controller.cleanup()
            status = "error" if result["processesRemaining"] or result["errors"] else "ok"
            reply(None, status, {"event": "finalCleanup", **result})
            if status == "error":
                exit_code = 1
        except BaseException as error:
            reply(None, "error", {"event": "finalCleanup", **error_result(error)})
            exit_code = 1
        finally:
            controller.close_fds()
sys.exit(exit_code)
