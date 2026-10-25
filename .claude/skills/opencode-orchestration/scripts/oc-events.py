"""Summarize an opencode `run --format json` event stream for review."""

import argparse
import json
import sys
import time
from pathlib import Path


def load(path):
    events = []
    bad = 0
    for line in Path(path).read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            bad += 1
    return events, bad


def tool_calls(events):
    calls = []
    for event in events:
        if event.get("type") != "tool_use":
            continue
        part = event.get("part", {})
        state = part.get("state", {})
        metadata = state.get("metadata", {}).get("metadata", {})
        calls.append(
            {
                "time": event.get("timestamp"),
                "tool": part.get("tool"),
                "status": state.get("status"),
                "input": state.get("input", {}),
                "exit": metadata.get("exit"),
                "error": state.get("error"),
            }
        )
    return calls


def summary(events, bad):
    sessions = sorted({e["sessionID"] for e in events if e.get("sessionID")})
    errors = [e.get("error", {}) for e in events if e.get("type") == "error"]
    texts = [e["part"].get("text", "") for e in events if e.get("type") == "text"]
    cost = 0.0
    tokens = {"input": 0, "output": 0, "reasoning": 0, "cacheRead": 0}
    for event in events:
        if event.get("type") != "step_finish":
            continue
        part = event.get("part", {})
        cost += part.get("cost") or 0
        used = part.get("tokens") or {}
        tokens["input"] += used.get("input") or 0
        tokens["output"] += used.get("output") or 0
        tokens["reasoning"] += used.get("reasoning") or 0
        tokens["cacheRead"] += (used.get("cache") or {}).get("read") or 0
    calls = tool_calls(events)
    stamps = [e["timestamp"] for e in events if isinstance(e.get("timestamp"), (int, float))]
    return {
        "events": len(events),
        "unparsedLines": bad,
        "sessions": sessions,
        "toolCalls": len(calls),
        "toolCallsByStatus": {
            status: sum(1 for c in calls if c["status"] == status)
            for status in sorted({str(c["status"]) for c in calls})
        },
        "deniedCalls": sum(1 for c in calls if "Permission denied" in str(c["error"])),
        "errors": [{"type": e.get("type"), "message": e.get("message")} for e in errors],
        "costUsd": round(cost, 6),
        "tokens": tokens,
        "firstEventMs": min(stamps) if stamps else None,
        "lastEventMs": max(stamps) if stamps else None,
        "quietSeconds": round(time.time() - max(stamps) / 1000) if stamps else None,
        "lastText": texts[-1][-1500:] if texts else None,
    }


def describe(call):
    data = call["input"]
    target = data.get("command") or data.get("filePath") or data.get("path") or data.get("pattern")
    if target is None:
        target = json.dumps(data, ensure_ascii=False)
    exit_code = "" if call["exit"] is None else f" exit={call['exit']}"
    error = f" error={call['error']}" if call["error"] else ""
    return f"{call['tool']} [{call['status']}{exit_code}] {target}{error}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jsonl", nargs="+")
    parser.add_argument("--calls", action="store_true", help="list every tool call")
    parser.add_argument("--grep", help="list tool calls whose input contains this text")
    args = parser.parse_args()
    events = []
    bad = 0
    for path in args.jsonl:
        loaded, unparsed = load(path)
        events.extend(loaded)
        bad += unparsed
    if args.calls or args.grep:
        for call in tool_calls(events):
            line = describe(call)
            if args.grep is None or args.grep in json.dumps(call["input"], ensure_ascii=False):
                print(line)
        return 0
    result = summary(events, bad)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
