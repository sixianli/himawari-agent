---
status: superseded
document_type: adr
decision_status: superseded
supersedes: docs/adr/0073-fast-delivery-mode.md
superseded_by: docs/adr/0132-docs-check-removed-from-npm-run-check.md
date: "2026-10-26"
---

# ADR 0080：快速模式下保留文档严格校验，只延后 Runbook 重新封存

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0073](0073-fast-delivery-mode.md) 定下了 `DELIVERY_MODE` 开关（仓库根目录的一个文件，`fast` 表示快速模式）。快速模式暂停了提交前的文档严格校验和 Runbook（运维手册，写清楚怎么上线、回滚、排查的文档）重新封存，`document-governance`（Andy 自己写的文档治理 skill，规定 PRD、架构文档、ADR、Spec、Plan、Runbook、Backlog 等文档怎么建、怎么改、怎么校验）也不再因为文档落后而触发。

2026-10-26 Andy 要求之后的云端线程真正用上这个 skill。线程里查到的情况：

- 这个 skill 已经复制在仓库的 `.claude/skills/document-governance/`，和 Andy Mac 上 `agent-skills` 仓库提交 `fa8a4e6` 的文件一致；`AGENTS.md` 也写明本项目采用它。但 claude.ai 项目里的云端线程不加载 `.claude/skills/`，只读仓库根目录的 `CLAUDE.md`、`.claude/CLAUDE.md` 和 `.claude/rules/`（[官方说明](https://code.claude.com/docs/en/claude-projects#what-threads-pick-up-from-your-repositories)：“Skills under `.claude/skills/` | Not loaded”）。
- 2026-10-25 以来 `main` 上 88 个提交里有 27 个写了 `Docs: deferred (fast mode)`。
- 严格校验（`validate_docs.py . --strict`）现在有 7 个错误，全部在 Runbook 上：6 个 Runbook 的 `contract_sha256`（Runbook 依据的代码和配置文件算出的摘要，用来发现手册是否落后于代码）与当前代码对不上，1 个 Runbook 依据的 `packages/memory-mem0/src/index.ts` 已随去掉 Mem0 删除。其他类型的文档没有错误。
- 一次严格校验约 1 秒（云端容器实测 0.997 秒）。

Andy 在线程的选择卡片上选了“轻量版：校验+硬门槛”（2026-10-26T09:06Z），即下面的决定；另外两个选项是“只加规则，不加门槛”和“快速模式下完全恢复”。

<a id="decision"></a>

## 决定

ADR 0073 的决定 1、2、4、5、6 不变，照原文继续有效（生产机访问以 [ADR 0074](0074-claude-runs-production-deployments.md) 为准）。只改决定 3 里文档的部分，并加一条：

1. **快速模式下照样做文档严格校验**：`npm run check` 新增一步 `npm run check:docs`（`scripts/check-docs-governance.mjs`），运行 skill 的 `validate_docs.py --strict`。快速模式下只放行 Runbook 封存落后的两类错误：`contract_sha256 does not match` 和 `contract path does not exist`；其余错误（ADR 字段、取代关系、Backlog 字段、SOURCE 链接等）都让检查失败。完整模式下所有错误都失败。
2. **Runbook 重新封存继续延后**：快速模式下改了 Runbook 依据的代码不要求同次复核和重新封存，提交说明写 `Docs: deferred (fast mode)` 并点名 Runbook；切回完整模式时，或线程要照某个 Runbook 操作前，再复核封存。
3. **skill 在两种模式下都用**：新的决定写 ADR、要保留的后续工作记 Backlog、Andy 要求记下的想法记 Idea、改动让现有文档说错的同次改正。规则写在 `.claude/rules/document-governance.md`，云端线程每次启动都会读到。
4. ADR 0073 决定 3 里其余被暂停的规则（第 2、3、4 层测试和浏览器检查、`Layer-0-tests:` 逐行声明、合并前等 CI、生产操作包的读回冻结演练和逐次授权）照旧暂停。

<a id="options"></a>

## 比较过的方案

- **只加规则文件，不加检查**：成本最低，但规则只靠线程自觉；快速模式下 27 个提交留了文档欠账，说明光靠文字不够。不采用。
- **快速模式下完全恢复 `AGENTS.md` 的文档一致性规则**：每次改到 Runbook 依据的代码都要对照代码复核并重新封存，现有 6 个 Runbook 的依据覆盖大部分产品目录，几乎每个提交都会被拖慢，违背快速模式的初衷。不采用。
- **把 skill 上传成 Andy 的 claude.ai 账号级 skill**：云端线程会自动加载，其他项目也能用；但只能由 Andy 在 claude.ai 设置里上传，skill 更新后要重新上传，而且仍然受快速模式暂停规则的约束，本身解决不了“快速模式下不用”的问题。作为可选补充，不作为本决定的一部分。
- **基线文件放行现有 7 个错误**：现有错误全是 Runbook 封存落后，和快速模式要延后的那一类相同，按错误类型放行就不需要另外维护一份基线清单。不采用。

<a id="consequences"></a>

## 后果

- 每次 `npm run check` 多约 1 秒；运行检查的机器要有 Python 3.10 或更高版本（Hermes 的 Ubuntu 22.04 自带 3.10，云服务器的 Ubuntu 24.04 自带 3.12）。
- 快速模式下 ADR、Backlog、Idea 和 SOURCE 链接的结构错误不会再积累；Runbook 内容仍可能落后于代码，切回完整模式时一次补齐。现有 7 个 Runbook 错误记成 Backlog，单独处理。
- CI 的 `static` 任务仍用 `tools/document-governance/` 里 2026-09-03 固定的旧版校验器，并且对所有错误都失败；快速模式下合并不等 CI，这一差别不影响合并。两份校验器的同步记成 Backlog。

<a id="references"></a>

## 关联文档

- [ADR 0073：用 `DELIVERY_MODE` 开关切换快速交付和完整流程](0073-fast-delivery-mode.md)（被本 ADR 取代）
- [ADR 0074：快速模式下由 Claude 直接执行生产上线、回滚和诊断](0074-claude-runs-production-deployments.md)
- [快速模式规则](../../.agents/instructions/delivery-mode.md)、[文档治理规则](../../.claude/rules/document-governance.md)
- [工程案例库案例 13：快速交付模式](../engineering-casebook.md#case-fast-mode)

[↑ 返回阅读导航](#contents)
