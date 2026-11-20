## 发现（按严重度从高到低，均为读代码证实）

### 1. 中低：文件列表控制层没有像登录设备那样核对认证上下文
- 文件：`apps/agent-service/src/production-files-control.ts:40`
- 问题：`ProductionFilesControl.query` 只核对 `query.scope`，没有接收/核对 `GatewayV2QueryContext.authentication`；同一轮新改的登录设备控制层则已经这样做。
- 证据：
  ```ts
  // production-files-control.ts:40-44
  async query(query: GatewayV2Query) {
    ...
    if (query.scope.ownerId !== ownerId || query.scope.agentId !== agentId)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "FILES_SCOPE_MISMATCH");
  ```
  对比：
  ```ts
  // production-login-devices-control.ts:63-67
  async query(query: GatewayV2Query, context?: GatewayV2QueryContext) {
    ...
    const authentication = context?.authentication;
    const ownerId = this.#owner(authentication, query.scope);
  ```
- 当前影响：经 HTTP 网关时，`AgentGatewayV2Service` 先执行 `authorize`（`packages/application/src/services/agent-gateway-v2-service.ts:33,91-111`），外层 `ProductionThreadGatewayAccessPolicy` 也核对活跃会话和 scope（`apps/agent-service/src/production-http-composition.ts:436-459`）。所以这不是当前可通过 HTTP 利用的漏洞，而是控制层纵深防御不一致；将来直接调用控制层或替换外层策略时会失去这层检查。
- 建议：给 `ProductionFilesControl.query` 增加可选的 `GatewayV2QueryContext` 并核对 `authentication.ownerId`，与登录设备保持一致；至少补一条“直接调用但无认证上下文必须拒绝”的单元测试。

### 2. 低：登录设备标签的清洗/截断没有控制层反向用例
- 文件：`apps/agent-service/src/production-login-devices-control.ts:24`、`:81`
- 问题：`singleLine` 负责把最长 128 字符的云端设备标签截到 80 字符并替换控制字符；契约要求 `label: boundedString(80)`。如果 `singleLine` 回归，真实设备快照会违反契约，但现有测试抓不到。
- 证据：
  ```ts
  // production-login-devices-control.ts:24-32
  const singleLine = (value: string): string => {
    let text = "";
    for (const character of value.replace(/\p{Cc}/gu, " ").trim()) {
      if (text.length + character.length > 80) break;
      text += character;
    }
    return text.length > 0 ? text : "?";
  };
  // :81
  label: singleLine(device.label),
  ```
  契约测试只直接构造夹具：
  ```ts
  // packages/gateway-contracts/test/login-devices-gateway.contract.test.ts:36
  ["a label over 80 characters", { label: "a".repeat(81) }],
  ```
  没有任何用例从控制层传入 128 字符/含控制字符的设备标签再解析快照。
- 建议：在 `production-login-devices-control.unit.test.ts` 增加一条：设备标签为 128 字符或含 `\u0007` 时，输出快照仍能通过 `gatewayV2MessageSchema`，且长度为 80、控制字符被替换。

### 3. 低：登录设备列表没有分页/上限，设备记录会累积
- 文件：`apps/agent-service/src/production-login-devices-control.ts:68`
- 问题：查询一次性返回所有活跃设备，没有 limit/cursor。内置身份在每次新设备登录时会新建设备行。
- 证据：
  ```ts
  // production-login-devices-control.ts:68
  const devices = [...(await this.#options.state.listDevices(ownerId, false))].sort(...)
  ```
  ```ts
  // packages/platform-node/src/built-in-identity.ts:203-210
  deviceId: createDeviceId(`device-${randomUUID()}`),
  ```
  ```ts
  // packages/persistence-sqlite/src/sqlite-built-in-identity.ts:282-293
  const deviceId = prior?.deviceId ?? input.deviceId;
  ...
  this.db.prepare("INSERT INTO devices VALUES (...)")
  ```
  网页 `/api/identity/v1/devices` 也是无分页的，所以这不是本 PR 新引入的漏洞；但网关新增了另一个会返回全量列表的入口。
- 建议：要么在契约和查询里加 `limit`/`before`，要么在 CI/文档里明确设备数量上限；否则长期使用后快照会持续变大。

### 4. 低：撤销设备没有审计记录
- 文件：`apps/agent-service/src/production-login-devices-control.ts:106`
- 问题：撤销设备是安全敏感、近似不可撤销的动作；新网关路径只调用 `revokeDevice`，没有写审计账本。网页路由同样没有审计（`packages/platform-node/src/built-in-identity-routes.ts:162-176`）。
- 证据：
  ```ts
  // production-login-devices-control.ts:106-110
  await this.#options.recentAuthentication.assertRecentAuthentication({...});
  await this.#options.state.revokeDevice(device.id, device.revision, this.#options.clock.now());
  return { resultRef: device.id, replayed: false };
  ```
  没有 `audit`、`ledger` 或等价调用。
- 建议：如果产品要求安全操作可追溯，追加一条审计记录（设备 id、操作者、authenticationRef、时间、结果）；如果明确不要求，至少在说明里写清楚，避免以后误以为已有审计。

### 5. 信息/低：枚举与游标格式在两处独立定义，存在 I-73 式漂移风险
- 文件：`packages/gateway-contracts/src/contracts-v2.ts:733`、`packages/application/src/ports/thread-artifacts.ts:6`
- 问题：`FILE_LIST_KINDS`/`FILE_LIST_ORIGINS`/`FILE_LIST_PAGE_LIMIT` 与存储层的 `THREAD_ARTIFACT_KINDS`/`THREAD_ARTIFACT_ORIGINS`/`THREAD_ARTIFACT_LIST_LIMIT` 是两份独立定义；游标也是契约正则和 SQLite `encodeCursor` 两处独立实现。当前值完全一致，真实的集成测试也会把 SQLite 产出的 `nextCursor` 交给契约解析，所以今天没有失败；但以后只改一端就会重演 I-73。
- 证据：
  ```ts
  // contracts-v2.ts:733-743
  export const FILE_LIST_KINDS = ["document","code","web","image","pdf","data","other"] as const;
  export const FILE_LIST_ORIGINS = ["uploaded","generated"] as const;
  export const FILE_LIST_PAGE_LIMIT = 100;
  ```
  ```ts
  // packages/application/src/ports/thread-artifacts.ts:6-20
  export const THREAD_ARTIFACT_KINDS = [...];
  export const THREAD_ARTIFACT_ORIGINS = ["uploaded","generated"] as const;
  export const THREAD_ARTIFACT_LIST_LIMIT = 200;
  ```
  游标：
  ```ts
  // contracts-v2.ts:744-750
  /^[A-Za-z0-9_-]{1,512}$/u
  ```
  ```ts
  // packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts:30-32
  Buffer.from(JSON.stringify([artifact.createdAt, artifact.id])).toString("base64url")
  ```
- 建议：把 kind/origin 从同一处导出，或加一条跨包检查，断言契约枚举等于存储层枚举；游标格式也最好由同一模块提供 encode/decode，或至少保留现有的集成解析测试。

## 推测 / 未核实

1. **`contentPath` 对 iOS 是否可用（未核实）**
   网关快照返回 `/api/files/v1/content/<id>`（`production-files-control.ts:81-84`），该路由在 `packages/platform-node/src/http-gateway-server.ts:1442` 由网页会话认证。`ci/operations-pending.json:13` 也写明“文件内容仍走网页会话”。如果 iOS 原生端不共享网页会话 cookie，它拿到 `contentPath` 也打不开文件；仓库当前是 sparse checkout，没有 `clients/apple`，无法核实。

2. **旧客户端对新增必填字段的兼容性（未核实）**
   `memory.rules.snapshot` 新增了必填的 `quoteSuperseded`/`quoteLatestMemoryId`（`contracts-v2.ts:1790-1793`）。同仓库的 Web 控制中心和服务同版本部署，没问题；旧版 iOS 如果使用严格解码器，可能拒绝多出来的字段。没有 `clients/apple` 源码，未核实。

3. **旧设备/旧文件行的时间戳或 id 不符合新契约（未核实）**
   新快照要求 `timestamp` 是带毫秒的 canonical UTC，`fileId`/`deviceId` 必须过 `machineString`。当前所有生产写入路径都用 `toISOString()` 和 `thread-artifact:<uuid>`/`device-<uuid>`，读代码没有发现反例；但无法检查生产库里是否有更早版本留下的非规范行。

4. **`quoteLatestMemoryId` 与超长 memory id 的潜在错配（潜在，非本 PR 引入）**
   `memory.create` 用 `memory:owner:${command.idempotencyKey}` 生成记忆 id（`production-memory-control.ts:1083`），而 `idempotencyKey` 契约上限是 128 字符（`contracts-v2.ts:187`，`validation.ts:49-59`），前缀 `"memory:owner:"` 有 13 字符，所以理论上可产生 141 字符的 memory id；`quoteLatestMemoryId` 要求 `machineString`（最多 128，`contracts-v2.ts:1793`）。如果这样的记忆成为“最新版”，`memory.rules.snapshot` 会违反自身契约。`memory.overview` 的 `memoryId: machineString` 本来就有同样暴露，所以这是既有的潜在问题；本 PR 多了 `quoteLatestMemoryId` 这个出口。建议在创建记忆时校验最终 id 长度，或不再把任意长度的 idempotencyKey 拼进 id。

## 侧重检查

- **错误路径**：坏 cursor 在 SQLite 层返回 `PORT_INVALID_OPERATION`，控制层只把这一种错误转换成 `ContractValidationError`（`production-files-control.ts:56-63`），HTTP 处理器再映射为 400（`packages/platform-node/src/http-gateway-server.ts:879-881`）。其他错误仍原样抛，未被吞掉。
- **不合规范/不可信输入**：`files.list.read` 的 kind/origin/before/limit 由契约校验（`contracts-v2.ts:751-758`）；文件名和媒体类型经 `displayText` 替换控制字符并截断（`production-files-control.ts:18-25,73-76`）；设备标签经 `singleLine` 清洗；`login.device.revoke` 的 `deviceId` 和 `recentAuthenticationRef` 由契约校验。
- **安全**：登录设备的查询和撤销现在在控制层核对 owner 和 agent（`production-login-devices-control.ts:45-61`）；撤销非当前设备要求最近验证（`:106-109`），当前设备返回 409（`:99-100`）；撤销会级联撤销该设备的活动会话（`packages/persistence-sqlite/src/sqlite-durable-operations.ts:5030-5035`）。文件列表控制层仍有上面的认证缺口。
- **资源耗尽**：文件列表有 `limit <= 100`（`contracts-v2.ts:743,757`）；登录设备列表无上限；记忆取代链最多 8 跳（`production-memory-control.ts:168,546`），规则上限 32（`production-owner-rules.ts:52`），最坏约 256 次记忆读，属于可控但不小的放大。
- **不可撤销操作**：设备撤销有最近验证和当前设备保护；已撤销设备的重复撤销返回 `replayed: true`，不在无最近验证的情况下再次改状态；但无审计记录。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 未被改动；新网关快照不进入模型请求；`ci/operations-pending.json` 新增的三个条目与 `check:operations` 的逻辑一致（后端和测试有字面量，前端 TypeScript 没有调用方，因此必须留在 pending）。

## 作者说法核对

- **“坏 cursor 返回 400，不再是 409”**：成立。转换点在 `production-files-control.ts:56-63`，HTTP 映射是 400。反向用例在 `apps/agent-service/test/production-http-composition.unit.test.ts:1245-1256`；去掉转换后会落到 `ApplicationPortError` 的通用 409 分支（`http-gateway-server.ts:883-892`），用例会失败。
- **“登录设备控制层自己核对 scope.agentId”**：成立。`production-login-devices-control.ts:45-61` 核对 `scope.agentId === agentId`；单元测试的 `agent-other` 分支在 `production-login-devices-control.unit.test.ts:47-78`。去掉这行后，`agent-other` 会通过 `#owner`，测试的 `rejects` 会失败。
- **“第 2 轮的 5 条低严重度意见只补了测试”**：最终状态成立。提交 `0fe8f9a8d` 只改了测试文件，覆盖排序、404、context 转交、另一 agent（记忆链）、contentPath 边界；`5e994075d` 才是这轮的两处代码改动。
- **“网页端允许退出当前设备，网关不允许，这是有意的”**：成立。网页路由 `built-in-identity-routes.ts:162-176` 没有当前设备判断；网关 `production-login-devices-control.ts:99-100` 返回 409。
- **“restricted 级本来就不能存成记忆”**：自动记忆路径确实丢弃 restricted（`packages/application/src/services/automatic-memory-service.ts:165-168`），手动 `#createMemory` 也拒绝 restricted（`production-memory-control.ts:1041-1042`）；同时 `#quotable` 用 `reviewMemoryVisible` 过滤 restricted（`production-memory-control.ts:530-539`，`model-visibility.ts:10-25`）。结论成立。另外要说明：这里的 `quote` 是控制中心 UI 字段，不是发给模型的内容。
- **“不改表”**：对比 diff 中没有迁移或 SQL 文件，成立。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本改动没有碰系统提示、工具定义、历史消息或出口遮盖。新增的 `files.list.snapshot`、`login.devices.snapshot` 只走网关查询/命令；`memory.rules.read` 只被控制中心读取（`apps/control-center/src/memory.ts:116`），不在模型上下文组装路径上。模型请求仍然是“只追加”，本 PR 新增的每轮变化值只有网关快照里的 `generatedAt`，它不在模型消息里，更不在系统提示或工具定义里。依据规则 `.claude/rules/prompt-prefix.md:27-35`。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
对**模型请求**：不会，本改动不进入模型请求。
对**网关响应**：`generatedAt` 是每请求变化的字段，但它是客户端快照，不是前缀；文件按 `created_at DESC, id DESC` 固定排序（`sqlite-thread-artifact-operations.ts:272-276`），设备按 `lastSeenAt`、`id` 固定排序（`production-login-devices-control.ts:68-72`），`displayText`/`singleLine`/文件名截断/游标编码都是确定性的；记忆取代链在同一份数据库状态下结果固定。没有发现依赖前后文的遮盖或无序集合。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？
有，且按代码判断反向用例会失败（我无法运行测试，未核实实际执行结果）：
- 坏 cursor 400：`production-http-composition.unit.test.ts:1245-1256`。
- 登录设备 agent 核对：`production-login-devices-control.unit.test.ts:47-78`。
- 排序：`production-http-composition.unit.test.ts` 中把某设备 `lastSeenAt` 改成 2099 后断言排在第一位。
- 404：同一测试用不存在的设备 id 断言 404。
- context 转交：`autonomy-gateway-adapter.unit.test.ts:382-402`、`host-workspace-gateway.test.ts:234-252`；生产链路上的 Governance 转交由 `production-http-composition` 的登录设备 200 用例间接覆盖。
- contentPath 边界：`files-list-gateway.contract.test.ts:59-62,83-86`。
- 记忆取代链：`production-memory-capture.test.ts:2245-2370` 覆盖被取代、归档、循环、超过 8 跳、另一 agent。

缺口：上面第 2 条发现（登录标签清洗/截断）没有控制层反向用例；另外 `files.list.read` 的 `mediaType` 截断和 `fileId` 非法长度没有从控制层直接验证。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？
逐项核对如下：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `files.list.read.kind` / `origin` | 契约 `FILE_LIST_KINDS`/`FILE_LIST_ORIGINS`（`contracts-v2.ts:733-742`） | 存储层 `THREAD_ARTIFACT_KINDS`/`ORIGINS`（`thread-artifacts.ts:6-18`） | 当前完全一致；有重复定义风险（见发现 5） |
| `files.list.read.limit` | 契约上限 100 | 存储层上限 200（`thread-artifacts.ts:20`，`sqlite-thread-artifact-operations.ts:240-247`） | 接受 |
| `files.list.read.before` / `nextCursor` | SQLite `encodeCursor` base64url（`sqlite-thread-artifact-operations.ts:30-32`） | 契约 `[A-Za-z0-9_-]{1,512}`（`contracts-v2.ts:744-750`） | 接受；真实集成测试会把 SQLite 游标交给契约解析 |
| `files.list.snapshot.fileId` | `thread-artifact:<uuid>`（`service-main.ts:244-247`、`production-thread-artifacts.ts:334`） | 契约 `machineString` 1-128（`contracts-v2.ts:765`、`validation.ts:49-59`） | 当前生产 id 约 53 字符，接受 |
| `files.list.snapshot.name` / `mediaType` | `displayText` 截断到 256/128 并替换控制字符（`production-files-control.ts:18-25,73-76`） | 契约 `boundedString(256)`/`boundedString(128)`（`contracts-v2.ts:767,770`） | 接受；缺控制层反向测试 |
| `files.list.snapshot.contentPath` | `"/api/files/v1/content/" + encodeURIComponent(id)`（`production-files-control.ts:81-84`） | 契约 `nullable(boundedString(512))`（`contracts-v2.ts:775`） | 当前 id 最大长度下约 405 字符，接受；iOS 是否能带网页会话未核实 |
| `login.devices.snapshot.deviceId` | `DeviceId`，域规则与 `machineString` 相同（`packages/domain/src/identifiers.ts:39-48,113-115`） | 契约 `machineString`（`contracts-v2.ts:791`） | 接受 |
| `login.devices.snapshot.label` | `singleLine` 截断到 80、非空、替换 `\p{Cc}`（`production-login-devices-control.ts:24-32,81`） | 契约 `boundedString(80)`（`contracts-v2.ts:792`） | 接受；缺测试 |
| `login.devices.snapshot.firstSeenAt/lastSeenAt` | 写入方用 `toISOString()`（`built-in-identity.ts:203-210`、`identity-gateway.ts:613-614`） | 契约 `timestamp` canonical UTC（`validation.ts:115-124`） | 接受；旧数据未核实 |
| `login.device.revoke.deviceId` | 客户端传入的 `DeviceId` | 契约 `machineString`；控制层按 owner 列表查找（`production-login-devices-control.ts:101-104`） | 接受 |
| `login.device.revoke.recentAuthenticationRef` | 客户端回传；实际值为 `sha256:<hex>`（`built-in-identity.ts:29-30`） | 契约 `nullable(machineString)`；`assertRecentAuthentication` 要求等于当前 auth ref（`recent-authentication-service.ts:56-61`） | 接受 |
| `memory.rules.snapshot.quoteSuperseded` | `#ruleQuote` 固定返回（`production-memory-control.ts:503-527`） | 契约 `booleanValue`（`contracts-v2.ts:1792`）；控制中心读取（`apps/control-center/src/memory.ts:116-120`） | 接受 |
| `memory.rules.snapshot.quoteLatestMemoryId` | `#latestVersion` 返回真实记忆 id（`production-memory-control.ts:542-553`） | 契约 `nullable(machineString)`（`contracts-v2.ts:1793`） | 正常记忆 id 接受；超长 id 有潜在风险（见“推测 4”） |
| 操作名 `files.list.read` / `login.devices.*` | `PRODUCTION_*_OPERATIONS` 与契约 | `check:operations` + `installedGatewayV2Operations` | 名称一致；pending 条目理由符合脚本逻辑 |

## 结论

没有发现高严重度或可直接利用的中严重度缺陷。两处本轮代码改动的方向正确：坏 cursor 只有 `PORT_INVALID_OPERATION` 被转成 400，登录设备在控制层补了 agent 核对，反向用例在代码逻辑上也能成立。需要跟进的是：文件列表控制层缺少与登录设备一致的认证上下文核对、登录标签清洗缺测试、设备列表无分页、撤销设备无审计，以及 kind/origin/游标格式的跨包重复定义。
