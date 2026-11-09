---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0176-ci-on-ovh-vps.md"
date: "2026-11-09"
---

# ADR 0190：草稿 PR 只跑快检查，标题修改不再取消在跑的 CI

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

按 [ADR 0176](0176-ci-on-ovh-vps.md)，PR 的 CI（持续集成，每次推送后自动跑的检查）在 OVH 的 VPS（按月租用的云服务器）上的两个 runner（替 GitHub 执行 CI 任务的程序）里运行，同一时刻最多跑两个作业。多个线程同时开 PR 时，CI 排队可达一个多小时。

草稿 PR（GitHub 上标为 Draft、还不能合并的 PR）和正式 PR 现在跑同一套完整检查。设计文档 [第 9 节](../execution/specs/2026-09-03-github-ci-quality-gates-design.md) 原先写“初期 draft PR 也完整运行”。耗时最长的是 `browser`（浏览器矩阵，最长 90 分钟）和 `coverage`（带覆盖率的全部测试，最长 60 分钟）。

另有一个问题：PR 的 `edited` 事件（改标题、改正文或改目标分支）触发的 CI 和推送触发的 CI 在同一个并发组里，`cancel-in-progress` 为真，所以改一下 PR 标题就会取消正在跑的整轮 CI，然后从头排队再跑。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-09，问：“草稿 PR 用‘跳过作业’的方式只跑快检查，同意改设计文档的原则吗？” 答：“同意，写 adr”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. `ci.yml` 里只有 `browser` 和 `coverage` 两个作业带条件 `github.event_name != 'pull_request' || github.event.pull_request.draft != true`：草稿 PR 上跳过它们，其他事件（main 的 `workflow_call`、手动运行、非草稿 PR）照常运行。`policy`、`static`、`build`、`security` 在草稿上照常运行。
2. 汇总作业 `ci/required` 和汇总脚本不改。`aggregate.mjs` 只接受上游作业的结果为 `success`，被跳过的作业算未完成，所以草稿 PR 上的 `ci/required` 一定是失败的。这是有意的：草稿没有跑完整检查，不能显示为通过；`main-evidence.mjs` 只认结论为成功的 PR 运行，草稿的运行永远不会被当成 main 的证据。
3. PR 从草稿改为正式（`ready_for_review` 事件）时，同一并发组里的草稿运行被取消，完整 CI 重新跑一遍。
4. `edited` 事件的运行在并发组名里加上固定的 `edited` 标记，和推送、开启、转正式触发的运行互不取消；连续几次 `edited` 之间仍按同组处理，后一次会取消前一次，所以连续改标题最多只留一轮。非草稿 PR 上的 `edited` 运行完整检查（因为改目标分支时需要重新核对），草稿 PR 上的 `edited` 和其他草稿运行一样只跑快检查。
5. `scripts/ci/check-policy.mjs` 把这个例外写成硬规则：只有 `browser` 和 `coverage` 两个作业可以带草稿条件，并且必须正好是上面那个条件（汇总作业 `ci/required` 原有的 `always()` 不变）；`policy`、`static`、`build`、`security` 带任何条件、这两个作业条件写错或缺失，策略检查都失败。策略检查只看作业级的 `if`，不检查步骤级的 `if`，这是原有的缺口，本决定不处理。设计文档第 9 节同步改写。

没有使用 `github.event.changes.base`（`edited` 事件里表示目标分支改动的字段）：它的具体形状没有在本机核实，按“拿不准就走完整运行”处理，非草稿 PR 的 `edited` 事件一律完整运行。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **草稿 PR 完全不跑 CI（工作流级条件或 `pull_request` 过滤）**：放弃。设计文档禁止用路径过滤和跳过必需检查的方式交付；草稿上也需要快检查给出早期反馈。
- **让草稿的 `ci/required` 显示成功并在汇总里标“草稿快检查”**：放弃。要改 `aggregate.mjs`、`main-evidence.mjs` 和汇总记录的格式，而且“成功”会被误当成可合并。保持失败更安全，代价见后果。
- **给所有作业加条件**：放弃。策略检查要求必需作业不带条件，只给最慢的两个开例外，改动面最小。
- **用 `changes.base` 只在改目标分支时重跑**：未采纳，原因见上。

[↑ 返回阅读导航](#options)

<a id="consequences"></a>

## 后果

- 草稿 PR 的检查少跑 `browser` 和 `coverage`，每个草稿推送省下最慢的两类作业，缓解两个 runner 的排队。省多少要以草稿落地后的排队时间来观察，不做事先承诺。
- 草稿 PR 上 `ci/required` 显示为失败。看这个检查的人要知道原因是草稿没跑完整检查；Auto-fix（桌面应用里自动修复 CI 失败的功能）本身不区分草稿，仍会把它当作失败事件发给线程；这一点只靠对线程的约定处理（草稿上由此产生的 `ci/required` 失败不用修，只修其他检查），仓库里没有代码或测试保证，也没有改 Auto-fix。
- 线程想在草稿阶段看到完整结果时，把 PR 改成正式即可。
- `edited` 与推送运行不再互相取消，改标题时偶尔会多出一轮完整 CI；连续改标题时后一次取消前一次，最多留一轮，这比打断在跑的 CI 更省。

[↑ 返回阅读导航](#consequences)

<a id="references"></a>

## 关联文档

- [ADR 0176：CI 迁到 OVH VPS](0176-ci-on-ovh-vps.md)
- [ADR 0189：去掉 node-floor 作业，把 test 作业并进 coverage 作业](0189-drop-node-floor-and-fold-test-into-coverage.md)
- [GitHub CI 质量闸门设计](../execution/specs/2026-09-03-github-ci-quality-gates-design.md)

[↑ 返回阅读导航](#references)
