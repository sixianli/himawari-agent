from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_DIR / "scripts" / "check_ascii.py"
PATTERNS = SKILL_DIR / "references" / "ascii-patterns.md"


def run_check(diagram: str, *args: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "diagram.txt"
        path.write_text(diagram, encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(path), *args],
            capture_output=True,
            text=True,
            check=False,
        )


def positions(output: str) -> list[tuple[int, int]]:
    return [(int(line), int(col)) for line, col in re.findall(r"^(\d+):(\d+):", output, re.MULTILINE)]


def diagram(text: str) -> str:
    return textwrap.dedent(text).strip("\n") + "\n"


ALIGNED_TREE = diagram(
    """
               +-----------+
               |  question |
               +-----+-----+
                     |
         +-----------+-----------+
         |           |           |
         v           v           v
     +-------+   +-------+   +-------+
     | [1]   |   | [2]   |   | [3]   |
     | text  |   | ascii |   | html  |
     +-------+   +-------+   +-------+
    """
)

ALIGNED_LOOP = diagram(
    """
     +------+     +------+     +----------+  pass   +------+
     | plan | --> | draw | --> | check.py | ------> | show |
     +------+     +--+---+     +----+-----+         +------+
                     ^              | fail
                     |              |
                     +--------------+
    """
)


class AlignedDiagramTests(unittest.TestCase):
    def test_aligned_tree_passes(self) -> None:
        result = run_check(ALIGNED_TREE)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("ok", result.stdout)

    def test_aligned_loop_with_edge_labels_passes(self) -> None:
        result = run_check(ALIGNED_LOOP)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_letter_v_inside_a_word_is_not_an_arrow(self) -> None:
        result = run_check(
            diagram(
                """
                +--------+
                | server |
                | v2 dev |
                +--------+
                """
            )
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class AlignmentErrorTests(unittest.TestCase):
    def test_box_side_shifted_one_column_is_reported(self) -> None:
        result = run_check(
            diagram(
                """
                +------+
                | plan  |
                +------+
                """
            )
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn((2, 9), positions(result.stdout))
        self.assertIn((1, 8), positions(result.stdout))

    def test_vertical_line_meeting_a_dash_needs_a_plus(self) -> None:
        result = run_check(
            diagram(
                """
                +------+
                | plan |
                +------+
                   |
                +------+
                | draw |
                +------+
                """
            )
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("4:4:", result.stdout)
        self.assertIn("+", result.stdout)

    def test_junction_on_a_border_without_a_vertical_line_is_reported(self) -> None:
        result = run_check(
            diagram(
                """
                +-----+-----+
                |   plan    |
                +-----------+
                """
            )
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("1:7:", result.stdout)

    def test_arrow_not_attached_to_a_line_is_reported(self) -> None:
        result = run_check(
            diagram(
                """
                +------+
                | plan |
                +------+

                   v
                +------+
                | draw |
                +------+
                """
            )
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("5:4:", result.stdout)

    def test_horizontal_arrow_needs_a_line_behind_it(self) -> None:
        result = run_check(
            diagram(
                """
                +---+     +---+
                | a |  >  | b |
                +---+     +---+
                """
            )
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("2:8:", result.stdout)


class CharacterTests(unittest.TestCase):
    def test_box_drawing_characters_are_rejected(self) -> None:
        result = run_check("┌──┐\n│ a│\n└──┘\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("1:1:", result.stdout)

    def test_unicode_arrow_is_rejected(self) -> None:
        result = run_check("a → b\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("1:3:", result.stdout)

    def test_tab_is_rejected(self) -> None:
        result = run_check("a\tb\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("1:2:", result.stdout)

    def test_ambiguous_width_character_is_rejected(self) -> None:
        result = run_check("step ①\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("1:6:", result.stdout)

    def test_chinese_label_is_rejected_and_columns_use_display_width(self) -> None:
        result = run_check(
            diagram(
                """
                +------+
                | 计划 |
                +------+
                """
            )
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(positions(result.stdout), [(2, 3), (2, 5)])

    def test_chinese_padded_by_character_count_is_misaligned(self) -> None:
        result = run_check(
            diagram(
                """
                +------+
                | 计划   |
                +------+
                """
            )
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("2:10:", result.stdout)

    def test_zero_width_space_is_reported_without_shifting_later_columns(self) -> None:
        result = run_check(
            diagram(
                """
                +------+
                | a\u200bbcd |
                +------+
                """
            )
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("zero-width character U+200B", result.stdout)
        self.assertEqual(positions(result.stdout), [(2, 4)])


class WidthTests(unittest.TestCase):
    def test_line_wider_than_80_columns_is_rejected(self) -> None:
        result = run_check("-" * 81 + "\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("1:81:", result.stdout)

    def test_line_of_exactly_80_columns_passes(self) -> None:
        result = run_check("-" * 80 + "\n")
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_width_limit_can_be_changed(self) -> None:
        result = run_check("-" * 50 + "\n", "--width", "40")
        self.assertEqual(result.returncode, 1)
        self.assertIn("1:41:", result.stdout)


class CommandLineTests(unittest.TestCase):
    def test_reads_standard_input_with_dash(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "-"],
            input=ALIGNED_TREE,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_file_exits_with_2(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "/nonexistent/diagram.txt"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertTrue(result.stderr.strip())

    def test_errors_are_sorted_by_line_then_column(self) -> None:
        result = run_check("a → b\n┌\n")
        positions = re.findall(r"^(\d+):(\d+):", result.stdout, re.MULTILINE)
        self.assertEqual(positions, sorted(positions, key=lambda p: (int(p[0]), int(p[1]))))
        self.assertEqual(len(positions), 2)


class PatternFileTests(unittest.TestCase):
    def test_every_pattern_in_the_reference_file_passes(self) -> None:
        text = PATTERNS.read_text(encoding="utf-8")
        blocks = re.findall(r"^```text\n(.*?)^```$", text, re.MULTILINE | re.DOTALL)
        self.assertGreaterEqual(len(blocks), 4)
        for block in blocks:
            with self.subTest(block=block.splitlines()[0]):
                result = run_check(block)
                self.assertEqual(result.returncode, 0, block + result.stdout)


if __name__ == "__main__":
    unittest.main()
