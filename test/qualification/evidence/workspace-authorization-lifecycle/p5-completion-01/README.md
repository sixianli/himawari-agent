# P5 自动审查接入：本批证据说明（2026-09-21）

本目录保存 [P5 本批完成条件](../../../../../docs/execution/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p5-batch-contract) 的历史机器可读摘要与复现入口。`verification.json` 中 `testedSha` 为 `20a7ec2`，仅证明那一版的本地检查；不能证明 2026-09-22/23 后续 TypeSafe 提交或当前工作树通过。本目录不把真实模型、真实费用或生产启用写成已验证。当前修复见[缺陷修复计划](../../../../../docs/archive/plans/2026-09-23-automatic-review-defect-repair-plan.md)。

## 本次交付的行为

1. **生产装配**：`createProductionAutomaticReview` 按 `runPolicy.automaticReview` 组合 `AutomaticActionReviewService` 与 `ModelActionReviewer`，复用产品 `ModelPort`/`TrustedModelProviderAdapter`、`ProtectedPiModelPayloadBoundary` 与 `AutomaticReviewStorePort`。`service-main.ts` 只在配置存在时装配；配置存在却缺少模型边界或受保护 Payload 时以 `AUTOMATIC_REVIEW_RUNTIME_UNAVAILABLE` 启动失败，不静默降级。
2. **最小披露**：审查输入为 `automatic-review-input.v1`，只含审查/请求身份、版本、能力与操作、`actionKind`、`sideEffect`、`finalRisk`、数据分级、目标类型集合、确定性事实码与期限；不含文件正文、本地路径、凭据、接收方或会话文本。
3. **替代的新请求**：`AutomaticActionReviewService.review` 返回宿主已提交的 `AutomaticReviewOutcome`；`ActionPolicyService` 只对 `alternative` 生成 `DENY automatic_review_suggested_alternative` 并附 `automaticReview.suggestionRef`，`runtimeToolAuthorizationResult` 把它渲染成“必须提出新的具体请求”的失败结果。修改后的请求是新 intent，缺少委托覆盖时回到人工；建议正文的指令不能执行，也不产生 Grant/Approval/claim。
4. **竞争与来源**：SQLite `claim`/`finish` 不写文件占用、不建 Handle 或调用回执；删除、取消、过期、政策收紧、人工决定与重复结果都被事务内核验拒绝；自动批准在审批与 Grant 上保留 `automaticReview` 与 `policyAuthorization` 来源。

## 复现命令

```sh
npx vitest run --config vitest.workspace.ts --project node-services apps/agent-service/test/production-automatic-review.unit.test.ts
npx vitest run --config vitest.workspace.ts --project integration test/integration/automatic-action-review.test.ts test/integration/authorization-capability-governance.test.ts
npx vitest run --config vitest.workspace.ts --project unit packages/application/test/automatic-action-review.unit.test.ts packages/application/test/model-action-reviewer.unit.test.ts packages/application/test/runtime-tool-authorization.unit.test.ts
npx vitest run --config vitest.workspace.ts --project unit packages/platform-node/test/startup-configuration.unit.test.ts
npx vitest run --config vitest.workspace.ts --project node-services apps/agent-service/test/service-orchestration.unit.test.ts apps/agent-service/test/production-file-read-workflow.unit.test.ts
```

计数、环境与未验证边界见 [verification.json](verification.json)。

## 标准本地交付验证

```sh
node scripts/ci/local.mjs --check test --tools .ci-output/tools --output .ci-output/p5-final
```

结果：`build/macos-arm64: passed`、`test/macos-arm64: passed`，`local_passed`（hosted gate 未执行）。测试为 **258 文件/4139 项全部通过、0 失败、0 跳过**；分项为 unit 134/1902、contracts 23/349、integration 88/1755、e2e 1/3、pi-compat 12/130。机器可读摘要见
`.ci-output/p5-final/test-macos-arm64/tests/tests.json`，同一摘要记录在 [verification.json](verification.json)。同一次运行还包含本机 node-services、browser 与 admin-cli 项目。

## 受控边界与已知环境失败

- 审查模型是测试替身，但 SQLite journal、Schema 39 持久记录、Approval/Grant 事务、预算结算、受保护 Payload 与取消信号是真实实现；没有真实 provider 调用、费用或生产启用。
- `test/integration/installable-node-services.test.ts` 与 `test/integration/production-http-composition-process.test.ts` 需要预构建产物（`HIMAWARI_TEST_ARTIFACT`/`HIMAWARI_TEST_CONTEXT`）；`tooling` 4 文件/11 项需要 `.ci-output/tools/installation.json`。在暂存本批全部跟踪改动后仍复现同样失败，属环境前提而非本批回归；未修改这些文件或放宽断言。
- 实施期间 `service-orchestration.unit.test.ts` 曾因组合逻辑对测试替身静默降级而暴露启动失败；改为显式配置门控与明确失败后该文件 57 项通过，这段返工原因已记入原决策日志。
