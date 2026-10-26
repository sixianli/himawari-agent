import hashlib
import json
import sys
from pathlib import Path

packet = Path(sys.argv[1])
expected_changes = set(sys.argv[2].split(",")) if len(sys.argv) > 2 and sys.argv[2] else set()
apply = "--apply" in sys.argv[3:]
draft = packet / "acceptance/cloud/cloud-inputs.draft.json"
raw = draft.read_text()
manifest = json.loads(raw)
if json.dumps(manifest, indent=2) + "\n" != raw:
    raise SystemExit("DRAFT_FORMAT_NOT_ROUND_TRIP")
changes = {}
for relative, recorded in manifest["files"].items():
    actual = hashlib.sha256((packet / "acceptance/cloud" / relative).read_bytes()).hexdigest()
    if actual != recorded:
        changes[relative] = (recorded, actual)
for relative, (before, after) in sorted(changes.items()):
    print(f"UPDATE {relative} {before[:16]} -> {after[:16]}")
print(f"{len(changes)} of {len(manifest['files'])} entries differ")
if set(changes) != expected_changes:
    raise SystemExit(f"UNEXPECTED_CHANGE_SET missing={sorted(expected_changes - set(changes))} extra={sorted(set(changes) - expected_changes)}")
if apply:
    for relative, (_, after) in changes.items():
        manifest["files"][relative] = after
    draft.write_text(json.dumps(manifest, indent=2) + "\n")
    print("applied")
