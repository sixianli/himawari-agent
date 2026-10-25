#!/usr/bin/env python3
import argparse
import sys
import unicodedata
from pathlib import Path

DEFAULT_WIDTH = 80
WIDE_FILLER = "\0"
VERTICAL_LINE = frozenset("|+")
HORIZONTAL_LINE = frozenset("-+")
ARROWS = frozenset("v^<>")
BANNED_RANGES = (
    (0x2190, 0x21FF, "Unicode arrow"),
    (0x2500, 0x257F, "box-drawing character"),
    (0x2580, 0x259F, "block character"),
    (0x25A0, 0x25FF, "geometric shape"),
    (0x27F0, 0x27FF, "Unicode arrow"),
    (0x2900, 0x297F, "Unicode arrow"),
    (0x2B00, 0x2BFF, "Unicode arrow"),
)


def character_problem(ch):
    if ch == "\t":
        return 1, "tab; use spaces"
    code = ord(ch)
    for start, end, kind in BANNED_RANGES:
        if start <= code <= end:
            return 1, f"{kind} {ch!r}; draw with + - | < > ^ v / \\ only"
    if unicodedata.category(ch) in ("Mn", "Me", "Cf"):
        return 0, f"zero-width character U+{code:04X}"
    width_class = unicodedata.east_asian_width(ch)
    if width_class == "A":
        return 1, f"ambiguous-width character {ch!r}; terminals show it as 1 or 2 columns"
    if width_class in ("W", "F"):
        return 2, f"wide character {ch!r} (2 columns); keep labels ASCII and put Chinese in numbered notes below"
    return 1, None


def build_grid(lines):
    grid = []
    problems = []
    for row, line in enumerate(lines, start=1):
        cells = []
        for ch in line:
            width, problem = character_problem(ch)
            if problem:
                problems.append((row, len(cells) + 1, problem))
            if width == 0:
                continue
            cells.append(ch)
            cells.extend(WIDE_FILLER * (width - 1))
        grid.append(cells)
    return grid, problems


def cell(grid, row, col):
    if 0 <= row < len(grid) and 0 <= col < len(grid[row]):
        ch = grid[row][col]
        return " " if ch == WIDE_FILLER else ch
    return " "


def is_arrow(grid, row, col):
    if cell(grid, row, col) not in ARROWS:
        return False
    return not (cell(grid, row, col - 1).isalnum() or cell(grid, row, col + 1).isalnum())


def joins_vertically(grid, row, col):
    ch = cell(grid, row, col)
    return ch in VERTICAL_LINE or (ch in "v^" and is_arrow(grid, row, col))


def joins_horizontally(grid, row, col):
    ch = cell(grid, row, col)
    return ch in HORIZONTAL_LINE or (ch in "<>" and is_arrow(grid, row, col))


def describe(ch):
    return "nothing" if ch == " " else repr(ch)


def vertical_line_problem(grid, row, col):
    for step, side in ((-1, "above"), (1, "below")):
        neighbor = cell(grid, row + step, col)
        if neighbor == "-":
            return f"vertical line meets '-' {side}; put '+' at the junction"
        if not joins_vertically(grid, row + step, col):
            return f"vertical line has {describe(neighbor)} {side}; check the column"
    return None


def junction_problem(grid, row, col):
    if not (joins_vertically(grid, row - 1, col) or joins_vertically(grid, row + 1, col)):
        return "'+' has no vertical line above or below; check the column"
    if not (joins_horizontally(grid, row, col - 1) or joins_horizontally(grid, row, col + 1)):
        return "'+' has no horizontal line left or right"
    return None


def arrow_problem(grid, row, col):
    ch = cell(grid, row, col)
    if ch == "v" and cell(grid, row - 1, col) not in VERTICAL_LINE:
        return "arrow 'v' has no line above it"
    if ch == "^" and cell(grid, row + 1, col) not in VERTICAL_LINE:
        return "arrow '^' has no line below it"
    if ch == ">" and cell(grid, row, col - 1) not in HORIZONTAL_LINE:
        return "arrow '>' has no line to its left"
    if ch == "<" and cell(grid, row, col + 1) not in HORIZONTAL_LINE:
        return "arrow '<' has no line to its right"
    return None


def structure_problems(grid):
    problems = []
    for row, cells in enumerate(grid):
        for col, ch in enumerate(cells):
            if ch == "|":
                problem = vertical_line_problem(grid, row, col)
            elif ch == "+":
                problem = junction_problem(grid, row, col)
            elif is_arrow(grid, row, col):
                problem = arrow_problem(grid, row, col)
            else:
                problem = None
            if problem:
                problems.append((row + 1, col + 1, problem))
    return problems


def width_problems(grid, limit):
    return [
        (row, limit + 1, f"line is {len(cells)} columns wide; limit is {limit}")
        for row, cells in enumerate(grid, start=1)
        if len(cells) > limit
    ]


def check(text, limit):
    grid, problems = build_grid(text.splitlines())
    problems += structure_problems(grid)
    problems += width_problems(grid, limit)
    return grid, sorted(problems)


def read_input(source):
    if source == "-":
        return sys.stdin.read()
    return Path(source).read_text(encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Check a plain ASCII diagram for alignment, banned characters and width."
    )
    parser.add_argument("file", help="diagram file, or - for standard input")
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH, help="maximum display width in columns")
    args = parser.parse_args(argv)
    try:
        text = read_input(args.file)
    except (OSError, UnicodeDecodeError) as error:
        print(f"cannot read {args.file}: {error}", file=sys.stderr)
        return 2
    grid, problems = check(text, args.width)
    for row, col, message in problems:
        print(f"{row}:{col}: {message}")
    if problems:
        print(f"{len(problems)} problem(s) found")
        return 1
    widest = max((len(cells) for cells in grid), default=0)
    print(f"ok: {len(grid)} lines, widest {widest} columns")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
