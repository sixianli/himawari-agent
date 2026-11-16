---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0160-self-hosted-runner-on-hermes.md"
amended_by: "docs/adr/0176-ci-on-ovh-vps.md"
date: "2026-11-05"
---

# ADR 0168：放宽 Hermes 上 CI 任务的整体时限

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与 ADR 0160 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

CI（每次推送后 GitHub Actions 自动跑的检查）从 2026-11-04 起在 Hermes（家里的 Linux 服务器）上的自托管 runner（替 GitHub 执行 CI 任务的程序）里运行，见 [ADR 0160](0160-self-hosted-runner-on-hermes.md)。每个任务有一个整体时限（workflow 里的 `timeout-minutes`，到点 GitHub 直接取消任务），同一个数也写在 `ci/policy.json` 的 `timeoutMinutes` 里，`scripts/ci/run.mjs` 按它计算检查内部的剩余时间。

2026-11-05 在 Hermes 上看到的情况（GitHub 接口记录）：

- 运行 41956662276：`test / linux-x64` 跑了约 46 分钟、`node-floor` 约 46 分钟、`coverage` 约 31 分钟后被取消，正好是当时的 45、45、30 分钟时限；`test` 的“执行共享检查”这一步 40 分钟里没有输出。
- 同一次运行里，“缓存 npm 下载”这一步在 Hermes 上要 3 分钟左右，在 GitHub 托管机器上只要几秒；下载构建归档有一次用了约 8 分钟。
- 运行 41846079755：`ci/required` 汇总任务用了约 4 分 50 秒，离 5 分钟时限只差 10 秒。

每个 runner 最多用 2 核，两个合计最多 3 核（[ADR 0171](0171-two-runners-on-hermes.md)）；GitHub 托管的 `ubuntu-24.04` 是 4 核。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-05，问题是“任务跑到上限就被取消，ADR 0160 规定‘不放宽任何测试时限’，改不改？”回答：

  > 那就改啊！Hermes 上本来就跑得慢，不放宽时限，永远就跑不了

- 同一天，问题是“有几条测试 5 秒就超时，和上一条是同一个决定”。回答：

  > 一样的，放开时间限制

- 同一天，接着说：

  > 时间放宽，然后去查清 Hermes 为什么这么慢

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 任务整体时限改为：`build`、`test`、`node-floor`、`browser` 90 分钟（原 45）；`policy`、`static`、`coverage`、`security` 60 分钟（原 30）；`ci/required` 15 分钟（原 5）。main 推送后的确认运行：`plan` 15 分钟（原 5），`confirm` 90 分钟（原 45）。
2. `ci/policy.schema.json` 里 `timeoutMinutes` 的上限从 60 提到 120，给以后留一次调整的余地。
3. 只改任务整体时限。Andy 也说了放开单条测试的时限（Vitest 默认 5 秒，`integration` 项目 30 秒），但这条暂缓：[BL-20261001-002](../backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md) 记录过，2026-10 在不限 CPU 的 Hermes 上用默认时限跑通了第 3 层 5133/5133；[测试主机操作手册](../runbooks/test-host-operations-runbook.md) 写明“超时是要诊断修复的缺陷，不是环境问题”。Claude 已把这两条交给 Andy，他看过后再定，定了再在这里记录。
4. 放宽之后要查清 Hermes 为什么慢，查到的原因按“修 bug 先查根因”处理；查清后如果整体时限可以收回，再改回来并在这里记录。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0160 的关系

本 ADR 改动 ADR 0160 决定第 8 条里的“不放宽任何测试时限”：任务整体时限按上面第 1 条放宽；单条测试的时限暂不改，见第 3 条。ADR 0160 的其他决定不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **放宽任务整体时限（选中）**：改动小；Hermes 慢的原因查清之前，CI 至少能跑完、给出结果。
- **不放宽，先查清慢的原因**：查原因要在 Hermes 上做，期间 `test`、`coverage`、`node-floor` 每次都被取消，`ci/required` 不可能通过。Andy 选择先放宽。
- **把大任务拆小**：要改检查的划分和 `ci/required` 的汇总逻辑，改动大，原因不清时拆了也可能仍然超时。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：任务不再因为跑到 45 分钟被取消，可以看到它们实际要多久、实际在哪里失败。
- 代价：卡死的任务要等更久才被取消，占住 runner 的时间更长，排队更久。
- 改动本身的 PR 上，`policy` 检查会失败：检查用 main 上的 `ci/policy.json`、按 PR 里的新代码核对（`scripts/ci/check-policy.mjs` 的 `resolvePolicySource`），而 main 上还是旧时限。合并后 main 上的第一次运行也会这样失败：推送到 main 时，比较用的基线是推送前的 main（`scripts/ci/context.mjs` 里 `push` 事件取 `payload.before`）。之后的 PR 和下一次推送到 main 才会用上新时限，在那时验证。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0160：CI 改在 Hermes 上的自托管 runner 运行](0160-self-hosted-runner-on-hermes.md)
- [ADR 0171：Hermes 上跑两个常驻 runner](0171-two-runners-on-hermes.md)
- [Hermes 自托管 runner 操作手册（已归档）](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md)

[↑ 返回阅读导航](#contents)
