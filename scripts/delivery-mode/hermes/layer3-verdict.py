#!/usr/bin/env python3
import json
import sys

ALLOWED_PUBLICATION_ERRORS = {"SECURITY_REVIEW_HTTP_NOT_FOUND"}


def fail(reason):
    print(f"LAYER3_VERDICT_FAILED {reason}")
    raise SystemExit(1)


def main(argv):
    if len(argv) != 3:
        fail(
            "usage layer3-verdict.py <local-summary.json> <tested sha> "
            "<required checks comma separated>"
        )
    path, tested_sha, required = argv
    required_checks = required.split(",")
    try:
        with open(path, encoding="utf-8") as handle:
            summary = json.load(handle)
    except FileNotFoundError:
        fail(f"MISSING_FILE {path}")
    except json.JSONDecodeError as error:
        fail(f"INVALID_JSON {path}: {error}")
    if not isinstance(summary, dict):
        fail(f"INVALID_JSON {path}: top level is not an object")
    context = summary.get("context")
    if not isinstance(context, dict) or "testedSha" not in context:
        fail("MISSING_FIELD context.testedSha")
    if context["testedSha"] != tested_sha:
        fail(f"TESTED_SHA expected={tested_sha} actual={context['testedSha']}")
    checks = summary.get("checks")
    if not isinstance(checks, list):
        fail("MISSING_FIELD checks")
    statuses = {}
    for entry in checks:
        if not isinstance(entry, dict) or "checkId" not in entry or "status" not in entry:
            fail("MISSING_FIELD checks[].checkId or checks[].status")
        check_id = entry["checkId"]
        if check_id in statuses:
            fail(f"DUPLICATE_CHECK {check_id}")
        statuses[check_id] = entry["status"]
    if set(statuses) != set(required_checks):
        fail(f"CHECKS expected={','.join(required_checks)} actual={','.join(sorted(statuses))}")
    for check in required_checks:
        if statuses[check] != "passed":
            fail(f"CHECK_NOT_PASSED {check}={statuses[check]}")
    if "publicationFailures" not in summary:
        fail("MISSING_FIELD publicationFailures")
    failures = summary["publicationFailures"]
    if not isinstance(failures, list):
        fail("MISSING_FIELD publicationFailures: not a list")
    for entry in failures:
        error = entry.get("error") if isinstance(entry, dict) else None
        if error not in ALLOWED_PUBLICATION_ERRORS:
            fail(f"PUBLICATION_FAILURE {error}")
    print(f"LAYER3_VERDICT_PASSED checks={','.join(required_checks)}")


main(sys.argv[1:])
