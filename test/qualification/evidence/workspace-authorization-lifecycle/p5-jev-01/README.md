# P5 TypeSafe JEV 自动审查接入：受控验证（2026-09-22）

> **2026-09-23 更正：** 下述 95 项是 2026-09-22 的历史替身测试结果，不可作为当前 TypeSafe 协议验收。替身当时采用 `{value, confidence}`、`model: jev-latest`，缺少官方 Choice 的 `type/choice/probabilities`、具体版本模型名及 `usage.output_tokens`；测试还手工构造了生产代码当时缺失的顶层数据分级。修复与现行测试结果见[缺陷修复计划](../../../../../docs/archive/plans/2026-09-23-automatic-review-defect-repair-plan.md)。本文件其余内容保留历史口径，不代表当前实现。

本目录记录以 TypeSafe JEV 作为自动审查模型的本地接入与受控验证。**没有真实 provider 调用、没有真实费用、没有生产启用**；JEV 端点是本地假端点。

## 交付行为

1. **配置驱动**：`runPolicy.automaticReview` 增加可选 `confidenceThreshold`（默认 0.8）；模型描述符的 `api` 改为判别式——`openai-completions`（原 Pi 对话模型）或 `typesafe-systemone`（决策端点，只允许 `modelVersion`，不允许 reasoning/contextWindow/maxTokens/providerRouting，且 output 价格必须为 0）。
2. **按描述符选择协议**：`production-model-composition` 由"单一 Pi transport"改为按冻结描述符的 `api` 分派；`piModels` 只绑定 OpenAI-compatible 描述符；决策端点按 input token 计价、output 记 0。
3. **JEV transport**：冻结摘要作为 `state`，host 拥有的 typed questions（`within_delegated_scope` / `decision` / `reason_code`）决定答案空间；答案由**宿主确定性合成**并重新绑定冻结请求身份，再经共享决策契约校验。未知答案、越出词表、越界置信度、外来 model 身份、缺凭据、HTTP 错误与取消一律 fail-closed；503/429 有界重试，4xx 不重试。
4. **置信度门控**：低于阈值的 `approve` 一律改写为 `human`（并丢弃仅批准允许携带的置信度），请求回到原人工确认路径，不生成 Grant。

## 验证命令与结果

```sh
# JEV transport 协议与失败分支
npx vitest run --config vitest.workspace.ts --project unit packages/platform-node/test/typesafe-jev-transport.unit.test.ts
# 配置契约
npx vitest run --config vitest.workspace.ts --project unit packages/platform-node/test/startup-configuration.unit.test.ts
# 审查契约与模型适配器
npx vitest run --config vitest.workspace.ts --project unit packages/application/test/automatic-action-review.unit.test.ts packages/application/test/model-action-reviewer.unit.test.ts
# 生产端到端（真实适配器 + 真实 SQLite + 假 JEV 端点）
npx vitest run --config vitest.workspace.ts --project integration test/integration/production-jev-review.test.ts
```

结果：14 + 38 + 40 + 3 = **95 项通过，0 失败**。

端到端三个场景：

| 场景 | 断言 |
| --- | --- |
| 高置信批准 | 调用一次 `POST /v1/systemone`；策略返回 `ALLOW` 且 basis 为 Grant；落库一次性精确 Grant（maxUses=1、intentFingerprint 绑定原请求）；审批带 `automaticReview` 来源；模型预算账户出现真实结算记录 |
| 低置信批准 | 策略返回 `ASK`；无 Grant；审批为 `pending`（原人工路径） |
| 越范围 | 策略返回 `ASK`；无 Grant；只调用一次 |

## 未验证与限制

- 真实 TypeSafe 端点、真实 key、真实用量与费用、真实接收方披露：**未执行**，待用户提供 key 后单独验收。
- `node scripts/ci/local.mjs --check test` 未能在本轮改动上取得完整通过：工作区读取间歇性 `ETIMEDOUT`（errno -60）曾使 build 阶段直接失败、个别 vitest 运行长时间无输出。同一工具链此前跑过 4139 项，故按环境故障处理，不计为产品失败。
- 完整页面/联合验收仍归 P6；P5 第③④项保持未勾选。
