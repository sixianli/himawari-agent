---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0174-no-github-cache-and-one-day-artifacts.md"
date: "2026-11-10"
---

# ADR 0201：汇总通过后删除本次运行的报告产物，控制 Actions 存储

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

2026-11-10，Andy 的监控报警：GitHub Actions 存储（产物加缓存）用了 1.8 GB / 2 GB（90%），12 月 1 日重置。存满后缓存可能写不进去，影响 CI。

实测原因：[ADR 0174](0174-no-github-cache-and-one-day-artifacts.md) 已把保存期设成最短的 1 天，但 GitHub 按“当前仍保留的产物总量”计存储，产物过期后还要过一段时间才从用量里扣掉。排队积压时一天内有几十轮 CI，每轮的 `build` 归档约 65 到 71 MB，`browser`（3 个引擎）、`coverage` 又各把这份归档原样复制进自己的报告，一轮就产生约 5 份拷贝。清理前存量约 7.7 GB，删掉 250 个旧报告产物后降到 1 MB 以下。

为什么不直接让消费者的报告只记归档的 SHA-256（内容指纹）而不复制归档：汇总脚本 `scripts/ci/aggregate.mjs` 的 `readReportEnvelopes` 会对每份报告里的每个文件重新算指纹，并核对消费者报告和 `build` 报告里的归档指纹相同；去掉拷贝就少了“汇总时重新核对每份拷贝”这一步，闸门变弱。所以选了不削弱闸门的做法。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-10，问：存储报警，是删掉现有报告产物并修 CI 让存储不再膨胀吗？答：“1 和 2 都做”。
- 2026-11-10，问：去掉消费者报告里的归档拷贝会削弱闸门，改成汇总通过后删掉本次运行的报告产物，是否采用？答：“按照你的建议来”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. `ci/required`（汇总作业）在核对通过、并且已经上传 `gate-` 汇总结论之后，新增一个步骤，只在前面所有步骤都成功时（`if: success()`）删除本次运行本次尝试的全部 `report-<运行号>-<尝试号>-*` 产物。脚本是 `scripts/ci/delete-run-reports.mjs`，通过 GitHub REST 接口列出并删除，已经被删掉的（404）不算失败，其他失败让步骤失败。
2. 只删前缀完全匹配 `report-<本次运行号>-<本次尝试号>-` 的产物：不碰 `gate-`（汇总结论，`main-evidence.mjs` 要用）、`diagnostic-`（失败诊断，保留 1 天供排查）、别的运行和别的尝试的产物。汇总失败时不执行，失败运行的报告留 1 天供排查。
3. 汇总作业的权限从“只读”放宽为 `contents: read`、`actions: write`、`pull-requests: read`；删除产物只需要 `actions: write`。其他作业仍然只读。`scripts/ci/check-policy.mjs` 把这写成硬规则：只有 `required` 作业可以带 `actions: write`，其他作业带任何写权限、`required` 带 `contents` 等其他写权限都被拒绝；`test/tooling/policy.test.mjs` 有正反用例，`test/tooling/ci-optimization.test.mjs` 检查删除步骤在核对步骤之后且带 `success()`。
4. `quality.yml` 同样下载 `report-<ci 运行号>-*`，但它按 [ADR 0176](0176-ci-on-ovh-vps.md) 之后的决定目前停用；重新启用时要在本决定的基础上重新评估。

[↑ 返回阅读导航](#decision)

<a id="options"></a>

## 比较过的方案

- **消费者报告只记归档指纹，不复制归档**：放弃。会削弱汇总对每份拷贝的重新核对（见背景），要改 `aggregate.mjs` 的核对逻辑。
- **只靠 1 天保存期**：放弃。已经是 1 天，仍然膨胀。
- **每轮 CI 结束后用定时任务清理**：放弃。多一个要维护的外部任务，而且清理时机和汇总是否通过脱节。
- **把整个仓库升级付费存储**：放弃。Andy 要求 0 美元预算（报警里写明）。

[↑ 返回阅读导航](#options)

<a id="consequences"></a>

## 后果

- 每轮通过的 CI 结束后，约 5 份归档拷贝（约 300 MB）立刻释放，存储不再随排队轮数线性增长。失败的运行仍保留报告 1 天，最坏情况下和以前一样。
- 通过的运行不能再单独重跑 `ci/required`（报告已不在）；要重跑须重跑整轮。这个代价接受：汇总结论已保存在 `gate-` 产物里，`main-evidence.mjs` 不受影响。
- `ci/required` 因为多了写权限，成为唯一可以删产物的作业；删除范围由脚本里的前缀匹配和测试限定。
- 这一步发生在 GitHub 上，本地测试只覆盖脚本和策略检查，真实删除要在合并后第一轮 `main` 的 CI 里观察：看该运行结束后 `report-` 产物是否被删除、`gate-` 是否还在。

[↑ 返回阅读导航](#consequences)

<a id="references"></a>

## 关联文档

- [ADR 0174：CI 不用 GitHub 缓存，artifact 只保存 1 天](0174-no-github-cache-and-one-day-artifacts.md)
- [ADR 0176：CI 迁到 OVH VPS](0176-ci-on-ovh-vps.md)
- [GitHub CI 质量闸门设计](../execution/specs/2026-09-03-github-ci-quality-gates-design.md)

[↑ 返回阅读导航](#references)
