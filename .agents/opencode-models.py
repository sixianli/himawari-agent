#!/usr/bin/env python3
import argparse
import sys
import tomllib
from pathlib import Path

REQUIRED_FIELDS = (
    "id",
    "pool",
    "order",
    "variants",
    "context",
    "status",
    "skip_for_context",
    "note",
    "updated",
)
ALLOWED_POOLS = ("free", "go")
ALLOWED_STATUSES = ("active", "paused", "withdrawn")
ALLOWLIST_RELATIVE = Path(".opencode") / "allowed-models.txt"
HEADER_LINES = (
    "# Generated from .agents/opencode-models.toml by .agents/opencode-models.py; do not edit by hand.",
    "# Run: python3 .agents/opencode-models.py export",
)
TABLE_RELATIVE = Path(".agents") / "opencode-models.toml"


class TableInvalid(Exception):
    pass


def repository_root():
    return Path(__file__).resolve().parent.parent


def load_table(root):
    path = root / TABLE_RELATIVE
    if not path.is_file():
        raise TableInvalid(f"table file not found: {TABLE_RELATIVE}")
    try:
        with path.open("rb") as handle:
            data = tomllib.load(handle)
    except tomllib.TOMLDecodeError as error:
        raise TableInvalid(f"cannot parse {TABLE_RELATIVE}: {error}") from error
    models = data.get("model")
    if not isinstance(models, list) or not models:
        raise TableInvalid("no [[model]] entries")
    seen_ids = set()
    seen_orders = set()
    for index, model in enumerate(models, start=1):
        if not isinstance(model, dict):
            raise TableInvalid(f"model {index} is not a table")
        for field in REQUIRED_FIELDS:
            if field not in model:
                raise TableInvalid(f"missing field '{field}' in model {index}")
        model_id = model["id"]
        if not isinstance(model_id, str) or not model_id:
            raise TableInvalid(f"model {index} has an empty or non-string id")
        if model_id in seen_ids:
            raise TableInvalid(f"duplicate id '{model_id}'")
        seen_ids.add(model_id)
        if model["pool"] not in ALLOWED_POOLS:
            raise TableInvalid(f"unknown pool '{model['pool']}' for '{model_id}'")
        if model["status"] not in ALLOWED_STATUSES:
            raise TableInvalid(f"unknown status '{model['status']}' for '{model_id}'")
        order = model["order"]
        if not isinstance(order, int) or isinstance(order, bool) or order < 0:
            raise TableInvalid(f"order for '{model_id}' must be a non-negative integer")
        if order != 0:
            if order in seen_orders:
                raise TableInvalid(f"duplicate order {order}")
            seen_orders.add(order)
        variants = model["variants"]
        if not isinstance(variants, list) or not all(isinstance(v, str) for v in variants):
            raise TableInvalid(f"variants for '{model_id}' must be a list of strings")
        context = model["context"]
        if not isinstance(context, int) or isinstance(context, bool) or context < 0:
            raise TableInvalid(f"context for '{model_id}' must be a non-negative integer")
        if not isinstance(model["skip_for_context"], bool):
            raise TableInvalid(f"skip_for_context for '{model_id}' must be true or false")
        if not isinstance(model["note"], str):
            raise TableInvalid(f"note for '{model_id}' must be a string")
        if not isinstance(model["updated"], str):
            raise TableInvalid(f"updated for '{model_id}' must be a string")
    return models


def sorting_key(model):
    order = model["order"]
    return (order == 0, order, model["id"])


def ordered_ids(models):
    active = [model for model in models if model["status"] == "active"]
    return [model["id"] for model in sorted(active, key=sorting_key)]


def read_listed_ids(path):
    if not path.is_file():
        return None
    ids = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        ids.append(stripped)
    return ids


def write_allowlist(path, ids):
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(HEADER_LINES + tuple(ids)) + "\n"
    path.write_text(body, encoding="utf-8")


def worktree_roots(root):
    base = root / ".ci-output" / "worktrees"
    if not base.is_dir():
        return []
    return [
        entry
        for entry in sorted(base.iterdir())
        if entry.is_dir() and (entry / ".opencode").is_dir()
    ]


def display_path(root, path):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def report_mismatch(root, path, expected):
    listed = read_listed_ids(path)
    label = display_path(root, path)
    if listed is None:
        print(f"missing allowlist file {label}")
        return
    if listed == expected:
        return
    print(f"allowlist file {label}")
    for model_id in listed:
        if model_id not in expected:
            print(f"EXTRA {model_id}")
    for model_id in expected:
        if model_id not in listed:
            print(f"MISSING {model_id}")
    if set(listed) == set(expected) and listed != expected:
        print("ORDER_MISMATCH")


def command_export(root, check_all):
    models = load_table(root)
    ids = ordered_ids(models)
    targets = [root / ALLOWLIST_RELATIVE]
    if check_all:
        targets.extend(worktree / ALLOWLIST_RELATIVE for worktree in worktree_roots(root))
    for target in targets:
        write_allowlist(target, ids)
        print(f"EXPORTED {display_path(root, target)} {len(ids)}")
    return 0


def command_check(root, check_all):
    models = load_table(root)
    ids = ordered_ids(models)
    targets = [root / ALLOWLIST_RELATIVE]
    if check_all:
        targets.extend(worktree / ALLOWLIST_RELATIVE for worktree in worktree_roots(root))
    mismatched = [target for target in targets if read_listed_ids(target) != ids]
    if not mismatched:
        print("MODELS_IN_SYNC")
        return 0
    print("MODELS_OUT_OF_SYNC")
    for target in mismatched:
        report_mismatch(root, target, ids)
    return 1


def command_order(root):
    models = load_table(root)
    active = [model for model in models if model["status"] == "active" and model["order"] > 0]
    for model in sorted(active, key=sorting_key):
        variants = ",".join(model["variants"])
        skip = "true" if model["skip_for_context"] else "false"
        print(
            f"{model['order']} {model['id']} pool={model['pool']} "
            f"variants={variants} context={model['context']} skip_for_context={skip}"
        )
    return 0


def format_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return ",".join(str(item) for item in value)
    return str(value)


def command_show(root, model_id):
    models = load_table(root)
    for model in models:
        if model["id"] == model_id:
            for field in REQUIRED_FIELDS:
                print(f"{field}={format_value(model[field])}")
            return 0
    print(f"MODEL_UNKNOWN {model_id}")
    return 2


def build_parser():
    parser = argparse.ArgumentParser(prog="opencode-models.py")
    subparsers = parser.add_subparsers(dest="command", required=True)
    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("--all", action="store_true", dest="check_all")
    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("--all", action="store_true", dest="check_all")
    subparsers.add_parser("order")
    show_parser = subparsers.add_parser("show")
    show_parser.add_argument("id")
    return parser


def main(argv=None):
    parser = build_parser()
    arguments = parser.parse_args(argv)
    root = repository_root()
    try:
        if arguments.command == "export":
            return command_export(root, arguments.check_all)
        if arguments.command == "check":
            return command_check(root, arguments.check_all)
        if arguments.command == "order":
            return command_order(root)
        return command_show(root, arguments.id)
    except TableInvalid as error:
        print(f"TABLE_INVALID {error}")
        return 3


if __name__ == "__main__":
    sys.exit(main())
