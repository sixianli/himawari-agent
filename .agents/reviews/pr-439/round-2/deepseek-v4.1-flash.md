## 发现（按严重度从高到低）

### 1. 中：`qualify` 仍比加载器宽——没有核对宿主平台，也没有核对沙箱证据与绑定的身份是否一致

- 文件:行：`packages/application/src/services/capability-lifecycle-service.ts:773-776`，`packages/execution-contracts/src/sandbox-qualification-v1.ts:117-122`
- 问题：生命周期只要求 `qualification.platform === sandbox.platform`（再加 runtimeIdentity、resourceCeilings、termination 和四项管控），没有核对 `qualification.platform` 是否等于**当前宿主平台**，也没有核对 `sandbox.hostId/profileRef/runtimeDigest/runnerDigest` 是否对得上部署绑定。
- 证据（读代码证实的）：
  - `capability-lifecycle-service.ts:773-776` 只有 `manifest.runtime.kind === "program" && sandboxEnforcementClaimsMatchEvidence(...) && sandboxRequiredControlsEnforced(...)`。
  - `sandbox-qualification-v1.ts:117-122` 只比较 `sandbox.platform === claims.platform`、runtimeIdentity、`resourceCeilings === false`、`termination === (sandbox.platform === "linux")`。
  - 加载器则会先要求 `qualificationPlatform === platform`（`capability-deployment.ts:542-548`），随后在 `parseEntry` 要求 `sandbox.hostId/profileRef/runtimeDigest/runnerDigest` 与 sandbox 绑定一致（`capability-deployment.ts:1158-1169`）。
- 后果（推测，基于以上代码）：如果运行时资格端口返回一份“自洽但来自另一台主机/另一个平台”的沙箱证据，生命周期会接受；同样的记录直接走加载器会被拒。当前测试里资格端口返回的是加载器读出的记录，所以测试路径暂时碰不到；但真正接线时如果资格端口不是加载器本身，这就是仍然存在的一处放宽。
- 建议：把宿主平台和绑定摘要也作为参数传入共用校验，或让资格端口只返回加载器已绑定过的资格记录并在生命周期侧核对其绑定摘要；否则“两边共用一条规则”只是部分对齐。

### 2. 中：回滚走重新资格判定，未使用已持久化的 `rollbackQualification`；收紧规则后可能挡住回滚

- 文件:行：`packages/application/src/services/capability-lifecycle-service.ts:559-562`、`599`、`606`，`packages/execution-contracts/src/sandbox-qualification-v1.ts:44`、`112`
- 问题：回滚没有使用持久化的 `rollbackQualification`，而是对回滚清单重新调用 `runtime.qualify`。如果新的资格判定比旧版严格（本 PR 正是收紧），或 `SANDBOX_RUNTIME_VERSION` 升级后旧证据无法重新通过 schema，回滚这条恢复路径可能失败，系统停留在新版本。
- 证据（读代码证实的）：
  - 激活更新时确实写入了 `rollbackQualification: current.runtimeQualification`（`capability-lifecycle-service.ts:562`）。
  - 但回滚时执行的是 `const qualified = await this.qualify(rollback);`（`599`），然后写入 `runtimeQualification: qualified.qualification`（`606`）。
  - 全仓库检索没有发现对 `rollbackQualification` 的读取，只有写入和测试夹具；它目前是只写字段。
  - `sandboxEnforcementClaimsMatchEvidence` 会重新解析证据（`sandbox-qualification-v1.ts:112`），而 schema 把 `srtVersion` 固定为当前常量（`sandbox-qualification-v1.ts:44`，当前 `0.0.81`）。
- 对你第 3 句问题的直接回答：**当前回滚不会重新解析已持久化的资格，因为根本没用它**；因此不会因“重新解析旧证据”被错误拒绝。但如果将来改为使用持久化资格，或资格端口返回旧证据，SRT 版本变化后会被重新解析拒绝。现在真正的风险是回滚依赖“当前资格端口能再次给出同样的证据”，这没有测试覆盖跨版本场景。
- 建议：回滚显式使用并校验持久化的 `rollbackQualification`（或在当前规则下重新验证它），并补一条“旧 SRT 版本资格记录在版本升级后回滚”的用例。

### 3. 低：新增“证据不合契约”用例没有真正隔离重新解析逻辑

- 文件:行：`test/integration/sandbox-capability-qualification-lifecycle.test.ts:314-326`
- 问题：这个用例同时把 `enforcement.termination` 改成 `!linux`，又改坏 `terminationMode`。即使把共用函数里的 `sandboxRuntimeQualificationSchema.parse(evidence)` 删掉（不做重新解析），仅凭 termination 与平台不一致也会被拒（`sandbox-qualification-v1.ts:121`），所以这个用例不能证明“先按契约解析证据”存在。
- 证据（读代码证实的）：测试第 317-324 行同时改 `termination: !linux` 和 `terminationMode: linux ? "best_effort" : "verified_tree"`；而共用函数的 termination 判断只要求 Linux 为 true、Darwin 为 false。
- 建议：保留 enforcement 不变，只构造一个“四项比较都通过、但 schema 不接受”的证据，例如删掉一个必需 guarantee、制造重复 guarantee 或加未知字段。这样去掉重新解析时用例才会失败。

### 4. 低：新增的 `manifest.runtime.kind === "program"` 和 `sandbox === null` 收紧都没有用例

- 文件:行：`packages/application/src/services/capability-lifecycle-service.ts:771`、`774`
- 问题：删掉 `manifest.runtime.kind === "program"` 或改回 `if (!sandbox)`，现有测试都不会失败。集成测试里的清单固定为 `kind: "program"`（`test/integration/sandbox-capability-qualification-lifecycle.test.ts:69`），没有任何 mcp 或 `sandbox: null` 用例。
- 证据（读代码证实的）：`qualificationEnforcementHolds` 的新分支只在 `774` 和 `771`；测试文件只有 program 清单。
- 建议：补一条带 mcp 清单 + 沙箱证据被拒的用例，以及一条 `sandbox: null` 不再走六项全真分支的用例。

### 5. 低：部分新用例在旧代码（第 1 轮 `5cec2fab`）下也会通过，不能证明本轮新检查

- 文件:行：`test/integration/sandbox-capability-qualification-lifecycle.test.ts:237-261`、`263-280`、`299-304`、`329-338`；`packages/platform-node/test/capability-deployment.unit.test.ts:506-542`
- 问题（静态推演，未运行测试）：
  - 第 1 轮生命周期已经检查 resourceCeilings、termination、四项管控；因此“更新激活并回滚”“更新虚报资源上限”“终止声明矛盾”“无沙箱证据仍要求六项”在 `5cec2fab` 下都会通过。
  - 加载器 4 条新增反向用例在旧加载器下也会通过——因为旧加载器本来就有平台、runtimeIdentity、resourceCeilings、termination 四项检查，本轮只是把它们抽成共用函数。它们能防重构回归，但不能证明“加载器行为有变化”。
  - 真正能在第 1 轮旧代码下失败的新用例只有：平台/runtimeIdentity 对不上（`306-312`）和“证据不合契约”（`314-326`，但见第 3 条它并不隔离重新解析）。
- 建议：在评审说明中区分“防止过紧导致误拒”的正向用例和“证明新增检查”的反向用例；至少给 `runtime.kind`、null 沙箱和重新解析各补一条在旧代码下必然失败的用例。

## 侧重检查

- **错误路径**：共用函数把 `ContractValidationError` 转成 `false`，非契约异常继续抛出（`sandbox-qualification-v1.ts:113-116`）。生命周期里这会把错误统一变成 `NOT_AUTHORITATIVE`，可接受；加载器里因为证据已先被解析，这个 catch 实际不可达。
- **不合规范/不可信输入**：加载器对沙箱证据先 schema 解析再比对，未知字段、缺失 guarantee、平台与 terminationMode 矛盾都会被拒。生命周期复用同一 schema，但只校验证据自身和 claims 的一致性，不校验证据与部署绑定/宿主平台一致（见发现 1）。
- **安全**：把“声明是否可信”的判定放进 `execution-contracts` 并由两个调用方共用，方向正确；但生命周期没有绑定上下文，仍不能完全复现加载器的信任边界。
- **资源耗尽**：`sandboxRuntimeQualificationSchema` 的 `guarantees`/`limitations` 数组没有长度上限（`sandbox-qualification-v1.ts:53-54`），生命周期现在会重新解析运行时端口提供的证据。加载器路径受快照 8 MiB 上限约束（`capability-deployment.ts:31`），运行时端口路径没有证据表明有上限；属于推测性风险，当前端口是内部受信代码。
- **不可撤销/恢复操作**：激活更新和回滚没有新的不可逆外部副作用；但回滚依赖重新资格判定，见发现 2。
- **规则/文档/代码一致性**：`.claude/rules/prompt-prefix.md` 未涉及本改动；本次 diff 没有改提示词目录或请求组装。作者所说“生产治理网关没有传 `capabilityLifecycle`”已核对：`apps/agent-service/src/production-approval-gateway.ts:200-205` 构造控制面时没有该依赖，`governance-gateway-adapter.ts:731-738` 缺失时直接抛 `INVALID_OPERATION`。
- **未核实**：`.agents/reviews/pr-439/round-1/judgments.md` 不在当前稀疏检出中，无法读取上一轮逐条判断；测试未实际运行，测试相关结论均为静态推演。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。依据 [prompt-prefix.md:35](../../.claude/rules/prompt-prefix.md#append-only) 的只追加要求，以及 [prompt-prefix.md:41](../../.claude/rules/prompt-prefix.md#stable) 的工具冻结要求：本 diff 只改能力部署/资格判定，没有改系统提示、工具定义、历史消息或遮盖；`packages/prompt-catalog`、`packages/runtime-pi` 均未涉及，资格字段也没有进入模型请求。能力集合变化会按既有规则触发一次换新，不是每轮变化。没有发现新增“每轮会变的值”；也没有证据显示本改动会把任何请求开头改写。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

不会。改动不产生或改变模型可见的序列化内容；共用函数只返回布尔值，不输出文本/JSON。`Object.values(enforcement)` 只用于判定，且其键顺序由固定对象字面量决定；`Set` 只用于重复检测，不参与输出。没有引入时间、随机数或依赖前后文的遮盖。

**3. 有没有对应自动检查，反向用例真的会失败吗？**

有：集成测试 `test/integration/sandbox-capability-qualification-lifecycle.test.ts`（12 条）和加载器单测 `packages/platform-node/test/capability-deployment.unit.test.ts`（新增 4 条）。但：
- 平台/runtimeIdentity 用例（`306-312`）在第 1 轮代码下会失败，是有效的反向用例。
- “证据不合契约”用例（`314-326`）不能隔离重新解析逻辑（发现 3）。
- `runtime.kind === "program"`、`sandbox === null` 没有用例（发现 4）。
- 加载器 4 条和第 1 轮已有的检查重复，在旧加载器下也通过（发现 5）。
- 测试未运行，以上为静态推演。

**4. 改动产生/修改的每个值，使用方都能接受吗？逐个核对两端**

- `qualification.platform`、`runtimeIdentity`、`enforcement`、`sandbox` 的产生端：
  - 加载器 `parseQualification` 生成并校验（`capability-deployment.ts:628-646`）；
  - 隔离后端生成无 sandbox 的资格（`isolation.ts:264-291`），其 identity 形如 `linux-bubblewrap-0.11.2+prlimit`，与本规则期望的 `srt:<version>` 不同，但它不携带 sandbox，因此走六项全真分支。
- 使用端：
  - 生命周期 `qualify` 校验 productionSuitable、artifactDigest、enforcement（`capability-lifecycle-service.ts:662-665`、`766-777`）；
  - 治理网关只投影 `platform/runtimeIdentity/productionSuitable/reasonCodes/checkedAt`（`governance-gateway-adapter.ts:460-467`）；
  - 执行 worker 组合和 worker store 只校验 `productionSuitable` 与 `artifactDigest`（`production-composition.ts:226-227`、`worker-delegation-store.ts:46-47`）。
- 结论：本改动没有新增字段、配置键、清单项或序列化格式，现有使用端都接受这些值。需要留意的是 `runtimeIdentity` 的语义只对“带 SRT 沙箱证据”的资格要求 `srt:<version>`；将来若把隔离后端的 identity 与沙箱证据混用，生命周期会拒绝，这是发现 1/接线层面需要确认的约束。

## 作者说法核对

- “新增两个共用函数、加载器改调、行为没变”：已核对，加载器接受/拒绝结果、错误码和错误字段均未变（证据：`capability-deployment.ts:584-611` 与旧逻辑等价；证据已先解析，共用函数重新解析是幂等的）。
- “qualify 改调共用函数并要求 `runtime.kind === "program"`”：属实（`capability-lifecycle-service.ts:766-777`）；但仍比加载器少了宿主平台和绑定身份校验（发现 1）。
- “已知不在本 PR 范围：生产网关没传 capabilityLifecycle”：属实，已核对生产构造点。
- “共 12 条集成 + 4 条加载器用例”：数量属实；但测试的鉴别力问题见发现 3、4、5。
