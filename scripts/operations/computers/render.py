import json
import os
import sys


def main():
    settings_path, release, digest, group_id, config_out, unit_out = sys.argv[1:7]
    settings = json.load(open(settings_path))
    paths = settings["paths"]
    computer = settings["computer"]
    if not release.startswith("/") or os.path.normpath(release) != release:
        raise SystemExit("COMPUTERS_RELEASE_INVALID " + release)
    if not any(release.startswith(root + "/") for root in paths["runtimeRoots"]):
        raise SystemExit("COMPUTERS_RELEASE_OUTSIDE_RUNTIME_ROOTS " + release)
    if not digest.startswith("sha256:") or len(digest) != 71:
        raise SystemExit("COMPUTERS_IMAGE_DIGEST_INVALID " + digest)
    config = {
        "schemaVersion": "user-computers.v1",
        "docker": {"executable": paths["docker"], "host": None},
        "runtime": computer["runtime"],
        "image": {"reference": None, "digest": digest},
        "stateDirectory": paths["stateDirectory"],
        "socket": {"path": paths["socket"], "groupId": int(group_id)},
        "disk": computer["disk"],
        "resources": computer["resources"],
        "admission": computer["admission"],
        "idle": computer["idle"],
        "commandTimeoutMs": computer["commandTimeoutMs"],
        "stopGraceSeconds": computer["stopGraceSeconds"],
        "beforeStop": computer["beforeStop"],
        "hostPaths": {"runtimeRoots": paths["runtimeRoots"], "seedRoots": paths["seedRoots"]},
    }
    host_main = release + "/lib/himawari-agent/node_modules/@himawari-agent/runtime-sandbox/dist/user-computer/host-main.js"
    unit = "\n".join([
        "[Unit]",
        "Description=Himawari per-user computers",
        "After=docker.service network.target",
        "Requires=docker.service",
        "",
        "[Service]",
        "Type=exec",
        "User=root",
        "Environment=PATH=" + os.path.dirname(paths["node"]) + ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "Environment=LANG=C.UTF-8",
        "ExecStart=" + paths["node"] + " --no-global-search-paths " + host_main + " --config " + paths["config"],
        "Restart=on-failure",
        "RestartSec=5s",
        "KillSignal=SIGTERM",
        "TimeoutStopSec=60s",
        "StandardOutput=journal",
        "StandardError=journal",
        "SyslogIdentifier=himawari-computers",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
    ])
    with open(config_out, "w") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")
    with open(unit_out, "w") as handle:
        handle.write(unit)
    print(host_main)


main()
