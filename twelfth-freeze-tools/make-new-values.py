import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

if len(sys.argv) not in (4, 5):
    raise SystemExit("usage: make-new-values.py <revision> <run-cand output> <new-values out> [<regression revision>]")
head, run_output, target = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
regression_revision = sys.argv[4] if len(sys.argv) == 5 else head
if not re.fullmatch(r"[0-9a-f]{40}", head):
    raise SystemExit("REVISION_INVALID")
if not re.fullmatch(r"[0-9a-f]{40}", regression_revision):
    raise SystemExit("REGRESSION_REVISION_INVALID")
if target.exists():
    raise SystemExit(f"TARGET_EXISTS {target}")
repo = Path(__file__).resolve().parents[3]
packet = repo / ".ci-output/production/2026-10-26-twelfth-change-packet-01"
PRODUCT_PATH = re.compile(r"^(?:apps/|packages/|assets/|tsconfig[^/]*\.json\Z|package(?:-lock)?\.json\Z)")
NOT_PRODUCT = re.compile(r"(?:^|/)(?:dist|node_modules|test)(?:/|\Z)|\.test\.")


def commit_exists(revision):
    return subprocess.run(
        ["git", "cat-file", "-e", f"{revision}^{{commit}}"], capture_output=True, cwd=repo,
    ).returncode == 0


if regression_revision != head:
    if not commit_exists(head):
        raise SystemExit("REVISION_NOT_FOUND")
    if not commit_exists(regression_revision):
        raise SystemExit("REGRESSION_REVISION_NOT_FOUND")
    if subprocess.run(["git", "merge-base", "--is-ancestor", head, regression_revision], capture_output=True, cwd=repo).returncode != 0:
        raise SystemExit("REGRESSION_REVISION_NOT_DESCENDANT")
    diff = subprocess.run(
        ["git", "diff", "--no-renames", "--name-only", "-z", head, regression_revision],
        capture_output=True, cwd=repo,
    )
    if diff.returncode != 0:
        raise SystemExit("REGRESSION_DIFF_FAILED")
    changed = [path for path in diff.stdout.decode("utf-8").split("\0") if path]
    product = [path for path in changed if PRODUCT_PATH.search(path) and not NOT_PRODUCT.search(path)]
    if product:
        raise SystemExit("\n".join(f"REGRESSION_REVISION_CHANGES_PRODUCT {path}" for path in product))
    print(f"REGRESSION_REVISION {regression_revision} changed={len(changed)}", file=sys.stderr)
    for path in changed:
        if not path.startswith(("test/", "docs/", ".agents/")) and "/test/" not in path and path != "AGENTS.md":
            print(f"REGRESSION_REVISION_OTHER_CHANGE {path}", file=sys.stderr)
text = run_output.read_text()
lines = text.splitlines()
if lines[-1:] != ["CAND_OK"]:
    raise SystemExit("RUN_CAND_NOT_OK")

start = lines.index("{")
end = lines.index("}", start)
build = json.loads("\n".join(lines[start:end + 1]))
sums = {}
sizes = {}
for line in lines[end + 1:]:
    digest = re.fullmatch(r"([0-9a-f]{64})  (\S+)", line)
    size = re.fullmatch(r"([0-9]+) (\S+)", line)
    if digest:
        sums.setdefault(Path(digest.group(2)).name, set()).add(digest.group(1))
    elif size:
        sizes.setdefault(Path(size.group(2)).name, set()).add(int(size.group(1)))


def one(table, name):
    values = table.get(name, set())
    if len(values) != 1:
        raise SystemExit(f"VALUE_NOT_UNIQUE {name} {sorted(values)}")
    return next(iter(values))


records = re.findall(r"^capture records ([0-9]+) ", text, re.M)
if len(records) != 1:
    raise SystemExit("CAPTURE_RECORD_LINE_NOT_UNIQUE")
if one(sums, build["artifactName"]) != build["artifactSha256"] or one(sizes, build["artifactName"]) != build["artifactBytes"]:
    raise SystemExit("ARTIFACT_SUMS_DIFFER_FROM_BUILD")
if one(sums, "context.json") != build["contextSha256"] or one(sizes, "context.json") != build["contextBytes"]:
    raise SystemExit("CONTEXT_SUMS_DIFFER_FROM_BUILD")

bundle = packet / "materials" / f"source-{head[:7]}.bundle"
bundle_data = bundle.read_bytes()
heads = subprocess.run(["git", "bundle", "list-heads", str(bundle)], capture_output=True, text=True, check=True).stdout.strip()
if heads != f"{head} HEAD":
    raise SystemExit(f"BUNDLE_HEADS_UNEXPECTED {heads}")
regression_read = subprocess.run(["git", "cat-file", "blob", f"{regression_revision}:test/integration/product-path-browser.test.ts"], capture_output=True, cwd=repo)
if regression_read.returncode != 0:
    raise SystemExit(f"REGRESSION_SOURCE_MISSING {regression_revision}")
regression = regression_read.stdout

values = {
    "head": head,
    "bundleName": bundle.name,
    "bundleSha256": hashlib.sha256(bundle_data).hexdigest(),
    "bundleBytes": len(bundle_data),
    "artifactName": build["artifactName"],
    "artifactSha256": build["artifactSha256"],
    "artifactBytes": build["artifactBytes"],
    "contextSha256": build["contextSha256"],
    "contextBytes": build["contextBytes"],
    "nodeModulesTarSha256": one(sums, "node-modules.tar.gz"),
    "nodeModulesTarBytes": one(sizes, "node-modules.tar.gz"),
    "nodeModulesJsonSha256": one(sums, "node-modules.json"),
    "nodeModulesJsonBytes": one(sizes, "node-modules.json"),
    "npmLsSha256": one(sums, "npm-ls.json"),
    "npmLsBytes": one(sizes, "npm-ls.json"),
    "sourceTreeSha256": build["sourceTreeSha256"],
    "regressionSourceSha256": hashlib.sha256(regression).hexdigest(),
    "regressionSourceBytes": len(regression),
    "sourceInputRecordCount": int(records[0]),
}
with open(target, "x") as handle:
    json.dump(values, handle, indent=2)
    handle.write("\n")
print(json.dumps(values, indent=2))
