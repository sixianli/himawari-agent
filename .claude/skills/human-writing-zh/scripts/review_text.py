#!/usr/bin/env python3
"""Read-only editorial hints and literal comparison; NOT an AI or fact detector.

Python 3.9+, standard library only. No network access, file writes, or code
execution. Markdown handling is deliberately partial, not a full parser.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_BYTES = 2 * 1024 * 1024
MAX_HINTS = 100
FENCE_START = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
INLINE_CODE = re.compile(r"(?<!`)(`+)(?!`)(.*?)\1(?!`)", re.DOTALL)
QUOTES = re.compile(r'“[^”\n]+”|「[^」\n]+」|『[^』\n]+』|"[^"\n]+"')
LINK_TARGET = re.compile(r'\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))')
REFERENCE_TARGET = re.compile(r'^ {0,3}\[(?!\^)[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))', re.MULTILINE)
URL = re.compile(r"https?://[^\s<>\[\]\"'，。；！？、）]+")
CITATION = re.compile(r'\[(?:\^[\w:-]+|[sS]\d+|\d+(?:\s*[,–-]\s*\d+)*)\]')
NUMBER = re.compile(
    r'[-+−]?\d+(?:,\d{3})*(?:\.\d+)*'
    r'(?:\s*(?:个百分点|毫秒|分钟|小时|GiB|MiB|GB|MB|KB|kB|ms|QPS|RPS|秒|天|次|元|人|％|%|s))?'
)
CUES = re.compile('|'.join(re.escape(x) for x in sorted([
    '仅限', '仅', '至少', '至多', '最多', '不超过', '低于', '不低于', '除外',
    '不适用', '不支持', '不能', '尚未', '暂未', '未确认', '还没', '可能',
    '预计', '计划', '约', '本地', '测试', '生产', '首月', '每月', '平均', 'P95',
], key=len, reverse=True)))
STYLE_PATTERNS = [
    ('generic-opening', re.compile(r'在当今[^。！？\n]{0,35}(?:时代|社会|背景下)'), '背景是否具体且必要？'),
    ('stock-preface', re.compile(r'值得注意的是|不难发现|众所周知|毋庸置疑'), '直接说内容是否更清楚？必要提示可以保留。'),
    ('abstract-promise', re.compile(r'赋能|全方位|无缝衔接|全面提升|高效闭环'), '是否已有明确对象、动作或证据？领域术语不要误删。'),
    ('inflation', re.compile(r'里程碑式|划时代|颠覆性|未来可期|意义深远'), '这项评价是否有依据并适合语境？'),
    ('chat-wrapper', re.compile(r'很高兴为你|希望这对你有帮助|以下是优化后的|让我们一起深入'), '是否属于不应出现在文章中的聊天包装？'),
    ('performed-casualness', re.compile(r'说白了|你细品|讲真|说实话|真正的问题是'), '是否把旧套话换成了新的口头禅？真实声线可以保留。'),
    ('contrast-review', re.compile(r'不(?:仅仅|仅|只是|是)[^。！？\n]{1,70}(?:而是|更是|而在于)'), '对比是否提供真实纠错或区别？不是禁用句式。'),
]
STRICT_KEYS = ('frontmatter', 'fenced_code', 'inline_code', 'link_targets', 'urls', 'citation_markers')
LIMITATIONS = [
    '只提供编辑线索，不检测 AI 作者身份、不核实事实、不保证语义一致。',
    '数字集合相同也可能对象绑定错误；条件、归属、因果和引用支持范围必须另行阅读核对。',
    '不是完整 Markdown 解析器；嵌套括号、复杂链接、特殊脚注/引文和中文数词可能漏检。',
    '措辞和数字差异可能来自合法改写；没有提示也不代表稿件合格。',
]


@dataclass
class Parsed:
    prose: str
    frontmatter: list[str]
    fenced_code: list[str]
    inline_code: list[str]


def blank(text: str) -> str:
    """Mask text without changing line offsets."""
    return ''.join('\n' if c == '\n' else '\r' if c == '\r' else ' ' for c in text)


def parse_regions(text: str) -> Parsed:
    """Find common frontmatter/fences/inline code, preserving them verbatim."""
    lines = text.splitlines(keepends=True)
    result: list[str] = []
    frontmatter: list[str] = []
    fenced: list[str] = []
    i = 0
    if lines and lines[0].strip() == '---':
        end = next((j for j in range(1, len(lines)) if lines[j].strip() in ('---', '...')), None)
        if end is not None:
            block = ''.join(lines[:end + 1])
            frontmatter.append(block)
            result.append(blank(block))
            i = end + 1
    while i < len(lines):
        match = FENCE_START.match(lines[i].rstrip('\r\n'))
        if match is None:
            result.append(lines[i])
            i += 1
            continue
        marker = match.group(1)
        closing = re.compile(r'^ {0,3}' + re.escape(marker[0]) + '{' + str(len(marker)) + r',}\s*$')
        j = i + 1
        while j < len(lines) and not closing.fullmatch(lines[j].rstrip('\r\n')):
            j += 1
        end = min(j + 1, len(lines))
        block = ''.join(lines[i:end])
        fenced.append(block)
        result.append(blank(block))
        i = end
    prose = ''.join(result)
    inline = [m.group(0) for m in INLINE_CODE.finditer(prose)]
    prose = INLINE_CODE.sub(lambda m: blank(m.group(0)), prose)
    return Parsed(prose, frontmatter, fenced, inline)


def style_prose(prose: str) -> str:
    text = re.sub(r'^ {0,3}>[^\n]*', lambda m: blank(m.group(0)), prose, flags=re.MULTILINE)
    text = QUOTES.sub(lambda m: blank(m.group(0)), text)
    text = URL.sub(lambda m: blank(m.group(0)), text)
    text = LINK_TARGET.sub(lambda m: blank(m.group(0)), text)
    text = REFERENCE_TARGET.sub(lambda m: blank(m.group(0)), text)
    return text


def inventory(parsed: Parsed) -> dict[str, list[str]]:
    prose = parsed.prose
    links = [m.group(1) or m.group(2) for m in LINK_TARGET.finditer(prose)]
    links += [m.group(1) or m.group(2) for m in REFERENCE_TARGET.finditer(prose)]
    urls = [m.group(0).rstrip(').,;:!?') for m in URL.finditer(prose)]
    numeric_prose = CITATION.sub('', URL.sub('', LINK_TARGET.sub('', prose)))
    return {
        'frontmatter': parsed.frontmatter,
        'fenced_code': parsed.fenced_code,
        'inline_code': parsed.inline_code,
        'link_targets': links,
        'urls': urls,
        'citation_markers': CITATION.findall(prose),
        'numbers_with_units': [re.sub(r'\s+', '', m.group(0)) for m in NUMBER.finditer(numeric_prose)],
        'scope_cues': CUES.findall(numeric_prose),
        'quoted_spans': QUOTES.findall(prose),
    }


def changes(before: Sequence[str], after: Sequence[str]) -> dict[str, list[dict[str, Any]]]:
    old, new = Counter(before), Counter(after)
    return {
        'removed': [{'text': k, 'count': v} for k, v in sorted((old - new).items())],
        'added': [{'text': k, 'count': v} for k, v in sorted((new - old).items())],
    }


def metrics(text: str) -> dict[str, Any]:
    paragraphs = [p for p in re.split(r'\n\s*\n', text) if p.strip()]
    lengths = [len(re.sub(r'\s+', '', s)) for s in re.split(r'[。！？!?]+|\.(?=\s|$)', text)]
    lengths = [n for n in lengths if n > 0]
    return {
        'editable_nonspace_characters': len(re.sub(r'\s+', '', text)),
        'editable_paragraphs_approx': len(paragraphs),
        'headings': len(re.findall(r'^ {0,3}#{1,6}\s+', text, flags=re.MULTILINE)),
        'list_lines': len(re.findall(r'^\s*(?:[-+*]|\d+[.)])\s+\S', text, flags=re.MULTILINE)),
        'sentence_characters_approx': {
            'count': len(lengths),
            'min': min(lengths, default=0),
            'median': statistics.median(lengths) if lengths else 0,
            'max': max(lengths, default=0),
        },
    }


def style_hints(text: str) -> list[dict[str, Any]]:
    hints: list[dict[str, Any]] = []
    for code, pattern, question in STYLE_PATTERNS:
        for match in pattern.finditer(text):
            hints.append({
                'kind': code,
                'line': text.count('\n', 0, match.start()) + 1,
                'text': match.group(0),
                'review_question': question,
            })
    return sorted(hints, key=lambda x: (x['line'], x['kind']))


def review(candidate: str, source: str | None = None) -> dict[str, Any]:
    parsed = parse_regions(candidate)
    editable = style_prose(parsed.prose)
    hints = style_hints(editable)
    result: dict[str, Any] = {
        'schema_version': '1.0',
        'purpose': 'read-only editorial review; not AI detection or factual verification',
        'metrics': metrics(editable),
        'style_hint_count': len(hints),
        'style_hints': hints[:MAX_HINTS],
        'style_hints_truncated': len(hints) > MAX_HINTS,
        'comparison': None,
        'protected_literal_changes': False,
        'limitations': LIMITATIONS,
    }
    if source is not None:
        before, after = inventory(parse_regions(source)), inventory(parsed)
        comparison = {}
        for key in before:
            delta = changes(before[key], after[key])
            if delta['removed'] or delta['added']:
                comparison[key] = delta
        result['comparison'] = comparison
        result['protected_literal_changes'] = any(key in comparison for key in STRICT_KEYS)
    return result


def read_text(path: Path) -> str:
    with path.open('rb') as handle:
        data = handle.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError(f'{path}: file exceeds {MAX_BYTES} bytes; review smaller authorized sections')
    return data.decode('utf-8-sig')


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('candidate', type=Path, help='UTF-8 candidate text/Markdown')
    parser.add_argument('--source', type=Path, help='Optional UTF-8 original for literal comparison')
    parser.add_argument('--json', action='store_true', help='Print JSON report to stdout')
    parser.add_argument('--strict-protected', action='store_true', help='Exit 1 for recognized protected-literal changes')
    args = parser.parse_args(argv)
    if args.strict_protected and args.source is None:
        parser.error('--strict-protected requires --source')
    try:
        candidate = read_text(args.candidate)
        source = read_text(args.source) if args.source is not None else None
        result = review(candidate, source)
    except (OSError, UnicodeError, ValueError) as exc:
        print(f'review_text: {exc}', file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print('编辑检查：这些是复查提示，不是 AI 概率或事实验证。')
        print(f"表层提示：{result['style_hint_count']}；仅显示前 {MAX_HINTS} 条。")
        for hint in result['style_hints']:
            print(f"L{hint['line']} [{hint['kind']}] {hint['text']}：{hint['review_question']}")
        if result['comparison'] is not None:
            keys = ', '.join(result['comparison']) or '未发现可识别的字面差异'
            print(f'原稿比较：{keys}')
            if result['comparison']:
                print(json.dumps(result['comparison'], ensure_ascii=False, indent=2))
        print('仍须人工/模型核对对象绑定、条件、引用支持范围、事实及目标文风。')
    return 1 if args.strict_protected and result['protected_literal_changes'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
