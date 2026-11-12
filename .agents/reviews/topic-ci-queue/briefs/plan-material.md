# 方案讨论材料：CI 排队太长

## 问题

2026-11-12 19:30 JST，仓库有 28 次 CI 运行在排队，新 PR 的检查要等几个小时才开始。Andy 的目标：CI 要顺；修根因，不降低检查质量；绝不在 GitHub 上花钱（仓库私有，不用 GitHub 托管的 runner）；不在服务器上多花钱（只用现有的 CI VPS）。

## 已核对的事实

1. CI 在一台 VPS 上跑：8 个 vCPU、22 GB 内存，两个自托管 runner `ci-vps-1`、`ci-vps-2`，标签都是 `ci-vps`。来源：`docs/adr/0176-ci-on-ovh-vps.md` 第 34、72、75 行（“两个 runner 合计 `MemoryHigh=19G`、`MemoryMax=20G`，每个 `MemoryHigh=14G`、`MemoryMax=15G`”）；第 54 行（“先装 2 个，跑一次完整 CI 再决定要不要加到 3”）。
2. 每个 runner 一次只跑一个作业（GitHub 自托管 runner 的固有行为）。`ci.yml` 一次完整运行有 6 个检查作业（policy、static、build、browser、coverage、security）加汇总作业 `ci/required`，全部 `runs-on: ci-vps`（`.github/workflows/ci.yml`）。
3. 实测作业时长（GitHub API 的作业记录，2026-11-12）：policy 13 到 14 分钟，static 13 到 14 分钟，build 约 6 分钟，security 约 6 分钟。policy 作业的资源记录：峰值内存 2.68 GB（作业日志里的 `peakBytes: 2682445824`），机器 8 核。
4. `ci.yml` 的并发设置（第 23 到 25 行）：`group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}-${{ github.event_name == 'push' && github.run_id || '' }}`，`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`。
5. 汇总作业 `required` 是 `if: always()`、`runs-on: ci-vps`，第一步“草稿和被取消的运行直接判失败”（`ci.yml` 第 324 行起）。草稿 PR 的 6 个检查作业都被跳过，但汇总作业仍要占一个 runner 跑几秒钟。来源：[ADR 0241](../../../docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md)。
6. 实测：排队的 28 次运行里，多数是“6 个检查作业已跳过或已取消，只剩 `ci/required` 在等 runner”的运行，例如运行 43188147300、43191538886、43186918106（都是 `ci/required | queued`，其余作业 `skipped`）。同一个 PR 的新运行处于 `pending`，要等旧运行的 `ci/required` 跑完才开始（例如 PR 439：43188147300 排队，43193780006 等待）。
7. `main.yml`（合并到 main 之后的确认）的并发组是 `main-confirmation-${{ github.run_id }}`、`cancel-in-progress: false`，所以 main 上连续合并 6 次就有 6 次确认各自排队；证据取不到时走完整 CI（6 个作业）。
8. 当天有多个线程同时开发，短时间内反复推送；每次推送触发一次运行。
9. 分支保护规则目前没有要求 `ci/required`（AGENTS.md“交付模式”一节：合并前 PR 最新提交上的 `ci/required` 必须是成功，由线程自己遵守）。
10. `scripts/ci/check-policy.mjs` 逐字校验 `ci.yml` 的结构，`scripts/ci/main-workflow.mjs` 校验 `main.yml`；改工作流要同步改它们和 `test/tooling/policy.test.mjs`。
11. VPS 的 runner 安装脚本在 `scripts/operations/ci-runner/`，运行手册是 `docs/runbooks/ci-vps-runner-runbook.md`。云端线程没有 VPS 的登录凭证，改 VPS 要 Andy 在 Mac 上执行。

## 约束

- 不花钱：不用 GitHub 托管 runner，不加服务器。
- 不降低检查质量：不能跳过、合并或弱化检查；被取消或草稿的运行不能被当成通过（跳过的必需检查在 GitHub 分支保护里算通过，这是 ADR 0241 让汇总作业 `if: always()` 并判失败的原因）。
- 汇总结论要打印在 `ci/required` 作业日志里，main 的轻量确认靠它（ADR 0243）。
- 代码不写注释；工作流改动要有硬规则和反向用例。

## 请你给出

一套让排队明显变短的方案：改哪些文件、VPS 上要做什么、每项改动的风险和怎样验证；参考 GitHub 官方文档和成熟开源项目在自托管 runner 上的做法，附一手来源。指出上面哪条事实你核对后认为不对。
