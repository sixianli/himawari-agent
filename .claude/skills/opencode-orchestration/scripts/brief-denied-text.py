#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

MARKER = "本地禁止规则："
LITERAL_PATTERN = re.compile(r"^\*([^*?\[\]\s]+)\*$")


def denied_texts(config):
    try:
        rules = json.loads(config.read_text())["permission"]["bash"]
        if not isinstance(rules, dict):
            raise TypeError("permission.bash is not an object")
    except KeyError:
        return []
    except (OSError, ValueError, TypeError) as error:
        print(f"OPENCODE_CONFIG_UNREADABLE: {config}: {error}", file=sys.stderr)
        sys.exit(2)
    return sorted({match.group(1) for pattern, action in rules.items() if action == "deny" and (match := LITERAL_PATTERN.match(pattern))})


def main():
    if len(sys.argv) != 3:
        print("usage: brief-denied-text.py <opencode.json> <brief or reply>", file=sys.stderr)
        return 2
    config, document = Path(sys.argv[1]), Path(sys.argv[2])
    lines = document.read_text().splitlines()
    warnings = [line for line in lines if line.lstrip(" \t-*>").startswith(MARKER)]
    missing = []
    for text in denied_texts(config):
        if any(text in warning for warning in warnings):
            continue
        number = next((index for index, line in enumerate(lines, 1) if text in line), None)
        if number is not None:
            missing.append((text, number))
    if not missing:
        return 0
    print(f"BRIEF_NAMES_DENIED_TEXT: {document} names text that the bash deny rules in {config} refuse in any shell command:", file=sys.stderr)
    for text, number in missing:
        print(f"  `{text}` first at {document}:{number}", file=sys.stderr)
    print(
        f"add a line starting with {MARKER} that names each of them, says the shell refuses commands containing it, "
        "and says to read and search those files with the read, glob and grep tools instead",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
