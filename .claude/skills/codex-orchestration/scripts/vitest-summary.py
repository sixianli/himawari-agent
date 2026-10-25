#!/usr/bin/env python3
import json
import sys
from collections import Counter


def main(paths):
    if not paths:
        print("usage: vitest-summary.py <vitest-json-report>...", file=sys.stderr)
        return 2
    grand = Counter()
    problems = []
    for path in paths:
        with open(path) as handle:
            report = json.load(handle)
        counts = Counter()
        for suite in report.get("testResults", []):
            if suite.get("status") != "passed" and not suite.get("assertionResults"):
                problems.append(f"{path}: suite {suite.get('name')} status {suite.get('status')} with no assertions")
            for assertion in suite.get("assertionResults", []):
                status = assertion.get("status")
                counts[status] += 1
                if status != "passed":
                    problems.append(f"{path}: {status}: {assertion.get('fullName')}")
        declared = report.get("numTotalTests")
        counted = sum(counts.values())
        mismatch = "" if declared in (None, counted) else f"  (numTotalTests says {declared})"
        print(f"{path}: {counted} assertions {dict(counts)}{mismatch}")
        if mismatch:
            problems.append(f"{path}: counted {counted} assertions but numTotalTests is {declared}")
        grand.update(counts)
    print(f"total: {sum(grand.values())} {dict(grand)}")
    for line in problems:
        print(line)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
