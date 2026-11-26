#!/usr/bin/python3
import argparse
import datetime
import fcntl
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_SETTINGS = "/etc/himawari-backup/settings.json"
BACKUP_ID = re.compile(r"^auto-(daily|pre-deploy|drill|manual)-\d{8}T\d{9}Z$")
PING_URL = re.compile(r"https://hc-ping\.com/[A-Za-z0-9_-]{1,64}(?:/[A-Za-z0-9_-]{1,64})?")


class BackupError(Exception):
    def __init__(self, code, detail=""):
        super().__init__(code if not detail else code + ": " + detail)
        self.code = code


def load_settings(path):
    try:
        with open(path, encoding="utf-8") as handle:
            settings = json.load(handle)
    except (OSError, ValueError) as error:
        raise BackupError("BACKUP_SETTINGS_UNREADABLE", path) from error
    required = ("repository", "serviceAccount", "config", "stateRoot", "unitPath", "releasesRoot", "workRoot", "passwordFile", "rcloneConfig", "retention", "keepLocal")
    missing = [key for key in required if key not in settings]
    if missing:
        raise BackupError("BACKUP_SETTINGS_INCOMPLETE", ",".join(missing))
    return settings


def run(command, environment=None, capture=True, check=True, input_text=None):
    result = subprocess.run(command, env=environment, capture_output=capture, text=True, input=input_text)
    if check and result.returncode != 0:
        tail = (result.stderr or "")[-2000:] if capture else ""
        raise BackupError("BACKUP_COMMAND_FAILED", " ".join(command[:4]) + " exit=" + str(result.returncode) + " " + tail.strip())
    return result


def serving_release(settings):
    try:
        unit = Path(settings["unitPath"]).read_text(encoding="utf-8")
    except OSError as error:
        raise BackupError("BACKUP_RELEASE_UNKNOWN", settings["unitPath"]) from error
    pattern = re.escape(settings["releasesRoot"].rstrip("/")) + r"/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{7,40}"
    match = re.search(pattern, unit)
    if not match:
        raise BackupError("BACKUP_RELEASE_UNKNOWN", "no release path in " + settings["unitPath"])
    release = Path(match.group(0))
    cli = release / "bin" / "himawari"
    if not cli.is_file():
        raise BackupError("BACKUP_CLI_MISSING", str(cli))
    return release, cli


def secret_directory(settings):
    return settings.get("secretDirectory") or str(Path(settings["stateRoot"]) / "secrets")


def as_service(settings, command):
    if pwd.getpwuid(os.getuid()).pw_name == settings["serviceAccount"]:
        return list(command)
    return ["/usr/sbin/runuser", "-u", settings["serviceAccount"], "--", *command]


def restic_environment(settings):
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/root",
        "RESTIC_REPOSITORY": settings["repository"],
        "RESTIC_PASSWORD_FILE": settings["passwordFile"],
        "RCLONE_CONFIG": settings["rcloneConfig"],
        "RESTIC_CACHE_DIR": str(Path(settings["workRoot"]) / "cache"),
    }


def restic(settings, arguments, check=True, capture=True):
    return run([settings.get("resticPath", "/usr/bin/restic"), *arguments], restic_environment(settings), capture, check)


def now_compact(clock):
    moment = clock()
    return moment.strftime("%Y%m%dT%H%M%S") + "%03dZ" % (moment.microsecond // 1000)


def create_recovery_point(settings, cli, reason, clock):
    backup_id = "auto-" + reason + "-" + now_compact(clock)
    result = run(as_service(settings, [str(cli), "backup", "create", "--config", settings["config"], "--secret-dir", secret_directory(settings), "--backup-id", backup_id]))
    try:
        report = json.loads(result.stdout)
    except ValueError as error:
        raise BackupError("BACKUP_CREATE_OUTPUT_INVALID") from error
    if report.get("fullIntegrityCheck") != "ok" or report.get("backupId") != backup_id:
        raise BackupError("BACKUP_CREATE_NOT_VERIFIED", backup_id)
    return backup_id, report


def copy_tree(source, destination):
    if not source.exists():
        return False
    if source.is_dir():
        shutil.copytree(source, destination, symlinks=True)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    return True


def stage_bundle(settings, backup_id, report, reason, release, clock):
    work = Path(settings["workRoot"])
    bundle = work / "bundle"
    if bundle.exists():
        shutil.rmtree(bundle)
    bundle.mkdir(mode=0o700, parents=True)
    state = Path(settings["stateRoot"])
    copy_tree(state / "recovery-points" / backup_id, bundle / "state" / "recovery-points" / backup_id)
    copy_tree(state / "authority.json", bundle / "state" / "authority.json")
    copy_tree(Path(secret_directory(settings)), bundle / "state" / "secrets")
    copy_tree(Path(settings["config"]), bundle / "config" / "config.json")
    extras = []
    for index, extra in enumerate(settings.get("extraPaths", [])):
        if copy_tree(Path(extra), bundle / "extra" / str(index) / Path(extra).name):
            extras.append(extra)
    manifest = json.loads((bundle / "state" / "recovery-points" / backup_id / "manifest.json").read_text(encoding="utf-8"))
    info = {
        "schema": "himawari.offsite-backup.v1",
        "backupId": backup_id,
        "reason": reason,
        "createdAt": clock().isoformat(),
        "release": release.name,
        "stateRoot": settings["stateRoot"],
        "config": settings["config"],
        "serviceAccount": settings["serviceAccount"],
        "extraPaths": extras,
        "schemaSequence": manifest.get("schemaSequence"),
        "rowCounts": manifest.get("rowCounts", {}),
        "fileCount": report.get("fileCount"),
    }
    (bundle / "backup-info.json").write_text(json.dumps(info, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return bundle, info


def upload(settings, bundle, reason, backup_id):
    result = restic(settings, ["backup", "--json", "--host", settings.get("host", "himawari-production"), "--tag", reason, "--tag", backup_id, str(bundle)])
    snapshot = None
    for line in result.stdout.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if item.get("message_type") == "summary":
            snapshot = item.get("snapshot_id")
    if not snapshot:
        raise BackupError("BACKUP_UPLOAD_NO_SNAPSHOT")
    return snapshot


def apply_retention(settings):
    retention = settings["retention"]
    restic(settings, ["forget", "--tag", "daily", "--group-by", "host", "--keep-daily", str(retention["daily"]), "--keep-weekly", str(retention["weekly"])])
    restic(settings, ["forget", "--tag", "pre-deploy", "--group-by", "host", "--keep-last", str(retention["preDeploy"])])
    restic(settings, ["forget", "--tag", "drill", "--group-by", "host", "--keep-last", str(retention.get("drill", 2))])
    restic(settings, ["prune"])


def prune_local(settings):
    root = Path(settings["stateRoot"]) / "recovery-points"
    if not root.is_dir():
        return []
    automatic = sorted((entry for entry in root.iterdir() if entry.is_dir() and BACKUP_ID.match(entry.name)), key=lambda entry: entry.name.rsplit("-", 1)[1])
    removed = automatic[: max(0, len(automatic) - int(settings["keepLocal"]))]
    for entry in removed:
        shutil.rmtree(entry)
    return [entry.name for entry in removed]


def ensure_repository(settings):
    probe = restic(settings, ["cat", "config"], check=False)
    if probe.returncode == 0:
        return False
    detail = (probe.stderr or "").lower()
    if "wrong password" in detail or "no key found" in detail:
        raise BackupError("BACKUP_PASSWORD_WRONG", "the restic password does not open " + settings["repository"])
    if "does not exist" not in detail and "is there a repository" not in detail and "not found" not in detail:
        raise BackupError("BACKUP_REPOSITORY_UNREACHABLE", detail.strip()[-500:])
    restic(settings, ["init"])
    return True


def ping(settings, suffix, body=None, opener=urllib.request.urlopen):
    url = settings.get("healthcheckUrl")
    if not url or not PING_URL.fullmatch(url):
        return False
    target = url + suffix
    data = body.encode("utf-8", "replace")[:10000] if body is not None else None
    try:
        with opener(urllib.request.Request(target, data=data, method="POST" if data is not None else "GET"), timeout=10) as response:
            response.read(64)
        return True
    except (urllib.error.URLError, OSError, ValueError):
        print("BACKUP_PING_FAILED", file=sys.stderr)
        return False


def largest_tables(row_counts, limit=8):
    ranked = sorted(row_counts.items(), key=lambda item: (-item[1], item[0]))
    return {"totalRows": sum(row_counts.values()), "tables": len(row_counts), "largest": dict(ranked[:limit])}


def backup(settings, reason, clock, output):
    release, cli = serving_release(settings)
    ensure_repository(settings)
    backup_id, report = create_recovery_point(settings, cli, reason, clock)
    bundle, info = stage_bundle(settings, backup_id, report, reason, release, clock)
    try:
        snapshot = upload(settings, bundle, reason, backup_id)
    finally:
        shutil.rmtree(bundle, ignore_errors=True)
    apply_retention(settings)
    removed = prune_local(settings)
    summary = {"result": "passed", "reason": reason, "backupId": backup_id, "snapshot": snapshot, "release": release.name, "rows": largest_tables(info["rowCounts"]), "localRemoved": removed}
    print("BACKUP_PASSED " + json.dumps(summary, sort_keys=True), file=output)
    return summary


def relocate(value, original, replacement):
    if isinstance(value, dict):
        return {key: relocate(item, original, replacement) for key, item in value.items()}
    if isinstance(value, list):
        return [relocate(item, original, replacement) for item in value]
    if isinstance(value, str) and (value == original or value.startswith(original + "/")):
        return replacement + value[len(original):]
    return value


def rewrite_config(source, destination, state_root):
    configuration = json.loads(Path(source).read_text(encoding="utf-8"))
    relocated = relocate(configuration, configuration["stateRoot"].rstrip("/"), state_root)
    Path(destination).write_text(json.dumps(relocated, indent=2) + "\n", encoding="utf-8")
    os.chmod(destination, 0o600)


def drill(settings, clock, output):
    release, cli = serving_release(settings)
    summary = backup(settings, "drill", clock, output)
    work = Path(settings["workRoot"])
    target = work / ("drill-" + now_compact(clock))
    target.mkdir(mode=0o700, parents=True)
    try:
        restic(settings, ["restore", summary["snapshot"], "--target", str(target)])
        bundles = [path.parent for path in target.rglob("backup-info.json")]
        if len(bundles) != 1:
            raise BackupError("DRILL_BUNDLE_NOT_FOUND", str(len(bundles)))
        bundle = bundles[0]
        info = json.loads((bundle / "backup-info.json").read_text(encoding="utf-8"))
        if info["backupId"] != summary["backupId"]:
            raise BackupError("DRILL_WRONG_SNAPSHOT", info["backupId"])
        state = bundle / "state"
        for directory in (state / "data", state / "runtime", state / "cache"):
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        rewrite_config(bundle / "config" / "config.json", str(bundle / "drill-config.json"), str(state))
        run(["/usr/bin/chown", "-R", settings["serviceAccount"] + ":" + settings["serviceAccount"], str(target)])
        run(["/usr/bin/chmod", "711", str(work), str(target)])
        result = run(as_service(settings, [str(cli), "backup", "verify", "--config", str(bundle / "drill-config.json"), "--secret-dir", str(state / "secrets"), "--backup", info["backupId"]]))
        report = json.loads(result.stdout)
        if report.get("fullIntegrityCheck") != "ok" or report.get("quickIntegrityCheck") != "ok":
            raise BackupError("DRILL_VERIFY_FAILED", info["backupId"])
        if sum(info["rowCounts"].values()) == 0:
            raise BackupError("DRILL_EMPTY_DATABASE")
        restic(settings, ["check", "--read-data-subset", settings.get("checkSubset", "10%")])
        result_summary = {"result": "passed", "backupId": info["backupId"], "snapshot": summary["snapshot"], "release": release.name, "rows": largest_tables(info["rowCounts"]), "payloadCount": report.get("payloadCount"), "fileCount": report.get("fileCount")}
        print("DRILL_PASSED " + json.dumps(result_summary, sort_keys=True), file=output)
        return result_summary
    finally:
        shutil.rmtree(target, ignore_errors=True)


def status(settings, output):
    result = restic(settings, ["snapshots", "--json"])
    snapshots = json.loads(result.stdout or "[]")
    rows = [{"id": item.get("short_id"), "time": item.get("time"), "tags": item.get("tags", [])} for item in snapshots]
    print("BACKUP_STATUS " + json.dumps({"count": len(rows), "snapshots": rows[-20:]}, sort_keys=True), file=output)
    return rows


def main(argv, clock=lambda: datetime.datetime.now(datetime.timezone.utc), output=sys.stdout, errors=sys.stderr, opener=urllib.request.urlopen):
    parser = argparse.ArgumentParser(prog="himawari-backup")
    parser.add_argument("--settings", default=DEFAULT_SETTINGS)
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--reason", choices=("daily", "pre-deploy", "manual"), default="daily")
    commands.add_parser("drill")
    commands.add_parser("status")
    arguments = parser.parse_args(argv)
    try:
        settings = load_settings(arguments.settings)
    except BackupError as error:
        print(str(error), file=errors)
        return 2
    lock_path = Path(settings["workRoot"]) / "backup.lock"
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(lock_path, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("BACKUP_ALREADY_RUNNING", file=errors)
            return 75
        if arguments.command == "status":
            try:
                status(settings, output)
                return 0
            except BackupError as error:
                print(str(error), file=errors)
                return 1
        ping(settings, "/start", opener=opener)
        try:
            if arguments.command == "run":
                summary = backup(settings, arguments.reason, clock, output)
            else:
                summary = drill(settings, clock, output)
        except (BackupError, OSError, ValueError, KeyError) as error:
            message = ("DRILL_FAILED " if arguments.command == "drill" else "BACKUP_FAILED ") + str(error)
            print(message, file=errors)
            ping(settings, "/fail", message, opener=opener)
            return 1
        ping(settings, "", json.dumps(summary, sort_keys=True), opener=opener)
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
