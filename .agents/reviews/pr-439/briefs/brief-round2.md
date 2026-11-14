# PR 439 第 2 轮作者说明

第 1 轮的逐条判断在 `.agents/reviews/pr-439/round-1/judgments.md`。这一轮请看第 1 轮之后的修改（请核对，不要直接采信）：

- `packages/execution-contracts/src/sandbox-qualification-v1.ts` 新增 `sandboxEnforcementClaimsMatchEvidence`（先用 `sandboxRuntimeQualificationSchema` 解析证据，再核对平台、`runtimeIdentity`、`resourceCeilings` 为假、`termination` 只在 Linux 为真）和 `sandboxRequiredControlsEnforced`（四项必须管控）。
- `packages/platform-node/src/capabilities/capability-deployment.ts` 的 `parseQualification` 改调这两个函数。作者认为加载器的行为没有变，请核对有没有变宽或变严。
- `packages/application/src/services/capability-lifecycle-service.ts` 的 `qualificationEnforcementHolds` 改调这两个函数，并要求带沙箱证据的清单 `runtime.kind === "program"`。
- 测试：`test/integration/sandbox-capability-qualification-lifecycle.test.ts` 共 12 条（更新激活后回滚、更新候选虚报被拒、终止声明矛盾、平台或运行时身份对不上、证据不合契约、无沙箱证据仍要求六项全真）；`packages/platform-node/test/capability-deployment.unit.test.ts` 补 4 条加载器冲突用例。
- 已知且不在本 PR 范围：main 上的生产治理网关没有传 `capabilityLifecycle`，接线由另一个分支做，本 PR 是它的前置。

约束：不改表；代码不写注释；不能只是把检查放宽。

列出的做法只是参考，不要局限于它，请从问题本身出发，提出你认为更好的做法。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？
2. 加载器改调共用函数后，对任何输入的接受或拒绝结果、错误码有没有变化。
3. `qualify` 的新规则还有没有比加载器宽的地方；已持久化的 `runtimeQualification`（回滚时用）会不会因为重新解析证据而被错误拒绝。
4. 新增用例有没有在旧代码下也通过、起不到回归保护作用的。
