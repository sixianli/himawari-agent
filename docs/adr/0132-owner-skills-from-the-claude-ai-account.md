---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-31"
covers: "ci/toolchain-lock.json, scripts/ci/run.mjs, scripts/machine-secret-scan-baseline.json"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0132：仓库不再保存 Andy 的技能副本，云端线程的技能改由 claude.ai 账号提供

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-26 起，仓库在 [.claude/skills/](https://github.com/sixianli/himawari-agent/tree/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills) 下放了 Andy 的 16 个技能（skill，给 Claude 的一套做事说明，入口是 `SKILL.md`）的快照，.claude/rules/owner-skills.md 让云端线程在任务对得上时用读文件的方式照做（[ADR 0080](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0080-document-governance-in-fast-mode.md) 记了 `document-governance` 这一份）。

2026-10-30 线程“让仓库规则文件被可靠读到”核对后发现：

- 云端项目线程本来就不加载仓库里的技能，只能靠线程自觉去读，读不读没人检查。
- Andy Mac 上的会话优先用 `~/.claude/skills/` 里的原件，仓库快照在 Mac 上用不到。
- 快照是 10-26 的版本（agent-skills 提交 `fa8a4e6`），原件改了以后两边会不一致。

2026-10-30 Andy 决定把云端线程要用的技能手动上传到自己的 claude.ai 账号，并于 2026-10-31 00:40（日本时间）要求删除 [.claude/skills/](https://github.com/sixianli/himawari-agent/tree/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills)。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Claude Code 文档《Let Claude coordinate ongoing work with Projects》（https://code.claude.com/docs/en/claude-projects ，2026-10-30 打开）：“Cloud threads load each repository's `CLAUDE.md` instructions but not its skills”；表格里 [.claude/skills/](https://github.com/sixianli/himawari-agent/tree/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills) 一行写“Not loaded. Enable the skill for your claude.ai account instead”。
- Claude Code 文档《Skills》（https://code.claude.com/docs/en/skills ，2026-10-30 打开）的加载位置表：项目技能“Sessions in this repository, but not cloud threads in a project”；账号技能“Cowork sessions, cloud sessions, and terminal sessions where you sign in with that account”；同名时“personal overrides project”。

官方给云端线程的路子就是账号技能，仓库副本对云端线程和 Mac 会话都不是生效的那一份。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 删除 [.claude/skills/](https://github.com/sixianli/himawari-agent/tree/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills)。
2. `document-governance` 也不留副本（Andy 2026-10-31 00:50 JST：“这个技能删掉啊”）。线程通过技能工具使用账号里的这份（Andy 2026-10-26 已上传）。给已停用的 CI 用的旧副本 `tools/document-governance/` 也删掉（Andy 2026-10-31 01:27 JST：“删掉”），连同 [scripts/ci/sync-governance.mjs](https://github.com/sixianli/himawari-agent/blob/1ee9b79d18cd4de856b952970c911c40edaa1fa1/test/qualification/evidence/ci-finder-ds-store-2026-09-27/governance-before.log)、`ci/toolchain-lock.json` 的 `governance` 一节、`scripts/ci/run.mjs` 里 CI `policy` 和 `static` 两步的治理检查及其测试；[BL-20261026-002](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-002-sync-ci-document-governance-validator.md) 随之不再需要。以后若重新打开 GitHub Actions，CI 也不再校验文档。
3. .claude/rules/owner-skills.md 改为说明各类会话从哪里拿技能：云端线程用 claude.ai 账号里启用的技能，Mac 会话用 `~/.claude/skills/`；技能工具里没有某个技能时，在计划或回复里说出来，不凭印象猜它的内容。
4. 同时删除 [.agents/tasks/](https://github.com/sixianli/himawari-agent/tree/bd0859a9084bd32bb7e00c4e6fcecd0c6a3e7874/.agents/tasks)（`long-task-planning` 技能完整模式留下的 12 个任务记录，最早 2026-10-28 进仓库；Andy 2026-10-31 00:55 JST：“全部删掉”），连同 `scripts/machine-secret-scan-baseline.json` 里指向它的 2 条豁免和 `biome.json` 里的排除项。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 云端线程能不能用某个技能，取决于 Andy 有没有把它上传到账号；仓库里读不到副本了。Andy 上传过哪些，以 claude.ai 设置页为准。
- `readable-output` 原件以插件方式带着检查中文回复的钩子；claude.ai 的技能包不接受插件清单文件（2026-10-30 上传报错“A skill cannot contain a plugin manifest”），所以上传的版本只有写作规则，钩子不在云端生效。
- 仓库里不再有能跑的文档校验程序，npm run check:docs、[scripts/check-docs-governance.mjs](https://github.com/sixianli/himawari-agent/blob/f06f1460b45a2b5f5506dc90579e440f4ff7a833/scripts/check-docs-governance.mjs) 和它的测试一起删除（[ADR 0133](0133-docs-check-removed-from-npm-run-check.md)）。要校验文档只能通过技能工具加载 `document-governance` 后手动跑。
- 历史文档（[ADR 0080](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0080-document-governance-in-fast-mode.md)、案例库、lessons）里出现的 [.claude/skills/](https://github.com/sixianli/himawari-agent/tree/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills) 是当时的事实，不改。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0080：快速模式下的文档治理](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0080-document-governance-in-fast-mode.md)
- 规则文件（.claude/rules/owner-skills.md，现已不在仓库里）
- 规则文件（.claude/rules/document-governance.md，现已不在仓库里）
- [案例 74：仓库里的规则和技能，云端线程到底读到了哪些](../engineering-casebook.md#case-cloud-thread-loading)

[↑ 返回阅读导航](#contents)
