## 结论摘要

核心三项核对（快照摘要、能力条目、执行进程记录）和“失败时不改能力记录”在代码上基本成立；没有发现会让模型请求开头变化、或让模型可见文本字节不确定的改动。主要问题集中在：执行进程记录生命周期的测试覆盖不足、正常停止后记录残留的活性风险，以及若干测试夹具/文档与生产行为不完全一致。

## 问题（按严重度从高到低）

### 1. 【中】【读代码证实】“写出记录后启动失败 → catch 删记录”没有自动测试；现有单测在写入之前就失败

- 文件:行：
  - `apps/execution-worker/src/service-main.ts:177-184`（`publishedLayout` 在写入前设置，随后写入记录，再建 composition）
  - `apps/execution-worker/src/service-main.ts:230-234`（catch 中按 `publishedLayout` 清除）
  - `apps/execution-worker/test/service-main.unit.test.ts:46-100`（测试配置没有 `capabilityDeployment`）
  - `apps/execution-worker/test/service-main.unit.test.ts:196-217`（名为“startup fails”的测试）
- 问题：这条测试只覆盖“启动时先删旧记录”。它使用的配置没有 `capabilityDeployment`，所以 `qualifyProductionWorkerDeployment` 会在 `bindingThenQualification` 阶段就抛错，`publishedLayout` 永远不会在 `service-main.ts:177` 被赋值，catch 里新增的删除分支不会执行。删掉 `service-main.ts:233-234` 这段代码，该测试仍然会通过。
- 证据：测试 fixture 的 `configuration()` 从 `service-main.unit.test.ts:46` 开始，没有 `capabilityDeployment`；写入点在 `service-main.ts:178`，而 catch 清理以 `publishedLayout` 为条件（`service-main.ts:233`）。
- 建议：增加一个单测，让 `qualifyProductionWorkerDeployment` 成功、`createProductionWorkerComposition` 或 `server.start` 失败，然后断言 `readWorkerQualifiedDeployment` 拒绝；再补成功启动后记录存在的用例。作者已承认这一条在云端容器里做不了进程级测试，但至少组合失败路径可以在单测里 mock。

### 2. 【中】【代码行为证实，风险为推测】正常停止时记录不删；重新启用不检查执行进程是否仍在运行

- 文件:行：
  - `apps/execution-worker/src/service-main.ts:219-229`（正常收尾只 `server.stop()`、`composition.close()`，不清记录）
  - `apps/agent-service/src/production-capability-reactivation.ts:38-48`（只比较记录里的 boot id、instance id、deployment id 和快照摘要）
- 问题：执行进程正常退出后，`runtime/execution-worker.qualified.json` 仍然留有一次“启动时检查通过”的记录。只要 agent-service 还活着、`peerBinding` 仍是这个旧 boot，重新启用仍会通过。ADR 只写明“不证明此刻机器上的隔离环境仍然健康”，没有说明“进程已经停了”的情况。
- 证据：`service-main.ts:228` 正常路径直接 `return 0`，没有清除记录；验证器只做静态字段比较。
- 建议：明确这是可接受的设计，或在正常停止时也删记录；如果要求“重新启用时执行进程必须活着”，需要额外的活性检查。当前要求文字只说“通过现场检查后公布的记录”，所以这一点标记为残余风险，不认定为违反现有规格。

### 3. 【低】【读代码证实】集成测试用的“部署快照”不是真实加载器能接受的格式，不能证明 (b) 对生产快照格式有效

- 文件:行：
  - `test/integration/production-capability-reactivation.test.ts:119-126`（快照只有 `capabilities: [{ manifest }]`）
  - `packages/platform-node/src/capabilities/capability-deployment.ts:1129-1138`（真实条目必须含 `manifest`、`qualification`、`binding`）
- 问题：测试快照缺少 `qualification` 和 `binding`，真实 `CapabilityDeploymentSnapshotLoader` 会拒绝它。`checkSealedCapabilityMembership` 只读 `capabilities[].manifest`，所以测试通过，但这个测试并没有验证真实生产快照的序列化格式。以后若快照把 manifest 字段移到别处，或新增必填字段，这些测试仍会通过，生产重新启用则可能全部拒绝。
- 建议：用 `CapabilityDeploymentSnapshotLoader` 生成的完整条目（至少包含 `qualification`、`binding`、`hostIsolation`）构造夹具，或直接对加载器输出的快照做摘要和成员检查。

### 4. 【低】【读代码证实】“没有核验入口就不进已安装清单”的反向用例很弱，不能证明安装清单本身正确

- 文件:行：
  - `test/integration/production-capability-reactivation.test.ts:341-346`
  - `test/integration/production-capability-reactivation.test.ts:416-420`
- 问题：`rejects.toBeDefined()` 只证明命令失败，不证明失败原因是“操作未安装”。在 `withVerifier: false` 的夹具里，即使网关错误地把 `capability.reactivate` 装进清单，生命周期服务也会因缺少验证器而抛 `PORT_NOT_AUTHORITATIVE`，测试仍然通过；`expect(PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS).toEqual(["capability.reactivate"])` 只是拿常量和自己比较，是恒真断言。
- 建议：断言错误码为 `PORT_OPERATION_NOT_INSTALLED`，并从 `createProductionHttpComposition` 或网关配置接口读取实际 `installedGatewayV2Operations` 再断言缺少该命令。

### 5. 【低】【读代码证实】作者“启动绑定行为不变”的说法与 16384 字节上限矛盾

- 文件:行：
  - `packages/platform-node/src/state-root-layout.ts:393-406`（共用 `readWorkerRuntimeRecord` 的大小检查）
  - `packages/platform-node/src/state-root-layout.ts:478-485`（启动绑定使用同一个读函数）
- 问题：重构后启动绑定的读写确实共用同一对函数，但新增的 `info.size > 16_384` 检查也作用于 `execution-worker.boot.json`。文件超过 16KB 时，以前能读，现在会失败，所以“重构后启动绑定的行为不变”不准确。实际启动绑定很小，影响可忽略，但说法与代码不一致。
- 建议：把说法改成“格式和写入时机不变，读取增加统一大小上限”，或给启动绑定单独保留旧行为。

### 6. 【低】【读代码证实】浏览器测试夹具重新启用后 `healthStatus` 留在 `unknown`，与生产不一致

- 文件:行：
  - `test/e2e/fixtures/control-center-browser-server.mjs:1841-1851`（停用设为 `unknown`，重新启用不恢复）
  - `packages/persistence-sqlite/src/sqlite-durable-operations.ts:2643-2656`（生产停用只写 `lastInvalidation`，不改 health）
  - `packages/application/src/services/capability-lifecycle-service.ts:642`（重新启用只改 lifecycle）
- 问题：生产停用不改 manifest health，重新启用后仍可能是 `healthy`；测试夹具停用把 `healthStatus` 改成 `unknown`，重新启用又保持 `unknown`。以后用这个夹具做界面断言，会得到不同于生产的状态。
- 建议：夹具与生产对齐（停用不改健康状态），或者明确测试只关心生命周期、不关心健康状态。

### 7. 【信息/低】【读代码证实】ADR 编号顺序错位；新记录的部分错误信息仍写“Agent Service boot binding”

- 文件:行：
  - `docs/adr/0254-capability-reactivation-is-one-atomic-command.md:68-70`（8、10、9 的顺序）
  - `packages/platform-node/src/state-root-layout.ts:204-212`（`assertBootBindingText` 固定写 “Agent Service boot binding is invalid”）
- 问题：ADR 决定列表顺序错乱；新 worker 记录字段校验失败时，错误信息会误称 Agent Service boot binding，排查时容易误导。
- 建议：修正 ADR 编号顺序；给 `assertBootBindingText` 增加 label 参数，或至少改掉固定文案。

## 作者说法核对

- “新文件读写和启动绑定共用同一对函数”：证实，见 `state-root-layout.ts:358-441`、`478-485`、`536-576`。但“启动绑定行为不变”不完全成立，见问题 5。
- “执行进程只在 `bindingThenQualification` 成功后才写记录，启动时先删旧记录”：证实，见 `service-main.ts:165`、`167-183`。
- “`capability.reactivate` 只在核验入口装配后才进已安装清单”：证实，见 `production-http-composition.ts:1150-1152`、`1208` 和 `production-approval-gateway.ts:286`。
- “最近认证没过的 reactivate 在写收据之前被拒”：证实，见 `governance-gateway-adapter.ts:621-639`；测试 `production-capability-reactivation.test.ts:309-319` 是真正的反向用例：去掉该分支后 `#begin` 会先建收据，断言会失败。
- “没有 `capabilityDeployment` 时返回 undefined、原因码删除”：证实，见 `production-capability-reactivation.ts:24-26`；全仓已无该原因码引用。
- “写出记录之后启动失败，catch 里删记录”：代码证实，见 `service-main.ts:230-234`；但没有测试覆盖，见问题 1。
- “readWorkerRuntimeRecord 加 16384 字节上限”：证实，见 `state-root-layout.ts:393-406`。
- “夹具重新启用时不改 healthStatus；架构文档和 ADR 同步”：代码/文档属实，但夹具因此与生产不一致，见问题 6；ADR 有编号顺序问题，见问题 7。

## 侧重检查

- 错误路径：检查了最近认证失败、收据已存在/重放、已激活状态、期望版本过期、快照不可读、摘要不符、能力不在快照、worker 记录缺失/权限不安全/boot 不符/快照不符、直接 activate。核心逻辑均为先验证后 `save`，失败不落库；重放路径在 `governance-gateway-adapter.ts:1032-1055` 提前返回。未发现逻辑漏洞。
- 不合规范/不可信输入：命令载荷由 `contracts-v2.ts` 校验；能力记录通过 owner/agent 作用域的 store 读取（`#requireCapability`）；快照路径和摘要来自严格配置（`strict-configuration.ts:211-219`）；没有用户可控文件路径进入新记录读写。记录读取拒绝符号链接、组/其他人权限、错误属主、未知字段和超大文件（`state-root-layout.ts:395-440`）。
- 安全：最近认证执行两次（`#authenticateBeforeFirstReceipt` 和 `#reactivateCapability`），文件同步/权限沿用原子写；不恢复句柄和定时任务。worker 记录是本地信任边界内的证据，不是签名凭证，但和现有 state-root 的信任模型一致。
- 资源耗尽：快照读取上限 `CAPABILITY_DEPLOYMENT_MAX_BYTES = 8MB`（`capability-deployment.ts:29`），记录读取上限 16KB；命令请求体仍受网关 HTTP 上限约束。新增的重复读取每次请求最多读 8MB 并解析 JSON，但只有已认证 owner 能触发，风险可接受。
- 不可撤销操作：重新启用本身可被再次停用；不恢复外部副作用、句柄或定时任务；未发现新增不可撤销动作。
- 规则/文档一致性：`docs/architecture-v0.1.md:364,554` 与代码的“有部署快照且核验入口装配才安装”一致；ADR 与实现的三项核对、原因码、失败不改记录基本一致。不一致点见问题 5、6、7。
- 未覆盖/未核实：没有重新逐行审计整个模型请求组装器；只确认本 PR 没有修改相关文件，也没有把新值送入请求组装路径。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本 PR 没有修改系统提示、工具定义生成器、历史消息或遮盖代码（`git diff --stat` 不涉及 prompt-catalog、runtime-pi、历史/遮盖文件）。重新启用只调用 `save(current, { lifecycle: "active" })`（`capability-lifecycle-service.ts:624-643`），不恢复执行句柄和定时任务；模型可见工具来自执行句柄（`production-runtime-tools.ts:509-527`），因此工具集合不变。新增的 `workerBootId`、`snapshotDigest` 只写进 `runtime/execution-worker.qualified.json`，只被重新启用验证器读取，不进入模型请求。结论：发给模型的内容仍然只在末尾追加，每轮会变的值没有被放进系统提示或工具定义。模型请求组装器本身未逐行重审（未核实），但本 PR 没有触及它。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会（针对模型可见内容）。本 PR 没有新增依赖前后文的遮盖、时间字段或无序集合到系统提示/工具/历史中。新增的两种序列化是 worker 资格记录和审计记录；前者字段固定、由执行进程按固定顺序 `JSON.stringify`，后者只进数据库，二者都不进入模型请求。控制中心新增文案是静态 i18n 字符串。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   大部分核对路径有测试，且多数是有效的反向用例：最近认证（`production-capability-reactivation.test.ts:309-319`）、已激活、版本不在快照、摘要不符、快照不可读、安装包摘要不符、worker 记录缺失/权限不安全/boot 不符/快照不符、过期版本、直接 activate，都会在对应检查被移除时让命令成功，从而使 `stillDisabled()` 或具体原因断言失败。存在以下缺口：
   - “写出记录后启动失败 → catch 删除”没有覆盖，现有单测在写入前就失败（问题 1）。
   - “完整启动成功后记录存在”没有自动测试，作者已承认。
   - “无部署快照 → 命令不进已安装清单”的断言不能证明安装清单正确（问题 4）。
   - 集成测试快照不是真实格式，无法防止快照格式回归（问题 3）。

4. **改动产生/修改的每个值，每一个使用它的地方都能接受吗？**
   逐项核对如下：
   - 命令类型 `capability.reactivate`：契约 schema（`contracts-v2.ts:95,1928-1936,2672`）→ 治理适配器集合（`governance-gateway-adapter.ts:65,86,751`）→ 生产已安装操作（`production-approval-gateway.ts:74,286`）→ HTTP 配置清单（`production-http-composition.ts:698`）→ 控制中心动作/命令构造（`governance-control-center.tsx:245,783-795`）→ e2e 夹具（`control-center-browser-server.mjs:1725,1742,1846,2230`）。两端都能接受；控制中心清单测试还会检查该类型确实存在于 `GATEWAY_V2_MESSAGE_TYPES`。
   - 配置键 `capabilityDeployment`：严格配置校验 `snapshotPath`/`sha256`（`strict-configuration.ts:211-219`）；agent-service 验证器和 worker 加载器消费同一结构。两端校验一致。
   - 原因码：`checkSealedCapabilityMembership` 产生三个快照原因码，`production-capability-reactivation.ts` 产生三个 worker 原因码；只作为 `ApplicationPortError.details.reasons` 返回，没有其他白名单消费者。已删除的 `capability_deployment_not_configured` 无残留引用。
   - 新记录路径和字段：写/读共用固定路径和共用校验函数（`state-root-layout.ts:506-576`）；`readWorkerQualifiedDeployment` 会再次校验 `schemaVersion`、字段集合、`workerInstanceId`、`workerBootId`、`deploymentId`、`snapshotDigest`。唯一不对称是写入端的 `deploymentId` 没再调用 `createDeploymentId`，但它的来源是已校验的配置，当前调用方都能接受。
   - 审计动作名 `capability.reactivate`：复用治理审计，`audit_records.action` 是普通文本列，没有枚举约束；集成测试也按该动作名计数。
   - 清单项 `capability.reactivate`：加入 `control-center-inventory.ts:227`，但该 surface 用 `mutationsOfferedWhenInstalled: true` 只按查询判断页面可用性（`control-center-inventory.ts:67-69`），因此不会因为新增 mutation 把能力页整体隐藏。
   - 测试夹具 `healthStatus`：只有测试夹具与生产不一致（问题 6），不影响生产值。
