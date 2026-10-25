import argparse
import datetime as dt
import inspect
import sys
import time
import traceback
import unittest
from pathlib import Path
from xml.etree import ElementTree

SEVERITY = ("passed", "skipped", "failure", "error")


class Collector(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.cases = {}
        self.clock = {}

    def entry(self, test):
        return self.cases.setdefault(test.id(), {"test": test, "outcome": "passed", "message": "", "detail": "", "seconds": 0.0})

    def mark(self, test, outcome, message, err=None):
        entry = self.entry(test)
        if SEVERITY.index(outcome) > SEVERITY.index(entry["outcome"]):
            detail = "".join(traceback.format_exception(*err)) if err else ""
            entry.update(outcome=outcome, message=message, detail=detail)

    def startTest(self, test):
        super().startTest(test)
        self.entry(test)
        self.clock[test.id()] = time.perf_counter()

    def stopTest(self, test):
        super().stopTest(test)
        started = self.clock.pop(test.id(), None)
        if started is not None:
            self.entry(test)["seconds"] = time.perf_counter() - started

    def addError(self, test, err):
        super().addError(test, err)
        self.mark(test, "error", str(err[1]), err)

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.mark(test, "failure", str(err[1]), err)

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.mark(test, "skipped", reason)

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.mark(test, "failure", "unexpected success")

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            outcome = "failure" if issubclass(err[0], test.failureException) else "error"
            self.mark(test, outcome, f"{subtest.id()}: {err[1]}", err)


def source_file(test, root):
    try:
        path = inspect.getsourcefile(type(test))
    except TypeError:
        return None
    if not path:
        return None
    try:
        return Path(path).resolve().relative_to(root).as_posix()
    except ValueError:
        return None


def names_of(test):
    classname = f"{type(test).__module__}.{type(test).__qualname__}"
    name = test.id()
    return classname, name.removeprefix(classname + ".")


def write_report(collector, out, started, seconds, root):
    entries = list(collector.cases.values())
    totals = {outcome: sum(entry["outcome"] == outcome for entry in entries) for outcome in SEVERITY}
    suite = ElementTree.Element("testsuite", {
        "name": "unittest",
        "tests": str(len(entries)),
        "failures": str(totals["failure"]),
        "errors": str(totals["error"]),
        "skipped": str(totals["skipped"]),
        "timestamp": started.isoformat(timespec="seconds"),
        "time": f"{seconds:.3f}",
    })
    for entry in entries:
        classname, name = names_of(entry["test"])
        case = ElementTree.SubElement(suite, "testcase", {"classname": classname, "name": name, "time": f"{entry['seconds']:.3f}"})
        path = source_file(entry["test"], root)
        if path:
            case.set("file", path)
        if entry["outcome"] != "passed":
            child = ElementTree.SubElement(case, entry["outcome"], {"message": entry["message"][:500]})
            child.text = entry["detail"]
    root_element = ElementTree.Element("testsuites")
    root_element.append(suite)
    out.parent.mkdir(parents=True, exist_ok=True)
    ElementTree.ElementTree(root_element).write(out, encoding="utf-8", xml_declaration=True)
    return totals


def main(argv=None):
    parser = argparse.ArgumentParser(description="用标准库跑 unittest，结果写成 JUnit XML 报告")
    parser.add_argument("--start", required=True, help="测试目录，和 unittest discover -s 相同")
    parser.add_argument("--pattern", default="test_*.py")
    parser.add_argument("--out", required=True, help="报告文件")
    args = parser.parse_args(argv)
    root = Path.cwd().resolve()
    suite = unittest.defaultTestLoader.discover(args.start, pattern=args.pattern)
    collector = Collector()
    started = dt.datetime.now().astimezone()
    clock = time.perf_counter()
    suite.run(collector)
    totals = write_report(collector, Path(args.out), started, time.perf_counter() - clock, root)
    print(f"通过 {totals['passed']}，失败 {totals['failure']}，出错 {totals['error']}，跳过 {totals['skipped']}；报告 {args.out}")
    return 1 if totals["failure"] or totals["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
