# PR 466 复核报告

## 结论摘要

改动与作者说明基本相符，三条能力都已实现并有测试。未发现高危问题；发现一处作者未提及的行为变化、两处两条同功能路径的策略不一致、若干无测试覆盖的分支。

---

## 发现的问题（按严重度）

**中 · apps/agent-service/src/production-memory-control.ts:532 — `#quotable` 新增 agentId 校验，作者说明未提**
- 证据：旧代码（diff 前的 `#ruleQuote`）只查 `record.ownerId !== this.options.configuration.ownerId`；新代码 `#quotable` 是 `record.ownerId === ownerId && record.agentId === agentId && ...`。
- 读代码证实的：这是一个真实的语义收紧——同一主人名下另一 agent 的记忆，以前能出 quote，现在返回 null。很可能是合理加固（`#replacedInto` 在 production-memory-control.ts:311-317 也是同款双查），但作者说明只字未提。
- 建议：在说明中补一句；若 state 层保证按 agent 隔离，可注明为什么。

**中 · packages/platform-node/src/built-in-identity-routes.ts:162-176 与 gateway 路径策略不一致**
- 证据：网页撤销路由 `POST /api/identity/v1/devices/revoke`（162-176 行）没有“不能退当前设备”的守卫，也没有 `LOGIN_DEVICE_IS_CURRENT` 检查；而网关 `production-login-devices-control.ts:88-90` 对当前设备抛 `PORT_CONFLICT`。另外网页撤销对已撤销设备（`listDevices(ownerId, false)` 查不到，170-173 行）抛 BuiltInAuthenticationError，网关对已撤销设备返回 `replayed: true`（99-100 行）。
- 读代码证实的：两条路撤销同一台设备，行为不同。不是本 PR 引入的缺陷，但 operations-pending.json:21-22 声称“和网页同一份数据、同一套语义”，读者会以为一致。
- 建议：在 pending 说明里写明差异，或给网页路由补同样的守卫（属后续 PR）。

**低 · packages/application/src/services/host-workspace-gateway-adapter.ts:626、autonomy-gateway-adapter.ts:356 — 委托时丢掉 context**
- 证据：两个适配器的 `query(query: GatewayV2Query)` 委托写的是 `this.#dependencies.delegate.query(query)`，不传 `context`。读代码证实：这两个适配器目前没有装进生产链（全仓库仅测试引用），它们的自有查询类型也不需要 authentication，所以今天无害；但若将来串进生产链，`login.devices.read` 经它们转发会变成无 context，`#owner`（production-login-devices-control.ts:44-54）会抛 `LOGIN_DEVICES_OWNER_REQUIRED`。
- 建议：顺手改为 `delegate.query(query, context)`，一行改动。

**低 · 测试缺口（读代码证实的缺失）**
- `login.device.revoke` 目标设备不存在 → `LOGIN_DEVICE_NOT_FOUND`（production-login-devices-control.ts:96-98）：composition 测试只测了自退 409、无验证非 200、成功三种，404 分支没有用例。
- `login.devices.read` 无 authentication / 非主人 → `LOGIN_DEVICES_OWNER_REQUIRED`（44-54 行）：没有反向用例。
- 并发撤销：两个请求都读到同一 `device.revision`，第二个 `revokeDevice` 撞乐观锁报错而非 replayed（95-101 行）；无用例。
- `files.list.read` 的 owner 对但 agentId 不符：sqlite 集成测试只拒了 `ownerId: "someone-else"`（test/integration/sqlite-thread-artifacts.test.ts，`control.query(query({}, "someone-else"))`）。
- 推测：这些分支逻辑简单、直读可见，风险低，但按本仓库“反向用例”惯例值得补。

**信息 · packages/platform-node/src/http-gateway-server.ts:1100-1107 — 网关出站快照不重新过 schema**
- 证据：`/queries`、`/commands` 只对入站消息 `parseV2BusinessMessage` 校验，出站直接 `sendJson`。快照是否符合契约只靠测试兜底（两个集成测试都特意把控制层输出再 `gatewayV2MessageSchema.parse` 一遍，做法正确）。与现有其他 control 一致，不是新问题。

---

## 作者说法逐条核对（读代码证实的）

| 说法 | 核对 |
|---|---|
| quoteSuperseded / quoteLatestMemoryId，被取代照样给引用，沿链找最新，仍在用且主人看得到才给 id，否则 null；归档的不标 | 与代码一致：production-memory-control.ts:501-526、540-552。链尾必须 `active` 且无 `supersededBy`（549 行），中间每环都要过 `#quotable`（547 行）；来源记忆 `status !== "active"` 时 `quoteSuperseded: false`（519-520 行）。测试覆盖了链成环返回 null、最新一条归档返回 null（test/integration/production-memory-capture.test.ts:2299-2321） |
| files.list.read/snapshot 包 ThreadArtifactStorePort.list，时间倒序分页，按类型、来源筛选 | 一致：production-files-control.ts:44-55；排序 `ORDER BY a.created_at DESC, a.id DESC`（sqlite-thread-artifact-operations.ts:275），cursor 是 `(createdAt, id)` 的 base64url（30-32 行），分页边界正确 |
| contentPath 沿用网页会话下载路由 | 一致：`FILE_CONTENT_PATH_PREFIX = "/api/files/v1/content/"` 与网页 `apps/control-center/src/gateway-client.ts:741`、服务路由 `http-gateway-server.ts:1442` 三处同串；`copyRef === null` 时给 null |
| login.devices.read/snapshot、login.device.revoke；标当前设备；退出别的设备要最近验证过身份、不能退当前这台 | 基本一致，见上面“中”第 2 条的差异：网关路径完全符合；网页 `/devices/revoke` 不受“不能退当前”约束 |
| query 加可选第二参数，AgentGatewayV2Service 和治理层转交 | 一致：ports/gateway.ts:102-105；agent-gateway-v2-service.ts:45 传 `{ authentication }`；governance-gateway-adapter.ts:211-212 透传。GovernanceGatewayV2ControlPlane 对非治理命令直接委托（governance-gateway-adapter.ts:611），不会拦 login.device.revoke |
| 不改表 | 属实：diff 无 schema/migration 文件 |
| ci/operations-pending.json 三条说明 | 与 check:operations 机制（ADR 0192：后端实现+调用方+测试三项，缺调用方挂 pending 附理由）相符；新操作进了 `installedOperations`（production-approval-gateway.ts:296-297）和路由装配（production-http-composition.ts:1194-1206），“check:operations 只扫 TypeScript”的说法与 `package.json:33` 指向的脚本口径一致 |

---

## 侧重检查

走通的流程（iOS 设置页登录设备，从入口到结束）：
1. 手机 `POST /api/gateway/v2/commands`（http-gateway-server.ts:1084）→ 鉴权 + CSRF + 幂等键校验（1086-1099）。
2. `parseV2BusinessMessage` 过 `loginDeviceRevokeCommandSchema`（contracts-v2.ts:801-805）。
3. `AgentGatewayV2Service.request`：`authorize` 校验 owner/actor + 设备授权策略（agent-gateway-v2-service.ts:91-112），installedOperations 检查（34-42）。
4. 治理层控制面 → 非治理命令委托（governance-gateway-adapter.ts:611）→ 审批网关委托（production-approval-gateway.ts:237-238）→ `ProductionLoginDevicesControl.execute`。
5. `#owner` → 自退 409 → `assertRecentAuthentication`（client 提供的 ref 必须等于本会话 authenticationRef 且证据新鲜，recent-authentication-service.ts:56-89）→ 查设备（含已撤销）→ 乐观锁撤销。

结论：主链路每一层都有测试覆盖（composition 测试走的是真实 HTTP 注入，含 409/非 200/成功三态）。**没有测试覆盖的路径**：404 分支、无 authentication 的查询、并发撤销、`files.list.read` 的 agentId 不符分支（见上面“低”第 4 条）。网关 v2 的入站有 schema 校验，出站无（见“信息”条）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会。读代码证实：本 PR 改动只落在网关查询/命令层、快照字段和装配，没有任何 prompt 目录、工具定义、历史存取、遮盖相关文件变更（git diff 全文核对）。`quoteSuperseded`、`quoteLatestMemoryId` 只出现在 `memory.rules.snapshot`（唯一的生成点 production-memory-control.ts:605-611），该快照是给网页/iOS 页面的 HTTP 响应；规则进模型走的是 enforced rule summary（production-mcp-read.ts:1263-1272），不读这两个新字段。发给模型的内容仍是只在末尾追加，每轮会变的值（generatedAt 等）都只在网关响应里、不在模型请求里。规则第 4 条不适用但也未违反。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。`quoteLatestMemoryId` 由确定的链遍历得出（seen 集合防环，production-memory-control.ts:540-552）；设备列表按 `lastSeenAt` 降序 + id 升序打破平局（production-login-devices-control.ts:70-74）；文件列表 SQL `ORDER BY created_at DESC, id DESC`；cursor 编码固定为 base64url（无 padding，与契约 `/^[A-Za-z0-9_-]{1,512}$/` 相容）。没有依赖前后文的遮盖、无时间字段进共享文本、无无序集合。唯一每轮变的是 `generatedAt`，它只出现在对客户端的快照里。

**3. 有没有对应的自动检查、反向用例会不会真的失败？** 有，且读断言可确认失败路径真实：契约测试对 files 列表拒绝未知 kind/origin、坏 cursor、超限 limit、控制字符、多余字段（files-list-gateway.contract.test.ts:38-76），对登录设备拒绝坏 label、多余字段、带空格的 deviceId 等（login-devices-gateway.contract.test.ts:28-59），断言均为 `toThrow(ContractValidationError)`，而 validation.ts 的 boundedString/machineString 实现确实会抛。集成测试覆盖取代链含成环反例（production-memory-capture.test.ts:2316）。composition 测试的反向用例（自退 409、无最近验证非 200）对应真实的 throw。`npm run check:operations` 挂 pending 的做法与 ADR 0192 相符。缺口见“低”第 4 条。

**4. 每个新值两端的校验都接受吗？** 逐个核对过：
- `quoteSuperseded`/`quoteLatestMemoryId`：生成于 memory-control，消费端是契约 schema（contracts-v2.ts:1792-1793，`booleanValue`/`nullable(machineString)`）；MemoryId 的合法字符集（identifiers.ts:39）与 machineString 相同，兼容。网页解析走同一 schema（control-center/src/memory.ts:116-118），无其他快照生产者会缺字段（control-center 的 e2e mock 不经 schema 解析，不受影响）。
- `files.list.*`/`login.*` 五个消息类型：进 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`PRODUCTION_*_OPERATIONS`、`installedOperations`、operations-pending.json，五处齐了；`FILE_LIST_PAGE_LIMIT=100 ≤ THREAD_ARTIFACT_LIST_LIMIT=200`（thread-artifacts.ts:20）；`FILE_LIST_KINDS` 与 `THREAD_ARTIFACT_KINDS` 逐项相同；`display truncation`（256/128/80 code units）与 `boundedString` 的 `.length` 口径一致，Cc 替换覆盖 DEL/C1（`\p{Cc}` 含 0x7F），不会撞“控制字符拒绝”。
- `contentPath`：256 上界对 `encodeURIComponent` 后的 ≤128 字符 id 足够；路由真实存在且按登记表编号放行。
- `GatewayV2QueryContext`：所有生产链实现要么透传（governance、approval-gateway）要么自有查询不需要 authentication；两个未装配的适配器丢 context，见“低”第 3 条。
全部可接受。

**未核实**：未实际运行任何测试或 `check:operations`（工具受限），以上“反向用例会失败”均为从断言与被测代码直读推断；`check-operations.mjs` 对 pending 条目的具体解析细节未逐行读。
