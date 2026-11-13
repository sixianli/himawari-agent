# 作者说明：把汇总作业 ci/required 切到专用 runner ci-vps-gate（ADR 0256 第 1 步的 PR B）

背景：ADR 0256（`docs/adr/0256-gate-job-gets-its-own-runner.md`）决定汇总作业只在第 3 个 runner `ci-vps-gate` 上跑。runner 的安装脚本已在上一个 PR 合并，第 3 个 runner 2026-11-12 已在 CI 服务器上注册并在线。

这个 PR 改了什么：

- `scripts/ci/contracts.mjs`：新增常量 `gateRunnerLabel = "ci-vps-gate"`。
- `scripts/ci/check-policy.mjs`：`validatePolicy` 要求 `required` 的成员 runner 是 `ci-vps-gate`、其余 Linux 成员是 `ci-vps`；新增 `upgradeGateRunnerPolicy`，接在升级链最外层：基准上是“七个作业、`required` 只有一个成员且 runner 是 `ci-vps`”的已接受策略时，把它升级成 `ci-vps-gate`，别的写法原样返回（之后被 `validatePolicy` 拒绝）。
- `ci/policy.json`、`ci/policy.schema.json`、`.github/actionlint.yaml`、`.github/workflows/ci.yml`：`required` 改成 `ci-vps-gate`，标签登记。
- 测试：`test/tooling/policy.test.mjs` 新增四条 `[ADR-0256]` 用例（旧基准升级且摘要按原始字节算；只升级那一种写法；检查作业写成 `ci-vps-gate`、汇总作业写回 `ci-vps` 的策略被拒；工作流同样被拒），并把代表历史写法的夹具改回 `required` 在 `ci-vps`；`test/tooling/ci-runner-scripts.test.mjs` 把“谁也不许用汇总标签”的用例换成跨文件一致性用例（策略、工作流、actionlint、schema、`runners.sh` 里两个标签一致，且只有 `required` 用汇总标签）。
- 文档：ADR 0172 加 `amended_by`，ADR 0256 的 `amends` 和后果一节写明恢复时加回的是各 runner 自己的标签。

请重点核对：

1. 升级链：别的 PR 的基准（main 上的旧 `ci/policy.json`，`required` 在 `ci-vps`）经 `resolvePolicySource` 之后，`validateWorkflow(source.policy, 新的 ci.yml)` 能不能过；更早的历史写法（托管 runner、`hermes-home`、九作业）经整条链之后能不能过。
2. 有没有一种本应被拒的策略因为新的升级函数而被放行。
3. `required` 作业在只有 2 GB 内存的 `ci-vps-gate` 上跑，它的步骤（安装固定工具、装汇总器最小依赖、从 `/srv/gh-runner-share` 收报告）有没有依赖只在检查 runner 上才有的东西。
