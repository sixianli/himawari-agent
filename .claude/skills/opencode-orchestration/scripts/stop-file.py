#!/usr/bin/env python3
import re
import sys
from pathlib import Path

STOP_FILE = re.compile(r"[^\s`'\"()（）<>\[\]]*stop(?:-[0-9]+)?\.md")
PLACEHOLDER = re.compile(
    r"本节[^\n]{0,40}填写|待填写|待补充|\bTBD\b"
    r"|(?:^[ \t]*(?:[-*+][ \t]+)?|[（(:：][ \t]*)待[补填]"
    r"|待[补填][。.]?[ \t]*[)）]",
    re.MULTILINE,
)


def pick(brief):
    named = []
    for match in STOP_FILE.findall(Path(brief).read_text(encoding="utf-8")):
        if match not in named:
            named.append(match)
    unwritten = [path for path in named if not Path(path).exists()]
    if len(unwritten) != 1:
        print(
            f"STOP_FILE_UNCLEAR: {brief} must name exactly one stop file (a path ending in stop.md or stop-N.md) "
            f"that does not exist yet; unwritten: {unwritten or 'none'}",
            file=sys.stderr,
        )
        return 2
    print(unwritten[0])
    return 0


def finished(path):
    stop = Path(path)
    if not stop.is_file() or stop.stat().st_size == 0:
        return 1
    return 1 if PLACEHOLDER.search(stop.read_text(encoding="utf-8", errors="replace")) else 0


def main(argv):
    if len(argv) == 3 and argv[1] == "pick":
        return pick(argv[2])
    if len(argv) == 3 and argv[1] == "finished":
        return finished(argv[2])
    print("usage: stop-file.py pick <brief> | finished <stop file>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
