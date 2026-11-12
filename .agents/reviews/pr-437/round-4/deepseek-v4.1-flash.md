## 一、读代码证实的问题

### 1. 严重度：中 — 「现场检查通过后才写记录」的自动测试没有真正覆盖「绑定成功、检查失败」这条路径

**文件:行**：`apps/execution-worker/test/service-main.unit.test.ts:33-38`、`:239-264`；`apps/execution-worker/src/service-main.ts:167-183`；`docs/adr/0254-capability-reactivation-is-one-atomic-command.md:121`

**问题**：新增测试把 `qualifyProductionWorkerDeployment` 替换成立即成功的桩，只证明「agent 绑定写出来之前读不到记录」；它没有让「绑定成功、现场检查失败」发生。若实现改成 `waitForAgentBinding` 成功后立即写记录、不等现场检查，这个测试仍会通过。另一个「启动失败不写记录」的用例里，qualification 因配置缺 `capabilityDeployment` 直接失败，但 agent 绑定也超时，两者同时失败，无法单独证明顺序。

**证据**：

```ts
// service-main.unit.test.ts:33-38
qualification.started += 1;
if (qualification.admittedSnapshotDigest)
  return Promise.resolve({
    deployment: { snapshotDigest: qualification.admittedSnapshotDigest, manifests: [] },
    isolation: {},
  } as unknown as ...);
return actual.qualifyProductionWorkerDeployment(options);
```

```ts
// service-main.unit.test.ts:262-264
await expect(readWorkerQualifiedDeployment(layout)).rejects.toMatchObject({
  code: "STATE_ROOT_BOOT_BINDING_INVALID",
});
```

```ts
// service-main.ts:167-183
const [binding, qualified] = await bindingThenQualification(...);
publishedLayout = layout;
await writeWorkerQualifiedDeployment(layout, {...});
```

ADR 第 121 行称该文件保证「现场检查没通过时没有记录」，这一说法比测试实际覆盖强。

**建议**：增加一个用例：让 `qualifyProductionWorkerDeployment` 返回 rejected（或延迟后 rejected），同时正常写入 `writeAgentServiceBootBinding` 让绑定成功；断言记录始终不存在且进程返回 1。这样才能真正锁住「检查通过之后才写」的顺序。

---

### 2. 严重度：中 — 新增的 16384 字节上限没有测试，启动绑定也受影响但没有反向用例

**文件:行**：`packages/platform-node/src/state-root-layout.ts:393-406`

**问题**：`readWorkerRuntimeRecord` 新增 `WORKER_RUNTIME_RECORD_MAX_BYTES = 16_384`，并同时用于启动绑定和新的 qualified 记录。现有测试只覆盖了权限 0644 不可读，没有覆盖超大文件；如果删掉上限，没有任何测试会失败。启动绑定如果被一个超大文件替换，行为也从「可读」变成「拒绝」，但也没有测试。

**证据**：

```ts
const WORKER_RUNTIME_RECORD_MAX_BYTES = 16_384;

async function readWorkerRuntimeRecord(file, fields, label) {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 || info.size > WORKER_RUNTIME_RECORD_MAX_BYTES) {
    throw new StateRootLifecycleError(
      STATE_ROOT_ERROR_CODES.BOOT_BINDING_INVALID,
      `${label} is missing or unsafe`,
    );
  }
```

**建议**：为 qualified 记录和启动绑定各加一条 `size = 16_385` 的拒绝用例，再加一条恰好 16_384 或更小的通过用例。

---

### 3. 严重度：低 — 正常停止删除记录没有自动测试（作者已承认）

**文件:行**：`apps/execution-worker/src/service-main.ts:225-229`；`docs/adr/0254-...md:121`

**问题**：`server.stop()`、`composition.close()` 之后调用 `clearWorkerQualifiedDeployment(layout)`，这条路径没有测试。作者在材料中也承认，ADR 也把它列在未知覆盖里。这不是代码错误，但意味着「正常停止后 agent-service 重新启用会失败」这个行为没有回归保护。

**证据**：

```ts
await server.stop();
await composition.close();
composition = undefined;
await clearWorkerQualifiedDeployment(layout);
writeServiceDiagnostic(output, { component: "execution-worker", event: "service.stopped" });
```

**建议**：与新增的启动失败用例类似，加一个收到终止信号后断言记录被删除的测试；如果进程级信号难测，至少把 `clearWorkerQualifiedDeployment` 的调用抽成可在单元测试里观察的行为。

---

### 4. 严重度：低 — 崩溃恢复重放分支没有反向用例；`deploymentId` / `workerInstanceId` 不一致也没有用例

**文件:行**：`packages/application/src/services/governance-gateway-adapter.ts:1040-1053`、`:703-714`；`test/integration/production-capability-reactivation.test.ts:431-464`

**问题**：

- 现有「重放幂等」测试第二次请求时收到的收据已经是 `completed`，会走 `#begin` 的提前返回（`governance-gateway-adapter.ts:710-714`），并没有走到 `#reactivateCapability` 里为「崩溃后收据仍为 executing」准备的重放分支：
  ```ts
  if (recovering && current.revision === command.payload.expectedRevision + 1 &&
      current.lifecycle === "active") {
    return this.#capabilityResult(current);
  }
  ```
  如果这个分支写错（例如条件永远不满足），现有测试不会失败。
- `production-capability-reactivation.ts:41-46` 同时检查 `workerBootId`、`workerInstanceId`、`deploymentId`；现有测试只覆盖了 `workerBootId` 不一致，后两者没有反向用例。

**建议**：参照 `test/integration/governance-control-center.test.ts` 中 disable/rollback 的 `interruptAfterMutation`，给 reactivate 加一个「变更已写入、收据未完成」后重放的用例；再给 qualified 记录的 `workerInstanceId`、`deploymentId` 不一致各加一条拒绝用例。

---

## 二、推测 / 需要进一步核实的问题

### 5. 严重度：低（推测）— 异常终止后旧记录可能残留，使重新启用通过但执行进程已死

**文件:行**：`apps/execution-worker/src/service-main.ts:165`、`:228`、`:234-235`；`apps/agent-service/src/production-capability-reactivation.ts:38-48`

**问题**：记录在启动时和优雅停止时删除，但 SIGKILL / 崩溃不会走删除逻辑。崩溃后旧记录的 `workerBootId` 仍是 agent-service 启动时读取的 `peerBinding.workerBootId`，重新启用可能通过，而执行进程已经不存在。ADR 只写了「快照和公布只证明启动时检查通过」，没有写「进程当前仍活着」。这是否可接受取决于 agent-service 是否在 worker 失联时立即停止或清除 peer binding；这一点我没有继续追到值守/断连逻辑，标为未核实。

**建议**：在 ADR 的「局限」里明确写出这一窗口；或者让 agent-service 在 worker 断连时把 peer binding 标记失效，重新启用时连同记录一起拒绝。

### 6. 严重度：低（推测）— `readWorkerRuntimeRecord` 存在 lstat/readFile 之间的 TOCTOU 和符号链接替换窗口

**文件:行**：`packages/platform-node/src/state-root-layout.ts:400-420`

**问题**：读取时先 `lstat(file)` 检查，再用 `readFile(file, "utf8")` 按路径读；两者之间文件可被替换成符号链接或另一个文件。旧启动绑定读取也有同样模式，但新记录现在被用于决定「重新启用」的授权，因此风险面扩大了。实际利用需要与 agent-service 同账号写运行目录，威胁等级有限。相比之下 `readSnapshotBytes` 使用了 `O_NOFOLLOW` 并在打开后重新 `stat` 比较，做得更完整。

**建议**：qualified 记录也改用 `open(..., O_NOFOLLOW)` + `fstat` + 有界读取，保证检查的字节就是校验的字节。

### 7. 严重度：极低 — 「启动绑定行为不变」与「16384 上限共用」在严格意义上有冲突

**文件:行**：`docs/adr/0254-...md:81-82`；`packages/platform-node/src/state-root-layout.ts:393-406`

ADR 第 81 行说启动绑定的格式和写入时机不变，第 82 行又写读时拒绝超过 16384 字节的文件；材料则同时说「重构后启动绑定的行为不变」和「16384 上限（启动绑定共用，同样生效）」。对正常大小的启动绑定确实无影响，但对超大文件读取行为已改变。建议把「行为不变」限定为格式、写入时机和正常大小文件。

---

## 三、侧重检查

- **错误路径**：逐条核对了快照读不出、摘要不符、能力不在快照、执行进程未公布、启动编号不符、公布的是另一份快照；`reactivate` 在任一检查失败时都在 `save` 之前抛错，能力记录不变（`capability-lifecycle-service.ts:628-643`），集成测试对每个失败分支都有断言且都检查 `stillDisabled()`。
- **不合规范或不可信的输入**：快照读取走 `readSnapshotBytes`，校验普通文件、非符号链接、权限 0700/0600、属主、大小，并使用 `O_NOFOLLOW` 和有界读取（`capability-deployment.ts:1298-1344`）。qualified 记录读取校验普通文件、符号链接、组/其他人权限、属主、大小、JSON、多余字段（`state-root-layout.ts:395-440`）。`snapshotDigest` 在写入和读取两端都按 `^sha256:[0-9a-f]{64}$` 校验。未覆盖的是上面的 TOCTOU 和符号链接替换窗口。
- **安全**：最近认证在创建收据之前检查（`governance-gateway-adapter.ts:622-638`）；测试确认认证失败时收据不存在（`production-capability-reactivation.test.ts:306-316`）。没有核验入口时命令不进已安装清单，网关返回 `PORT_OPERATION_NOT_INSTALLED`。重新启用只写 `lifecycle/revision/updatedAt`，不恢复执行句柄和定时任务（`capability-lifecycle-service.ts:642`；gateway 自身也没有撤销或创建句柄的代码路径）。
- **资源耗尽 / 不可撤销操作**：快照和 qualified 记录读取都有大小上限；重新启用可再次停用，属于可逆治理操作；没有迁移、没有删除业务数据。正常停止删除的是一个小的运行记录文件。
- **规则 / 文档 / 代码一致性**：ADR 0254、architecture-v0.1、i18n 文案和代码基本一致；界面文案只说「核对安装包和上线时的检查结果」，没有写「已重新检查运行环境」。材料中「执行进程写出记录之后启动失败……没有自动测试」与代码不一致：本 PR 已经加了该测试（尽管使用了替身）。
- **清单项 id 的后端校验**：`capability.reactivate` 已同时出现在 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`GOVERNANCE_COMMAND_TYPES`、`#mutate` switch、最近认证前置列表、生产已安装操作列表、control-center inventory、UI action、i18n 和三份测试中；`scripts/check-operations.mjs` 要求的后端实现、前端调用方和测试三处都存在。手机端能力表不在本仓库，按 ADR 属后续任务，未核实。

---

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会（就本 diff 而言）。** 本次改动只涉及治理命令、能力生命周期、运行目录文件和 control-center，没有改 `packages/prompt-catalog`、`packages/runtime-pi`、工具定义、历史消息或出口遮盖逻辑；因此发给模型的内容仍然只在末尾追加，每轮会变的值没有进入系统提示或工具定义。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。

需要说明的是：重新启用会让能力在后续请求中可能重新可用，若因此新增执行句柄类工具，会触发既有的「工具集合变化则换新一次」规则（规则 6/7），那是该规则已有的行为，不是本 diff 修改提示词组装。仓库内没有找到 `authorizedManifests()` 在生产工具组装路径中的直接使用（只在测试里使用），所以这一点未核实到实际影响。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**没有发现。** 新增的 qualified 记录是固定键顺序的 `JSON.stringify`，字段只有 `schemaVersion`、`workerInstanceId`、`workerBootId`、`deploymentId`、`snapshotDigest`，没有时间戳；快照成员检查用 `.some()` 只产生布尔结果，不参与序列化；`reasonCode` 是常量。审计记录里仍有 `occurredAt`，但审计不属于发给模型的内容。没有新增依赖前后文的遮盖、无序集合或带时间的模型可见字段。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**大部分有，但有上述缺口。**

有自动检查且反向用例确实会失败的部分：

- 最近认证失败不留收据：如果去掉 `#authenticateBeforeFirstReceipt` 里的 reactivate 分支，收据会被 `#begin` 创建，`production-capability-reactivation.test.ts:313-315` 会失败。
- 快照摘要不符、快照不可读、能力不在快照、未公布记录、记录不安全、启动编号不符、公布的是另一份快照：每条都会在对应检查去掉后变成成功，测试断言会失败。
- 没有装配核验入口时命令不安装：如果 `capabilityReactivationAvailable` 逻辑错误地把命令装上，`PORT_OPERATION_NOT_INSTALLED` 断言会失败。
- 已停用直接 `activate` 仍被拒绝、已激活重复重新启用被拒绝、陈旧修订号被拒绝、不恢复句柄和定时任务、审计只写一条、重放不重复写：都有对应断言。

**缺口**：

- 「绑定成功、现场检查失败不写记录」没有反向用例（问题 1）。
- 16384 字节上限没有反向用例（问题 2）。
- 正常停止删除记录没有自动测试（问题 3，作者已承认）。
- 崩溃恢复重放分支、`deploymentId` / `workerInstanceId` 不一致没有反向用例（问题 4）。
- 作者材料说「写记录之后启动失败、catch 删记录」没有自动测试，但本 PR 的 `service-main.unit.test.ts:239-285` 已覆盖该路径（使用替身）；材料说法与代码不一致。

### 4. 每个产生或修改的值，使用它的地方都能接受吗？

逐项核对结果：

- **`capability.reactivate` 命令类型**：产生于 `packages/gateway-contracts/src/contracts-v2.ts:95,1928-1936,2672`；被 `governance-gateway-adapter.ts:65,86,629,751`、`production-approval-gateway.ts:73-75,286-288`、`production-http-composition.ts:698,1208`、`control-center-inventory.ts:227`、`governance-control-center.tsx:42,176,209-210,245,783-791`、i18n 资源和测试使用。契约、后端 switch、最近认证列表、已安装清单、页面操作过滤和测试都能接受。
- **`workerInstanceId` / `workerBootId` / `deploymentId`**：worker 写启动绑定时产生，agent-service 读启动绑定时落成 `peerBinding`；qualified 记录用同一组值；verifier 同时和 `trustedPeerBinding()` 与 `configuration.deploymentId` 比较（`production-capability-reactivation.ts:41-46`）。两端校验一致。
- **`snapshotDigest`**：worker 从部署快照加载器的 `qualified.deployment.snapshotDigest` 取得（`production-worker-composition.ts:418-424`，加载器在 `capability-deployment.ts:1427,1458` 计算），写入时用 `SNAPSHOT_DIGEST` 校验，读取时再次校验，配置端 `strict-configuration.ts:205` 也用同一格式；verifier 与 `deployment.sha256` 比较。两端一致。
- **`capabilityDeployment` 配置键**：已存在的 `parseCapabilityDeploymentConfiguration`（`strict-configuration.ts:211-218`）产生，verifier 读取 `snapshotPath` / `sha256`；没有新增格式。
- **`capabilityReactivationAvailable`**：由 `options.capabilityReactivation !== undefined` 产生（`production-http-composition.ts:1152`），同时用于网关已安装清单和 config 接口清单（`:698`, `:1208`），两处接受同一个布尔值。
- **`CAPABILITY_REACTIVATION_REASONS` 原因码**：被放进 `ApplicationPortError.details.reasons`，消费方只把它当字符串拼接（`capability-lifecycle-service.ts:635-640`），测试按字符串断言，没有额外校验限制。
- **运行目录新文件 `execution-worker.qualified.json`**：只在 `state-root-layout.ts` 内产生、读取、删除；没有发现其他启动脚本或清理脚本枚举该目录并要求固定文件集合。上线脚本读取的仍是 `execution-worker.boot.json`（`S7-startup-readback.mjs:234`、`sandbox-install-restart-probe.mjs:1031-1032`），文件格式没有变。
- **手机端能力表**：ADR 0254:131 明确说由后续第 11 批任务补登记，本仓库没有这张表，未核实。
