---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0176-ci-on-ovh-vps.md"
superseded_by: ""
amends: "docs/adr/0174-no-github-cache-and-one-day-artifacts.md, docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md, docs/adr/0243-ci-uses-no-github-artifacts.md, docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md, docs/adr/0256-gate-job-gets-its-own-runner.md, docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md, docs/adr/0275-tests-job-runs-on-three-runners.md"
date: "2026-11-25"
---

# ADR 0287：仓库公开后，CI 全部跑在 GitHub 的免费标准机器上

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

CI（持续集成，每次提交自动跑的检查和测试）原先跑在自托管 runner（自己租的服务器上装的 GitHub 执行程序）上：OVH 的 CI VPS 和 Oracle 东京的 ARM 机器。2026-11-25（JST）Andy 把仓库改成公开，OVH 机器已退租，Oracle 机器改作 Himawari 生产服务器，6 台 runner 已全部从仓库注销。Andy 的要求是公开后 CI 全在 GitHub 自己的机器上跑，并且“保证不扣钱”；他明确说直接迁移，不再另写方案。

<a id="premises"></a>

## 前提

1. 公开仓库用标准托管机器免费：<https://docs.github.com/en/billing/concepts/product-billing/github-actions> 原话 “The following usage remains free independently and does not reduce the included compute usage: Standard GitHub-hosted runners in public repositories.”
2. larger runner 不在免费之列：同一页把 larger runner 单列为按分钟计费的机器，免费条目只写了 “Standard GitHub-hosted runners”。
3. Actions 缓存每个仓库 10 GB，不调高上限就不收费：同一页原话 “The repository owner will only be charged if the repository cache storage limit has been configured higher than the included usage.”；<https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching> 原话 “If you exceed the limit, GitHub will save the new cache but will begin evicting caches until the total size is less than the repository limit.”
4. 公开仓库的 artifact（作业产物）存储是否免费，上面那页没有明说：它只写 “For private repositories, usage is measured against two parts of your plan”。所以本决定不用 artifact，[ADR 0243](0243-ci-uses-no-github-artifacts.md) 的禁令保留。
5. 公开仓库不该用自托管 runner：<https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners> 原话 “self-hosted runners should almost never be used for public repositories on GitHub”。
6. 托管机器每个作业是一台新虚拟机，作业之间没有共用目录：`scripts/ci/run-share.mjs` 的 `shareRoot` 要求 `HIMAWARI_CI_SHARE` 指向本机一个已有目录，没设或不是绝对路径以 `CI_SHARE_ROOT_REQUIRED` 失败，目录不存在以 `CI_SHARE_ROOT_INVALID` 失败。

<a id="decision"></a>

## 决定

1. 机器：`policy`、`tooling`、`security` 跑在 `ubuntu-24.04-arm`；`static`、`build`、`browser`、`tests`、`ci/required`、main 确认、合并队列和“关闭 PR 时取消 CI”跑在 `ubuntu-24.04`；新增 `Apple` 工作流在 `macos-26` 上跑 `HimawariCore` 单元测试，并不签名编译 iPhone App。`static` 原来在 Oracle ARM 机器上跑，这次改回 x64：`npm run check` 里的 `check:delivery-dependencies` 会真的运行只认 linux-x64 的依赖收集脚本（`scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs`），在 ARM 机器上以 `P5_ENVIRONMENT_INVALID` 失败；两种机器都免费，所以不在测试里跳过，而是换机器。
2. 只准用这三种标签：`npm run check:ci-policy` 读 `.github/workflows/` 下全部工作流，`runs-on` 不是这三种之一（包括 larger runner、`self-hosted`、浮动标签和算出来的表达式）就以 `HOSTED_RUNNER_REQUIRED` 失败。
3. 作业之间传文件：`run-share.mjs` 的摘要核对不变，只是共享目录改成每台机器自己的 `$RUNNER_TEMP/ci-share`；每个检查作业把自己那份报告用 `actions/cache/save` 存进本次运行的缓存，键带 `run_id` 和 `run_attempt`；`browser`、`tests` 先用 `actions/cache/restore`（取不到就失败）取回本次的 Linux 构建，汇总作业在收齐前逐个取回各成员的报告。取回后仍按作业输出里的摘要逐字节核对。这是对 [ADR 0174](0174-no-github-cache-and-one-day-artifacts.md)“不用 GitHub 缓存”的修订：只放开本次运行内部的传递，依赖和工具仍不缓存。
4. 删除自托管 runner 的安装脚本、ssh 拉报告的 `scripts/ci/remote-share.mjs` 和 CI VPS 的运行手册。
5. 托管机器上沙箱测试需要的 bubblewrap、socat、ripgrep 和 Ubuntu 24.04 的 AppArmor 放宽，由 `scripts/ci/prepare-hosted.sh` 在每次作业开头装好。
6. main 上已接受的策略文件仍写着 `ci-vps`、`ci-arm`、`ci-vps-gate`：`resolvePolicySource` 在基准上把它们整体换成对应的托管标签，摘要仍按原始字节算。

<a id="industry"></a>

## 业界怎么做

GitHub 官方的缓存说明把 `actions/cache` 用于同一工作流里作业之间、以及多次运行之间复用文件；官方建议公开仓库不用自托管 runner（前提 5）。多数开源项目的 CI 都直接用标准托管机器。

<a id="options"></a>

## 放弃的做法

- 用 artifact 在作业之间传文件：写法最简单，但公开仓库的存储是否免费文档没明说（前提 4），而且 I-95 就是 artifact 额度撑爆导致 CI 全红。
- 每个测试作业自己重新构建：省掉传构建，但构建不可复现（归档名带运行号），也失去“消费者用的就是 build 作业那份归档”的核对。
- 继续用自托管 runner：公开仓库不安全（前提 5），机器也已退租或改作生产。

<a id="consequences"></a>

## 后果

- CI 不再花钱：标准托管机器免费，缓存在 10 GB 内不收费，Andy 账号上 Actions 的 0 美元预算并勾选了超额拦截，兜底防误开。
- 汇总作业不再在结束时删共享目录：每台机器的临时目录随虚拟机一起消失；存进缓存的那几份不主动删（删要给作业写权限，`ci.yml` 规定所有作业只读），由 GitHub 在七天没人用后删掉，或在仓库缓存超过 10 GB 时按“最久没用的先删”淘汰（前提 3）。同时跑的运行很多时，正在跑的那次的构建也可能被淘汰，这时 `browser`、`tests` 会在取回那一步明确失败，重跑整次运行即可；不会因此收费，因为上限没有调高。这修订了 [ADR 0241](0241-draft-prs-skip-ci-and-merge-waits-for-green.md) 里“结束时删除共享目录”和 [ADR 0243](0243-ci-uses-no-github-artifacts.md) 里“完整报告在 CI 服务器的共享目录里”的说法。
- macOS 机器只有 3 核、7 GB 内存，免费账号同时最多 5 台；iPhone 编译变慢时先看排队，不换收费机器。
- 自托管时代的 ADR（[0176](0176-ci-on-ovh-vps.md)、[0238](0238-ci-job-files-stay-on-the-ci-vps.md)、[0256](0256-gate-job-gets-its-own-runner.md)、[0266](0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md)、[0275](0275-tests-job-runs-on-three-runners.md)）里提到的 CI VPS 运行手册已删除，最后一版在提交 `88e17c2430041266de223e41c4163c45d1a02369`。
