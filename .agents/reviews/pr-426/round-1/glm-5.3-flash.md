# 复核报告：第 11 批服务器部分（设备接口 POST gateway）

## 结论概要

作者的核心说法全部与代码相符（下面逐条给证据）。发现的问题按严重度排列；最值得处理的是：能力表向手机承诺了 v1 网关的 8 种类型，但生产装配根本没有把 v1 网关装进服务器，手机发这 8 种只会得到 503，而这正是 I-73 那类「值只在一端认」的苗头。

---

## 发现（按严重度从高到低）

### 1.（中）能力表登记了 v1 网关的 8 种类型，生产装配里没有 v1，手机的这些请求一律 503

- **文件**：`packages/gateway-contracts/src/client-capabilities.ts:85-92`；`apps/agent-service/src/production-http-composition.ts:652-707`；`packages/platform-node/src/device-gateway.ts:176-177`
- **问题**：能力表登记了 `trigger.admit`、`thread.create`、`thread.close`、`run.cancel`、`approval.respond`、`thread.get_snapshot`、`run.get_snapshot`、`trace.query`（v1，3 个 change、1 个 tighten、4 个 read），生成的 Swift 清单也把它们发给手机（`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:52-59`）。但生产 `routeOptions` 返回的对象里没有 `gateway`（v1）字段；`buildHttpGatewayServer` 的 `options.gateway` 是可选的（`http-gateway-server.ts:108`）。生产里 `gateways.v1` 恒为 undefined，转发时 `if (!gateway) throw GATEWAY_UNAVAILABLE 503`（device-gateway.ts:177）。
- **证据**：`routeOptions`（production-http-composition.ts:658-707）返回对象只含 `threadGateway`、`gatewayV2` 等键，无 v1；测试 harness（`test/fixtures/device-api-harness.ts`）装配 `buildHttpGatewayServer` 时同样只传 `threadGateway`、`gatewayV2`，所以 v1 转发分支（device-gateway.ts:202-209）**没有任何测试走到过**。
- **影响**：fail-closed（不是安全洞），但「表里说手机能做、生产做不了」，网页侧同样没有 v1 可用——这和 I-73 的教训（一端认了另一端不认）同构。`check:client-parity` 只对照合约和网页清单，不对照生产装配，发现不了。
- **建议**：要么在表里把 v1 条目标成 not_on_phone 并写明原因，要么在 `check:client-parity` 或 `check:operations` 里加一条「能力表里每个 gateway 在生产装配里真实可用」的核对；至少给 v1 分支补一条 503 反向用例，把现状钉死。

### 2.（中低）「改/收紧」的完成审计写在命令生效之后，审计写入失败会让客户端看到 500 但改动已发生

- **文件**：`packages/platform-node/src/device-gateway.ts:155-163`
- **问题**：`result = await forward(input)` 之后才 `await record("completed")`。若审计 append 抛错（磁盘满等），命令已执行，客户端却收到 500，且该次高风险操作在账本里没有记录。「收紧和改每次写审计」的说法只在审计端口成功时成立。
- **建议**：审计写入失败时至少降级记日志而不是把已成功的命令报成失败；或把审计失败与命令结果分开返回。

### 3.（低）`proactive.pause` 是读-改-写，无事务，并发会丢更新

- **文件**：`apps/agent-service/src/production-proactive.ts:641-644`
- **证据**：`const settings = await store.readSettings(scope); await store.writeSettings({ ...scope, ...settings, enabled: false, now });`——两次 await 之间若有 `proactive.settings.set` 写入，会被覆盖回去。与既有代码 320、454 行同一样式，风格一致，但既然这条命令是新增的，值得注意。
- **建议**：可接受现状；若要改，在 store 层加「只把 enabled 置 false」的原子操作。

### 4.（低）挑战值在命令执行前就被消耗，命令随后失败时要重新面容

- **文件**：`packages/platform-node/src/paired-device-service.ts:296-314`（nonce 在 `authenticate` 内记录，早于 `dispatchDeviceGatewayRequest` 的转发）
- **问题**：确认签名的请求先记 nonce 再转发；若转发后命令本身失败（如线程 revision 冲突返回 409），挑战值已作废，手机要重新走一遍面容。设计上「一次性」没错，是可用性小坑，无安全影响。

### 5.（低，侧重：测试覆盖）几条路径没有任何测试覆盖

- **证实**（通读测试文件后）：
  - v1 转发分支（见发现 1）零覆盖。
  - 经 `POST /gateway` 的 **v2 查询**（如 `memory.overview.read`）没有直接用例；测试只走过 thread-v3 查询（`thread.detail`）和 v2 命令。
  - 审计 `outcome: "failed"` 分支（device-gateway.ts:158-160）没有断言（测试只数过 completed 审计）。
  - `proactive.pause` 没有经设备网关的端到端用例——只在 `ProductionProactive.execute` 层（proactive-production.test.ts 的 `h.command("proactive.pause", {})`）和合约层测过。
- **未核实**：生产组合级测试（production-http-composition-process.test.ts）是否覆盖 `audit: repository.auditLedger()` 这行新装配（production-http-composition.ts:1208）。

### 6.（信息）作者说法的小偏差

- 「正文里 authorizationRef、recentAuthenticationRef 手机**只能填**占位值 "device"」——实际这两个键也**可以完全不填**（device-gateway.ts:100-107 只在有该键且值不是 "device" 时拒绝）。语义无碍，表述不准。

---

## 侧重检查

**走的流程**：手机记忆页发起一次最普通的查询 → `POST /api/device/v1/gateway`：

1. `device-api-routes.ts:608` 路由（在 `DEVICE_API_ROUTES` 签名允许清单里，:53）→ 请求体大小检查（onRequest hook，:265-276）。
2. `authenticate`（paired-device-service.ts:266-354）：验签 → ownerActive → （confirmed 才查挑战值 MAC，:296）→ 撤销/待定检查 → nonce 防重放记录 → 读内部会话 → touch → 组装 authentication 上下文。
3. `classifyDeviceGatewayRequest`（device-gateway.ts:80-110）：查能力表、分档、键白名单、占位符校验。
4. `dispatchDeviceGatewayRequest`（:132-164）：change 未确认先拒（:142-143）→ read/routine 直接转发，tighten/change 包审计 → `forward`（:166-227）按网关封 envelope、填引用、`schema.parse` → 生产 `createProductionApprovalGateway`（production-http-composition.ts:1134）——与网页同一个实例（http-gateway-server.ts:1295-1300）。

**结论**：1、2、3、4 的主干都有测试覆盖（device-gateway.test.ts 10 个用例，含反向）；harness 里 v2 用的是**生产** approval gateway，覆盖真实。**没覆盖**：发现 1、5 列的路径。文档一致性：`check:client-parity` 已登记进 `check:steps`（package.json），`ci/operations-pending.json` 给 `proactive.pause` 的条目与 `check:operations` 的规则相符（缺调用方、理由够长）；新代码无注释、无迁移，符合约束。

---

## 作者说法核对（读代码证实的）

| 说法 | 结论 |
|---|---|
| 没确认签名的「改」在写审计和转发**之前**被拒 | ✅ device-gateway.ts:142-143 在 record/forward 之前；测试断言事后审计为空（device-gateway.test.ts:150、319、407） |
| 别的设备的挑战值被拒 | ✅ HMAC 绑定 deviceId（:232-239），测试 :192-195 |
| 过期/重复使用的挑战值被拒；并发只成功一个 | ✅ 过期 ：257-264；一次性靠 `recordNonce`（:302-314）+ SQLite `INSERT ... ON CONFLICT DO NOTHING` 按插入成败判（sqlite-paired-device-operations.ts:274-297，事务内，better-sqlite3 同步）；测试 :179-204、:323-338 |
| 收紧档不能夹带别的设置改动 | ✅ `sameFlags` 要求键集和值完全相等（:251-262）；`{capturePaused:true, extra:true}` 判 change；合约测试和集成测试 :281-321 都有反向 |
| 设备内部会话不带近期验证凭据 | ✅ confirmDevice 建会话时 `recent_authenticated_at` 固定 1970（sqlite:210）；evidence 只在 confirmed 且 ownerSubject 返回绑定时才挂（paired-device-service.ts:329-352）；device-api.test.ts:303 断言无该属性 |
| proactive.pause 正文为空、只关提醒、不动免打扰/重要发件人 | ✅ schema `payload: object({})`（contracts-v2.ts），handler 只覆写 `enabled:false` 保留其余（production-proactive.ts:641-644），production 测试断言 quietHours/importantSenders 不变 |
| payloads/text/new 与网页共用校验 | ✅ 同一 `parseTextAdmission`（text-admission.ts），同一上限 64KiB，网页路径该处本就不传 `accepts`（http-gateway-server.ts:1413），两端校验逐字节等价 |
| 挑战值不建表、HMAC 绑设备、启动时随机密钥 | ✅ diff 无迁移；`#challengeKey = randomBytes(32)` 于构造时（:104） |
| check:client-parity 三项内容、Swift 由表生成 | ✅ test/tooling/client-parity.test.ts + 契约测试，反向用例存在 |

---

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。改动全在设备 API 入口、网关转发层和 proactive 设置存储；转发给网关的消息用与网页完全相同的合约 `schema.parse` 和同一批端口实例（http-gateway-server.ts:1295-1300）。diff 文件清单里没有任何提示组装、工具定义、历史存储或遮盖相关文件；`check:prompt-prefix` 的代码未动。新引入的值（挑战值、correlationId、messageId、审计 id/时间）没有一个进入发给模型的内容。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。带时间/随机的只有：挑战值（发给手机）、审计记录（进审计账本不进模型）、`authenticatedAt/expiresAt`（服务端鉴权上下文，服务端鉴权用，从不序列化进模型请求）。correlationId 是 `sha256(deviceId\nmessageId)` 的确定性哈希（device-gateway.ts:112-114）。遮盖未动。
3. **有没有自动检查、反向用例会不会真失败？** 有：`check:client-parity` 已在 `check:steps` 里；反向用例包括：表和合约双向集合相等（漏登记/多登记都会失败）、Swift 文件与表不一致即失败（client-parity.test.ts:171-188）、未确认的 change 断言 403 且审计为空、外来/过期/重放挑战断言 401、并发断言 [200,401]、夹带断言 403、伪造顶层字段断言 400。守卫若被移除这些都会失败。盲区见发现 1、5（v1、v2 查询、failed 审计、生产审计装配）。
4. **每个新值两端的校验都对得上吗？** 逐值核对：`proactive.pause`（合约 schema 严格空正文 ↔ handler 忽略正文；check:operations 用 pending 台账放行缺调用方）；`device_confirmation_key`（paired-device-service 产生 ↔ recent-authentication-service `validSource` 接受，且守卫强制身份绑定活跃、externalSubjectRef、会话、设备全部匹配，两端一致）；占位符 `"device"`（同一文件里产生和消费）；`tightenPayload`（sameFlags 精确匹配 ↔ 合约/集成/Swift 三处）；`parseTextAdmission`（两端同一函数同一上限）；审计 `device.gateway.{tier}`（写入后测试能读回）。**唯一对不上的是发现 1：能力表/Swift 承诺的 v1 网关在生产装配端不存在**——正是 I-73 要求问的「清单里的东西后端认吗」，这里答案是：不认，503。
