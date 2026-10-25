#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from check_chinese_reply import english_lines

PLUGIN_ID = "readable-output@skills-dir"
PROMPT = "Answer in English only, in one short sentence: what colour is a clear daytime sky, and why?"


def run_session(model, out_dir):
    with tempfile.TemporaryDirectory() as cwd:
        command = [
            "claude", "-p", PROMPT,
            "--output-format", "stream-json", "--verbose", "--include-hook-events",
            "--model", model, "--max-turns", "4",
        ]
        completed = subprocess.run(
            command, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False, timeout=600
        )
    (out_dir / "stream.jsonl").write_text(completed.stdout, encoding="utf-8")
    (out_dir / "stderr.log").write_text(completed.stderr, encoding="utf-8")
    events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    return completed.returncode, events


def stop_blocks(events):
    blocks = []
    for event in events:
        if event.get("subtype") != "hook_response" or event.get("hook_event") != "Stop" or not event.get("output"):
            continue
        output = json.loads(event["output"])
        if output.get("decision") == "block":
            blocks.append(output)
    return blocks


def assistant_texts(events):
    return [
        block["text"]
        for event in events
        if event.get("type") == "assistant"
        for block in event["message"]["content"]
        if block.get("type") == "text"
    ]


def final_text(events):
    texts = assistant_texts(events)
    return texts[-1] if texts else ""


def checks(returncode, events):
    init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), {})
    plugins = [p.get("source") for p in init.get("plugins", [])]
    blocks = stop_blocks(events)
    result = next((e for e in events if e.get("type") == "result"), {})
    feedback = [
        e for e in events
        if e.get("type") == "user" and "Stop hook feedback" in json.dumps(e["message"], ensure_ascii=False)
    ]
    texts = assistant_texts(events)
    first_english = [line for _, line in english_lines(texts[0])] if texts else []
    text = final_text(events)
    return {
        "claude exited with 0": returncode == 0,
        f"session loaded {PLUGIN_ID}": PLUGIN_ID in plugins,
        "first reply was English": bool(first_english),
        "Stop hook blocked it, quoting that reply": any(
            line[:200] in b.get("reason", "") for b in blocks for line in first_english
        ),
        "Claude received the Stop hook feedback": bool(feedback),
        "session ended successfully": result.get("subtype") == "success",
        "final reply has no English prose": bool(text) and not english_lines(text),
    }


def main():
    parser = argparse.ArgumentParser(description="Run a real Claude Code session and check the readable-output plugin hooks.")
    parser.add_argument("--model", default="haiku")
    parser.add_argument("--out", type=Path, default=SKILL_DIR / "tests" / "verification" / datetime.now().strftime("%Y-%m-%d") / "local" / "plugin-session")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    returncode, events = run_session(args.model, args.out)
    results = checks(returncode, events)
    summary = {"model": args.model, "prompt": PROMPT, "final_reply": final_text(events), "checks": results}
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for name, passed in results.items():
        print(f"{'PASS' if passed else 'FAIL'}  {name}")
    print(f"artifacts: {args.out}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
