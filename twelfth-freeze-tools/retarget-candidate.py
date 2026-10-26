import argparse
import json
import re
import sys
from pathlib import Path

NEW_KEYS = {
    "head", "bundleName", "bundleSha256", "bundleBytes", "artifactName", "artifactSha256", "artifactBytes",
    "contextSha256", "contextBytes", "nodeModulesTarSha256", "nodeModulesTarBytes", "nodeModulesJsonSha256",
    "nodeModulesJsonBytes", "npmLsSha256", "npmLsBytes", "sourceTreeSha256", "regressionSourceSha256",
    "regressionSourceBytes", "sourceInputRecordCount",
}
HEX64 = re.compile(r"[0-9a-f]{64}")

TEXT_REPLACEMENTS = [
    ("head", {
        "install/p5-materials.json", "install/extract-node-modules.py", "install/twelfth-artifact-install.mjs",
        "install/S9-clean-transport.py", "install/collect-installer-dependencies.mjs", "install/verify-dependency-export.py",
        "signing/sign-twelfth.sh", "systemd/S7-startup-readback.mjs", "acceptance/cloud/finalize-cloud-inputs.py",
        "acceptance/cloud/cloud-inputs.draft.json", "acceptance/cloud/candidate-inputs.json",
        "acceptance/cloud/question-12-inputs.json", "acceptance/cloud/composition-source-contract.json",
        "acceptance/cloud/carry-forward-audit.json", "acceptance/cloud/adaptation-manifest.json",
        "acceptance/cloud/r2l6-source-manifest.json", "acceptance/cloud/prepare-composition-source.py",
        "acceptance/helpers/extract-node-modules.py", "acceptance/helpers/collect-installer-dependencies.mjs",
        "acceptance/helpers/run-hermes-rehearsal.py", "inputs/bindings.draft.json",
    }),
    ("bundleName", {"install/p5-materials.json", "install/twelfth-artifact-install.mjs", "install/S9-clean-transport.py"}),
    ("bundleSha256", {"install/p5-materials.json", "install/twelfth-artifact-install.mjs"}),
    ("artifactSha256", {
        "install/p5-materials.json", "install/twelfth-artifact-install.mjs", "acceptance/cloud/cloud-inputs.draft.json",
        "acceptance/cloud/question-12-inputs.json", "acceptance/cloud/finalize-cloud-inputs.py",
        "acceptance/helpers/run-hermes-rehearsal.py", "acceptance/cloud/candidate-inputs.json",
    }),
    ("artifactBytes", {
        "install/p5-materials.json", "acceptance/cloud/cloud-inputs.draft.json", "acceptance/cloud/finalize-cloud-inputs.py",
        "acceptance/cloud/candidate-inputs.json", "acceptance/cloud/question-12-inputs.json",
    }),
    ("contextSha256", {
        "install/p5-materials.json", "install/twelfth-artifact-install.mjs", "acceptance/cloud/cloud-inputs.draft.json",
        "acceptance/cloud/finalize-cloud-inputs.py", "acceptance/cloud/question-12-inputs.json",
        "acceptance/cloud/candidate-inputs.json", "acceptance/helpers/run-hermes-rehearsal.py",
    }),
    ("sourceTreeSha256", {"install/twelfth-artifact-install.mjs"}),
]
ARTIFACT_NAME_FILES = {"install/p5-materials.json", "install/S9-clean-transport.py"}
P5_ONLY = ["bundleBytes", "contextBytes", "nodeModulesTarSha256", "nodeModulesTarBytes", "nodeModulesJsonSha256",
           "nodeModulesJsonBytes", "npmLsSha256", "npmLsBytes"]
REGRESSION_FILES = ["acceptance/cloud/adaptation-manifest.json", "acceptance/cloud/r2l6-source-manifest.json"]


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def governed_files(packet):
    return sorted(
        path for path in packet.rglob("*")
        if path.is_file() and path.suffix != ".md" and path.name != "OWNED-SHA256SUMS"
        and path.relative_to(packet).parts[0] != "materials"
    )


def holders(packet, needle):
    return {str(path.relative_to(packet)) for path in governed_files(packet) if str(needle) in path.read_text(errors="ignore")}


def load_new(path):
    new = json.loads(Path(path).read_text())
    if set(new) != NEW_KEYS:
        fail(f"NEW_VALUES_KEYS_INVALID missing={sorted(NEW_KEYS - set(new))} extra={sorted(set(new) - NEW_KEYS)}")
    if not re.fullmatch(r"[0-9a-f]{40}", new["head"]):
        fail("NEW_HEAD_INVALID")
    if new["bundleName"] != f"source-{new['head'][:7]}.bundle":
        fail("NEW_BUNDLE_NAME_INVALID")
    if not re.fullmatch(rf"linux-x64-abi127-{new['head']}-[0-9]+-1\.tar\.gz", new["artifactName"]):
        fail("NEW_ARTIFACT_NAME_INVALID")
    for key, value in new.items():
        if key.endswith("Sha256") and not HEX64.fullmatch(value):
            fail(f"NEW_SHA256_INVALID {key}")
        if (key.endswith("Bytes") or key.endswith("Count")) and (not isinstance(value, int) or value <= 0):
            fail(f"NEW_BYTES_INVALID {key}")
    return new


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--packet", required=True)
    parser.add_argument("--old-values", required=True)
    parser.add_argument("--new-values", required=True)
    parser.add_argument("--apply", action="store_true")
    arguments = parser.parse_args()
    packet = Path(arguments.packet).resolve()
    global OLD
    OLD = load_new(arguments.old_values)
    new = load_new(arguments.new_values)
    if new["head"] == OLD["head"]:
        fail("NEW_HEAD_EQUALS_OLD_HEAD")
    old_record_count_text = f"sourceInputProof.records.length === {OLD['sourceInputRecordCount']},"

    for key, expected in TEXT_REPLACEMENTS:
        found = holders(packet, OLD[key])
        if found != expected:
            fail(f"OLD_VALUE_HOLDERS_CHANGED {key} unexpected={sorted(found - expected)} missing={sorted(expected - found)}")
    if holders(packet, OLD["artifactName"]) != ARTIFACT_NAME_FILES:
        fail("OLD_ARTIFACT_NAME_HOLDERS_CHANGED")

    changes = {}

    def edit(relative, transform, old_value):
        path = packet / relative
        before = changes.get(relative, path.read_text())
        after = transform(before)
        if str(old_value) in after:
            fail(f"OLD_VALUE_NOT_REPLACED {relative}")
        changes[relative] = after

    edit_p5 = "install/p5-materials.json"
    materials = json.loads((packet / edit_p5).read_text())
    if materials.get("purpose") not in ("cloud-twelfth-install",):
        fail("P5_PURPOSE_UNEXPECTED")
    by_name = {item["name"]: item for item in materials["files"]}
    expected_files = {
        OLD["bundleName"]: (OLD["bundleBytes"], OLD["bundleSha256"]),
        "candidate.tar.gz": (OLD["artifactBytes"], OLD["artifactSha256"]),
        "context.json": (OLD["contextBytes"], OLD["contextSha256"]),
        "node-modules.tar.gz": (OLD["nodeModulesTarBytes"], OLD["nodeModulesTarSha256"]),
        "node-modules.json": (OLD["nodeModulesJsonBytes"], OLD["nodeModulesJsonSha256"]),
        "npm-ls.json": (OLD["npmLsBytes"], OLD["npmLsSha256"]),
    }
    for name, (size, digest) in expected_files.items():
        item = by_name.get(name)
        if not item or item["bytes"] != size or item["sha256"] != digest:
            fail(f"P5_OLD_ENTRY_CHANGED {name}")
    replacement = {
        OLD["bundleName"]: (new["bundleName"], new["bundleBytes"], new["bundleSha256"]),
        "candidate.tar.gz": ("candidate.tar.gz", new["artifactBytes"], new["artifactSha256"]),
        "context.json": ("context.json", new["contextBytes"], new["contextSha256"]),
        "node-modules.tar.gz": ("node-modules.tar.gz", new["nodeModulesTarBytes"], new["nodeModulesTarSha256"]),
        "node-modules.json": ("node-modules.json", new["nodeModulesJsonBytes"], new["nodeModulesJsonSha256"]),
        "npm-ls.json": ("npm-ls.json", new["npmLsBytes"], new["npmLsSha256"]),
    }
    for item in materials["files"]:
        if item["name"] in replacement:
            name, size, digest = replacement[item["name"]]
            item["name"], item["bytes"], item["sha256"] = name, size, digest
            if name == "candidate.tar.gz":
                item["sourceName"] = new["artifactName"]
    materials["purpose"] = "cloud-twelfth-install"
    materials["sourceHead"] = new["head"]
    changes[edit_p5] = json.dumps(materials, indent=2, ensure_ascii=False) + "\n"

    for relative in sorted(ARTIFACT_NAME_FILES - {edit_p5}):
        edit(relative, lambda text: text.replace(OLD["artifactName"], new["artifactName"]), OLD["artifactName"])
    for key, files in TEXT_REPLACEMENTS:
        for relative in sorted(files - {edit_p5}):
            edit(relative, lambda text, k=key: text.replace(str(OLD[k]), str(new[k])), OLD[key])

    installer = "install/twelfth-artifact-install.mjs"
    if holders(packet, old_record_count_text) != {installer}:
        fail("OLD_RECORD_COUNT_HOLDERS_CHANGED")
    edit(installer, lambda text: text.replace(old_record_count_text, f"sourceInputProof.records.length === {new['sourceInputRecordCount']},"), old_record_count_text if new["sourceInputRecordCount"] != OLD["sourceInputRecordCount"] else "\0")

    for relative in REGRESSION_FILES:
        data = json.loads(changes.get(relative, (packet / relative).read_text()))
        holder = data["regressionSource"] if "regressionSource" in data else data["r2l6"]["regressionSource"]
        if holder["path"] != "test/integration/product-path-browser.test.ts" or holder["carriedForCloudExecution"] is not False:
            fail(f"REGRESSION_SOURCE_UNEXPECTED {relative}")
        holder["sha256"], holder["bytes"] = new["regressionSourceSha256"], new["regressionSourceBytes"]
        changes[relative] = json.dumps(data, indent=2, ensure_ascii=False) + "\n"

    leftovers = []
    for relative, text in changes.items():
        for key in ["head", "bundleName", "bundleSha256", "artifactSha256", "artifactName", "contextSha256", "sourceTreeSha256"] + P5_ONLY:
            if str(OLD[key]) != str(new[key]) and str(OLD[key]) in text and not (key.endswith("Bytes") and not re.search(rf"\b{OLD[key]}\b", text)):
                leftovers.append(f"{relative}:{key}")
    if leftovers:
        fail("OLD_VALUES_LEFT " + " ".join(leftovers))

    print(json.dumps({"apply": arguments.apply, "files": sorted(changes)}, indent=2))
    if arguments.apply:
        for relative, text in changes.items():
            (packet / relative).write_text(text)


main()
