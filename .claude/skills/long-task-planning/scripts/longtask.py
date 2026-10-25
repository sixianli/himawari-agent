#!/usr/bin/env python3
import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
import re
import secrets
import socket
import stat
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree

try:
    import fcntl
except ImportError:
    fcntl = None

SCRIPT_PATH = Path(os.path.abspath(__file__))
SKILL_MD = SCRIPT_PATH.parents[1] / "SKILL.md"
TASKS_DIR = ".agents/tasks"
TASK_FILES = ("goal.md", "items.json", "plan.md", "evidence.jsonl")
CONTEXT_BUDGET = 1600
JUNK_NAMES = {".DS_Store", "Thumbs.db"}
CHECK_TYPES = ("test", "doc", "review", "user", "command")
DECISION_VALUES = ("once", "durable")
DEFAULT_DECISION_DOCS = ("docs/adr/",)
STATUS_PRIORITY = ("unknown", "waiting", "not_done", "older", "verified")
DISPLAY_ORDER = ("unknown", "waiting", "not_done", "older", "verified", "withdrawn")
COUNT_ORDER = ("verified", "older", "not_done", "unknown", "waiting", "withdrawn")
LABELS = {
    "verified": "当前版本已验证",
    "older": "旧版本验证过",
    "not_done": "未完成",
    "unknown": "无法判断",
    "waiting": "等你决定",
    "withdrawn": "不做",
}
PLAN_SECTIONS = ("当前批次", "之后", "计划改动记录", "意外和发现", "决定")
LOG_SECTIONS = ("计划改动记录", "意外和发现", "决定")
STATUS_WORDS = re.compile(r"已完成|已修复|已修好|已修|已通过|已验证|已解决|已提交|已合并|已推送|已审核|已做完|做完了|待验证|待审核|进行中|未开始|完成了|✅|☑|✔|\[[xX ]\]")
PROGRESS_HINT = "计划只写做什么、用什么证据，不写到哪一步了；做没做完用 status 算"
QUESTION_PREFIX = "问题："
GOAL_HEADER = re.compile(r"^## (G\d+|CLOSED) (\d{4}-\d{2}-\d{2}) (\S.*)$")
ID_BODY = r"[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*"
ITEM_ID = re.compile(rf"[A-Za-z][A-Za-z0-9]*-{ID_BODY}")
TAG_IN_NAME = re.compile(rf"\[([A-Za-z][A-Za-z0-9]*-{ID_BODY})\]")
TEMPLATE_PLACEHOLDER = re.compile(r"%[sdifjo#$]")
UNKNOWN_FINGERPRINT = "unknown"
FINGERPRINT_FILE_FIELDS = ("fingerprint", "commit", "dirty")
FORMATTER_CONFIGS = (
    "biome.json", "biome.jsonc", "dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc",
    ".prettierrc", ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml",
    ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.ts", ".prettierrc.cts", ".prettierrc.mts",
    "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts", "prettier.config.cts", "prettier.config.mts",
)
TEST_FILE_PATTERNS = ("*.test.*", "*.spec.*", "test_*.py", "*_test.py", "*_test.go")
TEST_DIR_NAMES = {"test", "tests", "__tests__", "e2e", "spec"}
NON_TEST_SUFFIXES = {".md", ".txt"}
SOURCE_EVENTS = {"compact": "压缩", "resume": "恢复"}

GOAL_TEMPLATE = """# 目标：{task}

<!-- 只追加，不改旧内容。每条以“## G<编号> <YYYY-MM-DD> <来源>”开头，来源写“用户原话”“用户选择”或“转述：<出处>”，
     下面用“> ”引用原话；回答离开问题看不懂时，引用前写一行“问题：<原问题>”。
     任务结束时追加“## CLOSED <日期> 用户原话”和用户的验收原话。 -->

## G1 {date} {source}

{quote}
"""

PLAN_TEMPLATE = """# 计划：{task}

<!-- 只写打算，不写进度；做没做完用 longtask.py status 算。
     当前批次最多 3 项，每项一行、以条目编号开头，写清做法和需要的证据；
     同一次测试顺带验证的条目写在不以编号开头的一行里，不占名额；之后的条目每项一行；
     最后三段只追加，不改旧内容。 -->

## 当前批次

## 之后

## 计划改动记录

- {created} 建立任务。

## 意外和发现

## 决定
"""

REMINDER = (
    "【长任务检查】会话刚{event}。当前仓库没有进行中的长任务目录（{tasks}/）。"
    "如果手上的任务还没做完，按 long-task-planning 的规则判断要不要升级为完整模式："
    "要交给别的 Agent、目标开放、需要分别验证的验收项超过 3 个、继续之前没做完的任务、范围或难度变大。"
    "规则见 {skill}。"
)


class Fail(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"错误：{message}", file=sys.stderr)
        sys.exit(1)


def now():
    value = os.environ.get("LONGTASK_NOW")
    if value:
        return dt.datetime.fromisoformat(value)
    return dt.datetime.now().astimezone()


def iso(moment):
    return moment.isoformat(timespec="seconds")


def short_time(text):
    return (text or "")[:16].replace("T", " ")


def home_short(path):
    home, text = str(Path.home()), str(path)
    return "~" + text[len(home):] if home != "/" and text.startswith(home + "/") else text


def local_host():
    return os.environ.get("LONGTASK_HOST") or socket.gethostname()


def git(repo, *args, check=True, input_text=None):
    env = os.environ.copy()
    env["GIT_OPTIONAL_LOCKS"] = "0"
    result = subprocess.run(
        ["git", "-c", "core.quotepath=false", *args],
        cwd=repo, env=env, capture_output=True, input=input_text, check=False,
        text=True, encoding="utf-8", errors="surrogateescape",
    )
    if check and result.returncode != 0:
        raise Fail(f"git {' '.join(args)} 失败：{result.stderr.strip()}")
    return result


def git_out(repo, *args):
    return git(repo, *args).stdout


def split_z(text):
    return [part for part in text.split("\0") if part]


def find_repo(start):
    try:
        result = git(start, "rev-parse", "--show-toplevel", check=False)
    except (FileNotFoundError, NotADirectoryError):
        return None
    if result.returncode != 0:
        return None
    return Path(result.stdout.strip())


def repo_from(args):
    start = Path(args.repo or os.getcwd())
    repo = find_repo(start)
    if repo is None:
        raise Fail(f"{home_short(start)} 不在 git 仓库里；长任务的完整模式需要 git 仓库")
    return repo


def read_text(path):
    return Path(path).read_text(encoding="utf-8")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def truncate(text, limit):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def norm_lines(text):
    lines = [line.rstrip() for line in text.splitlines()]
    while lines and not lines[-1]:
        lines.pop()
    return lines


class Task:
    def __init__(self, repo, name):
        self.repo = repo
        self.name = name
        self.rel = f"{TASKS_DIR}/{name}"
        self.dir = repo / TASKS_DIR / name

    def path(self, name):
        return self.dir / name


def list_tasks(repo):
    base = repo / TASKS_DIR
    if not base.is_dir():
        return []
    return [Task(repo, entry.name) for entry in sorted(base.iterdir()) if (entry / "goal.md").is_file()]


def parse_goal(text):
    entries, errors, current = [], [], None
    for number, line in enumerate(text.splitlines(), 1):
        if line.startswith("## "):
            match = GOAL_HEADER.match(line.rstrip())
            if not match:
                errors.append(f"goal.md 第 {number} 行的标题格式不对，应为“## G<编号> <YYYY-MM-DD> <来源>”或“## CLOSED <日期> <来源>”")
                current = None
                continue
            current = {"id": match.group(1), "date": match.group(2), "source": match.group(3).strip(), "lines": []}
            entries.append(current)
        elif current is not None:
            current["lines"].append(line)
    for entry in entries:
        lines = entry.pop("lines")
        questions = [line.strip().removeprefix(QUESTION_PREFIX).strip() for line in lines if line.strip().startswith(QUESTION_PREFIX)]
        lines = [line for line in lines if not line.strip().startswith(QUESTION_PREFIX)]
        quoted = [line.lstrip()[1:].strip() for line in lines if line.lstrip().startswith(">")]
        body = quoted if quoted else [line.strip() for line in lines]
        entry["text"] = " ".join(part for part in body if part)
        entry["question"] = " ".join(part for part in questions if part)
    return entries, errors


def is_closed(task):
    try:
        entries, _ = parse_goal(read_text(task.path("goal.md")))
    except OSError:
        return False
    return any(entry["id"] == "CLOSED" for entry in entries)


def active_tasks(repo):
    return [task for task in list_tasks(repo) if not is_closed(task)]


def resolve_task(repo, name):
    if name:
        task = Task(repo, name)
        if not task.dir.is_dir():
            raise Fail(f"任务目录 {task.rel} 不存在")
        return task
    active = active_tasks(repo)
    if len(active) == 1:
        return active[0]
    if not active:
        raise Fail(f"没有进行中的长任务（{TASKS_DIR}/ 下没有未关闭的任务）")
    raise Fail("有多个进行中的任务，请用 --task 指定：" + "、".join(task.name for task in active))


def load_items(task):
    path = task.path("items.json")
    try:
        data = json.loads(read_text(path))
    except FileNotFoundError:
        raise Fail(f"{task.rel}/items.json 不存在")
    except json.JSONDecodeError as error:
        raise Fail(f"{task.rel}/items.json 不是合法的 JSON：{error}")
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise Fail(f"{task.rel}/items.json 缺少 items 列表")
    return data


def path_list(data, key):
    section = data.get("fingerprint") or {}
    values = section.get(key) or []
    return [value for value in values if isinstance(value, str)] if isinstance(values, list) else []


def scope_of(data):
    return path_list(data, "include"), path_list(data, "exclude")


def scope_record(scope):
    includes, excludes = scope
    return {"include": sorted(set(includes)), "exclude": sorted(set(excludes))}


def describe_scope(scope):
    text = "只看 " + "、".join(scope["include"]) if scope["include"] else "看全部文件"
    return text + ("，不算 " + "、".join(scope["exclude"]) if scope["exclude"] else "")


def load_records(task):
    records, errors = [], []
    path = task.path("evidence.jsonl")
    if not path.exists():
        return records, errors
    for number, line in enumerate(read_text(path).splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            errors.append(f"evidence.jsonl 第 {number} 行不是合法的 JSON：{error}")
            continue
        if not isinstance(record, dict) or not record.get("id") or not record.get("kind"):
            errors.append(f"evidence.jsonl 第 {number} 行缺少 id 或 kind")
            continue
        if record_moment(record) is None:
            errors.append(f"evidence.jsonl 第 {number} 行的时间 {record.get('time')!r} 读不出来")
        records.append(record)
    return records, errors


def record_moment(record):
    moment = report_moment(record.get("time"))
    return None if moment is None else moment.timestamp()


def in_time_order(records):
    def key(record):
        moment = record_moment(record)
        return (moment is not None, moment or 0.0)
    return sorted(records, key=key)


def effective_records(records):
    retracted = {record.get("target") for record in records if record.get("kind") == "retract"}
    return [record for record in records if record.get("kind") != "retract" and record["id"] not in retracted]


def is_junk(path):
    name = path.rsplit("/", 1)[-1]
    return name in JUNK_NAMES or name.startswith("._")


def under_any(path, prefixes):
    for value in prefixes:
        prefix = value.rstrip("/")
        if prefix and (path == prefix or path.startswith(prefix + "/")):
            return True
    return False


def quotes_of(check):
    value = check.get("quotes")
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    return []


def quotes_valid(value):
    return isinstance(value, str) or (isinstance(value, list) and all(isinstance(item, str) for item in value))


def normalize_quote(text):
    lines = []
    for line in text.splitlines():
        line = line.lstrip().removeprefix(">")
        lines.append(line)
    return re.sub(r"\s+", "", "".join(lines))


def decision_doc_paths(data):
    value = data.get("decision_docs", list(DEFAULT_DECISION_DOCS))
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    return list(DEFAULT_DECISION_DOCS)


def decision_doc_item(items, gid, docs):
    for entry in items:
        if entry.get("withdrawn"):
            continue
        if gid not in (entry.get("goal_ref") or []):
            continue
        for check in entry.get("done_when") or []:
            if isinstance(check, dict) and check.get("type") == "doc":
                path = check.get("path")
                if isinstance(path, str) and under_any(path, docs) and gid in quotes_of(check):
                    return True
    return False


def decision_missing(data, goal_entries):
    decisions = data.get("decisions")
    if not isinstance(decisions, dict):
        return []
    return [entry["id"] for entry in goal_entries if entry["id"] != "CLOSED" and entry["id"] not in decisions]


def decision_unlinked(data, goal_entries, items):
    decisions = data.get("decisions")
    if not isinstance(decisions, dict):
        return []
    goal_ids = {entry["id"] for entry in goal_entries}
    docs = decision_doc_paths(data)
    return [gid for gid, value in decisions.items()
            if value == "durable" and gid in goal_ids and not decision_doc_item(items, gid, docs)]


def decision_warnings(data, goal_entries, items):
    warnings = []
    missing = decision_missing(data, goal_entries)
    if missing:
        warnings.append(f"goal.md 里的 {'、'.join(missing)} 还没分类：在 items.json 的 decisions 里写 \"once\" 或 \"durable\"")
    unlinked = decision_unlinked(data, goal_entries, items)
    if unlinked:
        docs = decision_doc_paths(data)
        where = "、".join(docs) if docs else "decision_docs 里的路径"
        warnings.append(f"长期决定 {'、'.join(unlinked)} 还没有文档条目：加一个 goal_ref 含它的条目，done_when 里加 doc 检查，path 在 {where} 下，quotes 写这条 G")
    return warnings


def decision_errors(data, goal_entries, items):
    if "decisions" not in data:
        return []
    decisions = data.get("decisions")
    if not isinstance(decisions, dict):
        return ['items.json 的 decisions 必须是对象：键写 goal.md 的 G 编号，值写 "once" 或 "durable"']
    errors = []
    goal_ids = {entry["id"] for entry in goal_entries}
    for gid, value in decisions.items():
        if value not in DECISION_VALUES:
            errors.append(f"decisions 里的 {gid} 的值 {value!r} 不认识：只能是 \"once\" 或 \"durable\"")
        if gid not in goal_ids:
            errors.append(f"decisions 里的 {gid} 在 goal.md 里不存在：删掉这一项，或先在 goal.md 里记下这条原话")
    value = data.get("decision_docs", list(DEFAULT_DECISION_DOCS))
    if not (isinstance(value, list) and all(isinstance(item, str) for item in value)):
        errors.append('items.json 的 decision_docs 必须是路径前缀列表，例如 ["docs/adr/"] 或 ["AGENTS.md"]')
    errors += decision_warnings(data, goal_entries, items)
    return errors


def excluded(path, excludes):
    if path.startswith(TASKS_DIR + "/") or is_junk(path):
        return True
    return under_any(path, excludes)


def outside_scope(path, scope):
    includes, excludes = scope
    return excluded(path, excludes) or (bool(includes) and not under_any(path, includes))


def include_problems(repo, includes):
    files = repo_files(repo)
    return [f"items.json 的 fingerprint.include 里的 {value} 在仓库里没有对应的文件（写错了？）：它下面的改动不会进指纹"
            for value in includes if not any(under_any(path, [value]) for path in files)]


def blob_of_bytes(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def hash_paths(repo, paths):
    regular, result = [], {}
    for path in paths:
        full = repo / path
        if not os.path.lexists(full):
            result[path] = None
        elif os.path.islink(full):
            result[path] = blob_of_bytes(os.readlink(full).encode("utf-8", "surrogateescape"))
        elif full.is_file():
            regular.append(path)
        else:
            result[path] = None
    if regular:
        output = git(repo, "hash-object", "--stdin-paths", input_text="\n".join(regular) + "\n").stdout.split()
        result.update(zip(regular, output))
    return result


def worktree_mode(full):
    info = os.lstat(full)
    if stat.S_ISLNK(info.st_mode):
        return "120000"
    return "100755" if info.st_mode & stat.S_IXUSR else "100644"


def untracked_files(repo):
    return split_z(git_out(repo, "ls-files", "-o", "--exclude-standard", "-z"))


def fingerprint_lines(entries):
    return [f"{mode} {blob} {path}" for path, (mode, blob) in sorted(entries.items())]


def digest_lines(entries):
    return hashlib.sha256("\n".join(fingerprint_lines(entries)).encode("utf-8", "surrogateescape")).hexdigest()


def code_digest(entries, test_excludes):
    return digest_lines({path: value for path, value in entries.items() if not under_any(path, test_excludes)})


def worktree_entries(repo, scope):
    entries, pending = {}, set()
    for line in split_z(git_out(repo, "ls-files", "-s", "-z")):
        meta, path = line.split("\t", 1)
        mode, blob, stage = meta.split()
        if outside_scope(path, scope):
            continue
        if stage != "0":
            pending.add(path)
        entries[path] = (mode, blob)
    pending.update(path for path in split_z(git_out(repo, "diff-files", "--name-only", "-z"))
                   if not outside_scope(path, scope))
    pending.update(path for path in untracked_files(repo) if not outside_scope(path, scope))
    hashed = hash_paths(repo, sorted(pending))
    for path in pending:
        blob = hashed.get(path)
        if blob is None:
            if not os.path.lexists(repo / path):
                entries.pop(path, None)
            continue
        entries[path] = (worktree_mode(repo / path), blob)
    return entries


def tree_entries(repo, commit, scope):
    entries = {}
    for line in split_z(git_out(repo, "ls-tree", "-r", "-z", "--full-tree", commit)):
        meta, path = line.split("\t", 1)
        mode, _, blob = meta.split()
        if not outside_scope(path, scope):
            entries[path] = (mode, blob)
    return entries


def compute_fingerprint(repo, scope, entries=None):
    if entries is None:
        entries = worktree_entries(repo, scope)
    fingerprint = digest_lines(entries)
    head = git(repo, "rev-parse", "--verify", "-q", "HEAD", check=False).stdout.strip()
    dirty = not head or digest_lines(tree_entries(repo, head, scope)) != fingerprint
    return {"fingerprint": fingerprint, "commit": head, "dirty": dirty}


def repo_files(repo):
    tracked = split_z(git_out(repo, "ls-files", "-z"))
    files = set(tracked) | set(untracked_files(repo))
    return sorted(path for path in files if not path.startswith(TASKS_DIR + "/"))


def is_test_file(path):
    name = path.rsplit("/", 1)[-1]
    if Path(name).suffix in NON_TEST_SUFFIXES:
        return False
    if any(fnmatch.fnmatch(name, pattern) for pattern in TEST_FILE_PATTERNS):
        return True
    return any(part in TEST_DIR_NAMES for part in path.split("/")[:-1])


def find_tag_files(repo, tags):
    mapping = {tag: set() for tag in tags}
    if not tags:
        return mapping
    args = ["grep", "-z", "-I", "-o", "-F", "--untracked"]
    for tag in sorted(tags):
        args += ["-e", f"[{tag}]"]
    args += ["--", ".", f":(exclude){TASKS_DIR}"]
    result = git(repo, *args, check=False)
    if result.returncode > 1:
        raise Fail(f"git grep 失败：{result.stderr.strip()}")
    for line in result.stdout.split("\n"):
        path, _, match = line.partition("\0")
        tag = match[1:-1] if match.startswith("[") and match.endswith("]") else None
        if tag in mapping and is_test_file(path):
            mapping[tag].add(path)
    return mapping


class PathMapper:
    def __init__(self, files):
        self.by_name = {}
        for path in files:
            self.by_name.setdefault(path.rsplit("/", 1)[-1], []).append(path)

    def map(self, reported):
        reported = reported.replace("\\", "/")
        reported = reported.removeprefix("./")
        same_name = self.by_name.get(reported.rsplit("/", 1)[-1], [])
        if reported in same_name:
            return reported
        inside = [path for path in same_name if reported.endswith("/" + path)]
        if inside:
            return max(inside, key=len)
        below = [path for path in same_name if path.endswith("/" + reported)]
        return below[0] if len(below) == 1 else None

    def first(self, names):
        for name in names:
            path = self.map(name)
            if path:
                return path
        return None


def normalize_status(value):
    if value == "passed":
        return "passed"
    if value == "failed":
        return "failed"
    return "skipped"


def report_moment(text):
    try:
        moment = dt.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.astimezone() if moment.tzinfo else moment


def placeholder_problem(selector):
    if isinstance(selector, str) and TEMPLATE_PLACEHOLDER.search(selector):
        return f"测试名“{selector}”里有模板占位符：跑出来的名字里它会换成具体值，永远对不上；只写源码里原样出现、不含占位符的一段"
    return None


def environment_problem(check):
    if check.get("scope") != "environment":
        return f"环境检查的 scope 只能写 \"environment\"，现在是 {check.get('scope')!r}"
    if not (isinstance(check.get("host"), str) and check["host"]):
        return "环境检查缺少 host：只认那台主机上的结果"
    days = check.get("max_age_days")
    if isinstance(days, bool) or not isinstance(days, int) or days < 1:
        return f"环境检查的 max_age_days 要写有效天数（正整数），现在是 {days!r}"
    return None


def ignore_test_exclude_problem(check):
    if "ignore_test_exclude" in check and not isinstance(check["ignore_test_exclude"], bool):
        return (f"ignore_test_exclude 只能是 true 或 false，现在是 {check['ignore_test_exclude']!r}："
                "写成布尔值，例如 \"ignore_test_exclude\": true")
    if "ignore_test_exclude" in check and check.get("scope") == "environment":
        return ("ignore_test_exclude 不能和 \"scope\": \"environment\" 一起用：环境检查不看代码版本，"
                "删掉 ignore_test_exclude，或去掉 scope")
    return None


def parse_vitest(path):
    data = json.loads(read_text(path))
    start = data.get("startTime")
    started = None
    if isinstance(start, (int, float)) and not isinstance(start, bool) and start > 0:
        started = dt.datetime.fromtimestamp(start / 1000, dt.timezone.utc).astimezone()
    results = []
    for suite in data.get("testResults", []):
        names = [suite["name"]] if suite.get("name") else []
        assertions = suite.get("assertionResults") or []
        if not assertions and suite.get("status") == "failed":
            whole = f"（整个文件失败：{truncate(suite.get('message') or '', 120)}）"
            results.append((names, whole, "failed", whole))
        for assertion in assertions:
            full = assertion.get("fullName") or " ".join([*(assertion.get("ancestorTitles") or []), assertion.get("title") or ""])
            title = assertion.get("title") or full
            results.append((names, full.strip(), normalize_status(assertion.get("status")), title.strip()))
    return results, started


def junit_files(case):
    if case.get("file"):
        return [case.get("file")]
    classname = case.get("classname") or ""
    if not classname:
        return []
    if "/" in classname or re.search(r"\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|rs)$", classname):
        return [classname]
    parts = classname.split(".")
    return ["/".join(parts[:end]) + ".py" for end in range(len(parts), 0, -1)]


def parse_junit(path):
    root = ElementTree.parse(path).getroot()
    results = []
    for case in root.iter("testcase"):
        classname, name = case.get("classname") or "", case.get("name") or ""
        if case.find("failure") is not None or case.find("error") is not None:
            status = "failed"
        elif case.find("skipped") is not None:
            status = "skipped"
        else:
            status = "passed"
        results.append((junit_files(case), f"{classname} {name}".strip(), status, name or classname))
    moments = [moment for moment in (report_moment(suite.get("timestamp")) for suite in root.iter("testsuite")
                                     if suite.get("timestamp")) if moment]
    aware = [moment for moment in moments if moment.tzinfo]
    started = min(aware or moments) if moments else None
    return results, started


def selectors_of(data):
    found = []
    for entry in data.get("items", []):
        if not isinstance(entry, dict):
            continue
        for check in entry.get("done_when") or []:
            if isinstance(check, dict) and check.get("type") == "test" and check.get("file") and check.get("name"):
                pair = (check["file"], check["name"])
                if pair not in found:
                    found.append(pair)
    return found


def relative_to_repo(repo, path):
    full = Path(path).resolve()
    try:
        return str(full.relative_to(repo.resolve()))
    except ValueError:
        return str(full)


def base_record(kind, fingerprint, args):
    moment = now()
    record = {
        "v": 1,
        "id": f"E{moment.strftime('%Y%m%dT%H%M%S')}-{secrets.token_hex(3)}",
        "time": iso(moment),
        "kind": kind,
        "fingerprint": fingerprint["fingerprint"],
        "commit": fingerprint["commit"],
        "dirty": fingerprint["dirty"],
        "host": fingerprint["host"],
        "by": args.by,
    }
    if fingerprint.get("scope") is not None:
        record["scope"] = fingerprint["scope"]
    if fingerprint.get("code_fingerprint") is not None:
        record["code_fingerprint"] = fingerprint["code_fingerprint"]
        record["test_exclude"] = fingerprint["test_exclude"]
    if args.note:
        record["note"] = args.note
    return record


def record_fingerprint(task, args, scope, data=None):
    local = local_host()
    if args.fingerprint_file:
        try:
            data = json.loads(read_text(args.fingerprint_file))
        except (OSError, json.JSONDecodeError) as error:
            raise Fail(f"读不了指纹文件 {args.fingerprint_file}：{error}")
        missing = [key for key in FINGERPRINT_FILE_FIELDS if key not in data]
        if missing:
            raise Fail(f"指纹文件缺少字段：{', '.join(missing)}。必需字段是 {'、'.join(FINGERPRINT_FILE_FIELDS)}，host 可选；"
                       f"最好直接用那台机器上 `longtask.py fingerprint --json` 的输出。补录不知道代码版本的旧报告时可以手写，例如 "
                       + json.dumps({"fingerprint": UNKNOWN_FINGERPRINT, "commit": "<大概跑在哪个提交>", "dirty": False, "host": "<主机名>"},
                                    ensure_ascii=False))
        host = data.get("host") or args.host or local
        if args.host and args.host != host:
            raise Fail(f"--host {args.host} 和指纹文件里的主机 {host} 不一致")
        recorded = scope_record((data.get("includes") or [], data["excludes"] or [])) if "excludes" in data else None
        return {"fingerprint": data["fingerprint"], "commit": data["commit"], "dirty": bool(data["dirty"]), "host": host,
                "scope": recorded}
    if args.host and args.host != local:
        raise Fail("测试在别的机器上跑时，必须用 --fingerprint-file 传入在那台机器上运行 `longtask.py fingerprint --json` 得到的文件")
    entries = worktree_entries(task.repo, scope)
    fingerprint = compute_fingerprint(task.repo, scope, entries)
    fingerprint["host"] = local
    fingerprint["scope"] = scope_record(scope)
    test_excludes = path_list(data, "test_exclude") if data is not None else []
    if test_excludes:
        fingerprint["code_fingerprint"] = code_digest(entries, test_excludes)
        fingerprint["test_exclude"] = sorted(set(test_excludes))
    return fingerprint


def append_record(task, record):
    path = task.path("evidence.jsonl")
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with open(path, "a+", encoding="utf-8") as handle:
        if fcntl:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.seek(0, os.SEEK_END)
        if handle.tell() > 0:
            handle.seek(handle.tell() - 1)
            if handle.read(1) != "\n":
                line = "\n" + line
            handle.seek(0, os.SEEK_END)
        handle.write(line)
        handle.flush()


def artifacts_of(repo, paths):
    found = []
    for path in paths:
        if not Path(path).is_file():
            raise Fail(f"文件 {path} 不存在")
        found.append({"path": relative_to_repo(repo, path), "sha256": sha256_file(path)})
    return found


def test_record(task, data, args, fingerprint):
    report = args.vitest or args.junit
    if not Path(report).is_file():
        raise Fail(f"测试报告 {report} 不存在")
    try:
        results, started = parse_vitest(report) if args.vitest else parse_junit(report)
    except (json.JSONDecodeError, ElementTree.ParseError) as error:
        raise Fail(f"读不了测试报告 {report}：{error}")
    mapper = PathMapper(repo_files(task.repo))
    selectors = selectors_of(data)
    counts = {"passed": 0, "failed": 0, "skipped": 0}
    tags, selected, failures, unresolved = {}, {}, [], set()
    for names, full, status, _title in results:
        counts[status] += 1
        path = mapper.first(names)
        if path is None:
            path = names[0] if names else ""
            if path:
                unresolved.add(path)
        if status == "failed" and len(failures) < 20:
            failures.append(truncate(full, 200))
        if status == "skipped":
            continue
        for tag in sorted(set(TAG_IN_NAME.findall(full))):
            entry = tags.setdefault(tag, {"passed": 0, "failed": 0, "files": []})
            entry[status] += 1
            if path not in entry["files"]:
                entry["files"].append(path)
        for file_rel, name in selectors:
            if path == file_rel and name in full:
                entry = selected.setdefault((file_rel, name), {"file": file_rel, "name": name, "passed": 0, "failed": 0})
                entry[status] += 1
    for entry in tags.values():
        entry["files"].sort()
    record = base_record("test", fingerprint, args)
    record.update({
        "source": "vitest-json" if args.vitest else "junit-xml",
        "counts": counts,
        "tags": tags,
        "selected": list(selected.values()),
        "failures": failures,
        "artifacts": artifacts_of(task.repo, [report, *(args.artifact or [])]),
    })
    if args.ran:
        record["ran"] = args.ran
    if started:
        record["ran_at"] = iso(started)
    if unresolved:
        record["unresolved_files"] = sorted(unresolved)
    return record


def resolve_commit(repo, value):
    result = git(repo, "rev-parse", "--verify", "-q", f"{value}^{{commit}}", check=False)
    if result.returncode != 0:
        raise Fail(f"提交 {value} 不存在")
    return result.stdout.strip()


def commit_blobs(repo, commit, paths):
    found = {}
    for path in paths:
        line = git_out(repo, "ls-tree", "-z", "--full-tree", commit, "--", path).split("\0")[0]
        meta, _, name = line.partition("\t")
        parts = meta.split()
        found[path] = parts[2] if len(parts) == 3 and parts[1] == "blob" and name == path else None
    return found


def resolve_repo_path(repo, path):
    candidate = Path(path)
    full = candidate if candidate.is_absolute() else (Path.cwd() / candidate)
    if not full.exists() and not candidate.is_absolute():
        full = repo / candidate
    try:
        return str(full.resolve().relative_to(repo.resolve()))
    except ValueError:
        raise Fail(f"{path} 不在仓库里")


def cmd_record(args):
    repo = repo_from(args)
    task = resolve_task(repo, args.task)
    data = load_items(task)
    scope = scope_of(data)
    if args.commit and not args.review:
        raise Fail("--commit 只能和 --review 一起用：补录审核时按那个提交里的文件内容记录")
    if args.retract:
        records, _ = load_records(task)
        if args.retract not in {record["id"] for record in records}:
            raise Fail(f"证据 {args.retract} 不存在")
        if not args.reason:
            raise Fail("撤回证据必须用 --reason 写明原因")
        record = base_record("retract", record_fingerprint(task, args, scope), args)
        record.update({"target": args.retract, "reason": args.reason})
    elif args.command is not None:
        if args.exit_code is None:
            raise Fail("--command 需要同时给出 --exit-code")
        record = base_record("command", record_fingerprint(task, args, scope, data), args)
        record.update({"command": args.command, "exit_code": args.exit_code})
        if args.artifact:
            record["artifacts"] = artifacts_of(repo, args.artifact)
    elif args.review:
        if not args.items or not args.verdict:
            raise Fail("--review 需要 --items 和 --verdict")
        if args.no_files and (args.files or args.commit):
            raise Fail("--no-files 不能和 --files 或 --commit 一起用")
        if args.no_files and not args.note:
            raise Fail("--no-files 要用 --note 写明审核了什么，例如“测试环境问题，和代码无关”")
        if not args.no_files and not args.files:
            raise Fail("--review 需要 --files 写明审核过的文件；审核和代码无关时改用 --no-files --note \"审核了什么\"")
        known = {entry.get("id") for entry in data["items"] if isinstance(entry, dict)}
        item_ids = [value.strip() for value in args.items.split(",") if value.strip()]
        unknown = [value for value in item_ids if value not in known]
        if unknown:
            raise Fail(f"条目 {', '.join(unknown)} 在 items.json 里不存在")
        paths = [resolve_repo_path(repo, path) for path in args.files or []]
        reviewed = resolve_commit(repo, args.commit) if args.commit else None
        hashes = commit_blobs(repo, reviewed, paths) if reviewed else hash_paths(repo, paths)
        missing = [path for path, blob in hashes.items() if blob is None]
        if missing:
            where = f"在提交 {reviewed[:7]} 里" if reviewed else ""
            raise Fail(f"文件{where}不存在：{', '.join(missing)}")
        record = base_record("review", record_fingerprint(task, args, scope), args)
        record.update({"items": item_ids, "verdict": args.verdict, "files": {path: hashes[path] for path in paths}})
        if reviewed:
            record["reviewed_commit"] = reviewed
    else:
        record = test_record(task, data, args, record_fingerprint(task, args, scope, data))
    append_record(task, record)
    print(describe_record(record))
    for path in record.get("unresolved_files", []):
        print(f"警告：报告里的文件 {path} 对应不到仓库里的文件，相关测试不会算到任何条目上")
    return 0


def describe_record(record):
    head = f"已记录 {record['id']}（{record['kind']}，主机 {record['host']}，指纹 {record['fingerprint'][:12]}）"
    if record["kind"] == "test":
        counts = record["counts"]
        tags = "、".join(f"{tag} 通过 {value['passed']} 失败 {value['failed']}" for tag, value in sorted(record["tags"].items()))
        return f"{head}：通过 {counts['passed']}，失败 {counts['failed']}，跳过 {counts['skipped']}" + (f"；标签 {tags}" if tags else "")
    if record["kind"] == "command":
        return f"{head}：{record['command']} 退出码 {record['exit_code']}"
    if record["kind"] == "review":
        source = f"（按提交 {record['reviewed_commit'][:7]} 里的文件内容）" if record.get("reviewed_commit") else ""
        return f"{head}：{', '.join(record['items'])} 审核结论 {record['verdict']}{source}"
    return f"{head}：撤回 {record['target']}"


class Evaluation:
    def __init__(self, task):
        self.task = task
        self.repo = task.repo
        self.data = load_items(task)
        self.items = [entry for entry in self.data["items"] if isinstance(entry, dict)]
        goal_text = read_text(task.path("goal.md")) if task.path("goal.md").exists() else ""
        self.goal_entries, self.goal_errors = parse_goal(goal_text)
        self.goal_ids = {entry["id"] for entry in self.goal_entries}
        self.goal_texts = {entry["id"]: entry["text"] for entry in self.goal_entries}
        self.all_records, self.record_errors = load_records(task)
        self.records = in_time_order(effective_records(self.all_records))
        self.scope = scope_of(self.data)
        self.test_excludes = path_list(self.data, "test_exclude")
        self.entries = worktree_entries(self.repo, self.scope)
        self.fp = compute_fingerprint(self.repo, self.scope, self.entries)
        tags = {check["tag"] for entry in self.items for check in (entry.get("done_when") or [])
                if isinstance(check, dict) and check.get("type") == "test" and isinstance(check.get("tag"), str)}
        self.tag_files = find_tag_files(self.repo, tags)
        self._changed = {}
        self._untested = {}
        self._tree_digests = {}

    def changed_since(self, commit):
        if commit in self._changed:
            return self._changed[commit]
        if not commit or git(self.repo, "cat-file", "-e", f"{commit}^{{commit}}", check=False).returncode != 0:
            result = None
        else:
            old = tree_entries(self.repo, commit, self.scope)
            result = sorted(path for path in set(old) | set(self.entries) if old.get(path) != self.entries.get(path))
        self._changed[commit] = result
        return result

    def older(self, record, what):
        changed = self.changed_since(record.get("commit"))
        when = short_time(record["ran_at"]) if record.get("ran_at") else f"记录于 {short_time(record.get('time'))}"
        where = f"{(record.get('commit') or '')[:7]}（{when}，{record.get('host')}）"
        recorded, current = record.get("scope"), scope_record(self.scope)
        if recorded is not None and recorded != current:
            reason = f"{what}在 {where} 上通过，记录时的指纹范围（{describe_scope(recorded)}）和现在的设置（{describe_scope(current)}）不同，要在现在的设置下重跑"
            if record.get("host") != local_host():
                reason += "；在别的机器上算指纹时，要带上同样的 --include 和 --exclude"
            return "older", reason, []
        reason = f"{what}在 {where} 上通过，之后代码改过"
        if changed is None:
            reason += "；记录里的提交在本地找不到，列不出改了哪些文件"
            changed = []
        elif record.get("dirty"):
            reason += "；记录时有未提交改动，列出的文件可能偏多"
        elif not changed:
            reason = (f"{what}在 {where} 上通过，但指纹和现在不同；按现在的指纹设置比较，记录时的提交和现在没有文件差别："
                      "测试机上的文件和提交不同，或指纹设置改过，都会这样")
        return "older", reason, changed

    def host_ok(self, record, host):
        return host is None or record.get("host") == host

    def other_hosts_note(self, host, passed_elsewhere):
        if not host or not passed_elsewhere:
            return ""
        hosts = "、".join(sorted({str(record.get("host")) for record in passed_elsewhere}))
        return f"；另有 {len(passed_elsewhere)} 条通过记录在 {hosts} 上，这条检查只认 {host}，主机名要和记录里的完全一样"

    def current(self, record):
        return record.get("fingerprint") == self.fp["fingerprint"]

    def tree_digest(self, commit):
        if commit not in self._tree_digests:
            self._tree_digests[commit] = digest_lines(tree_entries(self.repo, commit, self.scope))
        return self._tree_digests[commit]

    def tested_commit(self, record):
        commit, fingerprint = record.get("commit"), record.get("fingerprint")
        if not commit or fingerprint in (None, UNKNOWN_FINGERPRINT):
            return None
        later = git(self.repo, "rev-list", "--reverse", f"{commit}..HEAD", check=False)
        if later.returncode != 0:
            return None
        return next((candidate for candidate in [commit, *later.stdout.split()] if self.tree_digest(candidate) == fingerprint), None)

    def untested_changes(self, record):
        if not self.test_excludes:
            return None
        recorded = record.get("test_exclude")
        key = (record.get("commit"), record.get("fingerprint"), record.get("code_fingerprint"),
               tuple(recorded) if isinstance(recorded, list) else None)
        if key not in self._untested:
            base = self.tested_commit(record)
            changed = self.changed_since(base) if base else None
            untested_only = changed is not None and all(excluded(path, self.test_excludes) for path in changed)
            if not untested_only:
                base = record.get("commit")
                changed = self.changed_since(base) if base else None
                if changed is not None and self.code_fingerprint_matches(record):
                    changed = sorted(path for path in changed if under_any(path, self.test_excludes))
                    untested_only = True
            self._untested[key] = (base, changed) if untested_only else None
        return self._untested[key]

    def code_fingerprint_matches(self, record):
        recorded = record.get("test_exclude")
        if not isinstance(recorded, list) or not isinstance(record.get("code_fingerprint"), str):
            return False
        if recorded != sorted(set(self.test_excludes)):
            return False
        return record["code_fingerprint"] == code_digest(self.entries, self.test_excludes)

    def test_current(self, record):
        return self.current(record) or self.untested_changes(record) is not None

    def relaxed_note(self, records):
        relaxed = [record for record in records if not self.current(record)]
        if not relaxed:
            return "", []
        commits = sorted({self.untested_changes(record)[0][:7] for record in relaxed})
        files = sorted({path for record in relaxed for path in self.untested_changes(record)[1]})
        if any(self.tested_commit(record) is None and record.get("dirty") for record in relaxed):
            return f"测试跑在 {'、'.join(commits)} 加记录时未提交的改动上，之后只改了测试不读的文件", files
        return f"测试跑在 {'、'.join(commits)} 上，之后只改了测试不读的文件", files

    def check(self, entry, check):
        if not isinstance(check, dict) or check.get("type") not in CHECK_TYPES:
            kind = check.get("type") if isinstance(check, dict) else check
            return "unknown", f"完成条件类型 {kind!r} 不认识", []
        kind = check["type"]
        if kind == "test" and isinstance(check.get("tag"), str):
            return self.check_tag(check)
        if kind == "test" and check.get("file") and check.get("name"):
            problem = placeholder_problem(check["name"])
            if problem:
                return "unknown", problem, []
            return self.check_selector(check)
        if kind == "test":
            return "unknown", "测试类完成条件要写 tag，或者同时写 file 和 name", []
        return getattr(self, f"check_{kind}")(entry, check)

    def check_tag(self, check):
        tag, host = check["tag"], check.get("host")
        files = sorted(self.tag_files.get(tag, set()))
        seen = any(tag in (record.get("tags") or {}) for record in self.all_records if record.get("kind") == "test")
        host_note = f"（只认 {host} 上的结果）" if host else ""
        if not files:
            if seen:
                return "unknown", f"测试标签 [{tag}] 以前出现在测试结果里，现在代码里找不到（测试被改名或删除了？）", []
            return "not_done", f"还没有带 [{tag}] 的测试", []
        relevant = [record for record in self.records if record.get("kind") == "test"
                    and tag in (record.get("tags") or {}) and self.host_ok(record, host)]
        current = [record for record in relevant if self.test_current(record)]
        if current:
            passed = sum(record["tags"][tag].get("passed", 0) for record in current)
            failed = [record for record in current if record["tags"][tag].get("failed", 0)]
            if failed:
                count = sum(record["tags"][tag]["failed"] for record in failed)
                ids = "、".join(record["id"] for record in failed)
                return "not_done", f"当前版本上 [{tag}] 有 {count} 个失败（{ids}）；失败和改动无关时用 record --retract 撤回并写明原因", []
            ran = set()
            for record in current:
                ran.update(record["tags"][tag].get("files", []))
            missing = [path for path in files if path not in ran]
            if passed and not missing:
                note, untested = self.relaxed_note(current)
                if note:
                    return "verified", f"[{tag}] 通过 {passed} 个{host_note}；{note}", untested
                return "verified", f"[{tag}] 在当前版本上通过 {passed} 个{host_note}", []
            if missing:
                more = f" 等 {len(missing)} 个" if len(missing) > 3 else ""
                return "not_done", f"当前版本上这些带 [{tag}] 的文件还没跑：{', '.join(missing[:3])}{more}", []
        passed_elsewhere = [
            record for record in self.records
            if record.get("kind") == "test" and not self.host_ok(record, host)
            and tag in (record.get("tags") or {})
            and record["tags"][tag].get("passed", 0) > 0
            and not record["tags"][tag].get("failed", 0)
        ]
        return self.older_or_missing(relevant, lambda record: record["tags"][tag], f"[{tag}] ",
                                     f"当前版本上没有 [{tag}] 的通过记录{host_note}" + self.other_hosts_note(host, passed_elsewhere))

    def older_or_missing(self, relevant, counts_of, what, missing_reason):
        seen = set()
        for record in reversed(relevant):
            fingerprint = record.get("fingerprint")
            if self.test_current(record) or fingerprint in seen:
                continue
            if fingerprint == UNKNOWN_FINGERPRINT:
                group = [counts_of(record)]
            else:
                seen.add(fingerprint)
                group = [counts_of(other) for other in relevant if other.get("fingerprint") == fingerprint]
            if sum(value.get("passed", 0) for value in group) and not sum(value.get("failed", 0) for value in group):
                return self.older(record, what)
        return "not_done", missing_reason, []

    def check_selector(self, check):
        file_rel, name, host = check["file"], check["name"], check.get("host")
        full = self.repo / file_rel
        key = (file_rel, name)
        seen = any((entry.get("file"), entry.get("name")) == key
                   for record in self.all_records if record.get("kind") == "test" for entry in record.get("selected") or [])
        if not full.is_file():
            if seen:
                return "unknown", f"测试文件 {file_rel} 不在了，但以前的测试结果里有它（被改名或删除了？）", []
            return "not_done", f"测试还没写：{file_rel} 不存在", []
        if name not in full.read_text(encoding="utf-8", errors="replace"):
            hint = "标题由模板拼成时（含 %s 之类），name 只写源码里原样出现的一段"
            if seen:
                return "unknown", f"{file_rel} 里找不到原文“{name}”，但以前的测试结果里有它：测试改名或删除了？{hint}", []
            return "not_done", f"{file_rel} 里还没有原文“{name}”：测试还没写？{hint}", []

        def entry_of(record):
            for entry in record.get("selected") or []:
                if (entry.get("file"), entry.get("name")) == key:
                    return entry
            return None

        relevant = [record for record in self.records if record.get("kind") == "test"
                    and entry_of(record) is not None and self.host_ok(record, host)]
        current_records = [record for record in relevant if self.test_current(record)]
        current = [entry_of(record) for record in current_records]
        label = f"“{name}”（{file_rel}）"
        if current:
            if any(entry.get("failed", 0) for entry in current):
                return "not_done", f"当前版本上 {label} 失败过；失败和改动无关时用 record --retract 撤回并写明原因", []
            if any(entry.get("passed", 0) for entry in current):
                note, untested = self.relaxed_note(current_records)
                if note:
                    return "verified", f"{label} 通过；{note}", untested
                return "verified", f"{label} 在当前版本上通过", []
        passed_elsewhere = []
        for record in self.records:
            if record.get("kind") != "test" or self.host_ok(record, host):
                continue
            entry = entry_of(record)
            if entry is None:
                continue
            if entry.get("passed", 0) > 0 and not entry.get("failed", 0):
                passed_elsewhere.append(record)
        return self.older_or_missing(relevant, entry_of, label,
                                     f"当前版本上没有 {label} 的通过记录"
                                     + (f"（只认 {host} 上的结果）" if host else "")
                                     + self.other_hosts_note(host, passed_elsewhere))

    def check_review(self, entry, check):
        reviewer = check.get("by")
        reviews = [record for record in self.records if record.get("kind") == "review"
                   and entry["id"] in (record.get("items") or []) and (reviewer is None or record.get("by") == reviewer)]
        if not reviews:
            return "not_done", "还没有审核记录" + (f"（需要 {reviewer} 审核）" if reviewer else ""), []
        latest = reviews[-1]
        if latest.get("verdict") != "approved":
            return "not_done", f"最近一次审核结论是 {latest.get('verdict')}（{latest['id']}）", []
        files = latest.get("files") or {}
        if not files:
            return "verified", f"{latest.get('by')} 在 {short_time(latest.get('time'))} 审核通过；没有绑定文件：{latest.get('note') or '（没有说明）'}", []
        current = hash_paths(self.repo, list(files))
        changed = sorted(path for path, blob in files.items() if current.get(path) != blob)
        when = short_time(latest.get("time"))
        if not changed:
            return "verified", f"{latest.get('by')} 在 {when} 审核通过，审核过的文件没变", []
        return "older", f"{latest.get('by')} 在 {when} 审核通过，之后审核过的文件改了", changed

    def check_user(self, entry, check):
        ref = check.get("ref")
        if not ref:
            return "waiting", check.get("question") or "（没有写要决定的问题）", []
        if ref in self.goal_ids:
            return "verified", f"你的决定见 goal.md {ref}", []
        return "unknown", f"引用的决定 {ref} 在 goal.md 里不存在", []

    def check_doc(self, entry, check):
        rel = check.get("path")
        if not isinstance(rel, str):
            return "unknown", "文档类完成条件缺少 path", []
        full = self.repo / rel
        if not full.is_file():
            return "not_done", f"文档 {rel} 不存在", []
        text = full.read_text(encoding="utf-8", errors="replace")
        heading = check.get("heading")
        if heading:
            found = False
            for line in text.splitlines():
                match = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
                if match and match.group(1) == heading:
                    found = True
                    break
            if not found:
                return "not_done", f"{rel} 里还没有“{heading}”这一节", []
        if "quotes" not in check:
            return "verified", (f"{rel} 里有“{heading}”这一节" if heading else f"{rel} 存在"), []
        if not quotes_valid(check.get("quotes")):
            return "unknown", '文档类完成条件的 quotes 要写 G 编号或 G 编号列表，例如 "G12" 或 ["G12", "G13"]', []
        quotes = quotes_of(check)
        unknown = [ref for ref in quotes if ref not in self.goal_ids]
        if unknown:
            return "unknown", f"quotes 里的 {'、'.join(unknown)} 在 goal.md 里不存在", []
        document = normalize_quote(text)
        missing = [ref for ref in quotes if normalize_quote(self.goal_texts[ref]) not in document]
        if missing:
            return "not_done", f"文档 {rel} 里没有 {'、'.join(missing)} 的原话：要原样引用（空白和换行可以不同）", []
        if heading:
            return "verified", f"{rel} 里有“{heading}”这一节，并原样引用了 {'、'.join(quotes)} 的原话", []
        return "verified", f"{rel} 原样引用了 {'、'.join(quotes)} 的原话", []

    def check_command(self, entry, check):
        run, host = check.get("run"), check.get("host")
        if not isinstance(run, str) or not run:
            return "unknown", "命令类完成条件缺少 run", []
        if "scope" in check:
            problem = environment_problem(check)
            if problem:
                return "unknown", problem, []
            return self.check_environment(run, host, check["max_age_days"])
        relevant = [record for record in self.records if record.get("kind") == "command"
                    and record.get("command") == run and self.host_ok(record, host)]
        ignore = check.get("ignore_test_exclude") is True
        current = [record for record in relevant if self.current(record)]
        if ignore:
            current = [record for record in relevant if self.test_current(record)]
        if current:
            failed = [record for record in current if record.get("exit_code") != 0]
            if failed:
                return "not_done", f"当前版本上“{run}”失败过（{'、'.join(record['id'] for record in failed)}）", []
            note, untested = self.relaxed_note(current) if ignore else ("", [])
            if note:
                return "verified", f"“{run}”在当前版本上通过；{note}", untested
            return "verified", f"“{run}”在当前版本上通过", []
        for record in reversed(relevant):
            if record.get("exit_code") == 0:
                return self.older(record, f"“{run}”")
        passed_elsewhere = [
            record for record in self.records
            if record.get("kind") == "command" and not self.host_ok(record, host)
            and record.get("command") == run and record.get("exit_code") == 0
        ]
        return "not_done", f"当前版本上还没有跑“{run}”" + (f"（只认 {host} 上的结果）" if host else "") + self.other_hosts_note(host, passed_elsewhere), []

    def check_environment(self, run, host, days):
        records = [record for record in self.records if record.get("kind") == "command"
                   and record.get("command") == run and record.get("host") == host]
        passed_elsewhere = [
            record for record in self.records
            if record.get("kind") == "command" and not self.host_ok(record, host)
            and record.get("command") == run and record.get("exit_code") == 0
        ]
        if not records:
            return "not_done", f"还没有在 {host} 上跑“{run}”的记录" + self.other_hosts_note(host, passed_elsewhere), []
        latest = records[-1]
        when = short_time(latest.get("time"))
        if latest.get("exit_code") != 0:
            return "not_done", f"“{run}”在 {host} 上最近一次（{when}）失败，退出码 {latest.get('exit_code')}（{latest['id']}）", []
        moment = report_moment(latest.get("time"))
        if moment is None:
            return "unknown", f"记录 {latest['id']} 的时间读不出来", []
        if moment.tzinfo is None:
            moment = moment.astimezone()
        if now() - moment > dt.timedelta(days=days):
            return "older", f"“{run}”在 {host} 上 {when} 通过，已超过 {days} 天有效期，需要重验", []
        return "verified", f"“{run}”在 {host} 上 {when} 通过，{days} 天内有效，和代码版本无关", []

    def item(self, entry):
        result = {"id": entry.get("id"), "title": entry.get("title") or "", "status": None,
                  "reasons": [], "changed_files": [], "checks": []}
        withdrawn = entry.get("withdrawn")
        if withdrawn:
            ref = withdrawn.get("ref") if isinstance(withdrawn, dict) else None
            if ref in self.goal_ids:
                result.update(status="withdrawn", reasons=[f"不做：依据 goal.md {ref}"])
            else:
                result.update(status="unknown", reasons=[f"撤回依据 {ref} 在 goal.md 里不存在"])
            return result
        statuses = []
        missing = [ref for ref in entry.get("goal_ref") or [] if ref not in self.goal_ids]
        if missing:
            statuses.append("unknown")
            result["reasons"].append(f"对应的目标 {', '.join(missing)} 在 goal.md 里不存在")
        if not entry.get("goal_ref"):
            statuses.append("unknown")
            result["reasons"].append("没有写对应哪条目标（goal_ref）")
        checks = entry.get("done_when") or []
        if not checks:
            statuses.append("unknown")
            result["reasons"].append("没有完成条件（done_when 为空）")
        for check in checks:
            status, reason, changed = self.check(entry, check)
            statuses.append(status)
            result["checks"].append({"type": check.get("type") if isinstance(check, dict) else None,
                                     "status": status, "reason": reason, "changed_files": changed})
            if status == "verified":
                continue
            for path in changed:
                if path not in result["changed_files"]:
                    result["changed_files"].append(path)
        result["status"] = next(status for status in STATUS_PRIORITY if status in statuses) if statuses else "unknown"
        shown = STATUS_PRIORITY if result["status"] == "verified" else STATUS_PRIORITY[:-1]
        result["reasons"] += [check["reason"] for status in shown for check in result["checks"] if check["status"] == status]
        return result

    def report(self):
        items = [self.item(entry) for entry in self.items]
        counts = {key: 0 for key in COUNT_ORDER}
        for entry in items:
            counts[entry["status"]] += 1
        return {
            "task": self.task.name,
            "dir": self.task.rel,
            "fingerprint": self.fp["fingerprint"],
            "commit": self.fp["commit"],
            "dirty": self.fp["dirty"],
            "counts": counts,
            "items": items,
            "changes_since_last": [],
            "include": self.scope[0],
            "warnings": (self.goal_errors + self.record_errors + include_problems(self.repo, self.scope[0])
                         + decision_warnings(self.data, self.goal_entries, self.items)),
        }


def snapshot_path(task):
    common = git_out(task.repo, "rev-parse", "--git-common-dir").strip()
    base = Path(common) if os.path.isabs(common) else task.repo / common
    return base / "longtask" / f"{task.name}.status.json"


def load_snapshot(task):
    try:
        return json.loads(read_text(snapshot_path(task)))
    except (OSError, ValueError, Fail):
        return None


def save_snapshot(task, report):
    try:
        path = snapshot_path(task)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {"time": iso(now()), "fingerprint": report["fingerprint"],
                "statuses": {entry["id"]: entry["status"] for entry in report["items"]}}
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except (OSError, Fail):
        pass


def changes_since(previous, report):
    if not previous:
        return []
    before = previous.get("statuses") or {}
    return [{"id": entry["id"], "from": before.get(entry["id"]), "to": entry["status"]}
            for entry in report["items"] if before.get(entry["id"]) != entry["status"]]


def summary_line(counts):
    total = sum(counts.values())
    parts = [f"{LABELS[key]} {counts[key]}" for key in COUNT_ORDER if counts.get(key)]
    return f"共 {total} 项" + ("：" + " · ".join(parts) if parts else "")


def format_files(paths, limit=3):
    shown = "、".join(paths[:limit])
    return shown + (f" 等 {len(paths)} 个" if len(paths) > limit else "")


def format_status(report, previous):
    dirty = "，有未提交改动" if report["dirty"] else ""
    lines = [
        f"长任务 {report['task']}（{report['dir']}）—— 状态由 longtask.py 从证据算出，不是手写的",
        f"代码：HEAD {(report['commit'] or '（还没有提交）')[:7]}{dirty}；指纹 {report['fingerprint'][:12]}",
        summary_line(report["counts"]),
    ]
    if report["include"]:
        lines.insert(2, f"指纹只看：{'、'.join(report['include'])}")
    for status in DISPLAY_ORDER:
        group = [entry for entry in report["items"] if entry["status"] == status]
        if not group:
            continue
        lines += ["", LABELS[status]]
        for entry in group:
            lines.append(f"  {entry['id']}  {entry['title']}")
            if status == "verified":
                for check in entry["checks"]:
                    if check["changed_files"]:
                        lines.append(f"      {check['reason']}：{format_files(check['changed_files'])}")
                continue
            for reason in entry["reasons"][:3]:
                lines.append(f"      {reason}")
            if entry["changed_files"]:
                lines.append(f"      之后改过：{format_files(entry['changed_files'])}")
    if report["changes_since_last"]:
        when = short_time((previous or {}).get("time"))
        changes = "；".join(f"{change['id']} {LABELS.get(change['from'], '新条目')} → {LABELS[change['to']]}"
                           for change in report["changes_since_last"])
        lines += ["", f"和上次（{when}）相比：{changes}"]
    for warning in report["warnings"]:
        lines.append(f"警告：{warning}")
    return "\n".join(lines)


def format_brief(report):
    lines = [f"长任务 {report['task']}，{summary_line(report['counts'])}"]
    for status in DISPLAY_ORDER:
        lines += [f"{entry['id']}  {LABELS[status]}  {entry['title']}" for entry in report["items"] if entry["status"] == status]
    lines += [f"警告：{warning}" for warning in report["warnings"]]
    return "\n".join(lines)


def cmd_status(args):
    repo = repo_from(args)
    task = resolve_task(repo, args.task)
    report = Evaluation(task).report()
    previous = load_snapshot(task)
    report["changes_since_last"] = changes_since(previous, report)
    if not args.no_save:
        save_snapshot(task, report)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    elif args.brief:
        print(format_brief(report))
    else:
        print(format_status(report, previous))
    return 2 if report["counts"]["unknown"] else 0


def parse_sections(text):
    sections, current, in_comment = {}, None, False
    for number, line in enumerate(text.splitlines(), 1):
        starts_comment = "<!--" in line
        if line.startswith("## ") and not in_comment:
            current = line[3:].strip()
            sections.setdefault(current, [])
        elif current is not None:
            sections[current].append((number, line, in_comment or starts_comment))
        if starts_comment and "-->" not in line.split("<!--", 1)[1]:
            in_comment = True
        elif in_comment and "-->" in line:
            in_comment = False
    return sections


def section_lines(text, name):
    return norm_lines("\n".join(line for _, line, _ in parse_sections(text).get(name, [])))


def strip_blank_head(lines):
    lines = list(lines)
    while lines and not lines[0]:
        lines.pop(0)
    return lines


def context_lines(text, name):
    return [line for line in strip_blank_head(section_lines(text, name)) if line.strip()]


def file_versions(task, name):
    path = f"{task.rel}/{name}"
    commits = git_out(task.repo, "log", "-n", "200", "--format=%H", "--", path).split()
    versions = []
    for commit in reversed(commits):
        shown = git(task.repo, "show", f"{commit}:{path}", check=False)
        versions.append((commit[:7], shown.stdout if shown.returncode == 0 else None))
    current = task.path(name)
    versions.append(("工作区", read_text(current) if current.exists() else None))
    return versions


def kept_in_order(old, new):
    remaining = iter(new)
    return all(line in remaining for line in old)


def append_only_errors(versions, label, extract, may_insert=False):
    errors, previous = [], None
    for name, text in versions:
        if text is None:
            errors.append(f"{label} 在 {name} 里被删除了")
            previous = None
            continue
        lines = strip_blank_head(extract(text))
        kept = previous is None or (kept_in_order(previous[1], lines) if may_insert else lines[: len(previous[1])] == previous[1])
        if not kept:
            errors.append(f"{label} 不是只追加：{previous[0]} → {name} 改动、删除或调换了已有内容")
        previous = (name, lines)
    return errors


def validate_check(name, check):
    if not isinstance(check, dict):
        return [f"条目 {name} 的完成条件 {check!r} 必须是对象"]
    kind = check.get("type")
    if kind not in CHECK_TYPES:
        return [f"条目 {name} 的完成条件类型 {kind!r} 不认识（可用：{'、'.join(CHECK_TYPES)}）"]
    errors = []
    if kind == "test":
        tag = check.get("tag")
        if tag is not None and not (isinstance(tag, str) and ITEM_ID.fullmatch(tag)):
            errors.append(f"条目 {name} 的测试标签 {tag!r} 格式不对，例如 R2-D1")
        if tag is None and not (isinstance(check.get("file"), str) and isinstance(check.get("name"), str)):
            errors.append(f"条目 {name} 的测试类完成条件要写 tag，或者同时写 file 和 name")
        problem = placeholder_problem(check.get("name"))
        if problem:
            errors.append(f"条目 {name} 的{problem}")
    elif kind == "doc":
        if not isinstance(check.get("path"), str):
            errors.append(f"条目 {name} 的文档类完成条件缺少 path")
        if "quotes" in check and not quotes_valid(check.get("quotes")):
            errors.append(f"条目 {name} 的文档类完成条件的 quotes 要写 G 编号或 G 编号列表，例如 \"G12\" 或 [\"G12\", \"G13\"]")
    elif kind == "user":
        if check.get("ref") is None and not check.get("question"):
            errors.append(f"条目 {name} 等你决定的完成条件要写 question")
    elif kind == "command" and not (isinstance(check.get("run"), str) and check.get("run")):
        errors.append(f"条目 {name} 的命令类完成条件缺少 run")
    elif kind == "command" and "scope" in check:
        problem = environment_problem(check)
        if problem:
            errors.append(f"条目 {name} 的{problem}")
        problem = ignore_test_exclude_problem(check)
        if problem:
            errors.append(f"条目 {name} 的{problem}")
    elif kind == "command":
        problem = ignore_test_exclude_problem(check)
        if problem:
            errors.append(f"条目 {name} 的{problem}")
    if "host" in check and not isinstance(check["host"], str):
        errors.append(f"条目 {name} 的 host 必须是字符串")
    return errors


def validate_items(data, goal_ids):
    errors = []
    prefix = data.get("prefix")
    if not (isinstance(prefix, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", prefix)):
        errors.append("items.json 的 prefix 必须是字母开头的字母数字串，例如 R2")
        prefix = None
    if not isinstance(data.get("task"), str):
        errors.append("items.json 缺少 task")
    fingerprint = data.get("fingerprint")
    if fingerprint is not None and not (isinstance(fingerprint, dict) and isinstance(fingerprint.get("exclude", []), list)):
        errors.append("items.json 的 fingerprint.exclude 必须是路径列表")
    include = fingerprint.get("include", []) if isinstance(fingerprint, dict) else []
    if not (isinstance(include, list) and all(isinstance(value, str) for value in include)):
        errors.append('items.json 的 fingerprint.include 必须是路径列表，例如 ["skill-a/", "README.md"]')
    test_exclude = fingerprint.get("test_exclude", []) if isinstance(fingerprint, dict) else []
    if not (isinstance(test_exclude, list) and all(isinstance(value, str) for value in test_exclude)):
        errors.append('items.json 的 fingerprint.test_exclude 必须是路径列表，例如 ["docs/", "AGENTS.md"]')
    seen = set()
    for index, entry in enumerate(data["items"], 1):
        where = f"items.json 第 {index} 个条目"
        if not isinstance(entry, dict):
            errors.append(f"{where} 必须是对象")
            continue
        item_id = entry.get("id")
        name = item_id if isinstance(item_id, str) else where
        if not (isinstance(item_id, str) and ITEM_ID.fullmatch(item_id)):
            errors.append(f"{where} 的编号 {item_id!r} 格式不对，例如 {prefix or 'R2'}-D1")
        elif prefix and not item_id.startswith(prefix + "-"):
            errors.append(f"条目 {item_id} 的编号必须以 {prefix}- 开头")
        if item_id in seen:
            errors.append(f"条目编号 {item_id} 重复")
        seen.add(item_id)
        if not (isinstance(entry.get("title"), str) and entry["title"].strip()):
            errors.append(f"条目 {name} 缺少 title")
        refs = entry.get("goal_ref")
        if not (isinstance(refs, list) and refs):
            errors.append(f"条目 {name} 没有写对应哪条目标（goal_ref）")
        else:
            for ref in refs:
                if ref not in goal_ids:
                    errors.append(f"条目 {name} 对应的目标 {ref} 在 goal.md 里不存在")
        added = entry.get("added")
        if not (isinstance(added, dict) and added.get("by") and added.get("on")):
            errors.append(f"条目 {name} 的 added 要写 by 和 on")
        checks = entry.get("done_when")
        may_be_empty = entry.get("withdrawn") is not None and checks in (None, [])
        if not may_be_empty and not (isinstance(checks, list) and checks):
            errors.append(f"条目 {name} 没有完成条件（done_when 为空）；只有写了 withdrawn 的条目可以不写")
        elif isinstance(checks, list):
            for check in checks:
                errors += validate_check(name, check)
        withdrawn = entry.get("withdrawn")
        if withdrawn is not None:
            if not (isinstance(withdrawn, dict) and withdrawn.get("on") and withdrawn.get("ref")):
                errors.append(f"条目 {name} 的 withdrawn 要写 on 和 ref（你的决定在 goal.md 里的编号）")
            elif withdrawn["ref"] not in goal_ids:
                errors.append(f"条目 {name} 的撤回依据 {withdrawn['ref']} 在 goal.md 里不存在")
    return errors


def head_text(task, name):
    shown = git(task.repo, "show", f"HEAD:{task.rel}/{name}", check=False)
    return shown.stdout if shown.returncode == 0 else None


def lint_task(task):
    errors, warnings = [], []
    for name in TASK_FILES:
        if not task.path(name).exists():
            errors.append(f"缺少 {task.rel}/{name}")
    if errors:
        return errors, warnings
    goal = read_text(task.path("goal.md"))
    entries, goal_errors = parse_goal(goal)
    errors += goal_errors
    ids = [entry["id"] for entry in entries]
    goal_ids = set(ids)
    if not [value for value in ids if value != "CLOSED"]:
        errors.append("goal.md 里还没有任何目标记录（## G1 …）")
    for value in sorted({value for value in ids if ids.count(value) > 1}):
        errors.append(f"goal.md 里的编号 {value} 重复")
    if "CLOSED" in ids and ids[-1] != "CLOSED":
        errors.append("goal.md 的 CLOSED 记录必须是最后一条")
    data = None
    try:
        data = load_items(task)
    except Fail as error:
        errors.append(str(error))
    if data:
        errors += validate_items(data, goal_ids)
        errors += decision_errors(data, entries, [entry for entry in data["items"] if isinstance(entry, dict)])
        errors += include_problems(task.repo, path_list(data, "include"))
        if not data["items"]:
            warnings.append("items.json 里还没有条目")
    records, record_errors = load_records(task)
    errors += record_errors
    record_ids = {record["id"] for record in records}
    for record in records:
        if record.get("kind") == "retract" and record.get("target") not in record_ids:
            errors.append(f"撤回记录 {record['id']} 指向不存在的证据 {record.get('target')}")
    plan = read_text(task.path("plan.md"))
    sections = parse_sections(plan)
    for name in PLAN_SECTIONS:
        if name not in sections:
            errors.append(f"plan.md 缺少“## {name}”一节")
    for name, lines in sections.items():
        if name in LOG_SECTIONS:
            continue
        for number, line, in_comment in lines:
            match = None if in_comment else STATUS_WORDS.search(line)
            if match:
                errors.append(f"plan.md 第 {number} 行写了进度（“{match.group(0)}”）：{PROGRESS_HINT}")
    for number, line in enumerate(plan.splitlines(), 1):
        if line.startswith("## "):
            break
        match = None if "<!--" in line else STATUS_WORDS.search(line)
        if match and not line.startswith("#"):
            errors.append(f"plan.md 第 {number} 行写了进度（“{match.group(0)}”）：{PROGRESS_HINT}")
    if data and isinstance(data.get("prefix"), str):
        pattern = re.compile(rf"(?<![A-Za-z0-9]){re.escape(data['prefix'])}-{ID_BODY}")
        known = {entry.get("id") for entry in data["items"] if isinstance(entry, dict)}
        batch, mentioned = [], []
        for _, line, in_comment in sections.get("当前批次", []):
            bullet = None if in_comment else re.match(r"^\s*[-*]\s+", line)
            if not bullet:
                continue
            mentioned += pattern.findall(line)
            found = pattern.match(line, bullet.end())
            if found and found.group(0) not in batch:
                batch.append(found.group(0))
        if len(batch) > 3:
            errors.append(f"当前批次有 {len(batch)} 项以条目编号开头（{'、'.join(batch)}），最多 3 项；同一次测试顺带验证的条目写在不以编号开头的一行里")
        for value in dict.fromkeys(mentioned):
            if value not in known:
                warnings.append(f"当前批次里的 {value} 在 items.json 里不存在")
    errors += append_only_errors(file_versions(task, "goal.md"), "goal.md", norm_lines)
    errors += append_only_errors(file_versions(task, "evidence.jsonl"), "evidence.jsonl", norm_lines, may_insert=True)
    plan_versions = file_versions(task, "plan.md")
    for name in LOG_SECTIONS:
        errors += append_only_errors(plan_versions, f"plan.md 的“{name}”", lambda text, name=name: section_lines(text, name))
    head_items = head_text(task, "items.json")
    if data and head_items:
        try:
            before_data = json.loads(head_items)
        except json.JSONDecodeError:
            before_data = {}
        if not isinstance(before_data, dict):
            before_data = {}
        before = {entry["id"]: entry for entry in before_data.get("items") or []
                  if isinstance(entry, dict) and "id" in entry}
        after = {entry.get("id"): entry for entry in data["items"] if isinstance(entry, dict)}
        head_plan = head_text(task, "plan.md") or ""
        old_log = strip_blank_head(section_lines(head_plan, "计划改动记录"))
        new_log = strip_blank_head(section_lines(plan, "计划改动记录"))
        added_lines = new_log[len(old_log):] if new_log[: len(old_log)] == old_log else new_log
        for item_id, old in before.items():
            if item_id not in after:
                errors.append(f"条目 {item_id} 被删除了：不做的条目要保留，用 withdrawn 写明依据")
                continue
            new = after[item_id]
            changed = (json.dumps(old.get("done_when"), sort_keys=True) != json.dumps(new.get("done_when"), sort_keys=True)
                       or json.dumps(old.get("withdrawn"), sort_keys=True) != json.dumps(new.get("withdrawn"), sort_keys=True))
            if changed and not any(item_id in line for line in added_lines):
                errors.append(f"条目 {item_id} 的完成条件或撤回状态改了，但 plan.md 的“计划改动记录”里没有新写一行说明（要提到 {item_id}）")
        before_decisions = before_data.get("decisions")
        after_decisions = data.get("decisions")
        if isinstance(before_decisions, dict):
            if not isinstance(after_decisions, dict):
                if not any("decisions" in line for line in added_lines):
                    errors.append("items.json 删掉了 decisions，要在计划改动记录里写一行说明原因（含 decisions）")
            else:
                for gid, value in before_decisions.items():
                    if value != "durable" or after_decisions.get(gid) == "durable":
                        continue
                    word = re.compile(rf"(?<![A-Za-z0-9]){re.escape(gid)}(?![0-9])")
                    if not any(word.search(line) for line in added_lines):
                        errors.append(f"长期决定 {gid} 不再标为 durable，但 plan.md 的“计划改动记录”里没有新写一行说明（要提到 {gid}）")
    return errors, warnings


def cmd_lint(args):
    repo = repo_from(args)
    task = resolve_task(repo, args.task)
    errors, warnings = lint_task(task)
    for error in errors:
        print(f"错误：{error}")
    for warning in warnings:
        print(f"警告：{warning}")
    if not errors:
        print(f"{task.rel} 检查通过" + (f"，{len(warnings)} 条警告" if warnings else ""))
    return 1 if errors else 0


def build_context(task, budget):
    header = f"【长任务 {task.name}】{task.rel}/ —— 下面的状态由 longtask.py 从证据算出，不是手写的"
    try:
        evaluation = Evaluation(task)
        report = evaluation.report()
    except Fail as error:
        return truncate(f"{header}\n读取出错：{error}。先修好再按 long-task-planning 的规则工作（{home_short(SKILL_MD)}）。", budget)
    goals = [entry for entry in evaluation.goal_entries if entry["id"] != "CLOSED"]
    goals = goals[:1] + sorted(goals[1:], key=lambda entry: entry["date"])
    plan_path = task.path("plan.md")
    plan = read_text(plan_path) if plan_path.exists() else ""
    batch = context_lines(plan, "当前批次")
    log = context_lines(plan, "计划改动记录")
    problems = [entry for status in ("unknown", "waiting", "not_done") for entry in report["items"] if entry["status"] == status]
    missing_decisions = decision_missing(evaluation.data, evaluation.goal_entries)
    unlinked_decisions = decision_unlinked(evaluation.data, evaluation.goal_entries, evaluation.items)
    decision_text = ""
    if missing_decisions or unlinked_decisions:
        parts = []
        if missing_decisions:
            parts.append(f"{'、'.join(missing_decisions)} 还没分类")
        if unlinked_decisions:
            parts.append(f"{'、'.join(unlinked_decisions)} 是长期决定，还没有文档条目")
        decision_text = "长期决定：" + "；".join(parts)

    def render(goal_keep, goal_width, problem_limit, line_width, questions):
        lines = [header, "目标（goal.md 原文）："]
        shown = goals if len(goals) <= goal_keep else goals[:1] + goals[-(goal_keep - 1):]
        for index, entry in enumerate(shown):
            if len(goals) > goal_keep and index == 1:
                lines.append(f"  ……中间 {len(goals) - goal_keep} 条见 goal.md")
            answer = truncate(entry["text"], goal_width)
            if questions and entry["question"]:
                answer = f"问：{truncate(entry['question'], goal_width)} 答：{answer}"
            lines.append(f"  {entry['id']} {entry['date']}（{entry['source']}）：{answer}")
        lines.append(f"状态：{summary_line(report['counts'])}")
        if decision_text:
            lines.append(truncate(decision_text, line_width))
        for entry in problems[:problem_limit]:
            reason = entry["reasons"][0] if entry["reasons"] else ""
            lines.append(f"  {LABELS[entry['status']]} {entry['id']}：{truncate(reason, line_width)}")
        if len(problems) > problem_limit:
            lines.append(f"  ……另有 {len(problems) - problem_limit} 项未完成或有问题，运行 status 查看")
        lines.append("当前批次（plan.md）：" + ("" if batch else "（空）"))
        for line in batch[:4]:
            lines.append(f"  {truncate(line, line_width)}")
        if log:
            lines.append(f"最近一次计划改动：{truncate(log[-1].lstrip('-* '), line_width)}")
        lines.append(f"规则：做没做完只看 `python3 {home_short(SCRIPT_PATH)} status`；重新规划、改目标或完成条件前先读 {home_short(SKILL_MD)}。")
        return "\n".join(lines)

    for settings in ((6, 160, 6, 120), (4, 110, 4, 100), (3, 70, 3, 80), (2, 50, 2, 60)):
        for questions in (True, False):
            text = render(*settings, questions)
            if len(text) <= budget:
                return text
    return text[: budget - 8] + "……（已截断）"


def hook_output(cwd, source):
    repo = find_repo(cwd)
    if repo is None:
        return ""
    tasks = active_tasks(repo)
    if not tasks:
        if source in SOURCE_EVENTS:
            return REMINDER.format(event=SOURCE_EVENTS[source], tasks=TASKS_DIR, skill=home_short(SKILL_MD))
        return ""
    budget = CONTEXT_BUDGET // len(tasks)
    return "\n\n".join(build_context(task, budget) for task in tasks)


def cmd_hook(args):
    try:
        raw = "" if sys.stdin is None or sys.stdin.isatty() else sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        cwd = Path(payload.get("cwd") or os.getcwd())
        output = hook_output(cwd, payload.get("source") or "startup")
    except (Fail, OSError, ValueError, LookupError, TypeError, AttributeError, RuntimeError) as error:
        output = f"【长任务】钩子出错，不影响会话：{error}"
    if output:
        print(output)
    return 0


def cmd_context(args):
    repo = repo_from(args)
    task = resolve_task(repo, args.task)
    print(build_context(task, CONTEXT_BUDGET))
    return 0


def cmd_fingerprint(args):
    repo = repo_from(args)
    includes = list(args.include or [])
    excludes = list(args.exclude or [])
    task = None
    if args.task:
        task = resolve_task(repo, args.task)
    else:
        active = active_tasks(repo)
        if len(active) > 1:
            raise Fail("有多个进行中的任务，请用 --task 指定：" + "、".join(entry.name for entry in active))
        task = active[0] if active else None
    if task:
        data = load_items(task)
        includes += [value for value in path_list(data, "include") if value not in includes]
        excludes += [value for value in path_list(data, "exclude") if value not in excludes]
    scope = (includes, excludes)
    entries = worktree_entries(repo, scope)
    if args.list:
        for line in fingerprint_lines(entries):
            sys.stdout.buffer.write(line.encode("utf-8", "surrogateescape") + b"\n")
        return 0
    result = compute_fingerprint(repo, scope, entries)
    result.update({"host": local_host(), "time": iso(now()), "includes": includes, "excludes": excludes,
                   "task": task.name if task else None})
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        dirty = "，有未提交改动" if result["dirty"] else ""
        print(f"指纹 {result['fingerprint']}（HEAD {result['commit'][:7]}{dirty}，主机 {result['host']}）")
    return 0


def title_fragment(title, text):
    words = list(re.finditer(r"\S+", title))
    found = [title[words[first].start():words[last].end()] for first in range(len(words)) for last in range(first, len(words))]
    found = [span for span in found if span in text]
    return min(found, key=lambda span: (text.count(span), -len(span)), default=None)


def cmd_find_tests(args):
    repo = repo_from(args)
    report = args.vitest or args.junit
    if not Path(report).is_file():
        raise Fail(f"测试报告 {report} 不存在")
    try:
        results, _ = parse_vitest(report) if args.vitest else parse_junit(report)
    except (json.JSONDecodeError, ElementTree.ParseError) as error:
        raise Fail(f"读不了测试报告 {report}：{error}")
    changed = None
    if args.commit:
        commit = resolve_commit(repo, args.commit)
        changed = set(split_z(git_out(repo, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "--diff-filter=AM", commit)))
    mapper = PathMapper(repo_files(repo))
    word = args.grep.casefold() if args.grep else None
    by_path, chosen, notes, unmapped, skipped = {}, [], [], set(), 0
    for names, full, status, title in results:
        if status == "skipped":
            skipped += 1
            continue
        path = mapper.first(names)
        if path is None:
            unmapped.add(names[0] if names else "（报告里没有文件名）")
            continue
        by_path.setdefault(path, []).append(full)
        if (word is None or word in full.casefold()) and (changed is None or path in changed):
            chosen.append((path, full, title))
    printed, texts = [], {}
    if not chosen:
        notes.append("报告里没有符合条件的测试，没有列出任何检查")
    for path, full, title in chosen:
        if path not in texts:
            texts[path] = (repo / path).read_text(encoding="utf-8", errors="replace")
        fragment = title_fragment(title, texts[path])
        if fragment is None:
            notes.append(f"{path} 里找不到测试“{full}”标题里原样出现的一段，请手动挑一段")
            continue
        if (path, fragment) in printed:
            continue
        printed.append((path, fragment))
        print(json.dumps({"type": "test", "file": path, "name": fragment}, ensure_ascii=False))
        matches = sum(fragment in other for other in by_path[path])
        if matches > 1:
            notes.append(f"{path} 的“{fragment}”同时对应报告里这个文件的 {matches} 个测试；参数化测试这样正常，否则手动换一段更长的")
    notes += [f"报告里的文件 {name} 在仓库里找不到，它的测试没有列出" for name in sorted(unmapped)]
    if skipped:
        notes.append(f"{skipped} 个测试被跳过（skipped），没有列出")
    for note in notes:
        print(f"提醒：{note}", file=sys.stderr)
    return 0


def brief_batch(text, pattern):
    batch, level, fenced = [], None, False
    for line in text.splitlines():
        if re.match(r"^\s*(```|~~~)", line):
            fenced = not fenced
            continue
        if fenced:
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            depth = len(heading.group(1))
            if level is None or depth <= level:
                level = depth if "范围" in heading.group(2) else None
            continue
        bullet = None if level is None else re.match(r"^\s*[-*]\s+`?", line)
        found = bullet and pattern.match(line, bullet.end())
        if found and found.group(0) not in batch:
            batch.append(found.group(0))
    return batch


def check_brief_for_task(task, text):
    data = load_items(task)
    prefix = data.get("prefix")
    if not isinstance(prefix, str) or not prefix:
        raise Fail("items.json 缺少 prefix")
    items = {entry.get("id"): entry for entry in data["items"] if isinstance(entry, dict)}
    pattern = re.compile(rf"(?<![A-Za-z0-9]){re.escape(prefix)}-{ID_BODY}")
    mentioned = sorted(set(pattern.findall(text)))
    batch = brief_batch(text, pattern)
    unknown = [value for value in mentioned if value not in items]
    withdrawn = [value for value in batch if value in items and items[value].get("withdrawn")]
    noted = [value for value in mentioned if value not in batch and value in items and items[value].get("withdrawn")]
    problems = []
    if unknown:
        problems.append(f"简报里的条目 {'、'.join(unknown)} 在 {task.rel}/items.json 里不存在")
    if not batch:
        problems.append(f"简报“范围”一节里没有以条目编号开头的列表行（例如“- `{prefix}-A1` 标题”）；只在别处提到的编号不算本批条目")
    if len(batch) > 3:
        problems.append(f"本批条目有 {len(batch)} 个（{'、'.join(batch)}），最多 3 个；同一次测试顺带验证的条目写在不以编号开头的一行里")
    if withdrawn:
        problems.append(f"本批条目 {'、'.join(withdrawn)} 已决定不做")
    return problems, noted, batch


def cmd_check_brief(args):
    repo = repo_from(args)
    try:
        text = read_text(args.brief)
    except OSError as error:
        raise Fail(f"读不了简报 {args.brief}：{error}")

    def emit(problems, noted, batch):
        for problem in problems:
            print(f"错误：{problem}")
        if noted:
            print(f"警告：简报提到的 {'、'.join(noted)} 已决定不做；它们不在本批条目里，只当说明")
        if problems:
            return 1
        print(f"简报检查通过：本批条目 {'、'.join(batch)}")
        return 0

    if args.task:
        task = resolve_task(repo, args.task)
        problems, noted, batch = check_brief_for_task(task, text)
        return emit(problems, noted, batch)
    active = active_tasks(repo)
    if not active:
        print("没有进行中的长任务，不检查条目：这个简报按不属于长任务的批次处理")
        return 0
    if len(active) == 1:
        task = active[0]
        problems, noted, batch = check_brief_for_task(task, text)
        return emit(problems, noted, batch)
    results = []
    for task in active:
        try:
            problems, noted, batch = check_brief_for_task(task, text)
        except Fail as error:
            results.append((task, [str(error)], [], []))
            continue
        results.append((task, problems, noted, batch))
    passed = [(task, problems, noted, batch) for task, problems, noted, batch in results if not problems]
    if len(passed) == 1:
        task, problems, noted, batch = passed[0]
        print(f"有 {len(active)} 个进行中的任务，按简报里的条目用 {task.name}（要指定就用 --task）")
        return emit(problems, noted, batch)
    print(f"有 {len(active)} 个进行中的任务，简报没有恰好对应其中一个，请用 --task 指定：")
    for task, problems, noted, batch in results:
        if problems:
            print(f"- {task.name}：{'；'.join(problems)}")
        else:
            print(f"- {task.name}：通过")
    return 1


def cmd_init(args):
    repo = repo_from(args)
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", args.task):
        raise Fail("任务名只能用小写字母、数字、点、下划线和连字符，例如 round2")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", args.prefix):
        raise Fail("--prefix 必须是字母开头的字母数字串，例如 R2")
    task = Task(repo, args.task)
    if task.dir.exists():
        raise Fail(f"{task.rel} 已存在")
    moment = now()
    date = args.date or moment.date().isoformat()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise Fail("--date 要写成 YYYY-MM-DD")
    quote = "\n".join(f"> {line}".rstrip() for line in args.goal.strip().splitlines())
    task.dir.mkdir(parents=True)
    task.path("goal.md").write_text(GOAL_TEMPLATE.format(task=args.task, date=date, source=args.source, quote=quote), encoding="utf-8")
    items = {"task": args.task, "prefix": args.prefix, "decisions": {"G1": "once"}, "items": []}
    task.path("items.json").write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    task.path("plan.md").write_text(PLAN_TEMPLATE.format(task=args.task, created=moment.strftime("%Y-%m-%d %H:%M")), encoding="utf-8")
    task.path("evidence.jsonl").write_text("", encoding="utf-8")
    print(f"已建立 {task.rel}/：goal.md、items.json、plan.md、evidence.jsonl")
    print("G1 先记为 once（本任务的目标）；它若是长期规则，改成 durable 并加文档条目")
    for name in FORMATTER_CONFIGS:
        if (repo / name).is_file():
            print(f"提醒：项目有格式化工具配置 {name}，把 {TASKS_DIR}/ 加进它的忽略列表（biome 的 files 设置、prettier 的 .prettierignore、dprint 的 excludes），"
                  "否则项目的格式检查会拦下 items.json；不要改用格式化工具处理任务文件：改写 goal.md 或计划日志的旧行会让“只追加”的检查报错。")
    return 0


def build_parser():
    parser = Parser(prog="longtask.py", description="长任务计划：目标原话、只写打算的计划、从证据算出的状态")
    parser.add_argument("--repo", help="仓库路径，默认当前目录")
    commands = parser.add_subparsers(dest="command_name", required=True, parser_class=Parser)

    init = commands.add_parser("init", help="建立任务目录")
    init.add_argument("task")
    init.add_argument("--prefix", required=True)
    init.add_argument("--goal", required=True, help="用户的原话")
    init.add_argument("--source", default="用户原话")
    init.add_argument("--date")

    fingerprint = commands.add_parser("fingerprint", help="算当前代码内容指纹")
    fingerprint.add_argument("--task")
    fingerprint.add_argument("--include", action="append")
    fingerprint.add_argument("--exclude", action="append")
    output = fingerprint.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true")
    output.add_argument("--list", action="store_true", help="逐行列出参与计算的文件：权限 内容哈希 路径")

    record = commands.add_parser("record", help="追加一条证据")
    record.add_argument("--task")
    source = record.add_mutually_exclusive_group(required=True)
    source.add_argument("--vitest", help="Vitest JSON 报告")
    source.add_argument("--junit", help="JUnit XML 报告")
    source.add_argument("--command", help="命令原文，与 --exit-code 一起用")
    source.add_argument("--review", action="store_true")
    source.add_argument("--retract", help="要撤回的证据编号")
    record.add_argument("--exit-code", type=int)
    record.add_argument("--items", help="审核涉及的条目，逗号分隔")
    record.add_argument("--verdict", choices=("approved", "rejected"))
    record.add_argument("--files", nargs="+")
    record.add_argument("--no-files", action="store_true", help="审核和代码无关时不绑定文件，要配 --note")
    record.add_argument("--commit", help="补录审核时，按这个提交里的文件内容记录")
    record.add_argument("--reason")
    record.add_argument("--fingerprint-file")
    record.add_argument("--host")
    record.add_argument("--by", default=os.environ.get("LONGTASK_BY", "unknown"))
    record.add_argument("--note")
    record.add_argument("--ran", help="产生这份报告的命令")
    record.add_argument("--artifact", action="append")

    status = commands.add_parser("status", help="从证据算出每个条目的状态")
    status.add_argument("--task")
    status_format = status.add_mutually_exclusive_group()
    status_format.add_argument("--json", action="store_true")
    status_format.add_argument("--brief", action="store_true", help="一行汇总，再每项一行：编号、状态、标题，不列原因")
    status.add_argument("--no-save", action="store_true")

    lint = commands.add_parser("lint", help="检查任务文件是否守规则")
    lint.add_argument("--task")

    context = commands.add_parser("context", help="打印钩子会注入的内容")
    context.add_argument("--task")

    commands.add_parser("hook", help="会话开始钩子：从标准输入读 JSON")

    find = commands.add_parser("find-tests", help="从测试报告列出可直接粘贴进 done_when 的测试检查")
    find_source = find.add_mutually_exclusive_group(required=True)
    find_source.add_argument("--vitest", help="Vitest JSON 报告")
    find_source.add_argument("--junit", help="JUnit XML 报告")
    find.add_argument("--commit", help="只列这个提交新增或修改过的测试文件里的测试")
    find.add_argument("--grep", help="只列完整测试名里含这个词的测试，不分大小写")

    brief = commands.add_parser("check-brief", help="检查简报是否写了有效的条目编号")
    brief.add_argument("brief")
    brief.add_argument("--task")
    return parser


COMMANDS = {
    "init": cmd_init,
    "fingerprint": cmd_fingerprint,
    "record": cmd_record,
    "status": cmd_status,
    "lint": cmd_lint,
    "context": cmd_context,
    "hook": cmd_hook,
    "check-brief": cmd_check_brief,
    "find-tests": cmd_find_tests,
}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return COMMANDS[args.command_name](args)
    except Fail as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
