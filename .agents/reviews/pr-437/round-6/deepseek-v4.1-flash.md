## 复核范围

本轮按 `git diff 7542f1a08147fddbb793881f22de1cbab6f6f84e..1462a914aa5c643e9ee33eaed2b055af3d88a83e` 看增量，并沿增量值追到这些地方读了代码：

- 网关装配：`apps/agent-service/src/production-approval-gateway.ts`、`production-http-composition.ts`、`production-capability-lifecycle.ts`、`production-capability-reactivation.ts`、`service-main.ts`
- 执行进程：`apps/execution-worker/src/service-main.ts`、`apps/execution-worker/test/service-main.unit.test.ts`
- 文件读写：`packages/platform-node/src/state-root-layout.ts`、`packages/platform-node/src/capabilities/capability-deployment.ts`
- 生命周期和治理：`packages/application/src/services/capability-lifecycle-service.ts`、`packages/application/src/services/governance-gateway-adapter.ts`、`packages/application/src/ports/capabilities.ts`
- 合约和客户端：`packages/gateway-contracts/src/contracts-v2.ts`、`client-capabilities.ts`、`clients/apple/.../Generated/ClientCapabilities.swift`、`ci/operations-pending.json`
- 检查和测试：`test/integration/production-capability-reactivation.test.ts`、`apps/agent-service/test/production-http-composition.unit.test.ts`、`test/tooling/client-parity.test.ts`、`scripts/check-operations.mjs`
- 依据链：SQLite `saveCapability` 的 CAS、HTTP 错误序列化、控制中心清单、ADR 0254、架构文档

没有重读前几轮已覆盖的整份旧代码；没有运行测试或检查（本轮工具只能读文件和跑指定的 git 命令）。“反向用例会失败”是从代码和断言推断，不是实测结果。

上一轮两条意见的核对结果：

- **d2 已改好**：`clearWorkerQualifiedDeployment` 已前移到 `readAuthorityFile` 之前（`apps/execution-worker/src/service-main.ts:152`），并有 `service-main.unit.test.ts:245-268` 的用例；该用例把 authority 写成 `inactive_ready`，如果清理仍在状态检查之后，记录会留下、断言会失败。
- **d1 只做了文字记录**：ADR 0254 第 121 行已明确写出“真实资格检查完整启动成功、正常停止时删记录”没有自动测试，但并没有新增结构化门槛。本轮不把“没有自动测试”本身当新错误，因为作者已把它写成已知问题；如果要求的是门槛而不是说明，这一条仍只完成了一半。

### 1. [中] 启动清理在 authority 身份校验之前执行，错误路径可能删掉别的部署的合格记录

- **文件:行**：`apps/execution-worker/src/service-main.ts:151-163`
- **问题**：d2 把清理前移到了 authority 校验之前。`initializeStateRoot` 只检查路径、权限和属主，不核对这个 authority 属于哪个 deployment/owner/agent；清理是一笔不可撤销的删除。如果执行进程被用错误的配置（或同账号下另一个部署的 state root）启动，它会先删掉那个 state root 里的 `runtime/execution-worker.qualified.json`，然后才读到 authority 不匹配并退出。之后那个部署的 `capability.reactivate` 会一直以 `execution_worker_qualification_not_published` 失败，直到它的 worker 重新启动。
- **证据（读代码证实）**：

  ```ts
  // apps/execution-worker/src/service-main.ts:151-163
  const layout = await initializeStateRoot(configuration.stateRoot);
  await clearWorkerQualifiedDeployment(layout);
  const authority = await readAuthorityFile(layout);
  if (authority.status !== "active") {
    throw new Error(EXECUTION_WORKER_SERVICE_ERROR_CODES.AUTHORITY_INACTIVE);
  }
  if (
    authority.id !== configuration.deploymentId ||
    authority.ownerId !== configuration.ownerId ||
    authority.agentId !== configuration.agentId
  ) {
    throw new Error(EXECUTION_WORKER_SERVICE_ERROR_CODES.AUTHORITY_MISMATCH);
  }
  ```

  `initializeStateRoot` 在 `state-root-layout.ts:122-143` 只做 `path.isAbsolute`、目录权限 `0700`、属主检查，不比对 authority 内容。
- **推测**：影响大小取决于部署是否多个 state root 共用一个服务账号、以及配置路径是否可能被写错或被控制。单账号单部署时，最坏只是自己的旧记录被提前删掉；共享账号的多人/多部署环境才会波及别的部署。
- **建议**：先读 authority，只核对 `id/ownerId/agentId` 与配置一致，再清理，最后再检查 `status === "active"`。这样既保留 d2 要求的“authority 不活跃也要清掉自己的旧记录”，也不会在 scope 不匹配时删除别人的记录；`service-main.unit.test.ts:245` 的用例仍然会通过。

### 2. [低] 重新启用的六种核验原因码到不了 HTTP 客户端，客户端只收到 403 `PORT_NOT_AUTHORITATIVE`

- **文件:行**：`apps/agent-service/src/production-capability-reactivation.ts:11-16,27-48`；`packages/application/src/services/capability-lifecycle-service.ts:636-645`；`packages/platform-node/src/http-gateway-server.ts:947-961`；`packages/gateway-contracts/src/contracts-v2.ts:1166`
- **问题**：核验器确实产生了六种不同的原因码，但它们只被放进 `ApplicationPortError.details.reasons`。HTTP 层只把 `error.code` 发出去，只有 `error.message` 本身在共享原因码清单里时才附带 `reasonCode`；当前共享清单只有 `LOGIN_DEVICES_STILL_CHANGING`。所以未来的 iOS 调用方看不到“worker 没公布”“快照摘要不符”“能力不在快照里”等区别，只会收到通用的 `403 PORT_NOT_AUTHORITATIVE`。这与 ADR 0254 决定第 3 条“每种失败给出各自的原因码”在客户端这一端对不上，也是 I-73 那类“值在一端产生、另一端不接受”的问题。
- **证据（读代码证实）**：

  ```ts
  // production-capability-reactivation.ts
  const refuse = (reason: string) => ({ verified: false, reasonCodes: [reason] });
  ...
  return refuse(CAPABILITY_REACTIVATION_REASONS.WORKER_NOT_QUALIFIED);
  ```

  ```ts
  // capability-lifecycle-service.ts:640-644
  throw new ApplicationPortError(
    PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    `Capability ${manifest.ref} reactivation check failed`,
    { capabilityRef: manifest.ref, reasons: check.reasonCodes.join(",") },
  );
  ```

  ```ts
  // http-gateway-server.ts:956-960
  sendJson(reply, statusCode, {
    error: {
      code: error.code,
      ...(isGatewayErrorReasonCode(error.message) ? { reasonCode: error.message } : {}),
    },
  });
  ```

  ```ts
  // contracts-v2.ts:1166
  export const GATEWAY_ERROR_REASON_CODES = Object.freeze(["LOGIN_DEVICES_STILL_CHANGING"] as const);
  ```

- **建议**：二选一。要么把这六个原因码登记进共享清单并在 HTTP 层映射成 `reasonCode`，要么在错误正文里增加一个受控的机器字段，并同步 iOS 合约；同时考虑“环境未就绪”是否应该用 409/503 而不是 403，避免 App 把“worker 还没起来”当成“没有权限”而要求重新面容。若决定客户端只需要通用错误，也应在 ADR 中把“原因码只进服务端日志/测试”写清。

### 3. [低] “完整启动成功后写出记录”与代码不符：记录在装配和监听之前写出

- **文件:行**：`apps/execution-worker/src/service-main.ts:177-208,231-235`；作者说明中的“执行进程完整启动成功后写出记录”
- **问题**：记录不是在“完整启动成功”之后写的，而是在 `bindingThenQualification` 成功、`createProductionWorkerComposition` 和 `server.start()` 之前写的；后面任何一步失败，catch 会把它删掉。所以这份记录的含义是“绑定和现场检查已通过”，不是“执行进程已经可用”。ADR 0254 第 80 行的写法是准确的（“现场检查通过、且拿到 agent-service 的绑定之后，才写出”），但作者说明和上一轮“完整启动成功后写出记录”的说法会被误读成服务已经 ready。
- **证据（读代码证实）**：

  ```ts
  // apps/execution-worker/src/service-main.ts:177-208
  publishedLayout = layout;
  await writeWorkerQualifiedDeployment(layout, {
    workerInstanceId,
    workerBootId,
    deploymentId: configuration.deploymentId,
    snapshotDigest: qualified.deployment.snapshotDigest,
  });
  composition = await createProductionWorkerComposition(...);
  server = new ExecutionUdsServer(...);
  await server.start();
  await composition.connectAgentServices();
  ```

  ```ts
  // apps/execution-worker/src/service-main.ts:234-235
  if (publishedLayout)
    await clearWorkerQualifiedDeployment(publishedLayout).catch(() => undefined);
  ```

- **建议**：把作者说明和测试说明改成 ADR 的措辞（“绑定和现场检查通过后写出；后续启动失败会删掉”）。如果产品真正需要“完整启动成功后才算合格”，则应把写入挪到 `server.start()` 和 `connectAgentServices()` 之后，并相应调整 `service-main.unit.test.ts:313-359` 中“装配失败前能读到记录”的断言。

### 4. [低] 核验入口存在时，HTTP 已安装清单包含 `capability.reactivate` 的正向路径没有自动测试

- **文件:行**：`apps/agent-service/src/production-http-composition.ts:805,1616-1619`；`apps/agent-service/test/production-http-composition.unit.test.ts:358-398`；`test/integration/production-capability-reactivation.test.ts:206-228`
- **问题**：集成测试直接调用 `createProductionApprovalGateway`，覆盖了“核验入口存在时命令被接受、不存在时 `PORT_OPERATION_NOT_INSTALLED`”。HTTP 组合层的单测覆盖的是反面：没有核验入口时 `installedGatewayV2Operations` 不含 `capability.reactivate`。没有一条测试用带 `capabilityReactivation` 的 `createProductionHttpComposition` 断言配置接口会公布 `capability.reactivate`。如果以后改漏了 `routeOptions` 的布尔参数，网关仍然能接受命令，但 iOS 从 `/api/control-center/v1/config` 看不到它已安装，界面不会出现入口。
- **证据（读代码证实）**：`production-http-composition.unit.test.ts:377-379` 期望的清单是 `capability.list`、`capability.detail`、`capability.disable`，没有 `capability.reactivate`；该测试没有传核验入口。`production-capability-reactivation.test.ts` 用的是网关和 `createProductionCapabilityLifecycle`，没有调用 `createProductionHttpComposition`。
- **建议**：补一条组合层用例，传入一个假的 `CapabilityReactivationVerifierPort`，断言 `/api/control-center/v1/config` 的 `installedGatewayV2Operations` 包含 `capability.reactivate`；再补一条不传时不包含的用例（现有测试已覆盖反面）。

### 5. [低] 16384 字节上限是 `lstat` 后 `readFile`，存在替换/增长绕过上限的窗口

- **文件:行**：`packages/platform-node/src/state-root-layout.ts:395-420`
- **问题**：`readWorkerRuntimeRecord` 先用 `lstat` 检查大小，再用 `readFile` 整份读入。文件在两次调用之间被替换成更大的文件、或在读取过程中增长时，16KB 上限并不生效；`lstat` 也只检查了当时是不是符号链接，之后换入的符号链接会被 `readFile` 跟随。快照读取函数 `readSnapshotBytes`（同文件 `1300-1348` 行）用的是 `open(O_NOFOLLOW)` + `fstat` + 有上限的循环读取 + 再次 `fstat`，是更稳的写法。
- **证据（读代码证实）**：

  ```ts
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > WORKER_RUNTIME_RECORD_MAX_BYTES) {
    throw ...
  }
  ...
  value = JSON.parse(await readFile(file, "utf8"));
  ```

- **推测**：利用这一点需要能写服务账号的 `0700` runtime 目录；能写那里的人本来就能伪造记录或直接破坏服务。更现实的场景是执行进程异常写出超大文件，agent-service 在处理 `capability.reactivate` 时把整个文件读进内存。现有测试 `production-capability-reactivation.test.ts:424-436` 只覆盖静态超大文件，覆盖不到这个竞态。
- **建议**：仿照 `readSnapshotBytes`，用 `open(file, O_RDONLY | O_NOFOLLOW)` 打开，对打开的描述符 `fstat` 校验属主/权限/大小，只读到上限，再 `fstat` 确认读取期间元数据未变；这样 16KB 上限才是硬上限。

## 说法核对

- “新文件读写和启动绑定共用同一对函数（`commitWorkerRuntimeRecord`、`readWorkerRuntimeRecord`）”：**成立**。两个读写函数都在 `state-root-layout.ts`，启动绑定和合格记录都走它们。
- “重构后启动绑定的行为不变”：**字面上不成立**，读取多了 16384 字节上限，超过就报 `BOOT_BINDING_INVALID`；格式和写入时机确实没变。作者在材料后文已经改成“格式和写入时机不变，读取多了 16384 字节上限”，以更正后的说法为准，不再单列意见。
- “执行进程只在 `bindingThenQualification` 成功后才写记录，启动时先删旧记录”：**成立**（`service-main.ts:152,167-183`），但“启动时”是在配置加载和 `initializeStateRoot` 之后、authority 读取之前；配置或 state root 初始化失败时不会清理。
- “capability.reactivate 只在核验入口装配后才进已安装清单”：**成立**（网关 `production-approval-gateway.ts:346,363`；HTTP 路由 `production-http-composition.ts:805`）。正向 HTTP 路由路径没有测试，见意见 4。
- “已知没有自动测试的一条：执行进程完整启动成功后写出记录”：**措辞不成立**，见意见 3；实际没有自动测试的是“真实资格检查完整启动成功”和“正常停止时删记录”，ADR 0254 第 121 行写的是后者。
- “最近认证没过的 `capability.reactivate` 在写治理收据之前被拒”：**成立**。`governance-gateway-adapter.ts:616` 先调 `#authenticateBeforeFirstReceipt`，`617` 才 `#begin`；集成测试 `312-322` 断言查不到收据。
- “配置里没有 `capabilityDeployment` 时核验器返回 undefined，生产入口不装配”：**成立**（`production-capability-reactivation.ts:25-26`；测试 `344-351`）。
- “执行进程写出记录之后启动失败，catch 里删掉记录”：**成立**（`service-main.ts:234-235`；测试 `313-359`）。
- “`readWorkerRuntimeRecord` 加 16384 字节上限，启动绑定共用”：**成立**（`state-root-layout.ts:393,405`；测试 `424-436`）。
- “浏览器测试夹具重新启用时不改 healthStatus”：本轮增量未包含该文件，**未核实**。
- “架构文档和 ADR 0254 同步”：大体成立；ADR 决定第 3 条的“原因码”在 HTTP 客户端这一端没有真正给出（意见 2），第 80/100 行对记录含义和崩溃残留的说明与代码一致。
- “Swift 生成文件同步”：**成立**，`test/tooling/client-parity.test.ts:214-231` 会逐字比较生成的 Swift。
- “`capability.reactivate` 登记为改类（要面容）”：**成立**，TS 表是 `change`，Swift 生成文件也是 `.change`。
- “网页不再动控制中心，`ci/operations-pending.json` 登记为暂时没有网页调用方”：**成立**。控制中心没有新增调用方；`check-operations.mjs` 的 Swift 扫描排除了 `/Generated/`，所以生成能力表不会被误算成调用方；该条目当前会因“缺调用方”留在 `operations`。
- “合并 main 的冲突解决：网关内部创建生命周期，`capabilityReactivation` 作为选项，HTTP 组合层传核验入口和布尔值”：**成立**（`production-approval-gateway.ts:339-346`；`production-http-composition.ts:1507-1511,1616-1619`）。

## 侧重检查

- **错误路径**：逐条读了集成测试覆盖的路径——已停用才能重新启用、期望版本不符、快照读不出、快照摘要不符、能力不在快照、worker 没公布、记录不可安全读、旧 boot、别的 worker/deployment、记录超 16KB、worker 准入另一份快照、没有核验入口、直接 `activate` 仍拒绝。结论：这些路径都会失败关闭，能力记录不变；测试断言也检查了 `lifecycle: "disabled", revision: 2`。真实资格检查完整启动成功、正常停止、崩溃后重放没有自动测试（ADR 0254:121 已写明）。
- **不合规范/不可信输入**：快照文件有 8MB 上限、`O_NOFOLLOW`、属主/权限检查、UTF-8 fatal 解码和 JSON 解析；合格记录有属主/权限/符号链接/未知字段/16KB 检查；命令载荷走 `gatewayV2MessageSchema`，`expectedRevision` 至少为 1。发现记录读取有 `lstat` 后 `readFile` 的竞态（意见 5）。
- **安全/不可撤销操作**：最近认证在写收据之前；治理命令要求 owner scope 和 `authorizationRef`；记录文件 0600、目录 0700。发现启动清理在 authority 身份校验之前执行，存在跨 scope 删除的可能（意见 1）。核验失败用 403 `PORT_NOT_AUTHORITATIVE` 且客户端拿不到细分原因（意见 2）。
- **资源耗尽**：每次 `capability.reactivate` 最多读 8MB 快照并解析，记录最多 16KB；没有发现无上限读取（除意见 5 的竞态）。命令没有频率限制，但只有已认证 Owner 能发，未发现放大到其他用户的路径。
- **规则文件/说明/代码一致**：ADR 0254 的主干顺序、三项核对、最近认证先于收据、不恢复句柄/任务、不走进加载器新鲜度和 `qualify`，都与代码一致；不一致点已写在“说法核对”和意见 2、3。
- **崩溃残留**：ADR 0254 第 100 行明确写了执行进程被强杀时记录会留到下次启动、这段时间重新启用仍可能通过但执行进程不在；这是已记录的局限，不作为新意见。前提 8 说两个进程成对重启，也解释了为什么不处理 worker 单独重启后的旧 peer binding。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本 PR 的代码增量没有改系统提示、工具定义、历史消息、遮盖或任何 `packages/prompt-catalog` / prompt golden 文件；`capability.reactivate` 是网关治理命令和已安装清单的一部分，不是模型工具。`production-http-composition.ts` 只多传一个核验入口，`contracts-v2.ts` 是网关协议。按 diff 判断，发给模型的内容仍然只在末尾追加，没有把每轮变化的值移进请求开头。本轮没有运行 `check:prompt-prefix`（工具限制），但从改动范围看没有触碰这条规则。
2. **会不会让同一段文字在不同请求里变成不同字节？** 对模型内容不涉及。新增的 `execution-worker.qualified.json` 里 `workerBootId` 是每次启动随机的、`snapshotDigest` 由快照字节决定、审计里有 `occurredAt`，但这些都只写进程间文件/审计表，不进入模型请求。没有发现依赖前后文的遮盖、无序集合或带时间的模型字段。**注意**：如果以后有人把这份记录或 `workerBootId` 带进提示词，就会违反“每轮会变的值只能放最后一条消息”的规则；目前没有这样的使用。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有，但有几处缺口。
   - 有：重新启用的集成测试覆盖了核验成功、六类核验失败、最近认证失败且不写收据、stale revision、已激活、直接 `activate` 仍拒绝、无核验入口不安装、重放幂等、不恢复句柄/定时任务、审计一条；执行进程单测覆盖了“检查前读不到、检查通过后装配前读得到、装配失败删除、旧记录被清掉、authority 检查失败也清掉、超过 16384 字节被拒、正常启动失败不留下记录”；客户端能力表有“每种 v2 请求类型都登记”和“Swift 由表生成、不得手改”的测试；`check:operations` 会要求该操作的调用方缺失项留在清单里。
   - 反向用例从断言看会失败：例如版本或摘要不在快照时，如果 `checkSealedCapabilityMembership` 忽略这些字段，测试会读到 `lifecycle: "active"` 而不是继续 `disabled`；如果启动清理仍在 authority 检查之后，`service-main.unit.test.ts:245` 会读到旧记录。**没有实际运行测试**，这是按代码和断言推断。
   - 缺口：真实资格检查完整启动成功、正常停止时删记录、崩溃后重放没有自动测试（ADR 0254:121 已写）；HTTP 配置接口在“有核验入口”时包含 `capability.reactivate` 没有正向测试（意见 4）；`check:operations` 因为安装条件改成了局部变量，把这条件清单当成无条件清单，门槛本身不再能区分“装配/未装配”，运行时行为靠集成测试兜底。
4. **每个产生或修改的值，两端都能接受吗？** 逐个核对：
   - `capability.reactivate` 字符串：合约 `GATEWAY_V2_MESSAGE_TYPES`、schema 映射、治理适配器命令集、网关已安装清单、HTTP 路由清单、客户端能力表、Swift 生成文件、操作清单、fixture 都能接受；`check:operations` 通过（Swift 的 `Generated` 被排除，不算调用方），客户端一致性测试会强制 Swift 同步。HTTP 路由“有核验入口时包含它”没有正向测试（意见 4）。
   - 命令载荷 `capabilityRef/expectedRevision/reasonCode/recentAuthenticationRef`：schema 与适配器类型一致；`recentAuthenticationRef` 由 `RecentAuthenticationGuard` 校验；`expectedRevision` 由生命周期按 CAS 校验。`reasonCode` 被 schema 接受但服务端没有写进审计，和现有 disable/rollback 一样，属于“接受但未使用”，不是阻断问题。
   - `WorkerQualifiedDeploymentRecord` 的 `workerInstanceId/workerBootId/deploymentId/snapshotDigest`：生产者和消费者共用 `writeWorkerQualifiedDeployment` / `readWorkerQualifiedDeployment`；读取时校验 `deploymentId` 和 `sha256:` 摘要格式；核验器再把 boot/instance/deployment 和摘要与 agent-service 的配置、对端绑定比较。两端格式一致。
   - 六种核验原因码：生命周期服务只要求 `reasonCodes` 非空，测试检查 `details.reasons`；HTTP 客户端收不到，见意见 2。
   - `capabilityReactivation` 选项和 `capabilityReactivationAvailable` 布尔：网关创建生命周期、网关已安装清单、HTTP 路由清单用同一个条件（`!== undefined`）；配置里缺 `capabilityDeployment` 时核验器返回 `undefined`，命令不安装。两端一致。
   - `capabilityDeployment` 配置键：已有严格配置校验（绝对路径、`sha256:` 格式），核验器沿用；没有新增配置键。
   - `runtime/execution-worker.qualified.json` 路径：生产者和消费者都通过 `workerQualifiedDeploymentPath`，没有重复字符串；启动绑定的路径和格式未变，读取多了 16KB 上限。
   - Swift `.change` 分级：生成文件已同步，`client-parity` 测试会守住；iOS 调用方尚未实现，`ci/operations-pending.json` 已登记缺调用方。
   - 结论：除意见 2 的原因码断点和意见 4 的 HTTP 正向测试缺口外，其余值的两端校验能对上。
