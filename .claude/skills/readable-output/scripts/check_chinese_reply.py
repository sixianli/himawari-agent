#!/usr/bin/env python3
import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_STATE_DIR = Path.home() / ".claude" / "reply-language"
CJK_CHARS = "　-〿㐀-䶿一-鿿＀-￯"
SEPARATOR = re.compile(f"[{CJK_CHARS}|]+")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
BLOCKQUOTE = re.compile(r"^\s*>")
INLINE_CODE = re.compile(r"(`+).+?\1")
LINK = re.compile(r"\[[^\]]*\]\([^)\s]*\)")
QUOTED = re.compile(r"“[^”]*”|\"[^\"]*\"")
SLASHED = re.compile(r"\S*/\S*")
WORD = re.compile(r"[A-Za-z]+(?:['’-][A-Za-z]+)*")
SENTENCE = re.compile(r"^[A-Z].*[.!?]$")
LIST_MARKER = re.compile(r"^(?:\d+[.)]|[-*+])\s+")
STOPWORDS = frozenset(
    {
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "to", "of", "and", "or",
        "but", "for", "in", "on", "at", "by", "with", "from", "into", "this", "that", "these", "those",
        "it", "its", "so", "now", "then", "let", "me", "i", "we", "you", "they", "them", "our", "my",
        "your", "their", "will", "would", "can", "could", "should", "must", "need", "needs", "only",
        "not", "no", "if", "as", "has", "have", "had", "do", "does", "did", "here", "there", "which",
        "what", "when", "where", "why", "how", "all", "some", "any", "just", "also", "still", "than",
        "before", "after", "about", "because", "while",
    }
)
CLAUSE_WORDS = frozenset(
    {
        "am", "is", "are", "was", "were", "be", "been", "being", "will", "would", "can", "could", "should",
        "must", "may", "might", "shall", "has", "have", "had", "do", "does", "did", "i", "we", "you", "they",
        "he", "she", "it", "me", "us", "them", "let", "please", "now", "then", "there", "what", "which",
        "when", "where", "why", "how",
    }
)
VERB_FORM = re.compile(r"[a-z]{3,}(?:ing|ed)$")
MAX_REPORTED = 8
REPORT_WIDTH = 200


def runs(line):
    line = INLINE_CODE.sub(" ", line)
    line = LINK.sub(" ", line)
    line = QUOTED.sub(" ", line)
    line = SLASHED.sub(" ", line)
    return [run.strip() for run in SEPARATOR.split(line)]


def is_name(words, run):
    content = [word for word in words if word.lower() not in STOPWORDS]
    return len(words) >= 2 and bool(content) and all(word[0].isupper() for word in content) and not run.endswith((".", "!", "?"))


def is_english(run):
    words = WORD.findall(run)
    lowered = [word.lower() for word in words]
    stops = sum(word in STOPWORDS for word in lowered)
    if len(words) < 3 or stops == 0 or is_name(words, run):
        return False
    if SENTENCE.match(LIST_MARKER.sub("", run)) or any(word in CLAUSE_WORDS for word in lowered):
        return True
    verb_form = any(VERB_FORM.match(word) and word not in STOPWORDS for word in lowered)
    if len(words) >= 4 and stops >= 2 and verb_form:
        return True
    return len(words) >= 6 and stops >= 2


def closes_fence(line, fence):
    stripped = line.strip()
    return bool(stripped) and set(stripped) == {fence[0]} and len(stripped) >= len(fence)


def english_lines(text):
    found = []
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        if fence:
            if closes_fence(line, fence):
                fence = None
            continue
        opening = FENCE.match(line)
        if opening:
            fence = opening.group(1)
            continue
        if BLOCKQUOTE.match(line):
            continue
        if any(is_english(run) for run in runs(line)):
            found.append((number, line.strip()))
    return found


def unique_lines(found):
    seen = []
    for _, line in found:
        if line not in seen:
            seen.append(line)
    return seen


def report(found, request):
    lines = "\n".join(f"- {line[:REPORT_WIDTH]}" for line in unique_lines(found)[:MAX_REPORTED])
    return (
        "回复语言检查：给用户的文字里有英文句子，而用户要求所有给用户的文字都用简体中文：\n"
        f"{lines}\n"
        f"{request}"
        "命令、路径和标识符放进反引号；需要原样引用的英文放进代码块，或放在以 > 开头的引用行里。"
    )


def notice(found):
    return f"回复语言检查：发现 {len(unique_lines(found))} 行英文，已要求改用中文。"


def state_file(state_dir, payload):
    session = re.sub(r"[^A-Za-z0-9_.-]", "_", str(payload.get("session_id") or "unknown"))
    return state_dir / f"{session}.txt"


def take_shown_text(payload, state_dir):
    path = state_file(state_dir, payload)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    path.unlink(missing_ok=True)
    return text


def record(payload, state_dir):
    delta = payload.get("delta") or ""
    if delta:
        state_dir.mkdir(parents=True, exist_ok=True)
        with state_file(state_dir, payload).open("a", encoding="utf-8") as handle:
            handle.write(delta if delta.endswith("\n") else delta + "\n")


def batch(payload, state_dir):
    found = english_lines(take_shown_text(payload, state_dir))
    if not found:
        return None
    request = "这些文字已经显示给用户。请先用简体中文把这些内容重新告诉用户，再继续原来的工作。"
    return {
        "systemMessage": notice(found),
        "hookSpecificOutput": {"hookEventName": "PostToolBatch", "additionalContext": report(found, request)},
    }


def start(payload, state_dir):
    skill_file = Path(__file__).resolve().parent.parent / "SKILL.md"
    return {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": (
                "Every reply in this session must follow the readable-output skill. "
                f"Before your first reply, read {skill_file} in full, then keep following it for the rest of the session."
            ),
        }
    }


def stop(payload, state_dir):
    found = english_lines(take_shown_text(payload, state_dir))
    found += english_lines(payload.get("last_assistant_message") or "")
    if not found:
        return None
    request = "这些文字已经显示给用户。请用简体中文把这些内容重新告诉用户，然后再结束。"
    return {"decision": "block", "reason": report(found, request), "systemMessage": notice(found)}


def ask(payload, state_dir):
    texts = []
    for question in (payload.get("tool_input") or {}).get("questions") or []:
        texts += [question.get("question"), question.get("header")]
        for option in question.get("options") or []:
            texts += [option.get("label"), option.get("description")]
    found = english_lines("\n".join(text for text in texts if text))
    if not found:
        return None
    request = "这个问题还没有显示给用户。请用简体中文重写问题和选项，再重新提问。"
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": report(found, request),
        }
    }


EVENTS = {
    "start": (start, "SessionStart hook: tell the agent to read this skill before its first reply"),
    "record": (record, "MessageDisplay hook: keep the text shown to the user until the next check"),
    "batch": (batch, "PostToolBatch hook: report English shown before the tool calls"),
    "stop": (stop, "Stop hook: block the stop when this turn showed English"),
    "ask": (ask, "PreToolUse hook for AskUserQuestion: deny English questions and options"),
}


def read_stdin():
    return sys.stdin.buffer.read().decode("utf-8")


def check_file(name):
    text = read_stdin() if name == "-" else Path(name).read_text(encoding="utf-8")
    found = english_lines(text)
    for number, line in found:
        print(f"{number}: {line}")
    if found:
        print(f"{len(found)} English line(s) found")
        return 1
    print("ok: no English prose found")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Find English prose in replies that must be written in Chinese.")
    commands = parser.add_subparsers(dest="command", required=True)
    check_parser = commands.add_parser("check", help="check a file, or - for standard input")
    check_parser.add_argument("file")
    for name, (_, description) in EVENTS.items():
        event_parser = commands.add_parser(name, help=description)
        event_parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR, help="where shown text waits for the next check")
    args = parser.parse_args(argv)
    if args.command == "check":
        try:
            return check_file(args.file)
        except (OSError, UnicodeDecodeError) as error:
            print(f"cannot read {args.file}: {error}", file=sys.stderr)
            return 2
    payload = json.loads(read_stdin())
    if payload.get("agent_id"):
        return 0
    handler, _ = EVENTS[args.command]
    output = handler(payload, args.state_dir)
    if output:
        print(json.dumps(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
