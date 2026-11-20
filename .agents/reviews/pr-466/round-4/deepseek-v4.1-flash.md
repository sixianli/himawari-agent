## 结论（按严重度）

### 1. 中 — `memory.rules.snapshot` 增加必填字段，对旧的严格解析端是破坏性变更
**[读代码证实]**
`quoteSuperseded`、`quoteLatestMemoryId` 在契约里是必填（`booleanValue` / `nullable(machineString)`）：`packages/gateway-contracts/src/contracts-v2.ts:1792-1793`。而 `object()` 会拒绝任何未知字段：`packages/gateway-contracts/src/validation.ts:174-176`。网页客户端用同一份严格 schema 解析响应：`apps/control-center/src/gateway-client.ts:268-272`，记忆页直接取 `memory.rules.snapshot`：`apps/control-center/src/memory.ts:116-123`。
因此，如果部署后浏览器仍运行旧 bundle，旧 schema 会把新字段当未知字段拒绝，整页 `RULES_INVALID`。是否有旧 bundle 常驻取决于部署/缓存，**未核实**；但契约层面的风险是确定的。
**建议：** 把两个字段做成可选（或按新消息类型/版本发布），或在部署说明里明确“网页必须整页重载”。新增必填字段不应悄悄改变已有 snapshot 形状。

### 2. 低-中 — 文件列表新增的“登录主人”核对自己没有直接反向用例
**[读代码证实]**
控制层新增的核心检查在 `apps/agent-service/src/production-files-control.ts:44-49`：
`context?.authentication?.ownerId !== ownerId || query.scope.ownerId !== ownerId || ...`
但测试只覆盖了两种情况：query scope 主人不同（`test/integration/sqlite-thread-artifacts.test.ts:535-537`）和完全不带 context（同文件 `:538-540`）。没有“scope.ownerId 正确、但 `context.authentication.ownerId` 错误”的用例。把条件弱化成“只要 context 存在”也能通过现有测试，所以作者说“核对其中的主人”这件事没有被自动检查真正锁住。
**建议：** 增加一条 `control.query(query({}), { authentication: { ...signedIn.authentication, ownerId: "someone-else" } })` 必须拒绝的用例；登录设备控制也补一条完全缺少 authentication 的用例。

### 3. 低 — 文件名/媒体类型的生产端截断没有直接测试
**[读代码证实]**
`displayText` 负责去掉控制字符并按 256/128 截断：`apps/agent-service/src/production-files-control.ts:19-26`，用于 `name` 和 `mediaType`：`:78`、`:81`。集成测试只用了带 `\u0007` 的短文件名（`test/integration/sqlite-thread-artifacts.test.ts` 的 `[iOS] 网关文件列表` 用例），没有 256/128 边界和长媒体类型。契约测试只验证“快照能解析”，不验证生产端截断。
**建议：** 加一条超长 basename / 超长 mediaType 的用例，断言截断后仍能通过 `gatewayV2MessageSchema`。

### 4. 低（推测）— `quoteLatestMemoryId` 的 `machineString` 与 `memory.create` 绕过 id 校验之间存在潜在不一致
**[推测，需确认]**
`memory.create` 直接拼 id：`apps/agent-service/src/production-memory-control.ts:1083`
```
id: `memory:owner:${command.idempotencyKey}` as MemoryId
```
这绕过了 `createMemoryId` 的 1-128 校验。命令的 `idempotencyKey` 契约上限是 128（`packages/gateway-contracts/src/contracts-v2.ts:187`），前缀 `memory:owner:` 有 13 个字符，因此理论上可产生 141 字符的 memory id。而新字段 `quoteLatestMemoryId` 使用 `machineString`（最大 128，`packages/gateway-contracts/src/contracts-v2.ts:1793`、`validation.ts:49-58`）。这种 id 若成为链尾，会让整个 `memory.rules.snapshot` 无法被严格客户端解析。
同样的 id 也可能影响既有的 `memory.overview.snapshot` 的 `memoryId: machineString`，所以不是本 PR 独有，但新字段又增加了一个消费点。
**建议：** 在创建记忆时统一走 `createMemoryId`，或在契约/存储两端明确 id 长度上限；补一条长 idempotencyKey 的集成用例。

### 5. 低（产品语义，需确认）— 记忆被“归档式取代”时不会标 `quoteSuperseded`
**[读代码证实]**
`#ruleQuote` 只有在 `record.status === "active"` 且 `supersededBy !== null` 时才标 superseded：`apps/agent-service/src/production-memory-control.ts:520-527`。但 memory checkup 的合并路径会同时把旧记忆设为 `archived` 并写 `supersededBy`：`packages/application/src/services/memory-checkup.ts:297-304`。这类规则不会被标“被取代”。测试里也明确写了“归档的不标”（`test/integration/production-memory-capture.test.ts:2322` 附近）。
如果产品语义是“归档就是主人主动移除，不算取代”，这是对的；如果“被新记忆取代”包括 checkup 合并，则这是漏标。**需要作者/产品确认。**
**建议：** 在作者说明里明确“取代”的定义；若 checkup 合并也算取代，改为按 `supersededBy !== null` 判断，或单独加 `quoteSuperseded` 的来源区分。

### 6. 低 — 设备列表无分页、无数量上限
**[读代码证实]**
`ProductionLoginDevicesControl.query` 一次返回全部非撤销设备：`apps/agent-service/src/production-login-devices-control.ts:68-72`；契约 `devices` 是普通 `array`，无 `maxItems`：`packages/gateway-contracts/src/contracts-v2.ts:784-797`。作者说网页也不分页，属实（`packages/platform-node/src/built-in-identity-routes.ts:150-160`），所以不是新差异；但网关新开了入口，设备很多时仍是一次性大响应。
**建议：** 低优先级；若设备数可能增长，给数组加契约上限或复用分页。

### 7. 低 — 标签/文件名只清洗了 `\p{Cc}`，没有处理双向控制等格式字符
**[读代码证实]**
`singleLine`：`apps/agent-service/src/production-login-devices-control.ts:31`；`displayText`：`apps/agent-service/src/production-files-control.ts:21`。两者只替换 `\p{Cc}`。契约 `boundedString` 也只拒绝 U+0000–U+001F 和 U+007F：`packages/gateway-contracts/src/validation.ts:96-99`。因此 U+202E（RTL override）等 `Cf` 字符会原样进入设备标签/文件名，可能影响显示。
**建议：** 如果设备标签可能由客户端或外部输入提供，考虑一并剥离/替换 `\p{Cf}`，或在契约里明确允许。

### 8. 低（说明文档与实现不一致）— “和网页同一份数据”说法过于绝对
**[读代码证实]**
网页设备列表返回 `{ id, label, lastSeenAt, current }`，标签原样返回：`packages/platform-node/src/built-in-identity-routes.ts:154-159`。网关返回 `deviceId`、额外 `firstSeenAt`，并把标签清洗/截断到 80：`apps/agent-service/src/production-login-devices-control.ts:79-85`。数据源相同，但字段名、字段集和标签字节不同。
`ci/operations-pending.json:21-22` 和作者说明都写“同一份数据”。建议改成“同一数据源，字段与标签按网关契约规范化”，避免后续误以为两者可逐字节互换。

---

## 侧重检查

- **错误路径**
  - 坏 cursor：store 抛 `PORT_INVALID_OPERATION`，控制层转 `ContractValidationError`（`production-files-control.ts:61-67`），HTTP 映射为 400（`packages/platform-node/src/http-gateway-server.ts:879-881`），有集成用例。
  - 跨主人 query：`query.scope.ownerId !== ownerId` 拒绝（`production-files-control.ts:46`），有测试。
  - 缺登录：不带 session 由 HTTP 401 拦截；控制层无 context 时 `NOT_AUTHORITATIVE`（`:45`），有测试。
  - 撤销当前设备：409（`production-login-devices-control.ts:98-99`），有测试。
  - 无近期验证：`assertRecentAuthentication` 拒绝（`:106-109`），集成测试期望非 200。
  - 设备不存在：404（`:101-104`），有测试。
  - 已撤销设备重复撤销：返回 `replayed: true` 且不再要求近期验证（`:104-105`）。没有状态变化，风险有限，但语义上等于绕过近期验证获得成功响应；作者未说明，建议确认是否可接受。
- **不可信输入**
  - 契约严格拒绝额外字段、坏 kind/origin/limit/cursor；设备标签和文件名做了控制字符清洗；但见问题 7（`Cf` 未处理）。
  - `recentAuthenticationRef` 由客户端提供，但 guard 要求它等于当前 session 的 `authentication.authenticationRef`，并且校验 evidence 与 session/device/owner 绑定（`packages/application/src/services/recent-authentication-service.ts:56-125`），不能靠客户端随便填。
- **安全**
  - 撤销设备会同时撤销该设备的活动 session：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:5030-5035`，不是只改设备状态。
  - 不能撤销当前设备，且需要近期验证，设计合理。
  - 撤销不写审计：与网页路由一致（`built-in-identity-routes.ts:162-176` 没有审计写入），作者说法属实；这是已知产品缺口，不是本 PR 引入。
- **资源耗尽**
  - 文件列表 limit 契约上限 100，store 上限 200，安全（`production-files-control.ts:59`、`packages/application/src/ports/thread-artifacts.ts:20`）。
  - 设备列表无分页（问题 6）。
  - `#rules` 对每条规则最多沿取代链读 8 次且用 `Promise.all` 并发（`production-memory-control.ts:542-553`、`:591-606`），规则多时是 N×最多 8 次数据库读；规则数量通常有限，低风险。
- **不可撤销操作**
  - 设备撤销本身不可撤销（只能重新登录生成新设备），但有近期验证且不能撤销当前设备；审计缺口见上。
- **规则/文档一致性**
  - 本改动不碰提示词组装，`prompt-prefix.md` 无需改。
  - `ci/operations-pending.json` 的键名与契约一致，`check:operations` 会扫到后端实现和测试、扫不到 Swift 调用方，所以留 pending 是合理的。
  - “同一份数据”说法不精确，见问题 8。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。[读代码证实] 改动只涉及 gateway v2 查询/命令、memory rules UI snapshot 和测试；`memory.rules.read` 的消费者是网页记忆页（`apps/control-center/src/memory.ts:116-123`），没有进入 `packages/runtime-pi` 或提示词组装。发给模型的内容仍然只在末尾追加，本改动没有新增“每轮会变的值”到系统提示、工具定义或历史中。`prompt-prefix` 门槛本身我没有运行，标为**未核实**。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对模型请求：不会。对 gateway snapshot：`generatedAt` 每次都会变（`production-files-control.ts:92`、`production-login-devices-control.ts:86`），这是快照的正常字段；文件列表排序固定为 `created_at DESC, id DESC`（`packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts:274-276`），设备排序固定为 `lastSeenAt DESC, id ASC`（`production-login-devices-control.ts:68-72`），cursor 由固定 JSON base64url 生成。没有依赖前后文的遮盖，也没有无序集合。`quoteLatestMemoryId` 会随数据库中的取代链变化，但那是 UI 快照，不是模型历史。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
有，但覆盖不均：
- 契约测试：新增类型、非法 kind/origin/limit/cursor、控制字符、超长字段、额外字段；schema 放宽时这些会失败。
- 文件列表集成测试：坏 cursor 400、无 session 401、无 context / scope 主人不同拒绝、与网页列表同一数据源、kind/origin 过滤、类型/来源/上限一致性断言（`test/integration/sqlite-thread-artifacts.test.ts:535-546`）。
- 登录设备：agent 不匹配拒绝、标签清洗截断；HTTP 层覆盖当前设备 409、无近期验证非 200、404、重复撤销 replayed、撤销后列表过滤。
- 适配器转发 context：`autonomy` 和 `host-workspace` 都有转发测试。
- `check:operations` 会检查新操作是否在契约、是否有后端/测试/调用方；目前调用方缺失，所以留在 pending。
缺口：问题 2 的“auth.ownerId 与 scope.ownerId 不同”没有直接用例；问题 3 的“长 name/mediaType 截断”没有生产端用例。因此不能说“每个新校验都有直接反向用例”。测试未实际运行（工具限制），以上是按代码和用例内容判断。

**4. 新产生的每个值，两端都能接受吗？逐项核对**
[读代码证实] 大部分一致：
- `files.list.read` / `files.list.snapshot` / `login.devices.read` / `login.devices.snapshot` / `login.device.revoke`：契约消息类型、schema 表、`PRODUCTION_*_OPERATIONS`、`installedGatewayV2Operations`、pending ledger、fixture 都一致。
- `FILE_LIST_KINDS` / `FILE_LIST_ORIGINS`：与 `THREAD_ARTIFACT_KINDS` / `THREAD_ARTIFACT_ORIGINS` 完全相等，且有断言（`:541-542`）。
- `FILE_LIST_PAGE_LIMIT=100`：小于 store 的 `THREAD_ARTIFACT_LIST_LIMIT=200`，有断言（`:543`）。
- cursor：生产端 `encodeCursor` 输出 base64url（`sqlite-thread-artifact-operations.ts:30-32`），消费端正则只允许 `[A-Za-z0-9_-]{1,512}`（`contracts-v2.ts:739-745`），一致。
- `fileId` / `threadId`：来自内部 id 生成器（`service-main.ts:244-247`），符合 `machineString`；`contentPath` 对 1-128 字符的 id 做 URL 编码，最长约 406，小于 512。
- `name` / `mediaType`：生产端按 256/128 截断并清洗 Cc，契约 `boundedString(256/128)` 接受。
- 设备 `label`：生产端 ≤80 且去掉 Cc，契约 `boundedString(80)` 接受。
- `firstSeenAt` / `lastSeenAt` / `createdAt` / `generatedAt`：来自 ISO 时钟写入，符合 `timestamp`。
- `recentAuthenticationRef`：真实值是 `sha256:<64 hex>`（`packages/platform-node/src/built-in-identity.ts:29-31`），长度 71，符合 `machineString`。
- `quoteLatestMemoryId`：正常 memory id 符合 `machineString`；仅问题 4 的异常长 id 是潜在例外。
两端不一致/需注意的地方：问题 1 的旧客户端、问题 4 的长 memory id、问题 8 的网页与网关标签差异。
