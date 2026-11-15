## 结论

没有发现会直接破坏“请求仅末尾追加”或“字节确定”的高严重度代码缺陷。重新启用的主链路（契约 → 安装清单 → 网关校验 → 服务层状态 → 审计）与作者第 5 轮的说法基本一致。下面按严重度列出问题，随后是侧重检查和必答问题。

### 读代码证实的问题

**1. [中] 未测试的关键启动路径没有被结构化记录，现有门槛抓不到这句话**
- 文件:行：`scripts/delivery-mode/untested-claims.py:6`；提交 `8810029`、`14398657` 的提交说明；`docs/adr/0254-capability-reactivation-is-one-atomic-command.md:116-118`
- 问题：提交说明写的是“没有自动测试：用真实现场检查完整启动成功后写出记录、正常停止时删掉记录。”但 `PHRASE` 只匹配以 `没有测试|未覆盖|原因不明` 开头的行，`没有自动测试` 不匹配；而发布前门槛只认 `Untested-critical-path:` 结构化声明。于是这条进程级关键路径既不会触发提交钩子，也不会在打包时要求 `Real-env-proof:` 或 `Waiver:`。ADR 也承认真实完整启动和正常停止没有自动测试。
- 证据：
  - `untested-claims.py:6`：`PHRASE = re.compile(r'^\s*(?:[-*]\s*)?(?:not covered by (?:a|any) test|unexplained|没有测试|未覆盖|原因不明)', re.I)`
  - 提交 `8810029` 正文：`没有自动测试：用真实现场检查完整启动成功后写出记录、正常停止时删掉记录。`
- 建议：把提交说明改成 `Untested-critical-path: ...`，并补 `Real-env-proof:`/`Waiver:`；或把 `PHRASE` 扩展到 `没有自动测试`、`没有.*测试`。在 ADR 的“已知问题”里也标注这是待补真实环境证据，而不是完成状态。

**2. [低] 旧记录清理发生在配置和 authority 校验之后，早期启动失败会跳过清理**
- 文件:行：`apps/execution-worker/src/service-main.ts:150-165`；`docs/adr/0254-capability-reactivation-is-one-atomic-command.md:80`
- 问题：ADR 说“执行进程启动时先删掉上一次留下的记录”，但代码是在 `readAuthorityFile` 并校验 `authority.status`、deployment/owner/agent 一致之后才调用 `clearWorkerQualifiedDeployment(layout)`。配置解析、`initializeStateRoot`、authority 读取或校验任一失败时，上一次的记录会保留。若此时 agent-service 仍用旧 `peerBinding` 运行，旧记录可能让重新启用通过（影响依赖运行状态，属推测）。
- 证据：
  - `service-main.ts:151` `const layout = await initializeStateRoot(configuration.stateRoot);`
  - `service-main.ts:152-162` authority 读取与三项一致性校验
  - `service-main.ts:165` `await clearWorkerQualifiedDeployment(layout);`
- 建议：在 `initializeStateRoot` 成功后立即清理（或用 `finally` 保证清理），并补一条“authority 无效时也不会留下旧记录”的单元测试；同时把 ADR 改成“通过 authority 校验后先删”。

**3. [低] 新记录读取仍有 `lstat` → `readFile` 的 TOCTOU/符号链接窗口**
- 文件:行：`packages/platform-node/src/state-root-layout.ts:400-420`
- 问题：文件大小、权限、属主是在 `lstat` 结果上检查，随后按路径 `JSON.parse(await readFile(file, "utf8"))` 读取。`lstat` 与 `readFile` 之间文件可被替换，16384 字节上限和符号链接检查都可能被绕过。启动绑定原本也是这个模式，但这个新文件现在参与授权判断，值得加严。对比快照读取器 `capability-deployment.ts:1298-1346` 已使用 `O_NOFOLLOW`、打开前后 `stat` 比对和有界读取。
- 证据：
  - `state-root-layout.ts:400-406` `lstat(file)`、`info.size > WORKER_RUNTIME_RECORD_MAX_BYTES`
  - `state-root-layout.ts:420` `value = JSON.parse(await readFile(file, "utf8"));`
- 建议：改成 `open(file, O_RDONLY|O_NOFOLLOW)` + `fstat` 前后比对 + 按上限有界读取，或复用快照读取器的同一套做法。运行目录是 0700 且属主相同，实际可利用性有限，属低风险。

**4. [低·测试夹具] 重新启用后的 `healthStatus` 与生产语义不一致**
- 文件:行：`test/e2e/fixtures/control-center-browser-server.mjs:1841-1852`；`packages/application/src/services/capability-lifecycle-service.ts:624-643`；`packages/application/src/services/governance-gateway-adapter.ts:456`
- 问题：夹具在 `capability.disable` 时把 `healthStatus` 设为 `"unknown"`，新增的 `capability.reactivate` 分支只改 `lifecycle`、`revision`，不重置健康状态。生产 `reactivate` 也只改 `lifecycle/revision/updatedAt`，而详情返回的是 `manifest.health.status`，通常仍是停用前的 `"healthy"`。因此浏览器测试里重新启用后的健康状态和真实后端不同。这是测试夹具问题，且 `disable` 设 `unknown` 是既有行为；本次只是没有在 `reactivate` 时修正。
- 证据：
  - 夹具 `1843-1844`：`target.lifecycle = "disabled"; target.healthStatus = "unknown";`
  - 夹具 `1846-1852`：`case "capability.reactivate": ... target.lifecycle = "active";` 没有改 `healthStatus`
  - 生产 `governance-gateway-adapter.ts:456`：`healthStatus: manifest.health.status`
- 建议：明确夹具想模拟的语义。如果要与生产一致，重新启用时恢复原健康状态；如果要表达“未重新检查”，在测试断言和文档里写清这不是生产 detail 的 health 值，并补一条真实快照对应行为的 e2e 期望。

### 推测 / 未核实

- **启动窗口（推测）**：执行进程在 `writeWorkerQualifiedDeployment` 之后才 `createProductionWorkerComposition`、`server.start()`、`connectAgentServices()`（`apps/execution-worker/src/service-main.ts:177-208`）。记录存在但 worker 尚未开始监听时，重新启用可能已经通过。ADR 只写了“写出记录后启动失败会删记录”和“强杀后记录留到下次启动”，没有把这段启动窗口写成已知限制；没有进程级测试可证实影响大小。
- **旧记录在 authority 校验失败时的后果（推测）**：同问题 2，是否真的能通过取决于 agent-service 是否仍持有旧的 `peerBinding`；这属于 ADR 已部分承认的崩溃/失联限制。
- **移动端能力表（未核实）**：ADR 说手机端要另行登记 `capability.reactivate`（`docs/adr/0254...:127`），手机端不在本仓库，未核实。

## 侧重检查

- **错误路径**：最近认证在写收据前校验（`governance-gateway-adapter.ts:600`、`622-639`），测试断言失败请求查不到收据（`test/integration/production-capability-reactivation.test.ts:313-323`）；校验失败不改能力记录；worker 装配失败 catch 删除记录（`service-main.ts:231-235`）；启动时先删旧记录（但见问题 2）。
- **不合规范或不可信输入**：快照路径/摘要来自严格配置（`strict-configuration.ts:211-219`）；快照读取有 8MB 上限、属主/权限/`O_NOFOLLOW`/前后元数据比对（`capability-deployment.ts:1287-1354`）；新记录读取拒绝符号链接、组/其他人可读写、属主不符、超过 16384 字节、多余字段和非 1 的 `schemaVersion`（`state-root-layout.ts:393-440`），但存在问题 3 的读取窗口。
- **安全/授权**：`capability.reactivate` 需要已认证 Owner、非空 `authorizationRef` 和最近认证（`governance-gateway-adapter.ts:641-655`、`1073-1088`）；只在核验入口装配后才进安装清单（`production-approval-gateway.ts:286-288`、`production-http-composition.ts:698`），未装配时后端返回 `PORT_OPERATION_NOT_INSTALLED`（测试 `production-capability-reactivation.test.ts:345-353`、`447-453`）。
- **资源耗尽**：快照读取 8MB 上限；记录读取 16384 字节上限；重复失败的治理请求会留下 `executing` 收据，但这是停用/退回已有的模式，不是本改动新增。
- **不可撤销操作**：重新启用不恢复执行句柄、不恢复被取消的定时任务；代码只 `save(current, { lifecycle: "active" })`（`capability-lifecycle-service.ts:642`），测试确认句柄仍 `revokedAt`、任务仍 `revoked`（`production-capability-reactivation.test.ts:463-496`）。重新启用本身可通过停用回退，不是不可逆操作。
- **规则/文档/代码一致性**：
  - 作者第 5 轮撤回“启动绑定行为完全不变”是对的：写路径和写入时机未变，读取新增 16384 字节上限（`state-root-layout.ts:393-405`）。
  - 作者第 5 轮说 8810029→7542 只加测试和 ADR，核对增量属实。
  - “执行进程只在 `bindingThenQualification` 成功后写记录”属实（`service-main.ts:167-183`）。
  - “重新启用只在核验入口装配后才进已安装清单”属实（两处安装清单都按 `capabilityReactivationAvailable` 条件加入）。
  - 未测试声明没有进入结构化门槛，见问题 1。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加？每轮会变的值是不是都在最后一条消息里？**

不会直接改变。这个 diff 没有触碰提示词组装、`packages/prompt-catalog`、工具定义、历史消息或出口遮盖；模型请求仍然只在末尾追加。每轮变化的时间、记忆、运行环境等值也没有被新增到系统提示或工具定义。新的 `execution-worker.qualified.json` 含每次启动随机的 `workerBootId`，但它只在执行进程和 agent-service 之间读写，不进入模型请求。重新启用后能力可能重新可用，但工具描述符是从执行句柄构建的（`apps/agent-service/src/production-runtime-tools.ts:405-565`），本命令不签发句柄，所以不会直接改变工具列表；是否存在其他把 active 能力投影成工具的路径未完全核实，但本 diff 内没有改。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

不会影响发给模型的文字。新增的治理命令、原因码、状态字段都是确定性的；快照摘要是内容寻址的；新记录里的随机 `workerBootId` 只存在于本机文件，不进入模型请求。没有新增依赖时间、前后文遮盖或无序集合的模型可见序列化。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有对应自动检查：
- `test/integration/production-capability-reactivation.test.ts`：认证失败不留收据、已激活拒绝、版本不在快照、stale revision、快照摘要不符、快照不可读、安装包摘要不符、无 worker 记录、记录不安全、旧 boot、实例/部署不匹配、超过 16384 字节、worker 准入另一份快照、未装配时 `PORT_OPERATION_NOT_INSTALLED`、停用后直接 `activate` 仍被拒、不恢复句柄/定时任务、审计只写一次。
- `apps/execution-worker/test/service-main.unit.test.ts:222-350`：启动删旧记录、绑定成功但检查失败不写记录、检查通过后、装配前读得到、装配失败后被删。

按断言逻辑，反向用例是真的会失败：例如去掉“写收据前先验认证”，`receipts.get` 断言会失败；去掉 16384 上限，超限用例会成功重新启用而断言失败；去掉启动删除或 catch 删除，后续读取会成功而断言失败。但我只能用 `read`/`git`，没有实际执行测试。

仍缺作者已承认的三条：真实现场检查完整启动成功后写出记录、正常停止时删除记录、崩溃后重放分支。另外提交说明中的“没有自动测试”没有进入结构化 `Untested-critical-path:` 门槛，见问题 1。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

逐项核对如下：
- `capability.reactivate` 命令类型：加入 `GATEWAY_V2_MESSAGE_TYPES`、`reactivateCapabilityCommandSchema`、`schemasByType`、`GOVERNANCE_COMMAND_TYPES`、`PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS`、浏览器 `installedGatewayV2Operations`、控制中心清单、网关适配器、e2e 夹具和测试；契约解析、安装清单校验、后端 `AgentGatewayV2Service` 操作过滤和 `#reactivateCapability` 都接受它。
- `PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS`：只在 `options.capabilityReactivation !== undefined` 时加入两处安装清单；`check:operations` 的后端、调用方、测试三类检查都有对应字面量。
- 新记录字段 `schemaVersion/workerInstanceId/workerBootId/deploymentId/snapshotDigest`：写端用 `assertBootBindingText`/`assertSnapshotDigest` 校验，读端校验 `schemaVersion === 1`、字段集合、`createDeploymentId` 和摘要正则；验证器再把 `workerBootId`、`workerInstanceId`、`deploymentId` 与当前 peer/配置比较，把 `snapshotDigest` 与配置摘要比较。两端格式一致。
- 快照成员核对：写端/加载器把 `capabilities[].manifest.ref/version/integrity` 作为条目；验证器按同样三个字段与注册记录比较，摘要另由配置的 `sha256` 绑定，格式一致。
- 新原因码只出现在验证器、错误 details 和测试里，没有需要同步的其他枚举；新 i18n key 已同时加入 `message-ids.ts` 和 en/ja/zh-CN 三个资源。
- 没有新增配置键、没有改表或迁移号。
- 例外是问题 4 的 e2e 夹具 `healthStatus`，以及问题 3 的记录读取窗口；前者是测试夹具语义，后者是读取强度。
