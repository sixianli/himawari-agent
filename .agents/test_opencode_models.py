import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "opencode-models.py"

BASE_HEADER = (
    "# Generated from .agents/opencode-models.toml by .agents/opencode-models.py; do not edit by hand.\n"
    "# Run: python3 .agents/opencode-models.py export\n"
)


def model_block(
    model_id,
    pool="free",
    order=0,
    variants=("low", "high"),
    context=200000,
    status="active",
    skip_for_context=False,
    note="a fact",
    updated="2026-10-21",
):
    variants_text = ", ".join(f'"{item}"' for item in variants)
    skip_text = "true" if skip_for_context else "false"
    return (
        "[[model]]\n"
        f'id = "{model_id}"\n'
        f'pool = "{pool}"\n'
        f"order = {order}\n"
        f"variants = [{variants_text}]\n"
        f"context = {context}\n"
        f'status = "{status}"\n'
        f"skip_for_context = {skip_text}\n"
        f'note = "{note}"\n'
        f'updated = "{updated}"\n'
    )


class ScriptTestCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        agents = self.root / ".agents"
        agents.mkdir()
        shutil.copyfile(SCRIPT, agents / "opencode-models.py")

    def write_table(self, text):
        (self.root / ".agents" / "opencode-models.toml").write_text(text, encoding="utf-8")

    def write_allowlist(self, text, base=None):
        target = (base or self.root) / ".opencode" / "allowed-models.txt"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def run_script(self, *args):
        return subprocess.run(
            [sys.executable, "-I", str(self.root / ".agents" / "opencode-models.py"), *args],
            cwd=self.root,
            capture_output=True,
            text=True,
        )

    def allowlist_text(self, base=None):
        return ((base or self.root) / ".opencode" / "allowed-models.txt").read_text(encoding="utf-8")

    def make_worktree(self, name, with_opencode=True):
        worktree = self.root / ".ci-output" / "worktrees" / name
        worktree.mkdir(parents=True)
        if with_opencode:
            (worktree / ".opencode").mkdir()
        return worktree


class ExportTests(ScriptTestCase):
    def test_export_writes_header_and_ordered_ids(self):
        self.write_table(
            model_block("open/third", order=3)
            + model_block("open/first", order=1)
            + model_block("open/second", order=2)
        )
        result = self.run_script("export")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "EXPORTED .opencode/allowed-models.txt 3\n")
        self.assertEqual(
            self.allowlist_text(),
            BASE_HEADER + "open/first\nopen/second\nopen/third\n",
        )

    def test_export_puts_order_zero_last_sorted_by_id(self):
        self.write_table(
            model_block("open/zeta", order=0)
            + model_block("open/second", order=2)
            + model_block("open/alpha", order=0)
            + model_block("open/first", order=1)
        )
        result = self.run_script("export")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            self.allowlist_text(),
            BASE_HEADER + "open/first\nopen/second\nopen/alpha\nopen/zeta\n",
        )

    def test_export_skips_paused_and_withdrawn(self):
        self.write_table(
            model_block("open/active", order=1)
            + model_block("open/paused", order=2, status="paused")
            + model_block("open/withdrawn", order=3, status="withdrawn")
        )
        result = self.run_script("export")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "EXPORTED .opencode/allowed-models.txt 1\n")
        self.assertEqual(self.allowlist_text(), BASE_HEADER + "open/active\n")

    def test_export_without_all_leaves_worktrees_alone(self):
        self.write_table(model_block("open/only", order=1))
        worktree = self.make_worktree("wt-one")
        result = self.run_script("export")
        self.assertEqual(result.returncode, 0)
        self.assertFalse((worktree / ".opencode" / "allowed-models.txt").exists())

    def test_export_all_writes_worktrees_with_opencode_and_skips_others(self):
        self.write_table(model_block("open/only", order=1))
        first = self.make_worktree("wt-a")
        second = self.make_worktree("wt-b")
        without = self.make_worktree("wt-c", with_opencode=False)
        result = self.run_script("export", "--all")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.stdout,
            "EXPORTED .opencode/allowed-models.txt 1\n"
            "EXPORTED .ci-output/worktrees/wt-a/.opencode/allowed-models.txt 1\n"
            "EXPORTED .ci-output/worktrees/wt-b/.opencode/allowed-models.txt 1\n",
        )
        expected = BASE_HEADER + "open/only\n"
        self.assertEqual(self.allowlist_text(first), expected)
        self.assertEqual(self.allowlist_text(second), expected)
        self.assertFalse((without / ".opencode" / "allowed-models.txt").exists())


class CheckTests(ScriptTestCase):
    def setUp(self):
        super().setUp()
        self.write_table(model_block("open/first", order=1) + model_block("open/second", order=2))

    def test_check_in_sync(self):
        self.write_allowlist(BASE_HEADER + "open/first\nopen/second\n")
        result = self.run_script("check")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "MODELS_IN_SYNC\n")

    def test_check_missing_id(self):
        self.write_allowlist(BASE_HEADER + "open/first\n")
        result = self.run_script("check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("MODELS_OUT_OF_SYNC", result.stdout)
        self.assertIn("MISSING open/second", result.stdout)

    def test_check_extra_id(self):
        self.write_allowlist(BASE_HEADER + "open/first\nopen/second\nopen/extra\n")
        result = self.run_script("check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("MODELS_OUT_OF_SYNC", result.stdout)
        self.assertIn("EXTRA open/extra", result.stdout)

    def test_check_different_order(self):
        self.write_allowlist(BASE_HEADER + "open/second\nopen/first\n")
        result = self.run_script("check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("MODELS_OUT_OF_SYNC", result.stdout)
        self.assertIn("ORDER_MISMATCH", result.stdout)
        self.assertNotIn("EXTRA", result.stdout)
        self.assertNotIn("MISSING", result.stdout)

    def test_check_file_missing(self):
        result = self.run_script("check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("MODELS_OUT_OF_SYNC", result.stdout)

    def test_check_ignores_comments_and_blank_lines(self):
        self.write_allowlist("# any comment\n\nopen/first\n\nopen/second\n")
        result = self.run_script("check")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "MODELS_IN_SYNC\n")

    def test_check_all_passes_when_every_copy_matches(self):
        self.write_allowlist(BASE_HEADER + "open/first\nopen/second\n")
        worktree = self.make_worktree("wt-a")
        self.write_allowlist(BASE_HEADER + "open/first\nopen/second\n", base=worktree)
        result = self.run_script("check", "--all")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "MODELS_IN_SYNC\n")

    def test_check_all_fails_on_one_worktree_mismatch(self):
        self.write_allowlist(BASE_HEADER + "open/first\nopen/second\n")
        worktree = self.make_worktree("wt-a")
        self.write_allowlist(BASE_HEADER + "open/first\n", base=worktree)
        result = self.run_script("check", "--all")
        self.assertEqual(result.returncode, 1)
        self.assertIn("MODELS_OUT_OF_SYNC", result.stdout)
        self.assertIn("MISSING open/second", result.stdout)

    def test_check_all_fails_when_worktree_file_missing(self):
        self.write_allowlist(BASE_HEADER + "open/first\nopen/second\n")
        self.make_worktree("wt-a")
        result = self.run_script("check", "--all")
        self.assertEqual(result.returncode, 1)
        self.assertIn("MODELS_OUT_OF_SYNC", result.stdout)

    def test_check_all_skips_worktree_without_opencode(self):
        self.write_allowlist(BASE_HEADER + "open/first\nopen/second\n")
        self.make_worktree("wt-a", with_opencode=False)
        result = self.run_script("check", "--all")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "MODELS_IN_SYNC\n")


class OrderTests(ScriptTestCase):
    def test_order_prints_only_active_positive_orders(self):
        self.write_table(
            model_block(
                "opencode-go/glm-5.3",
                pool="go",
                order=0,
                variants=("low", "high", "max"),
                context=0,
            )
            + model_block(
                "opencode/deepseek-v4.1-flash-free",
                order=1,
                variants=("low", "high"),
                context=200000,
                skip_for_context=False,
            )
            + model_block(
                "opencode/glm-5.3-flash-free",
                order=2,
                variants=("low", "high", "max"),
                context=200000,
                skip_for_context=True,
            )
            + model_block("opencode/paused", order=3, status="paused")
        )
        result = self.run_script("order")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.stdout,
            "1 opencode/deepseek-v4.1-flash-free pool=free variants=low,high context=200000 skip_for_context=false\n"
            "2 opencode/glm-5.3-flash-free pool=free variants=low,high,max context=200000 skip_for_context=true\n",
        )


class ShowTests(ScriptTestCase):
    def setUp(self):
        super().setUp()
        self.write_table(
            model_block(
                "opencode/first",
                pool="free",
                order=1,
                variants=("low", "high", "max"),
                context=200000,
                status="active",
                skip_for_context=True,
                note="a fact",
                updated="2026-10-21",
            )
        )

    def test_show_prints_all_fields(self):
        result = self.run_script("show", "opencode/first")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.stdout,
            "id=opencode/first\n"
            "pool=free\n"
            "order=1\n"
            "variants=low,high,max\n"
            "context=200000\n"
            "status=active\n"
            "skip_for_context=true\n"
            "note=a fact\n"
            "updated=2026-10-21\n",
        )

    def test_show_unknown_id(self):
        result = self.run_script("show", "opencode/missing")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "MODEL_UNKNOWN opencode/missing\n")


class InvalidTableTests(ScriptTestCase):
    def test_missing_field(self):
        self.write_table(
            "[[model]]\n"
            'id = "open/first"\n'
            'pool = "free"\n'
            "order = 1\n"
            'variants = ["low"]\n'
            "context = 200000\n"
            'status = "active"\n'
            "skip_for_context = false\n"
            'updated = "2026-10-21"\n'
        )
        result = self.run_script("check")
        self.assertEqual(result.returncode, 3)
        self.assertIn("TABLE_INVALID", result.stdout)
        self.assertIn("note", result.stdout)

    def test_unknown_pool(self):
        self.write_table(model_block("open/first", pool="paid", order=1))
        result = self.run_script("export")
        self.assertEqual(result.returncode, 3)
        self.assertIn("TABLE_INVALID", result.stdout)
        self.assertIn("paid", result.stdout)

    def test_unknown_status(self):
        self.write_table(model_block("open/first", order=1, status="retired"))
        result = self.run_script("order")
        self.assertEqual(result.returncode, 3)
        self.assertIn("TABLE_INVALID", result.stdout)
        self.assertIn("retired", result.stdout)

    def test_duplicate_id(self):
        self.write_table(model_block("open/first", order=1) + model_block("open/first", order=2))
        result = self.run_script("show", "open/first")
        self.assertEqual(result.returncode, 3)
        self.assertIn("TABLE_INVALID", result.stdout)
        self.assertIn("duplicate id", result.stdout)

    def test_duplicate_nonzero_order(self):
        self.write_table(model_block("open/first", order=1) + model_block("open/second", order=1))
        result = self.run_script("check")
        self.assertEqual(result.returncode, 3)
        self.assertIn("TABLE_INVALID", result.stdout)
        self.assertIn("duplicate order", result.stdout)


if __name__ == "__main__":
    unittest.main()
