#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

SESSION_ID_ENV = {"claude": "CLAUDE_CODE_SESSION_ID", "codex": "CODEX_THREAD_ID"}
AGENTS = tuple(SESSION_ID_ENV)
MAX_OTHER_CANDIDATES = 5

CLAUDE_DROPPED_TAGS = (
    "system-reminder",
    "task-notification",
    "bash-input",
    "bash-stdout",
    "bash-stderr",
    "local-command-stdout",
    "local-command-stderr",
    "local-command-caveat",
    "command-message",
)
CODEX_INJECTED_PREFIXES = ("# AGENTS.md instructions",)
CODEX_QUESTION_REPLY_TAG = "<send_user_message_question_reply>"
CODEX_ASSISTANT_METADATA = re.compile(r"<oai-mem-citation>.*?</oai-mem-citation>", re.DOTALL)
WHOLE_MESSAGE_TAG = re.compile(r"^\s*<([A-Za-z_][\w-]*)[^>]*>.*</\1>\s*$", re.DOTALL)


class TranscriptError(Exception):
    pass


@dataclass
class Entry:
    kind: str
    text: str
    timestamp: str = ""


@dataclass
class Transcript:
    agent: str
    session_id: str
    path: Path
    cwd: str = ""
    started_at: str = ""
    entries: list[Entry] = field(default_factory=list)
    unreadable_lines: int = 0

    def first_user_message(self) -> str:
        return next((e.text for e in self.entries if e.kind == "user"), "")


def read_records(path: Path) -> tuple[list[dict], int]:
    records: list[dict] = []
    unreadable = 0
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                unreadable += 1
                continue
            if isinstance(record, dict):
                records.append(record)
            else:
                unreadable += 1
    return records, unreadable


def clean_claude_user_text(text: str) -> str:
    for tag in CLAUDE_DROPPED_TAGS:
        text = re.sub(rf"<{tag}>.*?</{tag}>", "", text, flags=re.DOTALL)
    command = re.search(r"<command-name>(.*?)</command-name>", text, re.DOTALL)
    if command:
        args = re.search(r"<command-args>(.*?)</command-args>", text, re.DOTALL)
        text = " ".join(part.strip() for part in (command.group(1), args.group(1) if args else "") if part.strip())
    return text.strip()


def claude_user_parts(content) -> list[str]:
    if isinstance(content, str):
        return [content]
    parts = []
    for block in content:
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif block.get("type") == "image":
            parts.append("[图片]")
    return parts


def format_decision(pairs: list[tuple[str, str]]) -> str:
    return "\n\n".join(f"**问题**：{question}\n\n**回答**：{answer}" for question, answer in pairs)


def append_or_merge_assistant(entries: list[Entry], text: str, timestamp: str, message_id: str, last_id: list[str]):
    if entries and entries[-1].kind == "assistant" and message_id and last_id[0] == message_id:
        entries[-1].text = f"{entries[-1].text}\n\n{text}"
    else:
        entries.append(Entry("assistant", text, timestamp))
    last_id[0] = message_id


def parse_claude(path: Path) -> Transcript:
    records, unreadable = read_records(path)
    transcript = Transcript("claude", path.stem, path, unreadable_lines=unreadable)
    seen_uuids: set[str] = set()
    question_tool_ids: set[str] = set()
    last_assistant_id = [""]
    for record in records:
        if record.get("cwd") and not transcript.cwd:
            transcript.cwd = record["cwd"]
        kind = record.get("type")
        if kind not in ("user", "assistant") or record.get("isSidechain"):
            continue
        uuid = record.get("uuid", "")
        if uuid and uuid in seen_uuids:
            continue
        seen_uuids.add(uuid)
        timestamp = record.get("timestamp", "")
        if not transcript.started_at and timestamp:
            transcript.started_at = timestamp
        message = record.get("message") or {}
        content = message.get("content") or []
        if kind == "assistant":
            texts = []
            for block in content if isinstance(content, list) else [{"type": "text", "text": content}]:
                if block.get("type") == "text" and block.get("text", "").strip():
                    texts.append(block["text"].strip())
                elif block.get("type") == "tool_use" and block.get("name") == "AskUserQuestion":
                    question_tool_ids.add(block.get("id", ""))
            if texts:
                append_or_merge_assistant(transcript.entries, "\n\n".join(texts), timestamp, message.get("id", ""),
                                          last_assistant_id)
            continue
        last_assistant_id[0] = ""
        if record.get("isCompactSummary"):
            text = content if isinstance(content, str) else "\n".join(claude_user_parts(content))
            transcript.entries.append(Entry("summary", text.strip(), timestamp))
            continue
        if record.get("isMeta"):
            continue
        if isinstance(content, list):
            for block in content:
                if block.get("type") == "tool_result" and block.get("tool_use_id") in question_tool_ids:
                    answers = (record.get("toolUseResult") or {}).get("answers") or {}
                    if answers:
                        transcript.entries.append(Entry("decision", format_decision(list(answers.items())), timestamp))
        text = "\n\n".join(p for p in (clean_claude_user_text(part) for part in claude_user_parts(content)) if p)
        if text:
            transcript.entries.append(Entry("user", text, timestamp))
    return transcript


def codex_message_parts(payload: dict) -> list[str]:
    parts = []
    for item in payload.get("content") or []:
        if item.get("type") in ("input_text", "output_text", "text"):
            parts.append(item.get("text", "").strip())
        elif item.get("type") in ("input_image", "image"):
            parts.append("[图片]")
    return [part for part in parts if part]


def codex_question_replies(text: str) -> list[tuple[str, str]]:
    pairs = []
    for line in text.splitlines():
        line = line.strip().removeprefix("user: ")
        if not line.startswith("["):
            continue
        try:
            items = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(items, list):
            continue
        pairs.extend((str(i.get("question", "")), str(i.get("answer", ""))) for i in items if isinstance(i, dict))
    return pairs


def is_codex_injected(text: str) -> bool:
    return text.startswith(CODEX_INJECTED_PREFIXES) or bool(WHOLE_MESSAGE_TAG.match(text))


def codex_meta(records: list[dict]) -> dict:
    return next((r.get("payload") or {} for r in records if r.get("type") == "session_meta"), {})


def parse_codex(path: Path) -> Transcript:
    records, unreadable = read_records(path)
    meta = codex_meta(records)
    session_id = meta.get("id") or meta.get("session_id") or path.stem
    transcript = Transcript("codex", session_id, path, meta.get("cwd", ""), meta.get("timestamp", ""),
                            unreadable_lines=unreadable)
    for record in records:
        payload = record.get("payload") or {}
        timestamp = record.get("timestamp", "")
        if record.get("type") == "compacted":
            summary = str(payload.get("message") or "").strip()
            transcript.entries.append(Entry("summary", summary, timestamp))
            continue
        if record.get("type") != "response_item" or payload.get("type") != "message":
            continue
        role = payload.get("role")
        parts = codex_message_parts(payload)
        if role == "assistant":
            text = CODEX_ASSISTANT_METADATA.sub("", "\n\n".join(parts)).strip()
            if text:
                kind = "progress" if payload.get("phase") == "commentary" else "assistant"
                transcript.entries.append(Entry(kind, text, timestamp))
        elif role == "user":
            pairs = [pair for part in parts if part.startswith(CODEX_QUESTION_REPLY_TAG)
                     for pair in codex_question_replies(part)]
            if pairs:
                transcript.entries.append(Entry("decision", format_decision(pairs), timestamp))
            spoken = [part for part in parts
                      if not part.startswith(CODEX_QUESTION_REPLY_TAG) and not is_codex_injected(part)]
            if spoken:
                transcript.entries.append(Entry("user", "\n\n".join(spoken), timestamp))
    return transcript


PARSERS = {"claude": parse_claude, "codex": parse_codex}


def claude_files(home: Path) -> list[Path]:
    return sorted((home / "projects").glob("*/*.jsonl"))


def codex_files(home: Path) -> list[Path]:
    return sorted((home / "sessions").glob("**/rollout-*.jsonl"))


def find_by_id(agent: str, session_id: str, homes: dict[str, Path]) -> Path:
    if agent == "claude":
        matches = [p for p in claude_files(homes["claude"]) if p.stem == session_id]
    else:
        matches = [p for p in codex_files(homes["codex"]) if p.stem.endswith(session_id)]
    if not matches:
        raise TranscriptError(f"找不到 {agent} 会话 {session_id} 的记录文件（搜索目录：{homes[agent]}）")
    return max(matches, key=lambda p: p.stat().st_mtime)


def claude_cwd(path: Path) -> str:
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict) and record.get("cwd"):
                return record["cwd"]
    return ""


def codex_candidate(path: Path) -> dict | None:
    with path.open(encoding="utf-8", errors="replace") as handle:
        try:
            first = json.loads(handle.readline())
        except json.JSONDecodeError:
            return None
    meta = first.get("payload") or {} if first.get("type") == "session_meta" else {}
    source = meta.get("source")
    if meta.get("thread_source") == "guardian_review" or (isinstance(source, dict) and "subagent" in source):
        return None
    return {"cwd": meta.get("cwd", "")}


def candidates_for_cwd(agents: tuple[str, ...], cwd: str, homes: dict[str, Path]) -> list[tuple[str, Path]]:
    target = os.path.realpath(cwd)
    found = []
    for agent in agents:
        if agent == "claude":
            for path in claude_files(homes["claude"]):
                if os.path.realpath(claude_cwd(path) or "/") == target:
                    found.append((agent, path))
        else:
            for path in codex_files(homes["codex"]):
                info = codex_candidate(path)
                if info and os.path.realpath(info["cwd"] or "/") == target:
                    found.append((agent, path))
    return sorted(found, key=lambda item: item[1].stat().st_mtime, reverse=True)


def summary(transcript: Transcript) -> dict:
    return {
        "agent": transcript.agent,
        "session_id": transcript.session_id,
        "path": str(transcript.path),
        "cwd": transcript.cwd,
        "started_at": transcript.started_at,
        "first_user_message": transcript.first_user_message(),
    }


def resolve_agents(requested: str | None) -> tuple[str, ...]:
    if requested:
        return (requested,)
    with_ids = tuple(a for a in AGENTS if os.environ.get(SESSION_ID_ENV[a]))
    return with_ids if len(with_ids) == 1 else AGENTS


def locate(args: argparse.Namespace, homes: dict[str, Path]) -> dict:
    agents = resolve_agents(args.agent)
    if len(agents) == 1:
        agent = agents[0]
        session_id = args.session_id or os.environ.get(SESSION_ID_ENV[agent], "")
        if session_id:
            path = find_by_id(agent, session_id, homes)
            return {"method": "session-id", **summary(PARSERS[agent](path)), "other_candidates": []}
    elif args.session_id:
        raise TranscriptError("使用 --session-id 时必须同时指定 --agent claude 或 --agent codex")
    candidates = candidates_for_cwd(agents, args.cwd, homes)
    if not candidates:
        raise TranscriptError(f"在 {', '.join(agents)} 的会话记录中找不到工作目录为 {args.cwd} 的会话")
    (agent, path), rest = candidates[0], candidates[1 : 1 + MAX_OTHER_CANDIDATES]
    others = [summary(PARSERS[a](p)) for a, p in rest]
    return {"method": "recent-cwd", **summary(PARSERS[agent](path)), "other_candidates": others}


ENTRY_LABELS = {
    "user": "用户",
    "assistant": "助手",
    "progress": "助手（进度说明）",
    "decision": "用户决定",
    "summary": "上下文压缩",
}


def render(transcript: Transcript) -> str:
    counts = {label: sum(1 for e in transcript.entries if e.kind == kind) for kind, label in ENTRY_LABELS.items()}
    lines = [
        "# 还原的对话记录",
        "",
        f"- agent：{transcript.agent}",
        f"- 会话 ID：{transcript.session_id}",
        f"- 工作目录：{transcript.cwd}",
        f"- 开始时间：{transcript.started_at}",
        f"- 来源文件：{transcript.path}",
        "- 条目统计：" + "，".join(f"{label} {n}" for label, n in counts.items()),
        f"- 无法解析的行：{transcript.unreadable_lines}",
        "- 已省略：工具调用、工具结果、思考过程、子代理对话和系统注入内容。",
        "- 标为“上下文压缩”的条目是 AI 转述，不是原话；压缩前的原始消息仍按时间顺序保留在前面。",
        "",
    ]
    for number, entry in enumerate(transcript.entries, start=1):
        lines.append(f"## #{number} {ENTRY_LABELS[entry.kind]} · {entry.timestamp}".rstrip(" ·"))
        lines.append("")
        if entry.kind == "summary":
            note = "以下摘要为 AI 转述，不是原话" if entry.text else "记录中没有摘要文本"
            lines.append(f"（此处发生上下文压缩。{note}。）")
            lines.append("")
        if entry.text:
            lines.append(entry.text)
            lines.append("")
    return "\n".join(lines)


def export(args: argparse.Namespace) -> dict:
    path = Path(args.path).expanduser()
    if not path.is_file():
        raise TranscriptError(f"记录文件不存在：{path}")
    transcript = PARSERS[args.agent](path)
    output = Path(args.output).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(transcript), encoding="utf-8")
    return {
        "output": str(output),
        "entries": len(transcript.entries),
        "unreadable_lines": transcript.unreadable_lines,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="定位并还原 Claude Code / Codex 会话的对话记录")
    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument("--claude-home", default=os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"))
    parent.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", "~/.codex"))
    commands = parser.add_subparsers(dest="command", required=True)
    locate_cmd = commands.add_parser("locate", parents=[parent], help="找到当前 thread 的记录文件")
    locate_cmd.add_argument("--agent", choices=AGENTS)
    locate_cmd.add_argument("--session-id")
    locate_cmd.add_argument("--cwd", default=os.getcwd())
    export_cmd = commands.add_parser("export", parents=[parent], help="把记录文件还原成只含对话的 Markdown")
    export_cmd.add_argument("--agent", choices=AGENTS, required=True)
    export_cmd.add_argument("--path", required=True)
    export_cmd.add_argument("--output", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    homes = {"claude": Path(args.claude_home).expanduser(), "codex": Path(args.codex_home).expanduser()}
    try:
        result = locate(args, homes) if args.command == "locate" else export(args)
    except TranscriptError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
