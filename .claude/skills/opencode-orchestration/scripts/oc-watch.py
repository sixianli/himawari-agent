"""Follow an opencode run and print one line per event a reviewer acts on.

Meant as the command of a background monitor: every printed line is a
notification. Its first line names the watched file and where reading starts;
a prefix or stop file in a missing directory ends it with WATCH_ERROR. A
re-armed watch continues from the byte where the last one stopped, kept in
<prefix>.watchpos. It prints what the agent says (with CHECKPOINT and QUESTION lines
on their own), every file it edits or writes, failed tool calls, error events,
lines matching the default or --signal patterns, one STALL after a quiet period,
and ends with STOP_FILE or EXITED.
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

DEFAULT_SIGNALS = [
    r"(?<!passed )\b[1-9]\d* failed\b",
    r"\bfailed[ :=]+[1-9]\d*",
    r"\btimed ?out\b|\btime out\b|\btimeout\b(?![\"']?\s*[:=,)}]|\s+(?:-{1,2}[a-z]|\d))",
    r"\bout of memory\b",
    r"\boom_kill=[1-9]\d*",
]
EDIT_TOOLS = {"edit", "write", "patch", "apply_patch", "multiedit"}
MARKERS = ("CHECKPOINT:", "QUESTION:")
ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff"))


def one_line(value, limit):
    return " ".join(str(value).split())[:limit]


def has_visible_text(value):
    return bool(value.translate(ZERO_WIDTH).strip())


def describe(event, signals):
    lines = []
    if event.get("type") == "error":
        error = event.get("error") or {}
        lines.append(f"RUN_ERROR: {error.get('type')} {one_line(error.get('message'), 300)}")
        return lines
    part = event.get("part") or {}
    if part.get("type") == "text":
        body = part.get("text") or ""
        rest = []
        for line in body.splitlines():
            stripped = line.strip()
            if stripped.startswith(MARKERS):
                lines.append(one_line(stripped, 400))
            elif has_visible_text(stripped):
                rest.append(stripped)
        if rest:
            lines.insert(0, f"SAYS: {one_line(' '.join(rest), 400)}")
        return lines
    if part.get("type") != "tool":
        return lines
    state = part.get("state") or {}
    name = part.get("tool")
    data = state.get("input") or {}
    if name in EDIT_TOOLS:
        lines.append(f"EDIT: {name} {data.get('path') or data.get('filePath') or ''}")
    if state.get("status") == "error":
        lines.append(f"TOOL_ERROR: {name} {one_line(state.get('error'), 300)}")
    output = str(state.get("output") or "")
    command = re.sub(r"^(?:\s*cd\s+\S+\s*&&\s*)+", "", data.get("command") or "")
    source = one_line(command or data.get("path") or data.get("filePath") or "", 160)
    counts = {}
    for pattern in signals:
        for match in pattern.finditer(output):
            found = one_line(match.group(0), 200)
            counts[found] = counts.get(found, 0) + 1
    if counts:
        found = "; ".join(text if count == 1 else f"{text} x{count}" for text, count in counts.items())
        lines.append(f"SIGNAL: {found} ({name}: {source})")
    return lines


def mtime(path):
    try:
        return os.stat(path).st_mtime
    except FileNotFoundError:
        return None


def start_position(log, saved, from_start):
    if from_start or not log.exists():
        return 0, "from start" if log.exists() else "not written yet"
    size = log.stat().st_size
    try:
        position = int(saved.read_text().strip())
    except (FileNotFoundError, ValueError):
        return size, f"from byte {size}"
    if position > size:
        return 0, f"resuming from start (log shorter than saved byte {position})"
    return position, f"resuming at byte {position} of {size}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prefix", help="run prefix given to oc-launch.sh")
    parser.add_argument("--stop-file", action="append", default=[], help="stop file that ends the watch when written")
    parser.add_argument("--signal", action="append", default=[], help="extra regular expression to report from tool output")
    parser.add_argument("--quiet-seconds", type=float, default=600)
    parser.add_argument("--poll", type=float, default=2)
    parser.add_argument("--from-start", action="store_true", help="also report events written before the watch started")
    args = parser.parse_args()

    log = Path(args.prefix + ".jsonl")
    rc_file = Path(args.prefix + ".rc")
    saved = Path(args.prefix + ".watchpos")
    for path in [log, *map(Path, args.stop_file)]:
        if not path.parent.is_dir():
            print(f"WATCH_ERROR: no directory {path.parent}", flush=True)
            return 2
    signals = [re.compile(p, re.IGNORECASE) for p in DEFAULT_SIGNALS] + [re.compile(p) for p in args.signal]
    stop_marks = {path: mtime(path) for path in args.stop_file}
    position, where = start_position(log, saved, args.from_start)
    print(f"WATCHING {log} {where}", flush=True)
    saved.write_text(f"{position}\n")
    last_event = time.time()
    stalled = False

    while True:
        if log.exists():
            with log.open("rb") as handle:
                handle.seek(position)
                chunk = handle.read()
            end = chunk.rfind(b"\n") + 1
            if end:
                position += end
                saved.write_text(f"{position}\n")
            for line in chunk[:end].decode(errors="replace").split("\n"):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                last_event = time.time()
                stalled = False
                for out in describe(event, signals):
                    print(out, flush=True)
        for path, before in stop_marks.items():
            now = mtime(path)
            if now is not None and now != before:
                print(f"STOP_FILE {path}", flush=True)
                return 0
        if rc_file.exists():
            unfinished = " UNFINISHED" if Path(f"{args.prefix}.unfinished").exists() else ""
            print(f"EXITED rc={rc_file.read_text().strip()}{unfinished}", flush=True)
            return 0
        if not stalled and time.time() - last_event >= args.quiet_seconds:
            print(f"STALL: no event for {int(time.time() - last_event)}s", flush=True)
            stalled = True
        time.sleep(args.poll)


if __name__ == "__main__":
    sys.exit(main())
