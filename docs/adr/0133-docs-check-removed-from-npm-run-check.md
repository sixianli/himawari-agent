---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-31"
amended_by: "docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md"
---

# ADR 0133：删除仓库里的文档自动校验，改为用技能手动运行

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0080](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0080-document-governance-in-fast-mode.md)（2026-10-26）定下：快速模式（`DELIVERY_MODE` 为 `fast`，只跑相关测试、`npm run check` 和 `npm run build`）也保留文档严格校验，`npm run check` 每次都跑 `npm run check:docs`（`scripts/check-docs-governance.mjs`，现已不在仓库里；约 1 秒），只放过操作手册（Runbook）封存过期两类问题。它也是事故 I-06（提交 `51fe7f6` 改代码没重新封存操作手册，之后严格校验一直失败）的自动门槛。

2026-10-31 00:42（日本时间），在删除 `.claude/skills/`（[ADR 0132](0132-owner-skills-from-the-claude-ai-account.md)）的同一线程里，Andy 要求删掉 `npm run check` 里的这一步。线程用选择卡说明了代价：按 [ADR 0107](0107-every-incident-gets-an-automatic-gate.md)，拆掉门槛后 I-06 要改回“缺门槛”。Andy 选了“删掉，I-06 改回缺门槛”。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Google 文档风格指南《Documentation Best Practices》（https://google.github.io/styleguide/docguide/best_practices.html ，2026-10-30 打开）：“Change your documentation in the same CL as the code change.”“A good reviewer can at least insist that docstrings, header files, README.md files, and any other docs” get updated alongside the CL。它要求文档随代码一起改，靠的是评审，不是强制的自动检查。

这次决定和这条做法不冲突：文档仍要随代码一起改（[AGENTS.md](../../AGENTS.md) 的 Code and Documentation Consistency 一节不变），只是不再由 `npm run check` 自动拦。没有为这次决定另做调研；这是 Andy 在知道代价后的取舍。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. `npm run check` 不再运行 `npm run check:docs`。
2. 随后 Andy 要求连仓库里的 `document-governance` 副本也删掉（[ADR 0132](0132-owner-skills-from-the-claude-ai-account.md)），所以 `npm run check:docs`、`scripts/check-docs-governance.mjs` 和 `test/tooling/docs-governance-check.test.mjs` 一起删除。需要时通过技能工具加载 `document-governance`，手动跑它的 `validate_docs.py . --strict`。
3. 事故 I-06 在 [docs/incidents-and-gates.md](../incidents-and-gates.md) 里改回“缺门槛”。
4. ADR 0080 其余内容（快速模式下延后操作手册重新封存、`Docs: deferred (fast mode)` 提交说明）照旧，由本 ADR 继承。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每次提交少跑约 1 秒；文档校验出错不再挡提交。
- 文档和代码重新可能悄悄脱节，就像 I-06 那次；只有手动跑技能的校验或切回完整模式时才会发现。
- 规则文件（`.claude/rules/document-governance.md`，现已不在仓库里）、[.agents/instructions/delivery-mode.md](../../.agents/instructions/delivery-mode.md) 和 [AGENTS.md](../../AGENTS.md) 已改成“手动运行”。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0080：快速模式下保留文档严格校验](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0080-document-governance-in-fast-mode.md)（被本 ADR 取代）
- [ADR 0107：每个事故都要有自动门槛](0107-every-incident-gets-an-automatic-gate.md)
- [ADR 0132：仓库不再保存 Andy 的技能副本](0132-owner-skills-from-the-claude-ai-account.md)
- [案例 74：仓库里的规则和技能，云端线程到底读到了哪些](../engineering-casebook.md#case-cloud-thread-loading)

[↑ 返回阅读导航](#contents)
