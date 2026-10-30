---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-31"
---

# ADR 0131：仓库不再保存 Andy 的技能副本，云端线程的技能改由 claude.ai 账号提供

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-26 起，仓库在 `.claude/skills/` 下放了 Andy 的 16 个技能（skill，给 Claude 的一套做事说明，入口是 `SKILL.md`）的快照，`.claude/rules/owner-skills.md` 让云端线程在任务对得上时用读文件的方式照做（[ADR 0080](0080-document-governance-in-fast-mode.md) 记了 `document-governance` 这一份）。

2026-10-30 线程“让仓库规则文件被可靠读到”核对后发现：

- 云端项目线程本来就不加载仓库里的技能，只能靠线程自觉去读，读不读没人检查。
- Andy Mac 上的会话优先用 `~/.claude/skills/` 里的原件，仓库快照在 Mac 上用不到。
- 快照是 10-26 的版本（agent-skills 提交 `fa8a4e6`），原件改了以后两边会不一致。

2026-10-30 Andy 决定把云端线程要用的技能手动上传到自己的 claude.ai 账号，并于 2026-10-31 00:40（日本时间）要求删除 `.claude/skills/`。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Claude Code 文档《Let Claude coordinate ongoing work with Projects》（https://code.claude.com/docs/en/claude-projects ，2026-10-30 打开）：“Cloud threads load each repository's `CLAUDE.md` instructions but not its skills”；表格里 `.claude/skills/` 一行写“Not loaded. Enable the skill for your claude.ai account instead”。
- Claude Code 文档《Skills》（https://code.claude.com/docs/en/skills ，2026-10-30 打开）的加载位置表：项目技能“Sessions in this repository, but not cloud threads in a project”；账号技能“Cowork sessions, cloud sessions, and terminal sessions where you sign in with that account”；同名时“personal overrides project”。

官方给云端线程的路子就是账号技能，仓库副本对云端线程和 Mac 会话都不是生效的那一份。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 删除 `.claude/skills/`。
2. `document-governance` 整个目录移到 `tools/document-governance-skill/`，因为 `npm run check:docs`（[scripts/check-docs-governance.mjs](../../scripts/check-docs-governance.mjs)）运行它的 `validate_docs.py`，规则也让线程用它的模板和脚本。`tools/document-governance/` 那份被 `ci/toolchain-lock.json` 按指纹锁住的旧副本不动（同步它仍是 [BL-20261026-002](../backlog/BL-20261026-002-sync-ci-document-governance-validator.md)）。
3. `.claude/rules/owner-skills.md` 改为说明各类会话从哪里拿技能：云端线程用 claude.ai 账号里启用的技能，Mac 会话用 `~/.claude/skills/`；技能工具里没有某个技能时，在计划或回复里说出来，不凭印象猜它的内容。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 云端线程能不能用某个技能，取决于 Andy 有没有把它上传到账号；仓库里读不到副本了。Andy 上传过哪些，以 claude.ai 设置页为准。
- `readable-output` 原件以插件方式带着检查中文回复的钩子；claude.ai 的技能包不接受插件清单文件（2026-10-30 上传报错“A skill cannot contain a plugin manifest”），所以上传的版本只有写作规则，钩子不在云端生效。
- `npm run check:docs` 的行为不变，只是校验程序换了位置；`test/tooling/docs-governance-check.test.mjs` 跟着指向新位置。
- 历史文档（[ADR 0080](0080-document-governance-in-fast-mode.md)、案例库、lessons）里出现的 `.claude/skills/` 是当时的事实，不改。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0080：快速模式下的文档治理](0080-document-governance-in-fast-mode.md)
- [.claude/rules/owner-skills.md](../../.claude/rules/owner-skills.md)
- [.claude/rules/document-governance.md](../../.claude/rules/document-governance.md)
- [案例 73：仓库里的规则和技能，云端线程到底读到了哪些](../engineering-casebook.md#case-cloud-thread-loading)

[↑ 返回阅读导航](#contents)
