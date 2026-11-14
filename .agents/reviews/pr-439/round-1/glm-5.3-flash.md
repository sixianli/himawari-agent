# PR 439 第 1 轮复核报告

基准 `6e33c029`，待核 `5cec2fa`。改动：`capability-lifecycle-service.ts` 的 `qualify` 检查换为新函数 `qualificationEnforcementHolds`，新增一个集成测试文件，外加一个二进制评审简报 `.agents/reviews/pr-439/briefs/brief-round1.md`（内容未核实）。

## 按严重度排列的问题

**1｜中｜packages/platform-node/src/capabilities/isolation.ts:280-291、apps/execution-worker/src/production-worker-composition.ts:369-400、apps/agent-service/src/production-approval-gateway.ts:200-255**
问题：修复只对「运行时端口返回带 `sandbox` 证据的资格记录」生效，但现有生产代码没有任何路径能产生这种记录；测试里的“激活成功”是用内联 stub 喂进去的，没有证明任何真实装配能走到这条新分支。
证据（读代码证实）：
- `isolation.ts` 的 `qualification()` 辅助函数（280-291 行）构造的 `enforcement` 六项全部来自 `input.ready`，且**从不写 `sandbox` 字段**；三个实现（`LinuxBubblewrapIsolationBackend`、`MacSignedHelperIsolationBackend`、`NodeCapabilityRuntimeQualifier` 的 endpoint 分支）都走它，即生产 qualifier 永远产出无沙箱证据的 legacy 记录，命中 `!sandbox` 分支，与旧逻辑等价。
- `production-worker-composition.ts:376-379`：沙箱绑定条目在部署资格检查里**直接跳过 live qualify**（只做 `verifyWorkerSandboxHostAtStartup`），不走 `qualifier.qualify`。
- `production-approval-gateway.ts:200-255`：生产 agent-service 组装 `GovernanceGatewayV2ControlPlane` 时**没有传 `capabilityLifecycle`**（接口里它是可选的，governance-gateway-adapter.ts:573），即 `activate`/`activateUpdate`/`rollback` 这条用户流程目前没有生产装配；`CapabilityLifecycleService` 全仓库只在测试里构造。
建议：作者应说明修复预期在哪个装配里生效；若目标是“治理流程能激活沙箱能力”，需要补一个把部署快照资格记录接到 `CapabilityRuntimeQualifierPort` 的生产装配，或明确本 PR 只是解锁前置。

**2｜低（潜在）｜packages/application/src/services/capability-lifecycle-service.ts:762-772**
问题：服务端新规则比加载器（`capability-deployment.ts` 的 `parseQualification`）弱三处：不校验 `runtimeIdentity === "srt:${sandbox.srtVersion}"`、不校验 `sandbox.platform === qualification.platform`、不对 `sandbox` 记录重跑 schema 校验（guarantees、darwin/linux profile 约束等）。`termination === (terminationMode === "verified_tree")` 与加载器的 `termination === (platform === "linux")` 之所以等价，完全依赖 schema 的不变量（darwin 必须 `best_effort`、linux 必须 `verified_tree`，sandbox-qualification-v1.ts）；服务端自己不再保证这一点。当前唯一产沙箱证据的来源是加载器（已校验），所以现在无害；但端口是公开接口，未来任何自构 `sandbox` 记录的实现都会绕过这些交叉校验。
建议：要么在 `qualificationEnforcementHolds` 补上 `sandbox.platform === qualification.platform && runtimeIdentity === \`srt:${sandbox.srtVersion}\``，要么在端口文档里写明“必须原样返回加载器产出的记录”。

**3｜低｜test/integration/sandbox-capability-qualification-lifecycle.test.ts（全文）**
问题：测试覆盖缺口（读代码证实）：
- 只测了 `activate`（211、225、248 行三个用例）；作者声称要还原的 `activateUpdate`、`rollback` 路径**一个都没测**（二者都调同一个 `qualify`，功能上间接覆盖，但改 `activateUpdate`/`rollback` 的前置条件不会被抓到）。
- 缺 `termination` 不匹配的反向用例（如 darwin `best_effort` 却报 `termination: true`，或 linux `verified_tree` 报 `false`）——新逻辑里最不对称的一条检查（`enforcement.termination === (sandbox.terminationMode === "verified_tree")`）没有正反锁定。
- 缺 legacy 分支的定向用例：无沙箱证据但 `resourceCeilings=false` 的记录必须仍被拒绝（这正是本次修复容易“顺手放宽”的地方）。现有 `governance-control-center.test.ts:227-238` 的 fixture 只把六项布尔用 `qualificationAvailable` 整组翻转，覆盖了“全假”分支，但没有钉死“仅 resourceCeilings 假”这一历史行为。
- 正面用例（211 行）在旧代码下必然失败、反向用例（225、248 行）在旧代码下本来就通过——即反向用例并不区分新旧实现；真正守住本次修复的只有第 1 个用例。测试确实跑在 CI 的 integration 项目里（`ci/policy.json:158-159` include `test/integration/**/*.test.ts`），这一点没问题。
建议：补 activateUpdate/rollback 各一条（正反各一）、termination 反用例、legacy `resourceCeilings=false` 仍拒绝的用例。

**4｜低｜test/integration/sandbox-capability-qualification-lifecycle.test.ts:179-199**
问题：作者约束说“测试不用假替身”，但测试里 `artifacts.verify` 是硬编码 stub（永远 verified），`runtime.qualify` 是内联 stub（从部署快照里查表返回）。“真实加载器 + 真实生命周期服务”属实（156-171、176 行），但“不用假替身”的说法与代码不完全一致。stub 返回加载器记录本身是合理的折衷，但应如实说明。
建议：在说明里改口为“除 artifact 校验与 runtime 端口外全部真实”，或让 artifact stub 校验 digest 至少非平凡。

## 侧重检查

我走的一条普通流程：**生产沙箱能力上线流程**——`service-main.ts:170` → `qualifyProductionWorkerDeployment`（production-worker-composition.ts:413-425）→ 快照加载器 `load()`（校验资格记录、host 绑定匹配，capability-deployment.ts `parseEntry`）→ `completeDeployment`（206-253，要求 lifecycle=active、digest 匹配）→ `isolationBackend` + `qualifyDeployment`（363-401，沙箱条目只做 `verifySandboxHostAtStartup`，其余走 live qualify）→ 记录交给 `WorkerDelegationStore`（worker-delegation-store.ts:44-53，只查 productionSuitable 与 digest）→ 执行。**结论：这条流程全程不经过 `CapabilityLifecycleService.qualify`，本次修复对它无影响也无需它；它有 `production-http-composition-process.test.ts` 等覆盖，未核实其沙箱用例细节。** 另一条流程：治理网关的能力安装→激活（governance-gateway-adapter.ts:877-912 → lifecycle.activate），这正是被修复的路径，但目前没有生产装配（见问题 1），测试覆盖只有新文件三个用例。文档侧：`.claude/rules/prompt-prefix.md`、`ports/capabilities.ts:152` 注释、`sandbox-qualification-v1.ts` 的 schema 与代码一致，未发现文档-代码矛盾。

## 必答问题

1. **不会改变模型已见过的请求开头。** 依据：改动只在能力生命周期资格检查里（registry 数据），不触碰提示组装、工具定义、历史、遮盖。`qualify` 产出的 `runtimeQualification` 与 `health.checkedAt` 只写入 registry 记录和错误消息，不进模型请求（读代码证实：`enforcement` 的消费方只有加载器与生命周期服务，`authorizedManifests` 仅测试使用，工具定义另有来源）。若某对话因此多激活一个能力，工具集合变化走规则第 6/7 条的“换新一次”机制，属已批准路径，且当前该流程无生产装配。未发现每轮变化的值被放进请求头部。
2. **无字节不确定性。** 新函数是布尔纯函数；无依赖前后文的遮盖、无新时间字段进请求、无无序集合进请求。
3. **有自动检查，反向用例成立但有缺口。** 新测试跑在 CI integration 项目；正向用例在旧代码下确实失败；两条反向用例可守住“控制为假/虚报资源上限”的拒绝，但 terminate 不匹配、activateUpdate、rollback、legacy `resourceCeilings=false` 均无用例（见问题 3）。
4. **两端核对通过，无 I-73 类问题。** 改动未产生新标识/字段/配置键；`enforcement` 的产生端（加载器 `parseQualification`）与消费端（`qualificationEnforcementHolds`）规则一致，唯一非沙箱消费端 `WorkerDelegationStore`/`completeDeployment` 只看 `productionSuitable` 与 digest，兼容。潜在弱点是服务端对新规则依据的 `sandbox` 记录校验弱于加载器（问题 2）。
5. 作者根因认定核对：`resourceMode` 仅 `observe_and_stop`（schema 确认）、`parseQualification` 要求 `resourceCeilings=false` 且 `termination === (platform==="linux")`（确认）、端口注释 “legacy enforcement booleans must remain truthful”（capabilities.ts:152 确认）、旧 `qualify` 要求六项全真导致矛盾（确认）。**作者认定成立**；但“测试不用假替身”一条与代码不符（问题 4），且“激活成功”只在 stub 端口下成立（问题 1）。
