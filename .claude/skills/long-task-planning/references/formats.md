# File formats

Back to [SKILL.md](../SKILL.md). All files live in `<repo>/.agents/tasks/<task>/` and are UTF-8.

- [goal.md](#goalmd)
- [items.json](#itemsjson)
- [plan.md](#planmd)
- [evidence.jsonl](#evidencejsonl)
- [Fingerprint](#fingerprint)
- [status --json](#status---json)

## goal.md

```markdown
# 目标：round2

## G1 2026-09-28 转述：.ci-output/handoff/2026-09-28-codex-round2-brief.md

> 尽量把工具执行相关的缺陷全部找出来

## G2 2026-09-29 用户原话

> 把一经发现的bug修掉然后再收尾吧

## G3 2026-10-01 用户选择

问题：D12 要不要算进第二轮？

> 算进去 (Recommended)
> 和其他缺陷一起修。

## CLOSED 2026-10-20 用户原话

> 验收通过
```

- Headings match `## G<number> <YYYY-MM-DD> <source>` or `## CLOSED <YYYY-MM-DD> <source>`. Source is `用户原话` (typed by the user), `用户选择` (an option picked in a multiple-choice question) or `转述：<where from>`.
- The quote lines start with `> `. For `用户选择`, quote the chosen option's label and description exactly as shown.
- An optional `问题：<question>` line above the quote holds the question the user answered. Use it for every `用户选择` entry and for any short answer that is unclear on its own. `context` prints such an entry as `问：<question> 答：<answer>` when there is room; to stay within its length limit it drops all question lines before it shows fewer goals.
- IDs are unique and show the order entries were recorded, not when things were said: a decision found later gets the next free number with its own date. `context` shows G1 first, then the rest by date; entries of the same day keep their recorded order.
- `CLOSED` is last and makes the task inactive.
- Append only: every committed version and the working copy must start with the previous version's lines.

## items.json

```json
{
  "task": "round2",
  "prefix": "R2",
  "decisions": {"G1": "once", "G2": "once", "G3": "once"},
  "decision_docs": ["docs/adr/"],
  "fingerprint": {"test_exclude": ["docs/", "AGENTS.md"]},
  "items": [
    {
      "id": "R2-D1",
      "title": "Job Host 期限分类",
      "goal_ref": ["G2"],
      "done_when": [
        {"type": "test", "tag": "R2-D1", "host": "test-server"},
        {"type": "review", "by": "claude"}
      ],
      "added": {"by": "claude", "on": "2026-10-02", "why": "第二轮缺陷清单 D1"}
    },
    {
      "id": "R2-L4",
      "title": "生产部署",
      "goal_ref": ["G3"],
      "done_when": [{"type": "user", "ref": null, "question": "什么时候部署到生产？"}],
      "added": {"by": "claude", "on": "2026-10-02"},
      "withdrawn": {"on": "2026-10-05", "ref": "G7"}
    }
  ]
}
```

- `prefix`: letters and digits, starting with a letter. Every `id` starts with `<prefix>-`.
- `decisions`: optional object; each key is a `goal.md` entry other than `CLOSED` and each value is `"once"` or `"durable"`. `once` covers a one-off approval, an answer to one question, or a requirement that only affects this task. `durable` covers a decision or rule that keeps steering the project. A `durable` entry needs an active item whose `goal_ref` contains it and whose `done_when` has a `doc` check under `decision_docs` with `quotes` naming that entry. When the key is present, `lint` reports every unclassified entry. `init` writes `"decisions": {"G1": "once"}`.
- `decision_docs`: optional list of decision document path prefixes, default `["docs/adr/"]`. Use another location when the project does not use `document-governance`, for example `["AGENTS.md"]`.
- `fingerprint.exclude`: path prefixes left out of the fingerprint for every check. Add one only after checking that no test, command or review depends on those paths.
- `fingerprint.include`: path prefixes; when set, only files under them enter the fingerprint, minus `exclude`. For a repository holding several independent projects; see [Several projects in one repository](../SKILL.md#several-projects-in-one-repository). `lint` refuses an entry that matches no file.
- `fingerprint.test_exclude`: path prefixes that only test checks ignore, for documents no test reads. See [Documentation-only changes](../SKILL.md#documentation-only-changes). It does not change the fingerprint.
- Check fields: `test` needs `tag`, or both `file` and `name` (`name` appears verbatim in the file and in the reported names, with no placeholder such as `%s`); `doc` needs `path`, optional `heading`, and optional `quotes` (a G id or a list of G ids whose words must appear verbatim in the document, ignoring whitespace and line breaks); `review` optional `by`; `user` needs `ref` (null until decided) and `question`; `command` needs `run`, and with `"scope": "environment"` also `host` and `max_age_days` (a positive whole number of days). `test` and `command` accept `host`. `command` also accepts `ignore_test_exclude` (a boolean, `false` when omitted): `true` lets a record kept current by `test_exclude` satisfy the check, for a command that only reads code and tests. It cannot be combined with `"scope": "environment"`.
- `done_when` needs at least one check, except on an item with `withdrawn`: an item dropped from the start may leave `done_when` out or empty.
- `lint` compares with the version in `HEAD`: a removed item, or a changed `done_when` / `withdrawn` without a new `计划改动记录` line naming the item, is an error. A `durable` entry changed to `once` or removed needs a new line naming that entry. A removed `decisions` key needs a new line containing `decisions`.

## plan.md

```markdown
# 计划：round2

## 当前批次

- R2-D2：先写红测试复现 ACK 丢失，再修；证据：云服务器上 [R2-D2] 全过 + Claude 审核
- R2-E1：……
- 顺带验证（不占名额）：R2-D11、R2-D14 由本批的完整测试提供证据

## 之后

- R2-D13
- R2-B4

## 计划改动记录

- 2026-10-02 10:00 建立任务。
- 2026-10-02 11:30 当前批次改为 R2-D2、R2-E1。原因：status 显示 未完成 12、无法判断 0。

## 意外和发现

- 2026-10-02 D17：夹具套接字路径超过 107 字节。

## 决定

- 2026-10-02 D18 不在本批修，见 BL-20261002-002。
```

- The five `##` sections are required. In `当前批次`, `lint` counts only bullets that start with an item ID, and allows at most three. Items that the batch's test run only verifies, without work of their own, go on a bullet that does not start with an ID; they do not count, but every ID in the section must exist in `items.json`.
- No checkboxes or progress words outside the last three sections. `lint` refuses 已完成, 已修复, 已修好, 已修, 已通过, 已验证, 已解决, 已提交, 已合并, 已推送, 已审核, 已做完, 做完了, 待验证, 待审核, 进行中, 未开始, 完成了, ✅, ☑, ✔ and `[ ]` / `[x]`. The rule behind the list: a plan line says what to do and what evidence is needed, not how far it has got. Words the list misses still break that rule. HTML comments are ignored.
- The last three sections are append only, checked against git history.

## evidence.jsonl

One JSON object per line, appended under a file lock. `lint` compares each committed version with the next one and with the working tree: every earlier line must still be there, unchanged and in the same order; lines inserted between them are accepted, because another agent may have committed only its own lines. `status` reads records in `time` order, keeping file order for equal times, so where a line sits never changes which record is the latest. `lint` reports a record whose `time` cannot be read; `status` treats it as older than every other record. Common fields:

| Field | Meaning |
| --- | --- |
| `id` | `E<YYYYMMDD>T<HHMMSS>-<6 hex>` |
| `time`, `by`, `host` | When, which agent, which machine |
| `kind` | `test`, `command`, `review` or `retract` |
| `fingerprint`, `commit`, `dirty` | The code it applies to; `dirty` means uncommitted changes existed. `fingerprint` is `unknown` for results recorded without one; each such record is judged on its own |
| `code_fingerprint`, `test_exclude` | Present on local test and command records when `fingerprint.test_exclude` was non-empty: the digest of the fingerprint entries outside those paths, and the sorted list. Together they keep the record current after a documentation-only change when the tested state never became a commit. Missing in older records and in records made with `--fingerprint-file` |
| `scope` | `{include, exclude}`: the paths the fingerprint was computed with. Missing in older records and in records from a hand-written fingerprint file |
| `note` | Optional free text |

Kind-specific fields:

- `test`: `source` (`vitest-json` or `junit-xml`), `counts` `{passed, failed, skipped}`, `tags` `{TAG: {passed, failed, files}}` (skipped tests excluded), `selected` (results for `file`+`name` checks), `failures` (first 20 names), `artifacts` `[{path, sha256}]`, optional `ran`, `ran_at` (when the tests ran, from the report) and `unresolved_files`.
- `command`: `command`, `exit_code`, optional `artifacts`.
- `review`: `items`, `verdict`, `files` `{path: git blob hash at review time}`, optional `reviewed_commit` (recorded with `--commit`; the hashes then come from that commit). `files` is `{}` for a `--no-files` review; its `note` says what was reviewed.
- `retract`: `target` (an evidence id), `reason`. The target stops counting; the failure or pass it recorded is ignored.

## Fingerprint

1. Start from the index (`git ls-files -s`), skipping the task directory, `fingerprint.exclude` prefixes, every path outside `fingerprint.include` when it is set, and `.DS_Store`, `Thumbs.db`, `._*`.
2. Re-hash files that differ from the index (`git diff-files`) and untracked files git does not ignore; drop deleted files. Modes are `120000` (symlink), `100755` (executable) or `100644`.
3. Sort lines `<mode> <blob> <path>` by path, join with `\n`, SHA-256. `fingerprint --list` prints these lines.
4. `dirty` is true when the same computation over `HEAD`'s tree gives a different value.

Same content gives the same fingerprint on any machine and whether or not it is committed.

A fingerprint file (`record --fingerprint-file`) is the output of `fingerprint --json` on the host that ran the tests. `record` needs `fingerprint`, `commit` and `dirty`; `host` is optional and defaults to `--host` or this machine. `includes` and `excludes` from `fingerprint --json` become the record's `scope`; `time` and `task` are informational. For old reports whose code version is unknown, write one by hand:

```json
{"fingerprint": "unknown", "commit": "<commit they probably ran on>", "dirty": false, "host": "cloud"}
```

## status --json

```json
{
  "task": "round2", "dir": ".agents/tasks/round2",
  "fingerprint": "…", "commit": "…", "dirty": false,
  "counts": {"verified": 3, "older": 5, "not_done": 12, "unknown": 1, "waiting": 0, "withdrawn": 1},
  "items": [{"id": "R2-D4", "title": "…", "status": "unknown", "reasons": ["…"], "changed_files": [], "checks": [{"type": "test", "status": "unknown", "reason": "…", "changed_files": []}]}],
  "changes_since_last": [{"id": "R2-D1", "from": "verified", "to": "older"}],
  "include": [],
  "warnings": []
}
```

- `counts` covers every item in `items.json`, withdrawn ones included; the summary line's total (`共 N 项`) is their sum, so it always equals the number of items.
- `reasons`: for an unfinished item, one line per check not yet verified on the current code, worst first; for a verified item, its checks.
- `changed_files` of an item: files changed since the older evidence of any check that is not verified.
- `include`: `fingerprint.include` from `items.json`, empty when not set. `warnings` lists goal and evidence problems and `include` entries that match no file.
- `changed_files` of a check: the files behind its status. For a test or `ignore_test_exclude` command check verified under `test_exclude`, the files changed since the tested commit, all under `test_exclude`.
