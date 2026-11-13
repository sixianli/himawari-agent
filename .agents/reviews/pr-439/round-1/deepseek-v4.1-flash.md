## 读代码证实的问题

### 中：生产装配没有把 `CapabilityLifecycleService` 接进治理网关，这次修复在生产路径上可能不可达

- 文件：`apps/agent-service/src/production-approval-gateway.ts:200`、`packages/application/src/services/governance-gateway-adapter.ts:731`
- 问题：仓库里唯一的生产治理网关构造没有传 `capabilityLifecycle`；而 `capability.review`、`capability.install.approve`、`capability.update.respond`、`capability.rollback` 都经 `#capabilityLifecycle()`，该处没有实例就抛错。
- 证据：
  ```ts
  // production-approval-gateway.ts:200
  const controlPlane = new GovernanceGatewayV2ControlPlane({
    ownerId, agentId, authorization, capabilities, clock,
    delegate: {...},
    receipts: repository.governanceMutationReceiptStore(),
    approvalService: new ApprovalService({ store: authorization, clock }),
    grantService: new GrantService({...}),
    audit: repository.auditLedger(),
    recentAuthentication: options.recentAuthentication,
  });
  ```
  上面没有 `capabilityLifecycle`。对应地：
  ```ts
  // governance-gateway-adapter.ts:731
  #capabilityLifecycle(): CapabilityLifecycleService {
    const lifecycle = this.#dependencies.capabilityLifecycle;
    if (!lifecycle)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Capability lifecycle is not available on this gateway",
      );
    return lifecycle;
  }
  ```
- 影响：按本仓库代码，生产的能力注册/升级走 `apps/admin-cli/src/capabilities-command.ts` 的 `loadCapabilityDeploymentSnapshot` 路径，该路径本来就直接接受 `resourceCeilings: false` 的沙箱资格；本次改的 `activate`/`activateUpdate`/`rollback` 只在测试或仓库外装配里用得到。也就是说，PR 描述的“生产用户可见问题”可能不是这条路径造成的。
- 建议：确认生产是否确实规划走 `CapabilityLifecycleService`。若要走，需要把它和正确的运行时资格源接进 `production-approval-gateway.ts`，并补一条经生产网关的集成测试；若不走，应改测试/说明，避免把只对测试装配有效的修复当成生产修复。

### 中：新规则比加载器宽松，且两处用不同字段表达同一约束，存在再次漂移的风险

- 文件：`packages/application/src/services/capability-lifecycle-service.ts:762`、`packages/platform-node/src/capabilities/capability-deployment.ts:582`
- 问题：生命周期新规则只检查四个控制位、`resourceCeilings` 和 `terminationMode`；加载器还检查 `sandbox.platform === qualificationPlatform`、`runtimeIdentity === srt:<srtVersion>`。生命周期不解析 `sandboxRuntimeQualificationSchema`，因此一个被加载器拒绝的沙箱证据对象可能在生命周期这里通过。
- 证据：
  ```ts
  // capability-lifecycle-service.ts:762
  function qualificationEnforcementHolds(qualification: CapabilityRuntimeQualification): boolean {
    const { enforcement, sandbox } = qualification;
    if (!sandbox) return Object.values(enforcement).every(Boolean);
    return (
      enforcement.filesystem &&
      enforcement.network &&
      enforcement.processes &&
      enforcement.secrets &&
      !enforcement.resourceCeilings &&
      enforcement.termination === (sandbox.terminationMode === "verified_tree")
    );
  }
  ```
  ```ts
  // capability-deployment.ts:582
  if (
    sandbox &&
    (sandbox.platform !== qualificationPlatform ||
      input["runtimeIdentity"] !== `srt:${sandbox.srtVersion}` ||
      checkedEnforcement.resourceCeilings !== false ||
      checkedEnforcement.termination !== (sandbox.platform === "linux"))
  ) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
      field,
      "sandbox evidence conflicts with enforcement claims",
    );
  }
  ```
- 能通过的异常输入（按代码推算）：
  - `sandbox` 存在但 `terminationMode` 缺失或非法（例如被强转/来自未校验的持久化数据），同时 `termination: false`：新函数要求 `false === false`，通过；加载器的 schema 会先拒绝。
  - `qualification.platform = "linux"`、`sandbox.platform = "darwin"`、`terminationMode = "best_effort"`、`termination: false`：新函数通过；加载器在 `sandbox.platform !== qualificationPlatform` 处拒绝。
  - 沙箱证据挂在 `manifest.isolation !== "sandbox"` 的能力上：生命周期函数没有 binding/isolation 上下文，仍可能通过；加载器对非 sandbox binding 会拒绝。
- 建议：不要在 application 层重写一遍与加载器等价的规则。把“沙箱证据与 enforcement 是否一致”抽成一个共享的导出判定/校验（最好放进 `execution-contracts`，或由 `sandboxRuntimeQualificationSchema.parse` 加显式一致性检查实现），加载器和 `qualificationEnforcementHolds` 共用；如保留本地实现，至少补 `sandbox.platform === qualification.platform`、`runtimeIdentity === srt:<srtVersion>`，并考虑把 `manifest` 传进来要求 `manifest.isolation === "sandbox"`。这也是 I-73 的教训：一个值只在产生端校验，使用端会漂移。

### 中：新测试没有覆盖新规则的 `termination` 分支、非沙箱分支以及 `activateUpdate`/`rollback`

- 文件：`test/integration/sandbox-capability-qualification-lifecycle.test.ts:210`
- 问题：三个用例都只调用 `lifecycle.activate(REF)`，没有 `activateUpdate`、`rollback`；也没有 construction `termination` 不一致的用例；也没有“没有 sandbox 时仍要求六项全真”的反向用例。
- 证据：
  ```ts
  // 211
  it("activates a capability whose sandbox evidence honestly reports no kernel resource ceiling", ...)
  // 220
  const active = await lifecycle.activate(REF);
  // 244
  await expect(lifecycle.activate(REF)).rejects.toThrow("runtime qualification failed");
  // 266
  await expect(lifecycle.activate(REF)).rejects.toThrow("runtime qualification failed");
  ```
  三个用例中没有任何 `activateUpdate` / `rollback`，也没有 `termination` 相关变体。
- 影响：
  - 如果实现把 `enforcement.termination === ...` 这一行删掉，现有三个测试仍会全部通过，`termination` 约束实际没有被守住。
  - 如果实现把“没有 sandbox 时要求六项全真”改成“没有 sandbox 直接通过”，现有测试也不会失败。
  - “四个控制位为 false 时拒绝”在旧代码上本来就会拒绝，因此它不是新规则的回归用例；真正能证明修复的是“激活成功”和“resourceCeilings 虚报被拒”两条（按代码推算，旧代码下这两条会分别失败/误通过）。
- 建议：补四个反向用例：Linux 沙箱 `termination: false` 拒绝、Darwin 沙箱 `termination: true` 拒绝、无沙箱证据但任一 enforcement 为 false 拒绝、沙箱 `platform` 与 `qualification.platform` 不一致拒绝；再补沙箱能力的 `activateUpdate` 和 `rollback` 成功各一条。若担心规则再次和加载器漂移，再加一条直接跑真实加载器的 `resourceCeilings: true + sandbox` 拒绝用例。

### 低：加载器自己的“沙箱证据与 enforcement 冲突”规则没有直接反向测试

- 文件：`packages/platform-node/test/capability-deployment.unit.test.ts:491`
- 问题：现有测试只覆盖了“沙箱证据 + process binding”和“无沙箱 + termination false”。没有直接覆盖 `sandbox + resourceCeilings: true`、`sandbox.platform` 与 `qualification.platform` 不一致、`termination` 与平台不一致。
- 证据：
  ```ts
  it("does not use Mac sandbox evidence to relax legacy enforcement", async () => {
    const entry = sandboxEntry();
    entry["binding"] = processEntry()["binding"];
    ...
    (qualification["enforcement"] as JsonObject)["termination"] = false;
    ...
  ```
- 建议：在加载器测试里补上述三种冲突用例，这样“加载器语义是权威”的判断本身也有自动检查，而不是只靠生命周期测试绕过加载器后模拟。

### 低：测试的 `PLATFORM` 兜底把非 Darwin 平台都当成 Linux

- 文件：`test/integration/sandbox-capability-qualification-lifecycle.test.ts:13`
- 问题：`const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";`，而加载器用 `platformName(process.platform)`，非 Darwin/Linux 会得到 `"other"`。在 Windows/FreeBSD 等环境跑这个集成测试会因平台不匹配失败。
- 建议：让夹具和加载器使用同一个平台推导，或明确 `skipIf` 非 Linux/Darwin。当前 CI 是 Linux，影响很小。

## 推测

- “生产是否另有仓库外代码注入 `capabilityLifecycle`”未核实；本仓库内只能证实 `production-approval-gateway.ts` 没有注入。
- 新规则会让“实际管控不足但带沙箱标记”的记录通过，前提是 `CapabilityRuntimeQualifierPort` 能返回未经加载器校验的 sandbox 对象；如果生产只把 `loadCapabilityDeploymentSnapshot` 的结果当资格源，这个风险主要停留在防御性校验层面，而不是当前可触发的漏洞。
- 作者说“还原修复后激活成功和拒绝虚报资源上限两条失败”是按代码推算成立：旧代码要求六项全真，因此诚实的 `resourceCeilings: false` 会失败；而虚报 `resourceCeilings: true` 反而会被旧代码放过。未实际运行测试。

## 侧重检查

- **错误路径**：`qualificationEnforcementHolds` 是纯函数，不新增 I/O、不抛业务错误；`qualification` 或 `enforcement` 缺失时仍会像旧代码一样因属性访问报错，没有新增静默路径。`activate`/`activateUpdate`/`rollback` 都是在 `qualify` 成功后才写状态，失败不会留下半写记录。
- **不合规范/不可信输入**：这是本次最需要补的。生命周期没有对 `sandbox` 做 schema 校验，`terminationMode` 缺失/非法且 `termination:false` 会被当成“没有 verified_tree，所以要求 termination=false”而通过；加载器会拒绝。读代码证实的是“规则更宽”，是否能被真实输入触发取决于资格端口是否还经过加载器，标为推测。
- **安全**：没有新增密钥、日志或权限面。唯一安全相关点是放宽 enforcement 的依据只有“`sandbox` 字段存在”，而生命周期不掌握 binding；若未来有别的资格实现，可能把沙箱证据附到非沙箱能力上。加载器当前用 `binding.kind === "sandbox"` 挡住大部分，但生命周期自身没有这一层。
- **资源耗尽**：没有新增循环、递归或大对象复制；新测试写的是小 JSON 快照，`afterEach` 递归删除临时目录，加载器本身有 `maximumBytes` 上限。
- **不可撤销操作**：激活/更新/回滚仍是原有原子状态转换，新谓词只决定是否允许进入；没有新增不可逆副作用。
- **规则/文档一致性**：作者三条事实基本核对为真：加载器确实要求沙箱记录 `resourceCeilings === false`、`termination` 与 Linux 对齐（`capability-deployment.ts:582-593`）；`resourceMode` 只有 `observe_and_stop`（`sandbox-qualification-v1.ts:52`）；端口注释写着 “legacy enforcement booleans must remain truthful”（`ports/capabilities.ts:152`）。没有发现文档仍写“六项全真”的冲突。但代码把同一约束写成两套表达式（`platform === "linux"` 对 `terminationMode === "verified_tree"`），这是 I-73 式“同一值只在一端认”的复发风险。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 diff 只改能力资格判定和一个测试，没有碰系统提示、工具定义、历史消息、遮盖或序列化。新逻辑没有引入每轮变化的值，也没有把新字段放进请求头。唯一间接影响是：以前激活失败的能力现在可能激活成功，从而在未来某轮改变可用工具集合；这属于现有“工具集合变了就按规则换新一次”的范畴，不是本改动新增的逐轮变化，也没有破坏“只在末尾追加”的既有约束。结论：不涉及模型请求内容。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。改动是纯布尔判定，不生成或改写文本，不依赖时间、前后文、遮盖密钥、集合遍历顺序或序列化顺序。存储下来的 `runtimeQualification.sandbox` 是既有结构；`checkedAt` 本来就有，且不参与本判定。结论：没有引入非确定性字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。新文件在 `test/integration/**/*.test.ts`，会被 `ci/policy.json` 的 `integration` 项目包含，而 CI 的 `coverage` job 跑 `integration`。按代码推算：恢复旧实现后，“激活成功”会失败，“`resourceCeilings: true` 被拒”会因旧实现反而接受而失败；但“四个控制位 false 被拒”在旧实现下也通过，不是新规则的回归保护。缺少 `termination` 分支、非沙箱分支、`activateUpdate`/`rollback` 和加载器冲突规则的反向用例，见上面“中”级测试问题。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   本次没有新增标识、配置键、清单项或序列化格式；新“产生”的只是以前被拒绝的既有 `runtimeQualification.sandbox` 记录。逐个核对消费端：
   - `capability-lifecycle-service.ts:633` 的 `authorizedManifests` 只要求 `productionSuitable === true`，接受；
   - `governance-gateway-adapter.ts:460-467` 只投影 platform/runtimeIdentity/productionSuitable/reasonCodes/checkedAt，不接受 sandbox 细节，不会因此拒绝；
   - `apps/execution-worker/src/worker-delegation-store.ts:44-53` 只要求 active、`productionSuitable === true`、`artifactDigest` 匹配，接受；
   - `apps/execution-worker/src/production-worker-composition.ts:225-228` 同样只校验 `productionSuitable` 和 `artifactDigest`，接受；
   - `production-worker-composition.ts:376-379` 和 `production-sandbox-services.ts:191-201` 对沙箱记录直接取 `qualification.sandbox` 并交给 `verifySandboxHost` 重新解析和核对宿主，接受；
   - `production-sandbox-control.ts:504-505、544-547` 按 `terminationMode` 决定清理语义，已存在且接受；
   - `capability-runner-upgrade.ts:258` 从加载器原样复制资格，早已接受同一结构。
   没有发现要求沙箱记录必须 `resourceCeilings: true` 的消费端。真正的“两端不一致”是生产治理网关没有接入生命周期服务，导致这些新通过的值到不了生产网关，见第一条问题。
