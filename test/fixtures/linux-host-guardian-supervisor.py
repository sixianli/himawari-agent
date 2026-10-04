import ctypes
import json
import os
from pathlib import Path
import select
import signal
import sys
import time

node, host_script, guardian_url, group_url, ready_path, timeout = sys.argv[1:]
PR_SET_CHILD_SUBREAPER = 36
if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    raise RuntimeError("GUARDIAN_FIXTURE_SUBREAPER_UNAVAILABLE")
child = os.fork()
if child == 0:
    os.setsid()
    os.execv(node, [node, host_script, guardian_url, group_url, ready_path, timeout])

reaped = False
ready = None
deadline = time.monotonic() + 20


def identity(pid):
    try:
        value = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return None
    fields = value[value.rfind(")") + 2:].split()
    return {"state": fields[0], "group": int(fields[2]), "session": int(fields[3]), "token": fields[19]}


def reap_members():
    if ready:
        for key in ["guardianIdentity", "proxyIdentity"]:
            try:
                os.waitpid(ready[key]["processId"], os.WNOHANG)
            except ChildProcessError:
                pass


try:
    while time.monotonic() < deadline:
        if ready is None and Path(ready_path).is_file():
            ready = json.loads(Path(ready_path).read_text())
            if ready["hostIdentity"]["processId"] != child:
                raise RuntimeError("GUARDIAN_FIXTURE_HOST_CHANGED")
        reap_members()
        available, _, _ = select.select([sys.stdin], [], [], 0.01)
        if not available:
            continue
        command = sys.stdin.readline().strip()
        if command == "kill":
            os.kill(child, signal.SIGKILL)
        elif command == "reap":
            os.waitpid(child, 0)
            reaped = True
        elif command in ["stop", ""]:
            break
        else:
            raise RuntimeError("GUARDIAN_FIXTURE_COMMAND_INVALID")
    else:
        raise RuntimeError("GUARDIAN_FIXTURE_TIME_LIMIT")
finally:
    if not reaped:
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(child, 0)
    if ready is None and Path(ready_path).is_file():
        ready = json.loads(Path(ready_path).read_text())
    if ready:
        for key in ["guardianIdentity", "proxyIdentity"]:
            item = ready[key]
            current = identity(item["processId"])
            if current and current["token"] == item["startToken"]:
                if current["group"] != child or current["session"] != child:
                    raise RuntimeError("GUARDIAN_FIXTURE_MEMBER_CHANGED")
                try:
                    os.kill(item["processId"], signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                os.waitpid(item["processId"], 0)
            except ChildProcessError:
                pass
