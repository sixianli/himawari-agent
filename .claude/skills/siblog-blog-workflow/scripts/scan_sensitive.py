#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

RULES = (
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("api-key", re.compile(r"\b(?:sk|sk-ant|sk-proj)-[A-Za-z0-9_-]{20,}")),
    ("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("bearer-token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}")),
    (
        "secret-assignment",
        re.compile(r"(?i)\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*['\"]?[^\s'\"`]{6,}"),
    ),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    (
        "private-ip",
        re.compile(r"\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b"),
    ),
    ("home-path", re.compile(r"(?:/Users|/home)/[A-Za-z0-9._-]+/")),
)


def scan(text: str) -> list[dict]:
    findings = []
    for number, line in enumerate(text.splitlines(), start=1):
        for kind, pattern in RULES:
            for match in pattern.finditer(line):
                findings.append({"line": number, "kind": kind, "match": match.group(0)})
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="列出草稿中疑似敏感的内容，供作者逐条决定删除或改写")
    parser.add_argument("draft")
    args = parser.parse_args(argv)
    text = Path(args.draft).expanduser().read_text(encoding="utf-8")
    print(json.dumps(scan(text), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
