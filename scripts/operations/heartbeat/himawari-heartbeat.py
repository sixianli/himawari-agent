#!/usr/bin/python3
import argparse
import http.client
import re
import sys
import urllib.error
import urllib.request

DEFAULT_URL_FILE = "/etc/himawari-heartbeat/healthcheck-url"
DEFAULT_READY_URL = "http://127.0.0.1:8400/health/ready"
PING_URL = re.compile(r"https://hc-ping\.com/[A-Za-z0-9_-]{1,64}(?:/[A-Za-z0-9_-]{1,64})?")
MAXIMUM_URL_FILE_BYTES = 512
RESERVED_SUFFIXES = {"fail", "start", "log"}


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


def main(argv, opener=urllib.request.urlopen, output=sys.stdout, errors=sys.stderr):
    parser = argparse.ArgumentParser()
    parser.add_argument("--url-file", default=DEFAULT_URL_FILE)
    parser.add_argument("--ready-url", default=DEFAULT_READY_URL)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--check-url-file", action="store_true")
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
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
