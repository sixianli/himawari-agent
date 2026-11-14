# PR 439 第 1 轮作者说明

问题：带沙箱证据（资格记录里有 `sandbox` 字段）的能力，经 `CapabilityLifecycleService` 的 `activate`、`activateUpdate`、回滚激活时一律报 `runtime qualification failed`。

作者认定的根因（请核对，不要直接采信）：
- `packages/application/src/services/capability-lifecycle-service.ts` 的 `qualify` 原先要求 `enforcement` 六项全部为真。
- `packages/platform-node/src/capabilities/capability-deployment.ts` 的 `parseQualification` 要求带沙箱证据的记录 `resourceCeilings` 必须为假、`termination` 只在 Linux 为真，否则报 `sandbox evidence conflicts with enforcement claims`。
- `packages/execution-contracts/src/sandbox-qualification-v1.ts` 里 `resourceMode` 只有 `observe_and_stop` 一种取值；`packages/application/src/ports/capabilities.ts` 的端口定义写着 “legacy enforcement booleans must remain truthful”。作者据此认为加载器的语义对，`qualify` 错。

改动：
- `qualify` 改调新函数 `qualificationEnforcementHolds`：没有沙箱证据时仍要求六项全真；有沙箱证据时要求 filesystem、network、processes、secrets 为真，`resourceCeilings` 为假，`termination === (sandbox.terminationMode === "verified_tree")`。
- 新测试 `test/integration/sandbox-capability-qualification-lifecycle.test.ts`：写真实快照文件，用真实加载器读出资格记录，交给真实的 `CapabilityLifecycleService`。还原修复后“激活成功”和“拒绝虚报资源上限”两条失败。

约束：不改表；代码不写注释；测试不用假替身；不能只是把检查放宽。

列出的做法只是参考，不要局限于它，请从问题本身出发，提出你认为更好的做法。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？（作者认为不涉及发给模型的内容，请确认。）
2. 两边哪一边的语义才对，作者的认定有没有依据不足的地方；有没有第三处代码（例如 `apps/execution-worker/src/production-worker-composition.ts`、`packages/platform-node/src/capabilities/isolation.ts`、`authorizedManifests`）对同一份记录有别的要求，会让修复后仍然走不通或者放过不该放过的记录。
3. 新规则有没有比加载器更宽或更严的地方；有没有输入能让带沙箱证据但实际管控不足的记录通过。
4. 测试是否真的覆盖正反两面，有没有遗漏的路径（更新激活、回滚）。
