#!/usr/bin/python3
import argparse
import re
import subprocess
import sys
from pathlib import Path


class PushSetupError(Exception):
    pass


def serving_cli(unit_path, releases_root):
    try:
        unit = Path(unit_path).read_text(encoding="utf-8")
    except OSError as error:
        raise PushSetupError("OUTAGE_PUSH_RELEASE_UNKNOWN") from error
    match = re.search(re.escape(releases_root.rstrip("/")) + r"/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{7,40}", unit)
    if not match:
        raise PushSetupError("OUTAGE_PUSH_RELEASE_UNKNOWN")
    cli = Path(match.group(0)) / "bin" / "himawari"
    if not cli.is_file():
        raise PushSetupError("OUTAGE_PUSH_CLI_MISSING")
    environment = {}
    for line in unit.splitlines():
        found = re.fullmatch(r"Environment=(PATH|HOME|LANG)=(\S+)", line.strip())
        if found:
            environment[found.group(1)] = found.group(2)
    if "PATH" not in environment:
        raise PushSetupError("OUTAGE_PUSH_ENVIRONMENT_UNKNOWN")
    return str(cli), environment


def main(argv, runner=subprocess.run, errors=sys.stderr):
    parser = argparse.ArgumentParser()
    for name in ("--unit-path", "--releases-root", "--config", "--secret-dir", "--event-file"):
        parser.add_argument(name, required=True)
    arguments = parser.parse_args(argv)
    try:
        cli, environment = serving_cli(arguments.unit_path, arguments.releases_root)
    except PushSetupError as error:
        print(str(error), file=errors)
        return 2
    command = [cli, "push", "outage", "--config", arguments.config, "--secret-dir", arguments.secret_dir, "--event-file", arguments.event_file]
    return runner(command, env=environment, check=False).returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
