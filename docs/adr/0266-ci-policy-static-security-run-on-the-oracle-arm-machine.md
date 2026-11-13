---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0253-support-linux-arm64-for-test-and-qualification.md, docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md"
date: "2026-11-13"
---

# ADR 0266：policy、static、security 三项检查改在 Oracle 的 ARM 机器上跑

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提和来源](#premises)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [验证](#verification)
- [关联文档](#references)

<a id="context"></a>

## 背景

CI（每次推送后 GitHub Actions 自动跑的检查）的检查作业原来全部排在 CI 服务器的几个 runner（装在自己机器上、替 GitHub 执行作业的程序）上，开发线程一多就排长队。Andy 租的 Oracle 东京 ARM 机器（4 核、24 GB）上已经装好 `ci-arm-1`、`ci-arm-2` 两个 runner，此前只跑不计入必过结论的试跑工作流。这份 ADR 决定把三项检查正式放到它上面，并修订 [ADR 0253](0253-support-linux-arm64-for-test-and-qualification.md) 里“ARM 不进必过检查”的那一条。

<a id="premises"></a>

## 前提和来源

1. ADR 0253 现在写明 ARM 不进必过检查。来源：`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md` 第 62 行，原话“ARM 不进 GitHub 必过检查，也不切线上。”；第 83 行，原话“测试机可能被 Oracle 回收，不能让必过检查依赖它”。这份 ADR 修订这两处，只限 policy、static、security 三项。
2. ADR 0253 同时写明 `ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流不改。来源：同一文件第 66 行，原话“`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。”这份 ADR 修订这一条。
3. ADR 0238 写明只有 CI 服务器上的 runner 能跑这套 CI。来源：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md` 第 92 行，原话“只有 CI VPS 上的 runner 能跑这套 CI”。这份 ADR 同样修订这一条。
4. 三项检查的运行位置在 `.github/workflows/ci.yml`：policy 第 33 行、static 第 72 行、security 第 284 行，原话 `runs-on: ci-arm`。
5. 汇总作业用 `--remote-jobs policy,static,security` 去 ARM 机器取报告。来源：`.github/workflows/ci.yml` 第 362 行，原话 `run-share.mjs collect --to .ci-output/reports --remote-jobs policy,static,security`。
6. 策略里这三项允许的架构：`ci/policy.json`（policy 第 15、16 行，static 第 32、33 行，security 第 122、123 行），原话 `"arch": "x64"`、`"alternateArch": "arm64"`。
7. 未核实：ARM 机器上三项检查的真实时长和失败率。切换后的第一批运行产生数据，由日志里的 `CI_HOST_LOAD` 行和作业时长核对。

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-12 21:55 JST：“你以后不用担心我那台 Oracle 云服务器费用的问题”。
- 2026-11-13 01:01 JST：“那个 Oracle 的加速方案不用给我看了，方案出来之后直接实施”。
- 2026-11-13：“马上，现在就切过去，赶快让 Oracle 那台机器充分利用起来，来分担 CI 的负担。把 CI 赶快跑起来，不要再阻塞整个项目的开发了。”

<a id="decision"></a>

## 决定

1. policy、static、security 三项检查的 `runs-on` 和策略里的 runner 都改成 `ci-arm`；build、browser、coverage 和汇总作业仍在 CI 服务器上，因为后几项要用 x64 的构建产物。
2. 策略里这三项的成员仍写 `arch: x64`，另加 `alternateArch: arm64`。汇总时报告里的架构必须是这两个值之一；build 等其他检查不接受 arm64，也不接受其他架构。
3. 应急用 `arm-fallback.sh on` 把 `ci-arm` 标签加到 CI 服务器的检查 runner 上，这时三项检查在 x64 上跑，汇总照样认可。这是有意保留的取舍：Oracle 机器停机时 CI 能继续，代价是汇总不能证明某次报告一定来自 ARM。“在哪种机器上跑”靠运行时的 runner 标签和日志里的 `CI_HOST_LOAD` 行核对，不靠汇总拦。
4. 汇总作业用只读的 ssh 去 ARM 机器取这三项的报告，取回的内容照旧按摘要核对（取报告的做法见运行手册“Oracle 的 ARM 机器上的两个 runner”一节）。
5. ARM 的工具链条目放在主锁文件 `ci/toolchain-lock.json` 里（里面已有 linux-arm64 的 Node、Python、actionlint、gitleaks、Semgrep），不是 ADR 0253 第 66 行写的独立锁文件（第 84 行给出不直接加进主锁文件的理由）；汇总比对锁文件摘要，只有一份锁文件才对得上。这一点也以这份 ADR 为准。
6. 不再等 20 次试跑一致才切换：Andy 明确要求现在切。试跑工作流已删除，改为用切换后的真实运行数据观察；如果三项检查在 ARM 上出现与 x64 不一致的结论，停下来带数据找 Andy。

<a id="options"></a>

## 比较过的方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 三项检查切到 ARM，保留 x64 应急 | 采用 | 同时能跑的检查作业从 2 个变成 4 个，Oracle 停机时可退回 |
| 继续跑 20 次试跑再切 | 不采用 | Andy 明确要求立刻切，排队正在阻塞整个项目 |
| 汇总只接受 arm64 | 不采用 | Oracle 被回收或停机时必过检查会一直排队，应急命令也就没用 |
| build、browser、coverage 也搬到 ARM | 暂不采用 | 它们消费 x64 构建产物，要先有 ARM 产物和覆盖率合并方案 |

<a id="consequences"></a>

## 后果

- 必过检查开始依赖 Oracle 这台机器。它停机时三项检查排队，直到有人在 Mac 上运行 `arm-fallback.sh on`。
- Oracle 机器同时是测试机；runner 的服务单元设了 `ProtectHome=yes`（来源：`scripts/operations/ci-runner/gh-runner.service.in` 第 33 行），看不到 `/home`；测试数据放在哪些目录、是否读得到，要等安装脚本在机器上实查，这份 ADR 不保证。这也挡不住有人存心利用系统漏洞。仓库私有、只有 Andy 和他的代理提交，这和 CI 服务器接受的前提相同。
- 汇总不区分 ARM 和应急时的 x64，见决定第 3 条。
- GitHub 上不花钱。

<a id="verification"></a>

## 验证

- 策略：三项检查的 `runs-on` 写回 `ci-vps`、coverage 写成 `ci-arm`、漏写或少写 `--remote-jobs` 的名单，都必须失败；测试在 `test/tooling/policy.test.mjs`，名字带 `[ADR-0266]`。
- 汇总：三项检查的 arm64 报告通过，build 的 arm64 报告和任何检查的 ppc64 报告失败；测试在 `test/tooling/aggregate.test.mjs`。
- 上线后：真实 PR 的三项检查落在 `ci-arm-1` 或 `ci-arm-2` 上，`ci/required` 成功。

<a id="references"></a>

## 关联文档

- [ADR 0238：CI 作业的文件留在 CI 服务器上](0238-ci-job-files-stay-on-the-ci-vps.md)
- [ADR 0253：让 Himawari 能在 linux-arm64 上跑检查](0253-support-linux-arm64-for-test-and-qualification.md)
- [ADR 0256：汇总作业用专用 runner](0256-gate-job-gets-its-own-runner.md)
- [CI 服务器 runner 运行手册](../runbooks/ci-vps-runner-runbook.md)
