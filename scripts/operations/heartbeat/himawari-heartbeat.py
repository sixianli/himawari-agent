#!/usr/bin/python3
import argparse
import datetime
import http.client
import json
import os
import re
import sys
import urllib.error
import urllib.request

DEFAULT_URL_FILE = "/etc/himawari-heartbeat/healthcheck-url"
DEFAULT_READY_URL = "http://127.0.0.1:8400/health/ready"
PING_URL = re.compile(r"https://hc-ping\.com/[A-Za-z0-9_-]{1,64}(?:/[A-Za-z0-9_-]{1,64})?")
MAXIMUM_URL_FILE_BYTES = 512
RESERVED_SUFFIXES = {"fail", "start", "log"}
STREAK_FILE = "streak.json"
OUTAGE_FILE = "outage.json"


class UrlInvalid(Exception):
    pass


def read_ping_url(path):
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAXIMUM_URL_FILE_BYTES + 1)
    except OSError as error:
        raise UrlInvalid("HEARTBEAT_URL_UNREADABLE") from error
    if len(raw) > MAXIMUM_URL_FILE_BYTES:
        raise UrlInvalid("HEARTBEAT_URL_INVALID")
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as error:
        raise UrlInvalid("HEARTBEAT_URL_INVALID") from error
    value = text[:-1] if text.endswith("\n") else text
    if not PING_URL.fullmatch(value) or value.rsplit("/", 1)[1] in RESERVED_SUFFIXES:
        raise UrlInvalid("HEARTBEAT_URL_INVALID")
    return value


def probe_ready(opener, ready_url, timeout):
    try:
        with opener(urllib.request.Request(ready_url, method="GET"), timeout=timeout) as response:
            if response.status == 200:
                return None
            return "ready answered HTTP " + str(response.status)
    except urllib.error.HTTPError as error:
        return "ready answered HTTP " + str(error.code)
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError):
        return "ready did not answer"


def send(opener, url, body, timeout):
    request = urllib.request.Request(url, data=body, method="POST" if body is not None else "GET")
    with opener(request, timeout=timeout) as response:
        response.read(64)


def iso_now(clock):
    moment = clock().astimezone(datetime.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (moment.microsecond // 1000)


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def write_json(path, value, atomic):
    text = json.dumps(value, sort_keys=True) + "\n"
    if atomic:
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, path)
        return
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def record_outcome(state_dir, ready, alert_after, clock):
    streak_path = os.path.join(state_dir, STREAK_FILE)
    outage_path = os.path.join(state_dir, OUTAGE_FILE)
    streak = read_json(streak_path)
    failures = streak.get("failures") if isinstance(streak.get("failures"), int) else 0
    since = streak.get("since") if isinstance(streak.get("since"), str) else None
    down = read_json(outage_path).get("state") == "down"
    now = iso_now(clock)
    event = None
    if ready:
        if down:
            event = {"schemaVersion": 1, "state": "up", "failedChecks": max(failures, 1), "since": since or now, "at": now}
        failures, since = 0, None
    else:
        failures, since = failures + 1, since or now
        if failures >= alert_after and not down:
            event = {"schemaVersion": 1, "state": "down", "failedChecks": failures, "since": since, "at": now}
    write_json(streak_path, {"failures": failures, "since": since}, atomic=True)
    if event is not None:
        write_json(outage_path, event, atomic=False)
        return event["state"]
    return None


def positive_integer(text):
    value = int(text)
    if value < 1 or value > 10000:
        raise argparse.ArgumentTypeError("must be between 1 and 10000")
    return value


def main(argv, opener=urllib.request.urlopen, output=sys.stdout, errors=sys.stderr, clock=lambda: datetime.datetime.now(datetime.timezone.utc)):
    parser = argparse.ArgumentParser()
    parser.add_argument("--url-file", default=DEFAULT_URL_FILE)
    parser.add_argument("--ready-url", default=DEFAULT_READY_URL)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--check-url-file", action="store_true")
    parser.add_argument("--state-dir")
    parser.add_argument("--alert-after", type=positive_integer, default=5)
    arguments = parser.parse_args(argv)
    try:
        url = read_ping_url(arguments.url_file)
    except UrlInvalid as error:
        print(str(error), file=errors)
        return 2
    if arguments.check_url_file:
        print("HEARTBEAT_URL_OK", file=output)
        return 0
    problem = probe_ready(opener, arguments.ready_url, arguments.timeout)
    state_failed = False
    if arguments.state_dir:
        try:
            transition = record_outcome(arguments.state_dir, problem is None, arguments.alert_after, clock)
            if transition is not None:
                print("HEARTBEAT_OUTAGE " + transition, file=output)
        except OSError:
            print("HEARTBEAT_STATE_FAILED", file=errors)
            state_failed = True
    try:
        if problem is None:
            send(opener, url, None, arguments.timeout)
            print("HEARTBEAT ok", file=output)
        else:
            send(opener, url + "/log", problem.encode("ascii"), arguments.timeout)
            print("HEARTBEAT skipped " + problem, file=output)
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError):
        print("HEARTBEAT_PING_FAILED", file=errors)
        return 1
    return 1 if state_failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
