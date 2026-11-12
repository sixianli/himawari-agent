# 复核报告：PR 425（e7bd34c，网关 v2 设备管理 + 服务器状态合约）

## 发现的问题（按严重度从高到低）

### 1.【中】合约形状与仓库内唯一的设计文档不一致，PR 404 后端有撞车风险

- 文件：`packages/gateway-contracts/src/contracts-v2.ts:517-527`（`DEVICE_LIMIT_KEYS` 十项）、`:585-589`（`devicePairingCodeSchema`，配对码进 `device.pairing.start` 命令载荷）
- 问题：作者说「形状由 iOS 设计线程定稿」「设备上限键是设计文档里的十个硬上限键」，但仓库里唯一的设备设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md` 与合约在多处矛盾：
  - 配对码生成方：文档 169 行写「**服务器生成配对码**：128 位随机数，10 分钟有效……库里只存它的哈希」；合约的 `device.pairing.start` 载荷是调用方传入 `pairingCode`（contracts-v2.ts:604-607）。文档没有「调用方生成」的流程，仓库内也搜不到任何支持「调用方生成」的文档（grep `pairing.start|配对码` 全 docs 无果）。
  - 上限键：文档 583 行硬上限表把 `device.prefetch.cache` 列为**一个**键（“20 条、合计 200 KB”），706 行明确写「硬上限的**九个**配置键」；合约拆成 `device.prefetch.cache.entries` 和 `device.prefetch.cache.bytes` 共十键。作者「设计文档里的十个硬上限键」与文档不符。
  - 六位 `pairingNumber`（contracts-v2.ts:543-546）：文档的配对流程（169-176 行）里没有六位确认数字这个概念，确认靠网页上人工点头（175 行）。
  - `device.list.snapshot` 里的 `pairing.access { clientId, clientSecret }`（contracts-v2.ts:561-565）：文档的凭据经二维码/连接下发（170、188 行），没有经列表快照下发凭据的形状。
- 证据：以上均引自文档原文与合约源码。
- 建议：合约先行本身被 ADR 0192 流程和 pending 名单覆盖，没问题；但要么把设计文档更新成「iOS 设计线程定稿」的形状（并注明由哪个线程、何时定稿），要么在 PR 说明里给出该线程的出处，否则 PR 404 按现文档实现会直接撞合约校验。

### 2.【低】`server.status` 依赖状态枚举含 `"blocked"`，真实数据源永远不产生该值；「字段对齐网页接口」只对了一半

- 文件：`packages/gateway-contracts/src/contracts-v2.ts:626`；`packages/domain/src/durable-state.ts:532`
- 证据：合约 `SERVER_STATUS_DEPENDENCY = ["healthy", "degraded", "blocked", "unavailable"]`（contracts-v2.ts:626）；数据源 `DependencyHealthStatus = "healthy" | "degraded" | "unavailable"`（durable-state.ts:532），`RuntimeHealthModel.observe` 只接受这些值（runtime-health.ts:89-98）。新合约测试还专门断言接受 `"blocked"`（device-gateway.contract.test.ts:133）。仓库内没有任何健康生产者会发 `"blocked"`（grep 证实）。
- 说明：`apps/control-center/src/gateway-client.ts:32,416` 的网页客户端本来就写死了含 `"blocked"` 的四值枚举，所以合约是对齐了**客户端类型**而非**数据源**；这是超集，不会炸，但「`server.status.snapshot` 的字段对齐网页 /api/health/v1/dependencies」这句对依赖状态一列并不成立。建议在 PR 说明或合约注释里写明 `"blocked"` 是预留值、当前无生产者。

### 3.【低】集成测试没有把真实健康输出过一遍合约 schema，端到端只做了逐字段相等

- 文件：`apps/agent-service/test/production-http-composition.unit.test.ts:1098-1150`
- 证据：测试把 gateway 响应和 `/api/health/v1/dependencies` 逐项比较（1113-1140 行），但没有调用 `gatewayV2MessageSchema.parse` 校验响应；合约测试（device-gateway.contract.test.ts）只用合成 fixture。若真实 `RuntimeHealthModel` 将来产出违反 `machineString` 的依赖名/reasonCode（现在有守卫，runtime-health.ts:94，所以风险低），没有任何测试会经合约层拦截。
- 建议：在集成测试里对 `serverStatus.json()` 补一次 `gatewayV2MessageSchema.parseJson`，成本很低。

### 4.【低】`ProductionServerStatusControl` 的响应 messageId/correlationId 直接沿用查询消息，与其它读模型的约定不同

- 文件：`apps/agent-service/src/production-server-status-control.ts:41-44`
- 证据：`return { ...query, kind: "snapshot", ... }` 保留了请求的 `messageId`/`correlationId`/`causationId: null`；而同库其它读模型用 `responseId("snapshot", query.messageId)` 并把 `causationId` 设为请求 `messageId`（governance-gateway-adapter.ts:296-312）。schema 两头都合法（envelope 只要求 `machineString`/nullable），但客户端若按 `causationId` 关联快照与查询，这条消息和别的快照行为不一致。
- 建议：改成与 `GovernanceGatewayV2ReadModel.#envelope` 相同的约定，或说明为何不必。

### 5.【低/现存】`docs/architecture-v0.1.md:554` 「当前正式 Gateway v2 只安装 approval.list/detail/respond」与组装代码不符

- 证据：该行文字与 `production-http-composition.ts:680-691` 的 `installedGatewayV2Operations`（无条件含 owner.preferences、sensitive.interceptions、web.push 等，现在又加了 server.status.read）不符。核对 diff 后确认这在**本 PR 之前已经失真**（同样的无条件清单早已存在），本 PR 只是又加了一条；属既有文档陈旧，非本 PR 引入。建议顺手修正或注明。

## 侧重检查

走的流程：主人已登录 → `POST /api/gateway/v2/queries`（`server.status.read`）→ `http-gateway-server.ts:1103-1108`（`assertMutationBoundary` → `authenticate` → 合约解析 `parseV2BusinessMessage`）→ `AgentGatewayV2Service.request`（`agent-gateway-v2-service.ts:29-46`：身份/scope 匹配 91-103、access 策略 + authority 栅栏 104-111 与 `production-approval-gateway.ts:273-284`、installedOperations 检查 34-42）→ `GovernanceGatewayV2ReadModel.query`（`governance-gateway-adapter.ts:210-211`，`server.status.*` 不是治理查询，走 delegate）→ `ProductionServerStatusControl.query`（`production-server-status-control.ts:28-55`）→ `RuntimeHealthModel.authenticatedSnapshot(true)`（`runtime-health.ts:115-118`）。读路由由 HTTP 层先认证，控制里写死 `authenticatedSnapshot(true)` 是安全的（对照网页路由 `http-gateway-server.ts:925-929` 也是认证后同样调用）。

结论：主流程每一环都有测试或守卫覆盖（`production-http-composition.unit.test.ts:1098-1150`：200、与网页逐项相等、无会话 ≥400）。**没有测试覆盖的代码路径**：① `SERVER_STATUS_OPERATION_NOT_INSTALLED` 分支（production-server-status-control.ts:29-30，防御性，经现有分派不可达）；② authority 栅栏不匹配（`GATEWAY_AUTHORITY_CHANGED`）对这条新操作的专门用例（走通用网关测试）；③ 见问题 3 的合约层校验缺口。设备八个类型在生产组装里完全没有任何运行路径（无处理程序），发 `device.*` 会在 installedOperations 处按 ADR 0192 得 501/`PORT_OPERATION_NOT_INSTALLED`，符合设计。

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？——不会（读代码证实）。** 改动全部落在：合约定义（gateway-contracts，纯 schema）、主人侧 gateway v2 的读控制（production-approval-gateway.ts）、HTTP 组装与 `installedGatewayV2Operations` 配置（production-http-composition.ts:690、1150-1154）。这些文件不参与系统提示、工具定义、历史消息或出口遮盖的组装（模型请求由 threadGateway/runtime-pi 另行组装，本次未触碰）。没有「每轮会变的值」进入任何请求头；`generatedAt` 只出现在 gateway v2 响应里。`check:prompt-prefix` 闸门存在且未被本 PR 修改（.claude/rules/prompt-prefix.md:74）；其实际运行结果未核实（无法执行命令）。

**2. 会不会让同一段文字在不同请求里变成不同字节？——对模型请求：不会；对 gateway 响应本身：`generatedAt` 每次不同，但那是按请求即席生成的快照，不落历史、不进模型。** 合约侧序列化确定性已核实：`object` 按固定键序解析、数组冻结（validation.ts:150-191），`deviceNameSchema` 的 trim 是确定性变换；快照 `dependencies` 数组顺序由 `RuntimeHealthModel` 的 Map 插入序决定，进程内稳定。无依赖前后文的遮盖逻辑被改动。

**3. 有没有对应的自动检查、反向用例会不会真失败？——有（读代码证实其结构与覆盖，运行结果未核实）。** ① `check:operations`（scripts/check-operations.mjs:202-227）会对五个 device 操作要求后端/调用方/测试三项（gateway-contracts 的 src 和 test 都被刻意排除，128-156 行），`server.status.read` 只缺「调用方」（我核实了 control-center 全目录无 `server.status` 字面量），与 pending 名单的注明一致；反向用例在 `test/tooling/operations-check.test.mjs:90-97`（已齐全仍留在名单会报 `OPERATION_PENDING_BUT_COMPLETE` 失败）和 `:177-179`（真实仓库必须通过）——所以名单和代码不同步时 CI 会红。② 新合约测试 `device-gateway.contract.test.ts` 属 `contracts` 项目（ci/policy.json:152-156），在 `coverage` 检查里运行；`rejects()` 用 `toThrow(ContractValidationError)`，若放宽校验会失败。③ 逐类 fixture 齐备由 `gateway-v2.contract.test.ts:34-46` 的全类型往返测试强制（我核对了 8 个新 fixture 都已加进 `governanceMessages` → `compatibilityMessages`，gateway-v2.fixture.ts:1227）。④ 作者声称的 `check:secrets`：我读了扫描规则（scan-machine-secrets.mjs:17，credential-assignment 要求 ≥12 字符），新 fixture 的 `clientSecret: "secret-01"`（9 字符）不会命中，声称可信但未实跑。**未核实**：tsc、check:boundaries 的实际运行；「service-orchestration 34 例红是 main 已有」无法在不运行测试的情况下判定。

**4. 每个新值的两端都核对过吗？——逐个如下：**
- `server.status.read` / `server.status.snapshot`：生产者 `ProductionServerStatusControl`（含真实数据源 `RuntimeHealthModel`）；消费者是 HTTP 路由 + `installedOperations` + `installedGatewayV2Operations`。字段两端核对：`status` 枚举与 `DeploymentHealthSnapshot` 完全一致（durable-state.ts:545）；依赖 `status` 合约超集（见问题 2）；依赖 `name`/`reasonCode` 均满足 `machineString`/大写机器码两端校验（runtime-health.ts:94 vs validation.ts:49-60）。**通过**。
- `pairingCode`（22 字符 base64url）、`deviceId`（`dev_`+22）、`expectedRevision`（integer(0)）、设备名（trim 后 1–64、禁控制字符）：schema 与测试互证（device-gateway.contract.test.ts 各反向用例会失败）；但**仓库内没有任何其它端**（无后端、无调用方），且与设计文档矛盾（见问题 1）。`deviceId` 的 `dev_` 前缀格式和「调用方生成配对码」在仓库内无出处——作者归因于「iOS 设计线程」，**未核实**。
- `DEVICE_LIMIT_KEYS` 十键：与设计文档的九键（`device.prefetch.cache` 单键）不一致（见问题 1）。
- `pairingNumber`（6 位数字）：文档无此概念（问题 1）。
- pending 名单六条：`check-operations.mjs` 两端（合约清单正则 46-53 行 ↔ 名单键 215-219 行）核对一致，理由长度 ≥10，通过。
