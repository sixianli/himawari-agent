import datetime as dt
import subprocess
import sys
import unittest
from pathlib import Path
from xml.etree import ElementTree

from test_longtask import Base, item, write

RUNNER = Path(__file__).resolve().parent / "junit_report.py"

MIXED = """import unittest


class SampleTests(unittest.TestCase):
    def test_passes(self):
        self.assertTrue(True)

    def test_fails(self):
        self.assertEqual(1, 2)

    def test_raises(self):
        raise RuntimeError("boom")

    @unittest.skip("not now")
    def test_skipped(self):
        pass

    def test_subtest_fails(self):
        for value in (1, 2):
            with self.subTest(value=value):
                self.assertEqual(value, 1)
"""

PASSING = """import unittest


class SampleTests(unittest.TestCase):
    def test_passes(self):
        self.assertTrue(True)

    def test_more(self):
        self.assertTrue(True)
"""


class JUnitReportTests(Base):
    def run_report(self, cwd, start, out):
        return subprocess.run(
            [sys.executable, str(RUNNER), "--start", start, "--out", str(out)],
            cwd=cwd, env=self.env, capture_output=True, text=True, timeout=120, check=False,
        )

    def test_report_marks_every_outcome(self):
        project = self.root / "project"
        write(project, "pkg/tests/test_sample.py", MIXED)
        out = self.root / "report.xml"
        result = self.run_report(project, "pkg/tests", out)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        suite = ElementTree.parse(out).getroot().find("testsuite")
        cases = {case.get("name"): case for case in suite.iter("testcase")}
        self.assertEqual({name: [child.tag for child in case] for name, case in cases.items()}, {
            "test_passes": [],
            "test_fails": ["failure"],
            "test_raises": ["error"],
            "test_skipped": ["skipped"],
            "test_subtest_fails": ["failure"],
        })
        self.assertEqual({case.get("file") for case in cases.values()}, {"pkg/tests/test_sample.py"})
        self.assertEqual({case.get("classname") for case in cases.values()}, {"test_sample.SampleTests"})
        counts = tuple(suite.get(key) for key in ("tests", "failures", "errors", "skipped"))
        self.assertEqual(counts, ("5", "2", "1", "1"))
        self.assertIsNotNone(dt.datetime.fromisoformat(suite.get("timestamp")).tzinfo)

    def test_recorded_report_satisfies_selector_checks(self):
        repo = self.make_repo()
        write(repo, "pkg/tests/test_sample.py", PASSING)
        self.commit_all(repo, "sample")
        self.init_task(repo, [item("T-J1", [{"type": "test", "file": "pkg/tests/test_sample.py", "name": "test_passes"}])])
        out = self.root / "report.xml"
        result = self.run_report(repo, "pkg/tests", out)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.ok(self.cli(repo, "record", "--junit", str(out), "--by", "claude"))
        record = self.records(repo)[-1]
        self.assertEqual(record["counts"], {"passed": 2, "failed": 0, "skipped": 0})
        self.assertEqual(record["selected"], [{"file": "pkg/tests/test_sample.py", "name": "test_passes", "passed": 1, "failed": 0}])
        self.assertNotIn("unresolved_files", record)
        self.assertIn("ran_at", record)
        self.assertEqual(self.status_of(repo, "T-J1"), "verified")


if __name__ == "__main__":
    unittest.main()
