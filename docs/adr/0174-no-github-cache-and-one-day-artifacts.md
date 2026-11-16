---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-06"
---

# ADR 0174：CI 不用 GitHub 缓存，artifact 只保存 1 天

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

CI（持续集成，每次推送后 GitHub Actions 自动跑的检查）原来有两样东西存在 GitHub 上：

- 缓存：`actions/cache`（GitHub 提供的缓存步骤）把下载好的固定工具和 npm 包存到 GitHub，下次任务直接取回，不用重新下载。
- artifact（每次 CI 跑完上传到 GitHub 的报告和诊断文件）：报告保存 30 天，失败诊断保存 7 天，写在 `ci/policy.json`、`ci/quality-policy.json` 和 [GitHub CI 与质量门禁设计](../execution/specs/2026-09-03-github-ci-quality-gates-design.md) 里。

仓库是私有仓库。按 [GitHub Actions 计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)，私有仓库的 artifact 按每小时实际占用的空间计费，Free 套餐含 500 MB、Pro 套餐含 1 GB，超出部分收费；缓存另有每个仓库 10 GB 的额度。2026-11-06 用 GitHub 接口查到：仓库存着 801 个没过期的 artifact，共 15,428 MB，远超套餐所含空间；缓存为 0。

2026-11-06 16:47 到 16:52（JST），另一个代理按 Andy 的要求直接在 `main` 上删掉了三个工作流里全部 `actions/cache` 步骤，并把所有 `retention-days`（artifact 保存天数）改成 1。但策略文件、比对脚本和测试还按旧做法核对，`npm run check:ci-policy` 会报 `CI_QUALITY_WORKFLOW_MISMATCH`，`test/tooling/ci-optimization.test.mjs` 还要求每个任务都有缓存步骤。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-06，说明为什么让代理改 CI 配置：

  > 我不想让 GitHub 继续来扣我的钱。

  > 就是我把那个 CI 的那些缓存，还有 artifacts 全部删掉了。对，这就是我让那个 AI agent 做这件事的初衷

- 问“要我现在删掉这 801 个已存的 artifact 吗？”时，回答：

  > 全部删掉

- 问“要我开 PR 把策略、检查和测试改成和新配置一致吗？”时，回答：

  > 开 PR 修好

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 三个工作流（`ci.yml`、`main.yml`、`quality.yml`）都不用 `actions/cache`。每个任务从锁定的下载地址重新下载固定工具和 npm 包，并照旧校验摘要。
2. 所有 artifact 的 `retention-days` 都是 1，报告和失败诊断一样。`ci/policy.json`、`ci/quality-policy.json`、`ci/policy.schema.json` 和 `scripts/ci/quality-policy.mjs` 里的保存天数都改成 1。
3. `actions/cache` 从 `ci/toolchain-lock.json` 和 `scripts/ci/install-tools.mjs` 的 Action 清单里删掉，因为已经没有工作流用它。
4. `test/tooling/ci-optimization.test.mjs` 检查三个工作流都没有缓存步骤、每个上传步骤都只保存 1 天，防止以后有人加回来。
5. CI 校验 PR 时，`scripts/ci/check-policy.mjs` 的 `resolvePolicySource` 从基准提交读已接受的策略，再用当前的 `ci/policy.schema.json` 检查。基准上还是 30 天和 7 天时（本 PR 自己的 CI 和合并后第一次 `main` 确认就是这样），不升级就会被新规则拒绝。所以 `upgradeArtifactRetention` 只把恰好是“报告 30 天、诊断 7 天”的旧写法升级成 1 天，别的值照样拒绝；做法和已有的 `upgradeHostedRunnerPolicy` 一样，`test/tooling/policy.test.mjs` 里有正反两个用例。
6. 2026-11-06 已按 Andy 的“全部删掉”用 GitHub 接口删除了全部 801 个已存 artifact，删除失败 0 个；删完复查，没过期的 artifact 和缓存都是 0。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **不用缓存，artifact 存 1 天（选中）**：GitHub 上几乎不再存东西，不再产生存储费。代价见[后果](#consequences)。
- **撤回那 7 个提交，回到缓存加 30 天和 7 天**：检查都能通过，但存储费照旧，违背 Andy 的目的。
- **保留缓存，只把 artifact 改成 1 天**：按上面的计费说明，缓存在每个仓库 10 GB 以内另算额度，可能不另收费，还能省下重新下载的时间。Andy 的要求是缓存和 artifact 都删，所以没选；如果以后确认缓存在额度内不收费、又想要更快，可以另开一份 ADR 加回来。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每个任务都要重新下载工具和 npm 包。按 [CI 计划](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/plans/2026-09-03-github-ci-quality-gates-plan.md) 里同一台机器上的实测，锁文件重装冷缓存 120.6 秒、热缓存 77.9 秒，每个任务大约多 40 多秒；完整 CI 有 9 个任务。新的 CI 服务器上实际多多少，等第一次完整 CI 再看。
- CI 跑完 1 天后 GitHub 就删掉报告和诊断。要查失败原因，必须在 1 天内下载；`quality.yml` 手动交接任务读取的 CI 证据也必须在 1 天内用，`scripts/ci/export-evidence.mjs` 按 1 天判断过期，超过时报 `CI_HANDOFF_EVIDENCE_EXPIRED`。
- 目前三个工作流在 GitHub 上是停用状态：Hermes 跑 CI 太慢，要等新的 CI 服务器装好再打开。[ADR 0160](0160-self-hosted-runner-on-hermes.md) 定的“CI 在自己的服务器上跑”不变，停用只是等新服务器期间的临时状态。
- `quality.yml` 的任务仍在 GitHub 自己的机器（`ubuntu-24.04`）上跑。私有仓库按分钟计费，所以重新打开工作流之前，要另外决定它搬到自己的服务器还是继续停着。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [GitHub CI 与质量门禁设计](../execution/specs/2026-09-03-github-ci-quality-gates-design.md)
- [ADR 0160：CI 改在 Hermes 上的自托管 runner 运行](0160-self-hosted-runner-on-hermes.md)
- [ADR 0173：Hermes 只跑 CI](0173-hermes-runs-only-ci.md)

[↑ 返回阅读导航](#contents)
