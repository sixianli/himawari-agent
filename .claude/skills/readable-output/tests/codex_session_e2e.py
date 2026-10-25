#!/usr/bin/env python3
import argparse
import json
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_DIR / "scripts" / "check_chinese_reply.py"
SKILL_MD = SKILL_DIR / "SKILL.md"
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from check_chinese_reply import english_lines

PROMPT = "Answer in English only, in one short sentence: what colour is a clear daytime sky, and why?"


def toml_string(value):
    return json.dumps(value, ensure_ascii=False)


def hook_arguments(event, state_dir):
    return shlex.join([sys.executable, str(SCRIPT), event, "--state-dir", str(state_dir)])


def hook_config(state_dir):
    start = toml_string(hook_arguments("start", state_dir))
    stop = toml_string(hook_arguments("stop", state_dir))
    return [
        f'hooks.SessionStart=[{{matcher="startup",hooks=[{{type="command",command={start},timeout=20}}]}}]',
        f'hooks.Stop=[{{hooks=[{{type="command",command={stop},timeout=20}}]}}]',
    ]


def stream_events(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def run_session(model, out_dir):
    with tempfile.TemporaryDirectory() as cwd, tempfile.TemporaryDirectory() as state:
        overrides = hook_config(state)
        command = [
            "codex",
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "-s",
            "read-only",
            "-C",
            cwd,
            "--dangerously-bypass-hook-trust",
        ]
        for override in overrides:
            command += ["-c", override]
        if model:
            command += ["--model", model]
        command.append(PROMPT)
        completed = subprocess.run(
            command, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False, timeout=600
        )
    (out_dir / "stream.jsonl").write_text(completed.stdout, encoding="utf-8")
    (out_dir / "stderr.log").write_text(completed.stderr, encoding="utf-8")
    return completed.returncode, stream_events(completed.stdout), overrides


def agent_texts(events):
    return [
        event["item"]["text"]
        for event in events
        if event.get("type") == "item.completed"
        and (event.get("item") or {}).get("type") == "agent_message"
        and event["item"].get("text")
    ]


def command_lines(events):
    return [
        event["item"].get("command") or ""
        for event in events
        if (event.get("item") or {}).get("type") == "command_execution"
    ]


def checks(returncode, events):
    types = [event.get("type") for event in events]
    texts = agent_texts(events)
    first_english = [line for _, line in english_lines(texts[0])] if texts else []
    last = texts[-1] if texts else ""
    names = [str(SKILL_MD), str(SKILL_MD.resolve())]
    return {
        "codex exited with 0": returncode == 0,
        "turn completed without failure": "turn.completed" in types and "turn.failed" not in types,
        "agent read the skill file": any(name in line for line in command_lines(events) for name in names),
        "first reply was English": bool(first_english),
        "final reply has no English prose and is not the first": bool(texts)
        and len(texts) > 1
        and bool(last)
        and not english_lines(last),
    }


def main():
    parser = argparse.ArgumentParser(description="Run a real Codex session and check the readable-output hooks.")
    parser.add_argument("--model")
    parser.add_argument(
        "--out",
        type=Path,
        default=SKILL_DIR / "tests" / "verification" / datetime.now().strftime("%Y-%m-%d") / "local" / "codex-session",
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    returncode, events, overrides = run_session(args.model, args.out)
    results = checks(returncode, events)
    texts = agent_texts(events)
    summary = {
        "model": args.model or "default",
        "prompt": PROMPT,
        "returncode": returncode,
        "hook_overrides": overrides,
        "agent_messages": texts,
        "commands": command_lines(events),
        "final_reply": texts[-1] if texts else "",
        "checks": results,
    }
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for name, passed in results.items():
        print(f"{'PASS' if passed else 'FAIL'}  {name}")
    print(f"artifacts: {args.out}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
