# 第 7 轮复核：线程逐条判断

复核提交 `a22e487e`，增量从 `ddf64aaa` 起，只有第 6 轮复核记录和合并 origin/main（`ce1bcbee`）带进的三个 CI 工作流文件。DeepSeek 0.0309 美元，GLM 0.0313 美元；这个 PR 的复核累计 0.9728 美元（Andy 2026-11-06 批的总额上限 1.35 美元）。

两个模型都核实了：三个工作流文件和 origin/main 逐字相同，合并没有混入或丢掉本 PR 的任何改动。

结论：本 PR 没有“会出错”的意见，停在这一轮。

## 会出错（本 PR）

本轮没有。

## 不属于本 PR（main 上 CI 改动的问题，Andy 说由另一个线程处理）

两个模型指出的都是 main 本身的问题，合并前后一样，转给处理 CI 的线程参考：

| 来源 | 意见 |
|---|---|
| DeepSeek、GLM | `check:ci-policy` 失败的根因：`quality.yml` 的 artifacts 保留期改成 1 天，但 `ci/quality-policy.json`、`scripts/ci/quality-policy.mjs`（常量 30/7）、`ci/policy.schema.json`（`const` 30/7）和 `test/tooling/quality-policy.test.mjs` 仍要求 30/7，要几处一起改 |
| DeepSeek、GLM | 第二个会失败的测试：`test/tooling/ci-optimization.test.mjs:68-81` 仍要求每个 job 都有 `actions/cache@` 步骤，而 `ci.yml` 已全部删掉 |
| DeepSeek、GLM（推测） | `ci.yml` 的 report/gate artifacts 只留 1 天，`quality.yml` 交接和 `main.yml` 确认按 run 编号跨工作流下载它们，`scripts/ci/export-evidence.mjs` 仍按 30 天接收并写 30 天有效期；交接晚于 1 天就会下载失败 |
| GLM（低） | `scripts/ci/install-tools.mjs` 和 `ci/toolchain-lock.json` 仍强制锁着 `actions/cache`，以后清理要一起改 |

## 可以更好

第 6 轮那条“service-main 接线没有单独测试”，Andy 2026-11-06 说不做。
